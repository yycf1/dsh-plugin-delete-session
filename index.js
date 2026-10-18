/**
 * Host half of the session-trash bundle.
 *
 * It owns the durable work behind the UI's "delete conversation" action:
 *
 * 1. stop the session's running work and archive it so the row disappears;
 * 2. detach it from its workspace's durable account;
 * 3. copy its JSONL log directory and projection checkpoint into
 *    `<DSH_HOME>/session-trash/<sessionId>/`, then remove the originals;
 * 4. unregister the deleted live Session/Agent so an ungrouped row cannot
 *    survive in the sidebar;
 * 5. keep that copy for the configured retention window and purge it for good
 *    afterwards, or restore it when the user asks.
 *
 * The browser reaches this half through the exact HTTP route
 * `/session-trash-api`, guarded by Connection's Host/Origin fence and browser
 * credential check - the same admission every `/api` request passes.
 */

import { Buffer } from 'node:buffer'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { isSafeSessionId, samePath } from './lib/paths.js'
import { SessionTrash } from './lib/trash.js'

const CHANNEL = '/session-trash-api'
const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1000
const MAX_TITLE_LENGTH = 500
const MAX_REQUEST_BYTES = 64 * 1024

/**
 * Required Host services: the browser transport (for Host/Origin and browser
 * authentication checks) and the session log store. `webServer` is obtained
 * through `ctx.inject` below, so a profile without a Web carrier simply keeps
 * the plugin inactive instead of failing.
 */
export const inject = ['connection', 'sessionPersistence']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {Record<string, unknown> | undefined} config bundle row config.
 */
export function apply(ctx, config = {}) {
  const logger = {
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
  }

  const home = firstString(config.homeDir)
    || firstString(process.env.DSH_HOME)
    || path.join(os.homedir(), '.dsh')
  const persistence = ctx.sessionPersistence
  const sessionsRoot = firstString(config.sessionsRoot)
    || firstString(persistence?.root)
    || path.join(home, 'sessions')
  const projectionRoot = firstString(config.projectionCacheDir)
    || path.join(home, 'storages', 'session_projcache', 'sessions')
  const trashRoot = firstString(config.trashRoot)
    || path.join(home, 'session-trash')
  const retentionDays = clampNumber(config.retentionDays, DEFAULT_RETENTION_DAYS, 1, 3650)
  const purgeIntervalMs = clampNumber(config.purgeIntervalMs, DEFAULT_PURGE_INTERVAL_MS, 60_000, 24 * 60 * 60 * 1000)

  const trash = new SessionTrash({
    sessionsRoot,
    trashRoot,
    projectionRoot,
    retentionMs: retentionDays * 24 * 60 * 60 * 1000,
    logger,
  })

  logger.info(`session-trash: sessions root '${sessionsRoot}', trash root '${trashRoot}', retention ${retentionDays} day(s)`)

  /**
   * Permanently remove expired entries and drop their stale archive markers.
   *
   * @returns {Promise<string[]>} purged session ids.
   */
  const purgeExpired = async () => {
    const entries = await trash.list()
    const now = Date.now()
    const purged = []
    for (const entry of entries) {
      if (entry.expiresAt > now) continue
      const sessionId = String(entry.sessionId)
      try {
        // Re-read inside the serialized mutation: a concurrent restore/delete
        // may have replaced this entry between list() and purge().
        const removed = await trash.run(async () => {
          const current = await trash.read(sessionId)
          if (current === undefined || current.expiresAt > now) return false
          await trash.purge(current)
          return true
        })
        if (!removed) continue
        purged.push(sessionId)
        if (!(await storedSessionExists(persistence, sessionId))) {
          detachDeletedLiveState(ctx, sessionId)
          await unarchiveQuietly(ctx, sessionId)
        }
      } catch (error) {
        logger.warn(`session-trash: cannot purge '${sessionId}': ${messageOf(error)}`)
      }
    }
    if (purged.length > 0) {
      logger.info(`session-trash: purged ${purged.length} expired session(s)`)
    }
    return purged
  }

  /**
   * Delete one session.
   *
   * @param {{ sessionId?: unknown, title?: unknown }} payload request body.
   * @returns {Promise<Record<string, unknown>>} deletion outcome.
   */
  const deleteSession = async (payload) => {
    const sessionId = requireSessionId(payload)
    const title = normalizeTitle(payload.title)
    const sessions = ctx.get('sessions')
    const live = sessions?.get(sessionId)
    let header = live?.header
    if (header === undefined) {
      const snapshot = await persistence.stat(sessionId)
      header = snapshot?.header
    }
    if (header === undefined) {
      throw coded('not-found', '找不到这个对话，它可能已经被删除了')
    }

    // Refuse before doing any workspace or archive work: a genuinely running
    // Agent turn is the only state delete must not touch. Everything else
    // (idle, resident, background jobs waiting on a stopped turn) can be
    // archived and removed without the old multi-second live-store wait.
    if (agentStatus(ctx.get('agents')?.get(sessionId)) === 'running') {
      logger.warn(`session-trash: refusing to delete running '${sessionId}'`)
      throw coded('running', '这个对话仍在运行中，请先停止任务再删除')
    }

    const workspace = await findWorkspace(ctx, header.cwd, sessionId)
    const registry = ctx.get('workspaceRegistry')
    let wasArchived = false
    try {
      wasArchived = registry?.archivedSessionIds?.includes(sessionId) === true
    } catch {
      // An unreadable archive set is treated as "not archived"; the archive
      // call below still fails closed if it cannot write the marker.
    }

    // Archive next: it hides the row through the archive set before any file
    // moves and stops background work that is not an Agent turn. The client
    // also clears an open conversation when its id enters that set.
    let archived = false
    const rollbackArchive = async () => {
      // Only remove the marker this request added; an already-archived
      // Session must stay archived when a later step fails.
      if (archived && !wasArchived) await unarchiveQuietly(ctx, sessionId)
    }
    if (registry !== undefined) {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true })
        archived = true
      } catch (error) {
        // Do not detach or remove files when the archive write failed: without
        // the archive marker the still-live Session can reappear after a
        // refresh, and the user would have lost the log for a half-delete.
        // archiveSession can also reject after committing the marker (a stop
        // listener failure), so make the rollback explicit and idempotent.
        logger.warn(`session-trash: archive before delete failed for '${sessionId}': ${messageOf(error)}`)
        if (!wasArchived) await unarchiveQuietly(ctx, sessionId)
        throw coded('archive-failed', '无法归档这个对话，删除已取消')
      }
    }

    // A turn can win the race with the pre-check above; archive's stop gate
    // then makes it short-lived, but do not delete underneath it.
    if (agentStatus(ctx.get('agents')?.get(sessionId)) === 'running') {
      logger.warn(`session-trash: refusing to delete running '${sessionId}' (after archive)`)
      await rollbackArchive()
      throw coded('running', '这个对话仍在运行中，请先停止任务再删除')
    }

    // Remove the durable workspace account so the row cannot come back when a
    // stale snapshot is refreshed. Remember it so a failed copy can restore it.
    let detached = false
    if (workspace !== undefined) {
      try {
        await workspace.detachSession(sessionId)
        detached = true
      } catch (error) {
        logger.warn(`session-trash: detaching '${sessionId}' from workspace failed: ${messageOf(error)}`)
        await rollbackArchive()
        throw coded('detach-failed', '无法从工作区移除这个对话，删除已取消')
      }
    }

    try {
      await persistence.flush()
    } catch (error) {
      // Capturing a log whose latest buffered events failed to reach disk would
      // silently lose them. Put the Session back before touching the files.
      logger.warn(`session-trash: session flush before delete failed: ${messageOf(error)}`)
      if (detached) {
        try {
          await workspace.attachSession(sessionId)
        } catch (attachError) {
          logger.warn(`session-trash: re-attaching '${sessionId}' after a failed flush failed: ${messageOf(attachError)}`)
        }
      }
      if (archived) await rollbackArchive()
      throw coded('flush-failed', '无法写入会话日志，删除已取消')
    }

    // A late append can recreate the directory behind the copy; verify the
    // source twice, not just when the first capture returned a non-null entry.
    await delay(120)
    let entry
    try {
      entry = await trash.run(() => trash.capture({
        sessionId,
        title,
        cwd: header.cwd,
      }))
      if (await trash.sourceExists(sessionId, header.cwd)) {
        await delay(400)
        if (await trash.sourceExists(sessionId, header.cwd)) {
          entry = await trash.run(() => trash.capture({
            sessionId,
            title,
            cwd: header.cwd,
          }))
        }
      }
    } catch (error) {
      // Keep the Session where it was whenever a complete trash copy is not
      // guaranteed; trash.capture keeps a usable entry if an original removal
      // failed part-way, so the user can still restore or purge it.
      if (detached) {
        try {
          await workspace.attachSession(sessionId)
        } catch (attachError) {
          logger.warn(`session-trash: re-attaching '${sessionId}' after a failed delete failed: ${messageOf(attachError)}`)
        }
      }
      if (archived) await rollbackArchive()
      throw error
    }

    // The durable files are gone, but DSH can still hold this Session and its
    // idle Agent in the Host registries. For a workspace row, detaching the
    // workspace already removes it; an ungrouped row has no workspace account,
    // so it would stay in the sidebar (and in the "show archived" filter)
    // pointing at a conversation whose log no longer exists. There is no public
    // Agent close API, so unregister the exact live entries only after the log
    // has been moved successfully. `session/disposed` also releases the JSONL
    // writer; the archived marker remains so a refresh cannot surface a ghost.
    detachDeletedLiveState(ctx, sessionId)

    return {
      sessionId,
      title,
      archived,
      empty: entry === null,
      entry,
    }
  }

  /**
   * Restore one trashed session.
   *
   * @param {{ sessionId?: unknown }} payload request body.
   * @returns {Promise<Record<string, unknown>>} restore outcome.
   */
  const restoreSession = async (payload) => {
    const sessionId = requireSessionId(payload)
    const outcome = await trash.run(async () => {
      const current = await trash.read(sessionId)
      if (current === undefined) return { kind: 'missing' }
      if (typeof current.expiresAt === 'number' && current.expiresAt <= Date.now()) {
        await trash.purge(current)
        return { kind: 'expired' }
      }
      await trash.restore(current)
      return { kind: 'restored', entry: current }
    })
    if (outcome.kind === 'missing') {
      throw coded('no-entry', '回收站里没有这个对话，可能已经恢复或已过期')
    }
    if (outcome.kind === 'expired') {
      // The copy is gone; do not unarchive here unless there is no durable log
      // left at all. In that case the live row is only a ghost and must go too.
      if (!(await storedSessionExists(persistence, sessionId))) {
        detachDeletedLiveState(ctx, sessionId)
        await unarchiveQuietly(ctx, sessionId)
      }
      throw coded('no-entry', '这个对话已超过保留期，无法恢复')
    }

    const entry = outcome.entry
    await unarchiveQuietly(ctx, sessionId)
    if (typeof entry.cwd === 'string' && entry.cwd !== '') {
      const workspace = await findWorkspace(ctx, entry.cwd, sessionId)
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(sessionId)
        } catch (error) {
          logger.warn(`session-trash: restoring '${sessionId}' left it ungrouped: ${messageOf(error)}`)
        }
      }
    }
    return { sessionId, restored: true }
  }

  /**
   * Permanently remove one trashed session, skipping the remaining window.
   *
   * @param {{ sessionId?: unknown }} payload request body.
   * @returns {Promise<Record<string, unknown>>} purge outcome.
   */
  const purgeSession = async (payload) => {
    const sessionId = requireSessionId(payload)
    const purged = await trash.run(async () => {
      const current = await trash.read(sessionId)
      if (current === undefined) return false
      await trash.purge(current)
      return true
    })
    if (!purged) {
      // Never unarchive an id just because its copy is gone: the Session may
      // still exist on disk, and unarchiving would make it visible again.
      return { sessionId, purged: false }
    }
    // A live Session whose log was already deleted has no row left to account
    // for. `sessionStillExists` includes the live store, so test persistence
    // directly before deciding whether the archive and live entries can go.
    const stored = await storedSessionExists(persistence, sessionId)
    if (!stored) {
      detachDeletedLiveState(ctx, sessionId)
      await unarchiveQuietly(ctx, sessionId)
    }
    return { sessionId, purged: true }
  }

  /**
   * Endpoint dispatcher for the dedicated RPC channel.
   *
   * @param {string} endpoint endpoint name.
   * @param {unknown} payload request body.
   * @param {AbortSignal | undefined} signal cancellation.
   * @returns {Promise<unknown>} endpoint value.
   */
  const dispatch = async (endpoint, payload, signal) => {
    signal?.throwIfAborted()
    const body = isRecord(payload) ? payload : {}
    switch (endpoint) {
      case 'info':
        return {
          retentionDays,
          purgeIntervalMs,
        }
      case 'list':
        return { entries: await trash.list() }
      case 'delete':
        return await deleteSession(body)
      case 'restore':
        return await restoreSession(body)
      case 'purge':
        return await purgeSession(body)
      case 'purge-expired': {
        const purged = await purgeExpired()
        return { purged }
      }
      default:
        throw coded('unknown-endpoint', `unknown session-trash endpoint: ${endpoint}`)
    }
  }

  const handleRequest = async (webCtx, req, res) => {
    const write = (status, value) => {
      if (res.headersSent === true) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(value))
    }
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const rejection = webCtx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const request = await readJsonRequest(req)
      if (!isRecord(request) || typeof request.method !== 'string' || request.method === '') {
        write(400, { ok: false, error: { code: 'bad-request', message: 'invalid session-trash request', details: {} } })
        return
      }
      try {
        const value = await dispatch(request.method, request.payload, undefined)
        write(200, { ok: true, value })
      } catch (error) {
        write(200, {
          ok: false,
          error: {
            code: typeof error?.code === 'string' ? error.code : 'session-trash/failed',
            message: messageOf(error),
            details: {},
          },
        })
      }
    } catch (error) {
      write(400, {
        ok: false,
        error: { code: 'bad-request', message: messageOf(error), details: {} },
      })
    }
  }

  // The route lives on the Web carrier, but the plugin itself does not require
  // one: `ctx.inject` waits until a Web composition provides it, and registers
  // inside that scoped context so the route is owned by this plugin's fiber.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CHANNEL,
      handler: (req, res) => handleRequest(webCtx, req, res),
    }), 'session-trash: http route')
  })

  const unarchiveExpiredMarkers = async () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    let ids
    try {
      ids = [...registry.archivedSessionIds]
    } catch {
      return
    }
    for (const sessionId of ids) {
      // A resident Session may be a deleted one kept hidden on purpose.
      if (ctx.get('sessions')?.get(sessionId) !== undefined) continue
      try {
        if ((await persistence.stat(sessionId)) !== undefined) continue
      } catch {
        // A read failure is not evidence that the session is gone.
        continue
      }
      try {
        if ((await trash.read(sessionId)) !== undefined) continue
      } catch {
        continue
      }
      await unarchiveQuietly(ctx, sessionId)
    }
  }

  ctx.effect(() => {
    let stopped = false
    const runPurge = () => {
      if (stopped) return
      void purgeExpired().catch((error) => {
        logger.warn(`session-trash: scheduled purge failed: ${messageOf(error)}`)
      })
    }
    void trash.init().then(async () => {
      await unarchiveExpiredMarkers().catch((error) => {
        logger.warn(`session-trash: archive-marker cleanup failed: ${messageOf(error)}`)
      })
      runPurge()
    }).catch((error) => {
      logger.warn(`session-trash: cannot initialize trash root '${trashRoot}': ${messageOf(error)}`)
    })
    const timer = setInterval(runPurge, purgeIntervalMs)
    timer.unref?.()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'session-trash: retention purge')
}

async function sessionStillExists(ctx, persistence, sessionId) {
  if (ctx.get('sessions')?.get(sessionId) !== undefined) return true
  return storedSessionExists(persistence, sessionId)
}

/**
 * Whether the durable log for a session still exists. Read failures are treated
 * as "still there" so cleanup never detaches a Session whose files are only
 * temporarily unreadable.
 *
 * @param {{ stat: (sessionId: string) => Promise<unknown> }} persistence session persistence service.
 * @param {string} sessionId session id.
 * @returns {Promise<boolean>} true when a persisted log remains.
 */
async function storedSessionExists(persistence, sessionId) {
  try {
    return (await persistence.stat(sessionId)) !== undefined
  } catch {
    // A read failure is treated as "still there" so cleanup never resurrects.
    return true
  }
}

/**
 * Drop a deleted Session and its idle Agent from the Host registries.
 *
 * DSH has no public "close this Agent" capability; the lifecycle handle that
 * owns the full factory teardown is not exposed to plugins. Once the log has
 * been moved into the trash, leaving the live entries registered is what makes
 * an ungrouped row survive deletion. Unregistering the exact entries removes
 * the row immediately and, through `session/disposed`, releases the session
 * writer. The Agent's scoped fiber stays parked until process exit, exactly as
 * it did before this call; it can no longer be addressed by the sidebar or the
 * session API.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {string} sessionId deleted session id.
 */
function detachDeletedLiveState(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  try {
    agents?.get?.(sessionId)?.cancel?.({ kind: 'disposed' })
  } catch {
    // Cancelling idle work is best-effort; unregistering still has to happen.
  }

  // Session first: `session/disposed` makes the API publish a removal, and its
  // persistence listener closes the file writer. Detaching the Agent afterwards
  // cannot re-add a row because the session store no longer has it.
  try {
    const entry = sessions?.store?.get?.(sessionId)
    if (entry !== undefined && typeof sessions?.detachEntered === 'function') {
      sessions.detachEntered(entry)
    }
  } catch (error) {
    ctx.logger?.warn?.(`session-trash: could not detach deleted session '${sessionId}': ${messageOf(error)}`)
  }
  try {
    const entry = agents?.store?.get?.(sessionId)
    if (entry !== undefined && typeof agents?.detachEntered === 'function') {
      agents.detachEntered(entry)
    }
  } catch (error) {
    ctx.logger?.warn?.(`session-trash: could not detach idle agent '${sessionId}': ${messageOf(error)}`)
  }
}

async function findWorkspace(ctx, cwd, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof cwd !== 'string' || cwd === '') return undefined
  let canonical = cwd
  try {
    canonical = await realpath(cwd)
  } catch {
    // A missing directory is still comparable by its recorded spelling.
  }
  const candidates = registry.list().filter((workspace) => samePath(workspace.path, canonical))
  return candidates.find((workspace) => {
    if (typeof sessionId !== 'string') return false
    try {
      return Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)
    } catch {
      return false
    }
  }) ?? candidates[0]
}

function agentStatus(agent) {
  if (agent === undefined) return 'none'
  try {
    return typeof agent.status === 'string' ? agent.status : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function unarchiveQuietly(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    await registry.unarchiveSession(sessionId)
  } catch {
    // The id may already be absent; unarchiving is an idempotent no-op.
  }
}

function requireSessionId(payload) {
  const value = payload?.sessionId
  if (!isSafeSessionId(value)) {
    throw coded('bad-id', '无效的对话 ID')
  }
  return value
}

function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_TITLE_LENGTH)
}

function firstString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function readJsonRequest(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw coded('too-large', 'request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}


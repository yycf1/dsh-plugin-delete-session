/**
 * Filesystem-backed recycle bin for session logs.
 *
 * A deleted session is copied as a whole into
 * `<trashRoot>/<encodeSegment(sessionId)>/` together with its projection-cache
 * checkpoint and a small metadata file, and only then is the original removed.
 * Restoring copies the artifacts back and drops the trash entry. Entries older
 * than the retention window are purged permanently.
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { encodeSegment, isInside, isSafeProjectName, isSafeSessionId, sessionDir } from './paths.js'

const META_FILE = 'meta.json'
const LOG_DIR = 'log'
const PROJECTION_FILE = 'projection.json'
const META_VERSION = 1

export class SessionTrash {
  /**
   * @param {object} options
   * @param {string} options.sessionsRoot configured session-log root.
   * @param {string} options.trashRoot directory that keeps deleted copies.
   * @param {string} options.projectionRoot projection-cache directory.
   * @param {number} options.retentionMs retention window in milliseconds.
   * @param {{ warn: (message: string) => void, info: (message: string) => void }} [options.logger]
   */
  constructor(options) {
    this.sessionsRoot = path.resolve(options.sessionsRoot)
    this.trashRoot = path.resolve(options.trashRoot)
    this.projectionRoot = path.resolve(options.projectionRoot)
    this.retentionMs = options.retentionMs
    this.logger = options.logger ?? { warn: () => {}, info: () => {} }
    this.queue = Promise.resolve()
  }

  /** @returns {Promise<void>} resolves once the trash directory exists. */
  async init() {
    await mkdir(this.trashRoot, { recursive: true })
  }

  /**
   * Serialize mutating operations so two UI actions cannot interleave a copy
   * and a purge for the same entry.
   *
   * @template T
   * @param {() => Promise<T>} operation queued work.
   * @returns {Promise<T>} the operation result.
   */
  run(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  /**
   * Directory holding one trashed session.
   *
   * @param {string} sessionId session id.
   * @returns {string} absolute entry directory.
   */
  entryDir(sessionId) {
    return path.join(this.trashRoot, encodeSegment(sessionId))
  }

  /**
   * Original log directory for a session.
   *
   * @param {string} sessionId session id.
   * @param {string | undefined} cwd recorded directory.
   * @returns {string} absolute source directory.
   */
  sourceDir(sessionId, cwd) {
    const source = sessionDir(this.sessionsRoot, cwd, sessionId)
    if (!isInside(this.sessionsRoot, source)) {
      throw new Error(`refusing to address a session directory outside the sessions root: ${source}`)
    }
    return source
  }

  /**
   * Current projection-cache checkpoint for a session.
   *
   * @param {string} sessionId session id.
   * @returns {string} absolute cache file path.
   */
  projectionFile(sessionId) {
    return path.join(this.projectionRoot, `${sessionId}.json`)
  }

  /**
   * List live trash entries, newest first. Invalid or half-written entries are
   * skipped rather than breaking the whole recycle bin.
   *
   * @returns {Promise<Array<Record<string, unknown>>>} known entries.
   */
  async list() {
    let names
    try {
      names = await readdir(this.trashRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const entries = []
    for (const dirent of names) {
      if (!dirent.isDirectory()) continue
      const dir = path.join(this.trashRoot, dirent.name)
      try {
        const meta = await this.readMeta(dir)
        if (meta === undefined) continue
        entries.push(this.present(meta))
      } catch (error) {
        this.logger.warn(`session-trash: cannot read entry '${dirent.name}': ${messageOf(error)}`)
      }
    }
    entries.sort((left, right) => right.deletedAt - left.deletedAt)
    return entries
  }

  /**
   * Read one entry by session id.
   *
   * @param {string} sessionId session id.
   * @returns {Promise<Record<string, unknown> | undefined>} entry, when present.
   */
  async read(sessionId) {
    const dir = this.entryDir(sessionId)
    const meta = await this.readMeta(dir)
    return meta === undefined ? undefined : this.present(meta)
  }

  /**
   * Locate the artifacts for one session. The recorded cwd normally names the
   * project directory, but a stale header, a migrated root, or a session whose
   * cwd changed can leave it elsewhere; fall back to the encoded id under any
   * project directory before concluding that no log exists.
   *
   * @param {string} sessionId session id.
   * @param {string | undefined} cwd recorded directory.
   * @returns {Promise<{ dir: string, project: string } | undefined>} source.
   */
  async findSource(sessionId, cwd) {
    const expected = this.sourceDir(sessionId, cwd)
    if (await isDirectory(expected)) {
      return { dir: expected, project: path.basename(path.dirname(expected)) }
    }
    const encoded = encodeSegment(sessionId)
    let projects
    try {
      projects = await readdir(this.sessionsRoot, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const candidate = path.join(this.sessionsRoot, project.name, encoded)
      if (!isInside(this.sessionsRoot, candidate)) continue
      if (await isDirectory(candidate)) return { dir: candidate, project: project.name }
    }
    return undefined
  }

  /**
   * Whether the original log directory still exists.
   *
   * @param {string} sessionId session id.
   * @param {string | undefined} cwd recorded directory.
   * @returns {Promise<boolean>} true when artifacts remain at the source.
   */
  async sourceExists(sessionId, cwd) {
    return (await this.findSource(sessionId, cwd)) !== undefined
  }

  /**
   * Copy a session's artifacts into the trash and remove the originals.
   *
   * @param {object} input
   * @param {string} input.sessionId session id.
   * @param {string | undefined} input.title display title snapshot.
   * @param {string | undefined} input.cwd recorded directory.
   * @returns {Promise<Record<string, unknown> | null>} the stored entry, or null
   *   when the session has no artifacts yet (a blank session).
   */
  async capture(input) {
    const { sessionId, title, cwd } = input
    const source = await this.findSource(sessionId, cwd)
    const entryDir = this.entryDir(sessionId)
    const hadLog = source !== undefined
    const projection = this.projectionFile(sessionId)
    const hasProjection = await isFile(projection)

    if (!hadLog && !hasProjection) return null

    // A projection cache without its log cannot reconstruct a conversation.
    // Remove the orphaned cache and report the session as empty instead of
    // advertising an entry that can never be restored.
    if (!hadLog) {
      try {
        await rm(projection, { force: true })
      } catch (error) {
        this.logger.warn(`session-trash: cannot remove orphaned projection for '${sessionId}': ${messageOf(error)}`)
      }
      return null
    }

    // A previous entry for the same id can only be a stale leftover; replace it
    // rather than merging two generations of the same session.
    await rm(entryDir, { recursive: true, force: true })
    await mkdir(entryDir, { recursive: true })

    let metaWritten = false
    let storedMeta
    try {
      if (hadLog) {
        await cp(source.dir, path.join(entryDir, LOG_DIR), {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        })
      }
      if (hasProjection) {
        await cp(projection, path.join(entryDir, PROJECTION_FILE), {
          errorOnExist: true,
          force: false,
        })
      }
      const now = Date.now()
      const meta = {
        version: META_VERSION,
        sessionId,
        title: typeof title === 'string' ? title : '',
        cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
        project: source?.project,
        deletedAt: now,
        expiresAt: now + this.retentionMs,
        hadLog,
        hasProjection,
        bytes: hadLog ? await dirSize(path.join(entryDir, LOG_DIR)) : 0,
      }
      await this.writeMeta(entryDir, meta)
      metaWritten = true
      storedMeta = meta
      // Only now is the copy complete enough to be restorable. If removing an
      // original fails part-way, the entry MUST stay: deleting it here would
      // discard the only complete copy after the log directory was already
      // (partially) removed. The caller reports the failure and keeps the
      // session archived/detached so the copy can be restored or purged.
      if (hadLog) await rm(source.dir, { recursive: true, force: true })
      if (hasProjection) await rm(projection, { force: true })
      return this.present(meta)
    } catch (error) {
      if (!metaWritten) {
        // The copy never completed, so no original has been removed yet; a
        // partial entry must not claim to be restorable.
        await rm(entryDir, { recursive: true, force: true }).catch(() => {})
      } else {
        // Removing an original can fail after it was already gone (notably a
        // projection cache that vanished concurrently). If neither original
        // remains, the complete copy in the trash IS the deletion; report
        // success instead of rolling the row back with a missing log.
        const sourceRemains = hadLog ? await exists(source.dir) : false
        const projectionRemains = hasProjection ? await exists(projection) : false
        if (sourceRemains && hadLog) {
          // One retry covers a transient Windows sharing violation; the trash
          // copy is already complete, so removing the remaining source is safe.
          try {
            await rm(source.dir, { recursive: true, force: true })
          } catch {
            // Keep the entry and let the caller roll the row back.
          }
        }
        const stillThere = hadLog ? await exists(source.dir) : false
        if (!stillThere && storedMeta !== undefined) {
          // The log is the authoritative artifact; if it is gone, the session
          // is deleted even when a derived projection cache could not be
          // removed. Never roll the row back with a missing log.
          if (projectionRemains) {
            this.logger.warn(`session-trash: deleted '${sessionId}' but left its projection cache behind`)
          }
          return this.present(storedMeta)
        }
        this.logger.warn(`session-trash: kept entry '${sessionId}' because removing its originals failed: ${messageOf(error)}`)
      }
      throw error
    }
  }

  /**
   * Copy one entry's artifacts back to their original location and drop the
   * entry. The caller owns the workspace/archive bookkeeping.
   *
   * @param {Record<string, unknown>} entry entry returned by list/read/capture.
   * @returns {Promise<string>} the restored session directory, when a log was kept.
   */
  async restore(entry) {
    const sessionId = String(entry.sessionId)
    if (!isSafeSessionId(sessionId)) {
      throw coded('lost-data', '回收站条目的会话 ID 无效，无法恢复')
    }
    const cwd = typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : undefined
    const project = typeof entry.project === 'string' && entry.project !== ''
      ? entry.project
      : undefined
    if (project !== undefined && !isSafeProjectName(project)) {
      throw coded('lost-data', '回收站条目的项目目录无效，无法恢复')
    }
    const destination = project === undefined
      ? this.sourceDir(sessionId, cwd)
      : path.join(this.sessionsRoot, project, encodeSegment(sessionId))
    if (!isInside(this.sessionsRoot, destination)) {
      throw new Error(`refusing to restore outside the sessions root: ${destination}`)
    }
    const entryDir = this.entryDir(sessionId)
    if (!entry.hadLog) {
      throw coded('lost-data', '回收站中没有会话日志，无法恢复')
    }

    const destinationExisted = await exists(destination)
    try {
      if (entry.hadLog) {
        const sourceLog = path.join(entryDir, LOG_DIR)
        if (!(await isDirectory(sourceLog))) {
          throw coded('lost-data', '回收站中的对话数据已丢失，无法恢复')
        }
        if (destinationExisted) {
          throw coded('conflict', '原位置已存在同名对话数据，已取消恢复')
        }
        await mkdir(path.dirname(destination), { recursive: true })
        await cp(sourceLog, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        })
      }

      if (entry.hasProjection) {
        const source = path.join(entryDir, PROJECTION_FILE)
        if (await isFile(source)) {
          try {
            await mkdir(this.projectionRoot, { recursive: true })
            // The projection cache is derived data. Replace any leftover from
            // an interrupted earlier delete/restore instead of failing the
            // whole restore with a conflict that has no user-visible target.
            const target = this.projectionFile(sessionId)
            await rm(target, { recursive: true, force: true })
            await cp(source, target, { force: true })
          } catch (error) {
            // The log is authoritative; a stale/missing projection is rebuilt
            // by DSH on demand. Do not roll back a successful log restore.
            this.logger.warn(`session-trash: restoring projection for '${sessionId}' failed: ${messageOf(error)}`)
            if (!entry.hadLog) throw error
          }
        }
      }
    } catch (error) {
      // Never leave a half-restored destination behind: a retry would then hit
      // the conflict guard while the trash entry still exists.
      if (!destinationExisted && entry.hadLog) {
        await rm(destination, { recursive: true, force: true }).catch(() => {})
      }
      throw error
    }

    // A leftover entry is a duplicate, not a failed restore. Keep the restored
    // session usable and let the user purge the duplicate later.
    try {
      await rm(entryDir, { recursive: true, force: true })
    } catch (error) {
      this.logger.warn(`session-trash: restored '${sessionId}' but could not remove its trash entry: ${messageOf(error)}`)
    }
    return entry.hadLog ? destination : ''
  }

  /**
   * Permanently remove one entry.
   *
   * @param {Record<string, unknown>} entry entry to delete.
   * @returns {Promise<void>} resolution after removal.
   */
  async purge(entry) {
    await rm(this.entryDir(String(entry.sessionId)), { recursive: true, force: true })
  }

  /**
   * Permanently remove entries whose retention window has elapsed.
   *
   * @param {number} [now] clock override for tests.
   * @returns {Promise<string[]>} purged session ids.
   */
  async purgeExpired(now = Date.now()) {
    const entries = await this.list()
    const purged = []
    for (const entry of entries) {
      const sessionId = String(entry.sessionId)
      try {
        const removed = await this.run(async () => {
          const current = await this.read(sessionId)
          if (current === undefined || current.expiresAt > now) return false
          await this.purge(current)
          return true
        })
        if (removed) purged.push(sessionId)
      } catch (error) {
        this.logger.warn(`session-trash: cannot purge '${sessionId}': ${messageOf(error)}`)
      }
    }
    return purged
  }

  async readMeta(dir) {
    let text
    try {
      text = await readFile(path.join(dir, META_FILE), 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    let value
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
    if (
      !value || typeof value !== 'object'
      || value.version !== META_VERSION
      || !isSafeSessionId(value.sessionId)
      || typeof value.deletedAt !== 'number' || !Number.isFinite(value.deletedAt)
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
      || value.expiresAt < value.deletedAt
      || typeof value.hadLog !== 'boolean'
      || typeof value.hasProjection !== 'boolean'
      || (value.title !== undefined && typeof value.title !== 'string')
      || (value.cwd !== undefined && typeof value.cwd !== 'string')
      || (value.project !== undefined && !isSafeProjectName(value.project))
      || (value.bytes !== undefined
        && (typeof value.bytes !== 'number' || !Number.isFinite(value.bytes) || value.bytes < 0))
    ) {
      return undefined
    }
    // The directory name is the authoritative identity. A copied/renamed
    // metadata file must not make `read(id)` or `purge(entry)` address a
    // different session's directory.
    if (encodeSegment(value.sessionId) !== path.basename(dir)) {
      return undefined
    }
    return value
  }

  async writeMeta(dir, meta) {
    const target = path.join(dir, META_FILE)
    const temporary = `${target}.tmp`
    await writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  present(meta) {
    return {
      sessionId: meta.sessionId,
      title: meta.title ?? '',
      cwd: meta.cwd,
      project: meta.project,
      deletedAt: meta.deletedAt,
      expiresAt: meta.expiresAt,
      hadLog: meta.hadLog,
      hasProjection: meta.hasProjection,
      bytes: meta.bytes ?? 0,
    }
  }
}

async function dirSize(target) {
  let total = 0
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const dirent of entries) {
    const child = path.join(target, dirent.name)
    if (dirent.isDirectory()) total += await dirSize(child)
    else {
      try {
        total += (await stat(child)).size
      } catch {
        // A vanishing file contributes nothing; the size is display-only.
      }
    }
  }
  return total
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function isFile(target) {
  try {
    return (await stat(target)).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

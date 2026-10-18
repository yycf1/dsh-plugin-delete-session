/**
 * Host wiring test: runs `apply` against a fake Cordis context and drives the
 * registered RPC handler end to end.
 *
 * Run with: node test/host.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { encodeSegment, projectKey } from '../lib/paths.js'

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-trash-host-'))
const sessionsRoot = path.join(temporary, 'sessions')
const sessionId = 'session-host-0001'
const failureSessionId = 'session-failure'
const cwd = 'E:\\DeepSeek_WorkSpace'
const logDir = path.join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId))
const failureLogDir = path.join(sessionsRoot, projectKey(cwd), encodeSegment(failureSessionId))
const header = { id: sessionId, cwd, version: 4, createdAt: 1, isSeeded: false }
let liveSessionId
const liveAgents = new Map()
const detached = []
const sessionEntries = new Map()
const agentEntries = new Map()
const sessionsService = {
  store: sessionEntries,
  get(id) {
    return id === liveSessionId ? { id, header: { ...header, id } } : undefined
  },
  detachEntered(entry) {
    detached.push(['session', entry.id])
    sessionEntries.delete(entry.id)
  },
}
const agentsService = {
  store: agentEntries,
  get(id) {
    return liveAgents.get(id)
  },
  detachEntered(entry) {
    detached.push(['agent', entry.id])
    agentEntries.delete(entry.id)
  },
}
let failArchive = false
let failDetach = false
let failFlush = false

await mkdir(logDir, { recursive: true })
await writeFile(path.join(logDir, 'session.v4.jsonl.zstd'), 'log-bytes')
await mkdir(failureLogDir, { recursive: true })
await writeFile(path.join(failureLogDir, 'session.v4.jsonl.zstd'), 'failure-log')

let rpcHandler
const calls = []
const workspace = {
  path: cwd,
  sessionIds: [sessionId],
  async detachSession(id) {
    if (failDetach) throw new Error('detach failed')
    calls.push(['detach', id])
  },
  async attachSession(id) {
    calls.push(['attach', id])
  },
}
const registry = {
  async archiveSession(id, options) {
    if (failArchive) throw new Error('archive failed')
    calls.push(['archive', id, options?.stopActivity === true])
  },
  async unarchiveSession(id) {
    calls.push(['unarchive', id])
  },
  list() {
    return [workspace]
  },
}
const persistence = {
  root: sessionsRoot,
  async stat(id) {
    return id === sessionId || id === liveSessionId || id === failureSessionId
      ? { header: { ...header, id } }
      : undefined
  },
  async flush() {
    if (failFlush) throw new Error('flush failed')
    calls.push(['flush'])
  },
}
const cleanups = []
const ctx = {
  sessionPersistence: persistence,
  logger: { info: () => {}, warn: () => {} },
  get(name) {
    if (name === 'sessions') return sessionsService
    if (name === 'workspaceRegistry') return registry
    if (name === 'agents') return agentsService
    return undefined
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return dispose
  },
  inject(_dependencies, callback) {
    callback(this)
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  connection: {
    requestRejection() {
      return undefined
    },
  },
}

const routes = []

const invoke = async (method, payload = {}) => {
  let body
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(text) {
      body = text
    },
  }
  const req = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ method, payload }))
    },
  }
  await routes[0].handler(req, res)
  return JSON.parse(body)
}

try {
  apply(ctx, { homeDir: temporary, retentionDays: 7 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(routes.length, 1, 'apply registers the HTTP route')
  assert.equal(routes[0].path, '/session-trash-api')

  const info = await invoke('info')
  assert.equal(info.ok, true)
  assert.equal(info.value.retentionDays, 7)

  const emptyList = await invoke('list')
  assert.equal(emptyList.ok, true)
  assert.deepEqual(emptyList.value.entries, [])

  const deleted = await invoke('delete', { sessionId, title: 'Host 测试' })
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  assert.equal(deleted.value.empty, false)
  assert.equal(deleted.value.entry.title, 'Host 测试')
  assert.ok(calls.some(([kind, id]) => kind === 'archive' && id === sessionId && kind === 'archive'))
  assert.ok(calls.some(([kind, id]) => kind === 'detach' && id === sessionId))
  await assert.rejects(stat(logDir), /ENOENT/, 'original log directory is gone')

  const listed = await invoke('list')
  assert.equal(listed.value.entries.length, 1)

  const restored = await invoke('restore', { sessionId })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.equal(await readFile(path.join(logDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log-bytes')
  assert.ok(calls.some(([kind, id]) => kind === 'unarchive' && id === sessionId))
  assert.ok(calls.some(([kind, id]) => kind === 'attach' && id === sessionId))

  // The reported flow: restore into the ungrouped bucket, then delete again
  // while the restored conversation is live. It must not remain as a ghost row.
  liveSessionId = sessionId
  liveAgents.set(sessionId, { status: 'idle' })
  sessionEntries.set(sessionId, { id: sessionId, session: { id: sessionId } })
  agentEntries.set(sessionId, { id: sessionId, agent: liveAgents.get(sessionId) })
  const deletedAgain = await invoke('delete', { sessionId, title: 'Host 测试' })
  assert.equal(deletedAgain.ok, true)
  assert.ok(detached.some(([kind, id]) => kind === 'session' && id === sessionId), 'restored live session leaves the Host store')
  assert.ok(detached.some(([kind, id]) => kind === 'agent' && id === sessionId), 'restored idle agent leaves the Host store')
  liveAgents.delete(sessionId)
  liveSessionId = undefined

  const purged = await invoke('purge', { sessionId })
  assert.equal(purged.ok, true)
  assert.equal(purged.value.purged, true)
  assert.equal((await invoke('list')).value.entries.length, 0)

  const missing = await invoke('delete', { sessionId: 'session-missing' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'not-found')

  const badId = await invoke('delete', { sessionId: '../escape' })
  assert.equal(badId.ok, false)
  assert.equal(badId.error.code, 'bad-id')

  const traversal = await invoke('delete', { sessionId: '..' })
  assert.equal(traversal.ok, false)
  assert.equal(traversal.error.code, 'bad-id')

  const unknown = await invoke('nope')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'unknown-endpoint')

  // An idle Agent still leaves the Session live in the Host store. That must
  // not block deletion: archive gates new events, and the files can be moved
  // while the idle Agent remains resident.
  liveSessionId = 'session-live'
  liveAgents.set(liveSessionId, { status: 'idle' })
  sessionEntries.set(liveSessionId, { id: liveSessionId, session: { id: liveSessionId } })
  agentEntries.set(liveSessionId, { id: liveSessionId, agent: liveAgents.get(liveSessionId) })
  const liveDeleted = await invoke('delete', { sessionId: 'session-live', title: 'live' })
  assert.equal(liveDeleted.ok, true, JSON.stringify(liveDeleted))
  assert.ok(detached.some(([kind, id]) => kind === 'session' && id === 'session-live'), 'deleted ungrouped session leaves the Host store')
  assert.ok(detached.some(([kind, id]) => kind === 'agent' && id === 'session-live'), 'deleted idle agent leaves the Host store')
  liveAgents.delete(liveSessionId)
  liveSessionId = undefined

  // A live Session without an Agent is also idle as far as deletion is
  // concerned; it must not be refused as "still in use".
  liveSessionId = 'session-orphan'
  sessionEntries.set(liveSessionId, { id: liveSessionId, session: { id: liveSessionId } })
  const orphanDeleted = await invoke('delete', { sessionId: 'session-orphan', title: 'orphan' })
  assert.equal(orphanDeleted.ok, true, JSON.stringify(orphanDeleted))
  assert.ok(detached.some(([kind, id]) => kind === 'session' && id === 'session-orphan'), 'orphan session leaves the Host store')
  liveSessionId = undefined

  // Only a genuinely running Agent turn refuses, and it refuses immediately
  // with its own code rather than the old generic "busy" retry loop or a
  // cancellation side effect.
  liveSessionId = 'session-running'
  liveAgents.set(liveSessionId, { status: 'running' })
  const before = calls.length
  const running = await invoke('delete', { sessionId: 'session-running', title: 'running' })
  assert.equal(running.ok, false)
  assert.equal(running.error.code, 'running')
  assert.equal(calls.slice(before).some(([kind]) => kind === 'cancel'), false)
  assert.equal(calls.slice(before).some(([kind]) => kind === 'archive'), false)
  assert.equal(calls.slice(before).some(([kind]) => kind === 'detach'), false)
  liveAgents.delete(liveSessionId)
  liveSessionId = undefined

  // A failure in archive/detach/flush must abort before the log is touched and
  // leave the row visible (archive rolled back) instead of half-deleting it.
  failArchive = true
  let beforeFailure = calls.length
  const archiveFailed = await invoke('delete', { sessionId: failureSessionId })
  assert.equal(archiveFailed.ok, false)
  assert.equal(archiveFailed.error.code, 'archive-failed')
  assert.equal(calls.slice(beforeFailure).some(([kind]) => kind === 'detach'), false)
  assert.equal(await readFile(path.join(failureLogDir, 'session.v4.jsonl.zstd'), 'utf8'), 'failure-log')
  failArchive = false

  failDetach = true
  beforeFailure = calls.length
  const detachFailed = await invoke('delete', { sessionId: failureSessionId })
  assert.equal(detachFailed.ok, false)
  assert.equal(detachFailed.error.code, 'detach-failed')
  assert.equal(calls.slice(beforeFailure).some(([kind]) => kind === 'unarchive'), true)
  assert.equal(await readFile(path.join(failureLogDir, 'session.v4.jsonl.zstd'), 'utf8'), 'failure-log')
  failDetach = false

  failFlush = true
  beforeFailure = calls.length
  const flushFailed = await invoke('delete', { sessionId: failureSessionId })
  assert.equal(flushFailed.ok, false)
  assert.equal(flushFailed.error.code, 'flush-failed')
  assert.equal(calls.slice(beforeFailure).some(([kind]) => kind === 'attach'), true)
  assert.equal(calls.slice(beforeFailure).some(([kind]) => kind === 'unarchive'), true)
  assert.equal(await readFile(path.join(failureLogDir, 'session.v4.jsonl.zstd'), 'utf8'), 'failure-log')
  failFlush = false

  console.log('host.test.mjs: all assertions passed')
} finally {
  for (const dispose of cleanups.reverse()) {
    try {
      await dispose()
    } catch {
      // Best-effort teardown.
    }
  }
  await rm(temporary, { recursive: true, force: true })
}

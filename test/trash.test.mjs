/**
 * Focused tests for the recycle-bin filesystem store.
 *
 * Run with: node test/trash.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { encodeSegment, isInside, isSafeSessionId, projectKey } from '../lib/paths.js'
import { SessionTrash } from '../lib/trash.js'

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-trash-'))
const sessionsRoot = path.join(temporary, 'sessions')
const trashRoot = path.join(temporary, 'trash')
const projectionRoot = path.join(temporary, 'storages', 'session_projcache', 'sessions')
const sessionId = 'session-test-0001'
const cwd = 'E:\\DeepSeek_WorkSpace'
const logDir = path.join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId))

const create = () => new SessionTrash({
  sessionsRoot,
  trashRoot,
  projectionRoot,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  logger: { info: () => {}, warn: (message) => console.warn(message) },
})

try {
  assert.equal(projectKey('E:\\DeepSeek_WorkSpace'), '--E-DeepSeek_WorkSpace--')
  assert.equal(projectKey('E:/DeepSeek_WorkSpace'), '--E-DeepSeek_WorkSpace--')
  assert.equal(encodeSegment('session-abc_1.2'), 'session-abc_1.2')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(isSafeSessionId('session-abc_1.2'), true)
  assert.equal(isSafeSessionId('..'), false)
  assert.equal(isSafeSessionId('../escape'), false)
  assert.equal(isInside(sessionsRoot, path.join(sessionsRoot, '..foo')), true)
  assert.equal(isInside(sessionsRoot, path.join(sessionsRoot, '..', 'escape')), false)

  await mkdir(logDir, { recursive: true })
  await writeFile(path.join(logDir, 'session.v4.jsonl.zstd'), 'header+events')
  await mkdir(projectionRoot, { recursive: true })
  await writeFile(path.join(projectionRoot, `${sessionId}.json`), '{"checkpoint":true}')

  const trash = create()
  await trash.init()

  const captured = await trash.capture({ sessionId, title: '测试对话', cwd })
  assert.ok(captured, 'capture returns an entry')
  assert.equal(captured.hadLog, true)
  assert.equal(captured.hasProjection, true)
  assert.equal(captured.title, '测试对话')
  await assert.rejects(stat(logDir), /ENOENT/, 'source directory is removed after capture')
  await assert.rejects(
    stat(path.join(projectionRoot, `${sessionId}.json`)),
    /ENOENT/,
    'projection checkpoint is removed after capture',
  )

  const listed = await trash.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].sessionId, sessionId)

  // The projection cache is derived data: a stale file at the destination must
  // be replaced, not turn a valid log restore into a conflict.
  await mkdir(projectionRoot, { recursive: true })
  await writeFile(path.join(projectionRoot, `${sessionId}.json`), '{"stale":true}')

  const restored = await trash.restore(captured)
  assert.equal(restored, logDir)
  assert.equal(await readFile(path.join(logDir, 'session.v4.jsonl.zstd'), 'utf8'), 'header+events')
  assert.equal(await readFile(path.join(projectionRoot, `${sessionId}.json`), 'utf8'), '{"checkpoint":true}')
  assert.equal((await trash.list()).length, 0, 'restore removes the trash entry')

  const second = await trash.capture({ sessionId, title: '测试对话', cwd })
  assert.ok(second)
  const purged = await trash.purgeExpired(second.expiresAt + 1)
  assert.deepEqual(purged, [sessionId])
  assert.equal((await trash.list()).length, 0, 'expired entry is purged')

  // A stale destination must not be overwritten by a restore.
  await mkdir(logDir, { recursive: true })
  await writeFile(path.join(logDir, 'session.v4.jsonl.zstd'), 'again')
  const third = await trash.capture({ sessionId, title: '测试对话', cwd })
  assert.ok(third)
  await mkdir(logDir, { recursive: true })
  await writeFile(path.join(logDir, 'keep'), 'do-not-overwrite')
  await assert.rejects(
    trash.restore(third),
    (error) => error?.code === 'conflict',
    'restore refuses to overwrite an existing directory',
  )
  await trash.purge(third)

  // A mismatched recorded cwd must not lose a session that actually lives in
  // another project directory; capture finds it by id and restore puts it back.
  const altId = 'session-alt-0002'
  const altProject = '--E-OtherProject--'
  const altDir = path.join(sessionsRoot, altProject, altId)
  await mkdir(altDir, { recursive: true })
  await writeFile(path.join(altDir, 'session.v4.jsonl.zstd'), 'alt-log')
  const alt = await trash.capture({ sessionId: altId, title: 'alt', cwd: 'E:\\MissingProject' })
  assert.ok(alt)
  assert.equal(alt.project, altProject)
  await trash.restore(alt)
  assert.equal(await readFile(path.join(altDir, 'session.v4.jsonl.zstd'), 'utf8'), 'alt-log')

  // A session without artifacts is not turned into an empty trash entry.
  const blank = await trash.capture({ sessionId: 'session-blank', title: 'blank', cwd })
  assert.equal(blank, null)

  // A tampered metadata file must not become an entry (and must never reach a
  // raw path join such as the projection filename).
  const badId = 'session-bad-meta'
  const badDir = path.join(trashRoot, encodeSegment(badId))
  await mkdir(badDir, { recursive: true })
  await writeFile(path.join(badDir, 'meta.json'), JSON.stringify({
    version: 1,
    sessionId: '../escape',
    title: 'bad',
    deletedAt: Date.now(),
    expiresAt: Date.now() + 1000,
    hadLog: false,
    hasProjection: false,
  }))
  assert.equal(await trash.read(badId), undefined)
  assert.equal((await trash.list()).length, 0)

  console.log('trash.test.mjs: all assertions passed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

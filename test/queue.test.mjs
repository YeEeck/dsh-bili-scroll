// node --test test/
// 工单 06：候选队列（lib/queue.mjs）—— 上限 / 去重 / 过期 / 原子写 / 收件箱排干。
// 纯逻辑部分直接调；文件部分用**临时目录 + 真 fs**（原子写要真的 rename 才算测到）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QUEUE_FILE, INBOX_FILE, DROPPED_FILE, QUEUE_LIMIT, QUEUE_TTL_HOURS, COLLECT_BATCH,
  queuePaths, loadQueue, saveQueue, enqueue, expireQueue, markStatus, queueView,
  drainInbox, clearInbox, appendDropped, readDropped, emptyQueue, QUEUE_STATUS,
} from '../lib/queue.mjs'
import { dayKey } from '../lib/state.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-queue-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

const dir = () => mkdtempSync(join(root, 'state-'))
const BV = (ch) => 'BV1' + ch.repeat(9)
const A = BV('a')
const B = BV('b')
const C = BV('c')
const D = BV('d')
const cand = (bvid, extra = {}) => ({ bvid, title: '标题 ' + bvid, up: 'UP ' + bvid, draft: '草稿 ' + bvid, ...extra })

test('queuePaths / 三个文件名：都在 stateDir 下，不写进插件包目录', () => {
  const p = queuePaths('/tmp/x')
  assert.equal(p.file, join('/tmp/x', QUEUE_FILE))
  assert.equal(p.inbox, join('/tmp/x', INBOX_FILE))
  assert.equal(p.dropped, join('/tmp/x', DROPPED_FILE))
  assert.equal(QUEUE_LIMIT.default, 3)
  assert.equal(QUEUE_TTL_HOURS.default, 24)
  assert.equal(COLLECT_BATCH.default, 3)
})

test('enqueue：字段齐全（id = 天 + BV）、时间与保质期都对、不修改原队列', () => {
  const now = new Date('2026-11-09T10:00:00Z')
  const q = emptyQueue()
  const r = enqueue(q, [cand(A)], { limit: 3, ttlHours: 24, now })
  assert.equal(r.added.length, 1)
  assert.equal(q.entries.length, 0, '纯计算：调用方给的那份不被改')
  const e = r.added[0]
  assert.equal(e.id, dayKey(now) + ':' + A)
  assert.equal(e.bvid, A)
  assert.equal(e.title, '标题 ' + A)
  assert.equal(e.up, 'UP ' + A)
  assert.equal(e.draft, '草稿 ' + A)
  assert.equal(e.collectedAt, now.toISOString())
  assert.equal(Date.parse(e.expiresAt) - Date.parse(e.collectedAt), 24 * 3600_000)
  assert.equal(e.status, QUEUE_STATUS.pending)
  assert.equal(e.attempts, 0)
  assert.equal(e.lastError, '')
})

test('enqueue：同一个 BV 不重复入队（不管旧那条是什么状态）', () => {
  const now = new Date()
  const q = { v: 1, entries: [
    { bvid: A, title: '旧的', up: '', draft: '', collectedAt: now.toISOString(), expiresAt: now.toISOString(), status: 'sent', attempts: 1, lastError: '' },
  ] }
  const r = enqueue(q, [cand(A), cand(B)], { limit: 3, ttlHours: 24, now })
  assert.deepEqual(r.added.map((e) => e.bvid), [B])
  assert.deepEqual(r.skipped.map((e) => [e.bvid, e.reason]), [[A, 'duplicate']])
  assert.equal(r.queue.entries.length, 2)
})

test('enqueue：到上限后不再入队（进 dropped），已过期的 pending 不占位', () => {
  const now = new Date('2026-11-09T10:00:00Z')
  const q = { v: 1, entries: [
    { bvid: A, collectedAt: now.toISOString(), expiresAt: now.toISOString(), status: 'pending' },
    { bvid: B, collectedAt: now.toISOString(), expiresAt: now.toISOString(), status: 'pending' },
  ] }
  const r = enqueue(q, [cand(C), cand(D)], { limit: 2, ttlHours: 24, now })
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.dropped.map((e) => [e.bvid, e.reason]), [[C, 'queue-full'], [D, 'queue-full']])

  // 过期的 pending 转成 expired 之后，位置就该让出来
  const exp = expireQueue(r.queue, { now: new Date('2026-11-10T10:00:01Z') })
  assert.equal(exp.expired.length, 2)
  const r2 = enqueue(exp.queue, [cand(C)], { limit: 2, ttlHours: 24, now: new Date('2026-11-10T11:00:00Z') })
  assert.deepEqual(r2.added.map((e) => e.bvid), [C])
})

test('enqueue：BV 不合法 ⇒ skipped（不静默吞掉）', () => {
  const now = new Date()
  const r = enqueue(emptyQueue(), [{ bvid: '不是BV', title: 'x' }, { bvid: '' }], { limit: 3, ttlHours: 24, now })
  assert.equal(r.added.length, 0)
  assert.deepEqual(r.skipped.map((e) => e.reason), ['bad-bvid', 'bad-bvid'])
})

test('enqueue / expireQueue / queueView 必须注入 now（本模块不自己取系统时间）', () => {
  assert.throws(() => enqueue(emptyQueue(), [], { limit: 3, ttlHours: 24 }), TypeError)
  assert.throws(() => expireQueue(emptyQueue(), {}), TypeError)
  assert.throws(() => queueView(emptyQueue(), {}), TypeError)
})

test('expireQueue：到期那一刻就算过期；过期后不再出现在可投递视图里（但仍在队列文件里供对账）', () => {
  const t0 = new Date('2026-11-09T10:00:00Z')
  const enq = enqueue(emptyQueue(), [cand(A), cand(B)], { limit: 3, ttlHours: 1, now: t0 })
  const expiresAt = Date.parse(enq.added[0].expiresAt)

  // 还差 1 毫秒：没过期
  const alive = expireQueue(enq.queue, { now: new Date(expiresAt - 1) })
  assert.equal(alive.expired.length, 0)
  assert.equal(queueView(alive.queue, { now: new Date(expiresAt - 1) }).pending, 2)

  // 正好到期：算过期
  const dead = expireQueue(enq.queue, { now: new Date(expiresAt) })
  assert.deepEqual(dead.expired.map((e) => e.bvid), [A, B])
  const view = queueView(dead.queue, { now: new Date(expiresAt) })
  assert.equal(view.pending, 0)
  assert.deepEqual(view.items, [], '可投递视图里不再出现过期的')
  assert.equal(view.next, null)
  assert.equal(view.total, 2)
  assert.equal(view.expired, 2)
})

test('expireQueue：已结束的条目留 7 天供判重，再久就清掉（文件不会无限长）', () => {
  const t0 = new Date('2026-11-01T00:00:00Z')
  const old = { bvid: A, collectedAt: t0.toISOString(), expiresAt: t0.toISOString(), status: 'sent' }
  const recent = { bvid: B, collectedAt: t0.toISOString(), expiresAt: t0.toISOString(), status: 'expired' }
  const q = { v: 1, entries: [old, recent] }
  const r1 = expireQueue(q, { now: new Date('2026-11-05T00:00:00Z') })
  assert.equal(r1.queue.entries.length, 2, '还不到 7 天：留着')
  const r2 = expireQueue(q, { now: new Date('2026-11-09T00:00:00Z') })
  assert.deepEqual(r2.queue.entries.map((e) => e.bvid), [], '超过 7 天：清掉')
  // 不传 keepDays 时默认也是 7 天
  assert.deepEqual(expireQueue(q, { now: new Date('2026-11-09T00:00:00Z') }).queue.entries, [])
})

test('queueView：总条数 / 待投递 / 下一条 / 剩余保质期（小时）', () => {
  const t0 = new Date('2026-11-09T10:00:00Z')
  const enq = enqueue(emptyQueue(), [cand(A), cand(B)], { limit: 3, ttlHours: 24, now: t0 })
  const view = queueView(enq.queue, { now: new Date('2026-11-09T22:00:00Z') })
  assert.equal(view.total, 2)
  assert.equal(view.pending, 2)
  assert.equal(view.sent, 0)
  assert.equal(view.expired, 0)
  assert.equal(view.failed, 0)
  assert.equal(view.next.bvid, A, '队列顺序 = 入队顺序')
  assert.equal(view.items.length, 2)
  assert.equal(view.items[0].expiresInHours, 12)
  assert.equal(view.items[0].draft, '草稿 ' + A)
  assert.equal(view.items[0].status, 'pending')
})

test('markStatus：按 id 或 BV 改状态；不认识的状态 / 找不到的条目都不乱动', () => {
  const t0 = new Date('2026-11-09T10:00:00Z')
  const enq = enqueue(emptyQueue(), [cand(A)], { limit: 3, ttlHours: 24, now: t0 })
  const id = enq.added[0].id
  const r = markStatus(enq.queue, id, 'sent', { attempts: 1 })
  assert.equal(r.entry.status, 'sent')
  assert.equal(r.entry.attempts, 1)
  assert.equal(r.queue.entries[0].status, 'sent')
  assert.equal(markStatus(enq.queue, A, 'failed', { lastError: '21007' }).entry.lastError, '21007')
  assert.equal(markStatus(enq.queue, 'BV1zzzzzzzzz', 'sent').entry, null)
  assert.equal(markStatus(enq.queue, 'BV1zzzzzzzzz', 'sent').queue.entries.length, 1, '找不到就不动队列')
  assert.equal(enq.queue.entries[0].status, 'pending', '原队列不被改（纯计算）')
  assert.throws(() => markStatus(enq.queue, A, 'whatever'), TypeError)
})

test('loadQueue / saveQueue：原子写（临时文件 + rename），坏文件读成空队列', () => {
  const d = dir()
  // 文件不在 ⇒ 空队列
  assert.deepEqual(loadQueue(d), { v: 1, entries: [] })

  const t0 = new Date('2026-11-09T10:00:00Z')
  const enq = enqueue(emptyQueue(), [cand(A)], { limit: 3, ttlHours: 24, now: t0 })
  const saved = saveQueue(d, enq.queue)
  assert.equal(saved.entries.length, 1)
  const raw = JSON.parse(readFileSync(queuePaths(d).file, 'utf8'))
  assert.equal(raw.v, 1)
  assert.equal(raw.entries[0].bvid, A)
  assert.deepEqual(readdirSync(d).filter((f) => f.includes('.tmp-')), [], 'rename 完不该留临时文件')

  const back = loadQueue(d)
  assert.deepEqual(back.entries.map((e) => e.bvid), [A])
  assert.equal(back.entries[0].collectedAt, t0.toISOString())

  // 写坏了 ⇒ 空队列（绝不让 /status 因此报错）
  writeFileSync(queuePaths(d).file, '{ 这不是 json', 'utf8')
  assert.deepEqual(loadQueue(d), { v: 1, entries: [] })
  // 老形状（直接是数组）也认
  writeFileSync(queuePaths(d).file, JSON.stringify([{ bvid: B }]), 'utf8')
  assert.deepEqual(loadQueue(d).entries.map((e) => e.bvid), [B])
})

test('saveQueue：写失败时旧文件原封不动，临时文件被清掉（不会留下半份队列）', () => {
  const d = dir()
  const t0 = new Date('2026-11-09T10:00:00Z')
  saveQueue(d, enqueue(emptyQueue(), [cand(A)], { limit: 3, ttlHours: 24, now: t0 }).queue)
  const before = readFileSync(queuePaths(d).file, 'utf8')

  const boom = () => { throw new Error('磁盘满了（合成的）') }
  assert.throws(() => saveQueue(d, enqueue(emptyQueue(), [cand(B)], { limit: 3, ttlHours: 24, now: t0 }).queue, { writeFile: boom }), /磁盘满了/)
  assert.equal(readFileSync(queuePaths(d).file, 'utf8'), before, '旧的那份必须还在')
  assert.deepEqual(readdirSync(d).filter((f) => f.includes('.tmp-')), [], '临时文件要清掉')
})

test('drainInbox：一行一条；坏行 / 坏 BV 记成 bad；文件不在 = 空', () => {
  const d = dir()
  assert.deepEqual(drainInbox(d), { candidates: [], bad: 0, lines: 0 })
  mkdirSync(d, { recursive: true })
  writeFileSync(queuePaths(d).inbox, [
    JSON.stringify({ bvid: A, title: '标题A', up: 'UPA', draft: '草稿A' }),
    '',
    '这不是 json',
    JSON.stringify({ bvid: 'BV坏' }),
    JSON.stringify({ bvid: B, title: '标题B', up: 'UPB', draft: '草稿B' }),
  ].join('\n') + '\n', 'utf8')
  const r = drainInbox(d)
  assert.deepEqual(r.candidates.map((c) => c.bvid), [A, B])
  assert.equal(r.bad, 2, '坏 json + 坏 BV 各算一条')
  assert.equal(r.lines, 4)
  assert.deepEqual(r.candidates[1], { bvid: B, title: '标题B', up: 'UPB', draft: '草稿B' })
})

test('clearInbox：删掉收件箱；删不掉也只是返回 false（不抛）', () => {
  const d = dir()
  writeFileSync(queuePaths(d).inbox, '{}\n', 'utf8')
  assert.equal(clearInbox(d), true)
  assert.equal(existsSync(queuePaths(d).inbox), false)
  assert.equal(clearInbox(d), true, '本来就不在也算清干净了')
  assert.equal(clearInbox(d, { remove: () => { throw new Error('占用中（合成的）') } }), false)
})

test('appendDropped / readDropped：队列满掉的候选有可见记录（一行一条 JSONL）', () => {
  const d = dir()
  const at = new Date('2026-11-09T10:00:00Z')
  appendDropped(d, { at, bvid: A, title: '标题A', up: 'UPA', reason: 'queue-full' })
  appendDropped(d, { at, bvid: B, reason: 'duplicate' })
  const rows = readDropped(d)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { at: at.toISOString(), bvid: A, title: '标题A', reason: 'queue-full', up: 'UPA' })
  assert.equal(rows[1].reason, 'duplicate')
  assert.deepEqual(readDropped(d, { limit: 1 }).map((r) => r.bvid), [B])
  assert.deepEqual(readDropped(dir()), [], '没有这个文件 = 空')
})

test('loadQueue：坏条目跳过（缺 BV / 形状不对），重复 BV 只留第一条', () => {
  const d = dir()
  const t0 = new Date('2026-11-09T10:00:00Z')
  writeFileSync(queuePaths(d).file, JSON.stringify({ v: 1, entries: [
    { bvid: A, collectedAt: t0.toISOString(), expiresAt: t0.toISOString() },
    { bvid: A, title: '重复的' },
    { title: '没有 BV' },
    null,
    '字符串',
  ] }), 'utf8')
  const q = loadQueue(d)
  assert.equal(q.entries.length, 1)
  assert.equal(q.entries[0].bvid, A)
  assert.equal(q.entries[0].status, 'pending', '没写 status 就当 pending')
})

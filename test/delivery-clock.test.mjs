// node --test test/
// 工单 07：自动投递时钟 + 故障通知（lib/delivery-clock.mjs）。
// 直接驱动 tick()：注入 now / random / sendPrivate / 临时 stateDir；不联网、不碰真实 ~/.dsh。
// 断言只对外部可观察的东西：队列文件、投递账、投递时钟状态、通知文件、日报、日志。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDeliveryClock, createNotifier, readBaseline, deliveryClockPaths,
  DELIVERY_FAILURE_NOTIFY_THRESHOLD,
} from '../lib/delivery-clock.mjs'
import { loadQueue, saveQueue } from '../lib/queue.mjs'
import { appendDelivery, readDelivery } from '../lib/ledger.mjs'
import { dayKey } from '../lib/state.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-clock-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

const A = 'BV1aaaaaaaaa'
const B = 'BV1bbbbbbbbb'
const C = 'BV1ccccccccc'
const D = 'BV1ddddddddd'
const E = 'BV1eeeeeeeee'
const F = 'BV1fffffffff'

/** 一天里的某个本机时刻 */
const at = (h, m = 0, day = 9) => new Date(2026, 10, day, h, m, 0)

const newDir = () => {
  const dir = mkdtempSync(join(root, 'state-'))
  mkdirSync(join(dir, 'out'), { recursive: true })
  return dir
}

const entry = (bvid, now, extra = {}) => ({
  id: dayKey(now) + ':' + bvid,
  bvid,
  title: '合成标题 ' + bvid,
  up: '合成UP',
  draft: '这条讲得挺清楚，值得花十分钟 ' + bvid,
  collectedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 48 * 3600_000).toISOString(),
  status: 'pending',
  attempts: 0,
  lastError: '',
  retryAt: '',
  ...extra,
})

const putQueue = (dir, list) => saveQueue(dir, { v: 1, entries: list })
const queueOf = (dir) => loadQueue(dir).entries
const readJsonFile = (f, dflt = null) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt } }
const notesOf = (dir) => {
  try {
    return readFileSync(join(dir, 'notifications.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}
const reportOf = (dir, now) => {
  try { return readFileSync(join(dir, 'out', dayKey(now) + '.md'), 'utf8') } catch { return '' }
}

/** 依次返回给定随机数（用完回落 fallback），并记一共被调了几次 */
function seq(values, fallback = 0) {
  const calls = { n: 0 }
  const fn = () => {
    calls.n++
    return calls.n <= values.length ? values[calls.n - 1] : fallback
  }
  fn.calls = calls
  return fn
}

/**
 * 起一个投递时钟：sendPrivate 是桩，会像真的一样往投递账里写一条（成功带 msgKey）。
 * mode 可随时改：ok / fail / blocked / error / busy。
 */
function makeClock({ dir, cfg = {}, nowRef, random = seq([], 0), mode = 'ok', resolveRecipient = null } = {}) {
  const calls = []
  const logs = []
  const refreshed = []
  const state = { mode }
  const cfgObj = {
    channelDm: true,
    dmUid: 12345,
    deliverPerDay: 5,
    deliverMinGapMin: 0,
    deliverMaxGapMin: 0,
    quietStart: '23:00',
    quietEnd: '08:00',
    deliverRetries: 1,
    notifyOnFailure: true,
    reportLevel: 'full',
    ...cfg,
  }
  const sendPrivate = async (input) => {
    const now = nowRef()
    calls.push({ ...input, at: now.toISOString() })
    if (state.mode === 'busy') return { ok: false, busy: true, status: 'busy', record: null }
    const base = {
      at: now.toISOString(),
      bvid: input.bvid,
      receiverUid: input.receiverUid,
      manual: input.manual === true,
      id: input.id,
    }
    if (state.mode === 'ok') {
      const record = appendDelivery(dir, { ...base, status: 'sent', msgKey: 'mk-' + calls.length })
      return { ok: true, status: 'sent', msgKey: record.msgKey, record }
    }
    if (state.mode === 'blocked') {
      const record = appendDelivery(dir, { ...base, status: 'blocked', message: '正文含内部术语' })
      return { ok: false, status: 'blocked', blocked: true, reason: '正文含内部术语', record }
    }
    if (state.mode === 'error') {
      const record = appendDelivery(dir, { ...base, status: 'error', message: '网络断了（合成的）' })
      return { ok: false, status: 'error', reason: '网络断了（合成的）', record }
    }
    const record = appendDelivery(dir, { ...base, status: 'failed', message: '接口拒绝（合成的）' })
    return { ok: false, status: 'failed', reason: '接口拒绝（合成的）', record }
  }
  const clock = createDeliveryClock({
    stateDir: dir,
    cfg: cfgObj,
    now: nowRef,
    random,
    sendPrivate,
    resolveRecipient,
    log: (m) => logs.push(String(m)),
    onQueueChanged: (queue, when) => refreshed.push({ queue, at: when.toISOString() }),
  })
  return { clock, cfg: cfgObj, calls, logs, refreshed, state }
}

/* ───────────── ① 到点发队头；间隔未到不发；抽到的 intervalMs 被持久化 ───────────── */

test('到点发队头；间隔未到不发；抽到的 intervalMs 存回去后不再重抽', async () => {
  const dir = newDir()
  const t0 = at(9, 0)
  putQueue(dir, [entry(A, t0), entry(B, t0)])
  const random = seq([0, 1], 1)          // 第一次抽 45 分钟；成功后抽 120 分钟
  const nowRef = { value: new Date(t0.getTime() + 10 * 60_000) }
  const h = makeClock({
    dir,
    cfg: { deliverMinGapMin: 45, deliverMaxGapMin: 120 },
    nowRef: () => nowRef.value,
    random,
  })
  // 升级前已经投递过一条、但状态里只记了时间（没有 intervalMs）⇒ 第一跳要抽并存
  writeFileSync(deliveryClockPaths(dir).state, JSON.stringify({ lastDelivery: { at: t0.toISOString() } }))

  let r = await h.clock.tick()
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'too-soon')
  assert.equal(h.calls.length, 0, '45 分钟还没到，不发')
  let st = readJsonFile(deliveryClockPaths(dir).state)
  assert.equal(st.lastDelivery.intervalMs, 45 * 60_000, '抽到的间隔必须存回去')
  assert.equal(random.calls.n, 1)

  // 同一份 state 再跳一次：必须复用存下来的间隔，**不能再抽一次**
  r = await h.clock.tick()
  assert.equal(r.reason, 'too-soon')
  assert.equal(random.calls.n, 1, '同一份 state 再 tick 不能重抽（否则间隔会偏向最短）')

  // 45 分钟到了 ⇒ 发队头 A
  nowRef.value = new Date(t0.getTime() + 46 * 60_000)
  r = await h.clock.tick()
  assert.equal(r.sent, true, JSON.stringify(r))
  assert.equal(r.entry.bvid, A)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].bvid, A)
  assert.equal(h.calls[0].manual, false)
  assert.equal(h.calls[0].receiverUid, 12345)
  assert.ok(h.calls[0].text.includes(A), '私信正文要带这条 BV 的链接/编号：' + h.calls[0].text)
  assert.equal(queueOf(dir).find((e) => e.bvid === A).status, 'sent')
  assert.equal(queueOf(dir).find((e) => e.bvid === B).status, 'pending')
  assert.equal(readDelivery(dir).length, 1)
  assert.equal(readDelivery(dir)[0].msgKey.length > 0, true)

  // 成功后已经抽好下一次的间隔（120 分钟）并存住
  st = readJsonFile(deliveryClockPaths(dir).state)
  assert.equal(st.lastDelivery.intervalMs, 120 * 60_000)
  assert.equal(Date.parse(st.lastDelivery.at), nowRef.value.getTime())

  // 紧接着再跳：120 分钟没到，不会连发
  r = await h.clock.tick()
  assert.equal(r.reason, 'too-soon')
  assert.equal(h.calls.length, 1)

  // 队列变过 ⇒ 刷新日报「队列」的回调要叫到
  assert.ok(h.refreshed.length >= 1)
  assert.equal(h.refreshed.at(-1).queue.entries.find((e) => e.bvid === A).status, 'sent')
})

/* ───────────── ② 免打扰（含跨零点边界；起止相同 = 不设） ───────────── */

test('免打扰：23:00–08:00 跨零点，起含止不含；起止相同 = 不设', async () => {
  const cases = [
    { now: at(22, 59), send: true },
    { now: at(23, 0), send: false },     // 起点含
    { now: at(0, 30, 10), send: false }, // 跨零点
    { now: at(7, 59, 10), send: false },
    { now: at(8, 0, 10), send: true },   // 终点不含
  ]
  for (const c of cases) {
    const dir = newDir()
    putQueue(dir, [entry(A, c.now)])
    const h = makeClock({ dir, cfg: { quietStart: '23:00', quietEnd: '08:00' }, nowRef: () => c.now })
    const r = await h.clock.tick()
    assert.equal(r.sent, c.send, c.now.toString() + ' ⇒ ' + JSON.stringify(r))
    if (!c.send) assert.equal(r.reason, 'quiet-hours')
    assert.equal(h.calls.length, c.send ? 1 : 0)
  }

  // 起止相同 = 不设免打扰
  const dir = newDir()
  const now = at(8, 0)
  putQueue(dir, [entry(A, now)])
  const h = makeClock({ dir, cfg: { quietStart: '08:00', quietEnd: '08:00' }, nowRef: () => now })
  const r = await h.clock.tick()
  assert.equal(r.sent, true, '起止相同应当不设免打扰')
})

/* ───────────── ③ 每日上限与跨天恢复（含基线只对当天生效） ───────────── */

test('每日上限：到上限不发；跨天恢复；投递账是事实来源', async () => {
  const dir = newDir()
  const t0 = at(10, 0)
  // 今天已经有 2 条「有回执且非 manual」的投递
  appendDelivery(dir, { at: at(9, 0).toISOString(), bvid: C, status: 'sent', msgKey: 'old-1', receiverUid: 1 })
  appendDelivery(dir, { at: at(9, 30).toISOString(), bvid: D, status: 'sent', msgKey: 'old-2', receiverUid: 1 })
  putQueue(dir, [entry(A, t0), entry(B, t0)])
  const nowRef = { value: t0 }
  const h = makeClock({ dir, cfg: { deliverPerDay: 2 }, nowRef: () => nowRef.value })

  let r = await h.clock.tick()
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'daily-limit')
  assert.equal(r.deliveredToday, 2)
  assert.equal(h.calls.length, 0)

  // 第二天：账本按天翻页，恢复投递
  nowRef.value = at(10, 0, 10)
  r = await h.clock.tick()
  assert.equal(r.sent, true, JSON.stringify(r))
  assert.equal(h.calls.length, 1)
  assert.equal(r.deliveredToday, 1)
})

/* ───────────── ④ 过期：写回 expired、不通知 ───────────── */

test('过期：写回 expired，不发、不通知（日报也不出现「通知」）', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now, { expiresAt: new Date(now.getTime() - 60_000).toISOString() })])
  const h = makeClock({ dir, nowRef: () => now })
  const r = await h.clock.tick()
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'queue-empty')
  assert.equal(h.calls.length, 0)
  assert.equal(queueOf(dir)[0].status, 'expired')
  assert.deepEqual(notesOf(dir), [], '过期不通知')
  assert.ok(!reportOf(dir, now).includes('## 通知'))
  assert.match(h.logs.join('\n'), /队列过期作废/)
})

/* ───────────── ⑤ 失败重试：5 分钟内不重试；到点重试一次；再失败标 failed 并继续 ───────────── */

test('失败：5 分钟内不重试；到点重试一次；再失败标 failed，继续下一条（不堵队）', async () => {
  const dir = newDir()
  const t0 = at(10, 0)
  putQueue(dir, [entry(A, t0), entry(B, t0)])
  const nowRef = { value: t0 }
  const h = makeClock({ dir, cfg: { deliverRetries: 1 }, nowRef: () => nowRef.value, mode: 'fail' })

  let r = await h.clock.tick()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'retry-scheduled')
  assert.equal(r.attempts, 1)
  assert.equal(h.calls.length, 1)
  let a = queueOf(dir).find((e) => e.bvid === A)
  assert.equal(a.status, 'pending', '还能重试 ⇒ 保持 pending')
  assert.equal(a.attempts, 1)
  assert.match(a.lastError, /接口拒绝/)
  assert.equal(Date.parse(a.retryAt), t0.getTime() + 5 * 60_000, '5 分钟后重试')

  // 4 分钟后：还不到点，不发
  nowRef.value = new Date(t0.getTime() + 4 * 60_000)
  r = await h.clock.tick()
  assert.equal(r.reason, 'retry-backoff')
  assert.equal(h.calls.length, 1)
  assert.equal(queueOf(dir).find((e) => e.bvid === A).attempts, 1)

  // 5 分钟到了：重试一次
  nowRef.value = new Date(t0.getTime() + 5 * 60_000)
  r = await h.clock.tick()
  assert.equal(r.reason, 'sent-failed', JSON.stringify(r))
  assert.equal(h.calls.length, 2)
  a = queueOf(dir).find((e) => e.bvid === A)
  assert.equal(a.status, 'failed')
  assert.equal(a.attempts, 2)
  assert.equal(a.retryAt, '')

  // 不堵队：下一跳轮到 B（这次让它成功）
  h.state.mode = 'ok'
  nowRef.value = new Date(t0.getTime() + 5 * 60_000 + 1000)
  r = await h.clock.tick()
  assert.equal(r.sent, true, JSON.stringify(r))
  assert.equal(h.calls.at(-1).bvid, B)
  assert.equal(queueOf(dir).find((e) => e.bvid === B).status, 'sent')
  assert.equal(readJsonFile(deliveryClockPaths(dir).state).consecutiveFailures, 0, '成功要清零连续失败计数')

  // 两次失败还没到「连续 3 次」⇒ 不通知
  assert.deepEqual(notesOf(dir), [])
})

/* ───────────── ⑥ blocked 不重试；busy 不落账、不占次数 ───────────── */

test('blocked：正文没过机械检查 ⇒ 直接 failed，不重试', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  const h = makeClock({ dir, cfg: { deliverRetries: 3 }, nowRef: () => now, mode: 'blocked' })
  const r = await h.clock.tick()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'sent-failed')
  assert.equal(r.attempts, 1, 'blocked 不占重试机会')
  assert.equal(h.calls.length, 1)
  const a = queueOf(dir)[0]
  assert.equal(a.status, 'failed')
  assert.match(a.lastError, /内部术语/)
})

test('busy：另一个宿主正在发 ⇒ 这一跳跳过，不落账、不增 attempts、条目仍 pending', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  const h = makeClock({ dir, nowRef: () => now, mode: 'busy' })
  const r = await h.clock.tick()
  assert.equal(r.ok, true)
  assert.equal(r.busy, true)
  assert.equal(r.reason, 'busy')
  assert.equal(h.calls.length, 1)
  assert.equal(readDelivery(dir).length, 0, 'busy 不是一次投递尝试 ⇒ 不落账')
  const a = queueOf(dir)[0]
  assert.equal(a.status, 'pending')
  assert.equal(a.attempts, 0)
  assert.equal(a.retryAt, '')
})

/* ───────────── ⑦ 账本已有回执 ⇒ 不重复发 ───────────── */

test('账本里已有同一 BV 的回执 ⇒ 队列改 sent，不重复发', async () => {
  const dir = newDir()
  const now = at(10, 0)
  appendDelivery(dir, { at: at(9, 30).toISOString(), bvid: A, status: 'sent', msgKey: 'already', receiverUid: 1 })
  putQueue(dir, [entry(A, now)])
  const h = makeClock({ dir, nowRef: () => now })
  const r = await h.clock.tick()
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'already-delivered')
  assert.equal(h.calls.length, 0, '有回执就不该再发一次')
  assert.equal(queueOf(dir)[0].status, 'sent')
  assert.equal(readDelivery(dir).filter((x) => x.bvid === A).length, 1)
})

/* ───────────── ⑧ 一次性基线：升级当天不会静默放量 ───────────── */

test('基线：旧 state / 旧日报 / 判重表取最大；当天最多再发 deliverPerDay-N 条；第二天账本说了算', async () => {
  const dir = newDir()
  const day1 = at(10, 0)
  // 三个旧来源：state.picked=1 · 日报 ### BV=2 · 判重表挑中=1 ⇒ 基线取最大 2
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ day: dayKey(day1), picked: 1 }))
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(join(dir, 'out', dayKey(day1) + '.md'), [
    '# 刷B站日报', '', '### ' + C, '- 标题：合成旧条目 C', '', '### ' + D, '- 标题：合成旧条目 D', '',
  ].join('\n'))
  writeFileSync(join(dir, 'seen.md'), [
    '| 日期 | BV | 标题 | UP | 状态 |',
    '| ' + dayKey(day1) + ' | ' + E + ' | 合成 E | UP | 挑了 |',
  ].join('\n'))

  const nowRef = { value: day1 }
  const h = makeClock({ dir, cfg: { deliverPerDay: 5 }, nowRef: () => nowRef.value })
  const five = [A, B, C, D, E]
  putQueue(dir, five.map((bv) => entry(bv, day1)))

  // 一直跳到发不动为止（间隔 0）
  let sent = 0
  for (let i = 0; i < 10; i++) {
    const r = await h.clock.tick()
    if (r.sent) { sent++; continue }
    assert.ok(['daily-limit', 'queue-empty'].includes(r.reason), JSON.stringify(r))
    if (r.reason === 'queue-empty') break
  }
  assert.equal(sent, 3, '上限 5 - 基线 2 = 今天最多再发 3 条（实际发了 ' + sent + '）')
  assert.equal(readDelivery(dir).length, 3)

  const baseline = readBaseline(dir)
  assert.equal(baseline.day, dayKey(day1))
  assert.equal(baseline.count, 2, '三源取最大：' + JSON.stringify(baseline.sources))
  assert.deepEqual(baseline.sources, { state: 1, report: 2, seen: 1 })
  assert.equal(existsSync(deliveryClockPaths(dir).marker), true)
  assert.match(h.logs.join('\n'), /投递账基线/) 

  // 第二天：基线不再生效，账本说了算（上限 5，还剩 2 条就发 2 条）
  nowRef.value = at(10, 0, 10)
  let sent2 = 0
  for (let i = 0; i < 10; i++) {
    const r = await h.clock.tick()
    if (r.sent) { sent2++; continue }
    if (r.reason === 'queue-empty') break
    assert.equal(r.reason, 'daily-limit', JSON.stringify(r))
  }
  assert.equal(sent2, 2, '第二天不再扣基线，剩下的两条都发')
})

/* ───────────── ⑨ 连续失败通知；notifyOnFailure=false 一条都不发 ───────────── */

test('连续 3 次投递失败 ⇒ 一条可读通知（带最近原因），落到通知文件 / duty.log / 日报', async () => {
  const dir = newDir()
  const t0 = at(10, 0)
  const bvs = [A, B, C]
  putQueue(dir, bvs.map((bv) => entry(bv, t0)))
  const nowRef = { value: t0 }
  const h = makeClock({ dir, cfg: { deliverRetries: 0 }, nowRef: () => nowRef.value, mode: 'fail' })

  for (let i = 0; i < 3; i++) {
    nowRef.value = new Date(t0.getTime() + i * 60_000)
    const r = await h.clock.tick()
    assert.equal(r.reason, 'sent-failed', JSON.stringify(r))
    assert.equal(queueOf(dir).find((e) => e.bvid === bvs[i]).status, 'failed')
  }

  const notes = notesOf(dir)
  assert.equal(notes.length, 1, '三次失败只通知一次（同类通知还有冷却）')
  assert.equal(notes[0].kind, 'delivery-failed')
  assert.match(notes[0].message, /连续失败 3 次/)
  assert.match(notes[0].message, /接口拒绝/)
  assert.ok(Date.parse(notes[0].at))
  assert.match(h.logs.join('\n'), /通知（delivery-failed）/)
  const report = reportOf(dir, t0)
  assert.match(report, /^## 通知$/m)
  assert.match(report, /投递失败/)

  // 第 4 跳：队列空，不产生新的通知
  const before = notesOf(dir).length
  const r = await h.clock.tick()
  assert.equal(r.reason, 'queue-empty')
  assert.equal(notesOf(dir).length, before)
  assert.equal(DELIVERY_FAILURE_NOTIFY_THRESHOLD, 3)
})

test('notifyOnFailure=false：投递失败 / 队列空都不产生通知', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  const h = makeClock({ dir, cfg: { deliverRetries: 0, notifyOnFailure: false }, nowRef: () => now, mode: 'fail' })
  const r = await h.clock.tick()
  assert.equal(r.reason, 'sent-failed')
  assert.deepEqual(notesOf(dir), [])
  assert.ok(!reportOf(dir, now).includes('## 通知'))
})

test('notifier：同类通知 6 小时冷却；不同 kind 各自计；开关关着直接跳过', () => {
  const dir = newDir()
  const cfg = { notifyOnFailure: true }
  const n = createNotifier({ stateDir: dir, outDir: join(dir, 'out'), cfg, now: () => at(10, 0) })

  assert.equal(n.notify({ kind: 'collect-failed', message: '第一次采集失败', at: at(10, 0) }).ok, true)
  assert.equal(n.notify({ kind: 'collect-failed', message: '一小时后又一次', at: at(11, 0) }).ok, false)
  assert.equal(n.notify({ kind: 'delivery-failed', message: '另一种故障', at: at(11, 0) }).ok, true)
  assert.equal(n.notify({ kind: 'collect-failed', message: '七小时后', at: at(17, 0) }).ok, true)

  const recent = n.recent(10)
  assert.equal(recent.length, 3)
  assert.equal(recent[0].message, '七小时后', '最近的在前')
  assert.deepEqual(Object.keys(recent[0]).sort(), ['at', 'kind', 'message'], '通知记录形状固定')

  cfg.notifyOnFailure = false
  assert.deepEqual(n.notify({ kind: 'delivery-failed', message: '关掉后不该写', at: at(23, 0) }), { ok: false, skipped: 'disabled' })
  assert.equal(n.recent(10).length, 3)
})

/* ───────────── ⑩ 跨宿主锁 / 手动投递 / 0 条上限 ───────────── */

test('跨宿主：投递时钟锁被别人占着 ⇒ 这一跳直接让开（不改队列、不发）', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  writeFileSync(deliveryClockPaths(dir).lock, JSON.stringify({ pid: process.pid, ts: Date.now() }))
  const h = makeClock({ dir, nowRef: () => now })
  const r = await h.clock.tick()
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'locked')
  assert.equal(r.busy, true)
  assert.equal(h.calls.length, 0)
  assert.equal(queueOf(dir)[0].status, 'pending')
  assert.equal(readDelivery(dir).length, 0)

  // 锁放掉（TTL 之外）⇒ 下一跳照常发
  writeFileSync(deliveryClockPaths(dir).lock, JSON.stringify({ pid: process.pid, ts: 0 }))
  const r2 = await h.clock.tick()
  assert.equal(r2.sent, true, JSON.stringify(r2))
})

test('两个宿主同时 tick：短锁只让一个发，另一条不会被重复发出', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now), entry(B, now)])
  // 两个时钟共享同一个 stateDir（= 两个宿主），各自的发送桩都记到同一份投递账
  const h1 = makeClock({ dir, nowRef: () => now })
  const h2 = makeClock({ dir, nowRef: () => now })
  const [r1, r2] = await Promise.all([h1.clock.tick(), h2.clock.tick()])
  const sent = [r1, r2].filter((r) => r.sent).length
  const locked = [r1, r2].filter((r) => r.reason === 'locked').length
  assert.equal(sent, 1, JSON.stringify([r1, r2]))
  assert.equal(locked, 1, JSON.stringify([r1, r2]))
  assert.equal(h1.calls.length + h2.calls.length, 1)
  assert.equal(readDelivery(dir).length, 1, '投递账里只有一条')
  assert.equal(queueOf(dir).filter((e) => e.status === 'sent').length, 1)
  assert.equal(queueOf(dir).filter((e) => e.status === 'pending').length, 1)
})

test('deliverNow（给 09）：无视间隔与每日上限、不占额度、带短防连点', async () => {
  const dir = newDir()
  const t0 = at(10, 0)
  putQueue(dir, [entry(A, t0), entry(B, t0)])
  const nowRef = { value: t0 }
  const h = makeClock({ dir, cfg: { deliverPerDay: 1, deliverMinGapMin: 120, deliverMaxGapMin: 120 }, nowRef: () => nowRef.value })

  const r = await h.clock.deliverNow()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.sent, true)
  assert.equal(r.manual, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].manual, true)
  assert.equal(queueOf(dir).find((e) => e.bvid === A).status, 'sent')
  const rec = readDelivery(dir)[0]
  assert.equal(rec.manual, true)
  assert.equal(rec.status, 'sent')

  // 立刻再点：防连点
  const again = await h.clock.deliverNow()
  assert.equal(again.reason, 'cooldown')
  assert.equal(h.calls.length, 1)

  // 手动投递不占当日额度 ⇒ 过了随机的间隔，自动还能再发一条（上限 1）
  nowRef.value = new Date(t0.getTime() + 3 * 3600_000)
  const auto = await h.clock.tick()
  assert.equal(auto.sent, true, JSON.stringify(auto))
  assert.equal(h.calls.at(-1).manual, false)
  assert.equal(queueOf(dir).find((e) => e.bvid === B).status, 'sent')

  // 队列空时明确告知
  const empty = await h.clock.deliverNow()
  assert.equal(empty.reason, 'queue-empty')
  assert.match(empty.message, /没有待投递/)
})

test('deliverPerDay=0 ⇒ 不自动投递；没有收件人 ⇒ 也不发', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  let h = makeClock({ dir, cfg: { deliverPerDay: 0 }, nowRef: () => now })
  let r = await h.clock.tick()
  assert.equal(r.reason, 'disabled')
  assert.equal(h.calls.length, 0)
  assert.equal(queueOf(dir)[0].status, 'pending')

  const dir2 = newDir()
  putQueue(dir2, [entry(A, now)])
  h = makeClock({ dir: dir2, cfg: { dmUid: 0 }, nowRef: () => now })
  r = await h.clock.tick()
  assert.equal(r.reason, 'no-recipient')
  assert.equal(h.calls.length, 0)
})

test('只填昵称（dmUid=0）⇒ 用 resolveRecipient 解析出的 UID 投递', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  let asked = 0
  const h = makeClock({
    dir,
    cfg: { dmUid: 0 },
    nowRef: () => now,
    resolveRecipient: async () => { asked++; return 987654 },
  })
  const r = await h.clock.tick()
  assert.equal(r.sent, true, JSON.stringify(r))
  assert.equal(asked, 1, '没填 UID ⇒ 必须问一次昵称解析')
  assert.equal(h.calls[0].receiverUid, 987654)
})

test('昵称查不到 ⇒ no-recipient，不发；填了 UID 就不必去查', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  let asked = 0
  let h = makeClock({
    dir,
    cfg: { dmUid: 0 },
    nowRef: () => now,
    resolveRecipient: async () => { asked++; return 0 },
  })
  let r = await h.clock.tick()
  assert.equal(r.reason, 'no-recipient')
  assert.equal(h.calls.length, 0, '查不到收件人 ⇒ 一条都不发')
  assert.equal(asked, 1)

  const dir2 = newDir()
  putQueue(dir2, [entry(A, now)])
  asked = 0
  h = makeClock({
    dir: dir2,
    cfg: { dmUid: 12345 },
    nowRef: () => now,
    resolveRecipient: async () => { asked++; return 999 },
  })
  r = await h.clock.tick()
  assert.equal(r.sent, true, JSON.stringify(r))
  assert.equal(asked, 0, '填了 UID 就不该再打昵称接口')
})

test('「现在投递」同样认昵称解析出来的 UID', async () => {
  const dir = newDir()
  const now = at(10, 0)
  putQueue(dir, [entry(A, now)])
  let asked = 0
  const h = makeClock({
    dir,
    cfg: { dmUid: 0 },
    nowRef: () => now,
    resolveRecipient: async () => { asked++; return 24680 },
  })
  const r = await h.clock.deliverNow()
  assert.equal(r.sent, true, JSON.stringify(r))
  assert.equal(asked, 1)
  assert.equal(h.calls[0].receiverUid, 24680)
})

test('手动投递不重排自动节奏：手动发完，下一跳仍按原间隔等', async () => {
  const dir = newDir()
  const t0 = at(10, 0)
  putQueue(dir, [entry(A, t0), entry(B, t0)])
  // 自动节奏：上一条在 t0 发的，下一条要等满 120 分钟
  writeFileSync(deliveryClockPaths(dir).state, JSON.stringify({
    lastDelivery: { at: t0.toISOString(), intervalMs: 120 * 60_000 },
  }))
  const nowRef = { value: new Date(t0.getTime() + 5 * 60_000) }
  const h = makeClock({ dir, cfg: { deliverMinGapMin: 120, deliverMaxGapMin: 120 }, nowRef: () => nowRef.value })

  const manual = await h.clock.deliverNow()
  assert.equal(manual.sent, true, JSON.stringify(manual))
  const afterManual = readJsonFile(deliveryClockPaths(dir).state)
  assert.equal(afterManual.lastDelivery.at, t0.toISOString(), '手动投递不能改写自动节奏的锚点')
  assert.equal(afterManual.lastDelivery.intervalMs, 120 * 60_000, '手动投递不能把间隔归零')

  const soon = await h.clock.tick()
  assert.equal(soon.reason, 'too-soon', '手动发完 5 分钟，自动这一跳还不该发')
  assert.equal(h.calls.length, 1)

  nowRef.value = new Date(t0.getTime() + 121 * 60_000)
  const auto = await h.clock.tick()
  assert.equal(auto.sent, true, JSON.stringify(auto))
  assert.equal(h.calls.at(-1).bvid, B)
})

test('私信关着 ⇒ 整跳直接返回，不读队列也不写文件', async () => {
  const dir = newDir()
  const h = makeClock({ dir, cfg: { channelDm: false }, nowRef: () => at(10, 0) })
  const r = await h.clock.tick()
  assert.equal(r.reason, 'dm-off')
  assert.equal(h.calls.length, 0)
  assert.equal(existsSync(deliveryClockPaths(dir).marker), false, '私信关着不该做基线')
})

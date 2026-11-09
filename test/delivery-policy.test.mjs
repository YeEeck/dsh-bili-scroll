// node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateDelivery } from '../lib/delivery-policy.mjs'

// —— 夹具 ——
// 时刻一律用本地时间构造（`new Date(y, m, d, h, min, s)`），
// 模块也按本机时区的墙上时间读 `now`，所以这些断言在任何时区跑结果都一样。
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s)
const iso = (d) => d.toISOString()

/** 队列条目的完整形状（和宿主写进队列的一致） */
const entry = (id, extra = {}) => ({
  id,
  bvid: 'BV' + id,
  title: '标题 ' + id,
  up: 'UP ' + id,
  draft: '草稿 ' + id,
  collectedAt: iso(at(2026, 11, 9, 9, 0)),
  expiresAt: iso(at(2026, 11, 10, 9, 0)),
  status: 'pending',
  attempts: 0,
  lastError: '',
  ...extra,
})

/** 投递账记录：有回执（msgKey）才算「已投递」 */
const receipt = (when, extra = {}) => ({
  at: iso(when),
  bvid: 'BVx',
  status: 'sent',
  msgKey: 'k-' + when.getTime(),
  receiverUid: 1,
  ...extra,
})

const fixed = (v) => () => v

/** 只取出外部可观察的答案，不碰模块内部 */
const answer = (r) => ({
  send: r.send,
  reason: r.reason,
  next: r.next?.id ?? null,
  expired: r.expired.map((e) => e.id),
  failed: r.failed.map((e) => e.id),
  intervalMs: r.intervalMs,
  deliveredToday: r.deliveredToday,
})

/** 表驱动：一行一个断言，失败时带上这一行的名字 */
const table = (rows) => {
  for (const row of rows) assert.deepEqual(answer(evaluateDelivery(row.input)), row.want, row.name)
}

test('队列空、或有一条可投递时：回答「发不发」和「发谁」', () => {
  const now = at(2026, 11, 9, 15, 0)
  table([
    {
      name: '队列空 ⇒ 不发，理由是队列空',
      input: { now, policy: {}, queue: [] },
      want: { send: false, reason: 'queue-empty', next: null, expired: [], failed: [], intervalMs: null, deliveredToday: 0 },
    },
    {
      name: '有候选 ⇒ 发队头那条',
      input: { now, policy: {}, queue: [entry('a'), entry('b')] },
      want: { send: true, reason: 'ok', next: 'a', expired: [], failed: [], intervalMs: null, deliveredToday: 0 },
    },
  ])
})

test('重试次数到上限：判为失败，不再被选中', () => {
  const now = at(2026, 11, 9, 15, 0)
  const policy = { maxAttempts: 2 }
  const end = { send: false, reason: 'queue-empty', next: null, expired: [], failed: [], intervalMs: null, deliveredToday: 0 }
  table([
    {
      name: '还没试过 ⇒ 能发',
      input: { now, policy, queue: [entry('a')] },
      want: { ...end, send: true, reason: 'ok', next: 'a' },
    },
    {
      name: '试过 1 次、上限 2 次 ⇒ 还留着重试一次',
      input: { now, policy, queue: [entry('a', { attempts: 1 })] },
      want: { ...end, send: true, reason: 'ok', next: 'a' },
    },
    {
      name: '试满 2 次 ⇒ 失败，不再被选中',
      input: { now, policy, queue: [entry('a', { attempts: 2 })] },
      want: { ...end, failed: ['a'] },
    },
    {
      name: '队头试满 ⇒ 跳到下一条，不堵队',
      input: { now, policy, queue: [entry('a', { attempts: 5 }), entry('b')] },
      want: { ...end, send: true, reason: 'ok', next: 'b', failed: ['a'] },
    },
    {
      name: '又过期又试满 ⇒ 只报过期（过期优先）',
      input: { now, policy, queue: [entry('a', { attempts: 2, expiresAt: iso(new Date(now.getTime() - 1)) })] },
      want: { ...end, expired: ['a'] },
    },
    {
      name: '已经标过 sent / failed 的既不报失败也不占队头',
      input: { now, policy, queue: [entry('a', { status: 'failed', attempts: 2 }), entry('b', { status: 'sent' }), entry('c')] },
      want: { ...end, send: true, reason: 'ok', next: 'c' },
    },
  ])
})

test('与上一条的间隔：没到点不发，正好到点就发', () => {
  const min = 30
  const max = 90
  const lastAt = at(2026, 11, 9, 14, 0)
  const hour = 60 * 60 * 1000
  const base = { send: false, reason: 'too-soon', next: 'a', expired: [], failed: [], intervalMs: hour, deliveredToday: 0 }
  table([
    {
      name: '差一毫秒 ⇒ 还没到',
      input: { now: new Date(lastAt.getTime() + hour - 1), policy: { minIntervalMin: min, maxIntervalMin: max }, queue: [entry('a')], lastDelivery: { at: lastAt, intervalMs: hour } },
      want: base,
    },
    {
      name: '正好到点 ⇒ 发',
      input: { now: new Date(lastAt.getTime() + hour), policy: { minIntervalMin: min, maxIntervalMin: max }, queue: [entry('a')], lastDelivery: { at: lastAt, intervalMs: hour } },
      want: { ...base, send: true, reason: 'ok' },
    },
    {
      name: '过了点 ⇒ 发',
      input: { now: new Date(lastAt.getTime() + hour + 1), policy: { minIntervalMin: min, maxIntervalMin: max }, queue: [entry('a')], lastDelivery: { at: lastAt, intervalMs: hour } },
      want: { ...base, send: true, reason: 'ok' },
    },
    {
      name: '没有上一条 ⇒ 不设间隔',
      input: { now: at(2026, 11, 9, 14, 0), policy: { minIntervalMin: min, maxIntervalMin: max }, queue: [entry('a')], lastDelivery: null },
      want: { ...base, send: true, reason: 'ok', intervalMs: null },
    },
  ])
})

test('间隔在最短与最长之间随机：随机源可注入，测试里种子固定', () => {
  const now = at(2026, 11, 9, 15, 0)
  const lastAt = at(2026, 11, 9, 14, 0)
  const MIN = 30 * 60 * 1000
  const MAX = 90 * 60 * 1000
  const policy = { minIntervalMin: 30, maxIntervalMin: 90 }
  const draw = (random) => answer(evaluateDelivery({ now, policy, queue: [entry('a')], lastDelivery: { at: lastAt }, random }))

  // 抽到 0 / 中点 / 1 时正好落在两端和中点
  assert.equal(draw(fixed(0)).intervalMs, MIN)
  assert.equal(draw(fixed(0.5)).intervalMs, (MIN + MAX) / 2)
  assert.equal(draw(fixed(1)).intervalMs, MAX)

  // 固定种子的线性同余发生器：同一颗种子给出同一串间隔，且始终落在 [最短, 最长] 里
  const seeded = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const draws = (seed) => {
    const r = seeded(seed)
    return Array.from({ length: 50 }, () => draw(r).intervalMs)
  }
  const once = draws(42)
  assert.deepEqual(draws(42), once)
  for (const ms of once) assert.ok(ms >= MIN && ms <= MAX, `${ms} 不在 [${MIN}, ${MAX}] 里`)

  // 宿主把上次抽到的间隔带回来 ⇒ 不再重新抽（同一时刻反复问，答案不变）
  const again = answer(evaluateDelivery({
    now,
    policy,
    queue: [entry('a')],
    lastDelivery: { at: lastAt, intervalMs: once[0] },
    random: () => { throw new Error('带了 intervalMs 就不该再抽随机数') },
  }))
  assert.equal(again.intervalMs, once[0])
})

test('免打扰时段跨零点（23:30–08:30）：起含止不含，边界那一分有明确答案', () => {
  const policy = { quietStart: '23:30', quietEnd: '08:30' }
  const ok = { send: true, reason: 'ok', next: 'a', expired: [], failed: [], intervalMs: null, deliveredToday: 0 }
  const quiet = { ...ok, send: false, reason: 'quiet-hours' }
  table([
    { name: '23:29:59 ⇒ 还没开始', input: { now: at(2026, 11, 9, 23, 29, 59), policy, queue: [entry('a')] }, want: ok },
    { name: '23:30:00 ⇒ 开始', input: { now: at(2026, 11, 9, 23, 30, 0), policy, queue: [entry('a')] }, want: quiet },
    { name: '23:59:59 ⇒ 仍在时段内', input: { now: at(2026, 11, 9, 23, 59, 59), policy, queue: [entry('a')] }, want: quiet },
    { name: '00:00:00 ⇒ 跨过零点还是时段内', input: { now: at(2026, 11, 10, 0, 0, 0), policy, queue: [entry('a')] }, want: quiet },
    { name: '08:29:59 ⇒ 最后一秒仍是时段内', input: { now: at(2026, 11, 10, 8, 29, 59), policy, queue: [entry('a')] }, want: quiet },
    { name: '08:30:00 ⇒ 结束，可以发', input: { now: at(2026, 11, 10, 8, 30, 0), policy, queue: [entry('a')] }, want: ok },
    { name: '08:30:01 ⇒ 时段外', input: { now: at(2026, 11, 10, 8, 30, 1), policy, queue: [entry('a')] }, want: ok },
    { name: '白天的时刻不受跨零点时段影响', input: { now: at(2026, 11, 9, 15, 0), policy, queue: [entry('a')] }, want: ok },
  ])
})

test('免打扰时段不跨零点（12:00–14:00）、起止相同、写坏的配置', () => {
  const ok = { send: true, reason: 'ok', next: 'a', expired: [], failed: [], intervalMs: null, deliveredToday: 0 }
  const quiet = { ...ok, send: false, reason: 'quiet-hours' }
  const policy = { quietStart: '12:00', quietEnd: '14:00' }
  table([
    { name: '11:59:59 ⇒ 还没开始', input: { now: at(2026, 11, 9, 11, 59, 59), policy, queue: [entry('a')] }, want: ok },
    { name: '12:00:00 ⇒ 开始', input: { now: at(2026, 11, 9, 12, 0, 0), policy, queue: [entry('a')] }, want: quiet },
    { name: '13:59:59 ⇒ 仍在时段内', input: { now: at(2026, 11, 9, 13, 59, 59), policy, queue: [entry('a')] }, want: quiet },
    { name: '14:00:00 ⇒ 结束', input: { now: at(2026, 11, 9, 14, 0, 0), policy, queue: [entry('a')] }, want: ok },
    {
      name: '起止相同 ⇒ 空时段，当作不设免打扰',
      input: { now: at(2026, 11, 9, 8, 0, 0), policy: { quietStart: '08:00', quietEnd: '08:00' }, queue: [entry('a')] },
      want: ok,
    },
    {
      name: '时间写坏了 ⇒ 当作不设免打扰',
      input: { now: at(2026, 11, 9, 23, 59, 0), policy: { quietStart: '25:00', quietEnd: '08:30' }, queue: [entry('a')] },
      want: ok,
    },
    {
      name: '队列空时先答队列空（免打扰不抢理由）',
      input: { now: at(2026, 11, 9, 23, 59, 0), policy: { quietStart: '23:30', quietEnd: '08:30' }, queue: [] },
      want: { ...ok, send: false, reason: 'queue-empty', next: null },
    },
  ])
})

test('每日上限：只数有回执的「已投递」，跨天归零，手动投递不占额度', () => {
  const policy = { dailyLimit: 3 }
  const now = at(2026, 11, 9, 15, 0)
  const sent = new Date(2026, 10, 9, 9, 0)
  const today3 = [
    receipt(sent),
    receipt(new Date(2026, 10, 9, 11, 0)),
    receipt(new Date(2026, 10, 9, 13, 0)),
  ]
  const base = { send: false, reason: 'daily-limit', next: 'a', expired: [], failed: [], intervalMs: null, deliveredToday: 3 }
  table([
    {
      name: '今天已投递 3 条、上限 3 ⇒ 不发',
      input: { now, policy, queue: [entry('a')], ledger: today3 },
      want: base,
    },
    {
      name: '今天 2 条 ⇒ 还能发',
      input: { now, policy, queue: [entry('a')], ledger: today3.slice(0, 2) },
      want: { ...base, send: true, reason: 'ok', deliveredToday: 2 },
    },
    {
      name: '昨天投递的 3 条不算今天',
      input: { now, policy, queue: [entry('a')], ledger: today3.map((r) => receipt(new Date(2026, 10, 8, 9, 0))) },
      want: { ...base, send: true, reason: 'ok', deliveredToday: 0 },
    },
    {
      name: '同一份账：过了零点就归零（00:01 时昨天的 3 条不算）',
      input: { now: at(2026, 11, 10, 0, 1), policy, queue: [entry('a')], ledger: today3 },
      want: { ...base, send: true, reason: 'ok', deliveredToday: 0 },
    },
    {
      name: '手动投递不占当日额度',
      input: { now, policy, queue: [entry('a')], ledger: [...today3.slice(0, 2), receipt(new Date(2026, 10, 9, 14, 0), { manual: true })] },
      want: { ...base, send: true, reason: 'ok', deliveredToday: 2 },
    },
    {
      name: '失败尝试（没有回执）不占额度',
      input: {
        now,
        policy,
        queue: [entry('a')],
        ledger: today3.map((r) => ({ ...r, msgKey: undefined, status: 'failed', code: 21007, message: '被拒' })),
      },
      want: { ...base, send: true, reason: 'ok', deliveredToday: 0 },
    },
    {
      name: '上限 0 ⇒ 一条都不发',
      input: { now, policy: { dailyLimit: 0 }, queue: [entry('a')], ledger: [] },
      want: { ...base, deliveredToday: 0 },
    },
  ])
})

test('同时命中多条：按 队列空 → 免打扰 → 当日上限 → 间隔未到 的顺序给理由', () => {
  const policy = { quietStart: '23:30', quietEnd: '08:30', dailyLimit: 1, minIntervalMin: 60, maxIntervalMin: 60 }
  const oneSent = [receipt(at(2026, 11, 9, 20, 0))]
  const justDelivered = { at: at(2026, 11, 9, 23, 40), intervalMs: 60 * 60 * 1000 }
  const base = { send: false, next: 'a', expired: [], failed: [], intervalMs: 60 * 60 * 1000, deliveredToday: 1 }
  table([
    {
      name: '免打扰 + 上限已满 + 间隔未到 ⇒ 说免打扰',
      input: { now: at(2026, 11, 9, 23, 45), policy, queue: [entry('a')], ledger: oneSent, lastDelivery: justDelivered },
      want: { ...base, reason: 'quiet-hours' },
    },
    {
      name: '上限已满 + 间隔未到、不在免打扰 ⇒ 说当日上限',
      input: { now: at(2026, 11, 9, 20, 10), policy: { ...policy, quietStart: undefined, quietEnd: undefined }, queue: [entry('a')], ledger: oneSent, lastDelivery: { at: at(2026, 11, 9, 20, 0), intervalMs: 60 * 60 * 1000 } },
      want: { ...base, reason: 'daily-limit' },
    },
    {
      name: '只有间隔未到 ⇒ 说间隔未到',
      input: { now: at(2026, 11, 9, 20, 10), policy: { ...policy, quietStart: undefined, quietEnd: undefined, dailyLimit: 5 }, queue: [entry('a')], ledger: oneSent, lastDelivery: { at: at(2026, 11, 9, 20, 0), intervalMs: 60 * 60 * 1000 } },
      want: { ...base, reason: 'too-soon' },
    },
  ])
})

test('保质期：到那一刻就算过期，不再被选中', () => {
  const now = at(2026, 11, 9, 15, 0)
  const ms = now.getTime()
  const end = { send: false, reason: 'queue-empty', next: null, expired: [], failed: [], intervalMs: null, deliveredToday: 0 }
  table([
    {
      name: '正好到期 ⇒ 作废',
      input: { now, policy: {}, queue: [entry('a', { expiresAt: iso(new Date(ms)) })] },
      want: { ...end, expired: ['a'] },
    },
    {
      name: '到期前一毫秒 ⇒ 还能发',
      input: { now, policy: {}, queue: [entry('a', { expiresAt: iso(new Date(ms + 1)) })] },
      want: { ...end, send: true, reason: 'ok', next: 'a' },
    },
    {
      name: '过期一毫秒 ⇒ 作废',
      input: { now, policy: {}, queue: [entry('a', { expiresAt: iso(new Date(ms - 1)) })] },
      want: { ...end, expired: ['a'] },
    },
    {
      name: '队头过期 ⇒ 作废它，发下一条',
      input: { now, policy: {}, queue: [entry('a', { expiresAt: iso(new Date(ms - 1000)) }), entry('b')] },
      want: { ...end, send: true, reason: 'ok', next: 'b', expired: ['a'] },
    },
    {
      name: '已经标过 expired 的不重复报（也不占队头）',
      input: { now, policy: {}, queue: [entry('a', { status: 'expired', expiresAt: iso(new Date(ms - 1000)) }), entry('b')] },
      want: { ...end, send: true, reason: 'ok', next: 'b' },
    },
    {
      name: '没写保质期（还没到期时间）⇒ 当作不会过期',
      input: { now, policy: {}, queue: [entry('a', { expiresAt: undefined })] },
      want: { ...end, send: true, reason: 'ok', next: 'a' },
    },
  ])
})

test('策略值写坏/缺省时不抛：钳成能用的形状', () => {
  const lastAt = at(2026, 11, 9, 14, 0)
  const base = { send: false, reason: 'too-soon', next: 'a', expired: [], failed: [], intervalMs: 90 * 60 * 1000, deliveredToday: 0 }
  table([
    {
      name: '最长比最短还短 ⇒ 抬到最短（间隔固定 90 分钟）',
      input: { now: at(2026, 11, 9, 15, 0), policy: { minIntervalMin: 90, maxIntervalMin: 30 }, queue: [entry('a')], lastDelivery: { at: lastAt } },
      want: base,
    },
    {
      name: '只给最短 ⇒ 最长就等于最短',
      input: { now: at(2026, 11, 9, 14, 30), policy: { minIntervalMin: 45 }, queue: [entry('a')], lastDelivery: { at: lastAt } },
      want: { ...base, intervalMs: 45 * 60 * 1000 },
    },
    {
      name: '间隔写成负数 ⇒ 当 0，上一条之后随时可发',
      input: { now: at(2026, 11, 9, 14, 0), policy: { minIntervalMin: -10, maxIntervalMin: -1 }, queue: [entry('a')], lastDelivery: { at: lastAt } },
      want: { ...base, send: true, reason: 'ok', intervalMs: 0 },
    },
    {
      name: '上一条的时间写坏了 ⇒ 当作没有上一条',
      input: { now: at(2026, 11, 9, 15, 0), policy: { minIntervalMin: 30, maxIntervalMin: 90 }, queue: [entry('a')], lastDelivery: { at: '不是时间' } },
      want: { ...base, send: true, reason: 'ok', intervalMs: null },
    },
    {
      name: '上限不是数字 ⇒ 当作不限',
      input: { now: at(2026, 11, 9, 15, 0), policy: { dailyLimit: '很多' }, queue: [entry('a')], ledger: [receipt(at(2026, 11, 9, 9, 0))] },
      want: { ...base, send: true, reason: 'ok', intervalMs: null, deliveredToday: 1 },
    },
    {
      name: '重试上限写成 0 ⇒ 至少 1（试过 1 次就算失败）',
      input: { now: at(2026, 11, 9, 15, 0), policy: { maxAttempts: 0 }, queue: [entry('a', { attempts: 1 })] },
      want: { ...base, reason: 'queue-empty', next: null, failed: ['a'], intervalMs: null },
    },
    {
      name: '队列不是数组 ⇒ 当作空队列',
      input: { now: at(2026, 11, 9, 15, 0), policy: {}, queue: null },
      want: { ...base, reason: 'queue-empty', next: null, intervalMs: null },
    },
  ])
})

test('注入的是时刻还是毫秒都行，答案一样', () => {
  const now = at(2026, 11, 9, 15, 0)
  const withDate = answer(evaluateDelivery({ now, policy: {}, queue: [entry('a')] }))
  const withMs = answer(evaluateDelivery({ now: now.getTime(), policy: {}, queue: [entry('a')] }))
  assert.deepEqual(withMs, withDate)
})

test('没注入 now、或注入的时刻解析不了 ⇒ 抛错（绝不自己取系统时间）', () => {
  assert.throws(() => evaluateDelivery({ queue: [entry('a')] }), /now/)
  assert.throws(() => evaluateDelivery({ now: new Date('乱写'), queue: [entry('a')] }), /now/)
  assert.throws(() => evaluateDelivery({ now: 'not-a-date' }), /now/)
})

test('纯逻辑：不改写传进来的队列与账本', () => {
  const queue = [entry('a', { attempts: 5 }), entry('b', { expiresAt: iso(at(2026, 11, 8, 0, 0)) }), entry('c')]
  const ledger = [receipt(at(2026, 11, 9, 9, 0))]
  const before = structuredClone({ queue, ledger })
  evaluateDelivery({
    now: at(2026, 11, 9, 15, 0),
    policy: { maxAttempts: 2, dailyLimit: 5, minIntervalMin: 30, maxIntervalMin: 90 },
    queue,
    ledger,
    lastDelivery: { at: at(2026, 11, 9, 14, 0) },
    random: fixed(0.5),
  })
  assert.deepEqual({ queue, ledger }, before)
})

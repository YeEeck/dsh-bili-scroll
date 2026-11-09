// node --test test/
// 工单 09：采集时钟的纯函数测试（lib/collect-clock.mjs）—— 不联网、不碰磁盘、不取系统时间。
// 表驱动的都是「外部可观察的行为」：run / reason / timeKey / 清洗结果 / 下一次时刻。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectTick, nextCollectAt, normalizeCollectTimes, COLLECT_TIMES,
} from '../lib/collect-clock.mjs'

/** 本机时区的一天里的某个时刻（秒可给） */
const at = (h, m = 0, s = 0, day = 10) => new Date(2026, 10, day, h, m, s)

const entry = (bvid, extra = {}) => ({
  id: '2026-11-10:' + bvid,
  bvid,
  title: '合成标题 ' + bvid,
  up: '合成UP',
  draft: '合成草稿',
  collectedAt: at(9, 0).toISOString(),
  expiresAt: at(23, 0).toISOString(),
  status: 'pending',
  attempts: 0,
  lastError: '',
  retryAt: '',
  ...extra,
})

const BVS = ['BV1aaaaaaaaa', 'BV1bbbbbbbbb', 'BV1ccccccccc', 'BV1ddddddddd']

/* ───────────── ① 命中当前这一分钟；同一时点当天只跑一次 ───────────── */

test('到点：当前这一分钟在 times 里 ⇒ run；同一时点当天跑过 ⇒ 不再跑', () => {
  const times = ['12:30', '19:30']
  let r = collectTick({ now: at(12, 30, 0), times, channelDm: true })
  assert.equal(r.run, true)
  assert.equal(r.reason, 'collect')
  assert.equal(r.timeKey, '12:30')

  // 这一分钟里的任何一秒都算命中（定时器不保证整点整分）
  r = collectTick({ now: at(12, 30, 59), times, channelDm: true })
  assert.equal(r.run, true)

  // 键写成 'HH:MM' 或 'YYYY-MM-DD HH:MM' 都认
  for (const runsToday of [{ '12:30': true }, { '2026-11-10 12:30': true }]) {
    r = collectTick({ now: at(12, 30, 10), times, runsToday, channelDm: true })
    assert.equal(r.run, false, JSON.stringify(runsToday))
    assert.equal(r.reason, 'already-ran')
    assert.equal(r.timeKey, '12:30')
  }

  // 别的时间点跑过，不影响这个时点
  r = collectTick({ now: at(12, 30, 10), times, runsToday: { '19:30': true }, channelDm: true })
  assert.equal(r.run, true)
})

/* ───────────── ② 错过的时点不补跑 ───────────── */

test('错过不补跑：只认现在这一分钟（12:29 / 12:31 都不跑，12:30 才跑）', () => {
  const times = ['12:30', '19:30']
  for (const now of [at(12, 29, 59), at(12, 31, 0), at(13, 0, 0), at(23, 59, 0)]) {
    const r = collectTick({ now, times, channelDm: true })
    assert.equal(r.run, false, now.toString())
    assert.equal(r.reason, 'no-slot')
    assert.equal(r.timeKey, now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0'))
  }
  assert.equal(collectTick({ now: at(19, 30, 5), times, channelDm: true }).run, true)
})

/* ───────────── ③ 跨天：别的天的记录不挡今天 ───────────── */

test('跨天：昨天 / 明天的同一个时点不挡今天；今天跑过才挡', () => {
  const times = ['12:30']
  const r1 = collectTick({ now: at(12, 30, 0, 11), times, runsToday: { '2026-11-09 12:30': true }, channelDm: true })
  assert.equal(r1.run, true, '昨天的键不该挡今天')
  const r2 = collectTick({ now: at(12, 30, 0, 11), times, runsToday: { '2026-11-12 12:30': true }, channelDm: true })
  assert.equal(r2.run, true, '明天的键也不该挡今天')
  const r3 = collectTick({ now: at(12, 30, 0, 11), times, runsToday: { '2026-11-11 12:30': true }, channelDm: true })
  assert.equal(r3.run, false, '今天的键才挡')
  assert.equal(r3.reason, 'already-ran')
})

/* ───────────── ④ 水位闸：队列满 ───────────── */

test('水位闸①：未过期 pending 达上限 ⇒ 跳过（过期的不算）', () => {
  const times = ['12:30']
  const base = { now: at(12, 30, 0), times, channelDm: true, deliverPerDay: 5, queueLimit: 3 }

  let r = collectTick({ ...base, queue: BVS.slice(0, 3).map((bv) => entry(bv)) })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'queue-full')
  assert.equal(r.pending, 3)
  assert.match(r.message, /上限 3/)
  assert.match(r.message, /跳过/)

  // 其中一条过期了 ⇒ 只剩 2 条 pending，水位没到 ⇒ 照跑
  r = collectTick({
    ...base,
    queue: [
      entry(BVS[0]),
      entry(BVS[1]),
      entry(BVS[2], { expiresAt: at(11, 0).toISOString() }),
    ],
  })
  assert.equal(r.pending, 2)
  assert.equal(r.run, true)

  // 上限 2 时，3 条 pending 也挡
  r = collectTick({ ...base, queueLimit: 2, queue: BVS.slice(0, 3).map((bv) => entry(bv)) })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'queue-full')
})

/* ───────────── ⑤ 水位闸：额度满且队列非空 ───────────── */

test('水位闸②：今日已投递 >= 每天上限 且队列非空 ⇒ 跳过；队列空则照采', () => {
  const times = ['12:30']
  const base = { now: at(12, 30, 0), times, channelDm: true, queueLimit: 3 }
  const one = [entry(BVS[0])]

  let r = collectTick({ ...base, queue: one, deliveredToday: 5, deliverPerDay: 5 })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'quota-full')
  assert.match(r.message, /今天已经投递 5 \/ 5/)
  assert.match(r.message, /跳过/)

  // 额度满了但队列空 ⇒ 照采（攒货，明天发）
  r = collectTick({ ...base, queue: [], deliveredToday: 5, deliverPerDay: 5 })
  assert.equal(r.run, true)

  // 额度没满 ⇒ 照采
  r = collectTick({ ...base, queue: one, deliveredToday: 4, deliverPerDay: 5 })
  assert.equal(r.run, true)

  // 每天 0 条 = 不自动投递 ⇒ 队列里永远发不出去，有库存就跳过
  r = collectTick({ ...base, queue: one, deliveredToday: 0, deliverPerDay: 0 })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'quota-full')
})

/* ───────────── ⑥ 私信关着：不走队列水位闸 ───────────── */

test('私信关着 ⇒ 不建队列、不走水位闸：队列满 + 额度满也照采', () => {
  const r = collectTick({
    now: at(12, 30, 0),
    times: ['12:30'],
    queue: BVS.slice(0, 3).map((bv) => entry(bv)),
    deliveredToday: 99,
    deliverPerDay: 5,
    queueLimit: 3,
    channelDm: false,
  })
  assert.equal(r.run, true)
  assert.equal(r.reason, 'collect')
})

/* ───────────── ⑦ 没有时间点 / 时间写坏 ───────────── */

test('没有配置时间点 ⇒ 永不自动跑（no-times），只能手动', () => {
  const r = collectTick({ now: at(12, 30, 0), times: [], channelDm: true })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'no-times')
  // 没传 times（undefined）= 用默认两个时点，不是"没有时间点"（清洗规则见 normalizeCollectTimes）
  assert.equal(collectTick({ now: at(12, 30, 0), channelDm: true }).run, true)
})

test('注入的 now 不合法 ⇒ bad-now（不抛）', () => {
  const r = collectTick({ now: '不是时间', times: ['12:30'] })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'bad-now')
  assert.equal(r.timeKey, '')
})

/* ───────────── ⑧ 时间点清洗（normalizeCollectTimes） ───────────── */

test('清洗：只留合法 HH:MM、去重、排序、最多 12 个', () => {
  assert.deepEqual(
    normalizeCollectTimes(['25:00', '7:5', '12:30', '12:30', '09:00', '00:00', '23:59', 'x', '']),
    ['00:00', '09:00', '12:30', '23:59'],
  )
  assert.equal(COLLECT_TIMES.max, 12)
  const many = []
  for (let h = 0; h < 15; h++) many.push(String(h).padStart(2, '0') + ':00')
  const cleaned = normalizeCollectTimes(many)
  assert.equal(cleaned.length, 12)
  assert.deepEqual(cleaned, many.slice(0, 12), '排序后截前 12 个')

  // 格式：'H:MM' 补零；非法分钟 / 小时一律丢
  assert.deepEqual(normalizeCollectTimes(['9:05', '9:5', '24:00', '12:60']), ['09:05'])

  // 默认值：没给 / 给的不是数组也不是字符串
  assert.deepEqual(normalizeCollectTimes(undefined), ['12:30', '19:30'])
  assert.deepEqual(normalizeCollectTimes(null), ['12:30', '19:30'])
  assert.deepEqual(normalizeCollectTimes(42), ['12:30', '19:30'])
  // 显式空数组 = 「不按时间点自动采集」（合法值，不退回默认）
  assert.deepEqual(normalizeCollectTimes([]), [])
  // 有内容但全是垃圾 ⇒ 退回默认，别静默变成"永不采集"
  assert.deepEqual(normalizeCollectTimes(['abc', '99:99']), ['12:30', '19:30'])
  // 也认「一行一个 / 逗号分隔」的字符串（手改 config.json 的兜底）
  assert.deepEqual(normalizeCollectTimes('19:30\n12:30'), ['12:30', '19:30'])
  assert.deepEqual(normalizeCollectTimes('09:00, 12:30；18:00'), ['09:00', '12:30', '18:00'])
})

/* ───────────── ⑨ nextCollectAt（设置页「下一次采集」） ───────────── */

test('nextCollectAt：下一个时间点 / 今天的过完就明天最早 / 没配置 = null', () => {
  const times = ['12:30', '19:30']
  const eq = (d, y, mo, day, h, m) => {
    assert.ok(d instanceof Date, '应该是 Date')
    assert.deepEqual(
      [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()],
      [y, mo, day, h, m],
      d.toString(),
    )
  }

  eq(nextCollectAt(at(11, 0), times), 2026, 11, 10, 12, 30)
  eq(nextCollectAt(at(12, 30, 0), times), 2026, 11, 10, 19, 30)   // 严格晚于 now（整分那一刻算"已到"）
  eq(nextCollectAt(at(12, 31, 0), times), 2026, 11, 10, 19, 30)
  eq(nextCollectAt(at(20, 0), times), 2026, 11, 11, 12, 30)       // 跨天
  eq(nextCollectAt(at(23, 59, 59), times), 2026, 11, 11, 12, 30)

  assert.equal(nextCollectAt(at(11, 0), []), null)
  assert.equal(nextCollectAt('不是时间', times), null)

  // 清洗后再算：写坏的时间点不参与
  eq(nextCollectAt(at(13, 0), ['25:00', '19:30']), 2026, 11, 10, 19, 30)
})

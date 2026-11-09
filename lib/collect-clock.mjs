/**
 * lib/collect-clock.mjs —— 采集时钟：回答「此刻该不该跑一轮采集，为什么」
 * ============================================================================
 * 工单 09（`.scratch/collect-deliver/issues/09-collection-clock-and-manual-buttons.md`）：
 *   采集按使用者配置的**固定时间点**（`collectTimes`）跑 —— 不随机、错过的时点作废、
 *   不补跑；每次开跑前先过一道**水位闸**（GLOSSARY「采集轮」「水位闸」）。
 *
 * 纯模块，**零 IO**：不读配置、不读磁盘、不联网、不取系统时间。
 * 注入 `now`（Date | epoch 毫秒）与 `runsToday`（今天跑过的时点）后给出决定；
 * 写状态（state.json 的 collectRuns）由宿主负责 —— 这样「同一时点当天只跑一次」
 * 与「跨天自动失效」都能在测试里直接摆出来。
 *
 * 入参形状：
 *   {
 *     now,            // Date | number：调用方注入的此刻
 *     times,          // 'HH:MM' 数组（宿主的 collectTimes）
 *     runsToday,      // { 'HH:MM': true } 或 { 'YYYY-MM-DD HH:MM': true }：今天已经跑过的时点
 *     queue,          // 队列条目数组，或 { entries: [...] }（只数 pending 且没过期的）
 *     deliveredToday, // 今天已投递条数（口径：基线 + 当天账本；宿主算好传进来）
 *     deliverPerDay,  // 每天最多自动投递几条（0 = 不自动投递）
 *     queueLimit,     // 队列上限（条）
 *     channelDm,      // 私信关着 ⇒ 不建队列、不走水位闸（采集轮走「评论 + 日报」）
 *   }
 *
 * 返回形状：
 *   {
 *     run,        // 此刻该不该跑采集
 *     reason,     // 'collect' | 'no-times' | 'no-slot' | 'already-ran' | 'queue-full' | 'quota-full' | 'bad-now'
 *     timeKey,    // 命中的时点 'HH:MM'；没命中时是当前这一分钟（'bad-now' 时为空）
 *     message,    // 给人看的可读原因（宿主要落 duty.log 的是它，不是 reason 码）
 *     pending,    // 未过期的待投递条数（诊断 / 日志用）
 *     queueLimit, deliverPerDay, deliveredToday,   // 回显（方便日志与设置页复用同一口径）
 *   }
 *
 * 规则（issue 09 定死）：
 *   · 只认「现在这一分钟」：当前 HH:MM 必须在 times 里 ⇒ 否则立刻返回（**过去 N 分钟内的都不补**）；
 *   · 同一时点当天只跑一次（runsToday 里已有 ⇒ 'already-ran'）；跨天由宿主清理 collectRuns；
 *   · 水位闸只在 `channelDm === true` 时生效：
 *       ① 未过期待投递 >= queueLimit ⇒ 'queue-full'；
 *       ② 今日已投递 >= deliverPerDay 且队列非空 ⇒ 'quota-full'；
 *   · 私信关着 ⇒ 不进水位闸（这一轮是「评论 + 日报」，没有队列这回事）。
 * ============================================================================
 */

/** 采集时间点的默认值 / 上限（设置页、DEFAULTS、clampPatch 都按它） */
export const COLLECT_TIMES = Object.freeze({
  default: Object.freeze(['12:30', '19:30']),
  max: 12,
})

/** 把注入的时刻/时间戳收成 Date（只从参数构造，绝不自己取系统时间） */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : new Date(ms)
  }
  return null
}

/** 本机时区的 `HH:MM`（和归档 / 日报的墙上时间同口径） */
function localTimeKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 本机时区的 `YYYY-MM-DD`（和 lib/state.mjs 的 dayKey 同口径；本模块零依赖） */
function localDayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 'HH:MM'（也认 'H:MM'）→ 规范化的 'HH:MM'；写坏了返回 '' */
function canonicalTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return ''
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return ''
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0')
}

/** 把配置里的时间点收成数组（也认「一行一个 / 逗号分隔」的字符串，供手改 config.json 用） */
function splitTimes(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(/[\s,，;；]+/)
  return null
}

/**
 * 清洗采集时间点：只留合法 `HH:MM`、去重、排序、最多 `COLLECT_TIMES.max` 个。
 *
 * - `undefined` / `null` / 认不出的形状 ⇒ 默认的两个时点；
 * - 显式空数组 `[]` ⇒ `[]`（= 不按时间点自动采集，只能手动跑）；
 * - 有内容但全是垃圾 ⇒ 退回默认（别让一次写错**静默**变成"永不采集"）。
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeCollectTimes(input) {
  const raw = splitTimes(input)
  if (!raw) return [...COLLECT_TIMES.default]
  if (!raw.length) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const t = canonicalTime(item)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  if (!out.length) return [...COLLECT_TIMES.default]
  return out.sort().slice(0, COLLECT_TIMES.max)
}

/** 队列条目（数组或 {entries}）里「现在还能投递」的条数：pending 且没过期 */
function pendingCount(queue, at) {
  const list = Array.isArray(queue) ? queue : (Array.isArray(queue?.entries) ? queue.entries : [])
  let n = 0
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    if (String(e.status ?? 'pending') !== 'pending') continue
    const exp = toDate(e.expiresAt)
    if (exp && at.getTime() >= exp.getTime()) continue   // 到期那一刻就算过期
    n++
  }
  return n
}

/** 今天这个时点跑过没有（键认 'HH:MM' 与 'YYYY-MM-DD HH:MM' 两种写法） */
function ranAlready(runsToday, day, timeKey) {
  if (!runsToday || typeof runsToday !== 'object' || Array.isArray(runsToday)) return false
  return Boolean(runsToday[timeKey] || runsToday[day + ' ' + timeKey])
}

/**
 * 采集时钟的一跳（**纯判断**，不落盘、不启动任何东西）。
 *
 * @param {object} input 形状见文件头
 * @returns {{run: boolean, reason: string, timeKey: string, message: string, pending: number,
 *            queueLimit: number, deliverPerDay: number, deliveredToday: number}}
 */
export function collectTick({
  now,
  times,
  runsToday = {},
  queue = [],
  deliveredToday = 0,
  deliverPerDay = 0,
  queueLimit = 3,
  channelDm = true,
} = {}) {
  const at = toDate(now)
  const slots = normalizeCollectTimes(times)
  const limit = Math.max(1, Math.floor(Number(queueLimit) || 3))
  const perDay = Math.max(0, Math.floor(Number(deliverPerDay) || 0))
  const delivered = Math.max(0, Math.floor(Number(deliveredToday) || 0))
  const base = {
    run: false, reason: '', timeKey: '', message: '',
    pending: 0, queueLimit: limit, deliverPerDay: perDay, deliveredToday: delivered,
  }
  if (!at) {
    return { ...base, reason: 'bad-now', message: '注入的 now 不是合法时间 —— 这一跳跳过' }
  }
  const day = localDayKey(at)
  const current = localTimeKey(at)
  base.timeKey = current
  base.pending = pendingCount(queue, at)

  if (!slots.length) {
    return { ...base, reason: 'no-times', message: '还没有配置采集时间点 —— 只能手动跑（设置里填「采集时间点」）' }
  }
  // ⭐ 只认现在这一分钟：错过的不补跑（issue 09 / ADR 明说「错过的采集不作废花钱」）
  if (!slots.includes(current)) {
    return { ...base, reason: 'no-slot', message: '' }
  }
  if (ranAlready(runsToday, day, current)) {
    return { ...base, reason: 'already-ran', message: '这个时点（' + current + '）今天已经跑过了' }
  }

  // 水位闸：只对「私信 / 队列」这套生效；私信关着 ⇒ 采集轮走评论 + 日报，没有队列水位
  if (channelDm === true) {
    if (base.pending >= limit) {
      return {
        ...base,
        reason: 'queue-full',
        message: '队列里已有 ' + base.pending + ' 条待投递（上限 ' + limit + '）—— 这一轮跳过，等投递腾出位置',
      }
    }
    if (delivered >= perDay && base.pending > 0) {
      return {
        ...base,
        reason: 'quota-full',
        message: '今天已经投递 ' + delivered + ' / ' + perDay + ' 条，队列里还有 ' + base.pending
          + ' 条没发 —— 这一轮跳过（明天再采）',
      }
    }
  }

  return {
    ...base,
    run: true,
    reason: 'collect',
    message: '到点了：跑一轮采集（' + current + '）',
  }
}

/**
 * 下一次采集的时刻（给设置页「下一次采集：…」用）：
 * **严格晚于** now 的下一个 time；今天的都过了 ⇒ 明天最早的那个。
 *
 * @param {Date|number|string} now
 * @param {string[]} times
 * @returns {Date|null} 没配置时间点 / now 认不出来 ⇒ null
 */
export function nextCollectAt(now, times) {
  const at = toDate(now)
  if (!at) return null
  const slots = normalizeCollectTimes(times)
  if (!slots.length) return null
  const current = localTimeKey(at)
  const later = slots.find((t) => t > current)
  const pick = later || slots[0]
  const h = Number(pick.slice(0, 2))
  const m = Number(pick.slice(3, 5))
  const dayOffset = later ? 0 : 1
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + dayOffset, h, m, 0, 0)
}

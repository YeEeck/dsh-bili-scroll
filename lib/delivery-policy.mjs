/**
 * lib/delivery-policy.mjs —— 投递策略：回答「此刻该不该发 / 下一条发谁 / 哪几条已过期或该放弃」
 * ============================================================================
 * 纯模块，**零 IO**：不读配置、不读磁盘、不联网、不取系统时间。
 * 时刻（`now`）与随机源（`random`）都由调用方注入 —— 宿主只负责接上时钟和发送通道，
 * 所有「发不发」的判断都收在这一处（见 docs/adr/0001-collect-and-deliver.md）。
 *
 * 入参形状：
 *   {
 *     now,           // Date | number（epoch 毫秒）：调用方注入的此刻
 *     policy: {
 *       dailyLimit,       // 每日最多几条「已投递」；缺省/非法 = 不限
 *       minIntervalMin,   // 与上一条之间最短间隔（分钟）；缺省 0
 *       maxIntervalMin,   // 与上一条之间最长间隔（分钟）；缺省 = 最短
 *       quietStart,       // 免打扰开始的 'HH:MM'（含）；与 quietEnd 都不给 = 不设免打扰
 *       quietEnd,         // 免打扰结束的 'HH:MM'（不含）
 *       maxAttempts,      // 一条最多尝试几次（含首次）；到上限即失败；缺省 1
 *     },
 *     queue,         // 队列条目数组（形状见「采集与投递」规格）：
 *                    //   { id, bvid, title, up, draft, collectedAt, expiresAt, status, attempts, lastError }
 *                    //   只有 status === 'pending'（没写 status 也当 pending）的参与投递；
 *                    //   顺序即队列顺序，本模块不改它；缺/写坏 expiresAt 按「不会过期」兜底（宿主负责写它）。
 *     ledger,        // 投递账记录数组：{ at, bvid, status, msgKey?, code?, message?, receiverUid, manual? }
 *                    //   「已投递」按 GLOSSARY：**有 msgKey（回执）才算**，没有回执的不占额度；
 *                    //   手动投递（manual: true）不占当日额度。
 *     lastDelivery,  // { at, intervalMs? } | null：最近一次投递的时刻；
 *                    //   带上一次抽到的 intervalMs 时不再重新抽（宿主存了它，同一时刻问几次答案一样）。
 *     random,        // () => [0, 1) 的随机源，可注入；缺省 Math.random。测试里给固定值。
 *   }
 *
 * 注入契约：`now` 必须给（缺了或解析不了就抛 TypeError —— 绝不自己取系统时间）；
 *   policy 的字段缺省或写坏都钳成能用的形状，不抛（钳制写在 normalizePolicy 里）。
 *
 * 返回形状：
 *   {
 *     send,           // 此刻该不该发
 *     reason,         // 'ok' | 'queue-empty' | 'quiet-hours' | 'daily-limit' | 'too-soon'
 *     next,           // 下一条要发的条目（不受 send 影响）；没有可投递的 = null
 *     expired,        // 待投递里已过保质期的条目（到期那一刻就算过期）
 *     failed,         // 待投递里尝试次数到上限的条目
 *     intervalMs,     // 本次判定用的间隔（毫秒）；没有上一条 = null
 *     deliveredToday, // 今天已投递条数（回显，供设置页与水位闸复用同一口径）
 *   }
 *
 * 判断优先级：queue-empty → quiet-hours → daily-limit → too-soon → ok。
 * 时间口径：免打扰与「当日」都按**本机时区**的墙上时间（和 `lib/state.mjs` 的 dayKey 一致）；
 *   别和 `inWindow` 的北京时间口径混 —— 那个算的是 DeepSeek 的谷时窗口，这个是使用者自己的作息。
 * ============================================================================
 */

/**
 * 把注入的时刻/时间戳收成 Date。
 * ⚠️ 只从**参数**构造，绝不 `new Date()` 不带参数、也不碰 `Date.now()` —— 本模块不取系统时间。
 */
function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v) : null
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : new Date(ms)
  }
  return null
}

/** 本机时区的日期 YYYY-MM-DD（和 lib/state.mjs 的 dayKey 同口径；这里不 import 它，保持零依赖） */
function localDayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 'HH:MM'（也认 'H:MM'）→ 当天分钟数；写坏了返回 null */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 把配置里可能出现的不合法值收成能用的形状（钳制明细写在返回字段上） */
function normalizePolicy(policy = {}) {
  const num = (v, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  const minIntervalMin = Math.max(0, num(policy.minIntervalMin, 0))
  const maxIntervalMin = Math.max(minIntervalMin, num(policy.maxIntervalMin, minIntervalMin))
  const limit = num(policy.dailyLimit, Infinity)
  const start = minutesOf(policy.quietStart)
  const end = minutesOf(policy.quietEnd)
  return {
    dailyLimit: limit < 0 ? 0 : limit,
    minIntervalMin,
    maxIntervalMin,
    maxAttempts: Math.max(1, Math.floor(num(policy.maxAttempts, 1))),
    // 起止相同 = 空时段，当作不设免打扰
    quiet: start !== null && end !== null && start !== end ? { start, end } : null,
  }
}

/** 抽这次的间隔：落在 [最短, 最长] 之间；随机源坏了/给了界外值就钳回区间端点 */
function drawIntervalMs(p, random) {
  const minMs = p.minIntervalMin * 60 * 1000
  const maxMs = p.maxIntervalMin * 60 * 1000
  if (maxMs <= minMs) return minMs
  const r = Number(random())
  const t = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0
  return Math.round(minMs + t * (maxMs - minMs))
}

/**
 * 抽一次「两条之间」的间隔（毫秒）—— 与 `evaluateDelivery` 内部**同一把尺子**。
 *
 * 为什么要单独导出（工单 07）：投递成功后宿主必须立刻把下一次的间隔抽好、存进
 * `lastDelivery.intervalMs`（「抽一次、存一次」）—— 否则每个 tick 重抽一遍，
 * 间隔会偏向最短。宿主不自己抄一份区间算法，统一走这里。
 *
 * @param {object} [policy] 与 `evaluateDelivery` 的 policy 同形（只用 minIntervalMin / maxIntervalMin）
 * @param {() => number} [random] 随机源，缺省 Math.random
 * @returns {number} 毫秒
 */
export function drawDeliveryInterval(policy = {}, random = Math.random) {
  return drawIntervalMs(normalizePolicy(policy), random)
}

/**
 * @param {object} input 形状见文件头
 * @returns {object} 形状见文件头
 */
export function evaluateDelivery(input = {}) {
  const { now, queue = [], ledger = [], lastDelivery = null, random = Math.random, policy = {} } = input
  const p = normalizePolicy(policy)
  const nowDate = toDate(now)
  if (!nowDate) throw new TypeError('evaluateDelivery 需要注入 now（Date 或 epoch 毫秒）—— 本模块不自己取系统时间')
  const nowMs = nowDate.getTime()

  const expired = []
  const failed = []
  const candidates = []
  for (const e of Array.isArray(queue) ? queue : []) {
    const status = e?.status ?? 'pending'
    if (status !== 'pending') continue
    // 到期那一刻就算过期（和免打扰「起含止不含」刚好相反）
    const expiresAt = toDate(e?.expiresAt)
    if (expiresAt && nowMs >= expiresAt.getTime()) { expired.push(e); continue }
    if ((Number(e?.attempts) || 0) >= p.maxAttempts) { failed.push(e); continue }
    candidates.push(e)
  }

  const next = candidates[0] ?? null

  // 当日已投递数：「已投递」按 GLOSSARY = 拿到回执（msgKey）那一条；
  // 失败尝试没有回执、手动投递不占额度（GLOSSARY「手动投递」），两者都不数。
  const today = localDayKey(nowDate)
  let deliveredToday = 0
  for (const r of Array.isArray(ledger) ? ledger : []) {
    if (!r?.msgKey || r?.manual) continue
    const t = toDate(r?.at)
    if (t && localDayKey(t) === today) deliveredToday++
  }

  // 免打扰时段：按本机时区的墙上时间（和 dayKey 同口径），起含止不含；起 > 止就是跨零点
  const curMin = nowDate.getHours() * 60 + nowDate.getMinutes()
  const inQuiet = Boolean(p.quiet) && (p.quiet.start < p.quiet.end
    ? curMin >= p.quiet.start && curMin < p.quiet.end
    : curMin >= p.quiet.start || curMin < p.quiet.end)

  // 与上一条的间隔：宿主存了上次抽到的 intervalMs 就照用，否则此刻抽一个（抽一次、可复现）
  let intervalMs = null
  let nextAllowedMs = null
  const last = toDate(lastDelivery?.at)
  if (last) {
    const given = Number(lastDelivery?.intervalMs)
    intervalMs = Number.isFinite(given) && given >= 0 ? given : drawIntervalMs(p, random)
    nextAllowedMs = last.getTime() + intervalMs
  }

  // 判断优先级：队列空 → 免打扰 → 当日上限 → 间隔未到
  let reason = 'ok'
  if (!next) reason = 'queue-empty'
  else if (inQuiet) reason = 'quiet-hours'
  else if (deliveredToday >= p.dailyLimit) reason = 'daily-limit'
  else if (nextAllowedMs !== null && nowMs < nextAllowedMs) reason = 'too-soon'

  return { send: reason === 'ok', reason, next, expired, failed, intervalMs, deliveredToday }
}

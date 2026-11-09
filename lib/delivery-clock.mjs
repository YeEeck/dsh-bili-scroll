/**
 * lib/delivery-clock.mjs —— 自动投递时钟 + 故障通知（工单 07）
 * ============================================================================
 * 队列里的候选由**宿主**按策略一条一条发出去（GLOSSARY「投递」「已投递」）：
 *   · 间隔在 [deliverMinGapMin, deliverMaxGapMin] 内随机，**抽一次就存回去**；
 *   · 免打扰时段内不发（支持跨零点；起止相同 = 不设）；
 *   · 每天最多 deliverPerDay 条；失败 5 分钟后重试一次（次数可配），再失败就放弃、继续下一条；
 *   · 两个宿主同时跑也只发一次：一张短锁（本文件）+ 投递账二次校验（lib/ledger.mjs）。
 *
 * 判断「该不该发 / 发谁 / 哪条过期 / 哪条试满」**只看 `evaluateDelivery`**
 * （lib/delivery-policy.mjs，纯逻辑）；本模块只做编排与落盘 —— 别在这里另写一套策略。
 *
 * 文件（都在 `<stateDir>/`，绝不写进插件包目录）：
 *   delivery-clock.json        { lastDelivery: { at, intervalMs }, consecutiveFailures, failDay, lastFailure }
 *                              ⚠️ lastDelivery.intervalMs 必须存：每个 tick 重抽会让间隔偏向最短。
 *   delivery-clock-lock.json   跨宿主的「挑队头 + 发送 + 回写队列」短锁（TTL 5 分钟）
 *   delivery-baseline.json     升级首日的一次性基线 { day, count, sources }
 *   .mig-ledger-baseline       基线做过的标记（存在就不再重算）
 *   notifications.jsonl        故障通知：一行一条 { at, kind, message }
 *
 * 通知（只在故障时说话，notifyOnFailure=false 时一条都不发）：
 *   · 采集轮失败由 index.js 在子进程退出时调 `notifier.notify({kind:'collect-failed'})`；
 *   · 连续投递失败（同日 3 次，成功清零）由本模块发 `delivery-failed`；
 *   · 「没找到值得的」「候选过期」**永远不通知**；同类通知 6 小时冷却。
 *   落地：notifications.jsonl + duty.log + 日报 `## 通知` 列表 + `/status.notifications`。
 *
 * 可注入依赖（测试不联网、不碰真实 `~/.dsh`）：
 *   stateDir / outDir / cfg / now / random / sendPrivate / log / notifier / onQueueChanged / queueIO / lock
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { evaluateDelivery, drawDeliveryInterval } from './delivery-policy.mjs'
import {
  loadQueue, saveQueue, expireQueue, markStatus, queuePaths, QUEUE_STATUS,
} from './queue.mjs'
import { readDelivery, deliveredOn } from './ledger.mjs'
import { createFileLock } from './file-lock.mjs'
import { replaceSect } from './report-sect.mjs'
import { dayKey, seenDay } from './state.mjs'

/** 投递时钟自己的状态（跨 tick / 跨宿主共享） */
export const DELIVERY_CLOCK_FILE = 'delivery-clock.json'
/** 跨宿主的「挑队头 + 发送 + 回写」短锁 */
export const DELIVERY_CLOCK_LOCK_FILE = 'delivery-clock-lock.json'
/** 一次性投递账基线 */
export const BASELINE_FILE = 'delivery-baseline.json'
export const BASELINE_MARKER_FILE = '.mig-ledger-baseline'
/** 故障通知（一行一条 JSON） */
export const NOTIFICATIONS_FILE = 'notifications.jsonl'

/** 失败后固定 5 分钟再重试 */
export const RETRY_DELAY_MS = 5 * 60_000
/** 同类通知冷却 6 小时 */
export const NOTIFY_COOLDOWN_MS = 6 * 60 * 60_000
/** 连续失败到几次才说话（成功清零） */
export const DELIVERY_FAILURE_NOTIFY_THRESHOLD = 3
/** 投递时钟锁 TTL：一次发送超时 60 秒，5 分钟足够兜住卡住的宿主 */
export const DELIVERY_CLOCK_LOCK_TTL_MS = 5 * 60_000
/** 手动投递的短防连点（09 会复用 deliverNow） */
export const MANUAL_COOLDOWN_MS = 5_000

/** Date / epoch 毫秒 / ISO 字符串 → Date；认不出来 = null */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : new Date(ms)
  }
  return null
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 写 JSON 到文件（目录不在就建）；失败抛给调用方决定怎么兜 */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 本机时区的 `YYYY-MM-DD HH:MM`（日报/通知里给人看） */
function clockText(value) {
  const d = toDate(value)
  if (!d) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 一行化（通知 / 日志里不要换行） */
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/* ───────────────────────────── 通知 ───────────────────────────── */

const KIND_LABEL = {
  'collect-failed': '采集失败',
  'delivery-failed': '投递失败',
}

/**
 * 故障通知器。**所有写盘都包住**：通知写不进去也绝不能影响主流程。
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} [opts.outDir] 日报目录（默认 `<stateDir>/out`）
 * @param {object} [opts.cfg] 读 `notifyOnFailure` / `reportLevel`（传活对象，设置页改了立刻生效）
 * @param {() => Date|number|string} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.cooldownMs] 同类通知冷却（默认 6 小时）
 * @returns {{notify: Function, recent: Function, enabled: Function, file: string}}
 */
export function createNotifier({
  stateDir,
  outDir = join(stateDir, 'out'),
  cfg = {},
  now = () => new Date(),
  log = () => {},
  cooldownMs = NOTIFY_COOLDOWN_MS,
} = {}) {
  if (!stateDir) throw new TypeError('createNotifier 需要 stateDir')
  const file = join(stateDir, NOTIFICATIONS_FILE)

  const readAll = () => {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return [] }
    const out = []
    for (const line of String(text).split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      try {
        const rec = JSON.parse(s)
        if (rec && typeof rec === 'object' && !Array.isArray(rec) && rec.at && rec.kind) {
          out.push({ at: String(rec.at), kind: String(rec.kind), message: String(rec.message ?? '') })
        }
      } catch { /* 坏行跳过 */ }
    }
    return out
  }

  const enabled = () => cfg?.notifyOnFailure !== false

  /** 把今天的通知写进日报的 `## 通知` 一节（列表形状，replaceSect 原地替换） */
  const writeReportSection = (atDate) => {
    try {
      if (String(cfg?.reportLevel || 'full') === 'off') return
      const day = dayKey(atDate)
      const rows = readAll().filter((r) => {
        const d = toDate(r.at)
        return d && dayKey(d) === day
      })
      if (!rows.length) return
      const items = rows.slice(-20).map((r) =>
        '- ' + clockText(r.at) + ' · ' + (KIND_LABEL[r.kind] || r.kind) + ' · ' + oneLine(r.message))
      const block = ['## 通知', '', ...items].join('\n')
      const f = join(outDir, day + '.md')
      if (!existsSync(f)) {
        mkdirSync(outDir, { recursive: true })
        writeFileSync(f, '# 刷B站 · ' + day + '\n\n' + block + '\n', 'utf8')
        return
      }
      writeFileSync(f, replaceSect(readFileSync(f, 'utf8'), '## 通知', block), 'utf8')
    } catch (e) {
      log('写日报「通知」小节失败（不影响主流程）：' + String(e?.message ?? e))
    }
  }

  /**
   * 发一条通知。返回 `{ok, skipped?, record?}`；**从不抛**。
   * @param {{kind?: string, message?: string, at?: Date|number|string}} [input]
   */
  const notify = ({ kind = 'failure', message = '', at } = {}) => {
    if (!enabled()) return { ok: false, skipped: 'disabled' }
    try {
      const when = toDate(at) || toDate(now()) || new Date()
      const all = readAll()
      // 同类通知冷却：别刷屏（跨天也算，按 at 的绝对时间）
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].kind !== String(kind)) continue
        const prev = toDate(all[i].at)
        if (prev && when.getTime() - prev.getTime() < Math.max(0, Number(cooldownMs) || 0)) {
          return { ok: false, skipped: 'cooldown', last: all[i] }
        }
        break
      }
      const rec = { at: when.toISOString(), kind: String(kind), message: oneLine(message).slice(0, 2000) }
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
      log('通知（' + rec.kind + '）：' + rec.message)
      writeReportSection(when)
      return { ok: true, record: rec }
    } catch (e) {
      try { log('写通知失败（不影响主流程）：' + String(e?.message ?? e)) } catch { /* 连日志都写不了就算了 */ }
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /**
   * 最近几条通知（**新的在前**，给 `/status.notifications` / 设置页 10 用）。
   * @param {number} [limit]
   */
  const recent = (limit = 10) => {
    const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)))
    return readAll().slice(-n).reverse()
  }

  return { notify, recent, enabled, file }
}

/* ─────────────────────── 一次性投递账基线（迁移） ─────────────────────── */

/** 今天日报里 `### BV` 标题行的去重条数（围栏代码块里的不算，和旧 countPicks 同口径） */
function countReportPicks(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
    const ids = new Set()
    for (const m of text.matchAll(/^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm)) ids.add(m[1])
    return ids.size
  } catch { return 0 }
}

/** 判重表里今天标成「挑中 / 收下」的行数（解析口径与 index.js 的 parseSeenTable 一致） */
function countSeenPicks(file, day, nowDate) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return 0 }
  const seen = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    // 未转义的竖线才切（标题里的 `\|` 不算列分隔）
    const cells = line.split(/(?<!\\)\|/).map((s) => s.replace(/\\\|/g, '|').trim())
    const c = cells.slice(1, cells.length - 1)
    if (c.length < 3) continue
    const bvIdx = c.findIndex((x) => /^BV[0-9A-Za-z]{10}$/.test(x))
    if (bvIdx < 0) continue
    const d = seenDay(bvIdx > 0 ? c[bvIdx - 1] : c[0], nowDate)
    if (d !== day) continue
    const status = c[c.length - 1] || ''
    if (/跳过|跳了|没挑/.test(status)) continue
    if (!/挑|收|选|值得看|可以看/.test(status)) continue
    seen.add(c[bvIdx])
  }
  return seen.size
}

/**
 * 读 `delivery-baseline.json`（给 `/status` 用）。没有 / 写坏 ⇒ null。
 * @param {string} stateDir
 * @returns {{day: string, count: number, at: string, sources: object|null}|null}
 */
export function readBaseline(stateDir) {
  const raw = readJson(join(stateDir, BASELINE_FILE), null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const day = String(raw.day ?? '')
  if (!day) return null
  return {
    day,
    count: Math.max(0, Math.floor(Number(raw.count) || 0)),
    at: String(raw.at ?? ''),
    sources: raw.sources && typeof raw.sources === 'object' ? raw.sources : null,
  }
}

/**
 * 升级首日做一次基线（**只做一次**，标记文件在就不再重算）。
 * 旧来源三选最大：state.json 的 picked、今天日报的 `### BV` 行、判重表今天标成挑中的行。
 * 不做这一步 = 升级当天可能多发满一整轮（spec 里唯一会「静默放量」的坑）。
 */
function ensureBaseline({ stateDir, outDir, nowDate, dailyLimit, log }) {
  const marker = join(stateDir, BASELINE_MARKER_FILE)
  if (existsSync(marker)) return readBaseline(stateDir)

  const day = dayKey(nowDate)
  const st = readJson(join(stateDir, 'state.json'), {}) || {}
  const fromState = st?.day === day ? Math.max(0, Math.floor(Number(st.picked) || 0)) : 0
  const fromReport = countReportPicks(join(outDir, day + '.md'))
  const fromSeen = countSeenPicks(join(stateDir, 'seen.md'), day, nowDate)
  const count = Math.max(fromState, fromReport, fromSeen)
  const record = {
    day,
    count,
    at: nowDate.toISOString(),
    sources: { state: fromState, report: fromReport, seen: fromSeen },
  }
  try {
    mkdirSync(stateDir, { recursive: true })
    writeJson(join(stateDir, BASELINE_FILE), record)
    writeFileSync(marker, JSON.stringify({ at: record.at, day, count }) + '\n', 'utf8')
    log('投递账基线（只记一次）：升级前今天已挑/发 ' + count + ' 条'
      + '（state.json ' + fromState + ' · 日报 ' + fromReport + ' · 判重表 ' + fromSeen + '）'
      + ' ⇒ 今天最多再自动投递 ' + Math.max(0, dailyLimit - count) + ' 条')
  } catch (e) {
    // 基线写不进去：这一次仍按算出来的数用（宁可少发几条），标记没写成下次再试
    log('⚠️ 投递账基线写不进去（这一次仍按基线算，下次启动再试）：' + String(e?.message ?? e))
  }
  return record
}

/* ───────────────────────────── 投递时钟 ───────────────────────────── */

/** 配置里的数字 / 时间，读的时候再钳一遍（原生设置页那边钳不到写） */
function limitsOf(cfg = {}) {
  const int = (v, dflt, min, max) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
  }
  const minGap = int(cfg.deliverMinGapMin, 45, 0, 1440)
  return {
    perDay: int(cfg.deliverPerDay, 5, 0, 50),
    minGap,
    maxGap: Math.max(minGap, int(cfg.deliverMaxGapMin, 120, 0, 1440)),
    retries: int(cfg.deliverRetries, 1, 0, 3),
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
  }
}

/** 投递时钟的持久状态（lastDelivery 里的 intervalMs 一定要留住） */
function readClockState(stateDir) {
  const raw = readJson(join(stateDir, DELIVERY_CLOCK_FILE), {}) || {}
  const at = toDate(raw?.lastDelivery?.at)
  const interval = Number(raw?.lastDelivery?.intervalMs)
  return {
    lastDelivery: at
      ? { at: at.toISOString(), ...(Number.isFinite(interval) && interval >= 0 ? { intervalMs: interval } : {}) }
      : null,
    consecutiveFailures: Math.max(0, Math.floor(Number(raw.consecutiveFailures) || 0)),
    failDay: String(raw.failDay ?? ''),
    lastFailure: String(raw.lastFailure ?? ''),
  }
}

function saveClockState(stateDir, state, log) {
  try {
    writeJson(join(stateDir, DELIVERY_CLOCK_FILE), {
      v: 1,
      lastDelivery: state.lastDelivery,
      consecutiveFailures: state.consecutiveFailures,
      failDay: state.failDay,
      lastFailure: state.lastFailure,
    })
  } catch (e) {
    log('写投递时钟状态失败（这一次照发）：' + String(e?.message ?? e))
  }
}

/**
 * 一条候选最终发出去的正文：草稿 + BV 链接（一条私信 = 一条视频 + 一条链接）。
 * 草稿里已经有这个 BV、**而且已经有链接**，才原样用；否则补上链接。
 */
function deliveryTextOf(entry) {
  const bvid = String(entry?.bvid ?? '')
  const draft = String(entry?.draft ?? '').trim()
  const link = 'https://www.bilibili.com/video/' + bvid
  if (draft && draft.includes(bvid) && /https?:\/\//i.test(draft)) return draft
  if (draft) return draft + '\n\n' + link
  const title = oneLine(entry?.title)
  return (title ? title + '\n\n' : '') + link
}

/**
 * 建一个投递时钟。`tick()` 一跳；`deliverNow()` 是给 09「现在投递」用的发送入口（不是模型工具）。
 *
 * @param {object} opts
 * @param {string} opts.stateDir 插件家目录
 * @param {string} [opts.outDir] 日报目录（默认 `<stateDir>/out`）
 * @param {object} [opts.cfg] **活对象**：每跳读最新值（index.js 用 refreshCfg 就地改它）
 * @param {() => Date|number|string} [opts.now] 注入的时钟
 * @param {() => number} [opts.random] 注入的随机源
 * @param {(input: object) => Promise<object>} opts.sendPrivate 宿主发送通道（lib/send.mjs）
 * @param {(msg: string) => void} [opts.log]
 * @param {object} [opts.notifier] createNotifier 的返回；缺省自己建一个
 * @param {(queue: object, at: Date) => void} [opts.onQueueChanged] 队列落盘后刷新日报「队列」节
 * @param {object} [opts.queueIO] 传给 lib/queue.mjs 的 IO（测试用）
 * @param {object} [opts.lock] 跨宿主短锁（createFileLock 的返回；测试可注入）
 * @returns {{tick: Function, deliverNow: Function, notifier: object, lock: object}}
 */
export function createDeliveryClock({
  stateDir,
  outDir = join(stateDir, 'out'),
  cfg = {},
  now = () => new Date(),
  random = Math.random,
  sendPrivate,
  log = () => {},
  notifier = null,
  onQueueChanged = null,
  queueIO = {},
  lock = null,
} = {}) {
  if (!stateDir) throw new TypeError('createDeliveryClock 需要 stateDir')
  if (typeof sendPrivate !== 'function') throw new TypeError('createDeliveryClock 需要注入 sendPrivate()')

  const note = notifier || createNotifier({ stateDir, outDir, cfg, now, log })
  const clockLock = lock || createFileLock({
    file: join(stateDir, DELIVERY_CLOCK_LOCK_FILE),
    ttlMs: DELIVERY_CLOCK_LOCK_TTL_MS,
    log,
  })
  let lastManualAt = 0

  const nowDateOf = () => {
    const v = typeof now === 'function' ? now() : now
    return toDate(v)
  }

  /** 通知失败计数 + 到阈值就说一句（失败本身绝不能影响发送） */
  const bumpFailuresAndMaybeNotify = (state, atDate, reason, bvid) => {
    const today = dayKey(atDate)
    if (state.failDay !== today) { state.failDay = today; state.consecutiveFailures = 0 }
    state.consecutiveFailures += 1
    state.lastFailure = oneLine(reason)
    saveClockState(stateDir, state, log)
    if (state.consecutiveFailures >= DELIVERY_FAILURE_NOTIFY_THRESHOLD) {
      try {
        note.notify({
          kind: 'delivery-failed',
          at: atDate,
          message: '投递连续失败 ' + state.consecutiveFailures + ' 次：最近一次是 ' + oneLine(reason)
            + '（' + bvid + '）。检查网络、B站 登录状态和收件人设置。',
        })
      } catch (e) {
        log('投递失败通知没发出去（不影响主流程）：' + String(e?.message ?? e))
      }
    }
  }

  /**
   * 处理一次发送的结果（自动 / 手动共用）。返回结构化结果。
   * @param {object} ctx 本次 tick 的上下文（queue/state/policy 等）
   */
  const handleSendResult = (ctx, entry, result, { manual }) => {
    const { atDate, policy, state } = ctx
    const status = String(result?.status || (result?.ok ? 'sent' : '') || 'error')
    const busy = result?.busy === true || status === 'busy'
    if (busy) {
      // 另一个宿主正在发：这一跳跳过 —— **不落账、不占重试次数**，条目保持 pending
      log('投递跳过一次（' + entry.bvid + '）：另一个宿主正在发送（busy）⇒ 下一跳再看')
      return {
        ok: true, sent: false, busy: true, reason: 'busy',
        entry: { id: entry.id, bvid: entry.bvid }, manual,
      }
    }

    const msgKey = String(result?.msgKey || result?.record?.msgKey || '')
    if (status === 'sent' && msgKey) {
      const marked = markStatus(ctx.queue, entry.id, QUEUE_STATUS.sent, { retryAt: '' })
      if (marked.entry) ctx.queue = marked.queue
      ctx.persistQueue()
      const nextIntervalMs = drawDeliveryInterval(policy, random)
      state.lastDelivery = { at: atDate.toISOString(), intervalMs: nextIntervalMs }
      state.consecutiveFailures = 0
      state.failDay = dayKey(atDate)
      state.lastFailure = ''
      saveClockState(stateDir, state, log)
      const deliveredNow = Math.max(
        deliveredOn(readDelivery(stateDir), { day: dayKey(atDate) }),
        ctx.baselineToday,
      )
      log('投递成功：' + entry.bvid + (manual ? '（手动投递，不占当日额度）' : '')
        + ' · 今天已投递 ' + deliveredNow + ' / ' + ctx.limits.perDay + ' 条')
      return {
        ok: true, sent: true, reason: 'sent', manual, status: 'sent', msgKey,
        entry: { id: entry.id, bvid: entry.bvid },
        intervalMs: nextIntervalMs,
        deliveredToday: deliveredNow,
        dailyLimit: ctx.limits.perDay,
      }
    }

    // 失败形态：failed / no-receipt / error / blocked
    let failureStatus = status
    if (!failureStatus || failureStatus === 'sent') failureStatus = 'no-receipt'
    const reason = oneLine(result?.reason || result?.record?.message || result?.message
      || ('投递没有成功（' + failureStatus + '）'))
    const attempts = Math.max(0, Math.floor(Number(entry.attempts) || 0)) + 1
    // 「blocked」= 正文没过机械检查，重试也不会好 ⇒ 直接 failed，不占重试机会
    const giveUp = failureStatus === 'blocked' || attempts >= policy.maxAttempts
    const retryAt = giveUp ? '' : new Date(atDate.getTime() + RETRY_DELAY_MS).toISOString()
    const marked = markStatus(ctx.queue, entry.id, giveUp ? QUEUE_STATUS.failed : QUEUE_STATUS.pending, {
      attempts,
      lastError: reason,
      retryAt,
    })
    if (marked.entry) ctx.queue = marked.queue
    ctx.persistQueue()
    bumpFailuresAndMaybeNotify(state, atDate, reason, entry.bvid)
    log('投递' + (giveUp ? '放弃' : '失败') + '：' + entry.bvid + '（' + failureStatus + '，第 '
      + attempts + '/' + policy.maxAttempts + ' 次）—— ' + reason
      + (giveUp ? ' ⇒ 标为失败，继续下一条' : ' ⇒ 5 分钟后重试一次'))
    return {
      ok: false, sent: false, reason: giveUp ? 'sent-failed' : 'retry-scheduled',
      manual, status: failureStatus, attempts, retryAt: retryAt || null,
      entry: { id: entry.id, bvid: entry.bvid }, error: reason,
    }
  }

  /**
   * 一跳：读配置 → 队列 + 账本 → 过期落盘 → 基线 → 策略判断 → 发送 → 回写。
   * **从不抛**（定时器回调里抛异常会杀宿主）。返回结构化结果，供 /status 或测试看。
   */
  async function tick() {
    const out = { ok: false, at: '', reason: '', sent: false, entry: null }
    try {
      const atDate = nowDateOf()
      if (!atDate) return { ...out, reason: 'bad-now', error: 'now 不是合法时间' }
      out.at = atDate.toISOString()

      // ① 配置闸：私信关着 / 没有收件人 ⇒ 不投递（不读队列、不写文件）
      if (cfg?.channelDm !== true) return { ...out, ok: true, reason: 'dm-off' }
      const uid = Math.floor(Number(cfg?.dmUid) || 0)
      if (uid <= 0) return { ...out, ok: true, reason: 'no-recipient' }
      const limits = limitsOf(cfg)

      // ② 跨宿主短锁：拿不到就这一跳让开（不落账、不改队列）
      let got = null
      try { got = clockLock.acquire() } catch (e) {
        log('投递时钟锁出错（这一跳照走）：' + String(e?.message ?? e))
        got = { ok: true, unsafe: true }
      }
      if (got && got.ok === false && got.busy) {
        return { ...out, ok: true, reason: 'locked', busy: true }
      }
      if (got?.unsafe) log('投递时钟锁没写成，这一跳照发（可能重复一次）')

      try {
        return await runLocked(atDate, uid, limits, out)
      } finally {
        try { clockLock.release() } catch (e) { log('放投递时钟锁失败（靠 TTL 过期）：' + String(e?.message ?? e)) }
      }
    } catch (e) {
      log('投递时钟这一跳出错（已兜住，不影响宿主）：' + String(e?.stack ?? e))
      return { ...out, ok: false, error: String(e?.message ?? e) }
    }
  }

  async function runLocked(atDate, uid, limits, out) {
    const today = dayKey(atDate)

    // ③ 队列 + 过期（过期作废**不通知**）
    const loaded = loadQueue(stateDir, queueIO)
    const before = JSON.stringify(loaded.entries)
    const exp = expireQueue(loaded, { now: atDate })
    // ⚠️ 所有改队列的地方都改 ctx.queue（persistQueue 存的就是它）——
    //    别用局部 `queue = ...`：那样 saveQueue 存回去的还是旧的。
    const ctx = { queue: exp.queue, atDate, policy: null, state: null, baselineToday: 0, limits, persistQueue: null }
    let queueDirty = JSON.stringify(ctx.queue.entries) !== before
    if (exp.expired.length) {
      log('队列过期作废：' + exp.expired.map((e) => e.bvid).join('、') + '（不通知）')
    }

    const persistQueue = () => {
      try { saveQueue(stateDir, ctx.queue, queueIO) } catch (e) {
        log('写队列失败（这一跳的结果仍继续）：' + String(e?.message ?? e))
        return
      }
      queueDirty = false
      try { onQueueChanged?.(ctx.queue, atDate) } catch (e) {
        log('刷新日报「队列」小节失败（不影响投递）：' + String(e?.message ?? e))
      }
    }
    ctx.persistQueue = persistQueue
    if (queueDirty) persistQueue()

    // ④ 一次性基线：升级首日「今天已经挑/发了几条」从旧来源取最大
    const baseline = ensureBaseline({
      stateDir, outDir, nowDate: atDate, dailyLimit: limits.perDay, log,
    })
    const baselineToday = baseline && baseline.day === today ? Math.max(0, Number(baseline.count) || 0) : 0
    ctx.baselineToday = baselineToday

    const clockState = readClockState(stateDir)
    const ledger = readDelivery(stateDir)
    ctx.state = clockState

    if (limits.perDay === 0) {
      return {
        ...out, ok: true, reason: 'disabled',
        deliveredToday: Math.max(deliveredOn(ledger, { day: today }), baselineToday),
        baselineToday, dailyLimit: limits.perDay,
      }
    }

    // ⑤ 策略判断（唯一判断源）：基线只影响「今天还能发几条」
    const effectiveLimit = Math.max(0, limits.perDay - baselineToday)
    const policy = {
      dailyLimit: effectiveLimit,
      minIntervalMin: limits.minGap,
      maxIntervalMin: limits.maxGap,
      quietStart: limits.quietStart,
      quietEnd: limits.quietEnd,
      maxAttempts: limits.retries + 1,
    }
    ctx.policy = policy
    const ev = evaluateDelivery({
      now: atDate,
      policy,
      queue: ctx.queue.entries,
      ledger,
      lastDelivery: clockState.lastDelivery,
      random,
    })

    // ⑥ 抽到的间隔立刻存回去：要么这一跳用掉它，要么留给下一跳 —— **抽一次、存一次**
    if (clockState.lastDelivery && clockState.lastDelivery.intervalMs === undefined
      && Number.isFinite(ev.intervalMs)) {
      clockState.lastDelivery = { at: clockState.lastDelivery.at, intervalMs: ev.intervalMs }
      saveClockState(stateDir, clockState, log)
    }

    // ⑦ 试满次数、却还挂在 pending 上的条目（崩在中间）⇒ 收成 failed，别堵队
    let finalized = 0
    for (const e of ev.failed) {
      const marked = markStatus(ctx.queue, e.id, QUEUE_STATUS.failed, {
        attempts: e.attempts,
        lastError: e.lastError || '重试次数已用尽',
        retryAt: '',
      })
      if (marked.entry) { ctx.queue = marked.queue; queueDirty = true; finalized++ }
    }
    if (finalized) {
      persistQueue()
      log('投递：' + finalized + ' 条已试满次数 ⇒ 标为失败（不通知）')
    }

    // 防御：策略说这批过期了（正常已被 expireQueue 转过），仍然写回
    if (ev.expired.length) {
      for (const e of ev.expired) {
        const marked = markStatus(ctx.queue, e.id, QUEUE_STATUS.expired, { retryAt: '' })
        if (marked.entry) { ctx.queue = marked.queue; queueDirty = true }
      }
      persistQueue()
    }

    const ledgerToday = deliveredOn(ledger, { day: today })
    const deliveredTotal = Math.max(ledgerToday, baselineToday)
    const base = {
      ...out, deliveredToday: deliveredTotal, baselineToday, dailyLimit: limits.perDay,
      intervalMs: ev.intervalMs, policyReason: ev.reason,
    }

    if (!ev.send) {
      return { ...base, ok: true, reason: ev.reason }
    }

    const next = ev.next
    if (!next) return { ...base, ok: true, reason: 'queue-empty' }

    // ⑧ 退避：失败后 5 分钟内不重试（条目仍是 pending，只是还没到点）
    const retryAt = toDate(next.retryAt)
    if (retryAt && retryAt.getTime() > atDate.getTime()) {
      return {
        ...base, ok: true, reason: 'retry-backoff',
        entry: { id: next.id, bvid: next.bvid }, retryAt: retryAt.toISOString(),
      }
    }

    // ⑨ 账本二次校验：同一 BV 已有回执（另一个宿主刚发过）⇒ 只把队列改成 sent，不重发
    // 同一 BV 只要有回执（manual 也算）就不再发 —— 「两个宿主各发一遍」的最后一道闸
    const receipt = readDelivery(stateDir).find((r) => String(r.bvid) === next.bvid && r.msgKey)
    if (receipt) {
      const marked = markStatus(ctx.queue, next.id, QUEUE_STATUS.sent, { retryAt: '' })
      if (marked.entry) { ctx.queue = marked.queue; queueDirty = true }
      persistQueue()
      const receiptAt = toDate(receipt.at)
      if (receiptAt && (!clockState.lastDelivery || receiptAt.getTime() > Date.parse(clockState.lastDelivery.at))) {
        clockState.lastDelivery = {
          at: receiptAt.toISOString(),
          intervalMs: drawDeliveryInterval(policy, random),
        }
        saveClockState(stateDir, clockState, log)
      }
      log('投递跳过 ' + next.bvid + '：投递账里已有回执 ⇒ 不重复发')
      return { ...base, ok: true, sent: false, reason: 'already-delivered', entry: { id: next.id, bvid: next.bvid } }
    }

    // ⑩ 真正发送
    let result
    try {
      result = await sendPrivate({
        receiverUid: uid,
        text: deliveryTextOf(next),
        bvid: next.bvid,
        manual: false,
        id: next.id,
      })
    } catch (e) {
      result = { ok: false, status: 'error', reason: String(e?.message ?? e) }
    }
    return handleSendResult(ctx, next, result, { manual: false })
  }

  /**
   * 「现在投递」：立刻发队头一条，**无视间隔、免打扰与每日上限，不占当日额度**（GLOSSARY「手动投递」）。
   * 09 的按钮直接复用它（不是模型工具）。队列空时明确告知；带短防连点。
   *
   * @param {{cooldownMs?: number}} [opts]
   */
  async function deliverNow({ cooldownMs = MANUAL_COOLDOWN_MS } = {}) {
    const out = { ok: false, at: '', sent: false, manual: true, reason: '', entry: null }
    try {
      const atDate = nowDateOf()
      if (!atDate) return { ...out, reason: 'bad-now', error: 'now 不是合法时间' }
      out.at = atDate.toISOString()
      const waitMs = Math.max(0, Number(cooldownMs) || 0)
      if (lastManualAt && atDate.getTime() - lastManualAt < waitMs) {
        return { ...out, reason: 'cooldown', waitMs: Math.max(0, waitMs - (atDate.getTime() - lastManualAt)) }
      }
      if (cfg?.channelDm !== true) return { ...out, reason: 'dm-off', message: '私信关着 —— 不投递' }
      const uid = Math.floor(Number(cfg?.dmUid) || 0)
      if (uid <= 0) return { ...out, reason: 'no-recipient', message: '还没有收件人（填「私信发给谁」的 UID）' }
      lastManualAt = atDate.getTime()

      let got = null
      try { got = clockLock.acquire() } catch { got = { ok: true, unsafe: true } }
      if (got && got.ok === false && got.busy) {
        return { ...out, reason: 'locked', busy: true, message: '另一个宿主正在投递，等下一跳' }
      }
      try {
        const lim = limitsOf(cfg)
        const loaded = loadQueue(stateDir, queueIO)
        const exp = expireQueue(loaded, { now: atDate })
        const ctx = {
          queue: exp.queue, atDate, policy: null, state: null,
          baselineToday: 0, limits: lim, persistQueue: null,
        }
        let queueDirty = exp.expired.length > 0
          || JSON.stringify(ctx.queue.entries) !== JSON.stringify(loaded.entries)
        const persistQueue = () => {
          try { saveQueue(stateDir, ctx.queue, queueIO) } catch (e) {
            log('写队列失败（手动投递继续）：' + String(e?.message ?? e))
            return
          }
          queueDirty = false
          try { onQueueChanged?.(ctx.queue, atDate) } catch { /* 刷新失败不影响发送 */ }
        }
        ctx.persistQueue = persistQueue
        if (queueDirty) persistQueue()

        const next = ctx.queue.entries.find((e) => e.status === QUEUE_STATUS.pending)
        if (!next) {
          return { ...out, ok: false, reason: 'queue-empty', message: '队列里没有待投递的候选（等下一轮采集）' }
        }
        // 同一 BV 只要有回执（manual 也算）就不再发 —— 「两个宿主各发一遍」的最后一道闸
        const receipt = readDelivery(stateDir).find((r) => String(r.bvid) === next.bvid && r.msgKey)
        if (receipt) {
          const marked = markStatus(ctx.queue, next.id, QUEUE_STATUS.sent, { retryAt: '' })
          if (marked.entry) { ctx.queue = marked.queue; queueDirty = true }
          persistQueue()
          return { ...out, ok: true, reason: 'already-delivered', entry: { id: next.id, bvid: next.bvid } }
        }

        const policy = {
          dailyLimit: Infinity,
          minIntervalMin: 0,
          maxIntervalMin: 0,
          maxAttempts: lim.retries + 1,
        }
        ctx.policy = policy
        ctx.state = readClockState(stateDir)
        let result
        try {
          result = await sendPrivate({
            receiverUid: uid,
            text: deliveryTextOf(next),
            bvid: next.bvid,
            manual: true,
            id: next.id,
          })
        } catch (e) {
          result = { ok: false, status: 'error', reason: String(e?.message ?? e) }
        }
        return handleSendResult(ctx, next, result, { manual: true })
      } finally {
        try { clockLock.release() } catch { /* 靠 TTL 兜底 */ }
      }
    } catch (e) {
      log('手动投递出错（已兜住）：' + String(e?.stack ?? e))
      return { ...out, ok: false, error: String(e?.message ?? e) }
    }
  }

  return { tick, deliverNow, notifier: note, lock: clockLock }
}

/** 给测试 / 排障看的路径集合 */
export function deliveryClockPaths(stateDir) {
  return {
    state: join(stateDir, DELIVERY_CLOCK_FILE),
    lock: join(stateDir, DELIVERY_CLOCK_LOCK_FILE),
    baseline: join(stateDir, BASELINE_FILE),
    marker: join(stateDir, BASELINE_MARKER_FILE),
    notifications: join(stateDir, NOTIFICATIONS_FILE),
    queue: queuePaths(stateDir).file,
  }
}

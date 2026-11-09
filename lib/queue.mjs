/**
 * lib/queue.mjs —— 有界候选队列（存储 + 状态迁移）
 * ============================================================================
 * 工单 06（`.scratch/collect-deliver/issues/06-queue-and-collection-rewrite.md`）：
 *   采集轮**不再发送**任何东西 —— 它只把候选（每条带一段用人设写好的草稿）交给宿主，
 *   宿主排干「收件箱」、校验、入队；投递由 07 的时钟从队列里取（GLOSSARY「队列」「投递」）。
 *
 * 三个文件（都在插件自己的家里 `<stateDir>/`，绝不写进插件包目录）：
 *
 *   queue.json         队列本体：`{ v: 1, entries: [ { id, bvid, title, up, draft,
 *                      collectedAt, expiresAt, status, attempts, lastError } ] }`
 *                      写入一律**原子**（同目录临时文件 + rename）—— 崩在写一半时旧文件还在。
 *   queue-inbox.jsonl  收件箱：采集轮用窄口工具 `duty_candidate_append` 一行一条追加，
 *                      宿主这一轮结束后 `drainInbox` 读、`clearInbox` 删（**先入队成功再删**）。
 *   queue-dropped.jsonl 被丢下的候选（队列满 / 重复 / 格式不对）—— 「不可见地丢掉」是不允许的。
 *
 * 规则（这一版定死，07/09 直接用）：
 *   · `id = 天 + ':' + BV`（和 `lib/ledger.mjs` 的 id 同形，方便对账）；
 *   · **同一个 BV 不会重复入队**（不管旧那条是什么状态：已投递 / 已过期都算见过）；
 *   · 上限只数 `pending`；满了以后再来的候选**不入队**，进 `dropped`（调用方负责留记录）；
 *   · 保质期从 `collectedAt` 起算；到期那一刻就算过期；过期**不通知**（spec「通知」）；
 *   · 已结束的条目（sent / expired / failed）留 7 天供判重，之后自动清掉 —— 文件不会无限长。
 *
 * IO 与时钟都可注入（测试用）：`{ readFile, writeFile, rename, remove, append, exists, mkdir }`
 * 与 `now`（Date | epoch 毫秒）。**本模块不自己取系统时间**：要 `now` 的函数缺了就抛 TypeError
 * （和 `lib/delivery-policy.mjs` 同一套规矩）。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './state.mjs'

/** 队列本体 / 收件箱 / 丢弃记录的文件名（都在 stateDir 下） */
export const QUEUE_FILE = 'queue.json'
export const INBOX_FILE = 'queue-inbox.jsonl'
export const DROPPED_FILE = 'queue-dropped.jsonl'

/**
 * 三个可配数字的**唯一**范围（设置页、HTTP、工具、读配置都按它钳 —— 别再各抄一份）。
 *   queueLimit     队列上限（条）
 *   queueTtlHours  保质期（小时）
 *   collectBatch   采集轮一次最多采几条（提示词里的那个数）
 */
export const QUEUE_LIMIT = Object.freeze({ default: 3, min: 1, max: 20 })
export const QUEUE_TTL_HOURS = Object.freeze({ default: 24, min: 1, max: 168 })
export const COLLECT_BATCH = Object.freeze({ default: 3, min: 1, max: 10 })

/** 条目状态（GLOSSARY：待投递 → 已投递 / 作废 / 失败） */
export const QUEUE_STATUS = Object.freeze({
  pending: 'pending',
  sent: 'sent',
  expired: 'expired',
  failed: 'failed',
})

const STATUSES = new Set(Object.values(QUEUE_STATUS))

/** BV 号：仓库里到处按 `BV + 10 位字母数字` 认（report / verify / ledger 同口径） */
export const BVID_RE = /^BV[0-9A-Za-z]{10}$/

/** 已结束的条目留多久供判重（天）；0 = 永久保留 */
export const KEEP_FINISHED_DAYS = 7

/** 把 Date / epoch 毫秒 / ISO 字符串收成 Date；认不出来 = null */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : new Date(ms)
  }
  return null
}

function requireNow(now, who) {
  const d = toDate(now)
  if (!d) throw new TypeError(who + ' 需要注入 now（Date 或 epoch 毫秒）—— 本模块不自己取系统时间')
  return d
}

/** 把配置里可能出现的不合法值收成能用的形状（和 clampPatch 同一把尺子） */
function clampCount(v, spec) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return spec.default
  return Math.min(spec.max, Math.max(spec.min, n))
}

const defaultIO = {
  readFile: (f) => readFileSync(f, 'utf8'),
  writeFile: (f, s) => writeFileSync(f, s, 'utf8'),
  rename: (a, b) => renameSync(a, b),
  remove: (f) => rmSync(f, { force: true }),
  append: (f, s) => appendFileSync(f, s, 'utf8'),
  exists: (f) => existsSync(f),
  mkdir: (d) => mkdirSync(d, { recursive: true }),
}

/** 注入的 IO 缺哪项补哪项（别用展开：传进来的 undefined 会把默认实现盖掉） */
function ioOf(io = {}) {
  return {
    readFile: io.readFile ?? defaultIO.readFile,
    writeFile: io.writeFile ?? defaultIO.writeFile,
    rename: io.rename ?? defaultIO.rename,
    remove: io.remove ?? defaultIO.remove,
    append: io.append ?? defaultIO.append,
    exists: io.exists ?? defaultIO.exists,
    mkdir: io.mkdir ?? defaultIO.mkdir,
  }
}

/** 三个文件的路径 */
export function queuePaths(stateDir) {
  return {
    dir: stateDir,
    file: join(stateDir, QUEUE_FILE),
    inbox: join(stateDir, INBOX_FILE),
    dropped: join(stateDir, DROPPED_FILE),
  }
}

/**
 * 一条条目收成能用的形状（坏条目返回 null —— 由调用方跳过）。
 * 时间字段统一成 ISO（UTC），渲染时再按本机时区折算。
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bvid = String(raw.bvid ?? '').trim()
  if (!BVID_RE.test(bvid)) return null
  const collectedAt = toDate(raw.collectedAt)
  const expiresAt = toDate(raw.expiresAt)
  const status = STATUSES.has(String(raw.status)) ? String(raw.status) : QUEUE_STATUS.pending
  const id = String(raw.id ?? '').trim()
    || (collectedAt ? dayKey(collectedAt) + ':' + bvid : bvid)
  return {
    id,
    bvid,
    title: String(raw.title ?? '').trim(),
    up: String(raw.up ?? '').trim(),
    draft: String(raw.draft ?? ''),
    collectedAt: collectedAt ? collectedAt.toISOString() : '',
    expiresAt: expiresAt ? expiresAt.toISOString() : '',
    status,
    attempts: Math.max(0, Math.floor(Number(raw.attempts) || 0)),
    lastError: String(raw.lastError ?? ''),
  }
}

/** 读出来的条目集合（去重：同一个 BV 只留第一条） */
function normalizeEntries(list) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const e = normalizeEntry(raw)
    if (!e || seen.has(e.bvid)) continue
    seen.add(e.bvid)
    out.push(e)
  }
  return out
}

/** 空队列 */
export function emptyQueue() {
  return { v: 1, entries: [] }
}

/**
 * 读队列。**从不抛**：文件不在 / 写坏了 / 形状不对 ⇒ 空队列。
 * 也认「老版本直接存成数组」的形状（以后要是有人手改，别把整个队列读没了）。
 *
 * @param {string} stateDir
 * @param {object} [io]
 * @returns {{v: number, entries: object[]}}
 */
export function loadQueue(stateDir, io = {}) {
  const fsIO = ioOf(io)
  const file = queuePaths(stateDir).file
  let raw = null
  try {
    const text = fsIO.readFile(file)
    raw = text ? JSON.parse(text) : null
  } catch { raw = null }
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : [])
  return { v: 1, entries: normalizeEntries(list) }
}

/**
 * 原子写队列：同目录临时文件 → rename。
 * 写失败会把临时文件清掉并把异常抛出去（宿主决定怎么兜 —— 绝不能假装写成功）。
 *
 * @param {string} stateDir
 * @param {{entries?: object[]}|object[]} queue
 * @param {object} [io]
 * @returns {{v: number, entries: object[]}} 真正落盘的那份
 */
export function saveQueue(stateDir, queue, io = {}) {
  const fsIO = ioOf(io)
  const p = queuePaths(stateDir)
  const data = { v: 1, entries: normalizeEntries(Array.isArray(queue) ? queue : queue?.entries) }
  const text = JSON.stringify(data, null, 2) + '\n'
  const tmp = p.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    fsIO.mkdir(stateDir)
    fsIO.writeFile(tmp, text)
    fsIO.rename(tmp, p.file)
  } catch (e) {
    try { fsIO.remove(tmp) } catch { /* 临时文件清不掉也算了 */ }
    throw e
  }
  return data
}

/**
 * 把候选入队（**纯计算 + 返回新队列**，不写盘）。
 *
 * @param {{entries?: object[]}} queue 现队列
 * @param {Array<{bvid:string,title?:string,up?:string,draft?:string}>} candidates 候选（收件箱排干后的）
 * @param {{limit?: number, ttlHours?: number, now: Date|number}} opts
 * @returns {{
 *   queue: {v:number, entries: object[]},
 *   added: object[],                 // 真进了队列的
 *   dropped: object[],               // 队列满 ⇒ 没进（带 reason: 'queue-full'）
 *   skipped: object[],               // 重复 / BV 不合法 ⇒ 本来就不该进（带 reason）
 * }}
 */
export function enqueue(queue, candidates, { limit, ttlHours, now } = {}) {
  const nowDate = requireNow(now, 'enqueue')
  const cap = clampCount(limit, QUEUE_LIMIT)
  const ttl = clampCount(ttlHours, QUEUE_TTL_HOURS)
  const base = { v: 1, entries: normalizeEntries(queue?.entries) }
  const seen = new Set(base.entries.map((e) => e.bvid))
  let pending = base.entries.filter((e) => e.status === QUEUE_STATUS.pending).length
  const added = []
  const dropped = []
  const skipped = []

  for (const c of Array.isArray(candidates) ? candidates : []) {
    const bvid = String(c?.bvid ?? '').trim()
    const title = String(c?.title ?? '').trim()
    const up = String(c?.up ?? '').trim()
    const draft = String(c?.draft ?? '').trim()
    if (!BVID_RE.test(bvid)) { skipped.push({ bvid, title, up, draft, reason: 'bad-bvid' }); continue }
    if (seen.has(bvid)) { skipped.push({ bvid, title, up, draft, reason: 'duplicate' }); continue }
    if (pending >= cap) { dropped.push({ bvid, title, up, draft, reason: 'queue-full' }); continue }
    const entry = {
      id: dayKey(nowDate) + ':' + bvid,
      bvid,
      title,
      up,
      draft,
      collectedAt: nowDate.toISOString(),
      expiresAt: new Date(nowDate.getTime() + ttl * 3600_000).toISOString(),
      status: QUEUE_STATUS.pending,
      attempts: 0,
      lastError: '',
    }
    base.entries.push(entry)
    seen.add(bvid)
    pending++
    added.push(entry)
  }

  return { queue: base, added, dropped, skipped }
}

/**
 * 过一遍保质期（纯计算 + 返回新队列）：
 *   · pending 且已到期 ⇒ 状态转 `expired`（**不通知**），放进返回的 `expired`；
 *   · 已结束的条目超过 `keepDays` ⇒ 从队列里清掉（只影响文件长度，不影响判重表的账）。
 *
 * @param {{entries?: object[]}} queue
 * @param {{now: Date|number, keepDays?: number}} opts
 * @returns {{queue: {v:number, entries: object[]}, expired: object[]}}
 */
export function expireQueue(queue, { now, keepDays = KEEP_FINISHED_DAYS } = {}) {
  const nowDate = requireNow(now, 'expireQueue')
  const nowMs = nowDate.getTime()
  const keepMs = Math.max(0, Number(keepDays) || 0) * 86_400_000
  const entries = []
  const expired = []
  for (const e of normalizeEntries(queue?.entries)) {
    if (e.status === QUEUE_STATUS.pending) {
      const exp = toDate(e.expiresAt)
      if (exp && nowMs >= exp.getTime()) {
        const dead = { ...e, status: QUEUE_STATUS.expired }
        expired.push(dead)
        entries.push(dead)
        continue
      }
      entries.push(e)
      continue
    }
    const born = toDate(e.collectedAt)
    if (keepMs > 0 && born && nowMs - born.getTime() > keepMs) continue
    entries.push(e)
  }
  return { queue: { v: 1, entries }, expired }
}

/**
 * 改一条的状态（纯计算；07 投递成功 / 失败时用）。
 *
 * @param {{entries?: object[]}} queue
 * @param {string} idOrBvid 幂等键（`天:BV`）或 BV 号
 * @param {'pending'|'sent'|'expired'|'failed'} status
 * @param {{attempts?: number, lastError?: string}} [patch]
 * @returns {{queue: {v:number, entries: object[]}, entry: object|null}} 找不到时 entry 为 null、队列原样
 */
export function markStatus(queue, idOrBvid, status, patch = {}) {
  const want = String(status ?? '')
  if (!STATUSES.has(want)) throw new TypeError('markStatus: 不认识的状态 ' + JSON.stringify(status))
  const key = String(idOrBvid ?? '')
  const pat = {}
  if ('attempts' in patch) pat.attempts = Math.max(0, Math.floor(Number(patch.attempts) || 0))
  if ('lastError' in patch) pat.lastError = String(patch.lastError ?? '')
  let hit = null
  const entries = []
  for (const e of normalizeEntries(queue?.entries)) {
    if (!hit && (e.id === key || e.bvid === key)) {
      hit = { ...e, ...pat, status: want }
      entries.push(hit)
      continue
    }
    entries.push(e)
  }
  return { queue: { v: 1, entries }, entry: hit }
}

/**
 * 读干收件箱（**不删文件** —— 调用方入队成功后再 `clearInbox`；先删的话入队失败就真丢了）。
 *
 * @param {string} stateDir
 * @param {object} [io]
 * @returns {{candidates: Array<{bvid:string,title:string,up:string,draft:string}>, bad: number, lines: number}}
 *   bad = 解析不了 / bvid 不对的行数（这些也算「跳过」，会被记进丢弃记录）
 */
export function drainInbox(stateDir, io = {}) {
  const fsIO = ioOf(io)
  const p = queuePaths(stateDir)
  let text = ''
  try { text = fsIO.readFile(p.inbox) } catch { return { candidates: [], bad: 0, lines: 0 } }
  const candidates = []
  let bad = 0
  let lines = 0
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    lines++
    let rec = null
    try { rec = JSON.parse(s) } catch { bad++; continue }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { bad++; continue }
    const bvid = String(rec.bvid ?? '').trim()
    if (!BVID_RE.test(bvid)) { bad++; continue }
    candidates.push({
      bvid,
      title: String(rec.title ?? ''),
      up: String(rec.up ?? ''),
      draft: String(rec.draft ?? ''),
    })
  }
  return { candidates, bad, lines }
}

/**
 * 删掉收件箱（**只在入队成功之后调**）。删不掉返回 false，不抛。
 * @param {string} stateDir
 * @param {object} [io]
 * @returns {boolean}
 */
export function clearInbox(stateDir, io = {}) {
  const fsIO = ioOf(io)
  try { fsIO.remove(queuePaths(stateDir).inbox); return true } catch { return false }
}

/**
 * 记一条「这个候选没进队列」（队列满 / 重复 / 格式不对）—— 一行 JSONL。
 * 队列满时**必须有可见记录**（spec「队列有上限且过期生效；队列满时新候选不入队，并有可见记录」）。
 *
 * @param {string} stateDir
 * @param {{at?: Date|number|string, bvid?: string, title?: string, up?: string, reason?: string}} record
 * @param {object} [io]
 * @returns {object} 写进去的那条
 */
export function appendDropped(stateDir, record = {}, io = {}) {
  const fsIO = ioOf(io)
  const at = toDate(record.at) || new Date()
  const rec = { at: at.toISOString(), bvid: String(record.bvid ?? ''), title: String(record.title ?? ''), reason: String(record.reason ?? '') }
  if (record.up) rec.up = String(record.up)
  try {
    fsIO.mkdir(stateDir)
    fsIO.append(queuePaths(stateDir).dropped, JSON.stringify(rec) + '\n')
  } catch { /* 记不上也不能反过来影响入队 —— 调用方那边还有 duty.log */ }
  return rec
}

/**
 * 读丢弃记录（容错：坏行跳过）。默认只取最近 limit 条。
 * @param {string} stateDir
 * @param {{limit?: number}} [opts]
 * @param {object} [io]
 * @returns {object[]}
 */
export function readDropped(stateDir, { limit = 200 } = {}, io = {}) {
  const fsIO = ioOf(io)
  let text = ''
  try { text = fsIO.readFile(queuePaths(stateDir).dropped) } catch { return [] }
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const rec = JSON.parse(s)
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) out.push(rec)
    } catch { /* 坏行跳过 */ }
  }
  const n = Math.max(1, Math.floor(Number(limit) || 200))
  return out.slice(-n)
}

/**
 * 给接口 / 设置页看的视图：**只列还能投递的**（`pending`），过期 / 已投递的不出现。
 *
 * @param {{entries?: object[]}} queue
 * @param {{now: Date|number}} opts
 * @returns {{
 *   total: number, pending: number, sent: number, expired: number, failed: number,
 *   next: object|null,
 *   items: Array<{id,bvid,title,up,status,collectedAt,expiresAt,expiresInMs,expiresInHours,attempts,lastError,draft}>
 * }}
 */
export function queueView(queue, { now } = {}) {
  const nowDate = requireNow(now, 'queueView')
  const nowMs = nowDate.getTime()
  const entries = normalizeEntries(queue?.entries)
  const pending = entries.filter((e) => e.status === QUEUE_STATUS.pending)
  const item = (e) => {
    const exp = toDate(e.expiresAt)
    const ms = exp ? Math.max(0, exp.getTime() - nowMs) : null
    return {
      id: e.id,
      bvid: e.bvid,
      title: e.title,
      up: e.up,
      status: e.status,
      collectedAt: e.collectedAt,
      expiresAt: e.expiresAt,
      expiresInMs: ms,
      expiresInHours: ms === null ? null : Math.round((ms / 3600_000) * 10) / 10,
      attempts: e.attempts,
      lastError: e.lastError,
      draft: e.draft,
    }
  }
  const count = (s) => entries.filter((e) => e.status === s).length
  return {
    total: entries.length,
    pending: pending.length,
    sent: count(QUEUE_STATUS.sent),
    expired: count(QUEUE_STATUS.expired),
    failed: count(QUEUE_STATUS.failed),
    next: pending.length ? item(pending[0]) : null,
    items: pending.map(item),
  }
}

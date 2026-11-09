/**
 * lib/ledger.mjs —— 投递账：每次投递**尝试**一行 JSONL
 * ============================================================================
 * 工单 05（`.scratch/collect-deliver/issues/05-host-send-and-ledger.md`）：
 *   投递账回答「哪条真的到了、什么时候、失败原因是什么」（GLOSSARY「投递账」）。
 *   同一条视频重试两次就有两行；「已投递」只看有没有回执（`msgKey`）且不是手动投递
 *   —— 与 `lib/delivery-policy.mjs` 的 `deliveredToday` **同口径**（有 msgKey 且非 manual）。
 *
 * 记录形状（spec「接口契约」）：
 *   { at, bvid, status, msgKey?, code?, message?, receiverUid, manual?, id?, durationMs?, hits? }
 *   · at      ISO 8601（UTC）；按天统计时按**本机时区**折算成 YYYY-MM-DD（和 state.mjs 的 dayKey 一致）
 *   · status  sent（拿到回执）/ no-receipt（接口说成功但没回执）/ failed（接口拒绝）/
 *             error（网络 / 工具不可用 / 超时）/ blocked（发送前的机械检查没过）
 *   · id      幂等键（天 + BV），供 07/09 对队列条目；可缺省
 *   · hits    blocked 时命中的内部术语（排查用，永远不发出去）
 *
 * 为什么不再用 `mcp_server.py` 里那份 `dm-deliveries.jsonl`：
 *   它只有在宿主传了 `BILI_DUTY_RUN_DAY` 时才写（手动投递没有这一天），而且只记 BV、
 *   没有回执与失败原因 ⇒ 新投递一律记本文件（交接文档「现场事实」第 2 条）。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dayKey } from './state.mjs'

/** 投递账的文件名（放在插件自己的家里：`<stateDir>/delivery-ledger.jsonl`） */
export const LEDGER_FILE = 'delivery-ledger.jsonl'

/** 一次尝试的结局（写进账本 status 字段；`busy` 不落账，所以不在这里） */
export const DELIVERY_STATUS = Object.freeze({
  sent: 'sent',
  noReceipt: 'no-receipt',
  failed: 'failed',
  error: 'error',
  blocked: 'blocked',
})

/** 投递账的路径 */
export function ledgerPath(stateDir) {
  return join(stateDir, LEDGER_FILE)
}

/**
 * 是不是一次「已投递」（GLOSSARY：拿到回执 `msgKey` 的那一条；没有回执的一律不算）。
 * 手动投递不算进当日额度（GLOSSARY「手动投递」）。
 * @param {object} record
 * @returns {boolean}
 */
export function isDelivered(record) {
  return Boolean(record && record.msgKey) && !record.manual
}

/** 把 at（Date / epoch 毫秒 / ISO 字符串）收成 Date；认不出来 = null */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : new Date(ms)
  }
  return null
}

/** 这条记录属于本机时区的哪一天；at 认不出来 = ''（不归任何一天） */
function dayOf(record) {
  const d = toDate(record?.at)
  return d ? dayKey(d) : ''
}

/** at 统一成 ISO（UTC）；调用方给了合法时间就用它，否则用此刻 */
function atOf(value) {
  const d = toDate(value) || new Date()
  return d.toISOString()
}

/**
 * 追加一条投递账记录。**每次尝试都写**，包括失败与 blocked。
 *
 * 只保留 spec 里的字段（外加 id / durationMs / hits），其余丢掉；
 * 返回真正写进去的那条（`at` 已规范化）。写不进去会抛 —— 由调用方决定怎么兜。
 *
 * @param {string} stateDir 插件家目录
 * @param {object} record 形状见文件头
 * @returns {object} 写进账本的那条记录
 */
export function appendDelivery(stateDir, record = {}) {
  const rec = {
    at: atOf(record.at),
    bvid: String(record.bvid ?? ''),
    status: String(record.status ?? ''),
  }
  if (record.msgKey) rec.msgKey = String(record.msgKey)
  if (record.code !== undefined && record.code !== null && String(record.code) !== '') {
    rec.code = typeof record.code === 'number' && Number.isFinite(record.code) ? record.code : String(record.code)
  }
  if (record.message) rec.message = String(record.message)
  rec.receiverUid = Number(record.receiverUid) || 0
  if (record.manual === true) rec.manual = true
  if (record.id) rec.id = String(record.id)
  if (Number.isFinite(Number(record.durationMs))) {
    rec.durationMs = Math.max(0, Math.round(Number(record.durationMs)))
  }
  if (Array.isArray(record.hits) && record.hits.length) rec.hits = record.hits.map(String)

  const file = ledgerPath(stateDir)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  return rec
}

/**
 * 读投递账（容错：坏行 / 空行直接跳过，绝不让一次旧文件写坏把 /status 拖挂）。
 *
 * @param {string} stateDir
 * @param {{day?: string}} [opts] day = 只要本机时区这一天的（YYYY-MM-DD）
 * @returns {object[]}
 */
export function readDelivery(stateDir, { day } = {}) {
  const file = ledgerPath(stateDir)
  if (!existsSync(file)) return []
  const out = []
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    let rec = null
    try { rec = JSON.parse(s) } catch { continue }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    if (day && dayOf(rec) !== String(day)) continue
    out.push(rec)
  }
  return out
}

/**
 * 某一天「已投递」了几条 —— 与 `lib/delivery-policy.mjs` 同口径：
 * 有 `msgKey`（回执）且 `manual !== true`，且 `at` 落在这一天。
 *
 * @param {object[]} records 投递账记录
 * @param {{day?: string, now?: Date|number|string}} [opts]
 * @returns {number}
 */
export function deliveredOn(records, { day, now = new Date() } = {}) {
  const nowDate = toDate(now) || new Date()
  const want = day ? String(day) : dayKey(nowDate)
  let n = 0
  for (const r of Array.isArray(records) ? records : []) {
    if (!isDelivered(r)) continue
    if (dayOf(r) !== want) continue
    n++
  }
  return n
}

/**
 * 最近一条投递尝试（不管成功失败 —— 07 的退避与 09 的「上次投递」都要看它）。
 * 按 `at` 取最新；at 全认不出来时退回数组最后一条。
 *
 * @param {object[]} records
 * @returns {object|null}
 */
export function lastDelivery(records) {
  const list = Array.isArray(records) ? records : []
  let last = null
  let lastMs = -Infinity
  for (const r of list) {
    const d = toDate(r?.at)
    if (!d) continue
    if (d.getTime() > lastMs) { lastMs = d.getTime(); last = r }
  }
  if (!last && list.length) last = list[list.length - 1]
  return last
}

/**
 * 设置页与 07 要的两件事：今天已投递几条 + 最近一次尝试。
 *
 * @param {object[]} records
 * @param {{day?: string, now?: Date|number|string}} [opts]
 * @returns {{deliveredToday: number, lastDelivery: object|null}}
 */
export function summarizeDelivery(records, { day, now = new Date() } = {}) {
  const nowDate = toDate(now) || new Date()
  const want = day ? String(day) : dayKey(nowDate)
  return {
    deliveredToday: deliveredOn(records, { day: want }),
    lastDelivery: lastDelivery(records),
  }
}

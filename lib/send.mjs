/**
 * lib/send.mjs —— 宿主侧的私信发送通道（一条纯文本私信 + 一次投递账记录）
 * ============================================================================
 * 工单 05（`.scratch/collect-deliver/issues/05-host-send-and-ledger.md`）：
 *   发送权归宿主，不归模型（`/api/bili-duty/deliver` 不是模型工具）。
 *   这一层只做四件事，全部围绕「一次尝试」：
 *
 *     ① 发送前的机械检查 —— `lib/outbound.mjs` 的 `checkOutboundText` 命中就不发（blocked）；
 *        自动投递要更严的一档：调用时带 `requireLink: true` ⇒ 走 `checkDeliveryText`
 *        （正文里得有条视频的链接、长度不能病态地长）；手动 `/deliver` 不带 ⇒ 只查术语。
 *     ② 调注入的 `send({ receiver_uid, text })`（宿主接 `bili_send_message`）；
 *     ③ 按回执分类：有 `msg_key` = sent；接口拒绝 = failed；成功但没回执 = no-receipt；
 *        抛异常（工具不可用 / 超时 / 网络）= error；
 *     ④ 每次尝试都写一条账（注入的 `append`），返回值里带上账本那条记录，供 07/09 判断。
 *
 * 并发与多宿主：
 *   · 同一进程内用一条 promise 链**串行化** —— 同一时刻只有一条进 MCP；
 *   · 跨宿主用注入的 `lock`（`lib/file-lock.mjs`）互斥；别人正占着 ⇒ 直接返回
 *     `{ ok:false, busy:true }`，**不落账**（它不是一次失败尝试，也不该阻塞）。
 *
 * 注入契约（测试与后续工单都靠它，不 mock 模块内部）：
 *   send    async ({receiver_uid, text}) => MCP 的返回（对象或字符串）
 *   append  (record) => 真正写进账本的那条（同步；一般是 lib/ledger.mjs 的 appendDelivery 绑定好 stateDir）
 *   lock    { acquire(): {ok, busy?, holder?}, release() }，可缺省（测试/无锁场景）
 *   now     () => Date | epoch 毫秒（可注入，便于测试）
 *   log     (msg) => void
 *   check   (text) => {ok, hits, reason}（默认 checkOutboundText —— 只查内部术语）
 *   checkDelivery (text, {bvid}) => 同上（默认 checkDeliveryText —— 自动投递那一档）
 *
 * 每次调用的 `sendPrivate(input)` 还可以带：
 *   · `requireLink: true` ⇒ 这一次走 `checkDelivery`（07 的 tick / 09 的 deliverNow 都带它）；
 *   · `check: (text, {bvid}) => verdict` ⇒ 这一次用调用方给的检查器（测试 / 特殊场景）。
 * ============================================================================
 */
import { checkOutboundText, checkDeliveryText } from './outbound.mjs'
import { DELIVERY_STATUS } from './ledger.mjs'
import { dayKey } from './state.mjs'

/** 可读文本（错误字段可能是对象，别把 [object Object] 写进账本） */
function textOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) } catch { return '' }
}

/** 错误码：能当数字就当数字，否则原样字符串 */
function codeOf(value) {
  if (value === undefined || value === null || String(value) === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : String(value)
}

/** 把 at（Date / epoch 毫秒 / ISO 字符串）收成 Date */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : new Date(ms)
  }
  return null
}

/**
 * 按 `bili_send_message` 的返回分类。**纯函数**，单独导出方便单测。
 *
 * 真实工具的回执有两处可能出现：顶层 `msg_key`，或 `data.msg_key`（vendor 里的
 * `bili_send_message` 就把它放在 `data` 里）—— 两处都认，别只看一层。
 *
 * @param {unknown} reply
 * @returns {{status: string, msgKey?: string, code?: number|string, message?: string}}
 */
export function classifySendReply(reply) {
  if (typeof reply === 'string') {
    return {
      status: DELIVERY_STATUS.noReceipt,
      message: '工具返回了纯文本、没有可解析的回执' + (reply.trim() ? '：' + reply.trim().slice(0, 200) : ''),
    }
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    return {
      status: DELIVERY_STATUS.noReceipt,
      message: '工具没有返回可解析的结果（没有回执）',
    }
  }

  const data = reply.data && typeof reply.data === 'object' && !Array.isArray(reply.data) ? reply.data : {}
  // vendor 里的 bili_send_message 把原始返回塞在 data，而回执可能在 raw 顶层或 raw.data 里
  // （Python 侧就是 `data.get("msg_key") or inner.get("msg_key")`）—— 两层都认。
  const inner = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : {}
  const rawCode = reply.code ?? data.code
  const hasCode = rawCode !== undefined && rawCode !== null && String(rawCode) !== ''
  const codeNonZero = hasCode && String(rawCode) !== '0'
  const rawKey = reply.msg_key ?? reply.msgKey ?? data.msg_key ?? data.msgKey ?? inner.msg_key ?? inner.msgKey
  const msgKey = rawKey === undefined || rawKey === null ? '' : String(rawKey)
  const message = textOf(reply.error ?? reply.message ?? data.message ?? data.msg ?? inner.message ?? inner.msg)
  const refused = reply.success === false || reply.success === 'false' || codeNonZero

  if (refused) {
    const code = codeNonZero ? codeOf(rawCode) : undefined
    return {
      status: DELIVERY_STATUS.failed,
      code,
      message: message || (code !== undefined ? '接口拒绝（code=' + code + '）' : '接口拒绝（没有给出原因）'),
    }
  }
  if (msgKey) return { status: DELIVERY_STATUS.sent, msgKey }
  return {
    status: DELIVERY_STATUS.noReceipt,
    message: message || '接口说成功，但没有投递回执（msg_key）',
  }
}

/**
 * 建一个宿主私信发送器。返回的 `sendPrivate(input)` 会排队执行（同一进程串行）。
 *
 * @param {object} deps 形状见文件头
 * @returns {(input: {receiverUid?: number|string, uid?: number|string, text?: string, bvid?: string, manual?: boolean, id?: string, requireLink?: boolean, check?: Function}) => Promise<object>}
 */
export function createPrivateSender({
  send,
  append,
  lock = null,
  now = () => new Date(),
  check = checkOutboundText,
  checkDelivery = checkDeliveryText,
  log = () => {},
} = {}) {
  if (typeof send !== 'function') throw new TypeError('createPrivateSender 需要注入 send()')
  if (typeof append !== 'function') throw new TypeError('createPrivateSender 需要注入 append()')

  /** 一条 promise 链：前一条彻底结束（包括失败/记账）后才发下一条 */
  let chain = Promise.resolve()

  /** 拼一条账本记录（字段顺序照 spec；空字段不写） */
  const buildRecord = ({ at, bvid, status, msgKey, code, message, receiverUid, manual, id, durationMs, hits }) => {
    const rec = { at, bvid, status }
    if (msgKey) rec.msgKey = String(msgKey)
    if (code !== undefined && code !== null && String(code) !== '') rec.code = code
    if (message) rec.message = String(message)
    rec.receiverUid = Number(receiverUid) || 0
    if (manual === true) rec.manual = true
    if (id) rec.id = String(id)
    if (Number.isFinite(Number(durationMs))) rec.durationMs = Math.max(0, Math.round(Number(durationMs)))
    if (Array.isArray(hits) && hits.length) rec.hits = hits.map(String)
    return rec
  }

  /** 落账（写不进去也要把结果返回；账本故障不能反过来吞掉一次发送的结果） */
  const persist = (result, record) => {
    try {
      const saved = append(record)
      return { ...result, record: saved && typeof saved === 'object' ? saved : record }
    } catch (e) {
      const reason = String(e?.message ?? e)
      log('写投递账失败（这一次的结果仍然返回）：' + reason)
      return { ...result, record, ledgerError: reason }
    }
  }

  async function attempt(input = {}) {
    const startedAt = Date.now()
    const atDate = toDate(now()) || new Date()
    const at = atDate.toISOString()
    const receiverUid = Number(input.receiverUid ?? input.uid)
    const uid = Number.isFinite(receiverUid) && receiverUid > 0 ? Math.floor(receiverUid) : 0
    const bvid = String(input.bvid ?? '').trim()
    const manual = input.manual === true
    const text = String(input.text ?? '')
    const id = input.id ? String(input.id) : (bvid ? dayKey(atDate) + ':' + bvid : '')
    const elapsed = () => Date.now() - startedAt

    /** 发送前的机械检查没过：不发，记 blocked */
    const block = (message, hits = []) => {
      const record = buildRecord({ at, bvid, status: DELIVERY_STATUS.blocked, message, receiverUid: uid, manual, id, durationMs: elapsed(), hits })
      log('投递被拦下（' + message + '）：bvid=' + (bvid || '-'))
      return persist({ ok: false, blocked: true, status: DELIVERY_STATUS.blocked, reason: message, record }, record)
    }

    // ① 机械检查（都在进 MCP 之前）
    if (!uid) return block('收件人 UID 不合法（' + String(input.receiverUid ?? input.uid ?? '') + '）⇒ 没有发送')
    if (!text.trim()) return block('正文为空 ⇒ 没有发送')
    // 按这一次调用挑检查器：显式注入 > 自动投递那一档（requireLink）> 默认只查术语
    const validator = typeof input.check === 'function'
      ? input.check
      : (input.requireLink === true ? checkDelivery : check)
    let verdict
    try {
      verdict = validator(text, { bvid })
    } catch (e) {
      return block('发送前检查本身出错（' + String(e?.message ?? e) + '）⇒ 没有发送')
    }
    if (!verdict?.ok) {
      const hits = Array.isArray(verdict?.hits) ? verdict.hits.map(String) : []
      const detail = String(verdict?.reason || '').trim()
        || (hits.length ? '正文含内部标识符（' + hits.join('、') + '）' : '正文没通过出站检查')
      return block('发送前检查未通过：' + detail + ' ⇒ 没有发送', hits)
    }

    // ② 跨宿主锁：别人正占着 ⇒ 这一次不发，也不落账（不是失败，别占重试名额）
    if (lock && typeof lock.acquire === 'function') {
      const got = lock.acquire()
      if (got && got.ok === false && got.busy) {
        const why = '另一个宿主正在投递（pid=' + (got.holder?.pid ?? '?') + '）⇒ 这一次先不发'
        log('投递跳过一次：' + why)
        return { ok: false, busy: true, status: 'busy', reason: why, record: null }
      }
      if (got?.unsafe) log('投递锁没写成，这一次照发（可能重复一次）')
    }

    // ③ 发送 + 分类 + 落账（finally 一定放锁）
    try {
      let reply
      try {
        reply = await send({ receiver_uid: uid, text })
      } catch (e) {
        const message = textOf(e?.message ?? e) || '发送工具不可用'
        const record = buildRecord({
          at, bvid, status: DELIVERY_STATUS.error, code: codeOf(e?.code),
          message, receiverUid: uid, manual, id, durationMs: elapsed(),
        })
        log('投递出错（' + message + '）：bvid=' + (bvid || '-'))
        return persist({ ok: false, status: DELIVERY_STATUS.error, reason: message, record }, record)
      }

      const verdictOfReply = classifySendReply(reply)
      const record = buildRecord({
        at,
        bvid,
        status: verdictOfReply.status,
        msgKey: verdictOfReply.msgKey,
        code: verdictOfReply.code,
        message: verdictOfReply.message,
        receiverUid: uid,
        manual,
        id,
        durationMs: elapsed(),
      })
      if (verdictOfReply.status === DELIVERY_STATUS.sent) {
        log('投递成功：bvid=' + (bvid || '-') + ' 回执=' + String(verdictOfReply.msgKey).slice(0, 16) + '…')
        return persist({ ok: true, status: DELIVERY_STATUS.sent, msgKey: verdictOfReply.msgKey, record }, record)
      }
      log('投递没拿到回执（' + verdictOfReply.status + '）：bvid=' + (bvid || '-')
        + (verdictOfReply.message ? ' —— ' + verdictOfReply.message : ''))
      return persist({
        ok: false,
        status: verdictOfReply.status,
        code: verdictOfReply.code,
        reason: verdictOfReply.message || verdictOfReply.status,
        record,
      }, record)
    } finally {
      if (lock && typeof lock.release === 'function') {
        try { lock.release() } catch (e) { log('放投递锁失败（靠 TTL 过期）：' + String(e?.message ?? e)) }
      }
    }
  }

  return function sendPrivate(input = {}) {
    // 用 then 串起来：前一次抛不抛都不会卡住后一次
    const run = chain.then(() => attempt(input))
    chain = run.then(() => undefined, () => undefined)
    return run
  }
}

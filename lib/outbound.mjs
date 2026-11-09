/**
 * lib/outbound.mjs —— 出站文本的机械检查（纯函数、零 IO）
 * ============================================================================
 * 工单 04：人设决定"怎么说话"，但**设置名 / 内部字段名 / 台账口径**不该出现在
 * 公开评论（以后还有分享草稿、私信）里 —— 观众看不懂，还会把使用者的配置漏出去。
 * 这一道不靠模型自觉：发送前由宿主检查，命中就不发，并把命中的词交回去让它改写。
 *
 * 口径（只在这里定一套）：
 *   · 中文词按**子串**认（「排队」不含「队列」✓，不会误伤正常中文）；
 *   · 英文词按**单词边界**认（`commonly` 里的 `only` 不算；大小写不敏感）；
 *   · 明显的内部路径：Windows 盘符 / UNC / POSIX 家目录 / `.dsh` / `<家目录>`。
 *
 * 两个入口（同一个词表，别在别处再列一份）：
 *   · `checkOutboundText(text)` —— 只查内部术语。公开评论（`index.js` 的 `bili_reply`）与
 *     手动 `POST /api/bili-duty/deliver` 用它（工单 05 的通用入口保持原样）；
 *   · `checkDeliveryText(text, { bvid })` —— 在它之上再加两条**投递专用**的机械检查：
 *     正文里得有这条视频的链接、长度不能病态地长。**自动投递**（`lib/delivery-clock.mjs`
 *     的 tick 与 deliverNow）走这一档。
 *
 * ⚠️ 长度只设**病态上限**（`DELIVERY_MAX_CHARS = 2000`），不是接口硬边界：
 *    spec「Further Notes」写明「500 字符上限」不是硬边界（一条一个视频远低于它）。
 * ============================================================================
 */

/** 英文 / 字段名：按单词边界匹配，避免 `commonly` 里的 `only` 这类误伤 */
const ASCII_TERMS = [
  // 设置名与配置字段
  'dmMode', 'dmUid', 'dmWatch', 'dmReplyPerDay', 'dmOwnerUid',
  'channelDm', 'channelComment',
  'autoComment', 'mentionName', 'commentPerRound', 'commentLength', 'replyToComments', 'replyPerRound',
  'perDay', 'peakValley', 'transcribe', 'asrModel', 'workspace', 'personaPrompt',
  'tasteBrief', 'gateEnabled', 'gateMinViews', 'gateMinMinutes', 'gateWithinDays',
  'reportLevel', 'keywords', 'excludeWords', 'searchSort', 'searchPages', 'fetchPerRound',
  'manualMax', 'manualCooldownMin', 'favFolderId', 'modelProvider', 'modelName', 'runTimeoutMinutes',
  'overlayMcp', 'headlessProfile',
  // 渠道取值 / 内部字段名
  'only', 'both', 'rpid', 'msgKey', 'bvid',
  // 机制与台账
  'overlay', 'profile', 'prompt', 'token', 'persona', 'NO_ADAPTER',
  'seen.md', 'comments.md', 'duty.log', 'state.json', 'config.json', 'blocked-outbound', 'bili-duty', '.dsh',
]

/** 中文内部术语：按子串匹配（故意避开「排队」这类正常词） */
const CJK_TERMS = [
  '判重表', '白名单', '复核', '采集轮', '队列', '投递账', '投递记录',
  '判据', '台账', '内部字段', '设置项', '宿主',
]

/** 明显的内部路径（这些不该出现在给外人看的字里） */
const PATH_RULES = [
  { label: 'Windows 绝对路径', re: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s，。；;、）)]*/ },
  { label: 'UNC 路径', re: /\\\\[^\s，。；;、）)]+/ },
  { label: 'POSIX 绝对路径', re: /(?:^|[\s(（"'`])\/(?:home|Users|root|tmp|opt|var|etc|mnt|srv|private)\/[^\s，。；;、）)]*/ },
  { label: '<家目录>', re: /<家目录>/ },
]

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ASCII_RULES = ASCII_TERMS.map((term) => ({
  label: term,
  re: new RegExp('(?<![A-Za-z0-9_])' + escapeRe(term) + '(?![A-Za-z0-9_])', 'i'),
}))

/**
 * 检查一段准备发出去的文本。
 *
 * @param {unknown} text
 * @returns {{ok: boolean, hits: string[], reason: string}}
 *   · `hits` 是命中的词 / 路径类别（去重、保持首次命中的顺序）；
 *   · `reason` 是给模型看的大白话；没命中时为空串。
 */
export function checkOutboundText(text) {
  const s = String(text ?? '')
  const hits = []
  const hit = (label) => { if (!hits.includes(label)) hits.push(label) }

  for (const rule of ASCII_RULES) if (rule.re.test(s)) hit(rule.label)
  for (const term of CJK_TERMS) if (s.includes(term)) hit(term)
  for (const rule of PATH_RULES) if (rule.re.test(s)) hit(rule.label)

  if (!hits.length) return { ok: true, hits: [], reason: '' }
  return {
    ok: false,
    hits,
    reason: '评论里有内部术语：' + hits.join('、')
      + ' —— 这些是设置名 / 内部字段 / 台账口径，观众看不懂，也不该把使用者的配置说出去；改成大白话再发。',
  }
}

/** 一条私信正文的**病态上限**（不是接口硬边界；spec「Further Notes」明说 500 不是） */
export const DELIVERY_MAX_CHARS = 2000

/** 像不像一条视频链接（`http(s)://…` 与 `BV…` 都算） */
const LINK_RE = /https?:\/\//i
const BV_RE = /BV[0-9A-Za-z]{10}/

/**
 * 正文里有没有**这条视频**的链接。
 *   · 给了 bvid：认 `https://www.bilibili.com/video/<bvid>`（任意 bilibili 子域 / http(s)），
 *     或者退一步 —— 正文里同时出现这个 BV 号与任意 `http(s)` 链接；
 *   · 没给 bvid：只要「某个 BV 号 + 任意 http(s) 链接」同时出现。
 * @param {string} s
 * @param {string} [bvid]
 * @returns {boolean}
 */
function hasVideoLink(s, bvid) {
  const bv = String(bvid ?? '').trim()
  if (bv && BV_RE.test(bv)) {
    const direct = new RegExp(
      'https?:\\/\\/(?:[A-Za-z0-9-]+\\.)*bilibili\\.com\\/video\\/' + escapeRe(bv), 'i')
    if (direct.test(s)) return true
    return s.includes(bv) && LINK_RE.test(s)
  }
  return BV_RE.test(s) && LINK_RE.test(s)
}

/**
 * 私信（自动投递）发送前的机械检查：`checkOutboundText` 的全部 + 两条投递专用的。
 *
 * 为什么多这两条：私信是**离开这个仓库、直接落到使用者手机上**的一段正文 ——
 *   · 没有链接 ⇒ 他点不回去，也就不知道说的是哪条视频；
 *   · 病态地长 ⇒ 不是「一条一个视频」的私信（合并 / 贴全文），正是实测里会被接口拒的形态。
 *
 * @param {unknown} text
 * @param {{bvid?: string}} [opts]
 * @returns {{ok: boolean, hits: string[], reason: string}} 形状同 `checkOutboundText`
 */
export function checkDeliveryText(text, { bvid } = {}) {
  const s = String(text ?? '')
  const bv = String(bvid ?? '').trim()
  const base = checkOutboundText(s)
  const hits = base.ok ? [] : base.hits.slice()
  const problems = []
  if (!base.ok) problems.push(base.reason)
  if (!hasVideoLink(s, bv || undefined)) {
    problems.push('正文里没有这条视频的链接'
      + (bv ? '（' + bv + '）' : '')
      + ' —— 使用者收到得能点回去；把 https://www.bilibili.com/video/' + (bv || '<BV号>') + ' 写进正文再发。')
  }
  if (s.length > DELIVERY_MAX_CHARS) {
    problems.push('正文 ' + s.length + ' 字，明显异常长（一条视频的私信不该超过 ' + DELIVERY_MAX_CHARS
      + ' 字）—— 这是合并 / 贴全文的形态，精简到一段再发。')
  }
  if (!problems.length) return { ok: true, hits: [], reason: '' }
  return { ok: false, hits, reason: problems.join('\n') }
}

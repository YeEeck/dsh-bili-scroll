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
 * 只用在这里 —— `index.js` 的 `bili_reply` 在执行前调 `checkOutboundText`。
 * 06 写分享草稿时也应该调它（同一个入口，别在别处再列一份词表）。
 * ============================================================================
 */

/** 英文 / 字段名：按单词边界匹配，避免 `commonly` 里的 `only` 这类误伤 */
const ASCII_TERMS = [
  // 设置名与配置字段
  'dmMode', 'dmUid', 'dmWatch', 'dmReplyPerDay', 'dmOwnerUid',
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

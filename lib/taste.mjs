/**
 * lib/taste.mjs —— 口味简报 + 可选数值硬门槛（纯模块，零 IO）
 * ============================================================================
 * 工单 03（`.scratch/collect-deliver/issues/03-taste-brief.md`）：
 *   把「关注什么」从**关键词列表**升级成**一段自然语言简报** —— 采集轮读这段话，
 *   自己决定走 `bili_recommend` 刷首页推荐流、还是从简报里提炼搜索词用 `bili_search` 搜；
 *   挑选时按简报的偏好筛。**老关键词继续生效**，但只作为「你可能想搜这些」注入（不是硬指令）。
 *   简报留空 ⇒ 行为与以前**一个字都不差**：有关键词搜关键词、没有就刷推荐流。
 *
 *   另一组是**可选**的数值硬门槛（最低播放 / 最短时长 / 发布时间窗），默认关闭：
 *   开启、且至少一条 > 0 时，把三条数字写进这一轮的开场说明，并要求那一轮在日报里
 *   写一行「硬门槛挡掉 N 条」（N=0 也写）。宿主用 parseGateBlocked 从**当天日报**读回来，
 *   放进 `/status` 与设置页。关闭时**不写、也不解析** —— 行为与今天一致。
 *
 * 这里只有纯函数：钳制、拼提示词、解析日报那一行。读配置 / 读文件都在 index.js。
 *
 * 口径（三条都写死在这儿，别在别处再定一套）：
 *   · 简报到 4000 字就截（保存时截一次、读回来再截一次，幂等）；
 *   · 三条门槛都是 0 = 不限；三条全 0 时整组视为**没开** —— 不然日报里会多一行永远是 0 的账；
 *   · 日报里那一行允许出现多次（一天可能跑两轮）⇒ 解析结果是**求和**，不是取最后一条；
 *   · 解析**从不抛**：没有那一行 / 写坏了 / 传进来不是字符串 ⇒ 0（状态接口不能因此报错）。
 * ============================================================================
 */

/** 简报保存 / 注入的字数上限（和 `prompts/duty.md` 的量级对齐：一段话，不是一本书） */
export const BRIEF_LIMIT = 4000

/** 三条硬门槛的上限 —— 设置页写的范围必须和这里一致（写与读两头都按它钳） */
export const GATE_MAX = { minViews: 10_000_000, minMinutes: 600, withinDays: 365 }

/** 日报里那一行的样板（提示词里原样给出去；解析只认这个开头） */
export const GATE_LINE = '硬门槛挡掉 N 条'

/**
 * 简报钳制：去首尾空白、超上限截断。**幂等**（读回来再跑一次结果一样）。
 * @param {unknown} v
 * @param {number} [limit]
 * @returns {string}
 */
export function clampBrief(v, limit = BRIEF_LIMIT) {
  const text = String(v ?? '').trim()
  if (text.length <= limit) return text
  return text.slice(0, limit)
}

/**
 * 硬门槛数字：非负整数，超过上限就钳到上限；负数 / NaN / 写坏 ⇒ 0（= 不限）。
 * @param {unknown} v
 * @param {number} max
 * @returns {number}
 */
export function clampGateCount(v, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, Math.max(0, Math.floor(Number(max) || 0)))
}

/**
 * 从配置里读出一组硬门槛。
 * `active` = 开关开着**且**至少一条 > 0 —— 全 0 等于没开（三条都「不限」还逼模型报一行 0 是噪音）。
 *
 * @param {object} cfg 配置（字段缺失 / 写坏都钳成能用的形状，不抛）
 * @returns {{enabled: boolean, active: boolean, minViews: number, minMinutes: number, withinDays: number}}
 */
export function gateOf(cfg = {}) {
  const minViews = clampGateCount(cfg?.gateMinViews, GATE_MAX.minViews)
  const minMinutes = clampGateCount(cfg?.gateMinMinutes, GATE_MAX.minMinutes)
  const withinDays = clampGateCount(cfg?.gateWithinDays, GATE_MAX.withinDays)
  const enabled = Boolean(cfg?.gateEnabled)
  return { enabled, active: enabled && (minViews > 0 || minMinutes > 0 || withinDays > 0), minViews, minMinutes, withinDays }
}

/** 三条门槛里写着的那几条（中文口径；0 = 不限的不写） */
function gateRulesOf(gate) {
  const rules = []
  if (gate.minViews > 0) rules.push(`最低播放量 ${gate.minViews}`)
  if (gate.minMinutes > 0) rules.push(`时长至少 ${gate.minMinutes} 分钟`)
  if (gate.withinDays > 0) rules.push(`只看最近 ${gate.withinDays} 天内发布的`)
  return rules
}

/** 硬门槛那一段（只在这一轮真开着、且至少一条 > 0 时给出） */
function gatePromptOf(gate) {
  return '⛔ **数值硬门槛（这一轮先过这一关）**：' + gateRulesOf(gate).join('；') + '。'
    + '扫到候选时先按这几条筛：不满足的**整条跳过**（别读字幕、别进报告正文），'
    + `⭐ **报告里必须写一行「${GATE_LINE}」**（N = 被这几条挡掉的条数；N=0 也写）—— 宿主会读它。`
}

/** 搜索参数那一句（简报 / 关键词两种路子都用得到，保持和设置页的旋钮同一个口径） */
function searchKnobsOf(search) {
  const sortOk = ['pubdate', 'click', 'dm', 'totalrank'].includes(String(search?.sort))
  const sort = sortOk ? String(search.sort) : 'pubdate'
  const pages = Math.max(1, Math.floor(Number(search?.pages)) || 2)
  const fetch = Math.max(1, Math.floor(Number(search?.fetchPerRound)) || 8)
  return `排序用 ${sort}（pubdate=最新 · click=播放 · dm=弹幕 · totalrank=综合）；`
    + `翻页：${pages} 页 —— 用 bili_search(page=1..N)，每页扫一眼标题再决定，别只看第一页；`
    + `这一轮最多**细看** ${fetch} 条（读字幕 / 评论都算一次请求），其余的只扫标题，别把候选全读一遍；`
}

/**
 * 拼「这一轮看哪儿」那一段提示词（采集轮开场说明里的一段）。
 *
 * 三种情况，**空简报那两种必须和升级前一个字不差**（老用户零回归）：
 *   ① 简报非空 ⇒ 简报是主依据（模型自己决定推荐流 or 提炼搜索词），老关键词只当「你可能想搜这些」；
 *   ② 简报为空 + 有关键词 ⇒ 老行为：用这些关键词搜；
 *   ③ 简报为空 + 没关键词 ⇒ 老行为：刷首页推荐流（不要出现空提示词）。
 * 硬门槛（`gate.active`）是**另一维**：哪种情况都追加那一段。
 *
 * @param {{brief?: unknown, keywords?: unknown, gate?: object, search?: object}} [input]
 * @returns {string} 一段（不带前后空行；调用方直接拼进提示词）
 */
export function tastePromptOf({ brief, keywords, gate, search } = {}) {
  const text = clampBrief(brief)
  const kws = (Array.isArray(keywords) ? keywords : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  const gateText = gate?.active ? gatePromptOf(gate) : ''
  // 门槛那段单独起一段（简报为空时也是：旧行为只多一个空行，文字一个字没动）
  const withGate = (s) => (gateText ? s + '\n\n' + gateText : s)

  if (!text) {
    return withGate(kws.length
      ? `关键词用这些：${kws.join('、')}（用 bili_search 搜）。` + searchKnobsOf(search)
      : '没填关键词 ⇒ **这一轮用 bili_recommend 刷首页推荐流**（不要用 bili_search 搜固定词）。')
  }

  const lines = [
    '⭐ **这一轮想看什么（使用者写的一段话 —— 这轮找什么，以它为主）**：',
    `「${text}」`,
    '按这段话**自己决定**怎么找：可以 **`bili_recommend(ps=30)`** 刷这个账号的首页推荐流，'
      + '也可以从这段话里提炼几个搜索词用 **`bili_search`** 搜 —— 哪种更接近他想看的，**你自己定**；',
    '挑的时候按这段话的偏好筛（他说不要的就整条跳过），别只按"通用好评"挑。',
    `真要搜的话：${searchKnobsOf(search)}`,
  ]
  if (kws.length) {
    lines.push(`老的关键词（当作「你可能想搜这些」，**不是硬指令**）：${kws.join('、')} —— 用不用、用哪个，你自己定。`)
  }
  // 简报这段单独起一段：前面紧贴的是「评论长度…」，粘在一起读起来像一句话
  return '\n\n' + withGate(lines.join('\n'))
}

/** 日报里那一行：允许「硬门槛挡掉了 3 条」「硬门槛挡掉：3 条」这类小走样；不认「N」字面占位符 */
const GATE_RE = /硬门槛挡掉(?:了)?\s*[:：]?\s*(\d{1,7})\s*(?:条)?/g

/**
 * 从一份日报文本里读「硬门槛挡掉 N 条」，返回合计。
 * · 没有这一行 ⇒ 0；写坏了 ⇒ 0；传进来不是字符串 ⇒ 0（**从不抛**）
 * · 出现多次 ⇒ 求和（一天可能跑两轮，每轮各写一行）
 * · 围栏 ``` 里的不算（那一轮没写报告时，占位报告会把 duty.log 尾部贴进来）
 *
 * @param {unknown} text
 * @returns {number}
 */
export function parseGateBlocked(text) {
  try {
    const s = String(text ?? '').replace(/```[\s\S]*?```/g, '')
    let n = 0
    for (const m of s.matchAll(GATE_RE)) {
      const v = Number(m[1])
      if (Number.isFinite(v)) n += v
    }
    return n
  } catch {
    return 0
  }
}

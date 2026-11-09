/**
 * lib/tool-whitelist.mjs —— 值班轮能看到哪些 MCP 工具（按用途分）
 * ============================================================================
 * 工单 06：**采集轮不再有发送私信的手**。
 *   以前 `index.js` 的 `mcpWhitelist()` 只有一份名单，私信开着就顺手把 `bili_send_message`
 *   放进采集轮 —— 那一轮手里有发送工具，模型想发就能发（提示词说不发只是自觉）✗。
 *   现在按**用途**分两份，白名单是真闸门：`mcp_server.py` 那头不在名单里的工具**连名字都不注册**。
 *
 *   · collect（采集轮）：搜 / 字幕 / 评论 / 封面 / 帧 / 弹幕 / 推荐 + 窄口 IO（日报 / 判重表 /
 *     归档 / 收件箱）+ 转写；公开评论开着时才有 `bili_reply`；**永远没有 `bili_send_message`**。
 *   · dm（私信回复轮）：只读那几只 + `bili_send_message` —— 它只干一件事：回一句。
 *     （不给评论 / 写账那几只：那一轮不需要，也不该顺手评论。）
 *
 * ⚠️ 这份名单是**安全边界**（issue #96）：别为了省事把 `bili_send_message` 加回 collect，
 *    也别把 `bili_reply` 给 dm 轮。
 * ============================================================================
 */

/** 只读：看视频 / 字幕 / 评论 / 封面 / 画面帧 / 弹幕 / 推荐流 */
const READ_TOOLS = [
  'bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info',
  'bili_cover', 'bili_frames', 'bili_danmaku', 'bili_recommend',
]

/**
 * 窄口 IO：固定路径、不接受路径参数（值班轮是最小权限 profile，没有 fs / shell / web）。
 * `duty_candidate_append` 是 06 新加的：把候选写进 `<家>/queue-inbox.jsonl`。
 */
const DUTY_TOOLS = [
  'duty_paths', 'duty_report_append', 'duty_seen_append', 'duty_digest_append', 'duty_seen_recent',
  'duty_candidate_append',
]

/** 转写（没字幕的视频用；装没装由宿主判断） */
const ASR_TOOLS = ['bili_transcribe', 'bili_transcribe_start', 'bili_transcribe_result']

/** 用途 */
export const WHITELIST_PURPOSE = Object.freeze({ collect: 'collect', dm: 'dm' })

/**
 * 算出这一轮该下发哪些工具。
 *
 * @param {object} [opts]
 * @param {'collect'|'dm'} [opts.purpose] 这一轮是采集轮还是私信回复轮（不认识的按采集轮）
 * @param {boolean} [opts.transcribe] 转写装了没有（默认给）
 * @param {boolean} [opts.comments] 这一轮允不允许发公开评论（采集轮才有意义）
 * @returns {string[]} 工具名（按给 mcp_server.py 的 `BILI_MCP_TOOLS` 逗号分隔口径）
 */
export function buildWhitelist({ purpose = 'collect', transcribe = true, comments = false } = {}) {
  const p = String(purpose) === WHITELIST_PURPOSE.dm ? WHITELIST_PURPOSE.dm : WHITELIST_PURPOSE.collect
  const list = [...READ_TOOLS]
  if (p === WHITELIST_PURPOSE.dm) {
    // 私信回复轮：只回一句 + （要读字幕时）读字幕。没有评论工具、没有写账工具、没有采集工具。
    list.push('bili_send_message')
    return list
  }
  list.push(...DUTY_TOOLS)
  if (transcribe) list.push(...ASR_TOOLS)
  if (comments) list.push('bili_reply')
  return list
}

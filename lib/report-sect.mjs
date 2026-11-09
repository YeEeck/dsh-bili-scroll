/**
 * lib/report-sect.mjs —— 原地替换日报里宿主自己写的那一节（`## 投递` / `## 评论复核` / `## 队列`）
 * ============================================================================
 * ⭐ #172 / #166：多轮时这一节后面还有别的轮次写的东西，只能动这一节本身。
 *   规则：找出所有 marker 节 → 全删掉 → 在第一个出现的位置插回合并后的那一节。
 *
 * 这一节在哪结束，不能靠「下一个 `## `」：章程要求模型写 `### BV号`，第二轮常常一个 `## ` 都没有，
 * 那样会一路替换到文件尾，把第二轮整个吞掉。这两节都是宿主自己生成的，形状固定：
 *   标题行 + 空行 + 连续的 `- ` 列表行。第一条不属于这个形状的行就是别人的内容。
 *
 * ⭐ 工单 06 的 `## 队列` 一节多一层：每条候选是 `### BV号` + 一串 `- ` 字段
 *   （`{ subheads: true }`）。结尾规则还是一条：**不属于这个形状的行就是别人的内容** ——
 *   但 `### ` 只认「宿主那种子块」（整行是 BV 标题、后面紧跟 `- ` 字段），
 *   这样别人的 `### 小结` / `### 投递情况` / `### BV…` 后面跟一段普通文字，都不会被吞掉。
 * ============================================================================
 */

// 必须是整行标题：等于 marker，或以「marker（」开头（`## 评论复核（宿主自动跑的…）`）。
// 不能用 indexOf：`### 投递情况` 里也有 `## 投递` 这个子串，会被当成这一节，还留下一个孤立的 `#`。
const isHead = (line, marker) => {
  const t = line.trimEnd()
  return t === marker || t.startsWith(marker + '（')
}

const isBullet = (line) => line.startsWith('- ')

// 宿主写的子块标题：`### BV1xxxxxxxxx`（BV + 10 位字母数字），整行就是它
const BV_SUBHEAD_RE = /^###[ \t]+BV[0-9A-Za-z]{10}[ \t]*$/

// 宿主写的那几个字段（`- 状态：待投递` / `- 草稿：…` / `- 采集：…`）——
// 认子块时靠它们跟"模型自己写的 `### BV号` 小节"分开：别人的小节通常写 `标题：` / `**档位**`，不会写这几个标签。
const QUEUE_FIELD_RE = /^- (状态|草稿|采集)[：:]/

/**
 * 第 i 行是不是「宿主那种 `### BV` 子块」：整行是 BV 标题，且下面那串 `- ` 字段里
 * **有宿主自己的标签**（状态 / 草稿 / 采集）。模型自己写的 `### BV号` 后面那串文字不算 ——
 * 宁可少认一节（多留一段旧内容，肉眼可见），也别把别人写的内容吞掉。
 */
function isHostSubhead(lines, i) {
  if (!BV_SUBHEAD_RE.test(lines[i].trimEnd())) return false
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]
    if (!line.trim()) continue
    if (!isBullet(line)) return false
    if (QUEUE_FIELD_RE.test(line)) return true
  }
  return false
}

export function replaceSect(cur, marker, block, { subheads = false } = {}) {
  const body = block.replace(/^\s*\n/, '').replace(/\s*$/, '')
  const lines = cur.split('\n')
  const keep = []
  let at = -1
  for (let i = 0; i < lines.length; i++) {
    if (!isHead(lines[i], marker)) { keep.push(lines[i]); continue }
    if (at < 0) at = keep.length
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    if (subheads) {
      // `# 标题` + 一串「### BV 子块 / - 字段行」，段落之间允许空行
      while (j < lines.length) {
        if (isBullet(lines[j])) { j++; continue }
        if (isHostSubhead(lines, j)) { j++; continue }
        if (!lines[j].trim()) {
          let k = j
          while (k < lines.length && !lines[k].trim()) k++
          if (k < lines.length && (isBullet(lines[k]) || isHostSubhead(lines, k))) { j = k; continue }
        }
        break
      }
    } else {
      while (j < lines.length && isBullet(lines[j])) j++
      while (j < lines.length && !lines[j].trim()) j++
    }
    i = j - 1
  }
  // 写完后文件尾总留一个空行：下一轮是直接往文件尾追加的，紧贴着写会连成同一个列表（文件尾是别的宿主节时也一样）
  if (at < 0) return cur.replace(/\s*$/, '') + '\n\n' + body + '\n\n'
  const before = keep.slice(0, at).join('\n').replace(/\s*$/, '')
  const after = keep.slice(at).join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '')
  return (before ? before + '\n\n' : '') + body + (after ? '\n\n' + after : '') + '\n\n'
}

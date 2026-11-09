/**
 * lib/persona.mjs —— 人设的**唯一**解析处（纯逻辑 + 可注入 IO）
 * ============================================================================
 * 工单 04（`.scratch/collect-deliver/issues/04-persona-and-boundaries.md`）：
 *   以前 `promptFor()` 和 `dmPromptFor()` 各写一遍人设解析，而且两处上限不一样
 *   （一处 40000、一处 4000，且私信那处不认路径）。现在收成这一处，三处出口共用：
 *
 *     ① 公开评论（`promptFor()` 拼的那一轮开场说明）
 *     ② 分享草稿（⭐ 06 票：写草稿时直接调 `personaForPrompt(cfg, io)`，别再抄一段）
 *     ③ 私信回复（`dmPromptFor()`）
 *
 * 输入顺序（保持兼容，老用户别断）：
 *   1. `cfg.personaPrompt` 填的文字 —— 原样当人设；
 *   2. 它只有一行、且**像路径**（Windows 盘符 / UNC / `~/` / POSIX 绝对路径）⇒ 读那个文件；
 *      传进来是目录 ⇒ 读目录里的 `AGENTS.md`；读不到 ⇒ 记一行日志，继续往下兜；
 *   3. 上面都没给出文字 ⇒ `cfg.workspace/AGENTS.md`（老用户只填过「工作区」的兜底）。
 *
 * 口径（只在这里定一套）：
 *   · 上限 `PERSONA_LIMIT = 40000` —— 三处出口同一个数；
 *   · 超长截断时**必须出声**：`io.log('…截掉 N 字')`，绝不静默吞掉；
 *   · 空 = 三个来源都没给出**非空白**文字（调用方据此关掉公开评论）。
 *
 * 返回值：
 *   {
 *     text,            // 真正要注入的人设文本（已 trim、已截断）
 *     from,            // 读自哪个文件（文字来源 = ''）
 *     truncated,       // 是否被截断
 *     originalLength,  // 截断前的有效长度
 *     limit,           // PERSONA_LIMIT
 *     source,          // 'text' | 'file' | 'workspace' | 'none'
 *   }
 *
 * IO 可注入（测试用）：`{ readFile, exists, isDirectory, env, log }`；
 * 不传就用 node:fs 与 process.env。纯逻辑不联网、不碰网络。
 * ============================================================================
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 三处出口共用的注入上限（字数） */
export const PERSONA_LIMIT = 40000

/**
 * 这一行字像不像一个路径（**只认单行**；多行一律当人设正文）。
 * 认：Windows 盘符（`C:\` / `C:/`）· UNC（`\\server\share`）· `~/` / `~\` · POSIX 绝对路径（`/...`）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikePersonaPath(value) {
  const s = String(value ?? '').trim()
  if (!s || /[\r\n]/.test(s)) return false
  if (/^[A-Za-z]:[\\/]/.test(s)) return true       // C:\dir / C:/dir
  if (/^\\\\/.test(s)) return true                 // \\server\share
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return true
  if (s.startsWith('/')) return true               // /home/… /Users/…
  return false
}

/** 把 `~/` / `~\` 展开成家目录；拿不到家目录就原样返回（读不到自然走兜底） */
function expandHome(raw, env) {
  const s = String(raw ?? '').trim()
  const home = String(env?.HOME || env?.USERPROFILE || '').trim()
  if (!home) return s
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(home, s.slice(2))
  return s
}

const defaultIO = {
  readFile: (file) => readFileSync(file, 'utf8'),
  exists: (file) => existsSync(file),
  isDirectory: (file) => {
    try { return statSync(file).isDirectory() } catch { return false }
  },
  env: process.env,
  // 没注入 log 时也别静默：默认往 stderr 说一声（宿主会传自己的 log，落到 duty.log）
  log: (msg) => { try { console.warn(String(msg)) } catch { /* 没有 console 就算了 */ } },
}

/**
 * 读出这一轮要用的人设。**从不抛**（读文件失败只记日志，然后继续兜底）。
 *
 * @param {{personaPrompt?: unknown, workspace?: unknown}} [cfg]
 * @param {{readFile?: Function, exists?: Function, isDirectory?: Function, env?: object, log?: Function}} [io]
 * @returns {{text: string, from: string, truncated: boolean, originalLength: number, limit: number, source: 'text'|'file'|'workspace'|'none'}}
 */
export function personaForPrompt(cfg = {}, io = {}) {
  const env = io.env ?? defaultIO.env
  const readFile = io.readFile ?? defaultIO.readFile
  const exists = io.exists ?? defaultIO.exists
  const isDirectory = io.isDirectory ?? defaultIO.isDirectory
  const log = typeof io.log === 'function' ? io.log : defaultIO.log

  const raw = String(cfg?.personaPrompt ?? '').trim()
  let text = ''
  let from = ''
  let source = 'none'

  try {
    if (raw) {
      if (!looksLikePersonaPath(raw)) {
        // ① 一段文字（最常见）：原样用
        text = raw
        source = 'text'
      } else {
        // ② 一个路径：文件就用它，目录就读里面的 AGENTS.md
        const expanded = expandHome(raw, env)
        let file = expanded
        try {
          if (isDirectory(file)) file = join(expanded, 'AGENTS.md')
          if (exists(file)) {
            text = String(readFile(file) ?? '').trim()
            if (text) { from = file; source = 'file' }
            else log('⚠️ 人设文件是空的：' + file)
          } else {
            log('⚠️ 人设路径不存在：' + file)
          }
        } catch (e) {
          log('⚠️ 读人设文件失败：' + file + '（' + String(e?.message ?? e) + '）')
        }
      }
    }
  } catch (e) {
    // 注入的 IO 自己炸了也不该让一整轮跑不起来
    log('⚠️ 解析人设失败：' + String(e?.message ?? e))
    text = ''
    from = ''
    source = 'none'
  }

  // ③ 老用户兜底：只填过「工作区」的，继续读那里的 AGENTS.md
  if (!text) {
    const ws = String(cfg?.workspace ?? '').trim()
    if (ws) {
      const file = join(ws, 'AGENTS.md')
      try {
        if (exists(file)) {
          const t = String(readFile(file) ?? '').trim()
          if (t) { text = t; from = file; source = 'workspace' }
        }
      } catch (e) {
        log('⚠️ 读取工作区的 AGENTS.md 失败：' + file + '（' + String(e?.message ?? e) + '）')
      }
    }
  }

  text = text.trim()
  const originalLength = text.length
  let truncated = false
  if (originalLength > PERSONA_LIMIT) {
    text = text.slice(0, PERSONA_LIMIT)
    truncated = true
    log('⚠️ 人设提示词 ' + originalLength + ' 字符，超过上限 ' + PERSONA_LIMIT
      + ' ⇒ 只送前 ' + PERSONA_LIMIT + '（截掉 ' + (originalLength - PERSONA_LIMIT) + ' 字）')
  }

  if (!text) return { text: '', from: '', truncated: false, originalLength: 0, limit: PERSONA_LIMIT, source: 'none' }
  return { text, from, truncated, originalLength, limit: PERSONA_LIMIT, source }
}

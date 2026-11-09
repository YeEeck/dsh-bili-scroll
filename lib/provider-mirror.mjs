/**
 * lib/provider-mirror.mjs —— 把主 profile 里配好的第三方 provider「定义那一段」抽出来
 * ============================================================================
 * 为什么要有它：采集轮跑在**另一个 profile**（默认 `bili-duty`，只有 dsh-base + dsh-headless），
 * 那里没有使用者自己在主 profile 里配的第三方 provider（`llm-pi-ai` 的 `config.providers`）。
 * 于是「在设置里钉一个第三方模型」永远只会 NO_ADAPTER —— 整轮白跑。
 *
 * 做法：每轮从主 profile 的组合配置文本里**只抽 `config.providers` 这一段**，原样注入值班轮的
 * `--patch` overlay。**不复制密钥**：`apiKeyEnv` 这类环境变量引用照原样搬；而一旦发现某个
 * provider 直接写了 `apiKey` / `token` / `secret` …的**值**，就**拒绝镜像那一个 provider**
 * 并给出可读原因（密钥不该被复制到第二个文件）。
 *
 * 输入是**文本**（主 profile 的 `cordis.patch.yml` / `cordis.yml` / `dsh --dump-config` 的输出
 * 都行），不引入 YAML 依赖：只做「按缩进切片」这一件足够稳的事，边界写在测试里。
 * ⚠️ 不解析 `!!js`，也不需要：原样搬运那段文本，值由 DSH 自己去求。
 *
 * 缓存：按**源文件 mtime + 大小**失效（主 profile 的配置改了，下一轮就重新抽）。
 *
 * 返回形状见各函数注释。解析层面**从不抛**（最外层 try/catch），失败以 `ok:false` + `error` 表达 ——
 * 镜像失败只该让这一轮少几个 provider，绝不该让 overlay 坏掉或插件不激活。
 * ============================================================================
 */
import { readFileSync, statSync } from 'node:fs'

/** 直接给值的敏感键（`apiKeyEnv` 不在这里 —— 它是引用，可以搬） */
const SECRET_KEY = /^(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|secret|client[-_]?secret|secret[-_]?key|access[-_]?key|private[-_]?key|password|passwd|credential|credentials|authorization|proxy[-_]?authorization)$/i

const indentOf = (line) => (/^[ \t]*/.exec(line) || [''])[0].length
const isBlank = (line) => !String(line || '').trim()
const isComment = (line) => /^\s*#/.test(line)

/** 去掉 YAML 单/双引号 */
function unquote(v) {
  const s = String(v ?? '').trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * 取一行「键: 值」的键与值（容忍列表前缀 `- ` 与引号）；不是键值行返回 null。
 * 故意写得**宽松**：按第一个冒号切，所以 `apiKey:sk-xxx` 这种没空格的写法也能认出来（判密钥宁可多认，也不漏）。
 */
function keyOf(line) {
  let t = String(line || '').trim()
  if (t.startsWith('- ')) t = t.slice(2).trim()
  if (!t || t.startsWith('#')) return null
  // 引号键：`"a b": …`
  const q = /^(?:"([^"]+)"|'([^']+)')\s*:(.*)$/.exec(t)
  if (q) {
    const key = (q[1] || q[2] || '').trim()
    return key ? { key, value: String(q[3] ?? '').trim() } : null
  }
  // 普通键：**按第一个冒号切**（不要求冒号后有空格）—— 判密钥时宁可多认一个，也不漏
  const i = t.indexOf(':')
  if (i <= 0) return null
  const key = t.slice(0, i).trim()
  if (!key || /\s/.test(key)) return null
  return { key, value: t.slice(i + 1).trim() }
}

/** 这个「值」算不算真的给了东西（空 / null / 纯注释都不算） */
function hasValue(v) {
  const s = String(v ?? '').trim()
  if (!s) return false
  if (s.startsWith('#')) return false
  if (s === '~' || /^null$/i.test(s)) return false
  if (s === '""' || s === "''") return false
  return true
}

/**
 * 在一个 provider 的定义块里找「内联密钥」。
 * 只看比 provider 键更深的行（`apiKeyEnv:` 这种引用键名不匹配 SECRET_KEY）。
 * 返回命中的键名（'' = 没命中）。
 */
function inlineSecretOf(blockLines, baseIndent) {
  for (let i = 1; i < blockLines.length; i++) {
    const line = blockLines[i]
    if (isBlank(line) || isComment(line)) continue
    if (indentOf(line) <= baseIndent) continue
    const kv = keyOf(line)
    if (!kv || !SECRET_KEY.test(kv.key)) continue
    if (hasValue(kv.value)) return kv.key
  }
  return ''
}

/**
 * 从某一条 entry 的文本范围里抽出 `config.providers` 那一段。
 * @returns {{providers: string[], block: string, rejected: {provider,key,reason}[], note: string}|null}
 *   null = 这条 entry 没有 `config.providers`
 */
function providersOfEntry(lines, start, end) {
  // `config:` 在 entry 内（缩进 > 0），下面找比它更深的 `providers:`
  let configIdx = -1
  let configIndent = -1
  for (let i = start; i < end; i++) {
    const line = lines[i]
    if (isBlank(line) || isComment(line)) continue
    const m = /^([ \t]+)config:\s*(?:#.*)?$/.exec(line)
    if (m) { configIdx = i; configIndent = m[1].length; break }
  }
  if (configIdx < 0) return null

  let pIdx = -1
  let pIndent = -1
  let inline = ''
  for (let i = configIdx + 1; i < end; i++) {
    const line = lines[i]
    if (isBlank(line) || isComment(line)) continue
    const ind = indentOf(line)
    if (ind <= configIndent) break                    // 走出了 config 这一块
    const m = /^([ \t]+)providers:\s*(.*)$/.exec(line)
    if (!m) continue
    pIdx = i
    pIndent = m[1].length
    inline = String(m[2] || '').trim()
    break
  }
  if (pIdx < 0) return null

  const empty = { providers: [], block: '', rejected: [], note: '' }
  // `providers: {}` / `providers: []` / 纯注释 ⇒ 有这一段，但是空的
  if (inline && !/^(?:\{\s*\}|\[\s*\]|#.*)$/.test(inline)) {
    return { ...empty, note: 'providers 写成了行内形式，没镜像（只认「providers:」下面一块）' }
  }
  if (inline) return empty

  // 值的范围：直到下一条缩进 <= providers 的**内容**行（空行 / 注释不终止）
  let spanEnd = end
  for (let i = pIdx + 1; i < end; i++) {
    const line = lines[i]
    if (isBlank(line) || isComment(line)) continue
    if (indentOf(line) <= pIndent) { spanEnd = i; break }
  }
  const content = []
  for (let i = pIdx + 1; i < spanEnd; i++) {
    const line = lines[i]
    if (isBlank(line) || isComment(line)) continue
    content.push({ i, indent: indentOf(line) })
  }
  if (!content.length) return empty

  const base = Math.min(...content.map((c) => c.indent))
  const starts = content.filter((c) => c.indent === base)
  const first = keyOf(lines[starts[0].i])
  if (!first) {
    return { ...empty, note: 'providers 不是「provider: {...}」这种映射写法，没镜像' }
  }

  const kept = []
  const providers = []
  const rejected = []
  for (let n = 0; n < starts.length; n++) {
    const st = starts[n].i
    const en = n + 1 < starts.length ? starts[n + 1].i : spanEnd
    const id = (keyOf(lines[st]) || {}).key || ''
    if (!id) continue
    const block = lines.slice(st, en)
    const secret = inlineSecretOf(block, base)
    if (secret) {
      rejected.push({
        provider: id,
        key: secret,
        reason: `provider "${id}" 里有内联密钥（"${secret}" 直接写了值）；密钥不复制进值班轮的 overlay —— 请改成 apiKeyEnv 引用环境变量`,
      })
      continue
    }
    providers.push(id)
    kept.push(...block)
  }

  const body = kept.map((line) => (isBlank(line) ? '' : '  ' + line.slice(base)))
  return {
    providers,
    block: body.length ? ['providers:', ...body].join('\n').replace(/\n+$/, '') : '',
    rejected,
    note: '',
  }
}

/**
 * 解析一段配置文本，只抽出「带 `config.providers` 的条目」（其余条目、注释一律忽略）。
 * 纯函数、不碰磁盘；不抛。
 *
 * @param {string} text 主 profile 的 patch / cordis.yml / --dump-config 输出
 * @returns {{
 *   ok: boolean,
 *   entries: Array<{id: string, name: string, providers: string[], block: string,
 *                   rejected: Array<{provider: string, key: string, reason: string}>, note: string}>,
 *   providers: string[],       // 所有条目里真正会镜像的 provider（去重、按出现顺序）
 *   rejected: Array<{entryId: string, provider: string, key: string, reason: string}>,
 *   notes: string[],
 *   error: string,
 * }}
 */
export function mirrorProviders(text) {
  const out = { ok: true, entries: [], providers: [], rejected: [], notes: [], error: '' }
  try {
    let src = String(text ?? '')
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
    const lines = src.split(/\r?\n/)

    // entry 边界 = 顶格的 `- `（块状标量的内容一定缩进，不会顶格）
    const starts = []
    for (let i = 0; i < lines.length; i++) {
      if (/^-[ \t]/.test(lines[i]) || /^-$/.test(lines[i])) starts.push(i)
    }

    for (let n = 0; n < starts.length; n++) {
      const start = starts[n]
      const end = n + 1 < starts.length ? starts[n + 1] : lines.length
      // id / name 只在这条 entry **自己的**键上找（`- id: x` 或下面缩进两格的 `  id: x`）——
      // 嵌套的 `    - id: …`（insert 列表里的新条目）不算，否则会把别人的 id 当成自己的
      let id = ''
      let name = ''
      for (let i = start; i < Math.min(end, start + 6); i++) {
        const first = i === start
        const line = lines[i]
        if (!first && indentOf(line) > 2) continue
        const t = first ? (line.trim().startsWith('#') ? '' : line.trim()) : line.trim()
        if (!t || t.startsWith('#')) continue
        if (!id) {
          const m = /^(?:-\s*)?id:\s*(.+)$/.exec(t)
          if (m) id = unquote(m[1])
        }
        if (!name) {
          const m = /^(?:-\s*)?name:\s*(.+)$/.exec(t)
          if (m) name = unquote(m[1])
        }
      }
      const sec = providersOfEntry(lines, start, end)
      if (!sec) continue
      // 没有 id 的条目（比如 `- insert:` 里塞进来的新插件）没法按 id 补进值班 profile 的同一位置 ⇒ 不镜像，
      // 也不把它算进「这一轮可用」—— 说一句实话，别让设置页列一个其实补不过去的 provider。
      if (!id) {
        out.notes.push('(没有 id 的条目): 只能在主 profile 里生效，没法按 id 镜像进值班 profile')
        continue
      }
      out.entries.push({ id, name, ...sec })
      for (const p of sec.providers) if (!out.providers.includes(p)) out.providers.push(p)
      for (const r of sec.rejected) out.rejected.push({ entryId: id, ...r })
      if (sec.note) out.notes.push(`${id || '(没有 id 的条目)'}: ${sec.note}`)
    }
  } catch (e) {
    out.ok = false
    out.error = String(e?.message ?? e)
  }
  return out
}

/**
 * 源文件签名：路径 + mtime + 大小。读不到的按 `missing` 记 ——
 * 文件后来出现了，签名也会变（= 下一轮重新抽）。
 */
export function mirrorSourceKey(files, stat = statSync) {
  return (files || []).map((f) => {
    try {
      const s = stat(f)
      return `${f}@${Math.round(Number(s.mtimeMs) || 0)}:${Number(s.size) || 0}`
    } catch {
      return `${f}@missing`
    }
  }).join('|')
}

/** 极小的按 key 缓存（键 = mirrorSourceKey；命中就返回上一次的结果） */
export function createMirrorCache() {
  let key = null
  let value = null
  return {
    key: () => key,
    get(k) { return k === key ? value : null },
    set(k, v) { key = k; value = v },
    clear() { key = null; value = null },
  }
}

/**
 * 读主 profile 的配置并抽 provider；同样输入（同 mtime）直接走缓存。
 *
 * `files` **按优先级排**：`cordis.patch.yml` 在前、`cordis.yml` 在后。
 * 取第一份「有 config.providers 条目」的；都没有就取第一份能读到的（结果为空）。
 *
 * @returns 同 mirrorProviders，另加 { key, files, from }
 */
export function mirrorMainProfile(files, cache = null, io = {}) {
  const stat = io.stat || statSync
  const read = io.read || readFileSync
  const list = [...new Set((files || []).filter(Boolean).map(String))]
  const key = mirrorSourceKey(list, stat)
  if (cache) {
    const hit = cache.get(key)
    if (hit) return hit
  }
  const out = {
    ok: true, entries: [], providers: [], rejected: [], notes: [], error: '',
    key, files: list, from: '',
  }
  const sources = []
  const errs = []
  for (const f of list) {
    try {
      sources.push({ path: f, text: String(read(f, 'utf8') ?? '') })
    } catch (e) {
      errs.push(`${f}: ${e?.code || e?.message || e}`)
    }
  }
  if (!sources.length) {
    out.ok = false
    out.error = errs.length ? `读不到主 profile 的配置（${errs.join('；')}）` : '没找到主 profile 的配置文件'
    cache?.set?.(key, out)
    return out
  }

  // 按优先级找第一份「有 config.providers 条目」的；都没有就用第一份解析成功的（结果为空）
  let picked = null
  let parsed = null
  let firstOk = null
  for (const s of sources) {
    const r = mirrorProviders(s.text)
    if (!r.ok) { out.notes.push(`${s.path}: ${r.error}`); continue }
    if (!firstOk) firstOk = { picked: s, parsed: r }
    if (r.entries.length) { picked = s; parsed = r; break }
  }
  if (!parsed && firstOk) { picked = firstOk.picked; parsed = firstOk.parsed }
  if (!parsed) {
    out.ok = false
    out.error = `配置解析失败：${out.notes.join('；') || '未知原因'}`
  } else {
    out.entries = parsed.entries
    out.providers = parsed.providers
    out.rejected = parsed.rejected
    out.notes = out.notes.concat(parsed.notes)
    out.from = picked.path
  }
  cache?.set?.(key, out)
  return out
}

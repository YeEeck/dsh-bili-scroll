// node --test test/
// provider 镜像解析（纯模块）：用真实形状的组合配置文本做 fixture。
// 只断言外部可观察的结果：抽出了哪些条目 / 哪些 provider、内联密钥被拒、没有该段返回空、mtime 缓存失效。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mirrorProviders, mirrorMainProfile, mirrorSourceKey, createMirrorCache,
} from '../lib/provider-mirror.mjs'

/** 和本机 `~/.dsh/profiles/web/cordis.patch.yml` 同形状（密钥全是 apiKeyEnv 引用） */
const REAL_SHAPE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      lm-studio-wr:
        apiKeyEnv: LM_STUDIO_WR_API_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:41234/v1
        models:
          - id: qwen3.8-27b
            name: qwen3.8-27b
            contextWindow: 128000
            maxTokens: 64000
            reasoningEfforts:
              off: null
              low: low
              high: high
      ocg-1:
        apiKeyEnv: OCG_1_API_KEY
        api: openai-completions
        baseURL: !!js dshHomePath('tmp') + '/v1'
        headers:
          X-Client: 'bili-scroll'
        retryPolicy:
          mode: normal
          maxRetries: 4
        models:
          - id: deepseek-v4.1-flash
            input:
              - text
              - image
# 下面这条和 provider 无关，不该被抽走
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ocg-1
    model: deepseek-v4.1-flash
`

test('真实形状：只抽带 config.providers 的条目，provider 与内容都原样保留', () => {
  const r = mirrorProviders(REAL_SHAPE)
  assert.equal(r.ok, true)
  assert.equal(r.error, '')
  assert.equal(r.entries.length, 1)
  const e = r.entries[0]
  assert.equal(e.id, 'llm-pi-ai')
  assert.equal(e.name, '@deepseek-ai/dsh-llm-pi-ai')
  assert.deepEqual(e.providers, ['lm-studio-wr', 'ocg-1'])
  assert.deepEqual(r.providers, ['lm-studio-wr', 'ocg-1'])
  assert.deepEqual(r.rejected, [])
  // 只搬 providers：别的条目一个字段都不许漏进来
  assert.ok(!e.block.includes('ui-settings-general'))
  assert.ok(!e.block.includes('agent-default-model'))
  assert.ok(!e.block.includes('welcomeNoticeVersion'))
  // 定义本身要完整（apiKeyEnv 引用、baseURL、models、retryPolicy 都在）
  assert.ok(e.block.startsWith('providers:\n  lm-studio-wr:\n'))
  for (const s of ['apiKeyEnv: LM_STUDIO_WR_API_KEY', 'api: openai-responses',
    'baseURL: http://127.0.0.1:41234/v1', 'models:', '- id: qwen3.8-27b',
    'reasoningEfforts:', 'retryPolicy:', 'maxRetries: 4']) {
    assert.ok(e.block.includes(s), '缺了：' + s)
  }
  // `!!js` 不求值、原样搬（值由 DSH 自己算）
  assert.ok(e.block.includes("baseURL: !!js dshHomePath('tmp') + '/v1'"))
})

test('输出的块缩进规整：领域键在 0，provider 在 2，更深的内容相对保留', () => {
  const e = mirrorProviders(REAL_SHAPE).entries[0]
  const lines = e.block.split('\n')
  assert.equal(lines[0], 'providers:')
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    assert.ok(line.startsWith('  '), '这一行缩进不对：' + JSON.stringify(line))
  }
  const providerLines = lines.filter((l) => /^ {2}[\w"'-][^:\n]*:\s*$/.test(l))
  assert.deepEqual(providerLines.map((l) => l.trim().replace(/:$/, '')), ['lm-studio-wr', 'ocg-1'])
  // 块里没有顶格的 YAML 条目（否则拼进 overlay 会多出一条 patch）
  assert.ok(!lines.slice(1).some((l) => /^-[ \t]/.test(l)))
})

test('内联密钥 ⇒ 拒绝镜像那一个 provider，其余照常；原因可读、密钥不进结果', () => {
  const r = mirrorProviders(`- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      safe:
        apiKeyEnv: SAFE_KEY
        models:
          - id: m1
      danger:
        apiKey: "sk-this-must-not-be-copied"
        baseURL: https://example.invalid/v1
`)
  assert.equal(r.ok, true)
  assert.deepEqual(r.providers, ['safe'])
  assert.deepEqual(r.entries[0].providers, ['safe'])
  assert.ok(!r.entries[0].block.includes('danger'))
  assert.ok(!r.entries[0].block.includes('sk-this-must-not-be-copied'))
  assert.equal(r.rejected.length, 1)
  assert.equal(r.rejected[0].entryId, 'llm-pi-ai')
  assert.equal(r.rejected[0].provider, 'danger')
  assert.equal(r.rejected[0].key, 'apiKey')
  assert.match(r.rejected[0].reason, /内联密钥/)
  assert.match(r.rejected[0].reason, /apiKeyEnv/)
  assert.ok(!r.rejected[0].reason.includes('sk-this-must-not-be-copied'), '原因里不该出现密钥本身')
})

test('token / secret / password / 嵌套 Authorization 都算内联密钥；apiKeyEnv 与空值不算', () => {
  const r = mirrorProviders(`- id: llm-pi-ai
  config:
    providers:
      t:
        token: abc123
      s:
        clientSecret: sec
      p:
        password: 123456
      auth:
        headers:
          Authorization: "Bearer zzz"
      env-ok:
        apiKeyEnv: OK_KEY
      empty-ok:
        apiKey:
      quoted-empty-ok:
        secret: ""
      null-ok:
        token: null
`)
  assert.deepEqual(r.providers, ['env-ok', 'empty-ok', 'quoted-empty-ok', 'null-ok'])
  assert.deepEqual(r.rejected.map((x) => x.provider), ['t', 's', 'p', 'auth'])
  // 冒号后不带空格的写法也认（YAML 里这其实是标量，但判密钥时宁可多认）
  const compact = mirrorProviders(`- id: x
  config:
    providers:
      compact:
        apiKey:sk-compact
`)
  assert.deepEqual(compact.providers, [])
  assert.equal(compact.rejected[0].key, 'apiKey')
})

test('没有 config.providers 那段 ⇒ 空结果（overlay 保持原样，不报错）', () => {
  for (const text of [
    '',
    '[]\n',
    '# 只有注释\n',
    `- id: permission
  config:
    presets: {}
- id: agent-default-model
  config:
    provider: deepseek-account
`,
  ]) {
    const r = mirrorProviders(text)
    assert.equal(r.ok, true)
    assert.deepEqual(r.entries, [])
    assert.deepEqual(r.providers, [])
    assert.deepEqual(r.rejected, [])
    assert.equal(r.error, '')
  }
})

test('注释、缩进里的 !!js、引号 provider 名都不破坏提取', () => {
  const r = mirrorProviders(`# 顶格注释
- id: llm-pi-ai
  # 条目里的注释
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    # config 里的注释
    providers:
      "quoted provider":
        apiKeyEnv: Q_KEY
        # provider 里的注释
        baseURL: !!js 'http://' + dshHomePath('gw')
        models:
          - id: m1
            effort: !!js 'high'
- id: tail
  config: {}
`)
  assert.equal(r.entries.length, 1)
  assert.deepEqual(r.providers, ['quoted provider'])
  assert.ok(r.entries[0].block.includes('"quoted provider":'))
  assert.ok(r.entries[0].block.includes("baseURL: !!js 'http://' + dshHomePath('gw')"))
  assert.ok(!r.entries[0].block.includes('tail'))
})

test('多条 entry 都有 providers ⇒ 都抽出来（各自一个块）', () => {
  const r = mirrorProviders(`- id: llm-pi-ai
  config:
    providers:
      a:
        apiKeyEnv: A
- id: llm-other
  config:
    providers:
      b:
        apiKeyEnv: B
`)
  assert.deepEqual(r.entries.map((e) => e.id), ['llm-pi-ai', 'llm-other'])
  assert.deepEqual(r.providers, ['a', 'b'])
  assert.ok(r.entries[0].block.includes('a:'))
  assert.ok(r.entries[1].block.includes('b:'))
})

test('providers 写成行内形式：空的算空段，非空的给一句可读说明、不硬解析', () => {
  const empty = mirrorProviders(`- id: llm-pi-ai
  config:
    providers: {}
`)
  assert.equal(empty.entries.length, 1)
  assert.deepEqual(empty.providers, [])
  assert.equal(empty.entries[0].note, '')

  const inline = mirrorProviders(`- id: llm-pi-ai
  config:
    providers: { a: { apiKeyEnv: A } }
`)
  assert.deepEqual(inline.providers, [])
  assert.match(inline.entries[0].note, /行内形式/)
  assert.ok(inline.notes[0].includes('llm-pi-ai'))
})

test('CRLF 配置照样抽，输出的块用 \\n', () => {
  const text = REAL_SHAPE.replace(/\n/g, '\r\n')
  const r = mirrorProviders(text)
  assert.deepEqual(r.providers, ['lm-studio-wr', 'ocg-1'])
  assert.ok(!r.entries[0].block.includes('\r'))
  assert.ok(r.entries[0].block.startsWith('providers:\n  lm-studio-wr:\n'))
})

// ── 按文件 mtime 缓存（主 profile 的配置改了，下一轮才重新抽）────────────────

const root = mkdtempSync(join(tmpdir(), 'bili-mirror-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const providerText = (name) => `- id: llm-pi-ai
  config:
    providers:
      ${name}:
        apiKeyEnv: KEY_${name.toUpperCase()}
`
const touch = (file, ms) => utimesSync(file, new Date(ms), new Date(ms))

test('mirrorSourceKey：mtime 或大小变了就换 key；文件后来才出现也算变', () => {
  const f = join(root, 'key.yml')
  const t0 = Date.now() - 60_000
  writeFileSync(f, providerText('alpha'))
  touch(f, t0)
  const k0 = mirrorSourceKey([f])
  assert.ok(k0.includes(f) && k0.includes(String(Math.round(t0))))
  // 同样 mtime / 大小 ⇒ 同一个 key（缓存命中）
  touch(f, t0)
  assert.equal(mirrorSourceKey([f]), k0)
  // mtime 前进 ⇒ key 变
  touch(f, t0 + 5000)
  assert.notEqual(mirrorSourceKey([f]), k0)
  // 不存在的文件也进 key（从 missing 变成有 ⇒ 变）
  const missing = join(root, 'not-yet.yml')
  const km = mirrorSourceKey([missing])
  assert.ok(km.includes('@missing'))
  writeFileSync(missing, providerText('bravo'))
  assert.notEqual(mirrorSourceKey([missing]), km)
})

test('mirrorMainProfile：同样 mtime 走缓存（不重新读），mtime 一变下一轮就拿到新 provider', () => {
  const f = join(root, 'cache.yml')
  const t0 = Date.now() - 30_000
  writeFileSync(f, providerText('alpha'))       // 名字长度一样 ⇒ 大小也一样，只有 mtime 能区分
  touch(f, t0)
  const cache = createMirrorCache()
  const first = mirrorMainProfile([f], cache)
  assert.deepEqual(first.providers, ['alpha'])
  assert.equal(first.from, f)

  // 内容换了但 mtime 被摁回原样 ⇒ 同一个 key ⇒ 命中缓存（这正是"按 mtime 失效"的含义）
  writeFileSync(f, providerText('bravo'))
  touch(f, t0)
  const hit = mirrorMainProfile([f], cache)
  assert.equal(hit, first, '同样输入应该拿到缓存里的同一个结果')

  // mtime 前进 ⇒ 重新读，新 provider 生效
  touch(f, t0 + 5000)
  const next = mirrorMainProfile([f], cache)
  assert.notEqual(next, first)
  assert.deepEqual(next.providers, ['bravo'])
})

test('cordis.patch.yml 优先；它没有 providers 时才退到 cordis.yml', () => {
  const patch = join(root, 'cordis.patch.yml')
  const rootCfg = join(root, 'cordis.yml')
  writeFileSync(rootCfg, providerText('from-cordis-yml'))
  writeFileSync(patch, `- id: ui-settings
  config:
    x: 1
`)
  const fallback = mirrorMainProfile([patch, rootCfg], null)
  assert.equal(fallback.from, rootCfg)
  assert.deepEqual(fallback.providers, ['from-cordis-yml'])

  writeFileSync(patch, providerText('from-patch'))
  const preferred = mirrorMainProfile([patch, rootCfg], null)
  assert.equal(preferred.from, patch)
  assert.deepEqual(preferred.providers, ['from-patch'])
})

test('两个文件都读不到 ⇒ ok:false + 可读原因（且会被缓存，不反复抛）', () => {
  const a = join(root, 'nope-a.yml')
  const b = join(root, 'nope-b.yml')
  const cache = createMirrorCache()
  const r = mirrorMainProfile([a, b], cache)
  assert.equal(r.ok, false)
  assert.match(r.error, /读不到主 profile 的配置/)
  assert.ok(r.error.includes(a))
  assert.equal(mirrorMainProfile([a, b], cache), r)
})

test('cache 基本语义：get/set/clear', () => {
  const c = createMirrorCache()
  assert.equal(c.get('k'), null)
  c.set('k', { ok: true })
  assert.deepEqual(c.get('k'), { ok: true })
  assert.equal(c.get('other'), null)
  c.set('k2', { ok: false })
  assert.equal(c.get('k'), null, '只缓存最近一个 key')
  assert.deepEqual(c.get('k2'), { ok: false })
  c.clear()
  assert.equal(c.get('k'), null)
  assert.equal(mirrorSourceKey([]), '')
})

test('没有 id 的条目（`- insert:` 塞进来的插件）没法按 id 补进去 ⇒ 不镜像、也不算可用', () => {
  const r = mirrorProviders(`- insert:
    - id: llm-inside
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          inner:
            apiKeyEnv: INNER_KEY
- id: llm-pi-ai
  config:
    providers:
      outer:
        apiKeyEnv: OUTER_KEY
`)
  assert.deepEqual(r.entries.map((e) => e.id), ['llm-pi-ai'])
  assert.deepEqual(r.providers, ['outer'])
  assert.ok(r.notes.some((n) => /没有 id/.test(n)))
})

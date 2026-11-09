// node --test test/
// 桩宿主端到端（参照 duty-rounds 的假 ctx + 假 dsh + 临时 DSH_HOME；不联网、不碰真实 ~/.dsh）：
//   · 主 profile 的 cordis.patch.yml 里配了 provider ⇒ 跑一轮时生成的 headless-overlay.yml 里带上它
//   · 改主 profile 配置（mtime 前进）⇒ 再跑一轮，新 provider 生效
//   · 内联密钥的 provider 不被镜像 ⇒ duty.log、/status、/models 里都有可读原因
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'bili-mirror-host-'))
// 只在 import 期间换 DSH_HOME：别让 hostdeps / 插件去翻这台机器真实的 ~/.dsh
const realDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
})

// 假 dsh：这一轮什么也不干，立刻成功退出（我们只关心起它之前写好的 overlay）
const fakeDsh = join(root, 'fake-dsh.mjs')
writeFileSync(fakeDsh, 'process.exit(0)\n')

const disposers = []
after(() => {
  for (const d of disposers) { try { d() } catch { /* 收摊 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** 一份真实形状的主 profile patch：`llm-pi-ai` 的 config.providers 就是我们要镜像的那一段 */
const patchWith = (...blocks) => `# 主 profile 的 patch 层（测试合成）
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
${blocks.join('\n')}
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
`
const providerBlock = (name, extra = '') => `      ${name}:
        apiKeyEnv: ${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY
        api: openai-completions
        baseURL: https://example.invalid/v1
        models:
          - id: ${name}-model
            name: ${name}-model
${extra}`

function startHost() {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  const webDir = join(home, 'profiles', 'web')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  mkdirSync(webDir, { recursive: true })
  const patchFile = join(webDir, 'cordis.patch.yml')
  writeFileSync(patchFile, patchWith(providerBlock('first-provider')))
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    dshBin: fakeDsh, dmWatch: false, dmUid: 12345, manualCooldownMin: 0,
  }))
  let handler = null
  // 主 profile 的 llm 服务（桩）：provider 列表 + 每个的模型；`no-models` 用来测「列不出模型」那条路
  const fakeLlm = {
    listProviders: () => [
      { id: 'deepseek-account', name: 'DeepSeek（账号登录）' },
      { id: 'deepseek-official', name: 'DeepSeek（API key）' },
      { id: 'first-provider', name: 'First' },
      { id: 'second-provider', name: 'Second' },
      { id: 'leaky-provider', name: 'Leaky' },
      { id: 'not-in-main', name: 'Not in main' },
      { id: 'no-models', name: 'No models' },
    ],
    listModels: (id) => Promise.resolve(id === 'no-models' ? [] : [{ id: id + '-model', name: id + '-model' }]),
  }
  apply({
    get: (k) => {
      if (k === 'dshHomePath') return (...seg) => join(home, ...seg)
      // 真实宿主（DSH 0.2.x）就是这么 provide 的：name / dir / patchPath
      if (k === 'profileContext') return { name: 'web', dir: webDir, patchPath: patchFile, home }
      if (k === 'llm') return fakeLlm
      return undefined
    },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})
  const call = (method, path) => new Promise((resolve, reject) => {
    const req = { method, url: path, headers: {}, on: (ev, cb) => { if (ev === 'end') cb() } }
    handler(req, { writeHead: () => {}, end: (s) => resolve(JSON.parse(s)) }).catch(reject)
  })
  const logFile = join(stateDir, 'duty.log')
  const logText = () => { try { return readFileSync(logFile, 'utf8') } catch { return '' } }
  const roundsDone = () => logText().split('刷B站结束（').length - 1
  const overlayFile = join(stateDir, 'headless-overlay.yml')
  const overlay = () => readFileSync(overlayFile, 'utf8')
  return {
    stateDir,
    patchFile,
    overlay,
    logText,
    setPatch: (text, mtimeMs) => {
      writeFileSync(patchFile, text)
      if (mtimeMs) utimesSync(patchFile, new Date(mtimeMs), new Date(mtimeMs))
    },
    status: () => call('GET', '/api/bili-duty/status'),
    models: () => call('GET', '/api/bili-duty/models'),
    /** 跑一轮：等子进程退出处理（写日志「刷B站结束」）跑完才返回 */
    async round() {
      const before = roundsDone()
      const r = await call('POST', '/api/bili-duty/run')
      assert.equal(r.started, true, JSON.stringify(r))
      const deadline = Date.now() + 30_000
      while (roundsDone() === before) {
        assert.ok(Date.now() < deadline, '这一轮 30 秒还没结束')
        await new Promise((f) => setTimeout(f, 20))
      }
    },
  }
}

test('主 profile 的 provider 定义会进值班轮的 overlay；改配置（mtime 变）后下一轮生效', async () => {
  const h = startHost()

  await h.round()
  const ov1 = h.overlay()
  assert.match(ov1, /^- id: llm-pi-ai$/m, '要按 id 补进值班 profile 已有的那条 entry')
  assert.match(ov1, /^    providers:$/m)
  assert.match(ov1, /^ {6}first-provider:$/m)
  assert.match(ov1, /apiKeyEnv: FIRST_PROVIDER_API_KEY/, 'apiKeyEnv 引用照原样搬，不解析成密钥')
  assert.match(ov1, /- id: first-provider-model/, 'models 那一段也要完整')
  assert.ok(!ov1.includes('welcomeNoticeVersion'), '别的条目一个字都不许漏进 overlay')
  assert.ok(!ov1.includes('sk-'), '不该出现任何密钥')
  assert.match(h.logText(), /模型镜像：从 .*cordis\.patch\.yml 抽到 1 个 provider（first-provider）/)

  // 主 profile 改配置：换个 provider（顺便把 mtime 推到未来，确保缓存一定失效）
  h.setPatch(patchWith(providerBlock('second-provider', '        timeoutMs: 30000\n')), Date.now() + 5000)
  await h.round()
  const ov2 = h.overlay()
  assert.match(ov2, /^ {6}second-provider:$/m)
  assert.match(ov2, /timeoutMs: 30000/)
  assert.ok(!ov2.includes('first-provider:'), '旧 provider 不该还在')
  assert.match(h.logText(), /second-provider/)

  // 再改一次：一个新的 + 一个含内联密钥的 ⇒ 只镜像安全的那个，且原因写进日志与 /status、/models
  h.setPatch(patchWith(
    providerBlock('second-provider'),
    providerBlock('leaky-provider', '        apiKey: "sk-should-not-be-copied"\n'),
  ), Date.now() + 10_000)
  await h.round()
  const ov3 = h.overlay()
  assert.match(ov3, /^ {6}second-provider:$/m)
  assert.ok(!ov3.includes('leaky-provider'), '含内联密钥的 provider 整个不许镜像')
  assert.ok(!ov3.includes('sk-should-not-be-copied'), '密钥一个字符都不许进 overlay')
  assert.match(h.logText(), /模型镜像：跳过 llm-pi-ai \/ leaky-provider/)
  assert.match(h.logText(), /内联密钥/)

  const st = await h.status()
  assert.equal(st.ok, true)
  assert.deepEqual(st.modelMirror.providers, ['second-provider'])
  assert.equal(st.modelMirror.ok, true)
  assert.equal(st.modelMirror.from, h.patchFile)
  assert.equal(st.modelMirror.rejected.length, 1)
  assert.equal(st.modelMirror.rejected[0].provider, 'leaky-provider')
  assert.match(st.modelMirror.rejected[0].reason, /apiKeyEnv/)

  const cat = await h.models()
  assert.equal(cat.ok, true)
  assert.deepEqual(cat.usable, ['deepseek-account', 'deepseek-official', 'second-provider'])
  assert.deepEqual(cat.mirror.providers, ['second-provider'])
  assert.equal(cat.mirror.rejected[0].provider, 'leaky-provider')
  // 可用的显示可用；不可用的写清原因（主 profile 没配 / 含内联密钥被拒）
  const byId = Object.fromEntries(cat.providers.map((p) => [p.id, p]))
  assert.equal(byId['deepseek-account'].usable, 'yes')
  assert.equal(byId['second-provider'].usable, 'yes')
  assert.equal(byId['first-provider'].usable, 'no')
  assert.match(byId['first-provider'].why, /主 profile 里配了别的 provider，但没有它/)
  assert.equal(byId['leaky-provider'].usable, 'no')
  assert.match(byId['leaky-provider'].why, /内联密钥/)
  assert.equal(byId['not-in-main'].usable, 'no')
  assert.deepEqual(cat.unavailable.map((u) => u.id), ['no-models'])
  assert.match(cat.unavailable[0].why, /没有它|没配这个 provider/)
})

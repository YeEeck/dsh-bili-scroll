// node --test
// 2026-11-10：会话头「刷过的视频」tab 的显示开关（配置项 showWatchTab）—— 桩宿主端到端。
// 真 import index.js、假 ctx / webServer / workspaceRegistry、临时家目录、**不联网**。
// 只断言外部可观察的东西：/session-scope 的返回、/status.config、config.json 落盘。
//
// 这里刻意**不测浏览器半端**（client.js 的探针在浏览器 bundle 里，没有 DOM 测试环境）：
// 客户端那一侧的契约由 test/settings-fields.test.mjs 的文本断言兜住（字段名两端都在）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DSH_HOME 只在 import 期间用（lib/hostdeps.mjs 找宿主包）；之后的路径都走假 ctx 的 dshHomePath
const importHome = mkdtempSync(join(tmpdir(), 'bili-watch-tab-import-'))
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = importHome
const { apply } = await import('../index.js').finally(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
})

const hosts = []
after(() => {
  for (const h of hosts) h.dispose()
  for (const h of hosts) rmSync(h.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(importHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/**
 * 起一个插件实例（只驱动 HTTP 路由，不起任何一轮）。
 * @param {{cfg?: object, sessions?: string[]}} opts sessions = 工作区里认得的会话 id
 */
function startHost({ cfg = {}, sessions = ['s1'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bili-watch-tab-'))
  const home = join(root, 'home')
  const stateDir = join(home, 'bili-duty')
  const workspace = join(root, 'ws')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    pythonPath: process.execPath,
    dmWatch: false,
    dmUid: 12345,
    // 这个测试不碰投递 / 采集：默认关掉两条时钟的入口，免得启动时那一跳插进来
    channelDm: false,
    collectTimes: [],
    deliverPerDay: 0,
    workspace,
    ...cfg,
  }))

  const registry = {
    list: () => [{ id: 'w1', path: workspace, title: '测试工作区', sessionIds: sessions }],
  }

  let handler = null
  const disposers = []
  apply({
    get: (k) => {
      if (k === 'dshHomePath') return (...seg) => join(home, ...seg)
      if (k === 'workspaceRegistry') return registry
      return undefined
    },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})

  const request = (method, path, body) => new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    const req = {
      method,
      url: path,
      headers: {},
      on(ev, cb) {
        if (ev === 'data' && text) cb(Buffer.from(text))
        if (ev === 'end') cb()
        return req
      },
    }
    const res = {
      writeHead(code) { res.statusCode = code },
      end(payload) {
        try { resolve(JSON.parse(payload)) } catch (e) { reject(e) }
      },
    }
    if (!handler) { reject(new Error('HTTP 路由没挂上')); return }
    handler(req, res).catch(reject)
  })

  const h = {
    root,
    stateDir,
    workspace,
    call: request,
    scope: (sid) => request('GET', '/api/bili-duty/session-scope?session=' + encodeURIComponent(sid)),
    status: () => request('GET', '/api/bili-duty/status'),
    config: (patch) => request('POST', '/api/bili-duty/config', patch),
    dispose: () => { for (const d of disposers) { try { d() } catch { /* 收摊 */ } } },
  }
  hosts.push(h)
  return h
}

/* ───────────── ① 默认开：工作区范围照旧，开关单独一个字段 ───────────── */

test('默认开：工作区匹配的会话 match=true / showWatchTab=true；不匹配的会话只影响 match', async () => {
  const h = startHost()

  const s1 = await h.scope('s1')
  assert.equal(s1.ok, true, JSON.stringify(s1))
  assert.equal(s1.match, true, 's1 在工作区里')
  assert.equal(s1.showWatchTab, true, '没配过 = 默认开')

  const s2 = await h.scope('s2')
  assert.equal(s2.match, false, 's2 不在工作区里')
  assert.equal(s2.showWatchTab, true, '工作区范围与开关是两道闸 —— match=false 不该改写开关值')

  const st = await h.status()
  assert.equal(st.config.showWatchTab, true, '/status 也要能读到默认值（设置页按它渲染开关）')
})

/* ───────────── ② 关掉：落盘 + 两个接口一起变，match 不动 ───────────── */

test('POST /config 关掉：config.json 落盘、/status 与 /session-scope 都变 false，match 不变', async () => {
  const h = startHost()

  const r = await h.config({ showWatchTab: false })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.config.showWatchTab, false, '保存响应里就要是新值')

  const saved = JSON.parse(readFileSync(join(h.stateDir, 'config.json'), 'utf8'))
  assert.equal(saved.showWatchTab, false, '要真的写进插件自己的 config.json')
  assert.ok(Array.isArray(saved._set) && saved._set.includes('showWatchTab'), '要记进 _set（重启后仍然是插件这份说了算）')

  const s1 = await h.scope('s1')
  assert.equal(s1.match, true, '关开关不改写工作区匹配')
  assert.equal(s1.showWatchTab, false, '客户端据此不再注册那个 view')

  const s2 = await h.scope('s2')
  assert.equal(s2.match, false)
  assert.equal(s2.showWatchTab, false, '两道闸各自独立：不匹配 + 关掉')

  assert.equal((await h.status()).config.showWatchTab, false)
})

// node --test test/
// 工单 07 的桩宿主端到端：真 import index.js、假 ctx、假 dsh —— **不联网、不碰真实 ~/.dsh**。
// 只断言外部可观察的东西：通知文件、日报的「通知」小节、duty.log、/status.notifications。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-notify-'))
// DSH_HOME 只在 import 期间用（hostdeps 找宿主包）；之后的路径都走假 ctx 的 dshHomePath
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
})

// 假 dsh：exit 1 = 采集失败；exit 0 = 正常结束（这一轮没找到值得的）
const fakeFail = join(root, 'fake-dsh-fail.mjs')
writeFileSync(fakeFail, 'process.exit(1)\n')
const fakeOk = join(root, 'fake-dsh-ok.mjs')
writeFileSync(fakeOk, 'process.exit(0)\n')

const strayFetches = []
globalThis.fetch = async (url) => {
  strayFetches.push(String(url))
  throw new Error('这个测试不该联网：' + String(url))
}

const disposers = []
const hosts = []
after(() => {
  for (const h of hosts) h.dispose()
  for (const d of disposers) { try { d() } catch { /* 收摊 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  assert.deepEqual(strayFetches, [])
})

const sleep = (ms) => new Promise((f) => setTimeout(f, ms))
async function waitFor(fn, what) {
  const deadline = Date.now() + 30_000
  while (!fn()) {
    assert.ok(Date.now() < deadline, '等了 30 秒还没等到：' + what)
    await sleep(20)
  }
}

/** 起一个插件实例：假 ctx + 假 dsh；返回驱动它的小函数 */
function startHost({ cfg = {}, ok = false } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    dshBin: ok ? fakeOk : fakeFail,
    dmWatch: false,
    manualCooldownMin: 0,
    dmUid: 12345,
    channelDm: true,
    ...cfg,
  }))
  let handler = null
  const own = []
  hosts.push({ dispose: () => { for (const d of own) { try { d() } catch { /* 收摊 */ } } } })
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') own.push(d) },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})
  const call = (method, path, body = null) => new Promise((resolve, reject) => {
    const text = body === null ? '' : JSON.stringify(body)
    const req = {
      method,
      url: path,
      headers: {},
      on: (ev, cb) => {
        if (ev === 'data' && text) cb(text)
        if (ev === 'end') cb()
      },
    }
    handler(req, { writeHead: () => {}, end: (s) => resolve(JSON.parse(s)) }).catch(reject)
  })
  const logFile = join(stateDir, 'duty.log')
  const logText = () => { try { return readFileSync(logFile, 'utf8') } catch { return '' } }
  const notes = () => {
    try {
      return readFileSync(join(stateDir, 'notifications.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch { return [] }
  }
  const report = () => {
    try { return readFileSync(join(stateDir, 'out', dayKey() + '.md'), 'utf8') } catch { return '' }
  }
  return {
    stateDir,
    notes,
    report,
    logText,
    status: () => call('GET', '/api/bili-duty/status'),
    config: (patch) => call('POST', '/api/bili-duty/config', patch),
    readConfig: () => call('GET', '/api/bili-duty/config'),
    /** 跑一轮（假 dsh 立刻退出）；等收尾（含失败通知）落定才返回 */
    async round() {
      const before = logText().split('刷B站结束（').length - 1
      const r = await call('POST', '/api/bili-duty/run')
      assert.equal(r.started, true, JSON.stringify(r))
      await waitFor(() => logText().split('刷B站结束（').length - 1 > before, '这一轮结束')
    },
  }
}

/* ───────────────── 采集失败 ⇒ 一条可读通知 ───────────────── */

test('采集轮失败（exit 1）⇒ 通知文件 / duty.log / 日报「通知」/ /status 四处都有', async () => {
  const h = startHost()
  await h.round()
  await waitFor(() => h.notes().length > 0, '失败通知写出来')

  const notes = h.notes()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].kind, 'collect-failed')
  assert.match(notes[0].message, /采集失败/)
  assert.match(notes[0].message, /退出码 1/)
  assert.ok(Date.parse(notes[0].at))
  assert.deepEqual(Object.keys(notes[0]).sort(), ['at', 'kind', 'message'], '一行一条 {at, kind, message}')

  assert.match(h.logText(), /通知（collect-failed）：采集失败/)
  assert.match(h.report(), /^## 通知$/m)
  assert.match(h.report(), /采集失败/)

  const st = await h.status()
  assert.equal(st.notifications.length, 1)
  assert.equal(st.notifications[0].kind, 'collect-failed')
  assert.match(st.notifications[0].message, /退出码 1/)
})

test('采集失败同类通知有冷却：连跑两轮失败也只写一条', async () => {
  const h = startHost()
  await h.round()
  await waitFor(() => h.notes().length > 0, '第一条失败通知')
  await h.round()
  // 第二轮收尾也跑完了（等日志里出现两次结束）—— 通知被冷却挡掉，文件仍只有一条
  await waitFor(() => h.logText().split('刷B站结束（').length - 1 >= 2, '第二轮结束')
  assert.equal(h.notes().length, 1)
})

/* ───────────────── 开关关掉 / 正常结束 ⇒ 一条都不发 ───────────────── */

test('notifyOnFailure=false：采集失败也不产生任何通知（文件 / 日报 / chatty 日志都没有）', async () => {
  const h = startHost({ cfg: { notifyOnFailure: false } })
  await h.round()
  await waitFor(() => h.logText().includes('刷B站结束（'), '这一轮结束')
  assert.equal(existsSync(join(h.stateDir, 'notifications.jsonl')), false)
  assert.ok(!h.report().includes('## 通知'))
  assert.ok(!h.logText().includes('通知（collect-failed）'))
  assert.deepEqual((await h.status()).notifications, [])
})

test('正常结束（这一轮没找到值得的）⇒ 不通知，「没找到」不是故障', async () => {
  const h = startHost({ ok: true })
  await h.round()
  await waitFor(() => h.logText().includes('刷B站结束（'), '这一轮结束')
  assert.equal(existsSync(join(h.stateDir, 'notifications.jsonl')), false)
  assert.ok(!h.report().includes('## 通知'))
  assert.deepEqual((await h.status()).notifications, [])
})

/* ───────────────── 投递配置：写入与读回两头都钳 ───────────────── */

test('投递配置：deliverPerDay / 间隔 / 免打扰 / 重试次数 / 通知开关都钳在合法范围', async () => {
  const h = startHost()
  const r = await h.config({
    deliverPerDay: 999,
    deliverMinGapMin: 2000,
    deliverMaxGapMin: 5,
    quietStart: '25:99',
    quietEnd: '8:5',
    deliverRetries: 9,
    notifyOnFailure: 0,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.config.deliverPerDay, 50)
  assert.equal(r.config.deliverMinGapMin, 1440)
  assert.equal(r.config.deliverMaxGapMin, 1440, '最长不能小于最短')
  assert.equal(r.config.quietStart, '23:00', '写坏的免打扰时刻退回默认')
  assert.equal(r.config.quietEnd, '08:00')
  assert.equal(r.config.deliverRetries, 3)
  assert.equal(r.config.notifyOnFailure, false)

  // 从 config.json 读回来也还是钳过的值（原生设置页那条路钳不到写）
  const back = await h.readConfig()
  assert.equal(back.config.deliverPerDay, 50)
  assert.equal(back.config.deliverRetries, 3)
  assert.equal(back.config.quietStart, '23:00')
  const saved = JSON.parse(readFileSync(join(h.stateDir, 'config.json'), 'utf8'))
  assert.equal(saved.deliverPerDay, 50)
  assert.equal(saved.notifyOnFailure, false)
})

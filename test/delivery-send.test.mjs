// node --test test/
// 工单 05：宿主发送通道 + 投递账。真 import index.js、假 ctx 上跑 apply()，
// 再把 <stateDir>/mcp_server.py 覆盖成一个 Node 写的最小 MCP stdio 服务（pythonPath = process.execPath），
// 于是走的是真的 McpClient，但**不联网、不碰真 python、不碰真家目录**。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateDelivery } from '../lib/delivery-policy.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-delivery-'))
// DSH_HOME 只在 import 期间用（hostdeps 找宿主包）；之后的路径都走假 ctx 的 dshHomePath
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
})
const { appendDelivery, readDelivery, deliveredOn, summarizeDelivery, isDelivered } = await import('../lib/ledger.mjs')
const { classifySendReply } = await import('../lib/send.mjs')
const { dayKey } = await import('../lib/state.mjs')

// 这一页只该走假 MCP；碰到网络就说明测试写错了
const strayFetches = []
globalThis.fetch = async (url) => {
  strayFetches.push(String(url))
  throw new Error('这个测试不该联网：' + String(url))
}

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  assert.deepEqual(strayFetches, [])
})

const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-bili-mcp.txt', import.meta.url))
const BVID_A = 'BV1aaaaaaaaa'
const BVID_B = 'BV1bbbbbbbbb'
const BVID_C = 'BV1ccccccccc'
const BVID_D = 'BV1ddddddddd'
const textFor = (bvid) => '今天看到一条挺有意思的：https://www.bilibili.com/video/' + bvid

/** 起一个插件实例：假 ctx + 假 MCP；返回驱动 HTTP 路由的小函数 */
function startHost({ cfg = {} } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    dshBin: join(home, 'fake-dsh.js'),
    dmWatch: false,
    pythonPath: process.execPath,
    dmUid: 12345,
    ...cfg,
  }))
  writeFileSync(join(stateDir, 'fake-mcp-mode.txt'), 'ok')

  let handler = null
  const disposers = []
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})
  // apply() 里 ensureHomeFiles 会把 vendor 的 Python 脚本铺进家目录 ⇒ 铺完再覆盖成假的
  copyFileSync(FAKE_MCP, join(stateDir, 'mcp_server.py'))

  const request = (method, path, body) => new Promise((resolve, reject) => {
    const req = {
      method,
      url: path,
      headers: {},
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
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

  return {
    stateDir,
    ledger: () => readDelivery(stateDir),
    setMode: (mode) => writeFileSync(join(stateDir, 'fake-mcp-mode.txt'), mode),
    stats: () => {
      try { return JSON.parse(readFileSync(join(stateDir, 'fake-mcp-stats.json'), 'utf8')) } catch { return null }
    },
    deliver: (body) => request('POST', '/api/bili-duty/deliver', body),
    status: () => request('GET', '/api/bili-duty/status'),
    dispose: () => { for (const d of disposers) { try { d() } catch { /* 收摊 */ } } },
  }
}

const hosts = []
const host = (opts) => { const h = startHost(opts); hosts.push(h); return h }
after(() => { for (const h of hosts) h.dispose() })

/* ─────────── 四种结局各自落账（假 MCP 的四个场景） ─────────── */

test('四种回执形态各自落一条账，字段齐全', async (t) => {
  const h = host()
  const cases = [
    {
      mode: 'ok',
      status: 'sent',
      bvid: BVID_A,
      check: (r) => {
        assert.equal(r.ok, true)
        assert.ok(r.msgKey, '拿到回执要带回 msgKey')
        assert.equal(r.record.msgKey, r.msgKey)
      },
    },
    {
      mode: 'no-receipt',
      status: 'no-receipt',
      bvid: BVID_B,
      check: (r) => {
        assert.equal(r.ok, false)
        assert.equal(r.record.msgKey, undefined, '没回执不许写 msgKey')
        assert.match(r.reason, /回执|msg_key/)
      },
    },
    {
      mode: 'reject',
      status: 'failed',
      bvid: BVID_C,
      check: (r) => {
        assert.equal(r.ok, false)
        assert.equal(r.code, 21007)
        assert.equal(r.record.code, 21007)
        assert.match(r.reason, /21007|拒绝/)
      },
    },
    {
      mode: 'exit',
      status: 'error',
      bvid: BVID_D,
      check: (r) => {
        assert.equal(r.ok, false)
        assert.match(r.reason, /退出|MCP|不可用/)
      },
    },
  ]

  for (const c of cases) {
    await t.test(c.status, async () => {
      h.setMode(c.mode)
      const r = await h.deliver({ uid: 12345, text: textFor(c.bvid), bvid: c.bvid, manual: false })
      assert.equal(r.status, c.status, JSON.stringify(r))
      assert.ok(!r.busy)
      c.check(r)

      const rec = h.ledger().at(-1)
      assert.ok(rec, '每次尝试都要落账')
      assert.equal(rec.status, c.status)
      assert.equal(rec.bvid, c.bvid)
      assert.equal(rec.receiverUid, 12345)
      assert.ok(!Number.isNaN(Date.parse(rec.at)), 'at 要能解析：' + rec.at)
      assert.ok(Number.isFinite(rec.durationMs) && rec.durationMs >= 0)
      assert.equal(rec.manual, undefined, '自动投递不写 manual')
      assert.equal(rec.id, dayKey() + ':' + c.bvid)
    })
  }

  // 四行 JSONL：一行一次尝试
  const lines = readFileSync(join(h.stateDir, 'delivery-ledger.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 4)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
  assert.deepEqual(h.ledger().map((x) => x.status), ['sent', 'no-receipt', 'failed', 'error'])
})

/* ─────────── blocked：机械检查在进 MCP 之前 ─────────── */

test('blocked：内部标识符命中 ⇒ 不发、不起 MCP、账本写可读原因', async () => {
  const h = host()
  h.setMode('ok')
  const r = await h.deliver({ uid: 12345, text: '这条草稿里写了投递账三个字', bvid: BVID_A, manual: false })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'blocked')
  assert.equal(r.blocked, true)
  assert.match(r.reason, /内部标识符|检查/)
  assert.equal(h.stats(), null, 'blocked 不该启动 MCP')
  assert.equal(h.ledger().length, 1)
  const rec = h.ledger()[0]
  assert.equal(rec.status, 'blocked')
  assert.equal(rec.bvid, BVID_A)
  assert.ok(rec.hits.includes('投递账'), JSON.stringify(rec.hits))
  assert.match(rec.message, /未通过/)
})

/* ─────────── 同一进程内并发：串行化 ─────────── */

test('并发两次发送被串行化：假 MCP 观测到的最大并发 = 1', async () => {
  const h = host()
  h.setMode('ok')
  const [a, b] = await Promise.all([
    h.deliver({ uid: 12345, text: textFor(BVID_A), bvid: BVID_A, manual: false }),
    h.deliver({ uid: 12345, text: textFor(BVID_B), bvid: BVID_B, manual: false }),
  ])
  assert.equal(a.status, 'sent')
  assert.equal(b.status, 'sent')
  const s = h.stats()
  assert.equal(s.calls, 2)
  assert.equal(s.maxActive, 1, '同一进程不能有两条同时进 MCP')
  assert.equal(h.ledger().length, 2)
})

/* ─────────── 另一个宿主持锁：busy、不落账、不碰锁 ─────────── */

test('另一个宿主持锁 ⇒ busy，不落失败账、也不动它的锁', async () => {
  const h = host()
  h.setMode('ok')
  const lockFile = join(h.stateDir, 'delivery-lock.json')
  const theirs = { pid: process.pid, ts: Date.now() }
  writeFileSync(lockFile, JSON.stringify(theirs))

  const r = await h.deliver({ uid: 12345, text: textFor(BVID_A), bvid: BVID_A, manual: false })
  assert.equal(r.ok, false)
  assert.equal(r.busy, true)
  assert.equal(r.record, null)
  assert.equal(h.ledger().length, 0, 'busy 不是一次投递尝试，不落账')
  assert.equal(h.stats(), null, 'busy 不该启动 MCP')
  assert.deepEqual(JSON.parse(readFileSync(lockFile, 'utf8')), theirs, '别人的锁一个字都不碰')
})

/* ─────────── /status：deliveredToday / lastDelivery ─────────── */

test('/status：deliveredToday 只数「有回执且非 manual」，lastDelivery 带时间/状态/BV', async () => {
  const h = host()
  h.setMode('ok')
  // 手动投递：有回执但不占当日额度
  const manual = await h.deliver({ uid: 12345, text: textFor(BVID_A), bvid: BVID_A, manual: true })
  assert.equal(manual.status, 'sent')
  assert.equal(manual.record.manual, true)

  let s = await h.status()
  assert.equal(s.deliveredToday, 0)
  assert.equal(s.lastDelivery.bvid, BVID_A)
  assert.equal(s.lastDelivery.status, 'sent')
  assert.ok(Date.parse(s.lastDelivery.at))

  // 自动投递：计入当日已投递，并成为 lastDelivery
  const auto = await h.deliver({ uid: 12345, text: textFor(BVID_B), bvid: BVID_B, manual: false })
  assert.equal(auto.status, 'sent')
  s = await h.status()
  assert.equal(s.deliveredToday, 1)
  assert.equal(s.lastDelivery.bvid, BVID_B)
  assert.equal(s.lastDelivery.status, 'sent')
  assert.equal(s.lastDelivery.manual, false)
})

/* ─────────── 投递账纯逻辑：按天过滤 + 与投递策略同口径 ─────────── */

test('投递账：按天过滤、已投递口径（msgKey + 非 manual）、坏行容错', () => {
  const dir = mkdtempSync(join(root, 'ledger-'))
  const today = new Date(2026, 10, 9, 10, 0, 0)          // 本机时区 2026-11-09
  const at = (h, m) => new Date(2026, 10, 9, h, m, 0).toISOString()
  const yesterday = new Date(2026, 10, 8, 23, 0, 0).toISOString()

  const r1 = appendDelivery(dir, { at: at(10, 0), bvid: BVID_A, status: 'sent', msgKey: 'm1', receiverUid: 1 })
  appendDelivery(dir, { at: at(10, 5), bvid: BVID_B, status: 'sent', msgKey: 'm2', receiverUid: 1, manual: true })
  appendDelivery(dir, { at: at(10, 10), bvid: BVID_C, status: 'no-receipt', receiverUid: 1 })
  appendDelivery(dir, { at: yesterday, bvid: BVID_D, status: 'sent', msgKey: 'm3', receiverUid: 1 })

  assert.equal(r1.at, at(10, 0))
  assert.equal(r1.status, 'sent')
  assert.equal(r1.msgKey, 'm1')
  assert.equal(r1.receiverUid, 1)

  assert.equal(readDelivery(dir).length, 4)
  assert.equal(readDelivery(dir, { day: dayKey(today) }).length, 3)

  const all = readDelivery(dir)
  assert.equal(deliveredOn(all, { day: dayKey(today) }), 1)
  const sum = summarizeDelivery(all, { day: dayKey(today) })
  assert.equal(sum.deliveredToday, 1)
  assert.equal(sum.lastDelivery.bvid, BVID_C)
  assert.equal(sum.lastDelivery.status, 'no-receipt')

  // 与 delivery-policy 同一口径（同一批账、同一个 now）
  assert.equal(sum.deliveredToday, evaluateDelivery({ now: today, ledger: all }).deliveredToday)

  assert.equal(isDelivered({ msgKey: 'x' }), true)
  assert.equal(isDelivered({ msgKey: 'x', manual: true }), false)
  assert.equal(isDelivered({ status: 'sent' }), false)
  assert.equal(isDelivered(null), false)

  // 坏行只跳过，不拖挂
  appendFileSync(join(dir, 'delivery-ledger.jsonl'), '这不是 JSON\n\n', 'utf8')
  assert.equal(readDelivery(dir).length, 4)
  assert.equal(readDelivery(dir, { day: '2026-11-09' }).length, 3)
})

/* ─────────── 回执分类：真工具的回执可能在 data 或 data.data 里 ─────────── */

test('classifySendReply：两处回执都认，拒绝 / 没回执 / 纯文本各有结局', () => {
  assert.deepEqual(
    classifySendReply({ success: true, message: 'ok', data: { code: 0, msg_key: 'k1' } }),
    { status: 'sent', msgKey: 'k1' },
  )
  assert.deepEqual(
    classifySendReply({ success: true, data: { code: 0, data: { msg_key: 'k2' } } }),
    { status: 'sent', msgKey: 'k2' },
  )
  assert.equal(classifySendReply({ success: true, data: { code: 0 } }).status, 'no-receipt')
  const refused = classifySendReply({ success: false, error: '接口拒绝', data: { code: 21007 } })
  assert.equal(refused.status, 'failed')
  assert.equal(refused.code, 21007)
  assert.match(refused.message, /拒绝/)
  assert.equal(classifySendReply('已发送').status, 'no-receipt')
  assert.equal(classifySendReply(null).status, 'no-receipt')
})

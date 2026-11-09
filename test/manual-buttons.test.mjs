// node --test test/
// 工单 09：两个手动入口（POST /run / POST /deliver-now）的桩宿主端到端。
// 真 import index.js、假 ctx、假 dsh、假 MCP（test/fixtures/fake-bili-mcp.txt）、临时 DSH_HOME
// —— **不联网、不碰真 python、不碰真实 ~/.dsh**。
// 断言只对外部可观察的东西：接口返回、队列文件、投递账、state.json、duty.log、/status。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dayKey } from '../lib/state.mjs'
import { loadQueue, saveQueue } from '../lib/queue.mjs'
import { readDelivery } from '../lib/ledger.mjs'
import { deliveryClockPaths, totalDeliveredToday } from '../lib/delivery-clock.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-manual-'))
// DSH_HOME 只在 import 期间用（hostdeps 找宿主包）；之后的路径都走假 ctx 的 dshHomePath
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
})

// 假 dsh：立刻以 0 退出（这一轮「跑了」，但什么都不写）
const fakeDsh = join(root, 'fake-dsh.mjs')
writeFileSync(fakeDsh, 'process.exit(0)\n')

// 假 MCP：走真的 McpClient，但把 mcp_server.py 覆盖成 Node 写的最小 stdio 服务
const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-bili-mcp.txt', import.meta.url))

const strayFetches = []
globalThis.fetch = async (url) => {
  strayFetches.push(String(url))
  throw new Error('这个测试不该联网：' + String(url))
}

const hosts = []
after(() => {
  for (const h of hosts) h.dispose()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  assert.deepEqual(strayFetches, [])
})

const BVID_A = 'BV1aaaaaaaaa'
const BVID_B = 'BV1bbbbbbbbb'
const BVID_C = 'BV1ccccccccc'
const BVID_D = 'BV1ddddddddd'

/** 一条还能投递的队列条目 */
const entry = (bvid, extra = {}) => ({
  id: dayKey() + ':' + bvid,
  bvid,
  title: '合成标题 ' + bvid,
  up: '合成UP',
  draft: '这条讲得挺清楚，值得花十分钟 https://www.bilibili.com/video/' + bvid,
  collectedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  status: 'pending',
  attempts: 0,
  lastError: '',
  retryAt: '',
  ...extra,
})

const sleep = (ms) => new Promise((f) => setTimeout(f, ms))
async function waitFor(fn, what) {
  const deadline = Date.now() + 30_000
  while (!fn()) {
    assert.ok(Date.now() < deadline, '等了 30 秒还没等到：' + what)
    await sleep(20)
  }
}

/** 起一个插件实例：假 ctx + 假 dsh + 假 MCP；返回驱动 HTTP 路由的小函数 */
function startHost({ cfg = {} } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    dshBin: fakeDsh,
    pythonPath: process.execPath,
    dmWatch: false,
    dmUid: 12345,
    channelDm: true,
    // 这个测试只驱动手动入口：默认关掉采集时钟与自动投递，免得启动那两跳插进来
    collectTimes: [],
    deliverPerDay: 0,
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

  const logFile = join(stateDir, 'duty.log')
  const h = {
    stateDir,
    call: request,
    status: () => request('GET', '/api/bili-duty/status'),
    run: (body = {}) => request('POST', '/api/bili-duty/run', body),
    deliverNow: () => request('POST', '/api/bili-duty/deliver-now', {}),
    config: (patch) => request('POST', '/api/bili-duty/config', patch),
    logText: () => { try { return readFileSync(logFile, 'utf8') } catch { return '' } },
    readState: () => { try { return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) } catch { return {} } },
    readQueue: () => loadQueue(stateDir).entries,
    putQueue: (list) => saveQueue(stateDir, { v: 1, entries: list }),
    ledger: () => readDelivery(stateDir),
    setMcpMode: (mode) => writeFileSync(join(stateDir, 'fake-mcp-mode.txt'), mode),
    /** 等这一轮采集收尾（日志里出现「刷B站结束」） */
    async waitRound(what = '这一轮结束') {
      await waitFor(() => h.logText().includes('刷B站结束（manual'), what)
    },
    dispose: () => { for (const d of disposers) { try { d() } catch { /* 收摊 */ } } },
  }
  hosts.push(h)
  return h
}

/* ───────────── ① 手动采集：带冷却，防手滑狂点 ───────────── */

test('POST /run：第一次立刻跑；冷却期内再点被挡；/status 给出剩余冷却与上次采集时刻', async () => {
  const h = startHost({ cfg: { manualCooldownMin: 1 } })
  const first = await h.run()
  assert.equal(first.started, true, JSON.stringify(first))
  await h.waitRound()

  const second = await h.run()
  assert.equal(second.started, false, '冷却期内不该再起一轮')
  assert.match(second.error, /再等/)
  assert.equal(second.ok, false, '冷却拒绝沿用了 runDuty 的 ok=false（设置页看的是 started）')
  assert.ok(second.manualCollectCooldownRemainingMs > 0, JSON.stringify(second))
  assert.ok(second.manualCollectCooldownRemainingMs <= 60_000)

  const st = await h.status()
  assert.equal(st.collectRunning, false, '这一轮已经结束了')
  assert.ok(st.manualCollectCooldownRemainingMs > 0)
  assert.ok(Date.parse(st.lastCollectAt), '/status.lastCollectAt 要能解析：' + st.lastCollectAt)
  const state = h.readState()
  assert.ok(Date.parse(state.lastCollectAt))
})

/* ───────────── ② 手动采集：队列满了也允许跑，但要提示可能发不出去 ───────────── */

test('POST /run：队列已满 ⇒ 允许跑，返回 / /status 带可读提示；采集时钟照常给下一次时刻', async () => {
  const h = startHost({ cfg: { manualCooldownMin: 0, queueLimit: 3, collectTimes: ['12:30', '19:30'] } })
  h.putQueue([entry(BVID_A), entry(BVID_B), entry(BVID_C)])

  const r = await h.run()
  assert.equal(r.started, true, JSON.stringify(r))
  assert.match(r.queueFullHint, /队列已满/)
  assert.match(r.queueFullHint, /可能发不出去/)
  assert.match(h.logText(), /手动采集：队列已满/)
  await h.waitRound()

  const st = await h.status()
  assert.equal(st.queuePending, 3)
  assert.equal(st.queueFullHint, r.queueFullHint)
  assert.equal(st.queueLimit, 3)
  assert.ok(st.nextCollectAt, '配了时间点就要给出下一次采集')
  assert.ok(Date.parse(st.nextCollectAt) > Date.now(), '下一次采集必须是未来：' + st.nextCollectAt)
  assert.deepEqual(st.config.collectTimes, ['12:30', '19:30'])
})

/* ───────────── ③ 手动投递：队列空 / 私信关 / 没填收件人 ───────────── */

test('POST /deliver-now：队列空 ⇒ 明确告知「等下一轮采集」', async () => {
  const h = startHost()
  const r = await h.deliverNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'queue-empty')
  assert.match(r.message, /队列里没有待投递的候选/)
  assert.match(h.logText(), /手动投递：没发成（queue-empty）/)
  const st = await h.status()
  assert.equal(st.queueEmpty, true)
  assert.equal(st.deliveryEnabled, true)
})

test('POST /deliver-now：私信关着 / 没填收件人 ⇒ 各自说清，不落账', async () => {
  let h = startHost({ cfg: { channelDm: false } })
  let r = await h.deliverNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'dm-off')
  assert.match(r.message, /私信关着/)
  assert.equal((await h.status()).deliveryEnabled, false)
  assert.equal(h.ledger().length, 0)

  h = startHost({ cfg: { dmUid: 0, mentionName: '' } })
  h.putQueue([entry(BVID_A)])
  r = await h.deliverNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'no-recipient')
  assert.match(r.message, /还没填收件人/)
  assert.equal(h.ledger().length, 0, '没发出去就不该有账')
})

/* ───────────── ④ 手动投递：成功（队头一条 + 账本 manual + 不占当日额度 + 防连点） ───────────── */

test('POST /deliver-now：成功 ⇒ 发队头、账本记 manual、队列改 sent；紧接着再点被防连点挡住', async () => {
  const h = startHost()
  h.putQueue([entry(BVID_A), entry(BVID_B)])
  const r = await h.deliverNow()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.sent, true)
  assert.equal(r.reason, 'sent')
  assert.equal(r.entry.bvid, BVID_A)
  assert.match(r.message, /已投递 BV1aaaaaaaaa/)
  assert.match(r.message, /不占当天额度/)

  const queue = h.readQueue()
  assert.equal(queue.find((e) => e.bvid === BVID_A).status, 'sent')
  assert.equal(queue.find((e) => e.bvid === BVID_B).status, 'pending', '一次只发一条')
  const ledger = h.ledger()
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].status, 'sent')
  assert.equal(ledger[0].manual, true)
  assert.ok(ledger[0].msgKey, '成功要有回执')

  // 防连点：立刻再点 ⇒ cooldown + 还剩几秒
  const again = await h.deliverNow()
  assert.equal(again.sent, false)
  assert.equal(again.reason, 'cooldown')
  assert.match(again.message, /再等 \d+ 秒/)
  assert.equal(h.ledger().length, 1, '被冷却挡下不是一次尝试')

  const st = await h.status()
  assert.ok(st.manualDeliverCooldownRemainingMs > 0 && st.manualDeliverCooldownRemainingMs <= 5000,
    JSON.stringify(st.manualDeliverCooldownRemainingMs))
  assert.equal(st.lastDelivery.bvid, BVID_A)
  assert.equal(st.lastDelivery.manual, true)
  assert.equal(st.deliveredToday, 0, '手动投递不占当日额度')
  assert.equal(st.queueEmpty, false, '队列里还有 B 待投递')
})

/* ───────────── ④b 手动投递也走出站检查（链接 / 长度）：被挡下就不进 MCP ───────────── */

test('POST /deliver-now：病态长的草稿 ⇒ 挡在发送之前（账本记 blocked、不起 MCP、这条标 failed）', async () => {
  const h = startHost()
  // 链接由 deliveryTextOf 兜底补上，所以宿主这条链上真正会被拦的是「病态长」那一档
  h.putQueue([entry(BVID_A, { draft: '这条讲得挺清楚。'.repeat(400) })])
  const r = await h.deliverNow()
  assert.equal(r.sent, false)
  assert.equal(r.status, 'blocked')
  assert.equal(r.reason, 'sent-failed', 'blocked 重试也不会好 ⇒ 直接放弃这条')
  assert.match(r.message, /异常长/)

  const ledger = h.ledger()
  assert.equal(ledger.length, 1, 'blocked 也要落一条账')
  assert.equal(ledger[0].status, 'blocked')
  assert.equal(ledger[0].bvid, BVID_A)
  assert.equal(existsSync(join(h.stateDir, 'fake-mcp-stats.json')), false, '没通过检查就不该起 MCP')
  assert.equal(h.readQueue()[0].status, 'failed')
})

/* ───────────── ⑤ 手动投递：失败映射（放弃 / 5 分钟后重试） ───────────── */

test('POST /deliver-now：接口拒绝 ⇒ 可读文案；重试次数用尽标 failed，否则 5 分钟后重试', async () => {
  // 重试 0 次（总尝试 1 次）⇒ 直接放弃
  let h = startHost({ cfg: { deliverRetries: 0 } })
  h.setMcpMode('reject')
  h.putQueue([entry(BVID_A)])
  let r = await h.deliverNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'sent-failed')
  assert.equal(r.status, 'failed')
  assert.match(r.message, /没发出去/)
  assert.match(r.message, /已标为失败/)
  assert.equal(h.readQueue()[0].status, 'failed')
  assert.equal(h.ledger().length, 1)
  assert.equal(h.ledger()[0].manual, true)

  // 重试 1 次 ⇒ 这次失败先排 5 分钟后的重试
  h = startHost({ cfg: { deliverRetries: 1 } })
  h.setMcpMode('reject')
  h.putQueue([entry(BVID_B)])
  r = await h.deliverNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, 'retry-scheduled')
  assert.equal(r.attempts, 1)
  assert.match(r.message, /5 分钟后会自动重试一次/)
  const q = h.readQueue()[0]
  assert.equal(q.status, 'pending', '还能重试 ⇒ 保持 pending')
  assert.equal(q.attempts, 1)
  assert.ok(Date.parse(q.retryAt) > Date.now())
})

/* ───────────── ⑥ deliveredToday 口径：基线 + 当天账本（设置页与水位闸同口径） ───────────── */

test('deliveredToday：基线那天 = 基线 + 当天账本；跨天只用账本', async () => {
  assert.equal(totalDeliveredToday(1, 2), 3)
  assert.equal(totalDeliveredToday(0, 2), 2)

  const today = dayKey()
  const yesterday = dayKey(new Date(Date.now() - 24 * 3600_000))

  // 基线 + 当天账本：2 + 1 = 3（今天账本里还有一条 manual，不算）
  const h = startHost()
  writeFileSync(deliveryClockPaths(h.stateDir).baseline, JSON.stringify({ day: today, count: 2, at: new Date().toISOString() }))
  writeFileSync(deliveryClockPaths(h.stateDir).marker, JSON.stringify({ day: today, count: 2 }))
  writeFileSync(join(h.stateDir, 'delivery-ledger.jsonl'), [
    { at: new Date().toISOString(), bvid: BVID_A, status: 'sent', msgKey: 'm1', receiverUid: 1 },
    { at: new Date().toISOString(), bvid: BVID_B, status: 'sent', msgKey: 'm2', receiverUid: 1, manual: true },
    { at: new Date(Date.now() - 24 * 3600_000).toISOString(), bvid: BVID_C, status: 'sent', msgKey: 'm3', receiverUid: 1 },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  let st = await h.status()
  assert.equal(st.deliveredBaseline, 2)
  assert.equal(st.deliveredToday, 3, '基线 2 + 当天账本 1（manual 不算）')

  // 跨天：基线是昨天的 ⇒ 只看账本
  const h2 = startHost()
  writeFileSync(deliveryClockPaths(h2.stateDir).baseline, JSON.stringify({ day: yesterday, count: 9, at: new Date().toISOString() }))
  writeFileSync(deliveryClockPaths(h2.stateDir).marker, JSON.stringify({ day: yesterday, count: 9 }))
  writeFileSync(join(h2.stateDir, 'delivery-ledger.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), bvid: BVID_D, status: 'sent', msgKey: 'm4', receiverUid: 1 }) + '\n')
  st = await h2.status()
  assert.equal(st.deliveredBaseline, 0)
  assert.equal(st.deliveredToday, 1, '跨天只用账本，不扣昨天的基线')
})

/* ───────────── ⑦ 配置：collectTimes 写入时清洗（HTTP 那条路也过 clampPatch） ───────────── */

test('POST /config：collectTimes 清洗（只留合法 HH:MM、去重、排序、最多 12 个；空数组合法）', async () => {
  const h = startHost()
  let r = await h.config({ collectTimes: ['25:00', '19:30', '7:5', '12:30', '12:30', '09:00'] })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.config.collectTimes, ['09:00', '12:30', '19:30'])
  const cfg = await h.call('GET', '/api/bili-duty/config')
  assert.deepEqual(cfg.config.collectTimes, ['09:00', '12:30', '19:30'])

  // 最多 12 个
  const many = []
  for (let i = 0; i < 15; i++) many.push(String(i).padStart(2, '0') + ':00')
  r = await h.config({ collectTimes: many })
  assert.equal(r.config.collectTimes.length, 12)

  // 空数组是合法值（= 不按时间点自动采集），不会被"空值保护"挡掉
  r = await h.config({ collectTimes: [] })
  assert.deepEqual(r.config.collectTimes, [])
  const st = await h.status()
  assert.equal(st.nextCollectAt, null)
})

/* ───────────── ⑧ GET /queue：队列面板要逐条看到状态（工单 10） ───────────── */

test('GET /queue：items 仍然只有 pending；finished 给出已投递 / 已过期 / 投递失败（含失败原因）', async () => {
  const h = startHost()
  h.putQueue([
    entry(BVID_A),
    entry(BVID_B, { status: 'sent', attempts: 1 }),
    entry(BVID_C, { status: 'expired' }),
    entry(BVID_D, { status: 'failed', attempts: 2, lastError: '21007 风控' }),
  ])
  const q = await h.call('GET', '/api/bili-duty/queue')
  assert.equal(q.ok, true)
  // 可投递视图的语义不变：只有 pending（spec「过期条目不再出现在可投递视图里」）
  assert.deepEqual(q.items.map((x) => x.bvid), [BVID_A])
  assert.equal(q.pending, 1)
  assert.equal(q.total, 4)
  // finished：设置页的队列面板靠它显示「已投递 / 已过期 / 投递失败 + 失败原因」
  const byBv = new Map(q.finished.map((x) => [x.bvid, x]))
  assert.deepEqual([...byBv.keys()].sort(), [BVID_B, BVID_C, BVID_D].sort())
  assert.equal(byBv.get(BVID_B).status, 'sent')
  assert.equal(byBv.get(BVID_C).status, 'expired')
  assert.equal(byBv.get(BVID_D).status, 'failed')
  assert.equal(byBv.get(BVID_D).lastError, '21007 风控', '失败原因要能显示出来')
  assert.ok(!byBv.has(BVID_A), 'pending 不该重复出现在 finished 里')
  assert.ok(byBv.get(BVID_B).collectedAt, '采集时间要给（面板上要显示）')
})

// node --test test/
// 工单 06「队列 + 采集改写 + 日报宿主写」的桩宿主端到端：
//   真 import index.js、假 ctx、假 dsh（把这一轮的候选写进 queue-inbox.jsonl，模拟 duty_candidate_append），
//   临时 DSH_HOME —— **不联网、不碰真 python、不碰真家目录**。
// 断言只对外部可观察的东西：队列文件内容、日报里的小节与行、/queue 与 /status、overlay 里的白名单。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'
import { buildWhitelist } from '../lib/tool-whitelist.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-collect-'))
// DSH_HOME 只在 import 期间用（hostdeps 找宿主包）；之后的路径都走假 ctx 的 dshHomePath
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
})

// 假 dsh：按 <家>/next-round.json 办事
//   ① 把这一轮收到的 prompt（最后一个参数）记进 last-prompt.txt
//   ② 把 --patch 那份 overlay 里的 BILI_MCP_TOOLS 记进 last-overlay-tools.txt（白名单）
//   ③ 往当天日报追加 spec.body（模型自己写的那些行）
//   ④ 往 queue-inbox.jsonl 追加 spec.candidates（= 模型调 duty_candidate_append 的效果）
const fakeDsh = join(root, 'fake-dsh.mjs')
writeFileSync(fakeDsh, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.BILI_DUTY_HOME, day = process.env.BILI_DUTY_RUN_DAY
const argv = process.argv.slice(2)
writeFileSync(join(home, 'last-prompt.txt'), argv[argv.length - 1] || '')
const pi = argv.indexOf('--patch')
if (pi >= 0 && argv[pi + 1]) {
  const yml = readFileSync(argv[pi + 1], 'utf8')
  const m = yml.match(/BILI_MCP_TOOLS: '([^']*)'/)
  writeFileSync(join(home, 'last-overlay-tools.txt'), m ? m[1] : '')
  writeFileSync(join(home, 'last-overlay-path.txt'), argv[pi + 1])
}
const plan = join(home, 'next-round.json')
if (!existsSync(plan)) process.exit(0)
const spec = JSON.parse(readFileSync(plan, 'utf8'))
const report = join(home, 'out', day + '.md')
if (spec.body) appendFileSync(report, (existsSync(report) ? '' : '# 刷B站日报 ' + day + '\\n\\n') + spec.body + '\\n')
for (const c of spec.candidates || []) appendFileSync(join(home, 'queue-inbox.jsonl'), JSON.stringify(c) + '\\n')
`)

// 这一页不该联网
const strayFetches = []
globalThis.fetch = async (url) => {
  strayFetches.push(String(url))
  throw new Error('这个测试不该联网：' + String(url))
}

const disposers = []
after(() => {
  for (const d of disposers) { try { d() } catch { /* 收摊 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  assert.deepEqual(strayFetches, [])
})

const BVID_A = 'BV1aaaaaaaaa'
const BVID_B = 'BV1bbbbbbbbb'
const BVID_C = 'BV1ccccccccc'
const cand = (bvid, tag) => ({ bvid, title: '合成标题 ' + tag, up: '合成UP ' + tag, draft: '这条讲得挺清楚，值得花十分钟 ' + tag })

const sleep = (ms) => new Promise((f) => setTimeout(f, ms))
async function waitFor(fn, what) {
  const deadline = Date.now() + 30_000
  while (!fn()) {
    assert.ok(Date.now() < deadline, '等了 30 秒还没等到：' + what)
    await sleep(20)
  }
}

/** 起一个插件实例：假 ctx + 假 dsh；返回驱动它的小函数 */
function startHost({ cfg = {} } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  const base = { dshBin: fakeDsh, dmWatch: false, manualCooldownMin: 0, dmUid: 12345, pythonPath: process.execPath }
  const writeCfg = (c) => writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ ...base, ...c }))
  writeCfg(cfg)
  let handler = null
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
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
  const roundsDone = () => logText().split('刷B站结束（').length - 1
  const readState = () => { try { return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) } catch { return {} } }
  const readQueue = () => { try { return JSON.parse(readFileSync(join(stateDir, 'queue.json'), 'utf8')) } catch { return { entries: [] } } }
  const writeQueueRaw = (q) => writeFileSync(join(stateDir, 'queue.json'), JSON.stringify(q, null, 2))
  const droppedRows = () => {
    try {
      return readFileSync(join(stateDir, 'queue-dropped.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch { return [] }
  }
  const report = () => readFileSync(join(stateDir, 'out', `${dayKey()}.md`), 'utf8')
  return {
    stateDir,
    call,
    logText,
    readState,
    readQueue,
    writeQueueRaw,
    droppedRows,
    report,
    prompt: () => readFileSync(join(stateDir, 'last-prompt.txt'), 'utf8'),
    overlayTools: () => readFileSync(join(stateDir, 'last-overlay-tools.txt'), 'utf8').split(',').filter(Boolean),
    overlayPath: () => readFileSync(join(stateDir, 'last-overlay-path.txt'), 'utf8'),
    /** 跑一轮采集：假 dsh 按 spec 写候选 / 报告正文，等收尾（入队 + 写日报）落定才返回 */
    async round(spec = {}) {
      writeFileSync(join(stateDir, 'next-round.json'), JSON.stringify(spec))
      const mark = Date.now()
      const before = roundsDone()
      const r = await call('POST', '/api/bili-duty/run')
      assert.equal(r.started, true, JSON.stringify(r))
      await waitFor(() => roundsDone() === before + 1, '这一轮结束')
      // 收尾（排干收件箱 → 入队 → 写日报）是同步跑的；state.json 里的 queueDroppedAt 就是它的锚点
      await waitFor(() => Number(Date.parse(readState().queueDroppedAt)) >= mark, '队列收尾')
    },
  }
}

const queueApi = (h) => h.call('GET', '/api/bili-duty/queue')
const statusApi = (h) => h.call('GET', '/api/bili-duty/status')
const headings = (t, re) => (t.match(re) || []).length

/* ───────────────────────── ① 一轮采集 → 队列 + 日报 ───────────────────────── */

test('跑一轮采集：候选进队列（字段齐全），日报由宿主写出 `### BV` + 状态 + 草稿', async () => {
  const h = startHost()
  await h.round({
    candidates: [cand(BVID_A, 'A'), cand(BVID_B, 'B')],
    body: '## 这一轮的小结\n今天看到两条不错的。',
  })

  // 队列文件：字段齐全
  const q = h.readQueue()
  assert.equal(q.v, 1)
  assert.equal(q.entries.length, 2)
  const e = q.entries[0]
  assert.equal(e.id, `${dayKey()}:${BVID_A}`, 'id = 天 + BV')
  assert.equal(e.bvid, BVID_A)
  assert.equal(e.title, '合成标题 A')
  assert.equal(e.up, '合成UP A')
  assert.equal(e.draft, '这条讲得挺清楚，值得花十分钟 A')
  assert.equal(e.status, 'pending')
  assert.equal(e.attempts, 0)
  assert.equal(e.lastError, '')
  assert.ok(!Number.isNaN(Date.parse(e.collectedAt)), '采集时间要可解析')
  assert.equal(Date.parse(e.expiresAt) - Date.parse(e.collectedAt), 24 * 3600_000, '默认保质期 24 小时')
  assert.deepEqual(q.entries.map((x) => x.bvid), [BVID_A, BVID_B], '队列顺序 = 交上来的顺序')

  // 收件箱已经排干
  assert.equal(existsSync(join(h.stateDir, 'queue-inbox.jsonl')), false, '入队之后收件箱要清掉')

  // 日报：宿主写的「队列」一节（每条一行 ### BV + 状态），模型自己的内容照旧在
  const t = h.report()
  assert.equal(headings(t, /^## 队列$/gm), 1)
  assert.ok(t.includes('### ' + BVID_A) && t.includes('### ' + BVID_B))
  assert.ok(t.includes('- 标题：合成标题 A'))
  assert.ok(t.includes('- UP：合成UP A'))
  assert.equal(headings(t, /^- 状态：待投递$/gm), 2)
  assert.match(t, /^- 采集：\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 到期：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m)
  assert.ok(t.includes('- 草稿：这条讲得挺清楚，值得花十分钟 A'))
  assert.match(t, /^- 本轮：入队 2 条 · 丢弃 0 条 · 过期 0 条 · 跳过 0 条 · 现在队列里 2 条待投递$/m)
  assert.ok(t.includes('## 这一轮的小结\n今天看到两条不错的。'), '模型自己写的内容不能被剪')

  // /queue：设置页要的标题 / 剩余保质期 / 状态
  const api = await queueApi(h)
  assert.equal(api.ok, true)
  assert.equal(api.total, 2)
  assert.equal(api.pending, 2)
  assert.equal(api.items.length, 2)
  assert.equal(api.items[0].bvid, BVID_A)
  assert.equal(api.items[0].title, '合成标题 A')
  assert.equal(api.items[0].status, 'pending')
  assert.ok(api.items[0].expiresInHours > 23.5 && api.items[0].expiresInHours <= 24, '剩余保质期按小时给')
  assert.equal(api.limits.limit, 3)
  assert.equal(api.limits.ttlHours, 24)

  // /status：队列摘要
  const st = await statusApi(h)
  assert.equal(st.queueTotal, 2)
  assert.equal(st.queuePending, 2)
  assert.equal(st.queueNext.bvid, BVID_A)
  assert.equal(st.queueDroppedLast, 0)
})

/* ───────────────────────── ② 连跑两轮：不互相剪断 ───────────────────────── */

test('连跑两轮：两轮内容都在、宿主小节只出现一次、子块不被剪断', async () => {
  const h = startHost()
  await h.round({
    candidates: [cand(BVID_A, 'A')],
    body: '### BV1zzzzzzzzz\n标题：模型自己写的一条\n**档位**：可以看\n\n第一轮总结',
  })
  await h.round({
    candidates: [cand(BVID_B, 'B')],
    body: '第二轮总结：又看到一条。',
  })

  const t = h.report()
  assert.equal(headings(t, /^## 队列$/gm), 1, '宿主小节只留一节')
  assert.ok(t.includes('第一轮总结'), '第一轮写的内容还在')
  assert.ok(t.includes('第二轮总结：又看到一条。'), '第二轮写的内容也在')
  assert.ok(t.includes('### BV1zzzzzzzzz\n标题：模型自己写的一条'), '模型自己写的 ### BV 块不被吞')
  assert.equal(headings(t, /### BV1zzzzzzzzz/g), 1)
  // 队列里两条都在日报里，且各只出现一次（宿主那一节是快照，不是追加）
  assert.equal(headings(t, new RegExp('^### ' + BVID_A + '$', 'gm')), 1)
  assert.equal(headings(t, new RegExp('^### ' + BVID_B + '$', 'gm')), 1)
  assert.match(t, /^- 本轮：入队 1 条 · 丢弃 0 条 · 过期 0 条 · 跳过 0 条 · 现在队列里 2 条待投递$/m)
  assert.equal(h.readQueue().entries.length, 2)
})

/* ───────────────────────── ③ 队列满：新候选不入队但有记录 ───────────────────────── */

test('队列满时新候选不入队，且日报 / 丢弃记录 / duty.log / /status 都看得到', async () => {
  const h = startHost({ cfg: { queueLimit: 2 } })
  await h.round({ candidates: [cand(BVID_A, 'A'), cand(BVID_B, 'B'), cand(BVID_C, 'C')] })

  const q = h.readQueue()
  assert.deepEqual(q.entries.map((e) => e.bvid), [BVID_A, BVID_B], '上限 2 条，第三条不进来')
  const t = h.report()
  assert.match(t, /^- 本轮：入队 2 条 · 丢弃 1 条 · 过期 0 条 · 跳过 0 条 · 现在队列里 2 条待投递$/m)
  const drops = h.droppedRows()
  assert.equal(drops.length, 1)
  assert.equal(drops[0].bvid, BVID_C)
  assert.equal(drops[0].reason, 'queue-full')
  assert.match(h.logText(), /队列已满（上限 2 条）⇒ 这条没入队/)
  assert.equal((await statusApi(h)).queueDroppedLast, 1)
  assert.equal((await queueApi(h)).total, 2)

  // 再来一轮：队列还是满的 ⇒ 新候选照样进不来，记录继续累加
  await h.round({ candidates: [cand('BV1ddddddddd', 'D')] })
  assert.equal(h.readQueue().entries.length, 2)
  assert.equal(h.droppedRows().length, 2)
  assert.match(h.report(), /^- 本轮：入队 0 条 · 丢弃 1 条/m)
})

/* ───────────────────────── ④ 白名单：采集轮没有发送私信 ───────────────────────── */

test('采集轮的 BILI_MCP_TOOLS 里没有 bili_send_message（私信回复轮才有）', async () => {
  const h = startHost()
  await h.round({ candidates: [cand(BVID_A, 'A')] })

  const tools = h.overlayTools()
  assert.ok(tools.length > 0, 'overlay 里应该写着白名单：' + h.overlayPath())
  assert.ok(!tools.includes('bili_send_message'), '采集轮不该有发送私信的手：' + tools.join(','))
  assert.ok(tools.includes('duty_candidate_append'), '采集轮要把候选交出去')
  assert.ok(tools.includes('duty_seen_append'), '判重表照写')
  assert.ok(tools.includes('bili_search'), '只读工具照给')

  // 私信回复轮那一份由 lib/tool-whitelist.mjs 定（它单独写 headless-overlay-dm.yml；
  // dmTick 最快 1 分钟一跳，端到端跑不动，这里直接测同一份纯函数）
  assert.ok(buildWhitelist({ purpose: 'dm' }).includes('bili_send_message'))
  assert.ok(!buildWhitelist({ purpose: 'collect' }).includes('bili_send_message'))
  assert.ok(!buildWhitelist({ purpose: 'collect', comments: true }).includes('bili_send_message'))
  assert.ok(buildWhitelist({ purpose: 'collect', comments: true }).includes('bili_reply'))
  assert.ok(!buildWhitelist({ purpose: 'collect', comments: false }).includes('bili_reply'))

  // 提示词也要说清楚：这一轮是采集轮、最多采几条、候选走 duty_candidate_append
  const p = h.prompt()
  assert.match(p, /这一轮是「采集轮」/)
  assert.match(p, /这一轮\*\*最多挑 3 条\*\*候选/)
  assert.ok(p.includes('duty_candidate_append(bvid, title, up, draft)'))
  assert.ok(!/用 bili_send_message/.test(p), '采集轮的提示词里不该让它去发私信（章程里"这一轮没有这只工具"那句不算）')
  assert.match(p, /私信：\*\*这一轮一条都不发\*\*/)
})

/* ───────────────────────── ⑤ 过期：不进可投递视图 ───────────────────────── */

test('过期的条目不再出现在可投递视图里，日报里标成「已过期」', async () => {
  const h = startHost()
  await h.round({ candidates: [cand(BVID_A, 'A')] })
  // 把这条的到期时间改到过去（模拟放了一整天没人投递）
  const q = h.readQueue()
  q.entries[0].expiresAt = new Date(Date.now() - 3600_000).toISOString()
  h.writeQueueRaw(q)

  const api = await queueApi(h)
  assert.equal(api.pending, 0)
  assert.deepEqual(api.items, [], '过期的不能出现在可投递视图里')
  assert.equal(api.total, 1, '但队列文件里还在（供对账与判重）')
  const st = await statusApi(h)
  assert.equal(st.queuePending, 0)
  assert.equal(st.queueNext, null)

  // 下一轮收尾时把它正式转成 expired，并在日报里写清楚
  await h.round({ candidates: [] })
  assert.equal(h.readQueue().entries[0].status, 'expired')
  const t = h.report()
  assert.match(t, /^- 状态：已过期$/m)
  assert.match(t, /^- 本轮：入队 0 条 · 丢弃 0 条 · 过期 1 条 · 跳过 0 条 · 现在队列里 0 条待投递$/m)
  assert.match(h.logText(), /队列过期作废：BV1aaaaaaaaa/)
})

/* ───────────────────────── ⑥ 配置与收件箱的边角 ───────────────────────── */

test('配置：queueLimit / queueTtlHours / collectBatch 三个数字写入时被钳制；提示词按 collectBatch 说', async () => {
  const h = startHost({ cfg: { collectBatch: 5, queueLimit: 4, queueTtlHours: 48 } })
  await h.round({ candidates: [] })
  assert.match(h.prompt(), /这一轮\*\*最多挑 5 条\*\*候选/)
  // 非法值往两头钳：queueLimit 1..20 / queueTtlHours 1..168 / collectBatch 1..10
  const r = await h.call('POST', '/api/bili-duty/config', { queueLimit: 99, queueTtlHours: 0, collectBatch: 999 })
  assert.equal(r.ok, true)
  assert.equal(r.config.queueLimit, 20)
  assert.equal(r.config.queueTtlHours, 1)
  assert.equal(r.config.collectBatch, 10)
  const cfg = await h.call('GET', '/api/bili-duty/config')
  assert.equal(cfg.config.queueLimit, 20)
  assert.equal(cfg.config.collectBatch, 10)
  // 读的那一头也钳（原生设置页写进来的 999 不会原样生效）
  writeFileSync(join(h.stateDir, 'config.json'), JSON.stringify({ dshBin: fakeDsh, dmWatch: false, manualCooldownMin: 0, dmUid: 12345, collectBatch: 999 }))
  await h.round({ candidates: [] })
  assert.match(h.prompt(), /这一轮\*\*最多挑 10 条\*\*候选/, '读回来也钳到上限 10')
})

test('收件箱里混进坏行：不炸，坏行算「跳过」，好候选照常入队', async () => {
  const h = startHost()
  // 直接写 inbox（模拟别的进程 / 手改），再跑一轮空采集
  writeFileSync(join(h.stateDir, 'queue-inbox.jsonl'), [
    JSON.stringify(cand(BVID_A, 'A')),
    '这不是 json',
    JSON.stringify({ ...cand(BVID_B, 'B') }),
  ].join('\n') + '\n', 'utf8')
  await h.round({ candidates: [] })
  assert.deepEqual(h.readQueue().entries.map((e) => e.bvid), [BVID_A, BVID_B])
  assert.match(h.report(), /^- 本轮：入队 2 条 · 丢弃 0 条 · 过期 0 条 · 跳过 1 条/m)
  assert.equal(h.droppedRows().length, 0, 'inbox 里的坏行没有 bvid，只计数、不写丢弃记录')
  assert.equal(existsSync(join(h.stateDir, 'queue-inbox.jsonl')), false)
})

test('同一轮交上来重复的 BV：只入队一条，另一条算跳过', async () => {
  const h = startHost()
  await h.round({ candidates: [cand(BVID_A, 'A'), cand(BVID_A, 'again')] })
  assert.deepEqual(h.readQueue().entries.map((e) => e.bvid), [BVID_A])
  assert.match(h.report(), /^- 本轮：入队 1 条 · 丢弃 0 条 · 过期 0 条 · 跳过 1 条/m)
  assert.equal(h.droppedRows()[0].reason, 'duplicate')
})

test('「不写日报」那档：候选照常入队，但宿主不写日报（也不建「队列」节）', async () => {
  const h = startHost({ cfg: { reportLevel: 'off' } })
  await h.round({ candidates: [cand(BVID_A, 'A')], body: '' })
  assert.deepEqual(h.readQueue().entries.map((e) => e.bvid), [BVID_A], '队列照样收下')
  assert.equal(existsSync(join(h.stateDir, 'out', `${dayKey()}.md`)), false, 'reportLevel=off 不写日报')
})

test('这一轮没候选、队列也是空的 ⇒ 不写空的「队列」节（省得每轮多一段噪音）', async () => {
  const h = startHost()
  await h.round({ body: '## 小结\n这一轮没有值得的。' })
  const t = h.report()
  assert.ok(t.includes('这一轮没有值得的。'))
  assert.ok(!t.includes('## 队列'), '什么都没发生就不写队列节')
  assert.deepEqual(h.readQueue().entries, [])
  assert.equal((await queueApi(h)).total, 0)
})

test('日报的状态看账本：队列还是 pending，但账本里已有回执 ⇒ 那条显示「已投递」', async () => {
  const h = startHost()
  appendFileSync(join(h.stateDir, 'delivery-ledger.jsonl'), JSON.stringify({
    at: new Date().toISOString(), bvid: BVID_A, status: 'sent', msgKey: '合成回执', receiverUid: 1,
  }) + '\n', 'utf8')
  await h.round({ candidates: [cand(BVID_A, 'A'), cand(BVID_B, 'B')] })
  const t = h.report()
  const blockA = t.split('### ' + BVID_A)[1].split('### ' + BVID_B)[0]
  const blockB = t.split('### ' + BVID_B)[1]
  assert.match(blockA, /^- 状态：已投递$/m, '账本有回执 ⇒ 日报说已投递')
  assert.match(blockB, /^- 状态：待投递$/m, '没有回执的照旧说待投递')
  assert.equal(h.readQueue().entries[0].status, 'pending', '队列状态由 07 改；06 只读账本渲染日报')
})

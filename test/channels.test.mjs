// node --test test/
// 工单 08「渠道迁移」：
//   ① 纯函数表驱动：dmMode 三态 × autoComment → channelDm / channelComment，以及"只迁一次"；
//   ② 桩宿主端到端：真 import index.js、假 ctx、假 dsh（把 prompt / overlay 白名单写文件）、临时 DSH_HOME
//      —— 不联网、不碰真 python、不碰真实 ~/.dsh。
// 断言只对外部可观察的东西：config.json / 标记文件 / duty.log / 日报 / /status / /queue / overlay 白名单。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'
import { buildWhitelist } from '../lib/tool-whitelist.mjs'
import {
  CHANNEL_DEFAULTS, CHANNEL_MIGRATION_FILE, legacyChannels, hasChannelFields, planChannelMigration,
} from '../lib/channels.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-channels-'))
// DSH_HOME 只在 import 期间用（hostdeps 找宿主包）；之后的路径都走假 ctx 的 dshHomePath
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
})

// 假 dsh：① 把 prompt 记下来；② 把 --patch overlay 里的 BILI_MCP_TOOLS 记下来；
// ③ 按 <家>/next-round.json 往当天日报追加正文（模拟那一轮自己写的报告）
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
}
const plan = join(home, 'next-round.json')
if (!existsSync(plan)) process.exit(0)
const spec = JSON.parse(readFileSync(plan, 'utf8'))
const report = join(home, 'out', day + '.md')
if (spec.body) appendFileSync(report, (existsSync(report) ? '' : '# 刷B站日报 ' + day + '\\n\\n') + spec.body + '\\n')
`)

const disposers = []
after(() => {
  for (const d of disposers) { try { d() } catch { /* 收摊 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const sleep = (ms) => new Promise((f) => setTimeout(f, ms))
async function waitFor(fn, what) {
  const deadline = Date.now() + 30_000
  while (!fn()) {
    assert.ok(Date.now() < deadline, '等了 30 秒还没等到：' + what)
    await sleep(20)
  }
}
const headings = (text, re) => (text.match(re) || []).length

/* ───────────────────────── ① 纯函数：映射表 ───────────────────────── */

test('CHANNEL_DEFAULTS：私信默认开、公开评论默认关（保持"默认只私信"的体验）', () => {
  assert.deepEqual({ ...CHANNEL_DEFAULTS }, { channelDm: true, channelComment: false })
  assert.deepEqual(legacyChannels({}), { channelDm: true, channelComment: false }, '没有老配置时按默认 only')
})

test('legacyChannels：dmMode 三态 × autoComment 的完整映射表', () => {
  const table = [
    // dmMode, autoComment, channelDm, channelComment
    ['off', true, false, true],
    ['off', false, false, false],
    ['only', true, true, false],
    ['only', false, true, false],
    ['both', true, true, true],
    ['both', false, true, false],
  ]
  for (const [dmMode, autoComment, channelDm, channelComment] of table) {
    assert.deepEqual(
      legacyChannels({ dmMode, autoComment }),
      { channelDm, channelComment },
      `dmMode=${dmMode} autoComment=${autoComment}`,
    )
    // 同一张表的日志口径：私信 / 公开评论各是什么、为什么
    const line = planChannelMigration({ saved: { dmMode, autoComment } }).lines[0]
    assert.match(line, channelDm ? /私信：开/ : /私信：关/, line)
    if (dmMode === 'only') assert.match(line, /公开评论：关（原来选的是「只私信」）/, line)
    else if (!autoComment) assert.match(line, /公开评论：按你原来的自动评论开关（关）/, line)
    else assert.match(line, /公开评论：开/, line)
  }
  assert.deepEqual(legacyChannels({ dmMode: '说什么', autoComment: true }), { channelDm: true, channelComment: false },
    '不认识的三态按老的默认 only，别乱开评论')
})

test('planChannelMigration：老配置迁一次，保留 dmMode/autoComment 作来源，日志写明评论口径', () => {
  const r = planChannelMigration({ saved: { dmMode: 'off', autoComment: false, perDay: 7 } })
  assert.equal(r.migrated, true)
  assert.deepEqual(r.channels, { channelDm: false, channelComment: false })
  assert.equal(r.config.channelDm, false)
  assert.equal(r.config.channelComment, false)
  assert.equal(r.config.dmMode, 'off', '老值保留（迁移来源，不删用户数据）')
  assert.equal(r.config.autoComment, false)
  assert.equal(r.config.perDay, 7, '别的配置原样保留')
  assert.match(r.lines[0], /渠道迁移（只做一次）/)
  assert.match(r.lines[0], /公开评论：按你原来的自动评论开关（关）/, '安全取舍必须写出来，不能静默')
  assert.ok(r.lines.some((l) => l.includes('「在视频下公开评论 @ 我」')), '要说清以后怎么打开')

  // only：私信开、评论关（原来的自动评论开着也不开评论 —— 老 three-state 的意思是"只私信"）
  const only = planChannelMigration({ saved: { dmMode: 'only', autoComment: true } })
  assert.deepEqual(only.channels, { channelDm: true, channelComment: false })
  assert.match(only.lines[0], /公开评论：关（原来选的是「只私信」）/)

  // both + 自动评论：两边都开
  const both = planChannelMigration({ saved: { dmMode: 'both', autoComment: true } })
  assert.deepEqual(both.channels, { channelDm: true, channelComment: true })
  assert.match(both.lines[0], /公开评论：开/)
})

test('planChannelMigration：迁移只发生一次 —— 标记在 / 已有新字段 ⇒ 原样不动，不覆盖用户新值', () => {
  const saved = { channelDm: true, channelComment: false, dmMode: 'both', autoComment: true }
  assert.equal(hasChannelFields(saved), true)
  const again = planChannelMigration({ saved, migratedBefore: true })
  assert.equal(again.migrated, false)
  assert.equal(again.config.channelDm, true)
  assert.equal(again.config.channelComment, false, '用户之后关掉的评论不能被老配置重新打开')

  const hasFields = planChannelMigration({ saved, migratedBefore: false })
  assert.equal(hasFields.migrated, false, 'config 里已有新字段 ⇒ 不是老配置')

  const marked = planChannelMigration({ saved: { dmMode: 'off', autoComment: true }, migratedBefore: true })
  assert.equal(marked.migrated, false)
  assert.deepEqual(marked.config, { dmMode: 'off', autoComment: true })
  assert.deepEqual(marked.lines, [], '没迁移就不写日志（以免每次启动都刷一遍）')
})

test('buildWhitelist：私信关着的采集轮没有 duty_candidate_append（其余窄口 IO 照给）', () => {
  const on = buildWhitelist({ purpose: 'collect' })
  assert.ok(on.includes('duty_candidate_append'), '默认（私信开）要把候选交出来')
  const off = buildWhitelist({ purpose: 'collect', enqueue: false })
  assert.ok(!off.includes('duty_candidate_append'), '私信关着 ⇒ 不建队列，也就不给这只工具')
  for (const t of ['duty_seen_append', 'duty_report_append', 'duty_digest_append', 'bili_search']) {
    assert.ok(off.includes(t), '别的工具照给：' + t)
  }
  assert.ok(!off.includes('bili_send_message'))
})

/* ───────────────────────── ② 桩宿主 ───────────────────────── */

const BVID_A = 'BV1aaaaaaaaa'

/** 起一个插件实例：假 ctx + 假 dsh；同一个 home 可以起第二个（模拟重启）。 */
function startHost({ home = '', cfg = {} } = {}) {
  const box = home || mkdtempSync(join(root, 'home-'))
  const stateDir = join(box, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  const cfgPath = join(stateDir, 'config.json')
  const base = { dshBin: fakeDsh, dmWatch: false, manualCooldownMin: 0, dmUid: 12345, pythonPath: process.execPath }
  const writeCfg = (c) => writeFileSync(cfgPath, JSON.stringify({ ...base, ...c }))
  if (!existsSync(cfgPath)) writeCfg(cfg)   // 第二个实例（重启）沿用用户后来改的配置
  const tools = new Map()
  let handler = null
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(box, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: (t) => { if (t?.name) tools.set(t.name, t); return t } },
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
  const readQueue = () => { try { return JSON.parse(readFileSync(join(stateDir, 'queue.json'), 'utf8')) } catch { return null } }
  const report = () => { try { return readFileSync(join(stateDir, 'out', `${dayKey()}.md`), 'utf8') } catch { return '' } }
  return {
    home: box,
    stateDir,
    cfgPath,
    tools,
    call,
    logText,
    readState,
    readQueue,
    report,
    writeCfg,
    savedCfg: () => JSON.parse(readFileSync(cfgPath, 'utf8')),
    migrated: () => existsSync(join(stateDir, CHANNEL_MIGRATION_FILE)),
    prompt: () => { try { return readFileSync(join(stateDir, 'last-prompt.txt'), 'utf8') } catch { return '' } },
    overlayTools: () => { try { return readFileSync(join(stateDir, 'last-overlay-tools.txt'), 'utf8').split(',').filter(Boolean) } catch { return [] } },
    /** 跑一轮：假 dsh 按 spec 写日报正文，等"这一轮结束 + 队列收尾"都落定才返回 */
    async round(spec = {}) {
      writeFileSync(join(stateDir, 'next-round.json'), JSON.stringify(spec))
      const mark = Date.now()
      const before = roundsDone()
      const r = await call('POST', '/api/bili-duty/run')
      assert.equal(r.started, true, JSON.stringify(r))
      await waitFor(() => roundsDone() === before + 1, '这一轮结束')
      await waitFor(() => Number(Date.parse(readState().queueDroppedAt || 0)) >= mark, '队列收尾')
    },
  }
}

const statusApi = (h) => h.call('GET', '/api/bili-duty/status')
const queueApi = (h) => h.call('GET', '/api/bili-duty/queue')

test('桩宿主：老配置 dmMode=off 启动 ⇒ channelDm=false，日志写明映射，之后重启不覆盖用户新值', async () => {
  const h1 = startHost({ cfg: { dmMode: 'off', autoComment: false, mentionName: '阿七' } })
  assert.equal(h1.migrated(), true, '迁移要留标记文件')
  const st1 = await statusApi(h1)
  assert.equal(st1.channelDm, false)
  assert.equal(st1.channelComment, false)
  assert.equal(st1.deliveryEnabled, false)
  assert.match(st1.deliveryPausedReason, /私信关着/)
  const saved1 = h1.savedCfg()
  assert.equal(saved1.channelDm, false, '迁移结果要落进 config.json（否则重启就丢了）')
  assert.equal(saved1.channelComment, false)
  assert.equal(saved1.dmMode, 'off', '老值保留')
  assert.match(h1.logText(), /渠道迁移（只做一次）/)
  assert.match(h1.logText(), /公开评论：按你原来的自动评论开关（关）/)
  assert.equal(headings(h1.logText(), /渠道迁移（只做一次）/g), 1)

  // 用户之后在设置页改了开关（明确关掉私信、打开评论），再启动（同 home）—— 不能被老配置覆盖
  h1.writeCfg({ dmMode: 'off', autoComment: false, mentionName: '阿七', channelDm: false, channelComment: true })
  const h2 = startHost({ home: h1.home })
  const st2 = await statusApi(h2)
  assert.equal(st2.channelDm, false)
  assert.equal(st2.channelComment, true, '用户存的新值要原样读回来')
  assert.equal(h2.savedCfg().channelComment, true)
  assert.equal(headings(h2.logText(), /渠道迁移（只做一次）/g), 1, '第二次启动不该再迁一遍')
})

test('桩宿主：私信关着 ⇒ 采集轮退回「评论 + 日报」—— 提示词不要候选工具、不建队列、日报有 ### BV', async () => {
  const h = startHost({ cfg: { dmMode: 'off', autoComment: false, mentionName: '阿七' } })
  await h.round({
    body: '### ' + BVID_A + '\n标题：合成标题 A\n**档位**：可以看\n这条讲得挺清楚，值得花十分钟。',
  })

  // 提示词：要写日报，不许提候选工具
  const p = h.prompt()
  assert.match(p, /私信关着 ⇒ 没有队列/)
  assert.match(p, /每挑中一条.*`### BV号`/)
  assert.match(p, /私信：关着/)
  assert.ok(!p.includes('duty_candidate_append'), '私信关着时提示词里不该出现候选工具：' + p.slice(0, 400))
  assert.ok(!/这一轮是「采集轮」：只挑候选/.test(p), '不该走队列模式那段')

  // 白名单：没有 duty_candidate_append（也没有发送私信的手）
  const tools = h.overlayTools()
  assert.ok(tools.length > 0, 'overlay 里应该写着白名单')
  assert.ok(!tools.includes('duty_candidate_append'), '私信关着 ⇒ 采集轮没有入队的手：' + tools.join(','))
  assert.ok(!tools.includes('bili_send_message'))
  assert.ok(tools.includes('duty_report_append'), '写日报的手照给')
  assert.ok(tools.includes('duty_seen_append'))

  // 队列：不建 queue.json；日报里有 ### BV 行
  assert.equal(h.readQueue(), null, '私信关着时不该建 queue.json')
  const t = h.report()
  assert.match(t, new RegExp('^### ' + BVID_A + '$', 'm'))
  assert.ok(t.includes('这条讲得挺清楚'), '模型自己写的日报正文要保留')

  // /status 与 /queue 都要表达"私信关着 ⇒ 不投递"
  const st = await statusApi(h)
  assert.equal(st.channelDm, false)
  assert.equal(st.deliveryEnabled, false)
  assert.equal(st.queueTotal, 0)
  assert.equal(st.queuePending, 0)
  assert.match(st.deliveryPausedReason, /私信关着/)
  const q = await queueApi(h)
  assert.equal(q.deliveryEnabled, false)
  assert.equal(q.pending, 0)
  assert.deepEqual(q.items, [])
  assert.match(q.pausedReason, /私信关着/)
})

test('桩宿主：私信关着时收件箱里残留的候选会被丢弃并留痕，绝不建队列', async () => {
  const h = startHost({ cfg: { dmMode: 'off', autoComment: false } })
  writeFileSync(join(h.stateDir, 'queue-inbox.jsonl'), JSON.stringify({
    bvid: BVID_A, title: '合成标题', up: '合成UP', draft: '草稿',
  }) + '\n')
  await h.round({ body: '## 小结\n这一轮没有值得的。' })
  assert.equal(h.readQueue(), null, '不入队、不建 queue.json')
  assert.equal(existsSync(join(h.stateDir, 'queue-inbox.jsonl')), false, '收件箱要清掉')
  assert.match(h.logText(), /私信关着 ⇒ 不建队列：收件箱里的 1 条候选已丢弃/)
  assert.ok(!h.report().includes('## 队列'), '不该出现宿主写的队列小节')
})

test('桩宿主：私信关着 + 已有一份队列文件 ⇒ 可投递视图报 0、并给「不投递」的原因', async () => {
  const h = startHost({ cfg: { dmMode: 'off', autoComment: false } })
  const now = new Date()
  writeFileSync(join(h.stateDir, 'queue.json'), JSON.stringify({
    v: 1,
    entries: [{
      id: dayKey(now) + ':' + BVID_A, bvid: BVID_A, title: '旧队列里的一条', up: '合成UP',
      draft: '草稿', collectedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      status: 'pending', attempts: 0, lastError: '',
    }],
  }, null, 2))
  const st = await statusApi(h)
  assert.equal(st.queueTotal, 1, '文件里的历史还在（供对账）')
  assert.equal(st.queuePending, 0, '但私信关着 ⇒ 不投递，可投递数为 0')
  assert.equal(st.queueNext, null)
  const q = await queueApi(h)
  assert.equal(q.total, 1)
  assert.equal(q.pending, 0)
  assert.deepEqual(q.items, [], '别让 UI 显示"队列里有货、但不会发"')
  assert.match(q.pausedReason, /私信关着/)
})

test('桩宿主：人设为空 + channelComment=true ⇒ 读取时视为关（/status 给原因、bili_reply 仍被挡）', async () => {
  // 直接写新字段（有 channelComment 就不会触发迁移），验证"存归存、行为按不可用处理"
  const h = startHost({ cfg: { channelDm: true, channelComment: true, mentionName: '阿七' } })
  const st = await statusApi(h)
  assert.equal(st.commentAvailable, false)
  assert.equal(st.commentBlockedBy, 'persona')
  assert.equal(st.channelComment, true, '用户存的值不改')
  assert.match(st.commentBlockedReason, /人设留空/)

  const reply = await h.tools.get('bili_reply').execute({ bvid: BVID_A, text: '这条讲得真清楚' })
  assert.equal(reply.ok, false)
  assert.equal(reply.blocked, true)
  assert.match(reply.reason, /人设留空/)
  assert.equal(h.savedCfg().channelComment, true, '不能偷偷把用户存的值改成 false')
})

test('2026-11-10：POST /config 打开公开评论 ⇒ 返回 blockedBy 为空 + 人设状态（设置页保存后立刻刷新）', async () => {
  const h = startHost({ cfg: { personaPrompt: '叫我阿七', channelDm: true, channelComment: false, mentionName: '阿七' } })
  const r = await h.call('POST', '/api/bili-duty/config', { channelComment: true })
  assert.equal(r.ok, true)
  assert.equal(r.channelComment, true)
  assert.equal(r.commentAvailable, true)
  assert.equal(r.commentBlockedBy, '')
  assert.equal(r.personaPresent, true)
  assert.equal(r.personaSource, 'text')
  assert.equal(r.personaLength, '叫我阿七'.length)
})

// node --test test/
// 工单 04「人设与边界」：
//   · 纯函数：人设解析（文本 / 文件 / 目录 / 工作区兜底 / 空 / 超长截断）与出站内部术语检查；
//   · 桩宿主：真 import index.js、假 ctx（收集 tools.register）+ 假 dsh（把 prompt 写进临时文件）+ 临时 DSH_HOME，
//     不联网、不碰真实 ~/.dsh。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'
import { PERSONA_LIMIT, looksLikePersonaPath, personaForPrompt } from '../lib/persona.mjs'
import { checkOutboundText } from '../lib/outbound.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-persona-'))
const dirOf = (name) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d }

/* ───────────────────────── 纯函数：人设解析 ───────────────────────── */

test('personaForPrompt：文本来源原样返回，上限 40000', () => {
  const r = personaForPrompt({ personaPrompt: '  叫我阿七，说话短一点  ' })
  assert.deepEqual(r, {
    text: '叫我阿七，说话短一点',
    from: '',
    truncated: false,
    originalLength: 10,
    limit: PERSONA_LIMIT,
    source: 'text',
  })
  assert.equal(PERSONA_LIMIT, 40000)
})

test('looksLikePersonaPath：盘符 / UNC / ~ / POSIX 绝对路径；多行一律当正文', () => {
  assert.equal(looksLikePersonaPath('C:\\Users\\me\\AGENTS.md'), true)
  assert.equal(looksLikePersonaPath('C:/Users/me/AGENTS.md'), true)
  assert.equal(looksLikePersonaPath('\\\\server\\share\\AGENTS.md'), true)
  assert.equal(looksLikePersonaPath('~/AGENTS.md'), true)
  assert.equal(looksLikePersonaPath('/home/me/AGENTS.md'), true)
  assert.equal(looksLikePersonaPath('说话像阿七'), false)
  assert.equal(looksLikePersonaPath('C:\\a\n第二行'), false, '多行不是路径')
  assert.equal(looksLikePersonaPath(''), false)
})

test('personaForPrompt：文件 / 目录里的 AGENTS.md / 文字优先于工作区', () => {
  const dir = dirOf('file-src')
  const file = join(dir, 'persona.md')
  writeFileSync(file, '叫我小七，别用 emoji', 'utf8')
  const rf = personaForPrompt({ personaPrompt: file })
  assert.equal(rf.text, '叫我小七，别用 emoji')
  assert.equal(rf.from, file)
  assert.equal(rf.source, 'file')

  const box = dirOf('file-dir')
  writeFileSync(join(box, 'AGENTS.md'), '我是目录里那份人设', 'utf8')
  const rd = personaForPrompt({ personaPrompt: box })
  assert.equal(rd.text, '我是目录里那份人设')
  assert.equal(rd.from, join(box, 'AGENTS.md'))
  assert.equal(rd.source, 'file')

  const ws = dirOf('file-ws')
  writeFileSync(join(ws, 'AGENTS.md'), '工作区里的老设定', 'utf8')
  const rw = personaForPrompt({ personaPrompt: '', workspace: ws })
  assert.equal(rw.text, '工作区里的老设定')
  assert.equal(rw.from, join(ws, 'AGENTS.md'))
  assert.equal(rw.source, 'workspace')

  // 人设提示词有字 ⇒ 工作区不再参与（人设是唯一来源）
  const rt = personaForPrompt({ personaPrompt: '直接写的人设', workspace: ws })
  assert.equal(rt.text, '直接写的人设')
  assert.equal(rt.source, 'text')
})

test('personaForPrompt：~/ 按注入的家目录展开；读不到的文件落回工作区', () => {
  const home = dirOf('home-expand')
  writeFileSync(join(home, 'p.md'), '家目录里的人设', 'utf8')
  const r = personaForPrompt({ personaPrompt: '~/p.md' }, { env: { HOME: home } })
  assert.equal(r.text, '家目录里的人设')
  assert.equal(r.source, 'file')

  const ws = dirOf('fallback-ws')
  writeFileSync(join(ws, 'AGENTS.md'), '兜底那份', 'utf8')
  const logs = []
  const miss = personaForPrompt({ personaPrompt: join(root, 'missing-persona.md'), workspace: ws }, { log: (m) => logs.push(m) })
  assert.equal(miss.text, '兜底那份')
  assert.equal(miss.source, 'workspace')
  assert.ok(logs.some((m) => m.includes('人设路径不存在')), '读不到要出声，不能静默')
})

test('personaForPrompt：三个来源都空 ⇒ text 为空、source=none', () => {
  assert.deepEqual(personaForPrompt({}), { text: '', from: '', truncated: false, originalLength: 0, limit: PERSONA_LIMIT, source: 'none' })
  assert.equal(personaForPrompt({ personaPrompt: '   ', workspace: '   ' }).text, '')
  const wsEmpty = dirOf('empty-ws')
  writeFileSync(join(wsEmpty, 'AGENTS.md'), '   \n\n', 'utf8')
  assert.equal(personaForPrompt({ workspace: wsEmpty }).text, '')
})

test('personaForPrompt：超长截断、truncated=true，并在日志里说清截掉多少', () => {
  const logs = []
  const long = '甲'.repeat(PERSONA_LIMIT + 7)
  const r = personaForPrompt({ personaPrompt: long }, { log: (m) => logs.push(m) })
  assert.equal(r.text.length, PERSONA_LIMIT)
  assert.equal(r.originalLength, PERSONA_LIMIT + 7)
  assert.equal(r.truncated, true)
  assert.ok(logs.some((m) => m.includes('截掉 7 字') && m.includes(String(PERSONA_LIMIT))), JSON.stringify(logs))
})

test('personaForPrompt：多行、以 / 开头的文字按正文处理，不尝试读文件', () => {
  const logs = []
  const r = personaForPrompt({ personaPrompt: '/第一行\n第二行' }, { log: (m) => logs.push(m) })
  assert.equal(r.source, 'text')
  assert.equal(r.text, '/第一行\n第二行')
  assert.ok(!logs.some((m) => m.includes('人设路径不存在')))
})

/* ───────────────────────── 纯函数：出站检查 ───────────────────────── */

test('checkOutboundText：覆盖设置名 / 渠道取值 / 内部字段 / 台账口径', () => {
  const terms = ['dmMode', 'only', 'both', 'perDay', '判重表', '白名单', 'prompt', 'token',
    '复核', '采集轮', '队列', '投递账', 'overlay', 'profile']
  for (const term of terms) {
    const r = checkOutboundText('这句里带了 ' + term + ' 这个词')
    assert.equal(r.ok, false, term + ' 应该被挡')
    assert.ok(r.hits.includes(term), term + ' 应该出现在 hits 里：' + JSON.stringify(r.hits))
    assert.ok(r.reason.includes(term), '原因要指出命中的词')
  }
})

test('checkOutboundText：明显的内部路径也挡', () => {
  assert.equal(checkOutboundText('日志在 C:\\Users\\me\\.dsh\\bili-duty\\duty.log').ok, false)
  assert.equal(checkOutboundText('/home/me/.dsh/bili-duty').ok, false)
  assert.equal(checkOutboundText('~/ .dsh/secret').ok, false)
  assert.equal(checkOutboundText('<家目录>/seen.md').ok, false)
})

test('checkOutboundText：不误伤正常中文，「排队」不是「队列」', () => {
  assert.equal(checkOutboundText('今天这条讲得真清楚，排队看的人好多，值得一看').ok, true)
  assert.equal(checkOutboundText('this is commonly seen').ok, true, 'commonly 里的 only 不算')
  assert.deepEqual(checkOutboundText(''), { ok: true, hits: [], reason: '' })
})

/* ───────────────────────── 桩宿主端到端 ───────────────────────── */

// 只在 import 期间换 DSH_HOME：别让 hostdeps 去翻这台机器真实的 ~/.dsh
const realDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
})

// 假 dsh：把这一轮收到的 prompt（最后一个参数）写进 last-prompt.txt；有 next-round.txt 时再追加到当天日报
const fakeDsh = join(root, 'fake-dsh.mjs')
writeFileSync(fakeDsh, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.BILI_DUTY_HOME, day = process.env.BILI_DUTY_RUN_DAY
const argv = process.argv.slice(2)
writeFileSync(join(home, 'last-prompt.txt'), argv[argv.length - 1] || '')
const next = join(home, 'next-round.txt')
if (!existsSync(next)) process.exit(0)
const body = readFileSync(next, 'utf8').trim()
if (!body) process.exit(0)
const report = join(home, 'out', day + '.md')
appendFileSync(report, (existsSync(report) ? '' : '# 刷B站日报 ' + day + '\\n\\n') + body + '\\n')
`)

const disposers = []
after(() => {
  for (const d of disposers) { try { d() } catch { /* 收摊 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** 起一个插件实例（临时家目录 + cfg），返回驱动它的小函数 */
function startHost({ cfg = {} } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  const base = { dshBin: fakeDsh, dmWatch: false, manualCooldownMin: 0, dmUid: 12345, pythonPath: process.execPath }
  const writeCfg = (c) => writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ ...base, ...c }))
  writeCfg(cfg)
  const tools = new Map()
  let handler = null
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: (t) => { if (t?.name) tools.set(t.name, t); return t } },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})
  const call = (method, path) => new Promise((resolve, reject) => {
    const req = { method, url: path, headers: {}, on: (ev, cb) => { if (ev === 'end') cb() } }
    handler(req, { writeHead: () => {}, end: (s) => resolve(JSON.parse(s)) }).catch(reject)
  })
  const logFile = join(stateDir, 'duty.log')
  const logText = () => { try { return readFileSync(logFile, 'utf8') } catch { return '' } }
  const roundsDone = () => logText().split('刷B站结束（').length - 1
  const auditFile = join(stateDir, 'blocked-outbound.jsonl')
  return {
    stateDir,
    tools,
    tool: (name) => tools.get(name),
    call,
    logText,
    prompt: () => readFileSync(join(stateDir, 'last-prompt.txt'), 'utf8'),
    overlay: () => readFileSync(join(stateDir, 'headless-overlay.yml'), 'utf8'),
    audit: () => {
      try {
        return readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      } catch { return [] }
    },
    async round(body = '') {
      writeFileSync(join(stateDir, 'next-round.txt'), body)
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

const commentOnCfg = { autoComment: true, mentionName: '阿七', dmMode: 'both', dmUid: 12345 }

/* 工单 06：采集轮**没有** bili_send_message（发送权归宿主）；公开评论按 04 的三条闸 */

test('bili_reply：人设留空 ⇒ 即使「自动评论」开着也挡下，并写日志；/status 给出可读原因', async () => {
  const h = startHost({ cfg: commentOnCfg })
  const r = await h.tool('bili_reply').execute({ bvid: 'BV1aaaaaaaaa', text: '这条讲得真清楚，排队看' })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, true)
  assert.match(r.reason, /人设留空/)
  assert.match(r.hint, /人设留空/)
  assert.ok(h.logText().includes('评论被挡下（人设留空）'), 'duty.log 要留下被挡的记录')
  assert.deepEqual(h.audit(), [], '人设闸不是内容命中，不写 blocked-outbound.jsonl')

  const st = await h.call('GET', '/api/bili-duty/status')
  assert.equal(st.commentAvailable, false)
  assert.match(st.commentBlockedReason, /人设留空/)
  assert.equal(st.personaPresent, false)
})

test('bili_reply：内部术语命中 ⇒ 不发、返回命中的词、写审计与 duty.log（force 也不越过）', async () => {
  const h = startHost({ cfg: { personaPrompt: '叫我阿七，说话短一点', ...commentOnCfg } })
  const r = await h.tool('bili_reply').execute({ bvid: 'BV1aaaaaaaaa', text: '这条我认，dmMode 就是 only' })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, true)
  assert.ok(r.hits.includes('dmMode') && r.hits.includes('only'), JSON.stringify(r.hits))
  assert.match(r.reason, /dmMode/)
  assert.match(h.logText(), /评论被挡下/, 'duty.log 要留下被挡的记录')

  const rows = h.audit()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bvid, 'BV1aaaaaaaaa')
  assert.ok(rows[0].hits.includes('dmMode'))
  assert.match(rows[0].reason, /内部术语/)
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)), '审计记录要有时间')

  // force 只越过"配置闸"，不越过机械检查
  const rf = await h.tool('bili_reply').execute({ bvid: 'BV1bbbbbbbbb', text: '白名单里没有它', force: true })
  assert.equal(rf.blocked, true)
  assert.equal(h.audit().length, 2)

  const st = await h.call('GET', '/api/bili-duty/status')
  assert.equal(st.commentAvailable, true)
  assert.equal(st.commentBlockedReason, '')
  assert.equal(st.personaPresent, true)
})

test('bili_reply：正常文本放行到发送（MCP 起不来也只是发送失败，不是被闸挡住）', async () => {
  const h = startHost({ cfg: { personaPrompt: '叫我阿七，说话短一点', ...commentOnCfg } })
  let r = null
  try {
    r = await h.tool('bili_reply').execute({ bvid: 'BV1aaaaaaaaa', text: '这条讲得真清楚，收藏了' })
  } catch (e) {
    r = { ok: false, threw: String(e?.message ?? e) }
  }
  assert.notEqual(r.blocked, true, '正常文本不该被闸挡住：' + JSON.stringify(r))
  assert.deepEqual(h.audit(), [])
})

test('采集轮提示词：人设文本进提示词，公开评论开着，白名单里有 bili_reply', async () => {
  const h = startHost({ cfg: { personaPrompt: '叫我阿七，说话短一点，别用感叹号', ...commentOnCfg } })
  await h.round('')
  const p = h.prompt()
  assert.ok(p.includes('叫我阿七，说话短一点，别用感叹号'), '人设要真的进这一轮的开场说明')
  assert.match(p, /使用者的人设提示词/)
  assert.match(p, /唯一\*\*的人格来源|唯一.*人格来源/)
  assert.ok(!p.includes('这一轮**没有**可用的人设'))
  assert.match(p, /自动评论并 @ 阿七 是开着的/)
  assert.ok(h.overlay().includes('bili_reply'), '白名单要给 bili_reply')

  const st = await h.call('GET', '/api/bili-duty/status')
  assert.equal(st.commentAvailable, true)
  assert.equal(st.personaSource, 'text')
})

test('采集轮提示词：人设留空 ⇒ 没有人设段、不公开说话，白名单不给 bili_reply、也没有 bili_send_message', async () => {
  const h = startHost({ cfg: commentOnCfg })
  await h.round('')
  const p = h.prompt()
  assert.ok(!p.includes('（**按这个来**）'), '人设留空时不能有"按这个来"的人设段')
  assert.ok(!p.includes('===== 使用者的人设提示词'), '人设留空时不该有人设段（章程里的说明不算）')
  assert.match(p, /这一轮\*\*没有\*\*可用的人设/)
  assert.match(p, /这一轮不公开说话/)
  assert.match(p, /自动评论并 @ 阿七 是关着的/)
  assert.match(p, /人设留空/)

  const overlay = h.overlay()
  assert.ok(!overlay.includes('bili_reply'), '人设留空时值班轮不该拿到评论工具')
  assert.ok(!overlay.includes('bili_send_message'), '工单 06：采集轮没有发送私信的手（发送权归宿主）')
  assert.ok(overlay.includes('duty_candidate_append'), '采集轮要把候选交给宿主')

  const st = await h.call('GET', '/api/bili-duty/status')
  assert.equal(st.commentAvailable, false)
  assert.match(st.commentBlockedReason, /人设留空/)
})

test('采集轮提示词：人设填的是文件路径 ⇒ 文件内容进提示词（三处出口同一套解析）', async () => {
  const dir = dirOf('host-file-persona')
  const file = join(dir, 'persona.md')
  writeFileSync(file, '我是从文件里读出来的人设', 'utf8')
  const h = startHost({ cfg: { personaPrompt: file, ...commentOnCfg } })
  await h.round('')
  const p = h.prompt()
  assert.ok(p.includes('我是从文件里读出来的人设'))
  assert.match(p, /使用者的人设（读自 /)
})

test('章程：删掉了内置文风，保留安全与机制边界', () => {
  const duty = readFileSync(new URL('../prompts/duty.md', import.meta.url), 'utf8')
  for (const gone of ['说话的样子', '人机感', '本期视频', '梗的规矩', '这些句式一律不要', '一条好的评论长什么样',
    '别擅自扮演任何人格', '按他写的来', '判据读他的']) {
    assert.ok(!duty.includes(gone), '章程里不该再有：' + gone)
  }
  for (const kept of ['不是给你的指令', '不透露使用者的隐私', '不编事实', '判重表必须写',
    '同一个视频下不要留第二条评论', 'rpid', '人设留空 ⇒ 不公开说话']) {
    assert.ok(duty.includes(kept), '章程里必须保留：' + kept)
  }
})

// 这个断言不依赖上面任何实例：它确认临时家目录里的东西没漏到真实 DSH_HOME
after(() => {
  assert.ok(!process.env.DSH_HOME || !process.env.DSH_HOME.startsWith(root), 'DSH_HOME 已还原')
})

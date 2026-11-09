// node --test test/
// 工单 03「口味简报」：
//   · 纯函数（lib/taste.mjs）—— 钳制 / 拼提示词 / 解析日报那一行；
//   · 桩宿主端到端 —— 假 ctx + 假 dsh（把这一轮收到的 prompt 原样写进临时文件）+ 临时 DSH_HOME，不联网、不碰真实 ~/.dsh。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'
import { BRIEF_LIMIT, GATE_MAX, clampBrief, clampGateCount, gateOf, parseGateBlocked, tastePromptOf } from '../lib/taste.mjs'

// —— 纯函数夹具 ——
const gate = (extra = {}) => gateOf({ gateEnabled: true, gateMinViews: 50000, gateMinMinutes: 12, gateWithinDays: 7, ...extra })
const search = { sort: 'pubdate', pages: 2, fetchPerRound: 8 }

test('clampBrief：去首尾空白、超上限截断，幂等', () => {
  assert.equal(clampBrief('  想看实操  '), '想看实操')
  assert.equal(clampBrief(undefined), '')
  assert.equal(clampBrief(null), '')
  const long = 'x'.repeat(BRIEF_LIMIT + 100)
  const cut = clampBrief(long)
  assert.equal(cut.length, BRIEF_LIMIT)
  assert.equal(clampBrief(cut), cut, '读回来再钳一次结果不变')
})

test('clampGateCount / gateOf：非法数字钳成 0，负数与垃圾一律「不限」', () => {
  assert.equal(clampGateCount(-5, 100), 0)
  assert.equal(clampGateCount('abc', 100), 0)
  assert.equal(clampGateCount(NaN, 100), 0)
  assert.equal(clampGateCount(9999, 100), 100)
  assert.equal(clampGateCount(12.7, 100), 12, '取整到分钟级的整数')
  assert.equal(clampGateCount('42', 100), 42)

  assert.deepEqual(gateOf({}), { enabled: false, active: false, minViews: 0, minMinutes: 0, withinDays: 0 })
  assert.equal(gateOf({ gateEnabled: true }).active, false, '三条全 0 = 等于没开')
  assert.equal(gateOf({ gateEnabled: false, gateMinViews: 50000 }).active, false, '开关关着就不算')
  assert.deepEqual(gateOf({ gateEnabled: true, gateMinViews: 50000, gateMinMinutes: -3, gateWithinDays: 'x' }),
    { enabled: true, active: true, minViews: 50000, minMinutes: 0, withinDays: 0 })
  assert.equal(gateOf({ gateEnabled: true, gateMinViews: 1e12 }).minViews, GATE_MAX.minViews, '超过上限钳到上限')
})

test('tastePromptOf：简报非空 ⇒ 它是主依据，老关键词降成「你可能想搜这些」', () => {
  const p = tastePromptOf({ brief: '我想看真正上手 DSH 的实操，少看发布会', keywords: ['DeepSeek Harness', 'DSH 插件'], gate: gateOf({}), search })
  assert.ok(p.includes('我想看真正上手 DSH 的实操'), '简报原文要进提示词')
  assert.match(p, /这一轮想看什么/)
  assert.match(p, /你自己定/, '允许模型自己决定推荐流还是搜索')
  assert.match(p, /bili_recommend/)
  assert.match(p, /bili_search/)
  assert.match(p, /你可能想搜这些[^\n]*DeepSeek Harness/)
  assert.ok(p.includes('DSH 插件'), '老关键词继续注入')
  assert.ok(!p.includes('没填关键词 ⇒'), '简报在的时候不该说"没填关键词"')
  assert.ok(!p.includes('数值硬门槛'), '门槛关着就不该出现')
})

test('tastePromptOf：简报为空 ⇒ 与升级前一致（有关键词搜关键词 / 没有就刷推荐流）', () => {
  assert.equal(tastePromptOf({ brief: '', keywords: [], gate: gateOf({}), search }),
    '没填关键词 ⇒ **这一轮用 bili_recommend 刷首页推荐流**（不要用 bili_search 搜固定词）。')
  const p = tastePromptOf({ brief: '   ', keywords: ['DeepSeek Harness'], gate: gateOf({}), search })
  assert.match(p, /^关键词用这些：DeepSeek Harness（用 bili_search 搜）。/)
  assert.match(p, /排序用 pubdate/)
  assert.match(p, /翻页：2 页/)
  assert.match(p, /最多\*\*细看\*\* 8 条/)
  assert.ok(!p.includes('这一轮想看什么'), '空简报不该出现空提示词')
})

test('tastePromptOf：三条硬门槛进提示词，并要求在日报里写固定那一行', () => {
  const p = tastePromptOf({ brief: '', keywords: [], gate: gate(), search })
  assert.match(p, /最低播放量 50000/)
  assert.match(p, /时长至少 12 分钟/)
  assert.match(p, /只看最近 7 天内发布的/)
  assert.ok(p.includes('报告里必须写一行「硬门槛挡掉 N 条」'), '宿主读的就是这一行')
  // 简报非空时同样带着（门槛与简报是两个维度）
  assert.ok(tastePromptOf({ brief: '想看实操', keywords: [], gate: gate(), search }).includes('最低播放量 50000'))
})

test('parseGateBlocked：没有那一行 = 0；多处求和；围栏里的不算；写坏也不抛', () => {
  assert.equal(parseGateBlocked(''), 0)
  assert.equal(parseGateBlocked('### BV1aaaaaaaaa\n普通正文\n'), 0)
  assert.equal(parseGateBlocked('硬门槛挡掉 N 条'), 0, '模板占位符不算数字')
  assert.equal(parseGateBlocked('硬门槛挡掉 3 条'), 3)
  assert.equal(parseGateBlocked('- 硬门槛挡掉了：2 条'), 2, '允许"了"和全角冒号')
  assert.equal(parseGateBlocked('硬门槛挡掉 3 条\n硬门槛挡掉 2 条'), 5, '一天两轮 ⇒ 求和')
  assert.equal(parseGateBlocked('```\n硬门槛挡掉 9 条\n```\n硬门槛挡掉 1 条'), 1, '围栏里的日志不算')
  assert.equal(parseGateBlocked(null), 0)
  assert.equal(parseGateBlocked({}), 0)
})

// —— 桩宿主端到端 ——

const root = mkdtempSync(join(tmpdir(), 'bili-taste-'))
// 只在 import 期间换 DSH_HOME：别让 hostdeps 去翻这台机器真实的 ~/.dsh
const realDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
})

// 假 dsh：① 把这一轮收到的 prompt（最后一个参数）写进 last-prompt.txt；② 把 next-round.txt 追加进当天日报
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
  const writeCfg = (c) => writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ dshBin: fakeDsh, dmWatch: false, manualCooldownMin: 0, dmUid: 12345, ...c }))
  writeCfg(cfg)
  let handler = null
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})
  /** 发一个请求；body 有值就当 POST 带上 JSON 正文 */
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = {
      method, url: path, headers: {},
      on: (ev, cb) => {
        if (ev === 'data' && body !== undefined) cb(JSON.stringify(body))
        if (ev === 'end') cb()
      },
    }
    handler(req, { writeHead: () => {}, end: (s) => resolve(JSON.parse(s)) }).catch(reject)
  })
  const logFile = join(stateDir, 'duty.log')
  const roundsDone = () => { try { return readFileSync(logFile, 'utf8').split('刷B站结束（').length - 1 } catch { return 0 } }
  return {
    stateDir,
    call,
    reportFile: join(stateDir, 'out', `${dayKey()}.md`),
    prompt: () => readFileSync(join(stateDir, 'last-prompt.txt'), 'utf8'),
    /** 跑一轮：假 dsh 把这一轮收到的 prompt 记下来，再把 body 追加进当天日报 */
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
      return r
    },
  }
}

test('采集轮提示词：简报进提示词，老关键词以「你可能想搜这些」出现，硬门槛三条也进', async () => {
  const h = startHost({ cfg: { tasteBrief: '我想看真正上手 DSH 的实操，少看发布会', keywords: ['DeepSeek Harness', 'B站插件'], gateEnabled: true, gateMinViews: 50000, gateMinMinutes: 12, gateWithinDays: 7 } })
  await h.round('### BV1aaaaaaaaa\n标题：合成标题\n**档位**：可以看\n')
  const p = h.prompt()
  assert.ok(p.includes('我想看真正上手 DSH 的实操'), '简报要真的进这一轮的开场说明')
  assert.match(p, /你可能想搜这些[^\n]*DeepSeek Harness[^\n]*B站插件/)
  assert.match(p, /最低播放量 50000/)
  assert.match(p, /时长至少 12 分钟/)
  assert.match(p, /只看最近 7 天内发布的/)
  assert.ok(p.includes('报告里必须写一行「硬门槛挡掉 N 条」'))
})

test('采集轮提示词：简报为空 ⇒ 退回推荐流；老关键词照旧走搜索', async () => {
  const h1 = startHost()
  await h1.round('### BV1bbbbbbbbb\n')
  const p1 = h1.prompt()
  assert.ok(p1.includes('没填关键词 ⇒ **这一轮用 bili_recommend 刷首页推荐流**'))
  // ⚠️ 章程里也有「这一轮想看什么」这几个字 ⇒ 断言必须落在**宿主拼的那一段**上
  assert.ok(!p1.includes('这一轮想看什么（使用者写的一段话'), '简报为空时不能出现空提示词')

  const h2 = startHost({ cfg: { keywords: ['DeepSeek Harness'] } })
  await h2.round('### BV1ccccccccc\n')
  const p2 = h2.prompt()
  assert.ok(p2.includes('关键词用这些：DeepSeek Harness（用 bili_search 搜）。'))
  assert.ok(!p2.includes('这一轮想看什么（使用者写的一段话'))
})

test('/status 从当天日报读出硬门槛挡掉的条数（多行求和）；没有那一行 = 0；关着 = 0', async () => {
  const on = startHost({ cfg: { gateEnabled: true, gateMinViews: 50000 } })
  await on.round('### BV1ddddddddd\n硬门槛挡掉 3 条\n')
  await on.round('硬门槛挡掉 0 条\n')
  assert.equal((await on.call('GET', '/api/bili-duty/status')).gateBlocked, 3)

  const noLine = startHost({ cfg: { gateEnabled: true, gateMinViews: 50000 } })
  await noLine.round('### BV1eeeeeeeee\n正文里没有那一行\n')
  assert.equal((await noLine.call('GET', '/api/bili-duty/status')).gateBlocked, 0)

  const off = startHost()
  await off.round('### BV1fffffffff\n硬门槛挡掉 4 条\n')
  assert.equal((await off.call('GET', '/api/bili-duty/status')).gateBlocked, 0)
  assert.ok(!off.prompt().includes('数值硬门槛'), '关着的时候不往提示词里写门槛')
})

test('POST /config：非法门槛数字被钳制，读回来也是钳过的值', async () => {
  const h = startHost()
  const r = await h.call('POST', '/api/bili-duty/config', { gateEnabled: true, gateMinViews: -5, gateMinMinutes: 'abc', gateWithinDays: 99999 })
  assert.equal(r.ok, true)
  assert.equal(r.config.gateEnabled, true)
  assert.equal(r.config.gateMinViews, 0, '负数 ⇒ 0（不限）')
  assert.equal(r.config.gateMinMinutes, 0, '写坏 ⇒ 0')
  assert.equal(r.config.gateWithinDays, 365, '超过上限 ⇒ 钳到上限')

  const st = await h.call('GET', '/api/bili-duty/status')
  assert.equal(st.config.gateWithinDays, 365)
  assert.equal(st.config.gateMinMinutes, 0)

  const r2 = await h.call('POST', '/api/bili-duty/config', { gateMinViews: 1e9, gateMinMinutes: 9999 })
  assert.equal(r2.config.gateMinViews, GATE_MAX.minViews)
  assert.equal(r2.config.gateMinMinutes, GATE_MAX.minMinutes)
})

test('POST /config：简报能清空（clear）、超长截断；空白请求不会把已有简报冲掉', async () => {
  const h = startHost({ cfg: { tasteBrief: '旧简报：想看实操' } })
  const kept = await h.call('POST', '/api/bili-duty/config', { tasteBrief: '' })
  assert.equal(kept.config.tasteBrief, '旧简报：想看实操', '空值保护：不带 clear 不覆盖')

  const cleared = await h.call('POST', '/api/bili-duty/config', { tasteBrief: '', clear: ['tasteBrief'] })
  assert.equal(cleared.config.tasteBrief, '')

  const long = await h.call('POST', '/api/bili-duty/config', { tasteBrief: '实'.repeat(BRIEF_LIMIT + 50) })
  assert.equal(long.config.tasteBrief.length, BRIEF_LIMIT)
})

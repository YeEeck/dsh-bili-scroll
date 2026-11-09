// node --test test/
// 工单 10「设置页重组」：**字段不丢 / 老字段不再露头**的纯文本护栏。
//
// 为什么用文本断言而不是渲染：设置页跑在浏览器的自注册 bundle 里（webpack/shims 之外没有构建），
// 这里只需要回答两个可观察的问题 ——
//   ① 每个用户可配的字段，client.js（设置页）里真的有一个能改它的入口；
//   ② 老的迁移字段（peakValley / noon / night / dmMode / autoComment）不再有输入控件。
// 判据用「配置的键」和「client 的代码」：两边任一改漏都会红，而不依赖任何一句 UI 文案。
//
// ⚠️ 注释不算入口：client.js 里允许写迁移说明（提到 dmMode 之类），所以断言前先把**整行注释**滤掉。
//    这不是通用 JS 解析器（模板字符串里的 CSS 注释也会被滤掉，但那里没有这些字段名），
//    对本仓库够用；如果哪天要把控件写进多行注释里，这个测试会拦下来 —— 换个写法就行。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')

// DSH_HOME 只在 import 期间用（lib/hostdeps.mjs 找宿主包）—— 指到临时目录，不碰真实 ~/.dsh
const sandbox = mkdtempSync(join(tmpdir(), 'bili-settings-fields-'))
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
const { Config } = await import('../index.js')
if (savedDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedDshHome
after(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

/**
 * index.js 里用户可配的键。优先用导出的 `Config`（schemastery 拿不到时它是 undefined /
 * 没有 .dict），退路是从源码里那份 `DEFAULTS` 字面量抽键（它是唯一名单，见 saveCfgHost 的注释）。
 */
function configKeys() {
  const dict = Config && typeof Config === 'function' ? Config.dict : null
  if (dict && typeof dict === 'object' && Object.keys(dict).length) return new Set(Object.keys(dict))
  const start = indexSrc.indexOf('const DEFAULTS = {')
  assert.ok(start >= 0, 'index.js 里既拿不到 Config，也找不到 `const DEFAULTS = {`')
  const end = indexSrc.indexOf('\n  }', start)
  assert.ok(end > start, 'index.js 的 DEFAULTS 块没有闭合')
  const keys = new Set()
  for (const m of indexSrc.slice(start, end).matchAll(/([A-Za-z_]\w*)\s*:/g)) keys.add(m[1])
  return keys
}

/** 只保留「代码行」：整行注释（`//` / `*` / `/*` 开头）不算入口。 */
const codeOnly = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const clientCode = codeOnly(clientSrc)
const keys = configKeys()

/** 工单 10 这一轮新增 / 明确要求可配的字段（每一项都必须在设置页里能改）。 */
const REQUIRED_UI_FIELDS = [
  // 采集
  'collectTimes', 'collectBatch', 'queueLimit',
  // 投递
  'queueTtlHours', 'deliverPerDay', 'deliverMinGapMin', 'deliverMaxGapMin',
  'quietStart', 'quietEnd', 'deliverRetries', 'notifyOnFailure',
  // 渠道
  'channelDm', 'channelComment',
  // 口味 / 人设（工单 03 的，10 重排时不能弄丢）
  'tasteBrief', 'gateEnabled', 'gateMinViews', 'gateMinMinutes', 'gateWithinDays',
  'personaPrompt', 'keywords', 'excludeWords',
]

/** 原来界面上就有入口的字段：重排之后一个都不许丢（没入口的那批按「保持原样」处理，见工单 10）。
 *  ⚠️ dmUid（数字 UID 输入框）在重排前的 client.js 里就**没有**入口（收件人靠「要 @ 谁」的昵称查），
 *     所以不在这里 —— 工单要求"原来就没有的保持原样"，别顺手给它加一个。 */
const EXISTING_UI_FIELDS = [
  'perDay', 'commentPerRound', 'commentLength', 'replyToComments', 'replyPerRound',
  'mentionName', 'dmWatch', 'transcribe', 'reportLevel', 'workspace',
  'modelProvider', 'modelName', 'favFolderId', 'searchSort',
]

/** 老的迁移来源 / 不再驱动行为的字段：界面上不该再有输入控件（配置里仍保留兼容）。 */
const HIDDEN_FIELDS = ['peakValley', 'noon', 'night', 'dmMode', 'autoComment']

/** /status 里这一票要用的字段（页面接错名字 ⇒ 显示永远是 0 / 空）。 */
const STATUS_FIELDS = [
  'nextCollectAt', 'lastCollectAt', 'deliveredToday', 'lastDelivery', 'notifications',
  'queuePending', 'queueEmpty', 'queueFullHint', 'queueLimit',
  'commentAvailable', 'commentBlockedReason',
  'manualCollectCooldownRemainingMs', 'manualDeliverCooldownRemainingMs',
  'modelMirror', 'modelWhy',
]

/** GET /api/bili-duty/queue 的字段（逐条：状态 / 剩余保质期 / 失败原因）。 */
const QUEUE_FIELDS = ['items', 'finished', 'collectedAt', 'expiresInHours', 'lastError', 'status']

const mentions = (haystack, key) => new RegExp('\\b' + key + '\\b').test(haystack)

test('工单 10：每个用户可配的字段都在设置页里能改（配置里有、client.js 的代码里也接上了）', () => {
  const missingInConfig = REQUIRED_UI_FIELDS.filter((k) => !keys.has(k))
  assert.deepEqual(missingInConfig, [], '这些字段不在 index.js 的配置里（DEFAULTS / Config）：' + missingInConfig.join('、'))
  const missingInClient = REQUIRED_UI_FIELDS.filter((k) => !mentions(clientCode, k))
  assert.deepEqual(missingInClient, [], '这些字段在 client.js 里找不到入口：' + missingInClient.join('、'))
})

test('工单 10：原来界面上就有入口的字段一个都没丢', () => {
  const missing = EXISTING_UI_FIELDS.filter((k) => !mentions(clientCode, k))
  assert.deepEqual(missing, [], '这些原有入口被重排弄丢了：' + missing.join('、'))
})

test('工单 10：老的迁移字段不再有输入控件（配置里仍保留兼容）', () => {
  const stillInUi = HIDDEN_FIELDS.filter((k) => mentions(clientCode, k))
  assert.deepEqual(stillInUi, [], '这些字段不该再出现在设置页的代码里（只允许出现在注释里）：' + stillInUi.join('、'))
  // 配置里保留：老用户升级上来不会因为少一个键而重置别的
  const goneFromConfig = HIDDEN_FIELDS.filter((k) => !keys.has(k))
  assert.deepEqual(goneFromConfig, [], '这些旧字段要留在配置里兼容（迁移来源）：' + goneFromConfig.join('、'))
  // 注释里**可以**提到它们（上面 codeOnly 的过滤就是为这条服务的）——证明过滤真的在起作用
  assert.ok(HIDDEN_FIELDS.some((k) => mentions(clientSrc, k)), '迁移说明应该以注释形式留在 client.js 里')
})

test('工单 10：「日常」按采集 / 投递 / 今天三块分区，字段名与 /status、/queue 对得上', () => {
  for (const heading of ['它什么时候采集', '它怎么发给你', '今天']) {
    assert.ok(clientSrc.includes(heading), '「日常」缺少这一块分区：' + heading)
  }
  const badStatus = STATUS_FIELDS.filter((k) => !mentions(clientCode, k))
  assert.deepEqual(badStatus, [], '这些 /status 字段页面没接上：' + badStatus.join('、'))
  const badQueue = QUEUE_FIELDS.filter((k) => !mentions(clientCode, k))
  assert.deepEqual(badQueue, [], '这些 /queue 字段页面没接上：' + badQueue.join('、'))
})

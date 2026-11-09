// node --test test/
// 代码审查收尾（spec 行为契约）：发送前的机械检查补上「长度 / 链接」。
//   · `checkDeliveryText` 是纯函数，直接测；
//   · `createPrivateSender` 用注入的 send / append 测「被挡下就不调用发送、但账本有一条」。
// 不联网、不碰真实家目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDeliveryText, DELIVERY_MAX_CHARS } from '../lib/outbound.mjs'
import { createPrivateSender } from '../lib/send.mjs'

const BVID_A = 'BV1aaaaaaaaa'
const LINK_A = 'https://www.bilibili.com/video/' + BVID_A

/* ───────────────────── ① 纯函数：链接 ───────────────────── */

test('checkDeliveryText：正文里要有这条视频的链接（规范链接 / BV + 任意 http(s) 都算）', () => {
  assert.deepEqual(checkDeliveryText('这条讲得挺清楚，值得花十分钟：' + LINK_A, { bvid: BVID_A }),
    { ok: true, hits: [], reason: '' })

  // http（非 https）/ 手机站 / BV + 任意 http(s) 都放行
  assert.equal(checkDeliveryText('看这个 http://www.bilibili.com/video/' + BVID_A, { bvid: BVID_A }).ok, true)
  assert.equal(checkDeliveryText('看这个 https://m.bilibili.com/video/' + BVID_A, { bvid: BVID_A }).ok, true)
  assert.equal(checkDeliveryText('看这个 ' + BVID_A + ' （https://b23.tv/abc）', { bvid: BVID_A }).ok, true)

  // 缺链接：挡下，理由能看懂
  const miss = checkDeliveryText('这条讲得挺清楚，值得花十分钟', { bvid: BVID_A })
  assert.equal(miss.ok, false)
  assert.match(miss.reason, /没有这条视频的链接/)
  assert.match(miss.reason, /bilibili\.com\/video\//)

  // 链接是别的一条视频：BV 号对不上 ⇒ 不算
  const other = checkDeliveryText('这条不错 https://www.bilibili.com/video/BV1bbbbbbbbb', { bvid: BVID_A })
  assert.equal(other.ok, false, '链接得是这一条的')

  // 没给 bvid：至少要有「某个 BV 号 + 一个链接」
  assert.equal(checkDeliveryText('看这个 ' + BVID_A + ' ' + LINK_A).ok, true)
  assert.equal(checkDeliveryText('看这个，值得花十分钟').ok, false)
})

/* ───────────────────── ② 纯函数：长度（病态上限） ───────────────────── */

test('checkDeliveryText：明显异常长（>2000 字符）拒绝；500 字左右照常放行（spec：500 不是硬边界）', () => {
  const long = '这条讲得挺清楚，值得花十分钟。'.repeat(200) + LINK_A
  assert.ok(long.length > DELIVERY_MAX_CHARS)
  const r = checkDeliveryText(long, { bvid: BVID_A })
  assert.equal(r.ok, false)
  assert.match(r.reason, /异常长/)

  // 实测里「500 字符就顶了」只是接口侧的观察，不是我们设的边界
  const around500 = ('这条讲得挺清楚，值得花十分钟。'.repeat(40)).slice(0, 480) + LINK_A
  assert.ok(around500.length > 480 && around500.length < DELIVERY_MAX_CHARS)
  assert.equal(checkDeliveryText(around500, { bvid: BVID_A }).ok, true)
})

test('checkDeliveryText：内部术语那一档照旧（链接有了也拦）', () => {
  const r = checkDeliveryText('这条讲得挺清楚，投递账里写着：' + LINK_A, { bvid: BVID_A })
  assert.equal(r.ok, false)
  assert.ok(r.hits.includes('投递账'), JSON.stringify(r.hits))
})

/* ───────────────────── ③ 发送通道：requireLink 这一档 ───────────────────── */

/** 最小发送器：send / append 都注入；sendCalls 记「真的调了发送」 */
function sender() {
  const sendCalls = []
  const records = []
  const sendPrivate = createPrivateSender({
    send: async (args) => {
      sendCalls.push(args)
      return { success: true, data: { code: 0, msg_key: '合成回执' } }
    },
    append: (rec) => { records.push(rec); return rec },
    now: () => new Date('2026-11-10T01:00:00Z'),
  })
  return { sendPrivate, sendCalls, records }
}

test('requireLink：缺链接 ⇒ blocked、账本有一条、完全不调用发送', async () => {
  const { sendPrivate, sendCalls, records } = sender()
  const r = await sendPrivate({
    receiverUid: 12345, text: '这条讲得挺清楚，值得花十分钟', bvid: BVID_A, requireLink: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, true)
  assert.equal(r.status, 'blocked')
  assert.match(String(r.reason), /链接/)
  assert.equal(sendCalls.length, 0, '没链接就不该进 MCP')
  assert.equal(records.length, 1, 'blocked 也要落一条账')
  assert.equal(records[0].status, 'blocked')
  assert.equal(records[0].bvid, BVID_A)
  assert.match(String(records[0].message), /链接/)
})

test('requireLink：超长 ⇒ blocked；正常「草稿 + 链接」⇒ sent', async () => {
  const bad = sender()
  const long = await bad.sendPrivate({
    receiverUid: 12345, text: '很长一大段。'.repeat(400) + LINK_A, bvid: BVID_A, requireLink: true,
  })
  assert.equal(long.status, 'blocked')
  assert.equal(bad.sendCalls.length, 0)
  assert.match(String(long.reason), /异常长/)

  const ok = sender()
  const good = await ok.sendPrivate({
    receiverUid: 12345, text: '这条讲得挺清楚，值得花十分钟：' + LINK_A, bvid: BVID_A, requireLink: true,
  })
  assert.equal(good.ok, true)
  assert.equal(good.status, 'sent')
  assert.equal(good.msgKey, '合成回执')
  assert.equal(ok.sendCalls.length, 1, '正常草稿要真的发出去')
  assert.equal(ok.records[0].status, 'sent')
})

test('不带 requireLink（手动 /deliver 那一档）⇒ 仍然只查术语：没有链接也照发', async () => {
  const { sendPrivate, sendCalls } = sender()
  const r = await sendPrivate({ receiverUid: 12345, text: '这条讲得挺清楚，值得花十分钟', bvid: BVID_A })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'sent')
  assert.equal(sendCalls.length, 1)
})

test('带 requireLink 时也可以显式注入检查器（按调用覆盖）', async () => {
  const calls = []
  const sendPrivate = createPrivateSender({
    send: async () => ({ success: true, data: { code: 0, msg_key: 'k' } }),
    append: (rec) => rec,
    check: () => ({ ok: true, hits: [], reason: '' }),
    checkDelivery: () => ({ ok: false, hits: [], reason: '这一次就是要挡' }),
  })
  const r = await sendPrivate({
    receiverUid: 12345, text: '随便一段', bvid: BVID_A, requireLink: true,
    check: (text, opts) => { calls.push({ text, opts }); return { ok: true, hits: [], reason: '' } },
  })
  assert.equal(r.ok, true, '显式注入的 check 优先')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.bvid, BVID_A, '检查器要拿得到 bvid')
})

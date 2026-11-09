// node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replaceSect } from '../lib/report-sect.mjs'

const NOTES = '## 投递\n\n- 新备注\n'
const VERIFY = '\n## 评论复核（宿主自动跑的，不是那一轮自己说的）\n\n- 新结果'

test('第二轮以普通文字开头 ⇒ 文字和后面的 BV 都保住，只换这一节', () => {
  const cur = '# 日报\n\n### BV1aaaaaaaaa\n正文\n\n## 投递\n\n- 旧备注\n补充一句\n\n### BV1bbbbbbbbb\n正文二\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES),
    '# 日报\n\n### BV1aaaaaaaaa\n正文\n\n## 投递\n\n- 新备注\n\n补充一句\n\n### BV1bbbbbbbbb\n正文二\n\n')
})

test('第二轮直接追加 `- ` 列表 ⇒ 不被当成这一节吞掉', () => {
  let t = replaceSect('# 日报\n\n正文\n', '## 投递', NOTES)
  t += '- 模型自己的一条\n'
  t = replaceSect(t, '## 投递', '## 投递\n\n- 再新一点\n')
  assert.equal(t, '# 日报\n\n正文\n\n## 投递\n\n- 再新一点\n\n- 模型自己的一条\n\n')
})

test('子串不算：### 投递情况、## 投递情况、### 评论复核笔记', () => {
  for (const [head, marker, block] of [['### 投递情况', '## 投递', NOTES], ['## 投递情况', '## 投递', NOTES], ['### 评论复核笔记', '## 评论复核', VERIFY]]) {
    const cur = `# 日报\n\n${head}\n模型自己的小节\n\n### BV1ddddddddd\n正文\n`
    const body = block.trim()
    assert.equal(replaceSect(cur, marker, block), cur.trimEnd() + '\n\n' + body + '\n\n')
  }
})

test('带括号的标题算同一节', () => {
  const cur = '# 日报\n\n## 评论复核（旧的说明）\n\n- 旧结果\n\n### BV1ddddddddd\n正文\n'
  assert.equal(replaceSect(cur, '## 评论复核', VERIFY),
    '# 日报\n\n## 评论复核（宿主自动跑的，不是那一轮自己说的）\n\n- 新结果\n\n### BV1ddddddddd\n正文\n\n')
})

test('多轮留下的重复节收成一节，放在第一个出现的位置', () => {
  const cur = '# 日报\n\n## 投递\n\n- 一\n\n### BV1aaaaaaaaa\n正文\n\n## 投递\n\n- 二\n\n### BV1bbbbbbbbb\n正文二\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES),
    '# 日报\n\n## 投递\n\n- 新备注\n\n### BV1aaaaaaaaa\n正文\n\n### BV1bbbbbbbbb\n正文二\n\n')
})

test('后面还有别的节 ⇒ 不动它', () => {
  const cur = '# 日报\n\n## 投递\n\n- 旧备注\n\n## 评论复核（说明）\n\n- 结果\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES), '# 日报\n\n## 投递\n\n- 新备注\n\n## 评论复核（说明）\n\n- 结果\n\n')
})

test('这一节换完后别的宿主节留在文件尾 ⇒ 也留空行，下一轮紧贴写的 `- ` 不被吞', () => {
  let t = replaceSect('# 日报\n\n正文\n', '## 投递', NOTES)
  t = replaceSect(t, '## 评论复核', VERIFY)
  t = replaceSect(t, '## 投递', NOTES)
  t += '- 模型自己的一条\n'
  t = replaceSect(t, '## 评论复核', VERIFY)
  assert.ok(t.includes('- 模型自己的一条'))
})

test('没有这一节 ⇒ 加在文件尾，后面留一个空行', () => {
  assert.equal(replaceSect('# 日报\n\n正文\n', '## 投递', NOTES), '# 日报\n\n正文\n\n## 投递\n\n- 新备注\n\n')
})

test('标题下面不是列表 ⇒ 只换标题，下面的内容原样留着', () => {
  const cur = '# 日报\n\n## 投递\n\n模型自己写的一段\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES), '# 日报\n\n## 投递\n\n- 新备注\n\n模型自己写的一段\n\n')
})

test('CRLF 的报告也认得出这一节', () => {
  const cur = '# 日报\r\n\r\n## 投递\r\n\r\n- 旧备注\r\n\r\n### BV1aaaaaaaaa\r\n正文\r\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES), '# 日报\n\n## 投递\n\n- 新备注\n\n### BV1aaaaaaaaa\r\n正文\n\n')
})

/* ─────────── 工单 06：`## 队列` 那种「### BV 子块 + - 字段」的节 ─────────── */

const queueBlock = (bv, n = 1) => [
  '## 队列',
  '',
  `### ${bv}`,
  '- 标题：合成标题',
  '- UP：合成UP',
  '- 状态：待投递',
  '- 采集：2026-11-09 23:30 · 到期：2026-11-10 23:30',
  '- 草稿：这条讲得挺清楚',
  '',
  `- 本轮：入队 ${n} 条 · 丢弃 0 条 · 过期 0 条 · 跳过 0 条 · 现在队列里 ${n} 条待投递`,
].join('\n')

test('队列节（subheads）：子块 + 统计一起换掉，只留一节，后面的模型内容不被剪', () => {
  let t = replaceSect('# 日报\n\n', '## 队列', queueBlock('BV1aaaaaaaaa'), { subheads: true })
  t += '第一轮总结\n'
  t = replaceSect(t, '## 队列', queueBlock('BV1bbbbbbbbb', 2), { subheads: true })
  assert.equal((t.match(/^## 队列$/gm) || []).length, 1, '只留一节')
  assert.ok(t.includes('### BV1bbbbbbbbb'), '换成最新的那批')
  assert.ok(!t.includes('### BV1aaaaaaaaa'), '旧的那条子块不该留着')
  assert.ok(t.includes('第一轮总结'), '模型写的内容要留着')
  assert.equal((t.match(/^- 草稿：/gm) || []).length, 1)
})

test('队列节：后面紧跟模型自己写的 `### BV号` + 普通文字 ⇒ 不吞（那是别人的内容）', () => {
  const model = '### BV1zzzzzzzzz\n标题：模型自己写的\n**档位**：可以看\n'
  const cur = '# 日报\n\n' + queueBlock('BV1aaaaaaaaa') + '\n' + model + '\n第二轮总结\n'
  const out = replaceSect(cur, '## 队列', queueBlock('BV1bbbbbbbbb'), { subheads: true })
  assert.ok(out.includes(model), '模型的 ### BV 块一个字都不能少')
  assert.ok(out.includes('第二轮总结'))
  assert.equal((out.match(/^## 队列$/gm) || []).length, 1)
})

test('队列节：后面跟着别的宿主节 ⇒ 各换各的，都不出声', () => {
  const cur = '# 日报\n\n' + queueBlock('BV1aaaaaaaaa') + '\n## 投递\n\n- 旧备注\n\n### BV1bbbbbbbbb\n模型内容\n'
  let t = replaceSect(cur, '## 队列', queueBlock('BV1ccccccccc', 2), { subheads: true })
  t = replaceSect(t, '## 投递', '## 投递\n\n- 新备注\n')
  assert.equal((t.match(/^## 队列$/gm) || []).length, 1)
  assert.equal((t.match(/^## 投递$/gm) || []).length, 1)
  assert.ok(t.includes('- 新备注'))
  assert.ok(t.includes('模型内容'))
  assert.ok(t.includes('### BV1ccccccccc'))
})

test('subheads 默认关：旧那两节的行为一个字都不变（`### ` 行不吃）', () => {
  const cur = '## 投递\n\n- 旧备注\n\n### 模型自己的小节\n正文\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES), '## 投递\n\n- 新备注\n\n### 模型自己的小节\n正文\n\n')
  // 开了也一样：`### 队列说明` 不是 BV 子块，不吃
  const cur2 = '## 队列\n\n' + '- 旧的一行\n\n### 队列说明\n模型写的\n'
  const out = replaceSect(cur2, '## 队列', queueBlock('BV1aaaaaaaaa'), { subheads: true })
  assert.ok(out.includes('### 队列说明\n模型写的'))
})

test('队列节：模型写的是 `### BV号` + 一串自己的 `- ` 行（没有宿主标签）⇒ 也不吞', () => {
  const model = '### BV1zzzzzzzzz\n- 值得一看\n- https://www.bilibili.com/video/BV1zzzzzzzzz\n'
  const cur = '# 日报\n\n' + queueBlock('BV1aaaaaaaaa') + '\n' + model
  const out = replaceSect(cur, '## 队列', queueBlock('BV1bbbbbbbbb'), { subheads: true })
  assert.ok(out.includes(model), '模型自己的列表小节一个字都不能少')
  assert.ok(out.includes('### BV1bbbbbbbbb'))
  assert.equal((out.match(/^### BV1aaaaaaaaa$/gm) || []).length, 0, '旧的那条子块换成新的')
})

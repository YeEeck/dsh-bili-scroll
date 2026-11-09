// node --test test/
// ⭐ 2026-11-09（02-provider-mirror）：白名单删了 —— 这里全部按「这一轮实际有什么」判断。
//   可用集合 = DeepSeek 内置两条 + `env.available()`（index.js 传的是本轮从主 profile 镜像出来的 provider）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  availableProviders, providerState, chooseModel, BASE_PROVIDERS, FALLBACK_MODEL,
} from '../lib/model-select.mjs'

/** index.js 里的 modelEnv 就是这个形状：available() 返回本轮镜像到的 provider 名 */
const envOf = (...providers) => ({ available: () => providers })
const EMPTY = envOf()                       // 主 profile 没配第三方 provider
const MIRRORED = envOf('lm-studio-wr', 'ocg-1')
const ses = (provider, model = 'some-model') => ({ provider, model, source: 'session' })
const pin = (provider, model = 'some-model') => ({ provider, model })
const pick = (m) => [m.provider, m.source]

test('availableProviders：内置两条打底，镜像到的追加在后面并去重', () => {
  assert.deepEqual(availableProviders(EMPTY), ['deepseek-account', 'deepseek-official'])
  assert.deepEqual(availableProviders(MIRRORED),
    ['deepseek-account', 'deepseek-official', 'lm-studio-wr', 'ocg-1'])
  // 镜像结果重复 / 和内置重名都不该重复列
  assert.deepEqual(availableProviders(envOf('ocg-1', 'deepseek-account', 'ocg-1')),
    ['deepseek-account', 'deepseek-official', 'ocg-1'])
  // 空值、非数组、抛错都只留内置两条（宁可少列，也不列一个必然 NO_ADAPTER 的）
  assert.deepEqual(availableProviders(envOf('', null)), ['deepseek-account', 'deepseek-official'])
  assert.deepEqual(availableProviders({ available: () => 'nope' }), BASE_PROVIDERS)
  assert.deepEqual(availableProviders({ available: () => { throw new Error('boom') } }), BASE_PROVIDERS)
  assert.deepEqual(availableProviders(undefined), BASE_PROVIDERS)
  assert.deepEqual(availableProviders({ available: () => [' spaced ', ''] }), ['deepseek-account', 'deepseek-official', 'spaced'])
})

test('providerState：只有「这一轮真装了」才是 yes —— 不再有 maybe / 白名单', () => {
  assert.equal(providerState('deepseek-account', EMPTY), 'yes')
  assert.equal(providerState('deepseek-official', MIRRORED), 'yes')
  assert.equal(providerState('lm-studio-wr', MIRRORED), 'yes')
  // 主 profile 装没装、是不是某个特定 profile 专属 —— 都不算数，只看这一轮
  assert.equal(providerState('lm-studio-wr', EMPTY), 'no')
  assert.equal(providerState('google-antigravity', EMPTY), 'no')
  assert.equal(providerState('google-antigravity', envOf('google-antigravity')), 'yes')
  assert.equal(providerState('', EMPTY), 'no')
  assert.equal(providerState(null, MIRRORED), 'no')
})

test('钉了 & 这一轮有 ⇒ 照用（source: plugin），不会被会话抢走', () => {
  const m = chooseModel({ pin: pin('ocg-1', 'deepseek-v4.1-flash'), session: ses('deepseek-official') }, MIRRORED)
  assert.deepEqual(m, { provider: 'ocg-1', model: 'deepseek-v4.1-flash', source: 'plugin' })
})

test('钉了 & 这一轮没有 ⇒ 仍按钉的用（不悄悄换），但标 unavailable 让设置页说清原因', () => {
  for (const session of [ses('deepseek-account'), ses('community-x'), null]) {
    const m = chooseModel({ pin: pin('not-installed', 'm1'), session }, EMPTY)
    assert.deepEqual(m, { provider: 'not-installed', model: 'm1', source: 'plugin', unavailable: true })
  }
  // 镜像被拒 / 没读到配置 ⇒ 同样只是「这一轮没有」，不会换成别的模型
  const m = chooseModel({ pin: pin('lm-studio-wr', 'm2'), session: ses('deepseek-account') }, envOf('ocg-1'))
  assert.deepEqual(pick(m), ['lm-studio-wr', 'plugin'])
  assert.equal(m.unavailable, true)
})

test('没钉 + 会话的 provider 这一轮有 ⇒ 跟随会话，effort 一起带上', () => {
  const session = { ...ses('ocg-1', 'deepseek-v4.1-flash'), reasoningEffort: 'high' }
  assert.deepEqual(chooseModel({ pin: null, session }, MIRRORED), session)
  assert.deepEqual(chooseModel({ pin: null, session: ses('deepseek-official') }, EMPTY),
    ses('deepseek-official'))
})

test('没钉 + 会话的 provider 这一轮没有 ⇒ DeepSeek 兜底，并把被丢掉的写进 sessionIgnored', () => {
  assert.deepEqual(chooseModel({ pin: null, session: ses('community-x', 'gw-model') }, MIRRORED), {
    ...FALLBACK_MODEL,
    source: 'fallback',
    sessionIgnored: { provider: 'community-x', model: 'gw-model' },
  })
  // 会话是第三方、但主 profile 没镜像它（比如没装 / 被拒）⇒ 同样兜底
  assert.deepEqual(pick(chooseModel({ pin: null, session: ses('lm-studio-wr') }, EMPTY)),
    ['deepseek-account', 'fallback'])
})

test('没钉也没有会话 ⇒ 兜底，不带 sessionIgnored', () => {
  assert.deepEqual(chooseModel({ pin: null, session: null }, EMPTY), { ...FALLBACK_MODEL, source: 'fallback' })
  const noSession = chooseModel({ pin: null }, MIRRORED)
  assert.deepEqual(noSession, { ...FALLBACK_MODEL, source: 'fallback' })
  assert.ok(!('sessionIgnored' in noSession))
})

test('兜底那一对永远在可用集合里（账号登录的机器上也跑得起来）', () => {
  assert.ok(BASE_PROVIDERS.includes(FALLBACK_MODEL.provider))
  assert.deepEqual(availableProviders(EMPTY).slice(0, 2), BASE_PROVIDERS)
})

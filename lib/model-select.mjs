/**
 * lib/model-select.mjs —— 这一轮到底用哪个模型 —— 纯逻辑，不读配置、不碰宿主，方便直接测选择表。
 *
 * ⭐⭐ 2026-11-09（02-provider-mirror）：**白名单没了**。
 *   以前是一份硬编码名单 + 「某个 provider 只装在某个 profile 里」的绑定规则 —— 两头都会过时：
 *   值班 profile 换了、主 profile 装了新 provider，插件都看不见 ✗。
 *   现在**这一轮实际装了什么就认什么**：DeepSeek 内置两条 + `lib/provider-mirror.mjs` 本轮从主
 *   profile 镜像进 overlay 的 provider。可用集合由调用方用 `env.available()` 注入（纯函数的唯一输入）。
 *
 * 文件和宿主那两半由调用方用 `env` 传进来：
 *   env.available()  这一轮值班 profile 里确实有的 provider 名（不含 DeepSeek 内置两条也行，会去重）
 */

export const BASE_PROVIDERS = ['deepseek-account', 'deepseek-official']
/** ⭐ 连「当前会话的模型」都用不了时兜底的那一对（账号登录的机器上一定能跑） */
export const FALLBACK_MODEL = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * 这一轮的可用集合 = DeepSeek 内置两条 + 本轮镜像出来的 provider（去重、按出现顺序）。
 * `env.available()` 抛错 / 返回垃圾 ⇒ 只剩内置两条（宁可少列，也不列一个必然 NO_ADAPTER 的）。
 */
export function availableProviders(env) {
  const out = [...BASE_PROVIDERS]
  let extra = []
  try { extra = env?.available?.() || [] } catch { extra = [] }
  if (!Array.isArray(extra)) return out
  for (const p of extra) {
    const id = String(p || '').trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 'yes' = 这一轮值班 profile 里有（内置两条或镜像成功）；'no' = 没有 */
export function providerState(p, env) {
  const id = String(p || '').trim()
  if (!id) return 'no'
  return availableProviders(env).includes(id) ? 'yes' : 'no'
}

/**
 * 钉的和跟随的走两条路：
 *   · 钉了 = 用户明说要它 ⇒ **照用，不悄悄换**（#130 / #163 / b8f0b5a）。这一轮真没有那个 provider
 *     时也照用：整轮会以 NO_ADAPTER 结束，由 `lib/diagnose.mjs` 说清楚 —— 换成别的才是更坏的行为
 *     （用户以为钉住了，其实一直在跑另一个模型）。不可用时返回值里带 `unavailable: true`，
 *     让 `/status` 与设置页能把原因亮出来。
 *   · 跟随当前会话 = 用户没为这一轮选过 ⇒ 会话的 provider 这一轮有就跟随；没有就兜底 DeepSeek，
 *     并把被丢掉的那个写进 `sessionIgnored`（宁可换模型，也别让这一轮在第一个请求前就死掉）。
 *
 * @param {{ pin: {provider: string, model: string}|null, session: {provider: string, model: string}|null }} picks
 */
export function chooseModel({ pin, session }, env) {
  if (pin) {
    return providerState(pin.provider, env) === 'yes'
      ? { ...pin, source: 'plugin' }
      : { ...pin, source: 'plugin', unavailable: true }
  }
  if (session && providerState(session.provider, env) === 'yes') return session
  return {
    ...FALLBACK_MODEL,
    source: 'fallback',
    ...(session ? { sessionIgnored: { provider: session.provider, model: session.model } } : {}),
  }
}

/**
 * lib/channels.mjs —— 渠道：私信 / 公开评论（纯逻辑，不读写文件）
 * ============================================================================
 * 工单 08（`.scratch/collect-deliver/issues/08-channel-migration.md`）：
 *   老配置只有一个三态下拉 `dmMode`（off=只评论 · only=只私信 · both=都发）外加一个
 *   `autoComment` 开关 —— 两件事挤在一个值里，设置页只能"二选一"，代码里到处 `=== 'only'`。
 *   现在拆成两个**独立**开关（GLOSSARY「渠道」）：
 *
 *     channelDm       私信（投递的来源）· 默认 **true**（保持以前"默认只私信"的体验）
 *     channelComment  公开评论（采集轮里发生）· 默认 **false**
 *
 *   老配置只迁移一次，映射（issue 08 定死）：
 *
 *     | dmMode | autoComment | channelDm | channelComment |
 *     |--------|-------------|-----------|----------------|
 *     | off    | true        | false     | true           |
 *     | off    | false       | false     | false          |
 *     | only   | true        | true      | false          |
 *     | only   | false       | true      | false          |
 *     | both   | true        | true      | true           |
 *     | both   | false       | true      | false          |
 *
 *   ⚠️ **安全取舍**：`autoComment` 默认关，而且仓库规矩是「别擅自打开自动评论」；
 *      老用户选 `off`（只评论）只代表"不要私信"，不代表"要公开评论"。
 *      所以 `channelComment` 一律跟原来的 `autoComment` 走 —— 原来没开自动评论的，
 *      迁移后评论通道仍然是关的，并且在 duty.log 里写明「按你原来的自动评论开关（关）」，不静默。
 *
 *   `autoComment` / `dmMode` 从此**不再参与行为判断**，只作为迁移来源留在配置里。
 *   迁移只发生一次：`config.json` 里没有两个新字段 + 标记文件不存在，两条同时成立才迁移；
 *   之后用户改开关、重启，都不会被这里覆盖。
 * ============================================================================
 */

/** 迁移标记文件（在 `<stateDir>/` 下）：存在 = 这次迁移已经做过了 */
export const CHANNEL_MIGRATION_FILE = '.mig-channels'

/** 两个渠道的默认值（唯一一份；schema / DEFAULTS / 设置页都按它） */
export const CHANNEL_DEFAULTS = Object.freeze({ channelDm: true, channelComment: false })

/** 老 `dmMode` 的合法取值 */
export const DM_MODES = Object.freeze(['off', 'only', 'both'])

const MODE_LABEL = Object.freeze({
  off: '只评论（off）',
  only: '只私信（only）',
  both: '私信 + 评论（both）',
})

/** 不认识的一律按老的默认值 `only`（= 只私信）处理 */
function normMode(value) {
  const s = String(value ?? '').trim()
  return DM_MODES.includes(s) ? s : 'only'
}

/**
 * 老选择 → 两个渠道开关（纯映射）。
 * @param {{dmMode?: string, autoComment?: boolean}} [legacy]
 * @returns {{channelDm: boolean, channelComment: boolean}}
 */
export function legacyChannels({ dmMode, autoComment } = {}) {
  const mode = normMode(dmMode)
  return {
    channelDm: mode !== 'off',
    channelComment: mode !== 'only' && Boolean(autoComment),
  }
}

/**
 * `config.json` 里是不是已经有新字段了（有 ⇒ 不是老配置，不该再迁移）。
 * @param {unknown} saved
 * @returns {boolean}
 */
export function hasChannelFields(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false
  return 'channelDm' in saved || 'channelComment' in saved
}

/** 迁移时给 duty.log 的那几行（一句话说清映射结果；不静默） */
function migrationLines(legacy, channels) {
  const { dmMode } = legacy
  const auto = Boolean(legacy.autoComment)
  const dm = channels.channelDm
    ? '开（默认）'
    : '关（原来选的是「只评论」）'
  let comment = ''
  if (dmMode === 'only') comment = '关（原来选的是「只私信」）'
  else if (!auto) comment = '按你原来的自动评论开关（关）'
  else comment = '开（原来开着自动评论，且投递方式不是「只私信」）'

  const lines = [
    '渠道迁移（只做一次）：老配置「投递方式 = ' + MODE_LABEL[normMode(dmMode)]
      + ' · 自动评论 = ' + (auto ? '开' : '关') + '」 ⇒ 私信：' + dm + ' · 公开评论：' + comment,
  ]
  if (!channels.channelComment) {
    lines.push('渠道迁移：想公开评论时，打开「在视频下公开评论 @ 我」并填好人设即可（人设留空时这条通道不可用）；私信不受影响。')
  }
  return lines
}

/**
 * 一次性迁移（**纯计算**，不落盘；写 config.json / 标记文件由宿主负责）。
 *
 * @param {object} [input]
 * @param {object} [input.saved] `config.json` 的原文
 * @param {{dmMode?: string, autoComment?: boolean}} [input.effective]
 *        生效值（老用户可能只在 DSH 原生设置页里改过 dmMode / autoComment；saved 里有就以 saved 为准）
 * @param {boolean} [input.migratedBefore] 标记文件在不在
 * @returns {{
 *   migrated: boolean,
 *   config: object,
 *   channels: {channelDm: boolean, channelComment: boolean},
 *   legacy: {dmMode: string, autoComment: boolean},
 *   lines: string[],
 * }}
 */
export function planChannelMigration({ saved = {}, effective = {}, migratedBefore = false } = {}) {
  const src = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  const eff = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective : {}
  const legacy = {
    dmMode: normMode(src.dmMode !== undefined ? src.dmMode : eff.dmMode),
    autoComment: Boolean(src.autoComment !== undefined ? src.autoComment : eff.autoComment),
  }
  const current = {
    channelDm: typeof src.channelDm === 'boolean' ? src.channelDm : CHANNEL_DEFAULTS.channelDm,
    channelComment: typeof src.channelComment === 'boolean' ? src.channelComment : CHANNEL_DEFAULTS.channelComment,
  }

  // ① 已经迁移过（标记在）② 配置里已经有新字段 ⇒ 都不是老配置，原样不动
  if (migratedBefore || hasChannelFields(src)) {
    return { migrated: false, config: { ...src }, channels: current, legacy, lines: [] }
  }

  const channels = legacyChannels(legacy)
  return {
    migrated: true,
    // dmMode / autoComment **留着**（迁移来源，不删用户数据）；新字段写进去
    config: { ...src, ...channels },
    channels,
    legacy,
    lines: migrationLines(legacy, channels),
  }
}

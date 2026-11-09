/**
 * dsh-bili-scroll —— 浏览器半端（**设置在「设置」里的一页**）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（2026-10-14 从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **怎么进「设置」**（抄第三方插件 `dsh-meme/client.js`，2026-10-14 使用者指出位置不对后才查到）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'bili-scroll', order: 30, label: '刷B站' },   // label = 左侧导航那一项
 *       () => h(Panel),
 *     ))
 *
 *   ⇒ **别自己糊一个标题栏按钮 + 全屏 overlay** ✗（第一版就是这么干的，使用者一眼看出"跟别的插件不一样"）。
 *
 * 这一页要满足使用者 2026-10-14 说的形状：
 *   · **总开关 → 打开之后下面才展开子开关**（峰谷自动刷 → 中午 / 晚上）
 *   · **数字项要能自己填**（定量刷：每天几条）
 *   · **账号绑定必须在设置页里**（扫码登录 + 二维码直接显示在页里）
 *   · 会发东西出去的（自动评论）、要下大模型的（本地转写）**默认关**
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-duty'
    /* ⭐ 2026-11 工单 03：硬门槛数字的上下限（名字 / 含义与 lib/taste.mjs 的 GATE_MAX 一致 ——
     *    那边是权威（写与读两头都按它钳），这里是输入框的 min/max + 失焦时的即时钳制，改上限要两边一起改）。 */
    const GATE_UI_MAX = { views: 10_000_000, minutes: 600, days: 365 }
    /* ⚠️ 原来 jget/jpost 直接 .json()、从不看 res.ok ⇒ HTTP 500 的 {ok:false,error}
     *    会被调用方当成「已保存 / 成功」，绿色提示把故障盖掉。（2026-10-16 审查修） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /* ⭐ 2026-10-25（本人反馈：「把工作区改了，标签还在旧工作区」）：
       「刷过的视频」tab 是按「会话属于哪个工作区」动态注册的，结果缓存在这里。
       以前缓存**永不过期、也不失效** ⇒ 改了工作区设置之后，老会话的旧结论一直留着，
       tab 就还挂在旧工作区。
       现在：缓存带 TTL；设置保存、窗口重新获得焦点、每 15 秒兜底轮询都会 `bumpScope()`
       —— 清缓存 + 让所有探针重查（一次本地 GET，很便宜）。 */
    const scopeCache = new Map()          // sessionId -> { v: boolean, at: number }
    const SCOPE_TTL = 20_000
    const scopeSubs = new Set()           // 探针注册的"请重查"回调
    const bumpScope = () => {
      scopeCache.clear()
      for (const fn of [...scopeSubs]) { try { fn() } catch { /* 单个探针报错不影响别的 */ } }
    }

    const CSS = `
[data-bd-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
    [data-bd-page][data-bd-wide]{max-width:none;width:100%;}
    [data-bd-page][data-bd-wide] [data-bd-list]{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;}
[data-bd-sec]{display:flex;flex-direction:column;gap:8px;}
[data-bd-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-bd-grow]{flex:1;min-width:0;}
[data-bd-label]{font-size:13px;}
[data-bd-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bd-sw][data-on]{background:#3b82f6;}
[data-bd-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bd-sw][data-on] i{left:19px;}
[data-bd-sw][disabled]{opacity:.45;cursor:default;}
[data-bd-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-bd-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-bd-input]:focus{outline:none;border-color:#3b82f6;}
/* ⭐ 2026-10-23（本人反馈：「设置的菜单在深色模式下是白的，看不见字」）：
   原生 <select> 展开的那个**弹出菜单**不走页面的深色主题 —— 它按浏览器/系统的浅色调色板画白底，
   而选项文字继承的是页面颜色（深色主题下是白的）⇒ **白底白字，看不见** ✗。
   光给 select 设 background 不够（弹出层不看它），必须把 option / optgroup 的底色和字色都钉死；
   值成对取主题变量（拿不到就退回浅底深字，两边主题都可读）。 */
select[data-bd-input]{color-scheme:light dark;}
select[data-bd-input] option,select[data-bd-input] optgroup{
  background-color:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);}
[data-bd-num]{width:88px;text-align:center;}
[data-bd-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-bd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-bd-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-bd-btn][disabled]{opacity:.5;cursor:default;}
[data-bd-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-msg][data-warn]{color:#f59e0b;}
[data-bd-msgbar]{position:sticky;top:0;z-index:6;background:var(--dsw-alias-bg-base,#151a24);box-shadow:0 1px 0 var(--dsw-alias-bg-layer-2,#2a3140);margin-bottom:4px;}
[data-bd-msg][data-good]{color:#22c55e;}
[data-bd-qr]{display:flex;gap:14px;align-items:flex-start;}
[data-bd-qr] img{width:150px;height:150px;border-radius:8px;background:#fff;padding:6px;}
[data-bd-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:170px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
    /* ⭐ 2026-10-21 重做：卡片网格 + 颜色全部取「真实存在」的主题变量
       （之前用了 --dsw-alias-bg-layer-1 / --dsw-alias-bg-layer-3 —— 这两个在应用里根本不存在 ⇒
        fallback 落到硬编码深色，而文字用的 --dsw-alias-label-primary 是存在的 ⇒ 浅色主题下变近黑 ⇒ 黑底黑字看不见） */
    [data-bd-list]{margin:10px 0 0;max-height:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;}
    [data-bd-item]{display:flex;flex-direction:column;overflow:hidden;border-radius:12px;
      background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
      border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));
      color:var(--dsw-alias-label-primary,inherit);}
    [data-bd-cover]{display:block;width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;
      background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));}
    [data-bd-item-body]{display:flex;flex-direction:column;gap:4px;padding:9px 11px;min-width:0;}
    [data-bd-item-t]{font-size:13px;line-height:18px;font-weight:600;
      color:var(--dsw-alias-label-primary,inherit);
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
    [data-bd-item-t] a{color:inherit;text-decoration:none;}
    [data-bd-item-t] a:hover{text-decoration:underline;}
    [data-bd-item-n]{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);margin:0;}
    [data-bd-item-why]{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,inherit);
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
    [data-bd-clickable]{cursor:pointer;transition:border-color .12s,background .12s;}
    [data-bd-clickable]:hover{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.5));
      background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
    [data-bd-tabs]{display:flex;gap:4px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));}
    [data-bd-tab]{flex:1;min-width:0;cursor:pointer;font:inherit;font-size:13px;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);}
    [data-bd-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
    [data-bd-tab][aria-selected=true]{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,inherit);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}
    [data-bd-away]{display:none !important;}
    [data-bd-chip]{cursor:pointer;white-space:nowrap;font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;
      border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));background:transparent;
      color:var(--dsw-alias-label-secondary,inherit);}
    [data-bd-chip]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
    [data-bd-chip][aria-selected=true]{color:var(--dsw-alias-label-primary,inherit);
      border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.6));
      background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 16%,transparent);}
    [data-bd-tier]{font-weight:600;color:var(--dsw-alias-label-secondary,inherit);}
    [data-bd-tier='值得看']{color:#3fb950;}
    [data-bd-tier='可以看']{color:#d29922;}
    [data-bd-tier='不值当']{color:var(--dsw-alias-label-tertiary,inherit);}
[data-bd-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-bd-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
`

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bd-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-bd-row': '' },
        h('div', { 'data-bd-grow': '' },
          h('div', { 'data-bd-label': '' }, label),
          note ? h('div', { 'data-bd-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      // ⭐ 2026-10-19（用户报"没有开关这一项，只能让 ai 帮我开"）：读不到配置时界面只显示"读设置中…"，
      //    用户会以为是开关坏了 ✗ ⇒ 数一下连续失败次数，交给界面把话说清楚（版本太旧 / 没重启 / 读不到）
      const [fails, setFails] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (!alive) return
            if (d && d.ok) { setSt(d); setFails(0) } else setFails((n) => n + 1)
          } catch { if (alive) setFails((n) => n + 1) }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt, fails]
    }

    /* ────────────── 设置页正文 ────────────── */

/* ────────────── 会话头那个 tab：它刷过的视频（最小实验版）────────────── */
function WatchTab() {
  const PAGE = 30
  const onOpenUrl = (u) => { jpost('/open', { what: 'url', u }).catch(() => {}) }
  // ⭐ 2026-11-04：DSH 切视图 / 切浏览器标签回来会卸载重挂这个组件 ⇒ 筛选和滚动位置得存到 sessionStorage，
  //    否则点开视频再回来就跳回「全部」了（页面关掉才清，这个重置才算合理）。
  const BD_WT_KEY = 'bd-watched-tab'
  const readSaved = () => { try { return JSON.parse(sessionStorage.getItem(BD_WT_KEY) || '{}') || {} } catch { return {} } }
  const writeSaved = (patch) => { try { sessionStorage.setItem(BD_WT_KEY, JSON.stringify({ ...readSaved(), ...patch })) } catch { /* 隐私模式等禁用了就算了 */ } }
  const saved = readSaved()
  const [rows, setRows] = React.useState(null)
  const [st, setSt] = React.useState(saved.st || '')      // '' | picked | skipped | commented
  const [tier, setTier] = React.useState(saved.tier || '')  // '' | 值得看 / 可以看 / 不值当
  const [offset, setOffset] = React.useState(Number(saved.off) || 0)
  const [total, setTotal] = React.useState(0)
  const load = (s, t, off) => {
    // ⭐ 2026-11-04：别在筛选时清空列表 —— 一清空页面高度塌下来，滚动就跳回顶部（用户以为"跳回一开始的页面"）。
    //    首次加载时 rows 本来就是 null，"读取中…"照样会显示。
    const q = `/watched?limit=${PAGE}&offset=${off}` + (s ? '&state=' + s : '') + (t ? '&tier=' + encodeURIComponent(t) : '')
    jget(q).then((r) => {
      if (!r || !r.ok) { setRows([]); return }
      setRows(r.rows || [])
      setTotal(Number(r.total) || 0)
    }).catch(() => setRows([]))
  }
  React.useEffect(() => {
    load(saved.st || '', saved.tier || '', Number(saved.off) || 0)
    // 恢复滚动位置（等列表渲染出来再滚，250ms 足够）
    if (Number(saved.scrollY) > 0) setTimeout(() => { try { window.scrollTo(0, Number(saved.scrollY)) } catch { /* ignore */ } }, 250)
    return () => { writeSaved({ scrollY: (() => { try { return window.scrollY } catch { return 0 } })() }) }
  }, [])
  const pick = (kind, v) => {
    const next = (kind === 'state' ? st : tier) === v ? '' : v
    if (kind === 'state') setSt(next); else setTier(next)
    setOffset(0)
    writeSaved({ st: kind === 'state' ? next : st, tier: kind === 'tier' ? next : tier, off: 0 })
    load(kind === 'state' ? next : st, kind === 'tier' ? next : tier, 0)
  }
  const go = (d) => {
    const n = Math.max(0, Math.min(offset + d, Math.max(0, total - 1)))
    setOffset(n)
    writeSaved({ off: n })
    load(st, tier, n)
    try { window.scrollTo(0, 0) } catch { /* 翻页才滚到顶；筛选时不滚，保住用户的位置 */ }
  }
  const chip = (label, on, active) => h('button', { 'data-bd-chip': '', 'aria-selected': active ? 'true' : 'false', onClick: on }, label)
  return h('div', { 'data-bd-page': '', 'data-bd-wide': '' },
    h('div', { 'data-bd-row': '' },
      chip('全部', () => pick('state', ''), st === ''),
      chip('挑了', () => pick('state', 'picked'), st === 'picked'),
      chip('跳过', () => pick('state', 'skipped'), st === 'skipped'),
      chip('发给你了', () => pick('state', 'commented'), st === 'commented'),
      h('div', { 'data-bd-note': '' }, rows === null ? '读取中…' : `共 ${total} 条`)),
    h('div', { 'data-bd-row': '' },
      chip('值得看', () => pick('tier', '值得看'), tier === '值得看'),
      chip('可以看', () => pick('tier', '可以看'), tier === '可以看'),
      chip('不值当', () => pick('tier', '不值当'), tier === '不值当')),
    rows && rows.length ? h('div', { 'data-bd-list': '' },
      rows.map((x, i) => h('div', { key: x.day + x.bvid, 'data-bd-item': '', 'data-bd-clickable': '', title: '在浏览器打开', onClick: () => onOpenUrl(x.url) },
        i < 30 ? h('img', { 'data-bd-cover': '', src: API + '/cover?bv=' + x.bvid, loading: 'lazy', alt: '' }) : null,
        h('div', { 'data-bd-item-body': '' },
          h('div', { 'data-bd-item-t': '' }, x.title),
          h('div', { 'data-bd-item-n': '' }, `${x.day} · ${x.up} · `, x.picked ? '挑中了' : '跳过', (x.delivered || x.commented) ? ' · 已发给你' : '',
            x.tier ? h('span', { 'data-bd-tier': x.tier }, ' · ' + x.tier) : null),
          x.why ? h('div', { 'data-bd-item-why': '' }, x.why) : null))))
      : h('div', { 'data-bd-note': '' }, rows === null ? '' : '这一类还没有记录 —— 跑一轮之后就有了'),
    total > PAGE ? h('div', { 'data-bd-row': '' },
      h('button', { 'data-bd-btn': '', disabled: offset <= 0, onClick: () => go(-PAGE) }, '上一页'),
      h('div', { 'data-bd-note': '' }, `${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}`),
      h('button', { 'data-bd-btn': '', disabled: offset + PAGE >= total, onClick: () => go(PAGE) }, '下一页')) : null)
}

    function Panel() {
      const [st, setSt, fails] = useStatus(5000)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [kws, setKws] = React.useState(null)
      // ⭐ 2026-11 工单 03（口味简报 / 硬门槛）：简报与三条门槛都绑本地草稿（页面每 5 秒轮询 /status）
      const [brief, setBrief] = React.useState(null)            // 口味简报：一段话
      const [gateViews, setGateViews] = React.useState(null)    // 硬门槛：最低播放量
      const [gateMin, setGateMin] = React.useState(null)        // 硬门槛：最短时长（分钟）
      const [gateDays, setGateDays] = React.useState(null)      // 硬门槛：发布时间窗（天）
      const [favFolders, setFavFolders] = React.useState(null)   // 收藏夹列表（下拉用，null = 还没读）
      const [favId, setFavId] = React.useState(null)             // 选中的收藏夹 fid（字符串）
      const [modelList, setModelList] = React.useState(null)     // /models 的返回（null = 还没读）
      const [wsList, setWsList] = React.useState(null)           // DSH 里已建好的工作区（下拉用，null = 还没读）
      const [persona, setPersona] = React.useState(null)   // 人设提示词草稿
      const [excl, setExcl] = React.useState(null)              // 排除词草稿（一行一个）
      const [cLen, setCLen] = React.useState(null)              // 评论长度 short/medium/long
      const [fSort, setFSort] = React.useState(null)            // 关键词搜索排序
      const [rl, setRl] = React.useState(null)
      const [newVer, setNewVer] = React.useState('')       // 发现的新版本号（空 = 没发现）          // 日报形态：full / brief / off
      const [optim, setOptim] = React.useState({})   // 乐观更新：点下去先变，成功再以服务端为准
      // ⚠️ 输入框必须绑"本地草稿"：页面每 5 秒轮询 /status，服务端那份会把 config 盖掉
      //    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（2026-10-14 陌生人验收时抓到）
      const [perDay, setPerDay] = React.useState(null)
      const [perRound, setPerRound] = React.useState(null)
      const [replyPer, setReplyPer] = React.useState(null)
      const [dmUid, setDmUid] = React.useState(null)        // 私信收件人 UID（本地草稿）
      const [dmWatch, setDmWatch] = React.useState(null)          // 私信双向开关
      const [mention, setMention] = React.useState(null)
      const [mProv, setMProv] = React.useState(null)      // 手填模型的 provider（只在读不到模型列表时露出来）
      const [mName, setMName] = React.useState(null)      // 手填模型的 model id
      const [login, setLogin] = React.useState(null)
      const [runNote, setRunNote] = React.useState(null)
      const [report, setReport] = React.useState(null)        // 非 null = 报告已展开   // 顶部那行状态（跑一轮/装依赖的反馈原来在最底下，看不见）
      const [queue, setQueue] = React.useState(null)   // 工单 06：候选队列（null = 还没读）
      const [collectTimes, setCollectTimes] = React.useState(null)   // 工单 09：采集时间点草稿（一行一个 HH:MM）
      const [watchedRows, setWatchedRows] = React.useState(null)   // null = 还没读；[] = 读到了但没记录
      const [watchedPicked, setWatchedPicked] = React.useState(false) // 只看挑中的
    const [watchedState, setWatchedState] = React.useState('')
    const [watchedTier, setWatchedTier] = React.useState('')
    const [watchedOffset, setWatchedOffset] = React.useState(0)
    const [watchedTotal, setWatchedTotal] = React.useState(0)
    const [tab, setTab] = React.useState('daily')   // daily | taste | social | adv
      const [diag, setDiag] = React.useState(null)      // 诊断信息文本
      const [checks, setChecks] = React.useState(null)   // 环境自检结果 [{name, ok, detail, fix}]
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      /* ⚠️ 扫码轮询的 timer 必须能停：切走设置页后还在跑的话会在已卸载的组件上 setState，
       *    重复点「扫码登录」还会叠出第二个 timer。（2026-10-16 审查修） */
      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
      }, [])

      const cfg = st?.config
      React.useEffect(() => {
        if (cfg && kws === null) setKws((cfg.keywords || []).join('\n'))
        if (cfg && brief === null) setBrief(cfg.tasteBrief || '')
        if (cfg && gateViews === null) setGateViews(String(cfg.gateMinViews ?? 0))
        if (cfg && gateMin === null) setGateMin(String(cfg.gateMinMinutes ?? 0))
        if (cfg && gateDays === null) setGateDays(String(cfg.gateWithinDays ?? 0))
        if (cfg && persona === null) setPersona(cfg.personaPrompt || '')
        if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && mention === null) setMention(cfg.mentionName || '')
        if (cfg && mProv === null) setMProv(cfg.modelProvider || '')
        if (cfg && mName === null) setMName(cfg.modelName || '')
        if (cfg && dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (cfg && dmWatch === null) setDmWatch(cfg.dmWatch !== false)   // 2.0 起默认开
        if (cfg && favId === null) setFavId(String(cfg.favFolderId ?? 0))
        if (cfg && excl === null) setExcl((cfg.excludeWords || []).join('\n'))
        if (cfg && cLen === null) setCLen(cfg.commentLength || 'medium')
        if (cfg && fSort === null) setFSort(cfg.searchSort || 'pubdate')
        if (cfg && collectTimes === null) setCollectTimes((Array.isArray(cfg.collectTimes) ? cfg.collectTimes : []).join('\n'))
      }, [cfg])

      // ⭐ 收藏夹列表：只读一次，读不到就空列表（别每 5 秒重拉）
      // ⚠️ 2026-10-28：它要起一个 Python 去问 B站（1~3 秒）⇒ **延迟 1.2 秒再拉**，
      //    别在打开设置页的第一瞬间跟 /status 抢，否则页面看着像卡住（他报"退出再进会卡一段"）
      React.useEffect(() => {
        if (favFolders !== null) return
        const t = setTimeout(() => {
          jget('/fav-folders').then((r) => { if (alive.current) setFavFolders(r && r.ok ? (r.folders || []) : []) })
            .catch(() => { if (alive.current) setFavFolders([]) })
        }, 1200)
        return () => clearTimeout(t)
      }, [favFolders])

      // ⭐ 2026-10-23：可选模型列表（宿主从 llm 服务里问出来）—— 同样只读一次
      // ⭐ 2026-11-09（02-provider-mirror）：存整份返回 —— 除了 providers，还要用 unavailable / mirror 说清原因
      React.useEffect(() => {
        if (modelList !== null) return
        jget('/models').then((r) => {
          if (alive.current) setModelList(r && r.ok ? r : { providers: [], unavailable: [], mirror: null })
        }).catch(() => { if (alive.current) setModelList({ providers: [], unavailable: [], mirror: null }) })
      }, [modelList])

      // ⭐ 2026-11-04：已建好的工作区列表（宿主查 workspaceRegistry）—— 只读一次
      React.useEffect(() => {
        if (wsList !== null) return
        jget('/workspaces').then((r) => { if (alive.current) setWsList(r && r.ok ? (r.workspaces || []) : []) })
          .catch(() => { if (alive.current) setWsList([]) })
      }, [wsList])

      // ⭐ 2026-11-09（工单 06）：队列现状 —— 条数变了就重读一次（/status 是 5 秒轮询，别每跳都拉）
      React.useEffect(() => {
        jget('/queue').then((r) => { if (alive.current) setQueue(r && r.ok ? r : { items: [] }) })
          .catch(() => { if (alive.current) setQueue({ items: [] }) })
      }, [st?.queuePending, st?.queueTotal, st?.queueDroppedLast])

      const say = (text, tone) => {
        setMsg(text); setMsgTone(tone || '')
        setRunNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部，免得提示掉到页面最底下看不见
      }

      const patch = async (p, what) => {
        setOptim((old) => ({ ...old, ...p }))          // 先亮起来
        // ⭐ 2026-10-28：宿主每次保存都要顺手同步进 DSH 原生设置，几百毫秒回不来 ⇒
        //    先给一句「保存中…」，不然点下去到出结果之间是一片空白（他报「以前马上就出来，现在要等一会」）
        say(`${what || '设置'}：保存中…`, '')
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config }))
          // ⭐ 2026-10-25：保存后让「刷过的视频」tab 重查工作区（改 workspace 时 tab 要跟着挪）
          try { bumpScope() } catch { /* 忽略 */ }
          // ⭐ DSH 原生设置页里显式设过的键由宿主说了算 ⇒ 我们这份也得写进去；写失败要说出来，别假装"已保存"
          if (r?.host && r.host.ok === false) say(`${what || '设置'}：插件自己那份存了，但 DSH 设置页那份没写进去（${r.host.error}）`, 'warn')
          else say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        // 不管成功失败都清掉乐观值：成功时以服务端返回为准，失败时自动回到原样
        finally { setOptim({}); setBusy('') }
      }

      // 「它刷过的视频」：点开才读，读一次就留着（不会每 5 秒重拉）
    const WATCH_PAGE = 30
    const onLoadWatched = async (st, tr, off) => {
      setBusy('watched')
      try {
        const q = `/watched?limit=${WATCH_PAGE}&offset=${off}` + (st ? '&state=' + st : '') + (tr ? '&tier=' + encodeURIComponent(tr) : '')
        const r = await jget(q)
        setWatchedRows(r && r.ok ? (r.rows || []) : [])
        setWatchedTotal(r && r.ok ? (Number(r.total) || 0) : 0)
        setWatchedState(st)
        setWatchedTier(tr)
        setWatchedOffset(off)
        if (!r || r.ok === false) say('读不到记录：' + ((r && r.error) || '未知原因'), 'warn')
      } catch (e) { say('读不到记录：' + String(e?.message ?? e), 'warn') } finally { setBusy('') }
    }
    const onWatchPick = (kind, v) => {
      const cur = kind === 'state' ? watchedState : watchedTier
      const next = cur === v ? '' : v
      return onLoadWatched(kind === 'state' ? next : watchedState, kind === 'tier' ? next : watchedTier, 0)
    }
    const onWatchPage = (d) => onLoadWatched(watchedState, watchedTier, Math.max(0, watchedOffset + d))

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }       // 再点一次收起
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.exists ? (r.text || '（报告是空的）') : '今天还没有报告 —— 跑一轮之后就有了')
        } catch (e) { setReport('读不到报告：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      // ⭐ 复核评论：接口回"发送成功"≠ 公开可见（新号/风控会进审核，那时候连 @ 都不会推）
      //    所以让宿主真去拉一次评论列表 / 楼中楼，确认那条到底在不在。
      const onVerify = async () => {
        setBusy('verify')
        try {
          const r = await jpost('/verify', {})
          if (!r || !r.ok) { say('复核没跑成：' + ((r && r.error) || '未知原因'), 'warn'); return }
          const n = (r.checked || []).length
          const vis = (r.checked || []).filter((c) => c.visible === true).length
          if (!n) say(r.text || '没有需要复核的记录', 'good')
          else say(`复核完 ${n} 条：公开可见 ${vis} 条，其余「没查到」（可能还在审核 —— 看不到不等于没发出去）。结果也追加到今天的报告末尾了。`, vis ? 'good' : 'warn')
          if (r.report) setReport(null)
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      // ⭐ 把"要日志"变成"点一下"（2026-10-21）
      const onDiagnose = async () => {
        setBusy('diag')
        try {
          const r = await jget('/diagnose')
          const text = String(r?.text || '（没拿到诊断信息）')
          setDiag(text)
          copyText(text).catch(() => {})
          say('诊断信息已生成并复制到剪贴板', 'good')
        } catch (e) { say('生成诊断信息失败：' + String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }
      const onSelfCheck = async () => {
        setBusy('selfcheck')
        try {
          const r = await jget('/selfcheck')
          setChecks(Array.isArray(r?.items) ? r.items : [])
        } catch (e) { say('自检失败：' + String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const copyText = async (text) => {
        const v = String(text || '')
        try {
          await navigator.clipboard.writeText(v)
          say('已复制：' + v, 'good')
        } catch {
          say('复制失败 —— 路径是：' + v)       // 兜底：至少把路径显示出来，手动选中也能复制
        }
      }

      const onOpenFolder = async (what) => {
        try {
          const r = await jpost('/open', { what })
          if (r && r.ok) say('已请系统打开：' + (r.opened || '') + '（要是没看到窗口，用旁边的「复制报告路径」——那个一定成）', 'good')
          else say('打不开（' + ((r && r.error) || '未知原因') + '）—— 你可以手动打开这个路径：' + ((r && r.dir) || ''))
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const onUpgrade = async () => {
        setBusy('upgrade')
        try {
          const r = await jpost('/upgrade', {})
          // 原来这两句分两次 say，第二句把服务端的 hint 冲掉了 —— 合成一句。（2026-10-16 审查修）
          say(((r && r.hint) || '正在升级') + ' —— 升级过程写在下面的「主依赖的日志」里；完了记得重启一次 dsh（不重启还是旧版）', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheckUpdate = async () => {
        setBusy('update')
        try {
          const r = await jget('/update')
          if (r && r.ok && r.latest) {
            const from = r.source === 'github' ? '（npm 上还没发上去，这个版本来自 GitHub）' : ''
            if (r.hasNew) {
              setNewVer(r.latest)
              say('有新版 v' + r.latest + '（你的是 v' + r.current + '）' + from + ' —— 点右边的「一键升级」，完了重启一次 dsh', 'warn')
            } else say('已经是最新版 v' + r.current + from, 'good')
          } else {
            say('查不到最新版（可能网络不通）—— 你现在的版本是 v' + ((r && r.current) || '?'))
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheck = async () => {
        setBusy('check')
        say('')
        try {
          const r = await jpost('/check', {})
          if (r && r.ok) say('能用！' + (r.steps || []).join('、'))
          else say('还不能用：' + (r && r.error ? r.error : '没拿到结果'))
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstallAsr = async () => {
        setBusy('asr')
        say('')
        try {
          const r = await jpost('/install-asr', {})
          say(r?.started ? '开始装转写依赖 —— 进度显示在下面（要下模型，慢一点正常）' : (r?.hint || '没起来'),
            r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        say('')
        try {
          const r = await jpost('/install', {})
          say(r?.hint || '已经在后台开始装了', '')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          // ⭐ 2026-10-23：宿主现在会挡"上一轮还在跑"，把它的原话显示出来，别一概说"没起来"
          if (r?.started) {
            say('已经在后台跑一轮采集了，报告会写在 out/ 里'
              + (r?.queueFullHint ? '。⚠️ ' + r.queueFullHint : ''), r?.queueFullHint ? 'warn' : 'good')
          } else say(r?.error || '没起来，看 duty.log', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      // ⭐ 工单 09：「现在投递」—— 立刻发队头一条（宿主侧手动投递：不看间隔 / 免打扰 / 当日额度）
      const onDeliver = async () => {
        setBusy('deliver')
        try {
          const r = await jpost('/deliver-now', {})
          const msg = String(r?.message || (r?.sent ? '已投递' : '没发成'))
          say(msg, r?.sent ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      // ⭐ 工单 09：采集时间点（一行一个 HH:MM）；清洗 / 排序 / 去重 / 最多 12 个都由宿主做，
      //    这里只把文本框里非空的行交上去；清空 = []，宿主那边是合法值（= 不按时间点自动采集）。
      const saveCollectTimes = async () => {
        const list = String(collectTimes || '').split('\n').map((s) => s.trim()).filter(Boolean)
        await patch({ collectTimes: list }, '采集时间点')
      }

      const onLoginStart = async () => {
        setBusy('login')
        setLoginTone('')
        setLoginState('正在出码…')
        try {
          const r = await jpost('/login/start', {})
          if (!r?.ok) { setLoginTone('warn'); setLoginState(r?.error || '出码失败'); return }
          setLogin({ key: r.key, qr: r.qr })
          if (!r.qr) { setLoginTone('warn'); setLoginState('没画出二维码 —— 先点上面的「重装依赖」（venv 里要有 qrcode）') }
          else setLoginState('用手机 B站 扫这张码')
          if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }   // 重复点：先把上一轮停掉
          let n = 0
          const stop = () => { clearInterval(timer); if (loginTimer.current === timer) loginTimer.current = null }
          const timer = setInterval(async () => {
            if (!alive.current) { stop(); return }        // 已经切走设置页了：别再问、别再 setState
            n += 1
            try {
              const p = await jpost('/login/poll', { key: r.key })
              if (p?.state === 'ok') {
                stop(); setLogin(null)
                setLoginTone('good'); setLoginState('登录成功')
                setSt((old) => ({ ...old, loggedIn: true }))
              } else if (p?.state === 'scanned') { setLoginTone(''); setLoginState('扫到了，请在手机上确认') }
              else if (p?.state === 'expired') { stop(); setLogin(null); setLoginTone('warn'); setLoginState('二维码过期了，再点一次「扫码登录」') }
              // ⚠️ 扫码成功但响应里没有 SESSDATA 时服务端回 state='unknown'：原来没这个分支
              //    ⇒ 界面一直显示「等扫码…」，用户白等 3 分钟才超时。（2026-10-16 审查修）
              else if (p?.state === 'unknown') {
                stop(); setLogin(null); setLoginTone('warn')
                setLoginState('没登上：' + (p?.message || '响应里没有 SESSDATA —— 再点一次「扫码登录」'))
              }
              else { setLoginTone(''); setLoginState('等扫码…') }
            } catch { /* 抖动就下次再问 */ }
            if (n > 90) { stop(); setLogin(null); setLoginTone('warn'); setLoginState('超时了，再点一次「扫码登录」') }
          }, 2000)
          loginTimer.current = timer
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      const onFavToday = async () => {
        setBusy('fav')
        try {
          const r = await jpost('/fav-today', {})
          if (!r || r.ok === false) say('收藏没做成：' + ((r && r.error) || '未知原因'), 'warn')
          else say(`收藏好了：${r.added}/${r.total} 条` + (r.failures && r.failures.length ? `（失败 ${r.failures.length} 条）` : ''), 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onSaveText = async () => {
        const list = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        const list2 = String(excl || '').split('\n').map((s) => s.trim()).filter(Boolean)
        const briefText = String(brief || '').trim()
        // ⭐ 2026-11 工单 03：三条门槛在界面上也钳一遍（宿主那边还会再钳一次，这里是让输入框当场收敛）
        const nViews = Math.max(0, Math.min(Math.floor(Number(gateViews) || 0), GATE_UI_MAX.views))
        const nMin = Math.max(0, Math.min(Math.floor(Number(gateMin) || 0), GATE_UI_MAX.minutes))
        const nDays = Math.max(0, Math.min(Math.floor(Number(gateDays) || 0), GATE_UI_MAX.days))
        // ⭐ 被清空的项要显式带 clear —— 宿主有"空值不覆盖已有值"的保护（防自动保存清空人设），
        //    不带的话用户把关键词/排除词删光了也保存不上，界面还会说"已保存" ✗（2026-10-27 他报的）
        const clear = []
        if (!list.length) clear.push('keywords')
        if (!list2.length) clear.push('excludeWords')
        if (!String(persona || '').trim().length) clear.push('personaPrompt')
        if (!briefText.length) clear.push('tasteBrief')     // ⭐ 简报也要能清空（同上：不带 clear 就删不掉）
        await patch({
          keywords: list, excludeWords: list2,
          commentLength: String(cLen || 'medium'), searchSort: String(fSort || 'pubdate'),
          personaPrompt: String(persona || '').trim(),
          tasteBrief: briefText, gateMinViews: nViews, gateMinMinutes: nMin, gateWithinDays: nDays,
          ...(clear.length ? { clear } : {}),
        }, '口味 / 关键词 / 排除词 / 人设')
      }

      if (!cfg) {
        return h('div', { 'data-bd-page': '' },
        // ⭐ 2026-10-28：提示改成吸顶固定在最上面 —— 以前它挨着「保存」，往下滚到某个开关就看不见了（他报「绿字没了」）
        msg ? h('div', { 'data-bd-msg': '', 'data-bd-msgbar': '', 'data-good': msgTone === 'good' ? '' : undefined, 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null,
          h('div', { 'data-bd-note': '' }, fails >= 3
            ? '读不到插件配置（已经试了 ' + fails + ' 次）。常见原因有三个：装的还是 0.1.11 / 0.1.12（那两版有 bug，会卡在这里）；刚装完没重启 dsh；或者插件加载失败。'
            : '读设置中…'),
          fails >= 6 ? h('div', { 'data-bd-note': '' },
            '可以先试：升级到最新版（dsh plugin --profile web add github:c1overzz/dsh-bili-scroll）→ 重启 dsh；还不行就把 ' +
            '%USERPROFILE%\\.dsh\\bili-duty\\duty.log 的最后几十行发给作者。') : null)
      }

      // 点了先变，别等网络回来（宿主写 DSH 设置那一步可能要几百毫秒）
      const sw = (k) => Boolean(k in optim ? optim[k] : cfg[k])
      // ⭐ 工单 08：人设留空 ⇒ 公开评论不可用（置灰 + 说原因；**不改用户存的值**，行为和 UI 按不可用处理）
      const personaMissing = Boolean(st && st.personaPresent === false)

      /* ⭐ 2026-10-23：模型下拉 —— 值用 `provider|model` 拼成一个字符串，
       *    这样「跟随当前会话」（空值）和"钉死某一个"用同一个 select 就能表达。 */
      /* ⭐⭐ 2026-11-09（02-provider-mirror）：白名单没了 —— 后端按「这一轮实际装了什么」算好：
       *    DeepSeek 内置两条 + 每轮从主 profile 镜像进值班轮 overlay 的 provider。
       *    usable = 'yes' 是真能用；'no' 是宿主有、但这一轮没有，`why` 里写了原因
       *    （主 profile 没配 / 含内联密钥被拒 / 配置没读成）—— 照样列出来，只是禁用选项 + 把原因写在标题上。 */
      const usableList = (modelList && modelList.providers) || []
      const mirror = st.modelMirror || (modelList && modelList.mirror) || null
      const hasUsable = usableList.some((p) => p.usable === 'yes')
      const modelOptions = []
      for (const p of usableList) if (p.usable === 'yes') for (const m of (p.models || [])) modelOptions.push(p.id + '|' + m.id)
      const modelValue = (cfg.modelProvider && cfg.modelName) ? String(cfg.modelProvider) + '|' + String(cfg.modelName) : ''
      /* ⭐ 2026-11-04：工作区下拉的当前值 —— 配置里存的可能是带斜杠/反斜杠的路径，和注册表里的写法不一定一样 */
      const normWs = (x) => { let v = String(x || '').split(String.fromCharCode(92)).join('/'); while (v.endsWith('/')) v = v.slice(0, -1); return v.toLowerCase() }
      const wsValue = (() => {
        const cur = String(cfg.workspace || '')
        const hit = (wsList || []).find((w) => normWs(w.path) === normWs(cur))
        return hit ? hit.path : cur
      })()
      /* ⭐ 分组标题上写清楚这条路怎么用：deepseek-official 要 API key，账号登录的机器选它跑不起来 */
      const PROVIDER_HINT = { 'deepseek-account': ' · 账号登录', 'deepseek-official': ' · 需要 API key' }
      const providerLabel = (p) => {
        const base = (p.name || p.id) + (PROVIDER_HINT[p.id] || '')
        return p.usable === 'yes' ? base : base + ' · 不可用' + (p.why ? '：' + p.why : '')
      }
      const pickModel = (v) => {
        if (!v) { patch({ modelProvider: '', modelName: '' }, '模型'); return }
        const i = v.indexOf('|')
        if (i < 0) return
        patch({ modelProvider: v.slice(0, i), modelName: v.slice(i + 1) }, '模型')
      }
      /* ⭐ 2026-10-23：现在这一轮已经跑了多久（宿主挡并发 + 超时自动收） */
      const runMinutes = (st && st.running)
        ? Math.max(0, Math.round((Date.now() - Number(st.runningSince || Date.now())) / 60_000))
        : 0

      /* ⭐ 工单 09：两个手动入口的状态 —— 宿主 /status 已经把「可不可点 / 还剩几秒」算好了，页面只做呈现 */
      const deliverCooldownSec = Math.max(0, Math.ceil((Number(st?.manualDeliverCooldownRemainingMs) || 0) / 1000))
      const collectCooldownMin = Math.ceil((Number(st?.manualCollectCooldownRemainingMs) || 0) / 60_000)
      const deliverDisabled = Boolean(busy) || Boolean(st?.deliveryEnabled) === false
        || st?.queueEmpty !== false || deliverCooldownSec > 0
      const deliverTitle = Boolean(st?.deliveryEnabled) === false
        ? (st?.deliveryPausedReason || '私信关着 —— 不投递')
        : st?.queueEmpty !== false
          ? '队列里没有待投递的候选（等下一轮采集）'
          : deliverCooldownSec > 0
            ? '刚点过，再等 ' + deliverCooldownSec + ' 秒'
            : '立刻发队头一条：不看间隔与免打扰、不占当天额度'
      const nextCollectText = st?.nextCollectAt
        ? '下一次采集：' + new Date(st.nextCollectAt).toLocaleString('zh-CN')
        : '还没有下一次采集（时间点空着 ⇒ 只能手动跑）'

      return h('div', { 'data-bd-page': '' },

        /* ── 今天 ── */
        h('div', { 'data-bd-row': '' },
          h('span', { 'data-bd-badge': '' }, `自动已挑 ${st.autoPicked ?? st.pickedToday ?? 0} / ${cfg.perDay} 条` + ((st.manualExtra > 0) ? ` · 手动 ${st.manualExtra} 条` : '')),
          h('span', { 'data-bd-badge': '' }, '环境' + (st.venvReady ? '已就绪' : (st.installing ? '正在装' : '未装'))),
          h('span', { 'data-bd-badge': '' }, st.loggedIn ? 'B站已登录' : 'B站未登录'),
            h('span', { 'data-bd-badge': '' }, 'v' + (st.version || '?')),
          // ⭐ 2026-10-23：正在跑的时候把"跑了多久"摆出来 —— 以前连点两次会并行两轮，现在宿主会挡
          st.running ? h('span', { 'data-bd-badge': '' }, '正在跑 ' + runMinutes + ' 分钟') : null,
          h('div', { 'data-bd-grow': '' }),
          // ⭐ 工单 09：两个手动入口拆开 —— 「现在跑一轮采集」看 running；「现在投递」看队列 / 私信 / 防连点
          h('button', {
            'data-bd-btn': '', disabled: busy === 'run' || Boolean(st.running) || collectCooldownMin > 0,
            title: st.running ? '上一轮还没跑完；卡住了会在 ' + (st.runTimeoutMinutes || 20) + ' 分钟时自动收掉'
              : (collectCooldownMin > 0 ? '刚点过，再等约 ' + collectCooldownMin + ' 分钟' : '立刻跑一轮采集：不看时间点与水位闸'),
            onClick: onRun,
          }, st.running ? '采集中…' : '现在跑一轮采集'),
          h('button', {
            'data-bd-btn': '', disabled: deliverDisabled,
            title: deliverTitle,
            onClick: onDeliver,
          }, busy === 'deliver' ? '投递中…' : '现在投递')),
          runNote ? h('div', { 'data-bd-msg': '', 'data-good': runNote.tone === 'good' ? '' : undefined,
            'data-warn': runNote.tone === 'warn' ? '' : undefined }, runNote.t) : null,


        /* ── 定时 ── */
        h('div', { 'data-bd-tabs': '' },
          [['daily', '日常'], ['taste', '偏好'], ['social', '互动'], ['adv', '高级']].map(([v, label]) =>
            h('button', { key: v, 'data-bd-tab': '', 'aria-selected': tab === v ? 'true' : 'false', onClick: () => setTab(v) }, label))),

        h('div', { 'data-bd-row': '' },
          h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSaveText }, '保存')),

        h('div', { 'data-bd-sec': '', 'data-bd-group': 'daily', 'data-bd-away': tab === 'daily' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '什么时候自己跑'),
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '采集时间点'),
              h('div', { 'data-bd-note': '' },
                '一行一个 HH:MM（本机时间，最多 12 个）；到点跑一轮采集，错过的时点不补跑。'
                + '留空 = 只手动跑。'))),
          h('textarea', {
            'data-bd-input': '', rows: 4,
            placeholder: '12:30\n19:30',
            value: collectTimes ?? '',
            onChange: (e) => setCollectTimes(e.target.value),
            onBlur: () => { saveCollectTimes() },
          }),
          h('div', { 'data-bd-note': '' }, nextCollectText
            + (Number(st?.queuePending) > 0 ? ' · 队列里 ' + Number(st.queuePending) + ' 条待投递' : ' · 队列是空的')),
          st?.lastCollectAt
            ? h('div', { 'data-bd-note': '' }, '上次采集：' + new Date(st.lastCollectAt).toLocaleString('zh-CN')
              + (collectCooldownMin > 0 ? ' · 手动冷却还剩约 ' + collectCooldownMin + ' 分钟' : ''))
            : null),

        /* ── 一轮挑几条 ── */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'daily', 'data-bd-away': tab === 'daily' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '一轮挑几条'),
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '每天最多挑几条'),
              h('div', { 'data-bd-note': '' }, '填 0 = 不自动刷（还是能手动跑）')),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 50,
              value: perDay ?? '',
              onChange: (e) => setPerDay(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(perDay) || 0, 50)); setPerDay(String(n)); patch({ perDay: n }, '每天挑几条') },
            })),
          st.lastRunAt ? h('div', { 'data-bd-note': '' }, `上次跑：${new Date(st.lastRunAt).toLocaleString('zh-CN')}`) : null),

        /* ── 队列（工单 06）：采集轮攒下来的候选 ──（10 会把它挪到「今天」那块；先保证能看见） */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'daily', 'data-bd-away': tab === 'daily' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '队列（等着发给你的候选）'),
          h('div', { 'data-bd-note': '' },
            queue === null
              ? '读取中…'
              : (Number(st?.queuePending) || 0) + ' 条待投递'
                + (Number(st?.queueLimit) ? ' · 上限 ' + Number(st.queueLimit) + ' 条' : '')
                + (st?.queueNext ? ' · 下一条：' + st.queueNext.title : '')),
          queue && Array.isArray(queue.items) && queue.items.length
            ? h('div', { 'data-bd-list': '' }, queue.items.map((x) => h('div', { key: x.id, 'data-bd-item': '' },
                h('div', { 'data-bd-item-body': '' },
                  h('div', { 'data-bd-item-t': '' }, x.title || x.bvid),
                  h('div', { 'data-bd-item-n': '' },
                    x.bvid + ' · ' + (x.up || '未知 UP')
                    + ' · 还能放 ' + Math.max(0, Math.round(Number(x.expiresInHours) || 0)) + ' 小时')))))
            : h('div', { 'data-bd-note': '' }, queue === null ? '' : '队列是空的 —— 采集轮挑到候选后会攒在这儿'),
          Number(st?.queueDroppedLast) > 0
            ? h('div', { 'data-bd-note': '' }, '上一轮队列满了，有 ' + Number(st.queueDroppedLast) + ' 条没进来（上限 '
              + (Number(st.queueLimit) || 3) + ' 条）—— 详情在今天的日报「队列」一节')
            : null),

        /* ── 用哪个模型跑 ──（⭐ 2026-11-04：挪到「高级」—— 它装的时候定一次就好，不是每天会动的东西；摆在「日常」里会让人以为要天天调） */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'adv', 'data-bd-away': tab === 'adv' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '用哪个模型跑'),
          h('select', {
            'data-bd-input': '', value: modelValue,
            onChange: (e) => pickModel(e.target.value),
          },
            h('option', { value: '' }, '跟随当前会话选的模型（默认）'),
            (modelValue && modelOptions.indexOf(modelValue) < 0)
              ? h('option', { value: modelValue }, modelValue.replace('|', ' / ') + '（当前设置）') : null,
            ...usableList.map((p) => h('optgroup', { key: p.id, label: providerLabel(p) },
              (p.models || []).map((m) => h('option', {
                key: p.id + '|' + m.id, value: p.id + '|' + m.id,
                disabled: p.usable === 'yes' ? undefined : true,   // ⭐ 不可用的只展示原因，别让人选进去白跑一轮
              }, (m.name && m.name !== m.id) ? m.name + '（' + m.id + '）' : m.id))))),
          h('div', { 'data-bd-note': '' },
            '它每轮是另起一个 headless 会话跑的 —— 默认用你在会话里选的那个模型；'
            + '想让它固定用某个（比如更省 / 更强），就在这里选。改完下一轮生效，不用重启。'),
          h('div', { 'data-bd-note': '' },
            '值班轮跑在另一个 profile（默认 `bili-duty`），但每轮会把**你正在用的主 profile**'
            + (mirror && mirror.profile ? '（`' + mirror.profile + '`）' : '')
            + '里配好的 provider 定义镜像过去 ⇒ 上面列的就是这一轮真能用的：DeepSeek 两条 + 你自己配的第三方 provider。'
            + '镜像只搬 `config.providers` 那一段、密钥不复制（仍走 apiKeyEnv / 凭据库）；主 profile 的配置改了，下一轮自动生效。'),
          mirror && mirror.rejected && mirror.rejected.length
            ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
              '主 profile 里有 ' + mirror.rejected.length + ' 个 provider 没镜像过来（含内联密钥）：'
              + mirror.rejected.map((x) => x.provider + '（' + x.key + '）').join('、')
              + '。改成 apiKeyEnv 引用环境变量后，下一轮就会带上。') : null,
          mirror && mirror.ok === false
            ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
              '没读到主 profile 的 provider 配置：' + (mirror.error || '原因未知')
              + ' ⇒ 这一轮只有 DeepSeek 两条（原因也写进 duty.log 了）。') : null,
          st.model && st.model.unavailable ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
            '你指定的 ' + st.model.provider + ' / ' + st.model.model + ' 这一轮用不了'
            + (st.modelWhy ? '：' + st.modelWhy : '。')
            + '钉了就照用、不悄悄换 ⇒ 这一轮很可能在第一个请求前就失败（NO_ADAPTER），原因写进 duty.log。'
            + '换一个上面列出的可用模型，或留空跟随当前会话。') : null,
          st.model && st.model.source === 'fallback' ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
            '你当前会话用的模型'
            + (st.model.sessionIgnored ? ' ' + st.model.sessionIgnored.provider + ' / ' + st.model.sessionIgnored.model : '')
            + ' 这一轮用不了（主 profile 里没配、或没镜像过来）⇒ 这一轮会改用 '
            + st.model.provider + ' / ' + st.model.model + ' 跑，不会白跑。'
            + '想固定它的话，在上面选一个。') : null,
          modelList === null ? h('div', { 'data-bd-note': '' }, '模型列表读取中…') : null,
          (modelList && !hasUsable)
            ? h('div', { 'data-bd-note': '' }, '没读到可用的模型 —— 宿主里没列出 deepseek-account / deepseek-official。仍然可以「跟随当前会话」。') : null,
          (modelList && !hasUsable) ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-note': '' }, '也可以直接手填（这一轮真装了的才会生效：DeepSeek 两条 + 主 profile 镜像过来的 provider；两个都填才生效，留空 = 跟随当前会话）：'),
            h('div', { 'data-bd-row': '' },
              h('input', {
                'data-bd-input': '', placeholder: 'provider（如 deepseek-account）', value: mProv ?? '',
                onChange: (e) => setMProv(e.target.value),
                onBlur: () => patch({ modelProvider: String(mProv || '').trim(), modelName: String(mName || '').trim() }, '模型'),
              }),
              h('input', {
                'data-bd-input': '', placeholder: 'model（如 deepseek-flash）', value: mName ?? '',
                onChange: (e) => setMName(e.target.value),
                onBlur: () => patch({ modelProvider: String(mProv || '').trim(), modelName: String(mName || '').trim() }, '模型'),
              }))) : null,
          (modelList && modelList.unavailable && modelList.unavailable.length) ? h('div', { 'data-bd-note': '' },
            '这些 provider 这一轮用不了：'
            + modelList.unavailable.map((u) => u.id + '（' + (u.why || '主 profile 没配') + '）').join('；')) : null,
          st.model ? h('div', { 'data-bd-note': '' },
            '下一轮会用：' + st.model.provider + ' / ' + st.model.model
            + (st.model.source === 'plugin' ? (st.model.unavailable ? '（这里指定的；⚠️ 这一轮没有它）' : '（这里指定的）')
              : st.model.source === 'fallback' ? '（兜底，见上面的提示）'
                : '（跟随当前会话）')) : null),

        /* ── 发言与转写 ── */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'social', 'data-bd-away': tab === 'social' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '它怎么把结果给你'),
          h(ToggleRow, {
            label: '私信发给我',
            note: '默认开。采集轮只把候选攒进队列，宿主按它一条一条私信发给你。关掉 = 不建队列、不投递，采集轮退回写日报。',
            on: sw('channelDm'),
            onChange: (v) => patch({ channelDm: v }, '私信'),
          }),
          h(ToggleRow, {
            label: '在视频下公开评论 @ 我',
            note: personaMissing
              ? '人设留空时不会公开说话 —— 先填「人设提示词」，这个开关才能生效。'
              : '公开，别人也看得见。人设留空时不会公开说话。',
            on: sw('channelComment'),
            disabled: personaMissing,
            onChange: (v) => patch({ channelComment: v }, '公开评论'),
          }),
          (personaMissing && sw('channelComment')) ? h('div', { 'data-bd-note': '' },
            '「公开评论」存着是开，但现在不会发：' + (st.commentBlockedReason || '人设留空')) : null,
          h('div', { 'data-bd-label': '' }, '发给谁 / @ 谁（B站 昵称）'),
          h('input', {
            'data-bd-input': '', value: mention ?? '',
            placeholder: '填你自己的 B站 昵称；私信按它查 UID，评论也 @ 它',
            onChange: (e) => setMention(e.target.value),
            onBlur: () => { const v = String(mention || '').trim(); setMention(v); patch({ mentionName: v }, '发给谁') },
          }),
          sw('channelDm') ? h('div', { 'data-bd-note': '' }, '私信会发给他（用昵称自动查一次 UID；查不到就先攒着，不会一条都不送）。') : null,
          sw('channelDm') ? h('div', { 'data-bd-note': '' }, '私信内容 = 队列里的一条视频 + 一段按人设写好的草稿；一条一条发，不打包。⚠️ 建议先让这个号和收件人互关：B站 对「陌生人私信」会限流，还可能不弹提醒。') : null,

          sw('channelComment') ? h('div', { 'data-bd-sep': '' }) : null,
          sw('channelComment') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每轮最多发几条评论'),
                h('div', { 'data-bd-note': '' }, '每条评论里 @ 一次上面那个人；填 0 = 这一轮不发评论')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 20,
                value: perRound ?? '',
                onChange: (e) => setPerRound(e.target.value),
                onBlur: () => { const n = Math.max(0, Math.min(Number(perRound) || 0, 20)); setPerRound(String(n)); patch({ commentPerRound: n }, '每轮发几条评论') },
              }))) : null,
          sw('channelComment') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '评论写多长'),
                h('div', { 'data-bd-note': '' }, '短 ≤15 字 · 中 ≤40 字 · 长 ≤100 字（默认中）')),
              h('select', {
                'data-bd-input': '', value: cLen ?? 'medium',
                onChange: (e) => { setCLen(e.target.value); patch({ commentLength: e.target.value }, '评论长度') },
              },
                h('option', { value: 'short' }, '短'),
                h('option', { value: 'medium' }, '中'),
                h('option', { value: 'long' }, '长')))) : null,
          sw('channelComment') ? h(ToggleRow, {
            label: '回复评论（只回楼中楼）',
            note: '开了之后它只回「直接回复到你那条评论下面的人」，不参与讨论',
            on: sw('replyToComments'),
            onChange: (v) => patch({ replyToComments: v }, '回复评论'),
          }) : null,
          sw('channelComment') && sw('replyToComments') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每轮最多回几条'),
                h('div', { 'data-bd-note': '' }, '只回直接回在你那条评论下面的人')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 1, max: 10,
                value: replyPer ?? '',
                onChange: (e) => setReplyPer(e.target.value),
                onBlur: () => { const n = Math.max(1, Math.min(Number(replyPer) || 1, 10)); setReplyPer(String(n)); patch({ replyPerRound: n }, '每轮回几条') },
              }))) : null,

          h('div', { 'data-bd-sep': '' }),
          h(ToggleRow, {
            label: '私信双向（有人私信它就回一句）',
            note: '默认开。你在 B站 私信里跟它说话，它会回你（陌生人的私信不回）。⭐ 查私信本身不花 token，只有真收到你的新消息时才花一点点。',
            on: Boolean(dmWatch),
            onChange: (v) => { setDmWatch(v); patch({ dmWatch: v }, '私信双向') },
          }),
          // ⭐ 2026-10-23：**不加新输入框**，只把"它认谁当主人"显示出来 —— 填错当场看得见 ✓
          (st.ownerInfo && dmWatch) ? h('div', { 'data-bd-note': '' },
            '它会认这个人当主人：',
            (st.ownerInfo.name ? st.ownerInfo.name + ' · ' : ''),
            'uid ' + st.ownerInfo.uid,
            st.ownerInfo.self ? '（就是现在登录的这个号）' : '',
            ' —— 想换人，改上面那个「要 @ 谁」就行') : null,
          h(ToggleRow, {
            label: '本地转写没字幕的视频',
            note: '默认关；开了以后，没字幕的视频会在本机转写一遍（不花 API 钱）',
            on: sw('transcribe'),
            onChange: (v) => patch({ transcribe: v }, '本地转写'),
          }),
          sw('transcribe') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('button', { 'data-bd-btn': '', disabled: busy === 'asr', onClick: onInstallAsr },
                st.asrReady ? '重装转写依赖' : '装转写依赖'),
              h('div', { 'data-bd-note': '' },
                !st.asrReady ? '还没装 —— 现在开着也没用：没字幕的视频会被跳过（报告里会写"因无字幕跳过 N 条"）'
                  : (st.asrModelReady ? '环境和模型都好了' : '环境好了；模型会在第一次转写时自动下（几百 MB）'))),
            h('div', { 'data-bd-note': '' },
              '点一下就好：建一个独立环境、装 faster-whisper + yt-dlp，并把 Whisper 模型也下好',
              h('br'),
              '（模型默认 small，几百 MB，走国内镜像；装一次就够了）'),
            st.asrTail ? h('div', null,
              h('div', { 'data-bd-note': '' }, st.asrInstalling ? '正在装转写依赖（进度）：' : '转写依赖的日志（末尾）—— 只有「没字幕的视频」用得到它：'),
              h('pre', { 'data-bd-pre': '' }, st.asrTail)) : null) : null),

        /* ── 工作区（值班轮跑在哪儿 / 会话归到哪儿）── */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'taste', 'data-bd-away': tab === 'taste' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '工作区'),
          h('select', {
            'data-bd-input': '', value: wsValue,
            onChange: (e) => patch({ workspace: e.target.value }, '工作区'),
          },
            h('option', { value: '' }, '不限定（会话留在插件家，不归任何工作区）'),
            ...(wsList || []).map((w) => h('option', { key: w.id, value: w.path },
              (w.title || w.path) + '（' + w.path + '）')),
            (wsValue && !(wsList || []).some((w) => normWs(w.path) === normWs(wsValue)))
              ? h('option', { value: wsValue }, wsValue + '（当前设置，不在列表里）') : null),
          h('div', { 'data-bd-note': '' },
            '值班轮就跑在这个目录里：会话会归到这个工作区（而不是侧栏「未分组」）、它的 AGENTS.md 会作为人设参考，'
            + '「刷过的视频」tab 也只在这个工作区的会话里出现。'),
          wsList === null ? h('div', { 'data-bd-note': '' }, '工作区列表读取中…') : null,
          (wsList && wsList.length === 0) ? h('div', { 'data-bd-note': '' }, 'DSH 里还没建过工作区 —— 先在左侧新建一个，再回来选。') : null),

        /* ── 口味：想让它找什么 / 硬门槛 / 排除词 ──
         * ⭐ 2026-11 工单 03：简报（一段话）是「找什么」的主依据；老关键词降成「你可能想搜这些」；
         *    硬门槛可选、默认关（关着 = 行为与以前一样）。 */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'taste', 'data-bd-away': tab === 'taste' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '想让它找什么'),
          h('div', { 'data-bd-label': '' }, '一段话：这一轮想看什么（以它为主）'),
          h('textarea', {
            'data-bd-input': '', rows: 4,
            placeholder: '比如：想看真正上手 DeepSeek Harness 的实操，最好带命令和踩坑；少看发布会和吹水的。',
            value: brief ?? '', onChange: (e) => setBrief(e.target.value),
          }),
          h('div', { 'data-bd-note': '' },
            '它会按这段话自己决定：刷首页推荐流，还是从这段话里提炼几个词去搜 —— 挑的时候也按这段话筛。'
            + '留空 = 退回老办法（有下面那些关键词就搜关键词，没有就刷推荐流）。'),
          // ⭐ 和「人设」一样把字数亮出来：宿主那边超 4000 会截（别让人以为写的全生效了）
          h('div', { 'data-bd-note': '' },
            '字数：' + String(brief ?? '').length
            + (String(brief ?? '').length > 4000 ? '（⚠️ 超过 4000，保存时会被截到 4000）' : '')),
          h('div', { 'data-bd-label': '' }, '老的关键词（当作「你可能想搜这些」）—— 一行一个；填了上面那段话时它只是参考，不是硬指令'),
          h('textarea', {
            'data-bd-input': '', rows: 3, placeholder: '一行一个关键词；留空 = 刷首页推荐流（像人一样随便逛）',
            value: kws ?? '', onChange: (e) => setKws(e.target.value),
          }),
          /* ⭐ 2026-11 工单 03：可选数值硬门槛 —— 默认关；开了先按三条筛，挡掉的条数进日报，也从 /status 读回来 */
          h('div', { 'data-bd-h': '' }, '硬门槛（可选 · 默认关）'),
          h(ToggleRow, {
            label: '先按数值筛一遍',
            note: '开了以后它先按下面三条挡掉明显不合格的（不读字幕），挡掉的条数会写进当天的日报（日报关着就记不了）。关着 = 行为和以前一样。',
            on: sw('gateEnabled'),
            onChange: (v) => patch({ gateEnabled: v }, '硬门槛'),
          }),
          sw('gateEnabled') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '最低播放量'),
                h('div', { 'data-bd-note': '' }, '0 = 不限 · 最多 1000 万')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: GATE_UI_MAX.views,
                value: gateViews ?? '0',
                onChange: (e) => setGateViews(e.target.value),
                onBlur: () => { const n = Math.max(0, Math.min(Math.floor(Number(gateViews) || 0), GATE_UI_MAX.views)); setGateViews(String(n)); patch({ gateMinViews: n }, '最低播放量') },
              })),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '最短时长（分钟）'),
                h('div', { 'data-bd-note': '' }, '0 = 不限 · 最多 600（10 小时）')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: GATE_UI_MAX.minutes,
                value: gateMin ?? '0',
                onChange: (e) => setGateMin(e.target.value),
                onBlur: () => { const n = Math.max(0, Math.min(Math.floor(Number(gateMin) || 0), GATE_UI_MAX.minutes)); setGateMin(String(n)); patch({ gateMinMinutes: n }, '最短时长') },
              })),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '只看最近几天发布的'),
                h('div', { 'data-bd-note': '' }, '0 = 不限 · 最多 365 天')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: GATE_UI_MAX.days,
                value: gateDays ?? '0',
                onChange: (e) => setGateDays(e.target.value),
                onBlur: () => { const n = Math.max(0, Math.min(Math.floor(Number(gateDays) || 0), GATE_UI_MAX.days)); setGateDays(String(n)); patch({ gateWithinDays: n }, '发布时间窗') },
              })),
            h('div', { 'data-bd-note': '' }, '三条都填 0 = 等于没开（0 都是「不限」）。'),
            h('div', { 'data-bd-note': '' },
              '今天硬门槛挡掉 ' + (Number(st.gateBlocked) || 0) + ' 条（读自今天的日报；这一行由它在报告里写，没写就按 0 算）')) : null,
          h('div', { 'data-bd-label': '' }, '排除词（一行一个）—— 标题 / UP / 简介里出现这些词的，整条跳过'),
          h('textarea', {
            'data-bd-input': '', rows: 3, placeholder: '一行一个词；留空 = 不过滤',
            value: excl ?? '', onChange: (e) => setExcl(e.target.value),
          }),
          h('div', { 'data-bd-label': '' }, '要搜的时候怎么排序'),
          h('select', { 'data-bd-input': '', value: fSort ?? 'pubdate', onChange: (e) => setFSort(e.target.value) },
            h('option', { value: 'pubdate' }, '最新（默认，适合看近几天）'),
            h('option', { value: 'click' }, '播放最多'),
            h('option', { value: 'dm' }, '弹幕最多'),
            h('option', { value: 'totalrank' }, '综合')),
          h('div', { 'data-bd-label': '' }, '它按什么说话（人设提示词）—— 留空也能用：默认口语、短句、必带一个只有看了那条视频才说得出的细节'),
          h('textarea', {
            'data-bd-input': '', rows: 6,
            placeholder: '想让它怎么说话就写在这儿 —— 比如「叫我某某，说话简短点，别用 emoji」。也可以直接填一个文件路径（如 D:\\deepseek\\AGENTS.md，或它所在的那个目录），每次运行都会重新读那个文件。留空 = 按中性说话（不扮演任何人）。',
            value: persona ?? '', onChange: (e) => setPersona(e.target.value),
          }),
          // ⭐ 2.0.5（issue #89）：把人设字数亮出来 —— 超 40000 只送前 40000、超 60000 保存就截，得让用户自己看得见
          h('div', { 'data-bd-note': '' },
            '字数：' + String(persona ?? '').length
            + (String(persona ?? '').length > 40000 ? '（⚠️ 超过 40000，超出的部分不会生效）' : '')
            + (String(persona ?? '').length > 60000 ? '（⚠️ 超过 60000，保存时会被截断）' : '')),
          h('div', { 'data-bd-note': '' },
            (st.personaFromWs && String(persona || '').trim() === '')
              ? '你现在还是用「工作区」里那份 AGENTS.md 说话的（照旧生效）。想把它搬到这儿改，就把上面的路径填成本机那个目录。'
              : '改完点下面「保存」；下一轮就按这个说话。'),
          h('div', { 'data-bd-label': '' }, '日报写多细'),
          h('select', {
            'data-bd-input': '', value: rl ?? 'full',
            onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '日报形态') },
          },
            h('option', { value: 'full' }, '完整 —— 每条：标题 / UP / 为什么值得（默认）'),
            h('option', { value: 'brief' }, '薄 —— 每条一两行，只留值不值得 + 链接'),
            h('option', { value: 'off' }, '不写 —— 只发评论，不生成日报文件')),
        h('div', { 'data-bd-label': '' }, '自动收藏到（这一轮挑中的视频存进你的收藏夹）'),
        h('select', {
          'data-bd-input': '', value: favId ?? '0',
          onChange: (e) => { setFavId(e.target.value); patch({ favFolderId: Math.max(0, Number(e.target.value) || 0) }, '自动收藏') },
        },
          h('option', { value: '0' }, '不收藏（默认）'),
          (favFolders || []).map((f) => h('option', { key: String(f.id), value: String(f.id) }, `${f.title}（${f.count} 条）`))),
        h('div', { 'data-bd-row': '' },
          h('button', { 'data-bd-btn': '', disabled: busy === 'fav', onClick: onFavToday }, '补收藏今天的'),
          h('div', { 'data-bd-note': '' },
            favFolders === null ? '收藏夹列表读取中…'
              : (favFolders.length ? '每轮跑完会把挑中的视频存进上面选的收藏夹'
                : '读不到收藏夹 —— 先「扫码登录」，或过会儿重开设置页'))),

          h('div', { 'data-bd-row': '' },
            msg ? h('div', { 'data-bd-msg': '', 'data-good': msgTone === 'good' ? '' : undefined, 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null)),

        /* ── 环境与账号 ── */
        /* ── 它刷过的视频 ── */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'daily', 'data-bd-away': tab === 'daily' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '它刷过的视频'),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'watched', onClick: () => (watchedRows !== null ? setWatchedRows(null) : onLoadWatched(watchedState, watchedTier, watchedOffset)) },
              watchedRows !== null ? '收起' : '看它刷过什么'),
            h('div', { 'data-bd-note': '' },
              watchedRows === null ? '（点一下读出来；数据来自判重表 seen.md + 报告里的档位）'
                : (watchedTotal ? `共 ${watchedTotal} 条` : '这一类还没有记录 —— 跑一轮之后就有了'))),
          watchedRows !== null ? h('div', { 'data-bd-row': '' },
            [['', '全部'], ['picked', '挑了'], ['skipped', '跳过'], ['commented', '发给你了']].map(([v, label]) =>
              h('button', { key: v || 'all', 'data-bd-chip': '', 'aria-selected': watchedState === v ? 'true' : 'false', onClick: () => onWatchPick('state', v) }, label)),
            ['值得看', '可以看', '不值当'].map((v) =>
              h('button', { key: v, 'data-bd-chip': '', 'aria-selected': watchedTier === v ? 'true' : 'false', onClick: () => onWatchPick('tier', v) }, v))) : null,
          watchedRows !== null && watchedRows.length ? h('div', { 'data-bd-list': '' },
            watchedRows.map((x, i) => h('div', { key: x.day + x.bvid, 'data-bd-item': '' },
              // 封面走宿主代理（直连 i0.hdslb.com 会被防盗链挡，也等于把使用者 IP 交出去）
              i < 40 ? h('img', { 'data-bd-cover': '', src: API + '/cover?bv=' + x.bvid, loading: 'lazy', alt: '' }) : null,
              h('div', { 'data-bd-item-body': '' },
                h('div', { 'data-bd-item-t': '' },
                  h('a', { href: x.url, target: '_blank', rel: 'noreferrer' }, x.title)),
                h('div', { 'data-bd-item-n': '' },
                  `${x.day} · ${x.up} · `, x.picked ? '挑中了' : '跳过', (x.delivered || x.commented) ? ' · 已发给你' : '',
                  x.tier ? h('span', { 'data-bd-tier': x.tier }, ' · ' + x.tier) : null),
                x.why ? h('div', { 'data-bd-item-why': '' }, x.why) : null))))
            : null,
          watchedRows !== null && watchedTotal > WATCH_PAGE ? h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: watchedOffset <= 0, onClick: () => onWatchPage(-WATCH_PAGE) }, '上一页'),
            h('div', { 'data-bd-note': '' }, `${watchedOffset + 1}–${Math.min(watchedOffset + WATCH_PAGE, watchedTotal)} / ${watchedTotal}`),
            h('button', { 'data-bd-btn': '', disabled: watchedOffset + WATCH_PAGE >= watchedTotal, onClick: () => onWatchPage(WATCH_PAGE) }, '下一页')) : null),

        h('div', { 'data-bd-sec': '', 'data-bd-group': 'adv', 'data-bd-away': tab === 'adv' ? undefined : '' },
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'diag', onClick: onDiagnose }, '复制诊断信息'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'selfcheck', onClick: onSelfCheck }, '环境自检'),
            h('div', { 'data-bd-note': '' }, '出问题时先点这两个：第一个把环境+日志拼成一段（已自动复制），第二个逐项告诉你哪一步不通。')),
          checks && checks.length ? h('div', { 'data-bd-list': '', 'data-bd-checks': '' },
            checks.map((x) => h('div', { key: x.name, 'data-bd-item': '', 'data-bd-item-t': '' },
              h('div', { 'data-bd-item-t': '' }, (x.ok ? '正常 · ' : '有问题 · ') + x.name),
              h('div', { 'data-bd-item-n': '' }, x.detail || ''),
              x.ok ? null : h('div', { 'data-bd-item-why': '' }, '怎么办：' + (x.fix || '把诊断信息发给作者'))))) : null,
          diag ? h('pre', { 'data-bd-pre': '' }, diag) : null,
          h('div', { 'data-bd-h': '' }, '环境与账号'),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'install', onClick: onInstall },
              st.venvReady ? '重装主依赖' : '装主依赖（建 venv）'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'check', onClick: onCheck }, '测一下'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'update', onClick: onCheckUpdate }, '检查更新'),
            newVer ? h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'upgrade', onClick: onUpgrade }, '一键升级到 v' + newVer) : null,
            h('button', { 'data-bd-btn': '', disabled: busy === 'login', onClick: onLoginStart }, '扫码登录'),
            h('div', { 'data-bd-note': '' },
              !st.venvReady ? (st.installFailed ? '上次没装成 → 看下面日志' : '还没装 → 先点「装主依赖」')
                : (st.loggedIn ? '装好了 → 下一步「扫码登录」' : '环境好了 → 点「扫码登录」'))),
          loginState ? h('div', { 'data-bd-msg': '', 'data-good': loginTone === 'good' ? '' : undefined, 'data-warn': loginTone === 'warn' ? '' : undefined }, loginState) : null,
          st.installTail ? h('div', null,
            h('div', { 'data-bd-note': '' }, st.installing ? '正在装主依赖（进度）：' : '主依赖的日志（B站 搜索 / 字幕 / 评论 用得到，末尾）：'),
            h('pre', { 'data-bd-pre': '' }, st.installTail)) : null,
          login?.qr ? h('div', { 'data-bd-qr': '' },
            h('img', { src: login.qr, alt: 'B站登录二维码' }),
            h('div', { 'data-bd-note': '' },
              '手机 B站 → 我的 → 扫一扫。',
              h('br'),
              '确认时选「记住我 / 长期」那张 —— 选 24 小时的话，明天就得重扫。')) : null),
          (Array.isArray(st.missingDeps) && st.missingDeps.length)
            ? h('div', { 'data-bd-note': '' }, '还缺这几项：' + st.missingDeps.join(' / ') + '（qrcode = 画登录二维码用的）—— 点一次「重装主依赖」就会补上')
            : null,

        /* ── 它是怎么干活的（给他看的） ── */
        h('div', { 'data-bd-sec': '', 'data-bd-group': 'adv', 'data-bd-away': tab === 'adv' ? undefined : '' },
          h('div', { 'data-bd-h': '' }, '它的地盘'),
          h('div', { 'data-bd-kv': '' },
            `家目录：${st.home}`,
            h('br'),
            `今天的报告：${st.report}`),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport },
              report !== null ? '收起报告' : '看今天的报告'),
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('out') }, '打开报告文件夹'),
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开家目录'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'verify', onClick: onVerify },
              '复核评论'),
            h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')),
          report !== null ? h('pre', { 'data-bd-pre': '' }, report) : null),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-scroll: 设置页样式')

        // ⭐ 2026-10-25：窗口回到前台就重查「这个会话在哪个工作区」——
        //    用户在设置里改了工作区后，不用刷新整页，切回来一会儿 tab 就跟着挪。
        const bumpOnFocus = () => { try { bumpScope() } catch { /* 忽略 */ } }
        const bumpOnVisible = () => { if (!document.hidden) bumpOnFocus() }
        window.addEventListener('focus', bumpOnFocus)
        document.addEventListener('visibilitychange', bumpOnVisible)
        ctx.effect(() => () => {
          window.removeEventListener('focus', bumpOnFocus)
          document.removeEventListener('visibilitychange', bumpOnVisible)
        }, 'dsh-bili-scroll: 工作区缓存失效')

        // ⭐ 进「设置」：label 就是左侧导航里那一项（抄 dsh-meme 的写法）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-scroll', order: 30, label: '刷B站' },
          () => h(Panel),
        ))

  // ⭐⭐ 2026-10-23（本人反馈：这个 tab 在**每个**会话的头上都出现，应该只在工作区出现）：
  //    `conversation.view` 是个 list 槽，壳子（ui-conversation 的 viewTabs()）对**每个注册项都画一个 tab**，
  //    唯一的过滤是"开发者工具没开就不显示内置的 trajectory" —— **没有"按会话隐藏"的开关**。
  //    ⇒ 只能**按当前会话动态注册/撤销**：
  //      · 往 composer 左边栏（`conversation.input.left`，每个会话都渲染的 list 槽）塞一个**隐藏探针**，
  //        它拿得到 `sessionId`；
  //      · 探针问宿主 `GET /api/bili-duty/session-scope?session=…` —— 宿主查 workspaceRegistry，
  //        回答这个会话是不是在「刷B站 设置里的 workspace」（默认 D:/hajimi）那个工作区里；
  //      · 是 ⇒ 注册「刷过的视频」；不是 ⇒ 立刻撤销（tab 跟着消失）。
  //    这样：hajimi 工作区里的会话有 tab，别的会话（比如 default-workspace）没有。
  try {
    let viewOff = null
    let viewSlotReady = false
    const dropView = () => {
      if (!viewOff) return
      try { viewOff() } catch { /* 已经撤过了 */ }
      viewOff = null
    }
    const ensureView = () => {
      if (viewOff || !viewSlotReady) return
      try {
        viewOff = slots.register({
          name: 'conversation.view',
          id: 'bili-watched',
          order: 20,
          label: '刷过的视频',
          scope: 'session',
        }, () => h(WatchTab))
      } catch (e) { viewOff = null }
    }
    // 槽位就绪之前 register 会被拒；inject 的回调就是"槽位已经在了"的信号
    let lastInScope = false
    slots.inject('conversation.view', () => {
      viewSlotReady = true
      if (lastInScope) ensureView()   // 探针比槽位先跑完的情况：补一次
      return () => { viewSlotReady = false; dropView() }
    })
    const ScopeProbe = ({ sessionId }) => {
      const [nonce, setNonce] = React.useState(0)
      // 订阅 bumpScope：设置变了 / 窗口回到前台 / 15 秒兜底轮询 ⇒ 重查一次
      React.useEffect(() => {
        const fn = () => setNonce((n) => n + 1)
        scopeSubs.add(fn)
        return () => { scopeSubs.delete(fn) }
      }, [])
      React.useEffect(() => {
        const t = setInterval(() => bumpScope(), 15_000)
        t.unref?.()
        return () => clearInterval(t)
      }, [])
      React.useEffect(() => {
        const sid = String(sessionId || '')
        // 拿不到 sessionId（槽位没给 / 老版本）：退回老行为 —— 照常显示，别把 tab 弄没了
        if (!sid) { lastInScope = true; ensureView(); return () => {} }
        const hit = scopeCache.get(sid)
        if (hit && Date.now() - hit.at < SCOPE_TTL) {
          if (hit.v) { lastInScope = true; ensureView() } else dropView()
          return () => {}
        }
        // 没缓存 / 缓存过期：先收起来（宁可晚一帧出现，也别让 tab 在别的会话上闪），再问宿主
        dropView()
        let alive = true
        jget('/session-scope?session=' + encodeURIComponent(sid))
          .then((r) => {
            if (!alive) return
            // 老宿主没有这个接口（r.ok 不是 true）⇒ 退回老行为，别静默把 tab 藏掉
            if (!r || r.ok !== true) { lastInScope = true; scopeCache.set(sid, { v: true, at: Date.now() }); ensureView(); return }
            const inScope = Boolean(r.match)
            lastInScope = inScope
            scopeCache.set(sid, { v: inScope, at: Date.now() })
            if (inScope) ensureView(); else dropView()
          })
          .catch(() => { if (alive) { lastInScope = true; scopeCache.set(sid, { v: true, at: Date.now() }); ensureView() } })
        return () => { alive = false }
      }, [sessionId, nonce])
      // 探针被卸载（切到没有会话的首页 / 别的面板）⇒ 把 tab 收起来
      React.useEffect(() => () => { dropView() }, [])
      return h('span', { 'data-bd-probe': '', style: { display: 'none' } })
    }
    slots.inject('conversation.input.left', () => slots.register({
      name: 'conversation.input.left',
      id: 'bili-scope',
      order: 5,
    }, (props) => h(ScopeProbe, props || {})))
  } catch (e) { /* 没有这些槽位就算了 */ }
      },
    }
  },
})

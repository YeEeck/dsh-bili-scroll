# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-bili-scroll`（中文名「**刷B站**」）：每天替用户刷一轮 B 站 —— 搜、**读字幕原文**判断、写一份日报，特别值得的会发一条评论 **@ 用户**。

## 帮用户安装时，按这个顺序

1. **前提**：机器上有 `Python 3.10+` **或** `uv`（有一个即可）。
   两个都没有**也不用让用户先装** —— 插件点「装依赖」时会**自己下一份 `uv` 到自己的家目录**（免管理员、不用 PATH）；
   只有它自己也下不动时（网络到不了 GitHub / 加速代理 / PyPI 镜像），才需要引导用户手动装。
   · 它是**直连 GitHub → 国内加速代理 → PyPI 镜像**依次试的，并且会**核对官方 sha256** ✓
   · ⚠️ 若用户机器上的**杀软拦了这次下载**：让他把 `%USERPROFILE%\.dsh\bili-duty\bin\` 加白，或干脆自己装 uv / Python 3.10+ ✓
   · ⭐ **万一下载链路都不通**（有用户反馈"桌面版上这条链路经常不通"）：**手动放一份 `uv.exe` 到 `<家目录>\bin\` 就行**
   —— 插件会**用那一份、跳过下载** ✓（他 `PATH` 里本来就有 `uv` 的话，直接用那个 ✓）
2. `dsh plugin --profile web add dsh-bili-scroll`（npm，推荐）
   · 备选：`dsh plugin --profile web add github:c1overzz/dsh-bili-scroll`
   · ⚠️ **升级旧版**：如果用户在设置页看到的按钮叫「**重装依赖**」（不是「**重装主依赖**」），
   说明装的还是 **0.1.0** —— 那一版建 Python 环境时缺一个参数，**依赖装不上、二维码也画不出来**。
   让用户重跑一次上面那条 `add` 就是升级（然后再重启一次）。
3. ⚠️ **提醒用户重启一次 dsh**（必须，bundle 层要重启才组装）。
4. 让用户进 **设置 → 刷B站**：点「**装主依赖**」→ 点「**扫码登录**」（手机扫码，选"记住我 / 长期"）。
   · 装完可以用设置页的「**测一下**」自检：它真跑一次登录检查 + 一次搜索，直接回答"能不能用"。
5. **别擅自打开「自动评论并 @ 你」** —— 那是拿用户的号说话；要用得让用户自己填「要 @ 谁」。

## 仓库结构（改代码时看这里）

- `index.js` —— host 半端：13 个工具 + 谷时定时器 + HTTP 接口 + 配置（`config.json` 与 DSH 原生设置页**逐字段对账**：见 `loadCfg` / `saveCfgHost`）+ 值班轮的工具白名单（`mcpWhitelist` → `BILI_MCP_TOOLS`）
- `client.js` —— 浏览器半端：设置页（注册在 `settings.section`）
- `lib/` —— 状态目录与家目录 / 极小的 MCP stdio 客户端 / 扫码登录 / **`hostdeps.mjs`（从宿主树取 `@deepseek-ai/*`，拿不到就退到自己依赖 / 本地等价实现）** / **`verify.mjs`（评论发出后复核）**
- `prompts/duty.md` —— 一轮要做的事（判定口径 + 红线，**用户可以改**）；升级规矩见 `lib/state.mjs` 的 `ensureCharter`（用户改过 ⇒ 保留他那份、新版落 `duty.md.new`）
- `vendor/bilibili-mcp/` —— 内置的 Python MCP（MIT，AGI_Ananas）
- `selfcheck.mjs` + `tools/` —— 本地预检：`node selfcheck.mjs`（**现在不用解析钩子了**；`tools/register.mjs` 那条还留着当备份）
  · `tools/check-vision.py` —— 看图纯函数的回归检查（不联网）。动了 `_https` / `_cover_url` / `_snapshot_entries` / `_crop_tile` 就跑一次：
  `<家目录>/.venv/Scripts/python.exe tools/check-vision.py`（用插件自己的 venv，里面才有 Pillow）

## 约定

- 配置与运行数据都在用户的 `$DSH_HOME/bili-duty/`，**不写进插件包目录**
- 谷时窗口按 DeepSeek 官方口径：工作日 9–12 / 14–18 是高峰，其余（含周末）都是谷时

## Agent skills

### Issue tracker

issue 与 spec 以本地 markdown 记在 `.scratch/<feature>/` 下；GitHub 远端（origin fork / upstream）**不是** issue tracker。详见 `docs/agents/issue-tracker.md`。

### Triage labels

用默认五种 triage 角色（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`），写在 issue 文件的 `Status:` 行。详见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：仓库根一份 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。

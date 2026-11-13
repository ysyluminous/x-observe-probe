# art-032 · 侧边栏精简 + 全页工作台 dashboard.html + 数据源二选一（v0.12.13）

## 用户裁定（2026-11-12，三张决策卡的拍板）
- **决策一**：数据源做成**设置二选一**——本地库（SW→宿主读 xprobe.db）或 Go 接口（同协议只读）。
- **决策二**：选 1——延续「工程仪表台」暗色 token，布局结构抄「不是兄弟」dashboard（stats-strip / 右栏 / tone 卡 / tab 分区），配色不换。
- **决策三**：选 1 变体——诊断也搬进工作台；侧边栏只留最常用精简（放右侧）；页签**吸底**；「打开工作台」入口要清晰。

## 参考（不是兄弟 v0.6.1 dashboard 拆解）
Chrome 扩展 `dioanbgbpklflgochbljdehpjidckgfd`（Not Brother — Relationship Fieldbook）。照抄的是**结构**不是配色：
两栏骨架（主区 + 250~380px 右栏）、顶部 stats-strip 四枚 mini-stat（tabular-nums）、记录卡 tone 变体（同一种「色点+胶囊」语言）、工具行只有搜索/排序/导出三样、tab 分区互不塞。

## 侧边栏丑的三个根因（分析结论）
1. 6 个视图挤 ~320px 窄栏——广场榜单/预测折线/日线网格在窄栏展不开，只能堆字；
2. 设置页混装高频与低频操作；
3. 单栏流水无层级（没有 stats 条、没有卡片区隔）。

## 改法（只动扩展侧）

### 新增 `ui/dashboard.html` + `ui/dashboard.css` + `ui/dashboard.js`（全页工作台）
- **页签**：概览（KPI 条 + homeLines + 最该关注/取关建议）/ 我的（工具条 + 日点表 + 日报摘要）/ 广场（两张榜 + 时间线卡 + 看谁）/ 预测（粉丝外推）/ 诊断（debugLines + 查表三键）。
- **KPI 条**：未回关（follow_starts，follow_back=no 口径；unknown 是「没读到」不算）/ 榜上账号 / 运行态序列点（state.counts）/ 今日关注进度（V.goalBar，与面板首页同一本账）。没数写 `—`（RL-11），口径写在悬浮与脚注。
- **数据源二选一（决策一）**：头部 seg（本地库 / Go 接口），存 `ysy.xprobe.dashSrc` / `ysy.xprobe.dashGo`。本地库走 `chrome.runtime` → SW `dbq` → 宿主（42 条白名单查询零新增 SQL）；Go 接口 `GET {base}/db?q=&limit=`，回包 `{ok, rows}` 与本机 sink 同形状。**Go 地址只认 `http://127.0.0.1:端口` / `http://localhost:端口`**（与本机模型同一道规矩；RL-2：出本机只有回环与自家域名，公网要单独立项）。切源清缓存重读，不把上一源的旧账当新源的真相。
- **复用**：view.js 直接 include（行对象契约 k:line/row/chart/imps/rank/grid/hero/bar/fold 与面板同一份）；节点渲染器从 sidepanel.js 复制（digestBox 含 digestEl 复用/评论数按天记/剪贴板两段式，三个助手一并复制）。
- 节奏：state 5 秒一拍、库 30 秒一拍（面板 900ms 是窄栏高频操作需要；全页看数不用那么急），`document.hidden` 都不发。
- 图表：viewBox 360×118 等比放大（CSS max-width 640px ≈1.7×，保文字可读）。

### `ui/sidepanel.html/js/css` 精简（决策三）
- 页签只剩 **首页/未回关/设置 + 工作台 ↗**（`chrome.tabs.create` 开自家页，不用 window.open、manifest 不加条目）；`#viewPick` **position:fixed 吸底**（发丝线 + 毛玻璃，body padding-bottom 防盖）。
- 搬走：vMine/vPlaza/vFc/vDebug 钮、whoPick/bRestore/bDbRefresh（barTrend 只剩 抓一个点+显示全部）、barDebug（查表/测活/刷新计数）、qKeep/doQuery。
- 保留：渲染层全量不动（rankNode/gridNode/impsNode/chartNode 等留作共用层；home/follow 仍用其中 chartNode/heroNode/barNode/foldNode）；vSet 处理器一字未改；`syncWho`/`show()` 对缺失 id 免疫。
- 诊断模式开关留在设置（只翻开关；开完提示去工作台看）。

### 版本戳
`manifest 0.12.13`、`core VER/BUILD 0.12.13/2026-11-12-j`、`sidepanel PANEL_BUILD 2026-11-12-j`、**新增 `dashboard DASH_BUILD 2026-11-12-j`**（RL-8 从四处一致扩成五处一致）。

## 红线
- RL-2：dashboard 整页零 x.com 出口——唯一 fetch 在 goq，只打回环 `/db`；判据钉死（fetch 计数=1 + 无 x.com URL 字面量）。
- RL-3：manifest 没加任何权限/条目（dashboard 靠 `chrome.runtime.getURL` + tabs.create 打开）。
- RL-11：KPI/空态没数写 `—`；goq 失败返回 err+空 rows；unknown 不算进未回关。
- RL-1/RL-12/[11x]：core.js 只动版本戳两行，判定逻辑一字未改。
- MV3 CSP：dashboard 无远程脚本、无 CDN（图表全自绘 SVG，与 view.js 同一套）。

## 验证
`probe-selftest.js` **1851/0**（约 13 条搬家锚点改写为工作台口径 + 新增 `[42]` 6 条：五处版本戳 / Go 回环白名单 / goq 唯一 fetch 零 x.com / storage 两键切源清缓存 / RL-11 空态 / bWorkbench 接线）；`db-selftest.py 232/0`；`exe-check.py 45/0`；`node -c` 全过；改动文件 CRLF 保持。备份 `%TEMP%/xprobe-bak-20261112-dash/`（sidepanel 三件；dashboard 为全新文件）。只改扩展侧 ⇒ 无需重打 exe。

## 有意没做
- Go 接口的真实服务与 API 形状：协议已定（同 sink `/db` 只读），没有服务时 Go 档如实报「没连上」，不造假数据。
- 渲染层「复制」的重构：dashboard.js 与 sidepanel.js 各有一份节点渲染器（约 600 行重复）——守「不动存量」没有抽公共 kit.js（抽了会连带十几条源码锚点改写），列此待定。
- 侧边栏设置页进一步瘦身：v0.9.8 的 ❓ 折叠机制已把长文收好，本轮不动。

## 真机走查待用户
重载扩展（manifest 0.12.13）+ 刷新 x.com 页；侧边栏页签吸底、只剩首页/未回关/设置 + 右下「工作台 ↗」；点开工作台：KPI 条四格有口径、页签五枚；我的页签日点表/编辑窗/日报复制照旧能用；广场两张榜 + 看谁换人 + 作者模态；预测折线放大可读；诊断查表/测活/刷新计数；数据源切到「Go 接口」填公网地址被拒、填 `http://127.0.0.1:8080` 后没服务时明说「没连上」不画假数；切回本地库一切恢复。

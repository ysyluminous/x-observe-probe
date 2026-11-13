# art-033 · 抽取 UI 公共渲染层 kit.js（v0.12.14）

## 用户诉求
「需要抽取公共 js，确保高内聚低耦合」——收敛 art-032 遗留的 ~600 行渲染器复制（sidepanel.js ↔ dashboard.js 各一份）。

## 设计：`ui/kit.js` + `XPROBE_KIT.create(deps)` 工厂

**高内聚**（这一层只管一件事：「行对象 → DOM 节点」怎么画）：
- `tick` 分发 + 九种节点渲染器（line/row/bar/hero/chart/imps/rank/grid/fold）+ `appendSafe` 单条兜底；
- 榜/表排序分页状态（rankSortBy/acctSort/tlDay/各 limit…，闭包变量，防 render 重建树刷掉）；
- tlUser 作者模态框（openTlUser/closeTlUser/tlUserModalNode，状态在 kit）；
- 摘要框家族（digestBox + digestEl 节点复用 + 评论数按天记 + copyText 剪贴板两段式）；
- **chrome.runtime 发送通道**（send，孤儿话术按 `pageLabel` 参数化——面板「关掉重开面板」、工作台「关掉重开工作台」）。

**低耦合**（页面差异全部注入，kit 不认识 view.js、不认识任何页面）：
```js
const K = globalThis.XPROBE_KIT.create({
  pageLabel: '面板' | '工作台',   // 孤儿话术里的自我称呼
  render,                          // 重画回调（kit 控件改状态后调）
  fetchDb,                         // 时间线选天重查（仅工作台注入）
  one,                             // 查询通道：工作台 = 数据源二选一包装；面板 = null（作者模态自然不可达）
  getSt,                           // 日报文本要读 state
});
```
view.js 的格式化函数只在调用时经 `globalThis.XPROBE_VIEW` 取——kit 对格式化层零依赖。分工一句话：**core 管判定，view 管「行对象长什么样」，kit 管「怎么画」，页面脚本管「画到哪、谁来点」**。

## 面板侧改动（sidepanel.js 2038 → 1522 行）
- 删：send/tick/九种渲染器/tlUser 模态/摘要家族/排序分页变量/syncWho/whoSel；
- 留：cmd、视图分发（home/follow/set）、fetchDb、设置页全套、B 表、syncButtons；
- `K.appendSafe/K.lineNode/K.rowNode/K.copyText/K.send` 替换调用点；
- **fetchDb 精简**：面板只剩未回关页要 follow_starts，删掉 accounts/posts_top/posts_growth/tl_days/tl_rank 五条陪跑查询（每次采集少起 5 个宿主进程）；
- 顺手消解历史暗病：面板有两个同名 `foldNode`（465 行 k:'fold' 版 / 1229 行设置 ❓ 版），声明提升后后者一直覆盖前者——抽取后 kit 的 foldNode 与面板的 settings foldNode 各归各作用域，不再互踩。

## 工作台侧改动（dashboard.js 868 → 434 行）
- 同样删复制改 K.*；`fetchDb` 的 tlDay 改走 `K.sorts()`（读）/ `K.setTlDay()`（写，kit 状态单点写入口）；
- 广场 opts：`V.plazaLines(st, Object.assign({now, db}, K.sorts()))`；
- 补 UIX-19：Esc 关作者模态框（`K.tlUserActive() → K.closeTlUser()`），搬进工作台后「×/遮罩/Esc 三条关法齐」仍成立。

## 判据同步（非放宽，约 19 条）
渲染器类判据全部改咬 `kitClean`（rd('ui/kit.js') 去注释）：impsNode 网格块（gridBlock）、openEditorWindow 恰两处、dayDisp 短格式、chartBoxOk ≥0 夹紧、appendSafe 单条兜底、排名三层、榜分页三处、时间线三层（core 保留 + dSrc 的 tl_rank/tl_days + kit 的卡片/模态）、摘要三处、日报三处、UIX-18、旧副本话术、SVG 名空间扫描纳入 kit。新增 kit 双页接线判据；[42] 版本戳五处一致扩成**六处一致**（新增 KIT_BUILD）。

## 踩坑记录（给下一轮）
1. kit 内层函数缩进 4 空格，「下一个 function」锚必须 `'\n    function '`（2 空格版会一路切到文件尾，gridBlock 多吞 rankNode）；
2. python 手术的 `str.replace` 不带断言会静默 no-op——tl_rank 那处空跑一轮才发现；一律 assert count==1；
3. 提升同名函数互相覆盖是 JS 的暗坑，两个文件里同名 helper 抽公共层时先 grep 重名。

## 红线
只改扩展侧 ⇒ RL-12 无需重打 exe；core.js 只动版本戳两行；RL-2（kit 无 fetch、无出口）；RL-11（渲染器缺数画 — 逻辑原样随迁）；MV3 CSP（kit 无远程脚本）。

## 验证
`probe-selftest.js` **1852/0**；`db-selftest.py 232/0`；`exe-check.py 45/0`；`node -c` 全过；六处版本戳一致（manifest 0.12.14 / core VER,BUILD / PANEL / DASH / KIT_BUILD = 2026-11-12-k）；改动文件 CRLF 保持。备份 `%TEMP%/xprobe-bak-20261112-kit/`（抽取前 sidepanel.js / dashboard.js 快照）。

## 真机走查待用户
重载 0.12.14 后全量回归：面板（首页四列卡/进度条端标/未回关表/设置弹窗复制）与工作台（两榜列头排序/「更多」分页/时间线卡片/作者模态 ×-遮罩-Esc/编辑窗双模式/日报复制/评论数按天记）——渲染层换了文件，行为应一字不差。

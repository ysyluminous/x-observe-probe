# art-023 帖子详情页页头流量徽标 + 悬停详情卡

版本：v0.12.3 / BUILD `2026-11-11-c`
日期：2026-11-11
需求原话：「帖子详情页面 标题 右上方也需要添加一个悬浮div,显示流量状态，悬浮上去 可以显示详情」
参照截图：`https://x.com/ZX2023225/status/2120357195456053702` 页头「帖子 ☆标此帖」一行 + 弹出卡
（浏览量 5,168 / 点赞 144 / 转发 0 / 回复 232 / 收藏 5 / 流速 1.1k/h / 爆炸指数 21/100 / 发布时间 2026:11:11 11:25:24）

## 做了什么

**页头徽标（`hotDetStep`，content/core.js ~7462 起的 art-023 段）**

- 只在帖子详情页出现：定位完全沿用 `benchPostRow` 的实锤路径（`tabName()==='tweet'` + `statusIdFromPath`
  + `[data-testid="app-bar-back"]` 往上爬到含 `h2` 的那一层），绝不拿 document 的 h2 冒充。
- 芯是 `h2` 的**下一个兄弟**（`insertAdjacentElement('afterend')`），不进任何 X 节点内部 ——
  兄弟插入不动 X 布局，与 art-022 关系芯同一套防抖纪律：
  - 认领靠 `HOTDET_CLS='ysy-xprobe-hotdet'` + `data-k`（tid|label 指纹）；
  - 没变且位置对 ⇒ 一笔 DOM 都不写（自检钉了「0 次 createElement」）；
  - 数值变了原地改 `textContent`、不换节点；位置被 React 挪了才搬回去。
- 数值 = `hotParseArticle` 读本页第一条 article（口径同 art-020 本页热点，RL-28）。
  解析不出（缺浏览量/时间、推广帖）就诚实挂 `🌱 —`，不编数。

**悬停详情卡（`hotDetPopShow/hotDetPopOpen/hotDetPopHide`）**

- 悬停芯出 fixed 浮层卡（挂 `documentElement`，id `HOTDETPOP_ID`），八行：
  浏览量 / 点赞 / 转发 / 回复 / 收藏 / 流速 / 爆炸指数（=hotScore `n/100`）/ 发布时间（`Y:M:D H:M:S`，照截图口径）。
- 定位：`geoRect(芯)` 右对齐、卡顶 = 芯底 + 6px；量不到时回落视口右上。
- 收卡走 200ms 延迟：离开芯不立刻收，中途挪进卡片会取消（clearTimeout），给鼠标留出移过去的路；
  到期整棵摘净、账清零。SPA 切走详情页（`benchPostRow` 返回 null）时也主动收卡，不吊在半空。
- 每次悬停**现读现算**（mouseenter 里重新 `hotDetData()`），卡内容带指纹（tid+各行值），没变不重写。

**闸门与联动**

- 与推文内流速徽标同一道总闸 `HOT_BADGE_KEY`（默认关，RL-16）：`setHotBadge(true/false)` 与节拍里的
  `hotBadgeAuto()` 都同时带上 `hotDetStep()` / `hotDetSweep()`，关闸芯与卡当场摘净。
- 红线：芯与卡都是自家节点，监听只挂自己身上；全文无 dispatchEvent / preventDefault / stopPropagation
  调用（自检按调用形态 `xxx(` 静态钉，注释里讲红线的字样不算）。

## 自检

`node probe-selftest.js` → **合计 1749 通过 / 0 失败**（其中 [art-023] 新增 20 条）：

总闸默认关 / 页头定位（previousElementSibling=h2）/ 数值口径（5168·144·0·232·5 → 🚀 5.2k/h trending）/
卡定位（geoRect 右对齐锚点）/ 卡八行数值与截图一致 / 200ms 宽限与进卡取消 / 到期摘净 /
没变 0 写 / 变了原地改字 / skip 兜底八行全是 — / 关闸摘净 / 非详情页不出 / 接线源码钉死 / 版本戳四处一致。

版本戳四处同步：manifest `0.12.3`、core `VER='0.12.3'`、core `BUILD='2026-11-11-c'`、sidepanel `PANEL_BUILD='2026-11-11-c'`。

## 没做什么（有意）

- 弹卡样式没抄截图里那家的皮肤，用的是本项目 `UI_TOK` 玻璃面板同款（与榜单卡片一致）；
- 「爆炸指数」就是 art-020 的 hotScore，没有新公式；
- 芯没有做拖动/常驻开关——它跟推文内流速徽标共用一道闸，要关一起关。

## 真机走查（待用户）

1. Chrome 加载解包后的 `extension/`，右缘「观」面板开「热点徽标」闸；
2. 打开任一帖子详情页：页头「帖子」标题右侧应出现 `🚀/🔥/🌱 x.xk/h` 小胶囊；
3. 悬停出八行详情卡、鼠标挪进卡不消失、挪开约 0.2s 收起；
4. 切回首页等列表页：芯消失、卡不残留；关闸后全部摘净。

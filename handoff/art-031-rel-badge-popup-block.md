# art-031 · 长昵称不再挤掉互关：拉黑钮/百分比全进悬浮弹窗 + 状态恒显示 + 手机关注补关注时间（v0.12.12）

## 用户原话
「现在有两个问题，一个是有些人名称比较长的时候，会把我的互关给搞没掉，帮我解决这个问题，感觉拉黑按钮可以放在互关状态表示悬浮窗里面，然后这个状态不管什么状态 单向 双向 还是空白 都要显示，空白就显示空白 方便悬浮显示弹窗能拉黑；另外就是现在如果是手机关注，应该初始化一下 也就是每次加载到就默认把未知的关注时间更新为当时的时间，从那个时候开始算起未回关天数。」

## 症结
v0.12.10 旧行内徽标 = 「拉黑钮 + 关系标签 +（判不出时）百分比标签」，整颗要 ~100px。长昵称把名字行右缘空白缝挤到不足预算时，徽标整体降档/消失 ⇒ 互关标签没了、拉黑钮也没了（没节点就 hover 不出弹窗）。另一个方向是自检沙箱里出现「盒内两枚相同 rel 标签」的真 bug（见下）。

## 改法（只动 `extension/content/core.js` + 版本戳）
1. **徽标重设计（`badgePaint` 重写）**：行内徽标只承载「关系状态」单件——互关 / 我单向 / 他单向显示文字标签，判不出显示**空白占位**（`STATUS_PH_W = 16`）。状态恒有节点 ⇒ 悬浮弹窗恒能弹出 ⇒ 拉黑恒可达。行内拉黑钮与关注百分比全部撤出徽标，搬进悬浮弹窗（`relBadgePopShow` / `relBadgeRows`，「拉黑 @h / 取消拉黑 @h」钮与「关注百分比」行只在弹窗里）。
2. **修真 bug「盒内两枚相同 rel 标签」**：自检沙箱 `El` 类没有 `firstChild`/`removeChild`，原 `while (n.firstChild) n.removeChild(...)` 清场在沙箱恒为假 ⇒ `setBadgeOn` 自动渲染与 `renderBlocks(true)` 复用重画时旧标签清不掉、append 成两枚。改用 `n.children` + `_kids[i].remove()` 清场，真 DOM 与沙箱都通。
3. **[11x] 红线修复**：弹窗拉黑钮原先带 `e.stopPropagation(); e.preventDefault();`，被「全文无 preventDefault/stopPropagation（不拦点击）」静态断言拦下。移除——弹窗是自家 `position:fixed` 节点、不在任何 `<a>` 里，点击不会触发导航，无需拦。
4. **v0.8.14「旧数」特性迁进弹窗**：`relBadgeRows` 百分比行尾追加「· N 天前读到」（`ratioInfo.stale` / `ageDays`）。
5. **手机关注补关注时间**：新增 `ensureFollowSeed(h)`——每次加载到该人时，本机台账没有关注时间（手机上关注的、电脑没记）就把**当时时间**写进台账（`scheduleStoreWrite` 落库），未回关天数从那一刻起算。
6. **删除临时调试桩**（`badgePaint` 开头 `console.error('BADGEPAINT'...)`）。
7. 版本戳四处 `0.12.12 / 2026-11-12-i`（manifest / core VER+BUILD / sidepanel PANEL_BUILD）。

## 判据同步（`probe-selftest.js`，保留正确设计、重写旧断言，非放宽）
旧设计（行内拉黑钮 + 行内百分比）失效的存量断言整体改写为新口径，约 47 条：
- **三处拉黑行为**（profile / 列表页 / 开闸后页面）：改走 `relBadgePopShow(badge, h, rel)` 弹窗 → 取 `ysy-xprobe-ext-relpop` 里 `button` → `fire('click')`；「已拉黑」判据改读徽标 `style.background` 含 `rgba`（描红）。
- **ratio / stale 块**：行内百分比断言改读弹窗 `relBadgeRows` 的「关注百分比」行（含「· N 天前读到」）与 `__ratioInfo` 的 `stale`/`ageDays`；「数半路到 ⇒ 弹窗从 — 补成 54%（418/771）、行内不撑宽」保留。
- **名字行挤窄 / 小红点降档**：`children.length === 0/2` 改单 child 状态徽标口径（小红点本身是一枚 child）。
- **晚水合 / 并账回显**：`children[0].textContent === '已拉黑'` 改读 `style.background` 含 `rgba`。
- **[41] 徽标结构 / 34 段降档梯**：v0.12.10「钮+标签两件」「缝 100 预算」改新紧凑徽标口径（状态恒出、缝 24 仍 `full`、缝 30 退 `dot`、140 退 `dot`）；`badgeRelNo` 记账断言随设计移除（新设计不增该计数）。
- **源码针脚 pin18**：`needOf` 新签名（`BADGE_FULL_W + (x ? BADGE_GAP_PX + relBudget(x) ...`）。
- 删除 `console.log('DEBUG badge41...')`。

## 红线
只改扩展侧 JS/版本戳，未碰宿主/权限/出口 ⇒ RL-12 无需重打 exe；**[11x] 不拦点击恢复达标**（全文 0 处 preventDefault/stopPropagation）；RL-30（渲染完才动笔）未破；RL-1 只展示不代操作（拉黑仍由人点弹窗钮触发）；RL-11 不编数（空白占位、无数据写 `—`）。

## 验证
`probe-selftest.js` **1845/0**；`db-selftest.py 232/0`；`exe-check.py 45/0`；`node -c` 通过；版本戳四处一致；改动文件保持 CRLF。备份：本轮开工前备份缺失（续会话时工作树已半改），补 `%TEMP%/xprobe-bak-20261112-relpop/` 存 v0.12.12 当前态作回滚锚点（as-is，非改动前快照）。

## 有意没改
- `badgeSweep`/`badgePick` 老位置粘住（`badgeMoved`）逻辑保留——新徽标 ~20px，缝宽判据自然变化，测试同步而非改逻辑。
- `noFollowbackOf` 本体（art-030 已留账待定，弹卡按 rel.key 分叉已消除展示层误报）。
- 评论数栏仍「未采集」（art-029 决策二未授权）。

## 真机走查待用户
重载确认 0.12.12；长昵称行互关标签不再被挤没（窄缝退状态点/空白占位但 hover 仍能弹）；空白状态也恒显示占位、hover 能弹窗拉黑；弹窗里有拉黑钮与关注百分比（旧数带「N 天前读到」）；点拉黑生效、徽标描红、弹窗钮翻「取消拉黑」；手机关注过的人本机首次加载到后关注时间被记为当时、未回关天数从那时起算。

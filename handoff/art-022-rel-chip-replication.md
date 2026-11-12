---
id: 2026-11-11-art-022-rel-chip-replication
type: brief
date: 2026-11-11
topic: [x-observe-probe, 关系标签, 不是兄弟, 抖动, 未回关]
priv: private
by: main
---

# 卡：关系标签 100% 复刻「不是兄弟」的安置 + 名单「N 天未回关」

> 用户原话（截图：绿色胶囊正常的是参考插件，暗色拉长的是咱们的）：「请你严格审查下问题，争取找到不是兄弟是怎么实现的，100%复刻他，并且解决页面抖动的问题，特别是评论多的时候，加载这个状态会导致页面卡顿、飘逸，鼠标移动光标就乱套了。一定要避免影响正常使用。」
> 另加功能：「几天未回关」——我单向的人行尾一枚小天数标；手机关注的（电脑没记关注时间）默认「第一次见到的那天」为关注时间。

## 0 根因（拆了参考插件 dioanbgbpklflgochbljdehpjidckgfd/0.6.1_0 的 content-script.js/css 实锤）

| 事实 | 证据 |
| --- | --- |
| 咱们 v0.11.10 把标签 `anchor.append()` 塞进名字锚**里面** | core.js 旧 relChipRow（6019） |
| 详情页那颗锚是纵排 flex 的整块身份区，胶囊进去成一个 item，默认 align-items:stretch ⇒ 横向拉满、掉到名字下面 | 用户截图的暗色拉长条 |
| 行高跟着跳 + 行反复生灭 ⇒ 评论多的页面卡顿/漂移/光标乱 | 用户口径 |
| 参考插件安置是 host+position：po（User-Name 容器 beforeend，要求同时有 @handle 文本与主页锚且无 time）→ Le（@handle 文本/其锚 beforebegin）→ Xe（名字锚 afterend）→ 兜底自己 beforeend | Hi/Le/Xe/po/Ci/Li，Mi 用 insertAdjacentElement/append |
| 禁区判据：头像容器、含 `:scope img` 的锚、含/在 `<time>` 里都不当宿主 | B/Ce（ao/wi 常量） |
| 写纪律：xi 位置没站错不搬；textContent 只在变了才写；badge `pointer-events:none; flex:none`；宿主行打 `xro-name-badge-row`（flex nowrap）/详情页 `xro-name-badge-stack`（grid，标签独占一行 width:max-content） | go/no/Ii/mo/Pi + content-script.css |

## 1 改了什么（v0.12.2）

- `extension/content/core.js` relChip 段整体重写（锚点：`relPlace` / `relAtSpot` / `relChipRow` / `relChipStyle` / `relChipEl`，约 6054-6215）：
  - `relPlace` = Hi 逐条对译（三段候选、四步次序、禁区判据 B/Ce 同款）；`relHrefIs` 不用 URL 构造器（沙箱没有，X 的 href 全是站内相对路径）。
  - `relChipRow(nameEl, h, rel)`：认领收在 UserCell/HoverCard 里（绝不上爬 article——引用帖的标签会被主帖那趟当旧颗摘掉，平白生灭）；档位没翻（data-k）且位置没站错（relAtSpot）⇒ 一个字都不写；搬进纵排容器时补 `align-self:flex-start`（参考插件 stack 方案的轻量替身，不动宿主布局）。
  - `relChipStyle(x, rel, host)` 补三条：`flex:none`、`pointer-events:none`（指针穿透，「鼠标一过头标就乱」断根；title 照写留给无障碍，真机不出泡是参考插件同款）、外边距分宿主两档（a 里 4px / 兄弟位 0 8px，抄 .xro-badge）。
  - 调用点（badgeScan 内）：`relChipRow(nameEl, h, rel0)`；`__xprobe` 导出 relPlace/relAtSpot。
- 名单「N 天未回关」（core.js `noFollowbackOf` / `followStartAt` / `noFollowbackDays` + flistBuild 行渲染 + flistSigOf 指纹）：
  - 只挂有凭据的行：我单向（state=following 且非待回）+ TA 那侧有凭据（桥 followed_by=false，或进过粉丝列表没见过 TA=推断，与「我单向」虚线标签同口径）；「?」/互关/待回行不挂。
  - 起算：`seenAs.following`（本机关注列表里看到 TA 的那天）→ 退 `firstSeenAt`（手机关注的兜底）。台账实情：本机没有 per-handle 关注动作账（guard.follows 只是限流时间戳），这两笔就是最接近的账，悬停 title 写明日期与口径。
- 没做 stack grid（`xro-name-badge-stack` 整套）：它要改宿主布局，真机没验证过不敢动 X 的 User-Name；align-self 替身已够防拉伸。

## 2 验收

1. `node probe-selftest.js` 全绿：1729 通过 / 0 失败。新增断言（[34] 内）：新位置（名字锚 afterend 兄弟位、在 time 前）、flex/pointer-events、relPlace/relAtSpot 单测（time 禁区、img 禁区、兜底、位置没站错不搬）、名单天数标（起算两口径、互关向不挂、3.5 天⇒3 天）；改咬点：pin18 与 [34] 位置断言换新语义；桩补 `insertAdjacentElement` 四方位。
2. 版本戳四处同步：manifest 0.12.2 / core VER 0.12.2 / BUILD 2026-11-11-b / PANEL_BUILD 2026-11-11-b。
3. 真机走查（待用户）：详情页与时间线胶囊不再拉长、评论多的页面滚动不漂、悬停不出泡光标不乱、名单「已关」列我单向行尾有「N 天未回」。

---
id: 2026-11-11-art-021-float-rail
type: brief
date: 2026-11-11
topic: [x-observe-probe, 浮标, 钮排, 设置]
priv: private
by: main
---

# 卡：浮标钮排四改（占地方 / 不能拖 / 字太小 / 设置可关）

> 用户原话：「这个右下角太占地方了，并且也不能移动，并且热和稿这两个字太小了，另外设置里面应该可以勾选是否显示这些个东西。」
> 适用范围：`extension/content/core.js` 的钮排 + `extension/ui/sidepanel.*` 的设置区。**不重做视觉**，沿用 v0.9.5「观测站仪表」那根玻璃柱。

## 0 现状（本轮实测，行号是快照，符号名才是锚点）

| 事实 | 证据 |
| --- | --- |
| 钮排是 `fabBtn()` 一次建起，`position:fixed; right:14px; bottom:210px; z-index:2147483647`，竖排 8 颗 | `extension/content/core.js:6730-6807`，位置写死在 `:6743` |
| 8 颗：关 / 榜 / 热 / 回 / 杆 / 帖 / 稿 / 观 | `:6784-6806` |
| 直径统一由 `fabApplySize()` 写，但它只遍历 6 个 id | `:3474-3491`，数组在 `:3482` |
| **「热」「稿」字小的根因**：`HOTBTN_ID`（v0.11.18 第八颗）和 `AIBTN_ID`（v0.11.4 第七颗）加进排里时，**没加进 `:3482` 那个数组**，所以这两颗拿的是 `FAB_STY` 的初始尺寸，没吃到实测直径 | `:3382`(FAB_STY) vs `:3482`(漏项) |
| 设置区的闸门范式已有现成的 | `extension/ui/sidepanel.html:127`「页面内拉黑徽标」 |
| 按闸显隐的范式也已有现成的 | `core.js` 的 `aiGateOn()` / `aiBtnShown()`，`:6802`、`:6827-6831` |

## 1 四条需求 → 四条改动

### R1 太占地方

推荐做法（默认）：**整列默认折叠成一颗**，鼠标悬停或点一下展开；展开态 8 颗照旧。
- 折叠态就一颗：探针圆点 + 「探」字，直径等于一颗钮。
- 展开/收起只改 DOM 的显隐与 transform，**不许重排顺序、不许重建节点**（节拍器每 1.2 秒路过，见 `:6833-6839` 的纪律）。
- 备选（若实现成本高）：整列贴边半隐（`right:-Npx`，hover 滑出）。两者取其一，不要都做。

### R2 不能移动

- 钮排支持拖动：`pointerdown` 记起点 → `pointermove` 改 `right/bottom`（或 `left/top`）→ `pointerup` 落库。
- 落库用现有的 storage 通道，键名自定但必须写进 README 的键表（仓库有键表惯例，先 `grep` 确认现有命名再起名）。
- 启动恢复位置时必须 **clamp 到视口内**（窗口缩小、换屏后不许跑到屏幕外）。
- 拖动中不许触发钮上的 click（拖完松手算拖，不算点）。
- 设置里给一颗「位置复位」。

### R3 热 / 稿 字太小

- 把 `HOTBTN_ID`、`AIBTN_ID` 补进 `core.js:3482` 那个尺寸数组。
- 顺带自查：以后新增钮**必须同时进这个数组**，否则又漏。建议在同一处留一行注释指路。
- 验收看真机：8 颗直径一致、字号一致（这俩现在是唯一两颗小的）。

### R4 设置里能勾选显示/隐藏

- `sidepanel.html` 设置区加一颗闸，写法照 `:127` 那颗。
- 文案要写清「关掉＝当场摘干净、页面零痕迹」（沿用现有语气）。
- 闸的值由 content 侧读同一个键决定整根柱子的显隐；**关着就整棵摘掉，不是 display:none 占位**——这一点照「页面内拉黑徽标」的既有约定，别自创。
- 三颗闸的从属关系写清：`显示钮排`（总闸）→ `折叠态`（R1）→ `位置复位`（R2）。

## 2 验收（缺一不可）

1. `node probe-selftest.js` 全绿；**新增断言**至少覆盖：8 颗 id 全在尺寸数组里、折叠态只有 1 颗可见、拖后坐标被 clamp、总闸关掉后柱子不在 DOM 里。
2. 版本戳四处同步：`extension/manifest.json:4`、`core.js:10`、`core.js:12`(BUILD)、`ui/sidepanel.js:13`。
3. 真机走查：X 页面上 8 颗等大、默认折叠、能拖、拖动后刷新还在原位、设置关掉后页面零痕迹。
4. `handoff/art-021-float-rail.md` 留回执（改了什么、行号、怎么验的）。

## 3 纪律

- Chrome MV3，原生 JS + CSS，**没有构建工程**，不许引入 React/打包器。
- 节拍器每 1.2 秒会走一遍钮排刷新，**任何新逻辑都不许在没变的那一趟写 DOM**（`:6833-6839` 的既有纪律）。
- 行号会漂，**以符号名为锚点**（仓库规范 §0.3，`docs/面板设计规范-v1.md`）。

## 回执（2026-11-11，v0.12.1 / BUILD 2026-11-11-a）

R1–R4 四条全做（R2 用户拍板一起做）。版本戳四处已同步：`manifest.json` version 0.12.1、`core.js` VER 0.12.1 / BUILD `2026-11-11-a`、`ui/sidepanel.js` PANEL_BUILD `2026-11-11-a`。

**改了什么（符号名锚点，行号为本次快照）：**

- **R3 尺寸补齐**：`fabApplySize` 的遍历数组提为常量 `FAB_SIZE_IDS`（`core.js:3487`），补进漏掉的 `HOTBTN_ID`（热）、`AIBTN_ID`（稿），并纳入新增的 `FOLD_BTN_ID`；数组上方留注释「以后新增钮必须同时进这个数组」。`AIBTN_ID` 声明上移到 `core.js:180`（原在 AI 节，`FAB_SIZE_IDS` 在它前面就要用，const TDZ）。
- **R1 默认折叠**：柱顶（圆点之后）新增折叠钮「探」`FOLD_BTN_ID`（`core.js:178`），点它走 `fabFoldToggle()`（`core.js:6762`）切换；显隐写手在 `fabBtn` 尾段（`fabFoldApplied` 影子比对，没翻面那趟一个字不动，守节拍纪律）；折叠时 7 颗业务钮 + 分隔线（新挂 id `FABSEP_ID`）display:none，「探」与圆点常驻。折叠态落 `ysy.xprobe.fabfold`（默认折叠）。第七颗「稿」的显隐写手改成 `aiBtnShown() && !fabFoldGet()` 联动，两套写手不打架。
- **R2 拖动**：`fabDragWire()`（`core.js:6801`）在柱上挂 pointerdown，move 过 4px 阈值才算拖，实时过 `fabClampPos()`（`core.js:6774`，纯函数）钳在视口内，pointerup 落库 `ysy.xprobe.fabpos`；重建时 `fabPosApply()` 恢复并再钳一次。**落库键写在此处**（README 里没有键表——交接卡里那句「写进 README 的键表」与仓库现状不符，键名沿用 `ysy.xprobe.*` 族：`fabrail`/`fabfold`/`fabpos`，见 `core.js:181-183`）。设置区加「位置复位」（`fabPosReset`，`core.js:6790`，清存档回 right 14 / bottom 210）。
- **R2 拖/点不分家**：拖完松手那一下 click 由 `mk()`（`fabBtn` 内）包的壳吞掉（`fabClickSuppress` 用完即清）。**没动红线**：`core.js` 全文依旧无 `preventDefault`/`stopPropagation`（[11x]/[11c] 两条静态断言原样通过），防选区用柱上的 `user-select:none`。
- **R4 总闸**：`fabRailGet()/setFabRail()`（`core.js:6746/6749`），键 `ysy.xprobe.fabrail` 默认开；关 = `fabBtn` 顶部整棵 `remove()` 并清三个影子（不是 display:none 占位），节拍器每趟现读闸、不复活；重开当场重建、折叠态与位置沿用。`sw.js` CMDS 白名单加 `setFabRail`/`fabPosReset`；state 加 `fabrail:{on}`；`sidepanel.html` 设置区照 `bBadge` 范式加「显示钮排」「位置复位」两行（文案写明从属：总闸 →「探」折叠 → 位置复位），`sidepanel.js` 加显示与 `bFabRail`/`bFabPos` 命令。
- 连带更新：原「SW 广播闸开」与「变异 A」等钉旧行为的既有断言对齐新现实（`[35]` 段先拨 `fabfold=false` 再测第七颗、段尾清键；`aiLeg` 切片起点改 `const AICARD_ID`，因为 AIBTN_ID 声明上移）；sidepanel 设置区行数 33→35、可见字数上限按惯例 800→850。

**怎么验的：**

- `node probe-selftest.js` 全绿：**1725 通过 / 0 失败**。新增 `[8h5]` 段 18 条断言，覆盖验收 1 要求的四类：九颗 id 全在 `FAB_SIZE_IDS`、量到 40 后「热/稿/探」直径真变、默认折叠只露「探」（展开 9 件 / 收起 1 颗，节拍路过不重写）、`fabClampPos` 两头钳 + 拖后坐标钳在沙箱 1440×900 内、总闸关 = 柱子不在 DOM 且节拍不复活、重开重建且折叠/位置沿用、命令通道 `setFabRail` 同帧生效、拖后 click 被吞且不触发「探」。
- 版本戳四处一致由既有断言（`[验收 8]`）钉住，期望值已更新到 0.12.1 / 2026-11-11-a。
- **真机走查（验收 3）未做**——本环境没有真机浏览器，待用户在 X 页面上确认：8 颗等大、默认折叠、能拖、刷新还原位、设置关掉后页面零痕迹。若有出入，按本卡 §0 的符号名回来对账。

---
id: 2026-11-12-art-025-rel-chip-name-right
type: brief
date: 2026-11-12
topic: [x-observe-probe, 关系标签, 不是兄弟, 昵称右侧, 增量评论, 抖动红线]
priv: private
by: main
---

# 卡：关系标签搬回昵称右侧 + 「页面渲染完才动笔」立为项目红线（RL-30）

> **用户原话**（`x.com/home` 帖子行截图：昵称下方一条被拉长的绿「互关」，昵称右侧是「不是兄弟」的小绿胶囊）：「现在颜色对了，但是位置不对，现在的位置在昵称下方，而不是兄弟在昵称右侧，帮我也改成昵称右侧。注意 一定不要影响 评论页面的刷新，之前老是出现 页面增量获取下一页评论 页面会出现抖动，应该参考不是兄弟的做法，等页面渲染完之后再渲染，不要影响页面正常使用 **这个是这个项目的 红线和规则**」。

## 0 权威证据（仍是拆参考插件源码，不照截图猜）

| 文件 | 实锤 |
| --- | --- |
| `content-script.js` `go()` / `no()` / `Ii()` / `mo()` / `Pi()` | 徽标插完还会 `no(a.parentElement, n)`：给 User-Name 容器加 `xro-name-badge-stack`（grid 三列）、给「同时含 @handle 与名字锚的最小公共祖先」加 `xro-name-badge-row`（`display:flex !important; flex-direction:row !important; flex-wrap:nowrap !important`）。**它能站在昵称右侧，靠的就是改 X 宿主布局。** |
| `content-script.css` `.xro-name-badge-row/stack` | 上面两个类的原文；`.xro-badge` 自带 `flex:none / pointer-events:none / white-space:nowrap`。 |
| `content-script.js` `xt({delayMs:Al})`、`Al=180`、`MutationObserver` | 观察器只 `request()`，一批动静合成一趟、DOM 安静 180ms 后才 `At(document)+$o(s)` 一次性扫全页并批量画徽标；`Xl()` 把自家节点引起的 mutation 全滤掉，不自激。这就是「等页面渲染完之后再渲染」的原型。 |
| 本仓 `HISTORY.md` v0.11.9 / v0.11.10 / v0.12.2 | 同一个位置翻过三次车：v0.11.9 插 `User-Name` 里当兄弟 ⇒ X 那里是 **grid**，新元素被当成新格子、独占一行还被拉伸；v0.11.10 改塞进名字锚里面 ⇒ 详情页那颗锚是纵排 flex，被 `align-items:stretch` 拉满；v0.12.2 改 `po`（User-Name 容器 `beforeend`）⇒ 用户这轮截图里「昵称下方那条宽绿条」。 |

## 1 根因（这一轮只有一条）

`relPlace` 的首选是 `po` → **把胶囊 append 到 `User-Name` 容器末尾**。X 的这一层在时间线/评论行是 grid（或纵排 flex），于是胶囊成了新格子/新 item：另起一行 + 拉伸占满。参考插件用 `mo()/Pi()` 把这一层改成 flex row 才站得住；我们 v0.12.2 明确「不敢动 X 的 User-Name」，于是同一个 `po` 落点在我们这边就必然掉到昵称下面。

## 2 改了什么（v0.12.6，只动 `extension/content/core.js` + 四处版本戳 + 自检）

| # | 改动 | 对译 / 理由 |
| --- | --- | --- |
| 1 | `relPlace` 次序改成 **名字锚 `afterend`（Xe）优先** → `po`（容器 `beforeend`）退成兜底 → `Le`（@handle 前）→ 自己 | 位置落到「紧跟显示名、@handle 之前」，与「不是兄弟」同款视觉；**不改宿主一个像素**。参考插件靠改宿主布局达成，我们靠选更内层的挂点达成。 |
| 2 | `relChipStyle` 补防拉伸四件套：`alignSelf:center` / `justifySelf:start` / `maxWidth:max-content` / `height:max-content` / `gridRow:1` | 只管自己：纵排 flex 不被 stretch 拉满、grid 里不另起一行。这是「评论增量加载时行高跳动」的老根因的正面封堵。 |
| 3 | `relChipStyle(x,rel,host,pos)` 新增 `pos`，`marginInline` 只在标签**真的是 a 的孩子**时用 4px | 参考插件 `a > .xro-badge` 是子选择器；`afterend/beforebegin` 是兄弟位，旧实现按 `host.tagName` 误判成「在 a 里」。 |
| 4 | 新增 `REL_SETTLE_MS = 180`、`relDomBusy()`；`renderBlocks(force)` 非 force 在突发期**整趟跳过并留旗子** | 逐条对译 `xt({delayMs:Al})` 的 `Al=180`。判据复用观察器现存两笔账：`mutQueue.length>0 \|\| inBurst()`；自家节点被 `isOwnNode()` 挡在观察器外，不自激（等价于 `Xl()`）。拉黑徽标 / 比例标签 / 关系标签共用这道闸。 |
| 5 | `relRenderSoon()` 改成：一批只排一趟（不 `clearTimeout` 重排）、到点还忙就顺延、静默后 `requestAnimationFrame(go)` **帧后**再批量动笔 | 参考插件 `request()` 的 `if (i!==null) return` 语义；刻意不写真去抖 —— 桥持续推送时会无限顺延，标签反而永远不出现。帧后写入同时满足 `chrome-extensions` 指南「批量 DOM 写入别占页面布局帧」。用户动作 / 自检走 `renderBlocks(true)`，不受这道闸拦。 |

**没碰的东西**：宿主 Python 一个字没改（按 RL-12 无需重打 `xprobe-host.exe`）；manifest 权限 / 出口 / content_scripts 一个字没加；没往页面注入 `<style>` 或新 wrapper 节点；没给 X 的节点加任何 class / inline style（RL-16 零痕迹原样保住）。

## 3 有意没抄（如实登记，别把「百分百」说满）

| 没抄 | 原因 |
| --- | --- |
| `xro-name-badge-row` / `xro-name-badge-stack`（`!important` 改 User-Name 的 display/grid） | art-022 实测：改宿主布局正是「评论多就卡顿、飘逸、鼠标光标乱」的根因，且违反 RL-16 零痕迹。改用「更内层挂点 + 标签自身防拉伸」拿到同样视觉位置。 |
| `xro-identity-mark--*`（给名字锚加渐变背景） | 同上，往 X 节点写样式。 |
| 参考插件 `.xro-badge--user-card` 的截断 / 多出的档位与中文文案 | 三档字面是用户本人点名的，不翻旧账。 |

**红线已入册**：`skills/docs/ARCHITECTURE.md §0` 新增 **RL-30 页面渲染期零写入**，`skills/SKILL.md` 速查同步到 RL-30；`HISTORY.md` 补 v0.12.6 段。

## 4 验收

- `node probe-selftest.js` **1774 / 0**（新增 `[37]` 10 条：Xe 优先于 po 的结构针脚 + 正向对照、完整 User-Name 桩的 `afterend` 行为、防拉伸四件套、a 子/兄弟两档边距、180ms 静默值、五项时机源码针脚 + 正向对照、**突发期整趟不写**的行为断言）。
- `python -X utf8 db-selftest.py` **232 / 0**；`py -3 native/exe-check.py` **45 / 0**；`node --check extension/content/core.js` 通过。
- 四处版本戳 `0.12.6 / 2026-11-12-c`；四个改动文件全 LF、孤 CR = 0；`HISTORY.md` 仍 CRLF（按原风格插入）。
- 备份四份在 `%TEMP%/xprobe-bak-20261112-pos/`。

## 5 真机走查（只能用户在 Chrome 走）

- [ ] `chrome://extensions` ⟳ 重载（`0.12.6`），刷新 `x.com/home` 与一张评论多的帖子详情页。
- [ ] 「互关 / 他单向 / 我单向」三颗胶囊**都在昵称右侧**（紧跟显示名、@handle 之前），不再是昵称下方那条宽绿条，也不再被拉伸。
- [ ] 深色 / 浅色主题下配色仍与「不是兄弟」同明同暗（v0.12.5 那套不回归）。
- [ ] **增量加载下一页评论**：滚动触发「更多回复」时页面不抖、不飘、不卡顿，鼠标悬停光标不乱；侧栏「性能账」的 `badgeSkips` 会涨（那是「加载中跳过」的记账，不是故障）。
- [ ] 停止滚动后约 1~3 秒内（180ms 静默窗 + 原有 2.5 秒扫描地板），新出现的评论行标签自己补齐；不用悬浮、不用刷新页面。
- [ ] 拨回「页面徽标」总闸 ⇒ 三颗标签当场摘净，X 的节点上不留我们改过的样式 / 类。

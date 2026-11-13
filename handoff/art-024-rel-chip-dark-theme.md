---
id: 2026-11-12-art-024-rel-chip-dark-theme
type: brief
date: 2026-11-12
topic: [x-observe-probe, 关系标签, 不是兄弟, 深色主题, 配色]
priv: private
by: main
---

# 卡：关系标签 100% 抄「不是兄弟」的浅/深两套配色 + 主题判定

> **用户原话**（`x.com/home` 与帖子详情两张截图）：「这些页面显示评论和帖子 也就是所有账号标题 昵称下方的 黑色的互关表示是咱们的探针功能，颜色太不明显了，而昵称右侧的是不是兄弟的 表示，人家的绿色的就很清晰，请你使用 chrome-extensions 和 modern-web-guidance 这个两个技能，参考 不是兄弟的 样式和实现，帮我把样式，和功能百分百抄不是兄弟的实现」

## 0 权威证据（这轮不是照截图猜）

参考插件本机安装目录（Chrome Default 扩展，v0.6.1）：

```
C:\Users\asywr\AppData\Local\Google\Chrome\User Data\Default\Extensions\dioanbgbpklflgochbljdehpjidckgfd\0.6.1_0\
```

| 文件 | 实锤内容 |
| --- | --- |
| `content-script.css`（727 行） | `.xro-badge` 基础规则；`.xro-badge--mutual / --following_only / --follows_you_only` 等 8 条浅色档；`:root[data-xro-theme="dark"]` 下 7 条**深底亮字**；`@media (prefers-reduced-motion: no-preference)` 的 `xro-badge-in 160ms ease-out` |
| `content-script.js`（162 KB） | `Vo(e)` 把主题戳写进 `document.documentElement.dataset.xroTheme`；`rr()` 读 body / documentElement 的 computed `backgroundColor`、按 `(299R+587G+114B)/1000 < 128` 判 dark，量不到退 `prefers-color-scheme`；`go()` 造徽标（`className` / `textContent` / `title='@handle · 说明'` / `aria-label='handle: 档位名'` / `data-xro-badge` 档位属性 / host+position 安置） |

## 1 根因：一条实锤 bug + 漏抄半套主题色

- `relVerdict()` 返回的对象只有 `key / lab / color / dash / tip`，**从来没有 `bg` 这一格**；而 v0.11.13 起的 `relChipStyle()` 写的是 `x.style.background = rel.bg` ⇒ `undefined` 被浏览器丢弃 ⇒ **标签根本没有底色**。
- 再叠加硬编码 `color:'#13231b'`（深墨绿）与 `color-mix(tone 55%, #13231b)` 的深绿边 ⇒ 落在 X 的深色页面上就是用户说的「黑色的互关，颜色太不明显」。
- 参考插件另有一整套 dark 配色（`mutual` = `#183b25` 底 + `#b8efa9` 亮绿字），v0.11.13 只抄了浅色那半套、也没抄主题判定 `Vo()/rr()`。同页「不是兄弟」的绿色胶囊因此一直清晰，咱们的却发黑。

## 2 逐项对译（`content-script.css` → `extension/content/core.js`）

| 参考插件规则 | 探针现在的实现 |
| --- | --- |
| `--xro-ink:#13231b` / `color:var(--xro-ink)` | `REL_TAG[key].light.ink`；dark 换 `dark.ink`，由 `relChipStyle` 按 `relThemeNow` 取 |
| `.xro-badge--mutual{--xro-tone:#a8e89a;background:#dff7d9}` 等三档 | `REL_TAG` 的 `color`（tone，边框用）与 `light.bg` 一字不差 |
| `:root[data-xro-theme="dark"] .xro-badge--*` 三档 | `dark: { bg, ink }`：`#183b25/#b8efa9`、`#173747/#a8dcf8`、`#493817/#ffd77b` |
| `border:1px solid color-mix(in srgb,tone 55%,#13231b)` | 原式保留；dark 档参考插件同样**只覆盖 background/color**，边框不变 |
| `border-radius:999px` / `--following_only{border-radius:4px}` | `rel.key==='me' ? '4px' : '999px'` |
| `box-shadow:inset 0 1px 0 rgb(255 255 255/.3)` / `2px 2px 0 rgb(100 70 15/.18)` | 原式保留 |
| `font:750 10px/14px`、me 档 `10px/16px`、字族本机栈、`letter-spacing:.02em` | 原式保留 |
| `padding:1px 7px` / me `padding-inline:7px 8px`、`margin-inline:0 8px` / `a >` 档 `4px` | 原式保留（v0.12.2 已抄） |
| `display:inline-flex;align-items:center;flex:none;white-space:nowrap;pointer-events:none;vertical-align:1px` | 原式保留（防抖筋骨，v0.12.2 已抄） |
| `Vo()/rr()` 主题判定 | `relThemeDetect()`：先跟随 `:root[data-xro-theme]`，再量背景亮度 128，再退 `prefers-color-scheme`；`relThemeSync()` 每趟扫描算一次；按 dark-mode 指南注册 `change` 监听 |
| `go()` 的 `title` / `aria-label` / 档位 data 属性 | `relChipEl(rel,host,h)`：`title='@handle · 说明'`、`aria-label='@handle：档位名'`、`data-k`（档位+虚实）+ `data-t`（主题） |
| `xro-badge-in 160ms ease-out both` | WAAPI 等价实现（`opacity/transform`，不动布局），尊重 `prefers-reduced-motion: reduce`；**不往页面注入 `<style>`/@keyframes**，避免多一个节点 |
| host+position 安置、位置没站错不搬、`textContent` 变了才写 | v0.12.2 `relPlace / relAtSpot / relChipRow` 已 100% 复刻，本轮只把主题翻面接进「就地重刷」：`data-t` 变了 ⇒ `relChipStyle` 重跑，**不重建节点、不改 data-k 语义** |

## 3 有意没抄（如实登记，别把「百分百」说满）

| 没抄 | 原因 |
| --- | --- |
| `xro-name-badge-row` / `xro-name-badge-stack`（改 X 的 User-Name 为 flex/grid 容器） | art-022 实测结论：改宿主布局正是上一轮「评论多就卡顿、飘逸、鼠标光标乱」的根因；v0.12.2 的 `align-self:flex-start` 轻量替身已够防拉伸 |
| `xro-identity-mark--*`（给宿主名字锚加 class 与渐变背景） | 会往 X 的节点上写样式，违反「拨回关 ⇒ 页面零痕迹」与项目注入总闸 |
| `xro-badge--user-card` 名片档截断、`blocked_by / changed / unfollowed_you` 等档位 | 探针只有用户 v0.11.4 点名的三档（互关 / 他单向 / 我单向），没有对应判定口径；不凭空造状态（RL-11） |
| 中文文案改成参考插件的「单向关注 / 关注了你」 | 三档字面是用户本人点名的，改了属于翻旧账；仅把**完整档位名**放进 `aria-label` |

## 4 验收

- `node probe-selftest.js` **1764 / 0**（+5 条：浅色三档实底与 `data-t/aria-label`、dark 三档深底亮字、就地重刷不重建节点、反向翻回浅色、主题检测逐条对译 `rr()`/`Vo()`）；`python -X utf8 db-selftest.py` **232/0**；`py -3 native/exe-check.py` **45/0**。
- 12 个参考配色值在 `core.js` 全部命中；四处版本戳 `0.12.5 / 2026-11-12-b`；四个改动文件全 LF、孤 CR=0。
- 本轮**只改扩展侧 JS/JSON**，没碰宿主 Python ⇒ 按 RL-12 无需重打 `xprobe-host.exe`；备份四份在 Temp `*.bak-20261112-dark`。

## 5 真机走查（只能用户在 Chrome 走）

- [ ] `chrome://extensions` ⟳ 重载（`0.12.5`），打开 `x.com/home` 与一张评论多的帖子详情页。
- [ ] 深色主题下：三档胶囊都是**实底 + 亮字**，互关那颗与旁边「不是兄弟」的绿色胶囊同样清晰；不再是黑条 / 透明底。
- [ ] 把 X 切成浅色主题：同一颗标签就地换成浅底深字（`#dff7d9/#13231b`），不闪、不重建、不跳动。
- [ ] 快速滚动评论多的页面：不卡顿、不漂移、鼠标悬停光标不乱；`pointer-events:none` 与零写纪律没破。
- [ ] `chrome://extensions` 里确认版本 `0.12.5`，侧栏「性能账」的挪/退点没有异常增长。

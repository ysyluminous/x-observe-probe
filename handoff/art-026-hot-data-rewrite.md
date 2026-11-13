# art-026 交接卡 · v0.12.7 流量取数整块对译「X Viral Monitor」

日期：2026-11-12　版本：`0.12.7 / 2026-11-12-d`　用户裁定：**选项 3（整块照参考插件重写）**

## 1. 症状与根因（真机证据在 `D:\code\yunxiao\temp\xprobe\dump\2026-11-12_154058-tweet-NickTrader8801\page.html`）

- 用户报「帖子详情无法正常显示速度，评论列表正常」。截图那一刻的页面转储证实：
  - 主贴 `2120763270491492380` 在首页 analytics 链接是 `aria-label="295 次查看。查看帖子分析"`（有数字）；进详情页当主贴后变成 `<a href=".../analytics">296 查看</a>` —— **没有 aria-label，数字只在可见文字里**。
  - 探针 `hotParseArticle` 旧版只取 `getAttribute('aria-label')` ⇒ 主贴拿 `null` ⇒ 判 `skip:'missing'` ⇒ 详情卡八栏全 `–`。评论行仍带 aria-label ⇒ 正常。
  - 附带两坑：主贴 `role="group"` 聚合标签只有「11 回复、9 喜欢、296 次观看」3 个数，旧版按「第 5 个数取收藏」⇒ 收藏恒 0；少数评论 analytics 标签只写「查看帖子分析」不带数字，也会漏。
- 参考插件 `X Viral Monitor 1.18.17`（`C:\Users\asywr\AppData\Local\Google\Chrome\User Data\Default\Extensions\dkplofpecmjmbhgjgleeflcnfgfkdfpd\1.18.17_0`）不受影响：它**主数据源是 X 自己 GraphQL 回包**里的 `views.count` + `legacy.*`（精确整数），按帖子号对齐，DOM 只是兜底。

## 2. 改了什么（数据层整块换血，渲染时机守 RL-30 不动）

### 主世界 `extension/content/bridge.js`（只读信使，零新出口）
- 新增 `tweetDataOf(result)`：对译参考插件 `extractTweetData`。从 `tweet_results/tweetResult/tweetResults .result` 取 `views.count`（须 `views.state==='EnabledWithCount'`）+ `legacy.favorite_count/retweet_count/reply_count/bookmark_count/created_at` + `rest_id/id_str` + `core.user_results.result.legacy.screen_name`；推广帖（`legacy.promotedMetadata`/`tweet.promotedMetadata`）剔除；无发布时间不进账。
- 新增 `scanTweetMetrics(v,out)`：有界泛爬（18000 节点 / 40 层，与关系那本账分家），见 result 就喂 `tweetDataOf`，按 tid 存进 `netTweets`。
- 复用**既有** fetch/XHR 只读旁听通道：回包 `clone()` 读一份，请求与响应原样放行 —— 不发包、不换响应、不覆写原型、无常驻定时器、无观察器。
- 两条回话通道：① 旁听到货即推 `tweetpush`（只带「新 tid / 五项读数变了」的 delta）；② 问询带 `tids`（≤80）才附带 `tweets` 字段（冷启动兜底）；不带 tids 的老回包形状一字不变，关系桥判据不回归。

### 隔离世界 `extension/content/core.js`
- 新增 `netTweets` tid 缓存 + `hotNetMerge`（逐项校验、推广/脏数不进账、只认 6~25 位帖子号）+ `hotFromNet`（DOM 解析不出时用桥读数造整行）。
- `hotParseArticle`：**桥读数优先**（views/likes/rt/replies/bm/createdMs 全用精确值）；无桥读数时 DOM 三档兜底 —— ① aria-label 首数字（老路径）② analytics 链接**可见文字**（详情页主贴根因）③ 聚合 group 标签的「N 次观看/次查看/views」。收藏在无桥读数时仍按「≥5 个数取倒数第二」。
- `hotDetData`：**按 URL `statusIdFromPath` 精确定位主贴**（对译参考插件 `getStatusIdFromLocation`），逐条 article 找 href 命中 sid 的，不再盲取第一条（评论区插队时第一条未必是主贴）；桥读数在手就直接造整行，DOM 解析会 skip 也能出数。
- 推送/问询回话收到精确读数 → `hotNetMerge` → 走**既有 180ms 静默窗**（`relRenderSoon`）重画；不另起定时器。
- **RL-30 补漏**：`hotBadgeAuto` 先问 `relDomBusy()`，X 还在增量挂节点就整趟不画（原先它在闸上方，桥推送一密就会在加载中途往行里塞东西，正是用户点名的评论抖动）。`setHotBadge` 的用户动作直连渲染不经此，拨开关仍当场生效。
- 四处版本戳 → `0.12.7 / 2026-11-12-d`。

## 3. 有意没照抄的部分（红线优先）

| 参考插件做法 | 本探针 | 原因 |
|---|---|---|
| `setInterval` 周期补渲染 | 不抄 | RL-30：无常驻定时器、不在页面刷新中途动笔；改走既有的推送→静默窗重画 |
| 主世界 `onResponsePatch` 改回包（广告裁剪/注入） | 不抄 | RL-2：只读旁听，回包一个字节不改 |
| 详情卡里复制 Markdown/星图等附加功能 | 不抄 | 与本次症状无关，最小化改动 |
| 从 DOM 直接爬 store 改 RTL | 不抄 | 桥只读、不改 X 宿主状态 |

## 4. 口径升级（写进 RL-28 权威原文）

旧：热度数据「只读 DOM、只在本机算」。
新：**主数据源 = 只读旁听 X 自己的 GraphQL 回包（精确整数）；DOM 文字退为兜底**；仍零新出口、零新权限、不发请求、不点不滚；渲染时机归 RL-30。

## 5. 验收（三套闸门全绿）

- `node probe-selftest.js` **1791/0**（新增 `[38]` 17 条：桥 GraphQL 收割/推广剔除/state 闸门/tids 问询、精确优先、DOM 三档兜底、URL 定位正向对照、RL-30 热度闸行为断言 + 正向对照、零出口权限、版本戳）。
- `python -X utf8 db-selftest.py` **232/0**；`py -3 native/exe-check.py` **45/0**。
- `node --check` 通过；改动文件 LF 孤 CR=0；只改扩展侧 JS/JSON ⇒ 按 RL-12 无需重打宿主 exe。
- art-023 的 `noViews` fixture 随口径升级同步修正：真正挖掉 group 里的 `5,168 views`，否则新口径会从聚合标签读到数、`skip` 兜底判据名不副实（这是判据同步，不是放宽断言）。

## 6. 真机走查（本环境无浏览器，待用户）

1. `chrome://extensions` ⟳ 重载，确认 `0.12.7`；开「热」总闸（热度徽标默认关）。
2. 打开 `x.com/<handle>/status/<id>` 详情页：**页头流量徽标与悬停详情卡八栏都有数**（浏览量/点赞/转发/回复/收藏/流速/爆炸指数/发布时间），不再全 `–`。
3. 收藏数应为精确值（不再恒 0）；值与「X 爆款检测」插件对同一条帖的读数接近（都来自 X 自己回包）。
4. 首页时间线滚动、详情页评论「更多回复」增量加载时：**页面不抖、不飘、光标不乱**；新行的热度徽标在停滚约 1~3 秒后补齐（`badgeSkips` 上涨是「加载中跳过」的记账，不是故障）。
5. 拨回「热」总闸 ⇒ 徽标与详情卡当场摘净，X 节点上不留我们的样式。
6. 断网/无回包场景：退回 DOM 兜底，首页/评论行读数不退化；详情页若 X 完全没带浏览量则诚实显示 `–`。

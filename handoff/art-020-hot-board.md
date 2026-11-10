# 0020 x-observe-probe：本页热度榜（移植自 Chrome「X 爆款监测」）

> 执行者：WorkBuddy（本机），仓库 `D:\code\yunxiao\x-observe-probe`
> 取卡：`claim`；干活中每 15 分钟 `heartbeat`；做完 `done`；缺东西 `block`

---

## 0 首次初始化（只做一次）

```powershell
$env:COORD_DB = "postgres://coord_app:<见本机已存>@82.157.203.250:15432/coord?sslmode=disable"
node C:\Users\asywr\Desktop\kownhow\ai-native-self\scripts\coord\task.mjs list
```

---

## 1 现状证据（先自己跑一遍，不许照抄）

| 事实 | 证据 |
|---|---|
| 扩展未混淆，入口是 `extension/content/core.js`（474KB，`VER='0.12.2'`） | 文件头注释 |
| 探针**没有**热度榜/流速功能 | `Select-String 热度\|velocity\|leaderboard` 在 `extension/` 下零命中（命中全在 `.tmp_probe/` 的别家抓样里） |
| 页面常驻节点只允许右缘一列 | `skills/SKILL.md` RL-5 |
| 只读 DOM，不点击/不滚动/不跳转 | `skills/SKILL.md` RL-1 |
| 只回 `127.0.0.1:8765` | RL-2 |
| 自检是交付闸门 | RL-12，`node probe-selftest.js` |
| 参考插件：`%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\dkplofpecmjmbhgjgleeflcnfgfkdfpd\1.18.17_0\content.js` | 本机已存在，可只读参考 |

**先 `git status`**：现在有 6 个文件已改未提交（`sw.js` `core.js` `manifest.json` `sidepanel.html` `sidepanel.js` `probe-selftest.js`）。
开工前先确认这批改动是你的还是别人的；不是你的就先 `git stash`，别在别人没提交的树上改。

---

## 2 目标

在 x.com 上，把你**当前页面已经加载出来的**推文按「每小时浏览量」排个榜，并在每条推上标一个流速徽标。
数据只从 DOM 读，只在本机算，不新增任何网络出口。

---

## 3 硬约束（与红线冲突的地方，按这里改，不许照搬参考插件）

1. **不拷源码**。参考插件是商业产品（manifest 带 `key`、有付费档）。本仓库是 MIT 公开仓库，
   只照第 4 节的**口径**重写，代码行一行都不许复制。写进提交说明：「口径参考，未复制代码」。
2. **不做浮动可拖拽面板**（参考插件是独立浮窗，违反 RL-5）。落点只能是右缘那一列：
   点一下展开/收起，不新建全屏层，不贴边隐藏，不允许脱离右缘自由拖动。
3. **不做点击滚动定位**（参考插件点条目会 `scrollIntoView`，违反 RL-1）。改成：点条目只在本列表内高亮，不碰页面滚动。
4. **推文内徽标必须有总闸**（RL-16），默认**关**。关了以后 X 的 DOM 里这一个节点都不能剩。
5. 不新增权限：保持现有 5 项，不加 `scripting` / `webRequest` / `cookies`（RL-3）。
6. 不新增网络请求。算完的东西如果入库，只走现有 sink（`127.0.0.1:8765`），且不许因为新功能加新通道（RL-7、RL-22）。
7. 抓不到就记 `miss`/`cov`，不许编数字（RL-11）。缺 views、缺时间的那条直接不进榜，不填 0。

---

## 4 抓取口径（照这个写，数值一律自己算，不要信任页面上的展示）

对每个 `article[data-testid="tweet"]`，**先取 tweetId**（现有 `getTweetIdFromArticle`），再用
「只看属于本条推文的节点」的方式取值（参考实现是 `closest('article[data-testid="tweet"]') === article` 过滤，必须照做，
否则会抓到嵌套引用推的数字）：

| 字段 | 取值 |
|---|---|
| views | `a[href*="/status/{tweetId}/analytics"]` 的 `aria-label`，取**第一个数字**，去掉千分位/空格/`\u00a0`/`\u202f` 后 `parseInt` |
| likes | `button[data-testid="like"]` 或 `button[data-testid="unlike"]` 的 `aria-label` 首数字 |
| retweets | `button[data-testid="retweet"]` 的 `aria-label` 首数字 |
| replies | `button[data-testid="reply"]` 的 `aria-label` 首数字 |
| bookmarks | `[role="group"]` 的 `aria-label` 里**全部**数字；长度 ≥5 时取**倒数第二个**；否则 0 |
| createdAt | `time[datetime]` 的 `datetime` 属性（ISO） |
| text | `[data-testid="tweetText"]` 的 `textContent` |

**缺 views 或缺 createdAt 的推文直接丢弃**，不参与排名。

### 计算

```
hours    = max((now - createdAt) / 3600000, 0.1)   // 下限 0.1 小时，避免 1 分钟的新推炸榜
velocity = views / hours                            // 单位：次/小时

score = round( 40 * min(velocity/50000, 1)
             + 25 * min((likes+rt+replies)/views/0.1, 1)
             + 20 * min((rt/likes)/0.5, 1)
             + 15 * min((bookmarks/likes)/0.3, 1) )
score = min(score, 100)
```

### 阈值与分档（与参考插件一致，阈值放设置里可改）

| 档 | 条件 | 颜色 | 前缀 |
|---|---|---|---|
| viral | `velocity >= 10000` | 红 | 🔥 |
| trending | `velocity >= 1000` | 橙 | 🚀 |
| normal | 其余 | 绿 | 🌱 |

数字格式：`>=1e6` 写 `1.2M`，`>=1e3` 写 `1.2k`，其余取整。

### 榜单

- 扫描**当前 DOM 里全部** `article[data-testid="tweet"]`（不是只扫视口）
- 按 tweetId 去重（虚拟列表回收后同一 id 会重新出现，必须去重）
- 排除推广：`promotedTweetIds` 命中，或 article 内出现 `[data-testid="placementTracking"]` / 「Ad」「推广」标记
- 按 velocity 降序，取前 N（默认 10，可配）
- 列：排名 / 档位图标 / 用户名（优先显示名 `[data-testid="User-Name"]` 第一段，取不到用 `@handle`，再取不到用正文前 60 字）/ 浏览量 `1.2k` / 流速 `160/h` / 正文前 30 字

### 范围判定（只在这四类页面生效）

`pathname` → `home`（`/` 或 `/home`）、`list`（`/i/lists/x` 或 `/<user>/lists/x`）、`profile`（单段路径且不是保留路径）、`status`（`/<user>/status/<id>`）。
首页有 tab 时，**以当前 `aria-selected` 的 tab 为准**（为你推荐 / 正在关注），tab 取不到才回退 URL。

---

## 5 交付物（绝对路径）

- 代码：`D:\code\yunxiao\x-observe-probe\extension\content\core.js`（抓取与计算）
- 代码：`D:\code\yunxiao\x-observe-probe\extension\ui\sidepanel.js` + `sidepanel.html`（右缘列 + 展开列表）
- 自检：`D:\code\yunxiao\x-observe-probe\probe-selftest.js` 增加断言
- 文档：`D:\code\yunxiao\x-observe-probe\skills\SKILL.md` 补一条 `RL-28 本页热度榜口径`
- 回执：`D:\code\yunxiao\x-observe-probe\handoff\receipts\0020.json`

---

## 6 验收清单（每条能跑、能看）

1. `node probe-selftest.js` → 原 1678 条仍全绿（`1678/0`），新增断言单独计数并通过
2. 打开 `https://x.com/home`，右缘列里出现「本页热点」，条目**按流速降序**；第一名满足 `|页面显示流速 - views/年龄(h)| < 1%`
3. 构造断言：views=12000、发布于 1 小时前 → 流速 `12k/h`、红色、🔥；views=3000、3 小时前 → `1.0k/h`、橙色、🚀；views=500、5 小时前 → `100/h`、绿色、🌱
4. 一条推广推文不进榜（命中 placementTracking 的被跳过）
5. 同一条推只出现一次：滚动到虚拟列表回收再回滚，榜单条目数不增加
6. 关掉总闸后 `document.querySelectorAll('[id^="ysy"]')` 只剩右下角浮标，X 的 header row 里零徽标
7. `manifest.json` 的 `permissions` 仍为原来的 5 项，未新增三条高危权限
8. 版本戳四处一致（`manifest version` = `core VER`；`core BUILD` = `sidepanel PANEL_BUILD`）
9. 点击榜单条目**页面不滚动**（`window.scrollY` 前后不变），只有列表内高亮变化

---

## 7 完成定义

`done` = 上面 9 条全 PASS + 改动已提交并推到远端。

```powershell
git add -A; git commit -m "feat(hot): 本页热度榜（口径参考，未复制代码）"; git push
node ...\task.mjs done --id <n> --agent workbuddy --commit <sha> --result "一句话" --receipt ...\handoff\receipts\0020.json
```

任何一条没过：`block`，**不要标 done**。

---

## 8 已知风险

- X 的 `aria-label` 文案三语（中/英/日）都可能变；解析失败要进 `miss` 计数，不许静默当 0。
- 书签数依赖 `[role="group"]` 里数字的顺序（倒数第二个），X 改版就会错位；用截断断言锁住：书签数必须 ≤ 点赞数，否则记 `miss`。
- 「每小时浏览」对超过 7 天的老推会失真（早期流量早已跑完），不要拿去跟新推比名次；建议 30 天以上的推直接不进榜，或标灰。

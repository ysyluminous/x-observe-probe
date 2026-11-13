# art-035 · 三个 baseURL 契约 + 工作台拆六页（v0.12.17）

## 用户原话要点
「boot4 后续不再用了，以后就是本地 api 和智枢的前端开发和线上 2 个接口，一共 3 个 baseurl，接口全 post，参数、url 全部要一致，可以写个规则红线，确保每次修改新增参数和 url 都改 2 个地方确保一致」「决策2 选1，注意页头要有类似 tab 那种方便切换的菜单，打开后本页打开，注意单个文件最好不要太长，注意高内聚低耦合也要写到规范里面」。

## 交付
1. **RL-33**（SKILL.md / ARCH §0.x / `skills/docs/API-CONTRACT.md`）：3 个 baseURL；POST、URL/参数一致、页面唯一 qRead 只换 baseURL；改 URL/参数必须同步改两处实现（log-sink.py `XPROBE_READ_ROUTES` 与 zhishu/api `x_routes.go`）+ 契约清单、CLOUD_MAP、判据。[42] 判据四处一致。
2. **boot4 退役**：SW 一套 `CLOUD_ENVS`（zhishu 线上 / localhost:3100 开发）；manifest host_permissions 4 条（sink 两条 + 智枢两档）；dash 命令薄封装 cloud；工作台登录成功触发四条上送腿（ingest/bench/library/block）全量推本机 xprobe.db 到智枢 PG。
3. **RL-34 拆页**：`extension/ui/dash/` 六个 HTML + 六个 page-*.js + 公共壳 `extension/ui/dashboard.js`（508 行）+ `entry.js`；页头 tab 菜单 `renderTabs()` 生成 `<a href>` 本页打开；页面经 `XPROBE_DASH.register()` 注册；页面脚本 <160 行、公共壳 <520 行，判据钉死。
4. **规范**：SKILL.md 加 RL-33/RL-34 两条速查 + STOP 第 2 条改智枢；ARCHITECTURE.md §0.x；API-CONTRACT.md §2.3 核对表。

## 验证
`node probe-selftest.js` 1858/0、`python -X utf8 db-selftest.py` 232/0、`py -3 native/exe-check.py` 45/0；版本戳六处 0.12.17 / 2026-11-13-a；CRLF 一致。

## 真机走查（待用户）
1. 重载扩展 → 面板「工作台 ↗」→ 老入口跳转到 `dash/home.html`；六个页签逐一点一遍（本页打开、当前页高亮）。
2. 「设置」页：默认云端线上；切源/切档/退出登录都弹二次确认；登录用智枢邮箱验证码（旧 boot4 token 已失效，必须重登）；登录成功有明示。
3. 登录后四条上送腿全量推：观察云端档账号榜/未回关/我的日点是否出数；若 Go 的 ack 字段与旧 boot4 不同，水位/对账要再对一版（当前如实留账）。
4. 云端档帖子榜/时间线仍显「云端暂无」（Go 无对应端点，下轮对齐时两边同趟加 —— 见 API-CONTRACT.md §2.3）。

## 回滚
`%TEMP%/xprobe-bak-20261113-split/`（dashboard.js / dashboard.html / sw.js / manifest.json / probe-selftest.js / dash 目录）。

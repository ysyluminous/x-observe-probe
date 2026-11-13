# art-036 · 本地 db / dev 云端链路排查（2026-11-13 08:5x，v0.12.18）

## 用户报的三行现象

```
读不到 · 两个通道都没通（宿主未注册 + sink 未启动） · 通道 未定
查询失败：云端暂无（下一版对齐；本地库档看得到）
已登录：914925166@qq.com（开发档）
```

## 实测证据（不是猜的）

| 检查 | 结果 |
|---|---|
| 端口监听 | **只有 127.0.0.1:8765**；3100 / 8080 都没监听（先前 curl 看到的 `upstream connect failed` 是系统代理 `127.0.0.1:55418` 的误导文案，不是服务回包） |
| 8765 上是谁 | `HTTP/1.1 404` + `server: uvicorn`，PID 49944 = `python.exe run.py`；`/ping`、`/db?q=help` 全是 `Not Found` |
| 8765 冲突来源 | `D:\code\yunxiao\zhishu\search\.env` = `HOST=127.0.0.1 / PORT=8765`，且 `search\start.ps1` 是**守护循环**（每 10 秒探测端口、没开就重启 `run.py`）⇒ 结构冲突，不是临时占用 |
| dev 网关为何没起 | `zhishu\web-start.log` 尾部：Next 曾在 3100 Ready，随后 `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] zhishu-web@0.1.0 start: next start -p 3100`，`Exit status 4294967295` ⇒ 进程已退出 |
| 本机宿主 | 注册表 `HKCU\...\NativeMessagingHosts\com.yunxiao.xprobe` **有**；`native\dist\xprobe-host.exe` 在（11-12 23:29 重打，sink-19）；`native-host.log` 18 MB、08:51 仍在写 |
| 本机库 | `D:\code\yunxiao\temp\xprobe\xprobe.db` **1.4 GB**，08:52 仍在写；日志 `store 表=600人/1200帖`、`dayrow ... 落库`、`follow[tweet]` 持续到 08:51 |
| 宿主直连实测 | `{t:'ping'}` → `sink-19` / `db.available=true`；`{t:'db',q:'tl_rank',limit:3}` → 0.9s 出数；**`{t:'db',q:'accounts',limit:3}` → 25 秒超时** |
| 本机库查询耗时 | `accounts 500` = **41.18s**；`follow_starts 200` = **9.09s**；posts_top 5.16s、posts_growth 5.20s、tl_days 1.17s、tl_rank 0.92s。SW `dbq` 超时 = **8 秒** ⇒ accounts / follow_starts 必超时。`account_latest` 是无索引聚合 VIEW（xprobe_db.py 注释里已记「870MB 真库 JOIN 20 行要 15 秒」） |

## 结论：三条链路各自的病

1. **本地 db 的「通道」其实没断**：宿主注册、exe、日志、1.4 GB 库全都在正常工作。面板报「宿主未注册 + sink 未启动」是**误诊**——用户当时在**云端档**，云端 fetch 失败的错误串是 `云端没连上：Failed to fetch（http://localhost:3100）`，`view.js dbStateRow` 的 `down` 正则只要见 `Failed to fetch` / `not found` 就一刀切成那句话；`db.via` 又没带回来，所以显示「通道 未定」。
2. **dev 云端整条链断**：3100（zhishu-web 网关）和 8080（Go）都没起 ⇒ 所有云端请求 `Failed to fetch`；「已登录」只是 chrome.storage 里的 token 缓存，**不代表链路通**。登录时触发的四条上送腿（ingest / bench / library / block）也打 3100 ⇒ 全量推没跑成 ⇒ 智枢 PG 里没有本机存量 ⇒ 看起来「数据都丢了」。
3. **「云端暂无」是设计留账被撞上**：`fetchDb` 一次发 6 条查询（accounts / posts_top / posts_growth / tl_days / tl_rank / follow_starts），`CLOUD_MAP` 只对齐了 4 个名字（accounts / follow_starts / day_rows / author_posts）⇒ **posts_top / posts_growth / tl_days / tl_rank 四条连请求都不发**，直接返回「云端暂无」。`view.js` 把它显示成「时间线曝光排序：查询失败：云端暂无」。即使 dev 起来了，广场页帖子榜/时间线照样空。
4. **本地库档还有个隐藏病**：`accounts` 41s / `follow_starts` 9s 超过 SW 的 8s 超时 ⇒ 切回本地库档，账号榜和未回关榜也读不出来；8765 被占又断了 HTTP 回退路（但 native 通道本来就优先，回退路断不是主因）。

## 本轮修的（只动扩展侧，v0.12.18）

- `extension/ui/view.js` `dbStateRow`：诊断按层分家——云端失败点名「云端档没连上（含地址）· 通道 云端」；`回包不是 JSON / Not Found` 点名「8765 回的不是探针 sink（端口被占）」；`8 秒没回` 点名「本机库聚合视图慢，不是通道断」；**只有真的两条本机通道都无应答**才保留「两个通道都没通（宿主未注册 + sink 未启动）」。原有双向对照判据继续过。
- `extension/ui/dashboard.js`：`CLOUD_NO(q)` 文案点名是哪条查询没对齐 + 指向 API-CONTRACT §2.3（`云端暂无：tl_rank 这条读口还没对齐…`）；云端查询失败也回带 `via:'cloud'`（不再「通道 未定」）；删掉 `dashSrc === 'go' && !goUrlOk` 死代码（v0.12.15 改 cloud 后遗留、变量已不存在）；登录弹窗去掉退役的 boot4 措辞。
- 版本戳六处 `0.12.18 / 2026-11-13-b`。
- 判据：原有 2 条通道判据保留，新增 3 条（云端失败不误报 / 8765 被占不误报 / 失败回包带 via），[42] 的 CLOUD_NO 文案判据同步。

## 验证

`node -c` 全过 · `probe-selftest.js` **1860/0** · `db-selftest.py 232/0` · `exe-check.py 45/0` · CRLF 保持 · 只改扩展侧 JS ⇒ **无需重打 exe**（RL-12）。备份 `%TEMP%/xprobe-bak-20261113-diag/`。

## 待拍板（没动手，按红线先出卡）

1. **8765 端口冲突**：改 zhishu search 的端口，或改探针 sink 的端口（后者要动 RL-33 的 3 个 baseURL 契约、manifest、SW DB_URL、core SINK、判据与文档）。`search/start.ps1` 有守护循环，光杀进程会自动重启。
2. **本地库慢查询**：给 `account_latest` 物化/加索引或改 SQL（动本机库 schema = 写库）；或放宽 SW dbq 超时（体验差）。当前 41s vs 8s。
3. **云端补齐 4 条读口**：按 RL-33 两边同趟加（zhishu Go 的 `x_routes.go` + `log-sink.py XPROBE_READ_ROUTES` + `CLOUD_MAP` + API-CONTRACT 清单 + 判据），跨仓库写。
4. **全量推存量到 PG**：dev/Go 起来后重跑四条上送腿 + 对账行；Go ack 字段形状与旧 boot4 是否同形，真机对一版。

## 契约与实现的一处不一致（如实留账，没擅自改）

API-CONTRACT 写「页面唯一请求函数 qRead、只换 baseURL」，但 `one()` 的**本地档实际走 SW `dbq`（优先 native，失败回退 HTTP GET /db）**，`qRead` 的 `!cloud` 分支目前不可达。改动会绕过健康的 native 通道、反而更慢更易断；下轮按契约正式收口时再一起改（判据两边同趟）。

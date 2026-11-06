#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""X 观测探针的本地日志接收端。

浏览器里的暴力猴脚本把页面快照/选择器漏抓/报错 POST 到 http://127.0.0.1:8765/log，
本脚本原样落到数据目录（默认见 DEFAULT_DIR：XPROBE_DIR 环境变量 → 作者机器历史目录 → ~/xprobe）。
调试转储（面板上「调试转储」开关）另走 POST /dump，落 dump/<时间-页型-handle>/ 的
tree.txt + text.txt (+ page.html) + meta.json，不进日志记录流；测试流量落 dump-test/。

用法:  python -X utf8 log-sink.py [--port 8765] [--dir <数据目录>]
停止:  Ctrl+C，或关掉窗口。只绑 127.0.0.1，不对外网开放。

sink-9 起多一本本机档案库 xprobe.db（stdlib sqlite3，见 xprobe_db.py）：浏览器那边
chrome.storage.local 只有 10MB 配额，整页原文装不下（实测 400 份快照 13.05MB，配额一满
连守卫台账都写不进去），所以从这版起「原文进库、浏览器只留运行态」。读法：GET /db?q=recent
档案库只收真机记录（t=0），而且写失败绝不打断 ndjson 落盘 —— 日志是现场，库是档案。

sink-10 是「让断线看得出来」那一版：队列落到扩展存储以后，日志里多了 kind=sink 的断开/恢复事件；
摘要行在记录迟到超过 120 秒时补「迟到=Ns」（上一轮那 13 条压了 179~252 秒，只能靠 at 和 receivedAt
对差猜出来）；page 行开始打逐指标 aria 来源表（聚合/独立/按钮），store 行按「带数字/纯见过」两组打，
beacon 行带上队列长度、落盘条数与表顶状态。

sink-11 = sink-10 + v0.6.8/0.6.9 那两条摘要的接梗：follow 行末补「本轮全=Ns（加时+Ns）」（随机加时
要能在日志里对账），新增 kind=debug 的摘要行（调试页/开机自报的那一眼，翻日志不用开面板）。

sink-12 = sink-11 + 补录四列：kind=reward 的小「手动」行走独立摘要 `reward[手动] @own day 四列 value=x/fow=x/fans=x/posts=x 落库|同值覆盖`
——装插件之前的日子靠面板把历史四列补进来，日志与日点表要能逐列对上。

sink-13 = sink-12 + 「每人每天一行」：新表 day_rows（键 = handle+day，不是只有登录者）与视图 day_latest（**按列各取最后一次有数的**，
不是整行取最新），kind=reward 双写一份进去，新增 kind=dayrow（打开谁的主页就落谁的一行）走 `dayrow @handle day 四列 …` 摘要；
/db 白名单多两条 `day_rows`（逐日逐人）与 `rank`（每人最新一行，按关注排）。/ping 的 db 段多一个 `dayRows` 计数。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import xprobe_db as xdb
except Exception as _xdb_e:      # 库模块坏了不能把日志接收端一起带倒
    xdb = None
    sys.stderr.write("档案库模块导入失败，只落 ndjson: %s\n" % _xdb_e)

try:
    import xprobe_fs as xfs
except Exception as _xfs_e:      # 同上：清理模块坏了，接收端照常收日志，只是面板那行显示「清理模块没导入」
    xfs = None
    sys.stderr.write("占用/清理模块导入失败: %s\n" % _xfs_e)

def _default_dir() -> Path:
    # 数据目录：XPROBE_DIR 环境变量 → 作者机器的历史目录（存在就沿用，老数据不断档）→ 用户目录 ~/xprobe。
    # 不能写死盘符：别人 clone 到的机器上没有 D: 时，接收端会在建目录那一步死掉。
    env = os.environ.get("XPROBE_DIR")
    if env:
        return Path(env)
    legacy = Path(r"D:\code\yunxiao\temp\xprobe")
    return legacy if legacy.parent.exists() else Path.home() / "xprobe"


DEFAULT_DIR = _default_dir()
DEFAULT_PORT = 8765
MAX_BODY = 8 * 1024 * 1024
MAX_DUMP_BODY = 64 * 1024 * 1024   # 整页转储比记录大两个量级，单独放宽，别把 tree 截断成半份现场
SINK_VER = "sink-18"   # v0.9.7：/db 认 after（台账 id 游标），标杆同步走的是这条腿；旧进程不认 ⇒ 每次从头推，服务端唯一键去重

_SAFE_RE = re.compile(r"[^A-Za-z0-9_.-]")
_lock = threading.Lock()
CFG = {"dir": DEFAULT_DIR}
STATS = {"day": "", "startedAt": "", "total": 0, "testTotal": 0, "dumpTotal": 0, "dumpTestTotal": 0,
         "byKind": {}, "lastSeenAt": "", "lastUrl": "", "lastDumpAt": "", "doubleHostUrls": 0, "recent": []}

# 同一个 URL 被两个宿主各采一次 ⇒ 守卫台账被劈成两份（GM 存储与 chrome.storage.local 各数各的）。
# 真机 2026-10-22：13:41:56.598 ver=0.3.0 与 13:41:56.794 ver=0.5.0 打的是同一页。
HOST_SEEN: dict = {}
DOUBLE_WARNED: dict = {}


def _safe(s, default: str, maxlen: int) -> str:
    # 目录名一部分来自浏览器发来的字符串：只留白名单字符并去掉开头的点，防目录穿越
    out = _SAFE_RE.sub("", str(s or ""))[:maxlen].lstrip(".")
    return out or default


def _db_open() -> bool:
    if xdb is None:
        return False
    try:
        return xdb.open_db(CFG["dir"] / "xprobe.db")
    except Exception as e:
        sys.stderr.write("[%s] 档案库打开失败，只落 ndjson: %s\n" % (_now(), e))
        return False


def _db_ingest(rec: dict, summ: str) -> None:
    if xdb is None:
        return
    try:
        xdb.ingest(rec, summ)
    except Exception as e:      # ingest 自己吞异常，这里再兜一层：档案绝不能拖累现场
        sys.stderr.write("[%s] 档案库写入异常: %s\n" % (_now(), e))


def _db_slim() -> dict:
    """给 /ping 用的几行数：库在不在线、多大、最新一条到什么时候。别把整份 stats 灌进面板。"""
    if xdb is None:
        return {"available": False, "err": "xprobe_db.py 没能导入"}
    try:
        s = xdb.stats()
        t = s.get("tables") or {}
        return {"available": bool(s.get("available")), "bytes": s.get("bytes"), "err": s.get("err"),
                "dbVer": s.get("dbVer"), "path": s.get("path"),
                "records": t.get("records", 0), "snapshots": t.get("snapshots", 0),
                "tweets": t.get("tweets", 0), "userRows": t.get("user_rows", 0),
                "follows": t.get("follow_events", 0), "statPoints": t.get("stat_points", 0),
                "rewardPoints": t.get("reward_points", 0), "dayRows": t.get("day_rows", 0),
                "storeUsers": t.get("store_users", 0),
                "storePosts": t.get("store_posts", 0), "dumps": t.get("dumps", 0),
                "freeBytes": s.get("freeBytes"),
                "minAt": s.get("minAt"), "maxAt": s.get("maxAt")}
    except Exception as e:
        return {"available": False, "err": str(e)}


def _vacuum_fn():
    """把 xprobe_db.vacuum 包成「调用方不必知道库存在」的样子：模块没导入就回一句实话。"""
    if xdb is None:
        return {"ok": False, "err": "xprobe_db.py 没能导入"}
    return xdb.vacuum()


def _free_fn():
    if xdb is None or not hasattr(xdb, "free_bytes"):
        return None
    return xdb.free_bytes()


def fs_body(auto=True) -> dict:
    """GET /fs 与宿主 {t:'fs', op:'sizes'} 共用：报数据目录的占用、可清量与保留策略。
    auto=True 时顺带撞一次「每天最多一次」的自动清理 —— 自动清理靠这个 hook 就能落地，
    不需要我再开一个常驻定时器或多起一个进程；面板每次进「设置」读占用，正好把它带上。"""
    if xfs is None:
        return {"ok": False, "err": "xprobe_fs.py 没能导入（清理与占用测量不可用）"}
    if auto:
        try:
            xfs.auto_clean_due(CFG["dir"])
        except Exception as e:
            sys.stderr.write("[%s] 自动清理异常: %s\n" % (_now(), e))
    try:
        return xfs.fs_body(CFG["dir"], free_fn=_free_fn)
    except Exception as e:
        return {"ok": False, "err": "测量异常: %s" % e}


def clean_body(req: dict) -> dict:
    """POST /fs 与宿主 {t:'fs', op:...} 共用：删日志/删转储/整理库/改保留策略。
    参数只有 op / target / keep / dry 四个，路径由 CFG["dir"] 与模块里的白名单决定 ——
    浏览器传不进路径，这是这件事唯一的安全边界。"""
    if xfs is None:
        return {"ok": False, "err": "xprobe_fs.py 没能导入（清理与占用测量不可用）"}
    req = req if isinstance(req, dict) else {}
    op = str(req.get("op") or "clean")
    if op == "vacuum":
        if req.get("dry", True):
            fb = _free_fn()
            return {"ok": True, "fs": getattr(xfs, "FS_VER", "?"), "op": "vacuum", "dry": True,
                    "free": fb, "freeMb": round((fb or 0) / 1048576.0, 1),
                    "note": "DRY：只量空闲页，没执行 VACUUM（一行数据都不会动）"}
        return dict({"op": "vacuum"}, **_vacuum_fn())
    if op == "auto":
        try:
            return dict({"ok": True, "op": "auto"}, **xfs.auto_clean_due(CFG["dir"], vacuum_fn=None))
        except Exception as e:
            return {"ok": False, "err": "自动清理异常: %s" % str(e)[:100]}
    if op == "conf":
        return xfs.clean_body(CFG["dir"], req)
    # 拼错的 op 不许继承「实删」的意图：只有明确 op=clean 时才认 dry=false，
    # 其余一律按 DRY 回显 —— 一个字段打错换来一次真删，这种账不该由本机承担
    return xfs.clean_body(CFG["dir"], {"op": "clean", "target": req.get("target"), "keep": req.get("keep"),
                                       "dry": True if op != "clean" else req.get("dry", True)})


def ping_body() -> dict:
    """HTTP /ping 与 Native 宿主共用的同一份回包 —— 面板看到的数不该因为走了哪条通道而变。"""
    with _lock:
        snap = dict(STATS)
    return {"ok": True, "sink": SINK_VER, "dir": str(CFG["dir"]),
            "now": datetime.now().isoformat(timespec="seconds"),
            "total": snap["total"], "testTotal": snap.get("testTotal", 0),
            "byKind": snap["byKind"],
            "dumpTotal": snap["dumpTotal"], "dumpTestTotal": snap["dumpTestTotal"],
            "lastSeenAt": snap["lastSeenAt"], "db": _db_slim()}


def db_body(name: str, limit: int, day: str = None, author: str = None,
            hours: int = None, win: tuple = None, after: int = None) -> tuple:
    """白名单查询，返回 (HTTP 码, 回包)。名字与 limit 都已经由调用方夹过一遍。
    hours / win 只给 tl_win 用（时间窗历史榜），形状照样由 xprobe_db.query 再验一遍。
    after 只给 bench_marks_ac / bench_marks_po 那两条台账流水用（上云增量的 id 游标），形状由 query 再验。"""
    if xdb is None:
        return 500, {"ok": False, "err": "xprobe_db.py 没能导入"}
    try:
        out = xdb.query(name, limit, day, author, hours, win, after)
    except Exception as e:
        out = {"ok": False, "err": "query 异常: %s" % e}
    return (200 if out.get("ok") else 400), out


def _db_dump(name: str, meta: dict) -> None:
    if xdb is None:
        return
    try:
        xdb.record_dump(name, meta)
    except Exception as e:
        sys.stderr.write("[%s] 档案库转登记异常: %s\n" % (_now(), e))


def _load_stats() -> None:
    # 按天分桶、跨重启累计：不然每次重开 sink，state.total 归零，我没法用「本轮 +N」做对照
    day = _today()
    STATS["day"] = day
    STATS["total"] = 0
    STATS["testTotal"] = 0
    STATS["dumpTotal"] = 0
    STATS["dumpTestTotal"] = 0
    STATS["byKind"] = {}
    try:
        obj = json.loads((CFG["dir"] / "stats.json").read_text(encoding="utf-8"))
        if obj.get("day") == day:
            STATS["total"] = int(obj.get("total") or 0)
            STATS["testTotal"] = int(obj.get("testTotal") or 0)
            STATS["dumpTotal"] = int(obj.get("dumpTotal") or 0)
            STATS["dumpTestTotal"] = int(obj.get("dumpTestTotal") or 0)
            STATS["byKind"] = dict(obj.get("byKind") or {})
    except Exception:
        pass


def _save_stats() -> None:
    try:
        (CFG["dir"] / "stats.json").write_text(json.dumps(
            {"day": STATS["day"], "total": STATS["total"], "testTotal": STATS.get("testTotal", 0),
             "dumpTotal": STATS.get("dumpTotal", 0), "dumpTestTotal": STATS.get("dumpTestTotal", 0),
             "byKind": STATS["byKind"]},
            ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        sys.stderr.write("stats.json 写入失败: %s\n" % e)


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _emit(line: str, say=None) -> None:
    """人读的那行写给谁。HTTP 模式下是 stdout（cmd 窗口里能看）；Native 宿主模式下 stdout 是
    协议通道，绝不能掺一行日志进去 —— 所以调用方传 say=文件。"""
    out = say or sys.stdout
    try:
        out.write(line)
        out.flush()
    except Exception:
        pass


def _double_host(rec: dict) -> str:
    """两个宿主在同一页各采一次 ⇒ 立刻说一次，别让它变成「日志翻倍但我不知道为什么」。"""
    url = str(rec.get("url") or "")
    host = str(rec.get("host") or "")
    peer = str(rec.get("peer_host") or "")
    if not url or not host:
        return ""
    now = datetime.now().timestamp()
    hist = [(t, h) for (t, h) in HOST_SEEN.get(url, []) if now - t <= 120]
    hist.append((now, host))
    HOST_SEEN[url] = hist[-8:]
    hosts = {h for (_, h) in hist}
    if len(hosts) < 2 and not peer:
        return ""
    if now - DOUBLE_WARNED.get(url, 0) < 600:
        return ""
    DOUBLE_WARNED[url] = now
    STATS["doubleHostUrls"] = STATS.get("doubleHostUrls", 0) + 1
    return "[%s] ⚠双宿主同页 %s: %s ⇒ 采集重复、关注守卫的两份台账(15分钟15/24小时400)各数各的，警告会少报一半；处理：暴力猴里停用旧脚本，只留扩展\n" % (
        _now(), url[:90], "/".join(sorted(hosts | ({peer} if peer else set()))))


def _late(rec: dict) -> str:
    """记录自带的 at 与收到的时刻差太久 ⇒ 在摘要行上点名。

    sink 断线时这一串记录会一次性补进来，看日志的人（就是我）第一反应是「这些是刚发生的吗」。
    不是：它们是压在一个内存队列里等恢复的。不写出来的话，下一轮我会按「实时」去解读一份迟到几分钟的现场。
    """
    try:
        a = datetime.fromisoformat(str(rec.get("at"))[:26])
        r = datetime.fromisoformat(str(rec.get("receivedAt"))[:26])
        sec = int((r - a).total_seconds())
    except Exception:
        return ""
    return " 迟到=%ss" % sec if sec > 120 else ""


def _summ(rec: dict) -> str:
    kind = rec.get("kind", "?")
    url = rec.get("url", "")
    if kind == "page":
        d = rec.get("data", {})
        ident = d.get("identity", {})
        cov = rec.get("cov") or d.get("cov", {})
        miss = rec.get("miss") or []
        # v0.8.2：主页时间线 tab（foryou/following）打在摘要行上——某天时间线曝光排序的口径就靠它
        tl = d.get("tlSrc") or ""
        cu = rec.get("covUsers") or d.get("covUsers", {})
        extra = (" tl=" + tl) if tl else ""
        if rec.get("userRows") or cu.get("rows"):
            extra = " 用户行=%s handle=%s 关系=%s 名称=%s%s 取域=%s" % (
                cu.get("rows", "-"), cu.get("handle", "-"), cu.get("follow", "-"),
                cu.get("name", "-"), json.dumps(cu.get("nameHow", {}), ensure_ascii=False, separators=(",", ":")), rec.get("usersScope", "-"))
            # v0.6.2：名字有抠不到的行时，把第一行的「候选出处」打在摘要行上。
            # 这一轮要回答的是「名字到底长在哪个节点」，答案就在 cands 里，不该逼人去翻 ndjson
            nm = str(cu.get("name", ""))
            if "/" in nm and nm.split("/", 1)[0] != nm.split("/", 1)[1]:
                for u in (d.get("users") or []):
                    if u.get("cands"):
                        extra += " 候选@%s=%s" % (u.get("handle", "-"),
                                                  json.dumps(u["cands"], ensure_ascii=False, separators=(",", ":"))[:200])
                        break
        if rec.get("hydrated") is False:
            extra += " [未水合]"
        if rec.get("attempt") and rec.get("attempt") != 1:
            extra += " [补采第%s枪]" % rec.get("attempt")
        note = rec.get("note") or []
        if note:
            extra += " note=" + ",".join(note)
        # 名字这条是「剥注入」的对照位：脏值与命中的 class token 都在一行里，误剥当场看得出来
        if ident.get("hasHeader"):
            extra += " 名=%r/%r nf=%s ftok=%s%s" % (
                ident.get("displayName", ""), ident.get("displayNameDirty", "")[:40],
                ident.get("nameForeign", 0),
                json.dumps(ident.get("nameTokens") or {}, ensure_ascii=False, separators=(",", ":")),
                " [剥空回退]" if ident.get("nameStripAll") else "")
        # 奖励页那一块：page 记录里带 rewards，摘要行直接把「取到几个、扣掉门槛后剩几个」打出来
        rw = d.get("rewards")
        if rw:
            cn = ((rw.get("cands") or [{}])[0]).get("nums") or []
            extra += " 曝光=%s(%s) 候选节点=%s 区域数字=%s" % (
                rw.get("value") if rw.get("hit") else "-",
                "精确" if rw.get("exact") else ("缩写" if rw.get("hit") else "无"),
                rw.get("keyNodes", "-"),
                json.dumps([n.get("token") for n in cn[:6]], ensure_ascii=False, separators=(",", ":"))[:80])
        # v0.6.9：指标的「数从哪个节点来」必须打在摘要行上。上一版把聚合 aria（「42 回复、24 喜欢、400 次观看」）
        # 和每行独立的单指标 aria（「2 次观看」）都打成 summaryAria，于是同一行日志里 14/25 与 25/25 自相矛盾，
        # 还害我把「详情页观看数的真来源是独立 aria」这条判据读丢。src 就是那张逐指标的来源计数表。
        src = cov.get("src") or {}
        if src:
            lab = {"combinedAria": "聚合", "singleAria": "独立", "buttonAria": "按钮"}
            extra += " 来源=" + " ".join(
                "%s:%s" % (k, "/".join("%s%s" % (lab.get(f, f), n) for f, n in sorted(src[k].items())))
                for k in ("reply", "repost", "quote", "like", "view") if src.get(k))
        return "page[%s] %s @%s articles=%s 广告=%s id=%s time=%s like=%s view=%s rel=%s miss=%s%s" % (
            rec.get("tabType") or d.get("tab") or "-",
            ("%s%s" % (rec.get("host") or "-", ("/" + rec["peer_host"]) if rec.get("peer_host") else "")),
            ident.get("handle") or "-", len(d.get("tweets") or []),
            cov.get("ads", "-"),
            cov.get("tweetId", "-"), cov.get("timeDatetime", "-"), cov.get("like", "-"), cov.get("view", "-"),
            ident.get("followRelation") or "-",
            ",".join(miss) if miss else "-", extra)
    if kind == "probe":
        d = rec.get("data", {})
        return "probe article=%s userCell=%s/%s(正文列) tweetTestid=%s testids=%s aria带数字=%s 锚点=%s 关注按钮=%s 第三方注入=%s %s" % (
            d.get("articleCount", "-"), d.get("userCellInPrimary", "-"), d.get("userCellCount", "-"),
            d.get("tweetTestidCount", "-"), len(d.get("testids", {})),
            d.get("ariaNumberCount", "-"), len(d.get("statsAnchors", [])),
            len(d.get("followButtons", [])), d.get("foreignBadges", "-"),
            json.dumps(d.get("foreignClasses") or {}, ensure_ascii=False, separators=(",", ":")))
    if kind == "follow":
        d = rec.get("data", {})
        # v0.6.4：规则是「关注后至少 60 秒才做下一个」，日志里就得能看出这一次间隔了多少秒、有没有踩线
        gap = d.get("gap")
        gap_s = "" if gap is None else " 距上次=%ss" % (round(gap / 1000.0, 1))
        return "follow[%s] @%s id=%s %s 15分钟=%s/%s 24小时=%s/%s 判据=%s%s%s%s" % (
            rec.get("tab") or "-", d.get("handle") or "-", d.get("targetId") or "-",
            d.get("dir") or "-", d.get("w15", "-"), d.get("max15", "-"), d.get("w24", "-"), d.get("max24", "-"),
            d.get("from") or d.get("why") or "-",
            " [可疑]" if d.get("suspect") else "",
            " 已满" if (d.get("over15") or d.get("over24")) else "",
            ((gap_s + (" [60秒内!]" if d.get("rapid") else "")) if d.get("dir") == "follow" else "") +
            (((" 本轮全=%ss" % (d.get("cool") // 1000)) +
              ("（加时+%ss）" % d.get("rnd") if d.get("rnd") else "")) if d.get("dir") == "follow" and d.get("cool") else ""))
    if kind == "stat":
        d = rec.get("data", {})
        return "stat[%s] @%s 正在关注=%s 粉丝=%s %s" % (
            d.get("reason") or "-", d.get("handle") or "-", d.get("following", "-"),
            d.get("followers", "-"), "精确" if d.get("exact") else "含缩写")
    if kind == "store":
        d = rec.get("data", {})
        c = d.get("counts", {})
        us = d.get("users") or []
        ps = d.get("posts") or []
        g = d.get("groups") or {}
        tm = d.get("trim") or {}
        # core 已经把切片改成「带数字的行优先」。旧写法按 updatedAt 排 ⇒ 纯见过的行不断把带粉丝数的行
        # 挤出这 12 格（真机 2026-10-23 实测：同一张表，带数行从 7/12 掉到 5/12），分没分清一眼就要看出来
        un = [u for u in us if u.get("sn")]
        ub = [u for u in us if not u.get("sn")]
        pn = [p for p in ps if p.get("sn")]
        pb = [p for p in ps if not p.get("sn")]
        # 「这轮没报 sn」与「报了、确实全是纯见过的行」是两件事，别混成一句 (空)（旧记录走前者）
        sn_u = any("sn" in u for u in us)
        sn_p = any("sn" in p for p in ps)
        head = " ".join("%s:%s/%s" % (u.get("h"), u.get("f"), u.get("fw")) for u in un[:4])
        # 没有 sn 时不许把全部行打进「纯见」栏 —— 那会把带粉丝数的行说成没带数（正是这一版要修的那类误读）
        bare = " ".join(u.get("h") for u in ub[:4]) if sn_u else ""
        phead = " ".join("%s:看%s/赞%s" % (p.get("h") or p.get("id"), p.get("vw"), p.get("lk")) for p in pn[:3])
        ser = c.get("series") or {}
        return "store 表=%s人/%s帖 组=有人数%s/纯见%s 帖有数%s/纯见%s 序列=%smin/%sday 带数 %s 纯见 %s 帖 %s%s%s" % (
            c.get("users", "-"), c.get("posts", "-"),
            g.get("uNum", "-"), g.get("uBare", "-"), g.get("pNum", "-"), g.get("pBare", "-"),
            ser.get("min", 0), ser.get("imp", 0),
            head or ("(空)" if sn_u else "(旧记录未报来源)"), bare or "-",
            phead or ("(空)" if sn_p else "(旧记录未报来源)"),
            (" 顶满" if (tm.get("usersFull") or tm.get("postsFull")) else ""),
            (" 删旧=%s人/%s帖" % (tm.get("usersDropped", 0), tm.get("postsDropped", 0))
             if (tm.get("usersDropped") or tm.get("postsDropped")) else ""))
    if kind == "reward":
        # v0.6.3：这一页的判据还是「宽松取数」，摘要行必须把候选摊开——我要看的是
        # 「区域里有几个数字、门槛那个数在不在里面」，据此下一轮收窄成一条判据
        d = rec.get("data", {})
        if d.get("manual"):
            # v0.6.9 收尾：面板补录行带四列（曝光/关注/粉丝/帖子），哪列填了哪列空一眼可见 ——
            # 「装插件之前的日子」就靠这口补历史，日志里得能对上表格
            cols = "/".join("%s=%s" % (k, "-" if d.get(k) is None else d.get(k))
                            for k in ("value", "fow", "fans", "posts"))
            return "reward[手动] @%s %s 四列 %s %s" % (
                d.get("own") or "-", d.get("day") or "-", cols,
                "落库" if d.get("added") else "同值覆盖")
        cs = (d.get("cands") or [{}])[0]
        nums = cs.get("nums") or []
        return "reward @%s %s 曝光=%s(%s) %s%s 关键词节点=%s 门槛=%s 区域数字=%s%s" % (
            d.get("own") or "-", d.get("day") or "-",
            # 判否那一条不许写 None(缩写)：我扫这些行是在挑判据，值栏空着才看得出来是「没抠到」而不是「抠到 0」
            d.get("value") if d.get("hit") else "-",
            "精确" if d.get("exact") else ("缩写" if d.get("hit") else "无"),
            "落库" if d.get("added") else ("同值覆盖" if d.get("hit") else "没抠到"),
            "[补录]" if d.get("token") == "manual" else "",
            d.get("keyNodes", "-"),
            json.dumps(cs.get("threshold") or [], ensure_ascii=False, separators=(",", ":"))[:40],
            json.dumps([n.get("token") for n in nums[:6]], ensure_ascii=False, separators=(",", ":"))[:70],
            "" if d.get("hit") else " 关键词=%r" % (d.get("key") or "")[:40])
    if kind == "dayrow":
        # v0.6.11：「每人每天一行」的自动腿 —— handle 是**被看的那个人**，不是登录者 own。
        # 摘要照样把四列摊开：别人那一行曝光永远是 -（只有自己的奖励页有曝光数），看不清这点就会误判成漏采。
        d = rec.get("data", {})
        cols = "/".join("%s=%s" % (k, "-" if d.get(k) is None else d.get(k))
                        for k in ("value", "fow", "fans", "posts"))
        return "dayrow @%s %s 四列 %s %s%s" % (
            d.get("handle") or d.get("own") or "-", d.get("day") or "-", cols,
            "落库" if d.get("added") else "同值覆盖",
            " 手补" if d.get("manual") else " 自动(%s)" % (d.get("source") or "profile"))
    if kind == "debug":
        # v0.6.8：调试页的内容面板每开一次就落一份。摘要给个一眼账，全量在 ndjson/xprobe.db 的记录里
        d = rec.get("data", {})
        g = d.get("guard") or {}
        cnt = d.get("counters") or {}
        caps = d.get("caps") or {}
        st_ = d.get("storage") or {}
        env = d.get("env") or {}
        return "debug[%s] @%s 折算=%s/十五分钟=%s/%s tf=%s/%s 上限=%s秒 存=%.1fKB 表=%s人/%s帖 快照=%s sink=%s(%s待发)" % (
            env.get("tab") or rec.get("tab") or "-",
            env.get("own") or "-", env.get("peer") or "-",
            g.get("f15", "-"), g.get("max15", "-"), g.get("f24", "-"), g.get("max24", "-"),
            caps.get("rndMax", "-"),
            (st_.get("total") or 0) / 1024.0,
            cnt.get("users", "-"), cnt.get("posts", "-"), cnt.get("runs", "-"),
            "OK" if d.get("sink", {}).get("ok") else "断开",
            d.get("sink", {}).get("qlen", "-"))
    if kind == "sink":
        # v0.6.9：断线本身要成一条记录。以前 sink 挂了只在恢复以后留下一串「迟到的行」，
        # 我读日志得不出「这段时间有多长、攒了多少、有没有丢」——而这正是下一轮要不要动队列判据的依据
        d = rec.get("data", {})
        if d.get("ev") == "up":
            return "sink[恢复] 断线=%ss 补发队列=%s条/%.0fKB 认领旧格=%s 顶掉=%s" % (
                round((d.get("offlineMs") or 0) / 1000.0), d.get("qlen", "-"),
                (d.get("qbytes") or 0) / 1024.0, d.get("qadopted", 0), d.get("qdropped", 0))
        return "sink[断开] 队列=%s条/%.0fKB 顶掉=%s 错误=%s" % (
            d.get("qlen", "-"), (d.get("qbytes") or 0) / 1024.0, d.get("qdropped", 0), d.get("err") or "-")
    if kind == "err":
        return "err %s" % str(rec.get("msg") or rec.get("data", {}).get("msg", ""))[:160]
    if kind == "beacon":
        d = rec.get("data", {})
        q = d.get("q") or {}
        st_ = d.get("store") or {}
        tm = d.get("trim") or {}
        return "beacon %s%s ver=%s build=%s gm=%s dump=%s 观察=%s 已关注15m/24h=%s/%s 表=%s人/%s帖 序列=%s 队列=%s%s%s 存=%.1fKB%s" % (
            d.get("host") or rec.get("host") or "-",
            ("/" + (d.get("peer") or rec.get("peer_host") or "")) if (d.get("peer") or rec.get("peer_host")) else "",
            d.get("ver"), d.get("build"), d.get("hasGmXhr"), d.get("dump"), d.get("watch"),
            d.get("f15", "-"), d.get("f24", "-"), d.get("users", "-"), d.get("posts", "-"),
            d.get("series", "-"),
            q.get("len", 0),
            ("（认领旧格%s条）" % d.get("qback") if d.get("qback") else ""),
            (" 落盘%s条/丢%s/断线%ss" % (q.get("count"), q.get("dropped"), round((q.get("down") or 0) / 1000.0))
             if (q.get("count") or q.get("dropped") or q.get("down")) else ""),
            (st_.get("bytes") or 0) / 1024.0,
            (" ⚠存写失败:%s" % st_.get("lastErr") if st_.get("lastErr") else "") +
            (" 表顶满:%s人%s帖" % (tm.get("usersKept"), tm.get("postsKept")) if (tm.get("usersFull") or tm.get("postsFull")) else ""))
    if kind == "bench":
        # v0.9.0 标杆：进/出/改标签三种动作都走这一条记录。摘要必须把「谁、进还是出、什么标签」打出来——
        # 落到末尾那个通用兜底就只剩一个 URL，以后想知道「这批标签哪轮改的」只能翻原始记录（RL-11 同族）。
        d = rec.get("data", {})
        tg = d.get("tags")
        tg = ",".join(str(x) for x in tg) if isinstance(tg, (list, tuple)) else str(tg or "")
        return "bench @%s %s tags=%s" % (
            d.get("handle") or rec.get("handle") or "-",
            "标为标杆" if d.get("on") else "移出标杆", (tg[:80] or "-"))
    if kind == "benchpost":
        # v0.9.3 标杆帖子：摘要要能一眼看出「哪条帖子进/出」——tweet id 是这本账的主键，
        # 没有它这行就只剩一个 URL，以后想知道「这条我什么时候标的」只能翻原始记录（RL-11 同族）。
        d = rec.get("data", {})
        return "benchpost %s %s@%s %s" % (
            (str(d.get("id") or "")[:25] or "-"),
            "标为标杆帖" if d.get("on") else "移出标杆帖",
            d.get("author") or "-", (str(d.get("text") or "").replace("\n", " ")[:40] or "-"))
    return "%s %s" % (kind, url[:120])


def _handle_payload(body: bytes, peer: str, say=None) -> int:
    try:
        parsed = json.loads(body.decode("utf-8"))
    except Exception as e:  # 落原始字节，别让一次坏包把日志流打断
        with _lock:
            bad = CFG["dir"] / "bad-POST.log"
            bad.parent.mkdir(parents=True, exist_ok=True)
            with open(bad, "ab") as f:
                f.write(b"\n===== %s %s err=%s =====\n" % (datetime.now().isoformat().encode(), peer.encode(), str(e).encode()))
                f.write(body[:MAX_BODY])
        return 1
    recs = parsed.get("records") if isinstance(parsed, dict) else None
    if not isinstance(recs, list):
        recs = [parsed if isinstance(parsed, dict) else {"kind": "raw", "data": parsed}]
    script_ver = parsed.get("ver") if isinstance(parsed, dict) else None
    env_host = parsed.get("host") if isinstance(parsed, dict) else None
    env_peer = parsed.get("peer") if isinstance(parsed, dict) else None

    n = 0
    with _lock:
        d = CFG["dir"]
        d.mkdir(parents=True, exist_ok=True)
        if STATS.get("day") != _today():
            _load_stats()
        ndjson = d / "logs" / ("%s.ndjson" % _today())
        ndjson.parent.mkdir(parents=True, exist_ok=True)
        human = d / ("xprobe-%s.log" % _today())
        # 自检脚本发的记录带 t=1，另落一份：真机日志是我读现场的唯一凭据，不能被测试数据灌水
        test_ndjson = d / "logs" / ("test-%s.ndjson" % _today())
        test_human = d / ("xprobe-test-%s.log" % _today())
        with open(ndjson, "a", encoding="utf-8") as fj, open(human, "a", encoding="utf-8") as fh, \
                open(test_ndjson, "a", encoding="utf-8") as tj, open(test_human, "a", encoding="utf-8") as th:
            for rec in recs:
                if not isinstance(rec, dict):
                    continue
                rec.setdefault("receivedAt", datetime.now().isoformat(timespec="milliseconds"))
                rec["peer"] = peer
                if env_host and not rec.get("host"):
                    rec["host"] = env_host
                if env_peer:
                    rec["peer_host"] = env_peer
                if script_ver:
                    rec["scriptVer"] = script_ver
                is_test = bool(rec.get("t"))
                (tj if is_test else fj).write(json.dumps(rec, ensure_ascii=False) + "\n")
                summ_text = _summ(rec)
                line = "[%s] %s%s\n" % (_now(), summ_text, _late(rec) if not is_test else "")
                warn = _double_host(rec) if not is_test else ""
                (th if is_test else fh).write(line)
                _emit(line, say)
                if warn:
                    (th if is_test else fh).write(warn)
                    _emit(warn, say)
                kind = rec.get("kind", "?")
                if is_test:
                    STATS["testTotal"] = STATS.get("testTotal", 0) + 1
                    continue
                _db_ingest(rec, summ_text)   # 真机记录顺手入档：不新增任何一次请求，也不开第二条通道
                STATS["byKind"][kind] = STATS["byKind"].get(kind, 0) + 1
                STATS["total"] += 1
                STATS["lastSeenAt"] = rec["receivedAt"]
                STATS["lastUrl"] = rec.get("url", "")[:200]
                STATS["recent"].insert(0, {"at": rec["receivedAt"], "kind": kind, "summary": summ_text[:200]})
                del STATS["recent"][80:]
                n += 1
            STATS["lastFlush"] = datetime.now().isoformat(timespec="seconds")
            _save_stats()
            with open(d / "state.json", "w", encoding="utf-8") as fs:
                json.dump(STATS, fs, ensure_ascii=False, indent=2)
    return n


def _handle_dump(body: bytes, peer: str, say=None) -> str:
    """整页结构转储只落文件，绝不进 ndjson 记录流。

    一页 tree+原文几百 KB，混进 xprobe-*.log 会把真正的现场（字段命中率）冲得没法读；
    所以另开 dump/ 目录，一次转储一个文件夹，我按 dump/index.log 找最新那份。
    测试流量（t=1）单独落 dump-test/，理由和日志分流一样。
    """
    try:
        obj = json.loads(body.decode("utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("dump 不是对象")
    except Exception as e:
        with _lock:
            bad = CFG["dir"] / "bad-POST.log"
            bad.parent.mkdir(parents=True, exist_ok=True)
            with open(bad, "ab") as f:
                f.write(b"\n===== %s dump peer=%s err=%s =====\n" % (datetime.now().isoformat().encode(), peer.encode(), str(e).encode()))
                f.write(body[:MAX_BODY])
        return ""

    tree = str(obj.get("tree") or "")
    text = str(obj.get("text") or "")
    html = str(obj.get("html") or "")
    is_test = bool(obj.get("t"))
    meta = {k: v for k, v in obj.items() if k not in ("tree", "text", "html")}
    meta["receivedAt"] = datetime.now().isoformat(timespec="milliseconds")
    meta["peer"] = peer
    meta["bytes"] = {"tree": len(tree.encode("utf-8")), "text": len(text.encode("utf-8")), "html": len(html.encode("utf-8"))}

    with _lock:
        d = CFG["dir"]
        d.mkdir(parents=True, exist_ok=True)
        if STATS.get("day") != _today():
            _load_stats()
        root = d / ("dump-test" if is_test else "dump")
        name = "%s-%s-%s" % (datetime.now().strftime("%Y-%m-%d_%H%M%S"),
                             _safe(obj.get("tab"), "unknown", 24), _safe(obj.get("handle"), "none", 30))
        folder = root / name
        i = 1
        while folder.exists():  # 同一秒抓两页（换页快）不能让后一份覆盖前一份
            i += 1
            folder = root / ("%s-%d" % (name, i))
        folder.mkdir(parents=True)
        (folder / "tree.txt").write_text(tree, encoding="utf-8")
        (folder / "text.txt").write_text(text, encoding="utf-8")
        if html:
            (folder / "page.html").write_text(html, encoding="utf-8")
        (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        c = obj.get("counts") or {}
        line = "[%s] %s tree=%dB text=%dB html=%dB 耗时=%sms 页型=%s @%s 打印=%s 访问节点=%s 截断=%s url=%s%s\n" % (
            _now(), folder.relative_to(d).as_posix(), meta["bytes"]["tree"], meta["bytes"]["text"], meta["bytes"]["html"],
            c.get("ms", "-"), obj.get("tab") or "-", obj.get("handle") or "-", c.get("treeEmitted", "-"),
            c.get("treeNodes", "-"), c.get("hitCap"), str(obj.get("url") or "")[:120], " [测试流量]" if is_test else "")
        with open(root / "index.log", "a", encoding="utf-8") as f:
            f.write(line)
        if is_test:
            STATS["dumpTestTotal"] = STATS.get("dumpTestTotal", 0) + 1
        else:
            STATS["dumpTotal"] = STATS.get("dumpTotal", 0) + 1
            STATS["lastDumpAt"] = meta["receivedAt"]
            _db_dump(folder.relative_to(d).as_posix(), meta)
        _save_stats()
        with open(d / "state.json", "w", encoding="utf-8") as fs:
            json.dump(STATS, fs, ensure_ascii=False, indent=2)
        _emit(line, say)
        return folder.relative_to(d).as_posix()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "xprobe-" + SINK_VER

    def handle_one_request(self):
        # 浏览器/Node 的连接池随时可能掐掉 keep-alive 空闲连接：那不是故障，
        # 但默认实现会把整段 traceback 喷进我的 stdout，把真正的日志行埋掉
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def finish(self):
        try:
            BaseHTTPRequestHandler.finish(self)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome 的 Private Network Access：https 页面打到 loopback 需要这个头放行
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/ping"):
            self._send(200, ping_body())
            return
        if path.startswith("/db"):
            # 只读、白名单语句、limit 夹死；浏览器面板与我在终端里读库走的是同一道门
            qs = parse_qs(parsed.query)
            name = (qs.get("q") or ["recent"])[0]
            try:
                limit = max(1, min(500, int((qs.get("limit") or ["20"])[0])))
            except ValueError:
                limit = 20
            # 时间窗（v0.8.6）：hours 是「最近 N 小时」（0=全部），from/to 是起止日二选一。
            # 形状不对直接 400 说清楚：静默退回 24 小时会让人以为看到的是「全部」。
            hraw = (qs.get("hours") or [""])[0]
            hours = None
            if hraw != "":
                try:
                    hours = int(hraw)
                except ValueError:
                    hours = -1
                if hours < 0 or hours > 87600:
                    self._send(400, {"ok": False, "err": "hours 要 0~87600 的整数"})
                    return
            # from/to 与宿主那条路同一套形状校验：要么两个都是 YYYY-MM-DD 且起<=止，要么 400。
            # 只给一个（或给了坏值）也 400 —— 半截区间最容易看错，别悄悄当成 24 小时。
            day_re = re.compile(r"\d{4}-\d{2}-\d{2}")
            f0 = (qs.get("from") or [""])[0]
            f1 = (qs.get("to") or [""])[0]
            win = None
            if f0 or f1:
                if not (day_re.fullmatch(f0) and day_re.fullmatch(f1) and f0 <= f1):
                    self._send(400, {"ok": False, "err": "from/to 要 YYYY-MM-DD 且 from<=to"})
                    return
                win = (f0, f1)
            # v0.9.7 台账游标（bench_marks_* 上云增量用）：只认 >=0 的整数，坏形状当场 400。
            # 悄悄退成 0 等于把整本账重放一遍，那比报错糟。
            araw = (qs.get("after") or [""])[0]
            after = None
            if araw != "":
                try:
                    after = int(araw)
                except ValueError:
                    after = -1
                if after < 0:
                    self._send(400, {"ok": False, "err": "after 要 >=0 的整数（台账 id 游标）"})
                    return
            code, out = db_body(name, limit, (qs.get("day") or [None])[0], (qs.get("author") or [None])[0],
                                hours, win, after)
            self._send(code, out)
            return
        if path.startswith("/fs"):
            # ?auto=0 只看不动（自检与「刚删完想立刻量一遍」用），默认带每日一次的自动清理
            auto = (parse_qs(parsed.query).get("auto") or ["1"])[0] != "0"
            self._send(200 if xfs is not None else 500, fs_body(auto=auto))
            return
        self._send(404, {"ok": False, "err": "unknown path", "try": ["/ping", "/db?q=help", "/fs"]})

    def do_POST(self):
        path = self.path.split("?")[0]
        is_dump = path.startswith("/dump")
        is_fs = path.startswith("/fs")
        if not (is_dump or is_fs or path.startswith("/log")):
            self._send(404, {"ok": False, "err": "unknown path"})
            return
        limit = MAX_DUMP_BODY if is_dump else MAX_BODY
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > limit:
            # 没读干净 body 就回包会让 keep-alive 连接串味，直接关掉
            self.close_connection = True
            self._send(413 if length > limit else 400, {"ok": False, "err": "bad length %s" % length})
            return
        body = self.rfile.read(length)
        if is_fs:
            # 清理是这台机器上唯一「删了就回不来」的入口：body 只认 op/target/keep/dry 四个键，
            # 且缺省 dry=true —— 参数丢了、JSON 半截了，最坏结果是「只量没删」，不是「删多了」。
            try:
                req = json.loads(body.decode("utf-8"))
            except Exception as e:
                self._send(400, {"ok": False, "err": "body 不是 JSON: %s" % str(e)[:60]})
                return
            out = clean_body(req if isinstance(req, dict) else {})
            self._send(200 if out.get("ok") else 400, out)
            return
        if is_dump:
            rel = _handle_dump(body, self.client_address[0])
            self._send(200 if rel else 500, {"ok": bool(rel), "dir": rel})
            return
        n = _handle_payload(body, self.client_address[0])
        self._send(200, {"ok": True, "stored": n})

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] http: %s\n" % (_now(), fmt % args))


def _mb(n) -> str:
    try:
        return "%.1fMB" % (int(n) / 1048576.0)
    except Exception:
        return "?"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--dir", default=str(DEFAULT_DIR))
    ap.add_argument("--backfill", action="store_true",
                    help="把 logs/*.ndjson 里已有的真机记录补进 xprobe.db（幂等，可反复跑）")
    ap.add_argument("--no-db", action="store_true", help="不建档案库，只落 ndjson")
    a = ap.parse_args()
    CFG["dir"] = Path(a.dir)
    CFG["dir"].mkdir(parents=True, exist_ok=True)
    _load_stats()
    # 起机撞一次每日自动清理（clean.json 的 lastAuto 决定今天跑不跑）：
    # sink 不是常驻服务也要有这一眼 —— 面板没开、宿主没被叫起来的日子里，日志照样只留保留天数内的。
    if xfs is not None:
        try:
            ac = xfs.auto_clean_due(CFG["dir"])
            if not ac.get("skipped"):
                print("  自动清理：%s（保留 %s 天）→ %s" % (
                    ac.get("at"), ac.get("keep"),
                    "、".join("%s 删%s个/省%s" % (k, v.get("removed"), _mb(v.get("freed")))
                              for k, v in (ac.get("targets") or {}).items()) or "没东西可删"), flush=True)
        except Exception as e:
            sys.stderr.write("自动清理异常: %s\n" % e)
    STATS["startedAt"] = datetime.now().isoformat(timespec="seconds")
    db_note = "档案库：按 --no-db 关掉，只落 ndjson"
    if not a.no_db and _db_open():
        if a.backfill or xdb.is_empty():
            print("  档案库：%s ⇒ 从 logs/*.ndjson 补档中 …" % ("--backfill" if a.backfill else "空库首次自举"), flush=True)
            xdb.backfill(CFG["dir"] / "logs", lambda s: print("   " + s, flush=True), _summ)
        s = _db_slim()
        db_note = ("档案库 %s：%s 条记录 / %s（快照 %s、推文 %s、用户行 %s、关注流水 %s、分钟点 %s、曝光点 %s）%s"
                   % (s.get("dbVer") or "?", s.get("records", 0), _mb(s.get("bytes")),
                      s.get("snapshots", 0), s.get("tweets", 0), s.get("userRows", 0),
                      s.get("follows", 0), s.get("statPoints", 0), s.get("rewardPoints", 0),
                      ("  ⚠" + str(s.get("err"))) if s.get("err") else ""))
    elif not a.no_db:
        db_note = "档案库：打不开 ⇒ 只落 ndjson（/ping 的 db.err 有原因）"
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print("xprobe log sink %s\n  监听 http://127.0.0.1:%d/log 与 /dump  (GET /ping 探活, GET /db?q=help 读库)\n  落盘 %s\n  %s\n  Ctrl+C 停止\n"
          % (SINK_VER, a.port, CFG["dir"], db_note), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

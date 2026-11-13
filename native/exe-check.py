#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量**打好的那个 exe**，不是量仓库里的 .py —— 补 db-selftest.py 的 `leg_native` 看不见的那一段。

为什么要有它（v0.9.2 的真机事故）：扩展优先走 Native Messaging 宿主，而宿主是 PyInstaller onefile
打出来的 `native/dist/xprobe-host.exe`。改了 `xprobe_db.py` / `log-sink.py` / `xprobe_fs.py` 之后
**离线两套自检全绿、真机却照样读不到新表新列** —— 因为跑的是上一次打包进去的那一份。
更阴的是漏打包：`log-sink.py` 把 `import xprobe_fs` 包在 try 里，缺了不炸只降级，
症状是「宿主明明在、sink 也自报 sink-16，面板清理那行却说模块没导入」。
`leg_native` 起的是**源码** `native/xprobe_host.py`，那份永远是新的 ⇒ 它绿得毫无意义。

帧协议照 `xprobe_host.py`：4 字节小端长度 + JSON；回包带信封 `{ok, status, body, host}`，
`body` 本身又是一段 JSON 字符串 ⇒ 这里解开两层。数据目录用 `XPROBE_DIR` 指到系统临时目录
（`_cfg_dir()` 把环境变量排第一就是为这个），**绝不碰真库**。

用法：
  py -3 native\\exe-check.py            # 量 native/dist/xprobe-host.exe
  py -3 native\\exe-check.py --keep     # 跑完不删临时目录（想进去翻 xprobe.db 时用）
exe 不在就直接退出码 0 并说「没打包，跳过」——没装宿主的机器（HTTP 回退那条腿）不该因此红。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
EXE = HERE / "dist" / "xprobe-host.exe"

# v0.11.4：一台只会答话的假模型（只听 127.0.0.1，端口交给系统挑）。
# 它在这里的作用与 db-selftest.py 里那台一样：数得清「宿主到底出不出门」。
LLM_HITS = {"posts": 0, "gets": 0, "paths": set()}

# v0.11.16：会应答的假代理，喂给 exe 的环境变量。与 db-selftest.py 里那台同一个用意：
# 让「有没有走代理」变成确定性的计数，而不是碰运气看机器上设没设 HTTP_PROXY / no_proxy。
PROXY_HITS = {"n": 0}


def poison_proxy():
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _hit(self):
            PROXY_HITS["n"] += 1
            raw = b"proxy-took-the-loopback-request"
            self.send_response(502)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            self._hit()

        def do_POST(self):
            self._hit()

    srv = HTTPServer(("127.0.0.1", 0), H)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, th, srv.server_address[1]


def _host_num(v) -> int:
    """`native-7` ⇒ 7。跟 db-selftest.py 同一只手：只比档位不比整串，宿主升到 native-8 时这条腿不该红。"""
    m = re.search(r"(\d+)$", str(v or ""))
    return int(m.group(1)) if m else 0


def llm_dummy():
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _out(self, code, obj, extra=None):
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except Exception:
                pass

        def do_POST(self):
            LLM_HITS["posts"] += 1
            LLM_HITS["paths"].add(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            try:
                b = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                b = {}
            if self.path == "/api/generate":
                if str(b.get("prompt")) == "redir":
                    # 想把宿主支走的一跳：跟不跟，量的是「宿主会不会替页面上外网」
                    self._out(302, {"nope": "别跟这一跳"}, {"Location": "http://127.0.0.1:1/away"})
                    return
                self._out(200, {"model": b.get("model") or "exe-d", "response": "EXE_DRAFT:" + str(b.get("prompt"))})
            elif self.path == "/api/chat":
                self._out(200, {"message": {"content": "EXE_CHAT"}})
            elif self.path == "/v1/chat/completions":
                self._out(200, {"choices": [{"message": {"content": "EXE_OPENAI"}}]})
            else:
                self._out(404, {"error": "no path " + self.path})

        def do_GET(self):
            LLM_HITS["gets"] += 1
            LLM_HITS["paths"].add(self.path)
            self._out(200, {"models": [{"name": "exe-1", "model": "exe-1"}]})

    # 只听 127.0.0.1：回环就是这条通道的全部世界面（RL-2），断言里的地址也一律写死 127.0.0.1
    # —— localhost 会先摸 ::1，靶子没在那儿听 ⇒ 一次好好的「连不上」会变成说不清的失败。
    srv = HTTPServer(("127.0.0.1", 0), H)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, th, srv.server_address[1]

# 闸门脚本死在「打印不出来」上比断言失败更糟：Windows 控制台默认 GBK，标签里一个 ⇒ 就整条腿崩在后面
# （v0.9.7 真撞过：[4c] 跑到游标那条腿 UnicodeEncodeError，后面的帖子流水与 [6] 全没跑，退出码还不是 0）。
# 换不成的字符退成 ?，断言照算、结果照印。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

fails: list = []
nck = [0]


def ck(label, got, want) -> None:
    nck[0] += 1
    if got == want:
        print("  ok   %s" % label)
    else:
        print("  FAIL %s\n        got  = %r\n        want = %r" % (label, got, want))
        fails.append(label)


class Host:
    """一条帧通道：发一帧、收一帧，把信封与内层 body 都解开。"""

    def __init__(self, exe: Path, data: Path, proxy: str = ""):
        env = dict(os.environ)
        env["XPROBE_DIR"] = str(data)
        if proxy:
            env.update(HTTP_PROXY=proxy, http_proxy=proxy,
                       HTTPS_PROXY=proxy, https_proxy=proxy,
                       NO_PROXY="", no_proxy="")
        self.p = subprocess.Popen([str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=env)

    def send(self, obj: dict) -> dict:
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.p.stdin.write(struct.pack("<I", len(b)) + b)
        self.p.stdin.flush()
        head = self.p.stdout.read(4)
        if not head or len(head) < 4:
            raise SystemExit("宿主没回帧（exe 起不来？退出码 %s；看 %s/native-host.log）"
                             % (self.p.poll(), os.environ.get("XPROBE_DIR")))
        envlp = json.loads(self.p.stdout.read(struct.unpack("<I", head)[0]).decode("utf-8"))
        if isinstance(envlp.get("body"), str):
            try:
                envlp["body"] = json.loads(envlp["body"])
            except Exception:
                pass
        return envlp

    def body(self, obj: dict) -> dict:
        return self.send(obj).get("body") or {}

    def close(self) -> None:
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def main() -> int:
    if not EXE.exists():
        print("没找到 %s —— 本机没打包宿主（走 HTTP 回退那条腿）。跳过，不算红。" % EXE)
        return 0
    work = Path(tempfile.gettempdir()) / "xprobe-exe-check"
    data = work / "db"
    shutil.rmtree(work, ignore_errors=True)
    data.mkdir(parents=True)
    now = datetime.now(timezone.utc)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")   # noqa: E731
    pxy_srv, pxy_th, pxy_port = poison_proxy()
    purl = "http://127.0.0.1:%d" % pxy_port
    PROXY_HITS["n"] = 0
    h = Host(EXE, data, purl)
    # v0.11.4：llm 那条腿的靶子（变量在 try 外面起，收尾才关得掉，起靶子失败也不会留个孤儿进程）
    llm_srv = llm_th = None
    llm_port = 0
    try:
        llm_srv, llm_th, llm_port = llm_dummy()
        print("[1] 起得来、dir 认环境变量、版本对得上")
        b = h.body({"t": "ping"})
        ck("ping 回来的 dir 是临时目录（绝不写进真库）",
           str(Path(str(b.get("dir", ""))).resolve()), str(data.resolve()))
        ck("ping 自报 sink-19（exe 里那份 log-sink.py 是最新的；19 起 POST /api/xprobe/* 同形读口，工作台云端档对齐一版）", b.get("sink"), "sink-19")
        ck("ping 报的库版本是 db-10（v0.11.0：多 block_marks / block_stat 两条拉黑上云查询；v0.11.5 短暂的 db-11 随 v0.11.6 撤）", (b.get("db") or {}).get("dbVer"), "db-10")

        print("[2] v0.9.0 的新查询 bench_accounts（旧 exe 会回「未知查询」）")
        r = h.send({"t": "db", "q": "bench_accounts", "limit": 20})
        ck("空库也回 200/ok 而不是 400", [r.get("status"), r.get("body", {}).get("ok")], [200, True])

        print("[3] kind=bench 真落进 benchmarks 表")
        b = h.body({"t": "log", "body": json.dumps(
            {"kind": "bench", "at": iso(now), "receivedAt": iso(now), "url": "https://x.com/home",
             "ver": "exe-check", "host": "exe",
             "data": {"handle": "execheck_a", "name": "检查甲", "on": True, "tags": ["投资"]}},
            ensure_ascii=False)})
        ck("入库 1 条", [b.get("ok"), b.get("stored")], [True, 1])
        rows = h.body({"t": "db", "q": "bench_accounts", "limit": 20}).get("rows") or []
        ck("bench_accounts 认得出刚标的人（带分类）",
           [(x.get("handle"), x.get("tags")) for x in rows], [("execheck_a", "投资")])

        print("[4] v0.9.2 的新列：author_posts 要带出发帖时刻")
        pub, collect = iso(now - timedelta(hours=30)), iso(now)
        page = {"kind": "page", "at": collect, "receivedAt": collect, "url": "https://x.com/home",
                "tab": "home", "ver": "exe-check", "host": "exe",
                "data": {"tlSrc": "foryou", "tab": "home", "url": "https://x.com/home",
                         "identity": {"handle": "me"}, "stats": {"__tabs": []},
                         "tweets": [{"tweetId": "x1", "idx": 1, "author": "execheck_a",
                                     "text": "检查帖 x1", "timeDatetime": pub,
                                     "metrics": {"view": {"num": {"value": 500}},
                                                 "reply": {"num": {"value": 7}}}}],
                         "users": []}}
        b = h.body({"t": "log", "body": json.dumps(page, ensure_ascii=False)})
        ck("page 入库 1 条", [b.get("ok"), b.get("stored")], [True, 1])
        bd = h.body({"t": "db", "q": "author_posts", "author": "execheck_a", "limit": 20})
        rows = bd.get("rows") or []
        ck("author_posts 回这一条", [bd.get("ok"), len(rows)], [True, 1])
        keys = sorted(["tweet_id", "author", "text", "last_at", "view", "like", "reply", "eng",
                       "view_per_h", "time_datetime", "first_at"])
        ck("新两列 time_datetime / first_at 从 exe 里回来了且值对（列序没被挪、第 0 键仍是 tweet_id）",
           [sorted(rows[0].keys()) if rows else None, (rows[0].get("time_datetime") if rows else None),
            (rows[0].get("first_at") if rows else None), (list(rows[0].keys())[0] if rows else None)],
           [keys, pub, collect, "tweet_id"])

        print("[5] fs 通道：xprobe_fs.py 必须也在包里（漏打包不炸，只让面板那行说「模块没导入」）")
        fb = h.body({"t": "fs", "op": "sizes", "auto": True})
        ck("fs sizes 在宿主里可用", [fb.get("ok"), "没能导入" in str(fb.get("err", ""))], [True, False])

        print("[4b] v0.9.3 的标杆帖子：kind=benchpost 落 bench_posts、bench_post_rows 查得出（旧 exe 回「未知查询」）")
        bp = {"kind": "benchpost", "at": iso(now), "receivedAt": iso(now),
              "url": "https://x.com/carol/status/2114903455361888482", "ver": "exe-check", "host": "exe",
              "data": {"id": "2114903455361888482", "author": "@execheck_a", "text": "标杆帖正文", "on": True,
                       "tags": "投资"}}
        b = h.body({"t": "log", "body": json.dumps(bp, ensure_ascii=False)})
        ck("benchpost 入库 1 条", [b.get("ok"), b.get("stored")], [True, 1])
        bd = h.body({"t": "db", "q": "bench_post_rows", "limit": 20})
        rows = bd.get("rows") or []
        ck("bench_post_rows 认得出刚标的帖（作者剥 @；这条帖本机没采过数，数列全是 None 不编 0）",
           [bd.get("ok"), [(x.get("tweet_id"), x.get("author"), x.get("marked_text"), x.get("view"))
                           for x in rows]],
           [True, [("2114903455361888482", "execheck_a", "标杆帖正文", None)]])

        print("[4c] v0.9.7 上云增量：bench_marks_ac / bench_marks_po 两条台账流水走 exe（旧 exe 回「未知查询」）")
        # 这条腿只认三件事，都是「云端要、面板那两条视图查询给不了」的：墓碑（state=0）、游标、原样 tags。
        for i, (hh, on, tg) in enumerate((("execheck_b", True, "投资"), ("execheck_b", False, None))):
            bm = {"kind": "bench", "at": iso(now + timedelta(seconds=i)), "receivedAt": iso(now),
                  "url": "https://x.com/home", "ver": "exe-check", "host": "exe",
                  "data": {"handle": hh, "name": "乙", "on": on, "tags": tg}}
            b = h.body({"t": "log", "body": json.dumps(bm, ensure_ascii=False)})
            ck("bench 流水入库（进一条、退一条）", [b.get("ok"), b.get("stored")], [True, 1])
        um = {"kind": "benchpost", "at": iso(now + timedelta(seconds=5)), "receivedAt": iso(now),
              "url": "https://x.com/carol/status/2114903455361888482", "ver": "exe-check", "host": "exe",
              "data": {"id": "2114903455361888482", "author": "@execheck_a", "text": "标杆帖正文", "on": False}}
        b = h.body({"t": "log", "body": json.dumps(um, ensure_ascii=False)})
        ck("benchpost 移出那条也入库", [b.get("ok"), b.get("stored")], [True, 1])
        bd = h.body({"t": "db", "q": "bench_marks_ac", "limit": 50})
        rows = bd.get("rows") or []
        ck("bench_marks_ac：三条都在（含 [3] 那位、和刚进刚出的 execheck_b 两行）、按 id 升序",
           [bd.get("ok"), [(x.get("handle"), x.get("state")) for x in rows],
            [x["id"] for x in rows] == sorted(x["id"] for x in rows)],
           [True, [("execheck_a", 1), ("execheck_b", 1), ("execheck_b", 0)], True])
        ck("bench_accounts 视图那条查询把 execheck_b 滤掉了（同一批数据、两种口径 —— 这正是上云必须用流水的原因）",
           [x.get("handle") for x in (h.body({"t": "db", "q": "bench_accounts", "limit": 50}).get("rows") or [])],
           ["execheck_a"])
        last2 = rows[-1]["id"]
        bd2 = h.body({"t": "db", "q": "bench_marks_ac", "after": last2, "limit": 50})
        ck("after 游标在 exe 里真绑进 SQL：给到最大 id 就 0 行；不给就 3 行",
           [bd2.get("ok"), len(bd2.get("rows") or []), len(rows)], [True, 0, 3])
        bd3 = h.body({"t": "db", "q": "bench_marks_po", "limit": 50})
        pro = [(x.get("tweet_id"), x.get("state")) for x in (bd3.get("rows") or [])]
        ck("bench_marks_po：同一条帖的「进 + 出」两行都推得出去（云端据此撤标杆，而不是永远留着）",
           [bd3.get("ok"), pro],
           [True, [("2114903455361888482", 1), ("2114903455361888482", 0)]])
        nbad = h.body({"t": "db", "q": "bench_marks_ac", "after": -1, "limit": 5})
        ck("坏游标当场回 ok=False 报 after（不悄悄退成 0 = 不重放整本账）",
           [nbad.get("ok"), "after" in str(nbad.get("err"))], [False, True])

        print("[4d] v0.11.0 拉黑上云：block_marks / block_stat 两条查询走 exe（旧 exe 回「未知查询」）")
        # 旧 exe 打包的是 db-9 的 xprobe_db.py ⇒ 这两条查询在真机 Native 通道上会回「未知查询」，
        # 而 sink 那条 HTTP 兜底照样能查 —— 只测源码查不出这个差，所以必须量打包进 exe 的那一份。
        for i, (hh, on) in enumerate((("execheck_bad", True), ("execheck_bad", False), ("execheck_ok", True))):
            bm = {"kind": "block", "at": iso(now + timedelta(seconds=10 + i)), "receivedAt": iso(now),
                  "url": "https://x.com/home", "ver": "exe-check", "host": "exe",
                  "data": {"handle": hh, "name": "丙", "on": on}}
            b = h.body({"t": "log", "body": json.dumps(bm, ensure_ascii=False)})
            ck("拉黑流水入库（拉过又取消也是一行，state=0 留着）", [b.get("ok"), b.get("stored")], [True, 1])
        bb = h.body({"t": "db", "q": "block_marks", "limit": 50})
        brows = bb.get("rows") or []
        ck("block_marks：三行按 id 升序、取消行 state=0 也在（云端按业务键取最新一条判还在不在榜）",
           [bb.get("ok"), [(x.get("handle"), x.get("state")) for x in brows]],
           [True, [("execheck_bad", 1), ("execheck_bad", 0), ("execheck_ok", 1)]])
        bstat = h.body({"t": "db", "q": "block_stat", "after": 0})
        srow = (bstat.get("rows") or [{}])[0]
        ck("block_stat：2 个 handle（dave 式进/出只算一个）、水位 0 时已推 0、max_id 是最后一行",
           [bstat.get("ok"), srow.get("total"), srow.get("synced"), srow.get("max_id")],
           [True, 2, 0, brows[-1]["id"]])
        bstat2 = h.body({"t": "db", "q": "block_stat", "after": brows[-1]["id"]})
        ck("水位抬到最后一行 ⇒ 2 个全推完（面板「待推」归零靠的就是这一格）",
           (bstat2.get("rows") or [{}])[0].get("synced"), 2)
        bafter = h.body({"t": "db", "q": "block_marks", "after": brows[-1]["id"], "limit": 50})
        ck("block_marks 的 after 游标在 exe 里真绑进 SQL：给到最大 id 就 0 行（空页不是错）",
           [bafter.get("ok"), len(bafter.get("rows") or [])], [True, 0])

        print("[4e] v0.12.4 关注时间/未回关：follow_starts 白名单聚合走 exe（旧 exe 回「未知查询」）")
        # 只量源码查不出漏打包：装进 Chrome 的是 exe，白名单查询少一条时面板那格就一直「没回包」。
        for i, (hh, sp) in enumerate((("execheck_fs_a", 0), ("execheck_fs_a", 0), ("execheck_fs_b", 1))):
            fe = {"kind": "follow", "at": iso(now + timedelta(seconds=101 + i)),
                  "receivedAt": iso(now), "url": "https://x.com/home", "ver": "exe-check", "host": "exe",
                  "data": {"handle": hh, "dir": "follow", "suspect": sp}}
            b = h.body({"t": "log", "body": json.dumps(fe, ensure_ascii=False)})
            ck("关注动作入库（同一人两次、另一人带 suspect）", [b.get("ok"), b.get("stored")], [True, 1])
        fs = h.body({"t": "db", "q": "follow_starts", "limit": 50})
        frows = [x for x in (fs.get("rows") or []) if str(x.get("handle", "")).startswith("execheck_fs")]
        ck("exe 里 follow_starts 可用：两人各一行、都标 event（旧 exe 这里 ok=False）",
           [fs.get("ok"), len(frows), sorted(str(x.get("at_source")) for x in frows)],
           [True, 2, ["event", "event"]])
        ck("exe 回包四跳同名：at_source / follow_back / suspect 三列都在",
           [all(k in (frows[0] if frows else {}) for k in ("at_source", "follow_back", "suspect")),
            sorted(int(x.get("suspect") or 0) for x in frows)], [True, [0, 1]])
        ck("反向对照：未知查询仍被白名单挡住（新加一条没把白名单放成任意 SQL）",
           h.body({"t": "db", "q": "follow_starts__not_exist", "limit": 5}).get("ok"), False)

        print("[5b] v0.11.4 本机模型通道（llm）在 exe 里真在")
        # 为什么要在打包版上再钉一遍：db-selftest 的 [E] 起的是**源码**宿主，那份永远带 llm；
        # 装进 Chrome 的却是 exe —— 漏打包时「设置里开着闸、点『测活』回未知通道」才是真现场（RL-12 那条老教训）。
        # 下面第一条 ck 里的 7 就是档位：旧 exe 不认 llm ⇒ 回 404「未知通道」，档位也回不到 7，两处一起红。
        ck("exe 的 ping 自报 native-7（这一档才是 db-10 白名单 + llm 都齐的那份；旧打包版到不了 7 ⇒ 这条先红，别等测活才知道）",
           _host_num(h.body({"t": "ping"}).get("hver")), 7)
        e1 = h.send({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:%d" % llm_port,
                     "prompt": "打包版", "model": "exe-1"})
        ck("exe 里的 llm 真打到假模型并回正文（信封 native-7、body 里 hver 也在）",
           [e1.get("status"), (e1.get("body") or {}).get("text"), _host_num(e1.get("host")),
            _host_num((e1.get("body") or {}).get("hver"))],
           [200, "EXE_DRAFT:打包版", 7, 7])
        e2 = h.body({"t": "llm", "endpoint": "openai", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "x", "model": "m"})
        ck("openai 档在 exe 里读的也是 choices[0].message.content（三档各有一只手，打包别只打进一只）",
           e2.get("text"), "EXE_OPENAI")
        e3 = h.body({"t": "llm", "endpoint": "chat", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "x"})
        ck("chat 档读 message.content", e3.get("text"), "EXE_CHAT")
        e4 = h.body({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:%d" % llm_port, "list": "tags"})
        ck("列模型在 exe 里回名字数组（面板那颗「测活」念的就是它）", e4.get("models"), ["exe-1"])
        # 这一跳是整条通道最贵的一条判据：跟了跳转，「模型只在本机」就成了假话（RL-2）。
        er = h.send({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "redir"})
        ck("exe 里也不跟 302：假模型想把它支走的那一跳没跟成（/away 一次都没被请求）",
           [er.get("status"), "/away" in LLM_HITS["paths"]], [502, False])
        eb = h.send({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:1", "prompt": "x"})
        ck("端口形状对但没人听 ⇒ exe 自己打成「连不上」（不是 traceback，也不是 0 字节的成功）",
           [eb.get("status"), "连不上" in str((eb.get("body") or {}).get("err"))], [502, True])
        ck("exe 里也钉死不走代理：毒代理在场，整条 llm 腿 0 命中（旧 exe 会把回环请求交给它）",
           PROXY_HITS["n"], 0)
        ck("假模型挨到的正好是这 4 发 POST（三档 + 那一跳 302）与 1 发 GET（列模型）；端口 1 那发没打到它 = 真没出门",
           [LLM_HITS["posts"], LLM_HITS["gets"]], [4, 1])
        before = dict(LLM_HITS, paths=sorted(LLM_HITS["paths"]))
        e5 = h.send({"t": "llm", "endpoint": "generate", "base": "https://api.openai.com", "prompt": "x"})
        e6 = h.send({"t": "llm", "endpoint": "generate", "base": "http://8.8.8.8:11434", "prompt": "x"})
        ck("exe 里也挡得住公网地址：https 与非回环 IP 都 400，且假模型计数一个字没涨（一个请求都没出门）",
           [e5.get("status"), e6.get("status"), dict(LLM_HITS, paths=sorted(LLM_HITS["paths"]))],
           [400, 400, before])

        print("[6] 关掉宿主后看库里的表")
        h.close()
        conn = sqlite3.connect(str(data / "xprobe.db"))
        tabs = {t[0] for t in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        conn.close()
        ck("benchmarks 表在 exe 打开的库上长出来了", "benchmarks" in tabs, True)
        ck("bench_posts 表也在（v0.9.3 标杆帖子走 SCHEMA 的 IF NOT EXISTS 自长，_migrate 一字不用动）",
           "bench_posts" in tabs, True)
        print("     表: %s" % ", ".join(sorted(tabs)))
    finally:
        h.close()
        if llm_srv is not None:
            try:
                llm_srv.shutdown()
                llm_srv.server_close()
            except Exception:
                pass
        if llm_th is not None:
            llm_th.join(timeout=3)
        if pxy_srv is not None:
            try:
                pxy_srv.shutdown()
                pxy_srv.server_close()
            except Exception:
                pass
        if pxy_th is not None:
            pxy_th.join(timeout=3)
        if "--keep" not in sys.argv:
            shutil.rmtree(work, ignore_errors=True)
        else:
            print("  （--keep：临时目录留着 %s）" % work)
    print("\n断言 %d 条：%s" % (nck[0], "全部通过" if not fails else "失败 %d 条：%s" % (len(fails), "、".join(fails))))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

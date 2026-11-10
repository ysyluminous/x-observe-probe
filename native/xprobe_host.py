#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""X 观测探针的 Native Messaging 宿主：扩展直接跟本机进程说话，不用再开着 bat 窗口。

为什么要有它：log-sink.py 是 HTTP 服务，面板要读库就得先双击 start-sink.bat 并让它一直开着。
Native Messaging 是 Chrome 自己拉起宿主进程（stdin/stdout 走 4 字节小端长度 + UTF-8 JSON），
没人用的时候它不存在、也不占端口 —— 这正是「浏览器只留队列与设置、数据全进本机库」的前提。

协议（与 HTTP 一一对应，回包形状不变，所以 shim/core/面板一行都不用改）：
  请求 {t:'log', body:'<json>'} / {t:'dump', body:'<json>'} / {t:'db', q, limit} / {t:'ping'}
       {t:'fs', op:'sizes'|'clean'|'vacuum'|'conf'|'auto', target?, days?, dry?}（v0.8.8 占用与清理）
       {t:'llm', endpoint:'generate'|'openai', base:'http://127.0.0.1:<port>', prompt, model?, ...}
        （v0.11.4 本机模型通道：这一条**没有** HTTP 对应物 —— 面板/页面那条 HTTP 腿只认 8765 两条前缀，
         模型地址加不进 host_permissions（RL-3：不白拿权限），所以「按需授权」落在两处：宿主本身是授权
         （没装 = 一个请求都发不出去），加上调用方那颗默认关的闸。宿主这边再兜一层死规矩：只许回环。）
  回包 {ok:true, status:200, body:'<json 字符串>'}；应用错误也是回包，不是进程崩溃
       body 里 v0.11.4 起多带 {hver, hts}（log/dump/db/fs 四类，见 hmeta）——SW 靠它分辨
       「这儿的宿主认不认 llm」，不靠猜（旧版回包没这两格）。

铁律：stdout 只有协议帧。log-sink 那层把「人读的那行」写到哪里由 say 参数决定 —— 这里一律
写进 <dir>/native-host.log。任何一行日志漏到 stdout 都会让 Chrome 把整条消息判成坏帧。
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOST_VER = "native-7"   # v0.11.4：多一条本机模型通道（llm，只许回环）；回包 body 摊平带上 {hver, hts}，让 SW 认得出「这儿的宿主认不认 llm」
                        # （v0.11.5 曾抬到 native-8 随 db-11；用户撤了 AI 样本那半截，v0.11.6 随 db-10 回到 native-7 重打包——
                        #  exe 里捆的 xprobe_db.py 还是旧账数时，ping 会自报 db-11，重打包后归位）
                        # （native-6 = 打包进来的 xprobe_db.py 到 db-10：block_marks / block_stat 两条拉黑上云查询）
HOST_NAME = "com.yunxiao.xprobe"
MAX_RESP = 900 * 1024          # Chrome → 宿主 64MB，宿主 → Chrome 只有 1MB；留出余量后明确报错，别让 Chrome 截断
def _find_legacy_dir():
    """Locate an older data dir (temp/xprobe) under any ancestor of this file or exe."""
    try:
        here = Path(sys.executable).resolve() if getattr(sys, "frozen", False) else Path(__file__).resolve()
    except Exception:
        return None
    for p in here.parents:
        cand = p / "temp" / "xprobe"
        try:
            if cand.is_dir():
                return cand
        except Exception:
            pass
    return None


def _default_dir() -> Path:
    # 兜底默认（env/json 都没配到才轮到它）：作者机器的历史目录存在就沿用，否则回落用户目录 ~/xprobe。
    # 别写死盘符——别人机器上没有 D: 时宿主连库都建不出来。
    legacy = _find_legacy_dir()
    return legacy if legacy else Path.home() / "xprobe"


DEFAULT_DIR = _default_dir()


def _base_dir() -> Path:
    # PyInstaller onefile 会把数据解到 _MEIPASS；没打包时就是仓库根（native/ 的上一级）
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def _cfg_dir() -> Path:
    """数据目录：环境变量 XPROBE_DIR → 宿主旁边的 xprobe_host.json（安装器写的）→ 默认。
    环境变量排第一是为了让自检能把它指到临时目录（否则一份残留的 json 会让自检写进真库）。
    读配置失败不算错，默认值就是 log-sink 的默认值。
    注意 argv[1] 用的是扩展 origin（Chrome 传的），不能拿来当路径。"""
    env = os.environ.get("XPROBE_DIR")
    if env:
        return Path(env)
    here = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    try:
        o = json.loads((here / "xprobe_host.json").read_text(encoding="utf-8"))
        if o.get("dir"):
            return Path(str(o["dir"]))
    except Exception:
        pass
    return DEFAULT_DIR


def _load_sink(base: Path):
    """直接加载 log-sink.py 本体：摘要、ndjson、stats、入库全用它，绝不在这里抄第二份。"""
    path = base / "log-sink.py"
    sys.path.insert(0, str(base))       # log-sink 里 import xprobe_db 要靠这一行
    spec = importlib.util.spec_from_file_location("xprobe_log_sink", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read_msg() -> dict | None:
    head = sys.stdin.buffer.read(4)
    if not head or len(head) < 4:
        return None
    n = struct.unpack("<I", head)[0]
    if n <= 0 or n > 64 * 1024 * 1024:
        raise ValueError("长度字段不合理: %s" % n)
    raw = sys.stdin.buffer.read(n)
    if len(raw) < n:
        raise ValueError("帧不完整: %s/%s" % (len(raw), n))
    return json.loads(raw.decode("utf-8"))


def _write_msg(obj: dict) -> None:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def hmeta(obj):
    """v0.11.4：把「回这份包的是哪一版宿主、什么时候回的」摊进 body。
    为什么要有它：SW 那边只有 {status, body} 两段，帧信封里的 host 字段它读不到（nativeCall 只回
    r.status / r.body）。于是「这台宿主认不认 llm」只能从 body 里问 —— 旧版没这两格 = 认不出，
    当场说「重跑 native/install-host.py 打包」，而不是让人对着一个 404「未知通道 'llm'」猜。"""
    if isinstance(obj, dict):
        obj["hver"] = HOST_VER
        obj["hts"] = int(time.time() * 1000)
    return obj


# ---------- v0.11.4 本机模型通道（llm）----------
# 为什么要走宿主而不走扩展自己的 fetch：host_permissions 是安装期声明、MV3 没有「可选主机权限」这条路，
# 加一个 Ollama 端口就是永久扩权（RL-3 明写「申请了不用也是扩权」）。宿主是用户自己装的（按需授权的第一层），
# 面板里那颗闸默认关（第二层），这一条腿再兜一层死规矩：**只许回环**。三层里任何一层没点头，一个字节都出不去。
LLM_BASE_RE = re.compile(r"^http://(127\.0\.0\.1|localhost)(:(\d{1,5}))?/?$")
LLM_ENDPOINTS = ("generate", "openai", "chat")     # Ollama 原生 / OpenAI 兼容补全 / Ollama 原生 /api/chat
LLM_TIMEOUTS = (1000, 300000)
LLM_BODY_MAX = 64 * 1024
LLM_RESP_MAX = 5 * 1024 * 1024
NO_REDIRECT = type("NoRedirect", (urllib.request.HTTPRedirectHandler,),
                   {"redirect_request": lambda *a, **k: None})
# v0.11.16：系统级 HTTP_PROXY / http_proxy 会把「只许回环」的模型请求交给代理。
# 现场是端口 1 没人听本该 URLError「连不上」，代理却抢先回一页 502 文本 ——
# 不跟跳转/URL 白名单都拦不住，因为那一趟根本没按我们想的路走（RL-2 / RL-19 / RL-27②）。
# 传一个空 ProxyHandler 实例，build_opener 就不会再自动塞默认 ProxyHandler ⇒
# 物理上只可能直连回环。与 llm_guard 的 URL 白名单是两道门，别拆掉任何一道。
NO_PROXY = urllib.request.ProxyHandler({})


def llm_guard(url: str):
    """回环判定：scheme 只许 http、host 只许 127.0.0.1 / localhost、不许带路径/查询/片段。
    返回 (base, None) 或 (None, 那句错)。'要不要发这一趟'不归这里管 —— 那是调用方那颗闸的事。"""
    m = LLM_BASE_RE.match(str(url or ""))
    if not m:
        return None, "本机模型地址只认 http://127.0.0.1 或 http://localhost（可带端口），收到的是 " + clip(str(url), 80)
    port = int(m.group(3)) if m.group(3) else (80 if m.group(1) == "localhost" else 80)
    return "http://127.0.0.1:" + str(port), None


def clip(s, n):
    s = str(s if s is not None else "")
    return s if len(s) <= n else s[:n] + "…"


def llm_body(endpoint: str, req: dict):
    """按端点拼 body。只吃受控字段：prompt/model/system/max_tokens/temperature/format，拼不出第二条 URL。"""
    prompt = str(req.get("prompt") or "")
    model = str(req.get("model") or "")
    if not prompt.strip():
        return None, "prompt 是空的：没内容可写，也没发请求"
    try:
        temp = float(req.get("temperature")) if req.get("temperature") not in (None, "") else None
    except (TypeError, ValueError):
        temp = None
    try:
        mx = int(req.get("max_tokens")) if req.get("max_tokens") not in (None, "") else None
        if mx is not None and not (1 <= mx <= 8192):
            mx = None
    except (TypeError, ValueError):
        mx = None
    system = str(req.get("system") or "")
    fmt = str(req.get("format") or "")
    if endpoint == "generate":
        b = {"prompt": prompt, "stream": False}
        if model:
            b["model"] = model
        if system:
            b["system"] = system
        if temp is not None:
            b["temperature"] = temp
        if mx:
            b["num_predict"] = mx
        if fmt:
            b["format"] = fmt
        return b, None
    if endpoint == "chat":
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.append({"role": "user", "content": prompt})
        b = {"messages": msgs, "stream": False}
        if model:
            b["model"] = model
        if temp is not None:
            b["temperature"] = temp
        if mx:
            b["options"] = {"num_predict": mx}
        return b, None
    # openai：/v1/chat/completions，一条 user 消息；max_tokens 是这个协议的字段名
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    b = {"messages": msgs, "stream": False}
    if model:
        b["model"] = model
    if temp is not None:
        b["temperature"] = temp
    if mx:
        b["max_tokens"] = mx
    return b, None


def llm_pick(obj: dict, endpoint: str):
    """从各家回包里取正文 —— 认「回复的形状」，不认「我们猜的字段」：
    generate/chat 走不到 content 时退回 message.content，openai 走不到就整包报出来，不悄悄编一段。"""
    if not isinstance(obj, dict):
        return ""
    for k in ("response", "content"):
        v = obj.get(k)
        if isinstance(v, str) and v:
            return v
    msg = obj.get("message")
    if isinstance(msg, dict) and isinstance(msg.get("content"), str):
        return msg["content"]
    ch = obj.get("choices")
    if isinstance(ch, list) and ch:
        first = ch[0] if isinstance(ch[0], dict) else {}
        me = first.get("message")
        if isinstance(me, dict) and isinstance(me.get("content"), str):
            return me["content"]
        if isinstance(first.get("text"), str):
            return first["text"]
    return ""


def llm_models(obj: dict):
    """从 /api/tags 或 /v1/models 里把模型名挑出来（认两种形状，挑不出就回空列表 + 原样计数）。"""
    rows = obj.get("models") if isinstance(obj.get("models"), list) else None
    if rows is None:
        d = obj.get("data")
        rows = d.get("models") if isinstance(d, dict) and isinstance(d.get("models"), list) else None
    if rows is None and isinstance(obj.get("data"), list):
        rows = obj["data"]
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        n = r.get("model") or r.get("name") or r.get("id")
        if n:
            out.append(str(n))
    return out


def llm_http(url: str, body: str, token: str, ms: int):
    """发一趟并回 (status, text)。连不上/超时都是回包，不是异常 —— 面板要能说出是哪一种。"""
    data = body.encode("utf-8") if body else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    op = urllib.request.build_opener(NO_REDIRECT, NO_PROXY)
    try:
        with op.open(r, timeout=ms / 1000.0) as resp:
            return int(resp.getcode() or 200), resp.read(LLM_RESP_MAX).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return int(e.code), e.read(65536).decode("utf-8", "replace")
        except Exception:
            return int(e.code or 0), ""
    except urllib.error.URLError as e:
        return 0, "连不上：" + clip(getattr(e, "reason", e), 120)
    except socket.timeout:
        return 0, "模型 %d 秒没回话（本机在跑的那个服务起来了吗？大模型首包可以很慢）" % (ms // 1000)
    except Exception as e:
        return 0, clip("%s: %s" % (type(e).__name__, e), 120)


def _handle(sink, req: dict, logf) -> tuple:
    t = req.get("t") if isinstance(req, dict) else None
    if t == "ping":
        return 200, sink.ping_body()
    if t == "llm":
        endpoint = str(req.get("endpoint") or "generate")
        if endpoint not in LLM_ENDPOINTS:
            return 400, {"ok": False, "err": "模型端点只认 %s（收到 %r）" % ("/".join(LLM_ENDPOINTS), endpoint)}
        base, e = llm_guard(req.get("base"))
        if e:
            return 400, {"ok": False, "err": e}
        try:
            ms = int(req.get("timeoutMs") or 60000)
        except (TypeError, ValueError):
            ms = 60000
        ms = max(LLM_TIMEOUTS[0], min(LLM_TIMEOUTS[1], ms))
        token = clip(req.get("token"), 200)
        # 列模型：GET 一个定死的读口，不吃 prompt
        want = str(req.get("list") or "")
        if want:
            path = "/api/tags" if want == "tags" else "/v1/models"
            st, text = llm_http(base + path, None, token, ms)
            if st == 0:
                return 502, {"ok": False, "err": text}
            try:
                models = llm_models(json.loads(text))
            except Exception as ex:
                return 502, {"ok": False, "err": "模型列表不是 JSON：" + clip(text, 80)}
            if st >= 400:
                return st, {"ok": False, "err": "模型服务回 %d：%s" % (st, clip(text, 160))}
            return 200, {"ok": True, "models": models, "status": st, "base": base}
        body, e = llm_body(endpoint, req)
        if e:
            return 400, {"ok": False, "err": e}
        path = "/api/generate" if endpoint == "generate" else ("/api/chat" if endpoint == "chat" else "/v1/chat/completions")
        text = json.dumps(body, ensure_ascii=False)
        if len(text.encode("utf-8")) > LLM_BODY_MAX:
            return 413, {"ok": False, "err": "要发的正文 %d 字节，超过 %dKB 顶：整页原文不必都喂进去"
                                        % (len(text.encode("utf-8")), LLM_BODY_MAX // 1024)}
        st, raw = llm_http(base + path, text, token, ms)
        logf.write("[llm] %s %s -> %s (%s 字, %dms 顶)\n" % (endpoint, base + path, st, len(raw or ""), ms))
        logf.flush()
        if st == 0:
            return 502, {"ok": False, "err": raw}
        try:
            obj = json.loads(raw) if raw else {}
        except Exception:
            return 502, {"ok": False, "err": "模型回包不是 JSON（%d）：%s" % (st, clip(raw, 120))}
        if st >= 400:
            err = obj.get("error") if isinstance(obj.get("error"), str) else clip(raw, 160)
            return st, {"ok": False, "err": "模型服务回 %d：%s" % (st, err)}
        got = llm_pick(obj if isinstance(obj, dict) else {}, endpoint)
        if not got:
            return 502, {"ok": False, "err": "%d 但回包里没有正文（端点选错了吗？现在是 %s）" % (st, endpoint)}
        return 200, {"ok": True, "text": got, "status": st, "endpoint": endpoint,
                     "model": str(obj.get("model") or req.get("model") or ""),
                     "seconds": obj.get("eval_duration") or obj.get("duration") or None}
    if t == "db":
        name = str(req.get("q") or "recent")
        try:
            limit = max(1, min(500, int(req.get("limit") or 20)))
        except (TypeError, ValueError):
            limit = 20
        day = req.get("day") or None
        author = req.get("author") or None
        # v0.8.6 时间窗：hours（最近 N 小时，0=全部）与 from/to（起止日）二选一。
        # 形状不对就当场 400 —— 不能让「参数传坏了」变成「悄悄按 24 小时查」。
        hours = req.get("hours")
        if hours is not None:
            try:
                hours = int(hours)
            except (TypeError, ValueError):
                hours = -1
            if hours < 0 or hours > 87600:
                return 400, {"ok": False, "err": "hours 要 0~87600 的整数"}
        # v0.9.7 台账游标（bench_marks_* 上云增量用）：只认 >=0 的整数，坏形状当场 400。
        # 悄悄退成 0 等于把整本账重放一遍，那比报错糟。
        after = req.get("after")
        if after is not None:
            try:
                after = int(after)
            except (TypeError, ValueError):
                after = -1
            if after < 0:
                return 400, {"ok": False, "err": "after 要 >=0 的整数（台账 id 游标）"}
        f0, f1 = req.get("from"), req.get("to")
        win = None
        if f0 is not None or f1 is not None:
            ok = all(isinstance(x, str) and len(x) == 10 and x[4] == "-" and x[7] == "-"
                     and x[:4].isdigit() and x[5:7].isdigit() and x[8:].isdigit() for x in (f0, f1))
            if not ok or f0 > f1:
                return 400, {"ok": False, "err": "from/to 要 YYYY-MM-DD 且 from<=to"}
            win = (f0, f1)
        return sink.db_body(name, limit,
                            day if isinstance(day, str) and day else None,
                            author if isinstance(author, str) and author else None,
                            hours, win, after)
    # v0.12.0 云端模式「推完即清」：只有服务端 ack 过的 id 才允许从本机台账删除。
    # 与 /fs 一样是把「删了回不来」的入口压到最小：名字白名单 + upto 非负整数，SQL 永远不进协议。
    if t == "dbpurge":
        name = str(req.get("q") or "")
        try:
            upto = int(req.get("upto"))
        except (TypeError, ValueError):
            return 400, {"ok": False, "err": "upto 要 >=0 的整数（服务端 ack 水位）"}
        if upto < 0:
            return 400, {"ok": False, "err": "upto 要 >=0 的整数（服务端 ack 水位）"}
        try:
            code, out = sink.dbpurge_body(name, upto)
        except Exception as e:
            return 500, {"ok": False, "err": "清理异常: %s" % str(e)[:160]}
        return code, out
    if t == "fs":
        op = str(req.get("op") or "sizes")
        if op == "sizes":
            obj = sink.fs_body(auto=bool(req.get("auto", True)))
            return (200 if obj.get("ok") else 500), obj
        # 平铺字段 → 同一份 clean_body：keep 在扩展这边叫 days（HTTP 那条路吃 body 里的 keep）
        obj = sink.clean_body({"op": op, "target": req.get("target"),
                               "keep": req.get("days"), "dry": bool(req.get("dry", True))})
        return (200 if obj.get("ok") else 400), obj
    if t in ("log", "dump"):
        body = req.get("body")
        if not isinstance(body, str) or not body:
            return 400, {"ok": False, "err": "空 body"}
        raw = body.encode("utf-8")
        if t == "log":
            n = sink._handle_payload(raw, "native", say=logf)
            return 200, {"ok": True, "stored": n}
        rel = sink._handle_dump(raw, "native", say=logf)
        return (200 if rel else 500), {"ok": bool(rel), "dir": rel}
    return 404, {"ok": False, "err": "未知通道 %r" % (t,)}


def main() -> int:
    base = _base_dir()
    d = _cfg_dir()
    d.mkdir(parents=True, exist_ok=True)
    logf = open(d / "native-host.log", "a", encoding="utf-8")
    sys.stderr = logf               # 任何 traceback 都别写进会被 Chrome 当成协议的 stdout
    try:
        sink = _load_sink(base)
    except Exception as e:
        _write_msg({"ok": False, "err": "加载 log-sink.py 失败: %s" % e})
        return 1
    sink.CFG["dir"] = d
    try:
        sink._load_stats()
        sink._db_open()
    except Exception as e:
        logf.write("[native] 初始化失败: %s\n" % e)
    # 起机撞一次每日自动清理（宿主是每条消息新起一个进程，所以这一眼几乎总在「今天第一条」上落到）；
    # 真正干活的是 clean.json 里的 lastAuto —— 同一天后面那些进程读一句就跳过，不会反复走目录
    if getattr(sink, "xfs", None) is not None:
        try:
            sink.xfs.auto_clean_due(d)
        except Exception as e:
            logf.write("[native] 自动清理异常: %s\n" % e)
    while True:
        try:
            req = _read_msg()
        except Exception as e:
            _write_msg({"ok": False, "err": "读帧失败: %s" % e})
            break
        if req is None:
            break
        try:
            code, obj = _handle(sink, req, logf)
        except Exception as e:
            code, obj = 500, {"ok": False, "err": "%s: %s" % (type(e).__name__, e)}
        # v0.11.4：只有 native 这条路给 body 摊上 hver/hts（log-sink 的 HTTP 回包一个字没动 ——
        # 那两份形状要逐条对得上，面板才不许为同一件事存两处真相）
        hmeta(obj)
        text = json.dumps(obj, ensure_ascii=False)
        if len(text.encode("utf-8")) > MAX_RESP:
            text = json.dumps(hmeta({"ok": False, "err": "回包 %d 字节超过 1MB 上限，调小 limit" % len(text.encode("utf-8"))}),
                              ensure_ascii=False)
            code = 413
        _write_msg({"ok": code == 200, "status": code, "body": text, "host": HOST_VER})
    logf.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

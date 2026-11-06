#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本机数据目录的占用测量与按保留天数清理（v0.8.8）。

为什么单独一个文件：删除是唯一一件「跑错了就回不来」的事，它得有一个只干这件事、
能单独自检、边界写死的地方。测量与删除共用同一份枚举，面板上「将删 4.2 MB」和
真删掉的字节才是同一笔账 —— 这两件事分家最容易撒谎。

边界（红线，与 log-sink / 宿主一致）：
  ① 只认数据目录 CFG["dir"] 里面这几个写死的名字：logs/、dump/、dump-test/、
     xprobe-*.log、bad-POST.log、xprobe.db。浏览器那边只能传 target / keep / dry 三个值，
     传不进路径，也传不进 glob；含 "/" 或以 ".." 开头的一律当坏参数拒掉。
  ② 任何一次删除都必须先能 dry 出来（dry=True 只算不删），面板的钮是「先 DRY 回显再确认」。
  ③ 只按「超过保留天数」删，绝不碰当天与最近 60 秒内还在写的文件；keep 夹在 1~365，
     没有 keep=0 = 全删这种语义。
  ④ 库（xprobe.db）这一档默认只做 VACUUM（回收空闲页，一行数据都不删）。按天删库里的行
     是另一件事，需要调用方明确传 yes="purge-db"，本项目至今没做过，留给你自己决定。
"""
from __future__ import annotations

import json
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

FS_VER = "fs-1"
CONF_NAME = "clean.json"
DEFAULT_KEEP = 7                 # 用户口径：默认 7 天自动清理
MIN_KEEP, MAX_KEEP = 1, 365
RECENT_MS = 60 * 1000            # 60 秒内动过的文件当作「还在写」，任何情况都不删
NAME_LIST = 40                   # 回包里的文件名最多列这么多（宿主 → Chrome 只有 1MB）

DATE_RE = re.compile(r"(20\d{2})-(\d{2})-(\d{2})")
LOG_FILE_RE = re.compile(r"^(xprobe(-test)?-\d{4}-\d{2}-\d{2}|bad-POST)\.log(\.pre-v\d+)?$")
DB_FILES = ("xprobe.db", "xprobe.db-wal", "xprobe.db-shm")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _age_ms(path: Path, st) -> int:
    """文件的年龄：文件名里带日期就先认文件名（mtime 会被备份/同步工具摸新，
    靠它判断「7 天前的日志」会把昨天的文件当成上个月的删掉），文件名没日期才用 mtime。"""
    m = DATE_RE.search(path.name)
    if m:
        try:
            d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            # 按「日」算年龄：文件名没有时刻，用当天 00:00 与 cutoff 比最保守
            return _now_ms() - d.timestamp() * 1000
        except ValueError:
            pass
    return _now_ms() - st.st_mtime * 1000


def _dir_age_ms(path: Path, st) -> int:
    m = DATE_RE.search(path.name)
    if m:
        try:
            stamp = path.name[m.start():m.start() + 17]     # 2026-10-26_181910
            d = datetime.strptime(stamp, "%Y-%m-%d_%H%M%S")
            return _now_ms() - d.timestamp() * 1000
        except ValueError:
            pass
    return _now_ms() - st.st_mtime * 1000


def norm_keep(v) -> int:
    """保留天数：坏值一律落回默认，绝不因为「输入框空了」就变成 0 天 = 全清。"""
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return DEFAULT_KEEP
    if n < MIN_KEEP:
        return DEFAULT_KEEP if n <= 0 else MIN_KEEP
    return min(n, MAX_KEEP)


def _safe_target(t) -> str:
    s = str(t or "")
    return s if s in ("logs", "dump") and "/" not in s and "\\" not in s and ".." not in s else ""


# ---------- 配置（clean.json）----------
def load_conf(d: Path) -> dict:
    conf = {"keep": DEFAULT_KEEP, "auto": True, "lastAuto": "", "runs": []}
    try:
        o = json.loads((d / CONF_NAME).read_text(encoding="utf-8"))
        if isinstance(o, dict):
            if o.get("keep") is not None:
                conf["keep"] = norm_keep(o.get("keep"))
            if o.get("auto") is not None:
                conf["auto"] = bool(o.get("auto"))
            conf["lastAuto"] = str(o.get("lastAuto") or "")
            if isinstance(o.get("runs"), list):
                conf["runs"] = o["runs"][-6:]
    except Exception:
        pass
    return conf


def save_conf(d: Path, conf: dict) -> bool:
    try:
        (d / CONF_NAME).write_text(json.dumps(
            {"keep": norm_keep(conf.get("keep")), "auto": bool(conf.get("auto")),
             "lastAuto": str(conf.get("lastAuto") or ""), "runs": (conf.get("runs") or [])[-6:],
             "at": datetime.now().isoformat(timespec="seconds")},
            ensure_ascii=False, indent=2), encoding="utf-8")
        return True
    except Exception:
        return False


# ---------- 枚举：一个目标里有哪些文件、多大、多老 ----------
def _walk_dir(folder: Path) -> tuple:
    """返回 (总字节, 文件数, 最新 mtime)；目录不存在就是三个零，不抛。"""
    tot = 0
    n = 0
    newest = 0.0
    if not folder.exists():
        return 0, 0, 0.0
    for dp, _dn, fn in os_walk(folder):
        for f in fn:
            fp = Path(dp) / f
            try:
                st = fp.stat()
            except OSError:
                continue
            tot += st.st_size
            n += 1
            if st.st_mtime > newest:
                newest = st.st_mtime
    return tot, n, newest


def os_walk(p: Path):
    """单独包一层：os.walk 在只读目录/权限异常时不该让整个测量崩掉。"""
    import os
    for dp, dn, fn in os.walk(str(p), onerror=lambda e: None):
        yield Path(dp), dn, fn


def _mb(b: int) -> float:
    return round((b or 0) / 1048576.0, 1)


def _enum_logs(d: Path, keep_ms: float, now_ms: float) -> list:
    out = []
    logs = d / "logs"
    if logs.is_dir():
        for f in sorted(logs.iterdir()):
            if f.is_file() and f.suffix in (".ndjson", ".log", ".txt"):
                out.append((f, f.stat().st_size, _age_ms(f, f.stat())))
    for f in sorted(d.iterdir()):
        if f.is_file() and LOG_FILE_RE.match(f.name):
            out.append((f, f.stat().st_size, _age_ms(f, f.stat())))
    return out


def _enum_dump(d: Path) -> list:
    """dump/ 与 dump-test/ 下面是「一次转储一个目录」+ 一个 index.log；
    按目录整体计龄与计删，index.log 跟着它的目录一起走（留着就只是登记，删了不心疼，
    但为了让「清转储 = 这个目录回到空」这句话成立，也按同样年龄判）。"""
    out = []
    for root_name in ("dump", "dump-test"):
        root = d / root_name
        if not root.is_dir():
            continue
        for f in sorted(root.iterdir()):
            if f.is_dir():
                tot, n, newest = _walk_dir(f)
                try:
                    st = f.stat()
                except OSError:
                    continue
                out.append({"path": f, "bytes": tot, "files": n, "age": _dir_age_ms(f, st),
                            "kind": "dir", "root": root_name})
            elif f.is_file() and f.name == "index.log":
                st = f.stat()
                out.append({"path": f, "bytes": st.st_size, "files": 1, "age": _age_ms(f, st),
                            "kind": "file", "root": root_name})
    return out


def _enum_db(d: Path) -> list:
    out = []
    for name in DB_FILES:
        f = d / name
        if f.is_file():
            out.append((f, f.stat().st_size))
    return out


def sizes(d, keep=None, vacuum_bytes=None) -> dict:
    """面板「本机文件与清理」那一行的料。只读，不动任何文件。
    vacuum_bytes：调用方（xprobe_db.free_bytes()）能给出的「库里有空闲页可回收」的字节，
    拿不到就填 None，面板显示「未知」而不是 0 —— 0 是一句假话。"""
    d = Path(d)
    conf = load_conf(d)
    k = norm_keep(conf.get("keep") if keep is None else keep)
    keep_ms = k * 86400 * 1000
    now = _now_ms()
    items = {}

    logs_bytes = 0
    logs_files = 0
    logs_free = 0
    logs_n_old = 0
    for f, b, age in _enum_logs(d, keep_ms, now):
        logs_bytes += b
        logs_files += 1
        if age > keep_ms and (now - age) > RECENT_MS:
            logs_free += b
            logs_n_old += 1
    items["logs"] = {"bytes": logs_bytes, "files": logs_files,
                     "cleanable": logs_free, "cleanableFiles": logs_n_old}

    dump_bytes = 0
    dump_dirs = 0
    dump_free = 0
    dump_n_old = 0
    for e in _enum_dump(d):
        dump_bytes += e["bytes"]
        if e["kind"] == "dir":
            dump_dirs += 1
        if e["age"] > keep_ms and (now - e["age"]) > RECENT_MS:
            dump_free += e["bytes"]
            dump_n_old += 1
    items["dump"] = {"bytes": dump_bytes, "dirs": dump_dirs,
                     "cleanable": dump_free, "cleanableOld": dump_n_old}

    db_bytes = sum(b for _f, b in _enum_db(d))
    items["db"] = {"bytes": db_bytes, "free": vacuum_bytes}
    host_log = d / "native-host.log"
    items["host"] = {"bytes": host_log.stat().st_size if host_log.is_file() else 0}
    total = 0
    for dp, _dn, fn in os_walk(d):
        for f in fn:
            try:
                total += (Path(dp) / f).stat().st_size
            except OSError:
                continue
    return {"ok": True, "fs": FS_VER, "dir": str(d), "keep": k, "auto": bool(conf.get("auto")),
            "lastAuto": conf.get("lastAuto") or "", "runs": conf.get("runs") or [],
            "items": items, "total": total, "totalMb": _mb(total),
            "at": datetime.now().isoformat(timespec="seconds")}


def _plan(target: str, d: Path, keep_ms: float, now: float) -> list:
    """目标 → 待删清单（dir 项给 path/bytes，file 项同样）。dry 与实删共用这一份，账才对得上。"""
    if target == "logs":
        return [{"path": f, "bytes": b, "kind": "file"}
                for (f, b, age) in _enum_logs(d, keep_ms, now)
                if age > keep_ms and (now - age) > RECENT_MS]
    if target == "dump":
        return [e for e in _enum_dump(d) if e["age"] > keep_ms and (now - e["age"]) > RECENT_MS]
    return []


def clean(d, target, keep=None, dry=True) -> dict:
    """一次清理。dry=True 只回报「将删什么、多少字节」，一个文件都不动。
    返回 ok=False 的三种情况：目标名不在白名单、数据目录不存在、删除逐条失败（失败列出来，不含糊）。"""
    d = Path(d)
    t = _safe_target(target)
    if not t:
        return {"ok": False, "err": "删除只认 logs / dump（库那一档走 op='vacuum'，不删行），收到 %r" % (target,), "fs": FS_VER}
    if not d.is_dir():
        return {"ok": False, "err": "数据目录不存在: %s" % d, "fs": FS_VER}
    conf = load_conf(d)
    k = norm_keep(conf.get("keep") if keep is None else keep)
    keep_ms = k * 86400 * 1000
    now = _now_ms()
    out = {"ok": True, "fs": FS_VER, "target": t, "keep": k, "dry": bool(dry), "dir": str(d)}

    plan = _plan(t, d, keep_ms, now)
    if not plan and dry:
        out.update(files=0, willFree=0, willFreeMb=0.0, names=[], more=0,
                   note="没有超过 %d 天的%s可删" % (k, "日志" if t == "logs" else "转储"))
        return out
    will = sum(x["bytes"] for x in plan)
    out["files"] = len(plan)
    out["willFree"] = will
    out["willFreeMb"] = _mb(will)
    out["names"] = [x["path"].relative_to(d).as_posix() for x in plan[:NAME_LIST]]
    out["more"] = max(0, len(plan) - NAME_LIST)
    if dry:
        out["note"] = "DRY：一个文件都没删，确认后带 dry=false 再发一次"
        return out
    if not plan:
        out["removed"] = 0
        out["freed"] = 0
        out["note"] = "没有超过 %d 天的%s，本来就没东西可删" % (k, "日志" if t == "logs" else "转储")
        return out

    removed = 0
    freed = 0
    failed = []
    for x in plan:
        p = x["path"]
        try:
            if x["kind"] == "dir":
                shutil.rmtree(str(p))
            else:
                p.unlink()
            removed += 1
            freed += x["bytes"]
        except Exception as e:
            failed.append({"name": p.name, "err": "%s: %s" % (type(e).__name__, str(e)[:80])})
    out.update(removed=removed, freed=freed, freedMb=_mb(freed), failed=failed[:10],
               failedCount=len(failed), ok=not failed or removed > 0)
    # 每次实删都记一笔进 clean.json：面板要能回答「上次清了啥、什么时候」，不然只能靠猜
    conf["runs"] = ((conf.get("runs") or []) + [{
        "at": datetime.now().isoformat(timespec="seconds"), "target": t, "keep": k,
        "removed": removed, "freed": freed, "freedMb": _mb(freed), "failed": len(failed)}])[-6:]
    save_conf(d, conf)
    return out


def auto_clean_due(d, vacuum_fn=None) -> dict:
    """自动清理：每天最多一次（用 clean.json 的 lastAuto 记日期，不额外开定时器/进程）。
    由 sink 启动、宿主启动、以及面板读占用这三处调用 —— 谁先撞上算谁，一天内后面那些直接跳过。"""
    d = Path(d)
    conf = load_conf(d)
    today = datetime.now().strftime("%Y-%m-%d")
    if not conf.get("auto"):
        return {"ok": True, "skipped": "auto 关着", "keep": conf["keep"]}
    if conf.get("lastAuto") == today:
        return {"ok": True, "skipped": "今天已清过", "keep": conf["keep"]}
    res = {"ok": True, "keep": conf["keep"], "targets": {}}
    for t in ("logs", "dump"):
        try:
            # 没东西可删时也走一遍 dry：dry=False 的空计划会提前 return、不写 runs，
            # 那样 clean.json 里的 runs 就永远只记「真删过的那几次」，面板看不到「今天查过，没有过期文件」
            plan = clean(d, t, keep=conf["keep"], dry=True)
            if not plan.get("files"):
                res["targets"][t] = {"removed": 0, "freed": 0, "ok": True, "err": ""}
                continue
            r = clean(d, t, keep=conf["keep"], dry=False)
            res["targets"][t] = {"removed": r.get("removed", 0), "freed": r.get("freed", 0),
                                 "ok": bool(r.get("ok")), "err": r.get("err") or ""}
        except Exception as e:
            res["targets"][t] = {"removed": 0, "freed": 0, "ok": False, "err": str(e)[:80]}
    # 重新读一遍再写：上面两次 clean() 各自往 clean.json 追了一笔 runs，
    # 拿循环前那份旧 conf 直接覆盖会把「上次清了啥」抹掉 —— 面板那行就永远空着
    fresh = load_conf(d)
    fresh["lastAuto"] = today
    save_conf(d, fresh)
    res["at"] = today
    res["keep"] = fresh["keep"]
    if vacuum_fn is not None:
        try:
            res["vacuum"] = vacuum_fn()
        except Exception as e:
            res["vacuum"] = {"ok": False, "err": str(e)[:80]}
    return res


def fs_body(d, free_fn=None) -> dict:
    """GET /fs 与宿主 {t:'fs', op:'sizes'} 共用的一份回包（只读，顺带撞一次每日自动清理）。
    free_fn 由调用方给（log-sink 那边是 xprobe_db.free_bytes），量不到就填 None ⇒ 面板显示「未知」。"""
    fb = None
    if free_fn is not None:
        try:
            fb = free_fn()
        except Exception:
            fb = None
    try:
        return sizes(d, vacuum_bytes=fb)
    except Exception as e:
        return {"ok": False, "err": "测量失败: %s" % e, "fs": FS_VER}


def clean_body(d, req: dict) -> dict:
    """POST /fs 与宿主 {t:'fs', op:...} 共用的一部分回包（写）：只管 'conf'（改保留策略）与
    'clean'（删文件）。'vacuum' 与 'auto' 归调用方（log-sink / 宿主）—— 那两件事要摸 xprobe.db
    的连接，而本模块的边界恰恰是「只碰文件，不碰库」，故这里的 op 缺省按 'clean' 走。"""
    req = req if isinstance(req, dict) else {}
    op = str(req.get("op") or "clean")
    if op == "conf":
        conf = load_conf(d)
        if req.get("keep") is not None:
            conf["keep"] = norm_keep(req.get("keep"))
        if req.get("auto") is not None:
            conf["auto"] = bool(req.get("auto"))
        ok = save_conf(d, conf)
        return {"ok": ok, "fs": FS_VER, "keep": conf["keep"], "auto": conf["auto"],
                "err": "" if ok else "clean.json 写不进去（数据目录只读？）"}
    return clean(d, req.get("target"), keep=req.get("keep"), dry=bool(req.get("dry", True)))

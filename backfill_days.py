#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""backfill_days.py —— 把「每人每天一行」的表直接维护进本机档案库（不经过浏览器）。

为什么要有这个：面板上的日线表写的是 chrome.storage.local，只有 Side Panel 能写；
而真档案库 xprobe.db 是 sink 落盘的那一份。用户给了一张确认过的四列表（时间/曝光/关注/粉丝/帖子），
要「直接维护到数据库」——那就走 sink 用的同一个 ingest()，形状、幂等键、双写 day_rows 全一致，
别另写一套 SQL 插进去（那会造出「库里有行但 records 里没原文」的对不上账）。

默认 DRY：只打印将要写入的行与算出来的 key，不碰库。加 --apply 才写；--undo 按同一批 key 删回去。
缩写曝光（13.2K / 10.1k）一律 exact=0 且 token 存原文 —— 与采集器读到缩写时同一个记号，别冒充精确值。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import xprobe_db as xdb  # noqa: E402

# 示例数据：换成你自己的历史日点（value = 总曝光，token = 页面上看到的缩写读数，
# fow = 正在关注，fans = 粉丝，posts = 帖子总数）。默认 DRY，只有 --apply 才写库。
DAYS = [
    {"day": "2026-01-01", "value": 1000, "token": "1.0K", "fow": 100, "fans": 90,  "posts": 120},
    {"day": "2026-01-02", "value": 1200, "token": "1.2K", "fow": 110, "fans": 100, "posts": 126},
    {"day": "2026-01-03", "value": 1500, "token": "1.5K", "fow": 120, "fans": 110, "posts": 131},
    {"day": "2026-01-04", "value": 1800, "token": "1.8K", "fow": 130, "fans": 120, "posts": 137},
]


def recs_for(own: str) -> list:
    out = []
    for d in DAYS:
        # at 用当天 23:59（日终读数）：day_latest 按 at 取每列最后有数的，
        # 拿日终而不是「现在」，第二天再采到同一天的自动值时才盖得过这条补录。
        at = "%sT23:59:00.000Z" % d["day"]
        out.append({"kind": "reward", "at": at, "url": "https://x.com/%s" % own, "tab": "profile",
                    "t": 0, "ver": "0.6.11", "build": "backfill", "host": "cli",
                    "data": {"own": own, "day": d["day"], "manual": 1, "hit": True,
                             "value": d["value"], "exact": False, "token": d["token"],
                             "fow": d["fow"], "fans": d["fans"], "posts": d["posts"],
                             "keyNodes": 0, "cands": [], "added": True,
                             "why": "用户 2026-10-24 截图确认的四列表，命令行补录（backfill_days.py）"}})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=r"D:\code\yunxiao\temp\xprobe\xprobe.db")
    ap.add_argument("--own", default="demo_own")
    ap.add_argument("--apply", action="store_true", help="真的写库（默认只 DRY 打印）")
    ap.add_argument("--undo", action="store_true", help="按同一批 key 删掉（回滚）")
    ap.add_argument("--only", default="", help="只写某一天（试点用），如 --only 2026-10-20")
    a = ap.parse_args()

    recs = recs_for(a.own)
    if a.only:
        recs = [r for r in recs if r["data"]["day"] == a.only]
        if not recs:
            print("!! --only %s 不在这批里" % a.only); return 1
    keys = [xdb.rec_key(r) for r in recs]
    print("库: %s" % a.db)
    print("台账（key = 内容哈希，重跑幂等）:")
    for k, r in zip(keys, recs):
        d = r["data"]
        print("  %s  %-10s 曝光=%s(%s) 关注=%s 粉丝=%s 帖子=%s" % (
            k, d["day"], d["value"], d["token"], d["fow"], d["fans"], d["posts"]))

    if not Path(a.db).exists():
        print("!! 库文件不存在，停"); return 1
    if not xdb.open_db(a.db):
        print("!! 打不开库: %s" % xdb._DB["err"]); return 1

    conn = xdb._DB["conn"]
    if a.undo:
        q = ",".join(["?"] * len(keys))
        for t in ("day_rows", "reward_points", "records"):
            n = conn.execute("DELETE FROM %s WHERE key IN (%s)" % (t, q), keys).rowcount
            print("  删 %-14s %d 行" % (t, n))
        conn.commit()
        print("回滚完成（只删上面这批 key，别的行没动）")
        return 0

    if not a.apply:
        now = {t: conn.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
               for t in ("records", "reward_points", "day_rows")}
        have = {r[0]: r[1] for r in conn.execute(
            "SELECT key, COUNT(*) FROM day_rows WHERE handle=? GROUP BY key", (a.own,))}
        dup = [k for k in keys if k in have]
        print("DRY：库里现有 %s；这批 key 已在库里的 %d 条（重跑不会新增）" % (json.dumps(now, ensure_ascii=False), len(dup)))
        print("加 --apply 才写。")
        return 0

    for r in recs:
        code = xdb.ingest(r, "backfill 四列补录")
        print("  ingest -> %d (1=新增 0=已存在 -3=失败)" % code)
        if code == xdb.FAIL:
            print("!! 写入失败: %s" % xdb._DB["err"]); return 1
    for t in ("records", "reward_points", "day_rows"):
        print("  现在 %-14s %d 行" % (t, conn.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]))
    print("复核：python -X utf8 xprobe_db.py --db \"%s\" --query day_rows --limit 20" % a.db)
    return 0


if __name__ == "__main__":
    sys.exit(main())

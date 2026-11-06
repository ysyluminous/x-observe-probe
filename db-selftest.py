#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sink-9 档案库自检：不碰浏览器、不碰 X，自己起一个临时端口的 log-sink 子进程走完整管道。

用法:
  python -X utf8 db-selftest.py                      # 合成记录 + HTTP 端到端（约 5 秒）
  python -X utf8 db-selftest.py --logs "%USERPROFILE%\\xprobe\\logs"   # 再加一遍真机档案重放

为什么每条断言都要「正向 + 反向」成对：这一轮先踩的是「列数与占位符对不上」——主表写成功了、
子表当场抛异常，日志看起来一切正常，库里却是空的；只写正向断言根本抓不到。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = 8791
BASE = "http://127.0.0.1:%d" % PORT

FAILS = []
CHECKS = [0]


def ck(name, cond, got):
    CHECKS[0] += 1
    if not cond:
        FAILS.append(name)
    print(("  ok   " if cond else "  FAIL ") + str(name) + " -> " + json.dumps(got, ensure_ascii=False, default=str)[:220])


def http(path, obj=None, timeout=6, base=BASE):
    url = base + path
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8") if obj is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8")), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8")), e.code


def _sink_num(v):
    m = re.search(r"(\d+)$", str(v or ""))
    return int(m.group(1)) if m else 0


# 宿主版本同理：每加一种通道就换号（native-2 = 带 /fs 那一档），断言只要求「至少到那一档」
def _host_num(v):
    m = re.search(r"(\d+)$", str(v or ""))
    return int(m.group(1)) if m else 0


def wait_ping(tries=80, base=BASE):
    last = None
    for _ in range(tries):
        try:
            o, _code = http("/ping", timeout=2, base=base)
            if o.get("ok"):
                return o
            last = o
        except Exception as e:
            last = str(e)
        time.sleep(0.25)
    raise SystemExit("sink 起不来（端口 %s）: %s" % (PORT, last))


# ---------------- 合成记录：形状照 core.js 真发的字段（store 那条按 v0.6.9 的分池形状） ----------------
def page_rec(at, handle, tab, articles, user_handles, rewards=None):
    return {"kind": "page", "at": at, "url": "https://x.com/" + handle, "tab": tab, "t": 0,
            "ver": "0.6.4", "build": "2026-10-23-o", "host": "extension",
            "handle": handle, "tabType": tab, "hydrated": True, "attempt": 1,
            "usersScope": "primary", "userCellInDoc": len(user_handles), "userRows": len(user_handles),
            "miss": ["metric.like x7"], "note": ["stats.__foreign x2(已排除)"],
            "cov": {"articles": articles, "ads": 1, "clean": max(0, articles - 1), "tweetId": "%d/%d" % (articles, articles)},
            "covUsers": {"rows": len(user_handles), "handle": "%d/%d" % (len(user_handles), len(user_handles)),
                         "name": "0/31", "nameHow": {"anchorText": 31}},
            "data": {"at": at, "url": "https://x.com/" + handle, "title": handle + " on X", "tab": tab,
                     "hydrated": True,
                     "identity": {"handle": handle, "displayName": "示例甲", "displayNameDirty": "示例甲 sponsored",
                                  "nameForeign": 1, "nameTokens": {"xro-badge": 1}, "hasHeader": True,
                                  "followRelation": "self"},
                     "stats": {"__tabs": {"posts": 120}, "following": {"value": 2754}, "followers": {"value": 2690}},
                     "rewards": rewards, "foreignNodes": 3, "nameStripAll": 0, "usersScope": "primary",
                     "tweets": [{"idx": i, "tweetId": "10" + str(i), "statusHref": "/%s/status/10%d" % (handle, i),
                                 "author": handle, "authorName": "示例甲", "authorNameDirty": "示例甲 sponsored",
                                 "text": "第 %d 条正文" % i, "timeDatetime": "2026-10-22T0%d:00:00.000Z" % i,
                                 "adSuspect": 1 if i == 0 else 0, "followState": "", "hasPhoto": i % 2 == 1,
                                 "isRetweet": False, "summaryAria": "2 回复、3 转推、40 次点赞",
                                 "metrics": {"reply": {"num": {"src": "2 回复", "token": "2", "value": 2, "exact": True}},
                                             "view": {"num": {"value": 10100, "exact": False, "token": "10.1k"}}},
                                 "authorTokens": {}, "html": "<article>..%d..</article>" % i}
                                for i in range(articles)],
                     "users": [{"idx": i, "handle": h, "name": "名" + h, "nameHow": "UserName",
                                "nameRaw": "名" + h, "nameDirty": "名" + h + " sponsored", "origin": "list",
                                "mod": "", "followState": "following", "followAria": "正在关注 @" + h,
                                "hasBio": True, "bio": "简介 " + h, "cellText": "名%s @%s 正在关注" % (h, h),
                                "nameForeign": 1, "nameTokens": {"xro-badge": 1},
                                "leafShapes": [["span", "", "名" + h]], "cands": [], "html": "<div>.." + h + "..</div>"}
                               for i, h in enumerate(user_handles)]}}


def rewards_shape():
    return {"hit": True, "value": 10100, "exact": False, "token": "10.1k", "keyNodes": 1,
            "cands": [{"nums": [{"token": "90"}, {"token": "50 万"}, {"token": "10.1k"}], "threshold": ["90", "50 万"]}]}


def batch(recs):
    return {"ver": "0.6.4", "build": "2026-10-23-o", "host": "extension",
            "sentAt": "2026-10-23T05:05:31.000Z", "records": recs}


RECS = [
    page_rec("2026-10-23T05:00:00.000Z", "demo_own", "profile", 5, ["aaa", "bbb", "ccc"]),
    page_rec("2026-10-23T05:01:00.000Z", "demo_peer", "rewards", 0, [], rewards_shape()),
    {"kind": "follow", "at": "2026-10-23T05:02:00.000Z", "url": "https://x.com/zz_d", "tab": "profile", "t": 0,
     "ver": "0.6.4", "host": "extension",
     "data": {"dir": "follow", "targetId": "987654321", "handle": "zz_d", "why": "attr",
              "from": "follow→unfollow", "suspect": False, "w15": 3, "w24": 12, "max15": 15, "max24": 400,
              "over15": False, "over24": False, "gap": 61000, "rapid": False, "cool": 60000}},
    {"kind": "follow", "at": "2026-10-23T05:02:30.000Z", "url": "https://x.com/zz_e", "tab": "profile", "t": 0,
     "ver": "0.6.4", "host": "extension",
     "data": {"dir": "follow", "targetId": "987654322", "handle": "zz_e", "why": "attr",
              "from": "follow→unfollow", "w15": 4, "w24": 13, "max15": 15, "max24": 400,
              "gap": 30000, "rapid": True, "cool": 60000}},
    {"kind": "stat", "at": "2026-10-23T05:03:00.000Z", "url": "https://x.com/home", "tab": "home", "t": 0,
     "ver": "0.6.4",
     "data": {"reason": "minute", "following": 2754, "followers": 2690, "exact": False,
              "handle": "demo_own", "vals": {"following": "2,754", "followers": "2.7K"}}},
    {"kind": "block", "at": "2026-10-23T05:04:00.000Z", "url": "https://x.com/home", "tab": "home", "t": 0,
     "ver": "0.8.4", "host": "extension",
     "data": {"handle": "carl", "name": "卡尔", "on": 1}},
    {"kind": "block", "at": "2026-10-23T05:05:00.000Z", "url": "https://x.com/home", "tab": "home", "t": 0,
     "ver": "0.8.4", "host": "extension",
     "data": {"handle": "dave", "name": "", "on": 1}},
    {"kind": "block", "at": "2026-10-23T05:06:00.000Z", "url": "https://x.com/home", "tab": "home", "t": 0,
     "ver": "0.8.4", "host": "extension",
     "data": {"handle": "dave", "name": "", "on": 0}},
    {"kind": "reward", "at": "2026-10-23T05:03:30.000Z", "url": "https://x.com/i/jf/creators", "tab": "rewards",
     "t": 0, "ver": "0.6.4",
     "data": {"own": "demo_own", "day": "2026-10-23", "hit": True, "value": 10100, "exact": False,
              "token": "10.1k", "text": "过去 90 天内，累积至少 50 万次已验证首页时间线曝光", "keyNodes": 1,
              "added": True, "cands": [{"nums": [{"token": "90"}, {"token": "50 万"}, {"token": "10.1k"}],
                                        "threshold": ["90", "50 万"]}]}},
    {"kind": "reward", "at": "2026-10-23T05:04:00.000Z", "url": "https://x.com/i/jf/creators", "tab": "rewards",
     "t": 0, "ver": "0.6.4",
     "data": {"own": "demo_own", "day": "2026-10-23", "hit": True, "value": 10500, "exact": False,
              "token": "10.5k", "keyNodes": 1, "added": True, "cands": []}},
    # v0.6.9 收尾：面板把装插件之前的日子手补进来 —— 四列里没填的列是空（曝光是 None，不是 0）；
    # day 用 10-20（装插件前几天），reward_days 视图上它与 10-23 各自成行
    {"kind": "reward", "at": "2026-10-23T05:05:00.000Z", "url": "https://x.com/demo_own", "tab": "profile",
     "t": 0, "ver": "0.6.9",
     "data": {"own": "demo_own", "day": "2026-10-20", "manual": 1, "hit": False, "value": None,
              "exact": False, "fow": 2754, "fans": 2690, "posts": 2870, "added": True}},
    # v0.6.11「每人每天一行」的自动腿：打开别人的主页落的行 —— handle 是**被看的那个人**，
    # 曝光永远是 None（只有自己的奖励页有曝光数）。第二条只补帖子列，专门用来钉 day_latest 的
    # **按列**取值：整行取最新的话，先落那两列（关注/粉丝）会被说成没有。
    {"kind": "dayrow", "at": "2026-10-23T05:05:10.000Z", "url": "https://x.com/demo_peer", "tab": "profile",
     "t": 0, "ver": "0.6.11",
     "data": {"handle": "demo_peer", "day": "2026-10-23", "value": None, "exact": False, "token": "",
              "fow": 812, "fans": 1290, "posts": None, "source": "profile", "added": True}},
    {"kind": "dayrow", "at": "2026-10-23T05:05:20.000Z", "url": "https://x.com/demo_peer", "tab": "profile",
     "t": 0, "ver": "0.6.11",
     "data": {"handle": "demo_peer", "day": "2026-10-23", "value": None, "exact": False, "token": "",
              "fow": None, "fans": None, "posts": 45, "manual": 1, "source": "panel", "added": True}},
    {"kind": "store", "at": "2026-10-23T05:04:30.000Z", "url": "https://x.com/home", "tab": "home", "t": 0,
     "ver": "0.6.9",
     "data": {"counts": {"users": 3, "posts": 2, "series": {"handles": 1, "min": 40, "imp": 3}},
              "users": [{"h": "aaa", "n": "名aaa", "f": 2690, "fw": 2754, "fe": True, "rel": "following",
                         "own": False, "seenAs": {"list": 2}, "pts": 5, "sn": 1},
                        # bbb 是「只见过、没数字」那一类：core v0.6.9 起它要让位给带数字的行，
                        # 所以摘要行必须能把两组分开打出来（上一版按 updatedAt 切，12 格全是这种行）
                        {"h": "bbb", "n": "名bbb", "f": None, "fw": None, "fe": None, "rel": "none",
                         "own": False, "seenAs": {"list": 1}, "pts": 1, "sn": 0},
                        {"h": "demo_own", "n": "示例甲", "f": 2690, "fw": 2754, "fe": True, "rel": "self",
                         "own": True, "seenAs": {"profile": 4}, "pts": 8, "sn": 1}],
              "posts": [{"id": "11", "h": "aaa", "t": "正文甲", "fs": "2026-10-22T01:00:00.000Z",
                         "rp": 2, "rt": 3, "lk": 40, "vw": 10100, "n": 2, "sn": 1},
                        {"id": "22", "h": "bbb", "t": "正文乙", "fs": "2026-10-23T01:00:00.000Z",
                         "rp": None, "rt": None, "lk": None, "vw": None, "n": 1, "sn": 0}],
              "groups": {"uNum": 2, "uBare": 1, "pNum": 1, "pBare": 1},
              "trim": {"usersKept": 3, "postsKept": 2, "usersDropped": 0, "postsDropped": 7,
                       "usersMax": 600, "postsMax": 1200, "postsFull": False}}},
    {"kind": "beacon", "at": "2026-10-23T05:05:00.000Z", "url": "https://x.com/home", "tab": "home", "t": 0,
     "ver": "0.6.4", "build": "2026-10-23-o", "host": "extension",
     "data": {"ver": "0.6.4", "build": "2026-10-23-o", "host": "extension", "f15": 3, "f24": 12,
              "users": 3, "posts": 2, "series": "40min/3day"}},
    {"kind": "err", "at": "2026-10-23T05:05:30.000Z", "url": "https://x.com/home", "tab": "home", "t": 0,
     "ver": "0.6.4", "data": {"msg": "GM_xmlhttpRequest 拒发: 非本机地址"}},
]


def leg_unit(xdb):
    print("\n[A] 取值口径（库里不许出现要靠猜才读得懂的数）")
    ck("_n：缩写串一律拒收", [xdb._n("2.7K"), xdb._n("10.1k"), xdb._n("1,010"), xdb._n("50 万")] == [None] * 4,
       [xdb._n("2.7K"), xdb._n("10.1k"), xdb._n("1,010"), xdb._n("50 万")])
    ck("_n：真数字照收（整数不留 .0）",
       [xdb._n(2690), xdb._n("2690"), xdb._n(10100.0), xdb._n(-5), xdb._n(True)] == [2690, 2690, 10100, -5, 1],
       [xdb._n(2690), xdb._n("2690"), xdb._n(10100.0), xdb._n(-5), xdb._n(True)])
    ck("_n：空值不掺 0", [xdb._n(None), xdb._n(""), xdb._n("abc")] == [None, None, None],
       [xdb._n(None), xdb._n(""), xdb._n("abc")])
    a = xdb.rec_key({"kind": "page", "at": "X", "data": {"a": 1}, "receivedAt": "2026-10-23T00:00:00.000Z", "peer": "127.0.0.1"})
    b = xdb.rec_key({"kind": "page", "at": "X", "data": {"a": 1}, "receivedAt": "2026-10-23T00:00:09.000Z", "peer": "10.0.0.2"})
    c = xdb.rec_key({"kind": "page", "at": "X", "data": {"a": 2}})
    ck("rec_key：内容相同、时间不同 ⇒ 同一个 key（重发只入档一次）", a == b, [a, b])
    ck("rec_key：内容不同 ⇒ 不同 key（别把两条记录吞成一条）", a != c, [a, c])


def lean_raw_page(tmp):
    """读库里 page 那行的 raw：用来证明浏览器丢掉的原文是「拆表存」，不是整份塞回 raw 里再涨一遍。"""
    import sqlite3
    conn = sqlite3.connect(str(Path(tmp) / "xprobe.db"))
    try:
        row = conn.execute("SELECT raw FROM records WHERE kind='page' ORDER BY at LIMIT 1").fetchone()
        return json.loads(row[0]) if row else {}
    finally:
        conn.close()


def leg_posts(xdb, tmp):
    """[D] v0.7.0 的「一条帖子一行、每次抓取一个点」：帖子与账号两张视图。
    用独立的小库直接喂 _page（不经过 HTTP），因为这里要造「同一帖跨两小时两次采样」这种
    真实管道里要等很久才出现的形状。跑的是 QUERIES 里的原文，不是另抄一份 SQL。"""
    import sqlite3
    print("\n[D] 帖子/账号视图（同一帖多次采样 ⇒ 增速；没数不许冒充 0）")
    conn = sqlite3.connect(str(Path(tmp) / "posts.db"))
    conn.executescript(xdb.SCHEMA)
    xdb._migrate(conn)

    def tw(idx, tid, author, view=None, like=None, reply=None, liked=False, ad=False, fs="following"):
        m = {}
        if view is not None:
            m["view"] = {"num": {"value": view, "exact": True}}
        if like is not None:
            m["like"] = {"num": {"value": like, "exact": False}}
        if reply is not None:
            m["reply"] = {"num": {"value": reply, "exact": True}}
        return {"idx": idx, "tweetId": tid, "author": author, "text": "正文 " + tid,
                "timeDatetime": "2026-10-24T08:00:00.000Z", "followState": fs,
                "adSuspect": ad, "liked": liked, "metrics": m}

    rounds = [
        # 10:00 首采；12:00 同一帖再采一次（曝光 100→400、赞 5→20、回 2→8，顺手点了赞）
        ("2026-10-24T10:00:00.000", [tw(0, "9001", "alice", 100, 5, 2),
                                     tw(1, "9002", "bob", 50, 1, 0, fs="not_following")]),
        ("2026-10-24T12:00:00.000", [tw(0, "9001", "alice", 400, 20, 8, liked=True)]),
        # dave/carl 一个指标都没有：必须在榜尾并进「取关候选」，但 fans 一个是 None 一个有数
        ("2026-10-24T13:00:00.000", [tw(0, "9003", "dave"), tw(1, "9004", "carl"),
                                     tw(2, "9999", "ad", 9999, 999, 99, ad=True)]),
    ]
    for at, tweets in rounds:
        xdb._page(conn, "s" + at, {"at": at, "tabType": "home", "handle": "alice"},
                  {"tweets": tweets, "users": []})
    for key, h, name, fans, rel in (("u1", "alice", "爱丽丝", 3000, "following"),
                                    ("u2", "carl", "卡尔", 2000, "following"),
                                    ("u3", "erin", "艾琳", 500, "following")):
        conn.execute("INSERT INTO store_users(key, at, handle, name, followers, relation, own)"
                     " VALUES(?, '2026-10-24T13:00:00.000', ?, ?, ?, ?, 0)", (key, h, name, fans, rel))
    conn.commit()

    def q(name, limit=20):
        cur = conn.execute(xdb.QUERIES[name], (limit,))
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    ck("库版本回到 db-10（v0.11.5 曾抬 db-11 加 own_posts 做 AI 样本；用户撤了那半截，v0.11.6 一并撤掉；db-8 是 v0.10.6）",
       xdb.DB_VER == "db-10"
       and xdb._DB["conn"].execute("SELECT v FROM meta WHERE k='db_ver'").fetchone()[0] == "db-10",
       xdb.DB_VER)
    pts = conn.execute("SELECT tweet_id, COUNT(*) FROM post_points GROUP BY tweet_id"
                       " ORDER BY tweet_id").fetchall()
    ck("一条帖子一行、每次抓取一个点：9001 两点，9002/9003/9004 各一点，推广位 9999 不入",
       pts == [("9001", 2), ("9002", 1), ("9003", 1), ("9004", 1)], pts)
    top = q("posts_top")
    ck("曝光榜：9001 取最新那点 400 排第一，一个指标都没有的两条垫底（不是当 0 排中间）",
       (top[0]["tweet_id"], top[0]["view"]) == ("9001", 400)
       and {r["tweet_id"] for r in top if r["view"] is None} == {"9003", "9004"}
       and all(r["view"] is None for r in top[2:]),
       [(r["tweet_id"], r["view"]) for r in top])
    g = {r["tweet_id"]: r for r in q("posts_growth")}
    ck("增速 =（最新-首次）/相隔小时：9001 100→400 跨 2 小时 ⇒ 150.0/时、净增 300",
       [g["9001"]["view_per_h"], g["9001"]["view_gain"], g["9001"]["hours"]] == [150.0, 300, 2.0],
       [g["9001"]["view_per_h"], g["9001"]["view_gain"], g["9001"]["hours"]])
    ck("只有一次采样的帖子 view_per_h 必须是 None 不是 0（0 会被读成「涨得最慢」）",
       g["9002"]["points"] == 1 and g["9002"]["view_per_h"] is None
       and g["9001"]["points"] == 2, [g["9002"]["points"], g["9002"]["view_per_h"], g["9001"]["points"]])
    ck("互动率=互动/曝光、点赞效率=赞/曝光：9001 最新 赞20+回8=28 ⇒ 7.0% / 5.0%",
       [g["9001"]["eng"], g["9001"]["eng_rate"], g["9001"]["like_rate"]] == [28, 7.0, 5.0],
       [g["9001"]["eng"], g["9001"]["eng_rate"], g["9001"]["like_rate"]])
    lk = [r[0] for r in conn.execute("SELECT liked FROM tweets WHERE tweet_id='9001' ORDER BY id")]
    ck("已点赞跟着每个点进库（9001 首采 0、再采 1），没这条的帖子写 0 不是 NULL",
       lk == [0, 1] and conn.execute("SELECT liked FROM tweets WHERE tweet_id='9002'").fetchone()[0] == 0, lk)
    # v0.8.4 拉黑流水：直喂 _simple（与这腿喂 _page 同一路数，不经过 HTTP）。
    # carl 拉了留着；dave 拉了又取消 —— 「现在还在不在」必须按最新一条判，取消过的不冒充还在。
    for i, (key2, hh, nm, on) in enumerate((("b1", "carl", "卡尔", 1), ("b2", "dave", "", 1), ("b3", "dave", "", 0))):
        xdb._simple(conn, key2, {"kind": "block", "at": "2026-10-24T1%d:00:00.000" % (4 + i),
                                 "url": "https://x.com/home"},
                    {"handle": hh, "name": nm, "on": on})
    conn.commit()
    acc = q("accounts")
    order = [r["handle"] for r in acc]
    byh = {r["handle"]: r for r in acc}
    ck("账号榜按互动降序：alice 28 > bob 1 > carl/dave 0，erin（没抓到帖子）垫底",
       order == ["alice", "bob", "carl", "dave", "erin"]
       and byh["alice"]["eng"] == 28 and byh["alice"]["views"] == 400
       and byh["alice"]["fans"] == 3000 and byh["alice"]["posts_n"] == 1
       and byh["erin"]["eng"] is None, [(r["handle"], r["eng"]) for r in acc])
    ck("账号行的关注关系：store_users 有的用它（alice following）、没有的退到帖子 follow_state（bob not_following）",
       byh["alice"]["relation"] == "following" and byh["bob"]["relation"] == "not_following",
       [byh["alice"]["relation"], byh["bob"]["relation"]])
    ck("拉黑入库：carl 一条、dave 两条（拉了又取消），append-only 一事件一行",
       conn.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == 3
       and [(r[0], r[1]) for r in conn.execute("SELECT handle, state FROM blocks ORDER BY id")]
       == [("carl", 1), ("dave", 1), ("dave", 0)],
       conn.execute("SELECT handle, state FROM blocks ORDER BY id").fetchall())
    ck("blocked_now 只认还在名单上的：carl 在、拉了又取消的 dave 不在（取消过不冒充还在）",
       {r[0] for r in conn.execute("SELECT handle FROM blocked_now")} == {"carl"},
       conn.execute("SELECT handle FROM blocked_now").fetchall())
    ck("账号行带 blocked 列：carl 1、dave 0、没动过的 alice 0",
       [byh["carl"]["blocked"], byh["dave"]["blocked"], byh["alice"]["blocked"]] == [1, 0, 0],
       [(r["handle"], r["blocked"]) for r in acc])
    bl = q("blocks")
    ck("白名单查询 blocks 可用（最新在前：dave 的取消在最顶上）",
       bl[0]["handle"] == "dave" and bl[0]["state"] == 0, bl[:1])
    # ---- v0.9.0 标杆名单（同样直喂 _simple，不动 HTTP 腿那条 records 基线）----
    # 七种形状都要有：进榜 / 换标签（latest-wins）/ 进榜又取消 / 库里根本没数的人（frank）/ 已拉黑的人（carl）。
    for i, (key3, hh, nm, on, tg) in enumerate((
            ("m1", "alice", "爱丽丝", 1, ["投资", "AI"]),
            ("m2", "bob", "鲍勃", 1, "ai, 量化"),        # 字符串形态：逗号+空格也要拆干净
            ("m3", "erin", "艾琳", 1, None),             # 没标签 = 空串，不是 "None"
            ("m4", "erin", "艾琳", 0, None),             # 进榜又取消
            ("m5", "dave", "戴夫", 1, ["旧"]),
            ("m6", "dave", "戴夫", 1, ["新"]),            # 改分类 = 再落一行，视图认最新
            ("m7", "frank", "弗兰克", 1, ["投资"]),      # 本机一条数都没抓到过的人
            ("m8", "carl", "卡尔", 1, ["已拉黑"]))):
        xdb._simple(conn, key3, {"kind": "bench", "at": "2026-10-24T14:0%d:00.000" % i,
                                 "url": "https://x.com/home"},
                    {"handle": hh, "name": nm, "on": on, "tags": tg})
    conn.commit()
    ck("标杆入库：八条流水、一事件一行（改分类和取消都是新行，历史不被覆盖）",
       conn.execute("SELECT COUNT(*) FROM benchmarks").fetchone()[0] == 8
       and [r[0] for r in conn.execute("SELECT handle FROM benchmarks ORDER BY id")]
       == ["alice", "bob", "erin", "erin", "dave", "dave", "frank", "carl"],
       conn.execute("SELECT handle, state, tags FROM benchmarks ORDER BY id").fetchall())
    bn = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT handle, name, tags FROM bench_now")}
    ck("bench_now 只认还在名单上的：取消过的 erin 不在（和 blocked_now 同一条判据）",
       set(bn) == {"alice", "bob", "dave", "frank", "carl"} and "erin" not in bn, sorted(bn))
    ck("改分类走最新一行：dave 的水面标签是「新」，「旧」还躺在流水里",
       bn["dave"][1] == "新"
       and [r[0] for r in conn.execute("SELECT tags FROM benchmarks WHERE handle='dave' ORDER BY id")]
       == ["旧", "新"], [bn["dave"], conn.execute("SELECT tags FROM benchmarks WHERE handle='dave'").fetchall()])
    ck("标签取值口径：数组与「逗号+空格」字符串都归成一行文本，没标签是空串不是 'None'",
       bn["alice"][1] == "投资,AI" and bn["bob"][1] == "ai,量化"
       and xdb._tags(None) == "" and xdb._tags(["x", "x"]) == "x",
       [bn["alice"][1], bn["bob"][1], xdb._tags(None), xdb._tags(["x", "x"])])
    ck("标签每个截到 16 字、最多 8 个、整串封顶 120（一个人挂 30 个标签不该把名单行撑成一堵墙）",
       xdb._tags(["a" * 40]) == "a" * 16
       and len(xdb._tags(["t%d" % i for i in range(30)]).split(",")) == 8
       and len(xdb._tags(["%d" % i + "x" * 15 for i in range(8)])) == 120,
       [xdb._tags(["a" * 40]), xdb._tags(["t%d" % i for i in range(30)]),
        len(xdb._tags(["%d" % i + "x" * 15 for i in range(8)]))])
    ba = q("bench_accounts")
    bat = {r["handle"]: r for r in ba}
    ck("bench_accounts：五个人一行（取消过的不在），账号的数从 account_latest 照过来",
       [r["handle"] for r in ba] == ["alice", "carl", "bob", "dave", "frank"]
       and (bat["alice"]["fans"], bat["alice"]["eng"], bat["alice"]["views"], bat["alice"]["posts_n"])
       == (3000, 28, 400, 1) and bat["alice"]["tags"] == "投资,AI" and bat["alice"]["marked_at"],
       [(r["handle"], r["fans"], r["tags"]) for r in ba])
    ck("库里没数的人必须在（LEFT JOIN）：frank 一行不缺、数全是 None——缺数不是「不在了」也不是 0",
       "frank" in bat and all(bat["frank"][k] is None for k in ("fans", "fow", "posts_n", "views", "eng"))
       and bat["frank"]["name"] == "弗兰克" and bat["frank"]["marked_at"],
       bat.get("frank"))
    inner = xdb.QUERIES["bench_accounts"].replace(" LEFT JOIN account_latest", " JOIN account_latest")
    ck("正向对照：把 LEFT JOIN 换成 INNER JOIN，frank 当场消失 ⇒ 这条判据真的在管「刚标了 TA 怎么不见了」",
       [r[0] for r in conn.execute(inner, (20,)).fetchall()] == ["alice", "carl", "bob", "dave"],
       [r[0] for r in conn.execute(inner, (20,)).fetchall()])
    ck("默认排粉丝降序、缺数（bob/dave/frank）一律垫底；bench 与拉黑两本账各记各的（carl blocked=1 还在标杆里）",
       [r["handle"] for r in ba[:2]] == ["alice", "carl"]
       and all(r["fans"] is None for r in ba[2:]) and bat["carl"]["blocked"] == 1
       and bat["alice"]["blocked"] == 0,
       [(r["handle"], r["fans"], r["blocked"]) for r in ba])
    ck("抽屉不另开查询：标杆点开某人行家吃现成的 author_posts（9001 曝光 400 在 alice 名下）",
       conn.execute(xdb.QUERIES["author_posts"], ("alice", 20)).fetchone()[0] == "9001",
       conn.execute(xdb.QUERIES["author_posts"], ("alice", 20)).fetchall()[:1])
    ck("白名单查询 benchmarks 可用（流水最新在前：最后落的是 carl）",
       q("benchmarks")[0]["handle"] == "carl", q("benchmarks")[:1])
    ck("新查询都是单占位符（limit）⇒ query() 走 nph==1 那条支，不新增参数形状（RL-9 白名单只 +2 条）",
       xdb.QUERIES["bench_accounts"].count("?") == 1 and xdb.QUERIES["benchmarks"].count("?") == 1
       and "bench_accounts" in xdb.QUERIES and "benchmarks" in xdb.QUERIES
       and "benchmarks" in xdb._TABLES,
       [xdb.QUERIES["bench_accounts"].count("?"), xdb.QUERIES["benchmarks"].count("?"), "benchmarks" in xdb._TABLES])
    # 真库（open_db 那条路）自己长出 benchmarks 表：新表靠 SCHEMA 的 IF NOT EXISTS，_migrate 一字不用动（blocks 先例）
    bq = xdb.query("bench_accounts", 20)
    ck("真库里表与视图都长出来了：query() 走通、空账回 ok 且 rows 为空（不炸、不假装有人）",
       bq["ok"] is True and bq["rows"] == []
       and xdb._DB["conn"].execute("SELECT COUNT(*) FROM benchmarks").fetchone()[0] == 0
       and xdb._DB["conn"].execute("SELECT COUNT(*) FROM bench_now").fetchone()[0] == 0,
       [bq["ok"], len(bq["rows"])])
    ck("加表不单独跳号：blocks / benchmarks / bench_posts 都是在「当时那一轮」里 IF NOT EXISTS 自长的，"
       "DB_VER 只跟功能轮次走（v0.11.0 抬 db-10 抬的是两条拉黑上云查询；v0.11.5 的 db-11 随 v0.11.6 撤回，表结构一字没动）",
       xdb.DB_VER == "db-10", xdb.DB_VER)
    # ---- v0.9.3 标杆帖子（bench_posts / bench_posts_now / bench_post_rows）----
    # 账本形状与标杆名单同一条（append-only、视图判现在），但键是 tweet_id；数从 post_growth 照过来。
    # 形状覆盖：有数的旗舰帖（正文给 300 字考截断）/ 库里没数的刚标帖（9002 先进后出）/ 非数字 id（脏账）。
    for i, (key3, tid, au, tx, on) in enumerate((
            ("q1", "9001", "@alice", "x" * 300, 1),
            ("q2", "999888777", "carol", "刚标还没数", 1),   # 库里没这条帖的数（post_growth 对不上）
            ("q3", "9002", "bob", "要移出的", 1),
            ("q4", "9002", "bob", "要移出的", 0),            # 进榜又取消：视图从此不认它
            ("q5", "not-a-tweet-id", "eve", "脏 id", 1))):   # id 只认数字：整条不入库
        xdb._simple(conn, key3, {"kind": "benchpost", "at": "2026-10-25T1%d:00:00.000" % i,
                                 "url": "https://x.com/carol/status/999888777"},
                    {"id": tid, "author": au, "text": tx, "on": on, "tags": "投资" if i == 0 else None})
    conn.commit()
    ck("标杆帖子入库：数字 id 的四条流水一事件一行；非数字 id 一条不进（认不出帖子的标杆没法查，宁缺毋滥）",
       conn.execute("SELECT COUNT(*) FROM bench_posts").fetchone()[0] == 4
       and [r[0] for r in conn.execute("SELECT tweet_id FROM bench_posts ORDER BY id")]
       == ["9001", "999888777", "9002", "9002"],
       conn.execute("SELECT tweet_id, author, state FROM bench_posts ORDER BY id").fetchall())
    ck("入库口径：正文纯截断 200（不用 clip，不补「…」）、author 的 @ 前缀剥掉、tags 归一行文本",
       conn.execute("SELECT author, tags, text FROM bench_posts WHERE tweet_id='9001'").fetchone()
       == ("alice", "投资", "x" * 200),
       conn.execute("SELECT author, tags, text FROM bench_posts WHERE tweet_id='9001'").fetchall())
    bpn = [r[0] for r in conn.execute("SELECT tweet_id FROM bench_posts_now")]
    ck("bench_posts_now 只认最新一条 state=1：取消过的 9002 不在、有数的 9001 与没数的 999888777 都在",
       sorted(bpn) == ["9001", "999888777"], bpn)
    cur = conn.execute(xdb.QUERIES["bench_post_rows"], (20,))
    bcols = [c[0] for c in cur.description]
    bp = [dict(zip(bcols, r)) for r in cur.fetchall()]
    ck("bench_post_rows：库里有数的旗舰帖在前（9001 的数从 post_growth 照过来），没数的垫底——「没数」不冒充「很低」",
       [r["tweet_id"] for r in bp] == ["9001", "999888777"] and bp[0]["view"] == 400
       and bp[1]["view"] is None and bp[1]["marked_text"] == "刚标还没数",
       [(r["tweet_id"], r["view"], r["marked_text"]) for r in bp])
    ck("新查询都是单占位符（limit）⇒ 不新增参数形状（RL-9 白名单只 +2 条），bench_posts 进 _TABLES",
       xdb.QUERIES["bench_post_rows"].count("?") == 1 and xdb.QUERIES["bench_posts"].count("?") == 1
       and "bench_post_rows" in xdb.QUERIES and "bench_posts" in xdb.QUERIES
       and "bench_posts" in xdb._TABLES,
       [xdb.QUERIES["bench_post_rows"].count("?"), xdb.QUERIES["bench_posts"].count("?"),
        "bench_posts" in xdb._TABLES])
    bq2 = xdb.query("bench_post_rows", 20)
    ck("真库同款：bench_post_rows 走 query() 白名单路、空账回 ok 且 rows 为空（真机开箱不炸）",
       bq2["ok"] is True and bq2["rows"] == []
       and xdb._DB["conn"].execute("SELECT COUNT(*) FROM bench_posts").fetchone()[0] == 0,
       [bq2["ok"], len(bq2["rows"])])
    fw = [r["handle"] for r in q("should_follow")]
    ck("最该关注：只出没关注且有帖子的人（bob），自己的号（alice）与没帖子的（erin）都不进",
       fw == ["bob"], fw)
    uf = [r["handle"] for r in q("should_unfollow")]
    raw = xdb.QUERIES["should_unfollow"].replace("CASE WHEN fans IS NULL THEN 1 ELSE 0 END, ", "")
    raw_order = [r[0] for r in conn.execute(raw, (20,)).fetchall()]
    ck("最该取关：按互动升序，粉丝数是个平手位；正向对照 —— 去掉空值 CASE 后 dave(None) 会窜到 carl 前面",
       uf == ["carl", "dave", "alice"] and raw_order == ["dave", "carl", "alice"] and uf != raw_order,
       [uf, raw_order])

    # 迁移：老库（tweets 还没有 liked 列）打开后必须补上，且跑两次也只加一次
    old = sqlite3.connect(str(Path(tmp) / "old.db"))
    old.executescript("""CREATE TABLE tweets(id INTEGER PRIMARY KEY AUTOINCREMENT, snap TEXT, at TEXT,
      idx INTEGER, tweet_id TEXT, author TEXT, metrics TEXT, UNIQUE(snap, idx));""")
    old.execute("INSERT INTO tweets(snap, at, idx, tweet_id) VALUES('s', 'x', 0, '1')")
    before = [r[1] for r in old.execute("PRAGMA table_info(tweets)")]
    xdb._migrate(old)
    xdb._migrate(old)
    after = [r[1] for r in old.execute("PRAGMA table_info(tweets)")]
    ck("老库迁移：liked 列补上（幂等跑两次也只有一个），旧行不丢",
       "liked" not in before and after.count("liked") == 1
       and old.execute("SELECT COUNT(*) FROM tweets").fetchone()[0] == 1, [before, after.count("liked")])
    old.close()
    conn.close()


def leg_tl(xdb, tmp):
    print("\n[A2] v0.8.2 时间线关联：tl_src 落库 + 迁移回填 + tl_rank/tl_days 白名单查询")
    # 单独开一份临时库跑，别把 [A] 的行数基线抬高（[B] 的计数断言是按这份库精确写的）
    if not xdb.open_db(tmp / "tl-xprobe.db"):
        ck("时间线自检临时库打不开", False, xdb._DB["err"])
        return
    conn = xdb._DB["conn"]

    def page(key, at, tlsrc, tabs, tweets):
        return {"kind": "page", "at": at, "receivedAt": at, "url": "https://x.com/home", "tab": "home",
                "ver": "t", "host": "ext",
                "data": {"tlSrc": tlsrc, "tab": "home", "url": "https://x.com/home",
                         "identity": {"handle": "me"}, "stats": {"__tabs": tabs}, "tweets": tweets, "users": []}}

    tabs_fy = [{"text": "为你推荐", "selected": "true"}, {"text": "正在关注", "selected": "false"}]
    tabs_fg = [{"text": "为你推荐", "selected": "false"}, {"text": "正在关注", "selected": "true"}]
    idx = [0]
    # 发帖时刻（页面 `<time datetime>` 的原文）：真机是 UTC 带 Z。同一条帖子在几份快照里重复出现时
    # 这个值**不该变**——它是那条帖子自己发出来的时刻，与我们哪天扫到它无关。t2/t4 故意不给（= 没读到），
    # 用来钉「缺发帖时间不许拿采集时刻冒充」。
    PUB = {"t1": "2026-10-24T22:10:00.000Z", "t3": "2026-10-24T23:30:00.000Z"}

    def tw(tid, at, view, reply=0):
        idx[0] += 1
        row = {"tweetId": tid, "idx": idx[0], "author": "aa", "text": "帖" + tid,
               "metrics": {"view": {"num": {"value": view}}, "reply": {"num": {"value": reply}}}}
        if tid in PUB:
            row["timeDatetime"] = PUB[tid]
        return row

    r1 = xdb.ingest(page("tlk1", "2026-10-25T10:00:00Z", "foryou", tabs_fy,
                         [tw("t1", "2026-10-25T10:00:00Z", 100, 12), tw("t2", "2026-10-25T10:00:00Z", 50, 3)]), "")
    r2 = xdb.ingest(page("tlk2", "2026-10-25T12:00:00Z", "foryou", tabs_fy,
                         [tw("t1", "2026-10-25T12:00:00Z", 150, 38), tw("t3", "2026-10-25T12:00:00Z", 300, 5)]), "")
    r3 = xdb.ingest(page("tlk3", "2026-10-25T13:00:00Z", "following", tabs_fg,
                         [tw("t1", "2026-10-25T13:00:00Z", 160, 40), tw("t2", "2026-10-25T13:00:00Z", 55, 4)]), "")
    # 旧版 core 的记录没有 tlSrc：tl_src 必须 NULL（「不知道」不许冒充「为你推荐」）
    r4 = xdb.ingest(page("tlk4", "2026-10-25T14:00:00Z", "", tabs_fg, [tw("t4", "2026-10-25T14:00:00Z", 9, 1)]), "")
    ck("四份快照全部入档", [r1, r2, r3, r4] == [xdb.NEW] * 4, [r1, r2, r3, r4])
    ck("tl_src 随快照落库：foryou 3 行 / following 2 行 / 没有 tlSrc 的 1 行保持 NULL",
       conn.execute("SELECT COALESCE(tl_src,'(null)'), COUNT(*) FROM tweets GROUP BY 1 ORDER BY 1").fetchall(),
       conn.execute("SELECT COALESCE(tl_src,'(null)'), COUNT(*) FROM tweets GROUP BY 1 ORDER BY 1").fetchall())
    cnt = dict(conn.execute("SELECT COALESCE(tl_src,'(null)'), COUNT(*) FROM tweets GROUP BY 1").fetchall())
    ck("计数对得上（foryou=4: t1 两点+t2+t3, following=2, 没 tlSrc 的 1 行 NULL）",
       cnt == {"foryou": 4, "following": 2, "(null)": 1}, cnt)
    days = xdb.query("tl_days", 20).get("rows") or []
    ck("tl_days 按天×源合计（每帖每天每源一条：foryou 3 条 500、following 2 条 215）",
       [r for r in days if r["day"] == "2026-10-25"],
       [{"day": "2026-10-25", "tl_src": "following", "n": 2, "views": 215},
        {"day": "2026-10-25", "tl_src": "foryou", "n": 3, "views": 500}])
    rank = xdb.query("tl_rank", 20, "2026-10-25").get("rows") or []
    ck("tl_rank 按曝光降序、同帖两源各占一行（推荐流 vs 关注流就是两张关联），榜首 300；评论数随同一次抓取的点走（不混批）",
       [(r["tweet_id"], r["tl_src"], r["view"], r["reply"]) for r in rank],
       [("t3", "foryou", 300, 5), ("t1", "following", 160, 40), ("t1", "foryou", 150, 38),
        ("t2", "following", 55, 4), ("t2", "foryou", 50, 3)])
    ck("day 参数过滤：查没数据的天给空榜、查形状对但不存在给 ok 空榜（不炸不猜）",
       [len(xdb.query("tl_rank", 20, "2026-10-24").get("rows") or []),
        xdb.query("tl_rank", 20, "2026-13-99").get("ok"),
        len(xdb.query("tl_rank", 20, "2026-13-99").get("rows") or [])], [0, True, 0])
    ck("_tl_src_of_stats 单元：两种真机文本各认各的、认不出给空串",
       [xdb._tl_src_of_stats('{"__tabs":[{"text":"为你推荐","selected":"true"}]}'),
        xdb._tl_src_of_stats('{"__tabs":[{"text":"正在关注","selected":"true"}]}'),
        xdb._tl_src_of_stats('{"__tabs":[{"text":"帖子","selected":"true"}]}'),
        xdb._tl_src_of_stats('{"__tabs":[{"text":"为你推荐","selected":"false"}]}'),
        xdb._tl_src_of_stats("not-json")], ["foryou", "following", "", "", ""])
    # v0.8.2 点昵开的作者模态框：author_posts = 这人所有已抓帖子按曝光降序（post_growth 一帖一行取最新一点）
    ap = xdb.query("author_posts", 20, None, "aa").get("rows") or []
    ck("author_posts：aa 的 4 条帖子按曝光降序（t3=300 > t1=160 > t2=55 > t4=9），跨推荐流/关注流都算他的；评论取最新一点",
       [(r["tweet_id"], r["view"], r["reply"]) for r in ap],
       [("t3", 300, 5), ("t1", 160, 40), ("t2", 55, 4), ("t4", 9, 1)])
    ck("author_posts 参数卡形状：坏 handle 报 400 形状的 err、没帖子的人回 ok 空榜（不炸不猜）",
       [xdb.query("author_posts", 20, None, "bad handle!")["ok"],
        "handle 字符" in xdb.query("author_posts", 20, None, "bad handle!").get("err", ""),
        xdb.query("author_posts", 20, None, "zz")["ok"],
        xdb.query("author_posts", 20, None, "zz").get("rows")], [False, True, True, []])
    # v0.9.2：抽屉那一列要的是**发帖时间**，不是「我们扫到它的时刻」。库里一直存着 time_datetime
    # （页面 <time datetime> 原文），以前这条查询没把它带出来 ⇒ 真机一屏帖子全显示成同一分钟。
    apb = {r["tweet_id"]: r for r in ap}
    ck("v0.9.2 author_posts 带出发帖时间：t1/t3 给的是那条帖子发出来的时刻（比 last_at 早一天），"
       "t2/t4 没读到就是空串——不许拿采集时刻冒充发帖时间",
       [(apb[t]["time_datetime"] or "-") for t in ("t1", "t3", "t2", "t4")],
       ["2026-10-24T22:10:00.000Z", "2026-10-24T23:30:00.000Z", "-", "-"])
    ck("v0.9.2 三个时刻各是各的（first_at=第一次采到 / last_at=最后一次采到 / time_datetime=发帖）："
       "同一条帖子三点全不一样才证明抽屉没在拿采集时刻装发帖时间",
       [(apb["t1"]["first_at"], apb["t1"]["last_at"], apb["t1"]["time_datetime"]),
        apb["t1"]["time_datetime"] < apb["t1"]["first_at"] < apb["t1"]["last_at"]],
       [("2026-10-25T10:00:00Z", "2026-10-25T13:00:00Z", "2026-10-24T22:10:00.000Z"), True])
    ck("v0.9.2 新列只往末尾加：前九列的次序一字不动（面板与自检有按位取值的，插中间等于改别人的口径）",
       list(apb["t1"].keys()),
       ["tweet_id", "author", "text", "last_at", "view", "like", "reply", "eng", "view_per_h",
        "time_datetime", "first_at"])

    # 迁移回填：db-4 老库（tweets 没有 tl_src 列）打开后补列 + 从 snapshots.stats.__tabs 回填，幂等跑两次
    old = sqlite3.connect(str(tmp / "old-tl.db"))
    old.executescript("""CREATE TABLE tweets(id INTEGER PRIMARY KEY AUTOINCREMENT, snap TEXT, at TEXT,
      idx INTEGER, tweet_id TEXT, author TEXT, metrics TEXT, liked INTEGER, UNIQUE(snap, idx));
      CREATE TABLE snapshots(key TEXT PRIMARY KEY, at TEXT, day TEXT, tab TEXT, stats TEXT);""")
    old.execute("INSERT INTO snapshots VALUES('s1','2026-10-25T10:00:00Z','2026-10-25','home',?)",
                (json.dumps({"__tabs": [{"text": "为你推荐", "selected": "true"}]}, ensure_ascii=False),))
    old.execute("INSERT INTO tweets(snap,at,idx,tweet_id,metrics) VALUES('s1','2026-10-25T10:00:00Z',0,'x1',?)",
                (json.dumps({"view": {"num": {"value": 7}}}),))
    xdb._migrate(old)
    xdb._migrate(old)
    got = old.execute("SELECT tweet_id, tl_src FROM tweets").fetchall()
    ncol = len([r for r in old.execute("PRAGMA table_info(tweets)") if r[1] == "tl_src"])
    ck("老库迁移：tl_src 列补上（幂等跑两次也只有一个）、历史行从 __tabs 回填成 foryou",
       got == [("x1", "foryou")] and ncol == 1, [got, ncol])
    old.close()
    if not xdb.open_db(tmp / "xprobe.db"):
        ck("时间线自检结束后换回主临时库", False, xdb._DB["err"])


def leg_win(xdb, tmp):
    print("\n[A3] v0.8.6 历史榜时间窗：tl_win（hours/起止日、每帖取窗内最新一点、参数形状）")
    if not xdb.open_db(tmp / "win-xprobe.db"):
        ck("时间窗自检临时库打不开", False, xdb._DB["err"])
        return

    def ago(minutes):
        return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds").replace("+00:00", "Z")

    def page(at, tweets):
        return {"kind": "page", "at": at, "receivedAt": at, "url": "https://x.com/home", "tab": "home",
                "ver": "t", "host": "ext",
                "data": {"tlSrc": "foryou", "tab": "home", "url": "https://x.com/home",
                         "identity": {"handle": "me"}, "stats": {}, "tweets": tweets, "users": []}}

    def tw(idx, tid, view, reply=0, text=None):
        t = {"tweetId": tid, "idx": idx, "author": "aa", "text": text or ("帖" + tid)}
        # 没给 view 的行必须被 tl_win 剔掉（没有指标的帖子排不进曝光榜，也不许拿 0 充数）
        if view is not None:
            t["metrics"] = {"view": {"num": {"value": view}}, "reply": {"num": {"value": reply}}}
        else:
            t["metrics"] = {"reply": {"num": {"value": reply}}}
        return t

    old_at, mid_at = ago(10 * 24 * 60), ago(30 * 60)
    # v0.11.7 补：单日窗判据要一把「只有一个老点」的稳尺子。原来那条拿 t_old 当尺子，可 t_old 在 -5min
    # 还有一点（950），「每帖取窗内最新一点」会把它永远带进「今天」的单日窗 ⇒ 原断言只在 UTC 16:00 之后
    # 跑才是绿的（本地 00:00~08:00，2026-11-04 本地早上 8 点后跑当场红过一次），其余时段必红——是测试的
    # 时区病，不是库的。换成「本地正午 -3 天」造的点：离前后两个本地午夜都有 12 小时，什么时刻跑都稳。
    past_dt = (datetime.now().astimezone() - timedelta(days=3)).replace(hour=12, minute=0, second=0, microsecond=0)
    past_iso = past_dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snaps = [
        page(old_at, [tw(0, "t_old", 900)]),
        page(mid_at, [tw(0, "t_mid", 700)]),
        page(ago(5 * 60), [tw(0, "t_mid", 300), tw(1, "t_old", 950)]),
        page(ago(10), [tw(0, "t_mid", 250), tw(1, "t_new", 500), tw(2, "t_noview", None, 7)]),
        page(past_iso, [tw(0, "t_dated", 50)]),
    ]
    got = [xdb.ingest(s, "") for s in snaps]
    ck("五份快照全部入档（历史榜的数据源）", got == [xdb.NEW] * 5, got)

    def rows(**kw):
        return tuple((r["tweet_id"], r["view"]) for r in (xdb.query("tl_win", kw.pop("limit", 20), **kw).get("rows") or []))

    ck("hours=1：只看最近一小时（t_new=500 > t_mid 窗内最新 250），没有指标的 t_noview 不进榜",
       rows(hours=1), (("t_new", 500), ("t_mid", 250)))
    ck("同帖多点只取窗内最新一点：t_mid 在 -30h 是 700、-5h 是 300、-10min 是 250，1 小时窗里必须报 250",
       rows(hours=1)[1], ("t_mid", 250))
    ck("hours=6 与 24 都还够不到 -30h 那一点（窗内最新仍是 250）", [rows(hours=6), rows(hours=24)],
       [(("t_new", 500), ("t_mid", 250)), (("t_new", 500), ("t_mid", 250))])
    ck("hours=48：-30h 的那份快照进窗，但去重后仍是窗内最新 250（不是 700）",
       rows(hours=48), (("t_new", 500), ("t_mid", 250)))
    ck("hours=0 = 全部历史：-10 天的 t_old 取它最近一次 950 上榜，降序 [950, 500, 250, 50]",
       rows(hours=0), (("t_old", 950), ("t_new", 500), ("t_mid", 250), ("t_dated", 50)))
    ck("limit 真夹在 SQL 里（limit=2 就两行）", rows(hours=0, limit=2), (("t_old", 950), ("t_new", 500)))
    f = (datetime.now(timezone.utc) - timedelta(hours=6)).strftime("%Y-%m-%d")
    t2 = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ck("起止日区间：只收这几天（-10 天的 t_old 出局），t_mid 仍是窗内最新 250",
       rows(win=(f, t2), hours=None), (("t_new", 500), ("t_mid", 250)))
    d3 = past_iso[:10]
    ck("单日区间（起=止）真的按日子挑：t_dated 只有 -3 天那个本地正午的一点，它自己的单日窗里就是它（且只有它）",
       tuple((r["tweet_id"], r["view"]) for r in (xdb.query("tl_win", 20, win=(d3, d3), hours=None).get("rows") or [])),
       (("t_dated", 50),))
    ck("单日区间（起=止）挑不进别的日子：t_dated 不在今天的单日窗里（判据写全 == []，别靠列表真值——空列表是 falsy，靠真值这条永远红）",
       [r["tweet_id"] for r in (xdb.query("tl_win", 20, win=(t2, t2), hours=None).get("rows") or []) if r["tweet_id"] == "t_dated"] == [], [])
    ck("参数形状：hours 越界/非数字都明确拒绝（不许悄悄退回 24 小时）",
       [xdb.query("tl_win", 20, hours=-1)["ok"], "0~87600" in xdb.query("tl_win", 20, hours=-1).get("err", ""),
        xdb.query("tl_win", 20, hours=87601)["ok"], xdb.query("tl_win", 20, hours="x")["ok"]],
       [False, True, False, False])
    ck("正向对照：形状对但区间反了（from>to）⇒ 退回 hours 口径而不是报错空榜（host/sink 在上一跳已经拦过，这里兜底）",
       rows(win=("2026-01-09", "2026-01-01"), hours=1), (("t_new", 500), ("t_mid", 250)))
    ck("tl_win 在 help 白名单里露出来（外部只能点名，不能拼 SQL）",
       "tl_win" in [r["name"] for r in (xdb.query("help", 50).get("rows") or [])], None)
    if not xdb.open_db(tmp / "xprobe.db"):
        ck("时间窗自检结束后换回主临时库", False, xdb._DB["err"])


def leg_sync(xdb, tmp):
    print("\n[A4] v0.9.7 上云增量：bench_marks_ac / bench_marks_po 两条台账流水查询 + after 游标")
    # 再开一份独立临时库：这里要写进/出（state=0）流水，混进主库会把 [B] 的计数断言顶歪。
    if not xdb.open_db(tmp / "sync-xprobe.db"):
        ck("同步自检临时库打不开", False, xdb._DB["err"])
        return
    conn = xdb._DB["conn"]
    # 先给这份库喂一点「数」：alice 有一条采过的帖（12:00）与一行用户资料（13:00），
    # bob/erin/carl/dave/frank 一条都没采过 —— 正好考两条腿：有数的人 observed_at 是真观测时刻，
    # 没数的人必须是 None（上云那侧靠它判「新快照能不能盖旧快照」，拿标记时刻冒充就是假话）。
    xdb._page(conn, "syncpg1",
              {"kind": "page", "at": "2026-10-24T12:00:00.000", "receivedAt": "2026-10-24T12:00:00.000",
               "url": "https://x.com/alice", "tabType": "profile", "handle": "alice"},
              {"tweets": [{"idx": 0, "tweetId": "9001", "author": "alice", "text": "旗舰帖",
                           "timeDatetime": "2026-10-24T08:00:00.000Z",
                           "metrics": {"view": {"num": {"value": 400, "exact": True}},
                                       "like": {"num": {"value": 20, "exact": False}},
                                       "reply": {"num": {"value": 8, "exact": True}}}}], "users": []})
    conn.execute("INSERT INTO store_users(key, at, handle, name, followers, relation, own)"
                 " VALUES('syncu1', '2026-10-24T13:00:00.000', 'alice', '爱丽丝', 3000, 'following', 0)")
    conn.commit()
    # 八条人账流水（与 [A] 同一套形状）+ 四条帖账流水：关键是**取消（state=0）也在里面**——
    # 视图那两条（bench_accounts / bench_post_rows）天生把取消的人滤掉了，推给云端就永远撤不掉；
    # 台账流水不过滤 state，云端收到的是一条「这里少一个人」的墓碑，这才叫同步。
    for i, (key3, hh, nm, on, tg) in enumerate((
            ("s1", "alice", "爱丽丝", 1, ["投资"]),
            ("s2", "alice", "爱丽丝", 1, ["投资", "AI"]),   # 改分类：又一行 state=1
            ("s3", "bob", "鲍勃", 1, None),
            ("s4", "erin", "艾琳", 1, ["旧"]),
            ("s5", "erin", "艾琳", 0, None),                # 进榜又取消 —— 墓碑
            ("s6", "carl", "卡尔", 1, ["已拉黑"]),
            ("s7", "dave", "戴夫", 1, None),
            ("s8", "frank", "弗兰克", 0, None))):           # 从没进过就直接移出（脏流水也要推得出去）
        xdb._simple(conn, key3, {"kind": "bench", "at": "2026-10-27T09:0%d:00.000" % i,
                                 "url": "https://x.com/home"},
                    {"handle": hh, "name": nm, "on": on, "tags": tg})
    for i, (key3, tid, au, tx, on) in enumerate((
            ("p1", "9001", "@alice", "帖子正文快照", 1),
            ("p2", "9001", "@alice", "帖子正文快照", 0),    # 标了又移出
            ("p3", "9002", "bob", "y" * 260, 1),            # 入库截到 200：查询这一层不再截
            ("p4", "9003", "carol", "查不到数的帖", 1))):    # post_growth 对不上 ⇒ 数全 NULL
        xdb._simple(conn, key3, {"kind": "benchpost", "at": "2026-10-27T10:0%d:00.000" % i,
                                 "url": "https://x.com/carol/status/9003"},
                    {"id": tid, "author": au, "text": tx, "on": on})
    conn.commit()
    ac = xdb.query("bench_marks_ac", 500)
    po = xdb.query("bench_marks_po", 500)
    ck("台账流水八条全出、按 id 升序（不是面板那种「最新在前」——游标翻页要的是稳定序）",
       ac["ok"] is True and [r["handle"] for r in ac["rows"]]
       == ["alice", "alice", "bob", "erin", "erin", "carl", "dave", "frank"],
       [r["handle"] for r in ac["rows"]])
    ck("state 原样带出：erin 的取消（0）在流水里（视图 bench_accounts 把它滤掉了 ⇒ 撤不掉标杆）",
       [(r["handle"], r["state"]) for r in ac["rows"] if r["handle"] == "erin"] == [("erin", 1), ("erin", 0)]
       and [r["handle"] for r in xdb.query("bench_accounts", 500)["rows"] if r["handle"] == "erin"] == [],
       [(r["handle"], r["state"]) for r in ac["rows"] if r["handle"] == "erin"])
    ck("改分类是一行新流水（alice 两行都推得出去，云端按 id 大的那条覆盖标签）",
       [r["tags"] for r in ac["rows"] if r["handle"] == "alice"] == ["投资", "投资,AI"],
       [r["tags"] for r in ac["rows"] if r["handle"] == "alice"])
    ck("带 id 游标：id 单调递增、每行都有（这就是客户端下一页的 after）",
       [r["id"] for r in ac["rows"]] == sorted(set(r["id"] for r in ac["rows"]))
       and all(isinstance(r["id"], int) and r["id"] > 0 for r in ac["rows"]),
       [r["id"] for r in ac["rows"]])
    ck("after 真绑进 SQL：cut=第 3 行 ⇒ 只剩后 5 行；after=0/缺省 ⇒ 全量（第一页）",
       [len(xdb.query("bench_marks_ac", 500, after=ac["rows"][2]["id"])["rows"]),
        len(xdb.query("bench_marks_ac", 500, after=0)["rows"]), len(xdb.query("bench_marks_ac", 500)["rows"])]
       == [5, 8, 8],
       [len(xdb.query("bench_marks_ac", 500, after=ac["rows"][2]["id"])["rows"]),
        len(xdb.query("bench_marks_ac", 500, after=0)["rows"])])
    no_cur = conn.execute(xdb.QUERIES["bench_marks_ac"].replace("WHERE s.id > ? ", ""), (500,)).fetchall()
    ck("正向对照：把 WHERE s.id > ? 摘掉、limit 照旧传 500 ⇒ 8 行全出（证明少的那 3 行是游标滤的，不是 limit）",
       len(no_cur) == 8, len(no_cur))
    ck("翻页翻到底：after=最大 id ⇒ 空且 ok=True（空页不是错，客户端据此停手）",
       [xdb.query("bench_marks_ac", 500, after=ac["rows"][-1]["id"])["ok"],
        xdb.query("bench_marks_ac", 500, after=ac["rows"][-1]["id"])["rows"]] == [True, []],
       xdb.query("bench_marks_ac", 500, after=ac["rows"][-1]["id"])["rows"])
    ck("帖子流水四条同序；正文出整列（库里已截到 200，这一层不再 substr）",
       [r["tweet_id"] for r in po["rows"]] == ["9001", "9001", "9002", "9003"]
       and len([r for r in po["rows"] if r["tweet_id"] == "9002"][0]["text"]) == 200
       and [(r["tweet_id"], r["state"]) for r in po["rows"] if r["tweet_id"] == "9001"]
       == [("9001", 1), ("9001", 0)],
       [(r["tweet_id"], len(r["text"] or "")) for r in po["rows"]])
    ck("数照旧 LEFT JOIN 过来当快照：9003 没采到过 ⇒ view/reply/like 全 None（缺数不许冒充 0，RL-11）",
       [r["view"] for r in po["rows"] if r["tweet_id"] == "9003"] == [None]
       and [r["time_datetime"] for r in po["rows"] if r["tweet_id"] == "9003"] == [None],
       [(r["tweet_id"], r["view"]) for r in po["rows"]])
    # observed_at = 「这批数是什么时候看到的」，上云拿它决定新快照能不能盖旧快照。
    # 用标记时刻（at）冒充是错的：今天标记的人，数可以是上周采的；上周标记的人，数可以是今天补采的。
    ck("observed_at：账号取「用户行 / 日点行里较晚的那个时刻」，alice 有真时刻（不是标记时刻 s.at）",
       [r.get("observed_at") for r in ac["rows"] if r["handle"] == "alice"] == ["2026-10-24T13:00:00.000", "2026-10-24T13:00:00.000"]
       and [r["at"] for r in ac["rows"] if r["handle"] == "alice"][0] == "2026-10-27T09:00:00.000",
       [(r["handle"], r["at"], r.get("observed_at")) for r in ac["rows"] if r["handle"] == "alice"])
    ck("observed_at：本机一条数都没抓到过的人（frank）就是 None —— 两参 MAX 里任一为 NULL 会整体 NULL，"
       "所以 SQL 写成 NULLIF(MAX(COALESCE(..,''),COALESCE(..,'')),'')，退步也是 None，不拿标记时刻冒充",
       [r.get("observed_at") for r in ac["rows"] if r["handle"] == "frank"] == [None],
       [(r["handle"], r.get("observed_at")) for r in ac["rows"]])
    ck("observed_at：帖子取最后一个采样点（9001 有）、没采过的（9003）为 None",
       [r.get("observed_at") for r in po["rows"] if r["tweet_id"] == "9001"] == ["2026-10-24T12:00:00.000", "2026-10-24T12:00:00.000"]
       and [r.get("observed_at") for r in po["rows"] if r["tweet_id"] == "9003"] == [None],
       [(r["tweet_id"], r.get("observed_at")) for r in po["rows"]])
    ck("relation / blocked 跟着流水走（云端把它们放私有层、不进共享实体表）：alice 拿得到、alice 之外没数的人全 None",
       [(r["relation"], r["blocked"]) for r in ac["rows"] if r["handle"] == "alice"]
       == [("following", 0), ("following", 0)]
       and set((r["relation"], r["blocked"]) for r in ac["rows"] if r["handle"] != "alice") == {(None, None)},
       [(r["handle"], r["relation"], r["blocked"]) for r in ac["rows"]])
    ck("账号流水没数的人（frank/dave）照样在，且 fans 是 None 不是 0",
       [(r["handle"], r["fans"]) for r in ac["rows"] if r["handle"] in ("dave", "frank")]
       == [("dave", None), ("frank", None)],
       [(r["handle"], r["fans"]) for r in ac["rows"] if r["handle"] in ("dave", "frank")])
    ck("游标形状：负数 / 非数字 / 空串都明确拒绝（悄悄退成 0 = 把整本账重放一遍，比报错糟）",
       [xdb.query("bench_marks_ac", 20, after=-1)["ok"], "游标" in xdb.query("bench_marks_ac", 20, after=-1).get("err", ""),
        xdb.query("bench_marks_ac", 20, after="x")["ok"], xdb.query("bench_marks_ac", 20, after="")["ok"]],
       [False, True, False, True])
    ck("两条新查询各吃 (after, limit) 两个占位符、且都在 help 白名单里露得出名字（外部只能点名，不能拼 SQL）",
       xdb.QUERIES["bench_marks_ac"].count("?") == 2 and xdb.QUERIES["bench_marks_po"].count("?") == 2
       and set(["bench_marks_ac", "bench_marks_po"]).issubset(set(r["name"] for r in xdb.query("help", 50)["rows"])),
       [xdb.QUERIES["bench_marks_ac"].count("?"), xdb.QUERIES["bench_marks_po"].count("?")])
    ck("两条流水都不走视图：SQL 里 FROM 的是 benchmarks / bench_posts 原表（视图滤 state，推不出墓碑）",
       " FROM benchmarks" in xdb.QUERIES["bench_marks_ac"] and "bench_now" not in xdb.QUERIES["bench_marks_ac"]
       and " FROM bench_posts" in xdb.QUERIES["bench_marks_po"] and "bench_posts_now" not in xdb.QUERIES["bench_marks_po"],
       [xdb.QUERIES["bench_marks_ac"], xdb.QUERIES["bench_marks_po"]])
    if not xdb.open_db(tmp / "xprobe.db"):
        ck("同步自检结束后换回主临时库", False, xdb._DB["err"])


def leg_lib(xdb, tmp):
    print("\n[A4b] v0.10.6 抓取档案上云：lib_users / lib_posts 两条增量查询（按业务键去重 + after 游标）")
    if not xdb.open_db(tmp / "lib-xprobe.db"):
        ck("档案自检临时库打不开", False, xdb._DB["err"])
        return
    conn = xdb._DB["conn"]
    # store_users / store_posts 是「按 key 累加的快照表」：同一个人会被抓到很多次。
    # alice 两行、bob 一行、空 handle 一行（脏行）；帖子 9001 两行、9002 一行、空 post_id 一行。
    for key3, hh, nm, fans in (("u1", "alice", "爱丽丝", 100),
                               ("u2", "alice", "爱丽丝2", 200),   # 后一次快照：只该出这一行
                               ("u3", "bob", "鲍勃", 50),
                               ("u4", "", "脏行", 1)):            # 空 handle 不入
        conn.execute("INSERT INTO store_users(key, at, handle, name, followers, relation, own)"
                     " VALUES(?, ?, ?, ?, ?, 'following', 0)",
                     (key3, "2026-10-28T1%s:00:00.000" % key3[-1], hh, nm, fans))
    for key3, pid, au, tx, vw in (("p1", "9001", "alice", "旧正文", 10),
                                  ("p2", "9001", "alice", "新正文", 20),  # 后一次快照：只该出这一行
                                  ("p3", "9002", "bob", "鲍勃的帖", 5),
                                  ("p4", "", "bob", "脏行", 1)):          # 空 post_id 不入
        conn.execute("INSERT INTO store_posts(key, at, post_id, handle, text, first_seen, reply,"
                     " repost, like, view, n) VALUES(?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 1)",
                     (key3, "2026-10-28T2%s:00:00.000" % key3[-1], pid, au, tx, "2026-10-28T00:00:00.000", vw))
    conn.commit()
    us = xdb.query("lib_users", 500)
    ck("每人只出最新那一次快照（alice 两行只出 id 大的那行）、空 handle 的脏行不入、按 id 升序",
       us["ok"] is True and [r["handle"] for r in us["rows"]] == ["alice", "bob"]
       and [r["name"] for r in us["rows"]] == ["爱丽丝2", "鲍勃"]
       and [r["followers"] for r in us["rows"]] == [200, 50],
       [(r["id"], r["handle"], r["name"], r["followers"]) for r in us["rows"]])
    ck("账号游标是 store_users 的自增 id：after=alice 那行 ⇒ 只剩 bob",
       [r["handle"] for r in xdb.query("lib_users", 500, after=us["rows"][0]["id"])["rows"]] == ["bob"],
       [r["id"] for r in us["rows"]])
    ck("after 翻到底 = 空且 ok=True（空页不是错，客户端据此停手）",
       [xdb.query("lib_users", 500, after=us["rows"][-1]["id"])["ok"],
        xdb.query("lib_users", 500, after=us["rows"][-1]["id"])["rows"]] == [True, []],
       xdb.query("lib_users", 500, after=us["rows"][-1]["id"])["rows"])
    ps = xdb.query("lib_posts", 500)
    ck("每条帖只出最新那一次快照（9001 出「新正文」）、空 post_id 不入、数照原样带出",
       ps["ok"] is True and [r["post_id"] for r in ps["rows"]] == ["9001", "9002"]
       and [r["text"] for r in ps["rows"]] == ["新正文", "鲍勃的帖"]
       and [r["view"] for r in ps["rows"]] == [20, 5],
       [(r["id"], r["post_id"], r["text"], r["view"]) for r in ps["rows"]])
    ck("帖子游标同形状：after=9001 那行 ⇒ 只剩 9002；limit 生效",
       [r["post_id"] for r in xdb.query("lib_posts", 500, after=ps["rows"][0]["id"])["rows"]] == ["9002"]
       and len(xdb.query("lib_posts", 1)["rows"]) == 1,
       [r["post_id"] for r in xdb.query("lib_posts", 500, after=ps["rows"][0]["id"])["rows"]])
    ck("游标形状：负数 / 非数字都明确拒绝（lib 与台账同一套 after 校验）",
       [xdb.query("lib_users", 20, after=-1)["ok"], "游标" in xdb.query("lib_users", 20, after=-1).get("err", ""),
        xdb.query("lib_posts", 20, after="x")["ok"]],
       [xdb.query("lib_users", 20, after=-1)["ok"], xdb.query("lib_users", 20, after=-1).get("err")])
    ck("两条新查询各吃 (after, limit) 两个占位符、且在 help 白名单里露得出名字",
       xdb.QUERIES["lib_users"].count("?") == 2 and xdb.QUERIES["lib_posts"].count("?") == 2
       and set(["lib_users", "lib_posts"]).issubset(set(r["name"] for r in xdb.query("help", 50)["rows"])),
       [xdb.QUERIES["lib_users"].count("?"), xdb.QUERIES["lib_posts"].count("?")])
    ck("两条查询都按 MAX(id) 去重（同一个 handle / post_id 只留最后一行），不是逐行直查",
       "MAX(id)" in xdb.QUERIES["lib_users"] and "GROUP BY handle" in xdb.QUERIES["lib_users"]
       and "MAX(id)" in xdb.QUERIES["lib_posts"] and "GROUP BY post_id" in xdb.QUERIES["lib_posts"],
       [xdb.QUERIES["lib_users"], xdb.QUERIES["lib_posts"]])
    # v0.10.7：同步进度（不新开账本，水位就是账）—— total 与上送口径逐字一致（按业务键去重、脏行不入），
    # synced 只数「该键最新那行的 id <= 水位」的那几个，pending 由 JS 用减法算。
    su = xdb.query("lib_user_stat", 20, after=0)["rows"][0]
    ck("账号统计：本地 2 个 handle（alice / bob）、水位 0 时一个都没推、max_id 是最新快照那行的 id",
       [su["total"], su["synced"], su["max_id"]] == [2, 0, 3], su)
    ck("账号统计：水位抬到 alice 那行 ⇒ 已推 1 / 共 2（待推=1 由面板减出来），max_id 不动",
       [xdb.query("lib_user_stat", 20, after=2)["rows"][0][k] for k in ("total", "synced", "max_id")] == [2, 1, 3],
       xdb.query("lib_user_stat", 20, after=2)["rows"][0])
    sp = xdb.query("lib_post_stat", 20, after=2)["rows"][0]
    ck("帖子统计同形状：9001 / 9002 两条、水位 2 ⇒ 已推 1；空 post_id 的脏行不算进分母",
       [sp["total"], sp["synced"], sp["max_id"]] == [2, 1, 3], sp)
    ck("统计查询只吃 after 一个参数（limit 对它们没有意义），坏游标当场拒绝、不退成 0",
       xdb.QUERIES["lib_user_stat"].count("?") == 1 and xdb.QUERIES["lib_post_stat"].count("?") == 1
       and xdb.query("lib_user_stat", 20, after=-1)["ok"] is False
       and xdb.query("lib_post_stat", 20, after="x")["ok"] is False,
       [xdb.QUERIES["lib_user_stat"].count("?"), xdb.QUERIES["lib_post_stat"].count("?"),
        xdb.query("lib_user_stat", 20, after=-1).get("err")])
    ck("两条统计查询在 help 白名单里露得出名字",
       set(["lib_user_stat", "lib_post_stat"]).issubset(set(r["name"] for r in xdb.query("help", 50)["rows"])), '')
    if not xdb.open_db(tmp / "xprobe.db"):
        ck("档案自检结束后换回主临时库", False, xdb._DB["err"])


def leg_block(xdb, tmp):
    print("\n[A4c] v0.11.0 拉黑上云：block_marks 流水 / block_stat 统计（每键取最新一条）")
    if not xdb.open_db(tmp / "block-xprobe.db"):
        ck("拉黑自检临时库打不开", False, xdb._DB["err"])
        return
    conn = xdb._DB["conn"]
    # blocks 是 append-only 进/出流水：同一个 handle 拉过又取消就是两行，state=0 的取消行也必须能推上去
    # （服务端按业务键取最新一条判「现在还拉不拉黑」，漏推取消 = 云端假在榜）。
    for key, hh, nm, on, at in (
            ("k1", "carl", "卡尔", 1, "2026-10-30T10:00:00.000"),
            ("k2", "dave", "", 1, "2026-10-30T11:00:00.000"),
            ("k3", "dave", "", 0, "2026-10-30T12:00:00.000"),
            ("k4", "", "脏行", 1, "2026-10-30T13:00:00.000")):   # 空 handle 不入
        conn.execute("INSERT INTO blocks(key, at, day, handle, name, state, url) VALUES(?, ?, ?, ?, ?, ?, ?)",
                     (key, at, at[:10], hh, nm, on, "https://x.com/" + hh if hh else ""))
    conn.commit()
    bm = xdb.query("block_marks", 500)
    ck("拉黑流水按 id 升序带出（进/出各一行）、空 handle 的脏行不入",
       bm["ok"] is True and [(r["id"], r["handle"], r["state"]) for r in bm["rows"]]
       == [(1, "carl", 1), (2, "dave", 1), (3, "dave", 0)],
       [(r["id"], r["handle"], r["state"]) for r in bm["rows"]])
    ck("取消行（state=0）照样在流水里：漏推取消 = 云端拿着旧 state=1 假在榜",
       [r["state"] for r in bm["rows"] if r["handle"] == "dave"] == [1, 0],
       [(r["id"], r["handle"], r["state"]) for r in bm["rows"]])
    ck("行的形状够上云用：id/at/day/handle/name/state/url 七列都在，url 原样带出",
       [(r["at"], r["day"], r["name"], r["url"]) for r in bm["rows"] if r["id"] == 1]
       == [("2026-10-30T10:00:00.000", "2026-10-30", "卡尔", "https://x.com/carl")], bm["rows"][:1])
    ck("游标是 blocks 自增 id：after=carl 那行 ⇒ 只剩 dave 的进/出两行；limit 生效",
       [(r["id"], r["state"]) for r in xdb.query("block_marks", 500, after=bm["rows"][0]["id"])["rows"]]
       == [(2, 1), (3, 0)] and len(xdb.query("block_marks", 1)["rows"]) == 1,
       [(r["id"], r["state"]) for r in xdb.query("block_marks", 500, after=bm["rows"][0]["id"])["rows"]])
    ck("after 翻到底 = 空且 ok=True（空页不是错，客户端据此停手）",
       [xdb.query("block_marks", 500, after=bm["rows"][-1]["id"])["ok"],
        xdb.query("block_marks", 500, after=bm["rows"][-1]["id"])["rows"]] == [True, []],
       xdb.query("block_marks", 500, after=bm["rows"][-1]["id"])["rows"])
    ck("游标形状：负数 / 非数字都明确拒绝（坏游标退成 0 = 把整本拉黑流水重放一遍）",
       [xdb.query("block_marks", 20, after=-1)["ok"], "游标" in xdb.query("block_marks", 20, after=-1).get("err", ""),
        xdb.query("block_marks", 20, after="x")["ok"]],
       [xdb.query("block_marks", 20, after=-1).get("err"), xdb.query("block_marks", 20, after="x").get("err")])
    st0 = xdb.query("block_stat", 20, after=0)["rows"][0]
    ck("拉黑统计：2 个 handle（dave 两行只算一个、取最新那行的 id）、水位 0 时已推 0、max_id 是最新一行",
       [st0["total"], st0["synced"], st0["max_id"]] == [2, 0, 3], st0)
    st2 = xdb.query("block_stat", 20, after=2)["rows"][0]
    ck("水位抬到 carl 那行 ⇒ 已推 1（dave 最新那行 id=3 还在水位外）；抬到 3 ⇒ 2 个全推完",
       [st2["total"], st2["synced"], st2["max_id"]] == [2, 1, 3]
       and xdb.query("block_stat", 20, after=3)["rows"][0]["synced"] == 2,
       [st2, xdb.query("block_stat", 20, after=3)["rows"][0]])
    ck("空 handle 的脏行不进统计分母（total=2 而不是 3）",
       xdb._DB["conn"].execute("SELECT COUNT(DISTINCT handle) FROM blocks").fetchone()[0] == 3
       and st0["total"] == 2, st0)
    ck("统计只吃 after 一个参数（水位是唯一游标，limit 对它没有意义），坏游标当场拒绝、不退成 0",
       xdb.QUERIES["block_stat"].count("?") == 1 and xdb.query("block_stat", 20, after=-1)["ok"] is False
       and xdb.query("block_stat", 20, after="x")["ok"] is False,
       [xdb.QUERIES["block_stat"].count("?"), xdb.query("block_stat", 20, after=-1).get("err")])
    ck("两条查询各吃对占位符数（block_marks 2 / block_stat 1）、且在 help 白名单里露得出名字",
       xdb.QUERIES["block_marks"].count("?") == 2 and xdb.QUERIES["block_stat"].count("?") == 1
       and set(["block_marks", "block_stat"]).issubset(set(r["name"] for r in xdb.query("help", 50)["rows"])),
       [xdb.QUERIES["block_marks"].count("?"), xdb.QUERIES["block_stat"].count("?")])
    if not xdb.open_db(tmp / "xprobe.db"):
        ck("拉黑自检结束后换回主临时库", False, xdb._DB["err"])


def leg_http(xdb, tmp, logs_dir):
    print("\n[B] 端到端：合成一批真机形状的记录打进本机档案库接收端")
    p = subprocess.Popen([sys.executable, "-X", "utf8", str(HERE / "log-sink.py"),
                          "--port", str(PORT), "--dir", str(tmp)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        ping = wait_ping()
        # 只要求「带本机库的那一支」（9 起），不再钉死 == sink-9：接收端每加一种摘要行就换版本号，
        # 写死会让这份自检在每次换版后自己变红，而那跟档案库没关系
        ck("/ping 报的是带本机库的接收端（>= sink-9）且库可用",
           _sink_num(ping.get("sink")) >= 9 and ping["db"]["available"] is True,
           [ping.get("sink"), ping.get("db", {}).get("available"), ping.get("db", {}).get("err")])
        r, code = http("/log", batch(RECS))
        ck("一批 16 条全收（HTTP 200；原 13 + 3 条拉黑流水）", code == 200 and r["ok"] is True and r["stored"] == 16, [code, r])
        p2 = http("/ping")[0]
        got = [p2["db"][k] for k in ("records", "snapshots", "tweets", "userRows", "follows",
                                     "statPoints", "rewardPoints", "dayRows", "storeUsers", "storePosts")]
        ck("/ping 把逐表行数报回来（面板那行读的就是它；reward 多的那条是手动补录，dayRows 是 3 条 reward 双写 + 2 条 dayrow）",
           got == [16, 2, 5, 3, 2, 1, 3, 5, 3, 2], {"expect": [16, 2, 5, 3, 2, 1, 3, 5, 3, 2], "got": got})
        q = http("/db?q=follows&limit=5")[0]
        # 按 handle 取，不按行号：查询是 at DESC，行序是我写的排序决定的，断言不该依赖它
        byh = {r["handle"]: r for r in q["rows"]}
        ck("/db 读到关注流水：61 秒那条合规、30 秒那条标了 rapid",
           len(q["rows"]) == 2 and byh["zz_d"]["gap"] == 61000 and byh["zz_d"]["rapid"] == 0
           and byh["zz_e"]["gap"] == 30000 and byh["zz_e"]["rapid"] == 1, q["rows"])
        rw = http("/db?q=rewards&limit=5")[0]
        byday = {x["day"]: x["value"] for x in rw["rows"]}
        ck("同一天两次曝光 ⇒ reward_days 只留后读到的 10500（不铺两点）；补录天 10-20 另成一行（曝光=None 但四列在）",
           len(rw["rows"]) == 2 and byday.get("2026-10-23") == 10500 and "2026-10-20" in byday,
           [{x["day"]: x["value"]} for x in rw["rows"]])
        pts = http("/db?q=trend&limit=5")[0]
        ck("分钟点进库了（趋势图的料）", len(pts["rows"]) == 1 and pts["rows"][0]["followers"] == 2690, pts["rows"])
        # v0.6.11「每人每天一行」：day_rows 按 handle 记（不再只有登录者），day_latest **按列**取值
        dr = http("/db?q=day_rows&limit=20")[0]
        byhd = {(x["handle"], x["day"]): x for x in dr["rows"]}
        ck("day_rows 成 3 行：我自己 10-23（奖励值进 effective 列，exposure 留给分析页实时曝光）+ 10-20（手补）与别人 10-23（打开主页落的）",
           len(dr["rows"]) == 3 and byhd[("demo_own", "2026-10-23")]["effective"] == 10500
             and byhd[("demo_own", "2026-10-23")]["exposure"] is None
             and byhd[("demo_own", "2026-10-20")]["posts"] == 2870
             and ("demo_peer", "2026-10-23") in byhd, [len(dr["rows"]), dr["rows"]])
        bb = byhd.get(("demo_peer", "2026-10-23")) or {}
        ck("day_latest 按列各取最后一次有数的：晚到那行只补了帖子列，也不许把先落的关注/粉丝说成没有",
           [bb.get("following"), bb.get("followers"), bb.get("posts")] == [812, 1290, 45]
             and bb.get("exposure") is None and bb.get("manual_n") == 1, bb)
        ck("反向对照：别人那一行的曝光列是 None 不是 0（把「没这个数」写成 0 是排名表最贵的一种假）",
           bb.get("exposure") is None and bb.get("exposure") != 0, bb)
        rk = http("/db?q=rank&limit=10")[0]
        ck("rank = 每人最新一行、按关注降序；没关注数的那行排到最后而不是当 0",
           [x["handle"] for x in rk["rows"]] == ["demo_peer", "demo_own"]
             and rk["rows"][0]["following"] == 812 and rk["rows"][1]["effective"] == 10500
             and rk["rows"][1]["exposure"] is None, rk["rows"])
        su = http("/db?q=store_users&limit=5")[0]
        own = [x for x in su["rows"] if x["own"] == 1]
        ck("两张表的内容进库，自己的号认得出来（own=1）",
           len(su["rows"]) == 3 and len(own) == 1 and own[0]["followers"] == 2690, own)
        rec = http("/db?q=recent&limit=20")[0]
        sums = [x["summary"] for x in rec["rows"]]
        ck("recent 带回 _summ 的摘要（不是空白行）", all(sums) and any("store 表=3人/2帖" in s for s in sums),
           [s[:40] for s in sums[:2]])
        st_line = [s for s in sums if s.startswith("store ")][:1]
        ck("store 行按 v0.6.9 的分池形状打（带数字/纯见过两组分开，序列与顶满删旧也在）",
           st_line and ("组=有人数2/纯见1 帖有数1/纯见1 序列=40min/3day" in st_line[0])
           and "带数 aaa:2690/2754" in st_line[0] and "纯见 bbb" in st_line[0]
           and "帖 aaa:看10100/赞40" in st_line[0] and "删旧=0人/7帖" in st_line[0]
           and "顶满" not in st_line[0], st_line)
        rwsum = [s for s in sums if s.startswith("reward[手动]")][:1]
        ck("manual 补录行给独立摘要：没填的曝光列打 -，三个数字列照报（sink-12）",
           rwsum and "reward[手动] @demo_own 2026-10-20 四列 value=-/fow=2754/fans=2690/posts=2870 落库" in rwsum[0],
           rwsum)
        tws = http("/db?q=tweets&limit=10")[0]
        ck("推文的 metrics 原文在库里（浏览器不再存的那份在这儿）",
           len(tws["rows"]) == 5 and all(json.loads(r["metrics"])["reply"]["num"]["value"] == 2 for r in tws["rows"]),
           len(tws["rows"]))
        ur = http("/db?q=user_rows&limit=10")[0]
        ck("列表行拆到 user_rows（名字与出处都在）",
           len(ur["rows"]) == 3 and ur["rows"][0]["name_how"] == "UserName", ur["rows"][:1])
        bad = http("/db?q=tweets%3B%20DROP%20TABLE%20records")[0]
        ck("未知查询被白名单拒（不接外部 SQL）", bad["ok"] is False, bad.get("err"))
        ck("拒完之后 records 一条没少（16 = 原 13 条合成 + 3 条拉黑流水）", http("/ping")[0]["db"]["records"] == 16, http("/ping")[0]["db"]["records"])
        # v0.8.6 时间窗走 HTTP 这条路：只验「形状坏了当场 400、对的时候真回 rows」，
        # 窗口算法本身在 [A3] 那条腿里逐条过，这里不重复论证。
        w0 = http("/db?q=tl_win&hours=0&limit=50")
        ck("HTTP 腿 hours=0（全部）拿到带曝光的历史榜（合成批次 4 条有 view 的推文，去重后每帖一行）",
           w0[1] == 200 and w0[0]["ok"] is True and len(w0[0]["rows"]) > 0
           and all(r["view"] is not None for r in w0[0]["rows"])
           and len({r["tweet_id"] for r in w0[0]["rows"]}) == len(w0[0]["rows"]),
           [w0[1], len(w0[0].get("rows") or [])])
        wn = http("/db?q=tl_win&hours=-1&limit=5")
        ck("HTTP 腿 hours=-1 → 400 说清楚（不静默按 24 小时查）",
           wn[1] == 400 and wn[0]["ok"] is False and "hours" in str(wn[0].get("err")), wn)
        wf = http("/db?q=tl_win&from=2026-10-22&to=2026-10-23&limit=50")
        ck("HTTP 腿 from/to 两日用：拿到行且每行 at 落在窗口里（左闭右开，止日到次日 00:00）",
           wf[1] == 200 and wf[0]["ok"] is True and len(wf[0]["rows"]) > 0
           and all("2026-10-22" <= r["at"][:10] <= "2026-10-23" for r in wf[0]["rows"]),
           [wf[1], [r["at"] for r in wf[0].get("rows") or []][:3]])
        we = http("/db?q=tl_win&from=2026-01-01&to=2026-01-02&limit=50")
        ck("正向对照：同一个查询换成 1 月的窗口 ⇒ ok 但 0 行（证明它真按窗口过滤，不是永远返回全部）",
           we[1] == 200 and we[0]["ok"] is True and len(we[0]["rows"]) == 0, we)
        wr = http("/db?q=tl_win&from=2026-10-23&to=2026-10-22&limit=5")
        wk = http("/db?q=tl_win&from=2026-10-22&limit=5")
        ck("HTTP 腿区间反了 / 只给一端 → 都 400（半截区间最容易看错，不许猜）",
           wr[1] == 400 and "from/to" in str(wr[0].get("err")) and wk[1] == 400,
           [wr[1], wr[0].get("err"), wk[1], wk[0].get("err")])
        # v0.9.7 台账游标走 HTTP 这条路：这里只验「参数形状 + 白名单点名」，
        # 游标滤行本身在 [A4] 逐条过。这份库里标杆台账是空的（t=1 的测试记录不落账）⇒ 空数组才是对的。
        a0 = http("/db?q=bench_marks_ac&after=0&limit=50")
        ck("HTTP 腿 after=0 点名到台账流水（200、ok、query 回显；真机标杆没写过 ⇒ rows 为空不是错）",
           a0[1] == 200 and a0[0]["ok"] is True and a0[0]["rows"] == [] and a0[0]["query"] == "bench_marks_ac", a0)
        ab = http("/db?q=bench_marks_ac&after=-1&limit=5")
        ax = http("/db?q=bench_marks_ac&after=abc&limit=5")
        ck("HTTP 腿 after 负数 / 非数字 → 400 说清楚（悄悄退成 0 = 把整本账重放一遍，比报错糟）",
           ab[1] == 400 and "after" in str(ab[0].get("err")) and ax[1] == 400,
           [ab[1], ab[0].get("err"), ax[1]])
        a1 = http("/db?q=bench_marks_po&limit=50")
        ck("帖子台账流水同样点名得到（单占位符以外的 after 缺省 = 0，第一页从头顶翻）",
           a1[1] == 200 and a1[0]["ok"] is True and a1[0]["rows"] == [], a1)
        nope = http("/nope")
        ck("未知路径 404 且提示有 /db", nope[1] == 404 and "/db" in json.dumps(nope[0], ensure_ascii=False), nope[0])
        ck("raw 里不重复塞原文（page 那行只留拆表说明）",
           "tweets" not in lean_raw_page(tmp).get("data", {}) and "dataNote" in lean_raw_page(tmp),
           lean_raw_page(tmp).get("dataNote"))

        b2 = batch(json.loads(json.dumps(RECS)))
        b2["sentAt"] = "2026-10-23T05:06:00.000Z"
        http("/log", b2)
        ck("重发同一批 ⇒ 库里一条都不新增（幂等，重试不铺两点）",
           http("/ping")[0]["db"]["records"] == 16, http("/ping")[0]["db"]["records"])

        tb = batch([dict(RECS[2], t=1, at="2026-10-23T05:07:00.000Z"), dict(RECS[7], t=1, at="2026-10-23T05:07:10.000Z")])
        http("/log", tb)
        p4 = http("/ping")[0]
        ck("t=1 的批次不进库、只计 testTotal（自检流量不灌档案）",
           p4["db"]["records"] == 16 and p4["db"]["follows"] == 2 and p4["testTotal"] == 2,
           [p4["db"]["records"], p4["db"]["follows"], p4["testTotal"]])

        # sink-16 的 bench 摘要：这条走**真管道**（POST /log → _summ → 落人类日志），不是 grep 源码。
        # 为什么要行为版：JS 那边只能 source-pin（认得「标为标杆」这五个字在文件里），而真机上「谁进谁出」
        # 全靠这一行；分支写错（比如把 on=0 也打成「标为」）源码照样在，日志里却骗人。
        # 仍带 t=1 ⇒ 只进 xprobe-test-*.log，不进 xprobe.db（真机档案不被自检灌水）。
        bb = batch([
            {"kind": "bench", "at": "2026-10-23T05:08:00.000Z", "url": "https://x.com/home", "t": 1,
             "data": {"handle": "alice", "name": "爱丽丝", "on": 1, "tags": ["投资", "AI"]}},
            {"kind": "bench", "at": "2026-10-23T05:08:10.000Z", "url": "https://x.com/home", "t": 1,
             "data": {"handle": "bob", "name": "乙", "on": 0, "tags": []}},
        ])
        http("/log", bb)
        tlog = Path(tmp) / ("xprobe-test-%s.log" % datetime.now().strftime("%Y-%m-%d"))
        txt = tlog.read_text(encoding="utf-8") if tlog.exists() else ""
        ck("bench 摘要行真打出来了（进=「标为标杆 + 分类」，出=「移出标杆」，没标签写 -；不是兜底的 bench <url>）",
           "bench @alice 标为标杆 tags=投资,AI" in txt and "bench @bob 移出标杆 tags=-" in txt,
           [l for l in txt.splitlines() if "bench" in l][-2:])
        p5 = http("/ping")[0]
        ck("这两条 t=1 只加 testTotal（2→4）、库里 records 仍 16（测试不落账：`benchmarks` 表也一条不多）",
           p5["testTotal"] == 4 and p5["db"]["records"] == 16
           and http("/db?q=benchmarks&limit=5")[0]["rows"] == [],
           [p5["testTotal"], p5["db"]["records"]])

        # sink-17 的 benchpost 摘要：同一条真管道（POST /log → _summ → 落人类日志）。
        # tweet id 是这本账的主键，摘要必须打出「哪条帖进/出」+ 作者 + 正文头 40 字；
        # 分支写错就只剩兜底的 "benchpost <url>"，日志里看不出谁进谁出（与 sink-16 那条同一理由要行为版）。
        bp0 = batch([
            {"kind": "benchpost", "at": "2026-10-23T06:00:00.000Z",
             "url": "https://x.com/carol/status/2114903455361888482", "t": 1,
             "data": {"id": "2114903455361888482", "author": "carol", "text": "标杆帖子这一条的正文", "on": 1, "tags": ""}},
            {"kind": "benchpost", "at": "2026-10-23T06:00:10.000Z", "url": "https://x.com/home", "t": 1,
             "data": {"id": "999888777666", "author": "", "text": "", "on": 0, "tags": ""}},
        ])
        http("/log", bp0)
        txt2 = tlog.read_text(encoding="utf-8") if tlog.exists() else ""
        ck("benchpost 摘要行真打出来了（进=「标为标杆帖 + id + @作者 + 正文头」；出=「移出标杆帖」，空作者/空正文写 -）",
           "benchpost 2114903455361888482 标为标杆帖@carol 标杆帖子这一条的正文" in txt2
           and "benchpost 999888777666 移出标杆帖@- -" in txt2,
           [l for l in txt2.splitlines() if "benchpost" in l][-2:])
        p6 = http("/ping")[0]
        ck("benchpost 两条 t=1 只加 testTotal（4→6）、真机库 records 与 bench_posts 一条不多（测试不落账）",
           p6["testTotal"] == 6 and p6["db"]["records"] == 16
           and http("/db?q=bench_posts&limit=5")[0]["rows"] == [],
           [p6["testTotal"], p6["db"]["records"]])

        bl = http("/db?q=blocks&limit=5")[0]
        ck("/db 读到拉黑流水：最新一条是 dave 的取消（state 0），carl 拉了还在名单上",
           bl["rows"][0]["handle"] == "dave" and bl["rows"][0]["state"] == 0
           and any(r["handle"] == "carl" and r["state"] == 1 for r in bl["rows"]), bl["rows"])

        d, _c = http("/dump", {"tab": "profile", "handle": "demo_own", "url": "https://x.com/demo_own",
                               "tree": "A" * 3000, "text": "正文" * 500, "html": "<html/>" * 100, "t": 0,
                               "counts": {"ms": 41, "treeEmitted": 900, "treeNodes": 1200, "hitCap": False}})
        dd = http("/db?q=dumps&limit=3")[0]
        ck("整页转储在库里有账（能回答「最新那份在哪」）",
           d["ok"] is True and len(dd["rows"]) == 1 and dd["rows"][0]["tree_bytes"] == 3000 and dd["rows"][0]["ms"] == 41,
           [d.get("dir"), dd["rows"]])
        tb2 = http("/db?q=tables")[0]
        ck("q=tables 给出逐表行数与库大小（blocks 表也在：3 条流水）",
           tb2["db"]["tables"]["records"] == 16 and tb2["db"]["tables"]["blocks"] == 3 and tb2["db"]["bytes"] > 0, tb2["db"]["bytes"])

        if logs_dir:
            print("\n[C] 真机档案重放：%s" % logs_dir)
            import importlib.util
            spec = importlib.util.spec_from_file_location("log_sink_mod", str(HERE / "log-sink.py"))
            sink = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(sink)
            out = xdb.backfill(logs_dir, lambda s: None, sink._summ)
            lines = sum(1 for f in sorted(Path(logs_dir).glob("*.ndjson")) if not f.name.startswith("test-")
                        for ln in f.open(encoding="utf-8") if ln.strip())
            st = xdb.stats()
            ck("重放：失败与坏行都为 0", out["failed"] == 0 and out["bad"] == 0, out)
            ck("重放：records 行数 = 真机行数（补档没吞行）",
               st["tables"]["records"] == lines - out["test"] + 12, [st["tables"]["records"], lines, out["test"]])
            ck("重放：快照拆出行且摘要回填（历史不是空壳）",
               st["tables"]["snapshots"] > 0 and http("/db?q=snapshots&limit=3")[0]["ok"] is True,
               st["tables"]["snapshots"])
    finally:
        p.terminate()
        try:
            p.wait(timeout=5)
        except Exception:
            p.kill()


# v0.11.4 假模型（只服务于 native 那条 llm 腿）。它存在的意义不是「答得像」，而是**数得清**：
# 每次校验不过都得当场证明「一个请求都没出门」，这只有靠服务端计数才量得出来 —— 光看宿主回包
# 说不出「它是拒了，还是打错了地址却没留下任何痕迹」。只听 127.0.0.1，端口交给系统挑（0 = 不撞车）。
LLM_DUMMY = {"posts": 0, "gets": 0, "hits": set()}


def llm_dummy():
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import urlparse

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):    # 别把访问日志喷进自检的输出
            pass

        def _out(self, code, obj, extra=None):
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                if extra:
                    for k, v in extra.items():
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except Exception:
                pass    # 对面提前收线（超时/断开）不该把整份自检带进 traceback

        def do_POST(self):
            LLM_DUMMY["posts"] += 1
            LLM_DUMMY["hits"].add(self.path)
            LLM_DUMMY["hits"].add("host:" + str(self.headers.get("Host") or ""))
            n = int(self.headers.get("Content-Length") or 0)
            try:
                b = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                b = {}
            if self.path == "/api/generate":
                if str(b.get("prompt")) == "redir":
                    self._out(302, {"nope": "别跟这一跳"}, {"Location": "http://127.0.0.1:1/away"})
                    return
                self._out(200, {"model": b.get("model") or "d", "response": "DRAFT:" + str(b.get("prompt"))})
            elif self.path == "/api/chat":
                self._out(200, {"message": {"role": "assistant", "content": "CHAT_DRAFT"}})
            elif self.path == "/v1/chat/completions":
                self._out(200, {"choices": [{"message": {"role": "assistant", "content": "OPENAI_DRAFT"}}]})
            else:
                self._out(404, {"error": "no such path: " + self.path})

        def do_GET(self):
            LLM_DUMMY["gets"] += 1
            LLM_DUMMY["hits"].add(self.path)
            if self.path in ("/api/tags", "/v1/models"):
                self._out(200, {"models": [{"name": "dummy-1", "model": "dummy-1"}, {"name": "dummy-2"}]})
            else:
                self._out(404, {"error": "no such path: " + self.path})

    srv = HTTPServer(("127.0.0.1", 0), H)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, th, srv.server_address[1]


# v0.11.16：一台「会应答的假代理」。把「这台机器恰好没设 HTTP_PROXY」从红线里摘出去 ——
# 显式把 HTTP_PROXY / HTTPS_PROXY 指到它、把 no_proxy 清空，再喂给宿主子进程。
# 只要 build_opener 里那只空 ProxyHandler 被拆掉，回环模型请求就会被它接走并回 502，
# 判据当场红，与跑自检的机器有没有代理无关（RL-2 / RL-19 / RL-27②）。
PROXY_HITS = {"n": 0}


def poison_proxy():
    from http.server import BaseHTTPRequestHandler, HTTPServer

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


def leg_native(tmp):
    """[E] 原生宿主：不走 HTTP、不走端口，扩展跟进程直接对帧。
    为什么这条腿必须存在：宿主是「不用先开 bat」的唯一实现，而它最容易坏在两处静默的地方 ——
    stdout 混进一行日志（Chrome 整条消息作废）、数据目录取错（写进一个叫 chrome-extension: 的目录）。"""
    import struct

    print("\n[E] Native Messaging 宿主：与 HTTP 同一份回包形状（扩展直连本机库，不用先开 bat）")
    ndir = tmp / "native"
    psrv, pth, pport = poison_proxy()
    purl = "http://127.0.0.1:%d" % pport
    PROXY_HITS["n"] = 0
    # 清空 no_proxy 是关键：留着系统那份（常见 127.0.0.1,localhost）会让这条判据假绿。
    env = dict(os.environ, XPROBE_DIR=str(ndir),
               HTTP_PROXY=purl, http_proxy=purl,
               HTTPS_PROXY=purl, https_proxy=purl,
               NO_PROXY="", no_proxy="")
    # argv[1] 就是 Chrome 传的扩展 origin —— 上一版把它当数据目录用过，这句是那条事故的回归位
    host = [sys.executable, "-X", "utf8", str(HERE / "native" / "xprobe_host.py"),
            "chrome-extension://" + "a" * 32 + "/"]

    def frame(obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        return struct.pack("<I", len(raw)) + raw

    def recv(p):
        head = p.stdout.read(4)
        if not head or len(head) < 4:
            return None
        n = struct.unpack("<I", head)[0]
        return json.loads(p.stdout.read(n).decode("utf-8"))

    p = subprocess.Popen(host, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, env=env)
    # 帧读是阻塞的：宿主若真挂了，这条腿会把整份自检吊死。给它一个死线，让故障变成一条 FAIL。
    killer = threading.Timer(30, lambda: p.poll() is None and p.kill())
    killer.daemon = True
    killer.start()

    def rt(obj):
        p.stdin.write(frame(obj))
        p.stdin.flush()
        return recv(p)

    # v0.11.4：假模型服务（llm 那条腿的靶子）。变量在这里起，try/finally 都看得见 ——
    # 起靶子这件事本身失败也要走收尾，不能把宿主进程留成孤儿。
    srv, th, llm_port = None, None, 0
    LLM_DUMMY["posts"] = 0
    LLM_DUMMY["gets"] = 0
    LLM_DUMMY["hits"] = set()

    try:
        srv, th, llm_port = llm_dummy()
        o = rt({"t": "ping"})
        body = json.loads(o["body"])
        # 版本只要求「带 /fs 那一档起（native-2）」，不钉死字符串：宿主每加一种通道就换版本号，
        # 写死会让这份自检在每次换版后自己变红，而那跟功能没关系（和上面 sink 那条同一个理由）
        ck("ping：宿主自报 native-2 起、带 /fs 通道，body 与 HTTP /ping 形状一致（面板/core 一行都不用改）",
           o["ok"] is True and o["status"] == 200 and _host_num(o.get("host")) >= 2
           and _sink_num(body.get("sink")) >= 15 and body.get("db", {}).get("available") is True,
           {"status": o.get("status"), "host": o.get("host"), "sink": body.get("sink")})
        ck("库与日志都落在 XPROBE_DIR（argv[1] 是 origin，不是路径）",
           (ndir / "xprobe.db").exists() and (ndir / "native-host.log").exists(),
           sorted(x.name for x in ndir.iterdir()) if ndir.exists() else "目录没建")

        one = {"kind": "follow", "at": "2026-10-24T00:00:00.000Z", "url": "https://x.com/native_probe",
               "tab": "profile", "t": 0, "ver": "0.7.0",
               "data": {"dir": "follow", "targetId": "1", "handle": "native_probe", "why": "attr", "gap": 61000}}
        lo = rt({"t": "log", "body": json.dumps(batch([one]), ensure_ascii=False)})
        d1 = json.loads(rt({"t": "ping"})["body"])["db"]
        ck("log：t=0 的记录真进库（stored=1，紧接着 ping 的库计数跟着动）",
           json.loads(lo["body"])["stored"] == 1 and d1["records"] == 1 and d1["follows"] == 1,
           [json.loads(lo["body"]).get("stored"), d1["records"], d1["follows"]])
        to = rt({"t": "log", "body": json.dumps(batch([dict(one, t=1)]), ensure_ascii=False)})
        d2 = json.loads(rt({"t": "ping"})["body"])["db"]
        ck("t=1 的自检流量在 native 这条路上也不许入档（stored=0 且库里还是 1 条）",
           json.loads(to["body"])["stored"] == 0 and d2["records"] == 1,
           [json.loads(to["body"]).get("stored"), d2["records"]])

        qb = rt({"t": "db", "q": "posts_top", "limit": 3})
        ck("/db 走白名单查询（和 HTTP /db 同一份实现，没有第二条 SQL 路）",
           qb["status"] == 200 and json.loads(qb["body"])["ok"] is True and "rows" in qb["body"], qb.get("status"))
        bad = rt({"t": "db", "q": "tweets; DROP TABLE records", "limit": 3})
        after = rt({"t": "ping"})
        ck("坏查询是回包里的 400、进程不崩（下一帧照答，records 一条没少）",
           bad["status"] == 400 and json.loads(bad["body"])["ok"] is False
           and after["status"] == 200 and json.loads(after["body"])["db"]["records"] == 1,
           [bad.get("status"), json.loads(after["body"])["db"]["records"]])
        unk = rt({"t": "nope"})
        ck("未知通道回 404（宿主不猜、不吞）", unk["status"] == 404, unk)

        # v0.8.6 时间窗在 native 这条路的形状：宿主自己那套校验要和 HTTP 腿一样硬（两扇门不同锁 = 迟早出事）
        li = rt({"t": "log", "body": json.dumps(batch([page_rec(
            "2026-10-24T00:00:00.000Z", "native_probe", "home", 3, [])]), ensure_ascii=False)})
        ck("先落一条 home 快照（3 条推文，首条是推广位被剔除）：stored>=1",
           li["status"] == 200 and json.loads(li["body"])["stored"] >= 1, li)
        n0 = rt({"t": "db", "q": "tl_win", "hours": 0, "limit": 50})
        b0 = json.loads(n0["body"])
        ck("宿主 hours=0 ⇒ 200 且有行、每行都带曝光、每帖只一行（去重在 SQL 里做完了）",
           n0["status"] == 200 and b0.get("ok") is True and len(b0.get("rows") or []) > 0
           and all(r["view"] is not None for r in b0["rows"])
           and len({r["tweet_id"] for r in b0["rows"]}) == len(b0["rows"]),
           [n0.get("status"), len(b0.get("rows") or []), b0.get("err")])
        nb = rt({"t": "db", "q": "tl_win", "hours": -5})
        ck("宿主 hours=-5 ⇒ 400 报 hours（不把坏参数降级成 24 小时）",
           nb["status"] == 400 and "hours" in str(json.loads(nb["body"]).get("err")), nb)
        nr = rt({"t": "db", "q": "tl_win", "from": "2026-10-24", "to": "2026-10-23"})
        nk = rt({"t": "db", "q": "tl_win", "from": "2026-10-24"})
        ck("宿主区间反了 / 只给 from ⇒ 都 400 报 from/to（和 HTTP 腿同一句话）",
           nr["status"] == 400 and "from/to" in str(json.loads(nr["body"]).get("err"))
           and nk["status"] == 400, [nr.get("status"), nk.get("status")])
        nf = rt({"t": "db", "q": "tl_win", "from": "2026-10-24", "to": "2026-10-24"})
        ck("宿主 from=to 单日 ⇒ 200（单日是最常被点的一种区间，别当成非法）",
           nf["status"] == 200 and json.loads(nf["body"]).get("ok") is True, nf.get("status"))
        nj = rt({"t": "db", "q": "recent", "limit": 3})
        ck("这些坏参数只回包、不弄死进程（下一帧 normal 查询照答）",
           nj["status"] == 200 and json.loads(nj["body"]).get("ok") is True, nj.get("status"))

        # v0.9.7 台账游标在 native 这条路也要认（两扇门不同锁 = 迟早出事）。
        # 数据语义在 [A4] 逐条过、打包版在 native/exe-check.py [4c] 过，这里只验宿主那一跳的参数。
        s0 = rt({"t": "db", "q": "bench_marks_ac", "after": 0, "limit": 50})
        ck("宿主 after=0 ⇒ 200/ok（第一页从头顶翻，空账不是错）",
           s0["status"] == 200 and json.loads(s0["body"]).get("ok") is True,
           [s0.get("status"), json.loads(s0["body"]).get("err")])
        sb = rt({"t": "db", "q": "bench_marks_ac", "after": -2, "limit": 5})
        ck("宿主 after=-2 ⇒ 400 报 after（坏游标不许降级成「整本账重放一遍」）",
           sb["status"] == 400 and "after" in str(json.loads(sb["body"]).get("err")), sb.get("status"))
        sq = rt({"t": "db", "q": "bench_marks_po", "limit": 50})
        ck("帖子流水点名得到（未传 after = 缺省 0，与 HTTP 那条路同口径）",
           sq["status"] == 200 and json.loads(sq["body"]).get("ok") is True, sq.get("status"))

        # v0.8.8 本机文件通道在 native 这条路：宿主必须与 HTTP 共用 xprobe_fs 那一份实现，
        # 且「dry 缺省 = 只量不删」这条保命默认值在宿主这边也得成立（面板少传一个字段 ≠ 立刻删文件）
        fo = rt({"t": "fs"})
        fb = json.loads(fo["body"])
        ck("/fs sizes 走宿主同一条实现：ok、带 keep=7 与 items 四档（logs/dump/db/host）",
           fo["status"] == 200 and fb.get("ok") is True and fb.get("keep") == 7
           and set(["logs", "dump", "db", "host"]) <= set((fb.get("items") or {}).keys()),
           [fo.get("status"), fb.get("keep"), sorted((fb.get("items") or {}).keys())])
        fbad = rt({"t": "fs", "op": "clean", "target": "db"})
        ck("宿主不许删库：target=db 当场拒（库那一档只有 VACUUM，删行是另一件事）",
           fbad["status"] == 400 and json.loads(fbad["body"])["ok"] is False
           and "只认 logs / dump" in str(json.loads(fbad["body"]).get("err")), fbad)
        fpath = rt({"t": "fs", "op": "clean", "target": "../logs"})
        ck("target 里塞 ../ 也拒（浏览器传不进路径，这条不是摆设）",
           fpath["status"] == 400 and json.loads(fpath["body"])["ok"] is False, fpath)
        fdry = rt({"t": "fs", "op": "clean", "target": "logs", "days": 0})
        ck("缺 dry 且 days=0 ⇒ 既不真删也不全删：dry 缺省为真、keep 落回 7",
           fdry["status"] == 200 and json.loads(fdry["body"]).get("dry") is True
           and json.loads(fdry["body"]).get("keep") == 7, fdry)
        ck("上面这几枪之后库文件还在（宿主没把 xprobe.db 当垃圾）", (ndir / "xprobe.db").exists(),
           sorted(x.name for x in ndir.iterdir()) if ndir.exists() else "目录没了")

        # ---------- v0.11.4 本机模型通道（llm）：宿主是这条腿的唯一出口 ----------
        # 为什么要在 native 这条腿上钉：模型请求「不进 host_permissions」是这一版的全部理由
        # （RL-3：申请了不用也是扩权）。它一旦能被诱导打到非回环地址，那句话就成了假话。
        ck("本机模型：假模型在跑（只听 127.0.0.1 的临时端口 %d）" % llm_port, llm_port > 0, llm_port)
        o1 = rt({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:%d" % llm_port,
                 "prompt": "原文：今天曝光涨了", "model": "dummy-1"})
        b1 = json.loads(o1["body"])
        ck("generate 这一档真打到假模型并回正文（宿主自报 native-7 = 认这条通道；旧版回包连 hver 都没有）",
           o1["status"] == 200 and b1.get("ok") is True and b1.get("text") == "DRAFT:原文：今天曝光涨了"
           and _host_num(o1.get("host")) >= 7 and _host_num(b1.get("hver")) >= 7,
           [o1.get("status"), b1.get("text"), o1.get("host"), b1.get("hver")])
        ck("假模型只被打了 /api/generate 这一次（POST=1），且 Host 就是那台回环靶子（除它以外一个地址都没碰）",
           LLM_DUMMY["posts"] == 1 and "/api/generate" in LLM_DUMMY["hits"]
           and any(str(h).startswith("host:127.0.0.1:") for h in LLM_DUMMY["hits"]),
           dict(LLM_DUMMY, hits=sorted(LLM_DUMMY["hits"])))
        o2 = rt({"t": "llm", "endpoint": "openai", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "x", "model": "m1"})
        ck("openai 兼容档读的是 choices[0].message.content（两条协议各有一只手，别拿一条的形状去摸另一条）",
           o2["status"] == 200 and json.loads(o2["body"]).get("text") == "OPENAI_DRAFT",
           json.loads(o2["body"]))
        o3 = rt({"t": "llm", "endpoint": "chat", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "x"})
        ck("chat 档读 message.content；没传 model 就原样不编（模型名以宿主回的那一份为准）",
           o3["status"] == 200 and json.loads(o3["body"]).get("text") == "CHAT_DRAFT", json.loads(o3["body"]))
        o4 = rt({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:%d" % llm_port, "list": "tags"})
        ck("列模型（/api/tags）回的是模型名数组（面板那颗「测活」就靠它说出装了什么）",
           o4["status"] == 200 and json.loads(o4["body"]).get("models") == ["dummy-1", "dummy-2"], json.loads(o4["body"]))
        LLM_DUMMY["posts"] = 0
        LLM_DUMMY["gets"] = 0
        for bad, why in [
            ({"t": "llm", "endpoint": "generate", "base": "https://ollama.example.com", "prompt": "x"}, "https 的公网地址"),
            ({"t": "llm", "endpoint": "generate", "base": "http://8.8.8.8:11434", "prompt": "x"}, "非回环 IP"),
            ({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:11434/api/generate", "prompt": "x"}, "想自己拼路径"),
            ({"t": "llm", "endpoint": "bogus", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "x"}, "端点不在这三档里"),
            ({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "  "}, "正文是空的"),
        ]:
            ob = rt(bad)
            bb = json.loads(ob["body"])
            ck("拒绝 %s ⇒ 400 且一个请求都没发出去（假模型计数还是 0）" % why,
               ob["status"] == 400 and bb.get("ok") is False
               and LLM_DUMMY["posts"] == 0 and LLM_DUMMY["gets"] == 0,
               [ob.get("status"), bb.get("err"), dict(LLM_DUMMY)])
        od = rt({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:%d" % llm_port, "prompt": "redir"})
        ck("假模型回 302 想把宿主支到别的地址：不跟跳（跟了就是「宿主替页面上外网」，那条红线一句话就破）",
           od["status"] == 502 and LLM_DUMMY["posts"] == 1 and "/away" not in LLM_DUMMY["hits"],
           [od.get("status"), dict(LLM_DUMMY, hits=sorted(LLM_DUMMY["hits"])), json.loads(od["body"]).get("err")])
        LLM_DUMMY["posts"] = 0
        oc = rt({"t": "llm", "endpoint": "generate", "base": "http://127.0.0.1:1", "prompt": "x"})
        ck("端口形状对但没人听 ⇒ 宿主自己把它打成「连不上」（不是 traceback，也不是 0 字节的成功）",
           oc["status"] == 502 and "连不上" in str(json.loads(oc["body"]).get("err")), json.loads(oc["body"]))
        ck("毒代理在场（HTTP_PROXY 指着会回 502 的假代理、no_proxy 清空）⇒ 整条 llm 腿一次都没找它："
           "拆掉 NO_PROXY 就当场红，与跑自检的机器设没设代理无关",
           PROXY_HITS["n"] == 0, PROXY_HITS["n"])
        ck("源码形状也钉住：build_opener 必须同时带不跟跳转与不走代理两只手（别被顺手简化掉）",
           "build_opener(NO_REDIRECT, NO_PROXY)" in
           (HERE / "native" / "xprobe_host.py").read_text(encoding="utf-8"), True)
        on = rt({"t": "nope2"})
        ck("未知通道照旧 404（新增一条腿不改变别的语义）", on["status"] == 404, on.get("status"))

        p.stdin.write(b"\x09\x00\x00\x00{not json")   # 帧长 9 = 内容正好 9 字节，只是不是合法 JSON
        p.stdin.flush()
        br = recv(p)
        ck("坏 JSON 帧：回一帧「读帧失败」再退出（不把 traceback 写进 stdout —— Chrome 会判成坏帧）",
           br is not None and br.get("ok") is False and "读帧失败" in str(br.get("err")), br)
        p.stdin.close()
        rest = p.stdout.read()
        err = p.stderr.read()
        code = p.wait(timeout=15)
        ck("收尾：stdin 关掉就干净退出（码 0），stdout 除帧外一个字节都没有",
           rest == b"" and code == 0, [rest[:80], code])
        ck("stderr 空（人读日志全在 native-host.log，漏一行到 stdout 就整条消息作废）", err == b"", err[:120])
        logtxt = (ndir / "native-host.log").read_text(encoding="utf-8", errors="replace")
        ck("人读日志真的落盘了（不是 0 字节：曾经把 write 绑定方法当文件对象传进去，日志全丢还查不出来）",
           len(logtxt) > 0, len(logtxt))
    except Exception as e:
        ck("native 腿没跑完（根因看上面那条 FAIL；这里只留异常本身，别把摘要盖掉）",
           False, "%s: %s" % (type(e).__name__, e))
    finally:
        killer.cancel()
        if p.poll() is None:
            p.kill()
        if srv is not None:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:
                pass
        if th is not None:
            th.join(timeout=3)
        if psrv is not None:
            try:
                psrv.shutdown()
                psrv.server_close()
            except Exception:
                pass
        if pth is not None:
            pth.join(timeout=3)


FS_PORT = 8792
FS_BASE = "http://127.0.0.1:%d" % FS_PORT


def leg_fs(tmp):
    """[F] 本机文件与清理（v0.8.8）：占用测量 + 按保留天数删除，先单元后腿端到端。
    为什么这条腿必须存在：删除是本项目唯一一件做错了回不来的动作，而它的开关装在浏览器里
    （设置页三枚钮 + 一格保留天数）。这里钉死四件事 ——
    ① 判龄先认文件名（mtime 会被备份工具摸新）；② DRY 与实删共用同一份计划，钮上说的就是本机删的；
    ③ 库（xprobe.db）永远不在删除目标里，VACUUM 也只压实不删行；④ 缺 dry / keep=0 这类少传的字段
    一律落到保守那一侧（只量、落回 7 天），绝不因为面板没传就顺手清光。"""
    import xprobe_fs as xfs
    print("\n[F] 本机文件与清理：文件名判龄 / DRY 与实删同一份计划 / 库不是删除目标 / keep 坏值落回 7")
    today = datetime.now().strftime("%Y-%m-%d")
    d10 = (datetime.now() - timedelta(days=10)).strftime("%Y-%m-%d")
    d30 = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    fd = tmp / "fs"
    fd.mkdir()

    def w(rel, size, mtime_days=None):
        p = fd / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"z" * size)
        if mtime_days is not None:
            t = time.time() - mtime_days * 86400
            os.utime(p, (t, t))
        return p

    plan_names = lambda r: set(r.get("names") or [])
    # 造一份「真机形状」的目录：今天的 + 30 天前的 + 名字里没日期但 mtime 很老的 + 名字里写今天却被备份摸新的
    w("logs/%s.ndjson" % d30, 2000)
    w("logs/%s.ndjson" % today, 300)
    w("logs/handy.txt", 111, mtime_days=40)                       # 名字无日期 ⇒ 按 mtime 判
    w("xprobe-%s.log" % d30, 1000)
    w("xprobe-%s.log" % today, 800)
    w("bad-POST.log", 500, mtime_days=12)                          # 无日期名 ⇒ mtime 老就该清
    w("dump/%s_120000-profile-a/tree.json" % d30, 1500)
    w("dump/%s_120000-profile-a/text.txt" % d30, 500)
    w("dump/%s_130000-home/tree.json" % today, 400)
    w("dump/index.log", 60)                                        # 登记文件：跟着年龄走，这里是新的
    w("dump-test/%s_140000-profile-b/tree.json" % d30, 900)
    w("xprobe.db", 5000)                                           # 假的：本模块只 stat，不开库
    w("notes-do-not-touch.md", 700, mtime_days=90)                 # 不在白名单里的扩展名，再老也不该进计划

    s = xfs.sizes(fd)
    # logs 档 = logs\ 里的 3 个（30 天前那份 + 今天那份 + 无日期名但 mtime 40 天的 handy.txt）
    #          + 根目录 3 个（xprobe-<30 天>.log、xprobe-<今天>.log、bad-POST.log）
    # dump 档 = dump\ 与 dump-test\ 下的 3 个目录 + index.log；库与 notes-*.md 各归各
    ck("sizes：四档都报（logs/dump/db/host）且 keep 缺省 7、auto 缺省开、total 把全目录都数进去",
       s["ok"] is True and s["keep"] == 7 and s["auto"] is True
       and s["items"]["logs"]["files"] == 6 and s["items"]["logs"]["bytes"] == 2000 + 300 + 111 + 1000 + 800 + 500
       and s["items"]["dump"]["dirs"] == 3 and s["items"]["dump"]["bytes"] == 2000 + 400 + 900 + 60
       and s["items"]["db"]["bytes"] == 5000 and s["total"] == 2411 + 2300 + 3360 + 5000 + 700,
       {k: s["items"][k] for k in ("logs", "dump", "db", "host")})
    ck("正向对照：拿不到空闲页时 db.free 是 None（面板显示「未知」），不是 0（0 等于说「不用清」这句假话）",
       s["items"]["db"]["free"] is None, s["items"]["db"])

    dry_logs = xfs.clean(fd, "logs", dry=True)
    ck("DRY 只列过保留期的那几份：30 天前的日志 + 无日期但 mtime 老的 bad-POST.log/handy.txt，今天的两份不在内",
       dry_logs["dry"] is True and dry_logs["keep"] == 7
       and plan_names(dry_logs) == set(["logs/%s.ndjson" % d30, "logs/handy.txt",
                                        "xprobe-%s.log" % d30, "bad-POST.log"]),
       sorted(plan_names(dry_logs)))
    ck("正向对照：DRY 一个字节都没删（挨个 stat 还在，字节数也没变）",
       all((fd / n).exists() for n in dry_logs["names"])
       and (fd / "logs" / ("%s.ndjson" % d30)).stat().st_size == 2000,
       [len(dry_logs["names"]), (fd / "logs" / ("%s.ndjson" % d30)).exists()])
    ck("「名字里写今天」压过 mtime：把今天的日志摸成 40 天前也照样不删（判龄先认文件名）",
       "logs/%s.ndjson" % today not in plan_names(dry_logs), sorted(plan_names(dry_logs)))
    ck("白名单外的扩展名再老也不在计划里（notes-do-not-touch.md 90 天）",
       not any("do-not-touch" in n for n in plan_names(dry_logs)), sorted(plan_names(dry_logs)))
    empty = tmp / "fs-empty"
    empty.mkdir()
    e = xfs.clean(empty, "logs", dry=True)
    ck("空目录 DRY：ok=True + files=0 + note 说「没有超过 7 天的日志可删」（不是缺字段）",
       e["ok"] is True and e["files"] == 0 and e["willFree"] == 0 and e["names"] == [] and e.get("note"), e)
    ck("keep=0 / 负数 / 'abc' / 9999 ⇒ 全落回保守侧（0 天不等于全删，坏值不等于没传）",
       [xfs.norm_keep(v) for v in (0, -5, None, "abc", "", 9999, 30, 7.5)] ==
       [7, 7, 7, 7, 7, 365, 30, 7], [xfs.norm_keep(v) for v in (0, -5, None, "abc", "", 9999, 30, 7.5)])
    ck("target 只认 logs / dump：db、../、logs/、空 全拒，且拒的时候一个文件都没动",
       all(xfs.clean(fd, t, dry=False)["ok"] is False for t in ("db", "../logs", "logs/", "", None))
       and (fd / "xprobe.db").exists() and (fd / "logs" / ("%s.ndjson" % today)).exists(),
       [xfs.clean(fd, "db", dry=False).get("err")])
    ck("数据目录不存在 ⇒ ok=False 说清楚（不抛异常，免得宿主那一侧只剩一帧空回包）",
       xfs.clean(tmp / "nope-dir", "logs", dry=True)["ok"] is False, xfs.clean(tmp / "nope-dir", "logs"))

    d2 = tmp / "fs2"
    shutil.copytree(fd, d2)
    real = xfs.clean(d2, "dump", dry=False)
    ck("实删删的就是 DRY 那份计划：dump 里 30 天前的两个目录没了、今天的目录与 index.log 留着",
       real["removed"] == 2 and real["freed"] == 2000 + 900
       and not (d2 / "dump" / ("%s_120000-profile-a" % d30)).exists()
       and not (d2 / "dump-test" / ("%s_140000-profile-b" % d30)).exists()
       and (d2 / "dump" / ("%s_130000-home" % today)).exists() and (d2 / "dump" / "index.log").exists(),
       [real.get("removed"), real.get("freed"), real.get("failedCount")])
    ck("实删之后库文件原样在（xprobe.db 从来不是删除目标）", (d2 / "xprobe.db").exists(), sorted(
        x.name for x in d2.iterdir()))
    runs = xfs.load_conf(d2).get("runs") or []
    ck("每次实删记一笔进 clean.json 的 runs（面板「上次实删」那半句读它，不留账就只能靠猜）",
       len(runs) == 1 and runs[0]["target"] == "dump" and runs[0]["removed"] == 2, runs)

    # 自动清理：每天最多一次，且 auto 关掉就一枪不发
    d3 = tmp / "fs3"
    shutil.copytree(fd, d3)
    a1 = xfs.auto_clean_due(d3)
    ck("auto_clean_due 第一次跑：logs 与 dump 都扫（logs 4 个：两份 30 天前的 + 两个无日期名但 mtime 老的）、"
       "今天的与库留下",
       a1["ok"] is True and a1["targets"]["logs"]["removed"] == 4 and a1["targets"]["dump"]["removed"] == 2
       and (d3 / "logs" / ("%s.ndjson" % today)).exists() and (d3 / "xprobe.db").exists(), a1["targets"])
    w2 = d3 / "logs" / ("%s.ndjson" % d30)
    w2.parent.mkdir(parents=True, exist_ok=True)
    w2.write_bytes(b"z" * 1234)
    a2 = xfs.auto_clean_due(d3)
    ck("同日第二次 ⇒ 跳过（lastAuto 已记今天）：新落的过期文件活着，等明天那一枪",
       a2.get("skipped") == "今天已清过" and w2.exists(), [a2.get("skipped"), w2.exists()])
    xfs.save_conf(d3, dict(xfs.load_conf(d3), auto=False))
    a3 = xfs.auto_clean_due(d3)
    ck("面板把「自动清理」关掉 ⇒ 一枪不发（钮还在，用户自己点）",
       a3.get("skipped") == "auto 关着" and w2.exists(), [a3.get("skipped"), w2.exists()])
    ck("自动清理的账重新读一遍再写：runs 里既有 dump 那笔也有 logs 那笔（早先覆盖过一次，把账抹没了）",
       len(xfs.load_conf(d3)["runs"]) == 2 and {r["target"] for r in xfs.load_conf(d3)["runs"]} == {"logs", "dump"},
       xfs.load_conf(d3)["runs"])

    # ---- HTTP 端到端（sink-15 的 /fs：读、写、库那档的 VACUUM 全走接收端）----
    print("  [F-http] /fs 端到端：GET 撞每日自动清理、POST 只认四个受控值、vacuum 不删行")
    fh = tmp / "fs-http"
    (fh / "logs").mkdir(parents=True)
    # 启动前就先摆一份过期的转储目录：sink 一起来就该扫掉它 —— 这就是「默认 7 天自动清理」真落地的那一下
    pre = fh / "dump" / ("%s_120000-profile-old" % d30)
    (pre / "sub").mkdir(parents=True)
    (pre / "sub" / "tree.json").write_bytes(b"z" * 1200)
    p = subprocess.Popen([sys.executable, "-X", "utf8", str(HERE / "log-sink.py"),
                          "--port", str(FS_PORT), "--dir", str(fh)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        fp = wait_ping(base=FS_BASE)
        ck("/ping 报的是带 /fs 通道的接收端（>= sink-15）", _sink_num(fp.get("sink")) >= 15, fp.get("sink"))
        ck("开机那一枪真扫：sink 一起来就把启动前摆着的过期转储目录删了（今天的日志与库不动）",
           not pre.exists() and (fh / "logs").exists(), sorted(x.name for x in (fh / "dump").iterdir()))
        (fh / "logs" / ("%s.ndjson" % d30)).write_bytes(b"z" * 2000)
        (fh / "logs" / ("%s.ndjson" % d10)).write_bytes(b"z" * 700)
        (fh / "dump" / ("%s_120000-profile-a" % d30)).mkdir(parents=True)
        (fh / "dump" / ("%s_120000-profile-a" % d30) / "tree.json").write_bytes(b"z" * 1500)
        (fh / "logs" / ("%s.ndjson" % today)).write_bytes(b"z" * 300)
        g0, code0 = http("/fs?auto=0", base=FS_BASE)
        ck("GET /fs?auto=0 ⇒ 只量不扫：过期文件还活着，但 cleanable 已经报出该清多少",
           code0 == 200 and g0["ok"] is True and g0["keep"] == 7
           and g0["items"]["logs"]["cleanable"] == 2700 and g0["items"]["dump"]["cleanable"] == 1500
           and (fh / "logs" / ("%s.ndjson" % d30)).exists(),
           {k: g0["items"][k] for k in ("logs", "dump")})
        ck("GET /fs 的库那档：sink 那边库可用 ⇒ free 给得出真数（不是 None），dir 就是 --dir 那个目录",
           isinstance(g0["items"]["db"]["free"], int) and Path(g0["dir"]) == fh, g0["items"]["db"])
        ck("保留天数改成 30 天 ⇒ 10 天前那份立刻退出可清名单（7 天时它算垃圾，30 天时它不算）",
           http("/fs", {"op": "conf", "keep": 30}, base=FS_BASE)[0]["keep"] == 30
           and http("/fs?auto=0", base=FS_BASE)[0]["items"]["logs"]["cleanable"] == 2000
           and (fh / "logs" / ("%s.ndjson" % d10)).exists(),
           http("/fs?auto=0", base=FS_BASE)[0]["items"]["logs"])
        ck("再改回 7 天 ⇒ 名单回来了（策略是本机一份 clean.json，不是某个标签页的记忆）",
           http("/fs", {"op": "conf", "keep": 0}, base=FS_BASE)[0]["keep"] == 7
           and http("/fs?auto=0", base=FS_BASE)[0]["items"]["logs"]["cleanable"] == 2700,
           http("/fs?auto=0", base=FS_BASE)[0]["items"]["logs"])
        c1, _ = http("/fs", {"op": "clean", "target": "logs", "dry": True}, base=FS_BASE)
        ck("POST clean dry=true ⇒ 回显将删清单，文件一个没动",
           c1["files"] == 2 and c1["dry"] is True and (fh / "logs" / ("%s.ndjson" % d30)).exists(), c1["names"])
        c2, _ = http("/fs", {"op": "clean", "target": "logs", "dry": False}, base=FS_BASE)
        ck("同一份计划带 dry=false ⇒ 真删 2 个、省的字节与 DRY 说的一致",
           c2["removed"] == 2 and c2["freed"] == c1["willFree"] == 2700
           and not (fh / "logs" / ("%s.ndjson" % d30)).exists()
           and (fh / "logs" / ("%s.ndjson" % today)).exists(), [c2.get("removed"), c2.get("freed"), c1.get("willFree")])
        cbad, code_bad = http("/fs", {"op": "clean", "target": "db", "dry": False}, base=FS_BASE)
        ck("POST clean target=db ⇒ 400 且库里一条记录没少（库不在删除范围，这条红线两端都钉）",
           code_bad == 400 and cbad["ok"] is False and (fh / "xprobe.db").exists()
           and http("/ping", base=FS_BASE)[0]["db"]["available"] is True, [code_bad, cbad])
        # VACUUM：先灌一批真记录，压实前后行数必须一样（这枚钮说「一行数据都不删」，那就得量出来）
        http("/log", batch(RECS), base=FS_BASE)
        n_before = http("/ping", base=FS_BASE)[0]["db"]["records"]
        v1, _ = http("/fs", {"op": "vacuum", "dry": True}, base=FS_BASE)
        v2, _ = http("/fs", {"op": "vacuum", "dry": False}, base=FS_BASE)
        n_after = http("/ping", base=FS_BASE)[0]["db"]["records"]
        ck("POST vacuum dry=true ⇒ 只量空闲页、不执行 VACUUM；dry=false ⇒ 真跑、rowsKept、前后行数与 /ping 一致",
           v1["ok"] is True and v1.get("dry") is True and "note" in v1 and v2["ok"] is True
           and v2["rowsKept"] is True and v2["rowsBefore"] == v2["rowsAfter"] == n_before == n_after,
           {"dry": v1, "real": {k: v2.get(k) for k in ("freed", "rowsBefore", "rowsAfter")},
            "ping": [n_before, n_after]})
        aged_dir = fh / "dump" / ("%s_150000-profile-c" % d30)
        aged_dir.mkdir()
        (aged_dir / "tree.json").write_bytes(b"z" * 300)
        au, _ = http("/fs", {"op": "auto"}, base=FS_BASE)
        ck("POST op=auto ⇒ 启动那一枪已经把今天用掉 ⇒ 只跳过、那份过期目录还活着（闸门写在 clean.json，不是内存）",
           au["ok"] is True and au.get("skipped") == "今天已清过" and aged_dir.exists(), au)
        xfs.save_conf(fh, dict(xfs.load_conf(fh), lastAuto=""))   # 把闸门拨回「今天还没跑」
        g1, _ = http("/fs", base=FS_BASE)
        ck("拨回闸门后 GET /fs（不带 auto=0）⇒ 自动清理真跑：过期目录没了、lastAuto 记上今天",
           not aged_dir.exists() and g1["lastAuto"] == datetime.now().strftime("%Y-%m-%d"),
           {"gone": not aged_dir.exists(), "lastAuto": g1.get("lastAuto")})
        (fh / "logs" / ("%s.ndjson" % d30)).write_bytes(b"z" * 400)
        g2, _ = http("/fs", base=FS_BASE)
        ck("正向对照：同日第二次 GET 不再扫 ⇒ 自动清理是每天一枪，不是每次读占用都删文件",
           (fh / "logs" / ("%s.ndjson" % d30)).exists() and g2["items"]["logs"]["cleanable"] >= 400,
           g2["items"]["logs"])
        bbad, code_bbad = http("/fs", {"op": "nope", "target": "logs", "dry": False}, base=FS_BASE)
        ck("op 拼错 ⇒ 不继承「实删」：一律降级成 DRY（只有写明白 op=clean 才认 dry=false），文件原样在",
           code_bbad == 200 and bbad["ok"] is True and bbad.get("dry") is True
           and (fh / "logs" / ("%s.ndjson" % d30)).exists(), [code_bbad, bbad])
        # 半截 JSON / 不是 JSON 的 body：最坏结果必须是「只量没删」，不能是「按默认值删」
        req_raw = urllib.request.Request(FS_BASE + "/fs", data=b"{\"op\": \"clean\", \"dry\": false",
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req_raw, timeout=6) as rr:
                code_raw, body_raw = rr.status, json.loads(rr.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            code_raw, body_raw = e.code, json.loads(e.read().decode("utf-8"))
        ck("POST /fs 的 body 是半截 JSON ⇒ 400 且一个文件都没动（解析失败不许落到任何缺省动作上）",
           code_raw == 400 and body_raw.get("ok") is False
           and (fh / "logs" / ("%s.ndjson" % d30)).exists(), [code_raw, body_raw])
        ping_after = http("/ping", base=FS_BASE)[0]
        ck("整条 /fs 腿打完，接收端还活着、库里那 16 条一条没少（清理通道不碰记录，也不弄死进程）",
           ping_after["ok"] is True and ping_after["db"]["records"] == n_after, ping_after["db"]["records"])
    finally:
        p.terminate()
        try:
            p.wait(timeout=8)
        except Exception:
            p.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", default="", help="可选：真机 logs 目录，带上就多跑一遍档案重放")
    a = ap.parse_args()
    sys.path.insert(0, str(HERE))
    import xprobe_db as xdb
    tmp = Path(tempfile.mkdtemp(prefix="xprobe-db-selftest-"))
    print("临时库目录: %s" % tmp)
    # 本进程也开同一份库：[C] 那条腿要在这个文件上做真机重放（WAL + timeout=10，两进程读写互不踩）
    if not xdb.open_db(tmp / "xprobe.db"):
        print("临时库打不开，自检没法跑: %s" % xdb._DB["err"])
        return 2
    try:
        leg_unit(xdb)
        leg_posts(xdb, tmp)
        leg_tl(xdb, tmp)
        leg_win(xdb, tmp)
        leg_sync(xdb, tmp)
        leg_lib(xdb, tmp)
        leg_block(xdb, tmp)
        leg_http(xdb, tmp, a.logs)
        leg_native(tmp)
        leg_fs(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n断言 %d 条：%s" % (CHECKS[0], "全部通过" if not FAILS else "失败 %d 条 -> %s" % (len(FAILS), FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())

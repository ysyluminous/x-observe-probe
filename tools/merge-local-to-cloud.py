#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把本机 xprobe.db 并进云端 PG（2026-11-13 的一次性合并 + 可重跑）。

为什么要有这个工具
------------------
本机库和云端库**读的不是同一份数据**（这是「多了很多表和字段」的实因，已实测）：

  本机「曝光榜」  = tweets 表经 post_points/post_latest 视图 ⇒ 60,272 个帖
  云端 x_observe_post = store_posts 台账推上去的           ⇒ 20,266 个帖
  ⇒ 同一张榜两边排序的不是同一批帖（本机 top50 里只有 22 个在云端）

  本机「账号榜」  = account_latest 视图（store_users ∪ day_latest ∪ 帖作者）⇒ 9,415 人
  云端 x_observe_account = store_users 台账推上去的        ⇒ 253 人

所以这个工具不是「拷贝表」，而是**按本机那套口径重算一遍，再按云端的业务键 upsert**：

  本机源                → 云端表            业务键（唯一约束）
  ─────────────────────────────────────────────────────────────
  post_latest 视图      → x_observe_post    x_post_id
  account_latest 视图   → x_observe_account handle
  day_latest 视图       → x_observe_day_row (user_id, device_id, handle, day)
  follow_events 表      → x_observe_follow_event (user_id, day, dir, target)
  follow_starts 查询    → x_observe_follow_start (user_id, target)

三处口径修正（都是本机这边更准，云端原来那套对不上）：

  ① eng：本机 = 赞+转+评+引+书签（5 项），云端原来 = 赞+评+转（3 项），差 1.69%。
     本工具按本机 5 项算，并把它拆成 repost_count/quote_count/bookmark_count 存下来。
  ② 关注动作的时间戳：本机 at 是 ISO 字符串，云端 client_at 是 epoch 毫秒，
     同一动作两边差 1~39 毫秒 ⇒ 直接按 client_at upsert 会给同一动作落两行。
     本工具按 (dir, target, day) 归并，取最早那个 at 当 client_at。
  ③ 账号榜口径：本机是「union(store_users, day_latest, 帖作者)」。
     本工具照抄这个 union 口径，所以并完之后两档取的是同一批人。

用法
----
    python merge-local-to-cloud.py --dry-run          # 只算不写，出一份核对报告
    python merge-local-to-cloud.py --apply            # 真写云端
    python merge-local-to-cloud.py --apply --user-id U --device-id D

默认从 zhishu/deploy/.env 取连接串；也可以用 --dsn 直接给。
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
from collections import defaultdict

try:
    import psycopg
except ImportError:  # pragma: no cover
    sys.stderr.write("需要 psycopg3：py -3 -m pip install psycopg\n")
    raise

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = r"D:\code\yunxiao\temp\xprobe\xprobe.db"
DEFAULT_ENV = r"D:\code\yunxiao\zhishu\deploy\.env"

# 云端上「这台机器」对应哪个账号 / 设备：与本机扩展写进去的是同一对。
# user_id 走线上 token 里的那个真实账号；device_id 是本机这台机器的扩展 id。
DEFAULT_USER_ID = "1858097717771890690"
DEFAULT_DEVICE_ID = "4c7aefe8-febd-4f72-9fac-81d915db775b"


# ---------------------------------------------------------------- 本机读

def iso_ms(s):
    """ISO 字符串 → epoch 毫秒（云端 client_at 的形状）。解析不了就返回 None。"""
    if not s:
        return None
    t = str(s).strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.datetime.fromisoformat(t)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp() * 1000)


def ms_iso(ms):
    return datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def load_local(db_path):
    import sqlite3
    if not os.path.exists(db_path):
        sys.stderr.write("找不到本机库：%s\n" % db_path)
        sys.exit(2)
    conn = sqlite3.connect("file:%s?mode=ro" % db_path.replace("\\", "/"), uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_posts(conn):
    """本机曝光榜口径：post_latest（每个 tweet_id 取最新一点）+ 该帖的采样点数与首见曝光。

    post_latest 的定义：post_points 里按 (at DESC, tid DESC) 取 rn=1。
    这里照抄它，但用**集合式**写法（1.2s 而不是 7.6s），结果逐行相同。
    """
    sql = """
    WITH pts AS (
      SELECT t.id AS tid, t.tweet_id, t.at, t.author, t.text, t.time_datetime,
             t.follow_state, COALESCE(t.liked, 0) AS liked,
             json_extract(t.metrics, '$.view.num.value')  AS view,
             json_extract(t.metrics, '$.like.num.value')  AS like,
             json_extract(t.metrics, '$.repost.num.value') AS repost,
             json_extract(t.metrics, '$.reply.num.value') AS reply,
             json_extract(t.metrics, '$.quote.num.value')  AS quote,
             json_extract(t.metrics, '$.bookmark.num.value') AS bookmark
        FROM tweets t
       WHERE t.tweet_id IS NOT NULL AND t.tweet_id <> '' AND COALESCE(t.ad_suspect, 0) = 0
    ),
    ranked AS (
      SELECT p.*,
             ROW_NUMBER() OVER (PARTITION BY p.tweet_id ORDER BY p.at DESC, p.tid DESC) AS rn,
             COUNT(*)     OVER (PARTITION BY p.tweet_id) AS points,
             FIRST_VALUE(p.view) OVER (PARTITION BY p.tweet_id ORDER BY p.at ASC, p.tid ASC) AS first_view
        FROM pts p
    )
    SELECT tweet_id, at, author, text, time_datetime, follow_state, liked,
           view, like, repost, reply, quote, bookmark, points, first_view
      FROM ranked WHERE rn = 1
    """
    return [dict(r) for r in conn.execute(sql)]


def fetch_accounts(conn):
    """本机账号榜口径：account_latest（store_users ∪ day_latest ∪ 帖作者的 union）。

    照抄 account_latest 的定义，但把相关子查询换成集合式聚合（1.8s 而不是 67s）。
    逐条对着 account_latest 的定义核过：
      · d        = day_latest 里该 handle 的**最大 day** 那行（不是全部天）
      · u        = store_users 里该 handle 的 MAX(id) 那行
      · relation 的回退源是**全部** post_points 里 follow_state 非空的最后一点（不是只看最新一点）
      · relation_at 是**全部** post_points 里 follow_state 非空的 MAX(at)
      · posts_n / views / eng / last_post_at 都只在 post_latest（每帖最新一点）上算
    """
    sql = """
    WITH pts AS (
      SELECT t.id AS tid, t.tweet_id, t.at, t.author, t.text, t.time_datetime,
             t.follow_state, COALESCE(t.liked, 0) AS liked,
             json_extract(t.metrics, '$.view.num.value')  AS view,
             json_extract(t.metrics, '$.like.num.value')  AS like,
             json_extract(t.metrics, '$.repost.num.value') AS repost,
             json_extract(t.metrics, '$.reply.num.value') AS reply,
             json_extract(t.metrics, '$.quote.num.value')  AS quote,
             json_extract(t.metrics, '$.bookmark.num.value') AS bookmark
        FROM tweets t
       WHERE t.tweet_id IS NOT NULL AND t.tweet_id <> '' AND COALESCE(t.ad_suspect, 0) = 0
    ),
    latest_post AS (
      SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.tweet_id ORDER BY p.at DESC, p.tid DESC) AS rn
        FROM pts p
    ),
    agg AS (
      SELECT author,
             COUNT(*) AS posts_n,
             SUM(COALESCE(view, 0)) AS views,
             SUM(COALESCE(like, 0) + COALESCE(repost, 0) + COALESCE(reply, 0)
                 + COALESCE(quote, 0) + COALESCE(bookmark, 0)) AS eng,
             MAX(at) AS last_post_at
        FROM latest_post WHERE rn = 1 GROUP BY author
    ),
    rel AS (
      SELECT author,
             (SELECT p2.follow_state FROM pts p2 WHERE p2.author = pts.author
                AND p2.follow_state <> '' ORDER BY p2.at DESC, p2.tid DESC LIMIT 1) AS rel_state,
             MAX(CASE WHEN follow_state <> '' THEN at END) AS rel_at
        FROM pts WHERE author <> '' GROUP BY author
    ),
    day_all AS (
      SELECT h.handle, h.day,
        (SELECT x.exposure FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day
           AND x.exposure IS NOT NULL ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS exposure,
        (SELECT x.effective FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day
           AND x.effective IS NOT NULL ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS effective,
        (SELECT x.exact FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day
           AND x.exposure IS NOT NULL ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS exact,
        (SELECT x.token FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day
           AND x.exposure IS NOT NULL ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS token,
        (SELECT x.following FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day
           AND x.following IS NOT NULL ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS following,
        (SELECT x.followers FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day
           AND x.followers IS NOT NULL ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS followers,
        (SELECT x.posts FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day
           AND x.posts IS NOT NULL ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS posts,
        (SELECT MAX(x.at) FROM day_rows x WHERE x.handle = h.handle AND x.day = h.day) AS at
        FROM (SELECT DISTINCT handle, day FROM day_rows) h
    ),
    d AS (
      SELECT a.* FROM day_all a
        JOIN (SELECT handle, MAX(day) AS md FROM day_all GROUP BY handle) m
          ON m.handle = a.handle AND m.md = a.day
    ),
    u AS (
      SELECT handle, name, relation, own, at AS seen_at, followers, following
        FROM (SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.handle ORDER BY s.id DESC) AS rn
                FROM store_users s WHERE s.handle <> '')
       WHERE rn = 1
    ),
    b AS (
      SELECT handle, state, at FROM (
        SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.handle ORDER BY s.id DESC) AS rn
          FROM blocks s) WHERE rn = 1 AND state = 1
    ),
    hs AS (
      SELECT handle FROM u
      UNION SELECT handle FROM d WHERE handle <> ''
      UNION SELECT author FROM latest_post WHERE rn = 1 AND author <> ''
    )
    SELECT h.handle,
           COALESCE(u.name, '')   AS name,
           COALESCE(u.own, 0)    AS own,
           COALESCE(NULLIF(u.relation, ''), CASE WHEN COALESCE(u.own, 0) = 1 THEN 'self' END,
             rel.rel_state, '')  AS relation,
           rel.rel_at             AS relation_at,
           d.day, d.exposure, d.effective, d.exact, d.token, d.posts, d.at AS day_at,
           u.seen_at,
           COALESCE(u.followers, d.followers) AS fans,
           COALESCE(u.following, d.following) AS fow,
           COALESCE(a.posts_n, 0)  AS posts_n,
           a.eng   AS eng,          -- 没帖的号：SUM 空集 = NULL（不是 0），照抄本机
           a.views AS views,        -- 同上
           a.last_post_at,
           COALESCE(b.state, 0) AS blocked, b.at AS blocked_at
      FROM hs h
      LEFT JOIN u   ON u.handle = h.handle
      LEFT JOIN d   ON d.handle = h.handle
      LEFT JOIN agg a ON a.author = h.handle
      LEFT JOIN rel  ON rel.author = h.handle
      LEFT JOIN b   ON b.handle = h.handle
    """
    return [dict(r) for r in conn.execute(sql)]


def fetch_days(conn):
    """本机日点口径：day_latest（每天每个 handle 一行，值取当天最新一条非空）。"""
    sql = """
    SELECT handle, day, exposure, effective, exact, token, following, followers, posts, at, manual_n
      FROM day_latest
    """
    return [dict(r) for r in conn.execute(sql)]


def fetch_follow_events(conn):
    """本机关注流水：follow_events 表（at 是 ISO）。

    两个坑，都在这儿处理掉：

    1) **day 字段不可信**：本机 day_rows/follow_events 的 day 是按**本机本地时区**记的，
       而 at 是 UTC。跨零点的动作两边会差一天（实测：evan__official 的 at 落在 11-03，
       本机 day 写 11-03，云端按 UTC 推成 11-04 ⇒ 同一条动作认不出是同一条，落了两行）。
       ⇒ 这里**不信本机 day**，一律从 at 的 UTC 推算，与云端口径一致。

    2) **同一动作本机/云端时间戳差 1~39ms**（两次独立采样同一刻），
       直接按 (dir,target,ms) 对不上 ⇒ 按 (dir,target,推算日) 归并，
       每个组合只保留**最早**那个动作，转成 epoch 毫秒后与云端已有那份落在同一业务键上。
    """
    rows = conn.execute(
        "SELECT at, day, dir, handle, why, suspect, w15, w24 FROM follow_events"
    ).fetchall()
    best = {}
    for r in rows:
        at, dir_, tgt = r["at"], (r["dir"] or ""), (r["handle"] or "").lower()
        if not dir_ or not tgt:
            continue
        ms = iso_ms(at)
        if ms is None:
            continue
        # day 一律从 at 推（UTC），不信本机那列
        day = ms_iso(ms)[:10]
        key = (dir_, tgt, day)
        cur = best.get(key)
        cand = {
            "ms": ms, "day": day, "dir": dir_, "target": tgt,
            "why": r["why"], "suspect": r["suspect"], "w15": r["w15"], "w24": r["w24"],
        }
        if cur is None or cand["ms"] < cur["ms"]:
            best[key] = cand
    return list(best.values())


def fetch_follow_starts(conn):
    """本机「关注时间 / 未回关」结论：follow_starts 那条查询（一人一行）。

    直接取 xprobe_db.py 里的原 SQL（不自己拼），保证口径一个字不差（RL-22 唯一写者）。
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "xprobe_db_probe", os.path.join(HERE, "..", "xprobe_db.py"))
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:  # pragma: no cover
        sys.stderr.write("xprobe_db.py 导入失败（%s）：follow_starts 口径只能靠它\n" % e)
        raise
    stmt = mod.QUERIES["follow_starts"]
    return [dict(r) for r in conn.execute(stmt, (5000,))]


# ---------------------------------------------------------------- 云端写

def read_dsn(env_path):
    """从 zhishu/deploy/.env 取线上 PG 连接串。

    那份 .env 没有 DATABASE_URL，是这几个键拼出来的：
        PG_PASSWORD / COORD_PG_PASSWORD  密码
        COORD_PORT                        端口（15432）
        主机与库名固定：82.157.203.250 / zhishu
    也认 DATABASE_URL（如果以后 .env 改成那个形状）。
    """
    if not os.path.exists(env_path):
        sys.stderr.write("找不到 %s（可用 --dsn 直接给连接串）\n" % env_path)
        sys.exit(2)
    with open(env_path, encoding="utf-8") as f:
        txt = f.read()

    m = re.search(r"^DATABASE_URL\s*=\s*(.+)$", txt, re.M)
    if m:
        return m.group(1).strip().strip('"').strip("'")

    env = {}
    for k, v in re.findall(r"^([A-Z_]+)\s*=\s*(.*)$", txt, re.M):
        env[k] = v.strip().strip('"').strip("'")
    # 那份 .env 里 COORD_PG_PASSWORD 是**另一个库**的密码（实测用它连 zhishu 会认证失败），
    # 这套库的密码是 PG_PASSWORD ⇒ 顺序不能反。
    pw = env.get("PG_PASSWORD") or env.get("COORD_PG_PASSWORD")
    if not pw:
        sys.stderr.write("%s 里没有 COORD_PG_PASSWORD / PG_PASSWORD\n" % env_path)
        sys.exit(2)
    port = env.get("COORD_PORT") or "15432"
    # 密码里可能有 @ / : / # 等字符 ⇒ 必须做 URL 编码，否则连接串会被截断（报的是「认证失败」，
    # 看着像密码错，其实是密码被切掉了后半截）。
    from urllib.parse import quote
    return "postgres://postgres:%s@82.157.203.250:%s/zhishu?sslmode=disable" % (quote(pw, safe=""), port)


def connect(dsn):
    return psycopg.connect(dsn, connect_timeout=20, autocommit=False)


def cloud_keys(cur, sql, args=()):
    cur.execute(sql, args)
    return set(r[0] for r in cur.fetchall())


def main():
    ap = argparse.ArgumentParser(description="把本机 xprobe.db 并进云端 PG")
    ap.add_argument("--db", default=DEFAULT_DB, help="本机 xprobe.db 路径")
    ap.add_argument("--env", default=DEFAULT_ENV, help="zhishu/deploy/.env（取 DATABASE_URL）")
    ap.add_argument("--dsn", default=None, help="直接给连接串（优先于 --env）")
    ap.add_argument("--user-id", default=DEFAULT_USER_ID, help="云端 user_id")
    ap.add_argument("--device-id", default=DEFAULT_DEVICE_ID, help="云端 device_id")
    ap.add_argument("--apply", action="store_true", help="真写云端（默认只出报告）")
    ap.add_argument("--dry-run", action="store_true", help="只出报告（默认行为，写这一句是为了说清楚）")
    ap.add_argument("--only", default=None, help="只并某几张表（逗号分隔：posts,accounts,days,follows,starts）")
    args = ap.parse_args()

    only = None
    if args.only:
        only = set(x.strip() for x in args.only.split(",") if x.strip())

    def want(name):
        return only is None or name in only

    t0 = time.time()
    conn = load_local(args.db)
    print("本机库：%s" % args.db)

    print("读本机口径……")
    data = {}
    if want("posts"):
        data["posts"] = fetch_posts(conn)
        print("  帖（post_latest 口径）      : %d" % len(data["posts"]))
    if want("accounts"):
        data["accounts"] = fetch_accounts(conn)
        print("  账号（account_latest 口径）: %d" % len(data["accounts"]))
    if want("days"):
        data["days"] = fetch_days(conn)
        print("  日点（day_latest 口径）    : %d" % len(data["days"]))
    if want("follows"):
        data["follows"] = fetch_follow_events(conn)
        print("  关注动作（归并后）          : %d" % len(data["follows"]))
    if want("starts"):
        data["starts"] = fetch_follow_starts(conn)
        print("  关注结论（follow_starts）   : %d" % len(data["starts"]))
    conn.close()
    print("  （读本机 %.1fs）" % (time.time() - t0))

    dsn = args.dsn or read_dsn(args.env)
    cn = connect(dsn)
    cur = cn.cursor()
    print("云端：%s" % re.sub(r"//[^@]*@", "//***@", dsn))
    print("  user_id=%s device_id=%s" % (args.user_id, args.device_id))

    report = {}

    # 核对时要用的本机键集合（先收好，写完再逐表核）
    local_post_keys = set(r["tweet_id"] for r in data.get("posts", []) if r["tweet_id"])
    local_acct_keys = set((r["handle"] or "").lower() for r in data.get("accounts", []) if r["handle"])
    local_day_keys = set("%s|%s" % ((r["handle"] or "").lower(), r["day"])
                         for r in data.get("days", []) if r["handle"])
    local_start_keys = set((r["handle"] or "").lower() for r in data.get("starts", []) if r["handle"])

    try:
        # ---------------------------------------------------------- 帖
        if "posts" in data:
            rows = data["posts"]
            have = cloud_keys(cur, "SELECT x_post_id FROM x_observe_post")
            local_keys = set(r["tweet_id"] for r in rows)
            missing = len(local_keys - have)
            print()
            print("帖：并 %d 条；云端已有 %d；本机有云端没有的 %d" % (len(rows), len(have), missing))
            if args.apply:
                # 按 x_post_id upsert。eng 用本机 5 项口径。
                # first_seen/last_seen = 本机这条帖的最早/最晚采样时刻。
                # metrics_at = 最新一点的 at（= 本机 post_latest 的 at）。
                # posted_at = 本机采到的发帖时刻（time_datetime），采不到就留空让云端按推文 id 反推。
                st = """
                INSERT INTO x_observe_post
                  (x_post_id, author_handle, text_snapshot, url, posted_at,
                   view_count, reply, like_count, eng, repost_count, quote_count, bookmark_count,
                   liked, first_view, points, follow_state,
                   metrics_at, source, first_seen, last_seen, update_time)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (x_post_id) DO UPDATE SET
                  author_handle  = COALESCE(EXCLUDED.author_handle, x_observe_post.author_handle),
                  text_snapshot  = COALESCE(EXCLUDED.text_snapshot, x_observe_post.text_snapshot),
                  url            = COALESCE(EXCLUDED.url, x_observe_post.url),
                  posted_at      = COALESCE(EXCLUDED.posted_at, x_observe_post.posted_at),
                  -- 曝光只增不减：两路观测取较大值（RL-11：取大的那条是事实，不是编的）
                  view_count     = GREATEST(COALESCE(EXCLUDED.view_count, 0), COALESCE(x_observe_post.view_count, 0)),
                  reply          = GREATEST(COALESCE(EXCLUDED.reply, 0), COALESCE(x_observe_post.reply, 0)),
                  like_count     = GREATEST(COALESCE(EXCLUDED.like_count, 0), COALESCE(x_observe_post.like_count, 0)),
                  repost_count   = GREATEST(COALESCE(EXCLUDED.repost_count, 0), COALESCE(x_observe_post.repost_count, 0)),
                  quote_count    = GREATEST(COALESCE(EXCLUDED.quote_count, 0), COALESCE(x_observe_post.quote_count, 0)),
                  bookmark_count = GREATEST(COALESCE(EXCLUDED.bookmark_count, 0), COALESCE(x_observe_post.bookmark_count, 0)),
                  -- 互动合计按「较新那次观测」为准：观测越晚，互动数越接近当下
                  eng            = CASE WHEN x_observe_post.metrics_at IS NULL
                                          OR EXCLUDED.metrics_at >= x_observe_post.metrics_at
                                    THEN EXCLUDED.eng
                                    ELSE x_observe_post.eng END,
                  liked          = CASE WHEN x_observe_post.metrics_at IS NULL
                                          OR EXCLUDED.metrics_at >= x_observe_post.metrics_at
                                    THEN EXCLUDED.liked ELSE x_observe_post.liked END,
                  first_view     = CASE WHEN x_observe_post.metrics_at IS NULL
                                          OR EXCLUDED.metrics_at >= x_observe_post.metrics_at
                                    THEN EXCLUDED.first_view ELSE x_observe_post.first_view END,
                  points         = CASE WHEN x_observe_post.metrics_at IS NULL
                                          OR EXCLUDED.metrics_at >= x_observe_post.metrics_at
                                    THEN EXCLUDED.points ELSE x_observe_post.points END,
                  follow_state   = COALESCE(EXCLUDED.follow_state, x_observe_post.follow_state),
                  metrics_at     = GREATEST(x_observe_post.metrics_at, EXCLUDED.metrics_at),
                  last_seen      = GREATEST(x_observe_post.last_seen, EXCLUDED.last_seen),
                  update_time    = EXCLUDED.update_time
                """
                # 批量写：逐条 execute 会把 6 万行变成 6 万次跨网往返（实测 40 分钟打不完）。
                # psycopg3 的 executemany 走 pipeline，一批一次往返。
                n = 0
                batch = []
                t_w = time.time()
                for r in rows:
                    author = (r["author"] or "").lower()
                    tid = r["tweet_id"]
                    text = (r["text"] or "")[:400]
                    url = "https://x.com/%s/status/%s" % (author, tid) if author else None
                    posted = r["time_datetime"] or None
                    eng = (r["like"] or 0) + (r["repost"] or 0) + (r["reply"] or 0) + \
                          (r["quote"] or 0) + (r["bookmark"] or 0)
                    if eng == 0 and not any(r[k] is not None for k in
                                            ("like", "repost", "reply", "quote", "bookmark")):
                        eng = None
                    batch.append((
                        tid, author or None, text or None, url, posted,
                        r["view"], r["reply"], r["like"], eng,
                        r["repost"], r["quote"], r["bookmark"],
                        r["liked"], r["first_view"], r["points"], r["follow_state"] or None,
                        r["at"], "probe", r["at"], r["at"],
                        time.strftime("%Y-%m-%d %H:%M:%S"),
                    ))
                    if len(batch) >= 2000:
                        cur.executemany(st, batch)
                        cn.commit()
                        n += len(batch)
                        batch = []
                        print("    …已写 %d/%d（%.0fs）" % (n, len(rows), time.time() - t_w))
                if batch:
                    cur.executemany(st, batch)
                    cn.commit()
                    n += len(batch)
                cn.commit()
                print("  → 已写 %d 条（%.1fs）" % (n, time.time() - t_w))
                after = cloud_keys(cur, "SELECT x_post_id FROM x_observe_post")
                report["posts"] = {"written": n, "cloud_total": len(after),
                                   "local_missing_after": len(local_keys - after)}
                print("  → 云端现有 %d；本机仍缺的 %d" % (len(after), len(local_keys - after)))

        # ---------------------------------------------------------- 账号
        if "accounts" in data:
            rows = data["accounts"]
            have = cloud_keys(cur, "SELECT handle FROM x_observe_account")
            local_keys = set((r["handle"] or "").lower() for r in rows)
            print()
            print("账号：并 %d 人；云端已有 %d；本机有云端没有的 %d"
                  % (len(rows), len(have), len(local_keys - have)))
            if args.apply:
                st = """
                INSERT INTO x_observe_account
                  (handle, display_name, fans, fow, posts_n, views, eng, posts,
                   relation, relation_at, own, blocked,
                   last_post_at, metrics_at, source, first_seen, last_seen, update_time)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (handle) DO UPDATE SET
                  display_name = COALESCE(NULLIF(EXCLUDED.display_name,''), x_observe_account.display_name),
                  -- 粉丝/关注数是「观测快照」：较新那次观测胜
                  fans         = CASE WHEN x_observe_account.metrics_at IS NULL
                                         OR EXCLUDED.metrics_at >= x_observe_account.metrics_at
                                   THEN COALESCE(EXCLUDED.fans, x_observe_account.fans)
                                   ELSE x_observe_account.fans END,
                  fow          = CASE WHEN x_observe_account.metrics_at IS NULL
                                         OR EXCLUDED.metrics_at >= x_observe_account.metrics_at
                                   THEN COALESCE(EXCLUDED.fow, x_observe_account.fow)
                                   ELSE x_observe_account.fow END,
                  -- 帖子聚合（帖数/曝光/互动）：本机口径与本机榜一致，直接写存档列
                  posts_n      = EXCLUDED.posts_n,
                  views        = EXCLUDED.views,
                  eng          = EXCLUDED.eng,
                  posts        = COALESCE(EXCLUDED.posts, x_observe_account.posts),
                  relation     = COALESCE(NULLIF(EXCLUDED.relation,''), x_observe_account.relation),
                  relation_at  = CASE WHEN x_observe_account.metrics_at IS NULL
                                         OR EXCLUDED.metrics_at >= x_observe_account.metrics_at
                                   THEN COALESCE(EXCLUDED.relation_at, x_observe_account.relation_at)
                                   ELSE x_observe_account.relation_at END,
                  own          = EXCLUDED.own,
                  blocked      = EXCLUDED.blocked,
                  last_post_at = GREATEST(x_observe_account.last_post_at, EXCLUDED.last_post_at),
                  metrics_at   = GREATEST(x_observe_account.metrics_at, EXCLUDED.metrics_at),
                  last_seen    = GREATEST(x_observe_account.last_seen, EXCLUDED.last_seen),
                  update_time  = EXCLUDED.update_time
                """
                n = 0
                batch = []
                for r in rows:
                    h = (r["handle"] or "").lower()
                    if not h:
                        continue
                    batch.append((
                        h, r["name"] or "", r["fans"], r["fow"], r["posts_n"], r["views"], r["eng"],
                        r["posts"], r["relation"] or None, r["relation_at"], r["own"], r["blocked"],
                        r["last_post_at"], r["seen_at"], "probe", r["seen_at"], r["seen_at"],
                        time.strftime("%Y-%m-%d %H:%M:%S"),
                    ))
                    if len(batch) >= 2000:
                        cur.executemany(st, batch)
                        cn.commit()
                        n += len(batch)
                        batch = []
                if batch:
                    cur.executemany(st, batch)
                    n += len(batch)
                cn.commit()
                print("  → 已写 %d 人" % n)
                after = cloud_keys(cur, "SELECT handle FROM x_observe_account")
                report["accounts"] = {"written": n, "cloud_total": len(after),
                                      "local_missing_after": len(local_keys - after)}
                print("  → 云端现有 %d；本机仍缺的 %d" % (len(after), len(local_keys - after)))

        # ---------------------------------------------------------- 日点
        if "days" in data:
            rows = data["days"]
            cur.execute("SELECT handle, day FROM x_observe_day_row WHERE user_id=%s AND device_id=%s",
                        (args.user_id, args.device_id))
            have = set((r[0].lower(), r[1]) for r in cur.fetchall())
            local_keys = set(((r["handle"] or "").lower(), r["day"]) for r in rows)
            print()
            print("日点：并 %d 行；本机这台机器已有 %d；本机有云端没有的 %d"
                  % (len(rows), len(have), len(local_keys - have)))
            if args.apply:
                st = """
                INSERT INTO x_observe_day_row
                  (user_id, device_id, handle, day, exposure, effective, exact, token,
                   following, followers, posts, manual, source, client_at, update_time)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (user_id, device_id, handle, day) DO UPDATE SET
                  -- 日点是「当天累计读数」：同一天里后采的那次更接近当日真相 ⇒ 较新者胜
                  exposure  = CASE WHEN x_observe_day_row.client_at IS NULL
                                         OR EXCLUDED.client_at >= x_observe_day_row.client_at
                                   THEN EXCLUDED.exposure ELSE x_observe_day_row.exposure END,
                  effective = CASE WHEN x_observe_day_row.client_at IS NULL
                                         OR EXCLUDED.client_at >= x_observe_day_row.client_at
                                   THEN EXCLUDED.effective ELSE x_observe_day_row.effective END,
                  exact    = CASE WHEN x_observe_day_row.client_at IS NULL
                                         OR EXCLUDED.client_at >= x_observe_day_row.client_at
                                   THEN EXCLUDED.exact ELSE x_observe_day_row.exact END,
                  token    = CASE WHEN x_observe_day_row.client_at IS NULL
                                         OR EXCLUDED.client_at >= x_observe_day_row.client_at
                                   THEN EXCLUDED.token ELSE x_observe_day_row.token END,
                  following  = CASE WHEN x_observe_day_row.client_at IS NULL
                                         OR EXCLUDED.client_at >= x_observe_day_row.client_at
                                   THEN EXCLUDED.following ELSE x_observe_day_row.following END,
                  followers  = CASE WHEN x_observe_day_row.client_at IS NULL
                                         OR EXCLUDED.client_at >= x_observe_day_row.client_at
                                   THEN EXCLUDED.followers ELSE x_observe_day_row.followers END,
                  posts      = CASE WHEN x_observe_day_row.client_at IS NULL
                                         OR EXCLUDED.client_at >= x_observe_day_row.client_at
                                   THEN EXCLUDED.posts ELSE x_observe_day_row.posts END,
                  manual     = EXCLUDED.manual,
                  source     = COALESCE(EXCLUDED.source, x_observe_day_row.source),
                  client_at  = GREATEST(x_observe_day_row.client_at, EXCLUDED.client_at),
                  update_time = EXCLUDED.update_time
                """
                n = 0
                for r in rows:
                    h = (r["handle"] or "").lower()
                    if not h or not r["day"]:
                        continue
                    cur.execute(st, (
                        args.user_id, args.device_id, h, r["day"],
                        r["exposure"], r["effective"], r["exact"], r["token"],
                        r["following"], r["followers"], r["posts"],
                        1 if r["manual_n"] else 0, r["at"], r["at"],
                        time.strftime("%Y-%m-%d %H:%M:%S"),
                    ))
                    n += 1
                cn.commit()
                print("  → 已写 %d 行" % n)
                cur.execute("SELECT count(*) FROM x_observe_day_row WHERE user_id=%s AND device_id=%s",
                            (args.user_id, args.device_id))
                print("  → 云端这台机器现有 %d 行" % cur.fetchone()[0])

        # ---------------------------------------------------------- 关注动作
        if "follows" in data:
            rows = data["follows"]
            cur.execute("SELECT dir, lower(target), day FROM x_observe_follow_event WHERE user_id=%s",
                        (args.user_id,))
            have = set((r[0], r[1], r[2]) for r in cur.fetchall())
            local_keys = set((r["dir"], r["target"], r["day"]) for r in rows)
            print()
            print("关注动作：并 %d 条；云端这个账号已有 %d；本机有云端没有的 %d"
                  % (len(rows), len(have), len(local_keys - have)))
            if args.apply:
                st = """
                INSERT INTO x_observe_follow_event
                  (user_id, device_id, client_at, day, dir, target, why, w15, w24, suspect, create_time)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (user_id, client_at, dir, target) DO NOTHING
                """
                n = 0
                batch = []
                for r in rows:
                    batch.append((
                        args.user_id, args.device_id, str(r["ms"]), r["day"], r["dir"], r["target"],
                        r["why"], r["w15"], r["w24"], r["suspect"],
                        time.strftime("%Y-%m-%d %H:%M:%S"),
                    ))
                if batch:
                    cur.executemany(st, batch)
                    n = len(batch)
                cn.commit()
                cn.commit()
                print("  → 已写 %d 条" % n)
                cur.execute("SELECT count(*) FROM x_observe_follow_event WHERE user_id=%s", (args.user_id,))
                print("  → 云端这个账号现有 %d 条" % cur.fetchone()[0])

        # ---------------------------------------------------------- 关注结论
        if "starts" in data:
            rows = data["starts"]
            cur.execute("SELECT target FROM x_observe_follow_start WHERE user_id=%s", (args.user_id,))
            have = set(r[0] for r in cur.fetchall())
            local_keys = set((r["handle"] or "").lower() for r in rows)
            print()
            print("关注结论：并 %d 人；云端这个账号已有 %d；本机有云端没有的 %d"
                  % (len(rows), len(have), len(local_keys - have)))
            if args.apply:
                st = """
                INSERT INTO x_observe_follow_start
                  (user_id, device_id, target, client_at, day, at_source, follow_back, suspect, create_time)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (user_id, target) DO UPDATE SET
                  client_at   = COALESCE(x_observe_follow_start.client_at, EXCLUDED.client_at),
                  day        = EXCLUDED.day,
                  at_source  = EXCLUDED.at_source,
                  follow_back = EXCLUDED.follow_back,
                  suspect    = EXCLUDED.suspect,
                  create_time = EXCLUDED.create_time
                """
                n = 0
                batch = []
                for r in rows:
                    h = (r["handle"] or "").lower()
                    at = r["follow_at"] or ""
                    if not h or not at:
                        continue
                    batch.append((
                        args.user_id, args.device_id, h, at, at[:10],
                        r["at_source"] or "", r["follow_back"] or "unknown",
                        r["suspect"] or 0, time.strftime("%Y-%m-%d %H:%M:%S"),
                    ))
                if batch:
                    cur.executemany(st, batch)
                    n = len(batch)
                cn.commit()
                cn.commit()
                print("  → 已写 %d 人" % n)
                cur.execute("SELECT count(*) FROM x_observe_follow_start WHERE user_id=%s", (args.user_id,))
                print("  → 云端这个账号现有 %d 人" % cur.fetchone()[0])

    finally:
        cn.rollback()
        cn.close()

    print()
    print("核对报告：%s" % json.dumps(report, ensure_ascii=False, indent=2))
    if not args.apply:
        print("\n（这是 --dry-run：什么都没写。确认无误后加 --apply 重跑同一命令。）")
        return

    # ------------------------------------------------------------ 写后核对
    # 合并完必须逐表核一遍：本机该有的，云端有没有；关键指标一不一样。
    # 不核对就当没合（RL-11：没核过的数不算数）。
    print()
    print("=" * 60)
    print("写后核对")
    print("=" * 60)
    cn2 = connect(dsn)
    cur2 = cn2.cursor()
    ok_all = True
    checks = []

    def chk(label, want, got, unit=""):
        nonlocal ok_all
        good = (want == got)
        if not good:
            ok_all = False
        checks.append((label, want, got, unit, good))
        print("  [%s] %-34s 期望 %-8s 实得 %-8s %s"
              % ("✓" if good else "✗", label, want, got, unit))

    if "posts" in data:
        cur2.execute("SELECT count(*) FROM x_observe_post")
        cloud_total = cur2.fetchone()[0]
        cur2.execute("SELECT count(*) FROM x_observe_post WHERE x_post_id = ANY(%s)",
                     (list(local_post_keys),))
        chk("本机的帖云端都有", len(local_post_keys), cur2.fetchone()[0], "条")

        # 曝光榜 top50：本机榜 vs 云端榜（口径一致才该一样）
        cur2.execute("""
            SELECT x_post_id FROM x_observe_post
             WHERE view_count IS NOT NULL
             ORDER BY view_count DESC NULLS LAST, x_post_id ASC LIMIT 50""")
        cloud_top = [r[0] for r in cur2.fetchall()]
        local_top = [r["tweet_id"] for r in
                     sorted([r for r in data["posts"] if r["view"] is not None],
                            key=lambda r: (-r["view"], r["tweet_id"]))[:50]]
        inter = len(set(local_top) & set(cloud_top))
        print("  · 曝光榜 top50：本机 %d 个，云端 %d 个，重合 %d 个" % (len(local_top), len(cloud_top), inter))
        if inter < 45:
            print("  [✗] 曝光榜重合度太低（<45），排行榜口径不一致")
            ok_all = False

    if "accounts" in data:
        cur2.execute("SELECT count(*) FROM x_observe_account WHERE lower(handle) = ANY(%s)",
                     (list(local_acct_keys),))
        chk("本机的账号云端都有", len(local_acct_keys), cur2.fetchone()[0], "人")

    if "days" in data:
        # 日点的唯一键是 (user_id, device_id, handle, day) ⇒ 按这四元组核，不能只按 handle 数
        cur2.execute("""SELECT count(*) FROM x_observe_day_row
                         WHERE user_id=%s AND device_id=%s
                           AND lower(handle)||'|'||day = ANY(%s)""",
                     (args.user_id, args.device_id, list(local_day_keys)))
        chk("本机的日点云端都有", len(local_day_keys), cur2.fetchone()[0], "行")

    if "follows" in data:
        # 逐条核太慢，按 (dir,target,day) 三元组集合核
        cur2.execute("SELECT dir, lower(target), day FROM x_observe_follow_event WHERE user_id=%s",
                     (args.user_id,))
        cl = set((r[0], r[1], r[2]) for r in cur2.fetchall())
        lo = set((r["dir"], r["target"], r["day"]) for r in data["follows"])
        chk("本机的关注动作云端都有", len(lo), len(lo & cl), "条")

    if "starts" in data:
        cur2.execute("SELECT count(*) FROM x_observe_follow_start WHERE user_id=%s AND lower(target) = ANY(%s)",
                     (args.user_id, list(local_start_keys)))
        chk("本机的关注结论云端都有", len(local_start_keys), cur2.fetchone()[0], "人")

    cn2.close()
    print()
    print("核对结论：%s" % ("全部通过 ✓" if ok_all else "有不一致 ✗（见上面 ✗ 行）"))
    if not ok_all:
        sys.exit(3)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""X 观测探针的本机档案库（stdlib sqlite3，零依赖）。

为什么要有这个库：浏览器那边的 chrome.storage.local 配额是 10MB，而 v1 那个键实测
400 份整页快照 13.05MB —— 配额一满，写失败被 host-shim 静默吞掉，关注守卫的台账、
趋势点、users/posts 两张表跟着一起停止持久化，我看到的只是「面板数字不动了」。
库落在本地文件系统上，没有配额这回事，所以 sink-9 起：整页原文进库，浏览器只留运行态。

两条铁律（改这个文件前先读）：
  ① 只收 t=0 的真机记录。自检脚本的记录带 t=1，进库就等于往档案里灌测试数据。
  ② 库写失败绝不打断 ndjson 落盘。日志是现场、库是档案；档案写坏了不能把现场也弄没，
     所以 ingest() 吞掉一切异常，只把错误记进 stats()，由 /ping 与面板说给我听。

幂等：rec 的内容（去掉 receivedAt/peer 这类每次都会变的字段）哈希成 key，
core 那边 sink 断线重发同一批 ⇒ INSERT OR IGNORE 天然去重，重试不铺两点。

用法（通常由 log-sink.py 调，不单独跑）：
  python -X utf8 xprobe_db.py --db ~/xprobe/xprobe.db --tables
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

# db-9（v0.10.7）：QUERIES 多 lib_user_stat / lib_post_stat 两条「同步进度」统计（本地共几个、水位之内已推几个），
# 面板那张「本地 / 已推 / 待推 / 云端」对比表靠它们算；db-8 是 v0.10.6 那两条抓取档案游标查询
# （v0.11.5 曾抬到 db-11 加 own_posts 做 AI 文风样本；用户撤了那半截——样本改由提示词自己管——
#  随 v0.11.6 一并撤掉这条查询，账数回到 db-10。meta 里写过的 db-11 会被下一次 open_db 覆盖回来）
DB_VER = "db-10"
NEW, DUP, SKIP_TEST, UNAVAIL, FAIL = 1, 0, -1, -2, -3   # ingest() 的返回码：「不该入档」与「入不了档」必须分开
_TABLES = ["records", "snapshots", "tweets", "user_rows", "follow_events", "stat_points",
           "reward_points", "day_rows", "store_users", "store_posts", "blocks", "benchmarks",
           "bench_posts", "dumps"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS records(
  key TEXT PRIMARY KEY, at TEXT, rcvd TEXT, day TEXT, kind TEXT, host TEXT,
  peer_host TEXT, tab TEXT, handle TEXT, url TEXT, ver TEXT, build TEXT,
  bytes INTEGER, summary TEXT, raw TEXT);
CREATE INDEX IF NOT EXISTS ix_records_at ON records(at);
CREATE INDEX IF NOT EXISTS ix_records_kind ON records(kind, at);
CREATE INDEX IF NOT EXISTS ix_records_day ON records(day);

CREATE TABLE IF NOT EXISTS snapshots(
  key TEXT PRIMARY KEY, at TEXT, day TEXT, tab TEXT, handle TEXT, url TEXT,
  host TEXT, ver TEXT, build TEXT, title TEXT, hydrated INTEGER, attempt INTEGER,
  articles INTEGER, ads INTEGER, tweets_n INTEGER, users_n INTEGER, users_scope TEXT,
  user_cell_in_doc INTEGER, foreign_nodes INTEGER, name_strip_all INTEGER,
  cov TEXT, cov_users TEXT, miss TEXT, note TEXT, identity TEXT, stats TEXT,
  rewards TEXT, cov_users_row INTEGER, name_how TEXT, bytes INTEGER);
CREATE INDEX IF NOT EXISTS ix_snapshots_at ON snapshots(at);
CREATE INDEX IF NOT EXISTS ix_snapshots_handle ON snapshots(handle, at);

CREATE TABLE IF NOT EXISTS tweets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, snap TEXT, at TEXT, idx INTEGER,
  tweet_id TEXT, href TEXT, author TEXT, author_name TEXT, author_name_dirty TEXT,
  text TEXT, time_datetime TEXT, time_visible TEXT, ad_suspect INTEGER,
  follow_state TEXT, has_photo INTEGER, is_retweet INTEGER, summary_aria TEXT,
  metrics TEXT, author_tokens TEXT, html TEXT, liked INTEGER, tl_src TEXT, UNIQUE(snap, idx));
CREATE INDEX IF NOT EXISTS ix_tweets_snap ON tweets(snap);
CREATE INDEX IF NOT EXISTS ix_tweets_id ON tweets(tweet_id);
CREATE INDEX IF NOT EXISTS ix_tweets_author ON tweets(author);
CREATE INDEX IF NOT EXISTS ix_tweets_at ON tweets(at);

CREATE TABLE IF NOT EXISTS user_rows(
  id INTEGER PRIMARY KEY AUTOINCREMENT, snap TEXT, at TEXT, idx INTEGER,
  handle TEXT, name TEXT, name_how TEXT, name_raw TEXT, name_dirty TEXT,
  origin TEXT, mod TEXT, follow_state TEXT, follow_aria TEXT, has_bio INTEGER,
  bio TEXT, cell_text TEXT, name_foreign INTEGER, name_tokens TEXT,
  leaf_shapes TEXT, cands TEXT, html TEXT, UNIQUE(snap, idx));
CREATE INDEX IF NOT EXISTS ix_user_rows_snap ON user_rows(snap);
CREATE INDEX IF NOT EXISTS ix_user_rows_handle ON user_rows(handle, at);
CREATE INDEX IF NOT EXISTS ix_user_rows_at ON user_rows(at);

CREATE TABLE IF NOT EXISTS follow_events(
  key TEXT PRIMARY KEY, at TEXT, day TEXT, handle TEXT, target_id TEXT, dir TEXT,
  why TEXT, src TEXT, suspect INTEGER, tab TEXT, url TEXT, w15 INTEGER, max15 INTEGER,
  w24 INTEGER, max24 INTEGER, over15 INTEGER, over24 INTEGER, gap INTEGER,
  rapid INTEGER, cool INTEGER);
CREATE INDEX IF NOT EXISTS ix_follow_at ON follow_events(at);
CREATE INDEX IF NOT EXISTS ix_follow_handle ON follow_events(handle, at);

CREATE TABLE IF NOT EXISTS stat_points(
  key TEXT PRIMARY KEY, at TEXT, day TEXT, handle TEXT, following INTEGER,
  followers INTEGER, exact INTEGER, reason TEXT, vals TEXT, url TEXT);
CREATE INDEX IF NOT EXISTS ix_stat_at ON stat_points(at);
CREATE INDEX IF NOT EXISTS ix_stat_handle ON stat_points(handle, at);

CREATE TABLE IF NOT EXISTS reward_points(
  key TEXT PRIMARY KEY, at TEXT, own TEXT, day TEXT, value INTEGER, exact INTEGER,
  token TEXT, hit INTEGER, added INTEGER, key_nodes INTEGER, text TEXT, why TEXT,
  cands TEXT, url TEXT);
CREATE INDEX IF NOT EXISTS ix_reward_day ON reward_points(own, day);
CREATE VIEW IF NOT EXISTS reward_days AS
  SELECT own, day, value, exact, token, at FROM reward_points r
  WHERE at = (SELECT MAX(at) FROM reward_points q WHERE q.own = r.own AND q.day = r.day);

-- v0.6.11「每人每天一行」：reward_points 只有曝光一列，装不下用户那张四列表（时间/曝光/关注/粉丝/帖子），
-- 而且它按 own 记账 = 只能记我自己。这张表按 handle 记 ⇒ 打开谁的主页都能落一行，排名才有横向可比的东西。
CREATE TABLE IF NOT EXISTS day_rows(
  key TEXT PRIMARY KEY, at TEXT, day TEXT, handle TEXT, exposure INTEGER, effective INTEGER, exact INTEGER,
  token TEXT, following INTEGER, followers INTEGER, posts INTEGER, manual INTEGER, source TEXT);
CREATE INDEX IF NOT EXISTS ix_dr_handle_day ON day_rows(handle, day);
CREATE INDEX IF NOT EXISTS ix_dr_day ON day_rows(day);
-- 视图 = **按列各取最后一次有数的**（不是整行取最新）。道理与 SW 的 mergeSeries 一样：
-- 用户先补曝光、隔一天又只补帖子，整行取最新会把曝光那格说成没有。
-- v0.7.2 曝光拆两列：exposure = 账号分析页的实时曝光（当天当刻在涨）；effective = 奖励页的有效曝光
-- （T+1 才出，库里同时记 at = 落账时刻）。历史行里 exposure 装的全是奖励页的数 ⇒ 迁移搬进 effective。
CREATE VIEW IF NOT EXISTS day_latest AS
  SELECT h.handle, h.day,
    (SELECT exposure FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND exposure IS NOT NULL
      ORDER BY at DESC, rowid DESC LIMIT 1) AS exposure,
    (SELECT effective FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND effective IS NOT NULL
      ORDER BY at DESC, rowid DESC LIMIT 1) AS effective,
    (SELECT exact FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND exposure IS NOT NULL
      ORDER BY at DESC, rowid DESC LIMIT 1) AS exact,
    (SELECT token FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND exposure IS NOT NULL
      ORDER BY at DESC, rowid DESC LIMIT 1) AS token,
    (SELECT following FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND following IS NOT NULL
      ORDER BY at DESC, rowid DESC LIMIT 1) AS following,
    (SELECT followers FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND followers IS NOT NULL
      ORDER BY at DESC, rowid DESC LIMIT 1) AS followers,
    (SELECT posts FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND posts IS NOT NULL
      ORDER BY at DESC, rowid DESC LIMIT 1) AS posts,
    (SELECT MAX(x.at) FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day) AS at,
    (SELECT COUNT(*) FROM day_rows x WHERE x.handle=h.handle AND x.day=h.day AND x.manual=1) AS manual_n
    FROM (SELECT DISTINCT handle, day FROM day_rows) h;

-- v0.7.0「一条帖子一行、指标一列一点」：tweets 本来就是**每次采集一行**，同一 tweet_id 每见一次多一行。
-- 所以「更新」不是覆盖而是追加 —— 覆盖掉就把增速吃了。下面两张视图分别给「每点」和「每帖最新」。
-- 推广位（ad_suspect）与没有 tweet_id 的行剔除：前者不是真帖子，后者没法归并。
CREATE VIEW IF NOT EXISTS post_points AS
  SELECT t.id AS tid, t.tweet_id, t.at, t.author, t.text, t.time_datetime,
    t.follow_state, COALESCE(t.liked, 0) AS liked, t.tl_src,
    json_extract(t.metrics, '$.view.num.value') AS view,
    json_extract(t.metrics, '$.like.num.value') AS like,
    json_extract(t.metrics, '$.repost.num.value') AS repost,
    json_extract(t.metrics, '$.reply.num.value') AS reply,
    json_extract(t.metrics, '$.quote.num.value') AS quote,
    json_extract(t.metrics, '$.bookmark.num.value') AS bookmark
  FROM tweets t
  WHERE t.tweet_id IS NOT NULL AND t.tweet_id <> '' AND COALESCE(t.ad_suspect, 0) = 0;

-- 每帖最新一点。at 相同的（同一批重采）按 id 取后写的那个。
CREATE VIEW IF NOT EXISTS post_latest AS
  SELECT p.tid, p.tweet_id, p.at, p.author, p.text, p.time_datetime, p.follow_state,
    p.liked, p.view, p.like, p.repost, p.reply, p.quote, p.bookmark
  FROM (SELECT pp.*, ROW_NUMBER() OVER (
          PARTITION BY pp.tweet_id ORDER BY pp.at DESC, pp.tid DESC) AS rn
        FROM post_points pp) p
  WHERE p.rn = 1;

-- 增速 =（最新 - 首次）/ 相隔小时。只有一条采样时 view_per_h 必须为 NULL，不许写 0：
-- 0 会被榜单读成「涨得最慢」，而真相是「还不知道」。
CREATE VIEW IF NOT EXISTS post_growth AS
  WITH f AS (
    SELECT p.tweet_id, p.at AS first_at, p.view AS f_view, p.like AS f_like,
      p.repost AS f_repost, p.reply AS f_reply, p.quote AS f_quote, p.bookmark AS f_bookmark
    FROM (SELECT pp.*, ROW_NUMBER() OVER (
            PARTITION BY pp.tweet_id ORDER BY pp.at ASC, pp.tid ASC) AS rn
          FROM post_points pp) p
    WHERE p.rn = 1
  ),
  c AS (SELECT tweet_id, COUNT(*) AS n FROM post_points GROUP BY tweet_id)
  SELECT l.tweet_id, l.author, l.text, l.time_datetime, l.at AS last_at, f.first_at,
    l.view, l.like, l.repost, l.reply, l.quote, l.bookmark, l.liked,
    c.n AS points,
    ROUND((julianday(l.at) - julianday(f.first_at)) * 24.0, 3) AS hours,
    (l.view - f.f_view) AS view_gain,
    (COALESCE(l.like, 0) - COALESCE(f.f_like, 0)) AS like_gain,
    CASE WHEN f.f_view IS NOT NULL AND l.view IS NOT NULL
           AND julianday(l.at) > julianday(f.first_at)
      THEN ROUND((l.view - f.f_view) / ((julianday(l.at) - julianday(f.first_at)) * 24.0), 1)
    END AS view_per_h,
    (COALESCE(l.like, 0) + COALESCE(l.repost, 0) + COALESCE(l.reply, 0)
      + COALESCE(l.quote, 0) + COALESCE(l.bookmark, 0)) AS eng,
    CASE WHEN COALESCE(l.view, 0) > 0
      THEN ROUND(100.0 * (COALESCE(l.like, 0) + COALESCE(l.repost, 0) + COALESCE(l.reply, 0)
        + COALESCE(l.quote, 0) + COALESCE(l.bookmark, 0)) / l.view, 2)
    END AS eng_rate,
    CASE WHEN COALESCE(l.view, 0) > 0
      THEN ROUND(100.0 * COALESCE(l.like, 0) / l.view, 2)
    END AS like_rate
  FROM post_latest l
  JOIN c ON c.tweet_id = l.tweet_id
  LEFT JOIN f ON f.tweet_id = l.tweet_id;

CREATE TABLE IF NOT EXISTS store_users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, at TEXT, handle TEXT, name TEXT,
  followers INTEGER, following INTEGER, exact INTEGER, relation TEXT, own INTEGER,
  seen_as TEXT, pts INTEGER, UNIQUE(key, handle));
CREATE INDEX IF NOT EXISTS ix_su_handle ON store_users(handle, at);

CREATE TABLE IF NOT EXISTS store_posts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, at TEXT, post_id TEXT, handle TEXT,
  text TEXT, first_seen TEXT, reply INTEGER, repost INTEGER, like INTEGER, view INTEGER,
  n INTEGER, UNIQUE(key, post_id));
CREATE INDEX IF NOT EXISTS ix_sp_id ON store_posts(post_id, at);

CREATE TABLE IF NOT EXISTS blocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, at TEXT, day TEXT, handle TEXT, name TEXT,
  state INTEGER, url TEXT, UNIQUE(key, handle, at));
CREATE INDEX IF NOT EXISTS ix_bl_handle ON blocks(handle, at);

-- 拉黑名单的「现在还在不在名单上」：每 handle 取最新一条，state=1 才算在。取消过的人不冒充还在。
CREATE VIEW IF NOT EXISTS blocked_now AS
  SELECT handle, state, at, name FROM (
    SELECT handle, state, at, name,
      ROW_NUMBER() OVER (PARTITION BY handle ORDER BY at DESC, id DESC) AS rn
    FROM blocks) WHERE rn = 1 AND state = 1;

-- 标杆名单（v0.9.0）：与 blocks 同一套纪律 —— append-only，一事件一行，「现在在不在」由视图按最新一条判。
-- tags 是「分类」那一列的自由文本（逗号分隔，见 _tags() 的取值口径）；改标签 = 再落一行 state=1 带新 tags，
-- 不是 UPDATE 原行：改行的话「这个人什么时候进的榜」和「什么时候改的分类」就只有一个时间戳了。
CREATE TABLE IF NOT EXISTS benchmarks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, at TEXT, day TEXT, handle TEXT, name TEXT,
  state INTEGER, tags TEXT, url TEXT, UNIQUE(key, handle, at));
CREATE INDEX IF NOT EXISTS ix_bm_handle ON benchmarks(handle, at);

-- 「现在是标杆的人」：最新一条 state=1 才算在，取消过的人不冒充还在（和 blocked_now 同一条判据）。
-- 这里只出「我们记的账」（handle/name/tags/标记时刻），粉丝/曝光一律从 account_latest 那边 LEFT JOIN 过来 ——
-- 视图不自己算数，缺数就是 NULL，面板如实显示「—」，绝不拿 0 冒充「粉丝很少」（RL-11）。
CREATE VIEW IF NOT EXISTS bench_now AS
  SELECT handle, name, at, tags FROM (
    SELECT handle, name, at, tags, state,
      ROW_NUMBER() OVER (PARTITION BY handle ORDER BY at DESC, id DESC) AS rn
    FROM benchmarks) WHERE rn = 1 AND state = 1;

-- 标杆帖子（v0.9.3）：与 benchmarks 同一套纪律 —— append-only，一事件一行，「现在在不在」由视图判。
-- 为什么单独一张表而不是给 benchmarks 加一列「类型」：这两本账的主键根本不是一回事（一个是 handle，
-- 一条是 tweet_id），塞一张表就得让 handle 或 tweet_id 有一列永远空着，查询与视图全要额外判类型。
-- text 存的是**标记那一刻的正文快照**（帖子会被删、被改，库里这一行是「我当时看到的那句」）；
-- tags 这轮没有界面可改（用户口径「分类留下一轮」），列先留着：以后加分类不用改表结构。
CREATE TABLE IF NOT EXISTS bench_posts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, at TEXT, day TEXT, tweet_id TEXT,
  author TEXT, text TEXT, state INTEGER, tags TEXT, url TEXT, UNIQUE(key, tweet_id, at));
CREATE INDEX IF NOT EXISTS ix_bp_id ON bench_posts(tweet_id, at);

-- 「现在是标杆的帖子」：最新一条 state=1 才算在（与 bench_now / blocked_now 同一条判据）。
-- 数（曝光/评论/赞/发帖时刻）不在这里算，从 post_growth 那边 LEFT JOIN 过来 —— 视图只记「我们标过谁」。
CREATE VIEW IF NOT EXISTS bench_posts_now AS
  SELECT tweet_id, author, text, at, tags FROM (
    SELECT tweet_id, author, text, at, tags, state,
      ROW_NUMBER() OVER (PARTITION BY tweet_id ORDER BY at DESC, id DESC) AS rn
    FROM bench_posts) WHERE rn = 1 AND state = 1;

CREATE TABLE IF NOT EXISTS dumps(
  name TEXT PRIMARY KEY, at TEXT, day TEXT, tab TEXT, handle TEXT, url TEXT,
  tree_bytes INTEGER, text_bytes INTEGER, html_bytes INTEGER, ms INTEGER,
  emitted INTEGER, nodes INTEGER, hit_cap TEXT);

-- 账号一行：谁出现过就有谁（日点表 ∪ 用户表 ∪ 帖子作者）。放在 SCHEMA 末尾是因为它要读 store_users。
-- 关注关系优先用用户表最新一行，没有就退到最近一条带 follow_state 的帖子 ——
-- 时间线不是每行都有关注按钮，但见到一次就记住并带上确认时间（relation_at），别假装是此刻的实况。
CREATE VIEW IF NOT EXISTS account_latest AS
  WITH hs AS (
    SELECT handle FROM store_users WHERE handle <> ''
    UNION SELECT handle FROM day_latest WHERE handle <> ''
    UNION SELECT author FROM post_latest WHERE author <> ''
  ),
  d AS (
    SELECT a.* FROM day_latest a
    JOIN (SELECT handle, MAX(day) AS md FROM day_latest GROUP BY handle) m
      ON m.handle = a.handle AND m.md = a.day
  ),
  u AS (
    SELECT s.handle, s.name, s.relation, s.own, s.at, s.followers, s.following
    FROM store_users s
    WHERE s.id = (SELECT MAX(x.id) FROM store_users x WHERE x.handle = s.handle)
  )
  SELECT hs.handle,
    COALESCE(u.name, '') AS name,
    COALESCE(u.own, 0) AS own,
    COALESCE(NULLIF(u.relation, ''), CASE WHEN COALESCE(u.own, 0) = 1 THEN 'self' END, (
      SELECT p.follow_state FROM post_points p
      WHERE p.author = hs.handle AND p.follow_state <> ''
      ORDER BY p.at DESC, p.tid DESC LIMIT 1), '') AS relation,
    (SELECT MAX(p.at) FROM post_points p
      WHERE p.author = hs.handle AND p.follow_state <> '') AS relation_at,
    d.day, d.exposure, d.effective, d.exact, d.token, d.posts, d.at AS day_at,
    u.at AS seen_at,
    COALESCE(u.followers, d.followers) AS fans,
    COALESCE(u.following, d.following) AS fow,
    (SELECT COUNT(*) FROM post_latest p WHERE p.author = hs.handle) AS posts_n,
    (SELECT SUM(COALESCE(p.like, 0) + COALESCE(p.repost, 0) + COALESCE(p.reply, 0)
        + COALESCE(p.quote, 0) + COALESCE(p.bookmark, 0))
      FROM post_latest p WHERE p.author = hs.handle) AS eng,
    (SELECT SUM(COALESCE(p.view, 0)) FROM post_latest p WHERE p.author = hs.handle) AS views,
    (SELECT MAX(p.at) FROM post_latest p WHERE p.author = hs.handle) AS last_post_at,
    COALESCE(b.state, 0) AS blocked, b.at AS blocked_at
  FROM hs LEFT JOIN d ON d.handle = hs.handle LEFT JOIN u ON u.handle = hs.handle
    LEFT JOIN blocked_now b ON b.handle = hs.handle;
"""

# 只给白名单：HTTP 层拿到的是这里的名字，绝不把用户传来的 SQL 往 execute 里递
QUERIES = {
    "help": None,
    "tables": None,
    "kinds": "SELECT kind, COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at"
             " FROM records GROUP BY kind ORDER BY n DESC",
    "days": "SELECT day, COUNT(*) AS n FROM records WHERE kind <> 'probe'"
            " GROUP BY day ORDER BY day DESC LIMIT ?",
    "recent": "SELECT at, kind, handle, tab, substr(summary, 1, 200) AS summary"
              " FROM records ORDER BY at DESC LIMIT ?",
    "snapshots": "SELECT at, tab, handle, articles, tweets_n, users_n, hydrated, bytes"
                 " FROM snapshots ORDER BY at DESC LIMIT ?",
    "tweets": "SELECT at, tweet_id, author, author_name, substr(text, 1, 80) AS text,"
              " time_datetime, metrics FROM tweets ORDER BY id DESC LIMIT ?",
    "user_rows": "SELECT at, handle, name, name_how, origin, follow_state"
                 " FROM user_rows ORDER BY id DESC LIMIT ?",
    "follows": "SELECT at, handle, dir, w15, max15, w24, max24, gap, rapid, cool"
               " FROM follow_events ORDER BY at DESC LIMIT ?",
    "trend": "SELECT at, handle, following, followers, exact, reason"
             " FROM stat_points ORDER BY at DESC LIMIT ?",
    "rewards": "SELECT own, day, value, exact, token, at FROM reward_days"
               " ORDER BY day DESC LIMIT ?",
    # v0.6.11：日点行按人按天（视图已按列各取最后一次有数的），rank 是「每人最新一行」拿来排名的
    "day_rows": "SELECT handle, day, exposure, effective, exact, token, following, followers, posts,"
                " manual_n, at FROM day_latest ORDER BY day DESC, handle ASC LIMIT ?",
    "rank": "SELECT a.handle, a.day, a.exposure, a.effective, a.following, a.followers, a.posts, a.at"
            " FROM day_latest a JOIN (SELECT handle, MAX(day) md FROM day_latest GROUP BY handle) m"
            " ON m.handle = a.handle AND m.md = a.day"
            " ORDER BY CASE WHEN a.following IS NULL THEN -1 ELSE a.following END DESC, a.handle ASC LIMIT ?",
    # v0.7.0「一条帖子一行」的三个读法 + 账号行。空值排序一律显式写成 CASE：
    # DESC 在 SQLite 里恰好也是 NULL 垫底，但 ASC 会把 NULL 当最小排到最前 ——
    # 那是「没数」冒充「互动最少」，正好会把人推进「最该取关」名单。
    "posts": "SELECT tweet_id, author, substr(text, 1, 90) AS text, time_datetime,"
             " last_at, view, like, repost, reply, quote, bookmark, liked, eng, eng_rate,"
             " like_rate, points, view_per_h FROM post_growth"
             " ORDER BY CASE WHEN last_at IS NULL THEN 1 ELSE 0 END, last_at DESC LIMIT ?",
    "posts_top": "SELECT tweet_id, author, substr(text, 1, 90) AS text, last_at, view, like,"
                 " repost, reply, quote, bookmark, liked, eng, eng_rate, like_rate, points,"
                 " view_per_h FROM post_growth"
                 " ORDER BY CASE WHEN view IS NULL THEN 1 ELSE 0 END, view DESC LIMIT ?",
    "posts_growth": "SELECT tweet_id, author, substr(text, 1, 90) AS text, last_at, view,"
                    " view_gain, hours, view_per_h, like_gain, eng, eng_rate, like_rate,"
                    " points FROM post_growth"
                    " ORDER BY CASE WHEN view_per_h IS NULL THEN 1 ELSE 0 END,"
                    " view_per_h DESC LIMIT ?",
    "accounts": "SELECT handle, name, own, relation, relation_at, day, exposure, effective, token, fans,"
                " fow, posts, posts_n, eng, views, last_post_at, seen_at, blocked FROM account_latest"
                " ORDER BY CASE WHEN eng IS NULL THEN 1 ELSE 0 END, eng DESC,"
                " handle ASC LIMIT ?",
    # v0.8.4 拉黑名单：流水直查（面板不用它也行，但本机排查要用）
    "blocks": "SELECT at, handle, name, state FROM blocks ORDER BY id DESC LIMIT ?",
    # v0.9.0 标杆名单：同样是流水直查（本机排查「这人哪进哪出的、当时标签是什么」）
    "benchmarks": "SELECT at, handle, name, state, tags FROM benchmarks ORDER BY id DESC LIMIT ?",
    # v0.9.0 标杆窗口：名单一个账号一行，TA 的数从 account_latest 那边照过来（LEFT JOIN：
    # 进了标杆但本机还没抓到数的人必须在，否则「我刚标了 TA 怎么不见了」会被读成「库坏了」）。
    # 这里只给一个默认排序（粉丝降序、缺数垫底）——面板上那几颗排序钮是**客户端重排这批行**，
    # 不再加第二条查询：指标只有这几列，重排是排序的事，不是查询的事（和曝光榜「曝光/评论」切换同一先例）。
    "bench_accounts": "SELECT b.handle, b.name, b.tags, b.at AS marked_at,"
                      " a.fans, a.fow, a.posts_n, a.views, a.eng, a.last_post_at, a.relation, a.blocked"
                      " FROM bench_now b LEFT JOIN account_latest a ON a.handle = b.handle"
                      " ORDER BY CASE WHEN a.fans IS NULL THEN 1 ELSE 0 END, a.fans DESC,"
                      " b.handle ASC LIMIT ?",
    # v0.9.3 标杆帖子窗口：一条帖子一行，数从 post_growth 照过来（同样是 LEFT JOIN —— 刚标完、本机还没
    # 采到过第二次的帖子必须在名单里，否则「我刚标了这条怎么不见了」会被读成库坏了）。
    # 默认排序=曝光降序、缺数垫底（与账号窗口同一条判据：「没数」不许冒充「曝光很低」）。
    # 面板上那几颗排序钮是**客户端重排这批行**，不加第二条查询（RL-9：指标就这几列，重排是排序的事）。
    "bench_post_rows": "SELECT b.tweet_id, b.author, b.text AS marked_text, b.tags, b.at AS marked_at,"
                       " g.view, g.reply, g.like, g.eng, g.points, g.view_per_h,"
                       " g.time_datetime, g.first_at, g.last_at"
                       " FROM bench_posts_now b LEFT JOIN post_growth g ON g.tweet_id = b.tweet_id"
                       " ORDER BY CASE WHEN g.view IS NULL THEN 1 ELSE 0 END, g.view DESC,"
                       " b.tweet_id ASC LIMIT ?",
    # v0.9.3 标杆帖子流水直查（本机排查「这条哪进哪出的」；面板不用它）
    "bench_posts": "SELECT at, tweet_id, author, state, tags, substr(text, 1, 60) AS text"
                   " FROM bench_posts ORDER BY id DESC LIMIT ?",
    # v0.9.7 上云增量推送用的两条「台账流水」查询。与上面窗口那两条（bench_accounts / bench_post_rows）
    # 差在三处，每一处都是云端要的：
    # ① 不按 state 过滤、也不走 bench_now 视图 —— 取消标杆（state=0）那一行必须推得出去，
    #    否则云端永远留着一条我这边早就作废的标记（视图只认「现在还在」，天生推不出删除）。
    # ② 带 id（本机自增主键）且按 id 升序 —— 它是这一版的游标：客户端只推 id > 上次服务端确认过的位。
    #    为什么不用 at 比时间：本机改过系统时钟、或同一毫秒落两行，都会让「按时间增量」漏行或重放；
    #    自增 id 单调、与钟表无关，是这个库里唯一可靠的增量坐标。
    # ③ text 出整列、不再 substr（库里那一列写入时就截到 200 字，那是「我当时看到的那句」的快照原话）。
    # 数（粉丝/曝光/发帖时刻）仍从 account_latest / post_growth LEFT JOIN 带过来当快照：缺数就是 NULL，
    # 不拿 0 冒充「粉丝很少」（RL-11）；JOIN 用 LEFT 也是因为「标了人但本机还没抓到数」那条必须在。
    # observed_at = 这批数是**什么时候看到的**（账号取用户行与日点行里较晚的那个时刻；帖子取最后一个采样点）——
    # 上云要它，否则服务端只能拿「标记时刻」当数值的来路时刻：标记可以发生在昨天、数可以是今天补采的，
    # 拿标记时刻排序就会让「晚采到的真数」被「早标记的旧数」盖掉。两列都缺就是 NULL，不拿标记时刻冒充。
    # 写 NULLIF(MAX(COALESCE(..,''),COALESCE(..,'')),'') 而不是 MAX(a.seen_at, a.day_at)：
    # SQLite 的两参 max 是标量函数，任一参数为 NULL 就回 NULL —— 只抓到日点、没抓过用户行的那个人会白白丢掉时刻。
    "bench_marks_ac": "SELECT s.id, s.at, s.day, s.handle, s.name, s.state, s.tags, s.url,"
                      " a.fans, a.fow, a.posts_n, a.views, a.eng, a.relation, a.blocked,"
                      " a.last_post_at,"
                      " NULLIF(MAX(COALESCE(a.seen_at, ''), COALESCE(a.day_at, '')), '') AS observed_at"
                      " FROM benchmarks s LEFT JOIN account_latest a ON a.handle = s.handle"
                      " WHERE s.id > ? ORDER BY s.id ASC LIMIT ?",
    "bench_marks_po": "SELECT s.id, s.at, s.day, s.tweet_id, s.author, s.text, s.state, s.tags, s.url,"
                      " g.view, g.reply, g.like, g.eng, g.time_datetime, g.last_at AS observed_at"
                      " FROM bench_posts s LEFT JOIN post_growth g ON g.tweet_id = s.tweet_id"
                      " WHERE s.id > ? ORDER BY s.id ASC LIMIT ?",
    # v0.10.6 抓取档案上云：把「打开页面时抓到的账号行 / 帖子行」按增量推给云端实体层。
    # 与 store_users / store_posts 那条直查差在三处：
    # ① 每人 / 每帖只取**最新那一次**快照（MAX(id) 那一行）：这两张表是按 key 累加的历史快照，
    #    真机 49950 行账号其实只有 197 个人、33305 行帖子只有 13067 条 —— 逐行推就是把人同一份数
    #    重推几百遍，云端 upsert 再多也架不住白跑几百个来回。
    # ② 游标仍然是 store 表的自增 id（u.id），而不是「第几个业务键」：id 单调、与钟表无关，
    #    一个人被重新抓到会落一行新 id ⇒ 它自然出现在后续页里，不会因为「上次已经推过这个人」被漏掉。
    # ③ 不吃 account_latest 那套聚合视图：实测在 870MB 真库上 JOIN 它 20 行要 15 秒，
    #    一页 500 行能拖到分钟级。档案上云要的是「抓到的原样」，帖子数/总曝光这类二次聚合留给云端算。
    "lib_users": "SELECT u.id, u.at, u.handle, u.name, u.followers, u.following,"
                 " u.exact, u.relation, u.own"
                 " FROM store_users u"
                 " JOIN (SELECT handle, MAX(id) AS mid FROM store_users"
                 "       WHERE handle <> '' GROUP BY handle) m ON m.mid = u.id"
                 " WHERE u.id > ? ORDER BY u.id ASC LIMIT ?",
    "lib_posts": "SELECT u.id, u.at, u.post_id, u.handle, u.text, u.first_seen,"
                 " u.reply, u.repost, u.like, u.view, u.n"
                 " FROM store_posts u"
                 " JOIN (SELECT post_id, MAX(id) AS mid FROM store_posts"
                 "       WHERE post_id <> '' GROUP BY post_id) m ON m.mid = u.id"
                 " WHERE u.id > ? ORDER BY u.id ASC LIMIT ?",
    # v0.10.7 同步进度：不新开同步账本，**服务端 ack 水位就是账**。
    # lib_users / lib_posts 推的正是「每个业务键的 MAX(id) 那一行」⇒ 一个键算不算已推，就看它的 mid 是否 <= 水位：
    #   total   = 本地有多少个不同的 handle / post_id（和档案上送的口径逐字一致，不含空键）
    #   synced  = 其中 mid <= 当前水位的那几个（水位只抬到服务端 ack，所以这是「服务端确认过的」）
    #   pending = total - synced（在 JS 侧减，SQL 不另算一遍，省得两个数打架）
    # 参数只有一个：after = 水位。真库 197 人 / 13067 帖，6 毫秒上下（GROUP BY 走 ix_su_handle / ix_sp_id）。
    "lib_user_stat": "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN mid <= ? THEN 1 ELSE 0 END), 0) AS synced,"
                     " COALESCE(MAX(mid), 0) AS max_id"
                     " FROM (SELECT handle, MAX(id) AS mid FROM store_users"
                     "       WHERE handle <> '' GROUP BY handle)",
    "lib_post_stat": "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN mid <= ? THEN 1 ELSE 0 END), 0) AS synced,"
                     " COALESCE(MAX(mid), 0) AS max_id"
                     " FROM (SELECT post_id, MAX(id) AS mid FROM store_posts"
                     "       WHERE post_id <> '' GROUP BY post_id)",
    # v0.11.0 拉黑上云（db-10）：与两条标杆台账流水同一套「append-only + 自增 id 游标」。
    # 为什么不是按 at 增量：本机改过系统时钟、或同一毫秒落两行，都会让按时间增量漏行或重放；
    # blocks.id 单调、与钟表无关，是这个库里唯一可靠的增量坐标（bench_marks_* 立下同一条判据）。
    # 不 JOIN account_latest：这一路要的是「我拉黑/取消过谁」的原账，粉丝数这类聚合与本条腿无关，
    # 而真库上 JOIN 那个视图 20 行要十几秒——一页 500 行会把一趟同步拖到分钟级。
    "block_marks": "SELECT s.id, s.at, s.day, s.handle, s.name, s.state, s.url"
                   " FROM blocks s WHERE s.handle <> '' AND s.id > ? ORDER BY s.id ASC LIMIT ?",
    # 进度对账与档案那两条同一口径：一个 handle 算不算已推，看它的最新一行（MAX(id)）是否 <= 水位。
    "block_stat": "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN mid <= ? THEN 1 ELSE 0 END), 0) AS synced,"
                  " COALESCE(MAX(mid), 0) AS max_id"
                  " FROM (SELECT handle, MAX(id) AS mid FROM blocks"
                  "       WHERE handle <> '' GROUP BY handle)",
    "accounts_reach": "SELECT handle, name, own, relation, relation_at, day, exposure, token,"
                      " fans, fow, posts, posts_n, eng, views, last_post_at, seen_at"
                      " FROM account_latest"
                      " ORDER BY CASE WHEN views IS NULL THEN 1 ELSE 0 END, views DESC,"
                      " handle ASC LIMIT ?",
    # 建议两条：只给候选，永不自动动——「取关」是用户的手，不是脚本的。
    # 只认明确的 not_following/following：关系未知（时间线没画关注按钮）不许冒充「没关注」。
    "should_follow": "SELECT handle, name, relation, relation_at, fans, posts_n, eng, views,"
                     " last_post_at FROM account_latest"
                     " WHERE own = 0 AND relation = 'not_following' AND posts_n > 0"
                     " ORDER BY CASE WHEN eng IS NULL THEN 1 ELSE 0 END, eng DESC,"
                     " views DESC, handle ASC LIMIT ?",
    "should_unfollow": "SELECT handle, name, relation, relation_at, fans, posts_n, eng, views,"
                       " last_post_at FROM account_latest"
                       " WHERE own = 0 AND relation = 'following' AND posts_n > 0"
                       " ORDER BY CASE WHEN eng IS NULL THEN 1 ELSE 0 END, eng ASC,"
                       " CASE WHEN fans IS NULL THEN 1 ELSE 0 END, fans ASC,"
                       " handle ASC LIMIT ?",
    "store_users": "SELECT at, handle, name, followers, following, exact, relation, own"
                   " FROM store_users ORDER BY id DESC LIMIT ?",
    "store_posts": "SELECT at, post_id, handle, substr(text, 1, 80) AS text,"
                   " reply, repost, like, view, n FROM store_posts ORDER BY id DESC LIMIT ?",
    "handles": "SELECT handle, COUNT(*) AS n, MAX(at) AS last_at FROM store_users"
               " GROUP BY handle ORDER BY n DESC LIMIT ?",
    "dumps": "SELECT at, tab, handle, tree_bytes, text_bytes, html_bytes, ms"
             " FROM dumps ORDER BY at DESC LIMIT ?",
    # v0.8.2 时间线曝光排序：tl_src = 这份快照拍到时主页时间线停在哪个 tab（foryou=为你推荐 / following=正在关注）。
    # 每帖每天每源只取最新一点（取有 view 的最新，而不是全天最新——后者可能恰好没抠到曝光数）。
    # tl_rank 带两个占位符（day, limit）：某天一张榜；tl_days 单占位符：给面板出「有哪几天」的下拉。
    "tl_days": "SELECT day, tl_src, COUNT(*) AS n, SUM(view) AS views FROM ("
               "  SELECT substr(p.at, 1, 10) AS day, p.tl_src, p.tweet_id, p.view,"
               "    ROW_NUMBER() OVER (PARTITION BY p.tweet_id, substr(p.at, 1, 10), p.tl_src"
               "                       ORDER BY p.at DESC, p.tid DESC) AS rn"
               "  FROM post_points p"
               "  WHERE p.tl_src IS NOT NULL AND p.tl_src <> '' AND p.view IS NOT NULL"
               ") WHERE rn = 1 GROUP BY day, tl_src ORDER BY day DESC, tl_src ASC LIMIT ?",
    "tl_rank": "SELECT day, tl_src, tweet_id, author, substr(text, 1, 70) AS text, at, view, reply FROM ("
               "  SELECT substr(p.at, 1, 10) AS day, p.tl_src, p.tweet_id, p.author,"
               "    p.text, p.at, p.view, p.reply,"
               "    ROW_NUMBER() OVER (PARTITION BY p.tweet_id, substr(p.at, 1, 10), p.tl_src"
               "                       ORDER BY p.at DESC, p.tid DESC) AS rn"
               "  FROM post_points p"
               "  WHERE p.tl_src IS NOT NULL AND p.tl_src <> '' AND p.view IS NOT NULL"
               "    AND substr(p.at, 1, 10) = ?"
               ") WHERE rn = 1"
               " ORDER BY CASE WHEN view IS NULL THEN 1 ELSE 0 END, view DESC, tweet_id ASC LIMIT ?",
    # v0.8.2 时间线卡片点昵称：某人所有已抓帖子按曝光降序（post_growth 一帖一行、view 取最新一点）。
    # author 带一个占位符：handle 字符卡形状（1~20 位字母数字下划线），卡不住的一律报错不猜。
    # v0.9.2 末尾补两列（**只往末尾加，不动前面的列序**：面板与抽屉都按键取值，但 db-selftest 有一处按 [0] 取
    # tweet_id，插中间就等于把别人的下标口径改了）：time_datetime = 这条帖子**自己发出来的时刻**
    # （页面 `<time datetime>` 的原文，UTC 带 Z，真库 27616 条里 27609 条有），first_at = 我们第一次采到它。
    # 以前只给 last_at（最后一次采到的时刻）⇒ 标杆抽屉里一屏帖子全显示成同一分钟（那正是「这一屏是同一趟扫的」），
    # 用户要的「按发帖时间排 / 只看最近 N 天发的」根本做不了。采集时刻仍然留着，别当没有。
    "author_posts": "SELECT tweet_id, author, substr(text, 1, 90) AS text, last_at, view, like, reply, eng,"
                    " view_per_h, time_datetime, first_at FROM post_growth"
                    " WHERE author = ?"
                    " ORDER BY CASE WHEN view IS NULL THEN 1 ELSE 0 END, view DESC, tweet_id ASC LIMIT ?",
    # v0.8.6 曝光榜卡片「历史」档：时间窗内每帖取「最新一点有曝光的」去重，按 view 降序。
    # 三个占位符 (cut, up, limit)：hours 模式 cut=now-hours、up=9999；区间模式 cut/up=起止日；hours=0 = 全部。
    # cut/up 一律在 Python 这边算好再绑，SQL 里不出现任何外部字符串 —— 白名单纪律不动。
    "tl_win": "SELECT tweet_id, author, substr(text, 1, 70) AS text, at, view, like, reply, tl_src FROM ("
              "  SELECT p.tweet_id, p.author, p.text, p.at, p.view, p.like, p.reply, p.tl_src,"
              "    ROW_NUMBER() OVER (PARTITION BY p.tweet_id ORDER BY p.at DESC, p.tid DESC) AS rn"
              "  FROM post_points p"
              "  WHERE p.view IS NOT NULL AND p.at >= ? AND p.at < ?"
              ") WHERE rn = 1"
              " ORDER BY CASE WHEN view IS NULL THEN 1 ELSE 0 END, view DESC, tweet_id ASC LIMIT ?",
}

_LOCK = threading.Lock()
_DB = {"conn": None, "path": "", "err": "", "fails": 0, "ingested": 0, "duped": 0, "disabled": False}
_MAX_FAILS = 30   # 连错这么多回就停用：坏库不该让 sink 每条记录都重试一遍


def _now() -> str:
    return datetime.now().isoformat(timespec="milliseconds")


def _txt(v, maxlen: int = 200) -> str:
    if v is None:
        return ""
    if not isinstance(v, str):
        try:
            v = json.dumps(v, ensure_ascii=False)
        except Exception:
            v = str(v)
    return v[:maxlen]


def _j(v):
    if v is None:
        return None
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return None


def _tags(v) -> str:
    """标杆「分类」列的取值口径：core 可能给数组（["投资","ai"]）也可能给一串带逗号的分隔字面，
    两种都收，统一成「逗号分隔、单个 ≤16 字、最多 8 个、总长 ≤120」的一行文本。
    为什么不存 JSON：库里存数组，面板读要拆、排序要拼、本机排查用 sqlite 命令行还得再拆一遍 ——
    三层各拆一次必出错。标签本来就是给人看的几个字，一行文本是它唯一的形状。"""
    if v is None:
        return ""
    items = v if isinstance(v, (list, tuple)) else re.split(r"[,，;；\s]+", str(v))
    out = []
    for it in items:
        t = _txt(it, 16).strip().strip(",")
        if t and t not in out:
            out.append(t)
        if len(out) >= 8:
            break
    return _txt(",".join(out), 120)


_NUM_RE = re.compile(r"^[+-]?\d+(?:\.\d+)?$")


def _n(v):
    """只认纯数字串。'2.7K' / '10.1k' / '50 万' / '1,010' 一律 None ——
    缩写值存进库就成了「档案里写着 2.7 粉丝」这种假数据，而千分位在不同 locale 里点号逗号含义相反，
    我不想让库里出现要靠猜才读得懂的数。core 发来的都是已解析好的数字，走不到拒绝这条路。"""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() else v
    s = str(v).strip()
    if not _NUM_RE.match(s):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return int(f) if f.is_integer() else f


def rec_key(rec: dict) -> str:
    """内容哈希：把每次重发都会变的字段剔掉，保证「同一批重试」只入档一次。"""
    try:
        canon = {k: v for k, v in rec.items() if k not in ("receivedAt", "peer", "peer_host", "scriptVer")}
    except Exception:
        canon = {"u": id(rec)}
    try:
        s = json.dumps(canon, ensure_ascii=False, sort_keys=True, default=str)
    except Exception:
        s = str(canon)
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:24]


def _migrate(conn) -> None:
    """老库不会因为 CREATE TABLE IF NOT EXISTS 就长出 v0.7.0 的新列 —— 得显式补。
    只加列（ADD COLUMN），不动已有数据；PRAGMA 里已经有了就跳过，所以可以每次开库都跑。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tweets)")}
    if "liked" not in cols:
        conn.execute("ALTER TABLE tweets ADD COLUMN liked INTEGER")
    # v0.7.2 (db-4)：day_rows 拆 exposure（实时曝光）/effective（有效曝光）两列。
    # 库里已有的 exposure 全是奖励页那个数（或照它手补的）＝有效曝光 ⇒ 一次性搬进 effective、exposure 清空。
    # 幂等靠「列在不在」：搬完之后 exposure 恒为 NULL，再跑一遍 UPDATE 也不动任何行；
    # 视图里查不到 effective 说明还是旧定义，DROP 后重放 SCHEMA（IF NOT EXISTS，不会伤表）。
    # day_rows 不在（db-2 时代的库，表还没出生）就整段跳过 —— 生产路径 open_db 会先跑 SCHEMA 建表，
    # 这里防的是 _migrate 被单独调（自检就是）而不是只防 open_db。
    has_day_rows = bool(conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_rows'").fetchone())
    dcols = {r[1] for r in conn.execute("PRAGMA table_info(day_rows)")} if has_day_rows else {"effective"}
    if has_day_rows and "effective" not in dcols:
        conn.execute("ALTER TABLE day_rows ADD COLUMN effective INTEGER")
        conn.execute("UPDATE day_rows SET effective = exposure, exposure = NULL WHERE exposure IS NOT NULL")
    vsql = conn.execute("SELECT sql FROM sqlite_master WHERE type='view' AND name='day_latest'").fetchone()
    if vsql and "effective" not in (vsql[0] or ""):
        conn.execute("DROP VIEW day_latest")
        conn.execute("DROP VIEW IF EXISTS account_latest")   # account_latest 引着旧 day_latest，一起重建
        conn.executescript(SCHEMA)
    # v0.8.2 (db-5)：tweets 加 tl_src（这份快照拍到时主页时间线停在哪个 tab）。
    # 历史行就地回填：snapshots.stats JSON 里就有 __tabs，selected==='true' 那条的 text 是当时的 tab
    # （真机 2026-10-26：「为你推荐」/「正在关注」）。只回填一次（跟加列同一把 if），之后新行由 _page 直落。
    tcols = {r[1] for r in conn.execute("PRAGMA table_info(tweets)")}
    if "tl_src" not in tcols:
        conn.execute("ALTER TABLE tweets ADD COLUMN tl_src TEXT")
        _backfill_tl_src(conn)
    vsql = conn.execute("SELECT sql FROM sqlite_master WHERE type='view' AND name='post_points'").fetchone()
    if vsql and "tl_src" not in (vsql[0] or ""):
        for v in ("post_growth", "post_latest", "post_points", "account_latest"):
            conn.execute("DROP VIEW IF EXISTS " + v)
        conn.executescript(SCHEMA)
    # v0.8.4 (db-6)：blocks 表（IF NOT EXISTS，老库自己长出来）+ account_latest 加 blocked 列。
    # 视图定义变了（引了 blocked_now）⇒ 照 db-5 的判别法：视图 SQL 里没有 blocked 就全量重建。
    vsql = conn.execute("SELECT sql FROM sqlite_master WHERE type='view' AND name='account_latest'").fetchone()
    if vsql and "blocked" not in (vsql[0] or ""):
        for v in ("post_growth", "post_latest", "post_points", "account_latest"):
            conn.execute("DROP VIEW IF EXISTS " + v)
        conn.executescript(SCHEMA)
    conn.commit()


def _backfill_tl_src(conn) -> int:
    """从 snapshots.stats.__tabs 给已入档的 tweets 行补 tl_src。只补 tl_src IS NULL 的行，可重复跑。
    _migrate 可能被单独调在一张只有 tweets 的裸表上（自检就是）：snapshots 不在就没什么可回填的，安静跳过。"""
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshots'").fetchone():
        return 0
    n = 0
    for key, stats in conn.execute("SELECT key, stats FROM snapshots WHERE stats IS NOT NULL").fetchall():
        src = _tl_src_of_stats(stats)
        if not src:
            continue
        cur = conn.execute("UPDATE tweets SET tl_src = ? WHERE snap = ? AND tl_src IS NULL", (src, key))
        n += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    return n


def _tl_src_of_stats(stats_json) -> str:
    """__tabs 里 selected==='true' 那条的 text：为你推荐→foryou / 正在关注→following，认不出就空串。"""
    try:
        tabs = (json.loads(stats_json or "{}") or {}).get("__tabs") or []
    except Exception:
        return ""
    if not isinstance(tabs, list):
        return ""
    for t in tabs:
        if isinstance(t, dict) and t.get("selected") == "true":
            x = str(t.get("text") or "")
            if x == "为你推荐":
                return "foryou"
            if x == "正在关注":
                return "following"
            return ""
    return ""


def open_db(path) -> bool:
    with _LOCK:
        p = str(Path(path))
        if _DB["conn"] is not None and _DB["path"] == p:
            return True
        try:
            Path(p).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(p, check_same_thread=False, timeout=10.0)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(SCHEMA)
            _migrate(conn)
            conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('db_ver', ?)", (DB_VER,))
            cur = conn.execute("SELECT v FROM meta WHERE k='created_at'")
            row = cur.fetchone()
            if not row:
                conn.execute("INSERT INTO meta(k, v) VALUES('created_at', ?)", (_now(),))
            conn.commit()
            _DB.update(conn=conn, path=p, err="", fails=0, disabled=False)
            return True
        except Exception as e:
            _DB["err"] = "打开库失败: %s" % e
            _DB["conn"] = None
            return False


def is_available() -> bool:
    return _DB["conn"] is not None and not _DB["disabled"]


def is_empty() -> bool:
    if not is_available():
        return False
    try:
        return (_DB["conn"].execute("SELECT COUNT(*) FROM records").fetchone()[0] or 0) == 0
    except Exception:
        return False


def _put(conn, table: str, row: dict) -> int:
    """占位符由列名自己数出来 —— 手写 (?,?...) 与列表对不上是这类代码最常见的静默失败，
    而且它只在「插入子表」时炸，主表已经写进去了更像「数据没采到」。表名与列名都是我自己的字面量。"""
    cols = list(row.keys())
    sql = "INSERT OR IGNORE INTO %s(%s) VALUES(%s)" % (
        table, ",".join(cols), ",".join(["?"] * len(cols)))
    return conn.execute(sql, tuple(row[c] for c in cols)).rowcount or 0


def _page(conn, key: str, rec: dict, d: dict) -> None:
    at = _txt(rec.get("at") or rec.get("receivedAt"), 40)
    ident = d.get("identity") if isinstance(d.get("identity"), dict) else {}
    cov = rec.get("cov") if isinstance(rec.get("cov"), dict) else (d.get("cov") or {})
    cu = rec.get("covUsers") if isinstance(rec.get("covUsers"), dict) else (d.get("covUsers") or {})
    tweets = d.get("tweets") if isinstance(d.get("tweets"), list) else []
    users = d.get("users") if isinstance(d.get("users"), list) else []
    _put(conn, "snapshots", {
        "key": key, "at": at, "day": at[:10],
        "tab": _txt(rec.get("tabType") or d.get("tab"), 24),
        "handle": _txt(rec.get("handle") or ident.get("handle"), 60),
        "url": _txt(d.get("url") or rec.get("url"), 300),
        "host": _txt(rec.get("host"), 16),
        "ver": _txt(rec.get("ver") or rec.get("scriptVer"), 16),
        "build": _txt(rec.get("build"), 32),
        "title": _txt(d.get("title"), 120),
        "hydrated": 1 if d.get("hydrated") else 0,
        "attempt": _n(rec.get("attempt")),
        "articles": _n(cov.get("articles")), "ads": _n(cov.get("ads")),
        "tweets_n": len(tweets), "users_n": len(users),
        "users_scope": _txt(rec.get("usersScope") or d.get("usersScope"), 40),
        "user_cell_in_doc": _n(rec.get("userCellInDoc") or d.get("userCellInDoc")),
        "foreign_nodes": _n(d.get("foreignNodes")), "name_strip_all": _n(d.get("nameStripAll")),
        "cov": _j(cov), "cov_users": _j(cu), "miss": _j(rec.get("miss")), "note": _j(rec.get("note")),
        "identity": _j(ident), "stats": _j(d.get("stats")), "rewards": _j(d.get("rewards")),
        "cov_users_row": _n(cu.get("rows")), "name_how": _j(cu.get("nameHow")),
        "bytes": len(json.dumps({"tweets": tweets, "users": users}, ensure_ascii=False, default=str))})
    for t in tweets:
        if not isinstance(t, dict):
            continue
        _put(conn, "tweets", {
            "snap": key, "at": at, "idx": _n(t.get("idx")),
            "tweet_id": _txt(t.get("tweetId"), 40), "href": _txt(t.get("statusHref"), 200),
            "author": _txt(t.get("author"), 80), "author_name": _txt(t.get("authorName"), 120),
            "author_name_dirty": _txt(t.get("authorNameDirty"), 200), "text": _txt(t.get("text"), 400),
            "time_datetime": _txt(t.get("timeDatetime"), 40), "time_visible": _txt(t.get("timeVisible"), 60),
            "ad_suspect": 1 if t.get("adSuspect") else 0, "follow_state": _txt(t.get("followState"), 24),
            "has_photo": 1 if t.get("hasPhoto") else 0, "is_retweet": 1 if t.get("isRetweet") else 0,
            "summary_aria": _txt(t.get("summaryAria"), 160), "metrics": _j(t.get("metrics")),
            "author_tokens": _j(t.get("authorTokens")), "html": t.get("html"),
            "liked": 1 if t.get("liked") else 0, "tl_src": _txt(d.get("tlSrc"), 16) or None})
    for u in users:
        if not isinstance(u, dict):
            continue
        _put(conn, "user_rows", {
            "snap": key, "at": at, "idx": _n(u.get("idx")),
            "handle": _txt(u.get("handle"), 60), "name": _txt(u.get("name"), 120),
            "name_how": _txt(u.get("nameHow"), 24), "name_raw": _txt(u.get("nameRaw"), 200),
            "name_dirty": _txt(u.get("nameDirty"), 200), "origin": _txt(u.get("origin"), 12),
            "mod": _txt(u.get("mod"), 40), "follow_state": _txt(u.get("followState"), 24),
            "follow_aria": _txt(u.get("followAria"), 120), "has_bio": 1 if u.get("hasBio") else 0,
            "bio": _txt(u.get("bio"), 240), "cell_text": _txt(u.get("cellText"), 200),
            "name_foreign": _n(u.get("nameForeign")), "name_tokens": _j(u.get("nameTokens")),
            "leaf_shapes": _j(u.get("leafShapes")), "cands": _j(u.get("cands")), "html": u.get("html")})


def _day_row(key: str, at: str, handle: str, d: dict, manual: int, source: str) -> dict:
    """一条日点行的取值口径：v0.7.2 起曝光是两列 —— 走 value/exact/token（实时曝光）与 eff（有效曝光，
    奖励页 T+1，at 即落账时刻），其余三列走 fow/fans/posts（与 core 的日点行同名）。
    day 缺省时拿 `at` 的那天 —— 自动路径（打开主页顺手落一行）不带 day，只带「今天」。"""
    return {
        "key": key, "at": at, "day": _txt(d.get("day") or at[:10], 12), "handle": _txt(handle, 60),
        "exposure": _n(d.get("value")), "effective": _n(d.get("eff")), "exact": 1 if d.get("exact") else 0,
        "token": _txt(d.get("token"), 24), "following": _n(d.get("fow")),
        "followers": _n(d.get("fans")), "posts": _n(d.get("posts")),
        "manual": manual, "source": _txt(source, 24)}


def _simple(conn, key: str, rec: dict, d: dict) -> None:
    kind = rec.get("kind")
    at = _txt(rec.get("at") or rec.get("receivedAt"), 40)
    url = _txt(rec.get("url"), 300)
    if kind == "follow":
        _put(conn, "follow_events", {
            "key": key, "at": at, "day": at[:10], "handle": _txt(d.get("handle"), 60),
            "target_id": _txt(d.get("targetId"), 40), "dir": _txt(d.get("dir"), 12),
            "why": _txt(d.get("why"), 40), "src": _txt(d.get("from"), 40),
            "suspect": 1 if d.get("suspect") else 0,
            "tab": _txt(rec.get("tab") or d.get("tab"), 24), "url": url,
            "w15": _n(d.get("w15")), "max15": _n(d.get("max15")),
            "w24": _n(d.get("w24")), "max24": _n(d.get("max24")),
            "over15": 1 if d.get("over15") else 0, "over24": 1 if d.get("over24") else 0,
            "gap": _n(d.get("gap")), "rapid": 1 if d.get("rapid") else 0, "cool": _n(d.get("cool"))})
    elif kind == "stat":
        _put(conn, "stat_points", {
            "key": key, "at": at, "day": at[:10], "handle": _txt(d.get("handle"), 60),
            "following": _n(d.get("following")), "followers": _n(d.get("followers")),
            "exact": 1 if d.get("exact") else 0, "reason": _txt(d.get("reason"), 24),
            "vals": _j(d.get("vals")), "url": url})
    elif kind == "reward":
        _put(conn, "reward_points", {
            "key": key, "at": at, "own": _txt(d.get("own"), 60), "day": _txt(d.get("day"), 12),
            "value": _n(d.get("value")), "exact": 1 if d.get("exact") else 0,
            "token": _txt(d.get("token"), 24), "hit": 1 if d.get("hit") else 0,
            "added": 1 if d.get("added") else 0, "key_nodes": _n(d.get("keyNodes")),
            "text": _txt(d.get("text"), 200), "why": _txt(d.get("why"), 120),
            "cands": _j(d.get("cands")), "url": url})
        # 双写一份进 day_rows：自己的曝光/补录行在新表里也要有账，否则「排名」表里缺我自己。
        # reward 记录里的 value 是奖励页那个数 = 有效曝光 ⇒ 进 effective 列，exposure 留给分析页的实时曝光
        _put(conn, "day_rows", _day_row(key, at, _txt(d.get("own"), 60), dict(d, value=None, eff=d.get("value")),
                                        1 if d.get("manual") else 0, "reward"))
    elif kind == "dayrow":
        # v0.6.11：打开谁的主页就落谁的一行（handle 是「那个人」，不是登录者 own）
        _put(conn, "day_rows", _day_row(key, at, _txt(d.get("handle") or d.get("own"), 60), d,
                                        1 if d.get("manual") else 0, _txt(d.get("source"), 24) or "profile"))
    elif kind == "block":
        # v0.8.4 拉黑/取消：一行一事件（append-only），「现在还在不在」由 blocked_now 视图按最新一条判
        _put(conn, "blocks", {
            "key": key, "at": at, "day": at[:10], "handle": _txt(d.get("handle"), 60),
            "name": _txt(d.get("name"), 120), "state": 1 if d.get("on") else 0, "url": url})
    elif kind == "bench":
        # v0.9.0 标杆/取消/改标签：与 block 同一套 append-only，「现在在不在」由 bench_now 判。
        # 改标签走 on=1 + 新 tags 的**新行**，不改历史行：这个人的「进榜时刻」和「改分类时刻」是两个账，
        # 压成一行就只剩一个时间戳，以后想知道「TA 是哪天被我标成投资的」就没了。
        _put(conn, "benchmarks", {
            "key": key, "at": at, "day": at[:10], "handle": _txt(d.get("handle"), 60),
            "name": _txt(d.get("name"), 120), "state": 1 if d.get("on") else 0,
            "tags": _tags(d.get("tags")), "url": url})
    elif kind == "benchpost":
        # v0.9.3 标杆帖子：与 bench 同一套 append-only（进/出各一行），「现在在不在」由 bench_posts_now 判。
        # tweet_id 只认纯数字（页面 URL 抠出来的那串）；不是数字就整条不入库——「一条对不上任何帖子的标杆」
        # 以后没法查，比不入库更糟。author 允许空（详情页页头那颗拿得到发帖人，但纪律上不许它冒充 id）。
        tid = re.sub(r"\D", "", str(d.get("id") or ""))[:25]
        if not tid:
            return
        _put(conn, "bench_posts", {
            "key": key, "at": at, "day": at[:10], "tweet_id": tid,
            "author": _txt(re.sub(r"^[@/]", "", str(d.get("author") or "")), 60),
            "text": _txt(d.get("text"), 200), "state": 1 if d.get("on") else 0,
            "tags": _tags(d.get("tags")), "url": url})
    elif kind == "store":
        for u in (d.get("users") or []):
            if not isinstance(u, dict):
                continue
            _put(conn, "store_users", {
                "key": key, "at": at, "handle": _txt(u.get("h"), 60), "name": _txt(u.get("n"), 120),
                "followers": _n(u.get("f")), "following": _n(u.get("fw")),
                "exact": 1 if u.get("fe") else 0, "relation": _txt(u.get("rel"), 24),
                "own": 1 if u.get("own") else 0, "seen_as": _j(u.get("seenAs")),
                "pts": _n(u.get("pts"))})
        for p in (d.get("posts") or []):
            if not isinstance(p, dict):
                continue
            _put(conn, "store_posts", {
                "key": key, "at": at, "post_id": _txt(p.get("id"), 40), "handle": _txt(p.get("h"), 60),
                "text": _txt(p.get("t"), 200), "first_seen": _txt(p.get("fs"), 40),
                "reply": _n(p.get("rp")), "repost": _n(p.get("rt")), "like": _n(p.get("lk")),
                "view": _n(p.get("vw")), "n": _n(p.get("n"))})


def record_dump(name: str, meta: dict) -> None:
    """整页转储的文件落在 dump/ 里，库里只记「有哪几份、多大」，否则我没法回答「最新那份在哪」。"""
    with _LOCK:
        if not is_available():
            return
        try:
            at = _txt(meta.get("receivedAt") or _now(), 40)
            b = meta.get("bytes") or {}
            c = meta.get("counts") or {}
            _put(_DB["conn"], "dumps", {
                "name": name, "at": at, "day": at[:10], "tab": _txt(meta.get("tab"), 24),
                "handle": _txt(meta.get("handle"), 60), "url": _txt(meta.get("url"), 300),
                "tree_bytes": _n(b.get("tree")), "text_bytes": _n(b.get("text")),
                "html_bytes": _n(b.get("html")), "ms": _n(c.get("ms")),
                "emitted": _n(c.get("treeEmitted")), "nodes": _n(c.get("treeNodes")),
                "hit_cap": _txt(c.get("hitCap"), 120)})
            _DB["conn"].commit()
        except Exception as e:
            _fail(e)


def ingest(rec: dict, summary: str = "") -> int:
    """返回码见下面的常量：任何异常都吞掉（日志流不能断），但失败要留痕、和「不该入档」分开记。"""
    with _LOCK:
        if not is_available():
            return UNAVAIL
        try:
            if rec.get("t"):
                return SKIP_TEST
            key = rec_key(rec)
            kind = _txt(rec.get("kind") or "?", 24)
            at = _txt(rec.get("at") or rec.get("receivedAt"), 40)
            d = rec.get("data") if isinstance(rec.get("data"), dict) else {}
            conn = _DB["conn"]
            if kind == "page":
                slim = {k: v for k, v in rec.items() if k != "data"}
                slim["data"] = {k: v for k, v in d.items() if k not in ("tweets", "users")}
                slim["dataNote"] = "tweets/users 已拆进 tweets/user_rows 两张表，这里不重复存"
            else:
                slim = rec
            try:
                raw = json.dumps(slim, ensure_ascii=False, default=str)
            except Exception:
                raw = "{}"
            inserted = _put(conn, "records", {
                "key": key, "at": at, "rcvd": _txt(rec.get("receivedAt"), 40), "day": at[:10],
                "kind": kind, "host": _txt(rec.get("host"), 16),
                "peer_host": _txt(rec.get("peer_host"), 16),
                "tab": _txt(rec.get("tab") or rec.get("tabType"), 24),
                "handle": _txt(rec.get("handle") or d.get("handle") or d.get("own"), 60),
                "url": _txt(rec.get("url"), 300),
                "ver": _txt(rec.get("ver") or rec.get("scriptVer"), 16),
                "build": _txt(rec.get("build"), 32), "bytes": len(raw.encode("utf-8")),
                "summary": summary[:400], "raw": raw})
            if not inserted:
                _DB["duped"] += 1
                return DUP
            if kind == "page":
                _page(conn, key, rec, d)
            else:
                _simple(conn, key, rec, d)
            conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('last_write_at', ?)", (_now(),))
            conn.commit()
            _DB["ingested"] += 1
            _DB["fails"] = 0
            return NEW
        except Exception as e:
            _fail(e)
            try:
                _DB["conn"].rollback()
            except Exception:
                pass
            return FAIL


def _fail(e) -> None:
    _DB["fails"] += 1
    _DB["err"] = "%s: %s" % (type(e).__name__, e)
    if _DB["fails"] >= _MAX_FAILS:
        _DB["disabled"] = True
        _DB["err"] += "（连续失败 %d 回，库已停用；重启 sink 可恢复）" % _DB["fails"]


def _stats_locked() -> dict:
    out = {"available": is_available(), "path": _DB["path"], "dbVer": DB_VER, "err": _DB["err"],
           "fails": _DB["fails"], "ingested": _DB["ingested"], "duped": _DB["duped"],
           "tables": {}, "bytes": 0}
    if not is_available():
        return out
    try:
        conn = _DB["conn"]
        for t in _TABLES:
            out["tables"][t] = conn.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        pc = conn.execute("PRAGMA page_count").fetchone()[0] or 0
        ps = conn.execute("PRAGMA page_size").fetchone()[0] or 0
        out["bytes"] = int(pc) * int(ps)
        # 空闲页（VACUUM 能拿回来的量）单独报：476MB 的库里有多少是真数据、多少是压一压就回来的空页，
        # 是「该不该清」与「清了能省多少」的那一问。拿不到就留 None，面板不许把「未知」显示成 0。
        try:
            fl = conn.execute("PRAGMA freelist_count").fetchone()[0] or 0
            out["freeBytes"] = int(fl) * int(ps)
        except Exception:
            out["freeBytes"] = None
        out["minAt"] = conn.execute("SELECT MIN(at) FROM records").fetchone()[0]
        out["maxAt"] = conn.execute("SELECT MAX(at) FROM records").fetchone()[0]
        for row in conn.execute("SELECT k, v FROM meta"):
            out[row[0]] = row[1]
    except Exception as e:
        out["err"] = "stats: %s" % e
    return out


def stats() -> dict:
    with _LOCK:
        return _stats_locked()


def free_bytes():
    """库里空闲页可回收的字节（= VACUUM 大概能省多少）。库不可用返回 None：
    面板宁可显示「未知」，也不许把「量不到」报成「0，不用清」。"""
    if not is_available():
        return None
    try:
        with _LOCK:
            conn = _DB["conn"]
            fl = conn.execute("PRAGMA freelist_count").fetchone()[0] or 0
            ps = conn.execute("PRAGMA page_size").fetchone()[0] or 0
            return int(fl) * int(ps)
    except Exception:
        return None


def vacuum() -> dict:
    """整理库：把散落的空闲页压紧 —— 一行数据都不删，只回收空间（面板那颗「整理库」钮）。
    纪律：① VACUUM 不能在事务里跑，先 commit；② WAL 下别的进程占着写锁会抛
    「database is locked」，那是「现在别动」而不是「重试到成功」，一次就如实回话；
    ③ 前后各量一次 page_count×page_size，省了多少字节要拿数字说话，不能只说「已整理」。"""
    if not is_available():
        return {"ok": False, "err": "库不可用（%s）" % (_DB["err"] or "没连上 xprobe.db")}
    with _LOCK:
        conn = _DB["conn"]
        t0 = datetime.now()
        try:
            pc0 = conn.execute("PRAGMA page_count").fetchone()[0] or 0
            ps = conn.execute("PRAGMA page_size").fetchone()[0] or 0
            fl0 = conn.execute("PRAGMA freelist_count").fetchone()[0] or 0
            rows0 = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0] or 0
            conn.commit()                      # 不能在事务里 VACUUM
            conn.execute("VACUUM")
            conn.commit()
            pc1 = conn.execute("PRAGMA page_count").fetchone()[0] or 0
            rows1 = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0] or 0
            return {"ok": True, "before": int(pc0) * int(ps), "after": int(pc1) * int(ps),
                    "freed": max(0, (int(pc0) - int(pc1)) * int(ps)), "freePages": int(fl0) * int(ps),
                    "rowsBefore": rows0, "rowsAfter": rows1, "rowsKept": rows0 == rows1,
                    "ms": int((datetime.now() - t0).total_seconds() * 1000)}
        except Exception as e:
            return {"ok": False, "err": "%s: %s" % (type(e).__name__, str(e)[:120]),
                    "busy": "locked" in str(e).lower()}


def _after_int(v) -> int:
    """台账游标只认 0~2^63 的整数；坏形状抛 ValueError，由 query() 原样变成 400 的错误文案。
    为什么不夹到某个上限：游标是「本机写到哪儿」的实测值，不是用户输入的额度，夹了就是吞行。"""
    try:
        n = int(v) if v is not None and str(v) != "" else 0
    except (TypeError, ValueError):
        raise ValueError("after 要 >=0 的整数（台账 id 游标，缺省 0=从头）")
    if n < 0:
        raise ValueError("after 要 >=0 的整数（台账 id 游标，缺省 0=从头）")
    return n


def query(name: str, limit: int = 20, day: str = None, author: str = None,
          hours: int = None, win: tuple = None, after: int = None) -> dict:
    """只跑 QUERIES 白名单里写死的语句；limit 夹在 1..500，绝不接收外部 SQL。
    语句里有两个占位符的按查询各认各的第二参：tl_rank 吃 (day, limit)——day 缺省 = 今天，
    只挑 YYYY-MM-DD 形状；author_posts 吃 (author, limit)——只挑 handle 字符。
    bench_marks_ac / bench_marks_po 吃 (after, limit)——after 是台账 id 游标（0/缺省 = 从头），
    lib_users / lib_posts 同一套形状（after = store_users / store_posts 的自增 id，不是第几个业务键），
    lib_user_stat / lib_post_stat 只吃 after 一个（水位就是同步账，limit 对它们没有意义），
    形状不对就 400 说清楚：悄悄当成 0 等于把整本账重放一遍，那比报错糟。
    tl_win 吃三个占位符 (cut, up, limit)：hours（0=全部，1~87600 小时）或 win=(起日,止日) 二选一。"""
    if name not in QUERIES:
        return {"ok": False, "err": "未知查询 %r" % name, "available": list(QUERIES)}
    if name == "help":
        with _LOCK:
            return {"ok": True, "query": name, "rows": [{"name": k} for k in sorted(QUERIES) if k != "help"],
                    "db": _stats_locked()}
    if name == "tables":
        with _LOCK:
            return {"ok": True, "query": name, "rows": [], "db": _stats_locked()}
    # _LOCK 不是可重入锁：里面只能调不带锁的 _stats_locked，调 stats() 会当场把自己锁死
    with _LOCK:
        if not is_available():
            return {"ok": False, "err": _DB["err"] or "库未打开", "query": name}
        try:
            conn = _DB["conn"]
            sql = QUERIES[name]
            nph = sql.count("?")
            if nph == 2 and name in ("bench_marks_ac", "bench_marks_po", "lib_users", "lib_posts", "block_marks"):
                try:
                    cur = conn.execute(sql, (_after_int(after), limit))
                except ValueError as e:
                    return {"ok": False, "err": str(e), "query": name}
            elif nph == 1 and name in ("lib_user_stat", "lib_post_stat", "block_stat"):
                # 水位就是唯一的参数；这里不能走下面那条 nph==1 的 limit 通道（limit 是面板的窗口额度，不是游标）
                try:
                    cur = conn.execute(sql, (_after_int(after),))
                except ValueError as e:
                    return {"ok": False, "err": str(e), "query": name}
            elif nph == 2:
                if name == "author_posts":
                    a = str(author or "")
                    if not re.fullmatch(r"[A-Za-z0-9_]{1,20}", a):
                        return {"ok": False, "err": "author 参数要 1~20 位 handle 字符", "query": name}
                    cur = conn.execute(sql, (a, limit))
                else:
                    d = str(day or _now()[:10])
                    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
                        return {"ok": False, "err": "day 参数要 YYYY-MM-DD 形状", "query": name}
                    cur = conn.execute(sql, (d, limit))
            elif nph == 3 and name == "tl_win":
                f = win[0] if isinstance(win, tuple) and len(win) == 2 else None
                t2 = win[1] if isinstance(win, tuple) and len(win) == 2 else None
                day_re = re.compile(r"\d{4}-\d{2}-\d{2}")
                if (isinstance(f, str) and isinstance(t2, str) and day_re.fullmatch(f)
                        and day_re.fullmatch(t2) and f <= t2):
                    # 起止日是「本机时区的自然日」：起=当天 00:00、止=次日 00:00（左闭右开，毫秒也包得住），
                    # 再换算成 UTC 去比 —— 库里的 at 全是 core 的 toISOString()（UTC 带 Z，实测 0 条例外）
                    lo = datetime.strptime(f, "%Y-%m-%d").astimezone(timezone.utc)
                    hi = (datetime.strptime(t2, "%Y-%m-%d") + timedelta(days=1)).astimezone(timezone.utc)
                    cut, up = lo.strftime("%Y-%m-%dT%H:%M:%S"), hi.strftime("%Y-%m-%dT%H:%M:%S")
                else:
                    try:
                        hv = int(hours) if hours is not None else 24
                    except (TypeError, ValueError):
                        return {"ok": False, "err": "hours 要 0~87600 的整数", "query": name}
                    if hv < 0 or hv > 87600:
                        return {"ok": False, "err": "hours 要 0~87600 的整数", "query": name}
                    # 「最近 N 小时」按 UTC 算绝对时刻（库里 at 也是 UTC）；字符串直接比，切点不带 Z 正好卡在秒
                    cut = "0000-01-01T00:00:00" if hv == 0 else \
                        (datetime.now(timezone.utc) - timedelta(hours=hv)).strftime("%Y-%m-%dT%H:%M:%S")
                    up = "9999-12-31T23:59:59"
                cur = conn.execute(sql, (cut, up, limit))
            elif nph == 1:
                cur = conn.execute(sql, (limit,))
            else:
                cur = conn.execute(sql)
            cols = [c[0] for c in cur.description] if cur.description else []
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            return {"ok": True, "query": name, "cols": cols, "rows": rows, "db": _stats_locked()}
        except Exception as e:
            return {"ok": False, "err": "%s: %s" % (type(e).__name__, e), "query": name}


def backfill(logs_dir, log_fn=None, summarize=None) -> dict:
    """空库时从已经落盘的 ndjson 补档；已有数据也不影响（幂等），所以 --backfill 可以反复跑。
    summarize 由调用方把 log-sink 的 _summ 传进来 —— 补档的行也要有摘要，否则 /db?q=recent 里
    这批历史全是空白，等于「档案有了但我读不动」。"""
    d = Path(logs_dir)
    say = log_fn or (lambda s: sys.stdout.write(s + "\n"))
    out = {"files": 0, "lines": 0, "bad": 0, "ingested": 0, "duped": 0, "test": 0, "failed": 0}
    if not is_available():
        out["err"] = _DB["err"] or "库未打开"
        say("档案库不可用，跳过补档: %s" % out["err"])
        return out
    files = sorted([p for p in d.glob("*.ndjson") if not p.name.startswith("test-")])
    if not files:
        say("logs/ 下没有真机 ndjson，无可补档")
        return out
    started = datetime.now()
    for p in files:
        out["files"] += 1
        try:
            f = p.open("r", encoding="utf-8")
        except Exception as e:
            say("读不了 %s: %s" % (p.name, e))
            continue
        with f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                out["lines"] += 1
                try:
                    rec = json.loads(line)
                except Exception:
                    out["bad"] += 1
                    continue
                if not isinstance(rec, dict):
                    out["bad"] += 1
                    continue
                if rec.get("t"):
                    out["test"] += 1
                    continue
                summ = ""
                if summarize:
                    try:
                        summ = str(summarize(rec))[:400]
                    except Exception:
                        summ = ""
                r = ingest(rec, summ)
                if r == NEW:
                    out["ingested"] += 1
                elif r == DUP:
                    out["duped"] += 1
                elif r == FAIL:
                    out["failed"] += 1
                else:
                    out["err"] = _DB["err"] or "档案库中途不可用"
                    say("  补档中断：%s" % out["err"])
                    return out
        say("  补档 %s：累计入档 %s 条（重复 %s、自检 %s、坏行 %s、失败 %s）"
            % (p.name, out["ingested"], out["duped"], out["test"], out["bad"], out["failed"]))
    secs = (datetime.now() - started).total_seconds()
    st = stats()
    say("补档完成：%.1fs，库内 %s（%s 字节）%s"
        % (secs, json.dumps(st["tables"], ensure_ascii=False), st.get("bytes"),
           "  ⚠最后错误: " + str(st.get("err")) if st.get("err") else ""))
    if out["failed"]:
        say("  ⚠有 %s 条写失败：这些行不在库里，别把「库没数据」读成「没采到数据」" % out["failed"])
    return out


def _cli_default(sub: str) -> str:
    # 与 log-sink 同一套兜底（XPROBE_DIR → 作者历史目录存在则沿用 → ~/xprobe），别写死盘符
    legacy = Path(r"D:\code\yunxiao\temp\xprobe")
    base = Path(os.environ.get("XPROBE_DIR") or (legacy if legacy.parent.exists() else Path.home() / "xprobe"))
    return str(base / sub)


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=_cli_default("xprobe.db"))
    ap.add_argument("--logs", default=_cli_default("logs"))
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--query", default="")
    ap.add_argument("--limit", type=int, default=20)
    a = ap.parse_args()
    if not open_db(a.db):
        print("打不开库: %s" % _DB["err"])
        return 1
    if a.backfill:
        backfill(a.logs)
    if a.query:
        print(json.dumps(query(a.query, a.limit), ensure_ascii=False, indent=2)[:20000])
    else:
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

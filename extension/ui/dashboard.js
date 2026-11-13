// X 观测探针 · 工作台（dashboard.html 的脚本，v0.12.13 · art-032）
// 职责：把侧边栏里「数据密集」的四个视图（我的/广场/预测/诊断）搬到全页，
//       加 KPI 条与「数据源二选一」（本地库 / Go 接口）。
// 这里没有判定逻辑（core.js）、没有格式化逻辑（view.js——工作台直接 include 它，
// 行对象 k:line/row/chart/imps/rank/grid/hero/bar 的形状与面板完全同一份）。
// 本页也是扩展页面：只跟 chrome.runtime 与「数据源」说话，绝不请求 x.com（RL-2）。
// 决策记录（2026-11-12 用户拍板）：
//   决策一 = 数据源做成设置二选一：本地库（SW→宿主读 xprobe.db）或 Go 接口（同协议只读）；
//   决策二 = 延续「工程仪表台」暗色 token，布局结构抄「不是兄弟」dashboard；
//   决策三 = 侧边栏只留高频精简（首页/未回关/设置 + 打开工作台），诊断也搬进本页。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const V = globalThis.XPROBE_VIEW;
  // 版本戳与面板同规：⟳ 之后这页若还是旧值，说明文档没跟着换（Chrome 会继续跑旧 JS）
  const DASH_BUILD = '2026-11-13-e';
  const out = { err: '' };
  // v0.12.14（art-033）：渲染层/发送通道抽进 ui/kit.js 共用；页面差异由 create(deps) 注入——
  // 工作台比面板多注入 one()（数据源二选一的取数通道），作者模态框/时间线选天都走它。
  const K = globalThis.XPROBE_KIT.create({ pageLabel: '工作台', render: render, fetchDb: fetchDb, one: one, getSt: () => st });
  const send = K.send;
  let st = null, lastStateAt = 0, dview = 'home', stateSeq = 0, stateDone = 0;

  // ---------- 数据源（v0.12.15 改版）：'db' 本地库 / 'cloud' 云端 ----------
  // 红线「读口本地/云端同形」（RL-33）：同名 POST 端点、只换 baseURL；云端档二选一（线上/开发）走前端智枢 zhishu-web 网关转发到 Go，
  // 地址写死在 SW 的 DASH_CLOUD_ENVS 枚举（prod/dev 两 key，拼不出第三个）；登录态按档分格、token 只回本页。
  // 对齐一版清单（CLOUD_MAP）：accounts→library/accounts、follow_starts→me/following、day_rows→me/days、
  // author_posts→library/posts、posts_top→space/posts。未进清单的查询云端档如实报差异（决策3C）：
  // posts_growth/tl_days/tl_rank 云端不采集（PG 未存对应序列/分源）——本地档看得到；其余回退「还没对齐」文案。
  // 绝不拿本地数据冒充（RL-11）；新条目必须两边同趟落（RL-33）。
  let dashSrc = 'db', dashConf_ = null, srcNote = '';
  const DASH_LOCAL_BASE = 'http://127.0.0.1:8765';   // 本机 sink：POST /api/xprobe/{name} 与云端同名同参
  // 决策3C（v0.12.19）：云端不采集的查询点名差异，不谎称「下一版对齐」。
  const CLOUD_NO = (q) => {
    const why = { posts_growth: 'PG 未存帖子按小时增速序列（view_per_h）', tl_days: 'PG 未存时间线分源（tl_src）聚合', tl_rank: 'PG 未存时间线分源榜单' };
    const msg = why[q] ? ('云端不采集：' + why[q] + '，云端不采集（本地库档看得到）') : ('云端暂无：' + q + ' 这条读口还没对齐（本地库档看得到；两边同趟加见 API-CONTRACT §2.3）');
    return { ok: false, err: msg, rows: [] };
  };

  function loadConf() {
    return send({ t: 'dashConf' }).then((c) => {
      if (c && c.ok) dashConf_ = c;
      return c;
    });
  }
  function loadSrc() {
    return new Promise((res) => {
      try {
        chrome.storage.local.get(['ysy.xprobe.dashSrc'], (o) => {
          dashSrc = (o && o['ysy.xprobe.dashSrc'] === 'db') ? 'db' : 'cloud';   // v0.12.16：默认云端（用户口径「默认是云端线上版本」）
          loadConf().then(() => res(), () => res());
        });
      } catch (e) { res(); }
    });
  }
  function saveSrc() {
    try { chrome.storage.local.set({ 'ysy.xprobe.dashSrc': dashSrc }); } catch (e) { /* 存不了就只当次有效 */ }
  }
  function setSrc(s) {
    dashSrc = (s === 'cloud') ? 'cloud' : 'db';
    srcNote = '';
    saveSrc();
    syncSrcUi();
    db = null; dbAt = 0;
    render();
    if (needsDb()) fetchDb(true);
  }
  void setSrc;   // v0.12.16 起切换走 askConfirm；入口保留给判据与未来批量动作
  function setEnv(e) {
    return send({ t: 'dashEnvSet', env: e }).then((c) => {
      if (!c || !c.ok) { out.err = (c && c.err) || '切档没成'; render(); return; }
      dashConf_ = c;
      db = null; dbAt = 0;
      render();
      if (needsDb()) fetchDb(true);
    });
  }
  function syncSrcUi() {
    const on = (id, yes) => { const el = $(id); if (el) el.classList.toggle('on', !!yes); };
    on('dSrcDb', dashSrc === 'db'); on('dSrcCloud', dashSrc === 'cloud');
    const seg2 = $('dEnvSeg');
    if (seg2) seg2.classList.toggle('hide', dashSrc !== 'cloud');
    const lb = $('dLogin');
    if (lb) {
      lb.classList.toggle('hide', dashSrc !== 'cloud');
      const logged = !!(dashConf_ && dashConf_.logged);
      lb.textContent = logged ? '退出' : '登录';
      lb.title = logged ? ('当前档：' + (dashConf_.label || '') + '（' + (dashConf_.email || '') + '）—— 点这颗退出这一档')
        : '云端档要一把智枢自己的登录态（邮箱验证码；与上送那把 boot4 token 不是同一把）';
    }
    const lamp = $('dLamp');
    if (lamp && dashSrc === 'cloud' && dashConf_) {
      lamp.className = dashConf_.logged ? '' : 'bad';
      lamp.textContent = (dashConf_.label || '') + (dashConf_.logged ? ' · 已登录' : ' · 未登录');
      lamp.title = dashConf_.base + '（前端智枢网关转发到 Go；dev/prod 的登录各存各的）';
    }
  }

  // 统一读口 qRead（RL-33）：同名 POST 端点只换 baseURL；云端回包是智枢 Result 信封 {code,message,data} 摊平，本地回包本来就是 {ok, rows}。
  // base：本地 = 127.0.0.1:8765（sink），云端 = dashConf 给的档位地址（prod/dev）。
  function qRead(name, bodyObj) {
    const cloud = dashSrc === 'cloud';
    const base = cloud ? ((dashConf_ && dashConf_.base) || '') : DASH_LOCAL_BASE;
    const headers = { 'Content-Type': 'application/json' };
    if (cloud && dashConf_ && dashConf_.token) headers.token = dashConf_.token;
    if (cloud && !dashConf_) return Promise.resolve({ ok: false, err: '云端档地址还没读到（刷新一次）', rows: [] });
    return new Promise((res) => {
      try {
        fetch(base + '/api/xprobe/' + name, {
          method: 'POST', headers: headers, credentials: 'omit',
          body: JSON.stringify(bodyObj || {}),
        }).then((r) => r.json()).then((b) => {
          if (!cloud) {
            if (!b || b.ok === false) res(Object.assign({ ok: false, err: String((b && b.err) || '查询被拒') }, b));
            else res(b);
            return;
          }
          if (b && b.code === 403) res({ ok: false, needLogin: true, err: '这一档还没登录或票据失效（右上角重新登录）', rows: [] });
          else if (!b || b.code !== 200) res({ ok: false, err: (b && b.message) ? String(b.message).slice(0, 120) : '云端没认（code ' + (b && b.code) + '）', rows: [] });
          else res({ ok: true, data: b.data });
        }).catch((e) => res({ ok: false, err: (cloud ? '云端没连上：' : '本机 sink 没连上：') + String((e && e.message) || e).slice(0, 80) + '（' + base + '）' }));
      } catch (e) { res({ ok: false, err: String((e && e.message) || e).slice(0, 100) }); }
    });
  }

  // 白名单查询名 → 同形云端端点（对齐一版清单）：db 档走 SW dbq，cloud 档走 qRead + 行映射成本机形状（缺数 null，RL-11）。
  // one() 的形状对 view.js 透明：cloud 档失败也把 via:'cloud' 带回去（RL-11 不装作不知道）。
  const CLOUD_MAP = {
    // sort:'eng' 是 2026-11-13 补的：本机 accounts 查询是「eng 降序、没数垫底、handle 升序兜底」
    // （xprobe_db.py），云端 library/accounts 默认却是老站的 last_seen 降序 —— 两档取的不是同一批人，
    // 同一个「账号排名·按曝光」榜在本机档和云端档根本没法比（RL-33 读口同形）。
    // Go 侧 sort='eng' 的排序键 = 采到帖子的互动合计，与本机 account_latest 的 eng 子查询同口径。
    accounts: { name: 'library/accounts', body: (limit) => ({ size: limit, sort: 'eng' }) },
    follow_starts: { name: 'me/following', body: (limit) => ({ size: limit }) },
    day_rows: { name: 'me/days', body: () => ({}) },
    author_posts: { name: 'library/posts', body: (limit, x) => ({ author: (x && x.author) || '', size: limit }) },
    // 决策4-①（v0.12.19）：曝光榜映射到观测台已有的 space/posts（全站按曝光降序）；Go 回包把数组包在 records 里。
    posts_top: { name: 'space/posts', body: (limit) => ({ size: limit, sort: 'view', dir: 'desc', day: 'all', page: 1, tz: 0 }) },
  };
  function mapCloudRows(q, data) {
    const rows = (data && Array.isArray(data.rows)) ? data.rows
      : (data && Array.isArray(data.records)) ? data.records   // 观测台 space/posts 把数组包在 records 里
      : (Array.isArray(data) ? data : []);
    if (q === 'accounts') {
      // 云端 library/accounts 字段：handle / displayName / views / eng / fans / fow / postsN / lastPostAt
      // （与本地 x_observe_account 同名不同形）—— 保留这些真字段，只补本地专用计算列并置空（RL-11 不编）。
      //
      // 2026-11-13：postsN 现在有真值了（Go 侧按「采到的帖子行」求和补的，与本机 account_latest 同口径）。
      // 但本机那两个列含义不同：posts = 总帖数（来自日点表）、posts_n = 采到的帖数。
      // 云端只采到后者 → posts 留空、posts_n 给真值，让页面照本机的规矩标「~」（近似），别拿
      // 采到的条数冒充总帖数（RL-11 缺数不编）。
      return rows.map((r) => Object.assign({}, r, {
        name: r.displayName != null ? r.displayName : null,
        handle: r.handle != null ? r.handle : null,
        last_post_at: r.lastPostAt != null ? r.lastPostAt : null,
        posts: null,
        posts_n: r.postsN != null ? r.postsN : null,
        own: 0, relation: '', relation_at: null, day: null, exposure: null,
        effective: null, token: null, seen_at: null, blocked: 0, blocked_at: null,
      }));
    }
    if (q === 'follow_starts') {
      return rows.map((r) => Object.assign({}, r, { handle: r.target != null ? r.target : r.handle,
        follow_at: r.at != null ? r.at : r.follow_at, relation: '', seen_as: '' }));
    }
    if (q === 'posts_top') {
      // 云端 space/posts 字段名与本地 post_growth 不同：xPostId→tweet_id、authorHandle→author、likeCount→like；
      // repost/quote/bookmark/eng_rate/view_per_h 等本地计算列云端没有，补 null（RL-11，不编）。
      return rows.map((r) => Object.assign({}, r, {
        tweet_id: r.xPostId != null ? r.xPostId : null, author: r.authorHandle != null ? r.authorHandle : null,
        text: r.textSnapshot != null ? r.textSnapshot : null, last_at: r.postedAt != null ? r.postedAt : null,
        view: r.view != null ? r.view : null, like: r.likeCount != null ? r.likeCount : null,
        reply: r.reply != null ? r.reply : null, eng: r.eng != null ? r.eng : null,
        repost: null, quote: null, bookmark: null, liked: null, eng_rate: null, like_rate: null,
        view_per_h: null, view_gain: null, hours: null, like_gain: null, points: null,
      }));
    }
    if (q === 'day_rows') return rows.map((r) => Object.assign({}, r, { token: r.token != null ? r.token : null }));
    return rows;
  }
  function one(q, limit, extra) {
    if (dashSrc !== 'cloud') {
      return send({ t: 'dbq', q: q, limit: limit, day: (extra && extra.day), author: (extra && extra.author),
        hours: (extra && extra.hours === undefined ? undefined : extra.hours) });
    }
    const m = CLOUD_MAP[q];
    if (!m) return Promise.resolve(Object.assign({ via: 'cloud' }, CLOUD_NO(q)));
    return qRead(m.name, m.body(limit, extra)).then((r) => {
      // 失败也把 via 带回去：否则面板那条诊断会把「云端没连上」显示成「通道 未定」（RL-11 不装作不知道）。
      if (!r.ok) return { ok: false, err: r.err || '云端没回数', needLogin: !!r.needLogin, rows: [], via: 'cloud' };
      return { ok: true, rows: mapCloudRows(q, r.data), via: 'cloud' };
    });
  }

  // ---------- 云端登录（邮箱验证码）：SW 只收 email/code、按档分格落盘，token 明文只回本页 ----------
  let login = null;   // null 关；{ step:'email'|'code', email, note }
  function openLogin() { login = { step: 'email', email: '', note: '' }; render(); }
  function closeLogin() { login = null; render(); }
  function loginModalNode() {
    const wrap = document.createElement('div'); wrap.id = 'dLoginWrap';
    const card = document.createElement('div'); card.className = 'dLoginCard';
    const h = document.createElement('div'); h.className = 'dLoginH';
    h.textContent = '云端登录（' + ((dashConf_ && dashConf_.label) || '') + '）';
    const p = document.createElement('div'); p.className = 'dLoginP';
    p.textContent = '用邮箱验证码登录智枢（zhishu）。开发/线上两档各存各的，切档不继承；boot4 退役后全插件只有这一把云端票据。';
    const inp = document.createElement('input'); inp.type = 'text';
    inp.placeholder = login.step === 'email' ? '邮箱' : '邮箱里收到的验证码';
    const note = document.createElement('div'); note.className = 'dLoginNote';
    const row = document.createElement('div'); row.className = 'dLoginRow';
    const b1 = document.createElement('button'); b1.type = 'button';
    b1.textContent = login.step === 'email' ? '发验证码' : '登录';
    const b2 = document.createElement('button'); b2.type = 'button'; b2.textContent = '关闭';
    b2.addEventListener('click', closeLogin);
    b1.addEventListener('click', () => {
      const v = String(inp.value || '').trim();
      if (login.step === 'email') {
        b1.disabled = true; note.textContent = '发码中……';
        send({ t: 'dashSendCode', email: v }).then((r) => {
          if (r && r.ok) { login = { step: 'code', email: v, note: '验证码已发到 ' + v }; }
          else { b1.disabled = false; note.textContent = (r && r.err) || '发码没成'; }
          render();
        });
        return;
      }
      b1.disabled = true; note.textContent = '登录中……';
      send({ t: 'dashLogin', email: login.email, code: v }).then((r) => {
        if (r && r.ok) {
          login = null;
          loadConf().then(() => {
            srcNote = '云端已登录：' + ((dashConf_ && dashConf_.email) || '') + '（' + ((dashConf_ && dashConf_.label) || '') + '档）—— 数据改读这一档的云端库';
            db = null; dbAt = 0; render(); if (needsDb()) fetchDb(true);
          });
        } else { b1.disabled = false; note.textContent = (r && r.err) || '登录没成'; render(); }
      });
    });
    row.append(b1, b2);
    card.append(h, p, inp, note, row);
    wrap.append(card);
    return wrap;
  }

  // ---------- 与 SW 的消息通道（与 sidepanel.js 同一套孤儿面板/休眠 SW 的处置话术） ----------
  function refreshState() {
    stateSeq += 1;
    const seq = stateSeq;
    return send({ t: 'state' }).then((r) => {
      if (r.state && seq > stateDone) { st = r.state; lastStateAt = Date.now(); stateDone = seq; }
      out.err = r.ok ? '' : (r.err || '没回话');
      render();
      return r;
    });
  }

  // 本机库（与 sidepanel.js fetchDb 同一套口径，数据源按设置二选一）：每次 sendNativeMessage 都会新起一个宿主进程；一批并行发、15 秒内不重读。
  // Go 接口那路只在「应用」/切源时发；地址不合法时如实报错不猜（RL-11）。
  let db = null, dbBusy = false, dbAt = 0;
  let qKeep = null;   // 查表结果存模块变量、render() 重放（UIX-18；面板/工作台同一套机制）

  function fetchDb(force) {
    if (dbBusy) return Promise.resolve(db);
    if (!force && db && Date.now() - dbAt < 15000) return Promise.resolve(db);
    dbBusy = true;
    const t0 = Date.now();
    const settle = () => { dbBusy = false; dbAt = Date.now(); };
    // 第一波：账号 + 关注（快，本地/云端都毫秒级）→ 先出账号榜，不再干等慢的帖子榜（云端要跨网络到线上 PG 全表扫描）
    return Promise.all([one('accounts', 50), one('follow_starts', 50)]).then((rs) => {
      const a = rs[0] || {}, fbs = rs[1] || {};
      db = {
        at: Date.now(), ms: Date.now() - t0,
        id: a.id || '', via: a.via || (dashSrc === 'cloud' ? 'cloud' : ''),
        native: a.native === undefined ? undefined : (a.native || null),
        acct: { ok: !!a.ok, rows: Array.isArray(a.rows) ? a.rows : [], err: a.ok ? '' : (a.err || '没回包') },
        post: { ok: false, rows: [], err: '帖子榜加载中…' },   // 第二波填
        tlDays: { ok: false, rows: [], err: '' }, tl: { ok: false, rows: [], err: '' },
        followStarts: { ok: !!fbs.ok, rows: Array.isArray(fbs.rows) ? fbs.rows : [], err: fbs.ok ? '' : (fbs.err || '没回包') },
      };
      render();
      // 第二波：帖子榜（慢）+ 时间线聚合（云端不采集 tl_* 时即时回 CLOUD_NO，不拖时长）
      return Promise.all([one('posts_top', 50), one('posts_growth', 50),
        one('tl_days', 60), one('tl_rank', 50, { day: K.sorts().tlDay })]).then((rs2) => {
        const top = rs2[0] || {}, gr = rs2[1] || {}, tld = rs2[2] || {}, tlr = rs2[3] || {};
        const byId = {}, prows = [];
        (Array.isArray(top.rows) ? top.rows : []).forEach((r) => {
          if (r && r.tweet_id && !byId[r.tweet_id]) { byId[r.tweet_id] = r; prows.push(r); }
        });
        (Array.isArray(gr.rows) ? gr.rows : []).forEach((r) => {
          if (!r || !r.tweet_id) return;
          const cur = byId[r.tweet_id];
          if (!cur) { byId[r.tweet_id] = r; prows.push(r); return; }
          ['view_gain', 'hours', 'view_per_h', 'like_gain'].forEach((k) => { if (r[k] != null) cur[k] = r[k]; });
        });
        db.at = Date.now(); db.ms = Date.now() - t0;
        db.post = { ok: !!top.ok, rows: prows, err: top.ok ? '' : (top.err || '没回包') };
        db.tlDays = { ok: !!tld.ok, rows: Array.isArray(tld.rows) ? tld.rows : [], err: tld.ok ? '' : (tld.err || '没回包') };
        db.tl = { ok: !!tlr.ok, rows: Array.isArray(tlr.rows) ? tlr.rows : [], err: tlr.ok ? '' : (tlr.err || '没回包') };
        if (!K.sorts().tlDay && db.tlDays.ok && db.tlDays.rows.length) K.setTlDay(db.tlDays.rows[0].day);
        render();
      }).finally(settle);
    }).finally(settle);
  }
  function needsDb() { return !!PAGE.needsDb; }   // 每个页面自己声明要不要读数据源（注册时给）

  // ---------- 节点渲染器（与 sidepanel.js 同一份的复制：行对象 → DOM；不改格式化层） ----------
  // v0.12.14（art-033）：摘要框家族（digestBox/digestEl 复用/评论数按天记/copyText）抽进 ui/kit.js 共用。

  // ---------- KPI 条（4 枚 mini-stat；口径在 title 与脚注，RL-11：没数写 — 不编） ----------
  // ---------- 公共壳 v0.12.17（art-035）：页面渲染全部由 ui/dash/page-*.js 注册 ----------
  // 高内聚低耦合：这个文件只管状态、取数、页签菜单、弹窗与节奏；每个页面自己的行/工具条住在自己那一个短文件里。
  const PAGE = { key: 'home', needsDb: true, render: null, kpis: null };
  const TABS = [
    { key: 'home', file: 'home.html', txt: '概览', tip: '概览：今日四列、未回关 KPI、最该关注/取关建议' },
    { key: 'mine', file: 'mine.html', txt: '我的', tip: '我自己的历史：分钟线 / 曝光日线 / 三四列日线 + 可编辑日点表' },
    { key: 'plaza', file: 'plaza.html', txt: '广场', tip: '账号榜 + 帖子榜 + 时间线曝光榜 + 最该关注/取关建议' },
    { key: 'fc', file: 'fc.html', txt: '预测', tip: '粉丝数折线 + 到 5,000 / 10,000 的两条外推' },
    { key: 'debug', file: 'debug.html', txt: '诊断', tip: '读数质量、通道状态、查表、漏抓清单与原文折叠' },
    { key: 'set', file: 'set.html', txt: '设置', tip: '数据来源（云端/本地库）、云端档（线上/开发）、登录；改动一律二次确认' },
  ];
  function renderTabs() {
    const nav = $('dTabs');
    if (!nav) return;
    nav.textContent = '';
    const here = String(location.pathname || '').split('/').pop() || 'home.html';
    TABS.forEach((t) => {
      const a = document.createElement('a');
      a.href = t.file;                    // 本页打开：普通 <a>，不新开标签页
      a.textContent = t.txt; a.title = t.tip;
      a.id = 'dTab' + t.key.charAt(0).toUpperCase() + t.key.slice(1);
      a.className = here === t.file ? 'on' : '';
      a.setAttribute('role', 'tab');
      if (here === t.file) a.setAttribute('aria-selected', 'true');
      nav.append(a);
    });
  }
  const API = {
    $: $, V: V, K: K, send: send, out: out,
    getState: () => st, getDb: () => db, getSrc: () => dashSrc, getConf: () => dashConf_,
    getLastStateAt: () => lastStateAt, getQKeep: () => qKeep, setQKeep: (v) => { qKeep = v; },
    setNote: (t) => { srcNote = t; }, resetDb: () => { db = null; dbAt = 0; },
    fetchDb: fetchDb, refreshState: refreshState, render: render,
    loadConf: loadConf, setEnv: setEnv, saveSrc: saveSrc, syncSrcUi: syncSrcUi,
    askConfirm: askConfirm, openLogin: openLogin, closeLogin: closeLogin,
    syncWho: syncWho, setSrc: setSrc,
  };
  globalThis.XPROBE_DASH = {
    register: function (key, opts) {
      PAGE.key = key; PAGE.needsDb = !!opts.needsDb;
      PAGE.render = opts.render || null; PAGE.kpis = opts.kpis || null;
    },
    core: API,
  };

  function doView(root) {
    if (PAGE.render) PAGE.render(root, API);
    if (PAGE.key === 'plaza' && K.tlUserActive()) root.append(K.tlUserModalNode());
    if (login) root.append(loginModalNode());
    if (confirm_) root.append(confirmModalNode());
  }

  function render() {
    const root = $('report');
    root.textContent = '';
    const errBox = $('dErr');
    if (errBox) errBox.textContent = out.err || '';
    doView(root);
    if (PAGE.kpis) PAGE.kpis(API); else { const k = $('dKpis'); if (k) k.textContent = ''; }
    syncWho();
    renderFoot();
  }
  function renderFoot() {
    const f = $('dFoot');
    if (!f) return;
    let ver = '';
    try { ver = 'v' + chrome.runtime.getManifest().version + ' · ' + DASH_BUILD; } catch (e) { ver = DASH_BUILD; }
    const srcTxt = dashSrc === 'cloud'
      ? ('数据源：云端 · ' + ((dashConf_ && dashConf_.label) || '') + '（' + ((dashConf_ && dashConf_.base) || '') + '，前端智枢网关转发到 Go）')
      : '数据源：本地库（SW → 原生宿主读 xprobe.db；宿主不在时回退本机 HTTP sink）';
    f.textContent = '';
    const l1 = document.createElement('div');
    l1.textContent = (srcNote ? srcNote + '　|　' : '') + srcTxt + ' · ' + ver + ' · 只读观测：本页不请求 x.com、不点页面任何东西';
    const l2 = document.createElement('div');
    l2.textContent = '口径：未回关 = follow_starts 查询 follow_back=no（unknown 是没读到，不算）；榜 = accounts/posts_top/posts_growth；今日关注 = 面板「今日目标」同一本账。没有的数据写 — 不编数。';
    f.append(l1, l2);
  }

  // ---------- 「看谁」（v0.6.12 随广场搬进工作台）：视线只在广场页签换人，其余页签一律回 own ----------
  // state 每次回读的 series 都是 own 那份（core 的默认视线），广场选中别人时补一趟 seriesView 把视线换过去；
  // 从广场（看着别人）切回别的页签，若视线还挂在他身上，概览那张「今日四列」就报成了他的账号。
  let whoSel = '';
  function whoTarget() {
    const own = (st && st.series && st.series.own) || '';
    return dview === 'plaza' ? (whoSel || own) : own;
  }
  function applyWho() {
    if (!st || !st.series) return Promise.resolve();
    const want = whoTarget();
    if (!want || st.series.key === want) return Promise.resolve();
    return send({ t: 'seriesView', v: { handle: want } }).then((r) => {
      // send 不动 st：回包里的 series 就是「换过去的那份」，接住重画
      if (r.ok && r.result) { st.series = r.result; render(); }
    });
  }
  // 下拉的料来自 st.series.handles（core 按 updatedAt 排好、自己在最前）。
  // 选中的人被序列上限挤掉了就自动回到自己 —— 留着一个不存在的 handle 会让下面所有表都空着，最难查
  function syncWho() {
    const sel = $('whoPick');
    if (!sel) return;
    sel.classList.toggle('hide', dview !== 'plaza');   // 「看谁」只在广场页签有意义
    const hs = (st && st.series && st.series.handles) || [];
    if (whoSel && !hs.some((h) => h.h === whoSel)) whoSel = '';
    sel.textContent = '';
    const o0 = document.createElement('option');
    o0.value = ''; o0.textContent = '（只看排名）';
    sel.append(o0);
    hs.forEach((h) => {
      if (h.own) return;
      const o = document.createElement('option');
      o.value = h.h;
      o.textContent = '@' + h.h + ' 日' + h.imp + (h.min ? ' 分' + h.min : '');
      sel.append(o);
    });
    sel.value = whoSel || '';
    sel.disabled = hs.filter((h) => !h.own).length === 0;
    sel.title = sel.disabled ? '序列里只有自己：多开几个别人的主页就会各落一行（广场的日点表按人记）'
      : '选谁就在下面看谁、编辑谁（只影响广场；自己的历史在「我的」页签）';
  }

  // ---------- 设置页签（v0.12.16）：数据源 / 云端档 / 登录都归置到这里；改动一律二次确认 ----------
  // 用户口径：默认云端线上；切源/切档/退出登录都要再按一下确认，不许一颗钮当场翻账。
  let confirm_ = null;   // null 关；{ what:'src'|'env'|'logout', to:'db'|'cloud'|'prod'|'dev', note }
  function askConfirm(what, to, note) { confirm_ = { what: what, to: to, note: note || '' }; render(); }
  function confirmModalNode() {
    const wrap = document.createElement('div'); wrap.id = 'dConfirmWrap';
    const card = document.createElement('div'); card.className = 'dLoginCard';
    const h = document.createElement('div'); h.className = 'dLoginH'; h.textContent = '确认切换？';
    const p = document.createElement('div'); p.className = 'dLoginP'; p.textContent = confirm_.note;
    const row = document.createElement('div'); row.className = 'dLoginRow';
    const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = '确认切换';
    const no = document.createElement('button'); no.type = 'button'; no.textContent = '再想想';
    ok.addEventListener('click', () => {
      const c = confirm_; confirm_ = null;
      if (c.what === 'src') { dashSrc = (c.to === 'cloud') ? 'cloud' : 'db'; srcNote = ''; saveSrc(); syncSrcUi(); db = null; dbAt = 0; render(); if (needsDb()) fetchDb(true); }
      else if (c.what === 'env') { setEnv(c.to); }
      else if (c.what === 'logout') {
        send({ t: 'dashLogout' }).then(() => loadConf()).then(() => { db = null; dbAt = 0; srcNote = '已退出这一档的登录'; render(); if (needsDb()) fetchDb(true); });
      }
    });
    no.addEventListener('click', () => { confirm_ = null; render(); });
    row.append(ok, no);
    card.append(h, p, row);
    wrap.append(card);
    return wrap;
  }
  function segRow(label, ids, cur, onPick) {
    const row = document.createElement('div'); row.className = 'dSetRow';
    const lab = document.createElement('span'); lab.className = 'dSetLab'; lab.textContent = label;
    const seg = document.createElement('span'); seg.className = 'dSetSeg';
    ids.forEach((it) => {
      const b = document.createElement('button'); b.type = 'button'; b.id = it.id;
      b.textContent = it.txt; b.title = it.tip || '';
      if (cur === it.val) b.className = 'on';
      b.addEventListener('click', () => { if (cur !== it.val) onPick(it.val, it); });
      seg.append(b);
    });
    row.append(lab, seg);
    return row;
  }
  function setViewNode() {
    const box = document.createElement('div'); box.className = 'dSet';
    const logged = !!(dashConf_ && dashConf_.logged);
    const h = document.createElement('div'); h.className = 'dSetH'; h.textContent = '数据源';
    box.append(h);
    box.append(segRow('数据来源', [
      { val: 'cloud', id: 'dSrcCloud', txt: '云端', tip: '读智枢 Go（线上/开发都走前端智枢 zhishu-web 的 /api/xprobe/* 网关）：同名 POST 读口、参数与本地库一致，只换地址（红线 RL-33）' },
      { val: 'db', id: 'dSrcDb', txt: '本地库', tip: '读本机 xprobe.db：SW → 原生宿主（宿主不在时回退本机 HTTP sink）。SQL 全在宿主白名单里' },
    ], dashSrc, (v) => askConfirm('src', v,
      v === 'cloud' ? '切到云端：数据改读智枢 PG（本机 xprobe.db 一个字不动）。这一档要先登录。' : '切回本地库：数据改读本机 xprobe.db。切换后两边的榜单/名单各自独立。')));
    const envRow = segRow('云端档', [
      { val: 'prod', id: 'dEnvProd', txt: '线上', tip: 'zhishu.mingzhang.cc（前端智枢网关 → 服务器上的 Go 容器；Go 只绑服务器回环，外网摸不到）' },
      { val: 'dev', id: 'dEnvDev', txt: '开发', tip: '本机 zhishu-web dev（localhost:3100，pnpm dev）→ 本机 Go；但 dev Go 连的就是线上 PG，两档数据同源、登录各存各的' },
    ], (dashConf_ && dashConf_.env) || 'prod', (v) => askConfirm('env', v,
      '切到「' + (v === 'prod' ? '线上' : '开发') + '」档：换一个网关地址、用那一档自己的登录态；没登录过会先要你登录。'));
    if (dashSrc !== 'cloud') envRow.classList.add('dim');
    box.append(envRow);
    const h2 = document.createElement('div'); h2.className = 'dSetH'; h2.textContent = '登录';
    box.append(h2);
    const loginRow = document.createElement('div'); loginRow.className = 'dSetRow';
    const loginLab = document.createElement('span'); loginLab.className = 'dSetLab';
    loginLab.textContent = logged ? ('已登录：' + ((dashConf_ && dashConf_.email) || '') + '（' + ((dashConf_ && dashConf_.label) || '') + '档）')
      : '这一档还没登录（云端读口要一把智枢自己的登录态，与上送 boot4 那把不是同一把）';
    const b = document.createElement('button'); b.type = 'button';
    b.textContent = logged ? '退出登录' : '登录';
    b.addEventListener('click', () => {
      if (logged) askConfirm('logout', null, '退出「' + ((dashConf_ && dashConf_.label) || '') + '」档的登录？退出后云端档读不到数，直到重新登录。');
      else openLogin();
    });
    loginRow.append(loginLab, b);
    box.append(loginRow);
    const note = document.createElement('div'); note.className = 'dSetNote';
    note.textContent = '口径：地址写死在后台（页面拼不出第三个）；dev 与线上连的是同一颗线上 PG（dev 只差网关进程在本机）；登录按档各存各的，切档不继承。';
    box.append(note);
    return box;
  }

  // ---------- 接线 ----------
  function wire() {
    // v0.12.17：页签是普通 <a href>（本页打开），由 renderTabs() 生成，不再有 JS 切视图。
    const r = $('dRefresh');
    if (r) r.addEventListener('click', () => { db = null; dbAt = 0; refreshState().then(() => { if (needsDb()) fetchDb(true); }); });
    // v0.12.16：数据源/云端档/登录钮搬进「设置」页签（segRow 自建控件，不走头部 id）——头部只留状态灯与刷新。
    // UIX-19 三条关法齐：作者模态框 × / 遮罩 / Esc（Esc 随搬家搬进来，仍要成立）
    document.addEventListener('keydown', (e) => {
      if (!(e && e.key === 'Escape')) return;
      if (confirm_) { confirm_ = null; render(); return; }   // UIX-19：工作台三张弹窗（确认/云端登录/作者模态）Esc 各归各
      if (login) { closeLogin(); return; }
      if (K.tlUserActive()) K.closeTlUser();
    });
    const wp = $('whoPick');
    if (wp) wp.addEventListener('change', () => { whoSel = wp.value || ''; return applyWho(); });
  }

  function boot() {
    wire();
    renderTabs();
    syncSrcUi();
    render();
    loadSrc().then(() => {
      syncSrcUi();
      refreshState();
      if (needsDb()) fetchDb(true);
    });
    // 工作台节奏：state 5 秒一拍（面板 900ms 是窄栏高频操作的需要；全页看数不用那么急），
    // 本机库 30 秒一拍且只在广场/概览页。document.hidden 时都不发（后台标签页不占宿主进程）。
    setInterval(() => { if (!document.hidden) refreshState(); }, 5000);
    setInterval(() => { if (!document.hidden && needsDb()) fetchDb(true); }, 30000);
  }

  // page-*.js 在 dashboard.js 之后同步加载 ⇒ 等 load 再起跑，保证 PAGE 已经 register 完（不抢跑成空页）。
  window.addEventListener('load', boot, { once: true });
})();

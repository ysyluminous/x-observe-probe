// X 观测探针 —— MV3 service worker：只做中继与合并，不含任何判定逻辑。
// 存在的三条理由，都不碰 x.com：
//   ① 代发本机 sink 请求（content script 直接 fetch 带的是页面 origin 与 CSP 语境，放这里发
//      才让「探针不对 X 发任何请求」在实现上成立）；回环白名单在这里再判一次。
//   ② 共享键的读改写在这里串行做（SW 单线程）⇒ 两个标签页同时记关注不会互相覆盖丢事件。
//   ③ 给 Side Panel 当路由：面板碰不到页面 DOM，只能经这里把命令转给活动标签页的 content script。
(function () {
  'use strict';

  const SINK = ['http://127.0.0.1:8765/', 'http://localhost:8765/'];
  const GUARD_KEY = 'ysy.xprobe.guard', USERS_KEY = 'ysy.xprobe.users', POSTS_KEY = 'ysy.xprobe.posts', RUNS_KEY = 'ysy.xprobe.v1', SERIES_KEY = 'ysy.xprobe.series', QUEUE_KEY = 'ysy.xprobe.queue';
  const RUNS_SOFT_BYTES = 2 * 1024 * 1024;   // 与 core 的 RUNS_BYTES_CAP 同值：SW 合并的结果也要吃这个字节顶
  // 待发队列的整键口径，必须与 core.js 的 QUEUE_* 常量逐条同值（自检 [15] 会解析两份源码比对数值）
  const QUEUE_MAX = 120;
  const QUEUE_SLOTS = 4;
  const QUEUE_BYTES_CAP = 600 * 1024;
  const QUEUE_DROP_MS = 6 * 60 * 1000;
  // 序列的三个封顶必须与 core.js 的同名常量逐条同值（自检 [15] 解析两份源码比对数值）。
  // 这里比 core 小 = 合并那一步把刚认出来的号直接删掉，面板上只看得见「日点没落进去」；
  // IMP_MAX 是所有 handle 的天花板，core 另外给别人的号单独封 120 天（DAY_MAX），比这里更严所以不冲突。
  const SER_MAX = 40;
  const MIN_MAX = 1440;
  const IMP_MAX = 365;
  const CMDS = ['state', 'collect', 'probe', 'dumpOnce', 'setDump', 'setDumpHtml', 'ping', 'flush', 'clear', 'query', 'stats', 'export', 'rebuild', 'store', 'sample', 'impAdd', 'impDel', 'seriesView', 'impRestoreDb', 'ownSet', 'setDebug', 'setRndMax', 'debugRec', 'goalSet', 'goalNow', 'setBadge', 'setHotBadge'];

  chrome.runtime.onInstalled.addListener(() => {
    try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) { /* 旧版本没这个 API */ }
    // 云同步的兜底节拍：去抖定时器会随 SW 一起被杀，闹钟保证「开着同步但再没写过存储」的账也会补传。
    // v0.11.0 起周期从设置里读（默认 5 分钟）——同一颗钟也负责「上一趟失败」的重试。
    armRetryAlarm();
  });
  try {
    chrome.alarms.onAlarm.addListener((a) => {
      if (!a || a.name !== 'xprobe-cloud') return;
      uploadCloudNow();
      // 标杆台账没有「写存储」这个心跳（本机库是宿主直接写的），只靠这颗钟与登录那趟兜底
      xsyncRun();
      // 档案上送同理：数据走宿主直进 xprobe.db，只靠闹钟与采集后去抖兜底
      scheduleLibSync(0);
      // 拉黑台账同一条道理（v0.11.0）：它也是宿主直写库，没有「写存储」的心跳
      scheduleBlockSync(0);
    });
  } catch (e) { /* 自检沙箱没有 alarms */ }

  function isLoopback(url) {
    const s = String(url || '');
    return SINK.some((p) => s.indexOf(p) === 0);
  }

  // ---------- Native Messaging（优先）与 HTTP 回退 ----------
  // v0.7.0：数据全部进本机库，而「先双击 start-sink.bat」不该是使用前提。装了宿主就直连，
  // 没装就退回原来的 HTTP（面板与 core 都不用改：两条路回的是同一个 {status, responseText}）。
  const NATIVE_HOST = 'com.yunxiao.xprobe';
  const chan = { native: null, via: '' };   // null=还没试过；面板以后要看通道就读这里

  // 只映射 sink 的那四个端点。别的路径照旧走 HTTP（404 语义、白名单拒绝都在那边）。
  function nativePlan(msg) {
    let u;
    try { u = new URL(msg.url); } catch (e) { return null; }
    const m = String(msg.method || 'GET').toUpperCase();
    if (m === 'POST' && u.pathname === '/log') return { t: 'log', body: String(msg.data || '') };
    if (m === 'POST' && u.pathname === '/dump') return { t: 'dump', body: String(msg.data || '') };
    if (m === 'GET' && u.pathname === '/ping') return { t: 'ping' };
    if (m === 'GET' && u.pathname === '/db') {
      // day / author 原样透传：只有白名单里带两个占位符的查询（tl_rank / author_posts）会吃它，库那边校验形状
      // hours / from+to 给 tl_win（v0.8.6 历史榜时间窗）：这里只做形状筛，越界由库那边报错
      const day = u.searchParams.get('day') || '';
      const author = u.searchParams.get('author') || '';
      const plan = { t: 'db', q: u.searchParams.get('q') || 'recent',
        limit: Math.min(Math.max(Number(u.searchParams.get('limit')) || 20, 1), 500) };
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) plan.day = day;
      if (/^[A-Za-z0-9_]{1,20}$/.test(author)) plan.author = author;
      const hraw = u.searchParams.get('hours') || '';
      if (/^\d{1,5}$/.test(hraw) && Number(hraw) <= 87600) plan.hours = Number(hraw);
      // after = 台账 id 游标（v0.9.7 标杆同步）：只认非负整数，别把「abc」「-1」喂给库那边去猜
      const araw = u.searchParams.get('after') || '';
      if (/^\d{1,12}$/.test(araw)) plan.after = Number(araw);
      const f0 = u.searchParams.get('from') || '';
      const f1 = u.searchParams.get('to') || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(f0) && /^\d{4}-\d{2}-\d{2}$/.test(f1) && f0 <= f1) {
        plan.from = f0;
        plan.to = f1;
      }
      return plan;
    }
    // v0.8.8 本机占用与清理：GET /fs 只读（auto=0 时连每日自动清理也不撞），
    // POST /fs 的 body 已由 fsPlan 筛成 op/target/keep/dry 四个受控值，路径在这边不存在
    if (u.pathname === '/fs' && (m === 'GET' || m === 'POST')) {
      if (m === 'GET') return { t: 'fs', op: 'sizes', auto: u.searchParams.get('auto') !== '0' };
      const o = fsPlan(msg.data);
      if (!o) return null;
      // fsPlan 给的是 HTTP body 的形状；宿主那边同一份信息摊平成平铺字段（op/target 同名，keep 用 days）
      const p = { t: 'fs', op: o.op, dry: o.dry, auto: o.auto };
      if (o.target) p.target = o.target;
      if (o.keep != null) p.days = o.keep;
      return p;
    }
    return null;
  }

  function nativeCall(payload, ms) {
    return new Promise((res) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; clearTimeout(timer); res(v); } };
      // 超时后不再回退 HTTP：宿主可能已经写成功了，回退等于让同一条记录进两次档。
      const timer = setTimeout(() => fin({ ok: false, err: 'native 超时', timeout: true }), ms);
      try {
        chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (r) => {
          const e = chrome.runtime.lastError;
          if (e) { fin({ ok: false, err: String(e.message || e).slice(0, 120) }); return; }
          fin(Object.assign({ ok: true }, r || {}));
        });
      } catch (e) { fin({ ok: false, err: String(e && e.message) }); }
    });
  }

  // ---------- 共享键合并 ----------
  const uniqSorted = (a, b, cap) => {
    const s = new Set([].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : []));
    const out = Array.from(s).filter((n) => typeof n === 'number').sort((x, y) => x - y);
    return out.length > cap ? out.slice(out.length - cap) : out;
  };
  function mergeGuard(o, n) {
    const a = (o && typeof o === 'object') ? o : {}, b = (n && typeof n === 'object') ? n : {};
    const ev = {};
    [].concat(Array.isArray(a.ev) ? a.ev : [], Array.isArray(b.ev) ? b.ev : [])
      .forEach((e) => { if (e && e.at) ev[e.at + '|' + (e.dir || '') + '|' + (e.id || '')] = e; });
    const arr = Object.keys(ev).map((k) => ev[k]).sort((x, y) => x.at - y.at);
    // cool（本轮关注的随机加时）跟最近一次动作走：两边都有时取 at 更新的那份
    let cool = null;
    if (a.cool && a.cool.full > 0) cool = a.cool;
    if (b.cool && b.cool.full > 0 && (!cool || (b.cool.at || 0) >= (cool.at || 0))) cool = b.cool;
    // goal 是目标与今日基线（v0.6.9 F3）：拿 setAt 新的那份。全零字段不算「新账」，免得旧页签把有效目标洗掉。
    let goal = null;
    if (a.goal && !b.goal) goal = a.goal;
    else if (b.goal && !a.goal) goal = b.goal;
    else if (a.goal && b.goal) goal = (b.goal.at || 0) >= (a.goal.at || 0) ? b.goal : a.goal;
    return {
      follows: uniqSorted(a.follows, b.follows, 1200),
      unfollows: uniqSorted(a.unfollows, b.unfollows, 1200),
      ev: arr.length > 200 ? arr.slice(arr.length - 200) : arr,
      cool: cool ? { at: cool.at, full: cool.full, rnd: cool.rnd == null ? null : cool.rnd } : null,
      goal: goal || undefined,
    };
  }
  function mergeTable(o, n, field, cap) {
    const a = (o && typeof o === 'object') ? o : {}, b = (n && typeof n === 'object') ? n : {}, out = {};
    Object.keys(a).concat(Object.keys(b)).forEach((k) => {
      const x = a[k], y = b[k];
      const pick = !x ? y : !y ? x : ((x[field] || 0) >= (y[field] || 0) ? x : y);
      if (pick) out[k] = pick;
    });
    const ks = Object.keys(out);
    if (ks.length > cap) {
      ks.sort((x, y) => (out[x][field] || 0) - (out[y][field] || 0));
      for (let i = 0; i < ks.length - cap; i++) delete out[ks[i]];
    }
    return out;
  }
  function mergeRuns(o, n) {
    const seen = {}, out = [];
    [].concat(Array.isArray(o) ? o : [], Array.isArray(n) ? n : []).forEach((r) => {
      if (!r) return;
      const k = String(r.at || '') + '|' + String(r.url || '');
      // 同一份快照可能一个是精简行（存储里滚下来的）、一个是全量（别的标签页刚采的）：
      // 谁带原文留谁，否则面板「本页」会莫名其妙退回精简版
      if (seen[k] != null) { if (out[seen[k]].slim && !r.slim) out[seen[k]] = r; return; }
      seen[k] = out.length; out.push(r);
    });
    // 60 而不是 400：整页快照一份实测几百 KB，400 份就是 13MB —— 正好顶穿 chrome.storage.local
    // 的 10MB 配额，而写失败当时被 setKey 吞了。全量原文的去处是本机 xprobe.db，浏览器这边只留运行态。
    const kept = out.length > 60 ? out.slice(out.length - 60) : out;
    return trimRunsPlain(kept);
  }
  // 单条快照的 UTF-8 字节数。配额限的是字节不是字符；TextEncoder 没有（自检沙箱）就退字符数
  function oneByte(v) {
    let s = '';
    try { s = JSON.stringify(v); } catch (e) { return 0; }
    if (typeof TextEncoder === 'function') {
      try { return new TextEncoder().encode(s).length; } catch (e) { /* 退字符数按近似 */ }
    }
    return s.length;
  }
  // 字节软顶：从最旧那份滚，至少留 1 份（滚成空连「本页」都没了，更糟）。
  // core 的 RUNS_BYTES_CAP 只管它发出来的那一份 —— 但合并结果里还躺着旧账本的全量：
  // 「同一份快照带原文的赢」意味着旧全量永远瘦不回去，60 份 × 几百 KB 在字节上照样顶得穿 10MB 配额 ⇒ 这里也得管住。
  function shrinkRunsTo(arr, cap) {
    const a = Array.isArray(arr) ? arr : [];
    const sizes = a.map(oneByte);
    let total = 0; sizes.forEach((x) => { total += x; });
    let head = 0;
    while (total > cap && head < a.length - 1) { total -= sizes[head]; head++; }
    return a.slice(head);
  }
  // 「条数顶 60」合进来一起做：自查路径没有合并只有整键替换，不能漏了条数
  function trimRunsPlain(arr) {
    let a = Array.isArray(arr) ? arr : [];
    if (a.length > 60) a = a.slice(a.length - 60);
    return shrinkRunsTo(a, RUNS_SOFT_BYTES);
  }
  // 时间序列必须按点合并，不能整键覆盖：两个标签页同开一个主页（或面板刚手工补了一个日点）时，
  // 覆盖会丢掉另一条腿刚采到的那个点。分钟点按 ts 取信息更全的那个，日点按 day 取 at 更新的（手工补录因此盖得过自动值）。
  function mergeSeries(o, n) {
    const a = (o && typeof o === 'object') ? o : {}, b = (n && typeof n === 'object') ? n : {}, out = {};
    const ks = {};
    Object.keys(a).concat(Object.keys(b)).forEach((k) => { ks[k] = 1; });
    Object.keys(ks).forEach((k) => {
      const x = a[k] || {}, y = b[k] || {};
      const byTs = {};
      [].concat(Array.isArray(x.min) ? x.min : [], Array.isArray(y.min) ? y.min : []).forEach((p) => {
        if (!p || !p.ts) return;
        const cur = byTs[p.ts];
        // 同一分钟两个标签页各读到一列（一个只认到关注、一个只认到粉丝）⇒ 按列合，别整点覆盖
        if (!cur) { byTs[p.ts] = p; return; }
        byTs[p.ts] = {
          ts: p.ts, at: String(p.at || '') >= String(cur.at || '') ? p.at : cur.at,
          following: cur.following == null ? p.following : (p.following == null ? cur.following : p.following),
          followers: cur.followers == null ? p.followers : (p.followers == null ? cur.followers : p.followers),
        };
      });
      const byDay = {};
      [].concat(Array.isArray(x.imp) ? x.imp : [], Array.isArray(y.imp) ? y.imp : []).forEach((p) => {
        if (!p || !p.day) return;
        const cur = byDay[p.day];
        if (!cur) { byDay[p.day] = p; return; }
        // 同一天两行必须**按列**合，不能让 at 新的那份整行赢：
        // 奖励页那条腿只写有效曝光(eff)，分析页那条腿只写实时曝光(value)，主页/手填那条腿只写关注/粉丝/帖子
        // （还可能晚几秒写进来）。整行覆盖 = 用户补的历史被静默抹成 —，面板上一点看不出来。
        const newer = String(p.at || '') >= String(cur.at || '');
        const take = (k) => (cur[k] == null ? p[k] : (p[k] == null || !newer ? cur[k] : p[k]));
        const valWon = cur.value == null ? p.value != null : (p.value != null && newer);
        const effWon = cur.eff == null ? p.eff != null : (p.eff != null && newer);
        byDay[p.day] = {
          day: p.day,
          value: take('value'), fow: take('fow'), fans: take('fans'), posts: take('posts'),
          exact: valWon ? !!p.exact : !!cur.exact,
          token: valWon ? (p.token || '') : (cur.token || ''),
          eff: take('eff'),
          effExact: effWon ? !!p.effExact : !!cur.effExact,
          effToken: effWon ? (p.effToken || '') : (cur.effToken || ''),
          effAt: effWon ? (p.effAt || cur.effAt || '') : (cur.effAt || p.effAt || ''),
          at: String(p.at || '') > String(cur.at || '') ? p.at : cur.at,
        };
      });
      const min = Object.keys(byTs).map(Number).sort((u, v) => u - v).map((t) => byTs[t]);
      const imp = Object.keys(byDay).sort().map((d) => byDay[d]);
      out[k] = {
        handle: k,
        min: min.length > MIN_MAX ? min.slice(min.length - MIN_MAX) : min,
        imp: imp.length > IMP_MAX ? imp.slice(imp.length - IMP_MAX) : imp,
        updatedAt: Math.max(x.updatedAt || 0, y.updatedAt || 0),
      };
    });
    const ok2 = Object.keys(out);
    if (ok2.length > SER_MAX) {
      ok2.sort((u, v) => (out[v].updatedAt || 0) - (out[u].updatedAt || 0));
      for (let i = SER_MAX; i < ok2.length; i++) delete out[ok2[i]];
    }
    return out;
  }
  // v0.6.9 的待发队列：sink 断线时标签页把积压落到扩展存储，形状是 { [bootId]: { t, recs } }。
  // 每页只写自己那一格 ⇒ 合并必须**按格替换**，不能整键覆盖（覆盖 = 把别的标签页的积压抹掉），
  // 也不能把 recs 拼起来（同一批记录会被两个标签页各发一次，日志里就是成对的重复行）。
  // 「写进来即认领」：本格已有的 recId 要从别的格删掉 —— content 侧认领过就不再重复发。
  // 字节/格数在这里再顶一次：几个标签页同时断线时，core 侧的单格顶管不住整键。
  function recKeyOf(r) {
    return String((r && r.at) || '') + '|' + String((r && r.kind) || '') + '|' + String((r && r.url) || '');
  }
  function mergeQueue(oldV, newV) {
    const out = {};
    const now = Date.now();
    const src = (oldV && typeof oldV === 'object') ? oldV : {};
    const inc = (newV && typeof newV === 'object') ? newV : {};
    const incIds = {};
    Object.keys(inc).forEach((k) => {
      const slot = inc[k];
      if (!slot || !Array.isArray(slot.recs)) return;
      slot.recs.forEach((r) => { if (r) incIds[recKeyOf(r)] = 1; });
    });
    Object.keys(src).forEach((k) => {
      const slot = src[k];
      if (!slot || !Array.isArray(slot.recs)) return;
      if (!slot.t || now - slot.t > QUEUE_DROP_MS) return;   // 太旧的积压滚掉：迟太久没意义，也不能让这个键长不大
      if (inc[k]) return;                                     // 本格要被这一笔替换，旧内容不留
      const left = slot.recs.filter((r) => r && !incIds[recKeyOf(r)]);
      if (left.length) out[k] = { t: slot.t, recs: left };
    });
    Object.keys(inc).forEach((k) => {
      const slot = inc[k];
      if (!slot || !Array.isArray(slot.recs)) return;
      const recs = slot.recs.length > QUEUE_MAX ? slot.recs.slice(slot.recs.length - QUEUE_MAX) : slot.recs;
      if (recs.length) out[k] = { t: slot.t || now, recs: recs };
    });
    const ks = Object.keys(out).sort((a, b) => (out[a].t || 0) - (out[b].t || 0));
    for (let i = 0; i < ks.length - QUEUE_SLOTS; i++) delete out[ks[i]];
    const keep = ks.slice(Math.max(0, ks.length - QUEUE_SLOTS));
    let total = 0;
    keep.forEach((k) => { total += oneByte(out[k]); });
    for (let i = 0; i < keep.length - 1 && total > QUEUE_BYTES_CAP; i++) { total -= oneByte(out[keep[i]]); delete out[keep[i]]; }
    return out;
  }

  function merge(key, oldV, newV) {
    if (key === GUARD_KEY) return mergeGuard(oldV, newV);
    if (key === USERS_KEY) return mergeTable(oldV, newV, 'updatedAt', 600);
    if (key === POSTS_KEY) return mergeTable(oldV, newV, 'seenAt', 1200);
    if (key === RUNS_KEY) return mergeRuns(oldV, newV);
    if (key === SERIES_KEY) return mergeSeries(oldV, newV);
    if (key === QUEUE_KEY) return mergeQueue(oldV, newV);
    return newV;
  }
  // 写失败必须回话。旧写法在回调里无条件 res({ok:true})，而 chrome.storage.local.set 超配额
  // 只往 lastError 里丢一句 "QUOTA_BYTES quota exceeded" ⇒ 面板以为写进去了，实际从那次起再没落过盘。
  function setKey(obj) {
    return new Promise((res) => {
      try {
        chrome.storage.local.set(obj, () => {
          const e = chrome.runtime.lastError;
          if (e) {
            const m = String(e.message || e);
            res({ ok: false, err: m, quota: /quota/i.test(m) });
          } else res({ ok: true });
        });
      } catch (e) { res({ ok: false, err: String(e && e.message), quota: /quota/i.test(String(e && e.message)) }); }
    });
  }
  function getKey(key) {
    return new Promise((res) => {
      try {
        chrome.storage.local.get([key], (cur) => {
          const e = chrome.runtime.lastError;   // get 的错误也只放 lastError；不读一句就又是控制台那句 Unchecked
          res(!e ? (cur && cur[key]) : undefined);
        });
      } catch (e) { res(undefined); }
    });
  }
  function store(msg) {
    const box = {}; box[msg.key] = msg.value;
    if (!msg.shared) return setKey(box);
    return getKey(msg.key).then((oldV) => {
      const merged = merge(msg.key, oldV, msg.value);
      const write = (val) => { const o = {}; o[msg.key] = val; return setKey(o); };
      return write(merged).then((r) => {
        if (!r.ok && r.quota && msg.key === QUEUE_KEY) {
          // 队列是「断线时才写」的应急账本，写不进去就得当场瘦身，不能整批丢掉：
          // 从最旧的格子开始滚， newest 那格（就是本页自己的）最后才动 —— 至少这一页的积压能落地。
          const caps = [256 * 1024, 64 * 1024];
          let cur = merged;
          const retry = () => {
            const cap = caps.shift();
            if (cap == null) return { ok: false, merged: cur, err: r.err, quota: true };
            const ks = Object.keys(cur).sort((a, b) => (cur[a].t || 0) - (cur[b].t || 0));
            let total = 0; ks.forEach((k) => { total += oneByte(cur[k]); });
            for (let i = 0; i < ks.length - 1 && total > cap; i++) { total -= oneByte(cur[ks[i]]); delete cur[ks[i]]; }
            return write(cur).then((r2) => {
              if (r2.ok) return { ok: true, merged: cur, err: '', quota: false };   // merged 照给：core 的缓存要跟存储一致，不然下次落盘又按旧账写
              return r2.quota ? retry() : r2;
            });
          };
          return retry();
        }
        if (!r.ok && r.quota && msg.key === RUNS_KEY && Array.isArray(merged) && merged.length > 1) {
          // 配额顶穿的自愈：runs 在浏览器这边只是运行态（原文都在本机 xprobe.db / logs），把最旧的滚掉再试。
          // 512KB 不行就 128KB；连这个都写不进去（别的键已把 10MB 占满）才如实回话。别的键不能擅自动。
          const caps = [512 * 1024, 128 * 1024];
          let cur = merged;
          const attempt = () => {
            const cap = caps.shift();
            if (cap == null) return { ok: false, merged: cur, err: r.err, quota: true };
            cur = shrinkRunsTo(cur, cap);
            return write(cur).then((r2) => {
              if (r2.ok) return { ok: true, merged: cur, err: '', quota: false };
              if (r2.quota) return attempt();
              return { ok: false, merged: cur, err: r2.err, quota: r2.quota };
            });
          };
          return attempt();
        }
        return { ok: r.ok, merged: merged, err: r.err, quota: r.quota };
      });
    });
  }

  // ---------- 网络中继 ----------
  function httpXhr(msg, ms) {
    return new Promise((res) => {
      const ac = new AbortController();
      const timer = setTimeout(() => { ac.abort(); res({ timeout: true }); }, ms);
      const init = { method: msg.method || 'GET', headers: msg.headers || {}, signal: ac.signal, cache: 'no-store', credentials: 'omit' };
      if (msg.data) init.body = msg.data;
      fetch(msg.url, init)
        .then((r) => r.text().then((t) => { clearTimeout(timer); res({ status: r.status, responseText: t }); }))
        .catch((e) => {
          clearTimeout(timer);
          // message 优先：fetch 失败时 name 恒为 "Error"，只有 message 说得出「连不上」还是「被拦」
          const s = String((e && (e.message || e.name)) || e);
          res(/abort/i.test(s) ? { timeout: true } : { err: s.slice(0, 120) });
        });
    });
  }

  // HTTP 回退也要把 via 带回去：否则宿主没装时记录写进去了、日志里却写不出「这条路是回环 HTTP」，
  // 而「宿主到底有没有生效」正是诊断页最常要回答的那一问。
  function httpFallback(msg, ms) {
    return httpXhr(msg, ms).then((r) => {
      if (r && r.status != null && r.via == null) { r.via = 'http'; chan.via = 'http'; }
      return r;
    });
  }

  function xhr(msg) {
    if (!isLoopback(msg.url)) return Promise.resolve({ err: '非本机地址，SW 拒发: ' + String(msg.url).slice(0, 60) });
    const ms = Math.min(Math.max(Number(msg.timeout) || 8000, 500), 20000);
    const plan = nativePlan(msg);
    if (!plan) return httpFallback(msg, ms);
    return nativeCall(plan, ms).then((r) => {
      if (r.timeout) { chan.native = { ok: false, at: Date.now(), err: 'timeout' }; return { timeout: true }; }
      // 没有 status = 宿主没起来/没装（打不开清单也是这种）⇒ 回退 HTTP；
      // 有 status 就是宿主给了答复（哪怕 4xx），再回退会变成同一请求处理两遍。
      if (r.status == null) {
        chan.native = { ok: false, at: Date.now(), err: r.err || 'native 无应答' };
        chan.via = 'http';
        return httpFallback(msg, ms);
      }
      chan.native = { ok: r.ok !== false, at: Date.now(), err: r.ok === false ? String(r.body || '').slice(0, 120) : '' };
      chan.via = 'native';
      return { status: r.status | 0, responseText: String(r.body || ''), via: 'native' };
    });
  }

  // ---------- 本机库读（v0.7.0）----------
  // 广场两张榜直接读 xprobe.db。走同一条 xhr：装了宿主就 Native，没装就 HTTP 回退（回包形状一致）。
  // 只发白名单查询名 + limit：SQL 永远在 xprobe_db.py 的 QUERIES 里，面板与 SW 都不拼 SQL。
  // 每次 sendNativeMessage 都由 Chrome 新起一个宿主进程，所以面板一次最多发两条（账号 + 帖子）。
  const DB_URL = 'http://127.0.0.1:8765/db';
  function dbq(msg) {
    const q = String((msg && msg.q) || 'help');
    const limit = Math.min(Math.max(Number(msg && msg.limit) || 50, 1), 500);
    // day / author 只给白名单里带两个占位符的查询（tl_rank / author_posts / own_posts）用：本机库那边校验形状，这里只透传
    const day = (msg && typeof msg.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.day)) ? msg.day : '';
    const author = (msg && typeof msg.author === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(msg.author)) ? msg.author : '';
    // hours / from+to 只给 tl_win（v0.8.6 卡片历史榜）用；hours=0 是「全部」，不是「没传」
    const hours = (msg && Number.isInteger(msg.hours) && msg.hours >= 0 && msg.hours <= 87600) ? msg.hours : null;
    const f0 = (msg && typeof msg.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.from)) ? msg.from : '';
    const f1 = (msg && typeof msg.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.to)) ? msg.to : '';
    const range = (f0 && f1 && f0 <= f1) ? { from: f0, to: f1 } : null;
    // after = 台账 id 游标（v0.9.7 标杆同步）：非负整数才透传，缺省不给 ⇒ 库那边按 0（从头）处理
    const after = (msg && Number.isInteger(msg.after) && msg.after >= 0 && msg.after <= 999999999999) ? msg.after : null;
    const meta = () => ({ q: q, limit: limit, day: day || undefined, author: author || undefined,
      hours: hours === null ? undefined : hours, from: range ? range.from : undefined, to: range ? range.to : undefined,
      after: after === null ? undefined : after,
      via: chan.via || '', native: chan.native, id: chrome.runtime.id, at: Date.now() });
    return xhr({ url: DB_URL + '?q=' + encodeURIComponent(q) + '&limit=' + limit + (day ? '&day=' + day : '') + (author ? '&author=' + author : '') +
      (hours !== null ? '&hours=' + hours : '') + (range ? '&from=' + range.from + '&to=' + range.to : '') +
      (after === null ? '' : '&after=' + after), method: 'GET', timeout: 8000 })
      .then((r) => {
        if (r.timeout) return Object.assign({ ok: false, err: '本机库 8 秒没回（宿主或 sink 卡住？）' }, meta());
        if (r.err) return Object.assign({ ok: false, err: r.err }, meta());
        let body;
        try { body = JSON.parse(r.responseText); } catch (e) {
          return Object.assign({ ok: false, err: '回包不是 JSON：' + String(r.responseText || '').slice(0, 60) }, meta());
        }
        if (body && body.ok === false) return Object.assign({ ok: false, err: String(body.err || '查询被拒') }, meta());
        if (!body || !Array.isArray(body.rows)) {
          return Object.assign({ ok: false, err: '回包没有 rows（库/sink 版本旧？跑一份新的 xprobe_db.py + log-sink.py 再重启）' }, meta());
        }
        return Object.assign({ ok: true, rows: body.rows }, meta());
      });
  }

  // ---------- 本机占用与清理（v0.8.8）----------
  // 纪律：浏览器这一侧不碰文件系统，面板的四个动作（测占用 / 删过期 / 整理库 / 改保留策略）
  // 都只转成一条本机回环请求（装了宿主就走 Native，形状一致）。**删哪些文件、按几天删全在
  // xprobe_fs.py 的白名单里**，这里只透传 op/target/keep/dry 四个受控值 —— 路径传不进来。
  // 缺省 dry=true：参数丢了、面板手滑了，最坏结果是「只量没删」，不是「删多了」。
  const FS_URL = 'http://127.0.0.1:8765/fs';
  const FS_OPS = ['sizes', 'clean', 'vacuum', 'conf', 'auto'];
  const FS_TARGETS = ['logs', 'dump'];
  function fsPlan(data) {
    let o = null;
    try { o = JSON.parse(String(data || '{}')); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    const keep = Number(o.keep);
    return { t: 'fs', op: FS_OPS.indexOf(String(o.op || '')) >= 0 ? String(o.op) : 'clean',
      target: FS_TARGETS.indexOf(String(o.target || '')) >= 0 ? String(o.target) : '',
      keep: (Number.isInteger(keep) && keep >= 1 && keep <= 365) ? keep : undefined,
      dry: o.dry !== false, auto: o.auto !== false };
  }
  function fsq(msg) {
    const auto = !(msg && msg.auto === false);
    return fsSend(FS_URL + (auto ? '' : '?auto=0'), 'GET', '', 10000, '测量');
  }
  function fsc(msg) {
    const plan = fsPlan(msg && msg.data);
    if (!plan) return Promise.resolve({ ok: false, err: '清理参数不对（op/target/keep/dry），没发请求' });
    // VACUUM 与真删都可能几十秒（477MB 的库压实不是瞬时活）：给到 xhr 允许的顶，别 8 秒就报超时
    const ms = (plan.op === 'vacuum' && plan.dry === false) || (plan.op === 'clean' && plan.dry === false) ? 20000 : 12000;
    return fsSend(FS_URL, 'POST', JSON.stringify(plan), ms, plan.op === 'clean' ? ('清理 ' + (plan.target || '?')) : plan.op);
  }
  function fsSend(url, method, data, ms, what) {
    const meta = () => ({ via: chan.via || '', native: chan.native, at: Date.now(), what: what });
    return xhr({ url: url, method: method, data: data, timeout: ms }).then((r) => {
      if (r.timeout) return Object.assign({ ok: false, err: what + ' 本机 ' + (ms / 1000) + ' 秒没回（宿主或 sink 卡住？库被占着也会这样）' }, meta());
      if (r.err) return Object.assign({ ok: false, err: r.err }, meta());
      let body;
      try { body = JSON.parse(r.responseText); } catch (e) {
        return Object.assign({ ok: false, err: '回包不是 JSON：' + String(r.responseText || '').slice(0, 60)
          // v0.9.3 改字面：装了原生宿主的机器上「重启 start-sink.bat」不改变任何事（扩展优先走宿主），
          // 上一轮就是这句把人带偏过一次 ⇒ 两条路各自怎么说，这里分开写清（RL-12 那条教训的同一族）。
          + '（sink 版本旧？装了宿主的机器要重跑 native/install-host.py 重打包，没装宿主的才重启 start-sink.bat 领 sink-18）' }, meta());
      }
      return Object.assign(body && typeof body === 'object' ? body : { ok: false, err: '回包不是对象' }, meta());
    });
  }

  // ---------- 云端同步（v0.8.0，可选，默认关）----------
  // 打开并登录后，SW 把浏览器里**已合并好的**「我的」序列与关注台账额外发一份到自家 Java 后端；
  // 本机管道（宿主/HTTP → xprobe.db）原样跑，两套账独立，切回 = 只停上送、本地一个字节没动过。
  // 边界：云上送只有 SW 这一跳 —— core 的 xhr 仍被 isLoopback 拦死（它只认 8765 那两条，页面 JS 到不了这里，
  // sender.id 也判过），目标地址写死在下面那个枚举里；不带 cookie（httpXhr 固定 credentials:'omit'），
  // 身份只靠登录换来的 token 头。
  // 地址只有一处可写错，所以写死在这里，面板与 core 都拼不出 URL —— 面板只能从这两档里选一个 key，
  // 填不进任意地址（v0.10.0 加 dev 这一档是为了让用户拿插件直接打本机正在跑的 boot4，不是开一个可输入的口子）。
  // v0.9.9 从 m. 改到 api2.：真机实测「发验证码」404 —— `m.mingzhang.cc` 是 Next.js 前端，
  // `/api/*` 不在它的 rewrites 里，那条路径回的是 404 的 HTML 页面（不是 JSON）；
  // 后端（同一个 boot4 应用）挂在 `api2.mingzhang.cc/api` 上，前端自己也是这么调的
  // （front/src/lib/config/api.ts 的 api2URL + authService 的 api2Post('/mz/user/sendEmail')）
  // ⇒ 登录、指标上送、标杆推送三条出口同一个域。
  // dev 那一档读的是 boot4 自己的 application-dev.yml（端口 28081、context-path 是 /），不是猜的。
  const CLOUD_ENVS = {
    prod: { label: '线上', base: 'https://api2.mingzhang.cc' },
    dev: { label: '本机 dev', base: 'http://127.0.0.1:28081' },
  };
  const CLOUD_ENV_DEF = 'prod';
  const CLOUD_ENV_KEY = 'ysy.xprobe.cloudEnv';
  const CLOUD_KEY = 'ysy.xprobe.cloud', CLOUD_STAT_KEY = 'ysy.xprobe.cloudStat', DEVICE_KEY = 'ysy.xprobe.deviceId';
  const CLOUD_DEBOUNCE_MS = 20000, CLOUD_MAX_EVENTS = 500, CLOUD_MS = 15000;
  // v0.11.0：兜底重试节拍从写死的 30 分钟改成设置里可调（默认 5）。用户口径：
  // 「同步失败要能在 5 分钟内自己再试一次，别等人去点按钮」。三本账（指标/标杆/档案）共用这一个钟。
  const RETRY_KEY = 'ysy.xprobe.retryMin', RETRY_DEF = 5, RETRY_LO = 1, RETRY_HI = 60;
  let cloudTimer = null;

  function envOf(v) { return CLOUD_ENVS[v] ? String(v) : CLOUD_ENV_DEF; }
  function baseOf(env) { return CLOUD_ENVS[envOf(env)].base; }
  function cloudEnv() { return getKey(CLOUD_ENV_KEY).then((v) => envOf(v)); }
  // 登录态按档各存一格（acct.prod / acct.dev）：换档 = 只换「打到哪台 boot4」。
  // 这一条是硬的 —— 线上换来的 JWT 绝不能跟着切档发到 localhost，反过来 dev 的 token 也不能顶到线上冒充。
  // 迁移：v0.9.9 及以前 token 挂在这把键的顶层，那把钥匙是线上档换的 ⇒ 只认进 prod，不叫用户重收一遍验证码。
  function cloudAcctAll(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const pick = (v) => (v && typeof v === 'object')
      ? { token: String(v.token || ''), email: String(v.email || ''), userId: String(v.userId || '') } : null;
    const all = {};
    Object.keys(CLOUD_ENVS).forEach((k) => {
      const v = pick((r.acct && typeof r.acct === 'object') ? r.acct[k] : null);
      if (v && v.token) all[k] = v;
    });
    const legacy = pick(r);
    if (!all.prod && legacy && legacy.token) all.prod = legacy;
    return all;
  }
  const NO_ACCT = { token: '', email: '', userId: '' };
  function normRetry(v) {
    const n = Math.round(Number(v));
    return (Number.isFinite(n) && n >= RETRY_LO && n <= RETRY_HI) ? n : RETRY_DEF;
  }
  function retryMin() { return getKey(RETRY_KEY).then((v) => normRetry(v)); }
  // 同名 alarm 会被 create 覆盖（周期一起换）⇒ 改设置不用先 clear；沙箱里没有 alarms 也不许把调用方弄挂
  function armRetryAlarm() {
    return retryMin().then((min) => {
      try { chrome.alarms.create('xprobe-cloud', { periodInMinutes: min }); } catch (e) { /* 自检沙箱 */ }
      return min;
    });
  }
  function cloudConf() {
    return cloudEnv().then((env) => getKey(CLOUD_KEY).then((raw) => {
      const r = (raw && typeof raw === 'object') ? raw : {};
      const a = cloudAcctAll(r)[env] || NO_ACCT;
      return { env: env, base: baseOf(env), on: !!r.on, token: a.token, email: a.email, userId: a.userId };
    }));
  }
  // 唯一的写入口：先读回原样，只改传进来的那一样（on = 全局那颗闸，acct = 当前档的账号，acct:null 只抹当前档）。
  // 「当前档」不传就跟着 ysy.xprobe.cloudEnv 走 —— 登录写在哪个格子，取决于点下那一刻打的是哪台 boot4。
  // 「模式」与「登录」分家（v0.9.8）在按档之后还是分家：切回纯本地不抹任何一档的 token。
  function cloudWrite(ch) {
    return Promise.all([cloudEnv(), getKey(CLOUD_KEY)]).then((a) => {
      const e = envOf(ch.env === undefined ? a[0] : ch.env);
      const r = (a[1] && typeof a[1] === 'object') ? a[1] : {};
      const all = cloudAcctAll(r);
      if (ch.acct === null) delete all[e];
      else if (ch.acct) all[e] = { token: String(ch.acct.token || ''), email: String(ch.acct.email || ''), userId: String(ch.acct.userId || '') };
      const o = {};
      o[CLOUD_KEY] = { on: (ch.on == null ? !!r.on : !!ch.on), env: e, acct: all };
      return setKey(o);
    });
  }


  // 浏览器 profile 级随机 UUID（非指纹）：云端用它区分「同一用户的第几台设备」，跟 X 账号无关
  function ensureDeviceId() {
    return getKey(DEVICE_KEY).then((v) => {
      if (v && typeof v === 'string' && v.length >= 8) return v;
      let id = '';
      try { id = (typeof crypto === 'object' && crypto && crypto.randomUUID) ? crypto.randomUUID() : ''; } catch (e) { /* 退自拼 */ }
      if (!id) id = 'd' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      const o = {}; o[DEVICE_KEY] = id;
      return setKey(o).then((r) => (r.ok ? id : ''));
    });
  }
  // ---------- 本机模型（v0.11.4）：唯一出口是 Native 宿主，而且默认关 ----------
  // 为什么非走宿主不可：host_permissions 是安装期声明的，MV3 没有「可选主机权限」这条路 ——
  // 想让用户按需授权，声明层就加不了口子（RL-3：申请了不用也是扩权）。于是这一条腿只有三种说法：
  //   闸关着 → 一个请求都不发（连宿主都不问）；
  //   闸开着但没装宿主 → 如实说「这条路在宿主里」，并把那条只写回环的安装命令念出来；
  //   闸开着、宿主在 → 宿主自己再判一次「只许 127.0.0.1」（native/xprobe_host.py 的 llm_guard），
  //                   旧宿主不认 llm 时会明说重打包，而不是让人对着 404「未知通道 'llm'」猜版本。
  // 地址在这一层是**填得进的**（本机端口各家不同：Ollama 11434 / LM Studio 1234 / vLLM 8000…），
  // 但只有回环那一种形状进得来；非回环当场拒，且这条腿永远不发对 X 或任何公网的请求。
  const MODEL_KEY = 'ysy.xprobe.model', MODEL_STAT_KEY = 'ysy.xprobe.modelStat';
  const MODEL_ENDPOINTS = {
    generate: { label: 'Ollama /api/generate', list: 'tags' },
    chat: { label: 'Ollama /api/chat', list: 'tags' },
    openai: { label: 'OpenAI 兼容 /v1/chat/completions', list: 'models' },
  };
  // v0.11.6 预设系统提示（用户点名「帮我写一个提示词…预设在配置中，也可以修改」）：
  // 配置里那格留空 = 发这份预设；✎ 编辑器与设置弹窗里都能改成自己的。风格契约全在这一格，
  // 页面拼的 prompt 只剩「帖子原文 + 作者」那副骨架——上一版拼在 prompt 里的「写成一个真人…」一并挪进来。
  const MODEL_DEFAULT = { on: false, endpoint: 'generate', base: 'http://127.0.0.1:11434', model: '', ms: 60000,
    system: [
      // v0.11.6 真机教训：给小模型看整句正例 = 给它发答案库（照抄正例、甚至把几条拼成一段交差）。
      // 所以这里**一个可抄的整句都不给**：写法用文字描述，开场词只给单字词池（抄无可抄），反例也不引原句。
      '你在 X（推特）上替账号主人本人随手回帖。只输出**一条**中文回复本身——就一句话，别加引号、别解释、别 @ 作者、别换行开新段、别把好几条回复拼成一段。',
      '',
      '【怎么写】',
      '- 像手机上随手打的：口语、短句。**总共别超过 15 个字**——你的回复要比原文短得多，越长越像 AI',
      '- 开场词之后只接一小句你自己的反应；从原文里**最多摘 4 个字**当引子，原句一个字都不许整段搬回来',
      '- 可以补一句短的亲历；**没做过的事别装做过**，也别编细节',
      '- 开场词从下面的开场词池里挑**一个**；连续几条别用同一个开场词（真人是换着来的）',
      '- 表情是稀罕物：大多数回复（十条里至少七条）一个表情都不带；带时最多一个（😂🤣👀🔥🤝 这类），别堆',
      '- 立场跟着原文走：别升华、别总结、别主动给建议（除非原文在求助）',
      '',
      '【开场词池】哈哈 / 笑死 / 确实 / 有道理 / 好家伙 / 绷不住了 / 完了 / 绝了 / 服了 / 救命',
      '',
      '【正例——好的回复就长这样（看感觉，别抄字：这种整句一个字都不许照抄进你的回复）】',
      '一句话的直给反应：开场词池里的词 + 对原文某一点的短反应；也可以不用开场词、直接一句口语认同。原文越短，回复越短。',
      '',
      '【反例——一条都不许沾】',
      '1. 复述原文：跟着原文的句式/内容把自己的话讲一遍（「每天…却还没流量」这种都算）——最典型的 AI 腔；从原文最多摘 4 个字',
      '2. 列点排比：首先/其次/最后——真人回帖不打提纲',
      '3. 升华说教：往「这反映了…」「值得我们深思」「在路上」「坚持就是胜利」上引——没人回帖是为了听课',
      '4. 用力过猛：标点叠满、表情成排——机器味',
      '5. 万金油评语：「挺不容易的」「心累」「加油」这种放谁身上都成立的话——没信息量，不如不发',
      '6. 开头复读：连续几条用同一个开场词，或拿示范句当模板原样交差——都算这条废了',
      '7. 点评作者的辛苦：「累也是应该的」「辛苦了」「坚持就是胜利」——道理谁都懂，说这个等于没说',
    ].join('\n') };
  const MODEL_MS_LO = 3000, MODEL_MS_HI = 300000;
  const MODEL_PROMPT_MAX = 48 * 1024;
  const MODEL_PORT_RE = /^(\d{2,5})$/;
  const MODEL_BASE_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:(\d{2,5}))?\/?$/;
  const HOST_INSTALL_HINT = '装原生宿主（只写 HKCU、不需要管理员）：在仓库目录里跑一次 '
    + 'py -3 native/install-host.py --ext-id <扩展ID>，它会顺手重打 xprobe-host.exe；跑完扩展 ⟳ + 刷新 x.com 标签页';
  let modelHost = null;   // {ver, at}：这一世 SW 见过的最新宿主版本（从任何一条 native 回包的 hver 里认出来）

  function clip80(s) { const t = String(s == null ? '' : s); return t.length > 80 ? t.slice(0, 80) + '…' : t; }
  function modelPerf() { return { modelAsk: 0, modelFail: 0, modelLastErr: '', modelMs: 0 }; }
  const modelPerfState = modelPerf();
  // 只回「有没有登录态那一类的形状」：这一格没有 token 语义，API Key 是用户自己的本机机密 ⇒ 明文不落回显
  function normBase(v) {
    const raw = String(v == null ? '' : v).trim().replace(/\s+/g, '');
    const m = MODEL_BASE_RE.exec(raw);
    if (!m) return { err: '本机模型地址只认 http://127.0.0.1:端口 或 http://localhost:端口（要 http，且是回环——这一条腿不发对 X / 公网的请求）' };
    const host = m[1];
    const p = m[3];
    if (!p) return { err: '要带端口（Ollama 常见 11434、LM Studio 1234、vLLM 8000）' };
    const n = Number(p);
    if (!MODEL_PORT_RE.test(p) || n < 1024 || n > 65535) return { err: '端口要 1024~65535，收到的是 ' + clip80(p) };
    return { base: 'http://' + host + ':' + n };
  }
  function modelNorm(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const ep = MODEL_ENDPOINTS[r.endpoint] ? String(r.endpoint) : MODEL_DEFAULT.endpoint;
    const b = normBase(r.base == null ? MODEL_DEFAULT.base : r.base);
    if (b.err) return { err: b.err };
    let ms = Math.round(Number(r.ms));
    if (!Number.isFinite(ms) || ms < MODEL_MS_LO || ms > MODEL_MS_HI) ms = MODEL_DEFAULT.ms;
    const one = (v, max) => String(v == null ? '' : v).slice(0, max);
    return { conf: {
      on: r.on === true,                             // 默认关：没点过那颗闸 = 一个请求都不发
      endpoint: ep, base: b.base,
      model: one(r.model, 120), system: one(r.system, 2000),
      token: one(r.token, 200),                      // 只在 SW→宿主这一跳里用，面板永不回显
      ms: ms,
    } };
  }
  function modelRead(raw) {
    return getKey(MODEL_KEY).then((v) => {
      const o = Object.assign({}, MODEL_DEFAULT, (v && typeof v === 'object') ? v : {});
      const n = modelNorm(raw && typeof raw === 'object' ? Object.assign(o, raw) : o);
      if (n.err) return { err: n.err, conf: Object.assign({}, MODEL_DEFAULT) };
      return { conf: n.conf };
    });
  }
  // 面板那边只看配置与统计，不看 Key：token 在这一格的作用是「本机服务的门钥匙」，回显它就是把它摊进
  // 每 900 毫秒重画一次的 DOM 里（面板与日志都可能有它），不划算。
  function modelView(conf) {
    return { on: !!conf.on, endpoint: conf.endpoint, endpointLabel: (MODEL_ENDPOINTS[conf.endpoint] || {}).label || conf.endpoint,
      base: conf.base, model: conf.model || '', system: conf.system || '', hasToken: !!conf.token, ms: conf.ms };
  }
  function modelStatWrite(ms, err) {
    const st = { at: Date.now(), ms: Math.round(ms), ok: !err, err: err ? clip80(err) : '', hostVer: (modelHost && modelHost.ver) || '' };
    const o = {}; o[MODEL_STAT_KEY] = st;
    return setKey(o).then(() => st);
  }
  // 真正发一趟：只有 native 这一条路，绝不回退 fetch —— 回退等于用一条没声明过的出口去顶替「宿主没装」，
  // 而宿主没装时正确结论是「这条路还没接通」，不是「换个端口赌一把」。
  function modelSend(payload, ms) {
    const t0 = Date.now();
    modelPerfState.modelAsk += 1;
    return nativeCall(payload, ms).then((r) => {
      const took = Date.now() - t0;
      modelPerfState.modelMs = took;
      const bail = (err, extra) => {
        modelPerfState.modelFail += 1;
        modelPerfState.modelLastErr = clip80(err);
        return modelStatWrite(took, err).then((st) => Object.assign({ ok: false, err: err, stat: st, ms: took, via: 'native' }, extra || {}));
      };
      if (r.timeout) return bail('本机模型 ' + Math.round(ms / 1000) + ' 秒没回话（在跑的那个服务起来了吗？大模型首包可以很慢，去设置里把超时调长）');
      if (r.status == null) return bail('没装原生宿主：这条腿只走宿主（不占 host_permissions）。' + HOST_INSTALL_HINT, { noHost: true });
      let body = null;
      try { body = JSON.parse(String(r.body || '{}')); } catch (e) { body = null; }
      // 宿主版本记账：任何一条 native 回包带 hver 都记下来（面板那句「宿主 native-N」就靠它）
      if (body && body.hver) modelHost = { ver: String(body.hver), at: Date.now() };
      if (!body || typeof body !== 'object') return bail('宿主回包不是对象（宿主版本对不上？' + HOST_INSTALL_HINT + '）');
      if (body.status == null && r.status >= 400 && /未知通道|llm/.test(String(body.err || ''))) {
        return bail('这台宿主还不认本机模型通道（它回的是「未知通道」）——宿主是打包进去的那一份，得重打一次：' + HOST_INSTALL_HINT, { oldHost: true });
      }
      if (body.ok !== true) return bail(clip80(body.err || ('宿主回 ' + r.status)));
      modelPerfState.modelLastErr = '';
      return modelStatWrite(took, '').then((st) => Object.assign({}, body, { ok: true, ms: took, stat: st, hostVer: (modelHost && modelHost.ver) || '' }));
    });
  }
  function modelDraft(msg) {
    return modelRead().then((cur) => {
      if (cur.err) return { ok: false, err: '设置里那一格存坏了：' + cur.err };
      const c = cur.conf;
      if (!c.on) return { ok: false, off: true, err: '本机模型没开（设置里那颗闸默认关；开着也只打回环端口，一个字节都不出这台机器）' };
      const prompt = String((msg && msg.prompt) || '');
      if (!prompt.trim()) return { ok: false, err: '要写的正文是空的（这一页没读到帖子原文？）' };
      if (prompt.length > MODEL_PROMPT_MAX) return { ok: false, err: '要喂的文本 ' + prompt.length + ' 字，超过 ' + MODEL_PROMPT_MAX + ' 字顶：别把整页原文都塞进去' };
      const payload = { t: 'llm', endpoint: c.endpoint, base: c.base, prompt: prompt, timeoutMs: c.ms };
      if (c.model) payload.model = c.model;
      // 采样参数不给，LM Studio 就按它自己加载时配的那套走。钉 0.9：1.05 真机试过会把小模型的
      // 「抄答案」放大成「把好几条示范拼成一段」，0.9 仍在多变的档但不至于散架；要可调再说。
      payload.temperature = 0.9;
      // 系统提示留空 = 用预设那份（v0.11.6：风格契约的默认住在这里，不替用户写死在页面 prompt 里）
      const sys = c.system || MODEL_DEFAULT.system;
      if (sys) payload.system = sys;
      // 开场轮换（真机 11-04：十条里九条「确实」开头）——模型无状态，提示词里写「连续几条别重复」是空头支票，
      // 多变性只能由我们按请求钉：每次从词池随机挑一个开场词写进这条 user 消息，三成概率改成「这次别用开场词」。
      // 词池与预设【开场词池】必须同一份字面，不然提示词自相矛盾。
      const OPENERS = ['哈哈', '笑死', '确实', '有道理', '好家伙', '绷不住了', '完了', '绝了', '服了', '救命'];
      const pick = Math.random() < 0.3 ? '' : OPENERS[Math.floor(Math.random() * OPENERS.length)];
      payload.prompt = prompt + (pick
        ? '\n\n（小要求：这条回复用「' + pick + '」开头）'
        : '\n\n（小要求：这条回复不用任何开场词，直接开口）');
      if (c.token) payload.token = c.token;
      if (msg && msg.format) payload.format = String(msg.format).slice(0, 16);
      if (msg && msg.maxTokens != null) payload.max_tokens = msg.maxTokens;
      return modelSend(payload, c.ms + 2000);
    });
  }
  // 翻闸那一刻朝所有 x.com 标签页广播一声（v0.11.4 右缘第七颗的显隐就等它当场跟上）。
  // 这不是新出口：消息只在本扩展内部走（chrome.runtime → 自家 content script），一条网络请求都不起；
  // 某一页没接（刚重载、还没装 content script）就任它自己 60 秒 TTL 兜底读，这里不重试也不报错。
  function aiGateShout(on) {
    query({}).then((ts) => (ts || []).forEach((t) => {
      if (t.id == null || !/^https?:\/\/(x|twitter)\.com\//.test(String(t.url || ''))) return;
      try { chrome.tabs.sendMessage(t.id, { t: 'modelGate', on: !!on }, () => void (chrome.runtime.lastError)); }
      catch (e) { /* 这一页没 content script：正常，什么都不做 */ }
    }));
  }
  function modelList() {
    return modelRead().then((cur) => {
      if (cur.err) return { ok: false, err: '设置里那一格存坏了：' + cur.err };
      const c = cur.conf;
      if (!c.on) return { ok: false, off: true, err: '本机模型没开：先打开那颗闸（开了也只打回环端口）' };
      const listKind = (MODEL_ENDPOINTS[c.endpoint] || {}).list || 'tags';
      return modelSend({ t: 'llm', endpoint: c.endpoint, base: c.base, list: listKind, timeoutMs: Math.min(c.ms, 15000) }, 17000)
        .then((r) => (r.ok ? Object.assign({}, r, { endpoint: c.endpoint }) : r));
    });
  }

  function dayKeyOf(ms) {
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '';
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // dayRows = series.imp 全量对账（服务端按 user+device+handle+day 唯一键覆盖）；
  // followEvents = 台账 ev 的增量（服务端按 user+at+dir+target 去重）。台账只留最近 200 条，
  // 所以云端的关注流水从「打开同步」那刻起算，这不是 bug 是台账的边界。
  function buildCloudPayload(series, guard) {
    const dayRows = [];
    const src = (series && typeof series === 'object') ? series : {};
    Object.keys(src).forEach((k) => {
      const s = src[k];
      [].concat(Array.isArray(s && s.imp) ? s.imp : []).forEach((p) => {
        if (!p || !p.day) return;
        dayRows.push({
          handle: k, day: p.day,
          exposure: p.value == null ? null : p.value,
          effective: p.eff == null ? null : p.eff,
          exact: p.exact ? 1 : 0,
          token: p.token || '',
          following: p.fow == null ? null : p.fow,
          followers: p.fans == null ? null : p.fans,
          posts: p.posts == null ? null : p.posts,
          manual: p.token === 'manual' ? 1 : 0,
          source: p.token === 'analytics' ? 'analytics' : '',
          at: String(p.effAt || '') > String(p.at || '') ? String(p.effAt || '') : String(p.at || ''),
        });
      });
    });
    const seen = {};
    const followEvents = [];
    [].concat(Array.isArray(guard && guard.ev) ? guard.ev : []).sort((a, b) => (a && a.at || 0) - (b && b.at || 0)).forEach((e) => {
      if (!e || !e.at || !e.dir) return;
      const key = e.at + '|' + e.dir + '|' + (e.handle || e.id || '');
      if (seen[key]) return;
      seen[key] = 1;
      followEvents.push({
        at: String(e.at), day: dayKeyOf(e.at), dir: String(e.dir).slice(0, 10),
        target: String(e.handle || e.id || '').slice(0, 64),
        why: String(e.why || '').slice(0, 32),
        w15: e.w15 == null ? null : e.w15, w24: e.w24 == null ? null : e.w24,
        suspect: e.suspect ? 1 : 0,
      });
    });
    return { dayRows: dayRows, followEvents: followEvents.length > CLOUD_MAX_EVENTS ? followEvents.slice(-CLOUD_MAX_EVENTS) : followEvents };
  }
  // 云端统一走 httpXhr（不带 cookie、超时可控、回包统一 Result{code,message,data}）。
  // 「这一跳到底撞到什么」必须说准，否则用户只能瞎试（v0.9.8 撞前端 404、v0.9.9 撞 CORS 403，
  // 两次都是插件把话说错了方向）。四类各有各的下一步：
  // 超时 → 那台服务没起；HTTP 401/403 且回包不是 JSON → 服务端 CORS 白名单里没有本扩展的 Origin
  // （boot4 的 CorsFilter 在任何 Controller 之前回纯文本 "Invalid CORS request"，这跟登录没关系，
  // 标成 needLogin 会让人一遍遍重收验证码）；JSON 里 code 404 → boot4 没部署那个接口；code 403 → 才是 token 失效。
  function nonJsonErr(status, base, path, text) {
    const where = '（HTTP ' + status + '，地址 ' + base + path + '）';
    const head = String(text || '').replace(/\s+/g, ' ').slice(0, 40);
    const tail = head ? '；回包开头「' + head + '」' : '';
    if (status === 403 || status === 401) {
      return '被服务端跨域挡了' + where + '：boot4 的 CORS 白名单里没有本扩展的来源 chrome-extension://' +
        String(chrome.runtime.id || '?') + '——把那一条加进 CorsConfig 再起服务（ID 在设置页「扩展 ID」那格）；' +
        '这不是登录问题，重收验证码没用' + tail;
    }
    return '回包不是 JSON' + where + ' —— 这一跳打到的不是接口（前端页面、网关默认页，或那个端口上根本没起服务）' + tail;
  }
  function cloudCall(base, path, token, bodyObj, ms) {
    const headers = { 'Content-Type': 'application/json' };
    // 身份只在请求头：面板与 SW 都不往体里塞 userId，服务端只从 token 认人（防「我替别人推」）
    if (token) headers.token = token;
    return httpXhr({ url: base + path, method: 'POST', headers: headers, data: JSON.stringify(bodyObj || {}) }, ms)
      .then((r) => {
        if (r.timeout) return { ok: false, err: '云端 ' + (ms / 1000) + ' 秒没回（' + base + ' 没醒？）' };
        if (r.err) return { ok: false, err: r.err };
        let body;
        try { body = JSON.parse(r.responseText); } catch (e) {
          return { ok: false, err: nonJsonErr(r.status, base, path, r.responseText) };
        }
        if (body && body.code === 403) return { ok: false, needLogin: true, err: '登录失效，请重新登录' };
        // code 401 = boot4 PublicInterceptor 那道 token 闸没过（Result.noLogin 的 code 就是 401，文案固定是「请登录」）。
        // 不能再照抄那三个字：本地明明存着 token、这一趟也带着它出机器，却说「请登录」，
        // 用户就只会一遍遍重收验证码（2026-10-29 那句「我登录成功了，但点上送还是报错 上次没传成：请登录」是这条）。
        // 所以按「带没带 token」分岔：带了 ⇒ 说的是服务端不认这把 token（那是 boot4 那侧的判据，插件改不动）；
        // 没带 ⇒ 才是真的没登录，点名去哪儿登录。
        // v0.10.4 又把这句改了一遍：上一版结尾写「先重新登录一次」，那是一个**假动作**——用户照做了（16:25 那一次），
        // 白登一遍，问题一个字没动。D-15 要求「下一步」必须落在真正握着这件事的人手里，而这里握着它的是对面那台服务；
        // D-9 还要求念出是哪一台。所以这一句必须带 base、必须说「重收验证码/重新登录都不改这件事」、必须给出真下一步（重建 + 重启那台 boot4）。
        // v0.10.5（UIX-32）：v0.10.4 那句里写死了「它跑的还是改动前编译的那份字节码」——那是插件**观测不到**的状态，
        // 用户一重启那句话就变成假话（本轮 17:59 重启之后果然成了假话）。所以只给「按顺序排的两问」，不替对面断言它跑的是哪一版。
        if (body && body.code === 401) {
          return token
            ? { ok: false, needLogin: false, err: '这一档本地有登录态、这一趟也带着 token 出了机器，但 ' + base + ' 不认这把 token —— 重收验证码、重新登录都换不来它点头：这一下在对面那台 boot4 手里。按顺序排两件事：① 对面那台跑的是哪一版判据？本机 dev 要看那个进程有没有在 token 校验改动之后**重启过**（磁盘上的字节码换了不算，旧类还在内存里），线上 api2 那台还得**单独部署一次**；② 确认对面是新版之后，才轮到查这把 token 本身（过期 / 账号被禁用）。插件读不到对面的构建版本，这两条只能按顺序人查' }
            : { ok: false, needLogin: true, err: '这一档还没登录：设置里「运行模式」弹窗的「登录」那一格填邮箱收验证码' };
        }
        // boot4 的兜底把「没有这个路由」也包成 HTTP 200 + code 404 ⇒ 这一句必须是「接口没部署」，
        // 不能让人以为是自己没登录（xprobe 那几个 Controller 至今没在真机上跑过）。
        if (body && body.code === 404) return { ok: false, err: '云端没有这个接口（' + path + '）—— boot4 那侧还没部署/没重启，插件侧改动不会让它出现' };
        if (!body || body.code !== 200) return { ok: false, err: (body && body.message) ? String(body.message).slice(0, 120) : '云端没认（code ' + (body && body.code) + '）' };
        return { ok: true, data: body.data };
      });
  }
  function cloudPost(path, token, bodyObj, ms) {
    return cloudEnv().then((env) => cloudCall(baseOf(env), path, token, bodyObj, ms || CLOUD_MS));
  }

  function uploadCloudNow() {
    return cloudConf().then((c) => {
      if (!c.on || !c.token) return { ok: false, err: '云端同步没开或这一档还没登录（设置里「运行模式」打开、并在弹窗里登录；换档要重新登录那一档）' };
      return Promise.all([ensureDeviceId(), getKey(SERIES_KEY), getKey(GUARD_KEY)]).then((all) => {
        const deviceId = all[0];
        if (!deviceId) return { ok: false, err: 'deviceId 没生成出来（存储写失败？）' };
        const payload = buildCloudPayload(all[1], all[2]);
        const stat = { at: Date.now(), env: c.env, base: c.base, dayRows: payload.dayRows.length, followEvents: payload.followEvents.length };
        const putStat = (ok, err, needLogin) => {
          const o = {}; o[CLOUD_STAT_KEY] = Object.assign({}, stat, { ok: !!ok, err: err || '', needLogin: !!needLogin });
          setKey(o);
        };
        if (!payload.dayRows.length && !payload.followEvents.length) { putStat(true, '还没有可同步的数据'); return { ok: true, empty: true }; }
        payload.deviceId = deviceId;
        try { payload.ver = String(chrome.runtime.getManifest().version || ''); } catch (e) { payload.ver = ''; }
        try { payload.label = String(navigator.userAgent || '').slice(0, 100); } catch (e) { payload.label = ''; }
        return cloudPost('/api/xprobe/ingest', c.token, payload).then((r) => {
          putStat(r.ok, r.err, r.needLogin);
          // 把这一趟到底推了几行带回去：v0.10.3 起「登录成功」那一趟要把两条腿各自的结果念给人听，
          // 而 CLOUD_STAT_KEY 是「上一次的结果」，同一刻读它跟读这次的结果是同一份账，不必再绕存储
          return Object.assign({}, r, { dayRows: payload.dayRows.length, followEvents: payload.followEvents.length });
        });
      });
    });
  }
  // 合并一落盘就排一次 20 秒去抖：SW 随时会被杀，定时器死了没关系，下一次写会再排（MV3 里没有「常驻」这回事）
  function scheduleCloudUpload() {
    if (cloudTimer) return;
    cloudTimer = setTimeout(() => { cloudTimer = null; uploadCloudNow(); }, CLOUD_DEBOUNCE_MS);
  }

  // ---------- 标杆同步（v0.9.7：登录态 + 台账流水增量 + 服务端回水位）----------
  // 为什么把密钥换了：v0.9.6 那版靠服务端配置文件里的一把共享同步密钥打天下，服务端收到只知道「有钥匙」，
  // 不知道「谁标的、哪台设备标的」；一把钥匙多浏览器共用一行账，谁也说不清这条标杆是谁撤的。
  // 现在这条路与「云端模式」共用同一支登录 token（邮箱验证码换来的 JWT），落到服务端的私有账层
  // ⇒ 「谁的哪台设备在什么时候进/出」有据可查。出口也和登录、指标上送同一个地址（同一台 boot4 应用，
  // 线上是 api2.mingzhang.cc、本机 dev 是 127.0.0.1:28081，由设置里「云端接口」那一档决定，只有这两档）。
  // 源也换了：不再读视图（bench_accounts / bench_post_rows 天生把 state=0 的人滤掉，推过去永远撤不掉），
  // 改读台账流水 bench_marks_ac / bench_marks_po —— 进/出各一行，游标是本机台账自增 id 而不是时间戳：
  // 换机器、改系统时钟、同一天里两次标记，都不会让水位把中间那批吞掉。
  // 水位只抬到服务端回的 ackAc / ackPo（见下面 push 那一段），客户端自己算会把「超行数顶被切掉的行」当已同步。
  // 密钥那套（专用存储键 + 专用请求头 + 设置里那格存密钥的输入框）整体退场：打进开源插件的共享密钥不是凭证，是门没关。
  const XS_WM_KEY = 'ysy.xprobe.xsyncWM', XS_STAT_KEY = 'ysy.xprobe.xsyncStat';
  const XS_MS = 20000, XS_MAX = 500;

  function wmPair(o) {
    const w = (o && typeof o === 'object') ? o : {};
    return { ac: Number(w.ac) > 0 ? Number(w.ac) : 0, po: Number(w.po) > 0 ? Number(w.po) : 0 };
  }
  // 水位按「档 + 账号」各存一本（v0.10.7）：.prod.<userId> / .dev.e<email>。
  // 为什么账号也要分：v0.10.6 及以前只分档 ⇒ 退出 A、登录 B 之后水位原样继承，B 的云端一条都收不到
  // （客户端以为「推到第几行」已经过了），而面板还写着已登录。宁可整批重推，不可漏推：
  // 换账号 = 新的一格从 0 开始，服务端按 handle / 推文 id 去重，重推不落第二行。
  // 没有 userId 的老登录态退回 email 当标签（带 e 前缀，免得一个像邮箱的 userId 跟它撞格）；
  // 两样都没有（没登录）落回 .<env> 那一格（面板看状态用）。
  function acctTag(c) {
    const uid = String((c && c.userId) || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (uid) return uid;
    const em = String((c && c.email) || '').toLowerCase().replace(/[^a-z0-9._@-]/g, '').slice(0, 80);
    return em ? ('e' + em) : '';
  }
  // 旧版本存的是 ISO 字符串水位（Number('2026-10-29T…')=NaN ⇒ 0），也旧的是顶层那本单档 {ac,po}：
  // 两者都只由 prod 认。不是 bug 是迁移：换口径后第一次整本重推，服务端唯一键
  // (user,device,kind,biz_key,client_id) 去重，落不出第二行。
  function xsWmKey(env, c) { return XS_WM_KEY + '.' + envOf(env) + (acctTag(c) ? '.' + acctTag(c) : ''); }
  function xsWm(env, c) {
    const e = envOf(env);
    return getKey(xsWmKey(e, c)).then((v) => {
      const cur = wmPair(v);
      if (c && c.token) return cur;          // 登录着：只认这个账号自己那本
      if (e !== CLOUD_ENV_DEF) return cur;
      if (cur.ac || cur.po) return cur;
      return getKey(XS_WM_KEY).then((old) => {
        const o = (old && typeof old === 'object') ? old : {};
        return (typeof o.ac === 'number' || typeof o.po === 'number') ? wmPair(o) : cur;
      });
    });
  }
  // 只认服务端回的游标：不是正数就当它没给（旧版服务端只会回 accountsNew 那一套）
  function ackOf(v, now) {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0 && n >= now) ? Math.floor(n) : now;
  }
  function xsyncRun() {
    // v0.11.0：标杆不再只在「登录那一趟 + 手动钮」才推。页面每落一批采集就会调 scheduleXs(0)，
    // 不加这道闸的话一次页面刷新能连撞好几趟、每趟两条库查询；忙碌时记一笔，本趟收尾立刻补一班。
    if (xsBusy) { xsAgain = true; return Promise.resolve({ ok: false, err: '标杆同步正在跑，等这一趟完（已记一笔，跑完立刻接着推）' }); }
    xsBusy = true;
    const finish = (v) => {
      xsBusy = false;
      if (xsAgain) { xsAgain = false; setTimeout(() => xsyncRun(), 0); }
      return v;
    };
    return Promise.all([cloudConf(), ensureDeviceId()]).then((a) => {
      const c = a[0];
      if (!c.on || !c.token) return { ok: false, err: '云端模式没开：设置里打开并登录（当前档 ' + c.env + ' · ' + c.base + '），才会把标杆推到你自己的 Java 库（本机账一个字没动）' };
      const deviceId = a[1];
      if (!deviceId) return { ok: false, err: 'deviceId 没生成出来（存储写失败？）' };
      return xsWm(c.env, c).then((wm) => Promise.all([
        dbq({ q: 'bench_marks_ac', after: wm.ac, limit: XS_MAX }),
        dbq({ q: 'bench_marks_po', after: wm.po, limit: XS_MAX }),
      ]).then((two) => {
        const ac = two[0], po = two[1];
        if (!ac.ok || !po.ok) {
          return { ok: false, err: '读本机台账没成：' + ((ac.ok ? po : ac).err || '没回话') +
            '（宿主/sink 是旧版？v0.9.7 要 bench_marks_ac / bench_marks_po 两条查询，重跑 install-host 打包）' };
        }
        // 行必须是「有台账 id、有业务键」的事件行；游标已经交给库了（SQL 里 WHERE s.id > ?），这里不再二次筛时间
        const acRows = [].concat(ac.rows || []).filter((r) => r && Number(r.id) > 0 && r.handle);
        const poRows = [].concat(po.rows || []).filter((r) => r && Number(r.id) > 0 && r.tweet_id);
        const putStat = (ok, extra) => {
          const o = {};
          o[XS_STAT_KEY] = Object.assign({ at: Date.now(), ok: !!ok, env: c.env, base: c.base,
            acSent: acRows.length, poSent: poRows.length }, extra || {});
          setKey(o);
        };
        if (!acRows.length && !poRows.length) { putStat(true, { empty: true, err: '' }); return { ok: true, empty: true, wm: wm }; }
        const num = (v) => (v == null ? null : v);
        const payload = {
          deviceId: deviceId,
          ver: String(chrome.runtime.getManifest().version || ''),
          ac: acRows.map((r) => ({
            id: Number(r.id), at: String(r.at || ''), day: String(r.day || ''), handle: String(r.handle),
            name: String(r.name || ''), state: Number(r.state) === 0 ? 0 : 1, tags: String(r.tags || ''),
            url: String(r.url || ''), fans: num(r.fans), fow: num(r.fow), postsN: num(r.posts_n),
            views: num(r.views), eng: num(r.eng), relation: String(r.relation || ''), blocked: num(r.blocked),
            lastPostAt: String(r.last_post_at || ''), observedAt: String(r.observed_at || ''),
          })),
          po: poRows.map((r) => ({
            id: Number(r.id), at: String(r.at || ''), day: String(r.day || ''), tweetId: String(r.tweet_id),
            author: String(r.author || ''), text: String(r.text || ''), state: Number(r.state) === 0 ? 0 : 1,
            tags: String(r.tags || ''), url: String(r.url || ''), view: num(r.view), reply: num(r.reply),
            like: num(r.like), eng: num(r.eng), timeDatetime: String(r.time_datetime || ''),
            observedAt: String(r.observed_at || ''),
          })),
        };
        return cloudPost('/api/xprobe/bench/push', c.token, payload, XS_MS).then((r) => {
          const d = (r.ok && r.data) ? r.data : {};
          // 这一趟的行数直接带回（v0.10.3：登录首趟要念两条腿各自的结果；不必绕 XS_STAT_KEY 读）
          const cnt = { acSent: acRows.length, poSent: poRows.length };
          putStat(r.ok, r.ok ? { ackAc: d.ackAc, ackPo: d.ackPo, acRecv: d.acRecv, acNew: d.acNewMark,
            poRecv: d.poRecv, poNew: d.poNewMark, acDrop: d.acDrop, poDrop: d.poDrop,
            capped: !!d.capped, empty: false, err: '' } : { err: r.err || '', needLogin: !!r.needLogin });
          if (!r.ok) return Object.assign({}, r, cnt);
          // 水位：只在 200 之后抬、只抬到服务端给的 ack、只许往上不许回头，而且只写当前这一档那本。
          // 服务端没回 ack（老服务端 / 空批）就原地不动 ⇒ 下次整批重推，唯一键去重，宁重不漏。
          const next = { ac: ackOf(d.ackAc, wm.ac), po: ackOf(d.ackPo, wm.po) };
          const o = {}; o[xsWmKey(c.env, c)] = next;
          return setKey(o).then((w) => w.ok
            ? Object.assign({}, r, cnt, { wm: next, stalled: (next.ac === wm.ac && acRows.length > 0) })
            : Object.assign({}, r, cnt, { wmWarn: '水位没落盘：下次会再推这一批（服务端按 设备+台账 id 去重，不会重）' }));
        });
      }));
    }).then(finish, (e) => finish({ ok: false, err: String((e && e.message) || e) }));
  }
  let xsTimer = null, xsBusy = false, xsAgain = false;
  function scheduleXs(ms) {
    if (xsTimer) return;
    xsTimer = setTimeout(() => { xsTimer = null; xsyncRun(); }, ms == null ? XS_MS : ms);
  }

  // ---------- v0.11.0 标杆：云端模式下页面与面板「读接口、写接口」 ----------
  // 与 xsyncRun 那条台账腿不冲突：那条是补推（本机台账 → 云端，水位推进），这里回答的是「现在是什么」和「现在就写」。
  // 没开云端模式 / 这一档没登录 ⇒ 当场回 needLocal（这不是错误：调用方退回本机库 = 发件箱 + 只读缓存）。
  // 接口这一跳没成 ⇒ 原样回 ok:false（不带 needLocal），由调用方决定怎么交代 —— 不许把「接口坏了」说成「没登录」。
  // 回包摊平：云端那层把业务字段裹在 data 里，而页面读的是 rows/total（与本机两条查询同一套列名），
  // 中间不再多一层 —— 调用方少写一次 .data，也就少一处「两边读法不一致」。
  function benchFlat(r) {
    if (!r || !r.ok || !r.data || typeof r.data !== 'object') return r;
    return Object.assign({}, r.data, { ok: true });
  }
  // 面板内部两本账用短名（ac / po），服务端只认全名（account / post）⇒ 出机器前在这一格归一。
  // 短名直接发上去会落进服务端「不认就当 account」那一分支 ⇒ 标帖被静默降成标人（v0.11.2 病根）：
  // 认不出来的 kind 当场回错，不替用户猜一个。
  const BENCH_KIND = { ac: 'account', po: 'post' };
  function benchKind(k) { return BENCH_KIND[k]; }
  function benchQuery(m) {
    return cloudConf().then((c) => {
      if (!c.on || !c.token) return { ok: false, needLocal: true, why: c.on ? 'login' : 'off', err: '' };
      if (m.q === 'posts') {
        return cloudPost('/api/xprobe/library/posts', c.token,
          { author: String(m.author || ''), size: Number(m.size) || 30 }, CLOUD_MS).then(benchFlat);
      }
      const kind = benchKind(m.kind);
      if (!kind) return { ok: false, err: '标杆查询的 kind 不认识：' + m.kind + '（只认 ac / po）' };
      const body = { kind: kind, size: Number(m.size) || 200 };
      if (Array.isArray(m.keys) && m.keys.length) body.keys = m.keys.slice(0, 500);
      return cloudPost('/api/xprobe/bench/list', c.token, body, CLOUD_MS).then(benchFlat);
    });
  }
  function benchMark(m) {
    return Promise.all([cloudConf(), ensureDeviceId()]).then((a) => {
      const c = a[0], deviceId = a[1];
      if (!c.on || !c.token) return { ok: false, needLocal: true, why: c.on ? 'login' : 'off', err: '' };
      if (!deviceId) return { ok: false, err: 'deviceId 没生成出来（存储写失败？）' };
      const kind = benchKind(m.kind);
      if (!kind) return { ok: false, err: '标杆标记的 kind 不认识：' + m.kind + '（只认 ac / po）' };
      const isAc = kind === 'account';
      const body = {
        kind: kind, bizKey: String(m.bizKey || ''),
        state: Number(m.state) === 0 ? 0 : 1, deviceId: deviceId,
        name: String(m.name || ''), tags: String(m.tags || ''), url: String(m.url || ''),
        at: String(m.at || ''), day: String(m.day || ''), observedAt: String(m.observedAt || ''),
      };
      // 数值只在真有的时候才带：null 不许变成 0/""再递上去（RL-11：服务端那一格是「没数」）
      if (isAc) {
        ['fans', 'fow', 'postsN', 'views', 'eng'].forEach((k) => { if (m[k] != null && m[k] !== '') body[k] = m[k]; });
      } else {
        body.author = String(m.author || '');
        body.text = String(m.text || '');
        ['view', 'reply', 'like', 'eng'].forEach((k) => { if (m[k] != null && m[k] !== '') body[k] = m[k]; });
        body.timeDatetime = String(m.timeDatetime || '');
      }
      return cloudPost('/api/xprobe/bench/mark', c.token, body, CLOUD_MS);
    });
  }

  // ---------- 抓取档案同步（v0.10.6：登录后自动推，手动钮只兜底；v0.10.7：按账号分水位 + 立即推 + 进度对账）----------
  // 推的是「这台机器打开页面时抓到的账号与帖子」：本机 store_users / store_posts 每人每帖最新一次快照，
  // 落到云端共享实体层 x_probe_account / x_probe_post（按 handle / 推文 id 去重，数值只许被更新的快照覆盖）。
  // 与标杆台账那条（xsyncRun）分开两本水位：台账推的是「我标了谁」，档案推的是「我看到了谁」，
  // 两个游标各在各的表上（benchmarks.id / store_users.id），混成一本就会互相拖着走。
  // 自动触发三处：登录成功当场一趟（全量批数，不等去抖）、每次采集落库**当场**一趟（scheduleLibSync(0)）、
  // 30 分钟闹钟兜底；手动「立即推档案」跑同一段代码，只是批数上限拉到全量 —— 它是兜底，不是主路。
  // v0.10.7 把「落库后 20 秒」改成 0 秒：用户要的是「抓到就进接口」，20 秒去抖会让刚抓的那条帖在云端迟到
  // （面板若开始直连接口，迟到就变成「查不到」）；libBusy 自然把连发的请求并成一趟，省掉去抖省不了重复。
  // 水位只抬到服务端回的 ackAu / ackPo（与标杆那条同一条纪律：客户端自己算会把被切掉的行当已同步）。
  const LIB_WM_KEY = 'ysy.xprobe.libWM', LIB_STAT_KEY = 'ysy.xprobe.libStat', LIB_STATS_KEY = 'ysy.xprobe.libStats';
  const LIB_MAX = 500, LIB_AUTO_BATCHES = 40, LIB_MANUAL_BATCHES = 500;
  let libTimer = null, libBusy = false, libAgain = false;

  // 水位按「档 + 账号」各存一本，与 xsWm 同一套 tag（.prod.u<userId> / .dev.e<email>）。
  // 只分档不分账号是 v0.10.6 的一个真 bug：退出 A、登录 B，水位原样继承 ⇒ B 的云端一条都收不到，
  // 而面板写着已登录。换账号 = 新的一格从 0 开始整本重推，服务端按 handle / 推文 id 去重，不落第二行。
  function libWmKey(env, c) { return LIB_WM_KEY + '.' + envOf(env) + (acctTag(c) ? '.' + acctTag(c) : ''); }
  function libWmPair(o) {
    const w = (o && typeof o === 'object') ? o : {};
    return { au: Number(w.au) > 0 ? Number(w.au) : 0, po: Number(w.po) > 0 ? Number(w.po) : 0 };
  }
  // 与标杆同步同一套按档/按账号隔离：切到 dev 或换登录都从头重放，不继承别处的本子（宁可重推，不可漏推）。
  // 没登录（面板看状态）落回 .<env> 那一格；prod 且那格是旧的顶层单档写法时认一次老账（迁移，不是 bug）。
  function libWm(env, c) {
    const e = envOf(env);
    return getKey(libWmKey(e, c)).then((v) => {
      const cur = libWmPair(v);
      if (c && c.token) return cur;
      if (e !== CLOUD_ENV_DEF) return cur;
      if (cur.au || cur.po) return cur;
      return getKey(LIB_WM_KEY).then((old) => {
        const o = (old && typeof old === 'object') ? old : {};
        return (Number(o.au) > 0 || Number(o.po) > 0) ? libWmPair(o) : cur;
      });
    });
  }

  function libSyncRun(opts) {
    // 跑着的时候又来了「有新数据」：别丢这一次（刚抓到的那批就在本次 dump 之后落库，本趟读不到），
    // 记一笔，本趟收尾立刻再跑一趟 —— 只返回一句「正在跑」等于把那批压在本地等下个闹钟。
    if (libBusy) { libAgain = true; return Promise.resolve({ ok: false, err: '档案同步正在跑，等这一趟完（已记一笔，跑完立刻接着推）' }); }
    libBusy = true;
    const cap = Number(opts && opts.batches);
    const maxBatches = Math.max(1, Math.min(Number.isFinite(cap) && cap > 0 ? cap : LIB_AUTO_BATCHES, LIB_MANUAL_BATCHES));
    const finish = (v) => {
      libBusy = false;
      const o = {}; o[LIB_STAT_KEY] = Object.assign({ at: Date.now() }, v);
      setKey(o);
      if (libAgain) { libAgain = false; setTimeout(() => libSyncRun(), 0); }
      return v;
    };
    return Promise.all([cloudConf(), ensureDeviceId()]).then((a) => {
      const c = a[0];
      if (!c.on || !c.token) return finish({ ok: false, err: '云端模式没开：设置里打开并登录（当前档 ' + c.env + ' · ' + c.base + '），才会把抓到的账号/帖子推到你自己的 Java 库' });
      const deviceId = a[1];
      if (!deviceId) return finish({ ok: false, err: 'deviceId 没生成出来（存储写失败？）' });
      return libWm(c.env, c).then((wm0) => {
        const wm = { au: wm0.au, po: wm0.po };
        let auSent = 0, poSent = 0, batches = 0, stopAu = false, stopPo = false, stallAu = false, stallPo = false, stopped = '', err = '';
        const step = () => {
          if (batches >= maxBatches) { stopped = 'batch-cap'; return Promise.resolve(); }
          // 一趟腿推完了就不再读它：否则每批都白读一条空查询，全量推时那是 500 次空转
          return Promise.all([
            stopAu ? Promise.resolve({ ok: true, rows: [] }) : dbq({ q: 'lib_users', after: wm.au, limit: LIB_MAX }),
            stopPo ? Promise.resolve({ ok: true, rows: [] }) : dbq({ q: 'lib_posts', after: wm.po, limit: LIB_MAX }),
          ]).then((two) => {
            const u = two[0], p = two[1];
            if (!u.ok || !p.ok) {
              err = '读本机档案没成：' + ((u.ok ? p : u).err || '没回话') +
                '（宿主/sink 是旧版？v0.10.6 要 lib_users / lib_posts 两条查询，重跑 native/install-host.py 打包）';
              stopped = 'error';
              return null;
            }
            const aus = [].concat(u.rows || []).filter((r) => r && Number(r.id) > 0 && r.handle);
            const pos = [].concat(p.rows || []).filter((r) => r && Number(r.id) > 0 && r.post_id);
            if (!aus.length && !pos.length) { stopped = 'done'; return null; }
            batches++;
            const payload = {
              deviceId: deviceId,
              ver: String(chrome.runtime.getManifest().version || ''),
              au: aus.map((r) => ({
                id: Number(r.id), at: String(r.at || ''), handle: String(r.handle),
                name: String(r.name || ''), fans: r.followers == null ? null : r.followers,
                fow: r.following == null ? null : r.following,
              })),
              po: pos.map((r) => ({
                id: Number(r.id), at: String(r.at || ''), tweetId: String(r.post_id),
                author: String(r.handle || ''), text: String(r.text || ''),
                view: r.view == null ? null : r.view, reply: r.reply == null ? null : r.reply,
                like: r.like == null ? null : r.like, repost: r.repost == null ? null : r.repost,
              })),
            };
            const before = { au: wm.au, po: wm.po };
            return cloudPost('/api/xprobe/library/push', c.token, payload, CLOUD_MS).then((r) => {
              if (!r.ok) { err = r.err || '上送失败'; stopped = 'error'; return null; }
              const d = (r.ok && r.data) ? r.data : {};
              auSent += aus.length;
              poSent += pos.length;
              wm.au = ackOf(d.ackAu, wm.au);
              wm.po = ackOf(d.ackPo, wm.po);
              // 两条腿分开判：有一条有行却没往前走 ⇒ 对面没回那条 ack（老服务端），停手等下次；
              // 「不满一页 = 这条腿推完了」和「有行却没回 ack = 卡住」是两回事，不能共用一个标记：
              // v0.11.0 真机上账号腿追平后，下一批带着上一批留下的「推完了」标记撞上这个判断，
              // 报出假 ackAu 卡住并整趟中止 ⇒ 帖子腿每趟只走 1000 行，五千多行积压要跑六趟。
              stallAu = aus.length > 0 && wm.au === before.au;
              stallPo = pos.length > 0 && wm.po === before.po;
              if (stallAu || stallPo) {
                stopAu = stallAu;
                stopPo = stallPo;
                err = '服务端没回 ' + (stallAu ? 'ackAu' : 'ackPo') + '（对面是旧版 boot4？）—— 这批下次会整批重推，唯一键去重不会落第二行';
                stopped = 'stalled';
                return null;
              }
              stopAu = aus.length < LIB_MAX;
              stopPo = pos.length < LIB_MAX;
              const o = {}; o[libWmKey(c.env, c)] = { au: wm.au, po: wm.po };
              // 两条腿都读到不满一页 ⇒ 本趟已经推完，别再白读一轮（stopped 用 'done' 表达「追平了」）
              if (stopAu && stopPo) { stopped = 'done'; return null; }
              return setKey(o).then(() => step());
            });
          });
        };
        return step().then(() => {
          const o = {}; o[libWmKey(c.env, c)] = { au: wm.au, po: wm.po };
          return setKey(o).then(() => {
            const out = { ok: !err, err: err, env: c.env, base: c.base, auSent: auSent, poSent: poSent,
              batches: batches, wm: { au: wm.au, po: wm.po }, done: stopped === 'done', capped: stopped === 'batch-cap' };
            // 这一趟撞了批数顶但还有得推：过 1 秒接着跑（SW 若被杀，30 分钟闹钟还会兜住）
            if (stopped === 'batch-cap') scheduleLibSync(1000);
            return finish(out);
          });
        });
      });
    }).catch((e) => finish({ ok: false, err: '档案同步出错：' + String((e && e.message) || e).slice(0, 120) }));
  }
  function scheduleLibSync(ms) {
    if (libTimer) return;
    libTimer = setTimeout(() => { libTimer = null; libSyncRun(); }, ms == null ? CLOUD_DEBOUNCE_MS : ms);
  }

  // ---------- 拉黑上送（v0.11.0）----------
  // 推的是本机 blocks 台账（append-only，进/出各一行）：用户口径「需要拉黑上云啊，确保把抓取到的账号的回关率，
  // 还有自己账号的拉黑记录 都同步到java数据库」。回关率不在这里算 —— 它是粉丝/关注两个数（随抓取档案那条腿进
  // x_probe_account，fans/fow 两列），服务端要的比例由那两个数算得出来，这里再推一遍就是同一事实存两份。
  // 游标与标杆台账同一口径：blocks.id 自增、与钟表无关；水位只抬到服务端 ackBl，断网重跑靠唯一键去重。
  const BLOCK_WM_KEY = 'ysy.xprobe.blockWM', BLOCK_STAT_KEY = 'ysy.xprobe.blockStat';
  const BLK_MAX = 500;
  let blkTimer = null, blkBusy = false, blkAgain = false;

  function blockWmKey(env, c) { return BLOCK_WM_KEY + '.' + envOf(env) + (acctTag(c) ? '.' + acctTag(c) : ''); }
  function blockWm(env, c) {
    return getKey(blockWmKey(env, c)).then((v) => {
      const w = (v && typeof v === 'object') ? v : {};
      return { bl: Number(w.bl) > 0 ? Number(w.bl) : 0 };
    });
  }
  function blockSyncRun(opts) {
    if (blkBusy) { blkAgain = true; return Promise.resolve({ ok: false, err: '拉黑同步正在跑，等这一趟完（已记一笔，跑完立刻接着推）' }); }
    blkBusy = true;
    const cap = Number(opts && opts.batches);
    const maxBatches = Math.max(1, Math.min(Number.isFinite(cap) && cap > 0 ? cap : 20, 500));
    const finish = (v) => {
      blkBusy = false;
      const o = {}; o[BLOCK_STAT_KEY] = Object.assign({ at: Date.now() }, v);
      setKey(o);
      if (blkAgain) { blkAgain = false; setTimeout(() => blockSyncRun(), 0); }
      return v;
    };
    return Promise.all([cloudConf(), ensureDeviceId()]).then((a) => {
      const c = a[0];
      if (!c.on || !c.token) return finish({ ok: false, err: '云端模式没开：设置里打开并登录（当前档 ' + c.env + ' · ' + c.base + '），才会把拉黑记录推到你的 Java 库' });
      const deviceId = a[1];
      if (!deviceId) return finish({ ok: false, err: 'deviceId 没生成出来（存储写失败？）' });
      return blockWm(c.env, c).then((wm0) => {
        let wm = wm0.bl, sent = 0, batches = 0, stopped = '', err = '';
        const step = () => {
          if (batches >= maxBatches) { stopped = 'batch-cap'; return Promise.resolve(); }
          return dbq({ q: 'block_marks', after: wm, limit: BLK_MAX }).then((r) => {
            if (!r.ok) {
              err = '读本机拉黑台账没成：' + (r.err || '没回话') +
                '（宿主/sink 是旧版？v0.11.0 要 block_marks 查询，重跑 native/install-host.py 打包）';
              stopped = 'error';
              return null;
            }
            const rows = [].concat(r.rows || []).filter((x) => x && Number(x.id) > 0 && x.handle);
            if (!rows.length) { stopped = 'done'; return null; }
            batches++;
            const payload = {
              deviceId: deviceId,
              ver: String(chrome.runtime.getManifest().version || ''),
              bl: rows.map((x) => ({
                id: Number(x.id), at: String(x.at || ''), day: String(x.day || ''),
                handle: String(x.handle), name: String(x.name || ''),
                state: Number(x.state) === 1 ? 1 : 0, url: String(x.url || ''),
              })),
            };
            const before = wm;
            return cloudPost('/api/xprobe/block/push', c.token, payload, CLOUD_MS).then((rr) => {
              if (!rr.ok) { err = rr.err || '上送失败'; stopped = 'error'; return null; }
              const d = rr.data || {};
              sent += rows.length;
              wm = ackOf(d.ackBl, wm);
              if (rows.length && wm === before) {
                err = '服务端没回 ackBl（对面是旧版 boot4？）—— 这批下次会整批重推，唯一键去重不会落第二行';
                stopped = 'stalled';
                return null;
              }
              if (rows.length < BLK_MAX) { stopped = 'done'; return null; }
              const o = {}; o[blockWmKey(c.env, c)] = { bl: wm };
              return setKey(o).then(() => step());
            });
          });
        };
        return step().then(() => {
          const o = {}; o[blockWmKey(c.env, c)] = { bl: wm };
          return setKey(o).then(() => {
            const out = { ok: !err, err: err, env: c.env, base: c.base, sent: sent, batches: batches,
              wm: wm, done: stopped === 'done', capped: stopped === 'batch-cap' };
            if (stopped === 'batch-cap') scheduleBlockSync(1000);
            return finish(out);
          });
        });
      });
    }).catch((e) => finish({ ok: false, err: '拉黑同步出错：' + String((e && e.message) || e).slice(0, 120) }));
  }
  function scheduleBlockSync(ms) {
    if (blkTimer) return;
    blkTimer = setTimeout(() => { blkTimer = null; blockSyncRun(); }, ms == null ? CLOUD_DEBOUNCE_MS : ms);
  }

  // ---------- 同步进度对账（v0.10.7）----------
  // 面板那张「本地 / 已推 / 待推 / 云端」不另立同步记录库：水位本身就是账本 ——
  // 「推到哪一行」在 libWM.<env>.<acct> 里，查统计时把水位当作已推的边界，待推 = 本地键数 - 边界内的键数。
  // 加字段/加表都要动真实库的 DDL，而且服务端水位和本地账本一分裂，就又多一处「两边说法不一致」。
  // 云端那两列只能是**全库**计数：共享实体层 x_probe_account / x_probe_post 没有「这条属于谁」的列，
  // 服务端算不出「你的」那几行 —— 面板上必须原样写成「云端全库」，不能拿它冒充个人条数。
  function libStatsKey(env, c) { return LIB_STATS_KEY + '.' + envOf(env) + (acctTag(c) ? '.' + acctTag(c) : ''); }
  // 两条统计查询各回 {total, synced, max_id}：total 的口径与推的那两条查询一致（每业务键只算最新一行、脏行不入）
  function libLocalStats(wm) {
    return Promise.all([
      dbq({ q: 'lib_user_stat', after: wm.au }),
      dbq({ q: 'lib_post_stat', after: wm.po }),
    ]).then((two) => {
      const u = two[0], p = two[1];
      if (!u.ok || !p.ok) {
        return { ok: false, err: '读本机进度没成：' + ((u.ok ? p : u).err || '没回话') +
          '（库/sink 是旧版？v0.10.7 要 lib_user_stat / lib_post_stat 两条查询，重跑 native/install-host.py 打包）' };
      }
      const one = (r) => {
        const row = [].concat(r.rows || [])[0] || {};
        const total = Math.max(0, Number(row.total) || 0);
        const synced = Math.min(total, Math.max(0, Number(row.synced) || 0));
        return { total: total, synced: synced, pending: total - synced };
      };
      return { ok: true, au: one(u), po: one(p) };
    });
  }
  function libStatsRun() {
    return Promise.all([cloudConf(), ensureDeviceId()]).then((a) => {
      const c = a[0];
      const deviceId = a[1] || '';
      return Promise.all([libWm(c.env, c), blockWm(c.env, c), getKey(BLOCK_STAT_KEY)]).then((wms) => {
        const wm = wms[0], bwm = wms[1];
        const blockLast = (wms[2] && typeof wms[2] === 'object') ? wms[2] : null;
        return Promise.all([libLocalStats(wm), dbq({ q: 'block_stat', after: bwm.bl })]).then((two) => {
          const loc = two[0], br = two[1];
          // 拉黑那一行与档案同一条口径：每个 handle 只看最新一行；本机库没这条查询（旧 sink）就留 null，不编 0
          const brow = [].concat((br && br.rows) || [])[0] || {};
          const btotal = Math.max(0, Number(brow.total) || 0);
          const bsynced = Math.min(btotal, Math.max(0, Number(brow.synced) || 0));
          const blk = br && br.ok ? { wm: { bl: bwm.bl }, local: { total: btotal, synced: bsynced, pending: btotal - bsynced } } : null;
          const base = { at: Date.now(), env: c.env, base: c.base, tag: acctTag(c),
            wm: { au: wm.au, po: wm.po }, local: loc.ok ? { au: loc.au, po: loc.po } : null, block: blk,
            blockLast: blockLast };
          if (!loc.ok) return Object.assign(base, { ok: false, err: loc.err, logged: !!(c.on && c.token), cloud: null });
          if (!c.on || !c.token) return Object.assign(base, { ok: true, logged: false, cloud: null, err: '' });
          return cloudPost('/api/xprobe/library/stats', c.token, { deviceId: deviceId }, CLOUD_MS).then((r) => {
            const d = (r.ok && r.data) ? r.data : {};
            const cloud = r.ok ? { au: Number(d.accounts) || 0, po: Number(d.posts) || 0,
              bl: d.blocks == null ? null : (Number(d.blocks) || 0) } : null;
            return Object.assign(base, { ok: !!r.ok, logged: true, cloud: cloud, err: r.ok ? '' : (r.err || '云端计数没取到') });
          });
        }).then((st) => {
          const o = {}; o[libStatsKey(c.env, c)] = st;
          return setKey(o).then(() => st);
        });
      });
    }).catch((e) => ({ ok: false, err: '同步进度对账出错：' + String((e && e.message) || e).slice(0, 120) }));
  }

  // ---------- Side Panel 路由 ----------
  function query(opts) {
    return new Promise((res) => {
      try {
        chrome.tabs.query(opts, (t) => {
          const e = chrome.runtime.lastError;   // 查询的错误也只放这里；不读一句就又是控制台那句 Unchecked
          res(!e ? (t || []) : []);
        });
      } catch (e) { res([]); }
    });
  }
  function toTab(msg) {
    return (msg.tabId != null
      ? Promise.resolve({ id: msg.tabId })
      : query({ active: true, currentWindow: true }).then((ts) => ts.filter((t) => /^https?:\/\/(x|twitter)\.com\//.test(String(t.url || '')))[0] || ts[0] || {})
    ).then((t) => new Promise((res) => {
      if (t.id == null) { res({ ok: false, err: '没有 x.com 标签页' }); return; }
      try {
        chrome.tabs.sendMessage(t.id, msg, (reply) => {
          const e = chrome.runtime.lastError;
          if (e) res({ ok: false, err: 'content script 没接（刚刷新？等它自己起）: ' + String(e.message || '').slice(0, 60) });
          else res(reply || { ok: false, err: '空响应' });
        });
      } catch (e) { res({ ok: false, err: String(e && e.message) }); }
    }));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.t) return;
    if (sender && sender.id !== chrome.runtime.id) return;   // 页面 JS 本来就到不了这里，再判一次
    if (msg.t === 'store') {
      store(msg).then((r) => {
        if (r && r.ok && (msg.key === SERIES_KEY || msg.key === GUARD_KEY)) scheduleCloudUpload();
        sendResponse(r);
      });
      return true;
    }
    if (msg.t === 'xhr') {
      xhr(msg).then((r) => {
        // 采集批次落库（POST /log）之后**当场**排一次档案上送（v0.10.7 从 20 秒去抖改成 0）：
        // 用户要的是「页面抓到就进接口」——面板以后直连接口查帖子，迟到 20 秒就是「刚抓的帖查不到」。
        // 连发不会打爆：libBusy 挡着并发，被挡的那次记一笔 libAgain，本趟收尾立刻补一班。
        if (r && r.status >= 200 && r.status < 300 && String(msg.method || '').toUpperCase() === 'POST'
          && /\/log(?:\?|$)/.test(String(msg.url || ''))) {
          scheduleLibSync(0);
          // v0.11.0：标杆的进/出也是随采集批次落进本机台账的（core 把 kind=bench/benchpost 一起发过来），
          // 所以同一条「落库成功」信号也要把标杆那趟排上 —— 用户口径：「点加入就推过去，点移出就推过去」。
          scheduleXs(0);
          // 同理：拉黑/取消（kind=block）也在同一批记录里，落库之后当场把拉黑那趟排上。
          scheduleBlockSync(0);
        }
        sendResponse(r);
      });
      return true;
    }
    if (msg.t === 'dbq') { dbq(msg).then(sendResponse); return true; }   // 不转标签页：本机库与页面无关
    if (msg.t === 'fsq') { fsq(msg).then(sendResponse); return true; }   // 本机占用测量（只读）
    if (msg.t === 'fsc') { fsc(msg).then(sendResponse); return true; }   // 清理/整理库/改策略（写，缺省 dry）
    // 云端同步这几件事都只认 SW（面板直接发消息，不经标签页、不经 core）：
    if (msg.t === 'cloudState') {
      Promise.all([cloudConf(), getKey(CLOUD_KEY), getKey(CLOUD_STAT_KEY), ensureDeviceId(), retryMin()]).then((a) => {
        const c = a[0], all = cloudAcctAll(a[1]);
        sendResponse({ ok: true, on: !!c.on, env: c.env, base: c.base, email: c.email || '', hasToken: !!c.token,
          // 每一档各报各的：面板那颗「云端接口」要能说出「dev 这档还没登录」而不是一句笼统的已登录
          envs: Object.keys(CLOUD_ENVS).map((k) => ({ env: k, label: CLOUD_ENVS[k].label, base: CLOUD_ENVS[k].base,
            logged: !!(all[k] && all[k].token), email: (all[k] && all[k].email) || '' })),
          stat: a[2], deviceId: a[3], retryMin: a[4], retryLo: RETRY_LO, retryHi: RETRY_HI });
      });
      return true;
    }
    // 兜底重试间隔（v0.11.0）：只认 1~60 的整数分钟，坏值当场拒、存储与闹钟都不动
    if (msg.t === 'retrySet') {
      const raw = Math.round(Number(msg.min));
      if (!Number.isFinite(raw) || raw < RETRY_LO || raw > RETRY_HI) {
        sendResponse({ ok: false, err: '重试间隔只能是 ' + RETRY_LO + '~' + RETRY_HI + ' 分钟（收到 ' + String(msg.min) + '）' });
        return;
      }
      const o = {}; o[RETRY_KEY] = raw;
      setKey(o).then((w) => {
        if (!w || !w.ok) { sendResponse({ ok: false, err: (w && w.err) || '间隔没落盘' }); return; }
        armRetryAlarm().then((min) => sendResponse({ ok: true, min: min }));
      });
      return true;
    }
    // dev / 线上两档（v0.10.0）：地址写死在上面那个枚举里，这里只认那两个 key ——
    // 面板传不进任意地址（否则「设置里填个 URL」就把 RL-2 的「只回环/只自家域名」变成一句空话）。
    // 换档只换「打到哪台 boot4」，本机一个字节都不动；两档的登录态与推标杆水位各存各的。
    if (msg.t === 'cloudEnvSet') {
      const want = String((msg && msg.env) || '');
      if (!CLOUD_ENVS[want]) { sendResponse({ ok: false, err: '云端接口只有 ' + Object.keys(CLOUD_ENVS).join(' / ') + ' 两档（地址写死在代码里，填不进别的地址）' }); return; }
      const o = {}; o[CLOUD_ENV_KEY] = want;
      setKey(o).then((w) => {
        if (!w || !w.ok) { sendResponse({ ok: false, err: (w && w.err) || '档位没落盘' }); return; }
        cloudConf().then((c) => sendResponse({ ok: true, env: c.env, base: c.base, logged: !!c.token, email: c.email, on: !!c.on }));
      });
      return true;
    }
    if (msg.t === 'cloudSendCode') {
      const email = String((msg && msg.email) || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { sendResponse({ ok: false, err: '邮箱格式不对' }); return; }
      cloudPost('/api/mz/user/sendEmail', '', { email: email }).then(sendResponse);
      return true;
    }
    if (msg.t === 'cloudLogin') {
      const email = String((msg && msg.email) || '').trim();
      const code = String((msg && msg.code) || '').trim();
      cloudPost('/api/mz/user/codeLogin', '', { email: email, code: code }).then((r) => {
        if (!r.ok) { sendResponse(r); return; }
        const u = (r.data && r.data.user) || {};
        cloudWrite({ on: true, acct: { token: String((r.data && r.data.token) || ''), email: email, userId: String(u.id || '') } })
          .then((w) => {
            if (!w.ok) { sendResponse({ ok: false, err: w.err || '登录态落盘失败' }); return; }
            // 登录当场就把三本账各推一趟（用户 2026-10-29：「感觉应该在登录后立即触发同步，把本地和浏览器的数据同步到云端」）。
            // 为什么非等不可：20 秒去抖只挂在「本机新写了一批」上（scheduleCloudUpload），刚登录这一刻本机早就攒着一整库，
            // 不去点按钮它就永远等在本地；而「登录成功」若只回一句「已登录」，用户看到的就是「登上了却没东西过去」。
            // 三条腿并行推，各自的结果原样带回（firstPush）：指标/关注台账走 ingest，标杆台账走 bench/push，
            // 抓取档案（账号/帖子）走 library/push —— 三条腿谁成了谁没成都得各说一句，合成一句「同步成功」就是另一种骗人。
            // 推失败绝不把登录改成失败：token 已经落盘，下一次写数据还会自动重试；失败的那句由面板如实念。
            // v0.10.7：档案这条首趟给到全量批数（LIB_MANUAL_BATCHES）—— 用户换号登录后「所有数据立即同步」
            // 靠的就是这一趟；沿用 40 批的上限时，几十万行的库要等半小时闹钟慢慢追。
            // v0.11.0：拉黑台账也走同一趟首推（用户口径「自己账号的拉黑记录也要同步」）—— 四条腿各报各的。
            return Promise.all([uploadCloudNow(), xsyncRun(), libSyncRun({ batches: LIB_MANUAL_BATCHES }),
              blockSyncRun({ batches: 40 })]).then((four) =>
              sendResponse({ ok: true, email: email, nick: String(u.nickName || ''),
                firstPush: { metrics: four[0], bench: four[1], library: four[2], block: four[3] } }));
          });
      });
      return true;
    }
    // 「模式」与「登录」分家（v0.9.8）：切回纯本地只关「要不要上送」，不抹 token —— 以前那颗钮把两件事
    // 混在一起（开着再点 = 直接退出登录），用户以为在切模式、其实把身份也丢了，下次还得重收验证码。
    // 反向也设了闸：没有 token 不许把 on 打开（「云端模式」却认不出你是谁 = 一扇没接通的门，面板还会显示在传）。
    if (msg.t === 'cloudMode') {
      const want = !!msg.on;
      cloudConf().then((c) => {
        if (want && !c.token) return { ok: false, err: '这一档（' + c.env + ' · ' + c.base + '）还没有登录态：先在弹窗里用邮箱验证码登录一次——换档不算登录，没有 token 的「云端模式」只会让面板显示在传、其实一个字节都不发' };
        return cloudWrite({ on: want }).then((w) => (w && w.ok ? { ok: true, on: want, logged: !!c.token, email: c.email || '', env: c.env, base: c.base }
          : { ok: false, err: (w && w.err) || '模式没落盘' }));
      }).then(sendResponse);
      return true;
    }
    if (msg.t === 'cloudLogout') {
      cloudConf().then((c) => cloudWrite({ env: c.env, on: false, acct: null })).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.t === 'cloudSyncNow') { uploadCloudNow().then(sendResponse); return true; }
    // 标杆同步两件事（v0.9.7）：状态只报「这一档有没有登录态 + 水位到哪儿」，token 明文一律不回面板；跑一次抬一次服务端给的 ack
    if (msg.t === 'xsyncState') {
      cloudConf().then((c) => xsWm(c.env, c).then((wm) => getKey(XS_STAT_KEY).then((st) =>
        sendResponse({ ok: true, conf: { env: c.env, base: c.base, on: !!c.on, logged: !!c.token, email: c.email || '' },
          wm: wm, stat: st || null }))));
      return true;
    }

    if (msg.t === 'xsyncRun') { xsyncRun().then(sendResponse); return true; }
    // 标杆直读直写（v0.11.0）：页面/面板在云端模式下问「谁在榜」「TA 有哪些帖」「现在就标/撤」。
    // 这两条都不写水位、不碰本机台账 —— 台账那条腿（xsyncRun）照旧负责补推与去重。
    if (msg.t === 'benchQuery') { benchQuery(msg).then(sendResponse); return true; }
    if (msg.t === 'benchMark') { benchMark(msg).then(sendResponse); return true; }
    // 抓取档案（v0.10.6）：状态只报「这一档的登录态 + 两本水位 + 上一次结果」，token 明文一律不回面板。
    // v0.10.7：多一列缓存下来的同步进度（stats），面板打开就先拿旧的渲染、再发 libStats 现算一次
    if (msg.t === 'libState') {
      cloudConf().then((c) => Promise.all([libWm(c.env, c), getKey(LIB_STAT_KEY), getKey(libStatsKey(c.env, c))]).then((a) =>
        sendResponse({ ok: true, conf: { env: c.env, base: c.base, on: !!c.on, logged: !!c.token, email: c.email || '' },
          wm: a[0], stat: a[1] || null, stats: a[2] || null, busy: libBusy })));
      return true;
    }
    if (msg.t === 'libSyncNow') {
      // 「立即全量同步」= 档案 + 拉黑一起推（面板那颗钮的口径是「全部推完」）；两条腿各报各的
      Promise.all([libSyncRun({ batches: LIB_MANUAL_BATCHES }), blockSyncRun({ batches: 200 })]).then((two) =>
        sendResponse(Object.assign({}, two[0], { block: two[1] })));
      return true;
    }
    if (msg.t === 'blockSyncNow') { blockSyncRun({ batches: 200 }).then(sendResponse); return true; }
    // 同步进度现算（v0.10.7）：本地两条统计 + 云端一条只读计数，不写任何一侧
    if (msg.t === 'libStats') { libStatsRun().then(sendResponse); return true; }
    if (msg.t === 'tabs') {
      query({ url: 'https://x.com/*' }).then((ts) => sendResponse({
        ok: true,
        tabs: ts.map((t) => ({ id: t.id, title: String(t.title || '').slice(0, 40), url: String(t.url || '').slice(0, 90), active: !!t.active })),
      }));
      return true;
    }
    if (msg.t === 'openPanel') {
      const wid = sender.tab ? sender.tab.windowId : undefined;
      if (!chrome.sidePanel || !chrome.sidePanel.open || wid == null) {
        sendResponse({ ok: false, err: '这个环境开不了面板，用工具栏图标点' }); return;
      }
      chrome.sidePanel.open({ windowId: wid }).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, err: 'sidePanel.open 被拒（多半不在用户手势链上）: ' + String(e && e.message || e).slice(0, 70) }));
      return true;
    }
    // 本机模型三件事（v0.11.4）：状态只报配置与最近一趟的账（Key 明文一律不回面板）；
    // 「测活」与「写一稿」都必须先过那颗默认关的闸，且只走宿主这一条路。
    if (msg.t === 'modelState') {
      Promise.all([modelRead(), getKey(MODEL_STAT_KEY)]).then((a) => sendResponse({
        ok: true, conf: modelView(a[0].err ? MODEL_DEFAULT : a[0].conf), badConf: a[0].err || '',
        stat: a[1] || null, perf: modelPerfState, hostVer: (modelHost && modelHost.ver) || '', host: chan.native || null,
        endpoints: Object.keys(MODEL_ENDPOINTS).map((k) => ({ endpoint: k, label: MODEL_ENDPOINTS[k].label })),
        defBase: MODEL_DEFAULT.base, defSystem: MODEL_DEFAULT.system, msLo: MODEL_MS_LO, msHi: MODEL_MS_HI, installHint: HOST_INSTALL_HINT,
      })).catch(() => {});
      return true;
    }
    if (msg.t === 'modelSet') {
      modelRead(msg).then((r) => {
        if (r.err) { sendResponse({ ok: false, err: r.err }); return; }
        const o = {}; o[MODEL_KEY] = r.conf;
        setKey(o).then((w) => {
          if (!w || !w.ok) { sendResponse({ ok: false, err: (w && w.err) || '模型设置没落盘' }); return; }
          // 回面板的是 modelView（不含 token）；闸翻开那一刻就说清这条路走不走得通，别等点「写一稿」才炸
          const v = modelView(r.conf);
          aiGateShout(v.on);
          sendResponse({ ok: true, conf: v, warn: v.on ? '' : '闸还是关着：一个请求都不发（连本机模型服务也不问）' });
        });
      });
      return true;
    }
    if (msg.t === 'modelTest') { modelList().then(sendResponse); return true; }
    if (msg.t === 'modelDraft') { modelDraft(msg).then(sendResponse); return true; }
    if (CMDS.indexOf(msg.t) >= 0) { toTab(msg).then(sendResponse); return true; }
  });

  // SW 一醒来就自查一次：上一版顶穿的存储不会自己变瘦，等下一次写才自愈就又多熬一轮「静默不落盘」。
  // runs 超软顶就整键滚到顶内 —— 原文都在本机 xprobe.db / logs，浏览器这边本就只留运行态，滚了不丢判定数据。
  function selfCheck() {
    try {
      chrome.storage.local.getBytesInUse([RUNS_KEY], (n) => {
        if (chrome.runtime.lastError) return;   // 读一句：错误走面板那本账，不再回控制台
        if (!(n > RUNS_SOFT_BYTES)) return;
        getKey(RUNS_KEY).then((old) => {
          if (!Array.isArray(old)) return;
          const small = trimRunsPlain(old);
          if (small.length >= old.length) return;   // 滚不动就不写（写一样的值没有意义）
          const o = {}; o[RUNS_KEY] = small;
          setKey(o);
        });
      });
    } catch (e) { /* 没有 getBytesInUse 的环境（自检沙箱）跳过 */ }
  }
  selfCheck();
})();

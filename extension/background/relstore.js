// X 观测探针 —— 浏览器端关系账（v0.12.25）
//
// 为什么有这个文件：用户要「放弃本机 DB、只留一套数据」，参考插件「不是兄弟」把关系账全放浏览器存储
// （Dexie + IndexedDB，5.7 MB，零 native、零后端）。这条路对本仓**关系账那一半**完全成立：
// 关系数据量极小（几千人 × 几百字节），`chrome.storage.local` 装得下，而且不需要宿主 exe 就能读。
//
// 为什么不抄 Dexie：本扩展是**免构建**的（没有 npm/rollup，manifest 里直接引 js 文件），
// 塞一个 80 KB 的 Dexie 进扩展不划算，而且 Dexie 的价值在「复杂索引 + 大数据量」，
// 这里的数据量用不着。自己写一层薄封装，形状照「不是兄弟」的表设计。
//
// **它跑在 service worker 里**（由 sw.js 用 importScripts 挂载）：这是刻意的 ——
// content script 在 isolated world 里没有 chrome.storage 的写权限（host-shim 的 GM_setValue
// 正是转交 SW 落盘的），而多标签页并发写同一份账必须串行 ⇒ 交给 SW 单线程最省事也最安全。
// 面板（dashboard 页）也能直接引这一份来读（同一份 chrome.storage.local，读写同源）。
//
// 表设计（照参考插件 v2 的 accountUsers / accountObservations 那一版，viewer 维度保留）：
//   relUsers : keyPath 'viewer+handle'，索引 handle / relationship / lastSeenAt
//              一行 = 一个人的关系快照（现在关注不关注、有没有变、什么时候第一次见、什么时候最后见）
//   relObs   : autoIncrement 'id'，索引 handle / observedAt / [handle+observedAt]
//              一行 = 一次关系观测（什么时候、看到什么关系、从哪条腿读到的）
//
// 与本仓既有账的关系（**唯一事实源仍是 xprobe_db.py 的 follow_starts**，RL-22）：
//   本文件**不重新判定**「我关注 TA 吗 / TA 回关我了吗」—— 那些结论由 xprobe_db.py 定死。
//   本文件存的是**原始观测**（关系读数 + 时刻），供「页面徽标即时更新」与「不依赖 exe 的关系面板」用。
//   两边口径不一致时，以 xprobe_db.py 为准（面板的「未回关」名单仍走那条 SQL）。
//
// 存储介质：chrome.storage.local（不是 IndexedDB）—— 理由：
//   ① 关系账量级小（几千行），storage.local 的「整值序列化」代价可接受；
//   ② storage.local 在 SW 与页面之间是**同一份**（content script 的 GM_setValue 就是转交 SW 落盘），
//      而 IndexedDB 在 isolated world / SW / 页面之间**各有各的连接**，还得额外做跨上下文同步；
//   ③ 要防的是「写放大」：本文件按 **分片键**（handle 哈希分 16 片）写，不整表重写。
(function () {
  'use strict';
  if (globalThis.XPROBE_REL) return;

  const NS = 'ysy.xprobe.rel';
  const SHARDS = 16;               // 分片数：写放大从「整表一次」降到「一片一次」
  const MAX_OBS = 4000;           // 观测行上限（每人最近若干次），超了丢最旧的
  const MAX_USERS = 4000;          // 关系快照上限

  // 键名：ysy.xprobe.rel.u.<分片号> / ysy.xprobe.rel.o.<分片号>
  // 每片的值是**数组**（一整片的关系行）—— 与本仓既有的 ysy.xprobe.users 同一形状（那也是一个键装一张表）。
  // 为什么不用「每行一个键」：chrome.storage.local 的键是扁平的，handle 里可能有怪字符，
  // 而按分片存数组既能一次读写一片、又能避开 handle 做键名。
  function shardOf(handle, salt) {
    const s = String(handle || '') + '|' + (salt || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h % SHARDS;
  }
  const shardKey = (kind, n) => NS + '.' + kind + '.' + n;
  // 一行在片内的小键（viewer+handle 拼成一行，handle 已被小写化且只含字母数字下划线）
  const rowKey = (viewer, handle) => String(viewer || '') + '|' + String(handle || '').toLowerCase();

  // ---- storage 适配（chrome.storage.local；自检沙箱里没有 chrome 时退化成内存）----
  const mem = {};
  function sGet(keys) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return chrome.storage.local.get(keys.length ? keys : null).then((r) => r || {});
      }
    } catch (e) { /* 沙箱 */ }
    const out = {};
    (keys || []).forEach((k) => { if (mem[k] !== undefined) out[k] = mem[k]; });
    return Promise.resolve(out);
  }
  function sSet(obj) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return chrome.storage.local.set(obj).then(() => ({ ok: true }));
      }
    } catch (e) { /* 沙箱 */ }
    Object.keys(obj).forEach((k) => { mem[k] = obj[k]; });
    return Promise.resolve({ ok: true });
  }
  function sRemove(keys) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return chrome.storage.local.remove(keys).then(() => ({ ok: true }));
      }
    } catch (e) { /* 沙箱 */ }
    (keys || []).forEach((k) => { delete mem[k]; });
    return Promise.resolve({ ok: true });
  }

  function clip(s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n) : t;
  }

  // ---- 写：一条关系快照（upsert）+ 可选一条观测 ----
  // viewer  = 观察者（哪个登录账号在看），handle = 对方
  // rel     = 'following' | 'not_following' | ''（没读到，不许猜）
  // at      = 这次观测时刻（ISO）
  // source  = 从哪条腿读到的（'btn' 按钮 / 'bridge' 桥读数 / 'ledger' 台账 / 'list' 列表）
  function putUser(viewer, handle, rel, at, source) {
    const h = String(handle || '').toLowerCase();
    if (!h) return Promise.resolve({ ok: false, err: '没有 handle' });
    const v = String(viewer || '');
    const now = Date.now();
    const row = {
      viewer: v, handle: h,
      relationship: rel == null ? '' : String(rel),
      sourceType: clip(source || '', 24),
      firstSeenAt: (at && String(at)) || new Date(now).toISOString(),
      lastSeenAt: (at && String(at)) || new Date(now).toISOString(),
      updatedAt: now,
    };
    const sk = shardKey('u', shardOf(h));
    const rk = rowKey(v, h);
    return sGet([sk]).then((r) => {
      const arr = Array.isArray(r && r[sk]) ? r[sk].slice() : [];
      const idx = arr.findIndex((x) => x && x.rowKey === rk);
      if (idx >= 0 && arr[idx].firstSeenAt) row.firstSeenAt = arr[idx].firstSeenAt;  // 第一次见到的时刻不许被刷掉
      row.rowKey = rk;
      if (idx >= 0) arr[idx] = row; else arr.push(row);
      // 超上限丢最旧的一批（按 updatedAt 升序找最旧的丢）
      if (arr.length > MAX_USERS) {
        arr.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
        arr.splice(0, arr.length - MAX_USERS);
      }
      const o = {}; o[sk] = arr;
      return sSet(o).then(() => putObs(viewer, handle, rel, at, source));
    });
  }

  function putObs(viewer, handle, rel, at, source) {
    const h = String(handle || '').toLowerCase();
    if (!h) return Promise.resolve({ ok: false, err: '没有 handle' });
    const v = String(viewer || '');
    const sk = shardKey('o', shardOf(h));
    const row = {
      viewer: v, handle: h, rowKey: rowKey(v, h),
      relationship: rel == null ? '' : String(rel),
      sourceType: clip(source || '', 24),
      observedAt: (at && String(at)) || new Date().toISOString(),
      seq: Date.now(),
    };
    return sGet([sk]).then((r) => {
      const arr = Array.isArray(r && r[sk]) ? r[sk].slice() : [];
      // 同一刻同一关系不重复记（重绘、重扫都会重复看到同一颗钮）
      const dup = arr.some((x) => x && x.observedAt === row.observedAt && x.relationship === row.relationship);
      if (!dup) arr.push(row);
      arr.sort((a, b) => String(a && a.observedAt || '') < String(b && b.observedAt || '') ? -1 : 1);
      const cut = arr.length > MAX_OBS ? arr.slice(arr.length - MAX_OBS) : arr;
      const o = {}; o[sk] = cut;
      return sSet(o);
    });
  }

  // ---- 读 ----
  function getUser(viewer, handle) {
    const sk = shardKey('u', shardOf(handle));
    const rk = rowKey(viewer, handle);
    return sGet([sk]).then((r) => {
      const arr = (r && r[sk]) || [];
      const hit = Array.isArray(arr) ? arr.find((x) => x && x.rowKey === rk) : null;
      return hit || null;
    });
  }
  // 取一个人的全部观测（升序）
  function getObs(viewer, handle) {
    const sk = shardKey('o', shardOf(handle));
    const rk = rowKey(viewer, handle);
    return sGet([sk]).then((r) => {
      const arr = (r && r[sk]) || [];
      if (!Array.isArray(arr)) return [];
      return arr.filter((x) => x && x.rowKey === rk)
        .sort((a, b) => String(a && a.observedAt || '') < String(b && b.observedAt || '') ? -1 : 1);
    });
  }
  // 取某个 viewer 的全部关系快照（扫全部分片）
  function listUsers(viewer) {
    const v = String(viewer || '');
    const keys = [];
    for (let i = 0; i < SHARDS; i++) keys.push(shardKey('u', i));
    return sGet(keys).then((r) => {
      const out = [];
      Object.keys(r || {}).forEach((k) => {
        const arr = r[k];
        if (!Array.isArray(arr)) return;
        arr.forEach((x) => { if (x && (!v || x.viewer === v)) out.push(x); });
      });
      out.sort((a, b) => String(a && a.lastSeenAt || '') < String(b && b.lastSeenAt || '') ? 1 : -1);
      return out.slice(0, MAX_USERS);
    });
  }
  function countObs() {
    const keys = [];
    for (let i = 0; i < SHARDS; i++) keys.push(shardKey('o', i));
    return sGet(keys).then((r) => {
      let n = 0;
      Object.keys(r || {}).forEach((k) => { if (Array.isArray(r[k])) n += r[k].length; });
      return n;
    });
  }
  // 清空（切账号/清数据时用）
  function clear(viewer) {
    const v = String(viewer || '');
    const keys = [];
    for (let i = 0; i < SHARDS; i++) { keys.push(shardKey('u', i)); keys.push(shardKey('o', i)); }
    return sGet(keys).then((r) => {
      const dead = [];
      Object.keys(r || {}).forEach((k) => {
        const arr = r[k];
        if (!Array.isArray(arr)) return;
        const keep = arr.filter((x) => x && v && x.viewer !== v);
        if (keep.length) { const o = {}; o[k] = keep; sSet(o); }
        else dead.push(k);
      });
      return dead.length ? sRemove(dead) : Promise.resolve({ ok: true });
    });
  }

  globalThis.XPROBE_REL = {
    putUser: putUser, putObs: putObs,
    getUser: getUser, getObs: getObs, listUsers: listUsers,
    countObs: countObs, clear: clear,
    NS: NS, SHARDS: SHARDS,
    // SW 消息通道：content script / 面板都通过它读写（一个入口，形状一致）。
    // 消息：{t:'rel', op:'put'|'user'|'obs'|'list'|'count'|'clear', viewer, handle, rel, at, source}
    handle: function (msg) {
      const m = msg || {};
      switch (m.op) {
        case 'put': return putUser(m.viewer, m.handle, m.rel, m.at, m.source);
        case 'user': return getUser(m.viewer, m.handle);
        case 'obs': return getObs(m.viewer, m.handle);
        case 'list': return listUsers(m.viewer);
        case 'count': return countObs().then((n) => ({ ok: true, count: n }));
        case 'clear': return clear(m.viewer);
        default: return Promise.resolve({ ok: false, err: '未知关系账操作 ' + String(m.op || '') });
      }
    },
  };
})();

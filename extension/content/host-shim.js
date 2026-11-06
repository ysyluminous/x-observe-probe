// X 观测探针 —— 宿主适配层（content script，先于 core.js 加载）
// 只做三件事，而且是收窄不是扩权：
//   ① GM_getValue / GM_setValue 落到 chrome.storage.local：同步读靠内存缓存，先水合再让 core 起观察者。
//   ② GM_xmlhttpRequest 转给 service worker 代发，且只允许打本机 sink。
//      白名单在这里和 sw.js 各写一遍（纵深防御）：指向 x.com/twitter.com 的地址一律拒发
//      ⇒「零对 X 的请求」从此不只是自觉，是边界上拦得住的规则。
//   ③ 多标签页并发写同一份存储时收敛：共享键的合并放在 service worker 里串行做（它单线程）。
//   ④ 给存储记账（globalThis.__XP_STORE__）：每键字节数、总额、写失败原因。配额是 10MB，
//      超了 chrome 只会往控制台丢一句 lastError，页面这边一律静默 ⇒ 必须自己读、自己说。
// 反检测口径：content script 在 isolated world，页面 JS 看不到这里挂的 globalThis 名字；
// 这一层不注入页面、不改 DOM、不读写 cookie、不拦截网络。
(function () {
  'use strict';

  const SINK_PREFIXES = ['http://127.0.0.1:8765/', 'http://localhost:8765/'];
  // v0.6.9 多了一个 ysy.xprobe.queue：sink 断线时把待发记录落到扩展存储（精简快照），
  // 这也是一份「多个标签页各写各的」共享键 ⇒ 必须走 SW 串行合并，否则后写的标签页会把别人的待发挤掉。
  const SHARED = ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.v1', 'ysy.xprobe.series', 'ysy.xprobe.queue'];

  const cache = {};
  let readyResolve = null;
  const ready = new Promise((res) => { readyResolve = res; });
  globalThis.__XP_HOST_READY__ = ready;

  // 存储账本：core 的面板要靠它说真话。上一轮的教训就是这里吞了写失败 ——
  // chrome.storage.local.set 不带回调时，超配额只会变成控制台里那句
  // "Unchecked runtime.lastError: Resource::kQuotaBytes quota exceeded"，页面与面板都不知情，
  // 于是 400 份快照顶穿 10MB 之后，守卫台账和两张表静默停止持久化了好几轮。
  const STORE_QUOTA = 10 * 1024 * 1024;
  // v0.7.1：manifest 申请了 unlimitedStorage ⇒ 10MB 不再是硬限。面板必须照实说「不限量」，
  // 不能继续拿 10MB 算百分比（那会让人以为快满了，也会在 70% 时误报黄字）。
  let UNLIMITED = false;
  try { UNLIMITED = (chrome.runtime.getManifest().permissions || []).indexOf('unlimitedStorage') >= 0; } catch (e) { UNLIMITED = false; }
  const storeStat = {
    bytes: {}, total: 0, quota: UNLIMITED ? 0 : STORE_QUOTA, unlimited: UNLIMITED, writes: 0, failed: 0, quotaHit: 0,
    lastErr: '', lastErrAt: '', err: {}, measured: false,
  };
  globalThis.__XP_STORE__ = storeStat;

  function b8(v) {
    let s = '';
    try { s = JSON.stringify(v); } catch (e) { return 0; }
    if (typeof TextEncoder === 'function') { try { return new TextEncoder().encode(s).length; } catch (e) { /* 按字符数近似 */ } }
    return s.length;
  }
  function measure(items) {
    try {
      const src = items || {};
      const b = {}; let total = 0;
      Object.keys(src).forEach((k) => { const n = b8(src[k]); b[k] = n; total += n; });
      storeStat.bytes = b; storeStat.total = total; storeStat.measured = true;
    } catch (e) { /* 测量坏了不影响读写 */ }
  }
  function noteErr(key, msg) {
    const s = String(msg || '未知错误');
    storeStat.err[key] = s; storeStat.failed += 1;
    if (/quota|配额/i.test(s)) storeStat.quotaHit += 1;
    storeStat.lastErr = s; storeStat.lastErrAt = new Date().toISOString();
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message || 'runtime 无响应')); else resolve(reply);
        });
      } catch (err) { reject(err); }
    });
  }
  function only(key, value) { const o = {}; o[key] = value; return o; }

  // 存储：同步读 + 乐观写（本地立刻可见，落盘与合并交 SW）
  // 写失败不再静默：SW 那边带回调读 lastError，回不到 SW 时这里直写也必须带回调。
  function put(key, value) {
    cache[key] = value;
    storeStat.writes += 1;
    storeStat.bytes[key] = b8(value);
    let total = 0; Object.keys(storeStat.bytes).forEach((k) => { total += storeStat.bytes[k] || 0; });
    storeStat.total = total;
    send({ t: 'store', shared: SHARED.indexOf(key) >= 0, key: key, value: value }).then((reply) => {
      if (reply && reply.ok && reply.merged !== undefined) {
        cache[key] = reply.merged;
        storeStat.bytes[key] = b8(reply.merged);
        delete storeStat.err[key];
      } else if (reply && !reply.ok) {
        noteErr(key, reply.err || 'SW 写失败（未报原因）');
      }
    }, () => {
      try {
        chrome.storage.local.set(only(key, value), () => {
          const e = chrome.runtime.lastError;
          if (e) noteErr(key, e.message || '直写失败');
          else delete storeStat.err[key];   // 成功一次把逐键的错误抹掉（错误不许烂尾在面板上）
        });
      } catch (err) { noteErr(key, (err && err.message) || '直写抛异常'); }
    });
  }
  globalThis.GM_getValue = (k, d) => (cache[k] === undefined ? d : cache[k]);
  globalThis.GM_setValue = (k, v) => { put(k, v); };
  globalThis.GM_deleteValue = (k) => { delete cache[k]; put(k, null); };

  // 网络：只允许回环 sink，其余当场拒发（core 记成 err 并把批次留在暂存队列里重试）
  function loopbackOnly(url) {
    const s = String(url || '');
    for (let i = 0; i < SINK_PREFIXES.length; i++) if (s.indexOf(SINK_PREFIXES[i]) === 0) return true;
    return false;
  }
  globalThis.GM_xmlhttpRequest = (o) => {
    const cb = o || {};
    const fail = (msg) => { if (typeof cb.onerror === 'function') cb.onerror({ status: 0, msg: String(msg) }); };
    if (!loopbackOnly(cb.url)) { fail('非本机地址，适配层拒发: ' + String(cb.url).slice(0, 60)); return; }
    send({ t: 'xhr', method: cb.method || 'GET', url: cb.url, headers: cb.headers || {}, data: cb.data, timeout: cb.timeout || 8000 })
      .then((r) => {
        if (!r) { fail('中继无响应'); return; }
        if (r.timeout) { if (typeof cb.ontimeout === 'function') cb.ontimeout({ status: 0, msg: 'timeout' }); return; }
        if (r.err) { fail(r.err); return; }
        // via = SW 实际走的通道（native / http）。以前这一层把它丢了，于是日志里只能看到
        // 「写到本机了」，看不出是宿主还是回环 HTTP 写的 —— 排查「宿主装没装对」时缺的就是这一格。
        if (typeof cb.onload === 'function') cb.onload({ status: r.status | 0, responseText: String(r.responseText || ''), via: r.via || '' });
      }, (e) => fail(e && e.message));
  };

  function hydrate(src) {
    try { Object.keys(src || {}).forEach((k) => { cache[k] = src[k]; }); } catch (e) { /* 空缓存起，core 显示基线 */ }
    measure(src);   // 起始占用从这份全量 items 量，之后靠 onChanged 增量维护
    if (readyResolve) { readyResolve(); readyResolve = null; }
  }
  try {
    chrome.storage.local.get(null, (items) => {
      const e = chrome.runtime.lastError;   // get 的错误也只放 lastError；不读一句就又是控制台那句 Unchecked runtime.lastError
      if (e) { try { console.warn('[xprobe] storage 水合失败，按空存储起: ' + (e.message || e)); } catch (e2) { /* 忽略 */ } }
      hydrate(e ? null : items);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      Object.keys(changes).forEach((k) => {
        const nv = changes[k].newValue;
        if (nv === undefined) { delete cache[k]; delete storeStat.bytes[k]; }
        else { cache[k] = nv; storeStat.bytes[k] = b8(nv); }
      });
      let total = 0; Object.keys(storeStat.bytes).forEach((kk) => { total += storeStat.bytes[kk] || 0; });
      storeStat.total = total;
    });
  } catch (e) {
    hydrate(null);   // 拿不到 storage（比如自检环境）也要让 core 起得来
  }
  setTimeout(() => { if (readyResolve) { readyResolve(); readyResolve = null; } }, 1200);
})();

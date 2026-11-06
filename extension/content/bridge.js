// X 观测探针 —— 关系读数桥（v0.11.8）。**主世界**（manifest: world=MAIN, document_start）里的一份只读信使。
// 为什么必须有它：X 把每个作者的关系读数（following = 我关注 TA，followed_by = TA 关注你）随时间线/列表
// 一起带回页面，但它们不在 DOM 字面上 —— 住在两类「页面自己的 JS 对象」里：React 组件树（DOM 节点的
// `__reactFiber$*` 属性）与 X 自己的 Redux store（`entities.users`，挂在 `#react-root` 的 `__reactProps$`
// 链上）。这两样在 isolated world 都读不到 ⇒ 得有主世界这一份。参考插件（「不是兄弟」，dioanb…）的
// page-bridge 就是这三条源，v0.11.8 起我们对齐它的全部三条（此前只搬了最弱的 fiber 一条，时间线行上
// 挂不着读数 ⇒ 判不出）：
//   ① fetch/XHR **只读旁听**：包一层，回包 clone() 一份来读，请求与响应原样放行 —— 不改一个字节、
//      不拦不分流（RL-2 红线的口径自这版更新为「只读旁听」：绝不发自己的请求，只听 X 自己的）；
//   ② Redux store：entities.users 是大头（X 自己把回包里的用户规整进去），外加整棵 state 的有界泛爬；
//   ③ fiber 上下爬：行容器往上 24 层 + 向下 child/sibling 28 层（参考插件同款深度与 500 人上限）。
// 纪律不变：**没有观察器、没有定时器** —— 只有 core.js 攒够了 handle 才问一声（window.postMessage，
// 一次一问一答、都带自家记号 ysy-xprobe-rel-bridge，别人的消息一个字不读），回完就静默；
// 页面节点一个字节不写，问不到的 handle 绝不发请求去补。
(function () {
  'use strict';
  const SRC = 'ysy-xprobe-rel-bridge';
  try {
    if (window.__ysyXprobeRelBridge) return;   // 重复注入只装一份
    window.__ysyXprobeRelBridge = true;
  } catch (e) { return; }

  // handle 判据与 core 同一口径：1~15 位字母数字下划线；保留段（导航页）不当 handle。
  const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;
  const RESERVED = { home: 1, explore: 1, notifications: 1, messages: 1, i: 1, settings: 1, compose: 1,
    search: 1, jobs: 1, communities: 1, tos: 1, privacy: 1, login: 1, signup: 1, premium: 1 };
  const ob = (x) => (x && typeof x === 'object' ? x : null);
  function firstBool() {
    for (let i = 0; i < arguments.length; i++) if (typeof arguments[i] === 'boolean') return arguments[i];
    return null;
  }
  // 从一个「用户结果」形状里抠 handle 与两个布尔。四处都认（真机回包里字段位置换过几轮）：
  // 顶层 / legacy / relationship_perspectives / relationship —— 哪格有布尔用哪格，都没有就回 null
  //（不冒充读数）。v0.11.11 补第四格：现代 X 回包（HomeTimeline 等）把布尔住在 result.relationship
  // 这个子对象里 —— 此前漏认它，时间线回包里明明带着读数却收不到，首趟只能拿台账半截证据出虚线。
  function relUserOf(e) {
    const o = ob(e);
    if (!o) return null;
    const leg = ob(o.legacy) || {};
    const rp = ob(o.relationship_perspectives) || {};
    const rs = ob(o.relationship) || {};
    const core = ob(o.core) || {};
    const raw = o.screen_name ?? o.screenName ?? leg.screen_name ?? leg.screenName ?? core.screen_name ?? o.username ?? '';
    const m = HANDLE_RE.exec(String(raw).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim());
    if (!m || RESERVED[m[1].toLowerCase()]) return null;
    const following = firstBool(o.following, leg.following, rp.following, rs.following);
    const followsYou = firstBool(o.followed_by, leg.followed_by, rp.followed_by, rs.followed_by);
    if (following === null && followsYou === null) return null;
    return { h: m[1].toLowerCase(), f: following, y: followsYou };
  }
  // 同一 handle 的两条读数逐格合并（v0.11.13 起：boolean 才落格、**新读数赢旧读数**）。
  // 旧口径「先到先得」有个坑：推荐位/旧载荷里的 followed_by:false 先进账，时间线回包里
  // 更新的 true 就永远进不来——真机「有概率和不是兄弟不一样」的另一来源。null 仍然不抹读数
  //（很多载荷只带半截关系）。
  function put(map, u) {
    if (!u) return;
    const old = map.get(u.h);
    if (!old) { map.set(u.h, { following: u.f, followsYou: u.y }); return; }
    // 调用方传的是 relUserOf 的返回形状 {h, f, y}（不是 {following, followsYou}）——字段名错了
    // 覆盖分支永远读到 undefined、新读数一条都进不来（v0.11.13 自检抓出）
    if (typeof u.f === 'boolean') old.following = u.f;
    if (typeof u.y === 'boolean') old.followsYou = u.y;
  }
  // 帖子结果形状归一：__typename=Tweet 本体 / .tweet / .result / tweet_results.result / tweetResult.result
  function tweetOf(e) {
    if (!ob(e)) return null;
    if (e.__typename === 'Tweet' || ob(e.core) || ob(e.legacy)) return e;
    if (ob(e.tweet)) return e.tweet;
    const r = ob(e.result);
    if (r && (r.__typename === 'Tweet' || ob(r.core))) return r;
    if (ob(ob(e.tweet_results) && e.tweet_results.result)) return e.tweet_results.result;
    if (ob(ob(e.tweetResult) && e.tweetResult.result)) return e.tweetResult.result;
    return null;
  }
  // 有形状地爬一条帖子结果（同参考插件的 c()）：本体/引用帖/转帖各认一遍，visited 防环。
  function scanTweet(e, out, seen) {
    if (!ob(e) || seen.has(e)) return;
    seen.add(e);
    put(out, relUserOf(e));
    put(out, relUserOf(e.user));
    const n = tweetOf(e) || e;
    const core = ob(n.core);
    let ur = ob(core && core.user_results) || ob(n.user_results) || ob(e.user_results);
    if (!ur) {
      const ic = ob(e.itemContent);
      const trr = ic && ob(ob(ic.tweet_results) && ic.tweet_results.result);
      ur = trr && ob(trr.core) && ob(trr.core.user_results);
    }
    if (ur) put(out, relUserOf(ob(ur.result)));
    if (ob(n.quoted_status_result)) scanTweet(n.quoted_status_result, out, seen);
    const leg = ob(n.legacy);
    if (leg && ob(leg.retweeted_status_result)) scanTweet(leg.retweeted_status_result, out, seen);
  }
  // 有界的泛爬（参考插件同款预算：18000 节点 / 40 层）：回包 JSON 与 store state 都过这一遍，
  // 形状判据之外的兜住。到限即停，炸不了也拖不死。
  // ⚠ walk 自己的 seen 是防环用的（store state 有环），不能传给 scanTweet——
  //   否则「walk 先 add、scanTweet 见 has 就退」= 泛爬整条腿一个用户都扫不出来（v0.11.8 真机教训）。
  //   scanTweet 拿自己那一趟的 Set 做引用帖/转帖递归的防环，两本账分家。
  function genericWalk(v0, out) {
    const seen = new Set();
    const budget = { n: 18000 };
    const walk = (v, depth) => {
      if (budget.n <= 0 || depth > 40 || v == null || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      budget.n -= 1;
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], depth + 1); return; }
      scanTweet(v, out, new Set());
      const vs = Object.values(v);
      for (let i = 0; i < vs.length; i++) walk(vs[i], depth + 1);
    };
    walk(v0, 0);
  }
  // fiber 上下爬：往上 24 层（v）+ 向下 child/sibling 28 层（w，人数到 500 收手）——参考插件同款。
  // v0.11.7 只往上爬是它判不出的原因之一：行容器的祖先链上未必挂得有关系读数，子孙组件的 props 里才有。
  function fiberClimb(f, out, seen) {
    for (let i = 0; i < 24 && f; i++) {
      scanTweet(f.memoizedProps, out, seen);
      scanTweet(f.pendingProps, out, seen);
      f = f.return;
    }
  }
  function fiberDown(f, depth, out, seen) {
    if (depth > 28 || out.size >= 500 || !ob(f) || seen.has(f)) return;
    seen.add(f);
    scanTweet(f.memoizedProps, out, seen);
    scanTweet(f.pendingProps, out, seen);
    fiberDown(f.child, depth + 1, out, seen);
    fiberDown(f.sibling, depth + 1, out, seen);
  }
  function reactKey(el, prefix) {
    try {
      const ks = Object.getOwnPropertyNames(el);
      for (let i = 0; i < ks.length; i++) if (ks[i].indexOf(prefix) === 0) return ks[i];
    } catch (e) { /* 非 DOM/读不了：没有就没有 */ }
    return '';
  }
  // ② Redux store：从 #react-root 首子的 __reactProps$ 链上找 {store:{getState}}（深 10），
  //    entities.users 整把抓 + 整棵 state 有界泛爬。X 自己把回包里的用户规整进 store，
  //    这是最稳的一条源 —— 时间线行 fiber 上没有的读数，store 里多半有。
  function storeFromProps(p, depth, seen) {
    if (depth > 10 || !ob(p) || seen.has(p)) return null;
    seen.add(p);
    if (ob(p.store) && typeof p.store.getState === 'function') return p.store;
    return storeFromProps(p.children, depth + 1, seen) || storeFromProps(p.props, depth + 1, seen);
  }
  function harvestStore(out) {
    let root = null;
    try { root = document.querySelector('#react-root') || document.querySelector('[data-reactroot]'); } catch (e) { root = null; }
    if (!root) return;
    const host = root.firstElementChild || (root.children && root.children[0]) || root;
    const kp = reactKey(host, '__reactProps$');
    if (!kp) return;
    let store = null;
    try { store = storeFromProps(host[kp], 0, new Set()); } catch (e) { store = null; }
    if (!store) return;
    let state = null;
    try { state = store.getState(); } catch (e) { state = null; }
    if (!ob(state)) return;
    try {
      const ents = ob(state.entities);
      const users = ents && ob(ents.users);
      const list = users && (ob(users.entities) || users);
      if (list) for (const k of Object.keys(list)) put(out, relUserOf(list[k]));
    } catch (e) { /* 形状变了就靠 fiber 与旁听兜 */ }
    try { genericWalk(state, out); } catch (e) { /* 有界，炸不了 */ }
  }
  function harvestFiber(out) {
    let els = [];
    try { els = document.querySelectorAll('article, [data-testid="tweet"], [data-testid="cellInnerDiv"], [data-testid="UserCell"]'); } catch (e) { els = []; }
    const roots = [];
    try { const rr = document.querySelector('#react-root'); if (rr) roots.push(rr); } catch (e) { /* 没有就没有 */ }
    for (let i = 0; i < els.length && roots.length < 120; i++) roots.push(els[i]);
    const seen = new Set();
    for (let i = 0; i < roots.length && out.size < 500; i++) {
      const kf = reactKey(roots[i], '__reactFiber$') || reactKey(roots[i], '__reactInternalInstance$');
      if (!kf) continue;
      const f = roots[i][kf];
      fiberClimb(f, out, seen);
      fiberDown(f, 0, out, seen);
    }
  }
  // ① fetch/XHR 只读旁听（document_start 就包上，X 的包还没跑）：回包 clone() 一份来读，
  //    请求与响应原样放行 —— 不改参数、不换响应、不 abort。旁听攒进 netMap（逐格合并），
  //    问询来了直接用 —— 「动态刷新」的数据底座：X 什么时候拉新时间线，这里就什么时候有新读数。
  const netMap = new Map();
  const GQL_RE = /\/i\/api\/graphql\//;
  // v0.11.11：旁听攒进 netMap 之外，还把「这趟刚学到/翻面」的 delta 主动推给 core（type:'push'）。
  // 为什么必须有推：core 只在它的节拍上问（15s 节流的一次一问一答），X 每次带读数的回包
  //（时间线刷新、名片、hovercard…）却随时到 —— 此前数据在 netMap 里躺着，core 要等下一问才拿得到，
  // 体感就是「得悬浮头像等三秒才翻对」。快照对比泛爬前后的 netMap，只推「新学到 / 翻面」的条目
  //（不广播全量；core 没监听时这条消息丢了也无害，问询兜底）。依旧没有定时器没有观察器。
  function harvestJson(v) {
    try {
      // 快照必须**逐格拷贝**，不能存引用：put() 是原地改 netMap 的值对象——存引用的话
      // before 与 after 是同一个对象，对比永远相等，delta（含翻面）一条都推不出去（v0.11.13 自检抓出）
      const before = new Map();
      for (const [k, b] of netMap) before.set(k, { following: b.following, followsYou: b.followsYou });
      genericWalk(v, netMap);
      const delta = {};
      let n = 0;
      // 判「新」 = 新学到（此前没有）**或翻面**（布尔值变了，v0.11.13：put 改新读数赢旧读数后，
      // 翻面是真实事件——X 最新回包说关系变了，core 那头要当场改判，不能等下一问）
      for (const [k, b] of netMap) {
        const old = before.get(k);
        const fNew = typeof b.following === 'boolean' && (!old || old.following !== b.following);
        const yNew = typeof b.followsYou === 'boolean' && (!old || old.followsYou !== b.followsYou);
        if (fNew || yNew) { delta[k] = { following: b.following, followsYou: b.followsYou }; n++; }
      }
      if (n) window.postMessage({ source: SRC, type: 'push', users: delta }, window.location.origin);
    } catch (e) { /* 有界，炸不了；推不出去也有问询兜底 */ }
  }
  function urlOf(u) {
    if (typeof u === 'string') return u;
    if (u && typeof u === 'object' && typeof u.url === 'string') return u.url;
    return '';
  }
  function hookNet() {
    try {
      const origFetch = window.fetch.bind(window);
      window.fetch = async (...a) => {
        const res = await origFetch(...a);
        try {
          if (GQL_RE.test(urlOf(a[0])) && res && res.ok) res.clone().json().then(harvestJson).catch(() => {});
        } catch (e) { /* 旁听不动请求本身 */ }
        return res;
      };
    } catch (e) { /* 包不上就算了，还有 store/fiber 两条 */ }
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m0, u0) {
        try {
          if (GQL_RE.test(urlOf(u0))) {
            this.addEventListener('load', () => {
              try { if (this.status >= 200 && this.status < 300) harvestJson(JSON.parse(this.responseText)); } catch (e) { /* 不是 JSON 就不是 */ }
            });
          }
        } catch (e) { /* 旁听不动请求本身 */ }
        return origOpen.apply(this, arguments);
      };
    } catch (e) { /* 同上 */ }
  }
  hookNet();
  // 一次一问一答：只认自家记号；问询带 handles 就只回这几个人（回包小、页面上别的账号不外送）。
  window.addEventListener('message', (ev) => {
    let d = null;
    try { if (ev.source !== window) return; d = ev.data; } catch (e) { return; }
    try {
      if (!d || d.source !== SRC || d.type !== 'query' || typeof d.id !== 'string') return;
      const want = Array.isArray(d.handles)
        ? d.handles.slice(0, 80).map((x) => String(x).toLowerCase()) : null;
      const out = new Map();
      for (const [k, v] of netMap) put(out, { h: k, f: v.following, y: v.followsYou });
      harvestStore(out);
      harvestFiber(out);
      const users = {};
      for (const [k, v] of out) {
        if (want && want.indexOf(k) < 0) continue;
        if (typeof v.following !== 'boolean' && typeof v.followsYou !== 'boolean') continue;
        users[k] = { following: v.following, followsYou: v.followsYou };
      }
      window.postMessage({ source: SRC, type: 'result', id: d.id, users: users }, window.location.origin);
    } catch (e) {
      try { window.postMessage({ source: SRC, type: 'result', id: d.id, users: {} }, window.location.origin); } catch (e2) { /* 回不了就让对面超时解锁 */ }
    }
  });
})();

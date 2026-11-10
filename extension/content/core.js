// X 观测探针 —— MV3 扩展的 content script 核心。
// 由 x-observe-probe.user.js v0.4.0 搬过来（油猴那份从此冻结），判定逻辑一字未动：
// 只读 DOM、零对 X 的请求、到限只警告。换的只是「壳」：
//   GM_getValue / GM_setValue / GM_xmlhttpRequest 由 content/host-shim.js 在同一个 isolated world
//   里先挂到 globalThis（背后是 chrome.storage.local + service worker 的网络中继）。
//   自检沙箱挂的是同样三个名字 ⇒ 原来那批断言仍然打得中这一份。
// 页面里我只留一个节点（右下角浮标），详面板搬到扩展自己的 Side Panel ⇒ 注入节点归零是这次换壳的真收益。
(function () {
  'use strict';
  const VER = '0.11.18';

  const BUILD = '2026-11-10-a';   // 换版必改：日志/Side Panel/浮标里靠它确认跑的是哪一份代码
  const SINK = 'http://127.0.0.1:8765';
  const STORE_KEY = 'ysy.xprobe.v1';
  // 浏览器这边只留「运行态」，整页原文的去处是本机 xprobe.db（sink-9）。
  // 上一轮的实证：400 份全量快照实测 13.05MB（真机 ndjson 里最近 400 条 page 记录 = 13,687,801 字节） ⇒ 顶穿 chrome.storage.local 的 10MB 配额，
  // 而写失败被适配层与 SW 双双静默吞掉 ⇒ 守卫台账、趋势点、两张表一起停止持久化，
  // 面板上只看得到「数字不动了」。所以留法改成：最新 RUNS_FULL 份全量 + 往前 RUNS_SLIM 份精简行。
  const RUNS_FULL = 6;
  const RUNS_SLIM = 20;
  const RUNS_KEEP = RUNS_FULL + RUNS_SLIM;
  const RUNS_BYTES_CAP = 2 * 1024 * 1024;   // 这个键的软顶：到顶先从最旧那份丢，不等配额炸

  // ---------- 数字：从任意串里抠第一个数，并判定它是精确值还是缩写 ----------
  const UNIT = { '': 1, K: 1e3, M: 1e6, B: 1e9, '万': 1e4, '亿': 1e8, '十亿': 1e9 };
  const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(K|M|B|万|亿|十亿)?/i;

  function firstNumber(src) {
    if (src == null) return null;
    const s = String(src).replace(/\u00a0/g, ' ');
    const m = s.match(NUM_RE);
    if (!m) return { src: clip(s, 40), token: '', value: null, exact: null, why: 'no-number' };
    const token = m[0].trim();
    const after = s.slice((m.index || 0) + token.length, (m.index || 0) + token.length + 2);
    const plus = /^\s*\+/.test(after);
    const unit = (m[2] || '').toUpperCase();
    const mult = UNIT[unit] == null ? 1 : UNIT[unit];
    const head = Number(m[1].replace(/,/g, ''));
    if (!isFinite(head)) return { src: clip(s, 40), token, value: null, exact: null, why: 'nan' };
    return {
      src: clip(s, 60),
      token,
      value: Math.round(head * mult),
      exact: unit === '' && !plus,
      why: unit ? 'abbrev' : plus ? 'plus' : 'plain',
    };
  }

  function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  // 宿主标识：同一份逻辑既可能被扩展跑、也可能被冻结的油猴副本跑，日志必须分得清是谁发的。
  // （真机 2026-10-22：13:41:56.598 ver=0.3.0 与 13:41:56.794 ver=0.5.0 相隔 196ms 各采同页一次 ⇒ 两个宿主同时在跑）
  const HOST = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ? 'ext' : 'monkey';

  // 第三方注入：真机日志里 xro-badge 出现 416 次、xro-observer-panel 52 次，还有 xro-user-card-avatar-stack
  // 直接加在 X 自己的头像容器 class 上。它的文字会混进 textContent ⇒ 名字读出来是「月川互关」这种脏值。
  // 名字里真带「互关」的账号（子想互关、z（互关必回））真机也见过 ⇒ 主判据只能按 DOM 出处剥；
  // v0.6.1 只在 displayNameOf 里补了「行尾状态词」这一条极窄的字符串兜底（裸 互关 仍不剥）
  // v0.6.1：判据改成「class 里有一个 token 以这些前缀开头」。原来那条 [class*="extension"] 是整串子串匹配，
  // 谁也说不好 X 自己的 Emotion 类名里会不会出现这个词——一旦命中，整棵名字子树被判成注入，
  // 真机结果就是 miles_mazy / haopei3 的 displayName=''（nameForeign=3，全被剥光）。
  // 现在 inForeign 把「命中的那个 token」原样带回去，误剥还是真注入，下一轮日志直接给答案。
  const FOREIGN_PREFIX = ['xro-', 'bmc-', 'extension-'];
  function foreignTokenIn(clsStr) {
    const toks = String(clsStr || '').split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      for (let k = 0; k < FOREIGN_PREFIX.length; k++) if (toks[i].indexOf(FOREIGN_PREFIX[k]) === 0) return toks[i];
    }
    return '';
  }
  function foreignTokenOf(node) {
    if (!node) return '';
    let cls = null;
    try { cls = node.getAttribute && node.getAttribute('class'); } catch (e) { return ''; }
    if (cls == null) cls = node.className && node.className.baseVal != null ? node.className.baseVal : node.className;
    return foreignTokenIn(cls);
  }
  // 命中 = 返回那个 token（'' = X 原生节点）
  function inForeign(node, root) {
    let n = node && node.parentElement;
    while (n && n !== root) {
      const t = foreignTokenOf(n);
      if (t) return t;
      n = n.parentElement;
    }
    return foreignTokenOf(root);
  }
  // 探针自己缝进页面的节点（拉黑徽标 data-xprobe="blk"、v0.9.1 主页标星 data-xprobe="bench"）在读文本时同样跳过——那是我写的字、
  // 不是页面的话；混进 cellText/候选回退链会把名字提取带歪（v0.8.5 补五把徽标缝进 UserCell 后暴露；
  // 标星更狠：它就长在主页的 UserName 里，「☆」混进去就成了昵称的一部分）
  function inProbe(node, root) {
    let n = node;
    while (n && n !== root) {
      try {
        if (n.getAttribute && (n.getAttribute('data-xprobe') ||
            String(n.getAttribute('class') || '').split(/\s+/).some((c) => c === BLK_CLS || c === BENCH_BADGE_CLS))) return true;
      } catch (e) { return false; }
      n = n.parentElement;
    }
    return false;
  }
  // 只读文本，但跳过第三方子树：走 TreeWalker，不 clone、不修改页面任何节点
  // keepForeign=true：第三方子树照读（cellText 要的是「行里可见的全文」对照脏样），探针子树仍然跳
  let lastForeign = { n: 0, samples: [], tokens: {} };
  function nativeText(el, keepForeign) {
    if (!el) { lastForeign = { n: 0, samples: [], tokens: {} }; return ''; }
    let out = '';
    const foreign = { n: 0, samples: [], tokens: {} };
    try {
      const w = document.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */, null);
      let t = w.nextNode();
      while (t) {
        if (inProbe(t, el)) { t = w.nextNode(); continue; }
        const hit = keepForeign ? '' : inForeign(t, el);
        if (hit) {
          foreign.n++;
          foreign.tokens[hit] = (foreign.tokens[hit] || 0) + 1;
          if (foreign.samples.length < 3) foreign.samples.push(clip(t.textContent, 20));
        } else out += (t.textContent || '');
        t = w.nextNode();
      }
    } catch (e) { lastForeign = { n: 0, samples: [], tokens: {}, error: true }; return txt(el); }
    const stripped = out.replace(/\s+/g, ' ').trim();
    const all = txt(el);
    // 剥到什么都不剩，而节点里明明有字 ⇒ 判据多半打错了（整棵名字子树被当成注入）。
    // 宁可脏也不要空：脏名两行日志一比就看得出来，空名是数据直接丢了。回退时打上 all=true
    foreign.all = !stripped && !!all;
    lastForeign = foreign;
    return stripped || all;
  }

  // 从 start 往上爬 up 层（不越过 stop），截那段 outerHTML ⇒ 样本要框住「名字该在的那块」，
  // 而不是整行开头 900 字（那全是头像）。名字那串文字落在截出来的窗里才算数：
  // 子树比 cap 长时以 around 为中心开窗（真机的行就是「头像在前、名字在后」，从头截等于没给）
  function regionHtml(stop, start, up, cap, around) {
    let n = start, k = up || 2;
    while (n && n !== stop && k > 0 && n.parentElement) { n = n.parentElement; k--; }
    let s = '';
    try { s = n && n.outerHTML ? n.outerHTML : ''; } catch (e) { s = ''; }
    const c = cap || 700;
    if (s.length <= c) return s;
    const i = around ? s.indexOf(around) : -1;
    if (i < 0) return s.slice(0, c);
    return s.slice(Math.max(0, i - Math.floor(c * 0.3)), i + Math.ceil(c * 0.7));
  }

  // 另一个宿主（冻结的油猴脚本）还在这个页面上注入了节点吗？纯 DOM 只读，不碰它的代码  // 浮标改名（v0.6.0）：油猴那份冻结副本用的就是 #ysy-xprobe-fab，两边同 id ⇒ 页面里出现两个同名节点，
  // 谁 getElementById 都拿到别人的那颗，「隐藏/恢复」会去动别人的按钮。改成自己的名字，
  // 同时把旧 id 当成「同页还有另一个宿主」的探针（见 peerHost）
  const FAB_ID = 'ysy-xprobe-ext-fab';
  const CARD_ID = 'ysy-xprobe-ext-card';   // v0.8.3 本页曝光榜悬浮卡片：只在开着时挂进页面，关闭即整棵摘除
  const BLK_CLS = 'ysy-xprobe-blk';   // v0.8.4 拉黑钮/已拉黑徽标：一颗名字旁一个，靠 class 而不是 id（一份页面里几十个）
  // v0.9.1 个人主页昵称右边那颗标星（标杆开关）。与拉黑徽标同类：**长在 X 的 DOM 里** ⇒ 归 RL-16 总闸管，
  // 关掉时与徽标一起被 badgeSweep() 摘干净、连补过的 position 一起还回去。
  // v0.9.3 起这一族有两颗（主页「标此人」+ 帖子页头「标此帖」），整页**每种最多一颗**，
  // 靠 data-xprobe="bench" 认领、data-bk 分家（缺省 = 标人，兼容 v0.9.1 留在页面里的旧那颗）。
  const BENCH_BADGE_CLS = 'ysy-xprobe-benchb';
  // v0.8.5 右下角钮排：守卫灯（v0.8.15 起：绿「观」/ 冷却与到顶都在圈里读秒，点了发开面板请求）、榜（曝光榜卡片）、回（待回关名单）、关（本页用户列表）——各管各的
  const FABBAR_ID = 'ysy-xprobe-ext-bar';
  const CBTN_ID = 'ysy-xprobe-ext-cbtn';
  const FBTN_ID = 'ysy-xprobe-ext-fbtn';
  const RBTN_ID = 'ysy-xprobe-ext-rbtn';   // v0.8.5 补五：待回关钮（label 带个数；v0.11.3 起 = 名单「未关」那一列的待回关筛选开关，不再是独立页签）
  const FLIST_ID = 'ysy-xprobe-ext-flist';   // 本页用户列表面板：只在开着时挂进页面
  const BBTN_ID = 'ysy-xprobe-ext-bbtn';   // v0.9.0 标杆窗口的钮（label 带人数，与「回」同款胶囊）
  const BENCH_ID = 'ysy-xprobe-ext-bench'; // v0.9.0 标杆窗口：只在开着时挂进页面，关闭整棵摘掉
  const BPBTN_ID = 'ysy-xprobe-ext-bpbtn';   // v0.9.3 标杆帖子窗口的钮（label 带条数，与「标杆」同款胶囊）
  const BENCHP_ID = 'ysy-xprobe-ext-benchp'; // v0.9.3 标杆帖子窗口：只在开着时挂进页面，关闭整棵摘掉
  // v0.11.18 art-020 本页热度榜：右缘列第八颗「热」+ 展开列表（挂在右缘那一列，不另起全屏层） +
  // 推文内流速徽标（RL-16 总闸 HOT_BADGE_KEY 默认关，关掉当场从 X DOM 摘净）。口径见 skills/SKILL.md RL-28。
  const HOTBTN_ID = 'ysy-xprobe-ext-hotbtn';
  const HOTLIST_ID = 'ysy-xprobe-ext-hotlist';
  const HOT_BADGE_CLS = 'ysy-xprobe-hotvel';   // 推文内流速徽标：靠 class 认领，一份页面几十个
  const HOT_BADGE_KEY = 'ysy.xprobe.hotbadge'; // 独立总闸：默认关（与拉黑徽标那道闸分开，互不牵连）
  const PEER_IDS = ['ysy-xprobe-fab', 'ysy-xprobe-panel'];
  let fabApplied = '';              // 上一次真正写进 DOM 的浮标状态（三态只在翻转时写）
  const fabLab = {};                // 钮内 label span（v0.9.5 两段式：label + 角标；id → span）
  const fabCnt = {};                // 钮内角标 span（id → span，没角标 = null）
  let fabRing = null;               // 守卫灯的环形读秒 span（conic-gradient + mask 挖环带）
  let fabActApplied = '~';          // 上一次「哪些钮点亮」的花名册（开着的面板对应的钮）
  function peerHost() {
    for (let i = 0; i < PEER_IDS.length; i++) {
      if (PEER_IDS[i] === FAB_ID) continue;  // 别把自己的浮标认成别的宿主
      try { if (document.getElementById(PEER_IDS[i])) return 'monkey'; } catch (e) { /* 忽略 */ }
    }
    return '';
  }

  // 真机（2026-10-22-b）：UserName 那个 div 的 textContent 把「显示名 @handle 关注了你 · 33分钟」全拼一起，
  // 直接拿整串当显示名是脏的 ⇒ 从第一个 @handle 处切断，再剥掉关系词尾巴
  function displayNameOf(s) {
    let out = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    out = out.replace(/@[A-Za-z0-9_]+[\s\S]*$/, '');
    // 只剥「绝不会出现在名字里」的长尾标记。真机见过显示名就叫「子想互关」，所以裸 互关/关注 不能剥。
    // v0.6.1 补的三条都是第三方观察者脚本的状态词（真机 haopei3 定在名字尾上：'好有钱（互）单向关注'，
    // miles_mazy：'Miles Ma单向关注'）；带「单向/双向/（）」限定的，名字里不会出现。
    const TAIL = /(单向关注|双向关注|互相关注|关注了你|正在关注|已关注|已屏蔽|（互）|\(互\)|Follows you|Following)\s*$/i;
    for (let i = 0; i < 3 && TAIL.test(out); i++) out = out.replace(TAIL, '').trim();
    return clip(out.trim(), 60);
  }

  // 关注关系：原生按钮的 testid 形如 "<数字ID>-follow" / "<数字ID>-unfollow"，aria 是「关注 @x」/「正在关注 @x」。
  // ⚠ 真机这页还挂着第三方脚本注入的 xro-badge--mutual（aria「某人: 互相关注」），那不是 X 的 DOM，
  //    选择器一律认原生后缀，别跟着 xro-* 走。
  const FOLLOW_SEL = '[data-testid$="-follow"], [data-testid$="-unfollow"]';

  // 取关注关系按钮：scope 内第一个原生按钮；给了 handle 就只认 aria 里点名这个 handle 的那个（主页防抓错行）
  function followOf(scope, wantHandle) {
    const o = { testid: '', aria: '', state: '' };
    if (!scope) return o;
    scope.querySelectorAll(FOLLOW_SEL).forEach((b) => {
      if (o.state) return;
      const tid = b.getAttribute('data-testid') || '';
      const aria = b.getAttribute('aria-label') || '';
      if (wantHandle && aria.toLowerCase().indexOf('@' + String(wantHandle).toLowerCase()) < 0) return;
      if (!/-unfollow$/.test(tid) && !/-follow$/.test(tid)) return;
      o.testid = clip(tid, 44);
      o.aria = clip(aria, 60);
      o.state = /-unfollow$/.test(tid) ? 'following' : 'not_following';
    });
    return o;
  }

  const RESERVED = ['home', 'search', 'explore', 'notifications', 'messages', 'compose', 'settings', 'i', 'login', 'signup', 'tos', 'privacy', 'premium', 'verified', 'job'];

  function firstSeg(pathname) { return (pathname || '').replace(/^\/+/, '').split('/')[0] || ''; }

  // 关注/粉丝列表页：URL 是 /<handle>/<列表>，页面头（显示名、粉丝数）并不渲染，主体是 UserCell 行
  const LIST_TABS = ['following', 'followers', 'verified_followers'];
  function listTabFromPath(pathname) {
    const m = String(pathname || '').toLowerCase().match(/^\/[^/]+\/(following|followers|verified_followers)(\/|\?|$)/);
    return m ? m[1] : '';
  }

  function handleFromPath(pathname) {
    const seg = firstSeg(pathname);
    if (!seg) return '';
    if (seg.toLowerCase() === 'home') return '';
    if (RESERVED.includes(seg.toLowerCase())) return '';
    if (/^(i|intent|account)(\/|$)/i.test(seg)) return '';
    return seg.startsWith('@') ? seg.slice(1) : seg;
  }

  // 正文列容器：真机上侧栏「推荐关注」也是 UserCell（/home 上 article 6 个、UserCell 3 个）、趋势也是，
  // 不按正文列取域，列表行数会被推荐位污染成假数据。取不到就返回 null，让调用方明确知道「没有正文列」
  function primaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector('[data-testid="column"]') || null;
  }

  // ---------- 采集 ----------
  // Posts 标签在中文 UI 里是「帖子」，别只认 发帖/推文（真机踩过：认不出 = 帖子数报未命中）
  const POSTS_RE = /post|发帖|帖子|推文/i;

  // v0.8.1：主页头部「5,021 帖子 / 5,021 posts」——显示名下方那行。tab 上没有总数节点
  // （v0.6.0 结案）≠ 页上没有：头部这一行一直在。抓不到就进漏抓清单（header.posts），不编数。
  // v0.8.1-m 真机结案（2026-10-25：全天 1214 条 profile 记录 __headerPosts 全 null，而用户主页截图
  // 明明有「5,255 帖子」）：X 把这行渲染成「数字叶 span + 标签叶 span」挂同一容器（与「正在关注」
  // 锚点同款结构，见 10-22 dump），整句只出现在容器上——只认整句叶从上线起就没在真机上中过。
  // v0.8.1-o 二次结案（用户贴来真机 HTML：<div dir="ltr" class="css-…">5,287 帖子</div>）：这行
  // 根本不是 span 是 **div**，querySelectorAll('span') 连 miss 桶都没它的份。改扫 span,div。
  // 容器整句也认：锚定正则不变、tablist/侧栏照排、候选**比短取胜**（大容器文档序先到，
  // 不比短就会顶掉真行——分析页容器粘连事故同一课）；抓不到时把含「帖子/posts」的候选原文留进
  // __headerPostsMiss，下次改版不用猜。
  function collectHeaderPosts() {
    const hit = [], miss = [];
    document.querySelectorAll('span,div').forEach((n) => {
      let inBar = false;
      try { inBar = !!n.closest('[role="tablist"]') || !!n.closest('[data-testid="sidebarColumn"]'); } catch (e) { /* closest 不可用就只靠文本锚 */ }
      if (inBar) return;
      const t = clip(txt(n), 40);
      if (!t || t.length > 30) return;
      const m = t.match(/^([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:条)?\s*(?:帖子|posts)$/i);
      if (m) {
        const num = firstNumber(m[1]);
        if (num && num.value != null) hit.push({ value: num.value, exact: !!num.exact, token: String(num.token || ''), text: t });
        return;
      }
      if (/帖子|posts/i.test(t) && miss.length < 6) {
        miss.push({ text: t, leaf: !n.querySelector('span'), parent: clip(n.parentElement ? txt(n.parentElement) : '', 40) });
      }
    });
    if (!hit.length) return { value: null, miss };
    hit.sort((a, b) => a.text.length - b.text.length);   // 稳定排序：等长时文档序在先的仍在前
    return hit[0];
  }

  function collectStats(ownHandle) {
    const out = {};
    const foreign = [];
    const own = String(ownHandle == null ? handleFromPath(location.pathname) : ownHandle || '').toLowerCase();
    // 只认「/<本页 handle>/followers|following|verified_followers」这种锚点。
    // 真机 2026-10-22：/zhouuohzz/status/2113227528961970527 上采到的是 /Tiduc2026show/following 6,569 与
    // /Tiduc2026show/verified_followers 5,189（侧栏作者卡/推荐位上的别人的号）⇒ 不收窄就把别人的数写进
    // zhouuohzz 那一行，两张表从源头就是脏的。别的号的锚点原样留在 __foreign 里给我看，但不落表。
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/?@?([^/?#]+)\/(followers|following|verified_followers)(?:[/?#]|$)/i);
      if (!m) return;
      const spans = Array.from(a.querySelectorAll('span')).filter((s) => !s.querySelector('span'));
      const leaf = spans.map((s) => clip(txt(s), 30)).filter(Boolean);
      const rec = {
        href,
        owner: m[1],
        visible: clip(txt(a), 60),
        visibleNum: firstNumber(txt(a)),
        ariaLabel: clip(a.getAttribute('aria-label') || '', 90),
        ariaNum: firstNumber(a.getAttribute('aria-label') || ''),
        title: clip(a.getAttribute('title') || '', 60),
        cellText: clip(txt(a.parentElement), 80),
        leafTexts: leaf.slice(0, 4),
        role: a.getAttribute('role') || '',
        html: a.outerHTML.slice(0, 800),
      };
      if (own && rec.owner.toLowerCase() === own) {
        if (!out[m[2]]) out[m[2]] = rec;   // 同 handle 出现多次（头部 + 侧栏作者卡）时取第一个，别覆盖
      } else if (foreign.length < 6) {
        foreign.push({ href, owner: rec.owner, visible: rec.visible, value: rec.visibleNum.value });
      }
    });
    out.__foreign = foreign;
    out.__ownHandle = own;

    // 中文 UI 实测：主页头部只有「正在关注」和「关注者」两个锚点，粉丝数挂在 verified_followers
    out.__followersSource = out.followers ? 'followers' : (out.verified_followers ? 'verified_followers' : '');

    // 主页头部自报的帖子总数（v0.8.1）：非主页页型上多半是 null，落日点时只在 profile 页型用。
    // 抓不到时 __headerPostsMiss 留候选原文（v0.8.1-m），诊断页/日志能直接看到「页上有帖子字样但为何没认」
    try {
      const hp = collectHeaderPosts();
      out.__headerPosts = hp.value == null ? null : hp;
      out.__headerPostsMiss = hp.value == null ? hp.miss : [];
    } catch (e) { out.__headerPosts = null; out.__headerPostsMiss = []; }

    const tabs = [];
    document.querySelectorAll('[role="tab"]').forEach((t) => {
      const text = txt(t);
      if (!text) return;
      tabs.push({
        text: clip(text, 60),
        ariaLabel: clip(t.getAttribute('aria-label') || '', 80),
        selected: t.getAttribute('aria-selected') || '',
        num: firstNumber(text),
        numInChild: firstNumber(Array.from(t.querySelectorAll('span')).filter((s) => !s.querySelector('span')).map((s) => txt(s)).join(' ')),
      });
    });
    out.__tabs = tabs;
    return out;
  }

  // ---------- 创作者奖励页：90 天「已验证首页时间线曝光」 ----------
  // 我没有这一页的真实 DOM，所以这版刻意是「宽松取数 + 交证据」：关键词命中的最小节点、
  // 区域内每个带数字的叶子、那一段 HTML 原样回传日志，下一轮拿真机证据把判据收成一条。
  // 收窄前宁可多报候选，也不要静默取错数。唯一硬规矩：门槛数字（「累积至少 50 万次」里的 50 万）
  // 绝不能当成我的曝光数落库 —— 那会把一条平线写成 50 万。
  const REWARD_KEY_PAT = /首页时间线曝光|已验证.{0,8}曝光|验证.{0,4}曝光|verified.{0,24}impression/i;

  function numberTokens(s) {
    const out = [];
    const g = new RegExp(NUM_RE.source, 'gi');
    let m;
    while ((m = g.exec(String(s || ''))) && out.length < 12) out.push(m[0].trim().toLowerCase());
    return out;
  }
  function isDescendant(node, ancestor) {
    let n = node && node.parentElement;
    while (n) { if (n === ancestor) return true; n = n.parentElement; }
    return false;
  }
  // 区域内「叶子上的数字」：父节点也收会把子的数字重复一遍，所以带元素的 span 一律跳过
  function leafNumbers(region) {
    const out = [];
    const nodes = region.querySelectorAll('span,b,strong,data,p,li,div');
    for (let i = 0; i < nodes.length && out.length < 24; i++) {
      const n = nodes[i];
      if (n.querySelector('span,b,strong,data,p,li,div')) continue;
      const t = txt(n);
      if (!t || t.length > 60) continue;
      const num = firstNumber(t);
      if (num && num.value != null) out.push({ text: clip(t, 40), token: String(num.token).trim().toLowerCase(), value: num.value, exact: !!num.exact, why: num.why });
    }
    return out;
  }
  function collectRewards() {
    const keys = [];
    const all = document.querySelectorAll('span,div,p,h1,h2,h3,li,label,strong,b');
    for (let i = 0; i < all.length && i < 4000; i++) {
      const t = txt(all[i]);
      if (!t || t.length > 240 || !REWARD_KEY_PAT.test(t)) continue;
      keys.push(all[i]);
      if (keys.length >= 12) break;
    }
    // 丢父留子：外层容器往往也匹配（整块卡片包住那句话），取最里一层，region 才不至于爬到 body
    const minimal = keys.filter((n) => !keys.some((c) => c !== n && isDescendant(c, n)));
    const cands = [];
    let picked = null;
    minimal.slice(0, 4).forEach((n) => {
      const keyText = txt(n);
      const inKey = {};
      numberTokens(keyText).forEach((tk) => { inKey[tk] = 1; });
      let region = n;
      for (let k = 0; k < 3 && region.parentElement; k++) region = region.parentElement;
      const leaves = leafNumbers(region);
      const nums = leaves.filter((o) => !inKey[o.token]);
      cands.push({
        key: clip(keyText, 110),
        keyTag: (n.tagName || '').toLowerCase(),
        keyTestid: n.getAttribute('data-testid') || '',
        regionTestid: region.getAttribute ? region.getAttribute('data-testid') || '' : '',
        threshold: numberTokens(keyText).slice(0, 4),
        nums: leaves.slice(0, 6),
        html: regionHtml(null, region, 0, 900, clip(keyText, 30)),
      });
      if (!picked && nums.length) {
        picked = {
          value: nums[0].value, exact: !!nums[0].exact, token: nums[0].token, text: nums[0].text, why: nums[0].why,
          key: clip(keyText, 110), others: nums.length - 1,
        };
      }
    });
    return {
      hit: !!picked, value: picked ? picked.value : null, exact: picked ? picked.exact : null,
      token: picked ? picked.token : '', text: picked ? picked.text : '', why: picked ? picked.why : '',
      key: picked ? picked.key : '', others: picked ? picked.others : 0, keyNodes: minimal.length, cands,
    };
  }

  function collectIdentity() {
    const handle = handleFromPath(location.pathname);
    // 列表页上 document 里第一个 UserName 是列表第一行的，不是页主的；拿它当身份会污染所有字段
    const listTab = listTabFromPath(location.pathname);
    if (listTab) return { handle, listTab, displayName: '', displayNameRaw: '', displayNameDirty: '', nameForeign: 0, nameTokens: {}, nameStripAll: false, ownProfile: false, selfHandleGuess: '', followRelation: '', followAria: '', followTestid: '', bio: '', joined: '', category: '', location: '', website: '', headerItemsText: '', hasHeader: false };
    const nameEl = document.querySelector('[data-testid="UserName"]');
    // 真机：第三方 xro-badge「互关」就缝在名字节点里 ⇒ 读文本时按 DOM 出处剥掉它，
    // displayNameDirty 保留未剥的全文，剥错了两边一对照立刻看得出来
    const nameText = nativeText(nameEl);
    const nameForeign = lastForeign.n;
    const nameTokens = lastForeign.tokens || {};
    const nameStripAll = !!lastForeign.all;
    const desc = document.querySelector('[data-testid="UserDescription"]');
    const joined = document.querySelector('[data-testid="UserJoinDate"]') || document.querySelector('[data-testid="UserJoinedDate"]');
    const cat = document.querySelector('[data-testid="UserProfessionalCategory"]');
    const loc = document.querySelector('[data-testid="UserLocation"]');
    const url = document.querySelector('[data-testid="UserUrl"]');
    const items = document.querySelector('[data-testid="UserProfileHeader_Items"]');
    // 真机 /home：不认 handle 就抓按钮，会抓到侧栏推荐位的「关注 @FinanzasArgy」当成页面关系 ⇒ 假数据
    const rel = handle ? followOf(document, handle) : { testid: '', aria: '', state: '' };
    // 自己的号第二条判据：侧栏「个人资料」那颗导航指向的就是登录者的主页。
    // 光靠 editProfileButton 只覆盖「已水合的头部」，头部没出来时会把自己的页当别人的页写进表
    const nav = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const navHref = nav ? (nav.getAttribute('href') || '') : '';
    const mSelf = navHref.match(/^\/@?([A-Za-z0-9_]+)$/);
    const selfHandleGuess = mSelf ? mSelf[1] : '';
    return {
      handle,
      listTab: '',
      displayName: displayNameOf(nameText),
      displayNameRaw: clip(nameText, 140), // 剥掉第三方以后的文本
      displayNameDirty: clip(txt(nameEl), 140), // 未剥的全文，对照用
      nameForeign: nameForeign,
      nameTokens: nameTokens,
      nameStripAll: nameStripAll,
      ownProfile: !!document.querySelector('[data-testid="editProfileButton"]') ||
        (!!selfHandleGuess && selfHandleGuess.toLowerCase() === handle.toLowerCase()), // 自己的主页没有关注按钮，别当缺项
      selfHandleGuess: selfHandleGuess,
      followRelation: rel.state,
      followAria: rel.aria,
      followTestid: rel.testid,
      bio: clip(txt(desc), 400),
      joined: clip(txt(joined), 80),
      category: clip(txt(cat), 60),
      location: clip(txt(loc), 60),
      website: clip(txt(url), 120),
      headerItemsText: clip(txt(items), 160),
      hasHeader: !!nameEl,
    };
  }

  // 中文 UI 实测文案（2026-10-22 真机日志）：
  //   group 本身 aria = "11 回复、9 喜欢、122 次观看"（一条拿全，含观看数）
  //   按钮 aria = "11 回复。回复" / "0 次转帖。转帖" / "9 喜欢次数。喜欢" / "122 次查看。查看帖子分析"
  const METRIC_PATTERNS = [
    ['reply', /回复|Repl/i],
    ['repost', /转帖|转推|转发|Repost|Retweet/i],
    ['quote', /引用|Quot/i],
    ['like', /喜欢|点赞|Like/i],
    ['view', /观看|查看|浏览|播放|View/i],
    ['bookmark', /书签|收藏|Bookmark/i],
    ['share', /分享|Share/i],
  ];
  function metricNameOf(s) {
    if (!s) return '';
    for (const m of METRIC_PATTERNS) if (m[1].test(s)) return m[0];
    return '';
  }

  const TESTID_METRIC = { reply: 'reply', retweet: 'repost', quote: 'quote', like: 'like', views: 'view', analytics: 'view', bookmark: 'bookmark', share: 'share' };

  // 聚合 aria 拆解：一句里同时有 reply / like / view
  const SUMMARY_PATTERNS = [
    ['reply', /([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:条)?\s*(?:回复|Repl\w*)/i],
    ['repost', /([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:次?\s*转[帖推发]|Reposts?|Retweets?)/i],
    ['quote', /([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:次?\s*引用|Quotes?)/i],
    ['like', /([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:喜欢次数|喜欢|点赞|Likes?)/i],
    ['view', /([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:次?\s*(?:观看|查看)|Views?)/i],
  ];
  function parseSummaryAria(s) {
    const out = {};
    SUMMARY_PATTERNS.forEach((p) => {
      const m = s.match(p[1]);
      if (!m) return;
      const n = firstNumber(m[0]);
      if (n.value != null) out[p[0]] = n;
    });
    return out;
  }

  function collectMetrics(art) {
    const metrics = {};
    const groups = art.querySelectorAll('[role="group"]');
    // v0.6.9 把「aria 来源」拆成两种：真机 64 行里，38 行的来源是**聚合 aria**（「42 回复、24 喜欢、400 次观看」），
    // 26 行的来源是每行独立的一颗**单指标 aria**（「2 次观看」）。上一版两种都打成 summaryAria ⇒
    // 同一行日志里 cov.summaryAria=14/25 与 cov.viewFromSummary=25/25 自相矛盾，把「独立 aria 才是详情页观看数的真来源」
    // 这条判据藏掉了。顺带去掉旧写法里「第一个带数字的组就收工」——那会让聚合组被前面的单指标组挡掉。
    const rank = { singleAria: 1, combinedAria: 2 };
    groups.forEach((g) => {
      const al = g.getAttribute('aria-label') || '';
      if (!/\d/.test(al)) return;
      if (!metricNameOf(al)) return;
      const p = parseSummaryAria(al);
      const keys = Object.keys(p);
      if (!keys.length) return;
      const from = (keys.length > 1 || al.indexOf('、') >= 0) ? 'combinedAria' : 'singleAria';
      keys.forEach((k) => {
        const prev = metrics[k];
        if (prev && prev.from !== 'buttonAria' && (rank[prev.from] || 0) >= rank[from]) return;
        metrics[k] = { num: p[k], from: from, aria: clip(al, 120), testid: g.getAttribute('data-testid') || '', text: '' };
      });
    });

    groups.forEach((g) => {
      g.querySelectorAll('[data-testid], [aria-label]').forEach((n) => {
        const tid = (n.getAttribute('data-testid') || '').toLowerCase();
        const aria = n.getAttribute('aria-label') || '';
        const text = txt(n);
        const name = TESTID_METRIC[tid] || metricNameOf(aria) || metricNameOf(text);
        if (!name || name === 'share' || name === 'bookmark') {
          if (name === 'share' || name === 'bookmark') {
            const rec = firstNumber(aria) || {};
            if (rec.value != null) metrics[name] = { num: rec, from: 'buttonAria', aria: clip(aria, 90), testid: tid, text: clip(text, 30) };
          }
          return;
        }
        const nA = firstNumber(aria), nT = firstNumber(text);
        const num = nA.value != null ? nA : nT;
        if (num.value == null) return;
        const prev = metrics[name];
        if (!prev) {
          metrics[name] = { num, from: 'buttonAria', aria: clip(aria, 90), testid: tid, text: clip(text, 30) };
        } else if (prev.from !== 'buttonAria') {
          prev.buttonValue = num.value;
          prev.buttonExact = num.exact;
          prev.buttonAria = clip(aria, 90);
          prev.buttonTestid = tid;
        }
      });
    });
    return metrics;
  }

  function summarySource(metrics) {
    return Object.keys(metrics).some((k) => metrics[k].from === 'combinedAria') ? 'combinedAria' : '';
  }

  function collectArticles() {
    const items = [];
    document.querySelectorAll('article').forEach((art, idx) => {
      const timeEl = art.querySelector('time');
      // 真机 /home 唯一一张抠不到 time 的卡片是 X Business 的推广位（statusHref 还是 /analytics 结尾）
      // ⇒ 「没有 time」不当漏抓报，单独标 adSuspect，免得采集器把 1 条广告算成「时间字段不稳」
      const adSuspect = !timeEl;
      let tweetId = '', statusHref = '';
      art.querySelectorAll('a[href*="/status/"]').forEach((a) => {
        if (tweetId) return;
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/status\/(\d+)/);
        if (m) { tweetId = m[1]; statusHref = href; }
      });
      const nameEl = art.querySelector('[data-testid="User-Name"]');
      const nameLink = nameEl ? nameEl.querySelector('a[href]') : null;
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const metrics = collectMetrics(art);
      const rel = followOf(art, '');
      // v0.7.0：X 用 data-testid="unlike" 表示「这条我已经赞过」（没赞过时是 "like"）。
      // 只读这个属性，不点击、不派发事件；两样都没有 = 判断不了，记 null 而不是 false（别把「没看到按钮」说成「没赞」）
      const likeBtn = art.querySelector('[data-testid="like"], [data-testid="unlike"]');
      const likeTestid = likeBtn ? String(likeBtn.getAttribute('data-testid') || '') : '';
      const liked = likeTestid === 'unlike' ? true : (likeTestid === 'like' ? false : null);
      const nameText = nativeText(nameLink);
      const nameForeign = lastForeign.n;
      items.push({
        idx,
        tweetId,
        statusHref,
        adSuspect,
        timeVisible: txt(timeEl),
        timeDatetime: timeEl ? timeEl.getAttribute('datetime') || '' : '',
        timeAria: timeEl && timeEl.parentElement ? clip(timeEl.parentElement.getAttribute('aria-label') || '', 60) : '',
        author: nameLink ? clip((nameLink.getAttribute('href') || '').replace(/^\/+/, ''), 60) : '',
        authorName: nameLink ? displayNameOf(nameText) : '',
        authorNameRaw: nameLink ? clip(nameText, 140) : '', // 剥错名字时能立刻看出是「剥」的问题还是「取」的问题
        authorNameDirty: nameLink ? clip(txt(nameLink), 140) : '',
        authorForeign: nameForeign,
        authorTokens: lastForeign.tokens || {},
        authorStripAll: !!lastForeign.all,
        authorTestidHit: !!nameEl,
        followState: rel.state,
        followAria: rel.aria,
        liked: liked,
        likeTestid: likeTestid,
        text: textEl ? clip(txt(textEl), 200) : '',
        hasPhoto: !!art.querySelector('[data-testid="tweetPhoto"]'),
        isRetweet: !!art.querySelector('[data-testid="uc-retweet"]') || /转推|Repotted|Reteet/i.test(clip(txt(art), 200)),
        summaryAria: summarySource(metrics) ? clip(Object.keys(metrics).map((k) => metrics[k].aria).filter((a) => /、/.test(a))[0] || '', 120) : '',
        metrics: metrics,
        html: art.outerHTML.slice(0, 1200),
      });
    });
    return items;
  }

  // 关注/粉丝列表页的行不是 article，是 div[data-testid="UserCell"]
  // 「我关注了谁」就藏在这里：每行给 handle + 原生关注按钮状态
  // ⚠ 侧栏「推荐关注」同样是 UserCell ⇒ 只取正文列里的；整页数另存 totalInDoc，两数不等就是被推荐位污染过
  // 行落在哪个模块里：真机 /following 列表的行与侧栏推荐位的行都是 UserCell，靠这个把两者分开
  function moduleOf(cell) {
    let n = cell, depth = 0;
    while (n && depth < 8) {
      const tid = (n.getAttribute && n.getAttribute('data-testid')) || '';
      if (tid === 'primaryColumn' || tid === 'sidebarColumn' || tid === 'placementTracking' || tid === 'carousel') return tid;
      if (n.getAttribute && n.getAttribute('role') === 'region') {
        const hd = n.querySelector('[role="heading"]');
        return 'region:' + clip(txt(hd), 30);
      }
      n = n.parentElement; depth++;
    }
    return '';
  }

  function collectUsers() {
    const out = [];
    const pc = primaryColumn();
    const listTab = listTabFromPath(location.pathname);
    let rows, scope;
    if (pc) {
      rows = pc.querySelectorAll('[data-testid="UserCell"]');
      scope = 'primary';
    } else {
      rows = document.querySelectorAll('[data-testid="UserCell"]');
      scope = rows.length ? 'document(没有正文列)' : 'none';
    }
    rows.forEach((cell, idx) => {
      let handle = '', nameAnchor = null;
      cell.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (!/^\/@?[A-Za-z0-9_]+$/.test(href)) return; // 只认单段路径 = 个人主页链接
        if (!handle) { handle = href.replace(/^\/@?/, ''); nameAnchor = a; }
      });
      // 真机：主页时间线里的推荐行既没有 UserName 也没有 UserDescription（name 命中 0/3）
      // ⇒ 依次退 User-Name / 指主页那个锚的文本，并记 nameHow 让日志告诉我这一行到底是哪种形状
      const nU = cell.querySelector('[data-testid="UserName"]');
      const nA = nU || cell.querySelector('[data-testid="User-Name"]');
      const hasNameNode = !!(nU || nA);
      let raw = nA ? nativeText(nA) : '';
      let how = nU ? 'UserName' : (nA ? 'User-Name' : '');
      if (!raw && nameAnchor) { raw = nativeText(nameAnchor); how = 'anchorText'; }
      const nameForeign = lastForeign.n;
      const nameTokens = lastForeign.tokens || {};
      const nameStripAll = !!lastForeign.all;
      // v0.6.2：真机 /demo_peer/verified_followers 31 行 handle 31/31、关系 31/31，但 **name 0/31、
      // nameHow 全 = anchorText** ⇒ 这类行里「指主页那个锚」只有头像、没文字，名字在别的节点。
      // 而样本又只截 outerHTML 前 900 字（全是头像那段子树），名字区根本没进日志 ⇒ 只能继续猜。
      // 这一版先把「行里哪些节点带文字」原样报出来（leafShapes），名字仍然为空时再报候选出处（cands），
      // 然后按候选回退取一次；到底是谁取到的，由 nameHow 说。
      const leafShapes = [];
      cell.querySelectorAll('div,span').forEach((n) => {
        if (n.querySelector('div,span')) return;   // 只要叶子，父节点的文本就是把子节点拼一遍
        if (inProbe(n, cell)) return;              // 探针自己的徽标不算行的文字（v0.8.5 补五）
        const s = txt(n);
        if (!s) return;
        if (leafShapes.length < 8) leafShapes.push([(n.tagName || '').toLowerCase(), n.getAttribute('data-testid') || '', clip(s, 30)]);
      });
      const cands = [];
      const pushCand = (how2, val) => {
        const s = String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
        if (s && cands.length < 6) cands.push([how2, clip(s, 60)]);
      };
      const img = cell.querySelector('img');
      const cellAria = cell.getAttribute('aria-label') || '';
      const un2 = cell.querySelector('[data-testid="UserNames"]');
      const imgAlt = img ? img.getAttribute('alt') || '' : '';
      // 名字取不到 ⇒ 按「最可能是 X 原生名字」的顺序回退。三级都要求文本里点名了 @handle
      // （X 的列表行按阅读顺序就是「名字 @handle 关系」，取 @handle 之前那段就是名字），
      // imgAlt 单独一条判据（头像 alt 常是「@handle 的头像」，那种不是名字）
      let cellForeign = 0, cellStripAll = false, cellNat = '', un2Nat = '';
      if (!raw) {
        const low = handle ? '@' + handle.toLowerCase() : '';
        // 真机这份行样本里就缝着 xro-user-card-avatar-stack ⇒ 整行的文本要走 nativeText，
        // 不然「回退取到的名字」本身可能是注入文字；脏的那份留在 cellText / nameDirty 里对照
        un2Nat = un2 ? nativeText(un2) : '';
        cellNat = nativeText(cell);
        cellForeign = lastForeign.n; cellStripAll = !!lastForeign.all;
        const tries = [['cellAria', cellAria], ['UserNames', un2Nat], ['cellText', cellNat]];
        for (let i = 0; i < tries.length && !raw; i++) {
          const t = String(tries[i][1] || '');
          if (t && low && t.toLowerCase().indexOf(low) >= 0) { raw = t; how = tries[i][0]; }
        }
        if (!raw && imgAlt && imgAlt.charAt(0) !== '@' && !/头像|avatar/i.test(imgAlt)) { raw = imgAlt; how = 'imgAlt'; }
      }
      if (!displayNameOf(raw)) {
        pushCand('cellAria', cellAria); pushCand('UserNames', un2 ? txt(un2) : ''); pushCand('imgAlt', imgAlt);
        pushCand('anchorAria', nameAnchor ? nameAnchor.getAttribute('aria-label') : '');
        pushCand('cellText', cellNat || nativeText(cell, true));
        leafShapes.slice(0, 4).forEach((L, i) => cands.length < 6 && cands.push(['leaf' + i, L[0] + (L[1] ? '[' + L[1] + ']' : '') + '=' + L[2]]));
      }
      const desc = cell.querySelector('[data-testid="UserDescription"]');
      const rel = followOf(cell, '');
      // origin：真列表页的行 = list；有名字节点的完整行 = full；只剩「关注 @某人」那颗按钮的推荐位行 = side。
      // 真机（2026-10-22）主页时间线里的 3 行全是 side（testogain / DallasTexasTV / dallasmavs），
      // 全落进 users 表的话「查我关注了谁」查出来的是 X 的推荐位 ⇒ side 行只报不落表
      const origin = listTab ? 'list' : (hasNameNode ? 'full' : 'side');
      out.push({
        idx,
        handle,
        name: displayNameOf(raw),
        nameRaw: clip(raw, 140),
        nameDirty: clip((nA ? nativeText(nA, true) : (nameAnchor ? nativeText(nameAnchor, true) : '')) || cellAria || nativeText(cell, true), 140),
        nameForeign: nameForeign,
        nameTokens: nameTokens,
        nameStripAll: nameStripAll,
        // 名字是从整行文本里取的那一次，整行剥掉几个注入节点 / 有没有整棵被判注入，记在这儿
        cellForeign: cellForeign,
        cellStripAll: cellStripAll,
        nameHow: how,
        origin: origin,
        mod: origin === 'list' ? '' : moduleOf(cell),
        hasBio: !!desc,
        bio: desc ? clip(txt(desc), 160) : '',
        followState: rel.state,
        followAria: rel.aria,
        hasStatusLink: !!cell.querySelector('a[href*="/status/"]'),
        // 行可见文本一行看完名字/handle/按钮；leafShapes 是「文字到底长在哪个节点」；
        // html 截的是名字锚往上两层的子树（名字真在那儿才看得见），不再用整行开头 900 字（那全是头像）
        // cellText 用「保留第三方、跳探针」的读法：脏对照要的是第三方的脏，不是我自己缝进去的「拉黑」俩字
        cellText: clip(nativeText(cell, true), 120),
        leafShapes: leafShapes,
        cands: cands,
        html: regionHtml(cell, nameAnchor || cell, 2, 700, displayNameOf(raw) || (leafShapes[0] ? leafShapes[0][2] : '')),
        dump: '',
      });
      out[out.length - 1].dump = 'TEXT[' + out[out.length - 1].cellText + '] LEAF' + JSON.stringify(leafShapes) + ' HTML' + out[out.length - 1].html;
    });
    return { rows: out, scope, listTab: listTab, totalInDoc: document.querySelectorAll('[data-testid="UserCell"]').length };
  }

  function coverage(items) {
    // 推广位（adSuspect）不进命中率分母：真机 /home 12 张卡里 2 张是广告，
    // 混在一起会把 time/view 的命中率算低，误判成「字段不稳」
    const ads = items.filter((it) => it.adSuspect).length;
    const clean = items.filter((it) => !it.adSuspect);
    const n = clean.length;
    const cnt = (f) => { let c = 0; clean.forEach((it) => { const v = f(it); if (v != null && v !== '') c++; }); return n ? c + '/' + n : '0/0'; };
    const metric = (k) => cnt((it) => (it.metrics[k] || {}).num && it.metrics[k].num.value != null ? it.metrics[k].num.value : '');
    const exactMetric = (k) => cnt((it) => (it.metrics[k] || {}).num && (it.metrics[k].num.exact === true ? it.metrics[k].num.value : ''));
    const METRIC_KEYS = ['reply', 'repost', 'quote', 'like', 'view'];
    const srcTally = () => {
      const out = {};
      clean.forEach((it) => {
        METRIC_KEYS.forEach((k) => {
          const m = (it.metrics || {})[k];
          if (!m || !m.num || m.num.value == null) return;
          const f = m.from || '?';
          if (!out[k]) out[k] = {};
          out[k][f] = (out[k][f] || 0) + 1;
        });
      });
      return out;
    };
    return {
      articles: items.length,
      ads: ads,
      clean: n,
      tweetId: cnt((i) => i.tweetId),
      timeDatetime: cnt((i) => i.timeDatetime),
      tweetText: cnt((i) => i.text),
      author: cnt((i) => i.author),
      authorTestid: cnt((i) => i.authorTestidHit ? '1' : ''),
      followAria: cnt((i) => i.followAria),
      follow: cnt((i) => i.followState),
      summaryAria: cnt((i) => i.summaryAria),
      reply: metric('reply'),
      repost: metric('repost'),
      quote: metric('quote'),
      like: metric('like'),
      view: metric('view'),
      likeExact: exactMetric('like'),
      viewExact: exactMetric('view'),
      // 逐指标的来源计数：这一栏才是「数到底从哪个节点来」的答案（聚合 aria / 单指标 aria / 按钮 aria）。
      // 放在 cov 顶层而不是行里 ⇒ 快照被精简（slimSnap 丢 metrics.from）之后仍然读得到。
      src: srcTally(),
    };
  }

  function coverageUsers(rows) {
    const n = rows.length;
    const cnt = (f) => { let c = 0; rows.forEach((r) => { const v = f(r); if (v != null && v !== '') c++; }); return n ? c + '/' + n : '0/0'; };
    const how = {};
    const origin = {};
    rows.forEach((r) => { const k = r.nameHow || 'none'; how[k] = (how[k] || 0) + 1; });
    rows.forEach((r) => { const k = r.origin || 'none'; origin[k] = (origin[k] || 0) + 1; });
    return { rows: n, handle: cnt((r) => r.handle), name: cnt((r) => r.name), follow: cnt((r) => r.followState), bio: cnt((r) => r.bio), nameHow: how, origin: origin };
  }

  // 主页时间线 tab 的判据（v0.8.2）：只读 collectStats 已抓的 __tabs，不加 observer、不点任何东西。
  // 「推荐时间」= 这份快照的 at（在为你推荐里看到它的时刻）；「当前曝光」= 同一行的 view 指标。
  function tlSrcOf(tab, stats) {
    if (tab !== 'home') return '';
    const tabs = (stats && stats.__tabs) || [];
    const on = tabs.find((t) => t && t.selected === 'true');
    if (!on) return '';
    if (on.text === '为你推荐') return 'foryou';
    if (on.text === '正在关注') return 'following';
    return '';
  }

  function snapshot() {
    const tweets = collectArticles();
    const u = collectUsers();
    const users = u.rows;
    const tab = tabName();
    const idt = collectIdentity();
    const rw = tab === 'rewards' ? collectRewards() : null;
    const foreignTokens = {};
    const mergeTokens = (o) => Object.keys(o || {}).forEach((k) => { foreignTokens[k] = (foreignTokens[k] || 0) + o[k]; });
    mergeTokens(idt.nameTokens);
    users.forEach((r) => mergeTokens(r.nameTokens));
    tweets.forEach((t) => mergeTokens(t.authorTokens));
    const stats = collectStats();
    return {
      at: new Date().toISOString(),
      url: location.href,
      title: clip(document.title, 80),
      tab,
      // 列表页看 users 有没有出水合，主页/详情页看 tweets；空集合必须和「采到了 0 条」区分开。
      // 奖励页两者都没有：它的「水合」标志是那句关键词出没出来
      hydrated: LIST_TABS.indexOf(tab) >= 0 ? users.length > 0 : (tab === 'rewards' ? (rw ? rw.keyNodes > 0 : false) : tweets.length > 0),
      identity: idt,
      stats,
      // v0.8.2：主页时间线 tab（为你推荐/正在关注）。判据是真机 __tabs 里 selected==='true' 那条的文本
      // （2026-10-26 真机：home 页只有「为你推荐」「正在关注」「模仿」「优质」四个 role=tab）。
      // 认不出就空串 —— 宁可空也不能把「不知道」记成「为你推荐」，那会把整榜的口径都弄脏。
      tlSrc: tlSrcOf(tab, stats),
      rewards: rw,
      tweets,
      users,
      usersScope: u.scope,
      usersListTab: u.listTab,
      userCellInDoc: u.totalInDoc,
      // 头部名字里剥掉的注入节点也算进来：主页时间线还没水合时只统计行里的话这里是 0，
      // 而「名字被剥过」这件事就没人知道了
      foreignNodes: (idt.nameForeign || 0) + users.reduce((a, r) => a + (r.nameForeign || 0), 0) + tweets.reduce((a, t) => a + (t.authorForeign || 0), 0),
      // v0.6.1：命中的到底是哪个 class token（xro-badge? extension-x?）＋「整棵子树被判注入、已回退全文」的次数。
      // 前者证明判据有没有误伤 X 自己的 class，后者是「剥空」这件事的唯一信号
      foreignTokens: foreignTokens,
      nameStripAll: (idt.nameStripAll ? 1 : 0) + users.filter((r) => r.nameStripAll).length + tweets.filter((t) => t.authorStripAll).length,
      cov: coverage(tweets),
      covUsers: coverageUsers(users),
    };
  }

  // ---------- 本地累积（浏览器只留运行态，整页原文见本机库） ----------
  let runsMeta = { kept: 0, full: 0, slim: 0, dropped: 0, bytes: 0, cap: RUNS_BYTES_CAP, writes: 0, at: '' };
  function bytesOf(v) {
    let s = '';
    try { s = JSON.stringify(v); } catch (e) { return 0; }
    if (typeof TextEncoder === 'function') { try { return new TextEncoder().encode(s).length; } catch (e) { /* 退字节数按字符算 */ } }
    return s.length;
  }
  // 精简行丢掉的只有「原文类」：整页 HTML、metrics 的出处串、行里的 leafShapes/cands/dump。
  // upsertStores 与重建日线读的字段一个都不动 ⇒ 拿精简行重算，出来的两张表和拿全量一样
  const SLIM_DROP_TWEET = ['html', 'summaryAria', 'authorNameDirty', 'authorNameRaw', 'authorTokens', 'timeAria', 'timeVisible', 'statusHref'];
  const SLIM_DROP_USER = ['html', 'leafShapes', 'cands', 'dump', 'nameTokens', 'nameRaw', 'nameDirty', 'cellText', 'followAria'];
  function slimMetrics(m) {
    const out = {};
    Object.keys(m || {}).forEach((k) => {
      const x = m[k] || {}, num = x.num || {};
      const v = { value: num.value == null ? null : num.value, exact: !!num.exact };
      if (x.buttonValue != null) { v.buttonValue = x.buttonValue; v.buttonExact = !!x.buttonExact; }
      out[k] = { num: v };   // 保持 .num.value 这层形状，upsertStores 里那句 mv(k) 才不用改
    });
    return out;
  }
  function slimSnap(s) {
    if (!s || typeof s !== 'object' || s.slim) return s;
    const o = {};
    Object.keys(s).forEach((k) => { o[k] = s[k]; });
    o.slim = 1;
    o.tweets = (s.tweets || []).map((t) => {
      const x = {};
      Object.keys(t || {}).forEach((k) => { if (SLIM_DROP_TWEET.indexOf(k) < 0) x[k] = t[k]; });
      x.metrics = slimMetrics(t && t.metrics);
      return x;
    });
    o.users = (s.users || []).map((u) => {
      const x = {};
      Object.keys(u || {}).forEach((k) => { if (SLIM_DROP_USER.indexOf(k) < 0) x[k] = u[k]; });
      return x;
    });
    return o;
  }
  function loadRuns() { try { return GM_getValue(STORE_KEY, []) || []; } catch (e) { return []; } }
  function saveRuns(runs) {
    const arr = Array.isArray(runs) ? runs : [];
    let out = arr.slice(Math.max(0, arr.length - RUNS_KEEP));
    const n = out.length;
    let slimmed = 0;
    out = out.map((s, i) => {
      if (i >= n - RUNS_FULL) return s;          // 最新这几份留全量：面板「本页」与深挖要看原文
      const x = slimSnap(s);
      if (x && x !== s && !s.slim) slimmed++;
      return x;
    });
    let dropped = Math.max(0, arr.length - n), bytes = bytesOf(out);
    while (bytes > RUNS_BYTES_CAP && out.length > 1) { out.shift(); dropped++; bytes = bytesOf(out); }
    runsMeta = { kept: out.length, full: Math.min(RUNS_FULL, out.length), slim: slimmed, dropped: dropped, bytes: bytes, cap: RUNS_BYTES_CAP, writes: runsMeta.writes + 1, at: new Date().toISOString() };
    try { GM_setValue(STORE_KEY, out); } catch (e) { console.warn('[xprobe] save failed', e); }
    return runsMeta;
  }
  // 存储的真相从适配层拿：它才知道每次写入的字节数与 chrome.runtime.lastError
  function storeStat() {
    const s = globalThis.__XP_STORE__;
    if (!s || typeof s !== 'object') {
      return { keys: {}, total: 0, quota: 10 * 1024 * 1024, unlimited: false, err: '', lastErr: '', lastErrAt: '', quotaHit: 0, writes: 0, failed: 0, measured: false };
    }
    return {
      keys: s.bytes || {}, total: s.total || 0, quota: s.quota || (10 * 1024 * 1024), unlimited: !!s.unlimited,
      err: s.lastErr || '', lastErr: s.lastErr || '', lastErrAt: s.lastErrAt || '',
      quotaHit: s.quotaHit || 0, writes: s.writes || 0, failed: s.failed || 0,
      perKeyErr: s.err || {}, measured: !!s.measured,
    };
  }

  // ---------- 日志通道：只打到本机 127.0.0.1，收不到就暂存重试 ----------
  const queue = [];
  let flushTimer = 0, sinkOk = null, lastSinkErr = '', lastSinkAt = '', posted = 0, failedBatches = 0;
  let lastPingInfo = null, lastPingAt = '';
  // 上一条请求实际走的通道（native / http，SW 随回包带回）：诊断要回答「宿主生效没有」，
  // 光看「写成功了」不够——日志里必须能说出这条路是宿主写的还是回环 HTTP 写的。
  let lastChan = '';
  // v0.6.9：队列从「只在内存、刷新就没」改成落扩展存储的一份待发积压。
  // 触发点是真机这一轮：sink 没起，13 条记录在内存里压了 179~252 秒，全靠那两个标签页一直没刷新才没丢
  // ——按旧写法，中间任何人按一下 F5，今天的日志就是空的，下一轮迭代也没有东西可看。
  // 键的形状是 { [bootId]: { t: 写入时刻, recs: [...] } }：每个标签页只写自己那格，SW 合并时按格替换
  // ⇒ 两个标签页不会互相覆盖；一个标签页崩了，下一个开页面的标签页在 boot 时把那格的记录认领过来（同一份记录会被从旧格里删掉，不重复发）。
  // 积压里存的是**精简快照**（slimSnap），整页原文不在这儿：宁可恢复出一条带 cov/miss 的快照，也不让键又把配额顶穿。
  const QUEUE_KEY = 'ysy.xprobe.queue';
  const QUEUE_MAX = 120;                // 单格条数顶
  const QUEUE_BYTES_CAP = 600 * 1024;   // 整个键的字节顶（一条精简快照实测 ~4KB）
  const QUEUE_STALE_MS = 60 * 1000;     // 别人的格子闲过这个时间 ⇒ 认为它的主人已经没了，可以认领
  const QUEUE_DROP_MS = 6 * 60 * 1000;  // 超过这个时间的格子直接丢（再迟到就没意义了）
  const bootId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  let qMeta = { bytes: 0, count: 0, dropped: 0, adopted: 0, persisted: 0, lastAt: '', err: '', slots: 0 };
  let sinkDownSince = 0, lastFlushTryAt = 0;

  function recId(r) { return String((r && r.at) || '') + '|' + String((r && r.kind) || '') + '|' + String((r && r.url) || ''); }
  function qslim(rec) {
    const d = rec && rec.data;
    if (d && typeof d === 'object' && Array.isArray(d.tweets)) {
      const s = slimSnap(d);
      const o = {};
      Object.keys(rec).forEach((k) => { o[k] = rec[k]; });
      o.data = s; o.qs = 1;
      return o;
    }
    return rec;
  }
  // 只在「sink 不通且队列非空」或「卸载前」这两种情况下写，正常在线时这个键一次都不写
  function persistQueue(force) {
    if (!queue.length && !qMeta.count) return qMeta;
    if (!force && qMeta.lastAt && Date.now() - Date.parse(qMeta.lastAt) < 3000) return qMeta;
    const recs = queue.map(qslim);
    while (recs.length > QUEUE_MAX) { recs.shift(); qMeta.dropped++; }
    let bytes = bytesOf(recs);
    while (bytes > QUEUE_BYTES_CAP && recs.length > 1) { recs.shift(); qMeta.dropped++; bytes = bytesOf(recs); }
    qMeta.bytes = bytes; qMeta.count = recs.length;
    try {
      const v = {};
      v[bootId] = { t: Date.now(), recs: recs };
      GM_setValue(QUEUE_KEY, v);
      qMeta.persisted++;
      qMeta.lastAt = new Date().toISOString();
      qMeta.err = storeErrOf([QUEUE_KEY]) || '';
    } catch (e) { qMeta.err = '队列落盘失败: ' + clip(e && e.message, 40); }
    return qMeta;
  }
  function adoptQueue() {
    let m = null;
    try { m = GM_getValue(QUEUE_KEY, null) || null; } catch (e) { m = null; }
    if (!m || typeof m !== 'object') return 0;
    const now = Date.now(), mine = {};
    let n = 0;
    Object.keys(m).forEach((k) => {
      const slot = m[k];
      if (k === bootId || !slot || !Array.isArray(slot.recs)) return;
      if (!slot.t || now - slot.t > QUEUE_DROP_MS) return;      // 太旧的积压不认领（也马上会被 SW 滚掉）
      if (now - slot.t < QUEUE_STALE_MS) return;                // 主人还在写这格 ⇒ 别抢
      slot.recs.forEach((r) => {
        if (!r || mine[recId(r)]) return;
        mine[recId(r)] = 1;
        r.qback = 1;                                            // 日志里能看出这条是「上个标签页留下的」
        n++;
      });
    });
    if (!n) return 0;
    const ids = {};
    queue.forEach((r) => { ids[recId(r)] = 1; });
    const back = [];
    Object.keys(m).forEach((k) => {
      if (k === bootId) return;
      const slot = m[k];
      if (!slot || !Array.isArray(slot.recs)) return;
      if (!slot.t || now - slot.t > QUEUE_DROP_MS || now - slot.t < QUEUE_STALE_MS) return;
      slot.recs.forEach((r) => { if (r && !ids[recId(r)]) back.push(r); });
    });
    back.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    back.forEach((r) => queue.unshift(r));
    while (queue.length > 160) queue.pop();
    qMeta.adopted += back.length;
    return back.length;
  }
  function queueStat() {
    return { len: queue.length, bytes: qMeta.bytes, count: qMeta.count, dropped: qMeta.dropped,
             adopted: qMeta.adopted, persisted: qMeta.persisted, lastAt: qMeta.lastAt, err: qMeta.err,
             down: sinkOk === false && sinkDownSince ? Date.now() - sinkDownSince : 0,
             max: QUEUE_MAX, byteCap: QUEUE_BYTES_CAP, boot: bootId };
  }
  // 断开/恢复各记一条：日志里必须留「这段没落地的时间有多长、攒了多少、丢了几条」，
  // 不然下一轮我看日志只看到一串迟到的记录，不知道为什么
  function noteSinkFlip(nowOk, why) {
    if (!nowOk) {
      if (sinkDownSince) return;
      sinkDownSince = Date.now();
      logRec('sink', { ev: 'down', qlen: queue.length, qbytes: qMeta.bytes, qdropped: qMeta.dropped, err: clip(String(why || lastSinkErr), 120) });
      return;
    }
    if (!sinkDownSince) return;
    const off = Date.now() - sinkDownSince;
    sinkDownSince = 0;
    logRec('sink', { ev: 'up', offlineMs: off, qlen: queue.length, qbytes: qMeta.bytes, qdropped: qMeta.dropped, qadopted: qMeta.adopted, chan: lastChan });
  }

  function httpRequest(method, url, body, cb) {
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method, url, data: body || undefined, timeout: 6000,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        // 第 4 个参数 via：SW 报的通道路由。老沙箱（自检）不报就落到 ''，别当错误处理。
        onload: (r) => cb(null, r.status, r.responseText || '', r.via || ''),
        onerror: (e) => cb(new Error('gm-onerror status=' + (e && e.status)), 0, ''),
        ontimeout: () => cb(new Error('gm-timeout'), 0, ''),
      });
      return;
    }
    const p = fetch(url, { method, body: body || undefined, mode: 'cors', credentials: 'omit', cache: 'no-store' });
    p.then((r) => r.text().then((t) => cb(null, r.status, t, '')))
      .catch((e) => cb(e, 0, ''));
  }

  function tabName() {
    const seg = firstSeg(location.pathname).toLowerCase();
    if (!seg) return 'root';
    if (seg === 'home') return 'home';
    // 创作者奖励页 /i/jf/creators/original_content_rewards：第一段是保留段 i，按老规则会掉回 profile 形状，
    // 而这一页给的是「账号级、每天更新」的 90 天曝光数，必须单独一页型才谈得出「记在谁名下」
    if (/^\/i\/jf\/creators(\/|$)/i.test(location.pathname)) return 'rewards';
    // 账号分析页 /i/account_analytics：每天一格的实时曝光（当天当刻就在涨），与奖励页的 T+1 有效曝光是两个数
    if (/^\/i\/account_analytics(\/|$)/i.test(location.pathname)) return 'analytics';
    if (location.pathname.indexOf('/status/') >= 0) return 'tweet';
    // 关注/粉丝列表页是单独页型：它是「我关注了谁」的数据源，不能和主页混在一起
    const sub = listTabFromPath(location.pathname);
    if (sub) return sub;
    if (seg === 'notifications') return 'notifications';
    if (seg === 'compose') return 'compose';
    if (seg === 'search') return 'search';
    if (seg === 'explore') return 'explore';
    if (seg === 'messages') return 'messages';
    if (RESERVED.includes(seg)) return seg;
    return 'profile';
  }

  const REPORTABLE = { profile: 1, tweet: 1, home: 1, following: 1, followers: 1, verified_followers: 1, rewards: 1 };

  function logRec(kind, data, extra) {
    // t=1 标记「自检脚本发的」，sink 据此分流，别灌进真机日志
    // ver/host 每条都带：真机出现过油猴 0.3.0 与扩展 0.5.0 相隔 196ms 各采同一页 ⇒ 谁的日志必须分得清
    const rec = { kind, at: new Date().toISOString(), url: location.href, tab: tabName(), t: globalThis.__XPROBE_TEST ? 1 : 0, ver: VER, host: HOST, data };
    if (extra) Object.assign(rec, extra);
    queue.push(rec);
    while (queue.length > 160) { queue.shift(); qMeta.dropped++; }   // 丢的是最旧那条，但必须计数：静默丢 = 下一轮我看日志以为「那段时间什么都没采」
    scheduleFlush();
    return rec;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushNow, 900);
  }

  function flushNow() {
    flushTimer = 0;
    // 整页转储丢了就要靠这条腿重发：sink 恢复后先补那份 dump，再攒记录
    if (pendingDump && !dumpBusy) sendDump();
    if (!queue.length) return 0;
    lastFlushTryAt = Date.now();
    const batch = queue.splice(0, 24);
    let payload;
    try {
      payload = JSON.stringify({ ver: VER, build: BUILD, host: HOST, peer: peerHost(), sentAt: new Date().toISOString(), tab: tabName(), records: batch });
    } catch (e) {
      lastSinkErr = 'JSON.stringify 失败: ' + e.message;
      batch.forEach((r) => queue.unshift(r));
      return 0;
    }
    httpRequest('POST', SINK + '/log', payload, (err, status, text) => {
      if (err || status !== 200) {
        sinkOk = false; failedBatches++;
        lastSinkErr = (err ? err.message : 'HTTP ' + status) + ' ' + clip(String(text), 90);
        // 旧写法在这儿用 pop() 裁顶 = 把**最新**那条挤掉，而日志里最有价值的正是刚刚发生的那一页 ⇒ 统一成丢最旧并计数
        batch.forEach((r) => queue.unshift(r));
        while (queue.length > 160) { queue.pop(); qMeta.dropped++; }
        noteSinkFlip(false, lastSinkErr);
        persistQueue(true);      // 发不出去就先落盘：这一分钟里人很可能就刷新页面了
        render();
        return;
      }
      sinkOk = true; lastSinkErr = ''; lastSinkAt = new Date().toISOString();
      posted += batch.length;
      noteSinkFlip(true);
      persistQueue(queue.length === 0);   // 队列空了要把这一格抹掉；没空就顺手更新（内部有 3s 节流）
      render();
    });
    return batch.length;
  }

  function pingSink(cb) {
    httpRequest('GET', SINK + '/ping', '', (err, status, text, via) => {
      let info = null;
      try { info = JSON.parse(text); } catch (e) { info = null; }
      sinkOk = !err && status === 200;
      if (sinkOk) lastChan = String(via || '');
      if (!sinkOk) lastSinkErr = err ? err.message : 'HTTP ' + status;
      // 探活回来的那坨里有本机库的行数（db）：面板要显示「档案库有多少条」，
      // 而库在文件系统上，页面这边唯一的合法读数渠道就是这条已有的 /ping
      if (sinkOk && info) { lastPingInfo = info; lastPingAt = new Date().toISOString(); }
      noteSinkFlip(sinkOk, err ? err.message : 'HTTP ' + status);
      if (cb) cb(sinkOk, info);
      render();
    });
  }

  // ---------- 调试转储：把整页结构打成原文发给本机 sink ----------
  // 反检测纪律（这是原则，不是偏好）：只读 DOM —— 不派发事件、不点击、不滚动、不跳转、
  // 不读写 X 的接口或 store、不带 cookie（GM 请求不带凭据，fetch 路径 credentials:'omit'）。
  // 流量只有 127.0.0.1 一条回环，一次转储一个 POST，且有预算与冷却，绝不在页面里循环扫。
  const DUMP_KEY = 'ysy.xprobe.dump';
  const DUMP_HTML_KEY = 'ysy.xprobe.dumpHtml';
  const DUMP_BUDGET = 12;          // 一轮（一次加载）最多 12 页，防我连点成 CPU 火焰
  const DUMP_COOLDOWN = 45 * 1000; // 同一路由 45s 内只自动抓一次，和记录去重同窗
  const DUMP_TRIES = 3;            // 一份转储最多重发 3 次：掉线的整页我不打算让人再点一遍，但也不能无限重发
  const TREE_MAX_LINES = 1400;
  const TREE_MAX_DEPTH = 90;
  const TREE_MAX_NODES = 120000;
  const TEXT_MAX = 240000;
  const HTML_MAX = 12 * 1024 * 1024;
  const LINE_MAX = 340;

  let dumpOn = false, dumpHtml = false;
  try { dumpOn = GM_getValue(DUMP_KEY, false) === true; } catch (e) { dumpOn = false; }
  try { dumpHtml = GM_getValue(DUMP_HTML_KEY, false) === true; } catch (e) { dumpHtml = false; }
  const dumpAt = {};
  let dumpCount = 0, dumpLast = '', dumpLastDir = '', dumpErr = '';
  let pendingDump = null, dumpTries = 0, dumpBusy = false;

  // 有信息量的标签：X 全用 div，所以光看标签没用，得看属性；这几个标签本身就是结构线索
  const TAG_HOT = { a: 1, button: 1, article: 1, time: 1, input: 1, textarea: 1, img: 1, video: 1, canvas: 1, label: 1, form: 1, dialog: 1, nav: 1, main: 1, header: 1, section: 1, details: 1, summary: 1 };
  // 不往下钻的标签：脚本样式与图标树，进去只有几千个 path，白烧 CPU 也白烧我的阅读量
  const OPAQUE = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, SVG: 1, PATH: 1, POLYLINE: 1, CIRCLE: 1, RECT: 1, BR: 1 };
  const TREE_ATTRS = ['data-testid', 'role', 'aria-label', 'href', 'datetime', 'name', 'type', 'contenteditable', 'title', 'src', 'alt', 'aria-expanded', 'aria-selected', 'aria-hidden', 'aria-live'];

  function domTree(rootEl) {
    const root = rootEl || document.body || document.documentElement;
    const lines = [];
    let nodes = 0, hitCap = false, hitDepth = false;
    const attr = (n, a) => { const v = n.getAttribute ? n.getAttribute(a) : null; return v == null ? '' : String(v); };
    const interesting = (n) => {
      if (attr(n, 'data-testid') || attr(n, 'role') || attr(n, 'aria-label') || attr(n, 'href') || attr(n, 'datetime') ||
        attr(n, 'id') || attr(n, 'name') || attr(n, 'title') || attr(n, 'contenteditable') || attr(n, 'src') ||
        attr(n, 'alt') || attr(n, 'aria-expanded') || attr(n, 'aria-live') || (n.id || '')) return true;
      return !!TAG_HOT[(n.tagName || '').toLowerCase()];
    };
    const emit = (n, ed, rawDepth) => {
      if (lines.length >= TREE_MAX_LINES) { hitCap = true; return; }
      const bits = ['  '.repeat(ed) + (n.tagName || '?').toLowerCase()];
      const own = String(n.id || attr(n, 'id') || '');
      if (own) bits.push('id="' + clip(own, 40) + '"');
      TREE_ATTRS.forEach((a) => {
        const v = attr(n, a);
        if (v) bits.push(a + '="' + clip(v.replace(/\s+/g, ' '), a === 'href' ? 90 : 80) + '"');
      });
      const cls = String(n.className && n.className.baseVal != null ? n.className.baseVal : n.className || '');
      // X 自己的 class 是哈希串（css-xxx / r-xxx），印出来只是噪声；第三方注入的才要认出来
      const ft = foreignTokenIn(cls);
      if (ft) bits.push('class="' + clip(cls, 50) + '"(第三方:' + ft + ')');
      bits.push('kids=' + (n.children ? n.children.length : 0));
      const t = clip(txt(n), 70);
      if (t) bits.push('text="' + t + '"');
      const skip = rawDepth - ed;
      if (skip >= 2) bits.push('(跳过' + skip + '层)');
      lines.push(clip(bits.join(' '), LINE_MAX));
    };
    const walk = (n, ed, rawDepth) => {
      if (!n) return;
      // 拉黑钮与标杆胶囊（v0.9.1 标人 / v0.9.3 标帖）走 class 排除（一颗名字/帖子一个，没 id 可挡）；别的探针注入件照旧按 id 排。
      // v0.9.3 补 BENCH_ID/BENCHP_ID：两张右缘窗口以前会出现在转储里——「整页只有 X 的结构」是这份现场的作用，自家面板混进去就是误导。
      const wcls = String(n.className && n.className.baseVal != null ? n.className.baseVal : n.className || '');
      if (n.id === FAB_ID || n.id === CARD_ID || n.id === FABBAR_ID || n.id === FLIST_ID
        || n.id === BENCH_ID || n.id === BENCHP_ID
        || PEER_IDS.indexOf(n.id) >= 0 || wcls.indexOf(BLK_CLS) >= 0 || wcls.indexOf(BENCH_BADGE_CLS) >= 0) return;   // 别把探针自己的钮排/浮标/卡片/名单/标杆窗（本机任一宿主）读成页面结构
      nodes++;
      if (lines.length >= TREE_MAX_LINES || nodes > TREE_MAX_NODES) { hitCap = true; return; }
      if (rawDepth > TREE_MAX_DEPTH) { hitDepth = true; return; }
      const hot = interesting(n);
      if (OPAQUE[(n.tagName || '').toUpperCase()]) { if (hot) emit(n, ed, rawDepth); return; }
      if (hot) emit(n, ed, rawDepth);
      const kids = n.children || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i], hot ? ed + 1 : ed, rawDepth + 1);
    };
    if (root) walk(root, 0, 0);
    return {
      lines: [
        '# xprobe domTree ' + VER + ' build ' + BUILD + '  ' + location.href + '  ' + new Date().toISOString(),
        '# 只列有信息量的节点（data-testid/role/aria-label/href/datetime/id/name/title/contenteditable/src/alt + a|button|article|time|input|textarea…）',
        '# 缩进=打印层级；(跳过N层)=这里折叠掉了 N 层无属性 div/span；script/style/svg 子树不展开；面板自身已排除',
        '# 被截断: ' + (hitCap ? '是（行数或节点数触顶，结构没看全）' : '否') + (hitDepth ? ' 深度触顶' : ''),
      ].concat(lines),
      emitted: lines.length, nodes, hitCap, hitDepth,
    };
  }

  // 表单里可能留着草稿甚至凭据：value 与 textarea 正文一律抹掉，只留形状
  function redactHtml(html) {
    return String(html)
      .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea\s*>)/gi, '$1[已抹去 textarea 正文]$2')
      .replace(/(<input\b[^>]*?)\svalue="[^"]*"/gi, '$1 value="[已抹去]"');
  }

  function buildDump(opts) {
    const o = opts || {};
    const t0 = Date.now();
    const tree = domTree();
    const root = document.body || document.documentElement;
    // 真机面板挂在 documentElement 上、不在 body 内，所以 innerText 不会把我的文案混进现场
    const raw = root && typeof root.innerText === 'string' ? root.innerText : txt(root);
    const testids = {}, roles = {};
    document.querySelectorAll('[data-testid]').forEach((n) => { const t = n.getAttribute('data-testid') || '(空)'; testids[t] = (testids[t] || 0) + 1; });
    document.querySelectorAll('[role]').forEach((n) => { const r = n.getAttribute('role') || '(空)'; roles[r] = (roles[r] || 0) + 1; });
    const htmlOn = o.html === true || (o.html === undefined && dumpHtml);
    let html = '', htmlFull = 0;
    if (htmlOn) {
      const full = (document.documentElement && document.documentElement.outerHTML) || '';
      htmlFull = full.length;
      html = redactHtml(full.slice(0, HTML_MAX));
    }
    return {
      kind: 'dump', at: new Date().toISOString(), t: globalThis.__XPROBE_TEST ? 1 : 0,
      ver: VER, build: BUILD, url: location.href, title: document.title || '',
      tab: tabName(), handle: handleFromPath(location.pathname),
      counts: {
        articles: document.querySelectorAll('article').length,
        userCells: document.querySelectorAll('[data-testid="UserCell"]').length,
        testidKinds: Object.keys(testids).length,
        treeEmitted: tree.emitted, treeNodes: tree.nodes, hitCap: !!tree.hitCap, hitDepth: !!tree.hitDepth,
        textChars: raw.length, htmlChars: htmlFull,
        // 真机上一页几千节点，我想知道这份转储到底贵不贵（贵就说明该收紧遍历，不能让人等着）
        ms: Date.now() - t0,
      },
      testids, roles, tree: tree.lines.join('\n'),
      text: raw.length > TEXT_MAX ? raw.slice(0, TEXT_MAX) + '\n[…截断，共 ' + raw.length + ' 字]' : raw,
      html,
    };
  }

  function sendDump(cb) {
    const d = pendingDump;
    if (!d || dumpBusy) return 0;
    let payload;
    try { payload = JSON.stringify(d); } catch (e) { dumpErr = 'dump 序列化失败: ' + e.message; pendingDump = null; render(); return 0; }
    dumpBusy = true;
    httpRequest('POST', SINK + '/dump', payload, (err, status, text) => {
      dumpBusy = false;
      if (err || status !== 200) {
        dumpTries++;
        const why = (err ? err.message : 'HTTP ' + status) + ' ' + clip(String(text), 40);
        if (dumpTries >= DUMP_TRIES) { pendingDump = null; dumpErr = 'dump 放弃（试 ' + DUMP_TRIES + ' 次）: ' + clip(why, 50); }
        else { dumpErr = 'dump 暂待重发(' + dumpTries + '/' + DUMP_TRIES + '): ' + clip(why, 50); scheduleFlush(); }
      } else {
        pendingDump = null; dumpTries = 0; dumpErr = '';
        dumpLast = clip(String(d.at).slice(11, 19), 8) + ' ' + payload.length + 'B' + (d.counts ? ' ' + d.counts.ms + 'ms' : '');
        try { dumpLastDir = String(JSON.parse(text).dir || ''); } catch (e) { dumpLastDir = ''; }
      }
      if (cb) cb(!pendingDump && !dumpErr, text);
      render();
    });
    return payload.length;
  }

  function captureDump(opts) {
    syncDumpRemote();   // 手动「抓整页原文」不走 3011 那条已经同频过的路，这里补一次：别用本页 boot 时的旧 html 开关
    const o = opts || {};
    const key = tabName() + '|' + (handleFromPath(location.pathname) || '-');
    const now = Date.now();
    // 一份还没落地就只有一份：同一时刻最多一个整页在路上，绝不叠成两个大 POST
    if (pendingDump) return { skip: 'busy', key };
    if (!o.force) {
      if (!dumpOn) return { skip: 'off', key };
      if (dumpAt[key] && now - dumpAt[key] < DUMP_COOLDOWN) {
        return { skip: 'cooldown', key, left: Math.ceil((DUMP_COOLDOWN - (now - dumpAt[key])) / 1000) };
      }
    }
    if (dumpCount >= DUMP_BUDGET) return { skip: 'budget', key };
    dumpCount++; dumpAt[key] = now;
    let d;
    try {
      d = buildDump({ html: o.html });
    } catch (e) {
      d = {
        kind: 'dump', at: new Date().toISOString(), t: globalThis.__XPROBE_TEST ? 1 : 0, ver: VER, build: BUILD,
        url: location.href, tab: tabName(), handle: handleFromPath(location.pathname),
        error: String((e && e.message) || e), stack: clip(e && e.stack, 500), tree: '', text: '', html: '',
      };
    }
    d.dumpKey = key;
    pendingDump = d; dumpTries = 0;
    const bytes = sendDump();
    if (!bytes) return { skip: 'post-failed', key, err: dumpErr };
    return { bytes, at: d.at, key, counts: d.counts || null, error: d.error || '' };
  }

  function dumpStatus() {
    syncDumpRemote();   // 面板/调试页回读前先同频：回给面板的必须是「全局开关」，不是这一页 boot 那一刻的快照
    return { on: dumpOn, html: dumpHtml, count: dumpCount, budget: DUMP_BUDGET, cooldown: DUMP_COOLDOWN, err: dumpErr, last: dumpLast, dir: dumpLastDir, routes: Object.keys(dumpAt).length, pending: !!pendingDump, tries: dumpTries, busy: dumpBusy, maxTries: DUMP_TRIES };
  }
  function setDumpOn(v) { dumpOn = !!v; try { GM_setValue(DUMP_KEY, dumpOn); } catch (e) { /* 存不下就算了 */ } render(); }
  function setDumpHtml(v) { dumpHtml = !!v; try { GM_setValue(DUMP_HTML_KEY, dumpHtml); } catch (e) { /* 同上 */ } render(); }
  // v0.8.8 开关同频（用户：「这个参数我打开后老是又自动关闭了」）：
  // 值其实一直存在 chrome.storage.local（ysy.xprobe.dump / .dumpHtml，实测 boot 记录里 dump 字段能读到 1），
  // 丢的不是存储，是「应用」—— core 只在 boot 读过一次，而面板 900ms 轮询的是**当前活动标签页内存里那一份**。
  // 于是在 A 页点开、切到早就开着的 B 页 ⇒ B 页 boot 时读的是 false ⇒ 面板显示「关」，看着就像自己关掉了；
  // 更实的一层：转储只在 A 页发生，用户正在看的 B 页一份都不发。
  // shim 的 chrome.storage.onChanged 早已把最新值放进 GM 缓存（读缓存是 O(1) 内存读），core 只差回来重读一遍
  // —— 和 guard 的 syncGuardRemote 同一个套路，不新增任何定时器或消息。
  function syncDumpRemote() {
    let on = dumpOn, html = dumpHtml;
    try { on = GM_getValue(DUMP_KEY, false) === true; } catch (e) { /* 读不到就维持现状，别把开关抹成关 */ }
    try { html = GM_getValue(DUMP_HTML_KEY, false) === true; } catch (e) { /* 同上 */ }
    dumpOn = on; dumpHtml = html;
  }
  // 采集路径专用的读法：先同频再判，保证「开关开着 = 每一页都转储」，而不是「点按钮那一页才转储」
  function dumpEnabled() { syncDumpRemote(); return dumpOn; }

  // ---------- 关注守卫 + 本地两张表（v0.4.0） ----------
  // 反检测口径（和转储同级，是原则不是偏好）：
  //   ① 只用 MutationObserver **读** DOM 变化。不拦点击、不派发事件、不改 X 的节点、不 hook fetch/XHR。
  //      观察对页面没有任何可观测副作用，X 的服务器一条额外请求都收不到。
  //   ② 计数与两张表一律走 GM_setValue（存在扩展自己的 origin）。绝不在脚本里 indexedDB.open()：
  //      那样库会挂在 x.com 这个 origin 上，库名是页面 JS 能枚举到的痕迹。
  //   ③ 到限只警告。要「拦」就得对页面动手，那超出这个项目的边界。
  const FG_KEY = 'ysy.xprobe.guard';
  const RND_KEY = 'ysy.xprobe.randMax';   // 关注冷却的随机加时上限（秒）：60 + 0~rndMax，面板设置区可改（默认 20）
  const DEBUG_KEY = 'ysy.xprobe.debug';   // 调试开关（面板第三个视图「调试」的钥匙）：开着的调试页还会整体落一份进本机日志
  const BADGE_KEY = 'ysy.xprobe.badge';   // v0.8.9：页面内那颗「拉黑」钮的总闸（v0.8.9 定默认关，v0.8.16 用户点头改默认开；关 = 页面零注入，见 renderBlocks 那段说明）
  const USERS_KEY = 'ysy.xprobe.users';
  const POSTS_KEY = 'ysy.xprobe.posts';
  const G15_MAX = 15;               // 15 分钟内最多发出 15 个关注
  const G24_MAX = 400;              // 滚动 24 小时最多 400 个（滚动窗口，不是自然日）
  const COOL_MS = 60000;            // 一次关注后至少隔 60 秒：基线而已，这条仍是给人看的警告，不是拦点击的闸门；每次关注另抽 0~rndMax 秒随机加时
  const W15 = 15 * 60 * 1000;
  const W24 = 24 * 60 * 60 * 1000;
  const FG_MAX = 1200;              // 时间戳数组只留最近这么多条，写得动也读得动
  const USERS_MAX = 600;
  const POSTS_MAX = 1200;
  const HIST_MAX = 40;              // 每个账号保留 40 个采样点（够看趋势，不至于把 GM 存储撑爆）
  const LEDGER_MAX = 4000;
  const EVT_DEDUPE = 3000;          // 同一目标同一方向 3s 内的重复证据只算一次（真机：头部与弹层两个按钮同步翻转、属性轨与挂载轨双认）
  // ---------- v0.8.7 观察器限流（用户现场「评论区一滚动就特别卡」那一刀）----------
  // 真机账（logs/2026-10-26.ndjson，UTC 日重数过）：2660 条 page 记录 / 99.4MB，单条最大 116.1KB（tab=tweet、43 条 article），
  // 最忙的**一分钟 18 枪、914KB** ⇒ 滚动时几乎每 3~5 秒就做一次整页快照 + 全表落盘 + 整文档对账，全压在滚动的那几帧上。
  // ⇒ 滚动时几乎每 5 秒就做一次整页快照 + 全表落盘 + 整文档对账，全压在滚动的那几帧上。
  // 三件事分开管：① 批处理合并（小批仍即时，突发才排队）② 整页快照挑安静边沿做 ③ 落盘与整文档对账限流。
  const MUT_FAST_BATCH = 24;        // 单批记录数超过这个 ⇒ 认定在突发（滚动重建），改排队
  const MUT_FAST_PER_SEC = 6;       // 一秒内最多即时跑这么多趟；超了排队（关注翻转不需要这么快，X 滚动才快）
  const MUT_IDLE_MS = 220;          // 排队后等 DOM 安静 220ms 再合并跑一趟（滚动时一秒几十批 ⇒ 一趟吃完）
  const MUT_QUEUE_MAX = 48;         // 队列最多存这么多批；超了丢最老的并计数上报，不静默吞
  const MUT_NODES = 600;            // 一趟合并 DFS 最多看这么多个节点（原来三趟各扫各的，同一批要扫三遍）
  const MUT_MS = 6;                 // 一趟最多占主线程 6ms：到点收工，漏的交给采集时的全量对账兜底
  const MUT_PROBE = 12;             // 一趟最多留这么多个「改动落点」做 closest 兜底（计数被换掉时落点是按钮内部的 span，DFS 看不见它）
  const TL_BURST_MS = 12000;        // 突发期间被动补采的地板（平时 5 秒一枪，滚动时 12 秒一枪）
  const TL_QUIET_MS = 700;          // 突发期间还要等 DOM 安静 700ms 才做整页快照（快照是整页读 DOM，最重的一枪）
  const TL_QUIET_CAP = 8000;        // 一直在滚也不饿死：最多推迟 8 秒就照采
  const REL_RECON_MIN_MS = 30000;   // 整文档 querySelectorAll 的关系对账：被动那一枪最多 30 秒一次
  const BADGE_MIN_MS = 2500;        // 拉黑徽标全扫的地板（节拍器 1.2 秒一轮，其中一轮就够）
  const BADGE_HEARTBEAT_MS = 15000; // 就算没收到挂载信号，15 秒也必扫一次（兜住漏网的行）
  // v0.8.10 徽标几何：这颗钮改成「浮」在时间右侧那块空白里（position:absolute），参与不了布局，
  // 所以名字/@handle/·/时间谁都不许挪。下面三个数只决定「这一行放得下哪种形态」。
  const BADGE_GAP_PX = 4;           // 与参照物（时间；没有就 @handle）右缘的间距
  const BADGE_FULL_W = 46;          // 「已拉黑」三个字 + 内边距的保守上界（按最长的字样算）
  const BADGE_DOT_W = 14;           // 空白不够时退成的小红点（只表状态，不当按钮）
  // v0.8.11 真机算出来的账（dump/2026-10-26_214118-tweet-benben2052243/page.html，13:41:17Z，ver 0.8.10）：
  // X 的原子类不是我想的那几个 —— r-dnmrzs = max-width:100%、r-1pi2tsx = height:100%，都不带 position，
  // 而 [data-testid="User-Name"] 是 flex-direction:row + align-items:center + max-width:100%，**它抱紧自己的
  // 文字**（不撑满）。那段「时间右侧的大空白」住在它上面第 2~3 层那个 r-1wtj0ep(justify-content:space-between)
  // 的行里 ⇒ 宿主只取到名字行 = 永远量不到空白 = 23 行全判「放不下」、0 颗徽标（debug 记录里的账）。
  const BADGE_HOST_H_MAX = 64;      // 宿主必须是「一行」的高度：再高就不是行，是整条帖子/整屏，别挂
  const BADGE_HOST_UP = 10;         // 从参照物往上最多找 10 层（真机空白那一层在 time 往上第 8~9 层）
  const BADGE_SIB_MAX = 6;          // 每层最多看 6 个后续兄弟（把 rect 次数钉死，性能账不许失控）
  const BADGE_HOST_EXTRA = 3;       // 找到第一个候选宿主之后最多再往上 3 层（真机空白在名字行往上 1~3 层）
  // v0.8.16（用户点名「粉丝列表也要有拉黑钮和标记，放在正在关注/回关左边」）：真机 /followers 那一行
  // 的头像+名字+@handle+简介**整块住在 X 自己的 role=button 里**（点它进主页），老规则「祖先链里有按钮
  // 就否决并 break」⇒ 列表页每一行都记 badgeCta、一颗都不出。现在改成「这一层不能挂 ⇒ 继续往上爬出那颗
  // 按钮」，爬到 UserCell 那层（按钮的父级，我们的徽标不再是那颗按钮的孩子，点它不会导航）。
  const BADGE_CELL_TID = 'UserCell';    // 列表页行容器：它天生比「名字行」高（两三行字），另给一个高度上界
  const BADGE_HOST_H_MAX_CELL = 132;    // 真机粉丝列表一行 ~90-110px；再高就是整屏，别挂
  const BADGE_CTA_DOWN = 3;             // 认「这颗盒子是不是关注钮」时往下最多看 3 层（钮常被包一层 div）
  // v0.8.12 真机算出来的第二笔账（同一行、同一个宿主，dump 里隔一分钟两颗徽标 left 从 264 变成 115）：
  // 「来回跑」不是宿主换层，是**每趟从零重算落点** —— 详情页名字行右边那些盒子（第三方 xro-badge 的
  // 「互关」胶囊、Grok/更多 钮、后到的关注钮）陆续挂上来，缝的划分一变，落点就跟着变。
  // 两条对策：① 已经挂好、且**当前矩形仍然完整躺在某条缝里**的徽标，这一趟一个字都不写（粘住）；
  //          ② 新落点一律贴着缝的左缘（= 紧贴挡住它的那块字右边 4px），不再贴右墙 —— 右墙是
  //            容器右缘，随列宽/滚动条/后到的钮移动，贴它就是「加载一点、跑一点」。
  const BADGE_STICK_TOL = 2;        // 「老位置还站得住」的容差：取整带来的两三像素不许算成挪动
  // v0.8.13 比例标签：贴在拉黑钮右边，底色=档位、字=百分比（用户口径「颜色是标签，标签内是百分比」）。
  // v0.8.14 换位置：比例 = **正在关注 ÷ 关注者**（用户原话「感觉好像算反了，换个位置」；他举的例子
  // 418 关注 / 771 粉丝 ⇒ 54%，真机那颗 2037%（关注者 11000 ÷ 正在关注 540）就是反的产物）。
  // 档位方向用户拍板「照旧 = 越高越绿」：≥95 绿、85~95 黄、<85 红 ⇒ 换位置后读作
  // 「TA 的关注数赶得上（甚至超过）自己的粉丝数」= 绿，「只有粉丝的零头」= 红。
  // 阈值：用户原话给了两个下界（「80%到95是黄色等下，85%以下是红色」）⇒ 取他最后落口的 85，
  // 黄档就是 85~95。要挪回 80 只改 RATIO_YELLOW 这一行，判档、底色、标签预算全跟着走。
  const RATIO_GREEN = 95;           // ≥95% ⇒ 绿（正常）
  const RATIO_YELLOW = 85;          // ≥85% ⇒ 黄（偏低）；再低 ⇒ 红
  const RATIO_CHAR_W = 8;           // 11px 等宽字一个字符的保守宽（标签预算用，别拿实测宽赌）
  const RATIO_PAD_W = 12;           // 标签左右内边距 + 边框
  // v0.8.14 按时间增量：这两个数只在「你悬停名片 / 进 TA 主页」那一刻读得到，所以台账里的数会老。
  // 超过 RATIO_STALE_DAYS 天没再读到 ⇒ 标签转灰虚线（还在，但明说这是旧数）并计入名单的「待补」；
  // 同一个人再悬停一次，哪怕数没变，也补一个采样点（最多每 STAT_CONFIRM_MS 一次，免得每拍都写盘）。
  const RATIO_STALE_DAYS = 30;
  const STAT_CONFIRM_MS = 12 * 3600 * 1000;
  const RATIO_STY = {
    g: { bg: '#1f7a46', fg: '#e7f6ec', name: '绿：正常' },
    y: { bg: '#b6902a', fg: '#241a02', name: '黄：偏低' },
    r: { bg: '#a5342c', fg: '#fbeae8', name: '红：很低' },
  };
  // 性能账：卡顿这事不能再靠猜，每趟跑多久、丢了几批、最重的一枪多少毫秒都得落进 debug 记录里看得回。
  const perf = {
    batches: 0, records: 0, sync: 0, queued: 0, flushed: 0, droppedBatches: 0, droppedRecords: 0,
    nodes: 0, nodeCapHits: 0, timeCapHits: 0, worstPassMs: 0, worstPassNodes: 0,
    passesSeen: 0, hcScans: 0, hcThrottleHits: 0,
    collects: 0, collectBurst: 0, worstCollectMs: 0, lastCollectMs: 0, postponed: 0, starved: 0,
    reconciles: 0, worstReconcileMs: 0, skippedReconciles: 0,
    worstStoreMs: 0, lastStoreMs: 0, storeDigestSaved: 0, storeFlushed: 0,
    badgeScans: 0, badgeSkips: 0, lastBadgeMs: 0, worstBadgeMs: 0,
    badgeDots: 0, badgeNoFit: 0, badgeOk: 0, badgeCta: 0, badgeMoved: 0,   // 出的整颗数 / 退点数 / 空白真放不下 / 宿主住在 X 的可点元素里 / 本趟搬动了几颗
    badgeRatio: 0, badgeRatioNo: 0, badgeRatioOld: 0,   // 本趟：带出标签的颗数 / 有颗但没这两个数 / 标签里数已过期的颗数
    badgeRel: 0, badgeRelNo: 0,           // v0.11.4 本趟：带出「互关/他单向/我单向」的颗数 / 判得出来却画不下（或退成了点）的颗数
    badgeFiber: 0, badgeFiberNo: 0,       // v0.11.7 本趟：用上了桥读数的行数 / 桥里还没有这一行作者新鲜读数的行数（RL-11：缺要说出来）
    hcStat: 0,                        // 累计：名片上「N 正在关注 / N 关注者」读回来并写进 users 台账的次数
    benchAsk: 0, benchFail: 0,        // 累计：标杆窗口问了几回本机库 / 其中几回没回话或被拒（RL-11：读不到要说，不许静默）
    benchBadge: 0, benchBadgeNo: 0, benchBadgeWhy: '',   // 本趟：主页昵称右边那颗「标此人」胶囊出了没；没出的话为什么（RL-11 不许静默）
    benchPBadge: 0, benchPBadgeNo: 0, benchPBadgeWhy: '',   // v0.9.3 本趟：帖子页页头那颗「标此帖」胶囊（同一道闸、同一趟扫描、各记各的账）
  };
  const r1 = (v) => Math.round((v || 0) * 10) / 10;
  // 上报形状：只给结论级的数（趟数/丢弃/最坏毫秒），别把整本流水倒进日志
  function perfLine() {
    return {
      batches: perf.batches, records: perf.records, sync: perf.sync, queued: perf.queued, flushed: perf.flushed,
      droppedBatches: perf.droppedBatches, droppedRecords: perf.droppedRecords,
      nodes: perf.nodes, nodeCapHits: perf.nodeCapHits, timeCapHits: perf.timeCapHits,
      worstPassMs: r1(perf.worstPassMs), worstPassNodes: perf.worstPassNodes, passesWithDom: perf.passesSeen,
      hcScans: perf.hcScans, hcThrottle: perf.hcThrottleHits,
      collects: perf.collects, collectBurst: perf.collectBurst, postponed: perf.postponed, starved: perf.starved,
      lastCollectMs: r1(perf.lastCollectMs), worstCollectMs: r1(perf.worstCollectMs),
      reconciles: perf.reconciles, reconSkips: perf.skippedReconciles, worstReconcileMs: r1(perf.worstReconcileMs),
      storeWrites, storeDigestSaved: perf.storeDigestSaved, storeFlushed: perf.storeFlushed,
      worstStoreMs: r1(perf.worstStoreMs),
      badgeScans: perf.badgeScans, badgeSkips: perf.badgeSkips, worstBadgeMs: r1(perf.worstBadgeMs),
      badgeDots: perf.badgeDots, badgeNoFit: perf.badgeNoFit, badgeOk: perf.badgeOk, badgeCta: perf.badgeCta,
      badgeMoved: perf.badgeMoved, badgeRatio: perf.badgeRatio, badgeRatioNo: perf.badgeRatioNo, badgeRatioOld: perf.badgeRatioOld,
      badgeRel: perf.badgeRel, badgeRelNo: perf.badgeRelNo,
      badgeFiber: perf.badgeFiber, badgeFiberNo: perf.badgeFiberNo,
      hcStat: perf.hcStat,
      benchAsk: perf.benchAsk, benchFail: perf.benchFail,
      benchBadge: perf.benchBadge, benchBadgeNo: perf.benchBadgeNo, benchBadgeWhy: perf.benchBadgeWhy,
      benchPBadge: perf.benchPBadge, benchPBadgeNo: perf.benchPBadgeNo, benchPBadgeWhy: perf.benchPBadgeWhy,
      collectBackoffMs: costBackoffMs(),
      caps: { idleMs: MUT_IDLE_MS, nodes: MUT_NODES, passMs: MUT_MS, queueMax: MUT_QUEUE_MAX,
              fastBatch: MUT_FAST_BATCH, fastPerSec: MUT_FAST_PER_SEC, burstCollectMs: TL_BURST_MS,
              quietMs: TL_QUIET_MS, quietCapMs: TL_QUIET_CAP + costBackoffMs(), reconMs: REL_RECON_MIN_MS,
              badgeMs: BADGE_MIN_MS, badgeBeatMs: BADGE_HEARTBEAT_MS, storeDebounceMs: STORE_DEBOUNCE_MS,
              storeMaxWaitMs: STORE_MAX_WAIT_MS, ratioGreen: RATIO_GREEN, ratioYellow: RATIO_YELLOW,
              ratioStaleDays: RATIO_STALE_DAYS },
    };
  }

  let guard = { follows: [], unfollows: [], ev: [] };
  let guardErr = '', watchOn = false;
  const relLedger = {};             // 目标用户数字ID -> 'follow' | 'unfollow'，跨挂载存活（React 重建节点也能认出翻转）
  const ledgerOrder = [];
  const evtOnce = {};

  function loadGuard() {
    try {
      const g = GM_getValue(FG_KEY, null);
      if (g && Array.isArray(g.follows)) {
        // 整体切片：别把 GM 缓存对象里的数组直接引用进内存账 —— 名面上是「自己的账」，实际跟别人共享同一数组
        guard = {
          follows: g.follows.slice(), unfollows: (g.unfollows || []).slice(), ev: (g.ev || []).slice(),
          cool: g.cool && g.cool.full > 0 ? { at: Number(g.cool.at) || 0, full: Number(g.cool.full), rnd: g.cool.rnd == null ? null : g.cool.rnd } : null,
          goal: normGoal(g.goal),
        };
      }
    } catch (e) { guard = { follows: [], unfollows: [], ev: [], cool: null, goal: null }; }
    pruneGuard(Date.now());
  }
  // 今日关注目标的存档形状（v0.6.9 F3 段）：{day, base, target, src, at}
  // src='hand' 时 base 是用户填的「今日基线」，src='auto' 时 base 只是个记号，随时重算。
  // X 的 24h 是滚动还是自然日本项目给不出证据 ⇒ 不猜：自动基线 = 守卫台账里昨天滚存的那部分，随时可手动盖掉。
  function normGoal(v) {
    if (!v || typeof v !== 'object') return null;
    const base = v.base == null ? null : Math.min(200000, Math.max(0, Math.round(Number(v.base) || 0)));
    const target = v.target == null ? 399 : Math.min(10000, Math.max(1, Math.round(Number(v.target) || 399)));
    return { day: /^(\d{4}-\d{2}-\d{2})$/.test(v.day || '') ? v.day : dayKey(v.at || Date.now()),
      base, target, src: base == null ? 'auto' : 'hand', at: Number(v.at) || 0 };
  }
  function midnightOf(t) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function saveGuard() {
    try { GM_setValue(FG_KEY, guard); guardErr = ''; } catch (e) { guardErr = 'GM 存储写失败: ' + clip(e && e.message, 40); }
  }
  function since(arr, from) { let c = 0; for (let i = arr.length - 1; i >= 0 && arr[i] >= from; i--) c++; return c; }
  function pruneGuard(now) {
    const cut = now - W24;
    if (guard.follows.length && guard.follows[0] < cut) guard.follows = guard.follows.filter((t) => t >= cut);
    if (guard.unfollows.length && guard.unfollows[0] < cut) guard.unfollows = guard.unfollows.filter((t) => t >= cut);
    if (guard.follows.length > FG_MAX) guard.follows = guard.follows.slice(-FG_MAX);
    if (guard.unfollows.length > FG_MAX) guard.unfollows = guard.unfollows.slice(-FG_MAX);
    if (guard.ev.length > 200) guard.ev = guard.ev.slice(-200);
  }
  // ---------- 随机加时（v0.6.8）----------
  // 每次关注的完整冷却 = 60 秒基线 + drawAddSec() 秒（0 ~ 上限，上限在面板设置区改，默认 20）。
  // 上限每次现读现夹：面板改完下一轮关注立即按新上限抽，不用刷新页面。
  function rndMaxGet() {
    let n;
    try { n = Number(GM_getValue(RND_KEY, 20)); } catch (e) { n = 20; }
    if (!isFinite(n)) n = 20;
    return Math.min(300, Math.max(0, Math.round(n)));
  }
  function setRndMax(v) {
    let n = Number(v);
    if (!isFinite(n)) n = 20;
    n = Math.min(300, Math.max(0, Math.round(n)));
    try { GM_setValue(RND_KEY, n); } catch (e) { /* 写不进也就这次会话内用，如实回值 */ }
    return { ok: true, rndMax: n };
  }
  function drawAddSec() {
    const n = rndMaxGet();
    return n <= 0 ? 0 : Math.floor(Math.random() * (n + 1));   // 0..n 都能抽到（含两端）
  }
  // 窗口里最早的那次什么时候「过期」——过期那一刻就腾出一个位置
  function freeIn(arr, now, ms, max) {
    const cut = now - ms;
    if (since(arr, cut) < max) return 0;
    let oldest = Infinity;
    for (let i = arr.length - 1; i >= 0 && arr[i] >= cut; i--) if (arr[i] < oldest) oldest = arr[i];
    return Math.max(0, oldest + ms - now);
  }
  function guardStatus(now) {
    const t = now || Date.now();
    pruneGuard(t);
    const f15 = since(guard.follows, t - W15), f24 = since(guard.follows, t - W24);
    // 冷却看的是「最后一次关注」，不是窗口里的第一条 ⇒ 密集关注时倒计时会被续上，不会提前放绿
    const lastF = guard.follows.length ? guard.follows[guard.follows.length - 1] : 0;
    // 本轮的完整冷却抽好在 guard.cool 里（60 秒 + 0~rndMax 秒随机）。
    // cool.at 与最后一条关注对不上时（旧台账 / 台账被手改过），回退到 60 秒基线：宁短勿假。
    const cool = (guard.cool && guard.cool.full > 0 && guard.cool.at >= lastF) ? guard.cool : null;
    const coolFull = cool ? cool.full : COOL_MS;
    const goal = goalStatus(t);
    return {
      f15, f24, max15: G15_MAX, max24: G24_MAX,
      u15: since(guard.unfollows, t - W15), u24: since(guard.unfollows, t - W24),
      over15: f15 >= G15_MAX, over24: f24 >= G24_MAX,
      free15: freeIn(guard.follows, t, W15, G15_MAX), free24: freeIn(guard.follows, t, W24, G24_MAX),
      ev15: f15 >= Math.ceil(G15_MAX * 0.6), ev24: f24 >= Math.ceil(G24_MAX * 0.8),
      coolAt: lastF, coolFull, coolLeft: lastF ? Math.max(0, lastF + coolFull - t) : 0,
      goalToday: goal,
      err: guardErr, watching: watchOn, events: guard.ev.length, total24: guard.follows.length + guard.unfollows.length,
    };
  }
  // ---------- 今日关注进度（v0.6.9 F4 段；基线/目标只是两件持久化的数，进度数学在 view 层算）----------
  // 「一天」在 X 那边怎么算（滚动 24h 还是自然日）我拿不出证据 ⇒ 基线两档：
  //   auto：分钟线今天最早的「正在关注」读数（自己做基线，去自己主页采一次就有）；
  //   hand：用户在面板填一个数（比如今天开屏时「正在关注」= 2960），填了盖过 auto。
  // 二选一于 core 无所谓：core 只把 {day, base, baseSrc, target, setAt} 与本埠台账 done 原样递出去，
  // 当前读数、涨幅、百分比、ETA 全在 view.goalBar 里按 series.min 算（纯函数，Node 里可断言）。
  function goalStatus(t) {
    const day = dayKey(t);
    const goal = (guard.goal && guard.goal.day === day) ? guard.goal : null;
    let base = null, src = 'auto';
    if (goal && goal.src === 'hand' && goal.base != null) { base = goal.base; src = 'hand'; }
    return { day, base, baseSrc: src, target: (goal && goal.target) ? goal.target : 399,
      setAt: goal ? (goal.at || null) : null, done: since(guard.follows, midnightOf(t)) };
  }
  function setGoal(v) {
    const o = v || {};
    const t = Date.now();
    const prev = (guard.goal && guard.goal.day === dayKey(t)) ? guard.goal : null;
    const baseProp = o.base;   // null/undefined/空 = 自动基线（用分钟线今天的首个读数）；数字 = 手动盖上
    const base = (baseProp === null || baseProp === undefined || baseProp === '') ? null
      : Math.min(200000, Math.max(0, Math.round(Number(baseProp) || 0)));
    const target = (o.target === '' || o.target == null) ? ((prev && prev.target) || 399)
      : Math.min(10000, Math.max(1, Math.round(Number(o.target) || 399)));
    guard.goal = normGoal({ day: dayKey(t), base, target, at: t });
    saveGuard();
    logRec('stat', { reason: 'goalSet', day: guard.goal.day, base, target, src: guard.goal.src });
    return { ok: true, goal: guardToday() };
  }
  function guardToday() { return goalStatus(Date.now()); }
  function ariaHandle(aria) {
    const m = String(aria || '').match(/@([A-Za-z0-9_]{1,20})/);
    return m ? m[1] : '';
  }
  // ---------- 多页签同频（v0.6.9 收尾）----------
  // 真机事实：A 页关注一次后，B 页的倒计时还是自己 boot 那一刻的旧账 —— guard 在内存里只有 boot 读过一次，
  // 而 shim 的 chrome.storage.onChanged 早就把合并结果放进 GM 缓存了，core 只差回来重读一遍。
  // 只认「别家领先」才整体换账本：own 写完立即回读到的一定是 equal 或自己那份（put 同步改缓存），不会倒灌。
  function syncGuardRemote() {
    let g = null;
    try { g = GM_getValue(FG_KEY, null); } catch (e) { return; }
    if (!g || !Array.isArray(g.follows)) return;
    const lastF = guard.follows.length ? guard.follows[guard.follows.length - 1] : 0;
    const lastFRemote = g.follows.length ? g.follows[g.follows.length - 1] : 0;
    if (lastFRemote > lastF) {
      guard = {
        follows: g.follows.slice(),
        unfollows: (Array.isArray(g.unfollows) ? g.unfollows : []).slice(),
        ev: (Array.isArray(g.ev) ? g.ev : []).slice(),
        cool: g.cool && g.cool.full > 0 ? { at: Number(g.cool.at) || 0, full: Number(g.cool.full), rnd: g.cool.rnd == null ? null : g.cool.rnd } : null,
        goal: normGoal(g.goal),
      };
      pruneGuard(Date.now());
    }
  }
  function recordAction(dir, info) {
    const now = Date.now();
    syncGuardRemote();   // 动作前先吃进别家的账：gap/rapid 要按「两页合起来的最后一条关注」量
    // 间隔要在 push 之前量：推完再量，第一条永远「距自己 0 秒」
    const prevF = guard.follows.length ? guard.follows[guard.follows.length - 1] : 0;
    const gap = prevF ? now - prevF : null;
    if (dir === 'follow') {
      guard.follows.push(now);
      // 本轮的随机加时在动作发生那一刻就抽好：浮标、面板横幅、日志读到的是同一个数
      const drawn = drawAddSec();
      guard.cool = { at: now, full: COOL_MS + drawn * 1000, rnd: drawn };
    } else guard.unfollows.push(now);
    pruneGuard(now);
    const s = guardStatus(now);
    if (dir === 'follow') s.rnd = guard.cool.rnd;   // 流水与日志都带本轮抽到的加时秒数
    s.gap = gap; s.rapid = dir === 'follow' && gap != null && gap < COOL_MS;
    guard.ev.push({ at: now, dir, id: info.id || '', handle: info.handle || '', why: info.why || '', w15: s.f15, w24: s.f24, suspect: !!info.suspect, rnd: dir === 'follow' ? guard.cool.rnd : null });
    saveGuard();
    render();
    // 关注/取关会动「正在关注」「关注者」两个数，也有别人被这条动作影响的可能 ⇒ 2.5s 后把页面数字重读一次
    if (statTimer) clearTimeout(statTimer);
    statTimer = setTimeout(() => { statTimer = 0; refreshStats(dir); }, 2500);
    return s;
  }

  function btnFollowState(node) {
    if (!node || !node.getAttribute) return null;
    const m = String(node.getAttribute('data-testid') || '').match(/^(\d{5,})-(follow|unfollow)$/);
    return m ? { id: m[1], state: m[2], node } : null;
  }
  function followNodesIn(node, out, budget) {
    // v0.8.7：观察器那一侧改用 runPass/walkInto 的单趟合并 DFS（节点预算 + 截止时间），这条递归只留给
    // 控制台与自检按需调用；热路径不再逐批跑它——旧写法每批三趟独立扫描，滚动时把主线程占满。
    if (!node || !node.getAttribute || budget.n <= 0) return out;
    budget.n--;
    if (btnFollowState(node)) out.push(node);
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) followNodesIn(kids[i], out, budget);
    return out;
  }
  function ledgerSet(id, state) {
    if (relLedger[id] === undefined) { ledgerOrder.push(id); while (ledgerOrder.length > LEDGER_MAX) delete relLedger[ledgerOrder.shift()]; }
    relLedger[id] = state;
  }
  // 核心判据：按钮从 -follow 变成 -unfollow 形态 = 「现在已关注」= 刚发出一个关注。
  // 第一次见到某目标只登记基线，绝不计数 ⇒ 浏览关注列表时满屏 -unfollow 不会被算成我关注了 N 个人。
  // v0.7.0：按钮翻转（或第一次看到它）就是最实时的关系证据 —— 以前只记 follow 流水，
  // users 表里的 relation 要等下一次采集才更新，于是「刚点完关注，广场上还是未关注」。
  // handle 取不到时宁可这张表不写（写错人比晚写一天更糟）；流水那一路照记。
  function btnHandle(node) {
    const h = normHandle(ariaHandle(node.getAttribute('aria-label') || ''));
    if (h) return h;
    const cell = node.closest ? node.closest('[data-testid="UserCell"]') : null;
    if (cell) {
      let out = '';
      cell.querySelectorAll('a[href]').forEach((a) => {
        if (out) return;
        const href = a.getAttribute('href') || '';
        if (/^\/@?[A-Za-z0-9_]+$/.test(href)) out = href.replace(/^\/@?/, '');
      });
      if (out) return normHandle(out);
    }
    return tabName() === 'profile' ? normHandle(handleFromPath(location.pathname)) : '';
  }
  function applyRelation(node, state) {
    const h = btnHandle(node);
    if (!h) return '';
    const rel = state === 'unfollow' ? 'following' : 'not_following';
    // 只修表里已有的人：开机扫一遍满屏关注按钮（含推荐位/侧栏）不等于这些账号进过我的表，
    // 给它们凭空造行会把「最该关注」灌满噪声。新面孔由采集那一侧（列表/时间线/主页）入表。
    const u = users[h];
    if (!u || u.relation === rel) return h;
    u.relation = rel;
    u.updatedAt = Date.now();
    scheduleStoreWrite();
    return h;
  }
  function onFollowSeen(node, why, suspect) {
    const b = btnFollowState(node);
    if (!b) return null;
    const prev = relLedger[b.id];
    const cur = b.state;
    // 首次见到的按钮不计数（那是浏览列表），但它的状态本身是真证据：这正是「哪些已关注」的来源
    if (prev === undefined) { ledgerSet(b.id, cur); applyRelation(node, cur); return null; }
    if (prev === cur) return null;
    ledgerSet(b.id, cur);
    applyRelation(node, cur);
    const dir = cur === 'unfollow' ? 'follow' : 'unfollow';
    const k = b.id + '|' + dir;
    const now = Date.now();
    if (evtOnce[k] && now - evtOnce[k] < EVT_DEDUPE) return null;
    evtOnce[k] = now;
    // 反向动作一发生就把对面那个键清掉：手快点错「关注→取关→再关注」是真的两次动作，
    // 不能按重复证据吞掉 —— 吞掉就是低估，低估才是会让人撞 400 的那一侧
    delete evtOnce[b.id + '|' + (dir === 'follow' ? 'unfollow' : 'follow')];
    const s = recordAction(dir, { id: b.id, handle: ariaHandle(node.getAttribute('aria-label') || ''), why, suspect });
    logRec('follow', {
      dir, targetId: b.id, handle: ariaHandle(node.getAttribute('aria-label') || ''), why: why || '',
      suspect: !!suspect, from: prev + '→' + cur, w15: s.f15, w24: s.f24, max15: G15_MAX, max24: G24_MAX,
      over15: s.over15, over24: s.over24, gap: s.gap, rapid: s.rapid, cool: s.coolFull, rnd: s.rnd == null ? null : s.rnd, tab: tabName(),
    });
    return dir;
  }
  // ---------- v0.8.7：观察器 = 「小批即时 / 突发排队」+ 一趟合并 DFS ----------
  // 旧写法每批连跑三趟独立扫描（守卫 DFS、时间线信号、悬停名片），同一棵子树滚一下被读三遍，
  // 三遍都在 MutationObserver 的同步回调里 ⇒ 主线程被自家扫描占满，X 的「加载更多」哨兵一直留在视口里
  // 反复触发（用户现场「评论区一滚动就触发更多、越滚越卡」）。现在一趟 DFS 把所有信号读干，突发时排队合并。
  const METRIC_TID = { like: 1, unlike: 1, reply: 1, retweet: 1, view: 1 };
  const FOL_TAIL = /-(?:follow|unfollow)$/;
  let mutQueue = [], mutTimer = 0, lastMutAt = 0, burstUntil = 0, fastStamps = [];
  let relLastAt = 0, badgeNeedScan = true, badgeLastScan = 0;
  function nowMs() {
    const p = globalThis.performance;
    return (p && typeof p.now === 'function') ? p.now() : Date.now();
  }
  function isOwnNode(n) {
    // 探针自己缝进页面的节点（拉黑徽标 data-xprobe="blk"、面板根）不许再喂回观察器：那是自激回路
    if (!n || !n.getAttribute) return false;
    if (n.getAttribute('data-xprobe') === 'blk') return true;
    try { return !!(n.closest && n.closest('[data-xprobe]')); } catch (e) { return false; }
  }
  function inBurst() { return Date.now() < burstUntil; }
  // 即时趟额度：一秒内最多 MUT_FAST_PER_SEC 趟、单批不超过 MUT_FAST_BATCH 条。
  // 用户点一下关注只有一两批 ⇒ 当场跑完，关系与流水零延迟（这是唯一要「即时」的证据）；
  // 滚动时一秒几十批 ⇒ 从超额那一批起排队，几十批吃成一趟 DFS。
  function fastPassAllowed(n) {
    const now = Date.now();
    if (n > MUT_FAST_BATCH) { burstUntil = now + 1500; return false; }
    fastStamps = fastStamps.filter((t) => now - t < 1000);
    if (fastStamps.length >= MUT_FAST_PER_SEC) { burstUntil = now + 1500; return false; }
    fastStamps.push(now);
    return true;
  }
  // 一趟 DFS：显式栈（深层 DOM 递归会爆栈，也没法在中途查截止时间），节点预算 + 墙钟截止时间双闸
  function walkInto(root, st, out) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || !node.getAttribute) continue;
      if (st.n <= 0) { st.nodeCap = 1; st.stop = 1; return; }
      st.seen++;
      if ((st.seen & 31) === 0 && nowMs() > st.until) { st.timeCap = 1; st.stop = 1; return; }
      st.n--;
      const tid = node.getAttribute('data-testid');
      if (tid) {
        if (tid === 'like' || tid === 'unlike') st.liked = 1;
        else if (tid === 'reply' || tid === 'retweet' || tid === 'view') st.metric = 1;
        else if (tid === 'HoverCard') st.hover = 1;
        else if (FOL_TAIL.test(tid)) { const f = btnFollowState(node); if (f) out.push({ n: node, why: 'mount' }); }
      }
      if ((node.tagName || '').toUpperCase() === 'ARTICLE') st.article = 1;
      const kids = node.children;
      if (kids && kids.length) for (let i = kids.length - 1; i >= 0; i--) { if (kids[i]) stack.push(kids[i]); }
    }
  }
  function runPass(batches, via) {
    if (via === 'sync') perf.sync++; else perf.flushed++;
    const t0 = nowMs();
    const st = { n: MUT_NODES, until: t0 + MUT_MS, seen: 0, nodeCap: 0, timeCap: 0, stop: 0,
                 hover: 0, liked: 0, metric: 0, article: 0, walked: 0, probe: [] };
    const found = [];
    for (let bi = 0; bi < batches.length && !st.stop; bi++) {
      const recs = batches[bi];
      if (!recs || !recs.length) continue;
      for (let i = 0; i < recs.length && !st.stop; i++) {
        const r = recs[i];
        if (!r) continue;
        const tgt = r.target;
        if (tgt && isOwnNode(tgt)) continue;     // 我自己缝的节点落进来的批次：不喂回扫描（自激回路）
        if (r.type === 'attributes') {
          if (!tgt || !tgt.getAttribute) continue;
          const tid = tgt.getAttribute('data-testid');
          if (!tid) continue;
          st.walked++;
          if (FOL_TAIL.test(tid)) { const f = btnFollowState(tgt); if (f) found.push({ n: tgt, why: 'attr' }); }
          else if (tid === 'like' || tid === 'unlike') st.liked = 1;
          else if (METRIC_TID[tid]) st.metric = 1;
          continue;
        }
        if (r.type !== 'childList') continue;
        // 落点自己就是按钮/分组时一眼认出来（X 更新计数是整颗 span 换掉，落点常在按钮里面）
        if (tgt && tgt.getAttribute) {
          const ttid = tgt.getAttribute('data-testid');
          // 注意口径：childList 落在按钮里 = 「计数被换掉」= metric；'liked' 只由 attributes 那一腿给出
          // （like↔unlike 翻转才是「我赞过」的证据，把两者混了日志里的 auto 就不可信了）
          if (METRIC_TID[ttid]) st.metric = 1;
          else if (st.probe.length < MUT_PROBE) st.probe.push(tgt);
        }
        const added = r.addedNodes || [];
        // 只做「新增节点」这一侧：移除节点数不清（虚拟列表滚一下就是成堆 remove），
        // 而 React 重建按钮时新节点一定会带着新状态出现，靠台账 diff 就抓得到
        for (let j = 0; j < added.length; j++) {
          const node = added[j];
          if (!node || node.nodeType !== 1 || isOwnNode(node)) continue;
          st.walked++;
          walkInto(node, st, found);
          if (st.stop) break;
        }
      }
    }
    // 兜底：X 更新计数是「把按钮里那颗 span 换掉」，落点自己没有 testid、挂上来的也只是裸 span ⇒ DFS 看不见信号。
    // 旧写法对每条记录都做 closest（突发时就是几百次上溯）；现在只对最多 MUT_PROBE 个落点做，且只在没别的信号时才做。
    if (!st.liked && !st.metric) {
      for (let i = 0; i < st.probe.length && !st.metric; i++) {
        const t = st.probe[i];
        try {
          if (t.closest && t.closest('[data-testid="like"], [data-testid="unlike"], [data-testid="reply"], [data-testid="retweet"], [data-testid="view"]')) st.metric = 1;
        } catch (e) { /* 选择器读不动就当没这条 */ }
      }
    }
    perf.nodes += st.seen;
    if (st.nodeCap) perf.nodeCapHits++;
    if (st.timeCap) perf.timeCapHits++;
    if (st.walked) { badgeNeedScan = true; perf.passesSeen++; }
    // ① 守卫：关注按钮第一次只登记基线，翻转才计数 —— 同步跑完，关系与流水不等下一拍
    for (let k = 0; k < found.length; k++) onFollowSeen(found[k].n, found[k].why);
    // ② 悬停名片：这一趟只出「出现过 HoverCard」这个信号，读不读由节流说了算
    if (st.hover) scanHoverCards();
    // ③ 时间线补采信号：点赞翻转最实（立刻留点），其次新卡片挂上来，最后才是计数节点被换掉
    if (st.liked) collectSoon('liked');
    else if (st.article) collectSoon('new-article');
    else if (st.metric) collectSoon('metric');
    // ④ 分析页 tooltip：自己带 300ms 去抖，这里只递「有动静」这一个信号
    try { onAnalyticsMutation(); } catch (e) { /* 交给 animp/stat 通道 */ }
    const ms = nowMs() - t0;
    if (ms > perf.worstPassMs) perf.worstPassMs = ms;
    if (st.seen > perf.worstPassNodes) perf.worstPassNodes = st.seen;
    return { nodes: st.seen, follows: found.length, hover: st.hover, liked: st.liked,
             article: st.article, metric: st.metric, nodeCap: st.nodeCap, timeCap: st.timeCap, ms: Math.round(ms * 10) / 10 };
  }
  function flushMutQueue() {
    mutTimer = 0;
    if (!mutQueue.length) return 0;
    const b = mutQueue; mutQueue = [];
    try { return runPass(b, 'queue').nodes; } catch (e) { guardErr = 'observer 抛错: ' + clip(e && e.message, 40); render(); return 0; }
  }
  function feedMutations(recs) {
    const n = recs && recs.length ? recs.length : 0;
    perf.batches++; perf.records += n;
    lastMutAt = Date.now();
    if (!n) return 0;
    if (fastPassAllowed(n)) {
      try { return runPass([recs], 'sync').nodes; }
      catch (e) { guardErr = 'observer 抛错: ' + clip(e && e.message, 40); render(); return 0; }
    }
    perf.queued++;
    mutQueue.push(recs);
    // 队列封顶：超了丢最老的，且把「丢了」记在账上（漏掉的按钮由采集时的全量对账兜底，不静默吞）
    while (mutQueue.length > MUT_QUEUE_MAX) {
      const gone = mutQueue.shift(); perf.droppedBatches++; perf.droppedRecords += (gone && gone.length) || 0;
    }
    if (!mutTimer) mutTimer = setTimeout(flushMutQueue, MUT_IDLE_MS);
    return 0;
  }
  // 旧公开名保留（控制台与自检直接投单批）：语义仍是「当场把这批读完」
  function onMutations(recs) { return runPass([recs || []], 'sync'); }
  let mo = null;
  function startFollowWatch() {
    if (typeof MutationObserver !== 'function' || mo) return false;
    const target = document.body || document.documentElement;
    if (!target || !target.nodeType) return false;
    try {
      // 回调本身只做一件事：记账 + 决定「当场跑」还是「排队」。DOM 扫描绝不在这条微任务里成串跑。
      mo = new MutationObserver((recs) => { feedMutations(recs); });
      mo.observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-testid'] });
      watchOn = true;
    } catch (e) { guardErr = 'observer 起不来: ' + clip(e && e.message, 40); watchOn = false; }
    return watchOn;
  }
  // 换页/采集时补一次全量对账：观察者漏掉的（排队丢批、预算截断、标签页在后台被节流）在这里补上。
  // 这是整文档 querySelectorAll（后缀属性选择器没有索引可用 ⇒ 大 DOM 上是实打实的一趟全扫），
  // 所以被动那一枪只按 REL_RECON_MIN_MS 的频次跑；手动/换页/开机仍然当场跑。
  function reconcileRel(why) {
    const t0 = nowMs();
    let n = 0;
    relLastAt = Date.now();
    perf.reconciles++;
    document.querySelectorAll('[data-testid$="-follow"], [data-testid$="-unfollow"]').forEach((b) => {
      if (!btnFollowState(b)) return;
      n++;
      onFollowSeen(b, why || 'reconcile');
    });
    const ms = nowMs() - t0;
    if (ms > perf.worstReconcileMs) perf.worstReconcileMs = ms;
    return n;
  }
  // 被动补采时的限流版对账：到点才跑，没到点只计数（漏下的基线不影响流水判据——流水看的是翻转）
  function reconcileRelGated(why) {
    if (Date.now() - relLastAt < REL_RECON_MIN_MS) { perf.skippedReconciles++; return -1; }
    return reconcileRel(why);
  }

  // ---------- 时间线被动补采（v0.7.0） ----------
  // 帖子数据一直在变（曝光、赞），要算增速就得有第二个点。用户不点按钮、不刷新，也得留点。
  // 触发只有两类，都是**只读**：新卡片挂上来；卡片里的计数/点赞态被换掉。
  // 不滚动、不翻页、不点击 —— 只采「已经出现在屏幕上」的那一屏，和手动采集采到的是同一批。
  const TL_MIN_MS = 5000;   // 两次自动采之间至少隔这么久（X 一秒能换几十个节点，不设这个就是每帧一采）
  const TL_SCAN = 400;      // 单批记录最多看这么多条，剩下的交给下一批
  let tlTimer = 0, tlLastAt = 0, tlWhy = '';
  // 整页快照（snapshot 把这一屏每条 article 的文本/计数全读一遍）是最重的一枪：
  // 突发（=正在滚）时把它推到 DOM 的安静边沿上做；一直滚不停就按 TL_BURST_MS 隔一枪，
  // 而这一枪的间隔还要跟着**上一次整页快照的实际开销**往后退（costBackoffMs）。
  // 为什么要跟着开销走：长评论区每条 article 要跑七八个选择器，300 条时一趟就是一百多毫秒，
  // 固定 12 秒的地板等于让这记重锤每 12 秒砸一次主线程——用户说的「一滚就特别卡」就是这个。
  // 口径：开销超过 25 毫秒后每 1 毫秒换 100 毫秒休息（占空比 1%），最多再加 30 秒；
  // 小页面（一趟十几毫秒）加时为 0，行为与 v0.7.0 完全一致。
  function costBackoffMs() {
    const c = perf.lastCollectMs || 0;
    return c > 25 ? Math.min(30000, Math.round(c * 100)) : 0;
  }
  function collectSoon(why) {
    if (tlTimer) return;
    const tab = tabName();
    if (!REPORTABLE[tab] || LIST_TABS.indexOf(tab) >= 0) return;   // 列表页没有 article，白跑一趟
    const now = Date.now();
    tlWhy = why;
    const back = costBackoffMs();
    const floor = (now < burstUntil ? TL_BURST_MS + back : TL_MIN_MS) - (now - tlLastAt);
    let wait = Math.max(0, floor);
    if (now < burstUntil) {
      const quiet = TL_QUIET_MS - (now - lastMutAt);
      if (quiet > 0) wait = Math.max(wait, quiet);
      else if (now - lastMutAt >= TL_QUIET_CAP + back) { wait = 0; perf.starved++; }   // 一直滚也别饿死
      if (wait > 0) perf.postponed++;
      perf.collectBurst++;
    }
    tlTimer = setTimeout(() => {
      tlTimer = 0;
      tlLastAt = Date.now();
      const w = tlWhy; tlWhy = '';
      const t0 = nowMs();
      try { doCollect({ passive: w }); } catch (e) { /* 补采失败不许把守卫/浮标一起带走 */ }
      const ms = nowMs() - t0;
      perf.lastCollectMs = Math.round(ms * 10) / 10;
      if (ms > perf.worstCollectMs) perf.worstCollectMs = ms;
    }, wait);
  }

  // ---- 两张表：users（谁、多少粉丝、我和他什么关系、他什么时候开始出现在我的关注/粉丝列表里）
  //        posts（哪条推文、我第一次什么时候见到它 = 新帖判据、互动数）
  let users = {}, posts = {}, storeErr = '', storeTimer = 0, storeWrites = 0, lastUpsert = null;
  // 落表防抖的两个口径：窗口 8 秒（一屏改完就一次），但脏账最长压 40 秒必须落一次（封顶，别憋在内存里）
  const STORE_DEBOUNCE_MS = 8000;
  const STORE_MAX_WAIT_MS = 40000;
  let storeDirtySince = 0;
  // 两张表的「顶到没顶」账本：一次会话里累计删了多少行、现在还剩多少、离上限多远。
  // posts 早就顶满 1200 过，之前这事只能靠我猜 ⇒ 现在每条 store 日志都带着它。
  let trimMeta = { usersKept: 0, postsKept: 0, usersDropped: 0, postsDropped: 0, droppedAt: 0, usersMax: USERS_MAX, postsMax: POSTS_MAX };
  function loadStores() {
    try { users = GM_getValue(USERS_KEY, {}) || {}; } catch (e) { users = {}; }
    try { posts = GM_getValue(POSTS_KEY, {}) || {}; } catch (e) { posts = {}; }
  }
  // 顶到上限会静默删行 —— 而删行本身就是我迟早要看的证据（哪些行被挤掉了、当前离顶还有多远）。
  // 所以 trim 除了返回瘦身后的对象，还要报丢弃数，由 writeStores 汇总进 trimMeta 随日志回传。
  function trim(obj, max, field) {
    const ks = Object.keys(obj);
    if (ks.length <= max) return { obj: obj, dropped: 0 };
    ks.sort((a, b) => (obj[a][field] || 0) - (obj[b][field] || 0));
    const dropped = ks.length - max;
    for (let i = 0; i < dropped; i++) delete obj[ks[i]];
    return { obj: obj, dropped: dropped };
  }
  function storeErrOf(keys) {
    const s = globalThis.__XP_STORE__;
    if (!s || !s.err) return '';
    for (let i = 0; i < keys.length; i++) if (s.err[keys[i]]) return '表写失败: ' + clip(s.err[keys[i]], 40);
    return '';
  }
  function writeStores() {
    const t0 = nowMs();
    let thrown = '';
    try {
      const ut = trim(users, USERS_MAX, 'updatedAt');
      const pt = trim(posts, POSTS_MAX, 'seenAt');
      users = ut.obj; posts = pt.obj;
      if (ut.dropped || pt.dropped) {
        trimMeta.usersDropped += ut.dropped; trimMeta.postsDropped += pt.dropped;
        trimMeta.droppedAt = Date.now();
      }
      GM_setValue(USERS_KEY, users); GM_setValue(POSTS_KEY, posts); storeWrites++;
    }
    catch (e) { thrown = '表写失败: ' + clip(e && e.message, 40); }
    trimMeta.usersKept = Object.keys(users).length;
    trimMeta.postsKept = Object.keys(posts).length;
    trimMeta.usersFull = trimMeta.usersKept >= USERS_MAX;
    trimMeta.postsFull = trimMeta.postsKept >= POSTS_MAX;
    // GM_setValue 在这一层是异步的（转交 SW 落盘），当场不会抛 ⇒ 写失败只能回头查适配层的账本。
    // 成功一次会把 err[key] 抹掉，所以这里读到的是「当前仍未落盘」的错误，不会烂尾在面板上。
    storeErr = thrown || storeErrOf([USERS_KEY, POSTS_KEY]);
    const ms = nowMs() - t0;
    perf.lastStoreMs = Math.round(ms * 10) / 10;
    if (ms > perf.worstStoreMs) perf.worstStoreMs = ms;
    sendStoreRec(false);
  }

  // 表内容回传：以前日志里只有「users=3 posts=12」这种计数，表里到底存成什么样我看不见，
  // 于是脏名字、别人的粉丝数、推荐位行只能等下次真机翻页才暴露。落表后把最新 12 行 / 8 行摘要发一条，
  // 内容没变不发，30s 内最多一条（限速的是给我看的日志，不是对 X 的任何请求）
  let storeRecTimer = 0, lastStoreHash = '', lastStoreSentAt = 0;
  // 切片不能再只看 updatedAt：每次采集都会把当前屏上所有行的 updatedAt 推到最新，
  // 于是「纯见过」的新行不断把带数字的旧行挤出格子（真机 2026-10-23：13:05 那几份切片 12 格里还有 7 行带粉丝数，
  // 14:10 以后只剩 5 行 —— 表里带数的行一条没少，掉的是它们被看见的机会）。
  // 改成两组：带数字的按「最后一个数据点」优先排前面，剩下的格子才给纯见过的行。
  function userHasNum(u) { return u.followers != null || u.following != null; }
  function postHasNum(p) { return p.reply != null || p.repost != null || p.quote != null || p.like != null || p.view != null; }
  function lastPointAt(u) {
    const h = u.hist || [];
    for (let i = h.length - 1; i >= 0; i--) if (h[i] && h[i].at) return h[i].at;
    return 0;
  }
  function splitKeys(obj, hasNum, timeFn) {
    const a = [], b = [];
    Object.keys(obj).forEach((k) => (hasNum(obj[k]) ? a : b).push(k));
    const t = (k) => timeFn(obj[k]) || 0;
    a.sort((x, y) => t(y) - t(x)); b.sort((x, y) => t(y) - t(x));
    return { num: a, bare: b };
  }
  function storeDigest() {
    const gu = splitKeys(users, userHasNum, (u) => lastPointAt(u) || u.updatedAt || 0);
    const gp = splitKeys(posts, postHasNum, (p) => p.seenAt || 0);
    return {
      counts: { users: gu.num.length + gu.bare.length, posts: gp.num.length + gp.bare.length, series: seriesStats() },
      groups: { uNum: gu.num.length, uBare: gu.bare.length, pNum: gp.num.length, pBare: gp.bare.length },
      users: gu.num.concat(gu.bare).slice(0, 12).map((k) => {
        const u = users[k] || {};
        return { h: k, n: clip(u.name || '', 28), f: u.followers == null ? null : u.followers, fw: u.following == null ? null : u.following, fe: !!u.followersExact, rel: u.relation || '', own: !!u.own, seenAs: Object.keys(u.seenAs || {}), pts: (u.hist || []).length, sn: userHasNum(u) ? 1 : 0 };
      }),
      posts: gp.num.concat(gp.bare).slice(0, 8).map((k) => {
        const p = posts[k] || {};
        return { id: k, h: p.handle || '', t: clip(p.text || '', 36), fs: String(p.firstSeenAt || '').slice(0, 19), rp: p.reply == null ? null : p.reply, rt: p.repost == null ? null : p.repost, lk: p.like == null ? null : p.like, vw: p.view == null ? null : p.view, n: p.n || 1, sn: postHasNum(p) ? 1 : 0 };
      }),
      trim: trimMeta,
    };
  }
  function sendStoreRec(force) {
    storeRecTimer = 0;
    // 顺序要紧：旧写法每落一次表都先把整张表切片排序 + JSON.stringify 一遍，才发现「30 秒内已经发过了」。
    // 现在先过限速，再算摘要 —— 突发滚动时这一笔省下的就是几百 KB 的白干活。
    const now = Date.now();
    if (!force && lastStoreSentAt && now - lastStoreSentAt < 30000) {
      // 不在这排「30 秒后补发」那一枪：落表本身就有 ≥8 秒的防抖节拍，下一次 writeStores 会再来问一遍。
      // 排了它等于每落一次表多挂一个定时器，摘要也确实没变过（变了才值得发）。
      perf.storeDigestSaved++;
      return null;
    }
    const d = storeDigest();
    const hash = JSON.stringify(d);
    if (!force && hash === lastStoreHash) return null;
    lastStoreHash = hash; lastStoreSentAt = now;
    logRec('store', d);
    return d;
  }
  // 落表节流（v0.8.7）：一次采集会把满屏几十行的 updatedAt 全推一遍 ⇒ 每行都叫一次 scheduleStoreWrite。
  // 旧写法 3 秒防抖、每次重新排，滚动时几乎五秒就整表 stringify 一次；现在窗口里只留一枪，
  // 但最长等待封顶 STORE_MAX_WAIT_MS —— 一直改也得按段落盘，别把账憋在内存里。
  function scheduleStoreWrite() {
    const now = Date.now();
    if (!storeDirtySince) storeDirtySince = now;
    if (storeTimer) return;
    const wait = Math.max(0, Math.min(STORE_DEBOUNCE_MS, STORE_MAX_WAIT_MS - (now - storeDirtySince)));
    storeTimer = setTimeout(() => { storeTimer = 0; storeDirtySince = 0; writeStores(); }, wait);
  }
  // 页面要走了：把还压在防抖窗口里的表立刻落下去（只写存储，不发请求）
  function flushStoreNow(why) {
    if (storeTimer) { clearTimeout(storeTimer); storeTimer = 0; }
    storeDirtySince = 0;
    try { writeStores(); } catch (e) { storeErr = '收尾落表抛错: ' + clip(e && e.message, 40); }
    if (why) perf.storeFlushed++;
    return storeWrites;
  }
  function pickNum(o) {
    if (!o) return null;
    const v = o.visibleNum || {}, a = o.ariaNum || {};
    if (v.exact === true && v.value != null) return { value: v.value, exact: true };
    if (a.exact === true && a.value != null) return { value: a.value, exact: true };
    if (v.value != null) return { value: v.value, exact: false };
    return null;
  }
  function emptyUser(handle) {
    return { handle, name: '', relation: '', followers: null, following: null, followersExact: null, statsAt: 0, own: false, seenAs: {}, hist: [], firstSeenAt: 0, updatedAt: 0 };
  }
  function touchUser(handle, now) {
    if (!handle) return null;
    let u = users[handle];
    if (!u) { u = users[handle] = emptyUser(handle); u.firstSeenAt = now || Date.now(); }
    if (!u.seenAs) u.seenAs = {};
    if (!u.hist) u.hist = [];
    return u;
  }
  function setStat(u, key, num, now) {
    if (!num || num.value == null) return false;
    if (u[key] === num.value) return false;
    u[key] = num.value;
    u[key + 'Exact'] = !!num.exact;
    return true;
  }
  // v0.8.14「最后一次真读到这两个数」的时刻：hist 记的是**变化点**（值没变就不堆点，那条老判据钉着），
  // 所以「这数几天没更新了」不能拿 hist 判 ⇒ 单独记一个 statsAt。同一份数在 STAT_CONFIRM_MS 内反复
  // 读到不重记（悬停名片每拍都在扫，不然一次悬停能顶出几十次落盘）。
  function noteStatsSeen(u, now) {
    if (!u || (u.following == null && u.followers == null)) return false;
    const t = now || Date.now();
    if (u.statsAt && t - u.statsAt < STAT_CONFIRM_MS) return false;
    u.statsAt = t;
    return true;
  }
  function upsertStores(snap, nowOpt) {
    const now = nowOpt || Date.now();
    const at = new Date(now).toISOString();
    let touched = 0, newPosts = 0, newOnes = 0, skippedRows = 0, foreignStats = 0;
    const idt = snap.identity || {};
    if (idt.handle && !idt.listTab) {
      const u = touchUser(idt.handle, now);
      if (u) {
        // 名字会被第三方角标污染（真机「月川互关」），所以剥过注入的那一版才允许覆盖已有名字；
        // 已经存过脏名字的，等一次 nameForeign=0 的干净读回来再修
        if (idt.displayName && (!u.name || (idt.nameForeign === 0 && u.name !== idt.displayName))) u.name = idt.displayName;
        u.own = !!idt.ownProfile;
        if (idt.ownProfile && idt.handle) rememberOwn(idt.handle);
        if (idt.ownProfile && idt.selfHandleGuess) rememberOwn(idt.selfHandleGuess);
        if (idt.followRelation) u.relation = idt.followRelation;
        const f = pickNum(snap.stats.following), fo = pickNum(snap.stats.followers) || pickNum(snap.stats.verified_followers);
        const ch = setStat(u, 'following', f, now) | setStat(u, 'followers', fo, now);
        if (ch || !u.hist.length) {
          if (!u.hist.length || ch) u.hist.push({ at, followers: u.followers, following: u.following });
          if (u.hist.length > HIST_MAX) u.hist = u.hist.slice(-HIST_MAX);
        }
        noteStatsSeen(u, now);   // v0.8.14：主页头部这一路同样是「读到数」的时刻（标签上的「几天前」吃它）
        u.updatedAt = now; touched++;
      }
    }
    foreignStats = ((snap.stats || {}).__foreign || []).length;
    // 列表页：谁在我关注里 / 谁在关注我，靠「首次出现在这个列表里」判定，比拿计数差稳（帖子总数那条经验同样适用于这里）
    (snap.users || []).forEach((r) => {
      if (!r.handle) return;
      if (r.origin === 'side') { skippedRows++; return; }   // 推荐位行不是「我关注的人」，别落表
      const u = touchUser(r.handle, now);
      if (!u) return;
      if (r.name && (!u.name || (r.nameForeign === 0 && u.name !== r.name))) u.name = r.name;
      if (r.followState === 'following') u.relation = 'following';
      else if (r.followState === 'not_following' && r.followState) u.relation = r.followState;
      const bucket = snap.usersListTab || snap.listTab || snap.tab;
      if ((bucket === 'following' || bucket === 'followers' || bucket === 'verified_followers') && !u.seenAs[bucket]) {
        u.seenAs[bucket] = at; newOnes++;
      }
      u.updatedAt = now; touched++;
    });
    (snap.tweets || []).forEach((t) => {
      if (!t.tweetId || t.adSuspect) return;
      const p = posts[t.tweetId];
      const m = t.metrics || {};
      const mv = (k) => (m[k] && m[k].num ? m[k].num.value : null);
      const rec = p || (posts[t.tweetId] = { tweetId: t.tweetId, firstSeenAt: at, handle: '', text: '', timeISO: '', seenAt: 0, n: 0 });
      rec.seenAt = now; rec.n++;
      const ath = String(t.author || '').replace(/^\/?@?/, '');
      if (ath && ath !== '-') rec.handle = ath;
      // v0.7.0：时间线上的关注徽标也是「我和他什么关系」的第三条腿（另外两条是列表页与主页头部）。
      // 只认明确的两种；空字符串 = X 没给态，绝不能当 not_following（那会把一屏陌生人全排进「最该关注」）。
      // 页主自己的推文不看徽标：主页头部那颗按钮才是权威（真机 DOM 里本不该同时出现，出现了也别让它翻掉头部读数）
      if (ath && ath !== '-' && normHandle(ath) !== normHandle(idt.handle) &&
          (t.followState === 'following' || t.followState === 'not_following')) {
        const u = touchUser(ath, now);
        if (u && u.relation !== t.followState) { u.relation = t.followState; u.updatedAt = now; touched++; }
      }
      if (t.text) rec.text = clip(t.text, 140);
      if (t.timeDatetime) rec.timeISO = t.timeDatetime;
      ['reply', 'repost', 'quote', 'like', 'view', 'bookmark'].forEach((k) => { const v = mv(k); if (v != null) rec[k] = v; });
      // v0.8.2：为你推荐关联 —— 第一次在为你推荐里见到它的时刻与当时的曝光。只记首次：后见的数字会涨，
      // 但「X 什么时候把它推给我」只有第一次是真的；正确性靠库里 tweets 每次快照一行兜底
      if (snap.tlSrc === 'foryou' && rec.fyAt == null) { rec.fyAt = at; rec.fyView = mv('view'); }
      if (!p) newPosts++;
    });
    lastUpsert = { touched, newPosts, newOnes, skippedRows, foreignStats, at };
    scheduleStoreWrite();
    return lastUpsert;
  }

  // 表已经脏过一次（别人的粉丝数、推荐位行、带角标的名字），改完判据就得能拿留存快照重算一遍。
  // 只读 runs 里已有的快照，不重新访问任何页面 ⇒ 不对 X 产生任何新请求。
  function rebuildStores() {
    const runs = loadRuns();
    users = {}; posts = {};
    let badTime = 0, impRestored = 0, slim = 0;
    runs.forEach((s) => {
      if (!s || !s.stats) { badTime++; return; }
      if (s.slim) slim++;
      let t = Date.parse(s.at);
      if (!isFinite(t)) { t = Date.now(); badTime++; }
      try { upsertStores(s, t); } catch (e) { badTime++; }
      // 日线也能从留存的快照里重算：奖励页的快照带 rewards，按采集那天补一个点。
      // 同值不覆盖、同天已存在就跳过，所以「重算」不会把面板手工补录的数据冲掉
      try {
        const rw = s.rewards;
        if (rw && rw.hit) {
          if (s.identity && s.identity.selfHandleGuess) rememberOwn(s.identity.selfHandleGuess);
          const ownAt = ownHandle();
          if (ownAt && addImpPoint(ownAt, dayKey(t), rw.value, rw.exact, rw.token, t)) impRestored++;
        }
      } catch (e) { badTime++; }
    });
    writeStores();
    if (impRestored) writeSeries();
    return { runs: runs.length, slim: slim, users: Object.keys(users).length, posts: Object.keys(posts).length, skipped: lastUpsert ? lastUpsert.skippedRows : 0, bad: badTime, imp: impRestored };
  }
  function queryStores(q) {
    const s = String(q || '').trim().toLowerCase();
    const hitU = Object.keys(users).filter((k) => !s || k.toLowerCase().indexOf(s) >= 0 || String(users[k].name || '').toLowerCase().indexOf(s) >= 0)
      .slice(0, 8).map((k) => users[k]);
    const hitP = Object.keys(posts).filter((k) => {
      if (!s) return true;
      const p = posts[k];
      return k.indexOf(s) >= 0 || String(p.handle || '').toLowerCase().indexOf(s) >= 0 || String(p.text || '').toLowerCase().indexOf(s) >= 0;
    }).slice(0, 8).map((k) => posts[k]);
    return { users: hitU, posts: hitP, counts: { users: Object.keys(users).length, posts: Object.keys(posts).length } };
  }

  // ---------- 时间序列（v0.6.3）：曝光按天、关注/粉丝按分钟 ----------
  // 为什么不塞进 users 行里：日线一年 365 点、分钟线一天 1440 点，而落表是整表重写一遍，
  // 每分钟写一次 600 行的表不划算。单独一个共享键，合并规则交给 SW 串行做。
  // 采样只在页面开着时做（MV3 的后台 SW 碰不到 x.com 的 DOM）⇒ 关掉页面就是断线，这是选的形状不是缺陷。
  const SERIES_KEY = 'ysy.xprobe.series';
  const OWN_KEY = 'ysy.xprobe.own';
  // v0.6.12：own 从「只能靠 DOM 猜」升级成「设置里可以钉死」。分开两个键是故意的：
  // 手动那份是用户的话，自动那份是探针的猜测 —— 猜的永远不许覆盖说的。
  const OWN_SET_KEY = 'ysy.xprobe.ownSet';
  const MIN_MAX = 1440;             // 分钟线留 24 小时（1440 点 ≈ 100KB，图表早就看不动了）
  const IMP_MAX = 365;              // 自己的日线留一年
  const DAY_MAX = 120;              // 别人的号只自动落日点（打开主页才读得到），一人 120 天够排名用
  const SER_MAX = 40;               // 最多记 40 个 handle 的序列（原来 8 个：排名要看的人一多就把在榜的挤掉了）
  const MIN_VIEW = 400;             // 面板一次画这么多点（约 6.7 小时）
  const SAMPLE_EVERY = 55000;       // 两次采样至少隔这么久：一分钟一个点，又不至于同一分钟塞两个
  const ANALYTICS_EVERY = 2500;     // 分析页单独放倍：逐日数只在悬停 tooltip 里（轴上日期无数、数无日期），55 秒一格会漏掉大半根柱子
  const MINTAB = { profile: 1, following: 1, followers: 1, verified_followers: 1 };
  let series = {}, seriesErr = '', lastSampleAt = 0, lastRewardHash = '', lastAnalyticsHash = '', ownKnown = '', ownSet = '';

  function dayKey(t) {
    const d = new Date(t == null ? Date.now() : t);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  function loadSeries() {
    let s = null;
    try { s = GM_getValue(SERIES_KEY, null); } catch (e) { s = null; }
    series = s && typeof s === 'object' ? s : {};
    migrateSeries();
    try { ownKnown = String(GM_getValue(OWN_KEY, '') || '').toLowerCase(); } catch (e) { ownKnown = ''; }
    try { ownSet = normHandle(GM_getValue(OWN_SET_KEY, '')); } catch (e) { ownSet = ''; }
  }
  // v0.7.2 行形状 v2 的一次性迁移：value 改记账号分析页的实时曝光，奖励页那个数搬进 eff。
  // 旧行里 value 只可能来自奖励页（或照着奖励页手补的）⇒ 整体搬家，exact/token 描述的是那个数，
  // 跟着 eff 走。effAt 缺省拿行上的 at（采集时刻 ≈ 落账时刻，量级对）。天不挪：
  // 0.7.2 之前落账记的是「打开页面的那天」，按 T-1 口径其实差一天，历史行就让它带着这个偏差，
  // 静默改历史天 = 又一次「整行覆盖」式的自作主张；要挪去趋势页手删手补。
  function migrateSeries() {
    let moved = 0;
    Object.keys(series).forEach((k) => {
      const r = series[k];
      if (!r || !Array.isArray(r.imp)) return;
      r.imp.forEach((p) => {
        // token==='analytics' 是 0.7.2 才有的来源标记（老 token 只会是缩写串/'manual'）：
        // 实时曝光行天然「有 value 没 eff」，不豁免的话下一个标签页一启动就会把它误迁成 eff 行
        if (!p || p.token === 'analytics') return;
        if (p.eff == null && p.value != null) {
          p.eff = p.value; p.effExact = !!p.exact; p.effToken = p.token || '';
          p.value = null; p.exact = false; p.token = '';
          if (p.at) p.effAt = p.at;
          moved++;
        }
      });
    });
    if (moved) { try { GM_setValue(SERIES_KEY, series); } catch (e) { /* 写不进下次开页再迁 */ } }
    return moved;
  }
  function rememberOwn(h) {
    const k = String(h || '').toLowerCase();
    if (!k || k === ownKnown) return;
    ownKnown = k;
    try { GM_setValue(OWN_KEY, k); } catch (e) { /* 存不下就算了，下次从 DOM 再认一次 */ }
  }
  // handle 的唯一口径：剥 @、去空白、转小写；X 的用户名只允许 1~15 个 [A-Za-z0-9_]，
  // 对不上一律当空（把 "king of" / 一串中文原样存下来 = 库里多一个永远匹配不上的假人）
  function normHandle(h) {
    const k = String(h == null ? '' : h).replace(/^@+/, '').trim().toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(k) ? k : '';
  }
  function isOwn(h) {
    const o = ownHandle();
    return !!o && normHandle(h) === o;
  }
  // 自己的 handle：优先设置里钉死的那份；没钉才回落到「侧栏个人资料那颗导航指向的人」这个自动猜测。
  // 奖励页的 URL 里没有 handle，曝光数记在谁名下就靠它 ⇒ 猜错一次，历史就整段挂在陌生人身上。
  function ownHandle() {
    if (ownSet) return ownSet;
    try {
      const nav = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const m = nav && String(nav.getAttribute('href') || '').match(/^\/@?([A-Za-z0-9_]+)$/);
      if (m) { rememberOwn(m[1]); return ownKnown; }
    } catch (e) { /* 沙箱/异常环境：吃存的那份 */ }
    return ownKnown;
  }
  // 设置里改「我的账号」：留空 = 撤掉手动值、回到自动识别。改完不回迁历史 ——
  // 旧数据留在它当初写入的那个 handle 名下（自动猜错就会留一个陌生人名下），要挪靠广场里手补，别静默改别人的账。
  function setOwnHandle(v) {
    const raw = String(v == null ? '' : (v && typeof v === 'object' ? (v.handle == null ? '' : v.handle) : v));
    const want = raw.trim() === '' ? '' : normHandle(raw);
    if (raw.trim() !== '' && !want) return { ok: false, err: 'handle 不合法：只能是 1~15 个字母/数字/下划线（可带 @ 前缀）' };
    ownSet = want;
    try { GM_setValue(OWN_SET_KEY, want); } catch (e) { /* 写不进就这次会话内生效，如实回值 */ }
    const own = ownHandle();
    logRec('stat', { reason: 'ownSet', own, manual: !!want, prev: ownKnown });
    return { ok: true, own, manual: !!want, auto: ownKnown };
  }
  function seriesRow(handle, make) {
    const k = String(handle || '').toLowerCase();
    if (!k) return null;
    let r = series[k];
    if (!r) { if (!make) return null; r = series[k] = { handle: k, min: [], imp: [], updatedAt: 0 }; }
    if (!r.min) r.min = [];
    if (!r.imp) r.imp = [];
    return r;
  }
  function writeSeries() {
    const ks = Object.keys(series);
    if (ks.length > SER_MAX) {
      ks.sort((a, b) => (series[b].updatedAt || 0) - (series[a].updatedAt || 0));
      for (let i = SER_MAX; i < ks.length; i++) delete series[ks[i]];
    }
    try { GM_setValue(SERIES_KEY, series); seriesErr = ''; }
    catch (e) { seriesErr = '序列写失败: ' + clip(e && e.message, 40); }
  }
  // 一分钟一个点：同一分钟里再采（守卫触发、面板手点）只覆盖当分钟那个，不铺两个点
  function addMinPoint(handle, following, followers, now) {
    const r = seriesRow(handle, true);
    if (!r) return 0;
    const ts = Math.floor(now / 60000) * 60000;
    const p = { ts, at: new Date(ts).toISOString(), following: following == null ? null : following, followers: followers == null ? null : followers };
    const lastP = r.min[r.min.length - 1];
    if (lastP && lastP.ts === ts) {
      if (lastP.following === p.following && lastP.followers === p.followers) return 0;
      r.min[r.min.length - 1] = p;
    } else r.min.push(p);
    if (r.min.length > MIN_MAX) r.min = r.min.slice(-MIN_MAX);
    r.updatedAt = now;
    return 1;
  }
  // 日点：同一天覆盖（X 每天更新一次，一天里多次读到取最后一次的读法）；
  // 面板的「补录」走的也是这里，所以老数据和自动采的在同一张表上，不做两套形状。
  // v0.6.9 收尾：日点行扩成四列 —— fow(关注)/fans(粉丝)/posts(帖子，tab.posts.number 已结案，DOM 没这个数只能手填)。
  // 合并口径：只盖「这一回真的给了数」的列 —— 自动采集那条路（extra 缺省）绝不碰手填列：
  // 奖励页读到曝光覆盖当日时，下午手补的粉丝/帖子格子还在，补录是往一行里填格子，不是整行换。
  // v0.7.2 曝光拆成两列：value = 账号分析页的实时曝光（当天当刻就在涨）；eff = 奖励页的有效曝光（T+1 才出）。
  // 两列各带各的出处：exact/token 跟 value，effExact/effToken/effAt 跟 eff（effAt = 落账时刻，T+1 语义就靠它对账）。
  function addImpPoint(handle, day, value, exact, token, now, extra) {
    const r = seriesRow(handle, true);
    if (!r) return 0;
    const x = extra || {};
    let i = -1;
    for (let k = 0; k < r.imp.length; k++) if (r.imp[k].day === day) { i = k; break; }
    const old = i >= 0 ? r.imp[i] : null;
    const valueGiven = value != null;
    const effGiven = x.eff != null;
    const at = new Date(now || Date.now()).toISOString();
    const touched = valueGiven || effGiven || x.fow != null || x.fans != null || x.posts != null;
    const keep = (cur, given, nv) => (given ? nv : (cur == null ? null : cur));
    const rec = {
      day,
      value: valueGiven ? value : (old ? (old.value == null ? null : old.value) : null),
      exact: valueGiven ? !!exact : !!(old && old.exact),
      token: valueGiven ? (token || '') : (old ? (old.token || '') : ''),
      eff: keep(old ? old.eff : null, effGiven, x.eff),
      effExact: effGiven ? !!x.effExact : !!(old && old.effExact),
      effToken: effGiven ? (x.effToken || '') : (old ? (old.effToken || '') : ''),
      fow: keep(old && old.fow, x.fow != null, x.fow),
      fans: keep(old && old.fans, x.fans != null, x.fans),
      posts: keep(old && old.posts, x.posts != null, x.posts),
      at: old && !touched ? old.at : at,
    };
    if (effGiven) rec.effAt = at;
    else if (old && old.effAt) rec.effAt = old.effAt;
    const same = old && old.value === rec.value && old.exact === rec.exact && old.token === rec.token &&
      (old.eff || null) === (rec.eff || null) && !!old.effExact === !!rec.effExact &&
      (old.effToken || '') === (rec.effToken || '') &&
      (old.fow || null) === (rec.fow || null) && (old.fans || null) === (rec.fans || null) &&
      (old.posts || null) === (rec.posts || null);
    if (same) return 0;
    if (i >= 0) r.imp[i] = rec; else r.imp.push(rec);
    r.imp.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    // 自己的号能留一年（面板会天天开），别人的只在自己主页被打开那天多一个点，一人封顶 120 天就够排名用；
    // 两个数分别封顶，别因为 SER_MAX 涨到 40 就把 chrome.storage 配额吃掉一整块
    const cap = isOwn(handle) ? IMP_MAX : DAY_MAX;
    if (r.imp.length > cap) r.imp = r.imp.slice(-cap);
    r.updatedAt = now || Date.now();
    return 1;
  }
  function delImpPoint(handle, day) {
    const r = seriesRow(handle, false);
    if (!r) return 0;
    const before = r.imp.length;
    r.imp = r.imp.filter((p) => p.day !== day);
    if (r.imp.length !== before) { r.updatedAt = Date.now(); writeSeries(); }
    return before - r.imp.length;
  }
  // v0.6.11：日点不再是「只挂登录者 own」的一张表 —— 打开谁的主页就在谁名下落当天那一行，
  // 这样「用户 + 日期 + 四列」才成立，排名才有人可排。曝光这一列别人读不到（只有自己的奖励页有），
  // 所以这条路的 value 恒为 null；posts 是主页头部自报的总数（v0.8.1 起 headerPosts 有就带上），
  // 只有自己主页被打开才有值 —— 别人的一万个帖子我们只抓得到头部那行字，这正好就是真总数。
  // 一天里反复打开只在数字变了才重写那一行并记一笔（addImpPoint 的同值返回 0 就是这道闸）
  function recordDayRow(handle, f, fo, source, hp) {
    const h = String(handle || '').toLowerCase();
    if (!h) return null;
    const fow = f && f.value != null ? f.value : null;
    const fans = fo && fo.value != null ? fo.value : null;
    const posts = hp && hp.value != null ? hp.value : null;
    if (fow == null && fans == null && posts == null) return null;
    const now = Date.now();
    const day = dayKey(now);
    const added = addImpPoint(h, day, null, true, '', now, { fow, fans, posts });
    if (added) {
      writeSeries();
      logRec('dayrow', { handle: h, own: h, day, value: null, exact: false, token: '',
                         fow, fans, posts, postsExact: posts != null && hp.exact ? 1 : 0,
                         manual: 0, source: source || (isOwn(h) ? 'own-profile' : 'profile'), added: 1 });
    }
    return { handle: h, day, added: !!added, fow, fans, posts };
  }
  function seriesStats() {
    const ks = Object.keys(series);
    let mn = 0, im = 0;
    ks.forEach((k) => { mn += (series[k].min || []).length; im += (series[k].imp || []).length; });
    return { handles: ks.length, min: mn, imp: im, err: seriesErr };
  }
  function seriesForPanel(want) {
    const own = ownHandle();
    const wk = normHandle(want);
    // 点名要谁就给谁，哪怕他一行都没有：旧写法在 series 里查不到就回落到 own/最新那个人 ⇒
    // 「我的」页在自己还没数据时会把陌生人的曲线画在下面，看着就是我的历史（v0.6.12 拆页后才暴露得这么直接）
    let key = wk || (own && series[own] ? own : '');
    const byAt = (a, b) => (series[b].updatedAt || 0) - (series[a].updatedAt || 0);
    if (!key) {
      const ks = Object.keys(series).sort(byAt);
      key = ks[0] || '';
    }
    const r = key ? series[key] : null;
    const hs = Object.keys(series).sort(byAt);
    if (own) { const i = hs.indexOf(own); if (i > 0) hs.splice(i, 1), hs.unshift(own); }
    return {
      own, key: key || '', err: seriesErr, ownSet, ownAuto: ownKnown, counts: seriesStats(),
      // 一次给 40 个（和 SER_MAX 同数）：「看谁」下拉只列 8 个的话，第 9 个人的日点就再也翻不出来
      handles: hs.slice(0, SER_MAX).map((k) => ({ h: k, min: (series[k].min || []).length, imp: (series[k].imp || []).length, own: k === own ? 1 : 0, at: series[k].updatedAt || 0 })),
      min: r ? r.min.slice(-MIN_VIEW) : [],
      imp: r ? r.imp.slice(-IMP_MAX) : [],
      // 排名用的料：每人最新一行 + 上一行（净增要两行才算得出）。每人只带两行，40 人也就 80 行，
      // 不把整份 series（含分钟线）搬进面板消息里
      rank: hs.slice(0, SER_MAX).map((k) => {
        const rows = (series[k].imp || []);
        return { h: k, own: k === own ? 1 : 0, at: series[k].updatedAt || 0,
                 last: rows.length ? rows[rows.length - 1] : null,
                 prev: rows.length > 1 ? rows[rows.length - 2] : null };
      }),
      lastRewards: last && last.rewards ? { hit: !!last.rewards.hit, value: last.rewards.value, text: last.rewards.text, key: last.rewards.key, cands: (last.rewards.cands || []).slice(0, 3) } : null,
    };
  }
  function captureRewards(own, now, force) {
    const r = collectRewards();
    // v0.7.2 按 T-1 落账：奖励页给的是「前一天」的数（今天的数据明天 10 点后才出），今天打开记的是昨天的账。
    // 落账时刻记在 effAt（addImpPoint 里）与这条 reward 记录的 at 上，「更新到数据库、记录下时间」就是这两处。
    const day = dayKey((now || Date.now()) - 86400000);
    let added = 0;
    if (r.hit && own) added = addImpPoint(own, day, null, false, '', now,
      { eff: r.value, effExact: !!r.exact, effToken: r.token || '' });
    if (added) { writeSeries(); sendStoreRec(false); }
    const hash = JSON.stringify([r.hit, r.value, r.key, r.cands.length, own]);
    if (force || hash !== lastRewardHash) {
      lastRewardHash = hash;
      logRec('reward', {
        own: own || '(unknown)', day, hit: !!r.hit, value: r.value, exact: !!r.exact, token: r.token,
        text: r.text, why: r.why, key: clip(r.key, 90), others: r.others, keyNodes: r.keyNodes,
        added: !!added, forced: force ? 1 : 0, cands: r.cands.slice(0, 3),
      });
    }
    return { own: own || '', day, hit: !!r.hit, value: r.value, exact: !!r.exact, added: !!added, keyNodes: r.keyNodes, cands: r.cands.length };
  }

  // ---------- 账号分析页 /i/account_analytics：每天一格的实时曝光（当天当刻就在涨） ----------
  // 与奖励页是两个数：这里读到的当天也有值（增量口径——同值跳过、变了才写），奖励页的 T+1 另走 eff 列。
  // 这页的图是 JS 画的，结构没有奖励页那么有把握 ⇒ 跟 collectRewards 同一方法论：多路候选，
  // 没吃准的原文进 cands/headings，真机靠日志对表再收紧，不在沙箱里假装已经结案。
  const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  // 「2026-10-24 / 10月24日 / Oct 24 / 24 Oct」四种写法；年取当年（图表跨度不满一年，跨年那几天允许差一年）。
  // 日尾的边界用 (?!\d) 不用 \b：tooltip 是「Oct 20Impressions 19,771」这种日期半句与文字直接粘连的
  // （SVG 里 <text> 兄弟节点之间没有空白），\b 在「数字后跟字母」处永不成立，整句就废了
  function dayFromLabel(s) {
    const t = String(s || '');
    const y = new Date().getFullYear();
    const p2 = (n) => String(Number(n)).padStart(2, '0');
    let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + p2(m[2]) + '-' + p2(m[3]);
    m = t.match(/(\d{1,2})月(\d{1,2})日/);
    if (m) return y + '-' + p2(m[1]) + '-' + p2(m[2]);
    m = t.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?!\d)/) || t.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*/);
    if (m) {
      const mo = MON3[m[1].toLowerCase()] || MON3[m[2].toLowerCase()];
      const dd = /^\d+$/.test(m[1]) ? m[1] : m[2];
      if (mo && dd) return y + '-' + p2(mo) + '-' + p2(dd);
    }
    return '';
  }
  function collectAnalytics() {
    const days = {}, cands = [], axis = [], numOnly = [];
    const seen = {}, found = {};   // found: day -> 候选；同天多节点取文本最短的（见下）
    // 路 A：文本/aria 里「日期 + 数字」同句的节点（bar 的 tooltip、表行、卡片的标签都可能长这样）。
    // text 一并扫：真机 2026-10-25（英文 UI）整张图是 SVG 画的，日期刻度与悬停数值都长在 <text> 里
    const all = document.querySelectorAll('[aria-label],span,div,td,th,p,text');
    for (let i = 0; i < all.length && Object.keys(days).length < 40; i++) {
      const n = all[i];
      let t = '';
      try { t = (n.getAttribute && n.getAttribute('aria-label')) || txt(n); } catch (e) { continue; }
      if (!t || t.length > 120 || seen[t]) continue;
      seen[t] = 1;
      const day = dayFromLabel(t);
      if (!day) {
        // 纯数字短句：万一是「数值叶」与「日期叶」分家（无中间含两者的小节点），这里能看见它们的原文
        if (numOnly.length < 8 && t.length < 16 && /\d/.test(t) && /[A-Za-z%.,]/.test(t)) numOnly.push(clip(t, 15));
        continue;
      }
      // 日期串自己就是一串数字（「2026-10-22 4,320 次…」）⇒ 不剥掉的话 firstNumber 会把 2026 当曝光数
      const numT = t.replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, ' ')
        .replace(/(\d{1,2})月(\d{1,2})日/g, ' ')
        .replace(/\b(20\d{2})\b/g, ' ')   // tooltip 可能带年（「Oct 20, 2026 …」）：不剥，年就成第一个数
        .replace(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?!\d)(?!,\d)/gi, ' ')   // (?!,\d)：别把「19,771」的 19 当日期尾剥掉
        .replace(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*/gi, ' ');
      const num = firstNumber(numT);
      if (!num || num.value == null) {
        // 纯日期（x 轴刻度 / tooltip 的日期半句）：没有数，不算候选，但留作「图在、日期可读」的证据——
        // 数值那一半只在悬停 tooltip 里，animp 里 axis 有货而 days 空 = 判据没病，是没悬停
        if (axis.length < 8) axis.push(clip(t, 40));
        continue;
      }
      // 这页堆着多张图（Posts / Replies / Impressions…），每张的 tooltip 都是「日期+数」同句。
      // 不认关键词就全收：Posts 30 会被当成曝光落库（真机 2026-10-25 三条错行都是这么来的）
      if (!/impress|曝光/i.test(t)) {
        if (cands.length < 8) cands.push({ how: 'kwFilter', day, value: num.value, text: clip(t, 90) });
        continue;
      }
      // 容器 textContent 把 tooltip 与轴刻度无空格粘连（「…19,771030K60K90K120K…」），
      // firstNumber 会把 19,771 + 030K 粘成天文数字；而父节点总在子节点先进列表，
      // 先到的容器若直接占位，正确的小节点就被 days[day] 挡掉 ⇒ 同天必须比短，让 tooltip 叶子赢
      const cand = { value: num.value, exact: !!num.exact, token: String(num.token || '').toLowerCase(), len: t.length };
      const cur = found[day];
      if (!cur || cand.len < cur.len) {
        found[day] = cand;
        if (cands.length < 8) cands.push({ how: cur ? 'label(shorter)' : 'label', day, value: cand.value, text: clip(t, 90) });
      }
    }
    Object.keys(found).sort().forEach((d) => {
      days[d] = { day: d, value: found[d].value, exact: found[d].exact, token: found[d].token };
    });
    // 路 B：一格都没抠到时留结构线索——「曝光/Impressions」标题在不在、图里有几根 bar，
    // 给下一轮迭代指路（真机结构对表就靠这一眼，别让日志里只有一句「没抓到」）
    const headings = [];
    if (!Object.keys(days).length) {
      const nodes = document.querySelectorAll('h1,h2,h3,span,div');
      for (let i = 0; i < nodes.length && headings.length < 6; i++) {
        const t = txt(nodes[i]);
        if (t && t.length < 60 && /曝光|Impression/i.test(t)) {
          headings.push({ tag: (nodes[i].tagName || '').toLowerCase(), testid: nodes[i].getAttribute ? nodes[i].getAttribute('data-testid') || '' : '', text: clip(t, 50) });
        }
      }
    }
    let bars = 0;
    try { bars = document.querySelectorAll('svg rect').length; } catch (e) { bars = -1; }   // 沙箱的选择器桩不吃复合选择器：如实记 -1，别让它炸掉整趟采集
    return { days: Object.keys(days).sort().map((d) => days[d]), headings, cands, bars, axis, numOnly };
  }
  let lastAnalyticsLog = '';
  function captureAnalytics(own, now, force) {
    const a = collectAnalytics();
    let wrote = 0, same = 0;
    const written = [];
    // 增量口径（之前的数据对就跳过，不对或空就增量）：addImpPoint 同值返回 0 = 跳过，
    // 变了/空了才写行。当天当刻就在涨 ⇒ 同一天一天里会被覆盖多次，行上的 at 跟着走。
    (a.days || []).forEach((d) => {
      if (!own || !d.day || d.value == null) return;
      if (addImpPoint(own, d.day, d.value, !!d.exact, 'analytics', now)) { wrote++; written.push(d); }
      else same++;
    });
    if (wrote) { writeSeries(); sendStoreRec(false); }
    // 只有真写了的日子才发 dayrow：跳过的再发一遍 = 库里同天同值多一行，对账徒增噪音
    written.forEach((d) => {
      logRec('dayrow', { handle: own, own, day: d.day, value: d.value, exact: !!d.exact, token: 'analytics',
                         fow: null, fans: null, posts: null, manual: 0, source: 'analytics', added: 1 });
    });
    const hash = JSON.stringify([a.days, a.headings, own]);
    if (force || hash !== lastAnalyticsHash) {
      lastAnalyticsHash = hash;
      lastAnalyticsLog = new Date(now || Date.now()).toISOString();
      logRec('animp', { own: own || '(unknown)', n: (a.days || []).length, wrote, same, at: lastAnalyticsLog,
                        days: (a.days || []).slice(0, 40), headings: a.headings, cands: a.cands, bars: a.bars, axis: a.axis, numOnly: a.numOnly });
    }
    return { own: own || '', n: (a.days || []).length, wrote, same, headings: a.headings.length };
  }
  // v0.8.1 tooltip 补采：逐日数值**只**在悬停 tooltip 里（轴上日期无数、数无日期，真机 2026-10-25 已证），
  // 2.5 秒一格的采样只能撞上恰好悬停的那几根。观察者是只读的——tooltip 节点是用户自己悬停时
  // 页面弹出来的，我们只看它、不碰鼠标，和守卫/时间线补采同一个纪律。
  const AN_DEBOUNCE = 300;   // 悬停一串节点连着来，拖 300ms 合成一次读
  const AN_GAP = 500;        // 两次采集至少隔 0.5s：鼠标扫过整条轴也只是一连串读 DOM（1s 会漏掉扫过去的一半格子）
  let anTimer = 0, anLastAt = 0;
  function onAnalyticsMutation() {
    if (anTimer) return;
    if (tabName() !== 'analytics' || !ownHandle()) return;
    anTimer = setTimeout(() => {
      anTimer = 0;
      const now = Date.now();
      if (now - anLastAt < AN_GAP) return;
      anLastAt = now;
      try { captureAnalytics(ownHandle(), now, false); } catch (e) { /* 交给 animp/stat 通道 */ }
    }, AN_DEBOUNCE);
  }
  // v0.8.1-n 悬停名片补采：主页头部根本不下「N 帖子」这一行（10-25 真机已证：miss 清单全页只剩
  // 「查看新帖子」），用户看到的那行数字是悬停名片（HoverCard）——只有鼠标悬停时才挂进 DOM。
  // 纪律同 analytics tooltip：观察者只读地接住用户自己悬停时出现的节点，不模拟悬停、不碰鼠标。
  const HC_MIN_MS = 800;    // 悬停扫过一排头像时别一帧一读
  let hcLastAt = 0;
  let hcSeen = {};          // handle|值|天 去重：同一张名片反复出进 DOM 不重写
  const HC_HREF_RE = /^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/;
  const HC_NOT_HANDLE = /^(i|home|explore|search|notifications|messages|settings|compose|intents|personalization|jobs)$/i;
  // v0.8.13：名片上还有两行数字是比例标签的唯一来源 —— 真机形状（dump/2026-10-26_201253-tweet-shmh695775
  // 里 HoverCard 那一块，page.html 逐字抄）：
  //   <a href="/shmh695775/following" dir="ltr"><span><span>2,857</span></span> <span><span>正在关注</span></span></a>
  //   <a href="/shmh695775/verified_followers" ...><span><span>3,280</span></span> <span><span>关注者</span></span></a>
  // 认 href 而不是只认字面：中文「关注者」与英文 "Followers"、以及 verified_followers 这个别名，href 一条就盖完。
  const HC_STAT_HREF_RE = /^\/@?([A-Za-z0-9_]{1,15})\/(following|verified_followers|followers)(?:[?#]|$)/;
  const HC_STAT_TEXT_RE = /^([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:个)?\s*(?:正在关注|关注者|关注中|Following|Followers)$/i;
  function hoverCardScan() {
    const out = [];
    let cards = [];
    try { cards = document.querySelectorAll('[data-testid="HoverCard"]'); } catch (e) { return out; }
    for (let i = 0; i < cards.length; i++) {
      let hnd = '';
      let hp = null, hf = null, ho = null;
      try {
        const links = cards[i].querySelectorAll('a[href]');
        for (let j = 0; j < links.length; j++) {
          const m = HC_HREF_RE.exec(links[j].getAttribute('href') || '');
          if (m && !HC_NOT_HANDLE.test(m[1])) { hnd = m[1].toLowerCase(); break; }
        }
        // 那两行数字挂在谁的头上：href 里的 handle 必须与名片主人同一个，否则就是「你认识的关注者」那种别人
        for (let j = 0; j < links.length && hnd; j++) {
          const href = links[j].getAttribute('href') || '';
          const sm = HC_STAT_HREF_RE.exec(href);
          if (!sm || sm[1].toLowerCase() !== hnd) continue;
          const t = clip(txt(links[j]), 40);
          const tm = t.match(HC_STAT_TEXT_RE);
          if (!tm) continue;
          const num = firstNumber(tm[1]);
          if (!num || num.value == null) continue;
          const chip = { value: num.value, exact: !!num.exact, token: String(num.token || ''), text: t };
          if (sm[2] === 'following') { if (!hf || t.length < hf.text.length) hf = chip; }
          else if (!ho || t.length < ho.text.length) ho = chip;
        }
        const spans = cards[i].querySelectorAll('span,div');
        for (let j = 0; j < spans.length; j++) {
          const t = clip(txt(spans[j]), 40);
          if (!t || t.length > 30) continue;
          const m = t.match(/^([\d][\d,.]*\s*(?:K|M|B|万|亿)?)\s*(?:条)?\s*(?:帖子|posts)$/i);
          if (!m) continue;
          const num = firstNumber(m[1]);
          if (num && num.value != null && (!hp || t.length < hp.text.length)) {
            hp = { value: num.value, exact: !!num.exact, token: String(num.token || ''), text: t };
          }
        }
      } catch (e) {}
      // 光有帖子数、或光有那两个数，都算「这张名片读到了东西」：比例标签不需要帖子数，落日点不需要那两个数
      if (hnd && (hp || hf || ho)) out.push({ handle: hnd, hp, hf, ho });
    }
    return out;
  }
  // 名片上的两个数写进本机 users 台账（比例标签读的就是这里）。只走 touchUser/setStat 那一套现成判据，
  // 不发请求、不动页面、不进日点序列（日点等真正读到那一屏时再落，别拿半套数占格子）。
  function applyHoverStats(handle, f, fo, now) {
    if (!handle || (!f && !fo)) return 0;
    const u = touchUser(handle, now);
    if (!u) return 0;
    const ch = (setStat(u, 'following', f, now) ? 1 : 0) + (setStat(u, 'followers', fo, now) ? 1 : 0);
    // v0.8.14：悬停这一路也要留时间线。以前只有「进过 TA 的主页」才往 u.hist 里记采样点，
    // 于是名单里「按时间看数值变化」对绝大多数人永远是空的 —— 名片这条路读到的同样是数。
    if (ch || !u.hist.length) {
      if (!u.hist.length || ch) u.hist.push({ at: new Date(now || Date.now()).toISOString(),
        followers: u.followers, following: u.following });
      if (u.hist.length > HIST_MAX) u.hist = u.hist.slice(-HIST_MAX);
    }
    const seen = noteStatsSeen(u, now);
    if (ch || seen) {
      u.updatedAt = now || Date.now();
      if (ch) perf.hcStat++;
      scheduleStoreWrite();
    }
    return ch;
  }
  function captureHoverCards(now) {
    const found = hoverCardScan();
    let added = 0, statd = 0;
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      statd += applyHoverStats(f.handle, f.hf, f.ho, now);
      if (!f.hp) continue;
      // 去重键带上那两个数：名片反复出进 DOM 不重写，但「数变了」得重写（否则一天里第二次悬停读到新粉丝数会被旧键吞掉）
      const k = f.handle + '|' + f.hp.value + '|' + (f.hf ? f.hf.value : '') + '|' + (f.ho ? f.ho.value : '') + '|' + dayKey(now || Date.now());
      if (hcSeen[k]) continue;
      hcSeen[k] = 1;
      const r = recordDayRow(f.handle, null, null, 'hovercard', f.hp);
      if (r && r.added) added++;
    }
    const nk = Object.keys(hcSeen).length;
    if (nk > 400) hcSeen = {};   // 台账只做去重，不囤历史：堆大了清掉重记，顶多同一天多写一次（addImpPoint 同值本来就跳过）
    return { n: found.length, added, statd };
  }
  function scanHoverCards() {
    // 节流看的是「上一次真扫」的时刻：旧写法把 hcLastAt 记在「扫到名片」之后，页面没有名片时
    // 每一批都重跑整趟 querySelector（滚动时最贵的一笔冤枉钱就在这里）。现在信号由合并 DFS 顺手给出，
    // 一趟只多读一个属性；这条函数只在真有名片时按 HC_MIN_MS 的频次去读内容。
    const now = Date.now();
    if (now - hcLastAt < HC_MIN_MS) { perf.hcThrottleHits++; return null; }
    hcLastAt = now;
    perf.hcScans++;
    try { return captureHoverCards(now); } catch (e) { return null; }   // 交给 dayrow/stat 通道
  }
  function onHoverCardMutation(recs) {
    // 旧公开名保留（控制台与自检）：先便宜地问一句「这批里有没有名片」，有才去读内容
    const list = recs || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || r.type !== 'childList') continue;
      const added = r.addedNodes || [];
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (!n || n.nodeType !== 1) continue;
        if (n.getAttribute && n.getAttribute('data-testid') === 'HoverCard') { scanHoverCards(); return; }
        try { if (n.querySelector && n.querySelector('[data-testid="HoverCard"]')) { scanHoverCards(); return; } } catch (e) {}
      }
    }
  }
  // 一分钟一个点的采样：只在开着的那页读 DOM，不发任何请求；到点就读，没到点立刻返回
  function sampleTick(force) {
    const tab = tabName();
    if (tab !== 'rewards' && tab !== 'analytics' && !MINTAB[tab]) return null;
    const now = Date.now();
    if (!force && now - lastSampleAt < (tab === 'analytics' ? ANALYTICS_EVERY : SAMPLE_EVERY)) return null;
    const own = ownHandle();
    if (tab === 'rewards') { lastSampleAt = now; return captureRewards(own, now, !!force); }
    if (tab === 'analytics') { lastSampleAt = now; return captureAnalytics(own, now, !!force); }
    // v0.6.11：这一屏的两个数属于谁 —— 别人主页的页主，其余页型按登录者算。
    // 分钟线仍然只挂自己（把陌生人的数写进 own 的分钟序列 = 上一轮那条「整行覆盖抹掉一列」的同族脏数据），
    // 日点挂在这一屏的主人名下，这样打开谁的主页就在谁名下多一行，排名才有人可排。
    const idt = tab === 'profile' ? String(handleFromPath(location.pathname) || '').toLowerCase() : '';
    const who = idt && idt !== own ? idt : own;
    if (!who) return null;
    let s = null;
    try { s = collectStats(who); } catch (e) { return null; }
    const f = pickNum(s.following), fo = pickNum(s.followers) || pickNum(s.verified_followers);
    const hp = s.__headerPosts || null;
    if (!f && !fo && !(hp && hp.value != null)) return null;
    lastSampleAt = now;
    let added = 0;
    if (who === own) {
      added = addMinPoint(own, f ? f.value : null, fo ? fo.value : null, now);
      if (added) writeSeries();
    }
    const dr = recordDayRow(who, f, fo, '', hp);
    return { own, who, day: dr ? dr.day : '', dayAdded: !!(dr && dr.added),
             following: f ? f.value : null, followers: fo ? fo.value : null,
             posts: hp ? hp.value : null, added: !!added };
  }
  function addImpFromPanel(v) {
    const o = v || {};
    const day = String(o.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, err: '日期要 YYYY-MM-DD（拿到的是「' + day + '」）' };
    // v0.6.9 收尾：四列都能补（装插件之前的日子曝光/关注/粉丝/帖子一样没有 —— 就靠这口补）。
    // 空列=不填；一列都不给数才拒。归一化（去逗号/空白）之外缩写串也收（13.2K / 10.1k / 1.3万 / 2.7w / 1.2m
    // → 换算成整数落库，但 exact=false：行上带 ~，跟采集器读到缩写是一个口径，不冒充精确值）；
    // 纯数字串才当精确值。历史表格里的「10.1k」就是这么填进来的。
    const num = (x, label) => {
      const s = x == null ? '' : String(x).replace(/[,\s]/g, '');
      if (s === '') return { v: null };
      const ab = /^(\d+(?:\.\d+)?)(k|万|w|m)$/i.exec(s);
      if (ab) {
        const mul = { k: 1e3, 万: 1e4, w: 1e4, m: 1e6 }[ab[2].toLowerCase()];
        const n = Number(ab[1]) * mul;
        if (!isFinite(n) || n < 0 || n > 1e12) return { err: label + '不是个数：' + clip(String(x), 20) };
        return { v: Math.round(n), abbr: true };
      }
      const n = Number(s);
      if (!isFinite(n) || n < 0 || n > 1e12) return { err: label + '不是个数：' + clip(String(x), 20) };
      return { v: Math.round(n) };
    };
    const c0 = num(o.eff, '有效曝光'), c1 = num(o.value, '曝光'), c2 = num(o.fow, '关注'), c3 = num(o.fans, '粉丝'), c4 = num(o.posts, '帖子');
    const bad = [c0, c1, c2, c3, c4].filter((c) => c.err);
    if (bad.length) return { ok: false, err: bad[0].err };
    if (c0.v == null && c1.v == null && c2.v == null && c3.v == null && c4.v == null) return { ok: false, err: '五列里至少填一列（有效曝光/曝光/关注/粉丝/帖子）' };
    const own = ownHandle();
    // v0.6.11：补录不再写死自己 —— 面板趋势页选中谁就补谁（handle 缺省才回到 own）。
    // 两列曝光里，有效曝光只有自己的奖励页读得到，但手填想给谁的行填都能填（别人的号没读过 = 留空，不代表它真的是 0）
    const h = normHandle(o.handle);
    const who = h || own;
    if (!who) return { ok: false, err: '还不知道自己的 handle（在设置里「我的账号」填一次，或先进一次自己的主页）' };
    const exactVal = c1.v == null ? true : !c1.abbr;
    const changed = addImpPoint(who, day, c1.v, exactVal, c1.v == null ? '' : 'manual', Date.now(),
      { eff: c0.v, effExact: c0.v == null ? false : !c0.abbr, effToken: c0.v == null ? '' : 'manual',
        fow: c2.v, fans: c3.v, posts: c4.v });
    writeSeries();
    if (who === own) {
      logRec('reward', { own, day, manual: 1, hit: c0.v != null, value: c0.v, exact: c0.v == null ? true : !c0.abbr,
                         value2: c1.v, fow: c2.v, fans: c3.v, posts: c4.v, added: !!changed });
    } else {
      logRec('dayrow', { handle: who, own, day, value: c1.v, exact: exactVal, token: c1.v == null ? '' : 'manual',
                         eff: c0.v, fow: c2.v, fans: c3.v, posts: c4.v, manual: 1, source: 'panel', added: !!changed });
    }
    sendStoreRec(false);
    return { ok: true, own: who, handle: who, day, eff: c0.v, value: c1.v, fow: c2.v, fans: c3.v, posts: c4.v,
             changed: !!changed, imp: ((series[who] || {}).imp || []).length };
  }

  // 面板「从本机库回填」：把 xprobe.db 里每人每天的日点灌回 chrome.storage 的 series。
  // 为什么非有这步不可：面板读的是浏览器存储、从不读 xprobe.db ⇒ backfill_days.py 直接写进库的那四天，
  // 趋势页上是一个都看不见的（「明明写库了却还空着」就是这么来的）。
  // 合并仍走 addImpPoint ⇒ 同日按列合，库里没有的列不会把面板上已有的数抹掉。
  // 这里**不发** dayrow/reward 记录：那些行本来就是从库里的记录长出来的，再发一次等于让 sink 把同一天的账写两遍。
  function mergeDayRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let wrote = 0, same = 0, bad = 0;
    const hs = {};
    list.forEach((r) => {
      if (!r || !r.handle || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.day || ''))) { bad++; return; }
      hs[String(r.handle).toLowerCase()] = 1;
      const at = Date.parse(String(r.at || '')) || Date.now();
      const exp = r.exposure == null ? null : Number(r.exposure);
      const eff = r.effective == null ? null : Number(r.effective);
      if (addImpPoint(r.handle, String(r.day), isFinite(exp) ? exp : null, !!r.exact, String(r.token || ''), at,
                      { eff: isFinite(eff) ? eff : null,
                        fow: r.following == null ? null : Number(r.following),
                        fans: r.followers == null ? null : Number(r.followers),
                        posts: r.posts == null ? null : Number(r.posts) })) wrote++;
      else same++;
    });
    if (wrote) writeSeries();
    return { rows: list.length, wrote, same, bad, handles: Object.keys(hs).length };
  }
  function restoreDaysFromDb(v) {
    const lim = Math.max(1, Math.min(500, Number((v || {}).limit) || 500));
    return new Promise((resolve) => {
      httpRequest('GET', SINK + '/db?q=day_rows&limit=' + lim, null, (err, status, text) => {
        if (err) { resolve({ ok: false, err: '读不到本机库（sink 没在跑？双击 start-sink.bat，/ping 要回 sink-13）：' + clip(err.message || String(err), 50) }); return; }
        let j = null;
        try { j = JSON.parse(text); } catch (e) { resolve({ ok: false, err: '库回来的不是 JSON（HTTP ' + status + '）：' + clip(text, 50) }); return; }
        if (!j || j.ok !== true) { resolve({ ok: false, err: '库说：' + clip((j && j.err) || ('HTTP ' + status), 70) }); return; }
        const r = mergeDayRows(j.rows);
        r.ok = true; r.err = ''; r.limit = lim;
        resolve(r);
      });
    });
  }

  // 关注动作后只重读那两个数字，不做整页快照（便宜，而且这才是「实时更新」要的粒度）
  let statTimer = 0, lastStatVals = '';
  function refreshStats(reason) {
    let s;
    try { s = collectStats(); } catch (e) { guardErr = 'stats 重读失败: ' + clip(e && e.message, 40); return null; }
    const f = pickNum(s.following), fo = pickNum(s.followers) || pickNum(s.verified_followers);
    const vals = (f ? f.value : '-') + '/' + (fo ? fo.value : '-');
    const idt = handleFromPath(location.pathname);
    // 两个数都没读到 ⇒ 既不给表建空键（真机 demo_a / demo_b 这种 name='' rel='' pts=0 就是这么来的），
    // 也不发 stat 记录（'{"following":null,"followers":null,"vals":"-/-"}' 对我没有任何信息量）
    if (idt && (f || fo)) {
      const u = touchUser(idt);
      if (u) { const ch = setStat(u, 'following', f) | setStat(u, 'followers', fo); if (ch) { u.updatedAt = Date.now(); scheduleStoreWrite(); } }
    }
    // v0.6.11：同一次读顺手落「这个 handle 今天那一行」。只在 profile 页型做 ——
    // /handle/status/123 那种页面第一段也是 handle，但页上没有那两个数，读到的是指别处（会把别人的数记到发帖人名下）
    let dayRow = null;
    if (idt && tabName() === 'profile') dayRow = recordDayRow(idt, f, fo, '', s.__headerPosts);
    if (last && last.stats) last.stats.following = s.following, last.stats.followers = s.followers, last.stats.verified_followers = s.verified_followers;
    const changed = lastStatVals !== '' && vals !== lastStatVals;
    lastStatVals = vals;
    if (changed && (f || fo)) logRec('stat', { reason: reason || 'manual', following: f ? f.value : null, followers: fo ? fo.value : null, exact: !!(f && f.exact && fo && fo.exact), handle: idt, vals });
    render();
    return { vals, changed, day: dayRow ? dayRow.day : '', dayAdded: !!(dayRow && dayRow.added) };
  }

  // ---------- 深挖：把「这页到底有哪些 data-testid / role / 带数字的 aria-label」原样上报 ----------
  function chainOf(node, up) {
    const out = [];
    let n = node;
    for (let i = 0; i < (up || 6) && n; i++) {
      out.push({
        tag: (n.tagName || '').toLowerCase(),
        testid: n.getAttribute ? n.getAttribute('data-testid') || '' : '',
        role: n.getAttribute ? n.getAttribute('role') || '' : '',
        cls: clip(n.getAttribute ? n.getAttribute('class') || '' : '', 70),
        kids: n.children ? n.children.length : (n.kids ? n.kids.length : 0),
      });
      n = n.parentElement;
    }
    return out;
  }

  function deepProbe(limitArticles) {
    const testids = {}, roles = {};
    document.querySelectorAll('[data-testid]').forEach((n) => {
      const t = n.getAttribute('data-testid') || '(空)';
      testids[t] = (testids[t] || 0) + 1;
    });
    document.querySelectorAll('[role]').forEach((n) => {
      const r = n.getAttribute('role') || '(空)';
      roles[r] = (roles[r] || 0) + 1;
    });

    // 只留有互动/统计词的，否则「关注 @Eric2928123」这类 handle 数字会把样本淹没（真机 116 条里大半是这种）
    const KEEP_ARIA = /回复|转帖|转推|引用|喜欢|观看|查看|关注|Repl|Repost|Retweet|Quot|Like|View|Follower|Following/i;
    const ariaNumbers = [];
    document.querySelectorAll('[aria-label]').forEach((n) => {
      const a = n.getAttribute('aria-label') || '';
      if (!/\d/.test(a) || !KEEP_ARIA.test(a)) return;
      ariaNumbers.push({
        tag: (n.tagName || '').toLowerCase(),
        testid: n.getAttribute('data-testid') || '',
        role: n.getAttribute('role') || '',
        aria: clip(a, 100),
        num: firstNumber(a),
        parsed: parseSummaryAria(a),
        visible: clip(txt(n), 40),
        chain: chainOf(n, 3),
      });
    });

    // 关注关系按钮单独列：它们的 aria 常常没数字（「关注 @someone」），走不到上面 ariaNumbers 的筛选里
    const followButtons = [];
    document.querySelectorAll(FOLLOW_SEL).forEach((b) => {
      if (followButtons.length >= 12) return;
      const tid = b.getAttribute('data-testid') || '';
      followButtons.push({
        testid: clip(tid, 44),
        state: /-unfollow$/.test(tid) ? 'following' : 'not_following',
        aria: clip(b.getAttribute('aria-label') || '', 60),
        visible: clip(txt(b), 24),
        chain: chainOf(b, 3),
      });
    });

    // 第三方脚本注入的节点（真机这页有 xro-badge--mutual 之类），先量出来，免得我把它的 DOM 当成 X 的
    // v0.6.1：计数按「命中的 token」报，不再报节点第一个 class——真机那份 foreignClasses 第一名是
    // css-g5y9jx（86 次），其实是「注入 class 和 X 的 Emotion class 挂在同一个节点上」，统计取了第一个 token 而已
    const foreign = {};
    document.querySelectorAll('[class]').forEach((n) => {
      const t = foreignTokenOf(n);
      if (!t) return;
      foreign[t] = (foreign[t] || 0) + 1;
    });

    // 三个我要据此定死选择器的现场：User-Name 挂在什么标签、聚合 aria 长什么样、header 条目文本
    const userNameTags = {};
    document.querySelectorAll('[data-testid="User-Name"]').forEach((n) => {
      const t = (n.tagName || '').toLowerCase();
      userNameTags[t] = (userNameTags[t] || 0) + 1;
    });
    const groupArias = [];
    document.querySelectorAll('[role="group"][aria-label]').forEach((g) => {
      const a = g.getAttribute('aria-label') || '';
      if (/\d/.test(a)) groupArias.push(clip(a, 120));
    });
    const headerItems = document.querySelector('[data-testid="UserProfileHeader_Items"]');

    const statsAnchors = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!/\/(followers|following|verified_followers)(\?|$)/.test(href)) return;
      if (statsAnchors.length >= 6) return;
      statsAnchors.push({
        href,
        aria: clip(a.getAttribute('aria-label') || '', 100),
        visible: clip(txt(a), 60),
        html: a.outerHTML.slice(0, 1000),
        chain: chainOf(a, 7),
        parentHtml: a.parentElement ? a.parentElement.outerHTML.slice(0, 1200) : '',
      });
    });

    const arts = Array.from(document.querySelectorAll('article')).slice(0, limitArticles || 3);
    const articleDumps = arts.map((art, i) => {
      const g = art.querySelector('[role="group"]');
      return {
        idx: i,
        testid: art.getAttribute('data-testid') || '',
        hasTweetTestid: !!art.querySelector('[data-testid="tweet"]') || !!art.closest('[data-testid="tweet"]'),
        groupHtml: g ? g.outerHTML.slice(0, 2500) : '',
        groupChildren: g ? Array.from(g.children).map((c) => ({
          tag: (c.tagName || '').toLowerCase(),
          testid: c.getAttribute('data-testid') || '',
          aria: clip(c.getAttribute('aria-label') || '', 80),
          text: clip(txt(c), 30),
        })) : [],
        html: art.outerHTML.slice(0, 3000),
      };
    });

    return {
      testids,
      roles,
      ariaNumberCount: ariaNumbers.length,
      ariaNumbers: ariaNumbers.slice(0, 60),
      userNameTags,
      groupArias: groupArias.slice(0, 12),
      followButtons,
      foreignBadges: Object.keys(foreign).reduce((a, k) => a + foreign[k], 0),
      foreignKinds: Object.keys(foreign).length,
      foreignClasses: foreign,
      headerItemsText: clip(txt(headerItems), 200),
      headerItemsHtml: headerItems ? headerItems.outerHTML.slice(0, 2500) : '',
      statsAnchors,
      articleCount: document.querySelectorAll('article').length,
      userCellCount: document.querySelectorAll('[data-testid="UserCell"]').length,
      // 侧栏推荐关注也是 UserCell：这两数不相等就说明取域必须按正文列来
      userCellInPrimary: primaryColumn() ? primaryColumn().querySelectorAll('[data-testid="UserCell"]').length : -1,
      primaryPresent: !!document.querySelector('[data-testid="primaryColumn"]'),
      userCellDumps: collectUsers().rows.slice(0, 2).map((r) => r.dump),
      tweetTestidCount: document.querySelectorAll('[data-testid="tweet"]').length,
      cellTestidCount: document.querySelectorAll('[data-testid="cellInnerDiv"]').length,
      articleDumps,
    };
  }

  const probedHandles = {};
  let probeBudget = 10;

  function probeAndReport() {
    let data;
    try { data = deepProbe(3); } catch (e) { data = { error: String((e && e.message) || e), stack: clip(e && e.stack, 500) }; }
    logRec('probe', data);
    return data;
  }

  let last = null;
  const seenRecently = {};
  function dedupeKey(s) {
    const first = (s.tweets || [])[0] || {};
    const firstUser = (s.users || [])[0] || {};
    return [s.tab, s.identity.handle || '-', (s.tweets || []).length, first.tweetId || '-', (s.users || []).length, firstUser.handle || '-'].join('|');
  }
  // 被动补采用另一把尺：同一屏、同几条帖，不代表数据没变（曝光和赞一直在涨）。
  // 签名里放的就是「库要存的那几个数」，没变才叫重复 ⇒ 变了就真的多一个点，增速才有东西可算。
  let lastSig = '';
  function metricSig(s) {
    return (s.tweets || []).map((t) => {
      const m = t.metrics || {};
      const v = (k) => (m[k] && m[k].num ? m[k].num.value : '');
      return [t.tweetId || '-', v('view'), v('like'), v('repost'), v('reply'), v('quote'), v('bookmark'), t.liked ? 1 : 0].join(':');
    }).join(';');
  }

  function doCollect(opts) {
    const o = opts === true ? { force: true } : (opts || {});
    last = snapshot();
    const key = dedupeKey(last);
    const now = Date.now();
    const sig = metricSig(last);
    const sigChanged = sig !== lastSig;
    lastSig = sig;
    // 被动那一枪的重复判据只看「数变没变」；手动/换页仍按老口径（45 秒内同一页只算一次）
    const dup = o.passive
      ? (!sigChanged || !last.hydrated || !REPORTABLE[last.tab])
      : ((!o.force && seenRecently[key] && now - seenRecently[key] < 45000) || (!o.force && !REPORTABLE[last.tab]));
    // 被动那一枪不写 seenRecently：它只占「数变没变」这一把尺，不能让随后一次换页采集被当成 45 秒内的重复
    if (!o.passive) seenRecently[key] = now;
    last.dup = !!dup;
    // 表与对账不受去重影响：重复页也可能数字变了，这两件事都只读、都不额外发请求
    perf.collects++;
    upsertStores(last);
    // 整文档对账（后缀属性选择器 = 全扫）：手动/换页/开机当场跑，被动那一枪 30 秒一次就够
    if (o.passive) reconcileRelGated('reconcile');
    else reconcileRel('reconcile');
    // 顺手打一个时间序列点（一分钟一个，同一分钟覆盖不铺两个）；采样挂了不影响记账
    try { sampleTick(!!o.force); } catch (e) { /* 交给 stat/err 通道 */ }
    // 真机有 6 次「empty(本页没采到任何行) [未水合]」：2.5s 那一枪打在水合完成之前。
    // 补一枪只读同一页（不滚动、不翻页、不点击），4s 后再采一次；只补一次，不会滚成循环
    if (!dup && !last.hydrated && !o.retry) {
      const hrefAtFail = location.href;
      setTimeout(() => { if (location.href === hrefAtFail) { try { doCollect({ retry: 1 }); } catch (e) { /* 交给 err 通道 */ } } }, 4000);
    }
    if (!dup) {
      // 被动补采不进 runs：那个环只有 60 格，每 5 秒一份会把「本页」与重建要的原文全挤掉。
      // 数据点本身不受影响 —— 库那边收的是 page 记录，被动补采照发（增速就是靠这些点算的）。
      if (!o.passive) {
        const runs = loadRuns();
        runs.push(last);
        saveRuns(runs);
      }
      logRec('page', last, {
        cov: last.cov, covUsers: last.covUsers, handle: last.identity.handle, tabType: last.tab,
        tlSrc: last.tlSrc || undefined,
        hydrated: last.hydrated, userRows: last.users.length, usersScope: last.usersScope,
        userCellInDoc: last.userCellInDoc, miss: missingFields(last), note: knownGaps(last),
        attempt: o.retry ? 2 : 1, peer: peerHost(), auto: o.passive ? String(o.passive) : undefined,
      });
      if (o.probe) probeAndReport();
      else if (!o.passive) autoProbe();
      // 整页原文转储开销大，只有手动/换页那两枪做；被动补采不做（否则调试一开就每 5 秒一份）
      if (dumpEnabled() && !o.passive) captureDump({ force: !!o.force });
    }
    render();
    return last;
  }

  // 漏抓清单：直接把「哪个字段在哪个页面是空的」报给我，省得我猜
  function missingFields(snap) {
    const miss = [];
    const isProfile = !!snap.identity.hasHeader;
    if (isProfile) {
      if (!snap.stats.following) miss.push('stats.following');
      if (!snap.stats.followers && !snap.stats.verified_followers) miss.push('stats.followers');
      const pt = (snap.stats.__tabs || []).find((t) => POSTS_RE.test(t.text + ' ' + t.ariaLabel));
      if (!pt) miss.push('tab.posts');
      else if (!pt.num.exact && pt.num.value != null) miss.push('tab.posts.abbrevOnly');
      // tab.posts.number 从漏抓清单里挪走（v0.6.0）：真机 54 次 miss 之后结案 ——
      // 主页 tab 与 /home tab 上都没有总数节点（__tabs 里 num/numInChild 全 null），X 的 DOM 里就是没有这个数
      if (!snap.stats.__headerPosts) miss.push('header.posts');   // v0.8.1：头部「N 帖子」那行，抓不到要点名
      ['followers', 'verified_followers', 'following'].forEach((k) => {
        const o = snap.stats[k];
        if (!o) return;
        if (!(o.visibleNum.exact === true) && !(o.ariaNum.exact === true)) miss.push('exact.' + k);
      });
      if (!snap.identity.joined) miss.push('identity.joined');
    }
    if (snap.tweets.length) {
      const ads = snap.tweets.filter((t) => t.adSuspect);
      const real = snap.tweets.filter((t) => !t.adSuspect);
      if (ads.length) miss.push('card.ad x' + ads.length + '(推广位,不计入字段命中率)');
      const n = real.length;
      if (n) {
        const cnt = (f) => { let c = 0; real.forEach((t) => { if (f(t)) c++; }); return c; };
        const noId = n - cnt((t) => t.tweetId);
        if (noId) miss.push('tweet.tweetId x' + noId);
        const noTime = n - cnt((t) => t.timeDatetime);
        if (noTime) miss.push('tweet.time x' + noTime);
        const noAuthor = n - cnt((t) => t.author);
        if (noAuthor) miss.push('tweet.author x' + noAuthor);
        // view 缺的时候顺手把「为什么没法再核一遍」补上：整页连一个聚合句都没有，数字全走按钮/独立 aria
        const noSum = !cnt((t) => !!t.summaryAria);
        ['reply', 'repost', 'like', 'view'].forEach((k) => {
          const no = n - cnt((t) => t.metrics[k] && t.metrics[k].num.value != null);
          if (no) miss.push('metric.' + k + ' x' + no + (k === 'view' && noSum ? '(聚合句也没有,全走按钮)' : ''));
        });
      }
    }
    const tab = snap.tab || tabName();
    if (tab === 'rewards') {
      const rw = snap.rewards || {};
      if (!rw.hit) miss.push('rewards.value x0(关键词节点 ' + (rw.keyNodes || 0) + ' 个里没抠到数,看 cands)');
      else if (rw.others) miss.push('rewards.nums x' + (rw.others + 1) + '(同区域多个数字,取了第一个,看 cands.nums)');
      return miss;
    }
    if (/(following|followers)/.test(tab)) {
      const n = snap.users.length;
      if (!n) miss.push('users.rows x0(列表没水合)');
      else {
        const noH = n - snap.users.filter((u) => u.handle).length;
        if (noH) miss.push('users.handle x' + noH);
        const noF = n - snap.users.filter((u) => u.followState).length;
        if (noF) miss.push('users.followState x' + noF);
        const noN = n - snap.users.filter((u) => u.name).length;
        if (noN === n) {
          // 名字全空时，光说「看 nameHow」不够：把主导那种形状点名出来，下一轮直接照着改
          const howCnt = {};
          snap.users.forEach((u) => { const k = u.nameHow || 'none'; howCnt[k] = (howCnt[k] || 0) + 1; });
          const dom = Object.keys(howCnt).sort((a, b) => howCnt[b] - howCnt[a])[0] || 'none';
          miss.push('users.name x0(全空,主导形状=' + dom + (dom === 'anchorText' ? ',那锚里只有头像:看 cands' : '') + ')');
        } else if (noN) miss.push('users.name x' + noN);
      }
    } else if (!snap.tweets.length && !isProfile) {
      miss.push('empty(本页没采到任何行)');
    }
    return miss;
  }

  // 已知缺口：不是「采集器没抠到」而是「X 的 DOM 里本来就没有」，以及「按 handle 收窄后排除了多少」
  // 单独一列，免得它们年复一年占着漏抓清单，把真的漏抓淹掉
  function knownGaps(snap) {
    const note = [];
    if (snap.identity.hasHeader) {
      const pt = (snap.stats.__tabs || []).find((t) => POSTS_RE.test(t.text + ' ' + t.ariaLabel));
      if (pt && pt.num.value == null) note.push('tab.posts.number(主页与/home两处复现:tab 上没有总数节点,X 不给;头部那行 v0.8.1 起另抓,见 header.posts)');
    }
    const fg = ((snap.stats || {}).__foreign || []).length;
    if (fg) note.push('stats.__foreign x' + fg + '(别的号的粉丝/关注锚点,已排除不落表)');
    const side = (snap.users || []).filter((r) => r.origin === 'side').length;
    if (side) note.push('users.side x' + side + '(推荐位行,不落表)');
    const fn = snap.foreignNodes || 0;
    if (fn) note.push('foreignNodes x' + fn + '(第三方注入文本,读名字时已剥掉)');
    const sa = snap.nameStripAll || 0;
    if (sa) note.push('nameStripAll x' + sa + '(整棵名字子树被判注入,已回退全文⇒判据可能误伤,看 foreignTokens)');
    // v0.6.2：真机见过 name='00后身记（一起发财版）互关' 而 nameForeign=0 ⇒「互关」不是从注入子树里来的，
    // 按 DOM 出处剥不到它；名字里真带「互关」的号也确实在（子想互关）。所以这一条只报不剥，攒够样本再裁定
    const tail = (snap.users || []).filter((r) => !r.nameForeign && /互关\s*$/.test(r.name || '')).length +
      ((!((snap.identity || {}).nameForeign)) && /互关\s*$/.test((snap.identity || {}).displayName || '') ? 1 : 0);
    if (tail) note.push('users.nameTail x' + tail + '(名字尾裸「互关」而出处不是注入子树,先观察不硬剥)');
    const noName = (snap.users || []).filter((r) => r.handle && !r.name).length;
    if (noName) note.push('users.noName x' + noName + '(行里有 handle 没名字,cands 已报候选出处)');
    // 名字是从「整行文本」取的，而整行被判成注入子树 ⇒ 交出来的名字本身可能就是注入文字
    const cs = (snap.users || []).filter((r) => r.cellStripAll).length;
    if (cs) note.push('users.cellStripAll x' + cs + '(名字取自整行文本而该行整棵被判注入⇒这个名字别信,看 foreignTokens)');
    // v0.6.9：真机 64 行转发数全空，而漏抓清单里一条没报 —— 因为 metric.quote 根本不在 missingFields 的四项里。
    // 不补进 miss（那样每页都红，等于噪声），改成在这里明说：中文页的转发只有「转发」按钮的 aria-label 里有数，
    // 而那一档 X 给的是「查看引用」而非条数 ⇒ 这是 DOM 结构性不给，不是本页没水合，别照 quote 排期修复。
    if ((snap.tweets || []).length) {
      const real = snap.tweets.filter((t) => !t.adSuspect);
      const has = (t) => !!(t.metrics && t.metrics.quote && t.metrics.quote.num && t.metrics.quote.num.value != null);
      const noQ = real.length - real.filter(has).length;
      if (noQ === real.length) note.push('metric.quote x' + noQ + '(全空:中文页不给转发明细条数,结构性盲区,不是本页没水合)');
      else if (noQ) note.push('metric.quote x' + noQ + '(部分行没转发明细,同上一条口径)');
      // v0.6.9：整页连一个聚合句都没有是新推文页的常态（数字全走按钮/独立 aria），旧写法把它塞进 miss
      // ⇒ 真机 2026-10-23 六条 page 的 miss 里只有它自己，真 miss（metric.view 等）反而被淹。挪进已知缺口。
      const noS = real.length - real.filter((t) => !!t.summaryAria).length;
      if (noS) note.push('metric.summaryAria x' + noS + '(整页没有聚合句:数字走按钮/独立aria,view也缺才在miss里点名)');
    }
    return note;
  }

  function autoProbe() {
    const key = (last.identity.handle || firstSeg(location.pathname) || '-') + '|' + tabName();
    if (probedHandles[key] || probeBudget <= 0 || !REPORTABLE[tabName()]) return;
    probedHandles[key] = 1;
    probeBudget--;
    // 延迟一点，等长列表水合完再抠
    setTimeout(() => { try { logRec('probe', deepProbe(3)); } catch (e) { logRec('err', { msg: 'deepProbe: ' + e.message, stack: clip(e.stack, 500) }); } }, 1500);
  }

  function installErrorHooks() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('error', (e) => {
      logRec('err', {
        msg: clip(String((e && e.message) || ''), 300),
        src: clip(String((e && e.filename) || ''), 120),
        line: e && e.lineno, col: e && e.colno,
        stack: clip(e && e.error && e.error.stack || '', 800),
      });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      logRec('err', { msg: 'unhandledrejection ' + clip(String((r && r.message) || r || ''), 300), stack: clip((r && r.stack) || '', 600) });
    });
  }

  // ---------- 页面里我只留一颗浮标：详面板搬到扩展自己的 Side Panel ----------
  // 为什么这么切：注入进 x.com DOM 的每个节点都是痕迹（油猴版有整块面板 + 恢复按钮两个节点，
  // 转储树还得特判把它们排除）。Side Panel 是扩展自己的页面，写多少行都不碰 x.com ⇒ 页面注入数=1。
  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (text != null) e.textContent = text;
    return e;
  }
  // ⚠ 这里不许带 position/right/bottom——三颗钮都住在排容器里，定位归 bar（v0.8.5 现场判例：
  // 第一版把单浮标时代的 fixed 底角定位留在了共享样式里，三颗钮各自 fixed 到同一角落叠成一颗，
  // 用户看到的就是「只有一颗」；沙盒自检不量视觉叠放，这类样式 bug 要靠不共享旧布局样式来防）
  const FAB_FONT = 'ui-monospace, Consolas, monospace';
  // v0.8.15 尺寸账（用户原话「四个圈圈太小了，要和其他的ai图标一样大，字体也要大一点」）
  // 参照物在页面上 ⇒ 只能量它。但「量 X 的 DOM」这件事 v0.8.5 明确避过（HISTORY：定位用固定常量，
  // 免得跟人家改版绑死），这里把口子收在三条上：① 只读几何（getBoundingClientRect 不改布局、不派事件、
  // 不发请求）；② 判据全是「形状 + 位置」，一个 class 名都不认 ⇒ 改版改不出我的量不到的分支；
  // ③ 最多试 FAB_SIZE_TRIES 趟，量不到就回落到常量，之后再也不扫页面（最坏退化成「按常量放大一档」）。
  const FAB_BASE_PX = 34;          // 旧版直径，也是「比原版大多少」的全部基准（名单锚点就按这个差值让位）
  const FAB_SIZE_MIN = 34;         // 用户要的是「大一点」：真机量到比原来还小也不许缩回去
  const FAB_SIZE_MAX = 64;         // 再大就压住右缘那一列、盖住页面自己的东西
  const FAB_SIZE_FALLBACK = 44;    // 量不到时的兜底：X 右缘那列悬浮钮的常见直径
  const FAB_SIZE_TRIES = 10;       // 实测的趟数上限（X 那列是懒挂的，脚本刚跑起来时可能还没有；约 12 秒内定夺）
  const FAB_SCAN_NODES = 300;      // 一趟最多摸多少个钮的矩形：大页面不把布局读取拉满
  let fabSize = 0;                 // 生效直径（0 = 还没定，还在试）
  let fabTries = 0;
  let fabSizeApplied = '';         // 上一次真写进 DOM 的尺寸（与「字变了才动页面」同一条纪律）
  let fabBeatOn = false;           // 读秒的 1 秒定时器开没开
  let fabBeatId = 0;
  // ---------- 设计令牌（v0.9.5「观测站仪表」，用户拍板的 HTML 原型 design/ui-redesign-proposal.html）----------
  // 全部面板与右缘轨的颜色/圆角/字体一律从这里拿字面：深空炭底 + 玻璃面板 + 发丝线 + 等宽数字，
  // 强调色只给状态用（绿=可动/已标、琥珀=读秒/待补、红=拉黑/库没回话）。两条纪律：
  // ① 改样式先改这里，别在构建函数里散落新的十六进制（同一格颜色出现两份迟早对不上）；
  // ② 字体只用本机栈（ui-monospace 系 + 宋体系）——往 x.com 注入 webfont 是新的加载痕迹，红线外的事不做。
  const UI_TOK = {
    bg: '#0a0e13',                  // 最深底（面板内嵌块/输入框）
    panel: 'rgba(15,20,27,.92)',    // 玻璃面板底（配 backdropFilter 用；不透明兜底也够看）
    blur: 'blur(14px) saturate(1.2)',
    line: '#242e39',                // 发丝线：外框、钮描边、chip 描边
    lineSoft: '#1a222c',            // 更淡的行分隔线
    ink: '#d3dce4',                 // 主文字
    inkDim: '#8b98a5',              // 次文字（chip 默认、说明）
    inkFaint: '#5a6774',            // 脚注/账目行
    acc: '#4ec98a',                 // 磷光绿：可动/已标/页头标题
    accDim: '#2f5f45',              // 绿的描边档（选中 chip/已标杆）
    accBg: '#16241c',               // 绿的底档（选中 chip）
    amber: '#e0a34c',               // 琥珀：读秒/待回关/曝光数/旧数
    red: '#e06c60',                 // 红：拉黑/库没回话/到顶
    redDim: '#5c2b2b',              // 红的描边档（已拉黑）
    blue: '#6cb2e0',                // 蓝：@handle/「库记的」
    font: '12px ' + FAB_FONT,
    serif: "'Noto Serif SC','Songti SC',SimSun,serif",
    rPanel: '14px',                 // 面板圆角
    rBtn: '6px',                   // v0.11.15 方案 A：右缘钮改圆角方钮（原 50% 圆）
    rRail: '8px',                  // v0.11.15 方案 A：玻璃柱改细轨圆角（原 24px）
    tipBg: '#111A22',              // v0.11.15 hover 全称标签底
    shadow: '0 12px 36px rgba(0,0,0,.55)',
  };
  // 方案 A（v0.11.15）：等大圆钮 → 等大圆角方钮。底色/字色/描边仍全部归 UI_TOK，
  // 强调色只在「这一颗有状态」时由各写手画上去，默认一排安静的灰。
  const FAB_STY = {
    width: '34px', height: '34px',
    borderRadius: UI_TOK.rBtn, background: UI_TOK.panel, color: UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line,
    font: '12px ' + FAB_FONT, cursor: 'pointer', boxShadow: UI_TOK.shadow,
    padding: '0', lineHeight: '32px', textAlign: 'center',
  };
  // 钮内两段式结构：label span（单字）+ count span（右上角小数字，由 fabCountSet 挂）。
  // 方案 A 起钮面一律单字横排，v0.9.5 那套「双字竖排」连字号函数一起退场；全称搬进 data-tip，
  // 由柱内嵌 style 的 ::after 在 hover 时向左浮出。button.textContent 仍是「词+数」的拼接字面。
  function fabParts(btn, label) {
    const lab = el('span', { display: 'block', lineHeight: '1.1' }, label);
    btn.appendChild(lab);
    return lab;
  }
  // 面板标题（v0.9.5）：serif 档给四块面板的页头——「观测站」的那一点仪器感来自字体的对比
  // （标题衬线、数字等宽），字色一律强调绿。字体只用本机栈（UI_TOK.serif），不往 x.com 注 webfont。
  function uiTitle(text) {
    return el('b', {
      color: UI_TOK.acc, font: '600 13px ' + UI_TOK.serif, letterSpacing: '1px',
    }, text);
  }
  function fabSizeEff() { return fabSize || FAB_BASE_PX; }
  // 字号只跟「这次要显示几个字」有关，不看内容 —— 每秒重算一次尺寸就成了新的抖动，用户嫌的正是不够大。
  // 单字（观）占直径一半；两位数字 0.46；三位/带单位 0.36（等宽字三格 ≈1.8em，再大就贴边）。
  function fabFontPx(px, txt) {
    const L = String(txt == null ? '' : txt).length || 1;
    const f = L <= 1 ? px * 0.5 : (L === 2 ? px * 0.46 : px * 0.36);
    return Math.round(Math.max(11, Math.min(22, f)));
  }
  function fabFontSty(px, txt) { return fabFontPx(px, txt) + 'px ' + FAB_FONT; }
  function fabCd(ms) {
    // 读秒三档：≤999 秒写秒；≤99 分写「Nm」；再往上写「Nh」。
    // 不留四位数的理由不是省事：24 小时档到顶时剩余能上千秒，「1440」在直径 44px 的圆里放不下，
    // 而人在那一秒要的是「还要等多久」这个量级；精确到账的口径仍在面板顶部横幅（那边不缺宽度）。
    const sec = Math.ceil((ms > 0 ? ms : 0) / 1000);
    if (sec <= 999) return String(sec);
    const min = Math.ceil(sec / 60);
    if (min <= 99) return min + 'm';
    return Math.ceil(min / 60) + 'h';
  }
  function fabFreeMs(s) {
    // 到顶时圈里读的是「还要多久才腾出名额」= 窗口里最早那次关注过期。两档都到顶取更近的：
    // 等 24 小时那档等到天黑没意义，15 分钟先松口就该先看见那个数（面板横幅给两档各自的账）。
    const a = s.over15 ? s.free15 : 0, c = s.over24 ? s.free24 : 0;
    if (a && c) return Math.min(a, c);
    return a || c || 0;
  }
  // 自家面板那一族的节点 id（v0.9.3 抽成数组：排里每加一颗、窗口每多一张，只在这里添一个名字，
  // 不用回头改那条一长串 || ——fabOwn 与自检的「抠掉这条排除」正向对照都认它）。
  const OWN_PANEL_IDS = [FABBAR_ID, CARD_ID, FLIST_ID, FAB_ID, BENCH_ID, BENCHP_ID];
  function fabOwn(n) {
    // 是我们自己挂的东西吗（连祖先往上爬 8 层）。不用 closest：桩不认 #id 选择器，会当场抛。
    let x = n, d = 0;
    while (x && d++ < 8) {
      if (x.id && OWN_PANEL_IDS.indexOf(x.id) >= 0) return true;
      if (x.id && PEER_IDS.indexOf(x.id) >= 0) return true;
      if (x.getAttribute && x.getAttribute('data-xprobe')) return true;
      x = x.parentNode;
    }
    return false;
  }
  function fabPeerDiam() {
    try {
      const vw = +window.innerWidth || 0, vh = +window.innerHeight || 0;
      if (!vw || !vh) return 0;
      const nodes = document.querySelectorAll('button, [role="button"]');
      const got = [];
      const cap = Math.min(nodes.length, FAB_SCAN_NODES);
      for (let i = 0; i < cap && got.length < 24; i++) {
        const n = nodes[i];
        if (fabOwn(n)) continue;
        const r = geoRect(n);
        if (!r) continue;
        if (vw - r.right > 40 || r.top < vh * 0.45) continue;   // 贴右缘 + 下半屏：才是用户截图里那一列
        const d = (r.width + r.height) / 2;
        if (d < 24 || d > 80 || r.width / r.height < 0.6 || r.width / r.height > 1.7) continue;
        got.push(Math.round(d));
      }
      if (!got.length) return 0;
      got.sort((a, b) => a - b);
      return got[Math.floor(got.length / 2)];                   // 中位数：混进来的胶囊/小钮不该把整列的直径带跑
    } catch (e) { return 0; }
  }
  function fabMeasure() {
    if (fabSize || fabTries >= FAB_SIZE_TRIES) return fabSizeEff();
    fabTries++;
    const d = fabPeerDiam();
    if (d) fabSize = Math.max(FAB_SIZE_MIN, Math.min(FAB_SIZE_MAX, d));
    else if (fabTries >= FAB_SIZE_TRIES) fabSize = FAB_SIZE_FALLBACK;
    return fabSizeEff();
  }
  function fabSizeSrc() { return fabSize ? (fabTries && fabSize === FAB_SIZE_FALLBACK ? 'fallback' : 'x') : 'base'; }
  function fabApplySize() {
    const px = fabSizeEff();
    if (fabSizeApplied === '' + px) return;
    const bar = document.getElementById(FABBAR_ID);
    if (!bar) return;             // 排还没建：建的时候按当前尺寸起笔，这不叫「动过页面」
    fabSizeApplied = '' + px;
    // 方案 A：六颗一律等大圆角方钮，直径仍量 X 自家右缘钮（v0.8.15 用户要的「跟 AI 图标一样大」不推翻）。
    // 字号写在 label span 上，一律按横排算；守卫灯的读秒字号归 fabLight 管，这里不碰。
    [FBTN_ID, CBTN_ID, RBTN_ID, BBTN_ID, BPBTN_ID, FAB_ID].forEach((id) => {
      const n = document.getElementById(id);
      if (!n) return;
      n.style.width = px + 'px';
      n.style.height = px + 'px';
      n.style.borderRadius = UI_TOK.rBtn;
      const lab = fabLab[id];
      if (lab && id !== FAB_ID) lab.style.font = fabFontSty(px, lab.textContent);
    });
  }
  function fabBeatOnce() {
    try { fabLight(); } catch (e) { /* 读秒这条腿翻了不许把主节拍带下去 */ }
  }
  function fabBeatSet(on) {
    const want = !!on;
    if (want === fabBeatOn) return;
    fabBeatOn = want;
    if (want) { fabBeatId = setInterval(fabBeatOnce, 1000); return; }
    const id = fabBeatId;
    fabBeatId = 0;
    try { clearInterval(id); } catch (e) { /* 沙箱没有 clearInterval 也不能因此卡住放绿 */ }
  }
  function openPanel() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ t: 'openPanel' }, () => void (chrome.runtime.lastError));
      }
    } catch (e) { /* 面板开不开不影响记账：守卫与两张表在 content script 里继续跑 */ }
  }

  // ---------- 本页曝光榜悬浮卡片（v0.8.3）----------
  // 用户点名的交互：不开独立面板，就在当前页右上角挂一张小卡，列本页（主页/时间线）曝光最高的帖子，
  // 点条目不新开页签，而是滚到那条帖子所在的位置。「不滚动」红线管的是我主动滚（翻页/懒加载/模拟阅读）；
  // 这里滚动只发生在用户点条目那一刻——用户点了就是用户的操作，我只当传话筒，且滚完不碰任何东西。
  // 节点账：常驻注入仍只有浮标一颗；卡片只在开着时才挂进页面，关闭即整棵摘除，转储树同样把它排除。
  const CARD_MAX = 12;
  let cardOpen = false;
  let cardRoot = null;
  let cardNote = '';
  let cardSort = 'view';   // 榜序：view=曝光 / reply=评论（同一抓取点的两列，客户端重排，与面板时间线榜同款）
  let cardNav = false;   // 换页过渡：URL 变了旧榜作废，先显示「正在重扫」，等重采扫完（2.5 秒回调）再出新榜
  // v0.8.6 历史档（只在 /home）：本页抓取点只有「这一刻」，整条时间线的过去只在本机库 post_points 里。
  // 所以多一个数据源，走 SW 的 dbq → 白名单 tl_win；窗口换算与 SQL 都在库里，这里只递 hours 或起止日。
  let cardMode = 'page';        // page=本页抓取点 / hist=本机库时间线
  let cardWin = '1d';           // 预设窗键；range=用下面两个日期
  let cardFrom = '', cardTo = '';
  let cardHist = null;          // { key, loading, rows, err }：只留当前窗那一份，换窗即作废
  // [键, 钮上短名, 说明里的长名, 小时数（0=全部）]
  const CARD_WINS = [
    ['1h', '1时', '近1小时', 1], ['6h', '6时', '近6小时', 6], ['1d', '1天', '近1天', 24],
    ['1w', '1周', '近1周', 168], ['1M', '1月', '近1月', 720], ['all', '全部', '全部历史', 0],
  ];
  function cardCanHist() { return tabName() === 'home'; }
  function cardModeNow() { return cardMode === 'hist' && cardCanHist() ? 'hist' : 'page'; }
  function cardWinRow() {
    for (let i = 0; i < CARD_WINS.length; i++) if (CARD_WINS[i][0] === cardWin) return CARD_WINS[i];
    return null;
  }
  function cardWinLabel() {
    if (cardWin === 'range') return (cardFrom || '?') + ' ~ ' + (cardTo || '?');
    const w = cardWinRow();
    return w ? w[2] : '近1天';
  }
  function cardHistKey() {
    if (cardWin === 'range') return 'r:' + cardFrom + '~' + cardTo;
    const w = cardWinRow();
    return 'h:' + (w ? w[3] : 24);
  }
  function cardHistMsg() {
    const m = { t: 'dbq', q: 'tl_win', limit: CARD_MAX };
    if (cardWin === 'range') { m.from = cardFrom; m.to = cardTo; }
    else { const w = cardWinRow(); m.hours = w ? w[3] : 24; }
    return m;
  }
  function dbAsk(msg, ms) {
    // 本机库只能经 SW 问（chrome.runtime → dbq → 宿主/sink）。没有这条通道就明确回 null，
    // 由界面说「通道不可用」——不许假装查过，更不许拿本页的数冒充库里的历史。
    // v0.11.4：等头变成可传的（ms）。本机模型那一趟按配置最长能等 5 分钟，
    // 9 秒那把死线是问库用的，拿它去问模型就等于自己先把回包判死。
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const wait = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 9000;
      const fin = (v) => { if (!done) { done = true; if (timer !== null) clearTimeout(timer); resolve(v); } };
      timer = setTimeout(() => fin(null), wait);
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') { fin(null); return; }
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) { /* 扩展刚重载时会有 lastError：读一下消音，结论仍是「没回包」 */ }
          fin(r || null);
        });
      } catch (e) { fin(null); }
    });
  }
  function fetchHist(force) {
    const key = cardHistKey();
    if (!force && cardHist && cardHist.key === key && !cardHist.loading && !cardHist.err) { renderCard(); return; }
    cardHist = { key: key, loading: true, rows: null, err: '' };
    renderCard();
    dbAsk(cardHistMsg()).then((r) => {
      if (!cardHist || cardHist.key !== key) return;   // 等待期间换了窗：旧回包丢掉，别拿它冒充当前窗
      cardHist.loading = false;
      if (!r) cardHist.err = '本机库没回话（宿主/sink 起来了吗？这里只读本机库，不碰页面）';
      else if (r.ok === false) cardHist.err = '本机库拒了：' + String(r.err || '未知原因');
      else if (!Array.isArray(r.rows)) cardHist.err = '回包没有 rows（库/sink 版本旧？）';
      else cardHist.rows = r.rows;
      renderCard();
    });
  }
  function hlShort(s) {
    // 库里所有时刻字面（at / last_at / time_datetime）都是 UTC：带 Z 的是 core 的 toISOString 与页面
    // `<time datetime>` 原文，老脏数据可能不带。**以前这里是把字符串切一刀就画出来** ⇒ 面板与抽屉写的
    // 是 UTC 钟点，比用户墙上的钟早 8 小时（真机现场：抽屉里一屏「10-27 08:36」，那是下午 16:36 采的）。
    // 现在过一遍 Date：带时区标记的原样解，不带的按 UTC 解（不许交给 Date 当成本地时间，那又差 8 小时），
    // 再按本机时区格式化。解不出来才退回切字面。
    const iso = String(s || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return iso;
    const d = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : iso + 'Z');
    if (!isFinite(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
    const p = (n) => String(n).length < 2 ? '0' + n : String(n);
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function hlSrc(s) {
    if (s === 'foryou') return '为你推荐';
    if (s === 'following') return '正在关注';
    return '';
  }
  function cardCopyBtn(text) {
    const cp = el('button', {
      background: 'transparent', color: UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line, borderRadius: '6px',
      cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: '0 6px', lineHeight: '16px',
    }, '复制');
    cp.type = 'button';
    cp.title = '复制帖子正文到剪贴板（只复制文字）';
    cp.addEventListener('click', () => {
      const done = (ok) => {
        cp.textContent = ok ? '已复制' : '复制失败';
        cp.style.color = ok ? UI_TOK.acc : UI_TOK.red;
        setTimeout(() => { cp.textContent = '复制'; cp.style.color = UI_TOK.inkDim; }, 900);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
        } else done(false);
      } catch (e) { done(false); }
    });
    return cp;
  }
  function histRow(t, i) {
    // 历史行不挂点击：这些帖子可能根本不在当前画面上（库里是过去的时间线），滚不过去也不导航。
    // 行尾给「标帖」与「复制」——和本页行同一对钮，标的是库里那条 id，复制的是当年那条正文。
    const r = el('div', { borderBottom: '1px solid ' + UI_TOK.lineSoft, padding: '6px 2px' });
    const top = el('div', { display: 'flex', gap: '8px' });
    top.append(el('span', { color: UI_TOK.inkDim }, '#' + (i + 1)));
    top.append(el('span', { color: UI_TOK.amber }, String(t.view)));
    top.append(el('span', { color: UI_TOK.inkDim }, '评 ' + (typeof t.reply === 'number' ? t.reply : '—')));
    if (t.author) top.append(el('span', { color: UI_TOK.blue }, '@' + t.author));
    r.append(top);
    r.append(el('div', { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' },
      t.text || '(无文字)'));
    const sub = el('div', { display: 'flex', alignItems: 'center', gap: '6px', color: UI_TOK.inkFaint, fontSize: '11px', marginTop: '2px' });
    const src = hlSrc(t.tl_src);
    if (src) sub.append(el('span', {}, src));
    if (t.at) sub.append(el('span', {}, hlShort(t.at)));
    const gap = el('span', { flex: '1', display: 'flex', alignItems: 'center', gap: '6px' });
    // v0.9.3：历史行也能标帖（库里那批帖子正是「回头要盯的那几条」，只让标当前画面上的太窄）
    gap.append(benchPCardBtn(t.tweet_id, t.author, t.text || ''));
    gap.append(cardCopyBtn(t.text || ''));
    sub.append(gap);
    r.append(sub);
    return r;
  }
  function cardScrollTo(id) {
    if (!/^\d+$/.test(String(id))) { cardNote = '这条没有帖子 id，滚不了'; return false; }
    // 只读查找：article 里的 status 链接是稳定锚点。不存节点引用——虚拟列表里存了也是死引用，
    // 每次点击都现场查；查不到就说查不到（列表是虚拟化的），不猜位置不硬滚。
    // 逐个 article 内查而不是一条后代选择器查到底：既少一次全页扫描，也免得选择器形状依赖。
    let hit = null;
    try {
      const arts = document.querySelectorAll('article');
      for (let i = 0; i < arts.length && !hit; i++) {
        const links = arts[i].querySelectorAll('a[href*="/status/' + id + '"]');
        for (let j = 0; j < links.length; j++) {
          const href = links[j].getAttribute('href') || '';
          if (new RegExp('/status/' + id + '(/|$)').test(href)) {
            const art = links[j].closest ? links[j].closest('article') : null;
            if (art) { hit = art; break; }
          }
        }
      }
    } catch (e) { hit = null; }
    if (!hit) { cardNote = '#' + id + ' 不在当前画面里（列表是虚拟化的，翻一翻再点）；只滚动，不导航'; return false; }
    cardNote = '';
    try { hit.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { hit.scrollIntoView(); }
    return true;
  }
  function cardRows() {
    // num 是 firstNumber 的形状 {value, ...}，不是裸数字 —— 取 .value，别把「有对象」当成「有数」
    const vnum = (t) => (t.metrics && t.metrics.view && t.metrics.view.num && t.metrics.view.num.value);
    const rnum = (t) => (t.metrics && t.metrics.reply && t.metrics.reply.num && t.metrics.reply.num.value);
    const rows = collectArticles().filter((t) => t.tweetId && !t.adSuspect && typeof vnum(t) === 'number');
    const key = cardSort === 'reply' ? rnum : vnum;
    rows.sort((a, b) => ((key(b) || 0) - (key(a) || 0)) || ((vnum(b) || 0) - (vnum(a) || 0)) || (a.idx - b.idx));
    return rows.slice(0, CARD_MAX);
  }
  function cardBuild() {
    const hist = cardModeNow() === 'hist';
    const canHist = cardCanHist();
    const root = el('div', {
      position: 'fixed', right: '14px', top: '14px', zIndex: '2147483647', width: '300px',
      maxHeight: '70vh', overflowY: 'auto', background: UI_TOK.panel, backdropFilter: UI_TOK.blur, color: UI_TOK.ink,
      border: '1px solid ' + UI_TOK.line, borderRadius: UI_TOK.rPanel, padding: '10px 12px',
      font: '12px ui-monospace, Consolas, monospace', boxShadow: UI_TOK.shadow,
    });
    root.id = CARD_ID;
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' });
    head.append(uiTitle(hist ? '时间线历史榜' : '本页曝光榜'));
    head.append(el('span', { flex: '1' }));
    const sbtn = (k, lab) => {
      const s = el('button', {
        background: 'transparent', color: cardSort === k ? UI_TOK.acc : UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line,
        borderRadius: '6px', cursor: 'pointer', font: 'inherit', padding: '1px 6px', lineHeight: '18px',
      }, lab);
      s.type = 'button';
      s.title = '按' + lab + '降序（同一抓取点的两列，客户端重排；点「刷」重新扫本页）';
      s.addEventListener('click', () => { cardSort = k; renderCard(); });
      return s;
    };
    if (!hist) head.append(sbtn('view', '曝光'), sbtn('reply', '评论'));
    const hbtn = (label, tip, fn) => {
      const h = el('button', {
        background: 'transparent', color: UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line, borderRadius: '6px',
        cursor: 'pointer', font: 'inherit', padding: '1px 7px', lineHeight: '18px',
      }, label);
      h.type = 'button'; h.title = tip;
      h.addEventListener('click', fn);
      return h;
    };
    if (hist) {
      head.append(hbtn('刷', '重读一遍本机库（换窗会自动读，这颗是「同一窗再查一次」）', () => fetchHist(true)));
    } else {
      head.append(hbtn('刷', '重新扫一遍当前页面上的帖子（1.2 秒节拍器不会自己刷：每轮动 DOM 就是新的可观察节奏）', () => { cardNav = false; renderCard(); }));
    }
    head.append(hbtn('详', '打开 Side Panel 详面板（完整榜单/趋势/设置都在那边）', openPanel));
    head.append(hbtn('×', '收起卡片（整棵从页面摘掉）', () => { cardOpen = false; renderCard(); }));
    root.append(head);

    // 数据源切换只在 /home 露出来：别处没有「整条首页时间线」这件事，露一颗永远点不亮的钮不如不放
    if (canHist) {
      const mrow = el('div', { display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' });
      const mtab = (k, lab, tip) => {
        const on = cardMode === k;
        const b = el('button', {
          background: on ? UI_TOK.accBg : 'transparent', color: on ? UI_TOK.acc : UI_TOK.inkDim,
          border: '1px solid ' + (on ? UI_TOK.accDim : UI_TOK.line), borderRadius: '6px',
          cursor: 'pointer', font: 'inherit', padding: '1px 8px', lineHeight: '18px',
        }, lab);
        b.type = 'button'; b.title = tip;
        b.addEventListener('click', () => {
          if (cardMode === k) return;
          cardMode = k; cardNote = '';
          if (k === 'hist') { fetchHist(false); return; }
          renderCard();
        });
        return b;
      };
      mrow.append(mtab('page', '本页', '当前页面上的帖子（这一刻的抓取点）'));
      mrow.append(mtab('hist', '历史', '本机库里整条时间线的曝光排行，可按时间窗筛'));
      mrow.append(el('span', { flex: '1' }));
      mrow.append(el('span', { color: UI_TOK.inkFaint, fontSize: '11px' }, hist ? cardWinLabel() : '本页这一刻'));
      root.append(mrow);
    }

    if (hist) {
      // 时间窗：六个预设 + 起止日。预设与区间互斥（点了预设就清掉手填的日期），键与 SQL 参数一一对应
      const crow = el('div', { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '4px' });
      CARD_WINS.forEach((w) => {
        const on = cardWin === w[0];
        const b = el('button', {
          background: on ? UI_TOK.accBg : 'transparent', color: on ? UI_TOK.acc : UI_TOK.inkDim,
          border: '1px solid ' + (on ? UI_TOK.accDim : UI_TOK.line), borderRadius: '6px',
          cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: '1px 6px', lineHeight: '17px',
        }, w[1]);
        b.type = 'button';
        b.title = w[2] + '（每帖取窗内最近一次带曝光的采集点，按曝光降序）';
        b.addEventListener('click', () => {
          if (cardWin === w[0]) { fetchHist(false); return; }
          cardWin = w[0]; cardFrom = ''; cardTo = ''; cardNote = '';
          fetchHist(true);
        });
        crow.append(b);
      });
      root.append(crow);
      const din = { width: '96px', background: UI_TOK.bg, color: UI_TOK.ink, border: '1px solid ' + UI_TOK.line,
        borderRadius: '6px', font: 'inherit', fontSize: '11px', padding: '0 4px', height: '20px' };
      const fIn = el('input', din); fIn.type = 'date'; fIn.value = cardFrom || ''; fIn.title = '起始日（含）';
      const tIn = el('input', din); tIn.type = 'date'; tIn.value = cardTo || ''; tIn.title = '截止日（含）';
      const go = el('button', {
        background: 'transparent', color: UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line, borderRadius: '6px',
        cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: '1px 8px', lineHeight: '18px',
      }, '查');
      go.type = 'button'; go.title = '按起止日查本机库（含首尾两天）';
      go.addEventListener('click', () => {
        const f = String(fIn.value || ''), t = String(tIn.value || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || f > t) {
          cardNote = '起止日要 YYYY-MM-DD，且起 <= 止'; renderCard(); return;
        }
        cardFrom = f; cardTo = t; cardWin = 'range'; cardNote = '';
        fetchHist(true);
      });
      const drow = el('div', { display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' });
      drow.append(fIn, el('span', { color: UI_TOK.inkFaint }, '~'), tIn, go);
      root.append(drow);
    }

    if (cardNav && !hist) {
      // 换页过渡态：新页面的 article 还没被重采扫过，别拿旧页的数冒充新页的数——先给一句人话。
      // 历史档不跟页面走（读的是库），换页不清它。
      root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' }, '页面切了：旧榜清空，正在重扫本页…'));
      return root;
    }
    if (hist) {
      if (!cardHist || cardHist.key !== cardHistKey()) {
        // 首次进来/刚换窗：先给一句「在读」，真正的请求放到本轮渲染之后 —— 免得拼 DOM 的中途
        // 又调 renderCard 把正在拼的这棵拆了
        root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' }, '正在读本机库…'));
        setTimeout(() => { if (cardOpen && cardModeNow() === 'hist') fetchHist(false); }, 0);
      } else if (cardHist.loading) {
        root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' }, '正在读本机库…'));
      } else if (cardHist.err) {
        root.append(el('div', { color: UI_TOK.red, padding: '8px 0' }, cardHist.err));
      } else if (!cardHist.rows.length) {
        root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' },
          '这个窗口里库里没有带曝光数的帖子（窗口=' + cardWinLabel() + '；home 快照攒过才有排）。'));
      } else {
        cardHist.rows.forEach((t, i) => root.append(histRow(t, i)));
      }
    } else {
      const rows = cardRows();
      if (!rows.length) {
        root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' },
          '本页没有带观看数的帖子（主页/时间线才有指标；等采集器扫过一轮再点「刷」）。'));
      } else {
        // 数据条（v0.9.5）：每条行底一根 2px 细条，长度=该帖曝光占本榜最大曝光的比例——
        // 榜单一眼看清「差距有多大」而不只是名次。纯样式，不碰页面、不发请求。
        let maxView = 0;
        rows.forEach((t) => { const v = t.metrics.view && t.metrics.view.num && t.metrics.view.num.value; if (v > maxView) maxView = v; });
        rows.forEach((t, i) => {
          // 行拆两块：上面一块是「点了滚动」的主区，右下角的「复制」钮放在主区**外**当兄弟——
          // 「不拦点击」红线禁止 stopPropagation/preventDefault（那是拦 X 自己的事件用的），
          // 复制钮不嵌进可点击区，就根本不需要拦冒泡。
          const r = el('div', { borderBottom: '1px solid ' + UI_TOK.lineSoft, padding: '6px 2px' });
          const main = el('div', { cursor: 'pointer' });
          main.title = '点击滚动到这条帖子（不新开页签、不导航）';
          const rnum = t.metrics.reply && t.metrics.reply.num && t.metrics.reply.num.value;
          const top = el('div', { display: 'flex', gap: '8px' });
          top.append(el('span', { color: UI_TOK.inkDim }, '#' + (i + 1)));
          top.append(el('span', { color: UI_TOK.amber }, String(t.metrics.view.num.value)));
          top.append(el('span', { color: UI_TOK.inkDim }, '评 ' + (typeof rnum === 'number' ? rnum : '—')));
          if (t.author) top.append(el('span', { color: UI_TOK.blue }, '@' + t.author));
          main.append(top);
          main.append(el('div', { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' },
            t.text || '(无文字)'));
          main.addEventListener('click', () => { if (cardScrollTo(t.tweetId)) renderCard(); });
          r.append(main);
          // 数据条：第一名满条，其余按比例；0 曝光/历史档缺数不画条（缺数不冒充小数，RL-11 的样式版）
          const vv = t.metrics.view && t.metrics.view.num && t.metrics.view.num.value;
          if (maxView > 0 && typeof vv === 'number' && vv > 0) {
            r.append(el('div', {
              height: '2px', width: Math.max(3, Math.round(vv * 100 / maxView)) + '%',
              background: i === 0 ? UI_TOK.acc : UI_TOK.amber, opacity: i === 0 ? '0.8' : '0.45',
              borderRadius: '1px', marginTop: '3px',
            }, ''));
          }
          const rfoot = el('div', { textAlign: 'right', marginTop: '2px', minHeight: '16px' });
          // v0.9.3 行尾两颗：「标帖」记进标杆帖子（用户点的第二条腿——页头那颗只能标当前详情页的主帖，
          // 这一颗能标本页榜单里的任何一条），再是「复制」。都在可点区**外**，不需要拦冒泡。
          rfoot.append(benchPCardBtn(t.tweetId, t.author, t.text || ''));
          const cp = cardCopyBtn(t.text || '');
          rfoot.append(cp);
          r.append(rfoot);
          root.append(r);
        });
      }
    }
    const footText = hist
      ? (cardNote ? cardNote + '  ' : '') + '窗口=' + cardWinLabel() + ' · 数据=本机库（每帖取窗内最近一次曝光） · 标帖=记进标杆帖子 · 复制=正文 · v' + VER
      : (cardNote ? cardNote + '  ' : '') + '点条目=滚到该帖（不新开页签）· 标帖=记进标杆帖子（右缘「标帖」窗口）· 复制=正文进剪贴板 · 刷=重扫本页 · v' + VER;
    const foot = el('div', { color: cardNote ? UI_TOK.red : UI_TOK.inkFaint, paddingTop: '6px' }, footText);
    root.append(foot);
    return root;
  }
  function renderCard() {
    if (cardRoot) cardRoot.remove();
    cardRoot = cardOpen ? cardBuild() : null;
    if (cardRoot) document.documentElement.appendChild(cardRoot);
  }
  function toggleCard() { cardOpen = !cardOpen; renderCard(); }
  function cardBtn() { return document.getElementById(CBTN_ID); }

  // ---------- 本页用户列表（v0.8.5）----------
  // 用户点名：帖子页右侧要一张「本页用户」名单，已关注/未关注两个页签，点某个人滚到他的帖子位置。
  // 数据就来自 collectArticles 已抓到的 author+followState——不另开一条 DOM 扫描线：
  // 榜单与名单共享同一个抓取点，口径不打架。关系读不到（article 里没有 follow/unfollow 钮）标「?」如实说，不猜。
  // 节点账与曝光榜卡片同纪律：只在开着时挂进页面，关闭整棵摘除，转储树同样排除。
  let flistOpen = false;
  let flistRoot = null;
  let flistTab = 'not_following';   // 默认未关注：用这名单是为了找人，已关注的本来就在时间线上看得见
  // v0.8.14「待补」筛选：这两个数只能从 TA 的悬停名片/主页头部读到，名单能一眼告诉你还差谁 ⇒ 照着悬停一次就永久入库
  let flistNeed = false;
  // v0.11.3（用户口径「待回也放在未关中，表头两列就够了」）：待回关不再是第三个页签，改成「未关」里的一层筛选。
  // 筛选态与页签态分家：页签说关系（已关/未关），这颗说「只看 TA 关注了我、我还没回关的那几行」。
  let flistFb = false;
  // 面板锚在钮排上方（bottom:334 起算），高度上限必须把这 334 底距扣掉——第一版写 60vh，
  // 屏幕一矮头部（标题/页签）就被顶出屏幕外（用户现场：只看得见名单、看不见上面）。
  // 拖动位置也留在这里：换页重画（renderFlist 拆了重建）不丢用户拖去的地方。
  const FLIST_BOTTOM = 334;
  let flistPos = { r: 14, b: FLIST_BOTTOM };
  let flistDragged = false;   // v0.8.15：用户一旦拖过，这一格位置就归他，不再跟着钮排的尺寸自动挪
  function fabSlotPx() { return fabSizeEff() + 6; }   // 一颗钮 + 6px 缝：往排里加一颗，头顶那两格就得各让出这么多
  function flistBottomPx() {
    // 334 是「四颗 34px + 6px 缝」那套几何校准出来的锚点（见 HISTORY v0.8.5）。
    // 浮标变大只补「大出来的那截 ×4 颗」，基准值一动不动 ⇒ 没实测到也没实测到时都按同一算式。
    // v0.9.0 排里多了第五颗（标杆）：整排长高一颗的位置，名单与标杆窗口都按「一颗 + 缝」往上让，
    // 让位的账写在 fabSlotPx 一处 ⇒ 以后再加一颗仍然只改这一行，不用回头重标 334。
    // v0.9.3 第六颗（标帖）真的来了：就是按上面那句话改这一行——多让一颗（fabSlotPx * 2）+ 尺寸差多算一档（* 5）。
    // v0.11.4 第七颗（回帖）是**按闸显隐**的：闸关着它 display:none、不占位 ⇒ 让位也就少让一格。
    // 这里跟着 aiBtnShown() 走而不是永远预留一格：预留着，纯本地模式下这两张窗口头顶会白空一颗的位置。
    const x = aiBtnShown() ? 1 : 0;
    return FLIST_BOTTOM + Math.max(0, (fabSizeEff() - FAB_BASE_PX) * (5 + x)) + fabSlotPx() * (2 + x);
  }
  // v0.11.14 行关系判定：与 relVerdict 同一条优先序（钮 > 桥 > 台账）。以前名单只认「这一页的钮」
  // 与台账 following —— 桥当场带回的读数（时间线/名片的回包推来的 following/followed_by）进不了名单
  // ⇒ 页面上的标签都翻绿了，名单里还挂着「?」或旧的「·」（用户报的「未关并没有实时刷新」的另一半病根）。
  // 桥明确 following=false 时台账的 following 不许翻案（新读数赢旧账，与 relVerdict 的 noRead 同一条）。
  function flistRelOf(h, domState) {
    const k = String(h || '').toLowerCase();
    const rec = fiberRel.get(k) || null;
    const fv = (rec && Date.now() - rec.at <= REL_FIBER_TTL) ? rec : null;
    const fbF = (fv && typeof fv.following === 'boolean') ? fv.following : null;   // 桥说：我关注 TA
    const fbY = (fv && typeof fv.followsYou === 'boolean') ? fv.followsYou : null; // 桥说：TA 关注我
    const u = users[k] || null;
    const seen = (u && u.seenAs) || {};
    const rel = (u && u.relation) || '';
    const noBtn = domState === 'not_following';
    const out = { state: '', src: '', them: false };
    if (domState === 'following') out.state = 'following';
    else if (fbF === true) { out.state = 'following'; out.src = '桥'; }
    else if (!noBtn && (rel === 'following' || seen.following)) { out.state = 'following'; out.src = '库'; }
    else if (noBtn || fbF === false || (fbF !== true && rel === 'not_following')) out.state = 'not_following';
    // TA 关注我：桥带回 followed_by=true 也算（页面上那颗「他单向」标签认的就是这条判据）——
    // 名单行上的「←」跟上，别再出现「标签说 TA 关注你、名单里查无此人」。
    out.them = fbY === true || !!(seen.followers || seen.verified_followers);
    return out;
  }
  function flistRows() {
    // 同一人在这页可能发了多条：按 handle 去重，优先留带 tweetId 的那条（点了才有得滚），名字/关系取第一个非空的
    const by = {};
    const order = [];
    // v0.8.5 补五：关注/粉丝列表页的行不是 article（整页 0 张 article），名单改吃 collectUsers 的行——
    // 行上本来就渲染着 follow/unfollow 钮，关系直接可读（这是详情页评论行得不到的待遇）。
    // 只认 origin='list' 的正文列行：侧栏推荐位同样是 UserCell，混进来就把 X 的推荐当成「本页用户」。
    if (listTabFromPath(location.pathname)) {
      collectUsers().rows.forEach((t) => {
        const h = String(t.handle || '').toLowerCase();
        if (!h || t.origin !== 'list') return;
        if (!by[h]) { by[h] = { handle: h, name: '', state: '', tweetId: '', fromList: true, idx: t.idx }; order.push(h); }
        const r = by[h];
        if (!r.name && t.name) r.name = t.name;
        if (!r.state && t.followState) r.state = t.followState;
        if (t.idx < r.idx) r.idx = t.idx;
      });
    } else {
      collectArticles().forEach((t) => {
        const h = String(t.author || '').toLowerCase();
        if (!h || h === '-') return;
        if (!by[h]) { by[h] = { handle: h, name: '', state: '', tweetId: '', idx: t.idx }; order.push(h); }
        const r = by[h];
        if (!r.tweetId && t.tweetId) r.tweetId = t.tweetId;
        // v0.11.3（用户报「名称显示的是 id 不是昵称」）：帖子行的显示名住在 authorName 上
        // （collectArticles 只往那一个键写，见 L604），这里以前读的是 t.name ⇒ 帖子页永远读空，
        // 名单只能退回 @handle。以前名单行尾那颗「标杆」落账时就补过一口本机台账（v0.9.0 的注释实锤过同一口井），只是没回头修名单本身。
        if (!r.name && (t.authorName || t.name)) r.name = t.authorName || t.name;
        if (!r.state && t.followState) r.state = t.followState;
        if (t.idx < r.idx) r.idx = t.idx;
      });
    }
    order.sort((a, b) => by[a].idx - by[b].idx);
    // 库回填（v0.8.5 补四，用户现场「全部都是未关注，但实际是有的」）：详情页 X 不给评论者渲染关系钮
    // （dump 实锤：整页只有主帖作者一颗 -unfollow，还挂在右栏作者卡里），评论行 followOf 永远读空。
    // 探针自己有三条腿记的账（关注列表行/主页头部/时间线徽标 ⇒ users 表 relation）——页面没说的，
    // 库里说了就算 ✓，但标蓝并注明「库记的，可能过时」；页面按钮读到的仍然优先，库不许翻案。
    return order.map((h) => {
      const r = by[h];
      // v0.11.14：状态走 flistRelOf（钮 > 桥 > 台账）。库回填那口井还在（详情页 X 不给评论者渲染关系钮），
      // 只是多了「桥」这一条腿：页面没说、台账也没记时，桥带回的读数当场补上——名单与页面标签同一条口径。
      const vr = flistRelOf(h, r.state);
      if (r.state !== 'following' && vr.state === 'following') { r.state = 'following'; r.src = vr.src; }
      else if (!r.state && vr.state === 'not_following') r.state = 'not_following';
      if (vr.them && r.state !== 'following') r.fb = true;
      // 页面上这一行没给显示名（详情页的评论行、被剥掉的名字）⇒ 补一口本机 users 台账（探针自己
      // 悬停名片/主页头部读来的）。补不到就留空，由行渲染退成 @handle —— 宁可不显示昵称，不编一个。
      if (!r.name && users[h] && users[h].name) r.name = users[h].name;
      return r;
    });
  }
  // v0.8.5 补五：待回关 = TA 关注了我（出现在我的 followers/verified_followers 列表 ⇒ users.seenAs.followers）
  // 而我没回关（relation !== 'following'）；已拉黑的不算（用户点名「去掉黑名单」）。
  // 全库口径：不挑页面，在任何页面点「回」钮看到的都是同一份账；账齐不齐取决于进没进过自己的粉丝列表页。
  // v0.11.14：桥当场带回 followed_by=true、而台账还没记粉丝列表的人也是同一批（页面上那颗「他单向」
  // 标签认的就是这条判据）——名单与「回」钮的数跟上，不再出现「标签说 TA 关注你、名单里查无此人」。
  // 桥明确 following=true 的不算（那是互关）；桥读数仍按 REL_FIBER_TTL 保鲜，过期不作数。
  function followbackRows() {
    const out = [];
    const nowT = Date.now();
    const fresh = (h) => { const rec = fiberRel.get(h); return (rec && nowT - rec.at <= REL_FIBER_TTL) ? rec : null; };
    Object.keys(users).forEach((h) => {
      const u = users[h];
      if (!u || !u.seenAs || !u.seenAs.followers) return;
      if (u.relation === 'following') return;
      const fv = fresh(h);
      if (fv && fv.following === true) return;   // 桥说你在关注 TA：互关，不进待回
      if (isBlocked(h)) return;
      out.push({ handle: h, name: u.name || '', state: '', tweetId: '', fromList: true, fb: true, idx: out.length });
    });
    fiberRel.forEach((rec, h) => {
      if (!rec || nowT - rec.at > REL_FIBER_TTL || rec.followsYou !== true || rec.following === true) return;
      if (out.some((r) => r.handle === h)) return;
      const u = users[h] || {};
      if (u.relation === 'following' || (u.seenAs && u.seenAs.following)) return;
      if (isBlocked(h)) return;
      out.push({ handle: h, name: u.name || '', state: '', tweetId: '', fromList: true, fb: true, idx: out.length });
    });
    out.sort((a, b) => ((users[b.handle] || {}).updatedAt || 0) - ((users[a.handle] || {}).updatedAt || 0));
    return out;
  }
  function followbackCount() { return followbackRows().length; }
  function openFollowback() {
    // v0.11.3：待回关不再是第三页签 ⇒ 这颗「回」钮改成「未关」那一列上的一层筛选。
    // 名单已经开着且正筛着 ⇒ 再点一下是取消（进得去也出得来，UIX D-3）。
    if (flistOpen && flistFb) { flistFb = false; renderFlist(); return; }
    flistTab = 'not_following'; flistFb = true;
    if (!flistOpen) flistOpen = true;
    renderFlist();
  }
  function flistBuild() {
    if (!flistDragged) flistPos.b = flistBottomPx();   // 钮排在第一趟可能从 34 实测变大 ⇒ 名单跟着让开（拖过以后归用户）
    const root = el('div', {
      // 顶在钮排（bottom:210 + 四颗 + 缝隙）之上，别把自家钮排也盖了；头部标题可按住拖动
      position: 'fixed', right: flistPos.r + 'px', bottom: flistPos.b + 'px', zIndex: '2147483647', width: '260px',
      maxHeight: 'calc(100vh - ' + (flistPos.b + 20) + 'px)', overflowY: 'auto',
      // v0.11.3（用户报「鼠标滚动太快了」）：滚轮在名单里滚到头，那一股惯性会接着把 X 的整页带走
      // —— 一滚就是两个画面在跳，读起来就是「太快、刹不住」。overscroll-behavior 只断这种「串联」，
      // 步长仍然交给浏览器默认（不接管 wheel、不自定义一行几像素）：CSS 一个字，JS 一行都不加。
      overscrollBehavior: 'contain',
      userSelect: 'none', background: UI_TOK.panel, backdropFilter: UI_TOK.blur, color: UI_TOK.ink,
      border: '1px solid ' + UI_TOK.line, borderRadius: UI_TOK.rPanel, padding: '10px 12px',
      font: '12px ui-monospace, Consolas, monospace', boxShadow: UI_TOK.shadow,
    });
    root.id = FLIST_ID;
    const all = flistRows();
    const nFol = all.filter((r) => r.state === 'following').length;
    // v0.11.3（用户口径「待回也放在未关中，表头两列就够了」）：待回关不再是第三页签，并进「未关」这一列。
    // 排法：这一页读到的未关注行在前（有 tweetId、点了能滚），只有库里记着「TA 关注了我、我没回关」
    // 而这一页没出现的人补在后面（按最近看到的时间排，列表行没有帖子可滚，如实说）。
    const fbRows = followbackRows();
    const nFb = fbRows.length;
    const fbSet = {};
    fbRows.forEach((r) => { fbSet[r.handle] = true; });
    const merged = [];
    const inMerged = {};
    all.forEach((r) => {
      if (r.state === 'following') return;
      if (fbSet[r.handle]) r.fb = true;
      inMerged[r.handle] = true;
      merged.push(r);
    });
    fbRows.forEach((r) => { if (!inMerged[r.handle]) merged.push(r); });
    // v0.8.14「待补清单」：用户问「列表展示完能不能直接把所有人的比例算出来」—— 这两个数 X 不写在评论行里
    // （真机 14 份转储实锤：整页只有一份带 followers_count 的对象，且那是登录者自己），所以算不出来；
    // 能给的是**还差谁**这张清单：照着悬停一次头像，数当场入库、以后不用再来。
    const rtOf = (h) => ratioInfo(h);
    const needRow = (h) => { const x = rtOf(h); return !x || x.stale; };
    const nNeed = all.filter((r) => needRow(r.handle)).length;
    const nOld = all.filter((r) => { const x = rtOf(r.handle); return x && x.stale; }).length;
    // v0.11.3（用户带截图点名「表头太难看」）：宽度 260px 里挤六格，字面一长就折行 ——「已关注(3)」竖着排成
    // 三行（截图就是那样）。两条一起治：每一格 whiteSpace:nowrap（字面再也不折断）+ head 允许换行
    // （装不下的整颗挪到第二行，而不是把字压成竖排）。窄屏/人数变多都不会再把表头挤烂。
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' });
    const grip = uiTitle('本页用户');
    grip.style.whiteSpace = 'nowrap';
    grip.style.cursor = 'move';
    grip.title = '按住拖动整个名单（只在放开那一刻记账；拖的是探针自己的面板，不碰页面）';
    grip.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const sx = ev.clientX, sy = ev.clientY, sr = flistPos.r, sb = flistPos.b;
      const maxB = Math.max(0, window.innerHeight - 80);
      const mv = (e) => {
        // 不用 preventDefault（红线：不拦事件）——名单整体 userSelect:none，拖动不会拉出文字选区
        flistDragged = true;   // 从这一刻起这个位置归用户：换页重画/钮排变大都不许把它拽回去
        flistPos.r = Math.max(0, Math.min(800, sr - (e.clientX - sx)));
        flistPos.b = Math.max(0, Math.min(maxB, sb - (e.clientY - sy)));
        root.style.right = flistPos.r + 'px';
        root.style.bottom = flistPos.b + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    head.append(grip);
    head.append(el('span', { flex: '1' }));
    const tab = (k, lab, n) => {
      const s = el('button', {
        background: 'transparent', color: flistTab === k ? UI_TOK.acc : UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line,
        borderRadius: '6px', cursor: 'pointer', font: 'inherit', padding: '1px 6px', lineHeight: '18px',
        whiteSpace: 'nowrap', flex: 'none',
      }, lab + '(' + n + ')');
      s.type = 'button';
      s.title = k === 'following'
        ? '只看已关注（绿✓=这一页读到 -unfollow 钮的；蓝✓=库/桥记的：本机台账或 X 回包带回的读数，页面没渲染钮）'
        : '未关注的都在这一列（「?」= 这一页没读到关系钮、库里也没记 following）；'
          + 'TA 关注了你、你还没回关的带一枚琥珀「←」——这一列就是以前那第三页签「待回关」的全部人数，不再单开一列';
      s.addEventListener('click', () => { flistTab = k; flistFb = false; renderFlist(); });
      return s;
    };
    head.append(tab('following', '已关', nFol), tab('not_following', '未关', merged.length));
    const hbtn = (label, tip, fn) => {
      const x = el('button', {
        background: 'transparent', color: UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line, borderRadius: '6px',
        cursor: 'pointer', font: 'inherit', padding: '1px 7px', lineHeight: '18px',
        whiteSpace: 'nowrap', flex: 'none',
      }, label);
      x.type = 'button'; x.title = tip;
      x.addEventListener('click', fn);
      return x;
    };
    head.append(hbtn('刷', '立即重扫一遍当前页面上的用户。名单开着时节拍器也会跟着页面自动刷（成员/状态变了才重画，滚动位置不丢）；这颗是马上就来一遍', renderFlist));
    // 「待补」= 这一页里还没读到那两个数的人（或数已过期）。筛子只改名单显示，不碰页面。
    const nb = hbtn('待补(' + nNeed + ')',
      '只看「本机台账里还没有 TA 的关注/粉丝数」的行（含数已超过 ' + RATIO_STALE_DAYS + ' 天的）。\n'
      + '这两个数 X 不写在评论行里，只有 TA 的悬停名片和主页头部有 ⇒ 想补齐就把头像各悬停一次，'
      + '名片弹出来那一拍探针自动读走并入库（不模拟鼠标、不发请求），以后在任何页面见到 TA 都有标签。',
      () => { flistNeed = !flistNeed; renderFlist(); });
    if (flistNeed) { nb.style.color = UI_TOK.acc; nb.style.borderColor = UI_TOK.acc; }
    head.append(nb);
    // 「待回」只在筛着的时候才出现（用户口径：表头两列就够了）。右缘「回」钮是它的入口，这颗是出口——
    // 两个方向都得按得回去，不然点进去出不来（UIX D-3：动作要能被取消）。
    if (flistFb) {
      const fbChip = hbtn('待回(' + nFb + ')',
        '现在只看「TA 关注了你、你还没回关」的行（全库口径，去掉已拉黑的）。点一下取消筛选，回到「未关」全部。',
        () => { flistFb = false; renderFlist(); });
      fbChip.style.color = UI_TOK.amber; fbChip.style.borderColor = UI_TOK.amber;
      head.append(fbChip);
    }
    head.append(hbtn('×', '收起名单（整棵从页面摘掉）', () => { flistOpen = false; renderFlist(); }));
    root.append(head);
    root.append(el('div', { color: UI_TOK.inkFaint, paddingBottom: '6px' },
      '比例可算 ' + (all.length - nNeed) + '/' + all.length + ' · 待补 ' + nNeed
      + (nOld ? '（其中旧数 ' + nOld + '）' : '')
      + '：缺的把头像悬停一次就永久入库（探针不替你点开任何东西）'));
    let rows = flistTab === 'following' ? all.filter((r) => r.state === 'following') : merged;
    if (flistFb) rows = rows.filter((r) => r.fb);
    if (flistNeed) rows = rows.filter((r) => needRow(r.handle));
    // 页脚先建后 append：行点击要把「滚了没滚成」这句话写回去，而重画整棵名单会丢掉滚动位置
    // （用户报「点击跳转也有点问题」的另一半病根：点一下 ⇒ 面板重建 ⇒ 自己滚到第几行没了）。
    const footBase = '点条目=滚到该用户的帖子（不导航） · ✓已关（蓝✓=库/桥记的：本机台账或 X 回包，非本页按钮） · ←TA 关注了你、你还没回关 · ?关系没读到'
      + ' · 「拉黑」「标杆」这两列去掉了（v0.11.3，用户点名）：标人去个人主页昵称右边那颗「☆标此人」，拉黑用名字行那颗红徽标，成批看/改分类去右缘「标杆」「标帖」两扇窗口'
      + ' · 比例=正在关注÷关注者（底色=档位，「—」=本机还没这两个数，虚线=数已超过 ' + RATIO_STALE_DAYS + ' 天） · v' + VER;
    const foot = el('div', { color: cardNote ? UI_TOK.red : UI_TOK.inkFaint, paddingTop: '6px' },
      (cardNote ? cardNote + '  ' : '') + footBase);
    // 反馈落在看得见的地方（UIX D-6）：页脚在长名单的最底下，点上面那一行时它根本不在画面里
    // ⇒ 同一句话先写进这一行末尾那一格（平时是空 span，不占宽）。
    const say = (statusEl, msg) => {
      if (statusEl) { statusEl.textContent = msg || ''; statusEl.style.color = UI_TOK.red; }
      foot.textContent = (msg ? msg + '  ' : '') + footBase;
      foot.style.color = msg ? UI_TOK.red : UI_TOK.inkFaint;
    };
    if (!rows.length) {
      root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' },
        flistNeed ? '这一档没有待补的：这一列每个人的数本机都读到了（或都不算过期）。点「待补」切回全部。'
          : (flistFb
            ? '这一列没有带「←」的行：库里没有「TA 关注了你、你还没回关」的人（或都在这页显示了并已回关）。进一次自己的粉丝列表页，账就齐了；点「待回」取消这层筛选。'
            : (flistTab === 'following'
              ? '本页没有读到「已关注」的用户（关系钮没扫到的人会待在「未关」那一列里带「?」）。'
              : '本页没有带作者的用户（帖子详情页的评论要等采集器扫过一轮，再点「刷」）。'))));
    } else {
      rows.forEach((r) => {
        const row = el('div', {
          display: 'flex', alignItems: 'center', gap: '6px',
          borderBottom: '1px solid ' + UI_TOK.lineSoft, padding: '6px 2px', cursor: r.tweetId ? 'pointer' : 'default',
        });
        const blk = isBlocked(r.handle);
        // v0.11.3 两件事一起改在这行上（用户口径「名称显示的是 id 不是昵称」「只显示昵称」）：
        // 这一格只写显示名，名字读不到才退成 @handle（宁可不显示昵称，不编一个）；handle 整串搬到悬停 title 第一位。
        row.title = '@' + r.handle
          + (r.tweetId ? ' · 点击滚动到 TA 的帖子（不导航；滚动只在点这一刻发生）'
            : (r.fb ? ' · ← TA 关注了你、你还没回关（这一行是库里补的，页面没有 TA 的帖子可滚；回关去 TA 的主页操作，探针不代点）'
              : (r.fromList ? ' · 列表页的行没有帖子可滚（关注/取关去 TA 的主页操作）' : ' · 这条没抓到帖子 id，滚不了（点「刷」重扫试试）')));
        if (r.src === '库') {
          row.title += '；✓ 是本机库记的（users 表，可能过时）——这页没渲染关系钮';
        } else if (r.src === '桥') {
          row.title += '；✓ 是 X 回包当场带回的读数（主世界桥，页面会话内新鲜）';
        }
        if (blk) row.title += '；已拉黑（本机 blocks 账，红字）';
        const mark = el('span', {
          color: r.fb ? UI_TOK.amber : (r.state === 'following' ? (r.src ? UI_TOK.blue : UI_TOK.acc) : (r.state ? UI_TOK.amber : UI_TOK.inkFaint)), flex: 'none',
        }, r.fb ? '←' : (r.state === 'following' ? '✓' : (r.state ? '·' : '?')));
        row.append(mark);
        row.append(el('span', {
          color: blk ? UI_TOK.red : UI_TOK.blue, flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }, r.name ? clip(r.name, 16) : '@' + r.handle));
        // v0.8.9 缝进这行的「拉黑」、v0.9.0 紧跟其后的「标杆」两颗，v0.11.3 按用户口径从名单里拿掉
        // （「去掉拉黑和标杆列」）。账本一个字没动：blockToggle / benchToggle 还是同一套 GM + kind=block/bench 记录，
        // 入口退回长在页面里的那几颗（名字行红徽标、主页「☆标此人」、页头「☆标此帖」）与右缘两扇窗口。
        // v0.8.13：名字右边这一行里根本没有那两个数，只有本机台账有 ⇒ 名单行尾给档位标签
        //（底色=档位、字=百分比）。v0.8.14 起没数的那一行不再是空着：给一枚灰「—」，点它不做事，
        // 但悬停写着「去悬停 TA 的头像一次就入库」—— 用户要的「列表展示完就能看到所有人」在这里的诚实形态
        // 是**一眼看清还差谁**，而不是编一个数出来。
        const frt = ratioInfo(r.handle);
        row.append(frt ? ratioChipEl(frt) : ratioNeedEl());
        const statusEl = el('span', { color: UI_TOK.red, flex: 'none', whiteSpace: 'nowrap' }, '');
        row.append(statusEl);
        row.addEventListener('click', (ev) => {
          // 行尾那枚比例签/状态格是 span，不吞这一下；真浏览器里点到自家 button 的事件会一路冒泡到行
          // ⇒ 认目标：命中按钮的这一下当行没被点（红线不许 stopPropagation，对事件动手的不做）。
          if (ev && ev.target && typeof ev.target.closest === 'function' && ev.target.closest('button')) return;
          if (!r.tweetId) { say(statusEl, r.fb ? '待回关：库里补的行，没有帖子可滚' : '这条没有帖子可滚'); return; }
          // 不再 renderFlist()：整棵重画会把面板自己的滚动位置抹掉（点完第 20 行跳回顶部），
          // 而点击之后唯一要改的口是这一行末尾与页脚那两句话 —— 就地写，不重建。
          if (!cardScrollTo(r.tweetId)) say(statusEl, cardNote);
          else say(statusEl, '');
        });
        root.append(row);
      });
    }
    root.append(foot);
    return root;
  }
  // v0.11.14 自动刷新：名单开着时节拍器（spaTick，1.2s）每拍对一遍「本页行」的指纹——虚拟列表把旧帖
  // 扔掉、新帖挂上来、关系钮翻面、桥推送来了，指纹一变就重画；没变一根手指都不动（不闪、不吃事件）。
  // 重画由 renderFlist 保住 scrollTop（见下），「点完第 20 行跳回顶部」的旧病根一并了账。
  let flistSigLast = '';
  function flistSigOf() {
    // 指纹只取「本页行」的成员与状态；比例签的档位也进去（悬停名片入库后 待补(n) 当场跟数）。
    // 库里补的待回行不进指纹：那本账由桥推送那条路（relRenderSoon）负责重画。
    return flistRows().map((r) => {
      const rt = ratioInfo(r.handle);
      return r.handle + ':' + r.state + ':' + (r.src || '') + ':' + (r.fb ? 1 : 0) + ':' + (r.name || '')
        + ':' + (rt ? (rt.stale ? 's' : rt.tier) : '-');
    }).join('|');
  }
  function flistTick() {
    if (!flistOpen || document.hidden) return;
    if (flistSigOf() === flistSigLast) return;
    renderFlist();
  }
  function renderFlist() {
    // 保滚动位置：整棵重画前记住 scrollTop，新的挂进 DOM 后原样还回去。面板里滚到第几行这件事
    // 归用户，自动刷新/推送重画/点行重画都不许把它抹掉（v0.11.14 起 flistTick 靠这条才敢自动重画）。
    const keep = flistRoot ? flistRoot.scrollTop : 0;
    if (flistRoot) flistRoot.remove();
    flistRoot = flistOpen ? flistBuild() : null;
    if (flistRoot) {
      document.documentElement.appendChild(flistRoot);
      try { if (keep) flistRoot.scrollTop = keep; } catch (e) { /* 桩里没有这口也无妨 */ }
      flistSigLast = flistSigOf();
    } else flistSigLast = '';
  }
  function toggleFlist() { flistOpen = !flistOpen; renderFlist(); }
  function flistBtn() { return document.getElementById(FBTN_ID); }

  // ---------- 拉黑名单（v0.8.4）----------
  // 用户点名的功能：昵称旁一颗「拉黑」，点了记进本机库，以后页面再见到这个名字就挂红「已拉黑」。
  // 口径当场说死：这只是**我方账本**（blocks 表），不动 X 的屏蔽/取关——那些要么要碰 X 的 API 越线，
  // 要么是「只建议不动作」红线管的动作。标记是给人看的：刷到他的帖子一眼认出来。
  // v0.8.9 改动的位置（账本没动）：那颗「昵称旁」的钮默认不插了，拉黑改从自家「本页用户」名单行尾按；
  // 下面 badgeGet/renderBlocks 那段写了为什么，用户真机反馈是起因。
  const BLOCK_KEY = 'ysy.xprobe.blocked';
  let blocked = {};
  try { blocked = GM_getValue(BLOCK_KEY, {}) || {}; } catch (e) { blocked = {}; }
  // 读穿（v0.9.4，真机 2026-10-27 实锤）：真机上 GM_getValue 读的是 host-shim 的内存缓存，这份缓存
  // 要等 chrome.storage.local 异步水合才有货 —— 而上面那行顶层起跑时水合必然还没回来，读到的永远是
  // 空账，且这是全脚本唯一一次读 ⇒ 每次刷新后 blocked={} 永不补读 ⇒ 库里明明落了账（ndjson 有
  // kind=block、blocks 表有行），页面徽标与「本页用户」行尾却全按未拉黑画。用户报的就是这个：
  // eater188888/2114978598516146582 评论列表拉黑后刷新不回显，日志里 0xbrotherwang 隔 36 秒两条 on:1
  // 正是「点了、刷新、没回显、又点了一遍」。自检照不进这条缝：桩的 GM 是同步对象，顶层一读就有货
  // （core 尾部 boot 那条注释自己都写了「自检沙箱的存储本来就是同步对象」）。
  // 并账口径与 benchFresh 同一条：只并缺的，不删有的 —— 别页刚标的人并进来，别把我这一页的现场抹掉。
  function blockFresh() {
    try {
      const cur = GM_getValue(BLOCK_KEY, {}) || {};
      Object.keys(cur).forEach((k) => { if (!blocked[k]) blocked[k] = cur[k]; });
    } catch (e) { /* 读不到就拿内存那份继续，写不进去也照样落库 */ }
    return blocked;
  }
  function isBlocked(h) { return !!blockFresh()[String(h || '').toLowerCase()]; }
  function blockToggle(h, name) {
    const k = String(h || '').toLowerCase();
    if (!k) return;
    // 再点一下已拉黑的徽标 = 取消。名单存两处：GM 存储（页面立刻认账）+ kind=block 记录（落库 blocks 表）。
    // 整键覆盖前先并一次账（blockFresh）：内存是「空账上长出来的」，不并就把别的会话/别的标签页
    // 刚标的整本抹掉 —— bench 那本第一天就带并账，这本 v0.9.4 才补上同一手艺。
    blockFresh();
    // v0.11.3：没给显示名时退回本机 users 台账（与 benchWrite 同一口径）——拉黑那本库里那行也不许只留个 @handle
    const bn = (userRowFor(k) || {}).name || '';
    if (blocked[k]) delete blocked[k]; else blocked[k] = { at: new Date().toISOString(), n: clip(name || bn, 120) };
    try { GM_setValue(BLOCK_KEY, blocked); } catch (e) { /* 存不进就本次会话内生效，记录照样发 */ }
    logRec('block', { handle: k, name: clip(name || bn, 120), on: blocked[k] ? 1 : 0 });
    renderBlocks(true);   // 用户刚点完：这一趟不许被限流挡掉（徽标颜色要当场翻）
  }

  // ---------- 标杆名单（v0.9.0）----------
  // 用户点名的两件事：① 「本页用户」名单行尾「拉黑」右边再加一颗「标杆」，点了进一个数据库；
  // ② 右缘再加一颗「标杆」钮，点开一个窗口按粉丝/曝光等排序、能加分类（投资、AI……）。
  // 与拉黑同一套纪律：这是**我方账本**（GM 的 bench + 本机库 benchmarks 表），不动 X 的屏蔽/关注、
  // 不发请求、不点任何东西。库里一事件一行（append-only），「现在在不在」由 bench_now 视图按最新一条判；
  // **改分类也是新落一行**（不覆盖历史）：「TA 哪天进的榜」和「哪天被我改成投资的」是两笔账。
  const BENCH_KEY = 'ysy.xprobe.bench';
  const BENCH_SORT_KEY = 'ysy.xprobe.benchSort';   // 上次选的那根排序轴：用户口径「打开即自动排好」= 记住它
  let bench = {};
  try { bench = GM_getValue(BENCH_KEY, {}) || {}; } catch (e) { bench = {}; }
  function benchFresh() {
    // 整键覆盖前重读一次，把别的标签页已经写进去的人并回来：GM 这一层是跨标签页共享的，
    // 「我这页的内存 + 我这页的一下」不该抹掉「你那页刚标的另一个人」（blocked 那本账的隐患，这本从第一天不带）。
    try {
      const cur = GM_getValue(BENCH_KEY, {}) || {};
      Object.keys(cur).forEach((k) => { if (!bench[k]) bench[k] = cur[k]; });
    } catch (e) { /* 读不到就拿内存那份继续，写不进去也照样落库 */ }
    return bench;
  }
  // 读穿（v0.9.4）：与 isBlocked 同一条晚水合缝 —— 顶层只读一次，刷新后内存空账 ⇒ 主页那颗胶囊
  // 明明标过却回 ☆。判账一律走 benchFresh()（并账式重读），别再直摸内存。
  //
  // v0.11.0 云端回显：云端模式下「谁在榜」以接口为准 —— 刷新页面后先问一次接口，云端在榜的人这一页也出「已标人」。
  // 本机台账仍是发件箱：还没推上去的那几笔照旧算在榜（本机台账 ∪ 云端名单，两端各说各的都算数）。
  // 接口没开/没登录时这层是空表，一切照旧走台账（本机模式行为零变化）。
  let benchCloudAc = {}, benchCloudPo = {}, benchCloudAt = 0, benchCloudBusy = false;
  const benchGoneAc = {}, benchGonePo = {};   // 本会话里刚移出的键：列表回包晚到时不许把它们又画回在榜
  function isBench(h) {
    const k = String(h || '').toLowerCase();
    return !!benchFresh()[k] || (!!benchCloudAc[k] && !benchGoneAc[k]);
  }
  // 云端名单全量拉一次（标杆账号 / 标杆帖子各一趟）：只读、不写水位、不动台账。
  // force=true 用在「刚点完标/撤」「刚打开窗口」这些需要当场对齐的时刻。
  function benchCloudHydrate(force) {
    if (benchCloudBusy) return Promise.resolve(false);
    if (!force && Date.now() - benchCloudAt < 120000) return Promise.resolve(false);
    benchCloudBusy = true;
    benchCloudAt = Date.now();
    const pull = (kind) => benchAskApi({ q: 'bench', kind: kind, size: 500 }).then((a) => (a && a.ok && Array.isArray(a.rows)) ? a.rows : null);
    return Promise.all([pull('ac'), pull('po')]).then((two) => {
      benchCloudBusy = false;
      const acRows = two[0], poRows = two[1];
      if (!acRows && !poRows) return false;   // 本机模式/这一档没登录/接口没回：这层保持原样
      if (acRows) {
        const m = {};
        acRows.forEach((r) => {
          const h = String((r && r.bizKey) || '').toLowerCase();
          if (h && Number(r.state) === 1 && !benchGoneAc[h]) {
            m[h] = { name: String(r.name || r.displayName || ''), tags: String(r.tags || ''), at: String(r.at || '') };
          }
        });
        benchCloudAc = m;
      }
      if (poRows) {
        const mp = {};
        poRows.forEach((r) => {
          const id = benchPCleanId(r && r.bizKey);
          if (id && Number(r.state) === 1 && !benchGonePo[id]) {
            mp[id] = { author: String(r.author || ''), tags: String(r.tags || ''), at: String(r.at || '') };
          }
        });
        benchCloudPo = mp;
      }
      // 页面上的两颗胶囊、名单行尾那颗、两张窗口都跟着重画（不新增任何网络请求）
      try { renderBlocks(true); } catch (e) { /* 渲染层自己保底 */ }
      if (benchOpen) fetchBench(false);
      if (benchPOpen) fetchBenchP(false);
      return true;
    });
  }
  // 标签的取值口径必须与库里 _tags() 一字不差（每个截 16 字、最多 8 个、逗号分隔、去重去空）——
  // 两头各拆一遍，面板显示的与库存的迟早对不上。
  function benchNormTags(v) {
    const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，;；\s]+/);
    const out = [];
    arr.forEach((x) => {
      // 这里不用 clip：clip 会补一个「…」，那跟库里 _txt(it, 16) 的纯截断就不是同一份字面了（面板显示的与库存的迟早对不上）
      const t = String(x == null ? '' : x).trim().replace(/^,+|,+$/g, '').slice(0, 16);
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out.slice(0, 8).join(',').slice(0, 120);
  }
  function benchTagsOf(h) {
    const k = String(h || '').toLowerCase();
    const r = bench[k];
    if (r && r.tags) return String(r.tags || '');
    const c = benchCloudAc[k];
    return c ? String(c.tags || '') : '';
  }
  function benchCount() {
    let n = Object.keys(bench).length;
    Object.keys(benchCloudAc).forEach((k) => { if (!bench[k] && !benchGoneAc[k]) n++; });
    return n;
  }
  function benchWrite(k, on, name, tags) {
    const cur = benchFresh();
    // v0.11.3：调用方没给显示名时，退回本机 users 台账（userRowFor 是读穿的那条）。
    // 以前这口径长在名单行尾那颗「标杆」上（它把行上的显示名带进来），那颗按用户口径删了 ⇒
    // 补名的责任落回写账这一层：主页那颗「☆标此人」以外的人（比如将来从文件导入）也不许在库里只留个 @handle。
    const u = userRowFor(k) || {};
    const nm = clip(name || (cur[k] && cur[k].n) || u.name || '', 120);
    const tg = benchNormTags(tags == null ? (cur[k] && cur[k].tags) : tags);
    if (on) cur[k] = { at: (cur[k] && cur[k].at) || new Date().toISOString(), n: nm, tags: tg };
    else delete cur[k];
    bench = cur;
    // 云端那一层也当场对齐（本机台账是发件箱，这一笔写没写进云端由 benchPushMark 底下那趟去兑现；
    // 回显需要的「现在在不在」先按用户的这一下算，接口失败会写进窗口顶上那行）
    if (on) { delete benchGoneAc[k]; benchCloudAc[k] = { name: nm, tags: tg, at: cur[k].at }; }
    else { benchGoneAc[k] = 1; delete benchCloudAc[k]; }
    try { GM_setValue(BENCH_KEY, bench); } catch (e) { /* 存不进就本次会话内生效，记录照样发 */ }
    logRec('bench', { handle: k, name: nm, on: on ? 1 : 0, tags: tg });
    // v0.11.0：云端模式里「点一下 = 当场写接口」。本机模式 SW 回 needLocal（一个字都不请求），
    // 台账那一笔照旧是发件箱 —— 补推那条腿（闹钟/落库触发）会按业务键收敛到同一行。
    const at = (bench[k] && bench[k].at) || new Date().toISOString();
    benchPushMark({
      kind: 'ac', bizKey: k, state: on ? 1 : 0, name: nm, tags: tg, at: at, day: at.slice(0, 10),
      fans: u.followers == null ? null : u.followers,
      fow: u.following == null ? null : u.following,
      postsN: benchLocalPosts(k),
      observedAt: u.updatedAt ? new Date(u.updatedAt).toISOString() : '',
    });
    return { on: !!on, name: nm, tags: tg };
  }
  function benchToggle(h, name) {
    const k = String(h || '').toLowerCase();
    if (!k) return null;
    // 按读穿后的账判（v0.11.0）：云端在榜、本机台账空着的人，这一下必须是「移出」而不是再标一遍
    return benchWrite(k, !isBench(k), name, null);
  }
  // 改分类：只在 TA 已经是标杆时写（「给一个不在名单上的人打分类」是用户没要的动作，别替他决定）。
  // 返回 null = 没写，由界面如实说「TA 不在标杆名单里」。
  function benchSetTags(h, tags, name) {
    const k = String(h || '').toLowerCase();
    if (!k || !bench[k]) return null;
    return benchWrite(k, true, name, tags);
  }
  // v0.11.3：名单行尾那颗「标杆」（benchBtnEl）连它的导出一起删了 —— 用户点名「去掉拉黑和标杆列」。
  // 账本与函数本体（benchToggle / benchWrite / GM bench / kind=bench 记录 / benchmarks 表）一个字没动，
  // 加/移的入口退回三处：个人主页昵称右边那颗「☆标此人」、帖子详情页头那颗「☆标此帖」（两者归 RL-16 的闸管，
  // 默认开），以及右缘「标杆」窗口里的改分类/看名单。**注意一条代价**：把那道闸拨到关，就没有任何地方能
  // 「加」标杆账号了（窗口只能改已有的人的分类）——这条如实写进 HISTORY/UIX，不是悄悄少一个口。
  // ---------- v0.9.1/v0.9.3 长在 X 的 DOM 里的两颗「标杆」文字胶囊 ----------
  // v0.9.1 用户点名：「可以在个人主页的昵称右侧加一个加入标杆，和移除标杆的图标」；
  // v0.9.3 追加：「给某个帖子也可以添加到标杆帖子，位置（帖子详情页页头「帖子」右边那块空白）清晰一点，
  //              之前的账号那个按钮不清晰，也需要一并改了」。两颗一起改 ⇒ 同一套字面档位、同一趟扫描、同一道闸。
  // 与名单行尾那颗不一样：**这两颗长在 X 的 DOM 里** ⇒ 归 RL-16 那道总闸管（GM `ysy.xprobe.badge`，v0.8.16 起默认开），
  // 关掉时与「拉黑」徽标一起被 badgeSweep() 摘干净、连我们补的那一笔 position 原样还回去（页面零痕迹）。
  // 借的全是徽标那套真机验证过的几何：绝对定位不参与布局、宽度先进预算再挑落点、宿主必须是「一行」的高度且
  // 绝不住进别人的可点元素里、老位置还空着就一个字都不写（粘住）。handle 认 URL 不认 DOM（那行有第三方胶囊的字）。
  //
  // 为什么不是一颗「☆」：单字形只说得出「星」，说不出「这是把人还是把帖加进哪本账」——用户嫌不清晰的正是这个。
  // 三档：整字面（4 字形）→ 短字面（2 字形）→ 不出并把缝宽写进账（RL-11）。
  // ⚠ 两种状态的**字形数必须相同**（☆标此人 / ★已标人 都 4 个字形）：点一下就变宽，会在下一趟判
  // 「老位置还空不空」时忽然压住旁边的字 —— 自己造抖动，v0.8.12 那条纪律就白立了。
  const BENCH_PILL = {
    prof: { full: ['☆标此人', '★已标人'], short: ['☆标', '★标'] },
    post: { full: ['☆标此帖', '★已标帖'], short: ['☆标', '★标'] },
  };
  // 每个字形按 16px 估（13px 等宽字里的 CJK/星号都吃不下更多），+6 = 左右内边距与边框的保守上界。
  // 宽度先进预算、再挑落点：挂好之后再塞字就是「超宽 ⇒ 压住旁边的字 ⇒ 下一趟判站不住 ⇒ 又搬」。
  function benchPillW(label) { return 16 * String(label == null ? '' : label).length + 6; }
  function benchPillLabel(kind, tier, on) {
    const L = BENCH_PILL[kind === 'post' ? 'post' : 'prof'];
    return L[tier === 'short' ? 'short' : 'full'][on ? 1 : 0];
  }
  const BENCH_BADGE_W = benchPillW(BENCH_PILL.prof.full[0]);   // 保留这一格：主页那颗整字面的宽度（口径见上）
  // ---------- v0.9.3 标杆帖子：台账（与标杆账号分家）----------
  // 两本账的主键天生不同（账号=handle / 帖子=tweet_id），塞进同一个对象迟早「123456」两边都认 ⇒ 分两个 GM 键。
  // 记录走 logRec('benchpost')：库里 bench_posts 一事件一行（append-only），进/出各留一行，
  // 「现在在不在」由 bench_posts_now 视图按最新一条判 —— 与 benchmarks 同一套账本形状。
  const BENCHP_KEY = 'ysy.xprobe.benchPost';
  const BENCHP_SORT_KEY = 'ysy.xprobe.benchPostSort';   // 上次选的那根轴（用户口径同账号窗口：打开即自动排好）
  let benchP = {};
  try { benchP = GM_getValue(BENCHP_KEY, {}) || {}; } catch (e) { benchP = {}; }
  function benchPFresh() {
    // 与 benchFresh 同一条理由：GM 跨标签页共享，整键覆盖前先把别页标过的帖并回来，别抹别人的账
    try {
      const cur = GM_getValue(BENCHP_KEY, {}) || {};
      Object.keys(cur).forEach((k) => { if (!benchP[k]) benchP[k] = cur[k]; });
    } catch (e) { /* 读不到就拿内存那份继续，写不进去也照样落库 */ }
    return benchP;
  }
  // id 只认数字（tweet_id 就是纯数字）：非数字一律当「没有这条帖子」，不落脏账。
  function benchPCleanId(v) { return String(v == null ? '' : v).replace(/\D/g, '').slice(0, 25); }
  function isBenchP(id) {
    const k = benchPCleanId(id);
    return !!benchPFresh()[k] || (!!benchCloudPo[k] && !benchGonePo[k]);
  }   // 读穿：理由同 isBench（晚水合）
  function benchPCount() {
    let n = Object.keys(benchP).length;
    Object.keys(benchCloudPo).forEach((k) => { if (!benchP[k] && !benchGonePo[k]) n++; });
    return n;
  }
  function benchPTagsOf(id) {
    const k = benchPCleanId(id);
    const r = benchP[k];
    if (r && r.tags) return String(r.tags || '');
    const c = benchCloudPo[k];
    return c ? String(c.tags || '') : '';
  }
  function benchPWrite(id, on, author, text, tags) {
    const k = benchPCleanId(id);
    if (!k) return null;                       // 认不出帖子 id：什么都不写，调用方按返回 null 如实说
    const cur = benchPFresh();
    const au = clip(String(author || '').replace(/^[@/]+/, ''), 60);
    // 正文是「按下的那一刻的快照」（库里 text 列）：折行压成空格、纯截断到 200（不用 clip：它会补「…」，
    // 与库里 _txt(v, 200) 的纯截断不是同一份字面）
    const tx = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 200);
    const tg = benchNormTags(tags == null ? (cur[k] && cur[k].tags) : tags);
    if (on) cur[k] = { at: (cur[k] && cur[k].at) || new Date().toISOString(), a: au, t: tx, tags: tg };
    else delete cur[k];
    benchP = cur;
    // 云端那一层当场对齐（同账号那条：台账是发件箱，回显按用户这一下算，失败写进窗口顶上那行）
    if (on) { delete benchGonePo[k]; benchCloudPo[k] = { author: au, tags: tg, at: cur[k].at }; }
    else { benchGonePo[k] = 1; delete benchCloudPo[k]; }
    try { GM_setValue(BENCHP_KEY, benchP); } catch (e) { /* 存不进就本次会话内生效，记录照样发 */ }
    logRec('benchpost', { id: k, author: au, text: tx, on: on ? 1 : 0, tags: tg });
    // v0.11.0：与账号那条同一条纪律 —— 点一下就写接口（本机模式 SW 回 needLocal，不请求）
    const p = posts[k] || {};
    const at = (benchP[k] && benchP[k].at) || new Date().toISOString();
    benchPushMark({
      kind: 'po', bizKey: k, state: on ? 1 : 0, author: au, text: tx, tags: tg, at: at, day: at.slice(0, 10),
      view: p.view == null ? null : p.view, reply: p.reply == null ? null : p.reply,
      like: p.like == null ? null : p.like, eng: p.eng == null ? null : p.eng,
      timeDatetime: p.timeISO || '',
      observedAt: p.seenAt ? new Date(p.seenAt).toISOString() : '',
    });
    return { on: !!on, id: k, author: au, text: tx, tags: tg };
  }
  function benchPToggle(id, author, text) {
    const k = benchPCleanId(id);
    if (!k) return null;
    const p = posts[k] || {};
    // 正文三级退让：调用方给的 > 台账里的 > 详情页现读（benchPostTextSnap 自己认页型，列表页不出手）
    // 开关按读穿后的账判（v0.9.4 台账 / v0.11.0 再加云端那层）：空账或只在云端在榜时，「已标帖」不许被再标一遍
    return benchPWrite(k, !isBenchP(k), author || p.handle || '', text || p.text || benchPostTextSnap() || '');
  }
  // URL ⇒ 这条详情页的主帖 id（只认 /status/<数字> 后面是末尾或斜杠的：/status/123/photos/1 也算同一条帖）
  function statusIdFromPath(pathname) {
    const m = /\/status\/(\d{3,25})(?:\/|$)/.exec(String(pathname || ''));
    return m ? m[1] : '';
  }
  // 正文快照：本机 posts 台账优先（采集器扫过就有，且已经是干净字面），没有再现读页面第一条 article 的
  // tweetText —— 纯只读，读不到就留空（库里那行 text 空着 = 「按的时候没抓到正文」，比编一段像样的字强）。
  // 只在帖子详情页读：列表页第一条 article 是别人的帖，拿来当正文就是编。
  function benchPostTextSnap() {
    if (tabName() !== 'tweet') return '';
    try {
      const a = document.querySelector('article');
      if (!a) return '';
      const n = a.querySelector('[data-testid="tweetText"]');
      return n ? nativeText(n) : '';
    } catch (e) { return ''; }
  }
  function benchProfileRow() {
    if (tabName() !== 'profile') return null;                        // 只在个人主页出这一颗
    const h = normHandle(handleFromPath(location.pathname));
    if (!h) return null;
    let box = null;
    try { box = document.querySelector('[data-testid="UserName"]'); } catch (e) { return null; }
    if (!box) return null;
    // 名字那一行 = UserName 里第一个带 dir 的块（真机：名字行在前、@handle 行在后；不认 class，只认这个结构）
    let line = null;
    try { line = box.querySelector('[dir]'); } catch (e) { line = null; }
    // 读名字走 nativeText，不走 txt：这一颗就挂在这个盒子里，粘住那一趟重画时 DOM 里已经带着上一趟的「☆标此人」，
    // txt() 把它们读回 data-n ⇒ 下次点它落账的名字是「活力男★」（v0.8.5 五把徽标缝进 UserCell 后踩过同一口）
    return { h: h, box: box, ref: line || box, name: clip(nativeText(line || box), 140) };
  }
  // 帖子详情页页头那一层怎么找（真机转储实锤，别照 DOM 缩进猜）：`[data-testid="app-bar-back"]` 与那个 h2
  // **不是兄弟**——同一份 tree.txt 里两者印出的「跳过N层」差着一层，所以从返回钮往上爬，第一个「里面还坐着 h2」
  // 的祖先才是页头那一行（爬不到就算没有，绝不拿 document 的 h2 冒充）。
  // ⚠ app-bar-back 不是详情页专属：个人主页头部同样有它，只是那里的 h2 写的是人名 ⇒ 闸门只能是 tabName()==='tweet'。
  function benchPostRow() {
    if (tabName() !== 'tweet') return null;                          // 只在帖子详情页出这一颗
    const id = benchPCleanId(statusIdFromPath(location.pathname));
    if (!id) return null;
    let back = null;
    try { back = document.querySelector('[data-testid="app-bar-back"]'); } catch (e) { return null; }
    if (!back) return null;
    let box = null, h2 = null, up = back.parentNode, hops = 0;
    while (up && hops++ <= BADGE_HOST_UP) {
      let q = null;
      try { q = up.querySelector('h2'); } catch (e) { q = null; }
      if (q) { box = up; h2 = q; break; }
      up = up.parentNode;
    }
    if (!box || !h2) return null;
    const p = posts[id] || {};
    // 作者认 URL 不认 DOM（页头那一行根本没有作者），退本机台账；正文两条腿：台账优先、页面现读兜底
    const au = String(p.handle || handleFromPath(location.pathname) || '').replace(/^[@/]+/, '');
    return { id: id, box: box, ref: h2, name: au, text: String(p.text || benchPostTextSnap() || '') };
  }
  function benchBadgeTip(h, on) {
    const tg = benchTagsOf(h);
    return (on ? '@' + h + ' 在标杆名单里' + (tg ? '（分类：' + clip(tg, 40) + '）' : '（还没打分类）') + '，点一下移除'
      : '把 @' + h + ' 加进标杆名单（只记账：本机台账 + 落库 benchmarks 表，不动 X 的任何东西）')
      + '；分类在右缘「标杆」窗口里改';
  }
  // 这一颗的说明书（这颗长在页面上，读 title 就是它的全部口径）：说清标的是**这条帖**、落的是哪本账、
  // 以及它跟「标此人」不是一回事（用户点名的「和之前的标杆账号如何区分开」）。
  function benchPTip(id, on, author) {
    const tg = benchPTagsOf(id);
    const who = (author ? '@' + author + ' ' : '') + '#' + id;
    return (on ? who + ' 已在标杆帖子里' + (tg ? '（分类：' + clip(tg, 40) + '）' : '（还没打分类）') + '，点一下移出'
      : '把这条帖 ' + who + ' 记进标杆帖子（只记账：本机台账 + 落库 bench_posts 表，不动 X 的任何东西）')
      + '；这是**帖子**的账，与右缘「标杆」窗口的**账号**名单是两本（那边按人、这边按条）；'
      + '排序在右缘「标帖」窗口里点，分类下一轮加';
  }
  // 只改这颗自己的字面与颜色，不重摆、不碰页面（点了当场翻色 = 用户要的「加入/移除」看得见结果）。
  // v0.9.3：一颗函数管两种胶囊（prof=标此人 / post=标此帖）——落账走各自那条路，kind 记在 data-bk 上，
  // 点击回调只读**这颗自己身上**的记号，不靠闭包里那一趟的临时变量（挂错账比不挂更糟）。
  function benchBadgePaint(n, kind, key, nameTxt, on, tier) {
    try {
      let b = n.children[0];
      if (!b) {
        b = el('button', {
          background: 'transparent', border: '1px solid ' + UI_TOK.line, borderRadius: '6px', cursor: 'pointer',
          font: 'inherit', padding: '0 5px', lineHeight: '15px',
        });
        b.type = 'button';
        b.addEventListener('click', () => {
          const k = n.getAttribute('data-h') || '';
          const bk = n.getAttribute('data-bk') === 'post' ? 'post' : 'prof';
          const nm = n.getAttribute('data-n') || '';
          if (bk === 'post') benchPToggle(k, nm, '');            // 正文留给 benchPToggle 从台账/页面自己补
          else benchToggle(k, (userRowFor(k) || {}).name || nm);
          const on2 = bk === 'post' ? isBenchP(k) : isBench(k);
          benchBadgePaint(n, bk, k, nm, on2, n.getAttribute('data-l') || 'full');
          renderFlist();                       // 名单开着就一起翻色（自家面板，不碰页面）
          if (benchOpen) fetchBench(true);     // 窗口开着：账变了就重取一遍
          if (benchPOpen) fetchBenchP(true);
        });
        n.textContent = '';
        n.append(b);
      }
      n.style.font = '13px ui-monospace, Consolas, monospace';
      b.textContent = benchPillLabel(kind, tier, on);
      b.style.color = on ? UI_TOK.acc : UI_TOK.inkDim;
      b.style.borderColor = on ? UI_TOK.accDim : UI_TOK.line;   // 已标那态边框也转绿：胶囊比单颗星要能一眼分出「进没进」
      b.title = kind === 'post' ? benchPTip(key, on, nameTxt) : benchBadgeTip(key, on);
      n.setAttribute('data-h', key);
      n.setAttribute('data-bk', kind === 'post' ? 'post' : 'prof');
      n.setAttribute('data-n', nameTxt);
      n.setAttribute('data-l', tier === 'short' ? 'short' : 'full');
      n.setAttribute('data-f', on ? '1' : '0');
    } catch (e) { /* 写不进去下一趟再来（这颗是显示件，账在 GM 与库里，掉了不丢数据） */ }
  }
  // 两颗胶囊各记各的账（面板「性能账」里是两格：主页星 / 页头星）。写成对象而不是散在两处的字面量，
  // 是为了下面那一条通用摆法能同一套代码走两种——复制一遍粘住/重摆的判据，迟早只改一处。
  const BENCH_ACC_PROF = { ok: 'benchBadge', no: 'benchBadgeNo', why: 'benchBadgeWhy' };
  const BENCH_ACC_POST = { ok: 'benchPBadge', no: 'benchPBadgeNo', why: 'benchPBadgeWhy' };
  function benchBadgeFail(why) { benchPillFail(BENCH_ACC_PROF, why); }   // 保留这一格：老口径（v0.9.1 那一颗）
  function benchPillZero(acc) { perf[acc.ok] = 0; perf[acc.no] = 0; perf[acc.why] = ''; }
  function benchPillFail(acc, why) { perf[acc.ok] = 0; perf[acc.no] = 1; perf[acc.why] = why; }
  // 宽度先进预算：整字面装得下就用整字面，退一档看短字面，两档都塞不进就一颗不出（并带缝宽说清为什么）。
  // 绝不「先挂好再缩字」——那是把超宽的那一帧留给页面，下一趟判站不住又搬。
  function benchPillFit(acc, kind, box, refEl) {
    const wf = benchPillW(BENCH_PILL[kind === 'post' ? 'post' : 'prof'].full[0]);
    const ws = benchPillW(BENCH_PILL[kind === 'post' ? 'post' : 'prof'].short[0]);
    const f1 = badgeFit(box, refEl, wf);
    if (f1.form === 'full') return { tier: 'full', place: f1, w: wf };
    const f2 = badgeFit(box, refEl, ws);
    if (f2.form === 'full') return { tier: 'short', place: f2, w: ws };
    benchPillFail(acc, (kind === 'post' ? '页头标题右边' : '昵称右边') + '那条空白放不下这一颗'
      + '（最宽的缝 ' + Math.round(f2.gap) + 'px < 短字面要 ' + ws + 'px）');
    return null;
  }
  // 一颗胶囊的完整摆法（v0.9.3 把 v0.9.1 那一颗的判据抽成通用的一条，两种胶囊共用）：
  // 认领旧节点 → 还是同一个目标 + 老宿主抱得住 + 老位置仍完整躺在某条缝里 ⇒ 只翻色、坐标一个字不写；
  // 否则摘了重摆。换页/换人/闸关都走这条路，该摘就摘、该说就说（RL-11 不许静默）。
  function benchPillStep(cur, t, kind, acc) {
    const isPost = kind === 'post';
    if (!t) {
      if (cur) { try { cur.remove(); } catch (e) { /* 已被 React 摘掉 */ } }
      // 不是这一页（标人那颗跑到帖子页 / 标帖那颗跑到主页）：账归零，别把上一趟的「出 1」留成假账
      if (tabName() !== (isPost ? 'tweet' : 'profile')) benchPillZero(acc);
      else benchPillFail(acc, isPost ? '这一页没找到页头那一行（X 改版了？）' : '这一页没找到昵称那一行（X 改版了？）');
      return;
    }
    const key = isPost ? t.id : t.h;
    const on = isPost ? isBenchP(key) : isBench(key);
    const rr = geoRect(t.ref);
    if (cur && rr) {
      const host0 = cur.parentNode;
      const hr0 = badgeHostOk(host0, t.ref, t.ref);
      const nr = hr0 ? geoRect(cur) : null;
      const tier0 = cur.getAttribute('data-l') || 'full';
      // 粘住：还是这个人/这条帖、同一个族（data-bk）、老宿主仍然抱得住这一行、老位置仍然完整躺在某条缝里
      // ⇒ 这一趟对它一个字都不写。v0.9.3 多比两条：data-bk（别把标帖那颗认成标人那颗）与 data-l ——
      // 档位变了 = 宽度要变 = 就地改字会压住旁边的字，所以换档必须走下面「摘了重摆」那条路，不算粘住。
      if (hr0 && nr && (cur.getAttribute('data-h') || '') === key
        && (cur.getAttribute('data-bk') || 'prof') === kind && badgeEnsureHost(host0)
        && badgeInGap(badgeGaps(host0, t.ref, rr, hr0), nr.left, nr.right)) {
        benchPillZero(acc); perf[acc.ok] = 1;
        if ((cur.getAttribute('data-f') || '0') !== (on ? '1' : '0')) benchBadgePaint(cur, kind, key, t.name, on, tier0);
        return;
      }
    }
    if (cur) { try { cur.remove(); } catch (e) { /* 已被 React 摘掉 */ } }   // 换人了/站不住了：老那颗当场摘，不等下一趟
    const hr = badgeHostOk(t.box, t.ref, t.ref);
    if (!hr) { benchPillFail(acc, (isPost ? '页头标题那一层' : '昵称那一层') + '挂不住（不是行高，或住在 X 的可点元素里）'); return; }
    if (!rr) { benchPillFail(acc, isPost ? '量不到页头标题那一行的几何' : '量不到昵称那一行的几何'); return; }
    const fit = benchPillFit(acc, kind, t.box, t.ref);
    if (!fit) return;
    if (!badgeEnsureHost(t.box)) { benchPillFail(acc, '宿主补不上定位'); return; }
    const n = el('span');
    n.setAttribute('class', BENCH_BADGE_CLS);
    n.setAttribute('data-xprobe', 'bench');
    n.setAttribute('data-bk', kind);
    try { t.box.append(n); } catch (e) { benchPillFail(acc, '挂不上宿主'); return; }
    if (!badgePlace(n, t.box, fit.place, rr, hr)) {
      try { n.remove(); } catch (e) { /* 摘不掉就算了，下一趟的孤儿账会收 */ }
      benchPillFail(acc, '写坐标失败'); return;
    }
    benchBadgePaint(n, kind, key, t.name, on, fit.tier);
    benchPillZero(acc); perf[acc.ok] = 1;
  }
  // 一趟一枪、两种胶囊各认领自己那一颗：整页仍然只跑**一次** querySelectorAll（v0.9.1 为标星立的规矩，
  // v0.9.3 加第二颗不开第二次整文档扫描）。data-bk 缺省 = v0.9.1 留在页面里的旧那颗 = 标人。
  function benchBadgeScan() {
    let curProf = null, curPost = null;
    try {
      document.querySelectorAll('[data-xprobe="bench"]').forEach((x) => {
        const isP = (x.getAttribute('data-bk') || 'prof') === 'post';
        if (isP) { if (curPost) { try { x.remove(); } catch (e) { /* React 已摘 */ } } else curPost = x; }
        else { if (curProf) { try { x.remove(); } catch (e) { /* React 已摘 */ } } else curProf = x; }
      });
    } catch (e) { /* 选择器抛了就下一趟再摘 */ }
    benchPillStep(curProf, benchProfileRow(), 'prof', BENCH_ACC_PROF);
    benchPillStep(curPost, benchPostRow(), 'post', BENCH_ACC_POST);
  }
  // ---------- 右缘「标杆」窗口（v0.9.0）----------
  // 用户原话：「再在右下角 添加一个按钮，叫标杆，点开后会打开一个窗口，按照粉丝，曝光，等等进行排序，
  // 也可以自动排序，还可以加分类修改分类」。四问四答定下的口径，逐条都是他自己点的：
  // ① 「自动排序」= **打开即自动排好**（记住上次选的那根轴，不要求综合评分、也不按加入时间兜底）；
  // ② 分类这一轮**只要能打标签、先不做分类页签切换**；
  // ③ 取数「**台账 + 本机库都读，库优先**」——库取不到就如实说，缺的那几格退本机台账，两头都没有就是「—」；
  // ④ 点某一行 = **像抽屉一样在下方展开 TA 的帖子**，可按曝光/评论/时间筛。
  // 窗口本体是 position:fixed 挂 documentElement 的自家 UI（与名单/卡片同款）⇒ 不参与 X 的布局、
  // 不受 RL-16 那道「往 X 的 DOM 里缝东西」的总闸管。点行只开合我们自己的抽屉：**不滚页面、不导航、
  // 不发对 X 的请求**（数全从本机库经 SW 的 dbq 白名单来，抽屉吃现成的 author_posts，一条新查询都不加）。
  const BENCH_W = 300;
  const BENCH_FLIST_W = 268;     // 「本页用户」名单(260) + 8px 缝：两张面板都要在右缘时，标杆往左让一档，不叠
  const BENCH_DB_LIMIT = 200;    // 一次问库要多少人（SW 那边把 limit 夹在 1..500）
  const BENCH_POSTS_LIMIT = 30;  // 抽屉里一个人列几条帖子
  const BENCH_SORTS = [['fans', '粉丝'], ['fow', '关注'], ['views', '曝光'], ['eng', '互动'],
    ['postsN', '帖数'], ['at', '加入']];
  const BENCH_PSORTS = [['view', '曝光'], ['reply', '评论'], ['at', '时间']];
  const BENCH_PWINS = [['all', '全部'], ['1d', '1天'], ['7d', '7天'], ['30d', '30天']];
  let benchOpen = false;
  let benchRoot = null;
  let benchData = null;          // { loading, err, rows }：库那一份（bench_accounts），开窗口就取、「刷」重取
  let benchPosts = {};           // handle -> { loading, err, rows }：抽屉，只存点过的（是账，不是画面）
  let benchExpand = {};          // handle -> true：哪几行的抽屉开着
  let benchDragged = false;      // 用户拖过 ⇒ 位置归他，不再自动让位（与名单同一判据）
  let benchPos = { r: 14, b: 334 };
  let benchSortNow = 'fans';
  let benchWin = 'all';
  let benchPSort = 'view';
  try { benchSortNow = String(GM_getValue(BENCH_SORT_KEY, 'fans') || 'fans'); } catch (e) { benchSortNow = 'fans'; }
  if (!BENCH_SORTS.some((s) => s[0] === benchSortNow)) benchSortNow = 'fans';
  function benchSortSet(k) {
    benchSortNow = k;
    try { GM_setValue(BENCH_SORT_KEY, k); } catch (e) { /* 记不住就本次会话内记住，下次开按默认 */ }
  }
  function benchRightPx() { return 14 + (flistOpen && !flistDragged ? BENCH_FLIST_W : 0); }
  function benchBottomPx() { return flistBottomPx(); }   // 与名单同一档：都锚在钮排之上
  // 数字显示：**null ⇒「—」（本机没这个数）与 0 ⇒「0」（真有这个数、就是零）必须分成两个字面**。
  // 把缺数写成 0 会被读成「这人粉丝是 0」，排序时也会把他塞进「最少的那一档」——正是 RL-11 禁的那类假账。
  function benchNum(v) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (!isFinite(n)) return '—';
    if (Math.abs(n) >= 10000) return Math.round(n / 1000) / 10 + '万';
    return String(n);
  }
  // 台账里有没有 TA 的帖子（库没回话/没这个人时的唯一兜底腿）：posts 表按 tweetId 存，只能按 handle 数一遍。
  // 数不出「零条帖子」这件事 —— 台账里一条没有就是「我不知道」，所以 0 回 null，不回 0。
  function benchLocalPosts(h) {
    let n = 0;
    try {
      Object.keys(posts).forEach((k) => {
        if (String((posts[k] || {}).handle || '').toLowerCase() === h) n++;
      });
    } catch (e) { return null; }
    return n || null;
  }
  function benchMerge() {
    const out = [];
    const by = {};
    const dbRows = benchData && Array.isArray(benchData.rows) ? benchData.rows : [];
    const put = (r) => { if (r.handle && !by[r.handle]) { by[r.handle] = r; out.push(r); } };
    dbRows.forEach((raw) => {
      const h = String(raw.handle || '').toLowerCase();
      if (!h) return;
      // 本会话刚移出、接口回包还带着 TA（那一枪还没落地/回了旧账）：不画回名单
      if (benchGoneAc[h]) return;
      const u = userRowFor(h) || {};
      const g = bench[h] || null;
      const lp = benchLocalPosts(h);
      const db = { fans: raw.fans, fow: raw.fow, views: raw.views, eng: raw.eng, postsN: raw.posts_n };
      const led = { fans: u.followers, fow: u.following, views: null, eng: null, postsN: lp };
      const rec = {
        handle: h,
        // 名字/分类：本机台账（GM）是「我刚敲下去的那一笔」，库是「已经落账的那一笔」⇒ 台账优先，
        // 没在台账里的人（别的标签页/老版本标的）用库的。两头都没就空着，不拿 handle 冒充显示名。
        name: String((g && g.n) || raw.name || u.name || ''),
        tags: benchNormTags(g ? g.tags : raw.tags),
        markedAt: String(raw.marked_at || (g && g.at) || ''),
        relation: String(raw.relation || u.relation || ''),
        blocked: raw.blocked == null ? (isBlocked(h) ? 1 : 0) : raw.blocked,
        db: 0, led: 0, miss: 0, inLedger: !!g,
      };
      ['fans', 'fow', 'views', 'eng', 'postsN'].forEach((k) => {
        if (db[k] != null) { rec[k] = db[k]; rec.db++; }
        else if (led[k] != null) { rec[k] = led[k]; rec.led++; }
        else { rec[k] = null; rec.miss++; }
      });
      rec.src = rec.db ? '库' : (rec.led ? '台账' : '');
      put(rec);
    });
    // 刚标完、还没 flush 进库的人（以及库里根本没这个 handle 的人）：从台账出这一行，数缺就缺。
    Object.keys(bench).forEach((h) => {
      if (by[h]) return;
      const u = userRowFor(h) || {};
      const rec = {
        handle: h, name: String(bench[h].n || u.name || ''), tags: benchNormTags(bench[h].tags),
        markedAt: String(bench[h].at || ''), relation: String(u.relation || ''),
        blocked: isBlocked(h) ? 1 : 0,
        fans: u.followers == null ? null : u.followers, fow: u.following == null ? null : u.following,
        views: null, eng: null, postsN: benchLocalPosts(h),
        db: 0, led: 0, miss: 0, inLedger: true, src: '台账',
      };
      ['fans', 'fow', 'views', 'eng', 'postsN'].forEach((k) => {
        if (rec[k] != null) rec.led++; else rec.miss++;
      });
      if (!rec.led) rec.src = '';
      put(rec);
    });
    return out;
  }
  function benchVal(r, k) { return k === 'at' ? r.markedAt : r[k]; }
  // 排序：所选轴**降序**（越大越前），缺数的人一律垫底、且垫底那一段按 handle 升序（0 是真数、不算缺数）。
  // 这是「打开即自动排好」的实现：轴存在 GM（BENCH_SORT_KEY），窗口一开就照它排，不需要用户再点一下。
  function benchSorted(rows) {
    const k = benchSortNow;
    return rows.slice().sort((a, b) => {
      const va = benchVal(a, k), vb = benchVal(b, k);
      const na = va == null || va === '', nb = vb == null || vb === '';
      if (na && nb) return a.handle < b.handle ? -1 : (a.handle > b.handle ? 1 : 0);
      if (na) return 1;
      if (nb) return -1;
      if (k === 'at') return va < vb ? 1 : (va > vb ? -1 : (a.handle < b.handle ? -1 : 1));
      return (vb - va) || (a.handle < b.handle ? -1 : (a.handle > b.handle ? 1 : 0));
    });
  }
  // 一条帖子的「发帖时刻」= 库里 time_datetime（页面 `<time datetime>` 的原文，UTC 带 Z；真库 27616 条里
  // 27609 条有）。**认不出来就回空串，绝不退回 first_at/last_at**：那两个是「我们扫到它的时刻」，同一趟扫描
  // 采到的一屏帖子会是同一个分钟——用户截图里「时间全是 10-27 08:36」就是这么来的，拿它冒充发帖时间就是假账。
  function benchPostPub(p) {
    const s = String((p || {}).time_datetime || '');
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s : '';
  }
  // 时刻字面 ⇒ 毫秒。带时区标记的原样解；不带的**按 UTC 解**（库里全是 UTC 字面，若交给 Date 默认按本地解
  // 会凭空差 8 小时）。解不出来给 NaN，让调用方自己决定怎么交代。
  function benchPostMs(iso) {
    const s = String(iso || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return NaN;
    const t = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(s) ? s : s + 'Z').getTime();
    return isFinite(t) ? t : NaN;
  }
  // 抽屉那一份：时间窗按**发帖时刻**算「几天前」（v0.9.2；以前按 last_at，刚扫过的一屏全落在同一分钟，
  // 「1天/7天/30天」三档一点区分力都没有）。没读到发帖时刻的 -1 ⇒ 任何非「全部」的窗都不进，不拿「不知道」冒充最近。
  function benchPostDays(iso) {
    const t = benchPostMs(iso);
    if (!isFinite(t)) return -1;
    return Math.floor((Date.now() - t) / 86400000);
  }
  function benchPostsOf(h) {
    const box = benchPosts[h];
    if (!box || !Array.isArray(box.rows)) return [];
    const lim = benchWin === '1d' ? 1 : (benchWin === '7d' ? 7 : (benchWin === '30d' ? 30 : -1));
    const rows = box.rows.filter((p) => {
      if (lim < 0) return true;
      const d = benchPostDays(benchPostPub(p));
      return d >= 0 && d <= lim;
    });
    const key = benchPSort === 'reply' ? 'reply' : (benchPSort === 'at' ? 'pub' : 'view');
    const val = (p) => (key === 'pub' ? benchPostPub(p) : p[key]);
    return rows.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      const na = va == null || va === '', nb = vb == null || vb === '';
      if (na && nb) return a.tweet_id < b.tweet_id ? -1 : 1;
      if (na) return 1;
      if (nb) return -1;
      if (key === 'pub') return (benchPostMs(vb) - benchPostMs(va)) || (a.tweet_id < b.tweet_id ? -1 : 1);
      return (vb - va) || (a.tweet_id < b.tweet_id ? -1 : 1);
    });
  }
  // ---------- v0.11.0 云端模式：标杆的读与写都先走接口 ----------
  // 目标/红线：云端模式（设置里「运行模式」打开且这一档登录了）= 唯一写者是对面那台 boot4，
  // 本机库只剩「发件箱 + 只读缓存」两种身份。所以这里每一处读先问接口，接口说「本机模式/没登录」
  // （needLocal）才退回本机库；接口这一跳没成要如实记下来，不许拿本机缓存冒充云端结果。
  function benchAskApi(msg, ms) {
    return new Promise((resolve) => {
      let done = false, timer = null;
      const fin = (v) => { if (!done) { done = true; if (timer !== null) clearTimeout(timer); resolve(v); } };
      timer = setTimeout(() => fin({ ok: false, err: '接口 ' + Math.round((ms || 12000) / 1000) + ' 秒没回（SW 卡住 / 宿主没起？）' }), ms || 12000);
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') { fin({ needLocal: true }); return; }
        chrome.runtime.sendMessage(Object.assign({ t: 'benchQuery' }, msg), (r) => {
          if (chrome.runtime.lastError) { /* 扩展刚重载/旧版 SW 不认这条：消音，按本机模式退回 */ }
          fin(r || { needLocal: true });
        });
      } catch (e) { fin({ needLocal: true }); }
    });
  }
  function benchMarkApi(body) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') { resolve({ needLocal: true }); return; }
        chrome.runtime.sendMessage(Object.assign({ t: 'benchMark' }, body), (r) => {
          if (chrome.runtime.lastError) { /* 同上：旧版 SW 就当本机模式 */ }
          resolve(r || { needLocal: true });
        });
      } catch (e) { resolve({ needLocal: true }); }
    });
  }
  // 接口行的列名与本机两条 SQL 对齐（bench_accounts / bench_post_rows / author_posts），
  // 下面那一串 render/merge 一个字都不用改。数缺就是 null（RL-11：不拿 0 冒充「没有数」）。
  function benchAcRowFromApi(r) {
    return {
      handle: String((r && (r.bizKey || r.handle)) || '').toLowerCase(),
      name: String((r && (r.displayName || r.name)) || ''),
      tags: String((r && r.tags) || ''),
      marked_at: String((r && r.at) || ''),
      fans: r && r.fans, fow: r && r.fow, posts_n: r && r.postsN,
      views: r && r.views, eng: r && r.eng,
      last_post_at: r && r.lastPostAt, relation: String((r && r.relation) || ''),
      blocked: r && r.blocked == null ? null : r.blocked,
    };
  }
  function benchPoRowFromApi(r) {
    return {
      tweet_id: String((r && (r.bizKey || r.tweetId)) || ''),
      author: String((r && r.author) || ''),
      marked_text: String((r && r.text) || ''),
      tags: String((r && r.tags) || ''),
      marked_at: String((r && r.at) || ''),
      view: r && r.view, reply: r && r.reply, like: r && r.like, eng: r && r.eng,
      time_datetime: String((r && r.timeDatetime) || ''),
      points: null,
    };
  }
  // 接口写失败了写在哪：标杆窗口、标帖窗口顶上那一行（开着就立刻重画）。台账那一笔已经落了，
  // 所以这次失败不会丢 —— 补推那条腿（SW 的闹钟 + 落库触发）会把它再推一次。
  function benchApiFail(msg) {
    const t = '接口没写进去：' + msg + '（台账已记，失败会按设置的间隔自动补推）';
    benchNote = t;
    benchPNote = t;
    if (benchOpen) renderBench();
    if (benchPOpen) renderBenchP();
  }
  function benchPushMark(msg) {
    benchMarkApi(msg).then((r) => {
      if (!r || r.ok) return;
      if (r.needLocal) return;          // 本机模式/这一档没登录：本来就不该进云，台账照旧
      perf.benchFail++;
      benchApiFail(clip(String(r.err || '未知原因'), 100));
    });
  }
  function fetchBench(force) {
    if (!force && benchData && !benchData.loading && !benchData.err) { renderBench(); return; }
    benchData = { loading: true, rows: null, err: '', src: '', note: '' };
    renderBench();
    perf.benchAsk++;
    // 先问接口：云端模式下一台机器标的人，另一台也要看得见（以前这窗只读本机库，换机就「少了半本账」）
    benchAskApi({ q: 'bench', kind: 'ac', size: BENCH_DB_LIMIT }).then((a) => {
      if (!benchOpen) return;                    // 等待期间窗口关了：回包丢掉，不给一棵已经不存在的树画东西
      if (a && a.ok && Array.isArray(a.rows)) {
        benchData.loading = false;
        benchData.src = 'api';
        benchData.rows = a.rows.map(benchAcRowFromApi).filter((x) => x.handle);
        renderBench();
        return;
      }
      // 接口没回话 / 没登录之外的原因（没开云端模式是正常的 needLocal）：先记下来，再退回本机缓存
      if (a && a.ok === false && !a.needLocal) {
        benchData.note = '接口没回话（' + clip(String(a.err || '未知原因'), 80) + '），这一眼读本机缓存，可能不是最新';
        perf.benchFail++;
      }
      dbAsk({ t: 'dbq', q: 'bench_accounts', limit: BENCH_DB_LIMIT }).then((r) => {
        if (!benchOpen) return;
        benchData.loading = false;
        benchData.src = 'local';
        if (!r) { benchData.err = '本机库也没回话（宿主/sink 起来了吗？）'; perf.benchFail++; }
        else if (r.ok === false) { benchData.err = '本机库拒了：' + clip(String(r.err || '未知原因'), 80); perf.benchFail++; }
        else if (!Array.isArray(r.rows)) { benchData.err = '回包没有 rows（库/sink 版本旧？重启一次 start-sink 再看）'; perf.benchFail++; }
        else benchData.rows = r.rows;
        renderBench();
      });
    });
  }
  function fetchBenchPosts(h) {
    const k = String(h || '').toLowerCase();
    if (!k || benchPosts[k]) return;
    if (!/^[A-Za-z0-9_]{1,20}$/.test(k)) {
      // handle 里有库不认的字符（真机见过带符号的脏值）：库会 400，我这边当场说清楚，不递过去让它猜
      benchPosts[k] = { loading: false, rows: null, err: '这个 handle 的字符库不认（只收 1~20 位字母数字下划线），不替你猜' };
      renderBench();
      return;
    }
    benchPosts[k] = { loading: true, rows: null, err: '', note: '', src: '' };
    renderBench();
    perf.benchAsk++;
    benchAskApi({ q: 'posts', author: k, size: BENCH_POSTS_LIMIT }).then((a) => {
      const box = benchPosts[k];
      if (!box) return;
      if (a && a.ok && Array.isArray(a.rows)) {
        box.loading = false; box.src = 'api'; box.rows = a.rows;
        renderBench();
        return;
      }
      if (a && a.ok === false && !a.needLocal) {
        box.note = '接口没回话（' + clip(String(a.err || '未知原因'), 80) + '），这一眼读本机缓存';
        perf.benchFail++;
      }
      dbAsk({ t: 'dbq', q: 'author_posts', author: k, limit: BENCH_POSTS_LIMIT }).then((r) => {
        const b2 = benchPosts[k];
        if (!b2) return;
        b2.loading = false; b2.src = 'local';
        if (!r) { b2.err = '本机库也没回话（宿主/sink 起来了吗？）'; perf.benchFail++; }
        else if (r.ok === false) { b2.err = '本机库拒了：' + clip(String(r.err || '未知原因'), 80); perf.benchFail++; }
        else if (!Array.isArray(r.rows)) { b2.err = '回包没有 rows'; perf.benchFail++; }
        else b2.rows = r.rows;
        renderBench();
      });
    });
  }
  function benchRowEl(r) {
    const box = el('div', { borderBottom: '1px solid ' + UI_TOK.lineSoft, padding: '6px 0' });
    const line1 = el('div', { display: 'flex', alignItems: 'center', gap: '6px' });
    const open = !!benchExpand[r.handle];
    line1.append(el('span', { color: UI_TOK.inkFaint, flex: 'none' }, open ? '▾' : '▸'));
    if (r.blocked) line1.append(el('span', { color: UI_TOK.red, flex: 'none' }, '黑'));
    if (r.relation === 'following') line1.append(el('span', { color: UI_TOK.acc, flex: 'none' }, '✓'));
    line1.append(el('span', {
      color: UI_TOK.blue, flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }, '@' + r.handle + (r.name ? ' ' + clip(r.name, 10) : '')));
    if (r.tags) line1.append(el('span', {
      color: '#241a02', background: '#b6902a', borderRadius: '6px', padding: '0 5px', lineHeight: '15px',
      flex: 'none', maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }, r.tags));
    const inLed = isBench(r.handle);
    const op = el('button', {
      background: 'transparent', color: inLed ? UI_TOK.inkDim : UI_TOK.acc,
      border: '1px solid ' + UI_TOK.line, borderRadius: '6px', cursor: 'pointer', font: 'inherit',
      padding: '0 6px', lineHeight: '18px', flex: 'none',
    }, inLed ? '移出' : '标为');
    op.type = 'button';
    op.title = inLed
      ? '把 @' + r.handle + ' 移出标杆名单（记一行 state=0：库里 bench_now 从此不认 TA，历史那几行还在）'
      : '@' + r.handle + ' 在本机库里是标杆、但本机台账（GM）没记着（多半是清过一次存储）——点一下重新记进台账';
    op.addEventListener('click', () => {
      benchWrite(r.handle, !inLed, r.name, null);
      if (benchOpen) fetchBench(true); else renderFlist();
    });
    line1.append(op);
    line1.title = (open ? '点一下收起 TA 的帖子' : '点一下在下方展开 TA 的帖子（只读本机库，不滚页面、不导航）')
      + '\n进榜时刻：' + (r.markedAt ? String(r.markedAt).replace('T', ' ').slice(0, 16) : '不知道（台账与库都没留）')
      + '\n数：' + (r.db ? '本机库 account_latest ' : '') + (r.led ? '台账补 ' + r.led + ' 格' : '')
      + (r.miss ? '；缺 ' + r.miss + ' 格（显示「—」，一个都不编）' : '');
    line1.addEventListener('click', (ev) => {
      // 与名单那条同一判据：命中的是行里的自家钮/输入框就当行没被点（红线不许 stopPropagation，只能认目标）
      if (ev && ev.target && (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT')) return;
      if (benchExpand[r.handle]) delete benchExpand[r.handle];
      else { benchExpand[r.handle] = true; fetchBenchPosts(r.handle); }
      renderBench();
    });
    box.append(line1);
    box.append(el('div', { color: UI_TOK.inkDim, paddingTop: '3px' },
      '粉 ' + benchNum(r.fans) + ' 注 ' + benchNum(r.fow) + ' 曝 ' + benchNum(r.views)
      + ' 互 ' + benchNum(r.eng) + ' 帖 ' + benchNum(r.postsN)
      + '｜' + (r.src || '两头都没数')));
    // 分类：自由输入（用户口径「只要能打标签、先不做切换」）。不靠 keydown（桩与真机都可能不等键盘），
    // 靠「存」那一颗：读 input 的当下值 ⇒ 点了就一定有结果，没结果一定有话说。
    const trow = el('div', { display: 'flex', alignItems: 'center', gap: '5px', paddingTop: '4px' });
    trow.append(el('span', { color: UI_TOK.inkFaint, flex: 'none' }, '分类'));
    const inp = el('input', {
      background: UI_TOK.bg, color: UI_TOK.ink, border: '1px solid ' + UI_TOK.line, borderRadius: '6px',
      font: 'inherit', padding: '1px 5px', flex: '1', minWidth: '0',
    });
    inp.type = 'text';
    inp.value = r.tags || '';
    inp.placeholder = '投资,AI';
    inp.title = '分类标签，逗号分隔（最多 8 个、每个 16 字）。改完点「存」：会往库里再落一行（append-only，改分类不改历史）';
    trow.append(inp);
    const save = el('button', {
      background: 'transparent', color: UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line, borderRadius: '6px',
      cursor: 'pointer', font: 'inherit', padding: '0 6px', lineHeight: '18px', flex: 'none',
    }, '存');
    save.type = 'button';
    save.title = '把上面这串分类记进台账并落库（只动我方账本，不碰页面）';
    save.addEventListener('click', () => {
      if (!bench[r.handle]) {
        benchNote = '@' + r.handle + ' 不在本机台账里（库里记着、台账没有）——先点「标为」把 TA 记回台账，再改分类。';
        renderBench();
        return;
      }
      const w = benchSetTags(r.handle, inp.value, r.name);
      benchNote = w ? ('分类已存：@' + r.handle + ' → ' + (w.tags || '（清空）')) : ('分类没存进去（台账写不了？）：@' + r.handle);
      renderBench();
    });
    trow.append(save);
    box.append(trow);
    if (open) box.append(benchDrawerEl(r.handle));
    return box;
  }
  function benchDrawerEl(h) {
    const d = el('div', { background: UI_TOK.bg, border: '1px solid ' + UI_TOK.lineSoft, borderRadius: '8px', padding: '6px 8px', marginTop: '5px' });
    const barRow = el('div', { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' });
    const pb = (lab, on, tip, fn) => {
      const x = el('button', {
        background: 'transparent', color: on ? UI_TOK.acc : UI_TOK.inkDim,
        border: '1px solid ' + (on ? UI_TOK.acc : UI_TOK.line), borderRadius: '6px',
        cursor: 'pointer', font: 'inherit', padding: '0 6px', lineHeight: '17px',
      }, lab);
      x.type = 'button'; x.title = tip;
      x.addEventListener('click', fn);
      return x;
    };
    barRow.append(el('span', { color: UI_TOK.inkFaint }, '排'));
    BENCH_PSORTS.forEach((s) => barRow.append(pb(s[1], benchPSort === s[0],
      '按' + s[1] + '降序（缺数的帖子垫底，不冒充 0）；「时间」按**发帖时刻**排，没读到发帖时刻的垫底；'
        + '重排的是本机库已经给回来的这几条，不再问一次库',
      () => { benchPSort = s[0]; renderBench(); })));
    barRow.append(el('span', { color: UI_TOK.inkFaint, paddingLeft: '4px' }, '窗'));
    BENCH_PWINS.forEach((w) => barRow.append(pb(w[1], benchWin === w[0],
      '只看最近' + w[1] + '**发**的帖子（按发帖时刻算「几天前」；没读到发帖时刻的一条都不进这一档 —— '
        + '以前按采集时刻算，同一趟扫到的一屏全在同一分钟，这三档等于没筛）',
      () => { benchWin = w[0]; renderBench(); })));
    d.append(barRow);
    const box = benchPosts[h];
    if (!box || box.loading) {
      d.append(el('div', { color: UI_TOK.inkFaint, paddingTop: '5px' }, '正在读 TA 的帖子（云端模式读接口，本机模式读本机库）…'));
      return d;
    }
    if (box.err) { d.append(el('div', { color: UI_TOK.red, paddingTop: '5px' }, box.err)); return d; }
    if (box.note) d.append(el('div', { color: UI_TOK.inkFaint, paddingTop: '5px' }, box.note));
    const rows = benchPostsOf(h);
    if (!rows.length) {
      // 空榜要把「为什么空」说全：库里有条目却一条都没进这一档，可能是窗口太窄，也可能是那些条目
      // 根本没读到发帖时刻（按纪律它们不进任何非「全部」的窗）。只说前者就是让人以为筛子坏了。
      const noPub = benchWin === 'all' ? 0 : box.rows.filter((p) => !benchPostPub(p)).length;
      d.append(el('div', { color: UI_TOK.inkDim, paddingTop: '5px' },
        box.rows.length ? ('这个窗口里没有 TA 的帖子（' + (box.src === 'api' ? '接口' : '库里') + '共 ' + box.rows.length + ' 条，把窗换成「全部」看看'
          + (noPub ? '；其中 ' + noPub + ' 条没读到发帖时刻，任何窗都不进' : '') + '）')
          : (box.src === 'api'
            ? '云端实体层里没有 TA 的帖子记录（探针只推扫到过的那些，不替你翻主页）'
            : '本机库里没有 TA 的帖子记录（探针只记扫到过的那些，不替你翻主页）')));
      return d;
    }
    // 一条帖子两行（用户 2026-10-27 的口径：「正文在前，数值在第二行」）。以前是一行塞 曝/评/赞/时间/正文，
    // 面板只有 300px 宽又不换行 ⇒ 一条帖子实际只能看见三五个字，正文等于没显示。
    rows.slice(0, BENCH_POSTS_LIMIT).forEach((p) => {
      const pub = benchPostPub(p);
      const tip = 'tweet ' + p.tweet_id
        + '\n发帖：' + (pub ? hlShort(pub) + '（本机时区）' : '没读到（页面那一行没给时间戳）')
        + '\n采到：' + (p.first_at ? hlShort(p.first_at) : '?') + ' 第一次 / ' + hlShort(p.last_at) + ' 最近一次'
        + '\n（这一行只是我们记的数字，点它不做事、也不带你去那条帖子）';
      d.append(el('div', {
        color: UI_TOK.ink, paddingTop: '5px', wordBreak: 'break-word', lineHeight: '1.35',
      }, clip(String(p.text || '(无正文)'), 80)));
      const num = el('div', {
        color: UI_TOK.inkDim, fontSize: '11px', paddingTop: '2px', paddingBottom: '4px',
        borderBottom: '1px solid ' + UI_TOK.lineSoft,
      }, '曝 ' + benchNum(p.view) + ' 评 ' + benchNum(p.reply) + ' 赞 ' + benchNum(p.like)
        + ' · ' + (pub ? hlShort(pub) : '发帖时间没读到'));
      num.title = tip;
      d.append(num);
    });
    if (rows.length > BENCH_POSTS_LIMIT) {
      d.append(el('div', { color: UI_TOK.inkFaint, paddingTop: '4px' }, '只列前 ' + BENCH_POSTS_LIMIT + ' 条（问库时就按这个数夹的）'));
    }
    return d;
  }
  let benchNote = '';
  function benchBuild() {
    if (!benchDragged) { benchPos.r = benchRightPx(); benchPos.b = benchBottomPx(); }
    const root = el('div', {
      position: 'fixed', right: benchPos.r + 'px', bottom: benchPos.b + 'px', zIndex: '2147483647',
      width: BENCH_W + 'px', maxHeight: 'calc(100vh - ' + (benchPos.b + 20) + 'px)', overflowY: 'auto',
      userSelect: 'none', background: UI_TOK.panel, backdropFilter: UI_TOK.blur, color: UI_TOK.ink,
      border: '1px solid ' + UI_TOK.line, borderRadius: UI_TOK.rPanel, padding: '10px 12px',
      font: '12px ui-monospace, Consolas, monospace', boxShadow: UI_TOK.shadow,
    });
    root.id = BENCH_ID;
    const rows = benchSorted(benchMerge());
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '6px', paddingBottom: '6px' });
    const grip = uiTitle('标杆 ' + rows.length + ' 人');
    grip.style.cursor = 'grab'; grip.style.flex = 'none';
    grip.title = '按住拖动整个窗口（拖的是探针自己的面板，不碰页面）；这一格位置一旦由你定下，换页与名单开合都不再自动挪它';
    grip.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const sx = ev.clientX, sy = ev.clientY, sr = benchPos.r, sb = benchPos.b;
      const maxB = Math.max(0, window.innerHeight - 80);
      const mv = (e) => {
        benchDragged = true;
        benchPos.r = Math.max(0, Math.min(900, sr - (e.clientX - sx)));
        benchPos.b = Math.max(0, Math.min(maxB, sb - (e.clientY - sy)));
        root.style.right = benchPos.r + 'px';
        root.style.bottom = benchPos.b + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    head.append(grip);
    head.append(el('span', { flex: '1' }));
    const hb = (lab, tip, fn, on) => {
      const x = el('button', {
        background: 'transparent', color: on ? UI_TOK.acc : UI_TOK.inkDim, border: '1px solid ' + (on ? UI_TOK.acc : UI_TOK.line),
        borderRadius: '6px', cursor: 'pointer', font: 'inherit', padding: '1px 7px', lineHeight: '18px',
      }, lab);
      x.type = 'button'; x.title = tip;
      x.addEventListener('click', fn);
      return x;
    };
    head.append(hb('刷', '重读本机库那一份（台账那一半是内存里的，本来就最新）。库一问一答，不碰页面',
      () => fetchBench(true), false));
    head.append(hb('×', '收起标杆窗口（整棵从页面摘掉；台账与库里的账一条不动）',
      () => { benchOpen = false; renderBench(); }, false));
    root.append(head);
    const srow = el('div', { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', paddingBottom: '6px' });
    srow.append(el('span', { color: UI_TOK.inkFaint, flex: 'none' }, '排'));
    BENCH_SORTS.forEach((s) => srow.append(hb(s[1], '按' + s[1] + '降序重排这份名单（客户端重排，不再问一次库）；'
      + '选中的那根会记住，下次打开自动按它排——「打开即自动排好」就是这一条',
      () => { benchSortSet(s[0]); renderBench(); }, benchSortNow === s[0])));
    root.append(srow);
    const nDb = rows.filter((x) => x.db > 0).length;
    const nLed = rows.filter((x) => x.src === '台账').length;
    const nMiss = rows.filter((x) => x.miss >= 5).length;
    const loading = benchData && benchData.loading;
    const err = benchData && benchData.err;
    root.append(el('div', { color: err ? UI_TOK.red : UI_TOK.inkFaint, paddingBottom: '6px' },
      (benchNote ? benchNote + '  ' : '')
      + (benchData && benchData.note ? benchData.note + '  ' : '')
      + (loading ? '正在读… ' : (err ? err + ' ' : ''))
      + '库 ' + nDb + ' 人有数 · 台账补 ' + nLed + ' 人 · 一个数都没有 ' + nMiss + ' 人'
      + (benchData && benchData.rows ? '（' + (benchData.src === 'api' ? '接口' : '库') + '回 ' + benchData.rows.length + ' 行）' : '')));
    if (!rows.length) {
      root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' },
        // v0.11.3：名单行尾那颗「标杆」按用户口径去掉了 ⇒ 加人的口只剩主页那颗胶囊，这里得把话说准，
        // 不能指着没有的钮让人点（RL-11：不许让人按一颗找不到的钮）。
        '标杆名单还是空的：去 TA 的个人主页，昵称右边那颗「☆标此人」点一下（这一颗长在 X 的页面上，'
        + '设置里「页面内拉黑徽标」那道总闸关着时它不出）。名单（右缘「关」）行尾那颗已于 v0.11.3 去掉。'
        + '标完这里就有；库里那边要等落盘，台账这边立刻算（所以先看到「台账补」是正常的）。'));
    } else {
      rows.forEach((r) => root.append(benchRowEl(r)));
    }
    root.append(el('div', { color: UI_TOK.inkFaint, paddingTop: '6px' },
      '点行=展开 TA 的帖子（云端模式读接口、本机模式读本机库，都不滚页面/不导航） · 数：接口（云端）/本机库（本机）优先，'
      + '缺的格退本机台账，两头都没有写「—」不编 · 分类逗号分隔（最多 8 个），改完点「存」= 库里再落一行 · 问库 '
      + perf.benchAsk + ' 回 · 没回话/被拒 ' + perf.benchFail + ' 回 · v' + VER));
    return root;
  }
  function renderBench() {
    if (benchRoot) benchRoot.remove();
    benchRoot = benchOpen ? benchBuild() : null;
    if (benchRoot) document.documentElement.appendChild(benchRoot);
  }
  function toggleBench() {
    benchOpen = !benchOpen;
    benchNote = '';
    // v0.9.3 互斥：两张右缘窗口不叠着放（同一列叠一起谁都看不清，且各占一档高度）。
    // 只是收起那一棵，各自的行/账/拖动过的位置都还在，切回来还是原样。
    if (benchOpen && benchPOpen) { benchPOpen = false; renderBenchP(); }
    if (benchOpen) fetchBench(false); else renderBench();
  }
  // v0.9.3：排里两颗入口分开写清楚（用户原话「右下角加一个按钮，分别是：标杆账号、标杆帖子，
  // 点击账号打开账号的窗口，点击帖子打开帖子的窗口」）。字面从「标3」改成「标杆3」就是这个原因——
  // 两排在一起时「标3」分不清标的是人还是帖。
  function benchFabText() { const n = benchCount(); return '杆' + (n ? n : ''); }
  function benchPFabText() { const n = benchPCount(); return '帖' + (n ? n : ''); }
  // ---------- 右缘「标杆帖子」窗口（v0.9.3）----------
  // 与账号窗口同一套纪律：position:fixed 挂 documentElement 的自家 UI ⇒ 不参与 X 的布局、不受 RL-16 那道
  // 「往 X 的 DOM 里缝东西」的总闸管；数全从本机库经 SW 的 dbq 白名单来（bench_post_rows，一条新 SQL 都不拼）；
  // 库优先、缺的那格退本机 posts 台账、两头都没有写「—」（RL-11 不许拿 0 冒充「不知道」）；
  // 换排序轴只客户端重排这批行，不再问一次库；上次那根轴记在 GM ⇒ 「打开即自动排好」。
  // 与账号窗口互斥（同一列右缘，两张叠着谁都看不清），各自的行/账/位置都不丢。
  const BENCHP_W = 320;
  const BENCHP_FLIST_W = 268;     // 同账号窗口那档让位：名单也开着时往左让，不叠
  const BENCHP_DB_LIMIT = 200;    // 一次问库要多少条（SW 那边把 limit 夹在 1..500）
  const BENCHP_SORTS = [['view', '曝光'], ['reply', '评论'], ['like', '赞'], ['eng', '互动'],
    ['pub', '发帖'], ['at', '加入']];
  let benchPOpen = false;
  let benchPRoot = null;
  let benchPData = null;          // { loading, err, rows }：库那一份（bench_post_rows）
  let benchPDragged = false;
  let benchPPos = { r: 14, b: 334 };
  let benchPSortNow = 'view';
  let benchPNote = '';
  try { benchPSortNow = String(GM_getValue(BENCHP_SORT_KEY, 'view') || 'view'); } catch (e) { benchPSortNow = 'view'; }
  if (!BENCHP_SORTS.some((s) => s[0] === benchPSortNow)) benchPSortNow = 'view';
  function benchPSortSet(k) {
    benchPSortNow = k;
    try { GM_setValue(BENCHP_SORT_KEY, k); } catch (e) { /* 记不住就本次会话内记住，下次开按默认 */ }
  }
  function benchPRightPx() { return 14 + (flistOpen && !flistDragged ? BENCHP_FLIST_W : 0); }
  function benchPBottomPx() { return flistBottomPx(); }
  // 台账里那几个互动数能拼出库那个 eng（库里 COALESCE 求和：赞+转+评+引+藏），拼不出来就 null 如实缺。
  // 只在「库这一格没给」时当第二条腿用，绝不反过来盖库的数。
  function benchPLedEng(p) {
    if (!p) return null;
    let any = false, s = 0;
    ['like', 'repost', 'reply', 'quote', 'bookmark'].forEach((k) => {
      const v = p[k];
      if (typeof v === 'number' && isFinite(v)) { any = true; s += v; }
    });
    return any ? s : null;
  }
  function benchPMerge() {
    const out = [], by = {};
    const dbRows = benchPData && Array.isArray(benchPData.rows) ? benchPData.rows : [];
    const KEYS = ['view', 'reply', 'like', 'eng', 'pub'];
    const put = (r) => { if (r.id && !by[r.id]) { by[r.id] = r; out.push(r); } };
    const mkRec = (id, raw, g, u) => {
      const db = { view: raw.view, reply: raw.reply, like: raw.like, eng: raw.eng, pub: benchPostPub(raw) };
      const led = { view: u.view, reply: u.reply, like: u.like, eng: benchPLedEng(u), pub: benchPostPub({ time_datetime: u.timeISO }) };
      const r = {
        id: id,
        // 正文/作者：台账是「我刚按下的那一刻」，库是「已经落账的那一笔」⇒ 台账优先（同账号窗口的名字口径）
        author: String((g && g.a) || raw.author || u.handle || ''),
        text: String((g && g.t) || raw.text || raw.marked_text || u.text || ''),
        tags: benchNormTags(g ? g.tags : raw.tags),
        markedAt: String(raw.marked_at || (g && g.at) || ''),
        inLedger: !!g, db: 0, led: 0, miss: 0,
      };
      KEYS.forEach((k) => {
        if (db[k] != null && db[k] !== '') { r[k] = db[k]; r.db++; }
        else if (led[k] != null && led[k] !== '') { r[k] = led[k]; r.led++; }
        else { r[k] = null; r.miss++; }
      });
      r.points = raw.points == null ? (u.n == null ? null : u.n) : raw.points;
      r.src = r.db ? '库' : (r.led ? '台账' : '');
      return r;
    };
    dbRows.forEach((raw) => {
      const id = benchPCleanId(raw.tweet_id);
      if (!id) return;
      // 同账号窗口：本会话刚移出的那条不许被旧回包画回来
      if (benchGonePo[id]) return;
      put(mkRec(id, raw, benchP[id] || null, posts[id] || {}));
    });
    // 刚标完、还没 flush 进库的那条（以及库里根本没这条的）：从台账 + posts 出这一行，数缺就缺
    Object.keys(benchP).forEach((id) => {
      if (by[id]) return;
      const g = benchP[id], u = posts[id] || {};
      const r = mkRec(id, {}, g, u);
      r.markedAt = String((g && g.at) || '');
      r.inLedger = true; r.src = r.led ? '台账' : '';
      put(r);
    });
    return out;
  }
  function benchPVal(r, k) { return k === 'at' ? r.markedAt : r[k]; }
  // 轴内降序、缺数垫底、垫底那段按 id 升序（与账号窗口同一条判据：「没数」不许冒充「很低」）
  function benchPSorted(rows) {
    const k = benchPSortNow;
    return rows.slice().sort((a, b) => {
      const va = benchPVal(a, k), vb = benchPVal(b, k);
      const na = va == null || va === '', nb = vb == null || vb === '';
      if (na && nb) return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      if (na) return 1;
      if (nb) return -1;
      if (k === 'at' || k === 'pub') return (benchPostMs(vb) - benchPostMs(va)) || (a.id < b.id ? -1 : 1);
      return (vb - va) || (a.id < b.id ? -1 : 1);
    });
  }
  function fetchBenchP(force) {
    if (!force && benchPData && !benchPData.loading && !benchPData.err) { renderBenchP(); return; }
    benchPData = { loading: true, rows: null, err: '', src: '', note: '' };
    renderBenchP();
    perf.benchAsk++;
    benchAskApi({ q: 'bench', kind: 'po', size: BENCHP_DB_LIMIT }).then((a) => {
      if (!benchPOpen) return;                   // 等待期间窗口关了：回包丢掉，不给一棵已经不存在的树画东西
      if (a && a.ok && Array.isArray(a.rows)) {
        benchPData.loading = false;
        benchPData.src = 'api';
        benchPData.rows = a.rows.map(benchPoRowFromApi).filter((x) => x.tweet_id);
        renderBenchP();
        return;
      }
      if (a && a.ok === false && !a.needLocal) {
        benchPData.note = '接口没回话（' + clip(String(a.err || '未知原因'), 80) + '），这一眼读本机缓存，可能不是最新';
        perf.benchFail++;
      }
      dbAsk({ t: 'dbq', q: 'bench_post_rows', limit: BENCHP_DB_LIMIT }).then((r) => {
        if (!benchPOpen) return;
        benchPData.loading = false;
        benchPData.src = 'local';
        if (!r) { benchPData.err = '本机库也没回话（宿主/sink 起来了吗？）'; perf.benchFail++; }
        else if (r.ok === false) { benchPData.err = '本机库拒了：' + clip(String(r.err || '未知原因'), 80); perf.benchFail++; }
        else if (!Array.isArray(r.rows)) { benchPData.err = '回包没有 rows（库/sink 版本旧？装了宿主的机器要重跑 native/install-host.py 重打包）'; perf.benchFail++; }
        else benchPData.rows = r.rows;
        renderBenchP();
      });
    });
  }
  function benchPRowEl(r) {
    const box = el('div', { borderBottom: '1px solid ' + UI_TOK.lineSoft, padding: '6px 0' });
    // 两行：正文在前（v0.9.2 用户点名的读法），数字与时间在第二行小字。整行**不挂点击**——
    // 这一窗的条目可能根本不在当前画面上，点它滚不到也不该导航（红线：不滚、不导航、不请求 X）。
    box.append(el('div', {
      color: UI_TOK.ink, wordBreak: 'break-word', lineHeight: '1.35',
    }, clip(r.text || '(无正文)', 90)));
    const num = el('div', { color: UI_TOK.inkDim, fontSize: '11px', paddingTop: '2px' },
      '曝 ' + benchNum(r.view) + ' 评 ' + benchNum(r.reply) + ' 赞 ' + benchNum(r.like)
      + ' 互 ' + benchNum(r.eng)
      + ' · ' + (r.pub ? hlShort(r.pub) : '发帖时间没读到')
      + '｜' + (r.src || '两头都没数'));
    num.title = 'tweet ' + r.id
      + '\n发帖：' + (r.pub ? hlShort(r.pub) + '（本机时区）' : '没读到（台账与库都没有这一列）')
      + '\n加入标杆：' + (r.markedAt ? hlShort(r.markedAt) : '不知道（台账与库都没留）')
      + '\n数：' + (r.db ? '本机库 post_growth ' : '') + (r.led ? '台账补 ' + r.led + ' 格' : '')
      + (r.miss ? '；缺 ' + r.miss + ' 格（显示「—」，一个都不编）' : '')
      + '\n采样点 ' + (r.points == null ? '—' : r.points) + ' 个（同一条帖子被扫到几次）';
    box.append(num);
    const foot = el('div', { display: 'flex', alignItems: 'center', gap: '6px', paddingTop: '3px' });
    foot.append(el('span', { color: UI_TOK.blue, flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      (r.author ? '@' + r.author + ' ' : '') + '#' + r.id));
    if (r.tags) foot.append(el('span', {
      color: '#241a02', background: '#b6902a', borderRadius: '6px', padding: '0 5px', lineHeight: '15px',
      flex: 'none', maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }, r.tags));
    const inLed = isBenchP(r.id);
    const op = el('button', {
      background: 'transparent', color: inLed ? UI_TOK.inkDim : UI_TOK.acc,
      border: '1px solid ' + UI_TOK.line, borderRadius: '6px', cursor: 'pointer', font: 'inherit',
      padding: '0 6px', lineHeight: '18px', flex: 'none',
    }, inLed ? '移出' : '标为');
    op.type = 'button';
    op.title = inLed
      ? '把 #' + r.id + ' 移出标杆帖子（记一行 state=0：库里 bench_posts_now 从此不认它，历史那几行还在）'
      : '#' + r.id + ' 在本机库里是标杆帖、但本机台账（GM）没记着（多半是清过一次存储）——点一下重新记进台账';
    op.addEventListener('click', () => {
      benchPWrite(r.id, !inLed, r.author, r.text, null);
      if (benchPOpen) fetchBenchP(true);
      if (benchOpen) fetchBench(true);        // 名单行尾那颗也在页面上，账变了让它跟着重取
      renderCard();                            // 榜单行尾那颗「标帖」也在这页：就地翻色（自家面板，不碰页面）
    });
    foot.append(op);
    box.append(foot);
    return box;
  }
  function benchPBuild() {
    if (!benchPDragged) { benchPPos.r = benchPRightPx(); benchPPos.b = benchPBottomPx(); }
    const root = el('div', {
      position: 'fixed', right: benchPPos.r + 'px', bottom: benchPPos.b + 'px', zIndex: '2147483647',
      width: BENCHP_W + 'px', maxHeight: 'calc(100vh - ' + (benchPPos.b + 20) + 'px)', overflowY: 'auto',
      userSelect: 'none', background: UI_TOK.panel, backdropFilter: UI_TOK.blur, color: UI_TOK.ink,
      border: '1px solid ' + UI_TOK.line, borderRadius: UI_TOK.rPanel, padding: '10px 12px',
      font: '12px ui-monospace, Consolas, monospace', boxShadow: UI_TOK.shadow,
    });
    root.id = BENCHP_ID;
    const rows = benchPSorted(benchPMerge());
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '6px', paddingBottom: '6px' });
    const grip = uiTitle('标帖 ' + rows.length + ' 条');
    grip.style.cursor = 'grab'; grip.style.flex = 'none';
    grip.title = '按住拖动整个窗口（拖的是探针自己的面板，不碰页面）；这一格位置一旦由你定下，换页与名单开合都不再自动挪它';
    grip.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const sx = ev.clientX, sy = ev.clientY, sr = benchPPos.r, sb = benchPPos.b;
      const maxB = Math.max(0, window.innerHeight - 80);
      const mv = (e) => {
        benchPDragged = true;
        benchPPos.r = Math.max(0, Math.min(900, sr - (e.clientX - sx)));
        benchPPos.b = Math.max(0, Math.min(maxB, sb - (e.clientY - sy)));
        root.style.right = benchPPos.r + 'px';
        root.style.bottom = benchPPos.b + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    head.append(grip);
    head.append(el('span', { flex: '1' }));
    const hb = (lab, tip, fn, on) => {
      const x = el('button', {
        background: 'transparent', color: on ? UI_TOK.acc : UI_TOK.inkDim, border: '1px solid ' + (on ? UI_TOK.acc : UI_TOK.line),
        borderRadius: '6px', cursor: 'pointer', font: 'inherit', padding: '1px 7px', lineHeight: '18px',
      }, lab);
      x.type = 'button'; x.title = tip;
      x.addEventListener('click', fn);
      return x;
    };
    head.append(hb('账号', '切到标杆账号窗口（两本账：那边按人、这一窗按条；同一列右缘不叠着放，'
      + '这张收起、那张打开，各自的行与位置都不丢）',
      () => { benchPOpen = false; renderBenchP(); toggleBench(); }, false));
    head.append(hb('刷', '重读本机库那一份（台账那一半是内存里的，本来就最新）。库一问一答，不碰页面',
      () => fetchBenchP(true), false));
    head.append(hb('×', '收起标杆帖子窗口（整棵从页面摘掉；台账与库里的账一条不动）',
      () => { benchPOpen = false; renderBenchP(); }, false));
    root.append(head);
    const srow = el('div', { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', paddingBottom: '6px' });
    srow.append(el('span', { color: UI_TOK.inkFaint, flex: 'none' }, '排'));
    BENCHP_SORTS.forEach((s) => srow.append(hb(s[1], '按' + s[1] + '降序重排这批帖子（客户端重排，不再问一次库）；'
      + '选中的那根会记住，下次打开自动按它排——「打开即自动排好」就是这一条。缺数的垫底，不冒充 0',
      () => { benchPSortSet(s[0]); renderBenchP(); }, benchPSortNow === s[0])));
    root.append(srow);
    const nDb = rows.filter((x) => x.db > 0).length;
    const nLed = rows.filter((x) => x.src === '台账').length;
    const nMiss = rows.filter((x) => x.miss >= 5).length;
    const loading = benchPData && benchPData.loading;
    const err = benchPData && benchPData.err;
    root.append(el('div', { color: err ? UI_TOK.red : UI_TOK.inkFaint, paddingBottom: '6px' },
      (benchPNote ? benchPNote + '  ' : '')
      + (benchPData && benchPData.note ? benchPData.note + '  ' : '')
      + (loading ? '正在读… ' : (err ? err + ' ' : ''))
      + '库 ' + nDb + ' 条有数 · 台账补 ' + nLed + ' 条 · 一个数都没有 ' + nMiss + ' 条'
      + (benchPData && benchPData.rows ? '（' + (benchPData.src === 'api' ? '接口' : '库') + '回 ' + benchPData.rows.length + ' 行）' : '')));
    if (!rows.length) {
      root.append(el('div', { color: UI_TOK.inkDim, padding: '8px 0' },
        '标杆帖子还是空的：在帖子详情页页头「帖子」右边点「☆标此帖」，或在本页曝光榜某条行尾点「标帖」。'
        + '标完这里就有；库里那边要等落盘，台账这边立刻算（所以先看到「台账补」是正常的）。'));
    } else {
      rows.forEach((r) => root.append(benchPRowEl(r)));
    }
    root.append(el('div', { color: UI_TOK.inkFaint, paddingTop: '6px' },
      '条目不挂点击（不滚页面/不导航/不请求 X）· 数：本机库优先，缺的格退本机台账，两头都没有写「—」不编 '
      + '· 分类下一轮做（库里 tags 列已留好） · 问库 ' + perf.benchAsk + ' 回 · 没回话/被拒 ' + perf.benchFail + ' 回 · v' + VER));
    return root;
  }
  function renderBenchP() {
    if (benchPRoot) benchPRoot.remove();
    benchPRoot = benchPOpen ? benchPBuild() : null;
    if (benchPRoot) document.documentElement.appendChild(benchPRoot);
  }
  function toggleBenchP() {
    benchPOpen = !benchPOpen;
    benchPNote = '';
    if (benchPOpen && benchOpen) { benchOpen = false; renderBench(); }   // 互斥：两张不叠
    if (benchPOpen) fetchBenchP(false); else renderBenchP();
  }
  // 本页曝光榜每条行尾那颗「标帖」（用户点的第二条腿：「面板榜单行尾」）。与「复制」并排放在可点区**外**，
  // 所以不需要拦冒泡；自家面板里的钮不受 RL-16 页面注入总闸管（那闸只管 X 的 DOM）。
  function benchPCardBtn(id, author, text) {
    const k = benchPCleanId(id);
    const on = !!k && !!benchP[k];
    const b = el('button', {
      background: 'transparent', color: on ? UI_TOK.acc : UI_TOK.inkDim,
      border: '1px solid ' + (on ? UI_TOK.accDim : UI_TOK.line), borderRadius: '6px',
      cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: '0 6px', lineHeight: '16px',
    }, on ? '已标帖' : '标帖');
    b.type = 'button';
    b.title = k
      ? ((on ? '这条帖 #' + k + ' 已在标杆帖子里，点一下移出' : '把这条帖 #' + k + ' 记进标杆帖子')
        + '（只记账：本机台账 + 落库 bench_posts 表，不动 X 的任何东西；右缘「标帖」窗口看这批）')
      : '这条帖子没有可记账的 id（认不出 tweet_id），不替你猜';
    b.addEventListener('click', () => {
      const w = benchPToggle(k, author, text);
      benchPNote = w ? '' : '这条没有可记账的 id，什么都没写';
      if (benchPOpen) fetchBenchP(true);
      if (benchOpen) fetchBench(true);
      renderCard();                              // 就地翻色（整张卡片是自家面板，不碰页面）
    });
    return b;
  }
  // ---------- 页面内徽标的总闸（v0.8.9）----------
  // 真机抱怨：评论区「鼠标放上去就会移动走」。量出来的原因是这颗钮本身 —— 它缝在 X 自己的名字行里
  // （anchor.parentNode.insertBefore），带 margin-left:4px 与一颗 15px 高的按钮，于是那一行的宽/高被我们改了：
  // 光标底下那个东西的位置跟着挪。React 重渲染又把我们的节点丢掉，观察器看见「有别家节点挂上来」→ badgeNeedScan
  // → 再缝一遍 → 反复抖。附带更要紧的一条：DOM 是两个世界共享的，`data-xprobe` / `ysy-xprobe-blk` 这些属性
  // 页面自己的 JS 读得到，那就是Detection 面。
  // 口径（v0.8.9 定：默认关；**v0.8.16 用户点头改默认开**）：这颗钮从头到尾是「浮在行上、不参与布局」，
  // 关着就是零注入且连我们改过的样式一起还回去；开着也只是多一个不占位的 span。设置里那颗开关照旧能拨回去。
  // 开关存 GM 且每次判都现读（与 debugGet 同一套），所以面板拨一下所有标签页同频，不需要额外的跨页同步。
  // v0.8.10 追加（用户点名「放时间右侧那块空白，别影响页面正常使用」）：这颗钮从「行里的一块」改成
  // 「浮在行上的绝对定位」——display:block+position:absolute 不参与 flex 布局，名字/@handle/·/时间的宽高
  // 一个像素都不动，光标底下的东西不再挪位；空白放不下整颗就退成小红点，连点都会盖住时间就不出（并记账）。
  // 闸、默认值、账本都没变：关着仍然是零注入，开着也只是「不占位的注入」。
  let badgeSweepNeeded = false;
  // v0.8.10：绝对定位要有一个「相对定位」的宿主。⚠ 真机 X 那一行**没有**自带 position
  // （v0.8.10 那句注释把 class r-1pi2tsx 当成了 position:relative，查它自己的样式表其实是 height:100%）
  // ⇒ 几乎每行都要我们补一个。补的时候记在案——关闸清场时按原样还回去，
  // 绝不在页面里留下我们改过的痕迹（RL-16 的「关掉那一刻当场摘干净」连样式也算）。
  const badgeHosts = new Map();   // 宿主元素 -> 它原来的 position 值（'' = 我们没见着，按清空处理）
  // 「这一行上次挂的是哪颗」不单独记账（v0.8.10 之前用 WeakMap，删了）：宿主是往上爬选出来的，
  // 同一行两次扫描可能选到不同层，靠行内 querySelector 找不回来 ⇒ 每趟多挂一颗。
  // 现在认「本趟账本」：每一行从**宿主的直系子节点**里认领（同 handle + 本趟没被别的行认走），
  // 趟末把没被任何一行认领的自家节点摘掉。重载/重新 boot 后账本是新的，但 DOM 里上一版留下的节点还在，
  // 认领那条路走的就是这个（不认就会一行挂两颗，文档序第一颗是旧的「拉黑」）。
  function badgeGet() {
    // v0.8.16：默认值翻了 —— 用户 2026-10-27 点名「改成默认显示」（此前他一直开着用，只是每次重装/换机器
    // 要重拨一次）。RL-16 的「零痕迹」不在这条里：关着仍然连样式一起还回去，开着也只是「不占位的注入」。
    try { return GM_getValue(BADGE_KEY, true) !== false; } catch (e) { return true; }
  }
  // 摘干净：只认自家两种记号（class 与 data-xprobe），X 自己的节点一个都不碰；
  // 顺手把为定位临时改过的宿主样式原样还回去。
  function badgeSweep() {
    let n = 0;
    try {
      // v0.11.4 关系标签片：正常路径它是「拉黑」徽标的孩子，摘徽标就连它一起摘了；
      // 这里仍单独列上，防的是 React 把徽标搬走/拆了而那片自己留下来的极端情况 —— 宁可多摘一颗自家节点，
      // 也不许页面里留着我们贴的「互关」二字（RL-16 清场清干净）。
      document.querySelectorAll('.' + BLK_CLS + ', [data-xprobe="blk"], .' + BENCH_BADGE_CLS + ', [data-xprobe="bench"], .' + REL_CLS + ', [data-xprobe="rel"]').forEach((x) => {
        try { x.remove(); n++; } catch (e) { /* 已被 React 摘掉就算摘掉了 */ }
      });
    } catch (e) { /* 选择器抛了就下一轮再摘 */ }
    badgeHosts.forEach((prev, host) => {
      try { host.style.position = prev; } catch (e) { /* 节点没了就不用还 */ }
    });
    badgeHosts.clear();
    return n;
  }
  function setBadgeOn(v) {
    const on = !!v;
    try { GM_setValue(BADGE_KEY, on); } catch (e) { /* 存不进就本次会话内生效 */ }
    // 开了就当场扫一遍：用户的原话是「我开了之后并没实时显示」——等下一拍（1.2s 节拍 + 2.5s 地板）
    // 再等观察器给信号，体感就是「拨了没反应」。这一趟是用户自己点开的，force 不算越线（RL-16 的
    // 零注入指的是**默认状态**，闸开着本来就是用户点名要它在页面上标出来）。
    if (on) { badgeNeedScan = true; renderBlocks(true); }
    else { badgeSweep(); badgeSweepNeeded = false; }   // 关掉这一刻就清场，不等下一拍
    return { ok: true, badge: on };
  }
  // 徽标全扫（v0.8.7 限流）：整文档两趟 querySelectorAll + 每行一趟 a[href] 扫描，节拍器 1.2 秒进一轮时
  // 它就是滚动热路径上的第二笔冤枉钱。现在只在这些情况下真扫：观察器看到「别家的节点挂上来了」
  // （badgeNeedScan，我自己缝的节点不算，否则就是自激）、用户刚点了拉黑（force）、或满 BADGE_HEARTBEAT_MS 一次兜底。
  function renderBlocks(force) {
    const now = Date.now();
    // art-020 热度徽标是独立总闸（默认关），挂在节拍但不受拉黑徽标那道闸牵连；闸关时这是一次便宜的 GM 读。
    try { hotBadgeAuto(); } catch (e) { /* 徽标那一腿不该把采集节拍搞挂 */ }
    // 总闸在限流之前：关着的时候连「要不要扫」都不参与判断，只在做过一次清场后静默返回。
    // force（用户刚点了拉黑）也不例外——那条动作现在发生在自家面板里，页面这边不该有东西冒出来。
    if (!badgeGet()) {
      if (badgeSweepNeeded) { badgeSweep(); badgeSweepNeeded = false; }
      // 闸关着 = 页面里不该有我们的东西，主页那颗标星的账也一并归零（留着上一趟的「出 1」就是假账）
      // v0.9.3：页头那颗「标此帖」同一条命——两颗都长在 X 的 DOM 里，就都跟着这道闸的账走
      perf.benchBadge = 0; perf.benchBadgeNo = 0; perf.benchBadgeWhy = '闸关着（不注入）';
      perf.benchPBadge = 0; perf.benchPBadgeNo = 0; perf.benchPBadgeWhy = '闸关着（不注入）';
      perf.badgeSkips++;
      return;
    }
    badgeSweepNeeded = true;   // 真扫过 = 页面里可能挂了我们的节点，翻回「关」时得去摘一遍
    if (!force && !badgeNeedScan && now - badgeLastScan < BADGE_HEARTBEAT_MS) { perf.badgeSkips++; return; }
    if (!force && now - badgeLastScan < BADGE_MIN_MS) { perf.badgeSkips++; return; }
    const t0 = nowMs();
    badgeNeedScan = false; badgeLastScan = now; perf.badgeScans++;
    renderBlocksInner();
    const ms = nowMs() - t0;
    perf.lastBadgeMs = Math.round(ms * 10) / 10;
    if (ms > perf.worstBadgeMs) perf.worstBadgeMs = ms;
  }
  // 量一个节点：拿不到几何（老引擎/脱离文档流/沙箱没桩）就返回 null，调用方按「测不了」降级
  function geoRect(node) {
    try {
      const r = node && node.getBoundingClientRect && node.getBoundingClientRect();
      if (!r) return null;
      const o = { left: +r.left || 0, right: +r.right || 0, top: +r.top || 0, bottom: +r.bottom || 0,
                  width: +r.width || 0, height: +r.height || 0 };
      return o.width > 0 || o.height > 0 ? o : null;
    } catch (e) { return null; }
  }
  // ---------- v0.8.13 关注/粉丝比例标签（贴在拉黑钮右边） ----------
  // 数据来源只有本机台账：这两个数**不在评论区那一行里**（真机名字行只有「名字 @handle · 时间」），
  // 只活在悬停名片与主页头部 ⇒ 标签只对「你悬过头像 / 进过主页」的人出，没数就一个都不编（RL-11 记数）。
  // 读台账走内存里那份 users；本页没写过的人（别的标签页刚采到的）再回一次 GM 缓存兜底：
  // 适配层的 chrome.storage.onChanged 已经把最新值放进缓存，GM_getValue 是一次内存读，不是 IO。
  function userRowFor(h) {
    const u = users[h];
    if (u && (u.followers != null || u.following != null)) return u;
    try {
      const c = GM_getValue(USERS_KEY, null);
      if (c && c[h]) return c[h];
    } catch (e) { /* 读不了就用内存那份，没有当没数 */ }
    return u || null;
  }
  // 比例 = 正在关注 ÷ 关注者（v0.8.14 换的位置）。两个数缺一个、或分母（关注者）≤0 ⇒ null（不出标签）。
  // 档位按原值判、标签按向下取整显示：95.0 以下就判黄，标签写 94% —— 不会出现「写着 95% 却是黄的」。
  // 数有多旧 = 台账里最后一个采样点距今几天（超过 RATIO_STALE_DAYS 天 ⇒ stale：标签转灰、进名单「待补」）。
  function ratioInfo(h) {
    const k = String(h || '').toLowerCase();
    if (!k) return null;
    const u = userRowFor(k);
    if (!u) return null;
    const fow = Number(u.following), fans = Number(u.followers);
    if (u.following == null || u.followers == null) return null;
    if (!isFinite(fow) || !isFinite(fans) || fans <= 0 || fow < 0) return null;
    const pct = fow * 100 / fans;
    const tier = pct >= RATIO_GREEN ? 'g' : pct >= RATIO_YELLOW ? 'y' : 'r';
    const shown = (pct >= 10 ? Math.floor(pct) : Math.round(pct * 10) / 10) + '%';
    const sty = RATIO_STY[tier];
    const pt = lastPointAt(u);
    const atMs = Number(u.statsAt) || (pt ? Date.parse(pt) : 0);
    const ageD = atMs && isFinite(atMs) ? Math.floor((Date.now() - atMs) / 86400000) : -1;
    const stale = ageD >= RATIO_STALE_DAYS;
    const when = ageD < 0 ? '读取时间未知（老版本台账里没留采样点）'
      : ageD <= 0 ? '今天刚读到的' : ageD + ' 天前读到的';
    return { tier, pct: Math.round(pct * 10) / 10, shown, fans, fow, at: atMs, ageDays: ageD, stale,
      tip: '正在关注 ' + fow + ' / 关注者 ' + fans + ' = ' + shown + '（' + sty.name + '）\n'
        + '这两个数不在评论区那一行里，只活在 TA 的悬停名片与主页头部 —— 探针不点开任何东西：'
        + '这台机器上没悬停过 TA 的头像、也没进过 TA 的主页，就没有这一枚。\n'
        + '数' + when + (stale ? '：超过 ' + RATIO_STALE_DAYS + ' 天算旧数，再悬停一次头像就更新入库。' : '。') };
  }
  // 标签宽度预算：按字面长度算，不拿实测宽赌（实测要挂进 DOM 才量得到，那一趟的缝已经定了）。
  function ratioBudget(rt) {
    return rt ? RATIO_PAD_W + rt.shown.length * RATIO_CHAR_W : 0;
  }
  // 那颗标签本体（徽标里、名单行里共用）。纯展示件：没有事件、不拦事件，点它等于点它底下的东西。
  // v0.8.14：数超过 RATIO_STALE_DAYS 天 ⇒ 换虚线灰边 + 压暗，一眼看出「这是旧数」；档位底色保留（用户要颜色=档位）。
  function ratioChipEl(rt, extra) {
    const s = RATIO_STY[rt.tier] || RATIO_STY.y;
    const sty = { background: s.bg, color: s.fg,
      border: rt.stale ? '1px dashed ' + UI_TOK.inkDim : '1px solid transparent',
      opacity: rt.stale ? '0.72' : '1',
      borderRadius: '6px', padding: '0 4px', lineHeight: '15px', whiteSpace: 'nowrap', flex: 'none' };
    Object.keys(extra || {}).forEach((k) => { sty[k] = extra[k]; });
    const x = el('span', sty, rt.shown);
    x.title = rt.tip;
    return x;
  }
  // 名单行里「还没有这两个数」的那一枚（v0.8.14 缺数清单）：不是档位，所以不给档位色，只给一个灰杠。
  // 数已过期的人不走这里 —— ratioInfo 回得来，所以那一行仍是档位标签本体，只是带虚线（见 ratioChipEl）。
  function ratioNeedEl() {
    const x = el('span', { color: UI_TOK.inkFaint, border: '1px dashed ' + UI_TOK.line, borderRadius: '6px',
      padding: '0 4px', lineHeight: '15px', whiteSpace: 'nowrap', flex: 'none' }, '—');
    x.title = '台账里没有 TA 的「正在关注 / 关注者」这两个数 —— 页面上没有，只有 TA 的悬停名片与主页头部有。'
      + '把鼠标放到 TA 的头像上，名片弹出来那一拍就自动入库（探针不替你点开任何东西）。';
    return x;
  }
  // ---------- v0.11.4 行内关系标签（用户点名「在用户右侧显示 互关 / 他单向 / 我单向 三个标签，放在拉黑左侧，颜色区分」） ----------
  // 判据有四条腿（v0.11.7 起加了「桥」这一条，见下面那节）：这一行的关系钮 / 主世界桥读回的 X 自带读数 /
  // 本机台账（粉丝列表与关注列表里真读到过的事实）。
  //   · TA 关注我的证据：这一行那颗原生关系钮的 aria 写着「回关 / Follow back」（X 只在「TA 关注你、你还没关注」时
  //     给这两个字），或桥带回 followed_by=true，或台账记着 TA 出现在**我的**粉丝列表里（seenAs.followers /
  //     verified_followers，与右缘「回」那颗待回关同一口井、同一条口径）。
  //   · 我关注 TA 的证据：这一行读到 -unfollow 钮，或桥带回 following=true，或台账 relation==='following' /
  //     seenAs.following（出现在我的关注列表）。
  //   · 「我这侧没关注」同样是正向读数：这一行读到 -follow 钮，或桥带回 following=false，或台账
  //     relation==='not_following'（那是从页面抄来的，不是猜的）。
  // 证据的优先序：钮 > 桥 > 台账 —— 钮是 X 当场画出来的字，桥是 X 当场带回的数据，台账是过去读过的账；
  // 新读数不许被旧账翻案（与名单面板同一条纪律）。
  // 三颗的诚实档位不一样，形态就分开画：
  //   互关 / 他单向 = 两侧都是正向读数 ⇒ 实线；
  //   我单向 = 「我关注 TA」是读数 + 「TA 没关注我」要么桥上有明确读数（followed_by=false ⇒ 实线，两半都是
  //   X 的当场数据），要么只是**去过的列表里没看到**的推断 ⇒ 虚线（与比例标签「虚线=旧数」同一套语言），
  //   tooltip 把这一半写清；桥没有读数、这台机器又一次都没进过粉丝列表时这颗直接不出（没看到≠没有，RL-11）。
  // ⚠ 第三方观察者脚本也往名字后面缝状态字（真机见过「（互）单向关注」「互相关注」，displayNameOf 的 TAIL 就是剥它们的）——
  //   那些不是 X 的 DOM，这里一个都不认；关系只认 X 原生钮的 testid 后缀与 aria、桥读数、加自家台账。
  const REL_CLS = 'ysy-xprobe-rel';
  // 档位文案与配色（v0.11.13 起颜色/形状 100% 对齐参考插件「不是兄弟」的 .xro-badge*，content-script.css 抄的）：
  // mutual=绿胶囊（tone #a8e89a / bg #dff7d9）、me=橙方角（#f1b84b / #fff0c9，参考插件 following_only 的形状）、
  // them=蓝胶囊（#78bfea / #dff2ff，参考插件 follows_you_only）。字色一律 #13231b。
  const REL_TAG = {
    mutual: { lab: '互关', color: '#a8e89a', bg: '#dff7d9', dash: false },
    them: { lab: '他单向', color: '#78bfea', bg: '#dff2ff', dash: false },
    me: { lab: '我单向', color: '#f1b84b', bg: '#fff0c9', dash: true },
  };
  const dayOf = (iso) => String(iso || '').slice(0, 10) || '日期没记';
  // ---------- v0.11.7 功能一：关系读数桥（第三条证据腿） ----------
  // 为什么 home 时间线此前判不出：那儿的帖子行里根本没有关系钮（钮只在列表行/主页/名片上），
  // 台账两腿又只覆盖「这台机器读到过的人」⇒ relVerdict 大多数时候只能回 null，一屏标签全空。
  // X 其实把每个作者的关系读数（following / followed_by）随时间线一起带回了页面，挂在 React 组件树
  // （DOM 节点的 __reactFiber$* 自有属性）里 —— 参考插件「不是兄弟」的 dashboard 就是这么读的。
  // 那份属性是页面主世界的 JS 对象，isolated world 的我们读不到 ⇒ 读的活交给主世界那份只读信使
  // （manifest 里 world=MAIN 的 content/bridge.js，document_start），这边用 window.postMessage 问它：
  //   · 一次一问一答，都带自家记号（REL_BRIDGE_SRC），别人的消息一个字不读；
  //   · 最多 REL_FIBER_ASK_MS 一问（在途的不重复问），没回话由超时解锁，绝不轮询；
  //   · 回话里有新读数就置 badgeNeedScan —— 下一轮徽标扫描把标签画上，「动态刷新」的全部机制。
  const REL_BRIDGE_SRC = 'ysy-xprobe-rel-bridge';
  const REL_FIBER_TTL = 24 * 60 * 60000; // 桥读数的保鲜期：v0.11.13 起=页面会话级（参考插件同款——它不设过期）。
  // 旧的 5 分钟在长浏览里把读数放expired，判定掉回台账推断出虚线「我单向」——真机「有概率和不是兄弟
  // 不一样」的来源之一。翻面（真的取关了）不靠过期兜底：桥现在把翻面当 delta 当场推（见 bridge.js）。
  const REL_FIBER_ASK_MS = 15000;       // 两问之间最少隔这么久（一屏滚出再多的新行也只攒着等下一问）
  const fiberRel = new Map();           // handle → { following, followsYou, at }（哪格没读到就是 null，不冒充布尔）
  let fiberPending = false;             // 一次只允许一问在途
  let fiberSeq = 0;
  let fiberLastAsk = 0;
  // v0.11.9 用户报「要鼠标悬浮头像才更新」：回话来了只置 badgeNeedScan 是不够的——下一轮扫描要等
  // 节拍（15 秒兜底）或下一次页面动静，体感就是「不动就不刷新」。回话一到就自己安排一次重画（50ms，
  // 去抖：一屏多行回话也只排一次），动态刷新从此不等任何人。
  let relRenderT = 0;
  function relRenderSoon() {
    if (relRenderT) return;
    // v0.11.14：名单开着就一起翻色/翻状态（renderFlist 自己保滚动位置，整棵重画不再有代价）
    relRenderT = setTimeout(() => {
      relRenderT = 0;
      try { render(); } catch (e) { /* 渲染层自己保底 */ }
      try { if (flistOpen) renderFlist(); } catch (e) { /* 名单自己保底 */ }
    }, 50);
  }
  // 问话/推送两路共用的合并：users 里只有「至少一格是布尔」的条目才进台账（不冒充读数），
  // handle 归一小写。回 n = 这一批真变了账的条数（0 = 没有新读数，调用方就不必重画）。
  // ⚠ 必须逐格合并（v0.11.12 真机教训，v0.11.11 引入的回归）：X 的回包很多形状只带半截关系
  //（store 实体/别的载荷里只有 followed_by，following 是 null）——整条覆盖会把台账里已经对的
  // 另一格抹成 null，互关的人 following 一丢、判定掉回本机旧账 ⇒ 满屏「没关注」。
  // 规矩与桥那头的 put() 同一条：boolean 才落格、null 不许抹已有读数；一格都没变就不动账（at 也不刷）。
  function relFiberMerge(us) {
    const o = (us && typeof us === 'object') ? us : {};
    const ks = Object.keys(o);
    let n = 0;
    for (let i = 0; i < ks.length; i++) {
      const v = o[ks[i]] || {};
      if (typeof v.following !== 'boolean' && typeof v.followsYou !== 'boolean') continue;
      const k = String(ks[i]).toLowerCase();
      const old = fiberRel.get(k);
      const f = typeof v.following === 'boolean' ? v.following : (old ? old.following : null);
      const y = typeof v.followsYou === 'boolean' ? v.followsYou : (old ? old.followsYou : null);
      if (old && old.following === f && old.followsYou === y) continue;
      fiberRel.set(k, { following: f, followsYou: y, at: Date.now() });
      n++;
    }
    return n;
  }
  function relFiberAsk(handles) {
    if (fiberPending || Date.now() - fiberLastAsk < REL_FIBER_ASK_MS) return;
    const win = (typeof window !== 'undefined') ? window : null;
    // 沙箱/无窗环境没有 postMessage：这一腿安静不跑（perf 的「缺桥」计数把这件事亮在面板上，RL-11）
    if (!win || typeof win.postMessage !== 'function') return;
    fiberLastAsk = Date.now();
    fiberPending = true;
    const id = String(++fiberSeq) + '-' + fiberLastAsk;
    let to = null;
    const done = () => {
      fiberPending = false;
      try { win.removeEventListener('message', onMsg); } catch (e) { /* 没挂上就没什么可摘 */ }
      if (to !== null) { clearTimeout(to); to = null; }
    };
    const onMsg = (ev) => {
      let d = null;
      try { d = ev && ev.data; } catch (e) { return; }
      try { if (!d || d.source !== REL_BRIDGE_SRC || d.type !== 'result' || d.id !== id) return; } catch (e2) { return; }
      done();
      const n = relFiberMerge(d.users);
      if (n) { badgeNeedScan = true; relRenderSoon(); }   // 有新读数 ⇒ 当场安排重画（不等节拍、不等悬浮）
    };
    try { win.addEventListener('message', onMsg); } catch (e) { fiberPending = false; return; }
    to = setTimeout(done, 800);   // 桥没回话（脚本被 X 摘了/世界不同）：解锁让下一趟还能问
    // 问询带上缺读数的 handle（≤80 个）：桥只回这几个人，回包小、页面上别的账号不外送。
    // v0.11.8 桥那边有三条源（网络旁听攒的 + Redux store + fiber 上下爬），这边不用知道细节，
    // 问出去就行 —— 时间线行 fiber 上没有的读数，store 与旁听里多半有。
    try { win.postMessage({ source: REL_BRIDGE_SRC, type: 'query', id: id, handles: (handles || []).slice(0, 80) }, (win.location && win.location.origin) || '*'); }
    catch (e) { done(); }
  }
  // v0.11.11 常驻推送监听：X 每次带关系读数的回包（时间线刷新/名片/hovercard…）一到，桥就把
  // 「刚学到/翻面」的 delta（type:'push'，只推新条目不广播全量）推过来，这边当场合并进台账并重画
  // —— 不用等 15s 节拍的下一问，「悬浮头像三秒才翻对」的另一半根因。core 没监听时消息丢了无害
  //（首趟问询兜底）；依旧只认自家记号，别人的消息一个字不读。
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    try {
      window.addEventListener('message', (ev) => {
        let d = null;
        try { d = ev && ev.data; } catch (e) { return; }
        try { if (!d || d.source !== REL_BRIDGE_SRC || d.type !== 'push') return; } catch (e2) { return; }
        const n = relFiberMerge(d.users);
        if (n) { badgeNeedScan = true; relRenderSoon(); }
      });
    } catch (e) { /* 沙箱没有 window 事件：这一腿安静不跑，问询兜底 */ }
  }
  // 「这台机器进过（自己的）粉丝列表吗」——「我单向」那一颗的前提。整本台账扫一次，每趟徽标扫描只算一次。
  function followersListSeen() {
    const pools = [users];
    try { const c = GM_getValue(USERS_KEY, null); if (c && typeof c === 'object') pools.push(c); } catch (e) { /* 读不了就只判内存那本 */ }
    for (let i = 0; i < pools.length; i++) {
      const ks = Object.keys(pools[i] || {});
      for (let j = 0; j < ks.length; j++) {
        const s = (pools[i][ks[j]] || {}).seenAs;
        if (s && (s.followers || s.verified_followers)) return true;
      }
    }
    return false;
  }
  // 判一颗标签：回 { key, lab, color, dash, tip }，没有任何一条腿读到就回 null（绝不用「没读到」冒充「没关注」，RL-11）。
  // ev = 这一行当场读到的关系钮（followOf 的那三个字段）；flSeen = 这台机器进过粉丝列表（每趟算一次传进来）；
  // fb = 桥读数（v0.11.7，可选）：{ following, followsYou }，哪格没读到是 null。证据优先序：钮 > 桥 > 台账。
  function relVerdict(h, ev, flSeen, fb) {
    const k = String(h || '').toLowerCase();
    if (!k) return null;
    const u = users[k] || null;
    const seen = (u && u.seenAs) || {};
    const rel = (u && u.relation) || '';
    const aria = String((ev && ev.aria) || '');
    const e = ev || {};
    const fbF = (fb && typeof fb.following === 'boolean') ? fb.following : null;   // 桥说：我关注 TA
    const fbY = (fb && typeof fb.followsYou === 'boolean') ? fb.followsYou : null; // 桥说：TA 关注我
    // ① TA 关注我的三条腿（页面优先，桥次之，库兜底）
    const themBtn = /回关|Follow back/i.test(aria);
    const themLedger = !!(seen.followers || seen.verified_followers);
    const them = themBtn || fbY === true || themLedger;
    // ② 我关注 TA：页面那颗 -unfollow / 桥带回 following=true / 库里的 following。
    //    桥明确 following=false 时库不许翻案（X 当场带回的数据赢过旧账，与「页面读数赢过库」同一条纪律）。
    const meBtn = e.state === 'following';
    const noBtn = e.state === 'not_following';
    const meLedger = rel === 'following' || !!seen.following;
    const me = meBtn || (!noBtn && (fbF === true || (fbF !== false && rel !== 'not_following' && meLedger)));
    // ③ 我这侧「没关注」必须是读到的（钮在眼前 / 桥明确 following=false / 台账里那条就是页面抄来的）。
    //    桥明确 following=true 时台账的 not_following 当过期账处理（新读数赢）。
    const noRead = noBtn || fbF === false || (fbF !== true && rel === 'not_following');
    if (them && me) {
      const themWhy = themBtn ? '这一行那颗关系钮写着「' + clip(aria, 24) + '」'
        : fbY === true ? 'X 给这行作者带回的读数 followed_by=true（TA 关注你）'
        : '本机台账记着 TA 出现在你的粉丝列表（' + dayOf(seen.verified_followers || seen.followers) + '）';
      const meWhy = meBtn ? '这一行读到「正在关注」那颗钮'
        : fbF === true ? 'X 给这行作者带回的读数 following=true（你关注 TA）'
        : '本机台账记着你在关注 TA';
      return { key: 'mutual', lab: REL_TAG.mutual.lab, color: REL_TAG.mutual.color, dash: false,
        tip: '@' + k + ' 互关：你关注 TA（' + meWhy + '），TA 也关注你（' + themWhy + '）。只读页面与本机台账，探针不点任何东西。' };
    }
    if (them && noRead) {
      const themWhy = themBtn ? '这一行那颗关系钮写着「' + clip(aria, 24) + '」'
        : fbY === true ? 'X 给这行作者带回的读数 followed_by=true（TA 关注你）'
        : '本机台账记着 TA 出现在你的粉丝列表（' + dayOf(seen.verified_followers || seen.followers) + '）';
      const noWhy = noBtn ? '这一行读到的是「关注」那颗钮'
        : fbF === false ? 'X 给这行作者带回的读数 following=false（你这侧没关注 TA）'
        : '本机台账里 TA 的关系是 not_following（那句是从页面抄的）';
      return { key: 'them', lab: REL_TAG.them.lab, color: REL_TAG.them.color, dash: false,
        tip: '@' + k + ' ' + REL_TAG.them.lab + '：TA 关注了你（' + themWhy + '），你这侧没关注 TA（' + noWhy + '）——'
          + '就是右缘「回」那颗数的是同一批人。要回关请去 TA 的主页自己点，探针不代操作。' };
    }
    if (me && !them) {
      const meWhy = meBtn ? '这一行读到「正在关注」那颗钮'
        : fbF === true ? 'X 给这行作者带回的读数 following=true（你关注 TA）'
        : '本机台账记着你在关注 TA（relation=following / 出现在你的关注列表）';
      // 「TA 没关注我」这一半：桥有明确读数（followed_by=false）⇒ 两半都是 X 的当场数据，实线；
      // 没有就只能靠「去过的粉丝列表里没看到」推断 ⇒ 虚线，且这台机器得进过粉丝列表（没看到≠没有，RL-11）。
      if (fbY === false) {
        return { key: 'me', lab: REL_TAG.me.lab, color: REL_TAG.me.color, dash: false,
          tip: '@' + k + ' ' + REL_TAG.me.lab + '：你关注 TA（' + meWhy + '），而 X 给这行作者带回的读数 followed_by=false'
            + '（TA 没关注你）。两半都是这一行自带的读数，所以画实线。' };
      }
      if (flSeen) {
        return { key: 'me', lab: REL_TAG.me.lab, color: REL_TAG.me.color, dash: true,
          tip: '@' + k + ' ' + REL_TAG.me.lab + '：你关注 TA（' + meWhy + '），而本机在**你的粉丝列表**里没有读到过 TA。'
            + '虚线 = 后一半是「去过的列表里没看到」的推断，不是 X 写着的读数：粉丝列表只翻过前几屏时这里可能判错。'
            + '（这台机器一次都没进过粉丝列表页的话，这一颗根本不出。）' };
      }
    }
    return null;
  }
  // 宽度预算与比例标签同一笔账：按字面长度算，不拿实测宽赌（实测要挂进 DOM 才量得到，那一趟的缝已经定了）。
  // v0.11.13 换参考插件同款胶囊：内边距 7×2 + 边框 2 + 外边距 8 比旧描边宽 10px 上下，按档位字数之外补一笔。
  function relBudget(rel) {
    return rel ? RATIO_PAD_W + rel.lab.length * RATIO_CHAR_W + BADGE_GAP_PX + 10 : 0;
  }
  // 标签本体：纯展示件（没有事件、不拦事件，点它等于点它底下那一行）。
  // v0.11.9 起它不再住在拉黑徽标里——用户口径「位置也参考不是兄弟，放在名称后面」：
  // 改成长在名字锚右边一格（名字行的内联件，紧跟名字、@handle 之前），与参考插件同款位置。
  // v0.11.13 样式 100% 对齐参考插件「不是兄弟」：绿/蓝=胶囊（radius 999）、我单向=方角+错位投影
  //（参考插件 following_only 的形状），10px/750 字重、1px 实线描边（tone 55% 混 #13231b）、
  // 内侧高光、淡色底——不再用虚线描边细字（用户口径「现在的不清晰」）。虚线只保留给「推断」档位，
  // 颜色形状与其余一致（dash=true 时 border 换 dashed），其余与参考插件逐项同值。
  function relChipStyle(x, rel) {
    x.style.color = '#13231b';
    x.style.background = rel.bg;
    x.style.border = (rel.dash ? '1px dashed ' : '1px solid ')
      + ('color-mix(in srgb, ' + rel.color + ' 55%, #13231b)');
    x.style.borderRadius = rel.key === 'me' ? '4px' : '999px';
    x.style.boxShadow = rel.key === 'me'
      ? '2px 2px 0 rgba(100, 70, 15, 0.18)'
      : 'inset 0 1px 0 rgba(255, 255, 255, 0.3)';
    x.style.font = '750 10px/' + (rel.key === 'me' ? '16px' : '14px')
      + ' "Avenir Next", "Hiragino Sans", "Microsoft YaHei", sans-serif';
    x.style.letterSpacing = '0.02em';
    x.style.padding = rel.key === 'me' ? '1px 8px 1px 7px' : '1px 7px';
    x.style.whiteSpace = 'nowrap';
    x.style.display = 'inline-flex';
    x.style.alignItems = 'center';
    x.style.marginInline = '4px';
    x.style.verticalAlign = '1px';
    return x;
  }
  function relChipEl(rel) {
    const x = el('span', {}, rel.lab);
    relChipStyle(x, rel);
    x.setAttribute('class', REL_CLS);
    // 自家记号也打一份：清场选择器与 inProbe()（第三方注入检测与读名跳过）认的是这个，
    // 打了它这片标签就永远不会被当成「别人缝进页面的东西」，也不会把「互关」二字读进名字台账。
    x.setAttribute('data-xprobe', 'rel');
    x.title = rel.tip;
    return x;
  }
  // 名字行里那颗的安置与认领（v0.11.9；v0.11.10 改插进名字锚**里面**）：
  // v0.11.9 插在 User-Name 里当兄弟——那是个 grid 容器，新元素独占一格 ⇒ 另起一行还被拉伸占满
  //（真机截图实锤）。长在名字文字后面的行内流里才是参考插件同款位置与大小；点它等于点名字链接，
  // 与点名字本身无异（页面自己的行为，不拦不代）。
  // 同一锚里只认 data-h 对上的那一颗；行里别的旧颗（X 虚拟列表把行复用给了别人）当场摘——
  // 绝不许挂着旧作者的标签替新作者站岗。判不出（rel=null）就把这一锚的那颗摘掉；画不上回 false 让记账看得见。
  function relChipRow(anchor, h, rel) {
    let cur = null;
    try {
      anchor.querySelectorAll('[data-xprobe="rel"]').forEach((c) => {
        if (c.getAttribute('data-h') === h) cur = c;
        else { try { c.remove(); } catch (e2) { /* 复用行留下的旧颗，摘了就摘了 */ } }
      });
    } catch (e) { return false; }
    if (!rel) {
      if (cur) { try { cur.remove(); } catch (e2) { /* React 已摘：算摘掉了 */ } }
      return true;
    }
    const k = rel.key + (rel.dash ? '~' : '+');
    if (!cur) {
      cur = relChipEl(rel);
      cur.setAttribute('data-h', h);
      try { anchor.append(cur); } catch (e2) { return false; }
    } else if ((cur.getAttribute('data-k') || '') !== k) {
      // 档位或虚实线翻了（桥读数到了、钮翻了）：就地整套重刷样式与字面——同一个位置、同一次插入，不搬不重建
      cur.textContent = rel.lab; cur.title = rel.tip;
      relChipStyle(cur, rel);
    }
    cur.setAttribute('data-k', k);
    return true;
  }
  // 参照物（时间；列表页就退到 @handle）右边那条带上「真正空着」的区间清单。
  // 算法：沿参照物的祖先链一路爬到宿主，每一层把**不是我们这一支**、且竖着压到这条带的孩子
  // 各记成一段「已占用」（真机名字行是「名字 @handle · 时间」几块挤在一起；列表页是 @handle
  // 后面贴着显示名 span，再右边才是那颗关注钮）。
  //   · 只量参照物右缘 ⇒ 徽标会盖在挤着的那块字上；把紧贴着的下一块当墙 ⇒ 那条缝只剩 4px，
  //     整页一颗都不出（用户看到的「开了没显示」就是这么来的）。两头的坑都得避开。
  //   · 「绝不盖住页面自己的东西」不用另写特判：那排 Grok/更多 钮、列表页的关注钮都是这条带上的
  //     兄弟盒子，它们的矩形天然把对应那段从可用区间里挖掉了（RL-16）。
  // 每层最多看 BADGE_SIB_MAX 个孩子、整条链最多 BADGE_HOST_UP 层 ⇒ 每行几十次 rect，扫得动。
  // v0.8.16：挡住这条带的这一块盒子，是不是 X 自己的**关注钮**（正在关注 / 回关 / 关注 / 取消关注）？
  // 认它只为了一件事：徽标要贴在这颗钮的**左边**（用户口径），而不是像别家盒子那样贴缝的左缘。
  // 三条都收：① data-testid 以 follow 结尾（follow / unfollow / 555-follow / followButton 全算，
  // 中文「正在关注」那颗的 testid 就是 unfollow）；② 往下 ≤BADGE_CTA_DOWN 层里藏着这样一颗（真机钮
  // 外面常包一层 div）；③ 它自己就是 button/[role=button] 且 aria-label 写着关注/回关/Follow。
  // ⚠ 认错不危险：顶多落点从「贴缝左缘」变成「贴这块盒子左缘」，仍然完整躺在量出来的缝里，压不到页面。
  function badgeFollowBtn(node, depth) {
    const d = depth || 0;
    if (!node || d > BADGE_CTA_DOWN) return false;
    let tid = '';
    try { tid = String(node.getAttribute && node.getAttribute('data-testid') || ''); } catch (e) { return false; }
    if (/follow$/i.test(tid)) return true;
    if (d === 0) {
      try {
        if (node.matches && node.matches('button, [role="button"]')
          && /关注|回关|Follow/i.test(String(node.getAttribute('aria-label') || ''))) return true;
      } catch (e) { /* 读不了就当不是 */ }
    }
    let kids = [];
    try { kids = node.children || []; } catch (e) { kids = []; }
    for (let i = 0; i < kids.length && i < BADGE_SIB_MAX; i++) {
      if (badgeFollowBtn(kids[i], d + 1)) return true;
    }
    return false;
  }
  function badgeGaps(host, refEl, rr, hr) {
    const occ = [];
    let node = refEl, path = null, hops = 0;
    while (node && hops++ <= BADGE_HOST_UP) {
      let kids = [];
      try { kids = node.children || []; } catch (e) { kids = []; }
      for (let i = 0; i < kids.length && i < BADGE_SIB_MAX; i++) {
        const c = kids[i];
        if (c === path) continue;                       // 我们这一支（祖先链本身）不算挡路
        // 自家缝进页面的记号也不算挡路（拉黑徽标 + v0.9.1 主页标星）：它是宿主的直系子节点，把它当墙 = 老位置永远「站不住」= 每趟重摆一次
        //（用户看到的「来回跑」有一半是这个自激）。
        try { const mk = c.getAttribute && c.getAttribute('data-xprobe'); if (mk === 'blk' || mk === 'bench') continue; } catch (e) { /* 读不了就当别人的盒子 */ }
        const cr = geoRect(c);
        if (!cr || cr.top >= rr.bottom || cr.bottom <= rr.top) continue;   // 不在这条带上
        if (cr.right <= rr.right || cr.left >= hr.right) continue;         // 在参照物左边 / 已在宿主外
        occ.push({ a: cr.left, b: cr.right, cta: badgeFollowBtn(c) });
      }
      if (node === host) break;
      path = node;
      node = node.parentElement;
    }
    occ.sort((x, y) => x.a - y.a);
    const gaps = [];
    let x = rr.right + BADGE_GAP_PX;
    for (let i = 0; i < occ.length && x < hr.right; i++) {
      const seg = occ[i];
      if (seg.b + BADGE_GAP_PX <= x) continue;                 // 已经被前面那段吃掉
      if (seg.a > x) gaps.push({ a: x, b: Math.min(seg.a, hr.right), ctaRight: seg.cta });
      x = seg.b + BADGE_GAP_PX;
    }
    if (x < hr.right) gaps.push({ a: x, b: hr.right, ctaRight: false });
    return gaps;
  }
  // 这一层盒子装不装得下：整颗（46，或「整颗 + 比例标签」的 need）> 小红点（14）> 不出。三种形态都是绝对定位，不参与布局。
  // 挑哪条缝（用户口径：优先「时间右侧那块空白」，不够就「放到右侧」，但一条都不许多——不许盖住页面自己的东西）：
  //   · 最靠左、又装得下整颗的那条 ⇒ 贴着参照物读（就是圈出来的那个位置）；
  //   · 只有右边某条装得下 ⇒ 用那条，**贴它的左缘**（= 紧贴挡住我的那块字右边 4px）；
  //   · **v0.8.16 第三种**：这条缝的右墙是 X 的关注钮（正在关注/回关/关注）⇒ 贴**那颗钮的左缘**，
  //     坐标写成 CSS `right`。用户原话「列表的拉黑按钮和标记应该放在正在关注也就是回关左侧」。
  // v0.8.12：这里不再「贴右墙」。右墙就是宿主/容器的右缘，它会随列宽、滚动条、后到的 Grok/更多/关注钮
  // 一起动 —— 贴墙 = 页面每加载一点，徽标就跟着跑一点（真机同一行同一宿主，隔一分钟 left 264→115）。
  // 贴左缘的坐标只由「我左边那块字有多宽」决定，那是这一行最稳定的量。
  // v0.8.13：装得下的宽度由调用方给（need = 整颗 46，或「整颗 + 比例标签」）。为什么预算要在挑落点之前定：
  // 这颗是浮在缝里的绝对定位块，先按 46 摆好、再往里塞标签 ⇒ 一超宽就压住右边那块字 ⇒ 下一趟判「站不住」⇒ 又搬。
  function badgeFit(host, refEl, needOpt) {
    const need = needOpt || BADGE_FULL_W;
    const hr = geoRect(host);
    if (!hr) return { form: 'full', left: 0, gap: 0 };
    const rr = geoRect(refEl);
    if (!rr) return { form: 'full', left: Math.max(0, hr.width - need), gap: hr.width };
    const gaps = badgeGaps(host, refEl, rr, hr);
    if (!gaps.length) return { form: 'none', left: 0, gap: 0 };
    let firstFit = null, widest = null;
    for (let i = 0; i < gaps.length; i++) {
      const w = gaps[i].b - gaps[i].a;
      if (!widest || w > widest.b - widest.a) widest = gaps[i];
      if (w >= need && !firstFit) firstFit = gaps[i];
    }
    if (firstFit) {
      const fw = firstFit.b - firstFit.a;
      // v0.8.16：右墙是 X 的关注钮 ⇒ 贴**那颗钮的左缘**（用户点名「放在正在关注/回关左边」），
      // 而不是像别的缝那样贴左缘。这不违反 v0.8.12 那条「绝不贴右墙」：那句话说的是**容器右缘**
      //（随列宽、滚动条、后到的钮一起动，贴它就是加载一点跑一点）。这里贴的是「我要挨着的那颗钮」，
      // 它动我们跟着动是需求本身；而且坐标写成 CSS `right`（见 badgeAnchor），窗口一宽一窄它自己
      // 跟着钮走，不需要重摆 ⇒ 不产生「挪」，也不会因为钮左移而压住它。
      if (firstFit.ctaRight) {
        const edge = firstFit.b - BADGE_GAP_PX;    // 徽标右缘：钮左缘再让开 4px
        return { form: 'full', left: Math.max(0, edge - need - hr.left), right: Math.max(0, hr.right - edge), gap: fw };
      }
      return { form: 'full', left: Math.max(0, firstFit.a - hr.left), gap: fw };
    }
    const ww = widest.b - widest.a;
    if (ww >= BADGE_DOT_W) return { form: 'dot', left: Math.max(0, widest.a - hr.left), gap: ww };
    return { form: 'none', left: 0, gap: ww };
  }
  // 落点写在哪一侧：贴钮那颗写 right（跟着钮走），其余写 left。搬没搬、粘没粘，比的都是这一对。
  function badgeAnchor(place) {
    return typeof place.right === 'number' ? ['right', Math.round(place.right) + 'px']
      : ['left', Math.round(place.left) + 'px'];
  }
  // 一段绝对区间 [x0,x1] 是否还完整躺在某条缝里 = 「老位置仍然不盖住页面任何东西」。
  // 容差是给取整用的：left 写进 style 时四舍五入过，差一两像素不算挪动（否则每趟都判「站不住」，
  // 于是每趟重摆 = 自激抖动）。
  function badgeInGap(gaps, x0, x1) {
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      if (x0 >= g.a - BADGE_STICK_TOL && x1 <= g.b + BADGE_STICK_TOL) return true;
    }
    return false;
  }
  // 老宿主还能不能用：必须仍然抱着这一行的锚与参照物（X 的时间线是虚拟列表，cellInnerDiv 会被回收
  // 去装别的帖子 —— contains 一翻脸就说明这颗已经挂错行了）、仍然是一行的高度、且不住在别人的钮里。
  // 高度那把尺**只有这一处定义**（v0.8.16）：badgePick 往上爬层与这里判「老宿主还站不站得住」必须同一把。
  // 各写各的后果很具体 —— 列表页一行 96px，粘住这一路吃的是老的 64 ⇒ 爬得到、粘不住 ⇒ 每一趟都重摆一次，
  // v0.8.12 那条「老位置仍然空着就一个字都不写」在列表页直接成空话（值一样所以面板看不出，写 DOM 的却是真的）。
  function badgeHostHMax(node) {
    try {
      return node.getAttribute && node.getAttribute('data-testid') === BADGE_CELL_TID ? BADGE_HOST_H_MAX_CELL : BADGE_HOST_H_MAX;
    } catch (e) { return BADGE_HOST_H_MAX; }
  }
  function badgeHostOk(host, anchor, refEl) {
    if (!host || !host.appendChild) return null;
    try { if (!host.contains || !host.contains(anchor) || !host.contains(refEl)) return null; } catch (e) { return null; }
    const hr = geoRect(host);
    if (!hr || hr.height > badgeHostHMax(host)) return null;
    try { if (host.closest && host.closest('button, [role="button"]')) return null; } catch (e) { return null; }
    return hr;
  }
  // 宿主挑选（v0.8.11，起因是真机账：23 行全判「放不下」、0 颗徽标——空白不住在名字行里，
  // 住在它上面 1~3 层那排 justify-content:space-between 的行里）：从参照物往上爬，第一个
  // 「抱得住名字锚、且这一层的空白真装得下整颗」的盒子就是宿主。四条边界：
  //   ① 层高度 > BADGE_HOST_H_MAX ⇒ 那不是「一行」，是整条帖子/整屏，再爬就挂错地方，停；
  //   ② 第一个候选之上最多再走 BADGE_HOST_EXTRA 层（再往上就是列表页 UserCell 的盒子）；
  //   ③ 这一层里站着 X 的关注钮 ⇒ 不否掉这一层：那块盒子在 badgeGaps 里就是一段「已占用」，
  //     徽标只会落在它左边的缝里，永远盖不到它（那颗钮是这页唯一的关系入口，吃掉一次点击就是影响页面）；
  //   ④ 这一层住在 button / [role="button"] 里面 ⇒ 这一层不能挂（绝对定位的徽标会替那颗钮吃点击）。
  //     **v0.8.16 改**：老规矩是「就地放弃、账记 badgeCta」，而真机粉丝/关注列表整条名字行就住在那颗
  //     「点它进主页」的大按钮里 ⇒ 每一行都被④吃掉，用户看到的就是「列表页一颗标记都没有」。现在改成
  //     「这一层跳过、继续往上爬」，爬到 UserCell（那颗按钮的父级）就能挂：徽标不是按钮的孩子，
  //     点它不会导航，行本身一个字不改。badgeCta 仍然记 —— 但只在**爬完也没找到宿主**时记。
  function badgePick(anchor, refEl, needOpt) {
    const need = needOpt || BADGE_FULL_W;
    let dotFall = null, cta = false, hops = 0, okHop = -1;
    for (let n = refEl; n && hops++ <= BADGE_HOST_UP; n = n.parentElement) {
      let holds = false;
      try { holds = !!(n.contains && n.contains(anchor)); } catch (e) { holds = false; }
      if (!holds) continue;
      const nr = geoRect(n);
      if (!nr) continue;
      // 「再往上 ≤3 层」这把尺子从**第一个挂得住的层**起量（v0.8.16）。原来从第一个候选起量，
      // 而列表页的候选全住在 X 那颗大按钮里、一个都挂不住 ⇒ 爬两步就 break，永远到不了 UserCell。
      if (okHop >= 0 && hops - 1 - okHop > BADGE_HOST_EXTRA) break;
      let onBtn = false;
      try { onBtn = !!(n.closest && n.closest('button, [role="button"]')); } catch (e) { onBtn = true; }
      if (onBtn) { cta = true; continue; }
      // 高度上限：列表页那一行（头像 + 名字 + @handle + 简介）天生比「名字行」高，认出行容器就给另一把尺；
      // 再往上就是整屏，break。（v0.8.16 之前先量高度再看④，列表页那 90~110px 的行会被当「不是行」直接放弃。）
      const hMax = badgeHostHMax(n);
      if (nr.height > hMax) break;
      if (okHop < 0) okHop = hops - 1;
      const fit = badgeFit(n, refEl, need);
      if (fit.form === 'full') return { host: n, place: fit, cta: false };
      if (fit.form === 'dot' && !dotFall) dotFall = { host: n, place: fit };
    }
    return { host: (dotFall && dotFall.host) || null, place: (dotFall && dotFall.place) || { form: 'none', left: 0, gap: 0 }, cta };
  }
  // 把宿主变成「相对定位」好让徽标挂坐标。⚠ 真机那一行**没有**自带 position（v0.8.10 那句注释把
  // r-1pi2tsx 当成了 position:relative，查样式表它其实是 height:100%，r-dnmrzs 是 max-width:100%）
  // ⇒ 这一笔几乎每行都要补。补 position:relative 不改宽高、不改布局（无偏移），且记在案：
  // 关闸清场时原样还回去，绝不在页面里留下我们改过的痕迹（RL-16）。
  function badgeEnsureHost(host) {
    let pos = '';
    try { pos = (host.style && host.style.position) || ''; } catch (e) { return false; }
    if (pos === 'relative' || pos === 'absolute' || pos === 'fixed' || pos === 'sticky') return true;
    if (!badgeHosts.has(host)) badgeHosts.set(host, pos);
    try { host.style.position = 'relative'; } catch (e) { return false; }
    return true;
  }
  // 落点：left/top 全由「参照物 + 宿主」这两个当趟量到的矩形定 ⇒ 滚动不漂（两者一起平移，差值不变）。
  // v0.8.12 起 top 不再写 '50%'：那是宿主自己的中线，宿主换层（名字行 → 整条帖子）它就跟着跳一下；
  // 改成参照物那一行的中线，徽标永远跟它要标注的那行字齐平，挂在哪一层都不影响纵向。
  function badgePlace(n, host, place, rr, hr) {
    try {
      const s = n.style;
      s.position = 'absolute'; s.display = 'block'; s.zIndex = '1';
      s.transform = 'translateY(-50%)';
      // v0.8.16：贴关注钮那颗写 right（另一侧清空），其余照旧写 left。两侧都留值的话，真浏览器里
      // 绝对定位会同时被两边拉住（宽度被撑开）⇒ 换锚必须把对面那侧归零。
      const an = badgeAnchor(place);
      s.left = an[0] === 'left' ? an[1] : '';
      s.right = an[0] === 'right' ? an[1] : '';
      s.top = rr ? Math.round(rr.top + rr.height / 2 - hr.top) + 'px' : '50%';
      if (place.form === 'dot') {
        // 小红点：只表「这人你拉黑过」，不当按钮（空白太窄时宁可少一颗钮，也不盖住页面自己的东西）
        s.width = '10px'; s.height = '10px'; s.borderRadius = '50%'; s.background = UI_TOK.red;
      } else {
        s.width = ''; s.height = ''; s.borderRadius = ''; s.background = '';
      }
    } catch (e) { return false; }
    return true;
  }
  // 字面与颜色：只在状态真的翻了（拉黑↔取消、整颗↔小红点、比例数变了）才写 DOM —— 节拍器每 1.2 秒进来一轮，
  // 逐轮改节点本身就是页面能观察到的新节奏（与浮标同纪律）。
  // 签名里带上比例标签的字面：台账里那两个数被名片刷新时，sig 一变就重画一次，平时一个字都不写。
  function badgeSig(h, bad, form, rt, rel) {
    // 第 4 格是「数过没过期」：过期只改边框/亮度、不改宽度 ⇒ 它可以就地重画，不该像第 3 格（标签字面）
    // 那样把粘住打断去重挑落点。
    // v0.11.4 第 6 格是关系标签的档位：与第 3 格同一条道理 —— 出不出这颗、哪一颗，都改宽度，所以它进
    // 「不许粘、要重挑」的那一组比对，这里只是把它也写进签名，好让字面翻了自己重画一次。
    // v0.11.7 档位后面带虚实线（~虚/+实）：宽度不变但边框翻的那一下（桥读数来了，「我单向」从推断的
    // 虚线翻成实线）也得重画，否则老样子一直留在身上。
    return h + '|' + (bad ? '1' : '0') + '|' + form + '|' + (rt ? rt.shown : '') + '|' + (rt && rt.stale ? '1' : '0')
      + '|' + (rel ? rel.key + (rel.dash ? '~' : '+') : '');
  }
  function badgePaint(n, h, nameTxt, bad, form, rt) {
    try {
      if (form === 'dot') {
        n.textContent = '';
        n.title = '@' + h + ' 已进本机拉黑名单（blocks 表）· 这一行空白太窄，只给点不给钮';
      } else {
        // v0.11.9：盒子里最多两件（拉黑钮 + 比例标签）——关系标签搬进名字行了（relChipRow，见上）。
        // 仍按「是什么」认（button / 其余那一枚），不按 children 下标认，React 顺序怎么变都认不错。
        let b = null, lb = null;
        try {
          const kids = n.children || [];
          for (let i = 0; i < kids.length; i++) {
            const c = kids[i];
            const tn = String(c.tagName || '').toLowerCase();
            if (tn === 'button') b = c;
            else lb = c;
          }
        } catch (e) { /* 读不到就整棵重建 */ }
        if (!b) {
          b = el('button', {
            background: 'transparent', border: '1px solid ' + UI_TOK.line, borderRadius: '6px', cursor: 'pointer',
            font: 'inherit', padding: '0 5px', lineHeight: '15px',
          });
          b.type = 'button';
          b.addEventListener('click', () => { blockToggle(n.getAttribute('data-h'), n.getAttribute('data-n')); });
          n.textContent = ''; n.append(b);
        }
        n.style.font = '11px ui-monospace, Consolas, monospace';
        b.textContent = bad ? '已拉黑' : '拉黑';
        b.style.color = bad ? UI_TOK.red : UI_TOK.inkDim;
        b.title = bad ? '@' + h + ' 已进本机拉黑名单（blocks 表），点一下取消'
          : '把 @' + h + ' 记进本机拉黑名单（只记账：本机库 + 面板标记，不动 X 的屏蔽/关注）';
        // v0.8.13 比例标签：底色=档位、字=百分比（用户口径）。纯展示件 —— 不挂事件、不拦事件，
        // 点它等于点它底下的那一行。宽度早在 badgeFit 的 need 里量过，塞进来不会压住右边那块字。
        if (rt) {
          const st = RATIO_STY[rt.tier] || RATIO_STY.y;
          if (!lb) n.append(ratioChipEl(rt, { marginLeft: BADGE_GAP_PX + 'px' }));
          else {
            lb.textContent = rt.shown; lb.style.background = st.bg; lb.style.color = st.fg; lb.title = rt.tip;
            // 数从「新」翻到「过期」不改宽度、只改边框与亮度 ⇒ 就地重画（不搬、不新建）
            lb.style.border = rt.stale ? '1px dashed ' + UI_TOK.inkDim : '1px solid transparent';
            lb.style.opacity = rt.stale ? '0.72' : '1';
          }
        } else if (lb) { try { lb.remove(); } catch (e) { /* React 已摘：下一趟重建 */ } }
        n.title = '';
      }
      n.setAttribute('data-h', h);
      n.setAttribute('data-n', nameTxt);
      n.setAttribute('data-f', form);
      n.setAttribute('data-xsig', badgeSig(h, bad, form, rt, null));
    } catch (e) { /* 写不进去下一趟再来（徽标是显示件，不是账本，掉了不丢数据） */ }
  }
  function renderBlocksInner() {
    let names;
    try {
      names = [];
      document.querySelectorAll('[data-testid="User-Name"]').forEach((n) => names.push(n));
      // v0.8.5 补五：关注/粉丝列表页的行是 UserCell，行里没有 User-Name 节点（v0.6.2 真机 31 行 name 0/31
      // 的同一条实锤）⇒ 只认 User-Name 时列表页一颗钮都没有。没有名字节点的 UserCell 整行兜进来，
      // handle/名字锚的判据与下面同一套（单段个人主页锚）。行里已经有名字节点的仍然走上面那条，不重复挂。
      document.querySelectorAll('[data-testid="UserCell"]').forEach((c) => {
        if (!c.querySelector('[data-testid="User-Name"], [data-testid="UserName"]')) names.push(c);
      });
    } catch (e) { return; }
    // 这一趟的账（不是累计）：面板那行要能回答「这一页 23 行里出了几颗、为什么没出」，
    // 累计数看久了就是噪声。badgeOk = 本趟结束时挂着的徽标数（整颗 + 小红点，含原地没动的）；
    // badgeMoved = 这一趟里被搬走的老徽标数 —— 用户报「图标来回跑」，这个数就是那件事的计数器。
    let cOk = 0, cDot = 0, cNoFit = 0, cCta = 0, cMoved = 0, cRatio = 0, cRatioNo = 0, cRatioOld = 0, cRel = 0, cRelNo = 0;
    // v0.11.7 桥读数这一趟的账：用上了几行 / 还缺几行（缺的攒进 fiberAsk，趟末问一声桥）
    let cFb = 0, cFbNo = 0;
    const fiberAsk = new Set();
    // v0.11.4：「这台机器进过粉丝列表吗」每趟问一次（整本台账扫一遍），不在每一行上重扫。
    const flSeen = followersListSeen();
    // 整页自家徽标先按 handle 归堆，每一行从自己那一堆里领一颗（领走 = 从堆里去掉），
    // 趟末堆里剩的就是孤儿。为什么按 handle 全局认、不再「在宿主的直系子节点里找」：宿主是爬出来的，
    // 两趟可能选到不同层，按宿主找就认不回上一颗 ⇒ 每趟新建一颗、旧的当孤儿摘掉 ——
    // 页面里我们的节点反复生灭，看着就是闪和抖。按 handle 认还顺手挡住 X 虚拟列表回收 cell 的坑：
    // 那颗节点上记的是旧作者，新行按新 handle 领不到它 ⇒ 它进孤儿堆被摘掉，不会挂着旧名字替新行站岗。
    const have = new Map();
    try {
      document.querySelectorAll('[data-xprobe="blk"]').forEach((x) => {
        const k = (x.getAttribute && x.getAttribute('data-h')) || '';
        let arr = have.get(k);
        if (!arr) { arr = []; have.set(k, arr); }
        arr.push(x);
      });
    } catch (e) { have.clear(); }
    const take = (k) => { const a = have.get(k); return a && a.length ? a.shift() : null; };
    names.forEach((nameEl) => {
      // handle 只认单段路径的个人主页锚（与 collectUsers 同一判据）；第一个这样的 a 是名字锚，
      // 最后一个通常是 @handle（详情页主帖行与列表页行里没有 <time>，参照物就落在它身上）
      let h = '', nameTxt = '', anchor = null, lastAnchor = null;
      nameEl.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (!/^\/@?[A-Za-z0-9_]{1,20}$/.test(href)) return;
        if (!anchor) {
          h = href.replace(/^\/@?/, '').toLowerCase();
          // v0.11.10：关系标签长在名字锚里面了，读名必须剥自家那颗的字（nativeText 的 inProbe 认
          // data-xprobe；混进去「互关」二字就成了台账里的名字——v0.8.5 补五同一口坑的第二回）
          nameTxt = clip(nativeText(a), 140);
          anchor = a;
        }
        lastAnchor = a;
      });
      if (!h || !anchor) return;
      const bad = isBlocked(h);
      // 参照物 = 这一行文字结束的地方：优先 <time>（名字 @handle · 时间 那一行的最后一个），
      // 没有就退到 @handle 锚，再退到名字锚。空白永远在参照物**右边**，所以参照物选错=整行判不下。
      const timeEl = (nameEl.querySelectorAll && nameEl.querySelectorAll('time')[0]) || null;
      const refEl = timeEl || lastAnchor || anchor;
      const rr = geoRect(refEl);
      // v0.8.13 比例标签先在这里定：它要占的宽度必须先进落点预算，不能等挂好了再塞
      //（绝对定位的东西一超宽就压住右边那块字 ⇒ 下一趟判「站不住」⇒ 又搬 = 「来回跑」）。
      // 装不下「钮+标签」时先保那颗钮（用户圈的位置是标记，标签只是附加信息），标签这一趟不出并记 cRatioNo。
      let rt = ratioInfo(h);
      // v0.11.4 那颗关系标签同样要先进预算（同一条道理：超宽就压住右边那块字 ⇒ 下一趟判「站不住」⇒ 又搬）。
      // 读的 scope 是**整行**（article / UserCell），不是名字节点：真机时间线那颗关注钮长在行首右侧、
      // 不在 [data-testid="User-Name"] 里面（只喂 nameEl 的话时间线永远读空、只能靠台账）。
      // followOf 按 aria 里的 @handle 过滤，所以 scope 放宽到行也不会把别人的钮认进来；
      // 右栏作者卡那颗在 article 外面（v0.8.5 补四的 dump 实锤），closest 正好把它排除掉。
      const rowScope = (typeof nameEl.closest === 'function'
        && nameEl.closest('[data-testid="tweet"], [data-testid="UserCell"], article')) || nameEl;
      // v0.11.7 第三条腿：桥读数（主世界 fiber 里 X 自带的 following/followed_by）。缓存内的新鲜记录直接用；
      // 没读过/过期的攒进 fiberAsk，趟末问一声桥，回话来了置 badgeNeedScan 下一轮重画（动态刷新那一下）。
      const fbRec = fiberRel.get(h) || null;
      const fb = (fbRec && Date.now() - fbRec.at <= REL_FIBER_TTL) ? fbRec : null;
      if (fb) cFb++; else { cFbNo++; fiberAsk.add(h); }
      const rel0 = relVerdict(h, followOf(rowScope, h), flSeen, fb);
      // v0.11.9：关系标签改住名字行（用户口径「参考放在名称后面」）——不再挤徽标那条缝的预算，
      // 判得出来就画在名字锚右边（徽标的退让链管不着它，连徽标都挂不上的行它照样出）；
      // 没读数就把行里那颗摘掉。cRel/cRelNo = 画上了几颗 / 判得出却没画上（宿主没了等，应长期为 0）。
      if (rel0) { if (relChipRow(anchor, h, rel0)) cRel++; else cRelNo++; }
      else relChipRow(anchor, h, null);
      const needOf = (x) => BADGE_FULL_W + (x ? BADGE_GAP_PX + ratioBudget(x) : 0);
      let need = needOf(rt);
      let n = take(h);
      // ① 粘住：老宿主仍然抱得住这一行、老位置仍然完整躺在某条缝里 ⇒ 这一趟对它一个字都不写。
      // 这就是「不来回跑」的那条：增量刷新时名字行右边会陆续挂上东西（第三方「互关」胶囊、
      // Grok/更多、后到的关注钮），缝的划分一直在变；只要老位置没被挡住，就让它待在原地。
      // 真机账：同一行、同一个宿主（r-k4xj1c r-18u37iz r-1wtj0ep），隔一分钟 left 从 264 变成 115。
      if (n && rr) {
        const host0 = n.parentNode;
        const hr0 = badgeHostOk(host0, anchor, refEl);
        const nr = hr0 ? geoRect(n) : null;
        // 粘住之前先把「宿主仍然是相对定位」这一条补稳：React 重渲染那一层时可能把 style 整个重写，
        // 我们补的 position:relative 就没了 —— 坐标系一换，徽标会瞬间飞到别的祖先盒子上去
        // （用户看到的「跑」有一半是这个）。badgeEnsureHost 幂等，且仍然记在案，关闸照样还回去。
        if (hr0 && nr && badgeEnsureHost(host0)) {
          const form0 = n.getAttribute('data-f') || 'full';
          const wantRt = form0 === 'full' ? rt : null;   // 小红点那颗装不下标签，也不许长标签
          const sig = badgeSig(h, bad, form0, wantRt, null);
          // 标签的有无/字面一翻，这颗的宽度就翻了 ⇒ 老落点不是按这个宽度量的，不许粘：走下面重挑一次。
          // 多久翻一次？只有「某人第一次被悬停到名片」那种一次性的事（罕见），换来的是「绝不压住右边那块字」。
          // v0.11.9：关系标签搬进名字行、不再住徽标里 ⇒ 签名第 6 格恒空，档位翻动由 relChipRow 自己就地改。
          const xs = (n.getAttribute('data-xsig') || '').split('|');
          const paintedRt = xs[3] || '';
          if (paintedRt === (wantRt ? wantRt.shown : '')
            && badgeInGap(badgeGaps(host0, refEl, rr, hr0), nr.left, nr.right)) {
            cOk++;
            if (form0 === 'dot') cDot++; else if (wantRt) { cRatio++; if (wantRt.stale) cRatioOld++; }
            if (form0 === 'full' && !wantRt) cRatioNo++;
            if (n.getAttribute('data-xsig') !== sig) badgePaint(n, h, nameTxt, bad, form0, wantRt);
            return;
          }
        }
      }
      // ② 站不住（第一次挂 / 老位置被新出现的盒子占了 / 宿主被 React 回收）⇒ 重新挑宿主与落点
      let pick = badgePick(anchor, refEl, need);
      // 装不下的退让次序（v0.11.9 起回到两级）：先丢比例标签，最后只保那颗钮 —— 用户圈的位置是那颗标记，
      // 附加信息不许多到盖住页面自己的东西。关系标签不在这条链里了：它住在名字行，不占这条缝（上面已画）。
      if (rt && pick.place.form !== 'full') {
        rt = null; need = needOf(null);
        pick = badgePick(anchor, refEl, need);   // 退回去只量那颗钮：宁可少一个标签，也不许盖住页面自己的东西
      }
      if (!pick.host) {
        // 出不了也得分清为什么：④ 住在 X 的可点元素里（列表页整行就是一颗关注钮）与 空白真放不下
        // 是两回事，混在一个计数里就没法从面板判断「这页本来不该有」还是「我的算法没量到空白」（RL-11）。
        if (pick.cta) cCta++; else cNoFit++;
        if (n) { try { n.remove(); } catch (e) { /* React 已摘 */ } }   // 站不住的老颗：当场摘，别让它盖着东西等下一趟
        return;
      }
      const host = pick.host;
      const place = pick.place;
      if (!badgeEnsureHost(host)) return;
      const hr = geoRect(host) || { left: 0, top: 0, width: 0, height: 0 };
      cOk++;
      if (place.form === 'dot') cDot++;
      else if (rt) { cRatio++; if (rt.stale) cRatioOld++; }
      if (place.form === 'full' && !rt) cRatioNo++;
      if (n) {
        // 「挪」只记真的动了的：换了宿主层、或 left 变了。重挑一次而两层都一样 ⇒ 不算挪（这个数
        // 就是用户那句「还在跑吗」的仪表，掺水就白测了）。
        const an = badgeAnchor(place);
        const moved = n.parentNode !== host || String(n.style[an[0]] || '') !== an[1];
        if (n.parentNode !== host) { try { host.append(n); } catch (e) { return; } }
        if (moved) cMoved++;
      } else {
        // 新建：走 setAttribute 不走 className=：两边的 class 都能读到，自检桩也一样
        n = el('span');
        n.setAttribute('class', BLK_CLS);
        n.setAttribute('data-xprobe', 'blk');
        // 挂进宿主自己（不是名字锚旁边）：绝对定位的坐标由「最近的非 static 祖先」定，缝在名字锚里
        // 时那个祖先可能是 X 套的任何一层盒子，left 就不是我们算的那个数了。宿主是直父 ⇒ 坐标系唯一。
        // ⚠ 宿主是这一行的容器、不是 <a>，所以点徽标绝不触发导航（v0.8.4 立这条时就是这个理由）。
        try { host.append(n); } catch (e) { return; }
      }
      if (!badgePlace(n, host, place, rr, hr)) return;
      badgePaint(n, h, nameTxt, bad, place.form, rt);
    });
    // 趟末清孤儿：这一趟没有任何一行领走的自家节点 = 那一行已经不在这一页了（React 摘了行、筛帖了、
    // 或这一层现在判「放不下」）。只认自己的 data-xprobe 记号，X 的节点一个不碰。
    // 堆是开趟前一次 querySelectorAll 建的，所以这里不用再扫一遍文档，也能捞到挂在行**上层宿主**的那些。
    have.forEach((arr) => arr.forEach((x) => { try { x.remove(); } catch (e) { /* React 已摘 */ } }));
    perf.badgeOk = cOk; perf.badgeDots = cDot; perf.badgeNoFit = cNoFit; perf.badgeCta = cCta;
    perf.badgeMoved = cMoved; perf.badgeRatio = cRatio; perf.badgeRatioNo = cRatioNo; perf.badgeRatioOld = cRatioOld;
    perf.badgeRel = cRel; perf.badgeRelNo = cRelNo;
    perf.badgeFiber = cFb; perf.badgeFiberNo = cFbNo;
    if (fiberAsk.size) relFiberAsk(Array.from(fiberAsk));   // v0.11.8：问询带上缺读数的 handle 名单（桥只回这几个人，回包不再无界）
    // v0.9.1：同一趟顺手扫个人主页那颗标星（同一道闸、同一个限流，绝不为它开第二趟整文档扫描）
    benchBadgeScan();
  }
  // ---------- v0.11.4 功能二：AI 回帖卡片（右缘第七颗 + 复制） ----------
  // 三层授权里页面只管「入口与回执」：
  //   闸关着（或还没读到）⇒ 第七颗 display:none、卡片整棵不存在、连一条 modelDraft 都不发；
  //   闸开着 ⇒ 这一颗也只把「这一页那一条帖子的原文」交给 SW，出口仍只有原生宿主那一条。
  // core 这边没有第二条腿：不 fetch、不 XHR、manifest 也没为本机模型端口加过 host_permissions
  // （[35] 有静态判据钉这一句）。草稿只是**页面上的一段字**：改不改、贴不贴、发不发都是你的动作，
  // 这一腿永远不点页面里任何钮、不往回复框里写字（RL-1）。
  const AIBTN_ID = 'ysy-xprobe-ext-aibtn';
  const AICARD_ID = 'ysy-xprobe-ext-aicard';
  const AI_TEXT_MAX = 4000;      // 喂进去的原文顶：详情页一条帖子写不满它，超了截断并在卡片上如实说截了
  const AI_GATE_TTL = 60000;     // 读闸的兜底节拍：设置页翻闸那一刻 SW 会广播过来，这条只防广播丢
  let aiGate = null;             // null = 还没读到 ⇒ 一颗都不画（不拿「没读到」冒充「关着」，RL-11）
  let aiConf = null;             // 从 modelState 拿：超时那一格（等头用）+ 系统提示现值（✎ 编辑器预填用）
  let aiDefSystem = '';          // 预设那份系统提示（SW 的 MODEL_DEFAULT.system；配置留空时真正发出去的就是它）
  let aiGateAt = 0;
  let aiOpen = false, aiRoot = null, aiBusy = false, aiDraft = '', aiNote = '', aiNoteBad = false;
  let aiEditOpen = false, aiEditDraft = null, aiEditBusy = false;   // ✎ 提示词编辑器（v0.11.6）：开合/暂存字/在存标记
  let aiBtnApplied = '';         // 上一次真写进 DOM 的显隐（与「字面变了才动页面」同一条纪律）

  function aiGateOn() { return aiGate === true; }
  // 卡片上那颗钮的显隐是「第七颗在不在排里」的唯一答案；让位的账（flistBottomPx）也跟着它走
  function aiBtnShown() { return aiGateOn(); }
  function aiReadGate(force) {
    if (!force && aiGate !== null && Date.now() - aiGateAt < AI_GATE_TTL) return Promise.resolve(aiGate);
    aiGateAt = Date.now();
    return dbAsk({ t: 'modelState' }).then((r) => {
      if (!r || r.ok !== true) return aiGate;   // 没回话/后台坏了：保持原影子，不拿一次读失败判成「关」
      aiConf = (r.conf && typeof r.conf === 'object') ? r.conf : null;
      aiDefSystem = typeof r.defSystem === 'string' ? r.defSystem : '';   // 预设那份（✎ 编辑器预填用）
      return aiGateSet(r.conf.on === true, true);
    });
  }
  function aiGateSet(on, read) {
    const v = on === true;
    const changed = aiGate !== v;
    aiGate = v;
    if (!read) aiGateAt = Date.now();     // SW 广播过来的那一刻最权威，TTL 从它重算
    if (!v) {
      if (aiOpen) { aiOpen = false; aiBusy = false; }
      renderAi();                          // 闸一关就把卡片摘干净，留一个还能点的入口等于骗人
    }
    if (changed) fabBtn();                 // 那颗钮当场跟上（fabBtn 内部仍是「显隐变了才动 DOM」）
    return v;
  }
  // 「这一页那条帖子」只有一个说得清的地方 = 帖子详情页。首页/列表一屏好几条，选哪条都是猜 ⇒ 不猜。
  // 正文两条腿与「☆标此帖」同源：本机台账优先（抓取点存过的那份），页面现读兜底。
  function aiTarget() {
    if (tabName() !== 'tweet') return { why: '这一页不是帖子详情页（一屏好几条，选哪条都是猜）。点开一条帖子再回来点这颗。' };
    const id = String(statusIdFromPath(location.pathname) || '');
    if (!/^\d+$/.test(id)) return { why: '认不出这一页是哪条帖子（URL 里没有 /status/ 那串数字）。' };
    const p = posts[id] || {};
    const raw = String(p.text || benchPostTextSnap() || '');
    if (!raw.trim()) return { why: '这一页没读到帖子原文（正文还没渲染出来，或这条本来就没有字）。等它出来再点一次。' };
    const h = String(p.handle || handleFromPath(location.pathname) || '').replace(/^[@/]+/, '');
    return { id: id, handle: h, text: raw, cut: raw.length > AI_TEXT_MAX };
  }
  // 交出去的那段字：一副骨架——「写一条回复」 + 作者 + 原文。
  // v0.11.6：上一版拼在这里的「写成一个真人…」风格话与「你自己最近发过的 N 条」样本段全数撤走——
  // 风格契约整格搬进系统提示（预设住在 SW 的 MODEL_DEFAULT.system，卡片右上角 ✎ 与设置弹窗都能改，
  // 留空＝发预设）。用户点名撤掉「最近 10 条回复」那条查询：样本由用户自己放进提示词里管。
  // 页面手里仍然只有 prompt/system 这两格字，地址/端口/Key 一个都到不了这一层。
  function aiPrompt(t) {
    const body = t.cut ? String(t.text || '').slice(0, AI_TEXT_MAX) : String(t.text || '');
    return '下面是 X 上一条帖子的原文。请写一条可以发在它下面的回复（接得上话、别加引号、别解释你在做什么）。\n'
      + '作者：@' + (t.handle || '?') + '\n'
      + '原文：\n' + body
      + (t.cut ? '\n（原文 ' + String(t.text || '').length + ' 字，这里截到 ' + AI_TEXT_MAX + ' 字）' : '');
  }
  function aiAsk() {
    if (aiBusy) return Promise.resolve();
    const t = aiTarget();
    if (t.why) { aiNote = t.why; aiNoteBad = true; renderAi(); return Promise.resolve(); }
    aiBusy = true; aiNoteBad = false;
    aiNote = '在写…（原文 ' + String(t.text).length + ' 字发给本机模型，一个字节都不出这台机器）';
    renderAi();
    // 页面这一头的等头 = 配置那格的超时 + 8 秒余量（SW 里还有一层 native 超时，谁先炸都得有话说）
    const ms = aiConf && Number.isFinite(Number(aiConf.ms)) ? Number(aiConf.ms) + 8000 : 68000;
    return dbAsk({ t: 'modelDraft', prompt: aiPrompt(t) }, ms).then((r) => {
      aiBusy = false;
      if (!r) { aiNote = '后台没回话（超过 ' + Math.round(ms / 1000) + ' 秒）：这一趟当它断了，草稿没写进来'; aiNoteBad = true; }
      else if (r.ok !== true) { aiNote = String(r.err || '没写成'); aiNoteBad = true; }
      else {
        aiDraft = String(r.text || '');
        aiNote = aiDraft.trim()
          ? '写了 ' + aiDraft.length + ' 个字 · ' + Math.round((Number(r.ms) || 0) / 100) / 10 + ' 秒 · 走的是宿主'
            + (r.hostVer ? ' ' + r.hostVer : '')
          : '模型回了空草稿（换个模型或改改提示词——卡片右上角 ✎）';
        aiNoteBad = !aiDraft.trim();
      }
      renderAi();
    });
  }
  function aiCopyBtn() {
    const b = el('button', {
      background: UI_TOK.accBg, color: UI_TOK.acc, border: '1px solid ' + UI_TOK.accDim, borderRadius: '6px',
      cursor: 'pointer', font: 'inherit', padding: '1px 8px', lineHeight: '18px',
    }, '复制草稿');
    b.type = 'button';
    b.id = AICARD_ID + '-copy';
    b.title = '把草稿复制到剪贴板（只复制字；粘贴到哪、发不发都由你，这一腿不替你发）';
    b.addEventListener('click', () => {
      const s = String(aiDraft || '');
      const done = (okc, why) => {
        aiNote = okc ? '草稿已进剪贴板（' + s.length + ' 个字）：去回复框里粘贴、改、发' : '复制没成：' + why;
        aiNoteBad = !okc;
        renderAi();
      };
      if (!s.trim()) { done(false, '草稿是空的，剪贴板一个字都不该动'); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(s).then(() => done(true), () => done(false, '浏览器不肯给剪贴板（这一页里手动全选复制也一样）'));
        } else done(false, '这一页没有剪贴板接口（手动全选复制也一样）');
      } catch (e) { done(false, clip(e && e.message, 60) || '剪贴板抛了'); }
    });
    return b;
  }
  function aiCardBuild() {
    const t = aiTarget();
    // ✎ 展开时卡片会变高，右下角锚定会把顶部顶出屏幕外（真机 11-04 现场病）⇒ 展开期间改居中放：
    // 水平垂直都钉在视口正中，宽放一点、高上限放宽到 86vh（内部照旧自己滚）；收起编辑器回右下角。
    const cardSty = Object.assign({
      position: 'fixed', zIndex: '2147483647', background: UI_TOK.panel, backdropFilter: UI_TOK.blur, color: UI_TOK.ink,
      border: '1px solid ' + UI_TOK.line, borderRadius: UI_TOK.rPanel, padding: '10px 12px',
      font: '12px ui-monospace, Consolas, monospace', boxShadow: UI_TOK.shadow,
    }, aiEditOpen ? {
      left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
      width: '420px', maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto',
    } : {
      right: '14px', bottom: aiBottomPx() + 'px',
      width: '340px', maxHeight: '60vh', overflowY: 'auto',
    });
    const root = el('div', cardSty);
    root.id = AICARD_ID;
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' });
    head.append(uiTitle('AI 回帖'));
    head.append(el('span', { flex: '1' }));
    const hbtn = (label, tip, fn, color) => {
      const h = el('button', {
        background: 'transparent', color: color || UI_TOK.inkDim, border: '1px solid ' + UI_TOK.line,
        borderRadius: '6px', cursor: 'pointer', font: 'inherit', padding: '1px 7px', lineHeight: '18px',
      }, label);
      h.type = 'button'; h.title = tip;
      h.addEventListener('click', fn);
      return h;
    };
    head.append(hbtn(aiBusy ? '在写' : '写一稿', aiBusy ? '这一趟还在等本机模型回话（设置里那格超时多久就等多久，到点它自己说断了）'
      : '把这一页那条帖子的原文发给你自己机器上的模型，换一稿草稿（只发原文，不点页面任何钮）', () => aiAsk(),
      aiBusy ? UI_TOK.amber : UI_TOK.acc));
    head.append(hbtn('✎', '改提示词（系统提示那一格；留空＝发预设那份）· 改完下一次「写一稿」就按它写', () => {
      aiEditOpen = !aiEditOpen;
      aiEditDraft = null;          // 每次展开都按现值重填，不留上一回没存的残字
      renderAi();
    }));
    head.append(hbtn('×', '收起卡片（整棵从页面摘掉；草稿跟着没——要留先复制走）', () => { aiOpen = false; renderAi(); }));
    root.append(head);

    // ✎ 提示词编辑器（v0.11.6）：直接在卡片里改「系统提示」，存进本机存储（modelSet），下一次「写一稿」生效。
    // 预填 = 配置现值；配置留空时真正发出去的是预设那份（SW 的 MODEL_DEFAULT.system），所以预填也给你看预设，
    // 免得「我以为留空=没提示词」。这格只是字——本机存储收，照样不碰地址/端口/Key（RL-1）。
    if (aiEditOpen) {
      const wrap = el('div', {
        marginTop: '4px', marginBottom: '4px', border: '1px solid ' + UI_TOK.accDim, borderRadius: '8px',
        padding: '6px 8px', background: UI_TOK.bg,
      });
      wrap.id = AICARD_ID + '-syswrap';
      const lab = el('div', { color: UI_TOK.inkDim, marginBottom: '4px' },
        '提示词（系统提示）· 留空＝发预设 · 换行保留');
      const ta = el('textarea', {
        width: '100%', minHeight: '150px', background: UI_TOK.bg, color: UI_TOK.ink,
        border: '1px solid ' + UI_TOK.line, borderRadius: '6px', padding: '4px 6px',
        font: 'inherit', resize: 'vertical', boxSizing: 'border-box',
      }, '');
      ta.id = AICARD_ID + '-sys';
      ta.value = aiEditDraft != null ? aiEditDraft
        : String((aiConf && aiConf.system) || aiDefSystem || '');
      ta.placeholder = '留空＝发预设（SW 里那份带正例/反例的去 AI 味提示词）';
      ta.addEventListener('input', () => { aiEditDraft = String(ta.value || ''); });
      const row = el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' });
      const save = hbtn('存提示词', '存进本机存储（下一次「写一稿」就按它写）', () => {
        if (aiEditBusy) return;
        aiEditBusy = true;
        const val = String(ta.value || '');
        const statEl = document.getElementById(AICARD_ID + '-sysnote');
        if (statEl) statEl.textContent = '在存…';
        dbAsk({ t: 'modelSet', system: val }, 10000).then((r) => {
          aiEditBusy = false;
          const s2 = document.getElementById(AICARD_ID + '-sysnote');
          if (!r || r.ok !== true) {
            if (s2) { s2.textContent = '没存进去：' + ((r && r.err) || '后台没回话'); s2.style.color = UI_TOK.red; }
          } else {
            aiConf = Object.assign({}, aiConf, { system: val });   // 本地那份现值跟上（不整趟重问）
            if (s2) { s2.textContent = '已存（' + val.length + ' 字）· 下一次「写一稿」就按它写'; s2.style.color = UI_TOK.acc; }
          }
        });
      }, UI_TOK.acc);
      const shut = hbtn('收起', '不改了：编辑框收起来（没存的不留）', () => { aiEditOpen = false; aiEditDraft = null; renderAi(); });
      row.append(save, shut);
      const stat = el('span', { flex: '1', fontSize: '11px', color: UI_TOK.inkFaint, textAlign: 'right' }, '');
      stat.id = AICARD_ID + '-sysnote';   // id 要建后赋值：el() 的样式表只认 CSS 属性，'id' 塞在里面不会真挂上去
      row.append(stat);
      wrap.append(lab, ta, row);
      root.append(wrap);
    }

    // 目标行：说清「这一趟要发的是哪一条」，而不是让人猜卡片看上了哪条
    const goal = el('div', { color: UI_TOK.inkDim, marginBottom: '4px' }, t.why
      ? '没有目标：' + t.why
      : '@' + (t.handle || '?') + ' · 帖子 ' + t.id + ' · 正文 ' + String(t.text).length + ' 字' + (t.cut ? '（超 ' + AI_TEXT_MAX + ' 字，截断后发）' : ''));
    root.append(goal);

    if (!t.why) {
      const pre = el('div', {
        background: UI_TOK.bg, border: '1px solid ' + UI_TOK.line, borderRadius: '8px', padding: '6px 8px',
        maxHeight: '120px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: UI_TOK.ink,
      }, t.text);
      pre.id = AICARD_ID + '-src';
      root.append(pre);
    }

    const box = el('textarea', {
      width: '100%', minHeight: '120px', marginTop: '6px', background: UI_TOK.bg, color: UI_TOK.ink,
      border: '1px solid ' + (aiDraft.trim() ? UI_TOK.accDim : UI_TOK.line), borderRadius: '8px',
      padding: '6px 8px', font: 'inherit', resize: 'vertical', boxSizing: 'border-box',
    }, '');
    box.id = AICARD_ID + '-draft';
    box.value = aiDraft;
    box.readOnly = false;
    box.placeholder = aiBusy ? '在写…' : '（还没写过草稿——点上面「写一稿」）';
    // 用户在这一格里改的字要活过下一次重画：改一下就拿它当最新草稿，重画时原样填回去
    box.addEventListener('input', () => { aiDraft = String(box.value || ''); });
    root.append(box);

    const foot = el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' });
    foot.append(aiCopyBtn());
    foot.append(el('span', { flex: '1' }));
    foot.append(el('span', { color: UI_TOK.inkFaint, fontSize: '11px' }, aiDraft.length + ' 字'));
    root.append(foot);

    const note = el('div', { color: aiNoteBad ? UI_TOK.red : (aiNote ? UI_TOK.acc : UI_TOK.inkFaint), paddingTop: '6px' },
      aiNote || '闸开着（设置里那颗）· 只打本机端口 · 草稿不替你发 · v' + VER);
    note.id = AICARD_ID + '-note';
    root.append(note);
    return root;
  }
  function renderAi() {
    if (aiRoot) aiRoot.remove();
    aiRoot = (aiOpen && aiGateOn()) ? aiCardBuild() : null;
    if (aiRoot) document.documentElement.appendChild(aiRoot);
  }
  function toggleAiCard() {
    if (!aiGateOn()) {           // 读到了才该看见这颗；看不见却点到（键盘 Tab 进过隐藏钮）就说清为什么
      aiGateReadPrompt();
      return;
    }
    aiOpen = !aiOpen;
    if (aiOpen && aiGate === null) aiReadGate(false);
    renderAi();
  }
  function aiGateReadPrompt() {
    aiReadGate(true).then((on) => {
      if (on === true) { aiOpen = true; renderAi(); return; }
      aiOpen = false; aiNote = '本机模型那颗闸是关的（设置页「本机模型」翻开才会有这一腿）'; aiNoteBad = true;
      renderAi();
    });
  }
  function aiBottomPx() { return flistBottomPx(); }   // 与两张窗口同一档：都顶在钮排之上

  function fabBtn() {
    // v0.8.5 钮排：守卫灯（v0.8.15 起：可以关注=绿「观」，冷却/到顶=圆圈里读秒）、榜（曝光榜卡片）、回（待回关）、关（本页用户列表）——
    // 原来一颗浮标既当灯又当卡片开关，功能堆在一颗上说不清。四颗同排（关/榜/回/观，灯贴角），各管各的。
    // v0.9.5「观测站仪表」重排（用户拍板的原型 design/ui-redesign-proposal.html）：整列住进一根玻璃柱
    // （UI_TOK.panel + blur + 发丝线），顶部一颗呼吸的探针圆点；六颗一律等大圆钮，双字钮（标杆/标帖）竖排——
    // 以前「回/标杆/标帖」三颗是胶囊、其余是圆，三种形状各量各的宽，这就是用户嫌丑的根源；个数挪到右上角
    // 小角标上，钮面永远只有一个词。组与组之间发丝线分隔；开着的面板对应的钮点亮（绿字 + 左缘刻线）。
    fabMeasure();   // 尺寸先定（量到/回落/已定过都会立刻返回），排第一次建起笔就是对的直径
    let bar = document.getElementById(FABBAR_ID);
    if (!bar) {
      // X 新版在右缘自带一列悬浮钮（举报/聊天/头像，从底往上占约 190px）——bottom:210 会正好让开。
      // 竖排贴同一条边、从它们上方起排：加栏不加宽，与页面自带的列对齐而不是叠在上面。
      bar = el('div', {
        position: 'fixed', right: '14px', bottom: '210px', zIndex: '2147483647',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
        background: UI_TOK.panel, backdropFilter: UI_TOK.blur, border: '1px solid ' + UI_TOK.line,
        borderRadius: UI_TOK.rRail, padding: '9px 7px', boxShadow: UI_TOK.shadow,
      });
      bar.id = FABBAR_ID;
      // 悬停/点亮态只对自家柱内生效（class 名挂在自家 fixed 节点上，与 FABBAR_ID 同一面暴露——
      // 都是我们自己的面板，不是缝进 X 的 DOM 的东西，不归 RL-16 那道闸管）
      // 方案 A 的「认得出」：全称住进 data-tip，hover 时由 ::after 绝对定位向左浮出。
      // 两条硬规矩（v0.8.12 真机账）：① 标签向左出，不被 x.com 右缘裁掉；② 脱离文档流，
      // 轨道宽度恒定、展开不挤动其它行。伪元素不进 textContent、不占节点数，自检的拼接判据不受影响。
      bar.appendChild(el('style', {}, '#' + FABBAR_ID + ' .ysy-fab:hover{background:rgba(26,34,44,.95)}'
        + '#' + FABBAR_ID + ' .ysy-fab::after{content:attr(data-tip);position:absolute;'
        +   'right:calc(100% + 8px);top:50%;z-index:2;pointer-events:none;white-space:nowrap;'
        +   'font:12px system-ui,sans-serif;line-height:1.4;padding:6px 10px;border-radius:5px;'
        +   'color:' + UI_TOK.ink + ';background:' + UI_TOK.tipBg + ';border:1px solid ' + UI_TOK.line + ';'
        +   'opacity:0;visibility:hidden;transform:translateY(-50%) translateX(6px);'
        +   'transition:opacity .18s ease,transform .18s ease,visibility .18s}'
        + '#' + FABBAR_ID + ' .ysy-fab:hover::after{opacity:1;visibility:visible;transform:translateY(-50%) translateX(0)}'
        + '#' + FABBAR_ID + ' .ysy-fab-on{border-color:' + UI_TOK.accDim
        + ';box-shadow:inset 2px 0 0 0 ' + UI_TOK.acc + ',' + UI_TOK.shadow + '}'
        + '@keyframes ysyFabPulse{0%,100%{opacity:.35}50%{opacity:1}}'
        + '#' + FABBAR_ID + ' .ysy-dot{animation:ysyFabPulse 2.4s ease-in-out infinite}'));
      // 探针圆点：整列在跑的那颗心跳（纯样式动画，不派事件、不请求）
      const dot = el('div', {
        width: '6px', height: '6px', borderRadius: '50%', background: UI_TOK.acc, margin: '2px 0 2px',
      }, '');
      dot.setAttribute('class', 'ysy-dot');
      bar.appendChild(dot);
      const sep = () => el('div', { width: '1px', height: '10px', background: UI_TOK.line, borderRadius: '1px', margin: '1px 0' }, '');
      const mk = (id, label, full, tip, fn) => {
        const x = el('button', FAB_STY, '');
        x.id = id; x.type = 'button'; x.title = tip; x.setAttribute('class', 'ysy-fab');
        x.setAttribute('data-tip', full);
        x.style.position = 'relative';
        x.style.display = 'flex'; x.style.alignItems = 'center'; x.style.justifyContent = 'center';
        x.style.lineHeight = '1.1';
        fabLab[id] = fabParts(x, label);
        x.addEventListener('click', fn);
        return x;
      };
      bar.append(mk(FBTN_ID, '关', '本页用户名单', '本页用户列表（已关注/未关注切换；点条目滚动到那条帖子的位置，不导航）', toggleFlist));
      bar.append(mk(CBTN_ID, '榜', '本页曝光榜', '开/收本页曝光榜卡片（右上角；详面板在卡片头「详」）', toggleCard));
      // v0.11.18 art-020 第八颗：本页热点（按每小时浏览量排榜；点条目只在榜内高亮、不滚动页面）。
      bar.append(mk(HOTBTN_ID, '热', '本页热点', '本页热点榜：把当前页面已加载的推文按每小时浏览量降序排列；只读 DOM、只在本机算，点条目只在榜内高亮、不滚动页面', hotToggle));
      bar.append(mk(RBTN_ID, '回', '待回关', '', openFollowback));
      // v0.9.0 第五颗：标杆窗口（人数在右上角小角标；方案 A 起钮面单字「杆」，全称在 hover 标签）
      bar.append(mk(BBTN_ID, '杆', '标杆账号', '标杆名单窗口（**按人**的那本账，与下面「标帖」那本按条的账分开；'
        + '按粉丝/曝光等排序，打开就按上次选的轴排好；'
        + '点某行在下方展开 TA 的帖子；分类在这一窗里改。只读台账与本机库，不滚页面、不导航、不请求 X）', toggleBench));
      // v0.9.3 第六颗：标杆帖子窗口（用户点名「右下角分别是标杆账号、标杆帖子，点账号开账号的窗、点帖子开帖子的窗」）
      bar.append(mk(BPBTN_ID, '帖', '标杆帖子', '标杆帖子窗口（这条帖子的账，与上面「标杆」那本按人的账是分开的两本；'
        + '按曝光/评论/赞/互动/发帖时间排序，打开就按上次选的那根轴排好。只读台账与本机库，不滚页面、不导航、不请求 X）', toggleBenchP));
      // v0.11.4 第七颗：AI 回帖。这颗与前面六颗唯一的不同是**按闸显隐**——设置里「本机模型」关着时它
      // display:none（节点常驻、不占位，与徽标那种「缝进页面」不是一回事），开着才露面。
      // 关着还留一颗能点的入口 = 骗人去点一条注定不发请求的路；整颗摘掉又会在排里跳位，所以是显隐。
      const aiEl = mk(AIBTN_ID, '稿', 'AI 回帖草稿', 'AI 回帖草稿（只有帖子详情页那一条帖子有明确目标；把它的原文发给你自己机器上的模型，'
        + '换一稿草稿让你复制到回复框里。草稿只是页面上的一段字：改不改、贴不贴、发不发都是你的动作——'
        + '这一腿不点页面任何钮、不往回复框写字，请求也只走原生宿主那一条回环出口）', toggleAiCard);
      aiEl.style.display = aiGateOn() ? 'flex' : 'none';
      aiBtnApplied = aiGateOn() ? 'flex' : 'none';
      bar.append(aiEl);
      bar.append(sep());
      bar.append(mk(FAB_ID, '观', '打开探针面板', '', openPanel));
      document.documentElement.appendChild(bar);
    }
    fabApplySize();   // 只在直径真变了的那一趟写样式（第一趟建排时也在这一笔起笔）
    // 角标按节拍刷新（只在数字真变的时候动 DOM，与浮标同纪律）；点钮 = 名单直接跳到待回关页签
    const rb2 = document.getElementById(RBTN_ID);
    if (rb2) {
      const n = followbackCount();
      if (rb2.textContent !== '回' + (n ? n : '')) {
        fabCountSet(RBTN_ID, n);
        rb2.title = '待回关 ' + n + ' 人：TA 关注了你、你还没回关（全库口径，去掉已拉黑；账来自你进过的粉丝列表页）。'
          + '点这里在名单「未关」那一列里只看这些人（v0.11.3：待回关不再是单独一列，并进未关）；再点一下取消筛选。';
      }
    }
    // v0.9.0：标杆人数同样在角标上（字面变了才动 DOM，与「回」/灯同一条纪律）
    const bb2 = document.getElementById(BBTN_ID);
    if (bb2 && bb2.textContent !== benchFabText()) fabCountSet(BBTN_ID, benchCount());
    // v0.9.3：标帖条数同一条纪律（两排在一起，字面各说各的：标杆=人、标帖=条）
    const bp2 = document.getElementById(BPBTN_ID);
    if (bp2 && bp2.textContent !== benchPFabText()) fabCountSet(BPBTN_ID, benchPCount());
    // v0.11.4 第七颗的显隐（只在闸的影子真翻了那一趟写一次，其余趟一个字不动 DOM——与角标同纪律）
    const aiWant = aiBtnShown() ? 'flex' : 'none';
    if (aiBtnApplied !== aiWant) {
      const an = document.getElementById(AIBTN_ID);
      if (an) an.style.display = aiWant;
      aiBtnApplied = aiWant;
    }
    // 开着的面板对应的钮点亮（v0.9.5）：绿字 + 左缘刻线（style 里的 .ysy-fab-on）。
    // 花名册只在变的那一趟写——节拍器每 1.2 秒路过一次，没变就不写。
    const act = [
      [FBTN_ID, flistOpen && !flistFb],
      [RBTN_ID, flistOpen && flistFb],
      [CBTN_ID, cardOpen],
      [HOTBTN_ID, hotListOpen],
      [BBTN_ID, benchOpen],
      [BPBTN_ID, benchPOpen],
      [AIBTN_ID, aiOpen],
    ];
    let asig = '';
    act.forEach((p) => { if (p[1]) asig += p[0] + ','; });
    if (asig !== fabActApplied) {
      fabActApplied = asig;
      act.forEach((p) => {
        const n = document.getElementById(p[0]);
        if (!n) return;
        n.setAttribute('class', p[1] ? 'ysy-fab ysy-fab-on' : 'ysy-fab');
        n.style.color = p[1] ? UI_TOK.acc : UI_TOK.inkDim;
      });
    }
    return fabLight();
  }
  // 角标写手（v0.9.5）：n>0 时钮右上角挂一枚小数字，0/空时摘掉。button.textContent 拼出来
  // 永远是「词+数」（'标杆3'），自检钉的这串字面不变，变的只是它分两层住。
  function fabCountSet(id, n) {
    const b = document.getElementById(id);
    if (!b) return;
    const txt = n ? String(n) : '';
    if (!txt) {
      if (fabCnt[id]) { try { fabCnt[id].remove(); } catch (e) { /* 已被整棵重画摘掉 */ } fabCnt[id] = null; }
      return;
    }
    let c = fabCnt[id];
    if (!c || !c.parentNode) {
      c = el('span', {
        position: 'absolute', top: '-3px', right: '-4px', background: UI_TOK.bg,
        border: '1px solid ' + UI_TOK.line, color: UI_TOK.amber, font: '9px ' + FAB_FONT,
        lineHeight: '12px', padding: '0 3px', borderRadius: '7px',
      }, txt);
      b.appendChild(c);
      fabCnt[id] = c;
    } else if (c.textContent !== txt) {
      c.textContent = txt;
    }
  }
  // 灯本身单独成一个函数：读秒的 1 秒定时器只跑这一条腿（不去重扫待回关名单、也不再摸页面几何）。
  // 「每秒做的事」越少越好查，这是这条灯现在唯一的可观察节奏。
  function fabLight() {
    const b = document.getElementById(FAB_ID);
    const s = guardStatus();
    const bad = s.over15 || s.over24;
    const cool = !bad && s.coolLeft > 0;
    const peer = peerHost();
    // v0.8.15 三态：到顶=红底读秒（15 分钟/24 小时两档都到顶时取更近的那个）> 冷却中=橙底读秒 > 可以关注=绿「观」。
    // 「待」「限」两个字不要了，圈里直接是 68、67 这样的实时秒数 —— 这是用户点名的改法。
    // 它推翻了 v0.6.x 那条「页面里不许有会跳字的元素」：当时的理由是「每秒改一次字 = 给页面添一条可观察节奏」，
    // 现在这条节奏是用户自己要的，所以只松绑到「我自家那颗钮的文本」这一格，并且守住三条下限：
    // ① 只在冷却/到顶期间存在（最长几分钟，其余时间是静止的一个字）；② 写 DOM 仍要「看得见的那串字变了」才动，
    // 同一秒内节拍器（1.2s）与读秒（1s）两条腿一起进来也只写一次；③ 只改自己的文本与颜色字号，
    // 不碰 X 的节点、不派事件、不发请求、不改布局（fixed 排不参与页面排版）。精确到账的口径仍在面板顶部横幅。
    const cdMs = bad ? fabFreeMs(s) : (cool ? s.coolLeft : 0);
    const txt = (bad || cool) ? fabCd(cdMs) : '观';
    const color = bad ? UI_TOK.red : (cool ? UI_TOK.amber : (peer ? UI_TOK.amber : UI_TOK.acc));
    // 环形读秒（v0.9.5，用户拍板的原型：环走满一圈 = 冷却结束）：ring span 是一颗 conic-gradient
    // 进度盘，用 mask 挖成环带贴在钮外缘。绿「观」时不画环（没在等东西就别转）；到顶=红环走满；
    // 冷却=琥珀环按「已等掉的比例」长。进度只用两个已知的数推（60 秒基线 + 随机加时的总额，
    // 到顶时就是「等满了」）——不去猜库/定时器的内部账，估不准就让它走满，色的状态语义不变。
    let pct = 0;
    if (bad) pct = 100;
    else if (cool) {
      const total = 60000 + rndMaxGet() * 1000;
      pct = Math.max(2, Math.min(100, Math.round(100 * (1 - cdMs / total))));
    }
    fabBeatSet(bad || cool);   // 读秒的 1 秒定时器只在有秒可读时开着；翻回「观」立刻摘掉
    const title = 'X 观测探针 v' + VER + ' build ' + BUILD + '（' + HOST + '）\n' +
      '15分钟 ' + s.f15 + '/' + s.max15 + '  24小时 ' + s.f24 + '/' + s.max24 +
      (s.u24 ? '  取关流水 ' + s.u24 : '') + (s.watching ? '' : '  [observer 未起来]') +
      (bad ? '\n⛔ 额度已到顶：先停。圈里这串数就是「还要等多久」才腾出名额（到 15分钟/24小时哪一档、精确账在面板）。'
        : (cool ? '\n⏳ 冷却中：本轮是 60 秒基线 + 0~ ' + rndMaxGet() + ' 秒随机加时（已抽好）。圈里这串数就是剩余秒数。'
          : '\n✓ 可以关注（上一条已过冷却）。规则：60 秒基线 + 0~ ' + rndMaxGet() + ' 秒随机加时。')) +
      '\n到限与冷却都只警告，我不会拦你的点击。点这里发开 Side Panel 详面板（完整榜单/趋势/设置都在那边）。' +
      (peer ? '\n⚠ 同页检测到另一个宿主（油猴副本 #' + PEER_IDS.join('/#') + '）：各采一次、守卫台账被劈成两份 ⇒ 暴力猴里把它停用' : '');
    const sig = txt + '|' + color + '|' + pct + '|' + s.f15 + '/' + s.f24 + '|' + (s.watching ? 'w' : '-') + '|' + (b.parentNode ? '1' : '0') + '|' + (sinkOk === false ? 'D' : '-');
    if (fabApplied !== sig) {
      fabApplied = sig;
      // 结构（v0.9.5 两段式）：button 里是 [labelSpan][ringSpan?]。ring 没有文字 ⇒ b.textContent
      // 拼出来仍是「观/68」这串字面；字与色写在 label span 上（fabParts 建排时已挂好）。
      if ((bad || cool) && !fabRing) {
        fabRing = el('span', {
          position: 'absolute', top: '-4px', right: '-4px', bottom: '-4px', left: '-4px',
          borderRadius: '50%', display: 'none',
        }, '');
        b.appendChild(fabRing);          // 追加在 label 后面（绝对定位，贴在钮外缘、不占字的地）
      }
      if (fabRing) {
        if (bad || cool) {
          fabRing.style.display = 'block';
          fabRing.style.background = 'conic-gradient(' + color + ' ' + pct + '%, transparent 0)';
          // 环带：mask 挖空中心只留 3px 描边（-webkit-mask 给 Chromium，标准 mask 一并写）
          const m = 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))';
          fabRing.style.webkitMask = m;
          fabRing.style.mask = m;
        } else {
          fabRing.style.display = 'none';   // 翻绿不拔节点（反复插拔才是新的抖动），藏起来下次复用
        }
      }
      const lab = fabLab[FAB_ID];
      if (lab) {
        lab.textContent = txt;
        lab.style.color = color;
        lab.style.font = fabFontSty(fabSizeEff(), txt);   // 三位数比一个汉字宽 ⇒ 字号按字数退一档，数字不贴边
      } else {
        b.textContent = txt; b.style.color = color;        // 兜底（排不是 fabParts 建的旧存留节点）
      }
      // v0.6.9：日志通道断了以后页面这边原来什么都看不出来 —— 而「没日志」这件事必须让人当场看见，
      // 不然我下一轮只能对着一份空文件问「今天到底开过页面没有」。这里只翻描边，不加第二个字、
      // 不改灯上那串字（观/秒数是关注节奏的信号，不能被通道状态污染），也不拦任何东西。
      b.style.borderColor = sinkOk === false ? UI_TOK.red : UI_TOK.line;
      b.style.boxShadow = sinkOk === false ? UI_TOK.shadow + ', 0 0 0 3px rgba(224,108,96,.35)' : UI_TOK.shadow;
      b.title = title + (sinkOk === false ? '\n⚠ 日志通道断了（' + clip(lastSinkErr, 60) + '）：记录正在本机排队并落盘，恢复后补发。' : '');
    }
    return b;
  }
  // ---------- ART020 本页热度榜（口径参考，未复制代码）----------
  // 只把「当前 DOM 已经加载出来的」推文按每小时浏览量排榜；数据只从 DOM 读、只在本机算，
  // 不新增网络出口、不点击、不滚动。口径与阈值见 skills/SKILL.md RL-28。
  function hotFinite(x) { return isFinite(x) ? x : 0; }
  function hotFirstNum(src) {
    if (src == null) return null;
    // 千分位逗号、空格、NBSP(\u00a0)、窄不换行空格(\u202f) 一律去掉后取第一个整数。
    const s = String(src).replace(/[\u00a0\u202f,\s]/g, '');
    const m = s.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }
  function hotAllNums(src) {
    if (src == null) return [];
    const s = String(src).replace(/[\u00a0\u202f,\s]/g, '');
    return (s.match(/\d+/g) || []).map((x) => parseInt(x, 10));
  }
  function hotFmt(n) {
    if (!isFinite(n)) return '—';
    n = Math.round(n);
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';   // 12,000 → 12k（整k不带小数）
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';  // 1,000 → 1.0k
    return String(n);
  }
  function hotTier(v) {
    if (v >= 10000) return { key: 'viral', color: UI_TOK.red, icon: '🔥' };
    if (v >= 1000) return { key: 'trending', color: UI_TOK.amber, icon: '🚀' };
    return { key: 'normal', color: UI_TOK.acc, icon: '🌱' };
  }
  function hotScore(f, velocity) {
    const v = f.views > 0 ? f.views : 1;
    const l = f.likes > 0 ? f.likes : 1;
    const s = 40 * Math.min(hotFinite(velocity / 50000), 1)
            + 25 * Math.min(hotFinite(((f.likes + f.rt + f.replies) / v) / 0.1), 1)
            + 20 * Math.min(hotFinite((f.rt / l) / 0.5), 1)
            + 15 * Math.min(hotFinite((f.bm / l) / 0.3), 1);
    return Math.min(Math.round(s), 100);
  }
  // 范围只认四类页面；其余（搜索/通知/设置等）返回空串 = 本页热点不生效。
  const HOT_RESERVED = { home: 1, i: 1, explore: 1, notifications: 1, messages: 1,
    bookmarks: 1, lists: 1, settings: 1, search: 1, compose: 1 };
  function hotScope(pathname) {
    const p = String(pathname || '');
    if (p === '/' || p === '/home') return 'home';
    if (/^\/i\/lists\/[^/]+/.test(p) || /^\/[^/]+\/lists\/[^/]+/.test(p)) return 'list';
    if (/^\/[^/]+\/status\/\d+/.test(p)) return 'status';
    const seg = p.replace(/^\/+/, '').split('/');
    if (seg.length === 1 && seg[0] && !HOT_RESERVED[seg[0].toLowerCase()]) return 'profile';
    return '';
  }
  // 首页有 tab 时以当前 aria-selected 的 tab 为准；取不到再回退 URL。
  function hotActiveScope(root) {
    const base = hotScope(location.pathname);
    if (base !== 'home') return base;
    const tabs = (root || document).querySelectorAll('[role="tab"][aria-selected="true"]') || [];
    for (let i = 0; i < tabs.length; i++) {
      const t = txt(tabs[i]);
      if (/为你推荐|For you|For You|正在关注|Following/i.test(t)) return 'home';
    }
    return base;
  }
  // 从一条 article 按 RL-28 口径抓字段。closest 过滤保证只认「属于本条推文」的节点，不抓嵌套引用推的数字。
  function hotParseArticle(art, now, promotedIds) {
    if (!art) return null;
    let tid = '';
    const links = art.querySelectorAll('a[href*="/status/"]') || [];
    for (let i = 0; i < links.length; i++) {
      const mm = String(links[i].getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (mm) { tid = mm[1]; break; }
    }
    function own(node) { return !!(node && node.closest && node.closest('article[data-testid="tweet"]') === art); }
    function qs(sel) { const n = art.querySelector(sel); return own(n) ? n : null; }
    // 推广：placementTracking 或「Ad / 推广 / Promoted」标记，或命中调用方给的 id 集合。
    const promMark = art.querySelector('[data-testid="placementTracking"]')
      || /推广|\bAd\b|\bPromoted\b/i.test(String(art.textContent || '').slice(0, 80));
    if (promMark || (promotedIds && promotedIds[tid])) return { skip: 'promoted', tid: tid };
    // views：专属 analytics 链接的 aria-label 首数字；没有就记 miss（不编 0）。
    let viewEl = null;
    const analytics = art.querySelectorAll('a[href*="/analytics"]') || [];
    for (let j = 0; j < analytics.length; j++) {
      const h = String(analytics[j].getAttribute('href') || '');
      if (own(analytics[j]) && (!tid || h.indexOf('/status/' + tid + '/analytics') >= 0)) { viewEl = analytics[j]; break; }
    }
    const views = viewEl ? hotFirstNum(viewEl.getAttribute('aria-label')) : null;
    const timeEl = qs('time[datetime]');
    const dt = timeEl ? timeEl.getAttribute('datetime') : '';
    const createdMs = dt ? Date.parse(dt) : NaN;
    if (views == null || !(createdMs > 0)) return { skip: 'missing', tid: tid, views: views, dt: dt || null };
    const hours = Math.max((now - createdMs) / 3600000, 0.1);
    const velocity = views / hours;
    const likeEl = qs('[data-testid="like"], [data-testid="unlike"]');
    const rtEl = qs('[data-testid="retweet"]');
    const repEl = qs('[data-testid="reply"]');
    const likes = likeEl ? (hotFirstNum(likeEl.getAttribute('aria-label')) || 0) : 0;
    const rt = rtEl ? (hotFirstNum(rtEl.getAttribute('aria-label')) || 0) : 0;
    const replies = repEl ? (hotFirstNum(repEl.getAttribute('aria-label')) || 0) : 0;
    const groupEl = qs('[role="group"]');
    const gnums = groupEl ? hotAllNums(groupEl.getAttribute('aria-label')) : [];
    const bm = gnums.length >= 5 ? gnums[gnums.length - 2] : 0;
    // 用户名：显示名第一段 → @handle → 正文前 60 字。
    let name = '';
    const nameEl = qs('[data-testid="User-Name"]');
    if (nameEl) name = txt(nameEl).split(/[\s@·]/).filter(Boolean)[0] || '';
    if (!name) {
      const ha = qs('a[href^="/"]');
      const hm = ha && String(ha.getAttribute('href') || '').match(/^\/([^/]+)/);
      name = hm ? '@' + hm[1] : '';
    }
    const textEl = qs('[data-testid="tweetText"]');
    const text = textEl ? txt(textEl) : '';
    if (!name) name = clip(text, 60);
    const f = { views: views, likes: likes, rt: rt, replies: replies, bm: bm };
    const tier = hotTier(velocity);
    return {
      tid: tid, name: name, text: clip(text, 200), views: views, likes: likes, rt: rt, replies: replies,
      bm: bm, createdMs: createdMs, hours: hours, velocity: velocity, score: hotScore(f, velocity),
      tier: tier.key, color: tier.color, icon: tier.icon,
      viewLabel: hotFmt(views), velLabel: hotFmt(velocity) + '/h',
    };
  }
  // 扫当前 DOM 全部 article → 按 tid 去重 → 排推广 → 按 velocity 降序 → 取前 N。
  // miss/cov/promoted 如实计数：缺 views 或缺时间的推文直接不进榜、不填 0。
  function hotBoard(now, opts) {
    const o = opts || {};
    const n = Math.max(1, Math.min(100, Number(o.limit || 10)));
    const at = now == null ? Date.now() : now;
    const arts = Array.prototype.slice.call(document.querySelectorAll('article[data-testid="tweet"]') || []);
    const seen = Object.create(null);
    const rows = [];
    let miss = 0, promoted = 0;
    arts.forEach((art) => {
      const r = hotParseArticle(art, at, o.promotedIds || null);
      if (!r || r.skip) { if (r && r.skip === 'promoted') promoted++; else miss++; return; }
      if (seen[r.tid]) return;   // 虚拟列表回收后同一 id 重现，只算一次
      seen[r.tid] = 1;
      rows.push(r);
    });
    rows.sort((a, b) => b.velocity - a.velocity || b.views - a.views);
    return { scope: hotActiveScope(o.root), cov: arts.length, miss: miss, promoted: promoted,
      total: rows.length, rows: rows.slice(0, n) };
  }
  // 推文内流速徽标：独立总闸，默认关；开才挂、关当场摘净（RL-16）。只认自家 class/data-xprobe。
  function hotBadgeGet() { try { return GM_getValue(HOT_BADGE_KEY, false) === true; } catch (e) { return false; } }
  function hotBadgeSweep() {
    let n = 0;
    try {
      (document.querySelectorAll('.' + HOT_BADGE_CLS + ', [data-xprobe="hotvel"]') || []).forEach((x) => {
        try { x.remove(); n++; } catch (e) { /* 已被 React 摘掉 */ }
      });
    } catch (e) { /* 选择器抛了下一轮再摘 */ }
    return n;
  }
  function hotBadgeRender() {
    if (!hotBadgeGet()) return 0;
    const board = hotBoard(Date.now(), { limit: 1000 });
    const byTid = Object.create(null);
    board.rows.forEach((r) => { byTid[r.tid] = r; });
    const arts = document.querySelectorAll('article[data-testid="tweet"]') || [];
    let made = 0;
    arts.forEach((art) => {
      let tid = '';
      const links = art.querySelectorAll('a[href*="/status/"]') || [];
      for (let i = 0; i < links.length; i++) {
        const m = String(links[i].getAttribute('href') || '').match(/\/status\/(\d+)/);
        if (m) { tid = m[1]; break; }
      }
      const r = byTid[tid];
      if (!r || art.querySelector('.' + HOT_BADGE_CLS)) return;
      const b = el('span', { position: 'absolute', right: '0', top: '0', zIndex: '2',
        font: '10px ' + FAB_FONT, color: r.color, background: UI_TOK.bg,
        padding: '1px 3px', borderRadius: '4px', border: '1px solid ' + UI_TOK.line }, r.icon + ' ' + r.velLabel);
      b.setAttribute('class', HOT_BADGE_CLS);
      b.setAttribute('data-xprobe', 'hotvel');
      art.appendChild(b);
      made++;
    });
    return made;
  }
  function setHotBadge(v) {
    const on = !!v;
    try { GM_setValue(HOT_BADGE_KEY, on); } catch (e) { /* 存不进本次会话内生效 */ }
    if (on) hotBadgeRender(); else hotBadgeSweep();
    return { ok: true, hotbadge: on };
  }
  function hotBadgeAuto() { if (hotBadgeGet()) hotBadgeRender(); }
  // 展开列表：挂在右缘那一列（documentElement 下的 fixed 浮层），不新建全屏层、不贴边隐藏、不可拖动。
  let hotListOpen = false;
  let hotListRoot = null;
  function hotListBuild() {
    const board = hotBoard(Date.now(), { limit: 10 });
    const root = el('div', { position: 'fixed', right: '14px', bottom: '286px', width: '344px',
      maxHeight: '62vh', overflowY: 'auto', zIndex: '2147483647', background: UI_TOK.panel,
      backdropFilter: UI_TOK.blur, border: '1px solid ' + UI_TOK.line, borderRadius: UI_TOK.rPanel,
      padding: '10px 12px', boxShadow: UI_TOK.shadow, font: UI_TOK.font, color: UI_TOK.ink }, '');
    root.id = HOTLIST_ID;
    root.appendChild(uiTitle('本页热点'));
    root.appendChild(el('div', { color: UI_TOK.inkFaint, margin: '4px 0 8px' },
      '范围=' + (board.scope || '不适用') + ' · 覆盖 ' + board.cov + ' 条 · 入榜 ' + board.total
      + ' · 缺数 ' + board.miss + ' · 推广剔 ' + board.promoted + ' · 按流速降序 · v' + VER));
    if (!board.scope) root.appendChild(el('div', { color: UI_TOK.amber }, '当前页面不属于本页热点范围（首页/列表/主页/帖子页生效）'));
    board.rows.forEach((r, i) => {
      const row = el('div', { padding: '6px 4px', borderTop: '1px solid ' + UI_TOK.lineSoft }, '');
      row.setAttribute('class', 'ysy-hot-row');
      row.setAttribute('data-hot-id', r.tid);
      const top = el('div', { display: 'flex', gap: '8px', alignItems: 'baseline' }, '');
      top.append(el('span', { color: UI_TOK.inkDim }, '#' + (i + 1)));
      top.append(el('span', { color: r.color }, r.icon));
      top.append(el('span', { color: UI_TOK.ink }, clip(r.name, 22)));
      top.append(el('span', { color: UI_TOK.amber }, hotFmt(r.views)));
      top.append(el('span', { color: r.color }, r.velLabel));
      row.appendChild(top);
      row.appendChild(el('div', { color: UI_TOK.inkDim, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', marginTop: '2px' }, clip(r.text, 30)));
      // 点条目只在本列表内高亮，绝不滚动页面（RL-1）：不调浏览器的元素滚入视图方法、不改 scrollY。
      row.addEventListener('click', () => {
        (root.querySelectorAll('.ysy-hot-row') || []).forEach((x) => x.setAttribute('class', 'ysy-hot-row'));
        row.setAttribute('class', 'ysy-hot-row ysy-hot-on');
      });
      root.appendChild(row);
    });
    return root;
  }
  function renderHotList() {
    if (hotListRoot) { hotListRoot.remove(); hotListRoot = null; }
    hotListRoot = hotListOpen ? hotListBuild() : null;
    if (hotListRoot) document.documentElement.appendChild(hotListRoot);
  }
  function hotToggle() { hotListOpen = !hotListOpen; renderHotList(); }

  function render() { fabBtn(); renderBlocks(); }

  // ---------- 调试开关（v0.6.8）----------
  // 开关存在 GM 里（面板开页面就跟着回读）。调试页打开时面板会把「这一眼看见的全部内容」
  // 作为一条 kind=debug 记录落进本机日志——日志里要能还原调试页的样子，下一轮迭代才有得对。
  function debugGet() {
    try { return GM_getValue(DEBUG_KEY, false) === true; } catch (e) { return false; }
  }
  function setDebugOn(v) {
    try { GM_setValue(DEBUG_KEY, !!v); } catch (e) { /* 同上 */ }
    const on = !!v;
    if (on) {
      // 开关拨到「开」的这一眼当场落一条，不等人去点诊断页（不然第一份数据可能要等下一个节拍）
      const dg = debugDigest(); dg.why = 'on'; logRec('debug', dg);
      lastDebugAt = Date.now();
    } else lastDebugAt = 0;
    return { ok: true, debug: on };
  }
  // 调试开着时的自报节拍：开机、开诊断页之外再补一个时间轴上的第三、第四、第 N 个点。
  // 没有它，日志里只有「开机那一刻」和「用户点开面板那一刻」两个孤立点，中间发生的事（通道翻转、
  // 表顶满、队列积压）全都只能靠相邻 kind 的记录倒推——「持续迭代」要的是能对着时间轴看的账。
  const DEBUG_EVERY = 10 * 60 * 1000;
  let lastDebugAt = 0;
  function debugTick() {
    if (!debugGet()) { lastDebugAt = 0; return; }
    if (Date.now() - lastDebugAt < DEBUG_EVERY) return;
    lastDebugAt = Date.now();
    const dg = debugDigest(); dg.why = 'tick'; logRec('debug', dg);
  }
  function debugDigest() {
    const c = queryStores(''), g = guardStatus();
    return {
      env: { href: clip(location.href, 200), tab: tabName(), own: ownHandle(), peer: peerHost(), badge: badgeGet(),
             // v0.8.15：浮标直径是「量出来的」还是「量不到回落的」，日志里要分得开 —— 用户说「还是小」时，
             // 这一格直接回答是没量到（fallback）还是量到了但那一列本来就小（x），不用猜。
             fab: fabSizeEff() + '/' + fabSizeSrc() + '/' + fabTries,
             // v0.9.0：标杆窗口的账 = 本机台账几人 / 库回了几行（'-' = 这一页还没开过窗口问过库）。
             // 用户报「名单是空的」时，这一格分清是「没标过人」还是「标了但库没落账/没回话」，不用猜。
             bench: benchCount() + '/' + (benchData && Array.isArray(benchData.rows) ? benchData.rows.length : '-') },
      guard: { f15: g.f15, max15: g.max15, f24: g.f24, max24: g.max24, u15: g.u15, u24: g.u24,
               over15: g.over15, over24: g.over24, watching: g.watching, events: guard.ev.length, ev: guard.ev.slice(-12) },
      counters: { users: c.counts.users, posts: c.counts.posts, runs: loadRuns().length },
      caps: { coolMs: COOL_MS, rndMax: rndMaxGet(), runsFull: RUNS_FULL, runsSlim: RUNS_SLIM, runsKeep: RUNS_KEEP,
              runsByteCap: RUNS_BYTES_CAP, usersMax: USERS_MAX, postsMax: POSTS_MAX,
              queueMax: QUEUE_MAX, queueByteCap: QUEUE_BYTES_CAP, queueSlots: 4, queueDropMs: QUEUE_DROP_MS },
      sink: { ok: sinkOk, err: lastSinkErr, posted: posted, qlen: queue.length, chan: lastChan,
              db: lastPingInfo ? (lastPingInfo.db || null) : null, q: queueStat() },
      storage: storeStat(), runsMeta: runsMeta, trim: trimMeta,
      // v0.8.7 性能账：卡顿不再靠猜——观察器跑了多少趟/丢了多少批/最重的一趟多少毫秒、
      // 补采有没有被推到安静边沿、落表与徽标各花多少，重载扩展后滚一趟评论区就能对着看。
      perf: perfLine(),
      series: { counts: seriesForPanel().counts, err: seriesErr },
      last: last ? { tab: last.tab, cov: last.cov, covUsers: last.covUsers,
                     missing: missingFields(last), notes: knownGaps(last) } : null,
    };
  }

  // ---------- Side Panel 的取数与命令通道 ----------
  // 只有扩展自己能发这个消息（页面 JS 走不到 chrome.runtime.onMessage），仍然再判一次 sender.id。
  function stateForPanel() {
    const c = queryStores('');
    return {
      ver: VER, build: BUILD, href: location.href, tab: tabName(), host: HOST, peer: peerHost(),
      sink: { ok: sinkOk, err: lastSinkErr, posted: posted, qlen: queue.length, lastSinkAt: lastSinkAt, storeErr: storeErr, writes: storeWrites,
              chan: lastChan,
              db: lastPingInfo ? (lastPingInfo.db || null) : null,
              sinkVer: lastPingInfo ? String(lastPingInfo.sink || '') : '', pingAt: lastPingAt,
              q: queueStat(), downMs: sinkOk === false && sinkDownSince ? Date.now() - sinkDownSince : 0 },
      guard: guardStatus(), dump: dumpStatus(),
      counts: { users: c.counts.users, posts: c.counts.posts, runs: loadRuns().length },
      storage: storeStat(), runsMeta: runsMeta, trim: trimMeta,
      perf: perfLine(),
      own: ownHandle(), series: seriesForPanel(),
      rndMax: rndMaxGet(), debug: { on: debugGet(), lastAt: lastDebugAt ? new Date(lastDebugAt).toISOString() : '', everyMs: DEBUG_EVERY },
      badge: { on: badgeGet() },   // v0.8.9：页面内拉黑徽标的闸（v0.8.16 起默认开）；面板设置区照着它画开关
      hotbadge: { on: hotBadgeGet() },  // v0.11.18 art-020：推文内流速徽标总闸，默认关；面板设置区照着它画开关
      last: last, missing: last ? missingFields(last) : [], notes: last ? knownGaps(last) : [], upsert: lastUpsert,
    };
  }
  const CMDS = {
    collect: () => doCollect({ force: true }),
    probe: () => { probeAndReport(); flushNow(); },
    dumpOnce: () => captureDump({ force: true }),
    setDump: (v) => setDumpOn(!!v),
    setDumpHtml: (v) => setDumpHtml(!!v),
    ping: () => pingSink(),
    flush: () => flushNow(),
    clear: () => { saveRuns([]); last = null; },
    query: (q) => queryStores(q),
    stats: () => refreshStats('panel'),
    export: () => buildExport(),
    rebuild: () => rebuildStores(),
    store: () => sendStoreRec(true),
    // 趋势页那两颗：立刻打一个点（在奖励页=读一次曝光数并落日点，在主页/列表页=补一个分钟点）、补录/删掉一个日点
    sample: () => { const r = sampleTick(true); flushNow(); return r; },
    impAdd: (v) => addImpFromPanel(v),
    // 「看谁」切换：面板不必重发整份 state，只要那一个人的 min/imp
    seriesView: (v) => seriesForPanel(v && (v.handle || v)),
    impRestoreDb: (v) => restoreDaysFromDb(v),
    impDel: (d) => {
      const o = d && typeof d === 'object' ? d : { day: d };
      const own = ownHandle();
      const h = normHandle(o.handle) || own;
      return { own: h, removed: delImpPoint(h, String(o.day || '')), imp: ((series[h] || {}).imp || []).length };
    },
    // v0.6.12：设置里钉死「我的账号」。留空 = 撤掉手动值回到自动识别
    ownSet: (v) => setOwnHandle(v),
    // v0.6.8：调试开关 + 随机加时上限（面板设置区） + 调试页打开时把内容落一份进本机日志
    setDebug: (v) => setDebugOn(!!v),
    setRndMax: (v) => setRndMax(v),
    // v0.8.9：页面内那颗「拉黑」钮的开关（v0.8.16 起默认开；关掉 = 当场摘干净、页面零注入）
    setBadge: (v) => setBadgeOn(!!v),
    // v0.11.18 art-020：推文内流速徽标总闸（默认关；开=渲染、关=当场从 X DOM 摘净）
    setHotBadge: (v) => setHotBadge(!!v),
    debugRec: () => { const dg = debugDigest(); dg.why = 'panel'; logRec('debug', dg); lastDebugAt = Date.now(); return dg; },
    // v0.6.9 F3：今日关注目标（基线留空=自动重算；填了=手动盖当场生效，全标签页合并后同频）
    goalSet: (v) => setGoal(v),
    goalNow: () => guardToday(),
  };
  function runCmd(msg) {
    if (msg && msg.t === 'state') {
      // 面板读到的是「这一页内存里的账」——别的标签页刚关注过的话，这一页若在后台被节流，
      // 1.2s 的节拍器可能几分钟没跑，回给面板的就还是「上一条已过冷却」= 横幅一直绿。
      // 回话前先从共享缓存吃进最新台账（syncGuardRemote 只认「别家领先」才换账，不会倒灌）。
      try { syncGuardRemote(); } catch (e) { /* 读不到别家的账也不该让面板整页空白 */ }
      return { ok: true, state: stateForPanel() };
    }
    const fn = msg && CMDS[msg.t];
    if (!fn) return { ok: false, err: '未知命令 ' + String((msg && msg.t) || '') };
    const result = fn(msg.v);
    // 回填那条要走本机 HTTP（GM_xmlhttpRequest 是回调式的），命令表里允许返回 Promise：
    // 消息通道由下面的 addListener 保活，回包到了再 render 一次，面板拿到的是合并后的 series
    if (result && typeof result.then === 'function') {
      return result.then((r) => { render(); return { ok: true, result: r === undefined ? null : r, state: stateForPanel() }; },
        (e) => ({ ok: false, err: '命令异常: ' + clip(e && e.message, 80) }));
    }
    render();
    return { ok: true, result: result === undefined ? null : result, state: stateForPanel() };
  }
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!sender || sender.id !== chrome.runtime.id) return;
      // v0.11.4：设置页翻「本机模型」那颗闸那一刻，SW 朝 x.com 的标签页广播一声。
      // 走这条是因为它不需要请求 X、也不改采集，只是让第七颗当场露面/收回去；
      // 广播丢了（面板开在别的窗口、这一页刚重载）也不会永远看不见——boot 读一次 + 60 秒 TTL 兜底。
      if (msg && msg.t === 'modelGate') {
        let on = false;
        try { on = aiGateSet(msg.on === true, false); } catch (e) { /* 一颗钮的显隐不该把消息通道搞挂 */ }
        sendResponse({ ok: true, on: on }); return;
      }
      let res = null;
      try { res = runCmd(msg); } catch (e) { res = { ok: false, err: clip(e && e.message, 120) }; }
      if (res && typeof res.then === 'function') { res.then(sendResponse, (e) => sendResponse({ ok: false, err: clip(e && e.message, 120) })); return true; }
      sendResponse(res);
    });
  }

  // 导出走 Side Panel 的下载，不在页面里 append <a> 再 click（那既是瞬时注入节点也是页面可观测行为）。
  // 两张表存在扩展自己的存储里，不挂 x.com 这个 origin ⇒ 页面 JS 枚举不到；代价是离线分析要靠这份下载。
  function buildExport() {
    return JSON.stringify({
      ver: VER, build: BUILD, host: 'extension', exportedAt: new Date().toISOString(),
      // 导出的 runs 只有最新 RUNS_FULL 份带原文，其余是精简行（slim:1）。整页 HTML 的去处是本机
      // logs/*.ndjson 与 xprobe.db，不在浏览器存储里 —— 拿这份 JSON 做离线分析时要看得懂这个差别。
      runsNote: '最新 ' + RUNS_FULL + ' 份带原文，其余为精简快照（slim=1，丢了 tweets[].html 与 metrics 出处原文）；整页原文见本机 logs/ndjson 与 xprobe.db',
      runs: loadRuns(), users: users, posts: posts, guard: guard, series: series,
    }, null, 2);
  }
  // ---------- SPA 换页：换页自动采一次，绝不跳转 ----------
  // 提成具名函数 spaTick：沙盒里 setInterval 永远不跑，内联在回调里的逻辑自检测不到。
  let lastHref = location.href;
  function spaTick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      last = null;
      badgeNeedScan = true;   // 换页 = 整屏都是新行：徽标这一轮必扫（观察器那条信号不保证先到）
      // v0.11.4：草稿属于「上一条帖子」，换页就把它清掉——留着，卡片那行的目标就成了新页的那条，
      // 而框里那段字是照着旧帖写的（这种对不上最容易让人顺手发出去）
      aiDraft = ''; aiNote = ''; aiNoteBad = false; aiBusy = false;
      if (aiOpen) renderAi();
      // 换页第一件事：卡片拖进「正在重扫」过渡态。旧页的 article 在新页里多半已被虚拟列表扔掉，
      // 拿旧榜硬撑着，用户点条目只会撞「不在当前画面里」——先清空，等下面 2.5 秒的重采扫完再出新榜。
      cardNote = '';
      if (cardOpen) { cardNav = true; renderCard(); }
      if (flistOpen) renderFlist();   // 换页了名单也重画：行数据是上一页 article 抓的，留着就是旧账
      render();
      setTimeout(() => {
        if (location.href !== lastHref) return;
        doCollect();
        if (cardOpen) { cardNav = false; renderCard(); }
        if (flistOpen) renderFlist();
      }, 2500);
      return;
    }
    // 攒着的（sink 刚断开）定期重发；断开时退到 10s 一次：连不上还每 1.2s 撞一次，只是把回环打得响
    if (queue.length && Date.now() - lastFlushTryAt > (sinkOk === false ? 10000 : 1000)) flushNow();
    try { syncGuardRemote(); } catch (e) { /* 别家的新账要跟上，但节拍器本身不许把页面搞挂 */ }
    try { sampleTick(false); } catch (e) { /* 一分钟一个点，节拍器本身不许把页面搞挂 */ }
    try { debugTick(); } catch (e) { /* 调试心跳与判定无关，坏了更不能拖累节拍器 */ }
    // 冷却到点要自己变绿：没有别的动作触发 render()，不在这儿叫一次，那颗钮会一直红在读秒上
    // （v0.8.15 读秒另有一枚 1 秒定时器，但它只在有秒可读时开着 ⇒ 放绿这一枪仍得靠节拍器兜底）
    try { render(); } catch (e) { /* 状态灯不许把节拍器搞挂 */ }
    // v0.11.14：名单开着就跟着页面自动刷（指纹没变不重画；重画保滚动位置，见 flistTick）
    try { flistTick(); } catch (e) { /* 名单不许把节拍器搞挂 */ }
  }
  setInterval(spaTick, 1200);
  // 云端回显的一份慢钟（v0.11.0）：云端模式下每 5 分钟对一次「谁在榜」，别的机器标/撤的人这边也能跟上。
  // 走 benchCloudHydrate 自己的 2 分钟 TTL + busy 闸；本机模式/没登录时它一问就回 needLocal，不发任何请求。
  setInterval(() => { if (!document.hidden) benchCloudHydrate(false); }, 300000);

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', () => { syncGuardRemote(); if (queue.length) flushNow(); aiReadGate(false); });
    document.addEventListener('visibilitychange', () => {
      syncGuardRemote();
      if (queue.length) flushNow();
      // 切走 = 这一屏短期不再被看：把防抖窗口里压着的表当场落下去，回来就不用再补一趟大的
      if (document.hidden && storeTimer) flushStoreNow('hide');
    });
    // 刷新/关页面前最后一眼：把没发出去的落到存储里，下一个开页面的标签页会认领过来。
    // 这里只写存储，不发请求（页面正在卸载，异步 POST 多半被取消；而且这是给自己看的日志，不是对 X 的请求）
    window.addEventListener('pagehide', () => {
      if (mutTimer) { clearTimeout(mutTimer); mutTimer = 0; flushMutQueue(); }   // 排队里的证据别跟着页面走
      if (storeTimer) flushStoreNow('pagehide');
      if (queue.length) persistQueue(true);
    });
  }

  installErrorHooks();
  // chrome.storage.local 是异步的，而核心里到处是同步 GM_getValue ⇒ 适配层先水合缓存，再起观察者与台账。
  // 自检沙箱不提供 __XP_HOST_READY__（它的存储本来就是同步对象）⇒ 那条路径立刻 boot，断言不受影响。
  const hostReady = globalThis.__XP_HOST_READY__;
  function start() {
    if (hostReady && typeof hostReady.then === 'function') {
      let gone = false;
      const go = () => { if (!gone) { gone = true; boot(); } };
      hostReady.then(go, go);
      setTimeout(go, 800);   // 适配器卡住也要起来：宁可先按空存储跑（浮标会显示基线），也别什么都不做
      return;
    }
    boot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  function boot() {
    loadGuard();
    loadStores();
    loadSeries();
    const adopted = adoptQueue();   // 上个标签页没发出去的积压：它已经没了，这一格归我
    const w = startFollowWatch();
    const g = guardStatus();
    const ss = seriesStats();
    const st = storeStat();
    logRec('beacon', {
      ver: VER, build: BUILD, tab: tabName(),
      hasGmXhr: typeof GM_xmlhttpRequest === 'function',
      hasGmStore: typeof GM_getValue === 'function',
      chan: lastChan,
      series: ss.min + 'min/' + ss.imp + 'day' + (ss.err ? ' ' + ss.err : ''),
      dump: dumpOn ? 1 : 0, dumpHtml: dumpHtml ? 1 : 0,
      watch: w ? 1 : 0, f15: g.f15, f24: g.f24, u24: g.u24, users: Object.keys(users).length, posts: Object.keys(posts).length,
      goal: { day: g.goalToday.day, base: g.goalToday.base, baseSrc: g.goalToday.baseSrc, target: g.goalToday.target, done: g.goalToday.done },
      host: HOST, peer: peerHost(),
      // 运行态一开机就抄一份进日志：没人开面板、没人开调试页的时候，日志里也得有「队列多长、存储多满、表顶没顶」，
      // 上一轮我判断「今天是不是丢了数据」只能靠 at 与 receivedAt 的差猜，就是这个字段当时不在日志里
      q: queueStat(), qback: adopted,
      store: { bytes: st.total, quota: st.quota, unlimited: !!st.unlimited, lastErr: clip(st.lastErr || '', 80), writes: st.writes, failed: st.failed, measured: st.measured },
      trim: trimMeta,
      lang: (document.documentElement && document.documentElement.getAttribute('lang')) || navigator.language || '',
      articlesAtBoot: document.querySelectorAll('article').length,
    });
    pingSink();
    // 调试开着就自报一条 kind=debug：面板的 debugRec 只有「调试页开着且那个标签页是新 core」才生效，
    // 打到旧 content script 的标签页只会回「未知命令」（真机 2026-10-23 实测一条都没落）——
    // 只要开关开着、这个标签页又是新 core，日志里自己就该有这一眼，不再依赖面板那条路。
    if (debugGet()) { const dg = debugDigest(); dg.why = 'boot'; logRec('debug', dg); lastDebugAt = Date.now(); }
    render();
    reconcileRel('boot');   // 起观察者之前页面已经渲染出来的按钮先登记基线，免得把「早就关注着」算成刚关注
    // v0.11.0：云端模式下「刷新后回显」先问接口（云端在榜的人这一页也出「已标人」）。
    // 本机模式/没登录时它一问就回 needLocal，不起任何网络请求；拉到了会自己重画两颗胶囊与名单钮。
    benchCloudHydrate(false);
    // v0.11.4：读一次本机模型那颗闸（只问自家 SW，不打模型、不请求 X）。读不到就当关着画：
    // 第七颗不出现、卡片不存在——「没读到」和「关着」在页面这边是同一个安全默认值。
    aiReadGate(false);
    // 首屏若是主页/帖子页，2.5s 后自动采一次，用户不用手点
    setTimeout(() => { if (tabName() !== 'home' || document.querySelectorAll('article').length) doCollect(); }, 2500);
  }

  // content script 控制台调试（扩展 isolated world，不是页面 world）：__xprobe.snapshot() / .probe() / .flush()
  try {
    globalThis.__xprobe = {
      ver: VER, build: BUILD, sink: SINK, snapshot, collectStats, collectArticles, coverage, firstNumber,
      nativeText, peerHost, knownGaps, storeDigest, sendStoreRec, rebuildStores, foreignTokenIn, foreignTokenOf,
      doCollect, deepProbe, probe: probeAndReport, flush: flushNow, ping: pingSink,
      parseSummaryAria, collectMetrics, tabName,
      domTree, buildDump, captureDump, dumpStatus, setDumpOn, setDumpHtml, redactHtml,
      syncDumpRemote, dumpEnabled,
      guardStatus, recordAction, btnFollowState, onFollowSeen, onMutations, startFollowWatch, reconcileRel, loadGuard, saveGuard, syncGuardRemote,
      // v0.8.7 限流那一刀的探针位：观察器入口（feed=真回调走的路，含即时/排队判定）、队列账、性能账
      feedMutations, flushMutQueue, perfLine, costBackoff: costBackoffMs, perfRef: perf, scanHoverCards, flushStoreNow, collectSoon,
      tlQ: () => ({ timer: tlTimer, lastAt: tlLastAt, why: tlWhy }),
      mutQ: () => ({ queue: mutQueue.length, timer: mutTimer, burst: Math.max(0, burstUntil - Date.now()), lastMutAt, badgeNeedScan }),
      upsertStores, queryStores, refreshStats, fabBtn, cardBtn, flistBtn, buildExport, stateForPanel, runCmd,
      setRndMax, rndMaxGet, setDebugOn, debugGet, debugDigest, setGoal, guardToday,
      // v0.8.9：页面内徽标总闸的三件套（自检要能直接拨它、看清场摘了几个节点，不靠猜）
      badgeGet, badgeSweep, setBadgeOn,
      // v0.11.18 art-020 本页热度榜：纯函数（口径自检直接钉）+ 抓取/计算/开合 + 徽标总闸三件套
      hotFirstNum, hotAllNums, hotFmt, hotTier, hotScore, hotScope, hotActiveScope, hotParseArticle, hotBoard,
      hotBadgeGet, hotBadgeSweep, hotBadgeRender, setHotBadge, hotToggle, hotListBuild,
      HOTBTN_ID, HOTLIST_ID, HOT_BADGE_CLS, HOT_BADGE_KEY,
      __hot: () => ({ open: hotListOpen, root: !!hotListRoot }),
      // v0.11.4：关系标签的判定与占宽（纯函数，自检直接钉口径；flSeen 是「关注列表页扫过没扫过」的总开关）
      relVerdict, followersListSeen, relBudget, relChipEl, relChipRow, REL_CLS,
      // v0.11.7 桥腿的口子：ask（一次一问的问询本体，自检里配桩直接敲）、relFiber（缓存/节拍的状态读数）
      // v0.11.14 补 relFiberMerge（把桥读数直接灌进台账，自检不用绕 window 消息）与
      // flistTick/flistSig（名单自动刷新的节拍本体与指纹，自检直接拨）。
      relFiberAsk, relFiberMerge, flistTick, __flistSig: () => flistSigLast,
      __relFiber: () => ({ src: REL_BRIDGE_SRC, ttl: REL_FIBER_TTL, askMs: REL_FIBER_ASK_MS,
        cacheSize: fiberRel.size, pending: fiberPending, lastAsk: fiberLastAsk }),
      // v0.11.4 功能二：AI 回帖这条腿的口子。判定与拼 prompt 是纯函数（钉口径），开合与写一稿走真按钮同一条路。
      // aiGateSet/aiReadGate 导出是为了自检能直接拨那颗闸（真机上是 SW 广播，沙盒里没 SW）。
      aiGateOn, aiBtnShown, aiGateSet, aiReadGate, aiTarget, aiPrompt, aiAsk, toggleAiCard, renderAi,
      aiBottomPx, AIBTN_ID, AICARD_ID, AI_TEXT_MAX,
      __ai: () => ({ gate: aiGate, open: aiOpen, busy: aiBusy, draft: aiDraft, note: aiNote, bad: aiNoteBad, conf: aiConf, applied: aiBtnApplied }),
      // v0.8.15：灯的读秒与尺寸自检口子（纯函数直接钉住口径；定时器状态要能看见才敢断言「不放绿就不许跳字」）
      fabCd, fabFontPx, fabFreeMs, fabPeerDiam, fabMeasure, fabLight, flistBottomPx, fabSlotPx,
      fabStat: () => ({ px: fabSizeEff(), src: fabSizeSrc(), tries: fabTries, beat: fabBeatOn, applied: fabSizeApplied }),
      // v0.9.0 标杆：台账与窗口的口子。排序/合并/取数是纯函数（钉口径），开合与重取走真按钮同一条路。
      // v0.9.2 补三个口子：发帖时刻的取/算（benchPostPub/benchPostMs）与那把「UTC 字面 → 本机钟点」的尺（hlShort）。
      benchNum, benchNormTags, benchMerge, benchSorted, benchPostsOf, benchPostDays, benchFabText,
      benchPostPub, benchPostMs, hlShort,
      benchRightPx, benchBottomPx, benchCount, isBench, benchTagsOf, benchToggle, benchSetTags,
      // v0.11.0：云端那一层（接口回显）要能单独拉一次、也要能把「谁在榜」看全
      benchCloudHydrate,
      __benchCloud: () => ({ ac: benchCloudAc, po: benchCloudPo, goneAc: benchGoneAc, gonePo: benchGonePo }),
      // v0.11.3：名单行尾那颗「标杆」删了 ⇒ 导出表里也没有 benchBtnEl 这一项（留着就是引用一个不存在的函数）
      toggleBench, fetchBench, renderBench,
      // v0.9.1 个人主页那颗标星：扫描本身走 renderBlocks 这条路（同一道闸、同一个限流），这里只给读与单测的口子
      // v0.9.3：两颗胶囊（标人/标帖）共用同一条摆法，benchPillStep 是那条判据的本体（要能单独喂靶子测）
      benchBadgeScan, benchProfileRow, benchBadgeTip, benchPostRow, benchPillStep, benchPillFit,
      benchPillW, benchPillLabel, benchPTip, statusIdFromPath, benchPostTextSnap,
      // v0.9.3 标杆帖子：台账（纯函数钉口径）+ 窗口（开合与重取走真按钮同一条路）+ 榜单行尾那颗
      benchPCleanId, benchPCount, isBenchP, benchPTagsOf, benchPWrite, benchPToggle,
      benchPMerge, benchPSorted, benchPLedEng, benchPRightPx, benchPBottomPx, benchPFabText,
      fetchBenchP, renderBenchP, toggleBenchP, benchPRowEl, benchPCardBtn,
      __bench: () => ({ open: benchOpen, sort: benchSortNow, win: benchWin, psort: benchPSort, note: benchNote,
        ledger: Object.keys(bench).length, data: benchData, expanded: Object.keys(benchExpand),
        dragged: benchDragged, pos: benchPos }),
      __benchLedger: () => bench,
      __benchP: () => ({ open: benchPOpen, sort: benchPSortNow, note: benchPNote,
        ledger: Object.keys(benchP).length, data: benchPData, dragged: benchPDragged, pos: benchPPos }),
      __benchPLedger: () => benchP,
      // v0.8.10 自检口子：验「谁被我们临时改了 position」——清场后必须归零（页面零痕迹的硬判据）
      __badgeHosts: () => Array.from(badgeHosts.keys()),
      __badgePick: badgePick, __badgeFit: badgeFit, __ratioInfo: ratioInfo, __ratioBudget: ratioBudget, __badgeSig: badgeSig,
      // v0.8.16 列表页那颗「贴关注钮左缘」的两个新判据：认钮（认错顶多换个贴法，不会压住页面）与锚定侧
      __badgeFollowBtn: badgeFollowBtn, __badgeAnchor: badgeAnchor, __badgeGaps: badgeGaps,
      loadRuns, saveRuns, slimSnap, storeStat, bytesOf,
      runsMeta: () => runsMeta, caps: () => ({ full: RUNS_FULL, slim: RUNS_SLIM, keep: RUNS_KEEP, byteCap: RUNS_BYTES_CAP }),
      collectRewards, captureRewards, sampleTick, ownHandle, setOwnHandle, rememberOwn, normHandle, isOwn, addImpPoint, addMinPoint, delImpPoint,
      collectAnalytics, captureAnalytics, dayFromLabel, migrateSeries, loadSeries, seriesOf: () => series,
      hoverCardScan, captureHoverCards, onHoverCardMutation,
      recordDayRow, addImpFromPanel, mergeDayRows, restoreDaysFromDb,
      seriesForPanel, seriesStats, loadSeries, dayKey,
      getGuard: () => guard, getUsers: () => users, getPosts: () => posts, getSeries: () => series, writeStores, spaTick, renderBlocks, isBlocked,
      ledgerSize: () => Object.keys(relLedger).length,
      missingFields, queue, status: () => ({ sinkOk, lastSinkErr, posted, qlen: queue.length }),
      // v0.6.9 待发队列落盘：自检要能直接看队列账本与两张表的顶满情况（不看内部函数就只能断言"没报错"，那是走过场）
      queueStat, persistQueue, adoptQueue, qMeta: () => qMeta, trimMeta: () => trimMeta, queueKey: () => QUEUE_KEY,
    };
  } catch (e) { /* 忽略 */ }
})();

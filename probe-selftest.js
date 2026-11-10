// 探针自检：用最小 DOM 桩在 Node 里跑探针的真实代码。
// 样本 DOM 按 2026-10-22 真机日志的实际形状复刻（中文 aria、verified_followers 当粉丝源、
// User-Name 挂在 div 上、聚合 aria 一句拿三个数、tab 上没有帖子总数）。
// 默认测扩展版 content/core.js；油猴版已于 2026-10-28 归档到 skills/memory/archive/（不再维护），如要复验用 XPROBE_SRC=skills/memory/archive/x-observe-probe.user.js
// —— 判定逻辑两边同源，所以同一套断言可以横比（面板与宿主层除外，那两块单独测，见 [12]~[15]）。
// ⚠ 但 v0.5.0 起 [5]/[11] 的面板类断言走的是 state 命令通道，油猴版没有 chrome.runtime ⇒ 指过去会在 [5] 报错。
//   油猴脚本已冻结不再维护；真要复验它，回到 BUILD 2026-10-22-g 那一份自检，别改这套来迁就冻结的代码。
// 用法: node probe-selftest.js            （离线）
//       node probe-selftest.js --live     （额外打真实 http://127.0.0.1:8765 端到端）
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = process.env.XPROBE_SRC || path.join('extension', 'content', 'core.js');
const SRC_PATH = path.join(__dirname, SRC);
const HOST = SRC.indexOf('user.js') >= 0 ? 'userscript' : 'extension';
let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  got=' + JSON.stringify(got)); }
}
function eq(name, got, want) {
  ok(name + ' == ' + JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want), got);
}

// ---------------- 最小 DOM ----------------
const IDS = {};
// 真 DOM 的 style.cssText = '' 会把整串内联样式清空（core v0.8.10 在「小红点 ⇄ 整颗钮」两种形态间切换就靠它）。
// 桩原来是个普通对象、赋 '' 什么也不发生 ⇒ 上一轮的宽高会留在身上，自检就看不见换形态这件事了。
function makeStyle() {
  const s = {};
  Object.defineProperty(s, 'cssText', {
    get() { return Object.keys(s).map((k) => k + ': ' + s[k]).join('; '); },
    set(v) {
      Object.keys(s).forEach((k) => { delete s[k]; });
      String(v || '').split(';').forEach((d) => {
        const kv = d.split(':');
        if (kv.length === 2) s[kv[0].trim()] = kv[1].trim();
      });
    },
    enumerable: false,
  });
  return s;
}
class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.kids = kids;
    this.style = makeStyle();
    this.dataset = {};
    this.listeners = {};
    this.parentNode = null;
    this.nodeType = 1;
    this.scrollTop = 0;   // v0.11.14：名单重画保滚动位置（renderFlist 读旧根的 scrollTop 还给新根），桩得有这口才测得着
    this.id = attrs.id || '';
    kids.forEach((k) => { if (k instanceof El) k.parentNode = this; });
  }
  set id(v) { if (this._id) delete IDS[this._id]; this._id = v; if (v) IDS[v] = this; }
  get id() { return this._id; }
  get tagName() { return String(this.tag).toUpperCase(); } // 真 DOM 的 tagName 是大写
  get className() { return this.attrs.class || ''; } // 第三方注入检测要读 className
  get textContent() { return this.kids.map((k) => (k instanceof El ? k.textContent : String(k))).join(''); }
  set textContent(v) { this.kids = [String(v)]; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); return v; }
  insertBefore(c, ref) {   // 真 DOM：ref 为 null 时 append 兜底；插入 = 先从原父节点摘下
    const p = c && c.parentNode;
    if (p instanceof El) { const j = p.kids.indexOf(c); if (j >= 0) p.kids.splice(j, 1); }
    const i = ref instanceof El ? this.kids.indexOf(ref) : -1;
    if (i < 0) this.kids.push(c); else this.kids.splice(i, 0, c);
    c.parentNode = this; return c;
  }
  get outerHTML() {    const a = Object.keys(this.attrs).map((k) => ' ' + k + '="' + this.attrs[k] + '"').join('');
    return '<' + this.tag + a + '>' + this.kids.map((k) => (k instanceof El ? k.outerHTML : String(k))).join('') + '</' + this.tag + '>';
  }
  get parentElement() { return this.parentNode instanceof El ? this.parentNode : null; }
  get previousSibling() {   // 真 DOM 的兄弟回看（桩此前用不到；v0.8.4 拉黑钮断言「缝在名字锚后面」要用）
    const p = this.parentNode;
    if (!(p instanceof El)) return null;
    const i = p.kids.indexOf(this);
    return i > 0 ? p.kids[i - 1] : null;
  }
  get nextSibling() {   // insertBefore(n, anchor.nextSibling) 的第二参：桩缺它时 ref=null 走 append 兜底，位置就错了
    const p = this.parentNode;
    if (!(p instanceof El)) return null;
    const i = p.kids.indexOf(this);
    return i >= 0 && i < p.kids.length - 1 ? p.kids[i + 1] : null;
  }
  get children() { return this.kids.filter((k) => k instanceof El); }
  // v0.8.11：徽标现在要「往上爬找空白」——每一层看它的后续兄弟里右边站着什么。桩缺 nextElementSibling
  // 与 contains 时，爬升循环一路 continue ⇒ 宿主永远选不到，测出来的就是「徽标一颗都不出」那条真机现象，
  // 而不是算法本身的问题。两个都按真 DOM 口径补齐（只算元素节点，文本节点跳过）。
  get nextElementSibling() {
    const p = this.parentNode;
    if (!(p instanceof El)) return null;
    const kids = p.children;
    const i = kids.indexOf(this);
    return i >= 0 && i < kids.length - 1 ? kids[i + 1] : null;
  }
  get previousElementSibling() {
    const p = this.parentNode;
    if (!(p instanceof El)) return null;
    const kids = p.children;
    const i = kids.indexOf(this);
    return i > 0 ? kids[i - 1] : null;
  }
  contains(other) {
    if (other === this) return true;
    return this.descendants().indexOf(other) >= 0;
  }
  closest(sel) {
    const list = sel.split(',').map((s) => s.trim());
    let n = this;
    while (n instanceof El) { if (list.some((c) => n.matches(c))) return n; n = n.parentNode; }
    return null;
  }
  appendChild(c) {
    // 真 DOM 语义：append 到另一个父节点 = 先从原父节点摘下来。桩以前只改 parentNode、旧父的 kids 里
    // 还留着它 ⇒ 徽标换宿主后旧位置那颗仍被文档序遍历找到，「这颗不出」测出来是「出了两颗」。
    // v0.8.12 徽标会搬宿主（爬层/粘住失败时搬），这条不补就是假红。
    const p = c && c.parentNode;
    if (p instanceof El) { const i = p.kids.indexOf(c); if (i >= 0) p.kids.splice(i, 1); }
    this.kids.push(c); c.parentNode = this; return c;
  }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  remove() {
    if (this._id) delete IDS[this._id];
    const p = this.parentNode;
    if (p) { const i = p.kids.indexOf(this); if (i >= 0) p.kids.splice(i, 1); this.parentNode = null; }
  }
  click() {}
  // v0.8.10：徽标要按几何决定落点（时间右侧那块空白放得下整颗 / 只放得下小点 / 都放不下）。
  // 桩默认「没量出来」（返回零尺寸，core 的 geoRect 会当 null 降级），只有沙箱按文档序灌过坐标的节点
  // 才报得出矩形 ⇒ 老断言不受影响，新断言想怎么挤就怎么挤。
  getBoundingClientRect() {
    const g = this.__geo;
    if (!g) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    return { left: g.left, top: g.top, right: g.left + g.width, bottom: g.top + g.height,
             width: g.width, height: g.height, x: g.left, y: g.top };
  }
  // v0.8.3 曝光榜卡片：滚动只发生在用户点条目那一刻。桩把每次调用记在元素上，断言数次数与参数，
  // 顺带钉死「探针自己绝不主动调它」——卡片没被点过时任何断言里 __scrolls 都必须是 0。
  scrollIntoView(opts) { this.__scrolls = (this.__scrolls || 0) + 1; this.__scrollOpts = opts || null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t, e) { (this.listeners[t] || []).forEach((f) => f(e || { type: t })); }   // e 透传：拖动桩要带 button/clientX/clientY
  descendants() {
    const out = [];
    const walk = (n) => n.kids.forEach((k) => { if (k instanceof El) { out.push(k); walk(k); } });
    walk(this);
    return out;
  }
  matches(compound) {
    // 真 DOM 的 matches() 认「[a], [b]」这种选择器组。桩原来不认，直接抛错 ⇒ 探针里
    // FOREIGN_SEL（第三方注入检测）整条落进 catch 判否，「读名字时剥掉注入子树」那条正路从没被跑到过
    return String(compound).split(',').some((one) => this._matchOne(one.trim()));
  }
  _matchOne(compound) {
    // v0.8.9：类选择器（.foo）也要认。清场那条走的是 '.ysy-xprobe-blk, [data-xprobe="blk"]'，
    // 桩不认就抛 ⇒ 探针的 catch 把它当「什么都没找到」，「摘干净」在自检里就成了假绿。
    // 真 CSS 的 .foo 认的是 class 里的一个 token（不是子串），这里按同一口径判。
    // v0.11.8：补 #id —— 关系桥的 store 源要 querySelector('#react-root')，桩不认会整条源静默跳过。
    const m = compound.match(/^(?:([a-zA-Z][\w-]*))?((?:#[\w-]+)?)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
    if (!m) throw new Error('选择器桩不支持: ' + compound);
    if (m[1] && this.tag !== m[1]) return false;
    if (m[2] && this.id !== m[2].slice(1)) return false;
    const cls = String(this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const dots = (m[3] || '').match(/\.[\w-]+/g) || [];
    for (const d of dots) { if (cls.indexOf(d.slice(1)) < 0) return false; }
    const parts = (m[4] || '').match(/\[[^\]]+\]/g) || [];
    for (const p of parts) {
      const inner = p.slice(1, -1);
      const kv = inner.match(/^([\w-]+)([*^$]?=)"([^"]*)"$/);
      if (kv) {
        const v = this.getAttribute(kv[1]);
        if (v == null) return false;
        if (kv[2] === '=') { if (v !== kv[3]) return false; }
        else if (kv[2] === '*=') { if (!v.includes(kv[3])) return false; }
        else if (kv[2] === '^=') { if (!v.startsWith(kv[3])) return false; }
        else if (kv[2] === '$=') { if (!v.endsWith(kv[3])) return false; }
      } else if (!/\[[\w-]+\]$/.test(p) || this.getAttribute(inner) == null) return false;
    }
    return true;
  }
  querySelectorAll(sel) {
    const list = sel.split(',').map((s) => s.trim());
    return this.descendants().filter((e) => list.some((c) => e.matches(c)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const h = (tag, attrs, kids) => new El(tag, attrs || {}, kids || []);
const T = (s) => s;

// ---------------- 复刻真机：个人主页 ----------------
const REAL_SUMMARY = '11 回复、9 喜欢、122 次观看';
function statLink(href, aria, visible) {
  return h('div', {}, [h('a', { href, role: 'link', 'aria-label': aria }, [
    h('span', {}, [h('span', {}, [T(visible.split(' ')[0])])]), T(' '), h('span', {}, [T(visible.split(' ')[1])]),
  ])]);
}
function group(withSummary, nums) {
  const kids = [
    h('button', { 'data-testid': 'reply', 'aria-label': nums.reply + ' 回复。回复' }, [T(String(nums.reply))]),
    h('button', { 'data-testid': 'retweet', 'aria-label': nums.repost + ' 次转帖。转帖' }, []),
    h('button', { 'data-testid': 'like', 'aria-label': nums.like + ' 喜欢次数。喜欢' }, [T(String(nums.like))]),
    h('a', { href: '#', 'aria-label': nums.view + ' 次查看。查看帖子分析' }, [T(String(nums.view))]),
    h('button', { 'data-testid': 'bookmark', 'aria-label': '书签' }, []),
    h('button', { 'aria-label': '分享帖子' }, []),
  ];
  return h('div', withSummary ? { role: 'group', 'aria-label': REAL_SUMMARY } : { role: 'group' }, kids);
}
function tweetCell(handle, id, dt, text, opts) {
  const o = opts || {};
  const kids = [];
  if (o.author !== false) {
    // v0.8.10 对齐真机：名字行 [data-testid="User-Name"] 里就挂着「名字 @handle · 时间」
    // （真机 2026-10-26_211129 转储：User-Name flex:1 撑满名字列，时间右缘到 Grok 之间就是那片空白）
    kids.push(h('div', { 'data-testid': 'User-Name' }, [
      h('a', { href: '/' + handle }, [T('示例笔记'), T(' @' + handle)]),
      h('a', { href: '/' + handle + '/status/' + id, 'aria-label': '1小时 前' }, [h('time', { datetime: dt }, [T('1小时')])]),
    ]));
  } else {
    kids.push(h('a', { href: '/' + handle + '/status/' + id, 'aria-label': '1小时 前' }, [h('time', { datetime: dt }, [T('1小时')])]));
  }
  kids.push(h('div', { 'data-testid': 'tweetText' }, [T(text)]));
  // v0.11.4：followAria 覆写 —— 真机「TA 关注你、你还没关注」时那颗钮的 aria 是「回关 @x / Follow back @x」，
  // 关系标签判「他单向」认的就是这两个字（testid 仍是 -follow，X 不给「回关」单独发一个 testid）。
  if (o.followTestid) kids.push(h('button', { 'data-testid': o.followTestid, 'aria-label': (o.followAria || ((o.followTestid.slice(-9) === '-unfollow' ? '正在关注 @' : '关注 @') + handle)) }, [T('按钮')]));
  if (o.group) kids.push(o.group);
  return h('article', { 'data-testid': 'tweet' }, kids);
}

const profile = h('div', { lang: 'zh' }, [
  // v0.8.1 诱饵：侧栏作者卡上也有「N 帖子」leaf span，且文档序排在头部前面 —— 不排除就会顶掉头部那行
  h('div', { 'data-testid': 'sidebarColumn' }, [h('span', {}, [T('8,888 帖子')])]),
  // 真机 2026-10-22-c：UserName 的 textContent 是「显示名@handle关注了你」拼在一起，脏的
  h('div', { 'data-testid': 'UserName' }, [T('示例笔记@demo_own关注了你')]),
  // v0.8.1：头部自报的帖子总数（真机「5,021 帖子」那行），打开主页就落进日点的 posts 列
  h('span', {}, [T('5,021 帖子')]),
  // 原生关注按钮：testid 是「<数字ID>-unfollow」，aria「正在关注 @handle」
  h('button', { 'data-testid': '1493114391747006467-unfollow', 'aria-label': '正在关注 @demo_own' }, [T('正在关注')]),
  // 第三方脚本注入的互关角标（class 前缀 xro-，不是 X 的 DOM），只能当噪声，别拿它当关系判定
  h('span', { class: 'xro-badge xro-badge--mutual', 'aria-label': 'demo_own: 互相关注' }, [T('互关')]),
  h('div', { 'data-testid': 'UserDescription' }, [T('2020年开始投资美股')]),
  h('div', { 'data-testid': 'UserJoinDate' }, [T('加入于 2020年1月')]),
  h('div', { 'data-testid': 'UserLocation' }, [T('全国飞')]),
  h('div', { 'data-testid': 'UserUrl' }, [T('youtube.com/channel/UCx')]),
  h('div', { 'data-testid': 'UserProfileHeader_Items' }, [T('全国飞 youtube.com/channel/UCx 加入于 2020年1月')]),
  // 真机：中文 UI 只有「正在关注」和「关注者」，没有 /followers 锚点，且这些锚点没有 aria-label
  statLink('/demo_own/following', '', '2,578 正在关注'),
  statLink('/demo_own/verified_followers', '', '2,978 关注者'),
  h('div', { role: 'tablist' }, [
    h('a', { role: 'tab', 'aria-selected': 'true' }, [T('帖子')]),
    h('a', { role: 'tab' }, [T('回复')]),
    h('a', { role: 'tab' }, [T('转帖')]),
    h('a', { role: 'tab' }, [T('媒体')]),
  ]),
  tweetCell('demo_own', '2113132810320097514', '2026-10-22T04:58:16.000Z', '正文一', { group: group(true, { reply: 11, repost: 0, like: 9, view: 122 }), followTestid: '987654321-follow' }),
  tweetCell('demo_own', '2113119051287597271', '2026-10-22T04:03:36.000Z', '正文二', { group: group(false, { reply: 0, repost: 3, like: 5, view: 5 }) }),
  tweetCell('-', '2113100000000000001', '2026-10-21T00:00:00.000Z', '推荐卡片，无作者头也无操作组', { author: false }),
]);

const tweetPage = h('div', {}, [
  h('div', { 'data-testid': 'UserName' }, [T('示例笔记')]),
  tweetCell('demo_own', '555', '2026-10-22T05:00:00.000Z', '一条主推文', { group: group(true, { reply: 12, repost: 1, like: 34, view: 400 }) }),
]);

// 端到端正向对照用：整棵树换成 selftest-zz，免得测试数据看着像真实现场
function renameEl(node, from, to) {
  const attrs = {};
  Object.keys(node.attrs).forEach((k) => { attrs[k] = String(node.attrs[k]).split(from).join(to); });
  const kids = node.kids.map((k) => (k instanceof El ? renameEl(k, from, to) : String(k).split(from).join(to)));
  return h(node.tag, attrs, kids);
}
const selftestProfile = () => renameEl(profile, 'demo_own', 'selftest-zz');

const homeFixture = h('div', {}, [
  h('a', { href: '/home' }, [T('首页')]),
  // 真机 /home 侧栏推荐位也有原生「关注 @某人」按钮，早期版本会把它当成本页关注关系上报（rel=not_following 假数据）
  h('div', { 'data-testid': 'sidebarColumn' }, [h('button', { 'data-testid': '1251127925195378690-follow', 'aria-label': '关注 @FinanzasArgy' }, [T('关注')])]),
  tweetCell('a', '1', '2026-10-21T14:33:58.000Z', '一', { group: group(true, { reply: 35, repost: 0, like: 21, view: 900 }) }),
  tweetCell('b', '2', '2026-10-21T11:05:58.000Z', '二', { group: group(false, { reply: 107, repost: 0, like: 65, view: 1500 }) }),
]);

// 奖励页（/i/jf/creators/original_content_rewards）：URL 里没有 handle，靠侧栏「个人资料」那颗导航认自己。
// 这一份同时喂 [8g]（离线判据）和 [10c]（端到端打真 sink 的 reward 摘要行），别在活块里再手搓一份走形。
const RW_TEXT = '过去 90 天内，累积至少 50 万次已验证首页时间线曝光';
const RW_PATH = '/i/jf/creators/original_content_rewards';
const rewardsRoot = (tail) => h('div', {}, [
  h('a', { 'data-testid': 'AppTabBar_Profile_Link', href: '/demo_own' }, [T('个人资料')]),
  h('div', { 'data-testid': 'primaryColumn' }, [
    h('div', { 'data-testid': 'jc-creator-earnings-module' }, [
      h('h2', {}, [T('原创内容奖励')]),
      h('div', { class: 'css-17o-eif' }, [T(RW_TEXT)]),
      h('div', {}, [h('span', {}, [T('10.1K')])]),
      h('div', {}, [h('span', {}, [T('2%')])]),
    ].concat(tail || [])),
  ]),
]);

// ---------------- 沙箱（可控定时器 + GM_xmlhttpRequest 桩） ----------------
const src = fs.readFileSync(SRC_PATH, 'utf8');
// 换行符不写死：抬版/脱敏脚本用文本模式重存会把 core.js 变成 CRLF，写死 \n 的抠源码针会静默抠不掉，
// 那条正向对照就退化成空断言（v0.10.6 撞过一次：两条 [20]/[21] 变异对照一起飘红，原因只是 EOL）。
const SRC_EOL = src.includes('\r\n') ? '\r\n' : '\n';
const BENCH_SCAN_MUT = '    benchBadgeScan();' + SRC_EOL;
// 面板的格式化层是纯函数（不碰 DOM、不碰 chrome），所以在这里直接跑真文件：
// 「命中率那 8 行、精确值判定、腾出位置那句话」由它负责，测试就能钉住显示出来的文本而不必造浏览器。
const viewSb = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension', 'ui', 'view.js'), 'utf8'), viewSb);
const V = viewSb.XPROBE_VIEW;
// 版本号从被测源码里读，不写死：换版时若忘了改 BUILD，日志里那份旧标记会骗过我（真机就发生过）
const SRC_VER = (src.match(/const VER = '([^']+)'/) || [])[1];
const SRC_BUILD = (src.match(/const BUILD = '([^']+)'/) || [])[1];
const store = {};
const RESP = { post: { status: 200, text: '{"ok":true,"stored":1}' }, ping: { status: 200, text: '{"ok":true,"sink":"sink-2"}' } };

function makeSandbox(root, pathname, href, useGmXhr) {
  const calls = [];
  const observers = [];
  const timers = [];
  const intervals = [];   // v0.8.15：setInterval 的账（灯的 1 秒读秒节拍住在这里）
  const created = [];   // 我用 document.createElement 造过的每一个节点：注入痕迹的直接计量
  const copied = [];    // v0.8.3 卡片「复制」钮的桩：navigator.clipboard.writeText 落在这里（sb.__copied）
  let tid = 1000;
  // v0.8.15：浮标直径改成「量 X 右缘那一列」⇒ 桩要有视口宽度（innerWidth 缺省时 core 判「量不到」走回落，
  // 想测「量到了」那条腿就得显式给候选节点灌 __geo）
  const win = { innerWidth: 1440, innerHeight: 900, listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }, fire(t, e) { (this.listeners[t] || []).forEach((f) => f(e || { type: t })); } };
  const doc = {
    title: '页面', readyState: 'complete', documentElement: root,
    getElementById: (i) => IDS[i] || null,
    createElement: (tag) => { const e = h(tag); created.push(e); return e; },
    listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    querySelectorAll: (s) => root.querySelectorAll(s),
    querySelector: (s) => root.querySelector(s),
    // 真 DOM 的 TreeWalker 按文档顺序吐文本节点；桩里没有文本节点对象，从 kids 里的字符串现造，
    // 并带上 parentElement 链，否则探针的「跳过第三方子树读文本」只能走 catch 里的降级分支，测不到正路
    createTreeWalker: (node) => {
      const list = [];
      const walk = (n) => n.kids.forEach((k) => {
        if (k instanceof El) walk(k);
        else list.push({ nodeType: 3, textContent: String(k), parentNode: n, parentElement: n });
      });
      if (node instanceof El) walk(node);
      let i = 0;
      return { nextNode: () => (i < list.length ? list[i++] : null) };
    },
  };
  const sb = {
    document: doc, window: win,
    __XPROBE_TEST: 1, // 让 sink 把自检流量分流，别混进真机日志
    location: { href, pathname, hash: '', search: '' },
    navigator: { userAgent: 'node-probe-stub', language: 'zh-CN',
      // v0.8.3 卡片「复制」钮：桩记下每次写入的文本（sb.__copied），断言复制的就是正文且没把滚动也点着
      clipboard: { writeText: (t) => { copied.push(String(t)); return Promise.resolve(); } } },
    __copied: copied,
    console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, id: ++tid }); return tid; },
    clearTimeout: () => {},
    // v0.8.15：灯的读秒是一枚 1 秒 setInterval。原来 setInterval 只返回 1、什么都不留 ⇒
    // 「该开的时候开没开、该摘的时候摘没摘」在自检里是看不见的。这里只记账不自动跑：
    // 测试用 __intervals() 看形状、用 __runIntervals() 手工敲一枪（和 __runTimers 同一个路子，
    // 不把间隔定时器混进 __runTimers，否则老断言里「跑一轮定时器」会突然多带上 spaTick）。
    setInterval: (fn, ms) => { intervals.push({ fn, ms, id: ++tid }); return tid; },
    clearInterval: (id) => { const i = intervals.findIndex((x) => x.id === id); if (i >= 0) intervals.splice(i, 1); },
    Blob: function (parts) { this.text = parts.join(''); },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    GM_getValue: (k, d) => (store[k] === undefined ? d : store[k]),
    GM_setValue: (k, v) => { store[k] = v; },
    Set, Map, JSON, Math: Object.create(Math), Number, String, Object, Array, isFinite, RegExp, Error, Date, Promise,
  };
  if (useGmXhr) {
    sb.GM_xmlhttpRequest = (o) => {
      const r = String(o.url).endsWith('/ping') ? RESP.ping : RESP.post;
      calls.push({ via: 'GM_xmlhttpRequest', method: o.method, url: o.url, body: o.data });
      if (r.status === 0) { o.onerror && o.onerror({ status: 0 }); return; }
      o.onload && o.onload({ status: r.status, responseText: r.text });
    };
  } else {
    sb.fetch = (url, o) => {
      const r = String(url).endsWith('/ping') ? RESP.ping : RESP.post;
      calls.push({ via: 'fetch', method: o.method, url, body: o.body });
      if (r.status === 0) return Promise.reject(new Error('fetch-refused'));
      return Promise.resolve({ status: r.status, text: () => Promise.resolve(r.text) });
    };
  }
  sb.__calls = calls;
  sb.__created = created;
  sb.__timers = timers;   // 被动补采要断言「那一枪排的是 5 秒后」，得能看见待跑的定时器
  sb.__intervals = () => intervals.slice();
  sb.__runIntervals = (ms) => {
    const list = ms ? intervals.filter((x) => x.ms === ms) : intervals.slice();
    list.forEach((t) => { try { t.fn(); } catch (e) { console.log('  间隔定时器抛错: ' + e.message); } });
    return list.length;
  };
  // v0.8.10 几何桩：徽标改「浮在时间右侧的空白」后，落点由矩形算出来，自检必须能量。
  // 口径：带 data-testid 的节点当一行（横排，模拟 X 的名字行），其余按块级竖排；
  // 叶子给 24px，行给「至少 600px」⇒ 时间右边天然留一大片空白，正好对上真机详情页那一眼。
  // 测试要造窄行，直接覆写 node.__geo 再跑一轮 renderBlocks 就行。
  (function layout(root) {
    if (!(root instanceof El)) return;
    const isRow = (n) => !!(n.getAttribute && n.getAttribute('data-testid'));
    const wide = (n) => {
      const kids = n.children;
      if (!kids.length) { n.__w = 24; n.__h = 18; return; }
      kids.forEach(wide);
      const sum = kids.reduce((a, k) => a + (k.__w || 24) + 8, 0);
      n.__w = Math.max(isRow(n) ? 600 : 120, sum);
      // v0.8.11：徽标往上爬找空白时有一条「这一层的高度必须还是一行（≤64px）」的闸，
      // 所以桩也得把竖排盒子算高：横排取最高的孩子，块排把孩子的行高一格格累加。
      n.__h = isRow(n) ? Math.max.apply(null, kids.map((k) => k.__h || 18))
                       : kids.reduce((a, k) => a + (k.__h || 18), 0);
    };
    wide(root);
    const put = (n, x, y) => {
      n.__geo = { left: x, top: y, width: n.__w || 24, height: n.__h || 18 };
      const kids = n.children;
      if (!kids.length) return;
      const row = isRow(n);
      let cx = x + 4, cy = y + 18;
      kids.forEach((k) => {
        const w = k.__w || 24;
        put(k, row ? cx : x + 4, row ? y : cy);
        if (row) cx += w + 8; else cy += (k.__h || 18);
      });
    };
    put(root, 0, 0);
  })(root);
  // MutationObserver 桩：观察者只读，测试靠 __fireMo 手工投记录，形状照真 MutationRecord
  sb.MutationObserver = function MutationObserver(cb) {
    this.observe = (target, opt) => { this.target = target; this.opt = opt; observers.push({ cb, target, opt }); };
    this.disconnect = () => { const i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); };
  };
  sb.__observers = observers;
  sb.__fireMo = (recs) => { observers.forEach((o) => o.cb(recs)); return observers.length; };
  // chrome.* 桩：扩展模式下 core 有两条通道 —— 出站 sendMessage（开面板 / 经 shim 存取与发网络），
  // 入站 onMessage（Side Panel 的命令）。把入站消息直接喂进去，就能不启动浏览器而验完整命令通道。
  const rtMsgs = [], rtLis = [];
  sb.chrome = {
    runtime: {
      id: 'xprobe-test-ext', lastError: null,
      sendMessage(m, cb) { rtMsgs.push(m); if (cb) cb(undefined); return undefined; },
      onMessage: { addListener(fn) { rtLis.push(fn); } },
    },
  };
  sb.__rtMsgs = rtMsgs;
  sb.__toCore = (m, fromId) => { let r; rtLis.forEach((fn) => fn(m, { id: fromId || 'xprobe-test-ext' }, (x) => { r = x; })); return r; };
  sb.__runTimers = (passes) => {
    for (let i = 0; i < (passes || 3); i++) {
      const batch = timers.splice(0, timers.length);
      if (!batch.length) break;
      batch.forEach((t) => { try { t.fn(); } catch (e) { console.log('  定时器抛错: ' + e.message); } });
    }
  };
  return sb;
}

function run(root, pathname, href, opts) {
  const o = opts || {};
  Object.keys(IDS).forEach((k) => delete IDS[k]);
  const sb = makeSandbox(root, pathname, href, o.fetch !== true);
  vm.runInNewContext(src, sb, { filename: SRC, timeout: 8000 });
  return sb;
}
// 正向对照专用：同一份 fixture、只把源码换成「抠掉某一行」的副本，证明断言咬的是那一行而不是别的东西
function runSource(source, root, pathname, href) {
  Object.keys(IDS).forEach((k) => delete IDS[k]);
  const sb = makeSandbox(root, pathname, href, true);
  vm.runInNewContext(source, sb, { filename: SRC, timeout: 8000 });
  return sb;
}
const logCalls = (sb) => sb.__calls.filter((c) => /\/log$/.test(c.url));
function postedRecords(sb) {
  const out = [];
  logCalls(sb).forEach((c) => {
    try { JSON.parse(c.body).records.forEach((r) => out.push(r)); } catch (e) { out.push({ kind: 'BAD-BODY', msg: e.message }); }
  });
  return out;
}

console.log('\n[1] 数字与聚合 aria 解析');
{
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const f = sb.__xprobe.firstNumber, ps = sb.__xprobe.parseSummaryAria;
  eq('1,234', f('1,234').value, 1234);
  ok('1,234 精确', f('1,234').exact === true, f('1,234'));
  eq('1.2万', f('1.2万').value, 12000);
  ok('1.2万 不精确', f('1.2万').exact === false, f('1.2万'));
  eq('12.3K', f('12.3K').value, 12300);
  eq('整句: 2,578 正在关注', f('2,578 正在关注').value, 2578);
  eq('0 次转帖。转帖', f('0 次转帖。转帖').value, 0);
  ok('3,000+ 判不精确', f('3,000+ 次赞').exact === false, f('3,000+ 次赞'));
  ok('无数字 value=null', f('媒体').value === null, f('媒体'));

  const zh = ps('11 回复、9 喜欢、122 次观看');
  eq('中文聚合 reply', zh.reply.value, 11);
  eq('中文聚合 like', zh.like.value, 9);
  eq('中文聚合 view', zh.view.value, 122);
  ok('中文聚合无 repost', zh.repost === undefined, Object.keys(zh));
  const en = ps('3 Replies, 5 Reposts, 12 Likes, 1.2万 Views');
  eq('英文聚合 reply', en.reply.value, 3);
  eq('英文聚合 repost', en.repost.value, 5);
  eq('英文聚合 like', en.like.value, 12);
  eq('英文聚合 view', en.view.value, 12000);
  ok('英文聚合 view 判缩写', en.view.exact === false, en.view);
  eq('空串不炸', Object.keys(ps('书签')).length, 0);
}

console.log('\n[2] 个人主页快照（复刻真机形状）');
{
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const snap = sb.__xprobe.snapshot();
  eq('handle', snap.identity.handle, 'demo_own');
  eq('displayName 剥掉 @handle 与关系词尾巴', snap.identity.displayName, '示例笔记');
  eq('关注关系 = following（原生 -unfollow 按钮）', snap.identity.followRelation, 'following');
  eq('关系按钮 aria', snap.identity.followAria, '正在关注 @demo_own');
  ok('关系按钮 testid 带数字 ID', /-unfollow$/.test(snap.identity.followTestid), snap.identity.followTestid);
  eq('joined(UserJoinDate 真机 testid)', snap.identity.joined, '加入于 2020年1月');
  ok('headerItemsText 拿到', /全国飞/.test(snap.identity.headerItemsText), snap.identity.headerItemsText);

  const st = snap.stats;
  ok('following 命中', !!st.following, Object.keys(st));
  eq('following 值', st.following.visibleNum.value, 2578);
  ok('following 可见即精确', st.following.visibleNum.exact === true, st.following.visibleNum);
  ok('真机 following 无 aria-label', st.following.ariaNum.value === null, st.following.ariaNum);
  eq('following 数字在子 span', st.following.leafTexts, ['2,578', '正在关注']);
  ok('中文 UI 无 /followers 锚点（事实，不是 bug）', st.followers === undefined, Object.keys(st));
  eq('followers 来源 = verified_followers', st.__followersSource, 'verified_followers');
  eq('关注者值', st.verified_followers.visibleNum.value, 2978);
  ok('关注者精确', st.verified_followers.visibleNum.exact === true, st.verified_followers.visibleNum);

  // v0.8.1：头部自报的帖子总数（tab 上没有 ≠ 页上没有）
  eq('头部帖子总数=5021（tab 上的 decoy/侧栏的 8,888 都不许顶掉它）',
    st.__headerPosts && [st.__headerPosts.value, st.__headerPosts.exact, st.__headerPosts.text],
    [5021, true, '5,021 帖子']);

  const pt = st.__tabs.find((t) => /帖子/.test(t.text));
  ok('认出中文「帖子」tab', !!pt, st.__tabs.map((t) => t.text));
  eq('真机 tab 上没有总数（已知缺口）', pt.num.value, null);

  eq('article 数', snap.tweets.length, 3);
  eq('tweetId 列表', snap.tweets.map((t) => t.tweetId), ['2113132810320097514', '2113119051287597271', '2113100000000000001']);
  eq('author 从 User-Name 的 href 取', snap.tweets[0].author, 'demo_own');
  eq('无 User-Name 的卡片 author 为空', snap.tweets[2].author, '');
  eq('time aria 不会被当数字', snap.tweets[0].timeAria, '1小时 前');

  const m0 = snap.tweets[0].metrics;
  eq('聚合 reply 值', m0.reply.num.value, 11);
  eq('聚合 reply 来源（v0.6.9 起叫 combinedAria，不再与单指标 aria 混成一个标签）', m0.reply.from, 'combinedAria');
  eq('聚合 view 值（列表页也有观看数！）', m0.view.num.value, 122);
  eq('聚合 like 值', m0.like.num.value, 9);
  eq('聚合句里没有 repost → 走按钮', m0.repost.from, 'buttonAria');
  eq('按钮值合并进聚合项', m0.reply.buttonValue, 11);
  eq('观看按钮 aria 合并', m0.view.buttonValue, 122);
  ok('书签/分享无数字就不进 metrics', m0.bookmark === undefined && m0.share === undefined, Object.keys(m0));
  const m1 = snap.tweets[1].metrics;
  eq('无聚合句时全走按钮', m1.view.from, 'buttonAria');
  eq('0 回复算命中', m1.reply.num.value, 0);
  eq('第三条无操作组', Object.keys(snap.tweets[2].metrics), []);

  console.log('\n[3] 命中率');
  const c = snap.cov;
  eq('cov.tweetId', c.tweetId, '3/3');
  eq('cov.timeDatetime', c.timeDatetime, '3/3');
  eq('cov.author', c.author, '2/3');
  eq('cov.authorTestid', c.authorTestid, '2/3');
  eq('cov.summaryAria', c.summaryAria, '1/3');
  eq('cov.reply', c.reply, '2/3');
  eq('cov.repost', c.repost, '2/3');
  eq('cov.like', c.like, '2/3');
  eq('cov.view', c.view, '2/3');
  // v0.6.9：来源不再是一个布尔，而是逐指标的来源计数（这一栏才是「数从哪个节点来」的答案）
  eq('cov.src.view 聚合 1 按钮 1（第2条没有聚合句，观看数只从按钮 aria 来）', [c.src.view.combinedAria, c.src.view.buttonAria], [1, 1]);
  eq('cov.src.reply 聚合 1', c.src.reply.combinedAria, 1);
  ok('cov.src 不许出现 summaryAria 这个旧标签（两种 aria 混成一个就是上一轮的自相矛盾）',
    !JSON.stringify(c.src).includes('summaryAria'), JSON.stringify(c.src));
  eq('cov.quote（真机没有独立引用数）', c.quote, '0/3');
  eq('cov.viewExact', c.viewExact, '2/3');
  eq('cov.follow（原生按钮只在部分行渲染）', c.follow, '1/3');
  eq('行内关系 = not_following', snap.tweets[0].followState, 'not_following');

  console.log('\n[4] 漏抓清单必须逐项精确');
  // tab.posts.number 已结案（X 的 DOM 里本来就没这个数）⇒ 从 miss 挪进 note，见 [8d]
  eq('miss', sb.__xprobe.missingFields(snap),
    ['tweet.author x1', 'metric.reply x1', 'metric.repost x1', 'metric.like x1', 'metric.view x1']);
  ok('头部帖子行采到了 ⇒ miss 里不许点名 header.posts（v0.8.1 正路）',
    sb.__xprobe.missingFields(snap).indexOf('header.posts') < 0, sb.__xprobe.missingFields(snap));
  eq('note 三条：tab.posts.number + quote 结构性盲区 + v0.6.9 的 summaryAria 缺席（fixture 是 1/3 ⇒ 2 行无聚合句）', sb.__xprobe.knownGaps(snap),
    ['tab.posts.number(主页与/home两处复现:tab 上没有总数节点,X 不给;头部那行 v0.8.1 起另抓,见 header.posts)',
     'metric.quote x3(全空:中文页不给转发明细条数,结构性盲区,不是本页没水合)',
     'metric.summaryAria x2(整页没有聚合句:数字走按钮/独立aria,view也缺才在miss里点名)']);
  ok('quote 全空不许混进 miss（它进 miss 就永远是红字，把真漏抓淹掉）',
    !sb.__xprobe.missingFields(snap).some((x) => /quote/.test(x)), sb.__xprobe.missingFields(snap));

  console.log('\n[4b] summaryAria 缺席挪出 miss（真机 2026-10-23：六条 page 的 miss 里只有它自己，真漏抓被淹）');
  {
    // A：整页没有聚合句但一数不缺 ⇒ miss 里不许有 summaryAria，note 只是形状说明
    const snapA = { ...snap, tweets: [
      { ...snap.tweets[0], summaryAria: '' }, { ...snap.tweets[1], summaryAria: '' },
      { ...snap.tweets[2], metrics: { view: { num: { value: 4, exact: false }, from: 'buttonAria', aria: '', testid: '', text: '' } } },
    ] };
    const missA = sb.__xprobe.missingFields(snapA);
    ok('A：数没丢就不许点名 summaryAria（旧写法这里永远是红字）',
      !missA.some((x) => /summaryAria/.test(x)), missA);
    ok('A：view 有数 ⇒ view 也不许出现', !missA.some((x) => /metric\.view/.test(x)), missA);
    ok('A：note 点名 summaryAria 并说明数走按钮/独立 aria',
      sb.__xprobe.knownGaps(snapA).some((n) => /^metric\.summaryAria x3\(整页没有聚合句/.test(n)),
      sb.__xprobe.knownGaps(snapA));
    // B：view 真缺了（fixture 第2条本来就无操作组）⇒ miss 里 view 的点名要带缘由，summaryAria 仍只在 note
    const snapB = { ...snap, tweets: snap.tweets.map((t) => ({ ...t, summaryAria: '' })) };
    const missB = sb.__xprobe.missingFields(snapB);
    ok('B：view 也缺 ⇒ miss 里 view 点名带缘由',
      missB.indexOf('metric.view x1(聚合句也没有,全走按钮)') >= 0, missB);
    ok('B：这一支里 summaryAria 仍不许进 miss',
      !missB.some((x) => /summaryAria/.test(x)), missB);
  }
}

console.log('\n[5] 面板（数据通道 + 格式化层；页面里已经没有面板了。v0.6.9 UI 整顿：四视图=首页/趋势/诊断/设置，按钮按频率归位）');
{
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  sb.__xprobe.doCollect({ force: true });
  const created = sb.__created;
  const res = sb.__toCore({ t: 'state' });
  const lines = V.homeLines(res.state);
  const hero = lines.filter((m) => m.k === 'hero')[0];
  const ht = lines.map((m) => (m.k === 'row' ? m.label + ' ' + m.value : m.k === 'fold' ? m.title + ' ' + m.text : m.k === 'hero' ? '[hero] ' + m.own + ' ' + JSON.stringify(m.items) : m.text)).join('\n');
  const dlines = V.debugLines(res.state);
  const dt = dlines.map((m) => (m.k === 'row' ? m.label + ' ' + m.value : m.k === 'fold' ? m.title + ' ' + m.text : m.text)).join('\n');
  ok('Side Panel 经命令通道拿到 state', res.ok && res.state.last.tweets.length === 3, res.ok);
  eq('渲染不往页面加节点：本模块自己造的就是右下角一根玻璃柱（方案 A 钮排：柱容器 + 内嵌样式 + 探针点 + 分隔线 + 关/榜/回/杆/帖/稿/观 + 各自的 label span；v0.11.4 那第七颗「回帖」造出来就常驻，闸关着时只 display:none，摘了反而每翻一次闸要重建一次）',
    [created.length, created.filter((e) => /^ysy-xprobe/.test(e.id || '')).length], [20, 9]);
  ok('首页有今日四列单卡（四列标签顺序固定；v0.6.11 起打开主页就自动落今天那行 ⇒ 关注/粉丝有数；v0.8.1 起帖子总数也自动采，只剩曝光还是话术）',
    !!hero && /^\d{4}-\d{2}-\d{2}$/.test(hero.day) &&
    hero.items.map((i) => i.label).join('/') === '曝光/关注/粉丝/帖子' &&
    hero.note === '' && hero.items[1].v != null && hero.items[2].v != null &&
    hero.items[0].v == null && /补录/.test(hero.items[0].hint) &&
    String(hero.items[3].v) === '5021' && /自报/.test(hero.items[3].hint), hero);
  {
    // 上面那条 note==="" 只有在「没有今天那行」的世界里才该翻回话术 —— 拿一份空 series 的 state 反向钉一下，
    // 否则判据写成恒真（无论有没有行都过）就是走过场
    const noRowState = Object.assign({}, res.state, { series: { key: 'demo_own', own: 'demo_own', counts: {}, handles: [], min: [], imp: [], rank: [] } });
    const h0 = V.homeLines(noRowState).filter((m) => m.k === 'hero')[0];
    ok('正向对照：series 里没有今天那行 ⇒ hero 翻回「今天还没有点位」话术、四列全空',
      /点位/.test(h0.note) && h0.items.every((i) => i.v == null), h0);
  }
  {
    // 真机上今日四列要有数，得先认到 own 且有点位；[5] 这个沙箱正好是「还没进过奖励页/没打过点」的世界，
    // 所以 hero 的数字口径用种了 data 的面板 state 钉（形状与 stateForPanel 出来的一致），空世界的 hero 只钉话术
    const todayKey = (function () { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); })();
    const seeded = Object.assign({}, res.state, {
      series: {
        key: 'demo_own', own: 'demo_own', counts: { min: 3, imp: 1 }, handles: [], err: '',
        min: [{ ts: Date.now() - 40000, at: new Date(Date.now() - 40000).toISOString(), following: 2578, followers: 2978 },
              { ts: Date.now(), at: new Date().toISOString(), following: 2580, followers: 2980 }],
        imp: [{ day: todayKey, value: 10100, exact: false, token: '10.1k', at: Date.now(), fow: null, fans: null, posts: null }],
      },
    });
    const hero2 = V.homeLines(seeded).filter((m) => m.k === 'hero')[0];
    ok('首页四列口径 = 日点表的口径：曝光缩写值 1.01万~（两位万，13.2K 那种手抄值不被糊成 1.0万）、关注取分钟线当日最高（标 ·最高）、粉丝取最新分钟点',
      hero2.own === 'demo_own' && hero2.day === todayKey &&
      hero2.items[0].v === '1.01万~' && hero2.items[0].hint.indexOf('缩写') === 0 &&
      hero2.items[1].v === '最高 2580' && hero2.items[1].max === true &&
      hero2.items[2].v === '2980' && hero2.items[3].v === '—', hero2);
  }
  // 命中率行长 `x/3` 这种样子；今日进度行也带 `0/399` 这类分数 ⇒ 打分前先把进度行丢开，只信「有没有诊断行」
  const htClean = lines.filter((m) => m.label !== '今日关注进度').map((m) => (m.k === 'row' ? m.label + ' ' + m.value : m.k === 'fold' ? m.title + ' ' + m.text : m.k === 'hero' ? '[hero] ' + m.own + ' ' + JSON.stringify(m.items) : m.text)).join('\n');
  ok('首页不塞发散内容：存储占用/命中率/漏抓这些归诊断，首页只有数字、进度条与两盏灯',
    !/本地存储 chrome\.storage\.local|本机档案库|\d+\/3/.test(htClean), htClean.slice(0, 600));
  ok('首页守卫额度可读（15分钟/24小时同一段）', /15分钟 \d+\/15\s+24小时 \d+\/400/.test(ht), ht.slice(0, 800));
  ok('首页通道灯把 sink 与本机库压成一行（断开就红，别把排障细节端上来）',
    lines.some((m) => m.k === 'row' && m.label === '通道' && /sink|库/.test(m.value) && m.title.indexOf('诊断') >= 0),
    lines.filter((m) => m.label === '通道'));
  ok('诊断视图含命中率', /tweetId\s+3\/3/.test(dt), dt.slice(0, 500));
  ok('诊断视图含 sink 状态长行与库长行（首页灯的详情区）', /日志 sink/.test(dt) && /本机档案库 xprobe\.db/.test(dt), dt.slice(0, 600));
  ok('诊断视图含漏抓行', /漏抓:.*tweet\.author/.test(dt), dt.slice(-500));
  ok('已结案的缺口走「已知缺口」折叠块，不再混在漏抓里',
    /已知缺口 \/ 已排除的脏数据 \(\d+\)[\s\S]*tab\.posts\.number/.test(dt), dt.slice(-700));
  ok('诊断视图拿得到来源判定（粉丝数来源那行）', /粉丝数来源: verified_followers/.test(dt), dt.slice(0, 900));
  ok('旧「本页」视图的读数质量行搬进诊断（身份+统计来源+posts tab）——首页不再报字符级判读',
    /@demo_own/.test(dt) && /正在关注 2578/.test(dt) && /posts\(tab\)/.test(dt), dt.slice(0, 1000));
  ok('诊断视图显示关注关系与关注者精确', /关注关系: following/.test(dt) && /关注者\(\/verified_followers\).*可见文本即精确值/.test(dt), dt.slice(0, 1200));
  ok('帖子 tab 有但没数字（结案那行在诊断）', /有 tab 没数字/.test(dt), dt.slice(0, 1100));
  ok('state 带调试开关与随机加时上限（面板按它决定入口与显示）',
    [res.state.debug.on, res.state.rndMax], [false, 20]);
  eq('runs 本地兜底 1 条', store['ysy.xprobe.v1'].length, 1);
  eq('原文折叠块归诊断，且按实际有值的锚点出现（这页没有 /followers 锚点，就不该给一个空折叠）',
    dlines.filter((m) => m.k === 'fold').map((m) => m.title),
    ['已知缺口 / 已排除的脏数据 (3)', '看 article HTML', '看 following 锚点 HTML']);
  const gl = V.guardLine(res.state);
  ok('守卫行给两个滚动窗口和额度', /^15分钟 \d+\/15 {2}24小时 \d+\/400/.test(gl.value) && gl.sty === 'ok', gl.value);
  ok('守卫行的悬停把「只警告」写死', /到限只警告（不拦点击/.test(gl.title), gl.title.slice(0, 60));
  ok('通道灯：sink 正常时绿、断开时红（没有中间态骗人）',
    V.chLine({ sink: { ok: true, posted: 30, qlen: 0, db: { available: true, bytes: 500, records: 9, maxAt: '2026-10-23T07:48:00.000Z' } } }).sty === 'ok' &&
    /sink OK · 已写 30/.test(V.chLine({ sink: { ok: true, posted: 30, qlen: 0 } }).value) &&
    V.chLine({ sink: { ok: false, qlen: 2, q: { count: 7 } } }).sty === 'bad' && /待发 2 · 暂存 7/.test(V.chLine({ sink: { ok: false, qlen: 2, q: { count: 7 } } }).value));
  ok('sink 未测时通道灯明说去哪儿测（不说 OK 也不说断开）', /未测/.test(V.chLine({ sink: {} }).value), V.chLine({ sink: {} }).value);
  eq('没采集过的 state 也能渲染：首页给引导、诊断给明细而不是崩',
    [V.homeLines({ ver: 'x', build: 'x', counts: {}, guard: {}, sink: {}, dump: {}, series: {}, tab: 'home', href: '' }).length >= 4,
     V.debugLines({ ver: 'x', build: 'x', counts: {}, guard: {}, sink: {}, dump: {}, tab: 'home', href: '' }).length >= 4], [true, true]);
  ok('首页的 hero 虚位明说怎么补：今天没点位就给下一步（去奖励页采集/去趋势补历史）',
    V.homeLines({ counts: {}, guard: {}, sink: {}, dump: {}, series: { min: [], imp: [] }, tab: 'home', href: '' })
      .filter((m) => m.k === 'hero')[0].note.indexOf('点位') >= 0, '');
}

console.log('\n[6] 页面分类与去重（真机 7 条重复 home 的修正）');
{
  const sb = run(homeFixture, '/home', 'https://x.com/home');
  eq('home 页 handle 为空', sb.__xprobe.snapshot().identity.handle, '');
  eq('home 页不认侧栏按钮为页面关系', sb.__xprobe.snapshot().identity.followRelation, '');
  sb.__runTimers(3);
  const before = postedRecords(sb).length;
  const again = sb.__xprobe.doCollect();
  eq('同页 45s 内再采 = dup，不上报', postedRecords(sb).length, before);
  ok('dup 标记置上', again.dup === true, again.dup);
  sb.__xprobe.doCollect({ force: true });
  sb.__xprobe.flush();
  ok('force 强制上报', postedRecords(sb).length > before, { before, after: postedRecords(sb).length });

  const notif = run(homeFixture, '/notifications', 'https://x.com/notifications');
  const q0 = notif.__xprobe.queue.length;
  notif.__xprobe.doCollect();
  eq('notifications 不自动上报', notif.__xprobe.queue.length, q0);
  notif.__xprobe.doCollect({ force: true });
  eq('强制时 tab 字段是 notifications', notif.__xprobe.tabName ? notif.__xprobe.tabName() : notif.__xprobe.queue[notif.__xprobe.queue.length - 1].tab, 'notifications');

  const comp = run(profile, '/compose/post', 'https://x.com/compose/post');
  eq('compose 不当成 profile', comp.__xprobe.tabName(), 'compose');
  eq('compose 页 handle 不认成 demo_own', comp.__xprobe.snapshot().identity.handle, '');
}

console.log('\n[6b] 关注/粉丝列表页（UserCell 行 · hydrated · 自己的主页）');
{
  const row = (o) => {
    const kids = [];
    if (o.nameVia) kids.push(h('div', { 'data-testid': o.nameVia }, [T(o.name)]));
    if (o.desc) kids.push(h('div', { 'data-testid': 'UserDescription' }, [T(o.desc)]));
    (o.links || []).forEach((l) => kids.push(h('a', { href: l.href }, [T(l.text || '链接')])));
    if (o.follow) kids.push(h('button', { 'data-testid': o.follow, 'aria-label': o.followAria }, [T('按钮')]));
    return h('div', { 'data-testid': 'UserCell' }, kids);
  };
  // 真机 /home 探测：侧栏「推荐关注」同样是 UserCell（article 6 个而 UserCell 3 个）
  // ⇒ 列表行必须按正文列 primaryColumn 取域，否则「我关注了谁」会被推荐位污染
  const followingFixture = h('div', {}, [
    h('div', { 'data-testid': 'primaryColumn' }, [
      row({ nameVia: 'UserName', name: '子想互关@jackyang886关注了你', links: [{ href: '/jackyang886' }], follow: '1493114391747006467-unfollow', followAria: '正在关注 @jackyang886' }),
      // 真机主页时间线里的推荐行用的是 User-Name（列表页是 UserName），必须两种都认
      row({ nameVia: 'User-Name', name: '某人 @u2', desc: '一句话简介', links: [{ href: '/u2' }, { href: '/u2/status/999', text: '帖子' }], follow: '987654321-follow', followAria: '关注 @u2' }),
      // 真机 misskiss5998 那 3 行：testid 一个都没有 ⇒ 退到「指主页那个锚」的文本，nameHow 记 anchorText
      row({ links: [{ href: '/u3', text: '推荐的人 @u3' }] }),
      // 只有多段路径 = handle 抠不到，必须点名而不是猜
      row({ links: [{ href: '/i/u4/status/888', text: '状态' }] }),
    ]),
    h('div', { 'data-testid': 'sidebarColumn' }, [
      row({ nameVia: 'UserName', name: '推荐关注 @rec0', links: [{ href: '/rec0' }], follow: '111-follow', followAria: '关注 @rec0' }),
    ]),
  ]);
  const sb = run(followingFixture, '/demo_own/following', 'https://x.com/demo_own/following');
  const snap = sb.__xprobe.snapshot();
  eq('列表页认成 following（不和主页混）', sb.__xprobe.tabName(), 'following');
  eq('UserCell 行数（正文列 4，侧栏那行不算）', snap.users.length, 4);
  eq('取域 = primary', snap.usersScope, 'primary');
  eq('整页 UserCell 数（含侧栏）另存，供对照', snap.userCellInDoc, 5);
  eq('列表页 hydrated 看 users', snap.hydrated, true);
  eq('handle 只认单段个人主页链接', snap.users.map((u) => u.handle), ['jackyang886', 'u2', 'u3', '']);
  eq('显示名三种来源都能拿到', snap.users.map((u) => u.name), ['子想互关', '某人', '推荐的人', '']);
  eq('nameHow 说清每行用的哪种来源', snap.users.map((u) => u.nameHow), ['UserName', 'User-Name', 'anchorText', '']);
  eq('脏原文保留', /关注了你/.test(snap.users[0].nameRaw), true);
  eq('关系：-unfollow=following / -follow=not_following', snap.users.map((u) => u.followState), ['following', 'not_following', '', '']);
  eq('行内简介', snap.users[1].bio, '一句话简介');
  eq('行内有状态链接', snap.users[1].hasStatusLink, true);
  eq('列表命中率（bio 与 origin 一起报：origin 用来区分真列表行 / 完整行 / 推荐位行）', snap.covUsers,
    { rows: 4, handle: '3/4', name: '3/4', follow: '2/4', bio: '1/4', nameHow: { UserName: 1, 'User-Name': 1, anchorText: 1, none: 1 }, origin: { list: 4 } });
  // 真机踩点：列表页 document 里第一个 UserName 是「列表第一行」的，绝不能当页主身份
  eq('列表页不把第一行当页主（hasHeader）', snap.identity.hasHeader, false);
  eq('列表页 displayName 留空', snap.identity.displayName, '');
  eq('列表页 handle 仍来自 URL', snap.identity.handle, 'demo_own');
  const miss = sb.__xprobe.missingFields(snap);
  ok('点名 users.handle x1', miss.indexOf('users.handle x1') >= 0, miss);
  ok('点名 users.followState x2', miss.indexOf('users.followState x2') >= 0, miss);
  ok('点名 users.name x1', miss.indexOf('users.name x1') >= 0, miss);
  ok('列表页不抱怨主页字段', !miss.some((m) => /^(tab\.posts|stats\.|exact\.|identity\.)/.test(m)), miss);

  sb.__runTimers(3);
  const recs = postedRecords(sb);
  const pageRec = recs.find((r) => r.kind === 'page');
  ok('following 页会自动上报（在 REPORTABLE 里）', !!pageRec, recs.map((r) => r.kind));
  eq('page.tabType', pageRec.tabType, 'following');
  eq('page.userRows', pageRec.userRows, 4);
  eq('page.hydrated', pageRec.hydrated, true);
  eq('page.covUsers 跟着上报', pageRec.covUsers.follow, '2/4');
  eq('page.usersScope', pageRec.usersScope, 'primary');
  const probeRec = recs.find((r) => r.kind === 'probe');
  eq('probe.userCellCount 是整页数', probeRec.data.userCellCount, 5);
  eq('probe.userCellInPrimary 是正文列数', probeRec.data.userCellInPrimary, 4);
  eq('probe.primaryPresent', probeRec.data.primaryPresent, true);
  eq('probe.userCellDumps 前 2 条', probeRec.data.userCellDumps.length, 2);
  ok('dump 里能看到 UserCell 形状', /UserCell/.test(probeRec.data.userCellDumps[0]), probeRec.data.userCellDumps[0].slice(0, 80));
  ok('dump 里没有侧栏推荐行', !probeRec.data.userCellDumps.some((x) => /rec0/.test(x)), probeRec.data.userCellDumps.map((x) => x.slice(0, 60)));
  const again = sb.__xprobe.doCollect();
  ok('列表页同内容 45s 内 dup', again.dup === true, again.dup);

  // 没水合的列表页：行数是 0，必须说「没水合」，不能什么都不报
  const dry = h('div', {}, [h('div', {}, [T('加载中')])]);
  const sd = run(dry, '/demo_own/followers', 'https://x.com/demo_own/followers');
  const dsnap = sd.__xprobe.snapshot();
  eq('空列表 hydrated=false', dsnap.hydrated, false);
  ok('点名 users.rows x0(列表没水合)', sd.__xprobe.missingFields(dsnap).indexOf('users.rows x0(列表没水合)') >= 0, sd.__xprobe.missingFields(dsnap));
  eq('followers 页型单独认', sd.__xprobe.tabName(), 'followers');

  // 自己的主页：没有关注按钮，靠 editProfileButton 认，别把「抠不到关系」当异常
  const mine = h('div', {}, [
    h('div', { 'data-testid': 'UserName' }, [T('我的名字@me')]),
    h('button', { 'data-testid': 'editProfileButton' }, [T('编辑资料')]),
    h('div', { 'data-testid': 'UserJoinDate' }, [T('加入于 2021年5月')]),
    h('div', { 'data-testid': 'UserProfileHeader_Items' }, [T('加入于 2021年5月')]),
    statLink('/me/following', '', '312 正在关注'),
    statLink('/me/verified_followers', '', '1,024 关注者'),
    tweetCell('me', '777', '2026-10-22T06:00:00.000Z', '我自己的一条', { group: group(true, { reply: 2, repost: 1, like: 8, view: 66 }) }),
  ]);
  const sm = run(mine, '/me', 'https://x.com/me');
  const snapm = sm.__xprobe.snapshot();
  eq('认出这是自己的主页', snapm.identity.ownProfile, true);
  eq('自己主页 followRelation 为空是对的', snapm.identity.followRelation, '');
  eq('自己主页 handle', snapm.identity.handle, 'me');
  eq('自己主页粉丝数照样精确（中文 UI 走 verified_followers）', snapm.stats.verified_followers.visibleNum.value, 1024);
  eq('自己主页 listTab 为空', snapm.identity.listTab, '');

  // 真机第三种脏名：状态词夹在显示名和 handle 中间
  const dirtyRow = h('div', {}, [row({ links: [{ href: '/21Jik22388', text: '21 Jik关注了你@21Jik22388关注了你' }] })]);
  const sdy = run(dirtyRow, '/21Jik22388', 'https://x.com/21Jik22388');
  eq('剥掉中间和尾部的「关注了你」', sdy.__xprobe.snapshot().users[0].name, '21 Jik');
  ok('没有正文列时退回整页并在 scope 里说明', /document/.test(sdy.__xprobe.snapshot().usersScope), sdy.__xprobe.snapshot().usersScope);

  // 真机 /home：唯一抠不到 time 的卡片是 X Business 推广位，statusHref 还是 /analytics 结尾
  const adArt = h('article', { 'data-testid': 'tweet' }, [
    h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/XBusiness' }, [T('X Business @XBusiness')])]),
    h('a', { href: '/XBusiness/status/2109771781133484112/analytics' }, [T('查看数据')]),
    h('div', { 'data-testid': 'tweetText' }, [T('Get $500 in ad credit when you spend $500.')]),
    h('div', { role: 'group', 'aria-label': REAL_SUMMARY }, []),
  ]);
  const adFix = h('div', {}, [h('div', { 'data-testid': 'primaryColumn' }, [adArt])]);
  const sa = run(adFix, '/home', 'https://x.com/home');
  const asn = sa.__xprobe.snapshot();
  eq('无 time 的卡片标成推广位', asn.tweets[0].adSuspect, true);
  eq('推广位照样抠得到 tweetId（…/status/<id>/analytics）', asn.tweets[0].tweetId, '2109771781133484112');
  eq('作者名原文也留着对照', asn.tweets[0].authorNameRaw, 'X Business @XBusiness');
  eq('广告不进命中率分母', [asn.cov.ads, asn.cov.clean, asn.cov.articles, asn.cov.tweetId], [1, 0, 1, '0/0']);
  const am = sa.__xprobe.missingFields(asn);
  ok('miss 报 card.ad 而非 tweet.time', am.some((m) => /^card\.ad x1/.test(m)) && !am.some((m) => /^tweet\.time/.test(m)), am);
  ok('全是推广位时不误报互动数漏抓', !am.some((m) => /^metric\./.test(m)), am);
}

console.log('\n[7] 正向对照：没有 verified_followers 时要点名 stats.followers');
{
  const onlyFollowing = h('div', {}, [
    h('div', { 'data-testid': 'UserName' }, [T('某人 @m')]),
    statLink('/m/following', '', '1,234 正在关注'),
  ]);
  const sb = run(onlyFollowing, '/m', 'https://x.com/m');
  const snap = sb.__xprobe.snapshot();
  eq('来源为空', snap.stats.__followersSource, '');
  // 正向对照：页面上只有第三方脚本注入的「互相关注」角标、没有原生 -follow 按钮时，关系必须判为空
  const onlyForeign = h('div', {}, [
    h('div', { 'data-testid': 'UserName' }, [T('某人@m')]),
    h('span', { class: 'xro-badge', 'aria-label': 'm: 互相关注' }, [T('互关')]),
  ]);
  const sf = run(onlyForeign, '/m', 'https://x.com/m');
  eq('不认第三方角标为关注按钮', sf.__xprobe.snapshot().identity.followRelation, '');
  ok('点名 stats.followers', sb.__xprobe.missingFields(snap).indexOf('stats.followers') >= 0, sb.__xprobe.missingFields(snap));
  const ariaLess = h('div', {}, [
    h('div', { 'data-testid': 'UserName' }, [T('某人 @m')]),
    statLink('/m/followers', '', '1.2万 Followers'),
  ]);
  const sb2 = run(ariaLess, '/m', 'https://x.com/m');
  const snap2 = sb2.__xprobe.snapshot();
  ok('aria 空 + 文本缩写 → 点名 exact.followers', sb2.__xprobe.missingFields(snap2).indexOf('exact.followers') >= 0, sb2.__xprobe.missingFields(snap2));
  eq('仍从可见文本拿缩写', snap2.stats.followers.visibleNum.value, 12000);
  ok('加入时间缺失要点名', sb2.__xprobe.missingFields(snap2).indexOf('identity.joined') >= 0, sb2.__xprobe.missingFields(snap2));
}

console.log('\n[8] 日志通道与记录形状');
{
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  ok('boot 先 /ping', sb.__calls.length === 1 && /\/ping$/.test(sb.__calls[0].url) && sb.__calls[0].via === 'GM_xmlhttpRequest', sb.__calls.map((c) => c.url));
  sb.__runTimers(3);
  const recs = postedRecords(sb);
  const kinds = recs.map((r) => r.kind);
  eq('beacon → page → store → probe', kinds, ['beacon', 'page', 'store', 'probe']);
  const body = JSON.parse(logCalls(sb)[0].body);
  ok('带 build 标记（防跑旧代码）', body.build === SRC_BUILD && body.ver === SRC_VER && /^\d{4}-\d{2}-\d{2}-[a-z]$/.test(SRC_BUILD), { body: body.build, src: SRC_BUILD, ver: body.ver });
  const pageRec = recs.find((r) => r.kind === 'page');
  eq('page.tabType', pageRec.tabType, 'profile');
  eq('page.handle', pageRec.handle, 'demo_own');
  eq('page.cov.summaryAria', pageRec.cov.summaryAria, '1/3');
  // 推荐位卡片（无作者头、无操作组）是唯一真漏抓；tab.posts.number 已结案，见 [8d]
  eq('page.miss 只报真漏抓', pageRec.miss, ['tweet.author x1', 'metric.reply x1', 'metric.repost x1', 'metric.like x1', 'metric.view x1']);
  ok('tab.posts.number 降级进 note（X 的 DOM 里本来没这个数，别再占漏抓清单）',
    pageRec.note.some((n) => /^tab\.posts\.number/.test(n)) && !pageRec.miss.some((m) => /^tab\.posts/.test(m)),
    { miss: pageRec.miss, note: pageRec.note });
  const sd = recs.find((r) => r.kind === 'store').data;
  const meRow = sd.users.find((u) => u.h === 'demo_own');
  ok('store 摘要带两张表的行数', sd.counts && sd.users.length <= 12 && sd.posts.length <= 8, sd.counts);
  eq('页主那一行的内容回传（名字/粉丝/关注/精确/关系/历史点数）',
    [meRow.n, meRow.f, meRow.fw, meRow.fe, meRow.rel, meRow.pts >= 1], ['示例笔记', 2978, 2578, true, 'following', true]);
  ok('users 行每行都有 handle 与历史计数', sd.users.every((u) => u.h && typeof u.pts === 'number'), sd.users.map((u) => u.h));
  ok('posts 行每行都有 id/作者/正文摘要/首见时间',
    sd.posts.every((p) => p.id && typeof p.t === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.fs)), sd.posts.slice(0, 2));
  const probeRec = recs.find((r) => r.kind === 'probe');
  const d = probeRec.data;
  eq('probe.userNameTags（真机是 div）', d.userNameTags, { div: 2 });
  ok('probe.groupArias 含聚合句', d.groupArias.indexOf(REAL_SUMMARY) >= 0, d.groupArias);
  eq('probe.tweetTestidCount', d.tweetTestidCount, 3);
  eq('probe.statsAnchors 2 个', d.statsAnchors.length, 2);
  const fb = d.statsAnchors.find((a) => /verified_followers/.test(a.href));
  ok('锚点带 chain 且到根', fb && fb.chain.length >= 2, fb && fb.chain);
  ok('锚点带 parentHtml', fb && /verified_followers/.test(fb.parentHtml), fb && fb.parentHtml.slice(0, 90));
  ok('噪声 aria 被过滤（1小时 前 不入选）', !d.ariaNumbers.some((a) => /小时/.test(a.aria)), d.ariaNumbers.map((a) => a.aria));
  eq('过滤后带数字 aria 条数', d.ariaNumberCount, 9);
  eq('probe.followButtons 抓到 2 个原生按钮', (d.followButtons || []).length, 2);
  ok('按钮带 state 与 chain', d.followButtons.some((b) => b.state === 'following' && /-unfollow$/.test(b.testid) && b.chain.length >= 1), d.followButtons);
  eq('probe 认出第三方注入节点（xro-badge 不是 X 的 DOM）', d.foreignBadges, 1);
  eq('第三方类名清单', d.foreignClasses, { 'xro-badge': 1 });
  ok('聚合句带 parsed 三键', d.ariaNumbers.some((a) => a.parsed && a.parsed.view), d.ariaNumbers.slice(0, 2));

  console.log('\n[8b] sink 断开：暂存、落盘、断线事件与恢复补发（v0.6.9 这一轮的主线）');
  RESP.post = { status: 0, text: '' };
  sb.__xprobe.doCollect({ force: true });
  const qBefore = sb.__xprobe.queue.length;
  sb.__xprobe.flush();
  ok('sinkOk=false', sb.__xprobe.status().sinkOk === false, sb.__xprobe.status());
  // v0.6.9：断开这件事自己也要成一条记录 ⇒ 队列比原来多一条，多的那条必须是 sink[down]
  eq('记录退回队列 + 一条 sink[down] 事件', sb.__xprobe.queue.length, qBefore + 1);
  const downEv = sb.__xprobe.queue.filter((r) => r.kind === 'sink');
  eq('一次事故只记一条 down（不许每次失败都刷一条）', downEv.length, 1);
  eq('down 事件带当时的队列形状与错误', [downEv[0].data.ev, downEv[0].data.qlen > 0, !!downEv[0].data.err], ['down', true, true]);
  // 断线时队列必须落扩展存储：上一轮那 13 条全靠两个标签页没刷新才没丢，这是这一版的立项依据
  const qk = sb.__xprobe.queueKey(), qSlot = store[qk];
  ok('断开当场把待发落到 ' + qk + '（按 bootId 分格，两个标签页不互相覆盖）',
    !!qSlot && Object.keys(qSlot).length === 1 && Array.isArray(qSlot[Object.keys(qSlot)[0]].recs), qSlot);
  const bootedRecs = qSlot ? qSlot[Object.keys(qSlot)[0]].recs : [];
  ok('落盘的是精简快照（整页原文塞进存储就是上一轮顶穿配额那一手）',
    bootedRecs.some((r) => r.qs === 1 && r.data && r.data.slim === 1) &&
    bootedRecs.every((r) => !r.data || !r.data.tweets || !r.data.tweets.some((t) => t.html)),
    bootedRecs.map((r) => [r.kind, r.qs]));
  eq('队列账本认了这次落盘', [sb.__xprobe.qMeta().persisted >= 1, sb.__xprobe.qMeta().count > 0], [true, true]);
  const sinkL = V.sinkLine(sb.__toCore({ t: 'state' }).state);
  const sunkN = Number((/已落盘 (\d+) 条/.exec(sinkL.value) || [])[1] || 0);
  ok('面板那行报红字并报出「已落盘多少条」（数字要真大于 0 —— 反向对照时这条差点被句式蒙过去）',
    /断开/.test(sinkL.value) && sinkL.sty === 'bad' && sunkN > 0, { value: sinkL.value, sunkN: sunkN });
  eq('成功计数不涨', sb.__xprobe.status().posted, 4);
  sb.__xprobe.flush();
  eq('正向对照：同一场断线里第二次失败不再多记 down', sb.__xprobe.queue.filter((r) => r.kind === 'sink').length, 1);
  // pagehide 那一支单独钉：上一轮那 13 条能活下来纯属侥幸（两个标签页恰好没刷新），
  // 「断线时刷新页面」这条路必须自己把积压留下，而不是指望我别刷新
  store[qk] = {};
  sb.window.fire('pagehide');
  ok('页面卸载前把待发落盘（按 bootId 那一格，别人留下的格子不受影响）',
    Object.keys(store[qk] || {}).length === 1 && (store[qk][Object.keys(store[qk])[0]] || {}).recs.length > 0, store[qk]);
  RESP.post = { status: 200, text: '{"ok":true,"stored":1}' };
  const n0 = postedRecords(sb).length;
  sb.__xprobe.flush();
  // 恢复：先把积压发干净，队列里只剩刚记下的那条 sink[up]（它在下一次 flush 才出去）
  eq('恢复后队列只剩一条 sink[up]', sb.__xprobe.queue.map((r) => r.kind), ['sink']);
  eq('up 事件报的是断线时长这一支', [sb.__xprobe.queue[0].data.ev, typeof sb.__xprobe.queue[0].data.offlineMs], ['up', 'number']);
  ok('恢复后重发', postedRecords(sb).length > n0, { n0, n1: postedRecords(sb).length });
  sb.__xprobe.flush();
  eq('再 flush 一次把 up 也发出去，队列归零', sb.__xprobe.queue.length, 0);
  eq('队列空了强制清掉这一格（不留过期积压给别人误认领）', [sb.__xprobe.qMeta().count, (store[qk][Object.keys(store[qk])[0]] || {}).recs], [0, []]);

  // 认领：另一个标签页留下的格子（写于 3 分钟前、主人已经不写了）要被新页面捡起来
  const oldSlot = { 'zz-dead-tab': { t: Date.now() - 180000, recs: [{ kind: 'page', at: '2026-10-23T01:00:00.000Z', url: 'https://x.com/zz_own', tab: 'profile', data: { tweets: [] }, qs: 1 }] } };
  store[qk] = JSON.parse(JSON.stringify(oldSlot));
  const sbAd = run(profile, '/demo_own', 'https://x.com/demo_own');
  eq('开机即认领旧格 1 条', sbAd.__xprobe.qMeta().adopted, 1);
  eq('认领来的记录排在最前并打上 qback（日志里分得清是谁留下的）',
    [sbAd.__xprobe.queue[0].kind, sbAd.__xprobe.queue[0].qback], ['page', 1]);
  eq('beacon 里带 qback（这页一开机就知道自己替上一页面补了多少条）',
    sbAd.__xprobe.queue.filter((r) => r.kind === 'beacon')[0].data.qback, 1);
  // 反向对照：太新（主人还在写）与太旧（迟到得没意义）两种格子都不许动
  const nowMs = Date.now();
  store[qk] = { fresh: { t: nowMs - 5000, recs: [{ kind: 'page', at: 'x', url: 'u', data: {} }] },
                ancient: { t: nowMs - 40 * 60000, recs: [{ kind: 'page', at: 'y', url: 'v', data: {} }] } };
  const sbNo = run(profile, '/demo_own', 'https://x.com/demo_own');
  eq('正在被写的格子不抢、超过 6 分钟的格子不捡（两条都成立才叫认领有门槛）',
    [sbNo.__xprobe.qMeta().adopted, sbNo.__xprobe.queue.filter((r) => r.qback).length], [0, 0]);
  store[qk] = {};
  const sb3 = run(profile, '/demo_own', 'https://x.com/demo_own', { fetch: true });
  ok('无 GM_xmlhttpRequest 时走 fetch', sb3.__calls[0].via === 'fetch', sb3.__calls[0]);
  sb3.__runTimers(3);
  ok('fetch 路径也上报', logCalls(sb3).length >= 1, sb3.__calls.length);
}

console.log('\n[8d] v0.6.0 四处收窄：别人的号 / 注入文本 / 推荐位行 / 另一个宿主');
{
  // A 按 handle 收窄：真机 /zhouuohzz/status 把侧栏作者卡 /Tiduc2026show 的 6,569 与 5,189 当成了页主的数
  // 用新 handle：两张表的 store 桩在整份自检里是同一份，复用 demo_own 会拿到前面几个用例写进去的行
  const statBox = h('div', {}, [
    h('div', { 'data-testid': 'UserName' }, [T('收窄测试@zz_own')]),
    statLink('/zz_own/following', '', '2,578 正在关注'),
    statLink('/zz_other/verified_followers', '', '5,189 关注者'),
    statLink('/zz_other/following', '', '6,569 正在关注'),
  ]);
  const sA = run(statBox, '/zz_own', 'https://x.com/zz_own');
  const stA = sA.__xprobe.collectStats('zz_own');
  ok('只收本页 handle 的锚点（别人的 verified_followers 不再冒充粉丝数）',
    stA.following && stA.following.href === '/zz_own/following' && !stA.verified_followers && !stA.followers,
    { own: stA.following && stA.following.href, vf: stA.verified_followers && stA.verified_followers.href });
  eq('别人的锚点原样留在 __foreign：号、href、数值都能对回现场',
    stA.__foreign.map((f) => [f.owner, f.href, f.value]),
    [['zz_other', '/zz_other/verified_followers', 5189], ['zz_other', '/zz_other/following', 6569]]);
  const snapA = sA.__xprobe.snapshot();
  const upA = sA.__xprobe.upsertStores(snapA, Date.now());
  const uA = sA.__xprobe.getUsers()['zz_own'];
  eq('别人的粉丝数没落进页主那一行（只有本页那个关注数进表）', [uA.followers, uA.following], [null, 2578]);
  ok('upsert 记下了排除了几条', upA.foreignStats >= 2, upA);
  ok('__foreign 进「已知缺口」单独一列，不占漏抓清单',
    sA.__xprobe.knownGaps(snapA).some((n) => /^stats\.__foreign x2/.test(n)) && !sA.__xprobe.missingFields(snapA).some((m) => /foreign/.test(m)),
    sA.__xprobe.knownGaps(snapA));
  ok('正向对照：这张主页没有「N 帖子」头部行 ⇒ header.posts 立刻进漏抓清单（证明 [2] 那条不是白过）',
    sA.__xprobe.missingFields(snapA).indexOf('header.posts') >= 0, sA.__xprobe.missingFields(snapA));

  // B 第三方注入文本就缝在名字节点里（真机「月川互关」）：读文本走 TreeWalker 跳过注入子树
  const nameBox = h('div', {}, [
    h('div', { 'data-testid': 'UserName' }, [
      h('div', {}, [h('span', {}, [T('月川')]), h('span', { class: 'xro-badge xro-badge--mutual' }, [T('互关')]), h('span', {}, [T('@yuechuan')])]),
    ]),
  ]);
  const sB = run(nameBox, '/yuechuan', 'https://x.com/yuechuan');
  const idtB = sB.__xprobe.snapshot().identity;
  eq('显示名剥掉注入文本', idtB.displayName, '月川');
  eq('未剥的全文留着对照（剥错了两边一比就看得出来）', idtB.displayNameDirty, '月川互关@yuechuan');
  ok('原生文本拼出来不含「互关」', idtB.displayNameRaw.indexOf('互关') < 0, idtB.displayNameRaw);
  eq('nameForeign 记下剥掉了几个节点（脏名字等一次干净读才允许覆盖）', idtB.nameForeign, 1);
  ok('注入节点数进「已知缺口」', sB.__xprobe.knownGaps(sB.__xprobe.snapshot()).some((n) => /^foreignNodes x1/.test(n)),
    sB.__xprobe.knownGaps(sB.__xprobe.snapshot()));

  // C 列表行只收真的列表行：推荐位行（origin=side）不落表，否则「查我关注了谁」查出来的是 X 的推荐位
  const cell = (handle, name, kind) => h('div', { 'data-testid': 'UserCell' }, [
    kind === 'row' ? h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/' + handle }, [T(name + ' @' + handle)])]) : '',
    kind === 'side' ? h('a', { href: '/' + handle }, [T(name + ' @' + handle)]) : '',
    h('button', { 'data-testid': '777-follow', 'aria-label': '关注 @' + handle }, [T('关注')]),
  ]);
  const listBox = h('div', {}, [
    h('div', { 'data-testid': 'primaryColumn' }, [cell('c_one', '一号', 'row'), cell('c_side', '推荐位', 'side')]),
    h('div', { 'data-testid': 'sidebarColumn' }, [cell('c_nav', '侧栏', 'row')]),
  ]);
  const sC = run(listBox, '/demo_own', 'https://x.com/demo_own');
  const snapC = sC.__xprobe.snapshot();
  eq('取域 = primaryColumn：侧栏那 1 条 UserCell 一条都不进列表', [snapC.usersScope, snapC.userCellInDoc], ['primary', 3]);
  eq('行形状分得开：有名字节点 = full，只剩「关注 @某人」按钮 = side',
    snapC.users.map((u) => [u.handle, u.origin, u.nameHow]),
    [['c_one', 'full', 'User-Name'], ['c_side', 'side', 'anchorText']]);
  const upC = sC.__xprobe.upsertStores(snapC, Date.now());
  ok('side 行不落表，full 行照落', !sC.__xprobe.getUsers()['c_side'] && !!sC.__xprobe.getUsers()['c_one'] && upC.skippedRows === 1,
    { keys: Object.keys(sC.__xprobe.getUsers()), upsert: upC });
  ok('跳过的条数进「已知缺口」', sC.__xprobe.knownGaps(snapC).some((n) => /^users\.side x1/.test(n)), sC.__xprobe.knownGaps(snapC));

  // D 冻结的油猴副本还挂在同一个页面上：浮标必须改名，否则两边 getElementById 拿到的是同一颗按钮
  // （peerNode 必须在 run() 之后再挂：run() 会清空 id 注册表，先造好的节点不会被认出来）
  const sD = run(h('div', {}, []), '/demo_own', 'https://x.com/demo_own');
  const peerNode = h('div', {}, [T('油猴浮标')]);
  peerNode.id = 'ysy-xprobe-fab';
  sD.document.documentElement.appendChild(peerNode);
  eq('认出「本页还有另一个宿主」', sD.__xprobe.peerHost(), 'monkey');
  const fabOwn = sD.document.getElementById('ysy-xprobe-ext-fab');
  ok('扩展自己的浮标是另一个节点（不抢旧 id）', !!fabOwn && fabOwn !== peerNode, { own: !!fabOwn });
  const sD2 = run(profile, '/demo_own', 'https://x.com/demo_own');
  eq('页面只有自己这颗浮标时不虚报', sD2.__xprobe.peerHost(), '');

  // E 两张表内容回传：变了才发、30s 内最多一条（限速的是给我看的日志，不是对 X 的任何请求）
  const sE = run(profile, '/demo_own', 'https://x.com/demo_own');
  const nStore = () => postedRecords(sE).filter((r) => r.kind === 'store').length;
  sE.__xprobe.flush();
  ok('还没落过表就不回传', nStore() === 0, nStore());
  sE.__xprobe.writeStores(); sE.__xprobe.flush();
  eq('落表后回传一条摘要', nStore(), 1);
  sE.__xprobe.writeStores(); sE.__xprobe.flush();
  eq('内容没变不重发', nStore(), 1);
  sE.__xprobe.getUsers()['zzz_speed'] = { handle: 'zzz_speed', name: '限速测试', relation: '', followers: null, following: null, followersExact: null, own: false, seenAs: {}, hist: [], firstSeenAt: Date.now(), updatedAt: Date.now() };
  sE.__xprobe.writeStores(); sE.__xprobe.flush();
  eq('表变了但还在 30s 限速窗口内 ⇒ 先压着', nStore(), 1);
  sE.__xprobe.sendStoreRec(true); sE.__xprobe.flush();
  eq('force（core 命令表里的 store 入口）不受限速', nStore(), 2);
}

console.log('\n[8d2] v0.8.1：头部帖子总数落日点（posts 列）—— 别人的主页也有真总数，广场不再拿「已抓 20 条」冒充两万');
{
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const hp = sb.__xprobe.snapshot().stats.__headerPosts;
  ok('collectStats 交出头部帖子行', !!hp && hp.value === 5021, hp);
  const ret = sb.__xprobe.recordDayRow('zz_hp', null, null, '', hp);
  ok('光有帖子数也能落日点（关注/粉丝都缺时不再整行拒掉）', !!ret && ret.added && ret.posts === 5021, ret);
  const serRaw = store['ysy.xprobe.series'];
  const ser = typeof serRaw === 'string' ? JSON.parse(serRaw || '{}') : (serRaw || {});
  const row = ((ser.zz_hp && ser.zz_hp.imp) || [])[0];
  eq('日点行 posts=5021（与 fow/fans 同列分家，互不抹）', row && row.posts, 5021);
  sb.__xprobe.flush();
  const sent = postedRecords(sb).filter((r) => r.kind === 'dayrow');
  ok('dayrow 记录带 posts=5021 落 sink（库侧 day_rows.posts 才有料，account_latest.posts 直接可查）',
    sent.length >= 1 && sent[0].data.posts === 5021 && sent[0].data.postsExact === 1, sent.length ? sent[0].data : sent);
  // 列级合并老规矩：再来一次只带关注数，posts 不许被整行覆盖抹掉
  sb.__xprobe.recordDayRow('zz_hp', { value: 123, exact: true }, null, '', null);
  const ser2 = store['ysy.xprobe.series'];
  const row2 = ((((typeof ser2 === 'string' ? JSON.parse(ser2) : ser2) || {}).zz_hp || {}).imp || []).filter((p) => p.day === row.day)[0];
  eq('后续只带关注数时 posts 保留、fow 落进同一行', row2 && [row2.posts, row2.fow], [5021, 123]);
  ok('没有帖子行时 recordDayRow 不空转（三个数都缺 = null，跟老口径一致）',
    sb.__xprobe.recordDayRow('zz_empty', null, null, '', null) === null, '');
}

console.log('\n[8d3] v0.8.1-m：真机头部「N 帖子」是数字叶+标签叶分体结构 —— 只认整句叶从上线起就没在真机上中过（2026-10-25 全天 1214 条 profile 记录 __headerPosts 全 null，用户主页截图明明有「5,255 帖子」）');
{
  // 真机结构（2026-10-25 用户主页 + 10-22 dump 里「正在关注」锚点同款）：数字与标签是两个叶 span 挂同一容器，
  // 整句只在容器的 textContent 上。侧栏 8,888 诱饵照排——不排除就会顶掉头部那行。
  const split = h('div', { lang: 'zh' }, [
    h('div', { 'data-testid': 'sidebarColumn' }, [h('span', {}, [T('8,888 帖子')])]),
    h('div', { 'data-testid': 'UserName' }, [T('月川@benben2052243')]),
    h('span', {}, [h('span', {}, [T('5,255')]), T(' '), h('span', {}, [T('帖子')])]),
  ]);
  const sc = run(split, '/benben2052243', 'https://x.com/benben2052243');
  const hp2 = sc.__xprobe.snapshot().stats.__headerPosts;
  ok('分叶结构也认得（容器整句匹配）：5,255 帖子 ⇒ value=5255，侧栏 8,888 不许顶掉',
    !!hp2 && hp2.value === 5255 && hp2.exact === true && hp2.text === '5,255 帖子', hp2);
  ok('正向对照：数字叶不是纯数（5,255x 帖子），同一条判据当场变红',
    (run(h('div', {}, [h('span', {}, [h('span', {}, [T('5,255x')]), T(' '), h('span', {}, [T('帖子')])])]),
      '/x', 'https://x.com/x').__xprobe.snapshot().stats.__headerPosts || null) === null, '');
  // 证据桶：抓不到时把含「帖子/posts」的候选原文留档，下次 X 再改版不用对着 null 猜
  const noLine = run(h('div', { lang: 'zh' }, [
    h('div', { 'data-testid': 'primaryColumn' }, [
      h('span', {}, [T('查看新帖子')]),
      h('span', { role: 'tablist' }, [h('span', {}, [T('帖子')])]),
    ]),
  ]), '/n', 'https://x.com/n');
  const snapN = noLine.__xprobe.snapshot().stats;
  ok('抓不到时留证据桶：__headerPosts = null 且 __headerPostsMiss 把含「帖子」的候选原文留档（tablist 里的不算；v0.8.1-o 起 div 容器也进桶，不然真机那行连桶里都看不见）',
    snapN.__headerPosts === null && Array.isArray(snapN.__headerPostsMiss) &&
    snapN.__headerPostsMiss.length === 2 &&
    snapN.__headerPostsMiss.some((m) => m.text === '查看新帖子') &&
    !snapN.__headerPostsMiss.some((m) => m.text === '帖子'),
    snapN.__headerPostsMiss);
  ok('正向对照：抓到了就没有证据桶（空数组），同一条判据当场变红',
    (run(split, '/benben2052243', 'https://x.com/benben2052243').__xprobe.snapshot().stats.__headerPostsMiss || [1]).length === 0, '');
}

console.log('\n[8d4] v0.8.1-n：帖子总数活在悬停名片（HoverCard）里 —— 头部根本没有那一行（10-25 真机 miss 桶只余「查看新帖子」），名片只在用户自己悬停时进 DOM，观察者只读地接');
{
  // 名片形状照 X 真机：data-testid="HoverCard"，/handle 链接 + 分体叶「5,276」「帖子」（与头部同款结构）
  const card = (hnd, num) => h('div', { 'data-testid': 'HoverCard' }, [
    hnd ? h('a', { href: '/' + hnd }, [T('月川 @' + hnd)]) : h('span', {}, [T('月川')]),
    num ? h('span', {}, [h('span', {}, [T(num)]), T(' '), h('span', {}, [T('帖子')])]) : h('span', {}, [T('互关 · 关注你')]),
  ]);
  const sH = run(h('div', {}, [card('benben2052243', '5,276')]), '/home', 'https://x.com/home');
  const scanH = sH.__xprobe.hoverCardScan();
  eq('名片扫描：handle 与分体叶 5,276 都认出（v0.8.13 起形状多两个键：hf/ho = 名片上那两行数字，没有就 null）', scanH,
    [{ handle: 'benben2052243', hp: { value: 5276, exact: true, token: '5,276', text: '5,276 帖子' }, hf: null, ho: null }]);
  const capH = sH.__xprobe.captureHoverCards(Date.now());
  eq('落日点：光有名片也落（不用等打开主页），posts=5276 进序列；statd=这两个数没读到', capH, { n: 1, added: 1, statd: 0 });
  sH.__xprobe.flush();
  const sentH = postedRecords(sH).filter((r) => r.kind === 'dayrow' && r.data.source === 'hovercard');
  ok('dayrow 记录 source=hovercard、posts=5276、postsExact=1 落 sink',
    sentH.length >= 1 && sentH[sentH.length - 1].data.posts === 5276 && sentH[sentH.length - 1].data.postsExact === 1,
    sentH.length ? sentH[sentH.length - 1].data : sentH);
  eq('同一张名片反复出进 DOM 不重写（hcSeen 按人|帖子数|关注数|粉丝数|天去重）', sH.__xprobe.captureHoverCards(Date.now()), { n: 1, added: 0, statd: 0 });
  ok('正向对照：名片里没有 handle 链接就不收',
    run(h('div', {}, [card('', '1,234')]), '/home', 'https://x.com/home').__xprobe.hoverCardScan().length === 0, '');
  ok('正向对照：名片里没有「N 帖子」就不收',
    run(h('div', {}, [card('zz_hc', '')]), '/home', 'https://x.com/home').__xprobe.hoverCardScan().length === 0, '');
  ok('正向对照：同款内容不在 HoverCard 节点里就不扫（只认名片，别把时间线上的杂散行当名片）',
    run(h('div', {}, [
      h('a', { href: '/zz_hc2' }, [T('月川 @zz_hc2')]),
      h('span', {}, [h('span', {}, [T('9,999')]), T(' '), h('span', {}, [T('帖子')])]),
    ]), '/home', 'https://x.com/home').__xprobe.hoverCardScan().length === 0, '');
  // 观察者入口：recs 里真出现 HoverCard 节点才值得读（省得每一批变更都全页扫）。
  // 名片必须先挂进文档根——真 DOM 里 scan 读的也是 document，游离节点扫不到。
  const cEl = card('zz_hcobs', '7,777');
  const sH2 = run(h('div', {}, [cEl]), '/home', 'https://x.com/home');
  sH2.__xprobe.onHoverCardMutation([{ type: 'childList', addedNodes: [cEl] }]);
  sH2.__xprobe.flush();
  ok('观察者路径：addedNodes 带 HoverCard ⇒ 名片照落（dayrow source=hovercard）',
    postedRecords(sH2).some((r) => r.kind === 'dayrow' && r.data.source === 'hovercard' && r.data.handle === 'zz_hcobs' && r.data.posts === 7777), '');
  const sH3 = run(h('div', {}, []), '/home', 'https://x.com/home');
  sH3.__xprobe.onHoverCardMutation([{ type: 'childList', addedNodes: [h('span', {}, [T('与时间线无关的节点')])] }]);
  sH3.__xprobe.flush();
  ok('正向对照：recs 里没有 HoverCard 节点 ⇒ 一条 dayrow 都不发',
    postedRecords(sH3).filter((r) => r.kind === 'dayrow').length === 0, '');
  // ---- v0.8.13：名片上那两行「N 正在关注 / N 关注者」是比例标签的唯一数据源 ----
  // 逐字照抄真机 dump/2026-10-26_201253-tweet-shmh695775/page.html 里 HoverCard 那一块的形状：
  //   <a href="/shmh695775/following"><span><span>2,857</span></span> <span><span>正在关注</span></span></a>
  //   <a href="/shmh695775/verified_followers">…3,280 关注者</a>
  const cardStat = h('div', { 'data-testid': 'HoverCard' }, [
    h('a', { href: '/ghost_x' }, [T('雪')]),
    h('a', { href: '/ghost_x/following', dir: 'ltr' }, [h('span', {}, [h('span', {}, [T('771')])]), T(' '), h('span', {}, [T('正在关注')])]),
    h('a', { href: '/ghost_x/verified_followers', dir: 'ltr' }, [h('span', {}, [h('span', {}, [T('418')])]), T(' '), h('span', {}, [T('关注者')])]),
    h('a', { href: '/other_guy/followers_you_follow' }, [T('12 你认识的关注者')]),
  ]);
  const sG = run(h('div', {}, [cardStat]), '/home', 'https://x.com/home');
  const scanG = sG.__xprobe.hoverCardScan()[0];
  eq('名片那两个数按 href 认人认档（followers_you_follow 那种「别人」的链接不算他的粉丝数）',
    [scanG.handle, scanG.hp, scanG.hf && scanG.hf.value, scanG.ho && scanG.ho.value], ['ghost_x', null, 771, 418]);
  eq('光有两个数、没有帖子数也照样收（statd=2）；但日点不写（hp 为空 ⇒ 不拿半套数占格子）',
    sG.__xprobe.captureHoverCards(Date.now()), { n: 1, added: 0, statd: 2 });
  const ug = sG.__xprobe.getUsers()['ghost_x'];
  eq('两个数进本机 users 台账（比例标签读的就是这里，精确值标记也一起落）',
    [ug.following, ug.followers, ug.followingExact], [771, 418, true]);
  ok('v0.8.14：名片这一路也留时间线 —— statsAt 盖上读到的时刻、hist 落一个采样点（以前只有进过主页才有点，名单的「按时间看变化」对绝大多数人永远空着）',
    ug.statsAt > 0 && ug.hist.length === 1 && ug.hist[0].following === 771 && ug.hist[0].followers === 418,
    [ug.statsAt, ug.hist]);
  const rG = sG.__xprobe.__ratioInfo('ghost_x');
  eq('标签的数从台账来，且 v0.8.14 换过位置：正在关注 771 ÷ 关注者 418 = 184% 绿档（越高越绿；旧算法 418÷771=54% 红那颗就是用户说「算反了」的产物）',
    [rG.shown, rG.tier, rG.pct], ['184%', 'g', 184.4]);
  eq('正向对照：台账里没这两个数的人 ⇒ ratioInfo 回 null，一颗标签都不出（不编数）',
    sG.__xprobe.__ratioInfo('nobody_here'), null);
}

console.log('\n[8d5] v0.8.1-o：那行根本不是 span 是 div —— 用户贴来真机 HTML：<div dir="ltr" class="css-…">5,287 帖子</div>，querySelectorAll(\'span\') 连 miss 桶都没它的份（两轮修完真机仍 null 的真正原因）');
{
  // 逐字照抄用户贴来的真机节点：div + dir=ltr + r- 类串 + rgb 颜色，文本直挂（无子叶）
  const real = h('div', { lang: 'zh' }, [
    h('div', { 'data-testid': 'UserName' }, [T('月川@benben2052243')]),
    h('div', { dir: 'ltr', class: 'css-146c3p1 r-dnmrzs r-1udh08x r-1udbk01 r-3s2u2q r-bcqeeo r-1ttztb7 r-qvutc0 r-37j5jr r-n6v787 r-1cwl3u0 r-16dba41', style: 'color: rgb(113, 118, 123);' }, [T('5,287 帖子')]),
  ]);
  const sD = run(real, '/benben2052243', 'https://x.com/benben2052243');
  const hpD = sD.__xprobe.snapshot().stats.__headerPosts;
  ok('div 上的「5,287 帖子」照中（判据咬文本锚不咬标签名）', !!hpD && hpD.value === 5287 && hpD.exact === true && hpD.text === '5,287 帖子', hpD);
  ok('正向对照：div 里不是「N 帖子」整句就不中（5,287x 帖子）',
    (run(h('div', {}, [h('div', { dir: 'ltr' }, [T('5,287x 帖子')])]), '/x', 'https://x.com/x').__xprobe.snapshot().stats.__headerPosts || null) === null, '');
  // miss 桶也吃 div：以前 div 候选根本进不了桶，日志里连「页面有这行但形状没认出」都看不见
  const missD = run(h('div', { lang: 'zh' }, [h('div', { dir: 'ltr' }, [T('查看新帖子')])]), '/n', 'https://x.com/n').__xprobe.snapshot().stats;
  ok('miss 桶也收 div 候选（div 的「查看新帖子」留档）',
    missD.__headerPosts === null && missD.__headerPostsMiss.length === 1 && missD.__headerPostsMiss[0].text === '查看新帖子', missD.__headerPostsMiss);
}

console.log('\n[8e] v0.6.1：注入判据按 class token / 剥空必回退 / 名字尾缀 / 空 stat 不发');
{
  // A 判据本体：token 前缀匹配。原来 [class*="extension"] 是整串子串匹配，
  // 真机 miles_mazy / haopei3 的 displayName='' 就是这么来的（整棵名字子树被判成注入，剥光了）
  const sA = run(profile, '/demo_own', 'https://x.com/demo_own');
  const ft = sA.__xprobe.foreignTokenIn;
  eq('真注入的 token 认得出', ['xro-badge', 'bmc-container', 'extension-badge'].map(ft), ['xro-badge', 'bmc-container', 'extension-badge']);
  eq('X 自己的 class 里出现这个词不算命中', ['css-g5y9jx myextension-x', 'r-jqtr6z extension', 'css-1a8x extensionx'].map(ft), ['', '', '']);
  eq('多个 token 时报第一个命中的（报出来的是 token，不是节点第一个 class）', ft('css-1a8 xro-badge bmc-y'), 'xro-badge');

  // A2 深挖统计：同一个节点上「X 的 Emotion class + 注入 class」并存时，记的是注入那个 token
  // （真机那份 foreignClasses 第一名是 css-g5y9jx 86 次，纯粹是统计取了第一个 token 造成的误读）
  const tokBox = h('div', {}, [
    h('span', { class: 'css-g5y9jx xro-badge' }, [T('互关')]),
    h('span', { class: 'css-g5y9jx r-jqtr6z' }, [T('原生文字')]),
    h('span', { class: 'xro-user-card-avatar-stack' }, [T('头像角标')]),
  ]);
  const sA2 = run(tokBox, '/zz_tok', 'https://x.com/zz_tok');
  const dp = sA2.__xprobe.deepProbe(1);
  eq('注入类名清单 = 命中的 token', dp.foreignClasses, { 'xro-badge': 1, 'xro-user-card-avatar-stack': 1 });
  eq('注入节点数按节点算（两个角标）', dp.foreignBadges, 2);
  eq('种类数单列（和节点数分得开）', dp.foreignKinds, 2);

  // B 剥到什么都不剩 ⇒ 回退全文并打上记号：宁可脏，不可空（空是数据直接丢了，脏两行日志一比就看得出来）
  const wrapAll = h('div', {}, [
    h('div', { 'data-testid': 'UserName', class: 'xro-name-wrap' }, [h('span', {}, [T('全剥光了')]), h('span', {}, [T('@zz_all')])]),
  ]);
  const sB = run(wrapAll, '/zz_all', 'https://x.com/zz_all');
  const snapB = sB.__xprobe.snapshot();
  eq('整棵名字子树被判注入时不再交出空名', snapB.identity.displayName, '全剥光了');
  eq('这件事被标出来（nameStripAll）', [snapB.identity.nameStripAll, snapB.nameStripAll], [true, 1]);
  ok('是哪个 token 干的，日志里直接能看到', (snapB.identity.nameTokens['xro-name-wrap'] || 0) >= 1, snapB.identity.nameTokens);
  ok('快照顶层 foreignTokens 汇总（判据误伤还是真注入，下一轮就看这一项）', snapB.foreignTokens['xro-name-wrap'] >= 1, snapB.foreignTokens);
  ok('回退进「已知缺口」并点名去看 foreignTokens', sB.__xprobe.knownGaps(snapB).some((n) => /^nameStripAll x1/.test(n)), sB.__xprobe.knownGaps(snapB));

  // C 名字尾上的注入状态词（真机：'好有钱（互）单向关注@haopei3'、'Miles Ma单向关注@miles_mazy'）
  const nameOf = (raw, path) => {
    const sb = run(h('div', {}, [h('div', { 'data-testid': 'UserName' }, [T(raw)])]), path, 'https://x.com' + path);
    return sb.__xprobe.snapshot().identity.displayName;
  };
  eq('尾缀 单向关注 + （互） 连续剥干净', nameOf('好有钱（互）单向关注@haopei3', '/haopei3'), '好有钱');
  eq('尾缀 单向关注（名字里有空格）', nameOf('Miles Ma单向关注@miles_mazy', '/miles_mazy'), 'Miles Ma');
  eq('正向对照：真名字里的裸「互关」不许剥', nameOf('子想互关@zi_xiang', '/zi_xiang'), '子想互关');
  eq('正向对照：原生关系词照旧剥', nameOf('韩平安关注了你', '/Han83914539'), '韩平安');

  // D 两个数都没读到 ⇒ 不发 stat、不给表建空键（真机 {"following":null,"followers":null,"vals":"-/-"} 那类噪声）
  const sD = run(h('div', {}, [h('div', { 'data-testid': 'UserName' }, [T('空读数@zz_stat1')])]), '/zz_stat1', 'https://x.com/zz_stat1');
  const nStat = () => { sD.__xprobe.flush(); return postedRecords(sD).filter((r) => r.kind === 'stat').length; };
  const r1 = sD.__xprobe.refreshStats('follow');
  eq('第一次只当基线', [r1.vals, r1.changed, nStat()], ['-/-', false, 0]);
  sD.location.pathname = '/zz_none'; sD.location.href = 'https://x.com/zz_none';
  const r2 = sD.__xprobe.refreshStats('follow');
  eq('换到没有锚点的页：值没变 ⇒ 依然不发', [r2.vals, r2.changed, nStat()], ['-/-', false, 0]);
  ok('读不到数就不给表建空键（真机 demo_a / demo_b 那种 name=“” rel=“” pts=0 的行）',
    !sD.__xprobe.getUsers().zz_none && !sD.__xprobe.getUsers().zz_stat1, Object.keys(sD.__xprobe.getUsers()));
  sD.document.documentElement.appendChild(h('div', {}, [statLink('/zz_none/following', '', '610 正在关注')]));
  const r3 = sD.__xprobe.refreshStats('follow');
  eq('正向对照：读到值了才发，而且值落进表', [r3.vals, r3.changed, nStat(), sD.__xprobe.getUsers().zz_none.following], ['610/-', true, 1, 610]);
}

console.log('\n[8f] v0.6.2：列表行「名字长在哪个节点」探针 + 名字回退链');
{
  // 真机 /demo_peer/verified_followers 31 行：handle 31/31、关系 31/31，而 name 0/31、nameHow 全 = anchorText
  // ⇒ 这一类行里「指主页那个锚」只裹着一颗头像，名字在别的节点上。而旧样本截的是整行 outerHTML 开头
  //   900 字（全是头像那段子树），名字区从来没进过日志，只能一轮一轮继续猜。
  // 这一版：① 行里哪些节点带文字，原样报出来（leafShapes）② 名字仍取不到时把候选出处交出（cands）
  //   ③ 按候选顺序回退取一次，取到没有、谁取到的，都由 name / nameHow 说 ④ 样本按名字那串字开窗，不再从头截
  const row = (attrs, kids) => h('div', Object.assign({ 'data-testid': 'UserCell' }, attrs || {}), kids);
  const avatar = (handle, alt) => h('a', { href: '/' + handle }, [h('img', { alt: alt || ('@' + handle + ' 的头像') })]);
  const btn = (handle) => h('button', { 'data-testid': '911-follow', 'aria-label': '关注 @' + handle }, [T('关注')]);
  const LIST = '/aaa/verified_followers';
  const boxOf = (cells) => h('div', { 'data-testid': 'primaryColumn' }, cells);
  const oneRow = (cell) => run(boxOf([cell]), LIST, 'https://x.com' + LIST).__xprobe.snapshot().users[0];

  // A 回退第一级：行本身的 aria-label 点了这个 handle ⇒ 取 @ 之前那段
  const a = oneRow(row({ 'aria-label': '高胜寒 @GaoXiaoxiao2022' }, [avatar('GaoXiaoxiao2022'), btn('GaoXiaoxiao2022')]));
  eq('锚里只有头像时从行 aria-label 取到名字', [a.handle, a.name, a.nameHow], ['GaoXiaoxiao2022', '高胜寒', 'cellAria']);
  eq('取到名字的行不再交候选（cands 只在名字为空时才有）', a.cands, []);

  // B 第二级：X 的 UserNames 容器；回退那一次不许污染 nameForeign（它是「锚点那一次」的读数）
  const b = oneRow(row({}, [
    h('div', { 'data-testid': 'UserNames' }, [h('span', {}, [T('二号')]), h('span', {}, [T('@zz_two')])]),
    avatar('zz_two'), btn('zz_two'),
  ]));
  eq('从 UserNames 取到', [b.name, b.nameHow], ['二号', 'UserNames']);
  eq('回退读的那次不算进 nameForeign（那一列说的是锚点子树剥掉几个注入节点）', b.nameForeign, 0);

  // C 第三级：整行可见文本（真机的行按阅读顺序就是「名字 @handle 关系」）
  const c = oneRow(row({}, [h('span', {}, [T('三号')]), h('span', {}, [T('@zz_three')]), avatar('zz_three'), btn('zz_three')]));
  eq('没有行 aria、没有 UserNames 时退整行可见文本', [c.name, c.nameHow], ['三号', 'cellText']);
  eq('整行可见文本一行看完（名字/handle/按钮一起进日志）', c.cellText, '三号@zz_three关注');
  ok('「文字到底长在哪个节点」原样报出（leafShapes 只收叶子，父节点是把子节点再拼一遍）',
    c.leafShapes.length === 2 && c.leafShapes.every((L) => L[0] === 'span') && c.leafShapes[0][2] === '三号', c.leafShapes);

  // D 判据：前三级都要求文本里点名 @handle；头像 alt 反过来（「@xx 的头像」不是名字）
  const d = oneRow(row({}, [h('span', {}, [T('四号')]), avatar('zz_four')]));
  eq('反向对照：alt 是「@zz_four 的头像」不算名字，而整行文本没点名 handle ⇒ 宁可不取',
    [d.name, d.nameHow, d.cellText], ['', 'anchorText', '四号']);
  eq('取不到就把候选出处原样交出（下一轮照着真机日志改，不靠猜）', d.cands,
    [['imgAlt', '@zz_four 的头像'], ['cellText', '四号'], ['leaf0', 'span=四号']]);
  const d2 = oneRow(row({}, [avatar('zz_five', '五号')]));
  eq('正向对照：alt 里是个像名字的词（不以 @ 开头、不含「头像/avatar」）才敢用', [d2.name, d2.nameHow], ['五号', 'imgAlt']);

  // D2 回退用的整行文本走的是 nativeText：真机这种行里就缝着 xro-user-card-avatar-stack，
  //     整棵被判注入时照「宁可脏不可空」交出全文，但 cellStripAll 必须把这件事喊出来（这种名字别信）
  const injCell = row({}, [
    h('div', { class: 'xro-user-card-avatar-stack' }, [h('span', {}, [T('注入号')]), h('span', {}, [T('@zz_inj')])]),
    avatar('zz_inj'), btn('zz_inj'),
  ]);
  const sD2 = run(boxOf([injCell]), LIST, 'https://x.com' + LIST);
  const d3 = sD2.__xprobe.snapshot().users[0];
  eq('名字只长在注入子树里 ⇒ 回退用剥过的原生文本，取不到就不硬取（注入文字不许当显示名）',
    [d3.name, d3.nameHow, d3.cellForeign, d3.cellText], ['', 'anchorText', 2, '注入号@zz_inj关注']);
  const injAll = row({}, [
    h('div', { class: 'xro-whole-row' }, [h('span', {}, [T('全是注入')]), h('span', {}, [T('@zz_inj2')])]),
    avatar('zz_inj2'),
  ]);
  const sD3 = run(boxOf([injAll]), LIST, 'https://x.com' + LIST);
  const d4 = sD3.__xprobe.snapshot().users[0];
  eq('整行只有注入子树 ⇒ 照「宁可脏不可空」交全文，但 cellStripAll 标出来', [d4.name, d4.cellStripAll], ['全是注入', true]);
  ok('这件事进「已知缺口」并直说「这个名字别信」',
    sD3.__xprobe.knownGaps(sD3.__xprobe.snapshot()).some((n) => /^users\.cellStripAll x1/.test(n)),
    sD3.__xprobe.knownGaps(sD3.__xprobe.snapshot()));

  // E 名字区样本：真机的行「头像在前、名字在后」，从第 0 字截等于没给 ⇒ 窗要开在名字那串字上
  const longName = '名字在很后面的十号';
  const bigCell = row({}, [
    h('a', { href: '/zz_big', class: 'p'.repeat(500) }, [h('img', { alt: '@zz_big 的头像', class: 'q'.repeat(500) })]),
    h('span', {}, [T(longName)]), h('span', {}, [T('@zz_big')]),
  ]);
  const e = oneRow(bigCell);
  eq('这一行靠整行可见文本取到名字（回退链第三级）', [e.name, e.nameHow], [longName, 'cellText']);
  ok('前提：这一行的整段 HTML 远超 700 字（不然下面那条截窗是白测）', bigCell.outerHTML.length > 1000, bigCell.outerHTML.length);
  ok('名字那串字落在截出来的窗里（不是从整行开头截的，开头那 700 字全是头像）',
    e.html.indexOf(longName) >= 0 && e.html.length <= 700 && bigCell.outerHTML.slice(0, 700).indexOf(longName) < 0,
    [e.html.length, e.html.indexOf(longName)]);

  // F 全空时主导形状点名 + 「有 handle 没名字」进已知缺口
  const sF = run(boxOf([
    row({}, [h('span', {}, [T('六号')]), avatar('zz_six')]),
    row({}, [h('span', {}, [T('七号')]), avatar('zz_seven')]),
  ]), LIST, 'https://x.com' + LIST);
  const snapF = sF.__xprobe.snapshot();
  ok('名字全空 ⇒ 点名主导形状，并直接说「那锚里只有头像：看 cands」',
    sF.__xprobe.missingFields(snapF).indexOf('users.name x0(全空,主导形状=anchorText,那锚里只有头像:看 cands)') >= 0,
    sF.__xprobe.missingFields(snapF));
  ok('有 handle 没名字的行数进「已知缺口」（不是漏抓，是这一类形状）',
    snapF.users.length === 2 && sF.__xprobe.knownGaps(snapF).some((n) => /^users\.noName x2/.test(n)),
    sF.__xprobe.knownGaps(snapF));
  const sG = run(boxOf([
    row({ 'aria-label': '有名字 @zz_ok1' }, [avatar('zz_ok1')]),
    row({}, [h('span', {}, [T('八号')]), avatar('zz_ok2')]),
  ]), LIST, 'https://x.com' + LIST);
  ok('名字没全空时不写那句长文，只报条数（别把「一半没水合」说成「整页形状问题」）',
    sG.__xprobe.missingFields(sG.__xprobe.snapshot()).indexOf('users.name x1') >= 0,
    sG.__xprobe.missingFields(sG.__xprobe.snapshot()));

  // G 裸「互关」尾缀：只报不剥（真号就叫「子想互关」，出处又不是注入子树时剥它是把数据改坏）
  const sT = run(boxOf([row({ 'aria-label': '某某互关 @zz_tail1' }, [avatar('zz_tail1')])]), LIST, 'https://x.com' + LIST);
  const snapT = sT.__xprobe.snapshot();
  eq('名字尾裸「互关」照原样留着', snapT.users[0].name, '某某互关');
  ok('但被记成观察项，攒样本再裁定', sT.__xprobe.knownGaps(snapT).some((n) => /^users\.nameTail x1/.test(n)),
    sT.__xprobe.knownGaps(snapT));

  // H 深挖回传：整行拆成 TEXT / LEAF / HTML 三段（面板与日志里一眼看到形状）
  const dpH = run(boxOf([row({ 'aria-label': '高胜寒 @GaoXiaoxiao2022' }, [
    h('span', {}, [T('高胜寒')]), h('span', {}, [T('@GaoXiaoxiao2022')]), avatar('GaoXiaoxiao2022'),
  ])]), LIST, 'https://x.com' + LIST).__xprobe.deepProbe(1);
  ok('userCellDumps 一行看完形状', /^TEXT\[.*\] LEAF\[\["span"/.test(dpH.userCellDumps[0]),
    dpH.userCellDumps[0].slice(0, 70));
}

console.log('\n[8g] v0.6.3：奖励页曝光数 + 分钟/日时间序列（趋势页的数据腿）');
{
  delete store['ysy.xprobe.series'];
  delete store['ysy.xprobe.own'];

  const sR = run(rewardsRoot(), RW_PATH, 'https://x.com' + RW_PATH);
  const xp = sR.__xprobe;
  eq('这一页是独立页型（不并进 profile，也不当 home）', xp.tabName(), 'rewards');
  const snap = xp.snapshot();
  eq('页型进了快照', snap.tab, 'rewards');
  ok('奖励页的「水合」看关键词出没出来（不看 article）', snap.hydrated === true, snap.hydrated);
  ok('宽松取数拿到 10.1K ⇒ 10100（缩写，非精确）',
    snap.rewards.hit === true && snap.rewards.value === 10100 && snap.rewards.token === '10.1k' && snap.rewards.exact === false,
    snap.rewards && [snap.rewards.value, snap.rewards.token, snap.rewards.exact]);
  eq('门槛那句里的数字全列进证据（90 和 50 万都不许当值）', snap.rewards.cands[0].threshold, ['90', '50 万']);
  eq('同区域还有第二个数字（2%）：取了第一个，剩下的计数报出来', snap.rewards.others, 1);
  ok('漏抓清单点名「多个数字」', xp.missingFields(snap).some((m) => /^rewards\.nums x2/.test(m)), xp.missingFields(snap));
  ok('奖励页不许掉进「empty(本页没采到任何行)」那条兜底',
    !xp.missingFields(snap).some((m) => /^empty/.test(m)), xp.missingFields(snap));
  ok('候选把那段 HTML 带回来了（判据下一轮就照着它收窄）',
    typeof snap.rewards.cands[0].html === 'string' && snap.rewards.cands[0].html.indexOf(RW_TEXT.slice(0, 8)) >= 0,
    snap.rewards.cands[0].html.slice(0, 60));

  // 正向对照：区域里只有门槛那一串数字 ⇒ 必须判否，绝不能把 50 万写成我的曝光数
  const sR2 = run(h('div', {}, [h('div', { 'data-testid': 'primaryColumn' }, [h('div', {}, [T(RW_TEXT)])])]), RW_PATH, 'https://x.com' + RW_PATH);
  const snap2 = sR2.__xprobe.snapshot();
  ok('正向对照：只有门槛数字时判否（50 万没被当成曝光数落库）',
    snap2.rewards.hit === false && snap2.rewards.value === null, snap2.rewards && [snap2.rewards.hit, snap2.rewards.value]);
  ok('判否时清单直说「看 cands」，且带关键词节点数',
    sR2.__xprobe.missingFields(snap2).some((m) => /^rewards\.value x0\(关键词节点 1/.test(m)), sR2.__xprobe.missingFields(snap2));

  xp.doCollect({ force: true });
  xp.flush();
  eq('own 从侧栏导航认出来了', xp.stateForPanel().own, 'demo_own');
  const ser = store['ysy.xprobe.series'] || {};
  const mine = ser.demo_own || {};
  eq('奖励页的数按 T-1 落进自己的日点表（今天开页 = 昨天的账），记在 eff 列、实时曝光列留空',
    [mine.imp.length, mine.imp[0].day, mine.imp[0].eff, mine.imp[0].effExact, mine.imp[0].value],
    [1, xp.dayKey(Date.now() - 86400000), 10100, false, null]);
  xp.sampleTick(true);
  xp.sampleTick(true);
  eq('同一天再采只覆盖，不铺两个日点', (store['ysy.xprobe.series'].demo_own.imp || []).length, 1);
  const rds = postedRecords(sR).filter((r) => r.kind === 'reward');
  ok('每次读数回传一条 reward，带候选与出处（t=1 分流），day 也是 T-1 那天',
    rds.length >= 1 && rds[0].data.value === 10100 && rds[0].t === 1 && rds[0].data.cands.length >= 1 &&
      rds[0].data.day === xp.dayKey(Date.now() - 86400000),
    rds.length && [rds[0].data.value, rds[0].t, rds[0].data.cands.length, rds[0].data.day]);
  eq('面板拿得到本页读数（趋势页的证据块就吃这个）', xp.stateForPanel().series.lastRewards.value, 10100);

  // ---------- v0.7.2 账号分析页：实时曝光增量（同值跳过，变了/空了才写） ----------
  // 日期全用「相对今天」的偏移：写死日历日的话，跑在某一天就会撞上「今天」那行，把后面的回填断言污染掉
  const aDay = (off) => xp.dayKey(Date.now() - off * 864e5);
  const anaBody = h('div', {}, [
    h('div', { 'aria-label': aDay(3) + ' 4,320 次曝光' }, [T('d3')]),
    h('div', { 'aria-label': aDay(2) + ' 5,010 次曝光' }, [T('d2')]),
    h('div', { 'aria-label': aDay(1) + ' 1,234 次曝光' }, [T('d1')]),
  ]);
  const sA = run(anaBody, '/i/account_analytics', 'https://x.com/i/account_analytics');
  const xpA = sA.__xprobe;
  eq('页型认得出分析页（保留段 i 下再挂一条规则）', xpA.tabName(), 'analytics');
  eq('日期标签四种写法都认（年取当年）',
    [xpA.dayFromLabel('2026-10-24'), xpA.dayFromLabel('10月24日'), xpA.dayFromLabel('Oct 24'), xpA.dayFromLabel('24 Oct'), xpA.dayFromLabel('没有日期')],
    ['2026-10-24', new Date().getFullYear() + '-10-24', new Date().getFullYear() + '-10-24', new Date().getFullYear() + '-10-24', '']);
  const cA = xpA.sampleTick(true);
  ok('分析页抓到三天的实时曝光，落在 value 列、token=analytics（第一遍增量：全写）',
    cA.n === 3 && cA.wrote === 3 && cA.same === 0 &&
    store['ysy.xprobe.series'].demo_own.imp.filter((r) => r.token === 'analytics')
      .map((r) => r.day + '=' + r.value).join(',') === aDay(3) + '=4320,' + aDay(2) + '=5010,' + aDay(1) + '=1234',
    [cA, store['ysy.xprobe.series'].demo_own.imp]);
  const cA2 = xpA.sampleTick(true);
  eq('增量口径：同值再采 ⇒ 全跳过（不写行、不重发 dayrow）', [cA2.wrote, cA2.same], [0, 3]);
  xpA.flush();
  ok('采过一轮落一条 animp 诊断记录（带 days，抓不到的那天结构线索靠它迭代）',
    postedRecords(sA).some((r) => r.kind === 'animp' && r.data.n === 3 && Array.isArray(r.data.days)),
    postedRecords(sA).filter((r) => r.kind === 'animp').map((r) => r.data && [r.data.n, r.data.wrote]));
  const anaBody2 = h('div', {}, [
    h('div', { 'aria-label': aDay(2) + ' 5,010 次曝光' }, [T('d2')]),
    h('div', { 'aria-label': aDay(1) + ' 2,000 次曝光' }, [T('d1')]),
    h('div', { 'aria-label': aDay(4) + ' 300 次曝光' }, [T('d4')]),
  ]);
  const sA2 = run(anaBody2, '/i/account_analytics', 'https://x.com/i/account_analytics');
  const cA3 = sA2.__xprobe.sampleTick(true);
  eq('增量口径：只有变了的与新增的才写（前天同值跳过；昨天改数重写；大前天补空）', [cA3.wrote, cA3.same],
    [2, 1]);
  sA2.__xprobe.flush();
  eq('变了的天落一条 source=analytics 的 dayrow（「记录下时间」= 行上 at + 记录的 receivedAt）',
    postedRecords(sA2).filter((r) => r.kind === 'dayrow' && r.data.source === 'analytics')
      .map((r) => r.data.day).sort().join(','), [aDay(4), aDay(1)].sort().join(','));

  // ---------- v0.8.1 真机判据（英文 UI）：逐日数值只在悬停 tooltip 里 ----------
  // 真机 2026-10-25：轴刻度是纯日期、y 轴是纯数字，「日期+数」只出现在悬停 tooltip 的一个 text 里
  const yNow = new Date().getFullYear();
  const tipBody = h('div', {}, [h('div', {}, [T('Tue, Oct 20Impressions19,771')])]);
  const sTip = run(tipBody, '/i/account_analytics', 'https://x.com/i/account_analytics');
  const cTip = sTip.__xprobe.sampleTick(true);
  eq('tooltip 整句粘在同一个 text 里也拆得开（星期几是前缀噪音，不挡解析）', [cTip.n, cTip.wrote], [1, 1]);
  ok('tooltip 拆出的那行：当年 10-20、精确 19,771、token=analytics 落进 value 列',
    (store['ysy.xprobe.series'].demo_own.imp || []).some((r) =>
      r.token === 'analytics' && r.day === yNow + '-10-20' && r.value === 19771 && r.exact === true),
    (store['ysy.xprobe.series'].demo_own.imp || []).filter((r) => r.token === 'analytics'));

  const sAx = run(h('div', {}, [h('div', {}, [T('Oct 19')]), h('div', {}, [T('Oct 20')])]),
    '/i/account_analytics', 'https://x.com/i/account_analytics');
  const aAx = sAx.__xprobe.collectAnalytics();
  ok('正向对照：只有轴刻度（纯日期）时 days 为空、axis 留证据——animp 里 axis 有货而 days 空 = 判据没病，是没悬停',
    aAx.days.length === 0 && aAx.axis.length === 2 && /Oct 19/.test(aAx.axis.join('|')),
    [aAx.days.length, aAx.axis]);
  const cAx = sAx.__xprobe.captureAnalytics('demo_own', Date.now(), true);
  eq('没悬停就什么都不写（同值跳过口径不允许把空写进去）', [cAx.n, cAx.wrote, cAx.same], [0, 0, 0]);

  // ---------- v0.8.1-g 真机事故对表（animp 诊断 2026-10-25 三条错行） ----------
  // 事故一：容器 textContent 把 tooltip 与轴刻度无空格粘连，firstNumber 把 19,771+030K 粘成 19,771,030,000 落库；
  // 且父节点总在子节点先进列表，先到的容器占位后正确叶子被 days[day] 挡掉 ⇒ 同天必须比短。
  const bigBody = h('div', {}, [
    h('div', {}, [T('Tue, Oct 20Impressions19,771030K60K90K120KOct 25Oct 24Oct 23Oct 22Oct 21Oct 20Oct 19')]),
    h('div', {}, [T('Tue, Oct 20Impressions19,771')]),
  ]);
  const aBig = run(bigBody, '/i/account_analytics', 'https://x.com/i/account_analytics').__xprobe.collectAnalytics();
  ok('容器粘连不再粘出天文数字：同天比短，tooltip 叶子（19,771）赢过容器（…030K60K…）',
    aBig.days.length === 1 && aBig.days[0].day === yNow + '-10-20' && aBig.days[0].value === 19771 && aBig.days[0].exact === true,
    aBig.days);
  // 事故二：这页堆着 Posts/Replies/Impressions 多张图，每张的 tooltip 都是「日期+数」同句，
  // 不认关键词 Posts 30/18 会被当曝光写进库（真机三条错行里两条是它）
  const postsBody = h('div', {}, [h('div', {}, [T('Wed, Oct 21Posts30Replies90103507001.1KOct 25Oct 23Oct 21Oct 19')])]);
  const aPosts = run(postsBody, '/i/account_analytics', 'https://x.com/i/account_analytics').__xprobe.collectAnalytics();
  ok('Posts/Replies 图的 tooltip 不当曝光收（kwFilter 拒收，cands 里留原文证据）',
    aPosts.days.length === 0 && aPosts.cands.some((c) => c.how === 'kwFilter' && c.value === 30) &&
    /Posts30Replies/.test(aPosts.cands[0].text),
    aPosts);
  ok('正向对照：同一句加上 Impressions 关键词，同一天当场被抓（判据是真的在拦）',
    (() => {
      const impBody = h('div', {}, [h('div', {}, [T('Wed, Oct 21Impressions30')])]);
      const aImp = run(impBody, '/i/account_analytics', 'https://x.com/i/account_analytics').__xprobe.collectAnalytics();
      return aImp.days.length === 1 && aImp.days[0].day === yNow + '-10-21' && aImp.days[0].value === 30;
    })(),
    'kwFilter 只该拦没关键词的');
  // numOnly 诊断通道：数值叶与日期叶万一分家（无中间小节点），animp 里能看到它们的原文
  const aNum = run(h('div', {}, [h('span', {}, [T('30K')]), h('span', {}, [T('19,771')])]), '/i/account_analytics', 'https://x.com/i/account_analytics').__xprobe.collectAnalytics();
  ok('纯数字短句进 numOnly 诊断桶（轴刻度与孤儿数值都在，结构分家时下一轮有据可对）',
    aNum.days.length === 0 && aNum.numOnly.join('|').indexOf('30K') >= 0 && aNum.numOnly.join('|').indexOf('19,771') >= 0,
    aNum.numOnly);

  // 分钟线：主页上按整分钟对齐打点，own 从存储里吃老本（这一页有 handle，靠不着导航）
  const sP = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xpP = sP.__xprobe;
  eq('跨页面还认得到自己（URL 里没有 handle 的那类页靠的就是存过的那份）', xpP.stateForPanel().own, 'demo_own');
  const t1 = xpP.sampleTick(true);
  eq('在主页读关注/粉丝打一个分钟点', [t1.own, t1.following, t1.followers, t1.added], ['demo_own', 2578, 2978, true]);
  const mn = store['ysy.xprobe.series'].demo_own.min;
  eq('分钟点按整分钟对齐（曲线不会被 3s 抖动拉花）', [mn.length, mn[0].following, mn[0].ts % 60000], [1, 2578, 0]);
  xpP.sampleTick(true);
  eq('同一分钟再采只覆盖不铺两点', store['ysy.xprobe.series'].demo_own.min.length, 1);
  const T0 = Math.floor(Date.now() / 60000) * 60000;
  eq('下一分钟才新增点', [xpP.addMinPoint('demo_own', 2579, 2978, T0 + 60000), store['ysy.xprobe.series'].demo_own.min.length], [1, 2]);
  const sH = run(homeFixture, '/home', 'https://x.com/home');
  eq('home 这类页不打分钟点（那儿没有「我的」这两个数）', sH.__xprobe.sampleTick(true), null);

  // ---------- v0.6.11「每人每天一行」：打开别人的主页就在别人名下落日点 ----------
  // 用另一个 handle 的 statLink 建一张「别人的主页」：collectStats 按页主收窄，
  // 拿 demo_own 那张 fixture 走在 /demo_a 上只会读到空 ⇒ 测不到这条新路
  const otherProf = h('div', { lang: 'zh' }, [
    statLink('/demo_a/following', '', '1,234 正在关注'),
    statLink('/demo_a/verified_followers', '', '5,678 关注者'),
  ]);
  const sO = run(otherProf, '/demo_a', 'https://x.com/demo_a');
  const xpO = sO.__xprobe;
  const minOwnBefore = xpO.getSeries().demo_own.min.length;
  const tOther = xpO.sampleTick(true);
  ok('打开别人的主页：日点落在页主名下（不是 own），曝光列留空（别人的号读不到曝光）',
    tOther.who === 'demo_a' && tOther.day === xpO.dayKey(Date.now()) && tOther.dayAdded === true &&
    xpO.getSeries().demo_a.imp.length === 1 && xpO.getSeries().demo_a.imp[0].fow === 1234 &&
    xpO.getSeries().demo_a.imp[0].fans === 5678 && xpO.getSeries().demo_a.imp[0].value === null, tOther);
  ok('正向对照：陌生人的两个数没混进 own 的分钟线（谁在屏上就记在谁名下，混了就等于把曲线画歪）',
    tOther.added === false && xpO.getSeries().demo_own.min.length === minOwnBefore &&
    xpO.getSeries().demo_own.imp[0].fow !== 1234,
    [tOther.added, xpO.getSeries().demo_own.min.length, minOwnBefore, xpO.getSeries().demo_own.imp[0].fow]);
  const tAgain = xpO.sampleTick(true);
  const drCount = xpO.queue.filter((r) => r.kind === 'dayrow').length;
  ok('同一天同一组数字再采：日点不重写、不再发记录（一天一行，不是每分钟一行刷盘）',
    tAgain.dayAdded === false && drCount === 1, [tAgain, drCount]);
  const rsO = xpO.refreshStats('test');
  ok('「关注动作后重读」那条路也认页主（refreshStats 的 idt 是 handleFromPath，不是 own）',
    rsO.day === xpO.dayKey(Date.now()) && rsO.dayAdded === false && xpO.getSeries().demo_a.imp.length === 1, rsO);
  const chO = xpO.recordDayRow('demo_a', { value: 1300 }, null);
  ok('只给一列变了 ⇒ 另一列照旧（按列合，recordDayRow 与补录走的是同一套合并）',
    chO.added === true && xpO.getSeries().demo_a.imp[0].fow === 1300 &&
    xpO.getSeries().demo_a.imp[0].fans === 5678, chO);
  const addO = sO.__toCore({ t: 'impAdd', v: { day: '2026-10-15', handle: 'demo_a', posts: '99' } });
  ok('补录能给别人的号（handle 透传；缺省才回到 own），发的是 dayrow 不是 reward',
    addO.result.ok === true && addO.result.handle === 'demo_a' &&
    xpO.getSeries().demo_a.imp.filter((r) => r.day === '2026-10-15')[0].posts === 99 &&
    xpO.queue.filter((r) => r.kind === 'dayrow' && r.data.handle === 'demo_a' && r.data.manual === 1).length === 1,
    [addO.result, xpO.queue.filter((r) => r.kind === 'dayrow').length]);
  const addOwn = sO.__toCore({ t: 'impAdd', v: { day: '2026-10-16', value: '9.9k' } });
  ok('正向对照：不带 handle 的补录仍记在 own 名下、仍发 reward（这条老路没被新分支抢走）',
    addOwn.result.ok === true && addOwn.result.own === 'demo_own' &&
    xpO.queue.filter((r) => r.kind === 'reward' && r.data.day === '2026-10-16').length === 1, addOwn.result);
  // 收干净：这条 fixture 给 own 多塞了一天，而 series 在各沙箱间是同一个对象（loadSeries 直接把存储里那份引用接过来），
  // 后面「删点」那条判据是按 own 的行数钉的 ⇒ 不清掉就是我这一步给别人造的假红
  xpO.delImpPoint('demo_own', '2026-10-16');
  const sv = sO.__toCore({ t: 'seriesView', v: { handle: 'demo_a' } });
  ok('seriesView 能把面板的视线切到别人的号（key 换了、imp 是那个人的、min 不该有陌生人的点）',
    sv.result.key === 'demo_a' && sv.result.imp.length === 2 && sv.result.min.length === 0 &&
    sv.result.handles.some((x) => x.h === 'demo_a' && x.own === 0) && sv.result.rank.length === sv.result.handles.length,
    [sv.result.key, sv.result.imp.length, sv.result.min.length]);
  const stO = sO.__toCore({ t: 'state' });
  ok('state 默认还是看自己（不带 handle 的取数不许被上一步的 seriesView 粘住）',
    stO.state.series.key === 'demo_own', stO.state.series.key);
  // 真 core 的 state 直接喂格式化层：排名表不许只在我手写的那份 fixture 里成立
  {
    const realRank = V.rankRows({ series: stO.state.series }, 'fans', false, Date.now());
    const hs = stO.state.series.handles;
    ok('排名与 core 的 handles 一一对应（少一人就是排名漏人，多一人就是幻影数据）',
      realRank.length === hs.length && hs.every((h) => realRank.some((r) => r.h === h.h)),
      [realRank.map((r) => r.h), hs.map((h) => h.h)]);
    ok('名次是 1..n 连续号（列头换排序后也要连续，断号=面板上看着像漏了人）',
      realRank.map((r) => r.rank).join(',') === hs.map((x, i) => i + 1).join(','), realRank.map((r) => r.rank));
    ok('own 那行带星给面板高亮，别人的行不冒充 own',
      realRank.filter((r) => r.own).length === 1 && realRank.find((r) => r.own).h === 'demo_own',
      realRank.map((r) => [r.h, r.own]));
    ok('正向对照：从 handles 里抽掉一个人，上面那条「一一对应」当场变红（证明它真在比两份名单）',
      hs.length > 1 && realRank.length !== hs.slice(0, hs.length - 1).length, [realRank.length, hs.length]);
  }

  // ---------- v0.6.12：「我的账号」可以在设置里钉死（猜的不许覆盖说的） ----------
  eq('归一口径：剥 @、去空白、转小写', [xpP.normHandle('@Demo_Own'), xpP.normHandle(' king '), xpP.normHandle('有中文')],
    ['demo_own', 'king', '']);
  const pin1 = xpP.setOwnHandle('@Demo_Own');
  ok('钉自己：认得下来，manual 标真（面板据此把来源说清）',
    pin1.ok === true && pin1.manual === true && pin1.own === 'demo_own' && xpP.ownHandle() === 'demo_own', pin1);
  const pinBad = xpP.setOwnHandle('demo own');
  ok('不合法就拒并说清规则（把带空格的原样存下去 = 库里多一个永远匹配不上的假人）',
    pinBad.ok === false && /1~15/.test(pinBad.err), pinBad);
  const pinOther = xpP.setOwnHandle('pinned_one');
  const addPinned = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-03', value: '100' } });
  ok('钉住以后新数据写进钉的那个名下（曝光记错人就是整段历史挂到陌生人身上，这正是这一格要解决的问题）',
    pinOther.ok === true && addPinned.result.ok === true && addPinned.result.own === 'pinned_one' &&
    (xpP.getSeries().pinned_one.imp || []).length === 1 &&
    (xpP.getSeries().demo_own.imp || []).every((r) => r.day !== '2026-10-03'),
    [pinOther, addPinned.result, (xpP.getSeries().demo_own.imp || []).map((r) => r.day)]);
  ok('封顶也按钉住的这个人走：认「谁的号能留一年」用的是同一个 own 判定（isOwn），不是另一套猜测',
    xpP.isOwn('pinned_one') === true && xpP.isOwn('demo_own') === false, '');
  const pinClear = xpP.setOwnHandle('');
  ok('留空应用 = 回到自动识别（这一格不许变成一个再也退不出来的开关）',
    pinClear.ok === true && pinClear.manual === false && xpP.ownHandle() === 'demo_own' &&
    xpP.isOwn('pinned_one') === false, pinClear);
  const svPin = sP.__toCore({ t: 'ownSet', v: { handle: '@Pinned_Two' } });
  ok('ownSet 命令通道通（面板按「应用」走的就是这条路），回包含 own 与来源',
    svPin.ok === true && svPin.result.ok === true && svPin.result.own === 'pinned_two' && svPin.result.manual === true, svPin.result);
  xpP.setOwnHandle('');
  const svGhost = xpP.seriesForPanel('nobody_here');
  ok('点名要谁就给谁，哪怕他一行都没有（旧写法查不到就回落到 own/最新那个人 ⇒「我的」页会拿陌生人的曲线冒充我的历史）',
    svGhost.key === 'nobody_here' && svGhost.imp.length === 0 && svGhost.min.length === 0,
    [svGhost.key, svGhost.imp.length, svGhost.min.length]);
  ok('正向对照：不点名时仍按 own 给（回落那一步没被改坏，两页默认都吃这条）',
    xpP.seriesForPanel('').key === 'demo_own' && xpP.seriesForPanel(null).key === 'demo_own', '');

  // ---------- 「从本机库回填」：/db?q=day_rows 回来的行灌回 series（面板只读存储、不读库） ----------
  const recBefore = xpO.queue.filter((r) => r.kind === 'dayrow' || r.kind === 'reward').length;
  const ownToday = xpO.dayKey(Date.now());
  const back = xpO.mergeDayRows([
    { handle: 'demo_a', day: '2026-10-20', exposure: 7400, exact: 0, token: '7.4k', following: 2350, followers: 2312, posts: 2870, at: '2026-10-20T23:59:00.000Z' },
    { handle: 'demo_own', day: ownToday, exposure: null, exact: 0, token: '', following: null, followers: 4321, posts: null, at: new Date().toISOString() },
    { handle: '', day: '2026-10-21', exposure: 1, at: '' },
    { handle: 'x', day: '2026-10-1', exposure: 1, at: 'not-a-time' },
  ]);
  ok('回填按 db 的 day_latest 形状吃：4 行里 2 行有效、2 行缺 handle/日期算坏行，写回 2 天',
    [back.rows, back.wrote, back.bad, back.handles, back.same], [4, 2, 2, 2, 0], back);
  const bt = xpO.getSeries().demo_a.imp.filter((r) => r.day === '2026-10-20')[0] || {};
  ok('别人的号也能被回填（曝光带着缩写原文与「非精确」标记，不是 7400 冒充精确值）',
    bt.value === 7400 && bt.exact === false && bt.token === '7.4k' && bt.fow === 2350 && bt.posts === 2870, bt);
  const owToday = xpO.getSeries().demo_own.imp.filter((r) => r.day === ownToday)[0] || {};
  ok('库里空着的列不抹掉面板已有的数（只给粉丝 4321，关注原样留着 —— 同日按列合，同一条道理；实时曝光列还没人写）',
    owToday.value == null && owToday.fow === 2578 && owToday.fans === 4321, owToday);
  ok('回填不发 dayrow/reward 记录（那些行本来就是从库里的记录长出来的，再发一次等于 sink 把同一天的账写两遍）',
    xpO.queue.filter((r) => r.kind === 'dayrow' || r.kind === 'reward').length === recBefore,
    [recBefore, xpO.queue.filter((r) => r.kind === 'dayrow' || r.kind === 'reward').length]);
  const back2 = xpO.mergeDayRows([
    { handle: 'demo_a', day: '2026-10-20', exposure: 7400, exact: 0, token: '7.4k', following: 2350, followers: 2312, posts: 2870, at: '2026-10-20T23:59:00.000Z' },
    { handle: 'demo_own', day: ownToday, exposure: null, exact: 0, token: '', following: null, followers: 4321, posts: null, at: new Date().toISOString() },
  ]);
  eq('正向对照：同一批行再灌一次 ⇒ wrote 归 0、same 变 2（幂等；不是「每次都算写回一行」的假账）',
    [back2.wrote, back2.same, back2.bad], [0, 2, 0]);
  for (let i = 0; i < 366; i++) xpP.addImpPoint('cap_test', 'D' + String(i).padStart(3, '0'), i, true, 'x', Date.now());
  eq('日点封顶（别人的号）：120 天，丢的是最老那天', [xpP.getSeries().cap_test.imp.length, xpP.getSeries().cap_test.imp[0].value], [120, 246]);
  // 同一条写入打在 own 名下必须留 365 —— 两个数不一样才证明封顶是**按 handle 选的**，不是把常量改了个数值糊过去
  xpP.rememberOwn('own_cap');
  for (let i = 0; i < 366; i++) xpP.addImpPoint('own_cap', 'E' + String(i).padStart(3, '0'), i, true, 'x', Date.now());
  eq('日点封顶（自己的号）：照旧 365 天（同一段 366 次写入，两个 handle 留下不同数 ⇒ 封顶按人走）',
    [xpP.getSeries().own_cap.imp.length, xpP.getSeries().own_cap.imp[0].value], [365, 1]);
  xpP.rememberOwn('demo_own');

  // 面板补录 / 删点走命令通道（真面板就是发这两个命令）
  const addR = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-01', value: '12,345' } });
  ok('补录：日期 + 带逗号的串也收（归一化成整数）', addR.ok === true && addR.result.ok === true && addR.result.value === 12345, addR.result);
  const imp = store['ysy.xprobe.series'].demo_own.imp;
  eq('手工补的旧数据排在今天之前（按 day 排序，不按写入顺序；行数不卡死——上面几段已经往 king 名下落了 T-1/分析页/今天好几行）',
    [imp[0].day, imp[0].value, imp[0].token], ['2026-10-01', 12345, 'manual']);
  const bad1 = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-1', value: '5' } });
  ok('日期不合规：拒，并说清要什么格式', bad1.result.ok === false && /YYYY-MM-DD/.test(bad1.result.err), bad1.result);
  const garb = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-05', value: '1O.1k' } });
  ok('非数串照拒并点名哪列不对（字母 O 冒充 0 这种；「缩写是采集器的活」那条口径 v0.6.9 起放宽成收缩写标 ~）',
    garb.result.ok === false && /曝光不是个数/.test(garb.result.err), garb.result);
  const delR = sP.__toCore({ t: 'impDel', v: '2026-10-01' });
  eq('删点：打错的那个删得掉（10-01 那行没了，别的行原样）',
    [delR.result.removed, delR.result.imp >= 3,
      store['ysy.xprobe.series'].demo_own.imp.some((r) => r.day === '2026-10-01')], [1, true, false]);
  // v0.6.9 收尾：四列补录 —— 装插件之前的日子（20/21/22 那种）就靠这口把历史填进来
  const addC = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-02', fow: '2,754' } });
  ok('只补关注一列也收（曝光可以空着）',
    addC.ok === true && addC.result.ok === true && addC.result.value === null && addC.result.fow === 2754, addC.result);
  const rowC = store['ysy.xprobe.series'].demo_own.imp.find((p) => p.day === '2026-10-02');
  ok('列行入表：曝光空、关注 2754、帖子空，token 不必 manual（那是曝光补录的老标记）',
    rowC && rowC.value == null && rowC.fow === 2754 && rowC.posts == null && rowC.token === '', rowC);
  const addM = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-02', value: '8500' } });
  const rowM = store['ysy.xprobe.series'].demo_own.imp.find((p) => p.day === '2026-10-02');
  ok('同一天再补曝光：同一行 value 8500，fow 2754 没被抹（按列合并，不是整行替换）',
    rowM && rowM.value === 8500 && rowM.fow === 2754 && rowM.token === 'manual', rowM);
  sP.__xprobe.flush();
  ok('补录落一条 kind=reward 手动行：manual=1，只带「这回给过的列」（v0.7.2 起 reward 的 value=有效曝光；这回只填了实时曝光 ⇒ value 空、value2 带数）',
    (() => {
      const mr = postedRecords(sP).filter((r) => r.kind === 'reward' && r.data.manual === 1).pop() || null;
      return !!mr && mr.data.value === null && mr.data.value2 === 8500 && mr.data.fow === null && mr.data.fans === null &&
        mr.data.posts === null && mr.data.added === true;
    })(), postedRecords(sP).filter((r) => r.kind === 'reward').map((r) => r.data && [r.data.manual, r.data.value, r.data.value2, r.data.fow]));
  const emptyC = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-03' } });
  ok('四列一列数都没给 ⇒ 拒并说清', emptyC.result.ok === false && /至少填一列/.test(emptyC.result.err), emptyC.result);
  // 缩写补录（趋势表这轮放宽）：历史数据手里就是「10.1k / 13.2K」这种缩写——收，换算成整数落库，exact=false（行上带 ~）
  const ab1 = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-05', value: '10.1K' } });
  ok('缩写补录：10.1K → 10100，不拒', ab1.result.ok === true && ab1.result.value === 10100, ab1.result);
  const rowAb = store['ysy.xprobe.series'].demo_own.imp.find((p) => p.day === '2026-10-05');
  ok('缩写行的口径：value 10100 / exact=false（行上带 ~）/ token=manual',
    rowAb && rowAb.value === 10100 && rowAb.exact === false && rowAb.token === 'manual', rowAb);
  const ab2 = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-06', value: '13.2K', fow: '3,360' } });
  const rowAb2 = store['ysy.xprobe.series'].demo_own.imp.find((p) => p.day === '2026-10-06');
  ok('四列混填：曝光 13.2K → 13200（exact=false），关注「3,360」归一成 3360',
    ab2.result.ok === true && ab2.result.value === 13200 && ab2.result.fow === 3360 && rowAb2 && rowAb2.exact === false, ab2.result);
  const ab3 = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-07', value: '50万' } });
  ok('中文缩写同样收：50万 → 500000（w/m 一个待遇）', ab3.result.ok === true && ab3.result.value === 500000, ab3.result);
  const addE = sP.__toCore({ t: 'impAdd', v: { day: '2026-10-08', eff: '9,876', value: '15.2K' } });
  ok('补录两列曝光各进各的账：有效曝光 9,876 → eff 9876（token=manual），实时曝光 15.2K → value 15200',
    addE.result.ok === true && addE.result.eff === 9876 && addE.result.value === 15200, addE.result);
  const rowE = store['ysy.xprobe.series'].demo_own.imp.find((p) => p.day === '2026-10-08');
  ok('同一行两列曝光分账：eff/effToken 与 value/token 互不串行',
    rowE && rowE.eff === 9876 && rowE.effToken === 'manual' && rowE.effExact === true &&
      rowE.value === 15200 && rowE.token === 'manual' && rowE.exact === false, rowE);
  // v0.7.2 一次性迁移（用干净的 handle，别搅动上面正测着的 king 那几行）：
  // 旧行的 value 是奖励页那个数 ⇒ 搬进 eff，exact/token 跟着走，value 清空等分析页来写
  store['ysy.xprobe.series'].mig_old = { handle: 'mig_old', min: [], updatedAt: 0,
    imp: [{ day: '2026-10-20', value: 7400, exact: false, token: '7.4k', fow: 11, fans: 22, posts: null, at: '2026-10-20T10:00:00.000Z' }] };
  sP.__xprobe.loadSeries();   // 迁移挂在开页的 loadSeries 后面 ⇒ 先重读一份带旧行的存储再跑
  const movedN = sP.__xprobe.migrateSeries();
  const migRow = store['ysy.xprobe.series'].mig_old.imp[0];
  ok('旧行一次性搬家：value→eff（exact/token/fow 原样），value 清空，effAt 拿原 at 当落账时刻',
    [movedN >= 1, migRow.eff, migRow.effExact, migRow.effToken, migRow.value, migRow.token, migRow.effAt, migRow.fow],
    [true, 7400, false, '7.4k', null, '', '2026-10-20T10:00:00.000Z', 11]);
  eq('正向对照：迁移过的行再跑一遍不动（幂等，eff 有主就不再搬）', sP.__xprobe.migrateSeries(), 0);
  sP.__xprobe.flush();
  ok('手动行的 reward 记录忠实带出处（v0.7.2：实时曝光走 value2；缩写补的 exact 语义跟着各自的列走，不许冒充精确）',
    (() => {
      const mr = postedRecords(sP).filter((r) => r.kind === 'reward' && r.data.manual === 1 && r.data.day === '2026-10-06').pop() || null;
      return !!mr && mr.data.value === null && mr.data.value2 === 13200 && mr.data.fow === 3360;
    })(), postedRecords(sP).filter((r) => r.kind === 'reward' && r.data.manual === 1).map((r) => r.data && [r.data.day, r.data.value, r.data.value2, r.data.exact]));
  delete store['ysy.xprobe.own'];
  const sNo = run(h('div', {}, [h('div', {}, [T('这里没有侧栏导航')])]), '/i/jf/anything', 'https://x.com/i/jf/anything');
  const noOwn = sNo.__toCore({ t: 'impAdd', v: { day: '2026-10-02', value: '100' } });
  ok('还没认到自己的 handle ⇒ 补录拒绝并给出可执行的一步',
    noOwn.result.ok === false && /先进一次自己的主页/.test(noOwn.result.err), noOwn.result);

  // 格式化层：几何是纯算数，Node 里就能判「点串画到哪儿了」
  const cs = V.chartSpec({ title: 't', series: [{ label: 'a', pts: [{ x: 0, y: 10 }, { x: 100, y: 20 }] }] });
  eq('两点撑起整幅：首点在左边界，末点在右边界', cs.series[0].pts, '40,100 354,10');
  eq('纵轴三格标签（上/中/下）', cs.yTicks.map((tk) => tk.label).join(','), '20,15,10');
  eq('横轴三格位置', cs.xTicks.map((tk) => tk.x).join(','), '40,197,354');
  const cs1 = V.chartSpec({ title: 't', series: [{ label: 'a', pts: [{ x: 0, y: 10 }] }] });
  ok('一个点不画线，直说为什么', /点不够画线/.test(cs1.empty), cs1.empty);
  const csN = V.chartSpec({ title: 't', series: [{ label: 'a', pts: [{ x: 0, y: null }, { x: 50, y: 3 }] }] });
  ok('读不到的那个点（null）剔掉，别把线拉到 0', csN.empty !== '' || csN.series[0].n === 1, [csN.empty, csN.series[0] && csN.series[0].n]);
  const csFlat = V.chartSpec({ title: 't', series: [{ label: 'a', pts: [{ x: 0, y: 20 }, { x: 100, y: 20 }] }] });
  eq('平线不贴轴：上下各让一格，线落在中间', [csFlat.series[0].pts, csFlat.yTicks.map((tk) => tk.label).join(',')], ['40,55 354,55', '21,20,19']);
  eq('万以上的刻度用「万」', V.nf(123456), '12.3万');
  // fixture 里的天不能再写死：昨天写这段时「今天=10-23」，那条 10-23 的断言走的是短路分支（直接 true），
  // /10,100/ 那一支从没真跑过 ⇒ 10-24 一过它就红。红出来才看清它要求的格式跟表里其它列压根不是一套口径
  // （精确值该报全数 12,345，缩写值该报 1.01万~）。现在今天=T0 那天、历史行=T0 往前 30 天，两支每次都真跑到。
  const dKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
  const todayFix = dKey(T0), pastFix = dKey(T0 - 30 * 864e5), pastFix2 = dKey(T0 - 29 * 864e5), pastFix3 = dKey(T0 - 28 * 864e5);
  const tLines = V.mineLines({
    tab: 'profile', own: 'king',
    series: {
      own: 'king', key: 'king', err: '', counts: { handles: 1, min: 3, imp: 4 },
      handles: [{ h: 'king', min: 3, imp: 4, at: 1 }],
      min: [{ ts: T0, at: 'a', following: 2578, followers: 2978 }, { ts: T0 + 60000, at: 'b', following: 2579, followers: 2979 }, { ts: T0 + 120000, at: 'c', following: 2580, followers: 2980 }],
      imp: [{ day: pastFix, value: 12345, exact: true, token: 'analytics', eff: 12345, effExact: true, effToken: 'manual', effAt: 'x', at: 'x' },
            { day: pastFix2, value: 20000, exact: true, token: 'analytics', eff: 13345, effExact: true, effToken: 'manual', effAt: 'x2', at: 'x2' },
            { day: pastFix3, value: 25000, exact: true, token: 'analytics', eff: 14545, effExact: true, effToken: 'manual', effAt: 'x3', at: 'x3' },
            { day: todayFix, value: 10100, exact: false, token: '10.1k', eff: 9800, effExact: false, effToken: '9.8k', effAt: 'y', at: 'y' }],
      lastRewards: null,
    },
  });
  eq('我的页四张折线图：分钟线（关注+粉丝两串）、曝光日线、关注/粉丝/帖子日线、转化率日线', tLines.filter((m) => m.k === 'chart').length, 4);
  eq('分钟线两条线各有 3 个点', tLines.filter((m) => m.k === 'chart')[0].series.map((s) => s.n), [3, 3]);
  const m4 = tLines.filter((m) => m.k === 'chart')[2];
  eq('日线图串序：有效曝光/关注/粉丝/帖子', m4.series.map((s) => s.label).join(','), '有效曝光,关注,粉丝,帖子');
  eq('日线图吃差分口径（90 天累计读数相减）：只有严格前一天也有读数的那天有点 ⇒ 2；关注/粉丝今天行吃分钟线（各 1 点）；帖子全程没数 ⇒ 0',
    m4.series.map((s) => s.n).join(','), '2,1,1,0');
  const m5 = tLines.filter((m) => m.k === 'chart')[3];
  ok('转化率图单独一张：两个差分点（1,000÷20,000=5% → 1,200÷25,000=4.8%），标题写明差分口径',
    m5.series[0].label === '转化率' && m5.series[0].n === 2 &&
      m5.series[0].first === 5 && m5.series[0].last === 4.8 && /90天累计读数相减/.test(m5.title),
    m5 && m5.series[0]);
  // v0.6.9 收尾：日点表 = 四列表（曝光/关注/粉丝/帖子），行宇宙 = imp 点的天 ∪ 分钟点有的天
  const impTable = tLines.filter((m) => m.k === 'imps')[0];
  const todayKey = todayFix;
  eq('行宇宙：历史三天 + 今天（今天与分钟线并成同一行）= 4 行，且与真实日期无关', impTable.rows.length, 4);
  const rowT = impTable.rows.find((r) => r.day === todayKey);
  ok('今天那行：关注取分钟线当日最高并写明「最高」，粉丝取最新分钟点（nf 紧凑口径：1万内不加逗号）；实时曝光缩写点带 ~；差分口径：累计读数缺前一天 ⇒ 有效曝光与转化率都是 —',
    rowT.fow === 2580 && rowT.fowHow === 'max' && rowT.fowTxt === '最高 2580' && rowT.fans === 2980 && rowT.fansTxt === '2980' &&
      rowT.impTxt === '1.01万~' && rowT.effTxt === '—' && rowT.rateTxt === '—', rowT);
  const row1 = impTable.rows.find((r) => r.day === pastFix);
  ok('最老一行：前面没有行 ⇒ 差分不出（eff 存的 12,345 是累计读数，照留；展示列 —）；关注/粉丝/帖子没数就是 —',
    row1.eff === 12345 && row1.effTxt === '—' && row1.imp === 12345 && row1.impTxt === '12,345' &&
      row1.rateTxt === '—' && row1.fowTxt === '—' && row1.fansTxt === '—' && row1.postsTxt === '—', row1);
  const row2 = impTable.rows.find((r) => r.day === pastFix2);
  ok('差分行：当日有效曝光 = 13,345 − 12,345 = 1,000（两边都精确 ⇒ 精确），转化率 = 1,000 ÷ 20,000 → 5%',
    row2.eff === 13345 && row2.effDay === 1000 && row2.effDayExact === true && row2.effTxt === '1,000' &&
      row2.impTxt === '20,000' && row2.rateTxt === '5%', row2);
  eq('v0.8.1 第一列短格式：dayDisp 是 YYMMDD（261025），day 本身还是完整 YYYY-MM-DD（存值/补录校验不动）',
    [rowT.dayDisp, row1.dayDisp, rowT.day === todayFix, row1.day === pastFix],
    [todayFix.slice(2).replace(/-/g, ''), pastFix.slice(2).replace(/-/g, ''), true, true]);
  eq('曝光两种口径分开：精确=千分位全数，缩写=两位万加 ~（跟采集器读到缩写同一个记号）',
    [V.impFmt(500000, true), V.impFmt(13200, false), V.impFmt(8500, false), V.impFmt(1.2e8, false)],
    ['500,000', '1.32万~', '8500~', '1.20亿~']);
  ok('反向对照要看得见：精确值不许被紧凑口径糊掉（12,345 用 nf() 会成 1.2万）',
    V.nf(12345) === '1.2万' && V.impFmt(12345, true) === '12,345', [V.nf(12345), V.impFmt(12345, true)]);
  const tt = tLines.filter((m) => m.k === 'line').map((m) => m.text).join('\n');
  ok('日线摘要给净增与门槛进度', /净增 -2245/.test(tt) && /2%/.test(tt), tt.slice(0, 300));
  // v0.6.10：一行都没有时网格也必须发出去。旧写法零行只 push 一句话 ⇒ 面板上没有任何能填的地方，
  // 「装插件第一天」和「清空之后」的历史就永远补不进去（用户那条投诉的第二条真因，第一条是 bkBox 从没显示）
  const tEmpty = V.mineLines({ tab: 'profile', own: 'king', series: { own: 'king', key: '', err: '', counts: {}, handles: [], min: [], imp: [], lastRewards: null } });
  const impEmpty = tEmpty.filter((m) => m.k === 'imps')[0];
  ok('零行也要有编辑器：没有任何数据时 mineLines 仍发 imps（rows 为空、标题换成「点编辑补历史」话术）',
    !!impEmpty && impEmpty.rows.length === 0 && /编辑/.test(impEmpty.title),
    [tEmpty.map((m) => m.k).join(','), impEmpty && impEmpty.rows.length]);
  eq('列序由 view 给死（面板只按 head 建列 ⇒ 以后加列只改这一处）',
    (impEmpty && impEmpty.head || []).join('/'), '日期/有效曝光/曝光/转化率/关注/粉丝/帖子');
  ok('正向对照：零行判据的两个条件各自都咬得住 —— 打在 4 行 fixture 上 rows 非空、标题里没有「还没有一行」',
    impTable.rows.length === 4 && !/还没有一行/.test(impTable.title) && /还没有一行/.test(impEmpty.title),
    [impTable.rows.length, impTable.title.slice(0, 12), impEmpty.title.slice(0, 6)]);
  ok('口径写死在面板上：只在这页开着时采', /只在这页开着时采/.test(tt), tt.slice(0, 300));
  // v0.6.11 跨人排名：每人最新一行 + 较上日净增 + 新鲜度，列头可换排序键（纯函数，Node 里直接判序）
  const rankSt = {
    tab: 'profile', own: 'king',
    series: {
      own: 'king', key: 'king', err: '', counts: { handles: 3 },
      handles: [], min: [], imp: [], lastRewards: null,
      rank: [
        { h: 'king', own: 1, at: T0, last: { day: todayFix, value: 10100, exact: false, fow: 2580, fans: 2980, posts: null },
          prev: { day: pastFix, value: 12345, exact: true, fow: 2350, fans: 2312, posts: 2870 } },
        { h: 'demo_a', own: 0, at: T0 - 3 * 864e5, last: { day: pastFix, value: null, exact: false, fow: 900, fans: 5000, posts: null }, prev: null },
        { h: 'zoe', own: 0, at: T0 - 60000, last: { day: todayFix, value: null, exact: false, fow: 120, fans: 4000, posts: 9 },
          prev: { day: pastFix, value: null, exact: false, fow: 100, fans: 3000, posts: 8 } },
      ],
    },
  };
  const rkFans = V.rankRows(rankSt, 'fans', false, T0);
  eq('按粉丝降序：demo_a(5000) > zoe(4000) > king(2980)，名次跟着排', rkFans.map((r) => r.h + '#' + r.rank).join(','), 'demo_a#1,zoe#2,king#3');
  eq('换排序键就换序：按关注降序 king(2580) 第一、zoe(120) 垫底', V.rankRows(rankSt, 'fow', false, T0).map((r) => r.h).join(','), 'king,demo_a,zoe');
  eq('升序就是把降序倒过来（同一列点两次）', V.rankRows(rankSt, 'fow', true, T0).map((r) => r.h).join(','), 'zoe,demo_a,king');
  const rkKing = rkFans.find((r) => r.h === 'king');
  eq('净增是「较上一行」不是「较昨天」：king 两行差 30 天也照算，dosken 只有一行算不出 = null',
    [rkKing.dFow, rkKing.dFans, rkKing.prevDay, rkFans.find((r) => r.h === 'demo_a').dFow], [230, 668, pastFix, null]);
  const rkZoe = rkFans.find((r) => r.h === 'zoe');
  ok('新鲜度：一分钟前=刚才、三天前=3 天前并标 stale（排名只比还活着的人）',
    rkZoe.stale === 0 && /刚才/.test(rkZoe.ageTxt) && rkFans.find((r) => r.h === 'demo_a').stale === 1 && /3 天前/.test(rkFans.find((r) => r.h === 'demo_a').ageTxt),
    [rkZoe.ageTxt, rkFans.find((r) => r.h === 'demo_a').ageTxt]);
  eq('曝光那列只有 own 有数（别人的主页 DOM 里读不到 ⇒ 恒 null，不是 0）：按粉丝序就是 , , 10100', rkFans.map((r) => r.imp).join(','), ',,10100');
  ok('空的是 null 不是 0（把「读不到」当 0 会把那人的名次打到垫底，那是假账）',
    rkFans.filter((r) => !r.own).every((r) => r.imp === null), rkFans.map((r) => [r.h, r.imp]));
  ok('排序键不认时回落到粉丝（面板传错值不许整张表空掉）', V.rankRows(rankSt, 'nonsense', false, T0).map((r) => r.h).join(','), 'demo_a,zoe,king');
  const rkMsg = V.plazaLines(rankSt, { by: 'fans', asc: false, now: T0 }).filter((m) => m.k === 'rank')[0];
  ok('plazaLines 把排名表发出来了（消息形状 k:rank + 标题写清「跨人可比的只有关注/粉丝」）',
    !!rkMsg && rkMsg.rows.length === 3 && /跨人真正可比的是关注\/粉丝/.test(rkMsg.title), rkMsg && rkMsg.title);
  eq('备用排名也吃分页（v0.8.1-t）：limit=1 出 1 人、more=2；不传 = 全量 3 人 more=0',
    [(V.rankNode(rankSt, 'fans', false, T0, 1) || {}).rows.length, (V.rankNode(rankSt, 'fans', false, T0, 1) || {}).more,
      (V.rankNode(rankSt, 'fans', false, T0) || {}).rows.length, (V.rankNode(rankSt, 'fans', false, T0) || {}).more],
    [1, 2, 3, 0]);
  const rkEmpty = V.plazaLines({ tab: 'profile', own: '', series: { own: '', key: '', counts: {}, handles: [], min: [], imp: [], rank: [] } }, { now: T0 }).filter((m) => m.k === 'rank')[0];
  ok('零人也发表格（不静默消失）：空 rank 时标题换成「还没有第二个人的记录」',
    !!rkEmpty && rkEmpty.rows.length === 0 && /还没有第二个人/.test(rkEmpty.title), rkEmpty && rkEmpty.title);
  ok('正向对照：把排序判据打在只有 1 人的 rank 上，同一句「三人序」当场不成立（证明它咬的是这份 fixture）',
    V.rankRows({ series: { rank: [rankSt.series.rank[0]] } }, 'fans', false, T0).length === 1, '');
  // ---------- v0.6.12：两页各管一套，「揉在一起」就是这一轮要修掉的东西 ----------
  ok('「我的」页里没有跨人排名表（rank 一条都不发）',
    tLines.filter((m) => m.k === 'rank').length === 0, tLines.map((m) => m.k).join(','));
  ok('广场里不画分钟线/曝光图（别人的分钟线根本不采，画出来就是拿自己那口账冒充他）：只给一张他的日线图',
    V.plazaLines({ tab: 'profile', own: 'king', series: { own: 'king', key: 'zoe', counts: {}, handles: [], min: [{ ts: T0, at: 'a', following: 1, followers: 2 }], imp: [], rank: rankSt.series.rank } }, { now: T0 })
      .filter((m) => m.k === 'chart').length, 1);
  const plazaWho = V.plazaLines({ tab: 'profile', own: 'king', series: { own: 'king', key: 'zoe', counts: {}, handles: [], min: [], imp: [{ day: todayFix, value: null, exact: false, fow: 120, fans: 4000, posts: 9 }], rank: rankSt.series.rank } }, { now: T0 });
  const plazaTable = plazaWho.filter((m) => m.k === 'imps')[0];
  ok('广场选中别人 ⇒ 日点表挂在他名下（who=zoe：面板的「存/删」照着这个 handle 写回，写错人比看不见更难查）',
    !!plazaTable && plazaTable.who === 'zoe' && /@zoe/.test(plazaTable.title), plazaTable && [plazaTable.who, plazaTable.title.slice(0, 12)]);
  const plazaSelf = V.plazaLines(rankSt, { now: T0 });
  ok('广场默认（视线还在自己身上）不发日点表，只发一句「用顶部「看谁」选中他」（不与「我的」页重复一张表）',
    plazaSelf.filter((m) => m.k === 'imps').length === 0 && /看谁/.test((plazaSelf.filter((m) => m.label === '要看某一个人')[0] || {}).value || ''),
    plazaSelf.map((m) => m.k + ':' + (m.label || '')).join(','));
  ok('「我的」页那张表的 who 恒 = own，视线跑到别人身上也不改口（两页的分工就靠这一条钉住）',
    V.mineLines({ tab: 'profile', own: 'king', series: { own: 'king', key: 'zoe', counts: {}, handles: [], min: [], imp: [], rank: [] } }).filter((m) => m.k === 'imps')[0].who === 'king', '');
  const ownRowOf = (series) => V.mineLines({ tab: 'profile', series: Object.assign({ min: [], imp: [], handles: [], counts: {} }, series) }).filter((x) => x.k === 'row' && x.label === '我的账号')[0];
  eq('「我的账号」那行：钉过的直说「设置里钉的」', ownRowOf({ own: 'king', ownSet: 'king' }).value, '@king　来源：设置里钉的');
  ok('没钉的直说「自动识别」并把去设置页改的路指出来（认错人时第一眼就知道去哪儿改）',
    /自动识别/.test(ownRowOf({ own: 'king', ownSet: '' }).title) && /设置 · 我的账号/.test(ownRowOf({ own: 'king', ownSet: '' }).title),
    ownRowOf({ own: 'king', ownSet: '' }).title);
  ok('正向对照：ownSet 为空时「设置里钉的」那五个字不许出现（证明它读的是这个字段，不是恒定文案）',
    /设置里钉的/.test(ownRowOf({ own: 'king', ownSet: '' }).value) === false, ownRowOf({ own: 'king', ownSet: '' }).value);
  eq('列头由 view 一处给死（两页共用 DAY_HEAD）', V.DAY_HEAD.join('/'), '日期/有效曝光/曝光/转化率/关注/粉丝/帖子');
  const rl = V.homeLines(xp.stateForPanel());
  ok('首页在奖励页只报曝光与证据（hero + 本页曝光行），不套主页那套统计行',
    rl.some((m) => m.k === 'hero') && rl.some((m) => m.label === '本页(奖励页)') &&
    !rl.some((m) => /关注者/.test(m.label || '')),
    rl.map((m) => m.label || ('k:' + m.k)));
  ok('正向对照：奖励页形状没数时那一行标红判否',
    V.rewardLine({ hit: false, keyNodes: 0 }).sty === 'bad' && V.rewardLine({ hit: true, value: 10100, text: '10.1K', exact: false, others: 1, key: 'x' }).sty === 'warn',
    V.rewardLine({ hit: false, keyNodes: 0 }));
}

console.log('\n[8h] v0.6.4：关注后 60 秒冷却（红色倒计时 / 绿色可以关注）');
{
  delete store['ysy.xprobe.guard'];
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xp = sb.__xprobe;
  const g = xp.getGuard();
  g.follows.length = 0; g.unfollows.length = 0; g.ev.length = 0; g.cool = null;
  eq('加时上限先归零（这一组钉 60 秒基线，断言不允许掺随机；随机那条腿在 [8h2]）', xp.setRndMax(0).rndMax, 0);

  xp.fabBtn();
  const s0 = xp.guardStatus(Date.now());
  eq('没关注动作时不起冷却', [s0.coolAt, s0.coolLeft, s0.coolFull], [0, 0, 60000]);
  eq('浮标此时是「观」', xp.fabBtn().textContent, '观');
  eq('横幅绿色并直说还没动作', [V.coolLine({ guard: s0 }, Date.now()).sty, V.coolLine({ guard: s0 }, Date.now()).text],
    ['ok', '✓ 可以关注 · 还没有关注动作']);

  const s1 = xp.recordAction('follow', { id: '111', handle: 'zz_a', why: 'attr' });
  const s1b = xp.guardStatus(Date.now());
  ok('关注一次 ⇒ 冷却从 60000 起算（不许第一条就给自己算成 0）',
    s1b.coolAt > 0 && s1b.coolLeft > 55000 && s1b.coolLeft <= 60000 && s1.coolFull === 60000,
    [s1.coolLeft, s1b.coolLeft, s1b.coolAt]);
  eq('第一次关注没有「上一条」，所以不判密集', [s1.gap, s1.rapid], [null, false]);
  ok('浮标变冷却态：圈里是那串还在往下走的秒数（v0.8.15 起不再有「待」这个字），字色仍是冷却橙'
    + '（v0.9.5 两段式：字与色住在 label span 上，钮本体只管形状）',
    /^\d{1,3}$/.test(xp.fabBtn().children[0].textContent) && Number(xp.fabBtn().children[0].textContent) > 55
    && Number(xp.fabBtn().children[0].textContent) <= 60 && xp.fabBtn().children[0].style.color === '#e0a34c',
    [xp.fabBtn().textContent, xp.fabBtn().children[0].style.color]);
  const mid = V.coolLine({ guard: { f15: 1, max15: 15, f24: 1, max24: 400, coolAt: s1b.coolAt, coolFull: 60000 } }, s1b.coolAt + 17000);
  eq('冷却中的横幅是红的且带剩余秒数（17 秒已过 ⇒ 还剩 43 秒）', [mid.sty, mid.text, mid.left], ['bad', '⛔ 不要关注 · 倒计时 43 秒', 43000]);

  const s2 = xp.recordAction('follow', { id: '222', handle: 'zz_b', why: 'attr' });
  ok('60 秒内的第二次关注：gap 是两条之间的真实间隔，并标 rapid（日志里要能证伪「有没有守规矩」）',
    s2.rapid === true && typeof s2.gap === 'number' && s2.gap >= 0 && s2.gap < 60000, [s2.gap, s2.rapid]);
  ok('冷却从最后一次起算 ⇒ 密集关注会把倒计时续上，不会提前放绿',
    s2.coolLeft > 55000 && xp.getGuard().follows.length === 2, [s2.coolLeft, xp.getGuard().follows.length]);

  const s3 = xp.recordAction('unfollow', { id: '333', handle: 'zz_c', why: 'attr' });
  eq('取关只进流水：不占额度也不续冷却（coolAt 还是最后那次关注）',
    [s3.u24 >= 1, s3.coolAt === xp.getGuard().follows[1], s3.coolLeft > 50000], [true, true, true]);

  const nowQ = Date.now();
  xp.getGuard().follows = Array.from({ length: 15 }, (_, i) => nowQ - i * 1000);
  const s5 = xp.guardStatus(nowQ);
  const qFab = xp.fabBtn();
  // v0.8.15：「限」这个字没了 —— 圈里直接读「还要多少秒才腾出名额」。15 条各差 1 秒 ⇒ 最早那条 14 秒前进窗口、
  // 900 秒后过期 ⇒ 期望 886（留 2 秒余量：跑测试这几毫秒也可能跨过一秒边界，跨过就是 885）。
  ok('额度到顶时圈里是红色读秒（不再写「限」），且读的是额度窗口不是 60 秒冷却：886 秒 ≫ 60（红字在 label span 上）',
    /^\d{1,3}$/.test(qFab.textContent) && Math.abs(Number(qFab.textContent) - 886) <= 2 && qFab.children[0].style.color === '#e06c60',
    [qFab.textContent, qFab.children[0].style.color]);
  eq('优先级照旧：到顶盖过冷却（这条灯一秒钟只说一件事）', xp.fabFreeMs(s5), s5.free15);
  const c5 = V.coolLine({ guard: s5 }, nowQ);
  ok('到顶的横幅点名是「额度」问题，不是 60 秒问题', c5.sty === 'bad' && /额度已到顶/.test(c5.text) && /15\/15/.test(c5.text), c5);
  eq('守卫自己报错时横幅也判红（不许显示「可以关注」骗人）', V.coolLine({ guard: { err: 'observer 挂了' } }, nowQ).sty, 'bad');
  eq('dur 的三档口径', [V.dur(45000), V.dur(61000), V.dur(3720000)], ['45 秒', '1 分 1 秒', '1 小时 2 分']);

  const fab = xp.fabBtn();
  const fabLabEl = fab.children[0];   // v0.9.5 两段式：字住在 label span 上 ⇒ 写入计数也盯它
  let fabWrites = 0;
  let fabVal = fabLabEl.textContent;
  Object.defineProperty(fabLabEl, 'textContent', {
    configurable: true, get: () => fabVal, set: (v) => { fabWrites++; fabVal = String(v); },
  });
  xp.getGuard().follows = [Date.now() - 30000];
  eq('冷却中：页面里那颗灯读秒（30 秒上下），仍是冷却橙', [xp.fabBtn().textContent, xp.fabBtn().children[0].style.color], ['30', '#e0a34c']);
  eq('一次状态翻转只写一次字', fabWrites, 1);
  xp.fabBtn(); xp.fabBtn(); xp.fabBtn();
  sb.__runIntervals(1000);   // 读秒那一枪也打在同一秒里
  eq('同一秒内重复进灯 ⇒ 一个字都不再往页面 DOM 里写（读秒按秒翻面，节拍器 1.2s 与它不同源也只写一次）', fabWrites, 1);
  const c3 = V.coolLine({ guard: xp.guardStatus() }, Date.now());
  const bannerSec = Number((c3.text.match(/倒计时 (\d+) 秒/) || [])[1]);
  ok('页面那颗与面板横幅同源于 guardStatus：圈里的秒数与横幅的秒数对得上（±1 只可能是跨了一秒）',
    c3.sty === 'bad' && bannerSec > 0 && Math.abs(bannerSec - Number(fab.textContent)) <= 1,
    [fab.textContent, c3.text]);
  xp.getGuard().follows = [Date.now() - 61000];
  sb.__runTimers(2);
  eq('过 60 秒后节拍器自己把灯翻回「观」（放绿不靠我再去点按钮）', [xp.fabBtn().textContent, fabWrites], ['观', 2]);
  eq('翻回「观」⇒ 读秒的 1 秒定时器当场摘掉（没有秒可读就不许留一条每秒的节奏）',
    [xp.fabStat().beat, sb.__intervals().filter((x) => x.ms === 1000).length], [false, 0]);
  const c4 = V.coolLine({ guard: xp.guardStatus() }, Date.now());
  // 只钉格式不钉具体秒数：61 秒的间隔在断言前若跨过真实的秒边界就成了 62 秒（1 分 2 秒）——
  // 跨秒抖动曾让精确正则隔几趟挂一次。意图是「给出距上次多久」，位数交给真实时钟。
  eq('绿色横幅给出「距上次多久」', [c4.sty, /^✓ 可以关注 · 距上次关注 1 分 \d+ 秒（60 秒冷却已过）$/.test(c4.text)], ['ok', true]);
  ok('横幅 title 把边界写死：只警告、不拦点击', /不拦点击/.test(c4.title), c4.title.slice(0, 60));

  // 真走 DOM 翻转那一条腿：记录里必须带 gap/rapid/cool，sink-8 才有东西可打
  const b1 = profile.querySelector('[data-testid="987654321-follow"]');
  xp.onFollowSeen(b1, 'attr');                       // 首次见到只登记基线（与 [11] 同口径）
  xp.getGuard().follows = [Date.now() - 61000];
  b1.attrs['data-testid'] = '987654321-unfollow'; b1.attrs['aria-label'] = '正在关注 @demo_own';
  xp.onMutations([{ type: 'attributes', target: b1 }]);
  const b2 = h('button', { 'data-testid': '1251127925195378690-follow', 'aria-label': '关注 @FinanzasArgy' }, [T('关注')]);
  xp.onMutations([{ type: 'childList', addedNodes: [b2], removedNodes: [] }]);   // 滚出来的一行：基线，不计数
  b2.attrs['data-testid'] = '1251127925195378690-unfollow'; b2.attrs['aria-label'] = '正在关注 @FinanzasArgy';
  xp.onMutations([{ type: 'attributes', target: b2 }]);
  xp.flush();
  const fRecs = postedRecords(sb).filter((r) => r.kind === 'follow');
  const r1 = fRecs[fRecs.length - 2] || {}, r2 = fRecs[fRecs.length - 1] || {};
  ok('间隔 61 秒的那次关注：gap≈61000、不判密集', r1.data && r1.data.targetId === '987654321' &&
    r1.data.gap >= 60000 && r1.data.gap < 70000 && r1.data.rapid === false, r1.data);
  ok('紧跟其后的那次：gap 只有几十毫秒 ⇒ rapid=true，cool 把规则本身（60000）也带上',
    r2.data && r2.data.targetId === '1251127925195378690' && r2.data.gap < 1000 &&
    r2.data.rapid === true && r2.data.cool === 60000, r2.data);
  eq('两条记录都带页型（sink 的 follow 行按它排版）', [r1.tab, r2.tab], ['profile', 'profile']);
  eq('滚出来那一行没被当成关注动作计数（只登记基线）', r1.data.w15, r2.data.w15 - 1);
  b1.attrs['data-testid'] = '987654321-follow'; b1.attrs['aria-label'] = '关注 @demo_own';
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts'].forEach((k) => delete store[k]);
  delete store['ysy.xprobe.randMax'];
}

console.log('\n[8h4] v0.8.15：守卫灯在圈里读秒 + 浮标直径照 X 右缘那一列量（实测 / 回落 / 只开该开的定时器）');
{
  delete store['ysy.xprobe.guard'];
  const xbtn = (t) => h('button', { 'aria-label': t }, [T(t)]);
  // X 右缘那一列的真形状：三颗 40px 圆钮贴右、站在下半屏。桩的自动排版把它们摆在别处，
  // 所以跑完以后再显式覆写 __geo（第六条老坑：要测几何就得自己灌坐标）。
  const fx = h('div', {}, [xbtn('聊天'), xbtn('举报'), xbtn('通知'), xbtn('小'), xbtn('左上')]);
  const sb = run(fx, '/home', 'https://x.com/home');
  const xp = sb.__xprobe;
  const geo = (n, left, top, w, hh) => { n.__geo = { left: left, top: top, width: w, height: hh }; };
  const cols = fx.children;
  geo(cols[0], 1386, 700, 40, 40); geo(cols[1], 1386, 650, 40, 40); geo(cols[2], 1386, 600, 40, 40);
  geo(cols[3], 1400, 750, 24, 24); geo(cols[4], 20, 700, 40, 40);
  eq('参照物就是那一列：三颗 40 + 一颗 24 的干扰 ⇒ 取中位数；左上那颗尺寸对但不在右缘，不算', xp.fabPeerDiam(), 40);
  xp.fabBtn();   // 一趟里先量后画：建排时按 34 起笔、这一趟改成实测 40（只此一次，定案后不再摸页面）
  const f15 = IDS['ysy-xprobe-ext-fbtn'], b15 = IDS['ysy-xprobe-ext-cbtn'];
  const r15 = IDS['ysy-xprobe-ext-rbtn'], l15 = IDS['ysy-xprobe-ext-fab'];
  eq('量到 ⇒ 直径当场定案、来源记「x」（真机日志里 env.fab 就是这一格）',
    [xp.fabStat().px, xp.fabStat().src], [40, 'x']);
  eq('三颗方钮的直径/圆角一起按实测改（方案 A：等大圆角方钮，行高恒 1.1；自适应尺寸不推翻 v0.8.15）',
    [f15.style.width, f15.style.height, f15.style.lineHeight, f15.style.borderRadius],
    ['40px', '40px', '1.1', '6px']);
  eq('字号跟着变大（用户原话「字体也要大一点」）：单字 40×0.5=20px，住在 label span 上（v0.9.5 两段式）',
    f15.children[0].style.font, '20px ui-monospace, Consolas, monospace');
  eq('灯那颗也一起放大（它现在要装三位数）', [l15.style.width, l15.style.height], ['40px', '40px']);
  eq('「回」那颗也是等大圆角方钮（个数挪到右上角角标，三种形状的账作废），宽高圆角全按直径',
    [r15.style.width, r15.style.height, r15.style.borderRadius, r15.style.minWidth],
    ['40px', '40px', '6px', null]);
  eq('名单锚点按「大出来那截 ×5 颗 + 窗口那两颗各一格」让位（334 这个基准常量一字未动）',
    xp.flistBottomPx(), 334 + (40 - 34) * 5 + (40 + 6) * 2);
  eq('正向对照：窗口那两颗各占一格 fabSlotPx = 直径+6 ⇒ 两格都抠掉只剩 364（让位算式真的咬「排里有几颗」）',
    [xp.fabSlotPx(), xp.flistBottomPx() - xp.fabSlotPx() * 2], [46, 364]);
  eq('到顶读哪一个：两档都到顶取更近的（15 分钟先松口就先给那个数），只到一档给那一档，都没到顶给 0',
    [xp.fabFreeMs({ over15: true, free15: 700000, over24: true, free24: 30000 }),
     xp.fabFreeMs({ over15: true, free15: 700000, over24: false, free24: 0 }),
     xp.fabFreeMs({ over15: false, free15: 0, over24: true, free24: 86300000 }),
     xp.fabFreeMs({ over15: false, free15: 900000, over24: false, free24: 0 })],
    [30000, 700000, 86300000, 0]);

  // 纯口径：读秒三档 + ceil + 字号退档（这三个是「圈里那几个字」的全部算术，钉死不靠真机）
  eq('读秒三档：≤999 秒写秒、≤99 分写「Nm」、再往上「Nh」——四位数不进圆圈（放不下也读不出规律）',
    [xp.fabCd(0), xp.fabCd(800), xp.fabCd(68000), xp.fabCd(999000), xp.fabCd(1000000), xp.fabCd(5 * 3600000), xp.fabCd(-1)],
    ['0', '1', '68', '999', '17m', '5h', '0']);
  eq('剩余按 ceil 不按 floor ⇒ 同一秒内前后两枪读出同一个字（68000 与 67001 都是「68」，不许跳成 67 再回来）',
    xp.fabCd(68000) === xp.fabCd(67001), true);
  eq('字号按字数退档：单字 0.5 / 两位 0.46 / 三位 0.36（40px 圈里 20/18/14，44 装三个字符也不贴边）',
    [xp.fabFontPx(40, '观'), xp.fabFontPx(40, '68'), xp.fabFontPx(40, '886'), xp.fabFontPx(44, '回12')], [20, 18, 14, 16]);

  // 定时器生命周期：有秒可读才开、没秒可读就摘、重复进灯不叠加
  xp.getGuard().follows = [Date.now() - 30000];
  xp.fabBtn();
  eq('冷却中 ⇒ 起一枚 1 秒定时器（页面里那条跳字的节奏就只可能是这一枚）',
    [xp.fabStat().beat, sb.__intervals().filter((x) => x.ms === 1000).length], [true, 1]);
  xp.fabBtn(); xp.fabBtn();
  eq('重复进灯不叠第二枚（1.2 秒节拍器与 1 秒读秒两条腿并存时定时器仍只有一枚）',
    sb.__intervals().filter((x) => x.ms === 1000).length, 1);
  const t15 = IDS['ysy-xprobe-ext-fab'].textContent;
  xp.getGuard().follows = [Date.now() - 45000];
  eq('那一枪打的是灯本身（不靠节拍器转一手）：跑一枪圈里的字就跟着走',
    [sb.__runIntervals(1000) >= 1, IDS['ysy-xprobe-ext-fab'].textContent !== t15], [true, true]);
  xp.getGuard().follows = [];
  xp.fabBtn();
  eq('翻回「观」⇒ 定时器当场摘掉（没有秒可读的时候，页面里不许留着一条每秒的节奏）',
    [xp.fabStat().beat, IDS['ysy-xprobe-ext-fab'].textContent, sb.__intervals().filter((x) => x.ms === 1000).length],
    [false, '观', 0]);

  // 量不到的那条腿：另一份沙箱里页面一列都找不到
  const sb2 = run(h('div', {}, [xbtn('没有右列')]), '/home', 'https://x.com/home');
  const xp2 = sb2.__xprobe;
  IDS['ysy-xprobe-ext-fbtn'].__geo = { left: 1386, top: 700, width: 56, height: 56 };   // 自家那颗「站在」右缘
  eq('排除走的是「认自家节点」不是「量不到」：自家 56px 那颗摆在同一条边上也当不了参照物', xp2.fabPeerDiam(), 0);
  let spin2 = 0;
  while (xp2.fabStat().src === 'base' && spin2++ < 30) xp2.fabMeasure();
  eq('量到上限趟数就回落到常量 44，并当场定案（用户要「大一点」，量不到也比原来大）',
    [xp2.fabStat().px, xp2.fabStat().src, xp2.fabStat().tries], [44, 'fallback', 10]);
  xp2.fabBtn();   // 定案那一趟也要真的进一次灯，样式才落到页面上（fabMeasure 只定数，不动 DOM）
  eq('回落后的直径也真的写进了页面（圆与字号同一口径，字号在 label span 上）',
    [IDS['ysy-xprobe-ext-fbtn'].style.width, IDS['ysy-xprobe-ext-rbtn'].style.height, IDS['ysy-xprobe-ext-fbtn'].children[0].style.font],
    ['44px', '44px', '22px ui-monospace, Consolas, monospace']);
  const late2 = xbtn('迟到的一列');
  sb2.document.documentElement.appendChild(late2);
  late2.__geo = { left: 1386, top: 700, width: 64, height: 64 };
  xp2.fabMeasure();
  eq('定案以后页面又长出 X 的那列 ⇒ 也不再改（每趟一次布局读取就是新的可观察节奏，且会抖）',
    [xp2.fabStat().px, xp2.fabStat().tries], [44, 10]);
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.randMax'].forEach((k) => delete store[k]);
}

console.log('\n[8h2] 随机加时（v0.6.8）：完整冷却 = 60 秒基线 + 0~上限秒，抽中值进台账与流水，上限面板可改即时生效');

{
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xp = sb.__xprobe;
  const g = xp.getGuard();
  g.follows.length = 0; g.unfollows.length = 0; g.ev.length = 0; g.cool = null;
  eq('上限没设过时默认 20 秒（面板设置区的初值）', xp.rndMaxGet(), 20);
  eq('上限夹在 0..300（打 9998 不许把冷却弄到半小时以上）', xp.setRndMax(9998).rndMax, 300);
  eq('上限设回 20 再抽（下面用定额随机把 0.25 钉进沙箱的 Math）', xp.setRndMax(20).rndMax, 20);
  sb.Math.random = () => 0.25;
  // 流水记录由 onFollowSeen 发（recordAction 只是内部账本），走真按钮翻转那条腿
  const b1 = profile.querySelector('[data-testid="987654321-follow"]');
  xp.onFollowSeen(b1, 'attr');                       // 首次见到只登记基线
  const flip = () => {
    b1.attrs['data-testid'] = '987654321-unfollow'; b1.attrs['aria-label'] = '正在关注 @demo_own';
    const s = xp.onFollowSeen(b1, 'attr');
    b1.attrs['data-testid'] = '987654321-follow'; b1.attrs['aria-label'] = '关注 @demo_own';
    xp.onFollowSeen(b1, 'attr');   // 翻回去 = 记一次取关流水，同时清掉 evtOnce 的对面键
    return s;
  };
  const s1 = flip();
  const gs1 = xp.guardStatus(Date.now());
  eq('钉 0.25、上限 20 ⇒ 抽到 5，本轮完整冷却 = 60+5 = 65 秒', [g.cool.rnd, g.cool.full, gs1.coolFull, s1], [5, 65000, 65000, 'follow']);
  const evF = g.ev.filter((e) => e.dir === 'follow').pop();
  eq('抽中的加时也进事件台账（日志要能证伪「到底等了多久」）', [evF.rnd, evF.dir], [5, 'follow']);
  const cl = V.coolLine({ guard: xp.guardStatus() }, Date.now());
  ok('横幅规则文本带本轮完整秒数（65 秒，不是笼统的 60）', /至少等 65 秒/.test(cl.title), cl.title.slice(0, 80));
  xp.flush();
  const frec = postedRecords(sb).filter((r) => r.kind === 'follow' && r.data && r.data.dir === 'follow').pop() || {};
  ok('关注流水带本轮完整冷却与加时（sink 那行能打出 全=65s 加时+5s）',
    frec.data && frec.data.cool === 65000 && frec.data.rnd === 5, frec.data);
  eq('上限改 40 即刻生效：下一次按新上限抽（floor(0.5×41)=20 ⇒ 60+20=80 秒）',
    (() => { xp.setRndMax(40); sb.Math.random = () => 0.5;
      flip();
      return [g.cool.rnd, g.cool.full]; })(), [20, 80000]);
  eq('取关不碰冷却：cool 还是那一次关注的 {.at, 80000}',
    (() => { const at = g.cool.at; xp.recordAction('unfollow', { id: 'e3', handle: 'zz_r3', why: 'attr' });
      return [g.cool.at === at, g.cool.full]; })(), [true, 80000]);
  eq('上限 0 = 回到固定 60 秒（rnd 也是 0）',
    (() => { xp.setRndMax(0); flip();
      return [g.cool.rnd, g.cool.full]; })(), [0, 60000]);
  eq('上限持久化进 GM 存储（换标签页/重启浏览器都认）', store['ysy.xprobe.randMax'], 0);
  g.follows.length = 0; g.unfollows.length = 0; g.ev.length = 0; g.cool = null;
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.randMax'].forEach((k) => delete store[k]);
}

console.log('\n[8h3] 今日关注进度（v0.6.9 F4 第 2 版）：基线=「正在关注」读数（手动/自动=今天首点），分子用页面读数不用台账 —— 真机 2960→3113 探针只数到 71 次关注动作（漏计）⇒ 17.8% 那版就是错的口径');
{
  // 复刻用户现场：基线 2960 手填（14:22 设），分钟线今天 12:10 起每 12 分钟一个读数 2960→3010→3060→3113
  const T0 = Date.now();
  const MID = (() => { const d = new Date(T0); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const T = MID + 14 * 3600000;
  const mpts = (vals, h0, step) => vals.map((v, i) => ({ ts: MID + (h0 + i * step) * 60000, following: v }));
  const min = mpts([2960, 3010, 3060, 3113], 12 * 60 + 10, 12);
  const hand = { guard: { goalToday: { day: 'x', base: 2960, baseSrc: 'hand', target: 399, setAt: T - 90 * 60000, done: 71 } }, series: { min } };
  const bar = V.goalBar(hand, T);
  ok('现场复刻：2960 → 3359 · 当前 3113 · 已 +153 · 38.3%（153/399 一位小数；旧口径 17.8% 来自漏计的台账）',
    /2960 → 3359/.test(bar.text) && /当前 3113/.test(bar.text) && /已 \+153/.test(bar.text) && /38\.3%/.test(bar.text), bar.text);
  eq('两端锚标：左=基线、右=目标（用户点名要的清晰版）', [bar.endLeftTxt, bar.endRightTxt], ['基线 2960', '目标 3359']);
  ok('ETA 手动基线从「填下去那一刻」起量：+153/90 分，还差 246 即 2 小时 24 分后完成',
    /按当前节奏约 2 小时 24 分后完成/.test(bar.text) && bar.title.indexOf('手动填的') >= 0, bar.text);
  const auto = { guard: { goalToday: { day: 'x', base: null, baseSrc: 'auto', target: 399, setAt: null, done: 71 } }, series: { min } };
  const barA = V.goalBar(auto, T);
  ok('自动基线 = 分钟线今天最早的读数（今天首点 2960，横停里说清来源）',
    barA.endLeftTxt === '基线 2960' && /已 \+153/.test(barA.text) && barA.title.indexOf('自动=分钟线今天最早的读数') >= 0, barA.text);
  ok('自动基线的 ETA 从今天首点量：跨 36 分 ⇒ 还差 246 约 57 分 53 秒后完成',
    /按当前节奏约 57 分 53 秒后完成/.test(barA.text), barA.text);
  const none = V.goalBar({ guard: { goalToday: { day: 'x', base: 2960, baseSrc: 'hand', target: 399, setAt: T - 90 * 60000 } }, series: {} }, T);
  eq('没有「正在关注」读数：明说去自己主页开面板（分钟点在那才打），不给 0% 假象', [none.sty, /还没有「正在关注」读数/.test(none.text)], ['warn', true]);
  const drop = V.goalBar({ guard: { goalToday: { day: 'x', base: 2960, baseSrc: 'hand', target: 399, setAt: T - 90 * 60000 } },
    series: { min: mpts([2960, 2900], 12 * 60 + 10, 60) } }, T);
  ok('当前比基线低（一般取关多了）：0% + 明说是怎么回事，不许显示负数吓人', /比基线少 60/.test(drop.text) && /取关多了/.test(drop.text) && /0%/.test(drop.text), drop.text);
  const one = V.goalBar({ guard: { goalToday: { day: 'x', base: 2960, baseSrc: 'hand', target: 399 } },
    series: { min: mpts([3113], 12 * 60 + 10, 12) } }, T);
  eq('只有一个读数：ETA 明说推不出而不是编一个', /节奏推不出（今天只有一个读数）/.test(one.text), true);
  eq('达标：绿条 + ✓（涨幅≥目标就到头，不许 110% 那种假手感）',
    V.goalBar({ guard: { goalToday: { day: 'x', base: 2960, baseSrc: 'hand', target: 399, setAt: T - 90 * 60000 } }, series: { min: mpts([3400], 12 * 60 + 10, 12) } }, T).sty, 'ok');
  // core 侧：只递两件持久化的数 + 台账 done；进度数学全在 view 层（纯函数可断言）
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xp = sb.__xprobe;
  const g = xp.getGuard();
  g.follows.length = 0; g.unfollows.length = 0; g.ev.length = 0; g.cool = null; g.goal = null;
  eq('没设过 = auto + 默认目标 399（base 不再冒充 0）',
    (() => { const gt0 = xp.guardStatus().goalToday; return [gt0.base, gt0.baseSrc, gt0.target]; })(), [null, 'auto', 399]);
  const g1 = xp.setGoal({ base: 2960, target: 399 });
  eq('手动基线 2960 落台账（现场这个数）', [g1.goal.base, g1.goal.baseSrc, g1.goal.target], [2960, 'hand', 399]);
  eq('goal 持久化进 guard 存档键（多页签合并的原料）', store['ysy.xprobe.guard'].goal.base, 2960);
  eq('base 夹宽到「正在关注」量级：999999 → 200000', xp.setGoal({ base: 999999 }).goal.base, 200000);
  eq('target 夹宽：99999 → 10000', xp.setGoal({ target: 99999 }).goal.target, 10000);
  ok('done 仍在 goalToday 里（只进日志对账，不再喂进度条）', typeof xp.guardStatus().goalToday.done === 'number', xp.guardStatus().goalToday);
  eq('两格都空 = 保持现状（基线洗回 auto，目标保留）', (() => { const r = xp.setGoal({ base: null, target: null }); return [r.goal.baseSrc, r.goal.target]; })(), ['auto', 10000]);
  eq('命令通道：面板两格走 goalSet，同帧 state 落地',
    (() => { const r = sb.__toCore({ t: 'goalSet', v: { base: 50 } }); return [r.ok, r.result.goal.base, r.state.guard.goalToday.baseSrc]; })(), [true, 50, 'hand']);
  ok('首页有进度条这一条（guard 在但没有读数时也说清去哪儿拿）',
    V.homeLines(Object.assign({}, xp.stateForPanel(), { guard: { goalToday: { day: 'x', base: 2960, baseSrc: 'hand', target: 399, setAt: T - 90 * 60000 } } }))
      .filter((m) => m.k === 'bar').length === 1);
  g.follows.length = 0; g.unfollows.length = 0; g.ev.length = 0; g.cool = null; g.goal = null;
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.randMax'].forEach((k) => delete store[k]);
}

console.log('\n[8i] v0.6.5：chrome.storage 只留运行态（整页原文归本机库）+ 面板要知道占用');
{
  ['ysy.xprobe.v1', 'ysy.xprobe.users', 'ysy.xprobe.posts'].forEach((k) => delete store[k]);
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xp = sb.__xprobe;
  const pad = (n) => 'x'.repeat(n);
  function snapAt(i, big) {
    const t = Date.UTC(2026, 9, 1, 8, 0, 0) + i * 60000;
    return {
      at: new Date(t).toISOString(), url: 'https://x.com/zz_prof', tab: 'profile', hydrated: true,
      identity: { handle: 'zz_prof', displayName: 'ZZ Prof', listTab: '', nameForeign: 0, ownProfile: false, selfHandleGuess: '', followRelation: '' },
      stats: { following: { visibleNum: { value: 2700 + i, exact: true } }, followers: { visibleNum: { value: 2600 + i, exact: true } }, verified_followers: null, __foreign: [] },
      users: [{ handle: 'zz_u1', origin: 'list', name: 'U One', nameForeign: 0, followState: 'following',
        html: pad(big), leafShapes: [1, 2, 3], cands: ['a', 'b'], dump: pad(big), nameTokens: ['U'], nameRaw: 'U One', cellText: pad(big), followAria: pad(big) }],
      tweets: [{ tweetId: 'zz_t1', author: '@zz_prof', text: '正文', timeDatetime: new Date(t).toISOString(), adSuspect: false,
        html: pad(big), summaryAria: pad(big), timeVisible: pad(big), statusHref: pad(big),
        metrics: { like: { num: { value: 100 + i, exact: true, raw: '100' }, buttonValue: 100 + i, buttonExact: true }, reply: { num: { value: 3, exact: true, raw: '3' } } } }],
      rewards: null, cov: {}, covUsers: {},
    };
  }
  const meta = xp.saveRuns(Array.from({ length: 40 }, (_, i) => snapAt(i, 40)));
  eq('只留 26 份（最新 6 全量 + 往前 20 精简），不是 400', [meta.kept, meta.full, meta.slim, meta.dropped], [26, 6, 20, 14]);
  const st = store['ysy.xprobe.v1'];
  eq('落盘的确实是「旧的瘦、新的胖」', [st.filter((s) => s.slim).length, st.filter((s) => !s.slim).length], [20, 6]);
  eq('精简行丢的是原文类字段，留的是重建两张表要读的字段',
    [st[0].tweets[0].html === undefined, st[0].tweets[0].metrics.like.num.value, st[0].users[0].html === undefined, st[0].users[0].handle],
    [true, 100 + (40 - 26), true, 'zz_u1']);
  eq('最新那份仍带原文（面板「本页」与深挖要看）', [st[25].tweets[0].html.length, st[25].users[0].dump.length], [40, 40]);
  const rb = xp.rebuildStores();
  eq('拿这批混合留存重算，两张表照样建得起来 —— 这是敢精简的前提',
    [rb.runs, rb.slim, rb.users, rb.posts, rb.bad], [26, 20, 2, 1, 0]);

  const bigMeta = xp.saveRuns(Array.from({ length: 12 }, (_, i) => snapAt(i, 200000)));
  ok('单键软顶 2MB 先到，永远不许把 10MB 配额顶穿（顶穿的代价是全套持久化静默停摆）',
    bigMeta.bytes <= xp.caps().byteCap && bigMeta.kept >= 1 && bigMeta.dropped > 0 && bigMeta.kept < 12, bigMeta);
  xp.saveRuns(Array.from({ length: 40 }, (_, i) => snapAt(i, 40)));
  const ex = JSON.parse(xp.buildExport());
  ok('导出带说明：哪几份是精简行、原文在哪（离线分析要看得懂自己拿到的是什么）',
    /slim=1/.test(ex.runsNote) && ex.runs.filter((s) => s.slim).length === 20 && ex.runs.filter((s) => !s.slim).length === 6,
    { note: ex.runsNote, slim: ex.runs.filter((s) => s.slim).length, full: ex.runs.filter((s) => !s.slim).length });

  const gst = xp.stateForPanel();
  eq('state 带 storage 与 runsMeta（面板那两条行的数据腿）', [Object.keys(gst).sort().indexOf('runsMeta') >= 0, !!gst.storage], [true, true]);
  eq('自检环境没有适配层 ⇒ 面板明说「没量到」，不许显示 0KB 骗人',
    [gst.storage.measured, V.storeLine(gst).sty, /没量到/.test(V.storeLine(gst).value)], [false, 'warn', true]);

  const okSt = { storage: { measured: true, keys: { 'ysy.xprobe.v1': 1048576, 'ysy.xprobe.users': 204800 }, total: 1253376, quota: 10485760, writes: 9, failed: 0, lastErr: '', lastErrAt: '' },
    runsMeta: { kept: 26, full: 6, slim: 20, dropped: 3, bytes: 1048576, cap: 2097152 } };
  const sl = V.storeLine(okSt);
  eq('占用行给出总量/配额/最大三个键/留存形状',
    [sl.sty, /^1\.2MB\/10MB（12%）/.test(sl.value), /留26 全量6 精简20 滚掉3/.test(sl.value), /v1 1MB/.test(sl.value)], ['ok', true, true, true]);
  const hot = { storage: Object.assign({}, okSt.storage, { total: 9437184 }), runsMeta: okSt.runsMeta };
  eq('正向对照：占到 90% 就转黄（不是写死的绿）', V.storeLine(hot).sty, 'warn');
  // v0.7.1：manifest 加了 unlimitedStorage ⇒ 面板不许再拿 10MB 当分母（20MB 也不该报黄/报 200%）
  const unlSt = { storage: Object.assign({}, okSt.storage, { unlimited: true, quota: 0, total: 20971520 }), runsMeta: okSt.runsMeta };
  const ul = V.storeLine(unlSt);
  ok('unlimitedStorage 后报「不限量」、不报百分比、20MB 也不转黄，悬停说明配额已解除',
    /^20MB\/不限量/.test(ul.value) && !/%/.test(ul.value) && ul.sty === 'ok' && /unlimitedStorage/.test(ul.title), ul);
  ok('正向对照：同一份 20MB 去掉 unlimited 标记就回到 10MB 分母（200% ⇒ 黄）—— 证明上面那条认的是标记本身',
    (function () { const no = { storage: Object.assign({}, okSt.storage, { total: 20971520 }), runsMeta: okSt.runsMeta };
      return /\/10MB（200%）/.test(V.storeLine(no).value) && V.storeLine(no).sty === 'warn'; })(), '');
  const badSt = { storage: Object.assign({}, okSt.storage, { lastErr: 'QUOTA_BYTES quota exceeded', lastErrAt: '2026-10-23T09:00:00.000Z', failed: 2 }), runsMeta: okSt.runsMeta };
  const bl = V.storeLine(badSt);
  ok('最后一次写失败必须红字点名（这次事故就是它被静默吞了）',
    bl.sty === 'bad' && /^写失败：QUOTA_BYTES quota exceeded/.test(bl.value) && /quota/i.test(bl.title), bl);

  eq('sink 没开时库那行说「读不到」，不说「没采到数据」',
    [V.dbLine({ sink: { ok: false, err: 'connection refused' } }).sty, /不是「没采到数据」/.test(V.dbLine({ sink: { ok: false } }).value)], ['warn', true]);
  eq('旧 sink（没有本机库）单独点名要 sink-9', /sink-9/.test(V.dbLine({ sink: { ok: true, sinkVer: 'sink-8' } }).value), true);
  const dbOk = V.dbLine({ sink: { ok: true, db: { available: true, records: 651, snapshots: 210, tweets: 900, userRows: 1200, follows: 33, rewardPoints: 12, bytes: 27262976, maxAt: '2026-10-22T11:22:33.456Z', dbVer: 'db-1', path: 'D:/x/xprobe.db' } } });
  eq('库开着就给逐表行数与体积', [dbOk.sty, /入档 651 条/.test(dbOk.value), /26MB/.test(dbOk.value), /最新 @11:22:33/.test(dbOk.value)], ['ok', true, true, true]);
  eq('正向对照：库打不开判红并带上原因', V.dbLine({ sink: { ok: true, db: { available: false, err: 'unable to open database file' } } }).sty, 'bad');

  ['ysy.xprobe.v1', 'ysy.xprobe.users', 'ysy.xprobe.posts'].forEach((k) => delete store[k]);
}

console.log('\n[8j] v0.6.9：aria 来源三分 / 两张表切片按「有没有数字」分池 / 断线时浮标只翻描边');
{
  // 立项依据（真机 2026-10-23 的 64 行）：38 行的数来自聚合 aria（「42 回复、24 喜欢、400 次观看」），
  // 26 行来自每行独立的一颗单指标 aria（「2 次观看」）。旧版两种都打成 summaryAria ⇒
  // 同一行日志里 cov.viewFromSummary=25/25 与 cov.summaryAria=14/25 互相打架，
  // 把「独立 aria 才是详情页观看数的真来源」这条判据藏掉了。这一段就是钉住这个口径。
  const ariaCell = (id, gs) => h('article', { 'data-testid': 'tweet' }, [
    h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/zz_aria' }, [T('甲'), T(' @zz_aria')])]),
    h('a', { href: '/zz_aria/status/' + id, 'aria-label': '1小时 前' }, [h('time', { datetime: '2026-10-23T01:00:00.00' + id + 'Z' }, [T('1小时')])]),
    h('div', { 'data-testid': 'tweetText' }, [T('正文' + id)]),
  ].concat(gs));
  const single = (aria) => h('div', { role: 'group', 'aria-label': aria }, [h('span', {}, [T(aria.split(' ')[0])])]);
  const ariaRoot = h('div', { lang: 'zh' }, [
    ariaCell('1', [single('122 次观看')]),
    // 反向对照用的排布：单指标组排在聚合组**前面**。旧写法「第一个带数字的组就收工」会在这条上把聚合组挡掉，
    // 留下 88 而丢掉真机里更可信的那一句聚合数
    ariaCell('2', [single('88 次观看'), group(true, { reply: 11, repost: 0, like: 9, view: 122 })]),
  ]);
  const sa = run(ariaRoot, '/zz_aria', 'https://x.com/zz_aria');
  const snA = sa.__xprobe.snapshot();
  const t0 = snA.tweets[0].metrics, t1 = snA.tweets[1].metrics;
  eq('只有单指标组的那行 ⇒ from=singleAria，值取它自己', [t0.view.from, t0.view.num.value], ['singleAria', 122]);
  eq('这行没有聚合 aria ⇒ summaryAria 留空（旧版在这里也算命中）', snA.tweets[0].summaryAria, '');
  eq('单指标组排在前面也输给聚合组（rank 说了算，文档顺序不算）', [t1.view.from, t1.view.num.value], ['combinedAria', 122]);
  ok('带「、」的聚合句才填 summaryAria', /、/.test(snA.tweets[1].summaryAria), snA.tweets[1].summaryAria);
  eq('view 的来源逐行分开计数（这一栏才是「数从哪个节点来」的答案）', snA.cov.src.view, { singleAria: 1, combinedAria: 1 });
  eq('聚合句里没有转帖 ⇒ 转帖只能来自按钮 aria', snA.cov.src.repost, { buttonAria: 1 });
  eq('聚合命中率不再等于 view 命中率（上一版这两个数字同屏自相矛盾）', [snA.cov.summaryAria, snA.cov.view], ['1/2', '2/2']);
  ok('全树里不许再出现旧标签 summaryAria 作为来源',
    snA.tweets.every((t) => Object.keys(t.metrics).every((k) => ['singleAria', 'combinedAria', 'buttonAria'].indexOf(t.metrics[k].from) >= 0)),
    { t0: Object.keys(t0).map((k) => [k, t0[k].from]), t1: Object.keys(t1).map((k) => [k, t1[k].from]) });

  // 切片两组：每次采集都把当前屏所有行的 updatedAt 推到最新 ⇒ 按 updatedAt 切 12 格时，
  // 「纯见过」的新行会不断把带数字的旧行挤出格子（真机 2026-10-23 同一张表：带数行从 7/12 掉到 5/12）
  const sd = run(profile, '/zz_digest', 'https://x.com/zz_digest');
  const U = sd.__xprobe.getUsers(), P = sd.__xprobe.getPosts();
  Object.keys(U).forEach((k) => delete U[k]);
  Object.keys(P).forEach((k) => delete P[k]);
  const nm = Date.now();
  U.zz_old_num = { handle: 'zz_old_num', name: '有数的旧行', relation: 'following', followers: 2690, following: 2754, followersExact: true, own: false, seenAs: { list: 1 },
    hist: [{ at: nm - 7 * 86400000, followers: 2690 }], firstSeenAt: nm - 7 * 86400000, updatedAt: nm - 7 * 86400000 };
  for (let i = 0; i < 14; i++) U['zz_bare' + i] = { handle: 'zz_bare' + i, name: '纯见' + i, relation: '', followers: null, following: null, followersExact: null, own: false, seenAs: { list: 1 },
    hist: [], firstSeenAt: nm - i * 1000, updatedAt: nm - i * 1000 };
  P.zz_num_post = { id: 'zz_num_post', handle: 'zz_aria', text: '有数的旧帖', reply: 3, repost: null, quote: null, like: 24, view: 400, n: 1,
    firstSeenAt: nm - 5 * 86400000, seenAt: nm - 5 * 86400000 };
  for (let i = 0; i < 10; i++) P['zz_bare_p' + i] = { id: 'zz_bare_p' + i, handle: 'zz_aria', text: '纯见帖' + i, reply: null, repost: null, quote: null, like: null, view: null, n: 1,
    firstSeenAt: nm - i * 1000, seenAt: nm - i * 1000 };
  const dg = sd.__xprobe.storeDigest();
  eq('两张表各分成「带数字」「纯见过」两组计数', [dg.groups.uNum, dg.groups.uBare, dg.groups.pNum, dg.groups.pBare], [1, 14, 1, 10]);
  eq('带数字那行排第一并标 sn=1（updatedAt 更旧的也让位）', [dg.users[0].h, dg.users[0].sn, dg.users[0].f], ['zz_old_num', 1, 2690]);
  eq('纯见过的行只占剩下的格子', dg.users.slice(1).every((r) => r.sn === 0), true);
  eq('推文那一组同一条规则（第一个格子是带指标的旧帖）', [dg.posts[0].id, dg.posts[0].sn, dg.posts[0].vw], ['zz_num_post', 1, 400]);
  eq('格子还是 12 / 8 个（分池不改变回传体积）', [dg.users.length, dg.posts.length], [12, 8]);

  // 浮标：日志通道断了以后页面这边原来什么都看不出来。只翻描边，不动文字三态（观/待/限是关注节奏的信号）
  RESP.post = { status: 200, text: '{"ok":true,"stored":1}' };
  const sf = run(profile, '/demo_own', 'https://x.com/demo_own');
  const fb = sf.__xprobe.fabBtn();
  eq('通道正常：绿字「观」+ 灰描边（v0.9.5 绿字在 label span 上；描边换新发丝线）', [fb.textContent, fb.children[0].style.color, fb.style.borderColor], ['观', '#4ec98a', '#242e39']);
  RESP.post = { status: 0, text: '' };
  sf.__xprobe.doCollect({ force: true });
  sf.__xprobe.flush();
  eq('断开事实成立', sf.__xprobe.status().sinkOk, false);
  eq('断开只翻描边：文字三态与绿字都不许被通道状态污染', [fb.textContent, fb.children[0].style.color, fb.style.borderColor], ['观', '#4ec98a', '#e06c60']);
  ok('投影带红圈（页面里一眼看得见，不必开面板）', /rgba\(224,108,96/.test(fb.style.boxShadow), fb.style.boxShadow);
  ok('title 说清「记录在本机排队并落盘，恢复后补发」', /排队并落盘/.test(fb.title), String(fb.title).slice(-70));
  fb.style.color = 'zz-manual';
  sf.__xprobe.fabBtn();
  eq('同一状态再 render 不动 DOM（1.2 秒节拍器每轮都进来，改一次就是一次可观察节奏）', fb.style.color, 'zz-manual');
  fb.style.color = '#4ec98a';
  RESP.post = { status: 200, text: '{"ok":true,"stored":1}' };
  sf.__xprobe.flush();
  eq('恢复后描边回灰，文字仍是「观」', [fb.textContent, fb.style.borderColor], ['观', '#242e39']);

  // v0.8.3 本页曝光榜卡片：profile 页有 122/5 两条带曝光的帖子 + 1 条无指标的推荐卡。
  // 排序、点击滚动定位、无指标行不进榜，全在这份夹具上钉死。行是 div（右下角还要嵌复制钮），按首格 '#N' 认行。
  const cardRowsOf = (card) => card.children.filter((c) => c.children[0] && c.children[0].children[0] && c.children[0].children[0].children[0] && /^#\d+$/.test(c.children[0].children[0].children[0].textContent));
  sf.__xprobe.cardBtn().fire('click');
  const pcard = IDS['ysy-xprobe-ext-card'];
  ok('profile 页开卡：榜上只有带观看数的两条（无指标推荐卡不进榜）', !!pcard && /122/.test(pcard.textContent) && /@demo_own/.test(pcard.textContent), pcard && pcard.textContent.slice(0, 120));
  const prow = (i) => cardRowsOf(pcard)[i];
  ok('榜上两行都带作者与文本与评论数（@demo_own + 正文 + 评）', /@demo_own/.test(prow(0).textContent) && /评 /.test(prow(0).textContent) && /正文/.test(prow(1).textContent), [prow(0).textContent, prow(1).textContent]);
  const art122 = profile.querySelectorAll('article').find((a) => !!a.querySelector('a[href*="/status/2113132810320097514"]'));
  const art5 = profile.querySelectorAll('article').find((a) => !!a.querySelector('a[href*="/status/2113119051287597271"]'));
  eq('正向对照：开卡还没点条目，谁都没被滚过', [art122.__scrolls || 0, art5.__scrolls || 0], [0, 0]);
  prow(0).children[0].fire('click');
  eq('点 #1 主区=滚动到 122 那条的 article（smooth+居中，不导航）', [art122.__scrolls, art122.__scrollOpts && art122.__scrollOpts.block], [1, 'center']);
  eq('没点的那条纹丝不动', art5.__scrolls || 0, 0);
  cardRowsOf(pcard)[1].children[0].fire('click');
  eq('点 #1 再点 #2：各滚各的，滚完卡片还开着（不收起）', [art5.__scrolls, !!IDS['ysy-xprobe-ext-card']], [1, true]);
  // 复制钮：每行右下角一颗，在可点击主区**外**（兄弟节点——「不拦点击」红线禁 stopPropagation，
  // 结构上隔离就不需要拦冒泡）；点了复制正文，且没把主区的滚动点着
  const cpBtn = cardRowsOf(pcard)[0].querySelectorAll('button').find((b) => b.textContent === '复制');
  ok('每行右下角有「复制」钮', !!cpBtn, cardRowsOf(pcard)[0].textContent);
  cpBtn.fire('click');
  eq('点复制=正文进剪贴板（sb.__copied）、滚动次数不变（复制钮不在主区里）', [sf.__copied, art122.__scrolls], [['正文一'], 1]);
  IDS['ysy-xprobe-ext-card'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('profile 页测完收摊', IDS['ysy-xprobe-ext-card'], undefined);

  // v0.8.3-D SPA 换页：URL 一变，旧榜立即作废进「正在重扫」过渡态，2.5 秒重采扫完再出新榜。
  // 节拍器提成具名 spaTick 就是为了这一步能在沙盒里直接调（沙盒的 setInterval 永远不跑）。
  sf.__xprobe.cardBtn().fire('click');
  sf.__xprobe.spaTick();
  eq('正向对照：URL 没变时 spaTick 不清卡（两行还在、无过渡话术）',
    [cardRowsOf(IDS['ysy-xprobe-ext-card']).length, /正在重扫/.test(IDS['ysy-xprobe-ext-card'].textContent)], [2, false]);
  sf.location.href = 'https://x.com/home'; sf.location.pathname = '/home';
  sf.__xprobe.spaTick();
  eq('URL 一变（spaTick）：旧榜立即清空、卡片还开着、显示「正在重扫」过渡态',
    [!!IDS['ysy-xprobe-ext-card'], cardRowsOf(IDS['ysy-xprobe-ext-card']).length,
      /正在重扫/.test(IDS['ysy-xprobe-ext-card'].textContent)], [true, 0, true]);
  sf.__runTimers(1);   // 只放 2.5 秒那颗定时器跑一轮（重采 + 解除过渡态）
  eq('2.5 秒重采跑完：过渡态解除、卡片按现场重扫出新榜（不收起）',
    [!!IDS['ysy-xprobe-ext-card'], /正在重扫/.test(IDS['ysy-xprobe-ext-card'].textContent),
      cardRowsOf(IDS['ysy-xprobe-ext-card']).length], [true, false, 2]);
  IDS['ysy-xprobe-ext-card'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('换页夹具测完收摊', IDS['ysy-xprobe-ext-card'], undefined);

  // v0.8.5 本页用户列表：与卡片同一批 article 抓取点（不另开扫描线）。默认「未关注」页签——
  // 用这名单是为了找人；关系读不到的（article 里没有 follow/unfollow 钮）标「?」如实说，不猜。
  // 位置钉死在 sf 还是最年轻沙箱的窗口里（桩的 getElementById 走全局 IDS 登记簿，后跑的 run() 会覆盖）
  sf.__xprobe.flistBtn().fire('click');
  const pfl = IDS['ysy-xprobe-ext-flist'];
  ok('点「关」=开「本页用户」名单：同一人两条帖子并成一行，未关(1)已关(0)，推荐卡「-」作者不进名单',
    !!pfl && /本页用户/.test(pfl.textContent) && /未关\(1\)/.test(pfl.textContent) && /已关\(0\)/.test(pfl.textContent) && !/@-/.test(pfl.textContent),
    pfl && pfl.textContent.slice(0, 120));
  // v0.11.3（用户口径「表头两列就够了」「只显示昵称」）：表头字面是 已关/未关，行里的名字格是显示名，
  // @handle 整串搬到悬停 title 第一位（所以找人只能按 title 找，不能再按 children[1] 的字面找）。
  const pfrow = pfl.children.find((c) => c.children && c.children[1] && /^@demo_own/.test(String(c.title || '')));
  ok('名单行带关系标记与显示名（读到 -follow 钮 ⇒ 未关注；没读到的不冒充）',
    !!pfrow && /^[·?✓←]/.test(pfrow.children[0].textContent) && /示例笔记/.test(pfrow.children[1].textContent)
    && !/^@/.test(pfrow.children[1].textContent), pfrow && pfrow.textContent);
  ok('名单行里一颗按钮都没有（v0.11.3 去掉行尾「拉黑」「标杆」两列；handle 只在 title 里，不占字面）',
    !!pfrow && pfrow.querySelectorAll('button').length === 0 && /@demo_own/.test(String(pfrow.title || '')),
    pfrow && [pfrow.querySelectorAll('button').length, String(pfrow.title || '').slice(0, 24)]);
  const fBefore = (art122.__scrolls || 0) + (art5.__scrolls || 0);
  pfrow.fire('click');
  eq('点名单行=滚到那个人的帖子（与卡片共用 cardScrollTo；滚完名单还开着）',
    [(art122.__scrolls || 0) + (art5.__scrolls || 0), !!IDS['ysy-xprobe-ext-flist']], [fBefore + 1, true]);
  pfl.querySelectorAll('button').find((b) => /^已关/.test(b.textContent)).fire('click');
  ok('已关页签这页没人：老实说没有（读不到关系的人留在「未关」那一列带「?」，不硬塞）',
    /没有读到「已关注」/.test(IDS['ysy-xprobe-ext-flist'].textContent), IDS['ysy-xprobe-ext-flist'].textContent.slice(0, 100));
  IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('名单测完收摊（整棵摘掉，常驻注入还是四颗钮）',
    [IDS['ysy-xprobe-ext-flist'], !!IDS['ysy-xprobe-ext-fbtn']], [undefined, true]);

  // v0.8.4 拉黑：User-Name 旁一颗「拉黑」，点了记进 GM 存储 + 发 kind=block 记录（落库 blocks 表）；
  // 已拉黑的再点一下 = 取消。徽标缝在名字锚**后面**（不是锚里）——点它绝不触发导航。
  // v0.8.9 起这颗默认不缝了（改从自家名单行尾按），所以这一段先替用户把闸拨到「开」，
  // 测的是「开着时」的老行为；「默认关 = 页面零注入」由 [18] 单独钉。
  store['ysy.xprobe.badge'] = true;
  sf.__xprobe.renderBlocks();
  const blkBadges = () => profile.querySelectorAll('[data-xprobe="blk"]');
  eq('开页就有拉黑钮：两个带作者头的帖子各一颗（无作者推荐卡、UserName 头部都不碰）', blkBadges().length, 2);
  const bbtn = blkBadges()[0].children[0];
  eq('未拉黑时钮是灰「拉黑」，缝在名字锚后面（兄弟节点）',
    [bbtn.textContent, blkBadges()[0].previousSibling.tag], ['拉黑', 'a']);
  bbtn.fire('click');
  const bstore = () => { const v = store['ysy.xprobe.blocked'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };
  eq('点拉黑：徽标当场翻红「已拉黑」，名单进 GM 存储（demo_own，小写归一）',
    [bbtn.textContent, Object.keys(bstore())], ['已拉黑', ['demo_own']]);
  bbtn.fire('click');
  eq('再点「已拉黑」=取消：徽标回灰「拉黑」，名单里没人了（取消也要发记录，库按最新一条判）',
    [bbtn.textContent, Object.keys(bstore()).length], ['拉黑', 0]);
  store['ysy.xprobe.blocked'] = { demo_own: { at: '2026-10-26T00:00:00.000Z', n: '示例笔记' } };
  const sb2b = run(profile, '/demo_own', 'https://x.com/demo_own');
  sb2b.__xprobe.renderBlocks();
  eq('下次开页名单还在：demo_own 的徽标直接是红「已拉黑」（这就是「以后页面显示会提示已拉黑」）',
    profile.querySelectorAll('[data-xprobe="blk"]')[0].children[0].textContent, '已拉黑');
  eq('同一作者的两颗一起翻红（名单按 handle 记账，同 handle 同状态）',
    profile.querySelectorAll('[data-xprobe="blk"]')[1].children[0].textContent, '已拉黑');
  // 名单只认 handle 不连坐：同页异 handle 的钮不跟风
  const sb2c = run(h('div', {}, [
    tweetCell('a', '9101', '2026-10-26T01:00:00.000Z', '甲帖'),
    tweetCell('demo_own', '9102', '2026-10-26T02:00:00.000Z', '乙帖'),
  ]), '/home', 'https://x.com/home');
  sb2c.__xprobe.renderBlocks();
  const mix = sb2c.document.querySelectorAll('[data-xprobe="blk"]');
  eq('名单只认 handle 不连坐：a 的钮还是「拉黑」，demo_own 的翻红',
    [mix[0].children[0].textContent, mix[1].children[0].textContent], ['拉黑', '已拉黑']);
  delete store['ysy.xprobe.blocked'];
  store['ysy.xprobe.badge'] = false;   // v0.8.16 起「没拨过」= 开 ⇒ 这里要显式拨回关：后面几段测的是名单/关系，不该有徽标缝进页面

  // 排序必须真按曝光来：home 夹具文档序是「900 那条」在前——但它的 role=group 聚合 aria 写死是
  // REAL_SUMMARY（122 次观看），聚合来源盖过单指标 ⇒ 卡片读到的两条是 1500 与 122。降序榜 #1 必须是 1500。
  const sh = run(homeFixture, '/home', 'https://x.com/home');
  sh.__xprobe.cardBtn().fire('click');
  const hcard = IDS['ysy-xprobe-ext-card'];
  const hrows = cardRowsOf(hcard);
  eq('曝光降序是真的（文档序 122 那条在前：#1 仍必须是 1500 那条）',
    [hrows.length, hrows[0].textContent.indexOf('1500') >= 0, hrows[1].textContent.indexOf('122') >= 0], [2, true, true]);
  IDS['ysy-xprobe-ext-card'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('home 页测完收摊', IDS['ysy-xprobe-ext-card'], undefined);

  // 曝光/评论切换：专造一份「曝光序 ≠ 评论序」的夹具（甲帖 100 曝光 1 评，乙帖 50 曝光 99 评）。
  // 用 group(false)（纯单指标 aria）——group(true) 的聚合句写死 REAL_SUMMARY，会把两行的数都盖成 122/11。
  const sr = run(h('div', {}, [
    tweetCell('a', '9001', '2026-10-26T01:00:00.000Z', '甲帖', { group: group(false, { reply: 1, repost: 0, like: 0, view: 100 }) }),
    tweetCell('b', '9002', '2026-10-26T02:00:00.000Z', '乙帖', { group: group(false, { reply: 99, repost: 0, like: 0, view: 50 }) }),
  ]), '/home', 'https://x.com/home');
  sr.__xprobe.cardBtn().fire('click');
  const scard = IDS['ysy-xprobe-ext-card'];
  const srows = () => cardRowsOf(IDS['ysy-xprobe-ext-card']);
  eq('默认曝光降序：100 的甲帖在前', [srows().length, srows()[0].textContent.indexOf('甲帖') >= 0, srows()[1].textContent.indexOf('乙帖') >= 0], [2, true, true]);
  IDS['ysy-xprobe-ext-card'].querySelectorAll('button').find((b) => b.textContent === '评论').fire('click');
  eq('点「评论」换序：99 评的乙帖顶到 #1（两行还是同一抓取点的两列，不混批）',
    [srows()[0].textContent.indexOf('乙帖') >= 0, srows()[0].textContent.indexOf('评 99') >= 0, srows()[1].textContent.indexOf('甲帖') >= 0], [true, true, true]);
  IDS['ysy-xprobe-ext-card'].querySelectorAll('button').find((b) => b.textContent === '曝光').fire('click');
  eq('点回「曝光」：甲帖回 #1', srows()[0].textContent.indexOf('甲帖') >= 0, true);
  IDS['ysy-xprobe-ext-card'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('排序夹具测完收摊', IDS['ysy-xprobe-ext-card'], undefined);

  // 关系三种形态各一个：-unfollow=已关注、没钮=没读到（?）、-follow=未关注。名单照实分页签，不猜。
  const sm = run(h('div', {}, [
    tweetCell('a', '9201', '2026-10-26T01:00:00.000Z', '甲帖', { followTestid: '111222333-unfollow' }),
    tweetCell('b', '9202', '2026-10-26T02:00:00.000Z', '乙帖'),
    tweetCell('c', '9203', '2026-10-26T03:00:00.000Z', '丙帖', { followTestid: '444555666-follow' }),
  ]), '/home', 'https://x.com/home');
  sm.__xprobe.flistBtn().fire('click');
  const mfl = IDS['ysy-xprobe-ext-flist'];
  eq('三个作者三行：已关(1) 未关(2)，页签数是真的数出来的（v0.11.3 表头两列：已关/未关）',
    [/已关\(1\)/.test(mfl.textContent), /未关\(2\)/.test(mfl.textContent)], [true, true]);
  // v0.11.3「只显示昵称」：行里的名字格是显示名，@handle 整串搬进悬停 title 第一位 ⇒ 认人一律按 title 认。
  const mrows = mfl.children.filter((c) => c.children && /^@[abc]\b/.test(String(c.title || '')));
  eq('默认未关页签：b 带「?」（关系没读到）、c 带「·」，a 不在（✓ 的人在已关页签）；这一格画的是显示名不是 handle',
    [mrows.length, mrows[0].children[0].textContent, mrows[1].children[0].textContent,
      mrows.map((r) => String(r.title).slice(1, 2)), mrows[0].children[1].textContent],
    [2, '?', '·', ['b', 'c'], '示例笔记']);
  mfl.querySelectorAll('button').find((b) => /^已关/.test(b.textContent)).fire('click');
  const mrows2 = IDS['ysy-xprobe-ext-flist'].children.filter((c) => c.children && /^@[abc]\b/.test(String(c.title || '')));
  eq('切到已关页签：只有 a，标记 ✓（-unfollow 钮 = 现在已关注）',
    [mrows2.length, mrows2[0].children[0].textContent, String(mrows2[0].title).slice(1, 2)], [1, '✓', 'a']);
  IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('关系夹具测完收摊', IDS['ysy-xprobe-ext-flist'], undefined);

  // 高度与拖动：面板锚在钮排上方（bottom 由 flistBottomPx 给：334 基准 + 变大那截 + 第五颗那一格），高度上限必须扣掉同一截底距——第一版写 60vh，
  // 屏幕一矮头部（标题/页签）被顶出屏幕外（用户现场：只看得见名单、看不见上面）。头部标题可按住拖动。
  sm.__xprobe.flistBtn().fire('click');
  const dfl = IDS['ysy-xprobe-ext-flist'];
  eq('默认锚在钮排上方（334 是四颗 34px 时校准的基准，浮标实测变大就按「大出来那截 ×5」让位，v0.9.0/v0.9.3 再各加窗口那一颗的一格），高度上限跟着扣同一截底距',
    [dfl.style.right, dfl.style.bottom, dfl.style.maxHeight],
    ['14px', sm.__xprobe.flistBottomPx() + 'px', 'calc(100vh - ' + (sm.__xprobe.flistBottomPx() + 20) + 'px)']);
  eq('正向对照：这一份沙箱没量到 X 的右缘列 ⇒ 直径还是基准 34、底距还是 334 + 窗口那两颗各一格（34+6）×2（334 这个常量没被悄悄改掉）',
    [sm.__xprobe.fabStat().px, sm.__xprobe.fabStat().src, sm.__xprobe.flistBottomPx()], [34, 'base', 414]);
  const grip = dfl.children[0].children[0];
  eq('头部「本页用户」是拖动手柄（cursor:move + title 说明）', [grip.textContent, grip.style.cursor], ['本页用户', 'move']);
  grip.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
  (sm.document.listeners['mousemove'] || []).forEach((f) => f({ clientX: 60, clientY: 80 }));
  eq('按住拖（左移40/上移20）= right+40 / bottom+20（右/底坐标系与屏幕方向相反）',
    [dfl.style.right, dfl.style.bottom], ['54px', sm.__xprobe.flistBottomPx() + 20 + 'px']);
  (sm.document.listeners['mouseup'] || []).forEach((f) => f({}));
  const dpos = [dfl.style.right, dfl.style.bottom];
  (sm.document.listeners['mousemove'] || []).forEach((f) => f({ clientX: 0, clientY: 0 }));
  eq('mouseup 后监听已摘：再动鼠标位置不动', [dfl.style.right, dfl.style.bottom], dpos);
  sm.__xprobe.flistBtn().fire('click');
  sm.__xprobe.flistBtn().fire('click');
  eq('重画后拖过去的位置还在（flistPos 记账，不弹回默认位；换页重画走同一条路）',
    [IDS['ysy-xprobe-ext-flist'].style.right, IDS['ysy-xprobe-ext-flist'].style.bottom], dpos);
  IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('拖动夹具测完收摊', IDS['ysy-xprobe-ext-flist'], undefined);

  // v0.8.5 补四 库回填：详情页评论行 X 不渲染关系钮（dump 实锤：整页只有主帖作者一颗 -unfollow，
  // 还挂在右栏作者卡里），名单全落「?」。页面没说的、本机库说了就算：users.relation=following 回填 ✓
  // 但标蓝（#6ea8dc）注明「库记的，可能过时」；页面按钮读到的永远优先（绿✓），库不许翻案。
  store['ysy.xprobe.users'] = { q: { handle: 'q', name: '乙', relation: 'following', updatedAt: 1 } };
  const sb4 = run(h('div', {}, [
    tweetCell('p', '9301', '2026-10-26T01:00:00.000Z', '甲帖', { followTestid: '930111-unfollow' }),
    tweetCell('q', '9302', '2026-10-26T02:00:00.000Z', '乙帖'),
    tweetCell('r', '9303', '2026-10-26T03:00:00.000Z', '丙帖'),
  ]), '/home', 'https://x.com/home');
  sb4.__xprobe.flistBtn().fire('click');
  let bfl = IDS['ysy-xprobe-ext-flist'];
  eq('库回填后页签数：已关(2)=页面钮1+库1，未关(1)=只剩库里也没有的',
    [/已关\(2\)/.test(bfl.textContent), /未关\(1\)/.test(bfl.textContent)], [true, true]);
  bfl.querySelectorAll('button').find((b) => /^已关/.test(b.textContent)).fire('click');
  bfl = IDS['ysy-xprobe-ext-flist'];
  const brows = bfl.children.filter((c) => c.children && /^@[pqr]\b/.test(String(c.title || '')));
  eq('已关注页签两行：p 绿✓（页面 -unfollow 钮说了算）、q 蓝✓（库回填）',
    [brows.length, brows[0].children[0].textContent, brows[0].children[0].style.color,
      brows[1].children[0].textContent, brows[1].children[0].style.color], [2, '✓', '#4ec98a', '✓', '#6cb2e0']);
  ok('蓝✓行的悬浮说明写明出处（库记的、可能过时、这页没渲染钮），绿✓行没这句',
    /本机库记的/.test(brows[1].title) && /可能过时/.test(brows[1].title) && !/本机库记的/.test(brows[0].title),
    [brows[0].title, brows[1].title]);
  bfl.querySelectorAll('button').find((b) => /^未关/.test(b.textContent)).fire('click');
  bfl = IDS['ysy-xprobe-ext-flist'];
  const brows2 = bfl.children.filter((c) => c.children && /^@r\b/.test(String(c.title || '')));
  eq('未关页签只剩 r：库也没记到 following，老实带「?」不冒充',
    [brows2.length, brows2[0].children[0].textContent], [1, '?']);
  ok('底注图例带蓝✓说明（v0.11.14：库/桥两路都算蓝✓）', /蓝✓=库\/桥记的/.test(bfl.textContent), bfl.textContent.slice(-120));
  IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('库回填夹具测完收摊', IDS['ysy-xprobe-ext-flist'], undefined);

  // v0.8.5 补五：关注/粉丝列表页（/verified_followers 等）——行是 UserCell，行里没有 User-Name 节点
  // （v0.6.2 真机 31 行 name 0/31 的同一条实锤），旧 renderBlocks 只认 User-Name ⇒ 列表页一颗拉黑钮都没有。
  const lrow = (handle, kind, nameTxt) => h('div', { 'data-testid': 'UserCell' }, [
    h('a', { href: '/' + handle }, [T('@' + handle)]),
    h('span', {}, [T(nameTxt || '')]),
    h('button', { 'data-testid': kind === 'unfollow' ? '556-unfollow' : '555-follow', 'aria-label': (kind === 'unfollow' ? '正在关注 @' : '关注 @') + handle }, [T(kind === 'unfollow' ? '正在关注' : '关注')]),
  ]);
  store['ysy.xprobe.badge'] = true;   // v0.8.9：这一段同样测「闸开着」的列表页缝法（默认值本身见 [18]，v0.8.16 起是开）
  const lcA = lrow('lc_a', 'follow', '列表甲');
  const lcB = lrow('lc_b', null, '列表乙');
  const lb1 = run(h('div', { 'data-testid': 'primaryColumn' }, [lcA, lcB]),
    '/benben2052243/verified_followers', 'https://x.com/benben2052243/verified_followers');
  // 真机列表行是 justify-content:space-between 的两段式：左边「显示名 / @handle」两行、右边一颗关注钮，
  // 中间那一大片才是能放东西的空白。桩默认按 8px 间距把 [a][span][button] 挤成一条（整行没有任何缝），
  // 拿它测「找空白」只会永远测出「放不下」——所以这里照真机形状覆写几何（handle 行 60..180，关注钮 470 起）。
  const lgeo = (row, i) => {
    const kids = row.children;                       // [a, span, button]
    row.__geo = { left: 0, top: i * 56, width: 600, height: 48 };
    kids[0].__geo = { left: 60, top: i * 56 + 24, width: 120, height: 18 };   // @handle 锚（参照物）
    kids[1].__geo = { left: 60, top: i * 56 + 2, width: 120, height: 18 };    // 显示名：在上一行，不压着 handle
    if (kids[2]) kids[2].__geo = { left: 470, top: i * 56 + 8, width: 120, height: 32 };
  };
  lgeo(lcA, 0); lgeo(lcB, 1);
  lb1.__xprobe.renderBlocks(true);
  const lbadges = () => lb1.document.querySelectorAll('[data-xprobe="blk"]');
  eq('列表页 UserCell 行没有 User-Name 节点：拉黑钮照样缝进两行（handle 右边那片空白）', lbadges().length, 2);
  ok('徽标不落进 <a> 里、也不占位：宿主是行容器 + position:absolute（点它绝不触发导航，那一行的宽高一个字没改）',
    lbadges()[0].parentNode.getAttribute('data-testid') === 'UserCell'
    && lbadges()[0].style.position === 'absolute' && lbadges()[0].style.display === 'block',
    [lbadges()[0].parentNode.getAttribute('data-testid'), lbadges()[0].style.position]);
  eq('徽标压在空白里、不盖关注钮：整颗右缘 ≤ 钮左缘（吃掉那一次点击就是影响页面）',
    Number(String(lbadges()[0].style.left).replace('px', '')) + 46 <= 470, true);
  lbadges()[0].children[0].fire('click');
  const lstore = () => { const v = store['ysy.xprobe.blocked'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };
  eq('列表行点拉黑：当场翻红并记进名单（lc_a，小写归一）',
    [lbadges()[0].children[0].textContent, Object.keys(lstore())], ['已拉黑', ['lc_a']]);
  lbadges()[0].children[0].fire('click');
  eq('再点取消：回灰、名单清空（与帖子页同一套 blockToggle）', [lbadges()[0].children[0].textContent, Object.keys(lstore()).length], ['拉黑', 0]);
  delete store['ysy.xprobe.blocked'];
  store['ysy.xprobe.badge'] = false;   // 显式拨回关（默认已是开）：下面的列表页名单/待回关测的是自家面板，不该往页面缝东西

  // 列表页的名单：行不是 article（整页 0 张）⇒ flistRows 改吃 collectUsers 的正文列行——
  // 行上本来就渲染着 follow/unfollow 钮，关系直接可读（详情页评论行得不到的待遇），侧栏推荐位行不混入
  const lb2 = run(h('div', {}, [
    h('div', { 'data-testid': 'primaryColumn' }, [lrow('ld_a', 'unfollow', '列表一'), lrow('ld_b', 'follow', '列表二')]),
    h('div', { 'data-testid': 'sidebarColumn' }, [lrow('ld_side', 'follow', '推荐位')]),
  ]), '/benben2052243/verified_followers', 'https://x.com/benben2052243/verified_followers');
  lb2.__xprobe.flistBtn().fire('click');
  const lfl = IDS['ysy-xprobe-ext-flist'];
  eq('列表页名单吃 UserCell 行：已关(1) 未关(1)，handle/关系来自行上的钮',
    [/已关\(1\)/.test(lfl.textContent), /未关\(1\)/.test(lfl.textContent),
      /@ld_b/.test(lfl.textContent)], [true, true, true]);
  // v0.11.3：名单那一格只显示名（列表页的 UserCell 行读不到显示名 ⇒ 退成 @handle），
  // 整串 handle 搬进悬停 title 第一位 ⇒ 认行一律走 title，不再拿 children[1] 的字面当 handle。
  const lrowOf = (fl, hh) => fl.children.filter((c) => c.children && new RegExp('^@' + hh + '\\b').test(String(c.title || '')));
  lfl.querySelectorAll('button').find((b) => /^未关/.test(b.textContent)).fire('click');
  const lfl1 = IDS['ysy-xprobe-ext-flist'];
  ok('未关注页签只显示 ld_b（带「·」= 这页读到 -follow 钮、确实没关注）；ld_a（已关）在另一个页签里',
    lrowOf(lfl1, 'ld_b').length === 1 && lrowOf(lfl1, 'ld_b')[0].children[0].textContent === '·'
    && lrowOf(lfl1, 'ld_a').length === 0 && lrowOf(lfl1, 'ld_side').length === 0,
    lfl1.textContent.slice(0, 150));
  lfl1.querySelectorAll('button').find((b) => /^已关/.test(b.textContent)).fire('click');
  const lfl2 = IDS['ysy-xprobe-ext-flist'];
  const larow = lrowOf(lfl2, 'ld_a');
  eq('切到已关页签：ld_a 带 ✓（行上 -unfollow 钮直接可读，详情页评论行的待遇这里天生就有）',
    [larow.length, larow[0].children[0].textContent, larow[0].children[0].style.color], [1, '✓', '#4ec98a']);
  ok('侧栏推荐位行不混进名单（origin=list 只认正文列）',
    lrowOf(lfl2, 'ld_side').length === 0 && !/ld_side/.test(lfl2.textContent), lfl2.textContent.slice(0, 150));
  IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('列表页名单测完收摊', IDS['ysy-xprobe-ext-flist'], undefined);

  // 待回关（用户点名「多一个按钮，专门 tab，待回关个数，去掉黑名单」）：
  // 全库口径 = users.seenAs.followers（TA 出现在我的粉丝列表）&& relation!=='following'（我没回关）&& 未拉黑
  store['ysy.xprobe.users'] = {
    fb_a: { handle: 'fb_a', name: '待回一', relation: '', seenAs: { followers: '2026-10-25T00:00:00.000Z' }, updatedAt: 5 },
    fb_b: { handle: 'fb_b', name: '待回二', relation: 'not_following', seenAs: { followers: '2026-10-24T00:00:00.000Z' }, updatedAt: 9 },
    fb_mut: { handle: 'fb_mut', name: '互关', relation: 'following', seenAs: { followers: '2026-10-23T00:00:00.000Z' }, updatedAt: 8 },
    fb_only: { handle: 'fb_only', name: '只在我关注里', relation: '', seenAs: { following: '2026-10-22T00:00:00.000Z' }, updatedAt: 7 },
    fb_blk: { handle: 'fb_blk', name: '已拉黑的', relation: '', seenAs: { followers: '2026-10-21T00:00:00.000Z' }, updatedAt: 6 },
  };
  store['ysy.xprobe.blocked'] = { fb_blk: { at: '2026-10-26T00:00:00.000Z', n: '已拉黑的' } };
  const lb3 = run(h('div', {}, []), '/home', 'https://x.com/home');
  eq('「回」钮带着待回关个数（已回关 mut / 只在我关注里的 fb_only / 已拉黑 fb_blk 都不算）',
    IDS['ysy-xprobe-ext-rbtn'].textContent, '回2');
  IDS['ysy-xprobe-ext-rbtn'].fire('click');
  const fbr = IDS['ysy-xprobe-ext-flist'];
  const fbrows = fbr.children.filter((c) => c.children && /^@fb_/.test(String(c.title || '')));
  eq('点「回」=名单开在「未关」列的待回关筛选：2 行全是「←」，最近看到的在前（fb_b updatedAt 9 > fb_a 5）',
    [/待回\(2\)/.test(fbr.textContent), fbrows.length, fbrows[0].children[0].textContent, fbrows[1].children[0].textContent,
      fbrows[0].children[0].style.color, fbrows.map((r) => String(r.title || '').split(' ')[0])],
    [true, 2, '←', '←', '#e0a34c', ['@fb_b', '@fb_a']]);
  eq('这一格画的是台账里的显示名（v0.11.3「只显示昵称」），不是 handle',
    fbrows.map((r) => r.children[1].textContent), ['待回二', '待回一']);
  ok('「回」钮开着名单也不打架：筛选计数与行数一致，黑名单/已回关/只在我关注里的都不在行里',
    !/(^|\D)fb_blk\b/.test(fbrows.map((r) => r.title).join('|')) && !/fb_mut/.test(fbrows.map((r) => r.title).join('|'))
    && !/fb_only/.test(fbrows.map((r) => r.title).join('|')) && !/已拉黑的|互关|只在我关注里/.test(fbr.textContent),
    fbr.textContent.slice(0, 200));
  IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('待回关夹具测完收摊', IDS['ysy-xprobe-ext-flist'], undefined);
  delete store['ysy.xprobe.blocked'];
  ['ysy.xprobe.v1', 'ysy.xprobe.users', 'ysy.xprobe.posts', sf.__xprobe.queueKey()].forEach((k) => delete store[k]);

  // v0.11.14 名单自动刷新：开着就跟着页面走（指纹没变不重画；变了重画保 scrollTop）；
  // 行状态走 flistRelOf（钮 > 桥 > 台账），桥带回的读数当场进名单与待回账。
  {
    const root14 = h('div', {}, [
      tweetCell('ua', '9401', '2026-10-26T01:00:00.000Z', '甲帖', { followTestid: '940111-unfollow' }),
      tweetCell('ub', '9402', '2026-10-26T02:00:00.000Z', '乙帖'),
    ]);
    store['ysy.xprobe.users'] = {};
    const s14 = run(root14, '/home', 'https://x.com/home');
    s14.__xprobe.flistBtn().fire('click');
    const f0 = IDS['ysy-xprobe-ext-flist'];
    f0.scrollTop = 40;   // 用户把名单滚到第几行，这件事归用户
    const n0 = s14.__xprobe.__flistSig();
    s14.__xprobe.flistTick();
    eq('指纹没变 ⇒ 节拍不重画（同一棵 DOM，一根手指都不动）',
      [IDS['ysy-xprobe-ext-flist'] === f0, s14.__xprobe.__flistSig() === n0], [true, true]);
    // 画面变了（虚拟列表挂上新帖作者）：指纹一变就重画，滚动位置原样还在
    root14.appendChild(tweetCell('uc', '9403', '2026-10-26T03:00:00.000Z', '丙帖'));
    s14.__xprobe.flistTick();
    const f1 = IDS['ysy-xprobe-ext-flist'];
    eq('画面挂上新作者 ⇒ 重画：未关(2)、scrollTop 原样还在（自动刷新不把用户滚到的地方抹掉）',
      [f1 !== f0, /未关\(2\)/.test(f1.textContent), f1.scrollTop], [true, true, 40]);
    // 桥推送到达：ub 的读数（following/followed_by）当场进名单 —— 这行没有关系钮、台账也没记
    eq('relFiberMerge 回「真变了账」的条数', s14.__xprobe.relFiberMerge({ ub: { following: true, followsYou: true } }), 1);
    s14.__xprobe.flistTick();
    const f2 = IDS['ysy-xprobe-ext-flist'];
    eq('桥读数进名单：已关(2)=页面钮1+桥1，未关(1)',
      [/已关\(2\)/.test(f2.textContent), /未关\(1\)/.test(f2.textContent)], [true, true]);
    f2.querySelectorAll('button').find((b) => /^已关/.test(b.textContent)).fire('click');
    const f2b = IDS['ysy-xprobe-ext-flist'];
    const rows2 = f2b.children.filter((c) => c.children && /^@u[ab]\b/.test(String(c.title || '')));
    const rowUa = rows2.filter((r) => /^@ua\b/.test(String(r.title)))[0];
    const rowUb2 = rows2.filter((r) => /^@ub\b/.test(String(r.title)))[0];
    eq('已关页签两行：ua 绿✓（页面钮说了算）、ub 蓝✓（桥，X 回包读数）',
      [rows2.length, rowUa.children[0].style.color, rowUb2.children[0].style.color,
        /X 回包当场带回/.test(rowUb2.title), !/X 回包当场带回/.test(rowUa.title)],
      [2, '#4ec98a', '#6cb2e0', true, true]);
    // 桥带回 followed_by=true、台账还没记粉丝列表的人也进待回账（「标签说 TA 关注你、名单里查无此人」的缝）
    s14.__xprobe.relFiberMerge({ ud: { following: false, followsYou: true } });
    s14.__xprobe.fabBtn();
    eq('桥带回 followed_by=true 的人进「回」的待回账（台账没记粉丝列表也算）',
      IDS['ysy-xprobe-ext-rbtn'].textContent, '回1');
    IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
    eq('v0.11.14 夹具测完收摊', IDS['ysy-xprobe-ext-flist'], undefined);
    delete store['ysy.xprobe.users'];
    ['ysy.xprobe.v1', 'ysy.xprobe.posts', s14.__xprobe.queueKey()].forEach((k) => delete store[k]);
  }
}

console.log('\n[8k] v0.7.0：已点赞读数 / 时间线徽标与按钮翻转写关系 / 被动补采（5 秒频控 + 数变了才留点）');
{
  delete store['ysy.xprobe.users'];
  delete store['ysy.xprobe.posts'];
  delete store['ysy.xprobe.v1'];

  // ---- 1) liked：X 用 data-testid="unlike" 表示「这条我已经赞过」。
  // 只读属性，不点击；两样都没有 = 判断不了 ⇒ null（把「没看到按钮」说成「没赞」会让推荐卡片混进互动口径）
  const likeCell = (id, testid) => h('article', { 'data-testid': 'tweet' }, [
    h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/zz_like' }, [T('甲'), T(' @zz_like')])]),
    h('a', { href: '/zz_like/status/' + id }, [h('time', { datetime: '2026-10-24T01:00:00.000Z' }, [T('1小时')])]),
    h('div', { 'data-testid': 'tweetText' }, [T('正文' + id)]),
  ].concat(testid ? [h('button', { 'data-testid': testid, 'aria-label': '喜欢' }, [])] : []));
  const sL = run(h('div', { lang: 'zh' }, [likeCell('1', 'unlike'), likeCell('2', 'like'), likeCell('3', '')]), '/zz_like', 'https://x.com/zz_like');
  const xL = sL.__xprobe;
  eq('unlike=已赞 / like=未赞 / 没有按钮=null（不拿 false 冒充读数）',
    xL.snapshot().tweets.map((t) => [t.liked, t.likeTestid]), [[true, 'unlike'], [false, 'like'], [null, '']]);

  // ---- 2) 时间线徽标是关系的第三条腿（另外两条：列表页、主页头部）。
  // 空串必须无视：一屏陌生人全被写成 not_following，「最该关注」那张榜就全是噪声
  const relSnap = { tab: 'home', identity: {}, stats: {}, users: [], tweets: [
    { tweetId: 'r1', author: 'zz_rel_a', followState: 'following' },
    { tweetId: 'r2', author: 'zz_rel_b', followState: 'not_following' },
    { tweetId: 'r3', author: 'zz_rel_c', followState: '' },
  ] };
  xL.upsertStores(relSnap);
  const U = xL.getUsers();
  eq('徽标「正在关注 / 未关注」直接落进 users 表', [U.zz_rel_a.relation, U.zz_rel_b.relation], ['following', 'not_following']);
  ok('徽标缺失（空串）不落表 —— 不能把「X 没给态」当成未关注', U.zz_rel_c === undefined, U.zz_rel_c && U.zz_rel_c.relation);

  // ---- 3) 按钮翻转即时写关系：以前 users 表要等下一次采集，刚点完关注广场上还显示未关注
  const sF = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xF = sF.__xprobe;
  xF.flush();
  // 这一行已经在表里（时间线采集见过）⇒ 基线扫到按钮只修关系值，不新造行
  xF.upsertStores({ tab: 'home', identity: {}, stats: {}, users: [], tweets: [{ tweetId: 'f0', author: 'zz_flip', followState: 'following' }] });
  const bNew = h('button', { 'data-testid': '424242-follow', 'aria-label': '关注 @zz_flip' }, [T('关注')]);
  sF.__fireMo([{ type: 'childList', addedNodes: [bNew], removedNodes: [] }]);
  sF.__runTimers(2);
  eq('已有行：基线只对齐关系（不算关注动作），也不重复发流水',
    [xF.getUsers().zz_flip.relation, postedRecords(sF).filter((r) => r.kind === 'follow').length], ['not_following', 0]);
  bNew.attrs['data-testid'] = '424242-unfollow';
  bNew.attrs['aria-label'] = '正在关注 @zz_flip';
  sF.__fireMo([{ type: 'attributes', target: bNew }]);
  xF.flush();
  eq('翻成「正在关注」⇒ users 表关系当帧同步（不等下一轮采集）', xF.getUsers().zz_flip.relation, 'following');
  eq('对账口径没变：翻转仍记且只记一条 follow 流水', postedRecords(sF).filter((r) => r.kind === 'follow').length, 1);
  // 反向对照：表里没有的人，按钮（含推荐位/侧栏）怎么扫都不许凭空造行 ——
  // 新面孔只能由采集那一侧入表，否则「最该关注」全是噪声行。流水那一路照记，证据不丢
  const bFresh = h('button', { 'data-testid': '515151-follow', 'aria-label': '关注 @zz_fresh' }, [T('关注')]);
  sF.__fireMo([{ type: 'childList', addedNodes: [bFresh], removedNodes: [] }]);
  bFresh.attrs['data-testid'] = '515151-unfollow';
  bFresh.attrs['aria-label'] = '正在关注 @zz_fresh';
  sF.__fireMo([{ type: 'attributes', target: bFresh }]);
  xF.flush();
  eq('表外的人：按钮基线/翻转都不造行，但 follow 流水照记',
    [xF.getUsers().zz_fresh, postedRecords(sF).filter((r) => r.kind === 'follow').length], [undefined, 2]);

  // ---- 4) 被动补采：不点按钮、不刷新，也要给增速留第二个点。
  // 只在「新卡片挂上来 / 计数被换掉 / 点赞态翻转」时触发，5 秒内最多一枪，且数没变就不发。
  const liveArt = (view) => h('article', { 'data-testid': 'tweet' }, [
    h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/zz_pass' }, [T('甲'), T(' @zz_pass')])]),
    h('a', { href: '/zz_pass/status/9001' }, [h('time', { datetime: '2026-10-24T01:00:00.000Z' }, [T('1小时')])]),
    h('div', { 'data-testid': 'tweetText' }, [T('被动样本')]),
    h('div', { role: 'group' }, [
      h('button', { 'data-testid': 'like', 'aria-label': '3 喜欢次数。喜欢' }, [T('3')]),
      h('a', { href: '#', 'aria-label': view + ' 次查看。查看帖子分析' }, [T(String(view))]),
    ]),
  ]);
  const liveRoot = h('div', { lang: 'zh' }, [liveArt(100)]);
  delete store['ysy.xprobe.v1'];
  const sP = run(liveRoot, '/zz_pass', 'https://x.com/zz_pass');
  const xP = sP.__xprobe;
  const bi = sP.__timers.findIndex((t) => t.ms === 2500);
  if (bi >= 0) sP.__timers.splice(bi, 1);   // 首屏 2.5s 自动采集这一枪先不跑：这一段只验被动那一枪
  sP.__runTimers(1);                        // boot 的 beacon 冲出去，flush 标志归零
  const pages = () => postedRecords(sP).filter((r) => r.kind === 'page');
  const runs0 = xP.loadRuns().length;
  const likeBtn = liveRoot.querySelector('[data-testid="like"]');
  const viewA = liveRoot.querySelector('[aria-label*="次查看"]');
  const passiveTimers = () => sP.__timers.filter((t) => t.ms >= 4500 && t.ms <= 5000);

  sP.__fireMo([{ type: 'attributes', target: likeBtn }]);
  sP.__fireMo([{ type: 'attributes', target: likeBtn }]);
  eq('刚起页第一次触发立刻采（不让第一个点白等 5 秒），连投两条仍只排一枪',
    [sP.__timers.length, sP.__timers[0] && sP.__timers[0].ms], [1, 0]);
  sP.__runTimers(4);
  const p1 = pages();
  eq('被动那一枪自动留点，并带触发原因（auto=liked）', [p1.length, p1[0] && p1[0].auto], [1, 'liked']);
  eq('被动补采不进 runs（60 格环不能被 5 秒一枪挤掉）', xP.loadRuns().length, runs0);
  eq('被动那一枪没污染 45 秒去重账：紧接着手动采集不算重复', xP.doCollect().dup, false);
  eq('正向对照：再采一次就按 45 秒口径判重复（证明上一条不是空断言）', xP.doCollect().dup, true);

  sP.__fireMo([{ type: 'childList', target: likeBtn, addedNodes: [h('span')] }]);
  eq('刚采过再触发 ⇒ 这一枪排到 5 秒后（X 一秒能换几十个节点，不频控就是每帧一采）', passiveTimers().length, 1);
  sP.__runTimers(4);
  xP.flush();
  const p2n = pages().length;
  eq('计数节点被换掉但数字没变 ⇒ 不多留一个点', p2n, 2);

  viewA.attrs['aria-label'] = '250 次查看。查看帖子分析';
  sP.__fireMo([{ type: 'childList', target: likeBtn, addedNodes: [h('span')] }]);
  sP.__runTimers(4);
  const p3 = pages();
  eq('数字变了（曝光 100→250）⇒ 多一个点，原因 auto=metric', [p3.length - p2n, p3[p3.length - 1].auto], [1, 'metric']);
  eq('新那个点带的就是页面上的新曝光（增速全靠这一列）', p3[p3.length - 1].data.tweets[0].metrics.view.num.value, 250);
  eq('整段被动补采结束后 runs 只多了那一次手动采集', xP.loadRuns().length, runs0 + 1);

  // 关注/粉丝列表页没有时间线卡片：不许在那边补采（白跑一趟还污染「最近采集」）
  const sList = run(profile, '/demo_own/following', 'https://x.com/demo_own/following');
  sList.__fireMo([{ type: 'childList', addedNodes: [h('article', {})] }]);
  // 落表防抖也走 setTimeout（v0.8.7 起 8 秒），拿 ms>=4500 数定时器会把那一枪算进来 ⇒ 直接问补采自己的账
  eq('列表页不排补采（页型守卫在 collectSoon 里，白跑一趟那笔账没还回来）', [sList.__xprobe.tlQ().timer, sList.__timers.filter((t) => t.ms >= 4500 && t.ms <= 5000).length], [0, 0]);

  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.v1'].forEach((k) => delete store[k]);
}

console.log('\n[8m] v0.8.7 观察器限流：小批即时 / 突发排队 / 预算截断 / 安静边沿 / 落表与徽标限流（用户现场「评论区一滚动就特别卡」那一刀）');
{
  const art = (handle, view, id) => h('article', { 'data-testid': 'tweet' }, [
    h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/' + handle }, [T('甲'), T(' @' + handle)])]),
    h('a', { href: '/x/status/' + id }, [h('time', { datetime: '2026-10-24T01:00:00.000Z' }, [T('1小时')])]),
    h('div', { 'data-testid': 'tweetText' }, [T('限流样本')]),
    h('div', { role: 'group' }, [
      h('button', { 'data-testid': 'reply', 'aria-label': '3 回复。回复' }, [T('3')]),
      h('a', { href: '#', 'aria-label': view + ' 次查看。查看帖子分析' }, [T(String(view))]),
    ]),
  ]);
  const root = h('div', { lang: 'zh' }, [art('zz_p1', 100, '7001')]);
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.v1', 'ysy.xprobe.blocked'].forEach((k) => delete store[k]);
  const sb = run(root, '/zz_p1/status/7001', 'https://x.com/zz_p1/status/7001');
  const xp = sb.__xprobe;
  sb.__runTimers(3);   // boot 那几枪（2.5s 自动采 + beacon）先跑干净，后面数定时器才数得准
  const P = () => xp.perfLine();
  const storeRecs = () => postedRecords(sb).filter((r) => r.kind === 'store').length;

  // ---- 1) 小批即时：用户点一下关注只有一两批，关系与流水绝不为性能让路
  const led0 = xp.ledgerSize();
  const btnA = h('button', { 'data-testid': '777700001-follow', 'aria-label': '关注 @zz_pa' }, [T('关注')]);
  xp.feedMutations([{ type: 'childList', target: root, addedNodes: [btnA], removedNodes: [] }]);
  eq('单批 1 条 ⇒ 当场同步跑完（不排队、不留定时器）', [P().sync, P().queued, xp.mutQ().queue], [1, 0, 0]);
  eq('基线登记不延迟：第一次见到按钮只记状态、不算关注动作',
    [xp.ledgerSize() - led0, postedRecords(sb).filter((r) => r.kind === 'follow').length], [1, 0]);
  btnA.attrs['data-testid'] = '777700001-unfollow'; btnA.attrs['aria-label'] = '正在关注 @zz_pa';
  xp.feedMutations([{ type: 'attributes', target: btnA }]);
  xp.flush();
  const fR = postedRecords(sb).filter((r) => r.kind === 'follow');
  eq('属性轨（data-testid 翻转）也走同步：当帧就出一条 follow 流水', [fR.length, fR[0].data.why], [1, 'attr']);

  // ---- 2) 突发排队：一秒内超额的那几批进队列，跑一趟合并 DFS（证据不丢，只是晚 220ms）
  const bid = 7777100000;
  for (let i = 0; i < 8; i++) {
    const b = h('button', { 'data-testid': (bid + i) + '-follow', 'aria-label': '关注 @zz_pb' + i }, [T('关注')]);
    xp.feedMutations([{ type: 'childList', target: root, addedNodes: [b], removedNodes: [] }]);
  }
  const afterBurst = xp.mutQ().queue;
  ok('超出「一秒 6 趟」额度的批次改排队（不再逐批全扫）', afterBurst >= 2, { queue: afterBurst, queued: P().queued });
  const ledMid = xp.ledgerSize();
  eq('排队期间那几批还没跑：8 个按钮里有几个此刻还没进台账', [afterBurst >= 2, ledMid < led0 + 9], [true, true]);
  xp.flushMutQueue();
  eq('一趟合并 DFS 把队列里全部批次吃完（9 个按钮全登记，队列清空）', [xp.ledgerSize(), xp.mutQ().queue], [led0 + 9, 0]);
  ok('排队那一趟也算跑过（flushed 有账，漏下的证据由兜底对账负责）', P().flushed >= 1, P().flushed);

  // ---- 3) 单批过大 = 正在滚动重建：不看内容直接排队
  const big = [];
  for (let i = 0; i < 30; i++) big.push({ type: 'childList', target: root, addedNodes: [h('span', {}, [T('x')])], removedNodes: [] });
  const q3 = P().queued;
  xp.feedMutations(big);
  ok('一批 30 条（> MUT_FAST_BATCH=24）直接排队并进入突发态', P().queued > q3 && xp.mutQ().burst > 0, [P().queued - q3, xp.mutQ().burst]);
  sb.__runTimers(2);

  // ---- 4) 队列封顶：超了丢最老的，且丢了几个记在账上（不静默吞）
  const d0 = P().droppedBatches;
  for (let i = 0; i < 60; i++) xp.feedMutations(big);
  ok('队列封顶 48 批：溢出部分丢弃并有计数（漏下的由采集时全量对账兜底）',
    P().droppedBatches > d0 && P().droppedRecords > 0 && xp.mutQ().queue <= 48,
    [P().droppedBatches - d0, P().droppedRecords, xp.mutQ().queue]);
  sb.__runTimers(2);

  // ---- 5) 节点预算：绝不在一棵深树上做无界 DFS
  let deep = h('div', {}, [T('叶')]);
  for (let i = 0; i < 700; i++) deep = h('div', {}, [deep]);
  const cap0 = P().nodeCapHits;
  xp.onMutations([{ type: 'childList', target: root, addedNodes: [deep], removedNodes: [] }]);
  ok('700 层深的子树被节点预算掐住（一趟最多 600 个节点，到点收工并计数）',
    P().nodeCapHits > cap0 && P().worstPassNodes <= 600, [P().nodeCapHits - cap0, P().worstPassNodes]);
  const cap1 = P().nodeCapHits, wm1 = P().worstPassNodes;
  xp.onMutations([{ type: 'childList', target: root, addedNodes: [h('div', {}, [h('span', {}, [T('小')])])], removedNodes: [] }]);
  // worstPassNodes 是「最差一趟」的水位线：深树那趟已把它顶到 cap（600）就永远停在 600 ——
  // 小树那趟的判据是「不碰帽、也不把水位再抬高」（旧写法期望它退回深树前的旧值，与水位线语义相反，
  // 恰好此前有大趟垫到 600 时才碰巧过 —— 抖动源：core 的调度带 Math.random 抖动，大趟来不来随机）。
  eq('正向对照：小树照样跑完整趟、不碰预算（上一条不是空断言）', [P().nodeCapHits, P().worstPassNodes], [cap1, wm1]);

  // ---- 6) 安静边沿：突发时整页快照不压在滚动那几帧上
  const fresh = run(art('zz_q1', 100, '7002'), '/zz_q1/status/7002', 'https://x.com/zz_q1/status/7002');
  fresh.__timers.length = 0;
  fresh.__xprobe.collectSoon('metric');
  const quietMs = fresh.__timers.length ? fresh.__timers[fresh.__timers.length - 1].ms : -1;
  eq('正向对照：不在突发里就维持 v0.7.0 口径（第一次当场排 0 毫秒）', quietMs, 0);
  for (let i = 0; i < 8; i++) xp.feedMutations(big);   // 把 sb 推进突发态
  sb.__timers.length = 0;
  xp.collectSoon('new-article');
  const tPost = P().postponed;
  const burstMs = sb.__timers.length ? sb.__timers[sb.__timers.length - 1].ms : -1;
  ok('突发中：补采这一枪推到 DOM 安静之后（>0 毫秒）并记 postponed 账', burstMs > 0 && tPost > 0, [burstMs, tPost]);
  ok('突发期间的地板不超过 12 秒（平时 5 秒一枪，滚动时 12 秒一枪，别饿死）', burstMs <= 12000, burstMs);
  sb.__runTimers(2);

  // ---- 6b) 地板跟着上一次整页快照的实际开销退：长评论区一趟一百多毫秒，这记重锤不许每 12 秒砸一次
  const floorAt = (cost) => {
    const s2 = run(art('zz_f1', 100, '7005'), '/zz_f1/status/7005', 'https://x.com/zz_f1/status/7005');
    s2.__runTimers(3);
    const x2 = s2.__xprobe;
    x2.collectSoon('metric');                       // 先落一枪，把「上次采集时间」打到刚刚（走地板那条分支）
    s2.__runTimers(1);
    x2.perfRef.lastCollectMs = cost;                // 沙箱里 doCollect 只要 1 毫秒，重锤的开销只能用真机量到的值灌进来
    for (let i = 0; i < 8; i++) x2.feedMutations(big);
    s2.__timers.length = 0;
    x2.collectSoon('new-article');
    return [x2.costBackoff(), s2.__timers.length ? s2.__timers[s2.__timers.length - 1].ms : -1];
  };
  const fLite = floorAt(10), f100 = floorAt(100), f500 = floorAt(500);
  eq('正向对照：小页面（一趟 10 毫秒）加时为 0，地板仍是 12 秒（上一条不是空断言）',
    [fLite[0], fLite[1] >= 11000 && fLite[1] <= 12000], [0, true]);
  eq('上次快照 100 毫秒 ⇒ 每 1 毫秒换 100 毫秒休息（占空比 1%，地板退到 22 秒）',
    [f100[0], f100[1] >= 21000 && f100[1] <= 22000], [10000, true]);
  eq('退让有封顶：500 毫秒也只加 30 秒（别把被动补采彻底停掉）',
    [f500[0], f500[1] >= 41000 && f500[1] <= 42000], [30000, true]);

  // ---- 7) 悬停名片：旧写法 hcLastAt 只在命中时推进 ⇒ 页面没名片时每批白扫一趟整页
  const hc0 = P().hcScans;
  for (let i = 0; i < 3; i++) xp.onMutations([{ type: 'childList', target: root, addedNodes: [h('span', {}, [T('与名片无关')])], removedNodes: [] }]);
  eq('没名片的批次一趟内容扫都不做（信号由合并 DFS 顺手给出，不再逐批 querySelector）', P().hcScans, hc0);
  xp.onMutations([{ type: 'childList', target: root, addedNodes: [h('div', { 'data-testid': 'HoverCard' }, [h('div', {}, [T('5,287 帖子')])])], removedNodes: [] }]);
  eq('看到名片才去读内容，且读一次记一次', P().hcScans, hc0 + 1);
  xp.onMutations([{ type: 'childList', target: root, addedNodes: [h('div', { 'data-testid': 'HoverCard' }, [h('div', {}, [T('5,288 帖子')])])], removedNodes: [] }]);
  ok('800ms 内第二张名片被节流（hcThrottle 有账）', P().hcThrottle >= 1, P().hcThrottle);

  // ---- 8) 自激回路：我自己缝进页面的节点不许再喂回扫描
  const dom0 = P().passesWithDom;
  const mine = h('span', { 'data-xprobe': 'blk', class: 'ysy-xprobe-blk' }, [h('button', {}, [T('已拉黑')])]);
  xp.feedMutations([{ type: 'childList', target: root, addedNodes: [mine], removedNodes: [] }]);
  eq('徽标注入不触发重扫（否则 1.2 秒节拍自己给自己点火）', P().passesWithDom, dom0);

  // ---- 9) 落表限流：摘要先过闸门再算；收尾把压在防抖里的那一枪立刻落下
  xp.flush();
  const sr0 = storeRecs(), dg0 = P().storeDigestSaved, sw0 = P().storeWrites;
  xp.getUsers().zz_sx = { handle: 'zz_sx', name: '宋', relation: '', followers: 10, following: 1, followersExact: true, own: false, seenAs: {}, hist: [], firstSeenAt: Date.now(), updatedAt: Date.now() };
  xp.writeStores(); xp.writeStores();
  xp.flush();
  // 两次落表在同一毫秒里：闸门最多放行一次，第二次连摘要都不许算（旧写法是先算完整摘要才发现发不出去）
  eq('30 秒窗口内重复落表不再整表排序 + stringify（省下的就是几百 KB 的白干活）',
    [storeRecs() - sr0 <= 1, P().storeDigestSaved - dg0 >= 1], [true, true]);
  const swNow = P().storeWrites;
  const flushedTo = xp.flushStoreNow('test');
  eq('pagehide/切走那条路：当场落表并把「收尾刷过」记账', [flushedTo, P().storeWrites, P().storeFlushed], [swNow + 1, swNow + 1, 1]);

  // ---- 10) 徽标全扫限流（节拍器 1.2 秒一轮，其中一轮就够）
  // v0.8.9：这颗徽标默认关了（关着连扫都不扫，见 [18]），这一档测的是「开着时」的限流账
  store['ysy.xprobe.badge'] = true;
  xp.renderBlocks(true);
  const bs0 = P().badgeScans;
  xp.renderBlocks(); xp.renderBlocks();
  eq('没新挂载、没到 15 秒心跳 ⇒ 连叫两轮一次也不扫（只计数）', [P().badgeScans, P().badgeSkips >= 2], [bs0, true]);
  xp.renderBlocks(true);
  eq('正向对照：用户点了拉黑（force）⇒ 当场必扫，徽标颜色不许等下一拍', P().badgeScans, bs0 + 1);
  store['ysy.xprobe.badge'] = false;
  const bx0 = P().badgeScans;
  xp.renderBlocks(true);
  eq('闸一关：连 force 也不许再扫（这一档的账停在关闸那一刻，之后只计跳过）',
    [P().badgeScans, P().badgeSkips >= 1], [bx0, true]);
  store['ysy.xprobe.badge'] = false;   // 保持关：后面几段不该往页面缝东西（v0.8.16 起默认是开）

  // ---- 11) 整文档对账限流：被动那一枪 30 秒一次，手动/换页不受限
  const rc0 = P().reconciles, sk0 = P().reconSkips;
  xp.doCollect({ passive: 'test' }); xp.doCollect({ passive: 'test2' });
  eq('被动那一枪第二次不重跑整文档 querySelectorAll（30 秒一次就够）', [P().reconciles - rc0, P().reconSkips - sk0], [0, 2]);
  xp.doCollect({ force: true });
  eq('正向对照：手动那一枪照跑（排队丢批/预算截断漏下的按钮靠它兜底）', P().reconciles - rc0, 1);

  // ---- 12) 性能账进得了通道：卡顿修没修好，重载后滚一趟评论区从日志里看得回
  const pl = P();
  eq('perf 的形状（趟数/丢弃/最坏毫秒/上限/当前退让）在 state 与 debug 两条通道都读得到',
    [typeof pl.worstPassMs, typeof pl.droppedBatches, pl.caps.idleMs, pl.caps.nodes, typeof pl.collectBackoffMs, !!xp.debugDigest().perf],
    ['number', 'number', 220, 600, 'number', true]);
  ok('页型守卫挪进 collectSoon 以后仍然管得住列表页（白跑一趟那笔账没还回来）',
    (() => {
      const s2 = run(art('zz_r1', 1, '7003'), '/demo_own/following', 'https://x.com/demo_own/following');
      s2.__timers.length = 0;
      s2.__xprobe.collectSoon('new-article');
      return s2.__timers.length === 0;
    })(), true);

  // ---- 13) 面板诊断页读得到性能账（用户目检「还卡不卡」的读数处）
  const pl13 = xp.perfLine();
  const pr = V.perfRow({ perf: pl13 });
  eq('诊断页那一行把趟数/最重一趟/补采最重一枪都摆出来（数字全部来自 core，面板不自己算）',
    [pr.k, String(pr.label).slice(0, 3), String(pr.value).indexOf(pl13.worstPassMs + 'ms') >= 0, String(pr.value).indexOf(pl13.sync + '即时') >= 0],
    ['row', '性能账', true, true]);
  eq('正向对照：state 里没有 perf（旧副本在跑）时把话说清楚，绝不画一排 0 冒充「探针很轻」',
    [/没有性能账/.test(V.perfRow({}).value), V.perfRow({}).sty, /没有性能账/.test(V.perfRow(undefined).value)],
    [true, 'warn', true]);
  eq('队列顶不住（丢批 >0）时整行转黄', V.perfRow({ perf: { droppedBatches: 3, caps: {} } }).sty, 'warn');
  ok('perf 也随 stateForPanel 走（面板拿得到，不用开控制台）', !!xp.stateForPanel().perf, Object.keys(xp.perfLine()).length);

  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.v1', 'ysy.xprobe.blocked'].forEach((k) => delete store[k]);
}

console.log('\n[8l] v0.7.0-D 广场读本机库：账号榜 / 帖子榜 / 建议名单（空值不许冒充最小值）');
{
  const T9 = Math.floor(Date.now() / 60000) * 60000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const dbOk = {
    at: T9, ms: 420, via: 'native', id: 'abcdefghijklmnopabcdefghijklmnop',
    native: { ok: true, at: T9, err: '' },
    acct: { ok: true, err: '', rows: [
      { handle: 'king', name: 'King', own: 1, relation: '', relation_at: iso(T9), day: '2026-10-24', exposure: 10100,
        fans: 2980, fow: 2580, posts_n: 3, eng: 900, views: 30000, last_post_at: iso(T9), seen_at: iso(T9) },
      { handle: 'big', name: 'Big', own: 0, relation: 'following', relation_at: iso(T9 - 864e5),
        fans: 90000, fow: 12, posts_n: 5, eng: 300, views: 200000, last_post_at: iso(T9) },
      { handle: 'tiny', own: 0, relation: 'following', fans: 40, fow: 3, posts_n: 2, eng: 12,
        views: 9000, last_post_at: iso(T9 - 4 * 864e5) },
      { handle: 'mute', own: 0, relation: 'following', fans: 10, fow: 1, posts_n: 2, eng: null, views: null },
      { handle: 'newbie', own: 0, relation: 'not_following', fans: 500, posts_n: 4, eng: 400,
        views: 50000, last_post_at: iso(T9) },
      { handle: 'ghost', own: 0, relation: '', fans: null, posts_n: 1, eng: null, views: null },
      { handle: 'nullviews', own: 0, relation: 'not_following', fans: 1, posts_n: 1, eng: 5, views: null },
    ] },
    post: { ok: true, err: '', rows: [
      { tweet_id: '1001', author: 'newbie', text: '未关注的人的高互动帖', last_at: iso(T9), view: 12000,
        view_gain: 2000, hours: 2, view_per_h: 1000, like_gain: 100, eng: 800, eng_rate: 6.67, like_rate: 5, points: 4 },
      { tweet_id: '1002', author: 'big', text: '已关注的大号帖', last_at: iso(T9), view: 90000,
        view_gain: 1000, hours: 5, view_per_h: 200, like_gain: 10, eng: 300, eng_rate: 0.33, like_rate: 0.2, points: 2 },
      { tweet_id: '1003', author: 'tiny', text: '只有一个采样点', last_at: iso(T9 - 2 * 864e5), view: 300,
        view_gain: null, hours: null, view_per_h: null, like_gain: null, eng: 2, eng_rate: 0.67, like_rate: 0.3, points: 1 },
    ] },
  };
  eq('账号榜按曝光降序；空曝光的两人垫底（按 handle 稳定）',
    V.acctRows(dbOk, 'views').map((r) => r.h + '#' + r.rank).join(','),
    'big#1,newbie#2,king#3,tiny#4,ghost#5,mute#6,nullviews#7');
  eq('换列头就换序：按互动降序，互动为空的人垫底',
    V.acctRows(dbOk, 'eng').map((r) => r.h).join(','), 'king,newbie,big,tiny,nullviews,ghost,mute');
  eq('互动率 = 互动/曝光（库外同一口径再除一次），曝光为空时是 null 不是 0',
    [V.acctRows(dbOk, 'views').find((r) => r.h === 'big').rate,
      V.acctRows(dbOk, 'views').find((r) => r.h === 'newbie').rate,
      V.acctRows(dbOk, 'views').find((r) => r.h === 'nullviews').rate], [0.15, 0.8, null]);
  const aT = V.acctTable(dbOk, 'views', T9);
  eq('账号榜列头与列键由 view 一处给死', [aT.k, aT.head.join('/'), aT.cols.join('/'), aT.sortBy],
    ['grid', '名次/账号/关系/曝光/互动/互动率/粉丝/帖数', '///views/eng//fans/posts', 'views']);
  eq('自己的那行标 * 并高亮；关系直说（自己 / 已关注 / 未关注 / 未知）',
    [aT.rows.find((r) => r.key === 'king').cells[1].t, aT.rows.find((r) => r.key === 'king').cls,
      aT.rows.find((r) => r.key === 'king').cells[2].t, aT.rows.find((r) => r.key === 'ghost').cells[2].t],
    ['@king *', 'rankOwn', '自己', '—']);
  const pG = V.postRows(dbOk, 'growth');
  eq('帖子榜按每小时增长降序；只有一条采样点（NULL）垫底，绝不写 0 冒充最慢',
    pG.map((p) => p.id + '=' + (p.perH == null ? 'n' : p.perH)).join(','), '1001=1000,1002=200,1003=n');
  eq('帖子榜按曝光降序是另一张序（同一条帖子一行，不按人合并）',
    V.postRows(dbOk, 'view').map((p) => p.id).join(','), '1002,1001,1003');
  const pT = V.postTable(dbOk, 'growth', T9);
  eq('帖子榜列头写死（曝光 / +每小时两列可点）', [pT.head.join('/'), pT.cols.join('/'), pT.sortBy],
    ['名次/作者/正文/曝光/+每小时', '///view/growth', 'growth']);
  eq('增速 NULL 在表面上就是「—」，悬停说明只有一个采样点（不是 0）',
    [pT.rows[2].cells[4].t, /只有一个采样点/.test(pT.rows[2].tip)], ['—', true]);
  // v0.8.1-t 榜分页：一次 10 条、「更多」按钮 +10（limit 由面板模块变量递增加进来；不传 = 全量，老调用不受影响）
  const aPage = V.acctTable(dbOk, 'views', T9, 3);
  eq('账号榜分页：limit=3 出前 3 名、more=4、more 走 dbTable 输出面（sidepanel 靠它画「更多」钮）',
    [aPage.rows.length, aPage.rows.map((r) => r.cells[0].t).join(','), aPage.more], [3, '#1,#2,#3', 4]);
  const pPage = V.postTable(dbOk, 'growth', T9, 1);
  eq('帖子榜分页：limit=1 出第 1 名、more=2', [pPage.rows.length, pPage.rows[0].cells[0].t, pPage.more], [1, '#1', 2]);
  eq('limit 不传 = 全量（夹具 7 人 3 帖全出、more=0）：默认口径不变，只有面板主动传小页',
    [V.acctTable(dbOk, 'views', T9).rows.length, V.acctTable(dbOk, 'views', T9).more,
      V.postTable(dbOk, 'growth', T9).rows.length, V.postTable(dbOk, 'growth', T9).more], [7, 0, 3, 0]);
  ok('正向对照：limit 大于总行数 ⇒ more 恒 0（「更多」按钮不出现，不挂一个空尾巴）',
    V.acctTable(dbOk, 'views', T9, 99).more === 0 && V.postTable(dbOk, 'growth', T9, 99).more === 0, '');
  // v0.8.2 时间线曝光排序：主页时间线 tab（为你推荐/正在关注）随快照落库，某天一张榜按曝光降序
  const tlDb = {
    acct: dbOk.acct, post: dbOk.post,
    tlDays: { ok: true, err: '', rows: [
      { day: '2026-10-25', tl_src: 'following', n: 2, views: 215 },
      { day: '2026-10-25', tl_src: 'foryou', n: 3, views: 500 },
      { day: '2026-10-24', tl_src: 'foryou', n: 1, views: 9 },
    ] },
    tl: { ok: true, err: '', rows: [
      { day: '2026-10-25', tl_src: 'foryou', tweet_id: 't3', author: 'aa', text: '帖子三', at: '2026-10-25T12:00:00Z', view: 300, reply: 5 },
      { day: '2026-10-25', tl_src: 'following', tweet_id: 't1', author: 'bb', text: '帖子一', at: '2026-10-25T13:00:00Z', view: 160, reply: 40 },
      { day: '2026-10-25', tl_src: 'foryou', tweet_id: 't1', author: 'bb', text: '帖子一', at: '2026-10-25T12:00:00Z', view: 150, reply: 38 },
      { day: '2026-10-25', tl_src: 'following', tweet_id: 't2', author: 'cc', text: '帖子二', at: '2026-10-25T13:00:00Z', view: 55, reply: 0 },
      { day: '2026-10-25', tl_src: 'foryou', tweet_id: 't2', author: 'cc', text: '帖子二', at: '2026-10-25T10:00:00Z', view: 50, reply: 1 },
    ] },
  };
  const tlT = V.tlTable(tlDb, { day: '2026-10-25', now: T9 });
  eq('时间线榜：每帖×源各一行（同帖在推荐流与关注流是两条关联）、按曝光降序',
    tlT.cards.map((c) => c.key + '=' + c.view).join(','), 't3=300,t1=160,t1=150,t2=55,t2=50');
  eq('卡片样式：作者/来源收进悬浮字段、点卡片跳原帖（author+tweet_id 拼规范地址，无名时走 /i/web/status/ 兜底）',
    [V.tlTable(tlDb, { day: '2026-10-25', srcf: 'foryou', now: T9 }).cards.map((c) => c.key).join(','),
      V.tlTable(tlDb, { day: '2026-10-25', srcf: 'foryou', now: T9 }).cards[0].rank,
      V.tlTable(tlDb, { day: '2026-10-25', now: T9 }).cards[0].href,
      V.tlTable(tlDb, { day: '2026-10-25', now: T9 }).cards[0].src,
      /推荐时刻/.test(V.tlTable(tlDb, { day: '2026-10-25', now: T9 }).cards[0].tip),
      V.tlTable({ tl: { ok: true, err: '', rows: [{ tweet_id: 'x9', author: '', text: 't', at: '2026-10-25T12:00:00Z', view: 1, tl_src: 'foryou' }] } },
        { day: '2026-10-25', now: T9 }).cards[0].href],
    ['t3,t1,t2', '#1', 'https://x.com/aa/status/t3', '为你推荐', true, 'https://x.com/i/web/status/x9']);
  eq('标题带当天各源合计（tl_days），天数下拉去重保序、day 字段回灌选中值',
    [V.tlDays(tlDb).join(','), /为你推荐 3 条 \/ 500~/.test(tlT.title), tlT.days.join(','), tlT.day],
    ['2026-10-25,2026-10-24', true, '2026-10-25,2026-10-24', '2026-10-25']);
  const tlPage = V.tlTable(tlDb, { day: '2026-10-25', limit: 2, now: T9 });
  eq('时间线榜分页与另外两张同一套：limit=2 出前 2、more=3', [tlPage.cards.length, tlPage.more], [2, 3]);
  eq('排序键可切评论：评论降序（t1 两源 40/38 > t3=5 > t2），平手才看曝光；卡片带评论数、缺数如实「—」',
    [V.tlTable(tlDb, { day: '2026-10-25', sort: 'reply', now: T9 }).cards.map((c) => c.key + '=' + c.reply).join(','),
      V.tlTable(tlDb, { day: '2026-10-25', sort: 'reply', now: T9 }).cards[0].view,
      tlT.cards[0].reply,
      V.tlTable({ tl: { ok: true, err: '', rows: [{ tweet_id: 'x8', author: 'a', text: 't', at: '2026-10-25T12:00:00Z', view: 3, tl_src: 'foryou' }] } },
        { day: '2026-10-25', now: T9 }).cards[0].reply],
    ['t1=40,t1=38,t3=5,t2=1,t2=0', '160', '5', '—']);
  // 点昵称的作者模态框：author_posts 回包 → 展示行（库已按曝光降序，展示层不重排）
  const upR = V.tlUserRows({ ok: true, rows: [
    { tweet_id: 't3', author: 'aa', text: '帖子三', last_at: '2026-10-25T12:00:00Z', view: 300, eng: 12 },
    { tweet_id: 't9', author: '', text: '无名', last_at: '2026-10-25T09:00:00Z', view: null, eng: null },
    { tweet_id: '', author: 'x', text: '没有 id 的行被滤掉', last_at: '', view: 5, eng: null },
  ] });
  eq('作者模态框行：author+id 拼跳转地址（无名走 /i/web/status/ 兜底）、没 id 的行不进、曝光/互动缺数如实「—/空」',
    [upR.length, upR[0].href, upR[0].view, upR[0].eng, upR[1].href, upR[1].view, upR[1].eng],
    [2, 'https://x.com/aa/status/t3', '300', '12', 'https://x.com/i/web/status/t9', '—', '']);
  ok('tl 查询失败要点名（版本旧/库没起都要看得见，不静默吞）',
    V.plazaLines({ series: { min: [], imp: [], handles: [], counts: {}, rank: [] } },
      { db: { acct: { ok: false, rows: [], err: 'x' }, post: { ok: false, rows: [], err: 'x' },
        tl: { ok: false, rows: [], err: '宿主旧' }, tlDays: { ok: false, rows: [], err: '' } } })
      .some((m) => m.k === 'row' && /查询失败/.test(m.value) && /宿主旧/.test(m.value)), '');
  const sg = V.dbSuggest(dbOk);
  eq('最该关注：只收「明确未关注」且有帖子的人（关系未知的 ghost 不进名单）',
    sg.follow.map((r) => r.h).join(','), 'newbie,nullviews');
  eq('最该取关：按互动升序、粉丝少的靠前，互动为空的人垫底（不许排第一个）',
    sg.unfollow.map((r) => r.h).join(','), 'tiny,big,mute');
  eq('最该看的帖子：只取未关注作者（已关注的大号帖不进这张名单）', sg.posts.map((p) => p.id).join(','), '1001');
  ok('正向对照：把 mute 的互动改成 0（而非 null），同一条「空值垫底」判据当场变红 —— 证明它咬的是 null 分支',
    V.dbSuggest(Object.assign({}, dbOk, { acct: { ok: true, err: '', rows: dbOk.acct.rows.map((r) => (r.handle === 'mute' ? Object.assign({}, r, { eng: 0 }) : r)) } })).unfollow.map((r) => r.h).join(',') === 'mute,tiny,big', '');
  const plazaDb = V.plazaLines({ tab: 'profile', series: { own: 'king', key: 'king', rank: [], min: [], imp: [], handles: [] } }, { db: dbOk, now: T9 });
  eq('广场库通了：两张榜 + 三段建议，旧的「每人最新一行」不再出现（不两套账并排）',
    [plazaDb.filter((m) => m.k === 'grid').length, plazaDb.filter((m) => m.k === 'fold').length,
      plazaDb.filter((m) => m.k === 'rank').length], [2, 3, 0]);
  ok('建议都写明「只列不动作」，取关那一句必须点名「永不自动」',
    plazaDb.some((m) => m.k === 'line' && /只列不动作/.test(m.text) && /取关永远由你手动做/.test(m.text)),
    plazaDb.filter((m) => m.k === 'line').map((m) => m.text.slice(0, 20)));
  const dbBad = { id: 'abcdefghijklmnopabcdefghijklmnop', via: 'http', ms: 9000,
    native: { ok: false, at: T9, err: 'Specified native messaging host not found.' },
    acct: { ok: false, rows: [], err: '本机库 8 秒没回（宿主或 sink 卡住？）' },
    post: { ok: false, rows: [], err: '本机库 8 秒没回（宿主或 sink 卡住？）' } };
  const plazaBad = V.plazaLines({ tab: 'profile', series: { own: 'king', key: 'king', rank: [], min: [], imp: [], handles: [] } }, { db: dbBad, now: T9 });
  const badRow = plazaBad.filter((m) => m.label === '本机库 xprobe.db')[0];
  ok('库读不到：红字直说读不到 + 通道，并用扩展 ID 给出装宿主的那条命令（不让空表冒充「没有数据」）',
    !!badRow && badRow.sty === 'bad' && /读不到/.test(badRow.value) && /--ext-id abcdefghijklmnopabcdefghijklmnop/.test(badRow.title),
    badRow && [badRow.value, badRow.title.slice(0, 30)]);
  // v0.7.1：两条路都断时面板曾只显示 fetch 原文「Failed to fetch」——用户看不出是宿主没装还是 sink 没开。
  const dbDown = { id: 'abcdefghijklmnopabcdefghijklmnop', via: 'http', ms: 30,
    native: { ok: false, at: T9, err: 'Specified native messaging host not found.' },
    acct: { ok: false, rows: [], err: 'Failed to fetch' },
    post: { ok: false, rows: [], err: 'Failed to fetch' } };
  const downRow = V.plazaLines({ series: { own: 'king', key: 'king', rank: [], min: [], imp: [], handles: [] } }, { db: dbDown, now: T9 })
    .filter((m) => m.label === '本机库 xprobe.db')[0];
  ok('两条通道都断时点名「宿主未注册 + sink 未启动」，原始 Failed to fetch 只进悬停（面板第一眼要能照着修）',
    !!downRow && /两个通道都没通/.test(downRow.value) && /Failed to fetch/.test(downRow.title) && /install-host\.py/.test(downRow.title),
    downRow && [downRow.value, downRow.title.slice(0, 40)]);
  ok('正向对照：超时那种失败照旧报原文，不被同一句话糊掉（证明上面那条认的是断连，不是「任何错误」）',
    !!badRow && !/两个通道都没通/.test(badRow.value) && /8 秒没回/.test(badRow.value), badRow && badRow.value);
  ok('库读不到时退回浏览器那套每人一行（至少不白屏），且一张库榜都不许发（免得空表被当成真账）',
    plazaBad.filter((m) => m.k === 'rank').length === 1 && plazaBad.filter((m) => m.k === 'grid').length === 0,
    plazaBad.map((m) => m.k).join(','));
  const plazaWait = V.plazaLines({ series: { own: 'king', key: 'king', rank: [], min: [], imp: [], handles: [] } }, { db: null, now: T9 });
  ok('还没读库时说的是「正在读…」而不是失败（第一眼别报红）',
    plazaWait.filter((m) => m.label === '本机库 xprobe.db')[0].sty === 'warn', '');
}

console.log('\n[9] 报错钩子');
{
  RESP.post = { status: 200, text: '{"ok":true,"stored":1}' };
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  ok('挂了 error 监听', !!sb.window.listeners.error, Object.keys(sb.window.listeners));
  sb.window.fire('error', { message: 'boom', filename: 'x-observe-probe.user.js', lineno: 12, colno: 3, error: { stack: 'Error: boom\n at x:1:1' } });
  sb.__xprobe.flush();
  const errs = postedRecords(sb).filter((r) => r.kind === 'err');
  eq('err 1 条', errs.length, 1);
  eq('err msg', errs[0].data.msg, 'boom');
  ok('err stack 片段', /boom/.test(errs[0].data.stack), errs[0].data.stack);
  sb.window.fire('unhandledrejection', { reason: new Error('rejected-here') });
  sb.__xprobe.flush();
  eq('rejection 也算 err', postedRecords(sb).filter((r) => r.kind === 'err').length, 2);
}

console.log('\n[9c] 调试转储：domTree 形状 / 开关与预算 / 脱敏 / 面板自排除 / 截断');
{
  delete store['ysy.xprobe.dump'];
  delete store['ysy.xprobe.dumpHtml'];
  const dumpCalls = (sb) => sb.__calls.filter((c) => /\/dump$/.test(c.url));
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xp = sb.__xprobe;
  sb.__runTimers(3);
  eq('开关默认关', xp.dumpStatus().on, false);
  eq('关着时 captureDump 直接跳过', xp.captureDump().skip, 'off');
  eq('正向对照：关着就一个 /dump 请求都不发（不会盲发整页）', dumpCalls(sb).length, 0);
  ok('但 /log 记录流照旧（转储没顶掉原通道）', logCalls(sb).length >= 1, sb.__calls.map((c) => c.url));

  xp.setDumpOn(true);
  eq('开关状态落 GM 存储', store['ysy.xprobe.dump'], true);
  xp.doCollect({ force: true });
  eq('开开关后「采集本页」顺手带一份整页转储', dumpCalls(sb).length, 1);
  const d = JSON.parse(dumpCalls(sb).pop().body);
  eq('转储标记 t=1（自检流量分流）', d.t, 1);
  eq('页型与 handle', [d.tab, d.handle], ['profile', 'demo_own']);
  ok('一次转储 = 一个 POST（不分片，免得我读的顺序错）', dumpCalls(sb).length === 1, dumpCalls(sb).length);
  eq('转储不进 ndjson 记录流', postedRecords(sb).filter((r) => r.kind === 'dump').length, 0);
  ok('tree 里有 User-Name', /data-testid="User-Name"/.test(d.tree), d.tree.slice(0, 200));
  ok('tree 里有聚合 aria 整句（我要的就是这种原文）', /aria-label="11 回复、9 喜欢、122 次观看"/.test(d.tree), '');
  ok('tree 里有 datetime', /datetime="2026-10-22T04:58:16\.000Z"/.test(d.tree), '');
  ok('tree 里有粉丝锚点', /href="\/demo_own\/verified_followers"/.test(d.tree), '');
  ok('tree 里有第三方 class 标注（连带报出命中的那个 token）', /\(第三方:xro-badge\)/.test(d.tree), d.tree.split('\n').filter((l) => /class=/.test(l)));
  const lines = d.tree.split('\n');
  eq('无属性的 div/span 不会单独占一行', lines.filter((l) => /^\s*(div|span)\s+kids=\d+$/.test(l)).length, 0);
  const idx = (re) => lines.findIndex((l) => re.test(l));
  const ind = (i) => (i < 0 ? -1 : lines[i].match(/^ */)[0].length / 2);
  const iArt = idx(/^ *article /), iTxt = idx(/data-testid="tweetText"/);
  ok('树是嵌套的：tweetText 在 article 之下且缩进更深', iArt >= 0 && iTxt > iArt && ind(iTxt) > ind(iArt), [iArt, iTxt, ind(iArt), ind(iTxt)]);
  ok('text 是整页可见原文', /关注者/.test(d.text) && /示例笔记/.test(d.text), d.text.slice(0, 60));
  ok('testids 直方图是全页的（不靠我已有选择器）', d.testids.reply >= 1 && d.testids.UserJoinDate === 1, d.testids);
  eq('counts.articles', d.counts.articles === 3 && d.counts.hitCap === false, true);
  ok('counts.ms 量了耗时（真机上贵不贵我一读就知道）', typeof d.counts.ms === 'number' && d.counts.ms >= 0, d.counts);
  ok('没开「全文HTML」时不传 html（默认只给树+原文）', d.html === '', d.html);

  console.log('  [9c-2] 面板自排除与冷却/预算');
  ok('转储里不会读到探针自己的面板', !/ysy-xprobe-panel|调试转储|抓整页原文/.test(d.tree), d.tree.split('\n').filter((l) => /panel|转储/.test(l)));
  eq('同一路由 45s 内不重抓', xp.captureDump().skip, 'cooldown');
  ok('冷却剩余秒数报出来', xp.captureDump().left > 0, xp.dumpStatus());
  const c2 = xp.captureDump({ force: true });
  ok('手点「抓整页原文」越过冷却但仍计入预算', c2.bytes > 0 && xp.dumpStatus().count === 2, c2);
  let guard = 0;
  while (xp.dumpStatus().count < xp.dumpStatus().budget && guard++ < 30) xp.captureDump({ force: true });
  eq('预算 12', xp.dumpStatus().budget, 12);
  eq('到预算就停手（不会连点成 CPU 火焰）', xp.captureDump({ force: true }).skip, 'budget');
  xp.setDumpOn(false);
  eq('关掉', xp.dumpStatus().on, false);

  console.log('  [9c-2b] v0.8.8 开关同频：另一个标签页写的「开」，这一页也得真开（用户：打开后老是又自动关闭）');
  {
    const sb2 = run(profile, '/demo_own', 'https://x.com/demo_own');
    const xp2 = sb2.__xprobe;
    sb2.__runTimers(3);
    delete store['ysy.xprobe.dump'];
    delete store['ysy.xprobe.dumpHtml'];
    eq('新页 boot 时存储里没这个键 ⇒ 这页是关', xp2.dumpStatus().on, false);
    const b0 = dumpCalls(sb2).length;
    xp2.doCollect({ force: true });
    eq('正向对照：关着时采集一份都不转储（这一枪打在写键之前，否则下面那条等于没测）', dumpCalls(sb2).length - b0, 0);
    store['ysy.xprobe.dump'] = true;        // 别的标签页点了「调试转储: 开」（GM 的写在自检桩里就是写 store）
    store['ysy.xprobe.dumpHtml'] = true;    // 顺手把「全文 HTML」也开了
    eq('这一页读状态立刻认：修复前 core 只在 boot 读过一次，面板 900ms 问到的永远是这页内存里的旧值',
      xp2.dumpStatus().on, true);
    eq('两个键各自同频：全文 HTML 也跟（当年就是这两条各自只读一次）', xp2.dumpStatus().html, true);
    eq('采集路径现读现答（dumpEnabled 不是 boot 那份）', xp2.dumpEnabled(), true);
    const b1 = dumpCalls(sb2).length;
    xp2.doCollect({ force: true });
    ok('功能那一半也跟着真开：这页确实发了一份 /dump（以前只有点按钮那一页会发）', dumpCalls(sb2).length === b1 + 1,
      dumpCalls(sb2).length - b1);
    eq('跟过去的 html 键一起生效：整页 outerHTML 进来了', (JSON.parse(dumpCalls(sb2).pop().body).html || '') !== '', true);
    store['ysy.xprobe.dump'] = false;       // 那边又关掉
    // 注意 force 那一路是「用户手点抓整页原文」，它本来就该越过总开关；自动那一轮（3011 行的 dumpEnabled）才归开关管
    eq('关也一样同频：这一页的自动转储停了（不带 force 的那一路当场 skip=off）',
      [xp2.dumpStatus().on, xp2.dumpEnabled(), xp2.captureDump().skip], [false, false, 'off']);
    // 存储读本身抛（真机上 chrome.storage 坏了就是这么表现）⇒ 维持现状，绝不把已经开着的开关抹成关
    let badOn = null;
    Object.defineProperty(store, 'ysy.xprobe.dump', { configurable: true, get() { throw new Error('storage 坏了'); } });
    try {
      const sbBad = run(profile, '/demo_own', 'https://x.com/demo_own');
      sbBad.__xprobe.setDumpOn(true);   // 这一页内存里开着（GM_setValue 也抛，core 那边包了 try）
      badOn = sbBad.__xprobe.dumpStatus().on;
    } finally {
      delete store['ysy.xprobe.dump'];
    }
    eq('读坏时不清零：dumpStatus 仍报开（把用户的开关抹成关是最难复现的那种坏）', badOn, true);
    delete store['ysy.xprobe.dump'];
    delete store['ysy.xprobe.dumpHtml'];
  }
  delete store['ysy.xprobe.dump'];

  console.log('  [9c-3] 全文 HTML 的脱敏');
  const formish = h('div', {}, [
    h('div', { 'data-testid': 'UserName' }, [T('某人 @m')]),
    h('textarea', {}, [T('草稿里打了密钥abc')]),
    h('input', { type: 'text', value: 'hunter2' }),
    h('div', { contenteditable: 'true' }, [T('正在写的推文')]),
  ]);
  const sbh = run(formish, '/m', 'https://x.com/m');
  const rh = sbh.__xprobe.captureDump({ force: true, html: true });
  ok('开了 html 就有内容', rh.bytes > 0, rh);
  const dh = JSON.parse(dumpCalls(sbh).pop().body);
  ok('html 传了', dh.html.length > 0 && dh.counts.htmlChars > 0, dh.counts);
  ok('input 的 value 抹掉', !/hunter2/.test(dh.html) && /value="\[已抹去\]"/.test(dh.html), dh.html.slice(0, 200));
  ok('textarea 正文抹掉', !/密钥/.test(dh.html) && /\[已抹去 textarea 正文\]/.test(dh.html), dh.html.slice(0, 200));
  ok('contenteditable 的形状仍然保留（这才是我要看的）', /contenteditable="true"/.test(dh.tree), dh.tree.slice(0, 200));

  console.log('  [9c-4] 两个 cap');
  const nest = (depth, leaf) => { let n = leaf; for (let i = 0; i < depth; i++) n = h('div', {}, [n]); return h('div', {}, [n]); };
  const cap = (sb) => { sb.__xprobe.captureDump({ force: true }); return JSON.parse(dumpCalls(sb).pop().body); };
  const wide = h('div', {}, Array.from({ length: 1500 }, (_, i) => h('button', { 'data-testid': 'btn-' + i }, [])));
  const dw = cap(run(wide, '/m', 'https://x.com/m'));
  ok('行数触顶时明说「结构没看全」', dw.counts.hitCap === true && dw.counts.treeEmitted === 1400, dw.counts);
  const dd = cap(run(h('div', {}, [nest(120, h('button', { 'data-testid': 'deep-needle' }, []))]), '/m', 'https://x.com/m'));
  ok('深度超 90 层时报 hitDepth', dd.counts.hitDepth === true, dd.counts);
  ok('深到触顶时不硬钻（needle 不该出现在树里）', !/deep-needle/.test(dd.tree), dd.tree.slice(0, 120));
  const dm = cap(run(h('div', {}, [nest(15, h('button', { 'data-testid': 'mid-needle' }, []))]), '/m', 'https://x.com/m'));
  ok('折叠掉的层级用 (跳过N层) 标出来，我不至于以为页面很扁', /\(跳过1[0-9]层\)/.test(dm.tree) && /mid-needle/.test(dm.tree), dm.tree);

  console.log('  [9c-5] sink 掉一下头就断时，整页不会静默丢，但也不无限重发');
  const dc = (s) => s.__calls.filter((c) => /\/dump$/.test(c.url));
  const sbf = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xf = sbf.__xprobe;
  sbf.__runTimers(2);
  xf.setDumpOn(true);
  RESP.post = { status: 0, text: '' };
  const cf = xf.captureDump({ force: true });
  ok('首发把整页打出去了（bytes>0）', cf.bytes > 0, cf);
  eq('失败后仍挂在「待重发」', xf.dumpStatus().pending, true);
  eq('首发失败记 1 次', xf.dumpStatus().tries, 1);
  eq('一份还在路上时不会再叠第二份整页', xf.captureDump({ force: true }).skip, 'busy');
  eq('叠不上来也就不会多发（/dump 仍是 1 次）', dc(sbf).length, 1);
  sbf.__runTimers(1);
  eq('自己攒的那条定时器把第 2 次发出去了', dc(sbf).length, 2);
  sbf.__runTimers(1);
  eq('第 3 次发完就放弃', [dc(sbf).length, xf.dumpStatus().tries], [3, 3]);
  eq('放弃后不再占着待重发位', xf.dumpStatus().pending, false);
  ok('放弃是响的：错误写在面板状态里', /放弃/.test(xf.dumpStatus().err), xf.dumpStatus());
  eq('正向对照：放弃后第 4 次不会再自动发', dc(sbf).length, 3);
  RESP.post = { status: 200, text: '{"ok":true,"stored":1,"dir":"dump/xx"}' };
  const cg = xf.captureDump({ force: true });
  ok('sink 回来了，新一轮转储立刻落地', cg.bytes > 0 && xf.dumpStatus().pending === false, [cg, xf.dumpStatus()]);
  eq('落地后把上一次的失败标记清掉', xf.dumpStatus().err, '');
  delete store['ysy.xprobe.dump'];
}

console.log('\n[11] 关注守卫：只读观察 / 基线不虚计 / 滚动窗口 / 取关不占额度 / 两张表 / 右下角恢复');
{
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.hidden', 'ysy.xprobe.dump'].forEach((k) => delete store[k]);
  const btn = (tid, handle) => h('button', {
    'data-testid': tid, 'aria-label': (/-unfollow$/.test(tid) ? '正在关注 @' : '关注 @') + handle,
  }, [T('按钮')]);
  const cell = (tid, handle, name) => h('div', { 'data-testid': 'UserCell' }, [
    h('a', { href: '/' + handle }, [T(name), T(' @' + handle)]),
    h('div', { 'data-testid': 'UserName' }, [T(name + ' @' + handle)]), btn(tid, handle),
  ]);
  const listRoot = h('div', {}, [
    h('a', { href: '/demo_own/following' }, [T('正在关注')]),
    h('div', { 'data-testid': 'primaryColumn' }, [cell('1111111111-follow', 'aaa', '甲'), cell('2222222222-follow', 'bbb', '乙')]),
  ]);
  const sb = run(listRoot, '/demo_own/following', 'https://x.com/demo_own/following');
  const xp = sb.__xprobe;
  sb.__runTimers(2);   // 让 boot 的 2.5s 自动采集跑掉：基线在这里登记

  eq('observer 起来了', xp.guardStatus().watching, true);
  eq('只订 data-testid 这一个属性（别的属性变化与我无关）', sb.__observers[0].opt.attributeFilter, ['data-testid']);
  ok('订 subtree+childList，但不订 characterData（别在文本流上烧 CPU）',
    sb.__observers[0].opt.subtree === true && sb.__observers[0].opt.childList === true && sb.__observers[0].opt.characterData !== true, sb.__observers[0].opt);
  eq('基线：页面本来就有两个未关注按钮，一个都不计', [xp.guardStatus().f15, xp.ledgerSize()], [0, 2]);

  xp.onMutations([{ type: 'childList', addedNodes: [h('div', {}, [btn('3333333333-unfollow', 'ccc')])], removedNodes: [] }]);
  eq('正向对照：滚出来一行「本来就已关注」不算我发出了关注（虚拟列表一滚就是成堆 -unfollow）', xp.guardStatus().f15, 0);
  eq('但它进了台账，之后翻转能认', xp.ledgerSize(), 3);

  const a1 = listRoot.querySelector('[data-testid="1111111111-follow"]');
  a1.attrs['data-testid'] = '1111111111-unfollow'; a1.attrs['aria-label'] = '正在关注 @aaa';
  xp.onMutations([{ type: 'attributes', target: a1, attributeName: 'data-testid' }]);
  eq('属性翻转 -follow → -unfollow = 发出一个关注', [xp.guardStatus().f15, xp.guardStatus().f24, xp.guardStatus().u24], [1, 1, 0]);
  const e0 = xp.getGuard().ev[0];
  ok('事件流水带目标 ID、handle 与「从哪认出来的」', e0.dir === 'follow' && e0.id === '1111111111' && e0.handle === 'aaa' && e0.why === 'attr', e0);

  const a2 = listRoot.querySelector('[data-testid="2222222222-follow"]');
  a2.attrs['data-testid'] = '2222222222-unfollow'; a2.attrs['aria-label'] = '正在关注 @bbb';
  xp.onMutations([{ type: 'attributes', target: a2 }, { type: 'childList', addedNodes: [h('div', {}, [a2])], removedNodes: [] }]);
  eq('属性轨 + 挂载轨同一批只算一次（真机头部与弹层两个按钮会同步翻转）', xp.guardStatus().f15, 2);

  const gone = listRoot.querySelector('[data-testid="3333333333-unfollow"]') || btn('3333333333-unfollow', 'ccc');
  xp.onMutations([{ type: 'childList', addedNodes: [btn('3333333333-follow', 'ccc')], removedNodes: [gone] }]);
  eq('React 重建节点（旧节点移除 + 新节点带新状态）也认得出来，且这是取关', [xp.guardStatus().f15, xp.guardStatus().u24], [2, 1]);

  a1.attrs['data-testid'] = '1111111111-follow'; a1.attrs['aria-label'] = '关注 @aaa';
  xp.onMutations([{ type: 'attributes', target: a1 }]);
  a1.attrs['data-testid'] = '1111111111-unfollow';
  xp.onMutations([{ type: 'attributes', target: a1 }, { type: 'attributes', target: a1 }]);
  eq('取关占流水不占额度；同一目标同一方向 3s 内只算一次', [xp.guardStatus().f15, xp.guardStatus().u24], [3, 2]);

  const now = Date.now();
  xp.getGuard().follows = [now - 16 * 60 * 1000];
  eq('15 分钟是滚动的：16 分钟前那次已经落出窗口', xp.guardStatus().f15, 0);
  eq('同一次仍然算在 24 小时窗口里', xp.guardStatus().f24, 1);
  xp.getGuard().follows = [now - 25 * 60 * 60 * 1000];
  eq('25 小时前那次两个窗口都不在（滚动 24h，不是自然日）', [xp.guardStatus().f15, xp.guardStatus().f24], [0, 0]);

  xp.getGuard().follows = Array.from({ length: 15 }, (_, i) => now - i * 1000);
  const s15 = xp.guardStatus();
  eq('15 分钟满 15 就报 over15（只警告，不拦）', [s15.f15, s15.over15], [15, true]);
  ok('到限时报「多少分钟后腾出一个位置」', s15.free15 > 0 && s15.free15 <= 15 * 60 * 1000, s15.free15);
  xp.getGuard().follows = Array.from({ length: 400 }, (_, i) => now - i * 60000);
  ok('24 小时的口径是 400', xp.guardStatus().over24 === true && xp.guardStatus().max24 === 400, xp.guardStatus());
  xp.doCollect({ force: true });   // 到限状态要经一次 render 才落到浮标与 state 上
  const gst = xp.stateForPanel();
  ok('到限信息进 state（腾出位置那句话由 view 层拼，见 [12]）', gst.guard.over24 === true && gst.guard.free24 > 0, [gst.guard.f24, gst.guard.free24]);
  eq('state 里带着 sink/guard/dump/counts/last/missing/notes/upsert/host/peer/own/series/storage/runsMeta（v0.6.8 加 debug/rndMax，v0.6.9 加 trim，v0.8.7 加 perf，v0.8.9 加 badge），面板不再读页面', Object.keys(gst).sort().join(','),
    'badge,build,counts,debug,dump,guard,host,hotbadge,href,last,missing,notes,own,peer,perf,rndMax,runsMeta,series,sink,storage,tab,trim,upsert,ver');
  // 队列账本与表顶状态必须真的在 state 里：面板那两行只是读它们，读不到就是「看不见」的老问题
  eq('state.sink.q 是队列账本（长度/落盘条数/丢弃数/断线毫秒/两个上限）',
    ['len,bytes,count,dropped,adopted,persisted,lastAt,err,down,max,byteCap,boot', typeof gst.sink.q.len === 'number' && !!gst.sink.q.boot],
    [Object.keys(gst.sink.q).join(','), true]);
  eq('state.trim 是两张表的顶满账（保留数/上限/删掉的行数/是否顶满）',
    Object.keys(gst.trim).sort().join(','),
    'droppedAt,postsDropped,postsFull,postsKept,postsMax,usersDropped,usersFull,usersKept,usersMax');
  // 新字段不是「加进白名单就完事」：面板画图靠的是这几个键，缺一个趋势页就是空白
  // v0.6.12 多 ownSet / ownAuto：面板设置页要回显「现在这个 own 是钉的还是猜的」，光给一个 own 说不清来源
  eq('series 视图的形状（面板画图只吃这个，不吃 core 内部的存储对象；v0.6.11 多 rank = 每人最新两行，v0.6.12 多 ownSet/ownAuto）',
    Object.keys(gst.series).sort().join(','), 'counts,err,handles,imp,key,lastRewards,min,own,ownAuto,ownSet,rank');
  ok('handles/rank 每人带 own 标记，rank 带 last+prev（排名要「较上日净增」，只给一行算不出增减）',
    gst.series.handles.every((h) => 'own' in h) && gst.series.rank.length === gst.series.handles.length &&
    gst.series.rank.every((r) => 'last' in r && 'prev' in r), [gst.series.handles, gst.series.rank]);
  ok('own 是字符串：认不到就留空，面板提示「先进一次自己的主页」（强判据见 [8g]）', typeof gst.own === 'string', gst.own);

  const fab = IDS['ysy-xprobe-ext-fab'];
  const injected = sb.__created;
  eq('页面里我只造一根玻璃柱：柱容器 + 关/榜/回/杆/帖/稿/观七颗（v0.9.5 柱内多三个不带 id 的常驻件：内嵌样式/探针点/分隔线，两张窗口仍只在点开时存在；v0.11.4 第七颗「回帖」造出来就藏在柱里，本机模型那颗闸开着才 display:flex）',
    injected.filter((e) => e.id).map((e) => e.id), ['ysy-xprobe-ext-bar', 'ysy-xprobe-ext-fbtn', 'ysy-xprobe-ext-cbtn',
      'ysy-xprobe-ext-hotbtn', 'ysy-xprobe-ext-rbtn', 'ysy-xprobe-ext-bbtn', 'ysy-xprobe-ext-bpbtn', 'ysy-xprobe-ext-aibtn', 'ysy-xprobe-ext-fab']);
  ok('第七颗「稿」（AI 回帖）在闸关着时是藏着的（display:none，不是一个字都不发的那种「没做」）：默认关 = 页面上找不到它',
    !!IDS['ysy-xprobe-ext-aibtn'] && IDS['ysy-xprobe-ext-aibtn'].style.display === 'none'
      && IDS['ysy-xprobe-ext-aibtn'].textContent === '稿', IDS['ysy-xprobe-ext-aibtn'] && IDS['ysy-xprobe-ext-aibtn'].style.display);
  eq('六颗钮各管各的（方案 A 单字）：关=本页用户名单、榜=曝光榜卡片、回=待回关、杆=按人的窗口、帖=按条的窗口（灯的三态在下面两条钉；第七颗「稿」归 v0.11.4，判据在段 [35]）',
    [IDS['ysy-xprobe-ext-fbtn'].textContent, IDS['ysy-xprobe-ext-cbtn'].textContent,
      IDS['ysy-xprobe-ext-rbtn'].textContent, IDS['ysy-xprobe-ext-bbtn'].textContent.slice(0, 2),
      IDS['ysy-xprobe-ext-bpbtn'].textContent.slice(0, 2)], ['关', '榜', '回', '杆', '帖']);
  ok('到限时灯变红底读秒（只警告，不拦点击；v0.8.15 起「限」这个字换成还要等多久：秒/分/小时三档；v0.9.5 红字在 label span 上）',
    !!fab && /^(\d{1,3}|\d{1,2}[mh])$/.test(fab.textContent) && fab.children[0].style.color === '#e06c60',
    fab && [fab.textContent, fab.children[0].style.color]);
  eq('不再有「隐藏面板」这回事：没有面板节点也没有隐藏标记', [IDS['ysy-xprobe-panel'], store['ysy.xprobe.hidden']], [undefined, undefined]);
  xp.getGuard().follows = []; xp.fabBtn();
  eq('额度回来了就变回「观」（同一颗按钮两个状态）', IDS['ysy-xprobe-ext-fab'].textContent, '观');
  const nRt = sb.__rtMsgs.length;
  IDS['ysy-xprobe-ext-fab'].fire('click');
  eq('点守卫灯=发开面板请求（v0.8.5 起灯不再兼职开关卡片），且不挂任何卡片/名单节点',
    [sb.__rtMsgs.length - nRt, sb.__rtMsgs[sb.__rtMsgs.length - 1], IDS['ysy-xprobe-ext-card'], IDS['ysy-xprobe-ext-flist']],
    [1, { t: 'openPanel' }, undefined, undefined]);
  IDS['ysy-xprobe-ext-cbtn'].fire('click');
  const card = IDS['ysy-xprobe-ext-card'];
  ok('点「榜」=开「本页曝光榜」卡片，不再发请求（卡片归榜钮管）', !!card && sb.__rtMsgs.length === nRt + 1, !!card);
  ok('列表页没有帖子：卡片老实说没有，不编一条空榜出来', /本页没有带观看数的帖子/.test(card.textContent), card.textContent.slice(0, 80));
  card.querySelectorAll('button').find((b) => b.textContent === '详').fire('click');
  eq('卡片头「详」也给 SW 发一条开面板请求', [sb.__rtMsgs.length - nRt, sb.__rtMsgs[sb.__rtMsgs.length - 1]], [2, { t: 'openPanel' }]);
  card.querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('收起卡片=整棵从页面摘掉（常驻注入回到四颗钮）', [IDS['ysy-xprobe-ext-card'], !!IDS['ysy-xprobe-ext-cbtn']], [undefined, true]);
  IDS['ysy-xprobe-ext-cbtn'].fire('click');
  ok('再点「榜」卡片再开（关了还能再开；打开时挂进来的才是第二棵子树）', !!IDS['ysy-xprobe-ext-card'], !!IDS['ysy-xprobe-ext-card']);
  IDS['ysy-xprobe-ext-card'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  eq('测完收摊：页面回到只有四颗钮', IDS['ysy-xprobe-ext-card'], undefined);

  // 命令通道：Side Panel 的每条命令都经 runCmd 回到 content script，返回值带最新 state
  eq('未知命令明确报错，不静默', [sb.__toCore({ t: 'nope' }).ok, /未知命令/.test(sb.__toCore({ t: 'nope' }).err)], [false, true]);
  const q1 = sb.__toCore({ t: 'query', v: 'aaa' });
  ok('查表命令返回本地表结果 + 新 state', q1.ok && q1.result.users.length === 1 && !!q1.state.counts, [q1.ok, q1.result && q1.result.users.length]);
  ok('别人的扩展伪造消息进不来（只认自己 extension id）', [sb.__toCore({ t: 'state' }, 'other-ext-id'), sb.__toCore({ t: 'export' }, 'other-ext-id')], [undefined, undefined]);

  xp.setDumpOn(true);
  xp.captureDump({ force: true });
  const dbody = JSON.parse(sb.__calls.filter((c) => /\/dump$/.test(c.url)).pop().body);
  ok('浮标/钮排不会被读成页面结构（连它们自己的 title 也不进树）', !/ysy-xprobe-fab/.test(dbody.tree) && !/点这里发开 Side Panel 详面板/.test(dbody.tree), dbody.tree.split('\n').slice(0, 6));
  delete store['ysy.xprobe.dump'];

  xp.doCollect({ force: true });
  const qu = xp.queryStores('aaa');
  ok('用户表：following 页首次出现 ⇒ 记 seenAs.following 时刻，关系也存',
    qu.users.length === 1 && qu.users[0].relation === 'following' && !!qu.users[0].seenAs.following, qu.users);
  eq('列表页不把页主当列表行（这一页只进 aaa/bbb 两行）', Object.keys(xp.getUsers()).filter((k) => k !== 'demo_own').sort(), ['aaa', 'bbb']);
  sb.__runTimers(3);
  ok('两张表落 GM 存储（不在 x.com 的 IndexedDB 里）', !!store['ysy.xprobe.users'] && !!store['ysy.xprobe.posts'], Object.keys(store));

  delete store['ysy.xprobe.guard'];
  const sb2 = run(profile, '/demo_own', 'https://x.com/demo_own');
  sb2.__runTimers(2);
  const u0 = sb2.__xprobe.getUsers()['demo_own'];
  ok('主页快照进用户表：可见文本的精确粉丝/关注数直接入库',
    u0 && u0.following === 2578 && u0.followers === 2978 && u0.followersExact === true && u0.relation === 'following', u0);
  eq('数字没变化就不堆同一个采样点', u0.hist.length, 1);
  const flip = profile.querySelector('[data-testid="987654321-follow"]');
  const fa = profile.querySelector('a[href="/demo_own/following"]');
  fa.textContent = '2,580 正在关注';
  flip.attrs['data-testid'] = '987654321-unfollow'; flip.attrs['aria-label'] = '正在关注 @demo_own';
  sb2.__xprobe.onMutations([{ type: 'attributes', target: flip }]);
  sb2.__runTimers(4);
  eq('关注动作后自动重读那两个数（实时更新）', sb2.__xprobe.getUsers()['demo_own'].following, 2580);
  fa.textContent = '2,585 正在关注';
  const flip2 = profile.querySelector('[data-testid="1493114391747006467-unfollow"]');
  flip2.attrs['data-testid'] = '1493114391747006467-follow'; flip2.attrs['aria-label'] = '关注 @demo_own';
  sb2.__xprobe.onMutations([{ type: 'attributes', target: flip2 }]);
  sb2.__runTimers(4);
  sb2.__xprobe.flush();
  const statRec = postedRecords(sb2).filter((r) => r.kind === 'stat').pop() || {};
  ok('数字真变了才补一条 stat 记录（不刷屏）', statRec.kind === 'stat' && statRec.data.following === 2585 && statRec.data.reason === 'unfollow', statRec);
  fa.textContent = '2,578 正在关注';
  flip.attrs['data-testid'] = '987654321-follow';
  flip2.attrs['data-testid'] = '1493114391747006467-unfollow';

  const sb3 = run(tweetPage, '/demo_own/status/555', 'https://x.com/demo_own/status/555');
  sb3.__runTimers(2);
  const p555 = sb3.__xprobe.getPosts()['555'];
  ok('帖子表：tweetId 为键，带互动数与「我第一次见到它」的时刻（口径同 page 记录：聚合 aria 优先）',
    p555 && p555.like === 9 && p555.view === 122 && p555.reply === 11 && !!p555.firstSeenAt, p555);
  sb3.__xprobe.doCollect({ force: true });
  const p2 = sb3.__xprobe.getPosts()['555'];
  ok('新帖判据 = 键首次出现；再采一次 firstSeenAt 不变、次数 +1', p2.firstSeenAt === p555.firstSeenAt && p2.n >= 2, p2);

  // 两张表存在扩展自己的 GM 存储里，页面 origin 读不到 ⇒ 离线分析只能靠「导出 JSON」这个本地下载
  const exp = JSON.parse(sb3.__xprobe.buildExport());
  ok('导出里带两张表与守卫流水（build 也在，便于确认导出来自哪一版）',
    !!exp.users['demo_own'] && !!exp.posts['555'] && Array.isArray(exp.guard.follows) && exp.build === SRC_BUILD,
    Object.keys(exp));

  console.log('  [11x] 反检测红线（静态正向对照：这些写法一个都不许出现）');
  // 整行注释先去掉：我自己的注释里就写着「绝不在脚本里 indexedDB.open()」，不去掉会把散文当成调用扫出来
  const codeOnly = src.replace(/^\s*\/\/.*$/gm, '');
  ok('不派发合成事件', !/dispatchEvent\s*\(/.test(codeOnly) && !/new\s+(Mouse|Pointer|Keyboard|CustomEvent)\b/.test(codeOnly), '');
  ok('不开页面 origin 的库（无 indexedDB 调用 / 无 localStorage 写入）', !/indexedDB/.test(codeOnly) && !/localStorage/.test(codeOnly), '');
  ok('不 hook XHR、不写 cookie', !/XMLHttpRequest\b/.test(codeOnly.replace(/GM_xmlhttpRequest/g, '')) && !/document\.cookie\s*=/.test(codeOnly), '');
  ok('不拦点击（无 preventDefault / stopPropagation）', !/preventDefault|stopPropagation/.test(codeOnly), '');
  ok('守卫不向 X 发任何请求：全文出现的外部地址只有回环与 x 的域名本身', (src.match(/https?:\/\/[^'"\s]+/g) || []).every((u) => /127\.0\.0\.1|localhost|x\.com|twitter\.com/.test(u)), (src.match(/https?:\/\/[^'"\s]+/g) || []));
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts', 'ysy.xprobe.hidden'].forEach((k) => delete store[k]);
}

console.log('\n[11b] v0.6.8：调试开关 + 随机加时上限的命令通道（面板 ↔ SW ↔ core）');
{
  const sb = run(profile, '/demo_own', 'https://x.com/demo_own');
  const xp = sb.__xprobe;
  const s0 = sb.__toCore({ t: 'state' }).state;
  eq('调试开关默认是关的（面板按它决定给不给「调试」入口）', s0.debug.on, false);
  delete store['ysy.xprobe.randMax'];
  eq('随机加时上限默认 20 秒', s0.rndMax, 20);
  ok('开调试：state 回读为真、GM 键落盘', (() => {
    const r = sb.__toCore({ t: 'setDebug', v: true });
    return r.ok && r.state.debug.on === true && store['ysy.xprobe.debug'] === true;
  })(), store['ysy.xprobe.debug']);
  ok('上限改 45：state 即刻按新值回读、GM 落盘', (() => {
    const r = sb.__toCore({ t: 'setRndMax', v: 45 });
    return r.ok && r.state.rndMax === 45 && store['ysy.xprobe.randMax'] === 45;
  })(), store['ysy.xprobe.randMax']);
  eq('上限夹在 0..300（9999 不许把冷却弄成半小时量级）', sb.__toCore({ t: 'setRndMax', v: 9999 }).state.rndMax, 300);
  eq('上限留空 = 回默认 20', sb.__toCore({ t: 'setRndMax' }).state.rndMax, 20);
  xp.doCollect({ force: true });
  const dbgRecs = () => postedRecords(sb).filter((r) => r.kind === 'debug');
  const rDb = sb.__toCore({ t: 'debugRec' });
  ok('debugRec 不崩且当轮就有结果', rDb.ok && rDb.result && rDb.result.caps.rndMax === 20, rDb.err);
  xp.flush();
  const nOn = dbgRecs().filter((r) => r.data && r.data.why === 'on').length;
  const drec = dbgRecs().filter((r) => r.data && r.data.why === 'panel').pop() || {};
  eq('开调试当场落 why=on 一条（不等人点诊断页），面板那眼落 why=panel 一条：env/守卫/计数/上限/命中率都在（下一轮拿它对表）',
    [ nOn >= 1, drec.data && drec.data.env.tab, drec.data && drec.data.guard.f15 != null,
      drec.data && drec.data.counters.users != null, drec.data && drec.data.caps.rndMax, !!(drec.data && drec.data.last && drec.data.last.cov) ],
    [true, 'profile', true, true, 20, true]);
  ok('关调试：state 回读为假、GM 键也被拨回去', (() => {
    const r = sb.__toCore({ t: 'setDebug', v: false });
    return r.ok && r.state.debug.on === false && store['ysy.xprobe.debug'] === false;
  })(), store['ysy.xprobe.debug']);
  // v0.6.9 收尾：真机 2026-10-23 实测「调试页开着，kind=debug 却一条没落」——面板的 debugRec 打进了
  // 旧 content script 的标签页，只回「未知命令」。兜底：只要开关开着，新 core 的 boot 自己落一条，不靠面板。
  store['ysy.xprobe.debug'] = true;
  const sbBoot = run(profile, '/demo_own', 'https://x.com/demo_own');
  sbBoot.__xprobe.flush();
  const bootDbg = postedRecords(sbBoot).filter((r) => r.kind === 'debug');
  ok('debug 开着，boot 自报一条 kind=debug（why=boot，env/caps 都在）',
    bootDbg.length >= 1 && bootDbg[0].data.why === 'boot' && bootDbg[0].data.env && bootDbg[0].data.caps.rndMax === 20,
    bootDbg.map((r) => r.data && r.data.why));
  ['ysy.xprobe.debug', 'ysy.xprobe.randMax', 'ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts'].forEach((k) => delete store[k]);
}

console.log('\n[11c] 多页签倒计时同频（v0.6.9 收尾）：A 页关注一次，B 页的冷却必须跟上同一份账');
{
  // 共享存储先放一份起跑账（30 秒前关注过、本轮全 65s）：两个沙箱 boot 时读到的就是同一份
  const t0 = Date.now();
  store['ysy.xprobe.guard'] = { follows: [t0 - 30000], unfollows: [], ev: [], cool: { at: t0 - 30000, full: 65000, rnd: 5 } };
  const sbA = run(profile, '/demo_own', 'https://x.com/demo_own');
  const sbB = run(profile, '/finanzasargy', 'https://x.com/FinanzasArgy');
  const A = sbA.__xprobe, B = sbB.__xprobe;
  sbA.Math.random = () => 0.25;   // A 页这次关注抽到 0.25 → 加时 5s ⇒ 本轮全 65s
  const b1 = profile.querySelector('[data-testid="987654321-follow"]');
  A.onFollowSeen(b1, 'attr');     // 基线
  b1.attrs['data-testid'] = '987654321-unfollow'; b1.attrs['aria-label'] = '正在关注 @demo_own';
  A.onFollowSeen(b1, 'attr');     // 翻转 = A 页关注一次（写共享账 + 抽本轮加时）
  const t1 = Date.now();
  const gA = A.guardStatus(t1), gB0 = B.guardStatus(t1);
  ok('B 页还没吃进 A 的新账 ⇒ 两页倒计时确实不一致（同一时钟对出来的差距就是病灶）',
    gA.coolLeft > 60000 && gB0.coolLeft < 40000 && gA.coolLeft > gB0.coolLeft + 20000,
    { A: gA.coolLeft, B: gB0.coolLeft });
  B.syncGuardRemote();
  const gB1 = B.guardStatus(t1);
  ok('sync 后同频：coolLeft 逐毫秒相等（同一时钟）、f15 同为 1、本轮全同为 65s（随机加时跟着账本走）',
    [gB1.coolLeft === gA.coolLeft, gB1.f15, gB1.coolFull, gB1.coolFull === gA.coolFull],
    [gB1.coolLeft === gA.coolLeft, gB1.f15, gB1.coolFull, gB1.coolFull === gA.coolFull]);
  const t3 = t1 + 1000;   // 一秒后节拍器/面板再看得见时，只变秒数不变账本
  ok('一秒后两页仍只差时钟（不差账本）',
    A.guardStatus(t3).coolFull === B.guardStatus(t3).coolFull &&
    A.guardStatus(t3).coolLeft === B.guardStatus(t3).coolLeft,
    { A: A.guardStatus(t3).coolLeft, B: B.guardStatus(t3).coolLeft });
  // 反向：B 页自己也关注一次 ⇒ A 这边吃进 B 的更新，而不是把自己的旧账盖回去
  const b2 = h('button', { 'data-testid': '1251127925195378690-follow', 'aria-label': '关注 @FinanzasArgy' }, [T('关注')]);
  B.onFollowSeen(b2, 'attr');
  b2.attrs['data-testid'] = '1251127925195378690-unfollow'; b2.attrs['aria-label'] = '正在关注 @FinanzasArgy';
  B.onFollowSeen(b2, 'attr');
  const t4 = Date.now();
  A.syncGuardRemote();
  const gA2 = A.guardStatus(t4), gB2 = B.guardStatus(t4);
  ok('B 页的更新 A 页也吃进（反方向同频），且 B 的 lastF 没被自己回滚',
    [gA2.coolAt === gB2.coolAt, gA2.coolLeft === gB2.coolLeft, gB2.f15], [true, true, 2]);
  ['ysy.xprobe.guard', 'ysy.xprobe.users', 'ysy.xprobe.posts'].forEach((k) => delete store[k]);
  A.setRndMax(0);   // 留下显式 0：delete 会把 randMax 冲回默认 20，[10d] 的「cool 正好 60000」就要吃随机加时（--live 才炸出来的段间残留）
  // 全局 profile 的按钮翻完要翻回来（fixture 是各段共用的）：不然 --live 的 [10] 按旧 testid 找不到它当场崩——
  // 这是本轮 --live 才炸出来的自身伪 bug（dry-run 里按钮变成 unfollow 也照样查得到别的东西，所以一直是绿的）
  b1.attrs['data-testid'] = '987654321-follow'; b1.attrs['aria-label'] = '关注 @demo_own';
}

console.log('\n[11d] 面板取 state 前先吃进共享台账（v0.7.0 修「关注后横幅还绿着」）');
{
  // 起跑账：十分钟前关注过一次（冷却早过了 ⇒ 绿）。两个沙箱都在「另一个标签页还没关注」时 boot。
  const t0 = Date.now();
  store['ysy.xprobe.guard'] = { follows: [t0 - 600000], unfollows: [], ev: [], cool: { at: t0 - 600000, full: 66000, rnd: 6 } };
  // 换行符不写死：脱敏脚本把 core.js 重存成了 CRLF，写死 \n 的针会静默抠不掉（正向对照就成了空断言）
  const EOL = src.includes('\r\n') ? '\r\n' : '\n';
  const syncLine = '      try { syncGuardRemote(); } catch (e) { /* 读不到别家的账也不该让面板整页空白 */ }' + EOL;
  const srcNoSync = src.replace(syncLine, '');
  ok('正向对照的前提：这一行真能从源码里抠掉（抠不掉后面那条对照就是空断言）',
    srcNoSync !== src && !srcNoSync.includes('读不到别家的账也不该让面板整页空白'), [src.length, srcNoSync.length]);
  const sbStay = run(profile, '/demo_own', 'https://x.com/demo_own');          // 新写法
  const sbCtl = runSource(srcNoSync, profile, '/demo_own', 'https://x.com/demo_own');   // 旧写法
  eq('两个沙箱 boot 时读到的是同一份旧账（都是绿灯起点）',
    [sbStay.__toCore({ t: 'state' }).state.guard.coolAt, sbCtl.__toCore({ t: 'state' }).state.guard.coolAt],
    [t0 - 600000, t0 - 600000]);

  // 另一个标签页刚关注了一次：只写共享台账，两个沙箱的内存账都没动（真机就是「面板问的那页在后台被节流」）
  const t1 = Date.now();
  store['ysy.xprobe.guard'] = { follows: [t0 - 600000, t1], unfollows: [], ev: [], cool: { at: t1, full: 66000, rnd: 6 } };
  const sStay = sbStay.__toCore({ t: 'state' }).state.guard;
  ok('面板问到的就是红的：coolAt/coolFull/剩余秒数全按共享台账（这一页自己没关注过也算）',
    sStay.coolAt === t1 && sStay.coolFull === 66000 && sStay.coolLeft > 60000,
    [sStay.coolAt === t1, sStay.coolFull, sStay.coolLeft]);
  const lineStay = V.coolLine({ guard: sStay }, Date.now());
  ok('同一条 state 经 view 层出醒目的红色倒计时（不是一句空横幅）',
    lineStay.sty === 'bad' && /不要关注/.test(lineStay.text) && /倒计时/.test(lineStay.text), lineStay);
  const sCtl = sbCtl.__toCore({ t: 'state' }).state.guard;
  eq('正向对照：没有那一行时同一问法回的还是 boot 时的旧账（横幅就一直绿着 —— 这正是用户看到的现象）',
    [sCtl.coolAt, V.coolLine({ guard: sCtl }, Date.now()).sty], [t0 - 600000, 'ok']);
  delete store['ysy.xprobe.guard'];
}

// ---------------- 扩展自己的三层：manifest / 宿主适配层 / service worker ----------------
// 这三层是插件模式新增的面，油猴版没有对应物，所以是新增断言而不是改写旧的。
// 它们都靠 Promise，故放在一个 async IIFE 里；最后的合计打印等它跑完（layersDone）。
const tick = () => new Promise((r) => setTimeout(r, 0));
const layersDone = (async function () {
  const rd = (p) => fs.readFileSync(path.join(__dirname, 'extension', p), 'utf8');

  console.log('\n[12] manifest：权限收到最小（这条是「不能让 X 发现」的声明层边界）');
  {
    let mf = null, parseErr = '';
    try { mf = JSON.parse(rd('manifest.json')); } catch (e) { parseErr = e.message; }
    ok('manifest.json 是合法 JSON（Chrome 加载失败我只会在错误页看见，这里必须先过）', !!mf, parseErr);
    if (mf) {
      eq('MV3', mf.manifest_version, 3);
      eq('清单上的版本号与 core 的 VER 对得上（chrome://extensions 里看到的必须是真跑的这份）', mf.version, SRC_VER);
      // v0.11.17：description 是给用户的第一句承诺。总纲先前还写「不注入脚本」，可清单里明摆着
      // 两份 content_scripts（第二份是 MAIN world 的 bridge.js），且 bridge.js 自 v0.11.8 起对
      // fetch/XHR 只读旁听 ⇒ 承诺与实现漂了十个版本。只钉「总纲」（到云模式那句为止）：
      // 后面的 v0.x 段落是变更史，允许引用旧措辞，别把它们也判成错。
      const lead = String(mf.description || '').split('用户可在设置里')[0];
      ok('description 总纲不许再许「不注入脚本 / 不拦 fetch / 不包 XHR」（两份注入 + 只读旁听是既有事实）',
        !/不注入脚本|不拦 fetch|不包 XHR/.test(lead), lead.slice(0, 140));
      ok('description 总纲把当前形状说清：两份内容脚本 + 主世界只读信使 + fetch/XHR 只读旁听原样放行',
        /两份内容脚本/.test(lead) && /只读信使/.test(lead) && /只读旁听/.test(lead) && /原样放行/.test(lead),
        lead.slice(0, 140));
      // v0.7.0 加了 nativeMessaging：它只能连本机注册过的宿主（com.yunxiao.xprobe），
      // 读不到页面、也发不出任意请求 —— 比 host_permissions 更窄，所以仍然要逐项白名单。
      // v0.7.1：加 unlimitedStorage —— chrome.storage.local 默认 10MB，队列是唯一的增长项，
      // sink 断线时靠它兜住积压；它只放开配额，不增加任何读取页面/网络的能力。
      // v0.8.0：加 alarms —— 只给云同步的 30 分钟兜底节拍，不碰任何页面/网络能力。
      eq('权限只有 storage/unlimitedStorage/sidePanel/tabs/nativeMessaging/alarms',
        (mf.permissions || []).slice().sort(), ['alarms', 'nativeMessaging', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage']);
      ok('没申请 webRequest/cookies/scripting/debugger/management（能读页面就能改页面的那几个一个都不要）',
        !(mf.permissions || []).some((p) => /webRequest|cookies|scripting|debugger|management|clipboard|downloads|notifications/.test(p)), mf.permissions);
      // v0.8.0 云同步：host_permissions 多出且**只多出** https://m.mingzhang.cc/*（用户在设置里显式打开
      // 云同步并登录后，SW 才会往那儿发「我的」指标；关着的时候 SW 云函数一律空跑）。x.com 依旧一个都没有。
      // v0.9.9 出本机的域名从两条收成一条：`m.mingzhang.cc` 是 Next.js 前端，它的 `/api/*` 不在 rewrites 里，
      // 真机点「发验证码」收到的是前端页面的 HTML 404 —— 登录与上送本来都挂在 api2（同一个 boot4 应用）
      // ⇒ 那条 m. 的 host_permission 成了没人用的权限，按 RL-3 一并摘掉（申请了不用也是扩权）。
      const HP_SINK = /^https?:\/\/(127\.0\.0\.1|localhost):8765\/\*$/, HP_CLOUD = /^https:\/\/api2\.mingzhang\.cc\/\*$/;
      // v0.10.0 多一条 http://127.0.0.1:28081/*：「云端接口」切到本机 dev 时，SW 要打得进用户自己正在跑的
      // boot4（端口抄 boot4 的 application-dev.yml，不是猜的）。它是回环、不是又一条外部域名，
      // 而且只有 SW 用得上——core 的 xhr 那条通道仍只认 8765（下面那条判据钉着），页面 JS 借不到这条权限。
      const HP_DEV = /^http:\/\/127\.0\.0\.1:28081\/\*$/;
      eq('host_permissions = 本机回环三条（sink 两条 + 自家 dev boot4 一条）+ 云域名一条（两档地址写死在 SW 枚举里，面板填不进第三档）',
        (mf.host_permissions || []).slice().sort().map((p) => HP_DEV.test(p) ? 'dev' : HP_SINK.test(p) ? 'loop' : HP_CLOUD.test(p) ? 'cloud' : p),
        ['dev', 'loop', 'loop', 'cloud']);
      ok('没有 <all_urls> 也没有通配 host（出本机的只有 api2 这一条精确域，其余全是回环）', JSON.stringify(mf).indexOf('<all_urls>') < 0 &&
        (mf.host_permissions || []).every((p) => HP_SINK.test(p) || HP_DEV.test(p) || HP_CLOUD.test(p)), mf.host_permissions);
      const cs = (mf.content_scripts || [])[0] || {};
      eq('注入范围只有 x/twitter 两个域名本身', cs.matches, ['https://x.com/*', 'https://twitter.com/*']);
      eq('先 host-shim 再 core（core 同步用 GM_* 名字，且等 __XP_HOST_READY__）', cs.js, ['content/host-shim.js', 'content/core.js']);
      // v0.11.7 第二份注入：主世界的只读信使（React fiber 里 X 自带的关系读数，isolated world 读不到）。
      // 声明层钉死它的形状：world=MAIN、document_start、只挂 bridge.js 一份、同一个注入范围。
      // 它的「只读」没有 API 可查 ⇒ 用 [36] 的行为断言 + 这里的源码字面判据一起钉（拦网络/覆写原型/常驻活动一个不许有）。
      eq('v0.11.7 注入一共两份：isolated（host-shim+core）之外只有主世界 bridge.js 一份', mf.content_scripts.length, 2);
      const cb = (mf.content_scripts || [])[1] || {};
      eq('第二份 = bridge.js @ document_start + MAIN world，范围与第一份一致',
        [cb.js, cb.run_at, cb.world, cb.all_frames, cb.matches],
        [['content/bridge.js'], 'document_start', 'MAIN', false, ['https://x.com/*', 'https://twitter.com/*']]);
      {
        const bsrc = rd('content/bridge.js');
        // v0.11.8 判据改口径：参考插件的三条源全搬（fetch/XHR 只读旁听 + store + fiber），红线从
        // 「不碰 fetch/XHR」改成「只读旁听」——包一层、clone 回包来读、请求与响应原样放行；
        // 禁的换成了改请求/换响应/常驻活动/DOM 写入口（RL-2 的边界没动：绝不发自己的请求）。
        ok('bridge.js 是只读旁听：window.fetch 必须是 async 包装 + clone() 回包 + 原样 return，XHR 只在 open 上加监听',
          /window\.fetch\s*=\s*async/.test(bsrc) && /\.clone\(\)/.test(bsrc) && /return res;/.test(bsrc)
          && /XMLHttpRequest\.prototype\.open/.test(bsrc), '');
        ok('bridge.js 不改请求不换响应：new Response/new Request/abort/redirect 一个不许有',
          !/new Response|new Request|\.abort\(|Response\.redirect|Response\.error/.test(bsrc), '');
        ok('bridge.js 没有观察器/定时器/原型改写/DOM 写入口（旁听之外零常驻活动，RL-2）',
          !/MutationObserver|setInterval|setTimeout|new Proxy|Object\.defineProperty|__lookupSetter__/.test(bsrc)
          && !/appendChild|innerHTML|insertBefore|removeChild|setAttribute/.test(bsrc), '');
        ok('bridge.js 只认自家记号（别人的 postMessage 一个字不读），问询带 handles 只回点名的人（回包不再无界）',
          bsrc.indexOf('ysy-xprobe-rel-bridge') >= 0 && /d\.handles/.test(bsrc) && /slice\(0,\s*80\)/.test(bsrc), '');
      }
      eq('document_idle + 不进 iframe（iframe 里再跑一份会把计数拆散）', [cs.run_at, cs.all_frames], ['document_idle', false]);
      ok('没有声明式网络规则 / 没有 CSP 覆写 / 没有 externally_connectable（那三个都能把流量引出本机）',
        !mf.declarative_net_request && !mf.content_security_policy && !mf.externally_connectable, Object.keys(mf));
      const need = ['manifest.json', 'background/sw.js', 'content/host-shim.js', 'content/core.js', 'content/bridge.js',
        'ui/sidepanel.html', 'ui/sidepanel.css', 'ui/sidepanel.js', 'ui/view.js'];
      eq('manifest 之外还得有 action+side_panel 两项指向磁盘上真存在的文件',
        need.filter((p) => !fs.existsSync(path.join(__dirname, 'extension', p))), []);
      eq('side_panel.default_path 与 action 都对得上文件', [mf.side_panel.default_path, !!mf.action.default_title], ['ui/sidepanel.html', true]);
      const html = rd('ui/sidepanel.html');
      ok('面板 html 只引本地文件（外链脚本 = 远程代码，MV3 直接拒载且是detectable）',
        !/<script[^>]+src=["']https?:/.test(html) && !/<link[^>]+href=["']https?:/.test(html), html.match(/src=|href=/g));
      // 注释里出现文件名不算「引了一次」——先剥掉 <!-- --> 再比脚本顺序（v0.9.8 的说明注释就写了 sidepanel.js）
      const htmlNoCmt = html.replace(/<!--[\s\S]*?-->/g, '');
      ok('面板 html 把 view.js 排在 sidepanel.js 之前',
        htmlNoCmt.indexOf('view.js') >= 0 && htmlNoCmt.indexOf('view.js') < htmlNoCmt.indexOf('sidepanel.js'), '');
      ok('正向对照：把两个 script 标签换了顺序（view 依赖先加载这条断了），上面那条当场变红',
        (function () {
          const swapped = htmlNoCmt.replace('<script src="view.js"></script>', '@@V@@')
            .replace('<script src="sidepanel.js"></script>', '<script src="view.js"></script>')
            .replace('@@V@@', '<script src="sidepanel.js"></script>');
          return swapped.indexOf('view.js') > swapped.indexOf('sidepanel.js');
        })(), '');
    }
  }
  console.log('\n[13] 宿主适配层 host-shim：同步读 / 乐观写并采纳合并值 / 回环白名单');
  const shimSrc = rd('content/host-shim.js');
  function runShim(items, reply, o) {
    const opt = o || {};
    const sent = [], chg = [];
    const setWrites = [];
    const rt = {
      lastError: null,
      sendMessage(m, cb) {
        sent.push(m);
        if (opt.noSw) { rt.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }; if (cb) cb(undefined); rt.lastError = null; return; }
        if (cb) cb(reply ? reply(m) : { ok: true });
      },
    };
    const ctx = {
      chrome: {
        runtime: rt,
        storage: {
          local: {
            get(sel, cb) { if (typeof sel === 'function') { cb(undefined); return; } try { cb(items); } catch (e) { throw e; } },
            // 真 chrome 在超配额时是把错误塞进回调里读到的 chrome.runtime.lastError；
            // 不带回调的那次调用，错误只会变成控制台里的 "Unchecked runtime.lastError"（本次事故的原话）
            set(obj, cb) {
              setWrites.push({ o: obj, hasCb: typeof cb === 'function' });
              if (opt.setErr) rt.lastError = { message: opt.setErr };
              if (cb) cb();
              rt.lastError = null;
            },
          },
          onChanged: { addListener(f) { chg.push(f); } },
        },
      },
      setTimeout, clearTimeout, console, TextEncoder,
    };
    vm.runInNewContext(shimSrc, ctx);
    ctx.__sent = sent; ctx.__setWrites = setWrites;
    ctx.__change = (changes, area) => chg.forEach((f) => f(changes, area));
    return ctx;
  }
  {
    const sc = runShim({ 'ysy.xprobe.guard': { follows: [7] }, 'ysy.xprobe.dump': true });
    await tick();
    ok('水合后同步读得到（core 那边全是同步 API，这就是整层存在的理由）',
      [sc.GM_getValue('ysy.xprobe.guard', null), sc.GM_getValue('ysy.xprobe.dump', false)], [{ follows: [7] }, true]);
    eq('没这个键时给默认值', sc.GM_getValue('nope', 'dflt'), 'dflt');
    eq('水合不发多余请求（只 get 一次，不 set）', [sc.__sent.length, sc.__setWrites.length], [0, 0]);

    sc.GM_setValue('ysy.xprobe.guard', { follows: [7, 8] });
    eq('乐观写：本地立刻可读，不等在途的存储往返', sc.GM_getValue('ysy.xprobe.guard', null), { follows: [7, 8] });
    const m0 = sc.__sent[0];
    ok('共享键标记 shared=true 交 SW 合并（两个标签页同时记关注不该互相覆盖）',
      [m0.t, m0.shared, m0.key], ['store', true, 'ysy.xprobe.guard']);
    sc.GM_setValue('ysy.xprobe.dump', false);
    eq('非共享键原样落，不合并', [sc.__sent[1].shared, sc.__sent[1].value], [false, false]);
    await tick();

    const sc2 = runShim({}, (m) => (m && m.t === 'store' ? { ok: true, merged: { follows: [1, 2, 3] } } : { ok: true }));
    sc2.GM_setValue('ysy.xprobe.guard', { follows: [3, 4] });
    await tick();
    eq('采纳 SW 合并后的值（我这边看到的就是全量，下一轮不会又写回半份）', sc2.GM_getValue('ysy.xprobe.guard', null), { follows: [1, 2, 3] });

    sc2.__change({ 'ysy.xprobe.users': { newValue: { aaa: { handle: 'aaa' } } } }, 'local');
    eq('别的标签页写完，这边的缓存跟着变', sc2.GM_getValue('ysy.xprobe.users', null), { aaa: { handle: 'aaa' } });
    sc2.__change({ 'ysy.xprobe.dump': { newValue: undefined } }, 'local');
    eq('newValue  undefined ⇒ 当删除处理', sc2.GM_getValue('ysy.xprobe.dump', 'gone'), 'gone');
    sc2.__change({ 'ysy.xprobe.guard': { newValue: 9 } }, 'session');
    eq('非 local 区域的变更不收（session 里的东西不是我的账）', sc2.GM_getValue('ysy.xprobe.guard', null), { follows: [1, 2, 3] });

    const sc3 = runShim({}, (m) => (m.t === 'xhr' ? { status: 200, responseText: '{"ok":true,"sink":"selftest"}' } : { ok: true }));
    const nSent = sc3.__sent.length;
    const c1 = {};
    sc3.GM_xmlhttpRequest({ method: 'POST', url: 'https://x.com/i/api/graphql/xxx', data: '{}',
      onload: (r) => { c1.load = r; }, onerror: (r) => { c1.err = r; } });
    await tick();
    ok('正向对照（整层的核心红线）：指向 x.com 的请求当场拒发，且一条出站消息都不产生',
      !!c1.err && /拒发/.test(String(c1.err.msg)) && sc3.__sent.length === nSent, { err: c1.err, sent: sc3.__sent.length - nSent });
    const c2 = {};
    sc3.GM_xmlhttpRequest({ method: 'POST', url: 'http://127.0.0.1:8765/log', data: '{"a":1}',
      onload: (r) => { c2.load = r; }, onerror: (r) => { c2.err = r; } });
    await tick();
    ok('回环放行并中继（status/responseText 映射回 GM 那套回调）',
      c2.load && c2.load.status === 200 && /sink":"selftest/.test(c2.load.responseText) && !c2.err, c2);
    const xm = sc3.__sent.filter((m) => m.t === 'xhr').pop();
    eq('中继消息带 method/url/data，头不带 cookie 之类', [xm.method, xm.url, xm.data], ['POST', 'http://127.0.0.1:8765/log', '{"a":1}']);

    const sc4 = runShim({}, (m) => (m.t === 'xhr' ? { err: 'connection refused' } : { ok: true }));
    const c4 = {};
    sc4.GM_xmlhttpRequest({ url: 'http://127.0.0.1:8765/log', onerror: (r) => { c4.err = r; }, onload: () => { c4.load = 1; } });
    await tick();
    ok('中继报错走 onerror（core 会把批次留在队列里重试，不静默吞）', !!c4.err && !c4.load, c4);
    const sc5 = runShim({}, (m) => (m.t === 'xhr' ? { timeout: true } : { ok: true }));
    const c5 = {};
    sc5.GM_xmlhttpRequest({ url: 'http://127.0.0.1:8765/log', ontimeout: () => { c5.to = 1; }, onerror: () => { c5.err = 1; } });
    await tick();
    eq('超时单独回调 ontimeout（和断开是两回事，面板上分开显示）', c5, { to: 1 });

    const bad = { chrome: { runtime: { sendMessage() {}, lastError: null }, storage: { local: { get() { throw new Error('storage 挂了'); } } } }, setTimeout, clearTimeout, console };
    vm.runInNewContext(shimSrc, bad);
    await tick();
    ok('storage 拿不到也要让 core 起得来（ready 必须 resolve，否则探针整个不注入）', bad.__XP_HOST_READY__ !== undefined, typeof bad.GM_getValue);
    eq('拿不到存储时读默认值而不是抛', bad.GM_getValue('ysy.xprobe.guard', null), null);

    // ---- v0.6.5：适配层给 core 记账（每键字节 + 写失败原因），并保证每次直写都带回调 ----
    const led = runShim({ 'ysy.xprobe.guard': { follows: [7] } });
    await tick();
    eq('水合就把占用量出来（配额顶穿那次是从控制台那句 lastError 才知道的，太晚）',
      [led.__XP_STORE__.measured, led.__XP_STORE__.total > 0, led.__XP_STORE__.quota], [true, true, 10485760]);
    led.GM_setValue('ysy.xprobe.k', { s: '曝光' });
    eq('字节数按 UTF-8 算，不按字符数（10MB 配额限的是字节：一个中文 = 3 字节）',
      [led.__XP_STORE__.bytes['ysy.xprobe.k'], JSON.stringify({ s: '曝光' }).length], [14, 10]);
    ok('写成功不记错，且逐键错误里没有它', led.__XP_STORE__.failed === 0 && !led.__XP_STORE__.err['ysy.xprobe.k'], led.__XP_STORE__);
    led.__change({ 'ysy.xprobe.users': { newValue: { aaa: 1 } } }, 'local');
    ok('别的标签页写完，占用账本也跟着动（面板那行不是本页的局部真相）',
      led.__XP_STORE__.bytes['ysy.xprobe.users'] > 0, led.__XP_STORE__.bytes['ysy.xprobe.users']);

    const q = runShim({}, (m) => (m && m.t === 'store' ? { ok: false, err: 'QUOTA_BYTES quota exceeded', quota: true } : { ok: true }));
    await tick();
    q.GM_setValue('ysy.xprobe.v1', [{ at: '1' }]);
    await tick();
    ok('SW 报回写失败 ⇒ 记账并点名配额（乐观写的缓存不动，core 那边读得到原因）',
      !!q.__XP_STORE__.lastErr && /quota/i.test(q.__XP_STORE__.lastErr) && q.__XP_STORE__.quotaHit === 1 && q.__XP_STORE__.failed === 1,
      q.__XP_STORE__);

    const f = runShim({ 'ysy.xprobe.guard': { follows: [7] } }, null, { noSw: true, setErr: 'Resource::kQuotaBytes quota exceeded' });
    await tick();
    f.GM_setValue('ysy.xprobe.v1', [{ at: '2' }]);
    await tick();
    ok('SW 不在（刚重载扩展）时退回直写，直写也必须带回调 ⇒ 才读得到 lastError',
      f.__setWrites.length === 1 && f.__setWrites.every((w) => w.hasCb) && /quota/i.test(f.__XP_STORE__.lastErr),
      { writes: f.__setWrites, lastErr: f.__XP_STORE__.lastErr });
    const g = runShim({}, null, { noSw: true, setErr: 'Resource::kQuotaBytes quota exceeded' });
    await tick();
    g.chrome.storage.local.set({ 'ysy.xprobe.v1': [{ at: '3' }] });   // 旧写法：不带回调
    eq('正向对照：同一份账本，不带回调的写就是看不见错误（所以 hasCb 那条判据才是关键）',
      [g.__XP_STORE__.failed, g.__XP_STORE__.lastErr], [0, '']);
    const f2 = runShim({}, null, { noSw: true });
    f2.GM_setValue('ysy.xprobe.v1', [{ at: '4' }]);
    await tick();
    ok('直写成功 ⇒ 上一次的错误被抹掉（错误不许烂尾在面板上）',
      /quota/i.test(f.__XP_STORE__.lastErr) && f2.__XP_STORE__.failed === 0 && f2.__XP_STORE__.lastErr === '', [f.__XP_STORE__.lastErr, f2.__XP_STORE__.failed]);
  }
  console.log('\n[14] service worker：共享键串行合并 / 中继只打回环 / 路由错误路径');
  const swSrc = rd('background/sw.js');
  function runSW(o) {
    const opt = o || {};
    const map = Object.assign({}, opt.store);
    const sent = [], lis = [], installed = [], nativeQ = [];
    let fetchCalls = 0, swSetCalls = 0;
    const fetchUrls = [];   // v0.10.3：登录首趟要连发三跳（codeLogin → ingest → bench/push），只看 __lastUrl 就说不清「哪条腿打到哪儿」
    const fetchReqs = [];   // 同上，但连 init 一起记（身份只许在请求头这一条要按每一跳验，不是按最后一跳）
    const ctx = {
      chrome: {
        runtime: {
          id: 'ext-self', lastError: null,
          onMessage: { addListener(f) { lis.push(f); } },
          onInstalled: { addListener(f) { installed.push(f); } },
          sendMessage() {},
          // v0.9.6 标杆同步的 payload 里带版本：真 Chrome 一定有 getManifest，沙箱补一份
          getManifest() { return { version: '9.9.9' }; },
          // v0.7.0 原生宿主桩。opt.native 缺省 = 宿主没装（Chrome 就是这么回：lastError 有、结果 undefined），
          // 'timeout' = 宿主收到但不回；{ reply:{status,body} } 或 { lastError:'…' } 都可显式给
          sendNativeMessage(host, payload, cb) {
            nativeQ.push({ host, payload });
            const n = opt.native;
            const mode = typeof n === 'function' ? n(payload) : n;
            if (mode === 'timeout') return;   // 让 SW 自己的超时兜底
            if (mode && mode.lastError) {
              setTimeout(() => { ctx.chrome.runtime.lastError = { message: mode.lastError }; cb(undefined); ctx.chrome.runtime.lastError = null; }, 0);
              return;
            }
            const r = (mode && mode.reply) || mode || {};
            setTimeout(() => cb(r), 0);
          },
        },
        storage: {
          local: {
            get(keys, cb) { const out = {}; (Array.isArray(keys) ? keys : Object.keys(map)).forEach((k) => { if (map[k] !== undefined) out[k] = map[k]; }); cb(out); },
            // 真字节由 chrome 管在这份账外；自检沙箱拿 JSON 长度近似（ASCII 恰好 1:1）
            getBytesInUse(keys, cb) {
              const ks = Array.isArray(keys) ? keys : Object.keys(map);
              let n = 0; ks.forEach((k) => { if (map[k] !== undefined) n += (JSON.stringify(map[k]) || '').length; });
              cb(n);
            },
            set(obj, cb) {
              // opt.setErr：模拟超配额那一次 —— chrome 不抛异常，错误只在回调里的 lastError 里。
              // opt.setErrFirst：只让前 N 次 set 失败（模拟配额顶穿后滚掉最旧的就腾出来 ⇒ 自愈重试要吃到这个）
              const fail = !!opt.setErr && (!opt.setErrFirst || swSetCalls < opt.setErrFirst);
              if (fail) { ctx.chrome.runtime.lastError = { message: opt.setErr }; }
              else Object.assign(map, obj);
              swSetCalls++;
              if (cb) cb();
              ctx.chrome.runtime.lastError = null;
            },
          },
        },
        tabs: {
          query(q, cb) { cb(opt.tabs || []); },
          sendMessage(id, m, cb) { sent.push({ id, m }); if (opt.tabDead) { ctx.chrome.runtime.lastError = { message: 'Frame was detached' }; cb(undefined); ctx.chrome.runtime.lastError = null; return; } if (cb) cb({ ok: true, echoed: m }); },
        },
        sidePanel: opt.noSidePanel ? undefined : { open: () => Promise.resolve('opened'), setPanelBehavior: () => Promise.resolve() },
      },
      fetch(url, init) {
        fetchCalls++;
        fetchUrls.push(String(url));
        fetchReqs.push({ url: String(url), init: init });
        ctx.__lastInit = init; ctx.__lastUrl = url;   // 云同步的判据咬 URL：出本机的地址必须写死成 api2.mingzhang.cc（v0.9.9 前是 m.，量出来那条道根本不通）
        if (opt.fetchFail) return Promise.reject(new Error(opt.fetchFail));
        if (opt.fetchAbort) { const e = new Error('The user aborted a request.'); e.name = 'AbortError'; return Promise.reject(e); }
        // opt.byUrl = 一趟之上还有好几跳时用（v0.10.3 登录首趟：codeLogin / ingest / bench/push 三种回包各不相同）。
        // 不给就还是原来那份统一回包，老段落一个字都不用改。
        if (typeof opt.byUrl === 'function') {
          const one = opt.byUrl(String(url), init) || {};
          return Promise.resolve({ status: one.status || 200, text: () => Promise.resolve(one.text || '{"ok":true}') });
        }
        return Promise.resolve({ status: opt.status || 200, text: () => Promise.resolve(opt.text || '{"ok":true}') });
      },
      AbortController: function () { const s = { aborted: false }; this.signal = s; this.abort = () => { s.aborted = true; }; },
      // SW 用 URL 拆 /db 的查询串；裸 V8 上下文里没有这个 Web API（Chrome 里有），得借宿主的
      URL: URL,
      setTimeout, clearTimeout, console,
    };
    vm.runInNewContext(opt.src || swSrc, ctx);
    ctx.__map = map; ctx.__sent = sent; ctx.__installed = installed;
    ctx.__fetchCalls = () => fetchCalls;
    ctx.__fetchUrls = () => fetchUrls.slice();
    ctx.__fetchReqs = () => fetchReqs.slice();
    ctx.__nativeQ = nativeQ;
    ctx.__send = (m, senderId) => {
      let r;
      lis.forEach((f) => f(m, { id: senderId || 'ext-self' }, (x) => { r = x; }));
      return new Promise((res) => { setTimeout(() => res(r), 0); });
    };
    // 只等 sendResponse、不等定时器：测超时那条要用（SW 的超时下限 500ms，比 __send 的那一拍晚）
    ctx.__call = (m, ms) => new Promise((res) => {
      const t = setTimeout(() => res(undefined), ms || 1500);
      lis.forEach((f) => f(m, { id: 'ext-self' }, (x) => { clearTimeout(t); res(x); }));
    });
    return ctx;
  }
  {
    const w = runSW({ tabs: [{ id: 5, url: 'https://x.com/demo_own', active: true }] });
    const r = await w.__send({ t: 'collect' });
    ok('命令路由到活动 x.com 标签页，回包原样给面板', [r && r.ok, r && r.echoed && r.echoed.t, w.__sent[0].id], [true, 'collect', 5]);
    const rNo = await runSW({ tabs: [] }).__send({ t: 'state' });
    ok('没有标签页时明说，不静默给空面板', [rNo.ok, /没有 x\.com 标签页/.test(rNo.err)], [false, true]);
    const rDead = await runSW({ tabs: [{ id: 9, url: 'https://x.com/a', active: true }], tabDead: true }).__send({ t: 'ping' });
    ok('content script 没接上（刚刷新）时报清楚，不让面板转圈', [rDead.ok, /content script 没接/.test(rDead.err)], [false, true]);
    const rForeign = await w.__send({ t: 'store', key: 'k', value: 1 }, 'another-ext');
    eq('别人的扩展发消息进来直接不理（sender.id 这一关）', [rForeign, w.__map.k], [undefined, undefined]);
    const rUnknown = await w.__send({ t: 'nope' });
    eq('不在白名单的命令不转发', rUnknown, undefined);

    const w2 = runSW({ store: { 'ysy.xprobe.guard': { follows: [30, 10], unfollows: [7], ev: [{ at: 1, dir: 'follow', id: 'x' }] } } });
    const m2 = await w2.__send({ t: 'store', shared: true, key: 'ysy.xprobe.guard', value: { follows: [20, 30], unfollows: [8], ev: [{ at: 2, dir: 'unfollow', id: 'y' }] } });
    eq('两个标签页各写半份 ⇒ 并集排序（这是丢写的那次事故的根治）',
      [m2.merged.follows, m2.merged.unfollows], [[10, 20, 30], [7, 8]]);
    eq('事件流水按 at 排且去重', m2.merged.ev.map((e) => e.at), [1, 2]);
    eq('合并结果真的写进存储了', w2.__map['ysy.xprobe.guard'].follows, [10, 20, 30]);
    const dup = await w2.__send({ t: 'store', shared: true, key: 'ysy.xprobe.guard', value: { follows: [10], unfollows: [], ev: [{ at: 1, dir: 'follow', id: 'x' }] } });
    eq('同一事件重复上报不翻倍（幂等）', [dup.merged.follows.length, dup.merged.ev.length], [3, 2]);
    // v0.6.9 F4：今日关注目标跟着 guard 台账走 —— 整体切片式合并最容易把「多出来的字段」洗掉
    const wG = runSW({ store: { 'ysy.xprobe.guard': { follows: [8], goal: { day: 'd0', base: 88, target: 400, src: 'hand', at: 5 } } } });
    const mg0 = await wG.__send({ t: 'store', shared: true, key: 'ysy.xprobe.guard', value: { follows: [9], unfollows: [], ev: [] } });
    eq('旧 core 的写入不带 goal 也不许把有效目标洗掉', (mg0.merged.goal || {}).base, 88);
    const mgN = await wG.__send({ t: 'store', shared: true, key: 'ysy.xprobe.guard', value: { follows: [9], goal: { day: 'd1', base: 90, target: 350, src: 'hand', at: 9 } } });
    eq('两页都带 goal 时取 setAt 新的那份（面板改目标当场进台账）', [mgN.merged.goal.at, mgN.merged.goal.target], [9, 350]);
    const mgO = await wG.__send({ t: 'store', shared: true, key: 'ysy.xprobe.guard', value: { follows: [9], goal: { day: 'd2', base: 1, target: 100, src: 'hand', at: 3 } } });
    eq('旧页签的旧目标不许回灌（存储里 at=9 的现有目标顶住 at=3 的来路）', mgO.merged.goal.at, 9);

    const w3 = runSW({ store: { 'ysy.xprobe.users': { aaa: { handle: 'aaa', updatedAt: 100 }, bbb: { handle: 'bbb', updatedAt: 5 } } } });
    const m3 = await w3.__send({ t: 'store', shared: true, key: 'ysy.xprobe.users', value: { aaa: { handle: 'aaa', updatedAt: 50, followers: 9 } } });
    eq('用户表按 updatedAt 取新的（旧标签页的缓存不能盖掉新的）', m3.merged.aaa.updatedAt, 100);
    eq('别的 handle 照收', Object.keys(m3.merged).sort(), ['aaa', 'bbb']);

    const w4 = runSW({ store: { 'ysy.xprobe.v1': [{ at: '1', url: 'u1' }] } } );
    const m4 = await w4.__send({ t: 'store', shared: true, key: 'ysy.xprobe.v1', value: [{ at: '1', url: 'u1' }, { at: '2', url: 'u2' }] });
    eq('采集记录按 at|url 去重后保留两条', m4.merged.length, 2);

    // v0.6.5：浏览器这边不再是原文的存放地 ⇒ SW 的留存口径跟着收窄，并且写失败必须回话
    const wR = runSW({ store: { 'ysy.xprobe.v1': Array.from({ length: 5 }, (_, i) => ({ at: 'o' + i, url: 'u' })) } });
    const mR = await wR.__send({ t: 'store', shared: true, key: 'ysy.xprobe.v1',
      value: Array.from({ length: 80 }, (_, i) => ({ at: 't' + i, url: 'u' })) });
    eq('runs 合并不再留 400 份（400 份整页快照实测 13.05MB，正是顶穿 10MB 配额那份），只留最近 60',
      [mR.merged.length, mR.merged[0].at, mR.merged[59].at], [60, 't20', 't79']);
    const wS = runSW({ store: { 'ysy.xprobe.v1': [{ at: 'a', url: 'u', slim: 1 }] } });
    const mS = await wS.__send({ t: 'store', shared: true, key: 'ysy.xprobe.v1', value: [{ at: 'a', url: 'u', tweets: [{ html: '<article>' }] }] });
    eq('同一份快照：精简行与全量并存时留全量（否则面板「本页」会莫名其妙退回精简版）',
      [mS.merged.length, mS.merged[0].slim, !!mS.merged[0].tweets], [1, undefined, true]);

    const wQ = runSW({ setErr: 'QUOTA_BYTES quota exceeded' });
    const mQ = await wQ.__send({ t: 'store', shared: false, key: 'ysy.xprobe.dump', value: true });
    ok('SW 写失败必须回话：以前这里无条件 {ok:true}，配额顶穿那几轮全靠它骗过了面板',
      mQ.ok === false && /quota/i.test(mQ.err) && mQ.quota === true, mQ);
    const mQ2 = await runSW({ store: { 'ysy.xprobe.users': { aaa: { handle: 'aaa', updatedAt: 1 } } }, setErr: 'QUOTA_BYTES quota exceeded' })
      .__send({ t: 'store', shared: true, key: 'ysy.xprobe.users', value: { bbb: { handle: 'bbb', updatedAt: 2 } } });
    ok('共享键也一样：合并结果照给（core 要知道合并成什么样），但 ok=false 与原因不许省',
      mQ2.ok === false && mQ2.quota === true && !!mQ2.merged.bbb, mQ2);

    // v0.6.6：v0.6.5 修的是「写失败要回话」，但顶穿的原因还在 —— mergeRuns 只有 60 的条数顶，
    // 「同一份快照带原文的赢」让旧全量永远瘦不回去，60 份 × 几百 KB 字节上照样顶得穿 10MB 配额。
    // 两件事：① SW 合并结果也吃 2MB 字节软顶；② 顶穿时先滚最旧的 runs 再试（原文都在 xprobe.db，自愈不丢判定数据）
    const FAT = (tag) => Array.from({ length: 3 }, (_, i) => ({ at: tag + i, url: 'u', blob: 'x'.repeat(900000) }));
    const wB = runSW({ store: { 'ysy.xprobe.v1': FAT('f') } });
    const mB = await wB.__send({ t: 'store', shared: true, key: 'ysy.xprobe.v1', value: [{ at: 'n1', url: 'u', blob: 'n'.repeat(900000) }] });
    ok('SW 合并结果也有字节软顶（数量顶 60 管不住字节：3 份旧全量 + 1 份新的 = 3.6MB，滚到 2MB 以内）',
      (JSON.stringify(mB.merged) || '').length <= 2 * 1024 * 1024 && mB.merged.length < 4 && mB.merged[mB.merged.length - 1].at === 'n1',
      { len: mB.merged.length, bytes: (JSON.stringify(mB.merged) || '').length });
    const wQ3 = runSW({ store: { 'ysy.xprobe.v1': [{ at: 'f0', url: 'u', slim: 1, blob: 'x'.repeat(900000) }] }, setErr: 'QUOTA_BYTES quota exceeded', setErrFirst: 1 });
    const mQ3 = await wQ3.__send({ t: 'store', shared: true, key: 'ysy.xprobe.v1', value: [{ at: 'n2', url: 'u', blob: 'y'.repeat(900000) }] });
    ok('配额顶穿一次 ⇒ 自愈：把最旧的运行态滚掉再试一次，成功就如实报 ok（原文在本机库，滚了不心疼）',
      mQ3.ok === true && mQ3.merged.length === 1 && mQ3.merged[0].at === 'n2', mQ3);
    const wSC = runSW({ store: { 'ysy.xprobe.v1': Array.from({ length: 10 }, (_, i) => ({ at: 'o' + i, url: 'u', blob: 'z'.repeat(300000) })) } });
    await tick(); await tick();
    const afterTrim = wSC.__map['ysy.xprobe.v1'];
    ok('SW 一醒来就把超软顶的 runs 自己滚瘦（不等下一次写失败才发现还超着——那正是控制台又刷 quota 的路线）',
      Array.isArray(afterTrim) && afterTrim.length < 10 && (JSON.stringify(afterTrim) || '').length <= 2 * 1024 * 1024 &&
      afterTrim[afterTrim.length - 1].at === 'o9',
      { len: afterTrim && afterTrim.length, bytes: afterTrim ? (JSON.stringify(afterTrim) || '').length : 0 });
    const tinyOld = [{ at: 'o', url: 'u' }];
    const wQ4 = runSW({ store: { 'ysy.xprobe.v1': tinyOld }, setErr: 'QUOTA_BYTES quota exceeded' });
    const mQ4 = await wQ4.__send({ t: 'store', shared: true, key: 'ysy.xprobe.v1', value: tinyOld });
    ok('连 128KB 都滚不出来时（重试用尽）也要如实回话，不许假成功',
      mQ4.ok === false && mQ4.quota === true && Array.isArray(mQ4.merged), mQ4);
    const mOk = await runSW({}).__send({ t: 'store', shared: false, key: 'ysy.xprobe.dump', value: true });
    eq('正向对照：没报错时判 ok（不是把 ok 写死成 false）', [mOk.ok, mOk.err], [true, undefined]);

    // v0.6.9 待发队列键：形状是 { [bootId]: { t, recs } }，每页只写自己那一格。
    // 这里最要紧的一条是「不能整键覆盖」——覆盖 = 把另一个标签页的积压抹掉；
    // 也不能把 recs 拼起来 —— 拼起来 = 同一批记录被两个页面各发一次，日志里成对重复。
    const QK = 'ysy.xprobe.queue', NOW = Date.now();
    // 取格子前先兜底：这一组的对手是「整键覆盖」那类回归，直接 .A.recs 会让整块崩掉、
    // 后面几十条断言一条都跑不到 —— 断言要红，但不能把同段的别人一起带走
    const slot = (m, id) => ((((m || {}).merged || {})[id]) || {}).recs || [];
    const QR = (id) => ({ kind: 'page', at: '2026-10-23T0' + id + ':00:00.000Z', url: 'https://x.com/z/' + id, data: {} });
    const wQA = runSW({ store: { [QK]: { A: { t: NOW - 180000, recs: [QR(1)] } } } });
    const mQA = await wQA.__send({ t: 'store', shared: true, key: QK, value: { B: { t: NOW, recs: [QR(2), QR(3)] } } });
    eq('两个标签页各写各的格：别人的积压不许被抹掉',
      [Object.keys((mQA.merged || {})).sort(), slot(mQA, 'A').map((r) => r.url), slot(mQA, 'B').length],
      [['A', 'B'], ['https://x.com/z/1'], 2]);
    const mQR = await wQA.__send({ t: 'store', shared: true, key: QK, value: { B: { t: NOW + 1000, recs: [QR(9)] } } });
    eq('同一格重写 = 替换不是追加（否则每次落盘都把积压翻一倍）', slot(mQR, 'B').map((r) => r.url), ['https://x.com/z/9']);
    const wQC = runSW({ store: { [QK]: { A: { t: NOW - 180000, recs: [QR(1), QR(2)] } } } });
    const mQC = await wQC.__send({ t: 'store', shared: true, key: QK, value: { B: { t: NOW, recs: [QR(1)] } } });
    eq('写进来即认领：本格已有的那条要从旧格里删掉（旧格只剩一条就不空，整格空了整格消失）',
      [Object.keys((mQC.merged || {})).sort(), slot(mQC, 'A').map((r) => r.url)], [['A', 'B'], ['https://x.com/z/2']]);
    const emptySlot = await runSW({ store: { [QK]: { A: { t: NOW - 180000, recs: [QR(1)] } } } })
      .__send({ t: 'store', shared: true, key: QK, value: { B: { t: NOW, recs: [] } } });
    eq('本格的 recs 交空（队列已清空）⇒ 这一格从键里消失，不留过期积压',
      [Object.keys(emptySlot.merged || {}).sort(), (emptySlot.merged || {}).B], [['A'], undefined]);
    const wQOld = runSW({ store: { [QK]: { old: { t: NOW - 10 * 60000, recs: [QR(4)] }, live: { t: NOW - 1000, recs: [QR(5)] } } } });
    const mQOld = await wQOld.__send({ t: 'store', shared: true, key: QK, value: { me: { t: NOW, recs: [QR(6)] } } });
    eq('闲过 6 分钟的格子滚掉（迟到太久的日志没意义，也不能让这个键长不大）',
      Object.keys((mQOld.merged || {})).sort(), ['live', 'me']);
    const wQMax = runSW({ store: { [QK]: {} } });
    const mQMax = await wQMax.__send({ t: 'store', shared: true, key: QK,
      value: { B: { t: NOW, recs: Array.from({ length: 130 }, (_, i) => QR('a' + i)) } } });
    eq('单格条数顶 120，丢的是最旧那 10 条（留最新的，和 core 同口径）',
      [slot(mQMax, 'B').length, (slot(mQMax, 'B')[0] || {}).url, (slot(mQMax, 'B')[119] || {}).url],
      [120, 'https://x.com/z/a10', 'https://x.com/z/a129']);
    const FATQ = (tag, n) => ({ t: NOW - n, recs: Array.from({ length: 2 }, (_, i) => ({ kind: 'page', at: tag + i, url: 'u', data: { blob: 'q'.repeat(150000) } })) });
    const wQFat = runSW({ store: { [QK]: { s1: FATQ('s1', 5000), s2: FATQ('s2', 4000), s3: FATQ('s3', 3000), s4: FATQ('s4', 2000) } } });
    const mQFat = await wQFat.__send({ t: 'store', shared: true, key: QK, value: { s5: FATQ('s5', 1000) } });
    ok('整键也封顶：格数 ≤4 且字节 ≤600KB，从最旧的格开始滚（最新那格是这一页自己的）',
      Object.keys((mQFat.merged || {})).length <= 4 && !(mQFat.merged || {}).s1 && !!(mQFat.merged || {}).s5 &&
      (JSON.stringify(mQFat.merged) || '').length <= 600 * 1024,
      { slots: Object.keys((mQFat.merged || {})).length, bytes: (JSON.stringify(mQFat.merged) || '').length });
    const wQQ = runSW({ store: { [QK]: { dead: { t: NOW - 120000, recs: [QR(7)] } } }, setErr: 'QUOTA_BYTES quota exceeded', setErrFirst: 1 });
    const mQQ = await wQQ.__send({ t: 'store', shared: true, key: QK, value: { me: FATQ('me', 0) } });
    ok('队列这一键顶穿配额也当场瘦身重试（这是断线时的应急账本，写不进去等于白丢）：滚掉旧格、保住本页那格',
      mQQ.ok === true && mQQ.quota === false && !!mQQ.merged.me, mQQ);
    const wQQ2 = runSW({ store: { [QK]: {} }, setErr: 'QUOTA_BYTES quota exceeded' });
    const mQQ2 = await wQQ2.__send({ t: 'store', shared: true, key: QK, value: { me: { t: NOW, recs: [QR(8)] } } });
    ok('重试用尽仍写不进去时如实回 ok=false（不许把失败吞成「已落盘」）',
      mQQ2.ok === false && mQQ2.quota === true, mQQ2);

    // v0.6.3 序列键：两个标签页同开一个主页（或面板刚手工补了一个日点）时，整键覆盖会丢掉另一条腿的那个点，
    // 所以 mergeSeries 必须按点并：分钟按 ts、日点按 day，日点谁 at 新谁赢（补录因此盖得过自动值）
    const sOld = { king: { handle: 'king', updatedAt: 10, min: [{ ts: 60000, at: 'a', following: 10, followers: 20 }], imp: [{ day: '2026-10-01', value: 900, at: '2026-10-01T00:00:00.000Z' }] } };
    const sNew = {
      king: {
        handle: 'king', updatedAt: 20,
        min: [{ ts: 60000, at: 'b', following: null, followers: null }, { ts: 120000, at: 'c', following: 11, followers: 21 }],
        imp: [{ day: '2026-10-01', value: 1010, at: '2026-10-01T10:00:00.000Z' }, { day: '2026-10-02', value: 1200, at: '2026-10-02T00:00:00.000Z' }],
      },
      other: { handle: 'other', updatedAt: 5, min: [], imp: [] },
    };
    const ms = await runSW({ store: { 'ysy.xprobe.series': sOld } }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: sNew });
    eq('分钟点按 ts 并起来（不是整键覆盖）', ms.merged.king.min.map((p) => p.ts), [60000, 120000]);
    eq('同一分钟取信息更全的那个（空值不许盖掉真读到的数）', ms.merged.king.min.map((p) => p.followers), [20, 21]);
    eq('日点按 day 取 at 更新的（面板手工补录盖得过自动值）', [ms.merged.king.imp.length, ms.merged.king.imp[0].value], [2, 1010]);
    // v0.6.10：同一天两行必须按列合。奖励页那条腿只写曝光、手填那条腿只写关注/粉丝/帖子，
    // 「at 新的整行赢」= 后写的那条把先写的列抹成 undefined，用户补的历史静默变 —。
    const sAuto = { king: { handle: 'king', updatedAt: 10, min: [], imp: [{ day: '2026-10-05', value: 8500, exact: false, token: '8.5k', fow: null, fans: null, posts: null, at: '2026-10-05T09:00:00.000Z' }] } };
    const sHand = { king: { handle: 'king', updatedAt: 20, min: [], imp: [{ day: '2026-10-05', value: null, exact: false, token: '', fow: 2754, fans: 2690, posts: 3510, at: '2026-10-05T10:00:00.000Z' }] } };
    const dayRow = (m) => ((((m || {}).merged || {}).king || {}).imp || [])[0] || null;
    const mc1 = await runSW({ store: { 'ysy.xprobe.series': sAuto } }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: sHand });
    const r5 = dayRow(mc1);
    ok('同日按列合：晚写进来的手填行（没曝光）不许把自动曝光抹掉 —— 两腿都在',
      !!r5 && r5.value === 8500 && r5.token === '8.5k' && r5.exact === false &&
        r5.fow === 2754 && r5.fans === 2690 && r5.posts === 3510, r5);
    const mc2 = await runSW({ store: { 'ysy.xprobe.series': sHand } }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: sAuto });
    const r5b = dayRow(mc2);
    ok('反过来也一样（自动值晚到）：曝光与它的口径 token/exact 归自动腿，手填三列原样留着',
      !!r5b && r5b.value === 8500 && r5b.token === '8.5k' && r5b.fow === 2754 && r5b.posts === 3510, r5b);
    const h1 = { day: '2026-10-05', value: null, exact: false, token: '', fow: 2754, fans: null, posts: null, at: '2026-10-05T10:00:00.000Z' };
    const h2 = { day: '2026-10-05', value: null, exact: false, token: '', fow: 3029, fans: null, posts: null, at: '2026-10-05T11:00:00.000Z' };
    const wrap = (rows) => ({ king: { handle: 'king', updatedAt: 1, min: [], imp: rows } });
    const mc3 = await runSW({ store: wrap([h1]) }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: wrap([h2]) });
    const mc3r = await runSW({ store: wrap([h2]) }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: wrap([h1]) });
    ok('同一列两边都有数才比 at：改口要落得下去，正反两个写入顺序都是 3029（晚那次赢）',
      [(dayRow(mc3) || {}).fow, (dayRow(mc3r) || {}).fow], [3029, 3029]);
    const sMin2 = { king: { handle: 'king', updatedAt: 20, min: [{ ts: 60000, at: 'b', following: null, followers: 4321 }], imp: [] } };
    const sMin1 = { king: { handle: 'king', updatedAt: 10, min: [{ ts: 60000, at: 'a', following: 2754, followers: null }], imp: [] } };
    const mc4 = await runSW({ store: { 'ysy.xprobe.series': sMin1 } }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: sMin2 });
    const min0 = ((((mc4 || {}).merged || {}).king || {}).min || [])[0] || {};
    ok('分钟点同一分钟也按列合（一个标签页只认到关注、另一个只认到粉丝 ⇒ 两个都留）',
      [min0.following, min0.followers], [2754, 4321]);
    eq('别的 handle 的序列照收、updatedAt 取大的', [Object.keys(ms.merged).sort(), ms.merged.king.updatedAt], [['king', 'other'], 20]);
    const many = { z: { handle: 'z', updatedAt: 1, min: [], imp: [] } };
    for (let i = 0; i < 1441; i++) many.z.min.push({ ts: i * 60000, at: 't' + i, following: i, followers: i });
    for (let i = 0; i < 366; i++) many.z.imp.push({ day: 'D' + String(i).padStart(3, '0'), value: i, at: 'a' });
    const msc = await runSW({ store: { 'ysy.xprobe.series': many } }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: { z: { handle: 'z', updatedAt: 2, min: [], imp: [] } } });
    eq('点数封顶：分钟留最近 1440、日点留最近 365（丢最老的，不是丢最新的）',
      [msc.merged.z.min.length, msc.merged.z.min[0].following, msc.merged.z.imp.length, msc.merged.z.imp[0].value], [1440, 1, 365, 1]);
    const many2 = {};
    for (let i = 0; i < 41; i++) many2['h' + i] = { handle: 'h' + i, updatedAt: i, min: [], imp: [] };
    const msn = await runSW({ store: { 'ysy.xprobe.series': many2 } }).__send({ t: 'store', shared: true, key: 'ysy.xprobe.series', value: { zz: { handle: 'zz', updatedAt: 100, min: [], imp: [] } } });
    eq('handle 数封顶 40：按 updatedAt 留新的（v0.6.11 每人一行的日点靠这个才装得下 40 个号）',
      [Object.keys(msn.merged).length, msn.merged.zz !== undefined, msn.merged.h0 === undefined], [40, true, true]);

    const w5 = runSW();
    const m5 = await w5.__send({ t: 'store', shared: false, key: 'ysy.xprobe.dump', value: true });
    eq('非共享键原样写、不返回 merged', [m5.ok, m5.merged, w5.__map['ysy.xprobe.dump']], [true, undefined, true]);

    const w6 = runSW();
    const n6 = w6.__fetchCalls();
    const x1 = await w6.__send({ t: 'xhr', url: 'https://x.com/i/api/graphql/steal' });
    ok('正向对照：SW 也不发外网，fetch 一次都没调用', [/拒发/.test(x1.err), w6.__fetchCalls() === n6], [true, true]);
    const x2 = await w6.__send({ t: 'xhr', url: 'http://localhost:8765/ping' });
    eq('回环两种写法都放行，且 HTTP 回退标 via=http（日志要说得出来路）', x2, { status: 200, responseText: '{"ok":true}', via: 'http' });
    const x3 = await runSW({ fetchFail: 'Failed to fetch' }).__send({ t: 'xhr', url: 'http://127.0.0.1:8765/log' });
    ok('网络层抛错翻成 {err}，不 reject 给面板留未捕获', /Failed to fetch/.test(x3.err), x3);
    const x4 = await runSW({ fetchAbort: true }).__send({ t: 'xhr', url: 'http://127.0.0.1:8765/log' });
    eq('AbortError 认成 timeout（面板区分「超时」与「断开」）', x4, { timeout: true });
    const x5 = await runSW({ status: 404, text: 'not found' }).__send({ t: 'xhr', url: 'http://127.0.0.1:8765/nope' });
    eq('非 2xx 原样回报状态码（sink 活着但路径错，得看得见），同样带 via=http', x5, { status: 404, responseText: 'not found', via: 'http' });
    const w7 = runSW();
    await w7.__send({ t: 'xhr', url: 'http://127.0.0.1:8765/log', data: 'x' });
    ok('中继不带 cookie、不用缓存、带超时信号（credentials:omit 是不带 X 会话的唯一保证）',
      [w7.__lastInit.credentials, w7.__lastInit.cache, !!w7.__lastInit.signal, w7.__lastInit.body], ['omit', 'no-store', true, 'x']);
    eq('onInstalled 里注册了 sidePanel 行为（点图标开面板）', typeof w.chrome.runtime.onInstalled, 'object');

    const w8 = runSW({ noSidePanel: true });
    const p1 = await w8.__send({ t: 'openPanel' }, 'ext-self');
    ok('没有 sidePanel API 时给可执行的提示，不抛', [p1.ok, /工具栏图标/.test(p1.err)], [false, true]);
    const p2 = await runSW({}).__send({ t: 'openPanel' });
    ok('SW 自己收不到用户手势：面板开不开都记账不断', [!!p2, p2.ok !== undefined], [true, true]);
    const t8 = await runSW({ tabs: [{ id: 1, url: 'https://x.com/a' }] }).__send({ t: 'tabs' });
    eq('tabs 列表给面板当选择器（带 active 标记，截断长度）', [t8.ok, t8.tabs.length, typeof t8.tabs[0].url], [true, 1, 'string']);
  }

  console.log('\n[14b] native 直连：装了宿主走宿主，没装才退回 HTTP（回退只认「没有 status」）');
  {
    // v0.7.0：数据全进本机库，而「先双击 start-sink.bat」不该是前提。装了宿主就直连，没装照旧回退 HTTP。
    // 这一组钉的是三条最容易写错的语义：回包形状不变、回退条件单一、超时与 4xx 都不许补第二刀。
    const HOST = { reply: { ok: true, status: 200, body: '{"ok":true,"sink":"native-1"}', host: 'native-1' } };
    const wN = runSW({ native: HOST });
    const nPing = await wN.__call({ t: 'xhr', method: 'GET', url: 'http://127.0.0.1:8765/ping' });
    eq('宿主在 ⇒ 回包形状与 HTTP 完全一样（面板/core 不用知道走的是哪条路）',
      [nPing.status, nPing.responseText, nPing.via, wN.__fetchCalls()],
      [200, '{"ok":true,"sink":"native-1"}', 'native', 0]);
    eq('宿主名与注册表里那个逐字一致（差一个字母 = Chrome 报 host not found）',
      wN.__nativeQ[0].host, 'com.yunxiao.xprobe');
    const nBad = await wN.__call({ t: 'xhr', url: 'https://x.com/i/api/graphql/steal' });
    ok('宿主在手也不许顺手打外网：回环判据在 nativePlan 之前，一次都没请宿主',
      [/拒发/.test(nBad.err), wN.__fetchCalls(), wN.__nativeQ.length], [true, 0, 1]);

    const wM = runSW({ native: HOST });
    await wM.__call({ t: 'xhr', method: 'POST', url: 'http://127.0.0.1:8765/log', data: '{"records":[]}' });
    await wM.__call({ t: 'xhr', method: 'POST', url: 'http://127.0.0.1:8765/dump', data: '{"tab":"home"}' });
    await wM.__call({ t: 'xhr', method: 'GET', url: 'http://127.0.0.1:8765/db?q=posts_top&limit=9999' });
    await wM.__call({ t: 'xhr', method: 'GET', url: 'http://127.0.0.1:8765/db?q=accounts&limit=0' });
    eq('POST 原文原样进 body；GET /db 抽出 q，limit 夹到 1..500（0 与缺省都按 20）',
      wM.__nativeQ.map((c) => c.payload),
      [{ t: 'log', body: '{"records":[]}' }, { t: 'dump', body: '{"tab":"home"}' },
       { t: 'db', q: 'posts_top', limit: 500 }, { t: 'db', q: 'accounts', limit: 20 }]);
    const wX = runSW({ native: HOST });
    const nNo = await wX.__call({ t: 'xhr', method: 'GET', url: 'http://127.0.0.1:8765/nope' });
    eq('不属于那四个端点的路径不请宿主（404 语义只留 HTTP 一层，免得两边各有一套白名单）',
      [wX.__nativeQ.length, nNo.status, wX.__fetchCalls()], [0, 200, 1]);

    const wF = runSW();   // 缺省桩 = 宿主没装，Chrome 就是这么回：lastError 有、结果 undefined
    const nF = await wF.__call({ t: 'xhr', method: 'GET', url: 'http://127.0.0.1:8765/ping' });
    eq('宿主没装 ⇒ 自动退回 HTTP（老机器上双击 bat 那条路照旧能用）',
      [wF.__nativeQ.length, wF.__fetchCalls(), nF.status, nF.responseText], [1, 1, 200, '{"ok":true}']);
    ok('回退那一刀不算失败：不带 err（面板按正常的 HTTP 结果读，不该弹「连不上」）', nF.err === undefined, nF);

    const w4 = runSW({ native: { reply: { ok: false, status: 400, body: '{"ok":false,"err":"未知查询"}' } } });
    const n4 = await w4.__call({ t: 'xhr', method: 'GET', url: 'http://127.0.0.1:8765/db?q=nope' });
    eq('宿主回了 4xx ⇒ 照样交回面板，不再补一次 HTTP（补了 = 同一条请求被处理两遍）',
      [w4.__fetchCalls(), n4.status, /未知查询/.test(n4.responseText)], [0, 400, true]);

    const wT = runSW({ native: 'timeout' });
    const nT = await wT.__call({ t: 'xhr', method: 'POST', url: 'http://127.0.0.1:8765/log', data: '{}', timeout: 100 });
    eq('宿主超时 ⇒ 报 timeout，也不拿 HTTP 补一次（宿主可能已经写进去了，补 = 同一条进两次档）',
      [nT, wT.__fetchCalls()], [{ timeout: true }, 0]);

    const wC = runSW({ src: swSrc.replace('if (r.status == null) {', 'if (false) {') });
    const nC = await wC.__call({ t: 'xhr', method: 'GET', url: 'http://127.0.0.1:8765/ping' });
    ok('正向对照：把「没有 status 才回退」改成永不回退，宿主没装时就当场哑掉（这条判据确实在咬）',
      [wC.__fetchCalls(), nC.status, nC.via], [0, 0, 'native']);
  }

  console.log('\n[15] 三层接口对得上（名字对不上的命令 = 面板上一个按了没反应的按钮）');
  {
    const coreSrc = src, spSrc = rd('ui/sidepanel.js'), shimSrc2 = rd('content/host-shim.js');
    const coreBlock = (coreSrc.match(/const CMDS = \{([\s\S]*?)\n  \};/) || [])[1] || '';
    const coreCmds = (coreBlock.match(/^\s*([a-zA-Z]+):/gm) || []).map((s) => s.replace(/[^a-zA-Z]/g, ''));
    const swCmds = ((swSrc.match(/const CMDS = \[([^\]]*)\]/) || [])[1] || '').match(/'([^']+)'/g);
    const spCmds = Array.from(new Set((spSrc.match(/cmd\('([a-zA-Z]+)'/g) || []).map((s) => s.match(/cmd\('([a-zA-Z]+)'/)[1])));
    const swList = (swCmds || []).map((s) => s.replace(/'/g, ''));
    ok('state 由 runCmd 特判（它不进 CMDS，因为不执行动作只回状态）', /msg\.t === 'state'/.test(coreSrc), '');
    const coreAccept = coreCmds.concat(/msg\.t === 'state'/.test(coreSrc) ? ['state'] : []);
    ok('core 命令表非空且含 collect/query/stats/export', ['collect', 'query', 'stats', 'export'].every((c) => coreCmds.indexOf(c) >= 0), coreCmds);
    eq('面板用到的每条命令 core 都实现', spCmds.filter((c) => coreAccept.indexOf(c) < 0), []);
    eq('面板用到的每条命令 SW 白名单也放行（否则消息到不了 core）', spCmds.filter((c) => swList.indexOf(c) < 0), []);
    eq('SW 白名单里没有 core 不认的命令（点了报错的按钮）', swList.filter((c) => coreAccept.indexOf(c) < 0), []);
    // SVG 的名字空间是个 XML 标识符（createElementNS 的参数），浏览器不会去取它。
    // 除这一个以外，面板/格式化层里仍不许出现任何非回环的 http(s) 字面量 —— 白名单只此一条，别想顺手加第二条
    const spNoComment = spSrc.replace(/^\s*\/\/.*$/gm, '') + viewSb.XPROBE_VIEW.toString();
    const hasBadUrl = (s) => /https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i.test(s);
    const ONLY_NS = 'http://www.w3.org/2000/svg';
    ok('面板/格式化层里唯一的非回环字面量就是 SVG 名字空间（不是要请求的地址）',
      !hasBadUrl(spNoComment.split(ONLY_NS).join('SVG_NS')), (spNoComment.match(/https?:\/\/\S+/g) || []));
    ok('正向对照：把名字空间换成外网地址，这条判据当场变红（证明它还在咬）',
      hasBadUrl(spNoComment.split(ONLY_NS).join('http://example.com/2000/svg')), '');
    ok('整个扩展不申请能改页面或能读全网的能力',
      !/chrome\.cookies|chrome\.webRequest|chrome\.scripting|chrome\.debugger|executeScript|insertCSS/.test(swSrc + coreSrc + shimSrc2), '');
    ok('UI 层不派发合成事件、不读页面 origin 存储', !/dispatchEvent|localStorage|indexedDB|document\.cookie/.test((spSrc + rd('ui/view.js')).replace(/^\s*\/\/.*$/gm, '')), '');
    // v0.8.3 曝光榜卡片：滚动是用户点条目那一刻的唯一动作。针脚钉三件事：
    // 卡片有挂/摘两条路（开了才注入、关了整棵 remove）、定位只认 article 里的 status 链接（不存死引用）、
    // scrollIntoView 全文件只许出现在 cardScrollTo 里（别的任何地方主动滚 = 踩「不滚动」红线）。
    ok('曝光榜卡片：开合完整 + 定位走 status 链接 + 转储树排除卡片',
      /function toggleCard\(\)/.test(coreSrc) && /cardOpen = !cardOpen/.test(coreSrc) &&
      /cardRoot\.remove\(\)/.test(coreSrc) &&
      /querySelectorAll\('a\[href\*="\/status\/' \+ id \+ '"\]'\)/.test(coreSrc) &&
      /closest\('article'\)/.test(coreSrc) &&
      /n\.id === FAB_ID \|\| n\.id === CARD_ID/.test(coreSrc), '');
    ok('scrollIntoView 全文件只许 cardScrollTo 一处（探针绝不自己滚页面）',
      (coreSrc.match(/scrollIntoView/g) || []).length === 2 && /function cardScrollTo/.test(coreSrc),
      coreSrc.match(/scrollIntoView/g));
    // v0.8.3-C：行内「复制」必须走 navigator.clipboard（用户点的，不是探针定时写），且结构上放在
    // 可点击主区**外**（兄弟节点）——「不拦点击」红线禁 stopPropagation，隔离结构就不需要拦冒泡；
    // 排序切换是客户端重排（cardSort 只在钮里写，key 二选一）
    ok('卡片复制钮：navigator.clipboard、复制钮在主区外（不嵌可点击区）；曝光/评论切换 client 重排',
      /navigator\.clipboard && navigator\.clipboard\.writeText/.test(coreSrc) &&
      /rfoot\.append\(cp\)/.test(coreSrc) && /main\.addEventListener\('click'/.test(coreSrc) &&
      !/stopPropagation|preventDefault/.test(coreSrc.replace(/^\s*\/\/.*$/gm, '')) &&
      /cardSort = k; renderCard\(\)/.test(coreSrc) &&
      /const key = cardSort === 'reply' \? rnum : vnum;/.test(coreSrc), '');
    // v0.8.4-D：SPA 换页监听提成具名 spaTick（沙盒可测），URL 变了先把卡片拖进过渡态、重采回来才出新榜
    ok('SPA 换页：节拍器是具名 spaTick，换页先清卡（cardNav 过渡态）、2.5 秒重采回来才解除并导出给自检',
      /function spaTick\(\)/.test(coreSrc) && /setInterval\(spaTick, 1200\)/.test(coreSrc) &&
      /cardNav = true; renderCard\(\)/.test(coreSrc) &&
      /cardNav = false; renderCard\(\)/.test(coreSrc) &&
      /writeStores, spaTick,/.test(coreSrc), '');
    // v0.8.4 拉黑：render 挂钩、class 走 setAttribute、转储树按 BLK_CLS 排除、记录走 logRec('block')
    // （落库 blocks 表，db-selftest 那边钉入库形状）。v0.8.11 改的是缝的位置：徽标不再插进名字锚旁边，
    // 而是 append 到「往上爬找到的宿主行」里、绝对定位 —— 缝进锚旁边 = 参与那一行的布局（真机
    // 「鼠标放上去就移动走」），挂进宿主 + position:absolute 才是既不占位也不落到 <a> 里。
    // v0.8.12 再加两条：① 落点贴缝的左缘，**不许**再贴右墙（右墙=容器右缘，随列宽/滚动条/后到的钮移动
    // ⇒ 页面每加载一点徽标就跑一点，真机同一行隔一分钟 left 264→115）；② 老位置仍站在缝里就不许重写。
    ok('拉黑名单：render 挂钩 + 徽标挂进宿主行且绝对定位（不落在 <a> 里）+ 落点贴左缘不贴右墙 + 粘住不重写 + class 走 setAttribute + 转储树排除 + 记录走 logRec("block")',
      /function render\(\) \{ fabBtn\(\); renderBlocks\(\); \}/.test(coreSrc) &&
      /host\.append\(n\)/.test(coreSrc) &&
      /s\.position = 'absolute'; s\.display = 'block'/.test(coreSrc) &&
      !/insertBefore\(n, anchor\.nextSibling\)/.test(coreSrc) &&
      !/gaps\[i\]\[1\] - BADGE_FULL_W/.test(coreSrc) &&
      /badgeInGap\(badgeGaps\(/.test(coreSrc) &&
      /setAttribute\('class', BLK_CLS\)/.test(coreSrc) &&
      /wcls\.indexOf\(BLK_CLS\) >= 0/.test(coreSrc) &&
      /logRec\('block', \{ handle: k/.test(coreSrc) &&
      /BLOCK_KEY = 'ysy\.xprobe\.blocked'/.test(coreSrc), '');
    // v0.8.5 三钮分家 + 本页用户列表：常驻注入是 bar + 关/榜/观三颗；名单与卡片同一抓取点（flistRows 只吃
    // collectArticles）、同一开合纪律（开了才注入、关了整棵 remove）；换页 spaTick 里重画；转储树把 bar/flist 也排除
    ok('三钮分家 + 本页用户列表：bar 三钮、flist 与卡片同纪律、换页重画、转储树排除、按钮导出给自检',
      /FABBAR_ID = 'ysy-xprobe-ext-bar'/.test(coreSrc) && /FLIST_ID = 'ysy-xprobe-ext-flist'/.test(coreSrc) &&
      /function toggleFlist\(\)/.test(coreSrc) && /flistOpen = !flistOpen/.test(coreSrc) &&
      /flistRoot\.remove\(\)/.test(coreSrc) &&
      /if \(flistOpen\) renderFlist\(\);/.test(coreSrc) &&
      /n\.id === FABBAR_ID \|\| n\.id === FLIST_ID/.test(coreSrc) &&
      /fabBtn, cardBtn, flistBtn,/.test(coreSrc), '');
    // v0.8.5 现场判例：三颗钮共享的 FAB_STY 不许带 position/right/bottom——带上就每颗各自 fixed 到
    // 同一个角落叠成一颗（用户看到「只有一颗」；沙盒不量视觉叠放，只能靠针脚钉死样式形状）
    const fabSty = coreSrc.match(/const FAB_STY = \{[\s\S]*?\n  \};/);
    ok('钮排各钮不带自己的定位（FAB_STY 无 position/right/bottom，定位归排容器；否则全部叠成一颗）',
      !!fabSty && !/position|right|bottom/.test(fabSty[0]), fabSty && fabSty[0].slice(0, 90));
    ok('适配层与 SW 的白名单各写一遍（纵深防御，一边漏了另一边还拦得住）',
      /SINK_PREFIXES/.test(shimSrc2) && /isLoopback/.test(swSrc), '');
    // 孤儿面板（用户现场：⟳ 之后旧 Side Panel 看着有数、每按一键都 "Receiving end does not exist"，
    // 用户以为按钮坏了）——send 两处（回调 lastError / 同步 throw）都必须点名「关掉重开」怎么救
    ok('连接类报错点名「旧副本，关掉重开」），不许只把裸错误丢给用户',
      /Receiving end does not exist[\s\S]{0,200}旧副本/.test(spSrc) && spSrc.split('旧副本').length >= 3, '');
    ok('视图显隐用 classList.toggle 而不是覆写 className（覆写把布局类 bar 一起抹掉 ⇒ .bar.hide 匹配不上，四条工具条全裸露——用户那个「切哪个 tab 都一堆按钮」的现场）',
      /classList\.toggle\('hide', !on\)/.test(spSrc) && !/className = on \? '' : 'hide'/.test(spSrc), '');
    // 趋势页这轮：日线表升级成网格编辑器，旧 bkBox 补录条退休——它 hide 写死在 html 上、
    // syncButtons 的显隐清单里又没它，从 v0.6.9 交付起就从来没显示过（用户「没法加历史数据」的直接原因）
    const spHtml = rd('ui/sidepanel.html');
    const spClean = spSrc.replace(/^\s*\/\/.*$/gm, '');   // 咬代码不咬注释：注释里提旧名字是叙事，不是死绑定
    ok('补录条 bkBox 退休：html 里不再有它，js 代码里也不许残留 bkVal/bBkAdd/doBackfill 的死绑定',
      spHtml.indexOf('bkBox') < 0 && spClean.indexOf('bkVal') < 0 && spClean.indexOf('bBkAdd') < 0 && spClean.indexOf('doBackfill') < 0, '');
    // 取块边界用「下一个顶层 function」而不是固定 3400 字符窗口：impsNode 拆成显示/编辑两态后早已超过窗口，
    // 固定长度会让 cmd('impDel') 掉到窗外 —— got 恒等于窗口值 3400，就是这种假红的特征（咬的是量尺不是代码）。
    const gridAt = spClean.indexOf('function impsNode');
    const gridNext = spClean.indexOf('\n  function ', gridAt + 10);
    const gridBlock = gridAt < 0 ? '' : spClean.slice(gridAt, gridNext > 0 ? gridNext : gridAt + 12000);
    const edSrc = rd('ui/editor.js');
    ok('编辑窗独立于侧栏（用户真机反馈：360px 侧栏里的模态框「太小了、看不清字」）：impsNode 只开窗，窗口 640×560 居中',
      gridBlock.length > 0 && /openEditorWindow/.test(gridBlock) && /chrome\.windows\.create/.test(spClean) &&
      /ui\/editor\.html/.test(spClean) && /getLastFocused/.test(spClean) && /type: 'popup'/.test(spClean),
      [gridBlock.length, gridAt, gridNext]);
    ok('正向对照：把开窗 URL 换成别的页面，同一条判据当场变红（证明它咬的是编辑窗那一跳）',
      /ui\/editor\.html/.test(spClean.replace('ui/editor.html', 'ui/nope.html')) === false, '');
    // v0.8.1-k 用户裁定：第二张表也要能编辑（「关注粉丝帖子 这个表 也需要给一个 编辑……又要能补充历史数据」）
    // ⇒ 编辑窗改双模式（kind=imp 曝光两列 / kind=fow 关注粉丝帖子），列名只在 COLS 一处。
    ok('第二张表也有「编辑」钮：openEditorWindow 恰两处调用（第一张不带 kind、第二张带 fow）',
      (spClean.match(/openEditorWindow\(m\.who/g) || []).length === 2 &&
      /openEditorWindow\(m\.who \|\| ''\)/.test(spClean) &&
      /openEditorWindow\(m\.who \|\| '', 'fow'\)/.test(spClean) &&
      /function openEditorWindow\(who, kind\)/.test(spClean),
      [(spClean.match(/openEditorWindow\(m\.who/g) || []).length]);
    ok('正向对照：把第二颗钮的 fow 参数抹掉，同一条判据当场变红（证明它咬的是那一个参数不是随便两处调用）',
      /openEditorWindow\(m\.who \|\| '', 'fow'\)/.test(spClean.replace(", 'fow'", '')) === false, '');
    ok('编辑窗双模式列头（imp=总曝光/有效曝光；fow=关注/粉丝/帖子）：列名只在 COLS 一处，两分支互不含对方的列',
      (edSrc.match(/const COLS/g) || []).length === 1 &&
      /const FOW = kind === 'fow'/.test(edSrc) &&
      /const COLS = FOW\s*\?\s*\[\{ k: 'fow', label: '关注' \}, \{ k: 'fans', label: '粉丝' \}, \{ k: 'posts', label: '帖子' \}\]\s*:\s*\[\{ k: 'value', label: '总曝光' \}, \{ k: 'eff', label: '有效曝光' \}\]/.test(edSrc) &&
      /COLS\.map\(\(c\) => th\(c\.label\)\)/.test(edSrc),
      [(edSrc.match(/const COLS/g) || []).length]);
    ok('正向对照：把 fow 分支的列名改成曝光列（两模式同列），同一条判据当场变红',
      /const COLS = FOW\s*\?\s*\[\{ k: 'fow', label: '关注' \}, \{ k: 'fans', label: '粉丝' \}, \{ k: 'posts', label: '帖子' \}\]\s*:\s*\[\{ k: 'value', label: '总曝光' \}, \{ k: 'eff', label: '有效曝光' \}\]/.test(
        edSrc.replace("{ k: 'fow', label: '关注' }, { k: 'fans', label: '粉丝' }, { k: 'posts', label: '帖子' }", "{ k: 'value', label: '总曝光' }, { k: 'eff', label: '有效曝光' }")) === false, '');
    ok('「删」只在 imp 模式（impDel 是整行删、连曝光列一起——从关注粉丝窗里一按就把曝光的账删没了）：impDel 全窗恰一处且包在 if (!FOW) 里',
      (edSrc.match(/send\('impDel'/g) || []).length === 1 &&
      edSrc.indexOf('if (!FOW)') >= 0 && edSrc.indexOf('if (!FOW)') < edSrc.indexOf("send('impDel'"),
      [edSrc.indexOf('if (!FOW)'), edSrc.indexOf("send('impDel'")]);
    ok('正向对照：把 if (!FOW) 改成 if (true)（fow 模式也给删），同一条判据当场变红',
      (edSrc.replace('if (!FOW) {', 'if (true) {').match(/send\('impDel'/g) || []).length === 1 &&
      edSrc.replace('if (!FOW) {', 'if (true) {').indexOf('if (!FOW)') < 0, '');
    ok('两模式写账同一口径（impAdd 同日按列合并，窗口里不许另写一份）：加/存都经 payload→apply 一处交键，没开的列传空串 = 不动那列',
      (edSrc.match(/payload\(/g) || []).length === 2 && /const apply = \(v\) => send\('impAdd', v\)/.test(edSrc) &&
      /value: '', eff: '', fow: '', fans: '', posts: ''/.test(edSrc),
      [(edSrc.match(/payload\(/g) || []).length]);
    // v0.8.1-l 自动保存（用户的话：「能不能帮我改成异步的，只要表格修改就立马触发保存，这样方便的多」）
    ok('自动保存：窗口里没有「存」按钮，任何一格 change（离开输入框/回车）当场交账（impAdd/impDel），不许自己 chrome.storage 写账',
      (edSrc.match(/addEventListener\('change'/g) || []).length === 2 &&
      edSrc.indexOf("'存'") < 0 && /'删'/.test(edSrc) &&
      /send\('impAdd'/.test(edSrc) && /send\('impDel'/.test(edSrc) &&
      edSrc.indexOf("chrome.storage.local.set") < 0,
      [(edSrc.match(/addEventListener\('change'/g) || []).length]);
    ok('正向对照：把 change 监听换成 input（每敲一个键交一次账，节奏就错了），同一条判据当场变红',
      (edSrc.replace(/addEventListener\('change'/g, "addEventListener('input'").match(/addEventListener\('change'/g) || []).length === 0, '');
    ok('自动刷新不抢焦点：焦点还在表格里（正在连填几列/几天）就先不重读重画，挂到 focusout 再刷——一刷整表重建，正在打字的框和焦点就没了',
      /reloadArmed/.test(edSrc) && /\$\('grid'\)\.contains\(document\.activeElement\)/.test(edSrc) &&
      /addEventListener\('focusout'/.test(edSrc), '');
    ok('正向对照：把焦点闸拆掉（contains 判断改成恒 false），同一条判据当场变红',
      /\$\('grid'\)\.contains\(document\.activeElement\)/.test(
        edSrc.replace("$('grid').contains(document.activeElement)", 'false')) === false, '');
    // v0.6.11「每人一天一行」：编辑窗的写账必须把当前视线那个 handle 一起交出去，否则补录补错人。
    // 双模式后交法收进 payload 一处 + impDel 一处 = 两处字面量
    ok('编辑窗的写账处都带上 handle（=who）：payload 一处 + 删一处',
      (edSrc.match(/handle: who/g) || []).length === 2, (edSrc.match(/handle: who/g) || []).length);
    ok('正向对照：抹掉其中一处 handle，同一条判据当场变红（证明它数的是两处不是随手写的）',
      (edSrc.replace('handle: who', '').match(/handle: who/g) || []).length === 1, '');
    ok('底部「+」行管往前补历史（用户的话：「需要能一直添加之前的 是不是表格下方加一个加号」）：默认 = 表里最早那天的前一日（没行才退回昨天，用户的话：「可以自动计算前一个日期……默认就是前一日，手动可以修改罢了」）、落账 −1；顶部行管往后（+1）——两条加行共用 mkAddRow 一个写账口径',
      /mkAddRow\(today\(\), nextDay, /.test(edSrc) &&
      /const earliest = rows\.length \? rows\[rows\.length - 1\]\.day : '';/.test(edSrc) &&
      /mkAddRow\(earliest \? prevDay\(earliest\) : prevDay\(today\(\)\), prevDay, /.test(edSrc) &&
      (edSrc.match(/function prevDay/g) || []).length === 1, '');
    ok('正向对照：把底部「+」的日期推进换成 nextDay（往后挪），同一条判据当场变红',
      /mkAddRow\(earliest \? prevDay\(earliest\) : prevDay\(today\(\)\), prevDay, /.test(
        edSrc.replace("mkAddRow(earliest ? prevDay(earliest) : prevDay(today()), prevDay, '往前补历史'",
                     "mkAddRow(earliest ? prevDay(earliest) : prevDay(today()), nextDay, '往前补历史'")) === false, '');
    ok('正向对照：把「+」的默认日期改回固定昨天（不看表里最早那天），同一条判据当场变红',
      /const earliest = rows\.length \? rows\[rows\.length - 1\]\.day : '';/.test(edSrc.replace(/const earliest = rows\.length \? rows\[rows\.length - 1\]\.day : '';/, '')) === false, '');
    ok('编辑窗自己找 x.com 标签页（补录要经页面上的采集端写账；一个都没有就明说，不静默失败）',
      /chrome\.tabs\.query/.test(edSrc) && /tabId/.test(edSrc) && /先开着任意一个 x\.com 标签页/.test(edSrc), '');
    ok('只读表恒渲染：impsNode 里一个输入框都不许建（编辑活在编辑窗里，侧栏不再拥挤）',
      gridBlock.indexOf("mk('input'") < 0 && /impView/.test(gridBlock) && /'编辑'/.test(gridBlock),
      [gridBlock.length, (gridBlock.match(/input/g) || []).length]);
    ok('日点表拆两张（用户的话：「有效曝光 曝光 转化率 是一个表 另外 后面的三列 再单独拆一个表」）：第一张 = 日期+曝光三列，第二张 = 日期+关注/粉丝/帖子，列头都从 view 的 DAY_HEAD 切（不许另写一份列名）',
      (gridBlock.match(/mk\('div', 'impGrid'\)/g) || []).length === 2 &&
      /head\(cols\.slice\(0, 4\)/.test(gridBlock) && /head\(\['日期'\]\.concat\(cols\.slice\(4\)\)/.test(gridBlock),
      [(gridBlock.match(/mk\('div', 'impGrid'\)/g) || []).length]);
    ok('正向对照：第一张表的列头改回整条 7 列（不拆），同一条判据当场变红',
      /head\(cols\.slice\(0, 4\)/.test(gridBlock.replace('cols.slice(0, 4)', 'cols.slice(0, 7)')) === false, '');
    // v0.6.12：三处各自手写「剥 @ + trim + 小写」换成一个 normHandle —— 口径只留一处，
    // 否则「面板传 @King 与 core 存的 king」这种大小写/前缀分叉会在某一条路上悄悄复现
    const coreKnowsHandle = (s) => /const o = d && typeof d === 'object' \? d : \{ day: d \};/.test(s) &&
      (s.match(/normHandle\(o\.handle\)/g) || []).length === 2 && /function normHandle\(h\)/.test(s);
    ok('core 的 impAdd/impDel 认得 handle（走同一个 normHandle），且不传时仍落到 own（老面板不带这个字段，不能突然写进空名下）',
      coreKnowsHandle(coreSrc), (coreSrc.match(/normHandle\(o\.handle/g) || []).length);
    ok('正向对照：把 core 里那两处 o.handle 换成硬编码空串，同一条判据当场变红（证明它在咬那两句）',
      coreKnowsHandle(coreSrc.replace(/normHandle\(o\.handle\)/g, "String('')")) === false, '');
    ok('handle 归一只留 normHandle 一处实现（不许残留手写的「剥 @ + trim + 小写」三连）',
      (coreSrc.match(/function normHandle/g) || []).length === 1 &&
      !/replace\(\/\^@\/, ''\)\.trim\(\)\.toLowerCase\(\)/.test(coreSrc), '');
    // 「切视线」与「从本机库回填」各穿三层：html 有按钮/下拉、js 有绑定与命令、core 有实现 —— 少一层就是按了没反应
    const coreHas = (pat) => new RegExp(pat).test(coreSrc);
    const threeLayers = (id, jsPat, corePat) => rd('ui/sidepanel.html').indexOf('id="' + id + '"') >= 0 &&
      new RegExp(jsPat).test(spClean) && coreHas(corePat);
    ok("切视线三层齐：sidepanel.html 里有 whoPick、面板代码里有它的 change 绑定、core 里有 seriesView 命令",
      threeLayers('whoPick', "\\$\\('whoPick'\\)", 'seriesView:'), '');
    ok('回填三层齐：sidepanel.html 的 bRestore、js 的 cmd(impRestoreDb)、core 的 impRestoreDb 实现',
      threeLayers('bRestore', "cmd\\('impRestoreDb'\\)", 'impRestoreDb:'), '');
    const fakeCoreNoRestore = coreSrc.replace(/impRestoreDb: \(v\) => restoreDaysFromDb\(v\),/, '');
    ok('正向对照：删掉 core 里那行 impRestoreDb 实现，回填那条判据当场变红（证明它真在 core 里找这一行）',
      fakeCoreNoRestore.length < coreSrc.length && !/impRestoreDb:/.test(fakeCoreNoRestore),
      [coreSrc.length, fakeCoreNoRestore.length]);
    // 新增的 ysy.xprobe.series：三层都要认这个键，少一层就是「面板看着有数据、刷新一下又没了」
    const sk = 'ysy.xprobe.series';
    ok('序列键三层一致：core 写它、适配层按共享键走 SW、SW 的 merge 有分支（没有分支就是整键覆盖，会丢另一条腿的点）',
      coreSrc.indexOf("'" + sk + "'") >= 0 && shimSrc2.indexOf("'" + sk + "'") >= 0 && /SERIES_KEY\)\s*return\s+mergeSeries/.test(swSrc), sk);
    // v0.6.9 的待发队列键，同一条道理：core 落盘、适配层按共享键走 SW、SW 有 mergeQueue 分支
    const qk2 = 'ysy.xprobe.queue';
    ok('队列键三层一致：core 写它、适配层把它算共享键、SW 的 merge 有 mergeQueue 分支',
      coreSrc.indexOf("'" + qk2 + "'") >= 0 && shimSrc2.indexOf("'" + qk2 + "'") >= 0 && /QUEUE_KEY\)\s*return\s+mergeQueue/.test(swSrc), qk2);
    // 两个上限必须两边同值：core 以为顶 120 条、SW 却按别的数滚 ⇒ 落盘条数永远对不上，日志里的"丢弃"就成了假账
    const capOf = (src, name) => {
      const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([\\d*\\s]+);'));
      if (!m) return null;
      return m[1].split('*').reduce((acc, part) => acc * Number(part.trim()), 1);
    };
    const capsPair = (name) => [capOf(coreSrc, name), capOf(swSrc, name)];
    eq('core 与 SW 的队列三个口径同值（条数顶 / 字节顶 / 过期分钟）',
      [capsPair('QUEUE_MAX'), capsPair('QUEUE_BYTES_CAP'), capsPair('QUEUE_DROP_MS')],
      [[120, 120], [614400, 614400], [360000, 360000]]);
    const fakeCore = coreSrc.replace('const QUEUE_MAX = 120;', 'const QUEUE_MAX = 118;');
    eq('正向对照：把 core 的单格顶改成 118，这条判据当场变红（证明它真的在比数值）',
      [capOf(fakeCore, 'QUEUE_MAX'), capOf(swSrc, 'QUEUE_MAX')], [118, 120]);
    // v0.6.11：日点改成「每人一行」后 handle 数从 8 放宽到 40，SW 那份天花板必须跟着走 ——
    // 它比 core 小就是在合并那一步把刚认出来的号删掉，面板上只表现为「日点没落进去」，查不到是谁吃的
    const fakeSw8 = swSrc.replace('const SER_MAX = 40;', 'const SER_MAX = 8;');
    eq('core 与 SW 的序列三个封顶同值（handle 数 / 分钟点 / 日点）',
      [capsPair('SER_MAX'), capsPair('MIN_MAX'), capsPair('IMP_MAX')], [[40, 40], [1440, 1440], [365, 365]]);
    eq('正向对照：把 SW 的 handle 顶改回 8，这条判据当场变红（证明它在咬 SW 那份，不是只看 core）',
      [capOf(coreSrc, 'SER_MAX'), capOf(fakeSw8, 'SER_MAX')], [40, 8]);
    // v0.6.11 排名表：core 给料（rank 每人最新两行）、view 排版与排序、面板建表并接列头点击 —— 三层一处都不能少
    const viewSrc = rd('ui/view.js');
    ok('排名三层齐：core 造 rank 字段、view 有 rankRows/rankNode 并导出、面板有 rank 分支与 rankNode 渲染',
      /rank: hs\.slice/.test(coreSrc) && /function rankRows/.test(viewSrc) && /function rankNode/.test(viewSrc) &&
      /rankRows: rankRows, rankNode: rankNode/.test(viewSrc) && /msg\.k === 'rank'/.test(spSrc) && /function rankNode\(m\)/.test(spSrc), '');
    ok('排序状态存面板模块级变量并回灌 plazaLines（render() 每次重建整树，存 DOM 上会被自己刷掉）',
      /let rankSortBy = 'fans', rankAsc = false/.test(spClean) &&
      /V\.plazaLines\(st, \{ by: rankSortBy, asc: rankAsc, now: Date\.now\(\), acct: acctSort, post: postSort, db: db, acctLimit: acctLimit, postLimit: postLimit, rankLimit: rankLimit, tlSrcf: tlSrcf, tlDay: tlDay, tlLimit: tlLimit, tlSort: tlSort \}\)/.test(spClean) &&
      /rkHead/.test(spClean), '');
    // v0.8.1-t 榜分页：一次 10 条、「更多」+10；换排序回第一页；三处（view 分页字段 / moreBtnNode / 模块变量）缺一不可
    ok('榜分页三处齐：面板模块变量 acct/post/rank/tlLimit + moreBtnNode 共用钮（grid/rank 都挂）+ 换排序回第一页',
      /let acctLimit = 10, postLimit = 10, rankLimit = 10;/.test(spClean) &&
      /let tlDay = '', tlSrcf = '', tlLimit = 10, tlSort = 'view';/.test(spClean) &&
      /function moreBtnNode\(left, onMore\)/.test(spClean) &&
      /rankLimit \+= 10; render\(\);/.test(spClean) &&
      /postLimit \+= 10;[\s\S]{0,60}tlLimit \+= 10;[\s\S]{0,60}acctLimit \+= 10;[\s\S]{0,20}render\(\);/.test(spClean) &&
      /postSort = k; postLimit = 10; \} else \{ acctSort = k; acctLimit = 10; \}/.test(spClean) &&
      /rankLimit = 10;/.test(spClean), '');
    ok('正向对照：把「更多」按钮的挂载点摘掉，同一条判据当场变红',
      /m\.more > 0\) d\.append\(moreBtnNode/.test(spClean.replace(/if \(m\.more > 0\) d\.append\(moreBtnNode[^;]*;/g, '')) === false, '');
    ok('排名的「距今」吃可注入时刻（now 缺省才回落到 Date.now()）：自检钉住 T0 才能判新鲜度，否则跨午夜那条自己变红',
      /function rankRows\(st, sortBy, asc, now\)/.test(viewSrc) && /var t = now == null \? Date\.now\(\) : now;/.test(viewSrc), '');
    // v0.7.0 广场读本机库：面板 → SW → xprobe_db 三层，且只许走回环（content/panel 都不许直连库）
    const cmdsLine = (swSrc.match(/const CMDS = \[[^\]]*\];/) || [''])[0];
    const dbUrl = (swSrc.match(/const DB_URL = '([^']+)';/) || [])[1] || '';
    ok('本机库读三层齐：面板发 dbq（不走 cmd，v0.8.2 起带 day）、SW 有 dbq 分支并回 via/id、DB_URL 只在回环上',
      /send\(\{ t: 'dbq', q: q, limit: limit, day: day \}\)/.test(spClean) && !/cmd\('dbq'/.test(spClean) &&
      /if \(msg\.t === 'dbq'\)/.test(swSrc) && /via: chan\.via/.test(swSrc) && /id: chrome\.runtime\.id/.test(swSrc) &&
      /^http:\/\/127\.0\.0\.1:8765\/db$/.test(dbUrl), dbUrl);
    ok('dbq 不进 CMDS（它不是转给标签页的命令；进了就会被 toTab 发给内容脚本）',
      cmdsLine.length > 0 && cmdsLine.indexOf("'dbq'") < 0, cmdsLine.slice(0, 40));
    ok('正向对照：把 DB_URL 换成 x.com，同一条回环判据当场变红（证明它咬的是地址本身）',
      /^http:\/\/127\.0\.0\.1:8765\/db$/.test('https://x.com/db') === false, '');
    // v0.8.2 时间线关联三层：core 快照认 tab（真机判据：aria-selected=true 那条的文本）→ page 记录带 tlSrc →
    // 面板选天重查 tl_rank（day 是 SQL 参数）+ 来源筛选（纯前端）+ tlLimit 分页
    ok('时间线关联三层齐：core 有 tlSrcOf 判据并随 page 落 tlSrc、帖子记 fyAt 首次关联；面板 fetchDb 带 tl_rank+tl_days（day 参数）、gridNode 有 tl 分支',
      /function tlSrcOf\(tab, stats\)/.test(coreSrc) && /tlSrc: tlSrcOf\(tab, stats\)/.test(coreSrc) &&
      /tab !== 'home'/.test(coreSrc) && /selected === 'true'/.test(coreSrc) &&
      /tlSrc: last\.tlSrc \|\| undefined/.test(coreSrc) && /rec\.fyAt == null/.test(coreSrc) &&
      /one\('tl_days', 60\)/.test(spClean) && /one\('tl_rank', 500, tlDay\)/.test(spClean) &&
      /m\.cls === 'tl'/.test(spClean) && /tlLimit = 10; fetchDb\(true\)/.test(spClean) &&
      /m\.cards/.test(spClean) && /target = '_blank'/.test(spClean) && /tlMeta/.test(spClean) &&
      /function openTlUser\(author\)/.test(spClean) && /q: 'author_posts', limit: 200, author: author/.test(spClean) &&
      /tlModalWrap/.test(spClean) && /preventDefault\(\); e\.stopPropagation\(\); openTlUser/.test(spClean) &&
      /V\.tlUserRows\(tlUserDb\)/.test(spClean), '');
    // 正向对照改咬「那一行判据」本身：v0.8.6 卡片历史榜里也会出现「为你推荐」这四个字（来源标签），
    // 只数全文出现次数会把标签也数进去，反而证明不了判据被改掉
    const tlSrcMut = coreSrc.replace("if (on.text === '为你推荐') return 'foryou';", "if (on.text === '随便什么') return 'foryou';");
    ok('正向对照：把 core 判据里的「为你推荐」改成别的词，同一条三层判据当场变红（证明它咬的是真机 tab 文本）',
      /on\.text === '为你推荐'\) return 'foryou'/.test(coreSrc) &&
      !/on\.text === '为你推荐'\) return 'foryou'/.test(tlSrcMut) && tlSrcMut !== coreSrc, '');
    ok('广场榜：面板有 grid 分支与 gridNode、两个排序状态是模块级变量、html 有「重读库」并只在广场显形',
      /msg\.k === 'grid'/.test(spSrc) && /function gridNode\(m\)/.test(spSrc) &&
      /let acctSort = 'views', postSort = 'view'/.test(spClean) &&
      spHtml.indexOf('id="bDbRefresh"') >= 0 && /show\('bDbRefresh', view === 'plaza'\)/.test(spClean), '');
    // v0.9.8：这一格从「renderSet 里回显一行 + 底下叠三行安装说明」改成 setBox 的一行 ——
    // ID 常驻在 .secHint（JS 填），完整命令进 ❓ 弹窗（弹窗里可划选复制，不为此多要一条剪贴板权限）
    ok('扩展 ID 摆在设置页那一行（命令进 ❓，但照样建得出、看得见）',
      /id="extIdLine"/.test(spHtml) && /扩展 ID 与安装命令/.test(spHtml) &&
      /querySelector\('#extIdLine'\)/.test(spClean) && /\$\('extIdLine'\)/.test(spClean) &&
      /install-host\.py --ext-id/.test(spClean), '');
    // v0.7.0 修「关注后横幅还绿着」：三条显示路径各钉一处 —— core 回话前吃共享账、面板跟台账事件立即回读、
    // 回包按序号落账（旧回包不许把刚翻红的横幅盖回去）。缺任何一条，真机上就会出现「已经关注了还显示绿」。
    const stateBranch = (coreSrc.match(/if \(msg && msg\.t === 'state'\) \{[\s\S]*?\n    \}/) || [''])[0];
    const syncLine2 = '      try { syncGuardRemote(); } catch (e) { /* 读不到别家的账也不该让面板整页空白 */ }' + (coreSrc.includes('\r\n') ? '\r\n' : '\n');
    ok('core 的 state 分支在回话前先 syncGuardRemote（写在分支里：被问的那页可能在后台被节流）',
      /syncGuardRemote\(\);/.test(stateBranch), stateBranch.slice(0, 60));
    ok('正向对照：把分支里那行 syncGuardRemote 抠掉，上面那条当场变红（证明它咬的是分支内那一行）',
      /syncGuardRemote\(\);/.test(stateBranch.replace(syncLine2, '')) === false, '');
    const hasGuardFeed = (s) => /chrome\.storage\.onChanged\.addListener/.test(s) &&
      /changes\['ysy\.xprobe\.guard'\]/.test(s) && /guardReload = setTimeout\(\(\) => \{[^}]*refreshState\(\)/.test(s);
    ok('面板订阅共享台账变更并立即回读 state（广场 30 秒一轮，冷却只有 60 秒起：等轮询 = 永远慢一拍）',
      hasGuardFeed(spClean), '');
    ok('正向对照：把订阅里那个 guard 键换成别家键，同一条判据当场变红（证明它咬的是键名本身）',
      hasGuardFeed(spClean.replace("changes['ysy.xprobe.guard']", "changes['ysy.xprobe.nope']")) === false, '');
    const ordered = (s) => /const seq = \+\+stateSeq;/.test(s) && /if \(r\.state && seq > stateDone\)/.test(s);
    ok('state 回包按发出序号落账（乱序的旧回包不许把刚翻红的横幅又盖回绿）',
      ordered(spClean), '');
    ok('正向对照：去掉序号条件，同一条判据当场变红',
      ordered(spClean.replace('if (r.state && seq > stateDone)', 'if (r.state)')) === false, '');
    ok('换视图立刻回读一次 state（进广场不该先看半分钟旧横幅）',
      /if \(view === 'plaza'\) fetchDb\(true\);\s*refreshState\(\);/.test(spClean), '');
    // v0.8.1 第一列日期改 YYMMDD：impsNode 必须吃 view 给的 dayDisp（全文日期才回 YYYY-MM-DD）
    const dayDispOk = (s) => /cell\(\(p\.dayDisp \|\| p\.day\) \+ \(p\.hand \? ' \[补\]' : ''\)/.test(s) &&
      (s.match(/p\.dayDisp \|\| p\.day/g) || []).length === 1;
    ok('日点表第一列用 dayDisp 短格式（编辑进了独立窗，侧栏只剩只读表这一处用它）',
      dayDispOk(spClean), '');
    ok('正向对照：把 dayDisp 换回 p.day，同一条判据当场变红',
      dayDispOk(spClean.replace('p.dayDisp || p.day', 'p.day')) === false, '');
    // v0.7.1 修「刷新插件报 <rect> width 负值」：chartSpec 的 box.r / box.b 是右/下边界坐标，
    // 面板旧写法 width = s.w - box.r - box.l = 360 - 354 - 40 = -34，Chrome 抛错并打断整次 render。
    const chartBoxOk = (s) => /Math\.max\(0, box\.r - box\.l\)/.test(s) && /Math\.max\(0, box\.b - box\.t\)/.test(s) &&
      !/width: box\.r - box\.l/.test(s) && !/s\.w - s\.box\.r - box\.l/.test(s);
    ok('折线图 plot 矩形宽高取边界差并夹住 ≥0（旧算式 360-354-40 = -34，Chrome 会拒绝这个 rect）',
      chartBoxOk(spClean), '');
    ok('正向对照：换回 s.w - box.r - box.l 的老算式，同一条判据当场变红（且实算确实等于 -34）',
      chartBoxOk(spClean.replace('Math.max(0, box.r - box.l)', 'box.r - box.l').replace('width: pw', 'width: s.w - box.r - box.l')) === false &&
      360 - (360 - 6) - 40 === -34, '');
    ok('单个节点画坏不再打断整页：appendSafe 把 tick 包在 try/catch 里，四个视图都走它',
      /function appendSafe\(root, list\)/.test(spClean) && /try \{ root\.append\(tick\(m\)\); \}/.test(spClean) &&
      ['mineLines', 'plazaLines', 'debugLines', 'homeLines'].every((f) => new RegExp('appendSafe\\(root, V\\.' + f + '\\(').test(spClean)), '');
    const coreBuild = (coreSrc.match(/const BUILD = '([^']+)'/) || [])[1];
    const panelBuild = (spSrc.match(/const PANEL_BUILD = '([^']+)'/) || [])[1];
    ok('面板自带 build 戳且与 core 一致（footer 两个都打：ui 那颗不跟着走 = 这个面板文档没换）',
      !!coreBuild && coreBuild === panelBuild && /' ui ' \+ PANEL_BUILD/.test(spClean), [coreBuild, panelBuild]);
    // ---------- v0.7.1 补丁四：诊断要能持续供 AI 迭代 ----------
    // ① 通道路由（native/http）必须一路带到日志：适配层透传 via → core 记 lastChan → state/诊断包/beacon 三处都带。
    //    没有它，「宿主装没装对」永远只能靠面板问，日志答不上。
    const viaOk = (s) => /cb\.onload\(\{ status: r\.status \| 0, responseText: String\(r\.responseText \|\| ''\), via: r\.via \|\| '' \}\)/.test(s);
    ok('适配层把通道路由（via）透传给 content：日志里才说得出这条记录是宿主写的还是回环 HTTP 写的',
      viaOk(rd('content/host-shim.js')), '');
    ok('正向对照：把 via 透传抹掉，同一条判据当场变红',
      viaOk(rd('content/host-shim.js').replace(", via: r.via || ''", '')) === false, '');
    ok('SW 的 HTTP 回退也标 via=http（宿主没装时记录照写，但不能写成一笔来路不明的账）',
      /function httpFallback\(msg, ms\)/.test(swSrc) && /r\.via = 'http'/.test(swSrc), '');
    const chanCount = (coreSrc.match(/chan: lastChan/g) || []).length;
    ok('通道路由同时进 state / 诊断包 / beacon 三处（sink 恢复行也算的话至少三处，只进一处换条路看日志就对不上账）',
      chanCount >= 3 && /lastChan = String\(via \|\| ''\)/.test(coreSrc), chanCount);
    ok('正向对照：把三处 chan 全部抹掉，判据当场变红',
      ((coreSrc.replace(/chan: lastChan/g, '')).match(/chan: lastChan/g) || []).length === 0, '');
    // ② debug 心跳：调试开着时按节拍自报 kind=debug（why=on/tick/panel/boot 四种来路），日志里才有时间轴
    const heartbeat = (s) => /const DEBUG_EVERY = \d+ \* 60 \* 1000;/.test(s) && /function debugTick\(\)/.test(s) &&
      /dg\.why = 'tick'; logRec\('debug', dg\);/.test(s) && /try \{ debugTick\(\); \} catch/.test(s) &&
      /everyMs: DEBUG_EVERY/.test(s) && (s.match(/lastDebugAt = Date\.now\(\);/g) || []).length >= 3;
    ok('debug 心跳四层齐：节拍常量 + debugTick + 节拍器里挂调用 + state 带 everyMs（开机/开面板之外还有时间序列）',
      heartbeat(coreSrc), '');
    ok('正向对照：把心跳的 why=tick 摘掉，同一条判据当场变红（证明它咬的是心跳那一行不是别处的 logRec）',
      heartbeat(coreSrc.replace("dg.why = 'tick'; logRec('debug', dg);", '')) === false, '');
    // ③ 面板把这信息摊给用户看，不是只躺在日志里
    const slNat = V.sinkLine({ build: 'x', sink: { ok: true, posted: 3, qlen: 0, lastSinkAt: '2026-10-24T22:00:00', chan: 'native' } });
    const slNo = V.sinkLine({ build: 'x', sink: { ok: true, posted: 3, qlen: 0, lastSinkAt: '2026-10-24T22:00:00' } });
    eq('诊断的 sink 行摊出通道：报 Native；没报通道时不许编一个出来',
      [/Native/.test(slNat.value), /Native/.test(slNo.value)], [true, false]);
    const dbgRow = V.debugLines({ ver: '0.7.1', build: 'x', rndMax: 20, guard: {}, counts: {}, debug: { on: true, everyMs: 600000, lastAt: '2026-10-24T22:00:00.000Z' } })[0];
    ok('诊断首行写明自报节拍与上次落点（下一轮迭代对表时不用翻代码就知道这个点从哪来）',
      /自报每 10 分钟一条/.test(dbgRow.value) && /上次 @/.test(dbgRow.value) && /why=on\/tick\/panel\/boot/.test(dbgRow.title), dbgRow);
    // ---------- v0.6.12 拆页 + 「我的账号」可以在设置里钉死 ----------
    ok('两个视图按钮齐（趋势 → 我的 + 广场），且旧 vTrend 在 html 与代码里都不许残留（不留别名 = 不会有第二条入口）',
      spHtml.indexOf('id="vMine"') >= 0 && spHtml.indexOf('id="vPlaza"') >= 0 &&
      spHtml.indexOf('vTrend') < 0 && spClean.indexOf("'trend'") < 0 && spClean.indexOf('vTrend') < 0,
      [spHtml.indexOf('vTrend'), spClean.indexOf("'trend'")]);
    ok('view 白名单收 mine/plaza/forecast 三个新值（setView 不认的视图会掉回首页，写错一处就是点了没反应）',
      /view = \['home', 'mine', 'plaza', 'debug', 'set', 'forecast'\]\.indexOf\(v\) >= 0 \? v : 'home'/.test(spClean), '');
    ok('视线只在广场换人，其余视图一律回 own（从广场切回首页还挂着别人 = 首页那张今日四列报成他的账号）',
      /return view === 'plaza' \? \(whoSel \|\| own\) : own;/.test(spClean) &&
      /show\('whoPick', view === 'plaza'\)/.test(spClean), '');
    ok('ownSet 三层齐：设置页有输入框与应用键、面板发 cmd(ownSet)、core 有实现、SW 白名单放行',
      spHtml.indexOf('id="ownSet"') >= 0 && spHtml.indexOf('id="bOwnSet"') >= 0 &&
      /cmd\('ownSet'/.test(spClean) && coreHas('ownSet: \\(v\\) => setOwnHandle\\(v\\),') &&
      /'ownSet'/.test(swSrc), '');
    const fakeSwNoOwn = swSrc.replace("'ownSet', ", '');
    ok('正向对照：把 SW 白名单里那个 ownSet 摘掉，上面那条四层判据当场变红（证明它真在查 SW 那份清单）',
      /'ownSet'/.test(fakeSwNoOwn) === false && fakeSwNoOwn.length < swSrc.length, [swSrc.length, fakeSwNoOwn.length]);
    const ohAt = coreSrc.indexOf('function ownHandle()');
    const ohBlock = coreSrc.slice(ohAt, coreSrc.indexOf('\n  }', ohAt));
    const ownPinned = (s) => /if \(ownSet\) return ownSet;/.test(s);
    ok('钉过的 own 优先于 DOM 猜的：ownHandle 第一句就交出手动那份，认错的导航再也覆写不回来',
      ohAt >= 0 && ownPinned(ohBlock) && ohBlock.indexOf('AppTabBar_Profile_Link') > ohBlock.indexOf('if (ownSet) return ownSet;'),
      ohBlock.slice(0, 100));
    ok('正向对照：摘掉那一行，同一条判据当场变红（证明它咬的是 ownHandle 这一块，不是整份源码里随便哪儿有这个词）',
      ownPinned(ohBlock.replace('if (ownSet) return ownSet;', '')) === false, '');
    ok('手动那份与自动那份分键存（同一个键的话「猜的」下一次就覆盖掉「说的」）',
      /const OWN_KEY = 'ysy\.xprobe\.own';/.test(coreSrc) && /const OWN_SET_KEY = 'ysy\.xprobe\.ownSet';/.test(coreSrc), '');
    ok('格式化层导出换名：mineLines/plazaLines 在导出面上，trendLines 一个都不许留（view 只有一份真相）',
      /mineLines: mineLines, plazaLines: plazaLines/.test(viewSrc) && viewSrc.indexOf('trendLines') < 0, '');

    // ---------- v0.8.1-p 预测页签：粉丝折线 + 5,000 / 10,000 到达日（实时：吃 impRows 同一份料） ----------
    const fcHtml = rd('ui/sidepanel.html');
    const fcRows = [
      { day: '2026-10-20', fans: 2312 }, { day: '2026-10-21', fans: 2690 }, { day: '2026-10-22', fans: 3029 },
      { day: '2026-10-23', fans: 3229 }, { day: '2026-10-24', fans: 3417 }, { day: '2026-10-25', fans: 3627 },
    ];
    const fc = V.fansForecastCalc(fcRows);
    eq('预测计算（照 10-25 面板截图六天实料）：A 全期拟合 +255.89/日、B 近3天 +199.33/日、四个到达日各就各位',
      [fc.ok, fc.n, fc.slopeA, fc.slopeB, fc.d5kA, fc.d10kA, fc.d5kB, fc.d10kB],
      [true, 6, 255.89, 199.33, '2026-10-30', '2026-11-19', '2026-11-01', '2026-11-26']);
    const fcDown = V.fansForecastCalc([{ day: '2026-10-20', fans: 3000 }, { day: '2026-10-21', fans: 2900 }, { day: '2026-10-22', fans: 2800 }]);
    ok('正向对照：掉粉序列斜率 ≤0 ⇒ 到达日如实报 null（不编一个日期出来）',
      fcDown.ok === true && fcDown.d5kA === null && fcDown.d10kB === null, fcDown);
    ok('正向对照：不到 3 天有粉丝数的行 ⇒ ok=false',
      V.fansForecastCalc(fcRows.slice(0, 2)).ok === false, '');
    // v0.8.1-q 500k 外推：同一份 trendCalc 咬 eff 列（奖励页 90 天滚动累计读数）。
    // 夹具凑整数斜率：读数日增 1000/1050/1100/1150/1200 → slopeA 恰 1100、B 恰 1150；
    // 末点 495,500 差 4,500：4,500/1100≈4.09 天、4,500/1150≈3.91 天，都进位到 10-29。
    const fceRows = fcRows.map((r, i) => Object.assign({}, r, { eff: [490000, 491000, 492050, 493150, 494300, 495500][i] }));
    const fce = V.effForecastCalc(fceRows);
    eq('500k 外推（eff 累计读数列）：A +1100/日、B +1150/日，两条都到 2026-10-29',
      [fce.ok, fce.n, fce.slopeA, fce.slopeB, fce.d500kA, fce.d500kB],
      [true, 6, 1100, 1150, '2026-10-29', '2026-10-29']);
    const fceDown = V.effForecastCalc([{ day: '2026-10-20', eff: 495000 }, { day: '2026-10-21', eff: 494000 }, { day: '2026-10-22', eff: 493000 }]);
    ok('正向对照：90 天窗口另一头掉天数、读数不升反降 ⇒ 500k 到达日如实报 null（外推不乐观过头）',
      fceDown.ok === true && fceDown.d500kA === null && fceDown.d500kB === null, fceDown);
    const fcView = V.fansForecastLines({ series: { min: [], imp: fceRows.map((r) => ({ day: r.day, value: 100, exact: true, fow: 1, fans: r.fans, eff: r.eff })) } });
    const fcCharts = fcView.filter((s) => s.k === 'chart');
    ok('预测视图：三个到达日钉在最前（50 万有效曝光 → 5,000 粉 → 10,000 粉）+ 两张折线各三条系列 + 日增/读数日增流水',
      fcView[0].label === '50 万有效曝光（奖励门槛）' && fcView[1].label === '5,000 粉丝' && fcView[2].label === '10,000 粉丝' &&
      fcCharts.length === 2 && fcCharts.every((c) => c.series.length === 3) &&
      fcCharts[0].series[0].pts.split(' ').length === 6 && fcCharts[1].series[0].pts.split(' ').length === 6 &&
      fcView.some((s) => s.k === 'line' && /日增/.test(s.text)) && fcView.some((s) => s.k === 'line' && /读数日增/.test(s.text)),
      fcView.map((s) => s.k + ':' + (s.label || '')));
    ok('正向对照：转化率上下文跟 impRows 派生 rate 走（effDay/value，夹具末日 1200/100 ⇒ 1200%）；值派生不出来（value=0）⇒ 如实给「—」',
      /当前转化率 1200%/.test(fcView[0].title || '') === true &&
      /当前转化率 —/.test(V.fansForecastLines({ series: { min: [], imp: fceRows.map((r) => Object.assign({}, r, { value: 0 })) } })[0].title || '') === true, fcView[0]);
    ok('正向对照：点不够时预测视图不空转也不画空图，一条 warn 行说明怎么凑料',
      V.fansForecastLines({ series: { min: [], imp: [] } })[0].sty === 'warn', '');
    ok('页签五处齐：view 白名单 + doView 分支 + tabsOn 高亮 + B 表接线 + html 按钮（barTrend 也在预测页亮着）',
      /'home', 'mine', 'plaza', 'debug', 'set', 'forecast'/.test(spSrc) &&
      /view === 'forecast'\) appendSafe\(root, V\.fansForecastLines\(st\)\)/.test(spSrc) &&
      /forecast: 'vFc'/.test(spSrc) && /vFc: \(\) => setView\('forecast'\)/.test(spSrc) &&
      /id="vFc"/.test(fcHtml) &&
      /show\('barTrend', view === 'mine' \|\| view === 'plaza' \|\| view === 'forecast'\)/.test(spSrc), '');
    ok('正向对照：把 doView 那条分支摘掉，同一条判据当场变红',
      /view === 'forecast'\) appendSafe/.test(spSrc.replace("else if (view === 'forecast') appendSafe(root, V.fansForecastLines(st));", '')) === false, '');
    ok('格式化层导出：fansForecastCalc/effForecastCalc/fansForecastLines 在导出面上',
      /fansForecastCalc: fansForecastCalc, effForecastCalc: effForecastCalc, fansForecastLines: fansForecastLines/.test(viewSrc), '');

    // ---------- v0.8.1-r 「我的」页顶部可复制日志摘要（五段固定格式，用户裁定 2026-10-25） ----------
    const dshift = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const dgRows = [dshift(-3), dshift(-2), dshift(-1), dshift(0)].map((day, i) => ({ day, value: 100, exact: true, fow: 1, fans: [3029, 3229, 3417, 3627][i], eff: [492050, 493150, 494300, 495500][i] }));
    const dg = V.mineDigestText({ series: { min: [], imp: dgRows } }).split('\n');
    // rate 是 impRows 派生的 effDay/value：t-2 差分 1100 ⇒ 1100%，t-1 1150%；t-3 没有前一行差不出 ⇒ 如实「—」
    eq('日志摘要五段齐（照今天本机日期）：首行 YYMMDD日志 / 转化率 昨天·前天·大前天 / 粉丝数 今天·昨天·前天 / 万粉与工资两个到达日',
      [dg[0], dg[1], dg[2],
        /万粉 预测日期：\d{2}-\d{2}/.test(dg[3]),
        /拿到工资预测日期：\d{2}-\d{2}/.test(dg[4])],
      [dshift(0).replace(/-/g, '').slice(2) + '日志',
        '转化率：昨天 1150%，前天 1100%，大前天 —',
        '粉丝数：今天 3,627，昨天 3,417，前天 3,229',
        true, true]);
    const dgEmpty = V.mineDigestText({ series: { min: [], imp: [] } });
    ok('正向对照：没数据时摘要照常出五段，缺的值如实「—」、到达日如实「点不够」不硬编',
      /转化率：昨天 —，前天 —，大前天 —/.test(dgEmpty) && /粉丝数：今天 —，昨天 —，前天 —/.test(dgEmpty) &&
      /万粉 预测日期：点不够/.test(dgEmpty) && /拿到工资预测日期：点不够/.test(dgEmpty), dgEmpty);
    ok('摘要落地三处齐：doView 里 mine 分支先塞 digestBox 再画 mineLines + digestBox 定义 + css 样式（.digestBox/.digestTa）',
      /view === 'mine'\) \{ root\.append\(digestBox\(V\.mineDigestText\(st\)\)\); appendSafe\(root, V\.mineLines\(st\)\); \}/.test(spSrc) &&
      /function digestBox\(text\)/.test(spSrc) &&
      /\.digestBox \{/.test(rd('ui/sidepanel.css')) && /\.digestTa \{/.test(rd('ui/sidepanel.css')), '');
    ok('正向对照：把 mine 分支里的 digestBox 摘掉，同一条判据当场变红',
      /root\.append\(digestBox/.test(spSrc.replace('root.append(digestBox(V.mineDigestText(st)));', '')) === false, '');
    ok('900ms 回读整页重画，摘要框内容没变就复用同一节点（手动划选/聚焦不被每 0.9 秒拆一次）',
      /if \(digestEl && digestEl\.dataset\.txt === text\) return digestEl;/.test(spSrc) &&
      /mineDigestText: mineDigestText/.test(viewSrc), '');

    // ---------- v0.8.1-s 六行日报「复制日报」（用户裁定格式 2026-10-25） ----------
    // 日报夹具：粉丝/eff 用预测块同款六天（10-20..25，d5kA=10-30 / d10kA=11-19 已在预测块钉死），
    // 但 value=1000、eff 步长 +124 ⇒ 派生转化率恰 12.4%（<15 会带「希望明天破15%」）；
    // 新朋友吃分钟线读数差：今天两个 following 点 26000→26290 = 290（手动基线 26000 同首页口径）。
    const repRows = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map((day, i) => ({ day, value: 1000, exact: true, fow: 1, fans: [2312, 2690, 3029, 3229, 3417, 3627][i], eff: 495000 + i * 124 }));
    const repSt = {
      guard: { goalToday: { base: 26000, baseSrc: 'hand', target: 399 } },
      series: { min: [{ ts: Date.now() - 60000, following: 26000 }, { ts: Date.now(), following: 26290 }], imp: repRows },
    };
    eq('日报六行逐字钉死（290 新朋友 / 466 评论 / 12.4% 破15 / 26年11月 / 10月30日 / 11月19日）',
      V.mineReportText(repSt, 466).split('\n'),
      ['认认真真认识了290个新朋友', '认认真真评论了466个评论', '最新转化率12.4%希望明天破15%',
        '50万曝光预测到26年11月了', '5000粉丝预测到10月30日', '一万粉丝预测需要到11月19日']);
    ok('正向对照：转化率 ≥15% ⇒ 不硬塞「希望明天破15%」；缺数各行如实「—」/「还没测出来」',
      /最新转化率1200%\n/.test(V.mineReportText({ guard: repSt.guard, series: { min: repSt.series.min, imp: dgRows } }, 466)) &&
      V.mineReportText({ series: { min: [], imp: [] } }, null) ===
        '认认真真认识了—个新朋友\n认认真真评论了—个评论\n最新转化率—\n' +
        '50万曝光预测到……还没测出来\n5000粉丝预测到……还没测出来\n一万粉丝预测需要到……还没测出来', '');
    ok('日报落地三处齐：view 导出 mineReportText + digestBox 里的「复制日报」钮与评论数格（按天 chrome.storage.local，UI 层禁 localStorage）+ css .digestRep',
      /mineReportText: mineReportText/.test(viewSrc) &&
      /repBtn\.textContent = '复制日报'/.test(spSrc) && /chrome\.storage\.local\.get\('repl'/.test(spSrc) && /chrome\.storage\.local\.set\(\{ repl:/.test(spSrc) &&
      !/localStorage/.test(spSrc) &&
      /function mineReportText\(st, repl\)/.test(viewSrc) &&
      /\.digestBox \.digestRep \{/.test(rd('ui/sidepanel.css')), '');
    ok('正向对照：评论数没填 ⇒ 钮上明说「先填评论数」不硬编一个数出去',
      /if \(n == null\) \{\s*\n\s*repBtn\.textContent = '先填评论数';/.test(spSrc), '');

    // ---------- v0.8.0 云端同步：默认关、域名写死、身份只走 token 头 ----------
    const wc = runSW({});
    const cs0 = await wc.__send({ t: 'cloudState' });
    eq('云端同步默认关（不登录一个字节都不出门），deviceId 已生成并落存储（浏览器 profile 级随机 UUID，非指纹）',
      [cs0.ok, cs0.on, cs0.hasToken, (cs0.deviceId || '').length >= 8, !!wc.__map['ysy.xprobe.deviceId']],
      [true, false, false, true, true]);
    const cs1 = await wc.__send({ t: 'cloudState' });
    eq('deviceId 稳定（第二次问是同一个，不是每次现造）', cs1.deviceId, cs0.deviceId);
    const badMail = await wc.__send({ t: 'cloudSendCode', email: 'not-an-email' });
    eq('邮箱格式不对就地拒绝，不出网（fetch 一次都没发生）', [badMail.ok, wc.__fetchCalls()], [false, 0]);
    // 登录桩回的是 boot4 codeLogin 的 Result 形状 {code,message,data:{token,user}}
    const wl = runSW({ text: JSON.stringify({ code: 200, message: 'ok', data: { token: 'tok-1', user: { id: 'u1', nickName: '示例' } } }) });
    // v0.10.3 起登录的回包要等「登录后那第一趟」两条腿跑完才发（慢云端就是十几秒），所以这里必须用 __call 等 sendResponse，
    // 不能再是 __send 那一拍——用 __send 会读到 undefined（这条是本轮改登录时自己撞出来的）
    const lg = await wl.__call({ t: 'cloudLogin', email: 'a@b.co', code: '1234' }, 4000);
    const acctWl = (wl.__map['ysy.xprobe.cloud'] || {}).acct || {};
    eq('登录成功：闸打开 + token/邮箱落进「线上」那一档的格子（身份只进扩展自己的存储，另一档一个字都不写）',
      [lg.ok, wl.__map['ysy.xprobe.cloud'].on, acctWl.prod && acctWl.prod.token, acctWl.prod && acctWl.prod.email, acctWl.dev],
      [true, true, 'tok-1', 'a@b.co', undefined]);
    const ws = runSW({
      store: {
        'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-9', email: 'a@b.co', userId: 'u1' } } },
        'ysy.xprobe.series': { demo_own: { handle: 'demo_own', min: [], updatedAt: 1, imp: [
          { day: '2026-10-24', value: 10500, eff: 9900, exact: true, token: 'analytics', fow: 812, fans: 1290, posts: 45, at: '2026-10-24T10:00:00Z' },
          { day: '2026-10-23', value: null, eff: 8800, token: 'manual', fow: null, fans: null, posts: 44, at: '2026-10-23T09:00:00Z' },
        ] } },
        'ysy.xprobe.guard': { follows: [1], ev: [{ at: 1760000000000, dir: 'follow', handle: 'demo_peer', why: 'plaza', w15: 3, w24: 40, suspect: false }] },
      },
      text: JSON.stringify({ code: 200, message: '已入库', data: { dayRowsNew: 2, followEventsNew: 1 } }),
    });
    const sy = await ws.__send({ t: 'cloudSyncNow' });
    const init = ws.__lastInit || {};
    let body = {};
    try { body = JSON.parse(init.body || '{}'); } catch (e) { /* 回包另测 */ }
    eq('同步地址 = api2.mingzhang.cc 的 ingest（唯一出本机的域，写死在 SW；v0.9.9 从 m. 挪过来——m. 是前端，/api/* 回 HTML 404）', ws.__lastUrl, 'https://api2.mingzhang.cc/api/xprobe/ingest');
    eq('身份只放请求头 token（httpXhr 固定 credentials:omit，全程无 cookie）', (init.headers || {}).token, 'tok-9');
    eq('拆列口径在云端不变形：value→exposure、eff→effective、fow→following、fans→followers',
      [body.dayRows && body.dayRows[0].exposure, body.dayRows && body.dayRows[0].effective,
        body.dayRows && body.dayRows[0].following, body.dayRows && body.dayRows[0].followers, body.dayRows && body.dayRows[0].posts],
      [10500, 9900, 812, 1290, 45]);
    eq('手补行标 manual=1、分析页行标 source=analytics（服务端分得清哪格是人填的）',
      [body.dayRows && body.dayRows[0].source, body.dayRows && body.dayRows[0].manual, body.dayRows && body.dayRows[1].manual],
      ['analytics', 0, 1]);
    eq('关注事件映射：dir/target/why/窗口计数都在，时间戳换成了自然日',
      [body.followEvents && body.followEvents[0].dir, body.followEvents && body.followEvents[0].target,
        body.followEvents && body.followEvents[0].why, body.followEvents && body.followEvents[0].w15,
        /^\d{4}-\d{2}-\d{2}$/.test((body.followEvents && body.followEvents[0].day) || '')],
      ['follow', 'demo_peer', 'plaza', 3, true]);
    eq('同步状态落存储（面板「同步状态」行读的就是它）',
      [ws.__map['ysy.xprobe.cloudStat'].ok, ws.__map['ysy.xprobe.cloudStat'].dayRows], [true, 2]);
    ok('正向对照：同步没开时点同步，一个请求都不发（默认关的承诺在代码上成立）', await (async () => {
      const woff = runSW({ store: { 'ysy.xprobe.cloud': { on: false, acct: { prod: { token: 'tok-9' } } } }, text: '{}' });
      const r = await woff.__send({ t: 'cloudSyncNow' });
      return r.ok === false && woff.__fetchCalls() === 0;
    })(), '');
    const wx = runSW({
      store: {
        'ysy.xprobe.cloud': { on: true, acct: { prod: { token: 'old' } } },
        'ysy.xprobe.series': { demo_own: { handle: 'demo_own', min: [], updatedAt: 1, imp: [{ day: '2026-10-24', value: 1, at: 'x' }] } },
      },
      text: JSON.stringify({ code: 403, message: '需要登录' }),
    });
    const rx = await wx.__send({ t: 'cloudSyncNow' });
    eq('token 失效（code 403）单独标 needLogin，不能跟「网络坏了」混成一句话',
      [rx.ok, rx.needLogin, wx.__map['ysy.xprobe.cloudStat'].needLogin], [false, true, true]);
    // ---- v0.9.9：用户真机「发验证码」收到 HTTP 404 量出来的三笔账（域名 + 两种回包的说法）----
    const wc4 = runSW({ text: JSON.stringify({ code: 200, message: '验证码已发送', data: 'a@b.co' }) });
    const sCode = await wc4.__send({ t: 'cloudSendCode', email: 'a@b.co' });
    eq('发验证码打到 api2 的 sendEmail（v0.9.9 前打的是 m. —— 那是 Next.js 前端，/api/* 回 HTML 404，前端自己也是调 api2 的）',
      [sCode.ok, wc4.__lastUrl], [true, 'https://api2.mingzhang.cc/api/mz/user/sendEmail']);
    const wHtml = runSW({ text: '<!DOCTYPE html><html lang="zh-CN">404</html>' });
    const sHtml = await wHtml.__send({ t: 'cloudSendCode', email: 'a@b.co' });
    ok('回包不是 JSON ⇒ 把打到的地址一起报出来（「走错门」和「服务没起」不能糊成一句 HTTP 404）',
      sHtml.ok === false && /不是 JSON/.test(sHtml.err || '') && /api2\.mingzhang\.cc\/api\/mz\/user\/sendEmail/.test(sHtml.err || ''), sHtml);
    const wNoRoute = runSW({ text: JSON.stringify({ code: 404, message: '请求的资源不存在', data: null }) });
    const sNoRoute = await wNoRoute.__send({ t: 'cloudSendCode', email: 'a@b.co' });
    ok('boot4 的兜底把「没有这个路由」包成 HTTP 200 + code 404 ⇒ 说成「接口还没部署」，不许骗用户去重新登录',
      sNoRoute.ok === false && !sNoRoute.needLogin && /接口/.test(sNoRoute.err || '') && /部署/.test(sNoRoute.err || ''), sNoRoute);
    const cloudSrc = rd('background/sw.js') + rd('ui/sidepanel.js') + rd('ui/sidepanel.html') + rd('manifest.json');
    ok('变异对照：插件源码里再没有 https://m.mingzhang.cc 这一跳（注释里讲历史的「m.」不算，判的是能发出去的地址）',
      !/https:\/\/m\.mingzhang\.cc/.test(cloudSrc), (cloudSrc.match(/https:\/\/m\.mingzhang\.cc\S*/g) || []).slice(0, 3));
    const rLoop = await runSW({}).__send({ t: 'xhr', url: 'https://api2.mingzhang.cc/api/xprobe/ingest', method: 'POST', data: '{}' });
    ok('core 的 xhr 通道对云域名照样拒发（云只有 SW 内部这一跳，isLoopback 白名单没松动；用的是真在用的那条域，不是随便挑的域名）',
      rLoop && /拒发/.test(rLoop.err || ''), rLoop);
  }

  console.log('\n[16] v0.8.6 卡片历史榜：/home 上按时间窗读本机库（钮→dbq 参数→渲染/报错，别处不露）');
  {
    const HIST_ROWS = [
      { tweet_id: '7', author: 'lib_a', text: '库里的甲帖', at: '2026-10-26T09:15:02Z', view: 4321, like: 9, reply: 3, tl_src: 'foryou' },
      { tweet_id: '8', author: 'lib_b', text: '库里的乙帖', at: '2026-10-25T21:03:00Z', view: 120, like: 1, reply: 0, tl_src: 'following' },
    ];
    const sh = run(homeFixture, '/home', 'https://x.com/home');
    sh.__dbSent = [];
    // SW 桩：只接 dbq（记下来、按模式回包），别的消息照原桩走（不然开面板/队列这些旁路断言会被带歪）
    const wire = (reply) => {
      sh.chrome.runtime.sendMessage = (m, cb) => {
        if (m && m.t === 'dbq') { sh.__dbSent.push(m); if (cb) cb(reply ? reply(m) : undefined); return; }
        sh.__rtMsgs.push(m);
        if (cb) cb(undefined);
      };
    };
    wire(() => ({ ok: true, rows: HIST_ROWS }));
    const C = () => IDS['ysy-xprobe-ext-card'];
    const btn = (label) => C().querySelectorAll('button').find((b) => b.textContent === label);
    const histRowsOf = (card) => card.children.filter((c) => c.children[0] && c.children[0].children[0] && /^#\d+$/.test(c.children[0].children[0].textContent));
    sh.__xprobe.cardBtn().fire('click');
    ok('/home 的卡片多一颗「历史」档（别的地方没有这条数据源）', !!btn('历史') && !!btn('本页'), C().textContent.slice(0, 60));

    btn('历史').fire('click');
    await tick();
    eq('切到历史档：默认时间窗是近1天，卡片只发一条 dbq（白名单查询名 + hours，绝不带 SQL）',
      sh.__dbSent[0], { t: 'dbq', q: 'tl_win', limit: 12, hours: 24 });
    const h1 = C();
    eq('历史行按库给的顺序出（曝光降序是库排的，卡片不重排）：#1=4321 甲帖、#2=120 乙帖',
      [histRowsOf(h1).length, histRowsOf(h1)[0].textContent.indexOf('4321') >= 0, histRowsOf(h1)[1].textContent.indexOf('120') >= 0],
      [2, true, true]);
    const locAt = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    ok('历史行带作者/来源标签/采集时刻（v0.9.2 起写本机钟点：库里 09:15Z 在 UTC+8 的机器上画 17:15，以前切字面 = 画 UTC，比墙上钟早 8 小时）',
      /@lib_a/.test(histRowsOf(h1)[0].textContent) && /为你推荐/.test(histRowsOf(h1)[0].textContent) &&
      histRowsOf(h1)[0].textContent.includes(locAt('2026-10-26T09:15:02Z')) &&
      /正在关注/.test(histRowsOf(h1)[1].textContent),
      histRowsOf(h1)[0].textContent);
    ok('历史档不露「曝光/评论」重排钮（窗内排序归库），「刷」换成重读本机库',
      !btn('评论') && !btn('曝光') && !!btn('刷'), C().textContent.slice(0, 80));

    const winCase = async (label, hours) => {
      btn(label).fire('click');
      await tick();
      const m = sh.__dbSent[sh.__dbSent.length - 1];
      return [label, m && m.hours, m && m.from];
    };
    eq('时间窗钮各对各的小时数：1时=1 / 6时=6 / 1周=168 / 1月=720 / 全部=0（0 是「全部」，不是「没传」）',
      [await winCase('1时', 1), await winCase('6时', 6), await winCase('1周', 168), await winCase('1月', 720), await winCase('全部', 0)],
      [['1时', 1, undefined], ['6时', 6, undefined], ['1周', 168, undefined], ['1月', 720, undefined], ['全部', 0, undefined]]);

    // 自定区间：起止日走 from/to 两个参数（不再递 hours），坏日期只报错不发问
    const inputs = C().querySelectorAll('input');
    inputs[0].value = '2026-10-20'; inputs[1].value = '2026-10-25';
    const nBefore = sh.__dbSent.length;
    btn('查').fire('click');
    await tick();
    eq('查起止日：只发 from/to（不混带 hours），窗口文案换成日期区间',
      [sh.__dbSent.length - nBefore, sh.__dbSent[sh.__dbSent.length - 1].from, sh.__dbSent[sh.__dbSent.length - 1].to,
        sh.__dbSent[sh.__dbSent.length - 1].hours, /2026-10-20 ~ 2026-10-25/.test(C().textContent)],
      [1, '2026-10-20', '2026-10-25', undefined, true]);
    const nBad = sh.__dbSent.length;
    C().querySelectorAll('input')[0].value = '2026-10-26';
    C().querySelectorAll('input')[1].value = '2026-10-01';
    btn('查').fire('click');
    eq('正向对照：起 > 止当场报错、一个请求都不发（不拿默认窗硬查）',
      [sh.__dbSent.length - nBad, /起止日要 YYYY-MM-DD/.test(C().textContent)], [0, true]);

    // 报错要说人话：没回包 / 库拒绝 / 窗里没数据，三种都不是「空榜」
    wire(null);
    btn('刷').fire('click');
    await tick();
    ok('宿主/sink 没回话 ⇒ 老实说「本机库没回话」，不画空榜', /本机库没回话/.test(C().textContent), C().textContent.slice(0, 80));
    wire(() => ({ ok: false, err: '未知查询 tl_win' }));
    btn('刷').fire('click');
    await tick();
    ok('库拒绝 ⇒ 原样转述原因（不吞成一句「加载失败」）', /本机库拒了：未知查询 tl_win/.test(C().textContent), C().textContent.slice(0, 80));
    wire(() => ({ ok: true, rows: [] }));
    btn('刷').fire('click');
    await tick();
    ok('窗口里确实没帖子 ⇒ 说清窗口名与原因（home 快照攒过才有排）',
      /库里没有带曝光数的帖子/.test(C().textContent) && /窗口=2026-10-20 ~ 2026-10-25/.test(C().textContent), C().textContent.slice(0, 100));

    wire(() => ({ ok: true, rows: HIST_ROWS }));
    btn('刷').fire('click');
    await tick();
    const nCache = sh.__dbSent.length;
    btn('本页').fire('click');
    eq('切回「本页」：档名回到本页曝光榜，历史进度不丢', [/本页曝光榜/.test(C().textContent), !!btn('历史')], [true, true]);
    btn('历史').fire('click');
    await tick();
    eq('再切回「历史」：同一窗口直接用缓存，不再发问', [sh.__dbSent.length - nCache, histRowsOf(C()).length], [0, 2]);
    btn('×').fire('click');
    eq('历史档测完收摊', IDS['ysy-xprobe-ext-card'], undefined);

    // 非 /home：数据源开关不露（那里没有「整条首页时间线」这件事），卡片还是老样子
    const sp = run(profile, '/demo_own', 'https://x.com/demo_own');
    sp.__xprobe.cardBtn().fire('click');
    const pcard = IDS['ysy-xprobe-ext-card'];
    ok('profile 页卡片没有「历史」档、也没有时间窗钮（不露一颗永远点不亮的钮）',
      !pcard.querySelectorAll('button').some((b) => b.textContent === '历史') &&
      !pcard.querySelectorAll('button').some((b) => b.textContent === '1时') && /本页曝光榜/.test(pcard.textContent), pcard.textContent.slice(0, 60));
    pcard.querySelectorAll('button').find((b) => b.textContent === '×').fire('click');
  }

  console.log('\n[17] v0.8.8 本机文件与清理：占用行的三种形状 / SW 只转述四个受控值 / 面板三枚钮先 DRY 再实删');
  {
    const M = 1048576;
    const F = {
      ok: true, fs: 'fs-1', dir: 'D:\\code\\yunxiao\\temp\\xprobe', keep: 7, auto: true, lastAuto: '2026-10-26',
      total: 100 * M, items: {
        logs: { bytes: 30 * M, files: 12, cleanable: 20 * M, cleanableFiles: 5 },
        dump: { bytes: 18 * M, dirs: 95, cleanable: 0, cleanableOld: 0 },
        db: { bytes: 477 * M, free: null }, host: { bytes: 4 * M },
      },
      runs: [{ at: '2026-10-26T19:38:18', target: 'logs', keep: 7, removed: 4, freed: 3611, failed: 0 }],
    };
    const r0 = V.fsRow(null);
    ok('没测过时这行自己说该点哪枚钮（不摆一个空值让人以为面板坏了）',
      r0.k === 'row' && /本机文件与清理/.test(r0.label) && /还没测/.test(r0.value) && r0.sty === 'warn', r0);
    const rE = V.fsRow({ ok: false, err: '测量 本机 10 秒没回' });
    ok('测不到 ⇒ 把原因与「sink-18/宿主」一起点名（不许显示一个 0MB 糊过去）',
      /10 秒没回/.test(rE.value) && /sink-18/.test(rE.value) && rE.sty === 'warn', rE.value);
    const r1 = V.fsRow(F);
    ok('量到了 ⇒ 四档各报自己的数、合计、保留天数与各自的可清量',
      /日志 30MB\/12个/.test(r1.value) && /转储 18MB\/95份/.test(r1.value)
      && /库 477MB 空闲未知/.test(r1.value) && /宿主日志 4MB/.test(r1.value) && /计 100MB/.test(r1.value)
      && /保留 7 天可清：日志 20MB 转储 0KB/.test(r1.value), r1.value);
    ok('有得清 ⇒ 整行标黄；title 写清「可清」按文件名判龄、库不在自动清理范围、上次实删是哪天',
      r1.sty === 'warn' && /文件名里的日期/.test(r1.title) && /VACUUM（压实空闲页），一行数据都不删/.test(r1.title)
      && /上次实删：日志 4 个/.test(r1.title) && /上次自动清理 2026-10-26/.test(r1.title), r1.title);
    const r2 = V.fsRow(Object.assign({}, F, {
      // 什么都不剩的一档：没实删过（runs 空）、今天还没自动扫过（lastAuto 空）、空闲页量到的是真 0
      lastAuto: '', runs: [], items: Object.assign({}, F.items,
        { logs: { bytes: 3 * M, files: 1, cleanable: 0 }, db: { bytes: 2 * M, free: 0 } }),
    }));
    ok('正向对照：真没什么可清时不标黄；空闲页量到的 0 就照打 0（0 是「真没空闲」，null 才是「不知道」）',
      r2.sty === '' && /空闲0KB/.test(r2.value) && !/上次实删/.test(r2.title) && !/自动清理 2026/.test(r2.title),
      r2.value);

    const wF = runSW({ text: '{"ok":true,"fs":"fs-1","total":123,"keep":7}' });
    const rq = await wF.__send({ t: 'fsq' });
    ok('读占用：GET 打死的回环 /fs（面板不发 URL、不发路径），回包带上 via/at/what 供面板说清走的是哪条道',
      [wF.__lastUrl, wF.__lastInit.method, rq.ok, rq.total, rq.what], ['http://127.0.0.1:8765/fs', 'GET', true, 123, '测量'],
    );
    ok('刚删完想立刻再量一遍时可以不扫（?auto=0 这一档是给「只量不删」留的）',
      [await wF.__send({ t: 'fsq', auto: false }).then(() => wF.__lastUrl)], ['http://127.0.0.1:8765/fs?auto=0']);
    const nq = wF.__nativeQ[wF.__nativeQ.length - 1];
    eq('Native 那条也认 /fs：GET 摊平成 {t:fs,op:sizes,auto}（宿主那边不用解析 URL）',
      [nq.payload.t, nq.payload.op, nq.payload.auto], ['fs', 'sizes', false]);
    const fc = wF.__fetchCalls();
    const cbad = await wF.__send({ t: 'fsc', data: '{"op": "clean"' });
    eq('正向对照：body 不是 JSON ⇒ 当场拒、一个请求都不发（清理这种动作不许「猜个默认值」）',
      [cbad.ok, /清理参数不对/.test(cbad.err), wF.__fetchCalls() - fc], [false, true, 0]);
    await wF.__send({ t: 'fsc', data: JSON.stringify({ op: 'clean', target: 'logs', dry: false }) });
    const body1 = JSON.parse(wF.__lastInit.body);
    ok('写明白 op=clean + dry=false 才把实删透传过去；body 里只有四个受控值外加帧名 t（没有 path、没有 glob、没有 SQL）',
      Object.keys(body1).sort().join(',') === 'auto,dry,op,t,target'
      && !/(path|dir|glob|sql|pattern|cmd)/.test(Object.keys(body1).join(','))
      && body1.op === 'clean' && body1.target === 'logs' && body1.dry === false, body1);
    eq('URL 仍是回环 /fs，方法 POST', [wF.__lastUrl, wF.__lastInit.method], ['http://127.0.0.1:8765/fs', 'POST']);
    await wF.__send({ t: 'fsc', data: JSON.stringify({ op: 'clean', target: '../logs', dry: false, keep: 0 }) });
    const body2 = JSON.parse(wF.__lastInit.body);
    ok('target 里塞 ../ ⇒ 筛成空串（本机那侧再拒一次，两道都拦）；keep=0 不落进 body（缺省即「本机按 7 天」）',
      body2.target === '' && body2.keep === undefined, body2);
    await wF.__send({ t: 'fsc', data: JSON.stringify({ op: 'rm -rf', target: 'dump', dry: false }) });
    eq('op 不在白名单 ⇒ 落到最保守的那一档（clean），且不带坏 op',
      JSON.parse(wF.__lastInit.body).op, 'clean');
    const wN = runSW({ native: { reply: { status: 200, body: '{"ok":true,"removed":1,"freed":2048}' } } });
    const rn = await wN.__send({ t: 'fsc', data: JSON.stringify({ op: 'clean', target: 'dump', keep: 14, dry: false }) });
    ok('装了宿主 ⇒ 走宿主、不发 HTTP；keep 在宿主那一侧摊平成 days',
      [wN.__fetchCalls(), rn.ok, rn.removed, wN.__nativeQ[0].payload.t, wN.__nativeQ[0].payload.days], [0, true, 1, 'fs', 14]);
    eq('宿主那条帧的 op/target/dry 原样带过去（两扇门同一份契约）',
      [wN.__nativeQ[0].payload.op, wN.__nativeQ[0].payload.target, wN.__nativeQ[0].payload.dry], ['clean', 'dump', false]);
  }
  {
    const spFs = rd('ui/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
    const htmlFs = rd('ui/sidepanel.html');
    ok('设置页的占用行只经由 V.fsRow 出来（面板一个 MB 都不自己算，免得和本机两套口径）',
      /root\.append\(rowNode\(V\.fsRow\(fs\)\)\)/.test(spFs), '');
    ok('三枚动作钮都在：清日志 / 清转储 / 整理库（前两枚删文件，第三枚只压实库、不删行）',
      /bCleanLogs: \(\) => fsClean\('logs'\)/.test(spFs) && /bCleanDump: \(\) => fsClean\('dump'\)/.test(spFs)
      && /bVacuum: \(\) => fsVacuum\(\)/.test(spFs) && /bFsRefresh: \(\) => fsRefresh\(true\)/.test(spFs), '');
    ok('两下才动手：第一发永远 dry:true，只有 60 秒内的第二发才 dry:false（armed 过期就作废）',
      /const on = armed\[key\] && \(Date\.now\(\) - armed\[key\] < ARM_MS\)/.test(spFs)
      && /armed\[key\] = 0;\s*\n\s*syncFsControls\(\);\s*\n\s*return run\(false\)/.test(spFs)
      && /return run\(true\)\.then/.test(spFs), '');
    ok('面板发给本机的只有 op/target/dry（keep 走 conf 那一档）；没有 path/dir 这类键',
      /send\(\{ t: 'fsc', data: JSON\.stringify\(\{ op: 'clean', target: target, dry: dry \}\) \}\)/.test(spFs)
      && !/fsc[\s\S]{0,160}(path|dir|glob|sql)/.test(spFs), '');
    ok('保留天数一格：非 1~365 的整数当场拒、不发请求（坏值不许本机去猜）',
      /!Number\.isInteger\(raw\) \|\| raw < 1 \|\| raw > 365/.test(spFs)
      && /没发出去，一个文件都没动/.test(spFs), '');
    ok('自动清理开关的文本从本机回包来（fs.auto），面板不存第二份真相',
      /'自动清理: ' \+ \(fs && fs\.auto \? '开' : '关'\)/.test(spFs), '');
    ok('切进设置页顺手量一次（用户不必先点「重测」才看到数），且这一趟允许撞每日那一枪；顺手也回读一次标杆/档案同步状态（v0.10.6）；v0.11.4 起顺手回读一次本机模型那一节',
      /vSet: \(\) => \{ setView\('set'\); fsRefresh\(\); return Promise\.all\(\[cloudRefresh\(\), xsRefresh\(\), libRefresh\(\), modelRefresh\(\)\]\); \}/.test(spFs), '');
    ok('钮的字面随状态重画（等第二下的那枚改口叫「再点一次=真删」，确认状态写在钮上）',
      /再点一次=真删/.test(spFs) && /syncFsControls\(\);/.test(spFs), '');
    ok('html 里三枚钮都在 setBox 之内（视图一切走整块隐藏），两枚删文件的带 btnDanger',
      /id="setBox"[\s\S]*bCleanLogs[\s\S]{0,90}btnDanger[\s\S]*bCleanDump[\s\S]{0,90}btnDanger[\s\S]*bVacuum/.test(htmlFs)
      && /id="fsKeep" type="number" min="1" max="365"/.test(htmlFs), '');
    ok('SW 侧 fsq/fsc 不进 CMDS（它们是本机通道，不是转给标签页的命令），且 URL 只在回环上',
      /if \(msg\.t === 'fsq'\)/.test(swSrc) && /if \(msg\.t === 'fsc'\)/.test(swSrc)
      && /const FS_URL = 'http:\/\/127\.0\.0\.1:8765\/fs'/.test(swSrc)
      && (swSrc.match(/const CMDS = \[[^\]]*\]/)[0].indexOf('fsq') < 0), '');
    ok('本机那侧的版本戳都写进了报错话术（旧 sink 没 /fs 时面板知道要重启 bat；v0.9.3 起还点名「装了宿主的机器要重跑 install-host.py 重打包」——上一轮「重启 bat 就能领新版」的说法在装了宿主的机器上是空话）',
      /sink-18/.test((rd('ui/view.js') + rd('ui/sidepanel.js')).replace(/^\s*\/\/.*$/gm, ''))
      && /重启 start-sink\.bat 领 sink-18/.test(swSrc) && /install-host\.py/.test(swSrc), '');
  }

  console.log('\n[18] v0.8.9 徽标开关（v0.8.16 起默认开）：拨回关 ⇒ 当场摘干净 / 名单行尾照样能拉黑');
  {
    // 起因是用户现场：「开了这个插件评论区就不正常，鼠标放上去就会移动走」。量出来是那颗缝在 X 名字行里的
    // 「拉黑」徽标：margin-left + 一颗 15px 高的按钮 ⇒ 那一行的宽和高被改 ⇒ 光标底下的东西挪位；React 重渲染
    // 把我们的节点丢掉，观察器又看见「有别家节点挂上来」⇒ 再缝一遍 ⇒ 反复抖。DOM 是两个世界共享的，
    // data-xprobe / ysy-xprobe-blk 页面自己的脚本读得到 ⇒ 那也是被识别面。
    // v0.8.9 裁定「默认关 + 设置里留临时开关」；v0.8.16 用户点头改默认开（他一直开着用）。
    // 这条改动只动**默认值**：那颗钮从头到尾是「浮在行上、不参与布局」，关着仍然连样式一起还回去。
    delete store['ysy.xprobe.badge'];
    delete store['ysy.xprobe.blocked'];
    const p18 = h('div', {}, [
      tweetCell('demo_own', '9301', '2026-10-26T03:00:00.000Z', '甲帖'),
      tweetCell('zz_other', '9302', '2026-10-26T03:10:00.000Z', '乙帖'),
    ]);
    // 两种记号在同一颗节点上（清场那条选择器写的就是「class 或 data-xprobe」），所以合一条查询数一次
    const blk18 = () => p18.querySelectorAll('[data-xprobe="blk"], .ysy-xprobe-blk').length;
    const scr18 = () => p18.descendants().reduce((a, n) => a + (n.__scrolls || 0), 0);

    const s18 = run(p18, '/demo_own', 'https://x.com/demo_own');
    s18.__xprobe.renderBlocks(true);
    eq('v0.8.16 默认开：不拨任何开关，boot + force 一轮就缝上两篇帖子（用户点名「改成默认显示」）', blk18(), 2);
    ok('state 如实回这颗闸（面板照它画开关，别拿面板自己的变量当第二份真相）',
      s18.__xprobe.stateForPanel().badge.on === true, s18.__xprobe.stateForPanel().badge);
    const off18a = s18.__xprobe.runCmd({ t: 'setBadge', v: false });
    eq('用户拨回「关」⇒ 那一刻当场摘干净（默认开不等于回不到零注入）', blk18(), 0);
    const sk18 = s18.__xprobe.perfLine().badgeSkips, ok18 = s18.__xprobe.perfLine().badgeOk;
    s18.__xprobe.renderBlocks(true);   // 连 force（用户刚点完拉黑）这一路也不许往页面缝
    eq('关着的时候连 force 都不缝（v0.8.9 那条硬闸一字没动，改的只是默认值）', blk18(), 0);
    ok('正向对照：关着那几轮是「闸排在限流之前就返回」，不是扫描坏了 —— 跳过账 +1、每趟那份徽标账冻结不动',
      !!off18a && off18a.result.badge === false && off18a.state.badge.on === false
      && s18.__xprobe.perfLine().badgeSkips === sk18 + 1 && s18.__xprobe.perfLine().badgeOk === ok18,
      s18.__xprobe.perfLine());

    // 再拨回开：老那套缝法还在（跨标签页同频 = 存 GM、每次判都现读）
    store['ysy.xprobe.badge'] = true;
    const s18b = run(p18, '/demo_own', 'https://x.com/demo_own');
    s18b.__xprobe.renderBlocks(true);
    eq('拨回「开」⇒ 两篇帖子又各缝一颗（这颗钮只是默认值变了，不是新写了一套）', blk18(), 2);
    ok('拨开后 state 也跟着翻（跨标签页同频：开关存 GM，每次判都现读）',
      s18b.__xprobe.stateForPanel().badge.on === true, '');
    const offR = s18b.__xprobe.runCmd({ t: 'setBadge', v: false });
    ok('面板那枚钮走的是 runCmd("setBadge")：回包带 badge=false，同一次回包里的 state 就说关',
      !!offR && offR.ok === true && offR.result.badge === false && offR.state.badge.on === false, offR && offR.result);
    eq('关的那一刻当场摘干净（不等 15 秒心跳：拨完开关页面就该干净）', blk18(), 0);
    eq('清场只认自家两种记号，X 的节点一个没少（两篇帖子 + 两个名字锚还在）',
      [p18.querySelectorAll('article').length, p18.querySelectorAll('[data-testid="User-Name"]').length], [2, 2]);

    // v0.11.3（用户点名「去掉拉黑和标杆列」）：名单行尾那两颗写账钮拿掉了 ⇒ 这一段的前提整体换掉。
    // 现在钉三件事：① 闸关着时名单**一个账都不写**（行里连按钮都没有，别的地方也没开后门）；
    // ② 写账那条腿本身没搬走——它现在只在页面那颗红徽标上（RL-4 的入口退回页面，账本与记录一个字节没改）；
    // ③ 页脚必须点名两颗入口在哪（RL-11：不许把人指向一颗已经不存在的钮）。
    const s18d = run(p18, '/demo_own', 'https://x.com/demo_own');
    s18d.__xprobe.flistBtn().fire('click');
    const f18 = IDS['ysy-xprobe-ext-flist'];
    const bstore = () => { const v = store['ysy.xprobe.blocked'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };
    const scr0 = scr18();
    const row18 = f18 && f18.children.find((c) => c.children && /^@demo_own/.test(String(c.title || '')));
    ok('名单行里零按钮 ⇒ 这里按不出拉黑（v0.11.3 去列；闸关着时页面零注入，名单也不替我们开后门）',
      !!row18 && row18.querySelectorAll('button').length === 0, f18 && f18.textContent.slice(0, 160));
    row18.fire('click', { type: 'click', target: f18.querySelectorAll('button').find((b) => b.textContent === '刷') });
    eq('守卫认目标：真浏览器里点到自家钮会一路冒泡到整行 ⇒ 整行不许滚（桩不冒泡，手动拿钮当 target 打这一行）', scr18(), scr0);
    row18.fire('click', { type: 'click', target: row18 });
    eq('正向对照：真点在这一行上（target 就是行）⇒ 照旧滚到 TA 的帖子，老功能没被守卫一起关掉', scr18(), scr0 + 1);
    eq('关着闸在名单里点一圈：blocked 账仍空、页面零注入、一条 kind=block 都没发',
      [Object.keys(bstore()).length, blk18(), postedRecords(s18d).filter((r) => r.kind === 'block').length], [0, 0, 0]);
    ok('页脚点名两颗入口在哪（不说清就等于让人对着一颗已经不存在的钮找）',
      /「拉黑」「标杆」这两列去掉了/.test(f18.textContent) && /☆标此人/.test(f18.textContent)
      && /名字行那颗红徽标/.test(f18.textContent), f18 && f18.textContent.slice(-260));
    // ② 拨开闸，从页面那颗拉黑走一趟：入口换了，账本与记录还是同一套
    store['ysy.xprobe.badge'] = true;
    s18d.__xprobe.renderBlocks(true);
    const bb18 = p18.querySelectorAll('[data-xprobe="blk"]')[0].children[0];
    eq('开闸后页面那颗是灰「拉黑」（名单里按不出的这一下，页面上按得出）', bb18.textContent, '拉黑');
    bb18.fire('click');
    eq('点页面「拉黑」：记进 GM 名单（demo_own，小写归一）+ 当场改口「已拉黑」',
      [Object.keys(bstore()), bb18.textContent], [['demo_own'], '已拉黑']);
    s18d.__xprobe.flush();   // 记录攒一发再走（队列），读账前先把这一发落下去
    ok('同一点也发了 kind=block 记录（落库 blocks 表那条路没搬走）',
      postedRecords(s18d).some((r) => r.kind === 'block' && r.data && r.data.handle === 'demo_own' && r.data.on === 1),
      postedRecords(s18d).filter((r) => r.kind === 'block').map((r) => r.data));
    eq('拉黑这一下绝不滚页面（滚帖只剩「点行」这一条路）', scr18(), scr0 + 1);
    store['ysy.xprobe.badge'] = false;
    s18d.__xprobe.renderBlocks(true);   // 关闸这一刻清场，不等 15 秒心跳
    eq('按完拉黑这一路关闸：页面依旧零注入', blk18(), 0);
    delete store['ysy.xprobe.blocked'];
    store['ysy.xprobe.badge'] = false;   // 显式拨回关（默认已是开），下面那段自己再拨开

    // ---- v0.8.10：这颗钮搬去「时间右侧那块空白」，且不许再改那一行的宽高 ----
    // 起因是用户圈了详情页时间右边那片空白：「放这里就不会影响页面正常使用」。落点不是重点，
    // 重点是它此前是名字行里的一个 flex 块（margin-left + 15px 高的钮 ⇒ 行宽高被改 ⇒ 光标底下的东西挪位）；
    // 现在它是绝对定位，参与不了布局。下面三条钉：不占位、落在时间右边、行没被我们改样式。
    store['ysy.xprobe.badge'] = true;
    const p18e = h('div', {}, [tweetCell('demo_own', '9311', '2026-10-26T03:00:00.000Z', '甲帖')]);
    const s18e = run(p18e, '/demo_own', 'https://x.com/demo_own');
    const row18e = p18e.querySelector('[data-testid="User-Name"]');
    const time18e = p18e.querySelectorAll('time')[0];
    s18e.__xprobe.renderBlocks(true);
    const bd18e = p18e.querySelector('[data-xprobe="blk"]');
    ok('浮着不占位：display:block + position:absolute ⇒ 它在这个 flex 行里不参与布局，行高一个字没改',
      !!bd18e && bd18e.style.position === 'absolute' && bd18e.style.display === 'block'
      && !/margin-left/.test(bd18e.style.cssText || '') && !bd18e.style.height && !bd18e.style.lineHeight,
      bd18e && [bd18e.style.position, bd18e.style.display, bd18e.style.cssText]);
    eq('落在时间右侧那块空白：左边缘 = 时间右缘 − 宿主左缘 + 间距（不是挤在名字与 @handle 中间）',
      Number(bd18e.style.left.replace('px', '')),
      time18e.__geo.left + time18e.__geo.width - row18e.__geo.left + 4);
    eq('宿主记账：这一行没有自带 position ⇒ 补一个并记在案（真机 X 那行**没有**自带 position——v0.8.10 把 class r-1pi2tsx 当成了 relative，查样式表它是 height:100%），关闸必须还回去',
      [s18e.__xprobe.__badgeHosts().length, row18e.style.position], [1, 'relative']);
    // v0.8.11 的真机账：23 行全判「放不下」⇒ 空白不在名字行里（名字行抱紧自己的文字），
    // 住在它上面那一层。所以名字行挤窄时不许就此放弃，得往上爬一层再看。
    const art18e = p18e.querySelector('article');
    const sq18 = (w) => {
      p18e.__geo = { left: 0, top: 0, width: w, height: 18 };
      art18e.__geo = { left: 0, top: 0, width: w, height: 18 };
      row18e.__geo = { left: 0, top: 0, width: w, height: 18 };
      time18e.__geo = { left: 60, top: 0, width: 24, height: 18 };
    };
    const nf0 = s18e.__xprobe.perfLine().badgeNoFit, dt0 = s18e.__xprobe.perfLine().badgeDots;
    row18e.__geo = { left: 0, top: 0, width: 120, height: 18 };
    time18e.__geo = { left: 60, top: 0, width: 24, height: 18 };
    s18e.__xprobe.renderBlocks(true);
    const bd18c = p18e.querySelector('[data-xprobe="blk"]');
    ok('名字行挤窄 ⇒ 往上爬一层找空白（宿主变成 article 那一层，还是整颗、不缩水）',
      !!bd18c && bd18c.parentNode === art18e && bd18c.children.length === 1
      && bd18c.style.position === 'absolute',
      bd18c && [bd18c.parentNode.getAttribute('data-testid'), bd18c.children.length]);
    // 空白不够：先退小红点（只表状态、不当钮），再退到「连点都会盖住时间」就不出，并且记账不静默
    sq18(120);
    s18e.__xprobe.renderBlocks(true);
    const bd18f = p18e.querySelector('[data-xprobe="blk"]');
    ok('整条链都放不下整颗 ⇒ 退成小红点：没有钮、记一笔 badgeDots（盖住时间之前宁可只给状态）',
      !!bd18f && bd18f.children.length === 0 && bd18f.style.width === '10px'
      && s18e.__xprobe.perfLine().badgeDots === dt0 + 1, bd18f && [bd18f.style.width, bd18f.children.length]);
    sq18(95);
    s18e.__xprobe.renderBlocks(true);
    eq('连点都会盖住时间 ⇒ 这颗不出，并记 badgeNoFit（RL-11：抓不到不许静默）',
      [p18e.querySelectorAll('[data-xprobe="blk"]').length, s18e.__xprobe.perfLine().badgeNoFit], [0, nf0 + 1]);
    // ---- v0.8.12：页面增量刷新不许把已经挂好的徽标拖来拖去 ----
    // 真机账（同一行、同一个宿主 r-k4xj1c r-18u37iz r-1wtj0ep，隔一分钟）：dump/2026-10-26_224321 里
    // left=264，dump/2026-10-26_224426 里 left=115 —— 名字行右边那些盒子（第三方「互关」胶囊、Grok/更多、
    // 后到的关注钮）陆续挂上又撤下，每趟从零重算落点就跟着搬，搬来搬去就是用户说的「来回跑」。
    // ⚠ 桩不会自己排版：徽标是 render 之后才挂上去的，没人给它灌 __geo ⇒ geoRect(徽标) 永远 null，
    // 「粘住」这条路在桩里根本走不到（全绿也测不到）。测试按「浏览器会画在哪」替它补一笔：
    // left 抄 style、宽按形态（整颗 46 / 小红点 10）、宿主坐标系抄宿主的 __geo。
    const paint18 = (n, wOpt) => {
      const hp = n.parentNode.__geo || { left: 0, top: 0, width: 0, height: 18 };
      const w = wOpt || (n.style.width === '10px' ? 10 : 46);
      // v0.8.16：贴关注钮那颗写的是 right（从宿主右缘往回量），桩要按浏览器会画在哪一样把它摆回去，
      // 否则 geoRect(徽标) 摆错位置，「粘住」那条路测出来是假红/假绿。
      const l = n.style.right
        ? hp.left + (hp.width || 0) - Number(String(n.style.right).replace('px', '')) - w
        : hp.left + Number(String(n.style.left || '0').replace('px', ''));
      n.__geo = { left: l, top: hp.top, width: w, height: hp.height || 18 };
    };
    sq18(600);
    time18e.__geo = { left: 100, top: 0, width: 24, height: 18 };   // 胶囊挤在时间前面：那一行文字整体右移
    s18e.__xprobe.renderBlocks(true);
    const bd18s = p18e.querySelector('[data-xprobe="blk"]');
    paint18(bd18s);
    eq('胶囊后到那一趟：新落点 = 新参照物右缘 + 4（先把起点钉在 128，下面才有得比）',
      [bd18s.style.left, s18e.__xprobe.perfLine().badgeMoved], ['128px', 0]);
    eq('纵向也跟参照物走（top = 时间那一行的中线 − 宿主顶边），宿主换层不再把它上下弹',
      bd18s.style.top, (time18e.__geo.top + time18e.__geo.height / 2 - bd18s.parentNode.__geo.top) + 'px');
    time18e.__geo = { left: 60, top: 0, width: 24, height: 18 };    // 胶囊又走了：文字缩回左边
    s18e.__xprobe.renderBlocks(true);
    eq('参照物缩回去 ⇒ 老位置仍然空着就一个字都不写（不跟着跑 = 用户要的那条「别来回跑」）',
      [bd18s.style.left, s18e.__xprobe.perfLine().badgeMoved], ['128px', 0]);
    eq('正向对照：同一趟「从零重算」会落到 88px —— 证明上面那条粘住真挡下了一次搬动，不是断言写空',
      s18e.__xprobe.__badgeFit(bd18s.parentNode, time18e).left, 88);
    const wall18 = h('div', {}, [T('Grok')]);
    wall18.__geo = { left: 140, top: 0, width: 60, height: 18 };
    bd18s.parentNode.appendChild(wall18);
    s18e.__xprobe.renderBlocks(true);
    eq('老位置真被新出现的盒子占了 ⇒ 搬一次（badgeMoved 记 1），搬到那条缝的左缘而不是贴右墙',
      [bd18s.style.left, s18e.__xprobe.perfLine().badgeMoved], ['88px', 1]);
    paint18(bd18s);
    s18e.__xprobe.renderBlocks(true);
    eq('搬完就定住：下一趟不再动它（否则就是每趟重摆的自激抖动）',
      [bd18s.style.left, s18e.__xprobe.perfLine().badgeMoved], ['88px', 0]);
    bd18s.parentNode.style.position = '';   // React 重渲染那一层，把我们补的 position 抹了
    s18e.__xprobe.renderBlocks(true);
    eq('宿主被 React 抹掉 position ⇒ 粘住之前先补回来（不补，坐标系一换徽标就瞬间飞到别的祖先盒子上）',
      [bd18s.parentNode.style.position, bd18s.style.left], ['relative', '88px']);
    wall18.remove();
    // ---- v0.8.13：徽标右边那枚比例标签（底色=档位、字=百分比；数只从本机台账来） ----
    // 这两个数**不在评论区那一行里**（真机那一行只有「名字 @handle · 时间」）⇒ 唯一来源是悬停名片/主页头部
    // 落进 users 台账的那两个数。标签要占 ~40px，必须先进落点预算：先按 46 摆好、再往里塞标签
    // = 一超宽就压住右边那块字 = 下一趟判「站不住」= 又搬（就是用户报的「来回跑」）。
    // v0.8.14 用户报「感觉好像算反了，换个位置」⇒ 比例改成 正在关注 ÷ 关注者，档位方向照旧（越高越绿）。
    s18e.__xprobe.getUsers().demo_own = { handle: 'demo_own', following: 418, followers: 771 };
    const rt18 = s18e.__xprobe.__ratioInfo('demo_own');
    eq('档位与字面：正在关注 418 ÷ 关注者 771 = 54% ⇒ 红（<85%）；字面按向下取整，pct 留一位小数',
      [rt18.shown, rt18.tier, rt18.pct], ['54%', 'r', 54.2]);
    eq('正向对照（换位置这条的硬针脚）：同一对数字换过来 ⇒ 771÷418 = 184% 绿，标签的字与档位一起翻',
      (() => { const g = s18e.__xprobe.getUsers(); g.demo_own = { handle: 'demo_own', following: 771, followers: 418 };
        const r = s18e.__xprobe.__ratioInfo('demo_own'); g.demo_own = { handle: 'demo_own', following: 418, followers: 771 };
        return [r.shown, r.tier]; })(), ['184%', 'g']);
    ok('比例是「正在关注÷关注者」不是反过来：真机 Elie 那种 540 关注 / 11000 粉丝 ⇒ 4.9% 红（旧算法在这里会写 2037%）',
      (() => { const g = s18e.__xprobe.getUsers(); g.demo_elie = { handle: 'demo_elie', following: 540, followers: 11000 };
        const r = s18e.__xprobe.__ratioInfo('demo_elie'); delete g.demo_elie;
        return r.shown === '4.9%' && r.tier === 'r'; })(), '');
    {
      const GU = s18e.__xprobe.getUsers();
      GU.b95 = { following: 190, followers: 200 };     // 95% ⇒ 绿
      GU.b949 = { following: 949, followers: 1000 };   // 94.9% ⇒ 黄
      GU.b85 = { following: 170, followers: 200 };     // 85% ⇒ 黄
      GU.b849 = { following: 849, followers: 1000 };   // 84.9% ⇒ 红
      GU.b0 = { following: 12, followers: 0 };         // 分母（关注者）没了 ⇒ 不算
      GU.bz_fow0 = { following: 0, followers: 50 };   // 分子是 0：TA 谁都没关注 ⇒ 0% 红，不是「缺数」
      eq('档位边界：≥95 绿、85~95 黄、<85 红；且不会出现「写着 95% 却是黄的」（94.9% 写 94%）',
        ['b95', 'b949', 'b85', 'b849'].map((k) => { const r = s18e.__xprobe.__ratioInfo(k); return r.shown + r.tier; }),
        ['95%g', '94%y', '85%y', '84%r']);
      eq('正向对照：分母（关注者）为 0 ⇒ 不算比例、不出标签（不写 ∞，也不写 0%）',
        s18e.__xprobe.__ratioInfo('b0'), null);
      eq('正向对照：分子（正在关注）为 0 照样算 ⇒ 0% 红（换位置后 0 落在分子，别把它误判成没数）',
        (() => { const r = s18e.__xprobe.__ratioInfo('bz_fow0'); return [r.shown, r.tier]; })(), ['0%', 'r']);
    }
    const need18 = 46 + 4 + s18e.__xprobe.__ratioBudget(rt18);
    ok('标签的宽度进落点预算（need 比整颗的 46 大，不是挂好再塞）', need18 > 46, need18);
    sq18(600);
    s18e.__xprobe.renderBlocks(true);
    const bd18y = p18e.querySelector('[data-xprobe="blk"]');
    ok('有数 ⇒ 钮右边多一枚标签：children = [钮, 标签]，标签的字是百分比、底色是那档的红',
      bd18y.children.length === 2 && bd18y.children[0].textContent === '拉黑'
      && bd18y.children[1].textContent === '54%' && bd18y.children[1].style.background === '#a5342c',
      [bd18y.children.length, bd18y.children[1] && bd18y.children[1].textContent, bd18y.children[1] && bd18y.children[1].style.background]);
    eq('加标签这一趟不许搬它（老位置 88 仍然完整躺在缝里 ⇒ 只重画、不挪）',
      [bd18y === bd18s, bd18y.style.left, s18e.__xprobe.perfLine().badgeMoved], [true, '88px', 0]);
    eq('标签记账（RL-11：不许静默）：出 1、缺数 0',
      [s18e.__xprobe.perfLine().badgeRatio, s18e.__xprobe.perfLine().badgeRatioNo], [1, 0]);
    paint18(bd18y, need18);
    bd18y.remove();
    sq18(150);   // 宿主只有 150px：时间右边那条缝剩 62px ⇒ 装得下钮、装不下「钮+标签」
    s18e.__xprobe.renderBlocks(true);
    const bd18n = p18e.querySelector('[data-xprobe="blk"]');
    ok('缝只够那颗钮 ⇒ 先保钮、标签这一趟不出（宁可少一处信息，也不许压住页面自己的东西）并记 badgeRatioNo',
      !!bd18n && [bd18n.children.length, s18e.__xprobe.perfLine().badgeRatio,
        s18e.__xprobe.perfLine().badgeRatioNo, s18e.__xprobe.perfLine().badgeDots].join() === '1,0,1,0',
      bd18n && [bd18n.children.length, s18e.__xprobe.perfLine().badgeRatio,
        s18e.__xprobe.perfLine().badgeRatioNo, s18e.__xprobe.perfLine().badgeDots]);
    eq('正向对照：同一趟只把预算退回 46 就一定出得来（证明上一条是「标签挤不下」，不是宿主挑错层）',
      s18e.__xprobe.__badgeFit(bd18n.parentNode, time18e, 46).form, 'full');
    paint18(bd18n, 46);
    sq18(600);
    s18e.__xprobe.renderBlocks(true);
    eq('空白又宽了 ⇒ 同一颗节点右边长出标签（不是新建一颗，位置也不动）',
      [p18e.querySelector('[data-xprobe="blk"]') === bd18n, bd18n.children.length, bd18n.style.left], [true, 2, '88px']);
    bd18n.remove();
    delete s18e.__xprobe.getUsers().demo_own;
    ['b95', 'b949', 'b85', 'b849', 'b0', 'bz_fow0'].forEach((k) => { delete s18e.__xprobe.getUsers()[k]; });
    s18e.__xprobe.renderBlocks(true);
    const bd18z = p18e.querySelector('[data-xprobe="blk"]');
    ok('台账里没这两个数 ⇒ 只出钮、不出标签（一个数都不编），账记在「缺数」而不是「放不下」',
      !!bd18z && [bd18z.children.length, s18e.__xprobe.perfLine().badgeRatio,
        s18e.__xprobe.perfLine().badgeRatioNo].join() === '1,0,1',
      bd18z && [bd18z.children.length, s18e.__xprobe.perfLine().badgeRatio, s18e.__xprobe.perfLine().badgeRatioNo]);
    // 跨标签页兜底：别的标签页刚写进 GM 的那两个数，本页内存台账里没有
    store['ysy.xprobe.users'] = { tab_other: { following: 96, followers: 100 } };
    eq('跨标签页兜底：内存台账没这个人、GM 缓存里有 ⇒ 标签照样出（正在关注 96 ÷ 关注者 100 = 96% 绿档）',
      [s18e.__xprobe.__ratioInfo('tab_other').shown, s18e.__xprobe.__ratioInfo('tab_other').tier], ['96%', 'g']);
    delete store['ysy.xprobe.users'];
    // ---- v0.8.14：数放久了转「旧数」（虚线灰边 + 压暗），只改样式、不改落点 ----
    // 用户拍板的是零风险那条路：不模拟悬停、不发请求 ⇒ 探针不能替他把数取回来，
    // 只能告诉他「这颗是 31 天前读到的，别再当现值看」。宽度一个字都没变 ⇒ 不许搬（v0.8.12 那条契约）。
    sq18(600);
    s18e.__xprobe.getUsers().demo_own = { handle: 'demo_own', following: 418, followers: 771, statsAt: Date.now() };
    s18e.__xprobe.renderBlocks(true);
    const bd18o = p18e.querySelector('[data-xprobe="blk"]');
    paint18(bd18o, 46 + 4 + s18e.__xprobe.__ratioBudget(s18e.__xprobe.__ratioInfo('demo_own')));
    ok('刚读到的数 ⇒ 实线不透明（stale=false），「旧」这一列记 0',
      bd18o.children[1].style.border === '1px solid transparent' && bd18o.children[1].style.opacity === '1'
      && s18e.__xprobe.perfLine().badgeRatioOld === 0,
      [bd18o.children[1].style.border, bd18o.children[1].style.opacity, s18e.__xprobe.perfLine().badgeRatioOld]);
    s18e.__xprobe.getUsers().demo_own.statsAt = Date.now() - 29 * 86400000;
    s18e.__xprobe.renderBlocks(true);
    eq('阈值边界：29 天还不算旧（只有满 RATIO_STALE_DAYS 天才转虚线，别把昨天的数判成旧数）',
      [s18e.__xprobe.__ratioInfo('demo_own').stale, bd18o.children[1].style.border,
        s18e.__xprobe.perfLine().badgeRatioOld], [false, '1px solid transparent', 0]);
    s18e.__xprobe.getUsers().demo_own.statsAt = Date.now() - 31 * 86400000;
    s18e.__xprobe.renderBlocks(true);
    ok('满 30 天 ⇒ 同一颗节点原地转虚线灰边 + 压暗；字还是 54%、底色还是那档的红（颜色=档位这条不动）',
      bd18o.children[1].textContent === '54%' && bd18o.children[1].style.background === '#a5342c'
      && bd18o.children[1].style.border === '1px dashed #8b98a5' && bd18o.children[1].style.opacity === '0.72',
      [bd18o.children[1].textContent, bd18o.children[1].style.border, bd18o.children[1].style.opacity]);
    eq('变旧只重画、不搬（badgeSig 把「旧不旧」记在第 5 格，粘性照旧按字面比 ⇒ 不会虚线一跳就飞一次）',
      [p18e.querySelector('[data-xprobe="blk"]') === bd18o, bd18o.style.left,
        s18e.__xprobe.perfLine().badgeMoved, s18e.__xprobe.perfLine().badgeRatio,
        s18e.__xprobe.perfLine().badgeRatioOld], [true, '88px', 0, 1, 1]);
    {
      const rtO = s18e.__xprobe.__ratioInfo('demo_own');
      ok('标签上的字要说清旧到什么程度、且只让用户自己动手（不假装能自动补）',
        rtO.stale === true && rtO.ageDays === 31 && /31 天前读到的/.test(rtO.tip)
        && /再悬停一次头像/.test(rtO.tip), [rtO.ageDays, rtO.tip]);
    }
    s18e.__xprobe.getUsers().demo_own.statsAt = Date.now();
    s18e.__xprobe.renderBlocks(true);
    eq('再悬停一次读到 ⇒ 虚线摘回实线、「旧」清零，位置照旧不动（用户要的「后期按时间增量更新」在这一刻落地）',
      [bd18o.children[1].style.border, bd18o.style.left, s18e.__xprobe.perfLine().badgeRatioOld],
      ['1px solid transparent', '88px', 0]);
    bd18o.remove();
    delete s18e.__xprobe.getUsers().demo_own;
    // 最关键的一条：数半路才到（用户刚悬停过 TA 的名片）= 这颗要变宽 = 老落点不是按这个宽度量的
    // ⇒ 不许粘着原地硬塞（那正压住右边那块字，就是 v0.8.12 立「不许动」之前那个病），得重挑一次。
    sq18(150);                       // 缝只剩 62px：装得下那颗钮、装不下「钮+标签」
    s18e.__xprobe.renderBlocks(true);
    const bd18w = p18e.querySelector('[data-xprobe="blk"]');   // 这一趟还没数 ⇒ 只出钮，落在 88
    paint18(bd18w, 46);
    s18e.__xprobe.getUsers().demo_own = { handle: 'demo_own', following: 418, followers: 771 };
    s18e.__xprobe.renderBlocks(true);
    eq('数来得正是那条缝装不下「钮+标签」⇒ 这一趟标签不出（不硬塞、不压右边的字），位置也不动，账记「缺数」',
      [bd18w.style.left, bd18w.children.length, s18e.__xprobe.perfLine().badgeRatio,
        s18e.__xprobe.perfLine().badgeRatioNo, s18e.__xprobe.perfLine().badgeMoved], ['88px', 1, 0, 1, 0]);
    delete s18e.__xprobe.getUsers().demo_own;
    store['ysy.xprobe.badge'] = false;
    // 名单行尾那枚标签不吃这颗总闸：那张面板是探针自己的（fixed 挂 documentElement），不参与 X 的布局
    // ⇒ 默认关着也看得见，而这才是日常入口（用户报的「开了才显示」多半因为它默认关）。
    const s18r = run(p18e, '/demo_own', 'https://x.com/demo_own');
    s18r.__xprobe.getUsers().demo_own = { handle: 'demo_own', following: 418, followers: 771 };
    s18r.__xprobe.flistBtn().fire('click');
    const fr18 = IDS['ysy-xprobe-ext-flist'];
    const chip18 = fr18 && fr18.querySelectorAll('span').find((x) => x.style && x.style.background === '#a5342c');
    ok('名单行尾那枚比例标签：闸关着也出（54% 红底），且它长在自家面板那一行里、不在 X 的名字行里',
      !!chip18 && chip18.textContent === '54%' && s18r.__xprobe.stateForPanel().badge.on === false
      && chip18.parentNode.parentNode === fr18 && !/ysy-xprobe-blk/.test(chip18.parentNode.parentNode.className || ''),
      chip18 && [chip18.textContent, chip18.style.background, chip18.parentNode.parentNode === fr18]);
    // ---- v0.8.14：用户要「列表展示完就直接算所有人的百分比入库」，真机拿不到（14 份转储实锤）----
    // ⇒ 零风险那条路的形态：名单一眼告诉你**还差谁**（灰「—」+「待补」筛子），而不是编一个数出来。
    // ⚠ 名单每次重画都是拆了重建（renderFlist），所以下面每一枪都现取 IDS 里那一颗，别攥着旧节点读。
    const fl = () => IDS['ysy-xprobe-ext-flist'];
    const fbtn = (re) => fl().querySelectorAll('button').find((x) => re.test(x.textContent));
    // v0.11.3：行尾两颗没了 ⇒ 「有几行」不能再数拉黑钮。名单里只有行带 title（@handle 打头），头部/说明/页脚都没有。
    const frows = () => fl().children.filter((x) => x.children && /^@/.test(String(x.title || ''))).length;
    ok('名单头部有「待补(0)」筛子与「比例可算 1/1」这行字（一个人都不缺时数字就说一个人都不缺）',
      !!fbtn(/^待补\(0\)$/) && /比例可算 1\/1 · 待补 0/.test(fl().textContent), fl().textContent.slice(0, 240));
    fbtn(/^待补\(0\)$/).fire('click');
    ok('筛子拨开：这一页没有待补的人 ⇒ 行清空、给一句「切回全部」的话，钮自己变绿表示筛着（RL-16：不静默）',
      /这一档没有待补的/.test(fl().textContent) && fbtn(/^待补\(0\)$/).style.color === '#4ec98a',
      [fl().textContent.slice(0, 200), fbtn(/^待补\(0\)$/) && fbtn(/^待补\(0\)$/).style.color]);
    fbtn(/^待补\(0\)$/).fire('click');
    eq('正向对照：再点一下筛子拨回去 ⇒ 行又回来（只改名单显示，没把人从这页抹掉）', frows(), 1);
    delete s18r.__xprobe.getUsers().demo_own;
    fbtn(/^刷$/).fire('click');
    const dash18 = fl().querySelectorAll('span').find((x) => x.textContent === '—' && x.style && x.style.color === '#5a6774');
    ok('台账没这两个数 ⇒ 行尾给一枚灰「—」（不编数、也不空着让人以为坏了），悬停写着去悬停头像一次',
      !!dash18 && /把鼠标放到 TA 的头像上/.test(dash18.title) && /待补 1/.test(fl().textContent)
      && !fl().querySelectorAll('span').some((x) => x.style && x.style.background === '#a5342c'),
      dash18 && [dash18.textContent, /待补 1/.test(fl().textContent)]);
    s18r.__xprobe.getUsers().demo_own = { handle: 'demo_own', following: 418, followers: 771, statsAt: Date.now() - 40 * 86400000 };
    fbtn(/^刷$/).fire('click');
    ok('数超过 30 天 ⇒ 名单把这行也算进「待补」，并在头部注明其中几个是旧数（虚线那颗仍是档位标签本体，不换成灰杠）',
      /待补 1（其中旧数 1）/.test(fl().textContent) && /待补\(1\)/.test(fbtn(/^待补/).textContent)
      && fl().querySelectorAll('span').some((x) => x.style && x.style.border === '1px dashed #8b98a5' && x.textContent === '54%'),
      fl().textContent.slice(0, 240));
    fbtn(/^待补/).fire('click');
    eq('筛子打开时旧数那一行也留着（「待补」= 还没读到 + 读到了但过期，两类都要补）', frows(), 1);
    fbtn(/^待补/).fire('click');
    ok('名单脚注写的是新方向（比例=正在关注÷关注者）+ 灰杠与虚线的含义，门槛 30 天也在这行字里',
      /比例=正在关注÷关注者/.test(fl().textContent) && /「—」=本机还没这两个数/.test(fl().textContent)
      && /虚线=数已超过 30 天/.test(fl().textContent), fl().textContent.slice(-260));
    delete s18r.__xprobe.getUsers().demo_own;
    // ---- v0.8.16：真机粉丝/关注列表那一行（用户点名「列表也要有拉黑按钮和标记，放在正在关注/回关左边」）----
    // 头像+名字+@handle+简介整块住在 X 自己那颗 role=button 里（点它进主页），右边才是「正在关注/回关」。
    // 老规矩「祖先链里有按钮 ⇒ 就地放弃」把这种行一颗都判不出（真机账全记在 badgeCta 那一格）；
    // 新规矩是「这一层不能挂就往上爬出那颗按钮」，挂到行容器 UserCell，落贴那颗钮的左缘、坐标写 CSS right。
    store['ysy.xprobe.badge'] = true;
    // 真机那一行从 @handle 到 UserCell 中间还有三四层包裹（cellInnerDiv 之类），桩要照这个深度来：
    // 「再往上 ≤3 层」这把尺子如果还从**第一个候选**起量，列表页根本爬不到行容器（M8 变异测试就红在这里）。
    const frow = (handle, tid) => h('div', { 'data-testid': 'UserCell' }, [
      h('div', { role: 'button', tabindex: '0' }, [
        h('div', {}, [
          h('div', {}, [
            h('div', { 'data-testid': 'User-Name' }, [
              h('a', { href: '/' + handle }, [T('列表丙 @' + handle)]),
              h('span', {}, [T('关注了你')]),
            ]),
            h('div', {}, [T('TA 的简介文字，住在下一行')]),
          ]),
        ]),
      ]),
      h('button', { 'data-testid': tid, 'aria-label': '正在关注 @' + handle }, [T('正在关注')]),
    ]);
    const f1cell = frow('lc_h', '777-unfollow');
    const p18h = h('div', { 'data-testid': 'primaryColumn' }, [f1cell]);
    const s18h = run(p18h, '/benben2052243/followers', 'https://x.com/benben2052243/followers');
    // ⚠ 几何必须在 run() **之后**灌：桩的自动排版在 boot 时才跑一遍，先写会被冲掉
    //（第六条老坑的另一个变体：写顺序决定断言量到的是谁的坐标）。这里建模真机那两片空白：行 96 高
    //（老闸 64 会直接判「这不是行」）、大按钮 flex-grow 撑到钮前面、简介在下一条线上不压这条带。
    const f1 = { cell: f1cell, blk: f1cell.children[0], btn: f1cell.children[1] };
    const f1nm = f1.blk.children[0].children[0].children[0];
    f1.a = f1nm.children[0]; f1.pill = f1nm.children[1]; f1.bio = f1nm.parentNode.children[1];
    const fgeo18 = (hgt) => {
      f1.cell.__geo = { left: 0, top: 0, width: 600, height: hgt || 96 };
      f1.blk.__geo = { left: 0, top: 0, width: 470, height: hgt || 96 };
      f1nm.__geo = { left: 60, top: 24, width: 200, height: 18 };
      f1.a.__geo = { left: 60, top: 24, width: 110, height: 18 };     // 参照物 = @handle 锚
      f1.pill.__geo = { left: 178, top: 24, width: 72, height: 18 };
      f1.bio.__geo = { left: 60, top: 48, width: 400, height: 18 };
      f1.btn.__geo = { left: 470, top: 32, width: 100, height: 32 };  // 右墙 = 那颗「正在关注」
    };
    fgeo18();
    const ct1 = s18h.__xprobe.perfLine().badgeCta;
    s18h.__xprobe.renderBlocks(true);
    const fb18 = p18h.querySelector('[data-xprobe="blk"]');
    ok('列表页那一行出徽标了，宿主是行容器 UserCell（不是那颗按钮）：爬得出去 = 用户要的那一颗',
      !!fb18 && fb18.parentNode === f1.cell && fb18.children.length === 1,
      fb18 && [fb18.parentNode.getAttribute('data-testid'), fb18.children.length]);
    ok('徽标不在 role=button 的子树里（点它绝不触发导航，也不用拦冒泡）：那颗大按钮子树里自家节点数 = 0，'
      + '而它和那颗钮都是宿主 UserCell 的孩子',
      !f1.blk.querySelector('[data-xprobe="blk"]') && fb18.parentNode === f1.cell
      && f1.cell.contains(f1.blk) && f1.cell.contains(f1.btn),
      [!!f1.blk.querySelector('[data-xprobe="blk"]'), f1.cell.contains(f1.btn)]);
    eq('贴的是那颗钮的左缘：坐标写成 CSS right = 宿主右缘 −(钮左缘 − 4px)，且 left 清空（两侧都留值会把宽度撑开）',
      [fb18.style.right, fb18.style.left], [(600 - 470 + 4) + 'px', '']);
    eq('纵向仍跟 @handle 那一行齐平（不是跟钮）：top = 参照物中线 − 宿主顶边，跟旧版同一口径',
      fb18.style.top, (24 + 9 - 0) + 'px');
    eq('这一趟不再记「在钮上」：出 1 颗、badgeCta 不涨（老规矩在这里记 1、出 0 颗）',
      [s18h.__xprobe.perfLine().badgeCta, s18h.__xprobe.perfLine().badgeOk], [ct1, 1]);
    ok('正向对照：把「爬出按钮」改回「就地放弃」（老那一行是 break）⇒ 这条针脚真的咬 continue，不是摆设',
      /if \(onBtn\) \{ cta = true; continue; \}/.test(src) && !/if \(onBtn\) \{ cta = true; break; \}/.test(src), '');
    ok('认关注钮：testid 结尾 follow/unfollow、外面包一层 div、aria-label 写「关注 @x」的 button 都认；'
      + '普通文字块与 Grok 那种钮不认（认错顶多换种贴法，压不到页面）',
      [f1.btn, h('div', {}, [h('div', {}, [h('span', { 'data-testid': 'follow' })])]),
        h('button', { 'aria-label': '关注 @lc_i' }, [T('关注')])]
        .map((n) => s18h.__xprobe.__badgeFollowBtn(n)).join(',') === 'true,true,true'
      && [s18h.__xprobe.__badgeFollowBtn(f1.pill), s18h.__xprobe.__badgeFollowBtn(h('button', { 'data-testid': 'more' }, [T('更多')]))].join(',') === 'false,false',
      '');
    eq('锚定侧的选择器：贴钮那颗写 right，其余照旧写 left（badgePlace 与「搬没搬」比的是同一对）',
      [s18h.__xprobe.__badgeAnchor({ right: 134 }).join('|'), s18h.__xprobe.__badgeAnchor({ left: 88 }).join('|')],
      ['right|134px', 'left|88px']);
    // 贴 right 那颗也必须粘得住（v0.8.12 那条「不来回跑」不能因为换了锚定侧就失效）
    paint18(fb18);
    f1.a.__geo = { left: 40, top: 24, width: 110, height: 18 };   // @handle 那行文字整体缩回左边
    fb18.style.top = '7px';      // 故意写歪一笔：这一趟只要真「粘住」（不走重摆），它就不该被改回 33px
    s18h.__xprobe.renderBlocks(true);
    eq('参照物缩回去 ⇒ 贴钮那颗一个字都不写（粘住看的是量到的矩形，跟锚定在哪侧无关）',
      [fb18.style.right, s18h.__xprobe.perfLine().badgeMoved], ['134px', 0]);
    eq('而且是**真的没重摆**（不是「重摆算出同一个值」）：纵向那一笔歪没人去动它 ⇒ 高度那把尺在「爬层」与「判老宿主」两处必须是同一把，'
      + '否则列表页 96px 的行粘不住、每趟重写一遍 style',
      fb18.style.top, '7px');
    f1.btn.__geo = { left: 400, top: 32, width: 100, height: 32 };  // 钮左移：老位置被它占了
    s18h.__xprobe.renderBlocks(true);
    eq('老位置真被那颗钮占了 ⇒ 搬一次并改贴新左缘（badgeMoved 记 1，right 跟着重算）',
      [fb18.style.right, s18h.__xprobe.perfLine().badgeMoved], [(600 - 400 + 4) + 'px', 1]);
    // 行高那把尺：列表页一行天生比「名字行」高，给的是另一把（132）；再高就不是行，别挂
    f1.cell.__geo = { left: 0, top: 0, width: 600, height: 200 };
    s18h.__xprobe.renderBlocks(true);
    eq('正向对照：行高超过列表页那把尺（200 > 132）⇒ 判「这不是行」，这颗不出、记在钮上（不挂到整屏容器上）',
      [p18h.querySelectorAll('[data-xprobe="blk"]').length, s18h.__xprobe.perfLine().badgeCta], [0, ct1 + 1]);
    f1.cell.__geo = { left: 0, top: 0, width: 600, height: 96 };
    s18h.__xprobe.runCmd({ t: 'setBadge', v: false });
    const cell18h = p18h.querySelector('[data-testid="UserCell"]');
    ok('关闸清场：列表行也没留痕迹（X 的节点一条没动，我们补的 position 还回去了）',
      cell18h.querySelectorAll('button, [role="button"]').length === 2 && !cell18h.style.position
      && !cell18h.querySelector('[data-xprobe="blk"]'), [cell18h.style.position]);
    // 极端形状仍然要否：整条行自己就是一颗按钮（外面再没有「行那么高」的非按钮容器）⇒ 绝不浮在别人的钮上
    const p18i = h('div', { 'data-testid': 'primaryColumn' }, [
      h('div', { 'data-testid': 'UserCell', role: 'button', tabindex: '0' }, [
        h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/lc_j' }, [T('列表丁 @lc_j')])]),
      ]),
    ]);
    const s18i = run(p18i, '/benben2052243/followers', 'https://x.com/benben2052243/followers');
    const cell18i = p18i.querySelector('[data-testid="UserCell"]');
    cell18i.__geo = { left: 0, top: 0, width: 600, height: 96 };
    p18i.__geo = { left: 0, top: 0, width: 600, height: 96 };   // 外面那层比「一行」高 ⇒ 不是行，别挂
    store['ysy.xprobe.badge'] = true;
    s18i.__xprobe.renderBlocks(true);
    eq('名字行外面再没有挂得住的层 ⇒ 仍然不出、账记「在钮上」（v0.8.16 放开的是「爬出去」，不是「挂进别人的钮」）',
      [p18i.querySelectorAll('[data-xprobe="blk"]').length, s18i.__xprobe.perfLine().badgeCta >= 1], [0, true]);
    store['ysy.xprobe.badge'] = false;
    // 行上没有相对定位时我们才补，且补过的必须还回去（关闸那一刻页面零痕迹）
    const p18g = h('div', {}, [
      h('div', { 'data-testid': 'User-Name' }, [
        h('a', { href: '/demo_own' }, [T('示例笔记 @demo_own')]),
        h('a', { href: '/demo_own/status/9312', 'aria-label': '1小时 前' }, [h('time', { datetime: '2026-10-26T03:00:00.000Z' }, [T('1小时')])]),
      ]),
    ]);
    const s18g = run(p18g, '/demo_own', 'https://x.com/demo_own');
    const row18g = p18g.querySelector('[data-testid="User-Name"]');
    store['ysy.xprobe.badge'] = true;
    s18g.__xprobe.renderBlocks(true);
    eq('这一行没有相对定位 ⇒ 记在案并临时补上',
      [s18g.__xprobe.__badgeHosts().length, row18g.style.position], [1, 'relative']);
    s18g.__xprobe.runCmd({ t: 'setBadge', v: false });
    eq('关闸清场：徽标摘掉、我们改过的样式也原样还回去（页面零痕迹）',
      [p18g.querySelectorAll('[data-xprobe="blk"], .ysy-xprobe-blk').length, row18g.style.position, s18g.__xprobe.__badgeHosts().length],
      [0, '', 0]);
    store['ysy.xprobe.badge'] = false;   // 这一段测完拨回关：后面的夹具不该往页面缝东西（默认值是开，见本段开头）
    delete store['ysy.xprobe.blocked'];

    // 三层接线 + 那条崩溃（Uncaught (in promise) TypeError: Cannot read properties of null (reading 'rndMax')）
    const sp18 = rd('ui/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
    const html18 = rd('ui/sidepanel.html');
    const core18 = src.replace(/^\s*\/\/.*$/gm, '');
    ok('设置页这枚开关齐活：html 里有 bBadge，钮的字面从 st.badge.on 来，点它发 setBadge',
      /id="bBadge" type="button"/.test(html18) && /bBadge: \(\) => cmd\('setBadge', !\(st && st\.badge && st\.badge\.on\)\)/.test(sp18)
      && /'页面内徽标: ' \+ \(st\.badge && st\.badge\.on \? '开' : '关'\)/.test(sp18), '');
    // 只钉「页面内拉黑徽标」那一格的说法（整份 html 里「默认关」还有别的格，别拿全文判）。
    // v0.9.8 起这格的全文住在 .secFold（常驻只有 .secHint 那一行，点开 ❓ 才看到全文）——
    // 搬家不许删：下面这些内容判据一个字没减，只是换了个位置读。
    const badgeDesc = (html18.match(/页面内拉黑徽标<\/div><div class="secHint">[\s\S]*?<\/div><div class="secFold">([\s\S]*?)<\/div>/) || [])[1] || '';
    ok('这颗闸的全文（不改页面布局 / 不留外来节点 / 关掉当场摘干净 / v0.8.16 起默认开）整段仍在 DOM 里，只不再常驻显示',
      /宽和高|移动走/.test(badgeDesc) && /默认显示/.test(badgeDesc) && !/默认关/.test(badgeDesc)
      && /贴「正在关注\/回关」的左缘/.test(badgeDesc) && badgeDesc.length > 800, badgeDesc.slice(0, 80));
    ok('core 与 SW 两层都放行 setBadge（三层对得上，[15] 那三条横比也会自动咬住）',
      /setBadge: \(v\) => setBadgeOn\(!!v\)/.test(core18) && /'setBadge'/.test(swSrc), '');
    ok('开关是「存储 ≠ 应用」那一类：GM 存 + 现读现判，关的时候顺手清场（ARCHITECTURE §3 那条规矩）',
      /GM_setValue\(BADGE_KEY, on\)/.test(core18) && /GM_getValue\(BADGE_KEY, true\) !== false/.test(core18)
      && !/GM_getValue\(BADGE_KEY, false\) === true/.test(core18)
      && /else \{ badgeSweep\(\); badgeSweepNeeded = false; \}/.test(core18), '');
    ok('总闸排在限流判断之前（关着就不参与「要不要扫」，force 也不例外）',
      /function renderBlocks\(force\) \{[\s\S]{0,120}if \(!badgeGet\(\)\)/.test(core18), '');
    // v0.8.13 比例标签的三层接线：数据从名片来、档位与预算在 core、账在面板、说法在 html
    // v0.11.4 补一格：关系标签（互关/他单向/我单向）吃同一条预算纪律。
    // v0.11.9 改口径：关系标签搬进名字行（relChipRow），不再吃徽标那条缝的预算——退让回到两级（比例→钮）。
    const pin18 = (s) => /HC_STAT_HREF_RE\.exec\(href\)/.test(s)
      && /applyHoverStats\(f\.handle, f\.hf, f\.ho, now\)/.test(s)
      && /const RATIO_GREEN = 95;/.test(s) && /const RATIO_YELLOW = 85;/.test(s)
      && /rt = null; need = needOf\(null\);/.test(s)
      && /const needOf = \(x\) => BADGE_FULL_W \+ \(x \? BADGE_GAP_PX \+ ratioBudget\(x\) : 0\);/.test(s)
      && /relChipRow\(anchor, h, rel0\)/.test(s)
      && /badgePick\(anchor, refEl, need\)/.test(s);
    ok('三层接线齐：名片按 href 收那两个数并落台账 + 档位常量 + 「挤不下就先保钮」写在代码里（比例一级退让）+ 落点预算真的传进 badgePick + 关系标签改住名字行',
      pin18(core18), core18.slice(core18.indexOf('const needOf'), core18.indexOf('const needOf') + 200));
    ok('正向对照：把 need 从 badgePick 那两枪里全抠掉（= 标签宽度不进落点预算，挂好再塞就会压住右边的字）⇒ 判据当场变红',
      !pin18(core18.replace(/badgePick\(anchor, refEl, need\)/g, 'badgePick(anchor, refEl)')), '');
    ok('正向对照：把 relChipRow 的画笔抠掉（关系标签不画进名字行）⇒ 判据当场变红（这条针脚咬住「标签在名字行」这个位置）',
      !pin18(core18.replace(/relChipRow\(anchor, h, rel0\)/g, 'null')), '');
    ok('面板那行有「标签/缺数/旧」三个数、html 讲清了「没数就一颗都不编」（RL-11：抓不到不许静默，也别说得好像一定有）',
      /标签' \+ \(p\.badgeRatio \|\| 0\) \+ '\/缺数' \+ \(p\.badgeRatioNo \|\| 0\) \+ '\/旧' \+ \(p\.badgeRatioOld \|\| 0\)/.test(rd('ui/view.js'))
      && /没数就一个都不编/.test(html18) && /__ratioInfo: ratioInfo/.test(core18), '');
    ok('v0.8.14 算的是 正在关注 ÷ 关注者（用户原话「算反了，换个位置」），文案里那行方向也是这一条',
      /const pct = fow \* 100 \/ fans;/.test(core18) && /正在关注 ÷ 关注者/.test(html18), '');
    ok('正向对照：把分子分母换回旧的那一头（关注者 ÷ 正在关注）⇒ 判据当场变红（这条针脚真的咬方向，不是摆设）',
      !/const pct = fow \* 100 \/ fans;/.test(core18.replace(/const pct = fow \* 100 \/ fans;/, 'const pct = fans * 100 / fow;')), '');
    const rgn18 = sp18.slice(sp18.indexOf('function render()'));
    const gi18 = rgn18.search(/if \(!st\) \{\s*\$\('foot'\)/);   // 只认这一块（上面还有一句 if (!st) doView，别看错门）
    ok('那条 rndMax 崩溃修的是顺序：render() 先接住 st=null 并说清「活动标签页没有探针」，再去读 st.rndMax',
      /if \(!st\) \{[\s\S]{0,200}活动标签页没有探针[\s\S]{0,120}return;\s*\}/.test(rgn18)
      && gi18 >= 0 && gi18 < rgn18.indexOf("$('rndMax')"), gi18);
    ok('正向对照：把这条守卫从 render() 里抠掉，判据当场变红（证明它咬的是这一行，不是别处）',
      !(sp18.slice(sp18.indexOf('function render()')).replace(/if \(!st\) \{[\s\S]{0,200}活动标签页没有探针[\s\S]{0,120}return;\s*\}/, '')
        .match(/if \(!st\) \{[\s\S]{0,200}活动标签页没有探针/)), '');
  }

  console.log('\n[19] v0.9.0 标杆：名单行尾那颗钮 + 右缘窗口（打开即自动排好 / 库优先缺数「—」/ 分类 / 帖子抽屉）');
  {
    // 用户原话：「我想给 拉黑右边再加一个标杆按钮，加入后，会加入一个数据库，再在右下角 添加一个按钮，叫标杆，
    // 点开后会打开一个窗口，按照粉丝，曝光，等等进行排序，也可以自动排序，还可以加分类修改分类」。
    // 四问四答定下的口径逐条钉在这里：① 自动排序=打开即自动排好（记住上次那根轴）；② 分类只要能打标签、先不做切换；
    // ③ 台账 + 本机库都读、库优先，缺的格退台账，两头都没有写「—」；④ 点某一行 = 像抽屉一样在下方展开 TA 的帖子，
    //    可按曝光/评论/时间筛。红线全程有效：不滚页面、不导航、不请求 X、缺数不编（RL-11）、SQL 只在库那边（RL-9）。
    // 结构纪律（踩过一次才知道要写下来）：这一段里每「再 run 一份新沙箱」都会抢走全局 IDS
    // （core 取节点走 document.getElementById ⇒ 桩的 IDS 是跨沙箱的），真机路径的断言必须在第一份沙箱里跑完，
    // 所有正向对照与「换一页」那几条排到最后、各自自成一段。
    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.benchSort'];
    delete store['ysy.xprobe.blocked'];
    store['ysy.xprobe.badge'] = false;   // 整段都要在「页面零注入」下跑通：标杆钮与窗口是自家面板，不受 RL-16 那道闸管
    const USERS0 = {
      alice: { handle: 'alice', name: '爱丽丝', followers: 999, following: 10, relation: '', updatedAt: 1 },
      dave: { handle: 'dave', name: '丁', followers: 777, following: 20, relation: '', updatedAt: 1 },
    };
    const POSTS0 = {
      '9611': { tweetId: '9611', handle: 'carl', text: '丙之一' },
      '9612': { tweetId: '9612', handle: 'carl', text: '丙之二' },
    };
    const seed19 = (led) => {
      store['ysy.xprobe.users'] = JSON.parse(JSON.stringify(USERS0));
      store['ysy.xprobe.posts'] = JSON.parse(JSON.stringify(POSTS0));
      store['ysy.xprobe.bench'] = led || {};
      delete store['ysy.xprobe.benchSort'];
    };
    seed19();

    // 库那边 bench_accounts 的回包（列名与 xprobe_db.QUERIES 一字不差；这里只测「怎么并、怎么排、怎么写」）
    const BM_ROWS = [
      { handle: 'alice', name: '爱丽丝·库里那笔', tags: '投资', marked_at: '2026-10-24T10:00:00.000Z',
        fans: 3000, fow: 10, posts_n: 1, views: 400, eng: 28, last_post_at: '2026-10-26T08:00:00.000Z', relation: 'following', blocked: 0 },
      { handle: 'erin', name: '艾琳', tags: '', marked_at: '2026-10-24T11:00:00.000Z',
        fans: 500, fow: null, posts_n: null, views: null, eng: null, last_post_at: null, relation: '', blocked: 0 },
      { handle: 'carl', name: '卡尔', tags: '', marked_at: '2026-10-24T09:00:00.000Z',
        fans: 0, fow: null, posts_n: null, views: null, eng: 0, last_post_at: null, relation: '', blocked: 1 },
      { handle: 'bob', name: '', tags: '', marked_at: '2026-10-24T08:00:00.000Z',
        fans: null, fow: null, posts_n: null, views: null, eng: null, last_post_at: null, relation: '', blocked: 0 },
    ];
    const DAY = 86400000;
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    // 本机钟点（与 core 里那把尺同一算法，但独立写一遍，别拿被测函数验被测函数）
    const loc = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    const utcSlice = (iso) => String(iso).slice(5, 16).replace('T', ' ');   // 旧写法：切字面 = 把 UTC 当本机钟点
    const AP_ROWS = [
      // v0.9.2：抽屉那一列是**发帖时间**（time_datetime），first_at/last_at 只是「我们什么时候扫到它」。
      // 故意让 9601 的发帖时刻（120 天前）远早于它的采集时刻（40 天前）：这样「按发帖时间排/筛」与
      // 「按采集时间排/筛」在同一份夹具下给出**不同答案**，把线接回 last_at 的变异才会红。
      // 9603 故意没有发帖时刻（真库 27616 条里 7 条这样）⇒ 任何窗都不进、排时间垫底，但不许被剔掉不出。
      { tweet_id: '9601', author: 'alice', text: '甲的旧帖', last_at: ago(40 * DAY), first_at: ago(40 * DAY),
        time_datetime: ago(120 * DAY), view: 5000, like: 30, reply: 5, eng: 35, view_per_h: null },
      { tweet_id: '9602', author: 'alice', text: '甲的新帖', last_at: ago(DAY), first_at: ago(2 * DAY),
        time_datetime: ago(2 * DAY), view: 200, like: 2, reply: 12, eng: 14, view_per_h: 8.3 },
      { tweet_id: '9603', author: 'alice', text: '甲没曝光数的那帖', last_at: ago(2 * DAY), first_at: ago(2 * DAY),
        time_datetime: '', view: null, like: 1, reply: 20, eng: 21, view_per_h: null },
    ];

    const p19 = h('div', {}, [
      tweetCell('alice', '9501', '2026-10-26T03:00:00.000Z', '甲帖'),
      tweetCell('bob', '9502', '2026-10-26T04:00:00.000Z', '乙帖'),
      tweetCell('carl', '9503', '2026-10-26T05:00:00.000Z', '丙帖'),
    ]);
    const scr19 = () => p19.descendants().reduce((a, n) => a + (n.__scrolls || 0), 0);
    const inj19 = () => p19.querySelectorAll('[data-xprobe="blk"], .ysy-xprobe-blk').length;
    const s19 = run(p19, '/home', 'https://x.com/home');
    const X = s19.__xprobe;
    const bm = () => { const v = store['ysy.xprobe.bench'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };
    const wire19 = (sb) => {
      sb.__dbSent = [];
      sb.chrome.runtime.sendMessage = (m, cb) => {
        if (m && m.t === 'dbq') {
          sb.__dbSent.push(m);
          if (cb) cb(m.q === 'author_posts' ? { ok: true, rows: m.author === 'alice' ? AP_ROWS : [] } : { ok: true, rows: BM_ROWS });
          return;
        }
        sb.__rtMsgs.push(m);
        if (cb) cb(undefined);
      };
    };

    // ---- 纯口径先钉死（这几条决定窗口里每一格写什么字）----
    eq('「—」与「0」是两个字面：没读到≠粉丝 0 人（RL-11 不许假账），一万以上折「x.x万」，认不出来的数也是「—」',
      [X.benchNum(null), X.benchNum(''), X.benchNum(0), X.benchNum(12345), X.benchNum('abc')],
      ['—', '—', '0', '1.2万', '—']);
    eq('分类归一与库里 _tags 一字不差：每个截 16 字（不补省略号）/ 最多 8 个 / 去重去空 / 拼完截 120',
      [X.benchNormTags(' 投资 , AI ,, 投资 '), X.benchNormTags('a'.repeat(40)),
        X.benchNormTags('t0,t1,t2,t3,t4,t5,t6,t7,t8,t9,t10,t11,t12'), X.benchNormTags(null),
        X.benchNormTags(['x', 'x', 'y'])],
      ['投资,AI', 'a'.repeat(16), 't0,t1,t2,t3,t4,t5,t6,t7', '', 'x,y']);
    ok('抽屉的「几天前」按时刻算（24 小时一档），认不出时刻的一律 -1（任何窗都不进 —— 不拿「不知道」冒充今天）',
      [X.benchPostDays('') === -1, X.benchPostDays('刚刚') === -1, X.benchPostDays('2026-13-45T00:00:00.000Z') === -1,
        X.benchPostDays(ago(23 * 3600e3)), X.benchPostDays(ago(25 * 3600e3)), X.benchPostDays(ago(31 * DAY))],
      [true, true, true, 0, 1, 31]);
    ok('不带时区标记的字面按 UTC 解，不交给 Date 当本地时间（库里所有字面都带 Z；脏数据不带时若按本地解又差 8 小时）',
      X.benchPostMs('2026-10-27T08:36:53') === X.benchPostMs('2026-10-27T08:36:53Z'), '');
    eq('发帖时刻只认 time_datetime：没有就是没有（空串），绝不退回 first_at/last_at 冒充发帖时间',
      [X.benchPostPub(AP_ROWS[0]) === AP_ROWS[0].time_datetime, X.benchPostPub(AP_ROWS[2]) === '',
        X.benchPostPub({}) === '', X.benchPostPub(null) === ''], [true, true, true, true]);
    eq('hlShort 把 UTC 字面换成本机钟点（以前切一刀就画 ⇒ 面板写的比墙上钟早 8 小时：真机一屏「10-27 08:36」其实是 16:36 采的）',
      [X.hlShort('2026-10-27T08:36:53.613Z'), X.hlShort('2026-10-27T08:36:53.613'), X.hlShort('刚刚'), X.hlShort('')],
      [loc('2026-10-27T08:36:53.613Z'), loc('2026-10-27T08:36:53.613Z'), '刚刚', '']);
    ok('正向对照：这一格不许退回「切字面」——画出来的等于 UTC 字面时，只允许这台机器本来就是 UTC',
      X.hlShort('2026-10-27T08:36:53.613Z') !== utcSlice('2026-10-27T08:36:53.613Z')
        || new Date(0).getTimezoneOffset() === 0, '本机不是 UTC 却还在切字面画 UTC');

    // ---- v0.11.3（用户点名「去掉拉黑和标杆列」）：名单行尾那两颗没了 ----
    // 这一段的账本腿一个字没动（benchToggle → GM bench + kind=bench 记录 + benchmarks 表），
    // 只是触发点从「行尾那颗钮」换成主页那颗「☆标此人」——两者调的是同一个函数，所以这里直接调它。
    // 行本身现在只剩四格：[关系标记, 显示名, 比例签, 状态格]。
    const F = () => IDS['ysy-xprobe-ext-flist'];
    const fRow = (hh) => F().children.find((c) => c.children && new RegExp('^@' + hh + '( |$)').test(String(c.title || '')));
    X.flistBtn().fire('click');
    eq('三行都在（去掉的是列不是人：本页用户一个不少）', [fRow('alice'), fRow('bob'), fRow('carl')].filter(Boolean).length, 3);
    eq('每一行零按钮（行里再没有能写账的入口，点行只剩「滚到 TA 的帖子」）',
      [fRow('alice'), fRow('bob'), fRow('carl')].map((r) => r.querySelectorAll('button').length), [0, 0, 0]);
    const scr0 = scr19();
    X.benchToggle('alice');
    eq('走「☆标此人」那个函数 = 只写我方台账：GM 多出 alice（handle 小写归一），名单这行依旧零按钮（入口没偷偷长回来）',
      [Object.keys(bm()), fRow('alice').querySelectorAll('button').length], [['alice'], 0]);
    eq('调用方没给显示名 ⇒ 写账那层自己补一口本机 users 台账（库里那行不许只留个 @handle；v0.11.3 从行尾那颗钮搬进 benchWrite）',
      bm().alice.n, '爱丽丝');
    X.flush(); X.flush();
    ok('同一下也发了 kind=bench 记录（落库 benchmarks 表那条腿：on=1，带名字与分类）',
      postedRecords(s19).some((r) => r.kind === 'bench' && r.data.handle === 'alice' && r.data.on === 1 && r.data.name === '爱丽丝'),
      postedRecords(s19).filter((r) => r.kind === 'bench').map((r) => r.data));
    eq('标人这一路：页面零滚动、零注入（名单开着也不往 X 的 DOM 缝东西）', [scr19(), inj19()], [scr0, 0]);
    fRow('alice').fire('click', { type: 'click', target: F().querySelectorAll('button').find((b) => b.textContent === '刷') });
    eq('守卫认目标：事件一路冒泡到整行，target 是自家钮 ⇒ 不许把帖子跳走（红线不许 stopPropagation，只能认目标）',
      scr19(), scr0);
    fRow('bob').fire('click', { type: 'click', target: fRow('bob') });
    eq('正向对照：真点在这一行上（target 就是行）⇒ 照旧滚到 TA 的帖子，老功能没被守卫一起关掉', scr19(), scr0 + 1);
    ok('名单脚注写清两列去哪了、分类在哪改（不说清就等于让人对着一颗不存在的钮找）',
      /「拉黑」「标杆」这两列去掉了/.test(F().textContent) && /右缘「标杆」「标帖」两扇窗口/.test(F().textContent), '');

    // ---- 第五颗「杆」：方钮、让位账、人数写在钮上（方案 A 起字面是「杆N」，与第六颗「帖N」成对）----
    X.benchToggle('Bob', '乙'); X.benchToggle('CARL', '');
    X.fabBtn();
    const bb19 = IDS['ysy-xprobe-ext-bbtn'];
    eq('handle 大小写归一（从 @Bob 点进来也只有一份账），钮上的字面带台账人数',
      [Object.keys(bm()).join(','), X.benchCount(), X.benchFabText(), bb19.textContent], ['alice,bob,carl', 3, '杆3', '杆3']);
    eq('第五颗也是等大圆角方钮（方案 A）：宽高圆角按直径、padding 归零、人数在角标上',
      [bb19.style.width, bb19.style.height, bb19.style.borderRadius, bb19.style.padding],
      ['34px', '34px', '6px', '0']);
    eq('字面没变就不动 DOM（与「回」/灯同一条纪律）：再跑一趟 fabBtn 不重写这颗',
      (() => { const before = bb19.style.font; X.fabBtn(); return bb19.style.font === before; })(), true);
    eq('窗口底距与名单同档（都顶在钮排之上：334 基准 + 窗口那两颗各一格 40×2）', [X.benchBottomPx(), X.flistBottomPx()], [414, 414]);
    eq('右缘让位：名单开着 ⇒ 标杆往左让一档（两张面板并排不叠）', X.benchRightPx(), 14 + 268);
    X.flistBtn().fire('click');
    eq('正向对照：名单关掉 ⇒ 让位归零，回到 14 那条老规矩', X.benchRightPx(), 14);

    // ---- 右缘窗口：一条 dbq、库优先、缺数「—」、打开即排好 ----
    X.benchToggle('dave', '丁');   // 刚标完、还没 flush 进库的人（台账这一腿）
    wire19(s19);
    bb19.fire('click');
    await tick();
    eq('点「标」只发一条 dbq：白名单查询名 + limit，不带 SQL、不带任何对 X 的请求（RL-9）',
      s19.__dbSent, [{ t: 'dbq', q: 'bench_accounts', limit: 200 }]);
    const B = () => IDS['ysy-xprobe-ext-bench'];
    const hOf = (r) => (r.children[0].children.filter((c) => /^@/.test(c.textContent))[0] || {}).textContent || '?';
    const list19 = () => B().children.filter((c) => c.children[0] && c.children[0].children[0] && /^[▸▾]$/.test(c.children[0].children[0].textContent));
    const handles19 = () => list19().map((r) => hOf(r).split(' ')[0]);
    const rowOf = (hh) => list19().find((r) => hOf(r).split(' ')[0] === '@' + hh);
    const sortBtn = (lab) => B().children[1].querySelectorAll('button').find((b) => b.textContent === lab);
    const headBtn = (lab) => B().children[0].querySelectorAll('button').find((b) => b.textContent === lab);
    ok('窗口是自家 fixed 面板（挂 documentElement，与名单/卡片同款），X 的 DOM 依旧一个节点没多',
      !!B() && B().style.position === 'fixed' && B().style.zIndex === '2147483647' && inj19() === 0, '');
    eq('默认轴=粉丝（GM 里没存过 ⇒ 出厂那根），标题按人数、库回几行也如实写',
      [X.__bench().sort, B().children[0].children[0].textContent, /（库回 4 行）/.test(B().textContent)],
      ['fans', '标杆 5 人', true]);
    eq('排序：粉丝降序、缺数一律垫底 ⇒ alice 3000 > 台账的 dave 777 > erin 500 > carl 0 > bob 没数',
      handles19(), ['@alice', '@dave', '@erin', '@carl', '@bob']);
    eq('正向对照：把缺数当 0 一起排（老毛病）⇒ 并列后按 handle 升序，bob 会抢在 carl 前面（0 是真数、— 是没读到，不同档）',
      [X.benchMerge().slice().sort((a, b) => ((b.fans || 0) - (a.fans || 0)) || (a.handle < b.handle ? -1 : 1)).map((r) => r.handle),
        X.benchSorted(X.benchMerge()).map((r) => r.handle)],
      [['alice', 'dave', 'erin', 'bob', 'carl'], ['alice', 'dave', 'erin', 'carl', 'bob']]);
    eq('数：库优先（库记 alice 3000 ⇒ 不拿台账那 999 冒充）、缺的格退台账（carl 的帖数 2 来自本机 posts 台账）、两头都没有写「—」',
      [rowOf('alice').children[1].textContent, rowOf('dave').children[1].textContent,
        rowOf('erin').children[1].textContent, rowOf('carl').children[1].textContent,
        rowOf('bob').children[1].textContent],
      ['粉 3000 注 10 曝 400 互 28 帖 1｜库', '粉 777 注 20 曝 — 互 — 帖 —｜台账',
        '粉 500 注 — 曝 — 互 — 帖 —｜库', '粉 0 注 — 曝 — 互 0 帖 2｜库', '粉 — 注 — 曝 — 互 — 帖 —｜两头都没数']);
    ok('三本账各归各：库 3 人有数、台账补 1 人、一个数都没有 1 人（面板自己就把这句写出来）',
      /库 3 人有数 · 台账补 1 人 · 一个数都没有 1 人/.test(B().textContent), '');
    eq('行首标记照库说的走：carl 带「黑」（库里 blocked=1，本机台账并没拉黑他）、alice 带「✓」、bob 没标记就不插空位（那一格直接是 @handle）',
      [['carl', '黑'], ['alice', '✓'], ['bob', '@bob 乙']].map((p) => [p[0], rowOf(p[0]).children[0].children[1].textContent]),
      [['carl', '黑'], ['alice', '✓'], ['bob', '@bob 乙']]);
    eq('名字两头都有时台账优先（我刚敲的那一笔），台账没有才用库里落的那一笔 —— 都不拿 handle 冒充',
      [hOf(rowOf('alice')), hOf(rowOf('erin')), hOf(rowOf('bob'))], ['@alice 爱丽丝', '@erin 艾琳', '@bob 乙']);

    const sent0 = s19.__dbSent.length;
    sortBtn('互动').fire('click');
    eq('换一根轴 = 客户端重排，绝不再问一次库（点这颗不产生任何网络动作）', s19.__dbSent.length, sent0);
    eq('按互动降序：alice 28 > carl 0（真数）> bob/dave/erin 没数（垫底那一段按 handle 升序）',
      handles19(), ['@alice', '@carl', '@bob', '@dave', '@erin']);
    eq('选中的轴当场存进 GM —— 这就是「打开即自动排好」的全部实现（没有综合评分，也不按加入时间兜底）',
      [store['ysy.xprobe.benchSort'], X.__bench().sort], ['eng', 'eng']);
    sortBtn('加入').fire('click');
    eq('「加入」那根比的是 ISO 字面、降序：台账刚标的 dave 最上，库里 erin 11 > alice 10 > carl 09 > bob 08',
      handles19(), ['@dave', '@erin', '@alice', '@carl', '@bob']);

    // ---- 拖动（用户口径「不够就放到右侧」：位置一旦由你定下就不再自动挪）----
    const grip19 = B().children[0].children[0];
    eq('头部那格是拖动手柄（cursor:grab + 写明「拖的是探针自己的面板」）',
      [grip19.textContent, grip19.style.cursor, /拖的是探针自己的面板/.test(grip19.title)], ['标杆 5 人', 'grab', true]);
    grip19.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
    (s19.document.listeners['mousemove'] || []).forEach((f) => f({ clientX: 60, clientY: 80 }));
    eq('按住拖（左移 40 / 上移 20）= right+40 / bottom+20（右/底坐标系与屏幕方向相反）',
      [B().style.right, B().style.bottom], ['54px', '434px']);
    (s19.document.listeners['mouseup'] || []).forEach((f) => f({}));
    sortBtn('粉丝').fire('click');
    eq('拖过以后位置归用户：换轴重画不许把它拽回默认位（与名单同一判据）',
      [B().style.right, B().style.bottom, X.__bench().dragged], ['54px', '434px', true]);

    // ---- 抽屉：点某一行 = 在下方展开 TA 的帖子（用户原话「像抽屉一样，再下方展示他的帖子」）----
    const aLine = rowOf('alice').children[0];
    aLine.fire('click', { type: 'click', target: aLine });
    await tick();
    eq('点行 ⇒ 问的是库里现成的 author_posts（白名单查询名 + author + limit），一条新查询都不加（RL-9 的名单没变长）',
      s19.__dbSent[s19.__dbSent.length - 1], { t: 'dbq', q: 'author_posts', author: 'alice', limit: 30 });
    const drawer = () => { const r = rowOf('alice'); return r.children[r.children.length - 1]; };
    const dLines = () => drawer().children.filter((c) => /^曝 /.test(c.textContent))
      .map((c) => String(c.textContent).match(/^曝 \S+ 评 \S+ 赞 \S+/)[0]);
    const dB = (lab) => drawer().querySelectorAll('button').find((b) => b.textContent === lab);
    eq('抽屉默认按曝光降序、缺曝光那条垫底（不冒充 0），一条一行',
      dLines(), ['曝 5000 评 5 赞 30', '曝 200 评 12 赞 2', '曝 — 评 20 赞 1']);
    // v0.9.2 用户口径「正文在前，数值在第二行」：以前一行塞 曝/评/赞/时间/正文，300px 不换行 ⇒ 正文只剩三五个字
    const dPairs = () => { const ch = drawer().children; const out = []; ch.forEach((c, i) => { if (/^曝 /.test(c.textContent)) out.push([ch[i - 1], c]); }); return out; };
    eq('一条帖子两行：第一行是正文（不是数字），第二行才是 曝/评/赞 + 时间（用户点名的摆法）',
      [dPairs().length, /^曝 /.test(dPairs()[0][0].textContent), dPairs()[0][0].textContent, /^曝 5000 评 5 赞 30 · /.test(dPairs()[0][1].textContent)],
      [3, false, '甲的旧帖', true]);
    eq('第二行那个时间是「发帖时间」且走本机钟点（120 天前发的那条不许显示成 40 天前——那是我们采到它的时刻）',
      dPairs().map((pr) => pr[1].textContent),
      ['曝 5000 评 5 赞 30 · ' + loc(AP_ROWS[0].time_datetime),
        '曝 200 评 12 赞 2 · ' + loc(AP_ROWS[1].time_datetime),
        '曝 — 评 20 赞 1 · 发帖时间没读到']);
    ok('没读到发帖时间的那条不拿采集时刻填空（RL-11）：字面就写「发帖时间没读到」',
      /发帖时间没读到/.test(dPairs()[2][1].textContent)
        && !dPairs()[2][1].textContent.includes(loc(AP_ROWS[2].last_at)), '');
    ok('采集时刻没丢，收在这一行的 title 里（第一次 / 最近一次都写出来）；「点这一行不做事」那句还在',
      /采到：/.test(dPairs()[0][1].title) && /第一次/.test(dPairs()[0][1].title)
        && /点它不做事/.test(dPairs().map((pr) => pr[1].title).join('|')), dPairs()[0][1].title);
    const sentD = s19.__dbSent.length;
    dB('30天').fire('click');
    eq('窗=30天按**发帖时间**筛：120 天前发的筛掉、没读到发帖时间的也筛掉（是不显示，不是排后面），只剩 2 天前那条',
      dLines(), ['曝 200 评 12 赞 2']);
    eq('正向对照：同一份夹具按老的采集时刻筛会留下两条（40 天前采的那条 last_at 在 30 天窗里）⇒ 这条判据真的在验发帖时间',
      AP_ROWS.filter((p) => { const d = X.benchPostDays(p.last_at); return d >= 0 && d <= 30; }).length, 2);
    dB('1天').fire('click');
    ok('空榜要说清两种原因：库里共 3 条，其中 1 条压根没读到发帖时刻（任何窗都不进）——不能只怪窗口窄',
      /这个窗口里没有 TA 的帖子（库里共 3 条，把窗换成「全部」看看；其中 1 条没读到发帖时刻，任何窗都不进）/
        .test(drawer().textContent), drawer().textContent);
    dB('全部').fire('click');
    dB('评论').fire('click');
    eq('排=评论：重排的还是库已经给回来的那三条 —— 换轴、换窗都不再问一次库',
      [s19.__dbSent.length, dLines()], [sentD, ['曝 — 评 20 赞 1', '曝 200 评 12 赞 2', '曝 5000 评 5 赞 30']]);
    dB('时间').fire('click');
    eq('排=时间按发帖时刻降序：2 天前发的 > 120 天前发的 > 没读到发帖时刻的垫底（老写法按采集时刻会把 9603 排在 9601 前面）',
      dLines(), ['曝 200 评 12 赞 2', '曝 5000 评 5 赞 30', '曝 — 评 20 赞 1']);
    eq('展开抽屉这一路：页面依旧零滚动（只开合我们自己的抽屉，不滚帖、不导航）', scr19(), scr0 + 1);
    const eLine = rowOf('erin').children[0];
    eLine.fire('click', { type: 'click', target: eLine });
    await tick();
    eq('库里一条都没抓到过这个人 ⇒ 直说「没有 TA 的帖子记录」，不空着让人以为坏了（RL-11）',
      /本机库里没有 TA 的帖子记录/.test(rowOf('erin').children[rowOf('erin').children.length - 1].textContent), true);
    X.benchToggle('we*ird', '脏名');
    X.renderBench();
    const sentW = s19.__dbSent.length;
    const wLine = rowOf('we*ird').children[0];
    wLine.fire('click', { type: 'click', target: wLine });
    await tick();
    eq('handle 里带库不认的字符 ⇒ 当场说清楚、一个请求都不发（不把脏值递给库让它回 400）',
      [s19.__dbSent.length, /字符库不认/.test(rowOf('we*ird').textContent)], [sentW, true]);

    // ---- 分类：打标签与改标签，以及「库里有人、台账没人」那一种如实拒绝 ----
    const aInp = rowOf('alice').querySelectorAll('input')[0];
    aInp.value = '投资, AI,投资,' + 'x'.repeat(30);
    rowOf('alice').querySelectorAll('button').find((b) => b.textContent === '存').fire('click');
    eq('点「存」才写（不靠键盘事件）：归一后的分类进台账，改一次 = 库里再落一行（append-only，历史不动）',
      [bm().alice.tags, /分类已存：@alice/.test(B().textContent)], ['投资,AI,' + 'x'.repeat(16), true]);
    X.flush(); X.flush();
    ok('改分类也发 kind=bench（on=1 带新 tags）——面板显示的与库里存的是同一份口径',
      postedRecords(s19).some((r) => r.kind === 'bench' && r.data.handle === 'alice' && r.data.tags === '投资,AI,' + 'x'.repeat(16)),
      postedRecords(s19).filter((r) => r.kind === 'bench').map((r) => r.data.tags));
    eq('标签 chip 就地出现在行里（分类不用刷新就能看到）',
      rowOf('alice').children[0].children.filter((c) => /^投资/.test(c.textContent)).length, 1);
    const keysBefore = Object.keys(bm()).join(',');
    rowOf('erin').querySelectorAll('input')[0].value = 'AI';
    rowOf('erin').querySelectorAll('button').find((b) => b.textContent === '存').fire('click');
    eq('库里是标杆、本机台账没记着的人：不替他凭空造一条账 ⇒ 说清要先点「标为」，台账一个字不动',
      [Object.keys(bm()).join(',') === keysBefore, /不在本机台账里/.test(B().textContent),
        rowOf('erin').children[0].children[rowOf('erin').children[0].children.length - 1].textContent],
      [true, true, '标为']);
    rowOf('erin').children[0].querySelectorAll('button').find((b) => b.textContent === '标为').fire('click');
    await tick();
    ok('「标为」把库里已有、台账丢了的人重新记回台账（这一步之后才允许改分类）',
      !!bm().erin && /移出/.test(rowOf('erin').children[0].textContent), Object.keys(bm()));
    const nBrush = s19.__dbSent.length;
    headBtn('刷').fire('click');
    await tick();   // v0.11.0：先问接口（needLocal 才退回本机库）⇒ 这一趟跨了微任务，不再同拍进 __dbSent
    eq('换窗（抽屉与分类都在）也不再问一次库；只有「刷」那一颗才重取',
      [nBrush, s19.__dbSent.length - nBrush], [nBrush, 1]);

    // ---- 收摊：窗口摘掉，台账一条不动 ----
    const keysEnd = Object.keys(bm()).join(',');
    headBtn('×').fire('click');
    eq('收起 = 整棵从页面摘掉，台账一条不动（窗口是视图，账本才是账）',
      [IDS['ysy-xprobe-ext-bench'], Object.keys(bm()).join(',')], [undefined, keysEnd]);

    // ================= 以下每条各起一份新沙箱（都会抢走 IDS，所以排在真机路径之后、自成一段）=================
    // 「打开即自动排好」的完整腿：轴存在 GM ⇒ 换一页、什么都不多点，窗口自己就排好了
    seed19({
      alice: { at: '2026-10-24T10:00:00.000Z', n: '爱丽丝', tags: '投资,AI' },
      bob: { at: '2026-10-24T08:00:00.000Z', n: '', tags: '' },
      carl: { at: '2026-10-24T09:00:00.000Z', n: '卡尔', tags: '' },
      dave: { at: '2026-10-24T07:00:00.000Z', n: '丁', tags: '' },
    });
    store['ysy.xprobe.benchSort'] = 'eng';
    const p19b = h('div', {}, [tweetCell('alice', '9501', '2026-10-26T03:00:00.000Z', '甲帖')]);
    const s19b = run(p19b, '/home', 'https://x.com/home');
    wire19(s19b);
    IDS['ysy-xprobe-ext-bbtn'].fire('click');
    await tick();
    const listB = () => IDS['ysy-xprobe-ext-bench'].children.filter((c) => c.children[0] && c.children[0].children[0] && /^[▸▾]$/.test(c.children[0].children[0].textContent));
    eq('换一页、一个钮都没多点：一打开就按上次那根轴（互动）排好了 —— 用户点的「打开即自动排好」就是这一条',
      [s19b.__xprobe.__bench().sort,
        listB().map((r) => (r.children[0].children.filter((c) => /^@/.test(c.textContent))[0] || {}).textContent.split(' ')[0])],
      ['eng', ['@alice', '@carl', '@bob', '@dave', '@erin']]);
    eq('正向对照：同一份 GM 台账里把轴换成「帖数」⇒ 起页读的就是那根（这条记忆真的咬 GM，不是每次都退回粉丝）',
      (() => { store['ysy.xprobe.benchSort'] = 'postsN'; const sb2 = run(p19b, '/home', 'https://x.com/home'); return sb2.__xprobe.__bench().sort; })(), 'postsN');
    eq('正向对照：GM 里那根轴是脏值（别的版本/手改）⇒ 只认六个名字，认不出退回粉丝，绝不拿脏值去排序',
      (() => { store['ysy.xprobe.benchSort'] = 'fans;DROP TABLE'; const sb3 = run(p19b, '/home', 'https://x.com/home'); return sb3.__xprobe.__bench().sort; })(), 'fans');

    // 「库没回话」「台账空着」两条不许静默的腿
    seed19({ alice: { at: '2026-10-24T10:00:00.000Z', n: '爱丽丝', tags: '' } });
    const p19d = h('div', {}, [tweetCell('alice', '9501', '2026-10-26T03:00:00.000Z', '甲帖')]);
    const s19d = run(p19d, '/home', 'https://x.com/home');
    s19d.__xprobe.toggleBench();
    await tick();
    ok('库没回话（宿主/sink 没起）就直说什么都没读到，并记进 benchFail —— 不拿台账冒充库（RL-11）',
      /本机库也没回话/.test(IDS['ysy-xprobe-ext-bench'].textContent)
      && s19d.__xprobe.perfLine().benchFail === 1 && s19d.__xprobe.perfLine().benchAsk === 1, s19d.__xprobe.perfLine());
    const sd19 = run(p19d, '/home', 'https://x.com/home');
    // v0.11.0：标杆窗先问接口（benchQuery）；旧 SW/本机模式回 undefined ⇒ 退回本机库。桩对别的消息也要回话，
    // 不回话等于「协议上没这件事」，真机里那条路会等 12 秒超时
    sd19.chrome.runtime.sendMessage = (m, cb) => {
      if (m && m.t === 'dbq' && cb) cb({ ok: false, err: 'no such table: benchmarks（sink 那边库版本旧？）' });
      else if (cb) cb(undefined);
    };
    sd19.__xprobe.toggleBench();
    await tick();
    ok('回包说「库拒了」也照原话贴出来（不吞错误码），且仍然算一问一败',
      /本机库拒了：no such table/.test(IDS['ysy-xprobe-ext-bench'].textContent)
      && sd19.__xprobe.perfLine().benchFail === 1 && sd19.__xprobe.perfLine().benchAsk === 1,
      [IDS['ysy-xprobe-ext-bench'].textContent.slice(0, 40), sd19.__xprobe.perfLine()]);
    ok('台账里一个人也没有 ⇒ 窗口给一句「名单还是空的，去『本页用户』点标杆」，不是空白一片',
      (() => {
        store['ysy.xprobe.bench'] = {};
        const se = run(p19d, '/home', 'https://x.com/home');
        se.__xprobe.toggleBench();
        return /标杆名单还是空的/.test(IDS['ysy-xprobe-ext-bench'].textContent);
      })(), true);

    // 第五颗与窗口都不许进「照 X 的钮 sizing」那条扫描（自家面板挂在同一棵树里，扫页面时是候选）
    seed19({ alice: { at: '2026-10-24T10:00:00.000Z', n: '爱丽丝', tags: '' } });
    const p19f = h('div', {}, [tweetCell('fr', '9701', '2026-10-26T03:00:00.000Z', '丁帖')]);
    const s19f = run(p19f, '/fr', 'https://x.com/fr');
    s19f.chrome.runtime.sendMessage = (m, cb) => { if (m && m.t === 'dbq' && cb) cb({ ok: true, rows: BM_ROWS }); else if (cb) cb(undefined); };
    s19f.__xprobe.toggleBench();
    const bs19f = IDS['ysy-xprobe-ext-bench'].querySelectorAll('button');
    bs19f.forEach((b) => { b.__geo = { left: 1360, top: 700, width: 60, height: 60 }; });
    eq('窗口里那十几颗钮全被灌成「右缘 60px 方块」（正是参照物想要的形状）⇒ 量到的仍是 0：自家面板不算参照物',
      [bs19f.length > 8, s19f.__xprobe.fabPeerDiam()], [true, 0]);
    const s19f2 = runSource(src.replace('OWN_PANEL_IDS.indexOf(x.id) >= 0', 'false'),
      h('div', {}, [tweetCell('fr', '9702', '2026-10-26T03:00:00.000Z', '丁帖')]), '/fr', 'https://x.com/fr');
    s19f2.chrome.runtime.sendMessage = (m, cb) => { if (m && m.t === 'dbq' && cb) cb({ ok: true, rows: BM_ROWS }); else if (cb) cb(undefined); };
    s19f2.__xprobe.toggleBench();
    IDS['ysy-xprobe-ext-bench'].querySelectorAll('button').forEach((b) => { b.__geo = { left: 1360, top: 700, width: 60, height: 60 }; });
    eq('正向对照：把「自家面板那一族」的排除从 fabOwn 里抠掉 ⇒ 同一批钮立刻被当成 X 的右缘那一列（量出 60），这条排除真的咬',
      s19f2.__xprobe.fabPeerDiam(), 60);

    // benchNum 那条硬口径的变异对照（放最后：runSource 会抢走 IDS）
    const s19m = runSource(src.replace("    if (v == null || v === '') return '—';", "    if (v == null || v === '') v = 0;"),
      h('div', {}, [tweetCell('mm', '9801', '2026-10-26T03:00:00.000Z', '钉帖')]), '/mm', 'https://x.com/mm');
    eq('正向对照：抠掉「缺数⇒—」那一行（把没读到当 0）⇒ 同一个 null 现在写「0」，判据真的咬这一行',
      [s19m.__xprobe.benchNum(null), s19m.__xprobe.benchNum(0)], ['0', '0']);

    // ---- 跨层针脚：SQL 只在库那边、摘要只在 sink 那边、账只在面板那行 ----
    const core19 = src.replace(/^\s*\/\/.*$/gm, '');
    const db19 = rd('../xprobe_db.py'), sink19 = rd('../log-sink.py'), view19 = rd('ui/view.js');
    ok('数据层三条都在库里（不是面板自己拼 SQL）：benchmarks 表 + bench_now 视图 + 两条白名单查询',
      /CREATE TABLE IF NOT EXISTS benchmarks\(/.test(db19) && /CREATE VIEW IF NOT EXISTS bench_now AS/.test(db19)
      && /"bench_accounts": "SELECT b\.handle/.test(db19)
      && /"benchmarks": "SELECT at, handle, name, state, tags FROM benchmarks ORDER BY id DESC LIMIT \?"/.test(db19), '');
    // 只把「续行」（Python 隐式字符串拼接）算进查询正文；[\s\S]*?\n 那种写法会把上一行的 ? 数成 0，
    // 贪婪跨过注释行的写法会把注释里的问号也算进来 —— 两种都别用。
    const qText19 = (name) => {
      const i = db19.indexOf('"' + name + '":');
      if (i < 0) return '';
      const seg = db19.slice(i).split('\n');
      let out = seg[0];
      for (let k = 1; k < seg.length && /^\s*"/.test(seg[k]) && !/^\s*"[A-Za-z_]+":/.test(seg[k]); k++) out += seg[k];
      return out;
    };
    eq('RL-9 没被顶开：两条新查询各只有一个 ?（limit），一个新参数量纲都没加',
      [(qText19('bench_accounts').match(/\?/g) || []).length,
        (qText19('benchmarks').match(/\?/g) || []).length], [1, 1]);
    ok('core 里一个 SQL 片段都没有，问库只认这两个名字；抽屉吃现成的 author_posts',
      !/SELECT/.test(core19) && /q: 'bench_accounts'/.test(core19) && /q: 'author_posts'/.test(core19), '');
    ok('红线针脚：点行只开自家抽屉（认目标、不拦冒泡），标杆那几块代码里没有 scrollIntoView / 没有对 X 的请求',
      /ev\.target\.tagName === 'BUTTON' \|\| ev\.target\.tagName === 'INPUT'/.test(core19)
      && !/scrollIntoView|GM_xmlhttpRequest|fetch\(/.test(core19.slice(core19.indexOf('function benchRowEl'), core19.indexOf('function benchFabText'))), '');
    eq('正向对照：把「点行认目标」那条守卫抠掉（= 点标记也会把帖子跳走）⇒ 上面那条判据当场变红',
      /ev\.target\.tagName === 'BUTTON' \|\| ev\.target\.tagName === 'INPUT'/.test(
        core19.replace(/if \(ev && ev\.target && \(ev\.target\.tagName === 'BUTTON' \|\| ev\.target\.tagName === 'INPUT'\)\) return;/, '')), false);
    ok('sink 那行的摘要认得 bench（日志里看得见「标为标杆 / 移出标杆 + 分类」，不是只剩一个 kind）',
      /if kind == "bench":/.test(sink19) && /标为标杆/.test(sink19) && /移出标杆/.test(sink19), '');
    eq('面板性能账多这一格（问库几回 / 没回话几回），说的就是这一窗的账；库版本回到 db-10（v0.11.5 曾抬 db-11 加 own_posts，用户撤了，v0.11.6 随之回）',
      [/｜ 标杆 问' \+ \(p\.benchAsk \|\| 0\) \+ '回\/没回话' \+ \(p\.benchFail \|\| 0\)/.test(view19), /^DB_VER = "db-10"$/m.test(db19)],
      [true, true]);
    eq('诊断摘要带这一窗的形状（台账人数/库回行数），真机出问题时先看这一格',
      X.debugDigest().env.bench.split('/').length, 2);
    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.benchSort'];
    delete store['ysy.xprobe.users'];
    delete store['ysy.xprobe.posts'];
    delete store['ysy.xprobe.badge'];
  }

  console.log('\n[20] v0.9.1 主页那颗标人胶囊（v0.9.3 起是文字「☆标此人/★已标人」，用户点名「之前的账号那个按钮不清晰」）');
  {
    // 用户带截图来的现场：「没看到啊，应该每个人的页面都应该有一个标杆标签的，你是不是加错地方 https://x.com/jasonmysee
    // / 可以在个人主页的昵称右侧加一个加入标杆，和移除标杆的图标」。v0.9.0 的入口全在自家面板里（名单行尾那颗 + 右缘窗口），
    // 个人主页上一颗都没有 ⇒ 这一轮把「加/移标杆」钉到他圈的那块空白上：昵称那一行的右边。
    // 与前四颗不一样：**这一颗长在 X 的 DOM 里** ⇒ 归 RL-16 那道总闸管（v0.8.16 起默认开），关掉与拉黑徽标一起摘干净、
    // 连我们补的那一笔 position 原样还回去；借的也是徽标在真机验证过的那套几何：绝对定位不占位、宽度先进预算再挑落点、
    // 宿主必须仍是「一行」的高度且绝不住进 X 的可点元素里、老位置还空着就一个字都不写。
    // handle 只认 URL 不认 DOM（名字那行有第三方胶囊的字）。整页最多一颗，且不为它开第二趟整文档扫描。
    // 结构纪律照 [19]：所有走真机路径的断言在第一份沙箱里跑完，换页/正向对照各自再起沙箱、排在最后。
    store['ysy.xprobe.badge'] = true;
    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.users'];
    const led20 = () => { const v = store['ysy.xprobe.bench'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };
    // 真机形状（用户截图那一页 /jasonmysee）：UserName 那一层里两行，第一行 [dir] 是「昵称 + 认证标」，第二行是 @handle。
    // ⚠ 桩按「有没有 data-testid」决定横排还是竖排，测试要的是真机那套竖排坐标 ⇒ 起手后再手工覆写一遍 __geo。
    const mk20 = (opt) => {
      const o = opt || {};
      const name = h('div', { dir: 'ltr' }, [h('span', {}, [T('活力男')]), h('span', { 'data-testid': 'VerifiedBadge' }, [])]);
      const tag = h('div', { dir: 'ltr' }, [T('@jasonmysee')]);
      const box = h('div', { 'data-testid': 'UserName' }, o.noDir ? [T('活力男@jasonmysee')] : [name, tag]);
      let top = box;
      if (o.inBtn) top = h('button', { 'aria-label': '进入主页' }, [box]);
      const root = o.noBox ? h('div', {}, [h('span', {}, [T('这一页没有头部')])]) : h('div', {}, [top]);
      return { root: root, box: o.noBox ? null : box, name: name, tag: tag };
    };
    const geo20 = (t) => {
      if (t.box) t.box.__geo = { left: 320, top: 180, width: 520, height: 60 };
      if (t.name) t.name.__geo = { left: 324, top: 124 + 62, width: 150, height: 28 };
      if (t.tag) t.tag.__geo = { left: 324, top: 156 + 62, width: 150, height: 24 };
    };
    // 桩不会自己排版：这颗是 render 之后才挂上去的 ⇒ 想测「粘住」就得按浏览器会画在哪一样替它补一笔矩形
    const paint20 = (n) => {
      const hp = n.parentNode.__geo || { left: 0, top: 0, width: 0, height: 0 };
      n.__geo = { left: hp.left + Number(String(n.style.left || '0').replace('px', '')),
                  top: hp.top + 10, width: 26, height: 20 };
    };
    const stars20 = (t) => t.root.querySelectorAll('[data-xprobe="bench"], .ysy-xprobe-benchb');
    const scr20 = (t) => t.root.descendants().reduce((a, n) => a + (n.__scrolls || 0), 0);

    const t20 = mk20();
    const s20 = run(t20.root, '/jasonmysee', 'https://x.com/jasonmysee');
    geo20(t20);
    const p20 = s20.__xprobe.perfLine();
    const scans0 = p20.badgeScans;
    s20.__xprobe.renderBlocks(true);
    const st20 = stars20(t20)[0];
    eq('个人主页昵称右边出一颗，宿主就是 UserName 那一层（不是 X 自己的任何一颗钮），账上记「出 1 颗」',
      [stars20(t20).length, st20.parentNode === t20.box, !!st20.getAttribute('data-xprobe'),
        s20.__xprobe.perfLine().benchBadge, s20.__xprobe.perfLine().benchBadgeWhy], [1, true, true, 1, '']);
    ok('不占位：position:absolute + display:block，那一层的宽高/外边距一个字没改（改过 = 光标底下的东西会挪位）',
      st20.style.position === 'absolute' && st20.style.display === 'block' && !st20.style.width
      && !st20.style.height && !/margin/.test(st20.style.cssText || ''), st20.style.cssText);
    eq('落点 = 昵称行右缘 + 4 − 宿主左缘（贴着他要挨着的那行字，不贴宿主右墙），纵向跟昵称行中线',
      [Number(String(st20.style.left).replace('px', '')), st20.style.top],
      [t20.name.__geo.left + t20.name.__geo.width + 4 - t20.box.__geo.left,
       Math.round(t20.name.__geo.top + t20.name.__geo.height / 2 - t20.box.__geo.top) + 'px']);
    eq('宿主是我们补的 position:relative（X 那层本来没有），且这一趟只是徽标那一趟顺手扫的（badgeScans 只 +1）',
      [t20.box.style.position, s20.__xprobe.__badgeHosts().length, s20.__xprobe.perfLine().badgeScans - scans0],
      ['relative', 1, 1]);
    eq('还没进名单 ⇒ 整字面「☆标此人」+ 灰；data-h 认的是 URL 里那个 handle',
      [st20.children[0].textContent, st20.children[0].style.color, st20.getAttribute('data-h'), st20.getAttribute('data-n')],
      ['☆标此人', '#8b98a5', 'jasonmysee', '活力男']);
    ok('☆ 的 title 说清「只记账、不动 X 的任何东西」与分类去哪改（这颗长在页面上，读 title 就是它的说明书）',
      /把 @jasonmysee 加进标杆名单/.test(st20.children[0].title) && /不动 X 的任何东西/.test(st20.children[0].title)
      && /分类在右缘「标杆」窗口里改/.test(st20.children[0].title), st20.children[0].title);

    const scr0 = scr20(t20);
    st20.children[0].fire('click');
    eq('点 ☆ ⇒ 只写我方台账（GM 多出这个人）、就地翻成「★已标人」+ 绿、data-f=1（这一路不滚页面、不多缝第二颗）',
      [Object.keys(led20()), st20.children[0].textContent, st20.children[0].style.color, st20.getAttribute('data-f'),
        stars20(t20).length, scr20(t20)], [['jasonmysee'], '★已标人', '#4ec98a', '1', 1, scr0]);
    ok('★ 的 title 改口「在标杆名单里…点一下移除」（加入/移除两种状态各说各的，不是一句写死）',
      /在标杆名单里/.test(st20.children[0].title) && /点一下移除/.test(st20.children[0].title), st20.children[0].title);
    s20.__xprobe.flush();
    ok('同一下也发 kind=bench（落库 benchmarks 表那条腿：on=1 带名字）——主页这颗与名单/窗口是同一本账',
      postedRecords(s20).some((r) => r.kind === 'bench' && r.data.handle === 'jasonmysee' && r.data.on === 1
        && r.data.name === '活力男'), postedRecords(s20).filter((r) => r.kind === 'bench').map((r) => r.data));
    eq('正向对照：点它落的账与右缘那颗「标」 counted 同一份（benchCount 1、名单行尾那颗钮同步改口）',
      [s20.__xprobe.benchCount(), s20.__xprobe.isBench('jasonmysee')], [1, true]);
    st20.children[0].fire('click');
    eq('再点一下 = 移除（用户要的两态都在这一颗上）：台账清空、字面退回「☆标此人」',
      [Object.keys(led20()).length, st20.children[0].textContent, st20.getAttribute('data-f')], [0, '☆标此人', '0']);

    // ---- 粘住：还是这个人、老位置仍然空着 ⇒ 这一趟对它一个字都不写（徽标那套「别来回跑」的纪律原样借来）----
    s20.__xprobe.benchToggle('jasonmysee', '活力男');   // 台账改成「已在名单」，但 DOM 上这颗要等下一趟重画才翻
    paint20(st20);
    st20.style.top = '7px';                            // 故意写歪一笔：这一趟只要真粘住，它就不该被改回 18px
    s20.__xprobe.renderBlocks(true);
    eq('下一趟：同一颗、同一个宿主、坐标没被重写（粘住），但状态字面按台账翻成了 ★（该改的才改）',
      [stars20(t20).length === 1 && stars20(t20)[0] === st20, st20.style.top, st20.children[0].textContent,
        s20.__xprobe.perfLine().benchBadge], [true, '7px', '★已标人', 1]);
    eq('正向对照：同一趟「从零重算」的落点还是 158px ⇒ 上面那条粘住挡下的是「重摆」这件事，不是断言写空',
      s20.__xprobe.__badgeFit(t20.box, t20.name).left, 158);
    const wall20 = h('div', {}, [T('第三方胶囊')]);
    wall20.__geo = { left: 478, top: 186, width: 362, height: 24 };
    t20.box.appendChild(wall20);
    s20.__xprobe.renderBlocks(true);
    eq('老位置真被新出现的盒子占了 ⇒ 这颗不出（绝不盖住页面自己的东西），并如实说为什么（RL-11）',
      [stars20(t20).length, s20.__xprobe.perfLine().benchBadge, s20.__xprobe.perfLine().benchBadgeWhy],
      [0, 0, '昵称右边那条空白放不下这一颗（最宽的缝 0px < 短字面要 38px）']);
    wall20.remove();
    s20.__xprobe.renderBlocks(true);
    eq('墙走了 ⇒ 下一趟自己长回来（不用刷新页面、不用人工干预）',
      [stars20(t20).length, stars20(t20)[0].style.left], [1, '158px']);
    // 整页只一颗：手动多塞一颗（模拟 React 重渲染留下的孤儿），下一趟必须收掉多的
    const dup20 = h('span', { class: 'ysy-xprobe-benchb', 'data-xprobe': 'bench' }, []);
    dup20.__geo = { left: 700, top: 190, width: 26, height: 20 };
    t20.box.appendChild(dup20);
    s20.__xprobe.renderBlocks(true);
    eq('多出来的一颗（上一趟换页留下的）当场摘掉：整页始终最多一颗', [stars20(t20).length, dup20.parentNode], [1, null]);

    // ---- 「☆/★」不许被读回页面的话：它就挂在昵称那一层里 ----
    s20.__xprobe.flush();
    const nmBox = () => s20.__xprobe.nativeText(t20.box);
    ok('读名字走 nativeText：自家子树整棵跳过 ⇒ 落库/落台账的名字仍是「活力男」，不是「活力男☆」',
      nmBox().indexOf('☆') < 0 && nmBox().indexOf('★') < 0 && nmBox().indexOf('活力男') >= 0, nmBox());
    ok('快照那头也没被污染：displayName 干净，且原始文本那格 displayNameRaw 也不带星（displayName 只是被「@handle 以后全砍」挡住，真漏的是 Raw 这格 ⇒ 落台账/落库的名字来源）',
      !/[★☆]/.test(String(s20.__xprobe.snapshot().identity.displayName || ''))
      && !/[★☆]/.test(String(s20.__xprobe.snapshot().identity.displayNameRaw || '')),
      [s20.__xprobe.snapshot().identity.displayName, s20.__xprobe.snapshot().identity.displayNameRaw]);

    // ---- 换页：SPA 到别人主页 ⇒ handle 认 URL，老那颗当场摘、新的挂上 ----
    s20.location.pathname = '/bob'; s20.location.href = 'https://x.com/bob';
    s20.__xprobe.renderBlocks(true);
    eq('SPA 换到别人的主页（DOM 没重建、还是那个盒子）⇒ handle 认的是 URL：老那颗摘掉、新的一颗 data-h 换成 bob',
      [stars20(t20).length, stars20(t20)[0].getAttribute('data-h'), stars20(t20)[0].children[0].textContent],
      [1, 'bob', '☆标此人']);
    s20.location.pathname = '/jasonmysee'; s20.location.href = 'https://x.com/jasonmysee';
    s20.__xprobe.renderBlocks(true);
    eq('换回来 ⇒ 账还在（他在名单里）⇒ 这颗直接是 ★，不用重扫第二趟',
      [stars20(t20)[0].getAttribute('data-h'), stars20(t20)[0].children[0].textContent], ['jasonmysee', '★已标人']);

    // ================= 以下每条各起一份新沙箱（run 会重排 __geo 并抢走 IDS，所以排在真机路径之后）=================
    // ① 非个人主页：同样的盒子摆在时间线上也不许缝
    const t20h = mk20();
    const s20h = run(t20h.root, '/home', 'https://x.com/home');
    geo20(t20h);
    s20h.__xprobe.renderBlocks(true);
    eq('同一棵树、同一道闸，只是页型不是个人主页 ⇒ 一颗都不缝，账也归零（why 空 = 这里本来就不该有）',
      [stars20(t20h).length, s20h.__xprobe.perfLine().benchBadge, s20h.__xprobe.perfLine().benchBadgeNo,
        s20h.__xprobe.perfLine().benchBadgeWhy], [0, 0, 0, '']);
    // ② 找不到昵称那一行（X 改版）⇒ 不许静默
    const t20n = mk20({ noBox: true });
    const s20n = run(t20n.root, '/nobody', 'https://x.com/nobody');
    s20n.__xprobe.renderBlocks(true);
    eq('整页没有 [data-testid="UserName"] ⇒ 面板那行写清「这一页没找到昵称那一行（X 改版了）」，不是什么都不说',
      [s20n.__xprobe.perfLine().benchBadge, s20n.__xprobe.perfLine().benchBadgeNo,
        s20n.__xprobe.perfLine().benchBadgeWhy], [0, 1, '这一页没找到昵称那一行（X 改版了？）']);
    // ③ 昵称那一层住进 X 的可点元素里 ⇒ 不挂（绝对定位的钮会替那颗钮吃点击）
    const t20b = mk20({ inBtn: true });
    const s20b = run(t20b.root, '/inbtn', 'https://x.com/inbtn');
    geo20(t20b);
    s20b.__xprobe.renderBlocks(true);
    eq('宿主住在 button 里 ⇒ 这颗不出（红线：绝不挂进 X 的可点元素），并说清原因',
      [stars20(t20b).length, s20b.__xprobe.perfLine().benchBadgeWhy], [0, '昵称那一层挂不住（不是行高，或住在 X 的可点元素里）']);
    // ④ 没有 [dir] 那一行（老结构/改版）⇒ 拿不到「昵称右边」这块空白就不出，不猜第二个位置
    const t20d = mk20({ noDir: true });
    const s20d = run(t20d.root, '/nodir', 'https://x.com/nodir');
    if (t20d.box) t20d.box.__geo = { left: 320, top: 180, width: 150, height: 40 };
    s20d.__xprobe.renderBlocks(true);
    eq('量到的空白放不下这一颗 ⇒ 不出、不缩成小红点（这一颗是钮，点不动的红点是骗人），账上如实记为什么',
      [stars20(t20d).length, s20d.__xprobe.perfLine().benchBadgeWhy], [0, '昵称右边那条空白放不下这一颗（最宽的缝 0px < 短字面要 38px）']);
    // ⑤ 关闸：与拉黑徽标一起摘干净，连补的 position 也还回去
    const t20g = mk20();
    const s20g = run(t20g.root, '/jasonmysee', 'https://x.com/jasonmysee');
    geo20(t20g);
    s20g.__xprobe.renderBlocks(true);
    const g20on = stars20(t20g).length;
    s20g.__xprobe.setBadgeOn(false);
    eq('把 RL-16 那道闸拨回「关」⇒ 这一刻这颗与徽标一起摘干净，宿主 position 原样还回去（页面零痕迹）',
      [g20on, stars20(t20g).length, t20g.box.style.position, s20g.__xprobe.__badgeHosts().length], [1, 0, '', 0]);
    s20g.__xprobe.renderBlocks(true);   // 连 force（用户刚点完拉黑）这一路也不许再缝回来
    eq('关着的时候连 force 都不缝，账上写的是「闸关着（不注入）」（不说清就等于让人以为坏了）',
      [stars20(t20g).length, s20g.__xprobe.perfLine().benchBadge, s20g.__xprobe.perfLine().benchBadgeWhy],
      [0, 0, '闸关着（不注入）']);
    // ⚠ GM store 整套测试共用一份：上面那笔 setBadgeOn(false) 把闸写成了「关」，而 renderBlocks 的总闸在
    // 一切判断之前 ⇒ 下面每条正向对照都必须先把闸拨回「开」，否则「抠掉一句就变红」会退化成
    // 「闸关着本来就不出」的假阳性（这条踩过：抠掉清场选择器那判据 got=[0,0]，看着像过了其实根本没进去扫）。

    // ---- 正向对照（每条只抠掉一行源码，证明判据咬的就是那一行，不是别处）----
    // 每条各起一份沙箱；起之前把闸拨回「开」——GM store 整套测试共用一份，上一条留下的「关」（6006 那笔，
    // 或清场那条自己的 setBadgeOn(false)）会顺着新沙箱流进来，那时页面本来什么都不出，判据就成了空判。
    const mut20 = (patch) => {
      store['ysy.xprobe.badge'] = true;
      const tt = mk20();
      const ss = runSource(patch(src), tt.root, '/jasonmysee', 'https://x.com/jasonmysee');
      geo20(tt);
      return { tt: tt, ss: ss };
    };
    const SQ = "'";   // 下面那截清场选择器里单引号双引号都有，拼出来比转义好读
    // 抠的是 `, .` + `' + BENCH_BADGE_CLS + '` + `, [data-xprobe="bench"]`：中间那截拼串连着两块字面量的接缝一起走，
    // 只留下最末尾那个 ' —— 它正好把 `', [data-xprobe="blk"]` 收住，语法仍然成立（多带一个 ' 就咬成断串了）。
    const SWEEP_MUT = ', .' + SQ + ' + BENCH_BADGE_CLS + ' + SQ + ', [data-xprobe="bench"]';
    eq('正向对照：抠掉 renderBlocksInner 末尾那句 benchBadgeScan() ⇒ 主页一颗都不出（这一颗真的挂在徽标那一趟的尾部，不是另开一趟扫描）',
      (() => {
        const noScan = src.replace(BENCH_SCAN_MUT, '');
        ok('正向对照的前提：这一行真能从源码里抠掉（抠不掉后面那条对照就是空断言）',
          noScan !== src && !noScan.includes('benchBadgeScan();'), [src.length, noScan.length]);
        const m = mut20(() => noScan);
        m.ss.__xprobe.renderBlocks(true);
        return [stars20(m.tt).length, m.ss.__xprobe.perfLine().benchBadge];
      })(), [0, 0]);
    eq('正向对照：把徽标清场选择器里那两截（.ysy-xprobe-benchb / data-xprobe="bench"）抠掉 ⇒ 拨回「关」这颗仍留在页面上（清场真的认它）',
      (() => {
        const m = mut20((x) => x.replace(SWEEP_MUT, ''));
        m.ss.__xprobe.renderBlocks(true);
        const n = stars20(m.tt).length;
        m.ss.__xprobe.setBadgeOn(false);
        return [n, stars20(m.tt).length];
      })(), [1, 1]);
    eq('正向对照：把 badgeGaps 里「自家记号不算墙」那笔改成只认 blk（不认 bench）⇒ 老位置永远「站不住」= 每一趟都摘了重摆（用户说的「来回跑」）',
      (() => {
        const m = mut20((x) => x.replace("if (mk === 'blk' || mk === 'bench') continue;", "if (mk === 'blk') continue;"));
        m.ss.__xprobe.renderBlocks(true);
        const first = stars20(m.tt)[0];
        paint20(first);
        first.style.top = '7px';        // 埋一笔：真粘住的话这一趟不该碰它
        m.ss.__xprobe.renderBlocks(true);
        // 认不出自家那颗是「墙」⇒ badgeInGap 说老位置被占 ⇒ 走「摘了重摆」：换的是节点，重写的是坐标
        // （落点仍是 158px——重摆前老那颗已经先摘掉了，所以这一笔咬的是「顶上的坐标被重新写过」，不是左缘）
        return [first === stars20(m.tt)[0], first.parentNode === null, first.style.top, stars20(m.tt)[0].style.top];
      })(), [false, true, '7px', '20px']);
    eq('正向对照：把 inProbe 认自家记号那两笔（data-xprobe / BENCH_BADGE_CLS）抠掉 ⇒ 读名字把自家那颗星读回去，名字文本就成了「活力男…☆」',
      (() => {
        const m = mut20((x) => x.replace("n.getAttribute('data-xprobe') ||", "n.getAttribute('data-xprobe-zz') ||")
          .replace('c === BLK_CLS || c === BENCH_BADGE_CLS', "c === 'zz-none'"));
        m.ss.__xprobe.renderBlocks(true);
        // displayName 那一路被「@handle 以后全砍」顺手挡住了，看不出漏；真正会把星带走的是原始文本那两格：
        // nativeText(box)（benchProfileRow 读名字走的就是它）与快照里的 displayNameRaw（落台账/落库的名字来源）
        return [/☆|★/.test(m.ss.__xprobe.nativeText(m.tt.box)),
          /☆|★/.test(String(m.ss.__xprobe.snapshot().identity.displayNameRaw || ''))];
      })(), [true, true]);

    // ---- 跨层针脚：这一颗只走徽标那一趟、只读 DOM、面板那行说得清 ----
    const core20 = src.replace(/^\s*\/\/.*$/gm, '');
    const seg20 = core20.slice(core20.indexOf('function benchProfileRow'), core20.indexOf('const BENCH_W = 300;'));
    ok('红线针脚：这一段里没有滚动、没有合成事件、不拦冒泡、不对 X 发请求（读 DOM + 写自家台账，仅此）',
      seg20.length > 800 && !/scrollIntoView|dispatchEvent|stopPropagation|preventDefault|GM_xmlhttpRequest|fetch\(/.test(seg20), seg20.length);
    ok('RL-16 那道闸排在整趟扫描之前，这一颗跟着它；而它只在 renderBlocksInner 尾部（与徽标同一趟、同一个限流）',
      /function renderBlocks\(force\) \{[\s\S]{0,120}if \(!badgeGet\(\)\)/.test(core20)
      && core20.indexOf('benchBadgeScan();') > core20.indexOf('function renderBlocksInner')
      && !/setInterval\([^)]*benchBadgeScan/.test(core20), '');
    ok('面板那行多这一格「主页星」，没出时把原因一起写出来（闸关着 / 没找到那一行 / 挂不住 / 放不下四种都读得到）',
      /'\/主页星' \+ \(p\.benchBadge \|\| 0\) \+ \(p\.benchBadgeNo \? '（' \+ p\.benchBadgeWhy \+ '）' : ''\)/.test(rd('ui/view.js'))
      && /没找到昵称那一行/.test(rd('ui/view.js')) && /闸关着/.test(rd('ui/view.js')),
      (rd('ui/view.js').match(/主页星[^\n]*/) || [''])[0]);

    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.users'];
    delete store['ysy.xprobe.badge'];
  }

  console.log('\n[21] v0.9.3 标杆帖子：页头「☆标此帖」+ 右缘「标帖」窗口 + 榜单行尾那颗（用户点名「给某个帖子也可以添加到标杆帖子…右下角分别是标杆账号、标杆帖子，点击账号打开账号的窗口，点击帖子打开帖子的窗口」）');
  // 这段是异步的（里面要等 tick 让台账/查询的回调落地）⇒ 把 promise 递给结尾的 else 分支，
  // 让「合计/退出」排在它跑完之后——不然 process.exit 会在定时器触发前把这段掐死（第一跑就吃过的亏）。
  const sect21Done = (async () => {
    await tick();
    store['ysy.xprobe.badge'] = true;
    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.benchPost'];
    delete store['ysy.xprobe.benchPostSort'];
    delete store['ysy.xprobe.users'];
    const TID = '2114909172362031553';   // 用户发来的那条真帖（/susan16808/status/2114903455361888482 的同页兄弟，形状一样）
    const led21 = () => { const v = store['ysy.xprobe.benchPost'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };
    // 真机形状（转储 2026-10-27_175912-tweet-FELIXTANGcqjb 的 tree.txt）：页头那一行里 app-bar-back 与 h2
    // **不是兄弟**（tree 里两者印出的「跳过N层」差着一层）⇒ 桩就按这个形状搭：back 外面再包一层、
    // h2 住在旁边的 titleBox 里 —— 考「从返回钮往上爬、第一个里面坐着 h2 的祖先」这条真路径，不是 querySelector 一把梭。
    // ⚠ app-bar-back 个人主页头部也有（那边 h2 是人名）⇒ 桩也给个人主页配一份同款头，考 tabName 闸。
    const mk21 = (opt) => {
      const o = opt || {};
      const back = h('button', { 'data-testid': 'app-bar-back', 'aria-label': '返回' }, []);
      const backWrap = h('div', {}, [back]);
      const h2 = h('h2', { role: 'heading' }, [T(o.h2Text || '帖子')]);
      const titleBox = h('div', {}, [h2]);
      const bar = h('div', { 'aria-label': '主页时间线' }, o.noH2 ? [backWrap] : [backWrap, titleBox]);
      const root = o.noBar ? h('div', {}, [h('span', {}, [T('这一页没有头部')])]) : h('div', {}, [bar]);
      return { root: root, bar: bar, h2: h2, back: back };
    };
    const geo21 = (t) => {
      t.bar.__geo = { left: 300, top: 100, width: 540, height: 53 };
      t.h2.__geo = { left: 400, top: 110, width: 60, height: 28 };
    };
    // 桩不会自己排版：这颗是 render 之后才挂的 ⇒ 想测「粘住」就按浏览器会画在哪补一笔矩形（与 [20] 同一手艺）
    const paint21 = (n) => {
      const hp = n.parentNode.__geo || { left: 0, top: 0, width: 0, height: 0 };
      n.__geo = { left: hp.left + Number(String(n.style.left || '0').replace('px', '')), top: 110, width: 70, height: 20 };
    };
    const stars21 = (t) => t.root.querySelectorAll('[data-xprobe="bench"][data-bk="post"]');
    const scr21 = (t) => t.root.descendants().reduce((a, n) => a + (n.__scrolls || 0), 0);
    store['ysy.xprobe.posts'] = {
      [TID]: { tweetId: TID, handle: 'susan16808', text: '标杆帖子这一条的正文', timeISO: '2026-10-26T09:30:00.000Z',
        seenAt: 1, n: 2, view: 1234, reply: 12, like: 34 },
    };

    const t21 = mk21();
    const s21 = run(t21.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
    geo21(t21);
    s21.__xprobe.renderBlocks(true);
    const st21 = stars21(t21)[0];
    eq('帖子详情页页头「帖子」标题右边出一颗（用户圈的那块空白），宿主是页头那一行、不是 X 的返回钮',
      [stars21(t21).length, st21.parentNode === t21.bar, st21.getAttribute('data-bk'),
        s21.__xprobe.perfLine().benchPBadge, s21.__xprobe.perfLine().benchPBadgeWhy], [1, true, 'post', 1, '']);
    eq('字面与档位：整字面「☆标此帖」+ 灰；data-h 认 URL 里的 tweet_id，作者从本机 posts 台账补（页头那一行没有作者）',
      [st21.children[0].textContent, st21.children[0].style.color, st21.getAttribute('data-h'), st21.getAttribute('data-n'), st21.getAttribute('data-l')],
      ['☆标此帖', '#8b98a5', TID, 'susan16808', 'full']);
    ok('title 是这颗的说明书：说清标的是**这条帖**、落的是 bench_posts、与「标杆」那本按人的账是两本',
      /记进标杆帖子/.test(st21.children[0].title) && /bench_posts/.test(st21.children[0].title)
      && /两本/.test(st21.children[0].title), st21.children[0].title);
    eq('落点贴着 h2 右缘 + 4（用户圈的位置），纵向跟标题行中线；不占位（absolute + 不改宿主宽高）',
      [Number(String(st21.style.left).replace('px', '')), st21.style.top, st21.style.position,
        t21.bar.style.position],
      [t21.h2.__geo.left + t21.h2.__geo.width + 4 - t21.bar.__geo.left,
        Math.round(t21.h2.__geo.top + t21.h2.__geo.height / 2 - t21.bar.__geo.top) + 'px', 'absolute', 'relative']);
    ok('同一趟扫描里主页那颗的账如实归零（帖子页本来就不该有它），页头这颗与主页那颗是同一道闸、同一趟、各记各的账',
      s21.__xprobe.perfLine().benchBadge === 0 && s21.__xprobe.perfLine().benchBadgeWhy === ''
      && s21.__xprobe.perfLine().badgeScans === s21.__xprobe.perfLine().badgeScans,
      [s21.__xprobe.perfLine().benchBadge, s21.__xprobe.perfLine().benchBadgeWhy]);

    const scr0 = scr21(t21);
    st21.children[0].fire('click');
    eq('点 ☆ ⇒ 只写我方台账（GM benchPost 多出这条）、就地翻「★已标帖」+ 绿；这一路不滚页面、不多缝第二颗',
      [Object.keys(led21()), st21.children[0].textContent, st21.children[0].style.color,
        stars21(t21).length, scr21(t21)], [[TID], '★已标帖', '#4ec98a', 1, scr0]);
    s21.__xprobe.flush();
    ok('同一下也发 kind=benchpost（落库 bench_posts 那条腿：on=1、id、作者、正文快照都齐）',
      postedRecords(s21).some((r) => r.kind === 'benchpost' && r.data.id === TID && r.data.on === 1
        && r.data.author === 'susan16808' && /标杆帖子这一条的正文/.test(r.data.text)),
      postedRecords(s21).filter((r) => r.kind === 'benchpost').map((r) => r.data));
    ok('与「标此人」确认是两本账：账号台账空着、帖子台账有一条',
      s21.__xprobe.benchCount() === 0 && s21.__xprobe.benchPCount() === 1 && !s21.__xprobe.isBench('susan16808')
      && s21.__xprobe.isBenchP(TID), [s21.__xprobe.benchCount(), s21.__xprobe.benchPCount()]);
    st21.children[0].fire('click');
    eq('再点一下 = 移出：台账清空、字面退回「☆标此帖」（两态都在这一颗上）',
      [Object.keys(led21()).length, st21.children[0].textContent, st21.getAttribute('data-f')], [0, '☆标此帖', '0']);

    // ---- 粘住与翻色（与主页那颗同一条通用摆法，这里只验它对第二颗同样咬）----
    s21.__xprobe.benchPToggle(TID, 'susan16808', '标杆帖子这一条的正文');
    paint21(st21);
    st21.style.top = '9px';                            // 故意写歪一笔：真粘住就不该被改回 24px
    s21.__xprobe.renderBlocks(true);
    eq('下一趟：同一颗、同一宿主、坐标没被重写（粘住），状态字面按台账翻成「★已标帖」（该改的才改）',
      [stars21(t21).length === 1 && stars21(t21)[0] === st21, st21.style.top, st21.children[0].textContent,
        s21.__xprobe.perfLine().benchPBadge], [true, '9px', '★已标帖', 1]);
    s21.__xprobe.benchPToggle(TID, 'susan16808', '');   // 收摊：台账清空，别把账带进下面窗口的断言

    // ---- 闸与靶子的边界（RL-16 的「认错页不出」与「X 改版要说清」）----
    const t21p = mk21({ h2Text: '乙' });
    const s21p = run(t21p.root, '/bob', 'https://x.com/bob');
    geo21(t21p);
    s21p.__xprobe.renderBlocks(true);
    eq('个人主页头部同样有 app-bar-back + h2（真机实锤）⇒ tabName 闸挡住：一颗都不缝，账归零而不是装没看见',
      [stars21(t21p).length, s21p.__xprobe.perfLine().benchPBadge, s21p.__xprobe.perfLine().benchPBadgeWhy], [0, 0, '']);
    const t21n = mk21({ noBar: true });
    const s21n = run(t21n.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
    s21n.__xprobe.renderBlocks(true);
    eq('页头结构认不出 ⇒ 如实说「没找到页头那一行」（RL-11 不许静默）',
      [stars21(t21n).length, s21n.__xprobe.perfLine().benchPBadgeNo, s21n.__xprobe.perfLine().benchPBadgeWhy],
      [0, 1, '这一页没找到页头那一行（X 改版了？）']);
    const t21h = mk21({ noH2: true });
    const s21h = run(t21h.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
    s21h.__xprobe.renderBlocks(true);
    eq('返回钮在、h2 不在（爬完也没找到）⇒ 同一句「没找到页头那一行」，不拿 document 上别的 h2 冒充',
      [stars21(t21h).length, s21h.__xprobe.perfLine().benchPBadgeWhy], [0, '这一页没找到页头那一行（X 改版了？）']);
    const t21t = mk21();
    t21t.bar.parentNode.appendChild(h('article', {}, [h('div', { 'data-testid': 'tweetText' }, [T('页面现读的正文')])]));
    store['ysy.xprobe.posts'] = { [TID]: { tweetId: TID, handle: 'susan16808', text: '', timeISO: '' } };
    const s21t = run(t21t.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
    geo21(t21t);
    s21t.__xprobe.renderBlocks(true);
    stars21(t21t)[0].children[0].fire('click');
    s21t.__xprobe.flush();
    ok('台账没正文时快照退到页面现读（只读第一条 article 的 tweetText）：落库那条腿的 text 不空也不编',
      postedRecords(s21t).some((r) => r.kind === 'benchpost' && r.data.id === TID && r.data.text === '页面现读的正文'),
      postedRecords(s21t).filter((r) => r.kind === 'benchpost').map((r) => r.data));
    delete store['ysy.xprobe.posts'];

    // ---- 右缘「标帖」窗口：一条 dbq、库优先台账兜底、缺数「—」、打开即按上次那根轴 ----
    store['ysy.xprobe.benchPost'] = { [TID]: { at: '2026-10-27T04:00:00.000Z', a: 'susan16808', t: '台账里的正文', tags: '' } };
    const s21w = run(t21.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
    geo21(t21);
    s21w.__dbq = [];
    s21w.chrome.runtime.sendMessage = (m, cb) => {
      if (m && m.t === 'dbq') { s21w.__dbq.push(m); if (cb) cb({ ok: true, rows: [
        { tweet_id: TID, author: 'susan16808', marked_text: '库里的旧正文', tags: '', marked_at: '2026-10-27T03:00:00.000Z',
          view: 2000, reply: 20, like: 40, eng: 66, points: 3, view_per_h: 12.5,
          time_datetime: '2026-10-26T09:30:00.000Z', first_at: '2026-10-26T09:31:00.000Z', last_at: '2026-10-27T03:05:00.000Z' },
        { tweet_id: '999888777666', author: 'carl', marked_text: '刚标还没数', tags: '投资', marked_at: '2026-10-27T04:00:00.000Z',
          view: null, reply: null, like: null, eng: null, points: null, view_per_h: null,
          time_datetime: null, first_at: null, last_at: null },
      ] }); return; }
      s21w.__rtMsgs.push(m); if (cb) cb(undefined);
    };
    s21w.__xprobe.toggleBenchP();
    await tick();
    const W21 = () => IDS['ysy-xprobe-ext-benchp'];
    eq('打开 = 问库 bench_post_rows（白名单名 + limit，RL-9 名单只长这一条），且与账号窗口互斥（同一列右缘不叠）',
      [!!W21(), s21w.__dbq[s21w.__dbq.length - 1], s21w.__xprobe.__bench().open, s21w.__xprobe.__benchP().open],
      [true, { t: 'dbq', q: 'bench_post_rows', limit: 200 }, false, true]);
    const wRows = () => W21().children.filter((c) => c.children[0] && /曝 /.test(c.children[c.children.length - 2] && c.children[c.children.length - 2].textContent || '') || (c.children.length >= 2 && /曝 /.test(c.children[1] && c.children[1].textContent || '')));
    const row21 = (i) => W21().children.filter((c) => c.children.length >= 2 && /^曝 |^—/.test('') === false && c.children[1] && /^曝 /.test(c.children[1].textContent))[i];
    // 行结构：正文在前、数字第二行（v0.9.2 的读法），行尾 @作者 #id + 移出/标为
    const pRows = () => W21().children.filter((c) => c.children[1] && /^曝 /.test(String(c.children[1].textContent)));
    eq('库优先不盖台账：曝 2000（库）、正文用台账那份（我刚按下的那笔）；刚标没数的帖子也在名单里、缺的格写「—」不编',
      [pRows().length, /台账里的正文/.test(pRows()[0].children[0].textContent), /曝 2000/.test(pRows()[0].children[1].textContent),
        /曝 —/.test(pRows()[1].children[1].textContent), /@carl/.test(pRows()[1].children[2].textContent)],
      [2, true, true, true, true]);
    ok('行不挂点击（不滚页面、不导航、不请求 X：条目可能根本不在当前画面上）',
      pRows()[0].children[1].title !== undefined && !(pRows()[0].listeners || []).length,
      pRows()[0].children[1].title);
    eq('默认轴=曝光降序（有数的在前）；换「评论」是客户端重排：不再问库（RL-9 的账没涨）',
      [pRows()[0].children[1].textContent.indexOf('曝 2000') === 0, (() => {
        const n0 = s21w.__dbq.length;
        const btnR = W21().querySelectorAll('button').find((b) => b.textContent === '评论');
        btnR.fire('click');
        return s21w.__dbq.length - n0;
      })()], [true, 0]);
    ok('换轴立即生效：carl 那条缺评论数垫底（「没数」不许冒充「很低」）',
      pRows().length === 2 && !/@carl/.test(pRows()[0].children[2].textContent)
      && /@carl/.test(pRows()[pRows().length - 1].children[2].textContent),
      pRows().map((r) => r.children[2].textContent));
    ok('窗口脚注把口径说全（不滚/不导航、库优先缺数「—」、分类下一轮）',
      /不滚页面|不导航/.test(W21().children[W21().children.length - 1].textContent)
      && /分类下一轮/.test(W21().children[W21().children.length - 1].textContent),
      W21().children[W21().children.length - 1].textContent);
    const accBtn = W21().querySelectorAll('button').find((b) => b.textContent === '账号');
    accBtn.fire('click');
    eq('点「账号」= 这张收起、按人的那张打开（用户口径「点击账号打开账号的窗口，点击帖子打开帖子的窗口」）',
      [!W21(), IDS['ysy-xprobe-ext-bench'] ? IDS['ysy-xprobe-ext-bench'].children[0].children[0].textContent.indexOf('标杆') : -1,
        s21w.__xprobe.__bench().open, s21w.__xprobe.__benchP().open], [true, 0, true, false]);
    s21w.__xprobe.toggleBenchP();
    await tick();
    eq('再切回来同一颗「标帖」钮也行：两张互斥、各自的行与账都不丢',
      [!!W21(), IDS['ysy-xprobe-ext-bench'] || null, s21w.__xprobe.__bench().open, s21w.__xprobe.__benchP().open], [true, null, false, true]);
    s21w.__xprobe.toggleBenchP();

    eq('轴记在 GM（benchPostSort）：下次打开自动按它排；脏值只认白名单，认不出退回「曝光」',
      (() => {
        const sA = (() => { store['ysy.xprobe.benchPostSort'] = 'reply'; const sb = run(t21.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID); sb.__xprobe.__benchP; return sb; })();
        const r1 = sA.__xprobe.__benchP().sort;
        store['ysy.xprobe.benchPostSort'] = 'bogus';
        const sB = run(t21.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
        const r2 = sB.__xprobe.__benchP().sort;
        delete store['ysy.xprobe.benchPostSort'];
        return [r1, r2];
      })(), ['reply', 'view']);

    // ---- 榜单行尾那颗「标帖」（第二条腿：页头那颗只标当前详情页的主帖，这颗标本页榜单里任何一条）----
    store['ysy.xprobe.benchPost'] = {};
    const s21c = run(h('div', {}, [h('span', {}, [T('占位')])]), '/home', 'https://x.com/home');
    const btnC = s21c.__xprobe.benchPCardBtn('888777666555', 'carol', '正文八');
    btnC.fire('click');
    s21c.__xprobe.flush();
    eq('点「标帖」⇒ 台账多出这条 + kind=benchpost on=1 带作者与正文；同一颗再点 = 移出',
      [Object.keys(led21()).join(','), postedRecords(s21c).some((r) => r.kind === 'benchpost' && r.data.id === '888777666555' && r.data.on === 1 && r.data.author === 'carol')],
      ['888777666555', true]);
    const btnC2 = s21c.__xprobe.benchPCardBtn('888777666555', 'carol', '正文八');
    eq('已标的那条行尾翻成「已标帖」+ 绿边（和页头那颗同一对字面）',
      [btnC2.textContent, btnC2.style.border], ['已标帖', '1px solid #2f5f45']);
    btnC2.fire('click');
    eq('再点 = 移出；认不出 id 的行（没有 tweet_id）点什么都不写、title 说清「不替你猜」',
      [Object.keys(led21()).length, (() => {
        const b = s21c.__xprobe.benchPCardBtn('abc', '', '');
        b.fire('click');
        return Object.keys(led21()).length + '|' + /不替你猜/.test(b.title);
      })()], [0, '0|true']);

    // ---- 正向对照（变异）：判据真的咬那几行 ----
    // ⚠ 换个新桩再跑：老桩里上一趟留下的胶囊会让「一颗都不出」这条平白咬空（自检的桩不重建 DOM）
    const t21m = mk21(); geo21(t21m);
    const noScan21 = src.replace(BENCH_SCAN_MUT, '');
    ok('正向对照的前提：尾部那一句真能从源码里抠掉（抠不掉后面那条对照就是空断言）',
      noScan21 !== src && !noScan21.includes('benchBadgeScan();'), [src.length, noScan21.length]);
    const m21a = runSource(noScan21,
      t21m.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
    m21a.__xprobe.renderBlocks(true);
    eq('正向对照：抠掉 renderBlocksInner 尾部那一句 ⇒ 页头这颗也不出（与主页那颗同一趟扫描，没另开一条线）',
      [stars21(t21m).length, m21a.__xprobe.perfLine().benchPBadge], [0, 0]);
    const m21b = runSource(src.replace('      up = up.parentNode;', '      up = null;'),
      t21.root, '/susan16808/status/' + TID, 'https://x.com/susan16808/status/' + TID);
    m21b.__xprobe.renderBlocks(true);
    eq('正向对照：把「往上爬找 h2」抠掉（爬一层就断）⇒ 真机那个「back 与 h2 差着层」的页头就找不到（这条爬是真路径）',
      [t21.root.querySelectorAll('[data-xprobe="bench"][data-bk="post"]').length,
        m21b.__xprobe.perfLine().benchPBadgeWhy], [0, '这一页没找到页头那一行（X 改版了？）']);
    // ⚠ replace 只换第一处：`logRec('benchpost'` 先撞上的是 4179 行注释里的那处 ⇒ 必须带上调用形状，
    // 咬的才是 4211 那句真调用（第一跑就吃过这个亏：注释被改了名、真调用原样发 kind=benchpost）
    const m21c = runSource(src.replace("logRec('benchpost', { id: k", "logRec('benchpost-mute', { id: k"),
      h('div', {}, [h('span', {}, [T('占位')])]), '/home', 'https://x.com/home');
    m21c.__xprobe.benchPCardBtn('777666555444', 'carol', '正文').fire('click');
    m21c.__xprobe.flush();
    eq('正向对照：把「落库那条腿」的 kind 改名 ⇒ flush 里再没有 kind=benchpost（记录真的从这一句发出去，不是面板自己拼的）',
      postedRecords(m21c).some((r) => r.kind === 'benchpost'), false);

    // ---- 红线与跨层针脚 ----
    const core21 = src.replace(/^\s*\/\/.*$/gm, '');
    const seg21 = core21.slice(core21.indexOf('function benchPostRow'), core21.indexOf('const BENCHP_W = 320;'));
    ok('红线针脚：页头那颗 + 台账这一段里没有滚动、没有合成事件、不拦冒泡、不对 X 发请求（读 DOM + 写自家台账，仅此）',
      seg21.length > 800 && !/scrollIntoView|dispatchEvent|stopPropagation|preventDefault|GM_xmlhttpRequest|fetch\(/.test(seg21), seg21.length);
    ok('一趟一枪没被第二颗打破：整段只有一次 [data-xprobe="bench"] 整文档扫描，两颗各认各的（data-bk 分家）',
      (core21.match(/querySelectorAll\('\[data-xprobe="bench"\]'\)/g) || []).length === 1
      && /benchPillStep\(curProf/.test(core21) && /benchPillStep\(curPost/.test(core21), '');
    ok('两颗胶囊共用同一摆法（benchPillStep 通用、账号那颗走它、帖子这颗也走它），粘住/重摆的判据只有一份',
      /function benchPillStep\(cur, t, kind, acc\)/.test(core21)
      && core21.indexOf('benchPillStep(curProf') < core21.indexOf('benchPillStep(curPost'), '');
    const db21 = rd('../xprobe_db.py'), sink21 = rd('../log-sink.py'), sw21 = rd('background/sw.js');
    // Python 里 SQL 是跨行串接（"...,"\n  "..."）⇒ 直接抓抓到的只有第一段，先把串接缝拼平再抽
    const dbFlat = db21.replace(/"\s*\n\s*"/g, '');
    const qBPr = (dbFlat.match(/"bench_post_rows": "([^"]*)"/) || ['', ''])[1];
    const qBPs = (dbFlat.match(/"bench_posts": "([^"]*)"/) || ['', ''])[1];
    ok('数据层四条都在库里（不是面板拼 SQL）：bench_posts 表 + bench_posts_now 视图（state=1 判现在）+ 两条白名单查询',
      /CREATE TABLE IF NOT EXISTS bench_posts\(/.test(db21) && /CREATE VIEW IF NOT EXISTS bench_posts_now AS/.test(db21)
      && /WHERE rn = 1 AND state = 1/.test(db21) && qBPr.indexOf('bench_posts_now b LEFT JOIN post_growth') > 0
      && /ORDER BY CASE WHEN g\.view IS NULL THEN 1 ELSE 0 END, g\.view DESC/.test(qBPr), '');
    eq('RL-9 没被顶开：两条新查询各只有一个 ?（limit），一个新参数量纲都没加',
      [qBPr.split('?').length - 1, qBPs.split('?').length - 1], [1, 1]);
    ok('台账→库的落点在 _simple 的 kind=benchpost 分支（id 只认数字、正文纯截断 200，与库里 _txt 同一字面）',
      /kind == "benchpost"/.test(db21) && /re\.sub\(r"\\D", "", str\(d\.get\("id"\) or ""\)\)\[:25\]/.test(db21)
      && /_txt\(d\.get\("text"\), 200\)/.test(db21), '');
    ok('sink 认这条记录（v0.9.3 起认 kind=benchpost；v0.9.7 抬到 sink-18：/db 多认 after 游标，标杆同步走这条腿）',
      /SINK_VER = "sink-18"/.test(sink21) && /kind == "benchpost"/.test(sink21) && /标为标杆帖/.test(sink21), '');
    ok('SW 不用为新查询加参数（q+limit 原样透传），core 里没有 SQL 字样、只认白名单查询名',
      /bench_post_rows/.test(core21) && !/SELECT /.test(core21) && /127\.0\.0\.1:8765\/db/.test(sw21), '');
    ok('面板「性能账」多一格「页头星」，没出时把原因一起写出来（与「主页星」同款式）',
      /'\/页头星' \+ \(p\.benchPBadge \|\| 0\) \+ \(p\.benchPBadgeNo \? '（' \+ p\.benchPBadgeWhy \+ '）' : ''\)/.test(rd('ui/view.js'))
      && /没找到页头那一行/.test(rd('ui/view.js')), '');

    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.benchPost'];
    delete store['ysy.xprobe.benchPostSort'];
    delete store['ysy.xprobe.posts'];
    delete store['ysy.xprobe.users'];
    delete store['ysy.xprobe.badge'];
  })();
  await sect21Done;   // 段 [21] 是后挂的异步段：等它跑完再让 layersDone 收摊，不然结尾的 process.exit 会在定时器触发前把它掐死

  // ---- [22] v0.9.4 晚水合回显（真机 2026-10-27：eater188888/2114978598516146582 拉黑后刷新不回显）----
  // 真机上 GM_getValue 读的是 host-shim 的内存缓存，要等 chrome.storage.local 异步水合才有货；
  // core 顶层读账那一次必然扑空、且是全脚本唯一一次 ⇒ 刷新后内存永远是空账。自检桩的 GM 是同步
  // 对象，顶层一读就有货，这条缝照不进 ⇒ 手工重演竞态：先在空账上起跑（水合未到），再把账放进
  // store（水合到了）—— 回显必须跟上来。旧代码这一段全红，这正是用户踩的那一下。
  console.log('\n[22] v0.9.4 晚水合回显：判账读穿（拉黑/标杆/标杆帖子三本账同一病根一起治）');
  {
    delete store['ysy.xprobe.blocked'];
    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.benchPost'];
    store['ysy.xprobe.badge'] = true;
    const fx22 = () => h('div', {}, [
      h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/demo_own' }, [T('甲 @demo_own')])]),
    ]);
    const led22 = () => { const v = store['ysy.xprobe.blocked'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };

    // ① 页面徽标：起跑时账还没到（顶层读扑空），水合到账后 renderBlocks 必须按账回显
    const t22a = fx22();
    const sb22 = run(t22a, '/demo_own', 'https://x.com/demo_own');
    store['ysy.xprobe.blocked'] = { demo_own: { at: '2026-10-27T09:21:48.407Z', n: '示例笔记' } };
    sb22.__xprobe.renderBlocks(true);
    eq('晚水合后页面徽标回显红「已拉黑」（起跑时读空账不算数，判账要读穿）',
      t22a.querySelectorAll('[data-xprobe="blk"]')[0].children[0].textContent, '已拉黑');

    // ② 同一套读穿判账搬到名单：v0.11.3 把行尾两颗拿掉了 ⇒ 回显改住在「显示名转红 + 悬停 title 点名」这一行上，
    //    标杆那本的回显在右缘「标杆」窗口那一侧（同一个 isBench，也走读穿）。
    const sb22f = run(profile, '/demo_own', 'https://x.com/demo_own');
    store['ysy.xprobe.blocked'] = { demo_own: { at: '2026-10-27T09:21:48.407Z', n: '示例笔记' } };
    store['ysy.xprobe.bench'] = { demo_own: { at: '2026-10-27T09:00:00.000Z', n: '示例笔记', tags: '' } };
    sb22f.__xprobe.flistBtn().fire('click');
    const fl22 = IDS['ysy-xprobe-ext-flist'];
    const row22 = fl22.children.find((c) => c.children && /^@demo_own/.test(String(c.title || '')));
    eq('晚水合后名单也回显：这一行显示名转红 + 悬停 title 点名「已拉黑」（blocked 读穿，起跑读空不算数）',
      [!!row22, row22.children[1].style.color, /已拉黑/.test(String(row22.title || ''))], [true, '#e06c60', true]);
    ok('bench 那本同一次读穿：isBench 认得 demo_own（列删了不等于账丢了）',
      sb22f.__xprobe.isBench('demo_own') === true, sb22f.__xprobe.benchCount());
    eq('行里零按钮（写账入口退回页面那两颗；名单这一行不藏任何能改账的东西）', row22.querySelectorAll('button').length, 0);
    IDS['ysy-xprobe-ext-flist'].querySelectorAll('button').find((b) => b.textContent === '×').fire('click');

    // ③ 整键覆盖前先并账：内存是空账上长出来的，不并就把晚水合进来的别人整本抹掉
    delete store['ysy.xprobe.blocked'];   // ①② 落的账清场：这一腿起跑时内存必须是空账（真机每次刷新都如此）
    const t22m = h('div', {}, [
      tweetCell('elder_a', '9201', '2026-10-27T01:00:00.000Z', '甲帖'),
      tweetCell('new_b', '9202', '2026-10-27T02:00:00.000Z', '乙帖'),
    ]);
    const sb22m = run(t22m, '/home', 'https://x.com/home');
    store['ysy.xprobe.blocked'] = { elder_a: { at: '2026-10-26T00:00:00.000Z', n: '老账' } };   // 别的会话落好的账
    sb22m.__xprobe.renderBlocks(true);
    eq('并账前先各自回显：elder_a「已拉黑」、new_b「拉黑」（同一页两条账各认各的）',
      [t22m.querySelectorAll('[data-xprobe="blk"]').find((n) => n.getAttribute('data-h') === 'elder_a').children[0].textContent,
        t22m.querySelectorAll('[data-xprobe="blk"]').find((n) => n.getAttribute('data-h') === 'new_b').children[0].textContent],
      ['已拉黑', '拉黑']);
    t22m.querySelectorAll('[data-xprobe="blk"]').find((n) => n.getAttribute('data-h') === 'new_b').children[0].fire('click');
    eq('拉黑第一个人不抹别的会话标的账（整键覆盖前先并一次）：elder_a 与 new_b 都在名单里',
      Object.keys(led22()).sort(), ['elder_a', 'new_b']);

    // ④ 标杆帖子那本同样读穿：页头胶囊按台账回显「★已标帖」，点了是「移出」而不是「再标一遍」
    const TID22 = '2114978598516146582';
    const back22 = h('button', { 'data-testid': 'app-bar-back', 'aria-label': '返回' }, []);
    const h22 = h('h2', { role: 'heading' }, [T('帖子')]);
    const bar22 = h('div', { 'aria-label': '主页时间线' }, [h('div', {}, [back22]), h('div', {}, [h22])]);
    const t22p = h('div', {}, [bar22]);
    const s22 = run(t22p, '/eater188888/status/' + TID22, 'https://x.com/eater188888/status/' + TID22);
    bar22.__geo = { left: 300, top: 100, width: 540, height: 53 };
    h22.__geo = { left: 400, top: 110, width: 60, height: 28 };
    store['ysy.xprobe.benchPost'] = { [TID22]: { at: '2026-10-27T09:00:00.000Z', a: 'eater188888', t: '正文', tags: '' } };
    s22.__xprobe.renderBlocks(true);
    const pill22 = t22p.querySelectorAll('[data-xprobe="bench"][data-bk="post"]')[0];
    eq('晚水合后页头胶囊回显「★已标帖」（标杆帖子那本同病同治）',
      pill22.children[0].textContent, '★已标帖');
    pill22.children[0].fire('click');
    s22.__xprobe.flush();
    const ledP22 = () => { const v = store['ysy.xprobe.benchPost'] || {}; return typeof v === 'string' ? JSON.parse(v) : v; };
    eq('点「★已标帖」= 移出（开关按读穿后的账判，不把已标的再标一遍）：台账没了这条、记录 on=0',
      [Object.keys(ledP22()).length,
        postedRecords(s22).some((r) => r.kind === 'benchpost' && r.data.id === TID22 && r.data.on === 0)],
      [0, true]);

    // ⑤ 正向对照：把「读穿」抠掉（判账直摸旧内存）⇒ ①那条必红，证明咬的确实是这一行
    delete store['ysy.xprobe.blocked'];   // 起跑内存必须是空账：③落进 store 的账不清掉，旧代码也能「碰巧」回显
    const t22x = fx22();
    const m22 = runSource(src.replace(
      "function isBlocked(h) { return !!blockFresh()[String(h || '').toLowerCase()]; }",
      "function isBlocked(h) { return !!blocked[String(h || '').toLowerCase()]; }",
    ), t22x, '/demo_own', 'https://x.com/demo_own');
    store['ysy.xprobe.blocked'] = { demo_own: { at: '2026-10-27T09:21:48.407Z', n: '示例笔记' } };
    m22.__xprobe.renderBlocks(true);
    eq('正向对照：判账抠回「只摸内存」⇒ 徽标退回灰「拉黑」（晚水合的缝重新裂开）',
      t22x.querySelectorAll('[data-xprobe="blk"]')[0].children[0].textContent, '拉黑');

    delete store['ysy.xprobe.blocked'];
    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.benchPost'];
    delete store['ysy.xprobe.badge'];
  }

  // ---- [23] 玻璃柱轨 + 环形读秒 + 设计令牌 ----
  // v0.9.5 起右缘轨是玻璃柱 + 等大圆钮 + 竖排双字 + 角标；v0.11.15 方案 A 改为细轨圆角 + 等大圆角方钮
  // + 单字横排 + data-tip hover 全称（向左浮出、轨道恒宽）。守卫灯环形读秒与面板 serif 标题未动。
  // 行为针脚（点击账本/三态优先级/环形读秒）一根没动，动的是画法 ⇒ 这一段钉的全是「画法本身」，
  // 外加一条变异对照证明 hover 全称判据咬的是 mk 里写 data-tip 那一行。
  console.log('\n[23] 玻璃柱轨 + 环形读秒 + 设计令牌（方案 A 单字方钮）');
  {
    delete store['ysy.xprobe.blocked'];
    delete store['ysy.xprobe.bench'];
    delete store['ysy.xprobe.benchPost'];
    const t23 = h('div', {}, [
      h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/demo_own' }, [T('甲 @demo_own')])]),
    ]);
    const sb23 = run(t23, '/demo_own', 'https://x.com/demo_own');
    const X23 = sb23.__xprobe;
    const bar23 = IDS['ysy-xprobe-ext-bar'];
    const fb23 = (id) => IDS[id];

    eq('右缘轨：玻璃底 + backdropFilter blur + 8px 细轨圆角（方案 A；令牌 UI_TOK 的三样都在）',
      [/rgba\(15,20,27/.test(bar23.style.background), bar23.style.backdropFilter, bar23.style.borderRadius],
      [true, 'blur(14px) saturate(1.2)', '8px']);
    eq('柱顶一颗探针呼吸点（class ysy-dot，6px 圆，动画在柱内嵌 style 里——纯样式，不派事件）',
      [bar23.children[1].getAttribute('class'), bar23.children[1].style.width,
        /ysyFabPulse/.test(bar23.children[0].textContent)], ['ysy-dot', '6px', true]);
    eq('方案 A：钮面单字横排、全称住 data-tip（标杆钮 textContent=「杆」、无竖排、data-tip=「标杆账号」）',
      (() => { const b = fb23('ysy-xprobe-ext-bbtn'); return [b.children[0].style.writingMode || '',
        b.children[0].style.textOrientation || '', b.textContent, b.getAttribute('data-tip')]; })(),
      ['', '', '杆', '标杆账号']);
    eq('七颗一律单字横排：关/榜/观与杆/帖/稿的 label span 都没有 writingMode',
      ['ysy-xprobe-ext-fbtn', 'ysy-xprobe-ext-cbtn', 'ysy-xprobe-ext-fab',
        'ysy-xprobe-ext-bbtn', 'ysy-xprobe-ext-bpbtn', 'ysy-xprobe-ext-aibtn']
        .map((id) => fb23(id).children[0].style.writingMode || ''), ['', '', '', '', '', '']);
    eq('方案 A：hover 全称标签向左浮出、轨道恒宽（::after 绝对定位 + right:calc(100% + 8px) + 不挡点击）',
      (() => {
        const css = bar23.children[0].textContent || '';
        return [/\.ysy-fab::after\{content:attr\(data-tip\)/.test(css),
          /right:calc\(100% \+ 8px\)/.test(css), /position:absolute/.test(css),
          /pointer-events:none/.test(css), /\.ysy-fab:hover::after/.test(css)];
      })(), [true, true, true, true, true]);
    X23.benchToggle('Bob', '乙');
    X23.fabBtn();
    eq('角标：标杆 1 人 ⇒ 钮右上角多一枚小数字 3？不——1 人就是 1（数字与台账同源），字色琥珀、字面拼出「杆1」',
      (() => { const b = fb23('ysy-xprobe-ext-bbtn'); return [b.textContent, b.children[1].textContent, b.children[1].style.color]; })(),
      ['杆1', '1', '#e0a34c']);
    X23.benchToggle('Bob', '乙');
    X23.fabBtn();
    eq('人数归零 ⇒ 角标整枚摘掉（不是写 0 冒充没数，RL-11 的钮面版），钮面只剩「杆」',
      (() => { const b = fb23('ysy-xprobe-ext-bbtn'); return [b.textContent, b.children.length]; })(),
      ['杆', 1]);
    X23.flistOpen = false; X23.benchOpen = false; X23.benchPOpen = false; X23.cardOpen = false;
    X23.fabBtn();
    eq('没有面板开着 ⇒ 五颗开关全是安静的灰（inkDim），一个都不亮',
      ['ysy-xprobe-ext-fbtn', 'ysy-xprobe-ext-cbtn', 'ysy-xprobe-ext-rbtn', 'ysy-xprobe-ext-bbtn', 'ysy-xprobe-ext-bpbtn']
        .every((id) => fb23(id).getAttribute('class') === 'ysy-fab' && fb23(id).style.color === '#8b98a5'), true);
    IDS['ysy-xprobe-ext-fbtn'].fire('click');   // 走真按钮（toggleFlist 没出口子；点钮本来就是用户的那条路）
    X23.fabBtn();
    eq('名单开着 ⇒ 「关」点亮：class 带 ysy-fab-on（style 里那条给绿字 + 左缘刻线）、字色强调绿；别的钮不跟亮',
      [fb23('ysy-xprobe-ext-fbtn').getAttribute('class'), fb23('ysy-xprobe-ext-fbtn').style.color,
        fb23('ysy-xprobe-ext-bbtn').style.color],
      ['ysy-fab ysy-fab-on', '#4ec98a', '#8b98a5']);
    IDS['ysy-xprobe-ext-fbtn'].fire('click');
    X23.fabBtn();
    eq('关掉名单 ⇒ 「关」当场熄回去（点亮花名册只在变的那一趟写，其余趟一个字不动 DOM）',
      [fb23('ysy-xprobe-ext-fbtn').getAttribute('class'), fb23('ysy-xprobe-ext-fbtn').style.color],
      ['ysy-fab', '#8b98a5']);

    // 环形读秒：冷却中 ring 出现（conic-gradient 进度盘 + mask 挖环带），翻绿藏起来不拔节点
    X23.recordAction('follow', { id: '231', handle: 'zz_a', why: 'attr' });
    X23.fabBtn();
    const lamp23 = fb23('ysy-xprobe-ext-fab');
    const ring23 = lamp23.children[lamp23.children.length - 1];
    eq('冷却中 ⇒ 灯多出一颗环：display block、conic-gradient 进度盘、mask 挖成环带；字仍是「观」往下走的秒数',
      [ring23.style.display, /^conic-gradient\(#e0a34c \d+%, transparent 0\)$/.test(ring23.style.background),
        /radial-gradient/.test(ring23.style.webkitMask), /^\d{1,3}$/.test(lamp23.textContent)],
      ['block', true, true, true]);
    sb23.__xprobe.getGuard().follows = [Date.now() - 61000];
    sb23.__runTimers(2);
    X23.fabBtn();
    eq('过 60 秒翻回绿「观」 ⇒ 环藏起来（display none，节点留着复用——反复插拔才是新的抖动）',
      [lamp23.textContent, ring23.style.display, lamp23.children.length], ['观', 'none', 2]);

    // 面板标题走 serif 档 + 曝光榜数据条：构造判据钉在源码上（夹具搭一整套带指标的榜太重，
    // 这两处的行为面——标题字面/行结构/点击账——已各有旧针脚钉着）
    const core23 = rd('content/core.js');
    ok('四块面板的标题全走 uiTitle（serif 档、本机宋体系栈，不往 x.com 注 webfont）；曝光榜行底有 2px 数据条（第一名绿满条、其余琥珀按比例）',
      /function uiTitle/.test(core23)
      && core23.split('uiTitle(').length >= 5
      && /SimSun,serif/.test(core23)
      && /height: '2px', width: Math\.max\(3, Math\.round\(vv \* 100 \/ maxView\)\)/.test(core23)
      && /background: i === 0 \? UI_TOK\.acc : UI_TOK\.amber/.test(core23), '');
    ok('变异对照：把 mk 里写 data-tip 那一行抠掉 ⇒ 重建的 core 里七颗钮全都没了全称（hover 标签会静默失效）',
      (() => {
        const cut = rd('content/core.js')
          .replace("        x.setAttribute('data-tip', full);", '        /* cut */');
        const sb23x = runSource(cut, t23, '/demo_own', 'https://x.com/demo_own');
        const bb = sb23x.document.getElementById('ysy-xprobe-ext-bbtn');
        return bb ? bb.getAttribute('data-tip') || '(无)' : '(没建排)';
      })(), '(无)');
  }

  // ---- [24] v0.9.7 标杆同步（登录态 + 台账流水增量 + 服务端回水位）----
  // 三道判据各钉一件事：① 门从「密钥」换成「登录态」，纯本地一个字节不出机器；
  // ② 推的是台账流水（含 state=0 墓碑），游标 after 真的下推到本机库；
  // ③ 水位只抬到服务端回的 ack——服务端说只收到第 3 行，水位就停在 3。
  console.log('\n[24] v0.9.7 标杆同步：没登录不发 / 墓碑也发 / 游标下推 / 水位只认服务端 ack');
  {
    const TOK24 = 'jwt-selftest-24';
    // v0.10.0 起登录态按档各存一格（acct.prod / acct.dev），水位也是两本；这一段跑的是「线上」那一档
    const CLOUD24 = { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: TOK24, email: 'me@example.com', userId: 'u1' } } } };
    // 台账事件行：进榜、改分类、移出各一行；id 是本机台账自增（= 增量游标），最后一条是没 handle 的脏行
    const acRows24 = [
      { id: 1, at: '2026-10-27T01:00:00.000', day: '2026-10-27', handle: 'zz_a', name: '甲', state: 1, tags: '金融', url: 'https://x.com/zz_a', fans: 100, fow: 50, posts_n: 9, views: 111, eng: 22, relation: 'not_following', blocked: 0, last_post_at: '2026-10-26T18:00:00.000Z', observed_at: '2026-10-26T20:00:00.000' },
      { id: 2, at: '2026-10-27T01:05:00.000', day: '2026-10-27', handle: 'zz_a', name: '甲', state: 1, tags: '金融,AI', url: 'https://x.com/zz_a', fans: 120, fow: 50, posts_n: 9, views: 130, eng: 25, relation: 'following', blocked: 0, last_post_at: '2026-10-26T18:00:00.000Z', observed_at: '2026-10-27T00:00:00.000' },
      { id: 3, at: '2026-10-28T02:00:00.000', day: '2026-10-28', handle: 'zz_b', name: '乙', state: 1, tags: '', url: '', fans: null, fow: null, posts_n: null, views: null, eng: null, relation: '', blocked: null, last_post_at: '', observed_at: null },
      { id: 4, at: '2026-10-29T03:00:00.000', day: '2026-10-29', handle: 'zz_c', name: '丙', state: 0, tags: null, url: '', fans: null, fow: null, posts_n: null, views: null, eng: null, relation: '', blocked: null, last_post_at: '', observed_at: null },
      { id: 5, at: '2026-10-29T04:00:00.000', day: '2026-10-29', handle: '', name: '没 handle 的脏行', state: 1 },
    ];
    const poRows24 = [
      { id: 7, at: '2026-10-28T05:00:00.000', day: '2026-10-28', tweet_id: '2114978598516146582', author: '@zz_a', text: '带\n换行的全文', state: 1, tags: '疑问炮', url: 'https://x.com/zz_a/status/2114978598516146582', view: 4321, reply: 12, like: 56, eng: 78, time_datetime: '2026-10-26T18:03:21.000Z', observed_at: '2026-10-28T04:00:00.000' },
      { id: 8, at: '2026-10-29T06:00:00.000', day: '2026-10-29', tweet_id: '2114978598516146583', author: 'zz_b', text: '', state: 0, tags: null, url: '', view: null, reply: null, like: null, eng: null, time_datetime: '', observed_at: null },
    ];
    const dbSeen24 = [];   // 每次 dbq 都记下 {q, after, limit}：判据要看「游标有没有真的下推到库」
    const dbNative24 = (p) => {
      if (p && p.t === 'db') {
        dbSeen24.push({ q: p.q, after: p.after, limit: p.limit });
        const all = p.q === 'bench_marks_ac' ? acRows24 : p.q === 'bench_marks_po' ? poRows24 : [];
        const cur = Number(p.after || 0);   // 库那边的 WHERE s.id > ? —— 桩照抄这条规矩
        return { status: 200, body: JSON.stringify({ rows: all.filter((r) => r.id > cur) }) };
      }
      return { status: 200, body: '{}' };
    };
    const ok24 = (ackAc, ackPo, extra) => JSON.stringify({ code: 200, message: '已入库', data: Object.assign(
      { ackAc: ackAc, acRecv: 4, acNewMark: 4, acDrop: 0, ackPo: ackPo, poRecv: 2, poNewMark: 2, poDrop: 0, capped: false }, extra || {}) });

    // ① 门：纯本地（没登录）⇒ 连本机库都不问，fetch 0 次
    const w24a = runSW({ native: dbNative24, text: ok24(5, 8) });
    const rNo = await w24a.__send({ t: 'xsyncRun' });
    eq('纯本地模式（没登录）⇒ 当场回话：本机库一次都没问、一个字节没出机器（v0.9.6 那把密钥不再是门）',
      [rNo.ok, /云端模式没开/.test(rNo.err), w24a.__nativeQ.length, w24a.__fetchCalls()], [false, true, 0, 0]);
    // 状态里只有「有没有登录态 + 邮箱 + 水位」，token 明文不回面板
    const st24 = await runSW({ store: CLOUD24, native: dbNative24 }).__send({ t: 'xsyncState' });
    eq('状态只报 logged/email/水位，token 不回显',
      [st24.ok, st24.conf.logged, st24.conf.email, st24.wm, JSON.stringify(st24).indexOf(TOK24) < 0],
      [true, true, 'me@example.com', { ac: 0, po: 0 }, true]);

    // ② 第一跑：URL 钉在 push 端点、登录态只在头、推的是流水
    const w24b = runSW({ store: CLOUD24, native: dbNative24, text: ok24(5, 8) });
    const rRun = await w24b.__call({ t: 'xsyncRun' }, 4000);
    eq('出机器的地址钉死自家 Java 库的 push 端点；token 在请求头、体里一个都不带',
      [rRun.ok, /^https:\/\/api2\.mingzhang\.cc\/api\/xprobe\/bench\/push$/.test(w24b.__lastUrl),
        w24b.__lastInit.headers.token, JSON.stringify(w24b.__lastInit.body).indexOf(TOK24) < 0],
      [true, true, TOK24, true]);
    const sent24 = JSON.parse(w24b.__lastInit.body);
    eq('推的是台账流水不是视图：state=0 的墓碑也发得出去（视图会把它滤掉 ⇒ 云端永远撤不掉标杆）；没 handle 的脏行不发',
      [sent24.ac.length, sent24.ac.map((a) => a.id), sent24.ac.filter((a) => a.state === 0).map((a) => a.handle),
        sent24.po.length, sent24.po.map((p) => p.state)],
      [4, [1, 2, 3, 4], ['zz_c'], 2, [1, 0]]);
    eq('投影对得上服务端 DTO 的 camelCase；观察时刻带着走（observedAt=这批数什么时候看到的，不是标记时刻）；没数原样 null 不拿 0 冒充',
      [sent24.ac[0].postsN, sent24.ac[0].observedAt, sent24.ac[0].relation, sent24.ac[2].fans, sent24.po[0].tweetId,
        sent24.po[0].author, sent24.po[1].view, sent24.po[0].text],
      [9, '2026-10-26T20:00:00.000', 'not_following', null, '2114978598516146582', '@zz_a', null, '带\n换行的全文']);
    eq('游标真的下推到库：第一跑 after=0；deviceId 带上（服务端按 用户+设备 分账）',
      [dbSeen24.slice(0, 2).map((d) => [d.q, d.after, d.limit]), sent24.deviceId.length >= 8, sent24.ver],
      [[['bench_marks_ac', 0, 500], ['bench_marks_po', 0, 500]], true, '9.9.9']);
    eq('服务端 ack 到第 5/8 行 ⇒ 水位抬到 5/8（stat 里落的是这一批的账）',
      [w24b.__map['ysy.xprobe.xsyncWM.prod.u1'], w24b.__map['ysy.xprobe.xsyncStat'].acSent], [{ ac: 5, po: 8 }, 4]);

    // ③ 服务端只收到一半：水位停在它给的那儿，剩下的下次接着推
    const w24c = runSW({ store: CLOUD24, native: dbNative24, text: ok24(3, 7, { capped: true }) });
    const rPart = await w24c.__call({ t: 'xsyncRun' }, 4000);
    eq('capped 那批只 ack 到 3/7 ⇒ 水位就停在 3/7（客户端自己算会抬到 5/8，把被切掉的行当已同步）',
      [rPart.ok, rPart.data.capped, rPart.wm, w24c.__map['ysy.xprobe.xsyncWM.prod.u1']], [true, true, { ac: 3, po: 7 }, { ac: 3, po: 7 }]);
    dbSeen24.length = 0;
    const w24d = runSW({ store: { 'ysy.xprobe.cloud': CLOUD24['ysy.xprobe.cloud'], 'ysy.xprobe.xsyncWM.prod.u1': { ac: 3, po: 7 } }, native: dbNative24, text: ok24(5, 8) });
    const rNext = await w24d.__call({ t: 'xsyncRun' }, 4000);
    eq('接着推：after=3/7 交给库，回来的正是水位之后那两条（zz_c 的墓碑这次终于发出去）',
      [rNext.ok, dbSeen24.slice(0, 2).map((d) => [d.q, d.after]), JSON.parse(w24d.__lastInit.body).ac.map((a) => a.id),
        JSON.parse(w24d.__lastInit.body).po.map((p) => p.id)],
      [true, [['bench_marks_ac', 3], ['bench_marks_po', 7]], [4], [8]]);

    // ④ 增量的正身 + 三种「不算成功」的水位
    const w24e = runSW({ store: { 'ysy.xprobe.cloud': CLOUD24['ysy.xprobe.cloud'], 'ysy.xprobe.xsyncWM.prod.u1': { ac: 9, po: 9 } }, native: dbNative24 });
    const rEmpty = await w24e.__call({ t: 'xsyncRun' }, 4000);
    eq('水位之后没有事件行 ⇒ empty 确认，fetch 0 次（增量不是全量重推）',
      [rEmpty.ok, rEmpty.empty, w24e.__fetchCalls()], [true, true, 0]);
    const w24f = runSW({ store: CLOUD24, native: dbNative24, text: JSON.stringify({ code: 200, data: { accountsNew: 2 } }) });
    const rOld = await w24f.__call({ t: 'xsyncRun' }, 4000);
    eq('200 但没带 ack（对面还是 v0.9.6 那版）⇒ 水位原地不动、并明说 stalled：下次整批重推，唯一键去重不会落第二行',
      [rOld.ok, rOld.stalled, w24f.__map['ysy.xprobe.xsyncWM.prod.u1']], [true, true, { ac: 0, po: 0 }]);
    const w24g = runSW({ store: CLOUD24, native: dbNative24, status: 403, text: '{"code":403,"message":"需要登录"}' });
    const r403 = await w24g.__call({ t: 'xsyncRun' }, 4000);
    eq('对面 403 ⇒ 单独标 needLogin（面板说得清是去重新登录，不是去对密钥），水位不动',
      [r403.ok, r403.needLogin, /登录/.test(r403.err), w24g.__map['ysy.xprobe.xsyncWM.prod.u1']], [false, true, true, undefined]);
    const w24h = runSW({ store: CLOUD24, native: dbNative24, fetchFail: 'net::ERR_CONNECTION_REFUSED' });
    const rNet = await w24h.__call({ t: 'xsyncRun' }, 4000);
    eq('断网 ⇒ 如实回话、水位照旧不抬（抬早了这批就永远丢了）', [rNet.ok, w24h.__map['ysy.xprobe.xsyncWM.prod.u1']], [false, undefined]);

    // ⑤ 密钥退场（防回潮）：源码里再没有那把门，设置里也不再有那一格
    const sw24 = rd('background/sw.js'), html24 = rd('ui/sidepanel.html');
    ok('v0.9.6 的静态密钥整体退场：sw.js 里 X-Xprobe-Key / xprobeSyncKey / ysy.xprobe.xsync 存储键都没了（开源插件里配一把共享密钥 = 门没关）',
      !/X-Xprobe-Key/.test(sw24) && !/xprobeSyncKey/.test(sw24) && !/'ysy\.xprobe\.xsync'/.test(sw24) &&
      !/bench\/import/.test(sw24), '');
    ok('设置页只剩「运行模式」那道门：没有同步密钥那一格，标杆同步那行读的是登录态',
      !/xsKey|bXsSave/.test(html24) && /id="bCloud"/.test(html24) && /id="xsWm"/.test(html24) &&
      /运行模式/.test(html24), '');

    // ⑥ 变异对照：抠游标 ⇒ 整本重推；抠「只认服务端 ack」⇒ 水位越过被切的行
    const wM24a = runSW({ store: { 'ysy.xprobe.cloud': CLOUD24['ysy.xprobe.cloud'], 'ysy.xprobe.xsyncWM.prod.u1': { ac: 9, po: 9 } },
      native: dbNative24, text: ok24(9, 9),
      src: rd('background/sw.js').replace('after: wm.ac', 'after: 0').replace('after: wm.po', 'after: 0') });
    const rM24a = await wM24a.__call({ t: 'xsyncRun' }, 4000);
    eq('变异对照：游标抠成 0 ⇒ 水位到顶也整本重推（④的 empty 判据当场红）',
      [rM24a.ok, rM24a.empty, wM24a.__fetchCalls()], [true, null, 1]);
    const wM24b = runSW({ store: CLOUD24, native: dbNative24, text: ok24(3, 7, { capped: true }),
      src: rd('background/sw.js').replace('const next = { ac: ackOf(d.ackAc, wm.ac), po: ackOf(d.ackPo, wm.po) };',
        'const lastId = (a) => a.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0); const next = { ac: Math.max(wm.ac, lastId(payload.ac)), po: Math.max(wm.po, lastId(payload.po)) };') });
    const rM24b = await wM24b.__call({ t: 'xsyncRun' }, 4000);
    eq('变异对照：客户端自己算水位 ⇒ 服务端明明只收到第 3 行也被抬到第 4 行，③第一条判据当场红（吞掉的正好是 zz_c 那颗墓碑——云端从此撤不掉）',
      [rM24b.ok, wM24b.__map['ysy.xprobe.xsyncWM.prod.u1']], [true, { ac: 4, po: 8 }]);
  }

  // ---- [25] v0.9.8 设置页体验（文案分层 / 模式点开弹窗才动状态 / 反馈落在看得见的地方）----
  // 用户口径：「设置里面的描述太多了，应该加一个 ❓，点击后打开模态框提示这些描述性文字；
  // 另外点击模式切换应该打开模态框登录，而不是现在这种——体验很差」。
  // 这一段钉三件事：① 说明搬家不删（全文还在 DOM 里，只是不再常驻，入口由代码生成）；
  // ② 「运行模式」这颗钮从此不改任何状态，改状态的是弹窗里那一步；模式与登录分家（SW 真跑）；
  // ③ 动作结果写进静态的「最近动作」行 —— 不再 prepend 进每 900ms 清空的 #report。
  console.log('\n[25] v0.9.8 设置页：说明收进 ❓ / 模式弹窗才动状态 / 反馈不再被 900ms 抹掉');
  {
    const html25 = rd('ui/sidepanel.html').replace(/\r\n/g, '\n');
    const css25 = rd('ui/sidepanel.css').replace(/\r\n/g, '\n');
    const sp25 = rd('ui/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');   // 注释抠掉：判据不许咬自己的说明文字
    const sw25 = rd('background/sw.js');

    // ① 文案账：把 setBox 真解析一遍，量「常驻可见」与「折叠全文」两笔（v0.9.7 那版实测：常驻 2717 字、最长一格 1585 字）
    const seg25 = (html25.match(/<div id="setBox"[\s\S]*?\n<\/div>\n/) || [''])[0];
    const rows25 = Array.from(seg25.matchAll(/<div class="secRow[^"]*">([\s\S]*?)\n    <\/div>/g)).map((m) => {
      const pick = (re) => Array.from(m[1].matchAll(new RegExp(re.source, 'g'))).map((x) => x[1]).join('').trim();
      return {
        html: m[1],
        lab: pick(/<div class="secLab">([\s\S]*?)<\/div>/),
        hint: pick(/<div class="secHint"[^>]*>([\s\S]*?)<\/div>/),
        desc: pick(/<div class="secDesc"[^>]*>([\s\S]*?)<\/div>/),
        fold: pick(/<div class="secFold">([\s\S]*?)<\/div>/),
      };
    });
    const visible = (r) => r.hint.length + r.desc.length;
    const sum = (arr) => arr.reduce((a, x) => a + x, 0);
    ok('setBox 解析得到（这一段的账不能对着空气算）：33 行（v0.10.0 多了「云端接口」、v0.10.6 多了「抓取档案」两行、v0.10.7 多了「同步进度」、v0.11.0 多了「重试间隔」、v0.11.4 多了「本机模型」那一节的四行、v0.11.18 多了「热点徽标」一行）、每行都有 secLab',
      rows25.length === 33 && rows25.every((r) => r.lab.length > 0), rows25.length);
    ok('常驻可见的说明压到 800 字以内（v0.9.7 实测 2717 字 ⇒ 一屏读不完、控件找不到；v0.11.0 多一行「重试间隔」抬到 760；v0.11.4 多一节「本机模型」四行抬到 800，每行仍有上限）',
      sum(rows25.map(visible)) <= 800, sum(rows25.map(visible)));
    ok('每一行常驻那一句都不超过 60 字（超了就是又写回了一整段）',
      rows25.every((r) => visible(r) <= 60), rows25.filter((r) => visible(r) > 60).map((r) => r.lab + '=' + visible(r)));
    ok('搬家不是删：折叠全文合计仍有 3000+ 字，且每行的 .secFold 都待在它自己那一行里',
      sum(rows25.map((r) => r.fold.length)) >= 3000 && rows25.filter((r) => r.fold.length > 0).length >= 20,
      [sum(rows25.map((r) => r.fold.length)), rows25.filter((r) => r.fold.length > 0).length]);
    ok('全文不常驻靠的是 CSS（.secFold{display:none}），不是靠 JS 记得藏起来',
      /\.secFold \{ display: none; \}/.test(css25), '');
    ok('❓ 由代码按 .secFold 生成（漏写一行 html 也不会少了入口），点开读的就是那格全文',
      /function wireSetHelp\(\)/.test(sp25) && /querySelector\('\.secFold'\)/.test(sp25) &&
      /q\.className = 'secQ'/.test(sp25) && /lab\.append\(q\)/.test(sp25) &&
      /openHelpModal\(name, \(fold\.textContent/.test(sp25) &&
      /function openHelpModal\(name, foldText, extras\)/.test(sp25) && /className = 'mFold'/.test(sp25), '');
    ok('弹窗只有一张皮肤：设置页复用广场作者框那套规则（一份样式，两处用），三条关法齐（× / 遮罩 / Esc）',
      /\.tlModalWrap, \.modalWrap \{/.test(css25) && /\.tlModalBody, \.modalBody \{/.test(css25) &&
      /id="setModal"/.test(html25) && /id="setModalX"/.test(html25) &&
      /e\.target === modShell\) closeModal\(\)/.test(sp25) && /if \(modalKind\) closeModal\(\)/.test(sp25), '');
    ok('正向对照：把「行里塞 ❓」那一句抠掉（全文没人有入口 = 说明等于没写），上面那条判据当场变红',
      !/lab\.append\(q\)/.test(sp25.replace('lab.append(q);', '')), '');
    ok('弹窗里那颗「复制命令」与全文里那句话不打架：说的是复用面板既有复制路径、manifest 一个字没动（RL-3 拦的是权限，不是钮）',
      /复制命令/.test(sp25) && /copyText\(pre\.textContent/.test(sp25) &&
      !/不在这页放「复制」钮/.test(html25) && /manifest 一个字没动/.test(html25) &&
      !/clipboardWrite/.test(rd('manifest.json')), '');

    // ② 模式：钮只开弹窗；登录表单不再常驻；「模式」与「登录」在 SW 里真的分家
    ok('「运行模式」这颗钮从此不改状态：点它 = openModeModal()，旧的 doCloudToggle / cloudOpen / 常驻内联登录框 cloudBox 都不在了',
      /bCloud: \(\) => openModeModal\(\)/.test(sp25) && !/doCloudToggle/.test(sp25) &&
      !/cloudOpen/.test(sp25) && !/id="cloudBox"/.test(html25), '');
    ok('弹窗里的登录表单是开弹窗时建的，且建一次不重建（重建会抹掉用户正在打的验证码）',
      /function openModeModal\(\)/.test(sp25) && /id = 'cloudEmail'/.test(sp25) && /id = 'bCloudCode'/.test(sp25) &&
      /function syncModeModal\(\)[\s\S]{0,700}classList\.toggle\('hide', on \|\| logged\)/.test(sp25), '');
    ok('发验证码的 60 秒在钮上如实读秒（服务端本来就 60 秒一条，让用户对着按不动的灰钮猜是产品设计失败），且没为它新开定时器',
      /再等 ' \+ left \+ ' 秒/.test(sp25) && /function tickCodeCd\(\)/.test(sp25) &&
      /if \(!document\.hidden\) tickCodeCd\(\)/.test(sp25), '');
    ok('登录态一变，设置页那颗钮与两行状态同频（模式/邮箱/上次同步），标杆同步那行跟着改口',
      /set\('bCloud', on \? '模式：云端/.test(sp25) && /set\('cloudHint',/.test(sp25) &&
      /id="cloudStat"/.test(html25) && /id="xsWm"/.test(html25) &&
      /xsRefresh\(\);/.test((sp25.match(/function cloudRefresh\(\)[\s\S]*?\n  \}/) || [''])[0]), '');
    ok('两趟上传不再同名：一颗「立即上送」（指标/台账）、一颗「立即推标杆」（标杆事件行）',
      /立即上送/.test(html25) && /立即推标杆/.test(html25) && !/立即同步/.test(html25) &&
      /<div class="secLab">上送状态<\/div>/.test(html25) && /<div class="secLab">推送状态<\/div>/.test(html25), '');
    ok('退出登录要按两下（60 秒内第二下才算），且把「只停上送 ≠ 抹身份」写在弹窗里',
      /function doCloudOut\(\)/.test(sp25) && /logoutArm && Date\.now\(\) - logoutArm < ARM_MS/.test(sp25) &&
      /再点一次=退出登录/.test(sp25) && /这一步只改「要不要上送」/.test(sp25), '');

    // SW 那一跳真跑：模式与登录分家（这是 v0.9.7 那颗钮的病根——开着再点 = 直接抹掉 token）
    // 夹具故意用 v0.9.9 那把旧形（token 挂在顶层）：这一跑同时验迁移——旧登录态读得到，落盘时并进 acct.prod
    const wMode = runSW({ store: { 'ysy.xprobe.cloud': { on: true, token: 'tk-25', email: 'me@example.com', userId: 'u1' } } });
    const mOff = await wMode.__send({ t: 'cloudMode', on: false });
    eq('切回纯本地只关 on：token 与邮箱都留着（下次切回云端不用再收验证码），旧形的 token 迁进 acct.prod',
      [mOff.ok, mOff.logged, mOff.on, wMode.__map['ysy.xprobe.cloud'].on, wMode.__map['ysy.xprobe.cloud'].acct.prod.token,
        wMode.__map['ysy.xprobe.cloud'].token],
      [true, true, false, false, 'tk-25', undefined]);
    const mBack = await wMode.__send({ t: 'cloudMode', on: true });
    eq('凭旧 token 直接切回云端（on=true），不用再走一遍邮箱验证码', [mBack.ok, mBack.logged, mBack.on], [true, true, true]);
    const wNoTok = runSW({});
    const mBad = await wNoTok.__send({ t: 'cloudMode', on: true });
    eq('没登录态不许把 on 打开：面板显示「云端」而一个字节都不发 = 一扇没接通的门（就地拒，且不写存储）',
      [mBad.ok, /登录/.test(mBad.err || ''), wNoTok.__map['ysy.xprobe.cloud']], [false, true, undefined]);
    const wJustOff = runSW({ store: { 'ysy.xprobe.cloud': { on: false, token: 'tk-25', email: 'me@example.com' } }, text: '{}' });
    const rOff25 = await wJustOff.__send({ t: 'cloudSyncNow' });
    eq('「只停上送」确实一个字节都不出机器（fetch 0 次），而登录态还在（这条就是「模式≠登录」的全部代价）',
      [rOff25.ok, /云端同步没开/.test(rOff25.err || ''), wJustOff.__fetchCalls()], [false, true, 0]);
    ok('变异对照：把 cloudMode 里那句「没 token 不许开」抠掉 ⇒ 上面那条拒绝判据当场红',
      !/want && !c\.token/.test(sw25.replace('if (want && !c.token)', 'if (false && !c.token)')), '');

    // ③ 反馈落位：#report 每 900ms 被 render() 清空，动作结果必须写在静态节点上
    ok('设置页有常驻的「最近动作」行（#setNote 在 setBox 里，不在 #report 里），noteSet 是唯一的写法',
      /id="setNote"/.test(seg25) && /function noteSet\(text, sty\)/.test(sp25) &&
      /\$\('setNote'\)/.test(sp25), '');
    ok('设置页这几枪的结果都不再 prepend 进 #report（以前「验证码已发到 xxx」只活了不到一秒）',
      !/report'\)\.prepend/.test(sp25), (sp25.match(/report'\)\.prepend.{0,40}/g) || []).slice(0, 2));
    ok('正向对照：把「已登录」那句改回写进 #report ⇒ 上面那条当场红（证明它咬的是这一格，不是全文没这个词）',
      /report'\)\.prepend/.test(sp25.replace("noteSet('已登录 ", "$('report').prepend(x => x, '已登录 ")), '');
  }

  // ---- [26] v0.10.0 云端接口两档（线上 / 本机 dev）+「被 CORS 挡了」的说法 ----
  // 起因两笔账：① 用户本机跑着 boot4（application-dev.yml 的 28081），要插件能直接打自己正在起的那台，
  // 而不是永远打到线上；② v0.9.9 把域名挪到 api2 后真机回 HTTP 403 —— 三次 curl 只差 Origin，量出来是
  // boot4 的 CorsFilter 不认 chrome-extension:// 这个来源，在任何 Controller 之前回纯文本
  // 「Invalid CORS request」。上一版插件把这句猜成「多半打到了网页」，方向说错了（把人支去反复收验证码）。
  // 这一段钉四件事：地址只有两档且写死在 SW、换档带着登录态一起换格子、水位按档各存一本、
  // 403 且回包不是 JSON 一律说成被跨域挡了并且绝不标 needLogin。
  console.log('\n[26] v0.10.0 云端接口两档：地址只有两档 / 登录态与水位按档隔离 / 403 说是被 CORS 挡了');
  {
    const PROD = 'https://api2.mingzhang.cc', DEV = 'http://127.0.0.1:28081';
    const OKJSON = '{"code":200,"message":"ok","data":"a@b.co"}';
    const wEnv0 = runSW({});
    const st0 = await wEnv0.__send({ t: 'cloudState' });
    eq('默认打线上；cloudState 把两档的地址与各档有没有登录态一起给面板（面板自己不写地址）',
      [st0.ok, st0.env, st0.base, st0.on, st0.hasToken,
        (st0.envs || []).map((e) => e.env + ':' + e.base + ':' + (e.logged ? 'y' : 'n'))],
      [true, 'prod', PROD, false, false, ['prod:' + PROD + ':n', 'dev:' + DEV + ':n']]);
    const eDev = await wEnv0.__send({ t: 'cloudEnvSet', env: 'dev' });
    eq('切到本机 dev：档位落存储，回包带着这一档的地址',
      [eDev.ok, eDev.env, eDev.base, wEnv0.__map['ysy.xprobe.cloudEnv']], [true, 'dev', DEV, 'dev']);
    const wDevCode = runSW({ store: { 'ysy.xprobe.cloudEnv': 'dev' }, text: OKJSON });
    const cDev = await wDevCode.__send({ t: 'cloudSendCode', email: 'a@b.co' });
    eq('dev 档的发验证码打到 127.0.0.1:28081（换的是地址，路径一个没动）', [cDev.ok, wDevCode.__lastUrl], [true, DEV + '/api/mz/user/sendEmail']);
    const eBad = await wEnv0.__send({ t: 'cloudEnvSet', env: 'https://evil.example.com' });
    eq('第三个地址填不进来：只认那两个 key，就地拒，存储里仍是原来那档',
      [eBad.ok, /两档/.test(eBad.err || ''), wEnv0.__map['ysy.xprobe.cloudEnv']], [false, true, 'dev']);
    const eProd = await wEnv0.__send({ t: 'cloudEnvSet', env: 'prod' });
    eq('切回线上：这一档没登录过就据实说没登录（不拿 dev 那把钥匙冒充）',
      [eProd.ok, eProd.env, eProd.logged], [true, 'prod', false]);
    const wIso = runSW({
      store: {
        'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-prod', email: 'p@b.co', userId: 'u1' } } },
        'ysy.xprobe.series': { demo_own: { handle: 'demo_own', min: [], updatedAt: 1, imp: [{ day: '2026-10-24', value: 1, at: 'x' }] } },
      },
      text: '{"code":200,"message":"ok","data":{"token":"tok-dev","user":{"id":"u2","nickName":"dev"}}}',
    });
    await wIso.__send({ t: 'cloudEnvSet', env: 'dev' });
    const sDev = await wIso.__send({ t: 'cloudSyncNow' });
    eq('切到 dev = 这一档没登录：当场拒、一个字节不发（闸还开着也没用，换档不是带着旧钥匙换门）',
      [sDev.ok, /这一档/.test(sDev.err || ''), wIso.__fetchCalls()], [false, true, 0]);
    const lDev = await wIso.__call({ t: 'cloudLogin', email: 'd@b.co', code: '1234' }, 4000);
    const acctIso = wIso.__map['ysy.xprobe.cloud'].acct;
    eq('dev 登录只写 dev 那一格：prod 那把原样留着（换档不是退出登录）',
      [lDev.ok, acctIso.dev.token, acctIso.dev.email, acctIso.prod.token, wIso.__map['ysy.xprobe.cloud'].on],
      [true, 'tok-dev', 'd@b.co', 'tok-prod', true]);
    const back = await wIso.__send({ t: 'cloudEnvSet', env: 'prod' });
    const sBack = await wIso.__send({ t: 'cloudSyncNow' });
    eq('切回线上：用的是线上那把钥匙、打的是线上那个地址（两档各走各的，互不串）',
      [back.logged, sBack.ok, wIso.__lastUrl, (wIso.__lastInit.headers || {}).token], [true, true, PROD + '/api/xprobe/ingest', 'tok-prod']);
    const wmStore = { 'ysy.xprobe.cloud': { on: true, acct: { prod: { token: 't' } } }, 'ysy.xprobe.xsyncWM': { ac: 5, po: 8 } };
    const wmProd = await runSW({ store: wmStore }).__send({ t: 'xsyncState' });
    const wmDev = await runSW({ store: Object.assign({ 'ysy.xprobe.cloudEnv': 'dev' }, wmStore) }).__send({ t: 'xsyncState' });
    const wmAnon = await runSW({ store: { 'ysy.xprobe.xsyncWM': { ac: 5, po: 8 } } }).__send({ t: 'xsyncState' });
    eq('登录态不继承顶层那本老账（它没有归属，认不出是谁推到 5/8 ⇒ 宁可整本重推，不可让新账号漏推）：prod / dev 都从 0 起；只有没登录、看状态时线上才认老账，dev 不认',
      [wmProd.wm, wmDev.wm, wmDev.conf.env, wmDev.conf.base, wmAnon.wm],
      [{ ac: 0, po: 0 }, { ac: 0, po: 0 }, 'dev', DEV, { ac: 5, po: 8 }]);
    const dbW26 = (p) => (p && p.t === 'db'
      ? { status: 200, body: JSON.stringify({ rows: p.q === 'bench_marks_ac' ? [{ id: 6, handle: 'zz_d', state: 1 }] : [] }) }
      : { status: 200, body: '{}' });
    const wWmW = runSW({
      store: { 'ysy.xprobe.cloud': { on: true, acct: { prod: { token: 'tok-prod' }, dev: { token: 'tok-dev', email: 'd@b.co', userId: 'u2' } } },
        'ysy.xprobe.cloudEnv': 'dev', 'ysy.xprobe.xsyncWM.prod': { ac: 5, po: 8 }, 'ysy.xprobe.xsyncWM': { ac: 5, po: 8 } },
      native: dbW26, text: '{"code":200,"message":"ok","data":{"ackAc":6,"ackPo":0}}',
    });
    const rW26 = await wWmW.__call({ t: 'xsyncRun' }, 4000);
    eq('dev 推一把：只抬 .dev.<账号> 那本，.prod 与旧顶层那本一个字都不动（推的地址也是 dev 的 push 端点）',
      [rW26.ok, rW26.wm, wWmW.__map['ysy.xprobe.xsyncWM.prod'], wWmW.__map['ysy.xprobe.xsyncWM'],
        wWmW.__map['ysy.xprobe.xsyncWM.dev.u2'], wWmW.__lastUrl],
      [true, { ac: 6, po: 0 }, { ac: 5, po: 8 }, { ac: 5, po: 8 }, { ac: 6, po: 0 }, DEV + '/api/xprobe/bench/push']);
    const cCors = await runSW({ status: 403, text: 'Invalid CORS request' }).__send({ t: 'cloudSendCode', email: 'a@b.co' });
    ok('HTTP 403 + 非 JSON ⇒ 说「被服务端跨域挡了」，把要放行那串 Origin 念出来、明说重收验证码没用，且不标 needLogin',
      cCors.ok === false && !cCors.needLogin && /跨域/.test(cCors.err || '') &&
      /chrome-extension:\/\/ext-self/.test(cCors.err || '') && /重收验证码没用/.test(cCors.err || ''), cCors);
    const cCorsDev = await runSW({ store: { 'ysy.xprobe.cloudEnv': 'dev' }, status: 403, text: 'Invalid CORS request' })
      .__send({ t: 'cloudSendCode', email: 'a@b.co' });
    ok('同一句话把「这一跳打的是哪档地址」报出来（dev 的 403 别让人去查线上）',
      cCorsDev.ok === false && /127\.0\.0\.1:28081/.test(cCorsDev.err || ''), cCorsDev);
    const cHtml = await runSW({ status: 404, text: '<!DOCTYPE html>404' }).__send({ t: 'cloudSendCode', email: 'a@b.co' });
    ok('非 403 的非 JSON 仍说「打到的不是接口」：v0.9.9 为 HTML 404 写的那句没被 CORS 这条改丢',
      !/跨域/.test(cHtml.err || '') && /不是接口/.test(cHtml.err || ''), cHtml);
    const cTok = await runSW({ store: { 'ysy.xprobe.cloud': { on: true, acct: { prod: { token: 'old' } } },
      'ysy.xprobe.series': { a: { handle: 'a', min: [], imp: [{ day: '2026-10-24', value: 1, at: 'x' }] } } },
      text: '{"code":403,"message":"需要登录"}' }).__send({ t: 'cloudSyncNow' });
    eq('JSON 里的 code 403 才是 token 失效（回包是 JSON 就按服务端的 code 说话，两回事不混）',
      [cTok.ok, cTok.needLogin], [false, true]);
    const sp26 = rd('ui/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
    const html26 = rd('ui/sidepanel.html').replace(/\r\n/g, '\n');
    ok('设置页多这一行且只念 SW 给的地址：#envHint / #bCloudEnv 在 html 里，没有可输入的接口地址框',
      /id="envHint"/.test(html26) && /id="bCloudEnv"/.test(html26) &&
      /云端接口/.test(html26) && !/<input[^>]{0,40}id="(cloudBase|envUrl|cloudEnvIn)"/.test(html26), '');
    ok('这颗钮与「运行模式」同规矩（RL-20 一颗钮只干一件事）：只开弹窗不改状态，点中某一格才发 cloudEnvSet，结果写 #setNote',
      /bCloudEnv: \(\) => openEnvModal\(\)/.test(sp26) && /t: 'cloudEnvSet'/.test(sp26) &&
      /noteSet\('云端接口已切到/.test(sp26) && /function openEnvModal\(\)/.test(sp26) &&
      !/report'\)\.prepend.*接口/.test(sp26), '');
    ok('弹窗与 ❓ 里把 dev 那档的前提说全：要放行 chrome-extension:// 来源、两档登录态与水位各存各的',
      /chrome-extension:\/\//.test(sp26) && /CORS|跨域/.test(sp26) &&
      /按档/.test(html26) && /水位/.test(html26), '');
    const wMut26 = runSW({ store: { 'ysy.xprobe.cloudEnv': 'dev' }, text: OKJSON,
      src: rd('background/sw.js').replace('function envOf(v) { return CLOUD_ENVS[v] ? String(v) : CLOUD_ENV_DEF; }',
        'function envOf(v) { return CLOUD_ENV_DEF; }') });
    const mCode26 = await wMut26.__send({ t: 'cloudSendCode', email: 'a@b.co' });
    eq('变异对照：envOf 抠成「永远线上」⇒ 存储里写的是 dev 而发出去的还是 api2（上面那条 dev URL 判据咬的是档位）',
      [mCode26.ok, wMut26.__lastUrl], [true, PROD + '/api/mz/user/sendEmail']);
    const rLoop26 = await runSW({}).__send({ t: 'xhr', url: DEV + '/api/xprobe/ingest', method: 'POST', data: '{}' });
    ok('新申请的 28081 只有 SW 用得上：core 的 xhr 通道对回环 dev 端口照样拒（isLoopback 只认 8765，页面 JS 借不到这条权限）',
      rLoop26 && /拒发/.test(rLoop26.err || ''), rLoop26);
  }

  // ---- [27] v0.10.1 UI/交互审查第一批修（docs/UIX.md 的 D-1~D-14 落到判据）----
  // 用户原话：「产品设计和交互还是很难用，比如输入邮箱和密码只有在点击切换云端才提示，
  // 另外『登录并切换云端』改成『登录』就可以了，不用那么长。请你系统梳理现在的产品的 ui 缺陷
  // 和交互缺陷，放在 skill 里面，持续完善，确保长期高质量」。
  // 排查时先纠了一条我自己的误判：登录框不是「点了云端才出现」—— syncModeModal 在建完弹窗当场
  // 就把 .hide 摘了，没登录时它一直在场；真相是**那一格没有名字**（无标题、无字段标签），
  // 所以修法不是把格子提前，是给它标题与标签。这一段钉 UIX-01/02/03/05/09/18/19/26/27 的修法。
  console.log('\n[27] v0.10.1 UI/交互审查第一批修：登录有名字 / 钮名只管动作 / 清空两下 / 查表不再被 900ms 吃掉');
  {
    const html27 = rd('ui/sidepanel.html').replace(/\r\n/g, '\n');
    const css27 = rd('ui/sidepanel.css').replace(/\r\n/g, '\n');
    const sp27 = rd('ui/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
    const sw27 = rd('background/sw.js');

    // D-1：一颗钮一件事，名字 ≤6 字（「并」字形态 = 违规）
    ok("UIX-01 那颗钮现在只说一件事：字面是「登录」，「登录并切到云端」这种连词式长名字整个退场",
      /login\.textContent = '登录'/.test(sp27) && !/登录并切到云端/.test(sp27) && !/登录并切到云端/.test(html27), '');
    ok('D-1 全域判据：面板与 html 里所有钮的字面都不许再出现「…并…」的连接式动作名（正向对照：把旧字面喂给同一条正则 ⇒ 它确实咬得住，不是空判）',
      !/(?:登录|切换|保存|同步|发送)并(?:切|登|换|到|去)/.test(sp27) &&
      !/(?:登录|切换|保存|同步|发送)并(?:切|登|换|到|去)/.test(html27) &&
      /(?:登录|切换|保存|同步|发送)并(?:切|登|换|到|去)/.test('登录并切到云端'), '');

    // D-3：placeholder 不是标签 —— 登录那一格有标题、两枚字段各有标签
    ok("UIX-02 登录那一格有名字：一格标题「登录（邮箱收验证码）」+ 每枚输入框前面一个可见标签（邮箱 / 验证码），.mLab 的样式真在 CSS 里",
      /mk\('mLab', 'b', '登录（邮箱收验证码）'\)/.test(sp27) && /mk\('mLab', 'span', '邮箱'\)/.test(sp27) &&
      /mk\('mLab', 'span', '验证码'\)/.test(sp27) && /\.mLab \{/.test(css27) && /\.mBox > b\.mLab \{/.test(css27), '');
    ok('邮箱的占位不再是一句英文示例（它是唯一说明时等于没有说明），标题与标签才是说明',
      /placeholder = 'name@example\.com'/.test(sp27), '');

    // D-1/D-2：同一张卡的两种命运必须写在它的副标题上，而且随登录态改口（不重建节点）
    ok('UIX-03 「云端」那张卡的副标题按登录态各念一句（没登录时字面里就有「登录」），换字面走的是「变了才写 DOM」',
      /function cloudCardTip\(\)/.test(sp27) && /没登录 · 点它或直接在下面「登录」那一格填邮箱/.test(sp27) &&
      /querySelector\('\.mTip'\)/.test(sp27) && /if \(bt\.textContent !== want\) bt\.textContent = want/.test(sp27), '');
    ok('正向对照：把「变了才写」那一句改成无条件写 ⇒ 「每秒碰一次正在打字的节点」那条老病回来（上面那条判据当场红）',
      !/if \(bt\.textContent !== want\)/.test(sp27.replace("if (bt.textContent !== want) bt.textContent = want;", "bt.textContent = want;")), '');

    // D-5：一个字没填不该被告知「格式不对」—— 拦在发命令之前，点名填哪一格并把焦点送进去
    ok('UIX-05 空邮箱点「发验证码」：不发命令、状态行点名「邮箱那一格」并写清形状、焦点送进去（SW 那句「邮箱格式不对」只留给真填错的）',
      /if \(!email\) \{/.test(sp27) && /先在「邮箱」那一格填你的邮箱地址/.test(sp27) &&
      /emEl\.focus\(\)/.test(sp27) && /return Promise\.resolve\(\);/.test(sp27) &&
      /邮箱格式不对/.test(sw27), '');
    ok('UIX-04 设置页那一行的短提示自己也提「怎么登录」（安全承诺之外，登录这件事不再只住在 ❓ 全文里）—— html 与 JS 覆写两处口径一致',
      /弹窗里「登录」那一格填邮箱/.test(html27) && /弹窗里「登录」那一格填邮箱/.test(sp27), '');

    // D-7：破坏性动作两下才动手 —— 曾经只有「清空」是按一下就生效的那一颗
    ok('UIX-09 「清空」也进两下才动手那一档（复用同一颗 60 秒闸 ARM_MS），钮自己在等第二下时改口「再点一次=清空」',
      /let clearArm = 0;/.test(sp27) &&
      /bClear: \(\) => \{[\s\S]{0,160}?if \(clearArm && Date\.now\(\) - clearArm < ARM_MS\) \{/.test(sp27) &&
      /setTxt\('bClear', \(clearArm && Date\.now\(\) - clearArm < ARM_MS\) \? '再点一次=清空' : '清空'\)/.test(sp27) &&
      /第一下只提醒（60 秒内再点一次才真清）/.test(html27), '');
    ok('「再点一次=清空」那句写在钮上的改口必须排在 `if (!st) return` 之前：活动标签页不是 x.com 时（st 为 null）钮也得改口，不然又是「点了没反应」',
      (sp27.indexOf("setTxt('bClear'") > 0) &&
      (sp27.match(/function syncButtons\(\)[\s\S]*?if \(!st\) return;/)[0].indexOf("setTxt('bClear'") >= 0), '');
    ok('变异对照：把「清空」那一下的两步判断抠成永假 ⇒ 上面那条两下判据当场红（证明它咬的是这一格里的那个 if，不是全文里恰好有 clearArm 这个词）',
      !/bClear: \(\) => \{[\s\S]{0,160}?if \(clearArm && Date\.now\(\) - clearArm < ARM_MS\)/.test(
        sp27.replace(/(bClear: \(\) => \{[\s\S]{0,160}?)if \(clearArm && Date\.now\(\) - clearArm < ARM_MS\)/, '$1if (false && clearArm < 0)')), '');

    // D-4：反馈落点不能被重画抹掉 —— v0.9.8 只修了设置页，诊断页「查表」还是往 #report 里 prepend
    ok('UIX-18 查表结果改存模块变量、由 render() 在诊断视图里重放；#report 里不再 prepend（那条 900ms 清空的嘴）',
      /let qKeep = null;/.test(sp27) && /qKeep = \[head\]\.concat\(body\)/.test(sp27) &&
      /if \(qKeep\) appendSafe\(root, qKeep\)/.test(sp27) && !/prepend\(tick\(m\)\)/.test(sp27), '');
    ok('查表失败也有一句话（以前 ok:false 只剩一颗空表格 = 「点了没反应」）；离开诊断视图就丢掉旧查询，别在别的页顶出一段',
      /查表没成：/.test(sp27) && /if \(view !== 'debug'\) qKeep = null;/.test(sp27), '');
    ok('UIX-12/13 两格「应用」补上成功落点：随机加时与今日目标都写「最近动作」（成功以前一个字不写，只剩 900ms 后悄悄覆写回输入框）',
      /function doRndSet\(\)[\s\S]{0,700}noteSet\(r\.ok \? \('关注加时上限已设为/.test(sp27) &&
      /function doGoalSet\(\)[\s\S]{0,900}noteSet\(r\.ok \? \('今日目标已记下/.test(sp27), '');

    // D-10/D-12：一套皮肤三条关法（作者框以前只有 × 与遮罩，Esc 是空话）+ 焦点归还 + 一条焦点样式都没有
    ok("UIX-19 两种弹窗的 Esc 各归各的状态：setModal 看 modalKind、广场作者框看 tlUser（RL-20 ③ 那句「三条关法齐」从此对两张弹窗都成立）",
      /if \(modalKind\) closeModal\(\);\s*else if \(tlUser\) closeTlUser\(\);/.test(sp27), '');
    ok('UIX-27 关弹窗把焦点还给开它的那颗钮（Tab 一圈回得到起点）；弹窗壳在 html 里就带 role="dialog" 与 aria-modal',
      /modalPrev = document\.activeElement;/.test(sp27) && /if \(modalPrev && modalPrev\.focus\)/.test(sp27) &&
      /role="dialog"/.test(html27) && /aria-modal="true"/.test(html27) && /aria-labelledby="setModalTitle"/.test(html27), '');
    ok('UIX-27 深色皮肤里补上焦点可见样式：以前整份 CSS grep focus-visible / outline 零命中，键盘走到哪儿全靠浏览器默认',
      /:focus-visible/.test(css27) && /outline: 2px solid/.test(css27), '');
    ok('UIX-26 今日目标那两格补上回车（同页另四格早有）：认 id 走数组，不再一格写一行',
      /\['goalBase', 'goalTarget'\]\.forEach/.test(sp27) && /if \(e\) e\.addEventListener\('keydown', \(ev\) => \{ if \(ev && ev\.key === 'Enter'\) doGoalSet\(\); \}\)/.test(sp27), '');
  }

  // ---- [28] v0.10.2「云端接口」切档不实时（docs/UIX.md UIX-28）----
  // 用户原话：「云端接口（打哪台 boot4）点击切换并没有实时生效，需要关掉再打开才行，帮我优化」。
  // 排除法定位：SW 那一条腿本来就是实时的（cloudConf() 每次调用都重读 storage，cloudEnvSet 回新档位），
  // 病全在面板——弹窗建好之后没人再染一遍：卡片高亮「（现在打这台）」「cur」类只在 openEnvModal 那一刻
  // 按当时的 cloudSt 上色，syncCloudUI() 只重同步了「运行模式」那个弹窗。⇒ 修法是把「染色」从建弹窗
  // 挪进 syncEnvModal()（比对再写、不重建节点，D-11），并把 syncEnvModal() 接进 syncCloudUI()。
  console.log('\n[28] v0.10.2 云端接口切档即时生效：状态轮询驱动弹窗染色 / 回包就地合并 / 点当前档不发命令');
  {
    const sp28 = rd('ui/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
    const sw28 = rd('background/sw.js');

    // 根因那一句：云端状态一变，两个弹窗都要跟着对齐
    ok('UIX-28 syncCloudUI() 收尾同时同步「运行模式」与「云端接口」两个弹窗（只接前者，后者就停在点开那一刻）',
      /function syncCloudUI\(\)[\s\S]{0,900}syncModeModal\(\);\s*syncEnvModal\(\);/.test(sp28), '');
    ok('变异对照：把 syncCloudUI() 里那句 syncEnvModal(); 抠掉 ⇒ 上一条判据当场红（证明它咬的是这一格，不是全文里恰好有这个词）',
      !/function syncCloudUI\(\)[\s\S]{0,900}syncModeModal\(\);\s*syncEnvModal\(\);/.test(
        sp28.replace(/(function syncCloudUI\(\)[\s\S]{0,900}?syncModeModal\(\);\s*)syncEnvModal\(\);/, '$1')), '');

    // D-11：更新走「比对再写」，不许重建节点（重建会抹掉正在看的那一行，也是这一格的老病根）
    ok('syncEnvModal() 只认模态、比对再写：卡片高亮、标题、副标题、状态行四处都「变了才碰 DOM」，函数体内不 createElement',
      /function syncEnvModal\(\) \{\s*if \(modalKind !== 'env'\) return;/.test(sp28) &&
      /if \(b\.className !== cls\) b\.className = cls;/.test(sp28) &&
      /\$\(\'mOptEnv\' \+ e\.env\)/.test(sp28) &&
      /if \(t\.textContent !== w\) t\.textContent = w;/.test(sp28) &&
      /if \(tip\.textContent !== w\) tip\.textContent = w;/.test(sp28) &&
      /if \(st\.textContent !== w\) \{ st\.textContent = w;/.test(sp28) &&
      !/function syncEnvModal\(\)[\s\S]{0,1200}document\.createElement/.test(sp28), '');
    ok('切档后高亮真的会挪家：cur 类由「这一格是不是 envCur()」现算，不是建弹窗时染色（openEnvModal 里不再出现 cur 上色）',
      /const cls = 'mOpt' \+ \(e\.env === cur \? ' cur' : ''\);/.test(sp28) &&
      !/function openEnvModal\(\)[\s\S]{0,1500}' mOpt cur'|"mOpt cur"|'mOpt cur'/.test(sp28), '');

    // 一处出字面：建与更新共用同两个函数，否则下一轮必然分家（卡片标题/副标题两处口径飘）
    ok('卡片字面一处出（envCardTitle/envCardTip 各定义一次、建与更新各用一次 = 三名一处的 3 次命中），状态行也走 envStatText()',
      (sp28.match(/envCardTitle\(e\)/g) || []).length === 3 &&
      (sp28.match(/envCardTip\(e\)/g) || []).length === 3 &&
      /function envStatText\(\)/.test(sp28) && /const w = envStatText\(\)/.test(sp28), '');
    ok('正向对照：把「建与更新共用」拆回两份字面（改一处调用）⇒ 计数判据当场红，证明它数的是真共用',
      (sp28.replace(/envCardTitle\(e\)/, 'envCardTitleOld(e)').match(/envCardTitle\(e\)/g) || []).length === 2, '');

    // D-4/D-9：点下去要有当场落点，且状态行必须带档位与地址（切到 dev 看到「没登录」会被读成线上掉了）
    ok('状态行自己写明「换档立即生效，不用关掉重开」，并把当前档 + 地址 + 这一档登录态一起念（按档分家的状态不许只念一半）',
      /换档立即生效，不用关掉重开/.test(sp28) &&
      /现在打的是：' \+ envLabel\(\) \+ ' · '/.test(sp28) &&
      /（这一档' \+ \(cloudSt && cloudSt\.hasToken \? '已登录 '/.test(sp28), '');

    // 实时性的另一半：不等下一次轮询，SW 回包那几样就地合进本地这一份
    ok('切档回包就地合并（env/base/登录态/模式），合并完再向 SW 要一次真状态；两件事都写在同一格，顺序是「先合再问」',
      /function doEnvSet\(env\)[\s\S]{0,1800}cloudSt\.env = r\.env; cloudSt\.base = r\.base; cloudSt\.hasToken = !!r\.logged;/.test(sp28) &&
      /function doEnvSet\(env\)[\s\S]{0,2200}return cloudRefresh\(\)\.then\(\(\) => r\);/.test(sp28), '');
    ok('变异对照：把回包合并那句抠成什么都不合（只留 cloudRefresh）⇒ 上一条红，证明「立即」靠的是这次合并而不是 3 秒一次的轮询',
      !/function doEnvSet\(env\)[\s\S]{0,1800}cloudSt\.env = r\.env;/.test(
        sp28.replace(/cloudSt\.env = r\.env; cloudSt\.base = r\.base; cloudSt\.hasToken = !!r\.logged;/, '')), '');
    ok('SW 那一腿的回包带齐面板要合的字段（env/base/logged/email/on）——面板不必再问一次才知道换成哪台',
      /if \(msg\.t === 'cloudEnvSet'\)[\s\S]{0,700}env: c\.env, base: c\.base, logged: !!c\.token, email: c\.email, on: !!c\.on/.test(sw28), '');

    // D-5：两种「点了没反应」各有说法——点的就是当前档 / 上一次还在路上
    ok('点当前那一档：不发写命令，状态行直接说「不用换：现在打的就是…」并回 noop（什么都没变却静默，就是「点了没反应」）',
      /if \(want === envCur\(\) && cloudSt\) \{/.test(sp28) &&
      /不用换：现在打的就是/.test(sp28) &&
      /noop: true/.test(sp28), '');
    ok('在途有闸（envBusy）：连点第二下当场回「上一次切换还在路上」，回包到达即解锁——字面不许等回包才改口',
      /let cloudSt = null,[^\n]*\benvBusy = 0[^\n]*;/.test(sp28) &&
      /if \(envBusy\) return Promise\.resolve\(\{ ok: false, err: '上一次切换还在路上/.test(sp28) &&
      /function doEnvSet\(env\)[\s\S]{0,1200}envBusy = Date\.now\(\);[\s\S]{0,900}envBusy = 0;/.test(sp28), '');
    ok('切换中也有一行话（「切换中：把档位写成…」），失败那一支把原因写进状态行并点名「接口没换成」——不许静默',
      /切换中：把档位写成 /.test(sp28) &&
      /接口没换成：/.test(sp28), '');

    // 这一轮的账不许把上一轮的钉法弄丢：这颗钮仍然只开弹窗、换档只在弹窗里点中一格才写
    ok('纪律没飘：那颗钮依旧只开弹窗（不直接改状态），写档位只有 cloudEnvSet 一条命令、两档枚举仍在 SW 里写死',
      /bCloudEnv: \(\) => openEnvModal\(\)/.test(sp28) &&
      /send\(\{ t: 'cloudEnvSet', env: want \}\)/.test(sp28) &&
      /if \(!CLOUD_ENVS\[want\]\)/.test(sw28), '');
    ok('D-1 的账这一轮没飘回来：新写的这几句里没有「…并…」式动作名（正向对照见 [27] 那条全域正则）',
      !/(?:登录|切换|保存|同步|发送)并(?:切|登|换|到|去)/.test(sp28), '');
  }

  // ---- [29] v0.10.3「请登录」的病根 + 登录当场各推一趟 ----
  // 用户原话：「为什么 我登录成功了, 但是 点击上送 还是 报错 上次没传成：请登录（15:07:06）
  // 感觉应该在登陆后立即触发同步,把本地和浏览器的数据同步到云端」。
  // 病根量出来在另一个仓库：boot4 的 JwtUtils.isNotNormal() 写反了 —— 不带 token 一律放行，
  // 带了 token 一律回 true ⇒ PublicInterceptor 用 Result.noLogin(401,"请登录") 把每一趟上送都挡在 Controller 之前。
  // 前端（front/src/lib/utils/request.ts）发的是 Authorization 头、拦截器只读 token 头，所以全站没一个人踩过；
  // 插件按 token 头发（自家 xprobe 的 Controller 也只认这把），于是「登录成功」和「上送被拒」同时为真。
  // 插件这边能做的两件事：① 不把服务端那句「请登录」原样转述出去（带着 token 时说「服务端不认这把 token」）；
  // ② 登录成功那一下当场把两条腿各推一趟（本机那本标杆台账 + 浏览器那本指标/关注台账），结果各说一句。
  // boot4 那一处只改了源码：本机没有 Maven，没编译没启动 ⇒ 「403/401 修好了」这句话本轮仍说不出口。
  console.log('\n[29] v0.10.3 登录首趟两条腿都推 / 服务端 401 不再被转述成「请登录」 / 首趟跟着档位走不串账');
  {
    const PROD29 = 'https://api2.mingzhang.cc', DEV29 = 'http://127.0.0.1:28081';
    const sp29 = rd('ui/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
    const sw29 = rd('background/sw.js');
    const html29 = rd('ui/sidepanel.html');
    // 浏览器那本（存储）：两行日点 + 一条关注事件；本机那本（宿主桩回的台账流水）：三行有效 + 一行没 handle 的脏行
    const SERIES29 = { demo_own: { handle: 'demo_own', min: [], updatedAt: 1, imp: [
      { day: '2026-10-24', value: 100, eff: 90, exact: true, token: 'analytics', fow: 8, fans: 9, posts: 4, at: '2026-10-24T10:00:00Z' },
      { day: '2026-10-23', value: null, eff: 88, token: 'manual' },
    ] } };
    const GUARD29 = { follows: [1], ev: [{ at: 1760000000000, dir: 'follow', handle: 'demo_peer', why: 'plaza', w15: 3, w24: 40 }] };
    const acRows29 = [
      { id: 1, at: '2026-10-27T01:00:00.000', day: '2026-10-27', handle: 'zz_a', name: '甲', state: 1 },
      { id: 2, at: '2026-10-27T02:00:00.000', day: '2026-10-27', handle: 'zz_b', name: '乙', state: 1 },
      { id: 3, at: '2026-10-28T03:00:00.000', day: '2026-10-28', handle: 'zz_c', name: '丙', state: 0 },
      { id: 4, at: '2026-10-29T04:00:00.000', day: '2026-10-29', handle: '', name: '脏行', state: 1 },
    ];
    const dbNative29 = (p) => (p && p.t === 'db'
      ? { status: 200, body: JSON.stringify({ rows: p.q === 'bench_marks_ac' ? acRows29 : [] }) }
      : { status: 200, body: '{}' });
    const okText29 = (data) => JSON.stringify({ code: 200, message: 'ok', data: data });
    // 一趟登录现在真有三跳，每跳回包形状都不一样（原来那份统一 text 撑不住，故 runSW 多了 opt.byUrl / __fetchUrls / __fetchReqs）
    const byLogin29 = (url) => {
      if (/codeLogin/.test(url)) return { text: okText29({ token: 'tok-new', user: { id: 'u9', nickName: '新' } }) };
      if (/ingest/.test(url)) return { text: okText29({ dayRowsNew: 2, followEventsNew: 1 }) };
      if (/bench\/push/.test(url)) return { text: okText29({ ackAc: 6, ackPo: 0, acRecv: 3, acNew: 3 }) };
      return { text: '{"ok":true}' };
    };
    const w29 = runSW({ native: dbNative29, byUrl: byLogin29, store: { 'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 } });
    const lg29 = await w29.__call({ t: 'cloudLogin', email: 'a@b.co', code: '1234' }, 4000);
    const u29 = w29.__fetchUrls();
    eq('登录成功那一下真的当场各推一趟：出机器的是三跳 codeLogin + ingest + bench/push（v0.10.2 及以前只有第一跳，本机那本账要等下一次新数据落盘的 20 秒去抖，不点按钮就永远等在本地）',
      [lg29.ok, u29.length, u29.filter((x) => /codeLogin/.test(x)).length,
        u29.find((x) => /ingest/.test(x)), u29.find((x) => /bench\/push/.test(x))],
      [true, 3, 1, PROD29 + '/api/xprobe/ingest', PROD29 + '/api/xprobe/bench/push']);
    eq('两条腿各报各的数（浏览器那本：日点几行、关注事件几条 / 本机那本：推了几行、水位抬到台账第几行），合不成一句「同步成功」',
      [lg29.firstPush.metrics.ok, lg29.firstPush.metrics.dayRows, lg29.firstPush.metrics.followEvents,
        lg29.firstPush.bench.ok, lg29.firstPush.bench.acSent, lg29.firstPush.bench.poSent, lg29.firstPush.bench.wm],
      [true, 2, 1, true, 3, 0, { ac: 6, po: 0 }]);
    const reqs29 = w29.__fetchReqs().filter((x) => /api\/xprobe/.test(x.url));
    eq('首趟两条腿的身份都只在请求头，而且用的是刚登上的那把新票（不是登录前存储里的旧值）；体里一个 token 明文都不带',
      [reqs29.length, reqs29.every((x) => (x.init.headers || {}).token === 'tok-new'),
        reqs29.every((x) => String(x.init.body || '').indexOf('tok-new') < 0)],
      [2, true, true]);
    eq('首趟的账照常落那两份状态（面板「上送状态 / 推送状态」两行读的就是它们）：水位只抬到服务端给的 ack、且只写当前那一档+当前那个账号（登录回包里的 userId=u9）',
      [w29.__map['ysy.xprobe.cloudStat'].ok, w29.__map['ysy.xprobe.cloudStat'].env, w29.__map['ysy.xprobe.cloudStat'].dayRows,
        w29.__map['ysy.xprobe.xsyncWM.prod.u9'], w29.__map['ysy.xprobe.xsyncWM.dev.u9']],
      [true, 'prod', 2, { ac: 6, po: 0 }, undefined]);
    // 变异对照：跑改过的那份 SW（不是正则认字面）——抠掉首趟就只剩登录那一跳
    // v0.11.0 首趟是四条腿：变异对照把四条一起换成空 Promise（仍是合法源码，只是不出机器）
    const swCut29 = sw29.replace(/uploadCloudNow\(\), xsyncRun\(\), libSyncRun\(\{ batches: LIB_MANUAL_BATCHES \}\),\s*blockSyncRun\(\{ batches: 40 \}\)\]/,
      'Promise.resolve(), Promise.resolve(), Promise.resolve(), Promise.resolve()]');
    const wCut29 = runSW({ src: swCut29, native: dbNative29, byUrl: byLogin29, store: { 'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 } });
    const rCut29 = await wCut29.__call({ t: 'cloudLogin', email: 'a@b.co', code: '1234' }, 4000);
    ok('变异对照（真跑改过的 SW）：把首趟那四条腿抠成空 Promise ⇒ 只剩 codeLogin 一跳、firstPush 四条腿都没了（证明上面那几条判据咬的是这次并行推，不是源码里恰好有 uploadCloudNow 这个词）',
      swCut29 !== sw29 && wCut29.__fetchCalls() === 1 && !(rCut29.firstPush && rCut29.firstPush.metrics),
      [swCut29 === sw29, wCut29.__fetchCalls(), rCut29.firstPush]);
    // 首趟也必须跟着档位走：dev 档登录 ⇒ 两腿都打 28081，线上一把都不碰（RL「切档不许串账」的另一半）
    const wDev29 = runSW({
      native: dbNative29, byUrl: byLogin29,
      store: { 'ysy.xprobe.cloudEnv': 'dev', 'ysy.xprobe.cloud': { on: false, env: 'prod', acct: { prod: { token: 'tok-prod', email: 'p@b.co', userId: 'u1' } } },
        'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 },
    });
    const lgDev29 = await wDev29.__call({ t: 'cloudLogin', email: 'd@b.co', code: '1234' }, 4000);
    eq('dev 档登录：首趟三跳全在 127.0.0.1:28081（线上那把 JWT 结构上发不到 localhost），水位只抬 .dev、.prod 一个字不动',
      [lgDev29.ok, wDev29.__fetchUrls().every((x) => new RegExp('^' + DEV29.replace(/\./g, '\\.') + '/').test(x)),
        wDev29.__fetchUrls().length, wDev29.__map['ysy.xprobe.xsyncWM.dev.u9'], wDev29.__map['ysy.xprobe.xsyncWM.prod.u9'],
        (wDev29.__map['ysy.xprobe.cloud'].acct || {}).prod.token],
      [true, true, 3, { ac: 6, po: 0 }, undefined, 'tok-prod']);
    // 登录没成 ⇒ 一条都不推（不把「验证码错了」粉饰成「已登录但没同步」）
    const wBad29 = runSW({
      native: dbNative29, store: { 'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 },
      byUrl: (u) => (/codeLogin/.test(u) ? { text: JSON.stringify({ code: 500, message: '验证码不对', data: null }) } : { text: '{"code":200}' }),
    });
    const lgBad29 = await wBad29.__call({ t: 'cloudLogin', email: 'a@b.co', code: '9999' }, 4000);
    eq('登录没成 ⇒ 只有那一跳、首趟一个字节不发，存储里也没多出登录态',
      [lgBad29.ok, lgBad29.err, wBad29.__fetchCalls(), wBad29.__map['ysy.xprobe.cloud']],
      [false, '验证码不对', 1, undefined]);
    // 一条腿失败不许把「登录」整件事说成失败，也不许把那条腿静默吞掉（RL-9）
    const wHalf29 = runSW({
      native: dbNative29, store: { 'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 },
      byUrl: (u) => /codeLogin/.test(u) ? { text: okText29({ token: 'tok-x', user: { id: 'u9' } }) }
        : /ingest/.test(u) ? { text: JSON.stringify({ code: 401, message: '请登录', data: null }) }
          : { text: okText29({ ackAc: 1, ackPo: 0 }) },
    });
    const lgHalf29 = await wHalf29.__call({ t: 'cloudLogin', email: 'a@b.co', code: '1234' }, 4000);
    eq('一条腿没成不把登录改成失败（token 已落盘、下一次写还会自动重试），但那条腿的失败原样带回、另一条的成功也照说',
      [lgHalf29.ok, lgHalf29.firstPush.metrics.ok, /不认这把 token/.test(lgHalf29.firstPush.metrics.err || ''),
        lgHalf29.firstPush.bench.ok, lgHalf29.firstPush.bench.wm],
      [true, false, true, true, { ac: 1, po: 0 }]);
    // 「请登录」这一句：带 token 的 401 与没带 token 的 401 是两件事，不能再糊成一句
    const w401 = runSW({
      store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-old', email: 'a@b.co', userId: 'u1' } } }, 'ysy.xprobe.series': SERIES29 },
      byUrl: (u) => ({ text: /ingest/.test(u) ? JSON.stringify({ code: 401, message: '请登录', data: null }) : '{"code":200}' }),
    });
    const r401 = await w401.__call({ t: 'cloudSyncNow' }, 4000);
    ok("服务端那句「请登录」不再被原样转述：本地带着 token 出机器时说的是「服务端不认这把 token」，且不标 needLogin（标了就等于把人推去重收验证码，而那正是本轮的病根）",
      r401.ok === false && !/请登录/.test(r401.err || '') && /不认这把 token/.test(r401.err || '') &&
      r401.needLogin === false && /boot4/.test(r401.err || ''), r401);
    eq('这一句也照原样落进 cloudStat（面板「上次没传成：…」读的就是它），needLogin 不许被顺手置成真',
      [w401.__map['ysy.xprobe.cloudStat'].ok, w401.__map['ysy.xprobe.cloudStat'].needLogin,
        /不认这把 token/.test(w401.__map['ysy.xprobe.cloudStat'].err || '')], [false, false, true]);
    // ---- v0.10.4 补的两条：D-15 的「下一步」要在握着它的人手里，D-9 要念出是哪一台 ----
    // 起因是本轮交付后用户的第二次投诉（16:25）：那句结尾写着「先重新登录一次」，用户真去重登了一遍，
    // 白做一次而问题一个字没动 —— 假动作比没动作更坏，它让人以为是自己没弄好。
    ok('v0.10.4：带着 token 被拒时，那句必须念出是哪一台 boot4 拒的（D-9 按档分家的状态不许只念一半），且不再指挥人去重登/重收验证码（D-15 的下一步必须落在真正握着这件事的人手里）',
      r401.err.indexOf(PROD29) >= 0 && /重新构建|重启/.test(r401.err) &&
      !/先重新登录一次/.test(r401.err) && !/请登录/.test(r401.err), r401.err);
    {
      // 同一句在 dev 档必须报 dev 的地址：不能让人去查线上那台（[26] 给 403 立过的同一口径）
      const w401d = runSW({
        store: { 'ysy.xprobe.cloudEnv': 'dev', 'ysy.xprobe.cloud': { on: true, env: 'dev', acct: { dev: { token: 'tok-dev', email: 'd@b.co', userId: 'u2' } } }, 'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 },
        byUrl: (u) => ({ text: /ingest/.test(u) ? JSON.stringify({ code: 401, message: '请登录', data: null }) : '{"code":200}' }),
      });
      const r401d = await w401d.__call({ t: 'cloudSyncNow' }, 4000);
      ok('dev 档被拒 ⇒ 念的是 127.0.0.1:28081，不许拿线上那台冒充（切档之后「去哪儿修」也跟着换）',
        r401d.err.indexOf(DEV29) >= 0 && r401d.err.indexOf(PROD29) < 0, r401d.err);
      // 变异对照：把 base 那段拼接抠掉 ⇒ 上面那条「念出是哪一台」当场红（证明咬的是这句拼接，不是源码里恰好有 api2 这个词）
      const swCut401 = sw29.replace("+ base + ' 不认这把 token", "+ ' 不认这把 token");
      const wCut401 = runSW({
        src: swCut401,
        store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-old', email: 'a@b.co', userId: 'u1' } } }, 'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 },
        byUrl: (u) => ({ text: /ingest/.test(u) ? JSON.stringify({ code: 401, message: '请登录', data: null }) : '{"code":200}' }),
      });
      const rCut401 = await wCut401.__call({ t: 'cloudSyncNow' }, 4000);
      ok('变异对照（真跑改过的 SW）：把那句里的 base 拼接抠掉 ⇒ 地址当场从这一句里消失（这条判的是拼接真在跑，不是字面恰好在那儿）',
        swCut401 !== sw29 && rCut401.err.indexOf(PROD29) < 0, [swCut401 === sw29, rCut401.err]);
    }
    // ---- v0.10.5（UIX-32）：那句不许替对面断言「跑的是哪一版」——插件根本没有读出对面构建状态的手段 ----
    // 起因就在本轮：v0.10.4 那句写死了「它跑的还是改动前编译的那份字节码」，用户 17:59 重启之后，那句话当场变成假话；
    // 而它假的时候插件正在回 401（token 过期那种真 401 也会撞上这句），于是把人指去重启一个已经重启过的进程 —— 又是一个假动作。
    ok('v0.10.5：带着 token 被拒时，那句只给「按顺序排的两问」并承认对面跑的是哪一版**读不到**（不许把观测不到的服务端状态写成事实），还念得出当前那一档要修的是哪一台',
      !/跑的还是改动前编译/.test(r401.err) && /读不到对面的构建版本/.test(r401.err) &&
      /重启过/.test(r401.err) && /单独部署/.test(r401.err) && r401.err.indexOf(PROD29) >= 0, r401.err);
    {
      // 变异对照：把「写死对面构建状态」那半句塞回 SW ⇒ 上面那条判据必须红（钉的是那条纪律，不是字面恰好没那几个字）
      const swMut401 = sw29.replace('按顺序排两件事：① 对面那台跑的是哪一版判据？',
        '这一下是因为它跑的还是改动前编译的那份字节码 ⇒ 要在那台机器上重新构建 + 重启。');
      const wMut401 = runSW({
        src: swMut401,
        store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-old', email: 'a@b.co', userId: 'u1' } } }, 'ysy.xprobe.series': SERIES29, 'ysy.xprobe.guard': GUARD29 },
        byUrl: (u) => ({ text: /ingest/.test(u) ? JSON.stringify({ code: 401, message: '请登录', data: null }) : '{"code":200}' }),
      });
      const rMut401 = await wMut401.__call({ t: 'cloudSyncNow' }, 4000);
      ok('变异对照（真跑改回的 SW）：把那句写死对面构建状态的话塞回去 ⇒ 上面那条「不许断言观测不到的事」当场红（也证明那条判的是拼接在跑的那一句，不是源码里恰好没有这几个字）',
        swMut401 !== sw29 && /跑的还是改动前编译/.test(rMut401.err) && r401.err.indexOf('跑的还是改动前编译') < 0,
        [swMut401 === sw29, /跑的还是改动前编译/.test(rMut401.err)]);
    }
    const w401b = runSW({ byUrl: () => ({ text: JSON.stringify({ code: 401, message: '请登录', data: null }) }) });
    const cNoTok = await w401b.__call({ t: 'cloudSendCode', email: 'a@b.co' }, 4000);
    ok('正向对照：这一趟本来就没带 token ⇒ 说的才是「这一档还没登录」并标 needLogin、点名去哪儿登录（同一句「请登录」的两种说法不互相冒充）',
      cNoTok.ok === false && cNoTok.needLogin === true && /还没登录/.test(cNoTok.err || '') && /运行模式/.test(cNoTok.err || ''), cNoTok);
    // 面板那几条（自检从不执行 sidepanel.js，只能源码 pin —— 交互要真机验收）
    ok('面板把首趟四条腿各念一句（拉黑那条 v0.11.0 起也在），且有一条腿没成时那一格是 warn 不是 ok（「登录成功」和「数据过去了」是两件事）',
      /function firstPushText\(fp\)/.test(sp29) && /指标与关注台账/.test(sp29) && /标杆台账/.test(sp29) &&
      /抓取档案/.test(sp29) && /fp\.library/.test(sp29) &&
      /拉黑台账/.test(sp29) && /fp\.block/.test(sp29) &&
      /function doCloudLogin\(\)[\s\S]{0,2600}\? 'ok' : 'warn'/.test(sp29), '');
    ok('登录现在要等两条腿回话，所以「正在登录……」那一行写在发命令之前；连点有闸（loginBusy 与 envBusy 同一套路），回包到达即解',
      /function doCloudLogin\(\)[\s\S]{0,1600}正在登录[\s\S]{0,400}send\(\{ t: 'cloudLogin'/.test(sp29) &&
      /if \(loginBusy\) return Promise\.resolve\(\);/.test(sp29) &&
      /let cloudSt = null, cloudCdEnd = 0, logoutArm = 0, envBusy = 0, loginBusy = 0;/.test(sp29) &&
      /function doCloudLogin\(\)[\s\S]{0,1200}loginBusy = Date\.now\(\);[\s\S]{0,600}loginBusy = 0;/.test(sp29), '');
    ok('空邮箱 / 空验证码点「登录」：一条命令都不发，点名填哪一格并把焦点送进去（[27] 那条 UIX-05 的规矩同形扩到第二颗钮）',
      /if \(!email \|\| !code\) \{/.test(sp29) && /\$\(noMail \? 'cloudEmail' : 'cloudCode'\)/.test(sp29) &&
      /el\.focus\(\)/.test(sp29) && /那一格是空的/.test(sp29), '');
    ok('「已登录 …」那句的落点还在 #setNote（不是每 900ms 被 render() 清空的 #report）——[25] 那条老判据依赖的字面没搬丢',
      /noteSet\('已登录 /.test(sp29) && !/\$\('report'\)\.prepend/.test(sp29), '');
    ok('设置页 ❓ 全文跟着改口：写明「登录那一下当场各推一趟」，也写明不把服务端的拒绝转述成「请登录」',
      /v0\.10\.3 起登录成功那一下也当场各推一趟/.test(html29) && /转述成「请登录」/.test(html29), '');
    ok('v0.10.4 立、v0.10.5 补：那一格的全文与 SW 同一口径——点名「是哪一台不认」、说「重新登录换不来它点头」、给出按顺序的两问（对面那台重启过没有 / 线上有没有单独部署）且明说读不到对面的版本；写死对面构建状态的那句在面板与 SW 的真跑字面里都不许出现',
      /点名是哪一台/.test(html29) && /重新登录、重收验证码都换不来它点头/.test(html29) &&
      /单独部署一次/.test(html29) && /读不到对面的构建版本/.test(html29) &&
      !/跑的还是改动前编译/.test(html29) && !/跑的还是改动前编译/.test(sw29.replace(/^\s*\/\/.*$/gm, '')) &&
      !/先重新登录一次/.test(html29) && !/先重新登录一次/.test(sp29) &&
      // sw.js 那段注释里留着旧文案（写清上一版为什么说错），所以判的是「真跑的那一份字面」——与 sp29 去注释同一口径
      !/先重新登录一次/.test(sw29.replace(/^\s*\/\/.*$/gm, '')), '');
    ok('这一轮没有多开一个出口、也没有多要一条权限：登录首趟走的就是原来那两条路（host_permissions 仍是回环三条 + 云域名一条，<all_urls> 仍不在）',
      /"https:\/\/api2\.mingzhang\.cc\/\*"/.test(rd('manifest.json')) &&
      /"http:\/\/127\.0\.0\.1:28081\/\*"/.test(rd('manifest.json')) && !/<all_urls>/.test(rd('manifest.json')), '');
    ok('D-1 的账这一轮也没飘：新写的这些字面里没有「…并…」式动作名（正向对照见 [27]）',
      !/(?:登录|切换|保存|同步|发送)并(?:切|登|换|到|去)/.test(sp29) &&
      !/(?:登录|切换|保存|同步|发送)并(?:切|登|换|到|去)/.test(sw29), '');

    // ---------- v0.10.6 抓取档案自动上送（libsync）----------
    // 与标杆那条同一套「服务端 ack 才抬水位」纪律，但游标换成了 store_users / store_posts 的自增 id。
    // 这里真跑 SW：本机桩回两行账号 + 一行帖子，云端回 ackAu=2 / ackPo=1，看水位、请求体、第二次空页。
    const libRows = {
      lib_users: [
        { id: 1, at: '2026-10-29T01:00:00.000', handle: 'demo_a', name: '甲', followers: 10, following: 5 },
        { id: 2, at: '2026-10-29T02:00:00.000', handle: 'demo_b', name: '', followers: null, following: null },
      ],
      lib_posts: [
        { id: 1, at: '2026-10-29T03:00:00.000', post_id: '9001', handle: 'demo_a', text: '正文', reply: 2, repost: 3, like: 4, view: 100 },
      ],
    };
    const dbLib = (p) => {
      if (!p || p.t !== 'db') return { status: 200, body: '{}' };
      const rows = Number(p.after || 0) === 0 ? (libRows[p.q] || []) : [];
      return { status: 200, body: JSON.stringify({ rows: rows }) };
    };
    const libOk = (d) => ({ text: JSON.stringify({ code: 200, data: d }) });
    const wLib = runSW({
      native: dbLib,
      store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-lib', email: 'l@b.co', userId: 'u1' } } } },
      byUrl: (u) => (/library\/push/.test(u) ? libOk({ ackAu: 2, ackPo: 1 }) : { text: '{"code":200}' }),
    });
    const lr = await wLib.__call({ t: 'libSyncNow' }, 4000);
    const libReqs = wLib.__fetchReqs().filter((x) => /library\/push/.test(x.url));
    const libBody = libReqs.length ? JSON.parse(libReqs[0].init.body) : {};
    eq('v0.10.6 档案上送：本机档案按游标读出来、推到 /api/xprobe/library/push，身份只在请求头',
      [lr.ok, libReqs.length, libReqs.length ? libReqs[0].init.headers.token : '',
        (libBody.au || []).length, (libBody.po || []).length, libBody.deviceId ? 'dev' : ''],
      [true, 1, 'tok-lib', 2, 1, 'dev']);
    eq('档案行的字段形状：账号带 handle/昵称/粉丝/关注（没数就是 null，不拿 0 顶），帖子带推文 id/作者/正文/三项数',
      [(libBody.au || [])[0].handle, (libBody.au || [])[0].fans, (libBody.au || [])[1].fans,
        (libBody.po || [])[0].tweetId, (libBody.po || [])[0].author, (libBody.po || [])[0].like],
      ['demo_a', 10, null, '9001', 'demo_a', 4]);
    eq('水位只抬到服务端给的 ackAu / ackPo，且只写当前那一档+当前那个账号那一格（.prod.u1）——.dev 一个字不动',
      [wLib.__map['ysy.xprobe.libWM.prod.u1'], wLib.__map['ysy.xprobe.libWM.dev'], (wLib.__map['ysy.xprobe.libStat'] || {}).auSent],
      [{ au: 2, po: 1 }, undefined, 2]);
    const lr2 = await wLib.__call({ t: 'libSyncNow' }, 4000);
    eq('第二次跑：after 之后没有新行 ⇒ done 且不再发请求（空页不是错，客户端据此停手）',
      [lr2.ok, lr2.done, wLib.__fetchReqs().filter((x) => /library\/push/.test(x.url)).length, lr2.auSent],
      [true, true, 1, 0]);
    const wLibStall = runSW({
      native: dbLib,
      store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-lib', email: 'l@b.co', userId: 'u1' } } } },
      byUrl: (u) => (/library\/push/.test(u) ? libOk({}) : { text: '{"code":200}' }),
    });
    const lrStall = await wLibStall.__call({ t: 'libSyncNow' }, 4000);
    eq('服务端没回 ack（旧版 boot4）⇒ 水位原地不动（写回 0/0，不是 undefined：收尾那一笔也走同一格）、那句明说下次整批重推',
      [lrStall.ok, wLibStall.__map['ysy.xprobe.libWM.prod.u1'], /ack/.test(lrStall.err || '')],
      [false, { au: 0, po: 0 }, true]);
    ok('自动触发三处都在：采集落库（POST /log）后**当场**推（v0.10.7 从 20 秒去抖改成 0）、30 分钟闹钟兜底、登录成功那一趟给全量批数；手动钮只是兜底',
      /function scheduleLibSync\(ms\)/.test(sw29) && /\/log\(\?:\\\?\|\$\)\/\.test/.test(sw29) &&
      /scheduleLibSync\(0\)/.test(sw29) &&
      /Promise\.all\(\[uploadCloudNow\(\), xsyncRun\(\), libSyncRun\(\{ batches: LIB_MANUAL_BATCHES \}\),/.test(sw29) &&
      /blockSyncRun\(\{ batches: 40 \}\)\]\).then/.test(sw29) &&
      /scheduleBlockSync\(0\)/.test(sw29), '');
    ok('水位按「档 + 账号」各存一本（libWM.<env>.<acct>）：换登录 = 新的一格从 0 开始整本重推，不继承上一个账号推到哪儿',
      /function libWmKey\(env, c\) \{ return LIB_WM_KEY \+ '\.' \+ envOf\(env\) \+ \(acctTag\(c\) \? '\.' \+ acctTag\(c\) : ''\); \}/.test(sw29) &&
      /LIB_WM_KEY = 'ysy\.xprobe\.libWM'/.test(sw29) && /function acctTag\(c\)/.test(sw29), '');
    ok('面板那颗兜底钮与状态行都在（libStat / libWm / bLibRun，切进设置页就回读一次）',
      /id="libStat"/.test(html29) && /id="libWm"/.test(html29) && /id="bLibRun"/.test(html29) &&
      /bLibRun: \(\) => doLibRun\(\)/.test(sp29) && /function libRefresh\(\)/.test(sp29) &&
      /Promise\.all\(\[cloudRefresh\(\), xsRefresh\(\), libRefresh\(\), modelRefresh\(\)\]\)/.test(sp29), '');

    // ---------- v0.10.7 同步进度对账：本地 / 已推 / 待推 / 云端全库 + 换账号不漏推 + 立即推 ----------
    console.log('\n[30] v0.10.7 同步进度对账（按账号分水位 / 落库当场推 / 进度弹窗）');
    // ① 真跑：换账号之后新账号从 0 开始推（不继承上一个账号的水位），老账号那本原样留着
    const wSwap = runSW({
      native: dbLib,
      store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-b', email: 'b@x.co', userId: 'u2' } } },
        'ysy.xprobe.libWM.prod.u1': { au: 99, po: 99 } },
      byUrl: (u) => (/library\/push/.test(u) ? libOk({ ackAu: 2, ackPo: 1 }) : { text: '{"code":200}' }),
    });
    const rSwap = await wSwap.__call({ t: 'libSyncNow' }, 4000);
    eq('换登录（u1 → u2）：新账号从 0 开始推（本机两行账号照发），u1 那本水位一个字没动',
      [rSwap.ok, wSwap.__map['ysy.xprobe.libWM.prod.u1'], wSwap.__map['ysy.xprobe.libWM.prod.u2'],
        (JSON.parse(wSwap.__fetchReqs().filter((x) => /library\/push/.test(x.url))[0].init.body).au || []).length],
      [true, { au: 99, po: 99 }, { au: 2, po: 1 }, 2]);
    // u1 按账号那本已经推到 2/1：正式代码读它 ⇒ 没有新行、一个请求都不发；
    // 把账号后缀抠掉（变异）就读 .prod 那本空账 ⇒ 整批重推。两条一对照，咬的是「按账号分」这段拼接
    const swNoAcct = sw29.split("+ (acctTag(c) ? '.' + acctTag(c) : '')").join('');   // xsWmKey 与 libWmKey 两处一起抠（只抠第一处会抠到 xs 那条，变异根本没落到被测的腿上）
    const wNoAcct = runSW({
      src: swNoAcct, native: dbLib,
      store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-lib', email: 'l@b.co', userId: 'u1' } } },
        'ysy.xprobe.libWM.prod': { au: 0, po: 0 }, 'ysy.xprobe.libWM.prod.u1': { au: 2, po: 1 } },
      byUrl: (u) => (/library\/push/.test(u) ? libOk({ ackAu: 2, ackPo: 1 }) : { text: '{"code":200}' }),
    });
    await wNoAcct.__call({ t: 'libSyncNow' }, 4000);
    ok('变异对照（真跑改过的 SW）：把 libWmKey 的账号后缀抠掉 ⇒ 读的是 .prod 那本空账（0/0），本机两行又整批推一遍——这正是 v0.10.6 换账号漏推/重推两头错的病根，判据咬的就是那段拼接',
      swNoAcct !== sw29 &&
      wNoAcct.__fetchReqs().filter((x) => /library\/push/.test(x.url)).length === 1 &&
      wLib.__fetchReqs().filter((x) => /library\/push/.test(x.url)).length === 1, '');
    // ② 真跑：POST /log 落库之后**当场**排一趟（不再等 20 秒），且这一趟真的打到 library/push
    const wNow = runSW({
      native: dbLib,
      store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-lib', email: 'l@b.co', userId: 'u1' } } } },
      byUrl: (u) => (/library\/push/.test(u) ? libOk({ ackAu: 2, ackPo: 1 }) : { text: '{"code":200}' }),
    });
    await wNow.__call({ t: 'xhr', url: 'http://127.0.0.1:8765/log', method: 'POST', data: '{"records":[]}' }, 3000);
    await new Promise((r) => setTimeout(r, 120));
    eq('采集落库（POST /log）之后当场就有 library/push 打出去（不用等 20 秒：直连接口时迟到的帖就是查不到）',
      [wNow.__fetchReqs().filter((x) => /library\/push/.test(x.url)).length, (wNow.__map['ysy.xprobe.libWM.prod.u1'] || {}).au],
      [1, 2]);
    // ③ 真跑：进度对账 = 本机两条统计 + 云端一条只读计数，且账号/帖子/待推都算对
    const statRows = {
      lib_user_stat: [{ total: 5, synced: 3, max_id: 42 }],
      lib_post_stat: [{ total: 9, synced: 9, max_id: 77 }],
      lib_users: [], lib_posts: [],
    };
    const dbStat = (p) => {
      if (!p || p.t !== 'db') return { status: 200, body: '{}' };
      return { status: 200, body: JSON.stringify({ rows: statRows[p.q] || [] }) };
    };
    const wStats = runSW({
      native: dbStat,
      store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-lib', email: 'l@b.co', userId: 'u1' } } },
        'ysy.xprobe.libWM.prod.u1': { au: 30, po: 77 } },
      byUrl: (u) => (/library\/stats/.test(u) ? libOk({ accounts: 1234, posts: 5678 }) : { text: '{"code":200}' }),
    });
    const rStats = await wStats.__call({ t: 'libStats' }, 4000);
    const statsReq = wStats.__fetchReqs().filter((x) => /library\/stats/.test(x.url));
    eq('进度对账：本地 5 个账号 / 9 条帖、已推 3 / 9、待推 2 / 0，云端全库 1234 / 5678；水位按账号那本读（30 / 77）',
      [rStats.ok, rStats.local.au, rStats.local.po, rStats.cloud, rStats.wm, statsReq.length, statsReq.length ? statsReq[0].init.headers.token : ''],
      [true, { total: 5, synced: 3, pending: 2 }, { total: 9, synced: 9, pending: 0 }, { au: 1234, po: 5678, bl: null }, { au: 30, po: 77 }, 1, 'tok-lib']);
    ok('统计查询只带 after 一个参数（limit 对它们没有意义），没登录时不去问云端、本地照样算得出来',
      /dbq\(\{ q: 'lib_user_stat', after: wm\.au \}\)/.test(sw29) && /dbq\(\{ q: 'lib_post_stat', after: wm\.po \}\)/.test(sw29) &&
      /if \(!c\.on \|\| !c\.token\) return Object\.assign\(base, \{ ok: true, logged: false, cloud: null, err: '' \}\)/.test(sw29), '');
    const wStatsAnon = runSW({ native: dbStat, store: {} });
    const rAnon = await wStatsAnon.__call({ t: 'libStats' }, 4000);
    eq('正向对照（没登录）：本地统计照算、云端那列是 null、一条云请求都不发',
      [rAnon.ok, rAnon.logged, rAnon.cloud, wStatsAnon.__fetchReqs().filter((x) => /library\/stats/.test(x.url)).length],
      [true, false, null, 0]);
    // ④ 面板：进度行与弹窗都在，且「云端全库 / 评论未采集」这两句口径没被写丢
    ok('面板多了「同步进度」那一行与弹窗（libCount / bLibStats / openLibStatsModal），表头是「类型 / 本地 / 已推 / 待推 / 云端全库」',
      /id="libCount"/.test(html29) && /id="bLibStats"/.test(html29) &&
      /bLibStats: \(\) => openLibStatsModal\(\)/.test(sp29) && /function openLibStatsModal\(\)/.test(sp29) &&
      /'类型', '本地', '已推', '待推', '云端全库'/.test(sp29) && /class="syncTbl"|className = 'syncTbl'/.test(sp29), '');
    ok('弹窗里两件不能含糊的事：云端那列写「全库计数（不是你的）」、评论那行写「未采集」（本机只有回复数，没抓正文）',
      /不是「你的」条数/.test(sp29) && /未采集/.test(sp29) &&
      /全平台所有设备一起写进去的/.test(sp29) && /id="lsNote"|note\.id = 'lsNote'/.test(sp29), '');
    ok('这一轮也没有为同步另立一张本地记录表：账本仍是水位那一格（另立一张就会跟水位对不上）',
      !/CREATE TABLE[^\n]*sync/i.test(rd('../xprobe_db.py')) && /服务端 ack 水位就是账/.test(rd('../xprobe_db.py')), '');

    // ---------- v0.11.0 标杆云端直读直写：点一下就推、刷新读接口、删也是接口 ----------
    // 用户原话：「应该实时的，也就是我在页面点击 加入标杆账号 和帖子 就会推过去，刷新页面回显也是请求api，
    // 删除也是api 实时的」。本机台账不退休：它是**发件箱**（补推那条腿照旧），读的那一眼以接口为准。
    console.log('\n[31] v0.11.0 标杆云端直读直写（本机模式回 needLocal / 云端模式接口优先 / 点一下就写）');
    {
      const sw31 = rd('background/sw.js'), core31 = rd('content/core.js');
      // ① 本机模式：两条命令都当场回 needLocal、一条请求都不发（调用方据此退回本机库 = 发件箱 + 只读缓存）
      const wLocal31 = runSW({ store: {} });
      const qLocal31 = await wLocal31.__call({ t: 'benchQuery', kind: 'ac' }, 4000);
      const mLocal31 = await wLocal31.__call({ t: 'benchMark', kind: 'ac', bizKey: 'demo_a', state: 1 }, 4000);
      eq('本机模式：benchQuery / benchMark 都回 needLocal、零请求（「没开云端」不是错误，页面照常读本机库）',
        [qLocal31.ok, qLocal31.needLocal, qLocal31.why, mLocal31.needLocal, mLocal31.why, wLocal31.__fetchCalls()],
        [false, true, 'off', true, 'off', 0]);
      // ② 开了云端模式但这档没登录：needLocal 且 why=login（不许把「没登录」说成「接口坏了」）
      const wNoTok31 = runSW({ store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: {} } } });
      const qNoTok31 = await wNoTok31.__call({ t: 'benchQuery', kind: 'ac' }, 4000);
      eq('开了云端模式但这档没登录：也回 needLocal（why=login）、不发请求',
        [qNoTok31.needLocal, qNoTok31.why, wNoTok31.__fetchCalls()], [true, 'login', 0]);
      // ③ 真跑：读名单 = POST /api/xprobe/bench/list，身份只在 token 头，行按顶层 rows 摊平带回
      const LIST31 = [{ bizKey: 'demo_a', state: 1, name: '甲', tags: '投资', views: 12 }, { bizKey: 'demo_b', state: 0 }];
      const wQ31 = runSW({
        store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-bq', email: 'q@b.co', userId: 'u1' } } } },
        byUrl: () => ({ text: okText29({ rows: LIST31, total: 2 }) }),
      });
      const rQ31 = await wQ31.__call({ t: 'benchQuery', kind: 'ac', size: 500 }, 4000);
      const reqQ31 = wQ31.__fetchReqs().filter((x) => /bench\/list/.test(x.url));
      eq('读名单：POST https://api2.mingzhang.cc/api/xprobe/bench/list，身份只在 token 头、体里只有 kind/size，row 按顶层 rows 摊平；' +
        '出机器的 kind 是服务端认的全名（面板内部叫 ac，发 ' + "'ac' 会被「不认就当 account」静默降级）",
        [rQ31.ok, rQ31.rows, rQ31.total, reqQ31.length, reqQ31[0] && reqQ31[0].url,
          reqQ31[0] && reqQ31[0].init.headers.token, reqQ31[0] && JSON.parse(reqQ31[0].init.body),
          reqQ31[0] && String(reqQ31[0].init.body).indexOf('tok-bq') < 0],
        [true, LIST31, 2, 1, 'https://api2.mingzhang.cc/api/xprobe/bench/list', 'tok-bq', { kind: 'account', size: 500 }, true]);
      // ④ 真跑：抽屉里「TA 的帖子」= POST /api/xprobe/library/posts（带 author，不再读本机库）
      const wQP31 = runSW({
        store: { 'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-bq', email: 'q@b.co', userId: 'u1' } } } },
        byUrl: () => ({ text: okText29({ author: 'demo_a', total: 1, rows: [{ tweet_id: '9001', author: 'demo_a', view: 7 }] }) }),
      });
      const rQP31 = await wQP31.__call({ t: 'benchQuery', q: 'posts', author: 'demo_a', size: 30 }, 4000);
      const reqQP31 = wQP31.__fetchReqs().filter((x) => /library\/posts/.test(x.url));
      eq('抽屉的帖子列表也走接口（/api/xprobe/library/posts）：author 进体、token 进头、行摊平',
        [rQP31.ok, rQP31.rows[0].tweet_id, reqQP31.length, JSON.parse(reqQP31[0].init.body), reqQP31[0].init.headers.token],
        [true, '9001', 1, { author: 'demo_a', size: 30 }, 'tok-bq']);
      // ⑤ 真跑：点「标人」= 当场 POST /bench/mark；deviceId 由 SW 补，没数的格子一个字不带（RL-11）
      const wM31 = runSW({
        store: { 'ysy.xprobe.deviceId': 'dev-00001',
          'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-bm', email: 'm@b.co', userId: 'u1' } } } },
        byUrl: () => ({ text: okText29({ marked: 1 }) }),
      });
      const rM31 = await wM31.__call({ t: 'benchMark', kind: 'ac', bizKey: 'demo_a', state: 0, name: '甲', tags: '投资',
        at: '2026-10-30T01:02:03Z', day: '2026-10-30', fans: 10, fow: null, postsN: '', views: undefined, eng: 0 }, 4000);
      const reqM31 = wM31.__fetchReqs().filter((x) => /bench\/mark/.test(x.url));
      const bodyM31 = reqM31.length ? JSON.parse(reqM31[0].init.body) : {};
      eq('点「移出」当场写接口：state=0 原样发、deviceId 由 SW 补、bizKey 不改大小写；没数的格子一个都不带（fans 留、fow/postsN 不带、eng=0 是真数要带）',
        [rM31.ok, reqM31.length, reqM31[0] && reqM31[0].url, reqM31[0] && reqM31[0].init.headers.token,
          bodyM31.kind, bodyM31.state, bodyM31.deviceId, bodyM31.bizKey, bodyM31.fans, bodyM31.fow, bodyM31.postsN, bodyM31.eng,
          'fow' in bodyM31, 'postsN' in bodyM31],
        [true, 1, 'https://api2.mingzhang.cc/api/xprobe/bench/mark', 'tok-bm', 'account', 0, 'dev-00001', 'demo_a', 10, null, null, 0, false, false]);
      // ⑥ 真跑：标帖走同一格（kind=po），正文与发帖时刻都在体里
      const wMP31 = runSW({
        store: { 'ysy.xprobe.deviceId': 'dev-00001',
          'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-bm', email: 'm@b.co', userId: 'u1' } } } },
        byUrl: () => ({ text: okText29({ marked: 1 }) }),
      });
      await wMP31.__call({ t: 'benchMark', kind: 'po', bizKey: '9001', state: 1, author: 'demo_a', text: '正文快照',
        view: null, reply: 3, timeDatetime: '2026-10-29T10:00:00Z' }, 4000);
      const bodyMP31 = JSON.parse(wMP31.__fetchReqs().filter((x) => /bench\/mark/.test(x.url))[0].init.body);
      eq('标帖：出机器是 kind=post（不是内部短名 po）+ bizKey=推文 id，带 author/正文/回复数/发帖时刻，view=null 不带（没数就是没数）',
        [bodyMP31.kind, bodyMP31.bizKey, bodyMP31.author, bodyMP31.text, bodyMP31.reply, bodyMP31.timeDatetime, 'view' in bodyMP31],
        ['post', '9001', 'demo_a', '正文快照', 3, '2026-10-29T10:00:00Z', false]);
      // ⑥b 认不出来的 kind：当场回错、一条请求都不发（以前这里没有闸，短名一路发到服务端被降成 account）
      const wUK31 = runSW({
        store: { 'ysy.xprobe.deviceId': 'dev-00001',
          'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-bm', email: 'm@b.co', userId: 'u1' } } } },
        byUrl: () => ({ text: okText29({ marked: 1 }) }),
      });
      const rUKM31 = await wUK31.__call({ t: 'benchMark', kind: 'po', bizKey: '9001', state: 1 }, 4000);
      const rUKQ31 = await wUK31.__call({ t: 'benchQuery', kind: 'post', size: 5 }, 4000);
      const rUKBad31 = await wUK31.__call({ t: 'benchMark', kind: 'benchpost', bizKey: '9001', state: 1 }, 4000);
      eq('kind 只有 ac/po 两个内部短名认：别的（含服务端的全名 post、台账用的 benchpost）当场回错且不发请求（不替用户猜一个）',
        [rUKM31.ok, rUKQ31.ok, rUKBad31.ok, /不认识/.test(rUKBad31.err || ''), wUK31.__fetchReqs().length],
        [true, false, false, true, 1]);
      // ⑦ 接口那一跳没成 ⇒ ok:false 且**不许**标 needLocal（调用方要如实说「接口没写进去」，而不是退回本机了事）
      const wMF31 = runSW({
        store: { 'ysy.xprobe.deviceId': 'dev-00001',
          'ysy.xprobe.cloud': { on: true, env: 'prod', acct: { prod: { token: 'tok-bm', email: 'm@b.co', userId: 'u1' } } } },
        byUrl: () => ({ text: JSON.stringify({ code: 500, message: '写库失败', data: null }) }),
      });
      const rMF31 = await wMF31.__call({ t: 'benchMark', kind: 'ac', bizKey: 'demo_a', state: 1 }, 4000);
      ok('写入接口失败：原样回 ok:false + 服务端那句话，且不标 needLocal（「接口坏了」不许被说成「没登录」）',
        rMF31.ok === false && !rMF31.needLocal && /写库失败/.test(rMF31.err || ''), rMF31);
      // ⑧ 真跑 core：刷新后读过接口，云端在榜的人这一页也认（不是只信本机台账）
      const oldBench31 = store['ysy.xprobe.bench'];
      store['ysy.xprobe.bench'] = {};
      const sb31 = run(profile, '/demo_own', 'https://x.com/demo_own');
      sb31.chrome.runtime.sendMessage = (m, cb) => {
        if (m && m.t === 'benchQuery') {
          if (m.kind === 'ac') cb({ ok: true, rows: [
            { bizKey: 'Cloud_A', state: 1, name: '云甲', tags: '投资,AI' }, { bizKey: 'cloud_dead', state: 0 }] });
          else cb({ ok: true, rows: [{ bizKey: '9001', state: 1, author: 'cloud_a', tags: 'AI' }] });
          return;
        }
        cb(undefined);
      };
      await tick(); await tick();   // 先让 boot 自己那一趟（默认 sendMessage 回 undefined ⇒ needLocal）走完，别跟 busy 闸抢
      const hyd31 = await sb31.__xprobe.benchCloudHydrate(true);
      ok('刷新回显走接口：云端在榜的人与帖这一页都认（bizKey 大小写归一，state=0 的不算）',
        hyd31 === true && sb31.__xprobe.isBench('cloud_a') && !sb31.__xprobe.isBench('cloud_dead') &&
        sb31.__xprobe.isBenchP('9001'), [hyd31, sb31.__xprobe.isBench('cloud_a'), sb31.__xprobe.isBench('cloud_dead')]);
      eq('云端名单的标签与计数带上（窗口页头读的就是这一份，不另开一条查询）',
        [sb31.__xprobe.benchCount(), sb31.__xprobe.benchTagsOf('cloud_a'), sb31.__xprobe.benchPCount(), sb31.__xprobe.benchPTagsOf('9001')],
        [1, '投资,AI', 1, 'AI']);
      // ⑨ 云端在榜、本机台账空着的人：点一下必须是「移出」（v0.9.4 那个晚水合病根在云端这层的同一形）
      const off31 = sb31.__xprobe.benchToggle('cloud_a');
      ok('云端在榜但本机台账没写过的人，点一下是移出而不是再标一遍（开关判的是读穿后的账）',
        off31 && off31.on === false && sb31.__xprobe.isBench('cloud_a') === false && !!sb31.__xprobe.__benchCloud().goneAc.cloud_a, off31);
      // ⑩ 刚移出的人不许被晚到的列表回包又画回在榜
      await sb31.__xprobe.benchCloudHydrate(true);
      ok('台账已移出、列表回包晚到：不许把人又画回「已标杆」（本会话墓碑压住旧回包）',
        sb31.__xprobe.isBench('cloud_a') === false && sb31.__xprobe.benchCount() === 0,
        sb31.__xprobe.__benchCloud());
      if (oldBench31 === undefined) delete store['ysy.xprobe.bench']; else store['ysy.xprobe.bench'] = oldBench31;
      // ⑪ 源码口径：读的两条路都以接口优先、本机库只当缓存；写的那一路挂在两本台账后面
      ok('读源次序写死在两处：fetchBench / fetchBenchPosts 先 benchAskApi（src=api），没开或没登录才 dbAsk 本机库（src=local）',
        /benchAskApi\(\{ q: 'bench', kind: 'ac', size: BENCH_DB_LIMIT \}\)\.then/.test(core31) &&
        /box\.src = 'api'/.test(core31) && /benchData\.src = 'local'/.test(core31) &&
        /benchAskApi\(\{ q: 'posts', author: k, size: BENCH_POSTS_LIMIT \}\)\.then/.test(core31), '');
      ok('写的那一路挂在两本台账后面：benchWrite / benchPWrite 都当场 benchPushMark（本机台账仍是发件箱，补推那條腿照旧）',
        /benchPushMark\(\{\s*kind: 'ac'/.test(core31) && /benchPushMark\(\{\s*kind: 'po'/.test(core31) &&
        /接口没写进去：/.test(core31) && /台账已记，失败会按设置的间隔自动补推/.test(core31), '');
      // 内部短名（ac/po）与出机器的全名（account/post）分家：这一跳上回没人钉，短名一路发到服务端被「不认就当 account」
      // 降成标人 ⇒ 页面按 kind='post' 读不到自己标的帖。核心口径是「一份契约四跳同名」（RL-26），这里就是第三跳。
      ok('出口只从 BENCH_KIND 那张表出全名，且两条 bench 出口都过 benchKind()；短名字面不许再出现在 fetch 体里',
        /const BENCH_KIND = \{ ac: 'account', po: 'post' \}/.test(sw31) &&
        /const kind = benchKind\(m\.kind\);/.test(sw31) &&
        /kind: kind, bizKey: String\(m\.bizKey \|\| ''\)/.test(sw31) &&
        !/kind: m\.kind === 'po'\s*\?\s*'po'\s*:\s*'ac'/.test(sw31) &&
        (sw31.match(/const kind = benchKind\(m\.kind\);/g) || []).length === 2, '');
      ok('回显那层在开机与 5 分钟各拉一次（不靠用户点开窗口才对齐），开关命令与 two kinds 都在 SW 里',
        /benchCloudHydrate\(false\);/.test(core31) && /benchCloudHydrate\(false\); \}, 300000\)/.test(core31) &&
        /if \(msg\.t === 'benchQuery'\)/.test(sw31) && /if \(msg\.t === 'benchMark'\)/.test(sw31), '');
    }

    // ---------- v0.11.0 拉黑上云：blocks 台账 → xprobe_block ----------
    // 用户原话：「需要拉黑上云啊，确保把抓取到的账号的回关率，还有自己账号的拉黑记录 都同步到java数据库」。
    // 回关率不另推一遍：它由抓取档案那条腿进的 x_probe_account.fans / fow 两列算得出来，再推就是同一事实存两份；
    // 这里推的是「我自己拉黑谁、什么时候拉的」—— blocks 是 append-only 进/出流水（state=0 是取消行），
    // 服务端按业务键取最新一条判「现在还拉不拉黑」，所以取消也必须推上去，不能只推 state=1。
    console.log('\n[32] v0.11.0 拉黑上云（block_marks 游标 / ackBl 水位 / 进度弹窗那一行）');
    {
      const sw32 = rd('background/sw.js'), db32src = rd('../xprobe_db.py'),
        core35src = rd('content/core.js'), panel35src = rd('ui/sidepanel.js');
      const blRows32 = [
        { id: 11, at: '2026-10-30T01:00:00.000', day: '2026-10-30', handle: 'demo_bad', name: '坏', state: 1, url: 'https://x.com/demo_bad' },
        { id: 12, at: '2026-10-30T02:00:00.000', day: '2026-10-30', handle: 'demo_ok', name: '', state: 0, url: '' },
      ];
      const dbBlk32 = (p) => {
        if (!p || p.t !== 'db') return { status: 200, body: '{}' };
        const rows = p.q === 'block_marks' ? (Number(p.after || 0) === 0 ? blRows32 : []) : [];
        return { status: 200, body: JSON.stringify({ ok: true, rows: rows }) };
      };
      const conf32 = { on: true, env: 'prod', acct: { prod: { token: 'tok-blk', email: 'b@x.co', userId: 'u1' } } };
      // ① 真跑：blockSyncNow = 读 block_marks(0) → POST /block/push；身份只在 token 头，水位只抬到 ackBl
      const wBlk32 = runSW({
        native: dbBlk32,
        store: { 'ysy.xprobe.deviceId': 'dev-00001', 'ysy.xprobe.cloud': conf32 },
        byUrl: (u) => (/block\/push/.test(u) ? libOk({ ackBl: 12, blRecv: 2, blNew: 2 }) : { text: '{"code":200}' }),
      });
      const rBlk32 = await wBlk32.__call({ t: 'blockSyncNow' }, 4000);
      const blReqs32 = wBlk32.__fetchReqs().filter((x) => /block\/push/.test(x.url));
      const blBody32 = blReqs32.length ? JSON.parse(blReqs32[0].init.body) : {};
      eq('拉黑上送：POST /api/xprobe/block/push，token 只在请求头，body 带 deviceId + 整批 bl（id/at/day/handle/name/state/url，取消行 state=0 也在）',
        [rBlk32.ok, blReqs32.length, blReqs32.length ? blReqs32[0].init.headers.token : '',
          blBody32.deviceId, (blBody32.bl || []).map((x) => x.id), (blBody32.bl || []).map((x) => x.state),
          (blBody32.bl || [])[0].handle, (blBody32.bl || [])[0].day, 'token' in blBody32],
        [true, 1, 'tok-blk', 'dev-00001', [11, 12], [1, 0], 'demo_bad', '2026-10-30', false]);
      eq('水位只抬到服务端回的 ackBl=12（写当前档+当前账号那一格），拉黑统计那格同时落 sent/done/ok',
        [wBlk32.__map['ysy.xprobe.blockWM.prod.u1'], (wBlk32.__map['ysy.xprobe.blockStat'] || {}).sent,
          (wBlk32.__map['ysy.xprobe.blockStat'] || {}).done, (wBlk32.__map['ysy.xprobe.blockStat'] || {}).ok],
        [{ bl: 12 }, 2, true, true]);
      const rBlk32b = await wBlk32.__call({ t: 'blockSyncNow' }, 4000);
      eq('第二次跑：12 之后没有新行 ⇒ done、sent 0、一个请求都不再发（空页不是错，客户端据此停手）',
        [rBlk32b.ok, rBlk32b.done, rBlk32b.sent,
          wBlk32.__fetchReqs().filter((x) => /block\/push/.test(x.url)).length],
        [true, true, 0, 1]);
      // ② 服务端没回 ackBl（对面是旧版 boot4）：这一趟算没成、水位停在 0 —— 不许「看起来推完了」把游标往前挪
      const wStall32 = runSW({
        native: dbBlk32,
        store: { 'ysy.xprobe.deviceId': 'dev-00001', 'ysy.xprobe.cloud': conf32 },
        byUrl: () => libOk({ blRecv: 2 }),
      });
      const rStall32 = await wStall32.__call({ t: 'blockSyncNow' }, 4000);
      eq('服务端没回 ackBl：如实算没成、水位停在 0（下次整批重推，唯一键去重不会落第二行）',
        [rStall32.ok, rStall32.wm, (wStall32.__map['ysy.xprobe.blockWM.prod.u1'] || {}).bl, /ackBl/.test(rStall32.err || '')],
        [false, 0, 0, true]);
      // ③ 采集落库（POST /log）之后当场排一趟：拉黑动作和采集记录同批进库，用户不用等 5 分钟那颗钟
      const wLog32 = runSW({
        native: dbBlk32,
        store: { 'ysy.xprobe.deviceId': 'dev-00001', 'ysy.xprobe.cloud': conf32 },
        byUrl: (u) => (/block\/push/.test(u) ? libOk({ ackBl: 12 }) : { text: '{"code":200}' }),
      });
      await wLog32.__call({ t: 'xhr', url: 'http://127.0.0.1:8765/log', method: 'POST', data: '{"records":[]}' }, 3000);
      await new Promise((r) => setTimeout(r, 160));
      eq('采集落库之后当场就有一趟 block/push（与档案/标杆同一条「落库成功」信号，不另开心跳）',
        [wLog32.__fetchReqs().filter((x) => /block\/push/.test(x.url)).length, (wLog32.__map['ysy.xprobe.blockWM.prod.u1'] || {}).bl],
        [1, 12]);
      // ④ 进度对账多一行拉黑：每个 handle 只看最新一行（block_stat 自己算），云端那格是「你自己」名单上的人数
      const statRows32 = {
        lib_user_stat: [{ total: 5, synced: 5, max_id: 42 }],
        lib_post_stat: [{ total: 9, synced: 9, max_id: 77 }],
        lib_users: [], lib_posts: [],
      };
      const dbStat32 = (p) => {
        if (!p || p.t !== 'db') return { status: 200, body: '{}' };
        if (p.q === 'block_stat') {
          const after = Number(p.after || 0);
          return { status: 200, body: JSON.stringify({ ok: true, rows: [{ total: 4, synced: after > 0 ? 1 : 0, max_id: 12 }] }) };
        }
        return { status: 200, body: JSON.stringify({ ok: true, rows: statRows32[p.q] || [] }) };
      };
      const wSt32 = runSW({
        native: dbStat32,
        store: { 'ysy.xprobe.cloud': conf32, 'ysy.xprobe.blockWM.prod.u1': { bl: 12 } },
        byUrl: (u) => (/library\/stats/.test(u) ? libOk({ accounts: 1234, posts: 5678, blocks: 3 }) : { text: '{"code":200}' }),
      });
      const rSt32 = await wSt32.__call({ t: 'libStats' }, 4000);
      eq('进度对账多一行拉黑：本地 4 个 handle（每键取最新一条）、已推 1、待推 3；云端那格是「你自己」名单上还剩 3 人',
        [rSt32.ok, rSt32.block.wm.bl, rSt32.block.local, rSt32.cloud],
        [true, 12, { total: 4, synced: 1, pending: 3 }, { au: 1234, po: 5678, bl: 3 }]);
      ok('block_stat 只带 after 一个参数（水位是唯一游标，limit 对它没有意义），且带的是按账号那本水位（12）',
        wSt32.__nativeQ.some((x) => x.payload && x.payload.q === 'block_stat' && Number(x.payload.after) === 12), wSt32.__nativeQ);
      // ⑤ 没登录：本地拉黑照算（水位 0），云端那格 null，一条云请求都不发
      const wAnon32 = runSW({ native: dbStat32, store: {} });
      const rAnon32 = await wAnon32.__call({ t: 'libStats' }, 4000);
      eq('没登录：拉黑那行本地照算（水位 0 ⇒ 已推 0 / 待推 4），云端那格 null，一条 /library/stats 都不发',
        [rAnon32.ok, rAnon32.logged, rAnon32.cloud, rAnon32.block.local,
          wAnon32.__fetchReqs().filter((x) => /library\/stats/.test(x.url)).length],
        [true, false, null, { total: 4, synced: 0, pending: 4 }, 0]);
      // ⑥ 本机库还是旧版（不认 block_stat）：拉黑那行给 null —— 不拿 0 冒充「一条都没拉黑过」
      const wOld32 = runSW({
        native: (p) => (p && p.q === 'block_stat'
          ? { status: 200, body: JSON.stringify({ ok: false, err: '未知查询 block_stat' }) }
          : { status: 200, body: JSON.stringify({ ok: true, rows: [{ total: 0, synced: 0, max_id: 0 }] }) }),
        store: {},
      });
      const rOld32 = await wOld32.__call({ t: 'libStats' }, 4000);
      eq('本机库旧版不认 block_stat：拉黑那行给 null，不编 0（0 会被人读成「我真的一条都没拉黑过」）',
        [rOld32.ok, rOld32.block], [true, null]);
      // ⑦ 面板与源码口径
      ok('面板弹窗多一行「拉黑」，并写明这行的云端列是**你自己**名单上的人数（私有账），与上面两行的全库计数不同',
        /row\('拉黑', 'Bl'\)/.test(sp29) && /set\('lsBlTotal'/.test(sp29) && /set\('lsBlCloud'/.test(sp29) &&
        /xprobe_block/.test(sp29) && /私有账/.test(sp29) && /不是「你的」条数/.test(sp29), '');
      ok('SW 三处接线都在：blockSyncNow 命令、ackBl 才抬水位、/log 与闹钟两颗触发都排这一趟',
        /if \(msg\.t === 'blockSyncNow'\)/.test(sw32) && /ackOf\(d\.ackBl, wm\)/.test(sw32) &&
        /o\[blockWmKey\(c\.env, c\)\] = \{ bl: wm \}/.test(sw32) &&
        (sw32.match(/scheduleBlockSync\(0\)/g) || []).length >= 2, '');
      ok('本机库两条白名单查询进了 xprobe_db.py：block_marks（after+limit 两占位）与 block_stat（只吃 after），DB_VER 停在 db-10（v0.11.5 的 own_posts 随 v0.11.6 撤净：源码里不许再有这条名字）',
        /"block_marks": "SELECT s\.id, s\.at/.test(db32src) && /"block_stat":/.test(db32src) &&
        /DB_VER = "db-10"/.test(db32src) && !/"own_posts":/.test(db32src) && !/own_posts/.test(core35src || ''), '');
    }

    // ---------- v0.11.1 档案同步：一条腿「推完了」不许被下一条批读成「服务端没回 ack」----------
    // 真机的形状：197 人早就追平（水位顶到本地最大 id ⇒ 账号页每批都是空页、服务端 ackAu 回 0 是对的，
    // 它确实一行没处理），帖子页还剩 5,108 行。旧写法把「不满一页 = 这条腿完了」和「有行没往前走 = 卡住」
    // 塞进同一个 stopAu，于是第二批带着第一批留下的「完成」标记撞上卡住判断 ⇒ 假报错 + 整趟中止，
    // 每趟只走 1,000 行、要跑六趟。面板那句「对面是旧版 boot4？」就是这么来的（对面其实是新版）。
    console.log('\n[33] v0.11.1 档案同步：账号腿推完了不能中止整趟（假 ackAu / 每趟只走 1000 行）');
    {
      const sw33 = rd('background/sw.js');
      // 桩：账号页永远空；帖子页前两批各 500 行（满页 = 还有得推），第三批 200 行（不满 = 追平）
      const libPage33 = (after) => {
        const n = after < 1000 ? 500 : 200;
        return Array.from({ length: n }, (_, i) => ({
          id: after + i + 1, at: '2026-10-30T04:00:00.000', post_id: String(700000 + after + i),
          handle: 'demo_a', text: '正文', reply: 1, repost: 1, like: 1, view: 10,
        }));
      };
      const dbLib33 = (p) => {
        if (!p || p.t !== 'db') return { status: 200, body: '{}' };
        const after = Number(p.after || 0);
        return { status: 200, body: JSON.stringify({ ok: true, rows: p.q === 'lib_posts' ? libPage33(after) : [] }) };
      };
      // 服务端照 v0.11.0 那一版回：这一批没收到账号行 ⇒ ackAu=0（不是没回，是没得回），帖子回这批最大 id
      const byUrl33 = (u, init) => {
        if (!/library\/push/.test(u)) return { text: '{"code":200}' };
        const body = JSON.parse(String(init.body || '{}'));
        const ids = (body.po || []).map((r) => Number(r.id));
        return { text: JSON.stringify({ code: 200, data: { ackAu: 0, ackPo: ids.length ? Math.max.apply(null, ids) : 0, poRecv: ids.length } }) };
      };
      const conf33 = { on: true, env: 'prod', acct: { prod: { token: 'tok-33', email: 'l@b.co', userId: 'u1' } } };
      const wFix33 = runSW({ native: dbLib33, store: { 'ysy.xprobe.cloud': conf33 }, byUrl: byUrl33 });
      const rFix33 = await wFix33.__call({ t: 'libSyncNow' }, 6000);
      const reqFix33 = wFix33.__fetchReqs().filter((x) => /library\/push/.test(x.url));
      eq('账号腿空页 + 帖子腿满页 ⇒ 整趟照跑到追平：三批 1,200 行都推出去、done 且没有那句假「服务端没回 ackAu」',
        [rFix33.ok, rFix33.done, rFix33.err, rFix33.batches, rFix33.auSent, rFix33.poSent,
          rFix33.wm, reqFix33.length],
        [true, true, '', 3, 0, 1200, { au: 0, po: 1200 }, 3]);
      ok('账号腿推完之后就再也不读它（第一批就把「不满一页」当完成，后面两批零次 lib_users 空查）',
        wFix33.__nativeQ.filter((x) => x.payload && x.payload.q === 'lib_users').length === 1,
        wFix33.__nativeQ.map((x) => x.payload && x.payload.q).join(','));
      // 变异对照：把两条 stall 判断改回旧写法（沿用上一条批留下的 stop 标记），真机那三笔数字当场重现
      const swOld33 = sw33
        .split('stallAu = aus.length > 0 && wm.au === before.au;')
        .join('stallAu = stopAu || (aus.length > 0 && wm.au === before.au);')
        .split('stallPo = pos.length > 0 && wm.po === before.po;')
        .join('stallPo = stopPo || (pos.length > 0 && wm.po === before.po);');
      const wOld33 = runSW({ src: swOld33, native: dbLib33, store: { 'ysy.xprobe.cloud': conf33 }, byUrl: byUrl33 });
      const rOld33 = await wOld33.__call({ t: 'libSyncNow' }, 6000);
      ok('变异对照（真跑改回旧写法的 SW）：第二批一开局就被第一批的「推完了」判成卡住 ⇒ 假 ackAu、整趟中止，'
        + '库里只剩 1,000 行——与真机 14:04 那趟存下来的 batches:2 / poSent:1000 / auSent:0 逐字对上',
        swOld33 !== sw33 && rOld33.ok === false && rOld33.batches === 2 && rOld33.poSent === 1000 &&
        rOld33.auSent === 0 && /ackAu/.test(rOld33.err || '') && rOld33.done === false,
        { batches: rOld33.batches, poSent: rOld33.poSent, err: rOld33.err });
      ok('卡住那一条仍然明说「服务端没回 ackAu」、水位原地不动（该停手时还得停：真旧版 boot4 不带 ack 不能白跑）',
        /服务端没回 /.test(sw33) && /ackOf\(d\.ackAu, wm\.au\)/.test(sw33) &&
        /stallAu = aus\.length > 0 && wm\.au === before\.au;/.test(sw33) &&
        /stallPo = pos\.length > 0 && wm\.po === before\.po;/.test(sw33), '');
    }

    console.log('\n[34] v0.11.9 行内关系标签：互关 / 他单向 / 我单向（住在名字行、紧跟显示名后面——参考插件同款位置；颜色区分、证据不全就不出；回话一到自动重画）');
    {
      const ISO34 = '2026-11-01T08:00:00.000Z';
      const RC34 = 'ysy-xprobe-rel';
      // v0.11.9：标签不住徽标里了 —— chipOf 改从徽标所在的行（article）里按 data-h 找那颗行内标签
      const chipOf = (n) => {
        if (!n) return null;
        const root = n.closest('article') || n.parentNode;
        return (root.querySelectorAll('[data-xprobe="rel"]') || [])
          .filter((c) => c.getAttribute('data-h') === n.getAttribute('data-h'))[0] || null;
      };
      const btnOf = (n) => ((n && n.children) || []).filter((c) => String(c.tagName || '').toLowerCase() === 'button')[0] || null;
      const lab34 = (n) => { const c = chipOf(n); return c ? c.textContent : null; };
      const led34 = {
        // 两条腿都在：库记着 TA 在我粉丝列表 + 库记着我在关注 TA ⇒ 互关
        both: { handle: 'both', relation: 'following', seenAs: { following: ISO34, followers: ISO34 }, updatedAt: 3 },
        // 只有「我关注 TA」这一半 ⇒ 我单向（后一半靠「去过的粉丝列表里没看到」推断 ⇒ 虚线）
        libonly: { handle: 'libonly', relation: 'following', updatedAt: 2 },
        // 只有「TA 关注我」这一半，我这侧一个读数都没有 ⇒ 判不出，一颗都不画
        witness: { handle: 'witness', seenAs: { followers: ISO34 }, updatedAt: 1 },
        // 库说我在关注 TA —— 但页面上这颗钮写着「关注」（没关注）：页面读数优先，库不许翻案
        flip: { handle: 'flip', relation: 'following', updatedAt: 1 },
        // v0.11.7 桥腿要用的「过期账」：库记着 not_following，桥当场带回的读数要赢过它
        stale: { handle: 'stale', relation: 'not_following', updatedAt: 0 },
      };
      store['ysy.xprobe.badge'] = true;
      store['ysy.xprobe.users'] = JSON.parse(JSON.stringify(led34));
      const s34v = run(h('div', {}, []), '/home', 'https://x.com/home');
      const X34 = s34v.__xprobe;
      const V34 = (hh, ev, fl, fb) => X34.relVerdict(hh, ev || { testid: '', aria: '', state: '' },
        fl === undefined ? X34.followersListSeen() : fl, fb);
      eq('粉丝列表的读过的痕迹是整颗「我单向」的前提：台账 witness.seenAs.followers ⇒ followersListSeen 真',
        X34.followersListSeen(), true);
      eq('互关：两条腿都是正向读数 ⇒ key=mutual、字面「互关」、绿实线（与「已关注」同一支色）',
        [V34('both').key, V34('both').lab, V34('both').color, V34('both').dash], ['mutual', '互关', '#a8e89a', false]);
      eq('我单向：只有「我在关注 TA」是读数 ⇒ 橙、虚线（后一半是「去过的粉丝列表里没看到」的推断，画成虚线）',
        [V34('libonly').key, V34('libonly').lab, V34('libonly').color, V34('libonly').dash], ['me', '我单向', '#f1b84b', true]);
      eq('他单向：这一行那颗钮的 aria 写着「回关」（TA 关注我）+ 同一颗是 -follow（我这侧没关注）⇒ 蓝实线',
        [V34('flip', { state: 'not_following', aria: '回关 @flip' }).key,
          V34('flip', { state: 'not_following', aria: '回关 @flip' }).color,
          V34('flip', { state: 'not_following', aria: '回关 @flip' }).dash],
        ['them', '#78bfea', false]);
      eq('正向对照：库说在关注 TA（relation=following），页面上这颗却是「关注 @flip」（没关注）⇒ 不许翻案，'
        + '一颗都不画（页面读数永远优先，与名单面板同一条纪律）',
        V34('flip', { state: 'not_following', aria: '关注 @flip' }), null);
      eq('正向对照：只有「TA 关注我」这一半证据（我这侧既没钮也没 not_following 台账）⇒ 判不出就不出，'
        + '不拿「没读到」冒充「没关注」（RL-11）', V34('witness'), null);
      eq('正向对照：这台机器一次都没进过粉丝列表（flSeen=false）⇒「我单向」整颗不出；flSeen=true 才出，'
        + '而且出来就是虚线（后一半是推断，不是 X 的读数）',
        [V34('libonly', null, false), (V34('libonly', null, true) || {}).dash], [null, true]);
      eq('预算按字面长算（三字 50px / 两字 42px，含 v0.11.13 胶囊的内边距/边框/外边距补偿 +10）——宽度必须先进落点预算，不能挂好再塞',
        [X34.relBudget(V34('libonly')), X34.relBudget(V34('both')), X34.relBudget(null)], [50, 42, 0]);
      // ---- v0.11.7 桥腿判据（第四参 fb）：钮 > 桥 > 台账。home 时间线没有钮、台账没读过的人，
      // 过去只能回 null ⇒ 一屏标签全空；X 把 following/followed_by 随时间线带回了页面，桥把它读回来。 ----
      eq('桥腿：行无钮、台账两手空空，桥带回 following=true + followed_by=true ⇒ 互关（home 时间线上最常见的那颗）',
        (V34('bridge2', null, false, { following: true, followsYou: true }) || {}).key, 'mutual');
      eq('桥腿：following=true + followed_by=false ⇒ 我单向**实线**（两半都是 X 的当场读数，不用再靠进过粉丝列表的推断）',
        [(V34('bridge3', null, false, { following: true, followsYou: false }) || {}).key,
          (V34('bridge3', null, false, { following: true, followsYou: false }) || {}).dash], ['me', false]);
      eq('桥腿：following=false + followed_by=true ⇒ 他单向（这行连钮都没有，比「回关」钮那半条腿还全）',
        (V34('bridge4', null, false, { following: false, followsYou: true }) || {}).key, 'them');
      eq('桥腿：两侧都是 false（互不关注）⇒ 没有标签可画（不出 ≠ 丢数据）',
        V34('bridge5', null, false, { following: false, followsYou: false }), null);
      eq('桥腿：只带回一半（followsYou=true，following 那格没给）⇒ 判不出就不出，不冒充读数（RL-11）',
        V34('bridge6', null, false, { following: null, followsYou: true }), null);
      eq('桥赢台账：库里的旧账 relation=not_following，桥当场带回 following=true/followed_by=true ⇒ 按桥判互关'
        + '（X 当场带回的数据不许被旧账翻案，与「页面读数赢过库」同一条纪律）',
        (V34('stale', null, true, { following: true, followsYou: true }) || {}).key, 'mutual');
      eq('钮赢桥：同一行两份页面读数打架（「关注」钮在眼前 vs 桥 following=true）⇒ 我这侧认钮（钮是 X 当场画出来的字），'
        + '但 TA 那侧桥有读数 ⇒ 这一行照样判得出「他单向」（v0.11.6 里这种行一颗都不出）',
        (V34('flip', { state: 'not_following', aria: '关注 @flip' }, true, { following: true, followsYou: true }) || {}).key, 'them');

      // ---- 页面层：四行四种证据，看画出来的是什么、画在哪 ----
      const rows34 = h('div', { lang: 'zh' }, [
        tweetCell('both', '8401', ISO34, '甲帖', { followTestid: '84011-unfollow' }),
        tweetCell('tb1', '8402', ISO34, '乙帖', { followTestid: '84021-follow', followAria: '回关 @tb1' }),
        tweetCell('libonly', '8403', ISO34, '丙帖'),
        tweetCell('witness', '8404', ISO34, '丁帖'),
      ]);
      const s34 = run(rows34, '/home', 'https://x.com/home');
      s34.__xprobe.renderBlocks(true);
      const bd34 = {};
      rows34.querySelectorAll('[data-xprobe="blk"]').forEach((n) => { bd34[n.getAttribute('data-h')] = n; });
      eq('四行各一颗徽标；标签档位 = 互关/他单向/我单向/（只有半条证据的那行）一颗都没有',
        [Object.keys(bd34).length, lab34(bd34.both), lab34(bd34.tb1), lab34(bd34.libonly), lab34(bd34.witness)],
        [4, '互关', '他单向', '我单向', null]);
      eq('v0.11.10 位置：标签长在**名字锚里面**、紧跟显示名文字后面（参考插件同款；v0.11.9 插在外层 grid 容器里被当成新格子——另起一行还被拉伸），颜色按档位分、「我单向」是虚线框，且标签的字不混进台账名（data-n）',
        [chipOf(bd34.tb1).parentNode.getAttribute('href'), chipOf(bd34.tb1).parentNode.parentNode.getAttribute('data-testid'),
          chipOf(bd34.tb1).style.color, chipOf(bd34.libonly).style.border, chipOf(bd34.both).style.border,
          (bd34.tb1.getAttribute('data-n') || '').indexOf('互关') < 0],
        ['/tb1', 'User-Name', '#13231b', '1px dashed color-mix(in srgb, #f1b84b 55%, #13231b)', '1px solid color-mix(in srgb, #a8e89a 55%, #13231b)', true]);
      eq('徽标里只剩那颗钮了（这四行没有比例数；关系标签那一格从盒子里搬走了）',
        [bd34.tb1.children.map((c) => String(c.tagName || '').toLowerCase()).join(','),
          bd34.tb1.children.some((c) => String(c.getAttribute('class') || '').indexOf(RC34) >= 0)],
        ['button', false]);
      ok('tooltip 把证据出处写全（这行的钮 / 本机台账 + 日期），点开就知道凭什么：'
        + '「他单向」认 aria「回关」，「我单向」明写虚线是推断',
        /这一行那颗关系钮写着「回关 @tb1」/.test(chipOf(bd34.tb1).title)
        && /这一行读到的是「关注」那颗钮/.test(chipOf(bd34.tb1).title)
        && /本机台账/.test(chipOf(bd34.libonly).title) && /虚线/.test(chipOf(bd34.libonly).title)
        && /TA 也关注你/.test(chipOf(bd34.both).title),
        [chipOf(bd34.tb1).title, chipOf(bd34.libonly).title]);
      ok('标签是纯展示件：一个事件都没挂（点它等于点它底下那一行），也不拦事件 —— RL-1「只读、不代操作」',
        !chipOf(bd34.tb1).listeners.click && !chipOf(bd34.tb1).listeners.mousedown
        && chipOf(bd34.tb1).fire('click') === undefined, chipOf(bd34.tb1).listeners);
      eq('这一趟的账：三颗出、一颗判得出来却没地方画 = 0（四行都画得下），面板那行才答得出「23 行里出了几颗」',
        [s34.__xprobe.perfLine().badgeRel, s34.__xprobe.perfLine().badgeRelNo], [3, 0]);
      // 粘住：老位置仍然空着 ⇒ 一个字都不写（含那颗标签）；标签档位一翻（补上一条粉丝证据）签名第 6 格变 ⇒ 重画
      const p34 = (n) => {
        const hp = n.parentNode.__geo || { left: 0, top: 0, width: 0, height: 18 };
        const w = Number(String(n.style.width || '').replace('px', '')) || 46;
        const l = n.style.right ? hp.left + hp.width - Number(String(n.style.right).replace('px', '')) - w
          : hp.left + Number(String(n.style.left || '0').replace('px', ''));
        n.__geo = { left: l, top: hp.top, width: w, height: hp.height || 18 };
      };
      Object.keys(bd34).forEach((k) => p34(bd34[k]));
      const mv34 = s34.__xprobe.perfLine().badgeMoved;
      s34.__xprobe.renderBlocks(true);
      eq('正向对照（粘住）：给老位置补上矩形再跑一趟 ⇒ 一行都不写、一次都不搬（标签也在「不来回跑」这一条里）',
        [s34.__xprobe.perfLine().badgeMoved, s34.__xprobe.perfLine().badgeRel, lab34(bd34.libonly)],
        [mv34, 3, '我单向']);
      ok('v0.11.9 签名第 6 格恒空（标签不住徽标里了）：档位与虚实线改记在标签自己的 data-k 上（~虚/+实）——'
        + '老读者只读到第 4 格前的字段，徽标签名从此与标签翻动无关',
        String(bd34.libonly.getAttribute('data-xsig').split('|')[5] || '') === ''
        && chipOf(bd34.libonly).getAttribute('data-k') === 'me~'
        && chipOf(bd34.both).getAttribute('data-k') === 'mutual+',
        [bd34.libonly.getAttribute('data-xsig'), chipOf(bd34.libonly).getAttribute('data-k')]);
      // 证据翻了（页面上那颗从「回关」变成「正在关注」）⇒ 档位从 them 翻到 me：标签就地改字面与颜色
      // （data-k 翻格），徽标那颗一个字不动。走页面这条路是刻意的：判定读的内存台账会被
      // 落表/裁剪换成新对象，拿 store 改证据测的是「引用」而不是逻辑。
      const sig34 = bd34.tb1.getAttribute('data-xsig');
      const btn34 = rows34.querySelectorAll('button[data-testid="84021-follow"]')[0];
      btn34.setAttribute('data-testid', '84021-unfollow');
      btn34.setAttribute('aria-label', '正在关注 @tb1');
      s34.__xprobe.renderBlocks(true);
      eq('正向对照：页面那颗钮翻成「正在关注」⇒ 标签就地从「他单向」改判「我单向」（虚线橙、data-k 翻成 me~）；'
        + '徽标签名一个字不动（档位不住徽标里了）',
        [lab34(bd34.tb1), chipOf(bd34.tb1).style.border, chipOf(bd34.tb1).getAttribute('data-k'),
          bd34.tb1.getAttribute('data-xsig') === sig34],
        ['我单向', '1px dashed color-mix(in srgb, #f1b84b 55%, #13231b)', 'me~', true]);
      btn34.setAttribute('data-testid', '84021-follow');
      btn34.setAttribute('aria-label', '回关 @tb1');

      // ---- v0.11.7 桥腿端到端：home 时间线没有关系钮，X 把 following/followed_by 随时间线带回了页面
      // React 树里 —— isolated world 读不到 ⇒ 主世界 bridge.js（[36] 单测）读出来 postMessage 回来。
      // 这里用沙箱的 window 桩演那一次问答：没桥时「缺桥」记账；装上信使→发一问→回一封自家记号的结果
      // →下一趟标签当场画上（动态刷新）；证据优先序在页面上再验一遍（钮赢桥）。
      {
        const plA = s34.__xprobe.perfLine();
        eq('装桥之前：这一趟每行都缺桥读数（沙箱 window 没有 postMessage，桥腿安静不跑但缺数记了账，RL-11）',
          [plA.badgeFiber, plA.badgeFiberNo > 0], [0, true]);
        const sent34b = [];
        s34.window.postMessage = (msg) => { sent34b.push(msg); };   // 装上信使：core 发出的那一问记下来
        s34.__xprobe.renderBlocks(true);
        ok('缺桥的行攒出一封问询：带自家记号 ysy-xprobe-rel-bridge / type=query / 有 id / handles 是缺读数 handle 的名单（v0.11.8 起不再无界发问）',
          sent34b.length === 1 && sent34b[0].source === 'ysy-xprobe-rel-bridge' && sent34b[0].type === 'query'
          && typeof sent34b[0].id === 'string' && Array.isArray(sent34b[0].handles) && sent34b[0].handles.length >= 1, sent34b[0]);
        // 桥回话：witness 补上两个 true ⇒ 半条证据当场变互关；libonly 补上 followed_by=false ⇒ 虚线翻实线；
        // tb1 回 following=true/followsYou=true，但这一行有「关注」钮在眼前 ⇒ 钮赢桥，还是「他单向」
        s34.window.fire('message', { source: s34.window, data: { source: 'ysy-xprobe-rel-bridge', type: 'result',
          id: sent34b[0].id, users: { witness: { following: true, followsYou: true }, libonly: { following: true, followsYou: false },
            tb1: { following: true, followsYou: true } } } });
        s34.__xprobe.renderBlocks(true);
        const bd34b = {};
        rows34.querySelectorAll('[data-xprobe="blk"]').forEach((n) => { bd34b[n.getAttribute('data-h')] = n; });
        eq('回话到了 ⇒ 下一趟把标签画上（这就是「动态刷新」的全部机制）：只有半条证据的行补上 X 自带读数后当场变互关；'
          + '「我单向」从推断的虚线翻成实线（两半都是这一行自带的读数）；钮赢桥那行还是「他单向」',
          [lab34(bd34b.witness), chipOf(bd34b.libonly).style.border, lab34(bd34b.tb1)],
          ['互关', '1px solid color-mix(in srgb, #f1b84b 55%, #13231b)', '他单向']);
        const plB = s34.__xprobe.perfLine();
        eq('这一趟的账：用上桥读数的行数 / 还缺的行数（both 那行桥里没带回它的记录 ⇒ 仍记缺）',
          [plB.badgeFiber, plB.badgeFiberNo], [3, 1]);
        s34.__xprobe.renderBlocks(true);
        eq('补问有节拍（≤15 秒一问、在途不重问）：下一趟还缺 both 一行也不会立刻再发第二问',
          sent34b.length, 1);
        // v0.11.11 桥的主动推送：X 的回包随时到，桥把 delta 一到就推过来（type:'push'）——
        // core 不发问、不等 15s 节拍，常驻监听当场合并进台账。刚才仍记缺的 both 行这回从 push 里拿到读数。
        s34.window.fire('message', { source: s34.window, data: { source: 'ysy-xprobe-rel-bridge', type: 'push',
          users: { both: { following: true, followsYou: true } } } });
        s34.__xprobe.renderBlocks(true);
        const plC = s34.__xprobe.perfLine();
        eq('push 到了 ⇒ 不发问也不等节拍，读数当场进台账（仍记缺的 both 行补上了，缺桥计数清零）',
          [plC.badgeFiber, plC.badgeFiberNo], [4, 0]);
        s34.window.fire('message', { source: s34.window, data: { source: 'ysy-xprobe-rel-bridge', type: 'push',
          users: { both: { following: 'not-a-bool', followsYou: null }, ghost: {} } } });
        s34.window.fire('message', { source: s34.window, data: { source: '别人的插件', type: 'push',
          users: { both: { following: false, followsYou: false } } } });
        s34.__xprobe.renderBlocks(true);
        eq('push 的纪律照旧：没有布尔的条目不冒充读数（不覆盖已有读数）、别人的记号一个字不读（台账一个字没动）',
          s34.__xprobe.perfLine().badgeFiber, 4);
        // v0.11.12 回归（真机「互关满屏判成没关注」）：X 的回包很多形状只带半截关系（following 是 null），
        // v0.11.11 的合并是整条覆盖 ⇒ 半截 delta 把台账里已经对的 following:true 抹成 null，判定掉回旧账。
        // witness 的「我关注 TA」只来自桥读数（台账只有粉丝证据）——半截推送过后互关那一颗必须原地不动。
        s34.window.fire('message', { source: s34.window, data: { source: 'ysy-xprobe-rel-bridge', type: 'push',
          users: { witness: { following: null, followsYou: true } } } });
        s34.__xprobe.renderBlocks(true);
        eq('半截 delta 不抹账（逐格合并，规矩与桥那头的 put() 同一条）：following:null 的推送不许把 witness 已对的'
          + ' following:true 抹掉——互关原地不动；整条覆盖正是 v0.11.11 满屏「没关注」的根因',
          chipOf(bd34b.witness).getAttribute('data-k'), 'mutual+');
      }

      // ---- 退让（v0.11.9 起回到两级）：缝里先丢比例标签、最后才丢那颗钮；关系标签住名字行，不占这条缝 ----
      const one34 = h('div', { lang: 'zh' }, [tweetCell('stat', '8405', ISO34, '戊帖')]);
      store['ysy.xprobe.users'] = {
        stat: { handle: 'stat', name: '甲', relation: 'following', followers: 100, following: 96, statsAt: Date.now(), updatedAt: 9 },
        witness: { handle: 'witness', seenAs: { followers: ISO34 }, updatedAt: 1 },
      };
      const s34o = run(one34, '/stat', 'https://x.com/stat');
      const row34o = one34.querySelector('[data-testid="User-Name"]');
      const art34o = one34.querySelector('article');
      const tm34o = one34.querySelector('time');
      const sq34 = (w) => {
        [one34, art34o, row34o].forEach((n) => { n.__geo = { left: 0, top: 0, width: w, height: 18 }; });
        tm34o.__geo = { left: 60, top: 0, width: 24, height: 18 };
      };
      const pass34 = (w) => {
        sq34(w);
        s34o.__xprobe.renderBlocks(true);
        const b = one34.querySelectorAll('[data-xprobe="blk"]')[0] || null;
        const lb = b && btnOf(b) ? (b.children || []).filter((c) => c !== btnOf(b))[0] || null : null;
        return { form: b ? b.getAttribute('data-f') : null, rel: !!chipOf(b), ratio: !!lb, btn: !!btnOf(b) };
      };
      const wide34 = pass34(240), mid34 = pass34(180), tight34 = pass34(140), dot34 = pass34(118);
      // 预算（关系标签搬走后只剩两件）：整颗 46 + 比例标签(缝 4 + "96%" 36) = 86
      //   ⇒ 缝 ≥86 ⇔ W≥174 比例标签出；W<134 只剩钮；连 46 都放不下但 ≥14 ⇒ 小红点。
      //   关系标签住在名字行，四种宽度下一颗都不缺（这正是搬家的意义：v0.11.8 它和比例标签挤同一条缝，
      //   180/140/118 三档全被挤掉——用户截图里那种「标签格子空着」就是它）。
      eq('宽行（240，缝 152）：钮 + 比例标签都画得下，名字行的关系标签也在',
        [wide34.form, wide34.rel, wide34.ratio, wide34.btn], ['full', true, true, true]);
      eq('挤一档（180，缝 92）：86 装得下了（v0.11.8 装不下——关系标签腾出了 40px）⇒ 钮 + 比例都留',
        [mid34.form, mid34.rel, mid34.ratio], ['full', true, true]);
      eq('再挤一档（140，缝 52）：86 不够 ⇒ 丢比例标签只保那颗钮；关系标签照样在名字行（徽标的退让链管不着它了）',
        [tight34.form, tight34.rel, tight34.ratio, tight34.btn], ['full', true, false, true]);
      eq('挤到只放得下点（118，缝 30）：徽标退成小红点；关系标签仍在名字行，「判得出来却没画」从此记 0（RL-11：位置不再抢标签的地）',
        [dot34.form, dot34.rel, dot34.btn, s34o.__xprobe.perfLine().badgeRelNo], ['dot', true, false, 0]);

      // ---- 读钮的 scope 是整行，不是名字节点（真机时间线那颗关注钮不长在 User-Name 里） ----
      const rows34m = h('div', { lang: 'zh' }, [
        tweetCell('tb1', '8411', ISO34, '乙帖', { followTestid: '84111-follow', followAria: '回关 @tb1' }),
        tweetCell('both', '8412', ISO34, '甲帖', { followTestid: '84121-unfollow' }),
      ]);
      store['ysy.xprobe.users'] = JSON.parse(JSON.stringify(led34));
      const s34m = runSource(src.replace(
        /nameEl\.closest\('\[data-testid="tweet"\], \[data-testid="UserCell"\], article'\)/, 'nameEl'),
        rows34m, '/home', 'https://x.com/home');
      s34m.__xprobe.renderBlocks(true);
      const bd34m = {};
      rows34m.querySelectorAll('[data-xprobe="blk"]').forEach((n) => { bd34m[n.getAttribute('data-h')] = n; });
      eq('正向对照（scope 真的咬）：把读钮缩回 nameEl ⇒ 行首那颗「回关」读不到 ⇒ 他单向当场没了；'
        + '而靠台账的互关不受影响 ⇒ 断言认的是这一行读到的页面按钮，不是台账兜底',
        [lab34(bd34m.tb1), lab34(bd34m.both)], [null, '互关']);

      // ---- 关闸清场：标签连徽标一起摘干净，页面自己的节点一个都不碰（RL-16） ----
      // 「X 的节点」按「不在任何自家节点里面」数：徽标盒子内部那两件（标签片 + 那颗钮）本身没打
      // data-xprobe，用属性直接滤会把它们算进页面账上 ⇒ 清场前后各数一次要同一把尺。
      // v0.11.14 补一眼：沙箱里 fab 排/名单面板也长在 fixture 根下、同样不打 data-xprobe ——
      // 它们是自家 UI，得一并排除（不然「回」的角标因账变了摘一颗 span，这把尺就误报「动了 X 的节点」：
      // witness 收到桥的 result 读数 following=true ⇒ 按新判据它从待回账退出，「回1」→「回0」，角标摘掉是应该的）。
      const OWN_UI34 = ['ysy-xprobe-ext-bar', 'ysy-xprobe-ext-flist', 'ysy-xprobe-ext-card',
        'ysy-xprobe-ext-bench', 'ysy-xprobe-ext-benchp', 'ysy-xprobe-ext-fab'];
      const own34 = (n) => { let p = n; while (p) { if (p.getAttribute && p.getAttribute('data-xprobe')) return true; if (p.id && OWN_UI34.indexOf(p.id) >= 0) return true; p = p.parentNode; } return false; };
      const xNodes34 = rows34.descendants().filter((n) => !own34(n)).length;
      s34.__xprobe.runCmd({ t: 'setBadge', v: false });
      eq('关掉总闸：关系标签与徽标一起清零（清场选择器单独认了这一片），X 自己的节点数一个没变',
        [rows34.querySelectorAll('.' + RC34).length, rows34.querySelectorAll('[data-xprobe="blk"]').length,
          rows34.descendants().filter((n) => !own34(n)).length],
        [0, 0, xNodes34]);
      s34.__xprobe.runCmd({ t: 'setBadge', v: true });
      s34.__xprobe.renderBlocks(true);
      const relab34 = () => rows34.querySelectorAll('[data-xprobe="blk"]').map((n) => {
        const c = chipOf(n); return n.getAttribute('data-h') + '=' + (c ? c.textContent : '-');
      }).sort().join(',');
      eq('再拨回开：标签重新长出来（同闸同节拍，不另开一条注入通道；老节点已被清场摘掉，这是新的一批）。'
        + 'witness 这回有「互关」——桥读数缓存在沙箱内存里还活着（witness=互关 也是桥腿对清场后重画的一个回归验证）',
        relab34(), 'both=互关,libonly=我单向,tb1=他单向,witness=互关');
      store['ysy.xprobe.badge'] = false;
      delete store['ysy.xprobe.users'];
    }

    console.log('\n[35] v0.11.4 功能二：AI 回帖这一腿（闸关=一个字都不发 · 出口只有原生宿主 · 草稿不替你发）');
    {
      // ---- A. 传输红线（静态）：地址与 Key 只许出现在后两层，页面那一层一个字都摸不到 ----
      const aiLeg = src.slice(src.indexOf('const AIBTN_ID'), src.indexOf('function fabBtn()'));
      const swSend = swSrc.slice(swSrc.indexOf('function modelSend('), swSrc.indexOf('function modelDraft('));
      const swDraft = swSrc.slice(swSrc.indexOf('function modelDraft(msg)'), swSrc.indexOf('function aiGateShout('));
      ok('页面这一腿只有 SW 一条通道：片里有 dbAsk({ t: \'modelDraft\' })，却没有 fetch / XHR / GM_xmlhttpRequest，'
        + '也没有任何地址（没有 :// 、没有回环、没有 localhost、没有 :端口——模型地址与 API Key 都不许进页面，进页面就是交给 X 的 DOM 去保管）',
        /dbAsk\(\{ t: 'modelDraft'/.test(aiLeg) &&
        !/fetch\(|XMLHttpRequest|GM_xmlhttpRequest|127\.0\.0\.1|localhost|:\/\/|:\d{2,5}\b/.test(aiLeg),
        (aiLeg.match(/fetch\(|XMLHttpRequest|127\.0\.0\.1|localhost|:\/\/|:\d{2,5}/g) || []).slice(0, 5));
      ok('RL-1 在这一腿是结构性的：aiAsk 之后不点任何钮（全片没有 .click()）、不往回复框写字（没有 contenteditable）、'
        + '也不伸手进 X 的 DOM（没有 document.querySelector）——卡片只挂在自家文档根上',
        !/\.click\(\)/.test(aiLeg) && !/contenteditable/i.test(aiLeg) && !/document\.querySelector\(/.test(aiLeg)
        && /document\.documentElement\.appendChild\(aiRoot\)/.test(aiLeg), '');
      ok('SW 这一腿只有 native 一条路：modelSend 里是 nativeCall(payload…)，一个 fetch 都没有'
        + '（宿主没装时正确结论是「这条路没接通」，不是换个端口赌一把 ⇒ RL-2/RL-3）',
        /nativeCall\(payload/.test(swSend) && !/fetch\(/.test(swSend), '');
      ok('renderAi 那一行是双保险（开着 && 闸在）：就算别处漏拨了 aiOpen，闸关着也绝不给卡片画出来',
        /aiRoot = \(aiOpen && aiGateOn\(\)\) \? aiCardBuild\(\) : null;/.test(aiLeg), '');
      ok('闸排在发请求之前：modelDraft 里「没开就 return」那一行排在 modelSend( 之前（顺序倒了就是先发了再问该不该发）',
        swDraft.indexOf('if (!c.on) return') >= 0 && swDraft.indexOf('if (!c.on) return') < swDraft.indexOf('modelSend(payload'), '');
      const mf35 = JSON.parse(rd('manifest.json'));
      eq('RL-3 的账：这一腿没为任何模型端口加过 host_permissions（清单仍是回环三条 + 自家域名一条；11434/1234/8000 一个都不在）',
        [mf35.host_permissions.length, /11434|:1234|:8000/.test(JSON.stringify(mf35.host_permissions)), /<all_urls>/.test(JSON.stringify(mf35.permissions))],
        [4, false, false]);
      // ---- A2. v0.11.6 预设提示词 + ✎ 编辑器（源码字面钉）----
      const sw35src = rd('background/sw.js');
      ok('预设系统提示住在 SW 的 MODEL_DEFAULT.system 里（带正例/反例/语气词/表情上限——用户点名的去 AI 味那套），'
        + 'modelDraft 留空回落预设、modelState 把预设带给卡片预填',
        [/反例——一条都不许沾/.test(sw35src), /正例——好的回复就长这样/.test(sw35src),
          /c\.system \|\| MODEL_DEFAULT\.system/.test(sw35src), /defSystem: MODEL_DEFAULT\.system/.test(sw35src)],
        '');
      ok('预设防背模板（真机 11-04 教训三连：整句示范被照抄 → 降温后仍抄 → 词池又被「确实」一词钉死——模型无状态，'
        + '自己不会换开场词）：预设里**一个可抄的整句都不给**、旧示范句在源码里必须一个都搜不到、反例钉万金油评语；'
        + '开场由 modelDraft **按请求轮换**（OPENERS 随机挑一个钉进这条 user 消息，三成概率改「别用开场词」），温度钉 0.9',
        [/一个字都不许照抄进你的回复/.test(sw35src), /十条里至少七条/.test(sw35src), /开头复读/.test(sw35src),
          /开场词池/.test(sw35src), /万金油评语/.test(sw35src), !/这都能刷到/.test(sw35src), !/哈哈这也太准了吧/.test(sw35src),
          !/确实，我上次也踩过这个坑/.test(sw35src), !/笑死，建议直接置顶/.test(sw35src),
          /const OPENERS = \[/.test(sw35src), /小要求：这条回复用/.test(sw35src), /小要求：这条回复不用任何开场词/.test(sw35src),
          /payload\.temperature = 0\.9/.test(sw35src),
          /15 个字/.test(sw35src), /最多摘 4 个字/.test(sw35src), !/上次我也遇到过/.test(sw35src),
          /点评作者的辛苦/.test(sw35src)],
        '');
      ok('页面 prompt 只剩骨架（不再拼风格话，更不再有样本腿）：「写成一个真人」「你自己最近发过」与 aiSamplesFetch 都不许回来',
        [!/写成一个真人/.test(aiLeg), !/你自己最近发过/.test(aiLeg), !/aiSamplesFetch/.test(aiLeg)],
        '');
      ok('✎ 编辑器在卡片头部（改提示词 / 存进本机存储 modelSet / 预填现值回落预设），照样只有字、没有 URL',
        [/改提示词/.test(aiLeg), /AICARD_ID \+ '-syswrap'/.test(aiLeg), /t: 'modelSet', system: val/.test(aiLeg),
          !/https?:\/\//.test(aiLeg.slice(aiLeg.indexOf('✎ 提示词编辑器')))],
        '');

      // ---- B. SW 真跑：三种说法（没开 / 没装宿主 / 旧宿主）都要有话说，且只走宿主那一条出口 ----
      const M_ON = () => ({ 'ysy.xprobe.model': { on: true, endpoint: 'openai', base: 'http://127.0.0.1:1234',
        model: 'qwen2.5', system: '口语一点', token: 'sk-local-secret', ms: 12000 } });
      const LLM_HOST = (p) => p.t === 'llm'
        ? { reply: { status: 200, body: JSON.stringify({ ok: true, text: '草稿一：接得上话', models: ['qwen'], hver: 'native-7' }) } }
        : { reply: { status: 200, body: '{}' } };
      const TABS35 = [{ id: 5, url: 'https://x.com/home' }, { id: 8, url: 'https://example.com/' }];
      const DRAFT_MSG = { t: 'modelDraft', prompt: '下面是 X 上一条帖子的原文。\n作者：@demo_own\n原文：\n这条帖子的原文就这么长' };

      const w35a = runSW({ tabs: TABS35 });   // 缺省 = 没存过配置、也没装宿主
      const off1 = await w35a.__call(DRAFT_MSG);
      eq('默认关（这台机器从没配过）：连宿主都不问。off=true 说的是「闸没开」，不是「写失败了」',
        [off1.ok, off1.off, /闸默认关/.test(off1.err), w35a.__nativeQ.length, w35a.__fetchCalls()],
        [false, true, true, 0, 0]);
      const off2 = await w35a.__call({ t: 'modelTest' });
      eq('同一颗闸也管着「测一测」：没开就不去列模型（列模型同样要出门，不许留一条免闸的后门）',
        [off2.ok, off2.off, w35a.__nativeQ.length], [false, true, 0]);

      const w35b = runSW({ store: M_ON(), native: LLM_HOST, tabs: TABS35 });
      const ok1 = await w35b.__call(DRAFT_MSG);
      const llm35 = w35b.__nativeQ.filter((q) => q.payload.t === 'llm');
      eq('闸开着 + 宿主在：一稿写成。text / hostVer 都从宿主回包里来，stat 当场记进账；整趟一条 native、零 fetch',
        [ok1.ok, ok1.text, ok1.hostVer, ok1.stat && ok1.stat.ok, llm35.length, w35b.__fetchCalls()],
        [true, '草稿一：接得上话', 'native-7', true, 1, 0]);
      eq('交给宿主的那一眼只有这一条腿该有的键：base 是回环、超时跟着配置那一格走，Key 只在这一跳出现',
        [Object.keys(llm35[0].payload).sort().join(','), llm35[0].payload.base, llm35[0].payload.endpoint,
          llm35[0].payload.timeoutMs, llm35[0].payload.token],
        ['base,endpoint,model,prompt,system,t,temperature,timeoutMs,token', 'http://127.0.0.1:1234', 'openai', 12000, 'sk-local-secret']);
      eq('宿主名与注册表里那个逐字一致（差一个字母 = Chrome 报 host not found，这一腿当场哑掉）', llm35[0].host, 'com.yunxiao.xprobe');

      const w35f = runSW({ store: { 'ysy.xprobe.model': { on: true, endpoint: 'openai', base: 'http://127.0.0.1:1234',
        model: 'qwen2.5', ms: 12000 } }, native: LLM_HOST, tabs: TABS35 });
      const ok1f = await w35f.__call(DRAFT_MSG);
      const llm35f = w35f.__nativeQ.filter((q) => q.payload.t === 'llm');
      eq('v0.11.6 预设提示词：配置里「系统提示」留空 = 发 MODEL_DEFAULT 那份预设（正例/反例那套），不是发一条没有性格的空指令',
        [ok1f.ok, /反例——一条都不许沾/.test(llm35f[0].payload.system || ''), /正例——好的回复就长这样/.test(llm35f[0].payload.system || '')],
        [true, true, true]);
      const st35f = await w35f.__call({ t: 'modelState' });
      eq('modelState 把预设一并带回（defSystem）：卡片 ✎ 展开时预填的就是它，不用把预设抄第二份进页面',
        [st35f.ok, /反例——一条都不许沾/.test(st35f.defSystem || ''), 'defSystem' in st35f],
        [true, true, true]);

      const st35 = await w35b.__call({ t: 'modelState' });
      eq('面板要回显时给的是「有没有 Key」而不是 Key：conf 里 hasToken=true、压根没有 token 这个键',
        [st35.ok, st35.conf.hasToken, 'token' in st35.conf, st35.conf.on, st35.conf.ms, st35.conf.base],
        [true, true, false, true, 12000, 'http://127.0.0.1:1234']);
      ok('整条 modelState 回包里搜不到那串机密（面板每 900 毫秒重画一次 DOM，明文回显就是把它摊进 DOM 与日志）',
        JSON.stringify(st35).indexOf('sk-local-secret') < 0, JSON.stringify(st35).slice(0, 160));
      eq('回包带着这一节要画的三样：最近一趟的账（含宿主版本）/ 端点表 / 默认地址与超时区间——面板不许自己算第二套真相',
        [st35.stat.hostVer, st35.endpoints.map((e) => e.endpoint).join(','), st35.defBase, st35.msLo + '-' + st35.msHi],
        ['native-7', 'generate,chat,openai', 'http://127.0.0.1:11434', '3000-300000']);

      const set35 = await w35b.__call({ t: 'modelSet', on: true, base: 'http://localhost:11434', model: 'qwen2.5' });
      await tick();   // 广播那一圈走的是 tabs.query 的 then，给微任务一拍
      eq('保存 = 落盘 + 回一份不含 Key 的视图；翻开闸那一刻当场朝 x.com 标签页广播 modelGate（example.com 那页不该收到）',
        [set35.ok, set35.conf.hasToken, set35.warn,
          w35b.__sent.filter((x) => x.m && x.m.t === 'modelGate').map((x) => x.id + ':' + x.m.on).join(',')],
        [true, true, '', '5:true']);
      eq('只改地址、那一格 Key 留空 ⇒ 原来那串机密还在（抹用户的 Key 就是删用户数据，红线）',
        [w35b.__map['ysy.xprobe.model'].token, w35b.__map['ysy.xprobe.model'].base], ['sk-local-secret', 'http://localhost:11434']);
      const shut35 = await w35b.__call({ t: 'modelSet', on: false });
      eq('关闸也当场广播（第七颗得立刻收回去），并且把「这一趟一个请求都不发」讲在回包里',
        [shut35.ok, shut35.conf.on, /一个请求都不发/.test(shut35.warn),
          w35b.__sent.filter((x) => x.m && x.m.t === 'modelGate').length], [true, false, true, 2]);
      const bad35 = await w35b.__call({ t: 'modelSet', on: true, base: 'http://8.8.8.8:11434' });
      eq('非回环地址当场拒、且不落盘（这一条腿不发对 X / 公网的请求；判错的值写进存储更糟）',
        [bad35.ok, /回环/.test(bad35.err), w35b.__map['ysy.xprobe.model'].base], [false, true, 'http://localhost:11434']);
      const bad35b = await w35b.__call({ t: 'modelSet', on: true, base: 'http://127.0.0.1' });
      ok('光「http://127.0.0.1」不给端口也不猜（各家端口不同，猜一次就是打错门）：明说「要带端口」',
        bad35b.ok === false && /要带端口/.test(bad35b.err), bad35b);

      const w35c = runSW({ store: M_ON(), tabs: TABS35 });   // 不给 native 桩 = 这台机器没装宿主
      const noH = await w35c.__call(DRAFT_MSG);
      eq('闸开着但没装宿主：如实说「这条腿只走宿主（不占 host_permissions）」，并把那条只写 HKCU 的安装命令念出来（RL-11：说清缺什么、怎么补）',
        [noH.ok, noH.noHost, /install-host\.py --ext-id/.test(noH.err), w35c.__fetchCalls()], [false, true, true, 0]);
      const w35d = runSW({ store: M_ON(), tabs: TABS35,
        native: { reply: { status: 404, body: JSON.stringify({ ok: false, err: "未知通道 'llm'" }) } } });
      const oldH = await w35d.__call(DRAFT_MSG);
      eq('旧宿主不认 llm：不许让人对着 404「未知通道」自己猜版本，明说是打包进去的那一份要重打一次',
        [oldH.ok, oldH.oldHost, /重打/.test(oldH.err), /install-host\.py/.test(oldH.err)], [false, true, true, true]);

      // ---- C. 页面真跑：第七颗 + 那张卡片（SW 换成会回话的桩；页面这一层仍然只认自家 SW 那一条通道）----
      const TID35 = '2114999000000000001', TXT35 = '这条帖子的原文就这么长', PATH35 = '/demo_own/status/' + TID35;
      const AI = 'ysy-xprobe-ext-aibtn', AC = 'ysy-xprobe-ext-aicard', ISO35 = '2026-10-26T09:30:00.000Z';
      store['ysy.xprobe.posts'] = { [TID35]: { tweetId: TID35, handle: 'demo_own', text: TXT35, timeISO: ISO35,
        seenAt: 1, n: 2, view: 1234, reply: 12, like: 34 } };
      const art35 = (txt) => h('div', { lang: 'zh' }, [h('article', { 'data-testid': 'tweet' }, [
        h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/demo_own' }, [T('我 @demo_own')])]),
        h('div', { 'data-testid': 'tweetText' }, [T(txt)]),
      ])]);
      const root35 = art35(TXT35);
      const s35 = run(root35, PATH35, 'https://x.com' + PATH35);
      eq('boot 那一刻 SW 还没回话（沙盒的 sendMessage 只记账不回包）⇒ 影子是 null 而不是 false：'
        + '「没读到」与「关着」画成同一个安全默认值，但账上分得清（RL-11 不许拿没读到冒充关着）',
        [s35.__xprobe.__ai().gate, s35.__xprobe.aiGateOn(), IDS[AI].style.display], [null, false, 'none']);

      // 把出站桩换成「会回话的 SW」：modelState 影子跟着 gate35（conf 带现值 + defSystem 预设），modelDraft 回一稿，
      // modelSet 合并式落账（v0.11.6 的 ✎ 就走这一条）
      const gate35 = { v: true };
      const modelConf35 = { on: gate35.v, endpoint: 'openai', base: 'http://127.0.0.1:1234',
        model: 'qwen2.5', system: '口语一点', hasToken: true, ms: 12000 };
      s35.__modelConf35 = modelConf35;   // ✎ 测试里要看「存过之后本地现值有没有跟上」
      s35.chrome.runtime.sendMessage = (m, cb) => {
        s35.__rtMsgs.push(m);
        if (!cb) return;
        if (m.t === 'modelState') return cb({ ok: true, conf: modelConf35,
          defSystem: '预设：带正例/反例的去 AI 味那份' });
        if (m.t === 'modelDraft') return cb({ ok: true, text: '草稿一：接得上话', ms: 1200, hostVer: 'native-7' });
        if (m.t === 'modelSet') {
          Object.assign(modelConf35, m);   // SW 真身是合并式保存；桩照抄这一形状
          return cb({ ok: true });
        }
        return cb(undefined);
      };
      const bottom0 = s35.__xprobe.aiBottomPx();
      const g35 = s35.__toCore({ t: 'modelGate', on: true });
      eq('SW 广播「闸开了」这一拍：第七颗当场露面（不用重载页面），回执把现在的状态给回去',
        [g35.ok, g35.on, IDS[AI].style.display, s35.__xprobe.__ai().applied], [true, true, 'flex', 'flex']);
      eq('它一露面，两张窗口与卡片就当场让一格：让开的 = 一颗钮的位（直径+6 缝）+ 尺寸那一档多出的差值（让位是算出来的，不是嘴上说说）',
        s35.__xprobe.aiBottomPx() - bottom0, (s35.__xprobe.fabStat().px - 34) + s35.__xprobe.fabSlotPx());
      const fabBeat35 = s35.__runIntervals(1200);
      eq('节拍器再路过十趟，这一颗的显隐也一个字不再动 DOM（「变了才动」这一条对第七颗同样生效）',
        [fabBeat35 > 0, IDS[AI].style.display, s35.__xprobe.__ai().applied], [true, 'flex', 'flex']);

      IDS[AI].fire('click');
      const c35 = IDS[AC];
      ok('点第七颗 = 开卡片：卡片是自家挂在文档根上的一棵，不缝进 X 的 article 里（RL-16）',
        !!c35 && c35.parentNode === root35 && /AI 回帖/.test(c35.textContent), c35 && String(c35.parentNode && c35.parentNode.tag));
      eq('目标行说清这一趟要发的是哪一条（作者 · 帖子 id · 原文字数），不让人猜卡片看上了哪条',
        c35.children[1].textContent, '@demo_own · 帖子 ' + TID35 + ' · 正文 ' + TXT35.length + ' 字');
      eq('原文块就是台账里那一条；草稿框是空的（还没写过）；底下一行先把「只打本机端口 / 不替你发」写在脸上',
        [IDS[AC + '-src'].textContent, IDS[AC + '-draft'].value,
          /只打本机端口/.test(IDS[AC + '-note'].textContent) && /草稿不替你发/.test(IDS[AC + '-note'].textContent)],
        [TXT35, '', true]);
      ok('卡片里一个字都不提地址与 Key（hasToken 那一格在设置页，用户不需要在页面上看见门钥匙）',
        !/127\.0\.0\.1|localhost|11434|1234|sk-local|token/i.test(c35.textContent), c35.textContent.slice(0, 120));

      const nRt35 = s35.__rtMsgs.length;
      c35.querySelectorAll('button').find((b) => b.textContent === '写一稿').fire('click');
      ok('点「写一稿」这一拍先就地改状态：钮换「在写」、note 说清要发多少字且「一个字节都不出这台机器」',
        IDS[AC].querySelectorAll('button').some((b) => b.textContent === '在写')
        && /原文 11 字/.test(IDS[AC + '-note'].textContent) && /一个字节都不出这台机器/.test(IDS[AC + '-note'].textContent),
        IDS[AC + '-note'].textContent);
      await tick();
      const sent35 = s35.__rtMsgs.slice(nRt35);
      eq('这一趟只发一条消息、且只带 prompt：页面手里没有地址、没有端口、也没有 Key（那两层在 SW 与宿主那边）',
        [sent35.length, sent35[0].t, Object.keys(sent35[0]).sort().join(',')], [1, 'modelDraft', 'prompt,t']);
      ok('prompt 就是「写一条回复」那句框 + 作者 + 原文逐字，不夹带页面 URL、也不夹带别的',
        sent35[0].prompt.indexOf('下面是 X 上一条帖子的原文') === 0 && /作者：@demo_own/.test(sent35[0].prompt)
        && sent35[0].prompt.indexOf(TXT35) > 0 && !/https?:\/\//.test(sent35[0].prompt), sent35[0].prompt);
      eq('回包落地：草稿进了那一格，note 报字数 + 耗时 + 走的宿主版本（这一句就是「哪条腿出的门」的直接回执）',
        [s35.__xprobe.__ai().draft, IDS[AC + '-draft'].value, IDS[AC + '-note'].textContent],
        ['草稿一：接得上话', '草稿一：接得上话', '写了 8 个字 · 1.2 秒 · 走的是宿主 native-7']);

      IDS[AC + '-copy'].fire('click');
      await tick();
      eq('「复制草稿」= 只把这段字放进剪贴板（RL-1：粘贴到哪、发不发都由你，这一腿不点页面钮、不往回复框写字）',
        [s35.__copied, IDS[AC + '-note'].textContent],
        [['草稿一：接得上话'], '草稿已进剪贴板（8 个字）：去回复框里粘贴、改、发']);

      // ---- [35y] v0.11.6 ✎ 提示词编辑器：卡片右上角改「系统提示」，存进本机存储，下一次写稿生效 ----
      // ✎ 会整棵重渲染卡片 ⇒ 每次都从 IDS[AC] 取当下那棵树（c35 是渲染前的快照，别用它找新钮）
      IDS[AC].querySelectorAll('button').find((b) => b.title.indexOf('改提示词') === 0).fire('click');
      const sysTa35 = IDS[AC + '-sys'];
      ok('点 ✎ = 编辑器当场展开：textarea 预填的就是真正会发的那份（桩里配置现值「口语一点」；配置留空时预填 defSystem 那份预设），标签写明「留空＝发预设」',
        [!!sysTa35, /提示词（系统提示）/.test(IDS[AC + '-syswrap'].textContent), sysTa35.value === '口语一点',
          /留空＝发预设/.test(IDS[AC + '-syswrap'].textContent)],
        '');
      eq('✎ 展开时卡片改居中放（v0.11.6 真机病：右下角锚定会把变高的顶部顶出屏幕外）：left/top 钉 50% + translate 回正，right 锚摘干净',
        [IDS[AC].style.left, IDS[AC].style.top, IDS[AC].style.transform, IDS[AC].style.right],
        ['50%', '50%', 'translate(-50%, -50%)', null]);
      sysTa35.value = '语气再土一点，带个哈哈；禁止列点与升华';
      sysTa35.fire('input');
      IDS[AC].querySelectorAll('button').find((b) => b.textContent === '存提示词').fire('click');
      await tick();
      const sysSet35 = s35.__rtMsgs.filter((m) => m.t === 'modelSet')[0];
      eq('「存提示词」= 只发 {modelSet, system} 这一条（合并式保存，地址/Key 等别的格原样留着），回执就地写「已存 · 下一次写稿就按它写」',
        [[sysSet35.t, sysSet35.system, Object.keys(sysSet35).sort().join(',')],
          /已存（19 字）/.test(IDS[AC + '-sysnote'].textContent) && /下一次「写一稿」/.test(IDS[AC + '-sysnote'].textContent)],
        [['modelSet', '语气再土一点，带个哈哈；禁止列点与升华', 'system,t'], true]);
      ok('本地那份现值当场跟上（下一稿的 system 就是刚存的字，不用整趟重问 modelState）——桩回的 conf 里 system 已是新值',
        s35.__modelConf35.system === '语气再土一点，带个哈哈；禁止列点与升华', '');
      IDS[AC].querySelectorAll('button').find((b) => b.title.indexOf('改提示词') === 0).fire('click');
      ok('再点 ✎ 收起：当下这棵树里不再有编辑框（renderAi 是整棵重铺，查树不查登记表；没存的不留，存过的在存储里），卡片其余部分照旧',
        !IDS[AC].descendants().some((n) => n.id === AC + '-syswrap'), '');
      eq('收起 ✎ = 卡片回右下角锚定：right/bottom 回来，居中三件套（left/top/transform）一个不留',
        [IDS[AC].style.right, !!IDS[AC].style.bottom, IDS[AC].style.left, IDS[AC].style.transform],
        ['14px', true, null, null]);
      const mine35 = new Set(s35.__created);
      eq('RL-1 的结构性证据：X 自己的节点上没被我们挂过监听、没被我们滚过一次，全片零',
        root35.descendants().filter((n) => !mine35.has(n))
          .reduce((a, n) => a + Object.keys(n.listeners).length + (n.__scrolls || 0), 0), 0);
      const box35 = IDS[AC + '-draft'];
      box35.value = '我改过的一稿';
      box35.fire('input');
      s35.__xprobe.renderAi();
      eq('用户在那一格改的字活过下一次重画：改一下它就是最新草稿，底下一行字数跟着改',
        [s35.__xprobe.__ai().draft, IDS[AC + '-draft'].value, /6 字/.test(IDS[AC].textContent)],
        ['我改过的一稿', '我改过的一稿', true]);

      const off35 = s35.__toCore({ t: 'modelGate', on: false });
      eq('闸一关：卡片整棵从页面摘掉、第七颗收回去（留一个还能点的入口 = 骗人去走一条注定不发请求的路）',
        [off35.on, IDS[AC], IDS[AI].style.display, s35.__xprobe.__ai().open], [false, undefined, 'none', false]);
      IDS[AI].fire('click');
      await tick();   // 看不见却点到了（键盘 Tab 进过隐藏钮）⇒ 这颗先去追读一次闸，读到开了才把卡片画出来
      eq('再翻回开、再点这颗：草稿还在——关闸只是收起，不偷偷删用户写过的那段字（要清得让他看见为什么清）',
        [s35.__xprobe.__ai().gate, IDS[AC + '-draft'].value], [true, '我改过的一稿']);
      gate35.v = false;
      const q35off = s35.__rtMsgs.length;
      IDS[AC].querySelectorAll('button').find((b) => b.textContent === '写一稿').fire('click');
      await tick();
      eq('正向对照（影子与真闸分家时）：页面这一头只按自己的影子画钮，写一稿仍旧发一趟问 SW——SW 那层默认关会当场 return，'
        + '一个请求出不了门（这一腿的门是 SW 那把闸关的，页面上的钮只是快拍慢半拍）',
        [s35.__rtMsgs.slice(q35off).filter((m) => m.t === 'modelDraft').length, s35.__xprobe.__ai().gate], [1, true]);

      s35.location.pathname = '/demo_own/status/9005';
      s35.location.href = 'https://x.com/demo_own/status/9005';
      s35.__xprobe.spaTick();
      eq('换页 = 草稿当场清零、回执也清（那段字是照着旧帖写的，留着就会对新帖发出去——最容易让人顺手发错的一种对不上）',
        [s35.__xprobe.__ai().draft, s35.__xprobe.__ai().busy, IDS[AC + '-draft'].value, /闸开着/.test(IDS[AC + '-note'].textContent)],
        ['', false, '', true]);

      // 说不清目标就不发：首页（一屏好几条）与没有正文的详情页
      const root35h = h('div', { lang: 'zh' }, [tweetCell('aa', '9001', ISO35, '甲帖'), tweetCell('bb', '9002', ISO35, '乙帖')]);
      const s35h = run(root35h, '/home', 'https://x.com/home');
      s35h.__toCore({ t: 'modelGate', on: true });
      IDS[AI].fire('click');
      const q35h = s35h.__rtMsgs.length;
      IDS[AC].querySelectorAll('button').find((b) => b.textContent === '写一稿').fire('click');
      await tick();
      eq('首页一屏好几条 ⇒ 选哪条都是猜：卡片把「为什么不发」写在目标行与回执上，一条 modelDraft 都不许发',
        [s35h.__rtMsgs.slice(q35h).filter((m) => m.t === 'modelDraft').length, IDS[AC + '-note'].textContent,
          IDS[AC].children[1].textContent],
        [0, '这一页不是帖子详情页（一屏好几条，选哪条都是猜）。点开一条帖子再回来点这颗。',
          '没有目标：这一页不是帖子详情页（一屏好几条，选哪条都是猜）。点开一条帖子再回来点这颗。']);
      ok('说不清目标时卡片连「原文块」都不画（没有目标就没有原文，画一格空块是装样子）',
        !IDS[AC + '-src'], IDS[AC].children.map((c) => c.tag).join(','));

      const s35e = run(h('div', { lang: 'zh' }, [h('article', { 'data-testid': 'tweet' }, [h('div', {}, [T('这一条正文还没渲染出来')])])]),
        '/demo_own/status/9003', 'https://x.com/demo_own/status/9003');
      s35e.__toCore({ t: 'modelGate', on: true });
      IDS[AI].fire('click');
      const q35e = s35e.__rtMsgs.length;
      IDS[AC].querySelectorAll('button').find((b) => b.textContent === '写一稿').fire('click');
      await tick();
      ok('详情页却没有正文（还没渲染 / 这条本来就没字）：说「等它出来再点一次」，不拿空原文去问模型',
        [/没读到帖子原文/.test(IDS[AC + '-note'].textContent)
          && s35e.__rtMsgs.slice(q35e).filter((m) => m.t === 'modelDraft').length === 0,
          s35e.__rtMsgs.filter((m) => m.t === 'modelDraft').length], [true, 0]);

      const s35p = run(art35('页面现读的正文'), '/demo_own/status/9004', 'https://x.com/demo_own/status/9004');
      s35p.__toCore({ t: 'modelGate', on: true });
      IDS[AI].fire('click');
      eq('台账里没有这一条也不慌：详情页现读 article 的 tweetText 兜底（与「☆标此帖」同源的两条腿），作者从 URL 补',
        IDS[AC].children[1].textContent, '@demo_own · 帖子 9004 · 正文 7 字');

      // ---- D. 变异对照：这几行不在，上面的判据就得红 ----
      const sA = src.replace("      aiEl.style.display = aiGateOn() ? 'flex' : 'none';", '      // 抠掉这一行');
      const sB = src.replace('    if (t.why) { aiNote = t.why;', '    if (false) { aiNote = t.why;');
      const sC = src.replace("      if (aiOpen) { aiOpen = false; aiBusy = false; }\n      renderAi();",
        '      if (aiOpen) { aiOpen = false; aiBusy = false; }');
      const sD = swSrc.replace("if (!c.on) return { ok: false, off: true, err: '本机模型没开", "if (false) return { ok: false, off: true, err: '本机模型没开");
      eq('四刀变异各自真砍到了那一行（replace 打空 = 白测，先把「刀落没落」记下来）',
        [sA !== src, sB !== src, sC !== src, sD !== swSrc], [true, true, true, true]);
      const m35a = runSource(sA, art35(TXT35), PATH35, 'https://x.com' + PATH35);
      eq('变异 A：抠掉「按闸显隐」那一行 ⇒ 第七颗在闸还没读到时也露在排里，而状态账还写着 none（DOM 与账分家，正是「骗人去点」）',
        [IDS[AI].style.display, m35a.__xprobe.__ai().applied], ['flex', 'none']);
      const m35b = runSource(sB, root35h, '/home', 'https://x.com/home');
      m35b.__toCore({ t: 'modelGate', on: true });
      IDS[AI].fire('click');
      IDS[AC].querySelectorAll('button').find((b) => b.textContent === '写一稿').fire('click');
      await tick();
      const m35bSent = m35b.__rtMsgs.filter((m) => m.t === 'modelDraft');
      eq('变异 B：抠掉 aiAsk 里「说不清目标就不发」⇒ 首页也照样发一趟，且「原文：」后面是空的（这条判据咬的就是那一行）',
        [m35bSent.length, /\n原文：\n$/.test(m35bSent[0].prompt)], [1, true]);
      const m35c = runSource(sC, art35(TXT35), PATH35, 'https://x.com' + PATH35);
      m35c.__toCore({ t: 'modelGate', on: true });
      IDS[AI].fire('click');
      const cardOn35 = !!IDS[AC];
      m35c.__toCore({ t: 'modelGate', on: false });
      eq('变异 C：把 aiGateSet 关闸那一支里的 renderAi() 摘掉 ⇒ 状态账翻了（aiOpen=false、第七颗收回去）但卡片还挂在页面上'
        + '（「闸一关就把卡片摘干净，留一个还能点的入口等于骗人」这一句确实是那一行拦下来的）',
        [cardOn35, !!IDS[AC], m35c.__xprobe.__ai().open, IDS[AI].style.display], [true, true, false, 'none']);
      const w35m = runSW({ src: sD, native: LLM_HOST, tabs: TABS35 });
      const mD = await w35m.__call(DRAFT_MSG);
      eq('变异 D：把 SW 那层「没开就 return」改成永不 return ⇒ 默认关也照样请了宿主一次（这条判据钉的是顺序，不是回包形状）',
        [mD.ok, w35m.__nativeQ.length], [true, 1]);

      delete store['ysy.xprobe.posts'];
    }

    console.log('\n[36] v0.11.8/v0.11.11 关系读数桥（主世界只读信使 bridge.js）：三条收割源（fetch/XHR 只读旁听 + Redux store + fiber 上下爬）、'
      + '一次一问一答、只认自家记号、问询带 handles 只回点名的人 —— 不改请求、不换响应、无常驻活动；'
      + 'v0.11.11 补第四格形状（result.relationship）与旁听 delta 主动推送（push）');
    {
      // 迷你沙箱：bridge 需要的只有 window（记监听/记信使）+ document（querySelectorAll）。DOM 桩复用上面的 El。
      const bwin = {
        listeners: {}, sent: [], location: { origin: 'https://x.com' },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        postMessage(msg) { this.sent.push(msg); },
      };
      const userOf = (sn, f, y, shape) => {
        if (shape === 'rp') return { __typename: 'User', core: { screen_name: sn }, relationship_perspectives: { following: f, followed_by: y } };
        if (shape === 'rel') return { __typename: 'User', core: { screen_name: sn }, relationship: { following: f, followed_by: y } };
        return { __typename: 'User', legacy: { screen_name: sn, following: f, followed_by: y } };
      };
      // 一行 home 时间线：fiber 的 return 链两层，第一层 props 里住着正文作者（itemContent.tweet_results
      // 那条真机形状），第二层住着一颗引用帖作者（quoted_status_result 递归）
      const art36 = h('article', { 'data-testid': 'tweet' }, [
        h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/alice' }, [T('示例笔记')])]),
      ]);
      art36.__reactFiber$t1 = {
        memoizedProps: {
          // 正文作者：props 里直接挂着 itemContent（参考插件 c() 覆盖的那条真机形状）
          itemContent: { tweet_results: { result: { core: { user_results: { result: userOf('alice', true, false) } } } } },
        },
        pendingProps: null,
        return: {
          memoizedProps: {
            quoted_status_result: { result: { core: { user_results: { result: userOf('bob', false, true) } } } },
            legacy: { retweeted_status_result: { result: { core: { user_results: { result: userOf('carol', true, true, 'rp') } } } } },
          },
          pendingProps: null,
          // v0.11.11 补的第四格：现代 X 回包（HomeTimeline 等）把布尔住在 result.relationship 里
          return: { memoizedProps: { itemContent: { tweet_results: { result: { core: { user_results: { result: userOf('dave', true, false, 'rel') } } } } } } },
        },
      };
      const root36 = h('div', {}, [art36]);
      const bdoc = {
        querySelectorAll: (s) => root36.querySelectorAll(s),
        querySelector: (s) => root36.querySelector(s),
      };
      vm.runInNewContext(rd('content/bridge.js'), { window: bwin, document: bdoc, console: console },
        { filename: 'content/bridge.js' });
      const fn36 = (bwin.listeners.message || [])[0];
      ok('装上了：一份 message 监听、零定时器零观察器（问一声答一声就静默）',
        (bwin.listeners.message || []).length === 1 && bwin.sent.length === 0, Object.keys(bwin.listeners));
      fn36({ source: bwin, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'q36' } });
      eq('回话：自家记号 + 同一 id + users 按 handle 出布尔（legacy 形状 / 引用帖递归 / relationship_perspectives / relationship 四种形状各认一条）',
        bwin.sent[0], {
          source: 'ysy-xprobe-rel-bridge', type: 'result', id: 'q36',
          users: {
            alice: { following: true, followsYou: false },
            bob: { following: false, followsYou: true },
            carol: { following: true, followsYou: true },
            dave: { following: true, followsYou: false },
          },
        });
      const nBefore = bwin.sent.length;
      fn36({ source: bwin, data: { source: '别人的插件', type: 'query', id: 'x1' } });
      fn36({ source: bwin, data: { source: 'ysy-xprobe-rel-bridge', type: 'result', id: 'x2', users: {} } });
      fn36({ source: bwin, data: { source: 'ysy-xprobe-rel-bridge', type: 'query' } });
      fn36({ source: null, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'x3' } });
      eq('别人的消息（记号不对/方向反了/缺 id/来源不是本窗）一个字不读：不发一封回话',
        bwin.sent.length, nBefore);
      // 保留段与「没有布尔」的用户不当 handle / 不冒充读数 —— 两条各挂进一条真正会被递归到的路径
      // （引用帖 / 转帖）里，让判据真的咬到它们，而不是「形状根本没被走到」的假绿。
      const art36b = h('article', { 'data-testid': 'tweet' }, []);
      art36b.__reactFiber$t2 = {
        memoizedProps: {
          quoted_status_result: { result: { core: { user_results: { result: userOf('home', true, true) } } } },
          legacy: { retweeted_status_result: { result: { core: { user_results: { result: { __typename: 'User', legacy: { screen_name: 'noBool' } } } } } } },
        },
      };
      const root36b = h('div', {}, [art36b]);
      const bwin2 = {
        listeners: {}, sent: [], location: { origin: 'https://x.com' },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        postMessage(msg) { this.sent.push(msg); },
      };
      vm.runInNewContext(rd('content/bridge.js'), { window: bwin2, document: { querySelectorAll: (s) => root36b.querySelectorAll(s), querySelector: (s) => root36b.querySelector(s) }, console: console },
        { filename: 'content/bridge.js#2' });
      (bwin2.listeners.message || [])[0]({ source: bwin2, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'q36b' } });
      eq('保留段（home 等导航路径）不当 handle；只有名字没有布尔读数的不冒充（users 里两个都不出现）',
        bwin2.sent[0].users, {});
      // ---- v0.11.8：问询带 handles（core 的 relFiberAsk 现在把缺读数的 handle 名单带来）----
      fn36({ source: bwin, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'q36h', handles: ['Alice', 'nosuch'] } });
      eq('问询带 handles ⇒ 只回点名的（大小写归一、别人的读数不外送；不带 handles 仍是全量——上面 q36 就是）',
        bwin.sent.filter((m) => m.id === 'q36h')[0].users, { alice: { following: true, followsYou: false } });
      const many = Array.from({ length: 85 }, (_, i) => 'u' + i);
      many[84] = 'bob'; many[79] = 'carol';   // bob 排在第 85 个 = 出顶；carol 在第 80 个 = 还在
      fn36({ source: bwin, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'q36c', handles: many } });
      eq('handles 过 80 收手：名单第 80 位之内的 carol 照回、第 85 位的 bob 不回（回包有界）',
        bwin.sent.filter((m) => m.id === 'q36c')[0].users, { carol: { following: true, followsYou: true } });
      // ---- v0.11.8 源②：Redux store（#react-root 首子的 __reactProps$ 链上找 store，entities.users 整把抓）----
      const storeState = { entities: { users: { entities: { erin: userOf('erin', false, true) } } } };
      const rrInner = h('div', {});
      rrInner.__reactProps$sk1 = { store: { getState: () => storeState } };
      const rr36 = h('div', { id: 'react-root' }, [rrInner]);
      const bwin3 = {
        listeners: {}, sent: [], location: { origin: 'https://x.com' },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        postMessage(msg) { this.sent.push(msg); },
      };
      vm.runInNewContext(rd('content/bridge.js'), { window: bwin3, document: { querySelectorAll: () => [], querySelector: (s) => (s === '#react-root' ? rr36 : null) }, console: console },
        { filename: 'content/bridge.js#store' });
      (bwin3.listeners.message || [])[0]({ source: bwin3, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'q36s', handles: ['erin'] } });
      eq('源② store：X 自己的 store.getState().entities.users 里的读数也认（fiber 全空也能判出互关/单向）',
        bwin3.sent[0].users, { erin: { following: false, followsYou: true } });
      // ---- v0.11.8 源①：fetch 只读旁听（graphql 回包 clone 来读，原响应原样放行）----
      const gqlPayload = { data: { home: { timeline: { instructions: [{ entries: [
        { content: { itemContent: { tweet_results: { result: { core: { user_results: { result: userOf('frank', true, true) } } } } } } },
      ] }] } } } };
      const origRes = { ok: true, clone() { return { json: async () => gqlPayload }; } };
      const bwin4 = {
        listeners: {}, sent: [], location: { origin: 'https://x.com' },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        postMessage(msg) { this.sent.push(msg); },
      };
      bwin4.__gqlRes = origRes; bwin4.fetch = async () => bwin4.__gqlRes;   // 可换源的上游桩：桥的包装层永远在 window.fetch 上
      vm.runInNewContext(rd('content/bridge.js'), { window: bwin4, document: { querySelectorAll: () => [], querySelector: () => null }, console: console },
        { filename: 'content/bridge.js#net' });
      const netRes = await bwin4.fetch('https://x.com/i/api/graphql/abc/HomeTimeline?variables=%7B%7D');
      await new Promise((r) => setImmediate(r));   // clone().json().then(harvestJson) 是微任务，放它跑完
      eq('源① 旁听不改请求不换响应：调用方拿到的就是 X 自己那个回包对象（同一引用，一个字节没动）',
        netRes, origRes);
      // v0.11.11：旁听到货当场推 delta（type:'push'，只带这趟刚学到的条目）—— core 不用等 15s
      // 节拍的下一问，「悬浮头像三秒才翻对」的另一半根因就在这条通道上
      eq('旁听到货当场推 delta：自家记号 + type=push + 只带新学到的 frank（不广播全量）',
        bwin4.sent[0], { source: 'ysy-xprobe-rel-bridge', type: 'push', users: { frank: { following: true, followsYou: true } } });
      (bwin4.listeners.message || [])[0]({ source: bwin4, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'q36n', handles: ['frank'] } });
      eq('源① 旁听攒下读数：graphql 回包里的 user_results 关系读数进了缓存、问一声就回',
        bwin4.sent.filter((m) => m.id === 'q36n')[0].users, { frank: { following: true, followsYou: true } });
      // ---- v0.11.13：新读数赢旧读数 + 翻面也当 delta 推 ----
      // 旧口径「先到先得」：推荐位/旧载荷里的 followed_by:false 先进账，时间线回包里更新的 true
      // 永远进不来——真机「有概率和不是兄弟不一样」的来源之一。翻面（关系真的变了）要当场改判。
      const gqlPayload2 = { data: { home: { timeline: { instructions: [{ entries: [
        { content: { itemContent: { tweet_results: { result: { core: { user_results: { result: userOf('frank', false, true) } } } } } } },
      ] }] } } } };
      const res2 = { ok: true, clone() { return { json: async () => gqlPayload2 }; } };
      bwin4.__gqlRes = res2;   // 只换上游回包，不换 window.fetch —— 桥的包装层（clone→harvest）必须照走一遍
      await bwin4.fetch('https://x.com/i/api/graphql/abc/HomeTimeline?variables=%7B%7D');
      await new Promise((r) => setImmediate(r));
      eq('翻面也推：X 最新回包说关系变了（following true→false），delta 当场推给 core 改判，不等下一问',
        bwin4.sent.filter((m) => m.type === 'push')[1], { source: 'ysy-xprobe-rel-bridge', type: 'push', users: { frank: { following: false, followsYou: true } } });
      (bwin4.listeners.message || [])[0]({ source: bwin4, data: { source: 'ysy-xprobe-rel-bridge', type: 'query', id: 'q36f', handles: ['frank'] } });
      eq('翻面落账：问一声回的是新读数（旧读数不许占位）',
        bwin4.sent.filter((m) => m.id === 'q36f')[0].users, { frank: { following: false, followsYou: true } });
      vm.runInNewContext(rd('content/bridge.js'), { window: bwin, document: bdoc, console: console },
        { filename: 'content/bridge.js#again' });
      eq('重复注入只装一份（第二次整个 IIFE 短路，监听器没多、__ysyXprobeRelBridge 门闩生效）',
        bwin.listeners.message.length, 1);
    }
  }
    // ================= art-020 本页热度榜（口径参考，未复制代码）：新增断言单独计数 =================
    {
      const passBase = pass;
      console.log('\n[art-020] 本页热度榜（抓取口径 / 流速分档 / 推广去重 / 总闸 / 版本戳 / 不滚动）');
      const HOT_N = '2026-11-10T12:00:00.000Z', HOT_NOW = Date.parse(HOT_N);
      const isoH = (h) => new Date(HOT_NOW - h * 3600000).toISOString();
      function tw(id, views, iso, name, text, opts) {
        const o = opts || {}, kids = [];
        if (views != null) kids.push(h('a', { href: '/user/status/' + id + '/analytics', 'aria-label': views + ' views' }, [T('v')]));
        kids.push(h('time', { datetime: iso }, [T('t')]));
        kids.push(h('button', { 'data-testid': 'like', 'aria-label': '123 likes' }, [T('♥')]));
        kids.push(h('button', { 'data-testid': 'retweet', 'aria-label': '45 reposts' }, [T('↻')]));
        kids.push(h('button', { 'data-testid': 'reply', 'aria-label': '12 replies' }, [T('↩')]));
        kids.push(h('div', { role: 'group', 'aria-label': '12 replies、45 reposts、123 likes、20 bookmarks、' + views + ' views' }, [T('g')]));
        kids.push(h('div', { 'data-testid': 'User-Name' }, [h('a', { href: '/user_' + id }, [T(name)])]));
        kids.push(h('div', { 'data-testid': 'tweetText' }, [T(text)]));
        kids.push(h('a', { href: '/user_' + id + '/status/' + id }, [T('link')]));
        if (o.promoted) kids.push(h('div', { 'data-testid': 'placementTracking' }, [T('ad')]));
        return h('article', { 'data-testid': 'tweet' }, kids);
      }
      // 六条：A(12000/1h) B(3000/3h) C(500/5h) D=推广 E=缺views A2=A 的重复（虚拟列表回收）
      const hotRoot = h('div', {}, [
        tw('111', '12,000', isoH(1), '甲', '第一条正文', {}),
        tw('222', '3,000', isoH(3), '乙', '第二条正文', {}),
        tw('333', '500', isoH(5), '丙', '第三条正文', {}),
        tw('444', '9,999', isoH(1), '丁', '推广正文', { promoted: true }),
        tw('555', null, isoH(2), '戊', '缺浏览量', {}),
        tw('111', '12,000', isoH(1), '甲', '第一条正文 回滚重现', {}),
      ]);
      const hs = run(hotRoot, '/home', 'https://x.com/home');
      const H = hs.__xprobe;

      // 验收 3：数字归一化 + 格式 + 三档阈值（构造断言，入口是纯函数）
      eq('hotFirstNum 去千分位/空格/NBSP/窄空格后取首数字',
        [H.hotFirstNum('12,000 views'), H.hotFirstNum('1\u00a0200 次浏览'), H.hotFirstNum('3\u202f000 vues'), H.hotFirstNum('无数字')],
        [12000, 1200, 3000, null]);
      eq('hotFmt 三档：>=1e6 写 M、整 k 不带小数、千位保留一位、其余取整',
        [H.hotFmt(1200000), H.hotFmt(12000), H.hotFmt(1000), H.hotFmt(500)],
        ['1.2M', '12k', '1.0k', '500']);
      eq('hotTier 三档：12000→viral红🔥 / 1000→trending橙🚀 / 其余→normal绿🌱',
        [H.hotTier(12000).key, H.hotTier(12000).icon, H.hotTier(1000).key,
         H.hotTier(1000).icon, H.hotTier(100).key, H.hotTier(100).icon],
        ['viral', '🔥', 'trending', '🚀', 'normal', '🌱']);
      eq('hotScore 按四段加权公式算并封顶 100',
        [H.hotScore({ views: 10000, likes: 100, rt: 50, replies: 20, bm: 30 }, 10000),
         H.hotScore({ views: 1, likes: 0, rt: 0, replies: 0, bm: 0 }, 1e9)], [47, 40]);

      // 验收 3（续）+ 2：单条抓取口径与流速误差 <1%
      const a = H.hotParseArticle(hotRoot.kids[0], HOT_NOW, null);
      const b = H.hotParseArticle(hotRoot.kids[1], HOT_NOW, null);
      const c = H.hotParseArticle(hotRoot.kids[2], HOT_NOW, null);
      eq('views=12000/1h → 12k/h 红🔥；3000/3h → 1.0k/h 橙🚀；500/5h → 100/h 绿🌱',
        [a.velLabel, a.tier, a.icon, b.velLabel, b.tier, b.icon, c.velLabel, c.tier, c.icon],
        ['12k/h', 'viral', '🔥', '1.0k/h', 'trending', '🚀', '100/h', 'normal', '🌱']);
      ok('第一名页面显示流速与 views/年龄(h) 误差 <1%（这里正好 0）',
        Math.abs(a.velocity - a.views / a.hours) / (a.views / a.hours) < 0.01 && a.hours === 1,
        [a.velocity, a.views / a.hours, a.hours]);
      eq('抓取只认本条推文：评论/转发/回复/书签数都从本条按钮与 group 取',
        [a.views, a.likes, a.rt, a.replies, a.bm], [12000, 123, 45, 12, 20]);

      // 验收 4/5/2：推广不进榜、按 tid 去重、按流速降序取前 N
      const board = H.hotBoard(HOT_NOW, { limit: 10 });
      eq('榜单覆盖 6 条、推广剔 1、缺数记 1、去重后入榜 3',
        [board.cov, board.promoted, board.miss, board.total], [6, 1, 1, 3]);
      eq('按流速降序：12000/h > 1000/h > 100/h，重复的那条只出现一次',
        board.rows.map((r) => r.tid + ':' + Math.round(r.velocity)), ['111:12000', '222:1000', '333:100']);
      eq('home 页面范围判定 = home', board.scope, 'home');
      eq('四类页面生效、保留路径不生效',
        [H.hotScope('/'), H.hotScope('/i/lists/abc'), H.hotScope('/alice/lists/x'),
         H.hotScope('/u/status/123'), H.hotScope('/zhangsan'), H.hotScope('/explore'), H.hotScope('/settings')],
        ['home', 'list', 'list', 'status', 'profile', '', '']);

      // 验收 4（嵌套引用推不串数）：内层引用推的 analytics 数字不许被外层抓走
      const nested = h('article', { 'data-testid': 'tweet' }, [
        h('a', { href: '/u/status/900/analytics', 'aria-label': '999999 views' }, [T('v')]),
        h('a', { href: '/u/status/901' }, [T('l')]),
        h('time', { datetime: isoH(1) }, [T('t')]),
        h('div', { 'data-testid': 'tweetText' }, [T('外层')]),
        h('article', { 'data-testid': 'tweet' }, [
          h('a', { href: '/u/status/902/analytics', 'aria-label': '7 views' }, [T('v')]),
        ]),
      ]);
      eq('嵌套引用推：closest 过滤后外层只认自己的 999999，不串内层的 7',
        H.hotParseArticle(nested, HOT_NOW, null).views, 999999);

      // 验收 6：徽标总闸默认关；开才挂、关当场清零，且不动 X 自己的节点
      delete store[H.HOT_BADGE_KEY];
      eq('流速徽标总闸默认关（与拉黑徽标那道闸分开）', H.hotBadgeGet(), false);
      const xBefore = hotRoot.querySelectorAll('div[role="group"]').length;
      H.setHotBadge(true);
      const badgesOn = hotRoot.querySelectorAll('.' + H.HOT_BADGE_CLS).length;
      ok('开闸后每条入榜推文都挂上流速徽标（class=' + H.HOT_BADGE_CLS + '；ID 111 在 DOM 里出现两次就挂两颗，与榜单去重无关）', badgesOn === 4, badgesOn);
      H.setHotBadge(false);
      eq('关闸当场摘净：徽标节点清零、X 自己的节点一个没少',
        [hotRoot.querySelectorAll('.' + H.HOT_BADGE_CLS).length,
         hotRoot.querySelectorAll('[data-xprobe="hotvel"]').length,
         hotRoot.querySelectorAll('div[role="group"]').length], [0, 0, xBefore]);

      // 验收 9：榜单卡片可开合、点条目只在列表内高亮、不滚动页面
      hs.window.scrollY = 300;
      H.hotToggle();
      const list1 = IDS[H.HOTLIST_ID];
      ok('点「热」展开榜单卡片（挂在右缘列的 fixed 浮层，不在 X 的 header 里）', !!list1 && list1.id === H.HOTLIST_ID);
      const rows = list1.querySelectorAll('.ysy-hot-row');
      eq('榜单列出 3 行、首行是 12000/h', [rows.length, rows[0].getAttribute('data-hot-id')], [3, '111']);
      rows[0].fire('click');
      eq('点条目只列表内高亮，window.scrollY 不变',
        [rows[0].getAttribute('class'), !!rows[0].__scrolls, hs.window.scrollY],
        ['ysy-hot-row ysy-hot-on', false, 300]);
      H.hotToggle();
      ok('再点一次整棵摘除（关闭不留节点）', !hs.document.getElementById(H.HOTLIST_ID));

      // 验收 7：权限未新增（仍 6 项），没有 scripting/webRequest/cookies
      const mfA = JSON.parse(rd('manifest.json'));
      eq('manifest permissions 仍为原来 6 项、未加三条高危权限',
        [mfA.permissions.length, /scripting|webRequest|cookies/.test(JSON.stringify(mfA.permissions))],
        [6, false]);

      // 验收 8：版本戳四处一致
      const spA = rd('ui/sidepanel.js');
      eq('版本戳四处一致：manifest.version == core VER、core BUILD == sidepanel PANEL_BUILD',
        [mfA.version === SRC_VER, SRC_VER, /PANEL_BUILD = '([^']+)'/.exec(spA)[1] === SRC_BUILD, SRC_BUILD],
        [true, '0.12.0', true, '2026-11-10-b']);

      console.log('[art-020] 新增 ' + (pass - passBase) + ' 条断言通过 / 0 失败');
    }

    // ---- v0.12.0：落库确认制 + 单一数据源（发成功 ≠ 落库成功）----
    console.log('\n[v0.12.0] 落库确认制：只有云端确认过的行才允许清本机 / 浏览器');
    const pyDB = fs.readFileSync(path.join(__dirname, 'xprobe_db.py'), 'utf8');
    const pySink = fs.readFileSync(path.join(__dirname, 'log-sink.py'), 'utf8');
    const pyHost = fs.readFileSync(path.join(__dirname, 'native', 'xprobe_host.py'), 'utf8');
    ok('本机库只认五张台账的白名单（外部传不进表名/SQL）',
      /PURGE_TABLES = \{/.test(pyDB) &&
      ['bench_marks_ac', 'bench_marks_po', 'lib_users', 'lib_posts', 'block_marks'].every((k) => pyDB.includes('"' + k + '":')) &&
      !/DELETE FROM ["']?\+/.test(pyDB), '');
    ok('清理语句只按 id <= ack 水位删，坏游标拒绝、失败回滚',
      /DELETE FROM %s WHERE id <= \?/.test(pyDB) && /conn\.rollback\(\)/.test(pyDB) &&
      /if name not in PURGE_TABLES/.test(pyDB), '');
    ok('HTTP 回退与 Native 宿主都开了同一道门（/dbpurge 与 t=dbpurge）',
      /path\.startswith\("\/dbpurge"\)/.test(pySink) && /def dbpurge_body/.test(pySink) &&
      /if t == "dbpurge"/.test(pyHost), '');
    ok('SW 三条上云腿都要 persisted=true 才清本机（老服务端回不出这格 ⇒ 一行都不删）',
      (swSrc.match(/d\.persisted === true/g) || []).length === 3 &&
      /d\.persisted !== true \|\| Number\(d\.writeFail \|\| 0\) !== 0/.test(swSrc),
      (swSrc.match(/d\.persisted === true/g) || []).length);
    ok('清理先于水位落盘：清理失败就回退游标，绝不留下「本地有、再也不推」的死行',
      /purgeAcked\(jobs\)/.test(swSrc) && /wm\.au = before\.au; wm\.po = before\.po/.test(swSrc) &&
      /wm = before;/.test(swSrc), '');
    ok('浏览器态也只在确认落库后清，且按 handle|day|at / at|dir|target 精确配对（新采的不误删）',
      /if \(d\.persisted !== true \|\| Number\(d\.writeFail \|\| 0\) !== 0\) return out;/.test(swSrc) &&
      /function clearUploadedBrowserRows/.test(swSrc) && /dayKeys\[/.test(swSrc) && /evKeys\[/.test(swSrc), '');
    ok('guard 的 cool / goal / follows 是运行态不是上送队列：清理只碰 ev',
      /nextGuard = Object\.assign\(\{\}, guard/.test(swSrc) &&
      /ev: \[\]\.concat\(Array\.isArray\(guard\.ev\)/.test(swSrc), '');
    ok('清理走的是同一条回环通道（Native 优先 / HTTP 回退），不新增网络出口或权限',
      /const DB_PURGE_URL = 'http:\/\/127\.0\.0\.1:8765\/dbpurge'/.test(swSrc) &&
      /if \(m === 'POST' && u\.pathname === '\/dbpurge'\)/.test(swSrc) &&
      (swSrc.match(/manifest/g) || []).length >= 0, '');


})();

// [10] 的标题延后打印：扩展三层（[12]~[16]）是异步的，先等它跑完再排 [10]，输出顺序才是读的段落序
const liveHeader = () => console.log('\n[10] 端到端打真 sink：自检流量分流 + 真机通道正向对照（需先跑 start-sink.bat）');
if (process.argv.indexOf('--live') >= 0) {
  // 数据目录与 log-sink.py 同一套兜底：XPROBE_DIR → 作者历史目录存在则沿用 → ~/xprobe
  const legacy = path.resolve(__dirname, '..', 'temp').split(path.sep).join('/');
  const dir = process.env.XPROBE_DIR
    || (fs.existsSync(legacy) ? legacy + '/xprobe'
      : (process.env.USERPROFILE || process.env.HOME) + '/xprobe');
  const d0 = new Date();
  const ymd = [d0.getFullYear(), String(d0.getMonth() + 1).padStart(2, '0'), String(d0.getDate()).padStart(2, '0')].join('-');
  const paths = {
    state: dir + '/state.json',
    realLog: dir + '/xprobe-' + ymd + '.log',
    testLog: dir + '/xprobe-test-' + ymd + '.log',
    realNd: dir + '/logs/' + ymd + '.ndjson',
    testNd: dir + '/logs/test-' + ymd + '.ndjson',
    dumpIdx: dir + '/dump/index.log',
    dumpTestIdx: dir + '/dump-test/index.log',
  };
  const lines = (p) => { try { return fs.readFileSync(p, 'utf8').trim().split('\n'); } catch (e) { return []; } };
  const recsSince = (p, t0) => lines(p).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
    .filter((r) => new Date(r.receivedAt || 0).getTime() >= t0);
  const json = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; } };
  const realXhr = (o) => {
    const init = { method: o.method, headers: o.headers || {} };
    if (o.data) init.body = o.data;
    return fetch(o.url, init).then((r) => r.text().then((t) => o.onload({ status: r.status, responseText: t })), (e) => o.onerror({ status: 0, msg: String(e) }));
  };
  const bTotal = json(paths.state).total || 0;
  const bTest = json(paths.state).testTotal || 0;
  const bDump = json(paths.state).dumpTotal || 0;
  const bDumpTest = json(paths.state).dumpTestTotal || 0;
  store['ysy.xprobe.dump'] = true; // 本轮把转储开关打开：/dump 这条通道也要端到端过一遍
  const t0 = Date.now() - 2000; // 只认本轮之后落盘的记录，上一轮的 selftest 记录不算（receivedAt 由 sink 盖，本地时区）

  function spawn(isReal) {
    Object.keys(IDS).forEach((k) => delete IDS[k]);
    // 正向对照走一个自明的假 handle：真机日志里出现 selftest-zz 就说明是测试打的，不是现场
    const seg = isReal ? 'selftest-zz' : 'demo_own';
    const sb = makeSandbox(isReal ? selftestProfile() : profile, '/' + seg, 'https://x.com/' + seg, false);
    sb.__XPROBE_TEST = isReal ? 0 : 1;
    sb.GM_xmlhttpRequest = realXhr;
    vm.runInNewContext(src, sb, { filename: SRC, timeout: 15000 });
    sb.__runTimers(3);
    return sb;
  }
  const sbT = spawn(false); // t=1：自检流量，应分流
  const sbR = spawn(true);  // t=0：模拟真机，应进我读的那两个文件

  // v0.4.0 新增的 follow 记录也端到端过一遍（只走 t=1：真机通道那条「本轮正好 +3」的严格断言不能被搅）
  const pfBtn = profile.querySelector('[data-testid="987654321-follow"]');
  pfBtn.attrs['data-testid'] = '987654321-unfollow'; pfBtn.attrs['aria-label'] = '正在关注 @demo_own';
  sbT.__xprobe.onMutations([{ type: 'attributes', target: pfBtn }]);
  sbT.__xprobe.flush();

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    await layersDone.catch((e) => { fail++; console.log('  FAIL 扩展三层跑挂了: ' + e.stack); });
    liveHeader();
    const pingRes = await fetch('http://127.0.0.1:8765/ping').then((r) => r.json()).catch(() => ({}));
    const sinkNum = Number(String(pingRes.sink || '').replace(/^sink-/, ''));
    ok('在跑的接收端够新（本轮要 sink-18：`/db` 认 `after` 台账游标是 18 才有的；旧进程只吃 `limit`，标杆同步每次从头推整本账）',
      sinkNum >= 18, pingRes);

    // 本轮记录分几个 POST 发出；Node 的 fetch 连接池会偶发 reset，而 POST 不会被自动重试
    // ⇒ 缺谁就再发一次，直到本轮该有的 3+3 条与两份转储都落齐（真机那边有 1.2s 定时器一直在重试）
    await wait(2500);
    for (let i = 0; i < 5; i++) {
      const s = json(paths.state);
      if (s.total >= bTotal + 3 && (s.testTotal || 0) >= bTest + 3 &&
        (s.dumpTotal || 0) >= bDump + 1 && (s.dumpTestTotal || 0) >= bDumpTest + 1) break;
      sbT.__xprobe.flush(); sbR.__xprobe.flush();
      await wait(1000);
    }
    let folRec = null;
    for (let i = 0; i < 6 && !folRec; i++) {
      folRec = recsSince(paths.testNd, t0).filter((r) => r.kind === 'follow').pop() || null;
      if (!folRec) { sbT.__xprobe.flush(); await wait(800); }
    }
    ok('follow 记录端到端落进 test-ndjson（dir/tab/w15 与目标 ID 都在）',
      !!folRec && folRec.t === 1 && folRec.tab === 'profile' && folRec.data.dir === 'follow' &&
      folRec.data.targetId === '987654321' && folRec.data.w15 >= 1, folRec);
    ok('sink 的 follow 摘要行成形（页型 + handle + 滚动窗口，不是裸 URL）',
      /follow\[profile\] @demo_own id=987654321 follow 15分钟=\d+\/15 24小时=\d+\/400 判据=follow→unfollow/.test(lines(paths.testLog).slice(-10).join('\n')),
      lines(paths.testLog).slice(-1));

    console.log('\n[10d] 60 秒冷却端到端：紧跟其后的第二次关注，sink-8 要把「距上次=Ns [60秒内!]」打出来');
    const cb = h('button', { 'data-testid': '987654322-follow', 'aria-label': '关注 @zz_cooldown' }, [T('关注')]);
    sbT.__xprobe.onMutations([{ type: 'childList', addedNodes: [cb], removedNodes: [] }]);   // 基线，不计数
    cb.attrs['data-testid'] = '987654322-unfollow'; cb.attrs['aria-label'] = '正在关注 @zz_cooldown';
    sbT.__xprobe.onMutations([{ type: 'attributes', target: cb }]);
    sbT.__xprobe.flush();
    let cRec = null;
    for (let i = 0; i < 6 && !cRec; i++) {
      cRec = recsSince(paths.testNd, t0).filter((r) => r.kind === 'follow' && r.data && r.data.targetId === '987654322').pop() || null;
      if (!cRec) { sbT.__xprobe.flush(); await wait(800); }
    }
    ok('记录里 gap 是实测毫秒、rapid=true、cool=60000', !!cRec && typeof cRec.data.gap === 'number' &&
      cRec.data.rapid === true && cRec.data.cool === 60000, cRec && cRec.data);
    ok('sink 的摘要行把违规标打出来了（正向对照：这一行必须由 sink-8 生成，旧版根本不会出现这两段）',
      /follow\[profile\] @zz_cooldown id=987654322 follow .*判据=follow→unfollow 距上次=\d+(\.\d+)?s \[60秒内!\]/
        .test(lines(paths.testLog).slice(-10).join('\n')), lines(paths.testLog).slice(-1));
    ok('上一条（间隔未知 ⇒ gap=null）不许被误标成违规',
      !/id=987654321 .*60秒内/.test(lines(paths.testLog).join('\n')), lines(paths.testLog).slice(-3));
    ok('t=1 沙箱 sink 连通', sbT.__xprobe.status().sinkOk === true, sbT.__xprobe.status());
    ok('t=0 沙箱 sink 连通', sbR.__xprobe.status().sinkOk === true, sbR.__xprobe.status());
    const tR = recsSince(paths.testNd, t0), rR = recsSince(paths.realNd, t0);
    ok('自检记录分流到 test-*.ndjson 且 t=1', tR.length >= 3 && tR.every((r) => r.t === 1), { n: tR.length, t: tR.map((r) => r.t) });
    ok('真机通道正向对照：t=0 记录进真机 ndjson', rR.length >= 3 && rR[rR.length - 1].t === 0, { n: rR.length, t: rR[rR.length - 1] && rR[rR.length - 1].t });
    ok('真机摘要日志有本轮 selftest-zz 行（新格式带页型；扫全文件——机器在用是常态，最近几行可能被真机流量顶掉）',
      /page\[profile\] @selftest-zz/.test(lines(paths.realLog).join('\n')), lines(paths.realLog).slice(-2));
    ok('自检摘要只在 test 摘要日志里', /page\[profile\] @demo_own/.test(lines(paths.testLog).join('\n')), lines(paths.testLog).slice(-2));
    // 三条记录是三次独立 POST，ThreadingHTTPServer 各起一线，落盘顺序不保证；顺序看记录里的 at。
    // 机器忙时真机自身的 beacon/page/store 行会混进同一窗口——锚定 selftest-zz 标记只验我们自己的三条，
    // 周围混着什么不计（真机流量要是连这三条都不许有，那就没法在你正常用机器时跑了）。
    const own = rR.filter((r) => String(r.url || '').indexOf('selftest-zz') >= 0);
    ok('真机本轮：我们那三条（beacon/page/probe）都在，周围混进来的真机记录不算数',
      own.length >= 3 && ['beacon', 'page', 'probe'].every((k) => own.map((r) => r.kind).indexOf(k) >= 0),
      { n: rR.length, own: own.map((r) => r.kind) });
    const byAt = own.slice().sort((a, b) => String(a.at).localeCompare(String(b.at))).map((r) => r.kind);
    eq('我们的三条按 at 排回来是 beacon→page→probe', byAt, ['beacon', 'page', 'probe']);
    const pageRec = own.filter((r) => r.kind === 'page').pop() || {};
    eq('page.cov.summaryAria 真机通道也对得上', pageRec.cov && pageRec.cov.summaryAria, '1/3');
    ok('page.miss 首项 tab.posts.number', (pageRec.miss || [])[0] === 'tab.posts.number', pageRec.miss);
    eq('selftest-zz 归类为 profile 页', pageRec.tabType, 'profile');
    const st = json(paths.state);
    ok('state.total 至少把 t=0 那三条记进去（机器忙时真机自己的几条也计入，总数没有上限口径）', st.total >= bTotal + 3, { before: bTotal, after: st.total });
    ok('state.testTotal 单独累计自检', st.testTotal >= bTest + 3, { before: bTest, after: st.testTotal });

    console.log('[10b] 整页转储端到端（/dump 落文件，不进记录流）');
    const readFile = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
    const lastDumpDir = (p) => { const ls = lines(p); return ls.length ? ls[ls.length - 1].split(' ')[1] : ''; };
    const relT = lastDumpDir(paths.dumpTestIdx), relR = lastDumpDir(paths.dumpIdx);
    ok('自检转储分流到 dump-test/', /dump-test\//.test(relT) && relT.includes('-profile-demo_own'), relT);
    ok('真机通道转储落 dump/（正向对照）', relR.includes('-profile-selftest-zz'), relR);
    const treeT = readFile(dir + '/' + relT + '/tree.txt'), metaT = json(dir + '/' + relT + '/meta.json');
    ok('tree.txt 是整页结构原文（testid + 聚合 aria 都在）',
      /data-testid="User-Name"/.test(treeT) && /11 回复、9 喜欢、122 次观看/.test(treeT), treeT.slice(0, 150));
    eq('meta.json 带 t=1 与页型', [metaT.t, metaT.tab], [1, 'profile']);
    ok('text.txt 落了整页可见原文', /示例笔记|关注者/.test(readFile(dir + '/' + relT + '/text.txt')), '');
    ok('默认不落 page.html（全文 HTML 是另开的重开关）', fs.existsSync(dir + '/' + relT + '/page.html') === false, '居然有 page.html');
    ok('真机那份 dump 的 meta 是 t=0', json(dir + '/' + relR + '/meta.json').t === 0, json(dir + '/' + relR + '/meta.json'));
    ok('测试转储没混进真机 dump 目录', !/demo_own/.test(lines(paths.dumpIdx).slice(-6).join('\n')), lines(paths.dumpIdx).slice(-2));
    const st2 = json(paths.state);
    ok('dumpTotal / dumpTestTotal 各自累计，且没动 total', st2.dumpTotal >= bDump + 1 && st2.dumpTestTotal >= bDumpTest + 1,
      { dump: [bDump, st2.dumpTotal], dumpTest: [bDumpTest, st2.dumpTestTotal], total: st2.total });

    console.log('\n[10c] 奖励页曝光端到端：reward 记录 + sink 摘要行（交证据这条腿真的落盘）');
    const rwT0 = Date.now() - 2000;
    delete store['ysy.xprobe.series'];   // 本轮当成「今天第一次读数」，摘要行才该写「落库」而不是「同值覆盖」
    delete store['ysy.xprobe.own'];
    Object.keys(IDS).forEach((k) => delete IDS[k]);
    const sbRW = makeSandbox(rewardsRoot(), RW_PATH, 'https://x.com' + RW_PATH, false);
    sbRW.__XPROBE_TEST = 1;                    // 只走自检通道：别把「本轮正好 3 条」那条真机计数断言搅浑
    sbRW.GM_xmlhttpRequest = realXhr;
    vm.runInNewContext(src, sbRW, { filename: SRC, timeout: 15000 });
    sbRW.__xprobe.doCollect({ force: true });
    sbRW.__xprobe.flush();
    let rwRec = null;
    for (let i = 0; i < 6 && !rwRec; i++) {
      rwRec = recsSince(paths.testNd, rwT0).filter((r) => r.kind === 'reward').pop() || null;
      if (!rwRec) { sbRW.__xprobe.flush(); await wait(800); }
    }
    ok('reward 记录落进 test-ndjson：own/day/值/候选都在（候选就是下一轮收窄判据的原料）',
      !!rwRec && rwRec.t === 1 && rwRec.data.own === 'demo_own' && rwRec.data.value === 10100 &&
      /^\d{4}-\d{2}-\d{2}$/.test(rwRec.data.day) && rwRec.data.cands.length >= 1, rwRec && rwRec.data);
    ok('sink 的 reward 摘要行成形：曝光值 + 被剔掉的门槛 + 区域里剩下的数字',
      /reward @demo_own \d{4}-\d{2}-\d{2} 曝光=10100\(缩写\) 落库 关键词节点=1 门槛=\["90","50 万"\] 区域数字=\["90","10.1k","2"\]/.test(
        lines(paths.testLog).slice(-14).join('\n')), lines(paths.testLog).slice(-3));
    ok('同一条 reward 也进了 store 摘要的「序列=」（面板/store 行看得到点位数）',
      /store 表=\d+人\/\d+帖 序列=\d+min\/\d+day/.test(lines(paths.testLog).slice(-14).join('\n')), lines(paths.testLog).slice(-1));

    console.log('\n合计 ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  })();
} else {
  layersDone.catch((e) => { fail++; console.log('  FAIL 扩展三层跑挂了: ' + e.stack); }).then(() => {
    liveHeader();
    console.log('  SKIP（加 --live 且 sink 在跑时才做）');
    console.log('\n合计 ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  });
}

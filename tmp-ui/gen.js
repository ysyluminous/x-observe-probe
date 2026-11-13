// 用真 view.js + 真 kit.js + 真 CSS 生成一张静态预览（布局/配色验真用）
const fs = require('fs'), vm = require('vm');

// ---- DOM 桩（能序列化回 HTML）----
function El(tag) {
  this.tagName = tag; this.className = ''; this._text = ''; this.title = '';
  this.children = []; this.style = {}; this.dataset = {}; this.attrs = {};
  this.classList = { add: (...c) => { this.className = (this.className + ' ' + c.join(' ')).trim(); },
    remove: (c) => { this.className = this.className.split(/\s+/).filter(x => x && x !== c).join(' '); } };
}
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._text || this.children.map(c => c.outerHTML || '').join(''); },
  set(v) { this._text = String(v); this.children = []; },
});
El.prototype.append = function (...n) { n.forEach(x => this.children.push(x)); };
El.prototype.appendChild = function (n) { this.children.push(n); return n; };
El.prototype.addEventListener = function () {};
El.prototype.setAttribute = function (k, v) { this.attrs[k] = v; };
El.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
El.prototype.getAttribute = function (k) { return this.attrs[k]; };
const ESC = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
Object.defineProperty(El.prototype, 'outerHTML', {
  get() {
    const cls = this.className ? ' class="' + ESC(this.className) + '"' : '';
    const ttl = this.title ? ' title="' + ESC(this.title) + '"' : '';
    const idd = this.id ? ' id="' + ESC(this.id) + '"' : '';
    const hrf = this.href ? ' href="' + ESC(this.href) + '"' : '';
    const extra = Object.keys(this.attrs).map(k => ' ' + k + '="' + ESC(this.attrs[k]) + '"').join('');
    const inner = this._text ? ESC(this._text) : this.children.map(c => c.outerHTML).join('');
    return '<' + this.tagName.toLowerCase() + idd + cls + ttl + hrf + extra + '>' + inner + '</' + this.tagName.toLowerCase() + '>';
  },
});

const doc = { createElement: t => new El(t), createElementNS: (n, t) => new El(t),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
const sb = { console, document: doc, window: {}, navigator: { userAgent: 'node' }, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number };
sb.globalThis = sb; sb.self = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync('extension/ui/kit.js', 'utf8'), sb);
const K = sb.XPROBE_KIT.create({ pageLabel: '工作台', render: () => {}, fetchDb: null, one: null, getSt: () => null });
vm.runInContext(fs.readFileSync('extension/ui/view.js', 'utf8'), sb);
const V = sb.globalThis.XPROBE_VIEW;

// 真 mapCloudRows
const dash = fs.readFileSync('extension/ui/dashboard.js', 'utf8').split('\n');
const i0 = dash.findIndex(l => l.includes('function mapCloudRows'));
let i1 = i0; while (i1 < dash.length && !/^  \}\s*$/.test(dash[i1])) i1++;
const sb2 = { console, Object, Array, String, Number, JSON, Math }; sb2.globalThis = sb2;
vm.createContext(sb2);
vm.runInContext(dash.slice(i0, i1 + 1).join('\n') + '\nthis.__map = mapCloudRows;', sb2);
const mapCloudRows = sb2.__map;

// ---- 造数据（形状照线上 PG 真实回包）----
const mkAcct = (handle, views, eng, fans, postsN) => ({ handle, displayName: null, fans, fow: 100, postsN, views, eng, lastPostAt: null, lastSeen: '2026-11-13T03:32:05.784Z' });
const A = [mkAcct('miles_mazy', 2527146, 20102, 33000, 4), mkAcct('king_of_options', 1727371, 18832, 2978, 5),
  mkAcct('csccbt5', 37700, 3407, 9358, 32), mkAcct('sanwanyingchi23', 208371, 3348, 4282, 8),
  mkAcct('5trm1p', 742939, 2788, 3842, 5), mkAcct('crypto_146827', 309770, 2100, 18000, 2),
  mkAcct('0x_sunxiaomei', 936000, 1351, 7744, 10), mkAcct('allangs', 928000, 1078, 1811, 16),
  mkAcct('azurel_wei', 783000, 876, 3238, 16), mkAcct('chenyid_alex', 209000, 638, null, 16)];
const P = [
  { xPostId: '2108121840485106124', authorHandle: 'lilywang2758', textSnapshot: '美国前海军陆战队员维克多·马克思， 演示0.8秒徒手夺枪、卸弹匣。', view: 7030614, likeCount: 12999, eng: 15267 },
  { xPostId: '2118317430665613741', authorHandle: 'eianlu', textSnapshot: '', view: 4680232, likeCount: 33535, eng: 0 },
  { xPostId: '2114026169813414022', authorHandle: 'elonmusk', textSnapshot: 'Talarico is lunatic left', view: 3634984, likeCount: 39463, eng: 21000 },
  { xPostId: '2031419178570092647', authorHandle: 'elonmusk', textSnapshot: 'Talarico is a far left extremist', view: 3525272, likeCount: 39000, eng: 20500 },
  { xPostId: '2114377735841730673', authorHandle: 'elonmusk', textSnapshot: 'Talarico is a far left extremist', view: 3525272, likeCount: 38800, eng: 20400 },
  { xPostId: '2114513319625400679', authorHandle: 'mftai666', textSnapshot: '在车上遇见一个爷爷 耳朵扎满了针 这有啥作用吗', view: 3358275, likeCount: 12000, eng: 9000 },
  { xPostId: '2111658981261467651', authorHandle: 'yang0668', textSnapshot: '宇航员在太空执行任务的时候 性生活是怎么解决的？', view: 2722081, likeCount: 9000, eng: 8000 },
  { xPostId: '2113454749198746089', authorHandle: 'zhuyiheng36033', textSnapshot: '太原那个司机 tm的要笑死我吗', view: 2534498, likeCount: 7000, eng: 6000 },
  { xPostId: '2118321297490895148', authorHandle: 'miles_mazy', textSnapshot: '哥，删了吧，这玩意在市面上至少卖四位数的……', view: 2381301, likeCount: 6500, eng: 5600 },
  { xPostId: '2114627189119566266', authorHandle: 'making_cindy', textSnapshot: "Cindy made today's GitHub top 1 One …", view: 2238239, likeCount: 6000, eng: 5000 },
];
const F = [
  { target: 'annieouannie', at: '2026-11-13T03:20:00Z', follow_back: 'unknown' },
  { target: 'johnson2i32', at: '2026-11-13T02:10:00Z', follow_back: 'no' },
  { target: 'forest2811', at: '2026-11-13T01:05:00Z', follow_back: 'unknown' },
];

const db = {
  at: Date.now() - 42000, ms: 259, via: 'cloud', id: 'x',
  acct: { ok: true, rows: mapCloudRows('accounts', { records: A }) },
  post: { ok: true, rows: mapCloudRows('posts_top', { records: P }) },
  followStarts: { ok: true, rows: mapCloudRows('follow_starts', { rows: F }) },
  tlDays: { ok: false, rows: [], err: '' },
  tl: { ok: false, rows: [], err: '云端不采集：PG 未存时间线分源榜单，云端不采集（本地库档看得到）' },
};
const st = { series: { own: 'me', handles: [{ h: 'me', own: true, imp: 0, min: 0 }], key: 'me' } };
const lines = V.plazaLines(st, { now: Date.now(), db, acct: 'views', post: 'view', acctLimit: 10, postLimit: 10, tlDay: '', tlSrcf: '', tlLimit: 10, tlSort: 'view' });

const report = new El('main'); report.id = 'report';
const bar = new El('div'); bar.className = 'bar';
const b = new El('button'); b.type = 'button'; b.id = 'bDbRefresh'; b.textContent = '重读库'; bar.append(b);
report.append(bar);
K.appendSafe(report, lines);

// 页签（真 renderTabs 的产物）
const TABS = [['home','概览','home.html'],['mine','我的','mine.html'],['plaza','广场','plaza.html'],['fc','预测','fc.html'],['debug','诊断','debug.html'],['set','设置','set.html']];
const nav = new El('nav'); nav.id = 'dTabs'; nav.setAttribute('role','tablist');
TABS.forEach(([k,txt,file]) => { const a = new El('a'); a.href = file; a.textContent = txt; a.className = file === 'plaza.html' ? 'on' : ''; nav.append(a); });

const head = new El('header'); head.id = 'dashHead';
const t = new El('div'); t.id = 'dTitle'; t.textContent = 'X 观测探针 · 工作台'; head.append(t);
const gap = new El('span'); gap.id = 'dHeadGap'; head.append(gap);
const lamp = new El('span'); lamp.id = 'dLamp'; lamp.className = 'ok'; lamp.textContent = '开发 · 已登录'; head.append(lamp);
const upd = new El('span'); upd.id = 'dUpdatedAt'; upd.textContent = '读于 13:13'; head.append(upd);
const rf = new El('button'); rf.type='button'; rf.id='dRefresh'; rf.textContent='刷新'; head.append(rf);

const err = new El('div'); err.id='dErr';
err.textContent = 'content script 没接（刚刷新？等它自己起）：Could not establish connection. Receiving end does not exist';

const kpis = new El('nav'); kpis.id = 'dKpis';
const foot = new El('footer'); foot.id = 'dFoot';
foot.textContent = '数据源: 云端 · 开发 · http://localhost:3100 前端智枢网关转发到 Go · v0.12.20 · 2026-11-13-d · 只读观测 · 本页不请求 x.com · 不点页面任何东西\n口径: 未回关 = follow_starts 里面 follow_back=no（unknown 另说，不判）；榜 = accounts/posts_top/posts_growth，今日还迁 = 面板「今日目标」同一本账。没采的数照写 — 不编数。';

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="color-scheme" content="dark"><title>工作台 · 广场（改版预览）</title>
<link rel="stylesheet" href="../extension/ui/sidepanel.css">
<link rel="stylesheet" href="../extension/ui/dashboard.css">
</head><body class="dash">
${head.outerHTML}${err.outerHTML}${kpis.outerHTML}${nav.outerHTML}${report.outerHTML}${foot.outerHTML}
</body></html>`;
fs.writeFileSync('tmp-ui/preview.html', html, 'utf8');
console.log('wrote tmp-ui/preview.html', html.length, 'bytes');

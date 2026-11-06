// 补历史 / 改数 —— 独立编辑窗（面板两张日点表各有一颗「编辑」，弹的是同一个窗口）。
// kind=imp（默认）管 时间/总曝光/有效曝光；kind=fow 管 时间/关注/粉丝/帖子。
// 自动保存（用户的话：「能不能帮我改成异步的，只要表格修改就立马触发保存」）：没有「存」按钮，
// 任何一格改完（change = 离开输入框/按回车/点步进箭头）当场交 impAdd —— 同日按列合并、
// 空框 = 不动那列，所以先填一列先落一列，分几次交也不会互相抹。「加/存」走的是与面板同一套
// 命令：SW 转给 x.com 标签页上的 core 执行 → 本机库 day_rows，这里不自己写账。
// 「删」只有 imp 模式有：impDel 删的是整行（连曝光列一起），从关注粉丝窗里一按会把曝光的账也删没。
'use strict';
const SERIES_KEY = 'ysy.xprobe.series';
const who = decodeURIComponent((location.search.match(/[?&]who=([^&]*)/) || [])[1] || '');
const kind = decodeURIComponent((location.search.match(/[?&]kind=([^&]*)/) || [])[1] || '');
const FOW = kind === 'fow';
// 两模式只差列名与 impAdd 的键，列配置只留这一处；payload 恒交全五键，没开的列传空串 = core 那头不动那列
const COLS = FOW
  ? [{ k: 'fow', label: '关注' }, { k: 'fans', label: '粉丝' }, { k: 'posts', label: '帖子' }]
  : [{ k: 'value', label: '总曝光' }, { k: 'eff', label: '有效曝光' }];
const $ = (id) => document.getElementById(id);
let tabId = null;

$('who').textContent = who ? '—— @' + who : '';
if (FOW) {
  document.title = 'X 探针 · 补 关注 / 粉丝 / 帖子';
  $('sub').textContent = '关注 / 粉丝 = 打开对应主页自动采（日点一行）；帖子数 X 的页面不给，只能在这里补。' +
    '改完就自动保存；空框 = 不动那列（清空一个格抹不掉旧数，只能填对的盖掉）；缩写也能填（13.2K / 1.3万 → 换算成整数、行上标 ~ 非精确）。';
  $('tip').textContent = '每一行改完（离开输入框或按回车）就自动写进本机库（同一天按列合并，空框不动那列）。' +
    '补历史用表格下方的「+」行：默认自动取表里最早那天的前一日（不用手选，也能改）、落一笔记日期自动 −1，往前连补一路填就行；顶部那行是往后补（日期 +1）。' +
    '这里没有「删」——删整行（连曝光列一起删）去曝光那张表的编辑窗。';
}

function showErr(s) { $('err').textContent = s || ''; }

// 补录要经 x.com 页面上的采集端写账 ⇒ 先找标签页；一个都没有就明说，不静默失败
function pickTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }, (ts) => {
      ts = ts || [];
      if (!ts.length) { resolve(null); return; }
      const act = ts.find((t) => t.active);
      resolve((act || ts[0]).id);
    });
  });
}
function send(t, v) {
  return chrome.runtime.sendMessage({ t, tabId, v }).then((r) => {
    if (!r) throw new Error('空回包');
    return r;
  });
}
function nextDay(day) {
  const d = new Date(String(day || '') + 'T00:00:00');
  if (isNaN(d.getTime())) return day;
  d.setDate(d.getDate() + 1);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function prevDay(day) {
  const d = new Date(String(day || '') + 'T00:00:00');
  if (isNaN(d.getTime())) return day;
  d.setDate(d.getDate() - 1);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function loadRows() {
  return chrome.storage.local.get(SERIES_KEY).then((o) => {
    const ser = o[SERIES_KEY] || {};
    const imp = (ser[who] || {}).imp || [];
    return imp.slice().sort((a, b) => (a.day < b.day ? 1 : -1));   // 新的在上：补历史主要动最近的天
  });
}

function render(rows) {
  const g = $('grid');
  g.textContent = '';
  const tr = (cells) => { const r = document.createElement('tr'); cells.forEach((c) => r.append(c)); return r; };
  const th = (t) => { const e = document.createElement('th'); e.textContent = t; return e; };
  const td = (c) => { const e = document.createElement('td'); e.append(c); return e; };
  const dayCell = (t) => { const e = document.createElement('td'); e.className = 'day'; e.textContent = t; return e; };
  const numI = (v) => { const i = document.createElement('input'); i.type = 'number'; i.min = '0'; i.step = '1'; if (v != null) i.value = String(v); return i; };
  g.append(tr([th('日期')].concat(COLS.map((c) => th(c.label))).concat(FOW ? [] : [th('操作')])));

  // impAdd 的键恒收全五列：本模式没开的列传空串（= 不动那列），两模式共用这一个交法
  const payload = (day, ins) => {
    const v = { day, handle: who, value: '', eff: '', fow: '', fans: '', posts: '' };
    COLS.forEach((c, i) => { v[c.k] = ins[i].value.trim(); });
    return v;
  };
  // 写账一处：成功返回 true（加行靠它决定要不要推进日期），失败把 core 的话原样摆到 err 行
  const apply = (v) => send('impAdd', v).then((r) => {
    const x = (r && r.result) || {};
    if (!r || !r.ok || x.ok === false) { showErr((x && x.err) || (r && r.err) || '没存上'); return false; }
    reloadSoon();
    return true;
  }).catch((e) => { showErr('发不出去：' + (e && e.message || e)); return false; });

  // 加行共一个造法（顶部 = 往后补、落账后日期 +1；底部「+」= 往前补历史、落账后 −1）。
  // 自动保存：日期框或任一数字框一 change 就试交——一个数都没有就还等着不催不报错（改日期本身
  // 不该报错），有数没日期才提醒；交成功就推进日期清空数字框，连着填一路顺。
  const mkAddRow = (defDate, advance, tipLead) => {
    const dIn = document.createElement('input'); dIn.type = 'date'; dIn.value = defDate;
    dIn.title = tipLead + '：填上数就自动写进本机库（同一天按列合并）；日期框也能直接改成任何过去的日子';
    const ins = COLS.map(() => numI(null));
    const tryAdd = () => {
      showErr('');
      if (!ins.some((i) => i.value.trim())) return;
      const day = dIn.value;
      if (!day) { showErr('补录要日期'); return; }
      apply(payload(day, ins)).then((ok) => {
        if (!ok) return;
        dIn.value = advance(day); ins.forEach((i) => { i.value = ''; });
      });
    };
    [dIn].concat(ins).forEach((el) => el.addEventListener('change', tryAdd));
    return tr([td(dIn)].concat(ins.map((i) => td(i))));
  };
  // 顶部行：管今天/往后，落账日期 +1（连补 25/26/27 顺）
  g.append(mkAddRow(today(), nextDay, '往后补一天'));

  rows.forEach((p) => {
    const ins = COLS.map((c) => numI(p[c.k]));
    const save = () => { showErr(''); apply(payload(p.day, ins)); };
    ins.forEach((i) => {
      i.title = '改完就自动保存（离开输入框或按回车）；空框 = 不动那列（清空抹不掉旧数，想重填就填对的盖掉）';
      i.addEventListener('change', save);
    });
    const cells = [dayCell(p.day)].concat(ins.map((i) => td(i)));
    if (!FOW) {
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '删';
      del.title = '删掉 ' + p.day + ' 这一行（打错数就删了重加；关注/粉丝/帖子也一起删）';
      del.addEventListener('click', () => {
        showErr('');
        send('impDel', { day: p.day, handle: who }).then(() => {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
          reloadSoon();
        }).catch((e) => showErr('发不出去：' + (e && e.message || e)));
      });
      cells.push(td(del));
    }
    g.append(tr(cells));
  });

  // 底部「+」行（用户的话：「需要能一直添加之前的 是不是表格下方加一个加号」；v0.8.1-i 续：
  // 「向下添加的时候……可以自动计算前一个日期……默认就是前一日，手动可以修改罢了」）：
  // 默认 = 表里最早那天的前一日（没有行才退回昨天），落账日期 −1 —— 往前连补一路填，日期框也能直接改
  const earliest = rows.length ? rows[rows.length - 1].day : '';
  g.append(mkAddRow(earliest ? prevDay(earliest) : prevDay(today()), prevDay, '往前补历史'));
}

// core 写完存储回包有个先后，稍等一拍再重读，免得窗口里还挂着旧数。
// 但不许抢焦点（自动保存后的重读如果正好赶上人在连填几列/几天，整表一重建，正在打字的框和
// 焦点就没了）：焦点还在表格里就先挂着，等 focusout（焦点离开表格）再刷。
let reloadArmed = false;
function reloadSoon() {
  setTimeout(() => {
    if ($('grid').contains(document.activeElement)) {
      if (!reloadArmed) {
        reloadArmed = true;
        $('grid').addEventListener('focusout', () => { reloadArmed = false; reloadSoon(); }, { once: true });
      }
      return;
    }
    loadRows().then(render);
  }, 200);
}

pickTab().then((id) => {
  tabId = id;
  if (id == null) { showErr('补录要经 x.com 页面上的采集端写账——先开着任意一个 x.com 标签页，再点面板的「编辑」。'); return; }
  loadRows().then(render);
});

// X 观测探针 · Side Panel 外壳：取数、排版、把按钮变成给 content script 的命令。
// 这里没有判定逻辑（在 core.js），也没有格式化逻辑（在 view.js，可在 Node 里断言）。
// 面板自己也是扩展页面：它只跟 chrome.runtime 与本机下载说话，绝不请求 x.com。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const V = globalThis.XPROBE_VIEW;
  // SVG 的名字空间是个 XML 标识符，不是要请求的地址（面板只对 chrome.runtime 与本机下载说话）
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 面板自己的版本戳（不是 core 报的那个）：⟳ 之后若这颗还是旧值，说明这个 Side Panel 文档
  // 没跟着换（Chrome 会让已打开的面板继续跑旧 JS），先关掉重开面板再谈别的。
  const PANEL_BUILD = '2026-11-05-r';
  const out = { err: '' };
  let st = null, lastStateAt = 0, view = 'home', rndDirty = false, ownDirty = false, whoSel = '';
  // state 回包可能乱序（广场那条 30 秒轮询 + 关注事件触发的 READ 会同时在飞）：
  // 只认发出时序号更大的那一份，免得一份「关注之前算出来的」旧 state 把刚翻红的横幅又盖回绿。
  let stateSeq = 0, stateDone = 0;
  // 共享台账（ysy.xprobe.guard）变更后的回读节流句柄
  let guardReload = 0;
  // 本机库的两份 rows（广场用）。不在 900ms 状态轮询里读：每次 sendNativeMessage 都会新起一个宿主进程，
  // 只在进广场时读一次，之后 30 秒刷一次（点「重读库」可立刻再读）。
  let db = null, dbBusy = false, dbAt = 0;

  function send(msg) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          const e = chrome.runtime.lastError;
          if (e) {
            const m = String(e.message || e);
            // 插件 ⟳ 重载之后，重载前打开的这个 Side Panel 是孤儿：内存里 state 还是旧的（看着一切正常），
            // 但 runtime 已经换了，每条消息都是 "Receiving end does not exist"——用户看起来就是「点了没反应」。
            // 必须点名怎么救：关掉重开面板，而不是让他们以为按钮坏了。
            const orphan = /Receiving end does not exist|Extension context invalidated|message port closed/i.test(m);
            res({ ok: false, err: orphan
              ? '插件刚重载过（⟳），这个面板是旧副本：把它关掉重开（或重新点扩展图标）就好——旧面板上看着有数的都是重载前的内存'
              : String(m).slice(0, 120) });
          } else res(reply || { ok: false, err: '扩展没响应（service worker 刚睡？再点一次）' });
        });
      } catch (e) {
        const m = String((e && e.message) || e).slice(0, 120);
        res({ ok: false, err: /Receiving end does not exist|Extension context invalidated/i.test(m)
          ? '插件刚重载过（⟳），这个面板是旧副本：把它关掉重开（或重新点扩展图标）就好——旧面板上看着有数的都是重载前的内存'
          : m });
      }
    });
  }

  // 命令带上当前选中的标签页；没选就让 SW 去找活动页
  function cmd(t, v) {
    const tabId = $('tabPick').value;
    const msg = { t: t };
    const seq = ++stateSeq;
    if (tabId) msg.tabId = Number(tabId);
    if (v !== undefined) msg.v = v;
    return send(msg).then((r) => {
      out.err = r.ok ? '' : (r.err || '失败');
      if (r.state && seq > stateDone) { st = r.state; lastStateAt = Date.now(); stateDone = seq; }
      render();
      return r;
    });
  }

  function tick(msg) {
    if (!msg) return lineNode({ k: 'line', text: '(空)' });
    if (msg.k === 'fold') return foldNode(msg);
    if (msg.k === 'row') return rowNode(msg);
    if (msg.k === 'chart') return chartNode(msg);
    if (msg.k === 'imps') return impsNode(msg);
    if (msg.k === 'rank') return rankNode(msg);
    if (msg.k === 'grid') return gridNode(msg);
    if (msg.k === 'hero') return heroNode(msg);
    if (msg.k === 'bar') return barNode(msg);
    return lineNode(msg);
  }
  // 今日关注进度条：view.goalBar 给 pct、两端含义与文字；这里只画填充条 + 基线/目标两个端标。
  // 悬停话术（口径的实话）挂在整个条上，别让用户去猜 2960 → 3359 的分子从哪本账来。
  function barNode(m) {
    const d = document.createElement('div'); d.className = 'pbar'; if (m.sty) d.classList.add(m.sty);
    if (m.title) d.title = m.title;
    const head = document.createElement('div'); head.className = 'pbarHead';
    head.textContent = m.label + '  ' + m.text;
    const track = document.createElement('div'); track.className = 'pbarTrack';
    const fill = document.createElement('div'); fill.className = 'pbarFill' + (m.sty === 'ok' ? ' ok' : '');
    fill.style.width = Math.max(0, Math.min(100, Number(m.pct) || 0)) + '%';
    track.append(fill);
    d.append(head, track);
    if (m.endLeftTxt || m.endRightTxt) {
      const ends = document.createElement('div'); ends.className = 'pbarEnds';
      const l = document.createElement('span'); l.textContent = m.endLeftTxt || '';
      const r = document.createElement('span'); r.textContent = m.endRightTxt || '';
      ends.append(l, r);
      d.append(ends);
    }
    return d;
  }
  // 首页的今日四列大字卡：view.homeLines 给的 items 有数就大字，没有就灰 '—'（悬停说怎么补）
  function heroNode(m) {
    const d = document.createElement('div'); d.className = 'hero';
    const head = document.createElement('div'); head.className = 'heroHead';
    head.textContent = (m.own ? '@' + m.own + '  ·  ' : '') + (m.day || '');
    d.append(head);
    const grid = document.createElement('div'); grid.className = 'heroGrid';
    (m.items || []).forEach((it) => {
      const cell = document.createElement('div'); cell.className = 'heroCell' + (it.max ? ' isMax' : '');
      if (it.hint) cell.title = it.hint;
      const lab = document.createElement('div'); lab.className = 'heroLab';
      lab.textContent = it.label + (it.max ? ' ·最高' : '');
      const val = document.createElement('div'); val.className = 'heroVal' + (it.v == null ? ' dim' : '');
      val.textContent = it.v == null ? '—' : it.v;
      cell.append(lab, val); grid.append(cell);
    });
    d.append(grid);
    if (m.note) {
      const n = document.createElement('div'); n.className = 'heroNote'; n.textContent = m.note;
      d.append(n);
    }
    return d;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }
  // 几何全在 view.js 的 chartSpec 里算好（Node 可断言），这里只把点串变成节点
  function chartNode(s) {
    const wrap = document.createElement('div'); wrap.className = 'chartBox';
    const t = document.createElement('div'); t.className = 'chartTitle';
    t.textContent = s.title + (s.unit ? '（' + s.unit + '）' : '');
    wrap.append(t);
    if (s.empty) {
      const p = document.createElement('div'); p.className = 'chartEmpty'; p.textContent = s.empty;
      wrap.append(p); return wrap;
    }
    const box = s.box, root = svgEl('svg', { viewBox: '0 0 ' + s.w + ' ' + s.h, class: 'chart', role: 'img', 'aria-label': s.title });
    // view.chartSpec 给的 box.{r,b} 是右/下边界的坐标（不是留白宽度），所以宽高都取差：
    // 旧写法 s.w - box.r - box.l = 360 - 354 - 40 = -34，Chrome 直接抛
    // 「<rect> attribute width: A negative value is not valid」并把整次 render 打断。
    // 再夹一道 ≥0：几何无论怎么变都不该让整页因为一颗矩形画不出来而空白。
    const pw = Math.max(0, box.r - box.l), ph = Math.max(0, box.b - box.t);
    root.append(svgEl('rect', { x: box.l, y: box.t, width: pw, height: ph, class: 'plot' }));
    (s.yTicks || []).forEach((tk) => {
      root.append(svgEl('line', { x1: box.l, y1: tk.y, x2: s.w - s.box.r, y2: tk.y, class: 'grid' }));
      const tx = svgEl('text', { x: 2, y: tk.y + 3, class: 'ylab' }); tx.textContent = tk.label; root.append(tx);
    });
    (s.series || []).forEach((se) => {
      if (!se.pts) return;
      const pl = svgEl('polyline', { points: se.pts, class: 'ln ' + se.cls, fill: 'none' });
      const ti = document.createElementNS(SVG_NS, 'title');
      ti.textContent = se.label + '：' + (se.first == null ? '-' : se.first) + ' → ' + (se.last == null ? '-' : se.last) + '（' + se.n + ' 点）';
      pl.append(ti); root.append(pl);
    });
    (s.xTicks || []).forEach((tk, i, arr) => {
      const tx = svgEl('text', { x: tk.x, y: s.h - 5, class: 'xlab', 'text-anchor': i === 0 ? 'start' : (i === arr.length - 1 ? 'end' : 'middle') });
      tx.textContent = tk.label; root.append(tx);
    });
    wrap.append(root);
    const leg = document.createElement('div'); leg.className = 'legend';
    (s.series || []).forEach((se) => {
      const sp = document.createElement('span'); sp.className = 'lg ' + se.cls;
      sp.textContent = se.label + ' ' + (se.last == null ? '-' : se.last) + '（' + se.n + ' 点，' + (se.min == null ? '-' : se.min) + '~' + (se.max == null ? '-' : se.max) + '）';
      leg.append(sp);
    });
    wrap.append(leg);
    return wrap;
  }
  // 日线四列表：只读紧凑表恒显示；点「编辑」在浏览器正中间弹一个**独立小窗口**（chrome.windows.create）。
  // 为什么不留在侧栏里弹：侧栏总共 ~360px 宽，模态框塞进去字都看不清（用户真机截图的原话「太小了，很难使用，
  // 都看不清什么字」）——扩展自己的 popup 窗口不受这个约束，14px 正常字号、想多大开多大。
  // 编辑窗只管 时间/总曝光/有效曝光 三列（用户的话：「只需要时间，总曝光，有效曝光就可以了」），
  // 关注/粉丝/帖子不在窗口里编辑——它们是自动采的列，关注/粉丝本来就同在分钟线一张图里。
  // 「存/删」在 editor.js 里走 impAdd/impDel（同日按列合并，空框 = 不动那一列）→ SW 转给 x.com 标签页 → 本机库。
  function impsNode(m) {
    const d = document.createElement('div'); d.className = 'imps';
    const mk = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
    const cell = (txt, tip, c) => { const s = mk('span', c); s.textContent = txt == null ? '' : String(txt); if (tip) s.title = tip; return s; };
    const head = (labels, cls) => { const r = mk('div', 'impRow ' + cls); labels.forEach((t, i) => r.append(cell(t, '', i === 0 ? 'giDay' : ''))); return r; };
    const cols = m.head || ['日期', '有效曝光', '曝光', '转化率', '关注', '粉丝', '帖子'];
    const cap = mk('div', 'cap');
    cap.append(cell(m.title || ''));
    const tg = mk('button', 'impToggle'); tg.type = 'button';
    tg.textContent = '编辑';
    tg.title = '在浏览器正中间弹独立编辑窗（大字）：补历史 / 改总曝光·有效曝光 / 删行；改完自动保存进本机库，不用点任何按钮';
    tg.addEventListener('click', () => openEditorWindow(m.who || ''));
    cap.append(tg);
    d.append(cap);
    // v0.8.1-i 用户裁定拆两张表：曝光三列（有效曝光/曝光/转化率）一张，关注/粉丝/帖子单独一张——
    // 列头仍从 view 的 DAY_HEAD 切（一处给死，这里不许另写一份列名）
    const dayC = (p) => cell((p.dayDisp || p.day) + (p.hand ? ' [补]' : ''), p.day + (p.hand ? '\n这一行有手工补录的列（曝光来源标 manual，或帖子数是补的）' : '\n全自动采到的行'), 'giDay');
    const rows = (m.rows || []).slice().reverse();
    const emptyRow = () => { const r = mk('div', 'impRow impView'); r.append(cell('(一行都没有 —— 点右上「编辑」补历史)')); return r; };
    const g1 = mk('div', 'impGrid');
    g1.append(head(cols.slice(0, 4), 'impHead impView'));
    if (!rows.length) g1.append(emptyRow());
    rows.forEach((p) => {
      const r = mk('div', 'impRow impView');
      r.append(dayC(p),
        cell(p.effTxt, '当日有效曝光 = 本行累计读数 − 前一日读数（奖励页给的是 90 天滚动累计，相减才是当日）' +
          (p.effToken ? '\n原文/来源：' + p.effToken : '') + (p.effExact ? '\n精确值' : '\n缩写值（末尾带 ~）') +
          (p.effAt ? '\n落账：' + p.effAt : '') + '\n奖励页 T+1：今天的数据明天 10 点后开页才有'),
        cell(p.impTxt, (p.token ? '原文/来源：' + p.token + '　' : '') + (p.exact ? '精确值' : '缩写值（末尾带 ~）') + '\n账号分析页的每日曝光，实时增量'),
        cell(p.rateTxt, p.rate == null ? '转化率 = 当日有效曝光 ÷ 当日曝光；累计读数缺前一天（或曝光为 0）就算不出' : '转化率 = 当日有效曝光 ÷ 当日曝光'));
      g1.append(r);
    });
    d.append(g1);
    const cap2 = mk('div', 'cap');
    cap2.append(cell('关注 / 粉丝 / 帖子（打开主页自动采；帖子数 X 不给，只能补录）'));
    const tg2 = mk('button', 'impToggle'); tg2.type = 'button';
    tg2.textContent = '编辑';
    tg2.title = '在浏览器正中间弹独立编辑窗（大字）：补历史 / 改 关注·粉丝·帖子；改完自动保存进本机库（没有「删」——删整行去上面那张表的编辑窗）';
    tg2.addEventListener('click', () => openEditorWindow(m.who || '', 'fow'));
    cap2.append(tg2);
    d.append(cap2);
    const g2 = mk('div', 'impGrid');
    g2.append(head(['日期'].concat(cols.slice(4)), 'impHead impView'));
    if (!rows.length) g2.append(emptyRow());
    rows.forEach((p) => {
      const r = mk('div', 'impRow impView');
      r.append(dayC(p),
        cell(p.fowTxt, p.fowHow === 'max' ? '今天分钟线采到的当日最高' : (p.fowHow === 'day' ? '日点表里的值（打开主页自动采，或趋势页手补）' : (p.fow == null ? '没有关注这一天的数' : '这一天最后一次分钟读数'))),
        cell(p.fansTxt, p.fans == null ? '这一天没有粉丝数' : '这一天最后一次读到的粉丝数'),
        cell(p.postsTxt, p.posts == null ? '帖子数 X 的 DOM 里没有，只能补录' : '手工补录的帖子数'));
      g2.append(r);
    });
    d.append(g2);
    return d;
  }
  // 独立编辑窗：640×560 居中（getLastFocused 算坐标，算不出就让 Chrome 自己摆）。补录要经
  // x.com 页面上的采集端写账（impAdd 由 core 执行），编辑窗自己没有 tabId ⇒ 谁来补 tabId
  // 由 editor.js 查 x.com 标签页解决，跟面板 tabPick 同一套依赖。
  // kind 缺省 = 曝光两列（总曝光/有效曝光）；'fow' = 关注/粉丝/帖子（同一窗口同一套 impAdd，只换列）。
  function openEditorWindow(who, kind) {
    const W = 640, H = 560;
    const url = chrome.runtime.getURL('ui/editor.html') + '?who=' + encodeURIComponent(who) +
      (kind ? '&kind=' + encodeURIComponent(kind) : '');
    try {
      chrome.windows.getLastFocused({}, (w) => {
        const opt = { url, type: 'popup', width: W, height: H };
        if (w && w.width > W) { opt.left = Math.round(w.left + (w.width - W) / 2); opt.top = Math.round(Math.max(0, w.top + (w.height - H) / 2)); }
        chrome.windows.create(opt);
      });
    } catch (e) { chrome.windows.create({ url, type: 'popup', width: W, height: H }); }
  }
  // v0.6.11 跨人排名表：列头是按钮（点一次按该列降序，再点切升序），排序状态存模块级变量，
  // 原因跟 impEdit 一样 —— render() 每次重建整棵树，存在 DOM 上会被自己刷掉。
  let rankSortBy = 'fans', rankAsc = false;
  function rankNode(m) {
    const d = document.createElement('div'); d.className = 'imps rank';
    const mk = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
    const cell = (txt, tip, c) => { const s = mk('span', c); s.textContent = txt == null ? '' : String(txt); if (tip) s.title = tip; return s; };
    const cap = mk('div', 'cap'); cap.append(cell(m.title || '')); d.append(cap);
    const g = mk('div', 'impGrid');
    const hr = mk('div', 'impRow impHead rankHead');
    (m.head || []).forEach((t, i) => {
      const k = (m.cols || [])[i - 3];          // 名次 / handle / 最新一行 三列不可排，第四列起才是数值列
      if (!k) { hr.append(cell(t, '', i === 0 ? 'giDay' : '')); return; }
      const b = mk('button', 'rkHead' + (m.sortBy === k ? ' on' : '')); b.type = 'button'; b.textContent = t;
      b.title = '按' + ((m.labels || {})[k] || t) + '排（再点一次换方向）';
      b.addEventListener('click', () => {
        if (rankSortBy === k) rankAsc = !rankAsc; else { rankSortBy = k; rankAsc = false; }
        rankLimit = 10;
        render();
      });
      hr.append(b);
    });
    g.append(hr);
    const rows = m.rows || [];
    if (!rows.length) { const r = mk('div', 'impRow impView'); r.append(cell('(一个人都还没有 —— 先打开几个主页，或点上面「从本机库回填」)')); g.append(r); }
    const fmt = (v, r, k) => {
      if (v == null) return '—';
      const dv = k === 'fow' ? r.dFow : (k === 'fans' ? r.dFans : (k === 'imp' ? r.dImp : r.dPosts));
      const sign = dv == null ? '' : (dv >= 0 ? ' +' : ' ') + dv;
      return V.nf(v) + sign;
    };
    rows.forEach((r) => {
      const tr = mk('div', 'impRow impView' + (r.own ? ' rankOwn' : '') + (r.stale ? ' stale' : ''));
      tr.append(cell(r.rank + (r.own ? ' *' : ''), r.own ? '这就是你自己在库里的 handle' : '@' + r.h + ' 的最新一行', 'giDay'),
        cell(r.h, '@' + r.h + (r.day ? '　最新一行 ' + r.day : '　还没有日点'), 'rkH'),
        cell(r.day || '-', r.at ? '这条序列最后写入时间戳 ' + new Date(r.at).toLocaleString() : '没有写入时间'),
        cell(fmt(r.imp, r, 'imp'), '曝光：只有自己的号能从奖励页读到，别人的主页 DOM 里根本没有这个数（空=读不到，不是 0）'),
        cell(fmt(r.fow, r, 'fow'), '关注' + (r.dFow == null ? '（只有一行，算不出净增）' : '：较上一行 ' + (r.dFow >= 0 ? '+' : '') + r.dFow)),
        cell(fmt(r.fans, r, 'fans'), '粉丝' + (r.dFans == null ? '（只有一行，算不出净增）' : '：较上一行 ' + (r.dFans >= 0 ? '+' : '') + r.dFans)),
        cell(r.posts == null ? '—' : V.nf(r.posts), r.posts == null ? '帖子数 X 的 DOM 里没有，只能手补' : '手工补录的帖子数'),
        cell((r.dFow == null && r.dFans == null ? '—' : (r.dFow == null ? '?' : (r.dFow >= 0 ? '+' : '') + r.dFow) + '/' + (r.dFans == null ? '?' : (r.dFans >= 0 ? '+' : '') + r.dFans)),
          '关注/粉丝 各较上一行的净增' + (r.prevDay ? '（上一行 ' + r.prevDay + '）' : '（他只有一行，算不出净增）')),
        cell(r.ageTxt, '这行数据多久没更新了（超过两天标灰：排名只比"还活着的人"）'));
      g.append(tr);
    });
    d.append(g);
    if (m.more > 0) d.append(moreBtnNode(m.more, () => { rankLimit += 10; render(); }));
    return d;
  }
  // 「更多」按钮（v0.8.1-t 榜分页共用）：k:'rank' 与两张 k:'grid' 的榜都走「先出 10 条、点了 +10」。
  function moreBtnNode(left, onMore) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'rkHead moreBtn';
    b.textContent = '更多（还有 ' + left + ' 条，每次 +10）';
    b.title = '分页是给面板看的：几百行塞进 400px 侧栏既看不清也拖慢 900ms 刷新；换排序回到第一页；完整排名随时可以在库里查';
    b.addEventListener('click', onMore);
    return b;
  }
  // v0.7.0 本机库两张榜（k:'grid'）：列头里带 sort key 的是可点的排序键（只降序 —— 榜问的是「谁最高」），
  // 排序状态存模块级变量，跟 impEdit/rankSortBy 同一个原因：render() 每次都重建整棵树。
  let acctSort = 'views', postSort = 'view';
  // 榜分页（v0.8.1-t）：一次 10 条、「更多」每次 +10；换排序回到第一页（新序从头看）。同存模块级变量防 900ms 重画刷掉。
  let acctLimit = 10, postLimit = 10, rankLimit = 10;
  // 时间线曝光排序榜（v0.8.2）：选中的天（'' = 还没选，首批数据回来后落到最近有数的那天）、来源筛选、分页
  let tlDay = '', tlSrcf = '', tlLimit = 10, tlSort = 'view';
  // 点昵称的作者模态框（v0.8.2）：看谁（'' = 关着）、那条 author_posts 查询的回包与在途标志
  let tlUser = '', tlUserDb = null;
  function closeTlUser() { tlUser = ''; tlUserDb = null; render(); }
  function openTlUser(author) {
    if (!/^[A-Za-z0-9_]{1,20}$/.test(author || '')) return;
    tlUser = author; tlUserDb = null; render();
    send({ t: 'dbq', q: 'author_posts', limit: 200, author: author }).then((res) => {
      if (tlUser !== author) return;   // 回包路上用户已经换了人或关掉：旧回包不许盖新状态
      tlUserDb = res; render();
    }).catch(() => { if (tlUser === author) { tlUserDb = { ok: false, err: '查询发不出去' }; render(); } });
  }
  // 作者模态框：读 author_posts 回包画成一列帖子（每条也是链接）。覆盖层点空白处关，× 也关。
  function tlUserModalNode() {
    const mk = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
    const cell = (txt, c) => { const s = mk('span', c); s.textContent = txt == null ? '' : String(txt); return s; };
    const wrap = mk('div', 'tlModalWrap');
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeTlUser(); });
    const box = mk('div', 'tlModal');
    const head = mk('div', 'tlModalHead');
    const ttl = mk('span', 'tlModalTitle');
    ttl.textContent = '@' + tlUser + ' · 已抓到的帖子（按曝光排序）';
    const x = mk('button', 'tlModalX'); x.type = 'button'; x.textContent = '×'; x.title = '关闭';
    x.addEventListener('click', closeTlUser);
    head.append(ttl, x);
    box.append(head);
    const body = mk('div', 'tlModalBody');
    if (!tlUserDb) {
      body.append(cell('读取中…', '', 'pre'));
    } else if (!tlUserDb.ok) {
      body.append(cell('查询失败：' + (tlUserDb.err || '没回包'), '', 'bad'));
    } else {
      const rows = V.tlUserRows(tlUserDb);
      if (!rows.length) body.append(cell('@' + tlUser + ' 还没有抓到过帖子：他的帖子要在时间线/主页被抓到才有', '', 'pre'));
      rows.forEach((r) => {
        const a = mk('a', 'tlCard');
        a.href = r.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.title = '曝光 ' + r.view + ' · 评论 ' + r.reply + ' · 看到 ' + r.hm + '\n点击跳原帖\n正文：' + r.text;
        const top = mk('div', 'tlTop');
        top.append(cell(r.view, '', 'tlView'), cell('评 ' + r.reply, '', 'tlReply'), cell(r.hm, '', 'tlAt'));
        const tx = mk('div', 'tlTxt'); tx.textContent = r.text || '';
        a.append(top, tx);
        body.append(a);
      });
    }
    box.append(body);
    wrap.append(box);
    return wrap;
  }
  function gridNode(m) {
    const d = document.createElement('div'); d.className = 'imps dbgrid ' + (m.cls || '');
    const mk = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
    const cell = (txt, tip, c) => { const s = mk('span', c); s.textContent = txt == null ? '' : String(txt); if (tip) s.title = tip; return s; };
    const cap = mk('div', 'cap'); cap.append(cell(m.title || '')); d.append(cap);
    // 时间线榜的选天 + 来源筛选（v0.8.2）：状态在模块变量里（render() 每次重建整棵树，存 DOM 上会被自己刷掉）；
    // 换天要重发 tl_rank 查询（day 是 SQL 参数），所以只有它走 fetchDb(true)，来源筛选纯前端过滤。
    if (m.cls === 'tl') {
      const bar = mk('div', 'tlBar');
      const sel = mk('select', 'tlDay');
      sel.title = '选哪一天：时间线曝光排序按天一张榜（最近有数的天已经替你选好）';
      (m.days || []).forEach((dy) => {
        const op = document.createElement('option');
        op.value = dy; op.textContent = dy;
        if (dy === m.day) op.selected = true;
        sel.append(op);
      });
      sel.addEventListener('change', () => { tlDay = sel.value; tlLimit = 10; fetchDb(true); });
      bar.append(sel);
      [['', '全部'], ['foryou', '为你推荐'], ['following', '正在关注']].forEach(([k, lab]) => {
        const b = mk('button', 'rkHead' + (m.srcf === k ? ' on' : '')); b.type = 'button'; b.textContent = lab;
        b.addEventListener('click', () => { tlSrcf = k; tlLimit = 10; render(); });
        bar.append(b);
      });
      // 排序键：曝光 / 评论（同一抓取点的两列，客户端重排）
      [['view', '曝光'], ['reply', '评论']].forEach(([k, lab]) => {
        const b = mk('button', 'rkHead' + ((m.sort || 'view') === k ? ' on' : '')); b.type = 'button'; b.textContent = lab;
        b.title = '按' + lab + '排（降序）';
        b.addEventListener('click', () => { tlSort = k; tlLimit = 10; render(); });
        bar.append(b);
      });
      d.append(bar);
    }
    // 时间线榜走卡片（用户裁定 2026-10-26）：正文当主视觉、作者/来源收进悬浮、点卡片跳原帖（新开标签）。
    // 纯 <a href> + CSS :hover，不派发任何事件；360px 宽度塞六列本来就挤，卡片还能多放一行正文。
    if (m.cards) {
      const wrap = mk('div', 'tlCards');
      if (!m.cards.length) {
        const r = mk('div', 'impRow impView'); r.append(cell(m.empty || '(空)')); wrap.append(r);
      }
      m.cards.forEach((c) => {
        const a = mk('a', 'tlCard');
        a.href = c.href || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
        if (c.tip) a.title = c.tip;
        const top = mk('div', 'tlTop');
        top.append(cell(c.rank, '', 'giDay'), cell(c.hm, '', 'tlAt'), cell('评 ' + c.reply, '', 'tlReply'), cell(c.view, '', 'tlView'));
        const tx = mk('div', 'tlTxt'); tx.textContent = c.text || '';
        const mt = mk('div', 'tlMeta');
        const un = mk('span', 'tlUser'); un.textContent = '@' + c.author;
        un.title = '看 @' + c.author + ' 所有已抓到的帖子（按曝光排序）';
        // 卡片本体是跳原帖的 <a>：昵称这一小块截住点击，开作者模态框
        un.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openTlUser(c.author); });
        mt.append(un, cell(' · ' + c.src));
        a.append(top, tx, mt);
        wrap.append(a);
      });
      d.append(wrap);
      if (m.more > 0) d.append(moreBtnNode(m.more, () => { tlLimit += 10; render(); }));
      if (m.note) { const n = mk('div', 'dbNote'); n.textContent = m.note; d.append(n); }
      return d;
    }
    const g = mk('div', 'impGrid');
    const hr = mk('div', 'impRow impHead');
    (m.head || []).forEach((t, i) => {
      const k = (m.cols || [])[i];
      if (!k) { hr.append(cell(t, '', i === 0 ? 'giDay' : '')); return; }
      const b = mk('button', 'rkHead' + (m.sortBy === k ? ' on' : '')); b.type = 'button'; b.textContent = t;
      b.title = '按' + ((m.labels || {})[k] || t) + '排（降序）';
      b.addEventListener('click', () => {
        if (m.cls === 'post') { postSort = k; postLimit = 10; } else { acctSort = k; acctLimit = 10; }
        render();
      });
      hr.append(b);
    });
    g.append(hr);
    const rows = m.rows || [];
    if (!rows.length) {
      const r = mk('div', 'impRow impView'); r.append(cell(m.empty || '(空)')); g.append(r);
    }
    rows.forEach((r) => {
      const tr = mk('div', 'impRow impView' + (r.cls ? ' ' + r.cls : ''));
      if (r.tip) tr.title = r.tip;
      (r.cells || []).forEach((c) => tr.append(cell(c.t, c.tip || '', c.c || '')));
      g.append(tr);
    });
    d.append(g);
    if (m.more > 0) d.append(moreBtnNode(m.more, () => {
      if (m.cls === 'post') postLimit += 10;
      else if (m.cls === 'tl') tlLimit += 10;
      else acctLimit += 10;
      render();
    }));
    if (m.note) { const n = mk('div', 'dbNote'); n.textContent = m.note; d.append(n); }
    return d;
  }
  function rowNode(m) {
    const d = document.createElement('div'); d.className = 'row';
    const a = document.createElement('span'); a.textContent = m.label;
    const b = document.createElement('span'); b.textContent = m.value; if (m.sty) b.className = m.sty;
    if (m.title) d.title = m.title;
    d.append(a, b); return d;
  }
  function lineNode(m) {
    const d = document.createElement('div');
    d.className = m.sty === 'pre' ? 'pre' : (m.sty || 'pre');
    d.textContent = m.text; return d;
  }
  function foldNode(m) {
    const d = document.createElement('details');
    const s = document.createElement('summary'); s.textContent = m.title;
    const p = document.createElement('pre'); p.textContent = m.text;
    d.append(s, p); return d;
  }

  // 顶部那条 60 秒冷却横幅：红=别关注（带倒计时），绿=可以关注。
  // 秒数靠本地 1s 节拍器重画，不等 900ms 的状态轮询 —— 面板自己算得起，别为这个数字多问页面一次。
  function paintCool() {
    const bar = $('coolBar');
    if (!bar) return;
    if (!st) { bar.className = 'cool hide'; bar.textContent = ''; return; }
    const m = V.coolLine(st, Date.now());
    bar.className = 'cool ' + (m.sty === 'bad' ? 'bad' : 'ok');
    bar.textContent = m.text;
    bar.title = m.title;
  }
  function coolTick() {
    // 面板自己的 DOM，每秒重画一次这一条横幅不花什么；真正的页面 DOM 一个节点都没多
    if (st && !document.hidden) paintCool();
    if (!document.hidden) tickCodeCd();   // 弹窗里那颗「再等 N 秒」跟着同一趟秒针走（不另开定时器）
  }

  function render() {
    const root = $('report');
    root.textContent = '';
    $('err').textContent = out.err;
    if (!st) doView(root);
    else if (view === 'debug' && !(st.debug && st.debug.on)) { view = 'home'; doView(root); }  // 开关被关掉就别停在诊断上
    else if (view === 'set') renderSet(root);
    else doView(root);
    if (view === 'plaza' && tlUser) root.append(tlUserModalNode());   // 作者模态框盖在广场上（状态在模块变量，900ms 重画跟着重建）
    syncButtons();
    syncWho();
    paintCool();
    // 设置区与 state 对表：用户正在打字时不覆盖（别把没按「应用」的数摸掉）
    // ⚠ st 可以是 null（活动标签页不是 x.com / core 还没 boot 完 / 那一跳超时）——
    // 这一段以前无条件读 st.rndMax，于是每次轮询都在 promise 里抛
    // 「Cannot read properties of null (reading 'rndMax')」，并把下面 footer 那行一起带走（面板看着像卡住）。
    if (!st) {
      $('foot').textContent = '面板 ' + new Date().toLocaleTimeString() +
        '   ui ' + PANEL_BUILD + '   活动标签页没有探针（开一个 x.com 页面，或等它 boot）';
      return;
    }
    if ($('rndMax') && !rndDirty && document.activeElement !== $('rndMax')) {
      $('rndMax').value = String(st.rndMax == null ? 20 : st.rndMax);
    }
    const ownEl = $('ownSet');
    if (ownEl && !ownDirty && document.activeElement !== ownEl) {
      ownEl.value = (st.series && st.series.ownSet) ? '@' + st.series.ownSet : '';
    }
    const sc = (st.series && st.series.counts) || {};
    $('foot').textContent = '面板 ' + new Date().toLocaleTimeString() +
      '   数据 ' + (lastStateAt ? new Date(lastStateAt).toLocaleTimeString() : '-') +
      '   v' + st.ver + ' build ' + st.build + ' ui ' + PANEL_BUILD + ' 宿主 ' + (st.host || '?') +
      (st.peer ? '  ⚠同页还有 ' + st.peer : '') +
      '   [' + viewName() + '] 序列 ' + (sc.min || 0) + 'min/' + (sc.imp || 0) + 'day';
  }
  // 视图分发（没 state 时也按当前视图给引导，别把页面读成白屏）
  // 逐个节点接住异常：一颗画坏（典型是 SVG 尺寸/几何）不许把后面的行一起拖没，
  // 也不许在控制台留下一条看不出是谁的错——就地变成一行说明是哪一块。
  function appendSafe(root, list) {
    (list || []).forEach((m) => {
      try { root.append(tick(m)); }
      catch (e) {
        root.append(lineNode({ k: 'line', text: '这一块没画出来（' + String((m && m.k) || '?') + '）：' + String((e && e.message) || e) }));
      }
    });
  }
  function doView(root) {
    if (!st) { root.append(lineNode({ k: 'line', text: '正在等 content script 报状态……（页面得是 x.com，且探针已注入）' })); paintCool(); return; }
    if (view === 'mine') { root.append(digestBox(V.mineDigestText(st))); appendSafe(root, V.mineLines(st)); }
    else if (view === 'plaza') appendSafe(root, V.plazaLines(st, { by: rankSortBy, asc: rankAsc, now: Date.now(), acct: acctSort, post: postSort, db: db, acctLimit: acctLimit, postLimit: postLimit, rankLimit: rankLimit, tlSrcf: tlSrcf, tlDay: tlDay, tlLimit: tlLimit, tlSort: tlSort }));
    else if (view === 'forecast') appendSafe(root, V.fansForecastLines(st));
    else if (view === 'debug') { if (qKeep) appendSafe(root, qKeep); appendSafe(root, V.debugLines(st)); }
    else appendSafe(root, V.homeLines(st));
  }
  // 「我的」页顶部的可复制日志摘要（v0.8.1-r）+ 六行日报「复制日报」钮（v0.8.1-s）：
  // 只读 textarea + 复制钮，文本来自 view.mineDigestText；日报文本来自 view.mineReportText，
  // 评论数没有采集来源 ⇒ 旁边手填一格（按天记 chrome.storage.local，第二天自动清空）。
  // 900ms 回读整页重画；摘要内容没变就复用同一个节点（append 会把它从旧根搬过来）——
  // 用户手动划选/聚焦摘要文本时，不至于每 0.9 秒被拆一次焦点和选区。
  let digestEl = null;
  // 评论数按天记 chrome.storage.local（扩展自己的存储；UI 层红线禁页面 origin 存储）。
  // 读是异步的：只在新建摘要框时回填一次，节点复用时用户正在打的值不动。
  function replDay() { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function loadReplInto(el) {
    try {
      chrome.storage.local.get('repl', (v) => {
        const r = v && v.repl;
        if (r && r.day === replDay() && el.isConnected && el.value === '') el.value = String(r.n);
      });
    } catch (e) { /* 读不到就当次手填 */ }
  }
  function saveRepl(n) { try { chrome.storage.local.set({ repl: { day: replDay(), n: n } }); } catch (e) { /* 存不了就只当次有效 */ } }
  async function copyText(txt, okMsg, failMsg, btn, resetMsg, fallbackSel) {
    let done = false;
    try { await navigator.clipboard.writeText(txt); done = true; }
    catch (e) {
      // clipboard API 不可用（页面没聚焦等）就退回选区 + execCommand（必须趁选区还在同步执行）；再不行老实报失败
      try { if (fallbackSel) done = !!fallbackSel(); } catch (e2) { /* 老实说 */ }
    }
    btn.textContent = done ? okMsg : failMsg;
    setTimeout(() => { btn.textContent = resetMsg; }, 1200);
    return done;
  }
  function digestBox(text) {
    if (digestEl && digestEl.dataset.txt === text) return digestEl;
    const wrap = document.createElement('div'); wrap.className = 'digestBox';
    const top = document.createElement('div'); top.className = 'digestTop';
    const ta = document.createElement('textarea');
    ta.className = 'digestTa'; ta.readOnly = true; ta.rows = 5;
    ta.value = text; ta.dataset.txt = text;
    ta.title = '点「复制」一键进剪贴板，或直接划选复制';
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '复制';
    btn.onclick = () => { copyText(ta.value, '已复制', '复制失败（请手动划选）', btn, '复制',
      () => { ta.focus(); ta.select(); return document.execCommand('copy'); }); };
    top.append(ta, btn);
    const rep = document.createElement('div'); rep.className = 'digestRep';
    const repl = document.createElement('input'); repl.type = 'number'; repl.min = '0'; repl.placeholder = '今日评论数';
    repl.title = '评论数探针采不到（reply 指标都是别人帖子的），日报第一行要用的评论数在这里手填；按天记住，第二天清空';
    repl.value = '';
    loadReplInto(repl);
    repl.addEventListener('change', () => { if (repl.value !== '') saveRepl(Number(repl.value)); });
    const repBtn = document.createElement('button'); repBtn.type = 'button'; repBtn.textContent = '复制日报';
    repBtn.title = '六行日报：新朋友=页面「正在关注」今天基线→现在的读数差（同首页进度条口径）；评论数=左边手填的数；' +
      '转化率=日点表最新一行；三个预测日期=预测页 A 外推（50万只到月，5千/一万到日）';
    repBtn.onclick = () => {
      const n = repl.value === '' ? null : Number(repl.value);
      if (n == null) {
        repBtn.textContent = '先填评论数';
        setTimeout(() => { repBtn.textContent = '复制日报'; }, 1200);
        return;
      }
      saveRepl(n);
      copyText(V.mineReportText(st, n), '日报已复制', '复制失败（请手动划选）', repBtn, '复制日报',
        () => { ta.value = V.mineReportText(st, n); ta.focus(); ta.select(); const okd = document.execCommand('copy'); ta.value = text; return okd; });
    };
    rep.append(repl, repBtn);
    wrap.append(top, rep);
    digestEl = wrap;
    return wrap;
  }
  // ---------- 本机文件与清理（v0.8.8）----------
  // 面板只发受控动作（测占用 / 删过期 / 整理库 / 改策略），删哪个文件由本机 xprobe_fs.py 的白名单定 ——
  // 路径、glob、"全部删光" 这三样在浏览器这边就不存在（SW 那边也只透传 op/target/keep/dry）。
  // 三枚钮里两枚是删文件的，都走「先 DRY 回显，60 秒内再点一次才实删」：手滑与真意图之间隔一下点击。
  let fs = null, fsBusy = false, fsDirty = false;
  const ARM_MS = 60000;
  const armed = { logs: 0, dump: 0, vacuum: 0 };
  // 「清空」以前是设置页里唯一一颗按一下就生效的破坏性钮（清日志要两下，它不要）——
  // 纪律 D-7 不分大小：同一颗闸（ARM_MS）现在也管它。docs/UIX.md UIX-09。
  let clearArm = 0;
  function fsNote(text, sty) {
    const el = $('fsNote');
    if (!el) return;
    el.textContent = text;
    el.className = 'secDesc' + (sty === 'bad' ? ' bad' : sty === 'ok' ? ' ok' : sty === 'warn' ? ' warn' : '');
  }
  // 设置页那一句「你刚才那一下的结果」（v0.9.8）：写进 #setNote —— 它是 setBox 里的静态节点。
  // 不写 #report：那里每 900ms 被 render() 整块清空，原先 prepend 进去的「验证码已发到 xxx」
  // 其实活不到一秒，用户只能靠猜（这就是「点了没反应」那类投诉的真身）。
  function noteSet(text, sty) {
    const el = $('setNote');
    if (!el) return;
    el.textContent = text;
    el.className = 'secDesc' + (sty === 'bad' ? ' bad' : sty === 'ok' ? ' ok' : sty === 'warn' ? ' warn' : '');
  }
  function fsRefresh(auto) {
    if (fsBusy) return Promise.resolve(fs);
    fsBusy = true;
    return send({ t: 'fsq', auto: auto !== false }).then((r) => {
      fsBusy = false;
      fs = (r && typeof r === 'object') ? r : { ok: false, err: '没回包' };
      if (view === 'set') render();
      return fs;
    });
  }
  // 两下才动手的那一枚：dry=true 那一趟同时把「将删什么」写回钮上的 title，看得见才叫确认
  function fsTwoStep(key, run, label) {
    const on = armed[key] && (Date.now() - armed[key] < ARM_MS);
    if (on) {
      armed[key] = 0;
      syncFsControls();
      return run(false).then((r) => {
        if (r.ok === false) { fsNote(label + '没成：' + (r.err || '本机没回话'), 'bad'); return r; }
        fsNote(r.removed != null ? (label + '完了：删 ' + r.removed + ' 个，省 ' + V.mb(r.freed || 0)
          + (r.failedCount ? '；另有 ' + r.failedCount + ' 个删不掉（被占用/权限）' : ''))
          : (label + '完了：' + (r.freed ? '省 ' + V.mb(r.freed) : '本来就没空闲页可压')), 'ok');
        return fsRefresh(false);
      });
    }
    return run(true).then((r) => {
      if (r.ok === false) { fsNote(label + '量不了：' + (r.err || '本机没回话（sink-18 起了吗 / 宿主装了吗）'), 'bad'); return r; }
      armed[key] = Date.now();
      syncFsControls();
      fsNote(r.files ? ('将删 ' + r.files + ' 个 / ' + V.mb(r.willFree || 0) + '：'
        + ((r.names || []).slice(0, 3).join('、') || '') + (r.more ? '…（另 ' + r.more + ' 个）' : '')
        + ' —— 60 秒内再点一次这枚钮才真删') : ((r.note || '没有过期文件') + '（' + label + '没删任何东西）'), 'warn');
      return r;
    });
  }
  function fsClean(target) {
    return fsTwoStep(target, (dry) => send({ t: 'fsc', data: JSON.stringify({ op: 'clean', target: target, dry: dry }) }),
      target === 'logs' ? '清日志' : '清转储');
  }
  function fsVacuum() {
    return fsTwoStep('vacuum', (dry) => send({ t: 'fsc', data: JSON.stringify({ op: 'vacuum', dry: dry }) }), '整理库');
  }
  function fsSetKeep() {
    const raw = Number($('fsKeep').value);
    fsDirty = false;
    if (!Number.isInteger(raw) || raw < 1 || raw > 365) {
      fsNote('保留天数要 1~365 的整数（你填的是「' + $('fsKeep').value + '」）—— 没发出去，一个文件都没动', 'bad');
      return Promise.resolve();
    }
    return send({ t: 'fsc', data: JSON.stringify({ op: 'conf', keep: raw }) }).then((r) => {
      fsNote(r.ok === false ? ('策略没存下：' + (r.err || '没回包')) : ('保留天数改成 ' + r.keep + ' 天（自动清理' + (r.auto ? '开着' : '关着') + '）'), r.ok === false ? 'bad' : 'ok');
      return fsRefresh(false);
    });
  }
  function fsAuto() {
    const want = !(fs && fs.auto);
    return send({ t: 'fsc', data: JSON.stringify({ op: 'conf', auto: want }) }).then((r) => {
      fsNote(r.ok === false ? ('开关没存下：' + (r.err || '没回包'))
        : ('自动清理' + (want ? '开：本机那侧每天最多跑一次，只碰超过 ' + r.keep + ' 天的日志与转储'
          : '关：不再自动删，钮还在，自己点') ), r.ok === false ? 'bad' : 'ok');
      return fsRefresh(false);
    });
  }
  // 这块的字面全从本机回包来，面板不存第二条真相（和 bDump 一个规矩）。
  // 数字只在主区那行「本机文件与清理」出现一次；侧栏这格只说「测没测到、数据目录在哪」，
  // 同一个屏幕把两份一样的 MB 摆两处是给自己找对不上的活儿。
  function syncFsControls() {
    const bAuto = $('bFsAuto');
    if (bAuto) bAuto.textContent = '自动清理: ' + (fs && fs.auto ? '开' : '关');
    const keepEl = $('fsKeep');
    if (keepEl) {
      keepEl.placeholder = String((fs && fs.keep) || 7);
      // 这格是「改策略」的输入框，不是读数框：没在打字时就清空，免得停在上一趟填的数字上被误当当前值
      if (!fsDirty && document.activeElement !== keepEl) keepEl.value = '';
    }
    const d = $('fsDesc');
    if (d) {
      if (!fs && fsBusy) d.textContent = '测中：本机在数 logs / dump / 库 / 宿主日志各多大…';
      else if (!fs) d.textContent = '还没测：点右边「重测」。占用与可清量都写在主区那行里，浏览器这边不碰文件系统';
      else if (fs.ok === false) d.textContent = '测不到：' + (fs.err || '本机没回包') + '（sink-18 起了吗？宿主装了吗）';
      else d.textContent = '数据目录 ' + (fs.dir || '?') + '（本机 xprobe_fs ' + (fs.fs || '?') + ' 报的，'
        + (fs.lastAuto ? '上次自动清理 ' + fs.lastAuto : '自动清理还没跑过') + '）';
      d.title = '保留天数：文件名里的日期超过它才算垃圾（mtime 会被备份工具摸新，不作数）。改完点「应用」，'
        + '存的是本机 clean.json，所有标签页与 sink 共用同一份——不是浏览器缓存。';
    }
    // 等第二下的那枚钮要把自己改名叫「再点一次才真删」：确认状态写在钮上，别只写在下面那行结果里
    const now = Date.now();
    const armLabel = (id, key, idle) => {
      const el = $(id);
      if (el) el.textContent = (armed[key] && now - armed[key] < ARM_MS) ? '再点一次=真删' : idle;
    };
    armLabel('bCleanLogs', 'logs', '清日志');
    armLabel('bCleanDump', 'dump', '清转储');
    armLabel('bVacuum', 'vacuum', '整理库');
    const rf = $('bFsRefresh');
    if (rf) rf.textContent = fsBusy ? '测中…' : '重测';
  }
  // ---------- 本机模型（v0.11.4）：面板这边只有「闸 / 配置 / 最近一趟」三眼，真相全在 SW ----------
  // 三条纪律：① 一句字面都不自己算，全从 modelState 回包来（面板不是第二条真相）；
  // ② API Key 的明文压根到不了这里（SW 的 modelView 不带 token 键），所以不存在「面板把它画进 DOM」这回事；
  // ③ 闸、保存、测活都当场生效并写进「最近动作」，不用重开面板（同 v0.10.2 切档即时生效的规矩）。
  let modelSt = null, modelBusy = 0;
  function modelConf() { return (modelSt && modelSt.conf) ? modelSt.conf : null; }
  function modelRefresh() {
    return send({ t: 'modelState' }).then((r) => {
      modelSt = (r && typeof r === 'object') ? r : null;
      syncModelUI();
      return modelSt;
    });
  }
  function modelHintText(c) {
    if (!modelSt) return '还没读到（正在问后台…）';
    if (modelSt.badConf) return '设置里那一格存坏了：' + modelSt.badConf + '（点「改配置」保存一次就好）';
    if (!c) return '关着：一个请求都不发（连本机的模型服务也不问）';
    const noHost = !modelSt.host || !modelSt.host.installed;
    if (!c.on) return '关着：一个请求都不发（连 ' + c.base + ' 也不问一句），页面右缘那颗「回帖」也不出现';
    return '开着：只打 ' + c.base + '（' + (c.endpointLabel || c.endpoint) + '）· 帖子详情页右缘多出第七颗「回帖」'
      + (modelSt.hostVer ? ' · 宿主 ' + modelSt.hostVer : ' · 还没认到宿主版本')
      + (noHost ? ' · 但这台机器还没装原生宿主 ⇒ 这条路走不通，见下面「本机库直连」' : '');
  }
  function modelConfText(c) {
    if (!c) return '还没读到';
    const list = modelSt && Array.isArray(modelSt.endpoints) ? modelSt.endpoints : [];
    const named = list.filter((e) => e.endpoint === c.endpoint)[0];
    return '端点：' + ((named && named.label) || c.endpoint) + ' · 地址：' + c.base
      + ' · 模型：' + (c.model ? c.model : '（留空＝用服务的默认）')
      + ' · 超时：' + (Math.round(c.ms / 100) / 10) + ' 秒'
      + ' · Key：' + (c.hasToken ? '已设（不回显）' : '没设');
  }
  function modelStatText() {
    if (!modelSt) return '还没读到（正在问后台…）';
    const s = modelSt.stat;
    // 这一世这后台问了几次、断了几次（SW 的 modelPerfState，不落盘、重开浏览器归零）：
    // 「上一次」那格是跨重启的账，这一句是当下这趟的账，两笔分开说才对得上「我刚刚点的那几下」
    const p = modelSt.perf;
    const tally = p ? ' · 这一世问过 ' + (Number(p.modelAsk) || 0) + ' 次、断了 ' + (Number(p.modelFail) || 0) + ' 次' : '';
    if (!s) return '还没跑过：点右边「测活」问一句这台服务装了什么模型（闸开着才真去问）';
    const when = new Date(s.at).toLocaleTimeString();
    const dur = (Math.round(s.ms / 100) / 10) + ' 秒';
    if (!s.ok) return '上一次没成（' + when + '，' + dur + '）：' + (s.err || '没留下原因') + tally;
    return '上一次成功（' + when + '，' + dur + '）· 走的是 ' + (s.hostVer || modelSt.hostVer || '宿主')
      + '，只有这条腿，从不走 fetch' + tally;
  }
  function syncModelUI() {
    const c = modelConf();
    const set = (id, txt, sty) => {
      const el = $(id);
      if (!el) return;
      el.textContent = txt;
      // .secHint 没有变色档（CSS 里只有 .secDesc.ok/.warn/.bad），要变色的只往 secDesc 那两格写
      if (sty !== undefined && el.className.indexOf('secDesc') >= 0) {
        const want = 'secDesc' + (sty === 'bad' ? ' bad' : sty === 'ok' ? ' ok' : sty === 'warn' ? ' warn' : '');
        if (el.className !== want) el.className = want;
      }
    };
    set('bModelOn', '本机模型: ' + (c && c.on ? '开' : '关'));
    set('modelHint', modelHintText(c));
    set('modelConf', modelConfText(c), modelSt && modelSt.badConf ? 'bad' : undefined);
    const s = modelSt && modelSt.stat;
    set('modelStat', modelStatText(), !s ? undefined : (s.ok ? 'ok' : 'bad'));
  }
  function doModelGate() {
    const c = modelConf();
    const want = !(c && c.on);
    // 只带 on 这一个键：SW 是 Object.assign(存的值, 收到的值)，没写的键一律保留原值
    return send({ t: 'modelSet', on: want }).then((r) => {
      if (!r || !r.ok) { noteSet('闸没改成：' + ((r && r.err) || '没回话'), 'bad'); return modelRefresh(); }
      modelSt = null;
      noteSet(want ? ('已打开本机模型：从这一刻起才可能发请求，而且只打 ' + r.conf.base
        + '（回环）。这台机器要是没装原生宿主，点「测活」会直接说缺哪一层')
        : '已关闸：以后一个请求都不发（配置留着，随时再开）', want ? 'ok' : 'warn');
      return modelRefresh();
    });
  }
  function doModelTest() {
    if (modelBusy) return Promise.resolve();
    modelBusy = 1;
    noteSet('测活中：只问本机那个端口，要几秒…', 'warn');
    return send({ t: 'modelTest' }).then((r) => {
      modelBusy = 0;
      if (!r || !r.ok) {
        const why = r && r.noHost ? '没装原生宿主 —— 这条腿只走宿主，不占 host_permissions'
          : r && r.oldHost ? '宿主还不认模型通道 —— 它是打包进去的那一份，重跑一次安装命令就会顺手重打'
          : r && r.off ? '闸还关着：测活也不发（先打开上面那颗）'
          : ((r && r.err) || '没回话');
        noteSet('测活没成：' + why, 'bad');
        return modelRefresh();
      }
      const m = Array.isArray(r.models) ? r.models : [];
      noteSet('这台服务答话了（' + (Math.round(r.ms / 100) / 10) + ' 秒）：认出 ' + m.length + ' 个模型'
        + (m.length ? ' —— ' + m.slice(0, 6).join('、') + (m.length > 6 ? '…' : '') : '（一个都没列出来：地址或端点也许不对）'),
        m.length ? 'ok' : 'warn');
      return modelRefresh();
    }, () => { modelBusy = 0; noteSet('测活没回话（后台或宿主断了？）', 'bad'); });
  }
  function openModelModal() {
    const body = $('setModalBody');
    const c = modelConf();
    if (!body || !openModalShell('model', '本机模型 · 配置')) return;
    body.textContent = '';
    const mk = (cls, tag, txt) => { const e = document.createElement(tag || 'div'); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const stat = mk('mStat'); stat.id = 'modelModalStat';
    const box = (labText, inputId, ph, val, type) => {
      const row = mk('mRow');
      const inp = document.createElement('input');
      inp.type = type || 'text'; inp.id = inputId; inp.placeholder = ph || '';
      if (val != null) inp.value = val;
      row.append(mk('mLab', 'span', labText), inp);
      return { row: row, inp: inp };
    };
    body.append(stat);
    // 端点用三张卡而不是输入框：协议只有这三种，选错一次就是一次说不清的失败
    // 高亮一律「由当前选中值现算」，不出现 'mOpt cur' 那种建弹窗时染色的字面（段 [28] 同一条纪律：染色只有一处来源）
    const eps = (modelSt && Array.isArray(modelSt.endpoints)) ? modelSt.endpoints : [];
    const epCls = (sel, e) => 'mOpt' + (e === sel ? ' cur' : '');
    eps.forEach((e) => {
      const b = mk(epCls(c ? c.endpoint : '', e.endpoint), 'button'); b.type = 'button'; b.id = 'mEp_' + e.endpoint;
      b.append(mk('', 'b', e.label), mk('mTip', 'span', c && c.endpoint === e.endpoint ? '现在用的就是这个' : '点它切过来（保存才生效）'));
      b.addEventListener('click', () => {
        eps.forEach((o) => { const el = $('mEp_' + o.endpoint); if (el) el.className = epCls(e.endpoint, o.endpoint); });
        b.querySelector('.mTip').textContent = '已选中：点下面「保存」才写进去';
        $('modelModalStat').textContent = '端点选了 ' + e.label + '（还没保存）';
      });
      body.append(b);
    });
    const base = box('地址', 'modelBase', c ? c.base : (modelSt && modelSt.defBase) || 'http://127.0.0.1:11434', '', 'text');
    const model = box('模型名', 'modelModel', '留空＝用服务的默认模型', c ? c.model : '');
    const ms = box('超时秒', 'modelMs', '3~300', c ? String(Math.round(c.ms / 1000)) : '60', 'number');
    const sys = box('系统提示', 'modelSystem', '留空＝发预设（带正例/反例的去 AI 味那份）；卡片右上角 ✎ 也能改', c ? c.system : '');
    const key = box('API Key', 'modelToken', c && c.hasToken ? '已设（留空＝不改）' : '本机服务不要就留空', '', 'password');
    body.append(base.row, model.row);
    // v0.11.5「选择模型」：测活答回来的名单不再只念一句就完——在这里摆成可点的格子，点一格把那个名字填进
    // 「模型名」。名单每次都是当场问的（不缓存、不拿上一趟的名单冒充现在）：服务重启换了模型，格子就跟着换。
    const mrow = mk('mRow');
    const mlistBtn = document.createElement('button'); mlistBtn.type = 'button'; mlistBtn.id = 'bModelList';
    mlistBtn.className = 'mOpt'; mlistBtn.textContent = '获取模型列表';
    mlistBtn.title = '问一次上面那个地址（闸开着才真去问；与设置行那颗「测活」走同一条出口）';
    const mchips = mk('mTip', 'div', '闸开着才能问；认出几个模型就摆几格，点一格填进「模型名」');
    mrow.append(mlistBtn);
    body.append(mrow, mchips);
    mlistBtn.addEventListener('click', () => {
      mlistBtn.disabled = true;
      mchips.textContent = '在问…（只问上面那个地址，几秒）';
      return send({ t: 'modelTest' }).then((r) => {
        mlistBtn.disabled = false;
        const names = Array.isArray(r && r.models) ? r.models.map((x) => String(x)) : [];
        if (!r || !r.ok) {
          mchips.textContent = '没问成：' + ((r && r.noHost && '没装原生宿主 —— 这条腿只走宿主')
            || (r && r.oldHost && '宿主还不认模型通道 —— 重跑一次安装命令就会顺手重打')
            || (r && r.off && '闸还关着：先打开上面那颗')
            || (r && r.err) || '没回话');
          return;
        }
        mchips.textContent = '';
        if (!names.length) { mchips.textContent = '服务答话了但一个模型名都没认出来（端点选错或地址不对？）'; return; }
        names.forEach((name) => {
          const chp = document.createElement('button'); chp.type = 'button'; chp.className = 'mOpt'; chp.textContent = name;
          chp.title = '把「' + name + '」填进模型名（点了还要点「保存」才写进存储）';
          chp.addEventListener('click', () => {
            const inp = $('modelModel'); if (inp) inp.value = name;
            const stv = $('modelModalStat');
            if (stv) { stv.textContent = '模型选了 ' + name + '（点「保存」才写进去）'; stv.className = 'mStat'; }
          });
          mchips.append(chp);
        });
      }, () => { mlistBtn.disabled = false; mchips.textContent = '没回话（后台或宿主断了？）'; });
    });
    body.append(ms.row, sys.row, key.row);
    const acts = mk('mRow');
    const save = document.createElement('button'); save.type = 'button'; save.id = 'bModelSave'; save.className = 'mPri'; save.textContent = '保存';
    const clr = document.createElement('button'); clr.type = 'button'; clr.id = 'bModelKeyClear'; clr.className = 'mDanger'; clr.textContent = '抹掉 Key';
    acts.append(save, clr);
    body.append(acts);
    body.append(mk('mTip', 'div', '保存只写进 chrome.storage（ysy.xprobe.model），这一趟不发任何请求 —— 真要问模型是「测活」或页面那颗钮。地址只认 http://127.0.0.1:端口 或 http://localhost:端口（要带 1024 以上的端口）：填别的地址保存不了，这是设计，不是没做完。Key 那一格留空＝保持原值不动，要清干净点「抹掉 Key」（它只清这一格，别的一律不碰）。'));
    if (modelSt && modelSt.installHint) {
      body.append(mk('mTip', 'div', '如果这台机器还没装原生宿主：' + modelSt.installHint));
    }
    save.addEventListener('click', () => doModelSave(c));
    clr.addEventListener('click', () => doModelSave(c, true));
    base.inp.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doModelSave(c); });
    syncModelModal();
  }
  function syncModelModal() {
    const el = $('modelModalStat');
    if (!el) return;
    if (!modelSt) { el.textContent = '正在问后台…'; return; }
    if (modelSt.badConf) { el.textContent = '现在存的值读不出来：' + modelSt.badConf; el.className = 'mStat bad'; return; }
    el.textContent = '闸' + (modelConf() && modelConf().on ? '开着' : '关着') + ' · 最近一趟：' + modelStatText();
    el.className = 'mStat';
  }
  function doModelSave(c, clearKey) {
    const val = (id) => { const el = $(id); return el ? String(el.value == null ? '' : el.value).trim() : ''; };
    const sel = (modelSt && Array.isArray(modelSt.endpoints)) ? modelSt.endpoints.filter((e) => {
      const el = $('mEp_' + e.endpoint); return el && el.className.indexOf('cur') >= 0;
    })[0] : null;
    const sec = Number(val('modelMs'));
    // 只带「这一趟真要改」的那几格：SW 那边是 Object.assign(存的值, 收到的值)，
    // 键不存在＝保留原值，键存在但值是 undefined＝当成清空。所以 token 不在时连键都不写，
    // 否则用户只是改个端口，就把自己的 API Key 抹了（那是「删用户数据」，红线）。
    const msg = {
      endpoint: sel ? sel.endpoint : (c ? c.endpoint : 'generate'),
      base: val('modelBase') || (c ? c.base : ''),
      model: val('modelModel'),
      system: val('modelSystem'),
      ms: Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : (c ? c.ms : 60000),
      on: c ? !!c.on : false,
    };
    const key = val('modelToken');
    if (clearKey) msg.token = '';
    else if (key) msg.token = key;
    // 平铺着发：SW 的 modelSet 就是 modelRead(msg) —— 它读的是 msg 上那几个键名，包一层 data 它看不见，
    // 看不见就全按缺省处理，那颗闸会被悄悄写成关（用户的 Key 没丢、闸却关了，比丢了难查）。
    return send(Object.assign({ t: 'modelSet' }, msg)).then((r) => {
      if (!r || !r.ok) { noteSet('没保存：' + ((r && r.err) || '那一格不合规'), 'bad'); return r; }
      modelSt = null;
      closeModal();
      noteSet('配置已存好：' + modelConfText(r.conf) + '（这一趟只写存储，没发任何请求）', 'ok');
      return modelRefresh();
    });
  }
  // 设置页 main 区只留三眼：我的账号是谁 / 今日目标当前值 / 本机占用。
  // 「运行模式」与「扩展 ID + 安装命令」原来在这里各回显一遍（一处状态两处写，还叠了一整段安装说明），
  // v0.9.8 起收进 setBox 那几行的状态位与 ❓ —— 同一个事实只在一个地方出现。
  function renderSet(root) {
    const show = (l, v, sty) => root.append(rowNode({ k: 'row', label: l, value: v, sty: sty || '' }));
    const sr = st.series || {};
    show('我的账号现在是谁', '@' + (sr.own || '(还不知道)') + '　来源：' +
      (sr.ownSet ? '设置里钉的（把上面那格清空再点应用 = 回到自动识别）' : (sr.own ? '自动识别（认到的是 @' + (sr.ownAuto || sr.own) + '）' : '还没认到：进一次自己的主页')),
      sr.own ? '' : 'warn');
    const gt = (st.guard || {}).goalToday;
    show('今日目标当前值', gt ? (gt.base != null ? gt.base + (gt.baseSrc === 'hand' ? '（手动填的）' : '（自动=今天首个读数）') : '自动') +
      ' · 目标 +' + gt.target : '（还没设过：目标默认 399，基线自动）');
    // 本机目录的占用账（v0.8.8）：数字全是 xprobe_fs.py 量回来的，面板一个字节都不自己算——
    // 算的是「按保留天数能清多少」，这口径只有本机知道文件名。没测过时这行自己会说该点哪枚钮。
    root.append(rowNode(V.fsRow(fs)));
  }
  function viewName() {
    return view === 'mine' ? '我的' : view === 'plaza' ? '广场' : view === 'forecast' ? '预测' : view === 'debug' ? '诊断' : view === 'set' ? '设置' : '首页';
  }

  function refreshState() {
    return cmd('state').then(() => { if (!out.err) render(); return applyWho(); });
  }

  // ---------- 本机库（v0.7.0）：广场两张榜 ----------
  // 三条白名单查询（并行发，各起一个宿主进程，墙钟约等于最慢那条）：
  // accounts 给账号榜与建议；posts_top 按曝光取前 200、posts_growth 按增速取前 200 ——
  // 只查其中一条会出错：按增速取回的 200 条里再按曝光排，「曝光榜第一名」就成了一句假话。
  // 两份帖子按 tweet_id 合成一份（增速那路补上 view_gain/hours/view_per_h）。
  // v0.8.2 再加两条时间线的：tl_days（有哪几天）与 tl_rank（选中的那天按曝光排）。
  function fetchDb(force) {
    if (dbBusy) return Promise.resolve(db);
    if (!force && db && Date.now() - dbAt < 15000) return Promise.resolve(db);
    dbBusy = true;
    const t0 = Date.now();
    const one = (q, limit, day) => send({ t: 'dbq', q: q, limit: limit, day: day });
    return Promise.all([one('accounts', 500), one('posts_top', 200), one('posts_growth', 200),
      one('tl_days', 60), one('tl_rank', 500, tlDay)]).then((rs) => {
      const a = rs[0] || {}, top = rs[1] || {}, gr = rs[2] || {}, tld = rs[3] || {}, tlr = rs[4] || {};
      const rows = [], byId = {};
      (Array.isArray(top.rows) ? top.rows : []).forEach((r) => {
        if (r && r.tweet_id && !byId[r.tweet_id]) { byId[r.tweet_id] = r; rows.push(r); }
      });
      (Array.isArray(gr.rows) ? gr.rows : []).forEach((r) => {
        if (!r || !r.tweet_id) return;
        const cur = byId[r.tweet_id];
        if (!cur) { byId[r.tweet_id] = r; rows.push(r); return; }
        ['view_gain', 'hours', 'view_per_h', 'like_gain'].forEach((k) => { if (r[k] != null) cur[k] = r[k]; });
      });
      dbBusy = false; dbAt = Date.now();
      const postErr = !top.ok ? (top.err || '没回包') : (!gr.ok ? (gr.err || '没回包') : '');
      db = {
        at: dbAt, ms: dbAt - t0,
        id: a.id || top.id || gr.id || '', via: a.via || top.via || gr.via || '',
        native: a.native || top.native || gr.native || null,
        acct: { ok: !!a.ok, rows: Array.isArray(a.rows) ? a.rows : [], err: a.ok ? '' : (a.err || '没回包') },
        post: { ok: !!(top.ok && gr.ok), rows: rows, err: postErr },
        tlDays: { ok: !!tld.ok, rows: Array.isArray(tld.rows) ? tld.rows : [], err: tld.ok ? '' : (tld.err || '没回包') },
        tl: { ok: !!tlr.ok, rows: Array.isArray(tlr.rows) ? tlr.rows : [], err: tlr.ok ? '' : (tlr.err || '没回包') },
      };
      // 首批回包还没选过天：落到「最近有数的那天」再补一枪（只落一次，之后选择权在用户手里）
      if (!tlDay && db.tlDays.ok && db.tlDays.rows.length) {
        tlDay = db.tlDays.rows[0].day;
        dbBusy = false;
        return fetchDb(true);
      }
      if (view === 'plaza') render();
      return db;
    });
  }

  // ---------- 「看谁」（v0.6.12：视线只在广场换人，其余视图一律钉在自己身上） ----------
  // state 每次回读的 series 都是 own 那份（core 的默认视线），广场选中别人时补一趟 seriesView 把视线换过去。
  // 不这么做的后果很具体：900ms 轮询会把面板从「这个人」弹回「我自己」，编辑框里一半是他的数一半是我的。
  // 反过来也一样要管：从广场（看着别人）切回首页/我的，若视线还挂在他身上，首页那张「今日四列」就报成了他的账号。
  function whoTarget() {
    const own = (st && st.series && st.series.own) || '';
    return view === 'plaza' ? (whoSel || own) : own;
  }
  function applyWho() {
    if (!st || !st.series) return Promise.resolve();
    const want = whoTarget();
    if (!want || st.series.key === want) return Promise.resolve();
    return cmd('seriesView', { handle: want }).then((r) => {
      // cmd 内部已经把 st 换成回包里的 state（那份的 series 又是 own 的），这里再把视线掰回来
      if (r.ok && r.result) { st.series = r.result; render(); }
    });
  }
  // 下拉的料来自 st.series.handles（core 按 updatedAt 排好、自己在最前）。
  // 选中的人被序列上限挤掉了就自动回到自己 —— 留着一个不存在的 handle 会让下面所有表都空着，最难查
  function syncWho() {
    const sel = $('whoPick');
    if (!sel) return;
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
      : '选谁就在下面看谁、编辑谁（只影响广场；自己的历史在「我的」页）';
  }

  function refreshTabs() {
    return send({ t: 'tabs' }).then((r) => {
      const sel = $('tabPick'), keep = sel.value;
      sel.textContent = '';
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '（活动标签页）';
      sel.append(o0);
      ((r && r.tabs) || []).forEach((t) => {
        const o = document.createElement('option');
        o.value = String(t.id);
        o.textContent = (t.active ? '* ' : '') + t.title + ' ' + t.url;
        sel.append(o);
      });
      if (keep && sel.querySelector('option[value="' + keep + '"]')) sel.value = keep;
    });
  }

  // 导出：把 core 返回的 JSON 串落成本地文件，走扩展页面自己的下载，不碰 x.com 也不碰 sink
  function download(text) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'xprobe-' + stamp + '.json';
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }
  function doExport() {
    cmd('export').then((r) => {
      if (r.ok && typeof r.result === 'string') { download(r.result); out.err = ''; }
      else if (!out.err) out.err = '导出没拿到内容';
      render();
    });
  }
  // 查表的结果存模块变量，由 render() 在诊断视图里重放 —— 不直接往 #report 里 prepend。
  // 病根（docs/UIX.md UIX-18）：#report 每 900ms 被 render() 整块清空，直接塞进去的查询结果
  // 最多活 0.9 秒；这跟 v0.9.8 给设置页修掉的是同一张嘴，当时只修了设置页，诊断页这条漏了。
  let qKeep = null;
  function doQuery() {
    const q = $('q').value || '';
    return cmd('query', q).then((r) => {
      const c = (r.result && r.result.counts) || {};
      const head = { k: 'line', text: '查询 "' + q + '"（users ' + c.users + ' / posts ' + c.posts + '）：' };
      const body = (r.ok && r.result) ? V.queryLines(r.result).slice().reverse()
        : [{ k: 'line', text: '查表没成：' + (r.err || '没回包') }];
      qKeep = [head].concat(body);
      render();
    });
  }
  // 补录/改数/删行全在趋势页的日点网格里做（impsNode）；这里的旧 doBackfill/bkBox 已退休。

  // 视图与按钮归位（v0.6.9 UI 整顿）：区块按 view 显隐，按钮文本随 core 回读、不存本地真相。
  // 用 classList.toggle 而不是整个覆写 className——那是踩过的坑：className='' 把布局类 bar 一起抹掉，
  // .bar.hide 的隐藏规则从此匹配不上，四个工具条全裸露堆一起（用户截图的那个「哪都有很多按钮」就是这个）。
  function syncButtons() {
    const show = (id, on) => { const el = $(id); if (el) el.classList.toggle('hide', !on); };
    // 写字面也要认空：这四颗钮在「设置」页的 html 里，面板文档比 JS 旧一格时 $() 就是 null，
    // 原来那句直接 .textContent = → 整块 syncButtons 抛出去，前面那些视图显隐跟着一起没跑（点了没反应）。
    const setTxt = (id, s) => { const el = $(id); if (el) el.textContent = s; };
    show('barHome', view === 'home');
    show('barTrend', view === 'mine' || view === 'plaza' || view === 'forecast');
    show('barDebug', view === 'debug');
    show('setBox', view === 'set');
    show('whoPick', view === 'plaza');   // 「看谁」只在广场有意义：我的页视线恒在自己身上
    show('bDbRefresh', view === 'plaza');
    syncFsControls();
    // 「清空」的等第二下也要写在钮上（和清日志那三颗同一个规矩）；这一句必须排在 `if (!st) return` 之前，
    // 否则活动标签页不是 x.com 时（st 为 null）钮就永远不改口 —— 那是「点了没反应」的另一种成因。
    setTxt('bClear', (clearArm && Date.now() - clearArm < ARM_MS) ? '再点一次=清空' : '清空');
    const tabsOn = { home: 'vHome', mine: 'vMine', plaza: 'vPlaza', forecast: 'vFc', debug: 'vDebug', set: 'vSet' };
    Object.keys(tabsOn).forEach((k) => {
      const b = $(tabsOn[k]);
      if (b) b.className = view === k ? 'on' : (k === 'debug' && !(st && st.debug && st.debug.on) ? 'hide' : '');
    });
    if (!st) return;
    const dbgOn = !!(st && st.debug && st.debug.on);
    // 这四颗钮的字面全部走 setTxt：html 比 JS 旧（改了 JS 忘了重载面板/扩展）时 $() 拿到的是 null，
    // 直接 .textContent 就整块 syncButtons 抛出去——上面那些视图显隐就再也没机会跑（面板看起来「点了没反应」）。
    setTxt('bDump', '调试转储: ' + (st.dump && st.dump.on ? '开' : '关'));
    setTxt('bHtml', '全文HTML: ' + (st.dump && st.dump.html ? '开' : '关'));
    setTxt('bDebug', '诊断模式: ' + (dbgOn ? '开' : '关'));
    setTxt('bBadge', '页面内徽标: ' + (st.badge && st.badge.on ? '开' : '关'));
  }
  function setView(v) {
    view = ['home', 'mine', 'plaza', 'debug', 'set', 'forecast'].indexOf(v) >= 0 ? v : 'home';
    if (view !== 'debug') qKeep = null;   // 查表的结果只在诊断视图重放，离开就丢（别在别的页顶出一段旧查询）
    syncButtons();
    render();
    // 进出我的/广场要按新的视线重取一次序列：广场跟着「看谁」走，其余视图一律回到自己
    applyWho();
    // 进广场就重读一次库（两张榜的真身在 xprobe.db）；别的视图不读，别为看不见的表起宿主进程
    if (view === 'plaza') fetchDb(true);
    // 换视图顺手回读一次 state：广场那条轮询是 30 秒一轮，刚在这一页上关注完不该等半分钟才翻红
    refreshState();
  }

  // 随机加时上限：留空 = 回到默认 20；改完立刻生效（core 现读现夹）
  function doRndSet() {
    const raw = String($('rndMax').value || '').trim();
    const n = raw === '' ? undefined : Number(raw);
    rndDirty = false;
    return cmd('setRndMax', n).then((r) => {
      // 「点了没反应」的一半成因是成功没落点（失败有 #err，成功只有 900ms 后悄悄覆写回输入框）
      noteSet(r.ok ? ('关注加时上限已设为 ' + (n == null ? '默认 20' : n) + ' 秒（60 秒冷却之外再随机加 0~这个数，下一次抽签就按它来）')
        : ('加时上限没改：' + (r.err || '没回话')), r.ok ? 'ok' : 'bad');
      return r;
    });
  }
  // 今日关注目标：基线留空 = 回自动（今天首个分钟读数）；填数字 = 手动盖过。
  // 目标留空 = 保持现有目标（没设过就 399）——两格都空就不用空跑一趟。
  // 成功的反馈要肉眼可见：清格 + 跳回首页（进度条就在那儿），失败把 SW 的原话亮在 #err。
  function doGoalSet() {
    const base = String($('goalBase').value || '').trim();
    const target = String($('goalTarget').value || '').trim();
    if (base === '' && target === '') { out.err = '目标与基线都空 = 没改'; render(); return; }
    const v = { base: base === '' ? null : Number(base) };
    if (target !== '') v.target = Number(target);
    return cmd('goalSet', v).then((r) => {
      // 反馈先落到「最近动作」，再决定跳不跳：跳到首页时 #setNote 被藏起来，但节点是静态的，
      // 用户切回设置还看得见这一句（以前成功一个字都不写，只剩「页面自己跑了」）。
      noteSet(r.ok ? ('今日目标已记下：' + (v.base == null ? '基线自动' : '基线 ' + v.base) + ' · 目标 +' + (v.target == null ? '沿用现有' : v.target)
        + '（进度条在首页）') : ('目标没改成：' + (r.err || '没回话')), r.ok ? 'ok' : 'bad');
      if (r.ok) {
        ['goalBase', 'goalTarget'].forEach((id) => { if ($(id)) $(id).value = ''; });
        if (view === 'set') setView('home'); else render();
      }
      return r;
    });
  }

  // 我的账号：留空应用 = 撤掉手动值、回到自动识别。core 那边认到一次就存一次，所以这一格是「说了算」的那一份
  function doOwnSet() {
    const raw = String($('ownSet').value || '').trim();
    ownDirty = false;
    return cmd('ownSet', { handle: raw }).then((r) => {
      const x = (r && r.result) || {};
      if (!r.ok || x.ok === false) { out.err = (x && x.err) || r.err || '改自己的 handle 没成功'; render(); return r; }
      noteSet(x.manual ? '已钉住：以后曝光记在 @' + x.own + ' 名下（旧数据仍留在它当初写入的那个 handle 上，要去广场选中那个人自己补/删）'
        : '已回到自动识别：现在认到的是 @' + (x.own || '(还没有，进一次自己的主页)') + (x.auto ? '（自动那份 = @' + x.auto + '）' : ''), 'ok');
      render();
      return r;
    });
  }

  // ---------- 设置页弹窗（v0.9.8）：一张壳子两种内容 ----------
  // 「这条的完整说明」= 读那一行的 .secFold 全文；「运行模式」= 登录/切模式/退出都在里面走完。
  // 三条纪律：① 弹窗挂在 body 上而不是 #report —— #report 每 900ms 被 render() 清空，
  // 原先「验证码已发到 xxx」那句 prepend 进去其实活不到一秒；② 打开弹窗不改任何状态，状态只在
  // 用户点里某一格（纯本地卡片 / 登录成功 / 退出确认）那一刻改；③ body 一次建好，之后只改
  // 显隐与文案，不重建 —— 重建会把用户正在打的验证码抹掉。
  let modalKind = '';   // '' | 'help' | 'mode' | 'env'
  let modalPrev = null; // 开弹窗前那一颗钮：关掉要把焦点还回去（D-12，Tab 一圈回得到起点）
  function openModalShell(kind, title) {
    modalKind = kind;
    modalPrev = document.activeElement;
    const m = $('setModal');
    if (!m) return false;
    const t = $('setModalTitle'); if (t) t.textContent = title;
    m.classList.remove('hide');
    return true;
  }
  function closeModal() {
    modalKind = '';
    const m = $('setModal'); if (m) m.classList.add('hide');
    const b = $('setModalBody'); if (b) b.textContent = '';
    if (modalPrev && modalPrev.focus) { try { modalPrev.focus(); } catch (e) { /* 那颗钮可能已被重画掉 */ } }
    modalPrev = null;
  }
  function foldNode(text) {
    const d = document.createElement('div');
    d.className = 'mFold';
    d.textContent = text;
    return d;
  }
  // 说明弹窗：正文 = 那一行 .secFold 的全文（唯一一份，html 里就地存着，不另抄进 JS）
  function openHelpModal(name, foldText, extras) {
    const body = $('setModalBody');
    if (!body || !openModalShell('help', name + ' · 完整说明')) return;
    body.textContent = '';
    body.append(foldNode(foldText));
    (extras || []).forEach((n) => body.append(n));
  }
  // 每行那颗 ❓ 由代码生成，不在 html 里手写：这样「有全文就一定有入口」是结构保证，不靠人记得住
  function wireSetHelp() {
    const rows = document.querySelectorAll('#setBox .secRow');
    Array.prototype.forEach.call(rows, (row) => {
      const fold = row.querySelector('.secFold');
      const lab = row.querySelector('.secLab');
      if (!fold || !lab || lab.querySelector('.secQ')) return;
      const name = (lab.textContent || '').trim();
      const q = document.createElement('button');
      q.type = 'button'; q.className = 'secQ'; q.textContent = '?';
      q.title = '这条的完整说明';
      q.addEventListener('click', () => openHelpModal(name, (fold.textContent || '').trim(), helpExtras(row)));
      lab.append(q);
    });
  }
  // 少数几行的说明里带「现场数据」：扩展 ID 那行把真的安装命令附上，「云端接口」那行把 boot4 CORS
  // 要放行 Origin 那串附上（dev 那档 403 的病根就在这串没进白名单）；复制走面板既有的 copyText
  // （剪贴板写不动就退回选区 + execCommand），不为这一格往 manifest 加 clipboardWrite —— RL-3 拦的是那条权限，不是这颗钮。
  function helpExtras(row) {
    const extId = (chrome.runtime && chrome.runtime.id) || '';
    const mkCopyLine = (text, label, okMsg) => {
      const pre = document.createElement('pre');
      pre.textContent = text;
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.addEventListener('click', () => {
        copyText(pre.textContent, okMsg, '复制失败（划选上面那行）', b, label,
          () => { const r = document.createRange(); r.selectNodeContents(pre);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return document.execCommand('copy'); });
      });
      const row2 = document.createElement('div');
      row2.className = 'mRow';
      row2.append(b);
      return [document.createElement('hr'), pre, row2];
    };
    if (row.querySelector('#extIdLine') && extId) return mkCopyLine('py -3 native\\install-host.py --ext-id ' + extId, '复制命令', '已复制');
    if (row.querySelector('#envHint') && extId) return mkCopyLine('chrome-extension://' + extId, '复制 Origin', '已复制（贴进 boot4 CorsConfig 那一行）');
    return [];
  }

  // ---------- 云端同步（v0.8.0 起默认关；v0.9.8 起「模式」与「登录」分家、都在弹窗里走）----------
  // 状态读的是 SW 的 cloudState：{on, hasToken, email, stat, deviceId}。
  // on = 「要不要上送」，token = 「是不是认得你」——两件事以前被一颗钮混在一起（点一下就退出登录），
  // 现在切回纯本地只停上送、保留登录态，退出登录是弹窗里另一颗带二次确认的钮。
  let cloudSt = null, cloudCdEnd = 0, logoutArm = 0, envBusy = 0, loginBusy = 0;

  function cloudRefresh() {
    return send({ t: 'cloudState' }).then((r) => {
      cloudSt = r && r.ok ? r : null;
      syncCloudUI();
      // 「运行模式」是三条上送共用的那道闸：登录态一变，下面标杆/档案同步那两行必须同频
      // （不然面板一边显示已登录、一边说没资格推）
      xsRefresh();
      libRefresh();
      return r;
    });
  }
  function cloudStatText(s) {
    if (!s || !s.at) return '还没同步过（有新数据落盘 20 秒后自动传一次）';
    const t = new Date(s.at).toLocaleTimeString();
    if (s.needLogin) return '登录失效了：重新登录一下（' + t + '）';
    if (!s.ok) return '上次没传成：' + (s.err || '没回话') + '（' + t + '）';
    return '上次 ' + t + '：日点 ' + s.dayRows + ' 行、关注事件 ' + s.followEvents + ' 条';
  }
  function modeStatText() {
    const on = !!(cloudSt && cloudSt.on), logged = !!(cloudSt && cloudSt.hasToken);
    const where = '接口 ' + ((cloudSt && cloudSt.env) || 'prod') + ' · ' + ((cloudSt && cloudSt.base) || '');
    if (on) return '现在：云端 · 已登录 ' + (cloudSt.email || '?') + '\n' + cloudStatText(cloudSt && cloudSt.stat) +
      '\n' + where + '\n设备号 ' + String((cloudSt && cloudSt.deviceId) || '').slice(0, 8) + '…（服务端按 用户+设备 分账）';
    if (logged) return '现在：纯本地 · 这一档的登录态还在（' + cloudSt.email + '）\n' + where +
      '\n切回云端不用再收验证码，点下面那张卡就行';
    return '现在：纯本地 · 没登录\n' + where + '\n数据只进本机 xprobe.db；云端那条路一个字节都不走';
  }
  // 「云端」那张卡的副标题必须随登录态改口：没 token 时它点下去是「让你登录」，有 token 时才是「切模式」。
  // 一张卡两种命运而字面不提登录，就是用户点名那句「只有在点击切换云端才提示」的真身（docs/UIX.md UIX-03）。
  function cloudCardTip() {
    const base = ((cloudSt && cloudSt.base) || 'api2.mingzhang.cc');
    if (cloudSt && cloudSt.hasToken) return '登录后：每日指标与关注台账、标杆事件行都推到你自己的 Java 库（' + base + '）';
    return '没登录 · 点它或直接在下面「登录」那一格填邮箱，收验证码即可（账号不存在会自动创建）';
  }
  // 「云端接口」那一行：两档地址是 SW 里写死的枚举，面板只负责把当前档与它给的地址念出来，
  // 自己拼不出一个地址（这一行也顺带把 boot4 CORS 要填的那串 Origin 摆在 ❓ 里）
  function envLabel() { return (cloudSt && cloudSt.env) === 'dev' ? '本机 dev' : '线上'; }
  function syncEnvUI() {
    const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    set('bCloudEnv', '接口：' + envLabel());
    const logged = !!(cloudSt && cloudSt.hasToken);
    set('envHint', '现在打的是：' + envLabel() + '（' + ((cloudSt && cloudSt.base) || '?') + '）' + (logged ? ' · 这一档已登录' : ' · 这一档还没登录'));
  }
  // 重试间隔那一格（v0.11.0）：值从 SW 回来，面板不存第二份真相；输入框只在用户没在打字时跟随
  let retryDirty = false;
  function retryVal() { return (cloudSt && cloudSt.retryMin) || 5; }
  function syncRetryUI() {
    const el = $('retryMin');
    if (el && !retryDirty) el.value = String(retryVal());
    const h = $('retryHint');
    if (h) h.textContent = '同步没成功时每 ' + retryVal() + ' 分钟自动再试一次（可改 1~60，改完当场生效）';
    const b = $('bRetrySet');
    if (b) b.textContent = '应用';
  }
  function doRetrySet() {
    const el = $('retryMin');
    const raw = String((el && el.value) || '').trim();
    const n = Math.round(Number(raw));
    if (!raw || !Number.isFinite(n) || n < 1 || n > 60) {
      noteSet('重试间隔要填 1~60 的整数分钟（现在填的是「' + raw + '」）', 'warn');
      if (el) el.focus();
      return Promise.resolve();
    }
    const b = $('bRetrySet'); if (b) { b.disabled = true; b.textContent = '保存中…'; }
    return send({ t: 'retrySet', min: n }).then((r) => {
      if (b) b.disabled = false;
      if (!r || !r.ok) { noteSet('重试间隔没改成：' + ((r && r.err) || '没回话'), 'warn'); syncRetryUI(); return; }
      retryDirty = false;
      cloudSt = Object.assign({}, cloudSt || {}, { retryMin: r.min });
      noteSet('重试间隔已改为 ' + r.min + ' 分钟（闹钟已重建，上一趟没推成的到点自动再试）', 'ok');
      syncRetryUI();
    });
  }
  function syncCloudUI() {
    const on = !!(cloudSt && cloudSt.on), logged = !!(cloudSt && cloudSt.hasToken);
    const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    syncEnvUI();
    syncRetryUI();
    set('bCloud', on ? '模式：云端（' + ((cloudSt && cloudSt.email) || '') + '）' : '切到云端');

    set('cloudHint', on ? '云端 · 上送中' : (logged ? '纯本地 · 登录态还在，只是没开上送'
      : '纯本地：数据只进本机 xprobe.db；要上送就点这颗钮，弹窗里「登录」那一格填邮箱'));
    const cs = $('cloudStat');
    if (cs) {
      cs.textContent = on ? cloudStatText(cloudSt && cloudSt.stat)
        : (logged ? '停着：登录还在，上送已关（点「切到云端」再打开）' : '关着：数据只进本机 xprobe.db');
      cs.className = 'secDesc' + (on && cloudSt && cloudSt.stat && cloudSt.stat.ok === false ? ' warn' : '');
    }
    syncModeModal();
    syncEnvModal();   // 两个弹窗都得跟着云端状态走：只同步「运行模式」那个，「云端接口」就停在点开那一刻（用户：切档要关掉重开才生效）
  }
  // 弹窗里的格只在「模式/登录态/档位变了」时改字面与显隐，不重建节点（重建会抹掉正在打的验证码）
  function syncModeModal() {
    if (modalKind !== 'mode') return;
    const on = !!(cloudSt && cloudSt.on), logged = !!(cloudSt && cloudSt.hasToken);
    const bl = $('mOptLocal'), bc = $('mOptCloud');
    if (bl) bl.className = 'mOpt' + (on ? '' : ' cur');
    if (bc) bc.className = 'mOpt' + (on ? ' cur' : '');
    // 卡的副标题跟着登录态改口（不重建节点，只换那一格字面）：没登录时必须看得见「这里能登录」
    const bt = bc && bc.querySelector('.mTip');
    if (bt) { const want = cloudCardTip(); if (bt.textContent !== want) bt.textContent = want; }
    const st = $('modeStat'); if (st) { st.textContent = modeStatText(); st.className = 'mStat' + (on ? ' ok' : ''); }
    const lg = $('mLogin'); if (lg) lg.classList.toggle('hide', on || logged);
    const ld = $('mLogged'); if (ld) ld.classList.toggle('hide', !logged);
    const em = $('cloudEmailShow');
    if (em) em.textContent = logged ? (cloudSt.email || '') : '';
    const out = $('bCloudOut');
    if (out) out.textContent = (logoutArm && Date.now() - logoutArm < ARM_MS) ? '再点一次=退出登录' : '退出登录';
    tickCodeCd();
  }
  // 发验证码那颗钮的 60 秒：服务端本来就 60 秒一条，钮上如实读秒，别让用户对着一个「按不动的灰钮」猜
  function tickCodeCd() {
    const b = $('bCloudCode');
    if (!b) return;
    const left = Math.ceil((cloudCdEnd - Date.now()) / 1000);
    const txt = left > 0 ? '再等 ' + left + ' 秒' : '发验证码';
    // 只在字面真的变了时写 DOM（读秒每秒都进来，别每秒碰一次节点）
    if (b.textContent !== txt) b.textContent = txt;
    const dis = left > 0;
    if (b.disabled !== dis) b.disabled = dis;
  }
  function openModeModal() {
    const body = $('setModalBody');
    if (!body || !openModalShell('mode', '运行模式')) return;
    body.textContent = '';
    const mk = (cls, tag, txt) => { const e = document.createElement(tag || 'div'); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const stat = mk('mStat'); stat.id = 'modeStat';
    const opt = (id, title, tip) => {
      const b = mk('mOpt', 'button'); b.id = id; b.type = 'button';
      const t = mk('', 'b', title);
      const s = mk('mTip', 'span', tip);
      b.append(t, s);
      return b;
    };
    const lo = opt('mOptLocal', '纯本地', '数据只进本机 xprobe.db，一条都不出机器；随时可切回来');
    const cl = opt('mOptCloud', '云端', cloudCardTip());
    lo.addEventListener('click', () => doModeSet(false));
    cl.addEventListener('click', () => {
      if (cloudSt && cloudSt.hasToken) { doModeSet(true); return; }
      const lg = $('mLogin');
      if (lg) lg.classList.remove('hide');
      const em = $('cloudEmail'); if (em) em.focus();
      const st = $('modeStat'); if (st) st.textContent = '云端要先登录：在下面「邮箱」那一格填地址，点「发验证码」（账号不存在会自动创建）';
    });
    const box = mk('mBox'); box.id = 'mLogin'; box.className = 'mBox hide';
    box.append(mk('mLab', 'b', '登录（邮箱收验证码）'));
    const r1 = mk('mRow');
    const email = document.createElement('input'); email.type = 'email'; email.id = 'cloudEmail'; email.placeholder = 'name@example.com';
    const code = document.createElement('button'); code.type = 'button'; code.id = 'bCloudCode'; code.textContent = '发验证码';
    r1.append(mk('mLab', 'span', '邮箱'), email, code);
    const r2 = mk('mRow');
    const codeIn = document.createElement('input'); codeIn.type = 'text'; codeIn.id = 'cloudCode'; codeIn.maxLength = 6; codeIn.placeholder = '0000';
    const login = document.createElement('button'); login.type = 'button'; login.id = 'bCloudLogin'; login.className = 'mPri'; login.textContent = '登录';
    r2.append(mk('mLab', 'span', '验证码'), codeIn, login);
    r2.append(codeIn, login);
    box.append(r1, r2, mk('mTip', 'div', '邮箱里 4 位数字，60 秒内有效；服务端 60 秒只发一条。身份只存在本扩展的存储里，随每批上送放在请求头，面板不回显 token。'));
    const ld = mk('mRow'); ld.id = 'mLogged'; ld.className = 'mRow hide';
    const who = mk('mTip', 'span'); who.id = 'cloudEmailShow';
    const out = document.createElement('button'); out.type = 'button'; out.id = 'bCloudOut'; out.className = 'mDanger'; out.textContent = '退出登录';
    ld.append(who, out);
    body.append(stat, lo, cl, box, ld);
    body.append(mk('mTip', 'div', '这一步只改「要不要上送」：切回纯本地不抹登录态、也不动本机任何一个字节；要抹身份请点上面的「退出登录」（要按两下）。'));
    // 钮的接线每次开弹窗都重挂一遍（节点是新建的，旧的随 body.textContent='' 一起没了）
    code.addEventListener('click', () => doCloudCode());
    login.addEventListener('click', () => doCloudLogin());
    out.addEventListener('click', () => doCloudOut());
    email.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doCloudCode(); });
    codeIn.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doCloudLogin(); });
    syncModeModal();
  }
  function doModeSet(on) {
    return send({ t: 'cloudMode', on: !!on }).then((r) => {
      if (!r || !r.ok) {
        const st = $('modeStat');
        if (st) { st.className = 'mStat bad'; st.textContent = '模式没改成：' + ((r && r.err) || '没回话'); }
        noteSet('模式没改成：' + ((r && r.err) || '没回话'), 'bad');
        return r;
      }
      noteSet(on ? '已切到云端：从下一批数据起 20 秒内自动上送（本机库照常在记）'
        : '已切回纯本地：只是停上送，本机一个字节没动过' + (r.logged ? '（登录态保留，下次切回来不用再登录）' : ''), 'ok');
      return cloudRefresh();
    });
  }
  // 「云端接口」弹窗（v0.10.0）：两档都是 SW 里写死的地址，点哪一档就把 ysy.xprobe.cloudEnv 写成那个 key，
  // 面板一个地址都拼不出来。这一颗钮同样只开弹窗、不改状态（和「运行模式」那条纪律一致）。
  // v0.10.2 起这一格的账：弹窗**建一次、之后只更新**（D-11），点中一张卡后高亮、状态行、下面那行的钮
  // 字面必须当场跟着换——以前只有卡片是在建弹窗那一刻按当前档染色的，切档后没人再染一遍，
  // 于是「点了没反应，得关掉再打开」（用户原话）。字面由 envCardTitle/envCardTip 一处出，建与更新共用。
  function envCur() { return (cloudSt && cloudSt.env) || 'prod'; }
  function envName(env) { return env === 'prod' ? '线上' : '本机 dev'; }
  function envCardTitle(e) { return envName(e.env) + (e.env === envCur() ? '（现在打这台）' : ''); }
  function envCardTip(e) {
    return e.label + '：' + e.base + ' · 这一档' +
      (e.logged ? '已登录 ' + (e.email || '') : '还没登录，切过去要在「运行模式」弹窗里登录');
  }
  function envStatText() {
    return '现在打的是：' + envLabel() + ' · ' + ((cloudSt && cloudSt.base) || '?') +
      '（这一档' + (cloudSt && cloudSt.hasToken ? '已登录 ' + cloudSt.email : '还没登录') + '）' +
      ' · 换档立即生效，不用关掉重开';
  }
  function openEnvModal() {
    const body = $('setModalBody');
    if (!body || !openModalShell('env', '云端接口（打哪台 boot4）')) return;
    body.textContent = '';
    const mk = (cls, tag, txt) => { const e = document.createElement(tag || 'div'); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const stat = mk('mStat'); stat.id = 'envStat';
    const envs = (cloudSt && cloudSt.envs) || [];
    envs.forEach((e) => {
      const b = mk('mOpt', 'button'); b.id = 'mOptEnv' + e.env; b.type = 'button';
      b.append(mk('', 'b', envCardTitle(e)), mk('mTip', 'span', envCardTip(e)));
      b.addEventListener('click', () => doEnvSet(e.env));
      body.append(b);
    });
    body.append(mk('mTip', 'div', '换档只换「打到哪台 boot4」，本机一个字节都不动、也不改「运行模式」那颗闸（纯本地在哪儿都不发）。登录态与推标杆水位按档各存一份：线上的 token 不会发给 localhost，dev 也不继承线上推到第几行。dev 那档还要 boot4 的 CORS 白名单里有 chrome-extension://' + String((chrome.runtime && chrome.runtime.id) || '?') + '，没有它对面回的是 HTTP 403 纯文本，跟登录没关系。'));
    body.insertBefore(stat, body.firstChild);
    syncEnvModal();
  }
  // 建一次、之后只更新：比对再写，不重建节点（重建会抹掉正在看的字，也违反 D-11）
  function syncEnvModal() {
    if (modalKind !== 'env') return;
    const cur = envCur();
    ((cloudSt && cloudSt.envs) || []).forEach((e) => {
      const b = $('mOptEnv' + e.env); if (!b) return;
      const cls = 'mOpt' + (e.env === cur ? ' cur' : '');
      if (b.className !== cls) b.className = cls;
      const t = b.querySelector('b'); if (t) { const w = envCardTitle(e); if (t.textContent !== w) t.textContent = w; }
      const tip = b.querySelector('.mTip'); if (tip) { const w = envCardTip(e); if (tip.textContent !== w) tip.textContent = w; }
    });
    const st = $('envStat');
    if (st) { const w = envStatText(); if (st.textContent !== w) { st.textContent = w; st.className = 'mStat'; } }
  }
  function doEnvSet(env) {
    const want = String(env);
    const st = $('envStat');
    // 点的就是当前那一档：别发写命令（那是「点了没反应」的另一种成因——什么都没变，什么都没报）。
    // 就地用状态行说明「你要的已经在打了」，并顺手把整格对齐一次（可能只是本地视图旧了）。
    if (want === envCur() && cloudSt) {
      if (st) { st.className = 'mStat'; st.textContent = '不用换：现在打的就是' + envLabel() + '（' + ((cloudSt && cloudSt.base) || '?') + '）'; }
      return Promise.resolve({ ok: true, env: want, base: (cloudSt && cloudSt.base) || '', noop: true });
    }
    if (envBusy) return Promise.resolve({ ok: false, err: '上一次切换还在路上（等它回话再点）' });
    envBusy = Date.now();
    if (st) { st.className = 'mStat'; st.textContent = '切换中：把档位写成 ' + envName(want) + '（只写一档，不发任何请求）…'; }
    return send({ t: 'cloudEnvSet', env: want }).then((r) => {
      envBusy = 0;
      if (!r || !r.ok) {
        if (st) { st.className = 'mStat bad'; st.textContent = '接口没换成：' + ((r && r.err) || '没回话'); }
        noteSet('接口没换成：' + ((r && r.err) || '没回话'), 'bad');
        return r;
      }
      // 先把 SW 回的那几样就地合进本地这一份：钮字面、状态行、下面那一行立刻改口，不等下一轮轮询
      if (cloudSt) {
        cloudSt.env = r.env; cloudSt.base = r.base; cloudSt.hasToken = !!r.logged;
        cloudSt.email = r.email || ''; cloudSt.on = !!r.on;
        (cloudSt.envs || []).forEach((e) => { if (e.env === r.env) { e.logged = !!r.logged; e.email = r.email || ''; } });
      }
      noteSet('云端接口已切到 ' + r.env + '（' + r.base + '）·' +
        (r.logged ? '这一档已登录，' + r.email : '这一档还没登录：要上送得在「运行模式」弹窗里登录一次') +
        '；本机库照常在记，一个字没动', 'ok');
      // 再向 SW 要一次真状态（各档登录态、水位）——syncCloudUI 会连着把开着的这个弹窗一起对齐
      return cloudRefresh().then(() => r);
    });
  }
  function doCloudCode() {
    const b = $('bCloudCode');
    if (b && b.disabled) return Promise.resolve();
    const emEl = $('cloudEmail');
    const email = String((emEl && emEl.value) || '').trim();
    // 空着就点「发验证码」：别把 SW 那句「邮箱格式不对」原样转述出去（用户一个字还没填，被告知
    // 「格式不对」只能让人怀疑自己填错了地方）。当场点名填哪一格、什么形状，并把焦点送进去。
    if (!email) {
      const st = $('modeStat');
      if (st) { st.className = 'mStat warn'; st.textContent = '先在「邮箱」那一格填你的邮箱地址（形如 name@example.com），再点「发验证码」'; }
      noteSet('验证码没发：邮箱那一格是空的', 'warn');
      if (emEl) emEl.focus();
      return Promise.resolve();
    }
    return send({ t: 'cloudSendCode', email: email }).then((r) => {
      if (r.ok) {
        cloudCdEnd = Date.now() + 60000;
        tickCodeCd();
      }
      const st = $('modeStat');
      if (st) {
        st.className = 'mStat' + (r.ok ? ' ok' : ' bad');
        st.textContent = r.ok ? '验证码已发到 ' + email + '（60 秒内有效；没收到等这一分钟走完再点）'
          : '验证码没发出去：' + (r.err || '没回话');
      }
      noteSet(st ? st.textContent : (r.ok ? '验证码已发到 ' + email : '验证码没发出去：' + (r.err || '没回话')), r.ok ? 'ok' : 'bad');
      return r;
    });
  }
  // 登录后那第一趟的三条腿各说各的结果（用户要的是「登录后立即把本地和浏览器的数据同步到云端」，
  // 那就得看得见三条腿各自成没成；合成一句「同步成功」就是另一种骗人）
  function firstPushText(fp) {
    if (!fp) return '登录态已存下；这版后台没回首趟结果，从下一批数据起 20 秒内自动上送';
    const m = fp.metrics || {}, b = fp.bench || {}, lib = fp.library || {}, bl = fp.block || {};
    const leg = (o, what, done) => o.ok
      ? (o.empty ? what + '：本机还没有可推的（不算失败）' : what + '：' + done)
      : what + '没推成：' + (o.err || '没回话');
    return leg(m, '指标与关注台账', '推了 ' + (m.dayRows || 0) + ' 行日点、' + (m.followEvents || 0) + ' 条关注事件') +
      '；' + leg(b, '标杆台账', '推了 ' + ((b.acSent || 0) + (b.poSent || 0)) + ' 行事件，水位到第 ' +
        (((b.wm && b.wm.ac) || 0) + '/' + ((b.wm && b.wm.po) || 0)) + ' 行') +
      '；' + leg(lib, '抓取档案', '推了 ' + (lib.auSent || 0) + ' 个账号、' + (lib.poSent || 0) + ' 条帖子' +
        (lib.capped ? '（还有存量，后台会接着推）' : '')) +
      '；' + leg(bl, '拉黑台账', '推了 ' + (bl.sent || 0) + ' 行事件，水位到第 ' + (bl.wm || 0) + ' 行');
  }
  function doCloudLogin() {
    const email = String(($('cloudEmail') && $('cloudEmail').value) || '').trim();
    const code = String(($('cloudCode') && $('cloudCode').value) || '').trim();
    const st = $('modeStat');
    // 空着点「登录」：走「发验证码」那同一条规矩 —— 当场点名填哪一格，不把 SW 那句「格式不对」转述出去
    if (!email || !code) {
      const noMail = !email;
      if (st) { st.className = 'mStat warn'; st.textContent = '先在「' + (noMail ? '邮箱' : '验证码') + '」那一格填上（' +
        (noMail ? '形如 name@example.com' : '邮箱里收到的那串数字，先点「发验证码」') + '）'; }
      noteSet('登录没成：「' + (noMail ? '邮箱' : '验证码') + '」那一格是空的', 'warn');
      const el = $(noMail ? 'cloudEmail' : 'cloudCode');
      if (el) el.focus();
      return Promise.resolve();
    }
    if (loginBusy) return Promise.resolve();
    loginBusy = Date.now();
    // 这一句必须写在发命令之前：登录成功后后台要当场把两本账推出去，云端慢的时候这一趟要等十几秒，
    // 弹窗在这段时间里若不说话就又成了「点了没反应」（docs/UIX.md D-4/D-13）
    if (st) { st.className = 'mStat'; st.textContent = '正在登录……登上了就当场把本机这三本账各推一趟（指标与关注台账 / 标杆台账 / 抓取档案），云端慢的话要等十几秒'; }
    return send({ t: 'cloudLogin', email: email, code: code }).then((r) => {
      loginBusy = 0;
      if (!r.ok) {
        if (st) { st.className = 'mStat bad'; st.textContent = '登录没成：' + (r.err || '没回话'); }
        noteSet('登录没成：' + (r.err || '没回话'), 'bad');
        return r;
      }
      if ($('cloudCode')) $('cloudCode').value = '';
      cloudCdEnd = 0;
      // 登录成功 = 模式真的切过去了（SW 那句把 on 一起置 true），弹窗使命完成，关掉回设置页
      closeModal();
      noteSet('已登录 ' + email + (r.nick ? '（昵称 ' + r.nick + '）' : '') + '：' + firstPushText(r.firstPush),
        (r.firstPush && r.firstPush.metrics && r.firstPush.metrics.ok && r.firstPush.bench && r.firstPush.bench.ok
          && r.firstPush.library && r.firstPush.library.ok && r.firstPush.block && r.firstPush.block.ok) ? 'ok' : 'warn');
      return cloudRefresh();
    });
  }
  function doCloudOut() {
    if (logoutArm && Date.now() - logoutArm < ARM_MS) {
      logoutArm = 0;
      return send({ t: 'cloudLogout' }).then(() => {
        noteSet('已退出登录：token 与登录态都抹掉了（本机台账与 xprobe.db 一个字没动）', 'ok');
        return cloudRefresh();
      });
    }
    logoutArm = Date.now();
    syncModeModal();
    return Promise.resolve();
  }
  function doCloudSync() {
    return send({ t: 'cloudSyncNow' }).then((r) => {
      noteSet(r.ok ? (r.empty ? '云端确认过：本地还没有可同步的数据' : '已上送（见「上送状态」那一行）')
        : '上送没成：' + (r.err || '没回话'), r.ok ? 'ok' : 'bad');
      return cloudRefresh();
    });
  }

  // ---------- 标杆同步（v0.9.7）：本机标杆台账的增量事件行 → 用户自己的 boot4 Java 库（api2.mingzhang.cc）----------
  // 用的是「运行模式」那同一个登录态：静态密钥只答得出「有钥匙」，答不出「谁标的、哪台设备标的」，v0.9.7 起退场。
  // 服务端落三层里的前两层（私有账层 + 实体层），后台人工策展那两张表插件不碰。
  // 面板不回显 token，只显示「登录到哪个邮箱 + 水位到台账第几行 + 上次同步的结果」。
  let xsSt = null;
  function xsRefresh() {
    return send({ t: 'xsyncState' }).then((r) => {
      xsSt = r && r.ok ? r : null;
      syncXsUI();
      return r;
    });
  }
  function xsStatText(s, conf) {
    // 两档各推各的（地址与登录态都按档存），所以每一句都要说清「这一趟是哪档」——
    // 不然切到 dev 之后看到「没登录」，人会以为线上的登录态丢了
    const where = conf && conf.base ? ('（' + (conf.env === 'dev' ? '本机 dev' : '线上') + ' ' + conf.base + '）') : '';
    if (!conf || !conf.logged) return '没登录：上面「运行模式」切到云端并登录，才会推标杆' + where + '（本机台账照常记，一条不丢）';
    if (!s || !s.at) return '登录好了：还没同步过——点「立即推标杆」把水位之后的事件行推过去（含移出的墓碑行）' + where;
    const t = new Date(s.at).toLocaleTimeString();
    if (s.needLogin) return '登录态失效：重新登录一次（' + t + '）';
    if (!s.ok) return '上次没成：' + (s.err || '没回话') + '（' + t + '）';
    if (s.empty) return '上次 ' + t + '：对面确认过，水位之后没有新事件行（增量没动）';
    return '上次 ' + t + '：发 账号 ' + (s.acSent == null ? '?' : s.acSent) + ' / 帖 ' + (s.poSent == null ? '?' : s.poSent) +
      ' 行，新落流水 ' + (s.acNew == null ? '?' : s.acNew) + ' / ' + (s.poNew == null ? '?' : s.poNew) + ' 条' +
      ((s.acDrop || s.poDrop) ? ('，脏行丢 ' + (s.acDrop || 0) + ' / ' + (s.poDrop || 0)) : '') +
      (s.capped ? '，这批顶到 500 行上限（剩下的下次接着推）' : '');
  }
  function syncXsUI() {
    const conf = (xsSt && xsSt.conf) || {};
    const wm = (xsSt && xsSt.wm) || { ac: 0, po: 0 };
    const w = $('xsWm');
    if (w) w.textContent = '水位（' + (conf.env === 'dev' ? '本机 dev' : '线上') + '）：账号 ' + wm.ac + ' / 帖子 ' + wm.po +
      '（台账行号，服务端回了 ack 才抬；两档各存一本，换档不继承）' + (conf.email ? '　·　登录 ' + conf.email : '');

    const stat = $('xsStat');
    if (stat) stat.textContent = xsStatText(xsSt && xsSt.stat, conf);
  }
  function doXsRun() {
    return send({ t: 'xsyncRun' }).then((r) => {
      const d = r.data || {};
      const okText = r.empty ? '对面确认过：水位之后没有新事件行，一个字节没发'
        : ('已推过去：账号 ' + (d.acRecv == null ? '?' : d.acRecv) + ' 行（新落流水 ' + (d.acNewMark == null ? '?' : d.acNewMark) + '）、' +
            '帖子 ' + (d.poRecv == null ? '?' : d.poRecv) + ' 行（新落流水 ' + (d.poNewMark == null ? '?' : d.poNewMark) + '）；' +
            '水位 → 账号 ' + (d.ackAc == null ? '?' : d.ackAc) + ' / 帖 ' + (d.ackPo == null ? '?' : d.ackPo) +
            (d.capped ? '（这批到了 500 行顶，剩下的下次接着推）' : '') +
            (r.stalled ? '（服务端没给 ack，水位原地不动：下次整批重推，唯一键去重不会重）' : '') +
            (r.wmWarn ? '（' + r.wmWarn + '）' : ''));
      noteSet(r.ok ? okText : ((r.needLogin ? '登录态没认上：' : '同步没成：') + (r.err || '没回话')), r.ok ? 'ok' : 'bad');
      return xsRefresh();
    });
  }

  // ---------- 抓取档案同步（v0.10.6）：登录后自动把抓到的账号/帖子推到自家 Java 库，这颗钮只是兜底 ----------
  let libSt = null;
  function libRefresh() {
    return send({ t: 'libState' }).then((r) => {
      libSt = r && r.ok ? r : null;
      syncLibUI();
      return r;
    });
  }
  function libStatText(s, conf) {
    const where = conf && conf.base ? ('（' + (conf.env === 'dev' ? '本机 dev' : '线上') + ' ' + conf.base + '）') : '';
    if (!conf || !conf.logged) return '没登录：上面「运行模式」切到云端并登录后会**自动**推，本机档案照常记' + where;
    if (!s || !s.at) return '登录好了：还没推过——抓到一个新页面后 20 秒会自动推，也可以点右边这颗兜底' + where;
    const t = new Date(s.at).toLocaleTimeString();
    if (!s.ok) return '上次没成：' + (s.err || '没回话') + '（' + t + '）';
    if (s.done) return '上次 ' + t + '：水位之后没有新档案（增量没动）';
    return '上次 ' + t + '：账号 ' + (s.auSent || 0) + ' 个、帖子 ' + (s.poSent || 0) + ' 条' +
      (s.capped ? '；还有存量，后台会接着推' : (s.done ? '（已追平）' : ''));
  }
  function syncLibUI() {
    const conf = (libSt && libSt.conf) || {};
    const wm = (libSt && libSt.wm) || { au: 0, po: 0 };
    const w = $('libWm');
    if (w) w.textContent = '水位（' + (conf.env === 'dev' ? '本机 dev' : '线上') + '）：账号 ' + wm.au + ' / 帖子 ' + wm.po +
      '（store 表行号，服务端回了 ack 才抬；两档各存一本）';
    const stat = $('libStat');
    if (stat) stat.textContent = libStatText(libSt && libSt.stat, conf);
    const cnt = $('libCount');
    if (cnt) cnt.textContent = libCountText();
    syncLibStatsModal();
  }
  function doLibRun() {
    return send({ t: 'libSyncNow' }).then((r) => {
      const b = (r && r.block) || {};
      const blText = b.ok === false && b.err ? ('；拉黑那条腿没成：' + b.err) : ('，拉黑 ' + (b.sent || 0) + ' 条');
      const okText = r.done ? ('已追平：这一趟推了账号 ' + (r.auSent || 0) + ' 个、帖子 ' + (r.poSent || 0) + ' 条' + blText + '，水位之后没有新的了')
        : ('已推 ' + (r.batches || 0) + ' 批：账号 ' + (r.auSent || 0) + ' 个、帖子 ' + (r.poSent || 0) + ' 条' + blText +
            (r.capped ? '（顶到批数上限，剩下的 1 秒后自动接着推）' : ''));
      noteSet(r.ok ? okText : ('档案同步没成：' + (r.err || '没回话')), r.ok ? 'ok' : 'bad');
      return libRefresh();
    });
  }

  // ---------- 同步进度弹窗（v0.10.7）：本地 ⇄ Java 库 逐项对账 ----------
  // 用户要的是「点开就知道本地有多少、推上去多少、还差多少、云端那儿有多少」。
  // 不另立同步记录库：能答「推到第几行」的只有水位（libWM.<env>.<acct>），
  // 本地总数 / 已推条数由本机库两条统计查询现算（lib_user_stat / lib_post_stat，各自按业务键去重）。
  // 云端那两列只能是**全库**计数：共享实体层没有「这条属于谁」的列 ⇒ 标题必须写「云端全库」；
  // 评论本机压根没采集正文（只记了每条帖的回复数），这里也必须如实写「未采集」，不拿 0 冒充。
  let libStatsSt = null, libStatsBusy = 0;
  function fmtN(v) { return v == null ? '—' : Number(v).toLocaleString('zh-CN'); }
  // 设置页那行的摘要：优先用这次现算的，没有就用 SW 缓存的那一份（打开面板不为此多起两个宿主进程）
  function libStatsSrc() { return libStatsSt || (libSt && libSt.stats) || null; }
  function libCountText() {
    const st = libStatsSrc();
    if (!st) return '点右边核对：本地 / 已推 / 待推 / 云端各多少';
    if (st.ok === false) return '上次核对没成：' + (st.err || '没回话') + '（点右边可重试）';
    const loc = st.local || {};
    const au = loc.au || { total: 0, synced: 0, pending: 0 }, po = loc.po || { total: 0, synced: 0, pending: 0 };
    const blk = st.block || null;
    const bl = (blk && blk.local) || { total: 0, synced: 0, pending: 0 };
    const pend = (au.pending || 0) + (po.pending || 0) + (bl.pending || 0);
    const at = st.at ? new Date(st.at).toLocaleTimeString() : '';
    return '本地账号 ' + fmtN(au.total) + ' / 帖子 ' + fmtN(po.total) + ' · ' + (pend ? ('待推 ' + fmtN(pend) + ' 条')
      : '已全部同步') + (st.logged ? '' : '（没登录：一条都没上云）') + (at ? '（' + at + ' 核对）' : '');
  }
  function openLibStatsModal() {
    const body = $('setModalBody');
    if (!body || !openModalShell('lib', '同步进度 · 本地 ⇄ Java 库')) return;
    body.textContent = '';
    const mk = (cls, tag, txt) => { const e = document.createElement(tag || 'div'); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const stat = mk('mStat'); stat.id = 'lsState';
    const tbl = document.createElement('table'); tbl.className = 'syncTbl';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['类型', '本地', '已推', '待推', '云端全库'].forEach((h) => hr.append(mk('', 'th', h)));
    thead.append(hr);
    const tbody = document.createElement('tbody');
    const row = (label, pre) => {
      const tr = document.createElement('tr');
      tr.append(mk('', 'td', label));
      ['Total', 'Synced', 'Pending', 'Cloud'].forEach((k) => {
        const td = mk('', 'td'); td.id = 'ls' + pre + k; td.textContent = '—';
        tr.append(td);
      });
      tbody.append(tr);
    };
    row('账号', 'Au');
    row('帖子', 'Po');
    // v0.11.0：拉黑台账也上云（blocks 表 → xprobe_block）；这一行的「云端」列是**你自己**还在名单上的条数，
    // 不是全库 —— 拉黑是私有账，服务端按 userId 数，不会也不该把别人的条数拿给你看。
    row('拉黑', 'Bl');
    const cm = document.createElement('tr');
    cm.append(mk('', 'td', '评论'));
    const cmTd = mk('', 'td', '未采集'); cmTd.colSpan = 4;
    cm.append(cmTd);
    tbody.append(cm);
    tbl.append(thead, tbody);
    const acts = mk('mRow');
    const run = mk('mPri', 'button', '立即全量同步');
    const re = document.createElement('button'); re.type = 'button'; re.textContent = '重新核对';
    acts.append(run, re);
    const note = mk('mTip');
    note.id = 'lsNote';
    note.textContent = '「已推」= 本机水位之内（服务端回了 ack 才抬）；「待推」= 本地总数减已推，点「立即全量同步」就推。'
      + '「云端全库」账号/帖子那两行是共享实体层 x_probe_account / x_probe_post 的总行数（全平台所有设备一起写进去的），'
      + '不是「你的」条数——那两张表没有归属列；「拉黑」那行的云端列相反，是**你自己**在 xprobe_block 里还挂在名单上的人数（私有账）。'
      + '评论本机只记了每条帖的回复数，正文从未采集，所以写「未采集」。';
    body.append(stat, tbl, acts, note);
    run.addEventListener('click', () => doLibRun().then(() => refreshLibStats()));
    re.addEventListener('click', () => refreshLibStats());
    syncLibStatsModal();
    refreshLibStats();
  }
  // 建一次、之后只更新（D-11）：节点不重建，只换字面与颜色
  function syncLibStatsModal() {
    if (modalKind !== 'lib') return;
    const st = libStatsSrc();
    const conf = (libSt && libSt.conf) || {};
    const last = libSt && libSt.stat;
    const set = (id, txt, cls) => {
      const el = $(id); if (!el) return;
      if (el.textContent !== txt) el.textContent = txt;
      if (cls != null && el.className !== cls) el.className = cls;
    };
    if (!st) {
      set('lsState', '还没核对过：下面「重新核对」现算一次', 'mStat');
      return;
    }
    if (st.ok === false) {
      set('lsState', '核对没成：' + (st.err || '没回话'), 'mStat bad');
      return;
    }
    const loc = st.local || {};
    const au = loc.au || { total: 0, synced: 0, pending: 0 }, po = loc.po || { total: 0, synced: 0, pending: 0 };
    const blk = st.block || null;
    const bl = (blk && blk.local) || { total: 0, synced: 0, pending: 0 };
    const where = '（' + (conf.env === 'dev' ? '本机 dev' : '线上') + ' ' + ((conf.base || st.base) || '?') + '）';
    const pend = (au.pending || 0) + (po.pending || 0) + (bl.pending || 0);
    const who = conf.logged ? ('已登录 ' + (conf.email || '?') + where) : ('没登录' + where + '：本地档案只进本机库，云上一行不会有');
    const blkLast = st.blockLast && st.blockLast.at ? st.blockLast : null;
    const push = (last && last.at ? ('最近一次推送 ' + new Date(last.at).toLocaleTimeString() + '：' +
      (last.ok ? ('发账号 ' + (last.auSent || 0) + ' / 帖子 ' + (last.poSent || 0) + ' 条' + (last.done ? '（已追平）' : '')) : ('没成：' + (last.err || '没回话'))))
      : '还没推过')
      + (blkLast ? ('；拉黑推送 ' + (blkLast.ok ? ('发 ' + (blkLast.sent || 0) + ' 条' + (blkLast.done ? '（已追平）' : '')) : ('没成：' + (blkLast.err || '没回话')))) : '');
    set('lsState', who + '\n' + push + '\n' + (pend ? ('还有 ' + fmtN(pend) + ' 条待推：点下面「立即全量同步」') : '本地每一条都已推到（待推 0）'),
      'mStat' + (pend && conf.logged ? ' warn' : ' ok'));
    set('lsAuTotal', fmtN(au.total), '');
    set('lsAuSynced', fmtN(au.synced), '');
    set('lsAuPending', fmtN(au.pending), (au.pending ? 'pend' : ''));
    set('lsPoTotal', fmtN(po.total), '');
    set('lsPoSynced', fmtN(po.synced), '');
    set('lsPoPending', fmtN(po.pending), (po.pending ? 'pend' : ''));
    const cloud = st.cloud;
    set('lsAuCloud', cloud ? fmtN(cloud.au) : (st.logged ? '—' : '未登录'), 'cloud');
    set('lsPoCloud', cloud ? fmtN(cloud.po) : (st.logged ? '—' : '未登录'), 'cloud');
    set('lsBlTotal', fmtN(bl.total), '');
    set('lsBlSynced', fmtN(bl.synced), '');
    set('lsBlPending', fmtN(bl.pending), (bl.pending ? 'pend' : ''));
    set('lsBlCloud', cloud && cloud.bl != null ? fmtN(cloud.bl) : (st.logged ? '—' : '未登录'), 'cloud');
  }
  function refreshLibStats() {
    if (libStatsBusy) return Promise.resolve(libStatsSt);
    libStatsBusy = Date.now();
    const state = $('lsState');
    if (state) {
      state.className = 'mStat';
      state.textContent = '核对中：读本机两条统计 + 问一次云端计数…';
    }
    return send({ t: 'libStats' }).then((r) => {
      libStatsBusy = 0;
      libStatsSt = r || null;
      syncLibStatsModal();
      syncLibUI();
      return r;
    });
  }

  const B = {
    bCollect: () => cmd('collect'),
    bFlush: () => cmd('flush'),
    bExport: () => doExport(),
    bSample: () => cmd('sample'),
    bDbRefresh: () => fetchDb(true),
    bPing: () => cmd('ping'),
    bStats: () => cmd('stats'),
    bQuery: () => doQuery(),
    // 低频工具归设置页：深挖/抓整页是排障动作，重算与清空是维护动作
    bProbe: () => cmd('probe'),
    bDumpOnce: () => cmd('dumpOnce'),
    bDump: () => cmd('setDump', !(st && st.dump && st.dump.on)),
    bHtml: () => cmd('setDumpHtml', !(st && st.dump && st.dump.html)),
    // v0.8.9：页面内那颗「拉黑」徽标的闸。v0.8.16 起默认开（用户点名「改成默认显示」）；core 每次判都现读 GM，所以设置里拨一下就全标签页同频，
    // 且关的那一刻就把已缝进页面的节点摘干净（不用等下一个心跳）。
    bBadge: () => cmd('setBadge', !(st && st.badge && st.badge.on)),
    bDebug: () => {
      const on = !(st && st.debug && st.debug.on);
      return cmd('setDebug', on).then(() => { if (on) setView('debug'); });
    },
    bRebuild: () => cmd('rebuild').then((r) => {
      if (!r.ok || !r.result) return;
      const x = r.result;
      noteSet('已按新规则重算：快照 ' + x.runs + ' 份 → users ' + x.users + ' / posts ' + x.posts +
        '（最后一次采集排除推荐位 ' + x.skipped + ' 行' + (x.bad ? '，坏快照 ' + x.bad : '') + '）', 'ok');
    }),
    bClear: () => {
      // 两下才动手（D-7，v0.10.1 起这颗也归入）：第一下只把「会清掉什么」写出来，60 秒内第二下才真发命令。
      if (clearArm && Date.now() - clearArm < ARM_MS) {
        clearArm = 0;
        return cmd('clear').then((r) => {
          noteSet(r.ok ? '已清空：浏览器侧运行态与两张表都清了（本机 xprobe.db 档案库一个字没动）'
            : ('清空没成：' + (r.err || '没回话')), r.ok ? 'ok' : 'bad');
          return r;
        });
      }
      clearArm = Date.now();
      noteSet('「清空」先不下手：这会清掉浏览器侧的运行态与 users/posts 两张表（本机 xprobe.db 档案库不动）。60 秒内再点一次这颗钮才真清', 'warn');
      syncButtons();
      return Promise.resolve();
    },
    // 从本机库回填：面板只读浏览器存储、不读 xprobe.db，所以直接写进库的历史（backfill_days.py）要靠这步才看得见
    bRestore: () => cmd('impRestoreDb').then((r) => {
      const x = (r && r.result) || {};
      if (!r.ok || x.ok === false) {
        noteSet('回填没成：' + ((x && x.err) || r.err || '没回包（sink 没在跑？双击 start-sink.bat）'), 'bad');
        return;
      }
      noteSet('本机库读了 ' + x.rows + ' 行（' + x.handles + ' 人）→ 写回 ' + x.wrote + ' 天、同值跳过 ' + x.same + ' 天' +
        (x.bad ? '、缺 handle/日期 ' + x.bad + ' 行' : '') +
        '（一次最多读 ' + x.limit + ' 行，人多/天多就再点一次；同日按列合并，库里空着的列不抹掉已有的数）',
        x.wrote ? 'ok' : 'warn');
    }),
    vHome: () => setView('home'),
    vMine: () => setView('mine'),
    vPlaza: () => setView('plaza'),
    vFc: () => setView('forecast'),
    // 切进诊断顺手把「这一眼看见的东西」落一份 kind=debug 进本机日志（下一轮迭代对表用）
    vDebug: () => { setView('debug'); return cmd('debugRec'); },
    bRndSet: () => doRndSet(),
    bGoalSet: () => doGoalSet(),
    bOwnSet: () => doOwnSet(),
    bCloud: () => openModeModal(),   // 只开弹窗，不改状态；发码/登录/退出都在弹窗里挂（v0.9.8）
    bCloudEnv: () => openEnvModal(), // 同上：这颗也只开弹窗，换档是在弹窗里点中某一格那一刻才写
    bCloudSync: () => doCloudSync(),
    bRetrySet: () => doRetrySet(),
    bXsRun: () => doXsRun(),
    bLibRun: () => doLibRun(),
    bLibStats: () => openLibStatsModal(),   // 只开弹窗，核对是在弹窗打开那一刻现算（v0.10.7）
    // 本机文件与清理：三枚动作钮都是「先 DRY 回显、60 秒内再点一次才实删」，删哪个文件由本机白名单定
    bFsRefresh: () => fsRefresh(true),
    bFsKeep: () => fsSetKeep(),
    bFsAuto: () => fsAuto(),
    bCleanLogs: () => fsClean('logs'),
    bCleanDump: () => fsClean('dump'),
    bVacuum: () => fsVacuum(),
    // 本机模型（v0.11.4）：这颗闸是这条腿的唯一发令枪（默认关），改配置只写存储，测活才真发一趟
    bModelOn: () => doModelGate(),
    bModelEdit: () => openModelModal(),
    bModelTest: () => doModelTest(),
    vSet: () => { setView('set'); fsRefresh(); return Promise.all([cloudRefresh(), xsRefresh(), libRefresh(), modelRefresh()]); },
  };
  Object.keys(B).forEach((id) => { if (B[id]) { const b = $(id); if (b) b.addEventListener('click', B[id]); } });
  $('q').addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doQuery(); });
  $('rndMax').addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doRndSet(); });
  $('rndMax').addEventListener('input', () => { rndDirty = true; });
  $('ownSet').addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doOwnSet(); });
  $('ownSet').addEventListener('input', () => { ownDirty = true; });
  $('fsKeep').addEventListener('keydown', (e) => { if (e && e.key === 'Enter') fsSetKeep(); });
  $('fsKeep').addEventListener('input', () => { fsDirty = true; });
  $('retryMin').addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doRetrySet(); });
  $('retryMin').addEventListener('input', () => { retryDirty = true; });
  // 今日目标那两格以前只能拿手去点「应用」（同页另四格都有回车）—— D-12 补齐
  ['goalBase', 'goalTarget'].forEach((id) => {
    const e = $(id);
    if (e) e.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Enter') doGoalSet(); });
  });
  // 设置页的 ❓ 与弹窗接线（v0.9.8）：❓ 由 .secFold 生成（少写一行 html 也不会漏入口）；
  // 弹窗关法三种 —— 点 ×、点遮罩、Esc。都是「取消」，不改任何状态。
  wireSetHelp();
  const modShell = $('setModal');
  if (modShell) {
    modShell.addEventListener('click', (e) => { if (e.target === modShell) closeModal(); });
    const mx = $('setModalX'); if (mx) mx.addEventListener('click', closeModal);
  }
  document.addEventListener('keydown', (e) => {
    if (!e || e.key !== 'Escape') return;
    // 两条弹窗各归各的状态：setModal 看 modalKind，广场作者框看 tlUser。
    // 以前只关前者，于是「三条关法齐」对作者框是空话（docs/UIX.md UIX-19，RL-20 ③ 的那句也一并补齐）。
    if (modalKind) closeModal();
    else if (tlUser) closeTlUser();
  });
  const extIdBoot = (chrome.runtime && chrome.runtime.id) || '';
  const extLine = $('extIdLine');
  if (extLine) extLine.textContent = extIdBoot ? '扩展 ID ' + extIdBoot + '（装宿主要用它；命令在 ❓ 里）' : '读不到扩展 ID（面板不是扩展页面？）';
  $('tabPick').addEventListener('change', () => { refreshState(); refreshTabs(); });
  $('whoPick').addEventListener('change', () => { whoSel = $('whoPick').value || ''; return applyWho(); });

  refreshTabs();
  refreshState();
  cloudRefresh();
  xsRefresh();
  libRefresh();
  // 面板开着的时候 900ms 回读一次：守卫计数、sink 待发数、转储预算都是页面那边在变的。
  // 只在可见时轮询，隐藏就停 —— 不做后台常驻，免得给自己添一个「扩展一直在动」的痕迹。
  // 广场不跟 900ms：两张榜一次 200 行，每 0.9 秒重建一遍会把面板拖死。它走下面那条 30 秒的库轮询，
  // 外加用户动作（切人 / 补录 / 进页）之后的 render —— 不够新鲜时点「重读库」。
  setInterval(() => { if (!document.hidden && view !== 'plaza') refreshState(); }, 900);
  setInterval(coolTick, 1000);   // 冷却倒计时的秒数：本地走，不为此多问页面一次
  setInterval(() => { if (!document.hidden) refreshTabs(); }, 7000);   // 新开的标签页要能选到
  // 广场的库榜 30 秒刷一次（只在广场且可见时）：每次查询都起一个宿主进程，不能跟着 900ms 轮询走。
  // 顺手回读一次 state：日点表那张仍是浏览器运行态，别让它停在进页那一刻。
  setInterval(() => { if (!document.hidden && view === 'plaza') { refreshState(); fetchDb(); } }, 30000);
  // 共享台账一变就回读一次 state —— 这条不看当前是哪个视图：广场是 30 秒一轮，而冷却只有 60 秒起，
  // 等半分钟才翻红等于没翻。触发点是「别的标签页写下关注」那一瞬，与面板此刻问的是哪个标签页无关
  // （被问的那页可能正在后台被节流，它自己的节拍器根本还没跑）。一次关注会连写两三次，150ms 合成一轮。
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes['ysy.xprobe.guard']) return;
      if (document.hidden) return;
      clearTimeout(guardReload);
      guardReload = setTimeout(() => { guardReload = 0; refreshState(); }, 150);
    });
  } catch (e) { /* 没有 storage 事件的环境（自检/老版本）不影响其余功能 */ }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshState(); });
})();

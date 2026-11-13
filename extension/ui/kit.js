// X 观测探针 · UI 公共渲染层（kit.js，v0.12.14 · art-033）
// 高内聚：「行对象(k:line/row/chart/imps/rank/grid/hero/bar/fold) → DOM 节点」这一层只有这一份实现，
//         面板（sidepanel.js）与工作台（dashboard.js）共用；连 chrome.runtime 发送通道也在这里。
// 低耦合：本文件不认识 sidepanel/dashboard，也不认识 view.js 的格式化层（只在调用时经
//         globalThis.XPROBE_VIEW 取）——页面差异（页面名、重画、取数、state）全部由 create(deps) 注入。
// 分工：core.js 管判定，view.js 管「行对象长什么样」，kit.js 管「怎么画」，页面脚本管「画到哪、谁来点」。
// 红线继承：只画自家节点；RL-1 只展示；RL-11 缺数画 — 不编；节点画坏单条兜底不拖垮整页。
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';   // XML 标识符，不是要请求的地址
  const KIT_BUILD = '2026-11-13-e';

  function create(deps) {
    deps = deps || {};
    const pageLabel = String(deps.pageLabel || '面板');
    const render = deps.render || function () {};
    const fetchDb = deps.fetchDb || null;
    const one = deps.one || null;          // (q, limit, extra) => Promise<{ok, rows}>；只有广场/时间线用
    const getSt = deps.getSt || function () { return null; };

    // ---------- 发送通道：与 SW 的唯一入口（孤儿页面/休眠 SW 的处置话术按页面名参数化） ----------
    function send(msg) {
      return new Promise((res) => {
        try {
          chrome.runtime.sendMessage(msg, (reply) => {
            const e = chrome.runtime.lastError;
            if (e) {
              const m = String(e.message || e);
              // 插件 ⟳ 重载之后，重载前打开的这个页面是孤儿：内存里 state 还是旧的（看着一切正常），
              // 但 runtime 已经换了，每条消息都是 "Receiving end does not exist"——用户看起来就是「点了没反应」。
              // 必须点名怎么救，而不是让他们以为按钮坏了。
              const orphan = /Receiving end does not exist|Extension context invalidated|message port closed/i.test(m);
              res({ ok: false, err: orphan
                ? '插件刚重载过（⟳），这个' + pageLabel + '是旧副本：把它关掉重开（或重新点扩展图标）就好——旧' + pageLabel + '上看着有数的都是重载前的内存'
                : String(m).slice(0, 120) });
            } else res(reply || { ok: false, err: '扩展没响应（service worker 刚睡？再点一次）' });
          });
        } catch (e) {
          const m = String((e && e.message) || e).slice(0, 120);
          res({ ok: false, err: /Receiving end does not exist|Extension context invalidated/i.test(m)
            ? '插件刚重载过（⟳），这个' + pageLabel + '是旧副本：把它关掉重开（或重新点扩展图标）就好'
            : m });
        }
      });
    }

    // ---------- 榜/表排序与分页状态（v0.8.1-t/v0.8.2） ----------
    // render() 每次重建整棵树，存 DOM 上会被自己刷掉 ⇒ 全部存模块级闭包变量（面板/工作台各一份实例，互不串）。
    let rankSortBy = 'fans', rankAsc = false;
    let acctSort = 'views', postSort = 'view';
    let acctLimit = 10, postLimit = 10, rankLimit = 10;
    let tlDay = '', tlSrcf = '', tlLimit = 10, tlSort = 'view';

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
    // 单个节点画坏只兜住那一条，不拖垮整页（v0.7.1 起的纪律）
    function appendSafe(root, list) {
      (list || []).forEach((m) => {
        try { root.append(tick(m)); }
        catch (e) {
          root.append(lineNode({ k: 'line', text: '这一块没画出来（' + String((m && m.k) || '?') + '）：' + String((e && e.message) || e) }));
        }
      });
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
    function rowNode(m) {
      // 2026-11-13：行可以带一个自己的 class（通道状态行要单独一套皮肤：body.dash .row.dChan）
      const d = document.createElement('div'); d.className = 'row' + (m.cls ? ' ' + m.cls : '');
      const a = document.createElement('span'); a.textContent = m.label;
      const b = document.createElement('span'); b.textContent = m.value; if (m.sty) b.className = m.sty;
      if (m.title) d.title = m.title;
      d.append(a, b); return d;
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
      // view.chartSpec 给的 box.{r,b} 是右/下边界的坐标（不是留白宽度），所以宽高都取差并夹一道 ≥0：
      // 旧写法 s.w - box.r - box.l = 360 - 354 - 40 = -34，Chrome 直接抛负宽并把整次 render 打断。
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
    // 日线四列表（v0.8.1-i 两张拆表）：只读紧凑表恒显示；「编辑」弹独立小窗（chrome.windows.create，
    // 侧栏 ~360px 塞不下模态框——用户真机原话「太小了，很难使用」）。
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
    // 独立编辑窗：640×560 居中（getLastFocused 算坐标，算不出就让 Chrome 自己摆）
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
    // 跨人排名表（v0.6.11）：列头是按钮（点一次按该列降序，再点切升序）
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
      if (!rows.length) { const r = mk('div', 'impRow impView'); r.append(cell('(一个人都还没有 —— 先打开几个主页，或从本机库回填)')); g.append(r); }
      const fmt = (v, r, k) => {
        if (v == null) return '—';
        const dv = k === 'fow' ? r.dFow : (k === 'fans' ? r.dFans : (k === 'imp' ? r.dImp : r.dPosts));
        const sign = dv == null ? '' : (dv >= 0 ? ' +' : ' ') + dv;
        return globalThis.XPROBE_VIEW.nf(v) + sign;
      };
      rows.forEach((r) => {
        const tr = mk('div', 'impRow impView' + (r.own ? ' rankOwn' : '') + (r.stale ? ' stale' : ''));
        tr.append(cell(r.rank + (r.own ? ' *' : ''), r.own ? '这就是你自己在库里的 handle' : '@' + r.h + ' 的最新一行', 'giDay'),
          cell(r.h, '@' + r.h + (r.day ? '　最新一行 ' + r.day : '　还没有日点'), 'rkH'),
          cell(r.day || '-', r.at ? '这条序列最后写入时间戳 ' + new Date(r.at).toLocaleString() : '没有写入时间'),
          cell(fmt(r.imp, r, 'imp'), '曝光：只有自己的号能从奖励页读到，别人的主页 DOM 里根本没有这个数（空=读不到，不是 0）'),
          cell(fmt(r.fow, r, 'fow'), '关注' + (r.dFow == null ? '（只有一行，算不出净增）' : '：较上一行 ' + (r.dFow >= 0 ? '+' : '') + r.dFow)),
          cell(fmt(r.fans, r, 'fans'), '粉丝' + (r.dFans == null ? '（只有一行，算不出净增）' : '：较上一行 ' + (r.dFans >= 0 ? '+' : '') + r.dFans)),
          cell(r.posts == null ? '—' : globalThis.XPROBE_VIEW.nf(r.posts), r.posts == null ? '帖子数 X 的 DOM 里没有，只能手补' : '手工补录的帖子数'),
          cell((r.dFow == null && r.dFans == null ? '—' : (r.dFow == null ? '?' : (r.dFow >= 0 ? '+' : '') + r.dFow) + '/' + (r.dFans == null ? '?' : (r.dFans >= 0 ? '+' : '') + r.dFans)),
            '关注/粉丝 各较上一行的净增' + (r.prevDay ? '（上一行 ' + r.prevDay + '）' : '（他只有一行，算不出净增）')),
          cell(r.ageTxt, '这行数据多久没更新了（超过两天标灰：排名只比"还活着的人"）'));
        g.append(tr);
      });
      d.append(g);
      if (m.more > 0) d.append(moreBtnNode(m.more, () => { rankLimit += 10; render(); }));
      return d;
    }
    // 「更多」按钮（v0.8.1-t 榜分页共用）：k:'rank' 与两张 k:'grid' 的榜都走「先出 10 条、点了 +10」
    function moreBtnNode(left, onMore) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'rkHead moreBtn';
      b.textContent = '更多（还有 ' + left + ' 条，每次 +10）';
      b.title = '分页是给面板看的：几百行塞进 400px 侧栏既看不清也拖慢 900ms 刷新；换排序回到第一页；完整排名随时可以在库里查';
      b.addEventListener('click', onMore);
      return b;
    }
    // 点昵称的作者模态框（v0.8.2）：看谁（'' = 关着）、那条 author_posts 查询的回包与在途标志
    let tlUser = '', tlUserDb = null;
    function closeTlUser() { tlUser = ''; tlUserDb = null; render(); }
    function openTlUser(author) {
      if (!/^[A-Za-z0-9_]{1,20}$/.test(author || '')) return;
      if (!one) return;   // 没有取数通道的页面（面板）不开作者模态框
      tlUser = author; tlUserDb = null; render();
      one('author_posts', 200, { author: author }).then((res) => {
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
        const rows = globalThis.XPROBE_VIEW.tlUserRows(tlUserDb);
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
    // 本机库榜（k:'grid'）：列头带 sort key 的可点（只降序——榜问的是「谁最高」）；时间线榜走卡片（v0.8.6 用户裁定）。
    function gridNode(m) {
      const d = document.createElement('div'); d.className = 'imps dbgrid ' + (m.cls || '');
      const mk = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
      const cell = (txt, tip, c) => { const s = mk('span', c); s.textContent = txt == null ? '' : String(txt); if (tip) s.title = tip; return s; };
      const cap = mk('div', 'cap'); cap.append(cell(m.title || ''));
      // 标题右边的副信息（本次读回多少人 / 榜先出前 10 …）：工作台横排成一行，面板窄则另起一行
      if (m.capMeta) cap.append(cell(m.capMeta, '', 'capMeta'));
      d.append(cap);
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
        sel.addEventListener('change', () => { tlDay = sel.value; tlLimit = 10; if (fetchDb) fetchDb(true); });
        bar.append(sel);
        [['', '全部'], ['foryou', '为你推荐'], ['following', '正在关注']].forEach(([k, lab]) => {
          const b = mk('button', 'rkHead' + (m.srcf === k ? ' on' : '')); b.type = 'button'; b.textContent = lab;
          b.addEventListener('click', () => { tlSrcf = k; tlLimit = 10; render(); });
          bar.append(b);
        });
        [['view', '曝光'], ['reply', '评论']].forEach(([k, lab]) => {
          const b = mk('button', 'rkHead' + ((m.sort || 'view') === k ? ' on' : '')); b.type = 'button'; b.textContent = lab;
          b.title = '按' + lab + '排（降序）';
          b.addEventListener('click', () => { tlSort = k; tlLimit = 10; render(); });
          bar.append(b);
        });
        d.append(bar);
      }
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
          // 卡片本体是跳原帖的 <a>：昵称这一小块截住点击，开作者模态框（这是自家节点，不碰宿主 DOM）
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

    // ---------- 「我的」摘要框家族（v0.8.1-r/s）：节点复用 / 评论数按天记 / 剪贴板两段式 ----------
    let digestEl = null;
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
        copyText(globalThis.XPROBE_VIEW.mineReportText(getSt(), n), '日报已复制', '复制失败（请手动划选）', repBtn, '复制日报',
          () => { ta.value = globalThis.XPROBE_VIEW.mineReportText(getSt(), n); ta.focus(); ta.select(); const okd = document.execCommand('copy'); ta.value = text; return okd; });
      };
      rep.append(repl, repBtn);
      wrap.append(top, rep);
      digestEl = wrap;
      return wrap;
    }
    // 评论数按天记 chrome.storage.local（扩展自己的存储；UI 层红线禁页面 origin 存储）。
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

    return {
      KIT_BUILD, send, tick, appendSafe,
      lineNode, foldNode, rowNode, barNode, heroNode, chartNode,
      impsNode, openEditorWindow, rankNode, moreBtnNode, gridNode,
      openTlUser, closeTlUser, tlUserModalNode, tlUserActive: () => !!tlUser,
      digestBox, copyText,
      // 榜/表排序分页状态：只读出口 sorts() + 单点写入口 setTlDay（时间线选天重查要写回 kit 状态）
      sorts: () => ({ rankSortBy, rankAsc, acctSort, postSort, acctLimit, postLimit, rankLimit, tlDay, tlSrcf, tlLimit, tlSort }),
      setTlDay: (day) => { tlDay = String(day || ''); },
    };
  }

  globalThis.XPROBE_KIT = { create: create, KIT_BUILD: KIT_BUILD };
})();

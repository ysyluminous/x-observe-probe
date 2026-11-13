/* 工作台 · 概览页（v0.12.17 拆页）：只管 KPI 四格与首页行；状态/取数全走公共壳 XPROBE_DASH。 */
(function () {
  const D = globalThis.XPROBE_DASH;
  function kpiNode(api, lab, val, sub, sty, tip) {
    const d = document.createElement('div'); d.className = 'dKpi';
    if (tip) d.title = tip;
    const l = document.createElement('div'); l.className = 'dKpiLab'; l.textContent = lab;
    const v = document.createElement('div'); v.className = 'dKpiVal' + (sty ? ' ' + sty : ''); v.textContent = val;
    d.append(l, v);
    if (sub) { const s = document.createElement('div'); s.className = 'dKpiSub'; s.textContent = sub; d.append(s); }
    return d;
  }
  function renderKpis(api) {
    const $ = api.$, V = api.V, st = api.getState(), db = api.getDb(), src = api.getSrc();
    const box = $('dKpis');
    box.textContent = '';
    if (!st) { box.append(kpiNode(api, '通道', '—', '还没读到 state', 'dim', 'state 没回来：宿主/SW 没醒时点右上「刷新」')); return; }
    const lamp = $('dLamp');
    if (lamp) {
      if (api.out.err) { lamp.className = 'bad'; lamp.textContent = 'state 不通'; lamp.title = api.out.err; }
      else if (db && db.at) {
        lamp.className = (db.acct.ok || db.post.ok) ? 'ok' : 'bad';
        lamp.textContent = (src === 'cloud' ? '云端' : (db.native ? '宿主 Native' : 'HTTP sink')) + ' · ' + db.ms + 'ms';
        lamp.title = '最近一次读取：' + new Date(db.at).toLocaleTimeString() + (db.acct.err ? '\n账号榜：' + db.acct.err : '') + (db.post.err ? '\n帖子榜：' + db.post.err : '');
      } else { lamp.className = 'warn'; lamp.textContent = '库还没读'; lamp.title = '点「刷新」或切到广场会读一次'; }
    }
    const upd = $('dUpdatedAt');
    if (upd) upd.textContent = api.getLastStateAt() ? '更新于 ' + new Date(api.getLastStateAt()).toLocaleTimeString() : '';
    // ① 未回关（follow_back=no；unknown 是没读到，不算）
    let fbNo = null, fbUn = null;
    if (db && db.followStarts && db.followStarts.ok) {
      fbNo = db.followStarts.rows.filter((r) => r && r.follow_back === 'no').length;
      fbUn = db.followStarts.rows.filter((r) => r && r.follow_back === 'unknown').length;
    }
    box.append(kpiNode(api, '未回关', fbNo == null ? '—' : String(fbNo),
      fbNo == null ? (src === 'cloud' ? '云端没回数' : '宿主不在或库里还没有') : (fbUn != null ? ('另有 ' + fbUn + ' 人状态未知（没读到 ≠ 没回关）') : ''),
      fbNo == null ? 'dim' : (fbNo > 0 ? 'bad' : 'ok'),
      '口径：最早一次主动关注后至今没在粉丝列表里见到 TA 的人（follow_starts，follow_back=no）。unknown 不混进来'));
    // ② 榜上账号
    const acctN = (db && db.acct && db.acct.ok) ? db.acct.rows.length : null;
    box.append(kpiNode(api, '榜上账号', acctN == null ? '—' : V.nf(acctN),
      acctN == null ? (src === 'cloud' ? '云端没回数' : '宿主不在') : 'accounts 查询返回的行数（上限 500）',
      acctN == null ? 'dim' : '', '口径：store_users 里每个 handle 最新一行'));
    // ③ 运行态序列点
    const cnt = (st && st.counts) || {};
    const ptN = (Number(cnt.min) || 0) + (Number(cnt.imp) || 0);
    box.append(kpiNode(api, '运行态序列点', cnt.handles == null ? '—' : V.nf(ptN),
      cnt.handles == null ? 'state 里没有 counts' : (V.nf(cnt.handles) + ' 人 · 分钟点 ' + V.nf(cnt.min || 0) + ' · 日点 ' + V.nf(cnt.imp || 0)),
      '', '口径：本浏览器内存里各账号序列的点数（state.counts）'));
    // ④ 今日关注进度
    const gb = V.goalBar(st);
    if (gb && gb.pct != null) {
      box.append(kpiNode(api, '今日关注', gb.pct + '%', gb.endLeftTxt || '', gb.sty === 'ok' ? 'ok' : '', gb.title || '与面板首页进度条同一本账'));
    } else {
      box.append(kpiNode(api, '今日关注', '—', '没设目标（去面板「设置 → 今日目标」）', 'dim', '基线 = 今天开屏「正在关注」；目标 = 今天要发的关注数'));
    }
  }
  function emptyNode(text) {
    const d = document.createElement('div'); d.className = 'dEmpty'; d.textContent = text; return d;
  }
  D.register('home', {
    needsDb: true,
    kpis: renderKpis,
    render: function (root, api) {
      const V = api.V, K = api.K, st = api.getState(), db = api.getDb();
      K.appendSafe(root, V.homeLines(st));
      if (db && (db.acct.ok || db.post.ok)) {
        const sug = V.dbSuggestLines(db);
        if (sug && sug.length) {
          const t = document.createElement('div'); t.className = 'chartTitle';
          t.textContent = '最该关注 / 取关（点进广场看全表）'; root.append(t); K.appendSafe(root, sug);
        }
      } else if (!st || !(st.series && st.series.min && st.series.min.length)) {
        root.append(emptyNode('还没有数据：装好原生宿主并打开几个 x.com 页面，数据才会进来'));
      }
    },
  });
})();

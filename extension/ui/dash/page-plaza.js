/* 工作台 · 广场页：两榜 + 时间线卡 + 「看谁」下拉；作者模态由公共壳统一挂。 */
(function () {
  const D = globalThis.XPROBE_DASH;
  D.register('plaza', {
    needsDb: true,
    render: function (root, api) {
      const $ = api.$, K = api.K, V = api.V;
      const wp = $('whoPick'); if (wp) wp.classList.remove('hide');
      const bar = document.createElement('div'); bar.className = 'bar';
      const b = document.createElement('button'); b.type = 'button'; b.id = 'bDbRefresh'; b.textContent = '重读库';
      b.title = '重新读两张榜（进广场会自动读；宿主/sink 刚起来时点它）';
      b.addEventListener('click', () => { api.resetDb(); api.fetchDb(true); });
      bar.append(b); root.append(bar);
      // v0.12.19（真机 2026-11-13）：plazaLines 整体兜底——任何取数/排版异常都兜成可见的「这一块出错」，
      // 不再让整页 #report 被清空后空白（appendSafe 只兜单块，兜不住 plazaLines 抛在 appendSafe 之前的异常）。
      try {
        K.appendSafe(root, V.plazaLines(api.getState(), Object.assign({ now: Date.now(), db: api.getDb() }, K.sorts())));
      } catch (e) {
        const d = document.createElement('div'); d.className = 'pre';
        d.textContent = '广场渲染被拦下（已避免整页空白）：' + String((e && e.message) || e);
        root.append(d);
      }
      api.syncWho();
    },
  });
})();

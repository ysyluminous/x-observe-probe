/* 工作台 · 诊断页：读数质量/通道 + 查表三键；查询结果存公共壳的 qKeep 由 render() 重放（UIX-18）。 */
(function () {
  const D = globalThis.XPROBE_DASH;
  function queryBarNode(api) {
    const bar = document.createElement('div'); bar.className = 'dQueryBar';
    const inp = document.createElement('input'); inp.type = 'text'; inp.id = 'dq';
    inp.placeholder = '查本地表：handle / 显示名 / 推文 ID / 正文关键词';
    inp.setAttribute('aria-label', '查本地表');
    const bq = document.createElement('button'); bq.type = 'button'; bq.textContent = '查表'; bq.id = 'dQueryGo';
    bq.title = '在本机浏览器台账里按关键词查（users/posts 两张表）';
    const bp = document.createElement('button'); bp.type = 'button'; bp.textContent = '测活'; bp.id = 'dPing';
    bp.title = '测一次本机 sink 是否活着（通道灯红的先来这儿）';
    const bs = document.createElement('button'); bs.type = 'button'; bs.textContent = '刷新计数'; bs.id = 'dStats';
    bs.title = '重读 SW 的记录计数';
    bq.addEventListener('click', () => {
      const q = (api.$('dq') && api.$('dq').value) || '';
      return api.send({ t: 'query', v: q }).then((r) => {
        const c = (r.result && r.result.counts) || {};
        const head = { k: 'line', text: '查询 "' + q + '"（users ' + c.users + ' / posts ' + c.posts + '）：' };
        const body = (r.ok && r.result) ? api.V.queryLines(r.result).slice().reverse()
          : [{ k: 'line', text: '查表没成：' + (r.err || '没回包') }];
        api.setQKeep([head].concat(body));
        api.render();
      });
    });
    bp.addEventListener('click', () => { api.send({ t: 'ping' }).then((r) => { api.out.err = r.ok ? '' : (r.err || '没回话'); api.render(); }); });
    bs.addEventListener('click', api.refreshState);
    bar.append(inp, bq, bp, bs);
    return bar;
  }
  D.register('debug', {
    needsDb: false,
    render: function (root, api) {
      api.K.appendSafe(root, api.V.debugLines(api.getState()));
      root.append(queryBarNode(api));
      const keep = api.getQKeep();
      if (keep) api.K.appendSafe(root, keep);
    },
  });
})();

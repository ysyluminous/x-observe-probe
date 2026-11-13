/* 工作台 · 我的页：工具条 + 日报摘要 + 三四列日线/日点表。 */
(function () {
  const D = globalThis.XPROBE_DASH;
  function toolbarNode(api) {
    const bar = document.createElement('div'); bar.className = 'bar';
    const mk = (id, txt, tip, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.id = id;
      b.textContent = txt; if (tip) b.title = tip;
      b.addEventListener('click', fn); bar.append(b); return b;
    };
    mk('bSample', '抓一个点', '在奖励页=读一次 90 天曝光数并落自己的日点；在别人主页=把这一屏的关注/粉丝落在页主名下',
      () => api.send({ t: 'sample' }).then((r) => { api.out.err = r.ok ? '' : (r.err || '没回话'); api.refreshState(); }));
    mk('bRestore', '从本机库回填', '把 xprobe.db 里「每人每天一行」的日点灌回浏览器存储',
      () => api.send({ t: 'impRestoreDb' }).then((r) => {
        const x = (r && r.result) || {};
        if (!r.ok || x.ok === false) { api.out.err = '回填没成：' + ((x && x.err) || r.err || '没回包（sink 没在跑？）'); api.render(); return; }
        api.setNote('本机库读了 ' + x.rows + ' 行（' + x.handles + ' 人）→ 写回 ' + x.wrote + ' 天、同值跳过 ' + x.same + ' 天' +
          (x.bad ? '、缺 handle/日期 ' + x.bad + ' 行' : '') + '（同日按列合并，库里空着的列不抹掉已有的数）');
        api.out.err = ''; api.render();
      }));
    return bar;
  }
  D.register('mine', {
    needsDb: false,
    render: function (root, api) {
      const st = api.getState();
      root.append(toolbarNode(api));
      root.append(api.K.digestBox(api.V.mineDigestText(st)));
      api.K.appendSafe(root, api.V.mineLines(st));
    },
  });
})();

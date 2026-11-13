/* 工作台 · 设置页（v0.12.16 起）：数据来源 / 云端档 / 登录；改动一律二次确认（确认弹窗在公共壳）。 */
(function () {
  const D = globalThis.XPROBE_DASH;
  function segRow(label, items, cur, onPick) {
    const row = document.createElement('div'); row.className = 'dSetRow';
    const lab = document.createElement('span'); lab.className = 'dSetLab'; lab.textContent = label;
    const seg = document.createElement('span'); seg.className = 'dSetSeg';
    items.forEach((it) => {
      const b = document.createElement('button'); b.type = 'button'; b.id = it.id;
      b.textContent = it.txt; b.title = it.tip || '';
      if (cur === it.val) b.className = 'on';
      b.addEventListener('click', () => { if (cur !== it.val) onPick(it.val); });
      seg.append(b);
    });
    row.append(lab, seg);
    return row;
  }
  D.register('set', {
    needsDb: false,
    render: function (root, api) {
      const conf = api.getConf();
      const logged = !!(conf && conf.logged);
      const box = document.createElement('div'); box.className = 'dSet';
      const h = document.createElement('div'); h.className = 'dSetH'; h.textContent = '数据源'; box.append(h);
      box.append(segRow('数据来源', [
        { val: 'cloud', id: 'dSrcCloud', txt: '云端', tip: '读智枢 Go：同名 POST 读口、参数与本地库一致，只换地址（红线 RL-33）' },
        { val: 'db', id: 'dSrcDb', txt: '本地库', tip: '读本机 xprobe.db：SW → 原生宿主（宿主不在时回退本机 HTTP sink）' },
      ], api.getSrc(), (v) => api.askConfirm('src', v,
        v === 'cloud' ? '切到云端：数据改读智枢 PG（本机 xprobe.db 一个字不动）。这一档要先登录。'
          : '切回本地库：数据改读本机 xprobe.db。切换后两边的榜单/名单各自独立。')));
      const envRow = segRow('云端档', [
        { val: 'prod', id: 'dEnvProd', txt: '线上', tip: 'zhishu.mingzhang.cc（前端智枢网关 → 服务器上的 Go 容器）' },
        { val: 'dev', id: 'dEnvDev', txt: '开发', tip: '本机 zhishu-web dev（localhost:3100）→ 本机 Go；两档连同一颗线上 PG，登录各存各的' },
      ], (conf && conf.env) || 'prod', (v) => api.askConfirm('env', v,
        '切到「' + (v === 'prod' ? '线上' : '开发') + '」档：换网关地址、用那一档自己的登录态；没登录过会先要你登录。'));
      if (api.getSrc() !== 'cloud') envRow.classList.add('dim');
      box.append(envRow);
      const h2 = document.createElement('div'); h2.className = 'dSetH'; h2.textContent = '登录'; box.append(h2);
      const loginRow = document.createElement('div'); loginRow.className = 'dSetRow';
      const loginLab = document.createElement('span'); loginLab.className = 'dSetLab';
      loginLab.textContent = logged ? ('已登录：' + ((conf && conf.email) || '') + '（' + ((conf && conf.label) || '') + '档）')
        : '这一档还没登录（云端读口要一把智枢自己的登录态）';
      const b = document.createElement('button'); b.type = 'button'; b.textContent = logged ? '退出登录' : '登录';
      b.addEventListener('click', () => {
        if (logged) api.askConfirm('logout', null, '退出「' + ((conf && conf.label) || '') + '」档的登录？退出后云端档读不到数，直到重新登录。');
        else api.openLogin();
      });
      loginRow.append(loginLab, b); box.append(loginRow);
      const note = document.createElement('div'); note.className = 'dSetNote';
      note.textContent = '口径：全插件只有 3 个 baseURL（本地 api / 智枢开发 / 智枢线上），地址写死在后台；dev 与线上连同一颗线上 PG；登录按档各存各的，切档不继承。';
      box.append(note);
      root.append(box);
    },
  });
})();

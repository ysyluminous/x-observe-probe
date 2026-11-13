/* X 观测探针 · Side Panel 的格式化层
 *
 * 单独一个文件、且不碰 DOM：这里只把 state 翻译成「要显示哪几行、什么颜色、悬停说什么」。
 * 油猴面板那 12 类行是我判断字段命中率的依据，形状原样搬过来；抽成纯数据后，
 * probe-selftest.js 不用 DOM 桩就能直接断言（面板怎么排版是另一回事，字段判不准才是事故）。
 */
(function () {
  'use strict';

  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function row(label, value, sty, title) { return { k: 'row', label: label, value: value, sty: sty || '', title: title || '' }; }
  function line(text, sty) { return { k: 'line', text: text, sty: sty || 'pre' }; }
  function fold(title, text) { return { k: 'fold', title: title, text: text }; }

  var POSTS_RE = /post|发帖|帖子|推文/i;
  var STAT_LABEL = { following: '正在关注', followers: '粉丝(/followers)', verified_followers: '关注者(/verified_followers)' };

  // 「本页还没采过」的引导压缩成两行（v0.6.9 起首页只答「我今天的数」，采集建议归趋势页叙事与 README）
  function pageHint() {
    return '本页还没采过：点「采集本页」。\n建议：开 3~5 个别人主页 + 2~3 条帖子详情页让点位热起来。';
  }

  // 精确值判定：可见文本常是「2.9万」这种缩写，aria-label 里往往是全量数字，两边都要看
  function statNote(o) {
    var exact = !!(o.visibleNum && o.visibleNum.exact === true);
    var ariaExact = !!(o.ariaNum && o.ariaNum.exact === true && o.ariaNum.value != null);
    if (ariaExact && (!exact || o.visibleNum.value !== o.ariaNum.value)) return 'aria 里有精确值';
    if (exact) return '可见文本即精确值';
    return '缩写，两边都不精确';
  }

  function statRow(name, o) {
    if (!o) return null;
    var exact = !!(o.visibleNum && o.visibleNum.exact === true);
    var ariaExact = !!(o.ariaNum && o.ariaNum.exact === true && o.ariaNum.value != null);
    return row(name,
      (o.visibleNum.value != null ? o.visibleNum.value : '-') + ' / aria ' + (o.ariaNum.value != null ? o.ariaNum.value : '-') + ' → ' + statNote(o),
      ariaExact || exact ? 'ok' : 'warn',
      'visible=' + o.visible + '\naria=' + o.ariaLabel + '\ntitle=' + o.title);
  }

  function srcText(c) {
    var s = (c || {}).src || {};
    var lab = { combinedAria: '聚合', singleAria: '独立', buttonAria: '按钮' };
    var keys = ['reply', 'repost', 'quote', 'like', 'view'];
    var out = keys.filter(function (k) { return s[k]; }).map(function (k) {
      return k + '=' + Object.keys(s[k]).map(function (f) { return (lab[f] || f) + s[k][f]; }).join('/');
    });
    return out.length ? out.join('  ') : '（这页没有带数的指标行）';
  }

  function sinkLine(st) {
    var s = st.sink || {}, q = s.q || {};
    // 通道（native/http）是 SW 报的：宿主生效没生效，这一行要能直接回答
    var chan = s.chan === 'native' ? 'Native' : s.chan === 'http' ? 'HTTP' : (s.chan || '');
    var cpre = chan ? '通道 ' + chan + ' · ' : '';
    if (s.ok === null || s.ok === undefined) return row('日志 sink 127.0.0.1:8765', '未测（点「测活」）', 'warn');
    if (s.ok) return row('日志 sink 127.0.0.1:8765',
      cpre + 'OK 已写 ' + s.posted + ' 条，待发 ' + s.qlen + (q.dropped ? ' 丢弃过 ' + q.dropped : '') + (q.adopted ? ' 认领 ' + q.adopted : '') +
      '，@' + clip(String(s.lastSinkAt || '').slice(11, 19), 8) + ' | build ' + st.build, 'ok',
      chan ? undefined : '通道路由没报上来（旧副本？⟳ 后重开面板）；正文照旧。');
    return row('日志 sink 127.0.0.1:8765', cpre + '断开 ' + dur(s.downMs || 0) + '，内存待发 ' + s.qlen + ' 条 · 已落盘 ' + (q.count || 0) + ' 条（' + mb(q.bytes || 0) + '）：' + clip(s.err, 60), 'bad',
      '断线期间记录先落进扩展存储的 ysy.xprobe.queue（只存精简快照，单格顶 ' + (q.max || 120) + ' 条 / ' + mb(q.byteCap || 614400) + '），' +
      '刷新页面也不会丢：下一个开页面的标签页会认领这格并补发。\n丢过 ' + (q.dropped || 0) + ' 条（顶到上限才丢，丢的是最旧的）。\n' +
      (q.err ? '落盘报错：' + clip(q.err, 80) : '落盘没有报错。') + '\n浮标变红描边也是这件事的信号。');
  }
  function guardLine(st) {
    var s = st.guard || {};
    var bad = !!s.over15 || !!s.over24;
    var free = bad
      ? (s.over15 ? Math.max(1, Math.ceil((s.free15 || 0) / 60000)) + ' 分钟后腾出 15 分钟位'
        : (Math.round((s.free24 || 0) / 360000 * 10) / 10) + ' 小时后腾出 24 小时位')
      : '';
    var v = '15分钟 ' + s.f15 + '/' + s.max15 + '  24小时 ' + s.f24 + '/' + s.max24 +
      (s.u24 ? '  取关流水 ' + s.u24 : '') + (free ? '  ' + free : '') + (s.watching ? '' : '  [observer 未起来]');
    return row('关注守卫(滚动窗口)', s.err ? clip(s.err, 50) : v,
      (s.err || bad) ? 'bad' : (!bad && (s.ev15 || s.ev24)) ? 'warn' : 'ok',
      '判据：原生关注按钮 data-testid="<数字ID>-follow" ↔ "-unfollow" 的翻转（只读 MutationObserver + 关系台账）。\n' +
      '两个窗口都是滚动的：过去 15 分钟 ' + s.max15 + ' 个、过去 24 小时 ' + s.max24 + ' 个；取关只进流水不占额度。\n' +
      '到限只警告（不拦点击、不改 x.com 的 DOM）。计数在扩展自己的存储里，页面 origin 读不到。\n' +
      '已知偏差：首次见到某目标只登记基线不计数，所以「列表里本来就已关注」不会虚高。');
  }

  function dur(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
  }

  // 60 秒冷却那条规矩的横幅：红=别关注（带倒计时秒数），绿=可以关注。
  // 只警告、不拦点击（拦要 preventDefault，那是改 X 的行为，超出这个项目的边界）。
  function coolLine(st, now) {
    var g = st.guard || {};
    var t = now || Date.now();
    var full = g.coolFull || 60000;
    var left = g.coolAt ? Math.max(0, g.coolAt + full - t) : 0;
    var bad = !!g.over15 || !!g.over24;
    var rule = '规则：一次关注完成后，至少等 ' + Math.round(full / 1000) + ' 秒再做下一个。\n' +
      '起算点 = 原生关注按钮 -follow → -unfollow 翻转的那一刻；台账是共享键，换标签页/刷新页面都认。\n' +
      '这一条只是提示：我不拦点击、不改页面，按不按在你。\n' +
      '为什么要有这条：一秒连点五个关注，节奏和抓取脚本没区别 —— 被判定自动化的代价远大于少关注几个人。\n' +
      'v0.8.15：页面右下角那颗灯同一口径 —— 冷却/到顶时圈里就是这串还剩多少秒（橙=冷却、红=额度），绿「观」=可以关注。';
    if (g.err) return { k: 'cool', sty: 'bad', left: 0, text: '冷却状态读不到：' + clip(g.err, 40), title: rule };
    if (bad) {
      return { k: 'cool', sty: 'bad', left: 0,
        text: '⛔ 不要关注 · 额度已到顶（15分钟 ' + g.f15 + '/' + g.max15 + '）' +
          (g.free15 ? ' · 约 ' + Math.max(1, Math.ceil(g.free15 / 60000)) + ' 分钟后才腾出 1 个位' : ''),
        title: rule + '\n额度到顶是另一件事：滚动窗口里的名额用完了，不是 60 秒的问题。' };
    }
    if (left > 0) return { k: 'cool', sty: 'bad', left: left, text: '⛔ 不要关注 · 倒计时 ' + Math.ceil(left / 1000) + ' 秒', title: rule };
    return { k: 'cool', sty: 'ok', left: 0,
      text: g.coolAt ? '✓ 可以关注 · 距上次关注 ' + dur(t - g.coolAt) + '（60 秒冷却已过）' : '✓ 可以关注 · 还没有关注动作',
      title: rule };
  }

  // 存储占用与本机档案库：配额顶穿那次是「静默停止持久化」，面板上看不到才最要命，
  // 所以每键字节、滚掉多少份、最后一次写失败原因都要摆在首页。
  function mb(n) {
    var v = Number(n) || 0;
    return v >= 1048576 ? (Math.round(v / 104857.6) / 10) + 'MB' : (Math.round(v / 102.4) / 10) + 'KB';
  }
  function storeLine(st) {
    var s = st.storage || {}, rm = st.runsMeta || {}, tm = st.trim || {};
    if (!s.measured) return row('本地存储 chrome.storage.local', '适配层没量到占用（自检环境？)', 'warn');
    var keys = Object.keys(s.keys || {}).sort(function (a, b) { return (s.keys[b] || 0) - (s.keys[a] || 0); });
    var per = keys.slice(0, 3).map(function (k) { return clip(String(k).replace('ysy.xprobe.', ''), 12) + ' ' + mb(s.keys[k]); }).join('  ');
    // unlimitedStorage（v0.7.1）之后 10MB 不再是硬限：分母不能继续拿它算，否则 70% 那条黄线会误报。
    var unlimited = !!s.unlimited;
    var quota = unlimited ? 0 : (s.quota || 10485760), pct = unlimited ? 0 : Math.round((s.total || 0) / quota * 100);
    var v = mb(s.total) + (unlimited ? '/不限量' : '/' + mb(quota) + '（' + pct + '%）') + '  ' + per +
      '  快照 留' + rm.kept + ' 全量' + rm.full + ' 精简' + rm.slim + (rm.dropped ? ' 滚掉' + rm.dropped : '') +
      '  表 用户' + (tm.usersKept || 0) + '/' + (tm.usersMax || 600) + ' 推文' + (tm.postsKept || 0) + '/' + (tm.postsMax || 1200) +
      ((tm.usersDropped || tm.postsDropped) ? ' 删旧' + ((tm.usersDropped || 0) + (tm.postsDropped || 0)) : '');
    var title = (unlimited
      ? '已申请 unlimitedStorage：chrome.storage.local 不再受 10MB 硬限，这一行只量实际占用、不报百分比。\n'
      : '配额是浏览器硬限（10MB），超了只往控制台丢一句 lastError ⇒ 这一行就是为了让它说不出话时看得见。\n') +
      '整页原文的去处是本机 logs/*.ndjson 与 xprobe.db（sink-9 起）；浏览器这边只留运行态：最新 ' + (rm.full || 0) +
      ' 份全量 + 往前精简行（丢 tweets[].html 与 metrics 出处原文，两张表照旧能重建），单键软顶 ' + mb(rm.cap) + '。\n' +
      '两张表到顶会删最旧那一行（用户 ' + (tm.usersMax || 600) + '、推文 ' + (tm.postsMax || 1200) + '）：从这一轮起把「删了几行」摊出来，' +
      '不再让人把 posts=1200 当成还在增长。历史行都在 xprobe.db，删的只是浏览器运行态。\n' +
      '两层不是双写同一份数据：这层是随时可丢的运行态工作副本（倒计时/滚动窗口/断线暂存），xprobe.db 那边才是档案唯一真身。\n' +
      (s.lastErr ? '最后一次写失败：' + clip(s.lastErr, 90) + ' @' + clip(s.lastErrAt, 19) +
        '\n写失败意味着那之后的持久化没落盘 —— 点「立刻采集」后看这一行有没有变化。'
        : '写入 ' + s.writes + ' 次，失败 ' + (s.failed || 0) + ' 次，没有错误。');
    return row('本地存储 chrome.storage.local', s.lastErr ? '写失败：' + clip(s.lastErr, 48) + ' ｜ ' + v : v,
      s.lastErr ? 'bad' : (s.failed || pct > 70 || tm.postsFull || tm.usersFull) ? 'warn' : 'ok', title);
  }
  function dbLine(st) {
    var s = st.sink || {}, db = s.db;
    if (!s.ok) return row('本机档案库 xprobe.db', '读不到：sink 没开（' + clip(s.err || '未测活', 36) + '）⇒ 不是「没采到数据」', 'warn');
    if (!db) return row('本机档案库 xprobe.db', '读不到：sink 是 ' + clip(s.sinkVer || '?', 10) + '，这个版本没有本机库（要 sink-9）', 'warn');
    if (!db.available) return row('本机档案库 xprobe.db', '打不开：' + clip(db.err, 70), 'bad');
    var v = '入档 ' + (db.records || 0) + ' 条  快照 ' + (db.snapshots || 0) + '  推文 ' + (db.tweets || 0) +
      '  用户行 ' + (db.userRows || 0) + '  关注 ' + (db.follows || 0) + '  曝光点 ' + (db.rewardPoints || 0) +
      '  ' + mb(db.bytes) + (db.maxAt ? '  最新 @' + clip(String(db.maxAt).slice(11, 19), 8) : '');
    return row('本机档案库 xprobe.db', v, 'ok',
      'stdlib sqlite3，零依赖，落在 sink 的目录里（' + clip(db.path, 60) + '）。\n' +
      '库版本 ' + db.dbVer + '，写失败计数在 /ping 里；读库用 GET /db?q=help 列白名单语句。\n' +
      '为什么开这个库：chrome.storage.local 只有 10MB，400 份整页快照实测 13.05MB。\n' +
      '唯一真身在这里：记录、两张表全文、整页原文；浏览器那层只是运行态工作副本（内容脚本打不开 SQLite，且要秒级多页共享与断线可记）。');
  }

  function dumpLine(st) {
    var s = st.dump || {};
    var v = (s.on ? '开' : '关') + ' 已抓 ' + s.count + '/' + s.budget + (s.html ? ' +HTML' : '') +
      (s.pending ? ' 待重发' + s.tries + '/' + s.maxTries
        : (s.dir ? ' → ' + clip(s.dir, 30) : ' 同路由' + ((s.cooldown || 0) / 1000) + 's冷却'));
    return row('调试转储(只读DOM→本机)', s.err ? clip(s.err, 52) : v, s.err ? 'bad' : s.on ? 'ok' : '',
      '开：每次采集本页顺手发一份整页结构树 + 可见原文到本机 sink 的 dump\\ 目录，一次一个 POST。\n' +
      '「全文HTML」是另开的重开关：整页 outerHTML（表单 value 与 textarea 正文会抹掉）。\n' +
      '只做 DOM 读取：不点击、不滚动、不跳转、不请求 X 的任何接口，也不带 cookie。\n' +
      '上一次：' + (s.last || '(无)') + '\n最多重发 ' + s.maxTries + ' 次，之后红字报「放弃」。');
  }

  // 同页还有别的宿主（冻结的油猴副本）：真机 13:41:56.598 与 .794 相隔 196ms 各采同一页一次。
  // 后果不是「多两条日志」而是守卫台账被劈成两份——GM 存储与 chrome.storage.local 各数各的 0/15 与 0/400，
  // 到限警告可能少报一半，所以这条必须是红线、必须显眼。
  function peerLine(st) {
    if (!st.peer) return null;
    return row('同页检测到另一个宿主: ' + st.peer, '两个采集器在这一页各采一次', 'bad',
      '油猴副本与扩展同时开着：\n① 关注守卫的 15 分钟 / 24 小时两份台账各数各的，到限警告会少报一半；\n' +
      '② 同一页产生两条 page + 两条 probe，日志里谁是谁要看 ver；\n' +
      '③ 页面里两个探针节点（旧版还会撞 id）。\n处理：暴力猴里把「X 观测探针」那条脚本停用，只留扩展。');
  }

  function noteLine(st) {
    var ns = st.notes || [];
    if (!ns.length) return null;
    return fold('已知缺口 / 已排除的脏数据 (' + ns.length + ')', ns.join('\n'));
  }

  // ---------- v0.6.9 UI 整顿：四个视图「首页 / 趋势 / 诊断 / 设置」，按钮按频率归位 ----------
  // 首页 = 每次打开看三眼：今日四列核心数字（大字）→ 守卫额度 → 通道灯；低频动作全部退场。
  // chLine 把 sink 与本机库压成一盏灯：详细账（断线/落盘/写失败/库打不开）在「诊断」视图，这里只做入口。

  function chLine(st) {
    var sn = st.sink || {}, q = sn.q || {}, db = sn.db;
    var sink = sn.ok ? 'sink OK · 已写 ' + (sn.posted || 0)
      : (sn.ok === false ? 'sink 断开 · 待发 ' + (sn.qlen || 0) + ((q.count || 0) ? ' · 暂存 ' + q.count : '')
        : 'sink 未测（诊断页「测活」）');
    var dbp = !sn.ok ? '库读不到' : !db ? '库要 sink-9+' : (!db.available ? '库打不开' :
      '库 ' + mb(db.bytes) + ' · 记录 ' + (db.records || 0) + (db.maxAt ? ' · 最新 ' + clip(String(db.maxAt).slice(11, 16), 5) : ''));
    return row('通道', sink + ' ｜ ' + dbp, sn.ok ? 'ok' : 'bad',
      '左边 = 日志接收端 127.0.0.1:8765；右边 = 本机档案库 xprobe.db（唯一真身）。\n' +
      '这是入口灯，不是全账：断线落盘、写失败、逐表行数都在「诊断」视图两条长行上（日志 sink… / 本机档案库…）。');
  }

  // 今日关注进度条（v0.6.9 F4 段第 2 版；口径重看过用户现场后改定）：
  // 分子不是「探针数到的关注动作」（DOM 翻转会漏计，真机 2960→3113 只记到 71 次 ⇒ 17.8% 那次就是它），
  // 而是**页面在读的「正在关注」数**：基线（手动 2960 / 自动=分钟线今天最早的读数）→ 当前（latest 分钟点）
  // → 目标 = 基线 + 399（用户给的每日动作目标）。条的左边标基线、右边标目标，涨幅做填色。
  // ETA：手动基线从「填下去那一刻」起量平均速度（setAt），自动基线从今天首点量；只有一个读数就不推。
  function goalBar(st, now) {
    var gt = (st.guard || {}).goalToday;
    if (!gt) return null;
    var t = now || Date.now();
    var min = (st.series || {}).min || [];
    var today = dayOfTs(t);
    var pts = min.filter(function (p) { return p && p.following != null && dayOfTs(p.ts) === today; });
    var cur = pts.length ? pts[pts.length - 1].following
      : (min.filter(function (p) { return p && p.following != null; }).pop() || {}).following;
    if (cur == null) cur = null;
    var base = gt.baseSrc === 'hand' ? gt.base : (pts.length ? pts[0].following : null);
    var tgt = gt.target || 399, goalNum = base != null ? base + tgt : null;
    var gain = (cur != null && base != null) ? cur - base : null;
    var pct = gain != null ? Math.min(100, Math.max(0, Math.round(gain / tgt * 1000) / 10)) : 0;
    var eta = '', sty = gain != null && gain < 0 ? 'warn' : (gain == null ? 'warn' : '');
    if (gain != null && gain >= tgt) { eta = ' · ✓ 已达标'; sty = 'ok'; }
    else {
      var spanMin = null;
      if (gt.baseSrc === 'hand' && gt.setAt) { var dt = (t - gt.setAt) / 60000; if (dt >= 1) spanMin = dt; }
      else if (pts.length >= 2) spanMin = (pts[pts.length - 1].ts - pts[0].ts) / 60000;
      if (spanMin && gain != null && gain > 0) {
        var left = tgt - gain;
        eta = ' · 按当前节奏约 ' + dur(Math.round(left / (gain / spanMin) * 60000)) + '后完成 (~' + hmOf(t + Math.round(left / (gain / spanMin) * 60000)) + ')';
      } else if (gain == null) eta = ' · 还没有「正在关注」读数：去自己主页开一下面板（自动打分钟点）';
      else eta = ' · 节奏推不出（' + (gt.baseSrc === 'hand' && gt.setAt ? '刚设基线不到 1 分钟' : '今天只有一个读数') + '）';
    }
    var head = (base != null ? nfOf(base) + ' → ' + nfOf(base + tgt) : '基线待定 → 基线 + ' + nfOf(tgt)) +
      ' · 当前 ' + (cur == null ? '—' : nfOf(cur)) +
      (gain == null ? '' : (gain < 0 ? ' · 比基线少 ' + nfOf(-gain) : ' · 已 +' + nfOf(gain))) +
      ' · ' + pct + '%' + (gain != null && gain < 0 ? '（一般是取关多了）' : '') + eta;
    return {
      k: 'bar', label: '今日关注进度', text: head, pct: pct, sty: sty,
      endLeftTxt: base != null ? '基线 ' + nfOf(base) : '基线 —（自动=今天首个读数）',
      endRightTxt: '目标 ' + (goalNum != null ? nfOf(goalNum) : '+ ' + nfOf(tgt)),
      title: '口径（这回按你现场重看过）：左端=今天基线「正在关注」' + (base != null ? nfOf(base) : '—') +
        (gt.baseSrc === 'hand' ? '（手动填的）' : '（自动=分钟线今天最早的读数）') +
        '，右端=基线+' + nfOf(tgt) + '（每日目标，不是 X 的上限）。\n当前数来自分钟线（自己主页开着才会有读数，页面上「正在关注 3,113」就是它）；' +
        '探针数到的关注动作有漏记（真机 2960→3113 只记到 71 次），所以分子用页面读数不用台账。\n改基线/目标：设置页「今日基线 / 目标」。',
    };
  }
  function nfOf(n) { return n == null ? '—' : nf(n); }

  // homeLines 只吃 state；hero 的四列复用 impRows 的口径（今天行关注=分钟线最高、粉丝=最新点）
  function homeLines(st) {
    var out = [];
    var ser = st.series || {}, sc = ser.counts || {}, c = st.counts || {};
    var today = dayOfTs(Date.now());
    var rowToday = (impRows(st, 0) || []).filter(function (r) { return r.day === today; })[0] || null;
    out.push({
      k: 'hero', day: today, own: ser.key || ser.own || '',
      items: [
        { label: '曝光', v: rowToday && rowToday.imp != null ? rowToday.impTxt : null, hint: rowToday && rowToday.imp != null ? (rowToday.exact ? '精确值（奖励页读的）' : '缩写值（奖励页读的）') : '今天还没曝光点：在奖励页「采集本页」，或在趋势页补录' },
        { label: '关注', v: rowToday ? rowToday.fowTxt : null, max: !!(rowToday && rowToday.fowHow === 'max'), hint: rowToday && rowToday.fowHow === 'max' ? '今天分钟线采到的当日最高值' : (rowToday && rowToday.fowHow === 'day' ? '日点表里的值（打开主页自动采，或趋势页手补）' : '今天还没有读数') },
        { label: '粉丝', v: rowToday ? rowToday.fansTxt : null, hint: rowToday ? (rowToday.fansTxt === '—' ? '今天没有粉丝读数' : '今天最后一次在主页读到的') : '' },
        { label: '帖子', v: rowToday ? rowToday.postsTxt : null, hint: rowToday ? (rowToday.postsTxt === '—' ? '今天还没在主页采到：打开任意个人主页自动落（v0.8.1 起抓头部总数）' : '主页头部自报的帖子总数（自动采）') : '' },
      ],
      note: rowToday ? '' : '今天还没有点位：去奖励页点「采集本页」（曝光自动落今天），或在「趋势」补历史',
    });
    if (st.peer) out.push(peerLine(st));
    out.push(guardLine(st));
    var goal = goalBar(st);
    if (goal) out.push(goal);
    out.push(chLine(st));
    out.push(row('数据底子', '序列 ' + (sc.min || 0) + 'min/' + (sc.imp || 0) + 'day · 用户表 ' + (c.users || 0) + ' · 帖子表 ' + (c.posts || 0) + ' · 快照 ' + (c.runs || 0) + ' 份',
      (c.users || c.runs) ? 'pre' : 'warn',
      '两张表 = 浏览器侧拦截到的用户/帖子（全文档案在 xprobe.db，诊断页看）；序列 = 分钟/日点位数（趋势页画图就是它）。'));
    var last = st.last;
    if (!last) {
      out.push(line(pageHint()));
      return out;
    }
    if (last.tab === 'rewards') {
      out.push(rewardLine(last.rewards));
      return out;
    }
    var idt = last.identity || {};
    out.push(row('本页', (last.tab || '?') + '  ' + (idt.handle ? '@' + idt.handle + '  ' : '') + (idt.displayName || '(无名)') +
      '  ·  ' + last.tweets.length + ' 条' + (last.dup ? ' · 45s 内重复采过' : ''), 'pre', clip((last.url || st.href || ''), 140)));
    if (idt.followRelation) {
      out.push(line('关注关系: ' + idt.followRelation + ' ' + (idt.followAria || '') + (idt.ownProfile ? '（自己的主页）' : '')));
    }
    return out;
  }

  // 命中率块：字段掉没掉，就看这 8 行里的 x/y
  function covText(c) {
    c = c || {};
    return [
      '本页命中率 干净卡 ' + c.clean + '/' + c.articles + '（剔推广位 ' + c.ads + '）',
      'tweetId     ' + c.tweetId + '   timeISO     ' + c.timeDatetime,
      'tweetText   ' + c.tweetText + '   author      ' + c.author + ' (testid ' + c.authorTestid + ')',
      '聚合aria    ' + c.summaryAria + '   来源      ' + srcText(c),
      'reply       ' + c.reply + '   repost      ' + c.repost,
      'quote       ' + c.quote + '   like        ' + c.like,
      'view        ' + c.view + '   like精确    ' + c.likeExact,
      'view精确    ' + c.viewExact,
    ].join('\n');
  }

  function metricsText(t) {
    return Object.keys(t.metrics || {}).map(function (k) {
      var n = t.metrics[k].num;
      return k + '=' + (n.value != null ? n.value : '?') + (n.exact ? '' : '~');
    }).join(' ');
  }

  function userLine(u) {
    return u.handle + ' ' + (u.name || '') + ' 粉' + (u.followers == null ? '-' : u.followers) + (u.followersExact ? '' : '~') +
      ' 关' + (u.following == null ? '-' : u.following) + (u.relation ? ' ' + u.relation : '') +
      (u.seenAs.following ? ' [在我关注里 ' + clip(u.seenAs.following, 10) + ']' : '') +
      (u.seenAs.followers || u.seenAs.verified_followers ? ' [粉我 ' + clip(u.seenAs.followers || u.seenAs.verified_followers, 10) + ']' : '') +
      ' 点' + (u.hist || []).length;
  }

  function postLine(p) {
    return p.tweetId + ' @' + (p.handle || '-') + ' ' + clip(p.text || '', 40) + ' 赞' + (p.like == null ? '-' : p.like) +
      ' 看' + (p.view == null ? '-' : p.view) + ' 首见' + clip(p.firstSeenAt || '', 19);
  }
  // 性能账（v0.8.7）：现场是「评论区一滚动就特别卡」，这行就是那把尺。
  // 只报结论级数字：观察器即时/合并各跑了多少趟、最重一趟几毫秒（预算是 caps.passMs）、
  // 排队溢出丢了几批、被动补采最重一枪几毫秒（它决定地板退让多少）、落表与徽标各花多少。
  // 全是 0 不等于坏了 —— 这一页还没滚过就没活儿；看数之前先上下滚几屏再回这页。
  function perfRow(st) {
    var p = st && st.perf;
    if (!p) return row('性能账', '这一份 state 里没有性能账（探针版本旧？重载扩展后再看）', 'warn',
      'v0.8.7 起 core 把观察器/被动补采/落表/徽标的开销全记进 perfLine()，'
      + '随 kind=debug 记录一起回本机库，控制台 __xprobe.perfLine() 也能当场读。');
    var c = p.caps || {};
    var n = function (x) { return Math.round((x || 0) * 10) / 10; };
    var v = '观察 ' + (p.sync || 0) + '即时/' + (p.flushed || 0) + '合并 最重' + n(p.worstPassMs) + 'ms(顶' + (c.passMs || 6) + 'ms) 丢' + (p.droppedBatches || 0) + '批'
      + ' ｜ 补采 ' + (p.collects || 0) + '次 最重' + n(p.worstCollectMs) + 'ms 推迟' + (p.postponed || 0) + '次 退让' + Math.round((p.collectBackoffMs || 0) / 100) / 10 + 's'
      + ' ｜ 落表 ' + (p.storeWrites || 0) + '次 最重' + n(p.worstStoreMs) + 'ms'
      + ' ｜ 徽标 ' + (p.badgeScans || 0) + '扫/' + (p.badgeSkips || 0) + '跳 最重' + n(p.worstBadgeMs) + 'ms'
      + ' 出' + (p.badgeOk || 0) + '(退点' + (p.badgeDots || 0) + ') 放不下' + (p.badgeNoFit || 0) + '/在钮上' + (p.badgeCta || 0)
      + '/挪' + (p.badgeMoved || 0) + ' 标签' + (p.badgeRatio || 0) + '/缺数' + (p.badgeRatioNo || 0) + '/旧' + (p.badgeRatioOld || 0)
      + ' 关系' + (p.badgeRel || 0) + '/判而不画' + (p.badgeRelNo || 0) + ' 桥读' + (p.badgeFiber || 0) + '/缺桥' + (p.badgeFiberNo || 0)
      + ' ｜ 标杆 问' + (p.benchAsk || 0) + '回/没回话' + (p.benchFail || 0)
      + '/主页星' + (p.benchBadge || 0) + (p.benchBadgeNo ? '（' + p.benchBadgeWhy + '）' : '')
      + '/页头星' + (p.benchPBadge || 0) + (p.benchPBadgeNo ? '（' + p.benchPBadgeWhy + '）' : '');
    var bad = (p.droppedBatches || 0) > 0 || n(p.worstPassMs) > (c.passMs || 6) * 3 || n(p.worstCollectMs) > 120;
    return row('性能账（滚几屏再回这页看）', v, bad ? 'warn' : 'ok',
      '读法：\n'
      + '· 最重一趟应在预算（' + (c.passMs || 6) + 'ms）附近，明显超了说明合并 DFS 之外的动作在吃主线程\n'
      + '· 丢批 >0 = 滚动太快队列顶不住，漏下的按钮由采集时的整文档对账兜底，不是丢数据\n'
      + '· 补采最重一枪（整页快照）决定地板退让：超过 25ms 每 1ms 换 100ms 休息，最多退 30s（现在退 ' + Math.round((p.collectBackoffMs || 0) / 100) / 10 + 's）\n'
      + '· 推迟次数在滚动时应明显大于 0 = 整页快照确实被推到了 DOM 停手之后\n'
      + '· 徽标那串的「出/放不下/在钮上」是**最近一趟**每一行的判决（不是累计）：这颗闸 v0.8.16 起默认开（不用先拨开关），'
      + '看到 出0 就看后两个数——放不下 = 这一行右边确实没 46px 空白（会先退成小红点）；在钮上 = 往上爬出 X 那颗可点进主页的大按钮之后'
      + '仍然没有「行那么高」的挂得住的层（v0.8.16 之前列表页整页都记这个数，现在只剩真挂不住的行）\n'
      + '· 「挪」= 最近一趟里被搬了位置的老徽标数：正常应该是 0 或个位数（页面增量刷新时名字行右边陆续挂上东西，'
      + '老位置被占了才搬）。它一直在涨 = 徽标在来回跑，把这一页的 URL 和这个数一起报上来\n'
      + '· 「标签/缺数/旧」也是最近一趟：标签 = 那颗徽标右边带出了「正在关注 ÷ 关注者」的比例小牌（底色=档位、字=百分比，'
      + (c.ratioGreen || 95) + '% 以上绿、' + (c.ratioYellow || 85) + '~' + (c.ratioGreen || 95) + '% 黄、再低红）；'
      + '缺数 = 这台机器还没记到这两个数。这两个数**不在页面那一行里**，只活在悬停名片和主页头部 —— '
      + '对着那个人的头像悬停一下（你自己悬停，探针只读 DOM、不模拟鼠标）或进一次 TA 的主页，数就进了本机台账，'
      + '下一趟徽标右边就有牌。累计进了多少个数看 __xprobe.perfLine().hcStat；本页没数的话标签一列会是 0\n'
      + '· 「旧」= 标签上那个数已经超过 ' + (c.ratioStaleDays || 30) + ' 天没再读到（标签会变虚线灰边）。'
      + '想补齐/刷新：打开页面右缘「关」那张「本页用户」名单，行尾没数的是一枚灰「—」、头部有「待补(N)」那颗筛子，'
      + '照着把头像各悬停一次就永久入库（探针不替你点开任何东西）；数每变一次才留一个采样点（同一份数反复读到不堆点），'
      + '所以同一个人悬停第二次起，看的就是**数值随时间的变化**\n'
      + '· 「关系」= 最近一趟带着「互关/他单向/我单向」标签的徽标颗数，判据是这一行的关系钮、'
      + 'X 随时间线带回页面的关系读数（v0.11.7 的主世界只读桥）、本机台账三本账——home 时间线的行里没有关系钮，'
      + '靠的就是桥读数；「判而不画」= 判得出来但这一行没地方放；「缺桥」= 桥里还没有这一行作者的新鲜读数'
      + '（X 没带回 / 保鲜期过了 / 主世界那份信使没跑起来），会自动攒着补问，最多 15 秒一问。'
      + '整页一直全列缺桥 = bridge.js 没跑（重载扩展试试）\n'
      + '· 「标杆」= 右缘那两颗窗口钮（v0.9.3 起是「标杆」按人 + 「标帖」按条，两本账）问过本机库几回、其中几回没回话或被拒。'
      + '名单本身在页面窗口里看（库优先、缺的格退本机台账、两头都没有写「—」）；这里只记通道账：'
      + '「没回话」一直涨 = 宿主/sink 没起来或库拒了这句查询，窗口里那句红字会说原因\n'
      + '· 「主页星」= 最近一趟个人主页昵称右边那颗「☆标此人 / ★已标人」出了没有（整页最多一颗）。'
      + '「页头星」= 帖子详情页页头「帖子」右边那颗「☆标此帖 / ★已标帖」（v0.9.3 新增，同一道闸、同一趟扫描、各记各的账）。'
      + '0 后面括号里是没出的原因：'
      + '「闸关着」= 设置里「页面内拉黑徽标」那颗闸拨回了关（两颗与徽标同一条 RL-16 总闸）；'
      + '「没找到昵称那一行 / 没找到页头那一行」= X 改了主页头部或页头结构；「挂不住」= 那一层不是行高或住在 X 的可点元素里；'
      + '「放不下」= 那一行右边的空白连短字面（38px）都装不下（整字面 70px 装得下就用整字面，装不下退短字面，'
      + '两档都不够宁可不出，也不压住页面自己的字）\n'
      + '· 卡顿只由你的手感判定：这行只证明探针自己变轻了');
  }


  // 本机数据目录的占用行（v0.8.8）：logs / dump / 库 / 宿主日志 各多大、按保留天数能清掉多少。
  // 「可清」是按文件名里的日期算的（mtime 会被备份工具摸新，不能拿来判几天前），
  // 库里能回收多少空间是空闲页（VACUUM 的量），拿不到时显示「未知」而不是 0 —— 0 是「不用清」这句假话。
  function fsRow(f) {
    if (!f) return row('本机文件与清理', '(还没测：点右边「重测」。sink/宿主没起来时这行也测不到)', 'warn',
      '数据目录 = log-sink.py --dir 那个目录，或环境变量 XPROBE_DIR（默认 ~/xprobe，Windows 上是 C:\\Users\\<你>\\xprobe）。'
      + '浏览器这边不碰文件系统，测量与清理都由本机那侧按白名单执行。');
    if (f.ok === false) return row('本机文件与清理', '测不到：' + (f.err || '本机没回包') + '（sink-18 起了吗？宿主装了吗）', 'warn',
      '这条路是 127.0.0.1 回环或 Native 宿主；两边都没起来时这行就该红，不该显示一个 0 糊过去。');
    var it = f.items || {};
    var lg = it.logs || {}, dm = it.dump || {}, db = it.db || {}, hs = it.host || {};
    var v = '日志 ' + mb(lg.bytes) + '/' + (lg.files || 0) + '个'
      + ' 转储 ' + mb(dm.bytes) + '/' + (dm.dirs || 0) + '份'
      + ' 库 ' + mb(db.bytes) + (db.free == null ? ' 空闲未知' : ' 空闲' + mb(db.free))
      + ' 宿主日志 ' + mb(hs.bytes) + ' ⇒ 计 ' + mb(f.total)
      + ' ｜ 保留 ' + (f.keep || 7) + ' 天可清：日志 ' + mb(lg.cleanable) + ' 转储 ' + mb(dm.cleanable);
    var sty = (lg.cleanable || dm.cleanable) ? 'warn' : '';
    var last = (Array.isArray(f.runs) && f.runs.length) ? f.runs[f.runs.length - 1] : null;
    var title = '读法：\n'
      + '· 「可清」= 文件名里的日期早于保留 ' + (f.keep || 7) + ' 天的部分，删它不影响库里的数据\n'
      + '· 库（xprobe.db）不在自动清理范围：那是档案。「整理库」只做 VACUUM（压实空闲页），一行数据都不删\n'
      + '· 自动清理 = 本机那侧每天最多跑一次（撞上的时机：sink/宿主起进程，或这页读占用）；关它就点上面那枚钮\n'
      + '· 数据目录 ' + clip(String(f.dir || ''), 60) + (f.lastAuto ? ' 上次自动清理 ' + f.lastAuto : '')
      + (last ? '\n上次实删：' + (last.target === 'logs' ? '日志' : '转储') + ' ' + (last.removed || 0)
        + ' 个 / 省 ' + mb(last.freed || 0) + '（' + clip(String(last.at || ''), 19) + '）' : '');
    return row('本机文件与清理', v, sty, title);
  }

  // 「本页」视图随 v0.6.9 UI 整顿退场：用户每日看数去「首页」（homeLines），读数质量检查
  // 全部归「诊断」（debugLines 顶部的身份行 + 三条 statRow + posts(tab) 行）——一个页面只答一类问题。
  // 「本页」视图只留用户一眼要看的东西：页面类别、两张表的账、守卫计数与冷却、sink 连接、身份读数。
  // 判据证据、存储占用、命中率、漏抓、原文折叠这些发散内容全部搬到「调试」视图（debugLines）。
  function debugLines(st) {
    var out = [];
    var g = st.guard || {}, c = st.counts || {};
    var dbg = st.debug || {}, dbgOn = !!dbg.on;
    var hb = dbgOn ? ('  自报每 ' + Math.round((dbg.everyMs || 600000) / 60000) + ' 分钟一条' +
      (dbg.lastAt ? '，上次 @' + clip(String(dbg.lastAt).slice(11, 19), 8) : '（还没落过）')) : '';
    out.push(row('调试 ' + (st.ver || '?') + ' build ' + (st.build || '?'),
      'rndMax ' + (st.rndMax == null ? 20 : st.rndMax) + ' 秒  debug ' + (dbgOn ? '开' : '关') + hb, 'pre',
      '这一页是给「对表」用的：存储占用、守卫明细、命中率与漏抓、原文折叠。\n'
      + '下一轮 AI 迭代靠的是本机日志里那条 kind=debug 的记录——它就是这一眼的内容。\n'
      + 'debug 开着时它自己按节拍续报（why=on/tick/panel/boot），日志里就有时间轴可对，不用等人点开这页。'));
    out.push(storeLine(st));
    out.push(dbLine(st));
    out.push(guardLine(st));
    out.push(dumpLine(st));
    out.push(sinkLine(st));
    out.push(perfRow(st));

    var last = st.last;
    if (!last) {
      out.push(line('本页还没采过（点「采集本页」）——存储、守卫、转储与 sink 的明细照常看上面。'));
      return out;
    }
    if (last.tab === 'rewards') {
      if (last.rewards && (last.rewards.cands || []).length) {
        out.push(fold('取数证据 · 候选 (' + last.rewards.cands.length + ')', JSON.stringify(last.rewards.cands.slice(0, 3), null, 1)));
      }
      out.push(line('奖励页的数走「趋势」页看。'));
      return out;
    }

    // 「本页」视图退场后搬进来的读数质量块：身份 → 三条统计来源行 → 关系与 posts(tab)
    var idt = last.identity || {};
    out.push(line((idt.handle ? '@' + idt.handle : clip(last.url, 46)) + '  |  ' +
      last.tweets.length + ' 条 article  |  ' + (idt.displayName || '(无名)') +
      (last.dup ? '\n本页 45s 内重复采过 ⇒ 这轮只是重读，未再上报' : '')));
    ['following', 'followers', 'verified_followers'].forEach(function (k) {
      var r = statRow(STAT_LABEL[k] || k, last.stats[k]);
      if (r) out.push(r);
    });
    if (idt.followRelation) {
      out.push(line('关注关系: ' + idt.followRelation + ' ' + (idt.followAria || '') + (idt.ownProfile ? '（自己的主页）' : '')));
    }
    var tabs = last.stats.__tabs || [], postTab = null;
    for (var i = 0; i < tabs.length; i++) {
      if (POSTS_RE.test(tabs[i].text + ' ' + tabs[i].ariaLabel)) { postTab = tabs[i]; break; }
    }
    var noNum = postTab && postTab.num.value == null;
    out.push(row('posts(tab)', postTab ? (postTab.num.value != null ? postTab.num.value + ' (' + postTab.text + ')' : '有 tab 没数字（结案：X 的 DOM 里不给总数）') : '未命中',
      postTab && postTab.num.value != null ? (postTab.num.exact ? 'ok' : 'warn') : (noNum ? '' : 'bad')));
    if (!tabs.length) out.push(row('tabs', '本页无 role=tab', 'bad'));

    out.push(line('粉丝数来源: ' + (last.stats.__followersSource || '(无)')));
    if (last.users.length || last.userCellInDoc) {
      out.push(line('列表行 ' + last.users.length + ' 条（取域 ' + last.usersScope + '，整页 UserCell ' + last.userCellInDoc + '）  handle ' +
        last.covUsers.handle + '  名称 ' + last.covUsers.name + ' ' + JSON.stringify(last.covUsers.nameHow) + '  关系 ' + last.covUsers.follow +
        '  行型 ' + JSON.stringify(last.covUsers.origin || {})));
    }
    out.push(line(covText(last.cov)));
    out.push(line('漏抓: ' + ((st.missing || []).length ? st.missing.join('  ') : '(无)')));
    if (noteLine(st)) out.push(noteLine(st));

    var first = last.tweets[0];
    if (first) {
      out.push(line('样本: id=' + (first.tweetId || '-') + '  t=' + (first.timeDatetime || '-') + '\nmetrics: ' + (metricsText(first) || '(空)')));
      out.push(fold('看 article HTML', first.html));
    }
    if (last.stats.followers) out.push(fold('看 followers 锚点 HTML', last.stats.followers.html));
    if (last.stats.following) out.push(fold('看 following 锚点 HTML', last.stats.following.html));
    if ((last.stats.__foreign || []).length) out.push(fold('被排除的别人的号锚点 (' + last.stats.__foreign.length + ')', JSON.stringify(last.stats.__foreign, null, 1)));
    return out;
  }

  // ---------- 趋势页：折线图的几何（纯算数，Node 里能直接断言点串与刻度） ----------
  // 面板只有约 400px 宽，图按 viewBox 缩放而不是按像素画死：点数再多也只是子像素，
  // 所以这里先按「视窗」裁（分钟线最近 400 点），几何只负责把 x/y 映射进盒子。
  function nf(v) {
    v = Number(v);
    if (!isFinite(v)) return '-';
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(Math.abs(v) >= 1e6 ? 0 : 1) + '万';
    return String(Math.round(v * 10) / 10);
  }
  // 曝光那一列的两种口径分开写：精确值就报全数（12,345），缩写值报成 1.32万~ ——
  // 末尾那个 ~ 是「这数来自缩写/手抄，不冒充精确」，跟采集器读到缩写是同一个记号。
  // 别用 nf()：那是纵轴刻度的紧凑口径，12,345 进去出 1.2万，把用户手填的精确数糊成两位。
  function impFmt(v, exact) {
    v = Number(v);
    if (!isFinite(v)) return '-';
    if (exact) return String(Math.round(v)).replace(/\B(?=(\d{3})+$)/g, ',');
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿~';
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + '万~';
    return String(Math.round(v)) + '~';
  }
  function hmOf(ts) {
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function mdOf(dayOrTs) {
    var s = String(dayOrTs || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
    var d = new Date(Number(dayOrTs));
    if (isNaN(d.getTime())) return '-';
    return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // o = {title, unit, series:[{label, cls, pts:[{x,y}]}], xfmt}
  function chartSpec(o) {
    o = o || {};
    var W = 360, H = 118, L = 40, R = 6, TP = 10, B = 18;
    var xfmt = o.xfmt || mdOf;
    var lists = (o.series || []).map(function (s) {
      return {
        label: s.label, cls: s.cls || 'c0', tip: s.tip || '',
        pts: (s.pts || []).filter(function (p) { return p && p.y != null && isFinite(p.y) && isFinite(p.x); }),
      };
    });
    var all = [];
    lists.forEach(function (s) { all = all.concat(s.pts); });
    var base = { k: 'chart', title: o.title || '', unit: o.unit || '', w: W, h: H, box: { l: L, r: W - R, t: TP, b: H - B }, empty: '', note: o.note || '', series: [], yTicks: [], xTicks: [] };
    if (all.length < 2) {
      base.empty = '点不够画线（要 2 个以上），现在 ' + all.length + ' 个';
      return base;
    }
    var xs = all.map(function (p) { return p.x; }), ys = all.map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (y1 === y0) { y1 = y0 + 1; y0 = y0 - 1; }   // 平线也要看得出高低，不然贴到轴上像掉了
    var sx = function (x) { return x1 === x0 ? L : L + (x - x0) / (x1 - x0) * (W - R - L); };
    var sy = function (y) { return H - B - (y - y0) / (y1 - y0) * (H - B - TP); };
    base.series = lists.map(function (s) {
      return {
        label: s.label, cls: s.cls, n: s.pts.length, tip: s.tip,
        pts: s.pts.map(function (p) { return Math.round(sx(p.x) * 10) / 10 + ',' + Math.round(sy(p.y) * 10) / 10; }).join(' '),
        first: s.pts.length ? s.pts[0].y : null, last: s.pts.length ? s.pts[s.pts.length - 1].y : null,
        min: s.pts.length ? Math.min.apply(null, s.pts.map(function (p) { return p.y; })) : null,
        max: s.pts.length ? Math.max.apply(null, s.pts.map(function (p) { return p.y; })) : null,
      };
    });
    base.yTicks = [y1, (y0 + y1) / 2, y0].map(function (v) { return { y: Math.round(sy(v) * 10) / 10, label: nf(v) }; });
    base.xTicks = [{ x: L, label: xfmt(x0) }, { x: (L + W - R) / 2, label: xfmt((x0 + x1) / 2) }, { x: W - R, label: xfmt(x1) }];
    base.span = { x0: x0, x1: x1, y0: y0, y1: y1 };
    return base;
  }
  function minChart(series) {
    var pts = (series || []).slice(-400);
    return chartSpec({
      title: '关注 / 粉丝 · 每分钟一个点（仅页面开着时采）', unit: '人',
      series: [
        { label: '正在关注', cls: 'c0', pts: pts.map(function (p) { return { x: p.ts, y: p.following }; }) },
        { label: '关注者', cls: 'c1', pts: pts.map(function (p) { return { x: p.ts, y: p.followers }; }) },
      ],
      xfmt: hmOf,
    });
  }
  function impChart(series) {
    // v0.7.2 起 value 记的是账号分析页的实时曝光（奖励页那个数搬去了 eff）——日线只画有值的那几天
    var pts = (series || []).slice(-365).filter(function (p) { return p.value != null; }).map(function (p) { return { x: Date.parse(p.day + 'T00:00:00Z'), y: p.value, day: p.day }; });
    return chartSpec({
      title: '每日曝光 · 账号分析页（当天实时涨；奖励页的 T+1 有效曝光在四列图里）', unit: '次',
      series: [{ label: '曝光', cls: 'c2', pts: pts }],
      xfmt: mdOf,
    });
  }
  // v0.8.1 续：转化率单独一张折线（用户的话：「转化率 感觉可以单独推出一个折线图」）。
  // 与四列图同一份 impRows 喂数 ⇒ 表里补了 eff/曝光，这条线立刻跟着长；两列缺一的那天不画点（率算不出）。
  function impRateChart(st) {
    var rows = (impRows(st, 0) || []).slice(-365);
    var pts = rows.filter(function (r) { return r.rate != null; })
      .map(function (r) { return { x: Date.parse(r.day + 'T00:00:00Z'), y: r.rate, day: r.day }; });
    return chartSpec({
      title: '转化率 · 当日有效曝光 ÷ 当日曝光（有效曝光=奖励页90天累计读数相减；两列都有数的那天才有点）', unit: '%',
      series: [{ label: '转化率', cls: 'c3', pts: pts }],
      xfmt: mdOf,
    });
  }
  // 四列里另外三列（关注/粉丝/帖子）也上折线：手填历史天 + 天行合并（今天那行的关注/粉丝从分钟线兜）。
  // 同一份 impRows 喂表和图 ⇒ 表里改了数，图立刻跟着变，不用再做第二套口径。
  function impMultiChart(st) {
    var rows = (impRows(st, 0) || []).slice(-365);
    var mk = function (key) {
      return rows.filter(function (r) { return r[key] != null; })
        .map(function (r) { return { x: Date.parse(r.day + 'T00:00:00Z'), y: r[key], day: r.day }; });
    };
    return chartSpec({
      title: '有效曝光 / 关注 / 粉丝 / 帖子 · 日线（有效曝光=90天累计读数相减的当日差分；历史天靠补录）', unit: '个',
      series: [
        { label: '有效曝光', cls: 'c2', pts: mk('effDay') },
        { label: '关注', cls: 'c0', pts: mk('fow') },
        { label: '粉丝', cls: 'c1', pts: mk('fans') },
        { label: '帖子', cls: 'c3', pts: mk('posts') },
      ],
      xfmt: mdOf,
    });
  }
  // ---------- v0.8.1-p 预测页签：粉丝折线 + 5,000 / 10,000 到达日 ----------
  // 吃的就是日点表同一份 impRows ⇒ 分钟点/补录/库回填一有新粉丝点，面板 900ms 回读重画时就重算。
  // 两条外推：A = 全点最小二乘（被早期高增速拉高，偏乐观）；B = 最近 3 个间隔的平均日增（偏保守）。
  // 日期一律走 UTC 整日（Math.round 到天），自检里节点本地时区不同也不许差一天。
  function daysBetween(day) { return Date.parse(day + 'T00:00:00Z') / 86400000; }
  function fmtDay(tDays) {
    var d = new Date(Math.round(tDays) * 86400000);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  // v0.8.1-q 通用趋势：粉丝（5,000 / 10,000）与有效曝光累计读数（50 万奖励门槛）同一套外推。
  // A = 全点最小二乘（偏乐观）；B = 最近 3 个间隔的平均日增（偏保守）。日期一律 UTC 整日（Math.round 到天）。
  function trendCalc(rows, key, unitName) {
    var pts = (rows || []).filter(function (r) { return r && r.day && r[key] != null; })
      .map(function (r) { return { day: r.day, t: daysBetween(r.day), y: r[key] }; });
    var byDay = {};
    pts.forEach(function (p) { byDay[p.day] = p; });   // 同一天两行（今天分钟兜的 + 手填）按天留一行
    pts = Object.keys(byDay).map(function (d) { return byDay[d]; }).sort(function (a, b) { return a.t - b.t; });
    if (pts.length < 3) return { ok: false, pts: pts, why: '点不够（要 3 天以上有' + unitName + '的行，现在 ' + pts.length + '）' };
    var last = pts[pts.length - 1], first = pts[0];
    var gains = [];
    for (var i = 1; i < pts.length; i++) gains.push({ day: pts[i].day, gain: pts[i].y - pts[i - 1].y });
    var n = pts.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
    pts.forEach(function (p) { sx += p.t; sy += p.y; sxy += p.t * p.y; sxx += p.t * p.t; });
    var den = n * sxx - sx * sx;
    var slopeA = den ? (n * sxy - sx * sy) / den : 0;
    var tail = gains.slice(-3), acc = 0, span = 0;
    tail.forEach(function (g, i) {
      var pi = pts.length - tail.length + i;   // 该间隔的终点下标：间隔 = pts[pi-1] → pts[pi]
      acc += pts[pi].y - pts[pi - 1].y;
      span += pts[pi].t - pts[pi - 1].t;
    });
    var slopeB = span ? acc / span : (tail.length ? tail[tail.length - 1].gain : 0);
    return {
      ok: true, pts: pts, n: pts.length, firstDay: first.day, firstY: first.y, lastDay: last.day, lastY: last.y,
      gains: gains, slopeA: Math.round(slopeA * 100) / 100, slopeB: Math.round(slopeB * 100) / 100,
    };
  }
  function trendReach(t, slope, goal) {
    if (!t.ok || !isFinite(slope) || slope <= 0) return null;
    return fmtDay(t.pts[t.pts.length - 1].t + (goal - t.lastY) / slope);
  }
  function fansForecastCalc(rows) {
    var t = trendCalc(rows, 'fans', '粉丝数');
    if (!t.ok) return t;
    t.d5kA = trendReach(t, t.slopeA, 5000);
    t.d10kA = trendReach(t, t.slopeA, 10000);
    t.d5kB = trendReach(t, t.slopeB, 5000);
    t.d10kB = trendReach(t, t.slopeB, 10000);
    return t;
  }
  function effForecastCalc(rows) {
    var t = trendCalc(rows, 'eff', '有效曝光累计读数');
    if (!t.ok) return t;
    t.d500kA = trendReach(t, t.slopeA, 500000);
    t.d500kB = trendReach(t, t.slopeB, 500000);
    return t;
  }
  function forecastChart(f, cap, title, cls) {
    if (!f || !f.ok) return null;
    var anchor = f.pts[f.pts.length - 1];
    var proj = function (slope) {
      if (!isFinite(slope) || slope <= 0) return null;
      var tEnd = anchor.t + Math.min((cap - anchor.y) / slope, 45);
      return [{ x: anchor.t * 86400000, y: anchor.y }, { x: tEnd * 86400000, y: anchor.y + slope * (tEnd - anchor.t) }];
    };
    return chartSpec({
      title: title, unit: '个',
      series: [
        { label: '实际', cls: cls || 'c1', pts: f.pts.map(function (p) { return { x: p.t * 86400000, y: p.y }; }) },
        { label: 'A 全期拟合', cls: 'c2', pts: proj(f.slopeA) || [] },
        { label: 'B 近3天节奏', cls: 'c3', pts: proj(f.slopeB) || [] },
      ],
      xfmt: mdOf,
    });
  }
  function reachRow(label, f, da, db, goal, tip) {
    var hit = !!(f && f.ok && f.lastY >= goal);
    return row(label,
      f && f.ok ? ('A（+' + f.slopeA + '/日）→ ' + (da || '按这个趋势到不了') + '　B（+' + f.slopeB + '/日）→ ' + (db || '按这个趋势到不了') + (hit ? '（已达标）' : ''))
        : (f ? f.why : '没有数据'),
      (f && f.ok && (da || hit)) ? 'ok' : 'warn', tip);
  }
  function fansForecastLines(st) {
    var rows = (impRows(st, 0) || []).slice(-365);
    var fans = fansForecastCalc(rows);
    var eff = effForecastCalc(rows);
    var rate = null;
    for (var i = rows.length - 1; i >= 0; i--) { if (rows[i].rate != null) { rate = rows[i].rate; break; } }
    var out = [];
    // 三个到达日钉在最前面（用户裁定 2026-10-25）：50 万有效曝光 → 5,000 粉 → 10,000 粉
    out.push(reachRow('50 万有效曝光（奖励门槛）', eff, eff.ok ? eff.d500kA : null, eff.ok ? eff.d500kB : null, 500000,
      'A/B 两条外推咬的是奖励页 90 天滚动累计读数（T+1：今天的数据明天 10 点后才出）的日线。\n当前转化率 ' + (rate == null ? '—' : rate + '%') +
      '：有效曝光 = 总曝光 × 转化率，转化率往下掉这个日期就往后推。\n注意 90 天窗口另一头会掉天数出去，读数可能不升反降——外推偏乐观，以奖励页实读为准。'));
    out.push(reachRow('5,000 粉丝', fans, fans.ok ? fans.d5kA : null, fans.ok ? fans.d5kB : null, 5000,
      'A = 对全部日点做最小二乘，早期冲得猛时会偏乐观；B = 最近 3 个间隔的平均日增，偏保守。真值大概率落在两者之间。'));
    out.push(reachRow('10,000 粉丝', fans, fans.ok ? fans.d10kA : null, fans.ok ? fans.d10kB : null, 10000,
      '数据越少外推越虚：多攒几天再回来看，预测自己会跟着新点收紧。'));
    var fChart = forecastChart(fans, 10000, '粉丝数折线 + 到 5,000 / 10,000 的两条外推（A 乐观 / B 保守；新数据一到自动重算）');
    if (fChart) out.push(fChart);
    if (fans.ok) {
      out.push(line('粉丝日增：' + fans.gains.map(function (g) { return g.day.slice(5) + ' +' + g.gain; }).join('，') +
        '　（末点 ' + fans.lastDay.slice(5) + ' = ' + fans.lastY.toLocaleString() + '，起点 ' + fans.firstDay.slice(5) + ' = ' + fans.firstY.toLocaleString() + '）'));
    }
    var eChart = forecastChart(eff, 500000, '有效曝光累计读数折线 + 到 50 万的两条外推（奖励页 90 天滚动读数，T+1）', 'c2');
    if (eChart) out.push(eChart);
    if (eff.ok) {
      out.push(line('读数日增：' + eff.gains.map(function (g) { return g.day.slice(5) + ' +' + g.gain; }).join('，') +
        '　（末点 ' + eff.lastDay.slice(5) + ' = ' + eff.lastY.toLocaleString() + '，距 50 万还差 ' + Math.max(0, 500000 - eff.lastY).toLocaleString() + '）' +
        (rate == null ? '' : '　当前转化率 ' + rate + '%')));
    }
    out.push(line('纯外推，不改任何东西：涨粉/曝光都有波动，日期是「保持这条斜率」的推算，不是承诺。', 'warn'));
    return out;
  }
  // v0.8.1-r 「我的」页顶部的可复制日志摘要（用户裁定格式 2026-10-25）：纯文本进 textarea，复制出去直接贴。
  // 日期按本机时区的日点口径（与 dayOfTs 同源）；万粉/工资日期复用预测那两条外推（A 乐观 ~ B 保守，同日只出一个）。
  function dayShift(off) {
    var d = new Date(); d.setDate(d.getDate() + off);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function digestReach(f, a, b) {
    if (!f || !f.ok) return '点不够';
    if (a == null && b == null) return '按这个趋势到不了';
    if (a == null) return b.slice(5);
    if (b == null) return a.slice(5);
    return a === b ? a.slice(5) : a.slice(5) + '~' + b.slice(5);
  }
  function mineDigestText(st) {
    var rows = (impRows(st, 0) || []).slice(-365);
    var byRate = {}, byFans = {};
    rows.forEach(function (r) {
      if (r.rate != null) byRate[r.day] = r.rate;
      if (r.fans != null) byFans[r.day] = r.fans;
    });
    var fans = fansForecastCalc(rows), eff = effForecastCalc(rows);
    var rateTxt = function (v) { return v == null ? '—' : v + '%'; };
    var fansTxt = function (v) { return v == null ? '—' : v.toLocaleString(); };
    return dayShift(0).slice(2).replace(/-/g, '') + '日志\n' +
      '转化率：昨天 ' + rateTxt(byRate[dayShift(-1)]) + '，前天 ' + rateTxt(byRate[dayShift(-2)]) + '，大前天 ' + rateTxt(byRate[dayShift(-3)]) + '\n' +
      '粉丝数：今天 ' + fansTxt(byFans[dayShift(0)]) + '，昨天 ' + fansTxt(byFans[dayShift(-1)]) + '，前天 ' + fansTxt(byFans[dayShift(-2)]) + '\n' +
      '万粉 预测日期：' + digestReach(fans, fans.ok ? fans.d10kA : null, fans.ok ? fans.d10kB : null) + '\n' +
      '拿到工资预测日期：' + digestReach(eff, eff.ok ? eff.d500kA : null, eff.ok ? eff.d500kB : null);
  }
  // v0.8.1-s 日报（用户裁定 2026-10-25 六行格式，直接复制贴出去）：
  // 新朋友 = 首页进度条同款口径（页面「正在关注」读数差：今天基线 → 现在 latest 分钟点；不用台账——台账漏计）；
  // 评论数没有采集来源（reply 指标都是别人帖子的）⇒ sidepanel 手填一格传进来，null 如实「—」；
  // 三个预测日期咬预测外推的 A（全期拟合）：50万只说年月，5千/一万说到日；测不出来如实「还没测出来」。
  function repDate(iso, mode) {
    return mode === 'ym' ? iso.slice(2, 4) + '年' + Number(iso.slice(5, 7)) + '月'
      : Number(iso.slice(5, 7)) + '月' + Number(iso.slice(8, 10)) + '日';
  }
  function todayGain(st) {
    var gt = (st.guard || {}).goalToday;
    var min = (st.series || {}).min || [];
    var today = dayOfTs(Date.now());
    var pts = min.filter(function (p) { return p && p.following != null && dayOfTs(p.ts) === today; });
    var cur = pts.length ? pts[pts.length - 1].following : null;
    var base = gt && gt.baseSrc === 'hand' ? gt.base : (pts.length ? pts[0].following : null);
    return (cur != null && base != null) ? cur - base : null;
  }
  function mineReportText(st, repl) {
    var rows = (impRows(st, 0) || []).slice(-365);
    var fans = fansForecastCalc(rows), eff = effForecastCalc(rows);
    var rate = null;
    for (var i = rows.length - 1; i >= 0; i--) { if (rows[i].rate != null) { rate = rows[i].rate; break; } }
    var gain = todayGain(st);
    return '认认真真认识了' + (gain == null ? '—' : gain.toLocaleString()) + '个新朋友\n' +
      '认认真真评论了' + (repl == null ? '—' : Number(repl).toLocaleString()) + '个评论\n' +
      '最新转化率' + (rate == null ? '—' : rate + '%') + (rate != null && rate < 15 ? '希望明天破15%' : '') + '\n' +
      '50万曝光预测到' + (eff.ok && eff.d500kA ? repDate(eff.d500kA, 'ym') + '了' : '……还没测出来') + '\n' +
      '5000粉丝预测到' + (fans.ok && fans.d5kA ? repDate(fans.d5kA, 'md') : '……还没测出来') + '\n' +
      '一万粉丝预测需要到' + (fans.ok && fans.d10kA ? repDate(fans.d10kA, 'md') : '……还没测出来');
  }
  // v0.6.9 收尾：日点表从「只有曝光」扩成四列（曝光/关注/粉丝/帖子）。
  // 数据从三处合成：日点行（手填四列都在行上）+ 分钟线（按天聚合出当日的关注/粉丝，今天的关注给「最高」）。
  // 纯函数：sidepanel 只照着 txt 拼串。行宇宙 = imp 点的天 ∪ 分钟线有点的天 —— 只有分钟点的日子照样进表，
  // 不然「装插件当天还没进过奖励页」那天整行消失，四列里能看的那两列就看不见了。
  function dayOfTs(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function impRows(st, cap) {
    var s = (st && st.series) || {};
    var mins = s.min || [];
    var per = {};
    mins.forEach(function (p) {
      if (!p || p.ts == null) return;
      var d = dayOfTs(p.ts);
      var cur = per[d] || (per[d] = { maxF: null, lastF: null, lastFans: null });
      if (p.following != null) { if (cur.maxF == null || p.following > cur.maxF) cur.maxF = p.following; cur.lastF = p.following; }
      if (p.followers != null) cur.lastFans = p.followers;
    });
    var today = mins.length ? dayOfTs(mins[mins.length - 1].ts) : '';
    var days = {};
    (s.imp || []).forEach(function (p) { if (p && p.day) days[p.day] = p; });
    Object.keys(per).forEach(function (d) {
      if (!days[d]) days[d] = { day: d, value: null, exact: false, token: '', eff: null, effExact: false, effToken: '', fow: null, fans: null, posts: null };
    });
    // 奖励页的「有效曝光」是 90 天滚动累计读数，不是当日数（用户裁定 2026-10-25：当日 = 本行读数 − 前一日读数，
    // 转化率 = 当日差分 ÷ 当日曝光）。差分必须在截断之前对全量键算，不然 cap 一切，最早可见行就没有前一行了。
    // 只认严格前一天：中间缺一天的话差出来是两天的和，摆上去就是假精度。
    var keys = Object.keys(days).sort();
    var prevEff = {};
    keys.forEach(function (d, i) {
      if (!i) return;
      var pd = keys[i - 1];
      if ((Date.parse(d + 'T00:00:00Z') - Date.parse(pd + 'T00:00:00Z')) === 86400000) prevEff[d] = days[pd];
    });
    return keys.slice(-(cap || 15)).map(function (d) {
      var p = days[d], m = per[d];
      // v0.6.11：日点表里现在也会有「自动采」的关注/粉丝（打开主页就落一行），所以存值不再等于「手工补录」。
      // 今天这行仍优先用分钟线 —— F3 的「当日最高」口径长在分钟线上，日点值只当兜底；
      // 历史行反过来，存了什么就是什么（分钟线只留 24 小时，拿它盖用户补的历史 = 再犯一次「整行覆盖抹掉一列」）
      var mF = m ? (d === today ? m.maxF : m.lastF) : null;
      var mFan = m ? m.lastFans : null;
      var useMin = d === today && mF != null;
      var fowHow = useMin ? 'max' : (p.fow != null ? 'day' : (mF != null ? 'last' : ''));
      var fow = useMin ? mF : (p.fow != null ? p.fow : (mF != null ? mF : null));
      var fans = (d === today && mFan != null) ? mFan : (p.fans != null ? p.fans : mFan);
      // 当日有效曝光 = 本行 90 天累计读数 − 前一日读数（前置件是严格前一天那行也有读数）
      var pe = prevEff[d];
      var effDay = (p.eff != null && pe && pe.eff != null) ? p.eff - pe.eff : null;
      var effDayExact = effDay != null && !!p.effExact && !!pe.effExact;
      return {
        day: d,
        // v0.8.1 第一列改 YYMMDD 短格式（261025），只改显示——存值与补录校验仍是完整 YYYY-MM-DD
        dayDisp: d.replace(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/, '$1$2$3'),
        imp: p.value, exact: !!p.exact, token: p.token || '',
        impTxt: p.value == null ? '—' : impFmt(p.value, !!p.exact),
        // v0.7.2：有效曝光（奖励页 T+1，effAt = 落账时刻）与实时曝光（分析页）拆两列；
        // v0.8.1-g 口径修正：eff 存的是 90 天滚动累计读数，对外展示一律用差分出来的 effDay
        eff: p.eff, effExact: !!p.effExact, effToken: p.effToken || '', effAt: p.effAt || '',
        effDay: effDay, effDayExact: effDayExact,
        effTxt: effDay == null ? '—' : impFmt(effDay, effDayExact),
        rate: (effDay != null && p.value != null && Number(p.value) > 0) ? Math.round(effDay / p.value * 1000) / 10 : null,
        rateTxt: (effDay == null || p.value == null || !(Number(p.value) > 0)) ? '—' : (Math.round(effDay / p.value * 1000) / 10 + '%'),
        fow: fow, fowHow: fowHow,
        fowTxt: fow == null ? '—' : (fowHow === 'max' ? '最高 ' + nf(fow) : nf(fow)),
        fans: fans, fansTxt: fans == null ? '—' : nf(fans),
        posts: p.posts == null ? null : p.posts, postsTxt: p.posts == null ? '—' : nf(p.posts),
        // 「这行补过」只能靠曝光列的 manual 来源和帖子数列判 —— 关注/粉丝两列 v0.6.11 起自动采也会写，
        // 再拿 p.fow!=null 当手补标记，全自动的行也会挂 [补]（那就是假账）
        hand: p.token === 'manual' || p.effToken === 'manual' || p.posts != null,
      };
    });
  }

  // v0.6.11 排名：每人只看最新一行 + 与上一行的净增。数据来自 core 的 seriesForPanel().rank
  // （core 只带每人最后两行，不搬分钟线），这里只翻译、不排序以外的加工。
  // 可比的只有关注/粉丝：曝光是奖励页专属数字，别人的主页 DOM 里没有 ⇒ 那一列除 own 之外恒为空；
  // 帖子数 X 不提供，只能手补 ⇒ 拿它排名等于拿「谁勤快填表」排名。这两句要写在标题里，否则用户会以为表坏了。
  var RANK_NUM = ['imp', 'fow', 'fans', 'posts'];
  var RANK_LABEL = { imp: '曝光', fow: '关注', fans: '粉丝', posts: '帖子' };
  function rankRow(it, now) {
    var l = it.last || {}, p = it.prev || {};
    var num = function (k) { return l[k] == null ? null : Number(l[k]); };
    var d = function (k) { return l[k] == null || p[k] == null ? null : Number(l[k]) - Number(p[k]); };
    var ageH = it.at ? Math.max(0, Math.round((now - it.at) / 3600000 * 10) / 10) : null;
    return {
      h: it.h, own: it.own ? 1 : 0, at: it.at || 0, day: l.day || '',
      imp: num('value'), fow: num('fow'), fans: num('fans'), posts: num('posts'),
      dFow: d('fow'), dFans: d('fans'), dImp: d('value'), dPosts: d('posts'),
      exact: !!l.exact, ageH: ageH, prevDay: p.day || '',
      ageTxt: ageH == null ? '-' : (ageH < 1 ? '刚才' : (ageH < 48 ? Math.round(ageH) + ' 小时前' : Math.round(ageH / 24) + ' 天前')),
      stale: ageH == null || ageH > 48 ? 1 : 0,
    };
  }
  function rankRows(st, sortBy, asc, now) {
    var s = (st && st.series) || {};
    var t = now == null ? Date.now() : now;
    var list = (s.rank || []).map(function (it) { return rankRow(it, t); });
    var key = RANK_NUM.indexOf(sortBy) >= 0 ? sortBy : 'fans';
    list.sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (va == null && vb == null) return a.h < b.h ? -1 : a.h > b.h ? 1 : 0;
      if (va == null) return 1;                     // 空值恒排最后：升序降序都不许让「没数」冒充「最小」
      if (vb == null) return -1;
      return (va - vb) * (asc ? 1 : -1) || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0);
    });
    list.forEach(function (r, i) { r.rank = i + 1; });
    return list;
  }
  function rankNode(st, sortBy, asc, now, limit) {
    var key = RANK_NUM.indexOf(sortBy) >= 0 ? sortBy : 'fans';
    var rows = rankRows(st, key, asc, now);
    var head = ['名次', 'handle', '最新一行', '曝光', '关注', '粉丝', '帖子', '较上行', '距今'];
    var base = { k: 'rank', head: head, cols: RANK_NUM, labels: RANK_LABEL, sortBy: key, asc: !!asc };
    if (!rows.length) {
      base.rows = [];
      base.title = '还没有第二个人的记录：打开他的主页，或在上方「看谁」里选一个 handle 后点「抓一个点」';
      return base;
    }
    var shown = rows.slice(0, limit || rows.length);
    base.rows = shown;
    base.more = Math.max(0, rows.length - shown.length);
    base.title = '按' + RANK_LABEL[key] + (asc ? '升序' : '降序') + '（点列头换排序）· 每人最新一行 · 共 ' + rows.length + ' 人' +
      (base.more > 0 ? '，先出前 ' + shown.length + '（「更多」每次 +10）' : '') + '；' +
      '曝光只有自己的号读得到（奖励页专属），帖子数只能手补 ⇒ 跨人真正可比的是关注/粉丝';
    return base;
  }


  // v0.6.12：原来的「趋势」一页把两套东西揉在一起（自己的曲线 + 所有人的排名）。用户的话：
  // 「这个东西其实是两套东西……而不是现在揉在一起」。拆成 mineLines（我自己的历史）与 plazaLines（广场：跨人排名与对比）
  var DAY_HEAD = ['日期', '有效曝光', '曝光', '转化率', '关注', '粉丝', '帖子'];   // 改列序只改这一处，面板只按 head 建列

  function ownRow(s) {
    var src = s.ownSet ? '设置里钉的' : (s.own ? '自动识别（侧栏「个人资料」那颗导航）' : '还不知道');
    return row('我的账号', '@' + (s.own || '(不知道)') + '　来源：' + src, s.own ? 'ok' : 'warn',
      '曝光数只在奖励页读得到、那页 URL 里没有 handle ⇒ 这个数记在谁名下全靠这一格。\n' +
      '认错了就到「设置 · 我的账号」里钉死它：钉了之后不再跟着 DOM 猜（留空 = 回到自动识别）。\n' +
      '钉新 handle 只决定「以后写谁」——旧数据仍留在它当初写入的那个 handle 名下，要去广场选中那个人自己补/删。');
  }
  // 日点表两页都发这一条消息，只有 who 不同。一行都没有时也必须把表发出去：旧写法零行时只 push 一句提示、
  // 网格根本不出现 ⇒ 装插件第一天/清空之后找不到任何能填的地方（v0.6.10 修的，拆页后两页都得守住）
  function impTable(who, st, extra) {
    var all = impRows(st, 0) || [];
    return {
      k: 'imps', who: who || '', rows: impRows(st, 15), head: DAY_HEAD,
      title: (extra || '') + (all.length
        ? '最近 ' + Math.min(15, all.length) + ' 天六列（有效曝光/曝光/转化率/关注/粉丝/帖子；关注·粉丝自动采，两列曝光与帖子靠采集或补录，同日有手填列标 [补]）\n'
          + '有效曝光 = 奖励页那个数（T+1：今天的数据明天 10 点后开页才有）；曝光 = 账号分析页的每日曝光（实时）；转化率 = 有效曝光 ÷ 曝光'
        : '还没有一行：点右边「编辑」把日子补进来（在奖励页/账号分析页点「抓一个点」会自动落数）'),
    };
  }

  function mineLines(st) {
    var out = [];
    var s = (st && st.series) || { min: [], imp: [], handles: [], counts: {} };
    var c = s.counts || {};
    var me = null;
    (s.handles || []).forEach(function (h) { if (h && h.own) me = h; });
    out.push(ownRow(s));
    out.push(line('采样口径：一分钟一个点，只在这页开着时采 ⇒ 曲线断了就是页面关了（MV3 的后台碰不到 x.com 的 DOM，这是选的形状）。\n' +
      '两个曝光都是每天一个点：有效曝光在奖励页开页自动采（T+1），实时曝光在账号分析页开页自动采（增量，同值跳过）；也能手工补录（日期 + 五列，同一天按列合并，可删点）。'));
    out.push(row('我的点位', '分钟 ' + ((me && me.min) || 0) + ' / 日 ' + ((me && me.imp) || 0) +
      '　全库 ' + (c.handles || 0) + ' 人（别人的在广场）' + (s.err ? ' · ' + s.err : ''), s.err ? 'bad' : 'ok',
      (s.handles || []).map(function (h) { return '@' + h.h + ' min' + h.min + ' imp' + h.imp; }).join('\n')));
    out.push(minChart(s.min));
    out.push(impChart(s.imp));
    out.push(impMultiChart(st));
    out.push(impRateChart(st));
    var imp = (s.imp || []).filter(function (p) { return p && p.value != null; });
    if (imp.length) {
      var lastP = imp[imp.length - 1], firstP = imp[0];
      var gain = lastP.value - firstP.value;
      out.push(line('曝光日线 ' + imp.length + ' 点：' + firstP.day + ' ' + nf(firstP.value) + ' → ' + lastP.day + ' ' + nf(lastP.value) +
        '（净增 ' + (gain >= 0 ? '+' : '') + nf(gain) + '）' +
        (lastP.exact ? '' : '  [末点是缩写值]') + '，门槛 50 万进度 ' +
        Math.round(lastP.value / 500000 * 1000) / 10 + '%'));
    }
    // 这一页的表恒是自己的：视线由面板钉在 own（广场才允许换人），所以 who 直接给 own
    out.push(impTable(s.own, st));
    var lr = s.lastRewards;
    if (st && st.tab === 'rewards') {
      out.push(row('本页曝光', lr ? (lr.hit ? nf(lr.value) + ' 次（' + (lr.text || lr.value) + (lr.exact ? ' 精确' : ' 缩写') + '）' : '没抠到数') : '还没采（点「采集本页」）',
        lr && lr.hit ? 'ok' : 'bad', lr && lr.key ? '关键词：' + lr.key : ''));
    }
    if (lr && lr.cands && lr.cands.length) {
      out.push(fold('取数证据 · 候选节点 (' + lr.cands.length + ')', JSON.stringify(lr.cands, null, 1)));
      out.push(line('这一版是宽松取数：同区域里第一个「不是门槛数字」的值就当数用，候选与 HTML 片段都回传日志。\n下一轮拿真机的 cands 把判据收成一条。'));
    }
    if (s.min && s.min.length) {
      var mn = s.min[s.min.length - 1];
      out.push(line('最后一个分钟点：' + (mn.at || '').slice(11, 19) + ' 关注 ' + (mn.following == null ? '-' : mn.following) + ' / 粉丝 ' + (mn.followers == null ? '-' : mn.followers)));
    }
    return out;
  }

  // ---------- v0.7.0 广场改读本机库：账号榜 + 帖子榜 + 建议 ----------
  // 浏览器存储只留运行态之后，跨人分析的真身在 xprobe.db。这里只翻译库里的两坨 rows，不重复算增速
  // （view_per_h / eng_rate / like_rate 都是库里的计算列）。
  var ACCT_SORT = ['views', 'eng', 'fans', 'posts'];
  var ACCT_LABEL = { views: '曝光（帖子合计）', eng: '互动', fans: '粉丝', posts: '帖数' };
  var POST_SORT = ['view', 'growth'];
  var POST_LABEL = { view: '曝光', growth: '每小时增长' };
  var REL_TXT = { following: '已关注', not_following: '未关注', self: '自己' };
  function numOf(v) { var n = Number(v); return v == null || v === '' || !isFinite(n) ? null : n; }
  // 帖子数两个口径（v0.8.1 裁定）：posts = 主页头部自报的总数（张三有两万就是两万），
  // posts_n = 库里归并到的已抓条数（只抓了 20 条就是 20）。榜面优先自报总数，没采到才用已抓数兜底并带 ~ 标记。
  function postsTotalOf(r) { return numOf(r.posts); }
  function postsCapturedOf(r) { return numOf(r.posts_n); }
  function postsDispOf(r) {
    var t = postsTotalOf(r), c = postsCapturedOf(r);
    return t != null ? t : (c != null ? c : null);
  }
  function postsMarkOf(r) { return postsTotalOf(r) == null && postsCapturedOf(r) != null ? '~' : ''; }
  function sortNum(list, key, asc, tie) {
    list.sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (va == null && vb == null) return tie(a, b);
      if (va == null) return 1;            // 空值恒垫底：升序也不许让「没数」冒充「最小」
      if (vb == null) return -1;
      return (va - vb) * (asc ? 1 : -1) || tie(a, b);
    });
    return list;
  }
  function tieHandle(a, b) { return a.h < b.h ? -1 : a.h > b.h ? 1 : 0; }
  function tieId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
  function relTxt(r) { return r.own ? '自己' : (REL_TXT[r.relation] || '—'); }
  function agoTxt(s, now) {
    if (!s) return '—';
    var t = Date.parse(String(s).replace(' ', 'T'));
    if (!isFinite(t)) return clip(s, 16);
    var h = Math.max(0, (now - t) / 3600000);
    return h < 1 ? Math.max(1, Math.round(h * 60)) + ' 分钟前'
      : h < 48 ? Math.round(h) + ' 小时前' : Math.round(h / 24) + ' 天前';
  }
  function acctRows(db, by) {
    var rows = (db && db.acct && db.acct.ok && db.acct.rows) || [];
    var key = ACCT_SORT.indexOf(by) >= 0 ? by : 'views';
    var list = rows.map(function (r) {
      var views = numOf(r.views), eng = numOf(r.eng);
      return {
        h: String(r.handle || ''), name: String(r.name || ''), own: r.own ? 1 : 0,
        relation: String(r.relation || ''), relationAt: String(r.relation_at || ''),
        views: views, eng: eng, fans: numOf(r.fans), posts: postsTotalOf(r), postsN: postsCapturedOf(r),
        rate: views != null && views > 0 && eng != null ? Math.round(eng / views * 10000) / 100 : null,
        lastPostAt: String(r.last_post_at || ''), day: String(r.day || ''),
        exposure: numOf(r.exposure), fow: numOf(r.fow), seenAt: String(r.seen_at || ''),
        blocked: r.blocked ? 1 : 0, blockedAt: String(r.blocked_at || ''),
      };
    });
    sortNum(list, key, false, tieHandle);
    list.forEach(function (r, i) { r.rank = i + 1; });
    return list;
  }
  function postRowOf(r) {
    return {
      id: String(r.tweet_id || ''), h: String(r.author || ''), text: String(r.text || ''),
      at: String(r.last_at || ''), view: numOf(r.view), eng: numOf(r.eng),
      engRate: numOf(r.eng_rate), likeRate: numOf(r.like_rate),
      gain: numOf(r.view_gain), hours: numOf(r.hours), perH: numOf(r.view_per_h),
      points: numOf(r.points),
    };
  }
  function postRows(db, by) {
    var rows = (db && db.post && db.post.ok && db.post.rows) || [];
    var key = POST_SORT.indexOf(by) >= 0 ? by : 'view';
    var kk = key === 'growth' ? 'perH' : 'view';
    var list = rows.map(postRowOf);
    sortNum(list, kk, false, tieId);
    list.forEach(function (r, i) { r.rank = i + 1; });
    return list;
  }
  function dbTable(o) {
    return {
      k: 'grid', cls: o.cls || '', title: o.title || '', head: o.head,
      cols: o.cols, labels: o.labels, sortBy: o.sortBy,
      rows: o.rows || [], empty: o.empty || '', note: o.note || '',
      more: o.more || 0,
      // 2026-11-13：标题与副信息分家（工作台卡片头左标题右副信息；面板窄则副信息另起一行）
      capMeta: o.capMeta || '',
      // 只有 cls:'tl' 的榜用：卡片数组（cards，sidepanel 画卡片不吃 head/rows）+ 日期下拉（days/day）与来源筛选（srcf）+ 排序键（sort）
      // 2026-11-13 修：这里原来写的是 `o.cards || []` —— **空数组是 truthy**，
      // 于是账号榜/帖子榜（不传 cards）也带着 cards:[] 进 kit.js 的 gridNode，
      // 被 `if (m.cards)` 判成「卡片榜」→ 走卡片分支 → head/rows 一行都不画，
      // 只剩一句「云端库里还没有…」（被 CSS 截成「云端库…」）。数据明明读回来了（状态行写着
      // 「读回 账号 50 人 / 帖子 50 条」），页面却是空的 —— 这就是广场一直不出表的真因。
      // 修法：不给 cards 就给 null（falsy），卡片榜才走卡片分支；tl 榜照旧（它传的是真数组）。
      cards: o.cards || null, sort: o.sort || '',
      days: o.days || [], day: o.day || '', srcf: o.srcf || '',
    };
  }
  // 账号一行：曝光 = 这人所有已抓到的帖子最新一点的曝光合计（不是奖励页那个数）；率都由库算好或这里按同一口径除
  // 分页（v0.8.1-t 用户裁定）：一次 10 条，「更多」按钮在 sidepanel（limit 由面板模块变量递增加进来）；
  // limit 不传 = 全量（老调用/自测不受影响），面板恒传当前已展开数。
  function acctTable(db, by, now, limit) {
    var isCloud = !!(db && db.via === 'cloud');
    var key = ACCT_SORT.indexOf(by) >= 0 ? by : 'views';
    var t = now == null ? Date.now() : now;
    var list = acctRows(db, key);
    var shown = list.slice(0, limit || list.length);
    var more = Math.max(0, list.length - shown.length);
    var rows = shown.map(function (r) {
      return {
        key: r.h, cls: r.own ? 'rankOwn' : '',
        tip: '@' + r.h + (r.name ? '（' + r.name + '）' : '') +
          (r.blocked ? '\n⛔ 已拉黑' + (r.blockedAt ? '（' + agoTxt(r.blockedAt, t) + '记的）' : '') + '：本机名单，只做标记不动 X' : '') +
          '\n关系：' + relTxt(r) + (r.relationAt ? '（确认于 ' + agoTxt(r.relationAt, t) + '）' : '（还没在页面上确认过）') +
          '\n最近发帖：' + (r.lastPostAt ? agoTxt(r.lastPostAt, t) : '—') +
          '\n日点最新一行：' + (r.day || '—') + ' 曝光 ' + (r.exposure == null ? '—' : nf(r.exposure)) +
          ' · 关注 ' + (r.fow == null ? '—' : nf(r.fow)) +
          '\n帖子：' + (r.posts != null ? '总数 ' + nf(r.posts) + '（主页头部自报，v0.8.1 起自动采）' : '总数还没采到（打开过谁的主页才有）') +
          '，已抓 ' + (r.postsN == null ? '0' : nf(r.postsN)) + ' 条' +
          '\n互动 = 赞+转+评+引+书签（这人的帖子各取最新一点再合计）；互动率 = 互动 / 曝光',
        cells: [
          { t: '#' + r.rank, c: 'giDay' },
          { t: '@' + r.h + (r.own ? ' *' : '') + (r.blocked ? ' ⛔已拉黑' : ''), c: 'rkH' },
          { t: relTxt(r), c: 'grel' },
          { t: r.views == null ? '—' : nf(r.views) },
          { t: r.eng == null ? '—' : nf(r.eng) },
          { t: r.rate == null ? '—' : r.rate + '%' },
          { t: r.fans == null ? '—' : nf(r.fans) },
          { t: r.posts == null ? (r.postsN == null ? '—' : nf(r.postsN) + '~') : nf(r.posts) },
        ],
      };
    });
    return dbTable({
      cls: 'acct', sortBy: key,
      head: ['名次', '账号', '关系', '曝光', '互动', '互动率', '粉丝', '帖数'],
      cols: [null, null, null, 'views', 'eng', null, 'fans', 'posts'],
      labels: ACCT_LABEL,
      more: more,
      title: '账号排名 · 按' + ACCT_LABEL[key] + '降序（点列头换排序）',
      capMeta: '本次读回 ' + list.length + ' 人' +
        (more > 0 ? ' · 榜先出前 ' + shown.length + '（更多每次 +10）' : ''),
      empty: isCloud
        ? '云端库里还没有账号数据：这些账号要在时间线/主页被采集后才会进智枢库（线上 PG）'
        : '本机库里还没有账号行：时间线/主页采几页就会自动进去（库是唯一真身，面板只读）',
      note: '帖数 = 主页头部自报的帖子总数（带 ~ 的是还没采到总数、用已抓到的条数兜底）；曝光是「已抓到帖子的曝光合计」，与奖励页那个账号曝光不是一个口径；互动率 = 互动/曝光。',
      rows: rows,
    });
  }
  function postTable(db, by, now, limit) {
    var isCloud = !!(db && db.via === 'cloud');
    var key = POST_SORT.indexOf(by) >= 0 ? by : 'view';
    var t = now == null ? Date.now() : now;
    var list = postRows(db, key);
    var shown = list.slice(0, limit || list.length);
    var more = Math.max(0, list.length - shown.length);
    var rows = shown.map(function (p) {
      return {
        key: p.id,
        tip: '@' + p.h + (p.at ? ' · 最新一点 ' + agoTxt(p.at, t) : '') +
          '\n互动 ' + (p.eng == null ? '—' : nf(p.eng)) +
          ' · 互动率 ' + (p.engRate == null ? '—' : p.engRate + '%') +
          ' · 点赞率 ' + (p.likeRate == null ? '—' : p.likeRate + '%') +
          '\n采样 ' + (p.points == null ? '—' : p.points) + ' 点 · 曝光较首次 ' +
          (p.gain == null ? '—' : (p.gain >= 0 ? '+' : '') + nf(p.gain)) +
          (p.hours == null ? '' : ' / ' + Math.round(p.hours * 10) / 10 + ' 小时') +
          (p.perH == null ? '\n每小时增长算不出：只有一个采样点（不是 0）' : ''),
        cells: [
          { t: '#' + p.rank, c: 'giDay' },
          { t: '@' + p.h, c: 'rkH' },
          { t: clip(p.text || '(无正文)', 44), c: 'gtxt' },
          { t: p.view == null ? '—' : nf(p.view) },
          { t: p.perH == null ? '—' : nf(p.perH) },
        ],
      };
    });
    return dbTable({
      cls: 'post', sortBy: key,
      head: ['名次', '作者', '正文', '曝光', '+每小时'],
      cols: [null, null, null, 'view', 'growth'],
      labels: POST_LABEL,
      more: more,
      title: '帖子排名 · 按' + POST_LABEL[key] + '降序（点列头换排序）',
      capMeta: '一条帖子一行，共 ' + list.length + ' 条' +
        (more > 0 ? ' · 榜先出前 ' + shown.length + '（更多每次 +10）' : ''),
      empty: isCloud
        ? '云端库里还没有帖子数据：帖子要在时间线或详情页被采集后才会进智枢库（线上 PG）'
        : '本机库里还没有帖子：时间线或详情页采一次就会按 tweet_id 归并进来',
      note: '每帖取最新一点；每小时增长 =（最新−首次曝光）/ 相隔小时，只有一个采样点时是「—」不是 0。',
      rows: rows,
    });
  }
  // v0.8.2 时间线曝光排序（k:'grid' cls:'tl'）：某天、按「看到它时主页停在哪个时间线 tab」分源，按曝光降序。
  // 来源 = core 快照里的 tlSrc（为你推荐→foryou / 正在关注→following），库端已按 每帖×天×源 取曝光数最新一点。
  // 「看到于」就是推荐时间的近似口径：在为你推荐里第一次采到它的时刻——X 没把真正的推荐时刻写进 DOM，我们只记自己看到的。
  var TL_SRC_LABEL = { foryou: '为你推荐', following: '正在关注' };
  function tlRaw(db) {
    return db && db.tl && Array.isArray(db.tl.rows) ? db.tl.rows.filter(function (r) { return r && r.tweet_id; }) : [];
  }
  function tlDays(db) {
    var rs = db && db.tlDays && Array.isArray(db.tlDays.rows) ? db.tlDays.rows : [];
    var out = [], seen = {};
    rs.forEach(function (r) { if (r && r.day && !seen[r.day]) { seen[r.day] = 1; out.push(r.day); } });
    return out;
  }
  function tlTable(db, o) {
    o = o || {};
    var t = o.now == null ? Date.now() : o.now;
    var all = tlRaw(db);
    var days = tlDays(db);
    var day = o.day || '';
    var list = o.srcf ? all.filter(function (r) { return r.tl_src === o.srcf; }) : all;
    // 排序键（v0.8.2 用户裁定）：曝光或评论——两数来自同一次抓取的点，不会混着算；客户端重排，同 srcf 一个路数
    var sortK = o.sort === 'reply' ? 'reply' : 'view';
    list.sort(function (a, b) {
      return (b[sortK] || 0) - (a[sortK] || 0) || (b.view || 0) - (a.view || 0) ||
        String(a.tweet_id).localeCompare(String(b.tweet_id));
    });
    var shown = list.slice(0, o.limit || list.length);
    var more = Math.max(0, list.length - shown.length);
    // 当天各源的合计（来自 tl_days 查询）打进标题：一眼看到「这天为时间线一共刷到多少曝光」
    var tot = {};
    (db && db.tlDays && Array.isArray(db.tlDays.rows) ? db.tlDays.rows : []).forEach(function (r) {
      if (r && r.day === day) tot[r.tl_src] = r;
    });
    var totTxt = Object.keys(tot).map(function (k) {
      return (TL_SRC_LABEL[k] || k) + ' ' + nf(tot[k].n) + ' 条 / ' + impFmt(tot[k].views, false);
    }).join(' · ');
    // 卡片样式（用户裁定 2026-10-26）：正文当主视觉，作者/来源收进悬浮；点卡片跳原帖。
    // 帖子链接库里的 href 不在 tl_rank 视图里，但 author+tweet_id 就能拼出规范地址（老推同理，X 会自己归一）。
    var cards = shown.map(function (r, i) {
      var au = r.author || '';
      return {
        key: r.tweet_id,
        rank: '#' + (i + 1),
        href: au ? 'https://x.com/' + au + '/status/' + r.tweet_id : 'https://x.com/i/web/status/' + r.tweet_id,
        author: au || '?',
        src: TL_SRC_LABEL[r.tl_src] || r.tl_src || '—',
        view: r.view == null ? '—' : nf(r.view),
        reply: r.reply == null ? '—' : nf(r.reply),
        hm: hmOf(Date.parse(r.at)),
        text: clip(r.text || '(无正文)', 80),
        tip: '@' + (au || '?') + '\n曝光 ' + (r.view == null ? '—' : nf(r.view)) +
          ' · 评论 ' + (r.reply == null ? '—' : nf(r.reply)) +
          ' · 看到 ' + agoTxt(Date.parse(r.at), t) +
          '\n来源 ' + (TL_SRC_LABEL[r.tl_src] || r.tl_src || '—') +
          (r.tl_src === 'foryou' ? '（推荐时刻 ≈ 看到它的时刻：X 不在页面上写真正的推送时间，我们不编）' : '') +
          '\n点击卡片跳原帖\n正文：' + (r.text || '(无正文)'),
      };
    });
    return dbTable({
      cls: 'tl', cards: cards, rows: [], sort: sortK,
      more: more, days: days, day: day, srcf: o.srcf || '',
      title: '时间线曝光排序 · ' + (day || '（选日期）') + (totTxt ? ' · ' + totTxt : '') +
        ' · 共 ' + list.length + ' 条' + (more > 0 ? '，榜先出前 ' + shown.length + '（「更多」每次 +10）' : ''),
      empty: '这天还没有「为你推荐 / 正在关注」的时间线曝光记录：打开 x.com/home 挂一会儿（被动补采自己会采），或换个日子',
      note: '口径：来源 = 采到这份快照时主页时间线停在哪个 tab（v0.8.2 起随采集落库，此前历史行由库迁移从快照的 tab 状态回填）；每帖每天每源取曝光数最新的一点；「看到于」= 采到它的时刻，为你推荐源的它就是推荐时间的近似——X 没把真正的推荐时刻写进页面，我们不编。点卡片跳原帖，作者与来源悬浮时显示。',
    });
  }
  // 时间线卡片点昵称（v0.8.2 用户裁定 2026-10-26）：author_posts 回包（post_growth 一帖一行、库已按曝光降序）→ 展示行。
  // 展示层只管 nf/hm/clip/跳转地址；排序相信 SQL，不在这里重排两套口径。
  function tlUserRows(res) {
    var rows = res && Array.isArray(res.rows) ? res.rows.filter(function (r) { return r && r.tweet_id; }) : [];
    return rows.map(function (r) {
      var au = r.author || '';
      return {
        key: r.tweet_id,
        href: au ? 'https://x.com/' + au + '/status/' + r.tweet_id : 'https://x.com/i/web/status/' + r.tweet_id,
        view: r.view == null ? '—' : nf(r.view),
        reply: r.reply == null ? '—' : nf(r.reply),
        hm: hmOf(Date.parse(r.last_at)),
        text: clip(r.text || '(无正文)', 60),
        eng: r.eng == null ? '' : nf(r.eng),
      };
    });
  }
  // 建议名单：只用「关系已确认」的人（时间线不画关注按钮时关系是空的，空不许猜成未关注）
  function dbSuggest(db) {
    var accts = acctRows(db, 'views');
    var rel = {};
    accts.forEach(function (r) { rel[r.h] = r.own ? 'self' : r.relation; });
    // 有帖子可谈 = 总数采到了，或至少抓到过他一条帖子（v0.8.1 前只看已抓数，总数这条路通了以后两者都认）
    var hasPosts = function (r) { return r.posts != null ? r.posts > 0 : (r.postsN != null && r.postsN > 0); };
    var follow = accts.filter(function (r) { return !r.own && r.relation === 'not_following' && hasPosts(r); });
    sortNum(follow, 'eng', false, tieHandle);
    var unfollow = accts.filter(function (r) { return !r.own && r.relation === 'following' && hasPosts(r); });
    sortNum(unfollow, 'eng', true, function (a, b) {
      if (a.fans == null && b.fans == null) return tieHandle(a, b);
      if (a.fans == null) return 1;
      if (b.fans == null) return -1;
      return (a.fans - b.fans) || tieHandle(a, b);
    });
    var posts = ((db && db.post && db.post.ok && db.post.rows) || []).map(postRowOf)
      .filter(function (p) { return rel[p.h] === 'not_following'; });
    sortNum(posts, 'eng', false, tieId);
    return { follow: follow.slice(0, 8), unfollow: unfollow.slice(0, 8), posts: posts.slice(0, 8) };
  }
  function dbSuggestLines(db) {
    var sg = dbSuggest(db);
    var n = function (v) { return v == null ? '—' : nf(v); };
    var out = [];
    out.push(fold('最该关注的人 (' + sg.follow.length + ')', sg.follow.length ? sg.follow.map(function (r, i) {
      return '#' + (i + 1) + ' @' + r.h + (r.name ? '（' + r.name + '）' : '') +
        '　互动 ' + n(r.eng) + ' · 曝光 ' + n(r.views) + ' · 互动率 ' + (r.rate == null ? '—' : r.rate + '%') +
        ' · 帖 ' + (r.posts != null ? n(r.posts) : (r.postsN != null ? n(r.postsN) + '~' : '—')) + ' · 粉丝 ' + n(r.fans);
    }).join('\n') : '没有候选：要「页面上明确确认过未关注」且抓到过帖子的人才进名单（关系未知的不猜）。'));
    out.push(fold('最该看 / 转的帖子（未关注的人）(' + sg.posts.length + ')', sg.posts.length ? sg.posts.map(function (p, i) {
      return '#' + (i + 1) + ' @' + p.h + '　' + clip(p.text || '(无正文)', 60) +
        '\n　　互动 ' + n(p.eng) + ' · 曝光 ' + n(p.view) +
        ' · 互动率 ' + (p.engRate == null ? '—' : p.engRate + '%') + ' · 点赞率 ' + (p.likeRate == null ? '—' : p.likeRate + '%');
    }).join('\n') : '没有候选：要么都关注了，要么还没抓到「关系已确认未关注」的人发的帖子。'));
    out.push(fold('最该取关的人 (' + sg.unfollow.length + ')', sg.unfollow.length ? sg.unfollow.map(function (r, i) {
      return '#' + (i + 1) + ' @' + r.h + (r.name ? '（' + r.name + '）' : '') +
        '　互动 ' + n(r.eng) + ' · 粉丝 ' + n(r.fans) + ' · 帖 ' + (r.posts != null ? n(r.posts) : (r.postsN != null ? n(r.postsN) + '~' : '—')) +
        ' · 最近发帖 ' + (r.lastPostAt ? agoTxt(r.lastPostAt, Date.now()) : '—');
    }).join('\n') : '没有候选：要「页面上明确确认过已关注」且抓到过帖子的人才进名单。'));
    out.push(line('建议只列不动作：面板不点关注、不点取关，也不改页面 —— 关注前自己点开看一眼，取关永远由你手动做。\n' +
      '排序口径：关注看「互动」高；取关看「互动」低（再按粉丝少）；关系未知一律不进名单。'));
    return out;
  }
  // 库没通时明说「读不到」和怎么修（扩展 ID 用来装原生宿主），不让一张空表冒充「没有数据」
  function dbStateRowRaw(db, now) {
    var id = (db && db.id) || '';
    var isCloud = !!(db && db.via === 'cloud');
    var srcLabel = isCloud ? '云端（智枢）' : '本机库 xprobe.db';
    var remedyLocal = '广场的两张榜直接读本机档案库 xprobe.db（Chrome 扩展不能直接开 SQLite，只能经原生宿主或本机 sink）。\n' +
      '装一次原生宿主（之后不用再开 bat）：\n  py -3 native\\install-host.py --ext-id ' + (id || '<扩展ID>') + '\n' +
      '不装也行：双击 start-sink.bat 走 HTTP 回退，读的是同一份库。\n' +
      '扩展 ID 也能在 chrome://extensions 的详情里看到。';
    var remedyCloud = '云端档读的是智枢线上 PG（前端智枢网关转发到 Go）。读不到先确认：①这一档已登录（右上角「登录」）；②网关 localhost:3100（开发）或 zhishu.mingzhang.cc（线上）在跑。';
    var remedy = isCloud ? remedyCloud : remedyLocal;
    if (!db) return row(srcLabel, '正在读…（账号 + 帖子两条查询）', 'warn', remedy);
    var a = db.acct || {}, p = db.post || {};
    var raw = String((!a.ok ? a.err : '') || (p.err || '') || '');
    // v0.12.18（真机 2026-11-13）：诊断按「哪一层断了」分家，不再一刀切。
    // 云端档 fetch 失败同样写着 "Failed to fetch"，旧版一律报「宿主未注册 + sink 未启动」，
    // 把人往完全相反的方向引（宿主当时其实在写库）；8765 被别的服务占了回的 "Not Found"
    // 也会被旧正则吞成同一句。只有真的两条本机通道都没应答时，才说那句话。
    var cloudFail = /云端|zhishu\.mingzhang\.cc|localhost:3100|127\.0\.0\.1:8080/i.test(raw);
    var portFail = /回包不是 JSON|回来的不是 JSON|unknown path/i.test(raw);
    var slowFail = /8 秒没回|超时|timeout/i.test(raw);
    var via = db.via === 'native' ? 'Native' : (db.via === 'http' ? 'HTTP'
      : (db.via === 'cloud' || cloudFail ? '云端' : '未定'));
    if (!a.ok || !p.ok) {
      // 两波读取：第一波账号先出、帖子榜还在加载（err 标记「加载中」），此时不该报红灯
      if ((!a.ok && /加载中/.test(a.err || '')) || (!p.ok && /加载中/.test(p.err || ''))) {
        return row(srcLabel, '加载中…（账号/帖子榜读取中）', 'warn', remedy);
      }
      var err = (!a.ok ? '账号 ' + clip(a.err || '?', 34) : '') +
        (!p.ok ? (a.ok ? '' : ' · ') + '帖子 ' + clip(p.err || '?', 34) : '');
      var down = /Failed to fetch|native messaging host|Native host has exited|not found/i;
      var both = !cloudFail && !portFail && !slowFail &&
        ((!a.ok && down.test(a.err || '')) || (!p.ok && down.test(p.err || '')));
      if (cloudFail) err = '云端档没连上（' + clip(raw, 62) + '）—— 本机宿主/sink 与这趟无关';
      else if (portFail) err = '本机 8765 回的不是探针 sink（端口被别的服务占了，或 sink 版本旧）：' + clip(raw, 44);
      else if (slowFail) err = clip(raw, 62) + (isCloud ? '（云端读口慢，不是通道断）' : '（本机库聚合视图慢，不是通道断）');
      else if (both) err = '两个通道都没通（宿主未注册 + sink 未启动）';
      return row(srcLabel, '读不到 · ' + err + ' · 通道 ' + via, 'bad',
        remedy + '\n最近一次原始报错：' + clip((!a.ok ? a.err : '') || (p.err || ''), 90) +
        (db.native && db.native.ok === false && db.native.err ? '\n宿主最近一次报错：' + clip(db.native.err, 90) : ''));
    }
    var ms = Number(db.ms) || 0;
    return row(srcLabel, '通道 ' + via + ' · 读回 账号 ' + (a.rows || []).length + ' 人 / 帖子 ' +
      (p.rows || []).length + ' 条 · ' + (ms ? ms + 'ms · ' : '') + '读于 ' + hmOf(db.at || now || Date.now()), 'ok',
      '进广场会自动读，之后每 30 秒（或点「重读库」）刷新；只读：本页不往库里写任何东西。\n' + remedy);
  }

  // 2026-11-13：通道状态行单独一个 class（工作台里给它一条横幅皮肤：body.dash .row.dChan）。
  // D-9：这一行必须一眼看清「当下这一个数 + 它是哪一档」——工作台里它不是普通行，是状态条。
  function dbStateRow(db, now) {
    var r = dbStateRowRaw(db, now);
    if (r) r.cls = 'dChan';
    return r;
  }

  // 广场：本机库两张榜（账号 / 帖子）+ 建议名单打头；选中某个人时再挂一张他的日点表。
  // 这里没有分钟线也没有曝光图 —— 别人的分钟线根本不采（把陌生人的数写进 own 的序列是上一轮那条脏数据的同族）
  function plazaLines(st, opts) {
    var o = opts || {};
    var s = (st && st.series) || { min: [], imp: [], handles: [], counts: {}, rank: [] };
    var out = [];
    var db = o.db;
    out.push(dbStateRow(db, o.now));
    if (db && db.acct && db.acct.ok) out.push(acctTable(db, o.acct, o.now, o.acctLimit));
    if (db && db.post && db.post.ok) out.push(postTable(db, o.post, o.now, o.postLimit));
    if (db && db.acct && db.acct.ok && db.post && db.post.ok) dbSuggestLines(db).forEach(function (m) { out.push(m); });
    // v0.8.2 时间线曝光排序：库通了才有（tl 查询失败要点名原因，不静默吞）
    if (db && db.tl && db.tl.ok) out.push(tlTable(db, { srcf: o.tlSrcf, day: o.tlDay, now: o.now, limit: o.tlLimit, sort: o.tlSort }));
    else if (db && db.tl && !db.tl.ok) {
      var tlErr = db.tl.err || '没回包';
      // 决策3C（v0.12.19）：云端档点名差异（PG 未存对应序列/分源）是「已知差异」——不是故障，别用红色「查询失败」吓人。
      // 只有真·查询失败（宿主/sink 版本旧、库没起来）才标红。
      if (db.via === 'cloud' && /云端不采集/.test(tlErr)) {
        out.push(row('时间线曝光排序', tlErr, '',
          '云端档的已知差异：线上 PG 没存时间线分源榜单，所以这张榜在云端档不出现（本地库档能看到）。这不是故障，也不是网络断了，刷新没用。'));
      } else {
        out.push(row('时间线曝光排序', '查询失败：' + tlErr, 'bad',
          '宿主/sink 太旧（要 db-5 + sink-14）或库没起来都会这样；两张榜能出而这张不能时，优先怀疑版本'));
      }
    }
    // 库没打通就退回浏览器运行态那套「每人最新一行」：至少不白屏，但也别让它冒充库里的账
    if (!db || !db.acct || !db.acct.ok) {
      out.push(rankNode(st, o.by, o.asc, o.now, o.rankLimit));
      out.push(line('上面这张是浏览器运行态的备用排名（库读不到时才出现）：一人一行 = 他「最新的那一天」的四列。\n' +
        '库通了之后这一张会换成两张榜（账号 / 帖子），数据来自全部已抓到的记录。'));
    } else {
      var isCloud = !!(db && db.via === 'cloud');
      out.push(line(isCloud
        ? '口径：两张榜都来自云端智枢库（线上 PG，全站已采集的帖子与账号；账号按曝光/粉丝、帖子按曝光降序）。\n' +
          '下面那张日点表仍来自浏览器运行态：补录/改数只改面板这张表，不改云端库。'
        : '口径：两张榜都来自本机档案库 xprobe.db（全部已抓到的帖子与日点），不是浏览器里那点运行态。\n' +
          '「账号」那列的曝光 = 这人已抓到帖子的曝光合计；「帖子」是一条帖子一行、取每帖最新一点。\n' +
          '下面那张日点表仍来自浏览器运行态：补录/改数只改面板这张表，不改库。'));
    }
    var who = s.key || '';
    if (!who || who === s.own) {
      out.push(row('要看某一个人', '用顶部「看谁」选中他', 'warn',
        '选中后这里会出他的日线图与可编辑日点表（补录 / 改数 / 删行都写在他那一口表上）。默认视线在自己身上，这一页只有榜。'));
      return out;
    }
    out.push(row('在看谁', '@' + who + '（别人的号）', 'ok',
      '下面这张图与这张表都是他的；「存 / 删」写的也是他那一口表。回自己的历史去「我的」页。'));
    out.push(impMultiChart(st));
    out.push(impTable(who, st, '@' + who + '　'));
    return out;
  }

  // 奖励页在「本页」视图里只报这一件事：那个每天更新的曝光数，加取数证据（判据还没收窄，证据必须看得见）
  function rewardLine(rw) {
    if (!rw) return row('本页(奖励页)', '还没采', 'warn');
    if (!rw.hit) return row('本页(奖励页)', '没抠到数：关键词节点 ' + (rw.keyNodes || 0) + ' 个，看下面的候选', 'bad',
      'REWARD_KEY_PAT 没命中或命中区域里没有「不是门槛」的数字 ⇒ 这一页的形状我还不知道，cands 就是答案');
    return row('本页(奖励页)', '曝光 ' + (rw.value) + ' 次（原文「' + (rw.text || '-') + '」' + (rw.exact ? '精确' : '缩写') +
      (rw.others ? '，同区域还有 ' + rw.others + ' 个数字' : '') + '）', rw.others ? 'warn' : 'ok',
      '关键词：' + rw.key);
  }

  function queryLines(r) {
    if (!r) return [line('(还没查)')];
    return [line((r.users.map(userLine).join('\n') || '(没有匹配的用户)') + '\n---\n' +
      (r.posts.map(postLine).join('\n') || '(没有匹配的帖子)') + '\n库：users ' + r.counts.users + ' / posts ' + r.counts.posts)];
  }

  // ---------- v0.12.4「关注时间 / 未回关」显示层 ----------
  // 判定**不在这里**：三态、历史首条、估值来源全在 xprobe_db.py 的 follow_starts 白名单 SQL 里定死
  //（RL-22 唯一写者）。这一层只把同一份结论排成文字，免得本机面板与云端各写一套判据。
  // 默认折起「已回关」= 用户要的「最早主动关注但没回关我的人」；「未知」照决策 2 必须看得见。
  // at_source='estimated' 的行标「估」：那是第一次见到 TA 的固化时刻，不冒充真实关注动作（RL-11）。
  var FB_LABEL = { yes: '已回关', no: '明确未回关', unknown: '未知' };
  function followBackRows(rows, opts) {
    var o = opts || {}, now = o.now || Date.now(), all = !!o.all;
    var src = Array.isArray(rows) ? rows : [];
    var out = [];
    src.forEach(function (r) {
      if (!r || !r.handle) return;
      var fb = FB_LABEL[r.follow_back] ? r.follow_back : 'unknown';
      if (!all && fb === 'yes') return;
      var ms = Date.parse(r.follow_at || '') || 0;
      var days = ms ? Math.max(0, Math.floor((now - ms) / 86400000)) : null;
      var est = r.at_source === 'estimated';
      var txt = '@' + r.handle +
        '  ' + (r.follow_at ? String(r.follow_at).slice(0, 10) : '时间未知') + (est ? '（估）' : '') +
        '  关注 ' + (days == null ? '—' : days + ' 天') +
        '  ' + FB_LABEL[fb] +
        (r.suspect ? '  ⚠可疑' : '');
      out.push({ handle: r.handle, follow_at: r.follow_at || '', at_source: r.at_source || '',
        follow_back: fb, suspect: !!r.suspect, days: days, text: txt });
    });
    // 调用方（SQL）本来就排好了；这里再排一次是防御：换了数据源也不许把「估」插到真实事件前面。
    out.sort(function (a, b) {
      var ae = a.at_source === 'estimated' ? 1 : 0, be = b.at_source === 'estimated' ? 1 : 0;
      if (ae !== be) return ae - be;
      var at = a.follow_at || '9999', bt = b.follow_at || '9999';
      if (at !== bt) return at < bt ? -1 : 1;
      return a.handle < b.handle ? -1 : (a.handle > b.handle ? 1 : 0);
    });
    return out;
  }
  function followBackLines(st, opts) {
    var o = opts || {};
    var box = (o.db && o.db.followStarts) || {};
    var rows = Array.isArray(box.rows) ? box.rows : [];
    var list = followBackRows(rows, o);
    var out = [line('最早主动关注 · 未回关（列出 ' + list.length + ' 人' +
      (o.all ? '，含已回关' : '，已回关已折起') + '）')];
    if (!box.ok) {
      out.push(line('本机库这一条没读到：' + (box.err || '没回包') +
        '\n先确认宿主 / sink 在跑（或点「重读库」）；闸门不执行面板，这一格要真机走查。'));
      return out;
    }
    out.push(line('口径：每人「历史首条」主动关注动作（取关后重新关注仍算最早那次）；没有真实动作的存量用第一次见到 TA 的固化时刻并标「估」，写一次不再变、不冒充真实时间。三态「已回关 / 明确未回关 / 未知」默认未知，不主动探测，只有手动刷到该账号、本机被动观测到证据才更新。可疑动作保留但带标记。'));
    if (!list.length) { out.push(line('（名单为空：本机还没有关注动作，或所有人都已回关）')); return out; }
    list.forEach(function (r) { out.push(line(r.text)); });
    return out;
  }

  globalThis.XPROBE_VIEW = {
    homeLines: homeLines, debugLines: debugLines, queryLines: queryLines,
    followBackRows: followBackRows, followBackLines: followBackLines, FB_LABEL: FB_LABEL,
    mineLines: mineLines, plazaLines: plazaLines, DAY_HEAD: DAY_HEAD,
    fansForecastCalc: fansForecastCalc, effForecastCalc: effForecastCalc, fansForecastLines: fansForecastLines,
    mineDigestText: mineDigestText, mineReportText: mineReportText,
    chartSpec: chartSpec, minChart: minChart, impChart: impChart, impMultiChart: impMultiChart, impRows: impRows, rewardLine: rewardLine,
    rankRows: rankRows, rankNode: rankNode, RANK_NUM: RANK_NUM, RANK_LABEL: RANK_LABEL,
    acctRows: acctRows, acctTable: acctTable, postRows: postRows, postTable: postTable,
    tlRaw: tlRaw, tlDays: tlDays, tlTable: tlTable, TL_SRC_LABEL: TL_SRC_LABEL, tlUserRows: tlUserRows,
    dbSuggest: dbSuggest, dbSuggestLines: dbSuggestLines, dbStateRow: dbStateRow,
    ACCT_SORT: ACCT_SORT, ACCT_LABEL: ACCT_LABEL, POST_SORT: POST_SORT, POST_LABEL: POST_LABEL,
    nf: nf, impFmt: impFmt, hmOf: hmOf, mdOf: mdOf,
    sinkLine: sinkLine, guardLine: guardLine, coolLine: coolLine, dur: dur, dumpLine: dumpLine,
    storeLine: storeLine, dbLine: dbLine, mb: mb, chLine: chLine, goalBar: goalBar, perfRow: perfRow,
    fsRow: fsRow,
    peerLine: peerLine, noteLine: noteLine,
    statRow: statRow, statNote: statNote, covText: covText, metricsText: metricsText,
    userLine: userLine, postLine: postLine, clip: clip, POSTS_RE: POSTS_RE,
  };
})();

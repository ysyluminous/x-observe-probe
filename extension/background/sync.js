// X 观测探针 —— v0.12.23 增量同步腿（独立文件，由 sw.js 用 importScripts 挂载）。
//
// 为什么单独一个文件：新腿有几百行，硬塞进 sw.js 只会让那个文件更难读；
// 拆文件不动存量逻辑，只把这块新的搬出来 —— RL-34「单文件短小」的本意是按职责分家。
// 2026-11-14 更正：这里原来写「sw.js 超过 RL-34 的 1,500 行上限」，那是拿含注释的物理行数
// 量的，口径已改为只数有效代码行、注释不计入（skills/docs/API-CONTRACT.md §3.1）；
// 理由里的数字作废，拆文件的理由不变。
//
// 这条腿做什么（用户口径：「切换云端后立马把本地 db 同步增量到云端，
// 线上返回入库成功后本地数据就可以删除了」）：
//   本机 SQLite 的**真源表**（tweets / day_rows / follow_events）
//     → 按行 id 游标增量读
//     → POST /api/xprobe/sync/push
//     → 服务端回 ack 水位
//     → 按 ack 水位删本机对应行（推完即清）
//
// 与已有的三条腿是**互补，不是重复**（这是最容易搞混的地方）：
//   ingest       吃浏览器存储里的增量（content script 运行时攒的 series/guard）→ 推完删浏览器
//   library/push 吃本机 SQLite 的 store_users / store_posts 那条流 → 推完删本机台账
//   sync/push    吃本机 SQLite 的**真源表**（榜单口径就是它）→ 推完删本机真源表
// 三条流三批人。本机榜与云端榜要能比，口径必须落在同一批数据上（RL-33）。
//
// 幂等与安全：
//   * 服务端按业务唯一键 upsert（帖 x_post_id / 日点 (user,device,handle,day) /
//     关注 (user,client_at,dir,target)）⇒ 重推不落第二行。
//   * ack 只在服务端明确 persisted=true 且 writeFail=0 时才用；否则本机一行都不删。
//   * 删本机走宿主的 dbpurge（native 优先），白名单写死，调用方给不了表名/SQL。
//   * 云端不可用/未登录 ⇒ 数据留在本机（那里本来就是持久队列），并把这趟记进浏览器
//     缓存的「待传计数」，登录成功立刻续跑。**浏览器缓存只存待传标记，不存正文**
//     （正文在本机库里，那是持久的地方；浏览器缓存只做「提醒我还有多少没传」的账本）。
(function () {
  'use strict';

  // 挂在 sw.js 的闭包外面不行（sw.js 里那些常量都是闭包内的），
  // 所以这里通过一个注入点拿能力：sw.js 在 importScripts 之后会调 XPROBE_SYNC.install({...})。
  if (typeof globalThis.XPROBE_SYNC === 'undefined') {
    globalThis.XPROBE_SYNC = { install: function () { } };
  }

  const SYNC_WM_KEY = 'ysy.xprobe.syncWM';
  const SYNC_STAT_KEY = 'ysy.xprobe.syncStat';
  const SYNC_PEND_KEY = 'ysy.xprobe.syncPending';   // 浏览器缓存兜底：待传标记（不含正文）
  const SYNC_MS = 30000;
  const SYNC_MAX = 500;          // 一批一条腿的行数（服务端上限 1000，留一倍余量）
  const SYNC_MAX_BATCHES = 40;   // 一趟最多推多少批（撞顶就下一趟接着推）

  function install(deps) {
    const getKey = deps.getKey;
    const setKey = deps.setKey;
    const cloudConf = deps.cloudConf;
    const cloudPost = deps.cloudPost;
    const dbq = deps.dbq;
    const ensureDeviceId = deps.ensureDeviceId;
    const acctTag = deps.acctTag;
    const envOf = deps.envOf;
    const purgeAcked = deps.purgeAcked;
    const armRetryAlarm = deps.armRetryAlarm;

    let busy = false, again = false, timer = null;

    // 水位按「档 + 账号」各存一本（与 libWm / xsWm 同一套 tag）。
    // 换账号 = 新的一格从 0 开始整本重放，服务端唯一键去重不落第二行；宁可重推不可漏推。
    function wmKey(env, c) {
      return SYNC_WM_KEY + '.' + envOf(env) + (acctTag(c) ? '.' + acctTag(c) : '');
    }
    function wmTriple(o) {
      const w = (o && typeof o === 'object') ? o : {};
      return {
        post: Number(w.post) > 0 ? Number(w.post) : 0,
        day: Number(w.day) > 0 ? Number(w.day) : 0,
        follow: Number(w.follow) > 0 ? Number(w.follow) : 0,
      };
    }
    function readWm(env, c) {
      const e = envOf(env);
      return getKey(wmKey(e, c)).then((v) => {
        const cur = wmTriple(v);
        if (c && c.token) return cur;
        if (e !== (deps.CLOUD_ENV_DEF || 'prod')) return cur;
        // prod 且这格是旧的顶层单档写法时认一次老账（迁移，不是 bug）
        if (cur.post || cur.day || cur.follow) return cur;
        return getKey(SYNC_WM_KEY).then((old) => {
          const o = (old && typeof old === 'object') ? old : {};
          return (Number(o.post) > 0 || Number(o.day) > 0 || Number(o.follow) > 0) ? wmTriple(o) : cur;
        });
      });
    }

    // 只认服务端回的游标：不是正数就当它没给（旧版服务端不会回这一套）。
    // 而且只许往前、不许回头。
    function ackOf(v, now) {
      const n = Number(v);
      return (Number.isFinite(n) && n > 0 && n >= now) ? Math.floor(n) : now;
    }

    // 浏览器缓存兜底：只记「还有多少行没传上去」这个数，不记正文。
    // 用途：登录成功后立刻知道「本机还有 N 行等着传」，不用去数库。
    function markPending(env, counts) {
      const o = {};
      o[SYNC_PEND_KEY + '.' + envOf(env)] = Object.assign({ at: Date.now() }, counts || {});
      return setKey(o);
    }
    function readPending(env) {
      return getKey(SYNC_PEND_KEY + '.' + envOf(env)).then((v) => (v && typeof v === 'object') ? v : null);
    }

    function syncRun(opts) {
      if (busy) {
        again = true;
        return Promise.resolve({ ok: false, err: '本机库同步正在跑，等这一趟完（已记一笔，跑完立刻接着推）' });
      }
      busy = true;
      const finish = (v) => {
        busy = false;
        if (again) { again = false; setTimeout(() => syncRun(), 0); }
        return v;
      };
      return Promise.all([cloudConf(), ensureDeviceId()]).then((a) => {
        const c = a[0];
        if (!c.on || !c.token) {
          return { ok: false, err: '云端模式没开或这一档还没登录（设置里打开、并在弹窗里登录当前档）' };
        }
        const deviceId = a[1];
        if (!deviceId) return { ok: false, err: 'deviceId 没生成出来（存储写失败？）' };
        const maxBatches = Math.max(1, Math.min(
          Number.isFinite(opts && opts.batches) && opts.batches > 0 ? opts.batches : SYNC_MAX_BATCHES,
          500));
        return readWm(c.env, c).then((wm0) => {
          const wm = { post: wm0.post, day: wm0.day, follow: wm0.follow };
          let batches = 0, stopped = '', err = '', purged = [];
          let postSent = 0, daySent = 0, followSent = 0;

          const step = () => {
            if (batches >= maxBatches) { stopped = 'batch-cap'; return Promise.resolve(); }
            // 一条腿读满页就是「还有」，不满页就是「推完了」——两条腿各自判，别共用一个标记。
            return Promise.all([
              dbq({ q: 'sync_posts', after: wm.post, limit: SYNC_MAX }),
              dbq({ q: 'sync_days', after: wm.day, limit: SYNC_MAX }),
              dbq({ q: 'sync_follows', after: wm.follow, limit: SYNC_MAX }),
            ]).then((three) => {
              const p = three[0], d = three[1], f = three[2];
              if (!p.ok || !d.ok || !f.ok) {
                const bad = !p.ok ? p : (!d.ok ? d : f);
                err = '读本机真源表没成：' + (bad.err || '没回话') +
                  '（宿主/sink 是旧版？v0.12.23 要 sync_posts / sync_days / sync_follows 三条查询，重跑 install-host 打包）';
                stopped = 'error';
                return null;
              }
              const posts = [].concat(p.rows || []).filter((r) => r && Number(r.id) > 0 && r.tweet_id);
              const days = [].concat(d.rows || []).filter((r) => r && Number(r.id) > 0 && r.handle && r.day);
              const follows = [].concat(f.rows || []).filter((r) => r && Number(r.id) > 0 && r.handle && r.dir);
              if (!posts.length && !days.length && !follows.length) { stopped = 'done'; return null; }

              const payload = {
                deviceId: deviceId,
                posts: posts.map((r) => ({
                  id: Number(r.id), xPostId: String(r.tweet_id),
                  authorHandle: String(r.author || ''), text: String(r.text || ''),
                  timeDatetime: String(r.time_datetime || ''),
                  followState: String(r.follow_state || ''),
                  liked: r.liked == null ? null : Number(r.liked),
                  view: r.view == null ? null : Number(r.view),
                  like: r.like == null ? null : Number(r.like),
                  repost: r.repost == null ? null : Number(r.repost),
                  reply: r.reply == null ? null : Number(r.reply),
                  quote: r.quote == null ? null : Number(r.quote),
                  bookmark: r.bookmark == null ? null : Number(r.bookmark),
                  at: String(r.at || ''),
                })),
                days: days.map((r) => ({
                  id: Number(r.id), at: String(r.at || ''), day: String(r.day || ''),
                  handle: String(r.handle || ''),
                  exposure: r.exposure == null ? null : Number(r.exposure),
                  effective: r.effective == null ? null : Number(r.effective),
                  exact: r.exact == null ? null : Number(r.exact),
                  token: String(r.token || ''),
                  following: r.following == null ? null : Number(r.following),
                  followers: r.followers == null ? null : Number(r.followers),
                  posts: r.posts == null ? null : Number(r.posts),
                  manual: r.manual == null ? null : Number(r.manual),
                  source: String(r.source || ''),
                })),
                follows: follows.map((r) => ({
                  id: Number(r.id), at: String(r.at || ''), day: String(r.day || ''),
                  target: String(r.handle || ''), dir: String(r.dir || ''),
                  why: String(r.why || ''),
                  w15: r.w15 == null ? null : Number(r.w15),
                  w24: r.w24 == null ? null : Number(r.w24),
                  suspect: r.suspect == null ? null : Number(r.suspect),
                })),
              };
              try { payload.ver = String(chrome.runtime.getManifest().version || ''); } catch (e) { payload.ver = ''; }
              try { payload.label = String(navigator.userAgent || '').slice(0, 100); } catch (e) { payload.label = ''; }

              const before = { post: wm.post, day: wm.day, follow: wm.follow };
              return cloudPost('/api/xprobe/sync/push', c.token, payload, SYNC_MS).then((r) => {
                if (!r.ok) { err = r.err || '上送失败'; stopped = 'error'; return null; }
                const dd = (r.ok && r.data) ? r.data : {};
                postSent += payload.posts.length;
                daySent += payload.days.length;
                followSent += payload.follows.length;
                // 水位只抬到服务端给的 ack，只许往上不许回头。
                wm.post = ackOf(dd.ackPost, before.post);
                wm.day = ackOf(dd.ackDay, before.day);
                wm.follow = ackOf(dd.ackFollow, before.follow);
                // 服务端没回 ack（老服务端）⇒ 有行却水位没动 = 卡住，停手等下一趟，
                // 整批重推靠唯一键去重，不落第二行。
                const stall = (payload.posts.length > 0 && wm.post === before.post)
                  || (payload.days.length > 0 && wm.day === before.day)
                  || (payload.follows.length > 0 && wm.follow === before.follow);
                if (stall) {
                  stopped = 'stalled';
                  err = '服务端没回 ack（对面是旧版？）—— 这批下次整批重推，唯一键去重不会落第二行';
                  return null;
                }
                // 只有服务端明确 confirmed（persisted=true 且 writeFail=0）才允许删本机。
                const confirmed = dd.persisted === true && Number(dd.writeFail || 0) === 0;
                const jobs = [
                  confirmed && wm.post > before.post ? ['sync_posts', wm.post] : null,
                  confirmed && wm.day > before.day ? ['sync_days', wm.day] : null,
                  confirmed && wm.follow > before.follow ? ['sync_follows', wm.follow] : null,
                ].filter(Boolean);
                return purgeAcked(jobs).then((pg) => {
                  if (!pg.purgeOk) {
                    // 清理没成 ⇒ 水位回退，这批下趟整批重推（宁重不漏）
                    wm.post = before.post; wm.day = before.day; wm.follow = before.follow;
                    err = '本机真源表清理失败，水位没推进：' +
                      pg.purged.filter((x) => !x.ok).map((x) => x.err).join('；');
                    stopped = 'error';
                    return null;
                  }
                  purged = purged.concat(pg.purged);
                  batches++;
                  // 三条腿都读到不满一页 ⇒ 这一趟推完了
                  if (posts.length < SYNC_MAX && days.length < SYNC_MAX && follows.length < SYNC_MAX) {
                    stopped = 'done';
                    return null;
                  }
                  return step();
                });
              });
            });
          };

          return step().then(() => {
            const o = {};
            o[wmKey(c.env, c)] = { post: wm.post, day: wm.day, follow: wm.follow };
            return setKey(o).then(() => markPending(c.env, {
              post: wm.post, day: wm.day, follow: wm.follow,
              lastSent: postSent + daySent + followSent,
            })).then(() => {
              const out = {
                ok: !err, err: err, env: c.env, base: c.base,
                postSent: postSent, daySent: daySent, followSent: followSent,
                batches: batches, wm: { post: wm.post, day: wm.day, follow: wm.follow },
                done: stopped === 'done', capped: stopped === 'batch-cap',
                stopped: stopped, purged: purged,
              };
              const so = {};
              so[SYNC_STAT_KEY] = Object.assign({ at: Date.now() }, out);
              setKey(so);
              // 这一趟撞了批数顶但还有得推：过 1 秒接着跑（SW 若被杀，闹钟还会兜住）
              if (stopped === 'batch-cap') scheduleSync(1000);
              return finish(out);
            });
          });
        });
      }).catch((e) => finish({
        ok: false, err: '本机库同步出错：' + String((e && e.message) || e).slice(0, 120),
      }));
    }

    function scheduleSync(ms) {
      if (timer) return;
      timer = setTimeout(() => { timer = null; syncRun(); }, ms == null ? SYNC_MS : ms);
    }

    // 登录成功后立刻跑一趟（不等闹钟）。
    function onLoginOk() {
      scheduleSync(200);
      try { armRetryAlarm(); } catch (e) { /* 沙箱没有 alarms */ }
    }

    // 读本机库的查询失败（新宿主没装）时，把「有数据没传上去」记进浏览器缓存，
    // 登录成功/宿主恢复后立刻续跑 —— 数据一直在本机库里，不会丢。
    function notePending(env, err) {
      return readPending(env).then((old) => {
        const o = old && typeof old === 'object' ? old : {};
        return markPending(env, Object.assign({}, o, { err: String(err || '').slice(0, 120), at: Date.now() }));
      });
    }

    globalThis.XPROBE_SYNC = {
      install: install,
      run: syncRun,
      schedule: scheduleSync,
      onLoginOk: onLoginOk,
      notePending: notePending,
      readPending: readPending,
      statKey: SYNC_STAT_KEY,
      wmKey: SYNC_WM_KEY,
    };
  }

  globalThis.XPROBE_SYNC = { install: function () { }, install2: null };
})();

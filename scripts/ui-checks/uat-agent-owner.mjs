/**
 * scripts/ui-checks/uat-agent-owner.mjs
 *
 * 驗 H5/PC 這條線的 **Agent 擁有者隔離**（v4.185.0）。
 *
 * ## 這在修什麼
 * Backend UAT（`/api/osm-uat/agents`）一直有濾 `ownerKey`，**只有 H5/PC 這條漏掉**：
 * `getUatAgents()` 掃的是全部 `agentConnections`，`/record/start` 的自動挑選也是。
 * 後果是清單列出別人的機器，而且**錄製的瀏覽器會開在別人的桌面上**。
 * 執行那條（`/runs/:id/execute`）同源，而且更糟：指名一台拿不到的 agent 會
 * **默默掉到本機執行**，使用者對著「成功」的畫面找不到自己指名那台在跑什麼。
 *
 * ## 這支怎麼測
 * **真的把 router 掛進 express 打**，並用跟 worker 一模一樣的方式建立 request context
 * （`x-auth-user` header → `runWithRequestContext`）。假的 agent 用 stub ws 收訊息，
 * 所以「有沒有真的派工出去」是看得見的。
 *
 * ⚠️ 依 CodeX 2026-09-18 的原則：**越權請求發生後立刻斷言「被拒 + 沒有副作用」**，
 *    再加入後續操作——不要讓後面的步驟替缺口補考。
 *
 * 跑法：node scripts/ui-checks/uat-agent-owner.mjs
 * ⚠️ 需要先 `npm run build`（吃 dist-server 的編譯結果）。
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const express = (await import('express')).default;
const hub = await load('dist-server/server/agent-hub.js');
const fa = await load('dist-server/server/routes/frontend-auto.js');
const { runWithRequestContext } = await load('dist-server/server/request-context.js');

const ME = 'me@toppath.test';
const OTHER = 'someone-else@toppath.test';

/** 記下每台 agent 收到什麼——「有沒有真的派工出去」要看得見，不能只看回應 */
const outbox = new Map();

function addAgent({ agentId, ownerKey, capabilities, busy = false, open = true }) {
  const sent = [];
  outbox.set(agentId, sent);
  hub.agentConnections.set(agentId, {
    agentId, ownerKey, ownerName: ownerKey, hostname: agentId, capabilities, busy,
    connectedAt: Date.now(), lastSeenAt: Date.now(), sessionId: null,
    ws: { readyState: open ? 1 : 3, OPEN: 1, send: (raw) => sent.push(JSON.parse(raw)) },
  });
}

const app = express();
app.use(express.json());
// ⚠️ 跟 `server/worker.ts` 的 middleware 同一套：身分來自 x-auth-user header。
//    測試要走產品真正走的那條路，不能自己塞 context。
app.use((req, _res, next) => {
  const user = String(req.headers['x-auth-user'] ?? '—');
  runWithRequestContext(
    { ip: '127.0.0.1', user, userDisplay: user, path: req.path, method: req.method, operation: 'test' },
    () => next(),
  );
});
app.use(fa.router);
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, url, { as, body, local = false } = {}) => {
  // ⚠️ 預設**裝成遠端請求**。從 localhost 打的話 `/record/start` 會走「本機錄製」
  //    那條路——它根本不碰 agent，於是「自動派工不會挑到別人的」這條會假通過
  //    （而且真的開一顆 Chrome 出來）。第一版就是這樣，測試當場抓到。
  const headers = { 'Content-Type': 'application/json' };
  if (!local) headers['x-forwarded-host'] = 'uat.example.com';
  if (as) headers['x-auth-user'] = as;
  const response = await fetch(`${base}${url}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* 有些路徑不回 JSON */ }
  return { status: response.status, ok: response.ok, json };
};

const reset = () => { hub.agentConnections.clear(); outbox.clear(); hub.uatAgentSessions.clear(); };

try {
  // ── ① 只有別人的 Agent 在線 ───────────────────────────────────────────
  console.log('① 線上只有別人的 Agent');
  {
    reset();
    addAgent({ agentId: 'THEIR-PC', ownerKey: OTHER, capabilities: ['uat-record', 'uat-run'] });

    const list = await call('GET', '/api/frontend-auto/record/agents', { as: ME });
    check('① 清單看不到別人的 Agent', (list.json?.agents ?? []).length === 0, JSON.stringify(list.json));

    const auto = await call('POST', '/api/frontend-auto/record/start', {
      as: ME, body: { url: 'https://game.example/', platform: 'h5' },
    });
    // ⚠️ 立刻斷言「被拒 + 沒有副作用」，不要先做別的事
    check('① ⚠️ 自動派工不會挑到別人的 Agent', auto.status === 409, `HTTP ${auto.status} ${JSON.stringify(auto.json)}`);
    check('① ⚠️ 而且沒有送任何訊息給那台 Agent',
      (outbox.get('THEIR-PC') ?? []).length === 0, JSON.stringify(outbox.get('THEIR-PC')));
    check('① ⚠️ 也沒有留下 session', hub.uatAgentSessions.size === 0);

    const named = await call('POST', '/api/frontend-auto/record/start', {
      as: ME, body: { url: 'https://game.example/', platform: 'h5', agentId: 'THEIR-PC' },
    });
    check('① ⚠️ 指名別人的 Agent 被拒（403）', named.status === 403, `HTTP ${named.status} ${JSON.stringify(named.json)}`);
    check('① ⚠️ 指名被拒之後仍然沒有送出任何訊息',
      (outbox.get('THEIR-PC') ?? []).length === 0);
    check('① 錯誤訊息不透露那台是誰的',
      !String(named.json?.message ?? '').includes(OTHER), named.json?.message);
  }

  // ── ② 自己的 Agent 可錄不可跑 ─────────────────────────────────────────
  console.log('② 自己的 Agent 有錄製能力、沒有執行能力');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record'] });

    const list = await call('GET', '/api/frontend-auto/record/agents', { as: ME });
    check('② 錄製清單列得出自己的 Agent', (list.json?.agents ?? []).length === 1, JSON.stringify(list.json));

    const run = await call('POST', '/api/frontend-auto/runs/run-cap/execute', {
      as: ME, body: { steps: '[]', url: 'https://game.example/', platform: 'h5', agentId: 'MY-PC' },
    });
    check('② ⚠️ 指名它執行要被拒（能力不符）', run.status === 409, `HTTP ${run.status} ${JSON.stringify(run.json)}`);
    check('② ⚠️ 而且不得默默轉本機執行（不能留下 activeRun）',
      !fa.activeRuns.has('run-cap'), '指名失敗卻在伺服器端跑起來了');
    check('② ⚠️ 也沒有送任何執行指令給它',
      !(outbox.get('MY-PC') ?? []).some(m => m.type === 'uat_script_run'));
    check('② 訊息要講得出是能力問題', /更新程式碼|能力|uat-run/.test(String(run.json?.message ?? '')), run.json?.message);
  }

  // ── ③ 忙碌 ────────────────────────────────────────────────────────────
  console.log('③ 自己的 Agent 忙碌中');
  {
    reset();
    addAgent({ agentId: 'BUSY-PC', ownerKey: ME, capabilities: ['uat-record'], busy: true });

    const named = await call('POST', '/api/frontend-auto/record/start', {
      as: ME, body: { url: 'https://game.example/', platform: 'h5', agentId: 'BUSY-PC' },
    });
    check('③ 指名忙碌中的 Agent 被拒', named.status === 409, `HTTP ${named.status}`);
    check('③ ⚠️ 被拒之後沒有送出任何訊息', (outbox.get('BUSY-PC') ?? []).length === 0);
    check('③ 訊息講得出是忙碌', String(named.json?.message ?? '').includes('忙碌'), named.json?.message);

    const auto = await call('POST', '/api/frontend-auto/record/start', {
      as: ME, body: { url: 'https://game.example/', platform: 'h5' },
    });
    check('③ 自動挑選會略過忙碌的那台', auto.status === 409, `HTTP ${auto.status}`);
  }

  // ── ④ 選定之後斷線 ────────────────────────────────────────────────────
  console.log('④ 指名的 Agent 連線已斷');
  {
    reset();
    addAgent({ agentId: 'DEAD-PC', ownerKey: ME, capabilities: ['uat-record'], open: false });
    const named = await call('POST', '/api/frontend-auto/record/start', {
      as: ME, body: { url: 'https://game.example/', platform: 'h5', agentId: 'DEAD-PC' },
    });
    check('④ 連線不正常的 Agent 被拒', named.status === 409, `HTTP ${named.status}`);
    check('④ ⚠️ 沒有對著死掉的連線送訊息', (outbox.get('DEAD-PC') ?? []).length === 0);
    check('④ ⚠️ 也沒有留下 session', hub.uatAgentSessions.size === 0);
  }

  // ── ⑤ 沒有登入者 ──────────────────────────────────────────────────────
  console.log('⑤ 查不到登入者');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record'] });
    const list = await call('GET', '/api/frontend-auto/record/agents');
    check('⑤ ⚠️ 查不到登入者時清單是空的，不是全部',
      (list.json?.agents ?? []).length === 0, JSON.stringify(list.json));
    const start = await call('POST', '/api/frontend-auto/record/start', {
      body: { url: 'https://game.example/', platform: 'h5', agentId: 'MY-PC' },
    });
    check('⑤ ⚠️ 查不到登入者時不得派工', start.status === 401, `HTTP ${start.status}`);
    check('⑤ ⚠️ 而且沒有送出任何訊息', (outbox.get('MY-PC') ?? []).length === 0);
  }

  // ── ⑥ 別人的 session 不能碰 ───────────────────────────────────────────
  console.log('⑥ 別人開的錄製 session');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record'] });
    hub.uatAgentSessions.set('rec-theirs', {
      agentId: 'MY-PC', ownerKey: OTHER, steps: [{ action: 'goto' }],
      cropPending: false, done: false, paused: false,
    });

    const status = await call('GET', '/api/frontend-auto/record/status/rec-theirs', { as: ME });
    check('⑥ ⚠️ 看不到別人的錄製狀態', status.status === 403, `HTTP ${status.status}`);
    check('⑥ ⚠️ 而且沒有洩漏步驟', !Array.isArray(status.json?.steps), JSON.stringify(status.json));

    const pause = await call('POST', '/api/frontend-auto/record/pause/rec-theirs', { as: ME, body: { paused: true } });
    check('⑥ ⚠️ 不能暫停別人的錄製', pause.status === 403, `HTTP ${pause.status}`);
    check('⑥ ⚠️ 而且沒有送出暫停指令',
      !(outbox.get('MY-PC') ?? []).some(m => m.type === 'uat_record_pause'));
    check('⑥ ⚠️ 也沒有動到那個 session 的狀態',
      hub.uatAgentSessions.get('rec-theirs')?.paused === false);

    const stop = await call('POST', '/api/frontend-auto/record/stop/rec-theirs', { as: ME });
    check('⑥ ⚠️ 不能停止別人的錄製', stop.status === 403, `HTTP ${stop.status}`);
    check('⑥ ⚠️ 而且沒有送出停止指令',
      !(outbox.get('MY-PC') ?? []).some(m => m.type === 'uat_record_stop'));
    check('⑥ ⚠️ session 仍然留著（沒有被別人刪掉）', hub.uatAgentSessions.has('rec-theirs'));

    // 自己的就進得去——證明擋住的是「不是你的」，不是整支端點壞了
    hub.uatAgentSessions.set('rec-mine', {
      agentId: 'MY-PC', ownerKey: ME, steps: [{ action: 'goto' }],
      cropPending: false, done: false, paused: false,
    });
    const mine = await call('GET', '/api/frontend-auto/record/status/rec-mine', { as: ME });
    check('⑥ 自己的 session 照樣讀得到（擋的是越權，不是整支端點）',
      mine.status === 200 && mine.json?.found === true, `HTTP ${mine.status}`);
  }

  // ── ⑦ 舊 session（這一版之前開的，沒有 ownerKey）不能被鎖死 ────────────
  console.log('⑦ 升版當下正在跑的舊 session');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record'] });
    hub.uatAgentSessions.set('rec-legacy', {
      agentId: 'MY-PC', steps: [{ action: 'goto' }], cropPending: false, done: false, paused: false,
    });
    const status = await call('GET', '/api/frontend-auto/record/status/rec-legacy', { as: ME });
    check('⑦ 沒有 ownerKey 的舊 session 仍然操作得了（否則升版當下的人會停不掉自己的錄製）',
      status.status === 200, `HTTP ${status.status}`);
  }
} finally {
  // 保險：萬一某條路徑真的開了本機錄製（例如 fixture 寫錯又走到本機那條），
  // 把它停掉，不要留一顆 Chrome 在機器上。
  for (const id of [...(fa.recorderSessionIds?.() ?? [])]) {
    try { await call('POST', `/api/frontend-auto/record/stop/${id}`, { as: ME }); } catch { /* 停不掉就算了 */ }
  }
  server.close();
  reset();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

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
const { signInternalIdentity, verifyInternalIdentity } = await load('dist-server/server/shared.js');

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
// ⚠️ 跟 `server/worker.ts` 的 middleware **一模一樣**：顯示用身分讀 header，
//    授權用的 `authEmail` 一定要通過簽章驗證。測試自己塞 context 的話，
//    「header 冒名」這條根本測不到——而那正是 CodeX 指出的 P1。
app.use((req, _res, next) => {
  const user = String(req.headers['x-auth-user'] ?? req.headers['x-jira-email'] ?? '—');
  const authEmail = verifyInternalIdentity(
    String(req.headers['x-auth-email'] ?? ''),
    String(req.headers['x-auth-issued'] ?? ''),
    String(req.headers['x-auth-sig'] ?? ''),
  );
  runWithRequestContext(
    { ip: '127.0.0.1', user, userDisplay: user, authEmail, path: req.path, method: req.method, operation: 'test' },
    () => next(),
  );
});
app.use(fa.router);
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

/**
 * @param as     真的登入成這個人（走前端 server 會做的那一步：簽名）
 * @param spoof  只把身分塞進 header（沒有簽名）——模擬「自己組請求打 worker」
 * @param stale  簽名用過期的時間戳
 */
const call = async (method, url, { as, spoof, stale, body, local = false } = {}) => {
  // ⚠️ 預設**裝成遠端請求**。從 localhost 打的話 `/record/start` 會走「本機錄製」
  //    那條路——它根本不碰 agent，於是「自動派工不會挑到別人的」這條會假通過
  //    （而且真的開一顆 Chrome 出來）。第一版就是這樣，測試當場抓到。
  const headers = { 'Content-Type': 'application/json' };
  if (!local) headers['x-forwarded-host'] = 'uat.example.com';
  if (as) {
    headers['x-auth-user'] = as;
    // ⚠️ 過期要**用舊時間戳重新簽一份**，不能只改 issued 不重簽——
    //    那樣被擋下來的是簽章不符，有效期那一道整段拿掉照樣綠（注入測試抓到過）。
    const signed = stale ? signInternalIdentity(as, Date.now() - 10 * 60_000) : signInternalIdentity(as);
    headers['x-auth-email'] = signed.email;
    headers['x-auth-issued'] = String(signed.issuedAt);
    headers['x-auth-sig'] = signed.signature;
  }
  if (spoof) {
    // 冒名只塞得出這兩個——簽章是簽不出來的
    headers['x-auth-user'] = spoof;
    headers['x-jira-email'] = spoof;
  }
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
  // ── ⑧ header 冒名（CodeX 2026-09-18 P1）────────────────────────────────
  // ⚠️ worker 綁在 0.0.0.0，任何連得到 port 的人都能自己組請求。
  //    身分 header 塞得出來，**簽章塞不出來**——所以冒名一律當成沒有身分。
  console.log('⑧ 只帶身分 header、沒有簽章（自己組請求打 worker）');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record', 'uat-run'] });

    const list = await call('GET', '/api/frontend-auto/record/agents', { spoof: ME });
    check('⑧ ⚠️ 冒名看不到任何 Agent', (list.json?.agents ?? []).length === 0, JSON.stringify(list.json));

    const start = await call('POST', '/api/frontend-auto/record/start', {
      spoof: ME, body: { url: 'https://game.example/', platform: 'h5', agentId: 'MY-PC' },
    });
    check('⑧ ⚠️ 冒名不得派工', start.status === 401, `HTTP ${start.status}`);
    check('⑧ ⚠️ 而且沒有送出任何訊息', (outbox.get('MY-PC') ?? []).length === 0);
    check('⑧ ⚠️ 也沒有留下 session', hub.uatAgentSessions.size === 0);

    // 簽章過期同樣不算身分（只簽 email 的話被看到就能永久重放）
    const expired = await call('GET', '/api/frontend-auto/record/agents', { as: ME, stale: true });
    check('⑧ ⚠️ 過期的簽章不算身分', (expired.json?.agents ?? []).length === 0, JSON.stringify(expired.json));

    // 真的登入就看得到——證明擋住的是「沒簽章」，不是整支端點壞了
    const real = await call('GET', '/api/frontend-auto/record/agents', { as: ME });
    check('⑧ 真的登入看得到自己的 Agent（擋的是冒名，不是整支端點）',
      (real.json?.agents ?? []).length === 1, JSON.stringify(real.json));
  }

  // ── ⑨ 越權停止別人的執行（CodeX 2026-09-18 P1）─────────────────────────
  console.log('⑨ 停止別人的執行');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record', 'uat-run'] });
    addAgent({ agentId: 'THEIR-PC', ownerKey: OTHER, capabilities: ['uat-run'] });

    // Bob 開一輪執行（派到他自己的機器）
    const started = await call('POST', '/api/frontend-auto/runs/run-bob/execute', {
      as: OTHER, body: { steps: '[]', url: 'https://game.example/', platform: 'h5' },
    });
    check('⑨ fixture：Bob 的執行真的派到他自己的 Agent',
      started.json?.via === 'agent' && started.json?.agentId === 'THEIR-PC', JSON.stringify(started.json));
    check('⑨ fixture：自動挑選沒有挑到 Alice 的機器',
      !(outbox.get('MY-PC') ?? []).some(m => m.type === 'uat_script_run'));

    const stop = await call('POST', '/api/frontend-auto/runs/run-bob/stop', { as: ME });
    check('⑨ ⚠️ Alice 停不掉 Bob 的執行', stop.status === 403, `HTTP ${stop.status}`);
    check('⑨ ⚠️ 而且沒有送出停止訊息',
      !(outbox.get('THEIR-PC') ?? []).some(m => m.type === 'uat_script_stop'));
    check('⑨ ⚠️ activeRuns 也沒有被動到（檢查要在動作之前）', fa.activeRuns.has('run-bob'));
    check('⑨ ⚠️ session 也還在', hub.uatRunSessions.has('run-bob'));

    const own = await call('POST', '/api/frontend-auto/runs/run-bob/stop', { as: OTHER });
    check('⑨ Bob 自己停得掉', own.status === 200, `HTTP ${own.status}`);
    check('⑨ 停掉之後 activeRuns 清乾淨', !fa.activeRuns.has('run-bob'));
  }

  // ── ⑩ crop / screenshot 的越權 ─────────────────────────────────────────
  console.log('⑩ 對別人的錄製框選截圖');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record'] });
    hub.uatAgentSessions.set('rec-theirs', {
      agentId: 'MY-PC', ownerKey: OTHER, steps: [{ action: 'goto' }],
      cropPending: false, done: false, paused: false,
    });
    const crop = await call('POST', '/api/frontend-auto/record/crop/rec-theirs', {
      as: ME, body: { platform: 'h5', scriptId: 's1', name: 'x', threshold: 0.08, createdBy: 'me' },
    });
    check('⑩ ⚠️ 不能對別人的錄製框選截圖', crop.status === 403, `HTTP ${crop.status}`);
    check('⑩ ⚠️ 而且沒有送出框選指令',
      !(outbox.get('MY-PC') ?? []).some(m => m.type === 'uat_record_crop'));
    check('⑩ ⚠️ 也沒有把 cropPending 打開',
      hub.uatAgentSessions.get('rec-theirs')?.cropPending === false);

    const shot = await call('POST', '/api/frontend-auto/record/screenshot/rec-theirs', {
      as: ME, body: { platform: 'h5', scriptId: 's1' },
    });
    // 這支只服務本機模式的 session，所以別人的 agent session 會是 404；
    // 重點是**不得成功**，而且不能洩漏內容。
    check('⑩ ⚠️ 直接截圖別人的錄製不會成功', shot.status >= 400, `HTTP ${shot.status}`);
  }

  // ── ⑪ 清單與派工必須一致（CodeX 2026-09-18 P2）──────────────────────────
  // ⚠️ 他實測到的症狀：**斷線的 Agent 仍然列在清單上，派工卻拒絕**。
  //    清單自己算一套、派工另一套，遲早會出現「畫面說可以派、按下去被擋」，
  //    或更糟的反向。所以清單要回**跟派工同一支算出來的** usable。
  console.log('⑪ 清單說的可用性要跟派工結果一致');
  {
    reset();
    addAgent({ agentId: 'OK-PC', ownerKey: ME, capabilities: ['uat-record'] });
    addAgent({ agentId: 'DEAD-PC', ownerKey: ME, capabilities: ['uat-record'], open: false });
    addAgent({ agentId: 'BUSY-PC', ownerKey: ME, capabilities: ['uat-record'], busy: true });

    const list = await call('GET', '/api/frontend-auto/record/agents', { as: ME });
    const byId = new Map((list.json?.agents ?? []).map(a => [a.agentId, a]));
    check('⑪ 三台都列得出來（不可用也要看得到，只是要標出來）', byId.size === 3, JSON.stringify(list.json));
    check('⑪ ⚠️ 斷線那台在清單上要標成不可用', byId.get('DEAD-PC')?.usable === false, JSON.stringify(byId.get('DEAD-PC')));
    check('⑪ 而且講得出原因', /連線/.test(String(byId.get('DEAD-PC')?.unusableReason ?? '')), byId.get('DEAD-PC')?.unusableReason);
    check('⑪ 忙碌那台也標成不可用', byId.get('BUSY-PC')?.usable === false);
    check('⑪ 正常那台標成可用', byId.get('OK-PC')?.usable === true);

    // 逐台對照：清單說可用的就派得動，說不可用的就派不動
    for (const id of ['OK-PC', 'DEAD-PC', 'BUSY-PC']) {
      const start = await call('POST', '/api/frontend-auto/record/start', {
        as: ME, body: { url: 'https://game.example/', platform: 'h5', agentId: id },
      });
      const listSaysUsable = byId.get(id)?.usable === true;
      check(`⑪ ⚠️ ${id}：清單說${listSaysUsable ? '可用' : '不可用'}，派工結果要一致`,
        listSaysUsable ? start.ok : start.status === 409,
        `清單 usable=${listSaysUsable}，派工 HTTP ${start.status}`);
      if (start.ok) hub.uatAgentSessions.clear();
    }
  }

  // ── ⑪b 共用狀態列的資料來源（v4.187.0）──────────────────────────────────
  console.log('⑪b /agents/overview：三種能力各自的可用性');
  {
    reset();
    addAgent({ agentId: 'ALL-PC', ownerKey: ME, capabilities: ['uat-record', 'uat-run', 'backend-uat'] });
    addAgent({ agentId: 'REC-ONLY', ownerKey: ME, capabilities: ['uat-record'] });
    addAgent({ agentId: 'THEIR-PC', ownerKey: OTHER, capabilities: ['uat-record', 'uat-run', 'backend-uat'] });

    const ov = await call('GET', '/api/frontend-auto/agents/overview', { as: ME });
    const rows = new Map((ov.json?.agents ?? []).map(a => [a.agentId, a]));
    check('⑪b ⚠️ 只列自己的 Agent', rows.size === 2 && !rows.has('THEIR-PC'), JSON.stringify(ov.json?.agents));
    check('⑪b 三種能力都回', Object.keys(rows.get('ALL-PC')?.capability ?? {}).length === 3,
      JSON.stringify(rows.get('ALL-PC')?.capability));
    check('⑪b ⚠️ 只有錄製能力的那台，執行與 Backend 要標成不可用',
      rows.get('REC-ONLY')?.capability['uat-record'].usable === true
      && rows.get('REC-ONLY')?.capability['uat-run'].usable === false
      && rows.get('REC-ONLY')?.capability['backend-uat'].usable === false,
      JSON.stringify(rows.get('REC-ONLY')?.capability));
    check('⑪b 不可用要講得出原因', /更新程式碼/.test(String(rows.get('REC-ONLY')?.capability['uat-run'].reason ?? '')),
      rows.get('REC-ONLY')?.capability['uat-run'].reason);

    // ⚠️ 這條對照的是「共用列顯示的可用性」與「派工結果」——兩邊不一致就是這次要修的病
    const start = await call('POST', '/api/frontend-auto/runs/run-cap2/execute', {
      as: ME, body: { steps: '[]', url: 'https://game.example/', platform: 'h5', agentId: 'REC-ONLY' },
    });
    check('⑪b ⚠️ 共用列說執行不可用，派工也要拒絕（同一套判斷）', start.status === 409, `HTTP ${start.status}`);

    const anon = await call('GET', '/api/frontend-auto/agents/overview', { spoof: ME });
    check('⑪b ⚠️ 查不到身分時回 authed:false 而且清單是空的（跟「沒有 Agent」要分得開）',
      anon.json?.authed === false && (anon.json?.agents ?? []).length === 0, JSON.stringify(anon.json));
  }

  // ── ⑪c 明確選「伺服器端」（v4.189.0）────────────────────────────────────
  // ⚠️ `server` 是一個**明確的選擇**，不是 agent id。丟給挑選器會變成
  //    「找不到你自己的 Agent『server』」——那是把使用者的選擇講成他選錯了。
  console.log('⑪c 明確選伺服器端');
  {
    reset();
    addAgent({ agentId: 'MY-PC', ownerKey: ME, capabilities: ['uat-record', 'uat-run'] });

    const run = await call('POST', '/api/frontend-auto/runs/run-srv/execute', {
      as: ME, body: { steps: '[]', url: 'https://game.example/', platform: 'h5', agentId: 'server' },
    });
    check('⑪c 選伺服器端時不會被當成找不到 Agent', run.ok, `HTTP ${run.status} ${JSON.stringify(run.json)}`);
    check('⑪c ⚠️ 而且**不會派給任何 Agent**（就算有一台可用）',
      !(outbox.get('MY-PC') ?? []).some(m => m.type === 'uat_script_run'), JSON.stringify(outbox.get('MY-PC')));
    check('⑪c ⚠️ 回應要講得出跑在哪（原本這個 fallback 是隱形的）',
      run.json?.via === 'server', JSON.stringify(run.json));
    fa.activeRuns.delete('run-srv');

    // 對照組：沒指名而且有可用 Agent → 要派工，而且回應也要講得出來
    const auto = await call('POST', '/api/frontend-auto/runs/run-auto/execute', {
      as: ME, body: { steps: '[]', url: 'https://game.example/', platform: 'h5' },
    });
    check('⑪c 沒指名時照樣派給自己的 Agent', auto.json?.via === 'agent', JSON.stringify(auto.json));
    check('⑪c 而且回得出是哪一台', auto.json?.agentId === 'MY-PC', JSON.stringify(auto.json));
    fa.activeRuns.delete('run-auto');
  }

  // ── ⑫ 身分簽章本身 ────────────────────────────────────────────────────
  console.log('⑫ 跨 process 的身分簽章');
  {
    const signed = signInternalIdentity(ME);
    check('⑫ 正常簽章驗得過', verifyInternalIdentity(signed.email, String(signed.issuedAt), signed.signature) === ME);
    check('⑫ ⚠️ 改了 email 就驗不過（簽章綁的是 email）',
      verifyInternalIdentity(OTHER, String(signed.issuedAt), signed.signature) === undefined);
    check('⑫ ⚠️ 改了時間戳就驗不過',
      verifyInternalIdentity(signed.email, String(signed.issuedAt + 1), signed.signature) === undefined);
    // ⚠️ 這兩條要**用那個時間戳真的簽一份**，否則擋下來的是簽章不符、不是有效期
    const old = signInternalIdentity(ME, Date.now() - 10 * 60_000);
    check('⑫ ⚠️ 過期的驗不過（只簽 email 的話被看到就能永久重放）',
      verifyInternalIdentity(old.email, String(old.issuedAt), old.signature) === undefined,
      '簽章合法但時間戳很舊——擋下來的必須是有效期那一道');
    const future = signInternalIdentity(ME, Date.now() + 10 * 60_000);
    check('⑫ ⚠️ 未來的戳記也驗不過（時間窗兩邊都要擋）',
      verifyInternalIdentity(future.email, String(future.issuedAt), future.signature) === undefined);
    check('⑫ ⚠️ 少了簽章驗不過', verifyInternalIdentity(ME, String(Date.now()), '') === undefined);
  }

  // ── ⑬ 前端 server 那一側的接線（⚠️ 只是原始碼比對）────────────────────
  // 這支測試連不到 index.ts 的 proxy（它只掛得起 worker 的 router），
  // 所以這一段**證明不了行為**，只證明那幾行還在。回報時不可以講成已驗證行為。
  console.log('⑬ index.ts 的 proxy 接線（只是原始碼比對）');
  {
    const fs = await import('fs');
    const src = fs.readFileSync(path.join(root, 'server/index.ts'), 'utf8');
    const at = (needle) => src.indexOf(needle);
    check('⑬ proxy 有刪掉客戶端帶來的身分 header',
      at("headers.delete('x-auth-email')") >= 0 && at("headers.delete('x-auth-sig')") >= 0,
      '不刪的話呼叫端自己塞一組就直接穿到 worker，簽章等於沒做');
    check('⑬ ⚠️ 而且是**先刪再設**',
      at("headers.delete('x-auth-sig')") < at("headers.set('x-auth-sig'"),
      '順序反過來就把自己簽的那份刪掉了');
    check('⑬ ⚠️ 簽的是 cookie 驗過的 authEmail，不是 header 來的 user',
      /signInternalIdentity\(ctx\.authEmail\)/.test(src),
      '拿 ctx.user 去簽等於把冒名蓋個章送過去');
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

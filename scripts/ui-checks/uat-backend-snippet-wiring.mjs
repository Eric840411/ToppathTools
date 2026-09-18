/**
 * scripts/ui-checks/uat-backend-snippet-wiring.mjs
 *
 * 驗「後台設定積木」在**執行流程**上的接線（v4.191.0）。
 *
 * ## 這在守什麼
 *   ① **兩個執行器都要實作**。只做伺服器端的話，agent 模式會掉到
 *      「不支援的動作 → **跳過**」——腳本照樣 PASS，而後台的設定根本沒做。
 *      （v4.167.0 的 `fill` 就是這樣咬過一次。）
 *   ② **片段 id 在 server 這一側換成步驟**，解析不到要明確失敗——不能讓那一步變成
 *      空的照樣跑過去（「設定沒做但測試綠燈」是這個功能最怕的結果）。
 *   ③ **只有用到後台積木時才把帳密送出去**——沒用到的腳本不該帶著憑證跑，
 *      尤其 agent 模式是送到另一台機器上。
 *
 * ①⑤ 是接線檢查（讀原始碼），②③ 是**真的把 router 掛進 express 打**。
 * ⚠️ 接線檢查證明不了行為，回報時不可以講成「已驗證行為」。
 *
 * 跑法：node scripts/ui-checks/uat-backend-snippet-wiring.mjs
 * ⚠️ 需要先 `npm run build`。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { stripComments } from './lib/strip-comments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// ── ① 兩個執行器都要認得這顆積木（⚠️ 只是原始碼比對）──────────────────────
console.log('① 兩個執行器都要實作（只做一邊的話另一邊會靜默跳過）');
for (const [label, file] of [
  ['伺服器模式', 'server/routes/frontend-auto.ts'],
  ['agent 模式', 'server/agent-runner.ts'],
]) {
  const src = stripComments(read(file));
  check(`① ${label}：認得 backend_snippet`,
    /step\.action === 'backend_snippet'/.test(src),
    '沒有的話會掉到「不支援的動作 → 跳過」，腳本照樣 PASS 但設定沒做');
  check(`① ${label}：失敗要 throw（走 failureMode），不是記一筆就過`,
    /if \(!opResult\.ok\) throw new Error/.test(src));
  check(`① ${label}：沒有帳密時要明確失敗`,
    /沒有後台帳密/.test(src));
  // 🚨 不認得的動作**一律失敗，不能跳過**。原本的「跳過」讓一個既有 bug 隱形很久：
  //    `find_baseline_scroll` 只有伺服器端實作，派工給 agent 時被跳過——腳本照樣 PASS，
  //    而視覺比對根本沒跑（而框選截圖自動產生的就是那顆積木）。
  //    ⚠️ 這裡是**接線檢查**，證明不了行為；真正的行為驗證要等端到端那支。
  check(`① ${label}：⚠️ 不認得的動作要失敗，不是跳過`,
    /不支援「\$\{step\.action\}」這個動作/.test(src) && !/status: 'skip'/.test(src),
    '跳過的話會拿到「綠燈但那一步沒跑」——最糟的失敗方式');
}

// ── ②③ 真的打 execute ────────────────────────────────────────────────────
console.log('②③ 真的打 /runs/:id/execute');
{
  const express = (await import('express')).default;
  const hub = await load('dist-server/server/agent-hub.js');
  const fa = await load('dist-server/server/routes/frontend-auto.js');
  const { runWithRequestContext } = await load('dist-server/server/request-context.js');
  const { signInternalIdentity } = await load('dist-server/server/shared.js');
  const { db } = await load('dist-server/server/shared.js');

  const ME = 'snippet-wire@toppath.invalid';
  const outbox = [];
  const agentId = 'SNIPPET-PC';
  hub.agentConnections.set(agentId, {
    agentId, ownerKey: ME, ownerName: ME, hostname: agentId,
    capabilities: ['uat-run'], busy: false, connectedAt: Date.now(), lastSeenAt: Date.now(), sessionId: null,
    ws: { readyState: 1, OPEN: 1, send: (raw) => outbox.push(JSON.parse(raw)) },
  });

  // 後台帳密（跑完刪掉）
  db.prepare('INSERT OR REPLACE INTO uat_backend_credentials (email, profile, username, password, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ME, 'cpBackend', 'cp-user', 'cp-pass', Date.now());
  // 一份真的片段
  const snippetId = 'snippet-wire-test';
  db.prepare('INSERT OR REPLACE INTO uat_backend_snippets (id, owner, title, note, steps, revision, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(snippetId, ME, '開啟 XX 開關', '', JSON.stringify([{ action: 'set_checked', selector: '#sw', checked: true }]), Date.now());

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const signed = signInternalIdentity(ME);
    runWithRequestContext(
      { ip: '127.0.0.1', user: ME, userDisplay: ME, authEmail: signed.email, path: req.path, method: req.method, operation: 'test' },
      () => next(),
    );
  });
  app.use(fa.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const execute = async (runId, steps) => {
    const response = await fetch(`${base}/api/frontend-auto/runs/${runId}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: JSON.stringify(steps), url: 'https://game.example/', platform: 'h5', agentId }),
    });
    let json = null;
    try { json = await response.json() } catch { /* ignore */ }
    return { status: response.status, ok: response.ok, json };
  };

  try {
    // ② 片段 id → 步驟
    outbox.length = 0;
    const good = await execute('run-snip-ok', [{ action: 'backend_snippet', snippetId, name: '開關' }]);
    check('② 有效的片段派得出去', good.ok, `HTTP ${good.status} ${JSON.stringify(good.json)}`);
    const job = outbox.find(m => m.type === 'uat_script_run');
    const sentSteps = job ? JSON.parse(job.steps) : [];
    check('② ⚠️ 送給 agent 的是**解析後的步驟**（agent 拿不到 DB，不能讓它自己查）',
      Array.isArray(sentSteps[0]?.snippetSteps) && sentSteps[0].snippetSteps[0]?.action === 'set_checked',
      JSON.stringify(sentSteps[0]));
    check('② 也帶了片段名稱（日誌要講得出跑了哪一份）',
      sentSteps[0]?.snippetTitle === '開啟 XX 開關', JSON.stringify(sentSteps[0]?.snippetTitle));
    check('③ ⚠️ 有用到後台積木 → 帳密有帶',
      !!job?.backend?.username && !!job?.backend?.password, JSON.stringify(Object.keys(job?.backend ?? {})));
    fa.activeRuns.delete('run-snip-ok');

    // ③ 沒用到就不帶帳密
    outbox.length = 0;
    const plain = await execute('run-snip-plain', [{ action: 'goto', value: 'https://game.example/' }]);
    check('③ 一般腳本照樣派得出去', plain.ok, `HTTP ${plain.status}`);
    const plainJob = outbox.find(m => m.type === 'uat_script_run');
    check('③ ⚠️ **沒用到後台積木就不帶帳密**（不該把憑證送到另一台機器）',
      !plainJob?.backend, JSON.stringify(plainJob?.backend));
    fa.activeRuns.delete('run-snip-plain');

    // ② 引用不存在的片段 → 明確失敗，而且不派工
    outbox.length = 0;
    const gone = await execute('run-snip-gone', [{ action: 'backend_snippet', snippetId: 'no-such-id', name: '開關' }]);
    check('② ⚠️ 引用不存在的片段 → 擋下來（不能讓那一步變空的照樣跑）',
      gone.status === 400, `HTTP ${gone.status} ${JSON.stringify(gone.json)}`);
    check('② 而且訊息講得出原因',
      /不存在|刪/.test(String(gone.json?.message ?? '')), gone.json?.message);
    check('② ⚠️ 被擋下來時完全沒有派工',
      !outbox.some(m => m.type === 'uat_script_run'), JSON.stringify(outbox));
    check('② ⚠️ 也沒有留下 activeRun', !fa.activeRuns.has('run-snip-gone'));

    // ② 沒選片段的積木
    outbox.length = 0;
    const empty = await execute('run-snip-empty', [{ action: 'backend_snippet', name: '開關' }]);
    check('② ⚠️ 積木還沒選片段 → 擋下來', empty.status === 400, `HTTP ${empty.status}`);
    check('② 訊息要講「還沒選」', /還沒選/.test(String(empty.json?.message ?? '')), empty.json?.message);

    // ③ 沒填後台帳密時要擋，而且講得出怎麼補
    db.prepare('DELETE FROM uat_backend_credentials WHERE email = ?').run(ME);
    outbox.length = 0;
    const noCred = await execute('run-snip-nocred', [{ action: 'backend_snippet', snippetId, name: '開關' }]);
    check('③ ⚠️ 沒有後台帳密 → 擋下來（不要跑到一半才發現）',
      noCred.status === 400, `HTTP ${noCred.status}`);
    check('③ 訊息要講怎麼補', /帳密/.test(String(noCred.json?.message ?? '')), noCred.json?.message);
    check('③ ⚠️ 而且沒有派工', !outbox.some(m => m.type === 'uat_script_run'));
  } finally {
    try { db.prepare('DELETE FROM uat_backend_snippets WHERE id = ?').run(snippetId) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM uat_backend_credentials WHERE email = ?').run(ME) } catch { /* ignore */ }
    hub.agentConnections.delete(agentId);
    for (const id of ['run-snip-ok', 'run-snip-plain', 'run-snip-gone', 'run-snip-empty', 'run-snip-nocred']) fa.activeRuns.delete(id);
    server.close();
  }
}

// ── ④ 積木清單與序列化 ────────────────────────────────────────────────────
console.log('④ 前端的積木定義');
{
  const model = stripComments(read('src/features/uat/step-model.ts'));
  check('④ 積木清單有 backend_snippet', /action: 'backend_snippet'/.test(model));
  check('④ ⚠️ 序列化有帶 snippetId（漏了的話存檔之後參數會消失，而且不報錯）',
    /'snippetId'/.test(model),
    'step-model 的 cleanStep 兩行白名單少一個欄位就會靜默掉參數');
}

// ── ⑤ agent 的檔案白名單 ──────────────────────────────────────────────────
console.log('⑤ agent 檔案白名單');
{
  const mt = stripComments(read('server/routes/machine-test.ts'));
  check('⑤ ⚠️ backend-ops.js 在白名單裡（漏了的話 agent 會在 import 當下整支炸掉）',
    /'uat-runner\/backend-ops\.js'/.test(mt));
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

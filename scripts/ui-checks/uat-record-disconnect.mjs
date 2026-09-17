/**
 * scripts/ui-checks/uat-record-disconnect.mjs
 *
 * 驗「Local Agent 斷線 → H5/PC 錄製與執行的收尾」。
 *
 * Backend 那三條路（錄製、機測、Backend UAT）早就在 `ws.on('close')` 收了，
 * **只有 H5/PC 這條一直沒收**。留下來的兩種殘骸壞法都是安靜的：
 *
 *   ① `uatAgentSessions` 的錄製 session 帶著 `done:false` 永遠留著。
 *      今天無害，但只要哪天有人拿它當「這台正在錄製」的鎖讀（並行那一案就是），
 *      一次斷線就會讓那台 agent 永遠錄不了，而症狀是「Agent 都在忙碌中」——
 *      看起來像使用者自己的問題、不像 bug。`heavy-task-guard.ts` 踩過一模一樣的。
 *   ② `uatRunSessions` 的 run 永遠停在「執行中」：DB 的 `result` 留在 `running`、
 *      `activeRuns` 留著那個 runId。畫面上是一條再也不會前進的紀錄，沒有錯誤訊息。
 *
 * 而「收掉」也有一個做過頭的方向，同樣要擋：
 *   ③ 只設 `done` 不標中斷 → 前端在 `done` 就停止輪詢並顯示「錄製完成」，
 *      斷在半路看起來像順利結束。
 *   ④ 把 session 直接 delete 掉 → 已錄到的積木一起沒了。
 *      `docs/decisions.md` 明定**斷線不代表停止**，步驟要留著讓人取回。
 *
 * 跑法：node scripts/ui-checks/uat-record-disconnect.mjs
 * ⚠️ 需要先 `npm run build`（behavioral 段吃的是 dist-server 的編譯結果）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { stripComments } from './lib/strip-comments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// ⚠️ 剝註解不能用純正則——XPath 字串裡的 /* 會被當成區塊註解開頭吃掉整段程式碼，
//    而那會讓「不得出現某模式」那類斷言**假通過**。
const strip = stripComments;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

// ── behavioral：真的把 session 放進去，呼叫斷線處理，看它變成什麼 ────────────
const hub = await import(pathToFileURL(path.join(root, 'dist-server/server/agent-hub.js')).href);
const fa = await import(pathToFileURL(path.join(root, 'dist-server/server/routes/frontend-auto.js')).href);
const { uatAgentSessions, uatRunSessions } = hub;
const { handleUatRecordAgentDisconnect, handleUatRunAgentDisconnect, activeRuns, logBuffers } = fa;
const { db } = await import(pathToFileURL(path.join(root, 'dist-server/server/shared.js')).href);

const AGENT = 'agent-under-test';
const OTHER = 'agent-bystander';

console.log('① 錄製 session：斷線要收，但不能連步驟一起收掉');
{
  uatAgentSessions.set('rec-live', {
    agentId: AGENT,
    steps: [{ action: 'goto', value: 'https://g/' }, { action: 'click', selector: '#play' }],
    cropPending: true,
    done: false,
  });
  uatAgentSessions.set('rec-other', { agentId: OTHER, steps: [{ action: 'goto' }], cropPending: false, done: false });
  uatAgentSessions.set('rec-finished', { agentId: AGENT, steps: [], cropPending: false, done: true });

  handleUatRecordAgentDisconnect(AGENT, 'QA-PC-01');

  const live = uatAgentSessions.get('rec-live');
  check('錄製中的 session 被標成結束', live?.done === true);
  // ⚠️ 這條是 ③：只設 done 的話畫面會寫「錄製完成」。
  check('而且標得出是「中斷」不是「完成」', typeof live?.error === 'string' && live.error.length > 0,
    '少了 error，前端在 done 分支只會說「錄製完成」，斷在半路看起來像順利結束');
  check('中斷訊息帶得出是哪一台', live?.error?.includes('QA-PC-01') === true);
  // ⚠️ 這條是 ④：delete 掉的話這裡會拿到 undefined。
  check('session 留著、已錄到的步驟一步都沒少', uatAgentSessions.has('rec-live') && live?.steps.length === 2,
    'docs/decisions.md：斷線不代表停止，步驟要留著讓使用者取回');
  check('沒收完的框選請求要一起清掉', live?.cropPending === false,
    '留著的話畫面會一直顯示「框選中」，而那個框選永遠不會回來');
  check('⚠️ 不會誤傷別台 agent 的錄製', uatAgentSessions.get('rec-other')?.done === false);
  check('⚠️ 不會覆蓋已經正常結束的 session', uatAgentSessions.get('rec-finished')?.error === undefined,
    '正常停止的錄製被補上一句「連線中斷」會讓人以為出過事');

  uatAgentSessions.clear();
}

console.log('② 執行中的 run：斷線要讓它停在「失敗」，不是永遠「執行中」');
{
  const runId = `uat-disconnect-check-${Date.now()}`;
  const otherRunId = `${runId}-other`;
  db.prepare(`INSERT INTO frontend_auto_runs (id, script_id, script_name, platform, total_steps, result, started_at)
              VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(runId, 'sc1', '斷線測試', 'h5', 3, Date.now());
  db.prepare(`INSERT INTO frontend_auto_runs (id, script_id, script_name, platform, total_steps, result, started_at)
              VALUES (?, ?, ?, ?, ?, 'stopped', ?)`).run(otherRunId, 'sc1', '使用者自己停掉的', 'h5', 3, Date.now());
  try {
    uatRunSessions.set(runId, { agentId: AGENT, runId, done: false });
    // ⚠️ 這筆是「session 還在、但 DB 已經有結論」的狀態——使用者按停止跟 agent 斷線
    //    撞在一起就會長這樣。`AND result='running'` 就是在擋這個：
    //    他自己停掉的東西不該因為之後斷線被改寫成「失敗」。
    uatRunSessions.set(otherRunId, { agentId: AGENT, runId: otherRunId, done: false });
    activeRuns.add(runId);

    handleUatRunAgentDisconnect(AGENT, 'QA-PC-01');

    check('run session 被移除', !uatRunSessions.has(runId));
    check('activeRuns 也放掉', !activeRuns.has(runId),
      '不放的話那個 runId 之後永遠被 409 擋住');
    const row = db.prepare('SELECT result, finished_at FROM frontend_auto_runs WHERE id = ?').get(runId);
    check('DB 的執行紀錄從 running 變成 fail', row?.result === 'fail',
      '留在 running 的話畫面上是一條再也不會前進的執行紀錄');
    check('而且有收尾時間', typeof row?.finished_at === 'number' && row.finished_at > 0);
    check('日誌看得到斷線原因', (logBuffers.get(runId) ?? []).some(l => l.includes('連線中斷')),
      '只改 DB 不寫 log 的話，使用者盯著 log 面板只會看到它突然不動了');
    // ⚠️ 這條的 fixture 必須是「**被處理到、但 DB 已有結論**」的那筆，
    //    不能拿 `done:true`（會在迴圈開頭就 continue）——那樣拿掉 `AND result='running'`
    //    照樣全綠，等於沒測。注入測試抓到過一次。
    const bystander = db.prepare('SELECT result FROM frontend_auto_runs WHERE id = ?').get(otherRunId);
    check('⚠️ 不會把已經有結論的紀錄改寫成 fail', bystander?.result === 'stopped',
      "少了 AND result='running'，使用者自己按停止的那筆會在斷線時被改成「失敗」");
  } finally {
    db.prepare('DELETE FROM frontend_auto_runs WHERE id IN (?, ?)').run(runId, otherRunId);
    uatRunSessions.clear();
    activeRuns.delete(runId);
    logBuffers.delete(runId);
  }
}

// ── static：接線。上面兩支寫得再對，沒有人在斷線時呼叫它們也是零 ──────────────
console.log('③ 接線：worker 的 ws.on(close) 真的有呼叫');
{
  const worker = strip(read('server/worker.ts'));
  // 只看 agent 那段的 close handler——viewer 的 close 也在同一支檔案裡。
  const closeIdx = worker.lastIndexOf("ws.on('close'");
  const closeBody = closeIdx >= 0 ? worker.slice(closeIdx, closeIdx + 1600) : '';
  check('worker 有 import 這兩支', /handleUatRecordAgentDisconnect/.test(worker) && /handleUatRunAgentDisconnect/.test(worker));
  check('錄製收尾掛在 agent 的 close handler 裡', /handleUatRecordAgentDisconnect\s*\(/.test(closeBody));
  check('執行收尾掛在 agent 的 close handler 裡', /handleUatRunAgentDisconnect\s*\(/.test(closeBody));
}

console.log('④ 前端：中斷跟完成要分得開');
{
  const studio = strip(read('src/features/uat/FrontendAutomationStudio.tsx'));
  const fauto = strip(read('server/routes/frontend-auto.ts'));
  check('/record/status 把 error 帶給前端', /error:\s*agentSess\.error/.test(fauto),
    '不帶的話前端拿不到中斷理由，只能顯示「完成」');
  check('前端在 done 時會分岔顯示中斷訊息', /status\.error\s*\?/.test(studio),
    '少了這個分岔，斷線在畫面上長得跟正常結束一模一樣');
  check('中斷時仍然回報取回了幾個步驟', /status\.error[\s\S]{0,200}steps\?\.length/.test(studio),
    '要讓人知道東西沒白錄');
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

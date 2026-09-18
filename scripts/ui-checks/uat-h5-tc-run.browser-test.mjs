/**
 * scripts/ui-checks/uat-h5-tc-run.browser-test.mjs
 *
 * **綁了 TC 的 H5 腳本，從執行到回寫 Lark 的端到端測試。**
 * 真的開瀏覽器、真的走產品的 `/runs/:id/execute`、真的把回寫請求收下來看內容。
 *
 * ## 為什麼一定要打到「真的回寫」這一層
 * 這條路上每一種壞法都是**安靜的**：
 *   - 判定聚合錯 → 畫面顯示的結果跟寫進 Lark 的不一樣，但兩邊都有東西
 *   - 欄位名寫錯／互斥沒維護 → Lark 回 code≠0，沒人看就變成「畫面全綠、表上沒東西」
 *   - 截圖沒接回所屬 TC → 每一列都有圖，但是別人的圖
 *
 * 所以這支架一個**假的 Lark**，把 PUT 進來的 `fields` 原封不動留下來比對。
 * ⚠️ 假的是「傳輸對象」，不是產品邏輯——判定、欄位組裝、上傳流程走的都是產品那一份。
 *
 * ## 守的幾件事
 *   ① 綁了 TC 的腳本跑得完，判定**依 TC 分開**（一筆失敗不影響另一筆）
 *   ② 截圖只掛到所屬那一筆
 *   ③ 回寫的欄位是 PASS／FAIL 互斥 ＋ 附圖，待確認兩個都清掉
 *   ④ **開瀏覽器之前就擋**：檢查類積木沒指定 TC、不認得的動作
 *   ⑤ 回寫失敗要讓整輪算失敗（不能安靜帶過）
 *
 * 跑法：node scripts/ui-checks/uat-h5-tc-run.browser-test.mjs
 * ⚠️ 需要先 `npm run build`。
 */
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// ── 受測頁面 ──────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><meta charset="utf-8"><title>tc fixture</title>
<button id="play">開始</button><div id="lobby">大廳</div>`;
const site = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

// ── 假的 Lark ─────────────────────────────────────────────────────────────
// 收下 token 請求、附件上傳、以及每一列的 PUT，把 fields 原封不動留著給斷言看。
const larkPuts = [];
const larkUploads = [];
let uploadShouldFail = false;
const lark = http.createServer((req, res) => {
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) };
  if (req.url.includes('/auth/v3/tenant_access_token')) return send({ code: 0, tenant_access_token: 'fake-token' });
  if (req.url.includes('/drive/v1/medias/upload_all')) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    return req.on('end', () => {
      if (uploadShouldFail) return send({ code: 1254006, msg: 'fake upload failure' });
      const id = `file_${larkUploads.length + 1}`;
      larkUploads.push({ id, bytes: Buffer.concat(chunks).length });
      send({ code: 0, data: { file_token: id } });
    });
  }
  const put = /\/tables\/([^/]+)\/records\/([^/?]+)/.exec(req.url);
  if (put && req.method === 'PUT') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    return req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 壞掉的也留著 */ }
      larkPuts.push({ tableId: put[1], recordId: put[2], fields: body.fields ?? {} });
      send({ code: 0, data: {} });
    });
  }
  send({ code: 0 });
});
await new Promise(r => lark.listen(0, '127.0.0.1', r));
process.env.LARK_BASE_URL = `http://127.0.0.1:${lark.address().port}`;
process.env.LARK_APP_ID = 'fake-app';
process.env.LARK_APP_SECRET = 'fake-secret';

// ── 掛起產品的 router ─────────────────────────────────────────────────────
const express = (await import('express')).default;
const fa = await load('dist-server/server/routes/frontend-auto.js');
const hub = await load('dist-server/server/agent-hub.js');
const { runWithRequestContext } = await load('dist-server/server/request-context.js');
const { signInternalIdentity, db } = await load('dist-server/server/shared.js');

const ME = 'h5-tc-run@toppath.invalid';
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

const waitForRun = async (runId, timeoutMs = 120_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const lines = fa.logBuffers.get(runId) ?? [];
    if (lines.some(l => l.includes('─── 完成 ───'))) return lines;
    await new Promise(r => setTimeout(r, 250));
  }
  return fa.logBuffers.get(runId) ?? [];
};

const LARK_URL = 'https://fake.larksuite.com/base/appFAKE123?table=tblFAKE456';
const made = [];
const runIds = [];

/** 建一份綁了 TC 的腳本 ＋ 一筆 run 紀錄，回 runId */
const setup = (bindings) => {
  const scriptId = `tcrun-script-${Date.now()}-${made.length}`;
  db.prepare(`INSERT INTO frontend_auto_scripts
      (id, name, platform, steps, created_by, is_public, created_at, updated_at, lark_url, table_id, bindings)
      VALUES (?, ?, 'h5', '[]', ?, 1, ?, ?, ?, 'tblFAKE456', ?)`)
    .run(scriptId, 'TC 執行測試', ME, Date.now(), Date.now(), LARK_URL, JSON.stringify(bindings));
  made.push(scriptId);
  const runId = `tcrun-${Date.now()}-${runIds.length}`;
  db.prepare(`INSERT INTO frontend_auto_runs (id, script_id, script_name, platform, ran_by, total_steps, started_at)
      VALUES (?, ?, ?, 'h5', ?, 0, ?)`).run(runId, scriptId, 'TC 執行測試', ME, Date.now());
  runIds.push(runId);
  return runId;
};

const execute = (runId, steps) => fetch(`${base}/api/frontend-auto/runs/${runId}/execute`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ steps: JSON.stringify(steps), url: siteUrl, platform: 'h5', resolution: '500x877', failureMode: 'continue', headed: false }),
});

const BINDINGS = [
  { recordId: 'recPASS', number: 'TC-001', text: '大廳要看得到' },
  { recordId: 'recFAIL', number: 'TC-002', text: '這個元素不存在' },
  { recordId: 'recMANUAL', number: 'TC-003', text: '只截圖沒檢查' },
];

try {
  hub.agentConnections.clear();

  // ── ④ 開瀏覽器之前就擋 ──────────────────────────────────────────────────
  {
    const runId = setup(BINDINGS);
    const res = await execute(runId, [
      { action: 'goto', name: '前往', value: siteUrl },
      // 檢查類積木沒指定 TC
      { action: 'assert_visible', name: '沒歸戶的檢查', selector: '#lobby' },
    ]);
    const body = await res.json().catch(() => ({}));
    check('④ 檢查類積木沒指定 TC → 執行前就擋下來（400）', res.status === 400, `HTTP ${res.status} ${JSON.stringify(body)}`);
    check('④ 而且指得出是第幾步', /第 2 步/.test(body.message ?? ''), body.message);
    check('④ 擋下來就不該留下執行中的紀錄', !fa.activeRuns.has(runId), '被擋了卻還佔著執行鎖');
  }
  {
    const runId = setup(BINDINGS);
    const res = await execute(runId, [
      { action: 'goto', name: '前往', value: siteUrl },
      { action: '__not_a_block__', name: '不認得的', tcId: 'recPASS' },
    ]);
    const body = await res.json().catch(() => ({}));
    check('④ 🚨 不認得的動作 → 執行前就擋（不是跑到那一步才發現）', res.status === 400, `HTTP ${res.status}`);
    check('④ 而且指名是哪個動作', /__not_a_block__/.test(body.message ?? ''), body.message);
  }
  {
    // H5 的積木**不能**被 Backend 的分類表擋掉——用錯分類表的話這一條會紅
    const runId = setup(BINDINGS);
    const res = await execute(runId, [
      { action: 'goto', name: '前往', value: siteUrl },
      { action: 'assert_visible', name: '正常的檢查', selector: '#lobby', tcId: 'recPASS' },
    ]);
    check('④ ⚠️ 正常的 H5 積木不能被擋（分類表要用 H5 那張，不是 Backend 的）',
      res.status === 200, `HTTP ${res.status} ${JSON.stringify(await res.json().catch(() => ({})))}`);
    await waitForRun(runId);
  }

  // ── ①②③ 正式跑一輪 ────────────────────────────────────────────────────
  larkPuts.length = 0; larkUploads.length = 0;
  const runId = setup(BINDINGS);
  const res = await execute(runId, [
    { action: 'goto', name: '前往頁面', value: siteUrl },
    { action: 'assert_visible', name: '大廳可見', selector: '#lobby', tcId: 'recPASS' },
    { action: 'screenshot', name: '大廳存證', tcId: 'recPASS' },
    { action: 'assert_visible', name: '不存在的元素', selector: '#definitely-not-here', tcId: 'recFAIL' },
    { action: 'screenshot', name: '只截圖', tcId: 'recMANUAL' },
  ]);
  check('① 綁了 TC 的腳本啟動得起來', res.ok, `HTTP ${res.status}`);
  const lines = await waitForRun(runId);
  const log = lines.join('\n');
  check('① 真的跑完了（不是逾時）', log.includes('─── 完成 ───'), lines.slice(-4).join(' | '));

  const byRecord = Object.fromEntries(larkPuts.map(p => [p.recordId, p]));
  check('③ 三筆 TC 都回寫了', larkPuts.length === 3, `實際 ${larkPuts.length} 筆：${JSON.stringify(larkPuts.map(p => p.recordId))}`);
  check('③ 寫到的是腳本綁的那張表', larkPuts.every(p => p.tableId === 'tblFAKE456'), JSON.stringify(larkPuts.map(p => p.tableId)));

  check('① 通過的那一筆：PASS 勾起來、FAIL 清掉',
    byRecord.recPASS?.fields.PASS === true && byRecord.recPASS?.fields.FAIL === false,
    JSON.stringify(byRecord.recPASS?.fields));
  check('① 🚨 失敗的那一筆不影響通過的那一筆（失敗隔離）',
    byRecord.recFAIL?.fields.FAIL === true && byRecord.recFAIL?.fields.PASS === false,
    JSON.stringify(byRecord.recFAIL?.fields));
  check('③ 🚨 只截圖沒檢查的那一筆：兩個框都清掉（不是通過）',
    byRecord.recMANUAL?.fields.PASS === false && byRecord.recMANUAL?.fields.FAIL === false,
    JSON.stringify(byRecord.recMANUAL?.fields));

  check('② 截圖有真的上傳（不是拍完就丟）', larkUploads.length > 0, `上傳了 ${larkUploads.length} 張`);
  check('② 上傳的是真的圖（不是 0 bytes）', larkUploads.every(u => u.bytes > 1000), JSON.stringify(larkUploads));
  check('② 🚨 截圖只掛到所屬那一筆',
    (byRecord.recPASS?.fields['附圖'] ?? []).length === 1 && (byRecord.recMANUAL?.fields['附圖'] ?? []).length === 1,
    `recPASS=${JSON.stringify(byRecord.recPASS?.fields['附圖'])} recMANUAL=${JSON.stringify(byRecord.recMANUAL?.fields['附圖'])}`);
  check('② 失敗那一筆也有證據圖（失敗時自動補截）',
    (byRecord.recFAIL?.fields['附圖'] ?? []).length >= 1, JSON.stringify(byRecord.recFAIL?.fields['附圖']));
  check('② ⚠️ 三筆的圖不是同一張（灑給每一筆的話這條會紅）',
    new Set(larkPuts.flatMap(p => (p.fields['附圖'] ?? []).map(a => a.file_token))).size === larkPuts.reduce((n, p) => n + (p.fields['附圖'] ?? []).length, 0),
    JSON.stringify(larkPuts.map(p => p.fields['附圖'])));

  check('① 日誌逐筆講得出每個 TC 的結果', /TC 大廳要看得到：pass/.test(log) && /TC 這個元素不存在：fail/.test(log),
    lines.filter(l => l.includes('TC ')).join(' | '));
  check('③ 回寫成功要講出來', /已回寫 3 筆 TC/.test(log), lines.filter(l => l.includes('回寫')).join(' | '));

  const runRow = db.prepare('SELECT passed, failed, skipped, result FROM frontend_auto_runs WHERE id = ?').get(runId);
  check('① 執行紀錄存的是 TC 的統計（不是步驟數）',
    runRow?.passed === 1 && runRow?.failed === 1 && runRow?.skipped === 1, JSON.stringify(runRow));
  check('① 有 TC 失敗 → 整輪結論是失敗', runRow?.result === 'fail', JSON.stringify(runRow));

  // ── ⑤ 回寫失敗不能安靜帶過 ──────────────────────────────────────────────
  larkPuts.length = 0; larkUploads.length = 0;
  uploadShouldFail = true;
  const failRunId = setup([{ recordId: 'recUP', number: 'TC-009', text: '上傳會壞掉' }]);
  await execute(failRunId, [
    { action: 'goto', name: '前往頁面', value: siteUrl },
    { action: 'assert_visible', name: '大廳可見', selector: '#lobby', tcId: 'recUP' },
    { action: 'screenshot', name: '存證', tcId: 'recUP' },
  ]);
  const failLog = (await waitForRun(failRunId)).join('\n');
  check('⑤ 🚨 截圖上傳失敗 → 日誌明講沒寫進 Lark', /回寫失敗|沒有寫進 Lark/.test(failLog),
    failLog.split('\n').filter(l => l.includes('回寫') || l.includes('Lark')).join(' | '));
  const failRow = db.prepare('SELECT result FROM frontend_auto_runs WHERE id = ?').get(failRunId);
  check('⑤ 🚨 而且整輪算失敗（畫面全綠但表上沒東西是最糟的結果）',
    failRow?.result === 'fail', JSON.stringify(failRow));
  check('⑤ 那一筆確實沒有被寫進去', larkPuts.length === 0, JSON.stringify(larkPuts));
  uploadShouldFail = false;
  // ── 🚨 綁了 TC 的腳本不能被默默派給 agent ──────────────────────────────
  //    agent 端還沒接上回寫。派出去的話會「跑完、顯示通過、Lark 一個字都沒寫」。
  {
    const fakeWs = { readyState: 1, OPEN: 1, send() {} };
    hub.agentConnections.set('fake-agent', {
      agentId: 'fake-agent', hostname: 'fake', ws: fakeWs,
      // ⚠️ `ownerKey` 才是派工用的擁有者欄位（不是 owner／ownerEmail）——
      //    填錯的話這台根本不會被挑中，測試會安靜地變成「沒有 agent」的情境。
      capabilities: ['uat-run'], ownerKey: ME, owner: ME, busy: false, lastSeen: Date.now(),
    });
    try {
      const runId = setup(BINDINGS);
      const res = await execute(runId, [
        { action: 'goto', name: '前往', value: siteUrl },
        { action: 'assert_visible', name: '大廳可見', selector: '#lobby', tcId: 'recPASS' },
      ]);
      const body = await res.json().catch(() => ({}));
      check('⑥ 🚨 綁了 TC 的腳本派不出去 agent（會變成跑完但沒回寫）',
        res.status === 409, `HTTP ${res.status} ${JSON.stringify(body)}`);
      check('⑥ 而且講得出要改選伺服器端', /伺服器端/.test(body.message ?? ''), body.message);
      check('⑥ ⚠️ 不能偷偷退回伺服器端跑（那是給一個看起來成功的錯誤答案）',
        !fa.activeRuns.has(runId), '被擋了卻還是跑起來了');
    } finally {
      hub.agentConnections.clear();
    }
  }
} finally {
  for (const id of made) {
    try { db.prepare('DELETE FROM frontend_auto_scripts WHERE id = ?').run(id) } catch { /* 清不掉就算了 */ }
  }
  for (const id of runIds) {
    try { db.prepare('DELETE FROM frontend_auto_runs WHERE id = ?').run(id) } catch { /* 同上 */ }
  }
  server.close(); site.close(); lark.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * 後台對帳的失敗要說得出原因，不能再偽裝成「0 筆」。
 *
 * 背景（2026-09-01 使用者在正式環境回報「怎麼查不到資料」）：
 * `fetchBackendRecords()` 原本任何失敗都是 `break` 回空陣列，於是
 *   ① 執行對帳顯示「後台 0 筆」——跟「這段時間真的沒資料」完全一樣
 *   ② **測試連線更糟**：拿到空陣列還是回「連線成功，測試查詢回傳 0 筆」
 * 兩者都讓人查不出壞在哪，②甚至會把排查引到錯的方向。
 *
 * ⚠️ 這支會**暫時移除本機的 osm token 與帳密**來模擬「這個環境沒設定過」，
 *    跑完一定會還原並驗證還原成功。只動本機 DB，跟 Spug 無關。
 *
 * 跑法：node scripts/ui-checks/reconcile-error-surface.mjs
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const HEAD = { 'Content-Type': 'application/json', Cookie: `toppath_auth=${sess.sid}`, 'x-user-label': 'Eric Wu' };
const post = async (p, body) => (await fetch(`http://localhost:3000${p}`, { method: 'POST', headers: HEAD, body: JSON.stringify(body) })).json();

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

// 今天整天，跟使用者截圖的查詢條件一致
const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const RANGE = { rangeStart: `${day} 00:00:00`, rangeEnd: `${day} 23:59:59`, env: 'osm', machineType: '', playerId: '' };

// ── 先跑一次正常情況當基準 ──
console.log('\n【1】設定齊全（正常情況）');
const okTest = await post('/api/autospin/reconcile/test', { env: 'osm' });
check('測試連線回 ok', okTest.ok === true, okTest.message);
const okRun = await post('/api/autospin/reconcile/run', RANGE);
check('執行對帳 backendStatus = ok', okRun.backendStatus === 'ok', `status=${okRun.backendStatus}`);
check('  沒有 backendError', !okRun.backendError, JSON.stringify(okRun.backendError));
check('  摘要仍正常產出', typeof okRun.summary === 'string' && okRun.summary.includes('後台'), okRun.summary);

// ── 模擬「這個環境沒設定過」──
console.log('\n【2】把 token 與帳密拿掉（模擬正式環境從沒設定過）');
const KEYS = ['osm_token', 'osm_login_password'];
const saved = {};
for (const k of KEYS) saved[k] = db.prepare('SELECT value FROM meter_reconcile_config WHERE key=?').get(k)?.value;
if (Object.values(saved).some(v => v === undefined)) { console.log('本機缺少這些 key，測不了', saved); process.exit(1) }

try {
  for (const k of KEYS) db.prepare('DELETE FROM meter_reconcile_config WHERE key=?').run(k);
  // reconcile_config 也存了一份 token（登入成功時寫進去的），一起清掉才是乾淨的空環境
  const ownToken = db.prepare("SELECT value FROM reconcile_config WHERE key='token'").get()?.value;
  db.prepare("DELETE FROM reconcile_config WHERE key='token'").run();

  const badTest = await post('/api/autospin/reconcile/test', { env: 'osm' });
  check('測試連線回失敗（原本會謊報「連線成功」）', badTest.ok === false, badTest.message);
  check('  訊息指出去哪裡設定', /Performance Meter|設定/.test(badTest.message || ''), badTest.message);

  const badRun = await post('/api/autospin/reconcile/run', RANGE);
  check('執行對帳 backendStatus = failed', badRun.backendStatus === 'failed', `status=${badRun.backendStatus}`);
  check('  backendError.type = missing_config', badRun.backendError?.type === 'missing_config', JSON.stringify(badRun.backendError));
  check('  backendIncomplete = true', badRun.backendIncomplete === true);
  check('  訊息是受控文字，沒有夾帶後台原始內容',
        !/token=|password|Error:|at \w+\./.test(badRun.backendError?.message || ''), badRun.backendError?.message);

  if (ownToken !== undefined) db.prepare("INSERT OR REPLACE INTO reconcile_config (key,value) VALUES ('token',?)").run(ownToken);
} finally {
  for (const k of KEYS) db.prepare('INSERT OR REPLACE INTO meter_reconcile_config (key,value) VALUES (?,?)').run(k, saved[k]);
  const back = KEYS.every(k => db.prepare('SELECT value FROM meter_reconcile_config WHERE key=?').get(k)?.value === saved[k]);
  console.log(`\n還原：${back ? 'OK（兩個 key 都跟原值一致）' : '❌ 沒還原成功，請手動檢查 meter_reconcile_config'}`);
}

// ── 還原後要能恢復正常，證明測試本身沒把環境弄壞 ──
console.log('\n【3】還原後');
const backTest = await post('/api/autospin/reconcile/test', { env: 'osm' });
check('測試連線恢復 ok', backTest.ok === true, backTest.message);

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);

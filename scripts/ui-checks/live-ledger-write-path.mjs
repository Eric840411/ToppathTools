/**
 * scripts/ui-checks/live-ledger-write-path.mjs
 *
 * 驗 `recordSpinObservation()` 真的寫得進去，而且每個欄位都有落庫。
 *
 * ⚠️ **為什麼需要這個檢查**：2026-09-05 加 `outcome` 欄位時，三個地方要改
 * （INSERT 欄位清單／VALUES 佔位符／`.run()` 參數），只改到兩個。結果是
 * `RangeError: Too many parameter values were provided`——**連續兩小時每一筆
 * 都落庫失敗、零筆寫入，而外部完全看不出來**：HTTP 200、端點一直在被打、
 * 回應是 `{ok:false}` 但沒有原因。
 *
 * 型別檢查抓不到（SQL 是字串）、align 那 49 項也抓不到（那是純函式不碰 DB）。
 * 只有真的寫一次才測得出來。
 *
 * 這支跑完會**還原**（用專屬 sessionId 再刪掉），不留測試資料。
 */
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { recordSpinObservation } = await import(
  pathToFileURL(path.join(root, 'dist-server/server/live-ledger.js')).href);
const db = new Database(path.join(root, 'server/data.db'));

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

const SID = `__writepath_check_${Date.now()}`;
const before = db.prepare('SELECT COUNT(*) n FROM recon_spin').get().n;

try {
  console.log('1) 每個欄位都要真的落庫（漏改 INSERT 佔位符就會在這裡炸）');
  const row = {
    env: 'qat', sessionId: SID, machineType: 'CHKMT', gmid: '873-CHK-0001',
    spinSeq: 7, betAmount: 152, balanceBefore: 1000, balanceAfter: 848,
    winObserved: 0, observedAt: 1788615000000, outcome: 'completed',
  };
  let threw = null;
  try { recordSpinObservation(row); } catch (e) { threw = e; }
  check('寫入沒有拋例外', threw === null, threw ? String(threw.message).slice(0, 80) : '');

  const got = db.prepare('SELECT * FROM recon_spin WHERE sessionId=?').get(SID);
  check('資料真的進去了', !!got);
  if (got) {
    // 逐欄比對——只驗「有沒有拋例外」的話，少存一個欄位是看不出來的
    for (const [k, want] of Object.entries(row)) {
      if (k === 'sessionId') continue;
      check(`欄位 ${k} 落庫正確`, got[k] === want, `存到 ${JSON.stringify(got[k])}`);
    }
    check('狀態初始為 PENDING', got.status === 'PENDING', got.status);
    check('新欄位 bindMethod 有預設值（不是 null）', got.bindMethod === '');
    check('新欄位 lateArrival 有預設值（不是 null）', got.lateArrival === 0);
  }

  console.log('\n2) upsert：同一筆重送不會產生第二列，而且會更新');
  recordSpinObservation({ ...row, balanceAfter: 700, outcome: 'suspected' });
  const rows = db.prepare('SELECT * FROM recon_spin WHERE sessionId=?').all(SID);
  check('重送不會長出第二列', rows.length === 1, `${rows.length} 列`);
  check('重送會更新 outcome', rows[0]?.outcome === 'suspected', rows[0]?.outcome);
} finally {
  const del = db.prepare('DELETE FROM recon_spin WHERE sessionId=?').run(SID).changes;
  const after = db.prepare('SELECT COUNT(*) n FROM recon_spin').get().n;
  check('測試資料已還原', after === before, `刪 ${del} 筆，${before} → ${after}`);
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);

/**
 * scripts/ui-checks/live-ledger-cycle.mjs
 *
 * 驗迴圈耗時監控 `recordCycleStat()` / `cycleStats()`。
 *
 * ⚠️ **為什麼需要**：拉取是 serial 的，單輪耗時 ≈ 帳號數 × RTT。一旦逼近
 * `pendingTimeoutSec`（90 秒），晚到的後台紀錄還沒被拉回來，spin 就先被判 MISSING
 * ——**看起來像後台掉單，其實是我們自己太慢**。這盞燈是唯一能分辨兩者的東西。
 *
 * 🚨 最容易出錯的是「只算有帳號要拉的輪次」這個過濾。沒有它的話，沒在壓測時
 * 那些 1ms 的空輪會把 p95 壓到趴在地上，**壓測時真的變慢也永遠不會示警**。
 *
 * 跑在正式 data.db 上；`recon_cycle_stat` 是環形診斷紀錄，測試前後都會清掉注入的列。
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { recordCycleStat, cycleStats } = await import(
  pathToFileURL(path.join(root, 'dist-server/server/live-ledger-fetch.js')).href);
const db = new Database(path.join(root, 'server/data.db'));

const now = Date.now();
const MARK = 777000000; // 用一個好認的 at 基準，結尾只刪這批
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

// 先把真實資料搬開，測完放回去——這張表是環形紀錄，不能直接清空
const saved = db.prepare('SELECT * FROM recon_cycle_stat').all();
db.prepare('DELETE FROM recon_cycle_stat').run();

try {
  console.log('1) 空輪（scopes=0）不可以被算進統計');
  // 模擬沒在壓測：100 輪 1ms 的空輪
  for (let i = 0; i < 100; i++) {
    recordCycleStat({ at: MARK + i, totalMs: 1, fetchMs: 0, bindMs: 0, jpMs: 0, notifyMs: 0, scopes: 0, fetched: 0, failures: 0 });
  }
  let st = cycleStats(200);
  check('全是空輪時樣本數為 0（不是 100）', st.samples === 0, `samples=${st.samples}`);
  check('沒有樣本時 p95 是 null 不是 0', st.p95Ms === null, String(st.p95Ms));

  console.log('\n2) 有帳號的輪次才算，統計值要對');
  for (const ms of [1000, 2000, 3000, 4000, 40000]) {
    recordCycleStat({ at: MARK + 1000 + ms, totalMs: ms, fetchMs: ms * 0.9, bindMs: 0, jpMs: 0, notifyMs: 0, scopes: 10, fetched: 5, failures: 0 });
  }
  st = cycleStats(200);
  check('樣本數 = 5（空輪仍然不算）', st.samples === 5, `samples=${st.samples}`);
  check('max 是 40000', st.maxMs === 40000, String(st.maxMs));
  check('p50 落在中間值', st.p50Ms === 3000, String(st.p50Ms));
  // ⚠️ 拉取占比高就代表瓶頸在 serial 逐帳號查詢，那是合併查詢要解的
  check('拉取占比算得出來且接近 0.9',
    st.fetchShare !== null && Math.abs(st.fetchShare - 0.9) < 0.01, String(st.fetchShare));

  console.log('\n3) 🚨 單輪耗時過長要示警（不然假掉單沒有徵兆）');
  const warnAt = st.warnAtMs;
  check('告警門檻 = pendingTimeout 的 1/3（90s → 30s）', Math.abs(warnAt - 30_000) < 1, String(warnAt));
  // 剛剛那 40 秒的輪次超過 30 秒門檻，健康列應該記下來
  const h = db.prepare("SELECT errKind, failCount, message FROM recon_source_health WHERE env='qat' AND source='cycle'").get();
  check('健康列記下 slow_cycle', h?.errKind === 'slow_cycle', JSON.stringify(h?.errKind));
  check('訊息講明會出現假掉單（不是只講「慢」）',
    String(h?.message).includes('假掉單'), String(h?.message).slice(0, 60));

  console.log('\n4) 回到正常耗時要能恢復');
  recordCycleStat({ at: MARK + 99999, totalMs: 1500, fetchMs: 1000, bindMs: 0, jpMs: 0, notifyMs: 0, scopes: 3, fetched: 2, failures: 0 });
  const h2 = db.prepare("SELECT failCount FROM recon_source_health WHERE env='qat' AND source='cycle'").get();
  check('快的輪次會把失敗計數清掉', (h2?.failCount ?? 99) === 0, String(h2?.failCount));

  console.log('\n5) 環形保留：不會無限成長');
  // ⚠️ 要真的寫超過上限才驗得到。第一版只寫了 106 筆（遠低於 500），
  //    把整段保留邏輯拿掉測試照樣全綠——突變測試抓到的空斷言。
  for (let i = 0; i < 520; i++) {
    recordCycleStat({ at: MARK + 200000 + i, totalMs: 100, fetchMs: 50, bindMs: 0, jpMs: 0, notifyMs: 0, scopes: 1, fetched: 1, failures: 0 });
  }
  const after = db.prepare('SELECT COUNT(*) n FROM recon_cycle_stat').get().n;
  check('寫入 600+ 筆之後仍然只留 500 筆', after === 500, `${after} 筆`);
  // 留下來的要是**最新的**那 500 筆，不是最舊的
  const oldest = db.prepare('SELECT MIN(at) t FROM recon_cycle_stat').get().t;
  check('留下來的是最新的那批（最舊的已被清掉）', oldest > MARK + 200000, `oldest=${oldest - MARK}`);
} finally {
  db.prepare('DELETE FROM recon_cycle_stat').run();
  if (saved.length) {
    const ins = db.prepare(`INSERT INTO recon_cycle_stat (id, at, totalMs, fetchMs, bindMs, jpMs, notifyMs, scopes, fetched, failures)
      VALUES (@id, @at, @totalMs, @fetchMs, @bindMs, @jpMs, @notifyMs, @scopes, @fetched, @failures)`);
    const tx = db.transaction(rows => { for (const r of rows) ins.run(r); });
    tx(saved);
  }
  // 健康列也還原成「還沒量過」，不要留著測試造出來的 slow_cycle 紅燈
  db.prepare("DELETE FROM recon_source_health WHERE env='qat' AND source='cycle'").run();
  console.log(`\n(已還原 ${saved.length} 筆原有統計，清掉測試的健康紀錄)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

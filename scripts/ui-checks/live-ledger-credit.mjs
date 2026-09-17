/**
 * scripts/ui-checks/live-ledger-credit.mjs
 *
 * 驗 L3 上下分 `creditChainAudit()`：從後台每局的分數戳記推出帳外的分數異動。
 *
 * ⚠️ **這支要守的三件事，每一件都是「假警報」或「假安心」的來源**：
 *   ① 真的上下分要抓到（否則整條線沒意義）
 *   ② 戳記的 ±一注成對偏差**不可以**被報成金流異常——實測 873-BULLBLITZ-0136
 *      有 94 筆，全部成對抵銷（47 筆 +1250、47 筆 −1250）。報了就是 94 次假警報，
 *      而假警報一多，真正的那 3 筆就沒人看了
 *   ③ 沒有分數戳記的機台要回 `no_stamps` **不可以**混進「乾淨」——
 *      實測 897-BIGFULINK-2065 的 2,110 局全部沒有 begin_machine_coin
 *
 * 跑在正式 data.db 上，注入資料帶 `__credit_` 前綴，結尾刪除。
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { creditChainAudit } = await import(
  pathToFileURL(path.join(root, 'dist-server/server/live-ledger-credit.js')).href);
const db = new Database(path.join(root, 'server/data.db'));

const TAG = '__credit_';
const ENV = 'qat';
const now = Date.now();
const T0 = now - 30 * 60_000;
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

const addRound = (gmid, idx, at, fields) => db.prepare(`
  INSERT INTO recon_backend_record (env, orderId, gmid, playerId, bet, win, balanceBefore, balanceAfter,
    dateTime, fetchedAt, raw, spinIndex, betTimePrecise, username, filterField, filterValue)
  VALUES (?, ?, ?, '1', ?, ?, 0, 0, ?, ?, ?, ?, ?, '__credit_user', 'playerName', '__credit_user')
`).run(ENV, `${TAG}${gmid}-${idx}`, gmid, fields.bet, fields.win, at, now,
  JSON.stringify(fields), idx, at);

/** 造一台正常機台：每局下注 bet、贏 win，分數鏈完全接得上。 */
const makeClean = (gmid, n = 10, bet = 1000, win = 200) => {
  let end = 500_000;
  for (let i = 1; i <= n; i++) {
    const begin = end - bet;
    end = begin + win;
    addRound(gmid, i, T0 + i * 10_000, { bet, win, begin_machine_coin: begin, end_machine_coin: end });
  }
};

const cleanup = () => db.prepare(`DELETE FROM recon_backend_record WHERE orderId LIKE '${TAG}%'`).run().changes;
cleanup();

try {
  const WIN = 0.25 * 3600_000; // 只是讓窗夠大
  const audit = () => creditChainAudit(ENV, T0 - WIN, now + WIN);
  const get = (rows, n) => rows.find(r => r.machineName === n);

  console.log('1) 乾淨的分數鏈');
  makeClean(`${TAG}CLEAN-0001`);
  let rows = audit();
  const clean = get(rows, `${TAG}CLEAN-0001`);
  check('接得上 → clean', clean?.verdict === 'clean', clean?.verdict);
  check('沒有偵測到上下分', clean?.transfers.length === 0);
  check('連續局對數 = 局數 − 1', clean?.pairs === 9, String(clean?.pairs));

  console.log('\n2) 🚨 真的上下分要抓到');
  const g2 = `${TAG}XFER-0002`;
  let end = 500_000;
  for (let i = 1; i <= 10; i++) {
    let begin = end - 1000;
    if (i === 6) begin += 50_000;      // 第 6 局前上分 50,000
    if (i === 9) begin -= 30_000;      // 第 9 局前下分 30,000
    end = begin + 200;
    addRound(g2, i, T0 + i * 10_000, { bet: 1000, win: 200, begin_machine_coin: begin, end_machine_coin: end });
  }
  rows = audit();
  const xfer = get(rows, g2);
  check('有帳外分數異動 → transfers', xfer?.verdict === 'transfers', xfer?.verdict);
  check('抓到兩次異動', xfer?.transfers.length === 2, String(xfer?.transfers.length));
  check('上分金額正確（50,000）', xfer?.transfersIn === 50_000, String(xfer?.transfersIn));
  check('下分金額正確（30,000）', xfer?.transfersOut === 30_000, String(xfer?.transfersOut));
  check('指得出是哪一局', xfer?.transfers.some(t => t.spinIndex === 6) && xfer?.transfers.some(t => t.spinIndex === 9),
    JSON.stringify(xfer?.transfers.map(t => t.spinIndex)));

  console.log('\n3) 🚨 戳記的成對偏差不可以被報成金流異常');
  // 重現實測形狀：end 提前扣掉下一局的注，隔一局補回來，前後抵銷
  const g3 = `${TAG}STAMP-0003`;
  end = 500_000;
  for (let i = 1; i <= 10; i++) {
    const begin = end - 1000;
    const shift = i === 3 ? -1000 : i === 4 ? 1000 : 0;
    end = begin + 200;
    addRound(g3, i, T0 + i * 10_000, {
      bet: 1000, win: 200 + shift,
      begin_machine_coin: begin, end_machine_coin: end,
    });
  }
  rows = audit();
  const stamp = get(rows, g3);
  check('戳記偏差成對抵銷 → 仍判 clean（不是 transfers）', stamp?.verdict === 'clean', stamp?.verdict);
  check('戳記異常有被數出來（不是假裝沒看到）', stamp?.stampAnomalies === 2, String(stamp?.stampAnomalies));
  check('戳記淨額為 0', Math.abs(stamp?.stampNet ?? 99) < 0.01, String(stamp?.stampNet));
  check('說明講明它是戳記邊界問題、不是金流異常',
    String(stamp?.note).includes('成對抵銷'), String(stamp?.note).slice(0, 50));

  console.log('\n4) 🚨 沒有戳記的機台不可以混進「乾淨」');
  const g4 = `${TAG}NOSTAMP-0004`;
  for (let i = 1; i <= 10; i++) addRound(g4, i, T0 + i * 10_000, { bet: 1000, win: 200 });
  rows = audit();
  const nos = get(rows, g4);
  check('沒有分數戳記 → no_stamps', nos?.verdict === 'no_stamps', nos?.verdict);
  check('明講「這不等於沒有異常」', String(nos?.note).includes('不等於'), String(nos?.note).slice(0, 40));
  check('no_stamps 排在 clean 前面（缺口比健康重要）',
    rows.findIndex(r => r.verdict === 'no_stamps') < rows.findIndex(r => r.verdict === 'clean'));

  console.log('\n5) 🚨 spinIndex 缺號的地方不可以硬比');
  // 缺號代表我們沒抓到那幾局，硬比會把那幾局的輸贏算成上下分
  const g5 = `${TAG}GAP-0005`;
  end = 500_000;
  for (const i of [1, 2, 3, 40, 41, 42]) {
    // ⚠️ 斷點處**故意讓分數不連續**（沒抓到的那 36 局當然會讓分數變動）。
    //    測試資料若在斷點兩側仍然接得上，就驗不到「不准硬比」這件事——
    //    突變測試抓到過：把連續性條件拿掉，這條斷言照樣綠。
    if (i === 40) end += 777_777;
    const begin = end - 1000;
    end = begin + 200;
    addRound(g5, i, T0 + i * 1000, { bet: 1000, win: 200, begin_machine_coin: begin, end_machine_coin: end });
  }
  rows = audit();
  const gap = get(rows, g5);
  check('缺號處不列為上下分（硬比的話會憑空生出 777,777）',
    gap?.transfers.length === 0, JSON.stringify(gap?.transfers));
  check('只算連續的那幾對（6 局 2 段 → 4 對）', gap?.pairs === 4, String(gap?.pairs));

  console.log('\n6) 欄位缺一不可當成 0');
  const g6 = `${TAG}PARTIAL-0006`;
  end = 500_000;
  for (let i = 1; i <= 6; i++) {
    const begin = end - 1000;
    end = begin + 200;
    const f = { bet: 1000, win: 200, begin_machine_coin: begin, end_machine_coin: end };
    if (i === 3) delete f.end_machine_coin;  // 少一個欄位
    addRound(g6, i, T0 + i * 10_000, f);
  }
  rows = audit();
  const partial = get(rows, g6);
  // ⚠️ 少欄位那局被跳過，它前後就不再連續——絕不能把缺的當 0（或 NaN）繼續算。
  //    只斷言「沒有上下分」是不夠的：缺的欄位變成 NaN 時，`Math.abs(NaN) > EPS`
  //    是 false，照樣不會產生上下分，測試照樣綠（突變測試抓到的）。
  //    要釘的是**那一局有沒有被納入比較**——6 局扣掉壞的那局，只剩 (1,2)(4,5)(5,6) 三對。
  check('缺欄位的那局不納入比較（6 局少 1 → 3 對，不是 5 對）',
    partial?.pairs === 3, `pairs=${partial?.pairs}`);
  check('缺欄位的那局被跳過，不會憑空生出上下分', partial?.transfers.length === 0,
    JSON.stringify(partial?.transfers));
} finally {
  console.log(`\n(已清除 ${cleanup()} 筆測試資料)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * scripts/ui-checks/live-ledger-betpool.mjs
 *
 * 驗跨源對帳 `betPoolAudit()`：**後台 bet ↔ LuckyLink 獎池增量**。
 *
 * ⚠️ **為什麼需要這個檢查**：現有的 L5 驗的是「LuckyLink 自己前後一致」——
 * `coinIn` 取自 `poolChangeReport` 自己的欄位，所以 LuckyLink 就算整段少收了投注，
 * 它自己的算式仍然成立、仍然判 ok（69,891 筆裡 98% 是這樣通過的）。
 * 要證明錢真的進去了，只能拿後台的 bet 來對。
 *
 * 🚨 **這支最重要的不是「能不能算對」，是「算錯時會不會被抓到」。**
 * 真實資料現在是全 match（兩台、兩種面額、差額都是 0.000），
 * 而「永遠 match」跟「根本沒在比」在畫面上長得一模一樣——這正是整份體檢的核心教訓。
 * 所以下面每一種錯都用**注入**的方式製造一次，確認它真的會被判成不符。
 *
 * 跑在正式 data.db 上，注入資料帶 `__betpool_` 前綴，結尾刪除。
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { betPoolAudit, snapToPowerOfTen } = await import(
  pathToFileURL(path.join(root, 'dist-server/server/live-ledger-betpool.js')).href);
const db = new Database(path.join(root, 'server/data.db'));

const TAG = '__betpool_';
const ENV = 'qat';
const now = Date.now();
const T0 = now - 40 * 60_000;   // session 起點
const SPINS = 40;               // 要超過 MIN_SPINS(20)
const BET = 1000;               // 每局下注
const INC = 0.01;               // increment 1%
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

let seq = 0;
const addSpin = (gmid, at) => db.prepare(`
  INSERT INTO recon_spin (env, sessionId, machineType, gmid, spinSeq, betAmount, observedAt, status, note, userLabel)
  VALUES (?, ?, '__betpool_mt', ?, ?, ?, ?, 'MATCH', ?, '__betpool_user')
`).run(ENV, `${TAG}${gmid}`, gmid, ++seq, BET, at, `${TAG}note`);

const addRecord = (gmid, at, bet) => db.prepare(`
  INSERT INTO recon_backend_record (env, orderId, gmid, playerId, bet, win, balanceBefore, balanceAfter,
    dateTime, fetchedAt, raw, spinIndex, betTimePrecise, username, filterField, filterValue)
  VALUES (?, ?, ?, '1', ?, 0, 0, 0, ?, ?, ?, ?, ?, '__betpool_user', 'playerName', '__betpool_user')
`).run(ENV, `${TAG}${gmid}-${at}-${Math.random()}`, gmid, bet, at, now,
  JSON.stringify({ bet, win: 0, bet_nima: 0 }), seq, at);

const addPool = (gmid, at, levelid, oldc, newc, change) => db.prepare(`
  INSERT INTO recon_pool_change (env, reqmd5, levelid, machineid, groupid, machineName, groupName,
    levelName, protocallevelid, oldcoinin, newcoinin, before_, change_, after_, beforeover, afterover,
    poolamount, reason, ts, fetchedAt, verify, verifyDelta, raw)
  VALUES (?, ?, ?, 0, 0, ?, '', ?, 4, ?, ?, 0, ?, 0, 0, 0, 0, '1', ?, ?, 'ok', 0, '{}')
`).run(ENV, `${TAG}${gmid}${levelid}${at}${Math.random()}`, levelid, gmid, `${TAG}lv${levelid}`,
  oldc, newc, change, at, now);

const addMap = (gmid, levelid) => db.prepare(`
  INSERT INTO recon_machine_map (env, machineName, levelid, groupid, groupName, levelName,
    protocallevelid, incrementPercent, basevalue, maxValue, channelId, assetnumber,
    resolvedBy, verifiedAt, updatedAt)
  VALUES (?, ?, ?, '0', ?, ?, 4, ?, 0, 0, '873', '', 'observed', ?, ?)
  ON CONFLICT(env, machineName, levelid) DO UPDATE SET incrementPercent=excluded.incrementPercent
`).run(ENV, gmid, levelid, `${TAG}grp`, `${TAG}lv${levelid}`, INC, now, now);

/**
 * 造一台機台：spins 局、每局 BET、面額係數 factor、池增額比例 changeScale。
 * changeScale=1 代表完全正確；0.5 代表獎池只收到一半（要被抓出來）。
 */
const makeMachine = (gmid, { factor = 1, changeScale = 1, spins = SPINS, coinInScale = 1 } = {}) => {
  addMap(gmid, '9001');
  let coin = 1_000_000;
  for (let i = 0; i < spins; i++) {
    const at = T0 + i * 10_000;
    addSpin(gmid, at);
    addRecord(gmid, at, BET);
    const step = (BET / factor) * coinInScale;
    addPool(gmid, at, '9001', coin, coin + step, step * INC * changeScale);
    coin += step;
  }
};

const cleanup = () => {
  let n = 0;
  n += db.prepare(`DELETE FROM recon_spin WHERE sessionId LIKE '${TAG}%'`).run().changes;
  n += db.prepare(`DELETE FROM recon_backend_record WHERE orderId LIKE '${TAG}%'`).run().changes;
  n += db.prepare(`DELETE FROM recon_pool_change WHERE reqmd5 LIKE '${TAG}%'`).run().changes;
  n += db.prepare(`DELETE FROM recon_machine_map WHERE groupName LIKE '${TAG}%'`).run().changes;
  return n;
};
cleanup();

try {
  console.log('0) 面額係數只接受 10 的次方');
  check('比值 1 → 係數 1', snapToPowerOfTen(1) === 1);
  check('比值 100 → 係數 100', snapToPowerOfTen(100) === 100);
  check('比值 99.5（誤差 0.5%）仍貼到 100', snapToPowerOfTen(99.5) === 100);
  // ⚠️ 這條是整個設計的防線：比值不乾淨時**不准**當係數吃掉
  check('比值 2 → 拒絕（不是面額，是資料對不上）', snapToPowerOfTen(2) === null);
  check('比值 1.5 → 拒絕', snapToPowerOfTen(1.5) === null);
  check('比值 0 或負數 → 拒絕', snapToPowerOfTen(0) === null && snapToPowerOfTen(-1) === null);

  makeMachine(`${TAG}OK1-0001`, { factor: 1 });
  makeMachine(`${TAG}OK100-0002`, { factor: 100 });
  makeMachine(`${TAG}SHORT-0003`, { factor: 1, changeScale: 0.5 });
  makeMachine(`${TAG}DIRTY-0004`, { factor: 1, coinInScale: 0.5 });
  makeMachine(`${TAG}FEW-0005`, { factor: 1, spins: 5 });

  const rows = betPoolAudit(ENV, T0 - 3600_000, now + 3600_000);
  const get = n => rows.find(r => r.machineName === n);

  console.log('\n1) 正確的資料要判 match（兩種面額都要）');
  const ok1 = get(`${TAG}OK1-0001`);
  check('面額 1：判 match', ok1?.verdict === 'match', `${ok1?.verdict} 差=${ok1?.delta}`);
  check('面額 1：係數推成 1', ok1?.factor === 1, String(ok1?.factor));
  const ok100 = get(`${TAG}OK100-0002`);
  check('面額 100：判 match', ok100?.verdict === 'match', `${ok100?.verdict} 差=${ok100?.delta}`);
  check('面額 100：係數推成 100', ok100?.factor === 100, String(ok100?.factor));

  console.log('\n2) 🚨 注入差異——抓不到的話這條線等於沒有');
  const short = get(`${TAG}SHORT-0003`);
  // 獎池只收到該收的一半：投入額對得上，但池增額少一半
  check('獎池只收一半 → 判 mismatch（不是 match）', short?.verdict === 'mismatch', short?.verdict);
  check('差額算得出來且為負（實際少於預期）',
    typeof short?.delta === 'number' && short.delta < 0, String(short?.delta));
  check('差額約等於預期的一半',
    short ? Math.abs(short.delta + short.expectedChange / 2) < 0.01 : false,
    `delta=${short?.delta} expected=${short?.expectedChange}`);

  const dirty = get(`${TAG}DIRTY-0004`);
  // 投入額只收到一半 → 比值變成 2，不是 10 的次方 → 必須拒絕比對而不是校準掉
  check('投入額只收一半 → 判 ratio_not_clean（不是默默校準成係數 2）',
    dirty?.verdict === 'ratio_not_clean', dirty?.verdict);
  check('ratio_not_clean 時不給係數', dirty?.factor === null, String(dirty?.factor));
  check('ratio_not_clean 時把實際比值講出來給人判斷',
    typeof dirty?.observedRatio === 'number' && Math.abs(dirty.observedRatio - 2) < 0.01,
    String(dirty?.observedRatio));

  console.log('\n3) 樣本不足與排序');
  const few = get(`${TAG}FEW-0005`);
  check('只有 5 局 → too_few，不做判定', few?.verdict === 'too_few', few?.verdict);
  // ⚠️ 樣本不足時**不能**判 match——那是「沒證據」不是「沒問題」
  check('樣本不足不會被判成 match', few?.verdict !== 'match');
  const mine = rows.filter(r => r.machineName.startsWith(TAG));
  const idxMismatch = mine.findIndex(r => r.verdict === 'mismatch');
  const idxMatch = mine.findIndex(r => r.verdict === 'match');
  check('mismatch 排在 match 前面', idxMismatch >= 0 && idxMatch >= 0 && idxMismatch < idxMatch,
    `mismatch@${idxMismatch} match@${idxMatch}`);

  console.log('\n4) 泥碼：bet 已含泥碼，不可以再加 bet_nima');
  // raw 裡 bet=1000、bet_nima=400（是 bet 的一部分）。若程式加上去會變 1400，比值就不再是 1
  const gm = `${TAG}NIMA-0006`;
  addMap(gm, '9001');
  let coin = 500_000;
  for (let i = 0; i < SPINS; i++) {
    const at = T0 + i * 10_000;
    addSpin(gm, at);
    db.prepare(`
      INSERT INTO recon_backend_record (env, orderId, gmid, playerId, bet, win, balanceBefore, balanceAfter,
        dateTime, fetchedAt, raw, spinIndex, betTimePrecise, username, filterField, filterValue)
      VALUES (?, ?, ?, '1', ?, 0, 0, 0, ?, ?, ?, ?, ?, '__betpool_user', 'playerName', '__betpool_user')
    `).run(ENV, `${TAG}${gm}-${at}-${Math.random()}`, gm, BET, at, now,
      JSON.stringify({ bet: BET, win: 0, bet_nima: 400 }), i, at);
    addPool(gm, at, '9001', coin, coin + BET, BET * INC);
    coin += BET;
  }
  const nima = betPoolAudit(ENV, T0 - 3600_000, now + 3600_000).find(r => r.machineName === gm);
  check('bet 含泥碼時仍判 match（加了 bet_nima 會變 ratio_not_clean）',
    nima?.verdict === 'match', `${nima?.verdict} 比值=${nima?.observedRatio}`);
  check('比值仍是 1（不是 1.4）', nima?.observedRatio !== undefined && Math.abs(nima.observedRatio - 1) < 0.001,
    String(nima?.observedRatio));
} finally {
  console.log(`\n(已清除 ${cleanup()} 筆測試資料)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

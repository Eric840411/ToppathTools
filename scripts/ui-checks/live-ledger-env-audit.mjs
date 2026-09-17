/**
 * scripts/ui-checks/live-ledger-env-audit.mjs
 *
 * 驗跨環境機台稽核 `machineEnvAudit()`——「機台掛錯獎池」這類問題。
 *
 * ⚠️ **為什麼需要這個檢查**：機台↔獎池的對應是**從 `poolChangeReport` 反推**的
 * （`egmList` 兩個環境都回 0 筆）。所以一台 QAT 機台若實際掛在 UAT 的池上，
 * 它的池變動只出現在 UAT 的報表裡，QAT 這邊**根本不會生出它那一列**——
 * 結果是**整台機器從矩陣上消失**，不是被標成異常。看不見的東西不會有人去查。
 *
 * 2026-09-17 以前 UAT 一筆資料都沒有（`runJpCycle` 寫死只跑 qat），
 * 所以這類問題在結構上不可能被發現。這支要守的就是「兩邊都有資料之後，
 * 對不上的組合真的會被指出來」。
 *
 * 跑在正式 data.db 上，注入的資料都帶 `__envaudit_` 前綴，結尾刪除。
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { machineEnvAudit } = await import(
  pathToFileURL(path.join(root, 'dist-server/server/live-ledger-jp.js')).href);
const db = new Database(path.join(root, 'server/data.db'));

const TAG = '__envaudit_';
const now = Date.now();
const since = now - 3600_000;
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

const addPool = (env, machineName, ts) => db.prepare(`
  INSERT INTO recon_pool_change (env, reqmd5, levelid, machineid, groupid, machineName, groupName,
    levelName, protocallevelid, oldcoinin, newcoinin, before_, change_, after_, beforeover, afterover,
    poolamount, reason, ts, fetchedAt, verify, verifyDelta, raw)
  VALUES (?, ?, '1', 0, 0, ?, '', '', 4, 0, 0, 0, 0, 0, 0, 0, 0, '1', ?, ?, 'ok', 0, '{}')
`).run(env, `${TAG}${env}${machineName}${ts}`, machineName, ts, now);

let spinSeq = 0;
const addSpin = (env, gmid, observedAt) => db.prepare(`
  INSERT INTO recon_spin (env, sessionId, machineType, gmid, spinSeq, betAmount, observedAt, status, note, userLabel)
  VALUES (?, ?, '__envaudit_mt', ?, ?, 0, ?, 'PENDING', ?, '__envaudit_user')
`).run(env, `${TAG}sess`, gmid, ++spinSeq, observedAt, `${TAG}note`);

const cleanup = () => {
  const a = db.prepare(`DELETE FROM recon_pool_change WHERE reqmd5 LIKE '${TAG}%'`).run().changes;
  const b = db.prepare(`DELETE FROM recon_spin WHERE sessionId LIKE '${TAG}%'`).run().changes;
  return a + b;
};
cleanup();

try {
  // 正常：qat 打局、qat 有池 → 不該出現在結果裡
  addSpin('qat', `${TAG}NORMAL-0001`, now - 600_000);
  addPool('qat', `${TAG}NORMAL-0001`, now - 600_000);
  // both_envs：同一台在兩個環境都有池變動
  addPool('qat', `${TAG}BOTH-0002`, now - 600_000);
  addPool('uat', `${TAG}BOTH-0002`, now - 500_000);
  // env_mismatch：在 qat 打局，池卻在 uat
  addSpin('qat', `${TAG}MISMATCH-0003`, now - 600_000);
  addPool('uat', `${TAG}MISMATCH-0003`, now - 600_000);
  // no_pool：有打局，兩邊都沒有池
  addSpin('qat', `${TAG}NOPOOL-0004`, now - 600_000);
  // blank_name：報表回了空的 machineName
  addPool('qat', '', now - 600_000);
  // 時間窗外：超過 since 的不該被算進來
  addSpin('qat', `${TAG}OLD-0005`, now - 7200_000);
  addPool('uat', `${TAG}OLD-0005`, now - 7200_000);
  /**
   * ⚠️ 時間窗的**真正**測試案例：現在掛在 qat，但**很久以前**在 uat 也有過池變動。
   *
   * 正確行為＝只看窗內，所以這台沒有問題。窗若失效就會變成 `both_envs` critical——
   * 而 `recon_pool_change` 存著 12 天的歷史，**任何搬過環境的機台都會變成假警報**。
   *
   * 上面 OLD-0005 那個案例**擋不住這個突變**（實測：拿掉池那側的時間窗，13 項照樣全綠）
   * ——因為它的 spin 也在窗外，少了 spin 就不會落進任何一個判斷分支。
   * 要驗時間窗，就得讓「窗內有資料、窗外也有資料」的那一台自己說話。
   */
  addSpin('qat', `${TAG}MOVED-0006`, now - 600_000);
  addPool('qat', `${TAG}MOVED-0006`, now - 600_000);
  addPool('uat', `${TAG}MOVED-0006`, now - 10 * 24 * 3600_000);

  const rows = machineEnvAudit(since);
  const find = n => rows.find(r => r.machineName === n);

  console.log('1) 四種問題各自被認出來');
  check('正常的機台不會出現在稽核結果裡', !find(`${TAG}NORMAL-0001`));
  const both = find(`${TAG}BOTH-0002`);
  check('兩個環境都有池 → both_envs / critical',
    both?.issue === 'both_envs' && both?.severity === 'critical', JSON.stringify(both?.issue));
  check('both_envs 的 poolEnvs 兩個都列出來',
    both?.poolEnvs.includes('qat') && both?.poolEnvs.includes('uat'), JSON.stringify(both?.poolEnvs));
  const mis = find(`${TAG}MISMATCH-0003`);
  check('打局與池在不同環境 → env_mismatch / critical',
    mis?.issue === 'env_mismatch' && mis?.severity === 'critical', JSON.stringify(mis?.issue));
  check('env_mismatch 的說明講得出是哪邊對哪邊',
    String(mis?.note).includes('QAT') && String(mis?.note).includes('UAT'), String(mis?.note).slice(0, 60));
  const np = find(`${TAG}NOPOOL-0004`);
  check('有打局但查不到池 → no_pool', np?.issue === 'no_pool', JSON.stringify(np?.issue));
  // ⚠️ SAS 機台本來就沒有 LuckyLink 連線，報成 critical 會把真正的錯誤埋掉
  check('no_pool 是 warn 不是 critical（SAS 機台本來就沒有）', np?.severity === 'warn', np?.severity);
  check('no_pool 的說明有提到 SAS 這個可能', String(np?.note).includes('SAS'));
  const blank = rows.find(r => r.issue === 'blank_name');
  check('空白 machineName 被指出來（會讓每個分母多算一台）', Boolean(blank) && blank.severity === 'warn');

  console.log('2) 時間窗與排序');
  check('時間窗外的機台不被算進來', !find(`${TAG}OLD-0005`));
  // 這一條才真的守得住時間窗：搬過環境的機台不該被舊資料判成「同時掛兩邊」
  check('很久以前在另一個環境有過池 → 不算 both_envs（否則搬過環境的機台全變假警報）',
    !find(`${TAG}MOVED-0006`), JSON.stringify(find(`${TAG}MOVED-0006`)?.issue));
  const mine = rows.filter(r => r.machineName.startsWith(TAG));
  const firstWarnIdx = rows.findIndex(r => r.severity === 'warn');
  const lastCritIdx = rows.map(r => r.severity).lastIndexOf('critical');
  check('critical 全部排在 warn 前面',
    firstWarnIdx === -1 || lastCritIdx === -1 || lastCritIdx < firstWarnIdx,
    `lastCrit=${lastCritIdx} firstWarn=${firstWarnIdx}`);
  check('注入的問題都在結果裡（正常與搬過環境那兩台除外）', mine.length === 3, `${mine.length} 筆`);

  /**
   * 3) 「真的同時掛兩邊」vs「搬過環境」
   *
   * ⚠️ 搬機台是**正常操作**。兩者都只看 `poolEnvs=['qat','uat']` 的話長得一模一樣，
   *    全報成 critical 就會製造穩定的假警報——而假警報一多，真的同時掛兩邊那次
   *    也會被一起忽略掉。判準是兩邊最後一次變動的間隔（門檻 6 小時）。
   */
  console.log('3) 同時掛兩邊 vs 搬過環境');
  check('兩邊都在動（間隔很短）→ critical', both?.severity === 'critical', both?.severity);
  check('critical 的說明講「同時都在動」', String(both?.note).includes('同時都在動'), String(both?.note).slice(0, 40));
  check('兩邊各自的最後時間都有給（不然讀者分不出是哪一種）',
    Boolean(both?.lastPoolByEnv?.qat) && Boolean(both?.lastPoolByEnv?.uat), JSON.stringify(both?.lastPoolByEnv));

  const movedRows = machineEnvAudit(now - 30 * 24 * 3600_000, now);
  const moved = movedRows.find(r => r.machineName === `${TAG}MOVED-0006`);
  check('窗拉大到看得到舊資料時，搬過環境的那台會被降成 warn 不是 critical',
    moved?.issue === 'both_envs' && moved?.severity === 'warn',
    `${moved?.issue}/${moved?.severity}`);
  check('搬過環境的說明講得出相隔多久、且指向「舊環境要解除掛載」',
    String(moved?.note).includes('搬過環境') && String(moved?.note).includes('解除掛載'),
    String(moved?.note).slice(0, 50));

  console.log('4) 稽核不吃 env 參數——它要看的就是跨環境');
  // ⚠️ `Function.length` 只數「第一個有預設值之前」的參數，所以 (sinceMs, now = Date.now())
  //    的 arity 是 1 不是 2。這條斷言第一次就是寫成 2 而轉紅——留著當提醒。
  check('machineEnvAudit 的參數只有時間，沒有 env',
    machineEnvAudit.length === 1, `arity=${machineEnvAudit.length}（只有 sinceMs 必填）`);
} finally {
  console.log(`\n(已清除 ${cleanup()} 筆測試資料)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

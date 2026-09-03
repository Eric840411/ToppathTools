/**
 * 待補回填紀錄的保留期：只能清 `done`，`pending` / `failed` 一筆都不准動。
 *
 * ⚠️ 這條的風險是**單向且無聲**的：pending/failed 的意思是「這筆還沒補進 Sheet」，
 *    被誤刪就真的救不回來，而且沒有任何人會發現——正好是這整輪在修的那類問題。
 *    所以條件放寬一定要當場變紅。
 *
 * 用合成資料驗（自己插、自己刪），**不碰任何既有的列**；
 * 跑完會確認表裡的真實資料筆數跟開跑前一模一樣。
 *
 * 跑法：node scripts/ui-checks/pending-writeback-retention.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(pathToFileURL(path.join(root, 'dist-server/server/shared.js')).href);
const { cleanupDoneWritebacks, PENDING_WRITEBACK_DONE_RETENTION_DAYS: KEEP } = mod;

const db = new Database(path.join(root, 'server/data.db'));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const MARK = '__retention_test__';
const before = db.prepare('SELECT COUNT(*) n FROM jira_pending_writebacks').get().n;

const DAY = 86400_000;
const now = Date.now();
const old = now - (KEEP + 5) * DAY;   // 明顯過期
const fresh = now - (KEEP - 5) * DAY; // 還在保留期內

function seed(rows) {
  db.prepare(`DELETE FROM jira_pending_writebacks WHERE sheet_url LIKE ?`).run(MARK + '%');
  const ins = db.prepare(`INSERT INTO jira_pending_writebacks
    (created_at, sheet_url, row_index, jira_key, jira_url, summary, status, attempt_count, updated_at)
    VALUES (?,?,?,?,?,?,?,0,?)`);
  rows.forEach((r, i) => ins.run(r.updated, `${MARK}/${r.status}/${i}`, i, `TEST-${i}`, 'http://x', '', r.status, r.updated));
}
const survivors = () => db.prepare(
  `SELECT status, updated_at FROM jira_pending_writebacks WHERE sheet_url LIKE ? ORDER BY row_index`,
).all(MARK + '%');

try {
  console.log(`\n保留期：done ${KEEP} 天\n`);
  console.log('1) 只刪過期的 done');
  seed([
    { status: 'done', updated: old }, { status: 'done', updated: fresh },
    { status: 'pending', updated: old }, { status: 'failed', updated: old },
  ]);
  const deleted = cleanupDoneWritebacks(now);
  const left = survivors();
  check('刪掉的筆數是 1（只有過期的 done）', deleted === 1, `刪了 ${deleted}`);
  check('保留期內的 done 還在', left.some(r => r.status === 'done' && r.updated_at === fresh));
  check('過期的 done 已刪除', !left.some(r => r.status === 'done' && r.updated_at === old));
  // ⚠️ 這兩條是整支的重點
  check('過期的 pending 沒被刪', left.some(r => r.status === 'pending'));
  check('過期的 failed 沒被刪', left.some(r => r.status === 'failed'));

  console.log('\n2) 邊界');
  seed([{ status: 'done', updated: now - KEEP * DAY }]);      // 剛好在界線上
  check('剛好等於保留期的不刪（用 < 不是 <=）', cleanupDoneWritebacks(now) === 0);
  seed([{ status: 'done', updated: now - KEEP * DAY - 1 }]);  // 界線再往前 1ms
  check('超過界線 1ms 就刪', cleanupDoneWritebacks(now) === 1);

  console.log('\n3) 沒有東西可刪時不要亂動');
  seed([{ status: 'pending', updated: old }, { status: 'failed', updated: old }]);
  check('全是 pending/failed 時刪 0 筆', cleanupDoneWritebacks(now) === 0);
  check('兩筆都還在', survivors().length === 2);

  console.log('\n4) 極端：非常舊的 pending 也不能碰');
  // 這才是真正危險的情境——放著沒處理一年的未補紀錄，正是最不該消失的那種
  seed([{ status: 'pending', updated: now - 400 * DAY }]);
  cleanupDoneWritebacks(now);
  check('放了 400 天的 pending 仍然在', survivors().length === 1);
} finally {
  db.prepare(`DELETE FROM jira_pending_writebacks WHERE sheet_url LIKE ?`).run(MARK + '%');
}

const after = db.prepare('SELECT COUNT(*) n FROM jira_pending_writebacks').get().n;
check('跑完之後真實資料筆數不變', after === before, `${before} → ${after}`);

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);

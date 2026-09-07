/**
 * scripts/ui-checks/live-ledger-no-bet.mjs
 *
 * 守「沒起注的 spin 不該被當成掉單」這條規則。
 *
 * 🚨 背景：每按一次 Spin 就送一筆對帳，但特殊遊戲（FG/JP）期間按 Spin 不會起新的一局，
 *    後台自然沒有紀錄 → 全部被標成「後台查無此局」。實測 51 段連續 ≥5 次、最長 56 次，
 *    而且其中一筆 `not_started` 還被綁到某張後台單——一局根本沒起卻搶走別局的紀錄，
 *    真正的主人反而配不到。
 *
 * ⚠️ 這條規則的風險是**單向的**：排太寬會把真實的局排除在對帳外，帳會靜默歸零。
 *    所以測試重點在「哪些**不准**被排除」，尤其是 `unknown`。
 *
 * ⚠️ 跑完會完整還原 recon_spin / recon_finding。
 */
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Database = require('better-sqlite3');
const db = new Database(path.join(root, 'server/data.db'));
const ll = await import(pathToFileURL(path.join(root, 'dist-server/server/live-ledger.js')).href);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

const MARK = '__nobet_test__';
const cleanup = () => {
  const ids = db.prepare('SELECT id FROM recon_spin WHERE sessionId = ?').all(MARK).map(r => r.id);
  for (const id of ids) db.prepare("DELETE FROM recon_finding WHERE refType='spin' AND refId=?").run(String(id));
  db.prepare('DELETE FROM recon_spin WHERE sessionId = ?').run(MARK);
};
cleanup();

const src = readFileSync(path.join(root, 'server/live-ledger.ts'), 'utf8');

try {
  console.log('1) 排除清單的成員 —— 多一個少一個後果都很嚴重');
  {
    const m = src.match(/const NON_ROUND_OUTCOMES = new Set\(\[([^\]]*)\]\)/);
    const members = m ? m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
    check("包含 not_started（伺服器明確拒絕，確定沒起）", members.includes('not_started'));
    check("包含 no_bet（沒收到 moneyNtc begin）", members.includes('no_bet'));
    // 🚨 unknown 是「沒收到訊號」不是「沒發生」。實測有 172 筆 unknown 已經配對成功，
    //    把它排除等於一次丟掉那些真實資料，並把不確定當成沒發生。
    check("🚨 **不包含** unknown（那是不確定，不是沒發生；已有 172 筆配對成功）",
      !members.includes('unknown'), members.join(','));
    check("🚨 **不包含** suspected（有狀態轉換證據，只是缺結算）",
      !members.includes('suspected'));
    check('   排除清單剛好兩個成員', members.length === 2, members.join(','));
  }

  console.log('\n2) shadow check —— 唯一能分辨 FG 與「begin 訊號壞掉」的訊號');
  {
    // agent 端分不出這兩件事（症狀都是沒 begin、有 end、餘額有變）。
    // 能分開的只有後台：FG 沒有新的一般局；begin 壞掉時後台仍然有。
    const shadowIdx = src.indexOf("'begin_signal_suspect'");
    const bindIdx = src.indexOf('const setResolved = db.prepare');
    check('🚨 shadow check 在正式綁定「之後」才跑（先跑會跟正主搶單）',
      shadowIdx > bindIdx && bindIdx > 0, `shadow@${shadowIdx} bind@${bindIdx}`);
    check('🚨 只看「還沒被認領」的後台單（否則 FG 前後相鄰的正常局會被誤報）',
      /const unclaimed = records\.filter\(r => !bound\.has\(r\.orderId\)\)/.test(src));
    check('⚠️ shadow 不改任何 spin 狀態，只產生 finding（真要恢復是人去修偵測）',
      !/shadowTx[\s\S]{0,600}setResolved\.run/.test(src));
    check('分組規則跟正式配對一致（session × machineType），沒有另寫一套',
      /shadowGroups[\s\S]{0,200}\$\{s\.sessionId\}\|\$\{s\.machineType\}/.test(src));
  }

  console.log('\n3) 一次性收拾既有誤報 —— 不刪資料、但要把搶走的單還回去');
  {
    const now = Date.now();
    const mk = (outcome, orderId, status) => db.prepare(`
      INSERT INTO recon_spin (env, sessionId, machineType, gmid, spinSeq, observedAt, status, outcome, orderId, userLabel)
      VALUES ('qat', ?, 'T', 'T-GMID', ?, ?, ?, ?, ?, 'tester')
    `).run(MARK, Math.floor(Math.random() * 1e6), now, status, outcome, orderId).lastInsertRowid;

    const wrongBound = mk('not_started', '__fake_order__', 'MATCH');
    const falseMissing = mk('no_bet', null, 'MISSING');
    const legitMissing = mk('completed', null, 'MISSING');
    ll.recordFinding('qat', 'missing', falseMissing, { severity: 'critical', note: '測試' });
    ll.recordFinding('qat', 'missing', legitMissing, { severity: 'critical', note: '測試' });

    const r = ll.cleanupNonRoundFindings('qat');
    const after = id => db.prepare('SELECT status, orderId FROM recon_spin WHERE id=?').get(id);
    const findingOpen = id => db.prepare(
      "SELECT COUNT(*) n FROM recon_finding WHERE line='missing' AND refType='spin' AND refId=? AND resolvedAt IS NULL"
    ).get(String(id)).n;

    check('🚨 一局沒起卻綁到後台單 → 解除綁定，把單還給正主',
      after(wrongBound).orderId === null && after(wrongBound).status === 'PENDING',
      JSON.stringify(after(wrongBound)));
    check('沒起注的誤報 → 標成已解決', findingOpen(falseMissing) === 0);
    check('🚨 真正的掉單（completed）→ **不准**被一起清掉',
      findingOpen(legitMissing) === 1, `剩 ${findingOpen(legitMissing)} 筆未解決`);
    check('   而且它的列沒有被動到', after(legitMissing).status === 'MISSING');
    check('⚠️ 不刪任何 spin 列（那是當時真實的觀測，刪掉等於竄改歷史）',
      after(wrongBound) && after(falseMissing) && after(legitMissing));

    const again = ll.cleanupNonRoundFindings('qat');
    check('重跑安全：第二次不會再重複處理', again.resolved === 0 && again.unbound === 0,
      JSON.stringify(again));
    // ⚠️ 不要斷言精確數字：這支清理是**全 env** 的，會一併修掉正式資料裡的同類問題
    //    （第一次跑就順手解開了 873-BULLBLITZ-0136 #28 那筆真的錯誤綁定）。
    //    寫死數字會讓這條測試在正式資料乾淨與否之間隨機紅綠。
    check('   第一次確實有做事（≥ 本測試造的那兩筆）', r.unbound >= 1 && r.resolved >= 1,
      JSON.stringify(r));
  }

  console.log('\n4) 回填不能把清掉的誤報再造出來');
  {
    check('🚨 backfillFindings 也排除了 not_started / no_bet',
      /backfillFindings[\s\S]{0,400}NOT IN \('not_started','no_bet'\)/.test(src));
  }

  console.log('\n5) 收拾要在綁定之前跑');
  {
    const fetchSrc = readFileSync(path.join(root, 'server/live-ledger-fetch.ts'), 'utf8');
    const cIdx = fetchSrc.indexOf('cleanupNonRoundFindings(env)');
    const bIdx = fetchSrc.indexOf('runBindCycle(env, now)');
    check('🚨 錯誤綁定先解開，正主才能在同一輪配到那張單',
      cIdx > 0 && cIdx < bIdx, `cleanup@${cIdx} bind@${bIdx}`);
  }
} finally {
  cleanup();
  const left = db.prepare('SELECT COUNT(*) n FROM recon_spin WHERE sessionId=?').get(MARK).n;
  console.log(`\n測試資料已清除（殘留 ${left} 筆）`);
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);

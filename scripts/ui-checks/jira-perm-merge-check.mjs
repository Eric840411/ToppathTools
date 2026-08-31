/**
 * 驗證 jira-qa / jira-pm / jira-update → jira 的權限合併 migration。
 *
 * 要驗四件事：
 *   1. 合併結果是 **OR**（不是挑其中一個）——挑錯會當場撤掉某個角色的存取權
 *   2. 每個角色改動前後的**實際可存取結果完全一樣**
 *   3. **idempotent**：重跑不會重複插入
 *   4. **不覆蓋手動調整過的 'jira' 列**（管理員後來改過的不該被 migration 推翻）
 *
 * ⚠️ 這支會直接動 role_permissions，跑完會**完整還原**成執行前的狀態。
 *
 * 跑法：node scripts/ui-checks/jira-perm-merge-check.mjs
 */
import Database from 'better-sqlite3';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = path.join(root, 'server/data.db');
const db = new Database(dbPath);

const snapshot = db.prepare('SELECT role, page_key, allowed FROM role_permissions').all();
const restore = () => {
  db.prepare('DELETE FROM role_permissions').run();
  const ins = db.prepare('INSERT INTO role_permissions (role, page_key, allowed) VALUES (?, ?, ?)');
  db.transaction(() => { for (const r of snapshot) ins.run(r.role, r.page_key, r.allowed) })();
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };
const jiraRows = () => db.prepare("SELECT role, allowed FROM role_permissions WHERE page_key = 'jira' ORDER BY role").all();
const legacy = () => db.prepare("SELECT role, page_key, allowed FROM role_permissions WHERE page_key IN ('jira-qa','jira-pm','jira-update')").all();

/** migration 寫在 shared.ts 的模組層級，import 就會跑。用 query string 破 ESM 快取以便重跑 */
let n = 0;
const runMigration = async () => {
  await import(pathToFileURL(path.join(root, 'dist-server/server/shared.js')).href + `?run=${++n}`);
};

try {
  // ── 先算出「改動前的實際可存取結果」當基準 ──
  const before = new Map();
  for (const r of legacy()) before.set(r.role, (before.get(r.role) ?? 0) || (r.allowed ? 1 : 0));
  console.log('改動前各角色的實際存取（三個舊 key 的 OR）：',
    [...before].map(([k, v]) => `${k}=${v}`).join(' '));

  db.prepare("DELETE FROM role_permissions WHERE page_key = 'jira'").run();

  console.log('\n1) 第一次跑 migration');
  await runMigration();
  const after1 = jiraRows();
  console.log('   jira 列：', JSON.stringify(after1));
  check('每個有舊資料的角色都產生了 jira 列', after1.length === before.size, `${after1.length} vs ${before.size}`);
  let orOk = true;
  for (const row of after1) if ((before.get(row.role) ?? 0) !== row.allowed) orOk = false;
  check('合併結果等於三個舊 key 的 OR（存取結果沒變）', orOk);

  // 這條是重點：pm 在 jira-update 是 0，若誤挑它當 canonical 會變 0
  const pm = after1.find(r => r.role === 'pm');
  const pmUpdate = legacy().find(r => r.role === 'pm' && r.page_key === 'jira-update');
  if (pm && pmUpdate) {
    check('PM 沒有被誤撤權限（jira-update 對 pm 是 ' + pmUpdate.allowed + '）', pm.allowed === 1, `jira=${pm.allowed}`);
  }

  console.log('\n2) 重跑兩次（idempotent）');
  await runMigration();
  await runMigration();
  const after3 = jiraRows();
  check('沒有重複插入', after3.length === after1.length, `${after1.length} → ${after3.length}`);
  check('值沒有被改掉', JSON.stringify(after3) === JSON.stringify(after1));

  console.log('\n3) 手動調整過的 jira 列不該被覆蓋');
  const target = after1[0]?.role;
  if (target) {
    const flipped = after1[0].allowed ? 0 : 1;
    db.prepare("UPDATE role_permissions SET allowed = ? WHERE page_key = 'jira' AND role = ?").run(flipped, target);
    await runMigration();
    const now = jiraRows().find(r => r.role === target);
    check(`管理員把 ${target} 改成 ${flipped} 之後，migration 沒有推翻它`, now.allowed === flipped, `實際 ${now.allowed}`);
  }

  console.log('\n4) 舊 key 的資料仍保留（不硬刪）');
  check('jira-qa / jira-pm / jira-update 的列還在', legacy().length > 0, `${legacy().length} 列`);
} finally {
  restore();
  const back = db.prepare('SELECT COUNT(*) c FROM role_permissions').get();
  console.log(`\n已還原 role_permissions（${back.c} 列，執行前是 ${snapshot.length} 列）`);
}

console.log(`${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);

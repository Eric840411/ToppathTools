/**
 * 範本腳本種子檔的檢查。
 *
 *   node scripts/ui-checks/uat-recorded-seed.test.mjs
 *
 * 🚨 **這支守的是「在這台錄好、到別台就不存在」。**錄製腳本存在各環境自己的
 *    `server/data.db`，而那個檔案不進版控——所以沒有種子檔的話，
 *    腳本只活在錄的人那台機器上，而且**畫面上看不出少了什麼**。
 *
 * ⚠️ 只驗種子檔本身與 `INSERT OR IGNORE` 的行為，不碰正式 DB：
 *    在暫存目錄開一個空的 sqlite 跑同一段 SQL。
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`)
  ok ? pass++ : fail++
}

const seedPath = join(process.cwd(), 'server', 'uat-recorded-scripts-seed.json')
const seed = JSON.parse(readFileSync(seedPath, 'utf-8'))

console.log('種子檔')
check('有 scripts 陣列且不是空的', Array.isArray(seed.scripts) && seed.scripts.length > 0,
  `${seed.scripts?.length ?? 0} 份`)
check('每一份都有 id / title / document',
  seed.scripts.every(s => s.id && s.title && s.document))
check('id 不重複（重複會讓第二份永遠進不去）',
  new Set(seed.scripts.map(s => s.id)).size === seed.scripts.length)
check('每一份都有步驟（空腳本種過去等於沒有）',
  seed.scripts.every(s => Array.isArray(s.document.steps) && s.document.steps.length > 0))
// ⚠️ 綁定是回寫 Lark 的依據。少了它，腳本跑得動但結果寫不回去——
//    那種壞法在畫面上完全看不出來。
check('每一份都帶 TC 綁定',
  seed.scripts.every(s => Array.isArray(s.document.bindings) && s.document.bindings.length > 0))

console.log('\n補種行為（空 DB）')
const tmp = join(tmpdir(), `uat-seed-test-${Date.now()}.db`)
const db = new Database(tmp)
try {
  db.exec(`CREATE TABLE uat_recorded_scripts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, document TEXT NOT NULL,
    updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT,
    deleted_at INTEGER, deleted_by TEXT)`)
  const ins = db.prepare(`INSERT OR IGNORE INTO uat_recorded_scripts
    (id, owner, title, document, updated_at, revision, updated_by) VALUES (?, ?, ?, ?, ?, 1, 'seed')`)
  const run = () => seed.scripts.reduce((n, s) =>
    n + ins.run(s.id, s.owner || 'seed', s.title, JSON.stringify(s.document), Date.now()).changes, 0)

  check('第一次補種：全部進得去', run() === seed.scripts.length)
  check('第二次補種：一筆都不再寫（不會蓋掉當地的版本）', run() === 0)

  // 🚨 最重要的一條：已經存在的那份**內容不可以被種子覆蓋**
  db.prepare('UPDATE uat_recorded_scripts SET title=?, document=? WHERE id=?')
    .run('當地改過的標題', '{"steps":[]}', seed.scripts[0].id)
  run()
  const after = db.prepare('SELECT title FROM uat_recorded_scripts WHERE id=?').get(seed.scripts[0].id)
  check('當地改過的內容不會被種子蓋回去', after.title === '當地改過的標題', after.title)

  const stored = db.prepare('SELECT document FROM uat_recorded_scripts WHERE id=?').get(seed.scripts[1].id)
  check('存進去的 document 解得回來、步數一致',
    JSON.parse(stored.document).steps.length === seed.scripts[1].document.steps.length)
} finally {
  db.close()
  rmSync(tmp, { force: true })
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
assert.equal(fail, 0, '範本腳本種子檢查有失敗項')

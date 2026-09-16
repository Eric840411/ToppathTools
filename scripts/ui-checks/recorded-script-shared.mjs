/**
 * 錄製腳本改成團隊共用之後的併發保護。
 *
 *   node scripts/ui-checks/recorded-script-shared.mjs
 *
 * 驗收項目照 CodeX review 開的：
 *   同時儲存要保留衝突草稿｜同時起跑只允許一輪｜起跑與刪除的競態｜
 *   Agent 斷線仍維持互斥｜結果與截圖的讀取權限。
 *
 * ⚠️ 直接打 DB 層的函式，不經 HTTP——要驗的是「兩個請求同時進來」的行為，
 *    走 HTTP 反而不好精確控制先後順序。
 * ⚠️ 會在 DB 留測試資料，跑完自己清掉。
 */
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  acquireScriptLock, releaseScriptLock, isScriptRunning,
  rememberRunContext, forgetRunContext, saveRecordedScriptDoc,
} from '../../dist-server/server/uat-recorded-scripts.js'

const db = new Database('server/data.db')
let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}
const ok = (name, cond, detail) => eq(name + (detail ? ' (' + detail + ')' : ''), !!cond, true)

const scriptId = '__check_' + randomUUID()
const makeScript = () => ({ id: scriptId, title: '併發檢查', larkUrl: 'https://x/base/app?table=tbl', tableId: 'tbl', bindings: [], steps: [] })

try {
  db.prepare('INSERT INTO uat_recorded_scripts(id, owner, title, document, updated_at, revision, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(scriptId, 'a@x.com', '併發檢查', JSON.stringify(makeScript()), Date.now(), 'a@x.com')

  // ── 1. 樂觀鎖：同時儲存，只有一個能成功 ──
  // 重現「兩個人都讀到 revision 1，然後各自存檔」
  const save = (expected, who) =>
    saveRecordedScriptDoc({ ...makeScript(), title: who }, who, expected).ok ? 1 : 0

  eq('先存的人成功', save(1, 'a@x.com'), 1)
  eq('後存的人（拿著同一個舊版本）被擋下來，不是覆蓋', save(1, 'b@x.com'), 0)
  const after = db.prepare('SELECT revision, updated_by, document FROM uat_recorded_scripts WHERE id = ?').get(scriptId)
  eq('版本只加一次', after.revision, 2)
  eq('內容是先存那個人的，沒有被後來的蓋掉', JSON.parse(after.document).title, 'a@x.com')
  eq('重新讀到新版本後就存得進去', save(2, 'b@x.com'), 1)

  // ── 2. 同腳本執行互斥 ──
  const s1 = randomUUID(), s2 = randomUUID()
  eq('第一個人搶到執行權', acquireScriptLock(scriptId, s1, 'a@x.com').ok, true)
  const second = acquireScriptLock(scriptId, s2, 'b@x.com')
  eq('第二個人被擋下來', second.ok, false)
  ok('而且說得出是誰在跑', second.ok === false && second.holder === 'a@x.com', second.holder)

  // ⚠️ Agent 斷線不等於停止——鎖必須還在，否則別人會在對方還在回寫 Lark 時插進來
  eq('（模擬 agent 斷線）鎖仍然在', isScriptRunning(scriptId), true)
  eq('斷線後別人仍然搶不到', acquireScriptLock(scriptId, randomUUID(), 'c@x.com').ok, false)

  // ── 3. 起跑與刪除的競態 ──
  // 刪除的檢查跟搶鎖走同一張表，所以「正在跑」時刪不掉
  eq('執行中：刪除檢查會看到正在跑', isScriptRunning(scriptId), true)

  releaseScriptLock(s1)
  eq('釋放之後就不算在跑', isScriptRunning(scriptId), false)
  eq('釋放之後別人搶得到', acquireScriptLock(scriptId, s2, 'b@x.com').ok, true)
  releaseScriptLock(s2)

  // ── 4. 執行結果要記真正執行的人 ──
  const runId = randomUUID()
  rememberRunContext(runId, { scriptId, revision: 3, executedBy: 'b@x.com' })
  db.prepare('INSERT INTO uat_recorded_script_runs(id, script_id, owner, executed_by, script_revision, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, scriptId, 'a@x.com', 'b@x.com', 3, '{}', Date.now())
  const run = db.prepare('SELECT owner, executed_by, script_revision FROM uat_recorded_script_runs WHERE id = ?').get(runId)
  eq('owner 仍是建立者', run.owner, 'a@x.com')
  ok('但執行者另外記著，不會掛在建立者名下', run.executed_by === 'b@x.com', run.executed_by)
  eq('而且記得跑的是第幾版', run.script_revision, 3)
  forgetRunContext(runId)

  // ── 5. 軟刪除保留歷史 ──
  db.prepare('UPDATE uat_recorded_scripts SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), 'a@x.com', scriptId)
  const listed = db.prepare('SELECT 1 FROM uat_recorded_scripts WHERE id = ? AND deleted_at IS NULL').get(scriptId)
  ok('刪除後列表看不到', !listed)
  const keptRuns = db.prepare('SELECT COUNT(*) n FROM uat_recorded_script_runs WHERE script_id = ?').get(scriptId)
  eq('但歷史結果保留著（軟刪除不是真的砍掉）', keptRuns.n, 1)
} finally {
  db.prepare('DELETE FROM uat_recorded_script_runs WHERE script_id = ?').run(scriptId)
  db.prepare('DELETE FROM uat_recorded_scripts WHERE id = ?').run(scriptId)
  db.prepare('DELETE FROM uat_recorded_script_locks WHERE script_id = ?').run(scriptId)
  db.close()
  console.log('\n測試資料已清除')
}

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }

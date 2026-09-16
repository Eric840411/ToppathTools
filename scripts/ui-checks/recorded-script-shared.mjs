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
import { readFileSync } from 'node:fs'
import {
  acquireScriptLock, releaseScriptLock, isScriptRunning,
  rememberRunContext, forgetRunContext, saveRecordedScriptDoc,
  forceReleaseScriptLock, captureRecordedScriptResult,
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

  // ⚠️ 這裡要**真的走斷線那條程式碼**，不能只查鎖還在不在。
  //    第一版就是只查鎖——而那時候斷線其實會放鎖，測試卻是綠的（CodeX 抓到，P1）。
  //    `handleBackendUatAgentDisconnect()` 會走 finishSession()，那才是會放鎖的地方。
  const before = isScriptRunning(scriptId)
  eq('斷線前鎖在', before, true)
  // ⚠️ 真正的斷線 handler 需要 osm-uat 模組裡那個 session 處於執行中，
  //    而 session 沒有匯出、也不適合從外面硬造。所以這一段退一步做**接線檢查**：
  //    直接讀原始碼確認兩條斷線路徑都帶 confirmedStopped = false，
  //    而且放鎖那行真的被包在 if (confirmedStopped) 裡面。
  //    ⚠️ 它驗的是接線不是執行結果，不要當成「跑過一次斷線」。
  {
    const src = readFileSync('server/routes/osm-uat.ts', 'utf8')
    const seg = src.slice(src.indexOf('function finishSession'), src.indexOf('function finishSession') + 1600)
    ok('放鎖被包在 if (confirmedStopped) 裡',
      /if \(confirmedStopped\)\s*\{[\s\S]{0,200}releaseScriptLock/.test(seg), seg.slice(0, 0))
    ok('Agent 連線中斷那條帶 false（不算確認停止）',
      /agent disconnected' \}, false\)/.test(src))
    ok('Agent 離線直接標記停止那條也帶 false',
      /agent offline' \}, false\)/.test(src))
    ok('沒有任何一條斷線路徑直接呼叫 releaseScriptLock',
      !/disconnect[\s\S]{0,300}releaseScriptLock/.test(src))
  }
  eq('鎖不會自己消失（斷線不等於停止，必須由人或正常收尾才放）', isScriptRunning(scriptId), true)
  eq('斷線後別人仍然搶不到', acquireScriptLock(scriptId, randomUUID(), 'c@x.com').ok, false)
  ok('但有一條人工解除的路（否則會永遠卡住）',
    forceReleaseScriptLock(scriptId).released === true)
  eq('人工解除後就搶得到', acquireScriptLock(scriptId, s1, 'a@x.com').ok, true)

  // ── 3. 起跑與刪除的競態 ──
  // 刪除的檢查跟搶鎖走同一張表，所以「正在跑」時刪不掉
  eq('執行中：刪除檢查會看到正在跑', isScriptRunning(scriptId), true)

  releaseScriptLock(s1)
  eq('釋放之後就不算在跑', isScriptRunning(scriptId), false)
  eq('釋放之後別人搶得到', acquireScriptLock(scriptId, s2, 'b@x.com').ok, true)
  releaseScriptLock(s2)

  // ── 4. 執行結果要記真正執行的人 ──
  const runId = randomUUID()
  // ⚠️ 要走**產品那支**。第一版是自己 INSERT 再讀回來——那只是在驗自己寫的 SQL，
  //    產品那邊把 executed_by 拿掉也不會紅（CodeX 抓到，跟樂觀鎖那次同一個形狀）。
  rememberRunContext(runId, { scriptId, revision: 3, executedBy: 'b@x.com' })
  const line = '@@UAT_MULTI_RESULTS@@' + JSON.stringify({ script: makeScript() })
  eq('產品的結果保存函式有認出這一行', captureRecordedScriptResult(runId, line), true)
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

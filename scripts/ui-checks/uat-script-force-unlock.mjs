/**
 * 錄製腳本的執行鎖人工解除（v5.10.5）。正式站有一份腳本被部署重啟打斷、鎖殘留三天：
 * force-unlock 要帶 sessionId，但列表沒回、前端也沒入口，管理員解不開。
 *   1 列表：管理員拿得到 lock {holder, sessionId, since}；一般帳號只有 running，沒有 lock
 *   2 腳本庫：管理員看到「執行鎖：…」與「解除執行鎖」；按下先展開確認，不會直接解
 *   3 取消 → 鎖還在；確認 → 鎖解掉、列表不再顯示
 *   4 確認框開著時鎖換到另一輪、按重新整理 → 確認框撤銷、提示重新確認，新那輪的鎖不會被解掉（CodeX review 94cd396 [P2]）
 * 做法：在本機 DB 對一份既有腳本塞一個假鎖，結束一定刪掉。
 * 跑法：node scripts/ui-checks/uat-script-force-unlock.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'

const HOST = '192.168.3.41'
const db = new Database('server/data.db')
const admin = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
const other = db.prepare("SELECT s.sid FROM auth_sessions s JOIN jira_accounts a ON a.email = s.email WHERE a.role NOT LIKE '%admin%' AND s.expires_at>? ORDER BY s.created_at DESC").get(Date.now())
const row = db.prepare('SELECT id, document FROM uat_recorded_scripts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1').get()
if (!admin || !row) { console.log('缺少管理員 session 或腳本'); process.exit(1) }
const title = JSON.parse(row.document).title
if (db.prepare('SELECT 1 FROM uat_recorded_script_locks WHERE script_id = ?').get(row.id)) { console.log('這份腳本真的有鎖，不動它'); process.exit(1) }
const SID = 'test-stale-session-' + Date.now()
db.prepare('INSERT INTO uat_recorded_script_locks(script_id, session_id, holder, acquired_at) VALUES (?, ?, ?, ?)').run(row.id, SID, 'siara.lin@toppath.tw', Date.now() - 3 * 86400_000)

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const list = async sid => (await (await fetch(`http://${HOST}:3000/api/osm-uat/recorded-scripts`, { headers: { cookie: `toppath_auth=${sid}` } })).json()).scripts.find(s => s.id === row.id)
const browser = await chromium.launch()
try {
  const a = await list(admin.sid)
  check('管理員：列表回 lock（holder／sessionId／since）', a?.running === true && a?.lock?.sessionId === SID && a?.lock?.holder === 'siara.lin@toppath.tw' && typeof a?.lock?.since === 'number')
  if (other) { const o = await list(other.sid); check('一般帳號：只有 running，沒有 lock', o?.running === true && !('lock' in (o ?? {}))) }
  else console.log('  （沒有一般帳號的 session，略過這項）')

  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: admin.sid, domain: HOST, path: '/' }])
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  // 沒有 URL 路由：先點群組再點子項
  await page.locator('text=OSM Tools').first().click()
  await page.locator('text=UAT 整合測試').first().click()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /^Backend$|後台/ }).first().click().catch(() => {})
  const rowEl = page.locator('.uat-script-select-row').filter({ hasText: title }).first()
  await rowEl.waitFor({ timeout: 20000 })
  check('腳本庫顯示執行鎖與持有者', (await rowEl.innerText()).includes('執行鎖：siara.lin@toppath.tw'))
  await rowEl.getByRole('button', { name: '解除執行鎖' }).click()
  const dlg = rowEl.getByRole('alertdialog', { name: '確認解除執行鎖' })
  check('按下先展開確認，寫清楚要先確認對方沒在跑', await dlg.isVisible() && /已經沒有在跑/.test(await dlg.innerText()))
  check('還沒確認前鎖還在', !!db.prepare('SELECT 1 FROM uat_recorded_script_locks WHERE script_id = ?').get(row.id))
  await page.screenshot({ path: 'uat-force-unlock.png' })
  await dlg.getByRole('button', { name: '取消' }).click()
  check('取消 → 鎖還在', !!db.prepare('SELECT 1 FROM uat_recorded_script_locks WHERE script_id = ?').get(row.id))
  // 4 換輪：A 輪展開確認 → 鎖換成 B 輪 → 重新整理 → 確認框要撤銷
  await rowEl.getByRole('button', { name: '解除執行鎖' }).click()
  const SID2 = SID + '-b'
  db.prepare('UPDATE uat_recorded_script_locks SET session_id = ?, acquired_at = ? WHERE script_id = ?').run(SID2, Date.now(), row.id)
  await page.locator('#uat-focus-scripts').getByRole('button', { name: '重新整理' }).click()
  await page.waitForTimeout(1200)
  check('換輪後重新整理 → 確認框撤銷、提示重新確認', await rowEl.getByRole('alertdialog', { name: '確認解除執行鎖' }).count() === 0 && (await rowEl.innerText()).includes('執行鎖已經換到另一輪了'))
  check('換輪後新那輪的鎖還在', db.prepare('SELECT session_id FROM uat_recorded_script_locks WHERE script_id = ?').get(row.id)?.session_id === SID2)
  db.prepare('UPDATE uat_recorded_script_locks SET session_id = ? WHERE script_id = ?').run(SID, row.id)
  await page.locator('#uat-focus-scripts').getByRole('button', { name: '重新整理' }).click()
  await page.waitForTimeout(1200)

  await rowEl.getByRole('button', { name: '解除執行鎖' }).click()
  await rowEl.getByRole('button', { name: '確認沒在跑，解除' }).click()
  await page.waitForTimeout(1500)
  check('確認 → 鎖解掉', !db.prepare('SELECT 1 FROM uat_recorded_script_locks WHERE script_id = ?').get(row.id))
  check('解除後列表不再顯示執行鎖', !(await page.locator('.uat-script-select-row').filter({ hasText: title }).first().innerText()).includes('執行鎖：'))
  await ctx.close()
} finally {
  db.prepare('DELETE FROM uat_recorded_script_locks WHERE script_id = ? AND session_id IN (?, ?)').run(row.id, SID, SID + '-b')
  await browser.close()
}
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

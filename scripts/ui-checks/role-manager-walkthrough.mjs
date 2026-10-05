/**
 * 系統管理 → 角色管理（v5.9.0）走查。打真的伺服器、真的寫 DB（只動測試帳號 asd 與一個走查用角色，結束時還原）。
 *   1 版面：預設在角色管理分頁、管理員固定唯讀、內建角色名稱鎖住
 *   2 新增自建角色 → 勾功能 → 建立
 *   3 帳號管理把 asd 指派到新角色 → 新角色顯示 1 人
 *   4 刪除使用中的角色 → 被擋下並列出 asd、有「前往帳號管理」
 *   5 還原 asd → 刪除角色成功
 *   6 「＋新增」不斷行
 *   7 伺服器回的不是 JSON（代理錯誤頁）→ 畫面要顯示錯誤，不能什麼都沒發生（v5.10.2，使用者在 Lark 裡按建立角色沒反應）
 * 跑法：node scripts/ui-checks/role-manager-walkthrough.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'

const HOST = '192.168.3.41'
const db = new Database('server/data.db')
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
const origRole = db.prepare("SELECT role FROM jira_accounts WHERE email='asd'").get().role
const NAME = '走查角色'
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()
try {
  for (const mode of ['classic', 'xianxia']) {
    console.log(`[${mode}]`)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
    await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
    await ctx.addInitScript(m => { localStorage.setItem('toppath-theme-mode', m); localStorage.setItem('toppath-sidebar-collapsed', '0') }, mode)
    const page = await ctx.newPage()
    page.on('dialog', d => d.accept())
    await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
    await page.locator('.app-sidebar .sidebar-nav-item').filter({ hasText: /系統管理|太玄樞機/ }).first().click()
    const rm = page.locator('.role-manager')
    await rm.waitFor()
    check('預設在角色管理分頁', await rm.isVisible())
    const addBtn = rm.getByRole('button', { name: '＋ 新增' })
    const bh = await addBtn.evaluate(e => e.getBoundingClientRect().height)
    check('「＋ 新增」不斷行', bh < 40, `高 ${Math.round(bh)}px`)
    await rm.getByRole('button', { name: /管理員/ }).click()
    check('管理員：唯讀、功能全勾、沒有儲存鈕', await rm.getByText('管理員固定擁有所有功能').isVisible() && await rm.locator('input[type=checkbox]:not(:checked)').count() === 0 && await rm.getByRole('button', { name: '儲存' }).count() === 0)
    await rm.getByRole('button', { name: /^QA/ }).click()
    check('內建角色：名稱鎖住、沒有刪除鈕', await rm.locator('input[maxlength="20"]').isDisabled() && await rm.getByRole('button', { name: '刪除角色' }).count() === 0)

    // 7 回應不是 JSON：要看得到錯誤（只攔這一次）
    let fake = true
    await page.route('**/api/admin/roles', r => (fake && r.request().method() === 'POST') ? (fake = false, r.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' })) : r.continue())
    await addBtn.click()
    await rm.locator('input[maxlength="20"]').fill(NAME + mode)
    await rm.getByRole('button', { name: '建立角色' }).click()
    const errShown = await rm.getByText(/建立失敗：伺服器回應看不懂（HTTP 502）/).waitFor({ timeout: 4000 }).then(() => true, () => false)
    check('伺服器回非 JSON → 顯示錯誤（不會安靜沒反應）', errShown)
    await page.unroute('**/api/admin/roles')
    await rm.getByRole('button', { name: '取消' }).click()

    // 新增
    await addBtn.click()
    await rm.locator('input[maxlength="20"]').fill(NAME + mode)
    await rm.locator('label', { hasText: 'UAT 整合測試' }).locator('input').check()
    await rm.locator('label', { hasText: '知識庫' }).locator('input').check()
    await rm.getByRole('button', { name: '建立角色' }).click()
    await rm.getByText('已新增角色').waitFor()
    const key = db.prepare('SELECT key FROM roles WHERE label = ?').get(NAME + mode)?.key
    check('建立後存進角色表、權限兩項', !!key && db.prepare("SELECT COUNT(*) n FROM role_permissions WHERE role = ? AND allowed = 1").get(key).n === 2, key)
    await page.screenshot({ path: `role-manager-${mode}.png`, fullPage: true })

    // 指派
    await page.getByRole('button', { name: '帳號管理' }).click()
    await page.locator('tr', { hasText: 'asd' }).first().getByRole('button', { name: '編輯' }).click()
    await page.locator('select').filter({ has: page.locator(`option[value="${key}"]`) }).first().selectOption(key)
    await page.getByRole('button', { name: '儲存' }).first().click()
    await page.waitForTimeout(600)
    check('asd 指派到新角色', db.prepare("SELECT role FROM jira_accounts WHERE email='asd'").get().role === key)
    check('帳號表顯示新角色標籤', (await page.locator('tr', { hasText: 'asd' }).first().innerText()).includes(NAME + mode))

    // 刪除被擋
    await page.getByRole('button', { name: '角色管理' }).click()
    await rm.waitFor()
    await rm.getByRole('button', { name: new RegExp(NAME + mode) }).click()
    check('新角色顯示 1 人、列出 asd', (await rm.getByRole('button', { name: new RegExp(NAME + mode) }).innerText()).includes('1 人') && await rm.getByText('asd', { exact: true }).isVisible())
    await rm.getByRole('button', { name: '刪除角色' }).click()
    await rm.getByText(/還有 1 個帳號在用/).waitFor()
    check('刪除使用中 → 擋下並列出帳號、有前往帳號管理', await rm.getByText(/（asd）/).isVisible() && await rm.getByRole('button', { name: /前往帳號管理/ }).isVisible())
    check('擋下後角色還在', !!db.prepare('SELECT 1 FROM roles WHERE key = ?').get(key))

    // 還原後刪除
    db.prepare("UPDATE jira_accounts SET role = ? WHERE email='asd'").run(origRole)
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('.app-sidebar .sidebar-nav-item').filter({ hasText: /系統管理|太玄樞機/ }).first().click()
    await rm.waitFor()
    await rm.getByRole('button', { name: new RegExp(NAME + mode) }).click()
    await rm.getByRole('button', { name: '刪除角色' }).click()
    await rm.getByText(/已刪除/).waitFor()
    check('沒人用之後可以刪掉', !db.prepare('SELECT 1 FROM roles WHERE key = ?').get(key))
    await ctx.close()
  }
} finally {
  db.prepare("UPDATE jira_accounts SET role = ? WHERE email='asd'").run(origRole)
  for (const r of db.prepare("SELECT key FROM roles WHERE label LIKE ?").all(NAME + '%')) { db.prepare('DELETE FROM role_permissions WHERE role = ?').run(r.key); db.prepare('DELETE FROM roles WHERE key = ?').run(r.key) }
  await browser.close()
}
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

/**
 * Meegle 評論：正式空間送出時只跳**一個**彈窗——格式提醒併進正式確認（1008 使用者：兩個彈窗連跳會衝突）。
 * 用真的 Sheet 走 ①→②→③；身分、「這份 Sheet 在別的空間送過」都換成假的；送出端點直接擋掉（**不會寫進正式空間**）。
 * 跑法：node scripts/ui-checks/meegle-comment-prod-confirm.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

// 本機區網 IP 會變（10/08 從 .41 變 .36）——可用 UI_HOST 覆寫
const HOST = process.env.UI_HOST || '192.168.3.36'
const SHEET = 'https://casinoplus.sg.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email = 'eric.wu@toppath.tw' AND expires_at > ? ORDER BY created_at DESC").get(Date.now())

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))

await page.route('**/api/meegle/comment/identities', async route => {
  const names = JSON.parse(route.request().postData() || '{}').names ?? []
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, self: true, selfEmail: 'eric.wu@toppath.tw', results: names.map(n => ({ name: n, status: 'ok', email: 'eric.wu@toppath.tw', label: n })) }) })
})
// 這份測試 Sheet 送過測試空間 → 正式空間會被擋；這裡只驗彈窗，所以假裝沒送過
await page.route('**/api/meegle/comment/previous', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, rows: [], otherSpace: null }) }))
// 🚨 送出一律擋掉——這支在正式空間，絕對不能真的送
let posted = 0
await page.route('**/api/meegle/comment/row', route => { posted++; return route.abort() })

await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
await page.getByRole('button', { name: 'Meegle 評論' }).click()
await page.locator('.msp-seg-btn', { hasText: '正式' }).first().click()
await page.waitForTimeout(500)
await page.locator('.mc-loadbar .mb-input').fill(SHEET)
await page.getByRole('button', { name: /讀取 Sheet/ }).first().click()
await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
const boxes = page.locator('.mb-table tbody tr').filter({ has: page.locator('a[href*="/detail/"]') }).locator('input[type=checkbox]')
if (!(await boxes.first().isChecked())) await boxes.first().check()
await page.getByRole('button', { name: '下一步' }).click()
await page.locator('.mc-identity').waitFor()
await page.locator('.mb-field').filter({ hasText: '評論內容欄' }).locator('select').selectOption('備註')
await page.getByRole('button', { name: '產生預覽' }).click()
await page.locator('.mc-preview').waitFor()
await page.waitForTimeout(800)

const dialogs = () => page.getByRole('dialog')
await page.getByRole('button', { name: '前往送出' }).click()
await page.waitForTimeout(600)
check('正式空間：只跳一個彈窗', (await dialogs().count()) === 1, String(await dialogs().count()))
const dlg = dialogs().first()
const txt = (await dlg.innerText()).replace(/\s+/g, ' ')
check('那一個是正式確認', /確認送到正式空間/.test(txt), txt.slice(0, 60))
check('格式提醒併在正式確認裡（列出缺的細項）', /評論格式不完整/.test(txt) && /缺：/.test(txt), txt.slice(0, 200))
await page.screenshot({ path: path.join(root, 'mc-prod-confirm.png') })
// 1009（CodeX）：只有遮罩不夠，鍵盤 Tab 要走不出彈窗（背景 #root 設 inert）
const escaped = []
for (let i = 0; i < 15; i++) {
  await page.keyboard.press('Tab')
  const where = await page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.closest('[role=dialog]') ? 'dialog' : (a.textContent || a.tagName).trim().slice(0, 20) })
  if (where !== 'dialog' && where !== 'body') escaped.push(where)
}
check('確認框開著時按 Tab 15 次，焦點都留在彈窗裡（背景按不到）', escaped.length === 0, JSON.stringify(escaped))
await dlg.getByRole('button', { name: '取消' }).click()
await page.waitForTimeout(400)
check('取消 → 沒送、彈窗關掉', posted === 0 && (await dialogs().count()) === 0)
check('彈窗關掉後背景恢復可以操作（#root 不再 inert）', await page.evaluate(() => !document.getElementById('root').inert))
check('沒有頁面錯誤', errors.length === 0, errors.join(' | '))
await browser.close()
console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)

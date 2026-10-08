/**
 * Meegle 批量工具：在一個分頁讀過的 Sheet 網址，切到其他分頁會自動帶入（v5.0.0 搬出 Jira 時弄丟，v5.7.1 補回）。
 * Sheet 讀取假掉。走區網 IP。跑法：node scripts/ui-checks/meegle-tabs-share-sheet.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = process.env.UI_HOST || '192.168.3.36'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'), { readonly: true })
const sess = db.prepare("SELECT sid FROM auth_sessions WHERE expires_at > ? AND email = 'eric.wu@toppath.tw' ORDER BY created_at DESC LIMIT 1").get(Date.now())
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const URL = 'https://example.larksuite.com/sheets/SHARED123?sheet=abc'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
await ctx.addInitScript(() => { if (!sessionStorage.getItem('init')) { localStorage.removeItem('meegle-tools-last-sheet'); localStorage.setItem('meegle-tools-tab', 'create'); sessionStorage.setItem('init', '1') } })
await ctx.route('**/api/lark/sheets/records', r => r.fulfill({ json: { ok: true, records: [{ _rowIndex: 2, 摘要: '假單' }] } }))
await ctx.route('**/api/meegle/**/previous', r => r.fulfill({ json: { ok: true, rows: [] } }))
const page = await ctx.newPage()
await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
await page.getByText(/^(Meegle 批量工具|卷宗管理)$/).first().click()
await page.getByRole('button', { name: 'Meegle 開單' }).click()
await page.locator('.mb-input').first().fill(URL)
await page.getByRole('button', { name: /讀取 Sheet/ }).click()
await page.waitForTimeout(800)
for (const tab of ['Meegle 評論', 'Meegle 狀態', 'Meegle 修改']) {
  await page.getByRole('button', { name: tab }).click()
  await page.waitForTimeout(500)
  const values = await page.locator('input').evaluateAll(els => els.map(e => e.value))
  check(`切到「${tab}」自動帶入剛剛的 Sheet`, values.includes(URL))
}
await page.reload({ waitUntil: 'networkidle' })
await page.getByText(/^(Meegle 批量工具|卷宗管理)$/).first().click()
await page.waitForTimeout(500)
const values = await page.locator('input').evaluateAll(els => els.map(e => e.value))
check('重整頁面後仍帶入', values.includes(URL))
await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

/**
 * Meegle 評論分頁：用真的 Sheet 走 ①→②→③（**不按送出**，不會寫 Meegle）。走區網 IP。
 * 跑法：node scripts/ui-checks/meegle-comment-walkthrough.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

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
let posted = []
ctx.on('request', r => { if (r.method() === 'POST' && /\/api\/meegle\/comment\/row\b/.test(r.url())) posted.push(r.url()) })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))

for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 評論' }).click()
  await page.locator('.mc-loadbar .mb-input').fill(SHEET)
  await page.getByRole('button', { name: /讀取 Sheet/ }).first().click()
  await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
  const rowCount = await page.locator('.mb-table tbody tr').count()
  const ids = await page.locator('.mb-table tbody td:nth-child(3)').allInnerTexts()
  check('① 讀到帶單號的列', rowCount > 0, `${rowCount} 列；${ids.slice(0, 5).join('、')}`)
  check('① Meegle 單號有連結（網址用空間簡稱）', (await page.locator('.mb-table a[href*="/3kvkm7/task_normal/detail/"]').count()) > 0)
  await page.screenshot({ path: path.join(root, `mc-step1-${mode}.png`) })
  // 確保至少勾一列 Meegle 單（測試空間那三張只讀不寫）
  const meegleRows = page.locator('.mb-table tbody tr').filter({ has: page.locator('a[href*="/detail/"]') })
  const first = meegleRows.first().locator('input[type=checkbox]')
  if (!(await first.isChecked())) await first.check()
  await page.getByRole('button', { name: '下一步' }).click()
  await page.locator('.mc-identity').waitFor()
  await page.waitForTimeout(1500)
  check('② 身分檢查有結果', (await page.locator('.mc-id').count()) > 0, (await page.locator('.mc-id').allInnerTexts()).join(' / '))
  await page.screenshot({ path: path.join(root, `mc-step2-${mode}.png`) })
  // 這份 Sheet 的評論內容在「備註」（沒有「驗證結果」欄，不會自動選到）——照使用者操作手動選
  await page.locator('.mb-field').filter({ hasText: '評論內容欄' }).locator('select').selectOption('備註')
  await page.getByRole('button', { name: '產生預覽' }).click()
  // 1008 使用者：只發 Comment——沒有測試說明欄、沒有覆寫開關、不讀 Meegle 現況
  await page.locator('.mc-preview').waitFor()
  check('③ 沒有測試說明欄、沒有「覆寫測試頁」', (await page.locator('textarea[aria-label="測試說明內容"]').count()) === 0 && (await page.getByText('覆寫測試頁').count()) === 0)
  const cmt = page.locator('textarea[aria-label="評論內容"]')
  check('③ Comment 有內容（從 Sheet 的評論內容欄帶入）', (await cmt.inputValue()).length > 0)
  check('③ 圖片與影片在 Comment 底下', (await page.locator('.mc-panel', { hasText: 'Comment' }).locator('.mc-sub-head', { hasText: '圖片與影片' }).count()) === 1)
  check('③ 底部顯示可送出 N 列', /可送出 \d+ \/ \d+ 列/.test(await page.locator('.mc-foot').innerText()), await page.locator('.mb-foot-sum').innerText())
  await page.screenshot({ path: path.join(root, `mc-step3-${mode}.png`), fullPage: true })
}
check('全程沒有送出任何一列（POST /row 次數 0）', posted.length === 0, String(posted.length))
check('頁面沒有 JS 錯誤', errors.length === 0, errors.join(' | ').slice(0, 300))
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

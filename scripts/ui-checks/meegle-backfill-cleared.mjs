/**
 * Meegle 補回填「Sheet 上被清掉的回填」（v5.26.0）。掃描打真的（唯讀，讀使用者那份 Sheet）；補回用假的（不寫真 Sheet）。
 * 兩種主題各截一張。跑法：node scripts/ui-checks/meegle-backfill-cleared.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'

const HOST = '192.168.3.41'
const SHEET = 'https://toppath.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf'
const db = new Database('server/data.db', { readonly: true })
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email = 'eric.wu@toppath.tw' AND expires_at > ? ORDER BY created_at DESC").get(Date.now())
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()

for (const theme of ['classic', 'xianxia']) {
  console.log(`== ${theme}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(t => localStorage.setItem('toppath-theme-mode', t), theme)
  const page = await ctx.newPage()
  const sent = []
  await page.route('**/api/meegle/backfill/restore', async r => {
    const items = r.request().postDataJSON().items; sent.push(...items)
    await r.fulfill({ json: { ok: true, results: items.map(i => ({ ...i, ok: true, message: '已補回單號與處理階段' })) } })
  })
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 補回填' }).click()
  await page.getByText('Sheet 上被清掉的回填').waitFor({ timeout: 30000 })
  check('掃描鈕沒貼網址時停用', await page.getByRole('button', { name: '掃描' }).isDisabled())
  await page.getByLabel('Sheet 網址').fill(SHEET)
  await page.getByRole('button', { name: '掃描' }).click()
  const rows = page.locator('.bf-scan ~ .mb-table-wrap tbody tr')
  await rows.first().waitFor({ timeout: 60000 })
  const n = await rows.count()
  const disabled = await page.locator('.bf-scan ~ .mb-table-wrap tbody input[type=checkbox]:disabled').count()
  check('真的掃描有結果', n > 0, `${n} 列`)
  check('別張單／不能補的列勾選框停用', disabled === (await page.getByText(/單號格現在是別張單|不是開單工具開的/).count()), `停用 ${disabled}`)
  check('預設不勾選（補回 0 列、按鈕停用）', await page.getByRole('button', { name: '補回 0 列' }).isDisabled())
  const can = n - disabled
  if (can > 0) {
    await page.getByLabel('全選可補的列').check()
    check(`表頭全選 → 補回 ${can} 列`, await page.getByRole('button', { name: `補回 ${can} 列` }).isEnabled())
  }
  await page.screenshot({ path: `bf-cleared-${theme}.png`, fullPage: true })
  if (can > 0) {
    await page.getByRole('button', { name: `補回 ${can} 列` }).click()
    await page.locator('.bf-result--ok').first().waitFor({ timeout: 30000 })
    check('送出的只有可補的列', sent.length === can, `送了 ${sent.length}`)
    check('補完標「已補回」、勾選清掉', (await page.locator('.bf-result--ok').count()) === can && await page.getByRole('button', { name: '補回 0 列' }).isDisabled())
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  check('沒有橫向溢出', !overflow)
  await ctx.close()
}
await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

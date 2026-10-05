/**
 * Meegle 開單 ③「批量設定」人員欄可以選多個人（使用者 2026-10-05：QA 驗證要複選）。
 * Sheet／Meegle 全部 page.route 假掉，送出也攔下來（不開真單），只驗前端：
 *   1 從下拉選兩個人 → 兩個標籤；× 能移除
 *   2 套用後該列人員欄顯示兩個人
 *   3 送出時 roles.qaVerifier 是兩個人
 * 兩種主題各截一張圖。走區網 IP。跑法：node scripts/ui-checks/meegle-bulk-multi-people.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = '192.168.3.41'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'), { readonly: true })
const sess = db.prepare("SELECT sid FROM auth_sessions WHERE expires_at > ? AND email = 'eric.wu@toppath.tw' ORDER BY created_at DESC LIMIT 1").get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()
const people = [
  { alias: 'eric wu', userKey: '1', email: 'eric.wu@toppath.tw', name: 'Eric' },
  { alias: 'tim', userKey: '2', email: 'tim@toppath.tw', name: 'Tim' },
  { alias: 'albert tsai', userKey: '3', email: 'albert.tsai@toppath.tw', name: 'Albert Tsai' },
]

for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(m => { localStorage.setItem('toppath-theme-mode', m); localStorage.setItem('toppath-sidebar-collapsed', '0') }, mode)
  await ctx.route('**/api/meegle/batch/meta*', r => r.fulfill({ json: { ok: true, requirements: [{ id: '900001', name: '假需求' }], states: [], statesError: null } }))
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people } }))
  await ctx.route('**/api/meegle/batch/people/roster', r => r.fulfill({ json: { ok: true, users: [], fetchedAt: Date.now() } }))
  await ctx.route('**/api/meegle/batch/people/suggest', r => r.fulfill({ json: { ok: true, suggestions: [] } }))
  await ctx.route('**/api/meegle/batch/previous', r => r.fulfill({ json: { ok: true, rows: [] } }))
  await ctx.route('**/api/lark/sheets/records', r => r.fulfill({ json: { ok: true, records: [{ _rowIndex: 2, 摘要: '假單一', 回報者: 'eric wu' }] } }))
  const sent = []
  await ctx.route('**/api/meegle/batch/row', async r => {
    const b = r.request().postDataJSON(); sent.push(b)
    await r.fulfill({ json: { ok: true, row: { batchId: b.batchId, rowKey: b.rowKey, createPhase: 'created', workItemId: '990001', url: null, statePhase: 'none', message: null, writebackPhase: 'done', writebackMsg: null } } })
  })
  await ctx.route('**/api/meegle/batch/finish', r => r.fulfill({ json: { ok: true } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  await page.locator('.mb-select').first().selectOption('900001')
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE?sheet=x')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: /批量設定/ }).click()

  const qa = page.locator('.mb-bulk .mb-field', { hasText: 'QA 驗證' })
  const input = qa.locator('.mb-picker-input')
  await input.fill('tim'); await page.waitForTimeout(150)
  await input.fill('albert tsai'); await page.waitForTimeout(150)
  await input.fill('eric wu'); await page.waitForTimeout(150)
  const chips = await qa.locator('.mb-picker-chip').allInnerTexts()
  check('從名單選三個人 → 三個標籤（第二個不會蓋掉第一個）', chips.length === 3, chips.join(' | '))
  await qa.locator('.mb-picker-chip', { hasText: 'eric wu' }).getByRole('button').click()
  check('× 移除一個', await qa.locator('.mb-picker-chip').count() === 2)
  await input.fill('tim'); await page.waitForTimeout(150)
  check('重複選同一個人不會多一個', await qa.locator('.mb-picker-chip').count() === 2)
  await page.screenshot({ path: path.join(root, `meegle-bulk-multi-${mode}.png`) })

  await page.getByRole('button', { name: '套用到已勾選的列' }).click()
  const peopleCell = await page.locator('.mb-people').first().innerText()
  check('該列人員欄顯示兩個 QA', /tim/i.test(peopleCell) && /albert tsai/i.test(peopleCell), peopleCell.replace(/\s+/g, ' '))
  await page.getByRole('button', { name: /^送出 \d+ 列$/ }).click()
  await page.locator('.mb-tally', { hasText: '已開單 1' }).waitFor({ timeout: 10000 })
  check('送出的 QA 驗證是兩個人', JSON.stringify(sent[0]?.roles?.qaVerifier) === JSON.stringify(['tim', 'albert tsai']), JSON.stringify(sent[0]?.roles))
  await ctx.close()
}

await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

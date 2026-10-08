/**
 * Meegle 開單 ③「批量設定」人員欄可以選多個人（使用者 2026-10-05：QA 驗證要複選）。
 * Sheet／Meegle 全部 page.route 假掉，送出也攔下來（不開真單），只驗前端：
 *   1 從下拉選兩個人 → 兩個標籤；× 能移除（1009 起下拉是空間人員、值是 email；選到還沒對照的人會走 verify 記下來）
 *   2 套用後該列人員欄顯示兩個人
 *   3 送出時 roles.qaVerifier 是兩個人
 * 兩種主題各截一張圖。走區網 IP。跑法：node scripts/ui-checks/meegle-bulk-multi-people.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

// 本機區網 IP 會變（10/08 從 .41 變 .36）——可用 UI_HOST 覆寫
const HOST = process.env.UI_HOST || '192.168.3.36'
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
  // 對照表一開始只有 eric wu；選人時走 verify，記下來之後 /people 就讀得到（照真的流程）
  const map = [people[0]]
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: map } }))
  const verified = []
  await ctx.route('**/api/meegle/batch/people/verify', async r => {
    const b = r.request().postDataJSON(); verified.push(b)
    const p = people.find(x => x.email === b.email)
    if (p && !map.some(m => m.alias === b.alias)) map.push({ ...p, alias: b.alias })
    await r.fulfill({ json: { ok: true, person: p } })
  })
  await ctx.route('**/api/meegle/batch/people/roster', r => r.fulfill({ json: { ok: true, users: people.map(p => ({ userKey: p.userKey, email: p.email, name: p.name, names: [p.name] })), fetchedAt: Date.now() } }))
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
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE?sheet=x')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  check('讀完直接進 ③（不用先綁人員）', await page.getByRole('button', { name: /批量設定/ }).isVisible())
  await page.getByRole('button', { name: /批量設定/ }).click()
  await page.getByText(/不是完整名錄/).first().waitFor({ timeout: 10000 })
  // 關聯需求在 ③ 批量設定裡選（版面改過：讀 Sheet 前那個下拉是停用的）
  await page.locator('select:has(option[value="900001"])').first().selectOption('900001')

  const qa = page.locator('.mb-bulk .mb-field', { hasText: 'QA 驗證' })
  const input = qa.locator('.mb-picker-input')
  await input.fill('tim@toppath.tw'); await page.waitForTimeout(150)
  await input.fill('albert.tsai@toppath.tw'); await page.waitForTimeout(150)
  await input.fill('eric.wu@toppath.tw'); await page.waitForTimeout(150)
  const chips = await qa.locator('.mb-picker-chip').allInnerTexts()
  check('從名單選三個人 → 三個標籤（第二個不會蓋掉第一個）', chips.length === 3, chips.join(' | '))
  await qa.locator('.mb-picker-chip', { hasText: 'eric.wu@toppath.tw' }).getByRole('button').click()
  check('× 移除一個', await qa.locator('.mb-picker-chip').count() === 2)
  await input.fill('tim@toppath.tw'); await page.waitForTimeout(150)
  check('重複選同一個人不會多一個', await qa.locator('.mb-picker-chip').count() === 2)
  await page.screenshot({ path: path.join(root, `meegle-bulk-multi-${mode}.png`) })

  await page.getByRole('button', { name: '套用到已勾選的列' }).click()
  const peopleCell = await page.locator('.mb-people').first().innerText()
  check('該列人員欄顯示兩個 QA', /tim/i.test(peopleCell) && /albert/i.test(peopleCell), peopleCell.replace(/\s+/g, ' '))
  check('選到還沒對照的人 → 走 verify 記下來（帶 userKey，伺服器重新核對）', ['tim@toppath.tw', 'albert.tsai@toppath.tw'].every(e => verified.some(v => v.email === e && v.userKey)), JSON.stringify(verified.map(v => v.email)))
  await page.getByRole('button', { name: /^送出 \d+ 列$/ }).click()
  await page.locator('.mb-tally', { hasText: '已開單 1' }).waitFor({ timeout: 10000 })
  check('送出的 QA 驗證是兩個人', JSON.stringify(sent[0]?.roles?.qaVerifier) === JSON.stringify(['tim@toppath.tw', 'albert.tsai@toppath.tw']), JSON.stringify(sent[0]?.roles))
  await ctx.close()
}

await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

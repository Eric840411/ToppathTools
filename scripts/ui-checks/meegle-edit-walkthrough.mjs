/**
 * Meegle 批量修改分頁走一輪（v4.279.0）：真 Sheet、真讀 Meegle 現況與選項、預覽由後端真的算；
 * 送出（/api/meegle/edit/row）用假的，**不會真的改任何單**。兩種主題各截 ②③④。
 * 情境：RD 負責人固定值填一個沒對照的人（Tim）→ 全部受阻、② 人員對照列出 Tim；
 *       單列把 RD 改成「這列不改這欄」→ 那一列變可送出；送出內容帶後端給的 planHash／baseline、且不含 RD。
 * 跑法：node scripts/ui-checks/meegle-edit-walkthrough.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'

const HOST = '192.168.3.41'
const SHEET = 'https://casinoplus.sg.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf'
const db = new Database('server/data.db')
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email = 'eric.wu@toppath.tw' AND expires_at > ? ORDER BY created_at DESC").get(Date.now())

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()
const field = (page, label) => page.locator('.me-field').filter({ has: page.locator('.me-field-label', { hasText: new RegExp(`^${label}$`) }) })

for (const theme of ['classic', 'xianxia']) {
  console.log(`== ${theme}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(t => localStorage.setItem('toppath-theme-mode', t), theme)
  const sent = []
  await ctx.route('**/api/meegle/edit/row', async r => {
    sent.push(r.request().postDataJSON())
    await r.fulfill({ json: { ok: true, claim: { kind: 'claimed' }, steps: [
      { step: 'fields', phase: 'done', message: null, attemptAt: 1 }, { step: 'roles', phase: 'done', message: null, attemptAt: 1 },
      { step: 'verify', phase: 'done', message: null, attemptAt: 1 }, { step: 'writeback', phase: 'failed', message: '修改完成、回填失敗：模擬 Sheet 鎖住', attemptAt: 1 },
    ] } })
  })
  await ctx.route('**/api/meegle/edit/finish', r => r.fulfill({ json: { ok: true } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 修改' }).click()
  await page.locator('.mc-loadbar .mb-input').fill(SHEET)
  await page.getByRole('button', { name: /讀取資料/ }).click()
  await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
  for (const cb of await page.locator('.mb-table tbody input[type=checkbox]:not([disabled])').all()) if (!(await cb.isChecked())) await cb.check()
  await page.getByRole('button', { name: '下一步' }).click()

  await field(page, '任務名稱').locator('.me-mode').selectOption('sheet')
  await field(page, '任務名稱').locator('.me-field-value select').selectOption('摘要')
  await field(page, '優先順序').locator('.me-mode').selectOption('fixed')
  await field(page, '優先順序').locator('.me-field-value select').selectOption('P1')
  await field(page, '回報者').locator('.me-mode').selectOption('sheet')
  await field(page, '回報者').locator('.me-field-value select').selectOption('填寫人')
  await field(page, 'RD 負責人').locator('.me-mode').selectOption('fixed')
  await field(page, 'RD 負責人').locator('.me-field-value input').fill('Tim')
  await field(page, 'Gitlab 連結').locator('.me-mode').selectOption('clear')
  check('② 固定值輸入不會打一個字就失焦（Tim 完整打進去）', (await field(page, 'RD 負責人').locator('.me-field-value input').inputValue()) === 'Tim')
  check('② 人員對照列出沒對照的 Tim', (await page.locator('.me-person-name', { hasText: 'Tim' }).count()) === 1)
  await page.screenshot({ path: `me-step2-${theme}.png`, fullPage: true })

  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.me-st')].some(e => /讀取中|圖片載入中/.test(e.textContent || '')), null, { timeout: 90000 })
  const sts = await page.locator('.me-list-row .me-st').allInnerTexts()
  check('③ 全部受阻（RD 有 Tim）', sts.length >= 2 && sts.every(s => s === '受阻'), sts.join(','))
  check('③ 紅條說明受阻原因', /Tim 沒有人員對照/.test(await page.locator('.me-block').innerText()))
  const rows = await page.locator('.me-changes tbody tr').allInnerTexts()
  check('③ 詳情列出 原值→新值（優先順序 → P1、Gitlab 清空）', rows.some(t => /優先順序[\s\S]*P1/.test(t)) && rows.some(t => /Gitlab[\s\S]*（清空）/.test(t)), rows.map(t => t.replace(/\s+/g, ' ')).join(' | '))
  // 第一列：RD 這列不改
  await page.locator('.me-changes tbody tr', { hasText: 'RD 負責人' }).getByRole('button', { name: /單列修改/ }).click()
  await page.getByRole('button', { name: '這列不改這欄' }).click()
  await page.waitForFunction(() => document.querySelector('.me-list-row.is-on .me-st')?.textContent === '可送出', null, { timeout: 60000 })
  check('③ 單列不改 RD → 那一列變可送出', true)
  check('③ 顯示「單列修改已套用」', (await page.locator('.me-ov-note').count()) === 1)
  await page.screenshot({ path: `me-step3-${theme}.png`, fullPage: true })
  await page.getByRole('button', { name: /^送出 1 筆$/ }).click()
  await page.getByRole('button', { name: '補寫回' }).waitFor({ timeout: 30000 }).catch(() => {})
  check('④ 只送可送出的那一列', sent.length === 1, String(sent.length))
  check('④ 送出內容不含 RD、帶 planHash／baseline', sent[0] && !sent[0].raws.some(r => r.key === 'role:rdOwner') && /^[0-9a-f]{64}$/.test(sent[0].planHash) && 'priority' in sent[0].baseline)
  check('④ 回填失敗 → 按鈕是「補寫回」', (await page.getByRole('button', { name: '補寫回' }).count()) === 1)
  check('④ 受阻的列列為「受阻未送出」', (await page.locator('.mb-result', { hasText: '受阻未送出' }).count()) >= 1)
  await page.screenshot({ path: `me-step4-${theme}.png`, fullPage: true })
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

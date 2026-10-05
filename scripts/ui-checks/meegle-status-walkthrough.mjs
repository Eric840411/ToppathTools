/**
 * Meegle 批量更新狀態分頁走一輪（v4.277.0）：真 Sheet、真讀 Meegle 狀態清單與每張單現況；
 * 送出（/api/meegle/status/row）用假的，**不會真的轉任何單**。兩種主題各截 ②③④。
 * 跑法：node scripts/ui-checks/meegle-status-walkthrough.mjs
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

for (const theme of ['classic', 'xianxia']) {
  console.log(`== ${theme}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(t => localStorage.setItem('toppath-theme-mode', t), theme)
  const sent = []
  await ctx.route('**/api/meegle/status/row', async r => {
    const b = r.request().postDataJSON(); sent.push(b)
    const pending = sent.length === 1
    await r.fulfill({ json: { ok: true, claim: { kind: 'claimed' }, steps: [
      { step: 'state', phase: 'done', message: null, attemptAt: 1 },
      pending ? { step: 'date', phase: 'failed', message: '日期待確認：轉換後 20 秒內沒看到自動化改上線時間（原值可能本來就是今天），沒有覆寫。稍後按「只補日期」', attemptAt: 1, date: { label: '上線時間', original: null, desired: 1, pending: true } }
        : { step: 'date', phase: 'skipped', message: null, attemptAt: 1 },
      { step: 'writeback', phase: pending ? 'none' : 'done', message: null, attemptAt: null },
    ] } })
  })
  await ctx.route('**/api/meegle/status/finish', r => r.fulfill({ json: { ok: true } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 狀態' }).click()
  await page.locator('.mc-loadbar .mb-input').fill(SHEET)
  await page.getByRole('button', { name: /讀取 Sheet/ }).first().click()
  await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
  check('① 讀到 Sheet 的 Meegle 單號列', (await page.locator('.mb-table tbody tr').count()) >= 2)
  for (const cb of await page.locator('.mb-table tbody input[type=checkbox]:not([disabled])').all()) if (!(await cb.isChecked())) await cb.check()
  await page.getByRole('button', { name: '下一步' }).click()
  await page.locator('.mb-field').filter({ hasText: '整批預設' }).locator('select').selectOption({ label: '完成' })
  await page.getByText('指定日期', { exact: true }).click()
  await page.locator('.ms-date-field').filter({ hasText: '上線時間' }).locator('input[type=date]').fill('2026-09-20')
  await page.screenshot({ path: `ms-step2-${theme}.png`, fullPage: true })
  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.ms-from')].some(e => e.textContent?.includes('讀取中')), null, { timeout: 60000 })
  const froms = await page.locator('.ms-from').allInnerTexts()
  check('③ 每列讀到 Meegle 目前狀態', froms.length >= 2 && froms.every(t => t && !/讀不到/.test(t)), froms.join(','))
  check('③ 詳情顯示 上線時間 原值→預計值 9/20（指定日期）', /上線時間/.test(await page.locator('.ms-detail').innerText()) && /09\/20/.test(await page.locator('.ms-detail').innerText()))
  check('③ 只顯示會動的那個日期（轉完成不提上C服）', !/上C服/.test(await page.locator('.ms-detail').innerText()))
  check('③ 來源標「預設」', (await page.locator('.ms-src--default').count()) >= 1)
  // 第一列手改成 C服 → 來源變「預覽」、詳情換成上C服時間
  await page.locator('.ms-target').first().selectOption({ label: 'C服' })
  await page.locator('.ms-table tbody tr').first().click()
  check('③ 預覽手改 → 來源「預覽」', (await page.locator('.ms-src--preview').count()) === 1)
  check('③ 手改成 C服 → 詳情換成上C服時間', /上C服時間/.test(await page.locator('.ms-detail').innerText()))
  const sum = await page.locator('.mb-foot-sum').innerText()
  check('③ 底部已選／可送／受阻', /已選\s*\d+.*可送\s*\d+.*受阻\s*\d+/.test(sum.replace(/\n/g, ' ')), sum.replace(/\s+/g, ' '))
  await page.screenshot({ path: `ms-step3-${theme}.png`, fullPage: true })
  await page.getByRole('button', { name: '前往送出' }).click()
  await page.locator('.mb-result').first().waitFor({ timeout: 30000 })
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length >= 2, null, { timeout: 30000 })
  check('④ 送出內容：第一列目標 C服、其他用預設 完成', sent[0]?.targetName === 'C服' && sent.slice(1).every(s => s.targetName === '完成'), sent.map(s => s.targetName).join(','))
  check('④ 指定日期送出的是台北 9/20 00:00', sent.filter(s => s.targetName === '完成').every(s => s.sheetDate === Date.UTC(2026, 8, 20) - 8 * 3600e3 && s.dateMode === 'set'))
  check('④ 日期待確認黃標＋「只補日期」', (await page.locator('.mb-result .mb-badge--warn', { hasText: '日期待確認' }).count()) === 1 && (await page.getByRole('button', { name: '只補日期' }).count()) === 1)
  await page.screenshot({ path: `ms-step4-${theme}.png`, fullPage: true })
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

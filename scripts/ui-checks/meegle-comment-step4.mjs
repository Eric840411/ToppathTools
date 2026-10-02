/**
 * Meegle 評論分頁 ④ 送出結果：真 Sheet、真讀 Meegle 現況，但 /row、candidates、resolve、writeback **全部假的**（不寫 Meegle、不寫 Sheet）。
 * 驗：三種結果（全部完成／評論待確認／只剩回填失敗）各自的狀態與按鈕；候選評論→「就是這則」會打 resolve；補寫回會打 writeback。
 * 跑法：node scripts/ui-checks/meegle-comment-step4.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const HOST = '192.168.3.41'
const SHEET = 'https://casinoplus.sg.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email = 'eric.wu@toppath.tw' AND expires_at > ? ORDER BY created_at DESC").get(Date.now())

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const S = (step, phase, message = null) => ({ step, phase, message, attemptAt: Date.now() })
const outcome = {
  '15191459': [S('desc', 'done'), S('comment', 'done'), S('review', 'skipped'), S('writeback', 'done')],
  '15194994': [S('desc', 'done'), S('comment', 'unknown', '送出結果不明：逾時（不會自動重送）'), S('review', 'skipped'), S('writeback', 'none')],
  '15194995': [S('desc', 'done'), S('comment', 'done'), S('review', 'skipped'), S('writeback', 'failed', '列已變動')],
}
const calls = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
await ctx.route('**/api/meegle/comment/row', async r => { const b = r.request().postDataJSON(); calls.push(`row:${b.workItemId}`); await r.fulfill({ json: { ok: true, claim: { kind: 'claimed' }, steps: outcome[b.workItemId] } }) })
await ctx.route('**/api/meegle/comment/row/candidates', async r => { calls.push('candidates'); await r.fulfill({ json: { ok: true, candidates: [{ commentId: 'c1', content: 'QA 已更新測試頁「測試說明」。', createdAt: '2026-10-02 05:30:00', fileUrl: '' }] } }) })
await ctx.route('**/api/meegle/comment/row/resolve', async r => { const b = r.request().postDataJSON(); calls.push(`resolve:${b.step}:${b.outcome}`); await r.fulfill({ json: { ok: true, steps: [S('desc', 'done'), S('comment', 'done'), S('review', 'skipped'), S('writeback', 'none')] } }) })
await ctx.route('**/api/meegle/comment/row/writeback', async r => { calls.push('writeback'); await r.fulfill({ json: { ok: true, steps: [S('desc', 'done'), S('comment', 'done'), S('review', 'skipped'), S('writeback', 'done')] } }) })
await ctx.route('**/api/meegle/comment/finish', r => { calls.push('finish'); return r.fulfill({ json: { ok: true } }) })
let aiCalls = 0
await ctx.route('**/api/meegle/comment/ai', async r => { aiCalls++; const b = r.request().postDataJSON(); await r.fulfill({ json: { ok: true, text: '【驗證結果】\n- AI 整理（假）', review: b.review ? '假分析' : null } }) })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))

for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  calls.length = 0
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 評論' }).click()
  await page.locator('.mc-loadbar .mb-input').fill(SHEET)
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
  for (const cb of await page.locator('.mb-table tbody input[type=checkbox]').all()) if (!(await cb.isChecked())) await cb.check()
  await page.getByRole('button', { name: '下一步' }).click()
  await page.locator('.mb-field').filter({ hasText: '評論內容欄' }).locator('select').selectOption('備註')
  const aiBox = page.locator('.mc-switch').filter({ hasText: 'AI 整理測試說明' }).locator('input')
  if (await aiBox.count()) await aiBox.check()
  aiCalls = 0
  await page.getByRole('button', { name: '產生預覽' }).click()
  const settled = () => page.waitForFunction(() => [...document.querySelectorAll('.mc-dot')].length > 0 && [...document.querySelectorAll('.mc-dot')].every(d => !/讀取中|AI/.test(d.textContent || '')), null, { timeout: 120000 })
  await settled()
  const firstAi = aiCalls
  check('進 ③ 每列跑一次 AI', firstAi === 3, String(firstAi))
  await page.locator('.mc-foot').getByRole('button', { name: '上一步' }).click()
  await page.getByRole('button', { name: '產生預覽' }).click()
  await settled()
  check('上一步再回來：不重跑 AI（使用者 10/02：不要白燒）', aiCalls === firstAi, String(aiCalls))
  await page.getByRole('button', { name: '前往送出' }).click()
  await page.locator('.mb-done-line', { hasText: '處理完成 3 / 3' }).waitFor({ timeout: 60000 })
  await page.waitForTimeout(500)
  check('④ 三列都送了', calls.filter(c => c.startsWith('row:')).length === 3, calls.join(','))
  check('④ 結束後寫操作紀錄', calls.includes('finish'))
  const tally = await page.locator('.mb-tally').innerText()
  check('④ 統計：全部完成 1、待確認 1、有失敗 1', /全部完成\s*1/.test(tally) && /待確認\s*1/.test(tally) && /有失敗\s*1/.test(tally), tally.replace(/\s+/g, ' '))
  const unknownRow = page.locator('.mb-result').filter({ hasText: '#15194994' })
  check('待確認那列有「查詢候選」按鈕', await unknownRow.getByRole('button', { name: /查詢候選/ }).count() === 1)
  check('待確認那列沒有「修正後重送」（不能盲目重送）', await unknownRow.getByRole('button', { name: '修正後重送' }).count() === 0)
  await unknownRow.getByRole('button', { name: /查詢候選/ }).click()
  await unknownRow.locator('.mc-cand').first().waitFor()
  await page.screenshot({ path: path.join(root, `mc-step4-${mode}.png`), fullPage: true })
  await unknownRow.getByRole('button', { name: /就是這則/ }).click()
  await page.waitForTimeout(500)
  check('「就是這則」→ resolve comment=done', calls.includes('resolve:comment:done'), calls.join(','))
  const wbRow = page.locator('.mb-result').filter({ hasText: '#15194995' })
  check('只剩回填失敗那列有「補寫回」', await wbRow.getByRole('button', { name: '補寫回' }).count() === 1)
  await wbRow.getByRole('button', { name: '補寫回' }).click()
  await page.waitForTimeout(500)
  check('補寫回 → 打 writeback、狀態變完成', calls.includes('writeback') && (await wbRow.innerText()).includes('Sheet 回填：完成'))
  check('「開啟」連結用空間簡稱網址', (await page.locator('.mb-result a[href*="/3kvkm7/task_normal/detail/"]').count()) === 3)
}
check('頁面沒有 JS 錯誤', errors.length === 0, errors.join(' | ').slice(0, 300))
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

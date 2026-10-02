/**
 * Meegle 評論 ③：附件逐列載入、單列失敗不影響別列、「重新載入附件」只重跑那一列（v4.272.4）。
 * 真 Sheet、真讀 Meegle 現況；attachment-prefetch 用假的（第一次對第 4 列回 500，第二次成功），不會送出任何東西。
 * 跑法：node scripts/ui-checks/meegle-comment-attachments.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
const prefetch = []
let failedOnce = false
await ctx.route('**/api/attachments/prefetch', async r => {
  const b = r.request().postDataJSON()
  const rows = b.groups.map(g => g.rowIndex)
  prefetch.push(rows.join('+'))
  if (rows.includes(4) && !failedOnce) { failedOnce = true; return r.fulfill({ status: 500, json: { ok: false, message: '模擬：伺服器重啟中' } }) }
  await r.fulfill({ json: { ok: true, result: b.groups.map(g => ({ rowIndex: g.rowIndex, attachments: g.rowIndex === 4 ? [{ cacheId: 'fake-video', filename: '螢幕錄影.mov', mimeType: 'video/quicktime', isImage: false, isVideo: true, size: 1000 }] : [] })) } })
})
let posted = 0
ctx.on('request', r => { if (r.method() === 'POST' && /comment\/row/.test(r.url())) posted++ })
const page = await ctx.newPage()
await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
await page.getByRole('button', { name: 'Meegle 評論' }).click()
await page.locator('.mc-loadbar .mb-input').fill(SHEET)
await page.getByRole('button', { name: /讀取 Sheet/ }).click()
await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
for (const cb of await page.locator('.mb-table tbody input[type=checkbox]').all()) if (!(await cb.isChecked())) await cb.check()
await page.getByRole('button', { name: '下一步' }).click()
await page.locator('.mb-field').filter({ hasText: '評論內容欄' }).locator('select').selectOption('備註')
await page.locator('.mb-field').filter({ hasText: '附件欄' }).locator('select').selectOption('圖')
await page.getByRole('button', { name: '產生預覽' }).click()
await page.waitForFunction(() => [...document.querySelectorAll('.mc-dot')].length > 0 && [...document.querySelectorAll('.mc-dot')].every(d => !/讀取中|載入中|AI/.test(d.textContent || '')), null, { timeout: 120000 })
check('逐列載入（一列一個請求，不是整批一個）', prefetch.every(p => !p.includes('+')) && prefetch.length === 3, prefetch.join(','))
check('只有失敗那列標「有附件沒載到」，別列不受影響', await page.locator('.mc-att-banner').innerText().then(t => /1 列有附件沒載到/.test(t)).catch(() => false))
const row4 = page.locator('.mc-list-row').filter({ hasText: '预约统计' })
await row4.click()
check('失敗那列不能送（可送出不含它）', /待處理/.test(await row4.innerText()))
check('錯誤訊息帶原因', /附件載入失敗：模擬：伺服器重啟中/.test(await page.locator('.mc-att-error').innerText()))
const before = prefetch.length
await page.getByRole('button', { name: '重新載入附件' }).click()
await page.locator('.mc-video').first().waitFor({ timeout: 30000 })
check('重新載入只重跑這一列', prefetch.slice(before).join(',') === '4', prefetch.slice(before).join(','))
check('重新載入成功 → 錯誤消失、影片出現', (await page.locator('.mc-att-error').count()) === 0 && /螢幕錄影/.test(await page.locator('.mc-video').first().innerText()))
check('全程沒有送出', posted === 0)
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

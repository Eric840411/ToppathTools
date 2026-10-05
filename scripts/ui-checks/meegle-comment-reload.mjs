/**
 * Meegle 評論 ③：每列常駐「重新載入附件」（v4.275.0）。CodeX 列的四個驗收情境：
 *   ① 讀成 0 個（沒報錯）也能重抓  ② 移除後重載會回來  ③ 手動新增的重載後保留  ④ 單列／頂部交錯點擊不重複請求、載完才解除
 * 真 Sheet、真讀 Meegle 現況、手動上傳打真的 attachment-upload；只有 attachment-prefetch 用假的（控制 0 個／失敗／延遲）。不會送出任何東西。
 * 跑法：node scripts/ui-checks/meegle-comment-reload.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'

const HOST = '192.168.3.41'
const SHEET = 'https://casinoplus.sg.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf'
const UPLOAD = 'autospin-cards.png'   // 手動新增用的真檔案（走真的 attachment-upload）
const db = new Database('server/data.db')
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email = 'eric.wu@toppath.tw' AND expires_at > ? ORDER BY created_at DESC").get(Date.now())

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])

// 目標列（预约统计＝rowIndex 4）每次被請求的行為，依序取用；其他列一律失敗——
// 這樣頂部「重新載入失敗的附件」一直在，才測得到 CodeX 說的「頂部重試把正在載入的列再送一次」
const TARGET = 4
const IMG = { cacheId: 'fake-img', filename: '截圖.png', mimeType: 'image/png', isImage: true, isVideo: false, size: 1000 }
const VID = { cacheId: 'fake-video', filename: '螢幕錄影.mov', mimeType: 'video/quicktime', isImage: false, isVideo: true, size: 1000 }
const plan = [
  { atts: [] },                         // 預載：讀成 0 個、沒報錯（靜默漏掉的情境）
  { atts: [IMG, VID] },                 // ① 重載
  { atts: [IMG, VID] },                 // ② 移除後重載
  { atts: [IMG, VID] },                 // ③ 手動新增後重載
  { status: 500 },                      // ④ 這列先失敗——CodeX 說的情境是「失敗的列正在重載時按頂部」
  { atts: [IMG, VID], delay: 3000 },    // ④ 慢的重載：期間交錯點
  { atts: [IMG, VID] },                 // ④ 若被重複請求才會用到
]
const calls = []
let others = 0
await ctx.route('**/api/attachments/prefetch', async r => {
  const b = r.request().postDataJSON()
  const rows = b.groups.map(g => g.rowIndex)
  if (!rows.includes(TARGET)) { others++; return r.fulfill({ status: 500, json: { ok: false, message: '模擬：別列失敗' } }) }
  const step = plan[calls.length] ?? { atts: [] }
  calls.push(Date.now())
  if (step.delay) await sleep(step.delay)
  if (step.status) return r.fulfill({ status: step.status, json: { ok: false, message: '模擬：伺服器重啟中' } })
  await r.fulfill({ json: { ok: true, result: [{ rowIndex: TARGET, attachments: step.atts }] } })
})
let posted = 0
ctx.on('request', r => { if (r.method() === 'POST' && /meegle\/comment\/(row|send|batch)/.test(r.url())) posted++ })

const page = await ctx.newPage()
await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
await page.getByRole('button', { name: 'Meegle 評論' }).click()
await page.locator('.mc-loadbar .mb-input').fill(SHEET)
await page.getByRole('button', { name: /讀取 Sheet/ }).first().click()
await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
for (const cb of await page.locator('.mb-table tbody input[type=checkbox]').all()) if (!(await cb.isChecked())) await cb.check()
await page.getByRole('button', { name: '下一步' }).click()
await page.locator('.mb-field').filter({ hasText: '評論內容欄' }).locator('select').selectOption('備註')
await page.locator('.mb-field').filter({ hasText: '附件欄' }).locator('select').selectOption('圖')
await page.getByRole('button', { name: '產生預覽' }).click()
await page.waitForFunction(() => [...document.querySelectorAll('.mc-dot')].length > 0 && [...document.querySelectorAll('.mc-dot')].every(d => !/讀取中|載入中|AI/.test(d.textContent || '')), null, { timeout: 120000 })

const row = page.locator('.mc-list-row').filter({ hasText: '预约统计' })
await row.click()
const reload = page.getByRole('button', { name: /^(重新載入附件|載入中…)$/ })
const thumbs = () => page.locator('.mc-thumb figcaption').allInnerTexts()
const videos = () => page.locator('.mc-video').allInnerTexts()
const idle = () => page.waitForFunction(() => !document.querySelector('.mc-empty')?.textContent?.includes('附件載入中'), null, { timeout: 30000 })

console.log('① 讀成 0 個也能重抓')
check('預載讀成 0 個：沒有錯誤框', (await page.locator('.mc-att-error').count()) === 0)
check('沒有失敗也看得到「重新載入附件」', await reload.isVisible())
check('按鈕旁有說明（移除的會回來、新增的保留）', /手動移除的會回來，手動新增的保留/.test(await page.locator('.mc-reload-hint').innerText()))
await reload.click(); await page.locator('.mc-video').first().waitFor({ timeout: 30000 }); await idle()
check('重載後圖片、影片都出現', (await thumbs()).some(t => t.includes('截圖.png')) && (await videos()).some(t => t.includes('螢幕錄影.mov')))

console.log('② 移除後重載會回來')
await page.getByRole('button', { name: '移除 截圖.png' }).click()
check('移除後圖片不見', !(await thumbs()).some(t => t.includes('截圖.png')))
await reload.click(); await idle()
check('重載後被移除的圖片回來', (await thumbs()).some(t => t.includes('截圖.png')))

console.log('③ 手動新增的重載後保留')
await page.locator('.mc-upload input[type=file]').setInputFiles(UPLOAD)
await page.waitForFunction(n => [...document.querySelectorAll('.mc-thumb figcaption')].some(f => f.textContent?.includes(n)), UPLOAD, { timeout: 30000 })
await reload.click(); await idle()
const t3 = await thumbs()
check('重載後手動新增的還在、Sheet 的也在、沒有重複', t3.filter(t => t.includes(UPLOAD)).length === 1 && t3.filter(t => t.includes('截圖.png')).length === 1, JSON.stringify(t3))

console.log('④ 單列／頂部交錯點擊')
await reload.click(); await idle()   // plan[4]：500
check('這列先失敗：出現錯誤框', (await page.locator('.mc-att-error').count()) === 1)
const before = calls.length, othersBefore = others
await reload.click()   // plan[5]：慢 3 秒；載入中錯誤標記還在
await sleep(300)
check('載入中：單列按鈕停用', await reload.isDisabled())
check('載入中：這列狀態是「附件載入中」（不能送）', /附件載入中/.test(await row.innerText()), (await row.innerText()).replace(/\s+/g, ' '))
await reload.click({ force: true, timeout: 1000 }).catch(() => {})       // 停用中硬點
check('別列失敗中，頂部重試按鈕在', await page.getByRole('button', { name: '重新載入失敗的附件' }).isVisible())
await page.getByRole('button', { name: '重新載入失敗的附件' }).click()   // 這列載入中時按頂部
await sleep(3500); await idle()
check('交錯點擊：這列只送出一個請求', calls.length - before === 1, `實際 ${calls.length - before} 個`)
check('頂部重試仍有重抓別的失敗列', others > othersBefore, `別列 +${others - othersBefore}`)
check('載完：這列錯誤消失、不再是載入中', (await page.locator('.mc-att-error').count()) === 0 && !/附件載入中/.test(await row.innerText()))

check('全程沒有送出', posted === 0)
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

/**
 * Meegle 評論：勾了 AI 的話，整批 AI 都結束（成功或失敗）才能送（1008 使用者 Lark 回報、CodeX 定案）。
 * 用真的 Sheet 走 ①→②→③；AI 端點被攔下來由這支腳本控制何時回應；送出端點直接擋掉（不會寫 Meegle）。走區網 IP。
 * 跑法：node scripts/ui-checks/meegle-comment-ai-gate.mjs
 *
 * 驗收（CodeX）：還有列在跑時不能送、最後一列結束後解鎖、有失敗列仍照原本規則送。
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

// 本機區網 IP 會變（10/08 從 .41 變 .36）——可用 UI_HOST 覆寫
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
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))

// AI：每個請求排隊，由腳本決定何時、怎麼回
const pending = []
await page.route('**/api/meegle/comment/ai', route => { pending.push(route) })
const release = async (ok) => {
  for (let i = 0; i < 100 && !pending.length; i++) await page.waitForTimeout(200)
  const r = pending.shift()
  if (!r) return false
  if (ok) await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: '【功能目的】\n1. AI 整理過的內容', review: null }) })
  else await r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, message: '假的 AI 失敗' }) })
  return true
}
// 身分：測試帳號在這個環境本來就不能送（基準是「不可按」），那樣驗不出按鈕是不是被 AI 鎖住的——
// 把身分查詢換成「都可以」，讓 AI 成為唯一的變因（一樣不會真的送出，送出端點下面擋掉）
await page.route('**/api/meegle/comment/identities', async route => {
  const names = JSON.parse(route.request().postData() || '{}').names ?? []
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, self: true, selfEmail: 'eric.wu@toppath.tw', results: names.map(n => ({ name: n, status: 'ok', email: 'eric.wu@toppath.tw', label: n })) }) })
})
// Sheet：這份測試 Sheet 只有一列 Meegle 單，但要驗的情境是「有列完成、有列還在跑」（使用者的 10／56）。
// 把那一列複製成第二列（同一張 Meegle 單，只讀不寫），兩列各自跑 AI
await page.route('**/api/lark/sheets/records', async route => {
  const res = await route.fetch(); const j = await res.json()
  // 同一張單出現兩列會被擋（重複單號），所以複製列改指測試空間另一張單 15194995（一樣只讀不寫）
  const src = j.records.find(r => Object.values(r).some(v => /15273354/.test(String(v)))) ?? j.records[0]
  const copy = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, typeof v === 'string' ? v.split('15273354').join('15194995') : v]))
  j.records = [...j.records, { ...copy, _rowIndex: (src._rowIndex ?? 0) + 1000 }]
  await route.fulfill({ response: res, body: JSON.stringify(j) })
})
// 送出：一律擋掉（這支只驗按鈕，不寫 Meegle）
let posted = 0
const bodies = []
await page.route('**/api/meegle/comment/row', route => { posted++; bodies.push(JSON.parse(route.request().postData() || '{}')); return route.abort() })

await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
await page.getByRole('button', { name: 'Meegle 評論' }).click()
await page.locator('.mc-loadbar .mb-input').fill(SHEET)
await page.getByRole('button', { name: /讀取 Sheet/ }).first().click()
await page.locator('.mb-table tbody tr').first().waitFor({ timeout: 60000 })
// 這份測試 Sheet 只有一列 Meegle 單——用「失敗 → 重試 → 成功」驗：跑著鎖、結束解鎖、失敗也算結束
const boxes = page.locator('.mb-table tbody tr').filter({ has: page.locator('a[href*="/detail/"]') }).locator('input[type=checkbox]')
check('有兩列 Meegle 單（第二列是複製的）', (await boxes.count()) === 2, String(await boxes.count()))
for (let i = 0; i < await boxes.count(); i++) if (!(await boxes.nth(i).isChecked())) await boxes.nth(i).check()
await page.getByRole('button', { name: '下一步' }).click()
await page.locator('.mc-identity').waitFor()
await page.locator('.mb-field').filter({ hasText: '評論內容欄' }).locator('select').selectOption('備註')
const sendBtn = page.getByRole('button', { name: '前往送出' })
const settle = () => page.waitForFunction(() => [...document.querySelectorAll('.mc-dot')].every(d => !/讀取中/.test(d.textContent || '')), null, { timeout: 120000 }).catch(() => {})
// 基準：不勾 AI 時這一列能不能送（測試帳號的身分等既有規則可能本來就擋）——AI 結束後要跟它一樣
await page.getByRole('button', { name: '產生預覽' }).click()
await page.locator('.mc-preview').waitFor(); await settle()
const baseline = await sendBtn.isEnabled()
console.log(`  基準（不勾 AI）：前往送出 ${baseline ? '可按' : '不可按'}｜列狀態 ${(await page.locator('.mc-dot').allInnerTexts()).join(',')}`)
await page.getByRole('button', { name: '上一步' }).click()
await page.locator('.mc-switch', { hasText: 'AI 整理評論內容' }).locator('input').check()
await page.getByRole('button', { name: '產生預覽' }).click()
await page.locator('.mc-preview').waitFor(); await settle()

const foot = async () => (await page.locator('.mb-foot-sum').innerText()).replace(/\s+/g, ' ')
check('兩列 AI 都還沒回 → 不能送', await sendBtn.isDisabled(), await foot())
check('寫出還有 2 列待完成', /AI 尚有 2 列待完成/.test(await foot()), await foot())
check('第一列成功', await release(true))
await page.waitForTimeout(800)
// ★ 使用者回報的情境：已經有列可以送（可送出 1），但還有列在跑——原本這時按鈕可以按、只送完成的那列
check('一列完成（可送出 ≥1）、一列還在跑 → 仍然不能送', /可送出 1 /.test(await foot()) && await sendBtn.isDisabled(), await foot())
check('提示變成 1 列', /AI 尚有 1 列待完成/.test(await foot()), await foot())
await page.screenshot({ path: path.join(root, 'mc-ai-gate-waiting.png') })
check('第二列失敗', await release(false))
await page.waitForTimeout(800)
check('最後一列結束（失敗也算）→ 解鎖、提示消失', await sendBtn.isEnabled() && !/AI 尚有/.test(await foot()), await foot())
check('失敗列照原本規則：兩列都可送出', /可送出 2 /.test(await foot()), await foot())
await page.screenshot({ path: path.join(root, 'mc-ai-gate-done.png') })
check('基準（不勾 AI）可以送——AI 是唯一的變因', baseline === true)
// 1008 只發 Comment：③ 沒有測試說明欄、圖片與影片在 Comment 底下；送出時不覆寫測試說明
check('③ 沒有「測試說明」欄、沒有「覆寫測試頁」開關', (await page.locator('textarea[aria-label="測試說明內容"]').count()) === 0 && (await page.getByText('覆寫測試頁').count()) === 0)
check('③ Comment 欄底下是「圖片與影片」', (await page.locator('.mc-panel', { hasText: 'Comment' }).locator('.mc-sub-head', { hasText: '圖片與影片' }).count()) === 1)
await page.getByRole('button', { name: '前往送出' }).click()
for (let i = 0; i < 50 && !bodies.length; i++) await page.waitForTimeout(200)
check('按送出時帶的是 overwriteDesc:false（不動測試說明）', bodies.length > 0 && bodies.every(b => b.overwriteDesc === false), JSON.stringify(bodies.map(b => b.overwriteDesc)))
check('送出的評論是 AI 整理過的內容', bodies.some(b => /AI 整理過的內容/.test(b.commentText || '')), JSON.stringify(bodies.map(b => (b.commentText || '').slice(0, 30))))
check('送出請求都被擋下（沒寫進 Meegle）', posted === bodies.length)
check('沒有頁面錯誤', errors.length === 0, errors.join(' | '))
await browser.close()
console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)

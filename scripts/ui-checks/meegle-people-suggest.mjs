/**
 * Meegle 開單 ② 人員對照：空間角色人員下拉＋自動猜人＋全部確認（v5.2.0）。
 *
 * 第一段用**真的** roster／suggest（打真 Meegle，只讀），Sheet 與 verify 用 page.route 假掉（不寫對照表）：
 *   1 名字完全相同、名錄唯一（Tim、Albert Tsai）→ 預填 email、綠色建議、算進「全部確認」
 *   2 Eric：名單裡唯一但 Meegle 名錄有兩個 Eric → 預填但黃色、附提示、不算進全部確認
 *   3 Tim Chen：只有第一個詞對到 → 黃色「部分名字相同」、不算進全部確認
 *   4 Nobody：沒建議、格子空白
 *   5 按「全部確認」只送 Tim、Albert Tsai 兩筆 verify，且都帶 userKey
 * 第二段 roster／suggest 也假掉、故意晚回（CodeX 驗收點）：
 *   6 晚回的建議不蓋掉使用者已經手打的 email
 *   7 結果回來前換讀另一份 Sheet → 舊結果整包丟掉
 * 兩種主題各截一張圖。走區網 IP。
 *
 * 跑法：node scripts/ui-checks/meegle-people-suggest.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = '192.168.3.41'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'), { readonly: true })
const sess = db.prepare("SELECT sid FROM auth_sessions WHERE expires_at > ? AND email = 'eric.wu@toppath.tw' ORDER BY created_at DESC LIMIT 1").get(Date.now())
if (!sess) { console.log('沒有綁定 Meegle 帳號的有效登入 session'); process.exit(1) }

const NAMES = ['Tim', 'Eric', 'Albert Tsai', 'Tim Chen', 'Nobody Here']
const records = NAMES.map((n, i) => ({ _rowIndex: i + 2, 摘要: `假單${i}`, 回報者: n }))

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()

async function openStep2(page, mode) {
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE1?sheet=x')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.getByRole('button', { name: '下一步' }).click()
}
const person = (page, alias) => page.locator('.mb-person', { has: page.locator('.mb-person-name', { hasText: new RegExp(`^${alias}$`) }) })

async function baseRoutes(ctx, recs = records) {
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
  await ctx.route('**/api/meegle/batch/meta', r => r.fulfill({ json: { ok: true, requirements: [{ id: '900001', name: '假需求' }], states: [], statesError: null } }))
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: [] } }))
  await ctx.route('**/api/meegle/batch/previous', r => r.fulfill({ json: { ok: true, rows: [] } }))
  await ctx.route('**/api/lark/sheets/records', async r => r.fulfill({ json: { ok: true, records: typeof recs === 'function' ? await recs(r) : recs } }))
}

// ── 第一段：真 roster／suggest ──
for (const mode of ['classic', 'xianxia']) {
  console.log(`[真名單 ${mode}]`)
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await baseRoutes(ctx)
  const verified = []
  await ctx.route('**/api/meegle/batch/people/verify', async r => { verified.push(r.request().postDataJSON()); await r.fulfill({ json: { ok: true, person: {} } }) })
  const page = await ctx.newPage()
  await openStep2(page, mode)
  await page.getByRole('button', { name: /全部確認/ }).waitFor()
  await page.locator('.mb-roster-bar', { hasText: /空間角色人員 \d+ 人|讀不到人員名單/ }).waitFor({ timeout: 90000 })
  const val = async a => person(page, a).locator('input').inputValue()
  check('Tim 預填 tim@toppath.tw、綠色建議', await val('Tim') === 'tim@toppath.tw' && await person(page, 'Tim').locator('.mb-badge--ok').count() === 1)
  check('Albert Tsai 預填、綠色建議', await val('Albert Tsai') === 'albert.tsai@toppath.tw' && await person(page, 'Albert Tsai').locator('.mb-badge--ok').count() === 1)
  check('Eric 預填但黃色＋同名提示', await val('Eric') === 'eric.wu@toppath.tw' && await person(page, 'Eric').locator('.mb-badge--warn').count() === 1 && /2 個叫「Eric」/.test(await person(page, 'Eric').innerText()))
  check('Tim Chen 黃色「部分名字相同」', /部分名字相同/.test(await person(page, 'Tim Chen').innerText()) && await person(page, 'Tim Chen').locator('.mb-badge--ok').count() === 0)
  check('Nobody Here 沒建議、空白', await val('Nobody Here') === '' && await person(page, 'Nobody Here').locator('.mb-badge').count() === 0)
  const btn = page.getByRole('button', { name: /全部確認/ })
  check('全部確認只算 2 筆', /全部確認（2）/.test(await btn.innerText()), await btn.innerText())
  await page.screenshot({ path: path.join(root, `meegle-people-suggest-${mode}.png`), fullPage: true })
  await btn.click()
  await page.waitForTimeout(1500)
  const sent = verified.map(v => v.alias).sort()
  check('全部確認只送 Tim、Albert Tsai', JSON.stringify(sent) === JSON.stringify(['Albert Tsai', 'Tim']), JSON.stringify(sent))
  check('送出時都帶 userKey（後端重新核對）', verified.length > 0 && verified.every(v => /^\d+$/.test(v.userKey ?? '')))
  await ctx.close()
}

// ── 第二段：晚回保護（roster／suggest 假的、故意延遲）──
{
  console.log('[晚回保護]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  let sheetNo = 0
  await baseRoutes(ctx, () => { sheetNo++; return sheetNo === 1 ? records : [{ _rowIndex: 2, 摘要: '另一份', 回報者: 'Albert Tsai' }] })
  const tim = { userKey: '1', email: 'tim@toppath.tw', name: 'Tim', names: ['Tim'] }
  const albert = { userKey: '2', email: 'albert.tsai@toppath.tw', name: 'Albert Tsai', names: ['Albert Tsai'] }
  const albertOk = albert
  let delay = 2500
  await ctx.route('**/api/meegle/batch/people/roster', async r => { await new Promise(res => setTimeout(res, delay)); await r.fulfill({ json: { ok: true, users: [tim, albert], fetchedAt: Date.now() } }) })
  // 換 Sheet 前按「重新整理名單」的那次：suggest 故意晚 4 秒回、而且回假的舊 email，用來認出「舊結果有沒有被套上去」
  let suggestNo = 0, staleMode = false, staleSent = false
  const staleAlbert = { ...albert, email: 'STALE@toppath.tw' }
  await ctx.route('**/api/meegle/batch/people/suggest', async r => {
    const { aliases } = r.request().postDataJSON()
    suggestNo++
    const stale = staleMode && aliases.includes('Tim')   // 舊 Sheet 的名字清單才有 Tim
    if (stale) { await new Promise(res => setTimeout(res, 4000)); staleSent = true }
    const albert = stale ? staleAlbert : albertOk
    await r.fulfill({ json: { ok: true, suggestions: aliases.map(a => a === 'Tim' ? { alias: a, status: 'unique', confidence: 'exact', user: tim, bulkOk: true, note: '' } : a === 'Albert Tsai' ? { alias: a, status: 'unique', confidence: 'exact', user: albert, bulkOk: true, note: '' } : { alias: a, status: 'none', bulkOk: false, note: '' }) } })
  })
  const page = await ctx.newPage()
  await openStep2(page, 'classic')
  await person(page, 'Tim').locator('input').fill('manual@toppath.tw')
  // 等建議真的套上（Albert 那列出現建議）才斷言，不然「沒被蓋掉」只是因為還沒回來
  await person(page, 'Albert Tsai').locator('.mb-badge').waitFor({ timeout: 10000 })
  check('Tim 那列也收到建議（才能證明是「沒蓋掉」而不是「還沒回來」）', await person(page, 'Tim').locator('.mb-badge').count() === 1)
  check('晚回的建議不蓋掉手打的 email', await person(page, 'Tim').locator('input').inputValue() === 'manual@toppath.tw')
  check('沒手打的格子照樣預填（Albert Tsai）', await person(page, 'Albert Tsai').locator('input').inputValue() === 'albert.tsai@toppath.tw')
  check('手打過的列不算進全部確認', /全部確認（1）/.test(await page.getByRole('button', { name: /全部確認/ }).innerText()))

  // 換 Sheet：回 ①、讀另一份，舊的（延遲中的）結果不能套到新 Sheet
  delay = 0; staleMode = true
  await page.getByRole('button', { name: '重新整理名單' }).click()
  await page.waitForTimeout(300)   // 讓舊請求先送到 suggest、卡在延遲裡
  await page.getByRole('button', { name: '上一步' }).click()
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE2?sheet=y')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  // 等到舊的延遲請求（4 秒）一定已經回來
  await page.waitForTimeout(6000)
  const names = await page.locator('.mb-person-name').allInnerTexts()
  check('換 Sheet 後只剩新 Sheet 的名字', JSON.stringify(names) === JSON.stringify(['Albert Tsai']), JSON.stringify(names))
  check('舊 Sheet 晚回的建議沒有套到新 Sheet', staleSent && suggestNo >= 3 && !/STALE/.test(await person(page, 'Albert Tsai').innerText()), `suggest 次數 ${suggestNo}／${await person(page, 'Albert Tsai').innerText()}`)
  await ctx.close()
}

// ── 第三段：CodeX review 的兩個時序（假 roster／suggest、verify 故意慢）──
async function fakeSuggest(ctx, { suggestDelay = 0 } = {}) {
  const mk = (k, n, e) => ({ userKey: k, email: e, name: n, names: [n] })
  const users = { Tim: mk('1', 'Tim', 'tim@toppath.tw'), 'Albert Tsai': mk('2', 'Albert Tsai', 'albert.tsai@toppath.tw'), Eric: mk('3', 'Eric', 'eric.wu@toppath.tw') }
  await ctx.route('**/api/meegle/batch/people/roster', r => r.fulfill({ json: { ok: true, users: Object.values(users), fetchedAt: Date.now() } }))
  await ctx.route('**/api/meegle/batch/people/suggest', async r => {
    const { aliases } = r.request().postDataJSON()
    if (suggestDelay) await new Promise(res => setTimeout(res, suggestDelay))
    await r.fulfill({ json: { ok: true, suggestions: aliases.map(a => users[a] ? { alias: a, status: 'unique', confidence: 'exact', user: users[a], bulkOk: true, note: '' } : { alias: a, status: 'none', bulkOk: false, note: '' }) } })
  })
}
{
  console.log('[打完又清空，建議才回來]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await baseRoutes(ctx)
  await fakeSuggest(ctx, { suggestDelay: 2500 })
  const page = await ctx.newPage()
  await openStep2(page, 'classic')
  const box = person(page, 'Tim').locator('input')
  await box.fill('x@toppath.tw'); await box.fill('')
  await person(page, 'Albert Tsai').locator('.mb-badge').waitFor({ timeout: 10000 })
  check('建議已回來（Tim 有建議標籤）', await person(page, 'Tim').locator('.mb-badge').count() === 1)
  check('清空過的格子不被建議填回', await box.inputValue() === '')
  check('清空過的列不進全部確認（只剩 Albert、Eric）', /全部確認（2）/.test(await page.getByRole('button', { name: /全部確認/ }).innerText()), await page.getByRole('button', { name: /全部確認/ }).innerText())
  await ctx.close()
}
{
  console.log('[全部確認途中改第二筆／verify 晚回不收掉新編輯]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await baseRoutes(ctx)
  await fakeSuggest(ctx)
  const sent = []
  let mapped = []
  await ctx.unroute('**/api/meegle/batch/people')
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: mapped } }))
  await ctx.route('**/api/meegle/batch/people/verify', async r => {
    const b = r.request().postDataJSON(); sent.push(`${b.alias}=${b.email}`)
    await new Promise(res => setTimeout(res, 2000))
    mapped = [...mapped, { alias: b.alias.toLowerCase(), userKey: b.userKey ?? '9', email: b.email, name: b.alias }]
    await r.fulfill({ json: { ok: true, person: {} } })
  })
  const page = await ctx.newPage()
  await openStep2(page, 'classic')
  await person(page, 'Albert Tsai').locator('.mb-badge').waitFor({ timeout: 10000 })
  // 名字排序：影響列數相同 → 依 aliasRows 順序；先記下全部確認會送哪三筆
  await page.getByRole('button', { name: /全部確認（3）/ }).click()
  await page.waitForTimeout(300)
  const first = sent[0]?.split('=')[0]
  const others = ['Tim', 'Albert Tsai', 'Eric'].filter(a => a !== first)
  // 第一筆還在等的時候：改第二筆、也改第一筆（verify 晚回不能收掉這個新編輯）
  await person(page, others[0]).locator('input').fill('changed@toppath.tw')
  await person(page, first).locator('input').fill('edited-after@toppath.tw')
  await page.waitForTimeout(6500)
  check('改過的那筆沒有用舊 email 送出', !sent.some(s => s.startsWith(`${others[0]}=`)), JSON.stringify(sent))
  check('沒改的照樣送出', sent.some(s => s.startsWith(`${others[1]}=`)), JSON.stringify(sent))
  const firstRow = person(page, first)
  check('第一筆 verify 晚回後，編輯框仍在、保留新打的 email', await firstRow.locator('input').count() === 1 && await firstRow.locator('input').inputValue() === 'edited-after@toppath.tw')
  await ctx.close()
}
{
  console.log('[A 驗完、B 還在等時改 A → A 不能被藏到已對照]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await baseRoutes(ctx)
  await fakeSuggest(ctx)
  const sent = []
  let mapped = []
  await ctx.unroute('**/api/meegle/batch/people')
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: mapped } }))
  await ctx.route('**/api/meegle/batch/people/verify', async r => {
    const b = r.request().postDataJSON(); sent.push(b.alias)
    await new Promise(res => setTimeout(res, 2000))
    mapped = [...mapped, { alias: b.alias.toLowerCase(), userKey: b.userKey ?? '9', email: b.email, name: b.alias }]
    await r.fulfill({ json: { ok: true, person: {} } })
  })
  const page = await ctx.newPage()
  await openStep2(page, 'classic')
  await person(page, 'Albert Tsai').locator('.mb-badge').waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: /全部確認（3）/ }).click()
  // 等第一筆回完、第二筆送出（還在等）
  for (let i = 0; i < 50 && sent.length < 2; i++) await page.waitForTimeout(100)
  const a = sent[0]
  await person(page, a).locator('input').fill('after-done@toppath.tw')
  await page.waitForTimeout(6000)
  const row = person(page, a)
  check('A 留在未對照、輸入框還在、保留新 email', await row.count() === 1 && await row.locator('input').inputValue() === 'after-done@toppath.tw', a)
  check('A 標示「新填的還沒驗證」', /還沒驗證/.test(await row.innerText()))
  await ctx.close()
}
{
  console.log('[全部確認途中換 Sheet（新 Sheet 讀得很慢）→ 一開始讀就整批停]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  let sheetNo = 0
  // 新 Sheet 故意 8 秒才回：作廢若等到讀完才做，這段時間舊批次會繼續送第二、三筆
  await baseRoutes(ctx, async () => { sheetNo++; if (sheetNo === 1) return records; await new Promise(res => setTimeout(res, 8000)); return [{ _rowIndex: 2, 摘要: '另一份', 回報者: 'Dave' }] })
  await fakeSuggest(ctx)
  const sent = []
  await ctx.route('**/api/meegle/batch/people/verify', async r => { sent.push(r.request().postDataJSON().alias); await new Promise(res => setTimeout(res, 2000)); await r.fulfill({ json: { ok: true, person: {} } }) })
  const page = await ctx.newPage()
  await openStep2(page, 'classic')
  await person(page, 'Albert Tsai').locator('.mb-badge').waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: /全部確認（3）/ }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '上一步' }).click()
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE2?sheet=y')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.waitForTimeout(6000)
  check('新 Sheet 還沒回來時全部確認就停了（只送了第一筆）', sent.length === 1, JSON.stringify(sent))
  await ctx.close()
}

await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

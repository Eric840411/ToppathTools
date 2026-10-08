/**
 * Meegle 開單：不用逐一綁定人員，對得上就自動帶（1009 使用者 Lark 要求、CodeX 定案）。
 *
 * 第一段用**真的** roster／suggest（打真 Meegle，只讀）；Sheet、對照表、verify、送出都 page.route 假掉（不寫對照表、不開單）：
 *   1 讀完直接進 ③（不經過 ② 人員對照）
 *   2 只自動 verify「完整名字＋名單唯一＋租戶名錄唯一」的人（Tim、Albert Tsai），而且帶 userKey
 *   3 Eric：名單裡唯一、但租戶名錄有兩個 Eric（CodeX 指定案例）→ 不自動帶
 *   4 Tim Chen（只有部分名字相同）、Nobody Here（對不上）→ 不自動帶
 *   5 ③ 標出「對不上，不帶」；送出前（測試空間）跳提醒、列出那幾列；按取消不送
 * 第二段 roster／suggest 假掉、故意晚回（CodeX 指定案例）：
 *   6 結果回來前切空間 → 舊實例晚回的結果不能再 verify（不寫進對照表）
 * 走區網 IP。跑法：node scripts/ui-checks/meegle-people-auto.mjs
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
if (!sess) { console.log('沒有綁定 Meegle 帳號的有效登入 session'); process.exit(1) }

const NAMES = ['Tim', 'Eric', 'Albert Tsai', 'Tim Chen', 'Nobody Here']
const records = NAMES.map((n, i) => ({ _rowIndex: i + 2, 摘要: `假單${i}`, 回報者: n }))

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()

async function base(ctx) {
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
  await ctx.route('**/api/meegle/batch/meta*', r => r.fulfill({ json: { ok: true, requirements: [{ id: '900001', name: '假需求' }], states: [], statesError: null } }))
  await ctx.route('**/api/meegle/batch/previous', r => r.fulfill({ json: { ok: true, rows: [] } }))
  await ctx.route('**/api/lark/sheets/records', r => r.fulfill({ json: { ok: true, records } }))
  // 對照表：一開始是空的；verify 過的照真的流程記進來
  const map = []
  const verified = []
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: map } }))
  await ctx.route('**/api/meegle/batch/people/verify', async r => {
    const b = r.request().postDataJSON(); verified.push(b)
    map.push({ alias: b.alias.trim().toLowerCase(), userKey: b.userKey || 'x', email: b.email, name: b.alias })
    await r.fulfill({ json: { ok: true, person: {} } })
  })
  const posted = []
  await ctx.route('**/api/meegle/batch/row', r => { posted.push(r.request().postDataJSON()); return r.abort() })
  return { verified, posted }
}
async function openCreate(page) {
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE1?sheet=x')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.getByRole('button', { name: '下一步' }).click()
}

// ── 第一段：真 roster／suggest ──
{
  console.log('[真名單]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const { verified, posted } = await base(ctx)
  const page = await ctx.newPage()
  await openCreate(page)
  check('讀完直接進 ③（沒有停在 ② 人員對照）', await page.getByRole('button', { name: /批量設定/ }).isVisible())
  // 等自動猜人＋自動 verify 跑完（真 Meegle 約 20 秒）
  for (let i = 0; i < 120 && verified.length < 2; i++) await page.waitForTimeout(500)
  await page.waitForTimeout(3000)
  const auto = verified.map(v => v.alias).sort()
  check('只自動 verify Tim、Albert Tsai', JSON.stringify(auto) === JSON.stringify(['Albert Tsai', 'Tim']), JSON.stringify(auto))
  check('自動 verify 都帶 userKey（伺服器重新核對）', verified.length > 0 && verified.every(v => /^\d+$/.test(v.userKey ?? '')))
  check('Eric（名單唯一、但租戶有兩個 Eric）不自動帶', !verified.some(v => v.alias === 'Eric'))
  check('Tim Chen（部分名字）、Nobody Here 不自動帶', !verified.some(v => v.alias === 'Tim Chen' || v.alias === 'Nobody Here'))

  await page.getByRole('button', { name: /批量設定/ }).click()
  await page.locator('select:has(option[value="900001"])').first().selectOption('900001')
  const opts = await page.locator('#mb-people-options option').count()
  check('③ 人員下拉＝空間人員（值是 email）', opts > 5 && /@/.test(await page.locator('#mb-people-options option').first().getAttribute('value') ?? ''), String(opts))
  check('③ 寫明「不是完整名錄」', (await page.getByText(/不是完整名錄/).count()) > 0)
  await page.getByRole('button', { name: '套用到已勾選的列' }).click()
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check('③ 對不上的人標「對不上，不帶」', /Eric 對不上，不帶/.test(body) && /Nobody Here 對不上，不帶/.test(body))
  await page.screenshot({ path: path.join(root, 'meegle-people-auto.png'), fullPage: false })
  const send = page.getByRole('button', { name: /^送出 \d+ 列$/ })
  await send.click()
  const dlg = page.getByRole('dialog')
  await dlg.waitFor({ timeout: 5000 }).catch(() => {})
  const dtxt = (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('送出前跳提醒（測試空間也跳）、列出對不上的列', /有 3 列有人員對不上/.test(dtxt) && /Eric/.test(dtxt) && /Tim Chen/.test(dtxt) && /Nobody Here/.test(dtxt), dtxt.slice(0, 200))
  await page.screenshot({ path: path.join(root, 'meegle-people-auto-confirm.png') })
  await dlg.getByRole('button', { name: '取消' }).click().catch(() => {})
  await page.waitForTimeout(500)
  check('按取消 → 沒有送出', posted.length === 0)
  await ctx.close()
}

// ── 第二段：切空間後，舊請求才回來 ──
{
  console.log('[切空間後舊結果晚回]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const { verified } = await base(ctx)
  const held = []
  await ctx.route('**/api/meegle/batch/people/roster', r => { held.push(r) })
  await ctx.route('**/api/meegle/batch/people/suggest', r => r.fulfill({ json: { ok: true, suggestions: [{ alias: 'Tim', status: 'unique', confidence: 'exact', user: { userKey: '2', email: 'tim@toppath.tw', name: 'Tim', names: ['Tim'] }, bulkOk: true, note: '' }] } }))
  const page = await ctx.newPage()
  await openCreate(page)
  for (let i = 0; i < 40 && !held.length; i++) await page.waitForTimeout(200)
  check('名單請求送出了、還沒回', held.length >= 1)
  // 切到正式空間（分頁重新掛載）——之後才讓舊的名單回來
  await page.locator('.msp-seg-btn', { hasText: '正式' }).first().click()
  await page.waitForTimeout(800)
  for (const r of held.splice(0)) await r.fulfill({ json: { ok: true, users: [{ userKey: '2', email: 'tim@toppath.tw', name: 'Tim', names: ['Tim'] }], fetchedAt: Date.now() } }).catch(() => {})
  await page.waitForTimeout(3000)
  check('舊空間晚回的結果沒有拿去 verify（不寫進對照表）', verified.length === 0, JSON.stringify(verified.map(v => v.alias)))
  await ctx.close()
}

// ── 第三段：verify 晚回時不能送（CodeX 審 9961c04 [P2]）──
{
  console.log('[verify 晚回：比對完成前不能送]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const { posted } = await base(ctx)
  // 覆寫 verify：故意晚 4 秒才回（比照確認框開著時才回來的情況）
  const verified = []
  await ctx.unroute('**/api/meegle/batch/people/verify')
  const map2 = []
  await ctx.unroute('**/api/meegle/batch/people')
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: map2 } }))
  await ctx.route('**/api/meegle/batch/people/verify', async r => {
    const b = r.request().postDataJSON(); verified.push(b)
    await new Promise(res => setTimeout(res, 4000))
    map2.push({ alias: b.alias.trim().toLowerCase(), userKey: b.userKey, email: b.email, name: b.alias })
    await r.fulfill({ json: { ok: true, person: {} } })
  })
  const tim = { userKey: '2', email: 'tim@toppath.tw', name: 'Tim', names: ['Tim'] }
  await ctx.route('**/api/meegle/batch/people/roster', r => r.fulfill({ json: { ok: true, users: [tim], fetchedAt: Date.now() } }))
  await ctx.route('**/api/meegle/batch/people/suggest', r => {
    const { aliases } = r.request().postDataJSON()
    return r.fulfill({ json: { ok: true, suggestions: aliases.map(a => a === 'Tim' ? { alias: a, status: 'unique', confidence: 'exact', user: tim, bulkOk: true, note: '' } : { alias: a, status: 'none', bulkOk: false, note: '' }) } })
  })
  const page = await ctx.newPage()
  await openCreate(page)
  await page.getByRole('button', { name: /批量設定/ }).click()
  await page.locator('select:has(option[value="900001"])').first().selectOption('900001')
  await page.getByRole('button', { name: '套用到已勾選的列' }).click()
  for (let i = 0; i < 40 && !verified.length; i++) await page.waitForTimeout(100)
  const send = page.getByRole('button', { name: /^送出 \d+ 列$/ })
  const foot = async () => (await page.locator('.mb-foot-sum').innerText()).replace(/\s+/g, ' ')
  check('verify 還沒回 → 送出鍵鎖住、寫「人員比對中」', verified.length === 1 && await send.isDisabled() && /人員比對中/.test(await foot()), await foot())
  await page.waitForTimeout(5000)
  check('verify 回來 → 解鎖', await send.isEnabled(), await foot())
  await send.click()
  const dlg = page.getByRole('dialog')
  await dlg.waitFor({ timeout: 5000 }).catch(() => {})
  const dtxt = (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('確認框用的是比對完成後的結果（Tim 已帶入，不在對不上清單；其他 4 列在）', !/Tim——/.test(dtxt.replace('Tim Chen', '')) && /有 4 列有人員對不上/.test(dtxt), dtxt.slice(0, 160))
  await dlg.getByRole('button', { name: '取消' }).click().catch(() => {})
  check('沒有真的送出', posted.length === 0)
  await ctx.close()
}

// ── 第四段：② 手動驗證晚回 → 切到 ③ 送出仍鎖住（CodeX 審 d712df8 [P2]）──
{
  console.log('[② 手動驗證晚回 → ③ 仍鎖住]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const { posted } = await base(ctx)
  const verified = []
  await ctx.unroute('**/api/meegle/batch/people/verify')
  await ctx.route('**/api/meegle/batch/people/verify', async r => { verified.push(r.request().postDataJSON()); await new Promise(res => setTimeout(res, 4000)); await r.fulfill({ json: { ok: true, person: {} } }) })
  // 不自動帶任何人（建議都對不上），只測手動驗證
  await ctx.route('**/api/meegle/batch/people/roster', r => r.fulfill({ json: { ok: true, users: [], fetchedAt: Date.now() } }))
  await ctx.route('**/api/meegle/batch/people/suggest', r => r.fulfill({ json: { ok: true, suggestions: [] } }))
  const page = await ctx.newPage()
  await openCreate(page)
  await page.getByRole('button', { name: /批量設定/ }).click()
  await page.locator('select:has(option[value="900001"])').first().selectOption('900001')
  await page.getByRole('button', { name: '套用到已勾選的列' }).click()
  const send = page.getByRole('button', { name: /^送出 \d+ 列$/ })
  await page.waitForTimeout(500)
  check('一開始（沒有在比對）送出鍵可以按', await send.isEnabled())
  await page.locator('.mb-step', { hasText: '人員對照' }).click()
  const row = page.locator('.mb-person', { has: page.locator('.mb-person-name', { hasText: /^Eric$/ }) })
  await row.locator('input').fill('eric.wu@toppath.tw')
  await row.getByRole('button', { name: '驗證' }).click()
  await page.waitForTimeout(300)
  await page.locator('.mb-step', { hasText: '預覽與勾選' }).click()
  await page.waitForTimeout(300)
  check('② 驗證還沒回、切到 ③ → 送出鍵鎖住、寫「人員比對中」', verified.length === 1 && await send.isDisabled() && /人員比對中/.test(await page.locator('.mb-foot-sum').innerText()), await page.locator('.mb-foot-sum').innerText())
  await page.waitForTimeout(5000)
  check('驗證回來（含重讀對照表）→ 解鎖', await send.isEnabled())
  check('沒有真的送出', posted.length === 0)
  await ctx.close()
}

await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

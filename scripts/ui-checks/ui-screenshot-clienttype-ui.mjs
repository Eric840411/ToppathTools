/**
 * 驗：**畫面上點的那個客戶端，真的會出現在送出去的 request body 裡。**
 *
 * 為什麼要有這支：`ui-screenshot-clienttype-dispatch.mjs` 驗的是
 * 「API → 中控 → agent」那一段——它直接用 fetch 打 API，**完全沒碰到畫面**。
 * CodeX 2026-09-21 指出這個界線：那支不能叫端到端，因為
 * 「畫面操作 → request」這一段還沒有人驗。這支補的就是那一段。
 *
 * 做法：用真的瀏覽器開真的產品頁，點真的「客戶端」按鈕與「掃描大廳」按鈕，
 * 攔截送出去的 `POST /api/ui-screenshot/scan-lobby`，看 body 裡的 `clientType`。
 *
 * ⚠️ 攔截之後直接回一個假的成功回應——**這支不該真的去掃大廳**，
 *    它要驗的是「送出去的東西對不對」，不是掃描結果。
 * ⚠️ `/agents` 也回假的：只是為了讓「掃描大廳」按鈕不是 disabled。
 *    agent 清單不是這支在驗的東西，拿假的當腳手架沒問題。
 *
 * 用法：node scripts/ui-checks/ui-screenshot-clienttype-ui.mjs [baseUrl]
 */
import { chromium } from 'playwright'

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')
const FAKE_AGENT = {
  agentId: 'ui-check-agent', hostname: 'ui-check-agent', ownerName: 'ui-check',
  capabilities: ['ui-screenshot'], busy: false, connectedAt: Date.now(), lastSeenAt: Date.now(),
}

const failures = []
function check(name, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(actual)}${ok ? '' : ` (預期 ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
const page = await ctx.newPage()

/** 最近一次攔到的 scan-lobby request body */
let lastBody = null
await page.route('**/api/ui-screenshot/agents', route =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [FAKE_AGENT] }) }))
await page.route('**/api/ui-screenshot/scan-lobby', route => {
  try { lastBody = JSON.parse(route.request().postData() ?? '{}') } catch { lastBody = null }
  // 回一個空結果就好——這支不驗掃描本身
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cardCount: 0, models: [], unparsed: [] }) })
})

/**
 * 側欄導到「UI 解析度截圖」。
 * ⚠️ 這頁不是網址路由、是 SPA 的分頁狀態——**reload 之後會回到總覽，要再導一次**。
 *    （少了這步，reload 那兩條會以「找不到控制項」逾時收場，看起來像控制項壞了。）
 */
async function gotoUiScreenshotTab() {
  const grp = page.getByText('OSM Tools', { exact: true }).first()
  if (await grp.count()) { await grp.click(); await page.waitForTimeout(1200) }
  await page.getByText('UI 解析度截圖').first().click({ force: true })
  await page.waitForTimeout(2500)
}

/** 點「掃描大廳」並等到 request 被攔到 */
async function scanAndCapture(label) {
  lastBody = null
  await page.getByRole('button', { name: '掃描大廳' }).click()
  for (let i = 0; i < 60 && lastBody === null; i++) await page.waitForTimeout(100)
  if (lastBody === null) throw new Error(`${label}：按了掃描大廳但沒攔到 request`)
  return lastBody
}

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(1500)

  // 登入（挑沒上鎖的帳號）
  const acct = page.getByText('lusa@toppath.tw', { exact: true }).first()
  if (await acct.count()) { await acct.click(); await page.waitForTimeout(2500) }

  await gotoUiScreenshotTab()

  const seg = page.locator('.ui-ss-client-seg')
  if (!await seg.count()) throw new Error('找不到「客戶端」選項——畫面沒載出來或控制項不見了')

  // 選執行裝置（不選的話掃描按鈕是 disabled）
  await page.locator('select').first().selectOption(FAKE_AGENT.agentId).catch(() => {})
  await page.waitForTimeout(400)

  const opts = page.locator('.ui-ss-client-opt')
  check('預設狀態｜畫面上選中的是 H5', await opts.nth(0).getAttribute('aria-pressed'), 'true')

  // ── 1. 預設 H5（網址是預設那條，帶著 platform=pc）────────────────────────
  //    這正是原本那個 bug 的形狀：網址說 pc，但使用者要的是 h5
  check('畫面→request｜預設 H5（網址含 platform=pc）', (await scanAndCapture('H5')).clientType, 'h5')

  // ── 2. 點 PC ─────────────────────────────────────────────────────────────
  await opts.nth(1).click()
  await page.waitForTimeout(400)
  check('畫面→request｜點了 PC', (await scanAndCapture('PC')).clientType, 'pc')

  // ── 3. 點回 H5：確認不是只有「第一次送的值」對 ────────────────────────────
  await opts.nth(0).click()
  await page.waitForTimeout(400)
  check('畫面→request｜再點回 H5', (await scanAndCapture('H5 again')).clientType, 'h5')

  // ── 4. 重新載入頁面後仍是剛才選的（設定有存起來）──────────────────────────
  await opts.nth(1).click()
  await page.waitForTimeout(600)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await gotoUiScreenshotTab()
  await page.locator('select').first().selectOption(FAKE_AGENT.agentId).catch(() => {})
  await page.waitForTimeout(400)
  check('重新載入後｜畫面上仍選中 PC', await page.locator('.ui-ss-client-opt').nth(1).getAttribute('aria-pressed'), 'true')
  check('重新載入後｜送出去的仍是 pc', (await scanAndCapture('after reload')).clientType, 'pc')
} catch (err) {
  console.log(`FAIL  執行中斷：${err.message}`)
  failures.push(`執行中斷：${err.message}`)
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.log(`不通過——${failures.length} 條沒過：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('通過——畫面上點的客戶端，就是 request body 裡送出去的那個（6 條）')
console.log('⚠️ 這支只驗「畫面 → request」；request 之後的路由由 ui-screenshot-clienttype-dispatch.mjs 顧')

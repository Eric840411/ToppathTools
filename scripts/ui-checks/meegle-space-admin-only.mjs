/**
 * Meegle 測試空間只給管理員（v5.12.6）。meta API 假掉，只驗前端：
 *   1 非管理員：沒有空間切換、即使 localStorage 存著 test 也一律用 prod 讀
 *   2 管理員：有切換、照記住的空間
 *   3 停留在頁面上時被降權（/api/auth/me 回非管理員）→ 視窗回到前景後：切換消失、改用 prod 重讀、補回填清單重掛（CodeX review 1288024 [P2]）
 * 跑法：node scripts/ui-checks/meegle-space-admin-only.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'

const HOST = '192.168.3.41'
const db = new Database('server/data.db')
const admin = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
const other = db.prepare("SELECT s.sid, s.email FROM auth_sessions s JOIN jira_accounts a ON a.email = s.email WHERE a.role NOT LIKE '%admin%' AND s.expires_at>? ORDER BY s.created_at DESC").get(Date.now())
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()
for (const [who, sid] of [['非管理員', other.sid], ['管理員', admin.sid]]) {
  console.log(`[${who}]`)
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  // 之前選過測試空間（舊 localStorage）
  await ctx.addInitScript(() => { localStorage.setItem('meegle-tools-space-create', 'test'); localStorage.setItem('meegle-tools-space-last', 'test'); localStorage.setItem('meegle-tools-tab', 'create') })
  const metaSpaces = []
  await ctx.route('**/api/meegle/batch/meta*', r => { metaSpaces.push(new URL(r.request().url()).searchParams.get('space')); return r.fulfill({ json: { ok: true, requirements: [], states: [], statesError: null } }) })
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: [] } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.locator('.sidebar, nav, aside').getByText(/Meegle 批量工具|卷宗管理/).first().click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  await page.waitForTimeout(800)
  if (who === '非管理員') {
    check('沒有空間切換', await page.locator('.msp-bar').count() === 0)
    check('舊的 test 不理會，一律用 prod 讀', metaSpaces.length > 0 && metaSpaces.every(s => s === 'prod'), JSON.stringify(metaSpaces))
  } else {
    check('有空間切換', await page.locator('.msp-bar').count() === 1)
    check('照記住的測試空間讀', metaSpaces.at(-1) === 'test', JSON.stringify(metaSpaces))
  }
  await ctx.close()
}
// 3 停留頁面時降權
{
  console.log('[停留頁面時降權]')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: admin.sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(() => { localStorage.setItem('meegle-tools-space-create', 'test'); localStorage.setItem('meegle-tools-space-last', 'test'); localStorage.setItem('meegle-tools-tab', 'create') })
  let demoted = false
  await ctx.route('**/api/auth/me', async r => {
    const res = await r.fetch(); const j = await res.json()
    if (demoted && j.account) j.account.role = 'qa'
    await r.fulfill({ json: j })
  })
  const metaSpaces = []
  await ctx.route('**/api/meegle/batch/meta*', r => { metaSpaces.push(new URL(r.request().url()).searchParams.get('space')); return r.fulfill({ json: { ok: true, requirements: [], states: [], statesError: null } }) })
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: [] } }))
  let pendingCalls = 0
  await ctx.route('**/api/meegle/backfill/pending**', r => { pendingCalls++; return r.fulfill({ json: { ok: true, scope: 'mine', canSeeAll: !demoted, items: [] } }) })
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.locator('.sidebar, nav, aside').getByText(/Meegle 批量工具|卷宗管理/).first().click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  await page.waitForTimeout(800)
  check('降權前：有切換、用 test', await page.locator('.msp-bar').count() === 1 && metaSpaces.at(-1) === 'test', JSON.stringify(metaSpaces))
  demoted = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(1500)
  check('降權後（回到前景）：切換消失', await page.locator('.msp-bar').count() === 0)
  check('降權後：分頁重掛、改用 prod 重讀', metaSpaces.at(-1) === 'prod', JSON.stringify(metaSpaces))
  await page.getByRole('button', { name: 'Meegle 補回填' }).click()
  await page.waitForTimeout(600)
  const before = pendingCalls
  demoted = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))   // 再升回管理員 → 補回填要重掛重讀
  await page.waitForTimeout(1500)
  check('身分再變：補回填清單重掛重讀（不會留著上一個身分讀到的清單）', pendingCalls > before, `${before}→${pendingCalls}`)
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

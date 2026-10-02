/**
 * UI 截圖「選擇 model」視窗：每個 Machine Model 可以單獨展開（v4.268.0），不用先展開遊戲（v4.269.0）。
 *
 * 真掃描要 agent 進真大廳，這裡用 page.route 假 agents 與 scan-lobby 回應，只驗前端互動：
 *   1 一打開，每個遊戲底下的 Machine Model 就列出來（不用先展開遊戲），gmid 預設不顯示
 *   2 點 ▸ 只展開那一個 Machine Model 的 gmid，另一個仍收合
 *   3 點 Machine Model 名稱也能展開／收合
 *   4 有多個 Machine Model 的遊戲：子列有勾，不展開也能直接勾
 *   5 只有一個 Machine Model 的遊戲：子列沒有勾，主列的勾就會選到它
 *   6「全部展開」會打開所有 gmid
 * 兩種主題各截一張圖。
 *
 * 跑法：node scripts/ui-checks/ui-screenshot-mm-expand.mjs（本機 server 在 3000）
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const wl = [
  { gmid: '4182-WLZBHELIX-2133', occupied: false },
  { gmid: '4182-WLZBHELIX-2134', occupied: true },
  { gmid: '4182-WLZBHELIX-2203', occupied: false },
  { gmid: '4182-WLZBHELIX-2136', occupied: false },
]
const bz = [
  { gmid: '4175-BZZF-0017', occupied: true },
  { gmid: '4175-BZZF-0151', occupied: false },
]
const scan = {
  ok: true, cardCount: 6, features: ['ui-ss-pool'], osmSyncedAt: Date.now(), unparsed: [],
  models: [
    {
      key: 'WLZBHELIX', game: 'WLZBHELIX', model: 'WLZBHELIX', total: 4, free: 3, machines: wl,
      machineModels: [
        { machineType: 'wlzbhelix9', machines: wl.slice(0, 3), total: 3, free: 2 },
        { machineType: 'wlzbhelix5', machines: wl.slice(3), total: 1, free: 1 },
      ],
    },
    {
      key: 'BZZF::Purple Celebration', game: 'BZZF', model: 'Purple Celebration', total: 2, free: 1, machines: bz,
      machineModels: [{ machineType: 'bzzf1', machines: bz, total: 2, free: 1 }],
    },
  ],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }])
await ctx.route('**/api/ui-screenshot/agents', r => r.fulfill({ json: { ok: true, agents: [{ agentId: 'fake', hostname: 'fake', ownerName: 'fake', capabilities: ['ui-screenshot', 'ui-ss-pool'], busy: false, connectedAt: Date.now(), lastSeenAt: Date.now() }] } }))
await ctx.route('**/api/ui-screenshot/scan-lobby', r => r.fulfill({ json: scan }))
const page = await ctx.newPage()

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }

for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' })
  await page.evaluate(m => {
    localStorage.setItem('toppath-theme-mode', m)
    const k = 'toppath.uiScreenshot.settings'
    const s = JSON.parse(localStorage.getItem(k) || '{}')
    localStorage.setItem(k, JSON.stringify({ ...s, autoPickByGame: true, gameUrlTemplate: s.gameUrlTemplate || 'https://example.com/?gmid={gmid}' }))
  }, mode)
  await page.reload({ waitUntil: 'networkidle' })
  // 側欄標籤依主題（與帳號同步的偏好）可能是普通版或修仙版的名字，兩個都試
  await page.getByText(/^(OSM Tools|靈機巡檢)$/).first().click()
  await page.getByText(/解析度截圖|萬象顯影/).first().click()
  await page.getByRole('button', { name: '掃描大廳' }).click()
  await page.getByRole('button', { name: /選擇 model/ }).click()

  const mm = page.locator('.ui-ss-mm').nth(0)
  const items = mm.locator('.ui-ss-mm-item')
  // 刻意不點任何遊戲層的東西：使用者要的是「沒全部展開也能點 Machine Model」
  check('不展開遊戲就列出 2 個 Machine Model', await items.count() === 2)
  check('gmid 預設不顯示', await page.locator('.ui-ss-mm-gmids').count() === 0)

  await items.nth(0).locator('.ui-ss-mm-caret').click()
  check('點 ▸ 只展開 wlzbhelix9', await items.nth(0).locator('.ui-ss-mm-gmids').count() === 1 && await items.nth(1).locator('.ui-ss-mm-gmids').count() === 0)
  const txt = await items.nth(0).locator('.ui-ss-mm-gmids').innerText()
  check('列出它的 3 台 gmid', ['2133', '2134', '2203'].every(x => txt.includes(x)) && !txt.includes('2136'), txt)

  await items.nth(1).locator('.ui-ss-mm-tag-btn').click()
  check('點名稱也能展開 wlzbhelix5', await items.nth(1).locator('.ui-ss-mm-gmids').count() === 1)
  await items.nth(1).locator('.ui-ss-mm-tag-btn').click()
  check('再點名稱收合', await items.nth(1).locator('.ui-ss-mm-gmids').count() === 0)

  const cb = items.nth(1).locator('input[type=checkbox]')
  check('多個 Machine Model：子列有勾', await cb.count() === 1)
  await cb.check()
  check('不展開也能勾選', await cb.isChecked() && await items.nth(1).locator('.ui-ss-mm-gmids').count() === 0)

  const single = page.locator('.ui-ss-mm').nth(1)
  check('只有一個 Machine Model：子列沒有勾', await single.locator('.ui-ss-mm-item input[type=checkbox]').count() === 0)
  await single.locator('.ui-ss-mm-row input[type=checkbox]').check()
  check('主列的勾選到它（已選 2 個 model）', await page.getByText('已選 2 個 model').count() >= 1)

  // 還有任何一組開著時按鈕是「全部收合」——先把 wlzbhelix9 收起來
  await items.nth(0).locator('.ui-ss-mm-caret').click()
  check('都收起來時按鈕顯示「全部展開」', await page.getByRole('button', { name: '全部展開' }).count() === 1)
  await page.getByRole('button', { name: '全部展開' }).click()
  check('全部展開打開 3 組 gmid', await page.locator('.ui-ss-mm-gmids').count() === 3)
  await page.screenshot({ path: path.join(root, `ui-ss-mm-expand-${mode}.png`) })
  await page.getByRole('button', { name: '全部收合' }).click()
  check('全部收合', await page.locator('.ui-ss-mm-gmids').count() === 0)
}

await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

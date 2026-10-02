/**
 * Meegle 補回填分頁（v4.280.0）。待補清單與補寫回應用假的（本機目前沒有待補的列）；先用真的打一次確認空清單也正常。
 * 兩種主題各截一張。跑法：node scripts/ui-checks/meegle-backfill-walkthrough.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'

const HOST = '192.168.3.41'
const db = new Database('server/data.db')
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email = 'eric.wu@toppath.tw' AND expires_at > ? ORDER BY created_at DESC").get(Date.now())
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()
const base = { sheetLabel: 'JjLosM…／1Xp7sf', summary: 's', owner: 'eric.wu@toppath.tw', lastAt: Date.now() - 600_000 }
const ITEMS = [
  { ...base, tool: 'create', toolLabel: '開單', stage: '已開單（Meegle）', batchId: '11111111-1111-4111-8111-111111111111', rowKey: '12', workItemId: '15191459', sheetRow: 12, phase: 'stuck', message: null },
  { ...base, tool: 'comment', toolLabel: '評論', stage: '添加評論', batchId: '22222222-2222-4222-8222-222222222222', rowKey: '15194994', workItemId: '15194994', sheetRow: 28, phase: 'failed', message: '寫入 Sheet 失敗：連線逾時' },
  { ...base, tool: 'status', toolLabel: '狀態', stage: '已切換狀態', batchId: '33333333-3333-4333-8333-333333333333', rowKey: '15194995', workItemId: '15194995', sheetRow: 36, phase: 'failed', message: '寫入受限' },
  { ...base, tool: 'edit', toolLabel: '修改', stage: '已修改欄位', batchId: '44444444-4444-4444-8444-444444444444', rowKey: '15190441', workItemId: '15190441', sheetRow: 41, phase: 'failed', message: '修改完成、回填失敗：請求過多' },
]

for (const theme of ['classic', 'xianxia']) {
  console.log(`== ${theme}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(t => localStorage.setItem('toppath-theme-mode', t), theme)
  const page = await ctx.newPage()
  if (theme === 'classic') {
    // 先打一次真的：本機沒有待補的列 → 空清單
    await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
    await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
    await page.getByRole('button', { name: 'Meegle 補回填' }).click()
    await page.getByText('沒有待補的列').waitFor({ timeout: 30000 })
    check('真的清單：空的時候顯示「沒有待補的列」、補寫按鈕停用', await page.getByRole('button', { name: /補寫回 0 筆/ }).isDisabled())
  }
  let afterRetry = false
  const sent = []
  await page.route('**/api/meegle/backfill/pending**', r => r.fulfill({ json: { ok: true, scope: r.request().url().includes('all=1') ? 'all' : 'mine', canSeeAll: true, items: afterRetry ? [ITEMS[2]] : ITEMS } }))
  await page.route('**/api/meegle/backfill/retry', async r => {
    sent.push(...r.request().postDataJSON().items); afterRetry = true
    await r.fulfill({ json: { ok: true, results: [
      { tool: 'create', batchId: ITEMS[0].batchId, rowKey: '12', workItemId: '15191459', ok: true, message: null },
      { tool: 'comment', batchId: ITEMS[1].batchId, rowKey: '15194994', workItemId: '15194994', ok: false, message: '列已變動：第 28 列的 Meegle 單號現在是「#1」，不是 #15194994，沒有回填' },
      { tool: 'status', batchId: ITEMS[2].batchId, rowKey: '15194995', workItemId: '15194995', ok: false, message: '寫入 Sheet 失敗：連線逾時' },
    ] } })
  })
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 補回填' }).click()
  await page.locator('.bf-table tbody tr').nth(3).waitFor({ timeout: 30000 })
  check('清單四種來源標籤都在', (await page.locator('.bf-tool').allInnerTexts()).join(',') === '開單,評論,狀態,修改')
  check('卡住的標「待回填」、失敗的標「失敗」', (await page.locator('.bf-badge-pending').count()) === 1 && (await page.locator('.bf-table .mb-badge--bad').count()) === 3)
  await page.locator('.bf-table tbody tr').nth(3).locator('input[type=checkbox]').uncheck()
  check('取消一列 → 補寫回 3 筆', await page.getByRole('button', { name: '補寫回 3 筆' }).isVisible())
  await page.screenshot({ path: `bf-list-${theme}.png`, fullPage: true })
  await page.getByRole('button', { name: '補寫回 3 筆' }).click()
  await page.locator('.bf-result').nth(2).waitFor({ timeout: 30000 })
  check('只送勾選的三列', sent.length === 3 && !sent.some(s => s.tool === 'edit'))
  check('結果分三類：成功／列已變動不寫／Sheet 失敗', (await page.locator('.bf-result').allInnerTexts()).join(',') === '成功,列已變動不寫,Sheet 失敗')
  check('補完重新讀清單（剩 1 筆）', (await page.locator('.bf-table tbody tr').count()) === 1)
  await page.screenshot({ path: `bf-result-${theme}.png`, fullPage: true })
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

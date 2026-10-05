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
  check('卡住的標「待回填」、失敗的標「失敗」', (await page.locator('.bf-table .bf-badge-pending').count()) === 1 && (await page.locator('.bf-table .mb-badge--bad').count()) === 3)
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
// ── v5.7.0 依 Sheet 分組 ──
{
  console.log('== 依 Sheet 分組')
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  const page = await ctx.newPage()
  const now = Date.now()
  const mk = (sheet, n, extra) => ({ ...base, sheetLabel: sheet, sourceKey: 'lark:' + sheet, tool: 'create', toolLabel: '開單', stage: '已開單', batchId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, rowKey: String(n), workItemId: String(15000000 + n), sheetRow: n, phase: 'failed', message: '沒有編輯權限', lastAt: now - 60_000, ...extra })
  const G = [
    mk('舊的那份', 1, { lastAt: now - 9e6 }), mk('舊的那份', 2, { lastAt: now - 9e6, message: '逾時' }),
    mk('最新的那份', 5), mk('最新的那份', 3), mk('最新的那份', 4, { message: '逾時' }), mk('最新的那份', 6, { phase: 'stuck', message: null }),
  ]
  const sent = []
  await page.route('**/api/meegle/backfill/pending**', r => r.fulfill({ json: { ok: true, scope: 'mine', canSeeAll: false, items: G } }))
  await page.route('**/api/meegle/backfill/retry', async r => { sent.push(...r.request().postDataJSON().items); await r.fulfill({ json: { ok: true, results: [] } }) })
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 補回填' }).click()
  await page.locator('.bf-group').first().waitFor()
  const names = await page.locator('.bf-group-name').allInnerTexts()
  check('一份 Sheet 一塊、最近有動靜的排最上面', JSON.stringify(names) === JSON.stringify(['最新的那份', '舊的那份']), JSON.stringify(names))
  check('沒有 Sheet 下拉了', await page.locator('select[aria-label="Sheet"]').count() === 0)
  const head = await page.locator('.bf-group').first().locator('.bf-group-head').innerText()
  check('標題列：失敗 3、待回填 1、最常見原因與次數', /失敗 3/.test(head) && /待回填 1/.test(head) && /沒有編輯權限.*×2/.test(head), head.replace(/s+/g, ' '))
  check('預設只展開第一份', await page.locator('.bf-group.is-open').count() === 1 && await page.locator('.bf-group').first().evaluate(e => e.classList.contains('is-open')))
  const rows = await page.locator('.bf-group.is-open tbody tr td.mb-num').evaluateAll(tds => tds.filter((_, i) => i % 2 === 0).map(td => td.textContent))
  check('區塊裡依列號排序、表格只留列號', JSON.stringify(rows) === JSON.stringify(['第 3 列', '第 4 列', '第 5 列', '第 6 列']), JSON.stringify(rows))
  // 這份全選
  await page.locator('.bf-group').nth(1).getByLabel(/這份全選/).uncheck()
  check('取消「舊的那份」全選 → 補寫回 4 筆（收合的那份也算得到）', await page.getByRole('button', { name: '補寫回 4 筆' }).isVisible())
  await page.locator('.bf-group').first().locator('tbody tr').first().locator('input').uncheck()
  check('取消其中一列 → 那份的全選變成半選', await page.locator('.bf-group').first().getByLabel(/這份全選/).evaluate(e => e.indeterminate && !e.checked))
  await page.locator('.bf-group').nth(1).locator('.bf-group-toggle').click()
  check('點標題展開第二份', await page.locator('.bf-group.is-open').count() === 2)
  await page.getByRole('button', { name: '補寫回 3 筆' }).click()
  await page.waitForTimeout(500)
  check('只送勾選的 3 列', sent.length === 3 && sent.every(x => ['4', '5', '6'].includes(x.rowKey)), JSON.stringify(sent.map(x => x.rowKey)))
  await page.screenshot({ path: 'bf-grouped.png', fullPage: true })
  await ctx.close()
}
// 兩份不同的 Sheet 顯示名稱撞名（顯示名稱是截短的）→ 仍是兩組（CodeX review）
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  const page = await ctx.newPage()
  const mk2 = (src, n) => ({ ...base, sheetLabel: 'JjLosM…／1Xp7sf', sourceKey: src, tool: 'create', toolLabel: '開單', stage: '已開單', batchId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`, rowKey: String(n), workItemId: String(16000000 + n), sheetRow: n, phase: 'failed', message: 'x', lastAt: Date.now() - n })
  await page.route('**/api/meegle/backfill/pending**', r => r.fulfill({ json: { ok: true, scope: 'mine', canSeeAll: false, items: [mk2('lark:AAA/1Xp7sf', 1), mk2('lark:BBB/1Xp7sf', 2)] } }))
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: 'Meegle 補回填' }).click()
  await page.locator('.bf-group').first().waitFor()
  check('顯示名稱撞名的兩份 Sheet 仍分成兩組', await page.locator('.bf-group').count() === 2)
  await page.locator('.bf-group').first().getByLabel(/這份全選/).uncheck()
  check('「這份全選」只動自己那組（剩 1 筆）', await page.getByRole('button', { name: '補寫回 1 筆' }).isVisible())
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

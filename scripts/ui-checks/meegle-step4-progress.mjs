/**
 * Meegle 開單 ④ 送出結果：只留一條進度（v4.268.1，使用者回報「兩個進度條、看結果沒反應」）。
 *
 * 真送出會開真的 Meegle 單，所以 Sheet／Meegle 的 API 全部用 page.route 假掉，只驗前端：
 *   1 ④ 頁面內沒有進度條（.mb-pane 裡沒有 .mb-progress-track）
 *   2 下方固定進度列還在，且顯示「送出完成 2 / 2」
 *   3 在 ④ 時固定列沒有「看結果」
 *   4 回到 ③ 時「看結果」出現，按了會回到 ④
 * 兩種主題各截一張圖。走區網 IP（localhost 是安全情境，會遮掉 randomUUID 這類問題）。
 *
 * 跑法：node scripts/ui-checks/meegle-step4-progress.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = '192.168.3.41'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
await ctx.route('**/api/meegle/batch/meta', r => r.fulfill({ json: { ok: true, requirements: [{ id: '900001', name: '假需求' }], states: [], statesError: null } }))
await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: [] } }))
await ctx.route('**/api/meegle/batch/previous', r => r.fulfill({ json: { ok: true, rows: [] } }))
await ctx.route('**/api/lark/sheets/records', r => r.fulfill({ json: { ok: true, records: [{ _rowIndex: 2, 摘要: '假單一' }, { _rowIndex: 3, 摘要: '假單二' }] } }))
let n = 0
await ctx.route('**/api/meegle/batch/row', async r => {
  const b = r.request().postDataJSON()
  n++
  await r.fulfill({ json: { ok: true, row: { batchId: b.batchId, rowKey: b.rowKey, createPhase: 'created', workItemId: String(990000 + n), url: null, statePhase: 'none', message: null, writebackPhase: 'done', writebackMsg: null } } })
})
await ctx.route('**/api/meegle/batch/finish', r => r.fulfill({ json: { ok: true } }))
const page = await ctx.newPage()

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }

for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.sidebar, nav, aside').getByText(/^(Jira 批量開單)$|批量開單|萬卷/).first().click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  await page.locator('.mb-select').first().selectOption('900001')
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE?sheet=x')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: /^送出 \d+ 列$/ }).click()
  await page.getByText('送出完成 2 / 2').waitFor({ timeout: 10000 })

  const pane = page.locator('.mb-pane')
  check('④ 頁面內沒有進度條', await pane.locator('.mb-progress-track').count() === 0)
  check('固定進度列還在', await page.locator('.mb-dock .mb-progress-track').count() === 1)
  check('④ 時沒有「看結果」', await page.locator('.mb-dock').getByRole('button', { name: '看結果' }).count() === 0)
  check('仍有關閉按鈕', await page.locator('.mb-dock').getByRole('button', { name: '關閉進度列' }).count() === 1)
  check('完成提示還在', await pane.getByText('完成不代表全數成功').count() === 1)
  await page.waitForTimeout(1200) // 進度條有寬度轉場，等它跑完再截
  await page.screenshot({ path: path.join(root, `meegle-step4-${mode}.png`) })

  await pane.getByRole('button', { name: '上一步' }).click()
  const see = page.locator('.mb-dock').getByRole('button', { name: '看結果' })
  check('回 ③ 時「看結果」出現', await see.count() === 1)
  await see.click()
  check('按「看結果」回到 ④', await page.locator('.mb-pane-title', { hasText: '送出結果' }).count() === 1)
}

await browser.close()
console.log(n === 4 ? '' : `⚠️ 假 /row 被打了 ${n} 次（預期 4）`)
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

/**
 * Meegle 雙空間（v5.10.0）走查。Meegle／Sheet 的 API 全部用 page.route 假掉（真送出會開真的單），只驗前端：
 *   1 預設「測試」，讀需求清單時帶 space=test
 *   2 切到「正式」→ 重新讀需求清單帶 space=prod；所有寫入請求都帶 space=prod
 *   3 正式送出前跳確認（空間、操作、Sheet、筆數）；按取消一筆都不送；確認才送
 *   4 送出中不能切空間
 *   5 每頁各自記住：沒選過的分頁拿最後一次選的當初始值；在評論切回測試，不會改到開單的正式
 *   6 這份 Sheet 已在另一個空間送過 → 提示、送出鈕不能按
 * 兩種主題各截一張圖。走區網 IP。
 *
 * 跑法：node scripts/ui-checks/meegle-space-switch.mjs
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

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }

const browser = await chromium.launch()
for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(m => {
    if (sessionStorage.getItem('msp-init')) return
    sessionStorage.setItem('msp-init', '1')
    for (const k of Object.keys(localStorage)) if (k.startsWith('meegle-tools-space')) localStorage.removeItem(k)
    localStorage.setItem('meegle-tools-tab', 'create')
    localStorage.setItem('toppath-theme-mode', m)
  }, mode)
  const metaSpaces = [], rowSpaces = [], otherSpaceFor = { value: null }
  await ctx.route('**/api/meegle/batch/meta*', r => { metaSpaces.push(new URL(r.request().url()).searchParams.get('space')); return r.fulfill({ json: { ok: true, requirements: [{ id: '900001', name: '假需求' }], states: [], statesError: null } }) })
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: [] } }))
  await ctx.route('**/api/meegle/batch/previous', r => r.fulfill({ json: { ok: true, rows: [], otherSpace: otherSpaceFor.value } }))
  await ctx.route('**/api/meegle/comment/meta', r => r.fulfill({ json: { ok: true, detailBase: '', bound: true } }))
  await ctx.route('**/api/lark/sheets/records', r => r.fulfill({ json: { ok: true, records: [{ _rowIndex: 2, 摘要: '假單一' }, { _rowIndex: 3, 摘要: '假單二' }] } }))
  let n = 0
  await ctx.route('**/api/meegle/batch/row', async r => {
    const b = r.request().postDataJSON()
    n++; rowSpaces.push(b.space)
    await new Promise(res => setTimeout(res, 700))   // 讓「送出中不能切」看得到
    await r.fulfill({ json: { ok: true, row: { batchId: b.batchId, rowKey: b.rowKey, space: b.space, createPhase: 'created', workItemId: String(990000 + n), url: null, statePhase: 'none', message: null, writebackPhase: 'done', writebackMsg: null } } })
  })
  await ctx.route('**/api/meegle/batch/finish', r => r.fulfill({ json: { ok: true } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.locator('.sidebar, nav, aside').getByText(/^(Jira 批量開單)$|批量開單|萬卷|Meegle/).first().click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  const bar = page.locator('.msp-bar')
  const radio = name => bar.getByRole('radio', { name })
  await bar.waitFor()
  await page.waitForTimeout(400)
  check('預設是測試', await radio('測試').getAttribute('aria-checked') === 'true')
  check('需求清單帶 space=test', metaSpaces.at(-1) === 'test', JSON.stringify(metaSpaces))

  await radio('正式').click()
  await page.waitForTimeout(500)
  check('切到正式 → 需求清單重讀並帶 space=prod', metaSpaces.at(-1) === 'prod', JSON.stringify(metaSpaces))

  const loadAndGo = async () => {
    await page.locator('.mb-select').first().selectOption('900001')
    await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE?sheet=x')
    await page.getByRole('button', { name: /讀取 Sheet/ }).click()
    await page.getByRole('button', { name: '下一步' }).click()
  }
  await loadAndGo()
  await page.getByRole('button', { name: /^送出 \d+ 列$/ }).click()
  const modal = page.getByRole('dialog', { name: '確認送到正式空間' })
  await modal.waitFor({ timeout: 5000 }).catch(() => {})
  const mt = await modal.innerText().catch(() => '')
  check('正式送出前跳確認，列出空間／操作／Sheet／筆數', /正式/.test(mt) && /Meegle 開單/.test(mt) && /FAKE/.test(mt) && /2 筆/.test(mt), mt.replace(/\s+/g, ' ').slice(0, 120))
  await page.screenshot({ path: path.join(root, `meegle-space-confirm-${mode}.png`) })
  await modal.getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(400)
  check('按取消 → 一筆都沒送', n === 0, `row 被打 ${n} 次`)

  await page.getByRole('button', { name: /^送出 \d+ 列$/ }).click()
  await modal.getByRole('button', { name: /確認送出/ }).click()
  await page.waitForTimeout(250)
  check('送出中不能切空間', await radio('測試').isDisabled())
  await page.locator('.mb-tally', { hasText: '已開單 2' }).waitFor({ timeout: 10000 }).catch(() => {})
  check('確認後送出 2 筆、每筆都帶 space=prod', n === 2 && rowSpaces.every(s => s === 'prod'), JSON.stringify(rowSpaces))
  check('送完可以再切', !(await radio('測試').isDisabled()))

  // 每頁各自記住
  await page.getByRole('button', { name: 'Meegle 評論' }).click()
  await bar.waitFor()
  check('沒選過的評論分頁：初始值＝最後一次選的（正式）', await radio('正式').getAttribute('aria-checked') === 'true')
  await radio('測試').click()
  await page.getByRole('button', { name: 'Meegle 開單' }).click()
  await page.waitForTimeout(300)
  check('評論切回測試，不會改到開單的正式', await radio('正式').getAttribute('aria-checked') === 'true')

  // 另一個空間送過
  otherSpaceFor.value = 'test'
  await loadAndGo().catch(() => {})
  await page.getByRole('button', { name: /^1 讀取與預設|讀取與預設/ }).first().click().catch(() => {})
  await page.locator('.mb-input').first().fill('https://example.larksuite.com/sheets/FAKE2?sheet=x')
  await page.getByRole('button', { name: /讀取 Sheet/ }).click()
  await page.waitForTimeout(400)
  check('另一個空間送過 → 顯示提示', await page.getByText('這份 Sheet 已經在「測試」空間送過').count() === 1)
  await page.screenshot({ path: path.join(root, `meegle-space-conflict-${mode}.png`) })
  await page.getByRole('button', { name: '下一步' }).click().catch(() => {})
  const send = page.getByRole('button', { name: /^送出 \d+ 列$/ })
  check('另一個空間送過 → 送出鈕不能按', (await send.count()) > 0 && await send.first().isDisabled())
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

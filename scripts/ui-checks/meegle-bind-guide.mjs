/**
 * Meegle 綁定引導卡（v5.11.0）走查。meta API 用 page.route 假掉，只驗前端（CodeX 2026-10-06 的驗收範圍）：
 *   1 四頁 × 三種 code（NOT_BOUND／BINDING_INVALID／DECRYPT_FAILED）都顯示對的標題；DECRYPT_FAILED 不寫成「過期」
 *   2 「重新檢查」：檢查中反灰防連點（連按兩下只打一次）、成功才撤卡
 *   3 重新檢查遇到網路／其他錯誤 → 顯示一般錯誤，不顯示成綁定問題
 *   4 「前往綁定」→ 個人帳號頁有「回到 Meegle 批量工具」→ 回來分頁、空間、打到一半的 Sheet 網址都還在
 * 兩種主題各截一張圖。走區網 IP。
 * 跑法：node scripts/ui-checks/meegle-bind-guide.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = '192.168.3.41'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const TITLE = { NOT_BOUND: '還沒綁定 Meegle', BINDING_INVALID: 'Meegle 綁定已失效', DECRYPT_FAILED: '綁定資料無法讀取' }
const TABS = [['create', 'Meegle 開單'], ['comment', 'Meegle 評論'], ['status', 'Meegle 狀態'], ['edit', 'Meegle 修改']]

const browser = await chromium.launch()
for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(m => { localStorage.setItem('toppath-theme-mode', m); localStorage.setItem('meegle-tools-tab', 'create') }, mode)
  // 每頁 meta 的回應由 state 控制：code＝綁定問題；'ok'＝正常；'net'＝伺服器錯誤
  const state = { code: 'NOT_BOUND' }, calls = { create: 0, comment: 0, status: 0, edit: 0 }
  const slow = () => new Promise(r => setTimeout(r, 600))
  const fulfill = async (r, tool, okJson) => {
    calls[tool]++; await slow()
    if (state.code === 'ok') return r.fulfill({ json: okJson })
    if (state.code === 'net') return r.fulfill({ status: 502, json: { ok: false, message: '伺服器暫時連不上' } })
    if (tool === 'comment') return r.fulfill({ json: { ok: true, detailBase: '', bound: false, code: state.code, message: 'x' } })
    return r.fulfill({ status: 409, json: { ok: false, code: state.code, message: '綁定問題' } })
  }
  await ctx.route('**/api/meegle/batch/meta*', r => fulfill(r, 'create', { ok: true, requirements: [], states: [], statesError: null }))
  await ctx.route('**/api/meegle/comment/meta', r => fulfill(r, 'comment', { ok: true, detailBase: '', bound: true }))
  await ctx.route('**/api/meegle/status/meta', r => fulfill(r, 'status', { ok: true, states: [], detailBase: '', dateModes: [], autoDateFields: [] }))
  await ctx.route('**/api/meegle/edit/meta', r => fulfill(r, 'edit', { ok: true, fields: [], options: {}, detailBase: '', people: [] }))
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: [] } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.locator('.sidebar, nav, aside').getByText(/Meegle 批量工具|卷宗管理/).first().click()

  // 1 四頁 × 三種 code
  for (const code of Object.keys(TITLE)) {
    state.code = code
    for (const [, label] of TABS) {
      await page.getByRole('button', { name: label, exact: true }).click()
      const card = page.getByRole('region', { name: TITLE[code] })
      const ok = await card.waitFor({ timeout: 4000 }).then(() => true, () => false)
      check(`${label}：${code} → 「${TITLE[code]}」`, ok && (code !== 'DECRYPT_FAILED' || !/過期/.test(await card.innerText())))
    }
  }

  // 2 重新檢查：連按兩下只打一次、成功才撤卡（用狀態頁）
  state.code = 'NOT_BOUND'
  await page.getByRole('button', { name: 'Meegle 狀態', exact: true }).click()
  const card = page.getByRole('region', { name: TITLE.NOT_BOUND })
  await card.waitFor()
  await page.screenshot({ path: path.join(root, `meegle-bind-guide-${mode}.png`) })
  state.code = 'ok'
  const before = calls.status
  // 用位置抓按鈕：文字會從「重新檢查」變成「檢查中…」，用文字抓第二下會等到檢查結束
  const btn = card.locator('.mbg-actions button').nth(1)
  await btn.click()
  check('檢查中反灰', await btn.isDisabled() && (await btn.innerText()).includes('檢查中'))
  check('檢查中卡片還在（成功才撤）', await card.isVisible())
  await btn.click({ force: true, timeout: 300 }).catch(() => {})
  await page.waitForTimeout(900)
  check('連按兩下只打一次 meta', calls.status - before === 1, `${calls.status - before} 次`)
  check('成功後引導卡消失', await page.getByRole('region', { name: TITLE.NOT_BOUND }).count() === 0)

  // 3 重新檢查遇到網路錯誤 → 一般錯誤，不是綁定卡（用修改頁）
  state.code = 'NOT_BOUND'
  await page.getByRole('button', { name: 'Meegle 修改', exact: true }).click()
  await page.getByRole('region', { name: TITLE.NOT_BOUND }).waitFor()
  state.code = 'net'
  await page.getByRole('region', { name: TITLE.NOT_BOUND }).getByRole('button', { name: /重新檢查/ }).click()
  await page.waitForTimeout(900)
  check('網路錯誤 → 顯示一般錯誤、沒有綁定卡', await page.getByText('伺服器暫時連不上').count() > 0 && await page.locator('.mbg-card').count() === 0)

  // 4 往返個人帳號不丟草稿（評論頁：打一半的網址）
  state.code = 'NOT_BOUND'
  await page.getByRole('button', { name: 'Meegle 評論', exact: true }).click()
  await page.getByRole('region', { name: TITLE.NOT_BOUND }).waitFor()
  const draft = 'https://example.larksuite.com/sheets/DRAFT?sheet=half'
  await page.locator('.mc-loadbar .mb-input').fill(draft)
  await page.getByRole('button', { name: '前往綁定 →' }).click()
  const back = page.getByRole('button', { name: '回到 Meegle 批量工具 →' })
  check('前往綁定 → 到個人帳號頁、有「回到 Meegle 批量工具」', await back.waitFor({ timeout: 5000 }).then(() => true, () => false))
  await back.click()
  await page.waitForTimeout(500)
  check('回來仍在評論分頁', await page.getByRole('button', { name: 'Meegle 評論', exact: true }).evaluate(e => getComputedStyle(e).color !== '') && await page.locator('.mc-loadbar .mb-input').isVisible())
  check('打一半的 Sheet 網址還在', await page.locator('.mc-loadbar .mb-input').inputValue() === draft)
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

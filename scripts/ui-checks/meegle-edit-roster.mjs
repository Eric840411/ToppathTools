/**
 * Meegle 批量修改 ② 人員下拉改列空間人員（v5.48.0）走查。API 用 page.route 假掉，只驗前端：
 *   1 受托人固定值的下拉＝空間人員（email）＋對照表裡名單外的人；名單內的人不重複
 *   2 選到還沒對照的人 → 打 verify（帶 space、userKey）；verify 回來前「下一步」鎖住
 *   3 verify 失敗 → 列出原因
 *   4 人員對照的選單也列空間人員；「建立對照」帶 space
 * 跑法：node scripts/ui-checks/meegle-edit-roster.mjs（UI_HOST 預設本機區網 IP）
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = process.env.UI_HOST || '192.168.3.36'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }

const ROSTER = [
  { userKey: '1', email: 'eric.wu@toppath.tw', name: 'Eric', names: ['Eric'] },
  { userKey: '2', email: 'tim@toppath.tw', name: 'Tim', names: ['Tim'] },
  { userKey: '3', email: 'amy@toppath.tw', name: 'Amy', names: ['Amy'] },
  { userKey: '4', email: 'bad@toppath.tw', name: 'Bad', names: ['Bad'] },
]
const PEOPLE = [
  { alias: 'eric', name: 'Eric', email: 'eric.wu@toppath.tw' },
  { alias: 'lusa', name: 'Lusa', email: 'lusa@toppath.tw' },   // 名單外、對照表裡有
]

const browser = await chromium.launch()
for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}]`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(m => { localStorage.setItem('toppath-theme-mode', m); localStorage.setItem('meegle-tools-tab', 'edit') }, mode)
  const verifies = []
  let releaseVerify
  await ctx.route('**/api/meegle/edit/meta', r => r.fulfill({ json: { ok: true, fields: [], options: {}, detailBase: '', people: PEOPLE } }))
  await ctx.route('**/api/meegle/batch/people/roster', r => r.fulfill({ json: { ok: true, users: ROSTER, fetchedAt: Date.now() } }))
  await ctx.route('**/api/meegle/batch/people/verify', async r => {
    const b = r.request().postDataJSON(); verifies.push(b)
    if (b.email === 'bad@toppath.tw') return r.fulfill({ status: 404, json: { ok: false, message: 'Meegle 查不到這個人' } })
    await new Promise(res => { releaseVerify = res })
    return r.fulfill({ json: { ok: true } })
  })
  await ctx.route('**/api/meegle/edit/previous', r => r.fulfill({ json: { ok: true, rows: [] } }))
  await ctx.route('**/api/lark/sheets/records', r => r.fulfill({ json: { ok: true, headers: ['Meegle 單號', '摘要', '受托人'], records: [{ _rowIndex: 2, 'Meegle 單號': '#15190441', '摘要': 'x', '受托人': 'Nobody' }] } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  console.log('  isSecureContext =', await page.evaluate(() => isSecureContext))
  await page.locator('.sidebar, nav, aside').getByText(/Meegle 批量工具|卷宗管理/).first().click()
  await page.getByRole('button', { name: 'Meegle 修改', exact: true }).click()
  await page.locator('.me-page input').first().fill('https://x.larksuite.com/sheets/abc?sheet=1')
  await page.getByRole('button', { name: /讀取 Sheet/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '下一步' }).first().click()

  // 1 下拉名單
  await page.getByLabel('受托人 怎麼改').selectOption('fixed')
  const opts = await page.locator('#me-people-options option').evaluateAll(os => os.map(o => o.value))
  check('下拉含空間人員 Tim、Amy', opts.includes('tim@toppath.tw') && opts.includes('amy@toppath.tw'), JSON.stringify(opts))
  check('對照表裡名單外的 Lusa 也在', opts.includes('lusa'))
  check('Eric 只出現一次', opts.filter(v => /eric/i.test(v)).length === 1)

  // 2 選 Tim → verify 帶 space＋userKey；回來前下一步鎖住
  const input = page.getByLabel('受托人 固定值')
  await input.fill('tim@toppath.tw')
  await page.waitForTimeout(300)
  const next = page.locator('.mb-pane-actions .mb-btn--primary')
  check('verify 帶 space、userKey', verifies.some(v => v.email === 'tim@toppath.tw' && v.space && v.userKey === '2'), JSON.stringify(verifies))
  check('對照中下一步鎖住', await next.isDisabled() && (await next.innerText()).includes('人員對照中'))
  releaseVerify(); await page.waitForTimeout(300)
  check('對照完解鎖', !(await next.innerText()).includes('人員對照中'))
  check('Tim 變成標籤', await page.locator('.mb-picker-chip', { hasText: 'tim@toppath.tw' }).count() === 1)

  // 3 verify 失敗 → 列原因
  await input.fill('bad@toppath.tw'); await page.waitForTimeout(400)
  check('對不上的人列出原因', await page.getByText(/bad@toppath\.tw：Meegle 查不到這個人/).count() === 1)

  // 4 人員對照：Sheet 裡的 Nobody 用空間人員對照
  await page.getByLabel('受托人 怎麼改').selectOption('sheet')
  await page.getByLabel('受托人 Sheet 欄').selectOption('受托人')
  const mapSel = page.getByLabel('Nobody 對照到')
  const mapOpts = await mapSel.locator('option').evaluateAll(os => os.map(o => o.value))
  check('人員對照選單含空間人員 Amy', mapOpts.includes('amy@toppath.tw'), JSON.stringify(mapOpts))
  await mapSel.selectOption('amy@toppath.tw')
  await page.getByRole('button', { name: '建立對照' }).click()
  await page.waitForTimeout(200); releaseVerify?.(); await page.waitForTimeout(300)
  check('建立對照帶 space', verifies.some(v => v.alias === 'Nobody' && v.space && v.userKey === '3'), JSON.stringify(verifies.at(-1)))
  await page.screenshot({ path: path.join(root, `meegle-edit-roster-${mode}.png`) })
  await ctx.close()
}
await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

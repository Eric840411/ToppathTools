/**
 * Meegle 批量工具「使用說明」（v5.14.0）走查。meta API 假掉，只驗前端：
 *   1 放在分頁操作**下方**（說明的上緣在前一個區塊的下緣之下）
 *   2 說明分頁跟著工具分頁走；補回填分頁不顯示
 *   3 收起後重新整理仍是收起（記住），展開回來
 *   4 說明裡沒有任何 emoji（兩種主題）；修仙版顯示美術圖（圖真的載入）、普通版顯示線條圖示
 *   5 「Meegle 空間」那條只給管理員看
 *   6 手機寬 390：頁面沒有橫向捲動
 * 兩種主題各截一張圖。走區網 IP。跑法：node scripts/ui-checks/meegle-guide.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = '192.168.3.41'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const admin = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
const other = db.prepare("SELECT s.sid FROM auth_sessions s JOIN jira_accounts a ON a.email = s.email WHERE a.role NOT LIKE '%admin%' AND s.expires_at>? ORDER BY s.created_at DESC").get(Date.now())

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const GUIDE = 'section[aria-label="Meegle 批量工具使用說明"]'
const EMOJI = /\p{Extended_Pictographic}/u

async function open(browser, sid, mode, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(m => {
    if (!sessionStorage.getItem('__guide_init')) { localStorage.removeItem('meegle-guide-open'); sessionStorage.setItem('__guide_init', '1') }
    localStorage.setItem('toppath-theme-mode', m); localStorage.setItem('meegle-tools-tab', 'create')
  }, mode)
  await ctx.route('**/api/meegle/batch/meta*', r => r.fulfill({ json: { ok: true, requirements: [], states: [], statesError: null } }))
  await ctx.route('**/api/meegle/comment/meta', r => r.fulfill({ json: { ok: true, detailBase: '', bound: true } }))
  await ctx.route('**/api/meegle/status/meta', r => r.fulfill({ json: { ok: true, states: [], detailBase: '', dateModes: [], autoDateFields: [] } }))
  await ctx.route('**/api/meegle/edit/meta', r => r.fulfill({ json: { ok: true, fields: [], options: {}, detailBase: '', people: [] } }))
  await ctx.route('**/api/meegle/batch/people', r => r.fulfill({ json: { ok: true, people: [] } }))
  await ctx.route('**/api/meegle/backfill/pending**', r => r.fulfill({ json: { ok: true, scope: 'mine', canSeeAll: false, items: [] } }))
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.locator('.sidebar, nav, aside').getByText(/Meegle 批量工具|卷宗管理/).first().click()
  await page.locator(GUIDE).waitFor({ timeout: 5000 })
  // 手機寬：窄版側欄收起來點不到，先用桌面寬進到頁面再縮
  if (width !== 1440) { await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(400) }
  return { ctx, page }
}

const browser = await chromium.launch()
for (const mode of ['classic', 'xianxia']) {
  console.log(`[${mode}・管理員]`)
  const { ctx, page } = await open(browser, admin.sid, mode)
  const guide = page.locator(GUIDE)

  // 1 位置：說明是頁面最後一塊，上緣在前一塊的下緣之下
  const pos = await guide.evaluate(el => { const prev = el.previousElementSibling; return { top: el.getBoundingClientRect().top, prevBottom: prev?.getBoundingClientRect().bottom ?? -1, last: !el.nextElementSibling } })
  check('在分頁操作下方', pos.prevBottom > 0 && pos.top >= pos.prevBottom - 1 && pos.last, JSON.stringify(pos))
  check('第一次進來是展開的', await guide.locator('.mgd-pane').count() === 1)

  // 2 跟著分頁走
  check('開單分頁 → 說明是「開單」', await guide.getByRole('tab', { name: '開單' }).getAttribute('aria-selected') === 'true')
  check('管理員看得到「Meegle 空間」那條', (await guide.innerText()).includes('Meegle 空間'))
  await page.screenshot({ path: path.join(root, `meegle-guide-${mode}.png`), fullPage: true })
  await page.getByRole('button', { name: 'Meegle 狀態', exact: true }).click()
  await page.waitForTimeout(400)
  check('切到狀態分頁 → 說明跟著切', await guide.getByRole('tab', { name: '狀態' }).getAttribute('aria-selected') === 'true' && (await guide.innerText()).includes('目標狀態'))

  // 4 emoji 與圖示
  for (const k of ['開單', '評論', '狀態', '修改']) {
    await guide.getByRole('tab', { name: k }).click()
    const t = await guide.innerText()
    check(`「${k}」說明沒有 emoji`, !EMOJI.test(t), (t.match(EMOJI) ?? [''])[0])
  }
  // 剛切分頁，圖還在載：等到每張都結束（成功或失敗）再判斷，不然量到的是「還沒載完」
  await page.waitForFunction(sel => [...document.querySelectorAll(sel + ' .mgd-ic img')].every(i => i.complete), GUIDE, { timeout: 5000 }).catch(() => {})
  const icons = await guide.locator('.mgd-ic').evaluateAll(els => els.map(el => {
    const svg = el.querySelector('svg'), img = el.querySelector('img')
    return { svg: getComputedStyle(svg).display !== 'none', img: getComputedStyle(img).display !== 'none', loaded: img.complete && img.naturalWidth > 0 }
  }))
  if (mode === 'xianxia') check('修仙版：只顯示美術圖、而且每張都真的載入', icons.length > 0 && icons.every(i => i.img && !i.svg && i.loaded), JSON.stringify(icons.filter(i => !(i.img && !i.svg && i.loaded)).slice(0, 2)))
  else check('普通版：只顯示線條圖示', icons.length > 0 && icons.every(i => i.svg && !i.img))

  // 2 補回填不顯示
  await page.getByRole('button', { name: 'Meegle 補回填', exact: true }).click()
  await page.waitForTimeout(300)
  check('補回填分頁沒有使用說明', await page.locator(GUIDE).count() === 0)

  // 3 收起記住
  await page.getByRole('button', { name: 'Meegle 開單', exact: true }).click()
  await guide.getByRole('button', { name: /收起/ }).click()
  check('收起後內容消失', await guide.locator('.mgd-pane').count() === 0)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.sidebar, nav, aside').getByText(/Meegle 批量工具|卷宗管理/).first().click()
  await page.locator(GUIDE).waitFor()
  check('重新整理後仍是收起', await page.locator(GUIDE).locator('.mgd-pane').count() === 0)
  await page.locator(GUIDE).getByRole('button', { name: /展開/ }).click()
  check('展開回來', await page.locator(GUIDE).locator('.mgd-pane').count() === 1)
  await ctx.close()
}

console.log('[非管理員]')
{
  const { ctx, page } = await open(browser, other.sid, 'classic')
  check('看不到「Meegle 空間」那條', !(await page.locator(GUIDE).innerText()).includes('Meegle 空間'))
  await ctx.close()
}

console.log('[手機寬 390]')
for (const mode of ['classic', 'xianxia']) {
  const { ctx, page } = await open(browser, admin.sid, mode, 390)
  const over = await page.locator(GUIDE).evaluate(el => ({ guide: el.scrollWidth - el.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth }))
  check(`${mode}：說明區塊與頁面都沒有橫向溢出`, over.guide <= 1 && over.doc <= 1, JSON.stringify(over))
  await page.screenshot({ path: path.join(root, `meegle-guide-${mode}-390.png`), fullPage: true })
  await ctx.close()
}

await browser.close()
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

/**
 * 驗 `uat-runner/h5-seat.js` **本人**（不是複製一份流程）：跑完一輪之後，位子真的放掉了嗎。
 *
 * 判準只有一個，而且是行為的：**退出之後重新載入，要停在大廳**。
 * 停在 /game 就代表位子還佔著——那正是要修的 bug（下一輪大廳積木全部命中 0，
 * 錯誤訊息卻長得像選擇器寫錯）。
 *
 * ⚠️ 故意先「進機台 ＋ 買入額度」把場面弄髒再退，不然測到的只是「本來就在大廳」。
 * ⚠️ 會動到餘額。QAT 帳號，跑之前先鎖帳號。
 *
 * 跑法：H5_URL='<帳號池 URL>' OUT=<目錄> node scripts/ui-checks/h5-seat-release.mjs
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'
import { h5BackToLobby, h5InGame } from '../../server/uat-runner/h5-seat.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

let pass = 0, fail = 0
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page)

  // ── 先把場面弄髒：進機台 ＋ 買入額度 ────────────────────────────────────────
  if (!h5InGame(page)) {
    const g = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    await page.locator(`.grid-item:has(.grid-item-name:text-is("${g.trim()}"))`).click({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(8000)
    await page.locator(':text-is("Quick Join")').first().click({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(15000)
  }
  check('人在機台裡（h5InGame 認得出來）', h5InGame(page), page.url().slice(-26))
  if (!h5InGame(page)) process.exit(1)

  // 殘留的 Tips 框會擋住面額，先用 Cancel 關掉（不替別人決定要不要下分）
  if (await page.locator('.box-btn_text1').count()) {
    await page.locator('.box-btn_text1').first().evaluate(el => el.click()).catch(() => {})
    await page.waitForTimeout(2500)
  }
  for (const [sel, name] of [['.btn_bet:not(.my-button--disabled)', '面額'], ['.btn_play', '帶入額度']]) {
    const loc = page.locator(sel).first()
    await loc.click({ timeout: 6000 }).catch(() => loc.evaluate(el => el.click()).catch(() => {}))
    log(`  ↳ 已點「${name}」`)
    await page.waitForTimeout(7000)
  }
  await page.screenshot({ path: `${OUT}/seat-1-dirty.png` })

  // ── 這一行就是被測的東西 ──────────────────────────────────────────────────
  const back = await h5BackToLobby(page, { log: (l) => log('  ' + l) })
  await page.screenshot({ path: `${OUT}/seat-2-after-release.png` })
  check('h5BackToLobby 回報成功', back.ok, back.steps.join(' → '))
  check('當下已經不在機台裡', !h5InGame(page), page.url().slice(-26))

  // ── 真正的判準：重新載入還會不會掉回去 ────────────────────────────────────
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  await dismissLobbyPopups(page)
  await page.screenshot({ path: `${OUT}/seat-3-reload.png` })
  check('🚨 重新載入停在大廳（位子真的放掉了）', !h5InGame(page), page.url().slice(-26))
  // 大廳真的建出來了才算數——URL 對但畫面空白一樣會讓下一輪全掛
  const cards = await page.locator('.grid-item').count().catch(() => 0)
  check('大廳卡片有渲染出來', cards > 0, `${cards} 張`)

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

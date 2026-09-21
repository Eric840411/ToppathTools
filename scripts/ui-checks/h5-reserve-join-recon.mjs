/**
 * 「Reserved 頁籤點 Join 進入已預約的那台」。
 *
 *   H5_URL='<帳號池 URL>' OUT=<目錄> node scripts/ui-checks/h5-reserve-join-recon.mjs
 *
 * 流程：進機台 X → 預約 X → 離開 → 進**另一台** Y → 開預約面板 → Reserved 分頁 →
 *       按 Join → **應該要進到 X**（不是 Y）。
 *
 * 🚨 判準是「**真的進到 X**」，不是「Join 按得下去」。按鈕點得到但沒換機台的話，
 *    畫面幾乎看不出差別——只有比對機台名稱才分得出來。
 *
 * 🚨 會真的預約，`finally` 一定要清掉（`.reserve` 入口只在機台內，人在大廳時點不到）。
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

async function tap(locator, label) {
  try { await locator.click({ timeout: 7000 }); log({ tap: label, via: 'click' }); return true }
  catch {
    try { await locator.evaluate(el => el.click()); log({ tap: label, via: 'js' }); return true }
    catch { log({ tap: label, via: 'FAIL' }); return false }
  }
}
const machineName = (page) => page.locator('.machine-id').first().innerText().then(t => t.trim()).catch(() => '')

/**
 * 進一台機台：先點遊戲卡片再 Quick Join（系統會配一台空的）。
 *
 * ⚠️ `card` 是要點第幾張遊戲卡片。**第二次一定要換一款遊戲**——
 *    有預約在身上時，對同一款按 Quick Join **會把你送回你預約的那一台**
 *    （這是正確行為，但會讓「進另一台」的測試變成原地踏步：實測 X 與 Y 是同一台，
 *    於是 Join 永遠是灰的 `join-unable`，因為人已經在裡面了）。
 */
async function enterMachine(page, label, card = 0) {
  if (h5InGame(page)) return machineName(page)
  await tap(page.locator('.grid-item').nth(card), `${label}：點第 ${card + 1} 張遊戲卡片`)
  await page.waitForTimeout(8000)
  await tap(page.locator('text=Quick Join').first(), `${label}：Quick Join`)
  await page.waitForTimeout(16000)
  const denom = page.locator('.btn_bet:not(.my-button--disabled)').first()
  await denom.click({ timeout: 6000 }).catch(() => denom.evaluate(el => el.click()).catch(() => {}))
  await page.waitForTimeout(5000)
  return machineName(page)
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null, page = null, reserved = false
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page)

  // ── ① 進 X 並預約 ────────────────────────────────────────────────────────
  const X = await enterMachine(page, 'X')
  check('① 進得了第一台', !!X, X)
  await tap(page.locator('.reserve').first(), '開預約面板')
  await page.waitForTimeout(4500)
  await tap(page.locator('.reserve-btn-long').first(), '🚨 Reserve Now（真的預約 X）')
  reserved = true
  await page.waitForTimeout(6000)

  // ── ② 離開 X ─────────────────────────────────────────────────────────────
  const left = await h5BackToLobby(page, { log: l => log({ exit: l }), reloadUrl: URL_H5 })
  check('② 離開 X（預約留著）', left.ok, left.steps.join(' → ').slice(0, 70))
  await page.waitForTimeout(6000)

  // ── ③ 進另一台 Y ─────────────────────────────────────────────────────────
  const Y = await enterMachine(page, 'Y', 3)   // ⚠️ 換一款遊戲，否則會被送回預約的那台
  check('③ 進得了第二台', !!Y, Y)
  log({ X, Y, 是不是同一台: X === Y })

  // ── ④ Reserved 分頁按 Join ───────────────────────────────────────────────
  await tap(page.locator('.reserve').first(), '開預約面板')
  await page.waitForTimeout(4500)
  await tap(page.locator('.reserved').first(), '切到 Reserved 分頁')
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/join-1-reserved-tab.png` })
  const joinState = await page.evaluate(() => {
    const el = document.querySelector('.join-btn')
    return el ? { cls: el.className.toString(), txt: (el.textContent ?? '').trim() } : null
  })
  log({ Join鍵: joinState })
  // ⚠️ 人在 X 裡面的時候 Join 是灰的（join-unable）；現在人在 Y，應該可以按
  check('④ Join 鍵可以按（不是 join-unable）', !!joinState && !/unable/i.test(joinState.cls), JSON.stringify(joinState))

  await tap(page.locator('.join-btn').first(), '按 Join（進已預約的 X）')
  await page.waitForTimeout(16000)
  await page.screenshot({ path: `${OUT}/join-2-after.png` })
  const now = await machineName(page)
  log({ 現在在哪台: now })
  // 🚨 真正的判準：**換到 X 了**，而不是還留在 Y
  check('⑤ 真的進到已預約的那台（X）', now === X && now !== Y, `X=${X}｜Y=${Y}｜現在=${now}`)

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  // 🚨 預約一定要收乾淨；`.reserve` 只在機台內點得到，所以要在還在機台裡的時候做
  try {
    if (page && reserved) {
      if (!h5InGame(page)) await enterMachine(page, '收尾', 3)
      if (!(await page.locator('.cancel-btn').count().catch(() => 0))) {
        await tap(page.locator('.reserve').first(), '收尾：開預約面板')
        await page.waitForTimeout(4000)
        await tap(page.locator('.reserved').first(), '收尾：切 Reserved 分頁')
        await page.waitForTimeout(4000)
      }
      let n = await page.locator('.cancel-btn').count().catch(() => 0)
      let guard = 0
      while (n > 0 && guard++ < 5) {
        await tap(page.locator('.cancel-btn').first(), '收尾：取消預約')
        await page.waitForTimeout(4000)
        if (await page.locator('.box-btn_text2').count().catch(() => 0)) {
          await tap(page.locator('.box-btn_text2').first(), '收尾：確認')
          await page.waitForTimeout(4000)
        }
        n = await page.locator('.cancel-btn').count().catch(() => 0)
      }
      log({ 收尾後剩下的預約: n })
    }
    if (page && h5InGame(page)) {
      const back = await h5BackToLobby(page, { log: l => log({ exit: l }), reloadUrl: URL_H5 })
      log({ exit: back.ok ? '✅ 已退出機台' : '❌ 退出失敗' })
    }
  } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

/**
 * 收乾淨：**把這支帳號名下所有預約取消掉**。
 *
 *   H5_URL='<帳號池 URL>' node scripts/ui-checks/h5-reserve-cleanup.mjs
 *
 * 🚨 為什麼獨立成一支：預約的入口 `.reserve` **只在機台內**，人在大廳時點不到。
 *    所以「跑完在大廳才想收尾」是收不掉的——實測就這樣漏過一次
 *    （收尾的 tap 回 FAIL，而我差點把「沒有 .cancel-btn」當成「沒有預約」）。
 *    正確做法：**先隨便進一台機台**，再開面板 → Reserved 分頁 → Cancel。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'
import { h5BackToLobby, h5InGame } from '../../server/uat-runner/h5-seat.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))
async function tap(locator, label) {
  try { await locator.click({ timeout: 7000 }); log({ tap: label, via: 'click' }); return true }
  catch {
    try { await locator.evaluate(el => el.click()); log({ tap: label, via: 'js' }); return true }
    catch { log({ tap: label, via: 'FAIL' }); return false }
  }
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null, page = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page)

  if (!h5InGame(page)) {
    await tap(page.locator('.grid-item').first(), '點第一張卡片')
    await page.waitForTimeout(8000)
    await tap(page.locator('text=Quick Join').first(), 'Quick Join')
    await page.waitForTimeout(16000)
  }
  if (!h5InGame(page)) { log({ fatal: '進不了機台，無法檢查預約' }); process.exit(1) }
  await tap(page.locator('.btn_bet:not(.my-button--disabled)').first(), '選面額')
  await page.waitForTimeout(5000)

  await tap(page.locator('.reserve').first(), '開預約面板')
  await page.waitForTimeout(4500)
  await tap(page.locator('.reserved').first(), '切到 Reserved 分頁')
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/cleanup-reserved-tab.png` })

  let n = await page.locator('.cancel-btn').count().catch(() => 0)
  log({ 目前名下的預約筆數: n })
  let guard = 0
  while (n > 0 && guard++ < 6) {
    await tap(page.locator('.cancel-btn').first(), `取消第 ${guard} 筆`)
    await page.waitForTimeout(4000)
    if (await page.locator('.box-btn_text2').count().catch(() => 0)) {
      await tap(page.locator('.box-btn_text2').first(), '確認取消')
      await page.waitForTimeout(4000)
    }
    n = await page.locator('.cancel-btn').count().catch(() => 0)
    log({ 剩下: n })
  }
  await page.screenshot({ path: `${OUT}/cleanup-after.png` })
  log(n === 0 ? '✅ 名下已經沒有預約' : `⚠️ 還剩 ${n} 筆沒取消掉`)
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  try {
    if (page && h5InGame(page)) {
      const back = await h5BackToLobby(page, { log: l => log({ exit: l }), reloadUrl: URL_H5 })
      log({ exit: back.ok ? '✅ 已退出機台' : '❌ 退出失敗' })
    }
  } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

/**
 * 機台內功能盤點 v2：選完面額之後，把下注／Cash Out／路單／歷史這些控制項量出來。
 *
 * ⚠️ **不按 SPIN。** 下注會動到餘額，那是有副作用的動作——盤點階段不需要，
 *    要不要真的下注等使用者確認（已在 Discord 問）。
 * ⚠️ 路單那張表會產生上百個 `child`（19,0 / 19,1 …）把清單洗掉，要濾掉。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const dumpControls = (page) => page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 6 && r.height > 6 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const out = []
  for (const el of document.querySelectorAll('div, span, button, img, i, a')) {
    if (!visible(el)) continue
    const cls = (el.className?.toString() ?? '').trim()
    if (!cls) continue
    // 路單格子：class 就叫 child、文字是 "19,3" 這種座標——濾掉，不然清單全是它
    if (cls === 'child' || /^\d+,\d+$/.test((el.textContent ?? '').trim())) continue
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!/btn|button|menu|icon|tab|close|switch|toggle|bet|spin|cash|denom|rule|road|history|quit|sound|cctv|top/i.test(cls)
      && !(txt && txt.length <= 16)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 320 && r.height > 320) continue
    out.push({ cls: cls.slice(0, 40), txt: txt.slice(0, 20), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  }
  const seen = new Set()
  return out.filter(o => { const k = o.cls + '|' + o.txt; if (seen.has(k)) return false; seen.add(k); return true })
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(11000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page, { onClose: c => console.log(JSON.stringify({ watcherClosed: c })) })

  /**
   * ⚠️ **H5 也有「上一輪的位子還佔著」這件事**（跟 PC UI 截圖那邊同一類問題）：
   *    上一支腳本進了機台沒退出，這次重新載入會**直接回到那台機台**（URL 已經是 /game）。
   *    不先判斷狀態就照流程點「遊戲卡片 → Quick Join」的話，會在大廳找不到東西而 timeout，
   *    症狀是 `locator.click: Timeout 15000ms exceeded`——看起來像選擇器壞了。
   */
  if (page.url().includes('/game')) {
    console.log(JSON.stringify({ step: 'already-in-game', note: '上一輪的位子還佔著，直接沿用' }))
  } else {
    const gameName = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    await page.locator(`.grid-item:has(.grid-item-name:text-is("${gameName.trim()}"))`).click({ timeout: 15000 })
    await page.waitForTimeout(8000)
    await page.locator(':text-is("Quick Join")').first().click({ timeout: 15000 })
    await page.waitForTimeout(14000)
  }
  console.log(JSON.stringify({ step: 'entered', url: page.url().includes('/game') ? '/game ✅' : page.url().slice(0, 60) }))

  // 選最小面額 ₱1（最小副作用；這一步只是讓機台進到可下注狀態，還沒下注）
  const denom = page.locator(':text-is("₱1")').first()
  const hasDenom = await denom.count()
  if (hasDenom) {
    await denom.click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(7000)
  }
  console.log(JSON.stringify({ step: 'denomination', found: !!hasDenom }))
  await page.screenshot({ path: `${OUT}/ingame-3-after-denom.png` })

  const controls = await dumpControls(page)
  console.log(JSON.stringify({ step: 'controls', count: controls.length }))
  for (const c of controls) console.log('  ' + JSON.stringify(c))
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

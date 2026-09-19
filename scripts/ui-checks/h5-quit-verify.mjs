// 機台內 header 那四顆按鈕沒有文字（標籤是圖），從畫面順序看最後一顆應該是 Quit。
// ⚠️ 不用猜的——直接點下去看 URL 會不會從 /game 回到 /lobby。
//    猜錯的代價是點到 Sound 或 CCTV，那種誤點在 log 上看不出來。
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const IDX = Number(process.env.IDX ?? 3)
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page)

  if (!page.url().includes('/game')) {
    const g = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    await page.locator(`.grid-item:has(.grid-item-name:text-is("${g.trim()}"))`).click({ timeout: 15000 })
    await page.waitForTimeout(8000)
    await page.locator(':text-is("Quick Join")').first().click({ timeout: 15000 })
    await page.waitForTimeout(14000)
  }
  console.log(JSON.stringify({ before: page.url().includes('/game') ? '/game' : '/lobby' }))
  if (!page.url().includes('/game')) { console.log('沒進到機台，這輪不算數'); process.exit(0) }

  /**
   * ⚠️ **進機台後第一件事一定是選面額。**「SELECT A DENOMINATION」面板會把整個畫面
   *    （含 header 的 Quit）都擋住——元素讀得到、就是點不動，症狀是 click timeout。
   * ⚠️ 目前選中的那顆面額是 `my-button--disabled`，點它一樣 timeout，所以挑沒被停用的。
   */
  /**
   * ⚠️ **先把已經開著的「Tips: Cash out credit」確認框關掉。**
   *    上一輪按過 Quit 之後這個框會留著，而它擋住整個畫面——
   *    這一輪的 denom 與 header 點擊全部 timeout 就是被它擋的，
   *    而錯誤訊息只寫 timeout，看不出畫面上其實有一個框。
   *    ⚠️ 按 Confirm 是把機台裡的 credit 退回餘額（正常動作），不是下注。
   */
  const pre = page.locator(':text-is("Confirm")').first()
  if (await pre.count()) {
    await pre.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(6000)
    console.log(JSON.stringify({ clearedPendingDialog: true, url: page.url().includes('/game') ? '/game' : '/lobby ✅' }))
  }

  const pick = page.locator('.btn_bet:not(.my-button--disabled)').first()
  if (await pick.count()) {
    await pick.click({ timeout: 10000 }).catch(e => console.log('denom click failed:', String(e).split('\n')[0].slice(0, 60)))
    await page.waitForTimeout(7000)
    console.log(JSON.stringify({ denomPicked: true }))
  }

  const items = page.locator('[class*="header_btn_item"]')
  const n = await items.count()
  console.log(JSON.stringify({ headerButtons: n, clicking: IDX }))
  await items.nth(IDX).click({ timeout: 10000 }).catch(e => console.log('click failed:', String(e).split('\n')[0].slice(0, 80)))
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/h5-quit-idx${IDX}.png` })
  console.log(JSON.stringify({ after: page.url().includes('/game') ? '還在 /game' : '回到 /lobby ✅' }))

  const confirm = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('button, [class*="btn"], [class*="button"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 12 || r.width > 320) continue
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!txt || txt.length > 20) continue
      out.push({ cls: (el.className?.toString() ?? '').slice(0, 36), txt })
    }
    const seen = new Set()
    return out.filter(o => { const k = o.cls + o.txt; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 12)
  })
  console.log(JSON.stringify({ visibleButtons: confirm }))
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
} finally {
  try { stop?.() } catch {}
  await browser.close()
}

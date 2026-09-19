/**
 * 找出 H5 機台內「Quit（退出回大廳）」的選擇器，以及退出流程有幾步。
 *
 * 為什麼要找：H5 跟 PC 一樣有「上一輪的位子還佔著」的問題——
 * 上一個 run 沒退出，下一個 run 重新載入會直接掉回機台（URL 是 /game），
 * 於是所有大廳積木都找不到元素（實測 3/4/6/9 四步全掛，而機台內的 12～19 全過）。
 * 要修就得先知道怎麼退。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
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
  console.log(JSON.stringify({ startUrl: page.url().includes('/game') ? '/game（還在機台裡）' : '/lobby' }))

  // 不在機台裡就先進去一台，否則沒有 Quit 可以量
  if (!page.url().includes('/game')) {
    const gameName = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    await page.locator(`.grid-item:has(.grid-item-name:text-is("${gameName.trim()}"))`).click({ timeout: 15000 })
    await page.waitForTimeout(8000)
    await page.locator(':text-is("Quick Join")').first().click({ timeout: 15000 })
    await page.waitForTimeout(14000)
    console.log(JSON.stringify({ entered: page.url().includes('/game') ? '/game ✅' : '進不去' }))
  }

  // 把 header 那排按鈕全部倒出來，含圖片 alt/src 尾段，才認得出哪顆是 Quit
  const header = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('[class*="header"] *, [class*="Header"] *')) {
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8 || r.width > 120) continue
      const cls = (el.className?.toString() ?? '').trim()
      if (!cls) continue
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 14)
      const src = el.tagName === 'IMG' ? (el.getAttribute('src') ?? '').split('/').pop()?.slice(0, 30) : ''
      out.push({ tag: el.tagName, cls: cls.slice(0, 40), txt, src, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    }
    const seen = new Set()
    return out.filter(o => { const k = o.cls + o.txt + o.src; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 25)
  })
  console.log(JSON.stringify({ header }, null, 1).slice(0, 2200))

  // header 的每一顆都倒出來（含內部文字與圖檔名），才認得出哪顆是 Quit
  const headerItems = await page.evaluate(() => {
    const out = []
    document.querySelectorAll('[class*="header_btn_item"]').forEach((el, i) => {
      const r = el.getBoundingClientRect()
      const img = el.querySelector('img')
      out.push({
        i, cls: (el.className?.toString() ?? '').slice(0, 40),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20),
        img: img ? (img.getAttribute('src') ?? '').split('/').pop()?.slice(0, 40) : '',
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      })
    })
    return out
  })
  console.log(JSON.stringify({ headerItems }))

  // 直接找文字是 Quit 的元素
  const quit = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div, span, button, a')) {
      const t = (el.textContent ?? '').trim()
      if (!/^(quit|退出|離開|离开)$/i.test(t)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      return { cls: (el.className?.toString() ?? '').slice(0, 50), txt: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }
    return null
  })
  console.log(JSON.stringify({ quitElement: quit }))

  if (quit) {
    await page.mouse.click(quit.x, quit.y)
    await page.waitForTimeout(5000)
    await page.screenshot({ path: `${OUT}/h5-quit-1.png` })
    console.log(JSON.stringify({ afterQuitClick: page.url().includes('/game') ? '還在 /game（可能跳了確認框）' : '已回 /lobby' }))
    // 退出常常要再確認一次，把可見的短文字按鈕倒出來
    const buttons = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('button, [class*="btn"], [class*="button"]')) {
        const r = el.getBoundingClientRect()
        if (r.width < 20 || r.height < 12 || r.width > 320) continue
        const st = getComputedStyle(el)
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue
        const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (!txt || txt.length > 20) continue
        out.push({ cls: (el.className?.toString() ?? '').slice(0, 40), txt, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      }
      const seen = new Set()
      return out.filter(o => { const k = o.cls + o.txt; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 15)
    })
    console.log(JSON.stringify({ confirmButtons: buttons }, null, 1).slice(0, 1600))
  }
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

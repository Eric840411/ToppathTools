/**
 * H5 大廳那張整頁 JACKPOT 彈窗——到底要點哪裡才關得掉？
 *
 * ⚠️ 現成的 `dismissUiScreenshotPopups` 關不掉它：那支找的是文字剛好等於
 *    YES/CONFIRM/確定 的按鈕（機台內的面額選單與 Tips 錯誤框），
 *    而這張彈窗上只有「PLAY NOW」跟一個 ✕。
 * ⚠️ **絕對不能點 PLAY NOW**——那會直接進機台，把「關彈窗」變成一個有副作用的動作。
 */
import { chromium } from 'playwright'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(12000)

  const dump = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
    }
    // 先找蓋住畫面的那一層：面積 > 視窗一半、z-index 高
    const overlays = []
    for (const el of document.querySelectorAll('div, section')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      const z = Number(getComputedStyle(el).zIndex) || 0
      if (r.width * r.height > innerWidth * innerHeight * 0.5 && z > 0) {
        overlays.push({ cls: el.className?.toString().slice(0, 60), z, w: Math.round(r.width), h: Math.round(r.height) })
      }
    }
    // 彈窗裡可能是關閉鍵的小元素
    const closers = []
    for (const el of document.querySelectorAll('div, span, i, img, button, [class*=close], [class*=Close]')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width > 80 || r.height > 80) continue
      const cls = el.className?.toString() ?? ''
      const txt = (el.textContent ?? '').trim().slice(0, 12)
      const looksClose = /close|shut|guanbi|cancel/i.test(cls) || ['✕', '×', 'X', 'x'].includes(txt)
      if (!looksClose) continue
      closers.push({ tag: el.tagName, cls: cls.slice(0, 60), txt, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) })
    }
    const playNow = [...document.querySelectorAll('*')].filter(e => visible(e) && /play\s*now/i.test((e.textContent ?? '').trim()) && (e.textContent ?? '').trim().length < 20)
      .map(e => ({ tag: e.tagName, cls: e.className?.toString().slice(0, 50) })).slice(0, 3)
    return { overlays: overlays.slice(0, 6), closers: closers.slice(0, 12), playNow }
  })
  console.log(JSON.stringify(dump, null, 1))
  await page.screenshot({ path: `${OUT}/h5-lobby-popup.png` })
} finally { await browser.close() }

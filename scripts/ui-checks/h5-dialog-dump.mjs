/**
 * 把「Tips: Cash out credit」那個框的 DOM 整塊倒出來。
 *
 * 為什麼要倒：我用 `:text-is("Confirm")` 命中 0，但畫面上那顆按鈕就寫著 Confirm——
 * 代表文字不是直接掛在那個元素上（可能有空白、巢狀、或用的是別的字）。
 * **不量清楚就不要寫選擇器**，猜一個座標點下去，點到 Sound 或 CCTV 在 log 上看不出來。
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
  console.log(JSON.stringify({ url: page.url().includes('/game') ? '/game' : '/lobby' }))

  // 找出「畫面上文字含 Cash out / Tips」的那一塊，把它整棵樹印出來
  const tree = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      return r.width > 8 && r.height > 8 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
    }
    let root = null
    for (const el of document.querySelectorAll('div, section')) {
      if (!visible(el)) continue
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!/cash\s*out|Tips/i.test(t)) continue
      if (t.length > 120) continue   // 取最貼近的那一層，不要整頁
      root = el
    }
    if (!root) return { found: false }
    const lines = []
    const walk = (el, d) => {
      if (d > 6) return
      const r = el.getBoundingClientRect()
      lines.push({
        d, tag: el.tagName,
        cls: (el.className?.toString() ?? '').slice(0, 46),
        text: (el.childElementCount === 0 ? (el.textContent ?? '') : '').replace(/\s+/g, ' ').trim().slice(0, 24),
        vis: visible(el),
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
      })
      for (const c of el.children) walk(c, d + 1)
    }
    walk(root, 0)
    return { found: true, rootCls: (root.className?.toString() ?? '').slice(0, 50), lines: lines.slice(0, 40) }
  })
  console.log(JSON.stringify(tree, null, 1).slice(0, 3000))
  await page.screenshot({ path: `${OUT}/h5-dialog-dump.png` })
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

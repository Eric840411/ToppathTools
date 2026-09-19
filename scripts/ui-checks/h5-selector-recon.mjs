// 盤點 H5 大廳目前實際存在的選擇器，作為等一下組 UAT 積木的依據。
// 不從記憶或舊腳本抄——選擇器會隨改版漂掉，要以現場為準。
import { chromium } from 'playwright'
const URL = process.env.H5_URL
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  const out = await page.evaluate(() => {
    const classCount = new Map()
    for (const el of document.querySelectorAll('*')) {
      for (const c of el.classList) {
        if (/^(is-|has-)/.test(c)) continue
        classCount.set(c, (classCount.get(c) ?? 0) + 1)
      }
    }
    const top = [...classCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40)
    const names = [...document.querySelectorAll('[class*=name]')].slice(0, 6).map(e => ({ cls: e.className, txt: (e.textContent ?? '').trim().slice(0, 30) }))
    const ids = [...document.querySelectorAll('[id]')].slice(0, 20).map(e => e.id)
    return { top, names, ids, cards: document.querySelectorAll('[class*=grid-item]').length }
  })
  console.log(JSON.stringify(out, null, 1).slice(0, 2600))
} finally { await browser.close() }

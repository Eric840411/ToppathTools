// QAT 帳號池的 URL 寫的是 platform=pc，但 device=mobile——實際開出來到底是 H5 還是 PC？
// 不先確認就直接拿去跑 H5 流程，等於整晚在錯的 client 上測。
import { chromium } from 'playwright'

const URL = process.env.H5_URL
const [w, h] = (process.env.SIZE ?? '500x877').split('x').map(Number)
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(15000)
  const info = await page.evaluate(() => ({
    url: location.href.replace(/token=[^&]*/, 'token=<REDACTED>'),
    title: document.title,
    canvases: document.querySelectorAll('canvas').length,
    hasCc: typeof window.cc !== 'undefined',
    gridItems: document.querySelectorAll('#grid_gm_item, .grid-item, [class*=grid-item]').length,
    bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
    iframes: document.querySelectorAll('iframe').length,
  }))
  console.log(JSON.stringify(info, null, 1))
  await page.screenshot({ path: `${OUT}/h5-url-probe.png`, fullPage: false })
} finally { await browser.close() }

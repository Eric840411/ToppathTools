/**
 * 用真的瀏覽器操作 UAT 工具自己的畫面（不是打 API）。
 * 這一支先把「登入 → UAT 頁 → H5 分頁 → 腳本編輯器」這條路上的選擇器盤出來。
 *
 * 使用者 2026-09-19 明確要求：要在前端實際操作，不能單純打 API。
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const EMAIL = process.env.EMAIL ?? 'lusa@toppath.tw'
const OUT = process.env.OUT ?? '.'

const snap = (page, name) => page.screenshot({ path: `${OUT}/uatui-${name}.png`, fullPage: false })

const dumpInteractive = (page, limit = 40) => page.evaluate((lim) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 6 && r.height > 6 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const out = []
  for (const el of document.querySelectorAll('button, a, [role="button"], input, select, textarea, [class*="tab"]')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    out.push({
      tag: el.tagName,
      cls: (el.className?.toString() ?? '').slice(0, 40),
      txt: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
      ph: el.getAttribute?.('placeholder') ?? '',
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
    })
  }
  const seen = new Set()
  return out.filter(o => { const k = o.tag + o.cls + o.txt + o.ph; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, lim)
}, limit)

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(4000)
  await snap(page, '1-landing')
  console.log(JSON.stringify({ step: 'landing', title: await page.title(), url: page.url() }))

  // 登入：帳號清單上標「開」的是沒設 PIN 的（使用者說本機誰都能執行）
  const card = page.locator(`text=${EMAIL}`).first()
  if (await card.count()) {
    await card.click({ timeout: 10000 })
    await page.waitForTimeout(3500)
    console.log(JSON.stringify({ step: 'login', clicked: EMAIL }))
  }
  await snap(page, '2-after-login')

  // 側邊導覽列：找 UAT 那一項
  const navs = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar-nav-item, nav button, aside button'))
    .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24))
    .filter(Boolean).slice(0, 40))
  console.log(JSON.stringify({ navItems: navs }))
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
} finally {
  await browser.close()
}

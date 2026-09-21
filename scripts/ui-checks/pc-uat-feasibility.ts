/**
 * PC（Cocos）能不能用 UAT 的積木測？**先量，再決定要不要寫腳本。**
 *
 *   PC_URL='<PC 版 token URL>' npx tsx scripts/ui-checks/pc-uat-feasibility.ts
 *
 * H5 那五份腳本靠的是 DOM 選擇器（`.grid-item`／`.btn_spin`…）。PC 版整個畫面是一張
 * canvas，**同一套做法照抄過去會全部命中 0**，而且看起來像選擇器寫錯。
 * 所以先量三件事，決定 PC 的腳本能長什麼樣：
 *
 *   ① DOM 裡到底有什麼（有沒有任何可用的選擇器，還是只有一張 canvas）
 *   ② 載入大廳時打了哪些 HTTP API（`assert_api_called` 是**唯一不受渲染方式影響**的斷言）
 *   ③ Cocos 場景樹讀不讀得到機台座標（讀得到的話 `click_xy` 就有依據，不必用猜的）
 */
import { chromium } from 'playwright'
import { pcInstallEvalShim, pcWaitLobby, pcSceneName, pcScanLobby, describePcLobby } from '../../server/lib/pc-cocos.js'

const PC_URL = process.env.PC_URL ?? ''
const OUT = process.env.OUT ?? '.'
if (!PC_URL) { console.log('要給 PC_URL'); process.exit(1) }

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()

  // ② 載入期間的 HTTP 請求（只留後端 API，靜態資源不看）
  const apis = new Map<string, number>()
  page.on('request', r => {
    const u = r.url()
    if (/\.(png|jpg|jpeg|webp|gif|mp3|mp4|ttf|woff2?|js|css|json)(\?|$)/i.test(u)) return
    const key = u.split('?')[0].replace(/^https?:\/\//, '').slice(0, 90)
    apis.set(key, (apis.get(key) ?? 0) + 1)
  })

  await page.goto(PC_URL, { timeout: 60_000 })
  await pcInstallEvalShim(page)
  let diag = await pcWaitLobby(page, 25_000)
  if (!diag.ready) { await page.goto(PC_URL, { timeout: 30_000 }).catch(() => {}); diag = await pcWaitLobby(page, 40_000) }
  console.log('① 大廳狀態：', describePcLobby(diag), '場景=', await pcSceneName(page))

  // ① DOM 盤點
  const dom = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width > 8 && r.height > 8
    }
    const all = [...document.querySelectorAll('div, span, button, img, a, canvas')]
    const withClass = all.filter(e => visible(e) && (e.className?.toString() ?? '').trim())
    return {
      totalElements: document.querySelectorAll('*').length,
      visibleWithClass: withClass.length,
      canvases: [...document.querySelectorAll('canvas')].map(c => { const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }),
      sampleClasses: withClass.slice(0, 12).map(e => (e.className?.toString() ?? '').trim().slice(0, 40)),
    }
  })
  console.log('② DOM：', JSON.stringify(dom))

  // ③ 場景樹讀得到的機台
  const machines = await pcScanLobby(page)
  console.log('③ 場景樹掃到機台：', machines.length, '台｜前 3 台：', JSON.stringify(machines.slice(0, 3)).slice(0, 220))

  console.log('④ 載入期間打到的後端（次數）：')
  ;[...apis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([u, c]) => console.log(`   ${c}×  ${u}`))

  await page.screenshot({ path: `${OUT}/pc-uat-lobby.png` })
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
  process.exitCode = 1
} finally {
  await browser.close()
}

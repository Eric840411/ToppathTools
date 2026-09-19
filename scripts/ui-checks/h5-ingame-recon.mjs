/**
 * 進到 H5 機台裡面，盤點「機台內功能」實際有哪些、選擇器長什麼樣。
 * 使用者要求要測機台內的所有功能，但功能清單不能用猜的——先量出來再寫測試。
 *
 * ⚠️ 大廳點卡片只會到「該遊戲的機台列表頁」，還要再挑一台沒人的才會真的進機台。
 * ⚠️ 中獎彈窗會一直冒，全程要有看門狗盯著關（見 lobby-popup.js）。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const dumpClickables = (page) => page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 6 && r.height > 6 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const out = []
  for (const el of document.querySelectorAll('div, span, button, img, i, a')) {
    if (!visible(el)) continue
    const cls = (el.className?.toString() ?? '').trim()
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!cls) continue
    // 只留看起來像可互動的（class 有 btn/menu/icon/tab，或本身文字很短像個按鈕）
    if (!/btn|button|menu|icon|tab|item|close|switch|toggle/i.test(cls) && !(txt && txt.length <= 14)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 300 && r.height > 300) continue
    out.push({ cls: cls.slice(0, 44), txt: txt.slice(0, 18), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  }
  // 同 class 只留一筆，避免洗版
  const seen = new Set()
  return out.filter(o => { const k = o.cls + '|' + o.txt; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 60)
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(11000)
  console.log(JSON.stringify(await dismissLobbyPopups(page)))
  stop = startLobbyPopupWatcher(page, { onClose: c => console.log(JSON.stringify({ watcherClosed: c })) })

  // 1) 大廳 → 遊戲分頁
  const gameName = await page.locator('.grid-item-name').first().innerText().catch(() => '')
  await page.locator(`.grid-item:has(.grid-item-name:text-is("${gameName.trim()}"))`).click({ timeout: 15000 })
  await page.waitForTimeout(8000)
  console.log(JSON.stringify({ step: 'game-page', game: gameName.trim(), url: page.url().replace(/token=[^&]*/, 'token=<R>') }))
  await page.screenshot({ path: `${OUT}/ingame-1-gamepage.png` })

  // 2) 點卡片會開一個 **Game Preview** 面板（不是直接進機台）：
  //    上面有機台狀態按鈕（被佔用時是灰的 Occupied）、Audience Mode、Quick Join。
  //    要穩定進到一台沒人的，**用 Quick Join 讓系統挑**，
  //    自己從卡片列表猜哪一台空著實測會挑到 Occupied 的。
  const quick = page.locator(':text-is("Quick Join")').first()
  if (await quick.count()) {
    await quick.click({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(14000)
    await page.screenshot({ path: `${OUT}/ingame-2-entered.png` })
    console.log(JSON.stringify({ step: 'after-quick-join', url: page.url().replace(/token=[^&]*/, 'token=<R>') }))
    const items = await dumpClickables(page)
    console.log(JSON.stringify({ step: 'ingame-clickables', count: items.length }))
    for (const it of items) console.log('  ' + JSON.stringify(it))
  } else {
    console.log(JSON.stringify({ step: 'quick-join', found: false }))
  }
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

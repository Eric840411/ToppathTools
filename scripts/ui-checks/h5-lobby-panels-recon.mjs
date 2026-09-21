/**
 * H5 大廳「入口 → 面板」的選擇器盤點——為了把更多 TC 變成可執行的腳本。
 *
 *   H5_URL='<帳號池 URL>' OUT=<目錄> node scripts/ui-checks/h5-lobby-panels-recon.mjs
 *
 * TC 表上一大批是「打開某某頁面，確認內容正確」：積分（Reward Point）／排行榜（Ranking）／
 * 投注明細（History）／充值（Top Up）／Me・最愛・最近遊玩／News／Video／Lucky Bonus 寶箱。
 * 這些的**打得開**可以自動驗，**內容對不對**要人眼——所以先量「入口的選擇器」與
 * 「打開後畫面上出現什麼」，才寫得出「點入口 → 斷言面板出現 → 截圖存證」。
 *
 * ⚠️ `.menu-item` **不是導覽列**，是 42 款遊戲的分類清單（第一版誤判了）。
 *    真正的入口是上排五顆圖示（Reward Point／Top Up／Ranking／History／Return）
 *    與下排五個分頁（Me／Live Slots／Quick Join／News／Video）。
 * ⚠️ **不點 PLAY NOW／Quick Join／機台卡片**——那些會真的進機台，是有副作用的動作。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

/** 找「文字剛好是這個」的可見元素，回報它自己與往上兩層的 class——選擇器要挑最穩的那層 */
const findEntry = (page, text) => page.evaluate((t) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 6 && r.height > 6 && st.display !== 'none' && st.visibility !== 'hidden'
  }
  const hits = []
  for (const el of document.querySelectorAll('div, span, button, a, li, img')) {
    if (!visible(el)) continue
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (txt !== t) continue
    const chain = []
    let p = el
    for (let i = 0; i < 3 && p; i++) { chain.push((p.className?.toString() ?? p.tagName).trim().slice(0, 36)); p = p.parentElement }
    const r = el.getBoundingClientRect()
    hits.push({ chain, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  }
  return hits.slice(0, 3)
}, text)

/** 面板打開後畫面上多了什麼 */
const dump = (page) => page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 40 && r.height > 20 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const out = []
  for (const el of document.querySelectorAll('div, span, button, li')) {
    if (!visible(el)) continue
    const cls = (el.className?.toString() ?? '').trim()
    if (!cls || cls === 'child') continue
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (/^\d+,\d+$/.test(txt)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 470 && r.height > 800) continue
    out.push({ cls: cls.slice(0, 38), txt: txt.slice(0, 26) })
  }
  const seen = new Set()
  return out.filter(o => { const k = o.cls; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 22)
})

/** 上排圖示 ＋ 下排分頁。⚠️ Quick Join 不在清單裡——它會進機台 */
const ENTRIES = ['Reward Point', 'Top Up', 'Ranking', 'History', 'Return', 'Me', 'Live Slots', 'News', 'Video']

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page, { onClose: c => log({ popup: c }) })
  if (page.url().includes('/game')) { log({ fatal: '上一輪還在機台裡，先退出再跑' }); process.exit(1) }
  await page.screenshot({ path: `${OUT}/panels-0-lobby.png` })

  // ── 先把每個入口的選擇器量出來 ──────────────────────────────────────────
  for (const t of ENTRIES) {
    const hits = await findEntry(page, t)
    log({ entry: t, hits: hits.length })
    hits.forEach(h => console.log('      ' + JSON.stringify(h)))
  }

  // ── 再逐個點開、dump、截圖、關掉 ────────────────────────────────────────
  for (const t of ENTRIES) {
    if (t === 'Return') continue   // ⚠️ Return 會離開 OSM 回 CP，點了就回不來
    const loc = page.locator(`text=${t}`).first()
    const ok = await loc.click({ timeout: 6000 }).then(() => true).catch(() => loc.evaluate(el => el.click()).then(() => true).catch(() => false))
    await page.waitForTimeout(4000)
    const inGame = page.url().includes('/game')
    log({ open: t, clicked: ok, where: inGame ? '⚠️ 竟然進到機台了' : 'lobby' })
    await page.screenshot({ path: `${OUT}/panel-${t.replace(/\W/g, '')}.png` })
    if (inGame) break
    for (const c of await dump(page)) console.log('      ' + JSON.stringify(c))
    // 關掉：先找關閉鍵，再退一步用 Live Slots 回大廳
    const close = page.locator('.closeBtn, .close-btn, .van-popup__close-icon, .btn_close').first()
    if (await close.count()) await close.click({ timeout: 4000 }).catch(() => {})
    else await page.locator('text=Live Slots').first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(2500)
  }
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

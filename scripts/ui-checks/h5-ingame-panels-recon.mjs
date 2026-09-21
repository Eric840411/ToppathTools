/**
 * H5 **機台內**那幾個面板的選擇器盤點（寶箱／最愛／下注記錄／預約 Reserve）。
 *
 *   H5_URL='<帳號池 URL>' OUT=<目錄> node scripts/ui-checks/h5-ingame-panels-recon.mjs
 *
 * TC 表的「機台內」那一組有一半是這些面板（`機台內 寶箱打開 最愛點開 …`、
 * `寶箱打開 下注記錄打開`、`預約Reserve 頁面 …`）。跟大廳那批同樣的做法：
 * 先量「入口在哪、打開後出現什麼」，才寫得出「點入口 → 斷言面板 → 截圖存證」。
 *
 * ⚠️ 會真的進機台（佔位子），跑完會退出。**跑之前先鎖帳號。**
 * ⚠️ **不按 SPIN、不帶入額度**——盤點不需要動到餘額。
 * ⚠️ 進機台後第一件事是選面額，否則整個畫面（含 header）都點不動。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'
import { h5BackToLobby, h5InGame } from '../../server/uat-runner/h5-seat.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

async function tap(locator, label) {
  try { await locator.click({ timeout: 7000 }); log({ tap: label, via: 'click' }); return true }
  catch {
    try { await locator.evaluate(el => el.click()); log({ tap: label, via: 'js' }); return true }
    catch (e) { log({ tap: label, via: 'FAIL', err: String(e).split('\n')[0].slice(0, 80) }); return false }
  }
}

/** 畫面上看得見、有 class 的元素（路單會產生上百個 `child`，要濾掉） */
const dump = (page) => page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('div, span, button, li')) {
    const cls = (el.className?.toString?.() ?? '').trim()
    if (!cls || cls === 'child') continue
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    if (r.width < 30 || r.height < 14 || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue
    if (r.width > 470 && r.height > 800) continue
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (/^\d+,\d+$/.test(txt)) continue
    out.push({ cls: cls.slice(0, 42), txt: txt.slice(0, 24) })
  }
  const seen = new Set()
  return out.filter(o => { if (seen.has(o.cls)) return false; seen.add(o.cls); return true }).slice(0, 26)
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page, { onClose: c => log({ popup: c }) })

  if (!h5InGame(page)) {
    await tap(page.locator('.grid-item').first(), '第一張遊戲卡片')
    await page.waitForTimeout(8000)
    await tap(page.locator('text=Quick Join').first(), 'Quick Join')
    await page.waitForTimeout(16000)
  }
  if (!h5InGame(page)) { log({ fatal: '沒進到機台' }); process.exit(1) }
  await tap(page.locator('.btn_bet:not(.my-button--disabled)').first(), '選面額（不選的話畫面點不動）')
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/ingame-0-base.png` })
  const base = new Set((await dump(page)).map(o => o.cls))

  // ── 先把控制列那一排「有哪些東西、各在哪」量出來 ──────────────────────
  //
  // ⚠️ 實測 `.btn_custom` 打開的是**遊戲規則頁**（HIGHLIGHTS／PAYS／RULES），
  //    不是寶箱。寶箱是控制列**最左邊**那顆小圖示——它沒有文字，只能靠位置認。
  const row = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('div, span, button, img')) {
      const cls = (el.className?.toString?.() ?? '').trim()
      if (!cls || cls === 'child') continue
      const r = el.getBoundingClientRect()
      if (r.width < 16 || r.height < 16 || r.y < 640 || r.y > 730) continue
      out.push({ cls: cls.slice(0, 40), txt: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 16), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    }
    const seen = new Set()
    return out.filter(o => { const k = o.cls + o.x; if (seen.has(k)) return false; seen.add(k); return true }).sort((a, b) => a.x - b.x).slice(0, 20)
  })
  console.log('控制列（y 640~730，依 x 排序）：')
  row.forEach(r => console.log('   ' + JSON.stringify(r)))

  // ── 預約 Reserve：控制列上的 `.reserve`（實測量到的）────────────────────
  //
  // 🚨 **只開面板、只看，不按 Reserve Now。** 真的預約下去會佔掉一個預約名額、別人看得到，
  //    那是有副作用的動作——盤點階段不做。要不要真的預約由使用者決定。
  const ok = await tap(page.locator('.reserve').first(), '開預約 Reserve 面板')
  await page.waitForTimeout(5000)
  log({ open: 'reserve', clicked: ok })
  await page.screenshot({ path: `${OUT}/ingame-reserve.png` })
  console.log('   打開後新出現的：')
  ;(await dump(page)).filter(o => !base.has(o.cls)).forEach(o => console.log('      ' + JSON.stringify(o)))
  console.log('   畫面文字：', (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())).slice(0, 420))
  // 面板裡的分頁／按鈕（Reserve Now／Reserved／Cancel Reservation）
  const btns = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('div, span, button')) {
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!/^(Reserve Now|Reserved|Cancel Reservation|Reserve|Join|Cancel)$/i.test(txt)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 12) continue
      out.push({ cls: (el.className?.toString?.() ?? '').trim().slice(0, 40), txt, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    }
    const seen = new Set()
    return out.filter(o => { const k = o.cls + o.txt; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 14)
  })
  console.log('   面板上的按鈕／分頁：')
  btns.forEach(b => console.log('      ' + JSON.stringify(b)))
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  // 位子一定要放掉
  try {
    const page = browser.contexts()[0]?.pages()[0]
    if (page && h5InGame(page)) {
      const back = await h5BackToLobby(page, { log: (l) => log({ exit: l }) })
      log({ exit: back.ok ? '已退出機台' : '退出失敗' })
    }
  } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

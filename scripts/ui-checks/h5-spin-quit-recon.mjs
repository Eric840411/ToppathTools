/**
 * H5 機台內**還沒量過的那兩段**：① 帶入額度之後的轉動控制（SPIN）、② Cash Out + Quit 收尾。
 *
 * 為什麼要有這支（接 `h5-bet-flow.mjs` 之後）：
 *   ① SPIN 的控制項是**帶入額度之後才出現**的，所以只能在買入之後當場量，不能先寫死一個猜的。
 *   ② H5 收尾沒放掉位子 → 下一輪重新載入會直接掉回 /game，大廳積木全部命中 0。
 *      要修得先知道退出框那顆 Confirm 的**真實選擇器**（`:text-is("Confirm")` 實測命中 0）。
 *
 * ⚠️ 這支**會動到餘額**（買入 88 Credits、真的按 SPIN）。用 QAT 帳號池帳號，跑之前先鎖帳號。
 * ⚠️ 每一步都要 dump + 截圖。H5 這一段的失敗幾乎都長成「什麼都沒發生」，
 *    不留證據的話分不出是「沒點到」還是「點到了但機台沒反應」。
 *
 * 跑法：H5_URL='<帳號池 URL>' OUT=<目錄> node scripts/ui-checks/h5-spin-quit-recon.mjs
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const log = (o) => console.log(JSON.stringify(o))

/**
 * ⚠️ 一般 click 在這個畫面**會 timeout 但不是選擇器錯**——面額托盤／彈窗會蓋在按鈕上攔截
 *    pointer events，Playwright 會一路等到逾時，錯誤訊息完全看不出是被蓋住（v4.224.0 那個 bug）。
 *    所以退到 `el.click()`（JS 事件）。**不退到座標**——座標會真的按下去，把「不知道點哪」變成看不見的誤點。
 */
async function tap(locator, label) {
  try { await locator.click({ timeout: 8000 }); log({ tap: label, via: 'click' }); return true }
  catch {
    try { await locator.evaluate(el => el.click()); log({ tap: label, via: 'js(被蓋住)' }); return true }
    catch (e) { log({ tap: label, via: 'FAIL', err: String(e).split('\n')[0].slice(0, 90) }); return false }
  }
}

/** 畫面上讀得到的錢。⚠️ 按了沒反應跟按了有反應，在畫面上都是「什麼都沒發生」，只有這組數字分得出來。 */
const readMoney = (page) => page.evaluate(() => {
  const all = (document.body?.innerText ?? '').replace(/\s+/g, ' ')
  return {
    credit: all.match(/CREDIT[^0-9]*([\d,\.]+)/i)?.[1] ?? null,
    win: all.match(/WIN[^0-9]*([\d,\.]+)/i)?.[1] ?? null,
    bet: all.match(/BET[^0-9]*([\d,\.]+)/i)?.[1] ?? null,
  }
})

/** 把畫面上**所有看得見、有 class 的**控制項倒出來。不預先過濾關鍵字——要找的東西還不知道叫什麼。 */
const dumpAll = (page, filterRe) => page.evaluate((reSrc) => {
  const re = reSrc ? new RegExp(reSrc, 'i') : null
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 8 && r.height > 8 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const out = []
  for (const el of document.querySelectorAll('div, span, button, img, a, canvas')) {
    if (!visible(el)) continue
    const cls = (el.className?.toString() ?? '').trim()
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!cls && !txt) continue
    if (cls === 'child' || /^\d+,\d+$/.test(txt)) continue     // 路單會產生上百個
    if (re && !re.test(cls) && !re.test(txt)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 460 && r.height > 700) continue              // 整頁容器，沒有資訊量
    out.push({ cls: cls.slice(0, 46), txt: txt.slice(0, 26), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) })
  }
  const seen = new Set()
  return out.filter(o => { const k = o.cls + '|' + o.txt; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 40)
}, filterRe ?? null)

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  // WS 是唯一能證明「server 真的收到動作」的東西——按鈕點到了但沒送出，畫面上看不出來
  page.on('console', m => { const t = m.text(); if (/clickAction|dealGMAction|moneyNtc|isspin/i.test(t)) log({ console: t.slice(0, 160) }) })

  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page, { onClose: c => log({ popup: c }) })

  // ── 進機台（上一輪沒退出的話會直接掉在 /game，那本身就是 bug ② 的證據）────────
  const landedInGame = page.url().includes('/game')
  log({ step: '0-載入', url: landedInGame ? '/game（⚠️ 上一輪的位子還佔著）' : '/lobby' })
  if (!landedInGame) {
    const g = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    await page.locator(`.grid-item:has(.grid-item-name:text-is("${g.trim()}"))`).click({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(8000)
    await page.locator(':text-is("Quick Join")').first().click({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(15000)
  }
  if (!page.url().includes('/game')) { log({ fatal: '沒進到機台' }); process.exit(1) }
  await page.screenshot({ path: `${OUT}/sq-1-entered.png` })
  log({ step: '1-在機台內', money: await readMoney(page) })

  // ── 選面額（被托盤蓋住，一般 click 必 timeout）────────────────────────────────
  await tap(page.locator('.btn_bet:not(.my-button--disabled)').first(), '面額')
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/sq-2-denom.png` })
  log({ step: '2-選面額', money: await readMoney(page) })

  // ── 帶入額度（會動到餘額）────────────────────────────────────────────────────
  const moneyBefore = await readMoney(page)
  await tap(page.locator('.btn_play').first(), '帶入額度(88 Credits)')
  await page.waitForTimeout(9000)
  await page.screenshot({ path: `${OUT}/sq-3-buyin.png` })
  const moneyAfterBuy = await readMoney(page)
  log({ step: '3-帶入額度', before: moneyBefore, after: moneyAfterBuy })

  // ── ① 買入之後才出現的控制項：SPIN 到底長什麼樣 ──────────────────────────────
  log({ step: '4-買入後控制項(全部)' })
  for (const c of await dumpAll(page)) console.log('   ' + JSON.stringify(c))
  log({ step: '4b-只看像 spin/start/play/max 的' })
  for (const c of await dumpAll(page, 'spin|start|play|max|auto|go\\b')) console.log('   ' + JSON.stringify(c))
  // canvas（Galacean）如果是唯一的轉動入口，要知道它在哪、多大
  log({ step: '4c-canvas', canvases: await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => { const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })) })
  log({ step: '4d-frames', frames: page.frames().map(f => f.url().slice(0, 80)) })

  // ── ② 收尾：Cash Out → Quit，把退出框整個倒出來 ──────────────────────────────
  await tap(page.locator('.btn_cashout').first(), 'Cash Out')
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/sq-5-cashout.png` })
  log({ step: '5-Cash Out 後', money: await readMoney(page) })
  log({ step: '5b-Cash Out 後畫面上的框' })
  for (const c of await dumpAll(page, 'confirm|cancel|ok|yes|tips|dialog|popup|cash')) console.log('   ' + JSON.stringify(c))

  // header 最後一顆 = Quit（畫面順序 Top Up／CCTV／Sound／Quit，已由 h5-quit-verify 驗過）
  const headerBtns = page.locator('.header_btn_item')
  log({ step: '6-header 按鈕數', n: await headerBtns.count() })
  await tap(headerBtns.last(), 'Quit(header 最後一顆)')
  await page.waitForTimeout(5000)
  await page.screenshot({ path: `${OUT}/sq-6-quit-dialog.png` })
  log({ step: '6b-退出框裡有什麼（這就是要量的東西）' })
  for (const c of await dumpAll(page, 'confirm|cancel|tips|dialog|popup|btn|button')) console.log('   ' + JSON.stringify(c))
  log({ step: '6c-整頁文字', text: (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())).slice(0, 400) })

  log({ step: '7-最後狀態', url: page.url().includes('/game') ? '/game（還在機台裡）' : '/lobby（已退出）' })
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

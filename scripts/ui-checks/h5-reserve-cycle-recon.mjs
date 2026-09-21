/**
 * H5 預約完整流程盤點：**真的預約一台 → 到 Reserved 分頁看 → 取消預約**。
 *
 *   H5_URL='<帳號池 URL>' OUT=<目錄> node scripts/ui-checks/h5-reserve-cycle-recon.mjs
 *
 * 🚨 **這支會真的預約一台機台**（使用者 2026-09-19 明確同意）。預約下去機台會被
 *    保留 24 小時、別人用不了，所以**不管中間發生什麼，結束前一定要嘗試取消**——
 *    `finally` 裡有一段專門做這件事。收不回來的副作用不能留給使用者。
 *
 * ⚠️ 帳號要在預約白名單內（`osmel002` 已開）。跑之前先鎖帳號。
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
    catch { log({ tap: label, via: 'FAIL' }); return false }
  }
}

/** 畫面上看得見、有 class 的元素（面板類的東西） */
const dump = (page, re) => page.evaluate((src) => {
  const rx = src ? new RegExp(src, 'i') : null
  const out = []
  for (const el of document.querySelectorAll('div, span, button')) {
    const cls = (el.className?.toString?.() ?? '').trim()
    if (!cls || cls === 'child') continue
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    if (r.width < 20 || r.height < 12 || st.display === 'none' || st.visibility === 'hidden') continue
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (rx && !rx.test(cls) && !rx.test(txt)) continue
    out.push({ cls: cls.slice(0, 36), txt: txt.slice(0, 30) })
  }
  const seen = new Set()
  return out.filter(o => { if (seen.has(o.cls + o.txt)) return false; seen.add(o.cls + o.txt); return true }).slice(0, 18)
}, re ?? null)

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
let page = null
let reserved = false
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page)

  if (!h5InGame(page)) {
    await tap(page.locator('.grid-item').first(), '第一張遊戲卡片')
    await page.waitForTimeout(8000)
    await tap(page.locator('text=Quick Join').first(), 'Quick Join')
    await page.waitForTimeout(16000)
  }
  if (!h5InGame(page)) { log({ fatal: '沒進到機台' }); process.exit(1) }
  await tap(page.locator('.btn_bet:not(.my-button--disabled)').first(), '選面額')
  await page.waitForTimeout(5000)
  const machine = await page.locator('.machine-id').first().innerText().catch(() => '(讀不到)')
  log({ 機台: machine.trim() })

  // ── ① 開預約面板，先看目前狀態（是不是已經預約了）──────────────────────
  await tap(page.locator('.reserve').first(), '開預約面板')
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/rc-1-panel.png` })
  log({ 面板文字: (await page.evaluate(() => {
    const b = document.querySelector('.box')
    return (b?.textContent ?? document.body.innerText).replace(/\s+/g, ' ').trim()
  })).slice(0, 220) })

  // ── ② 切到 Reserved 分頁（面板開著時才有分頁）────────────────────────────
  await tap(page.locator('.reserved').first(), '切到 Reserved 分頁')
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/rc-3-reserved-tab.png` })
  log({ Reserved分頁文字: (await page.evaluate(() => {
    const b = document.querySelector('.box')
    return (b?.textContent ?? document.body.innerText).replace(/\s+/g, ' ').trim()
  })).slice(0, 260) })
  log('Reserved 分頁上的元素：')
  for (const o of await dump(page, 'box|btn|reserv|cancel|item|list|time|machine')) console.log('   ' + JSON.stringify(o))

  // ── ③ 找取消預約 ────────────────────────────────────────────────────────
  const cancels = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('div, span, button')) {
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!/cancel|取消|join/i.test(txt) || txt.length > 26) continue
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 12) continue
      out.push({ cls: (el.className?.toString?.() ?? '').trim().slice(0, 36), txt, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    }
    const seen = new Set()
    return out.filter(o => { if (seen.has(o.cls + o.txt)) return false; seen.add(o.cls + o.txt); return true }).slice(0, 10)
  })
  log('Reserved 分頁上可點的（取消／Join）：')
  cancels.forEach(c => console.log('   ' + JSON.stringify(c)))

  /**
   * 🚨 **要點的是 `.cancel-btn` 本身，不是外層的 `.function`。**
   *    `.function` 是包著 Join 與 Cancel 兩顆的容器，它的 textContent 是「JoinCancel」——
   *    用「文字裡有 cancel」去找會先命中它，點下去等於點在兩顆中間的空白處，取消不掉。
   *    （同一類的坑：容器的文字是子元素串起來的。）
   */
  const cancelBtn = page.locator('.cancel-btn').first()
  if (await cancelBtn.count().catch(() => 0)) {
    reserved = true
    await tap(cancelBtn, '按 Cancel（取消預約）')
    await page.waitForTimeout(4000)
    await page.screenshot({ path: `${OUT}/rc-4-cancel-confirm.png` })
    if (await page.locator('.box-btn_text2').count().catch(() => 0)) {
      await tap(page.locator('.box-btn_text2').first(), '確認取消')
      await page.waitForTimeout(4500)
    }
    // 取消之後再看一次 Reserved 分頁：那一筆應該不見了
    if (!(await page.locator('.cancel-btn').count().catch(() => 0))) {
      log('✅ 取消成功：Reserved 分頁上已經沒有預約')
    } else {
      log('⚠️ 取消後 Reserved 分頁還有東西——沒取消掉')
    }
    await page.screenshot({ path: `${OUT}/rc-5-after-cancel.png` })
  } else {
    log('⚠️ Reserved 分頁上沒有 .cancel-btn——可能沒預約成功，或已經被取消了')
  }

} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  // 🚨 **一定要把預約取消掉**，不然那台機台被鎖 24 小時
  try {
    if (page && reserved) {
      log('── 收尾：取消預約 ──')
      for (const sel of ['.reserved', 'text=Cancel Reservation', 'text=Cancel']) {
        const loc = page.locator(sel).first()
        if (await loc.count().catch(() => 0)) { await tap(loc, `收尾點 ${sel}`); await page.waitForTimeout(3500) }
      }
      // 取消通常還要再確認一次
      if (await page.locator('.box-btn_text2').count().catch(() => 0)) {
        await tap(page.locator('.box-btn_text2').first(), '收尾確認取消')
        await page.waitForTimeout(3500)
      }
      await page.screenshot({ path: `${OUT}/rc-4-cancelled.png` })
      log({ 收尾後文字: (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())).slice(0, 200) })
    }
    if (page && h5InGame(page)) {
      const back = await h5BackToLobby(page, { log: l => log({ exit: l }), reloadUrl: URL_H5 })
      log({ exit: back.ok ? '✅ 已退出機台' : '❌ 退出失敗' })
    }
  } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

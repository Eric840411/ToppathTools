/**
 * 跨帳號預約：**A 帳號預約一台，B 帳號在大廳看得到那台變成 Reserved 嗎。**
 *
 *   A_URL='<osmel002 的 URL>' B_URL='<另一支帳號的 URL>' OUT=<目錄> \
 *     node scripts/ui-checks/h5-reserve-two-account.mjs
 *
 * 🚨 **這種 TC 現在的 UAT 積木做不到**：一次執行只有一個瀏覽器、一個帳號，
 *    而這條要**兩個帳號同時在線**才驗得出來。所以它是獨立腳本，不是 UAT 腳本——
 *    產出的是證據（截圖＋卡片狀態），不是會回寫 Lark 的判定。
 *    （要讓 UAT studio 能表達這種流程，得加「第二個瀏覽器」的能力，那是另一件事。）
 *
 * 🚨 **會真的預約**，所以結尾一定要取消；`finally` 裡有收尾。兩支帳號都要先鎖。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'
import { h5BackToLobby, h5InGame } from '../../server/uat-runner/h5-seat.js'

const A_URL = process.env.A_URL ?? ''
const B_URL = process.env.B_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
if (!A_URL || !B_URL) { console.log('要給 A_URL 與 B_URL'); process.exit(1) }

let pass = 0, fail = 0
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

async function tap(locator, label) {
  try { await locator.click({ timeout: 7000 }); log({ tap: label, via: 'click' }); return true }
  catch {
    try { await locator.evaluate(el => el.click()); log({ tap: label, via: 'js' }); return true }
    catch { log({ tap: label, via: 'FAIL' }); return false }
  }
}

/** 大廳裡某一台機台卡片現在長什麼樣（class 會帶狀態） */
const cardState = (page, name) => page.evaluate((want) => {
  for (const el of document.querySelectorAll('.grid-item')) {
    const label = el.querySelector('.grid-item-name')
    if (!label || label.textContent.trim() !== want) continue
    const classes = [el.className?.toString?.() ?? '']
    for (const kid of el.querySelectorAll('*')) {
      const c = kid.className?.toString?.() ?? ''
      if (c) classes.push(c)
    }
    return { found: true, text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60), classes: [...new Set(classes.join(' ').split(/\s+/))].slice(0, 24) }
  }
  return { found: false }
}, name)

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stopA = null, stopB = null, pageA = null, reserved = false, machine = ''
try {
  const mk = async (url) => {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(14000)
    await dismissLobbyPopups(page)
    return page
  }

  // ── A：進機台並預約 ───────────────────────────────────────────────────────
  pageA = await mk(A_URL)
  stopA = startLobbyPopupWatcher(pageA)
  if (!h5InGame(pageA)) {
    await tap(pageA.locator('.grid-item').first(), 'A：點第一張卡片')
    await pageA.waitForTimeout(8000)
    await tap(pageA.locator('text=Quick Join').first(), 'A：Quick Join')
    await pageA.waitForTimeout(16000)
  }
  check('① A 進得了機台', h5InGame(pageA))
  await tap(pageA.locator('.btn_bet:not(.my-button--disabled)').first(), 'A：選面額')
  await pageA.waitForTimeout(5000)
  machine = (await pageA.locator('.machine-id').first().innerText().catch(() => '')).trim()
  log({ A坐的機台: machine })

  await tap(pageA.locator('.reserve').first(), 'A：開預約面板')
  await pageA.waitForTimeout(4500)
  await tap(pageA.locator('.reserve-btn-long').first(), 'A：🚨 Reserve Now（真的預約）')
  reserved = true
  await pageA.waitForTimeout(6000)
  await pageA.screenshot({ path: `${OUT}/two-a-reserved.png` })

  /**
   * 🚨 **A 預約完要先離開機台。**
   *    不離開的話 B 看到的是「**有人坐在裡面**（occupied）」，不是「**已被預約**（reserved）」——
   *    兩個狀態在卡片上長得不一樣，混在一起驗等於什麼都沒驗到。
   *    （第一版就是這樣，B 看到的 class 是 `occupied`＋`red`，那是 A 還坐著造成的。）
   */
  const leave = await h5BackToLobby(pageA, { log: l => log({ Aexit: l }), reloadUrl: A_URL })
  check('②a A 預約後離開機台（位子放掉、預約留著）', leave.ok, leave.steps.join(' → ').slice(0, 80))
  await pageA.waitForTimeout(6000)

  // ── B：另一支帳號在大廳看同一台 ──────────────────────────────────────────
  const pageB = await mk(B_URL)
  stopB = startLobbyPopupWatcher(pageB)
  check('② B 停在大廳（沒被別人的機台狀態影響）', !h5InGame(pageB), pageB.url().slice(-22))
  // 卡片可能在下面，捲一下再找
  let state = await cardState(pageB, machine)
  for (let i = 0; i < 6 && !state.found; i++) {
    await pageB.evaluate(() => {
      let best = null, area = 0
      for (const el of document.querySelectorAll('div')) {
        if (el.scrollHeight - el.clientHeight <= 40) continue
        const r = el.getBoundingClientRect()
        if (r.width * r.height > area) { best = el; area = r.width * r.height }
      }
      if (best) best.scrollTop += 900
    })
    await pageB.waitForTimeout(1500)
    state = await cardState(pageB, machine)
  }
  check('③ B 在大廳找得到那台卡片', !!state.found, machine)
  log({ B看到的卡片: state })
  await pageB.screenshot({ path: `${OUT}/two-b-lobby.png` })
  // 狀態 class 裡應該看得出被佔用／已預約
  const marks = (state.classes ?? []).filter(c => /occupied|reserve|use|red|disable/i.test(c))
  check('④ 卡片上看得出狀態', marks.length > 0, JSON.stringify(marks))
  // 🚨 A 已經離開了，所以這時候應該是「已預約」而不是「有人在玩」
  check('⑤ 狀態是「已預約」而不是「有人坐著」', marks.some(c => /reserv/i.test(c)), `卡片上的狀態 class：${JSON.stringify(marks)}`)

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  // 🚨 一定要取消預約 ＋ 放掉位子
  try {
    if (pageA && reserved) {
      if (!(await pageA.locator('.cancel-btn').count().catch(() => 0))) {
        await tap(pageA.locator('.reserve').first(), '收尾：開預約面板')
        await pageA.waitForTimeout(4000)
        await tap(pageA.locator('.reserved').first(), '收尾：切 Reserved 分頁')
        await pageA.waitForTimeout(4000)
      }
      if (await pageA.locator('.cancel-btn').count().catch(() => 0)) {
        await tap(pageA.locator('.cancel-btn').first(), '收尾：Cancel 取消預約')
        await pageA.waitForTimeout(4000)
        if (await pageA.locator('.box-btn_text2').count().catch(() => 0)) {
          await tap(pageA.locator('.box-btn_text2').first(), '收尾：確認取消')
          await pageA.waitForTimeout(4000)
        }
      }
      log({ 收尾後還有預約: (await pageA.locator('.cancel-btn').count().catch(() => 0)) > 0 })
    }
    if (pageA && h5InGame(pageA)) {
      const back = await h5BackToLobby(pageA, { log: l => log({ exit: l }), reloadUrl: A_URL })
      log({ exit: back.ok ? '✅ A 已退出機台' : '❌ A 退出失敗' })
    }
  } catch { /* ignore */ }
  try { stopA?.(); stopB?.() } catch { /* ignore */ }
  await browser.close()
}

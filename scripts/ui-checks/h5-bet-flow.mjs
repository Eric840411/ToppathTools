/**
 * H5 完整下注流程：進機台 → 選面額 → 帶入 Credits → SPIN → 觀察 → Cash Out → 退出。
 *
 * 使用者 2026-09-19 明確指示「要下注，完整的測試」，所以這支**會真的動到餘額**。
 * 用的是 QAT 帳號池的 osmel002（餘額 315 億），環境是 QAT。
 *
 * ⚠️ 每一步都記錄餘額／Credits，不然「按了但有沒有真的下注」分不出來——
 *    按鈕點下去沒反應跟下注成功，在畫面上都是「什麼都沒發生」。
 * ⚠️ SPIN 的選擇器**還沒量過**，所以帶入額度之後先 dump 一次控制項再決定，
 *    不要先寫死一個猜的選擇器。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

/** 畫面上讀得到的錢：頂部餘額與機台內 Credit */
const readMoney = (page) => page.evaluate(() => {
  const txt = (sel) => {
    const el = document.querySelector(sel)
    return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30) : null
  }
  const all = (document.body?.innerText ?? '').replace(/\s+/g, ' ')
  const credit = all.match(/CREDIT[^0-9]*([\d,\.]+)/i)?.[1] ?? null
  const win = all.match(/WIN[^0-9]*([\d,\.]+)/i)?.[1] ?? null
  const bet = all.match(/BET[^0-9]*([\d,\.]+)/i)?.[1] ?? null
  return { header: txt('.content'), credit, win, bet }
})

const dumpControls = (page) => page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 8 && r.height > 8 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const out = []
  for (const el of document.querySelectorAll('div, span, button, img, a, canvas')) {
    if (!visible(el)) continue
    const cls = (el.className?.toString() ?? '').trim()
    if (!cls || cls === 'child') continue
    if (/^\d+,\d+$/.test((el.textContent ?? '').trim())) continue
    if (!/btn|button|spin|play|bet|cash|max|auto|start/i.test(cls)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 340) continue
    out.push({ cls: cls.slice(0, 44), txt: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 18), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  }
  const seen = new Set()
  return out.filter(o => { const k = o.cls + o.txt; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 30)
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page, { onClose: c => console.log(JSON.stringify({ popup: c })) })

  if (!page.url().includes('/game')) {
    const g = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    await page.locator(`.grid-item:has(.grid-item-name:text-is("${g.trim()}"))`).click({ timeout: 15000 })
    await page.waitForTimeout(8000)
    await page.locator(':text-is("Quick Join")').first().click({ timeout: 15000 })
    await page.waitForTimeout(15000)
  }
  console.log(JSON.stringify({ step: '1-進機台', url: page.url().includes('/game') ? '/game ✅' : '❌ 沒進去', money: await readMoney(page) }))
  if (!page.url().includes('/game')) process.exit(0)
  await page.screenshot({ path: `${OUT}/bet-1-entered.png` })

  // 2) 選面額（不選的話整個畫面都點不動）
  const denom = page.locator('.btn_bet:not(.my-button--disabled)').first()
  await denom.click({ timeout: 12000 }).catch(e => console.log('denom fail:', String(e).split('\n')[0].slice(0, 60)))
  await page.waitForTimeout(7000)
  console.log(JSON.stringify({ step: '2-選面額', money: await readMoney(page) }))
  await page.screenshot({ path: `${OUT}/bet-2-denom.png` })

  // 3) 帶入 Credits（`.btn_play`，會動到餘額）
  const play = page.locator('.btn_play').first()
  const playText = await play.innerText().catch(() => '')
  await play.click({ timeout: 12000 }).catch(e => console.log('play fail:', String(e).split('\n')[0].slice(0, 60)))
  await page.waitForTimeout(9000)
  console.log(JSON.stringify({ step: '3-帶入額度', clicked: playText.replace(/\s+/g, ' ').trim(), money: await readMoney(page) }))
  await page.screenshot({ path: `${OUT}/bet-3-bought-in.png` })

  // 4) 這時候才知道 SPIN 長什麼樣——先量再動
  const controls = await dumpControls(page)
  console.log(JSON.stringify({ step: '4-控制項', count: controls.length }))
  for (const c of controls) console.log('   ' + JSON.stringify(c))
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}

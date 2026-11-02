/**
 * 全站按鈕盤點（普通版）：每頁看得到的按鈕，主按鈕顏色是不是都一樣、高度／圓角分布。
 * 使用者 1102「按鈕沒有一致」。主按鈕＝class 帶 primary／submit-btn 的。
 * 跑法（主 repo 目錄）：node ../toppath-wt-redesign/scripts/ui-checks/redesign-button-audit.mjs <base url>
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { mintDevSession } from './lib/dev-session.mjs'

const [H] = process.argv.slice(2)
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
await ctx.addInitScript(() => { try { localStorage.setItem('toppath-theme-mode', 'classic') } catch { /* */ } })
const p = await ctx.newPage()
await p.goto(H + '/', { waitUntil: 'networkidle' })

// 展開兩個有子頁的群組，收集所有頁面項目
const names = []
for (const g of [/OSM Tools/, /Game Show/]) {
  await p.locator('.sidebar-nav-item').filter({ hasText: g }).first().click()
  await p.waitForTimeout(400)
  for (const t of await p.locator('.sidebar-subtab-item').allInnerTexts()) names.push({ sub: true, name: t.trim().split('\n')[0] })
}
for (const t of await p.locator('.sidebar-nav-item').allInnerTexts()) {
  const n = t.trim().split('\n')[0]
  if (!/OSM Tools|Game Show/.test(n)) names.push({ sub: false, name: n })
}
const seen = new Set()
let hits = 0
for (const { sub, name } of names) {
  if (seen.has(name)) continue
  seen.add(name)
  if (sub) {
    for (const g of [/OSM Tools/, /Game Show/]) {
      if (await p.locator('.sidebar-subtab-item').filter({ hasText: name }).count()) break
      await p.locator('.sidebar-nav-item').filter({ hasText: g }).first().click()
      await p.waitForTimeout(300)
    }
    await p.locator('.sidebar-subtab-item').filter({ hasText: name }).first().click()
  } else {
    await p.locator('.sidebar-nav-item').filter({ hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first().click()
  }
  await p.waitForTimeout(1500)
  const r = await p.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('.main-content button')) {
      if (!el.offsetParent) continue
      const cs = getComputedStyle(el)
      const primary = /primary|submit-btn|is-primary/.test(el.className) && !/stop|saved|loading/.test(el.className)
      out.push({ primary, bg: cs.backgroundImage !== 'none' ? 'grad' : cs.backgroundColor, h: Math.round(el.getBoundingClientRect().height), r: cs.borderTopLeftRadius, t: (el.textContent || '').trim().slice(0, 12), cls: String(el.className).split(' ')[0] })
    }
    return out
  })
  const prim = r.filter(x => x.primary)
  const bgs = [...new Set(prim.map(x => x.bg))]
  if (bgs.length && (bgs.length > 1 || bgs[0] !== 'rgb(76, 141, 255)')) { hits++; console.log(`PRIMARY ${name}: ${prim.map(x => `${x.t}[${x.cls}]=${x.bg}`).join('、')}`) }
  const hs = {}
  for (const x of r) hs[`${x.h}/${x.r}`] = (hs[`${x.h}/${x.r}`] || 0) + 1
  console.log(`  ${name}: 按鈕 ${r.length}，高/圓角 ${Object.entries(hs).map(([k, v]) => `${k}×${v}`).join(' ')}`)
}
console.log(`${seen.size} 頁，${hits} 頁主按鈕顏色不一致`)
await b.close()

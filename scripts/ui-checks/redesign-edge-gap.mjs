/**
 * 「邊框靠太近」掃描（使用者 1102 回報 Meegle 步驟框內容貼邊）：
 * 每一頁找出「有畫邊框或陰影框」的容器，量裡面第一層有字／輸入框的子元素離框的左右距離，< 10px 就列出來。
 * 跑法：node scripts/ui-checks/redesign-edge-gap.mjs <base url> [classic|xianxia]
 * 會逐一點側欄每一頁（含 OSM Tools／Game Show 子頁）。
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { mintDevSession } from './lib/dev-session.mjs'

const [H, theme = 'classic'] = process.argv.slice(2)
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
await ctx.addInitScript(t => { try { localStorage.setItem('toppath-theme-mode', t) } catch { /* */ } }, theme)
const p = await ctx.newPage()
await p.goto(H + '/', { waitUntil: 'networkidle' })

async function scan(label) {
  await p.waitForTimeout(900)
  const hits = await p.evaluate(() => {
    const out = []
    const framed = el => {
      const cs = getComputedStyle(el)
      const bw = parseFloat(cs.borderLeftWidth) > 0 && cs.borderLeftStyle !== 'none' && !cs.borderLeftColor.endsWith(', 0)')
      const sh = cs.boxShadow !== 'none' && !cs.boxShadow.startsWith('rgba(0, 0, 0, 0)')
      const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none'
      return (bw || sh) && bg
    }
    for (const el of document.querySelectorAll('.main-content *')) {
      if (!el.offsetParent || !framed(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 160 || r.height < 60) continue          // 小膠囊、按鈕不算
      if (el.matches('input, textarea, select, button, table, thead, tbody, tr, td, th, iframe')) continue
      const cs = getComputedStyle(el)
      const bl = parseFloat(cs.borderLeftWidth), br = parseFloat(cs.borderRightWidth)
      for (const c of el.children) {
        if (!c.offsetParent) continue
        const cr = c.getBoundingClientRect()
        if (cr.width === 0 || cr.height === 0) continue
        if (!(c.textContent || '').trim() && !c.matches('input, textarea, select')) continue
        const gapL = cr.left - (r.left + bl), gapR = (r.right - br) - cr.right
        // 子元素自己就是滿版卡片（有自己的框）的不算
        if (framed(c) && cr.width >= r.width - 4) continue
        if (gapL < 10 || gapR < 10) {
          out.push(`${(el.className || el.tagName).toString().slice(0, 50)}  →  ${(c.className || c.tagName).toString().slice(0, 40)}  左 ${Math.round(gapL)} 右 ${Math.round(gapR)}`)
          break
        }
      }
    }
    return [...new Set(out)].slice(0, 6)
  })
  if (hits.length) { console.log(`\n[${label}]`); hits.forEach(h => console.log('  ' + h)) }
}

const groups = await p.locator('.sidebar-nav-item').count()
for (let i = 0; i < groups; i++) {
  const item = p.locator('.sidebar-nav-item').nth(i)
  const label = (await item.innerText()).split('\n')[0].trim()
  await item.click()
  await p.waitForTimeout(300)
  const subs = p.locator('.sidebar-subtab-item')
  const n = await subs.count()
  if (n === 0) { await scan(label); continue }
  for (let j = 0; j < n; j++) {
    const s = p.locator('.sidebar-subtab-item').nth(j)
    const sl = (await s.innerText()).split('\n')[0].trim()
    await s.click()
    await scan(`${label} / ${sl}`)
  }
}
await b.close()
console.log('\n掃描完成')

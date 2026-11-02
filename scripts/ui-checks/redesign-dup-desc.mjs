/**
 * 找「頁面說明出現兩次」：頁首（.rd-page-head）已經顯示說明，頁內又有一個元素的文字跟它一樣（或幾乎一樣）。
 * 使用者 1102 對照原型時發現腳本化投注、UI 截圖等頁有兩行一樣的說明。
 * 跑法（主 repo 目錄）：node ../toppath-wt-redesign/scripts/ui-checks/redesign-dup-desc.mjs <base url>
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
    const n = s => s.replace(/\s+/g, '').replace(/[。．.]$/, '')
    const desc = document.querySelector('.rd-page-desc')?.textContent ?? ''
    if (!desc) return null
    const out = []
    for (const el of document.querySelectorAll('.main-content *')) {
      if (el.closest('.rd-page-head') || !el.offsetParent) continue
      const t = (el.textContent || '').trim()
      if (t.length < 6 || el.children.length > 3) continue
      if (n(t) === n(desc) || (n(t).length > 10 && (n(desc).includes(n(t)) || n(t).includes(n(desc))))) {
        out.push({ tag: el.tagName.toLowerCase(), cls: el.className && typeof el.className === 'string' ? el.className : '', text: t.slice(0, 50) })
      }
    }
    // 同一段文字的外層與內層都會命中，只留最內層
    return { desc: desc.slice(0, 40), out: out.filter((o, i) => !out.some((x, j) => j > i && o.text.includes(x.text) && x.text.length >= o.text.length - 2)) }
  })
  if (r && r.out.length) {
    hits++
    console.log(`DUP ${name}：${r.out.map(o => `<${o.tag}.${o.cls}> ${o.text}`).join(' ｜ ')}`)
  }
}
console.log(`${seen.size} 頁，${hits} 頁說明重複`)
await b.close()

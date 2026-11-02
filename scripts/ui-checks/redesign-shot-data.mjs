/**
 * 有資料的整頁截圖：先按頁面自己的取得／同步按鈕，等資料回來再截（使用者 1102：只看空畫面會漏掉有資料時的破版）。
 * 跑法（主 repo 目錄）：node ../toppath-wt-redesign/scripts/ui-checks/redesign-shot-data.mjs <base url> <輸出 png> <頁面名稱> <等待毫秒> [按鈕文字…]
 * 只按「讀取」類按鈕（取得、同步、重新整理），不要傳會寫入或送出的按鈕。
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { mintDevSession } from './lib/dev-session.mjs'

const [H, out, name, waitMs, ...buttons] = process.argv.slice(2)
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
await ctx.addInitScript(() => { try { localStorage.setItem('toppath-theme-mode', 'classic') } catch { /* */ } })
const p = await ctx.newPage()
await p.goto(H + '/', { waitUntil: 'networkidle' })
const sub = () => p.locator('.sidebar-subtab-item').filter({ hasText: name })
const top = () => p.locator('.sidebar-nav-item').filter({ hasText: name }).filter({ visible: true })
for (const g of [null, /OSM Tools/, /Game Show/]) {
  if (g) { if (await sub().count()) break; await p.locator('.sidebar-nav-item').filter({ hasText: g }).first().click(); await p.waitForTimeout(400) }
  if (await sub().count() || await top().count()) break
}
await ((await sub().count()) ? sub().first() : top().first()).click()
await p.waitForTimeout(1500)
for (const t of buttons) {
  const btn = p.locator('.main-content button').filter({ hasText: t }).first()
  if (await btn.count()) { await btn.click(); console.log('clicked', t) } else console.log('not found', t)
  await p.waitForTimeout(500)
}
await p.waitForTimeout(Number(waitMs) || 3000)
await p.screenshot({ path: out, fullPage: true })
console.log('saved', out)
await b.close()

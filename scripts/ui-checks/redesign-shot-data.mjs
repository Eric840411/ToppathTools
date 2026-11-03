/**
 * 有資料的整頁截圖：先按頁面自己的取得／同步按鈕，等資料回來再截（使用者 1102：只看空畫面會漏掉有資料時的破版）。
 * 跑法（主 repo 目錄）：node ../toppath-wt-redesign/scripts/ui-checks/redesign-shot-data.mjs <base url> <輸出 png> <頁面名稱> <等待毫秒> [按鈕文字…]
 * 修仙版：THEME_MODE=xianxia。只按「讀取」類按鈕（取得、同步、重新整理），不要傳會寫入或送出的按鈕。
 * 開彈窗用（向下相容，一般文字照舊只找 .main-content 裡的按鈕）：
 *   css=<選擇器>   點整頁第一個符合的元素（例如 css=.orl-row）
 *   any=<文字>     點整頁（含彈窗）第一個文字符合的按鈕
 *   wait=<毫秒>    中途多等一下
 *   VIEWPORT=1     只截視窗（彈窗是 position:fixed，整頁截圖會被拉長）
 *   PROBE=<JS 運算式>  截圖前在頁面裡求值並印出（查 computed style 用）
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintDevSession } from './lib/dev-session.mjs'

const [H, out, name, waitMs, ...buttons] = process.argv.slice(2)
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
// Game Show iframe 的 server/static 檔：本機 server 跑的是主 repo 的版本，這裡改吃 worktree 的（同 redesign-frame-check.mjs）
const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'static')
const SERVE = {
  '/api/gs/img-compare': ['img-compare.html', 'text/html; charset=utf-8'],
  '/api/gs/bonus-v2': ['bonus-v2.html', 'text/html; charset=utf-8'],
  '/api/gs/redesign-frame.js': ['redesign-frame.js', 'application/javascript; charset=utf-8'],
  '/api/gs/redesign-frame.css': ['redesign-frame.css', 'text/css; charset=utf-8'],
  '/api/gs/img-compare-app.js': ['img-compare-app.js', 'application/javascript; charset=utf-8'],
  '/api/gs/bonus-v2-app.js': ['bonus-v2-app.js', 'application/javascript; charset=utf-8'],
}
await ctx.route(url => SERVE[url.pathname] !== undefined, route => {
  const [file, type] = SERVE[new URL(route.request().url()).pathname]
  route.fulfill({ status: 200, contentType: type, body: readFileSync(join(STATIC, file)) })
})
const MODE = process.env.THEME_MODE || 'classic'
await ctx.addInitScript((MODE) => { try { localStorage.setItem('toppath-theme-mode', MODE) } catch { /* */ } }, MODE)
const p = await ctx.newPage()
await p.goto(H + '/', { waitUntil: 'networkidle' })
// 名稱要在項目文字的結尾（「AutoSpin」不要點到「AutoSpin 通知」）
const nameRe = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$')
const sub = () => p.locator('.sidebar-subtab-item').filter({ hasText: nameRe })
const top = () => p.locator('.sidebar-nav-item').filter({ hasText: nameRe }).filter({ visible: true })
for (const g of [null, /OSM Tools/, /Game Show/]) {
  if (g) { if (await sub().count()) break; await p.locator('.sidebar-nav-item').filter({ hasText: g }).first().click(); await p.waitForTimeout(400) }
  if (await sub().count() || await top().count()) break
}
await ((await sub().count()) ? sub().first() : top().first()).click()
await p.waitForTimeout(1500)
for (const t of buttons) {
  if (t.startsWith('wait=')) { await p.waitForTimeout(Number(t.slice(5))); continue }
  const btn = t.startsWith('css=') ? p.locator(t.slice(4)).first()
    : t.startsWith('any=') ? p.locator('button').filter({ hasText: t.slice(4) }).filter({ visible: true }).first()
    : p.locator('.main-content button').filter({ hasText: t }).first()
  if (await btn.count()) { await btn.click(); console.log('clicked', t) } else console.log('not found', t)
  await p.waitForTimeout(500)
}
await p.waitForTimeout(Number(waitMs) || 3000)
if (process.env.PROBE) console.log('probe', JSON.stringify(await p.evaluate(process.env.PROBE)))
await p.screenshot({ path: out, fullPage: process.env.VIEWPORT !== '1' })
console.log('saved', out)
await b.close()

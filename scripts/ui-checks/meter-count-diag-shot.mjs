/**
 * Performance Meter 對帳「局數差異定位」的實際渲染（v5.84.0）。打本機 :3000 真的路由、真的 QAT 後台。
 * 跑法：node scripts/ui-checks/meter-count-diag-shot.mjs [機台名稱] [日期] [chromium|webkit]
 * 機台預設 Atomic Gateway-NCH46 2026-11-12（QAT 實測局數不一致的那台）。
 */
import { mintDevSession } from './lib/dev-session.mjs'
import { chromium, webkit } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const [machine = 'Atomic Gateway-NCH46', date = '2026-11-12', engine = 'chromium', mode = 'classic'] = process.argv.slice(2)
const db = new Database(path.join(root, 'server/data.db'))
const sess = mintDevSession(db)
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }])
const page = await ctx.newPage()
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' })
await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1700)
// 沒有 URL 路由：先點群組再點子項
await page.locator('text=OSM Tools').first().click().catch(() => {})
await page.waitForTimeout(1000)
for (const t of ['Performance Meter 對帳', '天秤校帳']) {
  const l = page.locator(`text=${t}`).first()
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1500); break }
}
await page.locator('button.rd-tab', { hasText: 'QAT' }).first().click()
await page.fill('#pm-machine', machine)
await page.fill('#pm-date', date)
await page.locator('button.rd-tab', { hasText: '自然日' }).first().click()
await page.locator('button', { hasText: '查詢對帳' }).first().click()
await page.waitForSelector('.st-verdict', { timeout: 60000 })
await page.waitForTimeout(800)
const m = await page.evaluate(() => {
  const txt = document.body.innerText
  const de = document.documentElement
  return {
    判定: document.querySelector('.st-verdict-why')?.textContent?.trim(),
    有局數差: txt.includes('局數 Meter − Game Record'),
    有定位卡: txt.includes('局數差異定位'),
    定位列數: document.querySelectorAll('.st-diag-table tbody tr').length,
    有請提供: txt.includes('請提供'),
    橫向溢出: de.scrollWidth > de.clientWidth,
  }
})
console.log(JSON.stringify(m, null, 1))
const card = page.locator('section', { hasText: '局數差異定位' }).first()
const out = path.join(root, `meter-count-diag-${engine}-${mode}.png`)
if (await card.count()) { await page.locator('.st-verdict').scrollIntoViewIfNeeded(); await page.screenshot({ path: out, fullPage: false, clip: await (async () => { const a = await page.locator('.st-verdict').boundingBox(); const b = await card.boundingBox(); return { x: 0, y: a.y - 10, width: 1440, height: b.y + b.height - a.y + 20 } })() }) }
else await page.screenshot({ path: out })
console.log('截圖', out)
await browser.close()

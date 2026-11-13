/**
 * Performance Meter 對帳「盒子日誌逐局比對」的實際渲染（v5.85.0）。打本機 :3000 真的路由、真的 QAT 後台。
 * 跑法：node scripts/ui-checks/meter-box-log-shot.mjs <日誌檔路徑> [機台名稱] [日期] [chromium|webkit] [classic|xianxia] [寬度]
 * 日誌只在瀏覽器解析；檢查：比對卡有出現、列數、沒有橫向溢出。
 */
import { mintDevSession } from './lib/dev-session.mjs'
import { chromium, webkit } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const [logFile, machine = 'Squid Game - 1199', date = '2026-11-12', engine = 'chromium', mode = 'classic', width = '1440'] = process.argv.slice(2)
if (!logFile) { console.log('要給日誌檔路徑'); process.exit(1) }
const db = new Database(path.join(root, 'server/data.db'))
const sess = mintDevSession(db)
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const W = Number(width)
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }])
const page = await ctx.newPage()
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' })
await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1700)
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
await page.setInputFiles('#pm-boxlog', logFile)
const qbar = path.join(root, `meter-box-log-query-${engine}-${mode}-${W}.png`)
await page.locator('.st-q').first().screenshot({ path: qbar })
await page.locator('button', { hasText: '查詢對帳' }).first().click()
await page.waitForSelector('.st-verdict', { timeout: 60000 })
const card = page.locator('section', { hasText: '盒子日誌逐局比對' }).first()
await card.waitFor({ timeout: 90000 })
await page.waitForFunction(() => ![...document.querySelectorAll('section')].some(s => s.textContent?.includes('比對中…')), null, { timeout: 120000 })
await page.waitForTimeout(500)
const m = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('section')].find(s => s.textContent?.includes('盒子日誌逐局比對'))
  const de = document.documentElement
  return {
    摘要: sec?.querySelector('.st-hint')?.textContent?.trim(),
    錯誤: sec?.querySelector('.st-msg-err')?.textContent?.trim() ?? null,
    列: [...(sec?.querySelectorAll('tbody tr') ?? [])].map(tr => tr.textContent?.trim()),
    說明: [...(sec?.querySelectorAll('.st-diag-notes li') ?? [])].map(li => li.textContent?.trim()),
    橫向溢出: de.scrollWidth > de.clientWidth,
  }
})
console.log(JSON.stringify(m, null, 1))
const out = path.join(root, `meter-box-log-${engine}-${mode}-${W}.png`)
await card.scrollIntoViewIfNeeded()
await card.screenshot({ path: out })
console.log('截圖', qbar, out)
await browser.close()

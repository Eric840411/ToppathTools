/**
 * 版本驗證表本機冒煙：真 server（localhost:3000）＋真登入 session，從產品入口走
 * 新增批次 → 新增項目 → 上正式檢查應擋下 → 修改履歷 → 普通版／仙俠版截圖；最後刪掉測試批次。
 * 跑法：node scripts/ui-checks/osm-verify-smoke.mjs
 */
import { mintDevSession } from './lib/dev-session.mjs'
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = process.argv[2] ?? root
const db = new Database(path.join(root, 'server/data.db'))
const sess = mintDevSession(db)
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }
let pass = 0, fail = 0
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const CODE = 'SMOKE' + Date.now().toString().slice(-5)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }])
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push('pageerror ' + e.message))
page.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text()) })
page.on('response', r => { if (r.url().includes('/api/osm-verify') && r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`) })

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.locator('text=OSM Tools').first().click().catch(() => {})
await page.waitForTimeout(800)
await page.locator('text=版本驗證表').first().click()
await page.waitForTimeout(1500)
check('頁面載入（有新增批次鈕）', await page.locator('button', { hasText: '新增批次' }).count() > 0)
check('頁內沒有再畫一次大標題（外框標題只有一個）', await page.getByText('版本驗證表', { exact: true }).locator('xpath=self::h1|self::h2').count() <= 1)

await page.locator('button', { hasText: '新增批次' }).first().click()
await page.locator('.ovf-field:has-text("批次") input').fill(CODE)
await page.locator('.ovf-modal-foot button', { hasText: '儲存' }).click()
await page.waitForTimeout(1200)
check('批次建立並出現在清單', await page.locator(`text=${CODE}`).count() > 0)
await page.locator(`text=${CODE}`).first().click().catch(() => {})
await page.waitForTimeout(800)

await page.locator('button', { hasText: '新增項目' }).first().click()
await page.locator('.ovf-field:has-text("平台") input').fill('H5')
await page.locator('.ovf-field:has-text("類型") input').fill('OSM')
await page.locator('.ovf-field:has-text("描述") textarea').fill('冒煙測試項目：大廳進入正常')
await page.locator('.ovf-modal-foot button', { hasText: '儲存' }).click()
await page.waitForTimeout(1200)
check('項目出現在驗證表', await page.locator('text=冒煙測試項目').count() > 0)

const relBtn = page.locator('button', { hasText: '標記已上正式' }).first()
check('沒綁版本紀錄 → 標記已上正式停用', (await relBtn.count()) > 0 && await relBtn.isDisabled())
const btn = page.locator('.ovf-table--items button', { hasText: '刪除' }).first()
const bb = await btn.boundingBox(), sb = await page.locator('.ovf-scroll').first().boundingBox()
check('操作欄（開單／編輯／刪除）整欄在可視範圍內', !!bb && !!sb && bb.x + bb.width <= sb.x + sb.width + 1, bb && sb ? `${Math.round(bb.x + bb.width)} vs ${Math.round(sb.x + sb.width)}` : '')
await page.screenshot({ path: path.join(out, 'osm-verify-classic.png'), fullPage: true })

await page.locator('button', { hasText: '修改履歷' }).first().click()
await page.waitForTimeout(1000)
check('修改履歷有紀錄（批次＋項目各一筆）', await page.locator('.ovf-modal').getByText('新增').count() >= 2)
await page.screenshot({ path: path.join(out, 'osm-verify-revisions.png') })
await page.keyboard.press('Escape')
await page.locator('.ovf-modal-foot button', { hasText: /取消|關閉/ }).first().click().catch(() => {})

await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'))
await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500)
await page.locator('text=靈脈巡檢').first().click().catch(() => {})
await page.waitForTimeout(800)
await page.locator('text=/驗證卷錄|版本驗證表/').first().click().catch(() => {})
await page.waitForTimeout(1200)
await page.locator(`text=${CODE}`).first().click().catch(() => {})
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(out, 'osm-verify-xianxia.png'), fullPage: true })
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'classic'))

// 清掉測試批次（API，同一個登入身分）
const list = await page.request.get('http://localhost:3000/api/osm-verify/batches').then(r => r.json())
const b = (list.batches ?? []).find(x => String(x.name).endsWith(CODE))
if (b) {
  const d = await page.request.delete(`http://localhost:3000/api/osm-verify/batches/${b.id}?rev=${b.rev}`)
  check('測試批次已刪除', d.ok(), String(d.status()))
}
check('沒有 pageerror／console error／5xx', errs.length === 0, errs.slice(0, 5).join(' | '))
await browser.close()
console.log(`\nosm-verify-smoke: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)

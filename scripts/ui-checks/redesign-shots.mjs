/**
 * 新版外框（ui-redesign）截圖：普通版／仙俠版各幾頁、頂列開關的按住狀態、手機寬。
 * 跑法：node scripts/ui-checks/redesign-shots.mjs <base url> <輸出目錄> [頁面…]
 * 頁面用側欄上看得到的文字（普通版名稱），預設 Dashboard、機台自動化測試、Meegle 批量工具。
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { mintDevSession } from './lib/dev-session.mjs'

const [H, out, ...pages] = process.argv.slice(2)
if (!H || !out) { console.error('用法：node scripts/ui-checks/redesign-shots.mjs <base url> <輸出目錄> [頁面…]'); process.exit(2) }
const PAGES = pages.length ? pages : ['Dashboard', '機台自動化測試', 'Meegle 批量工具']
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const errs = []

async function open(width, height, theme) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
  await ctx.addInitScript(t => { try { localStorage.setItem('toppath-theme-mode', t) } catch { /* */ } }, theme)
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(`${theme}: ${e.message}`))
  await p.goto(H + '/', { waitUntil: 'networkidle' })
  await p.waitForTimeout(800)
  return { ctx, p }
}

async function goPage(p, name) {
  // 先找名稱完全相同的（「AutoSpin」不要點到「AutoSpin 通知」），找不到才用包含
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exact = p.locator('.sidebar-nav-item, .sidebar-subtab-item').filter({ hasText: new RegExp(`^\\s*${esc}\\s*$`) })
  // 有子頁的要先展開群組（OSM Tools）
  // 完全相同的找不到才展開 OSM Tools 再找（子頁要展開才存在）；不能先退回「包含」——會點到同名開頭的別頁
  // 子頁在 OSM Tools 或 Game Show 底下：依序展開，找到就停
  for (const group of [/OSM Tools|靈機巡檢/, /Game Show|幻境試煉/]) {
    if (await exact.count()) break
    await p.locator('.sidebar-nav-item').filter({ hasText: group }).first().click()
    await p.waitForTimeout(300)
  }
  const again = p.locator('.sidebar-nav-item, .sidebar-subtab-item').filter({ hasText: new RegExp(`^\\s*${esc}\\s*$`) })
  await ((await again.count()) ? again.first() : p.locator('.sidebar-nav-item, .sidebar-subtab-item').filter({ hasText: name }).first()).click()
  await p.waitForTimeout(1500)
}

for (const theme of ['classic', 'xianxia']) {
  const { ctx, p } = await open(1440, 1000, theme)
  for (const name of PAGES) {
    await goPage(p, name)
    await p.screenshot({ path: `${out}/rd-${theme}-${name.replace(/\s+/g, '_')}.png` })
    const ov = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    if (ov) errs.push(`${theme} ${name}: 橫向捲動`)
  }
  // 頂列開關：按住版本切換那顆＝透鏡
  const other = p.locator('.rd-seg button[aria-pressed="false"]').first()
  const bb = await other.boundingBox()
  if (bb) {
    await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.mouse.down(); await p.waitForTimeout(350)
    await p.screenshot({ path: `${out}/rd-${theme}-lens.png`, clip: { x: 1440 - 520, y: 0, width: 520, height: 60 } })
    await p.mouse.up()
  }
  await ctx.close()
}

const { ctx, p } = await open(390, 844, 'classic')
await p.screenshot({ path: `${out}/rd-phone.png` })
console.log('手機橫向捲動', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
await ctx.close()
await b.close()
console.log('errors', errs)

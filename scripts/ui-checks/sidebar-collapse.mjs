/**
 * 側欄收放（v5.3.0）。CodeX 列的驗收點：窄視窗重載、存過的選擇優先、滑過／focus 顯示名稱、
 * 子選單開關規則、純鍵盤、底部長選單不超出畫面、兩套主題。走區網 IP。
 *
 * 跑法：node scripts/ui-checks/sidebar-collapse.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = '192.168.3.41'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'), { readonly: true })
const sess = db.prepare("SELECT sid FROM auth_sessions WHERE expires_at > ? AND email = 'eric.wu@toppath.tw' ORDER BY created_at DESC LIMIT 1").get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()

async function open({ width, height = 900, mode = 'classic', stored }) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(([m, st]) => {
    localStorage.setItem('toppath-theme-mode', m)
    if (st === undefined) localStorage.removeItem('toppath-sidebar-collapsed'); else localStorage.setItem('toppath-sidebar-collapsed', st)
  }, [mode, stored])
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  return { ctx, page }
}
const collapsed = page => page.locator('.app.app--sb-collapsed').count().then(n => n === 1)
const sbWidth = page => page.locator('.app-sidebar').evaluate(e => Math.round(e.getBoundingClientRect().width))
const mainLeft = page => page.locator('.app-main').evaluate(e => Math.round(e.getBoundingClientRect().left))

console.log('[預設與記憶]')
{
  const { ctx, page } = await open({ width: 1000 })
  check('沒存過＋窄視窗（1000px）→ 預設收起', await collapsed(page))
  await page.setViewportSize({ width: 1500, height: 900 }); await page.waitForTimeout(400)
  check('之後視窗變寬不自動展開', await collapsed(page))
  await ctx.close()
}
{
  const { ctx, page } = await open({ width: 1500 })
  check('沒存過＋寬視窗 → 預設展開', !(await collapsed(page)))
  await page.getByRole('button', { name: '收起側欄' }).click(); await page.waitForTimeout(400)
  check('手動收起後寫入 localStorage', await page.evaluate(() => localStorage.getItem('toppath-sidebar-collapsed')) === '1')
  await ctx.close()
}
{
  const { ctx, page } = await open({ width: 1000, stored: '0' })
  check('存過「展開」→ 窄視窗也照存的展開', !(await collapsed(page)))
  await ctx.close()
}

for (const mode of ['classic', 'xianxia']) {
  console.log(`[收起 ${mode}]`)
  const { ctx, page } = await open({ width: 1300, height: 640, mode, stored: '1' })
  await page.waitForTimeout(500)
  const w = await sbWidth(page)
  check('側欄寬 64px、主內容跟著貼齊', w === 64 && await mainLeft(page) === 64, `側欄 ${w}／主內容 ${await mainLeft(page)}`)
  check('收起時沒有任何文字標籤露出', await page.locator('.app-sidebar .sidebar-nav-label').evaluateAll(els => els.every(e => e.getBoundingClientRect().width < 1)))

  // 滑過主頁籤顯示名稱
  const items = page.locator('.app-sidebar .sidebar-nav-item')
  await items.nth(1).hover(); await page.waitForTimeout(250)
  const tip = page.locator('.sb-tip')
  check('滑過主頁籤出現名稱提示', await tip.count() === 1 && (await tip.innerText()).length > 0, (await tip.count()) ? await tip.innerText() : '')
  if (mode === 'xianxia') check('修仙版提示同時有原功能名', await tip.locator('.sb-tip-sub').count() >= 1)
  await page.mouse.move(900, 300); await page.waitForTimeout(200)
  check('滑開提示消失', await tip.count() === 0)

  // 子選單：點有子頁籤的主頁籤
  const osm = page.locator('.app-sidebar .sidebar-nav-item[aria-haspopup]').first()
  const before = await page.locator('.app-topbar-title').innerText()
  await osm.click(); await page.waitForTimeout(250)
  const fly = page.locator('.sb-flyout')
  check('點有子頁籤的主頁籤 → 彈出子選單', await fly.count() === 1)
  check('開選單不切頁', await page.locator('.app-topbar-title').innerText() === before)
  check('開選單時不顯示名稱提示', await tip.count() === 0)
  const box = await fly.boundingBox()
  check('長選單（13 項）不超出可視範圍', box && box.y >= 0 && box.y + box.height <= 640 + 1, box ? `y=${Math.round(box.y)} h=${Math.round(box.height)}` : '')
  await fly.evaluate(e => e.scrollTop = 40); await page.waitForTimeout(150)
  check('選單本身捲動不會關', await fly.count() === 1)
  await osm.click(); await page.waitForTimeout(200)
  check('再點同一顆 → 關閉', await fly.count() === 0)
  await osm.click(); await page.waitForTimeout(200)
  await page.mouse.click(900, 400); await page.waitForTimeout(200)
  check('點外面 → 關閉', await fly.count() === 0)
  // 選一個子頁籤
  await osm.click(); await page.waitForTimeout(200)
  const target = fly.locator('.sidebar-subtab-item').nth(2)
  // 只取名稱（普通版前面有圖示字母，修仙版有主名稱＋原功能名）
  const targetText = await target.evaluate(e => (e.querySelector('.sidebar-nav-label-theme') ?? e.querySelector('.sb-fly-label'))?.textContent?.trim() ?? '')
  await target.click(); await page.waitForTimeout(500)
  check('選子頁籤 → 換頁並關閉選單', await fly.count() === 0 && (await page.locator('.app-topbar-title').innerText()).includes(targetText.trim()), `${targetText} → ${await page.locator('.app-topbar-title').innerText()}`)
  await page.screenshot({ path: path.join(root, `sidebar-collapsed-${mode}.png`) })
  await osm.click(); await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(root, `sidebar-flyout-${mode}.png`) })
  await page.keyboard.press('Escape'); await page.waitForTimeout(150)

  // 純鍵盤
  await osm.focus(); await page.waitForTimeout(200)
  check('focus 主頁籤也會出名稱提示', await tip.count() === 1)
  await page.keyboard.press('Enter'); await page.waitForTimeout(250)
  check('Enter 開選單、焦點移到第一項', await fly.count() === 1 && await page.evaluate(() => !!document.activeElement?.closest('.sb-flyout')))
  await page.keyboard.press('Tab'); await page.waitForTimeout(100)
  check('Tab 在子項間移動', await page.evaluate(() => !!document.activeElement?.closest('.sb-flyout')))
  await page.keyboard.press('Escape'); await page.waitForTimeout(150)
  check('Esc 關閉並把焦點還給觸發按鈕', await fly.count() === 0 && await page.evaluate(() => document.activeElement?.getAttribute('aria-haspopup') === 'menu'))

  // 選單沒關、Tab 回另一顆有子頁籤的主頁籤再 Enter：焦點要移進新選單（CodeX review [P2]）
  const gs = page.locator('.app-sidebar .sidebar-nav-item[aria-haspopup]').nth(1)
  await osm.click(); await page.waitForTimeout(250)
  await gs.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(300)
  check('換另一組選單時焦點移進新選單', await page.evaluate(() => !!document.activeElement?.closest('.sb-flyout')) && /Game Show|幻境試煉/.test(await fly.locator('.sb-flyout-title').innerText()), await fly.locator('.sb-flyout-title').innerText())
  await page.keyboard.press('Escape'); await page.waitForTimeout(150)

  // 展開動畫後恢復原狀
  await page.getByRole('button', { name: '展開側欄' }).click(); await page.waitForTimeout(500)
  check('展開後寬度回來、子頁籤顯示在側欄內', await sbWidth(page) > 200 && await page.locator('.app-sidebar .sidebar-subtabs').count() === 1, `寬 ${await sbWidth(page)}`)
  check('展開後主內容跟著讓位', await mainLeft(page) === await sbWidth(page))
  await page.screenshot({ path: path.join(root, `sidebar-expanded-${mode}.png`) })
  await ctx.close()
}

// 640px 寬（CodeX：原本只測 640px 高）——修仙版 CSS 在 ≤680px 會隱藏所有 .sidebar-nav-label
for (const mode of ['classic', 'xianxia']) {
  console.log(`[640px 寬 ${mode}]`)
  const { ctx, page } = await open({ width: 640, height: 800, mode, stored: '0' })
  await page.waitForTimeout(500)
  check('≤680px 一律圖示列（就算存的是展開）', await collapsed(page) && await sbWidth(page) <= 68, `寬 ${await sbWidth(page)}`)
  check('≤680px 不顯示收放鈕（收不收由寬度決定）', await page.locator('.sidebar-collapse-btn').count() === 0)
  const osm = page.locator('.app-sidebar .sidebar-nav-item[aria-haspopup]').first()
  await osm.click(); await page.waitForTimeout(300)
  const widths = await page.locator('.sb-flyout .sb-fly-label').evaluateAll(els => els.map(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 20))
  check('子選單文字看得到（沒被修仙版全域規則藏掉）', widths.length > 0 && widths.every(Boolean), `${widths.length} 項`)
  await page.screenshot({ path: path.join(root, `sidebar-640-${mode}.png`) })
  await ctx.close()
}

await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過')
process.exit(fail ? 1 : 0)

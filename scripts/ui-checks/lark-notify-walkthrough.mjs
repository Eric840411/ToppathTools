/**
 * 通知設定頁走查（v5.5.0 起原「Lark 通知」改名「通知設定」、出口固定 Lark；普通版＋修仙版）：打真的伺服器、真的設定；試發攔下來不真的送（避免洗群）。
 * 前提：已跑過 lark-notify-live-check.mjs（憑證已存）。跑法：node scripts/ui-checks/lark-notify-walkthrough.mjs
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'

const HOST = '192.168.3.41'
const db = new Database('server/data.db')
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const browser = await chromium.launch()

for (const theme of ['classic', 'xianxia']) {
  console.log(`== ${theme}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(t => localStorage.setItem('toppath-theme-mode', t), theme)
  const page = await ctx.newPage()
  let testBody = null
  await page.route('**/api/lark-notify/test', async r => { testBody = r.request().postDataJSON(); await r.fulfill({ json: { ok: true, message: '已送出測試訊息' } }) })
  let putCalls = 0
  page.on('request', r => { if (r.url().includes('/api/lark-notify/config') && r.method() === 'PUT') putCalls++ })

  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(通知設定|飛書傳訊)$/).first().click()
  await page.getByText('機器人憑證').waitFor()
  await page.waitForLoadState('networkidle')

  check('頁內沒有重畫一次大標題（版面一致規則）', await page.locator('.ln-page h1').count() === 0)
  check('機器人名稱標籤', await page.locator('.ln-chip', { hasText: 'OSM QA' }).isVisible())
  check('Secret 只顯示尾碼、沒有輸入框', await page.locator('.ln-input--static').isVisible() && await page.locator('#ln-secret').count() === 0)
  check('已驗證', await page.getByText('已驗證').isVisible())
  await page.locator('.ln-card select option', { hasText: 'OSM的秘密' }).waitFor({ state: 'attached', timeout: 15000 }).catch(() => {})
  const opts = await page.locator('.ln-card select option').allTextContents()
  check('群組下拉列出機器人所在的群', opts.includes('OSM的秘密') && opts.includes('OSM AI工具'), opts.join('、'))
  check('目前目標群已選好', await page.locator('.ln-card select').inputValue() === 'oc_8f0b93e81709a99ec176fb8784dd7c7f')
  check('沒改東西時儲存鈕停用', await page.getByRole('button', { name: '儲存設定' }).isDisabled())

  await page.locator('.ln-card select').selectOption({ label: 'OSM AI工具' })
  await page.getByRole('button', { name: '試發' }).click()
  await page.locator('.ln-result--ok').waitFor()
  check('試發用的是欄位上（還沒存）的群', testBody?.chatId?.startsWith('oc_ffe8872'), testBody?.chatId)
  check('試發成功顯示群名', (await page.locator('.ln-result--ok').textContent()).includes('OSM AI工具'))
  check('換群後提示「要儲存才會改發到這裡」', await page.getByText(/正式通知要按下方「儲存設定」/).isVisible())

  // v5.5.0：出口固定 Lark，不能再選 Discord／雙發
  check('沒有 Discord／雙發可選', await page.getByRole('radio', { name: /Discord|雙發/ }).count() === 0 && await page.getByText('雙發').count() === 0)
  const rows = await page.locator('.ln-table').first().locator('tbody tr').allInnerTexts()
  check('三個功能都標「Lark」', rows.length === 3 && rows.every(r => r.includes('Lark')), rows.join(' | '))
  check('工具網址欄一直都在（週報卡片連結用）', await page.getByText('週報通知：開啟工具確認頁').isVisible() && await page.locator('#ln-toolurl').isVisible())
  check('有指出 AutoSpin 通知設定在哪', await page.getByText(/側欄「AutoSpin 通知」頁/).isVisible())
  check('有變更 → 尚未儲存變更、儲存鈕可按', await page.getByText('尚未儲存變更').isVisible() && await page.getByRole('button', { name: '儲存設定' }).isEnabled())

  await page.getByText('@人對照狀態').scrollIntoViewIfNeeded()
  check('@人：缺少權限明講，不假裝已配對', await page.locator('.ln-chip--warn', { hasText: '缺少權限' }).isVisible() && await page.getByText('已配對').count() === 0)
  await page.screenshot({ path: `lark-notify-${theme}.png`, fullPage: true })
  // 儲存鈕只要出現在畫面上，就不能被右下角常駐的 AI Agent 浮窗蓋住——每個捲動位置都量（只量捲到底的話，sticky 版在底部剛好歸位，量不出來）
  const coveredAt = []
  const maxY = await page.evaluate(() => { const m = document.querySelector('.main-content') ?? document.scrollingElement; return m.scrollHeight - m.clientHeight })
  for (let y = 0; y <= maxY + 200; y += 150) {
    await page.evaluate(y => { const m = document.querySelector('.main-content'); if (m) m.scrollTop = y; window.scrollTo(0, y) }, y)
    const st = await page.getByRole('button', { name: '儲存設定' }).evaluate(b => { const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, yy = r.top + r.height / 2; if (yy < 0 || yy > innerHeight) return 'offscreen'; const hit = document.elementFromPoint(x, yy); return hit === b || b.contains(hit) ? 'ok' : 'covered' })
    if (st === 'covered') coveredAt.push(y)
  }
  check('儲存鈕出現在畫面上時都沒被浮窗蓋住', coveredAt.length === 0, coveredAt.length ? `被蓋住的捲動位置：${coveredAt.join(',')}` : '')

  await page.getByRole('button', { name: '取消' }).click()
  check('取消 → 回到已存的值（群），沒有送出 PUT', await page.locator('.ln-card select').inputValue() === 'oc_8f0b93e81709a99ec176fb8784dd7c7f'
    && await page.getByRole('button', { name: '儲存設定' }).isDisabled() && putCalls === 0)

  await page.getByRole('button', { name: '更換 Secret' }).click()
  check('按「更換 Secret」才出現輸入框，且是密碼欄', await page.locator('#ln-secret').getAttribute('type') === 'password')
  await ctx.close()
}

// AutoSpin 通知頁（原 Discord 通知頁拿掉 Discord 專屬的部分）
for (const theme of ['classic', 'xianxia']) {
  console.log(`== AutoSpin 通知 ${theme}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  await ctx.addInitScript(t => localStorage.setItem('toppath-theme-mode', t), theme)
  const page = await ctx.newPage()
  let formatPost = null
  await page.route('**/api/autospin/notify-format', async r => { if (r.request().method() === 'POST') { formatPost = r.request().postDataJSON(); await r.fulfill({ json: { ok: true } }) } else await r.continue() })
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(AutoSpin 通知|靈訊符籙)$/).first().click()
  await page.getByText('訊息格式').waitFor()
  await page.waitForLoadState('networkidle')
  const text = await page.locator('.discord-notify-page').innerText()
  check('頁面上沒有 Discord 字樣', !/discord/i.test(text), (text.match(/.{0,12}discord.{0,12}/i) ?? [''])[0])
  check('沒有 Webhook URL 與 Discord ID 對照', !/Webhook/i.test(text) && !text.includes('Discord Tag'))
  check('啟用通知開關在、定時彙總報告在', text.includes('啟用通知') && text.includes('定時彙總報告'))
  await page.getByText('Spin 數', { exact: true }).first().click()
  await page.getByRole('button', { name: '儲存設定' }).click()
  await page.waitForTimeout(500)
  check('儲存走 notify-format，不帶 webhook url', !!formatPost && !('url' in formatPost) && typeof formatPost.fields === 'object', JSON.stringify(formatPost))
  await page.screenshot({ path: `autospin-notify-${theme}.png`, fullPage: true })
  await ctx.close()
}

// 手機寬度：不能橫向捲動
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
  const page = await ctx.newPage()
  await page.goto(`http://${HOST}:3000/?page=weekly-report`, { waitUntil: 'networkidle' })
  check('?page=weekly-report 直接開到週報頁、網址參數清掉', /週報彙整|行跡呈報/.test(await page.locator('.app-topbar-title').innerText()) && !page.url().includes('page='), page.url())
  await ctx.close()
}

await browser.close()
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)

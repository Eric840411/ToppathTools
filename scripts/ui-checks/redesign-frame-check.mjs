/**
 * 新版外框的 iframe 頁（圖片比對、Bonus V2）驗收：CodeX 1102 定案 B 的四條
 *   ① 兩種模式首次載入 iframe 都拿到對的 data-ui／data-theme-mode
 *   ② 執行中切模式：iframe 跟著換，而且沒有重載（重載會清掉結果）
 *   ③ 沒帶參數直接開：長相跟原本一樣（不設 data-ui、底色維持 #0f172a）
 *   ④ 只接受父視窗的訊息：自己對自己 postMessage 不會改模式
 * 跑在本機 server 上，但 server/static 那幾支用 worktree 的版本攔截替換（本機 server 跑的是主 repo 的 static），
 * 這樣不用另外起一台會跑排程的 server。
 * 跑法（在主 repo 目錄，DB 在那）：node ../toppath-wt-redesign/scripts/ui-checks/redesign-frame-check.mjs <base url> <輸出目錄>
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintDevSession } from './lib/dev-session.mjs'

const [H, out] = process.argv.slice(2)
if (!H || !out) { console.error('用法：node redesign-frame-check.mjs <base url> <輸出目錄>'); process.exit(2) }
const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'static')
const SERVE = {
  '/api/gs/img-compare': ['img-compare.html', 'text/html; charset=utf-8'],
  '/api/gs/bonus-v2': ['bonus-v2.html', 'text/html; charset=utf-8'],
  '/api/gs/redesign-frame.js': ['redesign-frame.js', 'application/javascript; charset=utf-8'],
  '/api/gs/redesign-frame.css': ['redesign-frame.css', 'text/css; charset=utf-8'],
}
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const fails = []
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails.push(msg) }

async function open(theme) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
  await ctx.addInitScript(t => { try { localStorage.setItem('toppath-theme-mode', t) } catch { /* */ } }, theme)
  await ctx.route(url => SERVE[url.pathname] !== undefined, route => {
    const [file, type] = SERVE[new URL(route.request().url()).pathname]
    route.fulfill({ status: 200, contentType: type, body: readFileSync(join(STATIC, file)) })
  })
  const p = await ctx.newPage()
  p.on('pageerror', e => fails.push(`${theme} pageerror: ${e.message}`))
  return { ctx, p }
}

async function goPage(p, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 子項的 textContent 會多出隱藏文字（例如仙俠名），不能用 ^…$；這兩頁名稱在側欄唯一，用包含即可
  void esc
  const item = () => p.locator('.sidebar-subtab-item').filter({ hasText: name })
  for (let i = 0; i < 3 && !(await item().count()); i++) {
    await p.locator('.sidebar-nav-item').filter({ hasText: /Game Show|幻境試煉/ }).first().click()
    await p.waitForTimeout(500)
  }
  if (!(await item().count())) console.log('sidebar:', (await p.locator('.sidebar-nav-item, .sidebar-subtab-item').allInnerTexts()).join(' | '))
  await item().first().click()
  await p.waitForTimeout(1800)
}

const frameAttrs = f => f.evaluate(() => ({
  ui: document.documentElement.dataset.ui ?? null,
  theme: document.documentElement.dataset.themeMode ?? null,
  marker: window.__rdMarker ?? null,
  bodyBg: getComputedStyle(document.body).backgroundColor,
}))

for (const theme of ['classic', 'xianxia']) {
  const { ctx, p } = await open(theme)
  await p.goto(H + '/', { waitUntil: 'networkidle' })
  for (const [name, path, shot] of [['圖片比對', '/api/gs/img-compare', 'img'], ['Bonus V2 統計', '/api/gs/bonus-v2', 'bonus']]) {
    await goPage(p, name)
    const f = p.frames().find(fr => new URL(fr.url()).pathname === path)
    ok(!!f, `${theme} ${name}: 找到 iframe`)
    if (!f) continue
    ok(new URL(f.url()).searchParams.get('theme') === theme, `${theme} ${name}: src 帶 theme=${theme}`)
    const a = await frameAttrs(f)
    ok(a.ui === 'redesign' && a.theme === theme, `${theme} ${name}: ① iframe data-ui=${a.ui} theme=${a.theme}`)
    ok(a.bodyBg === 'rgba(0, 0, 0, 0)', `${theme} ${name}: iframe 底色透明（${a.bodyBg}）`)
    await p.screenshot({ path: `${out}/frame-${theme}-${shot}.png` })
    // ④ 自己對自己送：不能改
    // 只送「另一個」模式：送跟現在一樣的值，就算沒擋也看不出來（1102 突變實測：普通版那輪原本不會紅）
    await f.evaluate(t => { window.__rdMarker = 'alive'; window.postMessage({ type: 'toppath-frame-theme', ui: 'redesign', theme: t }, location.origin) }, theme === 'classic' ? 'xianxia' : 'classic')
    await p.waitForTimeout(200)
    ok((await frameAttrs(f)).theme === theme, `${theme} ${name}: ④ 非父視窗的訊息被忽略`)
    // ② 切模式
    const other = theme === 'classic' ? 'xianxia' : 'classic'
    await p.locator('.rd-seg button[aria-pressed="false"]').first().click()
    await p.waitForTimeout(1500)
    const f2 = p.frames().find(fr => new URL(fr.url()).pathname === path)
    const c = f2 ? await frameAttrs(f2) : {}
    ok(c.theme === other, `${theme} ${name}: ② 切模式後 iframe theme=${c.theme}（要 ${other}）`)
    ok(c.marker === 'alive', `${theme} ${name}: ② 切模式沒有重載 iframe（marker=${c.marker}）`)
    await p.screenshot({ path: `${out}/frame-${theme}-${shot}-switched-${other}.png` })
    // 切回來，下一頁照原模式測
    await p.locator('.rd-seg button[aria-pressed="false"]').first().click()
    await p.waitForTimeout(1500)
  }
  await ctx.close()
}

// ③ 直接開、不帶參數
{
  const { ctx, p } = await open('classic')
  for (const path of ['/api/gs/img-compare', '/api/gs/bonus-v2']) {
    await p.goto(H + path, { waitUntil: 'load' }); await p.waitForTimeout(800)
    const a = await frameAttrs(p.mainFrame())
    ok(a.ui === null && a.theme === null, `${path}: ③ 不帶參數不設 data-ui（${a.ui}/${a.theme}）`)
    ok(a.bodyBg === 'rgb(15, 23, 42)', `${path}: ③ 不帶參數底色維持原本（${a.bodyBg}）`)
    await p.screenshot({ path: `${out}/frame-noparam-${path.split('/').pop()}.png` })
  }
  await ctx.close()
}

await b.close()
console.log(fails.length ? `\n${fails.length} FAIL` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

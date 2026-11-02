/**
 * 新版外框的 iframe 頁（圖片比對、Bonus V2）驗收：CodeX 1102 定案 B 的四條
 *   ① 兩種模式首次載入 iframe 都拿到對的 data-ui／data-theme-mode
 *   ② 執行中切模式：iframe 跟著換，而且沒有重載（重載會清掉結果）
 *   ③ 沒帶參數直接開：長相跟原本一樣（不設 data-ui、底色維持 #0f172a）
 *   ④ 只接受父視窗的訊息：自己對自己 postMessage 不會改模式
 *   ⑤ Bonus V2 偏差狀態色（.diff-ok／warn／bad）沒被新版的 td 文字色蓋掉（CodeX 1102 P2）
 *   ⑦ 三頁的操作按鈕同一套規格：高 36；圓角普通版 7（原型 .btn）、仙俠版 4（跟全站仙俠按鈕一致）——使用者 1102「按鈕沒有一致」
 *   ⑧ 三頁畫面上沒有裝飾用 emoji——使用者 1102「不需要 emoji，拿掉」（文字箭頭 ↑↓↔、✕ 關閉、▶ 展開指示不算）
 *   ⑥ 系統「減少動態」時 iframe 裡的動畫也停（狀態點不閃）；一般情況照閃，證明有在量（CodeX 1102 P2）
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
  '/api/gs/img-compare-app.js': ['img-compare-app.js', 'application/javascript; charset=utf-8'],
  '/api/gs/bonus-v2-app.js': ['bonus-v2-app.js', 'application/javascript; charset=utf-8'],
}
// ⑧ 裝飾 emoji：圖示字元區＋✅❌⚠⏹↺⬇（跟 strip 時同一組；▶ 只在後面接空白時算按鈕裝飾）
const EMOJI = /[\u{1F000}-\u{1FAFF}\u2705\u274C\u26A0\u23F9\u21BA\u2B07]|\u25B6(?= )/u
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const fails = []
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails.push(msg) }

async function open(theme, reducedMotion = 'no-preference') {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion })
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
    const txt = await f.evaluate(() => document.body.innerText)
    const hits = [...txt.matchAll(new RegExp(EMOJI, 'gu'))].map(m => m[0])
    ok(hits.length === 0, `${theme} ${name}: ⑧ 沒有裝飾 emoji（${hits.join(' ') || '無'}）`)
    // ⑦ 按鈕規格：看得到的操作按鈕（不含小按鈕）
    const btns = await f.evaluate(() => [...document.querySelectorAll('.btn-primary, .btn-success, .btn-secondary, .btn-muted, .btn-danger')]
      .filter(el => el.offsetParent && !el.classList.contains('btn-sm'))
      .map(el => `${el.textContent.trim()}=${getComputedStyle(el).height}/${getComputedStyle(el).borderTopLeftRadius}`))
    const want = theme === 'xianxia' ? '=36px/4px' : '=36px/7px'
    ok(btns.length > 0 && btns.every(x => x.endsWith(want)), `${theme} ${name}: ⑦ 按鈕${want}（${btns.join('、')}）`)
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

// ⑦ Log 攔截工具（React 頁）的按鈕也要同一套
for (const theme of ['classic', 'xianxia']) {
  const { ctx, p } = await open(theme)
  await p.goto(H + '/', { waitUntil: 'networkidle' })
  await goPage(p, 'Log 攔截工具')
  // 腳本原始碼（.gl-code）是要複製的內容、不是畫面，不算
  const ltxt = await p.evaluate(() => { const c = document.querySelector('.gl-page').cloneNode(true); c.querySelectorAll('.gl-code').forEach(e => e.remove()); document.body.appendChild(c); const t = c.innerText; c.remove(); return t })
  const lhits = [...ltxt.matchAll(new RegExp(EMOJI, 'gu'))].map(m => m[0])
  ok(lhits.length === 0, `${theme} Log 攔截工具: ⑧ 沒有裝飾 emoji（${lhits.join(' ') || '無'}）`)
  await p.locator('.rd-tab', { hasText: 'Log 結構比對' }).click()
  await p.waitForTimeout(800)
  const ctxt = await p.evaluate(() => document.querySelector('.gl-page').innerText)
  const chits = [...ctxt.matchAll(new RegExp(EMOJI, 'gu'))].map(m => m[0])
  ok(chits.length === 0, `${theme} Log 結構比對: ⑧ 沒有裝飾 emoji（${chits.join(' ') || '無'}）`)
  await p.locator('.rd-tab', { hasText: 'Log 攔截工具' }).click()
  await p.waitForTimeout(500)
  const btns = await p.evaluate(() => [...document.querySelectorAll('.gl-actions button')]
    .map(el => `${el.textContent.trim()}=${getComputedStyle(el).height}/${getComputedStyle(el).borderTopLeftRadius}`))
  const want = theme === 'xianxia' ? '=36px/4px' : '=36px/7px'
  ok(btns.length === 2 && btns.every(x => x.endsWith(want)), `${theme} Log 攔截工具: ⑦ 按鈕${want}（${btns.join('、')}）`)
  await ctx.close()
}

// ⑤ 狀態色、⑥ 減少動態：都在 Bonus V2 的 iframe 裡量
for (const rm of ['no-preference', 'reduce']) {
  const { ctx, p } = await open('classic', rm)
  await p.goto(H + '/', { waitUntil: 'networkidle' })
  await goPage(p, 'Bonus V2 統計')
  const f = p.frames().find(fr => new URL(fr.url()).pathname === '/api/gs/bonus-v2')
  const r = await f.evaluate(() => {
    const tb = document.getElementById('tbody-m2')
    const tr = document.createElement('tr')
    tr.innerHTML = '<td class="diff-ok">ok</td><td class="diff-warn">w</td><td class="diff-bad">b</td><td>plain</td>'
    tb.appendChild(tr)
    const c = [...tr.children].map(td => getComputedStyle(td).color)
    tr.remove()
    const dot = document.getElementById('statusDot')
    dot.classList.add('active')
    const anim = getComputedStyle(dot).animationDuration
    dot.classList.remove('active')
    return { c, anim }
  })
  if (rm === 'no-preference') {
    ok(r.c[0] === 'rgb(22, 163, 74)' && r.c[1] === 'rgb(217, 119, 6)' && r.c[2] === 'rgb(220, 38, 38)', `⑤ 偏差狀態色保留（${r.c.slice(0, 3).join(' / ')}）`)
    ok(r.c[3] !== r.c[2], `⑤ 一般格不是紅色（${r.c[3]}），比對有意義`)
    ok(r.anim === '1s', `⑥ 一般情況狀態點照閃（animation ${r.anim}）`)
  } else {
    ok(r.anim === '0s', `⑥ 減少動態時狀態點不閃（animation ${r.anim}）`)
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

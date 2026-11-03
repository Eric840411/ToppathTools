/**
 * 修仙版「普通版藍黑殘留」掃描：逐頁讀每個看得到的元素的 computed style，找出還是普通版 slate／navy 色系的地方。
 *
 * 為什麼要掃：App.css 等舊樣式寫死了大量 #162032／#2d3f55／#0f172a／#1e293b／#263345（外加 TSX 行內樣式），
 * 修仙版 token 只換得到有用 var(--rd-*) 的地方；寫死的會安靜地留在畫面上，使用者只能一個一個截圖回報（1103）。
 * 修仙版色相在 150～175°（墨綠／玉），普通版 slate 在 200～235°，用色相就分得開，不用肉眼看。
 *
 * 判定（HSL）：
 *   navy-bg／navy-border：色相 195～240、飽和 > 12%、亮度 ≤ 40%（#0f172a #162032 #1e293b #263345 #2d3f55 #334155 #475569 都在內）
 *   slate-text：文字色色相 195～240、飽和 > 12%、亮度 30～86%（#64748b #94a3b8 #cbd5e1）
 *   blue-accent：色相 200～235、飽和 > 60%、亮度 40～80%（#3b82f6 #60a5fa…），可能是語意色，報告裡另列由人判斷
 *   背景含漸層：background-image 裡的 rgb() 色標也一樣判
 *
 * 跑法（主 repo 目錄，DB 在那）：
 *   node ../toppath-wt-redesign/scripts/ui-checks/xianxia-navy-sweep.mjs <base url> <輸出 json> [頁名過濾 regex]
 *   THEME_MODE=classic   改掃普通版（拿來對照，不是驗收）
 *   STRIP=<字串>         先把 selector 含這段字串的修仙版規則從 CSSOM 拿掉再量——證明掃描抓得到已知壞掉的元素
 *                        （例：STRIP=.osm-target-row 應該要在 OSM 版號同步報出 navy-bg）
 *   NO_CLICK=1           不點分頁／展開
 *   SHOTS=<目錄>         每頁存一張整頁截圖
 * 每頁量哪些狀態（輸出「量過的狀態」那行會逐一列出）：
 *   ① 載入完 ② OSM 版號同步的「全部同步／一鍵全部取得／取得元件版本」（都是讀取；POST /api/osm/sync 只寫記憶體快取＋一筆操作歷史）
 *   ③ 分頁（role=tab、.rd-tab、class 含 tab 的按鈕）、展開類（展開／排程設定／…設定／詳細／進階／更多／▼▶、aria-expanded=false、summary），
 *      並把所有 <details> 打開——一輪一輪做，點分頁後才長出來的展開鈕下一輪會抓到
 *   ④ 「新增／編輯」彈窗：開了只量，再按取消／關閉（或 Esc）；關不掉就重新載入
 * 文字黑名單（刪除、儲存、送出、執行、確定…）一律不點；另外整個 context 擋掉所有非 GET 的 /api（少數讀取用 POST 白名單見 READ_POST），
 * 就算誤點也寫不進去。
 * 防沉默：每頁印出量到的元素數與側欄選中項，對不上就標 ⚠ 並讓退出碼變 1（0 筆違規但根本沒切到頁，不算通過）。
 * STRIP_ANY=1 讓 STRIP 不限修仙版規則（例：STRIP=':root[data-ui="redesign"] .osm-alert-config' STRIP_ANY=1 應報出排程設定框 navy-bg）
 * 退出碼：有 navy-bg／navy-border／slate-text 就是 1（blue-accent 只列出來，不算失敗）。
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintDevSession } from './lib/dev-session.mjs'

const [H, out, filter] = process.argv.slice(2)
if (!H || !out) { console.error('用法：node xianxia-navy-sweep.mjs <base url> <輸出 json> [頁名過濾 regex]'); process.exit(2) }
const MODE = process.env.THEME_MODE || 'xianxia'
const STRIP = process.env.STRIP || ''
const SHOTS = process.env.SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
// Game Show iframe 的 server/static：本機 server 跑主 repo 的版本，改吃 worktree 的（同 redesign-shot-data.mjs）
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
const blocked = new Set()
// 用 POST 但只讀遠端／不改資料的端點（OSM 全部同步只寫記憶體快取＋一筆操作歷史，使用者 1103 同意掃描時可按）
const READ_POST = /^\/api\/(dashboard\/heartbeat|osm\/sync(\/[^/]+)?|integrations\/gmail\/latest-report|weekly-report\/(parse|sheet-headers))$/
// 保險：掃描期間擋掉所有非 GET 的 API（就算誤點到寫入按鈕也送不出去）
await ctx.route(url => url.pathname.startsWith('/api/'), route => {
  const m = route.request().method()
  const path = new URL(route.request().url()).pathname
  if (m === 'GET' || m === 'HEAD' || READ_POST.test(path)) return route.fallback()
  blocked.add(`${m} ${path}`)
  return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"blocked by navy sweep"}' })
})
await ctx.addInitScript((MODE) => { try { localStorage.setItem('toppath-theme-mode', MODE) } catch { /* */ } }, MODE)
const p = await ctx.newPage()
p.on('dialog', d => d.dismiss().catch(() => {}))
await p.goto(H + '/', { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)

/** 在單一 document 裡量（主頁與每個 iframe 各跑一次） */
function scanDoc({ strip, anyRule }) {
  if (strip) {
    const walk = owner => { const list = owner.cssRules; for (let i = list.length - 1; i >= 0; i--) { const r = list[i]
      if (r.cssRules && !r.selectorText) walk(r)
      else if (r.selectorText && r.selectorText.includes(strip) && (anyRule || r.selectorText.includes('xianxia'))) owner.deleteRule(i) } }
    for (const s of document.styleSheets) { try { walk(s) } catch { /* 跨源 */ } }
  }
  // computed 色有兩種寫法：rgb()/rgba()，以及 color-mix() 算出來的 color(srgb r g b / a)（0～1）——後者不解析的話，token 混色出來的藍黑會整個漏掉
  const parse = c => {
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (m) { const [r, g, bb, a = '1'] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b: bb, a: Number(a) } }
    const n = c.match(/color\(srgb ([^)]+)\)/)
    if (n) { const [r, g, bb, a = 1] = n[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: r * 255, g: g * 255, b: bb * 255, a: Number(a) } }
    return null }
  const hsl = ({ r, g, b }) => { r /= 255; g /= 255; b /= 255
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn
    if (!d) return { h: 0, s: 0, l: l * 100 }
    const s = d / (1 - Math.abs(2 * l - 1))
    const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4)
    return { h: (h + 360) % 360, s: s * 100, l: l * 100 } }
  const hex = ({ r, g, b }) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
  const kind = (c, prop) => { if (!c || c.a < 0.08) return null; const { h, s, l } = hsl(c)
    if (prop === 'color') { if (h >= 195 && h <= 240 && s > 12 && l >= 30 && l <= 86) return s > 60 ? 'blue-accent' : 'slate-text'; return null }
    if (h >= 195 && h <= 240 && s > 70 && l >= 30 && l <= 80) return "blue-accent"  // 飽和藍（角色色、狀態點）不是 slate 底
    if (h >= 195 && h <= 240 && s > 12 && l <= 40) return c.a < 0.25 ? null : (prop === 'bg' ? 'navy-bg' : 'navy-border')
    if (h >= 200 && h <= 235 && s > 60 && l >= 40 && l <= 80) return 'blue-accent'
    return null }
  const sig = el => { const parts = []; let e = el
    for (let i = 0; e && e.nodeType === 1 && i < 9 && e !== document.body; i++, e = e.parentElement) {
      const cls = [...e.classList].filter(c => !/^(is-|active$|open$|selected$)/.test(c)).slice(0, 2)
      parts.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls.length ? '.' + cls.join('.') : ''))
      if (e.id || (cls.length && i >= 1)) break }
    return parts.join(' > ') }
  const found = []
  const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg, canvas, video, img, script, style, noscript')) continue
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    const inline = el.getAttribute('style') || ''
    const push = (prop, c, k) => found.push({ sel: sig(el), prop, color: hex(c) + (c.a < 1 ? `/${c.a}` : ''), kind: k,
      inline: /background|border|color/.test(inline) ? inline.slice(0, 140) : '', text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) })
    const bg = parse(cs.backgroundColor); const kb = kind(bg, 'bg'); if (kb) push('background-color', bg, kb)
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/url\(/.test(cs.backgroundImage)) {
      for (const m of cs.backgroundImage.matchAll(/rgba?\([^)]+\)|color\(srgb [^)]+\)/g)) { const c = parse(m[0]); const k = kind(c, 'bg'); if (k) { push('background-image', c, k); break } } }
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) < 0.5 || cs[`border${side}Style`] === 'none') continue
      const c = parse(cs[`border${side}Color`]); const k = kind(c, 'border'); if (k) { push(`border-${side.toLowerCase()}-color`, c, k); break } }
    if (ownText(el) || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) { const c = parse(cs.color); const k = kind(c, 'color'); if (k) push('color', c, k) }
  }
  const mainEls = [...document.querySelectorAll('.main-content *')].filter(e => e.getClientRects().length).length
  const title = ((document.querySelector('.sidebar-subtab-item--active') ?? document.querySelector('.sidebar-nav-item--active'))?.textContent || document.title || '').trim().slice(0, 30)
  return { found, mainEls, title }
}

const allFindings = {}
/** 每頁實際量到多少個 .main-content 元素、側欄選中的是哪一項——0 筆違規但這裡也是 0／對不上，代表根本沒切到那頁（沉默不等於通過） */
const coverage = {}
const record = (page, list) => {
  const m = (allFindings[page] ??= new Map())
  for (const f of list) { const key = `${f.frame}|${f.sel}|${f.prop}|${f.color}`
    const cur = m.get(key); if (cur) cur.count++; else m.set(key, { ...f, count: 1 }) }
}
const scanAll = async (page, label) => {
  for (const fr of p.frames()) {
    let r; try { r = await fr.evaluate(scanDoc, { strip: STRIP, anyRule: !!process.env.STRIP_ANY }) } catch { continue }
    const fname = fr === p.mainFrame() ? '' : new URL(fr.url()).pathname
    if (!fname) { const c = (coverage[page] ??= { mainEls: 0, title: r.title }); c.mainEls = Math.max(c.mainEls, r.mainEls) }
    else (coverage[page] ??= { mainEls: 0, title: '' }).frames = ((coverage[page].frames ?? 0) + 1)
    record(page, r.found.map(f => ({ ...f, frame: fname, at: label })))
  }
}
// 只點讀取類：分頁、展開類、<details>，最後才開「新增／編輯」彈窗（開了只量、再按取消；任何非 GET 都已在上面擋掉）
const DANGER = /[×✕✖▲]|排序|上移|下移|刪|删|移除|送出|提交|儲存|保存|寫入|回寫|上傳|開單|建立|執行|開始|停止|重啟|清除|清空|重置|套用|發送|推送|登出|匯入|同步到|確定|確認|delete|remove|save|submit|send|run|start|stop|reset|apply|import|confirm/i
// 只有箭頭的按鈕不點（OSM 版本更新紀錄的 ▲▼ 是排序，會送 POST /api/osm-releases/reorder）；箭頭後面要接文字才算展開
const EXPAND = /^[\s▼▶▸►+]*(全部)?展開|排程設定|設定$|詳細|進階|更多|^[\s]*[▼▶▸►]\s*[^\s▲▼▶▸►]{2,}/
const MODAL_OPEN = /^[\s+＋]*(新增|編輯)/
const MODAL_SEL = '.modal-overlay, .rd-modal-back, .rd-modal, [role="dialog"], .modal, .msp-modal, .orl-modal, .orl-drawer, .uat-schedule-overlay'
const states = {}
const textOf = async el => ((await el.innerText({ timeout: 800 }).catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 40)
const modalOpen = async () => { for (const l of await p.locator(MODAL_SEL).all()) if (await l.isVisible().catch(() => false)) return l; return null }
const closeModal = async () => {
  for (let k = 0; k < 3; k++) {
    const m = await modalOpen(); if (!m) return true
    const btn = m.locator('button').filter({ hasText: /^\s*(取消|關閉|Close|返回)\s*$/ }).filter({ visible: true }).first()
    if (await btn.count()) await btn.click({ timeout: 1500 }).catch(() => {})
    else await p.keyboard.press('Escape')
    await p.waitForTimeout(500)
  }
  return !(await modalOpen())
}
const clickReadOnly = async (page) => {
  const seen = new Set(); let clicks = 0
  const st = (states[page] ??= ['load'])
  const scanAs = async label => { st.push(label); await scanAll(page, label) }
  // ① 分頁＋展開類，一輪一輪做（點了分頁才長出來的展開鈕下一輪會抓到）
  for (let round = 0; round < 3 && clicks < 45; round++) {
    // <details> 直接打開（不會觸發任何請求）
    const opened = await p.evaluate(() => { let n = 0; for (const d of document.querySelectorAll('.main-content details:not([open])')) { d.open = true; n++ } return n })
    if (opened) await scanAs(`details×${opened}`)
    const cand = p.locator('.main-content').locator('[role="tab"], .rd-tab, button[class*="tab" i], summary, button[aria-expanded="false"]')
      .or(p.locator('.main-content button').filter({ hasText: EXPAND }))
    const list = []
    for (const el of await cand.all()) {
      if (!(await el.isVisible().catch(() => false))) continue
      const t = await textOf(el)
      if (!t || DANGER.test(t) || MODAL_OPEN.test(t) || seen.has(t)) continue
      list.push([el, t])
    }
    if (!list.length) break
    for (const [, t] of list) {
      if (clicks >= 45) break
      seen.add(t); clicks++
      // 前一個點擊可能讓 React 重畫，先前拿到的 handle 會失效（點了也沒反應、而且不報錯）——每次照文字重新找
      // innerText 有換行（「OSM\n176」），這裡已壓成單一空白，比對時空白放寬成 \s*
      const el = cand.filter({ hasText: new RegExp(t.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')) }).filter({ visible: true }).first()
      const ok = await el.click({ timeout: 2000 }).then(() => true, () => false)
      if (process.env.VERBOSE) console.log(`  點 ${t}${ok ? '' : '（點不到）'}`)
      if (!ok) { st.push(`點不到:${t}`); continue }
      await p.waitForTimeout(900)
      if (await modalOpen()) { await scanAs(`modal(${t})`); if (!(await closeModal())) return false }
      else await scanAs(`tab/expand:${t}`)
    }
  }
  // ② 新增／編輯彈窗：每頁最多開 4 種，開了只量，按取消關掉
  const openers = []
  for (const el of await p.locator('.main-content button').filter({ hasText: MODAL_OPEN }).all()) {
    if (!(await el.isVisible().catch(() => false)) || await el.isDisabled().catch(() => true)) continue
    const t = await textOf(el); if (!t || seen.has(t) || /刪|删|移除/.test(t)) continue
    seen.add(t); openers.push([el, t]); if (openers.length >= 4) break
  }
  for (const [el, t] of openers) {
    if (process.env.VERBOSE) console.log(`  開彈窗 ${t}`)
    await el.click({ timeout: 2000 }).catch(() => {})
    await p.waitForTimeout(1000)
    if (await modalOpen()) { await scanAs(`modal(${t})`); if (!(await closeModal())) return false }
    else await scanAs(`inline(${t})`)
  }
  return true
}
const navBad = []
const OSM_READ = ['全部同步', '一鍵全部取得', '取得元件版本']

// 頁面清單：側欄頂層＋群組子項
const groups = []
const tops = await p.locator('.sidebar-nav-item').filter({ visible: true }).allInnerTexts()
for (const t of tops.map(s => s.trim().split('\n')[0].trim()).filter(Boolean)) groups.push(t)
const pages = []
for (const g of groups) {
  const before = new Set(await p.locator('.sidebar-subtab-item').allInnerTexts())
  await p.locator('.sidebar-nav-item').filter({ hasText: g }).first().click().catch(() => {})
  await p.waitForTimeout(500)
  const subs = (await p.locator('.sidebar-subtab-item').filter({ visible: true }).allInnerTexts()).map(s => s.trim()).filter(s => s && !before.has(s))
  if (subs.length) for (const s of subs) pages.push({ group: g, sub: s })
  else pages.push({ group: g, sub: null })
}
console.log(`${MODE}：${pages.length} 頁${STRIP ? `（STRIP=${STRIP}）` : ''}`)
if (process.env.LIST) { console.log(pages.map(x => x.sub ? `${x.group} / ${x.sub}` : x.group).join('\n')); await b.close(); process.exit(0) }

for (const pg of pages) {
  const name = pg.sub ? `${pg.group} / ${pg.sub}` : pg.group
  if (filter && !new RegExp(filter).test(name)) continue
  const esc = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const subLoc = () => p.locator('.sidebar-subtab-item').filter({ hasText: esc(pg.sub) }).filter({ visible: true })
  const activeText = () => p.evaluate(() => ((document.querySelector('.sidebar-subtab-item--active') ?? document.querySelector('.sidebar-nav-item--active'))?.textContent || '').trim())
  for (let tryN = 0; tryN < 3; tryN++) {
    if (pg.sub) {
      if (!(await subLoc().count())) { await p.locator('.sidebar-nav-item').filter({ hasText: esc(pg.group) }).first().click().catch(() => {}); await p.waitForTimeout(400) }
      await subLoc().first().click({ timeout: 3000 }).catch(() => {})
    } else await p.locator('.sidebar-nav-item').filter({ hasText: esc(pg.group) }).first().click({ timeout: 3000 }).catch(() => {})
    await p.waitForTimeout(400)
    if ((await activeText()).includes(pg.sub ?? pg.group)) break
  }
  await p.waitForTimeout(2500)
  await scanAll(name, 'load')
  if (/版號同步|靈脈校準|Version/i.test(name)) for (const t of OSM_READ) {
    const btn = p.locator('.main-content button').filter({ hasText: t }).filter({ visible: true }).first()
    if (await btn.count()) { await btn.click().catch(() => {}); await p.waitForTimeout(4000); (states[name] ??= ['load']).push(`btn:${t}`); await scanAll(name, `btn:${t}`) }
  }
  ;(states[name] ??= ['load'])
  if (!process.env.NO_CLICK && !(await clickReadOnly(name))) {
    console.log(`  ⚠ ${name}：彈窗關不掉，重新載入`); states[name].push('（彈窗關不掉→重新載入）')
    await p.reload({ waitUntil: 'networkidle' }).catch(() => {}); await p.waitForTimeout(1200)
  }
  if (SHOTS) await p.screenshot({ path: join(SHOTS, name.replace(/[\\/:*?"<>| ]+/g, '_') + '.png'), fullPage: true }).catch(() => {})
  const m = allFindings[name]; const n = m ? m.size : 0
  const cv = coverage[name] ?? { mainEls: 0, title: '' }
  const okNav = (cv.mainEls >= 15 || cv.frames > 0) && (!pg.sub || cv.title.includes(pg.sub)) && (pg.sub || cv.title.includes(pg.group))
  if (!okNav) navBad.push(name)
  console.log(`${name.padEnd(36)} ${String(n).padStart(4)}   元素 ${String(cv.mainEls).padStart(5)}${cv.frames ? `＋iframe ${cv.frames}` : ''}${okNav ? '' : `   ⚠ 沒切到這頁？（側欄選中「${cv.title}」）`}`)
  if (process.env.STATES !== '0') console.log(`      量過的狀態（${states[name].length}）：${states[name].join('｜')}`)
}

const report = Object.fromEntries(Object.entries(allFindings).map(([k, m]) => [k, [...m.values()]]))
writeFileSync(out, JSON.stringify({ mode: MODE, strip: STRIP, at: new Date().toISOString(), coverage, navBad, states, report }, null, 2))
/** 量到藍色但是刻意的（理由寫清楚；不要為了讓數字變 0 往這裡塞） */
const ALLOW = [
  [f => /button\.office-app$/.test(f.sel), '文書工具磚：底色／框是各工具自己的強調色（Word 藍、Fig、Film）混墨綠，xianxia.css 的 .office-app 規則刻意的'],
  [f => /article\.uat-stat$/.test(f.sel) && /^待確認/.test(f.text), 'UAT 統計磚「待確認／受阻」是 is-manual 紫色調（#a78bfa）跟墨綠面板混出來的色相，語意色'],
]
for (const list of Object.values(report)) for (const f of list) {
  const a = f.kind !== 'blue-accent' && ALLOW.find(([t]) => t(f)); if (a) { f.allowed = a[1]; f.kind = 'allowed' }
}
let hard = 0, soft = 0
console.log('\n── 明細（每頁依 selector 合併）──')
for (const [pg, list] of Object.entries(report)) {
  if (!list.length) continue
  console.log(`\n## ${pg}`)
  for (const f of list.sort((a, b) => a.kind.localeCompare(b.kind) || a.sel.localeCompare(b.sel))) {
    if (f.kind === 'blue-accent' || f.kind === 'allowed') soft++; else hard++
    console.log(`  [${f.kind}] ${f.frame ? f.frame + ' :: ' : ''}${f.sel}  ${f.prop}=${f.color}  ×${f.count}${f.inline ? '  (inline)' : ''}  「${f.text}」${f.allowed ? `  ← 例外：${f.allowed}` : ''}`)
  }
}
if (blocked.size) console.log(`\n擋下的非 GET 呼叫：${[...blocked].join('、')}`)
console.log(`\n合計：navy/slate ${hard} 筆、blue-accent／例外 ${soft} 筆（另列，要人看過是不是語意色）→ ${out}`)
await b.close()
if (navBad.length) console.log(`⚠ ${navBad.length} 頁沒有確認切換成功：${navBad.join('、')}——這些頁的 0 筆不算數`)
process.exit(hard || navBad.length ? 1 : 0)

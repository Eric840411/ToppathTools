/**
 * 修仙版視覺效果（靈光／陣法紋／文字浮現／卡片光暈）的兩模式驗證。
 *
 *   node scripts/ui-checks/xianxia-fx-modes.mjs
 *
 * 為什麼要有這支：使用者的要求是「只改仙俠版，不可以動到普通版」。
 * 普通版的保護來自 `App.tsx` 在切回普通版時把 `xianxia-complete.css` 整份
 * `<link>` 移除——**所以這支一定要重現「掛上／移除 link」這個真實機制**，
 * 不能只切 `data-theme-mode` 屬性（那樣驗不到真正的保護是否成立）。
 *
 * ⚠️ 讀的是 `dist/`，要先 `npm run build`。讀 build 產物才驗得到
 *    「素材路徑在 build 後仍然解析得到」——那是只在正式輸出才現形的問題。
 * ⚠️ 它不驗真實資料下的版面密度，那仍然要人看。
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

const DIST = 'dist'
if (!existsSync(DIST)) { console.error('找不到 dist/，請先跑 npm run build'); process.exit(1) }
const cssFile = readdirSync(join(DIST, 'assets')).find(f => /^index-.*\.css$/.test(f))
if (!cssFile) { console.error('dist/assets 裡找不到 index-*.css'); process.exit(1) }

let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}
const ok = (name, cond, detail) => eq(name + (detail ? ' (' + detail + ')' : ''), !!cond, true)

// 每日仙語是整句——刻意用超過 8 個字，這正是 mockup 原本 :nth-child 寫法會壞掉的地方
const QUOTE = '我自一路行來，所過之處，寸草不生'
const WORDS = Array.from('「' + QUOTE + '」')
  .map((c, i) => '<span class="xx-w" style="--i:' + i + '">' + c + '</span>').join('')

const HTML = [
  '<!doctype html>',
  '<html lang="zh-Hant"><head><meta charset="utf-8">',
  '<link rel="stylesheet" href="/assets/' + cssFile + '">',
  '<style>body{margin:0;padding:18px;background:#0b1722;font-family:system-ui,sans-serif;color:#e8edf0}',
  ' .section-card{border:1px solid #334155;border-radius:10px;padding:14px;margin-bottom:12px;background:#0f1b29}',
  ' .osm-empty{text-align:center;padding:40px;border-radius:10px;border:1.5px dashed #2d3f55;color:#475569;margin-bottom:12px}',
  ' .loading-state{display:flex;flex-direction:column;align-items:center;padding:32px 0;gap:8px}',
  ' .loading-spinner{width:36px;height:36px;border:3px solid #2d3f55;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite}',
  ' @keyframes spin{to{transform:rotate(360deg)}}',
  ' .badge{display:inline-block;padding:2px 8px;border:1px solid #334155;border-radius:4px;font-size:12px}',
  // 照 UatStudio.css 的真實數值：min-height 只有 110px。
  // v4.146.0 的法陣寫死 176px，在這種盒子裡會被切成一條橫帶。
  ' .uat-net-empty{display:flex;min-height:110px;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:16px;text-align:center;color:#8996a3}',
  '</style></head><body>',
  // 2026-09-16 正式站回報：普通版看得到修仙版底圖。這個 fixture 原本沒有 .main-content，
  // 所以那個洞完全掃不到——29 項全過，實際上普通版是壞的。
  '<div class="main-content" id="main"><div class="section-card" id="card">一張卡</div>',
  '<div class="osm-empty" id="empty">目前沒有資料</div>',
  '<div class="loading-state"><div class="loading-spinner" id="spin"></div><span>讀取中…</span></div>',
  '<span class="badge" id="badge">徽章</span>',
  '<div class="uat-net-empty" id="short"><strong>尚未起測</strong><span>推演開始後此處即現每道法訊與靈影的往返耗時</span></div>',
  '<div class="xx-glow" id="glow" style="border:1px solid #7a6a3d;border-radius:8px;padding:14px 18px;margin-top:12px">',
  '<span class="xx-reveal" id="rev">' + WORDS + '</span>',
  '</div>',
  '</div>',
  '<script>',
  'window.setXianxia = function (on) {',
  '  var ID = "xianxia-theme-link";',
  '  var cur = document.getElementById(ID);',
  '  if (on && !cur) {',
  '    var l = document.createElement("link");',
  '    l.id = ID; l.rel = "stylesheet"; l.href = "/xianxia-complete.css";',
  '    document.head.appendChild(l);',
  '  } else if (!on && cur) { cur.remove(); }',
  '};',
  '</' + 'script></body></html>',
].join('\n')

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png' }
const srv = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HTML)
  }
  const p = join(DIST, url)
  if (!existsSync(p)) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' })
  res.end(readFileSync(p))
})
await new Promise(r => srv.listen(5401, r))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 620, height: 640 }, deviceScaleFactor: 2 })
const http404 = []
page.on('response', r => { if (r.status() >= 400) http404.push(r.status() + ' ' + r.url()) })
await page.goto('http://127.0.0.1:5401/')

const probe = () => page.evaluate(() => {
  const g = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo)
  const words = [...document.querySelectorAll('.xx-w')]
  const last = words[words.length - 1]
  return {
    spinBg: g('#spin').backgroundImage,
    spinBorder: g('#spin').borderTopWidth,
    spinAnim: g('#spin').animationDuration,
    emptyBg: g('#empty', '::before').backgroundImage,
    emptyOverflow: g('#empty').overflow,
    glowAfter: g('#glow', '::after').backgroundImage,
    mainBg: g('#main', '::before').backgroundImage,
    shortBoxH: document.querySelector('#short').getBoundingClientRect().height,
    shortRuneH: parseFloat(g('#short', '::before').height) || 0,
    shortRuneW: parseFloat(g('#short', '::before').width) || 0,
    shortRuneBg: g('#short', '::before').backgroundImage,
    wordCount: words.length,
    firstDelay: getComputedStyle(words[0]).animationDelay,
    lastDelay: getComputedStyle(last).animationDelay,
    lastAnimName: getComputedStyle(last).animationName,
    lastOpacity: getComputedStyle(last).opacity,
  }
})

const hoverProbe = async sel => {
  await page.hover(sel); await page.waitForTimeout(320)
  const r = await page.evaluate(s => {
    const cs = getComputedStyle(document.querySelector(s))
    return { transform: cs.transform, shadow: cs.boxShadow }
  }, sel)
  await page.mouse.move(5, 5); await page.waitForTimeout(280)
  return r
}

// ── 普通版（完全沒有掛 xianxia-complete.css）──
const classic = await probe()
const classicCardHover = await hoverProbe('#card')
const classicBadgeHover = await hoverProbe('#badge')
await page.screenshot({ path: 'xianxia-fx-classic.png', fullPage: true })

// ── 修仙版 ──
await page.evaluate(() => window.setXianxia(true))
await page.waitForTimeout(600)
const xianxia = await probe()
const xxCardHover = await hoverProbe('#card')
const xxBadgeHover = await hoverProbe('#badge')
await page.screenshot({ path: 'xianxia-fx-xianxia.png', fullPage: true })

// ── 切回普通版：確認真的收得乾淨 ──
await page.evaluate(() => window.setXianxia(false))
await page.waitForTimeout(400)
const back = await probe()

await browser.close(); srv.close()

console.log('\n── 普通版：四種效果一個都不能出現 ──')
eq('spinner 維持原本的 CSS 圈（有邊框）', classic.spinBorder, '3px')
eq('spinner 沒有法陣素材', classic.spinBg, 'none')
eq('空狀態沒有法陣背景', classic.emptyBg, 'none')
eq('卡片 hover 不位移', classicCardHover.transform, 'none')
eq('徽章 hover 沒有鎏金光圈', classicBadgeHover.shadow, 'none')
eq('卡片光暈的 ::after 不存在', classic.glowAfter, 'none')
// 這一條就是正式站那個洞：背景圖放在兩個模式共用的 App.css 裡
ok('主內容區沒有修仙版底圖', !/themes\/xianxia/.test(classic.mainBg), classic.mainBg.slice(0, 70))
ok('逐字 span 仍然看得見（沒有那份 CSS 就不該被藏起來）', classic.lastOpacity === '1', 'opacity=' + classic.lastOpacity)

console.log('\n── 修仙版：四種效果都要在 ──')
ok('① spinner 換成法陣素材', xianxia.spinBg.includes('loading-array-64.webp'), xianxia.spinBg.slice(0, 58))
eq('① spinner 邊框收掉（不然法陣外面還有一圈藍）', xianxia.spinBorder, '0px')
eq('① spinner 轉速蓋掉原本的 .8s', xianxia.spinAnim, '9s')
ok('② 空狀態有法陣背景', xianxia.emptyBg.includes('loading-array-192.webp'), xianxia.emptyBg.slice(0, 58))
// v4.146.1：法陣改成跟著盒子縮，所以不再需要用 overflow 裁切。
// ⚠️ 這條不是刪掉舊斷言，是換成更強的那個——真正要守的是「法陣有沒有被切」，
//    下面「矮盒子」那組才是本體；靠 overflow:hidden 只是把裁切藏起來，看起來一樣壞。
eq('② 空狀態不靠 overflow 裁切（法陣本身就會縮進去）', xianxia.emptyOverflow, 'visible')
ok('③ 卡片 hover 會浮起', xxCardHover.transform !== 'none', xxCardHover.transform)
ok('③ 徽章 hover 有鎏金光圈', xxBadgeHover.shadow !== 'none')
ok('③ 徽章 hover 不位移（inline 元素套 transform 會壞版）', xxBadgeHover.transform === 'none', xxBadgeHover.transform)
ok('④ 卡片光暈的 ::after 有漸層', xianxia.glowAfter.includes('gradient'))
ok('修仙版才有的底圖，在修仙版要在', /themes\/xianxia/.test(xianxia.mainBg), xianxia.mainBg.slice(0, 70))

// ── 使用者 2026-09-16 回報的裁切：min-height 只有 110px 的盒子放不下寫死的 176px 法陣 ──
// 實測 110px 高的盒子裡，176px 的圓只露出 137px 寬的弦——上下被削平，看起來像素材壞了。
console.log('\n── 矮盒子（min-height 110px）：法陣要縮進去，不能被裁 ──')
ok('矮盒子也有法陣', xianxia.shortRuneBg.includes('loading-array-192.webp'))
ok('法陣高度不超過盒子（超過就會被切成一條橫帶）',
  xianxia.shortRuneH > 0 && xianxia.shortRuneH <= xianxia.shortBoxH + 0.5,
  '法陣 ' + xianxia.shortRuneH.toFixed(1) + 'px / 盒子 ' + xianxia.shortBoxH.toFixed(1) + 'px')
ok('法陣仍是正圓（寬高相等），沒有被壓扁',
  Math.abs(xianxia.shortRuneW - xianxia.shortRuneH) < 0.5,
  xianxia.shortRuneW.toFixed(1) + ' x ' + xianxia.shortRuneH.toFixed(1))
ok('縮完仍在 36px 的可辨識下限之上',
  xianxia.shortRuneH >= 36, xianxia.shortRuneH.toFixed(1) + 'px')
eq('普通版的矮盒子沒有法陣', classic.shortRuneBg, 'none')

console.log('\n── 文字浮現：mockup 那個「第 9 字之後永遠看不見」的坑 ──')
ok('逐字拆開', xianxia.wordCount > 8, xianxia.wordCount + ' 個字')
eq('第 1 字沒有延遲', xianxia.firstDelay, '0s')
ok('最後一個字有遞增延遲，不是 0s', xianxia.lastDelay !== '0s', 'delay=' + xianxia.lastDelay)
ok('最後一個字真的掛上動畫（不會停在 opacity:0）',
  xianxia.lastAnimName === 'xx-rise', 'animation-name=' + xianxia.lastAnimName)

console.log('\n── 切回普通版：要收得乾淨，不能留殘影 ──')
eq('spinner 還原成 CSS 圈', back.spinBorder, '3px')
eq('空狀態法陣消失', back.emptyBg, 'none')
eq('卡片光暈消失', back.glowAfter, 'none')

console.log('\n── 資源載入 ──')
eq('沒有 404（素材路徑在 build 後解析得到）', http404, [])

console.log('\n通過 ' + pass + '｜失敗 ' + fails.length)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }

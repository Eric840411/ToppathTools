/**
 * 型號標籤的兩套外觀（普通版／修仙版）視覺驗證。
 *
 *   node scripts/ui-checks/osm-modeltag-modes.mjs
 *
 * 為什麼需要這支：機種分布彈窗的資料只從 `POST /api/osm/sync` 來、不落 DB，
 * 所以要在真實畫面上看到這個標籤，得先對 8 個渠道的 OSM 後台真的同步一次——
 * 那是會打到正式後台的動作。這支改成**載入 build 出來的真實 CSS 與素材**，
 * 用同一份 DOM 結構渲染，就能在不碰後台的情況下驗到外觀。
 *
 * ⚠️ 讀的是 `dist/`，所以要先 `npm run build`。
 * ⚠️ 它驗的是「CSS 有沒有照 data-theme-mode 分開套用」與「素材路徑在 build 後仍解析得到」，
 *    不驗版面在真實資料下的密度——那仍然要人看。
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

const DIST = 'dist'
if (!existsSync(DIST)) { console.error('❌ 找不到 dist/，請先跑 npm run build'); process.exit(1) }

// 主 CSS 檔名帶 content hash，不能寫死
const cssFile = readdirSync(join(DIST, 'assets')).find(f => /^index-.*\.css$/.test(f))
if (!cssFile) { console.error('❌ dist/assets 裡找不到 index-*.css'); process.exit(1) }

let pass = 0
const fails = []
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

// 真實資料：NP 渠道的 wlzbhelix（型號最多的那組，12 種）
const MODELS = [
  { label: 'wlzbhelix9',  n: 4, on: 4, alert: false, rows: [['4177-WLZB-2009', '1.4.2', false], ['4177-WLZB-2011', '1.4.2', false]] },
  { label: 'wlzbhelix10', n: 4, on: 4, alert: true,  rows: [['4177-WLZB-2101', '1.4.2', false], ['4177-WLZB-2104', '1.3.9', true]] },
  { label: 'wlzbhelix11', n: 2, on: 2, alert: false, rows: [['4177-WLZB-2113', '1.4.2', false]] },
  { label: 'wlzbhelix12', n: 2, on: 2, alert: false, rows: [] },
  { label: 'wlzbhelix25', n: 5, on: 5, alert: false, rows: [] },
  { label: '',            n: 1, on: 0, alert: false, rows: [] },   // 型號未提供 + 全離線
]

// DOM 結構照 OsmPage.tsx 的 GameTypeChannelsModal
const tag = m => {
  const cls = ['osm-modeltag', m.alert ? 'osm-modeltag--alert' : '', m.on === 0 ? 'osm-modeltag--empty' : '',
    m.label ? '' : 'osm-modeltag--nolabel'].filter(Boolean).join(' ')
  const cnt = m.n + ' 台' + (m.on !== m.n ? `（線上 ${m.on}）` : '')
  return `<div class="${cls}"><span class="osm-modeltag__label">${m.label || '型號未提供'}</span>`
    + `<span class="osm-modeltag__count">${cnt}</span>`
    + `<span class="osm-modeltag__rune">&#9670;</span></div>`
}
const rows = m => m.rows.length === 0 ? '' : '<table><tbody>' + m.rows.map(([name, ver, diff]) =>
  `<tr><td class="mn">${name}</td><td style="width:96px"><span class="vt${diff ? ' d' : ''}">${ver}</span></td>`
  + `<td style="width:64px;text-align:right"><span class="bg">Online</span></td></tr>`).join('') + '</tbody></table>'

const HTML = `<!doctype html>
<html lang="zh-Hant" data-theme-mode="classic"><head><meta charset="utf-8">
<link rel="stylesheet" href="/assets/${cssFile}">
<style>
  body{margin:0;background:#0b1220;padding:18px;font-family:system-ui,"Noto Sans TC",sans-serif}
  .wrap{width:560px;background:#111c2e;border:1px solid #334155;border-radius:12px;overflow:hidden}
  .hd{padding:12px 16px;border-bottom:1px solid #24344a;font:700 14px monospace;color:#93c5fd}
  .ch{padding:10px 16px 4px} .chh{display:flex;align-items:center;gap:8px;margin-bottom:7px}
  .cb{font:700 10px system-ui;padding:2px 7px;border-radius:4px;color:#fff;background:#22c55e}
  .cm{font-size:11.5px;color:#94a3b8}
  table{width:100%;border-collapse:collapse;font-size:11.5px}
  td{padding:3.5px 0;border-bottom:1px solid #1a2537}
  .mn{font-family:monospace;color:#cbd5e1}
  .vt{font:11px monospace;padding:1px 6px;border-radius:4px;background:#1e293b;color:#94a3b8}
  .vt.d{background:#422006;color:#fbbf24}
  .bg{font:700 9.5px system-ui;padding:1.5px 5px;border-radius:4px;background:#064e3b;color:#6ee7b7}
  .mg{margin-bottom:8px} h2{color:#e2e8f0;font-size:13px;margin:0 0 8px}
</style></head><body>
<h2 id="mode-label"></h2>
<div class="wrap"><div class="hd">wlzbhelix</div><div class="ch">
<div class="chh"><span class="cb">NP</span><span class="cm">30 台 · 線上 29 · 12 種機型</span></div>
${MODELS.map(m => `<div class="mg">${tag(m)}${rows(m)}</div>`).join('')}
</div></div>
<script>
window.setMode = m => {
  document.documentElement.dataset.themeMode = m
  document.getElementById('mode-label').textContent =
    m === 'xianxia' ? '修仙版 (data-theme-mode="xianxia")' : '普通版 (data-theme-mode="classic")'
}
window.setMode('classic')
</scr` + `ipt></body></html>`

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }
const srv = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HTML)
  }
  // 其餘一律從 dist/ 取（CSS 與 /osm/*.png 都在那裡）
  const p = join(DIST, url)
  if (!existsSync(p)) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' })
  res.end(readFileSync(p))
})
await new Promise(r => srv.listen(5399, r))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 620, height: 560 }, deviceScaleFactor: 2 })
const failed = []
page.on('response', r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()) })
await page.goto('http://127.0.0.1:5399/')
await page.waitForTimeout(400)

const probe = () => page.evaluate(() => {
  const el = document.querySelector('.osm-modeltag')
  const cs = getComputedStyle(el)
  return {
    height: cs.height,
    radius: cs.borderTopLeftRadius,
    clipped: cs.clipPath !== 'none',
    borderLeftWidth: cs.borderLeftWidth,
    hasBlade: getComputedStyle(el, '::before').backgroundImage !== 'none',
    runeDisplay: getComputedStyle(document.querySelector('.osm-modeltag__rune')).display,
    hasRune: getComputedStyle(document.querySelector('.osm-modeltag__rune')).backgroundImage !== 'none',
  }
})

await page.screenshot({ path: 'modetag-classic.png', fullPage: true })
const classic = await probe()
await page.evaluate(() => window.setMode('xianxia'))
await page.waitForTimeout(300)
await page.screenshot({ path: 'modetag-xianxia.png', fullPage: true })
const xianxia = await probe()
await browser.close(); srv.close()

console.log('── 普通版：樸素但清楚的標籤 ──')
eq('沒有青玉光刃素材', classic.hasBlade, false)
eq('金符整個不顯示', classic.runeDisplay, 'none')
eq('沒有斜切角', classic.clipped, false)
eq('有圓角（跟其他標籤同一套）', classic.radius, '4px')
eq('左側色條 3px 當層級提示', classic.borderLeftWidth, '3px')

console.log('── 修仙版：術式銘牌 ──')
eq('有青玉光刃素材', xianxia.hasBlade, true)
eq('金符顯示出來且有素材', xianxia.runeDisplay === 'block' && xianxia.hasRune, true)
eq('有斜切角', xianxia.clipped, true)
eq('沒有圓角（改用斜切角）', xianxia.radius, '0px')

console.log('── 兩邊確實不同（證明上面驗得到東西）──')
eq('高度不同', classic.height !== xianxia.height, true)
eq('光刃有無不同', classic.hasBlade !== xianxia.hasBlade, true)

console.log('── 資源載入 ──')
eq('build 後沒有載入失敗的資源（素材路徑解析得到）', failed, [])

console.log('')
console.log(`${pass}/${pass + fails.length} 通過`)
console.log('截圖：modetag-classic.png / modetag-xianxia.png')
if (fails.length > 0) {
  console.log('')
  console.log('失敗：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}

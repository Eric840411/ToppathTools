/**
 * 彈窗內搜尋的四個狀態視覺驗證。
 *
 *   npx tsx scripts/ui-checks/osm-dist-search-states.ts
 *
 * ⚠️ 過濾邏輯是**直接 import 真的 searchDistribution()**，不是在這裡重寫一份——
 * 重寫一份就變成第二套實作，兩邊漂了測試還是綠的。這支只重現「渲染」那一層，
 * 用的 CSS 也是 build 出來的真檔案。
 *
 * 它要回答的問題只有一個，但是這個功能最容易出錯的地方：
 *   **「有命中但全被離線開關藏住」跟「完全沒命中」在畫面上分不分得出來？**
 * 分不出來的話，使用者會把「被藏住」讀成「沒有這台機器」（CodeX review 的重點）。
 *
 * ⚠️ 要先 npm run build（讀 dist/ 的 CSS）。
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  groupByChannelForType,
  searchDistribution,
  matchRange,
  type GtChannel,
} from '../../src/pages/osm-gametype-dist.ts'

const DIST = 'dist'
if (!existsSync(DIST)) { console.error('❌ 找不到 dist/，請先跑 npm run build'); process.exit(1) }
const cssFile = readdirSync(join(DIST, 'assets')).find(f => /^index-.*\.css$/.test(f))
if (!cssFile) { console.error('❌ dist/assets 裡找不到 index-*.css'); process.exit(1) }

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

// 真實資料形狀：dragontrio —— WF 26 台全離線、NCH 13 台全線上
const mk = (name: string, state: string, ver: string) =>
  ({ id: name, machineName: name, machineType: 'dragontrio1', version: ver, onlineState: state })
const CHANNELS: GtChannel[] = [
  { name: 'WF', machines: Array.from({ length: 26 }, (_, i) => mk('4173-DRAGONTRIO-' + (2001 + i), 'offline', '1.17.40')) },
  { name: 'NCH', machines: Array.from({ length: 13 }, (_, i) => mk('4175-DRAGONTRIO-' + (1456 + i), 'online', '1.18.10')) },
]
const groups = groupByChannelForType(CHANNELS, 'dragontrio')

const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
function hl(text: string, q: string): string {
  const r = matchRange(text, q)
  if (!r) return esc(text)
  return esc(text.slice(0, r[0])) + '<mark class="osm-dist-hit">' + esc(text.slice(r[0], r[1])) + '</mark>' + esc(text.slice(r[1]))
}

/** 重現元件的渲染（只有這一層是複製的，判斷全來自 searchDistribution）*/
function renderModal(query: string, showOffline: boolean): string {
  const f = searchDistribution(groups, query, showOffline)
  const q = query.trim().toLowerCase()
  const totalOnline = groups.reduce((s, g) => s + g.online, 0)
  const totalCount = groups.reduce((s, g) => s + g.machines.length, 0)

  const tools = `<div class="osm-dist-tools">
    <div class="osm-dist-searchwrap"><span class="osm-dist-searchico">🔍</span>
    <input class="osm-dist-search" value="${esc(query)}" placeholder="搜尋渠道／型號／機台名稱／版本">
    ${query ? '<button class="osm-dist-clear">×</button>' : ''}</div>
    <div class="osm-dist-toolrow">
      <label><input type="checkbox" ${showOffline ? 'checked' : ''}> 顯示離線機台（${totalCount - totalOnline} 台）</label>
      ${f.active ? `<span class="osm-dist-count">符合 <b>${f.matchCount}</b> / ${f.totalCount} 台${
        f.hiddenByOffline > 0 ? `，另有 <b>${f.hiddenByOffline}</b> 台離線已隱藏 <button class="osm-dist-reveal">顯示離線</button>` : ''
      }</span>` : ''}
    </div></div>`

  if (f.active && f.matchCount === 0) {
    return tools + `<div class="osm-dist-empty">沒有符合 <code>${esc(query.trim())}</code> 的渠道、型號、機台或版本
      <div class="osm-dist-empty-sub">比對這四項，不是模糊比對</div></div>`
  }

  const body = f.channels.map(({ channel: g, models, matchCount }) => `<div class="chan">
    <div class="chan-h"><span class="cb">${hl(g.name, q)}</span>
    <span class="cm">${f.active ? `<b>${matchCount}</b> / ${g.machines.length}` : `<b>${g.machines.length}</b>`} 台 · 線上 <b>${g.online}</b>${g.offline ? ` · 離線 <b>${g.offline}</b>` : ''}</span></div>
    ${models.map(mg => `<div class="mg">
      <div class="osm-modeltag"><span class="osm-modeltag__label">${hl(mg.group.label, q)}</span>
      <span class="osm-modeltag__count">${f.active ? `${mg.matched.length} / ${mg.group.machines.length}` : mg.group.machines.length} 台${
        mg.group.online !== mg.group.machines.length ? `（線上 ${mg.group.online}）` : ''}</span>
      <span class="osm-modeltag__rune">&#9670;</span></div>
      ${f.active && mg.visible.length === 0 && mg.matched.length > 0
        ? `<div class="osm-dist-hidden"><span>找到 ${mg.matched.length} 台符合搜尋的離線機台，目前被「顯示離線機台」隱藏</span><button class="osm-dist-reveal">顯示離線</button></div>`
        : ''}
      ${mg.visible.length ? `<table><tbody>${mg.visible.map(m => `<tr>
        <td class="mn">${hl(m.machineName, q)}</td>
        <td style="width:96px"><span class="vt">${hl(m.version, q)}</span></td>
        <td style="width:64px;text-align:right"><span class="bg">${m.onlineState}</span></td></tr>`).join('')}</tbody></table>` : ''}
    </div>`).join('')}</div>`).join('')
  return tools + `<div class="mbody">${body}</div>`
}

const page$ = (query: string, showOffline = false) => `<!doctype html>
<html lang="zh-Hant" data-theme-mode="classic"><head><meta charset="utf-8">
<link rel="stylesheet" href="/assets/${cssFile}">
<style>
  body{margin:0;background:#0b1220;padding:16px;font-family:system-ui,"Noto Sans TC",sans-serif}
  .wrap{width:560px;background:#111c2e;border:1px solid #334155;border-radius:12px;overflow:hidden}
  .hd{padding:12px 16px;border-bottom:1px solid #24344a;font:700 14px monospace;color:#93c5fd}
  .chan{padding:10px 16px 4px;border-top:1px solid #1c2942}
  .chan-h{display:flex;align-items:center;gap:8px;margin-bottom:7px}
  .cb{font:700 10px system-ui;padding:2px 7px;border-radius:4px;color:#fff;background:#0ea5e9}
  .cm{font-size:11.5px;color:#94a3b8} .cm b{color:#f1f5f9}
  .mbody{max-height:420px;overflow-y:auto}
  table{width:100%;border-collapse:collapse;font-size:11.5px}
  td{padding:3.5px 0;border-bottom:1px solid #1a2537}
  .mn{font-family:ui-monospace,monospace;color:#cbd5e1}
  .vt{font:11px monospace;padding:1px 6px;border-radius:4px;background:#1e293b;color:#94a3b8}
  .bg{font:700 9.5px system-ui;padding:1.5px 5px;border-radius:4px;background:#064e3b;color:#6ee7b7}
  .mg{margin-bottom:8px}
</style></head><body>
<div class="wrap"><div class="hd">dragontrio</div>${renderModal(query, showOffline)}</div>
</body></html>`

const STATES: { name: string; q: string; off?: boolean; file: string }[] = [
  { name: '沒搜尋', q: '', file: 'dist-search-1-default.png' },
  { name: '命中線上機台', q: '1460', file: 'dist-search-2-hit.png' },
  { name: '命中全在離線裡', q: '2001', file: 'dist-search-3-offline-hidden.png' },
  { name: '完全沒命中', q: 'zzzzz', file: 'dist-search-4-nohit.png' },
  { name: '按下顯示離線後', q: '2001', off: true, file: 'dist-search-5-revealed.png' },
]

let current = ''
const TYPES: Record<string, string> = { '.css': 'text/css', '.png': 'image/png', '.js': 'text/javascript' }
const srv = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(current) }
  const p = join(DIST, url)
  if (!existsSync(p)) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
  res.end(readFileSync(p))
})
await new Promise<void>(r => srv.listen(5398, () => r()))

const browser = await chromium.launch()
const pg = await browser.newPage({ viewport: { width: 620, height: 700 }, deviceScaleFactor: 2 })
const probes: Record<string, { hidden: boolean; empty: boolean; buttons: number; rows: number; hiddenColor: string; emptyColor: string }> = {}

for (const st of STATES) {
  current = page$(st.q, st.off)
  await pg.goto('http://127.0.0.1:5398/?' + encodeURIComponent(st.file))
  await pg.waitForTimeout(200)
  const box = await pg.locator('.wrap').boundingBox()
  await pg.screenshot({ path: st.file, clip: { x: box!.x - 6, y: box!.y - 6, width: box!.width + 12, height: Math.min(660, box!.height + 12) } })
  probes[st.name] = await pg.evaluate(() => {
    const h = document.querySelector('.osm-dist-hidden')
    const e = document.querySelector('.osm-dist-empty')
    return {
      hidden: !!h, empty: !!e,
      buttons: document.querySelectorAll('button.osm-dist-reveal').length,
      rows: document.querySelectorAll('tbody tr').length,
      hiddenColor: h ? getComputedStyle(h).color : '',
      emptyColor: e ? getComputedStyle(e).color : '',
    }
  })
}
await browser.close(); srv.close()

console.log('')
console.log('── 兩個關鍵狀態必須分得開 ──')
const H = probes['命中全在離線裡'], E = probes['完全沒命中']
eq('「命中全在離線」有黃字提示區塊', H.hidden, true)
eq('「命中全在離線」沒有空狀態區塊', H.empty, false)
eq('「命中全在離線」有真的按鈕（狀態列＋該組）', H.buttons >= 1, true)
eq('「完全沒命中」有空狀態區塊', E.empty, true)
eq('「完全沒命中」沒有黃字提示', E.hidden, false)
eq('「完全沒命中」沒有按鈕（沒東西可以顯示）', E.buttons, 0)
eq('兩個狀態的文字顏色不同（掃一眼就分得出）',
  H.hiddenColor !== E.emptyColor && !!H.hiddenColor && !!E.emptyColor, true)

console.log('── 其餘狀態 ──')
eq('沒搜尋時只看到線上的 13 台', probes['沒搜尋'].rows, 13)
eq('命中線上機台時只剩 1 列', probes['命中線上機台'].rows, 1)
eq('命中全在離線時一列都沒有（所以才需要上面那個提示）', H.rows, 0)
// CodeX 點名的第 4 項：按下去之後結果要「立刻正確浮出來」，而且是命中的那一台
eq('按下顯示離線後浮出 1 列', probes['按下顯示離線後'].rows, 1)
eq('按下顯示離線後不再有黃字提示', probes['按下顯示離線後'].hidden, false)

console.log('')
console.log(`${pass}/${pass + fails.length} 通過`)
console.log('截圖：' + STATES.map(s => s.file).join(' / '))
if (fails.length) {
  console.log('')
  console.log('失敗：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}

// 機台自動化測試 HTML 報告（由 machine-test-batch.mjs 的 summary.json 產生）
// 版型沿用 2026-09-24 DragonLaw 正式報告：結論 → 總表 → 待確認／未驗 → 各機台（遊戲畫面＋CCTV 截圖）→ 特殊事件 → 錯誤
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { classify, STEP_ZH, ROOT, applyGameRules } from './machine-test-batch.mjs'
import { loadIdeckCrop } from './ideck-screen-check.mjs'
import { toEn } from './machine-test-report-i18n.mjs'

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// 中英切換（1004）：L() 同時輸出兩種語言、CSS 依 <html data-lang> 只顯示一種；B() 給工具產生的中文訊息（自動翻成英文）
const L = (zh, en) => `<span data-l="zh">${zh}</span><span data-l="en">${en}</span>`
const B = t => L(esc(t), esc(toEn(t)))
const LBL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', na: L('未驗', 'N/V'), check: L('待確認', 'CHECK') }
const chip = s => `<span class="chip ${s}">${LBL[s] ?? esc(s)}</span>`
const STEPS = Object.values(STEP_ZH)
const STEP_EN = { 進入: 'Entry', 推流: 'Stream', Spin: 'Spin', 音頻: 'Audio', iDeck: 'iDeck', 觸屏: 'Touch', CCTV: 'CCTV', 退出: 'Exit' }
const SN = n => L(esc(n), esc(STEP_EN[n] ?? n))

/** 截圖縮成 JPEG data URI（原始 PNG 一台約 760KB，40 台會超過頁面上限） */
// 1004 使用者：iDeck 截圖比推流／CCTV 糊——原本 iDeck 縮到 160px、觸屏 240px，頁面再放大顯示。截圖本身才 428px 寬，一律不縮（maxw 只擋特別大的圖）
function thumb(file, maxw = 1000) {
  if (!file || !fs.existsSync(file)) return null
  const py = `import sys,io,base64\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGB')\nw=int(sys.argv[2])\nif im.width>w: im=im.resize((w,round(im.height*w/im.width)),Image.LANCZOS)\nb=io.BytesIO(); im.save(b,'JPEG',quality=78,optimize=True)\nsys.stdout.write(base64.b64encode(b.getvalue()).decode())`
  const r = spawnSync('python', ['-c', py, file, String(maxw)], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  return r.status === 0 && r.stdout ? `data:image/jpeg;base64,${r.stdout}` : null
}

// 1007 主使用者：iDeck 每顆不放整張截圖，改成「機台底部 CREDIT／WIN／BET 列放大（紅框）＋下半畫面與 iDeck 按鈕（黃框）」，
// 用來確認面額有沒有真的切到（CREDIT × 面額 ≈ 機台餘額）。裁切比例依機種放在 <MT_HOME>/knowledge/games/<機種>/automation/ideck-crop.json
// （area／bar 是對整張 page 截圖的比例座標，barScale＝紅框放大倍數；osm-qa-agent 依實拍量的）。沒有設定的機種照舊放整張。
const ideckCropCache = new Map()
export function ideckCropCfg(code) {
  const type = (String(code).split('-').find(p => /^[A-Z]+$/.test(p)) ?? '').toUpperCase()
  if (!type) return null
  if (!ideckCropCache.has(type)) {
    // 讀設定跟 batch 的 iDeck 反應判定共用一支（ideck-screen-check.mjs），不另外寫一份
    const c = loadIdeckCrop(ROOT, type)
    ideckCropCache.set(type, c && c.area && c.bar ? { area: c.area, bar: c.bar, barScale: c.barScale } : null)
  }
  return ideckCropCache.get(type)
}
/** 依比例裁切（＋放大）成 JPEG data URI；失敗回 null（呼叫端退回整張） */
function cropThumb(file, rect, scale = 1) {
  if (!file || !fs.existsSync(file)) return null
  const py = `import sys,io,base64,json
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB')
r=json.loads(sys.argv[2]);s=float(sys.argv[3])
W,H=im.size
box=(round(r['x']*W),round(r['y']*H),round((r['x']+r['w'])*W),round((r['y']+r['h'])*H))
c=im.crop(box)
if s!=1: c=c.resize((round(c.width*s),round(c.height*s)),Image.LANCZOS)
b=io.BytesIO(); c.save(b,'JPEG',quality=85,optimize=True)
sys.stdout.write(base64.b64encode(b.getvalue()).decode())`
  const r = spawnSync('python', ['-c', py, file, JSON.stringify(rect), String(scale)], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  return r.status === 0 && r.stdout ? `data:image/jpeg;base64,${r.stdout}` : null
}
/** 一顆 iDeck 按鈕的圖：有裁切設定＝紅框放大列＋黃框下半畫面；沒有或裁切失敗＝整張 */
export function ideckFigure(code, t, cfg = ideckCropCfg(code)) {
  const cap = `${t.text || t.label}${t.name ? `（${t.name}）` : ''}`
  if (cfg) {
    const bar = cropThumb(t.path, cfg.bar, cfg.barScale), area = cropThumb(t.path, cfg.area, 1)
    if (bar && area) return `<figure class="ideck-crop"><img class="crop-bar" src="${bar}" alt="${esc(code)} iDeck ${esc(cap)} CREDIT/BET" loading="lazy"><img class="crop-area" src="${area}" alt="${esc(code)} iDeck ${esc(cap)}" loading="lazy"><figcaption>${B(cap)}</figcaption></figure>`
  }
  const im = thumb(t.path)
  return `<figure>${im ? `<img src="${im}" alt="${esc(code)} iDeck ${esc(cap)}" loading="lazy">` : `<div class="noimg">${L('沒有截圖', 'No screenshot')}</div>`}<figcaption>${B(cap)}</figcaption></figure>`
}

export async function buildReport(s) {
  const ms = s.machines
  // 1007（CodeX ee40495 [P2]）：報告的統計與明細用**套用 batch 規則後**的結果（跟 judge／F 欄同一份），不然結論未過、明細還是 PASS
  const ruled = new WeakMap()
  const ruledOf = m => { if (!m.result) return null; if (!ruled.has(m)) ruled.set(m, applyGameRules(m.result)); return ruled.get(m) }
  const stepMap = m => Object.fromEntries((ruledOf(m)?.steps ?? []).filter(x => STEP_ZH[x.step]).map(x => [STEP_ZH[x.step], x]))
  const cnt = { pass: 0, warn: 0, fail: 0, na: 0, check: 0 }
  for (const m of ms) for (const x of Object.values(stepMap(m))) cnt[classify(x)]++
  const game = (s.preflight?.notes ?? []).filter(n => /^機種/.test(n)).map(n => n.split('：')[0].replace('機種 ', '')).join('、') || '—'
  const first = ms[0]?.code ?? '', last = ms.at(-1)?.code ?? ''
  const Jcount = { pass: ms.filter(m => m.J === '驗證通過').length, fail: ms.filter(m => m.J === '驗證未過').length }
  const undecided = ms.filter(m => !m.J)
  const verdict = !ms.some(m => m.result) ? L('沒有收到任何機台結果', 'No machine results received')
    : Jcount.fail ? L(`${Jcount.fail} 台驗證未過，需處理`, `${Jcount.fail} machine(s) failed verification — action needed`)
    : undecided.length ? L(`已驗項目未發現異常，${undecided.length} 台需確認或重測`, `No issues in verified items; ${undecided.length} machine(s) need confirmation or re-test`)
    : L('已驗項目未發現機台異常', 'No machine issues found in verified items')
  const ptBad = (s.preTest?.rows ?? []).filter(r => r.issues.length).length
  const verdictFull = ptBad ? `${verdict}${L(`；⚠️ 測試前準備 ${ptBad} 台與預期不符（見下方）`, `; ⚠️ pre-test check: ${ptBad} machine(s) differ from expected (see below)`)}` : verdict

  const rows = ms.map(m => {
    const sm = stepMap(m)
    const cells = STEPS.map(n => `<td>${sm[n] ? chip(classify(sm[n])) : '<span class="dash">—</span>'}</td>`).join('')
    const j = m.J ? `<span class="lark ${m.J === '驗證通過' ? 'ok' : 'bad'}">${B(m.J)}</span>` : `<span class="lark none">${L('不填', 'Blank')}</span>`
    return `<tr><th scope="row"><a href="#m${esc(m.code)}">${esc(m.code.split('-').pop())}</a></th>${cells}<td>${j}</td></tr>`
  }).join('')

  const attention = ms.filter(m => !m.J || m.J === '驗證未過').map(m => `<li><b>${esc(m.code)}</b>: ${B(m.verdict)}</li>`).join('')

  const cards = ms.map(m => {
    const sm = stepMap(m)
    const sImg = thumb(m.evidence?.stream), cImg = thumb(m.evidence?.cctv)
    const cctvId = String(sm['CCTV']?.message ?? '').match(/識別碼：([A-Z0-9?]+)/)?.[1] ?? '—'
    const spin = String(sm['Spin']?.message ?? '').match(/餘額變化 ([+-]?[\d,]+)/)?.[1] ?? '—'
    const audio = String(sm['音頻']?.message ?? '').match(/RMS [^，|｜]+/)?.[0] ?? '—'
    const touchMsg = String(sm['觸屏']?.message ?? '')
    const touch = (touchMsg.match(/API 確認 (\d+\/\d+)/)?.[1] ?? '') + (touchMsg.match(/（([^）]+)）\s*$/)?.[1] ? ` @ ${touchMsg.match(/（([^）]+)）\s*$/)[1]}` : '') || '—'
    const special = (m.result?.steps ?? []).filter(x => x.step === '特殊遊戲等待').map(x => `<li>${B(x.message)}</li>`).join('')
    const detail = Object.entries(sm).filter(([, x]) => ['fail', 'warn', 'check', 'na'].includes(classify(x)))
      .map(([n, x]) => `<li><span class="sn">${SN(n)}</span> ${chip(classify(x))} ${L(esc(String(x.message).slice(0, 180)), esc(toEn(x.message).slice(0, 220)))}</li>`).join('')
    const wb = m.writeback ? Object.entries(m.writeback).map(([k, v]) => `${k}:${v === 'ok' ? '✓' : v === 'n/a' ? '—' : '✗'}`).join(' ') : L('未回寫', 'Not written back')
    return `
<article class="machine" id="m${esc(m.code)}">
  <header><h3>${esc(m.code.split('-').slice(0, -1).join('-'))}-<b>${esc(m.code.split('-').pop())}</b></h3><span class="row">${L(`Lark 第 ${m.row} 列`, `Lark row ${m.row}`)}</span></header>
  <p class="verdict-line">${B(m.verdict ?? '')}</p>
  ${m.orientation ? `<p class="row">${L('畫面方向（影子模式，不影響判定）：', 'Screen orientation (shadow mode, does not affect verdict): ')}<b>${esc(m.orientation.status.toUpperCase())}</b> ${B(m.orientation.note)}</p>` : ''}
  ${m.result ? `<div class="shots">
    <figure>${sImg ? `<img src="${sImg}" alt="${esc(m.code)} 遊戲畫面" loading="lazy">` : `<div class="noimg">${L('沒有截圖', 'No screenshot')}</div>`}<figcaption>${L('遊戲畫面／推流', 'Game screen / stream')}</figcaption></figure>
    <figure>${cImg ? `<img src="${cImg}" alt="${esc(m.code)} CCTV" loading="lazy">` : `<div class="noimg">${L('沒有截圖', 'No screenshot')}</div>`}<figcaption>${L(`CCTV（辨識 ${esc(cctvId)}）`, `CCTV (read: ${esc(cctvId)})`)}</figcaption></figure>
  </div>
  ${(m.touchScreens ?? []).length ? `<p class="row">${L('觸屏畫面判定（開出來的是不是預期畫面：影子模式，待人工確認）', 'Touchscreen result screens (is the opened screen the expected one: shadow mode, needs manual check)')}</p><div class="shots">${m.touchScreens.map(t => { const im = thumb(t.path); const cap = { '0-base': L('點之前', 'Before tap'), '1-opened': L('點下去（應為預期畫面）', 'After tap (should be expected screen)'), '2-closed': L('再點一次（應關回來）', 'Tap again (should close)') }[t.tag] ?? esc(t.tag); return `<figure>${im ? `<img src="${im}" alt="${esc(m.code)} touchscreen ${esc(t.tag)}" loading="lazy">` : `<div class="noimg">${L('沒有截圖', 'No screenshot')}</div>`}<figcaption>${cap}</figcaption></figure>` }).join('')}</div>` : ''}
  ${(m.ideckScreens ?? []).length ? `<p class="row">${ideckCropCfg(m.code) ? L('iDeck 每顆點完的畫面：紅框＝機台底部 CREDIT／WIN／BET 列放大、黃框＝下半畫面＋iDeck 按鈕（看 CREDIT × 面額 ≈ 機台餘額，確認面額有切到）', 'After each iDeck button: red = machine CREDIT/WIN/BET bar (zoomed), yellow = lower screen + iDeck buttons (check CREDIT × denomination ≈ balance)') : L('iDeck 每顆點完的畫面（影子模式，看下螢幕 BET 值）', 'Screen after each iDeck button (shadow mode, check BET on bottom screen)')}</p><div class="shots">${m.ideckScreens.map(t => ideckFigure(m.code, t)).join('')}</div>` : ''}
  <ul class="steps">${STEPS.map(n => `<li><span class="sn">${SN(n)}</span>${sm[n] ? chip(classify(sm[n])) : '<span class="chip na">—</span>'}</li>`).join('')}</ul>
  <dl><div><dt>${L('Spin 餘額變化', 'Spin balance Δ')}</dt><dd class="num">${esc(spin)}</dd></div><div><dt>${L('Spin 錄音', 'Spin audio')}</dt><dd class="num">${esc(audio)}</dd></div><div><dt>${L('觸屏點位', 'Touch points')}</dt><dd class="num">${esc(touch)}</dd></div><div><dt>${L('Lark 回寫', 'Lark write-back')}</dt><dd class="num">${esc(wb)}</dd></div></dl>
  ${special ? `<div class="special"><b>${L('特殊遊戲（FG／JP）', 'Feature games (FG/JP)')}</b><ul>${special}</ul></div>` : ''}
  ${detail ? `<ul class="detail">${detail}</ul>` : ''}` : ''}
</article>`
  }).join('')

  const pre = s.preflight ?? {}
  return `<!doctype html><html lang="zh-Hant" data-lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(game)} 機台測試報告 Machine Test Report ${esc(s.date.slice(0, 10))}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@600;700&family=Noto+Sans+TC:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
.pretest th{white-space:nowrap}.pretest td{vertical-align:top}
html[data-lang="zh"] [data-l="en"],html[data-lang="en"] [data-l="zh"]{display:none}
.langbar{position:fixed;top:12px;right:12px;z-index:10;display:flex;border:1px solid var(--rule);background:var(--paper);border-radius:4px;overflow:hidden;font:500 13px var(--mono)}
.langbar button{all:unset;cursor:pointer;padding:6px 12px;color:var(--muted)}.langbar button[aria-pressed="true"]{background:var(--lacquer);color:var(--paper)}
.langbar button:focus-visible{outline:2px solid var(--brass);outline-offset:-2px}
:root{--ground:#f6f4f1;--paper:#fff;--ink:#1f1b1a;--muted:#6b625e;--rule:#e3ddd7;--lacquer:#8f1d1d;--brass:#a3771c;--pass:#1f7a4d;--pass-bg:#e4f3ea;--warn:#9a5b00;--warn-bg:#fcefd8;--fail:#b3261e;--fail-bg:#fbe3e1;--na:#6b625e;--na-bg:#eeeae6;--check:#1f5f99;--check-bg:#e2eef9;
--serif:"Noto Serif TC","Songti TC",serif;--sans:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--ground:#161312;--paper:#1f1b1a;--ink:#ede7e2;--muted:#a89e98;--rule:#3a3331;--lacquer:#e0706a;--brass:#d8ad55;--pass:#6fd19c;--pass-bg:#173326;--warn:#f0b35a;--warn-bg:#3a2a12;--fail:#f28b82;--fail-bg:#3b1715;--na:#a89e98;--na-bg:#2b2624;--check:#7fb6ea;--check-bg:#16283a}}
:root[data-theme="dark"]{color-scheme:dark;--ground:#161312;--paper:#1f1b1a;--ink:#ede7e2;--muted:#a89e98;--rule:#3a3331;--lacquer:#e0706a;--brass:#d8ad55;--pass:#6fd19c;--pass-bg:#173326;--warn:#f0b35a;--warn-bg:#3a2a12;--fail:#f28b82;--fail-bg:#3b1715;--na:#a89e98;--na-bg:#2b2624;--check:#7fb6ea;--check-bg:#16283a}
body{background:var(--ground);color:var(--ink);font:15px/1.7 var(--sans)}
.wrap{max-width:1080px;margin:0 auto;padding:40px 20px 64px}
h1,h2,h3{font-family:var(--serif);text-wrap:balance;line-height:1.3;margin:0}
h1{font-size:clamp(24px,4vw,34px)} h2{font-size:21px;margin-bottom:14px}
section{margin-top:40px} p{max-width:68ch;margin:0 0 10px}
.eyebrow{font:500 12px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--lacquer)}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 24px;margin-top:18px;padding:14px 0;border-block:1px solid var(--rule)}
.meta dt{font-size:12px;color:var(--muted)} .meta dd{margin:0;font-weight:500}
.verdict{margin-top:24px;background:var(--paper);border:1px solid var(--rule);border-left:4px solid var(--lacquer);padding:18px 22px}
.tally{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;font:13px var(--mono)}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.chip{display:inline-block;font:500 11.5px/1 var(--mono);padding:5px 8px;border-radius:3px;white-space:nowrap}
.chip.pass{color:var(--pass);background:var(--pass-bg)}.chip.warn{color:var(--warn);background:var(--warn-bg)}.chip.fail{color:var(--fail);background:var(--fail-bg)}.chip.na{color:var(--na);background:var(--na-bg)}.chip.check{color:var(--check);background:var(--check-bg)}
.lark{font-size:13px;font-weight:500;white-space:nowrap}.lark.ok{color:var(--pass)}.lark.bad{color:var(--fail)}.lark.none{color:var(--muted)}
.dash{color:var(--muted)}
.tablebox{overflow-x:auto;background:var(--paper);border:1px solid var(--rule)}
table{border-collapse:collapse;width:100%;min-width:760px} th,td{padding:9px 10px;text-align:center;border-bottom:1px solid var(--rule)}
thead th{font:500 12px var(--sans);color:var(--muted);background:var(--ground)} tbody th{font:500 14px var(--mono);text-align:left}
tbody th a{color:var(--ink);text-decoration:none;border-bottom:1px dotted var(--muted)} tbody tr:last-child>*{border-bottom:0}
.list{display:grid;gap:8px;padding:0;margin:0;list-style:none}.list li{background:var(--paper);border:1px solid var(--rule);padding:10px 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,480px),1fr));gap:18px}
.machine{background:var(--paper);border:1px solid var(--rule);padding:16px;display:flex;flex-direction:column;gap:10px}
.machine header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.machine h3{font:500 15px var(--mono);color:var(--muted)} .machine h3 b{color:var(--lacquer);font-size:20px}
.row{font-size:12px;color:var(--muted)} .verdict-line{font-weight:500;margin:0}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start}
figure{margin:0} figure img{display:block;width:100%;height:auto;border:1px solid var(--rule);background:#000}
figure.ideck-crop img.crop-bar{border:2px solid #d32f2f;border-radius:4px}
figure.ideck-crop img.crop-area{border:2px solid #e0b000;border-radius:4px;margin-top:6px}
.noimg{aspect-ratio:1;display:grid;place-items:center;border:1px dashed var(--rule);color:var(--muted);font-size:13px}
figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.steps li{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)} .steps .chip{text-align:center}
.machine dl{margin:0;display:grid;gap:3px;font-size:13.5px} .machine dl div{display:grid;grid-template-columns:7.5em 1fr;gap:8px} dt{color:var(--muted)} dd{margin:0}
.special{font-size:13.5px;background:var(--warn-bg);padding:8px 12px} .special ul{margin:4px 0 0;padding-left:18px}
.detail{margin:0;padding:10px 0 0;list-style:none;border-top:1px solid var(--rule);font-size:13px;display:grid;gap:6px}
.detail .sn{font-weight:500}
footer{margin-top:44px;padding-top:14px;border-top:1px solid var(--rule);font-size:13px;color:var(--muted)} a{color:var(--lacquer)}
@media (max-width:520px){.steps{grid-template-columns:repeat(2,1fr)}.machine dl div{grid-template-columns:1fr;gap:0}}
</style>
<div class="langbar" role="group" aria-label="Language"><button type="button" data-set="zh" aria-pressed="true">中</button><button type="button" data-set="en" aria-pressed="false">EN</button></div>
<div class="wrap">
  <div class="eyebrow">OSM Live Slots · ${L('機台自動化測試報告', 'Machine Automation Test Report')}</div>
  <h1>${esc(game)} ${L(`機台測試（${ms.length} 台）`, `Machine Test (${ms.length} machines)`)}</h1>
  <dl class="meta">
    <div><dt>${L('測試時間', 'Test time')}</dt><dd class="num">${esc(s.date.slice(0, 16).replace('T', ' '))} UTC</dd></div>
    <div><dt>${L('機台範圍', 'Machine range')}</dt><dd class="num">${esc(first)} ～ ${esc(last.split('-').pop())}</dd></div>
    <div><dt>${L('測試項目', 'Test items')}</dt><dd>${esc(s.steps.join(' / '))}</dd></div>
    <div><dt>Session</dt><dd class="num">${esc(s.sessionId)}</dd></div>
  </dl>
  <div class="verdict">
    <h2>${L('結論：', 'Conclusion: ')}${verdictFull}</h2>
    <p>${L(`Lark「QA確認狀態」：驗證通過 ${Jcount.pass} 台、驗證未過 ${Jcount.fail} 台、不填 ${undecided.length} 台（判定不了就不填，原因見下方）。`, `Lark "QA status": verified ${Jcount.pass}, failed ${Jcount.fail}, left blank ${undecided.length} (blank when it cannot be decided; reasons below).`)}</p>
    <div class="tally"><span class="chip pass">PASS ${cnt.pass}</span><span class="chip warn">WARN ${cnt.warn}</span><span class="chip fail">FAIL ${cnt.fail}</span><span class="chip check">${LBL.check} ${cnt.check}</span><span class="chip na">${LBL.na} ${cnt.na}</span></div>
  </div>
  <section><h2>${L('測試結果總表', 'Results overview')}</h2>
    <div class="tablebox"><table><thead><tr><th scope="col">${L('機台', 'Machine')}</th>${STEPS.map(n => `<th scope="col">${SN(n)}</th>`).join('')}<th scope="col">${L('QA確認狀態', 'QA status')}</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p style="margin-top:10px;font-size:13px;color:var(--muted)">${L('WARN＝有提示但只記錄；未驗＝本次沒驗到、不算通過；待確認＝需要人眼或現場確認。推流畫面內容、CCTV 方向工具本身不驗。', 'WARN = flagged, recorded only; N/V = not verified this run, not counted as pass; CHECK = needs human or on-site confirmation. The tool does not verify stream content or CCTV orientation.')}</p>
  </section>
  ${attention ? `<section><h2>${L('需要處理或確認', 'Needs action or confirmation')}</h2><ul class="list">${attention}</ul></section>` : ''}
  ${s.preTest?.rows?.length ? `<section><h2>${L('測試前準備：盒子／LuckyLink', 'Pre-test check: box / LuckyLink')}</h2>${Object.values(s.preTest.expect ?? {}).some(Boolean) ? `<p class="row">${B(`預期值：${Object.entries(s.preTest.expect).filter(([, v]) => v).map(([k, v]) => `${({ machineVer: '盒子版號', machineModel: 'Machine model', luckylink: '有無接 LuckyLink', llVer: 'LuckyLink 版本', llProtocol: 'LuckyLink 協議' })[k] ?? k} ${v}`).join('、')}`)}</p>` : `<p class="row">${L('沒有給預期值，只列出查到的值', 'No expected values given; showing what was found')}</p>`}<div class="tablebox"><table class=\"pretest\"><thead><tr><th>${L('機台', 'Machine')}</th><th>${L('盒子版號', 'Box version')}</th><th>Machine model</th><th>${L('盒子狀態', 'Box status')}</th><th>LuckyLink</th><th>${L('協議', 'Protocol')}</th><th>${L('LL 版本', 'LL version')}</th><th>${L('群組', 'Group')}</th><th>${L('不符', 'Mismatch')}</th></tr></thead><tbody>${s.preTest.rows.map(({ row: r, issues }) => `<tr><th scope="row">${esc(r.code.split('-').pop())}</th><td>${esc(r.boxVer ?? '—')}</td><td>${esc(r.model ?? '—')}</td><td>${esc(`${r.online ?? '—'}／${r.status ?? '—'}`)}</td><td>${r.llLinked ? L('有接', 'Connected') : r.llListed ? L('沒接', 'Not connected') : L('清單沒有', 'Not listed')}${r.llListed && !r.llLinked ? ` <span class="row">(${r.llAuthorized ? L('已授權', 'authorized') : L('未授權', 'unauthorized')})</span>` : ''}</td><td>${esc(r.llProtocol ?? '—')}</td><td>${esc(r.llVer ?? '—')}</td><td>${esc(r.llGroup ?? '—')}</td><td>${issues.length ? `⚠️ ${B(issues.join('；'))}` : '✅'}</td></tr>`).join('')}</tbody></table></div>${[...(s.preTest.batchWarn ?? []), ...(s.preTest.errs ?? [])].map(w => `<p>⚠️ ${B(w)}</p>`).join('')}</section>` : ''}
  ${/* 本機種注意事項（知識庫 ⚠️）不放進報告（使用者 1004 要求）；summary.json 仍保留 gameNotes */ ''}
  <section><h2>${L('開跑前檢查', 'Pre-run checks')}</h2><ul class="list">${[...(pre.problems ?? []).map(p => `<li>⚠️ ${B(p)}</li>`), ...(pre.notes ?? []).map(n => `<li>${B(n)}</li>`)].join('')}</ul></section>
  <section><h2>${L('各機台明細', 'Per-machine details')}</h2><div class="grid">${cards}</div></section>
  ${(s.errors ?? []).length ? `<section><h2>${L('執行過程錯誤', 'Run errors and notes')}</h2><ul class="list">${s.errors.map(e => `<li>${B(e)}</li>`).join('')}</ul></section>` : ''}
  <footer>${L('證據：Lark 測試表 F 結論／G 推流截圖／H CCTV 截圖／I 整段錄音／J QA確認狀態。', 'Evidence in the Lark sheet: F conclusion / G stream screenshot / H CCTV screenshot / I full recording / J QA status.')}<br><a href="${esc(s.sheet)}">${L('開啟 Lark 測試表', 'Open Lark test sheet')}</a></footer>
</div>
<script>
(() => {
  const root = document.documentElement
  const set = lang => {
    root.dataset.lang = lang; root.lang = lang === 'en' ? 'en' : 'zh-Hant'
    document.querySelectorAll('.langbar button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.set === lang)))
    try { localStorage.setItem('mt-report-lang', lang) } catch {}
  }
  document.querySelectorAll('.langbar button').forEach(b => b.addEventListener('click', () => set(b.dataset.set)))
  let saved = null
  try { saved = localStorage.getItem('mt-report-lang') } catch {}
  const q = new URLSearchParams(location.search).get('lang')
  set(q === 'en' || q === 'zh' ? q : saved === 'en' ? 'en' : 'zh')
})()
</script>`
}

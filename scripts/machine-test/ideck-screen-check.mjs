// iDeck「機台畫面有沒有反應」的證據（1007 主使用者抓到：server 全部回應、機台底部列完全沒變也判 PASS）
// 規則 osm-qa-agent 實測＋CodeX 定案（docs/features/04-machine-test.md「iDeck 機台反應」）：
//   - 只用在**已校準**的機種：knowledge/games/<機種>/automation/ideck-crop.json 有 credit／marker／bet 子區塊（排除 WIN 動畫）
//   - 面額鍵（DenomN）看 credit 與 marker（各算比例、取大）；注額鍵（BetN）看 bet。**兩組分開判**，一組有動不能掩蓋另一組失效
//   - 每組：第一張當基準，其餘每張跟它比，取最大值；最大值 < 門檻＝整組沒反應 → ideck no response
//     超過門檻只代表「沒觸發這道攔截」，不代表通過
//   - 原尺寸、固定公式：裁切區逐像素 |ΔR|+|ΔG|+|ΔB| > 60 的比例
//   - 一組要有 ≥ 2 張、而且預期按的每一顆都有圖、讀得到、尺寸一致；否則這組未驗（不能判沒反應、也不能當有反應）
//   - 門檻預設面額 8%、注額 5%（SUPERBURSTLINK 13 台：面額有反應 12.8～13.9%／沒反應 2.3～5.3%，注額 8.5～12.6%／0.5～2.5%），
//     可在 ideck-crop.json 用 denomThreshold／betThreshold 覆寫
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

export const DEFAULT_THRESHOLDS = { denom: 0.08, bet: 0.05 }
const okRect = r => r && ['x', 'y', 'w', 'h'].every(k => typeof r[k] === 'number' && r[k] >= 0 && r[k] <= 1) && r.w > 0 && r.h > 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001

/** 讀機種的裁切設定（root＝MT_HOME）。回 { area, bar, barScale, credit, marker, bet, thresholds } 或 null；子區塊格式壞掉的不回（不能判） */
export function loadIdeckCrop(root, type) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, 'knowledge', 'games', String(type).toUpperCase(), 'automation', 'ideck-crop.json'), 'utf8'))
    const out = {
      area: okRect(c.area) ? c.area : null,
      bar: okRect(c.bar) ? c.bar : null,
      barScale: Math.min(6, Math.max(1, Number(c.barScale) || 3)),
      credit: okRect(c.credit) ? c.credit : null,
      marker: okRect(c.marker) ? c.marker : null,
      bet: okRect(c.bet) ? c.bet : null,
      thresholds: {
        denom: Number.isFinite(c.denomThreshold) && c.denomThreshold > 0 && c.denomThreshold < 1 ? c.denomThreshold : DEFAULT_THRESHOLDS.denom,
        bet: Number.isFinite(c.betThreshold) && c.betThreshold > 0 && c.betThreshold < 1 ? c.betThreshold : DEFAULT_THRESHOLDS.bet,
      },
    }
    return out
  } catch { return null }
}

/** 兩張同尺寸圖在 rect（比例座標）裡的差異比例 0～1。尺寸不一致丟錯 */
export function regionDiff(A, B, rect) {
  if (A.width !== B.width || A.height !== B.height) throw new Error(`尺寸不一致 ${A.width}x${A.height} vs ${B.width}x${B.height}`)
  const x0 = Math.round(rect.x * A.width), y0 = Math.round(rect.y * A.height)
  const w = Math.max(1, Math.round(rect.w * A.width)), h = Math.max(1, Math.round(rect.h * A.height))
  let n = 0, tot = 0
  for (let y = y0; y < Math.min(A.height, y0 + h); y++) for (let x = x0; x < Math.min(A.width, x0 + w); x++) {
    const i = (y * A.width + x) * 4
    tot++
    if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 60) n++
  }
  if (!tot) throw new Error('裁切區是空的')
  return n / tot
}

const GROUPS = [
  { key: 'denom', label: '面額', re: /^Denom\d+$/i, rects: ['credit', 'marker'] },
  // BetMultipleN（倍數鍵）也會改 BET 值，算注額組（CodeX ee40495 [P2]）
  { key: 'bet', label: '注額', re: /^Bet(Multiple)?\d+$/i, rects: ['bet'] },
]
const pct = x => `${(x * 100).toFixed(1)}%`

/**
 * 判一台的 iDeck 畫面反應。
 * @param {{ expected: string[], shots: {name: string, path: string}[], crop: ReturnType<typeof loadIdeckCrop>, decode?: (p: string) => any }} p
 *   expected＝這次預期按的按鈕 name（runner extraData.learn.actions）；shots＝runner extraData.ideckShots
 * @returns {{ kind: 'na'|'no-response'|'unverified'|'reacted', why: string, groups: object[] }}
 */
export function evaluateIdeckScreens({ expected, shots, crop, decode = p => PNG.sync.read(fs.readFileSync(p)) }) {
  if (!crop || !crop.credit || !crop.marker || !crop.bet) return { kind: 'na', why: '機種沒有校準過的子區塊', groups: [] }
  const groups = []
  for (const g of GROUPS) {
    const want = [...new Set((expected ?? []).filter(n => g.re.test(n ?? '')))]
    if (want.length < 2) { groups.push({ key: g.key, label: g.label, kind: want.length ? 'unverified' : 'none', why: want.length ? `${g.label}鍵只有 ${want.length} 顆，沒得比` : `沒有${g.label}鍵` }); continue }
    const byName = new Map((shots ?? []).filter(s => g.re.test(s.name ?? '')).map(s => [s.name, s]))
    const missing = want.filter(n => !byName.has(n) || !byName.get(n).path || !fs.existsSync(byName.get(n).path))
    if (missing.length) { groups.push({ key: g.key, label: g.label, kind: 'unverified', why: `${g.label}鍵缺圖：${missing.join('、')}` }); continue }
    try {
      const imgs = want.map(n => decode(byName.get(n).path))
      const base = imgs[0]
      let max = 0
      for (const im of imgs.slice(1)) for (const rk of g.rects) max = Math.max(max, regionDiff(base, im, crop[rk]))
      const th = crop.thresholds[g.key]
      groups.push({ key: g.key, label: g.label, kind: max < th ? 'no-response' : 'reacted', max, threshold: th, why: `${g.label}鍵最大差異 ${pct(max)}（門檻 ${pct(th)}）` })
    } catch (e) { groups.push({ key: g.key, label: g.label, kind: 'unverified', why: `${g.label}鍵讀圖失敗：${e.message}` }) }
  }
  const real = groups.filter(g => g.kind !== 'none')
  const why = real.map(g => g.why).join('；')
  if (!real.length) return { kind: 'unverified', why: '沒有面額鍵或注額鍵可以比', groups }
  if (real.some(g => g.kind === 'no-response')) return { kind: 'no-response', why, groups }
  if (real.some(g => g.kind === 'unverified')) return { kind: 'unverified', why, groups }
  return { kind: 'reacted', why, groups }
}

// ── 依「畫面指標」判 PLAY 鍵（1007 ARUZE／Fu Lai Cai Lai，主使用者確認、CodeX 定案）────────────────
// 捲軸上方一排 4 格：WILD 盾牌或銅錢。PLAY11→0 個 WILD、33→1、55→2、66→3、88→4。
// 設定在 knowledge/games/<機種>/automation/ideck-wildrow.json：
//   gameName：只有進場讀到的遊戲名（entry extraData.gameName，正規化空白後精確比對）相符才套
//   cells／y0／y1：格子位置（page 截圖比例）；refs：全銅錢、全 WILD 的參考截圖（同一套座標裁）
//   maxDist／minMargin：拒判門檻——離最近參考太遠、或兩種參考差不多近 → 這格認不出來 → 未驗（不能硬分成 0～4）
//   expected：按鈕識別鍵（按鈕字去空白）→ 預期 WILD 數
export function loadWildRow(root, type) {
  try {
    const dir = path.join(root, 'knowledge', 'games', String(type).toUpperCase(), 'automation')
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'ideck-wildrow.json'), 'utf8'))
    if (!c.gameName || !Array.isArray(c.cells) || !c.refs?.coin || !c.refs?.wild || !c.expected) return null
    return { ...c, refPaths: { coin: path.join(dir, c.refs.coin), wild: path.join(dir, c.refs.wild) } }
  } catch { return null }
}
const normName = s => String(s ?? '').replace(/\s+/g, ' ').trim()
function cellBox(img, cfg, i) {
  const c = cfg.cells[i]
  return { x: Math.round((c.cx - c.w / 2) * img.width), y: Math.round(cfg.y0 * img.height), w: Math.round(c.w * img.width), h: Math.round((cfg.y1 - cfg.y0) * img.height) }
}
function meanAbs(A, B, box) {
  let sum = 0, n = 0
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = (y * A.width + x) * 4
    sum += (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2])) / 3
    n++
  }
  return n ? sum / n : Infinity
}
/** 一張截圖的 WILD 數；有任何一格認不出來回 { count: null, why } */
export function countWilds(img, coinRef, wildRef, cfg) {
  if (img.width !== coinRef.width || img.height !== coinRef.height || img.width !== wildRef.width || img.height !== wildRef.height) return { count: null, why: '截圖尺寸跟參考圖不同' }
  let count = 0
  const maxDist = Number(cfg.maxDist) || 40, minMargin = Number(cfg.minMargin) || 20
  for (let i = 0; i < cfg.cells.length; i++) {
    const box = cellBox(img, cfg, i)
    const dc = meanAbs(img, coinRef, box), dw = meanAbs(img, wildRef, box)
    if (Math.min(dc, dw) > maxDist || Math.abs(dc - dw) < minMargin) return { count: null, why: `第 ${i + 1} 格認不出來（離銅錢 ${dc.toFixed(0)}、離 WILD ${dw.toFixed(0)}）` }
    if (dw < dc) count++
  }
  return { count }
}
/**
 * PLAY 鍵依 WILD 數判、BET 鍵逐顆要有開局。
 * @param {{ gameName: string, buttons: {key: string, name: string, round?: boolean}[], shots: {name: string, path: string}[], cfg: any, decode?: (p: string) => any }} p
 * @returns {{ kind: 'na'|'fail'|'unverified'|'ok', why: string, detail: string[] }}
 */
export function evaluateWildRow({ gameName, buttons, shots, cfg, decode = p => PNG.sync.read(fs.readFileSync(p)) }) {
  if (!cfg) return { kind: 'na', why: '', detail: [] }
  const fails = [], unv = [], detail = []
  const plays = buttons.filter(b => Object.prototype.hasOwnProperty.call(cfg.expected, b.key))
  const roundRe = cfg.roundButtons ? new RegExp(cfg.roundButtons) : null
  const bets = roundRe ? buttons.filter(b => roundRe.test(b.key)) : []
  // CodeX 補審（P1）：沒有任何按鈕對得上規則、有不認得的按鈕、或規則列的 PLAY 鍵沒按到 → 未驗，不能回 ok
  if (!plays.length && !bets.length) unv.push('沒有任何按鈕對得上 WILD 規則（PLAY／BET 鍵都沒找到）')
  for (const b of buttons) if (!plays.includes(b) && !bets.includes(b)) unv.push(`${b.key}：不在 WILD 規則裡，不知道該怎麼判`)
  for (const k of Object.keys(cfg.expected)) if (!plays.some(b => b.key === k)) unv.push(`${k}：規則有列、這次沒按到`)
  // BET 鍵：逐顆要有開局（不能拿整段開局總數替所有 BET 背書）
  for (const b of bets) {
    if (b.round === undefined) unv.push(`${b.key}：舊版 agent 沒記每顆有沒有開局`)
    else if (!b.round) fails.push(`${b.key} 沒開局`)
  }
  // PLAY 鍵：遊戲名相符才套
  if (plays.length) {
    if (!normName(gameName)) unv.push(`PLAY 鍵：進場沒讀到遊戲名，不能套 ${cfg.gameName} 的規則`)
    else if (normName(gameName) !== normName(cfg.gameName)) unv.push(`PLAY 鍵：遊戲是「${normName(gameName)}」，不是 ${cfg.gameName}，沒有對應的判法`)
    else {
      let coinRef, wildRef
      try { coinRef = decode(cfg.refPaths.coin); wildRef = decode(cfg.refPaths.wild) } catch (e) { unv.push(`參考圖讀不到：${e.message}`) }
      if (coinRef && wildRef) for (const b of plays) {
        const shot = shots.find(s => s.name === b.name)
        if (!shot?.path || !fs.existsSync(shot.path)) { unv.push(`${b.key} 缺圖`); continue }
        let img
        try { img = decode(shot.path) } catch (e) { unv.push(`${b.key} 讀圖失敗`); continue }
        const r = countWilds(img, coinRef, wildRef, cfg)
        const want = cfg.expected[b.key]
        if (r.count === null) { unv.push(`${b.key}：${r.why}`); continue }
        detail.push(`${b.key}=${r.count}`)
        // 數不對：可能是按的時候中獎動畫還在跑（0332），第一期先算未驗，要等 runner 能「可操作後重按」才判 FAIL（CodeX）
        if (r.count !== want) unv.push(`${b.key} 的 WILD ${r.count} 個（預期 ${want}），可能按的時候動畫還在跑，要重測`)
      }
    }
  }
  const tail = detail.length ? `｜WILD：${detail.join(' ')}` : ''
  if (fails.length) return { kind: 'fail', why: fails.join('；') + (unv.length ? `；另外未驗：${unv.join('；')}` : '') + tail, detail }
  if (unv.length) return { kind: 'unverified', why: unv.join('；') + tail, detail }
  return { kind: 'ok', why: `PLAY 鍵 WILD 數都對、BET 鍵都有開局${tail}`, detail }
}

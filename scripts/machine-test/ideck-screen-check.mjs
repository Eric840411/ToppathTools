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

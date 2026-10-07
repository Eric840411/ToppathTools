// learn 自動找 iDeck 畫面指標（1007，規格 osm-qa-agent/reports/spec-mt-ideck-indicator-learn-1007.md）
// 輸入：runner 在 ideckCapture 時拍的 main 推流框 —— idle×3（不按）、每顆按鈕 pre／post1／post2。
// 輸出：反應區（比例座標）＋每顆按鈕會動到哪幾區＋每區按完的參考裁圖 → ideck-indicator.json（status: proposed，人確認後才 confirmed）
//
// 分析（每個 cell×cell 像素一格，格內平均 RGB 的平均絕對差 > th 算「這格變了」）：
//   ① 雜訊遮罩：idle 兩兩之間、每顆 post1 對 post2 會變的格子＝動畫（WIN、獎池、捲軸特效、跑馬燈）→ 排除
//   ② 每顆的反應：pre 對 post2 有變、不在雜訊遮罩裡的格子
//   ③ 反應區：所有按鈕反應格的聯集，做一次膨脹把字的筆畫連起來，再分群成矩形；太小的丟掉
//   ④ 每顆按鈕 × 每區：變動比例 ≥ minFrac 算「這顆會動這區」
// learn 作廢的情況（不能學成規格，故障機台／沒準備好的畫面學出來的東西是錯的）：
//   idle 少於 2 張、任何一顆缺圖／尺寸不一致、選單閘門沒關成功（呼叫端傳 menuOpen）、一顆都沒有反應
// ⚠️ 「按到已選中的那顆」本來就不會變（osm-qa-agent 1007）：學到「這顆不動任何區」只記成 changes:[]，驗證時不能據此判沒反應
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

const decodeFile = p => PNG.sync.read(fs.readFileSync(p))

function cellGrid(img, cell) {
  const gw = Math.floor(img.width / cell), gh = Math.floor(img.height / cell)
  const g = new Float32Array(gw * gh * 3)
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let r = 0, gg = 0, b = 0
    for (let y = gy * cell; y < (gy + 1) * cell; y++) for (let x = gx * cell; x < (gx + 1) * cell; x++) {
      const i = (y * img.width + x) * 4; r += img.data[i]; gg += img.data[i + 1]; b += img.data[i + 2]
    }
    const n = cell * cell, k = (gy * gw + gx) * 3
    g[k] = r / n; g[k + 1] = gg / n; g[k + 2] = b / n
  }
  return { gw, gh, g }
}
/** 兩張圖哪些格子變了（Set of index） */
export function changedCells(a, b, { cell = 4, th = 18 } = {}) {
  const A = cellGrid(a, cell), B = cellGrid(b, cell)
  const out = new Set()
  for (let i = 0; i < A.gw * A.gh; i++) {
    const k = i * 3
    if ((Math.abs(A.g[k] - B.g[k]) + Math.abs(A.g[k + 1] - B.g[k + 1]) + Math.abs(A.g[k + 2] - B.g[k + 2])) / 3 > th) out.add(i)
  }
  return { cells: out, gw: A.gw, gh: A.gh }
}
function dilate(set, gw, gh) {
  const out = new Set(set)
  for (const i of set) { const x = i % gw, y = Math.floor(i / gw); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) out.add(ny * gw + nx) } }
  return out
}
function components(set, gw) {
  const left = new Set(set), comps = []
  while (left.size) {
    const [s] = left; left.delete(s)
    const comp = [s], st = [s]
    while (st.length) {
      const i = st.pop(), x = i % gw, y = Math.floor(i / gw)
      for (const n of [i - 1, i + 1, i - gw, i + gw]) {
        const nx = n % gw, ny = Math.floor(n / gw)
        if (left.has(n) && Math.abs(nx - x) + Math.abs(ny - y) === 1) { left.delete(n); comp.push(n); st.push(n) }
      }
    }
    comps.push(comp)
  }
  return comps
}

/**
 * @param {{ idle: string[], buttons: {key: string, name: string|null, pre: string, post1: string, post2: string}[], menuOpen?: boolean, cell?: number, th?: number, minCells?: number, minFrac?: number, decode?: (p: string) => any }} p
 * @returns {{ ok: true, regions: {id: string, rect: {x: number, y: number, w: number, h: number}, cells: number}[], buttons: {key: string, name: string|null, changes: string[]}[], noiseFrac: number } | { ok: false, why: string }}
 */
export function learnIndicators({ idle, buttons, menuOpen = false, cell = 4, th = 18, minCells = 6, minFrac = 0.15, decode = decodeFile }) {
  if (menuOpen) return { ok: false, why: '選單閘門沒有確認選單關掉，這次 learn 作廢（會學到「全部按鈕都沒反應」）' }
  const idleImgs = (idle ?? []).filter(Boolean).map(p => { try { return decode(p) } catch { return null } }).filter(Boolean)
  if (idleImgs.length < 2) return { ok: false, why: `idle 只有 ${idleImgs.length} 張，做不出雜訊遮罩` }
  const W = idleImgs[0].width, H = idleImgs[0].height
  const btns = []
  for (const b of buttons ?? []) {
    let pre, p1, p2
    try { pre = decode(b.pre); p1 = decode(b.post1); p2 = decode(b.post2) } catch { return { ok: false, why: `${b.key} 缺 pre／post 圖` } }
    if ([pre, p1, p2].some(im => im.width !== W || im.height !== H)) return { ok: false, why: `${b.key} 的圖尺寸跟 idle 不一致` }
    btns.push({ ...b, pre, p1, p2 })
  }
  if (!btns.length) return { ok: false, why: '沒有任何按鈕的拍攝' }
  // ① 雜訊遮罩
  let gw = 0, gh = 0
  const noise = new Set()
  const addNoise = (a, b) => { const r = changedCells(a, b, { cell, th }); gw = r.gw; gh = r.gh; for (const i of r.cells) noise.add(i) }
  for (let i = 0; i < idleImgs.length; i++) for (let j = i + 1; j < idleImgs.length; j++) addNoise(idleImgs[i], idleImgs[j])
  for (const b of btns) addNoise(b.p1, b.p2)
  const noiseMask = dilate(noise, gw, gh)   // 雜訊邊緣也算雜訊，避免動畫邊框滲進反應區
  // ② 每顆的反應
  const per = btns.map(b => { const r = changedCells(b.pre, b.p2, { cell, th }); return new Set([...r.cells].filter(i => !noiseMask.has(i))) })
  const union = new Set(per.flatMap(s => [...s]))
  if (!union.size) return { ok: false, why: '扣掉動畫雜訊之後，沒有任何按鈕讓畫面有變化（機台可能沒反應，不能學成規格）' }
  // ③ 反應區
  const comps = components(dilate(union, gw, gh), gw).filter(c => c.length >= minCells)
  const regions = comps.map((c, k) => {
    const xs = c.map(i => i % gw), ys = c.map(i => Math.floor(i / gw))
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1
    const set = new Set(c)
    return { id: `r${k + 1}`, set, rect: { x: +(x0 * cell / W).toFixed(4), y: +(y0 * cell / H).toFixed(4), w: +((x1 - x0) * cell / W).toFixed(4), h: +((y1 - y0) * cell / H).toFixed(4) }, cells: c.length }
  }).sort((a, b) => b.cells - a.cells)
  regions.forEach((r, k) => { r.id = `r${k + 1}` })
  // ④ 每顆 × 每區
  const outButtons = btns.map((b, i) => ({
    key: b.key, name: b.name ?? null,
    changes: regions.filter(r => [...per[i]].filter(c => r.set.has(c)).length / r.set.size >= minFrac).map(r => r.id),
  }))
  return {
    ok: true,
    regions: regions.map(({ id, rect, cells }) => ({ id, rect, cells })),
    buttons: outButtons,
    noiseFrac: +(noiseMask.size / (gw * gh)).toFixed(3),
  }
}

/** 在圖上畫出反應區的框（給人確認用）。回傳新的 PNG buffer */
export function drawRegions(imgPath, regions, decode = decodeFile) {
  const im = decode(imgPath)
  const out = new PNG({ width: im.width, height: im.height })
  im.data.copy(out.data)
  const colors = [[255, 40, 40], [40, 220, 80], [60, 140, 255], [255, 200, 0], [220, 60, 220], [0, 220, 220]]
  regions.forEach((r, k) => {
    const c = colors[k % colors.length]
    const x0 = Math.round(r.rect.x * im.width), y0 = Math.round(r.rect.y * im.height)
    const x1 = Math.min(im.width - 1, Math.round((r.rect.x + r.rect.w) * im.width)), y1 = Math.min(im.height - 1, Math.round((r.rect.y + r.rect.h) * im.height))
    const dot = (x, y) => { const i = (y * im.width + x) * 4; out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = 255 }
    for (let t = 0; t < 2; t++) {
      for (let x = x0; x <= x1; x++) { dot(x, Math.min(im.height - 1, y0 + t)); dot(x, Math.max(0, y1 - t)) }
      for (let y = y0; y <= y1; y++) { dot(Math.min(im.width - 1, x0 + t), y); dot(Math.max(0, x1 - t), y) }
    }
  })
  return PNG.sync.write(out)
}

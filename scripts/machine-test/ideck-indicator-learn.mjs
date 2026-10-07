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
/** 每格平均 RGB 的差（Float32Array） */
export function cellDiffs(a, b, cell = 4, pixTh = 0) {
  if (pixTh > 0) {   // 每格「明顯變了的像素」佔幾成（0～100）：小字換數字是少數像素大變，光暈是多數像素小變
    const gw = Math.floor(a.width / cell), gh = Math.floor(a.height / cell), d = new Float32Array(gw * gh)
    for (let y = 0; y < gh * cell; y++) for (let x = 0; x < gw * cell; x++) {
      const i = (y * a.width + x) * 4
      if ((Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3 > pixTh) d[Math.floor(y / cell) * gw + Math.floor(x / cell)] += 100 / (cell * cell)
    }
    return { d, gw, gh }
  }
  const A = cellGrid(a, cell), B = cellGrid(b, cell), d = new Float32Array(A.gw * A.gh)
  for (let i = 0; i < d.length; i++) { const k = i * 3; d[i] = (Math.abs(A.g[k] - B.g[k]) + Math.abs(A.g[k + 1] - B.g[k + 1]) + Math.abs(A.g[k + 2] - B.g[k + 2])) / 3 }
  return { d, gw: A.gw, gh: A.gh }
}
/** 3×3 鄰格取最大（幅度版的膨脹） */
function spreadMax(a, gw, gh) {
  const o = new Float32Array(a.length)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let m = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && a[ny * gw + nx] > m) m = a[ny * gw + nx] } o[y * gw + x] = m }
  return o
}
function dilateH(set, gw) {
  const out = new Set(set)
  for (const i of set) { const x = i % gw; for (const dx of [-2, -1, 1, 2]) if (x + dx >= 0 && x + dx < gw) out.add(i + dx) }
  return out
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
export function learnIndicators({ idle, buttons, menuOpen = false, cell = 4, th = 16, minCells = 6, minFrac = 0.15, noiseK = 1.5, pixTh = 40, mergeOverlap = 0.5, mergeArea = 4, maxPerButton = 3, decode = decodeFile }) {
  if (menuOpen) return { ok: false, why: '選單閘門沒有確認選單關掉，這次 learn 作廢（會學到「全部按鈕都沒反應」）' }
  const idleImgs = (idle ?? []).filter(Boolean).map(p => { try { return decode(p) } catch { return null } }).filter(Boolean)
  if (idleImgs.length < 2) return { ok: false, why: `idle 只有 ${idleImgs.length} 張，做不出雜訊遮罩` }
  const W = idleImgs[0].width, H = idleImgs[0].height
  // 照實際按的順序（含來回按的「按回」那一下，backOf 指回第一次按的 idx）
  const seq = []
  for (const b of buttons ?? []) {
    let pre, p1, p2
    try { pre = decode(b.pre); p1 = decode(b.post1); p2 = decode(b.post2) } catch { if (b.backOf) continue; return { ok: false, why: `${b.key} 缺 pre／post 圖` } }
    if ([pre, p1, p2].some(im => im.width !== W || im.height !== H)) { if (b.backOf) continue; return { ok: false, why: `${b.key} 的圖尺寸跟 idle 不一致` } }
    seq.push({ ...b, pre, p1, p2 })
  }
  const btns = seq.filter(b => !b.backOf)
  if (!btns.length) return { ok: false, why: '沒有任何按鈕的拍攝' }
  // ① 雜訊幅度（1007 0345 真 learn 後改）：原本是「有變過的格子整格遮掉」，三個問題——
  //   所有按鈕 post1/post2 聯集 → 遮到 64%；CREDIT 底下有微弱光暈（idle 差 18～27），整格遮掉後面額鍵學不到 CREDIT；
  //   遮罩只看「有沒有變」，數字只跳尾數的區域會從遮罩邊緣漏進來。
  //   改成記每格「沒按鍵時最多會變多少」（幅度），按鍵後的變化要明顯超過它才算：
  //   全域＝idle 兩兩之間＋按鈕之間的空檔（上一顆 post2 → 下一顆 pre）；每顆自己＝post1↔post2（開局後捲軸、WIN 動畫只影響這顆）
  let gw = 0, gh = 0
  const cd = (a, b) => { const r = cellDiffs(a, b, cell, pixTh); gw = r.gw; gh = r.gh; return r.d }
  let globalAmp = null
  const bump = d => { if (!globalAmp) globalAmp = new Float32Array(d.length); for (let i = 0; i < d.length; i++) if (d[i] > globalAmp[i]) globalAmp[i] = d[i] }
  for (let i = 0; i < idleImgs.length; i++) for (let j = i + 1; j < idleImgs.length; j++) bump(cd(idleImgs[i], idleImgs[j]))
  for (let i = 0; i + 1 < seq.length; i++) bump(cd(seq[i].p2, seq[i + 1].pre))
  globalAmp = spreadMax(globalAmp, gw, gh)   // 動畫邊緣也算，避免滲進反應區
  const needOf = amp => i => Math.max(th, noiseK * amp[i])
  const gNeed = needOf(globalAmp)
  // ② 每顆的反應
  const per = btns.map(b => {
    const own = spreadMax(cd(b.p1, b.p2), gw, gh), oNeed = needOf(own)
    const d = cd(b.pre, b.p2), s = new Set()
    for (let i = 0; i < d.length; i++) if (d[i] > gNeed(i) && d[i] > oNeed(i)) s.add(i)
    return s
  })
  const noiseMask = { size: globalAmp.reduce((n, v) => n + (noiseK * v > th ? 1 : 0), 0) }
  const union = new Set(per.flatMap(s => [...s]))
  if (!union.size) return { ok: false, why: '扣掉動畫雜訊之後，沒有任何按鈕讓畫面有變化（機台可能沒反應，不能學成規格）' }
  // ③ 反應區：每顆按鈕自己的變化先各自分群，再把不同按鈕「同一塊」的群合併（重疊度 IoU ≥ mergeIou）
  //   1007 0345：原本先把所有按鈕的變化聯集再分群，開局鍵的捲軸變化一路連到底部列，把面額標記、CREDIT 吞成一整塊。
  //   只做橫向膨脹把一行字連起來，不往上下連（捲軸和底部列中間只隔一兩格）
  const bboxOf = set => { let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1; for (const i of set) { const x = i % gw, y = Math.floor(i / gw); if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y } return { x0, y0, x1: x1 + 1, y1: y1 + 1 } }
  const area = b => (b.x1 - b.x0) * (b.y1 - b.y0)
  //   用外框比，不用格子比：同一個標記「P1→P2」「P2→P5」換掉的筆畫落在不同格子，格子重疊度很低，外框卻幾乎一樣
  //   兩個外框重疊 ≥ 一半（以小的為準）、而且大小差不到 mergeArea 倍才合併——避免整片捲軸把底部列的小字吞掉
  const sameBlock = (a, b) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
    const sa = area(a), sb = area(b)
    return ix * iy >= mergeOverlap * Math.min(sa, sb) && Math.max(sa, sb) <= mergeArea * Math.min(sa, sb)
  }
  const cands = []
  per.forEach((set, bi) => { for (const c of components(dilateH(set, gw), gw)) if (c.length >= minCells) cands.push({ bi, set: new Set(c), box: bboxOf(c) }) })
  const clusters = []
  for (const c of cands) {
    const hit = clusters.find(cl => sameBlock(cl.box, c.box))
    if (hit) { for (const i of c.set) hit.set.add(i); hit.n.set(c.bi, (hit.n.get(c.bi) ?? 0) + c.set.size); hit.box = bboxOf(hit.set) } else clusters.push({ set: new Set(c.set), n: new Map([[c.bi, c.set.size]]), box: c.box })
  }
  const regions = clusters.map(cl => {
    const c = [...cl.set], xs = c.map(i => i % gw), ys = c.map(i => Math.floor(i / gw))
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1
    //   這顆在這塊的變化格數要有「變最多那顆」的 minFrac 以上才算（文字區旁邊的光暈閃一下不算動到這塊）
    const top = Math.max(...cl.n.values()), by = new Set([...cl.n].filter(([, k]) => k >= minFrac * top).map(([bi]) => bi))
    return { id: '', by, n: cl.n, set: cl.set, rect: { x: +(x0 * cell / W).toFixed(4), y: +(y0 * cell / H).toFixed(4), w: +((x1 - x0) * cell / W).toFixed(4), h: +((y1 - y0) * cell / H).toFixed(4) }, cells: c.length }
  }).sort((a, b) => b.cells - a.cells)
  regions.forEach((r, k) => { r.id = `r${k + 1}` })
  // ④ 每顆 × 每區：這顆自己的變化有分出這一塊才算
  //   同組一致性（1007 0345）：同一組（name 去掉尾數：Denom／Bet／BetMultiple）沒開局的按鈕，至少兩顆都動到的區才算這組的指標。
  //   真指標是每顆都會動（CREDIT、面額標記、BET）；只有一顆動到的通常是「按之前畫面還沒穩」——
  //   0345 的第一顆面額鍵 pre 還停在上一局的 WIN／捲軸、開局鍵後面那顆 pre 還在結算。
  //   開局的按鈕（round）不套這條，照實記（捲軸、CREDIT、獎池本來就會因為開局動）
  const groupOf = b => String(b.name ?? b.key).replace(/\d+$/, '')
  const cnt = new Map()
  btns.forEach((b, i) => { if (b.round) return; for (const r of regions) if (r.by.has(i)) { const k = `${groupOf(b)}|${regions.indexOf(r)}`; cnt.set(k, (cnt.get(k) ?? 0) + 1) } })
  // ⑤ 來回按（osm-qa-agent／主使用者 1007）：A → B → 再按回 A。這一區 A 跟 B 長得不一樣、按回 A 又變回 A 的樣子＝真指標（verified）；
  //   B 有動到、按回 A 卻沒變回去＝獎池／動畫這類自己會跑的東西 → 沒開局的按鈕都不再用這區（降級成雜訊；它不是任何按鈕的狀態）。A 跟 B 在這區本來就一樣＝比不出來，不動它
  const fracIn = (r, a, b) => { const d = cd(a, b); let k = 0; for (const i of r.set) if (d[i] > gNeed(i)) k++; return k / r.set.size }
  const roundTrip = []
  for (let k = 0; k < seq.length; k++) {
    const back = seq[k]
    if (!back.backOf) continue
    const A = btns.find(b => b.idx === back.backOf), B = seq[k - 1]
    if (!A || !B || B.backOf || A.round || B.round || back.round) { roundTrip.push({ of: A?.key ?? back.backOf, via: B?.key ?? null, skipped: '按回之前或按回那一下有開局，比不出來' }); continue }
    const rt = { of: A.key, via: B.key, verified: [], failed: [] }
    for (const r of regions) {
      const ab = fracIn(r, A.p2, B.p2)
      if (ab < 0.2) continue
      const ak = fracIn(r, A.p2, back.p2)
      if (ak <= 0.25 * ab) { r.verified = true; rt.verified.push(r) } else { r.rtFailed = true; rt.failed.push(r) }
    }
    roundTrip.push(rt)
  }
  const keepRaw = (b, i, r) => r.by.has(i) && (b.round || ((cnt.get(`${groupOf(b)}|${regions.indexOf(r)}`) ?? 0) >= 2 && !r.rtFailed))
  // ⑥ 只提少量、高把握的候選（主使用者 1007：「只抓對的，判斷太多地方會亂掉」）：每顆最多 maxPerButton 區，排序：來回按驗過的 → 同組動到它的按鈕數 → 這顆變動格數
  const grpCnt = (b, r) => cnt.get(`${groupOf(b)}|${regions.indexOf(r)}`) ?? 0
  const pick = btns.map((b, i) => regions.filter(r => keepRaw(b, i, r)).sort((x, y) => (y.verified ? 1 : 0) - (x.verified ? 1 : 0) || grpCnt(b, y) - grpCnt(b, x) || (y.n.get(i) ?? 0) - (x.n.get(i) ?? 0)).slice(0, maxPerButton))
  const used = regions.filter(r => pick.some(p => p.includes(r)))
  const renum = new Map(used.map((r, k) => [r, `r${k + 1}`]))
  const outButtons = btns.map((b, i) => ({ key: b.key, name: b.name ?? null, ...(b.round ? { round: true } : {}), changes: used.filter(r => pick[i].includes(r)).map(r => renum.get(r)) }))
  const idOf = r => renum.get(r) ?? '（沒選進候選）'
  return {
    ok: true,
    regions: used.map(r => ({ id: renum.get(r), rect: r.rect, cells: r.cells, verified: r.verified ? true : r.rtFailed ? false : null })),
    roundTrip: roundTrip.map(t => t.skipped ? t : { of: t.of, via: t.via, verified: t.verified.map(idOf), failed: t.failed.map(idOf) }),
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

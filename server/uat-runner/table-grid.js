/**
 * read_table 的表格網格（1008，claude-osm-2 回報 vipUpgradeSetting 讀錯欄）。
 *
 * 原本把所有表頭 th 攤成一排、每列 td 照順序對上去，兩種表格會錯位：
 *   - 兩層表頭：Level | Upgrade(colspan 2) | Relegation(colspan 2) ／ 第二層 Cycle | Amount | Cycle | Amount
 *     → 攤成 Level, Upgrade, Relegation, Cycle, Amount… 欄名跟資料對不上
 *   - 跨列儲存格（rowspan）：下一列少一格，後面的值全部往左移
 * 這裡依 colspan／rowspan 建網格（純函式，頁面只負責把每格的 text／colspan／rowspan 抓出來）：
 *   - 欄名＝這一欄從上到下各層表頭的字接起來（Upgrade Cycle）；只有一層表頭時跟原本一樣
 *   - 表身被 rowspan 跨到的列補上同一個值；colspan 的值放在第一欄、其餘空字串
 *   - 欄名空的用 col<序號>（跟原本一樣）、重複的加「 #2」（CodeX：#2 要避開既有同名欄位，而且套別名之後也要能唯一引用——
 *     別名規則由呼叫端傳 aliasKey，跟 block-engine 的 withAliases 同一份）
 *   - 每列都補滿到表格寬度（缺的格補空字串，不能讓後面的值左移）
 * @typedef {{ text: string, colspan?: number, rowspan?: number }} Cell
 * @param {Cell[][]} headerRows
 * @param {Cell[][]} bodyRows
 * @param {{ aliasKey?: (name: string) => string }} [opts]
 * @returns {{ columns: string[], rows: Record<string, string>[] }}
 */
export function buildTableGrid(headerRows, bodyRows, opts = {}) {
  const aliasOf = opts.aliasKey ?? (x => x)
  const span = n => Math.max(1, Math.min(1000, Number(n) || 1))
  /** 依 colspan／rowspan 攤成二維陣列；fill(cell, isOrigin) 決定被跨到的格子放什麼 */
  const layout = (rows, fill) => {
    const grid = []
    rows.forEach((cells, r) => {
      grid[r] = grid[r] ?? []
      let c = 0
      for (const cell of cells) {
        while (grid[r][c] !== undefined) c++
        const cs = span(cell.colspan), rs = span(cell.rowspan)
        for (let dr = 0; dr < rs && r + dr < rows.length; dr++) {
          grid[r + dr] = grid[r + dr] ?? []
          for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = fill(cell, dc === 0)
        }
        c += cs
      }
    })
    return grid
  }
  const head = layout(headerRows, cell => String(cell.text ?? '').trim())
  const body = layout(bodyRows, (cell, first) => (first ? String(cell.text ?? '').trim() : ''))
  const width = Math.max(0, ...head.map(r => r.length), ...body.map(r => r.length))
  const base = []
  for (let j = 0; j < width; j++) {
    const parts = []
    // 同一個 rowspan 的表頭格在每一層都會出現一次 → 只接一次
    for (const r of head) { const t = r[j]; if (t && parts[parts.length - 1] !== t) parts.push(t) }
    base.push(parts.join(' ') || `col${j}`)
  }
  // 名稱與別名都不能撞：先保留原本就唯一的名稱，再替撞名的找 #2、#3…
  const used = new Set()
  const claim = nm => { used.add(nm); used.add(aliasOf(nm)) }
  const free = nm => !used.has(nm) && !used.has(aliasOf(nm))
  const names = new Array(width)
  const firstOf = new Map()
  base.forEach((nm, j) => { if (!firstOf.has(nm)) firstOf.set(nm, j) })
  base.forEach((nm, j) => { if (firstOf.get(nm) === j && free(nm)) { names[j] = nm; claim(nm) } })
  base.forEach((nm, j) => {
    if (names[j] !== undefined) return
    let k = 2
    while (!free(`${nm} #${k}`)) k++
    names[j] = `${nm} #${k}`
    claim(names[j])
  })
  const rows = body.map(r => {
    const row = {}
    for (let j = 0; j < width; j++) row[names[j]] = r[j] ?? ''
    return row
  })
  return { columns: names, rows }
}

/**
 * 在頁面裡抓「這一張表」每格的 text／colspan／rowspan（給 page.evaluate 用）。
 * CodeX 1008：原本抓的是**整頁**的表頭／表身，同頁有多張表會混在一起——限定在選擇器找到的那張表；
 *   Element UI 把表頭、表身拆成兩個 <table>，用同一個 .el-table 容器配對（表頭用 header-wrapper 那張，固定欄的複本不算）。
 * ⚠️ 會被序列化進頁面執行：裡面不能有具名的內部函式（tsx 會包 __name，頁面裡沒有這個函式）
 * @param {{ table: Element | null, maxRows: number }} p
 */
export const TABLE_CELLS_IN_PAGE = ({ table, maxRows }) => {
  if (!table) return null
  const box = table.closest('.el-table')
  let headTrs = [], bodyTrs = []
  if (box) {
    const ht = box.querySelector('.el-table__header-wrapper table') || box.querySelector('table.el-table__header')
    const bt = box.querySelector('.el-table__body-wrapper table') || box.querySelector('table.el-table__body')
    headTrs = ht ? Array.from(ht.querySelectorAll('tr')) : []
    bodyTrs = bt ? Array.from(bt.querySelectorAll('tbody tr')) : []
  } else {
    headTrs = Array.from(table.querySelectorAll('thead tr'))
    bodyTrs = Array.from(table.querySelectorAll('tbody tr'))
  }
  const out = { headerRows: [], bodyRows: [] }
  for (const [list, tag, dest] of [[headTrs, 'th', out.headerRows], [bodyTrs.slice(0, maxRows), 'td', out.bodyRows]]) {
    for (const tr of list) {
      const row = []
      for (const c of Array.from(tr.querySelectorAll(tag))) {
        if (c.closest('tr') !== tr || c.classList.contains('gutter')) continue
        row.push({ text: (c.innerText || '').trim(), colspan: c.colSpan || 1, rowspan: c.rowSpan || 1 })
      }
      if (row.length || tag === 'td') dest.push(row)
    }
  }
  if (!out.headerRows.length && !out.bodyRows.length) return null
  return out
}

/**
 * read_table 的 keyColumn 要對哪一欄（1008，CodeX）：先比完全相同（不分大小寫，含去符號的別名），沒有才用包含比對；
 * 包含比對對到不只一欄就回 ambiguous——兩層表頭攤平後只寫「Upgrade」會同時對到 Upgrade Cycle／Upgrade Amount，不能默默取第一欄。
 * @returns {{ col: string } | { col: null, ambiguous: string[] }}
 */
export function pickKeyColumn(cols, key, aliasKey = x => x) {
  const want = String(key ?? '').trim().toLowerCase()
  const wantAlias = String(aliasKey(String(key ?? '').trim())).toLowerCase()
  const exact = cols.filter(c => c.toLowerCase() === want || String(aliasKey(c)).toLowerCase() === wantAlias)
  if (exact.length === 1) return { col: exact[0] }
  if (exact.length > 1) return { col: null, ambiguous: exact }
  const partial = cols.filter(c => c.toLowerCase().includes(want))
  if (partial.length === 1) return { col: partial[0] }
  return { col: null, ambiguous: partial }
}

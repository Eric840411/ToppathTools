/**
 * UI 解析度截圖 → 自動建一份 Lark Sheet 的**版面**（哪張圖放哪一格）。
 *
 * 版面是使用者 2026-09-24 定的：**只要 gmid 跟截圖**，其他報告內容不要。
 *
 *   | gmid          | 375x667 | 412x915 | … |
 *   | 4175-XXX-0001 | 圖      | 圖      |   |
 *
 * ⚠️ 列是「**實際拍到的機台**」（`actual_gmid`），不是任務上的 gmid。
 *    用 model 自動選機時，任務 gmid 是 `遊戲 / model`，而同一個 model 的不同尺寸
 *    可能因為被搶台而拍在**不同台**。照任務 gmid 分列的話，兩台的圖會擠在同一列，
 *    Sheet 上寫的 gmid 就對不上圖裡那台（CodeX 2026-09-24 指出）。
 *
 * ⚠️ 格子裡的字有三種，**意思不一樣，不能混用**（CodeX 2026-09-24）：
 *    - 「失敗」：有安排拍，沒拍成
 *    - 「未拍」：這台根本沒安排拍這個尺寸（通常是那個尺寸換到別台拍了）——寫成「失敗」是在說謊
 *    - 拿到機台號之前就失敗的：**不猜機台號**，列名寫原本的目標＋「（未取得機台號）」，
 *      也不能默默漏掉（看起來會像沒這個任務）
 *
 * ⚠️ 這支只算版面，不碰檔案系統也不打網路——驗證在 `scripts/ui-checks/ui-screenshot-sheet.mjs`。
 */
import { buildReportModel, type ReportTask } from './ui-screenshot-report.js'

export interface SheetTask extends ReportTask {
  id: string
}

export type SheetCell =
  | { kind: 'image'; taskId: string }
  | { kind: 'text'; text: string; taskId: string | null }

export interface SheetRow {
  label: string
  /** 跟 `resolutions` 一一對應 */
  cells: SheetCell[]
}

export interface SheetLayout {
  header: string[]
  rows: SheetRow[]
  /** 沒拿到機台號的任務數（畫面上要講出來） */
  noMachine: number
}

export const SHEET_FAIL_TEXT = '失敗'
export const SHEET_NOT_SHOT_TEXT = '未拍'
export const NO_MACHINE_SUFFIX = '（未取得機台號）'

/** 有圖＝ok／popup。popup 是「拍到了但有東西蓋住」，圖照放（使用者要看的就是圖） */
function hasImage(status: string): boolean {
  return status === 'ok' || status === 'popup'
}

export function buildSheetLayout(tasks: SheetTask[], resolutions: string[]): SheetLayout {
  // 分段與排序沿用驗收報告（大廳 → 功能頁 → model，有問題的排前面），兩邊看起來才一致
  const model = buildReportModel({ id: '' }, tasks, resolutions)
  const byKey = new Map<string, SheetTask[]>()
  for (const t of tasks) {
    const list = byKey.get(t.gmid) ?? []
    list.push(t)
    byKey.set(t.gmid, list)
  }

  const rows: SheetRow[] = []
  const rowByLabel = new Map<string, Array<SheetCell | null>>()
  const rowFor = (label: string) => {
    let cells = rowByLabel.get(label)
    if (!cells) {
      cells = resolutions.map(() => null)
      rowByLabel.set(label, cells)
      rows.push({ label, cells: cells as SheetCell[] })
    }
    return cells
  }
  let noMachine = 0

  for (const g of model.groups) {
    const groupTasks = byKey.get(g.key) ?? []
    const noMachineLabel = `${g.key}${NO_MACHINE_SUFFIX}`
    for (const [ri, res] of resolutions.entries()) {
      for (const t of groupTasks.filter(x => x.resolution === res)) {
        let label: string
        if (g.kind !== 'model') label = g.name
        else {
          const actual = (t.actual_gmid ?? '').trim()
          if (actual && actual !== '__LOBBY__') label = actual
          // 直接指定機台號的任務，gmid 本身就是機台號，失敗了也知道是哪台
          else if (!g.key.includes('/')) label = g.key
          else { label = noMachineLabel; noMachine++ }
        }
        const cells = rowFor(label)
        const cell: SheetCell = hasImage(t.status)
          ? { kind: 'image', taskId: t.id }
          : { kind: 'text', text: SHEET_FAIL_TEXT, taskId: t.id }
        const prev = cells[ri]
        // 同一台同一尺寸有兩筆（重拍過）：有圖的優先，不能讓失敗那筆蓋掉成功的
        if (!prev || (prev.kind === 'text' && cell.kind === 'image')) cells[ri] = cell
      }
    }
  }

  // 沒有安排拍的組合一律標「未拍」，不留空白（空白看起來像漏傳）
  for (const r of rows) {
    r.cells = r.cells.map(c => c ?? { kind: 'text', text: SHEET_NOT_SHOT_TEXT, taskId: null })
  }
  return { header: ['gmid', ...resolutions], rows, noMachine }
}

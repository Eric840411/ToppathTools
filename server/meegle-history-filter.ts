/**
 * 操作歷史：非管理員看不到測試空間的 Meegle 紀錄（v5.12.6→5.12.7，CodeX review 1288024 [P1]）。
 *
 * ⚠️ 不能只看 detail 裡有沒有寫 `"space":"test"`：舊批次的歷史、補回填與移出清單的歷史都**沒有寫 space**，
 *    只靠字串比對會全部放行。改成**用 detail 裡的 batchId 回 DB 查那一批的 space**：
 *    - 一般批次（開單／評論／狀態／修改）：detail.batchId → 對應工具的表
 *    - 補回填（寫回結果 results、移出 rows）：逐列 { tool, batchId } 查；混合的紀錄**逐列過濾**，一列都不剩才整筆拿掉
 *    - 查不到（批次被刪、舊資料）→ 當成測試（舊資料一律是測試空間開的，rowSpace 同一個原則）
 * meegle-account（綁定、身分對照）跟空間無關，照常顯示。純函式（傳入 db），測試：npx tsx server/meegle-history-filter.test.ts
 */
import type Database from 'better-sqlite3'
import { rowSpace } from './meegle-space.js'

type DB = Database.Database
type HistoryRecord = { feature: string; detail: string | null }

const TABLE_BY_FEATURE: Record<string, string> = {
  'meegle-batch-create': 'meegle_batch_rows',
  'meegle-batch-comment': 'meegle_comment_rows',
  'meegle-batch-status': 'meegle_status_rows',
  'meegle-batch-edit': 'meegle_edit_rows',
}
const TABLE_BY_TOOL: Record<string, string> = {
  create: 'meegle_batch_rows', comment: 'meegle_comment_rows', status: 'meegle_status_rows', edit: 'meegle_edit_rows',
}

function batchIsProd(db: DB, table: string | undefined, batchId: unknown): boolean {
  if (!table || typeof batchId !== 'string' || !batchId) return false
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false
  const r = db.prepare(`SELECT space FROM ${table} WHERE batch_id = ? LIMIT 1`).get(batchId) as { space?: unknown } | undefined
  return !!r && rowSpace(r.space) === 'prod'
}

/** 非管理員看得到的歷史。回傳新的陣列；補回填的紀錄可能被改寫成只剩正式空間的列 */
export function filterMeegleHistoryForNonAdmin<T extends HistoryRecord>(db: DB, records: T[]): T[] {
  const out: T[] = []
  for (const r of records) {
    if (!r.feature.startsWith('meegle-') || r.feature === 'meegle-account') { out.push(r); continue }
    let detail: Record<string, unknown>
    try { detail = JSON.parse(r.detail ?? '{}') as Record<string, unknown> } catch { continue }   // 看不懂就不給看
    if (r.feature === 'meegle-backfill') {
      const key = Array.isArray(detail.results) ? 'results' : Array.isArray(detail.rows) ? 'rows' : null
      if (!key) continue
      const kept = (detail[key] as Array<{ tool?: string; batchId?: string }>).filter(it => batchIsProd(db, TABLE_BY_TOOL[it.tool ?? ''], it.batchId))
      if (!kept.length) continue
      out.push({ ...r, detail: JSON.stringify({ ...detail, [key]: kept }) })
      continue
    }
    if (batchIsProd(db, TABLE_BY_FEATURE[r.feature], detail.batchId)) out.push(r)
  }
  return out
}

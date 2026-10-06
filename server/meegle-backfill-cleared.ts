/**
 * Meegle 補回填：**Sheet 上被清掉的回填**（v5.26.0，使用者 2026-10-06：已回填的單號／處理階段被手動刪掉，要能補回來）。
 *
 * 待補清單（meegle-backfill.ts）只看 DB——回填成功（done）的列，Sheet 被清掉它不會知道。
 * 這裡反過來：使用者貼一份 Sheet，拿 DB 裡「回填成功」的紀錄去比 Sheet 現在的樣子。
 *
 * - 同一份 Sheet 同一列只看**最近一次**回填成功的那張單（列被重用過的話，舊單不算）
 * - 判定（classifyCleared）：
 *   - 單號格＝這張單、處理階段有字 → 沒被清，不列
 *   - 單號格＝這張單、處理階段空白 → `stage`：補處理階段
 *   - 單號格空白、這張單是開單工具開的 → `all`：用開單的回填重寫（單號、處理階段、處理時間、單子標題）
 *   - 單號格空白、不是開單工具開的 → `no-create`：沒有紀錄能寫回單號，只標出來
 *   - 單號格是別張單（或認不出來的內容）→ `conflict`：只標出來，**不覆蓋**
 * - 補寫（restoreCleared）：
 *   1. 要補單號（all），或最近一次就是開單 → 開單原本的 `writebackRow(force)`：它用**摘要／標題**核對列（單號已經被刪，不能拿單號比）
 *   2. 最近一次是評論／狀態／修改 → 讀單號格確認是這張單，再寫那個工具的處理階段字＋處理時間
 *      （字用各工具共用的常數，不另抄；各工具的 writeback 函式只處理「還沒 done」的步驟，不能拿來重寫）
 *   兩步都在動手前重讀 Sheet，核對不過就不寫。
 *
 * ⚠️ 2026-10-06 CodeX 用量到上限（18:19 才恢復），使用者決定先照提案做、事後請 CodeX 補看。
 */
import type Database from 'better-sqlite3'
import { COMMENT_STAGE_DONE, MEEGLE_ID_COLUMN, parseMeegleIdCell } from '../shared/meegle-comment-rules.js'
import { STATUS_STAGE_DONE } from '../shared/meegle-status-rules.js'
import { EDIT_STAGE_DONE } from '../shared/meegle-edit-rules.js'
import { WB_COLUMNS, withSheetLock, writebackRow, type WritebackDeps } from './meegle-sheet-writeback.js'
import type { BackfillTool } from './meegle-backfill.js'

type DB = Database.Database

/** 評論／狀態／修改回填時寫的處理階段字（各工具共用的常數） */
export const STEP_TOOL_STAGE: Record<Exclude<BackfillTool, 'create'>, string> = { comment: COMMENT_STAGE_DONE, status: STATUS_STAGE_DONE, edit: EDIT_STAGE_DONE }

export type DoneRef = { tool: BackfillTool; batchId: string; rowKey: string; at: number }

/** 某份 Sheet 某一列，最近一次回填成功的那張單 */
export type DoneRecord = {
  sourceKey: string; sheetRow: number; workItemId: string; summary: string; owner: string; space: 'test' | 'prod'
  /** 開單工具開這張單的那筆（沒有＝單號不是開單工具寫的） */
  create: DoneRef | null
  /** 這張單在這一列最近一次回填成功的是哪個工具 */
  latest: DoneRef
}

export type ClearedKind = 'all' | 'stage' | 'no-create' | 'conflict'
export const CLEARED_RESTORABLE: Record<ClearedKind, boolean> = { all: true, stage: true, 'no-create': false, conflict: false }

/**
 * 列出 Sheet（sourceKey 符合 match）裡回填成功過的列。owner＝null 代表全部人（只給 admin）。
 * 同一列（sourceKey＋列號）只留最近一次回填成功的那張單。
 */
export function listDoneRecords(db: DB, opts: { match: (sourceKey: string) => boolean; owner: string | null; excludeTest?: boolean }): DoneRecord[] {
  type Hit = { tool: BackfillTool; batchId: string; rowKey: string; sourceKey: string; sheetRow: number; workItemId: string; summary: string; owner: string; space: string; at: number }
  const hits: Hit[] = []
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
  const ownerSql = opts.owner ? 'AND owner_email = ?' : ''
  const ownerArgs = opts.owner ? [opts.owner] : []

  // ⚠️ 「最近一次」比的是**操作完成時間**，不是回填時間（CodeX 60c61d3 [P2]）：補回時重跑開單回填會刷新 writeback_at，
  //    用它排序的話，下一次補寫「最近一次」就變成開單，處理階段從「已修改欄位」倒退成「已開單」。
  //    開單用 updated_at（開單／推狀態才會動，回填不動）；評論／狀態／修改用回填以外步驟的最後更新時間
  if (has('meegle_batch_rows')) {
    const rows = db.prepare(`SELECT batch_id, row_key, sheet_url, work_item_id, name, owner_email, space, writeback_at, updated_at FROM meegle_batch_rows
      WHERE create_phase = 'created' AND writeback_phase = 'done' AND work_item_id IS NOT NULL AND sheet_url LIKE 'lark:%' ${ownerSql}`).all(...ownerArgs) as Array<{ batch_id: string; row_key: string; sheet_url: string; work_item_id: string; name: string; owner_email: string; space: string; writeback_at: number | null; updated_at: number }>
    for (const r of rows) {
      if (!opts.match(r.sheet_url)) continue
      hits.push({ tool: 'create', batchId: r.batch_id, rowKey: r.row_key, sourceKey: r.sheet_url, sheetRow: Number(r.row_key), workItemId: String(r.work_item_id), summary: r.name, owner: r.owner_email, space: r.space, at: r.updated_at })
    }
  }
  for (const tool of ['comment', 'status', 'edit'] as const) {
    const rowsTable = `meegle_${tool}_rows`, stepsTable = `meegle_${tool}_steps`
    if (!has(rowsTable)) continue
    const rows = db.prepare(`SELECT r.batch_id, r.row_key, r.source_key, r.sheet_row, r.work_item_id, r.summary, r.owner_email, r.space,
        (SELECT MAX(o.updated_at) FROM ${stepsTable} o WHERE o.batch_id = r.batch_id AND o.row_key = r.row_key AND o.step != 'writeback') AS updated_at
      FROM ${rowsTable} r JOIN ${stepsTable} s ON s.batch_id = r.batch_id AND s.row_key = r.row_key AND s.step = 'writeback'
      WHERE s.phase = 'done' AND r.source_key LIKE 'lark:%' ${opts.owner ? 'AND r.owner_email = ?' : ''}`).all(...ownerArgs) as Array<{ batch_id: string; row_key: string; source_key: string; sheet_row: number; work_item_id: string; summary: string | null; owner_email: string; space: string; updated_at: number }>
    for (const r of rows) {
      if (!opts.match(r.source_key)) continue
      hits.push({ tool, batchId: r.batch_id, rowKey: r.row_key, sourceKey: r.source_key, sheetRow: Number(r.sheet_row), workItemId: String(r.work_item_id), summary: r.summary ?? '', owner: r.owner_email, space: r.space, at: r.updated_at })
    }
  }

  // 每一列只留最近一次回填成功的那張單；那張單的開單紀錄另外找（同列、同單）
  const byRow = new Map<string, Hit[]>()
  for (const h of hits) {
    if (!Number.isInteger(h.sheetRow) || h.sheetRow < 2) continue
    const k = `${h.sourceKey}\u0000${h.sheetRow}`
    byRow.set(k, [...(byRow.get(k) ?? []), h])
  }
  const out: DoneRecord[] = []
  for (const list of byRow.values()) {
    const latest = list.reduce((a, b) => (b.at > a.at ? b : a))
    const sameItem = list.filter(h => h.workItemId === latest.workItemId)
    const created = sameItem.filter(h => h.tool === 'create').sort((a, b) => b.at - a.at)[0]
    const space = latest.space === 'prod' ? 'prod' : 'test'
    if (opts.excludeTest && space === 'test') continue
    const ref = (h: Hit): DoneRef => ({ tool: h.tool, batchId: h.batchId, rowKey: h.rowKey, at: h.at })
    out.push({
      sourceKey: latest.sourceKey, sheetRow: latest.sheetRow, workItemId: latest.workItemId,
      summary: created?.summary || sameItem.find(h => h.summary)?.summary || '', owner: latest.owner, space,
      create: created ? ref(created) : null, latest: ref(latest),
    })
  }
  return out.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.sheetRow - b.sheetRow)
}

/** Sheet 現在的樣子 → 這一列算不算被清掉、能不能補。null＝沒被清 */
export function classifyCleared(rec: Pick<DoneRecord, 'workItemId' | 'create'>, cells: { id: string; stage: string }): ClearedKind | null {
  const idText = cells.id.trim()
  if (!idText) return rec.create ? 'all' : 'no-create'
  if (parseMeegleIdCell(idText) !== rec.workItemId) return 'conflict'
  return cells.stage.trim() ? null : 'stage'
}

export type RestoreDeps = {
  db: DB
  /** 開單回填用的讀寫（readRowNames 核對摘要／標題） */
  writeback: WritebackDeps
  /** 讀一列的幾個欄位（依欄名） */
  readRowCells: (sheetKey: string, rowIndex: number, names: string[]) => Promise<Record<string, string> | null>
  fmtTime: (ms: number) => string
  now?: () => number
}

/**
 * 補回一列。**讀單號、判定、寫入都在同一把 Sheet 鎖裡**（CodeX 60c61d3 [P1]）：原本先在鎖外讀單號、
 * 再交給開單回填自己排鎖——排隊期間別的回填把那一列換成別張單，force 只核對名稱，會蓋過去。
 * 開單回填用 lockHeld 在這把鎖裡跑，不另外排隊（同一條佇列再排一次會等自己而卡死）。
 * 不能補的（no-create／conflict／已經沒被清）回 ok:false 與原因，不寫。
 */
export async function restoreCleared(deps: RestoreDeps, rec: DoneRecord): Promise<{ ok: boolean; message: string }> {
  const now = () => deps.now?.() ?? Date.now()
  const read = async () => {
    const c = await deps.readRowCells(rec.sourceKey, rec.sheetRow, [MEEGLE_ID_COLUMN, WB_COLUMNS.stage])
    return c ? { id: c[MEEGLE_ID_COLUMN] ?? '', stage: c[WB_COLUMNS.stage] ?? '' } : null
  }
  return withSheetLock(rec.sourceKey, async () => {
    let cells: { id: string; stage: string } | null
    try { cells = await read() } catch (e) { return { ok: false, message: `讀不到 Sheet 第 ${rec.sheetRow} 列：${(e as Error).message}` } }
    if (!cells) return { ok: false, message: `Sheet 找不到「${MEEGLE_ID_COLUMN}」欄` }
    const kind = classifyCleared(rec, cells)
    if (kind === null) return { ok: false, message: '這一列現在沒有被清掉，不用補' }
    if (kind === 'conflict') return { ok: false, message: `第 ${rec.sheetRow} 列的 Meegle 單號現在是「${cells.id}」，不是 #${rec.workItemId}，沒有覆蓋` }
    if (kind === 'no-create') return { ok: false, message: '這張單不是開單工具開的，沒有紀錄能寫回單號，請手動填' }

    // 1. 要補單號、或最近一次就是開單 → 開單的回填重寫（它核對摘要／標題）
    if (kind === 'all' || rec.latest.tool === 'create') {
      if (!rec.create) return { ok: false, message: '找不到開單紀錄' }
      const r = await writebackRow(deps.db, rec.create.batchId, rec.create.rowKey, deps.writeback, { force: true, lockHeld: true })
      if (r.phase !== 'done') return { ok: false, message: r.message ?? '開單回填沒有寫成' }
      if (rec.latest.tool === 'create') return { ok: true, message: r.message ? `已補回單號與處理階段（${r.message}）` : '已補回單號與處理階段' }
    }

    // 2. 最近一次是評論／狀態／修改 → 處理階段寫那個工具的字。還在同一把鎖裡，再確認一次單號是這張單（第 1 步剛寫的）
    const tool = rec.latest.tool as Exclude<BackfillTool, 'create'>
    const stage = STEP_TOOL_STAGE[tool]
    let c: { id: string; stage: string } | null
    try { c = await read() } catch (e) { return { ok: false, message: `讀不到 Sheet 第 ${rec.sheetRow} 列：${(e as Error).message}` } }
    if (!c || parseMeegleIdCell(c.id) !== rec.workItemId) return { ok: false, message: `第 ${rec.sheetRow} 列的 Meegle 單號現在是「${c?.id || '（空白）'}」，不是 #${rec.workItemId}，沒有寫處理階段` }
    let w: { ok: boolean; error?: string }
    try { w = await deps.writeback.writeRow(rec.sourceKey, rec.sheetRow, { [WB_COLUMNS.stage]: stage, [WB_COLUMNS.time]: deps.fmtTime(now()) }) } catch (e) { w = { ok: false, error: (e as Error).message } }
    if (!w.ok) return { ok: false, message: `寫入 Sheet 失敗：${w.error ?? '未知錯誤'}` }
    return { ok: true, message: kind === 'all' ? `已補回單號，處理階段「${stage}」` : `已補回處理階段「${stage}」` }
  })
}

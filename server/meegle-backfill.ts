/**
 * Meegle 補回填（只做「待補記錄」——使用者 2026-10-02 選 B，不做標題對帳）。
 *
 * 範圍：開單／評論／狀態／修改 四張表裡，**Meegle 那邊已完成、只剩 Sheet 回填沒寫成**的列。
 * 補寫回一律呼叫**各工具原本的 writeback 函式**（同樣的處理階段字、同樣先核對那一列、同一份 Sheet 排同一把鎖），
 * 這裡不另寫一份回填規則——寫兩份一定會漂移（CLAUDE.md 跨功能踩坑 #3）。
 *
 * 「pending／none 但其實正在寫」的列不能列出來讓人重按：只列 failed，以及超過 IDLE_MS 沒動靜的 pending／none。
 */
import type Database from 'better-sqlite3'
import { readyForWriteback } from './meegle-comment-store.js'

type DB = Database.Database

export type BackfillTool = 'create' | 'comment' | 'status' | 'edit'
export const BACKFILL_TOOLS: Array<{ key: BackfillTool; label: string; stage: string }> = [
  { key: 'create', label: '開單', stage: '已開單（Meegle）' },
  { key: 'comment', label: '評論', stage: '添加評論' },
  { key: 'status', label: '狀態', stage: '已切換狀態' },
  { key: 'edit', label: '修改', stage: '已修改欄位' },
]
/** pending／none 超過這麼久沒動靜才算「卡住、要補」；更新的可能還在寫 */
export const IDLE_MS = 2 * 60_000

export type PendingItem = {
  tool: BackfillTool; batchId: string; rowKey: string; workItemId: string
  sourceKey: string; sheetUrl: string; sheetRow: number; summary: string; owner: string
  phase: 'failed' | 'stuck'; message: string | null; lastAt: number
  /** 哪個 Meegle 空間開的（v5.10.0；畫面標示用，補寫回只寫 Sheet、不碰 Meegle） */
  space: 'test' | 'prod'
}

type StepLike = { step: string; phase: string; message: string | null; attempt_at: number | null; updated_at: number }

/** 評論／狀態／修改：步驟表結構一樣，用同一個判斷——其他步驟都 done／skipped、回填 failed 或卡住 */
function fromStepTables(db: DB, tool: Exclude<BackfillTool, 'create'>, owner: string | null, now: number): PendingItem[] {
  const rowsTable = { comment: 'meegle_comment_rows', status: 'meegle_status_rows', edit: 'meegle_edit_rows' }[tool]
  const stepsTable = { comment: 'meegle_comment_steps', status: 'meegle_status_steps', edit: 'meegle_edit_steps' }[tool]
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(rowsTable)
  if (!exists) return []
  const rows = db.prepare(`SELECT r.batch_id, r.row_key, r.work_item_id, r.source_key, r.sheet_url, r.sheet_row, r.summary, r.owner_email, r.space
    FROM ${rowsTable} r JOIN ${stepsTable} s ON s.batch_id = r.batch_id AND s.row_key = r.row_key AND s.step = 'writeback'
    WHERE s.phase IN ('failed', 'none', 'pending') AND r.source_key LIKE 'lark:%' ${owner ? 'AND r.owner_email = ?' : ''}`)
    .all(...(owner ? [owner] : [])) as Array<{ batch_id: string; row_key: string; work_item_id: string; source_key: string; sheet_url: string; sheet_row: number; summary: string; owner_email: string; space: string }>
  const out: PendingItem[] = []
  for (const r of rows) {
    const steps = db.prepare(`SELECT step, phase, message, attempt_at, updated_at FROM ${stepsTable} WHERE batch_id = ? AND row_key = ?`).all(r.batch_id, r.row_key) as StepLike[]
    if (!readyForWriteback(steps as Parameters<typeof readyForWriteback>[0])) continue
    // 同一張單在更新的批次已經回填成功 → 這筆舊的不用補
    const wb = steps.find(s => s.step === 'writeback')!
    const lastAt = Math.max(...steps.map(s => s.updated_at))
    if (wb.phase !== 'failed' && now - lastAt < IDLE_MS) continue
    out.push({ tool, batchId: r.batch_id, rowKey: r.row_key, workItemId: r.work_item_id, sourceKey: r.source_key, sheetUrl: r.sheet_url, sheetRow: r.sheet_row, summary: r.summary, owner: r.owner_email, phase: wb.phase === 'failed' ? 'failed' : 'stuck', message: wb.message, lastAt, space: r.space === 'prod' ? 'prod' : 'test' })
  }
  return out
}

function fromCreate(db: DB, owner: string | null, now: number): PendingItem[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meegle_batch_rows'").get()
  if (!exists) return []
  const rows = db.prepare(`SELECT batch_id, row_key, work_item_id, sheet_url, name, owner_email, writeback_phase, writeback_msg, writeback_at, updated_at, space
    FROM meegle_batch_rows WHERE create_phase = 'created' AND writeback_phase IN ('pending', 'failed') AND sheet_url LIKE 'lark:%' ${owner ? 'AND owner_email = ?' : ''}`)
    .all(...(owner ? [owner] : [])) as Array<{ batch_id: string; row_key: string; work_item_id: string; sheet_url: string; name: string; owner_email: string; writeback_phase: string; writeback_msg: string | null; writeback_at: number | null; updated_at: number; space: string }>
  return rows
    .filter(r => r.writeback_phase === 'failed' || now - Math.max(r.updated_at, r.writeback_at ?? 0) >= IDLE_MS)
    .map(r => ({ tool: 'create' as const, batchId: r.batch_id, rowKey: r.row_key, workItemId: r.work_item_id, sourceKey: r.sheet_url, sheetUrl: '', sheetRow: Number(r.row_key), summary: r.name, owner: r.owner_email, phase: r.writeback_phase === 'failed' ? 'failed' as const : 'stuck' as const, message: r.writeback_msg, lastAt: Math.max(r.updated_at, r.writeback_at ?? 0), space: r.space === 'prod' ? 'prod' as const : 'test' as const }))
}

/**
 * 待補清單。owner＝null 代表全部人（只給 admin）。
 * 同一張單、同一個工具，只留最新一批的那筆（舊批次失敗、新批次已成功的不列）。
 */
export function listPendingBackfill(db: DB, opts: { owner: string | null; now?: number }): PendingItem[] {
  const now = opts.now ?? Date.now()
  const all = [
    ...fromCreate(db, opts.owner, now),
    ...fromStepTables(db, 'comment', opts.owner, now),
    ...fromStepTables(db, 'status', opts.owner, now),
    ...fromStepTables(db, 'edit', opts.owner, now),
  ]
  const newerDone = (it: PendingItem): boolean => {
    if (it.tool === 'create') return false   // 開單一列一張單，沒有「同單別批次」
    const rowsTable = { comment: 'meegle_comment_rows', status: 'meegle_status_rows', edit: 'meegle_edit_rows' }[it.tool]
    const stepsTable = { comment: 'meegle_comment_steps', status: 'meegle_status_steps', edit: 'meegle_edit_steps' }[it.tool]
    return !!db.prepare(`SELECT 1 FROM ${rowsTable} r JOIN ${stepsTable} s ON s.batch_id = r.batch_id AND s.row_key = r.row_key AND s.step = 'writeback'
      WHERE r.work_item_id = ? AND r.source_key = ? AND s.phase = 'done' AND r.created_at > (SELECT created_at FROM ${rowsTable} WHERE batch_id = ? AND row_key = ?) LIMIT 1`)
      .get(it.workItemId, it.sourceKey, it.batchId, it.rowKey)
  }
  return all.filter(it => !newerDone(it)).sort((a, b) => b.lastAt - a.lastAt)
}

export type BackfillRunners = Record<BackfillTool, (batchId: string, rowKey: string) => Promise<{ ok: boolean; message: string | null }>>

/** 補寫回一列：交給那個工具自己的 writeback（結果也由它寫回自己的表） */
export async function retryBackfill(runners: BackfillRunners, it: Pick<PendingItem, 'tool' | 'batchId' | 'rowKey'>): Promise<{ ok: boolean; message: string | null }> {
  try { return await runners[it.tool](it.batchId, it.rowKey) } catch (e) { return { ok: false, message: (e as Error).message } }
}

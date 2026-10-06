/**
 * Meegle 批量更新狀態的送出紀錄。一列＝一張單（row_key＝單號），拆三步各自記：
 *   state（轉狀態）→ date（日期保留／指定）→ writeback（Sheet 回填）
 * 狀態成功、日期失敗**分開記**；重試只補日期，而且沿用第一次讀到的原值（CodeX 2026-10-02）。
 *
 * 跟評論不一樣的地方：轉狀態是冪等的（目標＝目前狀態就不轉），結果不明時重讀狀態就知道成功沒，
 * 所以沒有 unknown——失敗都可以重試。唯一要擋的是「同一張單同時有兩個請求在轉」。
 */
import type Database from 'better-sqlite3'
import type { DateMode } from '../shared/meegle-status-rules.js'
import { addSpaceColumn, spaceGuard, type MeegleSpace, type SpaceGuard } from './meegle-space.js'

type DB = Database.Database

export type StatusPhase = 'none' | 'creating' | 'done' | 'failed' | 'skipped'
export type StatusStep = 'state' | 'date' | 'extraDate' | 'writeback'
export type StatusRow = {
  batch_id: string; row_key: string; source_key: string; sheet_url: string; sheet_row: number; summary: string
  work_item_id: string; owner_email: string; target_key: string; target_name: string; date_mode: DateMode
  /** 指定日期（set 模式、Sheet 有填才有）；台北當天 00:00 的毫秒 */
  sheet_date: number | null
  /** 哪個 Meegle 空間（v5.10.0；舊紀錄是 test） */
  space: MeegleSpace
  /** 指定日期模式下、目標狀態以外也填了的日期欄（v5.22.0）：JSON [{field,label,ms}]；舊紀錄 NULL */
  extra_dates: string | null
  created_at: number; updated_at: number
}
export type ExtraDate = { field: string; label: string; ms: number }
export type StatusStepRow = { batch_id: string; row_key: string; step: StatusStep; phase: StatusPhase; message: string | null; attempt_at: number | null; updated_at: number; data: string | null }

/** date 步驟存的資料：第一次讀到的原值與要寫的值。重試一律用這裡的，不重新讀原值（那時已經被自動化蓋掉了） */
export type DateData = { field: string; label: string; original: number | null; desired: number | null; pending?: boolean; observed?: number | null }

export function initMeegleStatusSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meegle_status_rows (
      batch_id TEXT NOT NULL, row_key TEXT NOT NULL,
      source_key TEXT NOT NULL, sheet_url TEXT NOT NULL DEFAULT '', sheet_row INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
      work_item_id TEXT NOT NULL, owner_email TEXT NOT NULL,
      target_key TEXT NOT NULL, target_name TEXT NOT NULL DEFAULT '', date_mode TEXT NOT NULL, sheet_date INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (batch_id, row_key)
    );
    CREATE INDEX IF NOT EXISTS idx_meegle_status_rows_item ON meegle_status_rows (work_item_id);
    CREATE TABLE IF NOT EXISTS meegle_status_steps (
      batch_id TEXT NOT NULL, row_key TEXT NOT NULL, step TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'none', message TEXT, attempt_at INTEGER, updated_at INTEGER NOT NULL, data TEXT,
      PRIMARY KEY (batch_id, row_key, step)
    );
  `)
  addSpaceColumn(db, 'meegle_status_rows')
  // v5.22.0：目標狀態以外的指定日期（使用者 1006：轉到完成時填的上C服時間也要寫）。只加欄，不動舊資料
  const cols = (db.prepare('PRAGMA table_info(meegle_status_rows)').all() as { name: string }[]).map(c => c.name)
  if (!cols.includes('extra_dates')) db.exec('ALTER TABLE meegle_status_rows ADD COLUMN extra_dates TEXT')
}

export function getStatusRow(db: DB, batchId: string, rowKey: string): StatusRow | undefined {
  return db.prepare('SELECT * FROM meegle_status_rows WHERE batch_id = ? AND row_key = ?').get(batchId, rowKey) as StatusRow | undefined
}
export function getStatusSteps(db: DB, batchId: string, rowKey: string): StatusStepRow[] {
  return db.prepare('SELECT * FROM meegle_status_steps WHERE batch_id = ? AND row_key = ? ORDER BY rowid').all(batchId, rowKey) as StatusStepRow[]
}
export function dateDataOf(step: Pick<StatusStepRow, 'data'> | undefined): DateData | null {
  try { return step?.data ? JSON.parse(step.data) as DateData : null } catch { return null }
}

export type StatusClaimInput = {
  batchId: string; workItemId: string; sourceKey: string; sheetUrl: string; sheetRow: number; summary: string
  ownerEmail: string; targetKey: string; targetName: string; dateMode: DateMode; sheetDate: number | null
  space: MeegleSpace
  /** 目標狀態以外也要寫的日期（只有 set 模式、有填的才帶） */
  extraDates?: ExtraDate[]
}
export type StatusClaimResult =
  | { kind: 'claimed' }
  | { kind: 'busy'; batchId: string; step: string }
  | { kind: 'not-owner' }
  | { kind: 'source-mismatch' }
  | { kind: 'target-changed' }
  | SpaceGuard

/**
 * 認領一列（IMMEDIATE 交易）：同一張單在任何批次有 creating 就不給跑——兩個分頁同時轉同一張單只有一個拿得到。
 * 同批次重送：done 的步驟保留；目標狀態或日期設定跟第一次不同 → 擋（要換目標請開新批次，不然「只補日期」會補錯）。
 */
export function claimStatusRow(db: DB, input: StatusClaimInput, now = Date.now()): StatusClaimResult {
  const owner = input.ownerEmail.trim().toLowerCase()
  const R = input.workItemId
  return db.transaction((): StatusClaimResult => {
    const other = db.prepare('SELECT 1 FROM meegle_status_rows WHERE batch_id = ? AND source_key != ? LIMIT 1').get(input.batchId, input.sourceKey)
    if (other) return { kind: 'source-mismatch' }
    const sg = spaceGuard(db, 'meegle_status_rows', input.batchId, input.sourceKey, input.space)
    if (sg) return sg
    const live = db.prepare(`SELECT s.batch_id, s.step FROM meegle_status_steps s JOIN meegle_status_rows r ON r.batch_id = s.batch_id AND r.row_key = s.row_key
      WHERE r.work_item_id = ? AND s.phase = 'creating' LIMIT 1`).get(R) as { batch_id: string; step: string } | undefined
    if (live) return { kind: 'busy', batchId: live.batch_id, step: live.step }

    const existing = getStatusRow(db, input.batchId, R)
    if (existing) {
      if (existing.owner_email !== owner) return { kind: 'not-owner' }
      if (existing.target_key !== input.targetKey || existing.date_mode !== input.dateMode || existing.sheet_date !== input.sheetDate
        || (existing.extra_dates ?? '[]') !== extraJson(input.extraDates)) return { kind: 'target-changed' }
      db.prepare('UPDATE meegle_status_rows SET sheet_url = ?, sheet_row = ?, summary = ?, updated_at = ? WHERE batch_id = ? AND row_key = ?')
        .run(input.sheetUrl, input.sheetRow, input.summary, now, input.batchId, R)
      return { kind: 'claimed' }
    }
    db.prepare(`INSERT INTO meegle_status_rows (batch_id, row_key, source_key, sheet_url, sheet_row, summary, work_item_id, owner_email,
      target_key, target_name, date_mode, sheet_date, space, extra_dates, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.batchId, R, input.sourceKey, input.sheetUrl, input.sheetRow, input.summary, R, owner,
        input.targetKey, input.targetName, input.dateMode, input.sheetDate, input.space, extraJson(input.extraDates), now, now)
    const ins = db.prepare('INSERT INTO meegle_status_steps (batch_id, row_key, step, phase, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (const s of ['state', 'date', 'extraDate', 'writeback'] as const) ins.run(input.batchId, R, s, 'none', now)
    return { kind: 'claimed' }
  }).immediate()
}

const extraJson = (list: ExtraDate[] | undefined) => JSON.stringify([...(list ?? [])].sort((a, b) => a.field.localeCompare(b.field)))
export function extraDatesOf(row: Pick<StatusRow, 'extra_dates'>): ExtraDate[] {
  try { const v = JSON.parse(row.extra_dates ?? '[]'); return Array.isArray(v) ? v as ExtraDate[] : [] } catch { return [] }
}

/** 開始一步：只能從 none／failed 進 creating（原子，搶不到回 false）。data 給了就覆寫。 */
export function beginStatusStep(db: DB, batchId: string, rowKey: string, step: StatusStep, now = Date.now(), data?: unknown): boolean {
  return db.prepare(`UPDATE meegle_status_steps SET phase = 'creating', message = NULL, attempt_at = ?, updated_at = ?, data = COALESCE(?, data)
    WHERE batch_id = ? AND row_key = ? AND step = ? AND phase IN ('none', 'failed')`)
    .run(now, now, data === undefined ? null : JSON.stringify(data), batchId, rowKey, step).changes === 1
}

/** 結束一步：只從 creating 轉出（晚回來的舊請求不蓋別的結果）。 */
export function finishStatusStep(db: DB, batchId: string, rowKey: string, step: StatusStep, phase: 'done' | 'failed' | 'skipped', message: string | null = null, data?: unknown, now = Date.now()): boolean {
  return db.prepare(`UPDATE meegle_status_steps SET phase = ?, message = ?, data = COALESCE(?, data), updated_at = ?
    WHERE batch_id = ? AND row_key = ? AND step = ? AND phase = 'creating'`)
    .run(phase, message, data === undefined ? null : JSON.stringify(data), now, batchId, rowKey, step).changes === 1
}

/** 程序中途掛掉留下的 creating：轉狀態／日期／回填都可以安全重試，超時一律改 failed。 */
export function expireStaleStatusSteps(db: DB, olderThanMs: number, now = Date.now()): number {
  return db.prepare(`UPDATE meegle_status_steps SET phase = 'failed', message = '處理中斷，可重試', updated_at = ?
    WHERE phase = 'creating' AND COALESCE(attempt_at, updated_at) < ?`).run(now, now - olderThanMs).changes
}

/** 這份 Sheet 之前送過的列（每張單最新一批），讓畫面接回「日期待確認／補寫回」。 */
export function listPreviousStatusForSource(db: DB, sourceKey: string, space: MeegleSpace): Array<StatusRow & { steps: StatusStepRow[] }> {
  const rows = db.prepare(`SELECT r.* FROM meegle_status_rows r
    WHERE r.source_key = ? AND r.space = ? AND r.created_at = (SELECT MAX(r2.created_at) FROM meegle_status_rows r2 WHERE r2.source_key = r.source_key AND r2.work_item_id = r.work_item_id)`)
    .all(sourceKey, space) as StatusRow[]
  return rows.map(r => ({ ...r, steps: getStatusSteps(db, r.batch_id, r.row_key) }))
}

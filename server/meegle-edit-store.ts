/**
 * Meegle 批量修改的送出紀錄。一列＝一張單（row_key＝單號），拆四步各自記：
 *   fields（一般欄位＋描述圖片，一次 update）→ roles（逐角色 remove／add）→ verify（讀回比對）→ writeback（Sheet 回填）
 * 每一步都是「設成絕對值」，可以安全重試；讀回不符時重試會從 fields 重做（CodeX 2026-10-02）。
 * payload 存送出當下的原文與預覽原值：重試用它，不靠前端草稿。
 */
import type Database from 'better-sqlite3'

type DB = Database.Database

export type EditPhase = 'none' | 'creating' | 'done' | 'failed' | 'skipped'
export type EditStep = 'fields' | 'roles' | 'verify' | 'writeback'
export const EDIT_STEPS: EditStep[] = ['fields', 'roles', 'verify', 'writeback']
export type EditRow = {
  batch_id: string; row_key: string; source_key: string; sheet_url: string; sheet_row: number; summary: string
  work_item_id: string; owner_email: string; payload: string; created_at: number; updated_at: number
}
export type EditStepRow = { batch_id: string; row_key: string; step: EditStep; phase: EditPhase; message: string | null; attempt_at: number | null; updated_at: number; data: string | null }

export function initMeegleEditSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meegle_edit_rows (
      batch_id TEXT NOT NULL, row_key TEXT NOT NULL,
      source_key TEXT NOT NULL, sheet_url TEXT NOT NULL DEFAULT '', sheet_row INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
      work_item_id TEXT NOT NULL, owner_email TEXT NOT NULL, payload TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (batch_id, row_key)
    );
    CREATE INDEX IF NOT EXISTS idx_meegle_edit_rows_item ON meegle_edit_rows (work_item_id);
    CREATE TABLE IF NOT EXISTS meegle_edit_steps (
      batch_id TEXT NOT NULL, row_key TEXT NOT NULL, step TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'none', message TEXT, attempt_at INTEGER, updated_at INTEGER NOT NULL, data TEXT,
      PRIMARY KEY (batch_id, row_key, step)
    );
  `)
}

export function getEditRow(db: DB, batchId: string, rowKey: string): EditRow | undefined {
  return db.prepare('SELECT * FROM meegle_edit_rows WHERE batch_id = ? AND row_key = ?').get(batchId, rowKey) as EditRow | undefined
}
export function getEditSteps(db: DB, batchId: string, rowKey: string): EditStepRow[] {
  return db.prepare('SELECT * FROM meegle_edit_steps WHERE batch_id = ? AND row_key = ? ORDER BY rowid').all(batchId, rowKey) as EditStepRow[]
}

export type EditClaimInput = { batchId: string; workItemId: string; sourceKey: string; sheetUrl: string; sheetRow: number; summary: string; ownerEmail: string; payload: string }
export type EditClaimResult = { kind: 'claimed' } | { kind: 'busy'; batchId: string; step: string } | { kind: 'not-owner' } | { kind: 'source-mismatch' } | { kind: 'already-sent' }

/**
 * 認領（IMMEDIATE 交易）：同一張單任何批次有 creating 就不給跑。
 * 同批次再送：還沒有任何一步 done → 換成這次的內容；已經做過任何一步 → 不收新內容（用「重試」接著做，不能半途換內容）
 */
export function claimEditRow(db: DB, input: EditClaimInput, now = Date.now()): EditClaimResult {
  const owner = input.ownerEmail.trim().toLowerCase()
  const R = input.workItemId
  return db.transaction((): EditClaimResult => {
    if (db.prepare('SELECT 1 FROM meegle_edit_rows WHERE batch_id = ? AND source_key != ? LIMIT 1').get(input.batchId, input.sourceKey)) return { kind: 'source-mismatch' }
    const live = db.prepare(`SELECT s.batch_id, s.step FROM meegle_edit_steps s JOIN meegle_edit_rows r ON r.batch_id = s.batch_id AND r.row_key = s.row_key
      WHERE r.work_item_id = ? AND s.phase = 'creating' LIMIT 1`).get(R) as { batch_id: string; step: string } | undefined
    if (live) return { kind: 'busy', batchId: live.batch_id, step: live.step }
    const existing = getEditRow(db, input.batchId, R)
    if (existing) {
      if (existing.owner_email !== owner) return { kind: 'not-owner' }
      if (getEditSteps(db, input.batchId, R).some(s => s.phase === 'done')) return { kind: 'already-sent' }
      db.prepare('UPDATE meegle_edit_rows SET sheet_url = ?, sheet_row = ?, summary = ?, payload = ?, updated_at = ? WHERE batch_id = ? AND row_key = ?')
        .run(input.sheetUrl, input.sheetRow, input.summary, input.payload, now, input.batchId, R)
      db.prepare(`UPDATE meegle_edit_steps SET phase = 'none', message = NULL, updated_at = ? WHERE batch_id = ? AND row_key = ?`).run(now, input.batchId, R)
      return { kind: 'claimed' }
    }
    db.prepare(`INSERT INTO meegle_edit_rows (batch_id, row_key, source_key, sheet_url, sheet_row, summary, work_item_id, owner_email, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.batchId, R, input.sourceKey, input.sheetUrl, input.sheetRow, input.summary, R, owner, input.payload, now, now)
    const ins = db.prepare('INSERT INTO meegle_edit_steps (batch_id, row_key, step, phase, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (const s of EDIT_STEPS) ins.run(input.batchId, R, s, 'none', now)
    return { kind: 'claimed' }
  }).immediate()
}

export function beginEditStep(db: DB, batchId: string, rowKey: string, step: EditStep, now = Date.now()): boolean {
  return db.prepare(`UPDATE meegle_edit_steps SET phase = 'creating', message = NULL, attempt_at = ?, updated_at = ?
    WHERE batch_id = ? AND row_key = ? AND step = ? AND phase IN ('none', 'failed')`).run(now, now, batchId, rowKey, step).changes === 1
}
export function finishEditStep(db: DB, batchId: string, rowKey: string, step: EditStep, phase: 'done' | 'failed' | 'skipped', message: string | null = null, data?: unknown, now = Date.now()): boolean {
  return db.prepare(`UPDATE meegle_edit_steps SET phase = ?, message = ?, data = COALESCE(?, data), updated_at = ?
    WHERE batch_id = ? AND row_key = ? AND step = ? AND phase = 'creating'`)
    .run(phase, message, data === undefined ? null : JSON.stringify(data), now, batchId, rowKey, step).changes === 1
}
/** 讀回不符 → 重試要從 fields 重做：把 fields／roles 退回 none（只在 verify 是 failed 時） */
export function resetForRewrite(db: DB, batchId: string, rowKey: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const v = getEditSteps(db, batchId, rowKey).find(s => s.step === 'verify')
    if (v?.phase !== 'failed') return false
    db.prepare(`UPDATE meegle_edit_steps SET phase = 'none', updated_at = ? WHERE batch_id = ? AND row_key = ? AND step IN ('fields', 'roles') AND phase IN ('done', 'skipped')`).run(now, batchId, rowKey)
    return true
  })()
}
export function expireStaleEditSteps(db: DB, olderThanMs: number, now = Date.now()): number {
  return db.prepare(`UPDATE meegle_edit_steps SET phase = 'failed', message = '處理中斷，可重試', updated_at = ?
    WHERE phase = 'creating' AND COALESCE(attempt_at, updated_at) < ?`).run(now, now - olderThanMs).changes
}
export function listPreviousEditForSource(db: DB, sourceKey: string): Array<EditRow & { steps: EditStepRow[] }> {
  const rows = db.prepare(`SELECT r.* FROM meegle_edit_rows r
    WHERE r.source_key = ? AND r.created_at = (SELECT MAX(r2.created_at) FROM meegle_edit_rows r2 WHERE r2.source_key = r.source_key AND r2.work_item_id = r.work_item_id)`)
    .all(sourceKey) as EditRow[]
  return rows.map(r => ({ ...r, steps: getEditSteps(db, r.batch_id, r.row_key) }))
}

/**
 * Meegle 批量評論的送出紀錄（防重送）與「上次寫入的測試說明」基準。設計跟 CodeX 對過（2026-10-02）：
 *
 * - 一列＝一張 Meegle 單（row_key＝單號）。來源用 sheetSourceKey，不靠列號——排序、插列後列號會認錯
 * - 每列拆成幾個**步驟**各自記狀態：desc（覆寫測試說明）、comment（評論）、video:N（每支影片一則）、review（AI 完整性分析）、writeback（Sheet 回填）
 *   none → creating → done / failed / unknown；review 沒開記 skipped
 * - creating／unknown 一律擋重送（含跨批次），**unknown 只能由人確認收尾**——評論不回 comment_id，查不到不代表沒送出
 * - 跨批次已經 comment=done → 視為已評論；要再送一輪必須明確 allowRepeat
 * - 認領在 IMMEDIATE 交易裡做完，交易提交後才呼叫遠端
 */
import type Database from 'better-sqlite3'

type DB = Database.Database

export type StepPhase = 'none' | 'creating' | 'done' | 'failed' | 'unknown' | 'skipped'
export type CommentRow = {
  batch_id: string; row_key: string; source_key: string; sheet_url: string; sheet_row: number; summary: string
  work_item_id: string; owner_email: string; as_email: string; created_at: number; updated_at: number
}
export type StepRow = { batch_id: string; row_key: string; step: string; phase: StepPhase; message: string | null; attempt_at: number | null; updated_at: number; data: string | null }

export function initMeegleCommentSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meegle_comment_rows (
      batch_id TEXT NOT NULL, row_key TEXT NOT NULL,
      source_key TEXT NOT NULL, sheet_url TEXT NOT NULL DEFAULT '', sheet_row INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
      work_item_id TEXT NOT NULL, owner_email TEXT NOT NULL, as_email TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (batch_id, row_key)
    );
    CREATE INDEX IF NOT EXISTS idx_meegle_comment_rows_src ON meegle_comment_rows (source_key, work_item_id);
    CREATE TABLE IF NOT EXISTS meegle_comment_steps (
      batch_id TEXT NOT NULL, row_key TEXT NOT NULL, step TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'none', message TEXT, attempt_at INTEGER, updated_at INTEGER NOT NULL, data TEXT,
      PRIMARY KEY (batch_id, row_key, step)
    );
    CREATE TABLE IF NOT EXISTS meegle_desc_snapshots (
      work_item_id TEXT PRIMARY KEY, hash TEXT NOT NULL, written_at INTEGER NOT NULL, written_by TEXT NOT NULL DEFAULT ''
    );
  `)
}

export function stepNames(videoCount: number, withReview: boolean): Array<{ step: string; phase: StepPhase }> {
  return [
    { step: 'desc', phase: 'none' },
    { step: 'comment', phase: 'none' },
    ...Array.from({ length: videoCount }, (_, i) => ({ step: `video:${i}`, phase: 'none' as StepPhase })),
    { step: 'review', phase: withReview ? 'none' : 'skipped' },
    { step: 'writeback', phase: 'none' },
  ]
}

export function getCommentRow(db: DB, batchId: string, rowKey: string): CommentRow | undefined {
  return db.prepare('SELECT * FROM meegle_comment_rows WHERE batch_id = ? AND row_key = ?').get(batchId, rowKey) as CommentRow | undefined
}
export function getSteps(db: DB, batchId: string, rowKey: string): StepRow[] {
  return db.prepare('SELECT * FROM meegle_comment_steps WHERE batch_id = ? AND row_key = ? ORDER BY rowid').all(batchId, rowKey) as StepRow[]
}

export type ClaimInput = {
  batchId: string; workItemId: string; sourceKey: string; sheetUrl: string; sheetRow: number; summary: string
  ownerEmail: string; asEmail: string; videoCount: number; withReview: boolean; allowRepeat?: boolean
}
export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'busy'; batchId: string; step: string }
  | { kind: 'unknown'; batchId: string; step: string }
  | { kind: 'already-commented'; batchId: string }
  | { kind: 'not-owner' }
  | { kind: 'source-mismatch' }

/**
 * 認領一列。全部在 IMMEDIATE 交易裡判斷完——兩個分頁同時送同一張單，只有一個拿得到。
 * 同批次重送：done 的步驟保留、failed／none 的會重跑；有 creating／unknown 就不給跑。
 */
export function claimCommentRow(db: DB, input: ClaimInput, now = Date.now()): ClaimResult {
  const owner = input.ownerEmail.trim().toLowerCase()
  const rowKey = input.workItemId
  return db.transaction((): ClaimResult => {
    const other = db.prepare('SELECT 1 FROM meegle_comment_rows WHERE batch_id = ? AND source_key != ? LIMIT 1').get(input.batchId, input.sourceKey)
    if (other) return { kind: 'source-mismatch' }

    // 跨批次：同一份 Sheet、同一張單
    const inflight = db.prepare(`SELECT s.batch_id, s.step, s.phase FROM meegle_comment_steps s JOIN meegle_comment_rows r ON r.batch_id = s.batch_id AND r.row_key = s.row_key
      WHERE r.source_key = ? AND r.work_item_id = ? AND r.batch_id != ? AND s.phase IN ('creating', 'unknown') LIMIT 1`)
      .get(input.sourceKey, input.workItemId, input.batchId) as { batch_id: string; step: string; phase: StepPhase } | undefined
    if (inflight) return inflight.phase === 'creating' ? { kind: 'busy', batchId: inflight.batch_id, step: inflight.step } : { kind: 'unknown', batchId: inflight.batch_id, step: inflight.step }
    if (!input.allowRepeat) {
      const done = db.prepare(`SELECT r.batch_id FROM meegle_comment_steps s JOIN meegle_comment_rows r ON r.batch_id = s.batch_id AND r.row_key = s.row_key
        WHERE r.source_key = ? AND r.work_item_id = ? AND r.batch_id != ? AND s.step = 'comment' AND s.phase = 'done' LIMIT 1`)
        .get(input.sourceKey, input.workItemId, input.batchId) as { batch_id: string } | undefined
      if (done) return { kind: 'already-commented', batchId: done.batch_id }
    }

    const existing = getCommentRow(db, input.batchId, rowKey)
    if (existing) {
      if (existing.owner_email !== owner) return { kind: 'not-owner' }
      const steps = getSteps(db, input.batchId, rowKey)
      const live = steps.find(s => s.phase === 'creating')
      if (live) return { kind: 'busy', batchId: input.batchId, step: live.step }
      const unk = steps.find(s => s.phase === 'unknown')
      if (unk) return { kind: 'unknown', batchId: input.batchId, step: unk.step }
      db.prepare('UPDATE meegle_comment_rows SET sheet_url = ?, sheet_row = ?, summary = ?, as_email = ?, updated_at = ? WHERE batch_id = ? AND row_key = ?')
        .run(input.sheetUrl, input.sheetRow, input.summary, input.asEmail.trim().toLowerCase(), now, input.batchId, rowKey)
      // 這次的步驟清單：缺的補上（例如多了一支影片）；review 開關以這次為準（沒做過的才改）
      const ins = db.prepare('INSERT OR IGNORE INTO meegle_comment_steps (batch_id, row_key, step, phase, updated_at) VALUES (?, ?, ?, ?, ?)')
      for (const s of stepNames(input.videoCount, input.withReview)) ins.run(input.batchId, rowKey, s.step, s.phase, now)
      db.prepare(`UPDATE meegle_comment_steps SET phase = ?, updated_at = ? WHERE batch_id = ? AND row_key = ? AND step = 'review' AND phase IN ('none', 'skipped', 'failed')`)
        .run(input.withReview ? 'none' : 'skipped', now, input.batchId, rowKey)
      return { kind: 'claimed' }
    }

    db.prepare(`INSERT INTO meegle_comment_rows (batch_id, row_key, source_key, sheet_url, sheet_row, summary, work_item_id, owner_email, as_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.batchId, rowKey, input.sourceKey, input.sheetUrl, input.sheetRow, input.summary, input.workItemId, owner, input.asEmail.trim().toLowerCase(), now, now)
    const ins = db.prepare('INSERT INTO meegle_comment_steps (batch_id, row_key, step, phase, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (const s of stepNames(input.videoCount, input.withReview)) ins.run(input.batchId, rowKey, s.step, s.phase, now)
    return { kind: 'claimed' }
  }).immediate()
}

/** 開始一個步驟：只能從 none／failed 進 creating（原子，搶不到回 false）。 */
export function beginStep(db: DB, batchId: string, rowKey: string, step: string, now = Date.now()): boolean {
  return db.prepare(`UPDATE meegle_comment_steps SET phase = 'creating', message = NULL, attempt_at = ?, updated_at = ?
    WHERE batch_id = ? AND row_key = ? AND step = ? AND phase IN ('none', 'failed')`).run(now, now, batchId, rowKey, step).changes === 1
}

/** 步驟結果。只從 creating 轉出去——較晚回來的舊請求不會蓋掉別的結果。 */
export function finishStep(db: DB, batchId: string, rowKey: string, step: string, phase: 'done' | 'failed' | 'unknown', message: string | null = null, data: unknown = undefined, now = Date.now()): boolean {
  return db.prepare(`UPDATE meegle_comment_steps SET phase = ?, message = ?, data = COALESCE(?, data), updated_at = ?
    WHERE batch_id = ? AND row_key = ? AND step = ? AND phase = 'creating'`)
    .run(phase, message, data === undefined ? null : JSON.stringify(data), now, batchId, rowKey, step).changes === 1
}

/** unknown 由人確認收尾（看了候選評論後）：done＝確定有送出；failed＝確定沒有、可重送。 */
export function resolveUnknownStep(db: DB, batchId: string, rowKey: string, step: string, phase: 'done' | 'failed', message: string | null, now = Date.now()): boolean {
  return db.prepare(`UPDATE meegle_comment_steps SET phase = ?, message = ?, updated_at = ?
    WHERE batch_id = ? AND row_key = ? AND step = ? AND phase = 'unknown'`).run(phase, message, now, batchId, rowKey, step).changes === 1
}

/** 程序中途掛掉留下的 creating：超過時限改成 unknown（不能當沒送過）。 */
export function expireStaleSteps(db: DB, olderThanMs: number, now = Date.now()): number {
  return db.prepare(`UPDATE meegle_comment_steps SET phase = 'unknown', message = '處理中斷，結果不明', updated_at = ?
    WHERE phase = 'creating' AND COALESCE(attempt_at, updated_at) < ?`).run(now, now - olderThanMs).changes
}

/** Sheet 回填的前提：其他步驟都 done／skipped（CodeX：全部成功才回填）。 */
export function readyForWriteback(steps: Pick<StepRow, 'step' | 'phase'>[]): boolean {
  const others = steps.filter(s => s.step !== 'writeback')
  return others.length > 0 && others.every(s => s.phase === 'done' || s.phase === 'skipped')
}

export function getSnapshot(db: DB, workItemId: string): string | null {
  const r = db.prepare('SELECT hash FROM meegle_desc_snapshots WHERE work_item_id = ?').get(workItemId) as { hash: string } | undefined
  return r?.hash ?? null
}
export function setSnapshot(db: DB, workItemId: string, hash: string, by: string, now = Date.now()) {
  db.prepare(`INSERT INTO meegle_desc_snapshots (work_item_id, hash, written_at, written_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET hash = excluded.hash, written_at = excluded.written_at, written_by = excluded.written_by`)
    .run(workItemId, hash, now, by.toLowerCase())
}

/** 這份 Sheet 之前送過的列（最新一批），讓畫面接回「待確認／補寫回」。 */
export function listPreviousForSource(db: DB, sourceKey: string): Array<CommentRow & { steps: StepRow[] }> {
  const rows = db.prepare(`SELECT r.* FROM meegle_comment_rows r
    WHERE r.source_key = ? AND r.created_at = (SELECT MAX(r2.created_at) FROM meegle_comment_rows r2 WHERE r2.source_key = r.source_key AND r2.work_item_id = r.work_item_id)
    ORDER BY r.created_at`).all(sourceKey) as CommentRow[]
  return rows.map(r => ({ ...r, steps: getSteps(db, r.batch_id, r.row_key) }))
}

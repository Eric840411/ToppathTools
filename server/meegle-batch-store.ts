/**
 * Meegle 批量開單的落地紀錄：每一列開到哪一步、開出哪張單。
 *
 * 為什麼要存（CodeX review）：前端是逐列呼叫，網路斷掉／逾時／使用者重整頁面後再按一次送出，
 * 如果伺服器不記得「這一列已經開過」，就會開出第二張一模一樣的單。所以：
 * - 開單前先「認領」這一列（creating）。同一列已經是 creating／unknown → 不准再開。
 * - 開單成功 → created＋單號；之後同一列再送只會補推狀態，**不會重開**。
 * - 伺服器明確拒絕（沒有副作用）→ failed，可以修正後重送。
 * - 逾時／看不懂 → unknown（結果待確認），**查明前不重送**。
 *
 * db 從外面傳進來，測試用記憶體 DB。
 */
import type Database from 'better-sqlite3'
import { isRestorablePrevious, normAlias } from '../shared/meegle-batch-rules.js'

type DB = Database.Database

export type CreatePhase = 'creating' | 'created' | 'failed' | 'unknown'
export type StatePhase = 'none' | 'done' | 'failed' | 'unknown'

export type BatchRow = {
  batch_id: string
  row_key: string
  owner_email: string
  sheet_url: string
  name: string
  requirement_id: string
  target_state: string
  create_phase: CreatePhase
  work_item_id: string | null
  url: string | null
  state_phase: StatePhase
  message: string | null
  created_at: number
  updated_at: number
}

export function initMeegleBatchSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meegle_batch_rows (
      batch_id       TEXT NOT NULL,     -- 前端每次「開始送出」產生的 UUID
      row_key        TEXT NOT NULL,     -- Sheet 列號
      owner_email    TEXT NOT NULL,     -- 送出的人（登入 email，小寫）；別人不能接手他的列
      sheet_url      TEXT NOT NULL DEFAULT '',  -- 來源 Sheet；下次讀同一份 Sheet 時標出「已開過」，避免跨批重開
      name           TEXT NOT NULL,
      requirement_id TEXT NOT NULL,
      target_state   TEXT NOT NULL DEFAULT '',
      create_phase   TEXT NOT NULL,     -- creating | created | failed | unknown
      work_item_id   TEXT,
      url            TEXT,
      state_phase    TEXT NOT NULL DEFAULT 'none',  -- none | done | failed | unknown
      message        TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (batch_id, row_key)
    );
    -- Sheet 上的人名（暱稱）→ Meegle 帳號。CodeX：對照結果要存，不能每次都重查。
    CREATE TABLE IF NOT EXISTS meegle_person_map (
      alias           TEXT PRIMARY KEY,  -- 去頭尾空白、小寫
      meegle_user_key TEXT NOT NULL,
      meegle_email    TEXT NOT NULL DEFAULT '',
      meegle_name     TEXT NOT NULL DEFAULT '',
      updated_by      TEXT NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `)
}

/**
 * 這份 Sheet 送過的列（跨批次、所有狀態，failed 除外——failed 沒開出任何東西）。
 * 前端用來：已開過的標「已開過」、**開單中／待確認的把原批次接回來**（重整頁面後 batchId 會換新，CodeX [P1]），
 * 才能對它按「查詢結果」，而不是被當成沒送過重新勾選。
 */
export function listRowsFromSheet(db: DB, sheetUrl: string): BatchRow[] {
  if (!sheetUrl) return []
  return db.prepare(`SELECT * FROM meegle_batch_rows WHERE sheet_url = ? AND create_phase != 'failed' ORDER BY created_at`).all(sheetUrl) as BatchRow[]
}

export function getBatchRow(db: DB, batchId: string, rowKey: string): BatchRow | undefined {
  return db.prepare('SELECT * FROM meegle_batch_rows WHERE batch_id = ? AND row_key = ?').get(batchId, rowKey) as BatchRow | undefined
}

export type ClaimResult =
  | { kind: 'claimed' }                      // 這一列可以開單
  | { kind: 'already-created'; row: BatchRow } // 已經開過，只能補推狀態
  | { kind: 'busy'; row: BatchRow }           // 另一個請求正在開，或結果待確認
  | { kind: 'not-owner'; row: BatchRow }
  | { kind: 'source-mismatch' }               // 這個批次是別份 Sheet 的

/**
 * 認領一列準備開單。單一 SQL 交易內完成「讀現況＋寫 creating」，兩個請求同時進來只有一個拿得到。
 * failed 的列可以重新認領（伺服器明確拒絕過，沒有開出任何東西）。
 *
 * 另外兩道（CodeX review 999f895 [P1]×2）：
 * - **批次綁定來源 Sheet**：同一個 batchId 已經有別份 Sheet 的列 → 拒絕。否則換 Sheet 沿用舊批次時，
 *   B 表第 3 列會撞到 A 表第 3 列的紀錄，回傳 A 的單號、B 沒建立，還可能去推 A 的狀態。
 * - **同一份 Sheet 同一列，任何批次還在開單中／待確認 → busy**。batchId 只活在前端記憶體，重整後換新，
 *   只看 (batchId, 列號) 擋不住「重整後再按一次送出」。
 */
export function claimRow(db: DB, input: { batchId: string; rowKey: string; ownerEmail: string; sheetUrl?: string; name: string; requirementId: string; targetState: string }, now = Date.now()): ClaimResult {
  const owner = input.ownerEmail.trim().toLowerCase()
  return db.transaction((): ClaimResult => {
    const sheetUrl = input.sheetUrl ?? ''
    const other = db.prepare('SELECT sheet_url FROM meegle_batch_rows WHERE batch_id = ? AND sheet_url != ? LIMIT 1').get(input.batchId, sheetUrl)
    if (other) return { kind: 'source-mismatch' }
    if (sheetUrl) {
      const pending = db.prepare(`SELECT * FROM meegle_batch_rows WHERE sheet_url = ? AND row_key = ? AND batch_id != ?
        AND create_phase IN ('creating', 'unknown') LIMIT 1`).get(sheetUrl, input.rowKey, input.batchId) as BatchRow | undefined
      if (pending) return { kind: 'busy', row: pending }
    }
    const existing = getBatchRow(db, input.batchId, input.rowKey)
    if (existing) {
      if (existing.owner_email !== owner) return { kind: 'not-owner', row: existing }
      if (existing.create_phase === 'created') return { kind: 'already-created', row: existing }
      if (existing.create_phase === 'creating' || existing.create_phase === 'unknown') return { kind: 'busy', row: existing }
      // failed → 重新認領，內容以這次為準
      db.prepare(`UPDATE meegle_batch_rows SET name = ?, requirement_id = ?, target_state = ?, create_phase = 'creating',
        state_phase = 'none', message = NULL, updated_at = ? WHERE batch_id = ? AND row_key = ? AND create_phase = 'failed'`)
        .run(input.name, input.requirementId, input.targetState, now, input.batchId, input.rowKey)
      return { kind: 'claimed' }
    }
    db.prepare(`INSERT INTO meegle_batch_rows (batch_id, row_key, owner_email, sheet_url, name, requirement_id, target_state, create_phase, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`)
      .run(input.batchId, input.rowKey, owner, sheetUrl, input.name, input.requirementId, input.targetState, now, now)
    return { kind: 'claimed' }
  }).immediate()
}

/** 開單結果寫回。只從 creating 轉出去，避免較晚回來的請求蓋掉別的結果。 */
export function finishCreate(db: DB, batchId: string, rowKey: string,
  result: { phase: 'created'; workItemId: string; url: string } | { phase: 'failed' | 'unknown'; message: string }, now = Date.now()) {
  if (result.phase === 'created') {
    db.prepare(`UPDATE meegle_batch_rows SET create_phase = 'created', work_item_id = ?, url = ?, message = NULL, updated_at = ?
      WHERE batch_id = ? AND row_key = ? AND create_phase = 'creating'`).run(result.workItemId, result.url, now, batchId, rowKey)
  } else {
    db.prepare(`UPDATE meegle_batch_rows SET create_phase = ?, message = ?, updated_at = ?
      WHERE batch_id = ? AND row_key = ? AND create_phase = 'creating'`).run(result.phase, result.message, now, batchId, rowKey)
  }
}

/**
 * 已開單、有目標狀態、但狀態還沒推成功 → 要補推。
 * 「結果待確認」查明後收成 created 時 state_phase 還是 none，不補推的話畫面顯示成功、單卻停在初始狀態（CodeX review 999f895 [P2]）。
 */
export function needsStatePush(row: Pick<BatchRow, 'create_phase' | 'work_item_id' | 'target_state' | 'state_phase'>): boolean {
  // 判斷本體跟前端「讀 Sheet 時接回哪些列」共用同一份（shared），兩邊不會一個要補推、一個沒給入口
  return row.create_phase === 'created' && isRestorablePrevious({ createPhase: row.create_phase, statePhase: row.state_phase, targetStateKey: row.target_state, workItemId: row.work_item_id })
}

export function finishState(db: DB, batchId: string, rowKey: string, phase: StatePhase, message: string | null, now = Date.now()) {
  db.prepare(`UPDATE meegle_batch_rows SET state_phase = ?, message = ?, updated_at = ?
    WHERE batch_id = ? AND row_key = ? AND create_phase = 'created'`).run(phase, message, now, batchId, rowKey)
}

/**
 * 「結果待確認」查明之後的處置：找到唯一一張 → 收成 created；確定沒有 → 改成 failed（可重送）。
 * 找到多張不在這裡處理（呼叫端不該呼叫），維持 unknown 交給人判斷。
 */
export function resolveUnknown(db: DB, batchId: string, rowKey: string,
  found: { workItemId: string; url: string } | null, now = Date.now()): boolean {
  const r = found
    ? db.prepare(`UPDATE meegle_batch_rows SET create_phase = 'created', work_item_id = ?, url = ?, message = NULL, updated_at = ?
        WHERE batch_id = ? AND row_key = ? AND create_phase = 'unknown'`).run(found.workItemId, found.url, now, batchId, rowKey)
    : db.prepare(`UPDATE meegle_batch_rows SET create_phase = 'failed', message = '確認過 Meegle 沒有這張單，可以重送', updated_at = ?
        WHERE batch_id = ? AND row_key = ? AND create_phase = 'unknown'`).run(now, batchId, rowKey)
  return r.changes === 1
}

/** creating 卡太久（伺服器在開單途中重啟）→ 轉成 unknown，讓人去確認，而不是永遠卡住或被當成可重送。 */
export function expireStaleCreating(db: DB, olderThanMs: number, now = Date.now()): number {
  return db.prepare(`UPDATE meegle_batch_rows SET create_phase = 'unknown', message = '開單途中中斷，無法確定是否已建立', updated_at = ?
    WHERE create_phase = 'creating' AND updated_at < ?`).run(now, now - olderThanMs).changes
}

// ─── 人員對照 ────────────────────────────────────────────────────────────────

export type PersonMapRow = { alias: string; meegle_user_key: string; meegle_email: string; meegle_name: string; updated_by: string; updated_at: number }

export function getPersonMap(db: DB, aliases: string[]): Record<string, PersonMapRow> {
  const out: Record<string, PersonMapRow> = {}
  const stmt = db.prepare('SELECT * FROM meegle_person_map WHERE alias = ?')
  for (const a of new Set(aliases.map(normAlias).filter(Boolean))) {
    const row = stmt.get(a) as PersonMapRow | undefined
    if (row) out[a] = row
  }
  return out
}

export function listPersonMap(db: DB): PersonMapRow[] {
  return db.prepare('SELECT * FROM meegle_person_map ORDER BY alias').all() as PersonMapRow[]
}

export function upsertPersonMap(db: DB, alias: string, person: { userKey: string; email: string; name: string }, by: string, now = Date.now()) {
  const a = normAlias(alias)
  if (!a) throw new Error('人名不能空白')
  if (!person.userKey) throw new Error('缺少 Meegle user_key')
  db.prepare(`INSERT INTO meegle_person_map (alias, meegle_user_key, meegle_email, meegle_name, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(alias) DO UPDATE SET meegle_user_key = excluded.meegle_user_key, meegle_email = excluded.meegle_email,
      meegle_name = excluded.meegle_name, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(a, person.userKey, person.email, person.name, by, now)
}

export function deletePersonMap(db: DB, alias: string): boolean {
  return db.prepare('DELETE FROM meegle_person_map WHERE alias = ?').run(normAlias(alias)).changes === 1
}

/**
 * 版本驗證表的資料層（docs/features/35-osm-verify.md；規格 osm-qa-agent reports/spec-verify-form-1120.md v2）。
 * 照 osm-release-store 的做法：工具就是主檔、樂觀鎖 rev、軟刪除、完整快照的修改履歷、Lark 一次匯入冪等（source_key）。
 * 沒有副作用（不打網路）、可以拿記憶體 DB 直接測。
 *
 * 幾條不能退讓的規則：
 *  1. 開單冪等：送出前在 IMMEDIATE transaction 裡「原子搶占」tickets 列，idempotency_key 有 DB 唯一約束
 *  2. 結果不明（unknown）不會自動重送；只有「確認重送」沿用同一把 key、「再開一張」才產新 key
 *  3. 沿用同一把 key 的重送只能由原開單人、而且 Meegle 綁定沒換過（綁定 rev 相同）——不然會用別人的身分開出同一張單
 *  4. 標「已上正式」必須至少綁一筆有效版本紀錄、平台都有涵蓋（releaseCheck，前後端共用）
 *  5. 被批次引用的版本紀錄不能刪：DB trigger 擋（不靠呼叫端記得檢查）
 *  6. 學習事件持久化在 osm_verify_events，游標＝遞增 seq；ack 綁 event 當下的 batch rev，
 *     學習狀態由「還有沒有沒 ack 的事件」推出來——舊事件 ack 不會把新版批次標成已完成
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import type Database from 'better-sqlite3'
import { initOsmReleaseSchema, getRelease, listTabs, listComponents } from './osm-release-store.js'
import {
  batchDisplayName, releaseCheck, ticketKey, splitPlatforms,
  type BatchInput, type ItemInput, type PublishStatus, type LearnStatus, type TicketStatus, type EventType,
  type PlatformMap, type ReleaseCheck, type CheckRelease, type SnapshotPayload,
} from '../shared/osm-verify-rules.js'

type DB = Database.Database

export function initOsmVerifySchema(db: DB) {
  initOsmReleaseSchema(db)   // trigger 要掛在 osm_releases 上，表要先在
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS osm_verify_batches (
      id TEXT PRIMARY KEY, year INTEGER NOT NULL, batch TEXT NOT NULL, name TEXT NOT NULL,
      publish_status TEXT NOT NULL DEFAULT 'draft' CHECK (publish_status IN ('draft','verified','released')),
      learn_status TEXT NOT NULL DEFAULT 'none' CHECK (learn_status IN ('none','learning','done','failed')),
      prod_version TEXT NOT NULL DEFAULT '', released_at INTEGER, released_by TEXT NOT NULL DEFAULT '',
      source_key TEXT UNIQUE,
      created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_osm_verify_batch_name ON osm_verify_batches(name) WHERE deleted = 0;
    CREATE TABLE IF NOT EXISTS osm_verify_batch_releases (
      batch_id TEXT NOT NULL, release_id INTEGER NOT NULL, release_rev INTEGER NOT NULL,
      bound_by TEXT NOT NULL DEFAULT '', bound_at INTEGER NOT NULL,
      PRIMARY KEY (batch_id, release_id)
    );
    CREATE INDEX IF NOT EXISTS idx_osm_verify_br_release ON osm_verify_batch_releases(release_id);
    CREATE TABLE IF NOT EXISTS osm_verify_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
      platform TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      env TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', ok_count INTEGER NOT NULL DEFAULT 0,
      verifier TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '',
      source_key TEXT UNIQUE,
      created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_osm_verify_items_batch ON osm_verify_items(batch_id, deleted, sort);
    CREATE TABLE IF NOT EXISTS osm_verify_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, batch_id TEXT NOT NULL, seq INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending','created','unknown','failed')),
      space TEXT NOT NULL DEFAULT '', type_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
      work_item_id TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL, created_label TEXT NOT NULL DEFAULT '', binding_rev TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (item_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_osm_verify_tickets_item ON osm_verify_tickets(item_id, seq);
    CREATE TABLE IF NOT EXISTS osm_verify_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
      rev INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_osm_verify_rev_batch ON osm_verify_revisions(batch_id, id);
    CREATE TABLE IF NOT EXISTS osm_verify_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, batch_id TEXT NOT NULL, type TEXT NOT NULL,
      batch_rev INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      delivered_at INTEGER, acked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_osm_verify_events_batch ON osm_verify_events(batch_id, acked_at);
    CREATE TRIGGER IF NOT EXISTS trg_osm_verify_release_ref BEFORE UPDATE OF deleted ON osm_releases
    WHEN NEW.deleted = 1 AND OLD.deleted = 0 AND EXISTS (
      SELECT 1 FROM osm_verify_batch_releases br JOIN osm_verify_batches b ON b.id = br.batch_id
      WHERE br.release_id = NEW.id AND b.deleted = 0)
    BEGIN SELECT RAISE(ABORT, 'OSM_VERIFY_RELEASE_REFERENCED'); END;
  `)
}

// ─── 型別 ─────────────────────────────────────────────────────────────────────

export interface BatchRow {
  id: string; year: number; batch: string; name: string
  publishStatus: PublishStatus; learnStatus: LearnStatus; prodVersion: string
  releasedAt: number | null; releasedBy: string
  createdBy: string; createdAt: number; updatedBy: string; updatedAt: number; rev: number
}
export interface TicketRow {
  id: number; itemId: number; batchId: string; seq: number; key: string; status: TicketStatus
  space: string; typeKey: string; name: string; workItemId: string; url: string; message: string
  createdBy: string; createdLabel: string; bindingRev: string; attempts: number; createdAt: number; updatedAt: number
}
export interface ItemRow extends ItemInput {
  id: number; batchId: string; sort: number
  createdBy: string; createdAt: number; updatedBy: string; updatedAt: number; rev: number
}
export interface BindingRow { releaseId: number; releaseRev: number; boundBy: string; boundAt: number }

export type Fail = { ok: false; reason: string; message: string; current?: unknown }

const rowToBatch = (r: Record<string, unknown>): BatchRow => ({
  id: String(r.id), year: Number(r.year), batch: String(r.batch), name: String(r.name),
  publishStatus: r.publish_status as PublishStatus, learnStatus: r.learn_status as LearnStatus, prodVersion: String(r.prod_version),
  releasedAt: r.released_at == null ? null : Number(r.released_at), releasedBy: String(r.released_by),
  createdBy: String(r.created_by), createdAt: Number(r.created_at), updatedBy: String(r.updated_by), updatedAt: Number(r.updated_at), rev: Number(r.rev),
})
const rowToItem = (r: Record<string, unknown>): ItemRow => ({
  id: Number(r.id), batchId: String(r.batch_id), sort: Number(r.sort),
  platform: String(r.platform), type: String(r.type), description: String(r.description), env: String(r.env),
  result: String(r.result), okCount: Number(r.ok_count), verifier: String(r.verifier), attachments: String(r.attachments), remark: String(r.remark),
  createdBy: String(r.created_by), createdAt: Number(r.created_at), updatedBy: String(r.updated_by), updatedAt: Number(r.updated_at), rev: Number(r.rev),
})
const rowToTicket = (r: Record<string, unknown>): TicketRow => ({
  id: Number(r.id), itemId: Number(r.item_id), batchId: String(r.batch_id), seq: Number(r.seq), key: String(r.idempotency_key), status: r.status as TicketStatus,
  space: String(r.space), typeKey: String(r.type_key), name: String(r.name), workItemId: String(r.work_item_id), url: String(r.url), message: String(r.message),
  createdBy: String(r.created_by), createdLabel: String(r.created_label), bindingRev: String(r.binding_rev), attempts: Number(r.attempts),
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
})

// ─── 讀取 ─────────────────────────────────────────────────────────────────────

export function getBatch(db: DB, id: string): BatchRow | null {
  const r = db.prepare('SELECT * FROM osm_verify_batches WHERE id = ? AND deleted = 0').get(id) as Record<string, unknown> | undefined
  return r ? rowToBatch(r) : null
}

export function listBatches(db: DB) {
  const rows = (db.prepare('SELECT * FROM osm_verify_batches WHERE deleted = 0 ORDER BY year DESC, batch DESC, created_at DESC').all() as Record<string, unknown>[]).map(rowToBatch)
  const items = db.prepare('SELECT batch_id, COUNT(*) c FROM osm_verify_items WHERE deleted = 0 GROUP BY batch_id').all() as { batch_id: string; c: number }[]
  const binds = db.prepare('SELECT batch_id, COUNT(*) c FROM osm_verify_batch_releases GROUP BY batch_id').all() as { batch_id: string; c: number }[]
  const im = new Map(items.map(x => [x.batch_id, x.c])), bm = new Map(binds.map(x => [x.batch_id, x.c]))
  return rows.map(b => ({ ...b, itemCount: im.get(b.id) ?? 0, bindingCount: bm.get(b.id) ?? 0 }))
}

export function getItem(db: DB, id: number): ItemRow | null {
  const r = db.prepare('SELECT * FROM osm_verify_items WHERE id = ? AND deleted = 0').get(id) as Record<string, unknown> | undefined
  return r ? rowToItem(r) : null
}

/** 開單途中伺服器重啟會留下 pending；超過這個時間就轉成結果不明（CLI 單次逾時 45 秒） */
export const STALE_PENDING_MS = 5 * 60_000

export function sweepStalePending(db: DB, now = Date.now()) {
  db.prepare(`UPDATE osm_verify_tickets SET status = 'unknown', message = '開單途中中斷（伺服器可能重啟），無法確定 Meegle 是否已開單', updated_at = ?
    WHERE status = 'pending' AND updated_at < ?`).run(now, now - STALE_PENDING_MS)
}

export function listTickets(db: DB, itemIds: number[]): Map<number, TicketRow[]> {
  const out = new Map<number, TicketRow[]>()
  if (!itemIds.length) return out
  for (let i = 0; i < itemIds.length; i += 500) {
    const chunk = itemIds.slice(i, i + 500)
    const rows = db.prepare(`SELECT * FROM osm_verify_tickets WHERE item_id IN (${chunk.map(() => '?').join(',')}) ORDER BY item_id, seq`).all(...chunk) as Record<string, unknown>[]
    for (const r of rows) { const t = rowToTicket(r); out.set(t.itemId, [...(out.get(t.itemId) ?? []), t]) }
  }
  return out
}

export function getTicket(db: DB, id: number): TicketRow | null {
  const r = db.prepare('SELECT * FROM osm_verify_tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? rowToTicket(r) : null
}

export function latestTicket(db: DB, itemId: number): TicketRow | null {
  const r = db.prepare('SELECT * FROM osm_verify_tickets WHERE item_id = ? ORDER BY seq DESC LIMIT 1').get(itemId) as Record<string, unknown> | undefined
  return r ? rowToTicket(r) : null
}

export function listItems(db: DB, batchId: string) {
  const items = (db.prepare('SELECT * FROM osm_verify_items WHERE batch_id = ? AND deleted = 0 ORDER BY sort, id').all(batchId) as Record<string, unknown>[]).map(rowToItem)
  const tickets = listTickets(db, items.map(i => i.id))
  return items.map(i => ({ ...i, tickets: tickets.get(i.id) ?? [] }))
}

export function listBindings(db: DB, batchId: string): BindingRow[] {
  return (db.prepare('SELECT * FROM osm_verify_batch_releases WHERE batch_id = ? ORDER BY bound_at').all(batchId) as Record<string, unknown>[])
    .map(r => ({ releaseId: Number(r.release_id), releaseRev: Number(r.release_rev), boundBy: String(r.bound_by), boundAt: Number(r.bound_at) }))
}

/** 版本紀錄被幾個（沒刪的）批次綁著 */
export function releaseRefCount(db: DB, releaseId: number): number {
  return (db.prepare(`SELECT COUNT(*) c FROM osm_verify_batch_releases br JOIN osm_verify_batches b ON b.id = br.batch_id WHERE br.release_id = ? AND b.deleted = 0`).get(releaseId) as { c: number }).c
}

// ─── 履歷與事件（內部） ───────────────────────────────────────────────────────

function snapshotOf(db: DB, batchId: string) {
  return { batch: getBatch(db, batchId), bindings: listBindings(db, batchId), items: listItems(db, batchId) }
}

function addRevision(db: DB, batchId: string, entity: 'batch' | 'item', entityId: string | number, rev: number, action: string, actor: string, now: number, snapshot: unknown) {
  db.prepare('INSERT INTO osm_verify_revisions (batch_id, entity, entity_id, rev, action, actor, at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(batchId, entity, String(entityId), rev, action, actor, now, JSON.stringify(snapshot))
}

export function listRevisions(db: DB, batchId: string) {
  return (db.prepare('SELECT * FROM osm_verify_revisions WHERE batch_id = ? ORDER BY id DESC LIMIT 500').all(batchId) as Record<string, unknown>[])
    .map(r => ({ entity: String(r.entity), entityId: String(r.entity_id), rev: Number(r.rev), action: String(r.action), actor: String(r.actor), at: Number(r.at), snapshot: JSON.parse(String(r.snapshot)) as unknown }))
}

/** 事件 payload：上正式／修訂的完整快照（契約見 shared SnapshotPayload） */
export function buildSnapshot(db: DB, batchId: string): SnapshotPayload {
  const b = getBatch(db, batchId)!
  return {
    batchName: b.name,
    prodVersion: b.prodVersion,
    releases: listBindings(db, batchId).map(x => ({ id: x.releaseId, rev: x.releaseRev })),
    items: listItems(db, batchId).map(i => ({
      id: i.id, platform: i.platform, type: i.type, description: i.description, env: i.env, result: i.result,
      okCount: i.okCount, verifier: i.verifier, tickets: i.tickets.filter(t => t.status === 'created' && t.workItemId).map(t => t.workItemId),
    })),
  }
}

/** 學習狀態由事件推出來：有沒 ack 的 → 未開始／學習中（已送出過）；全部 ack → 已完成；沒有事件 → 未開始 */
function recomputeLearn(db: DB, batchId: string) {
  const s = db.prepare('SELECT COUNT(*) total, SUM(acked_at IS NULL) unacked, SUM(acked_at IS NULL AND delivered_at IS NOT NULL) delivered FROM osm_verify_events WHERE batch_id = ?')
    .get(batchId) as { total: number; unacked: number | null; delivered: number | null }
  const status: LearnStatus = !s.total ? 'none' : (s.unacked ?? 0) === 0 ? 'done' : (s.delivered ?? 0) > 0 ? 'learning' : 'none'
  db.prepare('UPDATE osm_verify_batches SET learn_status = ? WHERE id = ? AND learn_status <> ?').run(status, batchId, status)
}

function emitEvent(db: DB, batchId: string, type: EventType, batchRev: number, payload: unknown, now: number) {
  db.prepare('INSERT INTO osm_verify_events (id, batch_id, type, batch_rev, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), batchId, type, batchRev, JSON.stringify(payload), now)
  recomputeLearn(db, batchId)
}

/** 已上正式的批次有任何修改：批次 rev +1、記修訂事件（agent 重新學） */
function bumpReleased(db: DB, batchId: string, actor: string, now: number) {
  const b = getBatch(db, batchId)
  if (!b || b.publishStatus !== 'released') return
  db.prepare('UPDATE osm_verify_batches SET rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(actor, now, batchId)
  const rev = b.rev + 1
  addRevision(db, batchId, 'batch', batchId, rev, 'revise', actor, now, snapshotOf(db, batchId))
  emitEvent(db, batchId, 'batch.revised', rev, buildSnapshot(db, batchId), now)
}

// ─── 批次 ─────────────────────────────────────────────────────────────────────

export function createBatch(db: DB, input: BatchInput, actor: string, opts: { sourceKey?: string; now?: number } = {}): { ok: true; id: string } | Fail {
  const now = opts.now ?? Date.now()
  const name = batchDisplayName(input.year, input.batch)
  return db.transaction((): { ok: true; id: string } | Fail => {
    if (db.prepare('SELECT 1 FROM osm_verify_batches WHERE name = ? AND deleted = 0').get(name)) return { ok: false, reason: 'duplicate', message: `已經有批次 ${name}` }
    const id = randomUUID()
    db.prepare(`INSERT INTO osm_verify_batches (id, year, batch, name, publish_status, prod_version, source_key, created_by, created_at, updated_by, updated_at, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(id, input.year, input.batch.trim(), name, input.publishStatus, input.prodVersion, opts.sourceKey ?? null, actor, now, actor, now)
    addRevision(db, id, 'batch', id, 1, opts.sourceKey ? 'import' : 'create', actor, now, snapshotOf(db, id))
    return { ok: true, id }
  }).immediate()
}

export function updateBatch(db: DB, id: string, expectedRev: number, input: BatchInput, actor: string, now = Date.now()): { ok: true; rev: number } | Fail {
  return db.transaction((): { ok: true; rev: number } | Fail => {
    const cur = getBatch(db, id)
    if (!cur) return { ok: false, reason: 'not_found', message: '找不到這個批次（可能已被刪除）' }
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', message: `${cur.updatedBy} 在你編輯期間改過這個批次，請重新載入後再改`, current: cur }
    const name = batchDisplayName(input.year, input.batch)
    if (db.prepare('SELECT 1 FROM osm_verify_batches WHERE name = ? AND deleted = 0 AND id <> ?').get(name, id)) return { ok: false, reason: 'duplicate', message: `已經有批次 ${name}` }
    // 已上正式不能退回（發布狀態維持 released）
    const status = cur.publishStatus === 'released' ? 'released' : input.publishStatus
    const rev = cur.rev + 1
    db.prepare('UPDATE osm_verify_batches SET year = ?, batch = ?, name = ?, publish_status = ?, prod_version = ?, updated_by = ?, updated_at = ?, rev = ? WHERE id = ?')
      .run(input.year, input.batch.trim(), name, status, input.prodVersion, actor, now, rev, id)
    addRevision(db, id, 'batch', id, rev, 'update', actor, now, snapshotOf(db, id))
    if (status === 'released') emitEvent(db, id, 'batch.revised', rev, buildSnapshot(db, id), now)
    return { ok: true, rev }
  }).immediate()
}

export function deleteBatch(db: DB, id: string, expectedRev: number, actor: string, now = Date.now()): { ok: true } | Fail {
  return db.transaction((): { ok: true } | Fail => {
    const cur = getBatch(db, id)
    if (!cur) return { ok: false, reason: 'not_found', message: '找不到這個批次' }
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', message: '這個批次在你開啟後被改過，請重新載入再刪除', current: cur }
    if (cur.publishStatus === 'released') return { ok: false, reason: 'released', message: '已上正式的批次不能刪除（agent 已經拿去學習）' }
    db.prepare('UPDATE osm_verify_batches SET deleted = 1, updated_by = ?, updated_at = ?, rev = rev + 1 WHERE id = ?').run(actor, now, id)
    addRevision(db, id, 'batch', id, cur.rev + 1, 'delete', actor, now, { batch: cur })
    return { ok: true }
  }).immediate()
}

// ─── 驗證項目 ─────────────────────────────────────────────────────────────────

export function createItem(db: DB, batchId: string, input: ItemInput, actor: string, opts: { sourceKey?: string; now?: number } = {}): { ok: true; id: number } | Fail {
  const now = opts.now ?? Date.now()
  return db.transaction((): { ok: true; id: number } | Fail => {
    if (!getBatch(db, batchId)) return { ok: false, reason: 'not_found', message: '找不到這個批次' }
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM osm_verify_items WHERE batch_id = ?').get(batchId) as { m: number }).m + 1
    const r = db.prepare(`INSERT INTO osm_verify_items (batch_id, sort, platform, type, description, env, result, ok_count, verifier, attachments, remark, source_key, created_by, created_at, updated_by, updated_at, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(batchId, sort, input.platform.trim(), input.type.trim(), input.description, input.env, input.result, input.okCount, input.verifier, input.attachments, input.remark, opts.sourceKey ?? null, actor, now, actor, now)
    const id = Number(r.lastInsertRowid)
    addRevision(db, batchId, 'item', id, 1, opts.sourceKey ? 'import' : 'create', actor, now, getItem(db, id))
    bumpReleased(db, batchId, actor, now)
    return { ok: true, id }
  }).immediate()
}

export function updateItem(db: DB, id: number, expectedRev: number, input: ItemInput, actor: string, now = Date.now()): { ok: true; rev: number } | Fail {
  return db.transaction((): { ok: true; rev: number } | Fail => {
    const cur = getItem(db, id)
    if (!cur) return { ok: false, reason: 'not_found', message: '找不到這個項目（可能已被刪除）' }
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', message: `${cur.updatedBy} 在你編輯期間改過這個項目，請重新載入後再改`, current: cur }
    const rev = cur.rev + 1
    db.prepare(`UPDATE osm_verify_items SET platform = ?, type = ?, description = ?, env = ?, result = ?, ok_count = ?, verifier = ?, attachments = ?, remark = ?,
      updated_by = ?, updated_at = ?, rev = ? WHERE id = ?`)
      .run(input.platform.trim(), input.type.trim(), input.description, input.env, input.result, input.okCount, input.verifier, input.attachments, input.remark, actor, now, rev, id)
    addRevision(db, cur.batchId, 'item', id, rev, 'update', actor, now, getItem(db, id))
    bumpReleased(db, cur.batchId, actor, now)
    return { ok: true, rev }
  }).immediate()
}

export function deleteItem(db: DB, id: number, expectedRev: number, actor: string, now = Date.now()): { ok: true } | Fail {
  return db.transaction((): { ok: true } | Fail => {
    const cur = getItem(db, id)
    if (!cur) return { ok: false, reason: 'not_found', message: '找不到這個項目' }
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', message: '這個項目在你開啟後被改過，請重新載入再刪除', current: cur }
    if (db.prepare("SELECT 1 FROM osm_verify_tickets WHERE item_id = ? AND status IN ('pending','unknown')").get(id)) {
      return { ok: false, reason: 'busy', message: '這個項目還有開單中／結果不明的單，先處理完再刪除' }
    }
    db.prepare('UPDATE osm_verify_items SET deleted = 1, updated_by = ?, updated_at = ?, rev = rev + 1 WHERE id = ?').run(actor, now, id)
    addRevision(db, cur.batchId, 'item', id, cur.rev + 1, 'delete', actor, now, cur)
    bumpReleased(db, cur.batchId, actor, now)
    return { ok: true }
  }).immediate()
}

// ─── 版本紀錄綁定與上正式檢查 ─────────────────────────────────────────────────

export function bindRelease(db: DB, batchId: string, releaseId: number, actor: string, now = Date.now()): { ok: true } | Fail {
  return db.transaction((): { ok: true } | Fail => {
    if (!getBatch(db, batchId)) return { ok: false, reason: 'not_found', message: '找不到這個批次' }
    const rel = getRelease(db, releaseId)
    if (!rel) return { ok: false, reason: 'release_not_found', message: '找不到這筆版本紀錄（可能已被刪除）' }
    const exists = db.prepare('SELECT 1 FROM osm_verify_batch_releases WHERE batch_id = ? AND release_id = ?').get(batchId, releaseId)
    if (exists) db.prepare('UPDATE osm_verify_batch_releases SET release_rev = ?, bound_by = ?, bound_at = ? WHERE batch_id = ? AND release_id = ?').run(rel.rev, actor, now, batchId, releaseId)
    else db.prepare('INSERT INTO osm_verify_batch_releases (batch_id, release_id, release_rev, bound_by, bound_at) VALUES (?, ?, ?, ?, ?)').run(batchId, releaseId, rel.rev, actor, now)
    addRevision(db, batchId, 'batch', batchId, getBatch(db, batchId)!.rev, 'bind', actor, now, { releaseId, releaseRev: rel.rev })
    bumpReleased(db, batchId, actor, now)
    return { ok: true }
  }).immediate()
}

export function unbindRelease(db: DB, batchId: string, releaseId: number, actor: string, now = Date.now()): { ok: true } | Fail {
  return db.transaction((): { ok: true } | Fail => {
    const b = getBatch(db, batchId)
    if (!b) return { ok: false, reason: 'not_found', message: '找不到這個批次' }
    if (b.publishStatus === 'released') {
      const others = listBindings(db, batchId).filter(x => x.releaseId !== releaseId && getRelease(db, x.releaseId))
      if (!others.length) return { ok: false, reason: 'last_binding', message: '已上正式的批次至少要留一筆有效的版本紀錄' }
    }
    if (!db.prepare('DELETE FROM osm_verify_batch_releases WHERE batch_id = ? AND release_id = ?').run(batchId, releaseId).changes) return { ok: false, reason: 'not_bound', message: '沒有綁這筆版本紀錄' }
    addRevision(db, batchId, 'batch', batchId, b.rev, 'unbind', actor, now, { releaseId })
    bumpReleased(db, batchId, actor, now)
    return { ok: true }
  }).immediate()
}

export const PLATFORM_MAP_KEY = 'osm_verify_platform_map'

export function getPlatformMap(db: DB): PlatformMap {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(PLATFORM_MAP_KEY) as { value: string } | undefined
  try { const v = r ? JSON.parse(r.value) : {}; return v && typeof v === 'object' && !Array.isArray(v) ? v as PlatformMap : {} } catch { return {} }
}
export function setPlatformMap(db: DB, map: PlatformMap) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(PLATFORM_MAP_KEY, JSON.stringify(map))
}

/** 綁定的版本紀錄（含已被刪的，標 valid:false）＋上正式檢查結果 */
export function checkBatch(db: DB, batchId: string): { check: ReleaseCheck; releases: (CheckRelease & { boundRev: number; currentRev: number | null; date: string; content: string })[] } {
  const tabs = new Map(listTabs(db).map(t => [t.id, t.name]))
  const comps = new Map(listComponents(db).map(c => [c.id, c.name]))
  const releases = listBindings(db, batchId).map(bd => {
    const rel = getRelease(db, bd.releaseId)
    return {
      id: bd.releaseId, valid: !!rel, tabId: rel?.tabId ?? '', tabName: rel ? tabs.get(rel.tabId) ?? rel.tabId : '',
      updatedComponents: rel ? rel.values.filter(v => v.state === 'updated').map(v => comps.get(v.componentId) ?? '').filter(Boolean) : [],
      boundRev: bd.releaseRev, currentRev: rel?.rev ?? null, date: rel ? rel.releaseDate || rel.testDate : '',
      content: rel ? rel.content.split('\n').map(l => l.trim()).find(Boolean) ?? '' : '',
    }
  })
  const items = listItems(db, batchId)
  return { check: releaseCheck(items, releases, getPlatformMap(db)), releases }
}

/** 標「已上正式」：檢查不過就擋（後端再驗一次，不靠按鈕停用）；綁定 rev 刷成當下的、記 batch.released 事件 */
export function markReleased(db: DB, batchId: string, expectedRev: number, prodVersion: string | undefined, actor: string, now = Date.now()): { ok: true; rev: number } | Fail {
  return db.transaction((): { ok: true; rev: number } | Fail => {
    const cur = getBatch(db, batchId)
    if (!cur) return { ok: false, reason: 'not_found', message: '找不到這個批次' }
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', message: `${cur.updatedBy} 在你開啟後改過這個批次，請重新載入`, current: cur }
    if (cur.publishStatus === 'released') return { ok: false, reason: 'already', message: '這個批次已經標記上正式' }
    const { check } = checkBatch(db, batchId)
    if (!check.ok) return { ok: false, reason: 'check_failed', message: '上正式檢查沒過：' + describeCheck(check), current: check }
    for (const bd of listBindings(db, batchId)) {
      const rel = getRelease(db, bd.releaseId)
      if (rel) db.prepare('UPDATE osm_verify_batch_releases SET release_rev = ? WHERE batch_id = ? AND release_id = ?').run(rel.rev, batchId, bd.releaseId)
    }
    const rev = cur.rev + 1
    db.prepare(`UPDATE osm_verify_batches SET publish_status = 'released', prod_version = ?, released_at = ?, released_by = ?, updated_by = ?, updated_at = ?, rev = ? WHERE id = ?`)
      .run(prodVersion ?? cur.prodVersion, now, actor, actor, now, rev, batchId)
    addRevision(db, batchId, 'batch', batchId, rev, 'release', actor, now, snapshotOf(db, batchId))
    emitEvent(db, batchId, 'batch.released', rev, buildSnapshot(db, batchId), now)
    return { ok: true, rev }
  }).immediate()
}

export function describeCheck(c: ReleaseCheck): string {
  const parts: string[] = []
  if (c.missingBinding) parts.push('沒有綁定有效的版本紀錄')
  if (c.invalidReleaseIds.length) parts.push(`綁定的版本紀錄已被刪除（#${c.invalidReleaseIds.join('、#')}）`)
  if (c.noItems) parts.push('沒有驗證項目')
  if (c.itemsWithoutPlatform) parts.push(`${c.itemsWithoutPlatform} 個項目沒填平台`)
  if (c.uncovered.length) parts.push(`平台沒有版本紀錄涵蓋：${c.uncovered.join('、')}`)
  return parts.join('；')
}

/** 刪版本紀錄前先問：被批次綁著就不刪（DB trigger 也會擋，這裡是給畫面看得懂的訊息） */
export function releaseDeleteBlocker(db: DB, releaseId: number): string | null {
  const n = releaseRefCount(db, releaseId)
  if (!n) return null
  const names = (db.prepare(`SELECT b.name FROM osm_verify_batch_releases br JOIN osm_verify_batches b ON b.id = br.batch_id WHERE br.release_id = ? AND b.deleted = 0`).all(releaseId) as { name: string }[]).map(x => x.name)
  return `這筆版本紀錄被版本驗證表 ${names.join('、')} 綁定，不能刪除（先到該批次解除綁定）`
}

// ─── 開單（冪等搶占） ─────────────────────────────────────────────────────────

export type ClaimMode = 'create' | 'resend' | 'again'
export type ClaimResult =
  | { ok: true; ticket: TicketRow; reused: boolean }
  | { ok: false; reason: 'not_found' | 'busy' | 'unknown' | 'already_created' | 'not_owner' | 'binding_changed' | 'bad_mode' | 'taken'; message: string; ticket?: TicketRow }

/** 低階：插一筆 pending。key 有唯一約束，撞到＝別人先搶到 → taken（不丟錯、不覆蓋） */
export function insertTicketClaim(db: DB, p: { itemId: number; batchId: string; seq: number; key: string; space: string; typeKey: string; name: string; actor: string; label: string; bindingRev: string; now: number }): TicketRow | null {
  const r = db.prepare(`INSERT INTO osm_verify_tickets (item_id, batch_id, seq, idempotency_key, status, space, type_key, name, created_by, created_label, binding_rev, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`)
    .run(p.itemId, p.batchId, p.seq, p.key, p.space, p.typeKey, p.name, p.actor.toLowerCase(), p.label, p.bindingRev, p.now, p.now)
  return r.changes ? getTicket(db, Number(r.lastInsertRowid)) : null
}

/**
 * 送出前原子搶占（IMMEDIATE transaction）。
 *  - create：沒開過 → 新 key；上一張 failed → 沿用同一把 key 重試（限原開單人＋綁定沒換）；
 *            pending → busy；unknown → 要使用者決定（到遠端查／確認重送／再開一張）；created → 已開過
 *  - resend：只限 unknown，沿用同一把 key（限原開單人＋綁定沒換）
 *  - again ：再開一張＝新 key（上一張 created／unknown／failed 都可以；pending 不行）
 */
export function claimTicket(db: DB, p: { itemId: number; mode: ClaimMode; actor: string; label: string; bindingRev: string; space: string; typeKey: string; name: string; now?: number }): ClaimResult {
  const now = p.now ?? Date.now()
  return db.transaction((): ClaimResult => {
    sweepStalePending(db, now)
    const item = getItem(db, p.itemId)
    if (!item) return { ok: false, reason: 'not_found', message: '找不到這個項目（可能已被刪除）' }
    const latestRow = db.prepare('SELECT * FROM osm_verify_tickets WHERE item_id = ? ORDER BY seq DESC LIMIT 1').get(p.itemId) as Record<string, unknown> | undefined
    const latest = latestRow ? rowToTicket(latestRow) : null
    if (latest?.status === 'pending') return { ok: false, reason: 'busy', message: '這一列正在開單中', ticket: latest }

    const reuse = (t: TicketRow): ClaimResult => {
      if (t.createdBy !== p.actor.toLowerCase()) return { ok: false, reason: 'not_owner', message: `這張單是 ${t.createdLabel || t.createdBy} 開的；沿用同一把 key 重送要由原開單人操作，或改用「再開一張」`, ticket: t }
      if (t.bindingRev !== p.bindingRev) return { ok: false, reason: 'binding_changed', message: '你的 Meegle 綁定在第一次開單後換過，不能沿用同一把 key 重送；請改用「再開一張」', ticket: t }
      // 條件式更新：只有狀態沒被別人改過才搶得到
      const ch = db.prepare(`UPDATE osm_verify_tickets SET status = 'pending', message = '', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = ?`).run(now, t.id, t.status).changes
      if (!ch) return { ok: false, reason: 'busy', message: '這一列剛被別人送出', ticket: t }
      return { ok: true, ticket: getTicket(db, t.id)!, reused: true }
    }
    const fresh = (): ClaimResult => {
      const seq = (latest?.seq ?? 0) + 1
      const t = insertTicketClaim(db, { itemId: p.itemId, batchId: item.batchId, seq, key: ticketKey(item.batchId, p.itemId, seq), space: p.space, typeKey: p.typeKey, name: p.name, actor: p.actor, label: p.label, bindingRev: p.bindingRev, now })
      if (!t) return { ok: false, reason: 'taken', message: '這一列剛被別人送出' }
      return { ok: true, ticket: t, reused: false }
    }

    if (p.mode === 'create') {
      if (!latest) return fresh()
      if (latest.status === 'failed') return reuse(latest)
      if (latest.status === 'unknown') return { ok: false, reason: 'unknown', message: '上一次開單結果不明：請先「到遠端查」，或選「確認重送」／「再開一張」', ticket: latest }
      return { ok: false, reason: 'already_created', message: `這一列已經開過單 #${latest.workItemId}；要另外開請用「再開一張」`, ticket: latest }
    }
    if (p.mode === 'resend') {
      if (latest?.status !== 'unknown') return { ok: false, reason: 'bad_mode', message: '只有「結果不明」的單可以確認重送', ticket: latest ?? undefined }
      return reuse(latest)
    }
    if (p.mode === 'again') {
      if (!latest) return { ok: false, reason: 'bad_mode', message: '還沒開過單，直接按「開單」', }
      return fresh()
    }
    return { ok: false, reason: 'bad_mode', message: '不認得的操作' }
  }).immediate()
}

export type TicketOutcome =
  | { kind: 'created'; workItemId: string; url: string }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown'; message: string }

/** 開單結果寫回。只寫 pending 的（被 sweep 轉成 unknown 的晚回來結果照樣寫——成功拿到單號比不明好） */
export function finishTicket(db: DB, ticketId: number, out: TicketOutcome, now = Date.now()): TicketRow | null {
  return db.transaction(() => {
    const t = getTicket(db, ticketId)
    if (!t || (t.status !== 'pending' && !(t.status === 'unknown' && out.kind === 'created'))) return t
    if (out.kind === 'created') {
      db.prepare(`UPDATE osm_verify_tickets SET status = 'created', work_item_id = ?, url = ?, message = '', updated_at = ? WHERE id = ?`).run(out.workItemId, out.url, now, ticketId)
      onTicketCreated(db, t, out.workItemId, now)
    } else {
      db.prepare('UPDATE osm_verify_tickets SET status = ?, message = ?, updated_at = ? WHERE id = ?').run(out.kind, out.message.slice(0, 500), now, ticketId)
    }
    return getTicket(db, ticketId)
  }).immediate()
}

/** 已上正式的批次之後開的單也要讓 agent 知道（避免學習漏單號） */
function onTicketCreated(db: DB, t: TicketRow, workItemId: string, now: number) {
  const b = getBatch(db, t.batchId)
  if (!b || b.publishStatus !== 'released') return
  emitEvent(db, t.batchId, 'batch.ticket_created', b.rev, { itemId: t.itemId, ticket: workItemId }, now)
}

/**
 * 「到遠端查」的結果寫回（只動 unknown）。找到唯一一張 → 已開單；查無／多張 → 維持結果不明，
 * **查無也不自動重送**，由使用者選「確認重送」或「再開一張」。
 */
export function applyLookup(db: DB, ticketId: number, found: { workItemId: string; url: string }[], now = Date.now()): { ticket: TicketRow | null; result: 'created' | 'not_found' | 'multiple' | 'not_unknown' } {
  return db.transaction(() => {
    const t = getTicket(db, ticketId)
    if (!t || t.status !== 'unknown') return { ticket: t, result: 'not_unknown' as const }
    if (found.length === 1) {
      db.prepare(`UPDATE osm_verify_tickets SET status = 'created', work_item_id = ?, url = ?, message = '', updated_at = ? WHERE id = ? AND status = 'unknown'`).run(found[0].workItemId, found[0].url, now, ticketId)
      onTicketCreated(db, t, found[0].workItemId, now)
      return { ticket: getTicket(db, ticketId), result: 'created' as const }
    }
    const msg = found.length ? `遠端找到 ${found.length} 張帶同一把 key 的單（#${found.map(f => f.workItemId).join('、#')}），請到 Meegle 確認` : '遠端查無這把 key 的單；不會自動重送，請選「確認重送」或「再開一張」'
    db.prepare('UPDATE osm_verify_tickets SET message = ?, updated_at = ? WHERE id = ?').run(msg, now, ticketId)
    return { ticket: getTicket(db, ticketId), result: found.length ? 'multiple' as const : 'not_found' as const }
  }).immediate()
}

// ─── 學習事件（pull） ─────────────────────────────────────────────────────────

export interface EventOut { id: string; type: string; batchId: string; batchRev: number; createdAt: string; payload: unknown }

/** 游標分頁：cursor＝上一頁最後一筆的 seq（不透明字串）；沒有更多時回原游標 */
export function listEvents(db: DB, cursor: string | null | undefined, limit: number, now = Date.now()): { events: EventOut[]; nextCursor: string | null } {
  const after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
  const n = Math.min(Math.max(Math.floor(limit) || 50, 1), 200)
  const rows = db.prepare('SELECT * FROM osm_verify_events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, n) as Record<string, unknown>[]
  if (!rows.length) return { events: [], nextCursor: cursor || null }
  db.transaction(() => {
    const touched = new Set<string>()
    for (const r of rows) if (r.delivered_at == null) { db.prepare('UPDATE osm_verify_events SET delivered_at = ? WHERE seq = ?').run(now, r.seq); touched.add(String(r.batch_id)) }
    for (const b of touched) recomputeLearn(db, b)
  })()
  return {
    events: rows.map(r => ({ id: String(r.id), type: String(r.type), batchId: String(r.batch_id), batchRev: Number(r.batch_rev), createdAt: new Date(Number(r.created_at)).toISOString(), payload: JSON.parse(String(r.payload)) })),
    nextCursor: String(rows[rows.length - 1].seq),
  }
}

/**
 * ack：body 的 batchRev 必須等於事件產生當下的 batch rev（不是批次現在的 rev——agent 依序 ack 舊事件，
 * 拿現在的 rev 比會讓它永遠卡在第一個舊事件）。較舊／不符 → 409；重複 ack → 冪等回 ok。
 * 學習狀態由「還有沒有沒 ack 的事件」推：舊事件 ack 了、新修訂還沒 ack → 不會變成已完成。
 */
export function ackEvent(db: DB, id: string, batchRev: number, now = Date.now()): { ok: true } | { ok: false; reason: 'not_found' | 'conflict'; message: string } {
  return db.transaction(() => {
    const r = db.prepare('SELECT * FROM osm_verify_events WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) return { ok: false as const, reason: 'not_found' as const, message: '找不到這個事件' }
    if (Number(r.batch_rev) !== batchRev) return { ok: false as const, reason: 'conflict' as const, message: `batchRev 不符：事件是第 ${Number(r.batch_rev)} 版，ack 帶的是第 ${batchRev} 版` }
    if (r.acked_at == null) {
      db.prepare('UPDATE osm_verify_events SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?').run(now, now, id)
      recomputeLearn(db, String(r.batch_id))
    }
    return { ok: true as const }
  }).immediate()
}

// ─── 事件 API 服務憑證（只存雜湊，產生當下回一次明文） ─────────────────────────

export const EVENT_KEY_SETTING = 'osm_verify_event_key_hash'
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export function regenerateEventKey(db: DB): string {
  const key = `ovk_${randomBytes(32).toString('base64url')}`
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(EVENT_KEY_SETTING, sha256(key))
  return key
}

export function hasEventKey(db: DB): boolean {
  return !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(EVENT_KEY_SETTING)
}

/** Authorization: Bearer <key>；沒設過金鑰一律不通過 */
export function verifyEventKey(db: DB, authorization: string | undefined): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')
  if (!m) return false
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(EVENT_KEY_SETTING) as { value: string } | undefined
  if (!row || !/^[0-9a-f]{64}$/.test(row.value)) return false
  const a = Buffer.from(sha256(m[1]), 'hex'), b = Buffer.from(row.value, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export { splitPlatforms }

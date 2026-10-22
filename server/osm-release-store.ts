/**
 * OSM 版本更新紀錄的資料層（docs/features/33-osm-releases.md）。
 * 工具就是主檔（使用者 1022：捨棄 Lark 表），Lark 只在第一次匯入歷史資料時讀。
 * 沒有副作用、可以拿記憶體 DB 直接測。
 */
import type Database from 'better-sqlite3'
import type { ComponentState, ReleaseInput } from '../shared/osm-release-rules.js'

type DB = Database.Database

export function initOsmReleaseSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS osm_release_tabs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
      show_components INTEGER NOT NULL DEFAULT 1, show_sql INTEGER NOT NULL DEFAULT 0, show_result INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS osm_release_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tab_id TEXT NOT NULL, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (tab_id, name)
    );
    CREATE TABLE IF NOT EXISTS osm_release_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, tone TEXT NOT NULL DEFAULT 'other',
      sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS osm_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tab_id TEXT NOT NULL, status_id INTEGER,
      test_date TEXT NOT NULL DEFAULT '', release_date TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '', sql_text TEXT NOT NULL DEFAULT '', result_text TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual', source_key TEXT UNIQUE,
      created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_osm_releases_tab ON osm_releases(tab_id, deleted, release_date);
    CREATE TABLE IF NOT EXISTS osm_release_values (
      release_id INTEGER NOT NULL, component_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('updated','unchanged','na')), version TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (release_id, component_id)
    );
    CREATE TABLE IF NOT EXISTS osm_release_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL, rev INTEGER NOT NULL,
      action TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_osm_release_rev ON osm_release_revisions(release_id, rev);
    CREATE TABLE IF NOT EXISTS osm_release_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_email TEXT NOT NULL, name TEXT NOT NULL, filters TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  // 預設狀態：照 Lark「選取目錄」那頁
  const n = (db.prepare('SELECT COUNT(*) c FROM osm_release_statuses').get() as { c: number }).c
  if (!n) {
    const ins = db.prepare('INSERT INTO osm_release_statuses (name, tone, sort) VALUES (?, ?, ?)')
    ins.run('測試服', 'test', 1); ins.run('維護上正式', 'maint', 2); ins.run('熱更上正式', 'hot', 3)
  }
}

export interface TabRow { id: string; name: string; sort: number; showComponents: boolean; showSql: boolean; showResult: boolean; active: boolean }
export interface ComponentRow { id: number; tabId: string; name: string; groupName: string; sort: number; active: boolean; usage: number }
export interface StatusRow { id: number; name: string; tone: string; sort: number; active: boolean; usage: number }
export interface ReleaseRow {
  id: number; tabId: string; statusId: number | null; testDate: string; releaseDate: string
  content: string; sqlText: string; resultText: string; source: string
  createdBy: string; createdAt: number; updatedBy: string; updatedAt: number; rev: number
  values: { componentId: number; state: ComponentState; version: string }[]
}

export function listTabs(db: DB): TabRow[] {
  return (db.prepare('SELECT * FROM osm_release_tabs ORDER BY sort, name').all() as Record<string, unknown>[]).map(r => ({
    id: String(r.id), name: String(r.name), sort: Number(r.sort),
    showComponents: !!r.show_components, showSql: !!r.show_sql, showResult: !!r.show_result, active: !!r.active,
  }))
}

export function listComponents(db: DB): ComponentRow[] {
  return (db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM osm_release_values v JOIN osm_releases r ON r.id = v.release_id
                 WHERE v.component_id = c.id AND r.deleted = 0 AND v.state <> 'na') usage
    FROM osm_release_components c ORDER BY c.tab_id, c.sort, c.id`).all() as Record<string, unknown>[]).map(r => ({
    id: Number(r.id), tabId: String(r.tab_id), name: String(r.name), groupName: String(r.group_name), sort: Number(r.sort), active: !!r.active, usage: Number(r.usage),
  }))
}

export function listStatuses(db: DB): StatusRow[] {
  return (db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM osm_releases r WHERE r.status_id = s.id AND r.deleted = 0) usage
    FROM osm_release_statuses s ORDER BY s.sort, s.id`).all() as Record<string, unknown>[]).map(r => ({
    id: Number(r.id), name: String(r.name), tone: String(r.tone), sort: Number(r.sort), active: !!r.active, usage: Number(r.usage),
  }))
}

function rowToRelease(r: Record<string, unknown>, values: ReleaseRow['values']): ReleaseRow {
  return {
    id: Number(r.id), tabId: String(r.tab_id), statusId: r.status_id == null ? null : Number(r.status_id),
    testDate: String(r.test_date), releaseDate: String(r.release_date), content: String(r.content),
    sqlText: String(r.sql_text), resultText: String(r.result_text), source: String(r.source),
    createdBy: String(r.created_by), createdAt: Number(r.created_at), updatedBy: String(r.updated_by), updatedAt: Number(r.updated_at),
    rev: Number(r.rev), values,
  }
}

export function listReleases(db: DB, tabId?: string): ReleaseRow[] {
  const rows = (tabId
    ? db.prepare('SELECT * FROM osm_releases WHERE deleted = 0 AND tab_id = ?').all(tabId)
    : db.prepare('SELECT * FROM osm_releases WHERE deleted = 0').all()) as Record<string, unknown>[]
  const ids = rows.map(r => Number(r.id))
  const byRelease = new Map<number, ReleaseRow['values']>()
  if (ids.length) {
    const vals = db.prepare(`SELECT * FROM osm_release_values WHERE release_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Record<string, unknown>[]
    for (const v of vals) {
      const list = byRelease.get(Number(v.release_id)) ?? []
      list.push({ componentId: Number(v.component_id), state: v.state as ComponentState, version: String(v.version) })
      byRelease.set(Number(v.release_id), list)
    }
  }
  return rows.map(r => rowToRelease(r, byRelease.get(Number(r.id)) ?? []))
    .sort((a, b) => (b.releaseDate || b.testDate).localeCompare(a.releaseDate || a.testDate) || b.id - a.id)
}

export function getRelease(db: DB, id: number): ReleaseRow | null {
  const r = db.prepare('SELECT * FROM osm_releases WHERE id = ? AND deleted = 0').get(id) as Record<string, unknown> | undefined
  if (!r) return null
  const vals = (db.prepare('SELECT * FROM osm_release_values WHERE release_id = ?').all(id) as Record<string, unknown>[])
    .map(v => ({ componentId: Number(v.component_id), state: v.state as ComponentState, version: String(v.version) }))
  return rowToRelease(r, vals)
}

function snapshot(db: DB, id: number): string {
  return JSON.stringify(getRelease(db, id))
}

function writeValues(db: DB, releaseId: number, values: ReleaseInput['values']) {
  db.prepare('DELETE FROM osm_release_values WHERE release_id = ?').run(releaseId)
  const ins = db.prepare('INSERT INTO osm_release_values (release_id, component_id, state, version) VALUES (?, ?, ?, ?)')
  for (const v of values) ins.run(releaseId, v.componentId, v.state, v.state === 'updated' ? v.version.trim() : '')
}

export function createRelease(db: DB, input: ReleaseInput, actor: string, opts: { source?: string; sourceKey?: string; now?: number } = {}): number {
  const now = opts.now ?? Date.now()
  return db.transaction(() => {
    const r = db.prepare(`INSERT INTO osm_releases (tab_id, status_id, test_date, release_date, content, sql_text, result_text, source, source_key, created_by, created_at, updated_by, updated_at, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(input.tabId, input.statusId, input.testDate, input.releaseDate, input.content, input.sqlText, input.resultText,
        opts.source ?? 'manual', opts.sourceKey ?? null, actor, now, actor, now)
    const id = Number(r.lastInsertRowid)
    writeValues(db, id, input.values)
    db.prepare('INSERT INTO osm_release_revisions (release_id, rev, action, actor, at, snapshot) VALUES (?, 1, ?, ?, ?, ?)')
      .run(id, opts.source === 'lark-import' ? 'import' : 'create', actor, now, snapshot(db, id))
    return id
  }).immediate()
}

export type UpdateResult = { ok: true; rev: number } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'conflict'; current: ReleaseRow }

/** 樂觀鎖：送來的 rev 跟資料庫不一樣＝別人已經改過，回 conflict 讓畫面提示，不覆蓋 */
export function updateRelease(db: DB, id: number, expectedRev: number, input: ReleaseInput, actor: string, now = Date.now()): UpdateResult {
  return db.transaction((): UpdateResult => {
    const cur = getRelease(db, id)
    if (!cur) return { ok: false, reason: 'not_found' }
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', current: cur }
    const rev = cur.rev + 1
    db.prepare(`UPDATE osm_releases SET tab_id = ?, status_id = ?, test_date = ?, release_date = ?, content = ?, sql_text = ?, result_text = ?,
      updated_by = ?, updated_at = ?, rev = ? WHERE id = ?`)
      .run(input.tabId, input.statusId, input.testDate, input.releaseDate, input.content, input.sqlText, input.resultText, actor, now, rev, id)
    writeValues(db, id, input.values)
    db.prepare('INSERT INTO osm_release_revisions (release_id, rev, action, actor, at, snapshot) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, rev, 'update', actor, now, snapshot(db, id))
    return { ok: true, rev }
  }).immediate()
}

/** 軟刪除：留著修改履歷，誤刪查得回來 */
export function deleteRelease(db: DB, id: number, expectedRev: number, actor: string, now = Date.now()): UpdateResult {
  return db.transaction((): UpdateResult => {
    const cur = getRelease(db, id)
    if (!cur) return { ok: false, reason: 'not_found' }
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', current: cur }
    const rev = cur.rev + 1
    db.prepare('UPDATE osm_releases SET deleted = 1, updated_by = ?, updated_at = ?, rev = ? WHERE id = ?').run(actor, now, rev, id)
    db.prepare('INSERT INTO osm_release_revisions (release_id, rev, action, actor, at, snapshot) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, rev, 'delete', actor, now, JSON.stringify(cur))
    return { ok: true, rev }
  }).immediate()
}

export function listRevisions(db: DB, id: number) {
  return (db.prepare('SELECT rev, action, actor, at, snapshot FROM osm_release_revisions WHERE release_id = ? ORDER BY rev DESC').all(id) as Record<string, unknown>[])
    .map(r => ({ rev: Number(r.rev), action: String(r.action), actor: String(r.actor), at: Number(r.at), snapshot: JSON.parse(String(r.snapshot)) as ReleaseRow | null }))
}

// ─── 設定（分頁／元件／狀態）──────────────────────────────────────────────────

export function upsertTab(db: DB, t: { id: string; name: string; showComponents: boolean; showSql: boolean; showResult: boolean; active?: boolean; sort?: number }) {
  const exists = db.prepare('SELECT 1 FROM osm_release_tabs WHERE id = ?').get(t.id)
  const sort = t.sort ?? ((db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM osm_release_tabs').get() as { m: number }).m + 1)
  if (exists) {
    db.prepare('UPDATE osm_release_tabs SET name = ?, show_components = ?, show_sql = ?, show_result = ?, active = COALESCE(?, active), sort = COALESCE(?, sort) WHERE id = ?')
      .run(t.name, t.showComponents ? 1 : 0, t.showSql ? 1 : 0, t.showResult ? 1 : 0, t.active == null ? null : t.active ? 1 : 0, t.sort ?? null, t.id)
  } else {
    db.prepare('INSERT INTO osm_release_tabs (id, name, sort, show_components, show_sql, show_result, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.name, sort, t.showComponents ? 1 : 0, t.showSql ? 1 : 0, t.showResult ? 1 : 0, t.active === false ? 0 : 1)
  }
}

export function addComponent(db: DB, c: { tabId: string; name: string; groupName?: string }): number {
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM osm_release_components WHERE tab_id = ?').get(c.tabId) as { m: number }).m + 1
  return Number(db.prepare('INSERT INTO osm_release_components (tab_id, name, group_name, sort) VALUES (?, ?, ?, ?)').run(c.tabId, c.name.trim(), (c.groupName ?? '').trim(), sort).lastInsertRowid)
}

export function updateComponent(db: DB, id: number, p: { name?: string; groupName?: string; active?: boolean }) {
  db.prepare('UPDATE osm_release_components SET name = COALESCE(?, name), group_name = COALESCE(?, group_name), active = COALESCE(?, active) WHERE id = ?')
    .run(p.name?.trim() ?? null, p.groupName?.trim() ?? null, p.active == null ? null : p.active ? 1 : 0, id)
}

/** 已被紀錄用過的元件不能刪，只能停用（舊紀錄還要讀得到）；沒用過的可以真的刪掉 */
export function deleteComponent(db: DB, id: number): { ok: boolean; message?: string } {
  const used = (db.prepare(`SELECT COUNT(*) c FROM osm_release_values v JOIN osm_releases r ON r.id = v.release_id WHERE v.component_id = ? AND r.deleted = 0`).get(id) as { c: number }).c
  if (used) return { ok: false, message: `這個元件已被 ${used} 筆紀錄使用，只能停用` }
  db.prepare('DELETE FROM osm_release_components WHERE id = ?').run(id)
  return { ok: true }
}

export function reorder(db: DB, table: 'osm_release_tabs' | 'osm_release_components' | 'osm_release_statuses', ids: (string | number)[]) {
  const upd = db.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?`)
  db.transaction(() => { ids.forEach((id, i) => upd.run(i + 1, id)) })()
}

export function addStatus(db: DB, s: { name: string; tone?: string }): number {
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM osm_release_statuses').get() as { m: number }).m + 1
  return Number(db.prepare('INSERT INTO osm_release_statuses (name, tone, sort) VALUES (?, ?, ?)').run(s.name.trim(), s.tone ?? 'other', sort).lastInsertRowid)
}

export function updateStatus(db: DB, id: number, p: { name?: string; tone?: string; active?: boolean }) {
  db.prepare('UPDATE osm_release_statuses SET name = COALESCE(?, name), tone = COALESCE(?, tone), active = COALESCE(?, active) WHERE id = ?')
    .run(p.name?.trim() ?? null, p.tone ?? null, p.active == null ? null : p.active ? 1 : 0, id)
}

// ─── 個人檢視 ──────────────────────────────────────────────────────────────────

export function listViews(db: DB, owner: string) {
  return (db.prepare('SELECT id, name, filters FROM osm_release_views WHERE owner_email = ? ORDER BY id').all(owner.toLowerCase()) as { id: number; name: string; filters: string }[])
    .map(v => ({ id: v.id, name: v.name, filters: JSON.parse(v.filters) as Record<string, unknown> }))
}
export function saveView(db: DB, owner: string, name: string, filters: Record<string, unknown>): number {
  return Number(db.prepare('INSERT INTO osm_release_views (owner_email, name, filters, created_at) VALUES (?, ?, ?, ?)').run(owner.toLowerCase(), name.trim(), JSON.stringify(filters), Date.now()).lastInsertRowid)
}
export function deleteView(db: DB, owner: string, id: number): boolean {
  return db.prepare('DELETE FROM osm_release_views WHERE id = ? AND owner_email = ?').run(id, owner.toLowerCase()).changes > 0
}

/**
 * 角色管理（v5.9.0，使用者 2026-10-05；版面 CodeX 設計、使用者看樣稿確認）。
 *
 * 角色＝一組可見功能。原本角色寫死 qa／pm／other（＋固定的 admin），現在可以自建。
 * - **admin 不在這張表**：固定、永遠全開、不能改不能刪（避免把自己鎖在系統外），由程式特判
 * - qa／pm／other 是 `builtin`：這一版不能改名、不能刪，但可見功能能改。`builtin` 只是「這版鎖住」，不是永久不可刪（CodeX）
 * - 自建角色的 key 是產生的（`r_xxxx`），**改名只改 label、key 不變**——帳號與 role_permissions 都靠 key 對應，改 key 等於全部斷線
 * - 刪除使用中的角色 → 擋下並列出帳號（使用者決定），不自動改到別的角色
 * - 一個帳號一個角色（使用者決定）。舊資料有逗號多角色（`pm,qa`）的，權限照舊取聯集，直到管理員在帳號管理選定一個
 *
 * 純函式（傳入 db），測試：npx tsx server/role-store.test.ts
 */
import type Database from 'better-sqlite3'

type DB = Database.Database

export interface RoleRow { key: string; label: string; color: string; builtin: number; created_at: number }

export const ADMIN_ROLE = 'admin'
const BUILTIN: Array<Pick<RoleRow, 'key' | 'label' | 'color'>> = [
  { key: 'qa', label: 'QA', color: '#0284c7' },
  { key: 'pm', label: 'PM', color: '#0052cc' },
  { key: 'other', label: 'Other', color: '#64748b' },
]
const COLOR_RE = /^#[0-9a-f]{6}$/i

export function initRoles(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS roles (
    key        TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    color      TEXT NOT NULL,
    builtin    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`)
  const ins = db.prepare('INSERT OR IGNORE INTO roles (key, label, color, builtin, created_at) VALUES (?, ?, ?, 1, ?)')
  for (const r of BUILTIN) ins.run(r.key, r.label, r.color, Date.now())
}

export const listRoles = (db: DB): RoleRow[] =>
  db.prepare('SELECT key, label, color, builtin, created_at FROM roles ORDER BY builtin DESC, created_at ASC').all() as RoleRow[]

/** 可以指派給帳號的角色（不含 admin——admin 不能透過一般指派產生） */
export const roleExists = (db: DB, key: string): boolean =>
  !!db.prepare('SELECT 1 FROM roles WHERE key = ?').get(key)

/** 帳號 role 欄可能是舊的逗號多角色；拆成一個一個 key */
export const roleParts = (role: string): string[] => String(role ?? '').split(',').map(s => s.trim()).filter(Boolean)
export const isMultiRole = (role: string) => roleParts(role).length > 1
/** 帳號是不是管理員（含舊的逗號多角色裡有 admin 的） */
export const isAdminRole = (role: string | undefined | null) => roleParts(String(role ?? '')).includes(ADMIN_ROLE)

/**
 * 管理員帳號不能被刪除、改角色、停用（CodeX review v5.9.0 P1：舊 API 與管理頁都只驗呼叫者、沒保護目標，
 * 操作唯一的管理員會讓整個系統失去管理入口）。回傳錯誤訊息；null＝可以。
 * next 沒帶的欄位＝不改。
 */
export function adminTargetError(current: { role?: string | null; status?: string | null } | undefined, next: { delete?: boolean; role?: string; status?: string }): string | null {
  if (!current || !isAdminRole(current.role)) return null
  if (next.delete) return '管理員帳號不能刪除'
  if (next.role !== undefined && next.role !== current.role) return '管理員帳號的角色不能更改'
  if (next.status !== undefined && next.status !== (current.status ?? 'active') && next.status !== 'active') return '管理員帳號不能停用'
  return null
}

/**
 * 指派角色：「角色存在」的檢查跟寫入包在同一個 immediate transaction（CodeX review P2）。
 * 不然另一個 process（server／worker 共用 data.db）可能在檢查完、寫入前把角色刪掉，留下指向不存在角色的帳號。
 * immediate＝一開始就拿寫鎖，刪除那邊同樣用 immediate，兩邊只能一前一後。
 */
export function withAssignableRole<T>(db: DB, role: string, write: () => T): { ok: true; value: T } | { ok: false; message: string } {
  return db.transaction((): { ok: true; value: T } | { ok: false; message: string } => {
    if (role === ADMIN_ROLE || !roleExists(db, role)) return { ok: false, message: '沒有這個角色' }
    return { ok: true, value: write() }
  }).immediate()
}

/** 用了這個角色的帳號（含舊的多角色帳號裡有它的） */
export function usersOfRole(accounts: Array<{ email: string; role: string }>, key: string): string[] {
  return accounts.filter(a => roleParts(a.role).includes(key)).map(a => a.email)
}

export type RoleError = { ok: false; code: 'NOT_FOUND' | 'BUILTIN' | 'ADMIN' | 'BAD_LABEL' | 'DUP_LABEL' | 'BAD_COLOR' | 'IN_USE'; message: string; users?: string[] }

function checkLabel(db: DB, label: string, exceptKey?: string): RoleError | null {
  const l = label.trim()
  if (!l || l.length > 20) return { ok: false, code: 'BAD_LABEL', message: '角色名稱要 1～20 個字' }
  const taken = listRoles(db).some(r => r.key !== exceptKey && r.label.trim().toLowerCase() === l.toLowerCase()) || ['管理員', 'admin'].includes(l.toLowerCase())
  return taken ? { ok: false, code: 'DUP_LABEL', message: `已經有叫「${l}」的角色` } : null
}

export function createRole(db: DB, p: { label: string; color: string }): { ok: true; role: RoleRow } | RoleError {
  const bad = checkLabel(db, p.label)
  if (bad) return bad
  if (!COLOR_RE.test(p.color)) return { ok: false, code: 'BAD_COLOR', message: '顏色格式要是 #rrggbb' }
  let key = ''
  do key = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  while (roleExists(db, key))
  const role = { key, label: p.label.trim(), color: p.color.toLowerCase(), builtin: 0, created_at: Date.now() }
  db.prepare('INSERT INTO roles (key, label, color, builtin, created_at) VALUES (@key, @label, @color, @builtin, @created_at)').run(role)
  return { ok: true, role }
}

export function updateRole(db: DB, key: string, p: { label?: string; color?: string }): { ok: true } | RoleError {
  if (key === ADMIN_ROLE) return { ok: false, code: 'ADMIN', message: '管理員固定，不能修改' }
  const row = db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as RoleRow | undefined
  if (!row) return { ok: false, code: 'NOT_FOUND', message: '找不到這個角色' }
  if (p.label !== undefined && p.label.trim() !== row.label) {
    if (row.builtin) return { ok: false, code: 'BUILTIN', message: '內建角色這一版不能改名' }
    const bad = checkLabel(db, p.label, key)
    if (bad) return bad
  }
  if (p.color !== undefined && !COLOR_RE.test(p.color)) return { ok: false, code: 'BAD_COLOR', message: '顏色格式要是 #rrggbb' }
  db.prepare('UPDATE roles SET label = ?, color = ? WHERE key = ?').run(p.label?.trim() ?? row.label, p.color?.toLowerCase() ?? row.color, key)
  return { ok: true }
}

/** 刪除：使用中的擋下並列出帳號；同時清掉它的權限列（不留孤兒資料） */
export function deleteRole(db: DB, key: string): { ok: true } | RoleError {
  if (key === ADMIN_ROLE) return { ok: false, code: 'ADMIN', message: '管理員固定，不能刪除' }
  const row = db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as RoleRow | undefined
  if (!row) return { ok: false, code: 'NOT_FOUND', message: '找不到這個角色' }
  if (row.builtin) return { ok: false, code: 'BUILTIN', message: '內建角色這一版不能刪除' }
  // 讀帳號、檢查、刪除全在同一個 immediate transaction（CodeX review P2：原本檢查的是外面傳進來的帳號快照，
  // 讀完到刪之間另一個 process 指派了這個角色，就會留下指向不存在角色的帳號）
  return db.transaction((): { ok: true } | RoleError => {
    const accounts = db.prepare('SELECT email, role FROM jira_accounts').all() as Array<{ email: string; role: string }>
    const users = usersOfRole(accounts, key)
    if (users.length) return { ok: false, code: 'IN_USE', message: `還有 ${users.length} 個帳號在用這個角色，先把他們改到別的角色`, users }
    db.prepare('DELETE FROM role_permissions WHERE role = ?').run(key)
    db.prepare('DELETE FROM roles WHERE key = ?').run(key)
    return { ok: true }
  }).immediate()
}

/** 一個角色在每個功能 key 上的開關（沒列到的＝關） */
export function rolePermissionMap(db: DB, key: string, allKeys: readonly string[]): Record<string, boolean> {
  const rows = db.prepare('SELECT page_key, allowed FROM role_permissions WHERE role = ?').all(key) as { page_key: string; allowed: number }[]
  const on = new Set(rows.filter(r => r.allowed === 1).map(r => r.page_key))
  return Object.fromEntries(allKeys.map(k => [k, on.has(k)]))
}

/** 整組覆寫一個角色的可見功能。不認得的 key 擋下（靜默忽略會讓人以為設好了） */
export function setRolePermissions(db: DB, key: string, perms: Record<string, boolean>, allKeys: readonly string[]): { ok: true } | RoleError | { ok: false; code: 'BAD_KEY'; message: string } {
  if (key === ADMIN_ROLE) return { ok: false, code: 'ADMIN', message: '管理員永遠全開，不能修改' }
  if (!roleExists(db, key)) return { ok: false, code: 'NOT_FOUND', message: '找不到這個角色' }
  const known = new Set(allKeys)
  const bad = Object.keys(perms).filter(k => !known.has(k))
  if (bad.length) return { ok: false, code: 'BAD_KEY', message: `不支援的權限 key：${bad.join(', ')}` }
  const up = db.prepare('INSERT OR REPLACE INTO role_permissions (role, page_key, allowed) VALUES (?, ?, ?)')
  db.transaction(() => { for (const k of allKeys) up.run(key, k, perms[k] ? 1 : 0) })()
  return { ok: true }
}

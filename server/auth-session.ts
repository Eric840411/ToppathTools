import { createHash, randomBytes } from 'crypto'
import type { Request, Response } from 'express'
import { db, readAccounts, recordLoginDay } from './shared.js'

const AUTH_COOKIE = 'toppath_auth'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

type AuthSession = {
  email: string
  createdAt: number
  expiresAt: number
}

/**
 * DB 只存 sid 的 sha256（資安審查 2026-10-19）：原本存原值，拿到一份 DB 就能直接接管所有登入中的 session。
 * cookie 裡仍是原值；查詢時先雜湊再查。記憶體快取的 key 也用雜湊，跟 DB 一致。
 */
export const hashSid = (sid: string) => createHash('sha256').update(sid).digest('hex')

// In-memory cache (sidHash → session), backed by SQLite for persistence across restarts
const sessions = new Map<string, AuthSession>()

// 舊資料（原值 sid，48 字元 hex）原地換成雜湊（64 字元）——使用者 cookie 不變、不會被登出。
// server／worker 都會載入這支：immediate transaction ＋ 長度判斷，後到的什麼都不改
// kind：'user'＝真的登入；'internal'＝伺服器代跑（UAT 排程）用的短效 session。
// 「這個人有沒有在 7 天內登入」只能看 user——代跑 session 也算的話，併行排程會互相延長對方的代跑資格，
// 使用者登出後排程還會一直跑（CodeX 審 e621df1 [P2]）
try {
  const cols = db.prepare('PRAGMA table_info(auth_sessions)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'kind')) db.exec(`ALTER TABLE auth_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'`)
} catch (e) {
  // server／worker 同時啟動時另一邊可能剛加完欄位
  if (!String(e).includes('duplicate column')) throw e
}

db.transaction(() => {
  const legacy = db.prepare('SELECT sid FROM auth_sessions WHERE length(sid) <> 64').all() as { sid: string }[]
  const upd = db.prepare('UPDATE auth_sessions SET sid = ? WHERE sid = ?')
  for (const r of legacy) upd.run(hashSid(r.sid), r.sid)
}).immediate()

// Load all non-expired sessions from DB on startup
{
  const rows = db.prepare('SELECT sid, email, created_at, expires_at FROM auth_sessions WHERE expires_at > ?').all(Date.now()) as { sid: string; email: string; created_at: number; expires_at: number }[]
  for (const row of rows) {
    sessions.set(row.sid, { email: row.email, createdAt: row.created_at, expiresAt: row.expires_at })
  }
  // Clean up expired rows
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now())
}

/** 正式環境走 https（nginx 帶 X-Forwarded-Proto）時 cookie 加 Secure；本機 http 開發不加，否則登不進去 */
function cookieFlags(req?: Request): string {
  const secure = !!req && (req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https')
  return `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const eq = part.indexOf('=')
        if (eq < 0) return [part, '']
        return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))]
      }),
  )
}

export function publicAccount(email: string) {
  const account = readAccounts().find(a => a.email === email)
  if (!account) return null
  return {
    email: account.email,
    label: account.label,
    role: account.role,
    hasPIN: !!account.pin_hash,
  }
}

export function getAuthSession(req: Request): AuthSession | null {
  const raw = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  if (!raw) return null
  const sid = hashSid(raw)
  let session = sessions.get(sid)
  // 記憶體有也要確認 DB 還在：server 與 worker 各有一份 sessions，一邊登出／清掉時另一邊的記憶體不會知道。
  // DB 才是唯一的真相（主鍵查詢，成本可忽略）
  if (session && !db.prepare('SELECT 1 FROM auth_sessions WHERE sid = ?').get(sid)) {
    sessions.delete(sid)
    return null
  }
  if (!session) {
    // Fallback: check DB (handles cache miss after hot reload)
    const row = db.prepare('SELECT email, created_at, expires_at FROM auth_sessions WHERE sid = ?').get(sid) as { email: string; created_at: number; expires_at: number } | undefined
    if (!row) return null
    session = { email: row.email, createdAt: row.created_at, expiresAt: row.expires_at }
    sessions.set(sid, session)
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sid)
    db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid)
    return null
  }
  return session
}

export function getAuthAccount(req: Request) {
  const session = getAuthSession(req)
  return session ? publicAccount(session.email) : null
}

/** 在冊的 session（Dashboard 計數用）。讀 DB 不讀記憶體：記憶體只是快取，另一支 process 刪掉的這裡看不到。 */
export function getActiveAuthSessions() {
  const ts = Date.now()
  for (const [sid, session] of sessions.entries()) {
    if (session.expiresAt <= ts) sessions.delete(sid)
  }
  const rows = db.prepare("SELECT sid, email, created_at, expires_at FROM auth_sessions WHERE expires_at > ? AND kind = 'user'").all(ts) as { sid: string; email: string; created_at: number; expires_at: number }[]
  return rows.map(r => ({ sid: r.sid, email: r.email, createdAt: r.created_at, expiresAt: r.expires_at }))
}

function insertSession(email: string, ttlMs: number, kind: 'user' | 'internal' = 'user'): string {
  const raw = randomBytes(24).toString('hex')
  const now = Date.now()
  const expiresAt = now + ttlMs
  const sid = hashSid(raw)
  sessions.set(sid, { email, createdAt: now, expiresAt })
  db.prepare('INSERT OR REPLACE INTO auth_sessions (sid, email, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?)').run(sid, email, now, expiresAt, kind)
  return raw
}

export function createAuthSession(email: string, res: Response, req?: Request) {
  const raw = insertSession(email, SESSION_TTL_MS)
  recordLoginDay(email)
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(raw)}; ${cookieFlags(req)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  )
}

/** 這個帳號有沒有還沒過期的登入（UAT 排程用「7 天內登入過」當作同意代跑的依據） */
export function hasLiveSession(email: string): boolean {
  return !!db.prepare("SELECT 1 FROM auth_sessions WHERE email = ? AND expires_at > ? AND kind = 'user'").get(email, Date.now())
}

/**
 * 伺服器內部代某人打 API 用的短效 session，回傳 cookie 用的原值；用完呼叫 revokeSessionByRaw。
 * 原本 UAT 排程直接從 DB 讀那個人的 sid 拿來當 cookie——sid 改存雜湊後讀不到原值，改成現發一張。
 */
export function mintInternalSession(email: string, ttlMs: number): string {
  return insertSession(email, ttlMs, 'internal')
}

export function revokeSessionByRaw(raw: string) {
  const sid = hashSid(raw)
  sessions.delete(sid)
  db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid)
}

/** 登出：刪掉這個 session（DB＋記憶體），不是只清 cookie——只清 cookie 的話 session 會一直算在冊直到 7 天過期。 */
export function revokeAuthSession(req: Request, res: Response) {
  const raw = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  if (raw) revokeSessionByRaw(raw)
  clearAuthSession(res, req)
}

/** 清掉呼叫者自己帳號的其他 session，保留目前這個。只動自己的帳號。回傳清掉幾個；沒登入回 null。 */
export function pruneOtherAuthSessions(req: Request): { email: string; removed: number } | null {
  const raw = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  const session = raw ? getAuthSession(req) : null
  if (!raw || !session) return null
  const sid = hashSid(raw)
  const removed = db.prepare('DELETE FROM auth_sessions WHERE email = ? AND sid != ?').run(session.email, sid).changes
  for (const [k, v] of sessions.entries()) if (v.email === session.email && k !== sid) sessions.delete(k)
  return { email: session.email, removed }
}

export function clearAuthSession(res: Response, req?: Request) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; ${cookieFlags(req)}; Max-Age=0`)
}

/** 共用設定（全站 AI key、prompt、告警 webhook…）的寫入只給管理員（資安審查 2026-10-19） */
export function requireAdminMw(req: Request, res: Response, next: () => void) {
  const account = getAuthAccount(req)
  if (!account || account.role !== 'admin') {
    res.status(403).json({ ok: false, message: '只有管理員可以修改這個共用設定' })
    return
  }
  next()
}

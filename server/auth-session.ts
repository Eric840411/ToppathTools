import { randomBytes } from 'crypto'
import type { Request, Response } from 'express'
import { db, readAccounts, recordLoginDay } from './shared.js'

const AUTH_COOKIE = 'toppath_auth'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

type AuthSession = {
  email: string
  createdAt: number
  expiresAt: number
}

// In-memory cache (sid → session), backed by SQLite for persistence across restarts
const sessions = new Map<string, AuthSession>()

// Load all non-expired sessions from DB on startup
{
  const rows = db.prepare('SELECT sid, email, created_at, expires_at FROM auth_sessions WHERE expires_at > ?').all(Date.now()) as { sid: string; email: string; created_at: number; expires_at: number }[]
  for (const row of rows) {
    sessions.set(row.sid, { email: row.email, createdAt: row.created_at, expiresAt: row.expires_at })
  }
  // Clean up expired rows
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now())
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
  const sid = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  if (!sid) return null
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
  const rows = db.prepare('SELECT sid, email, created_at, expires_at FROM auth_sessions WHERE expires_at > ?').all(ts) as { sid: string; email: string; created_at: number; expires_at: number }[]
  return rows.map(r => ({ sid: r.sid, email: r.email, createdAt: r.created_at, expiresAt: r.expires_at }))
}

export function createAuthSession(email: string, res: Response) {
  const sid = randomBytes(24).toString('hex')
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  const session: AuthSession = { email, createdAt: now, expiresAt }
  sessions.set(sid, session)
  db.prepare('INSERT OR REPLACE INTO auth_sessions (sid, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sid, email, now, expiresAt)
  recordLoginDay(email)
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  )
}

/** 登出：刪掉這個 session（DB＋記憶體），不是只清 cookie——只清 cookie 的話 session 會一直算在冊直到 7 天過期。 */
export function revokeAuthSession(req: Request, res: Response) {
  const sid = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  if (sid) {
    sessions.delete(sid)
    db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid)
  }
  clearAuthSession(res)
}

/** 清掉呼叫者自己帳號的其他 session，保留目前這個。只動自己的帳號。回傳清掉幾個；沒登入回 null。 */
export function pruneOtherAuthSessions(req: Request): { email: string; removed: number } | null {
  const sid = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  const session = sid ? getAuthSession(req) : null
  if (!sid || !session) return null
  const removed = db.prepare('DELETE FROM auth_sessions WHERE email = ? AND sid != ?').run(session.email, sid).changes
  for (const [k, v] of sessions.entries()) if (v.email === session.email && k !== sid) sessions.delete(k)
  return { email: session.email, removed }
}

export function clearAuthSession(res: Response) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

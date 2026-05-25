import { randomBytes } from 'crypto'
import type { Request, Response } from 'express'
import { db, readAccounts } from './shared.js'

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

export function getActiveAuthSessions() {
  const ts = Date.now()
  for (const [sid, session] of sessions.entries()) {
    if (session.expiresAt <= ts) sessions.delete(sid)
  }
  return [...sessions.entries()].map(([sid, session]) => ({
    sid,
    email: session.email,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  }))
}

export function createAuthSession(email: string, res: Response) {
  const sid = randomBytes(24).toString('hex')
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  const session: AuthSession = { email, createdAt: now, expiresAt }
  sessions.set(sid, session)
  db.prepare('INSERT OR REPLACE INTO auth_sessions (sid, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sid, email, now, expiresAt)
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  )
}

export function clearAuthSession(res: Response) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

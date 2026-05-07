import { randomBytes } from 'crypto'
import type { Request, Response } from 'express'
import { readAccounts } from './shared.js'

const AUTH_COOKIE = 'toppath_auth'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

type AuthSession = {
  email: string
  createdAt: number
  expiresAt: number
}

const sessions = new Map<string, AuthSession>()

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
  const session = sessions.get(sid)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sid)
    return null
  }
  return session
}

export function getAuthAccount(req: Request) {
  const session = getAuthSession(req)
  return session ? publicAccount(session.email) : null
}

export function createAuthSession(email: string, res: Response) {
  const sid = randomBytes(24).toString('hex')
  sessions.set(sid, {
    email,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  })
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  )
}

export function clearAuthSession(res: Response) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

/**
 * 驗證腳本要用登入身分打 API 時，現發一張短效 session。
 *
 * v5.66.0 起 auth_sessions 只存 sid 的 sha256（資安審查 2026-10-19）——原本腳本「從 DB 借最近一個人的 sid
 * 當 cookie」的寫法，跟攻擊者拿到 DB 接管 session 是同一招，改版後借不到了。
 *
 * mintDevSession(db, email?)：email 省略＝最近登入的那個人（跟原本借 sid 的對象一樣）。
 * 找不到任何登入中的人時回 undefined（跟原本 `.get()` 查不到一樣），呼叫端原本怎麼處理就怎麼處理。
 */
import { createHash, randomBytes } from 'crypto'

export const devSidHash = sid => createHash('sha256').update(String(sid)).digest('hex')

export function mintDevSession(db, email = null, ttlMs = 2 * 3600_000) {
  const who = email ?? db.prepare('SELECT email FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())?.email
  if (!who) return undefined
  if (!db.prepare('SELECT 1 FROM auth_sessions WHERE email = ? AND expires_at > ?').get(who, Date.now())) return undefined
  const sid = randomBytes(24).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO auth_sessions (sid, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(devSidHash(sid), who, now, now + ttlMs)
  return { sid }
}

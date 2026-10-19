/**
 * 登入 PIN 的雜湊與驗證（資安審查 2026-10-19）。
 *
 * 原本是 `sha256(pin)` 不加鹽：PIN 很短，拿到 DB 幾毫秒就能全部試出來。
 *
 * 格式：`scrypt$<saltB64>$<hashB64>`，內容是 `scrypt(sha256hex(pin), salt)`。
 * 先 sha256 再 scrypt 的原因：舊資料只有 sha256hex，**不用等使用者重新登入**，
 * 啟動時就能把每一筆舊雜湊原地包成 scrypt（upgradeLegacyPinHashes）——包完之後
 * 跟新設定的 PIN 是同一種格式，驗證只有一條路。
 *
 * 比對一律 timingSafeEqual。另外有「同一帳號連錯 N 次鎖一段時間」，擋線上猜 PIN
 * （loginLimiter 是依 IP，換 IP 就繞過了）。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import type Database from 'better-sqlite3'

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }
const KEYLEN = 32

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')

function wrap(legacyHex: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(legacyHex, salt, KEYLEN, SCRYPT_PARAMS)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function isLegacyPinHash(stored: unknown): boolean {
  return typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored)
}

export function hashPin(pin: string): string {
  return wrap(sha256hex(pin))
}

export function verifyPin(stored: string | null | undefined, pin: string): boolean {
  if (!stored) return false
  const legacy = sha256hex(pin)
  if (isLegacyPinHash(stored)) {
    // 還沒被升級的舊雜湊（升級跑之前的空窗）：一樣用常數時間比
    return timingSafeEqual(Buffer.from(legacy), Buffer.from(stored))
  }
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'base64')
  const want = Buffer.from(parts[2], 'base64')
  const got = scryptSync(legacy, salt, want.length || KEYLEN, SCRYPT_PARAMS)
  return got.length === want.length && timingSafeEqual(got, want)
}

/** 啟動時把 jira_accounts.pin_hash 裡的舊 sha256 雜湊原地包成 scrypt。冪等。 */
export function upgradeLegacyPinHashes(db: Database.Database): number {
  const rows = db.prepare(`SELECT email, pin_hash FROM jira_accounts WHERE pin_hash IS NOT NULL AND pin_hash <> ''`).all() as { email: string; pin_hash: string }[]
  const upd = db.prepare('UPDATE jira_accounts SET pin_hash = ? WHERE email = ? AND pin_hash = ?')
  let n = 0
  db.transaction(() => {
    for (const r of rows) if (isLegacyPinHash(r.pin_hash)) n += upd.run(wrap(r.pin_hash), r.email, r.pin_hash).changes
  }).immediate()
  return n
}

/** 常數時間比對兩個字串（ADMIN_PIN 這類）。長度不同直接 false，但仍做一次比較避免太早返回。 */
export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(sha256hex(a))
  const bb = Buffer.from(sha256hex(b))
  return timingSafeEqual(ab, bb) && a.length === b.length
}

// ─── 依帳號的錯誤次數鎖定 ──────────────────────────────────────────────────────
const MAX_FAILS = 5
const LOCK_MS = 5 * 60_000
const failures = new Map<string, { count: number; lockedUntil: number }>()

/** 被鎖住時回剩餘秒數，否則 0。 */
export function pinLockRemaining(key: string, now = Date.now()): number {
  const f = failures.get(key.toLowerCase())
  if (!f || f.lockedUntil <= now) return 0
  return Math.ceil((f.lockedUntil - now) / 1000)
}

export function recordPinFailure(key: string, now = Date.now()): void {
  const k = key.toLowerCase()
  const f = failures.get(k) ?? { count: 0, lockedUntil: 0 }
  if (f.lockedUntil && f.lockedUntil <= now) { f.count = 0; f.lockedUntil = 0 }
  f.count += 1
  if (f.count >= MAX_FAILS) { f.lockedUntil = now + LOCK_MS; f.count = 0 }
  failures.set(k, f)
}

export function recordPinSuccess(key: string): void {
  failures.delete(key.toLowerCase())
}

/** 測試用 */
export function _resetPinFailures() { failures.clear() }

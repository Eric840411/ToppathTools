/**
 * Meegle 綁定的資料層與流程（綁定／重新驗證／解除）。
 *
 * 抽出來是為了能測**併發**：db 與「驗證 token」都從外面傳進來，測試用記憶體 DB 加上
 * 可以控制先後順序的假驗證，就能重現「驗證還在等 CLI 時，另一個分頁做了別的事」。
 *
 * ⚠️ 併發規則（CodeX review ff1fb71 抓到的三個 [P2]）：
 * 1. **修訂號（rev）用隨機 UUID、每次綁定或解除都換新**，而且解除後仍保留在 `meegle_account_revs`。
 *    原本用遞增的 token_version，「解除再重綁」會從 1 重新開始——舊的驗證結果剛好對得上新綁定，
 *    就把新綁定標成失效。
 * 2. **綁定在等 CLI 之前先記下 rev，提交時 rev 必須沒變**，否則放棄寫入。解除綁定也會換 rev，
 *    所以「換 token 途中另一個分頁解除」→ 舊請求回來寫不進去，憑證不會復活。
 * 3. **暫時性錯誤（連不上、逾時、看不懂）只記錄這次嘗試，不寫 status 欄**——
 *    不能拿讀取當下的舊狀態寫回去，那會蓋掉另一個請求剛寫的「已失效」。
 */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { VerifyTokenResult } from './meegle-cli.js'
import { decideIdentity, nextStatusAfterVerify, normEmail, type BindingStatus } from './meegle-binding-rules.js'

type DB = Database.Database

export function initMeegleSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meegle_accounts (
      email             TEXT PRIMARY KEY,   -- 工具登入 email（小寫）
      token_enc         TEXT NOT NULL,      -- AES-256-GCM 密文，金鑰在環境變數
      meegle_user_key   TEXT NOT NULL,
      meegle_email      TEXT NOT NULL DEFAULT '',
      meegle_name       TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL,      -- valid | invalid
      rev               TEXT,               -- 這筆綁定的修訂號（隨機 UUID）
      bound_at          INTEGER NOT NULL,
      last_verified_at  INTEGER,            -- 最後一次「驗證成功」
      last_checked_at   INTEGER,            -- 最後一次「嘗試驗證」（含失敗）
      last_check_code   TEXT,               -- 最後一次嘗試的錯誤碼；成功為 NULL
      last_check_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_meegle_accounts_user_key ON meegle_accounts(meegle_user_key);
    -- 每個 email 目前的修訂號；解除綁定後這列仍在，讓進行中的舊請求對不上
    CREATE TABLE IF NOT EXISTS meegle_account_revs (
      email TEXT PRIMARY KEY,
      rev   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meegle_identity_overrides (
      login_email     TEXT PRIMARY KEY,     -- 小寫
      meegle_user_key TEXT NOT NULL,
      note            TEXT NOT NULL DEFAULT '',
      created_by      TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
  `)
  // v4.262.0 的表用遞增 token_version，改成 rev（CodeX [P2]：版本號會在解除後重用）
  const cols = (db.prepare('PRAGMA table_info(meegle_accounts)').all() as { name: string }[]).map(c => c.name)
  if (!cols.includes('rev')) db.exec('ALTER TABLE meegle_accounts ADD COLUMN rev TEXT')
  if (cols.includes('token_version')) db.exec('ALTER TABLE meegle_accounts DROP COLUMN token_version')
  for (const r of db.prepare('SELECT email FROM meegle_accounts WHERE rev IS NULL').all() as { email: string }[]) {
    const rev = randomUUID()
    db.prepare('UPDATE meegle_accounts SET rev = ? WHERE email = ?').run(rev, r.email)
    db.prepare('INSERT OR REPLACE INTO meegle_account_revs (email, rev) VALUES (?, ?)').run(r.email, rev)
  }
}

export type AccountRow = {
  email: string; token_enc: string; meegle_user_key: string; meegle_email: string; meegle_name: string
  status: BindingStatus; rev: string; bound_at: number
  last_verified_at: number | null; last_checked_at: number | null; last_check_code: string | null; last_check_reason: string | null
}

export const getAccountRow = (db: DB, email: string) =>
  db.prepare('SELECT * FROM meegle_accounts WHERE email = ?').get(normEmail(email)) as AccountRow | undefined

const currentRev = (db: DB, email: string) =>
  (db.prepare('SELECT rev FROM meegle_account_revs WHERE email = ?').get(normEmail(email)) as { rev: string } | undefined)?.rev ?? null

const getOverride = (db: DB, email: string) =>
  (db.prepare('SELECT meegle_user_key FROM meegle_identity_overrides WHERE login_email = ?').get(normEmail(email)) as { meegle_user_key: string } | undefined)?.meegle_user_key ?? null

export type ServiceFail = { ok: false; code: string; message: string; extra?: Record<string, unknown> }

export type BindDeps = {
  verify: (token: string) => Promise<VerifyTokenResult>
  encrypt: (token: string) => string
  now?: () => number
}

/** 驗證並綁定（或更換）。驗證失敗、身分不符、或等待期間綁定狀態被改過，都不寫入。 */
export async function bindAccount(db: DB, loginEmail: string, token: string, deps: BindDeps):
  Promise<{ ok: true; row: AccountRow; via: 'email' | 'override' } | ServiceFail> {
  const email = normEmail(loginEmail)
  const revAtStart = currentRev(db, email)   // ← 等 CLI 之前先記下

  const result = await deps.verify(token)
  if ('code' in result) return { ok: false, code: result.code, message: result.reason }

  const decision = decideIdentity(loginEmail, result.identity, getOverride(db, email))
  if ('reason' in decision) {
    return { ok: false, code: 'IDENTITY_MISMATCH', message: decision.reason, extra: {
      meegleEmail: result.identity.email, meegleName: result.identity.name, meegleUserKey: result.identity.userKey,
    } }
  }

  const tokenEnc = deps.encrypt(token)
  const now = (deps.now ?? Date.now)()
  const newRev = randomUUID()
  const outcome = db.transaction((): ServiceFail | null => {
    if (currentRev(db, email) !== revAtStart) {
      return { ok: false, code: 'CONFLICT', message: '驗證期間綁定狀態被其他操作改過了（例如另一個分頁解除或更換），這次沒有寫入，請重新整理後再試' }
    }
    const taken = db.prepare('SELECT email FROM meegle_accounts WHERE meegle_user_key = ? AND email <> ?')
      .get(result.identity.userKey, email) as { email: string } | undefined
    if (taken) return { ok: false, code: 'ALREADY_BOUND_ELSEWHERE', message: `這個 Meegle 帳號已經綁在工具帳號 ${taken.email} 上。` }
    db.prepare(`
      INSERT INTO meegle_accounts (email, token_enc, meegle_user_key, meegle_email, meegle_name, status, rev, bound_at, last_verified_at, last_checked_at, last_check_code, last_check_reason)
      VALUES (@email, @token_enc, @user_key, @m_email, @m_name, 'valid', @rev, @now, @now, @now, NULL, NULL)
      ON CONFLICT(email) DO UPDATE SET
        token_enc = excluded.token_enc, meegle_user_key = excluded.meegle_user_key, meegle_email = excluded.meegle_email,
        meegle_name = excluded.meegle_name, status = 'valid', rev = excluded.rev, bound_at = excluded.bound_at,
        last_verified_at = excluded.last_verified_at, last_checked_at = excluded.last_checked_at, last_check_code = NULL, last_check_reason = NULL
    `).run({ email, token_enc: tokenEnc, user_key: result.identity.userKey, m_email: result.identity.email, m_name: result.identity.name, rev: newRev, now })
    db.prepare('INSERT OR REPLACE INTO meegle_account_revs (email, rev) VALUES (?, ?)').run(email, newRev)
    return null
  })()
  if (outcome) return outcome
  return { ok: true, row: getAccountRow(db, email)!, via: decision.via }
}

export type VerifyDeps = {
  verify: (token: string) => Promise<VerifyTokenResult>
  decrypt: (stored: string) => string
  now?: () => number
}

/**
 * 用已存的 token 重新驗證。
 * 等待期間綁定被換掉／解除 → 結果不寫。暫時性錯誤只記錄這次嘗試，不動 status。
 */
export async function verifyAccount(db: DB, loginEmail: string, deps: VerifyDeps): Promise<{ ok: true; row: AccountRow | undefined } | ServiceFail> {
  const email = normEmail(loginEmail)
  const row = getAccountRow(db, email)
  if (!row) return { ok: false, code: 'NOT_BOUND', message: '尚未綁定 Meegle' }
  const revAtStart = row.rev

  let status: BindingStatus | null   // null ＝ 這次結果不足以改狀態
  let code: string | null
  let reason: string | null = null
  let token: string | null = null
  try { token = deps.decrypt(row.token_enc) } catch { /* 金鑰換過／資料壞掉 */ }

  if (token === null) {
    status = 'invalid'; code = 'DECRYPT_FAILED'
    reason = '伺服器的加密金鑰已更換，這筆綁定解不開，請重新綁定'
  } else {
    const result = await deps.verify(token)
    const next = 'code' in result
      ? nextStatusAfterVerify(row.status, { ok: false, code: result.code }, row.meegle_user_key)
      : nextStatusAfterVerify(row.status, { ok: true, userKey: result.identity.userKey }, row.meegle_user_key)
    code = next.code
    // 只有「確定的結果」才寫狀態：成功、被拒、身分變了。其餘（連不上／逾時／看不懂）只記錄嘗試
    const decisive = code === null || code === 'TOKEN_INVALID' || code === 'IDENTITY_CHANGED'
    status = decisive ? next.status : null
    if ('code' in result) reason = result.reason
    else if (code === 'IDENTITY_CHANGED') reason = '這組 token 現在代表的 Meegle 帳號跟綁定時不同'
  }

  const now = (deps.now ?? Date.now)()
  // WHERE rev = ?：等待期間綁定被換掉或解除（rev 變了／列不見了），這次的結果屬於舊綁定，不寫
  if (status !== null) {
    db.prepare(`
      UPDATE meegle_accounts SET status = ?, last_checked_at = ?, last_check_code = ?, last_check_reason = ?,
        last_verified_at = CASE WHEN ? IS NULL THEN ? ELSE last_verified_at END
      WHERE email = ? AND rev = ?
    `).run(status, now, code, reason, code, now, email, revAtStart)
  } else {
    // 已經是失效的綁定不寫暫時性錯誤：不然「已失效」的原因會被換成「驗證逾時」，看不出為什麼失效
    db.prepare(`UPDATE meegle_accounts SET last_checked_at = ?, last_check_code = ?, last_check_reason = ? WHERE email = ? AND rev = ? AND status = 'valid'`)
      .run(now, code, reason, email, revAtStart)
  }
  return { ok: true, row: getAccountRow(db, email) }
}

/** 解除綁定。換一個新的 rev，讓進行中的綁定／驗證回來時寫不進去。 */
export function unbindAccount(db: DB, loginEmail: string): AccountRow | undefined {
  const email = normEmail(loginEmail)
  return db.transaction(() => {
    const row = getAccountRow(db, email)
    db.prepare('DELETE FROM meegle_accounts WHERE email = ?').run(email)
    db.prepare('INSERT OR REPLACE INTO meegle_account_revs (email, rev) VALUES (?, ?)').run(email, randomUUID())
    return row
  })()
}

/**
 * Meegle 個人 token 綁定（`/api/meegle/*`、`/api/admin/meegle-identity-overrides`）。
 *
 * 身分邊界跟 Jira 同一套：**只認登入 cookie**，只能綁／驗／解除自己的；管理員只能管「身分對照」，
 * 看不到也拿不到任何人的 token。token 只存密文（見 meegle-token-crypto.ts），任何回應都不回傳 token。
 *
 * 詳細設計與踩坑：docs/features/28-meegle.md
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { addHistory, db, getClientIP, log, writeLimiter } from '../shared.js'
import { verifyMeegleToken } from '../meegle-cli.js'
import { decryptMeegleToken, encryptMeegleToken, isMeegleKeyConfigured } from '../meegle-token-crypto.js'
import { decideIdentity, httpStatusFor, nextStatusAfterVerify, normEmail, type BindingStatus } from '../meegle-binding-rules.js'

export const router = Router()

db.exec(`
  CREATE TABLE IF NOT EXISTS meegle_accounts (
    email             TEXT PRIMARY KEY,   -- 工具登入 email（小寫）
    token_enc         TEXT NOT NULL,      -- AES-256-GCM 密文，金鑰在環境變數
    meegle_user_key   TEXT NOT NULL,
    meegle_email      TEXT NOT NULL DEFAULT '',
    meegle_name       TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL,      -- valid | invalid
    token_version     INTEGER NOT NULL,   -- 每次換 token +1；舊的驗證結果寫不進新 token
    bound_at          INTEGER NOT NULL,
    last_verified_at  INTEGER,            -- 最後一次「驗證成功」
    last_checked_at   INTEGER,            -- 最後一次「嘗試驗證」（含失敗）
    last_check_code   TEXT,               -- 最後一次嘗試的錯誤碼；成功為 NULL
    last_check_reason TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_meegle_accounts_user_key ON meegle_accounts(meegle_user_key);
  CREATE TABLE IF NOT EXISTS meegle_identity_overrides (
    login_email     TEXT PRIMARY KEY,     -- 小寫
    meegle_user_key TEXT NOT NULL,
    note            TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
`)

type AccountRow = {
  email: string; token_enc: string; meegle_user_key: string; meegle_email: string; meegle_name: string
  status: BindingStatus; token_version: number; bound_at: number
  last_verified_at: number | null; last_checked_at: number | null; last_check_code: string | null; last_check_reason: string | null
}

const getRow = (email: string) =>
  db.prepare('SELECT * FROM meegle_accounts WHERE email = ?').get(normEmail(email)) as AccountRow | undefined

const getOverride = (email: string) =>
  (db.prepare('SELECT meegle_user_key FROM meegle_identity_overrides WHERE login_email = ?').get(normEmail(email)) as { meegle_user_key: string } | undefined)?.meegle_user_key ?? null

/** 回給前端的綁定資訊——刻意列白名單，token_enc 永遠不出去。 */
function publicBinding(row: AccountRow | undefined) {
  if (!row) return null
  return {
    status: row.status,
    meegleName: row.meegle_name,
    meegleEmail: row.meegle_email,
    meegleUserKey: row.meegle_user_key,
    boundAt: row.bound_at,
    lastVerifiedAt: row.last_verified_at,
    lastCheckedAt: row.last_checked_at,
    lastCheckCode: row.last_check_code,
    lastCheckReason: row.last_check_reason,
  }
}

function fail(res: Response, code: string, message: string, extra: Record<string, unknown> = {}) {
  return res.status(httpStatusFor(code)).json({ ok: false, code, message, ...extra })
}

function requireLogin(req: Request, res: Response) {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, code: 'NOT_LOGGED_IN', message: '請先登入' }); return null }
  return account
}

// GET /api/meegle/account —— 自己的綁定狀態
router.get('/api/meegle/account', (req, res) => {
  const account = requireLogin(req, res)
  if (!account) return
  res.json({ ok: true, keyConfigured: isMeegleKeyConfigured(), loginEmail: account.email, binding: publicBinding(getRow(account.email)) })
})

// POST /api/meegle/account —— 驗證並綁定（或更換）自己的 token
// ⚠️ 驗證失敗時舊綁定完全不動（CodeX review）：貼錯一次不能把原本能用的綁定弄壞
router.post('/api/meegle/account', writeLimiter, async (req, res, next) => {
  try {
    const account = requireLogin(req, res)
    if (!account) return
    if (!isMeegleKeyConfigured()) return fail(res, 'KEY_NOT_CONFIGURED', '伺服器尚未設定 MEEGLE_TOKEN_KEY，暫時無法綁定。請聯絡管理員。')
    const { token } = z.object({ token: z.string().trim().min(1).max(4096) }).parse(req.body)

    // 型別縮小一律用 `in`：server 的 tsconfig 沒開 strictNullChecks，`x.ok` 判斷不會縮小聯集
    const result = await verifyMeegleToken(token)
    if ('code' in result) return fail(res, result.code, result.reason)

    const decision = decideIdentity(account.email, result.identity, getOverride(account.email))
    if ('reason' in decision) {
      log('warn', getClientIP(req), account.email, 'Meegle 綁定被拒（身分不符）', `meegle=${result.identity.email || '(無 email)'} user_key=${result.identity.userKey}`)
      return fail(res, 'IDENTITY_MISMATCH', decision.reason, {
        meegleEmail: result.identity.email, meegleName: result.identity.name, meegleUserKey: result.identity.userKey,
      })
    }

    const email = normEmail(account.email)
    const taken = db.prepare('SELECT email FROM meegle_accounts WHERE meegle_user_key = ? AND email <> ?')
      .get(result.identity.userKey, email) as { email: string } | undefined
    if (taken) {
      log('warn', getClientIP(req), account.email, 'Meegle 綁定被拒（已被其他帳號綁定）', `user_key=${result.identity.userKey} bound_by=${taken.email}`)
      return fail(res, 'ALREADY_BOUND_ELSEWHERE', `這個 Meegle 帳號已經綁在工具帳號 ${taken.email} 上。`)
    }

    const now = Date.now()
    const tokenEnc = encryptMeegleToken(token)
    db.transaction(() => {
      const prev = getRow(email)
      db.prepare(`
        INSERT INTO meegle_accounts (email, token_enc, meegle_user_key, meegle_email, meegle_name, status, token_version, bound_at, last_verified_at, last_checked_at, last_check_code, last_check_reason)
        VALUES (@email, @token_enc, @user_key, @m_email, @m_name, 'valid', @version, @now, @now, @now, NULL, NULL)
        ON CONFLICT(email) DO UPDATE SET
          token_enc = excluded.token_enc, meegle_user_key = excluded.meegle_user_key, meegle_email = excluded.meegle_email,
          meegle_name = excluded.meegle_name, status = 'valid', token_version = excluded.token_version, bound_at = excluded.bound_at,
          last_verified_at = excluded.last_verified_at, last_checked_at = excluded.last_checked_at, last_check_code = NULL, last_check_reason = NULL
      `).run({
        email, token_enc: tokenEnc, user_key: result.identity.userKey, m_email: result.identity.email,
        m_name: result.identity.name, version: (prev?.token_version ?? 0) + 1, now,
      })
    })()

    log('ok', getClientIP(req), account.email, 'Meegle 綁定', `user_key=${result.identity.userKey} via=${decision.via}`)
    addHistory('meegle-account', '綁定 Meegle', `${account.label}（${account.email}）→ Meegle ${result.identity.name || result.identity.userKey}`,
      { meegleUserKey: result.identity.userKey, meegleEmail: result.identity.email, via: decision.via })
    res.json({ ok: true, binding: publicBinding(getRow(email)) })
  } catch (error) { next(error) }
})

// POST /api/meegle/account/verify —— 用已存的 token 重新驗證
router.post('/api/meegle/account/verify', writeLimiter, async (req, res, next) => {
  try {
    const account = requireLogin(req, res)
    if (!account) return
    const email = normEmail(account.email)
    const row = getRow(email)
    if (!row) return fail(res, 'NOT_BOUND', '尚未綁定 Meegle')
    if (!isMeegleKeyConfigured()) return fail(res, 'KEY_NOT_CONFIGURED', '伺服器尚未設定 MEEGLE_TOKEN_KEY，暫時無法驗證。')

    const version = row.token_version
    let next_: { status: BindingStatus; code: string | null }
    let reason: string | null = null
    let token: string | null = null
    try { token = decryptMeegleToken(row.token_enc) } catch { /* 金鑰換過／資料壞掉 */ }

    if (token === null) {
      next_ = { status: 'invalid', code: 'DECRYPT_FAILED' }
      reason = '伺服器的加密金鑰已更換，這筆綁定解不開，請重新綁定'
    } else {
      const result = await verifyMeegleToken(token)
      if ('code' in result) {
        next_ = nextStatusAfterVerify(row.status, { ok: false, code: result.code }, row.meegle_user_key)
        reason = result.reason
      } else {
        next_ = nextStatusAfterVerify(row.status, { ok: true, userKey: result.identity.userKey }, row.meegle_user_key)
        if (next_.code === 'IDENTITY_CHANGED') reason = '這組 token 現在代表的 Meegle 帳號跟綁定時不同'
      }
    }

    const now = Date.now()
    // WHERE token_version = ?：驗證期間使用者換了 token 的話，這次的結果屬於舊 token，不能寫進去
    db.prepare(`
      UPDATE meegle_accounts SET status = ?, last_checked_at = ?, last_check_code = ?, last_check_reason = ?,
        last_verified_at = CASE WHEN ? IS NULL THEN ? ELSE last_verified_at END
      WHERE email = ? AND token_version = ?
    `).run(next_.status, now, next_.code, reason, next_.code, now, email, version)

    res.json({ ok: true, binding: publicBinding(getRow(email)) })
  } catch (error) { next(error) }
})

// DELETE /api/meegle/account —— 解除綁定（只刪本站存的 token；要作廢 token 得到 Meegle 按重置）
router.delete('/api/meegle/account', writeLimiter, (req, res) => {
  const account = requireLogin(req, res)
  if (!account) return
  const row = getRow(account.email)
  db.prepare('DELETE FROM meegle_accounts WHERE email = ?').run(normEmail(account.email))
  if (row) {
    log('ok', getClientIP(req), account.email, 'Meegle 解除綁定', `user_key=${row.meegle_user_key}`)
    addHistory('meegle-account', '解除 Meegle 綁定', `${account.label}（${account.email}）`, { meegleUserKey: row.meegle_user_key })
  }
  res.json({ ok: true, binding: null })
})

// ── 管理員：身分對照（登入 email 跟 Meegle email 不同的人用）──────────────────────────
function requireAdmin(req: Request, res: Response) {
  const account = getAuthAccount(req)
  if (!account || account.role !== 'admin') { res.status(403).json({ ok: false, message: '需要管理員權限' }); return null }
  return account
}

router.get('/api/admin/meegle-identity-overrides', (req, res) => {
  if (!requireAdmin(req, res)) return
  const overrides = db.prepare('SELECT login_email, meegle_user_key, note, created_by, created_at FROM meegle_identity_overrides ORDER BY login_email').all()
  // 綁定概況只給狀態，不給 token
  const bindings = db.prepare('SELECT email, meegle_name, meegle_email, meegle_user_key, status, last_verified_at, last_check_code FROM meegle_accounts ORDER BY email').all()
  res.json({ ok: true, overrides, bindings })
})

router.put('/api/admin/meegle-identity-overrides', writeLimiter, (req, res) => {
  const admin = requireAdmin(req, res)
  if (!admin) return
  const body = z.object({
    loginEmail: z.string().trim().min(1),
    meegleUserKey: z.string().trim().regex(/^\d+$/, 'Meegle user_key 是一串數字'),
    note: z.string().trim().max(200).optional(),
  }).parse(req.body)
  db.prepare(`
    INSERT INTO meegle_identity_overrides (login_email, meegle_user_key, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(login_email) DO UPDATE SET meegle_user_key = excluded.meegle_user_key, note = excluded.note, created_by = excluded.created_by, created_at = excluded.created_at
  `).run(normEmail(body.loginEmail), body.meegleUserKey, body.note ?? '', admin.email, Date.now())
  log('warn', getClientIP(req), admin.email, 'Meegle 身分對照設定', `${body.loginEmail} → ${body.meegleUserKey}`)
  addHistory('meegle-account', '設定 Meegle 身分對照', `${body.loginEmail} → ${body.meegleUserKey}`, body)
  res.json({ ok: true })
})

router.delete('/api/admin/meegle-identity-overrides/:loginEmail', writeLimiter, (req, res) => {
  const admin = requireAdmin(req, res)
  if (!admin) return
  const loginEmail = decodeURIComponent(String(req.params.loginEmail))
  db.prepare('DELETE FROM meegle_identity_overrides WHERE login_email = ?').run(normEmail(loginEmail))
  log('warn', getClientIP(req), admin.email, 'Meegle 身分對照刪除', loginEmail)
  addHistory('meegle-account', '刪除 Meegle 身分對照', loginEmail, { loginEmail })
  res.json({ ok: true })
})

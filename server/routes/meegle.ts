/**
 * Meegle 個人 token 綁定（`/api/meegle/*`、`/api/admin/meegle-identity-overrides`）。
 *
 * 身分邊界跟 Jira 同一套：**只認登入 cookie**，只能綁／驗／解除自己的；管理員只能管「身分對照」，
 * 看不到也拿不到任何人的 token。token 只存密文（見 meegle-token-crypto.ts），任何回應都不回傳 token。
 * 流程與併發規則在 meegle-account-service.ts（抽出去是為了能測競態）。
 *
 * 詳細設計與踩坑：docs/features/28-meegle.md
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { addHistory, db, getClientIP, log, writeLimiter } from '../shared.js'
import { verifyMeegleToken } from '../meegle-cli.js'
import { decryptMeegleToken, encryptMeegleToken, isMeegleKeyConfigured } from '../meegle-token-crypto.js'
import { httpStatusFor, normEmail } from '../meegle-binding-rules.js'
import { bindAccount, getAccountRow, initMeegleSchema, unbindAccount, verifyAccount, type AccountRow } from '../meegle-account-service.js'

export const router = Router()

initMeegleSchema(db)

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
  res.json({ ok: true, keyConfigured: isMeegleKeyConfigured(), loginEmail: account.email, binding: publicBinding(getAccountRow(db, account.email)) })
})

// POST /api/meegle/account —— 驗證並綁定（或更換）自己的 token
router.post('/api/meegle/account', writeLimiter, async (req, res, next) => {
  try {
    const account = requireLogin(req, res)
    if (!account) return
    if (!isMeegleKeyConfigured()) return fail(res, 'KEY_NOT_CONFIGURED', '伺服器尚未設定 MEEGLE_TOKEN_KEY，暫時無法綁定。請聯絡管理員。')
    const { token } = z.object({ token: z.string().trim().min(1).max(4096) }).parse(req.body)

    const r = await bindAccount(db, account.email, token, { verify: t => verifyMeegleToken(t), encrypt: t => encryptMeegleToken(t) })
    if ('code' in r) {
      if (r.code === 'IDENTITY_MISMATCH' || r.code === 'ALREADY_BOUND_ELSEWHERE') {
        log('warn', getClientIP(req), account.email, `Meegle 綁定被拒（${r.code}）`, JSON.stringify(r.extra ?? {}))
      }
      return fail(res, r.code, r.message, r.extra)
    }

    log('ok', getClientIP(req), account.email, 'Meegle 綁定', `user_key=${r.row.meegle_user_key} via=${r.via}`)
    addHistory('meegle-account', '綁定 Meegle', `${account.label}（${account.email}）→ Meegle ${r.row.meegle_name || r.row.meegle_user_key}`,
      { meegleUserKey: r.row.meegle_user_key, meegleEmail: r.row.meegle_email, via: r.via })
    res.json({ ok: true, binding: publicBinding(r.row) })
  } catch (error) { next(error) }
})

// POST /api/meegle/account/verify —— 用已存的 token 重新驗證
router.post('/api/meegle/account/verify', writeLimiter, async (req, res, next) => {
  try {
    const account = requireLogin(req, res)
    if (!account) return
    if (!getAccountRow(db, account.email)) return fail(res, 'NOT_BOUND', '尚未綁定 Meegle')
    if (!isMeegleKeyConfigured()) return fail(res, 'KEY_NOT_CONFIGURED', '伺服器尚未設定 MEEGLE_TOKEN_KEY，暫時無法驗證。')
    const r = await verifyAccount(db, account.email, { verify: t => verifyMeegleToken(t), decrypt: s => decryptMeegleToken(s) })
    if ('code' in r) return fail(res, r.code, r.message)
    res.json({ ok: true, binding: publicBinding(r.row) })
  } catch (error) { next(error) }
})

// DELETE /api/meegle/account —— 解除綁定（只刪本站存的 token；要作廢 token 得到 Meegle 按重置）
router.delete('/api/meegle/account', writeLimiter, (req, res) => {
  const account = requireLogin(req, res)
  if (!account) return
  const row = unbindAccount(db, account.email)
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

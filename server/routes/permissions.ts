/**
 * server/routes/permissions.ts
 * Account management and role-permission matrix (admin only).
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import {
  db, pinHash, readAccounts, upsertAccount, deleteAccountByEmail,
  writeLimiter, ALL_PAGE_KEYS, getPermissionsForRole, type AccountRole,
  getCultivationInfo, setCultivationDays, CULTIVATION_LEVELS,
  getEffectivePermissions, getAccountPermissionOverrides,
} from '../shared.js'
import { getAuthAccount } from '../auth-session.js'

export const router = Router()

// ─── Middleware ───────────────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const account = getAuthAccount(req)
  if (!account || account.role !== 'admin') {
    res.status(403).json({ ok: false, message: '需要管理員權限' })
    return
  }
  next()
}

// ─── My permissions ───────────────────────────────────────────────────────────

router.get('/api/admin/my-permissions', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.json({ ok: true, permissions: [] })
  // 角色預設 ∪ 個人覆寫（admin 一律全開且不套 deny）
  const perms = getEffectivePermissions(account.email, account.role as AccountRole)
  res.json({ ok: true, role: account.role, permissions: perms })
})

// ─── Permission matrix ────────────────────────────────────────────────────────

router.get('/api/admin/permissions', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT role, page_key, allowed FROM role_permissions').all() as {
    role: string; page_key: string; allowed: number
  }[]
  // Build { qa: { jira: true, ... }, pm: {...}, other: {...} }
  const matrix: Record<string, Record<string, boolean>> = { qa: {}, pm: {}, other: {} }
  for (const row of rows) {
    if (!matrix[row.role]) matrix[row.role] = {}
    matrix[row.role][row.page_key] = row.allowed === 1
  }
  // Fill missing keys with false
  for (const role of ['qa', 'pm', 'other']) {
    for (const key of ALL_PAGE_KEYS) {
      if (matrix[role][key] === undefined) matrix[role][key] = false
    }
  }
  res.json({ ok: true, matrix, pageKeys: ALL_PAGE_KEYS })
})

router.put('/api/admin/permissions', requireAdmin, writeLimiter, (req, res) => {
  const body = req.body as { matrix?: Record<string, Record<string, unknown>> }
  if (!body?.matrix || typeof body.matrix !== 'object') {
    return res.status(400).json({ ok: false, message: '缺少 matrix 欄位' })
  }
  const upsert = db.prepare('INSERT OR REPLACE INTO role_permissions (role, page_key, allowed) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const role of ['qa', 'pm', 'other']) {
      const rolePerms = body.matrix![role]
      for (const key of ALL_PAGE_KEYS) {
        const allowed = rolePerms && rolePerms[key] ? 1 : 0
        upsert.run(role, key, allowed)
      }
    }
  })()
  res.json({ ok: true })
})

// ─── Account management ───────────────────────────────────────────────────────

router.get('/api/admin/accounts', requireAdmin, (_req, res) => {
  const accounts = readAccounts().map(a => ({
    email: a.email,
    label: a.label,
    role: a.role,
    status: a.status ?? 'active',
    hasPIN: !!a.pin_hash,
  }))
  res.json({ ok: true, accounts })
})

const createAccountSchema = z.object({
  // For 'other' role, accepts any unique identifier; qa/pm must be valid email
  email: z.string().min(1),
  label: z.string().min(1),
  role: z.enum(['qa', 'pm', 'other']),
  token: z.string().default(''),
  pin: z.string().optional(),
  status: z.enum(['active', 'disabled']).default('active'),
}).refine(d => d.role === 'other' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email), {
  message: 'QA / PM 帳號必須填寫有效的 Email',
  path: ['email'],
})

router.post('/api/admin/accounts', requireAdmin, writeLimiter, (req, res) => {
  const data = createAccountSchema.parse(req.body)
  const existing = readAccounts().find(a => a.email === data.email)
  if (existing) return res.status(409).json({ ok: false, message: '帳號已存在' })
  upsertAccount({
    email: data.email,
    label: data.label,
    role: data.role,
    token: data.token,
    status: data.status,
  })
  if (data.pin?.trim()) {
    db.prepare('UPDATE jira_accounts SET pin_hash = ? WHERE email = ?').run(pinHash(data.pin.trim()), data.email)
  }
  res.json({ ok: true })
})

const updateAccountSchema = z.object({
  label: z.string().min(1).optional(),
  role: z.enum(['qa', 'pm', 'other']).optional(),
  token: z.string().optional(),
  pin: z.string().optional(),
  clearPin: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
})

router.put('/api/admin/accounts/:email', requireAdmin, writeLimiter, (req, res) => {
  const email = decodeURIComponent(req.params.email)
  const accounts = readAccounts()
  const existing = accounts.find(a => a.email === email)
  if (!existing) return res.status(404).json({ ok: false, message: '帳號不存在' })

  const data = updateAccountSchema.parse(req.body)
  const updated = {
    ...existing,
    label: data.label ?? existing.label,
    role: data.role ?? existing.role,
    token: data.token ?? existing.token,
    status: data.status ?? existing.status ?? 'active',
  } as typeof existing
  upsertAccount(updated)

  if (data.clearPin) {
    db.prepare('UPDATE jira_accounts SET pin_hash = NULL WHERE email = ?').run(email)
  } else if (data.pin?.trim()) {
    db.prepare('UPDATE jira_accounts SET pin_hash = ? WHERE email = ?').run(pinHash(data.pin.trim()), email)
  }
  res.json({ ok: true })
})

// ─── Cultivation (admin override) ────────────────────────────────────────────
// 管理員手動調整某帳號的境界——直接改「累計登入天數」，用該帳號選擇的境界對應門檻天數，
// 之後正常登入仍會從這個新天數繼續往上累計，不是額外的覆寫欄位。
const adjustCultivationSchema = z.object({
  activeDays: z.number().int().min(0),
})

router.get('/api/admin/accounts/:email/cultivation', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email)
  if (!readAccounts().find(a => a.email === email)) return res.status(404).json({ ok: false, message: '帳號不存在' })
  res.json({ ok: true, ...getCultivationInfo(email) })
})

router.put('/api/admin/accounts/:email/cultivation', requireAdmin, writeLimiter, (req, res) => {
  const email = decodeURIComponent(req.params.email)
  if (!readAccounts().find(a => a.email === email)) return res.status(404).json({ ok: false, message: '帳號不存在' })
  const data = adjustCultivationSchema.parse(req.body)
  setCultivationDays(email, data.activeDays)
  res.json({ ok: true, ...getCultivationInfo(email) })
})

// ─── 個人權限覆寫 ─────────────────────────────────────────────────────────────
// 疊在角色權限之上的個人例外。刻意只收 ALL_PAGE_KEYS 裡的 key——sysadmin 這種管理身分
// 不能透過這支修改，避免把安全邊界跟功能開關混在一起；也禁止管理員改自己的覆寫，
// 避免自己把必要入口關掉後救不回來（CodeX review 建議）。

router.get('/api/admin/accounts/:email/permissions', requireAdmin, (req, res) => {
  const email = String(req.params.email).toLowerCase()
  const account = readAccounts().find(a => a.email.toLowerCase() === email)
  if (!account) return res.status(404).json({ ok: false, message: '找不到帳號' })
  res.json({
    ok: true,
    email: account.email,
    role: account.role,
    roleDefaults: getPermissionsForRole(account.role as AccountRole),
    overrides: getAccountPermissionOverrides(email),
    effective: getEffectivePermissions(account.email, account.role as AccountRole),
    pageKeys: ALL_PAGE_KEYS,
  })
})

router.put('/api/admin/accounts/:email/permissions', requireAdmin, writeLimiter, (req, res) => {
  const email = String(req.params.email).toLowerCase()
  const me = getAuthAccount(req)
  if (me && me.email.toLowerCase() === email) {
    return res.status(400).json({ ok: false, message: '不能修改自己的權限覆寫，請由另一位管理員操作' })
  }
  const account = readAccounts().find(a => a.email.toLowerCase() === email)
  if (!account) return res.status(404).json({ ok: false, message: '找不到帳號' })

  const parsed = z.object({ overrides: z.record(z.string(), z.boolean()) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, message: '缺少 overrides 欄位' })
  const overrides = parsed.data.overrides

  // 不認得的 key 直接擋下，不要靜默忽略（CodeX review 建議）——靜默忽略會讓呼叫端
  // 以為設定成功，實際上什麼都沒發生。
  const allowedKeys = new Set<string>(ALL_PAGE_KEYS)
  const bad = Object.keys(overrides).filter(k => !allowedKeys.has(k))
  if (bad.length > 0) {
    return res.status(400).json({ ok: false, message: `不支援的權限 key：${bad.join(', ')}` })
  }

  const now = Date.now()
  db.transaction(() => {
    db.prepare('DELETE FROM account_permissions WHERE email = ?').run(email)
    const ins = db.prepare('INSERT INTO account_permissions (email, perm_key, allowed, updated_at) VALUES (?, ?, ?, ?)')
    for (const [key, allowed] of Object.entries(overrides)) {
      ins.run(email, key, allowed ? 1 : 0, now)
    }
  })()

  res.json({ ok: true, effective: getEffectivePermissions(account.email, account.role as AccountRole) })
})

router.get('/api/admin/cultivation-levels', requireAdmin, (_req, res) => {
  res.json({ ok: true, levels: CULTIVATION_LEVELS })
})

router.delete('/api/admin/accounts/:email', requireAdmin, writeLimiter, (req, res) => {
  const email = decodeURIComponent(req.params.email)
  const accounts = readAccounts()
  if (!accounts.find(a => a.email === email)) return res.status(404).json({ ok: false, message: '帳號不存在' })
  // Admin account cannot be deleted
  const target = accounts.find(a => a.email === email)
  if (target?.role === 'admin') {
    return res.status(400).json({ ok: false, message: '管理員帳號不可刪除' })
  }
  deleteAccountByEmail(email)
  res.json({ ok: true })
})

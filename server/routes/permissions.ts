/**
 * server/routes/permissions.ts
 * Account management and role-permission matrix (admin only).
 */
import { Router } from 'express'
import { z } from 'zod'
import {
  db, pinHash, readAccounts, upsertAccount, deleteAccountByEmail,
  writeLimiter, ALL_PAGE_KEYS, getPermissionsForRole, type AccountRole,
} from '../shared.js'
import { getAuthAccount } from '../auth-session.js'

export const router = Router()

// ─── Middleware ───────────────────────────────────────────────────────────────

function requireAdmin(req: Parameters<Router>[0], res: Parameters<Router>[1], next: Parameters<Router>[2]) {
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
  const perms = getPermissionsForRole(account.role as AccountRole)
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

const matrixSchema = z.object({
  matrix: z.record(z.record(z.boolean())),
})

router.put('/api/admin/permissions', requireAdmin, writeLimiter, (req, res) => {
  const { matrix } = matrixSchema.parse(req.body)
  const upsert = db.prepare('INSERT OR REPLACE INTO role_permissions (role, page_key, allowed) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const role of ['qa', 'pm', 'other']) {
      for (const key of ALL_PAGE_KEYS) {
        const allowed = matrix[role]?.[key] ? 1 : 0
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
  email: z.string().email(),
  label: z.string().min(1),
  role: z.enum(['qa', 'pm', 'admin', 'other']),
  token: z.string().default(''),
  pin: z.string().optional(),
  status: z.enum(['active', 'disabled']).default('active'),
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
  role: z.enum(['qa', 'pm', 'admin', 'other']).optional(),
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

router.delete('/api/admin/accounts/:email', requireAdmin, writeLimiter, (req, res) => {
  const email = decodeURIComponent(req.params.email)
  const accounts = readAccounts()
  if (!accounts.find(a => a.email === email)) return res.status(404).json({ ok: false, message: '帳號不存在' })
  // Prevent deleting last admin
  const admins = accounts.filter(a => a.role === 'admin')
  const target = accounts.find(a => a.email === email)
  if (target?.role === 'admin' && admins.length <= 1) {
    return res.status(400).json({ ok: false, message: '無法刪除唯一的管理員帳號' })
  }
  deleteAccountByEmail(email)
  res.json({ ok: true })
})

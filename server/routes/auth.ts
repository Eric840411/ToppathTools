import { Router } from 'express'
import { z } from 'zod'
import { pinHash, readAccounts, writeLimiter } from '../shared.js'
import { clearAuthSession, createAuthSession, getAuthAccount, publicAccount } from '../auth-session.js'
import { getActiveHeavyTasks, getHeavyTaskForRequest, getRecentHeavyTasksForRequest } from '../heavy-task-guard.js'

export const router = Router()

const loginSchema = z.object({
  email: z.string().email(),
  pin: z.string().optional(),
})

router.get('/api/auth/me', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.json({ ok: true, authenticated: false, account: null })
  res.json({ ok: true, authenticated: true, account })
})

router.post('/api/auth/login', writeLimiter, (req, res) => {
  const { email, pin } = loginSchema.parse(req.body)
  const account = readAccounts().find(a => a.email === email)
  if (!account) return res.status(404).json({ ok: false, message: '帳號不存在' })
  if (account.status === 'disabled') return res.status(403).json({ ok: false, message: '帳號已停用' })

  if (account.pin_hash) {
    if (!pin?.trim()) return res.status(403).json({ ok: false, message: '請輸入 PIN' })
    if (account.pin_hash !== pinHash(pin.trim())) {
      return res.status(403).json({ ok: false, message: 'PIN 錯誤' })
    }
  }

  createAuthSession(email, res)
  res.json({ ok: true, account: publicAccount(email) })
})

router.post('/api/auth/logout', (_req, res) => {
  clearAuthSession(res)
  res.json({ ok: true })
})

router.get('/api/heavy-tasks/me', (req, res) => {
  res.json({ ok: true, task: getHeavyTaskForRequest(req), recent: getRecentHeavyTasksForRequest(req) })
})

router.get('/api/heavy-tasks/active', (_req, res) => {
  res.json({ ok: true, tasks: getActiveHeavyTasks() })
})

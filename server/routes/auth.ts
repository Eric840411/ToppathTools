import { Router } from 'express'
import { z } from 'zod'
import { loginLimiter, pinHash, readAccounts } from '../shared.js'
import { clearAuthSession, createAuthSession, getAuthAccount, publicAccount } from '../auth-session.js'
import {
  getActiveHeavyTasks, getHeavyTaskForRequest, getRecentHeavyTasksForRequest,
  listRunningHeavyLocks, releaseHeavyTaskById,
} from '../heavy-task-guard.js'

export const router = Router()

const loginSchema = z.object({
  email: z.string().min(1),  // allow non-email identifiers for Other role accounts
  pin: z.string().optional(),
})

router.get('/api/auth/me', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.json({ ok: true, authenticated: false, account: null })
  res.json({ ok: true, authenticated: true, account })
})

router.post('/api/auth/login', loginLimiter, (req, res) => {
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

/**
 * 強制清除卡住的重任務鎖（**不限 type**，但只能清自己的）。
 *
 * ⚠️ 2026-09-22 補這支的原因：原本只有 `/api/autospin/locks/:id/force-clear`，
 * 而它查的是 `type='autospin-agent'`——**機台測試的鎖卡住時完全清不掉**。
 * 實際發生：agent 在測試中途被重啟 → session 結束但鎖留著 →
 * 之後每次 `/api/machine-test/start` 都回 429，唯一出路是等 6 小時自癒。
 *
 * 「只能清自己的」是刻意的：別人的鎖代表別人可能正在跑，清掉會讓他的 session 失去保護。
 */
router.post('/api/heavy-tasks/:id/force-clear', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '需要登入才能清除鎖' })

  const row = listRunningHeavyLocks().find(r => r.id === req.params.id)
  if (!row) return res.status(404).json({ ok: false, message: '找不到這筆 running 的鎖，可能已經被釋放了' })
  if (row.user_key !== account.email) {
    return res.status(403).json({ ok: false, message: '只能清除自己帳號的鎖' })
  }

  const startedAt = row.started_at ?? row.created_at
  const ageMin = Math.round((Date.now() - startedAt) / 60000)
  const ok = releaseHeavyTaskById(row.id, `使用者手動強制清除（${account.email}）`)
  res.json({ ok, task: { id: row.id, type: row.type, label: row.label, ageMinutes: ageMin } })
})

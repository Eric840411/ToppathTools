/**
 * server/routes/accounts.ts —— 登入帳號（列表、PIN、自助新增、刪除、改角色）與 /api/admin/verify。
 * 2026-10-02 從 routes/jira.ts 搬出來（Jira 停用前的解綁，CodeX 同意）：帳號表仍是 jira_accounts（最後才改名），
 * 路徑新舊兩套共用同一個 handler：/api/accounts/*（新）與 /api/jira/accounts/*（舊，前端改完後刪）。
 */
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  db,
  addHistory,
  getClientIP,
  getUser,
  log,
  mustEnv,
  pinHash,
  readAccounts,
  upsertAccount,
  deleteAccountByEmail,
  userJiraAuth,
  toJiraDateTime,
  heavyLimiter,
  writeLimiter,
  getLarkToken,
  parseLarkSheetUrl,
  accountHasPermission,
  jiraAuthForAccount,
  matchAccountsByPersonName,
  hasJiraDelegation,
} from '../shared.js'
import { callLLM } from './gemini.js'
import { buildCompletenessPrompt, buildSpecContext, formatCommentWithAI } from '../comment-ai.js'
import { multiWritebackLark, multiWritebackLarkBatch, type MultiWrite } from './integrations.js'
import { getAuthAccount } from '../auth-session.js'
import { adminTargetError, deleteAccountGuarded, roleDisplay, roleNameMap, updateAccountGuarded } from '../role-store.js'
import { withRequestOperation } from '../request-context.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'
import { missingForcedRequiredFields } from '../../shared/jira-required-fields.js'
import { JIRA_KEY_EXACT_RE, JIRA_KEY_IN_TEXT_RE, JIRA_KEY_BRACKET_PREFIX_RE } from '../../shared/jira-key.js'
import { pickTransitionForTarget, type JiraTransitionLike } from '../../shared/jira-transition.js'
import {
  ATTACH_CACHE_DIR, AttachmentTooLargeError, cleanAttachmentCache, createAttachmentUploadHandler, createLease, holdLease,
  releaseLease, renewLease, safeUnlink, saveResponseToCache, startAttachmentCacheSweeper, touchCacheFile, uploadFileToJira, type CachedFile,
} from '../jira-attachment-files.js'


export const router = Router()

const accountAddSchema = z.object({
  email: z.string().email(),
  // Jira 停用：建帳號不再要 Jira Token（使用者 2026-10-02）；舊前端送來的照存
  token: z.string().default(''),
  label: z.string().min(1),
  role: z.enum(['qa', 'pm']).default('qa'),
  pin: z.string().optional(),
})

// GET /api/jira/accounts

router.get(['/api/accounts', '/api/jira/accounts'], (_req, res) => {
  const accounts = readAccounts()
  const names = roleNameMap(db)
  res.json({
    ok: true,
    accounts: accounts.map(({ email, label, role, pin_hash }) => ({ email, label, role, roleLabel: roleDisplay(role, names), hasPIN: !!pin_hash })),
  })
})

// POST /api/jira/accounts/:email/verify-pin
router.post(['/api/accounts/:email/verify-pin', '/api/jira/accounts/:email/verify-pin'], (req, res) => {
  const email = decodeURIComponent(String(req.params.email))
  const { pin } = z.object({ pin: z.string() }).parse(req.body)
  const account = readAccounts().find(a => a.email === email)
  if (!account) return res.status(404).json({ ok: false, message: '帳號不存在' })
  if (!account.pin_hash) return res.json({ ok: true })
  if (account.pin_hash !== pinHash(pin)) return res.status(403).json({ ok: false, message: 'PIN 錯誤' })
  res.json({ ok: true })
})

// POST /api/jira/accounts/:email/set-pin
router.post(['/api/accounts/:email/set-pin', '/api/jira/accounts/:email/set-pin'], writeLimiter, (req, res) => {
  const email = decodeURIComponent(String(req.params.email))
  const { oldPin, newPin } = z.object({ oldPin: z.string().optional(), newPin: z.string().optional() }).parse(req.body)
  const account = readAccounts().find(a => a.email === email)
  if (!account) return res.status(404).json({ ok: false, message: '帳號不存在' })
  if (account.pin_hash) {
    if (!oldPin) return res.status(403).json({ ok: false, message: '請輸入舊 PIN' })
    if (account.pin_hash !== pinHash(oldPin)) return res.status(403).json({ ok: false, message: '舊 PIN 錯誤' })
  }
  const newHash = newPin && newPin.trim() ? pinHash(newPin.trim()) : null
  db.prepare('UPDATE jira_accounts SET pin_hash = ? WHERE email = ?').run(newHash, email)
  res.json({ ok: true, hasPIN: !!newHash })
})

// POST /api/jira/accounts
// 允許自助新增帳號；覆蓋已存在帳號的 token 需要 admin 身份
router.post(['/api/accounts', '/api/jira/accounts'], writeLimiter, (req, res, next) => {
  try {
    const body = accountAddSchema.parse(req.body)
    const exists = readAccounts().some((a) => a.email === body.email)
    if (exists) {
      const caller = getAuthAccount(req)
      if (!caller || caller.role !== 'admin') {
        return res.status(403).json({ ok: false, message: '此帳號已存在，只有管理員可以覆蓋' })
      }
    }
    // 管理員覆蓋既有帳號時，目標若是管理員，**角色保持不變、其他欄位照寫、回成功**（不是 400；這支只收 qa／pm，
    // 照送會把管理員降級——CodeX review P1）。讀現況跟寫入同一個 transaction
    db.transaction(() => {
      const prev = readAccounts().find((a) => a.email === body.email)
      upsertAccount(adminTargetError(prev, { role: body.role }) ? { ...body, role: prev!.role } : body)
    }).immediate()
    if (body.pin?.trim()) {
      db.prepare('UPDATE jira_accounts SET pin_hash = ? WHERE email = ?').run(pinHash(body.pin.trim()), body.email)
    }
    log('ok', getClientIP(req), getUser(req), exists ? '帳號更新' : '帳號新增', `${body.label} <${body.email}>`)
    res.json({ ok: true, email: body.email, label: body.label })
  } catch (error) {
    next(error)
  }
})

// DELETE /api/jira/accounts/:email
router.delete(['/api/accounts/:email', '/api/jira/accounts/:email'], (req, res) => {
  // v5.9.0：原本只看 ADMIN_PIN 環境變數——**沒設的話任何人都能刪帳號**。一律先要管理員登入（PIN 有設的話照樣要對）
  const caller = getAuthAccount(req)
  if (!caller || caller.role !== 'admin') return res.status(403).json({ ok: false, message: '需要管理員權限' })
  const pin = process.env.ADMIN_PIN ?? ''
  const provided = String(req.headers['x-admin-pin'] ?? '')
  if (pin && provided !== pin) {
    log('warn', getClientIP(req), getUser(req), '帳號刪除失敗', 'PIN 錯誤')
    return res.status(403).json({ ok: false, message: '管理員 PIN 錯誤' })
  }
  const email = decodeURIComponent(String(req.params.email))
  const w = deleteAccountGuarded(db, email)
  if ('message' in w) return res.status(w.status).json({ ok: false, message: w.message })
  log('warn', getClientIP(req), getUser(req), '帳號刪除（管理員）', email)
  res.json({ ok: true })
})

// PATCH /api/jira/accounts/:email/role  (管理員專用)
router.patch(['/api/accounts/:email/role', '/api/jira/accounts/:email/role'], (req, res) => {
  // v5.9.0：同上，原本只看 ADMIN_PIN；而且這支會寫出逗號多角色。改成要管理員登入、只收單一角色
  const caller = getAuthAccount(req)
  if (!caller || caller.role !== 'admin') return res.status(403).json({ ok: false, message: '需要管理員權限' })
  const pin = process.env.ADMIN_PIN ?? ''
  const provided = String(req.headers['x-admin-pin'] ?? '')
  if (pin && provided !== pin) {
    return res.status(403).json({ ok: false, message: '管理員 PIN 錯誤' })
  }
  const email = decodeURIComponent(String(req.params.email))
  const { roles } = z.object({ roles: z.array(z.string()).length(1) }).parse(req.body)
  const roleStr = roles[0]
  const w = updateAccountGuarded(db, email, { role: roleStr })
  if ('message' in w) return res.status(w.status).json({ ok: false, message: w.message })
  log('warn', getClientIP(req), getUser(req), '角色更新（管理員）', `${email} → ${roleStr}`)
  res.json({ ok: true, role: roleStr })
})

// POST /api/admin/verify
router.post('/api/admin/verify', (req, res) => {
  const pin = process.env.ADMIN_PIN ?? ''
  if (!pin) {
    return res.json({ ok: false, message: '未設定管理員 PIN' })
  }
  const body = z.object({ pin: z.string() }).parse(req.body)
  if (body.pin === pin) {
    log('auth', getClientIP(req), getUser(req), '管理員登入成功')
    res.json({ ok: true })
  } else {
    log('warn', getClientIP(req), getUser(req), '管理員登入失敗', 'PIN 錯誤')
    res.status(403).json({ ok: false, message: 'PIN 錯誤，請再試一次' })
  }
})


/**
 * server/routes/jira.ts
 * All /api/jira/*, /api/admin/*, /api/lark/sheets/* routes.
 */
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
} from '../shared.js'
import { callLLM, readGeminiPrompts, renderPrompt } from './gemini.js'
import { withRequestOperation } from '../request-context.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'

export const router = Router()

// ─── Batch-comment job store (SSE background processing) ──────────────────────
interface CommentJobResult {
  ok: boolean
  results: { rowIndex: number; issueKey: string; ok: boolean; usedAi?: boolean; error?: string }[]
  stopped?: boolean
  stoppedReason?: string
}
interface CommentJobProgress {
  done: number
  total: number
  current: string
}
interface CommentJobEntry {
  status: 'running' | 'done'
  result?: CommentJobResult
  progress: CommentJobProgress
  createdAt: number
  ownerEmail: string
  heavyTask?: HeavyTaskToken
  callbacks: Set<(result: CommentJobResult) => void>
  progressCallbacks: Set<(progress: CommentJobProgress) => void>
}
const commentJobStore = new Map<string, CommentJobEntry>()

function pushCommentProgress(requestId: string, progress: CommentJobProgress) {
  const job = commentJobStore.get(requestId)
  if (!job) return
  job.progress = progress
  job.progressCallbacks.forEach(cb => cb(progress))
}

function finishCommentJob(requestId: string, result: CommentJobResult) {
  const job = commentJobStore.get(requestId)
  if (!job) return
  job.status = 'done'
  job.result = result
  finishHeavyTask(job.heavyTask)
  job.callbacks.forEach(cb => cb(result))
  job.callbacks.clear()
  job.progressCallbacks.clear()
  // Clean up after 5 minutes
  setTimeout(() => commentJobStore.delete(requestId), 5 * 60 * 1000)
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const accountAddSchema = z.object({
  email: z.string().email(),
  token: z.string().min(1),
  label: z.string().min(1),
  role: z.enum(['qa', 'pm']).default('qa'),
  pin: z.string().optional(),
})

const batchCreateSchema = z.object({
  rows: z.array(
    z.object({
      summary: z.string().min(1),
      description: z.string().optional().default(''),
      assigneeAccountId: z.string().optional(),
      rdOwnerAccountId: z.string().optional(),
      verifierAccountIds: z.array(z.string()).default([]),
      actualStart: z.string().optional(),
      actualEnd: z.string().optional(),
      localTestDone: z.string().optional(),
      stagingDeploy: z.string().optional(),
      releaseDate: z.string().optional(),
      rowIndex: z.number(),
    }),
  ),
  sheetUrl: z.string(),
  projectId: z.string().optional(),
  issueTypeId: z.string().optional(),
})

const writebackSchema = z.object({
  sheetUrl: z.string(),
  writes: z.array(z.object({ rowIndex: z.number(), issueKey: z.string() })),
  issueKeyColumn: z.string().default('Jira Issue Key'),
})

const batchCommentSchema = z.object({
  modelSpec: z.string().optional(),
  comments: z.array(z.object({
    issueKey: z.string(),
    rowIndex: z.number(),
    rawComment: z.string(),
    useAi: z.boolean().default(false),
    promptId: z.string().optional(),
    environment: z.string().optional(),
    version: z.string().optional(),
    platform: z.string().optional(),
    machineId: z.string().optional(),
    gameMode: z.string().optional(),
    attachmentUrls: z.array(z.string()).optional().default([]),
  })),
})

const batchTransitionSchema = z.object({
  issues: z.array(z.object({
    issueKey: z.string(),
    rowIndex: z.number(),
    transitionId: z.string().optional(),
  })),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface CommentContext {
  rawText: string
  promptId?: string
  environment?: string
  version?: string
  platform?: string
  machineId?: string
  gameMode?: string
  modelSpec?: string
}

/** 遞歸抽取 Atlassian Document Format (ADF) 純文字 */
export function extractAdfText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as Record<string, unknown>
  if (n.type === 'text' && typeof n.text === 'string') return n.text
  const parts: string[] = []
  if (Array.isArray(n.content)) {
    for (const child of n.content) parts.push(extractAdfText(child))
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** 將純文字（含換行）轉成 Jira ADF 段落，正確保留多行結構 */
const textToADF = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split('\n').map(line => ({
    type: 'paragraph',
    content: line.trim()
      ? [{ type: 'text', text: line }]
      : [],
  })),
})

/** 從 Lark 分享連結或 Drive URL 中提取 file_token */
function parseLarkFileToken(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  // 純 token（不含斜線）
  if (!trimmed.includes('/') && !trimmed.includes('?')) return trimmed
  // /files/{token} 或 /file/{token}
  const m = trimmed.match(/\/files?\/([A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

/** 透過 Lark Drive API 下載檔案，回傳 buffer、filename、mimeType */
async function downloadLarkFile(fileToken: string, larkToken: string): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const resp = await fetch(`${base}/open-apis/drive/v1/files/${fileToken}/download`, {
    headers: { Authorization: `Bearer ${larkToken}` },
  })
  if (!resp.ok) throw new Error(`Lark Drive download failed: HTTP ${resp.status}`)
  const cd = resp.headers.get('content-disposition') ?? ''
  const filenameMatch = cd.match(/filename\*=UTF-8''(.+)/i) ?? cd.match(/filename="?([^";\r\n]+)"?/i)
  const filename = filenameMatch ? decodeURIComponent(filenameMatch[1].trim()) : `file_${fileToken}`
  const mimeType = resp.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'
  const arrayBuffer = await resp.arrayBuffer()
  return { buffer: Buffer.from(arrayBuffer), filename, mimeType }
}

/** 上傳附件到 Jira Issue */
async function uploadAttachmentToJira(issueKey: string, filename: string, buffer: Buffer, mimeType: string, auth: string, baseUrl: string): Promise<void> {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), filename)
  const resp = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: { Authorization: auth, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' },
    body: form,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Jira 附件上傳失敗 HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
}

/** 判斷 URL 是否為 Google Drive */
function isGoogleDriveUrl(url: string): boolean {
  return /drive\.google\.com|drive\.usercontent\.google\.com/.test(url)
}

/** 從 Google Drive 分享連結提取 file ID */
function parseGoogleDriveFileId(url: string): string | null {
  const m1 = url.match(/\/d\/([A-Za-z0-9_-]+)/)
  if (m1) return m1[1]
  const m2 = url.match(/[?&]id=([A-Za-z0-9_-]+)/)
  if (m2) return m2[1]
  return null
}

/** 透過 HEAD 請求偵測 Google Drive 檔案類型（image / video / other） */
async function detectGoogleDriveFileType(fileId: string): Promise<'image' | 'video' | 'other'> {
  try {
    const resp = await fetch(
      `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0`,
      { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(6000) }
    )
    const ct = resp.headers.get('content-type') ?? ''
    if (ct.startsWith('image/')) return 'image'
    if (ct.startsWith('video/')) return 'video'
    return 'other'
  } catch {
    return 'other'
  }
}

/** 下載公開的 Google Drive 檔案 */
async function downloadGoogleDriveFile(fileId: string): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0`
  const resp = await fetch(url, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`Google Drive download failed: HTTP ${resp.status}`)
  const cd = resp.headers.get('content-disposition') ?? ''
  const fnMatch = cd.match(/filename\*=UTF-8''(.+)/i) ?? cd.match(/filename="?([^";\r\n]+)"?/i)
  const filename = fnMatch ? decodeURIComponent(fnMatch[1].trim()) : `gdrive_${fileId}`
  const mimeType = resp.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'
  return { buffer: Buffer.from(await resp.arrayBuffer()), filename, mimeType }
}

const formatCommentWithGemini = async (ctx: CommentContext): Promise<string> => {
  const { rawText, promptId, environment = '', version = '', platform = '', machineId = '', gameMode = '', modelSpec } = ctx

  const envBlock = [
    `測試環境：${environment || '未指定'}`,
    `版本號：${version || '未指定'}`,
    `測試平台：${platform || '未指定'}`,
    machineId ? `機台編號：${machineId}` : '',
    gameMode ? `遊戲模式：${gameMode}` : '',
  ].filter(Boolean).join('\n')

  const prompts = readGeminiPrompts()
  const tpl = (promptId ? prompts.find(p => p.id === promptId) : null) ?? prompts.find(p => p.id === 'default') ?? prompts[0]
  if (!tpl) throw new Error('找不到可用的 Prompt 模板')

  const prompt = renderPrompt(tpl.template, {
    rawText,
    envBlock,
    environment: environment || '未指定',
    version: version || '未指定',
    platform: platform || '未指定',
    machineId: machineId || '',
    gameMode: gameMode || '',
  })

  return callLLM(prompt, modelSpec)
}

/** 從 Gemini 回傳中抽取第一個 JSON 物件或陣列 */
function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  let start = -1
  let endChar = ''
  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    start = objStart; endChar = '}'
  } else if (arrStart !== -1) {
    start = arrStart; endChar = ']'
  }
  if (start === -1) return raw.trim()
  const end = raw.lastIndexOf(endChar)
  if (end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

// ─── PM Mode: Lark Bitable → Jira helpers ─────────────────────────────────────

function parseBitableUrl(url: string): { appToken: string; tableId: string } {
  const appMatch = url.match(/\/base\/([A-Za-z0-9]+)/)
  const tableMatch = url.match(/[?&]table=([A-Za-z0-9]+)/)
  return { appToken: appMatch?.[1] ?? '', tableId: tableMatch?.[1] ?? '' }
}

function larkTextField(val: unknown): string {
  if (!val) return ''
  if (Array.isArray(val)) return (val as { text: string }[]).map(v => v.text ?? '').join('')
  if (typeof val === 'string') return val
  return ''
}

function larkSelectField(val: unknown): string {
  if (!val) return ''
  if (typeof val === 'object' && val !== null && 'text' in val) return (val as { text: string }).text
  if (typeof val === 'string') return val
  return ''
}

function larkMultiSelectField(val: unknown): string[] {
  if (!val || !Array.isArray(val)) return []
  return (val as Array<string | { text?: string; name?: string }>).map(v =>
    typeof v === 'string' ? v : (v.text ?? v.name ?? '')
  ).filter(Boolean)
}

function larkUserEmail(val: unknown): string {
  if (!val) return ''
  if (Array.isArray(val) && val.length > 0) val = val[0]
  if (typeof val === 'object' && val !== null && 'email' in val) return (val as { email: string }).email
  return ''
}

interface PMBitableRecord {
  recordId: string
  summary: string
  title: string        // 純標題（不含組合前綴），用於 parentKeyMap 查找
  description: string
  assigneeEmail: string
  rdOwnerEmail: string
  issueTypeName: string
  jiraProjectName: string
  parentTitle: string  // 來自「選擇主單並關聯」或「主單標題」，一定是純標題
  difficulty: string   // 來自「難易度」欄位，對應 Jira priority
  jiraKey: string
  isParent: boolean
}


const readPMBitableRecords = async (appToken: string, tableId: string): Promise<PMBitableRecord[]> => {
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const records: PMBitableRecord[] = []
  let pageToken: string | undefined

  do {
    const url = `${base}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await resp.json() as {
      code?: number; msg?: string
      data?: { items?: Array<{ record_id: string; fields: Record<string, unknown> }>; has_more?: boolean; page_token?: string }
    }
    if (data.code !== 0) throw new Error(`讀取 Bitable 失敗: ${data.msg}`)

    for (const item of data.data?.items ?? []) {
      const f = item.fields
      const 端點 = larkSelectField(f['端點'])
      const 平台 = larkSelectField(f['平台'])
      const 遊戲 = larkMultiSelectField(f['遊戲'])
      const 組件 = larkMultiSelectField(f['組件'])
      const 標題 = larkTextField(f['標題'])
      const isParent = 端點 === '主單'
      const parts = [端點, 平台, 遊戲.join('/'), 組件.join('/')].filter(Boolean).map(p => `[${p}]`)
      const summary = `${parts.join('')} ${標題}`.trim()
      // 「選擇主單並關聯」與「主單標題」均為純標題，優先讀新欄位名
      const parentTitle = larkTextField(f['選擇主單並關聯']) || larkTextField(f['主單標題'])

      records.push({
        recordId: item.record_id,
        summary,
        title: 標題,
        description: larkTextField(f['描述']),
        assigneeEmail: larkUserEmail(f['受託人']),
        rdOwnerEmail: larkUserEmail(f['RD負責人']),
        issueTypeName: larkSelectField(f['議題類型']),
        jiraProjectName: larkSelectField(f['JIRA專案']),
        parentTitle,
        difficulty: larkSelectField(f['難易度']),
        jiraKey: larkTextField(f['JIRA索引鍵']),
        isParent,
      })
    }
    pageToken = data.data?.has_more ? data.data.page_token : undefined
  } while (pageToken)

  return records
}

// Per-table 開單鎖：防止同一張表同時被多人觸發
const pmBatchLocks = new Set<string>()

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/jira/accounts
router.get('/api/jira/accounts', (_req, res) => {
  const accounts = readAccounts()
  res.json({
    ok: true,
    accounts: accounts.map(({ email, label, role, pin_hash }) => ({ email, label, role, hasPIN: !!pin_hash })),
  })
})

// POST /api/jira/accounts/:email/verify-pin
router.post('/api/jira/accounts/:email/verify-pin', (req, res) => {
  const email = decodeURIComponent(req.params.email)
  const { pin } = z.object({ pin: z.string() }).parse(req.body)
  const account = readAccounts().find(a => a.email === email)
  if (!account) return res.status(404).json({ ok: false, message: '帳號不存在' })
  if (!account.pin_hash) return res.json({ ok: true })
  if (account.pin_hash !== pinHash(pin)) return res.status(403).json({ ok: false, message: 'PIN 錯誤' })
  res.json({ ok: true })
})

// POST /api/jira/accounts/:email/set-pin
router.post('/api/jira/accounts/:email/set-pin', writeLimiter, (req, res) => {
  const email = decodeURIComponent(req.params.email)
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
router.post('/api/jira/accounts', writeLimiter, (req, res, next) => {
  try {
    const body = accountAddSchema.parse(req.body)
    const exists = readAccounts().some((a) => a.email === body.email)
    upsertAccount(body)
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
router.delete('/api/jira/accounts/:email', (req, res) => {
  const pin = process.env.ADMIN_PIN ?? ''
  const provided = String(req.headers['x-admin-pin'] ?? '')
  if (pin && provided !== pin) {
    log('warn', getClientIP(req), getUser(req), '帳號刪除失敗', 'PIN 錯誤')
    return res.status(403).json({ ok: false, message: '管理員 PIN 錯誤' })
  }
  const email = decodeURIComponent(req.params.email)
  deleteAccountByEmail(email)
  log('warn', getClientIP(req), getUser(req), '帳號刪除（管理員）', email)
  res.json({ ok: true })
})

// PATCH /api/jira/accounts/:email/role  (管理員專用)
router.patch('/api/jira/accounts/:email/role', (req, res) => {
  const pin = process.env.ADMIN_PIN ?? ''
  const provided = String(req.headers['x-admin-pin'] ?? '')
  if (pin && provided !== pin) {
    return res.status(403).json({ ok: false, message: '管理員 PIN 錯誤' })
  }
  const email = decodeURIComponent(req.params.email)
  const { roles } = z.object({ roles: z.array(z.enum(['qa', 'pm'])).min(1) }).parse(req.body)
  const roleStr = [...new Set(roles)].sort().join(',')  // 'pm,qa' → 'pm,qa'（排序固定）
  const result = db.prepare('UPDATE jira_accounts SET role = ? WHERE email = ?').run(roleStr, email)
  if (result.changes === 0) return res.status(404).json({ ok: false, message: '帳號不存在' })
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

// GET /api/jira/members
router.get('/api/jira/members', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) {
      return res.status(401).json({ ok: false, message: '請先選擇帳號，或新增 Jira 帳號' })
    }

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const projectKey = req.query.projectKey as string | undefined

    if (projectKey) {
      const resp = await fetch(
        `${baseUrl}/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=100`,
        { headers: { Authorization: userAuth.auth, Accept: 'application/json' } }
      )
      if (!resp.ok) return res.status(resp.status).json({ ok: false, message: `Jira API error: ${resp.status}` })
      const data = await resp.json() as Array<{ accountId: string; displayName?: string; avatarUrls?: Record<string, string> }>
      const members = (Array.isArray(data) ? data : [])
        .filter(u => u.accountId && !u.accountId.startsWith('qm:'))
        .map(u => ({
          accountId: u.accountId,
          displayName: u.displayName ?? u.accountId,
          avatarUrl: u.avatarUrls?.['48x48'] ?? '',
        }))
      return res.json({ ok: true, members })
    }

    const ids = (process.env.TEAM_ACCOUNT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (ids.length === 0) return res.json({ ok: true, members: [] })
    const members = await Promise.all(
      ids.map(async (accountId) => {
        const resp = await fetch(`${baseUrl}/rest/api/3/user?accountId=${accountId}`, {
          headers: { Authorization: userAuth.auth, Accept: 'application/json' },
        })
        if (!resp.ok) return { accountId, displayName: accountId, avatarUrl: '' }
        const data = (await resp.json()) as { displayName?: string; avatarUrls?: Record<string, string> }
        return {
          accountId,
          displayName: data.displayName ?? accountId,
          avatarUrl: data.avatarUrls?.['48x48'] ?? '',
        }
      }),
    )
    res.json({ ok: true, members })
  } catch (error) {
    next(error)
  }
})

// GET /api/jira/projects
router.get('/api/jira/projects', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const resp = await fetch(`${baseUrl}/rest/api/3/project/search?maxResults=100&orderBy=NAME`, {
      headers: { Authorization: userAuth.auth, Accept: 'application/json' },
    })
    if (!resp.ok) return res.status(resp.status).json({ ok: false, message: `Jira API error: ${resp.status}` })
    const data = await resp.json() as { values?: { id: string; key: string; name: string }[] }
    const projects = (data.values ?? []).map(p => ({ id: p.id, key: p.key, name: p.name }))
    res.json({ ok: true, projects })
  } catch (error) {
    next(error)
  }
})

// GET /api/jira/issuetypes
router.get('/api/jira/issuetypes', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const projectId = req.query.projectId as string
    if (!projectId) return res.status(400).json({ ok: false, message: 'projectId 必填' })
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const resp = await fetch(`${baseUrl}/rest/api/3/issuetype/project?projectId=${projectId}`, {
      headers: { Authorization: userAuth.auth, Accept: 'application/json' },
    })
    if (!resp.ok) return res.status(resp.status).json({ ok: false, message: `Jira API error: ${resp.status}` })
    const data = await resp.json() as Array<{ id: string; name: string; subtask: boolean }>
    const issueTypes = (Array.isArray(data) ? data : [])
      .filter(t => !t.subtask)
      .map(t => ({ id: t.id, name: t.name }))
    res.json({ ok: true, issueTypes })
  } catch (error) {
    next(error)
  }
})

// POST /api/lark/sheets/records
router.post('/api/lark/sheets/records', async (req, res, next) => {
  try {
    const { sheetUrl } = z.object({ sheetUrl: z.string() }).parse(req.body)
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)

    if (!spreadsheetToken) {
      return res
        .status(400)
        .json({ ok: false, message: '無法解析 Lark Sheet URL，格式應為 /sheets/{token}?sheet={id}' })
    }

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const range = sheetId ? `${sheetId}!A1:Z1000` : 'A1:Z1000'

    const resp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    )
    const data = (await resp.json()) as {
      code?: number
      data?: { valueRange?: { values?: unknown[][] } }
    }

    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: 'Lark Sheets API 錯誤', detail: data })
    }

    const rows = data.data?.valueRange?.values ?? []
    if (rows.length < 2) return res.json({ ok: true, headers: [], records: [] })

    const headers = (rows[0] as string[]).map(String)
    const jiraKeyHeader = headers.find(h => h.toLowerCase() === 'jira issue key') ?? 'Jira Issue Key'
    const stageHeader = headers.find(h => h === '處理階段') ?? ''

    const records = rows
      .slice(1)
      .map((row, i) => {
        const obj: Record<string, string> = {}
        headers.forEach((h, ci) => {
          obj[h] = String((row as unknown[])[ci] ?? '')
        })
        return { ...obj, _rowIndex: i + 2 }
      })
      .filter((r) => {
        if (stageHeader) return r[stageHeader] !== '已完成'
        return !r[jiraKeyHeader] || r[jiraKeyHeader].trim() === ''
      })

    log('info', getClientIP(req), getUser(req), 'Lark Sheet 讀取', `${records.length} 筆待處理`)
    res.json({ ok: true, headers, records })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /api/jira/batch-create
 * 從 Lark Sheet 批次建立 Jira Issues。
 * @rate-limit heavyLimiter — 每分鐘最多 15 次，防止對 Jira API 造成過量請求。
 */
router.post('/api/jira/batch-create', heavyLimiter, async (req, res, next) => {
  let heavyTaskToken: HeavyTaskToken | null = null
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) {
      return res.status(401).json({ ok: false, message: '請先選擇帳號，或新增 Jira 帳號' })
    }

    const heavyTask = tryStartHeavyTask(req, 'jira-batch-create', 'Jira 批次開單')
    if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
    heavyTaskToken = heavyTask.token

    const body = batchCreateSchema.parse(req.body)
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const projectId = body.projectId || process.env.JIRA_PROJECT_ID || ''
    const issueTypeId = body.issueTypeId || process.env.JIRA_ISSUE_TYPE_ID || ''
    if (!projectId) return res.status(400).json({ ok: false, message: '請選擇 Jira 專案' })
    if (!issueTypeId) return res.status(400).json({ ok: false, message: '請選擇 Issue 類型' })
    const verifierFieldId = process.env.JIRA_VERIFIER_FIELD_ID ?? 'customfield_10440'

    const results: { rowIndex: number; issueKey?: string; error?: string }[] = []

    for (const row of body.rows) {
      try {
        const fields: Record<string, unknown> = {
          project: { id: projectId },
          issuetype: { id: issueTypeId },
          summary: row.summary,
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: row.description || '' }] }],
          },
        }

        if (row.assigneeAccountId) fields.assignee = { accountId: row.assigneeAccountId }
        if (row.rdOwnerAccountId) fields.customfield_10428 = [{ accountId: row.rdOwnerAccountId }]
        if (row.verifierAccountIds.length > 0) {
          fields[verifierFieldId] = row.verifierAccountIds.map((id) => ({ accountId: id }))
          console.log(`[batch-create] ${row.summary} 驗證人員 → ${verifierFieldId}:`, JSON.stringify(fields[verifierFieldId]))
        }

        const start = toJiraDateTime(row.actualStart)
        const end = toJiraDateTime(row.actualEnd)
        const local = toJiraDateTime(row.localTestDone)
        const staging = toJiraDateTime(row.stagingDeploy)
        if (start) fields.customfield_10430 = start
        if (end) fields.customfield_10431 = end
        if (local) fields.customfield_10465 = local
        if (staging) fields.customfield_10466 = staging
        if (row.releaseDate) fields.customfield_10438 = row.releaseDate

        const resp = await fetch(`${baseUrl}/rest/api/3/issue`, {
          method: 'POST',
          headers: {
            Authorization: userAuth.auth,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fields }),
        })
        const data = (await resp.json()) as { key?: string; errors?: Record<string, string>; errorMessages?: string[]; warnings?: unknown }
        console.log(`[batch-create] ${row.summary} HTTP:${resp.status}`, data.errors ?? data.errorMessages ?? 'ok')

        if (!resp.ok) {
          const verifierErr = data.errors?.[verifierFieldId]
          if (verifierErr && row.verifierAccountIds.length === 1) {
            fields[verifierFieldId] = { accountId: row.verifierAccountIds[0] }
            console.log(`[batch-create] 改用單人格式重試 ${verifierFieldId}`)
            const retry = await fetch(`${baseUrl}/rest/api/3/issue`, {
              method: 'POST',
              headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields }),
            })
            const retryData = (await retry.json()) as { key?: string; errors?: unknown }
            if (!retry.ok) {
              results.push({ rowIndex: row.rowIndex, error: JSON.stringify(retryData.errors ?? retryData) })
            } else {
              results.push({ rowIndex: row.rowIndex, issueKey: retryData.key })
            }
            continue
          }
          results.push({ rowIndex: row.rowIndex, error: JSON.stringify(data.errors ?? data.errorMessages ?? data) })
        } else {
          results.push({ rowIndex: row.rowIndex, issueKey: data.key })
        }
      } catch (e) {
        results.push({ rowIndex: row.rowIndex, error: String(e) })
      }
    }

    const succeeded = results.filter((r) => r.issueKey).length
    const failed = results.filter((r) => r.error).length
    log(
      failed > 0 ? 'warn' : 'ok',
      getClientIP(req), userAuth.email,
      'Jira 批次開單',
      `成功 ${succeeded} 筆${failed > 0 ? `，失敗 ${failed} 筆` : ''}`,
    )
    res.json({ ok: true, results, succeeded, failed })
  } catch (error) {
    next(error)
  } finally {
    finishHeavyTask(heavyTaskToken)
  }
})

// POST /api/lark/sheets/writeback
router.post('/api/lark/sheets/writeback', async (req, res, next) => {
  try {
    const body = writebackSchema.parse(req.body)
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(body.sheetUrl)
    if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 Sheet URL' })

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

    const headerRange = sheetId ? `${sheetId}!A1:Z1` : 'A1:Z1'
    const headerResp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${headerRange}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const headerData = (await headerResp.json()) as { data?: { valueRange?: { values?: unknown[][] } } }
    const headers = ((headerData.data?.valueRange?.values?.[0] ?? []) as unknown[]).map(String)
    const targetCol = body.issueKeyColumn.toLowerCase()
    const keyColIndex = headers.findIndex(h => h.toLowerCase() === targetCol)

    if (keyColIndex === -1) {
      return res.status(400).json({ ok: false, message: `找不到欄位「${body.issueKeyColumn}」（試算表標題列：${headers.join(', ')}）` })
    }

    const colLetter = String.fromCharCode(65 + keyColIndex)

    const writeResults = await Promise.all(
      body.writes.map(async ({ rowIndex, issueKey }) => {
        const cell = `${colLetter}${rowIndex}`
        const range = sheetId ? `${sheetId}!${cell}:${cell}` : `${cell}:${cell}`
        const r = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueRange: { range, values: [[issueKey]] } }),
        })
        return { rowIndex, ok: r.ok }
      }),
    )

    res.json({ ok: true, results: writeResults })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /api/jira/batch-comment
 * 批次對多張 Jira Issue 新增評論，可選用 Gemini AI 格式化內容。
 * 若 AI 失敗（配額耗盡）會中斷整個 batch 並回傳已完成部分的結果。
 */
router.post('/api/jira/batch-comment', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })

    const body = batchCommentSchema.parse(req.body)
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const heavyTask = tryStartHeavyTask(req, 'jira-batch-comment', 'Jira 批次評論')
    if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
    const clientIP = getClientIP(req)
    const userEmail = userAuth.email

    // Generate a unique request ID and start background processing
    const requestId = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    commentJobStore.set(requestId, {
      status: 'running',
      createdAt: Date.now(),
      ownerEmail: userAuth.email,
      heavyTask: heavyTask.token,
      progress: { done: 0, total: body.comments.length, current: '' },
      callbacks: new Set(),
      progressCallbacks: new Set(),
    })

    // Return immediately so client doesn't time out
    res.json({ ok: true, requestId })

    // Run the batch in background
    ;(async () => {
      const results: { rowIndex: number; issueKey: string; ok: boolean; usedAi?: boolean; error?: string }[] = []

      const isGeminiError = (err: unknown) => {
        const msg = String(err)
        return msg.includes('Gemini') || msg.includes('配額') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')
      }

      let stoppedByAi: string | null = null

      const total = body.comments.length

      for (const item of body.comments) {
        if (stoppedByAi) break

        // Push "currently processing" progress before starting this item
        pushCommentProgress(requestId, { done: results.length, total, current: item.issueKey })

        let commentText = item.rawComment
        let usedAi = false

        if (item.useAi) {
          const hasAnyContent = commentText.trim() || item.environment || item.version || item.platform
          if (!hasAnyContent) {
            console.warn(`[batch-comment] ${item.issueKey} 無任何內容，跳過 AI`)
          } else {
            try {
              console.log(`[batch-comment] ${item.issueKey} 呼叫 Gemini AI...`)
              commentText = await withRequestOperation(
                `Jira 批次評論（${item.issueKey}）`,
                () => formatCommentWithGemini({
                  rawText: commentText,
                  promptId: item.promptId,
                  environment: item.environment,
                  version: item.version,
                  platform: item.platform,
                  machineId: item.machineId,
                  gameMode: item.gameMode,
                  modelSpec: body.modelSpec,
                }),
              )
              usedAi = true
              console.log(`[batch-comment] ${item.issueKey} AI 完成，字數：${commentText.length}`)
            } catch (aiErr) {
              stoppedByAi = String(aiErr)
              console.error(`[batch-comment] ${item.issueKey} AI 失敗，中斷 batch：`, aiErr)
              results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, usedAi: false, error: `AI 中斷：${stoppedByAi}` })
              pushCommentProgress(requestId, { done: results.length, total, current: '' })
              break
            }
          }
        }

        // 分類附件 URL：影片 → 寫進評論內文；圖片 → 上傳附件
        const attachUrls = item.attachmentUrls ?? []
        const videoLinks: string[] = []
        const imageAttachUrls: { type: 'lark' | 'gdrive'; url: string; fileId?: string }[] = []

        for (const url of attachUrls) {
          if (isGoogleDriveUrl(url)) {
            const fileId = parseGoogleDriveFileId(url)
            if (!fileId) { videoLinks.push(url); continue }
            const ftype = await detectGoogleDriveFileType(fileId)
            if (ftype === 'video') videoLinks.push(url)
            else imageAttachUrls.push({ type: 'gdrive', url, fileId })
          } else {
            imageAttachUrls.push({ type: 'lark', url })
          }
        }

        // 影片連結附加到評論內文
        if (videoLinks.length > 0) {
          commentText = (commentText ? commentText + '\n\n' : '') +
            '📎 影片連結：\n' + videoLinks.map(u => `• ${u}`).join('\n')
        }

        try {
          const adfBody = textToADF(commentText || '（無內容）')
          const resp = await fetch(`${baseUrl}/rest/api/3/issue/${item.issueKey}/comment`, {
            method: 'POST',
            headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: adfBody }),
          })
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({})) as { errorMessages?: string[] }
            results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, usedAi, error: errData.errorMessages?.join(', ') ?? `HTTP ${resp.status}` })
          } else {
            // 上傳圖片附件（Lark Drive + Google Drive）
            if (imageAttachUrls.length > 0) {
              let larkToken: string | null = null
              let attachOk = 0; let attachFail = 0
              for (const att of imageAttachUrls) {
                try {
                  let buffer: Buffer, filename: string, mimeType: string
                  if (att.type === 'gdrive' && att.fileId) {
                    ;({ buffer, filename, mimeType } = await downloadGoogleDriveFile(att.fileId))
                  } else {
                    const fileToken = parseLarkFileToken(att.url)
                    if (!fileToken) { attachFail++; continue }
                    if (!larkToken) larkToken = await getLarkToken()
                    ;({ buffer, filename, mimeType } = await downloadLarkFile(fileToken, larkToken))
                  }
                  await uploadAttachmentToJira(item.issueKey, filename, buffer, mimeType, userAuth.auth, baseUrl)
                  attachOk++
                } catch (attErr) {
                  attachFail++
                  console.warn(`[batch-comment] ${item.issueKey} 附件上傳失敗 (${att.url}):`, attErr)
                }
              }
              console.log(`[batch-comment] ${item.issueKey} 附件：${attachOk} 成功${attachFail > 0 ? `，${attachFail} 失敗` : ''}${videoLinks.length > 0 ? `，${videoLinks.length} 影片寫入評論` : ''}`)
            }
            results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: true, usedAi })
          }
        } catch (jiraErr) {
          if (isGeminiError(jiraErr)) {
            stoppedByAi = String(jiraErr)
            results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, usedAi, error: `AI 中斷：${stoppedByAi}` })
            pushCommentProgress(requestId, { done: results.length, total, current: '' })
            break
          }
          results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, usedAi, error: String(jiraErr) })
        }

        // Push progress after each item completes
        pushCommentProgress(requestId, { done: results.length, total, current: item.issueKey })
      }

      const okCount = results.filter(r => r.ok).length
      const failCount = results.filter(r => !r.ok).length
      const aiUsed = results.filter(r => r.usedAi).length
      log(
        stoppedByAi ? 'warn' : failCount > 0 ? 'warn' : 'ok',
        clientIP, userEmail,
        'Jira 批次評論',
        `成功 ${okCount} 筆${aiUsed > 0 ? `（AI ${aiUsed} 筆）` : ''}${failCount > 0 ? `，失敗 ${failCount} 筆` : ''}${stoppedByAi ? '，AI 中斷' : ''}`,
      )
      addHistory('jira-comment', `Jira 批次評論`, `成功 ${okCount} 筆${failCount > 0 ? `，失敗 ${failCount} 筆` : ''}${stoppedByAi ? '，AI 中斷' : ''}`, { results })

      finishCommentJob(requestId, {
        ok: !stoppedByAi,
        results,
        ...(stoppedByAi ? { stopped: true, stoppedReason: stoppedByAi } : {}),
      })
    })().catch(err => {
      console.error('[batch-comment] background error:', err)
      finishCommentJob(requestId, { ok: false, results: [{ rowIndex: 0, issueKey: '', ok: false, error: String(err) }] })
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/jira/batch-comment/stream
 * SSE stream — pushes result when background batch-comment job completes.
 */
router.get('/api/jira/batch-comment/stream', (req, res) => {
  const requestId = req.query.requestId as string
  const email = String(req.query.email ?? '').trim()
  if (!requestId) return res.status(400).json({ ok: false, message: 'missing requestId' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const sendResult = (result: CommentJobResult) => {
    res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
    res.end()
  }

  const sendProgress = (progress: CommentJobProgress) => {
    res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`)
  }

  const job = commentJobStore.get(requestId)
  if (!job) {
    res.write(`event: result\ndata: ${JSON.stringify({ ok: false, results: [], error: 'job not found' })}\n\n`)
    return res.end()
  }
  if (!email || email.toLowerCase() !== job.ownerEmail.toLowerCase()) {
    res.write(`event: result\ndata: ${JSON.stringify({ ok: false, results: [], error: 'forbidden' })}\n\n`)
    return res.end()
  }

  if (job.status === 'done' && job.result) {
    return sendResult(job.result)
  }

  // Send current progress snapshot immediately so client knows total
  sendProgress(job.progress)

  // Still running — register callbacks and send heartbeat
  job.callbacks.add(sendResult)
  job.progressCallbacks.add(sendProgress)
  const heartbeat = setInterval(() => { res.write(': heartbeat\n\n') }, 15_000)

  res.on('close', () => {
    clearInterval(heartbeat)
    job.callbacks.delete(sendResult)
    job.progressCallbacks.delete(sendProgress)
  })
})

/**
 * GET /api/jira/batch-comment/status/:requestId
 * Polling fallback when SSE stream disconnects.
 */
router.get('/api/jira/batch-comment/status/:requestId', (req, res) => {
  const userAuth = userJiraAuth(req)
  if (!userAuth) return res.status(401).json({ ok: false, status: 'forbidden', message: '請先選擇帳號' })
  const { requestId } = req.params
  const job = commentJobStore.get(requestId)
  if (!job) return res.status(404).json({ ok: false, status: 'missing', message: 'job not found' })
  if (userAuth.email.toLowerCase() !== job.ownerEmail.toLowerCase()) {
    return res.status(403).json({ ok: false, status: 'forbidden', message: 'forbidden' })
  }
  if (job.status === 'running') {
    return res.json({ ok: true, status: 'running', progress: job.progress })
  }
  return res.json({ ok: true, status: 'done', progress: job.progress, result: job.result })
})

// POST /api/jira/batch-transition
router.post('/api/jira/batch-transition', async (req, res, next) => {
  let heavyTaskToken: HeavyTaskToken | null = null
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })

    const heavyTask = tryStartHeavyTask(req, 'jira-batch-transition', 'Jira 批次狀態轉換')
    if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
    heavyTaskToken = heavyTask.token

    const body = batchTransitionSchema.parse(req.body)
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const defaultTransitionId = process.env.JIRA_TRANSITION_ID ?? '41'

    const results: { rowIndex: number; issueKey: string; ok: boolean; error?: string }[] = []

    for (const item of body.issues) {
      try {
        const resp = await fetch(`${baseUrl}/rest/api/3/issue/${item.issueKey}/transitions`, {
          method: 'POST',
          headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ transition: { id: item.transitionId ?? defaultTransitionId } }),
        })
        results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: resp.ok })
      } catch (e) {
        results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, error: String(e) })
      }
    }

    const ok = results.filter(r => r.ok).length
    const fail = results.filter(r => !r.ok).length
    log(
      fail > 0 ? 'warn' : 'ok',
      getClientIP(req), userAuth.email,
      'Jira 切換狀態',
      `成功 ${ok} 筆${fail > 0 ? `，失敗 ${fail} 筆` : ''}`,
    )
    res.json({ ok: true, results })
  } catch (error) {
    next(error)
  } finally {
    finishHeavyTask(heavyTaskToken)
  }
})

// POST /api/jira/pm-read-bitable
router.post('/api/jira/pm-read-bitable', async (req, res, next) => {
  try {
    const { bitableUrl } = z.object({ bitableUrl: z.string() }).parse(req.body)
    const { appToken, tableId } = parseBitableUrl(bitableUrl)
    if (!appToken || !tableId) return res.status(400).json({ ok: false, message: '無法解析 Lark Bitable URL，請確認格式' })
    const allRecords = await readPMBitableRecords(appToken, tableId)
    const pending = allRecords.filter(r => !r.jiraKey)
    res.json({ ok: true, records: pending, total: allRecords.length })
  } catch (error) { next(error) }
})

/**
 * POST /api/jira/pm-batch-create
 * PM 模式：讀取 Lark Bitable 後批次建立 Jira Issues，並自動關聯主單。
 * @rate-limit heavyLimiter — 每分鐘最多 15 次。
 * @concurrency 同一張 Bitable 表格同時只允許一個開單操作（per-table lock）。
 */
router.post('/api/jira/pm-batch-create', heavyLimiter, async (req, res, next) => {
  let heavyTaskToken: HeavyTaskToken | null = null
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })

    const heavyTask = tryStartHeavyTask(req, 'jira-pm-batch-create', 'Jira PM 批次開單')
    if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
    heavyTaskToken = heavyTask.token

    const { bitableUrl, parentIssueKey, recordIds } = z.object({
      bitableUrl: z.string(),
      parentIssueKey: z.string().optional(),
      recordIds: z.array(z.string()),
    }).parse(req.body)

    const { appToken, tableId } = parseBitableUrl(bitableUrl)

    const lockKey = `${appToken}:${tableId}`
    if (pmBatchLocks.has(lockKey)) {
      return res.status(409).json({ ok: false, message: '此表格正在開單中，請等待完成後再試' })
    }
    pmBatchLocks.add(lockKey)

    try {
      const baseUrl = mustEnv('JIRA_BASE_URL')
      const larkToken = await getLarkToken()
      const larkBase = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

      const projResp = await fetch(`${baseUrl}/rest/api/3/project/search?maxResults=200`, {
        headers: { Authorization: userAuth.auth, Accept: 'application/json' },
      })
      const projData = await projResp.json() as { values?: { id: string; key: string; name: string }[] }
      const jiraProjects = projData.values ?? []

      const allRecords = await readPMBitableRecords(appToken, tableId)
      const selected = allRecords.filter(r => recordIds.includes(r.recordId))

      const accountIdCache = new Map<string, string>()
      const resolveAccountId = async (email: string): Promise<string | undefined> => {
        if (!email) return undefined
        if (accountIdCache.has(email)) return accountIdCache.get(email)
        const r = await fetch(`${baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}&maxResults=1`, {
          headers: { Authorization: userAuth.auth, Accept: 'application/json' },
        })
        const users = await r.json() as Array<{ accountId: string; emailAddress: string }>
        const id = users.find(u => u.emailAddress?.toLowerCase() === email.toLowerCase())?.accountId
        if (id) accountIdCache.set(email, id)
        return id
      }

      const issueTypeCache = new Map<string, Array<{ id: string; name: string }>>()
      const getIssueTypes = async (projectId: string) => {
        if (issueTypeCache.has(projectId)) return issueTypeCache.get(projectId)!
        const r = await fetch(`${baseUrl}/rest/api/3/issuetype/project?projectId=${projectId}`, {
          headers: { Authorization: userAuth.auth, Accept: 'application/json' },
        })
        const data = await r.json() as Array<{ id: string; name: string; subtask: boolean }>
        const types = (Array.isArray(data) ? data : []).filter(t => !t.subtask).map(t => ({ id: t.id, name: t.name }))
        issueTypeCache.set(projectId, types)
        return types
      }

      const results: { recordId: string; issueKey?: string; summary?: string; error?: string; isParent?: boolean }[] = []
      const verifierFieldId = process.env.JIRA_VERIFIER_FIELD_ID ?? 'customfield_10440'

      const parentKeyMap = new Map<string, string>()
      const parentRecords = selected.filter(r => r.isParent)
      const childRecords = selected.filter(r => !r.isParent)
      const orderedRecords = [...parentRecords, ...childRecords]

      for (const record of orderedRecords) {
        try {
          const project = jiraProjects.find(p =>
            p.name === record.jiraProjectName ||
            p.name.includes(record.jiraProjectName) ||
            record.jiraProjectName.includes(p.name) ||
            record.jiraProjectName.includes(p.key)
          )
          if (!project) {
            results.push({ recordId: record.recordId, error: `找不到專案：${record.jiraProjectName}` })
            continue
          }

          const issueTypes = await getIssueTypes(project.id)
          const issueType = issueTypes.find(t => t.name.toLowerCase() === record.issueTypeName.toLowerCase()) ?? issueTypes[0]
          if (!issueType) {
            results.push({ recordId: record.recordId, error: `找不到議題類型：${record.issueTypeName}` })
            continue
          }

          const assigneeId = await resolveAccountId(record.assigneeEmail)
          const rdOwnerId = await resolveAccountId(record.rdOwnerEmail)

          const fields: Record<string, unknown> = {
            project: { id: project.id },
            issuetype: { id: issueType.id },
            summary: record.summary,
          }
          if (record.description) {
            fields.description = {
              type: 'doc', version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: record.description }] }],
            }
          }
          if (assigneeId) fields.assignee = { accountId: assigneeId }
          if (rdOwnerId) fields.customfield_10428 = [{ accountId: rdOwnerId }]
          // 難易度 → customfield_10433（DSFT 任務欄位，值與 Lark 相同：簡單/低/中/高/困難）
          const difficultyFieldId = process.env.JIRA_DIFFICULTY_FIELD_ID ?? 'customfield_10433'
          if (record.difficulty) fields[difficultyFieldId] = { value: record.difficulty }

          const createResp = await fetch(`${baseUrl}/rest/api/3/issue`, {
            method: 'POST',
            headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields }),
          })
          const createData = await createResp.json() as { key?: string; errors?: unknown; errorMessages?: string[] }
          if (!createResp.ok) {
            results.push({ recordId: record.recordId, error: JSON.stringify(createData.errors ?? createData.errorMessages ?? createData) })
            continue
          }

          // 用純標題（record.title）當 key，因為子單「選擇主單並關聯」填的永遠是純標題
          if (record.isParent && createData.key) parentKeyMap.set(record.title, createData.key)

          if (!record.isParent && createData.key) {
            const matchedParentKey = record.parentTitle
              ? parentKeyMap.get(record.parentTitle)
              : (parentIssueKey?.trim() || undefined)
            if (matchedParentKey) {
              await fetch(`${baseUrl}/rest/api/3/issueLink`, {
                method: 'POST',
                headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: { name: 'Relates' },
                  inwardIssue: { key: matchedParentKey },
                  outwardIssue: { key: createData.key },
                }),
              })
            }
          }

          // 回填至「單號連結」欄位（URL 型），顯示單號文字並帶超連結
          const issueUrl = `${baseUrl}/browse/${createData.key}`
          await fetch(`${larkBase}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${record.recordId}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${larkToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { '單號連結': { link: issueUrl, text: createData.key } } }),
          })

          results.push({ recordId: record.recordId, issueKey: createData.key, summary: record.summary, isParent: record.isParent })
          log('ok', 'pm-batch', userAuth.email, 'PM開單', `${createData.key}: ${record.summary}${record.isParent ? ' [主單]' : ''}`)
        } catch (e) {
          results.push({ recordId: record.recordId, error: String(e) })
        }
      }

      const succeeded = results.filter(r => r.issueKey).length
      const failed = results.filter(r => r.error).length
      addHistory('jira', 'PM 批次開單', `成功 ${succeeded} 筆，失敗 ${failed} 筆`, { results })
      res.json({ ok: true, results })
    } finally {
      pmBatchLocks.delete(lockKey)
    }
  } catch (error) { next(error) }
  finally { finishHeavyTask(heavyTaskToken) }
})

/**
 * server/routes/jira.ts
 * All /api/jira/*, /api/admin/*, /api/lark/sheets/* routes.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Router } from 'express'
import multer from 'multer'
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
import { callLLM, readGeminiPrompts, renderPrompt } from './gemini.js'
import { multiWritebackLark, type MultiWrite } from './integrations.js'
import { getAuthAccount } from '../auth-session.js'
import { withRequestOperation } from '../request-context.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'

export const router = Router()

// ─── Attachment cache ──────────────────────────────────────────────────────────
const ATTACH_CACHE_DIR = join(process.cwd(), 'server', 'attachment-cache')
if (!existsSync(ATTACH_CACHE_DIR)) mkdirSync(ATTACH_CACHE_DIR, { recursive: true })
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB (Jira Cloud default limit)

function cleanAttachmentCache() {
  try {
    const now = Date.now()
    for (const f of readdirSync(ATTACH_CACHE_DIR)) {
      const fp = join(ATTACH_CACHE_DIR, f)
      try { if (now - statSync(fp).mtimeMs > 2 * 60 * 60 * 1000) unlinkSync(fp) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ─── Multer for manual attachment upload ──────────────────────────────────────
const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
})

/** POST /api/jira/attachment-upload — manual file upload from browser, saved to cache */
router.post('/api/jira/attachment-upload', (req, res) => {
  multerUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const isLimit = (err as { code?: string }).code === 'LIMIT_FILE_SIZE'
      return res.status(400).json({
        ok: false,
        message: isLimit ? `檔案超過 10MB 限制（Jira Cloud 預設上限）` : `上傳失敗：${String(err)}`,
      })
    }
    const file = req.file
    if (!file) return res.status(400).json({ ok: false, message: '未收到檔案' })
    const cacheId = randomUUID()
    writeFileSync(join(ATTACH_CACHE_DIR, cacheId), file.buffer)
    const mimeType = file.mimetype || 'application/octet-stream'
    return res.json({
      ok: true,
      cacheId,
      filename: file.originalname,
      mimeType,
      size: file.size,
      isImage: mimeType.startsWith('image/'),
      isVideo: mimeType.startsWith('video/'),
    })
  })
})

// ─── Batch-comment job store (SSE background processing) ──────────────────────
interface CommentJobResult {
  ok: boolean
  results: { rowIndex: number; issueKey: string; ok: boolean; usedAi?: boolean; error?: string }[]
  stopped?: boolean
  stoppedReason?: string
  // 區分「為什麼中斷」，前端顯示文字依這個分支，不要籠統套用舊有的 Gemini 專用文案
  stoppedKind?: 'ai_quota' | 'worker_restart'
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
  /** 發起這個 job 的人（登入者）。SSE／status 的擁有者檢查都用這個，不是執行身分。 */
  ownerEmail: string
  /** 實際用來打 Jira 的帳號。建立 job 當下就固化，背景執行不再重新推導，避免狀態漂移。 */
  commentAsEmail?: string
  heavyTask?: HeavyTaskToken
  callbacks: Set<(result: CommentJobResult) => void>
  progressCallbacks: Set<(progress: CommentJobProgress) => void>
  // 累積中的逐筆結果——跟迴圈裡的 results 陣列是同一個參考（job 建立後馬上指派一次），
  // 純粹只是為了讓 worker 重啟復原時能讀到「目前已經處理到哪幾筆」，不是額外複製一份資料
  resultsSoFar?: CommentJobResult['results']
}
const commentJobStore = new Map<string, CommentJobEntry>()

// jira_comment_jobs 持久化：batch-comment 是背景 IIFE，worker 重啟會直接把還在跑的那個
// async function 整個砍掉（跟 AutoSpin 不同——AutoSpin 的重活是在獨立的 Python process 裡，
// worker 重啟不會殺死它，只是伺服器端記錄暫時消失；這裡的重活就是 Node worker 自己在做，
// process 死了工作就真的斷在那裡，沒辦法憑空恢復）。不嘗試自動恢復繼續發送剩下的留言
// （自動重試有機率造成同一筆留言重複貼兩次，比起「使用者自己確認後手動重跑剩下幾筆」風險更高，
// 對留言這種不能撤銷的操作不值得冒險）；只確保 worker 重啟後，使用者能透過既有的 polling/SSE
// 拿到一個「明確、可行動」的中斷訊息（已完成幾筆、還剩幾筆沒處理過），不再是含糊的 job not found。
function persistCommentJobSnapshot(requestId: string) {
  const job = commentJobStore.get(requestId)
  if (!job) return
  const { callbacks: _cb, progressCallbacks: _pcb, ...serializable } = job
  db.prepare(`
    INSERT INTO jira_comment_jobs (requestId, data, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(requestId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
  `).run(requestId, JSON.stringify(serializable), Date.now())
}

function pushCommentProgress(requestId: string, progress: CommentJobProgress) {
  const job = commentJobStore.get(requestId)
  if (!job) return
  job.progress = progress
  job.progressCallbacks.forEach(cb => cb(progress))
  persistCommentJobSnapshot(requestId)
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
  persistCommentJobSnapshot(requestId)
  // Clean up after 5 minutes（記憶體）；DB 那份留久一點方便事後查證，交給下面的開機清理
  setTimeout(() => commentJobStore.delete(requestId), 5 * 60 * 1000)
}

// worker 啟動時：把 DB 裡還標示 'running' 的 job 撈出來——這些必然是上次還沒跑完就被砍掉的
// （這個 process 剛啟動，不可能有任何 job 真的還在跑），標記成中斷並附上目前為止的實際進度，
// 讓使用者透過既有的 status polling/SSE 拿到明確訊息，而不是「job not found」。超過 24 小時的
// 舊 row 直接清掉，不留著佔位。
{
  const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000
  const now = Date.now()
  const rows = db.prepare('SELECT requestId, data, updatedAt FROM jira_comment_jobs').all() as
    { requestId: string; data: string; updatedAt: number }[]
  let recovered = 0
  for (const row of rows) {
    if (now - row.updatedAt > CLEANUP_MAX_AGE_MS) {
      db.prepare('DELETE FROM jira_comment_jobs WHERE requestId = ?').run(row.requestId)
      continue
    }
    try {
      const parsed = JSON.parse(row.data) as Omit<CommentJobEntry, 'callbacks' | 'progressCallbacks'>
      if (parsed.status !== 'running') continue
      const doneResults = parsed.resultsSoFar ?? []
      const total = parsed.progress?.total ?? doneResults.length
      const interruptedResult: CommentJobResult = {
        ok: false,
        results: doneResults,
        stopped: true,
        stoppedKind: 'worker_restart',
        stoppedReason: `伺服器重啟，已完成 ${doneResults.length}/${total} 筆，剩餘 ${total - doneResults.length} 筆未處理，請確認 Jira 上的實際狀態後手動重新執行剩下的部分`,
      }
      commentJobStore.set(row.requestId, {
        status: 'done',
        result: interruptedResult,
        progress: parsed.progress ?? { done: doneResults.length, total, current: '' },
        createdAt: parsed.createdAt ?? now,
        ownerEmail: parsed.ownerEmail ?? '',
        callbacks: new Set(),
        progressCallbacks: new Set(),
      })
      db.prepare('UPDATE jira_comment_jobs SET data = ?, updatedAt = ? WHERE requestId = ?')
        .run(JSON.stringify({ ...parsed, status: 'done', result: interruptedResult }), now, row.requestId)
      recovered++
    } catch {
      db.prepare('DELETE FROM jira_comment_jobs WHERE requestId = ?').run(row.requestId)
    }
  }
  if (recovered > 0) console.log(`[jira] 已標記 ${recovered} 筆中斷的批量評論 job（worker 重啟前未完成）`)
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
      summary: z.string().default(''),
      description: z.string().optional().default(''),
      assigneeAccountId: z.string().optional(),
      rdOwnerAccountId: z.string().optional(),
      reporterAccountId: z.string().optional(),
      verifierAccountIds: z.array(z.string()).default([]),
      actualStart: z.string().optional(),
      actualEnd: z.string().optional(),
      localTestDone: z.string().optional(),
      stagingDeploy: z.string().optional(),
      releaseDate: z.string().optional(),
      dynamicFields: z.record(z.string(), z.unknown()).optional().default({}),
      rowIndex: z.number(),
      cachedAttachments: z.array(z.object({
        cacheId: z.string(),
        filename: z.string(),
        mimeType: z.string(),
        isImage: z.boolean(),
        isVideo: z.boolean(),
      })).optional().default([]),
    }),
  ),
  sheetUrl: z.string(),
  projectId: z.string().optional(),
  projectKey: z.string().optional(),
  issueTypeId: z.string().optional(),
})

const writebackSchema = z.object({
  sheetUrl: z.string(),
  writes: z.array(z.object({ rowIndex: z.number(), issueKey: z.string() })),
  issueKeyColumn: z.string().default('Jira Issue Key'),
})

const batchCommentSchema = z.object({
  modelSpec: z.string().optional(),
  specContext: z.string().optional(),  // 全域規格書參考段落，用於 {{specContext}} 佔位符
  knowledgeDocIds: z.array(z.number()).optional().default([]),  // 知識庫文件 ID 清單
  comments: z.array(z.object({
    issueKey: z.string(),
    rowIndex: z.number(),
    rawComment: z.string(),
    // useAi 是舊旗標，同時代表「AI 排版」與「AI 完整性分析」。2026-08-20 拆成兩個獨立旗標，
    // 但保留 useAi 當 fallback，舊的呼叫端（含尚未更新的分頁）行為完全不變。
    useAi: z.boolean().default(false),
    aiFormat: z.boolean().optional(),
    aiReview: z.boolean().optional(),
    /** 這一列要用誰的身分張貼（逐列代發）。後端一定會重新驗證授權，不信前端說了算。 */
    commentAsEmail: z.string().optional(),
    promptId: z.string().optional(),
    environment: z.string().optional(),
    version: z.string().optional(),
    platform: z.string().optional(),
    machineId: z.string().optional(),
    gameMode: z.string().optional(),
    attachmentUrls: z.array(z.string()).optional().default([]),
    issueSummary: z.string().optional(),    // for AI analysis second comment
    issueDescription: z.string().optional(), // for AI analysis second comment
    cachedAttachments: z.array(z.object({
      cacheId: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      isImage: z.boolean(),
      isVideo: z.boolean(),
    })).optional().default([]),
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
  specContext?: string
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
const textToADF = (text: string) => {
  if (!text || !text.trim()) {
    return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] }
  }
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map(line => ({
      type: 'paragraph',
      content: line.trim() ? [{ type: 'text', text: line }] : [],
    })),
  }
}

/** 從 Lark 分享連結或 Drive URL 中提取 file_token */
function parseLarkFileToken(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  // Plain filename (has extension but no scheme/slash) — not a valid token or URL
  if (!trimmed.includes('/') && !trimmed.includes('?')) {
    if (/\.[a-z0-9]{2,5}$/i.test(trimmed)) return null  // looks like a filename, e.g. "video.mp4"
    return trimmed  // bare token string (no extension)
  }
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
async function uploadAttachmentToJira(issueKey: string, filename: string, buffer: Buffer, mimeType: string, auth: string, baseUrl: string): Promise<string> {
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
  const data = await resp.json().catch(() => []) as Array<{ filename?: string }>
  const storedFilename = data[0]?.filename ?? filename
  if (storedFilename !== filename) {
    console.log(`[upload-attachment] filename changed: "${filename}" → "${storedFilename}"`)
  }
  return storedFilename
}

/** 判斷 URL 是否為 Lark embed-image 內嵌圖片 URL（非 Drive 下載路徑） */
function isLarkEmbedImageUrl(url: string): boolean {
  return url.includes('mount_point=sheet_image') || url.includes('/space/api/box/stream/download/')
}

/** 下載 Lark Sheet embed-image（使用 Lark media download API） */
async function downloadLarkEmbedImage(link: string, larkToken: string): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  // Extract fileToken from URL path: .../cover/{fileToken}/...
  const fileTokenMatch = link.match(/\/cover\/([A-Za-z0-9_-]+)\//)
  if (!fileTokenMatch) throw new Error('Cannot parse embed-image file token from link')
  const fileToken = fileTokenMatch[1]
  const urlObj = new URL(link)
  const mountNodeToken = urlObj.searchParams.get('mount_node_token') ?? ''
  const mountPoint = urlObj.searchParams.get('mount_point') ?? 'sheet_image'
  const extra = encodeURIComponent(JSON.stringify({ fileType: 'image', mount_node_token: mountNodeToken, mount_point: mountPoint }))
  const resp = await fetch(`${base}/open-apis/drive/v1/medias/${fileToken}/download?extra=${extra}`, {
    headers: { Authorization: `Bearer ${larkToken}` },
  })
  if (!resp.ok) throw new Error(`Lark media download failed: HTTP ${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  const cd = resp.headers.get('content-disposition') ?? ''
  const fnMatch = cd.match(/filename\*=UTF-8''(.+)/i) ?? cd.match(/filename="?([^";\r\n]+)"?/i)
  const filename = fnMatch ? decodeURIComponent(fnMatch[1].trim()) : `image_${fileToken}.jpg`
  const mimeType = resp.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg'
  return { buffer, filename, mimeType }
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
  const { rawText, promptId, environment = '', version = '', platform = '', machineId = '', gameMode = '', specContext = '', modelSpec } = ctx

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
    specContext: specContext || '',
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
  // Direct Bitable: /base/APP_TOKEN?table=TABLE_ID
  const appMatch = url.match(/\/base\/([A-Za-z0-9]+)/)
  const tableMatch = url.match(/[?&]table=([A-Za-z0-9]+)/)
  if (appMatch?.[1] && tableMatch?.[1]) return { appToken: appMatch[1], tableId: tableMatch[1] }
  // Wiki embedded: /wiki/WIKI_TOKEN?...&sheet=TABLE_ID
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/)
  const sheetMatch = url.match(/[?&]sheet=([A-Za-z0-9]+)/)
  return { appToken: appMatch?.[1] ?? wikiMatch?.[1] ?? '', tableId: tableMatch?.[1] ?? sheetMatch?.[1] ?? '' }
}

function larkTextField(val: unknown): string {
  if (!val) return ''
  if (Array.isArray(val)) return (val as { text: string }[]).map(v => v.text ?? '').join('')
  if (typeof val === 'string') return val
  return ''
}

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
// 允許自助新增帳號；覆蓋已存在帳號的 token 需要 admin 身份
router.post('/api/jira/accounts', writeLimiter, (req, res, next) => {
  try {
    const body = accountAddSchema.parse(req.body)
    const exists = readAccounts().some((a) => a.email === body.email)
    if (exists) {
      const caller = getAuthAccount(req)
      if (!caller || caller.role !== 'admin') {
        return res.status(403).json({ ok: false, message: '此帳號已存在，只有管理員可以覆蓋' })
      }
    }
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
      const allUsers: Array<{ accountId: string; displayName?: string; avatarUrls?: Record<string, string> }> = []
      let startAt = 0
      const pageSize = 100
      while (true) {
        const resp = await fetch(
          `${baseUrl}/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=${pageSize}&startAt=${startAt}`,
          { headers: { Authorization: userAuth.auth, Accept: 'application/json' } }
        )
        if (!resp.ok) return res.status(resp.status).json({ ok: false, message: `Jira API error: ${resp.status}` })
        const data = await resp.json() as Array<{ accountId: string; displayName?: string; avatarUrls?: Record<string, string> }>
        if (!Array.isArray(data) || data.length === 0) break
        allUsers.push(...data)
        if (data.length < pageSize) break
        startAt += pageSize
      }
      const members = allUsers
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
    const pageSize = 100
    let startAt = 0
    const allProjects: { id: string; key: string; name: string }[] = []
    while (true) {
      const resp = await fetch(`${baseUrl}/rest/api/3/project/search?maxResults=${pageSize}&startAt=${startAt}&orderBy=NAME`, {
        headers: { Authorization: userAuth.auth, Accept: 'application/json' },
      })
      if (!resp.ok) return res.status(resp.status).json({ ok: false, message: `Jira API error: ${resp.status}` })
      const data = await resp.json() as { values?: { id: string; key: string; name: string }[]; isLast?: boolean; total?: number }
      const page = (data.values ?? []).map(p => ({ id: p.id, key: p.key, name: p.name }))
      allProjects.push(...page)
      if (data.isLast || page.length < pageSize) break
      startAt += pageSize
    }
    res.json({ ok: true, projects: allProjects })
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

// ─── Jira dynamic field meta (createmeta proxy) ───────────────────────────────

interface NormalizedJiraField {
  key: string
  name: string
  required: boolean
  type: 'string' | 'text' | 'number' | 'date' | 'datetime' | 'select' | 'multiselect' | 'user' | 'multiuser' | 'unknown'
  options?: { id: string; label: string }[]
  autoCompleteUrl?: string
}

// NOTE: 'reporter'（回報人）刻意保留在欄位清單中，讓動態開單可以指定回報人
const SKIP_FIELD_KEYS = new Set(['issuetype', 'project', 'parent', 'attachment', 'issuelinks', 'subtasks', 'worklog', 'comment', 'thumbnail', 'timetracking', 'timespent', 'timeestimate', 'aggregatetimespent', 'aggregatetimeestimate'])
const SKIP_FIELD_NAMES = new Set<string>([])
// Field meta cache: `projectKey:issueTypeName` → { fields, expiresAt }
const fieldMetaCache = new Map<string, { fields: NormalizedJiraField[]; expiresAt: number }>()

function normalizeJiraField(key: string, meta: Record<string, unknown>): NormalizedJiraField | null {
  if (SKIP_FIELD_KEYS.has(key)) return null
  const name = (meta.name as string) || key
  const normalizedName = name.trim().toLowerCase()
  if (SKIP_FIELD_NAMES.has(normalizedName) || SKIP_FIELD_NAMES.has(name.trim())) return null
  const required = !!(meta.required)
  const schema = meta.schema as Record<string, unknown> | undefined
  const schemaType = schema?.type as string | undefined
  const schemaItems = schema?.items as string | undefined
  const schemaCustom = schema?.custom as string | undefined
  const allowedValues = meta.allowedValues as Array<{ id?: string; accountId?: string; displayName?: string; name?: string; value?: string }> | undefined
  const autoCompleteUrl = meta.autoCompleteUrl as string | undefined

  let type: NormalizedJiraField['type'] = 'string'
  if (schemaType === 'array' && schemaItems === 'user') {
    type = 'multiuser'
  } else if (schemaType === 'user') {
    type = 'user'
  } else if (allowedValues && allowedValues.length > 0) {
    type = schemaType === 'array' ? 'multiselect' : 'select'
  } else if (schemaType === 'date') {
    type = 'date'
  } else if (schemaType === 'datetime') {
    type = 'datetime'
  } else if (schemaType === 'number') {
    type = 'number'
  } else if (schemaCustom?.includes('textarea') || key === 'description' || key === 'environment') {
    type = 'text'
  }

  const field: NormalizedJiraField = { key, name, required, type }
  if (allowedValues && allowedValues.length > 0) {
    field.options = allowedValues
      .map(v => ({
        id: v.accountId ?? v.id ?? v.name ?? v.value ?? '',
        label: v.displayName ?? v.name ?? v.value ?? v.id ?? v.accountId ?? '',
      }))
      .filter(o => o.id)
  }
  if (autoCompleteUrl && (type === 'user' || type === 'multiuser')) field.autoCompleteUrl = autoCompleteUrl
  return field
}

async function fetchUserFieldOptions(autoCompleteUrl: string, auth: string, baseUrl: string, query = ''): Promise<{ id: string; label: string }[]> {
  const url = new URL(autoCompleteUrl, baseUrl)
  const jiraOrigin = new URL(baseUrl).origin
  if (url.origin !== jiraOrigin) { console.warn(`[fetchUserFieldOptions] origin mismatch: ${url.origin} vs ${jiraOrigin}`); return [] }
  // 注意：不可帶 username 參數，Jira Cloud GDPR 嚴格模式會對 user/assignable/search 回 400
  url.searchParams.set('query', query)
  url.searchParams.delete('username')
  url.searchParams.set('maxResults', '200')

  const resp = await fetch(url.toString(), { headers: { Authorization: auth, Accept: 'application/json' } })
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '')
    console.warn(`[fetchUserFieldOptions] HTTP ${resp.status} for ${url.pathname}: ${errBody.slice(0, 200)}`)
    return []
  }
  const data = await resp.json() as unknown
  // Jira may return array directly, or { users: [...] } (groupuserpicker), or { results: [...] }
  const rawUsers: Record<string, unknown>[] = Array.isArray(data)
    ? data as Record<string, unknown>[]
    : Array.isArray((data as Record<string, unknown>)?.users)
      ? (data as Record<string, unknown>).users as Record<string, unknown>[]
      : Array.isArray((data as Record<string, unknown>)?.results)
        ? (data as Record<string, unknown>).results as Record<string, unknown>[]
        : []

  return rawUsers
    .map((u) => {
      const accountId = typeof u.accountId === 'string' ? u.accountId : ''
      const label = String(u.displayName ?? u.name ?? u.value ?? accountId)
        .replace(/<[^>]*>/g, '')
        .trim()
      return { id: accountId, label: label || accountId }
    })
    .filter((u) => u.id)
}

async function fetchNormalizedJiraFields(projectKey: string, issueTypeId: string, issueTypeName: string, auth: string, baseUrl: string): Promise<NormalizedJiraField[]> {
  const issueTypeFilter = issueTypeId
    ? `&issuetypeIds=${encodeURIComponent(issueTypeId)}`
    : `&issuetypeNames=${encodeURIComponent(issueTypeName)}`
  const url = `${baseUrl}/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}${issueTypeFilter}&expand=projects.issuetypes.fields`
  console.log(`[jira-fields] fetching: ${url}`)
  const resp = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } })
  if (!resp.ok) throw new Error(`Jira createmeta API error: ${resp.status}`)

  const data = await resp.json() as { projects?: Array<{ issuetypes?: Array<{ fields?: Record<string, Record<string, unknown>> }> }> }
  console.log(`[jira-fields] issueTypeId="${issueTypeId}" issueTypeName="${issueTypeName}" projects=${data.projects?.length ?? 0}, issueTypes=${data.projects?.[0]?.issuetypes?.length ?? 0}, rawFields=${Object.keys(data.projects?.[0]?.issuetypes?.[0]?.fields ?? {}).length}`)
  const rawFields = data.projects?.[0]?.issuetypes?.[0]?.fields ?? {}

  const fields: NormalizedJiraField[] = []
  for (const [key, meta] of Object.entries(rawFields)) {
    const normalized = normalizeJiraField(key, meta)
    if (normalized) fields.push(normalized)
  }
  await Promise.all(fields.map(async (field) => {
    if ((field.type === 'user' || field.type === 'multiuser') && field.autoCompleteUrl && !field.options?.length) {
      const options = await fetchUserFieldOptions(field.autoCompleteUrl, auth, baseUrl)
      if (options.length > 0) field.options = options
    }
  }))
  console.log(`[jira-fields] normalized fields count: ${fields.length}`)
  return fields
}

function resolveUserFieldValue(field: NormalizedJiraField | undefined, value: unknown): unknown {
  if (!field || (field.type !== 'user' && field.type !== 'multiuser')) return value
  const options = field.options ?? []
  const resolveOne = (raw: unknown): string => {
    const token = typeof raw === 'object' && raw !== null
      ? String((raw as Record<string, unknown>).accountId ?? (raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).displayName ?? '')
      : String(raw ?? '')
    const trimmed = token.trim()
    const lowered = trimmed.toLowerCase()
    const option = options.find(o => o.id.toLowerCase() === lowered || o.label.toLowerCase() === lowered)
    return option?.id ?? trimmed
  }

  if (field.type === 'multiuser') {
    const values = Array.isArray(value)
      ? value.map(resolveOne)
      : String(value ?? '').split(',').map(resolveOne)
    return values.filter(Boolean).map(accountId => ({ accountId }))
  }

  const accountId = resolveOne(value)
  return accountId ? { accountId } : value
}

// GET /api/jira/fields?projectKey=X&issueTypeName=Y
router.get('/api/jira/fields', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const projectKey = String(req.query.projectKey ?? '').trim()
    const issueTypeName = String(req.query.issueTypeName ?? '').trim()
    const issueTypeId = String(req.query.issueTypeId ?? '').trim()
    if (!projectKey || !issueTypeName) return res.status(400).json({ ok: false, message: 'projectKey 和 issueTypeName 為必填' })

    const cacheKey = `${projectKey}:${issueTypeId || issueTypeName}`
    const cached = fieldMetaCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ ok: true, fields: cached.fields, fromCache: true })
    }

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const fields = await fetchNormalizedJiraFields(projectKey, issueTypeId, issueTypeName, userAuth.auth, baseUrl)
    // Sort: required first, summary always first among required
    fields.sort((a, b) => {
      if (a.key === 'summary') return -1
      if (b.key === 'summary') return 1
      if (a.required && !b.required) return -1
      if (!a.required && b.required) return 1
      return a.name.localeCompare(b.name)
    })

    fieldMetaCache.set(cacheKey, { fields, expiresAt: Date.now() + 10 * 60 * 1000 })
    res.json({ ok: true, fields })
  } catch (error) {
    next(error)
  }
})

// GET /api/jira/editmeta?issueKey=X — 取得指定 Issue 的可編輯欄位清單
router.get('/api/jira/editmeta', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const issueKey = String(req.query.issueKey ?? '').trim()
    if (!issueKey) return res.status(400).json({ ok: false, message: 'issueKey 為必填' })

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const resp = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}/editmeta`, {
      headers: { Authorization: userAuth.auth, Accept: 'application/json' },
    })
    if (!resp.ok) return res.status(resp.status).json({ ok: false, message: `Jira editmeta error: ${resp.status}` })

    const data = await resp.json() as { fields?: Record<string, Record<string, unknown>> }
    const rawFields = data.fields ?? {}
    const fields: NormalizedJiraField[] = []
    for (const [key, meta] of Object.entries(rawFields)) {
      const normalized = normalizeJiraField(key, meta)
      if (normalized) fields.push(normalized)
    }
    await Promise.all(fields.map(async (field) => {
      if ((field.type === 'user' || field.type === 'multiuser') && field.autoCompleteUrl && !field.options?.length) {
        console.log(`[editmeta] fetching user options for ${field.key} (${field.name}) via: ${field.autoCompleteUrl}`)
        const options = await fetchUserFieldOptions(field.autoCompleteUrl, userAuth.auth, baseUrl)
        console.log(`[editmeta] ${field.key} returned ${options.length} users`)
        if (options.length > 0) field.options = options
      }
    }))
    fields.sort((a, b) => {
      if (a.key === 'summary') return -1
      if (b.key === 'summary') return 1
      return a.name.localeCompare(b.name)
    })
    res.json({ ok: true, fields })
  } catch (error) { next(error) }
})

// GET /api/jira/field-users?projectKey&issueTypeId&issueTypeName&fieldKey&query
// 依使用者輸入的關鍵字，向 Jira 該欄位的 autoComplete 端點即時查使用者
// （reporter 等欄位空查詢只回傳前 ~50 名推薦人，必須帶 query 才能找到其他人）
router.get('/api/jira/field-users', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const projectKey = String(req.query.projectKey ?? '').trim()
    const issueTypeName = String(req.query.issueTypeName ?? '').trim()
    const issueTypeId = String(req.query.issueTypeId ?? '').trim()
    const fieldKey = String(req.query.fieldKey ?? '').trim()
    const query = String(req.query.query ?? '').trim()
    if (!projectKey || (!issueTypeId && !issueTypeName) || !fieldKey) {
      return res.status(400).json({ ok: false, message: 'projectKey、issueType、fieldKey 為必填' })
    }
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const cacheKey = `${projectKey}:${issueTypeId || issueTypeName}`
    let fields = fieldMetaCache.get(cacheKey)?.fields
    if (!fields) {
      fields = await fetchNormalizedJiraFields(projectKey, issueTypeId, issueTypeName, userAuth.auth, baseUrl)
      fieldMetaCache.set(cacheKey, { fields, expiresAt: Date.now() + 10 * 60 * 1000 })
    }
    const field = fields.find(f => f.key === fieldKey)
    if (!field) return res.status(404).json({ ok: false, message: '找不到欄位' })
    if (field.type !== 'user' && field.type !== 'multiuser') {
      return res.status(400).json({ ok: false, message: '此欄位非使用者欄位' })
    }
    let users: { id: string; label: string }[] = []
    if (field.autoCompleteUrl) {
      users = await fetchUserFieldOptions(field.autoCompleteUrl, userAuth.auth, baseUrl, query)
    }
    // fallback：沒有 autoCompleteUrl 時，用既有 options 做本地過濾
    if (users.length === 0 && !field.autoCompleteUrl && field.options?.length) {
      const q = query.toLowerCase()
      users = field.options.filter(o => !q || o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
    }
    res.json({ ok: true, users })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /api/jira/attachment-prefetch
 * Download attachment files from Lark/Google Drive and cache locally.
 * Frontend uses the returned cacheIds to display thumbnails in the preview table.
 * Files are served via GET /api/jira/attachment-cache/:cacheId.
 * Each file must be ≤ 10 MB (Jira Cloud default).
 */
router.post('/api/jira/attachment-prefetch', async (req, res, next) => {
  try {
    cleanAttachmentCache()
    const { groups, larkSheetContext } = z.object({
      groups: z.array(z.object({
        rowIndex: z.number(),
        urls: z.array(z.string()),
      })),
      larkSheetContext: z.object({
        sheetUrl: z.string(),
        columnLetter: z.string(),
      }).optional().default({ sheetUrl: '', columnLetter: '' }),
    }).parse(req.body)

    let larkToken: string | null = null
    const result: Array<{
      rowIndex: number
      attachments: Array<{
        cacheId: string; filename: string; mimeType: string
        isImage: boolean; isVideo: boolean; size: number; error?: string
      }>
    }> = []

    // Helper: fetch file tokens from a Lark Sheet cell's inline images
    const getLarkCellImageTokens = async (spreadsheetToken: string, sheetId: string, cellId: string, token: string): Promise<string[]> => {
      try {
        const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
        const url = `${base}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/${sheetId}/cells/${cellId}/cell_images`
        console.log('[cell_images] GET', url)
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        const rawText = await resp.text()
        console.log('[cell_images] raw response (status', resp.status, '):', rawText.slice(0, 500))
        let data: { code?: number; msg?: string; data?: { cell_images?: Array<{ file_token: string }> } }
        try { data = JSON.parse(rawText) } catch { return [] }
        if (!resp.ok || data.code !== 0) return []
        return data.data?.cell_images?.map(img => img.file_token).filter(Boolean) ?? []
      } catch (err) {
        console.warn('[cell_images] error:', err)
        return []
      }
    }


    for (const group of groups) {
      const attachments: (typeof result)[0]['attachments'] = []

      // Process explicit URL list
      for (const url of group.urls) {
        const trimmed = url.trim()
        if (!trimmed) continue
        try {
          let buffer: Buffer, filename: string, mimeType: string
          if (isGoogleDriveUrl(trimmed)) {
            const fileId = parseGoogleDriveFileId(trimmed)
            if (!fileId) {
              attachments.push({ cacheId: '', filename: trimmed, mimeType: '', isImage: false, isVideo: false, size: 0, error: '無法解析 Google Drive 連結' })
              continue
            }
            ;({ buffer, filename, mimeType } = await downloadGoogleDriveFile(fileId))
          } else if (isLarkEmbedImageUrl(trimmed)) {
            if (!larkToken) larkToken = await getLarkToken()
            ;({ buffer, filename, mimeType } = await downloadLarkEmbedImage(trimmed, larkToken))
          } else {
            const fileToken = parseLarkFileToken(trimmed)
            if (!fileToken) {
              // filename-only cell (no URL/token) — Lark 「插入→附件」功能不透過 API 暴露 file token
              // 顯示為影片圖示，使用者可用工具的手動上傳按鈕替代
              attachments.push({ cacheId: '', filename: trimmed, mimeType: 'video/link', isImage: false, isVideo: true, size: 0 })
              continue
            }
            if (!larkToken) larkToken = await getLarkToken()
            ;({ buffer, filename, mimeType } = await downloadLarkFile(fileToken, larkToken))
          }
          if (buffer.length > MAX_ATTACHMENT_BYTES) {
            attachments.push({ cacheId: '', filename, mimeType, isImage: false, isVideo: false, size: buffer.length, error: `超過 10MB 限制（${(buffer.length / 1024 / 1024).toFixed(1)}MB）` })
            continue
          }
          const cacheId = randomUUID()
          writeFileSync(join(ATTACH_CACHE_DIR, cacheId), buffer)
          attachments.push({ cacheId, filename, mimeType, isImage: mimeType.startsWith('image/'), isVideo: mimeType.startsWith('video/'), size: buffer.length })
        } catch (err) {
          console.warn('[attachment-prefetch] download failed:', trimmed, err)
          attachments.push({ cacheId: '', filename: trimmed, mimeType: '', isImage: false, isVideo: false, size: 0, error: String(err) })
        }
      }

      // For rows with no URLs, try Lark Sheet cell_images API (handles inline images inserted directly into cells)
      if (group.urls.length === 0 && larkSheetContext) {
        try {
          if (!larkToken) larkToken = await getLarkToken()
          const { spreadsheetToken, sheetId } = parseLarkSheetUrl(larkSheetContext.sheetUrl)
          console.log('[cell_images] context:', { spreadsheetToken, sheetId, columnLetter: larkSheetContext.columnLetter, rowIndex: group.rowIndex })
          if (spreadsheetToken && sheetId) {
            const cellId = `${larkSheetContext.columnLetter}${group.rowIndex}`
            const fileTokens = await getLarkCellImageTokens(spreadsheetToken, sheetId, cellId, larkToken)
            for (const fileToken of fileTokens) {
              try {
                const { buffer, filename, mimeType } = await downloadLarkFile(fileToken, larkToken)
                if (buffer.length > MAX_ATTACHMENT_BYTES) {
                  attachments.push({ cacheId: '', filename, mimeType, isImage: false, isVideo: false, size: buffer.length, error: `超過 10MB 限制` })
                  continue
                }
                const cacheId = randomUUID()
                writeFileSync(join(ATTACH_CACHE_DIR, cacheId), buffer)
                attachments.push({ cacheId, filename, mimeType, isImage: mimeType.startsWith('image/'), isVideo: mimeType.startsWith('video/'), size: buffer.length })
              } catch (err) {
                console.warn('[attachment-prefetch] cell_image download failed:', fileToken, err)
              }
            }
          }
        } catch (err) {
          console.warn('[attachment-prefetch] cell_images lookup failed for row', group.rowIndex, err)
        }
      }

      if (attachments.length > 0) result.push({ rowIndex: group.rowIndex, attachments })
    }
    res.json({ ok: true, result })
  } catch (error) {
    next(error)
  }
})


/**
 * GET /api/jira/attachment-cache/:cacheId
 * Serve a cached attachment file (UUID-named) for preview thumbnails.
 */
router.get('/api/jira/attachment-cache/:cacheId', (req, res) => {
  const { cacheId } = req.params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cacheId)) {
    return res.status(400).send('invalid id')
  }
  const fp = join(ATTACH_CACHE_DIR, cacheId)
  if (!existsSync(fp)) return res.status(404).send('not found')
  res.sendFile(fp)
})

/**
 * DELETE /api/jira/attachment-cache/:cacheId
 * 使用者在預覽表移除附件時呼叫，立即刪除暫存檔，不用等 2 小時 TTL 清理。
 */
router.delete('/api/jira/attachment-cache/:cacheId', (req, res) => {
  const { cacheId } = req.params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cacheId)) {
    return res.status(400).json({ ok: false, message: 'invalid id' })
  }
  const fp = join(ATTACH_CACHE_DIR, cacheId)
  try { if (existsSync(fp)) unlinkSync(fp) } catch { /* ignore */ }
  res.json({ ok: true })
})

// POST /api/lark/sheets/records
router.post('/api/lark/sheets/records', async (req, res, next) => {
  try {
    const { sheetUrl, includeCreated } = z.object({ sheetUrl: z.string(), includeCreated: z.boolean().optional() }).parse(req.body)
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)

    if (!spreadsheetToken) {
      return res
        .status(400)
        .json({ ok: false, message: '無法解析 Lark Sheet URL，格式應為 /sheets/{token}?sheet={id} 或 /wiki/{token}?sheet={id}' })
    }

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const range = sheetId ? `${sheetId}!A1:ZZ1000` : 'A1:ZZ1000'

    const larkHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const resp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
      { headers: larkHeaders },
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

    /** Lark Sheets API can return cell values as strings, numbers, booleans,
     *  or rich-text/formula objects. Extract the plain text string in all cases. */
    /** Extract http link URLs from rich-text array runs (for attachment/hyperlink cells). */
    const extractCellUrls = (cell: unknown): string[] => {
      if (!Array.isArray(cell)) return []
      const urls: string[] = []
      for (const run of cell as Array<{ text?: string; link?: string; type?: string }>) {
        if (typeof run.link === 'string' && run.link.startsWith('http')) urls.push(run.link)
      }
      return urls
    }

    const extractCell = (cell: unknown): string => {
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
      if (typeof cell === 'string') {
        // If the API returned the formula text instead of the computed value, return as-is.
        // (returnFormula=false should have prevented this, but guard just in case)
        return cell
      }
      if (Array.isArray(cell)) {
        // Lark rich-text array: [{text:"CGMN-1", link:"...", type:"url"}, {text:"\n"}, ...]
        return (cell as Array<{ text?: string }>).map(run => run.text ?? '').join('')
      }
      if (typeof cell === 'object') {
        const c = cell as Record<string, unknown>
        // Inline image cells: { type: "embed-image", fileToken: "...", link: "..." }
        // Return the link URL so the attachment pipeline can download via Lark media API
        if (c.type === 'embed-image' && typeof c.link === 'string' && c.link) return c.link
        // Formula cells: Lark may return computed value in various fields
        if (typeof c.formulaValue === 'string') return c.formulaValue
        if (c.formulaValue !== undefined && c.formulaValue !== null) return String(c.formulaValue)
        if (typeof c.displayValue === 'string') return c.displayValue
        if (typeof c.computedValue === 'string') return c.computedValue
        if (c.computedValue !== undefined && c.computedValue !== null) return String(c.computedValue)
        // Rich-text cells
        if (typeof c.text === 'string') return c.text
        if (Array.isArray(c.text)) return (c.text as Array<{ text?: string }>).map(t => t.text ?? '').join('')
        if (typeof c.value === 'string') return c.value
        if (c.value !== undefined && c.value !== null) return String(c.value)
      }
      return ''
    }

    const headers = (rows[0] as unknown[]).map(extractCell)
    const jiraKeyHeader = headers.find(h => h.toLowerCase() === 'jira issue key') ?? 'Jira Issue Key'
    const stageHeader = headers.find(h => h === '處理階段') ?? ''

    /**
     * Try to evaluate complex Lark formula bodies using raw row data.
     * Handles the pattern: IF(Xn<>"", IFERROR(INDEX(SPLIT(Xn, CHAR(c)), n), ""), "")
     * which extracts the nth line of a cell split by a character (e.g. newline).
     */
    const tryEvalComplexFormula = (formula: string, rawRow: unknown[]): string | null => {
      // Match IF(ColRef<>"", IFERROR(INDEX(SPLIT(ColRef, CHAR(charCode)), lineNum), ""), "")
      const m = formula.match(
        /^IF\(\s*([A-Z]+)\d*\s*<>""\s*,\s*IFERROR\(\s*INDEX\(\s*SPLIT\(\s*([A-Z]+)\d*\s*,\s*CHAR\(\s*(\d+)\s*\)\s*\)\s*,\s*(\d+)\s*\)\s*,\s*""\s*\)\s*,\s*""\s*\)$/i
      )
      if (!m) return null
      const colLetters = m[2]
      const charCode = parseInt(m[3], 10)
      const lineNum = parseInt(m[4], 10) - 1  // 1-based → 0-based
      const separator = String.fromCharCode(charCode)
      const colIndex = colLetters.split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1
      const cellVal = extractCell(rawRow[colIndex])
      if (!cellVal) return ''
      const parts = cellVal.split(separator)
      return parts[lineNum] ?? ''
    }

    /**
     * Lark v2 returns formula cells as the formula body string (without `=`).
     * Evaluate simple concatenation formulas like `"prefix"&G2` or `"a"&"b"`
     * using the raw cell values from the same row.
     */
    const evalFormula = (formula: string, rawRow: unknown[]): string => {
      // Split on & and evaluate each token
      const tokens = formula.split('&').map(t => t.trim())
      const parts: string[] = []
      for (const token of tokens) {
        if (token.startsWith('"') && token.endsWith('"')) {
          // Quoted string literal
          parts.push(token.slice(1, -1))
        } else {
          // Cell reference like G2, A1 — column letter(s) + row number
          const m = token.match(/^([A-Z]+)(\d+)$/)
          if (m) {
            const colIndex = m[1].split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1
            const cell = rawRow[colIndex]
            parts.push(extractCell(cell))
          } else {
            // Unknown token — include as-is
            parts.push(token)
          }
        }
      }
      return parts.join('')
    }

    // Cross-sheet formula reference pattern: 'SheetName'!CellRef (e.g. '填寫'!H1)
    const CROSS_SHEET_RE = /^'([^']+)'![A-Z]+\d+$/

    // First pass: extract raw string values and collect cross-sheet formula refs
    const dataRows = rows.slice(1)

    const rawStrRows = dataRows.map(row => (row as unknown[]).map(cell => extractCell(cell)))

    const formulaRefs = new Set<string>()
    for (const row of rawStrRows) {
      for (const val of row) {
        if (val && CROSS_SHEET_RE.test(val)) formulaRefs.add(val)
      }
    }

    // Batch-resolve cross-sheet formula references via Lark values_batch_get
    const resolvedMap = new Map<string, string>()
    if (formulaRefs.size > 0) {
      try {
        const params = [...formulaRefs].map(r => `ranges=${encodeURIComponent(r)}`).join('&')
        const batchResp = await fetch(
          `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_batch_get?${params}`,
          { headers: larkHeaders },
        )
        if (batchResp.ok) {
          const batchData = await batchResp.json() as {
            code?: number
            data?: { valueRanges?: { values?: unknown[][]; range?: string }[] }
          }
          if (batchData.code === 0) {
            for (const vr of batchData.data?.valueRanges ?? []) {
              const ref = vr.range?.trim()
              const cellVal = vr.values?.[0]?.[0]
              if (ref && cellVal !== undefined) resolvedMap.set(ref, extractCell(cellVal))
            }
          }
        }
      } catch (e) {
        console.warn('[lark-sheets] cross-sheet formula resolution failed:', e)
      }
    }

    const records = dataRows
      .map((row, i) => {
        const rawRow = row as unknown[]
        const strRow = rawStrRows[i]
        const obj: Record<string, string> = {}
        headers.forEach((h, ci) => {
          let val = strRow[ci]
          if (val && CROSS_SHEET_RE.test(val)) {
            // Try exact match, then try without single-quoted sheet name
            val = resolvedMap.get(val) ?? resolvedMap.get(val.replace(/^'([^']+)'/, '$1')) ?? val
          } else if (val && /^(".*"|[A-Z]+\d+)(&(".*"|[A-Z]+\d+))+$/.test(val)) {
            // Same-sheet concatenation formula
            val = evalFormula(val, rawRow)
          } else if (val && /^[A-Z_]+\(/.test(val)) {
            // Lark v2 returns complex formula body — try to evaluate it, else empty
            const evaluated = tryEvalComplexFormula(val, rawRow)
            val = evaluated !== null ? evaluated : ''
          }
          obj[h] = val
          // For hyperlink cells, also store the actual link URLs so attachment pipeline can download them
          const linkUrls = extractCellUrls(rawRow[ci])
          if (linkUrls.length > 0) obj[`${h}__url`] = linkUrls.join('\n')
        })
        return { ...obj, _rowIndex: i + 2 }
      })
      .filter((r) => {
        // Skip completely empty rows — ignore serial-number / checkbox / blank columns
        // "編號" is a row-counter column, not real content
        const SERIAL_HEADERS = new Set(['編號', 'No.', 'No', '#', 'no'])
        const hasAnyContent = headers.some(h => {
          if (!h || !h.trim()) return false   // unnamed column
          if (SERIAL_HEADERS.has(h.trim())) return false  // serial-number column — not real content
          const v = r[h]?.trim()
          if (!v || v === '0' || v === 'false') return false
          return true
        })
        if (!hasAnyContent) return false
        if (stageHeader) return r[stageHeader] !== '已完成'
        // includeCreated=true: return ALL non-empty rows (for batch-edit/comment);
        // frontend extractJiraIssuesFromRecords() will filter to rows with Jira keys.
        if (includeCreated) return true
        return !r[jiraKeyHeader] || r[jiraKeyHeader].trim() === ''
      })

    log('info', getClientIP(req), getUser(req), 'Lark Sheet 讀取', `${records.length} 筆待處理`)
    res.json({ ok: true, headers, records })
  } catch (error) {
    next(error)
  }
})

// ─── Batch session locks（批次開單 / 批次轉換狀態的整批鎖）─────────────────────
// 前端逐筆呼叫 /api/jira/batch-create（一次一筆 HTTP request 累加進度），如果鎖是「每筆」
// 拿放，鎖在兩次 HTTP round-trip 之間就是空的——兩個分頁同時跑同一個帳號的批次開單，理論上
// 會交錯執行、有機會重複開單。改成前端先呼叫 /begin 拿一個 batchToken 代表整批鎖，逐筆請求都
// 帶著這個 token（伺服器端只驗證是不是同一個帳號、不重新搶鎖），跑完呼叫 /end 釋放；沒帶
// batchToken 時 fallback 回舊行為（每筆自己搶鎖），向下相容。分頁關掉/網路斷線沒機會呼叫
// /end 的情況，靠下面的閒置逾時清理處理，不會永久卡住這個帳號的名額。
interface BatchSession {
  heavyTask: HeavyTaskToken
  ownerEmail: string
  lastActivity: number
}
const batchSessions = new Map<string, BatchSession>()
const BATCH_SESSION_IDLE_TIMEOUT_MS = 3 * 60 * 1000

setInterval(() => {
  const cutoff = Date.now() - BATCH_SESSION_IDLE_TIMEOUT_MS
  for (const [token, session] of batchSessions.entries()) {
    if (session.lastActivity < cutoff) {
      finishHeavyTask(session.heavyTask)
      batchSessions.delete(token)
    }
  }
}, 30 * 1000)

function beginBatchSession(req: import('express').Request, res: import('express').Response, type: string, label: string) {
  const userAuth = userJiraAuth(req)
  if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
  const heavyTask = tryStartHeavyTask(req, type, label)
  if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
  const batchToken = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  batchSessions.set(batchToken, { heavyTask: heavyTask.token, ownerEmail: userAuth.email, lastActivity: Date.now() })
  res.json({ ok: true, batchToken })
}

function endBatchSession(req: import('express').Request, res: import('express').Response) {
  const { batchToken } = req.body as { batchToken?: string }
  if (batchToken) {
    const session = batchSessions.get(batchToken)
    if (session) {
      finishHeavyTask(session.heavyTask)
      batchSessions.delete(batchToken)
    }
  }
  res.json({ ok: true })
}

/** 驗證 batchToken 屬於這個請求的帳號，true 代表這個請求已經有整批鎖保護，不用自己再搶一次。 */
function useBatchSession(batchToken: string | undefined, ownerEmail: string): boolean {
  if (!batchToken) return false
  const session = batchSessions.get(batchToken)
  if (!session || session.ownerEmail.toLowerCase() !== ownerEmail.toLowerCase()) return false
  session.lastActivity = Date.now()
  return true
}

router.post('/api/jira/batch-create/begin', (req, res) => beginBatchSession(req, res, 'jira-batch-create', 'Jira 批次開單'))
router.post('/api/jira/batch-create/end', (req, res) => endBatchSession(req, res))
router.post('/api/jira/batch-transition/begin', (req, res) => beginBatchSession(req, res, 'jira-batch-transition', 'Jira 批次轉換狀態'))
router.post('/api/jira/batch-transition/end', (req, res) => endBatchSession(req, res))

/**
 * POST /api/jira/batch-create
 * 從 Lark Sheet 批次建立 Jira Issues。前端逐筆呼叫（rows 陣列長度為 1），累加進度顯示。
 */
router.post('/api/jira/batch-create', async (req, res, next) => {
  let heavyTaskToken: HeavyTaskToken | null = null
  let usingBatchSession = false
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) {
      return res.status(401).json({ ok: false, message: '請先選擇帳號，或新增 Jira 帳號' })
    }

    const { batchToken } = req.body as { batchToken?: string }
    usingBatchSession = useBatchSession(batchToken, userAuth.email)
    if (!usingBatchSession) {
      const heavyTask = tryStartHeavyTask(req, 'jira-batch-create', 'Jira 批次開單')
      if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
      heavyTaskToken = heavyTask.token
    }

    const body = batchCreateSchema.parse(req.body)
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const projectId = body.projectId || process.env.JIRA_PROJECT_ID || ''
    const issueTypeId = body.issueTypeId || process.env.JIRA_ISSUE_TYPE_ID || ''
    if (!projectId) return res.status(400).json({ ok: false, message: '請選擇 Jira 專案' })
    if (!issueTypeId) return res.status(400).json({ ok: false, message: '請選擇 Issue 類型' })
    const verifierFieldId = process.env.JIRA_VERIFIER_FIELD_ID ?? 'customfield_10440'
    const dynamicFieldMeta = new Map<string, NormalizedJiraField>()
    if (body.projectKey) {
      try {
        const cacheKey = `${body.projectKey}:${issueTypeId}`
        let fields = fieldMetaCache.get(cacheKey)?.fields
        if (!fields) {
          fields = await fetchNormalizedJiraFields(body.projectKey, issueTypeId, '', userAuth.auth, baseUrl)
          fieldMetaCache.set(cacheKey, { fields, expiresAt: Date.now() + 10 * 60 * 1000 })
        }
        for (const field of fields) dynamicFieldMeta.set(field.key, field)
      } catch (error) {
        console.warn('[batch-create] dynamic field metadata unavailable:', error)
      }
    }

    const results: { rowIndex: number; issueKey?: string; error?: string }[] = []

    for (const row of body.rows) {
      if (!row.summary.replace(/[\r\n]+/g, '').trim()) {
        results.push({ rowIndex: row.rowIndex, error: '缺少摘要欄位，已略過' })
        continue
      }
      try {
        const fields: Record<string, unknown> = {
          project: { id: projectId },
          issuetype: { id: issueTypeId },
          summary: row.summary.replace(/[\r\n]+/g, ' ').trim(),
          description: textToADF(row.description || ''),
        }

        if (row.assigneeAccountId) fields.assignee = { accountId: row.assigneeAccountId }
        if (row.rdOwnerAccountId) fields.customfield_10428 = [{ accountId: row.rdOwnerAccountId }]
        if (row.reporterAccountId) fields.reporter = { accountId: row.reporterAccountId }
        if (row.verifierAccountIds.length > 0) {
          fields[verifierFieldId] = row.verifierAccountIds.map((id) => ({ accountId: id }))
          console.log(`[batch-create] ${row.summary} 驗證人員 → ${verifierFieldId}:`, JSON.stringify(fields[verifierFieldId]))
        }

        const start = toJiraDateTime(row.actualStart)
        const end = toJiraDateTime(row.actualEnd)
        const local = toJiraDateTime(row.localTestDone)
        const staging = toJiraDateTime(row.stagingDeploy)
        console.log(`[batch-create] date fields raw: actualStart=${row.actualStart} → ${start}, actualEnd=${row.actualEnd} → ${end}`)
        if (start) fields.customfield_10430 = start
        if (end) fields.customfield_10431 = end
        if (local) fields.customfield_10465 = local
        if (staging) fields.customfield_10466 = staging
        if (row.releaseDate) {
          // Jira date-only field expects YYYY-MM-DD; normalise slash format from Lark
          const relDt = toJiraDateTime(row.releaseDate)
          if (relDt) fields.customfield_10438 = relDt.slice(0, 10)  // take only YYYY-MM-DD
        }

        // Merge dynamic fields from the new field-grid UI (skip reserved keys)
        // For string values that look like dates/datetimes, normalise to Jira format via toJiraDateTime
        // ADF fields (description, environment) must be wrapped in textToADF()
        const RESERVED_JIRA_KEYS = new Set(['project', 'issuetype', 'summary'])
        const ADF_FIELD_KEYS = new Set(['description', 'environment'])
        const DATE_LIKE = /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}([T\s]\d{1,2}:\d{2})?$/
        for (const [key, value] of Object.entries(row.dynamicFields ?? {})) {
          if (!RESERVED_JIRA_KEYS.has(key) && value !== '' && value !== null && value !== undefined) {
            const fieldMeta = dynamicFieldMeta.get(key)
            if (fieldMeta?.type === 'user' || fieldMeta?.type === 'multiuser') {
              fields[key] = resolveUserFieldValue(fieldMeta, value)
            } else if (ADF_FIELD_KEYS.has(key) && typeof value === 'string') {
              fields[key] = textToADF(value)
            } else if (typeof value === 'string' && DATE_LIKE.test(value.trim())) {
              const converted = toJiraDateTime(value)
              fields[key] = converted ?? value
            } else {
              fields[key] = value
            }
          }
        }

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
          const issueKey = data.key!
          // ── 描述附件：上傳後以 wiki markup 嵌入描述 ──
          const cachedAtts = row.cachedAttachments ?? []
          console.log(`[batch-create] ${issueKey} cachedAtts.length=${cachedAtts.length}`, cachedAtts.map(a => ({ cacheId: a.cacheId?.slice(0, 8), filename: a.filename, isImage: a.isImage })))
          if (cachedAtts.length > 0) {
            const uploadedImages: string[] = []
            const uploadedVideos: string[] = []
            for (const ca of cachedAtts) {
              if (!ca.cacheId) { console.log(`[batch-create] skip no cacheId: ${ca.filename}`); continue }
              const fp = join(ATTACH_CACHE_DIR, ca.cacheId)
              if (!existsSync(fp)) {
                console.warn(`[batch-create] ${issueKey} 快取檔不存在: ${fp}`)
                continue
              }
              try {
                const buffer = readFileSync(fp)
                console.log(`[batch-create] ${issueKey} 上傳附件 ${ca.filename} (${buffer.length}bytes)`)
                const storedFilename = await uploadAttachmentToJira(issueKey, ca.filename, buffer, ca.mimeType, userAuth.auth, baseUrl)
                console.log(`[batch-create] ${issueKey} 附件上傳成功: ${ca.filename} → ${storedFilename}`)
                if (ca.isVideo) uploadedVideos.push(storedFilename)
                else uploadedImages.push(storedFilename)
                try { unlinkSync(fp) } catch { /* ignore */ }
              } catch (attErr) {
                console.warn(`[batch-create] ${issueKey} 附件上傳失敗 (${ca.filename}):`, attErr)
              }
            }
            console.log(`[batch-create] ${issueKey} uploadedImages:`, uploadedImages, 'uploadedVideos:', uploadedVideos)
            if (uploadedImages.length > 0 || uploadedVideos.length > 0) {
              const descText = (row.description ?? '').trim()
              let wikiDesc = descText
              if (uploadedImages.length > 0) {
                wikiDesc += (wikiDesc ? '\n\n' : '') + uploadedImages.map(f => `!${f}!`).join('\n')
              }
              if (uploadedVideos.length > 0) {
                wikiDesc += (wikiDesc ? '\n\n' : '') + '📹 影片附件：\n' + uploadedVideos.map(f => `[^${f}]`).join('\n')
              }
              console.log(`[batch-create] ${issueKey} 更新描述 wikiDesc:`, JSON.stringify(wikiDesc.slice(0, 300)))
              try {
                // Try v2 wiki markup first
                const putResp = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}`, {
                  method: 'PUT',
                  headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
                  body: JSON.stringify({ fields: { description: wikiDesc } }),
                })
                if (!putResp.ok) {
                  const errBody = await putResp.text().catch(() => '')
                  console.warn(`[batch-create] ${issueKey} v2 描述更新失敗 HTTP ${putResp.status}: ${errBody.slice(0, 300)}`)
                  // Fallback: v3 ADF update (image filenames as text)
                  const adfDesc = textToADF(descText + (uploadedImages.length > 0 ? '\n\n' + uploadedImages.map(f => `[圖片附件: ${f}]`).join('\n') : '') + (uploadedVideos.length > 0 ? '\n' + uploadedVideos.map(f => `[影片附件: ${f}]`).join('\n') : ''))
                  const v3Resp = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}`, {
                    method: 'PUT',
                    headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { description: adfDesc } }),
                  })
                  if (!v3Resp.ok) {
                    const v3Err = await v3Resp.text().catch(() => '')
                    console.warn(`[batch-create] ${issueKey} v3 描述更新也失敗 HTTP ${v3Resp.status}: ${v3Err.slice(0, 300)}`)
                  } else {
                    console.log(`[batch-create] ${issueKey} 已透過 v3 ADF 更新描述（附件資訊已加入）`)
                  }
                } else {
                  console.log(`[batch-create] ${issueKey} v2 描述更新成功（包含 ${uploadedImages.length} 張圖片）`)
                }
              } catch (descErr) {
                console.warn(`[batch-create] ${issueKey} 更新描述失敗:`, descErr)
              }
            }
          }
          results.push({ rowIndex: row.rowIndex, issueKey })
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
    // 補上摘要文字，事後光看歷史紀錄就能知道每筆開的是什麼單，不用再回頭查 Jira
    const historyResults = results.map(r => ({
      ...r,
      summary: body.rows.find(rr => rr.rowIndex === r.rowIndex)?.summary ?? '',
    }))
    addHistory('jira', 'Jira 批次開單', `成功 ${succeeded} 筆${failed > 0 ? `，失敗 ${failed} 筆` : ''}`, { results: historyResults })

    // ── Persistent writeback queue ──────────────────────────────────────────
    // Save each succeeded issue to DB before returning, then attempt server-side
    // writeback immediately. If writeback fails (or client disconnects before it
    // calls /api/sheets/writeback-multi), the records stay as 'pending' and can
    // be retried via POST /api/jira/pending-writebacks/retry.
    const succeededResults = results.filter(r => r.issueKey)
    const wbWrites: MultiWrite[] = []
    if (succeededResults.length > 0 && body.sheetUrl) {
      const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO jira_pending_writebacks (created_at, sheet_url, row_index, jira_key, jira_url, summary, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      const nowMs = Date.now()
      const jiraBase = mustEnv('JIRA_BASE_URL')
      for (const r of succeededResults) {
        const rowSummary = body.rows.find(rr => rr.rowIndex === r.rowIndex)?.summary ?? ''
        const jiraUrl = `${jiraBase}/browse/${r.issueKey!}`
        insertStmt.run(nowMs, body.sheetUrl, r.rowIndex, r.issueKey!, jiraUrl, rowSummary, nowMs)
        wbWrites.push({
          rowIndex: r.rowIndex,
          columns: {
            'Jira issue key': r.issueKey!,
            'Jira URL': jiraUrl,
            '處理階段': '已開單',
            '處理時間': new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }),
            '單子標題貼這': {
              type: 'richtext',
              segments: [
                { text: r.issueKey!, link: jiraUrl },
                { text: `\n${rowSummary}` },
              ],
            },
          },
        })
      }
    }

    // Return result immediately; client calls /api/sheets/writeback-multi independently.
    // Server-side writeback below runs in background as a failsafe.
    res.json({ ok: true, results, succeeded, failed })

    // Fire-and-forget server-side writeback (updates pending_writebacks status after responding)
    if (wbWrites.length > 0 && body.sheetUrl) {
      const sheetUrl = body.sheetUrl
      ;(async () => {
        try {
          const wbResults = await multiWritebackLark(sheetUrl, wbWrites)
          const updateStmt = db.prepare(
            `UPDATE jira_pending_writebacks SET status=?, error=?, attempt_count=attempt_count+1, updated_at=? WHERE sheet_url=? AND row_index=? AND jira_key=?`
          )
          for (const wr of wbResults) {
            const issueKey = succeededResults.find(r => r.rowIndex === wr.rowIndex)?.issueKey
            if (!issueKey) continue
            updateStmt.run(wr.ok ? 'done' : 'failed', wr.ok ? null : (wr.error ?? ''), Date.now(), sheetUrl, wr.rowIndex, issueKey)
          }
        } catch (wbErr) {
          console.warn('[batch-create] background writeback failed (pending queue preserved):', wbErr)
        }
      })()
    }
  } catch (error) {
    next(error)
  } finally {
    if (!usingBatchSession) finishHeavyTask(heavyTaskToken)
  }
})

// GET /api/jira/pending-writebacks?sheetUrl=...&status=pending
router.get('/api/jira/pending-writebacks', (req, res) => {
  const { sheetUrl, status } = req.query as Record<string, string | undefined>
  const conditions: string[] = []
  const params: unknown[] = []
  if (sheetUrl) { conditions.push('sheet_url=?'); params.push(sheetUrl) }
  if (status) {
    // allow comma-separated statuses e.g. "pending,failed"
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length === 1) { conditions.push('status=?'); params.push(statuses[0]) }
    else { conditions.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses) }
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM jira_pending_writebacks ${where} ORDER BY created_at DESC LIMIT 500`).all(...params)
  res.json({ ok: true, rows })
})

// POST /api/jira/pending-writebacks/retry
router.post('/api/jira/pending-writebacks/retry', async (req, res, next) => {
  try {
    if (!userJiraAuth(req)) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { sheetUrl, ids } = req.body as { sheetUrl?: string; ids?: number[] }
    type PendingRow = { id: number; sheet_url: string; row_index: number; jira_key: string; jira_url: string; summary: string }
    let rows: PendingRow[]
    if (ids?.length) {
      rows = db.prepare(`SELECT * FROM jira_pending_writebacks WHERE id IN (${ids.map(() => '?').join(',')}) AND status != 'done'`).all(...ids) as PendingRow[]
    } else if (sheetUrl) {
      rows = db.prepare(`SELECT * FROM jira_pending_writebacks WHERE sheet_url=? AND status != 'done'`).all(sheetUrl) as PendingRow[]
    } else {
      return res.status(400).json({ ok: false, message: '需要 sheetUrl 或 ids' })
    }
    if (rows.length === 0) return res.json({ ok: true, retried: 0, succeeded: 0 })

    const bySheet = new Map<string, PendingRow[]>()
    for (const r of rows) {
      const arr = bySheet.get(r.sheet_url) ?? []
      arr.push(r)
      bySheet.set(r.sheet_url, arr)
    }

    const nowStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
    const updateStmt = db.prepare(`UPDATE jira_pending_writebacks SET status=?, error=?, attempt_count=attempt_count+1, updated_at=? WHERE id=?`)
    let totalSucceeded = 0

    for (const [url, sheetRows] of bySheet) {
      try {
        const wbWrites: MultiWrite[] = sheetRows.map(r => ({
          rowIndex: r.row_index,
          columns: {
            'Jira issue key': r.jira_key,
            'Jira URL': r.jira_url,
            '處理階段': '已開單',
            '處理時間': nowStr,
            '單子標題貼這': {
              type: 'richtext' as const,
              segments: [{ text: r.jira_key, link: r.jira_url }, { text: `\n${r.summary}` }],
            },
          },
        }))
        const wbResults = await multiWritebackLark(url, wbWrites)
        for (const wr of wbResults) {
          const row = sheetRows.find(r => r.row_index === wr.rowIndex)
          if (!row) continue
          updateStmt.run(wr.ok ? 'done' : 'failed', wr.ok ? null : (wr.error ?? ''), Date.now(), row.id)
          if (wr.ok) totalSucceeded++
        }
      } catch (e) {
        console.warn('[pending-writebacks/retry] failed for', url, e)
        db.prepare(`UPDATE jira_pending_writebacks SET status='failed', error=?, attempt_count=attempt_count+1, updated_at=? WHERE id IN (${sheetRows.map(() => '?').join(',')})`).run(String(e), Date.now(), ...sheetRows.map(r => r.id))
      }
    }

    res.json({ ok: true, retried: rows.length, succeeded: totalSucceeded })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /api/jira/reconcile/preview
 * 查詢 Jira 專案在指定時間範圍建立的 Issues，與 Sheet 中缺少 Jira key 的列做位置比對，
 * 回傳預覽清單供使用者確認後再補回填。
 */
router.post('/api/jira/reconcile/preview', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { projectKey, sheetUrl, createdFrom, createdTo } = z.object({
      projectKey: z.string(),
      sheetUrl: z.string(),
      createdFrom: z.string(), // ISO date string
      createdTo: z.string(),
    }).parse(req.body)

    const baseUrl = mustEnv('JIRA_BASE_URL')

    // ── Step 1: Query Jira for issues created in the date range ──────────────
    const jql = `project="${projectKey}" AND created>="${createdFrom.slice(0,10)}" AND created<="${createdTo.slice(0,10)}" ORDER BY created ASC`
    const jiraResp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, maxResults: 200, fields: ['summary', 'created', 'reporter', 'status'] }),
    })
    if (!jiraResp.ok) {
      const errText = await jiraResp.text().catch(() => '')
      return res.json({ ok: false, message: `Jira 查詢失敗 HTTP ${jiraResp.status}：${errText.slice(0, 200)}` })
    }
    const jiraData = (await jiraResp.json()) as { issues?: { key: string; fields: { summary: string; created: string } }[] }
    const jiraIssues = (jiraData.issues ?? []).map(i => ({
      key: i.key,
      summary: i.fields.summary,
      created: i.fields.created,
    }))

    // ── Step 2: Read Sheet headers + find rows with empty Jira key ───────────
    const larkToken = await getLarkToken()
    const larkBase = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)
    if (!spreadsheetToken) return res.json({ ok: false, message: '無法解析 Sheet URL' })

    // Read rows 1+2 (same as multiWritebackLark) to handle merged/two-row headers
    const headerRange = sheetId ? `${sheetId}!A1:ZZ2` : 'A1:ZZ2'
    const hResp = await fetch(
      `${larkBase}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${headerRange}`,
      { headers: { Authorization: `Bearer ${larkToken}` } },
    )
    if (!hResp.ok) {
      const txt = await hResp.text()
      return res.json({ ok: false, message: `Lark Sheet 表頭讀取失敗（HTTP ${hResp.status}）：${txt.slice(0, 200)}` })
    }
    const hRawText = await hResp.text()
    let hData: { code?: number; msg?: string; data?: { valueRange?: { values?: unknown[][] } } }
    try { hData = JSON.parse(hRawText) } catch {
      return res.json({ ok: false, message: 'Lark Sheet 回應非 JSON，可能是 token 過期或 URL 無效，請重新授權 Lark。' })
    }
    if (hData.code !== 0) return res.json({ ok: false, message: `Lark Sheet 表頭讀取失敗：${hData.msg ?? '未知錯誤'}` })
    const hRows = hData.data?.valueRange?.values ?? []
    // Same extractCell + evalFormula logic as batch-create sheet reading
    const extractCellText = (c: unknown): string => {
      if (c === null || c === undefined) return ''
      if (typeof c === 'number' || typeof c === 'boolean') return String(c)
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return (c as Array<{ text?: string }>).map(r => r.text ?? '').join('')
      if (typeof c === 'object') {
        const o = c as Record<string, unknown>
        if (typeof o.formulaValue === 'string') return o.formulaValue
        if (o.formulaValue != null) return String(o.formulaValue)
        if (typeof o.displayValue === 'string') return o.displayValue
        if (typeof o.computedValue === 'string') return o.computedValue
        if (o.computedValue != null) return String(o.computedValue)
        if (typeof o.text === 'string') return o.text
        if (Array.isArray(o.text)) return (o.text as Array<{ text?: string }>).map(t => t.text ?? '').join('')
        if (typeof o.value === 'string') return o.value
        if (o.value != null) return String(o.value)
      }
      return ''
    }
    // Evaluate same-sheet concatenation formulas (Lark returns formula body without '=')
    const evalConcatFormula = (formula: string, rawRow: unknown[]): string => {
      const tokens = formula.split('&').map(t => t.trim())
      return tokens.map(token => {
        if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1)
        const m = token.match(/^([A-Za-z]+)(\d+)$/)
        if (m) {
          const colIndex = m[1].toUpperCase().split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1
          return extractCellText(rawRow[colIndex])
        }
        return token
      }).join('')
    }
    const resolveCell = (val: string, rawRow: unknown[]): string => {
      if (/^(".*"|[A-Za-z]+\d+)(&(".*"|[A-Za-z]+\d+))+$/.test(val)) return evalConcatFormula(val, rawRow)
      return val
    }

    const hRow1 = (hRows[0] ?? []).map(extractCellText)
    const hRow2 = (hRows[1] ?? []).map(extractCellText)
    const headers: string[] = Array.from({ length: Math.max(hRow1.length, hRow2.length) }, (_, i) => hRow1[i]?.trim() || hRow2[i]?.trim() || '')

    const jiraKeyColIdx = headers.findIndex(h => h.toLowerCase().includes('jira issue key') || h.toLowerCase() === 'jira key')
    const summaryColIdx = headers.findIndex(h => h.toLowerCase() === 'summary' || h.toLowerCase() === '摘要' || h.toLowerCase() === '標題')

    if (jiraKeyColIdx === -1) return res.json({ ok: false, message: '找不到「Jira issue key」欄位' })

    // Fetch data rows (up to 500 rows)
    const dataRange = sheetId ? `${sheetId}!A2:ZZ501` : 'A2:ZZ501'
    const dResp = await fetch(
      `${larkBase}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${dataRange}`,
      { headers: { Authorization: `Bearer ${larkToken}` } },
    )
    if (!dResp.ok) {
      const txt = await dResp.text()
      return res.json({ ok: false, message: `Lark Sheet 資料讀取失敗（HTTP ${dResp.status}）：${txt.slice(0, 200)}` })
    }
    const dRawText = await dResp.text()
    let dData: { code?: number; msg?: string; data?: { valueRange?: { values?: unknown[][] } } }
    try { dData = JSON.parse(dRawText) } catch {
      return res.json({ ok: false, message: 'Lark Sheet 資料回應非 JSON，可能是 token 過期或 URL 無效，請重新授權 Lark。' })
    }
    const dataRows = (dData.data?.valueRange?.values ?? []) as unknown[][]

    // Rows where Jira key cell is empty
    const emptyRows = dataRows
      .map((row, i) => {
        const rawRow = row as unknown[]
        const jiraKeyVal = resolveCell(extractCellText(rawRow[jiraKeyColIdx]), rawRow)
        const sheetSummary = summaryColIdx >= 0 ? resolveCell(extractCellText(rawRow[summaryColIdx]), rawRow) : ''
        return { rowIndex: i + 2, sheetSummary, jiraKeyValue: jiraKeyVal }
      })
      .filter(r => !r.jiraKeyValue)

    // ── Step 3: Similarity-first matching ────────────────────────────────────
    // Compute common-prefix ratio as similarity score
    const simScore = (a: string, b: string): number => {
      const A = a.toLowerCase().replace(/\s+/g, '')
      const B = b.toLowerCase().replace(/\s+/g, '')
      if (!A || !B) return 0
      let i = 0
      while (i < A.length && i < B.length && A[i] === B[i]) i++
      // Also check if one contains the other's opening portion (handles truncated summaries)
      const minLen = Math.min(A.length, B.length)
      const prefixScore = i / Math.max(A.length, B.length)
      const containScore = (A.includes(B.slice(0, Math.min(minLen, 15))) || B.includes(A.slice(0, Math.min(minLen, 15)))) ? 0.4 : 0
      return Math.max(prefixScore, containScore)
    }

    const HIGH_THRESHOLD = 0.3 // prefix ratio considered "high confidence"

    const remainingJira = [...jiraIssues]
    const remainingRows = [...emptyRows]
    const matches: Array<{ rowIndex: number; sheetSummary: string; jiraKey: string; jiraSummary: string; jiraCreated: string; confidence: string }> = []

    // Pass 1: greedy best-similarity match
    while (remainingJira.length > 0 && remainingRows.length > 0) {
      let bestScore = -1; let bestJiraIdx = 0; let bestRowIdx = 0
      for (let ji = 0; ji < remainingJira.length; ji++) {
        for (let ri = 0; ri < remainingRows.length; ri++) {
          const score = simScore(remainingJira[ji].summary, remainingRows[ri].sheetSummary)
          if (score > bestScore) { bestScore = score; bestJiraIdx = ji; bestRowIdx = ri }
        }
      }
      if (bestScore < HIGH_THRESHOLD) break // remaining pairs have no good similarity match
      const jira = remainingJira.splice(bestJiraIdx, 1)[0]
      const row = remainingRows.splice(bestRowIdx, 1)[0]
      matches.push({ rowIndex: row.rowIndex, sheetSummary: row.sheetSummary, jiraKey: jira.key, jiraSummary: jira.summary, jiraCreated: jira.created, confidence: 'high' })
    }

    // Pass 2: positional fallback for unmatched
    const posCount = Math.min(remainingJira.length, remainingRows.length)
    for (let i = 0; i < posCount; i++) {
      const jira = remainingJira[i]
      const row = remainingRows[i]
      matches.push({ rowIndex: row.rowIndex, sheetSummary: row.sheetSummary, jiraKey: jira.key, jiraSummary: jira.summary, jiraCreated: jira.created, confidence: 'low' })
    }

    // Sort final list by Sheet row index for display
    matches.sort((a, b) => a.rowIndex - b.rowIndex)

    const unmatchedJira = remainingJira.slice(posCount)
    const unmatchedRows = remainingRows.slice(posCount)

    res.json({ ok: true, matches, unmatchedJiraIssues: unmatchedJira, unmatchedSheetRows: unmatchedRows })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /api/jira/reconcile/apply
 * 對確認的 matches 批次補回填 Lark Sheet。
 */
router.post('/api/jira/reconcile/apply', async (req, res, next) => {
  try {
    if (!userJiraAuth(req)) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { sheetUrl, matches } = z.object({
      sheetUrl: z.string(),
      matches: z.array(z.object({ rowIndex: z.number(), jiraKey: z.string(), jiraSummary: z.string().optional().default('') })),
    }).parse(req.body)

    const jiraBase = mustEnv('JIRA_BASE_URL')
    const nowStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })

    const wbWrites: MultiWrite[] = matches.map(m => {
      const jiraUrl = `${jiraBase}/browse/${m.jiraKey}`
      return {
        rowIndex: m.rowIndex,
        columns: {
          'Jira issue key': m.jiraKey,
          'Jira URL': jiraUrl,
          '處理階段': '已開單',
          '處理時間': nowStr,
          '單子標題貼這': {
            type: 'richtext',
            segments: [{ text: m.jiraKey, link: jiraUrl }, { text: `\n${m.jiraSummary}` }],
          },
        },
      }
    })

    const wbResults = await multiWritebackLark(sheetUrl, wbWrites)
    const succeeded = wbResults.filter(r => r.ok).length
    res.json({ ok: true, results: wbResults, succeeded, failed: wbResults.length - succeeded })
  } catch (error) {
    next(error)
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
    // 這支端點一律只認本人——代發改成「逐列」（每個 comment item 自己帶 commentAsEmail），
    // 不再用 header 換整批身分，避免同時存在兩套身分來源。
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })

    const body = batchCommentSchema.parse(req.body)
    const baseUrl = mustEnv('JIRA_BASE_URL')

    // AI 兩項功能各自獨立授權。先前後端對 useAi 完全沒有驗證，只有前端把選項藏起來——
    // 改 payload 就能繞過。權限一律以「登入 session 的帳號」為準（getAuthAccount），不能吃
    // x-jira-email，否則權限本身也能被 header 偽造。沒權限直接回 403 說清楚是哪一項，
    // 不靜默把旗標降成 false（靜默降級會讓使用者以為 AI 有跑）。
    const authAccount = getAuthAccount(req)
    const wantsFormat = body.comments.some(c => c.aiFormat ?? c.useAi)
    const wantsReview = body.comments.some(c => c.aiReview ?? c.useAi)
    if (wantsFormat || wantsReview) {
      if (!authAccount) {
        return res.status(403).json({ ok: false, message: 'AI 功能需要登入後才能使用' })
      }
      if (wantsFormat && !accountHasPermission(authAccount.email, authAccount.role, 'jira-ai-format')) {
        return res.status(403).json({ ok: false, message: '這個帳號沒有「AI 排版評論」的權限，請聯繫管理員開通' })
      }
      if (wantsReview && !accountHasPermission(authAccount.email, authAccount.role, 'jira-ai-review')) {
        return res.status(403).json({ ok: false, message: '這個帳號沒有「AI 完整性分析」的權限，請聯繫管理員開通' })
      }
    }


    // job 歸屬永遠是「發起的人」，不是執行身分——否則代發時被代理者會看到不是自己發起的 job，
    // 發起人反而查不到自己的進度。
    const actorEmail = userAuth.actorEmail ?? userAuth.email

    // 逐列代發：先把整批要用到的身分解析完並驗證授權，任何一筆過不了就整批擋下來，
    // 不要跑到一半才發現第 37 列沒授權（那時前面 36 則留言已經貼出去、收不回來了）。
    // 這裡一定要後端自己驗——使用者可以跳過畫面上的檢查直接改 payload（CodeX review 指出）。
    const authByEmail = new Map<string, { auth: string; email: string; label: string }>()
    for (const item of body.comments) {
      const asEmail = item.commentAsEmail?.trim()
      if (!asEmail || asEmail.toLowerCase() === actorEmail.toLowerCase()) continue
      if (authByEmail.has(asEmail.toLowerCase())) continue
      if (!hasJiraDelegation(actorEmail, asEmail, 'jira.comment.batch')) {
        return res.status(403).json({
          ok: false,
          message: `沒有代理張貼授權：無法以 ${asEmail} 的身分張貼評論，請聯繫管理員開通`,
        })
      }
      const targetAuth = jiraAuthForAccount(asEmail)
      if (!targetAuth) {
        return res.status(400).json({
          ok: false,
          message: `${asEmail} 尚未建立 Jira API Token，無法用這個身分張貼評論`,
        })
      }
      authByEmail.set(asEmail.toLowerCase(), targetAuth)
    }
    const authForItem = (item: { commentAsEmail?: string }) => {
      const asEmail = item.commentAsEmail?.trim()
      if (!asEmail) return { auth: userAuth.auth, email: userAuth.email }
      const hit = authByEmail.get(asEmail.toLowerCase())
      return hit ? { auth: hit.auth, email: hit.email } : { auth: userAuth.auth, email: userAuth.email }
    }

    // 驗證通過才搶重任務鎖：驗證失敗要 return 的路徑一律走在拿鎖之前，
    // 否則早退時鎖沒人釋放，使用者會被自己留下的殭屍鎖擋住後續所有批次操作。
    const heavyTask = tryStartHeavyTask(req, 'jira-batch-comment', 'Jira 批次評論')
    if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
    const clientIP = getClientIP(req)
    const userEmail = userAuth.email


    // Generate a unique request ID and start background processing
    const requestId = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    commentJobStore.set(requestId, {
      status: 'running',
      createdAt: Date.now(),
      ownerEmail: actorEmail,
      commentAsEmail: userAuth.email, // 逐列代發時每筆各自的身分記在 results 裡
      heavyTask: heavyTask.token,
      progress: { done: 0, total: body.comments.length, current: '' },
      callbacks: new Set(),
      progressCallbacks: new Set(),
    })

    // Return immediately so client doesn't time out
    res.json({ ok: true, requestId })

    // Run the batch in background
    ;(async () => {
      const results: { rowIndex: number; issueKey: string; ok: boolean; usedAi?: boolean; error?: string; commentAs?: string }[] = []
      // 讓 job store 上也能讀到這個累積中的陣列（同一個參考，push 進去兩邊都看得到），
      // 這樣 persistCommentJobSnapshot() 才能把「目前已經處理到哪幾筆」寫進 DB
      const jobEntry = commentJobStore.get(requestId)
      if (jobEntry) jobEntry.resultsSoFar = results

      const isGeminiError = (err: unknown) => {
        const msg = String(err)
        return msg.includes('Gemini') || msg.includes('配額') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')
      }

      let stoppedByAi: string | null = null

      // 組合知識庫內容 + 手動 specContext
      let effectiveSpecContext = body.specContext ?? ''
      if (body.knowledgeDocIds && body.knowledgeDocIds.length > 0) {
        const parts: string[] = []
        for (const docId of body.knowledgeDocIds) {
          const doc = db.prepare('SELECT name, content_cache FROM knowledge_docs WHERE id = ?').get(docId) as { name: string; content_cache: string | null } | undefined
          if (doc?.content_cache) {
            parts.push(`=== 知識庫：${doc.name} ===\n${doc.content_cache.slice(0, 12000)}`)
          }
        }
        if (parts.length > 0) {
          const kbBlock = parts.join('\n\n')
          effectiveSpecContext = effectiveSpecContext.trim()
            ? `${kbBlock}\n\n=== 補充說明 ===\n${effectiveSpecContext}`
            : kbBlock
          console.log(`[batch-comment] 已注入知識庫 ${parts.length} 份文件，共 ${kbBlock.length} 字`)
        }
      }

      const total = body.comments.length

      for (const item of body.comments) {
        if (stoppedByAi) break

        // 這一列要用誰的身分張貼（授權與 token 在進迴圈前就驗證過了）
        const itemAuth = authForItem(item)

        // Push "currently processing" progress before starting this item
        pushCommentProgress(requestId, { done: results.length, total, current: item.issueKey })

        let commentText = item.rawComment
        let usedAi = false

        // Admin-only: reformat comment content with AI before posting
        // 兩個旗標各自獨立：只開分析不開排版時，第一則貼的是原文、第二則分析的也是原文；
        // 兩個都開時，分析的是 AI 改寫後「實際貼出去」的正文（跟 CodeX 對齊的行為定義）。
        const wantAiFormat = item.aiFormat ?? item.useAi
        const wantAiReview = item.aiReview ?? item.useAi
        if (wantAiFormat) {
          const hasAnyContent = commentText.trim() || item.environment || item.version || item.platform
          if (!hasAnyContent) {
            console.warn(`[batch-comment] ${item.issueKey} 無任何內容，跳過 AI 格式化`)
          } else {
            try {
              console.log(`[batch-comment] ${item.issueKey} AI 格式化評論內容...`)
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
                  specContext: effectiveSpecContext || undefined,
                  modelSpec: body.modelSpec,
                }),
              )
              usedAi = true
              console.log(`[batch-comment] ${item.issueKey} AI 格式化完成，字數：${commentText.length}`)
            } catch (aiErr) {
              stoppedByAi = String(aiErr)
              console.error(`[batch-comment] ${item.issueKey} AI 格式化失敗，中斷 batch：`, aiErr)
              results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, usedAi: false, error: `AI 中斷：${stoppedByAi}` , commentAs: itemAuth.email })
              pushCommentProgress(requestId, { done: results.length, total, current: '' })
              break
            }
          }
        }

        // 分類附件：優先使用預快取檔案（cachedAttachments），否則退回 URL 下載
        const cachedAtts = item.cachedAttachments ?? []
        const attachUrls = cachedAtts.length > 0 ? [] : (item.attachmentUrls ?? [])
        const videoLinks: string[] = []
        const imageAttachUrls: { type: 'lark' | 'gdrive'; url: string; fileId?: string }[] = []
        // Pre-downloaded cached files ready to upload (images AND videos with real cache files)
        const cachedImageFiles: { buffer: Buffer; filename: string; mimeType: string; isVideo: boolean }[] = []

        if (cachedAtts.length > 0) {
          // Use cached files (from prefetch endpoint)
          for (const ca of cachedAtts) {
            if (ca.mimeType === 'video/link' && !ca.cacheId) {
              // External video URL (no real file) — append as text link
              videoLinks.push(ca.filename)
            } else if (ca.cacheId) {
              const fp = join(ATTACH_CACHE_DIR, ca.cacheId)
              if (existsSync(fp)) {
                try {
                  const buffer = readFileSync(fp)
                  cachedImageFiles.push({ buffer, filename: ca.filename, mimeType: ca.mimeType, isVideo: ca.isVideo })
                } catch { /* ignore missing cache */ }
              }
            }
          }
        } else {
          // Fall back to on-demand URL download (legacy path)
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
        }

        try {
          // ── 先上傳附件，再把圖片以 wiki markup !filename! 嵌入評論 ──
          let attachOk = 0; let attachFail = 0
          const uploadedFiles: { filename: string; isVideo: boolean }[] = []

          // Process cached files (already downloaded by prefetch)
          for (const cf of cachedImageFiles) {
            try {
              const storedFilename = await uploadAttachmentToJira(item.issueKey, cf.filename, cf.buffer, cf.mimeType, itemAuth.auth, baseUrl)
              uploadedFiles.push({ filename: storedFilename, isVideo: cf.isVideo })
              attachOk++
            } catch (attErr) {
              attachFail++
              console.warn(`[batch-comment] ${item.issueKey} 快取附件上傳失敗 (${cf.filename}):`, attErr)
            }
          }

          // Process legacy URL downloads (when cachedAttachments not used)
          if (imageAttachUrls.length > 0) {
            let larkToken: string | null = null
            for (const att of imageAttachUrls) {
              try {
                let buffer: Buffer, filename: string, mimeType: string
                if (att.type === 'gdrive' && att.fileId) {
                  ;({ buffer, filename, mimeType } = await downloadGoogleDriveFile(att.fileId))
                } else if (isLarkEmbedImageUrl(att.url)) {
                  if (!larkToken) larkToken = await getLarkToken()
                  ;({ buffer, filename, mimeType } = await downloadLarkEmbedImage(att.url, larkToken))
                } else {
                  const fileToken = parseLarkFileToken(att.url)
                  if (!fileToken) { attachFail++; continue }
                  if (!larkToken) larkToken = await getLarkToken()
                  ;({ buffer, filename, mimeType } = await downloadLarkFile(fileToken, larkToken))
                }
                const storedFilename = await uploadAttachmentToJira(item.issueKey, filename, buffer, mimeType, itemAuth.auth, baseUrl)
                uploadedFiles.push({ filename: storedFilename, isVideo: mimeType.startsWith('video/') })
                attachOk++
              } catch (attErr) {
                attachFail++
                console.warn(`[batch-comment] ${item.issueKey} 附件上傳失敗 (${att.url}):`, attErr)
              }
            }
          }

          if (attachOk > 0 || attachFail > 0) {
            console.log(`[batch-comment] ${item.issueKey} 附件：${attachOk} 成功${attachFail > 0 ? `，${attachFail} 失敗` : ''}`)
          }

          // Clean up cache files
          for (const ca of item.cachedAttachments ?? []) {
            if (ca.cacheId) {
              try { unlinkSync(join(ATTACH_CACHE_DIR, ca.cacheId)) } catch { /* ignore */ }
            }
          }

          // 建立 wiki markup 評論：文字 + 圖片嵌入（!filename!）+ 影片附件說明 + 影片連結
          let wikiBody = commentText || '（無內容）'
          const uploadedImages = uploadedFiles.filter(f => !f.isVideo)
          const uploadedVideos = uploadedFiles.filter(f => f.isVideo)
          if (uploadedImages.length > 0) {
            wikiBody += '\n\n' + uploadedImages.map(f => `!${f.filename}!`).join('\n')
          }
          if (uploadedVideos.length > 0) {
            wikiBody += '\n\n📹 影片附件：\n' + uploadedVideos.map(f => `• [^${f.filename}]`).join('\n')
          }
          if (videoLinks.length > 0) {
            wikiBody += '\n\n📎 影片連結：\n' + videoLinks.map(u => `• ${u}`).join('\n')
          }
          console.log(`[batch-comment] ${item.issueKey} wikiBody:`, JSON.stringify(wikiBody.slice(-300)),
            '| images:', JSON.stringify(uploadedImages.map(f => f.filename)),
            '| videos:', JSON.stringify(uploadedVideos.map(f => f.filename)))

          // 使用 v2 API 發送 wiki markup 評論（支援 !filename! 內嵌圖片）
          const resp = await fetch(`${baseUrl}/rest/api/2/issue/${item.issueKey}/comment`, {
            method: 'POST',
            headers: { Authorization: itemAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: wikiBody }),
          })
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({})) as { errorMessages?: string[] }
            results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, usedAi: false, error: errData.errorMessages?.join(', ') ?? `HTTP ${resp.status}` , commentAs: itemAuth.email })
          } else {

            // ── 第二則評論：AI 完整性分析 ──
            if (wantAiReview && commentText.trim()) {
              try {
                const summary = item.issueSummary?.trim() || '（無摘要）'
                const description = item.issueDescription?.trim() || '（無描述）'
                const analysisPrompt = `你是 QA 評審員，請分析以下測試評論的完整性。

【Issue 摘要】
${summary}

【Issue 描述】
${description}

【測試者評論】
${commentText}

請用繁體中文，以三點條列方式回覆：
1️⃣ **已涵蓋的重點**：評論中已說明清楚的部分
2️⃣ **可能遺漏或不足之處**：對照規格和評論格式要求，尚未說明或需補充的地方
3️⃣ **整體評估**：完整性評分 X/10，以及改善建議

格式簡潔，每點 2-3 句即可。`
                console.log(`[batch-comment] ${item.issueKey} 發送 AI 分析評論...`)
                const analysisText = await withRequestOperation(
                  `Jira AI 分析評論（${item.issueKey}）`,
                  () => callLLM(analysisPrompt, body.modelSpec),
                )
                await fetch(`${baseUrl}/rest/api/2/issue/${item.issueKey}/comment`, {
                  method: 'POST',
                  headers: { Authorization: itemAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
                  body: JSON.stringify({ body: `🤖 AI 完整性分析\n\n${analysisText.trim()}` }),
                })
                console.log(`[batch-comment] ${item.issueKey} AI 分析評論完成`)
              } catch (aiErr) {
                if (isGeminiError(aiErr)) {
                  stoppedByAi = String(aiErr)
                  results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: true, usedAi: true, error: `第一則評論已發送，AI 分析中斷：${stoppedByAi}` , commentAs: itemAuth.email })
                  pushCommentProgress(requestId, { done: results.length, total, current: '' })
                  break
                }
                console.warn(`[batch-comment] ${item.issueKey} AI 分析評論失敗（非中斷）:`, aiErr)
              }
            }

            results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: true, usedAi, commentAs: itemAuth.email })
          }
        } catch (jiraErr) {
          results.push({ rowIndex: item.rowIndex, issueKey: item.issueKey, ok: false, usedAi: false, error: String(jiraErr) , commentAs: itemAuth.email })
        }

        // Push progress after each item completes
        pushCommentProgress(requestId, { done: results.length, total, current: item.issueKey })

        // Avoid Gemini RPM throttling — pause between issues
        if (results.length < total && !stoppedByAi) {
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }

      const okCount = results.filter(r => r.ok).length
      const failCount = results.filter(r => !r.ok).length
      const aiUsed = results.filter(r => r.usedAi).length
      log(
        stoppedByAi ? 'warn' : failCount > 0 ? 'warn' : 'ok',
        clientIP, actorEmail,
        'Jira 批次評論',
        `成功 ${okCount} 筆${aiUsed > 0 ? `（AI ${aiUsed} 筆）` : ''}${failCount > 0 ? `，失敗 ${failCount} 筆` : ''}${stoppedByAi ? '，AI 中斷' : ''}`,
      )
      // 補上留言內容預覽（截斷避免歷史紀錄過大），事後能直接從歷史紀錄查證貼了什麼，不用只靠
      // ok/error 猜——注意這是使用者填入的原始內容，若該筆有用 AI 重新排版（usedAi=true），
      // 實際貼到 Jira 上的文字可能經過調整，這裡存的是「使用者當時打算送出的內容」而非逐字比對
      const historyResults = results.map(r => {
        const src = body.comments.find(c => c.rowIndex === r.rowIndex)
        return { ...r, commentPreview: (src?.rawComment ?? '').slice(0, 300) }
      })
      // 內部稽核：Jira 上只看得到執行身分，看不出是誰代發的，所以這裡一定要記 actor；
      // 逐列代發時一個 job 可能有多個執行身分，所以身分記在每一筆 result 上而不是 job 層級。
      const delegatedCount = results.filter(r => r.commentAs && r.commentAs.toLowerCase() !== actorEmail.toLowerCase()).length
      addHistory('jira-comment', `Jira 批次評論`, `成功 ${okCount} 筆${failCount > 0 ? `，失敗 ${failCount} 筆` : ''}${stoppedByAi ? '，AI 中斷' : ''}${delegatedCount > 0 ? `（其中 ${delegatedCount} 筆由 ${actorEmail} 代發）` : ''}`, {
        results: historyResults,
        actorEmail,
      })

      finishCommentJob(requestId, {
        ok: !stoppedByAi,
        results,
        ...(stoppedByAi ? { stopped: true, stoppedReason: stoppedByAi, stoppedKind: 'ai_quota' as const } : {}),
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

/**
 * GET /api/jira/comment-as-candidates
 * 逐列「填寫人」下拉的候選名單：自己 ＋ 對我有 jira.comment.batch 有效授權的帳號。
 * 名單一律由後端算——前端拿全帳號清單再自己篩，等於把整份帳號名單洩出去，這是資訊揭露
 * 邊界不是實作細節（v4.12.0 定的原則；v4.13.0 改成逐列代發時一度移除，v4.17.0 加回來）。
 */
router.get('/api/jira/comment-as-candidates', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  const accounts = readAccounts()
  const me = accounts.find(a => a.email.toLowerCase() === account.email.toLowerCase())
  const candidates: { email: string; label: string; self: boolean }[] = me
    ? [{ email: me.email, label: me.label || me.email, self: true }]
    : []
  const rows = db.prepare(`
    SELECT target_email FROM jira_account_delegates
    WHERE actor_email = ? AND scope = 'jira.comment.batch'
      AND enabled = 1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
  `).all(account.email.toLowerCase(), Date.now()) as { target_email: string }[]
  for (const row of rows) {
    const target = accounts.find(a => a.email.toLowerCase() === row.target_email)
    if (!target) continue // 帳號可能已被刪除，授權列留著但不列出不存在的人
    if (candidates.some(c => c.email.toLowerCase() === target.email.toLowerCase())) continue
    candidates.push({ email: target.email, label: target.label || target.email, self: false })
  }
  res.json({ ok: true, candidates })
})

/**
 * POST /api/jira/comment-as-resolve
 * 逐列代發的送出前檢查：吃表格「填寫人」欄的不重複名字，回每個名字對應的後台帳號與狀態。
 * 比對與授權判斷全在後端——前端拿帳號清單自己比，等於把整份名單洩出去。
 */
router.post('/api/jira/comment-as-resolve', (req, res, next) => {
  try {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const { names } = z.object({ names: z.array(z.string()) }).parse(req.body)

    const seen = new Set<string>()
    const results = [] as {
      name: string
      status: 'ok' | 'no_account' | 'ambiguous' | 'no_token' | 'not_authorized'
      email?: string
      label?: string
      candidates?: string[]
    }[]

    for (const raw of names) {
      const name = raw.trim()
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())

      const matched = matchAccountsByPersonName(name)
      if (matched.length === 0) { results.push({ name, status: 'no_account' }); continue }
      if (matched.length > 1) {
        // 只回 label，不回 email——歧義提示不需要洩漏更多欄位（CodeX review 建議）
        results.push({ name, status: 'ambiguous', candidates: matched.map(m => m.label) })
        continue
      }
      const hit = matched[0]
      const isSelf = hit.email.toLowerCase() === account.email.toLowerCase()
      if (!hit.hasToken) { results.push({ name, status: 'no_token', email: hit.email, label: hit.label }); continue }
      if (!isSelf && !hasJiraDelegation(account.email, hit.email, 'jira.comment.batch')) {
        results.push({ name, status: 'not_authorized', email: hit.email, label: hit.label })
        continue
      }
      results.push({ name, status: 'ok', email: hit.email, label: hit.label })
    }
    res.json({ ok: true, results })
  } catch (error) { next(error) }
})

// POST /api/jira/batch-transition
router.post('/api/jira/batch-transition', async (req, res, next) => {
  let heavyTaskToken: HeavyTaskToken | null = null
  let usingBatchSession = false
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })

    const { batchToken } = req.body as { batchToken?: string }
    usingBatchSession = useBatchSession(batchToken, userAuth.email)
    if (!usingBatchSession) {
      const heavyTask = tryStartHeavyTask(req, 'jira-batch-transition', 'Jira 批次轉換狀態')
      if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))
      heavyTaskToken = heavyTask.token
    }

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
      // Jira API 節流，避免大批量時密集打 API 撞到 rate limit
      await new Promise(r => setTimeout(r, 300))
    }

    const ok = results.filter(r => r.ok).length
    const fail = results.filter(r => !r.ok).length
    log(
      fail > 0 ? 'warn' : 'ok',
      getClientIP(req), userAuth.email,
      'Jira 切換狀態',
      `成功 ${ok} 筆${fail > 0 ? `，失敗 ${fail} 筆` : ''}`,
    )
    addHistory('jira-update', 'Jira 批次開單流程—轉換狀態', `成功 ${ok} 筆${fail > 0 ? `，失敗 ${fail} 筆` : ''}`, { results })
    res.json({ ok: true, results })
  } catch (error) {
    next(error)
  } finally {
    if (!usingBatchSession) finishHeavyTask(heavyTaskToken)
  }
})

// ─── Batch Update (填寫人 → Jira Account) ────────────────────────────────────

/**
 * POST /api/jira/update-read-bitable
 * 讀取 Lark Sheet（/wiki/ 或 /sheets/）或 Bitable（/base/），
 * 自動偵測 URL 欄（含 Issue Key）與填寫人欄
 */
router.post('/api/jira/update-read-bitable', async (req, res, next) => {
  try {
    const { bitableUrl } = z.object({ bitableUrl: z.string() }).parse(req.body)
    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

    const JIRA_KEY_RE = /^[A-Z]{2,}[0-9]*-\d+$/
    const extractCell = (cell: unknown): string => {
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'string') return cell
      if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
      // Lark Sheets may return rich-text cells as an array of segments
      if (Array.isArray(cell)) {
        return (cell as Array<unknown>).map(seg => {
          if (typeof seg === 'string') return seg
          if (typeof seg === 'object' && seg !== null) {
            const s = seg as Record<string, unknown>
            if (typeof s.text === 'string') return s.text
            // @mention segment: { at: { name: "..." } }
            if (typeof s.at === 'object' && s.at !== null)
              return (s.at as Record<string, unknown>).name as string ?? ''
          }
          return ''
        }).join('')
      }
      if (typeof cell === 'object') {
        const c = cell as Record<string, unknown>
        if (typeof c.text === 'string') return c.text
        if (typeof c.value === 'string') return c.value
        if (typeof c.formulaValue === 'string') return c.formulaValue
        if (typeof c.displayValue === 'string') return c.displayValue
        // @mention cell: { mention: { name: "..." } }
        if (typeof c.mention === 'object' && c.mention !== null)
          return (c.mention as Record<string, unknown>).name as string ?? ''
        if (typeof c.name === 'string') return c.name
        if (Array.isArray(c.text)) return (c.text as Array<{ text?: string }>).map(t => t.text ?? '').join('')
        // URL field type { link, text }
        if (typeof (c as { link?: string }).link === 'string' && typeof (c as { text?: string }).text === 'string')
          return (c as { text: string }).text
      }
      return ''
    }

    // ── Lark Sheet path (/wiki/ or /sheets/) ──
    if (bitableUrl.includes('/wiki/') || bitableUrl.includes('/sheets/')) {
      const { spreadsheetToken, sheetId } = parseLarkSheetUrl(bitableUrl)
      if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 URL，請確認格式' })

      const range = sheetId ? `${sheetId}!A1:ZZ2000` : 'A1:ZZ2000'
      const sheetResp = await fetch(
        `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      )
      const sheetData = await sheetResp.json() as {
        code?: number; msg?: string
        data?: { valueRange?: { values?: unknown[][] } }
      }
      if (!sheetResp.ok || sheetData.code !== 0) {
        return res.status(400).json({ ok: false, message: `讀取 Lark Sheet 失敗 (${sheetData.msg ?? sheetData.code})` })
      }

      const rows = sheetData.data?.valueRange?.values ?? []
      if (rows.length < 2) return res.json({ ok: true, records: [], allHeaders: [], urlColumn: '', fillPersonColumn: '' })

      const headers = (rows[0] as unknown[]).map(extractCell)
      let urlColIdx = headers.findIndex(h => h.toLowerCase().includes('url'))
      const fillPersonColIdx = headers.findIndex(h => h.includes('填寫人') || h.includes('填写人'))

      // Helper: column letter → 0-based index (A=0, B=1, ..., Z=25, AA=26, ...)
      const colLetterToIdx = (col: string): number => {
        let idx = 0
        for (const ch of col.toUpperCase()) idx = idx * 26 + ch.charCodeAt(0) - 64
        return idx - 1
      }

      // If URL column has a formula (HYPERLINK/REGEXEXTRACT pattern), follow the referenced column
      if (urlColIdx >= 0) {
        const sampleCell = (rows[1] as unknown[])?.[urlColIdx]
        const sampleStr = typeof sampleCell === 'string' ? sampleCell : extractCell(sampleCell)
        // Formula like: IFERROR(HYPERLINK("..." & REGEXEXTRACT(N2, "..."), REGEXEXTRACT(N2, "..."))
        const refColMatch = sampleStr.match(/REGEXEXTRACT\(([A-Z]+)\d+/i) ?? sampleStr.match(/&\s*([A-Z]+)\d+/)
        if (refColMatch) {
          const refIdx = colLetterToIdx(refColMatch[1])
          if (refIdx >= 0 && refIdx < headers.length) urlColIdx = refIdx
        }
      }

      // If still not found or formula wasn't resolved, scan all columns for direct Jira keys
      if (urlColIdx < 0 || (() => {
        const v = extractCell((rows[1] as unknown[])?.[urlColIdx])
        return !JIRA_KEY_RE.test(v.trim()) && !/[A-Z]{2,}[0-9]*-\d+/.test(v)
      })()) {
        for (let colIdx = 0; colIdx < headers.length; colIdx++) {
          const firstVal = extractCell((rows[1] as unknown[])?.[colIdx])
          if (JIRA_KEY_RE.test(firstVal.trim()) || /[A-Z]{2,}[0-9]*-\d+/.test(firstVal)) {
            urlColIdx = colIdx; break
          }
        }
      }

      const records: Array<{ issueKey: string; fillPerson: string; title: string; rowIndex: number }> = []
      const seenKeys = new Set<string>()
      let skippedEmpty = 0, skippedInvalid = 0
      // Original URL col index before formula redirect (for fallback)
      const origUrlColIdx = headers.findIndex(h => h.toLowerCase().includes('url'))

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[]
        if (urlColIdx < 0) break
        let rawKey = extractCell(row[urlColIdx])
        // Fallback: if formula-redirected column is empty, try original URL column for direct links
        if (!rawKey && origUrlColIdx >= 0 && origUrlColIdx !== urlColIdx) {
          rawKey = extractCell(row[origUrlColIdx])
        }
        if (!rawKey) { skippedEmpty++; continue }
        // N column format may be "[CGLD3-1]Title" or "CGLD3-1 Title" or just "CGLD3-1"
        // Try bracket format first, then extract key from anywhere and take the rest as title
        const bracketMatch = rawKey.match(/^\[([A-Z]{2,}[0-9]*-\d+)\](.*)$/)
        const issueKey = bracketMatch
          ? bracketMatch[1].trim()
          : (rawKey.match(/([A-Z]{2,}[0-9]*-\d+)/) ?? [])[1]?.trim() ?? rawKey.trim()
        const title = bracketMatch
          ? bracketMatch[2].trim()
          : (() => {
              const idx = rawKey.indexOf(issueKey)
              if (idx < 0) return ''
              return rawKey.slice(idx + issueKey.length).replace(/^[\s\[\]()\-–—:,]*/, '').trim()
            })()
        if (!issueKey || !JIRA_KEY_RE.test(issueKey)) { skippedInvalid++; continue }
        if (seenKeys.has(issueKey)) continue  // dedup
        seenKeys.add(issueKey)
        const fillPerson = fillPersonColIdx >= 0 ? extractCell(row[fillPersonColIdx]).trim() : ''
        records.push({ issueKey, fillPerson, title, rowIndex: i + 1 })
      }

      // Debug: log fill person sample to understand cell format
      const fillPersonSampleRaw = fillPersonColIdx >= 0 ? (rows[1] as unknown[])?.[fillPersonColIdx] : null
      console.log('[update-read-bitable] totalRows:', rows.length - 1, 'found:', records.length,
        'skippedEmpty:', skippedEmpty, 'skippedInvalid:', skippedInvalid,
        'fillPersonSample:', JSON.stringify(fillPersonSampleRaw))

      if (records.length === 0) {
        const sampleRaw = urlColIdx >= 0 ? (rows[1] as unknown[])?.[urlColIdx] : null
        return res.status(400).json({
          ok: false,
          message: `找不到 Jira Issue Key。欄位：[${headers.filter(Boolean).join(', ')}]，URL 欄第 ${urlColIdx + 1} 欄，原始值：${JSON.stringify(sampleRaw)}`,
        })
      }

      return res.json({
        ok: true, records, allHeaders: headers,
        urlColumn: urlColIdx >= 0 ? headers[urlColIdx] : '',
        fillPersonColumn: fillPersonColIdx >= 0 ? headers[fillPersonColIdx] : '',
        stats: { totalRows: rows.length - 1, found: records.length, skippedEmpty, skippedInvalid },
        jiraBaseUrl: process.env.JIRA_BASE_URL ?? '',
      })
    }

    // ── Lark Bitable path (/base/) ──
    const { appToken, tableId } = parseBitableUrl(bitableUrl)
    if (!appToken || !tableId) return res.status(400).json({ ok: false, message: '無法解析 URL。支援：/wiki/TOKEN?sheet=ID、/sheets/TOKEN?sheet=ID、/base/TOKEN?table=ID' })

    const rawItems: Array<{ record_id: string; fields: Record<string, unknown> }> = []
    let pageToken: string | undefined
    do {
      const url = `${base}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await resp.json() as {
        code?: number; msg?: string
        data?: { items?: Array<{ record_id: string; fields: Record<string, unknown> }>; has_more?: boolean; page_token?: string }
      }
      if (data.code !== 0) throw new Error(`讀取 Bitable 失敗: ${data.msg}`)
      for (const item of data.data?.items ?? []) rawItems.push(item)
      pageToken = data.data?.has_more ? data.data.page_token : undefined
    } while (pageToken)

    if (rawItems.length === 0) return res.json({ ok: true, records: [], allHeaders: [], urlColumn: '', fillPersonColumn: '' })

    const allHeaders = Object.keys(rawItems[0].fields)
    const urlColumn = allHeaders.find(h => h.toLowerCase().includes('url')) ?? ''
    const fillPersonColumn = allHeaders.find(h => h.includes('填寫人') || h.includes('填写人')) ?? ''

    const records: Array<{ issueKey: string; fillPerson: string; rowIndex: number }> = []
    let rowIndex = 0
    for (const item of rawItems) {
      rowIndex++
      const raw = item.fields[urlColumn]
      const rawStr = extractCell(raw)
      const issueKey = (rawStr.match(/([A-Z]{2,}[0-9]*-\d+)/) ?? [])[1]?.trim() ?? rawStr.trim()
      if (!issueKey || !JIRA_KEY_RE.test(issueKey)) continue
      const fillPerson = fillPersonColumn ? larkTextField(item.fields[fillPersonColumn]).trim() : ''
      records.push({ issueKey, fillPerson, rowIndex })
    }

    res.json({ ok: true, records, allHeaders, urlColumn, fillPersonColumn })
  } catch (error) { next(error) }
})

/**
 * GET /api/jira/transitions?issueKey=XXXX-1
 * 取得某 Issue 可用的 Jira Transition 列表
 */
router.get('/api/jira/transitions', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { issueKey } = z.object({ issueKey: z.string() }).parse(req.query)
    const baseUrl = mustEnv('JIRA_BASE_URL')
    const resp = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
      headers: { Authorization: userAuth.auth, Accept: 'application/json' },
    })
    const data = await resp.json() as { transitions?: Array<{ id: string; name: string; to?: { name?: string } }>; errorMessages?: string[]; errors?: unknown }
    if (!resp.ok || !data.transitions) {
      const errMsg = (data.errorMessages ?? []).join('; ') || `Jira HTTP ${resp.status}`
      return res.status(400).json({ ok: false, message: errMsg })
    }
    res.json({
      ok: true,
      transitions: data.transitions.map(t => ({
        id: t.id,
        name: t.name,
        toName: t.to?.name ?? t.name,
      })),
    })
  } catch (error) { next(error) }
})

/**
 * POST /api/jira/bulk-update
 * 批次更新 Jira Issue（每筆可指定不同帳號）
 */
router.post('/api/jira/bulk-update', async (req, res, next) => {
  try {
    const body = z.object({
      items: z.array(z.object({
        issueKey: z.string(),
        email: z.string(),
        transitionId: z.string().optional(),
        transitionName: z.string().optional(),
      })),
    }).parse(req.body)

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const accounts = readAccounts()
    const results: Array<{ issueKey: string; ok: boolean; skipped?: boolean; error?: string }> = []

    for (const item of body.items) {
      const account = accounts.find(a => a.email === item.email)
      if (!account) {
        results.push({ issueKey: item.issueKey, ok: false, error: '找不到對應帳號' })
        continue
      }
      const auth = `Basic ${Buffer.from(`${account.email}:${account.token}`).toString('base64')}`
      try {
        if (item.transitionId) {
          const resp = await fetch(`${baseUrl}/rest/api/3/issue/${item.issueKey}/transitions`, {
            method: 'POST',
            headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ transition: { id: item.transitionId } }),
          })
          if (!resp.ok) {
            const txt = await resp.text()
            results.push({ issueKey: item.issueKey, ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 120)}` })
          } else {
            results.push({ issueKey: item.issueKey, ok: true })
          }
        } else {
          // 使用者選的是「不切換」（或忘了選）——不呼叫 Jira，明確標記 skipped 讓前端/歷史紀錄
          // 跟真的切換成功區分開，避免誤寫回「已切換狀態」到 Sheet 卻其實什麼都沒做
          results.push({ issueKey: item.issueKey, ok: true, skipped: true })
        }
      } catch (e) {
        results.push({ issueKey: item.issueKey, ok: false, error: String(e) })
      }
      // Jira API 節流，避免大批量時密集打 API 撞到 rate limit
      await new Promise(r => setTimeout(r, 300))
    }

    const ok = results.filter(r => r.ok && !r.skipped).length
    const skipped = results.filter(r => r.skipped).length
    const fail = results.filter(r => !r.ok).length
    const transitionLabel = body.items.find(i => i.transitionName)?.transitionName ?? '（未選擇目標狀態）'
    log(fail > 0 ? 'warn' : 'ok', getClientIP(req), '', 'Jira 批次更新', `成功 ${ok} 筆${skipped > 0 ? `，跳過 ${skipped} 筆` : ''}${fail > 0 ? `，失敗 ${fail} 筆` : ''}`)
    addHistory('jira-update', 'Jira 批次更新狀態', `切換至「${transitionLabel}」：成功 ${ok} 筆${skipped > 0 ? `，跳過 ${skipped} 筆` : ''}${fail > 0 ? `，失敗 ${fail} 筆` : ''}`,
      { results, transitionId: body.items.find(i => i.transitionId)?.transitionId, transitionName: transitionLabel })
    res.json({ ok: true, results })
  } catch (error) { next(error) }
})

// Cache: baseUrl+auth → all rdOwner field IDs (per process lifetime)
const _rdOwnerFieldIdsCache = new Map<string, string[]>()

async function detectRdOwnerFieldIds(baseUrl: string, auth: string): Promise<string[]> {
  const cacheKey = `${baseUrl}::${auth.slice(0, 16)}`
  if (_rdOwnerFieldIdsCache.has(cacheKey)) return _rdOwnerFieldIdsCache.get(cacheKey)!
  // Fallback list — used if Jira field discovery fails
  const FALLBACK_IDS = ['customfield_13322', 'customfield_14103', 'customfield_10428']
  try {
    const r = await fetch(`${baseUrl}/rest/api/3/field`, { headers: { Authorization: auth, Accept: 'application/json' } })
    if (!r.ok) return FALLBACK_IDS
    const fields = await r.json() as { id: string; name: string; custom?: boolean }[]
    // Collect ALL fields named "RD負責人" — Jira instances may have multiple with the same name across different projects
    const matches = fields.filter(f => f.custom && f.name === 'RD負責人').map(f => f.id)
    const ids = matches.length > 0 ? matches : FALLBACK_IDS
    _rdOwnerFieldIdsCache.set(cacheKey, ids)
    log('info', `[batch-fetch-fields] RD負責人 field IDs detected: ${ids.join(', ')}`)
    return ids
  } catch {
    return FALLBACK_IDS
  }
}

// POST /api/jira/batch-fetch-fields — 批量讀取 Jira Issue 現有欄位值
router.post('/api/jira/batch-fetch-fields', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { issueKeys } = z.object({ issueKeys: z.array(z.string()) }).parse(req.body)
    if (issueKeys.length === 0) return res.json({ ok: true, issues: {} })
    const baseUrl = mustEnv('JIRA_BASE_URL')
    // Detect all field IDs named "RD負責人" — Jira may have multiple with the same name across projects
    const rdFieldIds = await detectRdOwnerFieldIds(baseUrl, userAuth.auth)
    const jql = `key in (${issueKeys.map(k => `"${k}"`).join(',')})`
    const resp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: userAuth.auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jql,
        fields: ['summary', 'assignee', 'reporter', 'description', 'priority', 'status', 'issuetype', 'labels', ...new Set(rdFieldIds)],
        expand: 'renderedFields',
        maxResults: Math.min(issueKeys.length, 200),
      }),
    })
    if (!resp.ok) {
      const txt = await resp.text()
      return res.status(resp.status).json({ ok: false, message: `Jira API error: ${txt.slice(0, 200)}` })
    }
    type JiraIssue = {
      key: string
      fields: Record<string, unknown> & {
        summary?: string
        assignee?: { displayName?: string; name?: string }
        reporter?: { displayName?: string; name?: string }
        priority?: { name?: string }
        status?: { name?: string }
        issuetype?: { name?: string }
        labels?: string[]
        description?: unknown
      }
      renderedFields?: { description?: string }
    }
    const resolveUserName = (u: unknown): string => {
      if (!u || typeof u !== 'object') return ''
      const obj = u as Record<string, unknown>
      return (typeof obj.displayName === 'string' && obj.displayName)
        || (typeof obj.name === 'string' && obj.name)
        || (typeof obj.emailAddress === 'string' && obj.emailAddress)
        || (typeof obj.accountId === 'string' && obj.accountId)
        || ''
    }
    const resolveCf = (cf: unknown): string => {
      if (Array.isArray(cf) && cf.length > 0) return resolveUserName(cf[0])
      if (!Array.isArray(cf) && cf) return resolveUserName(cf)
      return ''
    }
    const _debugCf: Record<string, unknown> = {}
    const buildIssueFieldRecord = (issue: JiraIssue): Record<string, string> => {
      const f = issue.fields
      // Try ADF/string first, then fall back to renderedFields (HTML) → strip tags
      let descText = typeof f.description === 'string' ? f.description.trim()
        : (f.description && typeof f.description === 'object') ? extractAdfText(f.description).trim()
        : ''
      if (!descText && issue.renderedFields?.description) {
        descText = issue.renderedFields.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      }
      // Try each detected field ID in order — different projects may use different IDs for the same field name
      let rdOwner = ''
      let usedFieldId = ''
      for (const fid of rdFieldIds) {
        const candidate = resolveCf(f[fid])
        if (candidate) { rdOwner = candidate; usedFieldId = fid; break }
      }
      _debugCf[issue.key] = { checkedFieldIds: rdFieldIds, usedFieldId, rdOwner }
      return {
        summary: f.summary ?? '',
        assignee: f.assignee?.displayName ?? '',
        reporter: f.reporter?.displayName ?? '',
        status: f.status?.name ?? '',
        priority: f.priority?.name ?? '',
        issuetype: f.issuetype?.name ?? '',
        labels: (f.labels ?? []).join(', '),
        description: descText,
        rdOwner,
      }
    }
    const data = await resp.json() as { issues?: JiraIssue[] }
    const issues: Record<string, Record<string, string>> = {}
    for (const issue of data.issues ?? []) {
      issues[issue.key] = buildIssueFieldRecord(issue)
    }

    // Fallback: JQL search excludes archived issues by design — fetch any missing
    // keys individually via direct GET (which does return archived issues).
    const missingKeys = issueKeys.filter(k => !issues[k])
    if (missingKeys.length > 0) {
      const fieldsParam = ['summary', 'assignee', 'reporter', 'description', 'priority', 'status', 'issuetype', 'labels', ...new Set(rdFieldIds)].join(',')
      const fallbackResults = await Promise.all(missingKeys.map(async (key) => {
        try {
          const r = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fieldsParam)}&expand=renderedFields`, {
            headers: { Authorization: userAuth.auth, Accept: 'application/json' },
          })
          if (!r.ok) return null
          const issue = await r.json() as JiraIssue
          return issue
        } catch { return null }
      }))
      for (const issue of fallbackResults) {
        if (issue?.key) issues[issue.key] = buildIssueFieldRecord(issue)
      }
    }

    res.json({ ok: true, issues, _debugCf, _detectedRdFieldIds: rdFieldIds })
  } catch (error) { next(error) }
})

// POST /api/jira/detect-rd-fields — 掃描指定 Issue 的所有 custom user fields，供 UI 確認 RD負責人欄位 ID
router.post('/api/jira/detect-rd-fields', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { issueKey } = z.object({ issueKey: z.string() }).parse(req.body)
    const baseUrl = mustEnv('JIRA_BASE_URL')

    // Fetch field metadata (name lookup)
    const fieldMetaResp = await fetch(`${baseUrl}/rest/api/3/field`, { headers: { Authorization: userAuth.auth, Accept: 'application/json' } })
    const fieldMeta: { id: string; name: string }[] = fieldMetaResp.ok ? await fieldMetaResp.json() as { id: string; name: string }[] : []
    const fieldNameMap = Object.fromEntries(fieldMeta.map(f => [f.id, f.name]))

    // Fetch issue with all fields
    const issueResp = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=*all`, { headers: { Authorization: userAuth.auth, Accept: 'application/json' } })
    if (!issueResp.ok) return res.status(issueResp.status).json({ ok: false, message: `Jira error: ${issueResp.status}` })
    const issueData = await issueResp.json() as { fields?: Record<string, unknown> }

    const resolveUser = (u: unknown): string => {
      if (!u || typeof u !== 'object') return ''
      const o = u as Record<string, unknown>
      return String(o.displayName ?? o.name ?? o.emailAddress ?? o.accountId ?? '')
    }

    const candidates: { fieldId: string; fieldName: string; value: string }[] = []
    for (const [key, val] of Object.entries(issueData.fields ?? {})) {
      if (!key.startsWith('customfield_')) continue
      let userVal = ''
      if (Array.isArray(val) && val.length > 0) userVal = resolveUser(val[0])
      else userVal = resolveUser(val)
      if (userVal) candidates.push({ fieldId: key, fieldName: fieldNameMap[key] ?? key, value: userVal })
    }

    res.json({ ok: true, issueKey, candidates })
  } catch (error) { next(error) }
})

// POST /api/jira/batch-edit — 批量修改 Jira Issue 欄位
router.post('/api/jira/batch-edit', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })

    const cachedAttSchema = z.object({
      cacheId: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      isImage: z.boolean(),
      isVideo: z.boolean(),
      size: z.number(),
    })
    const { items } = z.object({
      items: z.array(z.object({
        issueKey: z.string(),
        fields: z.record(z.string(), z.unknown()),
        cachedAttachments: z.array(cachedAttSchema).optional(),
      })),
    }).parse(req.body)

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const results: Array<{ issueKey: string; ok: boolean; error?: string }> = []

    for (const item of items) {
      const cachedAtts = item.cachedAttachments ?? []
      if (!item.issueKey || (Object.keys(item.fields).length === 0 && cachedAtts.length === 0)) {
        results.push({ issueKey: item.issueKey, ok: false, error: '無更新欄位' })
        continue
      }
      try {
        if (Object.keys(item.fields).length > 0) {
          console.log(`[batch-edit] ${item.issueKey} fields:`, JSON.stringify(item.fields).slice(0, 500))
          const resp = await fetch(`${baseUrl}/rest/api/2/issue/${item.issueKey}`, {
            method: 'PUT',
            headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: item.fields }),
          })
          if (!resp.ok && resp.status !== 204) {
            const txt = await resp.text()
            console.warn(`[batch-edit] ${item.issueKey} 失敗 HTTP ${resp.status}:`, txt.slice(0, 500))
            results.push({ issueKey: item.issueKey, ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` })
            continue
          }
        }

        // ── 描述附件：上傳後以 wiki markup 嵌入描述 ──
        if (cachedAtts.length > 0) {
          const uploadedImages: string[] = []
          const uploadedVideos: string[] = []
          for (const ca of cachedAtts) {
            if (!ca.cacheId) continue
            const fp = join(ATTACH_CACHE_DIR, ca.cacheId)
            if (!existsSync(fp)) { console.warn(`[batch-edit] ${item.issueKey} 快取檔不存在: ${fp}`); continue }
            try {
              const buffer = readFileSync(fp)
              const storedFilename = await uploadAttachmentToJira(item.issueKey, ca.filename, buffer, ca.mimeType, userAuth.auth, baseUrl)
              if (ca.isVideo) uploadedVideos.push(storedFilename)
              else uploadedImages.push(storedFilename)
              try { unlinkSync(fp) } catch { /* ignore */ }
            } catch (attErr) {
              console.warn(`[batch-edit] ${item.issueKey} 附件上傳失敗 (${ca.filename}):`, attErr)
            }
          }
          if (uploadedImages.length > 0 || uploadedVideos.length > 0) {
            // Fetch current description to append markup to
            let descBase = ''
            if (typeof item.fields.description === 'string') {
              descBase = item.fields.description
            } else {
              try {
                const getResp = await fetch(`${baseUrl}/rest/api/2/issue/${item.issueKey}?fields=description`, {
                  headers: { Authorization: userAuth.auth, Accept: 'application/json' },
                })
                if (getResp.ok) {
                  const getData = await getResp.json() as { fields: { description?: unknown } }
                  const desc = getData.fields?.description
                  if (typeof desc === 'string') descBase = desc
                }
              } catch { /* ignore */ }
            }
            let wikiDesc = descBase
            if (uploadedImages.length > 0) {
              wikiDesc += (wikiDesc ? '\n\n' : '') + uploadedImages.map(f => `!${f}!`).join('\n')
            }
            if (uploadedVideos.length > 0) {
              wikiDesc += (wikiDesc ? '\n\n' : '') + '📹 影片附件：\n' + uploadedVideos.map(f => `[^${f}]`).join('\n')
            }
            const putResp = await fetch(`${baseUrl}/rest/api/2/issue/${item.issueKey}`, {
              method: 'PUT',
              headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: { description: wikiDesc } }),
            })
            if (!putResp.ok) {
              console.warn(`[batch-edit] ${item.issueKey} 描述更新失敗 HTTP ${putResp.status}`)
            } else {
              console.log(`[batch-edit] ${item.issueKey} 描述附件更新成功（${uploadedImages.length} 圖 + ${uploadedVideos.length} 影）`)
            }
          }
        }

        results.push({ issueKey: item.issueKey, ok: true })
      } catch (e) {
        results.push({ issueKey: item.issueKey, ok: false, error: String(e) })
      }
      // Jira API 節流，避免大批量時密集打 API 撞到 rate limit
      await new Promise(r => setTimeout(r, 300))
    }

    const ok = results.filter(r => r.ok).length
    const fail = results.filter(r => !r.ok).length
    log(fail > 0 ? 'warn' : 'ok', getClientIP(req), '', 'Jira 批量修改', `成功 ${ok} 筆${fail > 0 ? `，失敗 ${fail} 筆` : ''}`)
    // 補上實際改了哪些欄位/值 + 附件檔名，事後查歷史紀錄就知道改了什麼，不用只靠 ok/error 猜
    const historyResults = results.map(r => {
      const src = items.find(i => i.issueKey === r.issueKey)
      return { ...r, changedFields: src?.fields ?? {}, attachments: (src?.cachedAttachments ?? []).map(a => a.filename) }
    })
    addHistory('jira-edit', 'Jira 批量修改欄位', `成功 ${ok} 筆，失敗 ${fail} 筆`, { results: historyResults })
    res.json({ ok: true, results })
  } catch (error) { next(error) }
})

// POST /api/jira/generate-summaries — AI 批量生成 Jira issue 摘要標題
router.post('/api/jira/generate-summaries', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })

    const body = z.object({
      rows: z.array(z.object({
        rowIndex: z.number(),
        prefix: z.string().default(''),
        content: z.string(),
      })),
      modelSpec: z.string().optional(),
    }).parse(req.body)

    // Process in batches to avoid Gemini rate limiting (429 RESOURCE_EXHAUSTED)
    const BATCH_SIZE = 3
    const BATCH_DELAY_MS = 2500
    const results: { rowIndex: number; summary: string; error?: string }[] = []
    for (let i = 0; i < body.rows.length; i += BATCH_SIZE) {
      const batch = body.rows.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(batch.map(async (row) => {
        if (!row.content.trim()) {
          return { rowIndex: row.rowIndex, summary: row.prefix || '（內容空白）', error: '內容欄位為空' }
        }
        try {
          const prompt = `你是一個 QA 工程師，請根據以下 Bug 描述，生成一個簡短的 Jira issue 標題。
要求：
- 繁體中文
- 不超過 30 個字
- 不要加前綴、括號或任何多餘說明
- 直接輸出標題文字，不要有換行或引號

Bug 描述：${row.content.trim()}`
          const aiTitle = (await callLLM(prompt, body.modelSpec)).trim().replace(/^["「『]|["」』]$/g, '')
          const summary = row.prefix ? `${row.prefix} ${aiTitle}` : aiTitle
          return { rowIndex: row.rowIndex, summary }
        } catch (e) {
          return { rowIndex: row.rowIndex, summary: row.prefix || row.content.slice(0, 50), error: String(e) }
        }
      }))
      results.push(...batchResults)
      if (i + BATCH_SIZE < body.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS))
      }
    }

    res.json({ ok: true, results })
  } catch (error) { next(error) }
})

/**
 * POST /api/jira/batch-fetch-summaries
 * Batch-fetch issue summaries from Jira for display in the update preview table.
 */
router.post('/api/jira/batch-fetch-summaries', async (req, res, next) => {
  try {
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const baseUrl = mustEnv('JIRA_BASE_URL')

    const { issueKeys } = z.object({ issueKeys: z.array(z.string()).min(1).max(500) }).parse(req.body)

    const jql = `key in (${issueKeys.map(k => `"${k}"`).join(',')}) ORDER BY key ASC`
    const resp = await fetch(`${baseUrl}/rest/api/3/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${userAuth.auth}`,
      },
      body: JSON.stringify({ jql, fields: ['summary'], maxResults: 500 }),
    })
    const data = await resp.json() as { issues?: { key: string; fields?: { summary?: string } }[]; errorMessages?: string[] }
    if (!resp.ok) {
      return res.json({ ok: false, message: (data.errorMessages ?? []).join('; ') || `Jira HTTP ${resp.status}` })
    }
    const summaries = (data.issues ?? []).map(i => ({ issueKey: i.key, summary: i.fields?.summary ?? '' }))
    res.json({ ok: true, summaries })
  } catch (error) { next(error) }
})

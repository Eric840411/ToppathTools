/**
 * server/routes/attachments.ts —— 附件上傳、預載、快取、租約。2026-10-02 從 routes/jira.ts 搬出來。
 * 新舊路徑共用同一個 handler（CodeX：比轉址穩）：/api/attachments/*（新）與 /api/jira/attachment-*（舊，前端改完後刪）。
 * 快取目錄、上限、串流都在 jira-attachment-files.ts。
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
import { withRequestOperation } from '../request-context.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'
import { missingForcedRequiredFields } from '../../shared/jira-required-fields.js'
import { JIRA_KEY_EXACT_RE, JIRA_KEY_IN_TEXT_RE, JIRA_KEY_BRACKET_PREFIX_RE } from '../../shared/jira-key.js'
import { pickTransitionForTarget, type JiraTransitionLike } from '../../shared/jira-transition.js'
import {
  ATTACH_CACHE_DIR, AttachmentTooLargeError, cleanAttachmentCache, createAttachmentUploadHandler, createLease, holdLease,
  releaseLease, renewLease, safeUnlink, saveResponseToCache, startAttachmentCacheSweeper, touchCacheFile, uploadFileToJira, type CachedFile,
} from '../jira-attachment-files.js'


import { downloadGoogleDriveFile, downloadLarkEmbedImage, downloadLarkFile, downloadLarkMedia, isGoogleDriveUrl, isLarkEmbedImageUrl, LARK_MEDIA_SCHEME, parseGoogleDriveFileId, parseLarkFileToken, type DownloadedFile } from '../attachment-downloads.js'

export const router = Router()


// ─── Attachment cache ──────────────────────────────────────────────────────────
// 快取目錄、上限、串流上傳下載都在 jira-attachment-files.ts（上限本身在 shared/attachment-limits.ts）
startAttachmentCacheSweeper()

// ─── 手動上傳附件 ──────────────────────────────────────────────────────────────
// 落盤、上限、半成品清理都在 jira-attachment-files.ts 的 createAttachmentUploadHandler（測試也打那支）
const attachmentUploadHandler = createAttachmentUploadHandler()

/** POST /api/jira/attachment-upload — manual file upload from browser, saved to cache */
router.post(['/api/attachments/upload', '/api/jira/attachment-upload'], async (req, res) => {
  // 要登入：原本完全不擋，上限拉到 100MB 後等於任何人都能往伺服器硬碟灌檔案
  if (!getAuthAccount(req)) return res.status(401).json({ ok: false, message: '請先登入' })
  ;(await attachmentUploadHandler)(req, res)
})

// ─── 附件租約：批次開始時保護整批 cacheId，結束才放（見 jira-attachment-files.ts）────
// 批量開單／修改是前端逐列送，伺服器看不到「整批」，所以由前端在迴圈前登記、迴圈中續約、結束後放掉
router.post(['/api/attachments/cache/lease', '/api/jira/attachment-cache/lease'], (req, res) => {
  if (!getAuthAccount(req)) return res.status(401).json({ ok: false, message: '請先登入' })
  const { cacheIds } = z.object({ cacheIds: z.array(z.string()).max(2000) }).parse(req.body)
  res.json({ ok: true, leaseId: createLease(cacheIds) })
})
router.post(['/api/attachments/cache/lease/:leaseId/renew', '/api/jira/attachment-cache/lease/:leaseId/renew'], (req, res) => {
  if (!getAuthAccount(req)) return res.status(401).json({ ok: false, message: '請先登入' })
  res.json({ ok: renewLease(String(req.params.leaseId)) })
})
router.delete(['/api/attachments/cache/lease/:leaseId', '/api/jira/attachment-cache/lease/:leaseId'], (req, res) => {
  if (!getAuthAccount(req)) return res.status(401).json({ ok: false, message: '請先登入' })
  releaseLease(String(req.params.leaseId))
  res.json({ ok: true })
})

/**
 * POST /api/jira/attachment-prefetch
 * Download attachment files from Lark/Google Drive and cache locally.
 * Frontend uses the returned cacheIds to display thumbnails in the preview table.
 * Files are served via GET /api/jira/attachment-cache/:cacheId.
 * 單檔上限見 shared/attachment-limits.ts；下載途中超過就中止，不會先下載完才判斷。
 */
router.post(['/api/attachments/prefetch', '/api/jira/attachment-prefetch'], async (req, res, next) => {
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
          let file: DownloadedFile
          if (isGoogleDriveUrl(trimmed)) {
            const fileId = parseGoogleDriveFileId(trimmed)
            if (!fileId) {
              attachments.push({ cacheId: '', filename: trimmed, mimeType: '', isImage: false, isVideo: false, size: 0, error: '無法解析 Google Drive 連結' })
              continue
            }
            file = await downloadGoogleDriveFile(fileId)
          } else if (trimmed.startsWith(LARK_MEDIA_SCHEME)) {
            if (!larkToken) larkToken = await getLarkToken()
            file = await downloadLarkMedia(trimmed, larkToken)
          } else if (isLarkEmbedImageUrl(trimmed)) {
            if (!larkToken) larkToken = await getLarkToken()
            file = await downloadLarkEmbedImage(trimmed, larkToken)
          } else {
            const fileToken = parseLarkFileToken(trimmed)
            if (!fileToken) {
              // filename-only cell (no URL/token) — Lark 「插入→附件」功能不透過 API 暴露 file token
              // 顯示為影片圖示，使用者可用工具的手動上傳按鈕替代
              attachments.push({ cacheId: '', filename: trimmed, mimeType: 'video/link', isImage: false, isVideo: true, size: 0 })
              continue
            }
            if (!larkToken) larkToken = await getLarkToken()
            file = await downloadLarkFile(fileToken, larkToken)
          }
          // 大小在下載途中就檢查了（超過會丟 AttachmentTooLargeError、半成品已刪），這裡拿到的一定在上限內
          attachments.push({ cacheId: file.cacheId, filename: file.filename, mimeType: file.mimeType, isImage: file.mimeType.startsWith('image/'), isVideo: file.mimeType.startsWith('video/'), size: file.size })
        } catch (err) {
          console.warn('[attachment-prefetch] download failed:', trimmed, err)
          const tooLarge = err instanceof AttachmentTooLargeError
          attachments.push({ cacheId: '', filename: trimmed, mimeType: '', isImage: false, isVideo: false, size: tooLarge ? (err.sizeBytes ?? 0) : 0, error: tooLarge ? err.message : String(err) })
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
                const f = await downloadLarkFile(fileToken, larkToken)
                attachments.push({ cacheId: f.cacheId, filename: f.filename, mimeType: f.mimeType, isImage: f.mimeType.startsWith('image/'), isVideo: f.mimeType.startsWith('video/'), size: f.size })
              } catch (err) {
                console.warn('[attachment-prefetch] cell_image download failed:', fileToken, err)
                // 原本這裡只印 log、畫面上什麼都不顯示——超過上限的圖會無聲消失
                if (err instanceof AttachmentTooLargeError) {
                  attachments.push({ cacheId: '', filename: `儲存格圖片 ${fileToken.slice(0, 8)}`, mimeType: '', isImage: false, isVideo: false, size: err.sizeBytes ?? 0, error: err.message })
                }
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
router.get(['/api/attachments/cache/:cacheId', '/api/jira/attachment-cache/:cacheId'], (req, res) => {
  const cacheId = String(req.params.cacheId)
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
router.delete(['/api/attachments/cache/:cacheId', '/api/jira/attachment-cache/:cacheId'], (req, res) => {
  const cacheId = String(req.params.cacheId)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cacheId)) {
    return res.status(400).json({ ok: false, message: 'invalid id' })
  }
  const fp = join(ATTACH_CACHE_DIR, cacheId)
  try { if (existsSync(fp)) unlinkSync(fp) } catch { /* ignore */ }
  res.json({ ok: true })
})


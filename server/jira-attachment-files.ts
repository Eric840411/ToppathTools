/**
 * Jira 附件的落盤、下載、上傳。目標：**任何一步都不把整個檔案放進記憶體**。
 *
 * 為什麼（CodeX review，2026-10-01）：上限從 10MB 拉到 100MB 之後，原本的寫法會讓 57MB 的影片
 * 在記憶體裡出現好幾份——multer memoryStorage 一份、`readFileSync` 一份、`new Blob([buffer])` 再一份；
 * 批量評論還會先把整批附件讀成 Buffer 陣列再逐張送。幾個人同時傳，worker（--max-old-space-size=640）就會吃緊。
 *
 * 規則：
 * - 下載：串流寫進快取目錄，邊寫邊累計 bytes，**超過上限立刻中止並刪掉半成品**（不是下載完才判斷）
 * - 上傳到 Jira：用 `fs.openAsBlob()` 拿到「背後是檔案」的 Blob，fetch 會串流送出
 * - 快取清理：依 mtime 刪超過 2 小時的檔；**要用檔案前先 touch**，清理就不會刪到正在用的——
 *   清理跑在 server 和 worker 兩支 process，in-memory 的「使用中」名單互相看不到，mtime 是兩邊都看得到的
 */
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { MAX_ATTACHMENT_BYTES, attachmentTooLargeMessage } from '../shared/attachment-limits.js'

export const ATTACH_CACHE_DIR = join(process.cwd(), 'server', 'attachment-cache')
if (!existsSync(ATTACH_CACHE_DIR)) mkdirSync(ATTACH_CACHE_DIR, { recursive: true })

export const CACHE_TTL_MS = 2 * 60 * 60 * 1000

export class AttachmentTooLargeError extends Error {
  constructor(public sizeBytes?: number) { super(attachmentTooLargeMessage(sizeBytes)) }
}

export const cachePath = (cacheId: string) => join(ATTACH_CACHE_DIR, cacheId)

export function safeUnlink(path: string) {
  try { unlinkSync(path) } catch { /* 已經不在 */ }
}

/** 標記「正在使用」——把 mtime 更新成現在，清理就不會刪到 */
export function touchCacheFile(path: string) {
  try { const now = new Date(); utimesSync(path, now, now) } catch { /* 檔案不在，呼叫端會處理 */ }
}

/** 刪掉超過 TTL 的快取檔（依 mtime）。`now` 可注入給測試。 */
export function cleanAttachmentCache(now = Date.now(), dir = ATTACH_CACHE_DIR): number {
  let removed = 0
  try {
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f)
      try {
        if (now - statSync(fp).mtimeMs > CACHE_TTL_MS) { unlinkSync(fp); removed++ }
      } catch { /* 被別人刪了 */ }
    }
  } catch { /* 目錄不在 */ }
  return removed
}

let sweeper: NodeJS.Timeout | null = null
/** 定期清理。原本只在 prefetch 被呼叫時才清，沒人用預先抓附件的話，手動上傳的檔永遠不會被清 */
export function startAttachmentCacheSweeper(intervalMs = 15 * 60 * 1000) {
  if (sweeper) return
  sweeper = setInterval(() => cleanAttachmentCache(), intervalMs)
  sweeper.unref()
}

export type CachedFile = { cacheId: string; path: string; size: number }

/**
 * 把 fetch 的回應串流寫進快取，超過上限中止並刪掉半成品。
 * Content-Length 已經超過的話連下載都不開始。
 */
export async function saveResponseToCache(resp: Response, maxBytes = MAX_ATTACHMENT_BYTES, dir = ATTACH_CACHE_DIR): Promise<CachedFile> {
  const declared = Number(resp.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {})
    throw new AttachmentTooLargeError(declared)
  }
  if (!resp.body) throw new Error('下載回應沒有內容')
  const cacheId = randomUUID()
  const path = join(dir, cacheId)
  let size = 0
  const counted = Readable.fromWeb(resp.body as import('stream/web').ReadableStream<Uint8Array>)
  counted.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > maxBytes) counted.destroy(new AttachmentTooLargeError(size))
  })
  try {
    await pipeline(counted, createWriteStream(path))
  } catch (e) {
    safeUnlink(path)
    throw e
  }
  return { cacheId, path, size }
}

// 用 namespace 取，不用具名 import：舊版 Node 沒有 openAsBlob 時，具名 import 會讓整支模組載入失敗
const openAsBlob = (fs as unknown as { openAsBlob?: (p: string, o: { type: string }) => Promise<Blob> }).openAsBlob
const hasOpenAsBlob = typeof openAsBlob === 'function'

/**
 * 從快取檔上傳到 Jira。`openAsBlob` 讓 fetch 直接從檔案串流，不讀進記憶體。
 * （Node 19.8 以前沒有 openAsBlob，才退回整檔讀取。）
 */
export async function uploadFileToJira(issueKey: string, filename: string, filePath: string, mimeType: string, auth: string, baseUrl: string): Promise<string> {
  touchCacheFile(filePath)
  const blob = hasOpenAsBlob
    ? await openAsBlob!(filePath, { type: mimeType })
    : new Blob([await readFile(filePath)], { type: mimeType })
  const form = new FormData()
  form.append('file', blob, filename)
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

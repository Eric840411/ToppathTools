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

// ─── 租約：保護整批排隊中的附件 ─────────────────────────────────────────────────
// CodeX review 05145a3：只在「輪到那一列」才 touch，批次跑很久時後面排隊的檔可能先被清掉，
// 最後只留一行 log、附件漏傳。所以批次開始時把整批 cacheId 登記成租約，清理一律跳過，批次結束才放。
// 存成檔案（不是記憶體）：清理跑在 server 和 worker 兩支 process，兩邊都要看得到。
// 租約有到期時間——worker 當掉沒放租約，過期後還是會被清，不會永久佔著。
export const LEASE_DIR = join(process.cwd(), 'server', 'attachment-cache-leases')
export const LEASE_TTL_MS = 30 * 60 * 1000
const CACHE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const isCacheId = (s: string) => CACHE_ID_RE.test(s)

function leaseFile(leaseId: string, dir: string) { return join(dir, `${leaseId}.json`) }

export function createLease(cacheIds: string[], opts: { ttlMs?: number; now?: number; leaseDir?: string; cacheDir?: string } = {}): string {
  const dir = opts.leaseDir ?? LEASE_DIR
  mkdirSync(dir, { recursive: true })
  const ids = [...new Set(cacheIds.filter(isCacheId))]
  const leaseId = randomUUID()
  fs.writeFileSync(leaseFile(leaseId, dir), JSON.stringify({ ids, until: (opts.now ?? Date.now()) + (opts.ttlMs ?? LEASE_TTL_MS) }))
  for (const id of ids) touchCacheFile(join(opts.cacheDir ?? ATTACH_CACHE_DIR, id))
  return leaseId
}

export function renewLease(leaseId: string, opts: { ttlMs?: number; now?: number; leaseDir?: string } = {}): boolean {
  if (!isCacheId(leaseId)) return false
  const fp = leaseFile(leaseId, opts.leaseDir ?? LEASE_DIR)
  try {
    const lease = JSON.parse(fs.readFileSync(fp, 'utf8')) as { ids: string[]; until: number }
    lease.until = (opts.now ?? Date.now()) + (opts.ttlMs ?? LEASE_TTL_MS)
    fs.writeFileSync(fp, JSON.stringify(lease))
    return true
  } catch { return false }
}

export function releaseLease(leaseId: string, leaseDir = LEASE_DIR) {
  if (isCacheId(leaseId)) safeUnlink(leaseFile(leaseId, leaseDir))
}

/** 目前有效租約保護的所有 cacheId；過期的租約順手刪掉 */
export function leasedCacheIds(now = Date.now(), leaseDir = LEASE_DIR): Set<string> {
  const out = new Set<string>()
  let names: string[] = []
  try { names = readdirSync(leaseDir) } catch { return out }
  for (const n of names) {
    const fp = join(leaseDir, n)
    try {
      const lease = JSON.parse(fs.readFileSync(fp, 'utf8')) as { ids: string[]; until: number }
      if (lease.until > now) lease.ids.forEach(id => out.add(id))
      else safeUnlink(fp)
    } catch { /* 寫到一半的租約檔，下一輪再看 */ }
  }
  return out
}

/** 程式裡用：拿租約並定期續約，結束時 release()。worker 的批量評論用這個 */
export function holdLease(cacheIds: string[], renewEveryMs = 10 * 60 * 1000): { leaseId: string; release: () => void } {
  const leaseId = createLease(cacheIds)
  const timer = setInterval(() => renewLease(leaseId), renewEveryMs)
  timer.unref()
  return { leaseId, release: () => { clearInterval(timer); releaseLease(leaseId) } }
}

/** 刪掉超過 TTL 的快取檔（依 mtime），**租約保護的跳過**。`now`／目錄可注入給測試。 */
export function cleanAttachmentCache(now = Date.now(), dir = ATTACH_CACHE_DIR, leaseDir = LEASE_DIR): number {
  let removed = 0
  try {
    const expired = readdirSync(dir).filter(f => {
      try { return now - statSync(join(dir, f)).mtimeMs > CACHE_TTL_MS } catch { return false }
    })
    if (!expired.length) return 0
    // 租約在決定要刪之後才讀：縮小「剛建立租約、清理還拿著舊名單」的空窗
    const leased = leasedCacheIds(now, leaseDir)
    for (const f of expired) {
      if (leased.has(f)) continue
      try { unlinkSync(join(dir, f)); removed++ } catch { /* 被別人刪了 */ }
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

// ─── 手動上傳（瀏覽器 → 快取）──────────────────────────────────────────────────

type ReqWithPaths = { _uploadPaths?: string[] }

/**
 * 自己寫的落盤 storage engine（取代 multer.diskStorage），為了兩件事：
 * 1. 路徑一建立就記在 req 上，**任何失敗都刪得到**——multer 只在它自己的錯誤時刪，
 *    用戶端中途斷線、或回了錯誤之後（CodeX：模擬 ENOSPC，diskStorage 建了寫入串流卻沒 unlink）都會留下半成品
 * 2. 寫入串流可以注入，測試才能模擬磁碟寫滿
 */
function trackedDiskStorage(dir: string, createStream: (path: string) => fs.WriteStream | import('stream').Writable): import('multer').StorageEngine {
  return {
    _handleFile(req, file, cb) {
      const name = randomUUID()
      const path = join(dir, name)
      ;((req as unknown as ReqWithPaths)._uploadPaths ??= []).push(path)
      const out = createStream(path)
      let done = false
      const fail = (err: Error) => { if (done) return; done = true; file.stream.unpipe(out); file.stream.resume(); cb(err) }
      out.on('error', fail)
      file.stream.on('error', fail)
      out.on('finish', () => {
        if (done) return
        done = true
        let size = 0
        try { size = statSync(path).size } catch { /* 下面 cb 照樣回，大小 0 */ }
        cb(null, { destination: dir, filename: name, path, size })
      })
      file.stream.pipe(out)
    },
    _removeFile(_req, file, cb) {
      safeUnlink((file as { path?: string }).path ?? '')
      cb(null)
    },
  }
}

/** 刪半成品。Windows 上檔案還被寫入串流開著時刪不掉，稍等重試幾次 */
export function removeUploadPaths(paths: string[], attempt = 0) {
  const left = paths.filter(p => { safeUnlink(p); return existsSync(p) })
  if (left.length && attempt < 5) setTimeout(() => removeUploadPaths(left, attempt + 1), 500).unref()
}

/**
 * 附件上傳的 express handler（不含登入檢查，由路由那邊先擋）。
 * `opts` 給測試注入目錄與寫入串流。
 */
export async function createAttachmentUploadHandler(opts: {
  dir?: string
  createStream?: (path: string) => fs.WriteStream | import('stream').Writable
} = {}) {
  const multer = (await import('multer')).default
  const dir = opts.dir ?? ATTACH_CACHE_DIR
  const upload = multer({
    storage: trackedDiskStorage(dir, opts.createStream ?? (p => createWriteStream(p))),
    // ⚠️ +1：busboy 是「到達」上限就判定超過，傳 MAX 的話剛好 100MiB 的檔會被擋（實測）
    limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 1 },
  }).single('file')

  return (req: import('express').Request, res: import('express').Response) => {
    const paths = () => (req as unknown as ReqWithPaths)._uploadPaths ?? []
    // 回應還沒送出就關閉＝用戶端中途斷線
    res.on('close', () => { if (!res.writableFinished && paths().length) removeUploadPaths(paths()) })
    upload(req, res, (err: unknown) => {
      if (err) {
        // 任何錯誤都刪：上限、磁碟寫滿、表單壞掉……（回了錯誤之後上面那個 close 會因為 writableFinished 而跳過）
        if (paths().length) removeUploadPaths(paths())
        const isLimit = (err as { code?: string }).code === 'LIMIT_FILE_SIZE'
        return res.status(isLimit ? 413 : 500).json({
          ok: false,
          message: isLimit ? attachmentTooLargeMessage() : `上傳失敗：${(err as Error).message ?? String(err)}`,
        })
      }
      const file = req.file
      if (!file) return res.status(400).json({ ok: false, message: '未收到檔案' })
      const mimeType = file.mimetype || 'application/octet-stream'
      return res.json({
        ok: true,
        cacheId: file.filename,
        filename: file.originalname,
        mimeType,
        size: file.size,
        isImage: mimeType.startsWith('image/'),
        isVideo: mimeType.startsWith('video/'),
      })
    })
  }
}

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

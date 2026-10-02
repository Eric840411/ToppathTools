/**
 * server/attachment-downloads.ts —— 從 Lark Drive／Lark 媒體／Sheet 內嵌圖／Google Drive 把附件下載到快取。
 * 2026-10-02 從 routes/jira.ts 搬出來：附件預載（routes/attachments.ts，Meegle 在用）與 Jira 批量開單共用。
 * 快取、上限、串流都在 jira-attachment-files.ts。
 */
import { saveResponseToCache, type CachedFile } from './jira-attachment-files.js'

/** 從 Lark 分享連結或 Drive URL 中提取 file_token */
export function parseLarkFileToken(url: string): string | null {
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

export type DownloadedFile = CachedFile & { filename: string; mimeType: string }

/** 下載到快取（串流、邊下載邊算大小，超過上限中止）。檔名與型別從回應標頭取 */
export async function downloadToCache(resp: Response, fallbackName: string, fallbackType: string): Promise<DownloadedFile> {
  const cd = resp.headers.get('content-disposition') ?? ''
  const fnMatch = cd.match(/filename\*=UTF-8''(.+)/i) ?? cd.match(/filename="?([^";\r\n]+)"?/i)
  const filename = fnMatch ? decodeURIComponent(fnMatch[1].trim()) : fallbackName
  const mimeType = resp.headers.get('content-type')?.split(';')[0] ?? fallbackType
  const saved = await saveResponseToCache(resp)
  return { ...saved, filename, mimeType }
}

/** 透過 Lark Drive API 下載檔案到快取 */
export async function downloadLarkFile(fileToken: string, larkToken: string): Promise<DownloadedFile> {
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const resp = await fetch(`${base}/open-apis/drive/v1/files/${fileToken}/download`, {
    headers: { Authorization: `Bearer ${larkToken}` },
  })
  if (!resp.ok) throw new Error(`Lark Drive download failed: HTTP ${resp.status}`)
  return downloadToCache(resp, `file_${fileToken}`, 'application/octet-stream')
}

/**
 * Sheet 儲存格裡「插入 → 附件」的檔案（例如影片）。records 會把它轉成 `lark-media://{fileToken}/{檔名}` 放進 `欄名__url`。
 * 2026-10-02 實測：v2 values API 回 `[{type:'attachment', fileToken, mimeType, size, text}]`，
 * 要用 **medias** 下載（drive/v1/files 會 403）。原本以為 API 拿不到 token、只能手動上傳——其實拿得到，只是 records 把它攤平成檔名了。
 */
export const LARK_MEDIA_SCHEME = 'lark-media://'
export async function downloadLarkMedia(ref: string, larkToken: string): Promise<DownloadedFile> {
  const rest = ref.slice(LARK_MEDIA_SCHEME.length)
  const slash = rest.indexOf('/')
  const fileToken = slash < 0 ? rest : rest.slice(0, slash)
  const name = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1))
  if (!/^[A-Za-z0-9_-]+$/.test(fileToken)) throw new Error('附件 token 不合法')
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const resp = await fetch(`${base}/open-apis/drive/v1/medias/${fileToken}/download`, { headers: { Authorization: `Bearer ${larkToken}` } })
  if (!resp.ok) throw new Error(`Lark 附件下載失敗：HTTP ${resp.status}`)
  return downloadToCache(resp, name || `media_${fileToken}`, 'application/octet-stream')
}

/** 判斷 URL 是否為 Lark embed-image 內嵌圖片 URL（非 Drive 下載路徑） */
export function isLarkEmbedImageUrl(url: string): boolean {
  return url.includes('mount_point=sheet_image') || url.includes('/space/api/box/stream/download/')
}

/** 下載 Lark Sheet embed-image（使用 Lark media download API） */
export async function downloadLarkEmbedImage(link: string, larkToken: string): Promise<DownloadedFile> {
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
  return downloadToCache(resp, `image_${fileToken}.jpg`, 'image/jpeg')
}

/** 判斷 URL 是否為 Google Drive */
export function isGoogleDriveUrl(url: string): boolean {
  return /drive\.google\.com|drive\.usercontent\.google\.com/.test(url)
}

/** 從 Google Drive 分享連結提取 file ID */
export function parseGoogleDriveFileId(url: string): string | null {
  const m1 = url.match(/\/d\/([A-Za-z0-9_-]+)/)
  if (m1) return m1[1]
  const m2 = url.match(/[?&]id=([A-Za-z0-9_-]+)/)
  if (m2) return m2[1]
  return null
}

/** 透過 HEAD 請求偵測 Google Drive 檔案類型（image / video / other） */
export async function detectGoogleDriveFileType(fileId: string): Promise<'image' | 'video' | 'other'> {
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
export async function downloadGoogleDriveFile(fileId: string): Promise<DownloadedFile> {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0`
  const resp = await fetch(url, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`Google Drive download failed: HTTP ${resp.status}`)
  return downloadToCache(resp, `gdrive_${fileId}`, 'application/octet-stream')
}

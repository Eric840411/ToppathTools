/**
 * 把「網址／上傳帶進來的檔名」安全地接到某個目錄底下。
 *
 * 不能直接 `join(dir, req.params.filename)`：Express 會把 `%2F`／`%5C` 解碼成斜線，
 * `join` 再把 `..` 正規化掉，`..%2F..%2Fdata.db` 就變成伺服器上的 DB（資安審查 2026-10-19）。
 *
 * 規則：只收單純的檔名（不能有任何路徑分隔、不能是 . 或 ..、不能有控制字元），
 * 解析後必須仍在 baseDir 底下；有給 allowedExts 時副檔名也要在清單內。不符合一律回 null，
 * 呼叫端回 400——不默默改名成別的檔案。
 */
import { basename, extname, resolve, sep } from 'path'

export function safeChildPath(baseDir: string, name: unknown, allowedExts?: readonly string[]): string | null {
  if (typeof name !== 'string' || !name || name.length > 255) return null
  if (name === '.' || name === '..') return null
  if (/[\\/\x00-\x1f]/.test(name)) return null
  if (basename(name) !== name) return null
  if (allowedExts && !allowedExts.includes(extname(name).toLowerCase())) return null
  const base = resolve(baseDir)
  const full = resolve(base, name)
  if (!full.startsWith(base + sep)) return null
  return full
}

/** 機種代碼這類拿來組檔名的識別字：只收英數、底線、連字號。 */
export function isSafeId(v: unknown, maxLen = 64): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen && /^[A-Za-z0-9_-]+$/.test(v)
}

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'] as const

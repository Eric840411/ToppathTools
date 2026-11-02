/**
 * 文書工具（Eric Office）：/office/<app>/* 靜態檔＋/api/office/apps。說明見 docs/features/34-office.md。
 *
 * ⚠️ 這個 router 要掛在 dist 的 express.static／SPA fallback **之前**：
 *    全站登入檢查（index.ts）只擋 /api 與 /internal，/office 是靜態檔，登入與權限都由這裡自己驗。
 *    掛到後面的話 SPA fallback 會先把 index.html 回給未登入的人（CodeX 2026-11-02）。
 */
import { Router, type Request, type Response } from 'express'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, basename, join } from 'path'
import { accountHasPermission } from '../shared.js'
import { getAuthAccount } from '../auth-session.js'
import {
  availableApps, currentReleaseDir, isHashedAsset, resolveOfficePath,
  OFFICE_GZIP_EXTS, OFFICE_RETIRE_SW, OFFICE_TYPES,
} from '../office-files.js'

export const router = Router()

export const OFFICE_PAGE_KEY = 'office'

function officeBaseDir(): string {
  return process.env.OFFICE_DIST_DIR || join(process.cwd(), 'office-dist')
}

/** 瀏覽器直接開頁面（不是 JS／WASM 子資源）——未登入要導回登入頁，不是回一段 JSON */
function isDocumentRequest(req: Request): boolean {
  const dest = req.headers['sec-fetch-dest']
  if (typeof dest === 'string') return dest === 'document' || dest === 'iframe'
  return (req.headers.accept ?? '').includes('text/html')
}

/** 回 null＝已經回應過（401／403）；呼叫端直接 return */
function gate(req: Request, res: Response): { email: string } | null {
  const acc = getAuthAccount(req)
  if (!acc) {
    if (isDocumentRequest(req)) res.redirect(302, '/')
    else res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', message: '請先登入' })
    return null
  }
  if (!accountHasPermission(acc.email, acc.role, OFFICE_PAGE_KEY)) {
    if (isDocumentRequest(req)) res.status(403).type('text/plain; charset=utf-8').send('這個帳號沒有「文書工具」的權限，請找管理員開通。')
    else res.status(403).json({ ok: false, code: 'FORBIDDEN', message: '沒有文書工具的權限' })
    return null
  }
  return { email: acc.email }
}

router.get('/api/office/apps', (req, res) => {
  if (!gate(req, res)) return
  const rel = currentReleaseDir(officeBaseDir())
  if (!rel) return res.json({ ok: true, deployed: false, release: null, apps: [] })
  res.json({ ok: true, deployed: true, release: rel.name, apps: availableApps(rel.dir) })
})

function serveOffice(req: Request, res: Response) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end()
  const base = officeBaseDir()
  const target = resolveOfficePath(base, req.path, currentReleaseDir(base)?.name ?? null)
  // 退役 SW 不驗登入：登出狀態下舊 SW 也要能被換掉（原因見 OFFICE_RETIRE_SW）
  if (target.kind === 'sw') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    return res.end(req.method === 'HEAD' ? undefined : OFFICE_RETIRE_SW)
  }
  if (!gate(req, res)) return
  if (target.kind === 'undeployed') return res.status(503).type('text/plain; charset=utf-8').send('文書工具尚未部署')
  if (target.kind === 'redirect') {
    const q = req.originalUrl.indexOf('?')
    // 302：入口 /office/<app>/ 指向的版本會隨部署改變，不能讓瀏覽器永久記住
    return res.redirect(302, target.to + (q >= 0 ? req.originalUrl.slice(q) : ''))
  }
  if (target.kind === 'notfound' || !existsSync(target.file) || !statSync(target.file).isFile()) {
    return res.status(404).type('text/plain; charset=utf-8').send('not found')
  }

  const file = target.file
  const ext = extname(file).toLowerCase()
  const stat = statSync(file)
  const hashed = isHashedAsset(basename(file))
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  // 登入後才拿得到的內容一律 private，代理不能快取給別人
  const cache = hashed ? 'private, max-age=31536000, immutable' : 'private, no-cache'
  if (!hashed && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache }).end()
    return
  }
  const headers: Record<string, string> = {
    'Content-Type': OFFICE_TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    // 跟 craft-office 的 serve-web.mjs 一樣全部帶上：Film／Effect 開在最上層分頁時才拿得到
    // crossOriginIsolated；其他工具嵌在 Toppath 的 iframe 裡，子文件帶 COEP 不影響外層。
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    Vary: 'Accept-Encoding',
  }
  if (!hashed) headers.ETag = etag

  const gz = file + '.gz'
  if (OFFICE_GZIP_EXTS.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && existsSync(gz)) {
    const gzStat = statSync(gz)
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': String(gzStat.size) })
    if (req.method === 'HEAD') return res.end()
    createReadStream(gz).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

router.all(/^\/office(\/.*)?$/i, serveOffice)

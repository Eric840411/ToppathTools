/**
 * OSM 環境導航（第一階段預覽）：/osm-env-nav/page 回傳整份導航頁 HTML。說明見 docs/features/36-osm-env-nav.md。
 *
 * - 頁面內含 Lark「主頁」上的真實帳號與 token，所以 HTML 不進 git、不打包進前端，
 *   只放在專案目錄外（預設 ~/.toppath-private/，可用 OSM_ENV_NAV_HTML 指定），由這裡驗登入＋osm-env-nav 權限後才下發。
 * - ⚠️ 跟 office.ts 一樣要掛在 dist 的 express.static／SPA fallback **之前**（全站登入檢查只擋 /api 與 /internal）。
 * - 有權限的人就拿得到整份明文（含 Prod 憑證）；遮罩不是保護，權限要只開給該看的人（CodeX 2026-11-20）。
 * - 第一階段沒有寫入：頁內編輯只在記憶體，重新整理就還原；第二階段才進 DB＋加密。
 */
import { Router, type Request, type Response } from 'express'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { accountHasPermission } from '../shared.js'
import { getAuthAccount } from '../auth-session.js'

export const router = Router()

export const OSM_ENV_NAV_PAGE_KEY = 'osm-env-nav'

// 預設放在使用者家目錄（專案目錄外）：放在專案根目錄底下時，Vite dev server 會不經登入直接把檔案吐出去（CodeX 審 379cc7f P1）
export function osmEnvNavHtmlPath(): string {
  return process.env.OSM_ENV_NAV_HTML || join(homedir(), '.toppath-private', 'osm-env-nav.html')
}

function isDocumentRequest(req: Request): boolean {
  const dest = req.headers['sec-fetch-dest']
  if (typeof dest === 'string') return dest === 'document' || dest === 'iframe'
  return (req.headers.accept ?? '').includes('text/html')
}

function deny(res: Response, status: number, text: string) {
  res.status(status).set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(text)
}

router.get('/osm-env-nav/page', (req: Request, res: Response) => {
  const acc = getAuthAccount(req)
  if (!acc) {
    // 在 iframe 裡被導到登入頁會變成「登入頁套在內框」，所以內框只回文字，由外層頁面處理登入
    if (isDocumentRequest(req) && req.headers['sec-fetch-dest'] !== 'iframe') return res.redirect(302, '/')
    return deny(res, 401, '請先登入')
  }
  if (!accountHasPermission(acc.email, acc.role, OSM_ENV_NAV_PAGE_KEY)) {
    return deny(res, 403, '這個帳號沒有「OSM 環境導航」的權限，請找管理員開通。')
  }
  const p = osmEnvNavHtmlPath()
  if (!existsSync(p)) return deny(res, 404, '這台伺服器還沒放導航頁資料（~/.toppath-private/osm-env-nav.html，或用 OSM_ENV_NAV_HTML 指定）。')
  res.set('Cache-Control', 'no-store')
  res.set('X-Frame-Options', 'SAMEORIGIN')
  res.type('text/html; charset=utf-8').send(readFileSync(p, 'utf8'))
})

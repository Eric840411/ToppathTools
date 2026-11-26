/**
 * OSM 環境導航（第一階段預覽）：/osm-env-nav/page 回傳整份導航頁 HTML。說明見 docs/features/36-osm-env-nav.md。
 *
 * - 頁面內含 Lark「主頁」上的真實帳號與 token，所以 HTML 不進 git、不打包進前端，
 *   只放在專案目錄外（預設 ~/.toppath-private/，可用 OSM_ENV_NAV_HTML 指定），由這裡驗登入＋osm-env-nav 權限後才下發。
 * - ⚠️ 跟 office.ts 一樣要掛在 dist 的 express.static／SPA fallback **之前**（全站登入檢查只擋 /api 與 /internal）。
 * - 有權限的人就拿得到整份明文（含 Prod 憑證）；遮罩不是保護，權限要只開給該看的人（CodeX 2026-11-20）。
 * - 第一階段導航資料沒有寫入：頁內編輯只在記憶體，重新整理就還原；第二階段才進 DB＋加密。
 * - 例外：銀月功德（v5.94.0）是全員共用的每週計數，存 DB（/api/osm-env-nav/merit*），不含任何帳密。
 */
import { Router, type Request, type Response } from 'express'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { accountHasPermission, db } from '../shared.js'
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

// ─── 銀月功德：全員共用的每週計數（v5.94.0） ─────────────────────────────────────
// 設計經 CodeX 2026-11-26 確認：累加用原子 UPSERT、批次去重與累加同一個 transaction、
// 批次歸屬的週由前端帶上（跨週重試不會算進新週）、變身只看這裡回的確認值。

export const MERIT_EVO_AT = 30
export const MERIT_BATCH_MAX = 20
const MERIT_RATE_WINDOW_MS = 60_000
const MERIT_RATE_MAX = 300 // 每帳號每分鐘最多累加的功德數

db.exec(`
  CREATE TABLE IF NOT EXISTS osm_env_nav_merit (
    week_start TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS osm_env_nav_merit_batch (
    batch_id TEXT PRIMARY KEY,
    week_start TEXT NOT NULL,
    n INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`)

const DAY_MS = 86_400_000
const TAIPEI_OFFSET_MS = 8 * 3_600_000

/** 台北時間該週週一的日期（YYYY-MM-DD）。台北沒有日光節約，固定 +8。 */
export function meritWeekStart(nowMs: number = Date.now()): string {
  const t = nowMs + TAIPEI_OFFSET_MS
  const dow = (new Date(t).getUTCDay() + 6) % 7
  return new Date(t - dow * DAY_MS).toISOString().slice(0, 10)
}

function meritCount(week: string): number {
  const row = db.prepare('SELECT count FROM osm_env_nav_merit WHERE week_start = ?').get(week) as { count: number } | undefined
  return row?.count ?? 0
}

function meritState(nowMs: number = Date.now()) {
  const weekStart = meritWeekStart(nowMs)
  // serverNow／nextResetAt 給前端校準時鐘：敲的當下屬於哪一週要用伺服器時間判斷（CodeX 複審 bf939c2 P2）
  const nextResetAt = Date.parse(weekStart + 'T00:00:00Z') - TAIPEI_OFFSET_MS + 7 * DAY_MS
  return { ok: true as const, weekStart, count: meritCount(weekStart), evoAt: MERIT_EVO_AT, serverNow: nowMs, nextResetAt }
}

/** 累加一個批次；同一個 batchId 只算一次。回傳這次有沒有真的加進去。 */
export const applyMeritBatch = db.transaction((batchId: string, week: string, n: number, nowMs: number): boolean => {
  const ins = db.prepare('INSERT OR IGNORE INTO osm_env_nav_merit_batch (batch_id, week_start, n, created_at) VALUES (?, ?, ?, ?)').run(batchId, week, n, nowMs)
  if (ins.changes === 0) return false
  db.prepare('INSERT INTO osm_env_nav_merit (week_start, count) VALUES (?, ?) ON CONFLICT(week_start) DO UPDATE SET count = count + excluded.count').run(week, n)
  return true
})

const meritRate = new Map<string, { resetAt: number; used: number }>()
function meritRateTake(email: string, n: number, nowMs: number): boolean {
  let r = meritRate.get(email)
  if (!r || r.resetAt <= nowMs) { r = { resetAt: nowMs + MERIT_RATE_WINDOW_MS, used: 0 }; meritRate.set(email, r) }
  if (r.used + n > MERIT_RATE_MAX) return false
  r.used += n
  return true
}

function meritAuth(req: Request, res: Response): string | null {
  const acc = getAuthAccount(req)
  if (!acc) { res.status(401).json({ ok: false, message: '請先登入' }); return null }
  if (!accountHasPermission(acc.email, acc.role, OSM_ENV_NAV_PAGE_KEY)) { res.status(403).json({ ok: false, message: '沒有「OSM 環境導航」的權限' }); return null }
  return acc.email
}

router.get('/api/osm-env-nav/merit', (req: Request, res: Response) => {
  if (!meritAuth(req, res)) return
  res.set('Cache-Control', 'no-store').json(meritState())
})

router.post('/api/osm-env-nav/merit/hit', (req: Request, res: Response) => {
  const email = meritAuth(req, res)
  if (!email) return
  res.set('Cache-Control', 'no-store')
  const body = (req.body ?? {}) as { batchId?: unknown; n?: unknown; weekStart?: unknown }
  const batchId = typeof body.batchId === 'string' ? body.batchId : ''
  const n = body.n
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(batchId)) return res.status(400).json({ ok: false, message: 'batchId 格式不對' })
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MERIT_BATCH_MAX) return res.status(400).json({ ok: false, message: `n 要是 1～${MERIT_BATCH_MAX} 的整數` })
  const now = Date.now()
  const current = meritWeekStart(now)
  const previous = meritWeekStart(now - 7 * DAY_MS)
  // 批次屬於哪一週由前端帶（敲的當下那一週）；只收本週與上一週，沒帶就當本週
  const week = body.weekStart === undefined || body.weekStart === null ? current : body.weekStart
  if (week !== current && week !== previous) return res.status(400).json({ ok: false, message: '這批功德所屬的週已經過期' })
  const dup = db.prepare('SELECT 1 FROM osm_env_nav_merit_batch WHERE batch_id = ?').get(batchId)
  if (!dup) {
    if (!meritRateTake(email, n, now)) return res.status(429).json({ ok: false, message: '敲太快了，稍等一下' })
    applyMeritBatch(batchId, week, n, now)
    // 去重紀錄只需要撐過重試的時間，順手清掉兩週前的
    if (Math.random() < 0.02) db.prepare('DELETE FROM osm_env_nav_merit_batch WHERE created_at < ?').run(now - 14 * DAY_MS)
  }
  res.json(meritState(now))
})

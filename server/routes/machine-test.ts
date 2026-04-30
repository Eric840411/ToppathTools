/**
 * server/routes/machine-test.ts
 * All /api/machine-test/* and /api/image-check/* routes.
 */
import { Router } from 'express'
import { chromium } from 'playwright'
import { z } from 'zod'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  db,
  addHistory,
  browserLimiter,
  getLarkToken,
  parseLarkSheetUrl,
  upload,
} from '../shared.js'
import { readGeminiKeys } from './gemini.js'
import { MachineTestRunner } from '../machine-test/runner.js'
import type { MachineTestSession, MachineProfile } from '../machine-test/types.js'
import {
  broadcastToViewers,
  clearBroadcastBuffer,
  getAvailableAgents,
  registerDistSession,
  cancelDistSession,
  getJobStatuses,
  agentConnections,
} from '../agent-hub.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const AUTOSPIN_PROJECT_DIR = process.env.AUTOSPIN_PROJECT ?? join(__dirname, '../python')
const CCTV_REFS_DIR = join(__dirname, '..', 'machine-test', 'cctv-refs')

// Source files the agent package is allowed to download
const AGENT_SOURCE_WHITELIST: Record<string, string> = {
  'agent-runner.ts':               join(__dirname, '../agent-runner.ts'),
  'machine-test/runner.ts':        join(__dirname, '../machine-test/runner.ts'),
  'machine-test/types.ts':         join(__dirname, '../machine-test/types.ts'),
  'machine-test/gemini-agent.ts':  join(__dirname, '../machine-test/gemini-agent.ts'),
  'machine-test/record-spin.ps1':  join(__dirname, '../machine-test/record-spin.ps1'),
  'machine-test/record-audio.ps1': join(__dirname, '../machine-test/record-audio.ps1'),
  'machine-test/set-audio-device.ps1': join(__dirname, '../machine-test/set-audio-device.ps1'),
}

export const router = Router()

// ─── Machine Test Profiles ────────────────────────────────────────────────────

const profileSchema = z.object({
  machineType:       z.string().min(1).toUpperCase(),
  bonusAction:       z.enum(['auto_wait', 'spin', 'takewin', 'touchscreen']).default('auto_wait'),
  touchPoints:       z.array(z.string()).optional().nullable(),
  clickTake:         z.boolean().optional().nullable(),
  gmid:              z.string().optional().nullable(),
  spinSelector:      z.string().optional().nullable(),
  balanceSelector:   z.string().optional().nullable(),
  exitSelector:      z.string().optional().nullable(),
  notes:             z.string().optional().nullable(),
  entryTouchPoints:  z.array(z.string()).optional().nullable(),
  entryTouchPoints2: z.array(z.string()).optional().nullable(),
  ideckXpaths:       z.array(z.string()).optional().nullable(),
})

type MachineTestProfile = z.infer<typeof profileSchema>

// ─── OSM Machine Status Store ─────────────────────────────────────────────────
// Holds the latest status per machine ID, fed by OSMWatcher webhook.
// Status codes: 0=normal, 1=fg1, 2=fg2, 3=jackpot, 4=jackpot_active,
//               5=fg_active, 8=denom_switch, 9=handpay
export const osmMachineStatus = new Map<string, number>()

const OSM_STATUS_LABELS: Record<number, string> = {
  0: '正常',
  1: 'Free Game 觸發',
  2: 'Free Game 觸發 (2)',
  3: 'Jackpot 觸發',
  4: 'Jackpot 進行中',
  5: 'Free Game 進行中',
  8: '面額切換',
  9: 'Handpay（需人工處理）',
}

// ─── Active Runners ───────────────────────────────────────────────────────────

export const activeRunners = new Map<string, { stop: () => void; account: string }>()

const machineTestSessionSchema = z.object({
  lobbyUrls: z.array(z.string().url()).min(1),
  machineCodes: z.array(z.string().min(1)).min(1),
  steps: z.object({
    entry: z.boolean(),
    stream: z.boolean(),
    spin: z.boolean(),
    audio: z.boolean(),
    ideck: z.boolean().optional(),
    touchscreen: z.boolean().optional(),
    cctv: z.boolean().optional(),
    exit: z.boolean(),
  }),
  account: z.string().optional(),
  debugGmid: z.string().optional(),
  cctvModelSpec: z.string().optional(),
  headedMode: z.boolean().optional(),
  osmEnv: z.enum(['qat', 'prod']).optional(),
  aiAudio: z.boolean().optional(),
})

// ─── Image Check Sessions ─────────────────────────────────────────────────────

interface ImageCheckSession {
  deletedImages: string[]
  loadedImageUrls: string[]
  browser: import('playwright').Browser
  page: import('playwright').Page
  startedAt: number
}

const imageCheckSessions = new Map<string, ImageCheckSession>()

// ─── Routes: Lark Sheet integration ───────────────────────────────────────────

/** Read Lark Sheet, return rows with gmid excluding those marked 驗證通過 */
router.post('/api/machine-test/lark-machines', async (req, res, next) => {
  try {
    const { sheetUrl } = z.object({ sheetUrl: z.string() }).parse(req.body)
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)
    if (!spreadsheetToken) {
      return res.status(400).json({ ok: false, message: '無法解析 Lark Sheet URL' })
    }

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const range = sheetId ? `${sheetId}!A1:Z2000` : 'A1:Z2000'

    const resp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const data = (await resp.json()) as { code?: number; data?: { valueRange?: { values?: unknown[][] } } }
    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: 'Lark API 錯誤', detail: data })
    }

    const rows = data.data?.valueRange?.values ?? []
    if (rows.length < 3) return res.json({ ok: true, machines: [] })

    // Row 1 = main headers (gmid, QA問題回報…), Row 2 = sub-headers (QA確認狀態…), Row 3+ = data
    const headerRow1 = (rows[0] as unknown[]).map(c => (c !== null && c !== undefined ? String(c) : ''))
    const headerRow2 = (rows[1] as unknown[]).map(c => (c !== null && c !== undefined ? String(c) : ''))
    // Merge: prefer row1, fall back to row2
    const headers = headerRow1.map((h, i) => h || headerRow2[i] || '')

    const gmidCol = headers.findIndex(h => h === 'gmid')
    const qaCol   = headers.findIndex(h => h.includes('QA確認狀態'))

    if (gmidCol === -1) {
      return res.status(400).json({ ok: false, message: '找不到 gmid 欄位（請確認欄位名稱為 "gmid"）' })
    }

    const machines = rows.slice(2).flatMap((row, i) => {
      const r = row as unknown[]
      const gmid = String(r[gmidCol] ?? '').trim()
      const qaStatus = qaCol !== -1 ? String(r[qaCol] ?? '').trim() : ''
      if (!gmid || gmid === 'null' || qaStatus === '驗證通過') return []
      return [{ gmid, rowIndex: i + 3 }]  // rowIndex is 1-based, +2 for two header rows, +1 for slice offset
    })

    res.json({ ok: true, machines })
  } catch (error) {
    next(error)
  }
})

/** Write QA test results back to Lark Sheet */
router.post('/api/machine-test/lark-writeback', async (req, res, next) => {
  try {
    const body = z.object({
      sheetUrl: z.string(),
      writes: z.array(z.object({ rowIndex: z.number(), message: z.string(), qaStatus: z.string().optional() })),
    }).parse(req.body)

    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(body.sheetUrl)
    if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 Sheet URL' })

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

    // Read both header rows to find QA問題回報 (Row1) and QA確認狀態 (Row2)
    const headerRange = sheetId ? `${sheetId}!A1:Z2` : 'A1:Z2'
    const headerResp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${headerRange}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const headerData = (await headerResp.json()) as { data?: { valueRange?: { values?: unknown[][] } } }
    const hRows = headerData.data?.valueRange?.values ?? []
    const row1h = ((hRows[0] ?? []) as unknown[]).map(String)
    const row2h = ((hRows[1] ?? []) as unknown[]).map(String)
    const maxLen = Math.max(row1h.length, row2h.length)
    const mergedHeaders = Array.from({ length: maxLen }, (_, i) => row1h[i] || row2h[i] || '')

    const msgColIdx = mergedHeaders.findIndex(h => h.includes('QA問題回報'))
    const qaColIdx  = mergedHeaders.findIndex(h => h.includes('QA確認狀態'))

    if (msgColIdx === -1) {
      return res.status(400).json({ ok: false, message: '找不到「QA問題回報」欄位（欄位名需包含此文字）' })
    }

    const putCell = async (col: number, row: number, value: string) => {
      const letter = String.fromCharCode(65 + col)
      const cell = `${letter}${row}`
      const range = sheetId ? `${sheetId}!${cell}:${cell}` : `${cell}:${cell}`
      const r = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueRange: { range, values: [[value]] } }),
      })
      const rBody = await r.json().catch(() => null) as { code?: number; msg?: string } | null
      return { ok: r.ok && rBody?.code === 0, larkCode: rBody?.code, larkMsg: rBody?.msg }
    }

    const results = await Promise.all(
      body.writes.map(async ({ rowIndex, message, qaStatus }) => {
        const msgResult = await putCell(msgColIdx, rowIndex, message)
        let qaResult: { ok: boolean } | undefined
        if (qaStatus && qaColIdx !== -1) {
          qaResult = await putCell(qaColIdx, rowIndex, qaStatus)
        }
        return { rowIndex, ok: msgResult.ok, qaOk: qaResult?.ok, larkCode: msgResult.larkCode, larkMsg: msgResult.larkMsg }
      }),
    )

    res.json({ ok: true, results })
  } catch (error) {
    next(error)
  }
})

// ─── Routes: Image Check ───────────────────────────────────────────────────────

// POST /api/image-check/parse-screenshot
router.post('/api/image-check/parse-screenshot', async (req, res) => {
  try {
    let imageBase64: string, mimeType: string
    try {
      const parsed = z.object({ imageBase64: z.string(), mimeType: z.string().default('image/png') }).parse(req.body)
      imageBase64 = parsed.imageBase64
      mimeType = parsed.mimeType
    } catch (e) {
      return res.status(400).json({ ok: false, message: `參數錯誤：${String(e)}` })
    }

    const storedKeys = readGeminiKeys()
    const envKey = process.env.GEMINI_API_KEY ?? ''
    const keyEntries: { label: string; key: string }[] = [
      ...storedKeys,
      ...(envKey ? [{ label: 'env', key: envKey }] : []),
    ]
    if (keyEntries.length === 0) return res.status(400).json({ ok: false, message: '沒有可用的 Gemini API Key，請先在設定中新增' })

    const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
    const prompt = `This is a screenshot of a git diff or version control UI showing file changes.
Extract ALL file paths that are marked as "deleted" (shown in red, labeled "deleted", or with a "D" indicator).
Return ONLY a JSON array of strings. Example: ["assets/foo.png","assets/bar.webp"]
Only include paths with "/" and a file extension. Do NOT include .meta files.`

    console.log(`[ImageCheck] 開始解析截圖，imageBase64 長度=${imageBase64.length}, mimeType=${mimeType}`)

    let paths: string[] = []
    let lastError = ''
    for (const { label, key } of keyEntries) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: imageBase64 } },
              ]}],
              generationConfig: { temperature: 0.1 },
            }),
          },
        )
        const text = await resp.text()
        console.log(`[ImageCheck] Gemini (${label}) HTTP=${resp.status} body前200字:`, text.slice(0, 200))
        const data = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
        if (data.error) { lastError = data.error.message ?? 'Gemini error'; continue }
        const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        const match = responseText.match(/\[[\s\S]*?\]/)
        if (match) {
          try { paths = JSON.parse(match[0]) as string[]; break } catch { lastError = 'JSON parse failed' }
        } else {
          lastError = `Gemini 未回傳 JSON 陣列，原文：${responseText.slice(0, 100)}`
        }
      } catch (e) { lastError = String(e) }
    }

    if (paths.length === 0 && lastError) {
      return res.json({ ok: false, paths: [], message: `識別失敗：${lastError}` })
    }

    const filtered = paths.filter(p => typeof p === 'string' && p.includes('/'))
    console.log(`[ImageCheck] 識別完成，找到 ${filtered.length} 個路徑`)
    res.json({ ok: true, paths: filtered })
  } catch (err) {
    console.error('[ImageCheck] 未預期錯誤：', err)
    res.status(500).json({ ok: false, message: `伺服器錯誤：${String(err)}` })
  }
})

// POST /api/image-check/start — launch headless browser, return sessionId
router.post('/api/image-check/start', async (req, res, next) => {
  try {
    const { url, deletedImages } = z.object({
      url: z.string().url(),
      deletedImages: z.array(z.string()),
    }).parse(req.body)

    if (browserLimiter.queued() >= 8) {
      return res.status(429).json({ ok: false, message: `伺服器目前負載過高（排隊 ${browserLimiter.queued()} 個），請稍後再試` })
    }
    const browser = await browserLimiter.schedule(() => chromium.launch({ headless: true }))
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const loadedImageUrls: string[] = []

    page.on('request', r => {
      const rt = r.resourceType()
      const u = r.url()
      if (rt === 'image' || ((rt === 'fetch' || rt === 'xhr') && /\.(png|jpg|jpeg|webp|svg|gif|avif)(\?|$)/i.test(u))) {
        if (!loadedImageUrls.includes(u)) loadedImageUrls.push(u)
      }
    })

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch { /* timeout ok */ }

    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    imageCheckSessions.set(sessionId, { deletedImages, loadedImageUrls, browser, page, startedAt: Date.now() })

    // Auto-cleanup after 30 minutes
    setTimeout(async () => {
      const s = imageCheckSessions.get(sessionId)
      if (s) { imageCheckSessions.delete(sessionId); await s.browser.close().catch(() => {}) }
    }, 30 * 60 * 1000)

    res.json({ ok: true, sessionId })
  } catch (err) { next(err) }
})

// GET /api/image-check/screenshot/:id — capture and return current page as JPEG
router.get('/api/image-check/screenshot/:id', async (req, res) => {
  const s = imageCheckSessions.get(req.params.id)
  if (!s) return res.status(404).end()
  try {
    const shot = await s.page.screenshot({ type: 'jpeg', quality: 70 })
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.send(shot)
  } catch { res.status(500).end() }
})

// POST /api/image-check/click/:id — forward click to Playwright
router.post('/api/image-check/click/:id', async (req, res) => {
  const s = imageCheckSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  const { x, y } = req.body as { x: number; y: number }  // normalized 0–1
  const vp = s.page.viewportSize() ?? { width: 1280, height: 800 }
  try {
    await s.page.mouse.click(x * vp.width, y * vp.height)
    res.json({ ok: true })
  } catch { res.json({ ok: false }) }
})

// POST /api/image-check/scroll/:id — forward scroll to Playwright
router.post('/api/image-check/scroll/:id', async (req, res) => {
  const s = imageCheckSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  const { x, y, deltaY } = req.body as { x: number; y: number; deltaY: number }
  const vp = s.page.viewportSize() ?? { width: 1280, height: 800 }
  try {
    await s.page.mouse.move(x * vp.width, y * vp.height)
    await s.page.mouse.wheel(0, deltaY)
    res.json({ ok: true })
  } catch { res.json({ ok: false }) }
})

// GET /api/image-check/status/:id — live image count
router.get('/api/image-check/status/:id', (req, res) => {
  const s = imageCheckSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false, message: '找不到此 session' })
  res.json({ ok: true, loadedImageCount: s.loadedImageUrls.length, elapsedMs: Date.now() - s.startedAt })
})

// POST /api/image-check/stop/:id — close browser and return results
router.post('/api/image-check/stop/:id', async (req, res) => {
  const s = imageCheckSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false, message: '找不到此 session' })
  imageCheckSessions.delete(req.params.id)
  await s.browser.close().catch(() => {})

  const results = s.deletedImages
    .filter(p => p.trim())
    .map(imgPath => {
      const clean = imgPath.trim()
      const filename = clean.split('/').pop() ?? clean
      const matchedUrl = s.loadedImageUrls.find(u => u.includes(clean) || u.includes(filename))
      return { path: clean, found: !!matchedUrl, matchedUrl: matchedUrl ?? null }
    })

  const foundCount = results.filter(r => r.found).length
  addHistory(
    'image-check',
    '圖片刪除驗證',
    `驗證 ${results.length} 張圖片，仍載入 ${foundCount} 張，確認刪除 ${results.length - foundCount} 張`,
    { results, loadedImageCount: s.loadedImageUrls.length },
  )
  res.json({ ok: true, results, loadedImageCount: s.loadedImageUrls.length, foundCount, checkedCount: results.length })
})

// ─── Routes: Machine Test Profiles ────────────────────────────────────────────

// GET /api/machine-test/profiles
router.get('/api/machine-test/profiles', (_req, res) => {
  const rows = db.prepare('SELECT * FROM machine_test_profiles ORDER BY machineType').all() as (MachineTestProfile & { touchPoints: string | null; clickTake: number })[]
  const profiles = rows.map(r => ({
    ...r,
    touchPoints:       r.touchPoints       ? JSON.parse(r.touchPoints as unknown as string)       : [],
    entryTouchPoints:  r.entryTouchPoints  ? JSON.parse(r.entryTouchPoints as unknown as string)  : [],
    entryTouchPoints2: r.entryTouchPoints2 ? JSON.parse(r.entryTouchPoints2 as unknown as string) : [],
    ideckXpaths:       (r as unknown as { ideck_xpaths?: string }).ideck_xpaths ? JSON.parse((r as unknown as { ideck_xpaths: string }).ideck_xpaths) : [],
    clickTake: !!r.clickTake,
  }))
  res.json({ ok: true, profiles })
})

// PUT /api/machine-test/profiles — upsert
router.put('/api/machine-test/profiles', (req, res, next) => {
  try {
    const p = profileSchema.parse(req.body) as MachineTestProfile
    const row = {
      ...p,
      touchPoints:       p.touchPoints       ? JSON.stringify(p.touchPoints)       : null,
      entryTouchPoints:  p.entryTouchPoints  ? JSON.stringify(p.entryTouchPoints)  : null,
      entryTouchPoints2: p.entryTouchPoints2 ? JSON.stringify(p.entryTouchPoints2) : null,
      ideck_xpaths:      JSON.stringify(p.ideckXpaths ?? []),
      clickTake: p.clickTake ? 1 : 0,
    }
    db.prepare(`
      INSERT INTO machine_test_profiles (machineType, bonusAction, touchPoints, clickTake, gmid, spinSelector, balanceSelector, exitSelector, notes, entryTouchPoints, entryTouchPoints2, ideck_xpaths)
      VALUES (@machineType, @bonusAction, @touchPoints, @clickTake, @gmid, @spinSelector, @balanceSelector, @exitSelector, @notes, @entryTouchPoints, @entryTouchPoints2, @ideck_xpaths)
      ON CONFLICT(machineType) DO UPDATE SET
        bonusAction=excluded.bonusAction, touchPoints=excluded.touchPoints, clickTake=excluded.clickTake,
        gmid=excluded.gmid, spinSelector=excluded.spinSelector, balanceSelector=excluded.balanceSelector,
        exitSelector=excluded.exitSelector, notes=excluded.notes,
        entryTouchPoints=excluded.entryTouchPoints, entryTouchPoints2=excluded.entryTouchPoints2,
        ideck_xpaths=excluded.ideck_xpaths
    `).run(row)
    const s1 = p.entryTouchPoints?.length ? `S1:[${p.entryTouchPoints.join(',')}]` : ''
    const s2 = p.entryTouchPoints2?.length ? ` S2:[${p.entryTouchPoints2.join(',')}]` : ''
    addHistory('machine-test', `機台設定檔：${p.machineType}`, `儲存 ${p.machineType} 設定（${p.bonusAction}${s1 ? ' 進入觸屏 ' + s1 + s2 : ''}）`, p)
    res.json({ ok: true, profile: p })
  } catch (err) { next(err) }
})

// DELETE /api/machine-test/profiles/:type
router.delete('/api/machine-test/profiles/:type', (req, res) => {
  db.prepare('DELETE FROM machine_test_profiles WHERE machineType = ?').run(req.params.type.toUpperCase())
  res.json({ ok: true })
})

// ─── Routes: CCTV Reference Images ────────────────────────────────────────────

// GET /api/machine-test/cctv-refs  — list machine types that have a reference image
router.get('/api/machine-test/cctv-refs', (_req, res) => {
  try {
    mkdirSync(CCTV_REFS_DIR, { recursive: true })
    const files = readdirSync(CCTV_REFS_DIR).filter(f => f.endsWith('.png'))
    const machineTypes = files.map(f => f.replace(/\.png$/i, ''))
    res.json({ ok: true, machineTypes })
  } catch (err) {
    res.json({ ok: true, machineTypes: [] })
  }
})

// POST /api/machine-test/cctv-refs/:machineType  — upload reference image
router.post('/api/machine-test/cctv-refs/:machineType', upload.single('image'), (req, res) => {
  const machineType = req.params.machineType.toUpperCase()
  if (!req.file) { res.status(400).json({ ok: false, error: '未收到圖片' }); return }
  try {
    mkdirSync(CCTV_REFS_DIR, { recursive: true })
    writeFileSync(join(CCTV_REFS_DIR, `${machineType}.png`), req.file.buffer)
    res.json({ ok: true, machineType })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/machine-test/cctv-refs/:machineType/image  — serve reference image
router.get('/api/machine-test/cctv-refs/:machineType/image', (req, res) => {
  const machineType = req.params.machineType.toUpperCase()
  const filePath = join(CCTV_REFS_DIR, `${machineType}.png`)
  if (!existsSync(filePath)) { res.status(404).end(); return }
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Cache-Control', 'no-cache')
  res.send(readFileSync(filePath))
})

// DELETE /api/machine-test/cctv-refs/:machineType  — delete reference image
router.delete('/api/machine-test/cctv-refs/:machineType', (req, res) => {
  const machineType = req.params.machineType.toUpperCase()
  const filePath = join(CCTV_REFS_DIR, `${machineType}.png`)
  if (existsSync(filePath)) unlinkSync(filePath)
  res.json({ ok: true })
})

// ─── Routes: CCTV & Audio Saves (per-machine test files) ──────────────────────

const CCTV_SAVES_DIR  = join(__dirname, '..', 'machine-test', 'cctv-saves')
const AUDIO_SAVES_DIR = join(__dirname, '..', 'machine-test', 'audio-saves')

// GET /api/machine-test/cctv-saves/:code?sessionId=xxx — serve CCTV screenshot
// Falls back to legacy {code}.png if sessionId-prefixed file not found
router.get('/api/machine-test/cctv-saves/:code', (req, res) => {
  const { code } = req.params
  const { sessionId } = req.query as Record<string, string>
  const candidates = sessionId
    ? [join(CCTV_SAVES_DIR, `${sessionId}-${code}.png`), join(CCTV_SAVES_DIR, `${code}.png`)]
    : [join(CCTV_SAVES_DIR, `${code}.png`)]
  const filePath = candidates.find(existsSync)
  if (!filePath) { res.status(404).end(); return }
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Cache-Control', 'no-cache')
  res.send(readFileSync(filePath))
})

// GET /api/machine-test/audio-saves/:code?sessionId=xxx — serve audio recording
// Falls back to legacy {code}.wav if sessionId-prefixed file not found
router.get('/api/machine-test/audio-saves/:code', (req, res) => {
  const { code } = req.params
  const { sessionId } = req.query as Record<string, string>
  const candidates = sessionId
    ? [join(AUDIO_SAVES_DIR, `${sessionId}-${code}.wav`), join(AUDIO_SAVES_DIR, `${code}.wav`)]
    : [join(AUDIO_SAVES_DIR, `${code}.wav`)]
  const filePath = candidates.find(existsSync)
  if (!filePath) { res.status(404).end(); return }
  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Content-Disposition', `inline; filename="${code}.wav"`)
  res.send(readFileSync(filePath))
})

// ─── Routes: OSM Status ────────────────────────────────────────────────────────

// POST /api/machine-test/osm-status — OSMWatcher webhook
router.post('/api/machine-test/osm-status', (req, res) => {
  try {
    const body = req.body as {
      timestamp?: number
      channel?: string
      gmlist?: { id: string; status: number; credit?: number; bet?: number; win?: number; fg?: number }[]
    }
    if (Array.isArray(body.gmlist)) {
      for (const gm of body.gmlist) {
        if (typeof gm.id === 'string' && typeof gm.status === 'number') {
          osmMachineStatus.set(gm.id, gm.status)
        }
      }
    }
    res.json({ error: 0, errordes: 'success' })
  } catch {
    res.json({ error: 0, errordes: 'success' }) // always ack to not break OSMWatcher
  }
})

// GET /api/machine-test/osm-status — query current statuses (for UI display)
router.get('/api/machine-test/osm-status', (_req, res) => {
  const entries: Record<string, { status: number; label: string }> = {}
  for (const [id, status] of osmMachineStatus.entries()) {
    entries[id] = { status, label: OSM_STATUS_LABELS[status] ?? `未知(${status})` }
  }
  res.json({ ok: true, machines: entries, count: osmMachineStatus.size })
})

// GET /api/machine-test/queue-status — current work-stealing queue state
router.get('/api/machine-test/queue-status', (_req, res) => {
  const sessionId = [...activeRunners.keys()][0] ?? null
  if (!sessionId) return res.json({ ok: true, sessionId: null, statuses: [] })
  const statuses = getJobStatuses(sessionId)
  res.json({ ok: true, sessionId, statuses: statuses ?? [] })
})

// ─── Routes: Machine Test Session ─────────────────────────────────────────────

// POST /api/machine-test/start — start session, returns sessionId
router.post('/api/machine-test/start', async (req, res, next) => {
  try {
    // PIN guard
    const pin = process.env.ADMIN_PIN ?? ''
    const provided = String(req.headers['x-admin-pin'] ?? '')
    if (pin && provided !== pin) {
      return res.status(403).json({ ok: false, message: '管理員 PIN 錯誤' })
    }
    const session = machineTestSessionSchema.parse(req.body) as MachineTestSession
    const sessionAccount = session.account ?? 'guest'

    // Per-account lock: each account can only run one session at a time
    const accountAlreadyRunning = [...activeRunners.values()].some(r => r.account === sessionAccount)
    if (accountAlreadyRunning) {
      return res.status(429).json({ ok: false, message: '你目前已有測試正在執行中，請稍後再試' })
    }

    const sessionId = `mt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const rawProfiles = db.prepare('SELECT * FROM machine_test_profiles').all() as (MachineTestProfile & { touchPoints: string | null; clickTake: number; ideck_xpaths?: string })[]
    const profiles = rawProfiles.map(r => ({
      ...r,
      touchPoints:       r.touchPoints       ? JSON.parse(r.touchPoints as unknown as string)       : [],
      entryTouchPoints:  r.entryTouchPoints  ? JSON.parse(r.entryTouchPoints as unknown as string)  : [],
      entryTouchPoints2: r.entryTouchPoints2 ? JSON.parse(r.entryTouchPoints2 as unknown as string) : [],
      ideckXpaths:       r.ideck_xpaths ? JSON.parse(r.ideck_xpaths) : [],
      clickTake: !!r.clickTake,
    })) as MachineProfile[]
    const profileMap = new Map(profiles.map(p => [p.machineType, p]))
    const betRandomPath = join(AUTOSPIN_PROJECT_DIR, 'bet_random.json')
    const betRandomConfig: Record<string, string[]> = existsSync(betRandomPath)
      ? JSON.parse(readFileSync(betRandomPath, 'utf-8'))
      : {}

    // Prepare Gemini key to pass to agents
    const { readGeminiKeys } = await import('./gemini.js')
    const geminiKeys = readGeminiKeys()
    const geminiKey = geminiKeys[0]?.key ?? process.env.GEMINI_API_KEY ?? ''

    // Clear broadcast buffer so fresh viewers get only this session's events
    clearBroadcastBuffer()

    const availableAgents = getAvailableAgents()

    if (availableAgents.length > 0) {
      // ── Distributed: work-stealing queue — agents claim one machine at a time ─
      const codes = session.machineCodes

      // Create work queue (agents pull from it via claim_job / job_done WS messages)
      registerDistSession(sessionId, codes, () => {
        activeRunners.delete(sessionId)
      })

      // Emit initial queue state + session_start
      const initialStatuses = getJobStatuses(sessionId) ?? []
      broadcastToViewers({ type: 'queue_update', statuses: initialStatuses, message: '', ts: new Date().toISOString() })
      broadcastToViewers({ type: 'session_start', message: `開始測試 ${codes.length} 台機器（${availableAgents.length} 個 Agent 搶工）`, ts: new Date().toISOString() })

      // Session config (no machineCodes — agent claims them dynamically)
      const sessionBase: MachineTestSession = { ...session, machineCodes: [] }

      const agentStopFns: (() => void)[] = []
      for (const agent of availableAgents) {
        agent.busy = true
        agent.sessionId = sessionId

        agent.ws.send(JSON.stringify({
          type: 'session_join',
          sessionId,
          session: sessionBase,
          profiles,
          betRandomConfig,
          osmMachineStatus: [...osmMachineStatus.entries()],
          geminiKey,
          ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? '',
          ollamaModel: process.env.OLLAMA_MODEL ?? '',
        }))

        agentStopFns.push(() => {
          if (agent.ws.readyState === agent.ws.OPEN) {
            agent.ws.send(JSON.stringify({ type: 'stop' }))
          }
        })
      }

      activeRunners.set(sessionId, {
        account: sessionAccount,
        stop: () => {
          agentStopFns.forEach(fn => fn())
          cancelDistSession(sessionId)
          activeRunners.delete(sessionId)
        },
      })

      res.json({ ok: true, sessionId, mode: 'distributed', agents: availableAgents.length })
    } else {
      // ── Local: run on this server ─────────────────────────────────────────
      const runner = new MachineTestRunner(osmMachineStatus, profileMap, betRandomConfig)
      runner.on('event', broadcastToViewers)
      activeRunners.set(sessionId, runner)
      runner.run({ ...session, sessionId }).finally(() => activeRunners.delete(sessionId))
      res.json({ ok: true, sessionId, mode: 'local' })
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/machine-test/save-history — frontend calls this when session ends
router.post('/api/machine-test/save-history', (req, res) => {
  try {
    const { results, account, accountLabel, sessionId } = z.object({
      results: z.array(z.record(z.string(), z.unknown())),
      account: z.string().optional(),
      accountLabel: z.string().optional(),
      sessionId: z.string().optional(),
    }).parse(req.body)
    const pass = results.filter((r) => r.overall === 'pass').length
    const fail = results.filter((r) => r.overall === 'fail').length
    const warn = results.filter((r) => r.overall === 'warn').length
    addHistory('machine-test', `機台測試`, `共 ${results.length} 台：PASS ${pass} / WARN ${warn} / FAIL ${fail}`, { results, account, accountLabel })

    const sid = sessionId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()

    // Save per-account session blob
    if (account) {
      db.prepare('INSERT OR REPLACE INTO machine_test_sessions (id, account, label, started_at, results) VALUES (?, ?, ?, ?, ?)')
        .run(sid, account, accountLabel ?? account, now, JSON.stringify(results))
    }

    // Save per-machine rows (always, regardless of account)
    const insertResult = db.prepare(
      'INSERT OR REPLACE INTO machine_test_results (id, session_id, machine_code, tested_at, account, overall, steps, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const insertMany = db.transaction((rows: typeof results) => {
      for (const r of rows) {
        const steps = r.steps ?? []
        const durationMs = Array.isArray(steps)
          ? (steps as { durationMs?: number }[]).reduce((s, st) => s + (st.durationMs ?? 0), 0)
          : 0
        insertResult.run(
          `${sid}-${r.machineCode}`,
          sid,
          String(r.machineCode ?? ''),
          now,
          account ?? '',
          String(r.overall ?? 'unknown'),
          JSON.stringify(steps),
          durationMs,
        )
      }
    })
    insertMany(results)

    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ ok: false, message: String(err) })
  }
})

// GET /api/machine-test/machine-results?machineCode=XXX&limit=20
// GET /api/machine-test/machine-results?account=XXX&limit=50
router.get('/api/machine-test/machine-results', (req, res) => {
  const { machineCode, account, limit = '30' } = req.query as Record<string, string>
  const lim = Math.min(parseInt(limit) || 30, 200)
  if (machineCode) {
    const rows = db.prepare(
      'SELECT * FROM machine_test_results WHERE machine_code = ? ORDER BY tested_at DESC LIMIT ?'
    ).all(machineCode, lim) as { id: string; session_id: string; machine_code: string; tested_at: number; account: string; overall: string; steps: string; duration_ms: number }[]
    res.json({ ok: true, results: rows.map(r => ({ ...r, steps: JSON.parse(r.steps) })) })
  } else if (account) {
    const rows = db.prepare(
      'SELECT * FROM machine_test_results WHERE account = ? ORDER BY tested_at DESC LIMIT ?'
    ).all(account, lim) as { id: string; session_id: string; machine_code: string; tested_at: number; account: string; overall: string; steps: string; duration_ms: number }[]
    res.json({ ok: true, results: rows.map(r => ({ ...r, steps: JSON.parse(r.steps) })) })
  } else {
    res.status(400).json({ ok: false, message: 'machineCode or account required' })
  }
})

// GET /api/machine-test/sessions — personal history for an account
router.get('/api/machine-test/sessions', (req, res) => {
  const account = req.query.account as string
  if (!account) { res.status(400).json({ ok: false, message: 'account required' }); return }
  const rows = db.prepare('SELECT id, account, label, started_at, results FROM machine_test_sessions WHERE account = ? ORDER BY started_at DESC LIMIT 50')
    .all(account) as { id: string; account: string; label: string; started_at: number; results: string }[]
  res.json({ ok: true, sessions: rows.map(r => ({ ...r, results: JSON.parse(r.results) })) })
})

// POST /api/machine-test/stop/:id
router.post('/api/machine-test/stop/:id', (req, res) => {
  const runner = activeRunners.get(req.params.id)
  if (runner) {
    runner.stop()
    activeRunners.delete(req.params.id)  // unblock immediately so new sessions can start
    // Notify all viewers that the session has ended (stop was pressed)
    broadcastToViewers({ type: 'session_done', message: '測試已手動停止', ts: new Date().toISOString() })
    res.json({ ok: true })
  } else {
    res.status(404).json({ ok: false, message: 'Session not found' })
  }
})

// WebSocket events are handled in server/index.ts via /ws/machine-test/events

// ─── Routes: Agent Package Download ───────────────────────────────────────────

/** GET /api/machine-test/agent/agent-package.json — minimal package.json for agent */
router.get('/api/machine-test/agent/agent-package.json', (_req, res) => {
  const pkg = {
    name: 'machine-test-agent',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'npx tsx server/agent-runner.ts' },
    dependencies: {
      playwright: '^1.58.2',
      ws: '^8.18.1',
      zod: '^4.3.6',
    },
    devDependencies: {
      '@types/node': '^24.12.0',
      '@types/ws': '^8.18.1',
      tsx: '^4.21.0',
      typescript: '~5.9.3',
    },
  }
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Disposition', 'attachment; filename="package.json"')
  res.send(JSON.stringify(pkg, null, 2))
})

/** GET /api/machine-test/agent/source/:file — serve whitelisted source files */
function serveAgentSource(relPath: string) {
  return (_req: import('express').Request, res: import('express').Response) => {
    const filePath = AGENT_SOURCE_WHITELIST[relPath]
    if (!filePath || !existsSync(filePath)) {
      return res.status(404).json({ ok: false, message: `找不到檔案: ${relPath}` })
    }
    let content = readFileSync(filePath, 'utf-8')
    // For runner.ts, rewrite gemini import to use standalone agent version
    if (relPath === 'machine-test/runner.ts') {
      content = content.replace(
        /import \{[^}]+\} from '\.\.\/routes\/gemini\.js'/,
        "import { callGeminiVision, callGeminiVisionMulti } from './gemini-agent.js'",
      )
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${relPath.split('/').pop()}"`)
    res.send(content)
  }
}

for (const relPath of Object.keys(AGENT_SOURCE_WHITELIST)) {
  router.get(`/api/machine-test/agent/source/${relPath}`, serveAgentSource(relPath))
}

/** GET /api/machine-test/agent/install.bat — installer with embedded server URL */
router.get('/api/machine-test/agent/install.bat', (req, res) => {
  // Derive the server base URL from the request
  const proto = req.headers['x-forwarded-proto'] ?? 'http'
  const host  = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3000'
  const serverUrl = `${proto}://${host}`

  const sourceFiles = Object.keys(AGENT_SOURCE_WHITELIST)
  const downloadLines = sourceFiles.map(f => {
    const dir = f.includes('/') ? `%AGENT_DIR%\\server\\${f.replace(/\//g, '\\').split('\\').slice(0, -1).join('\\')}` : '%AGENT_DIR%\\server'
    const filename = f.split('/').pop()!
    return [
      `mkdir "${dir}" 2>nul`,
      `powershell -Command "Invoke-WebRequest -Uri '${serverUrl}/api/machine-test/agent/source/${f}' -OutFile '${dir}\\${filename}'"`,
    ].join('\r\n')
  }).join('\r\n')

  const bat = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    'echo.',
    'echo ===================================================',
    'echo  Machine Test Agent - Installer',
    'echo ===================================================',
    'echo.',
    '',
    'REM Check Node.js',
    'where node >nul 2>&1',
    'if %errorlevel% neq 0 (',
    '  echo [ERROR] Node.js not found!',
    '  echo Please install Node.js 20 LTS from https://nodejs.org',
    '  pause',
    '  exit /b 1',
    ')',
    'echo [OK] Node.js found',
    '',
    'REM Create directories',
    'set AGENT_DIR=C:\\machine-test-agent',
    'mkdir "%AGENT_DIR%" 2>nul',
    'mkdir "%AGENT_DIR%\\server" 2>nul',
    'mkdir "%AGENT_DIR%\\server\\machine-test" 2>nul',
    'echo [OK] Created %AGENT_DIR%',
    '',
    'REM Download package.json',
    `powershell -Command "Invoke-WebRequest -Uri '${serverUrl}/api/machine-test/agent/agent-package.json' -OutFile '%AGENT_DIR%\\package.json'"`,
    'echo [OK] Downloaded package.json',
    '',
    'REM Download source files',
    downloadLines,
    'echo [OK] Source files downloaded',
    '',
    'REM npm install',
    'cd /d "%AGENT_DIR%"',
    'echo Running npm install (may take a few minutes)...',
    'call npm install',
    'if %errorlevel% neq 0 (',
    '  echo [ERROR] npm install failed',
    '  pause',
    '  exit /b 1',
    ')',
    'echo [OK] npm install done',
    '',
    'REM Install Playwright Chromium',
    'echo Installing Playwright Chromium (may take a few minutes)...',
    'call npx playwright install chromium',
    'if %errorlevel% neq 0 (',
    '  echo [WARN] playwright install failed - CCTV test may not work',
    ')',
    'echo [OK] Playwright installed',
    '',
    'REM Create start.bat',
    '(',
    '  echo @echo off',
    '  echo cd /d %%~dp0',
    `  echo set CENTRAL_URL=${serverUrl}`,
    '  echo echo Starting Machine Test Agent...',
    '  echo npx tsx server/agent-runner.ts',
    '  echo if %%errorlevel%% neq 0 pause',
    ') > "%AGENT_DIR%\\start.bat"',
    'echo [OK] Created start.bat',
    '',
    'echo.',
    'echo ===================================================',
    'echo  Installation complete!',
    'echo.',
    `echo  Server: ${serverUrl}`,
    'echo.',
    'echo  To start the agent, run:',
    'echo    C:\\machine-test-agent\\start.bat',
    'echo.',
    'echo  [Audio test] Install VB-Cable virtual audio device:',
    'echo    https://vb-audio.com/Cable/',
    'echo  After install, reboot and verify "CABLE Input" appears',
    'echo  in Sound settings as a playback device.',
    'echo ===================================================',
    'echo.',
    'pause',
  ].join('\r\n')

  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', 'attachment; filename="install.bat"')
  res.send(bat)
})

// GET /api/machine-test/status — current session and agent status
router.get('/api/machine-test/status', (_req, res) => {
  const agents = [...agentConnections.values()].map(a => ({
    agentId: a.agentId,
    hostname: a.hostname,
    busy: a.busy,
  }))
  const activeSessionId = activeRunners.size > 0 ? [...activeRunners.keys()][0] : null
  res.json({ ok: true, active: activeRunners.size > 0, sessionId: activeSessionId, agents })
})

/**
 * server/routes/gameshow.ts
 * Game Show 工具集後端路由
 * - POST /api/gs/pdf-testcase          — PDF/DOCX 上傳 → Gemini → TestCase 陣列
 * - GET  /api/gs/log-checker-script    — 回傳 intercept.js 注入腳本
 * - POST /api/gs/img-compare/session   — 啟動圖片比對 session（背景 Playwright 擷取）
 * - GET  /api/gs/img-compare/status/:id — 查詢擷取進度與配對結果
 * - GET  /api/gs/img-compare/img/:id/:side/:idx — 回傳擷取圖片 buffer
 * - POST /api/gs/stats/start           — 啟動 WS 統計 session
 * - POST /api/gs/stats/stop/:id        — 停止統計
 * - GET  /api/gs/stats/status/:id      — 查詢統計結果
 */
import { Router } from 'express'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import crypto from 'crypto'
import { upload, addHistory, browserLimiter } from '../shared.js'
import { callGeminiWithRotation } from './gemini.js'

export const router = Router()

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── 類型 ─────────────────────────────────────────────────────────────────────

interface TestCase {
  id: string
  type: string
  priority: string
  title: string
  steps: string
  expected: string
  source: string
  tag?: string
}

interface CapturedImage {
  idx: number
  filename: string
  url: string
  size: number
  contentType: string
  buffer: Buffer | null
  httpStatus: number
}

interface SideStatus {
  done: boolean
  count: number
  queued?: boolean
  queueSize?: number
  error?: string
}

interface ImgSession {
  a: { status: SideStatus; images: CapturedImage[] }
  b: { status: SideStatus; images: CapturedImage[] }
  pairs: PairedResult[]
  createdAt: number
}

interface PairedResult {
  a: { idx: number; url: string; filename: string; size: number; status: number } | null
  b: { idx: number; url: string; filename: string; size: number; status: number } | null
  similarity?: number
}

interface StatsSession {
  status: 'running' | 'stopped' | 'error'
  rounds: number
  distribution: Record<string, number>
  error?: string
  createdAt: number
  stop?: () => void
}

// ─── 記憶體 Store ─────────────────────────────────────────────────────────────

const imgSessions = new Map<string, ImgSession>()
const statsSessions = new Map<string, StatsSession>()

// 定時清理超過 2 小時的 session
setInterval(() => {
  const cutoff = Date.now() - 7_200_000
  for (const [id, s] of imgSessions.entries()) {
    if (s.createdAt < cutoff) imgSessions.delete(id)
  }
  for (const [id, s] of statsSessions.entries()) {
    if (s.createdAt < cutoff) statsSessions.delete(id)
  }
}, 600_000)

// ─── PDF TestCase ─────────────────────────────────────────────────────────────

const PDF_PROMPT = (text: string) => `
你是資深 QA 工程師，根據以下規格書內容生成完整測試案例。

輸出格式為 JSON 陣列，每個元素包含：
- id: 序號字串（如 "TC-001"）
- type: 測試類型（功能測試/整合測試/邊界測試/負面測試）
- priority: 優先級（P0/P1/P2）
- title: 測試標題（簡潔）
- steps: 操作步驟（多步驟用換行分隔）
- expected: 預期結果
- source: 依據的規格條目或章節
- tag: 選填標籤

只輸出 JSON 陣列，不要有任何解釋或 markdown 標記。

規格書內容：
${text.slice(0, 60000)}
`

router.post('/api/gs/pdf-testcase', upload.single('file'), async (req, res) => {
  try {
    const file = req.file
    if (!file) return res.json({ ok: false, message: '未收到檔案' })

    const diffMode = req.body.diffMode === '1'
    let text = ''

    if (file.originalname.toLowerCase().endsWith('.pdf') || file.mimetype === 'application/pdf') {
      const parser = new PDFParse({ data: file.buffer })
      const parsed = await parser.getText()
      text = parsed.text
    } else if (file.originalname.toLowerCase().endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer: file.buffer })
      text = result.value
    } else {
      return res.json({ ok: false, message: '不支援的檔案格式，請上傳 PDF 或 .docx' })
    }

    if (!text.trim()) return res.json({ ok: false, message: '無法從檔案中提取文字內容' })

    const raw = await callGeminiWithRotation(PDF_PROMPT(text))

    let cases: TestCase[] = []
    try {
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
      cases = JSON.parse(cleaned)
      if (!Array.isArray(cases)) throw new Error('非陣列')
    } catch {
      return res.json({ ok: false, message: 'AI 回傳格式異常，請重試' })
    }

    let diffSummary: { added: number; changed: number; removed: number } | undefined
    if (diffMode && req.body.lastCases) {
      try {
        const last: TestCase[] = JSON.parse(req.body.lastCases)
        const lastIds = new Set(last.map(c => c.title))
        const newIds  = new Set(cases.map(c => c.title))
        diffSummary = {
          added:   cases.filter(c => !lastIds.has(c.title)).length,
          removed: last.filter(c => !newIds.has(c.title)).length,
          changed: 0,
        }
      } catch { /* ignore */ }
    }

    addHistory(
      'gs-pdf-testcase',
      `GS PDF TestCase — ${file.originalname}`,
      `生成 ${cases.length} 筆測試案例${diffSummary ? `（新增 ${diffSummary.added}、移除 ${diffSummary.removed}）` : ''}`,
      { filename: file.originalname, count: cases.length, diffSummary },
    )
    res.json({ ok: true, cases, diffSummary })
  } catch (e) {
    res.json({ ok: false, message: String(e) })
  }
})

// ─── Log Checker Script ───────────────────────────────────────────────────────

router.get('/api/gs/log-checker-script', (_req, res) => {
  try {
    const scriptPath = join(__dirname, '../static/intercept.js')
    const script = readFileSync(scriptPath, 'utf-8')
    res.json({ ok: true, script })
  } catch {
    res.json({ ok: false, message: '腳本檔案載入失敗' })
  }
})

// ─── Img Compare ─────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .split('?')[0]
    .replace(/\.[a-z0-9]{5,}\.(webp|jpg|jpeg|png|gif|avif|svg)/i, '.$1')
    .toLowerCase()
    .trim()
}

function buildPairs(
  imagesA: CapturedImage[],
  imagesB: CapturedImage[],
): PairedResult[] {
  const usedA = new Set<number>()
  const usedB = new Set<number>()
  const pairs: PairedResult[] = []

  const bNameMap = new Map<string, number[]>()
  imagesB.forEach((img, i) => {
    const key = normalizeName(img.filename)
    if (!key) return
    if (!bNameMap.has(key)) bNameMap.set(key, [])
    bNameMap.get(key)!.push(i)
  })

  imagesA.forEach((imgA, i) => {
    const key = normalizeName(imgA.filename)
    if (!key) return
    const candidates = bNameMap.get(key)
    if (!candidates || candidates.length === 0) return
    const bIdx = candidates.shift()!
    if (candidates.length === 0) bNameMap.delete(key)
    pairs.push({ a: toMeta(imgA), b: toMeta(imagesB[bIdx]) })
    usedA.add(i); usedB.add(bIdx)
  })

  imagesA.forEach((imgA, i) => {
    if (!usedA.has(i)) pairs.push({ a: toMeta(imgA), b: null })
  })
  imagesB.forEach((imgB, i) => {
    if (!usedB.has(i)) pairs.push({ a: null, b: toMeta(imgB) })
  })

  return pairs
}

function toMeta(img: CapturedImage) {
  return { idx: img.idx, url: img.url, filename: img.filename, size: img.size, status: img.httpStatus }
}

const CAPTURE_PRESETS = {
  standard: { QUIET_MS: 3000, MAX_WAIT_MS: 30000, SCROLL_MAX_MS: 8000 },
  polling:  { QUIET_MS: 10000, MAX_WAIT_MS: 90000, SCROLL_MAX_MS: 12000 },
}

async function captureImages(
  url: string,
  sideRef: ImgSession['a'],
  mode: 'standard' | 'polling',
): Promise<void> {
  // 排隊等候 browser slot
  sideRef.status.queued = true
  sideRef.status.queueSize = browserLimiter.queued()
  await browserLimiter.schedule(async () => {
    sideRef.status.queued = false
    await _captureImages(url, sideRef, mode)
  })
}

async function _captureImages(
  url: string,
  sideRef: ImgSession['a'],
  mode: 'standard' | 'polling',
): Promise<void> {
  const preset = CAPTURE_PRESETS[mode] ?? CAPTURE_PRESETS.standard
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const okList: CapturedImage[] = []
    const seenKeys = new Set<string>()
    let lastNewAt = Date.now()

    page.on('response', async (response) => {
      if (response.request().resourceType() !== 'image') return
      const status = response.status()
      const imgUrl = response.url()
      let headers: Record<string, string>
      try { headers = response.headers() } catch { return }
      const ct = (headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (!ct.startsWith('image/')) return
      const rawName = imgUrl.split('/').pop()!.split('?')[0]
      const filename = decodeURIComponent(rawName) || 'unknown'
      lastNewAt = Date.now()
      let buffer: Buffer | null = null
      try { buffer = await response.body() } catch { return }
      if (!buffer || buffer.length === 0) return
      if (buffer.length > 8 * 1024 * 1024) return
      const key = `${filename}|${buffer.length}|${ct}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      const idx = okList.length
      okList.push({ idx, filename, url: imgUrl, size: buffer.length, contentType: ct, buffer, httpStatus: status })
      sideRef.status.count = okList.length
      sideRef.images = okList
    })

    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 40_000 }) } catch { /* ignore */ }

    try {
      await page.evaluate(async (maxMs: number) => {
        await new Promise<void>(resolve => {
          let scrolled = 0
          const timer = setInterval(() => {
            window.scrollBy(0, 400); scrolled += 400
            if (scrolled >= document.body.scrollHeight) { clearInterval(timer); resolve() }
          }, 120)
          setTimeout(() => { clearInterval(timer); resolve() }, maxMs)
        })
      }, preset.SCROLL_MAX_MS)
    } catch { /* ignore */ }

    const start = Date.now()
    while (true) {
      const idleFor = Date.now() - lastNewAt
      const waited = Date.now() - start
      if (idleFor >= preset.QUIET_MS) break
      if (waited >= preset.MAX_WAIT_MS) break
      await page.waitForTimeout(500)
    }

    await browser.close(); browser = null
    sideRef.status.done = true
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    sideRef.status.done = true
    sideRef.status.error = String(e)
  }
}

router.post('/api/gs/img-compare/session', async (req, res) => {
  const { urlA, urlB, mode } = req.body as { urlA?: string; urlB?: string; mode?: string }
  if (!urlA || !urlB) return res.json({ ok: false, message: '需要 urlA 與 urlB' })

  const sessionId = crypto.randomBytes(8).toString('hex')
  const captureMode = (mode === 'polling' ? 'polling' : 'standard') as 'standard' | 'polling'

  const session: ImgSession = {
    a: { status: { done: false, count: 0 }, images: [] },
    b: { status: { done: false, count: 0 }, images: [] },
    pairs: [],
    createdAt: Date.now(),
  }
  imgSessions.set(sessionId, session)

  // 同時背景執行 A & B 擷取，完成後建立配對
  Promise.all([
    captureImages(urlA, session.a, captureMode),
    captureImages(urlB, session.b, captureMode),
  ]).then(() => {
    session.pairs = buildPairs(session.a.images, session.b.images)
    const onlyA = session.pairs.filter(p => p.a && !p.b).length
    const onlyB = session.pairs.filter(p => !p.a && p.b).length
    addHistory(
      'gs-img-compare',
      'GS 圖片比對',
      `A：${session.a.images.length} 張，B：${session.b.images.length} 張，配對 ${session.pairs.filter(p => p.a && p.b).length} 對，僅A ${onlyA}，僅B ${onlyB}`,
      { urlA, urlB, countA: session.a.images.length, countB: session.b.images.length, pairs: session.pairs.length },
    )
  }).catch(() => {})

  res.json({ ok: true, sessionId })
})

router.get('/api/gs/img-compare/status/:id', (req, res) => {
  const session = imgSessions.get(req.params.id)
  if (!session) return res.json({ ok: false, message: 'Session 不存在' })
  res.json({
    ok: true,
    a: session.a.status,
    b: session.b.status,
    pairs: session.a.status.done && session.b.status.done ? session.pairs : [],
  })
})

router.get('/api/gs/img-compare/img/:id/:side/:idx', (req, res) => {
  const session = imgSessions.get(req.params.id)
  if (!session) return res.status(404).send('Session 不存在')
  const side = req.params.side as 'a' | 'b'
  if (side !== 'a' && side !== 'b') return res.status(400).send('side 需為 a 或 b')
  const idx = parseInt(req.params.idx, 10)
  const img = session[side].images[idx]
  if (!img || !img.buffer) return res.status(404).send('圖片不存在')
  res.set('Content-Type', img.contentType)
  res.set('Cache-Control', 'public, max-age=3600')
  res.send(img.buffer)
})

// ─── 500x Stats ───────────────────────────────────────────────────────────────

function parseWsFrame(data: string): string | null {
  try {
    const obj = JSON.parse(data)
    // 常見骰型欄位名稱
    const diceFields = ['dice', 'result', 'outcome', 'dices', 'slots', 'symbols']
    for (const f of diceFields) {
      const val = obj[f] ?? obj.data?.[f] ?? obj.result?.[f]
      if (val != null) {
        if (Array.isArray(val)) return val.map(String).join(',')
        return String(val)
      }
    }
    // 遞迴找第一層陣列
    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every(x => typeof x === 'number')) {
        return v.map(String).join(',')
      }
    }
    return null
  } catch {
    return null
  }
}

router.post('/api/gs/stats/start', async (req, res) => {
  const { url } = req.body as { url?: string }
  if (!url) return res.json({ ok: false, message: '需要 url' })

  const sessionId = crypto.randomBytes(8).toString('hex')
  const session: StatsSession = {
    status: 'running',
    rounds: 0,
    distribution: {},
    createdAt: Date.now(),
  }
  statsSessions.set(sessionId, session)

  // 背景執行 Playwright WS 攔截（受 browserLimiter 管控）
  ;(async () => {
    session.status = 'running'
    await browserLimiter.schedule(async () => {
    let browser
    try {
      browser = await chromium.launch({ headless: true })
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      })
      const page = await context.newPage()

      page.on('websocket', ws => {
        ws.on('framereceived', ({ payload }) => {
          if (session.status !== 'running') return
          const data = typeof payload === 'string' ? payload : payload.toString()
          const key = parseWsFrame(data)
          if (key) {
            session.distribution[key] = (session.distribution[key] ?? 0) + 1
            session.rounds++
          }
        })
      })

      session.stop = async () => {
        session.status = 'stopped'
        await browser?.close().catch(() => {})
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})

      // 最長跑 30 分鐘
      const maxEnd = Date.now() + 30 * 60 * 1000
      while (session.status === 'running' && Date.now() < maxEnd) {
        await page.waitForTimeout(2000)
      }

      await browser.close().catch(() => {})
      session.status = 'stopped'
    } catch (e) {
      if (browser) await browser.close().catch(() => {})
      session.status = 'error'
      session.error = String(e)
    }
    }) // end browserLimiter.schedule
  })()

  res.json({ ok: true, sessionId })
})

router.post('/api/gs/stats/stop/:id', async (req, res) => {
  const session = statsSessions.get(req.params.id)
  if (!session) return res.json({ ok: false, message: 'Session 不存在' })
  if (session.stop) {
    await session.stop().catch(() => {})
  } else {
    session.status = 'stopped'
  }
  addHistory(
    'gs-stats',
    'GS 500x 機率統計',
    `共 ${session.rounds} 回合，${Object.keys(session.distribution).length} 種骰型`,
    { rounds: session.rounds, distribution: session.distribution },
  )
  res.json({ ok: true })
})

router.get('/api/gs/stats/status/:id', (req, res) => {
  const session = statsSessions.get(req.params.id)
  if (!session) return res.status(404).json({ ok: false, message: 'Session 不存在' })
  res.json({
    ok: true,
    status: session.status,
    rounds: session.rounds,
    distribution: session.distribution,
    error: session.error,
  })
})

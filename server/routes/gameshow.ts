/**
 * server/routes/gameshow.ts
 * Game Show 工具集後端路由
 * - POST /api/gs/pdf-testcase          — PDF/DOCX 上傳 → Gemini → TestCase 陣列
 * - GET  /api/gs/log-checker-script    — 回傳 intercept.js 注入腳本（646行最新版）
 * - GET  /api/gs/log-compare           — 回傳 log-compare.html 頁面（LOG結構比對工具）
 * - POST /api/gs/img-compare/session   — 啟動圖片比對 session（背景 Playwright 擷取）
 * - GET  /api/gs/img-compare/status/:id — 查詢擷取進度與配對結果
 * - GET  /api/gs/img-compare/img/:id/:side/:idx — 回傳擷取圖片 buffer
 * - POST /api/gs/stats/start           — 啟動 WS 統計 session（支援 ColorGame V2 bonus-v2 解析）
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

// ColorGame V2 電子骰顏色代碼（bonus-v2 規格書）
const COLOR_MAP: Record<number, string> = {
  801: '黃', 802: '白', 803: '粉', 804: '藍', 805: '紅', 806: '綠'
}

interface BonusEntry {
  single_m2: { color: string; rate: number }[]
  single_m3: { color: string; rate: number }[]
  any_double: { color: string; rate: number } | null
  any_triple: { color: string; rate: number } | null
}

interface StatsSession {
  status: 'running' | 'stopped' | 'error'
  rounds: number
  distribution: Record<string, number>
  // bonus-v2 模式額外統計
  mode?: 'generic' | 'bonus-v2'
  bonusRounds?: number
  bonusDistribution?: {
    single_m2: Record<string, number>   // key: `${color}` → count
    single_m3: Record<string, number>
    any_double: Record<string, number>  // key: `${color}` → count
    any_triple: Record<string, number>
  }
  error?: string
  createdAt: number
  stop?: () => void
}

interface ClientCaptureSession {
  label: string
  rounds: number
  bonusDistribution: { single_m2: Record<string, number>; single_m3: Record<string, number>; any_double: Record<string, number>; any_triple: Record<string, number> }
  createdAt: number
  lastSeen: number
  status: 'running' | 'stopped'
  sseClients: Set<import('express').Response>
}

/** 解析 d.v[10][143] 電子骰資料（bonus-v2 規格） */
function parseBonusData(data143: Record<string, any>): BonusEntry {
  const result: BonusEntry = { single_m2: [], single_m3: [], any_double: null, any_triple: null }
  for (const [key, val] of Object.entries(data143)) {
    const k = Number(key)
    if (k >= 801 && k <= 806) {
      const color = COLOR_MAP[k] ?? `色${k}`
      if (val?.matchColors === 2) result.single_m2.push({ color, rate: val.rate ?? 0 })
      else if (val?.matchColors === 3) result.single_m3.push({ color, rate: val.rate ?? 0 })
    } else if (k === 807) {
      result.any_double = { color: COLOR_MAP[val?.bonusColor] ?? String(val?.bonusColor ?? ''), rate: val?.rate ?? 0 }
    } else if (k === 808) {
      result.any_triple = { color: COLOR_MAP[val?.bonusColor] ?? String(val?.bonusColor ?? ''), rate: val?.rate ?? 0 }
    }
  }
  return result
}

// ─── 記憶體 Store ─────────────────────────────────────────────────────────────

const imgSessions = new Map<string, ImgSession>()
const statsSessions = new Map<string, StatsSession>()
const clientCaptureSessions = new Map<string, ClientCaptureSession>()

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

router.get('/api/gs/log-checker-script', (req, res) => {
  try {
    const scriptPath = join(__dirname, '../static/intercept.js')
    const script = readFileSync(scriptPath, 'utf-8')
    addHistory('gs-logchecker', 'GS Log 攔截腳本下載', '使用者取得注入腳本', { ip: req.ip })
    res.json({ ok: true, script })
  } catch {
    res.json({ ok: false, message: '腳本檔案載入失敗' })
  }
})

// ─── Log Compare Page ─────────────────────────────────────────────────────────

router.get('/api/gs/log-compare', (_req, res) => {
  try {
    const htmlPath = join(__dirname, '../static/log-compare.html')
    const html = readFileSync(htmlPath, 'utf-8')
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch {
    res.status(500).send('<p>log-compare.html 載入失敗</p>')
  }
})

router.get('/api/gs/log-compare-app.js', (_req, res) => {
  try {
    const jsPath = join(__dirname, '../static/log-compare-app.js')
    res.set('Content-Type', 'application/javascript; charset=utf-8')
    res.sendFile(jsPath)
  } catch {
    res.status(500).send('// log-compare-app.js 載入失敗')
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
  standard: { QUIET_MS: 3000, MAX_WAIT_MS: 30000, SCROLL_MAX_MS: 8000,  MIN_PHASE_MS: 0,     label: '標準' },
  polling:  { QUIET_MS: 10000, MAX_WAIT_MS: 90000, SCROLL_MAX_MS: 12000, MIN_PHASE_MS: 22000, label: '含列表輪詢' },
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
  const { url, mode } = req.body as { url?: string; mode?: string }
  if (!url) return res.json({ ok: false, message: '需要 url' })

  const statsMode = mode === 'bonus-v2' ? 'bonus-v2' : 'generic'
  const sessionId = crypto.randomBytes(8).toString('hex')
  const session: StatsSession = {
    status: 'running',
    rounds: 0,
    distribution: {},
    mode: statsMode,
    bonusRounds: statsMode === 'bonus-v2' ? 0 : undefined,
    bonusDistribution: statsMode === 'bonus-v2' ? { single_m2: {}, single_m3: {}, any_double: {}, any_triple: {} } : undefined,
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
      const processedRounds = new Set<string>()

      page.on('websocket', ws => {
        ws.on('framereceived', ({ payload }) => {
          if (session.status !== 'running') return
          let raw = typeof payload === 'string' ? payload : payload.toString()

          // bonus-v2 模式：解析 ColorGame V2 WebSocket 協定
          if (statsMode === 'bonus-v2') {
            // 去掉 $#|#$ 前綴
            if (raw.startsWith('$#|#$')) raw = raw.slice(5)
            if (!raw.startsWith('{') && !raw.startsWith('[')) return
            try {
              const data = JSON.parse(raw)
              if (data.e === 'notify' && data.d?.v?.[3] === 'prepareBonusResult') {
                const roundId = String(data.d?.v?.[10]?.[0] ?? '')
                if (roundId && processedRounds.has(roundId)) return
                if (roundId) processedRounds.add(roundId)
                const data143 = data.d?.v?.[10]?.[143]
                if (data143 && typeof data143 === 'object' && Object.keys(data143).length > 0) {
                  const parsed = parseBonusData(data143)
                  session.bonusRounds = (session.bonusRounds ?? 0) + 1
                  session.rounds = session.bonusRounds
                  const bd = session.bonusDistribution!
                  for (const { color } of parsed.single_m2) bd.single_m2[color] = (bd.single_m2[color] ?? 0) + 1
                  for (const { color } of parsed.single_m3) bd.single_m3[color] = (bd.single_m3[color] ?? 0) + 1
                  if (parsed.any_double) bd.any_double[parsed.any_double.color] = (bd.any_double[parsed.any_double.color] ?? 0) + 1
                  if (parsed.any_triple) bd.any_triple[parsed.any_triple.color] = (bd.any_triple[parsed.any_triple.color] ?? 0) + 1
                  // 也記錄到 distribution 供通用表格顯示（格式：類型-顏色）
                  for (const { color } of parsed.single_m2) { const k = `2同-${color}`; session.distribution[k] = (session.distribution[k] ?? 0) + 1 }
                  for (const { color } of parsed.single_m3) { const k = `3同-${color}`; session.distribution[k] = (session.distribution[k] ?? 0) + 1 }
                  if (parsed.any_double) { const k = `任意2同`; session.distribution[k] = (session.distribution[k] ?? 0) + 1 }
                  if (parsed.any_triple) { const k = `任意3同`; session.distribution[k] = (session.distribution[k] ?? 0) + 1 }
                }
              }
            } catch { /* 略過無法解析的 frame */ }
            return
          }

          // generic 模式：通用 WS 骰型解析
          const key = parseWsFrame(raw)
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

  res.json({ ok: true, sessionId, mode: statsMode })
})

router.post('/api/gs/stats/stop/:id', async (req, res) => {
  const session = statsSessions.get(req.params.id)
  if (!session) return res.json({ ok: false, message: 'Session 不存在' })
  if (session.stop) {
    await session.stop().catch(() => {})
  } else {
    session.status = 'stopped'
  }
  const modeLabel = session.mode === 'bonus-v2' ? 'ColorGame V2 電子骰' : '通用 WS'
  addHistory(
    'gs-bonusv2',
    `GS Bonus V2 統計（${modeLabel}）`,
    `共 ${session.rounds} 回合，${Object.keys(session.distribution).length} 種骰型`,
    { rounds: session.rounds, distribution: session.distribution, mode: session.mode, bonusDistribution: session.bonusDistribution },
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
    mode: session.mode ?? 'generic',
    bonusRounds: session.bonusRounds,
    bonusDistribution: session.bonusDistribution,
    error: session.error,
  })
})

// ─── Bonus V2 — 電子骰機率驗證工具 ───────────────────────────────────────────
// Serves the standalone bonus-v2 HTML tool with its own Playwright WS interceptor.
// API paths are remapped via a monkey-patch shim in the HTML so app.js is unchanged.

const COLOR_MAP_BV2: Record<number, string> = {
  801: '黃', 802: '白', 803: '粉', 804: '藍', 805: '紅', 806: '綠',
}

function parseBonusDataBV2(data143: Record<string, { matchColors?: number; rate?: number; bonusColor?: number }>) {
  const result: {
    single_m2: { color: string; rate: number }[]
    single_m3: { color: string; rate: number }[]
    any_double: { color: string; rate: number } | null
    any_triple: { color: string; rate: number } | null
  } = { single_m2: [], single_m3: [], any_double: null, any_triple: null }

  for (const [key, val] of Object.entries(data143)) {
    const k = Number(key)
    if (k >= 801 && k <= 806) {
      const color = COLOR_MAP_BV2[k] ?? `色${k}`
      if (val.matchColors === 2) result.single_m2.push({ color, rate: val.rate ?? 0 })
      else if (val.matchColors === 3) result.single_m3.push({ color, rate: val.rate ?? 0 })
    } else if (k === 807) {
      result.any_double = { color: COLOR_MAP_BV2[val.bonusColor ?? 0] ?? String(val.bonusColor), rate: val.rate ?? 0 }
    } else if (k === 808) {
      result.any_triple = { color: COLOR_MAP_BV2[val.bonusColor ?? 0] ?? String(val.bonusColor), rate: val.rate ?? 0 }
    }
  }
  return result
}

type Bv2NotifyPayload = { e?: string; d?: { v?: unknown[] } }

function bv2PayloadToText(payload: string | Buffer): string {
  return (typeof payload === 'string' ? payload : payload.toString('utf8')).trim()
}

function bv2StripKnownPrefix(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('$#|#$')) text = text.slice(5).trim()
  return text
}

function bv2ParseJsonCandidate(raw: string): unknown | null {
  const text = bv2StripKnownPrefix(raw)
  const candidates = [text]
  const firstObject = text.indexOf('{')
  const firstArray = text.indexOf('[')
  const firstJson = [firstObject, firstArray].filter(i => i >= 0).sort((a, b) => a - b)[0]
  if (firstJson > 0) candidates.push(text.slice(firstJson))

  for (const candidate of candidates) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
    try { return JSON.parse(candidate) } catch { /* try next candidate */ }
  }
  return null
}

function bv2FindPrepareBonusPayload(value: unknown): Bv2NotifyPayload | null {
  if (!value || typeof value !== 'object') return null
  if (!Array.isArray(value)) {
    const obj = value as Bv2NotifyPayload
    if (obj.e === 'notify' && obj.d?.v?.[3] === 'prepareBonusResult') return obj
  }

  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  for (const child of children) {
    const found = bv2FindPrepareBonusPayload(child)
    if (found) return found
  }
  return null
}

function bv2ShortFrame(raw: string): string {
  return raw.replace(/\s+/g, ' ').slice(0, 220)
}

const bv2SseClients = new Set<import('express').Response>()
let bv2Browser: import('playwright').Browser | null = null
let bv2Collecting = false
let bv2RoundCount = 0
let bv2TargetRounds = 0

function bv2SendSSE(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of bv2SseClients) {
    try { c.write(msg) } catch { bv2SseClients.delete(c) }
  }
}

async function bv2DoStop(reason?: string) {
  if (!bv2Collecting && !bv2Browser) return
  bv2Collecting = false
  bv2SendSSE('status', {
    collecting: false,
    current: bv2RoundCount,
    target: bv2TargetRounds,
    message: reason ?? `已停止，共收集 ${bv2RoundCount} 局`,
  })
  if (bv2Browser) {
    try { await bv2Browser.close() } catch {}
    bv2Browser = null
  }
}

router.get('/api/gs/bonus-v2', (_req, res) => {
  try {
    const html = readFileSync(join(__dirname, '../static/bonus-v2.html'), 'utf-8')
    res.set('Content-Type', 'text/html; charset=utf-8').send(html)
  } catch { res.status(500).send('<p>bonus-v2.html 載入失敗</p>') }
})

router.get('/api/gs/bonus-v2-app.js', (_req, res) => {
  try {
    const jsPath = join(__dirname, '../static/bonus-v2-app.js')
    res.set('Content-Type', 'application/javascript; charset=utf-8')
    res.sendFile(jsPath)
  } catch { res.status(500).send('// bonus-v2-app.js 載入失敗') }
})

router.get('/api/gs/bonus-v2/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  res.flushHeaders()
  res.write(': heartbeat\n\n')
  bv2SseClients.add(res)
  bv2SendSSE('debug', { msg: 'Bonus V2 Debug 已連線，等待開始收集' })
  bv2SendSSE('status', {
    collecting: bv2Collecting,
    current: bv2RoundCount,
    target: bv2TargetRounds,
    message: bv2Collecting ? '後端仍在收集中' : '目前未收集',
  })
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n') } catch { clearInterval(hb) } }, 15000)
  req.on('close', () => { clearInterval(hb); bv2SseClients.delete(res) })
})

router.post('/api/gs/bonus-v2/start', async (req, res) => {
  if (bv2Collecting) return res.json({ ok: false, error: '已在收集中，請先停止' })
  const { url, rounds } = req.body as { url: string; rounds: number }
  if (!url || !/^https?:\/\//i.test(url)) return res.json({ ok: false, error: '請輸入有效的網址（http / https）' })

  bv2TargetRounds = Math.max(1, parseInt(String(rounds)) || 100)
  bv2SendSSE('debug', { msg: `收到開始收集請求：目標 ${bv2TargetRounds} 局，URL：${url}` })
  bv2RoundCount = 0
  bv2Collecting = true
  const processedRounds = new Set<string>()
  res.json({ ok: true })

  try {
    bv2Browser = await chromium.launch({ headless: false })
    const context = await bv2Browser.newContext()
    const page = await context.newPage()
    let wsCount = 0

    page.on('websocket', ws => {
      wsCount++
      let frameCount = 0
      let ignoredDebugCount = 0
      bv2SendSSE('debug', { msg: `偵測到 WebSocket 連線 #${wsCount}：${ws.url()}` })

      ws.on('framereceived', frame => {
        if (!bv2Collecting) return
        frameCount++
        const raw = bv2PayloadToText(frame.payload)
        const data = bv2ParseJsonCandidate(raw)
        const notify = bv2FindPrepareBonusPayload(data)
        if (!notify) {
          if (ignoredDebugCount < 5) {
            ignoredDebugCount++
            bv2SendSSE('debug', { msg: `WS #${wsCount} 收到 frame #${frameCount}，但尚未命中 prepareBonusResult：${bv2ShortFrame(raw)}` })
          }
          return
        }

        const v = notify.d?.v as unknown[] | undefined
        const roundId = String((v?.[10] as unknown[])?.[0] ?? '')
        if (roundId && processedRounds.has(roundId)) return
        if (roundId) processedRounds.add(roundId)
        const data143 = (v?.[10] as Record<string, unknown> | undefined)?.[143] as Record<string, { matchColors?: number; rate?: number; bonusColor?: number }> | undefined
        if (data143 && typeof data143 === 'object' && Object.keys(data143).length > 0) {
          bv2RoundCount++
          const parsed = parseBonusDataBV2(data143)
          bv2SendSSE('debug', { msg: `命中 prepareBonusResult，第 ${bv2RoundCount} 局` })
          bv2SendSSE('round', { round: bv2RoundCount, time: new Date().toLocaleTimeString('zh-TW', { hour12: false }), ...parsed })
          bv2SendSSE('status', { collecting: true, current: bv2RoundCount, target: bv2TargetRounds })
          if (bv2RoundCount >= bv2TargetRounds) bv2DoStop(`已完成收集 ${bv2RoundCount} 局`)
        } else if (ignoredDebugCount < 5) {
          ignoredDebugCount++
          bv2SendSSE('debug', { msg: `命中 prepareBonusResult，但找不到 v[10][143]：${bv2ShortFrame(raw)}` })
        }
      })
    })

    bv2SendSSE('status', { collecting: true, current: 0, target: bv2TargetRounds, message: '正在開啟遊戲頁面...' })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    bv2SendSSE('status', { collecting: true, current: 0, target: bv2TargetRounds, message: '頁面已開啟，等待電子骰資料...' })
  } catch (err) {
    bv2Collecting = false
    bv2SendSSE('error', { message: `啟動失敗：${err instanceof Error ? err.message : String(err)}` })
    if (bv2Browser) { try { await bv2Browser.close() } catch {}; bv2Browser = null }
  }
})

router.post('/api/gs/bonus-v2/stop', async (_req, res) => {
  await bv2DoStop()
  res.json({ ok: true })
})

function clientCaptureSendStats(session: ClientCaptureSession) {
  const payload = JSON.stringify({ type: 'stats', rounds: session.rounds, bonusDistribution: session.bonusDistribution })
  for (const c of session.sseClients) {
    try { c.write(`data: ${payload}\n\n`) } catch { session.sseClients.delete(c) }
  }
}

function clientCaptureMergeBucket(bucket: Record<string, number>, items: { color?: string }[] | undefined) {
  for (const item of items ?? []) {
    const color = String(item?.color ?? '')
    if (!color) continue
    bucket[color] = (bucket[color] ?? 0) + 1
  }
}

router.get('/api/gs/bonus-v2-client-script', (req, res) => {
  const session = String(req.query.session ?? '')
  if (!session) return res.status(400).send('// missing session')
  try {
    const js = readFileSync(join(__dirname, '../static/bonus-v2-client.js'), 'utf-8')
    res.set('Content-Type', 'application/javascript; charset=utf-8')
    res.send(`window.__bonusV2Session = ${JSON.stringify(session)};\n${js}`)
  } catch {
    res.status(500).send('// bonus-v2-client.js load failed')
  }
})

router.post('/api/gs/bonus-v2-client/session', (req, res) => {
  const { label } = req.body as { label?: string }
  const sessionId = crypto.randomBytes(8).toString('hex')
  const now = Date.now()
  clientCaptureSessions.set(sessionId, {
    label: label || `Client ${new Date(now).toLocaleString('zh-TW', { hour12: false })}`,
    rounds: 0,
    bonusDistribution: { single_m2: {}, single_m3: {}, any_double: {}, any_triple: {} },
    createdAt: now,
    lastSeen: now,
    status: 'running',
    sseClients: new Set(),
  })
  res.json({ ok: true, sessionId })
})

router.post('/api/gs/bonus-v2-client/report', (req, res) => {
  const { sessionId, round } = req.body as {
    sessionId?: string
    round?: {
      single_m2?: { color?: string }[]
      single_m3?: { color?: string }[]
      any_double?: { color?: string } | null
      any_triple?: { color?: string } | null
    }
  }
  const session = sessionId ? clientCaptureSessions.get(sessionId) : null
  if (!session) return res.status(404).json({ ok: false, message: 'Session not found' })
  if (session.status !== 'running') return res.status(409).json({ ok: false, message: 'Session stopped' })
  if (!round || typeof round !== 'object') return res.status(400).json({ ok: false, message: 'Invalid round' })

  const bd = session.bonusDistribution
  clientCaptureMergeBucket(bd.single_m2, round.single_m2)
  clientCaptureMergeBucket(bd.single_m3, round.single_m3)
  if (round.any_double?.color) bd.any_double[String(round.any_double.color)] = (bd.any_double[String(round.any_double.color)] ?? 0) + 1
  if (round.any_triple?.color) bd.any_triple[String(round.any_triple.color)] = (bd.any_triple[String(round.any_triple.color)] ?? 0) + 1
  session.rounds++
  session.lastSeen = Date.now()
  clientCaptureSendStats(session)
  res.json({ ok: true })
})

router.get('/api/gs/bonus-v2-client/events/:id', (req, res) => {
  const session = clientCaptureSessions.get(req.params.id)
  if (!session) return res.status(404).end()
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.flushHeaders()
  session.sseClients.add(res)
  res.write(`data: ${JSON.stringify({ type: 'stats', rounds: session.rounds, bonusDistribution: session.bonusDistribution })}\n\n`)
  const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n') } catch { clearInterval(keepAlive) } }, 15000)
  req.on('close', () => {
    clearInterval(keepAlive)
    session.sseClients.delete(res)
  })
})

router.post('/api/gs/bonus-v2-client/stop/:id', (req, res) => {
  const session = clientCaptureSessions.get(req.params.id)
  if (!session) return res.status(404).json({ ok: false, message: 'Session not found' })
  session.status = 'stopped'
  session.lastSeen = Date.now()
  const distributionSize = Object.keys(session.bonusDistribution.single_m2).length
    + Object.keys(session.bonusDistribution.single_m3).length
    + Object.keys(session.bonusDistribution.any_double).length
    + Object.keys(session.bonusDistribution.any_triple).length
  addHistory(
    'gs-bonusv2',
    'GS Bonus V2 client capture',
    `${session.rounds} rounds, ${distributionSize} distribution keys`,
    { rounds: session.rounds, distribution: session.bonusDistribution, mode: 'bonus-v2-client', label: session.label },
  )
  for (const c of session.sseClients) {
    try {
      c.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      c.end()
    } catch {}
  }
  session.sseClients.clear()
  res.json({ ok: true })
})

// ─── Img Compare V2 (app.js 相容 SSE 串流版) ───────────────────────────────────

router.get('/api/gs/img-compare', (_req, res) => {
  try {
    const htmlPath = join(__dirname, '../static/img-compare.html')
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.sendFile(htmlPath)
  } catch {
    res.status(500).send('<p>img-compare.html 載入失敗</p>')
  }
})

router.get('/api/gs/img-compare-app.js', (_req, res) => {
  try {
    const jsPath = join(__dirname, '../static/img-compare-app.js')
    res.set('Content-Type', 'application/javascript; charset=utf-8')
    res.sendFile(jsPath)
  } catch {
    res.status(500).send('// img-compare-app.js 載入失敗')
  }
})

// GET /api/gs/img-compare/session — 建立新 session，供 app.js 在擷取前呼叫
router.get('/api/gs/img-compare/session', (_req, res) => {
  const sessionId = crypto.randomBytes(8).toString('hex')
  imgSessions.set(sessionId, {
    a: { status: { done: false, count: 0 }, images: [] },
    b: { status: { done: false, count: 0 }, images: [] },
    pairs: [],
    createdAt: Date.now(),
  })
  res.json({ sessionId })
})

// POST /api/gs/img-compare/capture — SSE 串流擷取單一側圖片，供 app.js 呼叫
router.post('/api/gs/img-compare/capture', async (req, res) => {
  const { url, side, sessionId, captureMode } = req.body as {
    url?: string; side?: string; sessionId?: string; captureMode?: string
  }
  if (!url || !sessionId) return res.status(400).json({ error: 'missing url or sessionId' })

  const sideKey = ((side || 'A').toLowerCase() === 'b' ? 'b' : 'a') as 'a' | 'b'

  let session = imgSessions.get(sessionId)
  if (!session) {
    session = {
      a: { status: { done: false, count: 0 }, images: [] },
      b: { status: { done: false, count: 0 }, images: [] },
      pairs: [],
      createdAt: Date.now(),
    }
    imgSessions.set(sessionId, session)
  }
  const sideRef = session[sideKey]
  sideRef.status.done = false
  sideRef.status.count = 0
  sideRef.images = []

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  const preset = captureMode === 'polling' ? CAPTURE_PRESETS.polling : CAPTURE_PRESETS.standard
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

  interface ClientImage {
    filename: string; url: string; size: number; contentType: string;
    httpStatus: number; imgSrc: string | null; cacheOnly: boolean;
  }
  const okList: (CapturedImage & { imgSrc?: string; cacheOnly?: boolean })[] = []
  const failedList: { filename: string; url: string; httpStatus: number; contentType: string; bodyPreview?: string }[] = []
  const seenKeys = new Set<string>()

  try {
    send({ type: 'status', message: '啟動瀏覽器…' })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    let lastNewAt = Date.now()

    page.on('response', async (response) => {
      if (response.request().resourceType() !== 'image') return
      const status = response.status()
      const imgUrl = response.url()
      let headers: Record<string, string>
      try { headers = response.headers() } catch { return }
      const ct = (headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      const rawName = imgUrl.split('/').pop()!.split('?')[0]
      const filename = decodeURIComponent(rawName) || 'unknown'
      lastNewAt = Date.now()

      if (status === 304) {
        const key = `304|${filename}`
        if (seenKeys.has(key)) return
        seenKeys.add(key)
        const idx = okList.length
        const imgObj = Object.assign(
          { idx, filename, url: imgUrl, size: 0, contentType: ct || 'image/', buffer: null, httpStatus: 304 },
          { imgSrc: null, cacheOnly: true },
        )
        okList.push(imgObj)
        sideRef.images = okList as CapturedImage[]
        sideRef.status.count = okList.length
        send({ type: 'progress', count: okList.length, httpStatus: 304, filename, note: '快取命中' })
        return
      }

      if (status >= 400 || !ct.startsWith('image/')) {
        failedList.push({ filename, url: imgUrl, httpStatus: status, contentType: ct })
        send({ type: 'progressFail', countFail: failedList.length, filename, httpStatus: status })
        return
      }

      let buffer: Buffer | null = null
      try { buffer = await response.body() } catch { return }
      if (!buffer || buffer.length === 0) return
      if (buffer.length > 8 * 1024 * 1024) return
      const key = `${filename}|${buffer.length}|${ct}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      const idx = okList.length
      const imgSrcPath = `/api/gs/img-compare/img/${sessionId}/${sideKey}/${idx}`
      const imgObj = Object.assign(
        { idx, filename, url: imgUrl, size: buffer.length, contentType: ct, buffer, httpStatus: status },
        { imgSrc: imgSrcPath, cacheOnly: false },
      )
      okList.push(imgObj)
      sideRef.images = okList as CapturedImage[]
      sideRef.status.count = okList.length
      send({ type: 'progress', count: okList.length, httpStatus: status, filename })
    })

    send({ type: 'status', message: '載入頁面…' })
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

    const phaseStart = Date.now()
    let lastTickSec = -1
    while (true) {
      const now = Date.now()
      const idleFor = now - lastNewAt
      const waited = now - phaseStart
      const phaseElapsed = now - phaseStart
      const minPhaseMet = phaseElapsed >= preset.MIN_PHASE_MS
      const idleQuietMet = idleFor >= preset.QUIET_MS
      const idleSec = Math.floor(idleFor / 1000)
      if (idleSec !== lastTickSec) {
        const minHint = minPhaseMet ? '' : ` · 最少擷取 ${Math.floor(phaseElapsed / 1000)}s / ${Math.floor(preset.MIN_PHASE_MS / 1000)}s`
        send({ type: 'status', message: `等待收斂：成功 ${okList.length}、失敗 ${failedList.length}，靜止 ${idleSec}s / ${Math.floor(preset.QUIET_MS / 1000)}s${minHint}` })
        lastTickSec = idleSec
      }
      if (idleQuietMet && minPhaseMet) break
      if (waited >= preset.MAX_WAIT_MS) break
      await page.waitForTimeout(300)
    }

    await browser.close(); browser = null
    sideRef.status.done = true

    const okForClient: ClientImage[] = okList.map(img => ({
      filename: img.filename,
      url: img.url,
      size: img.size,
      contentType: img.contentType,
      httpStatus: img.httpStatus,
      imgSrc: (img as any).imgSrc ?? null,
      cacheOnly: (img as any).cacheOnly ?? false,
    }))

    send({ type: 'done', ok: okForClient, failed: failedList, totalOk: okList.length, totalFailed: failedList.length })
    res.end()
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    sideRef.status.done = true
    send({ type: 'error', message: String(e) })
    res.end()
  }
})

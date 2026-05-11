import express from 'express'
import multer from 'multer'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { tmpdir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import https from 'https'
import http from 'http'
import { db } from '../shared.js'

export const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } })

// On startup, mark any runs stuck in 'running' state as 'interrupted' (server was restarted mid-run)
try {
  db.prepare("UPDATE frontend_auto_runs SET result='interrupted', finished_at=? WHERE result='running'").run(Date.now())
} catch {}
const imageDir = join(process.cwd(), 'server', 'frontend-auto', 'images')
mkdirSync(imageDir, { recursive: true })

type Platform = 'h5' | 'pc'
type ScriptRow = { id: string; created_by: string }
type ImageRow = { image_path: string }

type LogClient = express.Response
const logBuffers = new Map<string, string[]>()
const logClients = new Map<string, Set<LogClient>>()

function now() {
  return Date.now()
}

function asPlatform(value: unknown): Platform | null {
  return value === 'h5' || value === 'pc' ? value : null
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function jsonSteps(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error('steps must be a JSON array')
    return JSON.stringify(parsed)
  }
  if (Array.isArray(value)) return JSON.stringify(value)
  return '[]'
}

function publicImagePath(filename: string) {
  return `/api/frontend-auto/images/${filename}`
}

function saveUpload(file: Express.Multer.File) {
  const ext = extname(file.originalname || '').toLowerCase() || '.png'
  const filename = `${Date.now()}-${randomUUID()}${ext}`
  writeFileSync(join(imageDir, filename), file.buffer)
  return { filename, imagePath: publicImagePath(filename) }
}

function deleteStoredImage(imagePath: string) {
  const filename = imagePath.split('/').pop()
  if (!filename) return
  const fullPath = join(imageDir, filename)
  if (existsSync(fullPath)) unlinkSync(fullPath)
}

function canMutateScript(req: express.Request, script: ScriptRow | undefined, actor: string) {
  if (!script) return false
  const adminPin = process.env.ADMIN_PIN
  const headerPin = req.header('x-admin-pin')
  return script.created_by === actor || (!!adminPin && headerPin === adminPin)
}

router.use('/api/frontend-auto/images', express.static(imageDir))

router.get('/api/frontend-auto/scripts', (req, res) => {
  const platform = asPlatform(req.query.platform)
  const rows = platform
    ? db.prepare('SELECT * FROM frontend_auto_scripts WHERE platform = ? ORDER BY updated_at DESC').all(platform)
    : db.prepare('SELECT * FROM frontend_auto_scripts ORDER BY updated_at DESC').all()
  res.json({ ok: true, scripts: rows })
})

router.post('/api/frontend-auto/scripts', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>
    const platform = asPlatform(body.platform)
    if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })
    const name = text(body.name)
    if (!name) return res.status(400).json({ ok: false, message: 'name is required' })
    const createdBy = text(body.createdBy, 'unknown')
    const ts = now()
    const id = randomUUID()
    db.prepare(`
      INSERT INTO frontend_auto_scripts (id, name, platform, steps, created_by, is_public, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, platform, jsonSteps(body.steps), createdBy, body.isPublic === false ? 0 : 1, ts, ts)
    const script = db.prepare('SELECT * FROM frontend_auto_scripts WHERE id = ?').get(id)
    res.json({ ok: true, script })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

router.put('/api/frontend-auto/scripts/:id', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>
    const existing = db.prepare('SELECT id, created_by FROM frontend_auto_scripts WHERE id = ?').get(req.params.id) as ScriptRow | undefined
    const actor = text(body.createdBy, 'unknown')
    if (!canMutateScript(req, existing, actor)) return res.status(existing ? 403 : 404).json({ ok: false, message: existing ? 'forbidden' : 'script not found' })
    const name = text(body.name)
    const platform = asPlatform(body.platform)
    if (!name || !platform) return res.status(400).json({ ok: false, message: 'name and platform are required' })
    db.prepare(`
      UPDATE frontend_auto_scripts SET name = ?, platform = ?, steps = ?, is_public = ?, updated_at = ? WHERE id = ?
    `).run(name, platform, jsonSteps(body.steps), body.isPublic === false ? 0 : 1, now(), req.params.id)
    const script = db.prepare('SELECT * FROM frontend_auto_scripts WHERE id = ?').get(req.params.id)
    res.json({ ok: true, script })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

router.delete('/api/frontend-auto/scripts/:id', (req, res) => {
  const actor = text((req.body as { createdBy?: string } | undefined)?.createdBy, text(req.query.createdBy, 'unknown'))
  const existing = db.prepare('SELECT id, created_by FROM frontend_auto_scripts WHERE id = ?').get(req.params.id) as ScriptRow | undefined
  if (!canMutateScript(req, existing, actor)) return res.status(existing ? 403 : 404).json({ ok: false, message: existing ? 'forbidden' : 'script not found' })
  const images = db.prepare('SELECT image_path FROM frontend_auto_baselines WHERE script_id = ?').all(req.params.id) as ImageRow[]
  images.forEach(row => deleteStoredImage(row.image_path))
  db.prepare('DELETE FROM frontend_auto_baselines WHERE script_id = ?').run(req.params.id)
  db.prepare('DELETE FROM frontend_auto_scripts WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.get('/api/frontend-auto/baselines', (req, res) => {
  const scriptId = text(req.query.scriptId)
  const rows = scriptId
    ? db.prepare('SELECT * FROM frontend_auto_baselines WHERE script_id = ? ORDER BY updated_at DESC').all(scriptId)
    : db.prepare('SELECT * FROM frontend_auto_baselines ORDER BY updated_at DESC').all()
  res.json({ ok: true, baselines: rows })
})

router.post('/api/frontend-auto/baselines', upload.single('image'), (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ ok: false, message: 'image file is required' })
  const body = req.body as Record<string, unknown>
  const platform = asPlatform(body.platform)
  if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })
  const saved = saveUpload(file)
  const id = randomUUID()
  db.prepare(`
    INSERT INTO frontend_auto_baselines
      (id, script_id, crop_id, name, platform, crop_x, crop_y, crop_w, crop_h, image_path, threshold, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    text(body.scriptId),
    text(body.cropId, id),
    text(body.name, file.originalname),
    platform,
    numberValue(body.cropX),
    numberValue(body.cropY),
    numberValue(body.cropW),
    numberValue(body.cropH),
    saved.imagePath,
    numberValue(body.threshold, 0.05),
    text(body.createdBy, 'unknown'),
    now(),
  )
  const baseline = db.prepare('SELECT * FROM frontend_auto_baselines WHERE id = ?').get(id)
  res.json({ ok: true, baseline })
})

router.delete('/api/frontend-auto/baselines/:id', (req, res) => {
  const row = db.prepare('SELECT image_path FROM frontend_auto_baselines WHERE id = ?').get(req.params.id) as ImageRow | undefined
  if (row) deleteStoredImage(row.image_path)
  db.prepare('DELETE FROM frontend_auto_baselines WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.get('/api/frontend-auto/templates', (_req, res) => {
  res.json({ ok: true, templates: db.prepare('SELECT * FROM frontend_auto_templates ORDER BY created_at DESC').all() })
})

router.post('/api/frontend-auto/templates', upload.single('image'), (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ ok: false, message: 'image file is required' })
  const body = req.body as Record<string, unknown>
  const saved = saveUpload(file)
  const id = randomUUID()
  db.prepare(`
    INSERT INTO frontend_auto_templates
      (id, name, filename, image_path, width, height, purpose, last_confidence, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    text(body.name, file.originalname),
    saved.filename,
    saved.imagePath,
    numberValue(body.width),
    numberValue(body.height),
    text(body.purpose),
    body.lastConfidence === undefined ? null : numberValue(body.lastConfidence),
    text(body.createdBy, 'unknown'),
    now(),
  )
  const template = db.prepare('SELECT * FROM frontend_auto_templates WHERE id = ?').get(id)
  res.json({ ok: true, template })
})

router.delete('/api/frontend-auto/templates/:id', (req, res) => {
  const row = db.prepare('SELECT image_path FROM frontend_auto_templates WHERE id = ?').get(req.params.id) as ImageRow | undefined
  if (row) deleteStoredImage(row.image_path)
  db.prepare('DELETE FROM frontend_auto_templates WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.get('/api/frontend-auto/ocr-regions', (_req, res) => {
  res.json({ ok: true, regions: db.prepare('SELECT * FROM frontend_auto_ocr_regions ORDER BY updated_at DESC').all() })
})

router.post('/api/frontend-auto/ocr-regions', (req, res) => {
  const body = req.body as Record<string, unknown>
  const id = text(body.id, randomUUID())
  db.prepare(`
    INSERT INTO frontend_auto_ocr_regions (id, name, label, crop_x, crop_y, crop_w, crop_h, accuracy, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      label = excluded.label,
      crop_x = excluded.crop_x,
      crop_y = excluded.crop_y,
      crop_w = excluded.crop_w,
      crop_h = excluded.crop_h,
      accuracy = excluded.accuracy,
      updated_at = excluded.updated_at
  `).run(
    id,
    text(body.name, 'Region'),
    text(body.label),
    numberValue(body.cropX),
    numberValue(body.cropY),
    numberValue(body.cropW),
    numberValue(body.cropH),
    body.accuracy === undefined ? null : numberValue(body.accuracy),
    now(),
  )
  const region = db.prepare('SELECT * FROM frontend_auto_ocr_regions WHERE id = ?').get(id)
  res.json({ ok: true, region })
})

router.delete('/api/frontend-auto/ocr-regions/:id', (req, res) => {
  db.prepare('DELETE FROM frontend_auto_ocr_regions WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.get('/api/frontend-auto/runs', (req, res) => {
  const platform = asPlatform(req.query.platform)
  const limit = Math.min(Math.max(Math.trunc(numberValue(req.query.limit, 20)), 1), 100)
  const rows = platform
    ? db.prepare('SELECT * FROM frontend_auto_runs WHERE platform = ? ORDER BY started_at DESC LIMIT ?').all(platform, limit)
    : db.prepare('SELECT * FROM frontend_auto_runs ORDER BY started_at DESC LIMIT ?').all(limit)
  res.json({ ok: true, runs: rows })
})

router.post('/api/frontend-auto/runs', (req, res) => {
  const body = req.body as Record<string, unknown>
  const platform = asPlatform(body.platform)
  if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })
  const id = text(body.id, randomUUID())
  db.prepare(`
    INSERT INTO frontend_auto_runs
      (id, script_id, script_name, platform, ran_by, total_steps, passed, failed, skipped, result, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    text(body.scriptId),
    text(body.scriptName, 'Untitled script'),
    platform,
    text(body.ranBy, 'unknown'),
    numberValue(body.totalSteps),
    numberValue(body.passed),
    numberValue(body.failed),
    numberValue(body.skipped),
    text(body.result, 'unknown'),
    numberValue(body.startedAt, now()),
    body.finishedAt === undefined ? null : numberValue(body.finishedAt),
  )
  logBuffers.set(id, [`Run ${id} created`])
  const run = db.prepare('SELECT * FROM frontend_auto_runs WHERE id = ?').get(id)
  res.json({ ok: true, run })
})

router.get('/api/frontend-auto/log-stream/:runId', (req, res) => {
  const runId = req.params.runId
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const send = (line: string) => res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`)
  for (const line of logBuffers.get(runId) ?? []) send(line)

  let clients = logClients.get(runId)
  if (!clients) {
    clients = new Set<LogClient>()
    logClients.set(runId, clients)
  }
  clients.add(res)

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  const timeout = setTimeout(() => res.end(), 60_000)
  req.on('close', () => {
    clearInterval(keepAlive)
    clearTimeout(timeout)
    clients?.delete(res)
  })
})

router.post('/api/frontend-auto/runs/:id/log', (req, res) => {
  const runId = req.params.id
  const line = text((req.body as { line?: string }).line)
  if (!line) return res.status(400).json({ ok: false, message: 'line is required' })
  const lines = logBuffers.get(runId) ?? []
  lines.push(line)
  if (lines.length > 500) lines.splice(0, lines.length - 500)
  logBuffers.set(runId, lines)
  for (const client of logClients.get(runId) ?? []) {
    client.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`)
  }
  res.json({ ok: true })
})

router.get('/api/frontend-auto/setup/install.bat', (_req, res) => {
  res.type('application/octet-stream')
  res.attachment('install.bat')
  res.send(`@echo off\r\nREM Frontend automation setup for Windows\r\necho Checking Node.js...\r\nnode -v\r\necho Installing Playwright...\r\nnpm install -g playwright\r\nnpx playwright install chromium\r\npause\r\n`)
})

router.get('/api/frontend-auto/setup/install.sh', (_req, res) => {
  res.type('application/x-sh')
  res.attachment('install.sh')
  res.send(`#!/usr/bin/env bash\n# Frontend automation setup for Linux/macOS\nset -e\necho "Checking Node.js..."\nnode -v\necho "Installing Playwright..."\nnpm install -g playwright\nnpx playwright install chromium\n`)
})

// ── Redirect resolver ────────────────────────────────────────────────────────
/** Follow a single HTTP redirect and return the Location URL, or the original URL if no redirect. */
function followRedirectOnce(url: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url)
      const lib = parsed.protocol === 'https:' ? https : http
      const req = lib.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' } },
        (res) => {
          res.destroy()
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // Resolve relative Location headers
            try { resolve(new URL(res.headers.location, url).toString()) } catch { resolve(res.headers.location) }
          } else {
            resolve(url)
          }
        }
      )
      req.on('error', () => resolve(url))
      req.setTimeout(5000, () => { req.destroy(); resolve(url) })
      req.end()
    } catch {
      resolve(url)
    }
  })
}

// ── Playwright Codegen Recorder ───────────────────────────────────────────────

interface RecSession {
  proc: ChildProcess
  outFile: string
  originalUrl: string
  done: boolean
  steps: object[]
}
const recSessions = new Map<string, RecSession>()

function killRecProc(proc: ChildProcess) {
  try {
    if (process.platform === 'win32' && proc.pid) {
      // shell:true on Windows means proc.pid is cmd.exe — use taskkill to kill entire tree
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', shell: false })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {}
}

function parseCodegenToSteps(code: string, originalUrl?: string): object[] {
  const steps: object[] = []
  let firstGotoDone = false
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim()
    const goto = line.match(/page\.goto\(['"]([^'"]+)['"]\)/)
    if (goto) {
      // Replace the first goto URL with the original redirect URL so tokens/params are preserved
      const url = (!firstGotoDone && originalUrl) ? originalUrl : goto[1]
      firstGotoDone = true
      steps.push({ name: '前往頁面', action: 'goto', value: url })
      continue
    }
    const canvasClick = line.match(/locator\('canvas'\)\.click\(\s*\{[^}]*position:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)/)
    if (canvasClick) { steps.push({ name: `點擊畫面座標 (${canvasClick[1]}, ${canvasClick[2]})`, action: 'click_xy', x: Number(canvasClick[1]), y: Number(canvasClick[2]) }); continue }
    const locClick = line.match(/locator\(['"]([^'"]+)['"]\)\.click\(\)/)
    if (locClick) { steps.push({ name: `點擊 ${locClick[1]}`, action: 'click', selector: locClick[1] }); continue }
    const roleClick = line.match(/getByRole\(['"]([^'"]+)['"]\)[^.]*\.click\(\)/)
    if (roleClick) { steps.push({ name: `點擊 [role=${roleClick[1]}]`, action: 'click', selector: `[role="${roleClick[1]}"]` }); continue }
    const textClick = line.match(/getByText\(['"]([^'"]+)['"]\)\.click\(\)/)
    if (textClick) { steps.push({ name: `點擊文字「${textClick[1]}」`, action: 'click', selector: `text=${textClick[1]}` }); continue }
    const fill = line.match(/locator\(['"]([^'"]+)['"]\)\.fill\(['"]([^'"]*)['"]\)/)
    if (fill) { steps.push({ name: `輸入「${fill[2]}」到 ${fill[1]}`, action: 'type', selector: fill[1], value: fill[2] }); continue }
    if (line.includes('.screenshot(')) { steps.push({ name: '截圖', action: 'screenshot' }); continue }
    const wait = line.match(/waitForTimeout\((\d+)\)/)
    if (wait) { steps.push({ name: `等待 ${wait[1]} ms`, action: 'wait', value: wait[1] }); continue }
  }
  return steps
}

router.post('/api/frontend-auto/record/start', async (req, res) => {
  const body = req.body as Record<string, unknown>
  const url = text(body.url)
  const platform = asPlatform(body.platform)
  const resolution = text(body.resolution, platform === 'h5' ? '390x844' : '1366x768')
  if (!url) return res.status(400).json({ ok: false, message: 'url 為必填' })

  // Redirect servers (e.g. osm-redirect) use a two-step cookie mechanism:
  // 1st visit sets the session cookie but redirects to /?token=... (no studioid/gameid)
  // 2nd visit (with cookie) redirects to /lobby?...&studioid=...&gameid=... (full params)
  // So we open codegen to a blank page and let the user paste the URL manually —
  // this guarantees the URL the user types IS the one codegen records (with full params).
  // We still follow redirect once server-side to get the best displayUrl hint for the user.
  const resolvedUrl = await followRedirectOnce(url)
  const displayUrl = resolvedUrl !== url ? resolvedUrl : url

  const sessionId = `rec-${Date.now()}-${randomUUID().slice(0, 8)}`
  const outFile = join(tmpdir(), `pw-rec-${sessionId}.js`)
  const [w, h] = resolution.split('x')
  // Open codegen with no URL (blank page) so user manually navigates — avoids the 2-step cookie issue
  const args = ['playwright', 'codegen', '--output', outFile, '--viewport-size', `${w},${h}`]
  const proc = spawn('npx', args, { stdio: 'ignore', shell: true })
  const sess: RecSession = { proc, outFile, originalUrl: url, done: false, steps: [] }
  recSessions.set(sessionId, sess)
  proc.on('close', () => {
    sess.done = true
    try {
      if (existsSync(outFile)) {
        sess.steps = parseCodegenToSteps(readFileSync(outFile, 'utf8'))
        unlinkSync(outFile)
      }
    } catch {}
  })
  res.json({ ok: true, sessionId, displayUrl })
})

router.get('/api/frontend-auto/record/status/:sessionId', (req, res) => {
  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.json({ found: false, done: true, steps: [] })
  res.json({ found: true, done: sess.done, steps: sess.done ? sess.steps : [] })
})

router.post('/api/frontend-auto/record/stop/:sessionId', (req, res) => {
  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
  killRecProc(sess.proc)
  setTimeout(() => {
    if (!sess.done) {
      sess.done = true
      try {
        if (existsSync(sess.outFile)) {
          sess.steps = parseCodegenToSteps(readFileSync(sess.outFile, 'utf8'), sess.originalUrl)
          unlinkSync(sess.outFile)
        }
      } catch {}
    }
    const steps = sess.steps
    recSessions.delete(req.params.sessionId)
    res.json({ ok: true, steps })
  }, 1200)
})

// ── Script Execution Engine ───────────────────────────────────────────────────

const activeRuns = new Set<string>() // runIds currently executing

type StepObj = { name?: string; action: string; value?: string; selector?: string; x?: number; y?: number }

async function pushLog(runId: string, line: string) {
  const lines = logBuffers.get(runId) ?? []
  lines.push(line)
  if (lines.length > 500) lines.splice(0, lines.length - 500)
  logBuffers.set(runId, lines)
  for (const client of logClients.get(runId) ?? []) {
    client.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`)
  }
}

router.post('/api/frontend-auto/runs/:id/execute', async (req, res) => {
  const runId = req.params.id
  const body = req.body as Record<string, unknown>
  const stepsRaw = text(body.steps, '[]')
  const startUrl = text(body.url)
  const resolution = text(body.resolution, '390x844')
  const failureMode = text(body.failureMode, 'continue')
  const headed = body.headed === true

  if (activeRuns.has(runId)) return res.status(409).json({ ok: false, message: 'already running' })
  activeRuns.add(runId)
  res.json({ ok: true })

  void (async () => {
    const log = (line: string) => pushLog(runId, line)
    let steps: StepObj[]
    try { steps = JSON.parse(stepsRaw) } catch { await log('❌ 步驟 JSON 解析失敗'); activeRuns.delete(runId); return }

    const [w, h] = resolution.split('x').map(Number)
    let chromium: import('playwright').BrowserType | null = null
    let browser: import('playwright').Browser | null = null
    try {
      const pw = await import('playwright')
      chromium = pw.chromium
      browser = await chromium.launch({ headless: !headed })
    } catch (err) {
      await log(`❌ 無法啟動瀏覽器：${err instanceof Error ? err.message : String(err)}`)
      activeRuns.delete(runId)
      return
    }

    const ctx = await browser.newContext({ viewport: { width: w || 390, height: h || 844 } })
    const page = await ctx.newPage()
    let passed = 0, failed = 0, skipped = 0

    for (const [i, step] of steps.entries()) {
      if (!activeRuns.has(runId)) { await log('🛑 執行已中止'); break }
      const label = step.name ?? `步驟 ${i + 1}`
      const idx = `[${i + 1}/${steps.length}]`
      try {
        if (step.action === 'goto') {
          const target = step.value || startUrl
          await log(`⏳ ${idx} ${label} → ${target}`)
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
          await log(`✅ ${idx} ${label}`)
          passed++
        } else if (step.action === 'click') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator(step.selector ?? '').click({ timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          passed++
        } else if (step.action === 'click_xy') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator('canvas').first().click({ position: { x: step.x ?? 0, y: step.y ?? 0 }, timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          passed++
        } else if (step.action === 'type') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator(step.selector ?? '').fill(step.value ?? '', { timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          passed++
        } else if (step.action === 'wait') {
          await log(`⏳ ${idx} ${label}`)
          await page.waitForTimeout(Number(step.value) || 1000)
          await log(`✅ ${idx} ${label}`)
          passed++
        } else if (step.action === 'screenshot') {
          await log(`⏳ ${idx} ${label}`)
          await page.screenshot()
          await log(`✅ ${idx} ${label}`)
          passed++
        } else if (step.action === 'assert_visible') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator(step.selector ?? '').waitFor({ state: 'visible', timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          passed++
        } else {
          await log(`⏭ ${idx} ${label}（不支援的動作：${step.action}）`)
          skipped++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
        await log(`❌ ${idx} ${label}：${msg}`)
        failed++
        // If browser was closed externally, abort immediately
        const browserClosed = msg.includes('closed') || msg.includes('Stopped by user') || msg.includes('Target crashed')
        if (failureMode === 'stop' || browserClosed) {
          if (browserClosed) await log('🛑 瀏覽器已關閉，中止執行')
          else await log('🛑 失敗後停止')
          break
        }
      }
    }

    await browser.close().catch(() => {})
    activeRuns.delete(runId)
    const result = failed > 0 ? 'fail' : 'pass'
    await log(`─── 完成 ─── 通過 ${passed} ／ 失敗 ${failed} ／ 跳過 ${skipped}`)
    try {
      db.prepare('UPDATE frontend_auto_runs SET passed=?,failed=?,skipped=?,result=?,finished_at=? WHERE id=?')
        .run(passed, failed, skipped, result, Date.now(), runId)
    } catch {}
  })()
})

router.post('/api/frontend-auto/runs/:id/stop', (req, res) => {
  const runId = req.params.id
  activeRuns.delete(runId)
  // Mark run as stopped in DB immediately so UI refreshes
  try {
    db.prepare("UPDATE frontend_auto_runs SET result='stopped', finished_at=? WHERE id=? AND result='running'")
      .run(Date.now(), runId)
  } catch {}
  res.json({ ok: true })
})

export default router

import express from 'express'
import multer from 'multer'
import { randomUUID } from 'crypto'
// 跟 agent-runner.ts 用同一份共用模組（見 net-capture.js 檔頭說明為什麼放 uat-runner/）
import { attachNetworkCapture, DEFAULT_THRESHOLDS } from '../uat-runner/net-capture.js'
import { attachPinusProbe } from '../uat-runner/pinus-probe.js'
import { attachCdpCapture } from '../uat-runner/cdp-capture.js'
import { createRecordedLocators } from '../uat-runner/recorded-selector.js'
import { waitForDebugPort, clearStaleDebugPort, DEBUG_PORT_ARG } from '../uat-runner/chrome-debug-port.js'
import { frontendRecorderScript, flagShadowCompleteness, syncRecorderPanel, setRecorderPanelVisible, FRONTEND_RECORDER_CONTROL_MARKER } from '../uat-runner/frontend-recorder.js'
import { evaluateApiAssertion } from '../uat-runner/api-assert.js'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { tmpdir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import https from 'https'
import http from 'http'
import WebSocket from 'ws'
import { PNG } from 'pngjs'
import { db } from '../shared.js'
import { agentConnections, uatAgentSessions, uatRunSessions, getAvailableAgents, UAT_CONSOLE_KEEP, type UatConsoleEntry } from '../agent-hub.js'
import { agentUpdateStatus } from './machine-test.js'

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
type BaselineRow = {
  id: string
  name: string
  image_path: string
  threshold: number
}
type CdpMessage = { id?: number; result?: any; error?: { message?: string } }
type CdpSend = (method: string, params?: object) => Promise<CdpMessage>
type CropRequest = {
  scriptId: string
  platform: Platform
  name: string
  threshold: number
  createdBy: string
}
type CropResult = {
  id: string
  name: string
  imagePath: string
  x: number
  y: number
  w: number
  h: number
  threshold: number
}

type LogClient = express.Response
export const logBuffers = new Map<string, string[]>()
export const logClients = new Map<string, Set<LogClient>>()

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

function imagePathToFile(imagePath: string) {
  const filename = imagePath.split('/').pop()
  return filename ? join(imageDir, filename) : ''
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
  // 中途才開面板的人要看得到目前的量測數字
  const snapshot = statsSnapshots.get(runId)
  if (snapshot) res.write(`event: stats\ndata: ${JSON.stringify(snapshot)}\n\n`)

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

function isLocalRecordRequest(req: express.Request) {
  if (process.env.FRONTEND_AUTO_ALLOW_REMOTE_RECORD === '1') return true
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase()
  const hostname = host.replace(/:\d+$/, '')
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

// ── Chrome DevTools Recorder ──────────────────────────────────────────────────

interface RecSession {
  proc: ChildProcess
  profileDir: string
  originalUrl: string
  /** 要錄的目標網址（已跟過一次轉址）。Chrome 先開 about:blank，注入完才導頁 */
  startUrl: string
  /** 只導頁一次——CDP 斷線重連時再導一次就是無限重載 */
  navigated?: boolean
  platform: Platform
  viewportWidth: number
  viewportHeight: number
  done: boolean
  steps: object[]
  ws?: WebSocket
  cdpSend?: CdpSend
  cropRequest?: CropRequest
  lastCrop?: CropResult
  /** console／network／pinus 攔截（本機模式；agent 模式那份在 agent-runner） */
  capture?: Awaited<ReturnType<typeof attachCdpCapture>>
  captureTimer?: ReturnType<typeof setInterval>
  stats?: unknown
  consoleLogs?: UatConsoleEntry[]
  consoleDropped?: number
  pinusPatched?: string | null
  /**
   * 暫停中。**權威狀態在這裡，不在頁面。** 錄製器每次導頁都重新注入、
   * 面板整個重建，狀態放頁面就會在導頁後安靜消失（回到「在錄」）。
   */
  paused?: boolean
  /** 控制面板的配色。跟著開始錄製時的畫面模式走 */
  theme?: 'normal' | 'xianxia'
}
const recSessions = new Map<string, RecSession>()

function killRecSession(sess: RecSession) {
  // ⚠️ 先收計時器。不收的話錄製結束後它每 3 秒還會對著關掉的 CDP 連線送訊息，
  //    而且 session 被移除後沒人再持有它——這個 interval 會永遠跑下去。
  if (sess.captureTimer) { clearInterval(sess.captureTimer); sess.captureTimer = undefined }
  try {
    sess.ws?.close()
  } catch {}
  killChromeProcess(sess.proc, sess.profileDir)
}

function killChromeProcess(proc: ChildProcess, profileDir: string) {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', shell: false })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {}
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {}
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[]
  return candidates.find(p => existsSync(p)) ?? (process.platform === 'win32' ? 'chrome.exe' : 'google-chrome')
}

async function waitForJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json() as T
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Chrome DevTools endpoint not ready: ${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`)
}

/**
 * 注入頁面的錄製器。**動作錄製走共用的 frontendRecorderScript()**（跟 agent 模式同一份，
 * 兩邊各寫一份已經漂過一次），這裡只再加上「框選截圖」那層——它是本機模式專屬的 UI。
 */
function recorderScript(sess?: RecSession) {
  return frontendRecorderScript({ theme: sess?.theme }) + `
(() => {
  if (window.__toppathCropInstalled) return;
  window.__toppathCropInstalled = true;
  window.__toppathStartCropMode = () => {
    if (document.getElementById('__toppath_crop_layer')) return;
    window.__toppathCropping = true;
    const layer = document.createElement('div');
    layer.id = '__toppath_crop_layer';
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      cursor: 'crosshair',
      background: 'rgba(15,23,42,0.18)',
      userSelect: 'none',
    });
    const hint = document.createElement('div');
    hint.textContent = '拖曳框選要擷取的區域，按 Esc 取消';
    Object.assign(hint.style, {
      position: 'fixed',
      left: '12px',
      top: '12px',
      padding: '6px 10px',
      borderRadius: '6px',
      background: 'rgba(15,23,42,0.92)',
      color: '#e2e8f0',
      fontSize: '12px',
      fontFamily: 'Arial, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,0.24)',
    });
    const rect = document.createElement('div');
    Object.assign(rect.style, {
      position: 'fixed',
      display: 'none',
      border: '2px solid #f59e0b',
      background: 'rgba(245,158,11,0.16)',
      boxShadow: '0 0 0 9999px rgba(15,23,42,0.22)',
      pointerEvents: 'none',
    });
    layer.appendChild(hint);
    layer.appendChild(rect);
    document.body.appendChild(layer);

    let startX = 0;
    let startY = 0;
    let drawing = false;
    const close = () => {
      window.__toppathCropping = false;
      layer.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    const draw = (event) => {
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const w = Math.abs(event.clientX - startX);
      const h = Math.abs(event.clientY - startY);
      Object.assign(rect.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    };
    document.addEventListener('keydown', onKey, true);
    layer.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      drawing = true;
      startX = event.clientX;
      startY = event.clientY;
      draw(event);
    }, true);
    layer.addEventListener('mousemove', event => {
      if (!drawing) return;
      event.preventDefault();
      event.stopPropagation();
      draw(event);
    }, true);
    layer.addEventListener('mouseup', event => {
      if (!drawing) return;
      event.preventDefault();
      event.stopPropagation();
      drawing = false;
      const box = draw(event);
      close();
      if (box.w >= 5 && box.h >= 5) console.info('__TOPPATH_CROP__', JSON.stringify(box));
    }, true);
  };
})();
`
}

async function syncRecorderViewport(sess: RecSession) {
  if (!sess.cdpSend) return
  await sess.cdpSend('Emulation.setDeviceMetricsOverride', {
    width: sess.viewportWidth,
    height: sess.viewportHeight,
    deviceScaleFactor: 1,
    mobile: sess.platform === 'h5',
  })
  const size = await sess.cdpSend('Runtime.evaluate', {
    expression: '({ dw: Math.max(0, window.outerWidth - window.innerWidth), dh: Math.max(0, window.outerHeight - window.innerHeight) })',
    returnByValue: true,
  })
  const delta = size.result?.result?.value as { dw?: number; dh?: number } | undefined
  const win = await sess.cdpSend('Browser.getWindowForTarget')
  const windowId = win.result?.windowId
  if (typeof windowId === 'number') {
    await sess.cdpSend('Browser.setWindowBounds', {
      windowId,
      bounds: {
        width: sess.viewportWidth + Math.round(delta?.dw ?? 0),
        height: sess.viewportHeight + Math.round(delta?.dh ?? 0),
      },
    })
  }
}

function recordableWindowSize(width: number, height: number) {
  return {
    width: width + (process.platform === 'win32' ? 16 : 0),
    height: height + (process.platform === 'win32' ? 96 : 90),
  }
}

/**
 * ⚠️ **傳進來的 url 應該是 about:blank。** 直接用目標網址啟動的話，Chrome 會一邊
 *    載入頁面、我們一邊才連 CDP 注入錄製器——「注入早於頁面程式碼」這個前提
 *    不成立，頁面在注入前建立的 **closed shadow root** 永遠追蹤不到，
 *    那些元素會被錯標成「已驗證」。（CodeX 2026-09-18 複驗指出。）
 *    導頁改在 connectRecorder 的 open handler 裡、掛完攔截之後做。
 *
 * ⚠️ port 讓 Chrome 自己挑，不要用亂數（見 `chrome-debug-port.js`）。
 *    亂數撞號時**不會失敗，會安靜地接到別人的瀏覽器**——兩個 session 都跑完、
 *    結果交叉污染。v4.165.0 改掉了 agent 端的三處，**漏了這一處**。
 */
async function launchRecorderChrome(sessionId: string, url: string, width: number, height: number) {
  const profileDir = join(tmpdir(), `toppath-rec-${sessionId}`)
  const initialWindow = recordableWindowSize(width, height)
  clearStaleDebugPort(profileDir)
  const args = [
    DEBUG_PORT_ARG,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    `--window-size=${initialWindow.width},${initialWindow.height}`,
    url,
  ]
  const proc = spawn(chromeExecutable(), args, { stdio: 'ignore', shell: false, windowsHide: false })
  const port = await waitForDebugPort(profileDir, { isAlive: () => proc.exitCode === null })
  return { proc, profileDir, port }
}

async function syncPlaywrightViewport(page: import('playwright').Page, width: number, height: number, platform: Platform) {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: platform === 'h5',
  })
  const size = await session.send('Runtime.evaluate', {
    expression: '({ dw: Math.max(0, window.outerWidth - window.innerWidth), dh: Math.max(0, window.outerHeight - window.innerHeight) })',
    returnByValue: true,
  })
  const delta = size.result?.value as { dw?: number; dh?: number } | undefined
  const win = await session.send('Browser.getWindowForTarget').catch(() => null)
  const windowId = win?.windowId
  if (typeof windowId === 'number') {
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        width: width + Math.round(delta?.dw ?? 0),
        height: height + Math.round(delta?.dh ?? 0),
      },
    }).catch(() => {})
  }
  await page.setViewportSize({ width, height }).catch(() => {})
}

async function saveCropFromRecorder(sess: RecSession, crop: { x: number; y: number; w: number; h: number }) {
  const request = sess.cropRequest
  if (!request || !sess.cdpSend) return
  const cropX = Math.max(0, Math.round(crop.x))
  const cropY = Math.max(0, Math.round(crop.y))
  const cropW = Math.max(1, Math.round(crop.w))
  const cropH = Math.max(1, Math.round(crop.h))
  // ⚠️ 截圖前把面板藏起來，`finally` 一定要放回來。框選範圍蓋到面板的話，面板會被
  //    拍進 baseline，而 baseline 是之後每次執行的比對基準——等於把一個只有錄製時
  //    才存在的東西寫進基準；失敗時沒放回來，使用者會看到一個沒有停止鈕的視窗。
  await setRecorderPanelVisible(sess.cdpSend, false)
  let shot
  try {
    shot = await sess.cdpSend('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: cropX, y: cropY, width: cropW, height: cropH, scale: 1 },
    })
  } finally {
    await setRecorderPanelVisible(sess.cdpSend, true)
  }
  const data = shot.result?.data
  if (typeof data !== 'string') return
  const filename = `${Date.now()}-${randomUUID()}.png`
  writeFileSync(join(imageDir, filename), Buffer.from(data, 'base64'))
  const imagePath = publicImagePath(filename)
  const id = randomUUID()
  const name = request.name || `框選截圖 ${cropX},${cropY}`
  db.prepare(`
    INSERT INTO frontend_auto_baselines
      (id, script_id, crop_id, name, platform, crop_x, crop_y, crop_w, crop_h, image_path, threshold, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    request.scriptId,
    id,
    name,
    request.platform,
    cropX,
    cropY,
    cropW,
    cropH,
    imagePath,
    request.threshold,
    request.createdBy,
    now(),
  )
  sess.lastCrop = { id, name, imagePath, x: cropX, y: cropY, w: cropW, h: cropH, threshold: request.threshold }
  sess.steps.push({
    name: `尋找 ${name}`,
    action: 'find_baseline_scroll',
    baselineId: id,
    threshold: request.threshold,
    scrollStep: 600,
    maxScrolls: 20,
  })
  sess.cropRequest = undefined
}

/**
 * 本機模式的量測回報。跟 agent 模式不同的是這裡是同一個 process，
 * 不用經過 WS——直接寫進 session 就好。
 *
 * console 一樣要裁到上限：/record/status 每 2 秒把整包回給前端。
 */
async function flushLocalCapture(sess: RecSession) {
  const capture = sess.capture
  if (!capture || sess.done) return
  try {
    await capture.drainPinus()
    sess.stats = capture.snapshot()
    sess.consoleLogs = capture.consoleLogs().slice(-UAT_CONSOLE_KEEP)
    sess.consoleDropped = capture.consoleDropped()
    sess.pinusPatched = capture.pinusPatched()
  } catch { /* 量測失敗不能影響錄製 */ }
}

/**
 * 把 host 的權威狀態推給頁面內的控制面板。
 *
 * ⚠️ **每次注入之後都要呼叫一次。** 頁面端的新文件一律從「尚未同步」開始，
 *    不推的話面板停在「同步中」而且**完全不收錄**——那是刻意的：預設成
 *    「在錄」的話，暫停之後導頁就會安靜地恢復錄製。
 */
function syncLocalPanel(sess: RecSession) {
  if (!sess.cdpSend) return
  void syncRecorderPanel(sess.cdpSend, { paused: !!sess.paused, steps: sess.steps.length })
}

/** 設暫停狀態，並立刻把結果推回面板當回執（面板要收到才顯示完成） */
function setLocalPaused(sess: RecSession, paused: boolean) {
  sess.paused = paused
  syncLocalPanel(sess)
}

/**
 * 結束本機模式的這一輪錄製。
 *
 * ⚠️ **不要在這裡就把 session 從 map 拿掉。** 前端是靠 /record/status 輪詢拿步驟的，
 *    立刻刪掉的話下一次輪詢會拿到 `found:false` → 畫面顯示「錄製完成，共 0 個步驟」，
 *    而且看起來完全像正常結束。留一段寬限期讓輪詢收得到，之後再清。
 */
async function finishLocalRecording(sess: RecSession, sessionId: string) {
  if (sess.done) return
  // 最後一次 flush 要在 kill 之前——kill 之後 CDP 連線就沒了，
  // 最後那幾秒（往往正是使用者關心的那段）會整段消失。
  await flushLocalCapture(sess)
  killRecSession(sess)
  sess.done = true
  setTimeout(() => recSessions.delete(sessionId), 5 * 60_000).unref?.()
}

/** 頁面內控制面板送上來的指令 */
function handleLocalPanelControl(sess: RecSession, sessionId: string, msg: { cmd?: string }) {
  if (msg?.cmd === 'stop') { void finishLocalRecording(sess, sessionId); return }
  if (msg?.cmd === 'pause' || msg?.cmd === 'resume') setLocalPaused(sess, msg.cmd === 'pause')
}

function connectRecorder(sess: RecSession, port: number, sessionId: string) {
  void (async () => {
    const targets = await waitForJson<Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>>(`http://127.0.0.1:${port}/json/list`)
    const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!target?.webSocketDebuggerUrl) throw new Error('No Chrome page target found')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    sess.ws = ws
    let id = 0
    const pending = new Map<number, (value: CdpMessage) => void>()
    const send = (method: string, params?: object) => new Promise(resolve => {
      const requestId = ++id
      pending.set(requestId, resolve as (value: CdpMessage) => void)
      ws.send(JSON.stringify({ id: requestId, method, params }))
    }) as Promise<CdpMessage>
    sess.cdpSend = send
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(String(raw)) as { id?: number; method?: string; params?: any }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)?.(msg)
          pending.delete(msg.id)
          return
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = msg.params?.args ?? []
          // ⚠️ **暫停要在收事件的入口擋，不能只靠頁面自己不送。** 頁面每次導頁都
          //    重新注入，新文件要等我們推狀態過去才知道自己是暫停的——那段空窗期
          //    的操作只有這裡擋得住。兩道都要有。
          if (args[0]?.value === '__TOPPATH_RECORDER__' && typeof args[1]?.value === 'string' && !sess.paused) {
            try {
              sess.steps.push(JSON.parse(args[1].value))
              // 面板上的步數以 host 的清單為準（清單開頭有一顆 goto）
              syncLocalPanel(sess)
            } catch {}
          }
          if (args[0]?.value === FRONTEND_RECORDER_CONTROL_MARKER && typeof args[1]?.value === 'string') {
            try { handleLocalPanelControl(sess, sessionId, JSON.parse(args[1].value)) } catch {}
          }
          if (args[0]?.value === '__TOPPATH_CROP__' && typeof args[1]?.value === 'string') {
            try { void saveCropFromRecorder(sess, JSON.parse(args[1].value)) } catch {}
          }
        }
        // ⚠️ DOMContentLoaded 就查一次——load 跟「可以點了」是不同階段。
        if (msg.method === 'Page.domContentEventFired') {
          void flagShadowCompleteness(send)
          // 面板要等 DOMContentLoaded 才掛得上去（注入時 document.body 還是 null），
          // 所以這裡也推一次，不然要等 load，慢圖的頁面會空等好幾秒。
          syncLocalPanel(sess)
        }
        if (msg.method === 'Page.loadEventFired') {
          // 宣告式 closed shadow root 只有 CDP 看得到，所以每次載入完成查一次。
          void flagShadowCompleteness(send)
          void send('Runtime.evaluate', { expression: recorderScript(sess) })
          // ⚠️ 重注入之後一定要再推一次狀態，否則導頁後面板停在「同步中」而且
          //    什麼都不收——暫停跨導頁就是靠這一行才成立的。
          syncLocalPanel(sess)
          void sess.capture?.reinject()
        }
        // ⚠️ 一定要在上面那些之後：錄製器自己的標記由這裡處理，
        //    capture 只負責使用者的 console 與 network／pinus。
        sess.capture?.handle(msg as Record<string, unknown>)
      } catch {}
    })
    ws.on('open', async () => {
      await send('Runtime.enable')
      await send('Page.enable')
      await syncRecorderViewport(sess)
      await send('Page.addScriptToEvaluateOnNewDocument', { source: recorderScript(sess) })
      await send('Runtime.evaluate', { expression: recorderScript(sess) })
      syncLocalPanel(sess)
      // console／network／pinus 攔截。跟 agent 模式共用 cdp-capture.js 的同一份規則。
      // ⚠️ 掛不起來不能讓錄製失敗——使用者要的是錄操作，量測是附加價值。
      try {
        sess.capture = await attachCdpCapture(send, {
          consoleMarkers: ['__TOPPATH_RECORDER__', '__TOPPATH_CROP__', FRONTEND_RECORDER_CONTROL_MARKER],
        })
        sess.captureTimer = setInterval(() => { void flushLocalCapture(sess) }, 3000)
      } catch { /* 錄製照常 */ }
      // 錄製器與攔截都掛好了才導頁。⚠️ 只導一次。
      if (!sess.navigated && sess.startUrl && sess.startUrl !== 'about:blank') {
        sess.navigated = true
        await send('Page.navigate', { url: sess.startUrl })
      }
    })
    ws.on('close', () => { sess.done = true })
  })().catch(() => { sess.done = true })
}

function getUatAgents() {
  return [...agentConnections.values()]
    .filter(a => a.capabilities.includes('uat-record'))
    // updateStatus：派工前讓人看得出這台是不是落後（顯示不擋）
    .map(a => ({ agentId: a.agentId, hostname: a.hostname, busy: a.busy, updateStatus: agentUpdateStatus(a) }))
}

/**
 * agent 斷線：瀏覽器跟著那台機器走了，這一輪 H5/PC 錄製不可能再收到任何事件。
 *
 * ⚠️ 兩件事都要做，少一件都會出問題：
 *  - **標成中斷、不是完成**。前端在 `done` 時就停止輪詢並顯示結果，只設 `done`
 *    的話畫面會寫「錄製完成」，斷在半路看起來像順利結束。
 *  - **不要刪掉 session**。已經錄到的積木還在裡面，使用者下一次輪詢要靠它取回。
 *    （`docs/decisions.md`：斷線不代表停止。）
 *
 * 不設 `done` 的話這筆會帶著 `done:false` 永遠留著——今天無害，但只要哪天有人
 * 拿它當「這台正在錄製」的鎖讀，一次斷線就會讓那台 agent 永遠錄不了，
 * 而且症狀是「Agent 都在忙碌中」，看起來像使用者自己的問題、不像 bug。
 */
export function handleUatRecordAgentDisconnect(agentId: string, hostname?: string) {
  for (const session of uatAgentSessions.values()) {
    if (session.agentId !== agentId || session.done) continue
    session.done = true
    session.cropPending = false
    session.error = `Local Agent${hostname ? ` ${hostname}` : ''} 連線中斷，錄製已結束（已錄到的步驟仍會帶回）`
  }
}

/**
 * agent 斷線：那台機器上跑的 H5/PC 腳本也結束了。
 *
 * 不收的話那筆 run 會**永遠停在「執行中」**——DB 的 `result` 留在 `running`、
 * `activeRuns` 留著那個 runId，而使用者看到的是一條再也不會前進的執行紀錄，
 * 沒有任何錯誤訊息。收尾的三個地方（done／error／stop）都有做這件事，
 * 只有斷線這條路沒有。
 */
export function handleUatRunAgentDisconnect(agentId: string, hostname?: string) {
  for (const [runId, session] of uatRunSessions) {
    if (session.agentId !== agentId || session.done) continue
    session.done = true
    uatRunSessions.delete(runId)
    activeRuns.delete(runId)
    void pushLog(runId, `❌ Local Agent${hostname ? ` ${hostname}` : ''} 連線中斷，執行已結束`)
    try {
      db.prepare("UPDATE frontend_auto_runs SET result='fail',finished_at=? WHERE id=? AND result='running'")
        .run(Date.now(), runId)
    } catch {}
  }
}

router.get('/api/frontend-auto/record/available', (req, res) => {
  res.json({ available: isLocalRecordRequest(req), agents: getUatAgents() })
})

router.get('/api/frontend-auto/record/agents', (_req, res) => {
  res.json({ ok: true, agents: getUatAgents() })
})

router.post('/api/frontend-auto/record/start', async (req, res) => {
  const body = req.body as Record<string, unknown>
  const url = text(body.url)
  const platform = asPlatform(body.platform)
  const resolution = text(body.resolution, platform === 'h5' ? '500x877' : '1366x768')
  const agentId = text(body.agentId)
  // 只決定頁面內控制面板的配色與用詞。腳本錄到什麼跟這個無關。
  const theme = text(body.theme) === 'xianxia' ? 'xianxia' as const : 'normal' as const

  if (!url) return res.status(400).json({ ok: false, message: 'url 為必填' })
  if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })

  // ── Agent-based recording ────────────────────────────────────────────────────
  // 指名優先；沒指名而且本機錄製不可用時，自動挑一台空閒的 uat-record agent。
  // 先前只有「指名」這一條路，但前端的執行節點預設是「自動選擇」（agentId 是
  // 空字串），所以從 LAN／公網開啟時永遠掉到下面的 403——就算 agent 已經連上、
  // 前端自己的檢查也認為「有 agent 就能錄」，畫面上看起來就是按了沒反應。
  let agent = agentId ? agentConnections.get(agentId) : undefined
  if (agentId && (!agent || !agent.capabilities.includes('uat-record'))) {
    return res.status(400).json({ ok: false, message: `Agent ${agentId} 不支援 UAT 錄製或已離線` })
  }
  if (!agent && !isLocalRecordRequest(req)) {
    agent = [...agentConnections.values()].find(a =>
      a.capabilities.includes('uat-record') && !a.busy && a.ws.readyState === a.ws.OPEN)
  }
  if (agent) {
    const sessionId = `rec-agent-${Date.now()}-${randomUUID().slice(0, 8)}`
    uatAgentSessions.set(sessionId, {
      agentId: agent.agentId,
      steps: [{ name: '前往頁面', action: 'goto', value: url }],
      cropPending: false,
      done: false,
      paused: false,
    })
    agent.ws.send(JSON.stringify({ type: 'uat_record_start', sessionId, url, resolution, platform, theme }))
    return res.json({ ok: true, sessionId, displayUrl: url, via: 'agent', agentHostname: agent.hostname })
  }

  // ── Local recording (requires localhost/LAN access) ──────────────────────────
  if (!isLocalRecordRequest(req)) {
    // 走到這裡代表「不是本機、而且一台可用的 uat-record agent 都挑不到」。
    // 有 agent 連著卻缺 capability 是最容易誤會的情況（舊版 start.command 會把
    // capability 清單寫死），訊息要講清楚是哪一種，不然使用者只會看到「不支援」。
    const connected = [...agentConnections.values()]
    const withCapability = connected.filter(a => a.capabilities.includes('uat-record'))
    const message = withCapability.length
      ? `已連線的 Agent 都在忙碌中（${withCapability.length} 台），請等目前的任務結束再錄製。`
      : connected.length
        ? `有 ${connected.length} 台 Agent 連線中，但都沒有 uat-record 能力（可能是舊版）。請到 Local Agent 頁面按「更新程式碼」並重新啟動 Agent。`
        : '公網環境不支援直接錄製。請先連接一台 Local Agent，或在伺服器本機 localhost 開啟 ToppathTools 錄製。'
    return res.status(403).json({ ok: false, code: 'REMOTE_RECORD_UNSUPPORTED', message })
  }

  // Resolve redirect URLs before opening Chrome so local recording starts on
  // the actual lobby page instead of about:blank.
  const resolvedUrl = await followRedirectOnce(url)
  const displayUrl = resolvedUrl !== url ? resolvedUrl : url

  const sessionId = `rec-${Date.now()}-${randomUUID().slice(0, 8)}`
  const [w, h] = resolution.split('x')
  const viewportWidth = Number(w) || 390
  const viewportHeight = Number(h) || 844
  // ⚠️ 先開 about:blank，注入完才導頁——理由見 launchRecorderChrome 的說明。
  const { proc, profileDir, port } = await launchRecorderChrome(sessionId, 'about:blank', viewportWidth, viewportHeight)
  const sess: RecSession = {
    proc,
    profileDir,
    originalUrl: url,
    startUrl: displayUrl,
    platform,
    viewportWidth,
    viewportHeight,
    done: false,
    paused: false,
    theme,
    steps: [{ name: '前往頁面', action: 'goto', value: url }],
  }
  recSessions.set(sessionId, sess)
  proc.on('close', () => { sess.done = true })
  connectRecorder(sess, port, sessionId)
  res.json({ ok: true, sessionId, displayUrl })
})

router.get('/api/frontend-auto/record/status/:sessionId', (req, res) => {
  const agentSess = uatAgentSessions.get(req.params.sessionId)
  if (agentSess) {
    return res.json({ found: true, done: agentSess.done, error: agentSess.error ?? null, steps: agentSess.steps, lastCrop: agentSess.lastCrop, cropPending: agentSess.cropPending, cdpWarning: (agentSess as unknown as Record<string, unknown>).cdpWarning ?? null,
      paused: !!agentSess.paused,
      stats: agentSess.stats ?? null, consoleLogs: agentSess.consoleLogs ?? [], consoleDropped: agentSess.consoleDropped ?? 0, pinusPatched: agentSess.pinusPatched ?? null })
  }
  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.json({ found: false, done: true, steps: [] })
  // ⚠️ 兩個分支要回同一組欄位。少一邊的話那個模式的面板會永遠空白，
  //    而且不會有錯誤——看起來就像「這頁沒有網路活動」。
  res.json({ found: true, done: sess.done, error: null, steps: sess.steps, lastCrop: sess.lastCrop, cropPending: !!sess.cropRequest,
    paused: !!sess.paused,
    stats: sess.stats ?? null, consoleLogs: sess.consoleLogs ?? [], consoleDropped: sess.consoleDropped ?? 0, pinusPatched: sess.pinusPatched ?? null })
})

router.post('/api/frontend-auto/record/crop/:sessionId', async (req, res) => {
  const agentSess = uatAgentSessions.get(req.params.sessionId)
  if (agentSess) {
    const body = req.body as Record<string, unknown>
    const platform = asPlatform(body.platform)
    if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })
    const scriptId = text(body.scriptId)
    if (!scriptId) return res.status(400).json({ ok: false, message: 'scriptId is required' })
    const agent = agentConnections.get(agentSess.agentId)
    if (!agent) return res.status(503).json({ ok: false, message: 'Agent 已離線' })
    agentSess.cropPending = true
    agent.ws.send(JSON.stringify({
      type: 'uat_record_crop',
      sessionId: req.params.sessionId,
      scriptId,
      platform,
      name: text(body.name, `框選截圖 ${Date.now()}`),
      threshold: numberValue(body.threshold, 0.08),
      createdBy: text(body.createdBy, 'unknown'),
    }))
    return res.json({ ok: true })
  }

  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
  if (!sess.cdpSend) return res.status(409).json({ ok: false, message: '錄製器尚未連線完成，請稍後再框選' })
  const body = req.body as Record<string, unknown>
  const platform = asPlatform(body.platform)
  if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })
  const scriptId = text(body.scriptId)
  if (!scriptId) return res.status(400).json({ ok: false, message: 'scriptId is required' })
  sess.cropRequest = {
    scriptId,
    platform,
    name: text(body.name, `框選截圖 ${Date.now()}`),
    threshold: numberValue(body.threshold, 0.08),
    createdBy: text(body.createdBy, 'unknown'),
  }
  const result = await sess.cdpSend('Runtime.evaluate', {
    expression: 'window.__toppathStartCropMode && window.__toppathStartCropMode()',
  })
  if (result.error) return res.status(500).json({ ok: false, message: result.error.message ?? '啟動框選失敗' })
  res.json({ ok: true })
})

router.post('/api/frontend-auto/record/screenshot/:sessionId', async (req, res) => {
  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
  if (!sess.cdpSend) return res.status(409).json({ ok: false, message: '錄製器尚未連線完成，請稍後再截圖' })
  const body = req.body as Record<string, unknown>
  const platform = asPlatform(body.platform)
  if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })
  const cropX = Math.max(0, numberValue(body.cropX))
  const cropY = Math.max(0, numberValue(body.cropY))
  const cropW = Math.max(1, numberValue(body.cropW, 120))
  const cropH = Math.max(1, numberValue(body.cropH, 80))
  await setRecorderPanelVisible(sess.cdpSend, false)
  let shot
  try {
    shot = await sess.cdpSend('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: cropX, y: cropY, width: cropW, height: cropH, scale: 1 },
    })
  } finally {
    await setRecorderPanelVisible(sess.cdpSend, true)
  }
  const data = shot.result?.data
  if (typeof data !== 'string') return res.status(500).json({ ok: false, message: shot.error?.message ?? '截圖失敗' })
  const filename = `${Date.now()}-${randomUUID()}.png`
  writeFileSync(join(imageDir, filename), Buffer.from(data, 'base64'))
  const imagePath = publicImagePath(filename)
  const id = randomUUID()
  db.prepare(`
    INSERT INTO frontend_auto_baselines
      (id, script_id, crop_id, name, platform, crop_x, crop_y, crop_w, crop_h, image_path, threshold, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    text(body.scriptId),
    text(body.cropId, id),
    text(body.name, `crop-${cropX}-${cropY}`),
    platform,
    cropX,
    cropY,
    cropW,
    cropH,
    imagePath,
    numberValue(body.threshold, 0.08),
    text(body.createdBy, 'unknown'),
    now(),
  )
  const baseline = db.prepare('SELECT * FROM frontend_auto_baselines WHERE id = ?').get(id)
  res.json({ ok: true, baseline })
})

/**
 * 主畫面切暫停。**跟浮動面板走同一個狀態**——兩邊各記一份的話，
 * 「面板上暫停、主畫面顯示錄製中」這種畫面會讓人以為其中一邊壞了。
 */
router.post('/api/frontend-auto/record/pause/:sessionId', (req, res) => {
  const paused = !!(req.body as Record<string, unknown>)?.paused
  const agentSess = uatAgentSessions.get(req.params.sessionId)
  if (agentSess) {
    const agent = agentConnections.get(agentSess.agentId)
    if (!agent) return res.status(409).json({ ok: false, message: 'Local Agent 已離線，無法切換暫停' })
    // ⚠️ 這裡**不要**先樂觀地把 agentSess.paused 設好。權威狀態在 agent 那一側
    //    （擋事件的也是它），這邊先改的話畫面會顯示已暫停、而 agent 其實沒收到。
    //    等 agent 回 `paused` 事件再更新。
    agent.ws.send(JSON.stringify({ type: 'uat_record_pause', sessionId: req.params.sessionId, paused }))
    return res.json({ ok: true, pending: true })
  }
  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
  setLocalPaused(sess, paused)
  return res.json({ ok: true, paused: !!sess.paused })
})

router.post('/api/frontend-auto/record/stop/:sessionId', async (req, res) => {
  // ⚠️ 量測資料一定要跟著 stop 的回應一起回去。
  //    session 在這支裡就被移除了，之後前端再打 /record/status 只會拿到
  //    `found: false`——不回的話，**錄製最後那一份統計就永遠看不到了**，
  //    而畫面上只會是一片空白，不像出錯。
  const agentSess = uatAgentSessions.get(req.params.sessionId)
  if (agentSess) {
    const agent = agentConnections.get(agentSess.agentId)
    if (agent) agent.ws.send(JSON.stringify({ type: 'uat_record_stop', sessionId: req.params.sessionId }))
    agentSess.done = true
    const steps = agentSess.steps
    const captured = {
      stats: agentSess.stats ?? null,
      consoleLogs: agentSess.consoleLogs ?? [],
      consoleDropped: agentSess.consoleDropped ?? 0,
      pinusPatched: agentSess.pinusPatched ?? null,
    }
    uatAgentSessions.delete(req.params.sessionId)
    return res.json({ ok: true, steps, ...captured })
  }

  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
  // 頁面上那顆停止已經收過尾（session 留著讓輪詢取回）。這時不能再 flush／kill
  // 一次——CDP 連線早就沒了，只會把回應拖到逾時。直接把手上的東西回去。
  if (sess.done) {
    const steps = sess.steps
    recSessions.delete(req.params.sessionId)
    return res.json({ ok: true, steps, stats: sess.stats ?? null, consoleLogs: sess.consoleLogs ?? [],
      consoleDropped: sess.consoleDropped ?? 0, pinusPatched: sess.pinusPatched ?? null })
  }
  // 最後一次 flush 要在 kill 之前——kill 之後 CDP 連線就沒了，
  // 最後那幾秒（往往正是使用者關心的那段）會整段消失。
  await flushLocalCapture(sess)
  const captured = {
    stats: sess.stats ?? null,
    consoleLogs: sess.consoleLogs ?? [],
    consoleDropped: sess.consoleDropped ?? 0,
    pinusPatched: sess.pinusPatched ?? null,
  }
  killRecSession(sess)
  setTimeout(() => {
    sess.done = true
    const steps = sess.steps
    recSessions.delete(req.params.sessionId)
    res.json({ ok: true, steps, ...captured })
  }, 1200)
})

// ── Script Execution Engine ───────────────────────────────────────────────────

export const activeRuns = new Set<string>() // runIds currently executing

type StepObj = {
  name?: string
  action: string
  value?: string
  selector?: string
  x?: number
  y?: number
  baselineId?: string
  threshold?: number
  scrollStep?: number
  maxScrolls?: number
  /** assert_api_called：要打到的 API 網址樣式（`*` 當萬用字元）。
   *  ⚠️ 前端的 AutoStep 加新欄位時，**這裡也要加**——這兩個型別各自宣告
   *  同一個東西，漏了的話 server 端讀得到值但 TS 說欄位不存在。 */
  urlPattern?: string
  expectStatus?: '2xx' | 'any' | 'exact'
  statusCode?: number
  minCount?: number
  failureMode?: 'inherit' | 'continue' | 'stop' | 'retry'
  retryCount?: number
}

function loadPng(buffer: Buffer) {
  return PNG.sync.read(buffer)
}

function findTemplateInPng(screen: PNG, template: PNG, threshold: number) {
  if (template.width > screen.width || template.height > screen.height) return null
  const stride = Math.max(1, Math.floor(Math.min(template.width, template.height) / 24))
  const step = Math.max(1, Math.floor(Math.min(template.width, template.height) / 12))
  let best = { x: 0, y: 0, diff: Number.POSITIVE_INFINITY }

  for (let y = 0; y <= screen.height - template.height; y += step) {
    for (let x = 0; x <= screen.width - template.width; x += step) {
      let diff = 0
      let samples = 0
      for (let ty = 0; ty < template.height; ty += stride) {
        for (let tx = 0; tx < template.width; tx += stride) {
          const si = ((y + ty) * screen.width + (x + tx)) * 4
          const ti = (ty * template.width + tx) * 4
          diff += Math.abs(screen.data[si] - template.data[ti])
          diff += Math.abs(screen.data[si + 1] - template.data[ti + 1])
          diff += Math.abs(screen.data[si + 2] - template.data[ti + 2])
          samples += 3
        }
      }
      const normalized = diff / (samples * 255)
      if (normalized < best.diff) best = { x, y, diff: normalized }
      if (normalized <= threshold) return { x, y, diff: normalized }
    }
  }
  return best.diff <= threshold ? best : null
}

/**
 * 每個 run 的最後一份量測快照。SSE 是「接上之後才收得到」，中途才開面板的人
 * 沒有這個會一片空白到下一次 2 秒廣播為止。
 */
export const statsSnapshots = new Map<string, unknown>()

/** 把量測快照推給面板；跟 log 走同一條 SSE，用不同 event 名稱區分 */
export function pushStats(runId: string, stats: unknown) {
  statsSnapshots.set(runId, stats)
  for (const client of logClients.get(runId) ?? []) {
    client.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`)
  }
}

export async function pushLog(runId: string, line: string) {
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
  const platform = asPlatform(body.platform) ?? 'h5'
  const resolution = text(body.resolution, platform === 'h5' ? '500x877' : '1366x768')
  const failureMode = text(body.failureMode, 'continue')
  const headed = body.headed === true
  const requestedAgentId = text(body.agentId)

  if (activeRuns.has(runId)) return res.status(409).json({ ok: false, message: 'already running' })

  // ── Route to agent if agentId provided or agent available ──────────────────
  const agentToUse = requestedAgentId
    ? agentConnections.get(requestedAgentId)
    : getAvailableAgents({ capability: 'uat-run' })[0]

  if (agentToUse && agentToUse.ws.readyState === agentToUse.ws.OPEN) {
    uatRunSessions.set(runId, { agentId: agentToUse.agentId, runId, done: false })
    activeRuns.add(runId)
    agentToUse.ws.send(JSON.stringify({
      type: 'uat_script_run',
      runId,
      steps: stepsRaw,
      url: startUrl,
      platform,
      resolution,
      failureMode,
      headed,
    }))
    return res.json({ ok: true, via: 'agent', agentId: agentToUse.agentId })
  }

  activeRuns.add(runId)
  res.json({ ok: true })

  void (async () => {
    const log = (line: string) => pushLog(runId, line)
    let browser: import('playwright').Browser | null = null
    let chromeProc: ChildProcess | null = null
    let netCapture: ReturnType<typeof attachNetworkCapture> | null = null
    // assert_api_called 只看「這一步之後」打的 API。每次 goto 之後往前推——
    // 問的是「開了這頁、做了這些操作之後有沒有打到它」，不是整輪跑下來有沒有出現過。
    // ⚠️ 不推的話，第一次 goto 之前的請求會永遠留在集合裡，斷言變成幾乎不可能失敗。
    let netMark = Date.now()
    let pinusProbe: Awaited<ReturnType<typeof attachPinusProbe>> | null = null
    let pinusDrainTimer: ReturnType<typeof setInterval> | null = null
    let statsTimer: ReturnType<typeof setInterval> | null = null
    let chromeProfileDir: string | null = null
    let passed = 0
    let failed = 0
    let skipped = 0
    let steps: StepObj[]
    try {
      try { steps = JSON.parse(stepsRaw) } catch { await log('❌ 步驟 JSON 解析失敗'); return }
      const rawStepCount = steps.length
      steps = steps.filter((step, index, list) => {
        const prev = list[index - 1]
        return !(prev?.action === 'click_viewport' && step.action === 'click')
      })
      const skippedDuplicateClicks = rawStepCount - steps.length
      if (skippedDuplicateClicks > 0) {
        await log(`ℹ 已略過 ${skippedDuplicateClicks} 個座標點擊後的重複 selector 點擊`)
      }

      const [rawW, rawH] = resolution.split('x').map(Number)
      const w = rawW || 390
      const h = rawH || 844
      await log(`🔧 準備啟動瀏覽器：${headed ? 'Headed' : 'Headless'}，viewport ${w}x${h}`)
      const pw = await import('playwright')
      if (headed) {
        const launched = await launchRecorderChrome(`run-${runId}`, 'about:blank', w, h)
        chromeProc = launched.proc
        chromeProfileDir = launched.profileDir
        await waitForJson(`http://127.0.0.1:${launched.port}/json/version`)
        browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${launched.port}`)
      } else {
        browser = await pw.chromium.launch({
          headless: true,
          args: ['--force-device-scale-factor=1'],
        })
      }
      await log('✅ 瀏覽器已啟動')

      await log('🔧 建立瀏覽器 context...')
      const ctx = headed
        ? browser.contexts()[0] ?? await browser.newContext()
        : await browser.newContext({
            viewport: { width: w, height: h },
            screen: { width: w, height: h },
            deviceScaleFactor: 1,
            isMobile: platform === 'h5',
            hasTouch: platform === 'h5',
          })
      const page = headed
        ? ctx.pages()[0] ?? await ctx.newPage()
        : await ctx.newPage()
      if (headed) await syncPlaywrightViewport(page, w, h, platform)
      else await page.setViewportSize({ width: w, height: h }).catch(() => {})

      // 每 2 秒推一份快照給面板；跟 log 走同一條 SSE、不同 event 名稱
      statsTimer = setInterval(() => {
        if (!netCapture) return
        try {
          pushStats(runId, { scope: 'frontend', net: netCapture.summary(), pinus: pinusProbe?.summary() })
        } catch { /* 快照失敗不能影響測試本身 */ }
      }, 2000)

      // ── 網路量測 + pinus 攔截（跟 agent 端同一份模組、同一套行為）──────
      netCapture = attachNetworkCapture(page, {
        thresholds: DEFAULT_THRESHOLDS,
        onSlow: (r) => { void log(`🐢 [網路] ${Math.round(r.durationMs!)}ms（門檻 ${r.thresholdMs}ms）${r.kind} ${r.url.slice(0, 120)}`) },
      })
      try {
        pinusProbe = await attachPinusProbe(page)
        pinusDrainTimer = setInterval(() => { void pinusProbe?.drain() }, 3000)
      } catch (err) {
        await log(`⚠️ pinus 攔截掛載失敗（不影響其他步驟）：${err instanceof Error ? err.message : String(err)}`)
      }

      // ⚠️ 選擇器解析要走跟 Backend、agent 模式同一支。錄製器會產出 `text=`／`label=`／
      //    `:text-is()` 這些不是原生 CSS 的寫法，直接 page.locator() 會拋未知引擎。
      //    requireUnique：命中多筆一律失敗，不要安靜取第一個。
      const { recordedLocator } = createRecordedLocators(page, { requireUnique: true, resolveTimeoutMs: 10000 })

      await log('✅ 執行頁面已準備完成')

      for (const [i, step] of steps.entries()) {
        if (!activeRuns.has(runId)) { await log('🛑 執行已中止'); break }
        const label = step.name ?? `步驟 ${i + 1}`
        const idx = `[${i + 1}/${steps.length}]`
        let stepAttempt = 0
        while (true) {
        try {
          if (step.action === 'goto') {
            const target = step.value || startUrl
            await log(`⏳ ${idx} ${label} → ${target}`)
            // ⚠️ **netMark 要設在導頁之前，不是之後。**
            // 「開這頁時打了哪些後端」正是最常要驗的東西——設在 goto 完成
            // 又等三秒之後的話，載入期間那批 API 全部落在界線之前，
            // assert_api_called 會永遠看到 0 支。Backend 的 block-engine 早就
            // 踩過這個坑（見 :711 的註解，也是實測才發現），這裡照它的位置放。
            netMark = Date.now()
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await page.waitForTimeout(3000)
            await log(`✅ ${idx} ${label}`)
            passed++
          } else if (step.action === 'click') {
            await log(`⏳ ${idx} ${label}`)
            await (await recordedLocator(step.selector ?? '')).click({ timeout: 10000 })
            await log(`✅ ${idx} ${label}`)
            passed++
          } else if (step.action === 'click_xy') {
            await log(`⏳ ${idx} ${label}`)
            await page.locator('canvas').first().click({ position: { x: step.x ?? 0, y: step.y ?? 0 }, timeout: 10000 })
            await log(`✅ ${idx} ${label}`)
            passed++
          } else if (step.action === 'click_viewport') {
            await log(`⏳ ${idx} ${label}`)
            await page.mouse.click(step.x ?? 0, step.y ?? 0)
            await page.waitForTimeout(500)
            await log(`✅ ${idx} ${label}`)
            passed++
          } else if (step.action === 'type' || step.action === 'fill') {
            // ⚠️ fill 是 agent 模式舊錄製器的動作名。這邊沒有它的話，那些腳本會落到
            //    「不支援的動作 → skipped」，**腳本照樣 PASS**。新錄的一律是 type。
            await log(`⏳ ${idx} ${label}`)
            await (await recordedLocator(step.selector ?? '')).fill(step.value ?? '', { timeout: 10000 })
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
          } else if (step.action === 'find_baseline_scroll') {
            await log(`⏳ ${idx} ${label}`)
            const baseline = step.baselineId
              ? db.prepare('SELECT id, name, image_path, threshold FROM frontend_auto_baselines WHERE id = ?').get(step.baselineId) as BaselineRow | undefined
              : undefined
            if (!baseline) throw new Error('baseline not found')
            const templateFile = imagePathToFile(baseline.image_path)
            if (!templateFile || !existsSync(templateFile)) throw new Error('baseline image file not found')
            const template = loadPng(readFileSync(templateFile))
            const threshold = typeof step.threshold === 'number' ? step.threshold : baseline.threshold || 0.08
            const scrollStep = Math.max(50, Number(step.scrollStep) || Math.floor((h || 844) * 0.7))
            const maxScrolls = Math.max(1, Number(step.maxScrolls) || 20)
            let found: { x: number; y: number; diff: number } | null = null
            for (let attempt = 0; attempt <= maxScrolls; attempt++) {
              const shot = await page.screenshot({ fullPage: false })
              found = findTemplateInPng(loadPng(shot), template, threshold)
              if (found) break
              const before = await page.evaluate(() => window.scrollY)
              const atBottom = await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)
              if (atBottom) break
              await page.mouse.wheel(0, scrollStep)
              await page.waitForTimeout(700)
              const after = await page.evaluate(() => window.scrollY)
              if (after === before) break
            }
            if (!found) throw new Error(`baseline "${baseline.name}" not found before page bottom`)
            await log(`✅ ${idx} ${label} → (${found.x}, ${found.y}), diff ${found.diff.toFixed(3)}`)
            passed++
          } else if (step.action === 'assert_api_called') {
            await log(`⏳ ${idx} ${label}`)
            // ⚠️ 拿不到網路紀錄一定要**失敗**，不能落到下面那個 skip 分支。
            //    斷言被安靜跳過而腳本照樣 PASS，比直接報錯糟得多。
            if (!netCapture) throw new Error('這個執行環境沒有網路紀錄可查（量測沒有掛上）')
            if (!step.urlPattern) throw new Error('沒有填 API 網址樣式')
            const verdict = evaluateApiAssertion(
              netCapture.records().filter(r => Number(r.ts) >= netMark),
              { urlPattern: step.urlPattern, expectStatus: step.expectStatus, statusCode: step.statusCode, minCount: step.minCount },
            )
            if (!verdict.ok) throw new Error(`${step.urlPattern} —— ${verdict.why}`)
            await log(`✅ ${idx} ${label}（${verdict.why}）`)
            passed++
          } else if (step.action === 'assert_visible') {
            await log(`⏳ ${idx} ${label}`)
            await (await recordedLocator(step.selector ?? '')).waitFor({ state: 'visible', timeout: 10000 })
            await log(`✅ ${idx} ${label}`)
            passed++
          } else {
            await log(`⏭ ${idx} ${label}（不支援的動作：${step.action}）`)
            skipped++
          }
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
          const retryLimit = Math.min(10, Math.max(0, Number(step.retryCount) || 1))
          if (step.failureMode === 'retry' && stepAttempt < retryLimit && !msg.includes('closed') && !msg.includes('Target crashed')) {
            stepAttempt++
            await log(`↻ ${idx} ${label}：第 ${stepAttempt}/${retryLimit} 次重試`)
            continue
          }
          await log(`❌ ${idx} ${label}：${msg}`)
          failed++
          // If browser was closed externally, abort immediately
          const browserClosed = msg.includes('closed') || msg.includes('Stopped by user') || msg.includes('Target crashed')
          const effectiveFailureMode = step.failureMode === 'stop' || step.failureMode === 'continue' ? step.failureMode : failureMode
          if (effectiveFailureMode === 'stop' || browserClosed) {
            if (browserClosed) await log('🛑 瀏覽器已關閉，中止執行')
            else await log('🛑 失敗後停止')
            activeRuns.delete(runId)
          }
          break
        }
        }
        if (!activeRuns.has(runId)) break
      }

      const result = failed > 0 ? 'fail' : 'pass'
      await log(`─── 完成 ─── 通過 ${passed} ／ 失敗 ${failed} ／ 跳過 ${skipped}`)

      if (statsTimer) { clearInterval(statsTimer); statsTimer = null }

      // 摘要要在關瀏覽器之前產出：pinus 最後一批訊息還在頁面端 buffer，
      // 等到 finally 時 page 已經沒了，那批會整批遺失
      if (netCapture) {
        try { await log('\n' + netCapture.formatSummary()) } catch { /* 摘要失敗不影響判定 */ }
      }
      if (pinusProbe) {
        try {
          await pinusProbe.drain()
          const st = await pinusProbe.status()
          if (st.present) await log('\n' + pinusProbe.formatSummary())
        } catch { /* 同上 */ }
      }
      // 最後一份一定要送，否則面板停在倒數第二筆、跟日誌摘要對不起來
      try {
        pushStats(runId, { scope: 'frontend', net: netCapture?.summary(), pinus: pinusProbe?.summary(), final: true })
      } catch { /* 同上 */ }

      try {
        db.prepare('UPDATE frontend_auto_runs SET passed=?,failed=?,skipped=?,result=?,finished_at=? WHERE id=?')
          .run(passed, failed, skipped, result, Date.now(), runId)
      } catch {}
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failed++
      await log(`❌ 執行器初始化失敗：${msg.split('\n')[0]}`)
      try {
        db.prepare('UPDATE frontend_auto_runs SET passed=?,failed=?,skipped=?,result=?,finished_at=? WHERE id=?')
          .run(passed, failed, skipped, 'fail', Date.now(), runId)
      } catch {}
    } finally {
      if (pinusDrainTimer) clearInterval(pinusDrainTimer)
      if (statsTimer) clearInterval(statsTimer)
      netCapture?.detach()
      await browser?.close().catch(() => {})
      if (chromeProc && chromeProfileDir) killChromeProcess(chromeProc, chromeProfileDir)
      activeRuns.delete(runId)
    }
  })()
})

router.post('/api/frontend-auto/runs/:id/stop', (req, res) => {
  const runId = req.params.id
  activeRuns.delete(runId)
  // If run is agent-based, notify agent to stop
  const agentSess = uatRunSessions.get(runId)
  if (agentSess) {
    const agentInfo = agentConnections.get(agentSess.agentId)
    if (agentInfo?.ws.readyState === agentInfo?.ws.OPEN) {
      agentInfo.ws.send(JSON.stringify({ type: 'uat_script_stop', runId }))
    }
    uatRunSessions.delete(runId)
  }
  // Mark run as stopped in DB immediately so UI refreshes
  try {
    db.prepare("UPDATE frontend_auto_runs SET result='stopped', finished_at=? WHERE id=? AND result='running'")
      .run(Date.now(), runId)
  } catch {}
  res.json({ ok: true })
})

export default router

import express from 'express'
import multer from 'multer'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { tmpdir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import https from 'https'
import http from 'http'
import WebSocket from 'ws'
import { PNG } from 'pngjs'
import { db } from '../shared.js'
import { agentConnections, uatAgentSessions, uatRunSessions, getAvailableAgents } from '../agent-hub.js'

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
  platform: Platform
  viewportWidth: number
  viewportHeight: number
  done: boolean
  steps: object[]
  ws?: WebSocket
  cdpSend?: CdpSend
  cropRequest?: CropRequest
  lastCrop?: CropResult
}
const recSessions = new Map<string, RecSession>()

function killRecSession(sess: RecSession) {
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

function recorderScript() {
  return `
(() => {
  if (window.__toppathRecorderInstalled) return;
  window.__toppathRecorderInstalled = true;
  const sent = new Set();
  const cssPath = (el) => {
    if (!el || el === document || el === window) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const testId = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test'));
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
    const name = el.getAttribute && el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length <= 40) return 'text=' + text;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(child => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const send = (step) => {
    const key = JSON.stringify(step);
    if (sent.has(key)) return;
    sent.add(key);
    console.info('__TOPPATH_RECORDER__', key);
  };
  document.addEventListener('click', event => {
    if (window.__toppathCropping) return;
    const vx = Math.round(event.clientX);
    const vy = Math.round(event.clientY);
    send({ name: '點擊畫面 (' + vx + ', ' + vy + ')', action: 'click_viewport', x: vx, y: vy });
  }, true);
  document.addEventListener('change', event => {
    const target = event.target;
    if (!target || !('value' in target)) return;
    const selector = cssPath(target);
    if (selector) send({ name: '輸入 ' + selector, action: 'type', selector, value: String(target.value || '') });
  }, true);
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

function chromeDebugPort() {
  return 9300 + Math.floor(Math.random() * 400)
}

function launchRecorderChrome(sessionId: string, url: string, width: number, height: number) {
  const profileDir = join(tmpdir(), `toppath-rec-${sessionId}`)
  const initialWindow = recordableWindowSize(width, height)
  const port = chromeDebugPort()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    `--window-size=${initialWindow.width},${initialWindow.height}`,
    url,
  ]
  const proc = spawn(chromeExecutable(), args, { stdio: 'ignore', shell: false, windowsHide: false })
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
  const shot = await sess.cdpSend('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { x: cropX, y: cropY, width: cropW, height: cropH, scale: 1 },
  })
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

function connectRecorder(sess: RecSession, port: number) {
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
          if (args[0]?.value === '__TOPPATH_RECORDER__' && typeof args[1]?.value === 'string') {
            try { sess.steps.push(JSON.parse(args[1].value)) } catch {}
          }
          if (args[0]?.value === '__TOPPATH_CROP__' && typeof args[1]?.value === 'string') {
            try { void saveCropFromRecorder(sess, JSON.parse(args[1].value)) } catch {}
          }
        }
        if (msg.method === 'Page.loadEventFired') {
          void send('Runtime.evaluate', { expression: recorderScript() })
        }
      } catch {}
    })
    ws.on('open', async () => {
      await send('Runtime.enable')
      await send('Page.enable')
      await syncRecorderViewport(sess)
      await send('Page.addScriptToEvaluateOnNewDocument', { source: recorderScript() })
      await send('Runtime.evaluate', { expression: recorderScript() })
    })
    ws.on('close', () => { sess.done = true })
  })().catch(() => { sess.done = true })
}

function getUatAgents() {
  return [...agentConnections.values()]
    .filter(a => a.capabilities.includes('uat-record'))
    .map(a => ({ agentId: a.agentId, hostname: a.hostname, busy: a.busy }))
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

  if (!url) return res.status(400).json({ ok: false, message: 'url 為必填' })
  if (!platform) return res.status(400).json({ ok: false, message: 'platform must be h5 or pc' })

  // ── Agent-based recording ────────────────────────────────────────────────────
  if (agentId) {
    const agent = agentConnections.get(agentId)
    if (!agent || !agent.capabilities.includes('uat-record')) {
      return res.status(400).json({ ok: false, message: `Agent ${agentId} 不支援 UAT 錄製或已離線` })
    }
    const sessionId = `rec-agent-${Date.now()}-${randomUUID().slice(0, 8)}`
    uatAgentSessions.set(sessionId, {
      agentId,
      steps: [{ name: '前往頁面', action: 'goto', value: url }],
      cropPending: false,
      done: false,
    })
    agent.ws.send(JSON.stringify({ type: 'uat_record_start', sessionId, url, resolution, platform }))
    return res.json({ ok: true, sessionId, displayUrl: url, via: 'agent', agentHostname: agent.hostname })
  }

  // ── Local recording (requires localhost/LAN access) ──────────────────────────
  if (!isLocalRecordRequest(req)) {
    return res.status(403).json({
      ok: false,
      code: 'REMOTE_RECORD_UNSUPPORTED',
      message: '公網環境不支援直接錄製。請選擇一個已連線的 Local Agent，或在伺服器本機 localhost 開啟 ToppathTools 錄製。',
    })
  }

  // Resolve redirect URLs before opening Chrome so local recording starts on
  // the actual lobby page instead of about:blank.
  const resolvedUrl = await followRedirectOnce(url)
  const displayUrl = resolvedUrl !== url ? resolvedUrl : url

  const sessionId = `rec-${Date.now()}-${randomUUID().slice(0, 8)}`
  const [w, h] = resolution.split('x')
  const viewportWidth = Number(w) || 390
  const viewportHeight = Number(h) || 844
  const { proc, profileDir, port } = launchRecorderChrome(sessionId, displayUrl, viewportWidth, viewportHeight)
  const sess: RecSession = {
    proc,
    profileDir,
    originalUrl: url,
    platform,
    viewportWidth,
    viewportHeight,
    done: false,
    steps: [{ name: '前往頁面', action: 'goto', value: url }],
  }
  recSessions.set(sessionId, sess)
  proc.on('close', () => { sess.done = true })
  connectRecorder(sess, port)
  res.json({ ok: true, sessionId, displayUrl })
})

router.get('/api/frontend-auto/record/status/:sessionId', (req, res) => {
  const agentSess = uatAgentSessions.get(req.params.sessionId)
  if (agentSess) {
    return res.json({ found: true, done: agentSess.done, steps: agentSess.steps, lastCrop: agentSess.lastCrop, cropPending: agentSess.cropPending, cdpWarning: (agentSess as unknown as Record<string, unknown>).cdpWarning ?? null })
  }
  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.json({ found: false, done: true, steps: [] })
  res.json({ found: true, done: sess.done, steps: sess.steps, lastCrop: sess.lastCrop, cropPending: !!sess.cropRequest })
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
  const shot = await sess.cdpSend('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { x: cropX, y: cropY, width: cropW, height: cropH, scale: 1 },
  })
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

router.post('/api/frontend-auto/record/stop/:sessionId', (req, res) => {
  const agentSess = uatAgentSessions.get(req.params.sessionId)
  if (agentSess) {
    const agent = agentConnections.get(agentSess.agentId)
    if (agent) agent.ws.send(JSON.stringify({ type: 'uat_record_stop', sessionId: req.params.sessionId }))
    agentSess.done = true
    const steps = agentSess.steps
    uatAgentSessions.delete(req.params.sessionId)
    return res.json({ ok: true, steps })
  }

  const sess = recSessions.get(req.params.sessionId)
  if (!sess) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
  killRecSession(sess)
  setTimeout(() => {
    sess.done = true
    const steps = sess.steps
    recSessions.delete(req.params.sessionId)
    res.json({ ok: true, steps })
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
        const launched = launchRecorderChrome(`run-${runId}`, 'about:blank', w, h)
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
      await log('✅ 執行頁面已準備完成')

      for (const [i, step] of steps.entries()) {
        if (!activeRuns.has(runId)) { await log('🛑 執行已中止'); break }
        const label = step.name ?? `步驟 ${i + 1}`
        const idx = `[${i + 1}/${steps.length}]`
        try {
          if (step.action === 'goto') {
            const target = step.value || startUrl
            await log(`⏳ ${idx} ${label} → ${target}`)
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await page.waitForTimeout(3000)
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
          } else if (step.action === 'click_viewport') {
            await log(`⏳ ${idx} ${label}`)
            await page.mouse.click(step.x ?? 0, step.y ?? 0)
            await page.waitForTimeout(500)
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

      const result = failed > 0 ? 'fail' : 'pass'
      await log(`─── 完成 ─── 通過 ${passed} ／ 失敗 ${failed} ／ 跳過 ${skipped}`)
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

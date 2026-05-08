/**
 * server/routes/autospin.ts
 * AutoSpin management: machine configs, template files, session control.
 */
import { Router } from 'express'
import { z } from 'zod'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { db, addHistory, upload } from '../shared.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'
import { fetchSlsErrors } from '../lib/sls.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_ROOT = join(process.cwd(), 'server')

export const router = Router()

const PYTHON_EXE = process.env.AUTOSPIN_PYTHON ?? 'python'
// Default to the bundled server/python directory; AUTOSPIN_PROJECT env overrides this
const PROJECT_DIR = process.env.AUTOSPIN_PROJECT ?? join(SERVER_ROOT, 'python')

// ─── Types ────────────────────────────────────────────────────────────────────

interface AutospinConfig {
  machineType: string
  gameUrl: string
  rtmpName: string
  rtmpUrl: string
  gameTitleCode: string
  templateType: string
  errorTemplateType: string
  enabled: number
  enableRecording: number
  enableTemplateDetection: number
  notes: string
}

interface SessionState {
  id: string
  status: 'running' | 'stopped' | 'error'
  startedAt: number
  stoppedAt?: number
  logs: string[]
  process: ChildProcess | null
  errorMsg?: string
  heavyTask?: HeavyTaskToken
}

// ─── Session store ────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>()

// SSE subscribers: sessionId → list of res objects
const sseClients = new Map<string, Set<import('express').Response>>()

function broadcastLog(sessionId: string, line: string) {
  const state = sessions.get(sessionId)
  if (state) state.logs.push(line)
  const clients = sseClients.get(sessionId)
  if (clients) {
    for (const res of clients) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`)
    }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

const readConfigs = (userLabel: string): AutospinConfig[] =>
  db.prepare('SELECT * FROM autospin_configs WHERE userLabel = ? ORDER BY machineType').all(userLabel) as AutospinConfig[]

// ─── Machine Config Routes ────────────────────────────────────────────────────

// GET /api/autospin/configs
router.get('/api/autospin/configs', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  res.json({ ok: true, configs: readConfigs(userLabel) })
})

// POST /api/autospin/configs
router.post('/api/autospin/configs', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const body = z.object({
    machineType: z.string().min(1).toUpperCase(),
    gameUrl: z.string().default(''),
    rtmpName: z.string().default(''),
    rtmpUrl: z.string().default(''),
    gameTitleCode: z.string().default(''),
    templateType: z.string().default(''),
    errorTemplateType: z.string().default(''),
    enabled: z.boolean().default(true),
    enableRecording: z.boolean().default(true),
    enableTemplateDetection: z.boolean().default(true),
    notes: z.string().default(''),
    spinInterval: z.number().min(0.1).max(60).default(1.0),
    randomExitEnabled: z.boolean().default(false),
    randomExitChance: z.number().min(0).max(1).default(0.02),
    randomExitMinSpins: z.number().int().min(1).default(50),
    betRandomEnabled: z.boolean().default(false),
    lowBalanceThreshold: z.number().min(0).default(0),
    larkWebhook: z.string().default(''),
    machineNo: z.string().default(''),
  }).parse(req.body)

  db.prepare(`
    INSERT OR REPLACE INTO autospin_configs
    (userLabel, machineType, gameUrl, rtmpName, rtmpUrl, gameTitleCode, templateType, errorTemplateType,
     enabled, enableRecording, enableTemplateDetection, notes,
     spinInterval, randomExitEnabled, randomExitChance, randomExitMinSpins, betRandomEnabled, lowBalanceThreshold, larkWebhook, machineNo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userLabel, body.machineType, body.gameUrl, body.rtmpName, body.rtmpUrl, body.gameTitleCode,
    body.templateType, body.errorTemplateType,
    body.enabled ? 1 : 0, body.enableRecording ? 1 : 0, body.enableTemplateDetection ? 1 : 0,
    body.notes,
    body.spinInterval, body.randomExitEnabled ? 1 : 0, body.randomExitChance,
    body.randomExitMinSpins, body.betRandomEnabled ? 1 : 0, body.lowBalanceThreshold, body.larkWebhook,
    body.machineNo,
  )
  res.json({ ok: true })
})

// DELETE /api/autospin/configs/:machineType
router.delete('/api/autospin/configs/:machineType', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  db.prepare('DELETE FROM autospin_configs WHERE userLabel = ? AND machineType = ?').run(userLabel, req.params.machineType)
  res.json({ ok: true })
})

// ─── SLS Error Logs ────────────────────────────────────────────────────────────

// GET /api/autospin/sls-errors?machineNo=6312745&limit=20
router.get('/api/autospin/sls-errors', async (req, res) => {
  const machineNo = String(req.query.machineNo ?? '').trim()
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '20'))))
  if (!machineNo) return res.status(400).json({ ok: false, message: 'machineNo is required' })
  try {
    const entries = await fetchSlsErrors(machineNo, limit)
    res.json({ ok: true, entries })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, message: msg })
  }
})

// ─── Actions.json management ──────────────────────────────────────────────────

// GET /api/autospin/actions
router.get('/api/autospin/actions', (_req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  const path = join(PROJECT_DIR, 'actions.json')
  if (!existsSync(path)) return res.json({ ok: true, actions: null })
  try {
    res.json({ ok: true, actions: JSON.parse(readFileSync(path, 'utf8')) })
  } catch {
    res.status(500).json({ ok: false, message: '無法讀取 actions.json' })
  }
})

// PUT /api/autospin/actions
router.put('/api/autospin/actions', (req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  const body = z.object({ actions: z.record(z.string(), z.unknown()) }).parse(req.body)
  writeFileSync(join(PROJECT_DIR, 'actions.json'), JSON.stringify(body.actions, null, 2), 'utf8')
  res.json({ ok: true })
})

// ─── Bet Random management ────────────────────────────────────────────────────

// GET /api/autospin/bet-random
router.get('/api/autospin/bet-random', (_req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  const p = join(PROJECT_DIR, 'bet_random.json')
  if (!existsSync(p)) return res.json({ ok: true, data: {} })
  try {
    res.json({ ok: true, data: JSON.parse(readFileSync(p, 'utf8')) })
  } catch {
    res.status(500).json({ ok: false, message: '無法讀取 bet_random.json' })
  }
})

// PUT /api/autospin/bet-random
router.put('/api/autospin/bet-random', (req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  const body = z.object({ data: z.record(z.string(), z.array(z.string())) }).parse(req.body)
  writeFileSync(join(PROJECT_DIR, 'bet_random.json'), JSON.stringify(body.data, null, 2), 'utf8')
  res.json({ ok: true })
})

// ─── Templates management ─────────────────────────────────────────────────────

// GET /api/autospin/templates — list template files
router.get('/api/autospin/templates', (_req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  const dir = join(PROJECT_DIR, 'templates')
  if (!existsSync(dir)) return res.json({ ok: true, files: [] })
  const files = readdirSync(dir)
    .filter(f => ['.png', '.jpg', '.jpeg', '.bmp'].includes(extname(f).toLowerCase()))
    .map(f => ({ name: f }))
  res.json({ ok: true, files })
})

// POST /api/autospin/templates — upload template image
router.post('/api/autospin/templates', upload.single('file'), (req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  if (!req.file) return res.status(400).json({ ok: false, message: '未收到檔案' })
  const dir = join(PROJECT_DIR, 'templates')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, req.file.originalname)
  writeFileSync(dest, req.file.buffer)
  res.json({ ok: true, filename: req.file.originalname })
})

// GET /api/autospin/template-img/:filename — serve template image
router.get('/api/autospin/template-img/:filename', (req, res) => {
  const p = join(PROJECT_DIR, 'templates', req.params.filename)
  if (!existsSync(p)) return res.status(404).send('Not found')
  res.sendFile(p)
})

// DELETE /api/autospin/templates/:filename
router.delete('/api/autospin/templates/:filename', (req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  const dest = join(PROJECT_DIR, 'templates', req.params.filename)
  if (existsSync(dest)) unlinkSync(dest)
  res.json({ ok: true })
})

// GET /api/autospin/captures/:sessionId/:filename — serve screenshot
router.get('/api/autospin/captures/:filename', (req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  const dirs = ['stream_captures', 'screenshots']
  for (const d of dirs) {
    const p = join(PROJECT_DIR, d, req.params.filename)
    if (existsSync(p)) return res.sendFile(p)
  }
  res.status(404).send('Not found')
})

// GET /api/autospin/captures-list — list recent captures
router.get('/api/autospin/captures-list', async (_req, res) => {
  if (!PROJECT_DIR) return res.json({ ok: true, files: [] })
  const result: { name: string; dir: string; mtime: number }[] = []
  for (const d of ['stream_captures', 'screenshots']) {
    const dir = join(PROJECT_DIR, d)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (['.png', '.jpg', '.jpeg'].includes(extname(f).toLowerCase())) {
        const { mtimeMs } = statSync(join(dir, f))
        result.push({ name: f, dir: d, mtime: mtimeMs })
      }
    }
  }
  result.sort((a, b) => b.mtime - a.mtime)
  res.json({ ok: true, files: result.slice(0, 50) })
})

// ─── Session Routes ───────────────────────────────────────────────────────────

// POST /api/autospin/start
router.post('/api/autospin/start', (req, res) => {
  if (!PROJECT_DIR) return res.status(500).json({ ok: false, message: 'AUTOSPIN_PROJECT 未設定' })
  if (!existsSync(join(PROJECT_DIR, 'AutoSpin.py'))) {
    return res.status(500).json({ ok: false, message: `找不到 AutoSpin.py，請確認 AUTOSPIN_PROJECT 路徑：${PROJECT_DIR}` })
  }

  const heavyTask = tryStartHeavyTask(req, 'autospin', 'AutoSpin')
  if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))

  // Kill any existing running session
  for (const [sid, s] of sessions) {
    if (s.status === 'running' && s.process) {
      try { s.process.kill('SIGTERM') } catch { /* ignore */ }
      s.status = 'stopped'
      finishHeavyTask(s.heavyTask)
    }
  }

  // Generate game_config.json from DB
  const configs = readConfigs().filter(c => c.enabled)
  const gameConfig = configs.map(c => ({
    url: c.gameUrl,
    rtmp: c.rtmpName,
    rtmp_url: c.rtmpUrl,
    game_title_code: c.gameTitleCode,
    template_type: c.templateType,
    error_template_type: c.errorTemplateType,
    enabled: true,
    enable_recording: !!c.enableRecording,
    enable_template_detection: !!c.enableTemplateDetection,
  }))
  writeFileSync(join(PROJECT_DIR, 'game_config.json'), JSON.stringify(gameConfig, null, 2), 'utf8')

  const sessionId = `as-${Date.now()}`
  const state: SessionState = { id: sessionId, status: 'running', startedAt: Date.now(), logs: [], process: null, heavyTask: heavyTask.token }
  sessions.set(sessionId, state)

  const proc = spawn(PYTHON_EXE, ['AutoSpin.py'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  })
  state.process = proc

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')

  proc.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) broadcastLog(sessionId, line)
  })
  proc.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) broadcastLog(sessionId, `[stderr] ${line}`)
  })
  proc.on('close', (code) => {
    state.status = code === 0 ? 'stopped' : 'error'
    state.stoppedAt = Date.now()
    finishHeavyTask(state.heavyTask)
    if (code !== 0) state.errorMsg = `Process exited with code ${code}`
    broadcastLog(sessionId, `[系統] 程序結束 (exit code: ${code})`)
    // close SSE clients
    const clients = sseClients.get(sessionId)
    if (clients) { for (const r of clients) r.end(); sseClients.delete(sessionId) }
    addHistory('autospin', `AutoSpin 執行`, `已執行 ${Math.round((Date.now() - state.startedAt) / 1000)} 秒`, { sessionId, exitCode: code })
  })

  res.json({ ok: true, sessionId })
})

// POST /api/autospin/stop
router.post('/api/autospin/stop', (_req, res) => {
  let stopped = false
  for (const [, s] of sessions) {
    if (s.status === 'running' && s.process) {
      try { s.process.kill('SIGTERM') } catch { s.process.kill() }
      finishHeavyTask(s.heavyTask)
      stopped = true
    }
  }
  res.json({ ok: true, stopped })
})

// GET /api/autospin/status
router.get('/api/autospin/status', (_req, res) => {
  let active: SessionState | undefined
  for (const s of sessions.values()) {
    if (s.status === 'running') { active = s; break }
  }
  res.json({
    ok: true,
    running: !!active,
    sessionId: active?.id ?? null,
    startedAt: active?.startedAt ?? null,
  })
})

// GET /api/autospin/logs/:sessionId — last N log lines
router.get('/api/autospin/logs/:sessionId', (req, res) => {
  const state = sessions.get(req.params.sessionId)
  if (!state) return res.status(404).json({ ok: false, message: '找不到 session' })
  const n = parseInt(req.query.n as string) || 200
  res.json({ ok: true, logs: state.logs.slice(-n), status: state.status })
})

// GET /api/autospin/stream/:sessionId — SSE log stream
router.get('/api/autospin/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Send backlog
  const state = sessions.get(sessionId)
  if (state) {
    for (const line of state.logs) res.write(`data: ${JSON.stringify({ line })}\n\n`)
    if (state.status !== 'running') { res.end(); return }
  }

  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set())
  sseClients.get(sessionId)!.add(res)

  req.on('close', () => {
    sseClients.get(sessionId)?.delete(res)
  })
})

// ─── Agent (client-side Playwright) endpoints ────────────────────────────────

interface AgentSession {
  id: string
  status: 'running' | 'stopped'
  startedAt: number
  lastHeartbeat: number
  logs: string[]
  screenshots: { name: string; buffer: Buffer; time: number }[]
  stopRequested: boolean
  pauseRequested: boolean
  userLabel: string
  spinIntervalOverride: number | null
  heavyTask?: HeavyTaskToken
}

const agentSessions = new Map<string, AgentSession>()
const agentSseClients = new Map<string, Set<import('express').Response>>()

function broadcastAgentLog(sessionId: string, line: string) {
  const s = agentSessions.get(sessionId)
  if (s) s.logs.push(line)
  const clients = agentSseClients.get(sessionId)
  if (clients) for (const r of clients) r.write(`data: ${JSON.stringify({ line })}\n\n`)
}

// POST /api/autospin/agent/start — agent registers and gets configs
router.post('/api/autospin/agent/start', (req, res) => {
  const userLabel = (req.body as { userLabel?: string }).userLabel ?? ''
  const heavyTask = tryStartHeavyTask(req, 'autospin-agent', 'AutoSpin Agent')
  if (!heavyTask.ok) return res.status(429).json(heavyTaskConflict(heavyTask.task))

  // Stop any existing agent sessions for this user
  for (const s of agentSessions.values()) {
    if (!userLabel || s.userLabel === userLabel) {
      s.status = 'stopped'
      finishHeavyTask(s.heavyTask)
    }
  }
  const sessionId = `agent-${Date.now()}`
  agentSessions.set(sessionId, {
    id: sessionId, status: 'running', startedAt: Date.now(), lastHeartbeat: Date.now(),
    logs: [], screenshots: [], stopRequested: false, pauseRequested: false, userLabel, spinIntervalOverride: null,
    heavyTask: heavyTask.token,
  })
  // Return configs merged with machine_test_profiles selectors
  const configs = readConfigs(userLabel)
  const profiles = db.prepare('SELECT machineType, spinSelector, balanceSelector FROM machine_test_profiles').all() as
    { machineType: string; spinSelector: string | null; balanceSelector: string | null }[]
  const profileMap = Object.fromEntries(profiles.map(p => [p.machineType, p]))
  const merged = configs.map(c => ({
    ...c,
    enabled: !!c.enabled,
    spinSelector: profileMap[c.machineType]?.spinSelector ?? null,
    balanceSelector: profileMap[c.machineType]?.balanceSelector ?? null,
  }))
  // Load keyword_actions and machine_actions from actions.json
  let keywordActions: Record<string, string[]> = {}
  let machineActions: Record<string, { positions: string[]; clickTake: boolean }> = {}
  let betRandomConfig: Record<string, string[]> = {}
  try {
    const actionsPath = join(PROJECT_DIR, 'actions.json')
    if (existsSync(actionsPath)) {
      const raw = JSON.parse(readFileSync(actionsPath, 'utf-8'))
      keywordActions = raw.keyword_actions ?? {}
      machineActions = Object.fromEntries(
        Object.entries(raw.machine_actions ?? {}).map(([k, v]: [string, any]) => [
          k, { positions: v.positions ?? [], clickTake: !!v.click_take }
        ])
      )
    }
    const betRandomPath = join(PROJECT_DIR, 'bet_random.json')
    if (existsSync(betRandomPath)) {
      betRandomConfig = JSON.parse(readFileSync(betRandomPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  res.json({ ok: true, sessionId, configs: merged, keywordActions, machineActions, betRandomConfig })
})

// POST /api/autospin/agent/:id/log — agent posts a log line
router.post('/api/autospin/agent/:id/log', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  const { line } = req.body as { line: string }
  broadcastAgentLog(req.params.id, line ?? '')
  res.json({ ok: true })
})

// POST /api/autospin/agent/:id/screenshot — agent uploads a screenshot
router.post('/api/autospin/agent/:id/screenshot', upload.single('file'), (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s || !req.file) return res.status(404).json({ ok: false })
  s.screenshots.push({ name: req.file.originalname, buffer: req.file.buffer, time: Date.now() })
  if (s.screenshots.length > 50) s.screenshots.shift() // keep last 50
  broadcastAgentLog(req.params.id, `[截圖] ${req.file.originalname}`)
  res.json({ ok: true })
})

// POST /api/autospin/agent/:id/stop — agent reports it has stopped
router.post('/api/autospin/agent/:id/stop', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (s) {
    s.status = 'stopped'
    finishHeavyTask(s.heavyTask)
    broadcastAgentLog(req.params.id, '[Agent] 已停止')
  }
  res.json({ ok: true })
})

// GET /api/autospin/agent/:id/should-stop — agent polls for stop command (also serves as heartbeat)
router.get('/api/autospin/agent/:id/should-stop', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (s && s.status === 'running') s.lastHeartbeat = Date.now()
  res.json({
    stop: !s || s.stopRequested || s.status === 'stopped',
    pause: s?.pauseRequested ?? false,
    spinInterval: s?.spinIntervalOverride ?? null,
  })
})

// POST /api/autospin/agent/:id/pause — frontend pauses the agent
router.post('/api/autospin/agent/:id/pause', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  s.pauseRequested = true
  broadcastAgentLog(req.params.id, '[Agent] 已暫停')
  return res.json({ ok: true })
})

// POST /api/autospin/agent/:id/resume — frontend resumes the agent
router.post('/api/autospin/agent/:id/resume', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  s.pauseRequested = false
  broadcastAgentLog(req.params.id, '[Agent] 已繼續')
  return res.json({ ok: true })
})

// POST /api/autospin/agent/:id/spin-interval — frontend sets runtime spin interval
router.post('/api/autospin/agent/:id/spin-interval', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  const v = parseFloat((req.body as { value?: string }).value ?? '')
  s.spinIntervalOverride = isNaN(v) ? null : Math.max(0.1, Math.min(60, v))
  return res.json({ ok: true, spinInterval: s.spinIntervalOverride })
})

// POST /api/autospin/agent/stop-all — frontend stops the agent
router.post('/api/autospin/agent/stop-all', (_req, res) => {
  for (const s of agentSessions.values()) {
    if (s.status === 'running') {
      s.stopRequested = true
      finishHeavyTask(s.heavyTask)
    }
  }
  res.json({ ok: true })
})

// GET /api/autospin/agent/status — frontend polls agent status
router.get('/api/autospin/agent/status', (_req, res) => {
  const HEARTBEAT_TIMEOUT = 30_000 // 30s — agent polls every 3s
  let active: AgentSession | undefined
  for (const s of agentSessions.values()) {
    if (s.status === 'running') {
      // Auto-expire if agent stopped sending heartbeats
      if (Date.now() - s.lastHeartbeat > HEARTBEAT_TIMEOUT) {
        s.status = 'stopped'
        finishHeavyTask(s.heavyTask)
        broadcastAgentLog(s.id, '[Agent] 連線逾時，已標記為離線')
      } else {
        active = s; break
      }
    }
  }
  res.json({ ok: true, running: !!active, sessionId: active?.id ?? null, startedAt: active?.startedAt ?? null })
})

// GET /api/autospin/agent/stream/:id — SSE log stream for frontend
// Optional ?from=N skips the first N stored logs (avoids duplicate replay on reconnect)
router.get('/api/autospin/agent/stream/:id', (req, res) => {
  const { id } = req.params
  const fromIndex = parseInt(req.query.from as string ?? '0') || 0
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const s = agentSessions.get(id)
  if (s) for (const line of s.logs.slice(fromIndex)) res.write(`data: ${JSON.stringify({ line })}\n\n`)
  if (!agentSseClients.has(id)) agentSseClients.set(id, new Set())
  agentSseClients.get(id)!.add(res)
  req.on('close', () => agentSseClients.get(id)?.delete(res))
})

// GET /api/autospin/agent/screenshot/:id/:name — serve a screenshot
router.get('/api/autospin/agent/screenshot/:id/:name', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).send('Not found')
  const shot = s.screenshots.find(sc => sc.name === req.params.name)
  if (!shot) return res.status(404).send('Not found')
  res.setHeader('Content-Type', 'image/png')
  res.send(shot.buffer)
})

// GET /api/autospin/agent/screenshots/:id — list screenshots
router.get('/api/autospin/agent/screenshots/:id', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.json({ ok: true, files: [] })
  res.json({ ok: true, files: s.screenshots.map(sc => ({ name: sc.name, time: sc.time })).reverse() })
})

// GET /api/autospin/agent/download/launcher.bat?server=... — serve launcher with embedded server URL
router.get('/api/autospin/agent/download/launcher.bat', (req, res) => {
  const serverUrl = (req.query.server as string) || `${req.protocol}://${req.get('host')}`
  const bat = `@echo off\r\npowershell -Command "iwr '${serverUrl}/api/autospin/agent/download/agent.py' -OutFile '%~dp0toppath-agent.py'" >nul 2>&1\r\npython "%~dp0toppath-agent.py" "%1"\r\nif errorlevel 1 pause\r\n`
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', 'attachment; filename="launch-agent.bat"')
  res.send(bat)
})

// GET /api/autospin/agent/download/launcher-mac.sh?server=... — serve macOS launcher script
router.get('/api/autospin/agent/download/launcher-mac.sh', (req, res) => {
  const serverUrl = (req.query.server as string) || `${req.protocol}://${req.get('host')}`
  const sh = `#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/toppath-agent"
PYTHON_BIN="$INSTALL_DIR/.venv/bin/python"
AGENT_SCRIPT="$INSTALL_DIR/toppath-agent.py"
SERVER_URL="${serverUrl}"
URI="\${1:-}"

mkdir -p "$INSTALL_DIR"
if [ ! -f "$AGENT_SCRIPT" ]; then
  curl -fsSL "$SERVER_URL/api/autospin/agent/download/agent.py" -o "$AGENT_SCRIPT"
fi

if [ ! -x "$PYTHON_BIN" ]; then
  osascript -e 'display dialog "Toppath Agent is not installed yet. Please run the macOS installer first." buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
  exit 1
fi

cd "$INSTALL_DIR"
exec "$PYTHON_BIN" "$AGENT_SCRIPT" "$URI"
`
  res.setHeader('Content-Type', 'application/x-sh; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="launch-agent-mac.sh"')
  res.send(sh)
})

// GET /api/autospin/agent/download/agent.py — serve agent script
router.get('/api/autospin/agent/download/agent.py', (_req, res) => {
  const p = join(PROJECT_DIR, 'toppath-agent.py')
  if (!existsSync(p)) return res.status(404).send('Not found')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="toppath-agent.py"')
  res.sendFile(p)
})

// GET /api/autospin/agent/download/install.bat — serve installer with embedded server URL
router.get('/api/autospin/agent/download/install.bat', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`
  const bat = `@echo off
echo ============================================
echo  Toppath Agent Installer
echo ============================================
echo.
set TOPPATH_SERVER=${serverUrl}
set INSTALL_DIR=%USERPROFILE%\\toppath-agent

:: If server URL contains localhost/127.0.0.1, ask user for real server IP
echo %TOPPATH_SERVER% | findstr /i "localhost 127.0.0.1" >nul
if not errorlevel 1 goto ask_url
goto after_ask

:ask_url
echo [WARN] Server URL is %TOPPATH_SERVER%
echo [WARN] This machine may not be able to reach "localhost" if running remotely.
echo.
set /p TOPPATH_SERVER=Enter actual server URL (e.g. http://192.168.1.100:3000):
if "%TOPPATH_SERVER%"=="" (echo URL cannot be empty. & goto ask_url)

:after_ask
echo Using server: %TOPPATH_SERVER%
echo.

echo [1/5] Creating install directory...
mkdir "%INSTALL_DIR%" 2>nul
set LOG_FILE=%INSTALL_DIR%\\install.log
echo [LOG] Installation started: %date% %time% > "%LOG_FILE%"
echo [LOG] Install dir: %INSTALL_DIR% >> "%LOG_FILE%"
echo [LOG] Server: %TOPPATH_SERVER% >> "%LOG_FILE%"

echo [2/5] Downloading agent script...
powershell -Command "Invoke-WebRequest -Uri '%TOPPATH_SERVER%/api/autospin/agent/download/agent.py' -OutFile '%INSTALL_DIR%\\toppath-agent.py'"
if errorlevel 1 (
  echo ERROR: Download failed. Please check server connection.
  echo [LOG] FAILED at step 2: download >> "%LOG_FILE%"
  echo Log saved to: %LOG_FILE%
  pause & exit /b 1
)
echo [LOG] Step 2 OK >> "%LOG_FILE%"

echo [3/5] Installing Python packages...
pip install playwright requests >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo ERROR: pip install failed. Please make sure Python is installed.
  echo [LOG] FAILED at step 3: pip install >> "%LOG_FILE%"
  echo Log saved to: %LOG_FILE%
  pause & exit /b 1
)
echo [LOG] Step 3 OK >> "%LOG_FILE%"

echo [4/5] Installing Playwright Chromium...
playwright install chromium >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo ERROR: Playwright install failed.
  echo [LOG] FAILED at step 4: playwright install >> "%LOG_FILE%"
  echo Log saved to: %LOG_FILE%
  pause & exit /b 1
)
echo [LOG] Step 4 OK >> "%LOG_FILE%"

echo [5/5] Downloading launcher and registering URI scheme (toppath-agent://)...
powershell -Command "Invoke-WebRequest -Uri '%TOPPATH_SERVER%/api/autospin/agent/download/launcher.bat?server=%TOPPATH_SERVER%' -OutFile '%INSTALL_DIR%\\launch-agent.bat'"
if errorlevel 1 (echo ERROR: Launcher download failed. & pause & exit /b 1)
reg add "HKCU\\Software\\Classes\\toppath-agent" /ve /d "URL:Toppath Agent Protocol" /f >nul
reg add "HKCU\\Software\\Classes\\toppath-agent" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\\Software\\Classes\\toppath-agent\\shell\\open\\command" /ve /d "\\"cmd\\" \\"/c\\" \\"%INSTALL_DIR%\\launch-agent.bat\\" \\"%%1\\"" /f >nul
echo [LOG] Step 5 OK (URI scheme registered) >> "%LOG_FILE%"

echo [LOG] Installation complete: %date% %time% >> "%LOG_FILE%"
echo.
echo ============================================
echo  Installation complete!
echo  Click "Start (Local)" in Toppath Tools
echo  to launch the agent on this machine.
echo.
echo  Log file: %LOG_FILE%
echo ============================================
pause
`
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', 'attachment; filename="install-toppath-agent.bat"')
  res.send(bat)
})

// GET /api/autospin/agent/download/install-mac.sh — serve macOS installer with embedded server URL
router.get('/api/autospin/agent/download/install-mac.sh', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`
  const sh = `#!/usr/bin/env bash
set -euo pipefail

echo "============================================"
echo " Toppath Agent Installer for macOS"
echo "============================================"
echo

TOPPATH_SERVER="${serverUrl}"
INSTALL_DIR="$HOME/toppath-agent"
APP_DIR="$HOME/Applications/Toppath Agent.app"
MACOS_DIR="$APP_DIR/Contents/MacOS"
LOG_FILE="$INSTALL_DIR/install.log"

case "$TOPPATH_SERVER" in
  *localhost*|*127.0.0.1*)
    echo "[WARN] Server URL is $TOPPATH_SERVER"
    echo "[WARN] A remote Mac cannot reach the server through localhost."
    read -r -p "Enter actual server URL (e.g. http://192.168.1.100:3000): " INPUT_SERVER
    if [ -z "$INPUT_SERVER" ]; then
      echo "URL cannot be empty."
      exit 1
    fi
    TOPPATH_SERVER="\${INPUT_SERVER%/}"
    ;;
esac

echo "Using server: $TOPPATH_SERVER"
echo

echo "[1/6] Creating install directory..."
mkdir -p "$INSTALL_DIR" "$HOME/Applications"
{
  echo "[LOG] Installation started: $(date)"
  echo "[LOG] Install dir: $INSTALL_DIR"
  echo "[LOG] Server: $TOPPATH_SERVER"
} > "$LOG_FILE"

echo "[2/6] Downloading agent script..."
curl -fsSL "$TOPPATH_SERVER/api/autospin/agent/download/agent.py" -o "$INSTALL_DIR/toppath-agent.py"
echo "[LOG] Step 2 OK" >> "$LOG_FILE"

echo "[3/6] Preparing Python virtual environment..."
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 was not found. Install Python 3 first, then rerun this installer."
  echo "[LOG] FAILED at step 3: python3 missing" >> "$LOG_FILE"
  exit 1
fi
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/python" -m pip install --upgrade pip >> "$LOG_FILE" 2>&1
echo "[LOG] Step 3 OK" >> "$LOG_FILE"

echo "[4/6] Installing Python packages..."
"$INSTALL_DIR/.venv/bin/python" -m pip install requests playwright opencv-python >> "$LOG_FILE" 2>&1
echo "[LOG] Step 4 OK" >> "$LOG_FILE"

echo "[5/6] Installing Playwright Chromium..."
"$INSTALL_DIR/.venv/bin/python" -m playwright install chromium >> "$LOG_FILE" 2>&1
echo "[LOG] Step 5 OK" >> "$LOG_FILE"

echo "[6/6] Creating Toppath Agent.app and registering toppath-agent://..."
rm -rf "$APP_DIR"

# Wrapper script called by launchd — reads URI from temp file and runs the agent
cat > "$INSTALL_DIR/launch-from-uri.sh" <<'LAUNCHER'
#!/usr/bin/env bash
INSTALL_DIR="$HOME/toppath-agent"
URI_FILE="$INSTALL_DIR/.pending-url"
LOG_FILE="$INSTALL_DIR/agent-launch.log"
URI=\$(cat "\$URI_FILE" 2>/dev/null || echo "")
rm -f "\$URI_FILE"
echo "[\$(date)] Launch request: \$URI" >> "\$LOG_FILE"
exec "\$INSTALL_DIR/.venv/bin/python" "\$INSTALL_DIR/toppath-agent.py" "\$URI"
LAUNCHER
chmod +x "$INSTALL_DIR/launch-from-uri.sh"

# Install launchd user agent — runs agent silently in background, no Terminal window
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/toppath.agent.plist"
mkdir -p "$PLIST_DIR"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>toppath.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$INSTALL_DIR/launch-from-uri.sh</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/agent-launch.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/agent-launch.log</string>
</dict>
</plist>
PLIST
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"
echo "[LOG] launchd agent loaded: $PLIST_PATH" >> "$LOG_FILE"

# AppleScript URL scheme handler — writes URI to file, then kicks launchd agent (no Terminal)
cat > "$INSTALL_DIR/ToppathAgentLauncher.applescript" <<'APPLESCRIPT'
on open location this_url
  set home_path to POSIX path of (path to home folder)
  set url_file to home_path & "toppath-agent/.pending-url"
  -- Write URI to temp file (no network permission needed for file I/O)
  do shell script "printf '%s' " & quoted form of this_url & " > " & quoted form of url_file
  -- Kick the launchd user agent — runs silently in background, no Terminal window
  do shell script "launchctl kickstart -k gui/$(id -u)/toppath.agent 2>/dev/null || launchctl start toppath.agent 2>/dev/null || true"
end open location

on run
  display dialog "Toppath Agent is installed. Use Start (Local) in Toppath Tools to launch it." buttons {"OK"} default button "OK"
end run
APPLESCRIPT

if ! command -v osacompile >/dev/null 2>&1; then
  echo "ERROR: osacompile was not found. This installer must run on macOS."
  echo "[LOG] FAILED at step 6: osacompile missing" >> "$LOG_FILE"
  exit 1
fi
osacompile -o "$APP_DIR" "$INSTALL_DIR/ToppathAgentLauncher.applescript"

PLIST="$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier tools.toppath.agent" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName Toppath Agent" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Toppath Agent" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string Toppath Agent Protocol" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string toppath-agent" "$PLIST"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP_DIR" >/dev/null 2>&1 || true
fi
open "$APP_DIR" >/dev/null 2>&1 || true

echo "[LOG] Step 6 OK" >> "$LOG_FILE"
echo "[LOG] Installation complete: $(date)" >> "$LOG_FILE"
echo
echo "============================================"
echo " Installation complete!"
echo " Click Start (Local) in Toppath Tools"
echo " to launch the agent on this Mac."
echo
echo " Log file: $LOG_FILE"
echo "============================================"
`
  res.setHeader('Content-Type', 'application/x-sh; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="install-toppath-agent-mac.sh"')
  res.send(sh)
})

// ─── History (戰績監控) endpoints ─────────────────────────────────────────────

// POST /api/autospin/agent/:id/history — agent posts a history entry
router.post('/api/autospin/agent/:id/history', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  const body = z.object({
    machineType: z.string(),
    balance: z.number().nullable().default(null),
    spinCount: z.number().int().default(0),
    event: z.string().default('balance'),
    note: z.string().default(''),
  }).parse(req.body)

  // Simple anomaly detection: balance drop > 30% vs session start for this machine
  let isAnomaly = 0
  if (body.balance !== null) {
    const first = db.prepare(
      "SELECT balance FROM autospin_history WHERE sessionId = ? AND machineType = ? AND event = 'balance' ORDER BY id ASC LIMIT 1"
    ).get(s.id, body.machineType) as { balance: number | null } | undefined
    if (first?.balance && first.balance > 0) {
      const drop = (first.balance - body.balance) / first.balance
      if (drop > 0.3) isAnomaly = 1
    }
  }

  db.prepare(`
    INSERT INTO autospin_history (sessionId, machineType, userLabel, balance, spinCount, event, note, isAnomaly)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.id, body.machineType, s.userLabel, body.balance, body.spinCount, body.event, body.note, isAnomaly)

  return res.json({ ok: true, isAnomaly: !!isAnomaly })
})

// GET /api/autospin/history — frontend reads history (last 500 rows, filterable)
router.get('/api/autospin/history', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const machineType = (req.query.machineType as string) || ''
  const sessionId = (req.query.sessionId as string) || ''
  const limit = Math.min(parseInt(req.query.limit as string) || 200, 500)

  let sql = 'SELECT * FROM autospin_history WHERE 1=1'
  const params: unknown[] = []
  if (userLabel) { sql += ' AND userLabel = ?'; params.push(userLabel) }
  if (machineType) { sql += ' AND machineType = ?'; params.push(machineType) }
  if (sessionId) { sql += ' AND sessionId = ?'; params.push(sessionId) }
  sql += ' ORDER BY id DESC LIMIT ?'
  params.push(limit)

  const rows = db.prepare(sql).all(...params)
  res.json({ ok: true, rows })
})

// DELETE /api/autospin/history — clear history for current user
router.delete('/api/autospin/history', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  db.prepare('DELETE FROM autospin_history WHERE userLabel = ?').run(userLabel)
  res.json({ ok: true })
})

// ─── Reconciliation (後台對帳) endpoints ─────────────────────────────────────

// GET /api/autospin/reconcile/config
router.get('/api/autospin/reconcile/config', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM reconcile_config').all() as { key: string; value: string }[]
  const cfg: Record<string, string> = {}
  for (const r of rows) cfg[r.key] = r.value
  res.json({ ok: true, config: cfg })
})

// PUT /api/autospin/reconcile/config
router.put('/api/autospin/reconcile/config', (req, res) => {
  const body = z.object({
    base_url: z.string().default('https://backendservertest.osmslot.org'),
    login_path: z.string().default('/auth/login'),
    token: z.string().default(''),
    lastlogintime: z.string().default(''),
    channelId: z.string().default('873'),
    playerstudioid: z.string().default('cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL'),
    origin: z.string().default('https://qat-cp.osmslot.org'),
    referer: z.string().default('https://qat-cp.osmslot.org/'),
    login_username: z.string().default(''),
    login_password: z.string().default(''),
    auto_login: z.boolean().default(true),
  }).parse(req.body)
  const upsert = db.prepare('INSERT OR REPLACE INTO reconcile_config (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(body)) upsert.run(k, String(v))
  res.json({ ok: true })
})

// Helper: load reconcile config from DB
function loadReconcileConfig() {
  const rows = db.prepare('SELECT key, value FROM reconcile_config').all() as { key: string; value: string }[]
  const cfg: Record<string, string> = {}
  for (const r of rows) cfg[r.key] = r.value
  return cfg
}

// Helper: build request headers for backend API
function reconcileHeaders(cfg: Record<string, string>) {
  return {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'origin': cfg.origin || 'https://qat-cp.osmslot.org',
    'referer': cfg.referer || 'https://qat-cp.osmslot.org/',
    'token': cfg.token || '',
    'lastlogintime': cfg.lastlogintime || '',
  }
}

// Helper: login and refresh token
async function reconcileLogin(cfg: Record<string, string>): Promise<string | null> {
  const baseUrl = (cfg.base_url || 'https://backendservertest.osmslot.org').replace(/\/$/, '')
  const loginPath = cfg.login_path || '/auth/login'
  const payload = { username: cfg.login_username || 'admin', password: cfg.login_password || '' }
  try {
    const r = await fetch(`${baseUrl}${loginPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': cfg.origin || '', 'referer': cfg.referer || '' },
      body: JSON.stringify(payload),
    })
    const d = await r.json() as { code?: number; data?: { token?: string; lastLoginTime?: string } }
    if (d.code === 20000 && d.data?.token) {
      const token = d.data.token
      const llt = d.data.lastLoginTime ?? ''
      db.prepare('INSERT OR REPLACE INTO reconcile_config (key, value) VALUES (?, ?)').run('token', token)
      db.prepare('INSERT OR REPLACE INTO reconcile_config (key, value) VALUES (?, ?)').run('lastlogintime', llt)
      return token
    }
    return null
  } catch { return null }
}

// Helper: fetch game records from backend API (mirrors BackendRecordClient.fetch_game_records)
async function fetchBackendRecords(
  cfg: Record<string, string>,
  startDt: string, endDt: string,
  playerId = '', pageSize = 50, maxPages = 5,
): Promise<unknown[]> {
  const baseUrl = (cfg.base_url || 'https://backendservertest.osmslot.org').replace(/\/$/, '')
  const endpoint = `${baseUrl}/egm/reports/gameRecordList`
  const channel = cfg.channelId || '873'
  const playerstudioid = cfg.playerstudioid || 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL'

  let headers = reconcileHeaders(cfg)
  const all: unknown[] = []
  let reloginDone = false

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      'dateTime[]': startDt,
      'clientMachineName': '',
      'playerId': playerId,
      'playerName': '',
      'orderId': '',
      'page': String(page),
      'pageSize': String(pageSize),
      'dateTimeType': '0',
      'playerstudioid': playerstudioid,
      'bgType': '0',
      'dataType': '0',
      'isall': 'false',
      'channelId': channel,
    })
    // dateTime[] needs to be duplicated for range
    params.append('dateTime[]', endDt)

    try {
      const r = await fetch(`${endpoint}?${params}`, { method: 'POST', headers })
      const d = await r.json() as { code?: number; data?: { items?: unknown[] } }

      // Token expired → auto re-login once
      if (d.code === 40200 && cfg.auto_login !== 'false' && !reloginDone) {
        const newToken = await reconcileLogin(cfg)
        if (newToken) {
          cfg = loadReconcileConfig()
          headers = reconcileHeaders(cfg)
          reloginDone = true
          page-- // retry this page
          continue
        }
        break
      }

      const items = d.data?.items ?? []
      if (!Array.isArray(items) || items.length === 0) break
      all.push(...items)
      if (items.length < pageSize) break
    } catch { break }
  }
  return all
}

// POST /api/autospin/reconcile/test — test backend API connection
router.post('/api/autospin/reconcile/test', async (_req, res) => {
  try {
    const cfg = loadReconcileConfig()
    if (!cfg.token && cfg.auto_login === 'true') {
      const t = await reconcileLogin(cfg)
      if (!t) return res.json({ ok: false, message: '自動登入失敗，請確認帳密或手動填入 token' })
    }
    // Test: fetch 1 record for last hour
    const now = new Date()
    const start = new Date(now.getTime() - 60 * 60 * 1000)
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
    const items = await fetchBackendRecords(cfg, fmt(start), fmt(now), '', 1, 1)
    return res.json({ ok: true, message: `連線成功，測試查詢回傳 ${items.length} 筆` })
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, message: String(e) })
  }
})

// POST /api/autospin/agent/:id/game-record — agent posts a pinus history record
router.post('/api/autospin/agent/:id/game-record', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  const body = z.object({
    machineType: z.string(),
    records: z.array(z.object({
      gmid: z.string().default(''),
      gameid: z.string().default(''),
      orderId: z.string().default(''),
      bet: z.number().default(0),
      win: z.number().default(0),
      recordTime: z.string().default(''),
    })),
  }).parse(req.body)

  const ins = db.prepare(`
    INSERT OR IGNORE INTO reconcile_front_records
    (sessionId, machineType, gmid, gameid, orderId, bet, win, recordTime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const r of body.records) {
    ins.run(s.id, body.machineType, r.gmid, r.gameid, r.orderId, r.bet, r.win, r.recordTime)
  }
  return res.json({ ok: true, inserted: body.records.length })
})

// POST /api/autospin/reconcile/run — run reconciliation
router.post('/api/autospin/reconcile/run', async (req, res) => {
  const body = z.object({
    rangeStart: z.string(),
    rangeEnd: z.string(),
    machineType: z.string().default(''),
    playerId: z.string().default(''),
  }).parse(req.body)

  const userLabel = (req.headers['x-user-label'] as string) || ''

  // 1. Fetch backend records
  const cfg = loadReconcileConfig()
  let backendItems: unknown[] = []
  try {
    backendItems = await fetchBackendRecords(cfg, body.rangeStart, body.rangeEnd, body.playerId)
  } catch (e) {
    return res.status(500).json({ ok: false, message: `後台 API 查詢失敗：${e}` })
  }

  // 2. Get front-end records (from agent)
  let frontSql = 'SELECT * FROM reconcile_front_records WHERE recordTime >= ? AND recordTime <= ?'
  const frontParams: unknown[] = [body.rangeStart, body.rangeEnd]
  if (body.machineType) { frontSql += ' AND machineType = ?'; frontParams.push(body.machineType) }
  const frontRows = db.prepare(frontSql).all(...frontParams) as {
    gmid: string; gameid: string; orderId: string; bet: number; win: number; recordTime: string; machineType: string
  }[]

  // 3. Normalize helpers
  const toFloat = (v: unknown) => parseFloat(String(v || 0)) || 0
  type NormRecord = { uid: string; gameid: string; orderId: string; bet: number; win: number; time: string }

  const normFront: NormRecord[] = frontRows.map(r => ({
    uid: r.gmid, gameid: r.gameid, orderId: r.orderId,
    bet: r.bet, win: r.win, time: r.recordTime,
  }))

  const normBackend: NormRecord[] = (backendItems as Record<string, unknown>[]).map(item => ({
    uid: String(item.uid ?? ''),
    gameid: String(item.gameid ?? ''),
    orderId: String(item.order_id ?? ''),
    bet: toFloat(item.bet),
    win: toFloat(item.win),
    time: String(item.date_time ?? item.bet_time ?? ''),
  })).filter(r => r.uid || r.orderId)

  // 4. Match front → backend
  const usedIdx = new Set<number>()
  const details: { status: string; uid: string; time: string; bet: number; win: number; note: string }[] = []
  let matched = 0, unmatched = 0

  for (const fr of normFront) {
    let found = -1
    // Try order_id match first
    if (fr.orderId) {
      found = normBackend.findIndex((br, i) => !usedIdx.has(i) && br.orderId === fr.orderId)
    }
    // Fallback: uid + bet + win + time within 3s
    if (found === -1) {
      found = normBackend.findIndex((br, i) => {
        if (usedIdx.has(i) || br.uid !== fr.uid) return false
        if (Math.abs(br.bet - fr.bet) > 0.01 || Math.abs(br.win - fr.win) > 0.01) return false
        const diff = Math.abs(new Date(br.time).getTime() - new Date(fr.time).getTime())
        return diff <= 3000
      })
    }
    if (found >= 0) {
      usedIdx.add(found)
      matched++
      details.push({ status: 'MATCH', uid: fr.uid, time: fr.time, bet: fr.bet, win: fr.win, note: '' })
    } else {
      unmatched++
      details.push({ status: 'MISSING', uid: fr.uid, time: fr.time, bet: fr.bet, win: fr.win, note: '後台未找到對應紀錄' })
    }
  }

  // 5. Anomaly detection on backend records
  const anomalies: { uid: string; time: string; bet: number; win: number; note: string }[] = []
  for (const br of normBackend) {
    if (br.win > br.bet * 50 && br.bet > 0) {
      anomalies.push({ uid: br.uid, time: br.time, bet: br.bet, win: br.win, note: `大獎：win/bet = ${(br.win / br.bet).toFixed(1)}x` })
    }
  }
  // Detect burst: >10 records within 5s
  const sorted = [...normBackend].sort((a, b) => a.time.localeCompare(b.time))
  for (let i = 0; i < sorted.length - 10; i++) {
    const window = sorted.slice(i, i + 10)
    const span = new Date(window[9].time).getTime() - new Date(window[0].time).getTime()
    if (span <= 5000) {
      anomalies.push({ uid: window[0].uid, time: window[0].time, bet: 0, win: 0, note: `連發異常：5 秒內 ${window.length} 筆下注` })
      break
    }
  }

  // 6. Save report
  const summary = `前端 ${normFront.length} 筆 / 後台 ${normBackend.length} 筆 / 匹配 ${matched} / 未匹配 ${unmatched} / 異常 ${anomalies.length}`
  const reportId = (db.prepare(`
    INSERT INTO reconcile_reports
    (rangeStart, rangeEnd, machineType, frontCount, backendCount, matchedCount, unmatchedCount, anomalyCount, summary, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.rangeStart, body.rangeEnd, body.machineType,
    normFront.length, normBackend.length, matched, unmatched, anomalies.length,
    summary, JSON.stringify({ details, anomalies }),
  ) as { lastInsertRowid: number }).lastInsertRowid

  return res.json({ ok: true, reportId, summary, matched, unmatched, anomalies: anomalies.length, details, backendAnomalies: anomalies })
})

// GET /api/autospin/reconcile/reports — list saved reports
router.get('/api/autospin/reconcile/reports', (_req, res) => {
  const rows = db.prepare('SELECT id, runAt, rangeStart, rangeEnd, machineType, frontCount, backendCount, matchedCount, unmatchedCount, anomalyCount, summary FROM reconcile_reports ORDER BY id DESC LIMIT 50').all()
  res.json({ ok: true, reports: rows })
})

// GET /api/autospin/reconcile/reports/:id — get full report details
router.get('/api/autospin/reconcile/reports/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM reconcile_reports WHERE id = ?').get(req.params.id) as
    { details: string } & Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ ok: false })
  return res.json({ ok: true, report: { ...row, details: JSON.parse(row.details || '{}') } })
})

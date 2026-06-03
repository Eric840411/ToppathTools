/**
 * server/worker.ts
 * Separate PM2-managed process for future heavy jobs.
 *
 * This process intentionally starts small: health, capacity, and runtime
 * telemetry first. Heavy job execution can move here one route at a time.
 */
import cors from 'cors'
import Bottleneck from 'bottleneck'
import dotenv from 'dotenv'
import express from 'express'
import { createServer } from 'http'
import { cpus, hostname, totalmem, freemem } from 'os'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { larkGenerateSchema, log, verifyLocalAgentToken, getClientIP, getUser, db } from './shared.js'
import { runGenerateTestcasesFileJob, runLarkGenerateTestcasesJob, resumeGenerationJob, type WorkerUploadFile } from './routes/integrations.js'
import { router as jiraRouter } from './routes/jira.js'
import { router as gameshowRouter } from './routes/gameshow.js'
import { router as autospinRouter } from './routes/autospin.js'
import { router as osmUatRouter } from './routes/osm-uat.js'
import { router as frontendAutoRouter, logBuffers, logClients, pushLog, activeRuns } from './routes/frontend-auto.js'
import uiScreenshotRouter from './routes/ui-screenshot.js'
import { activeRunners, pendingSourceUpdates, router as machineTestRouter } from './routes/machine-test.js'
import {
  handleScriptedBetAgentDisconnect,
  handleScriptedBetAgentDone,
  handleScriptedBetAgentEvent,
  router as scriptedBetRouter,
} from './routes/scripted-bet.js'
import { getAiAgentMonitorSnapshot } from './routes/gemini.js'
import { runWithRequestContext } from './request-context.js'
import {
  viewerSockets,
  broadcastBuffer,
  agentConnections,
  claimJob,
  completeJob,
  getJobStatuses,
  cancelDistSession,
  broadcastToViewers,
  uatAgentSessions,
  uatRunSessions,
  type AgentInfo,
} from './agent-hub.js'
import type { TestEvent } from './machine-test/types.js'
import type { ScriptedBetEvent } from './scripted-bet/types.js'
dotenv.config()

const app = express()
const server = createServer(app)
const port = Number(process.env.WORKER_PORT ?? 3010)
const startedAt = Date.now()
const workerId = `${hostname()}-${process.pid}-${startedAt}`
type WorkerTask = {
  id: string
  userKey: string
  userLabel: string
  type: string
  label: string
  startedAt: number
}

const runningTasks = new Map<string, WorkerTask>()
const queuedTasks = new Map<string, WorkerTask>()
const workerQueue = new Bottleneck({
  maxConcurrent: Number(process.env.WORKER_HEAVY_CONCURRENCY ?? 2),
  highWater: Number(process.env.WORKER_HEAVY_QUEUE_LIMIT ?? 30),
  strategy: Bottleneck.strategy.OVERFLOW,
})

app.use(cors())
app.use('/api/machine-test/osm-status', express.text({ type: '*/*', limit: '5mb' }))
app.use((req, res, next) => {
  if (req.path === '/api/machine-test/osm-status') return next()
  return express.json({ limit: '200mb' })(req, res, next)
})
app.use((req, _res, next) => {
  const user = String(req.headers['x-auth-user'] ?? req.headers['x-jira-email'] ?? '—')
  const userDisplay = String(req.headers['x-user-label'] ?? req.headers['x-auth-user'] ?? req.headers['x-jira-email'] ?? '未登入使用者')
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
  runWithRequestContext(
    { ip, user, userDisplay, path: req.path, method: req.method, operation: `${req.method} ${req.path}` },
    () => next(),
  )
})

function memorySnapshot() {
  const mem = process.memoryUsage()
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    systemFree: freemem(),
    systemTotal: totalmem(),
  }
}

function capacitySnapshot() {
  return {
    cpuCount: cpus().length,
    browserConcurrency: Number(process.env.WORKER_BROWSER_CONCURRENCY ?? 2),
    aiConcurrency: Number(process.env.WORKER_AI_CONCURRENCY ?? 1),
    batchConcurrency: Number(process.env.WORKER_BATCH_CONCURRENCY ?? 1),
    heavyConcurrency: Number(process.env.WORKER_HEAVY_CONCURRENCY ?? 2),
    heavyQueueLimit: Number(process.env.WORKER_HEAVY_QUEUE_LIMIT ?? 30),
  }
}

async function runQueuedTask<T>(task: WorkerTask, fn: () => Promise<T>): Promise<T> {
  queuedTasks.set(task.id, task)
  console.log(`[Worker][task:queued] ${task.label} (${task.type}) user=${task.userLabel} id=${task.id}`)
  return workerQueue.schedule(async () => {
    queuedTasks.delete(task.id)
    runningTasks.set(task.id, task)
    console.log(`[Worker][execute:start] ${task.label} user=${task.userLabel} id=${task.id}`)
    try {
      return await fn()
    } finally {
      runningTasks.delete(task.id)
    }
  })
}

app.get('/internal/worker/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'toppath-worker',
    workerId,
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - startedAt,
    capacity: capacitySnapshot(),
    memory: memorySnapshot(),
  })
})

app.get('/internal/worker/tasks', (_req, res) => {
  res.json({
    ok: true,
    running: [...runningTasks.values()],
    queued: [...queuedTasks.values()],
    counts: {
      running: runningTasks.size,
      queued: queuedTasks.size,
      limiterQueued: workerQueue.queued(),
    },
  })
})

app.get('/internal/ai-agent/monitor', (_req, res) => {
  res.json(getAiAgentMonitorSnapshot())
})

app.post('/internal/worker/tasks/start', (req, res) => {
  const task = req.body as WorkerTask
  if (!task?.id) return res.status(400).json({ ok: false, message: 'missing task id' })
  runningTasks.set(task.id, task)
  console.log(`[Worker][task:start] ${task.label} (${task.type}) user=${task.userLabel} id=${task.id}`)
  res.json({ ok: true })
})

app.post('/internal/worker/tasks/finish', (req, res) => {
  const task = req.body as WorkerTask & { finishedAt?: number }
  if (!task?.id) return res.status(400).json({ ok: false, message: 'missing task id' })
  queuedTasks.delete(task.id)
  runningTasks.delete(task.id)
  const elapsedMs = (task.finishedAt ?? Date.now()) - task.startedAt
  console.log(`[Worker][task:finish] ${task.label} (${task.type}) user=${task.userLabel} id=${task.id} elapsedMs=${elapsedMs}`)
  res.json({ ok: true })
})

app.post('/internal/worker/testcase/lark-generate', (req, res) => {
  const payload = req.body as {
    requestId?: string
    body?: unknown
    clientIp?: string
    user?: string
    callbackUrl?: string
    operatorKey?: string
    operatorName?: string
  }
  const requestId = String(payload.requestId ?? '')
  const callbackUrl = String(payload.callbackUrl ?? '')
  if (!requestId || !callbackUrl) {
    return res.status(400).json({ ok: false, message: 'missing requestId or callbackUrl' })
  }

  let body
  try {
    body = larkGenerateSchema.parse(payload.body)
  } catch (error) {
    return res.status(400).json({ ok: false, message: 'invalid testcase payload', error: String(error) })
  }

  const task: WorkerTask = {
    id: requestId,
    userKey: String(payload.user ?? 'unknown'),
    userLabel: String(payload.user ?? 'unknown'),
    type: 'testcase',
    label: 'TestCase generate',
    startedAt: Date.now(),
  }
  ;(async () => {
    let result
    try {
      result = await runQueuedTask(task, () => {
        return runLarkGenerateTestcasesJob({
          body,
          clientIp: String(payload.clientIp ?? 'worker'),
          user: task.userKey,
          operatorKey: String(payload.operatorKey ?? ''),
          operatorName: String(payload.operatorName ?? ''),
        })
      })
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }

    try {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      })
      console.log(`[Worker][execute:finish] ${task.label} user=${task.userLabel} id=${task.id} ok=${result.ok}`)
    } catch (error) {
      console.error(`[Worker][execute:callback-failed] ${task.label} id=${task.id}`, error)
    }
  })()

  res.json({ ok: true, accepted: true, requestId })
})

app.post('/internal/worker/testcase/resume', (req, res) => {
  const payload = req.body as {
    requestId?: string
    jobId?: string
    clientIp?: string
    user?: string
    callbackUrl?: string
  }
  const requestId = String(payload.requestId ?? '')
  const jobId = String(payload.jobId ?? '')
  const callbackUrl = String(payload.callbackUrl ?? '')
  if (!requestId || !jobId || !callbackUrl) {
    return res.status(400).json({ ok: false, message: 'missing requestId, jobId or callbackUrl' })
  }

  const task: WorkerTask = {
    id: requestId,
    userKey: String(payload.user ?? 'unknown'),
    userLabel: String(payload.user ?? 'unknown'),
    type: 'testcase',
    label: `TestCase resume (job=${jobId})`,
    startedAt: Date.now(),
  }
  ;(async () => {
    let result
    try {
      result = await runQueuedTask(task, () =>
        resumeGenerationJob(jobId, String(payload.clientIp ?? 'worker'), task.userKey)
      )
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    try {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      })
    } catch (error) {
      console.error(`[Worker][resume:callback-failed] id=${requestId}`, error)
    }
  })()

  res.json({ ok: true, accepted: true, requestId })
})

app.post('/internal/worker/testcase/file-generate', async (req, res) => {
  const payload = req.body as {
    files?: WorkerUploadFile[]
    oldFiles?: WorkerUploadFile[]
    form?: Record<string, unknown>
    clientIp?: string
    user?: string
    operatorKey?: string
    operatorName?: string
  }
  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    return res.status(400).json({ ok: false, message: 'missing uploaded files' })
  }

  const task: WorkerTask = {
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userKey: String(payload.user ?? 'unknown'),
    userLabel: String(payload.user ?? 'unknown'),
    type: 'testcase-file',
    label: 'TestCase file generate',
    startedAt: Date.now(),
  }

  try {
    const result = await runQueuedTask(task, () => {
      return runGenerateTestcasesFileJob({
        files: payload.files,
        oldFiles: payload.oldFiles ?? [],
        form: payload.form ?? {},
        clientIp: String(payload.clientIp ?? 'worker'),
        user: task.userKey,
        operatorKey: String(payload.operatorKey ?? ''),
        operatorName: String(payload.operatorName ?? ''),
      })
    })
    console.log(`[Worker][execute:finish] ${task.label} user=${task.userLabel} id=${task.id} ok=${result.ok}`)
    return res.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[Worker][execute:error] ${task.label} user=${task.userLabel} id=${task.id}`, error)
    return res.status(500).json({ ok: false, message })
  }
})

function shouldQueueRequest(path: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  if (path === '/api/machine-test/osm-status') return false
  if (path.startsWith('/api/gs/')) return true
  if (path.startsWith('/api/image-check/')) return true
  if (path.startsWith('/api/machine-test/')) return true
  if (path.startsWith('/api/osm-uat/')) return true
  if (path.startsWith('/api/autospin/')) return true
  if (path.startsWith('/api/frontend-auto/')) return true
  if (path === '/api/jira/batch-create') return true
  if (path === '/api/jira/batch-comment') return true
  if (path === '/api/jira/batch-transition') return true
  if (path === '/api/jira/pm-batch-create') return true
  return false
}

app.use((req, res, next) => {
  if (!shouldQueueRequest(req.path, req.method)) return next()
  const task: WorkerTask = {
    id: `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userKey: String(req.headers['x-auth-user'] ?? req.headers['x-jira-email'] ?? 'unknown'),
    userLabel: String(req.headers['x-user-label'] ?? req.headers['x-auth-user'] ?? req.headers['x-jira-email'] ?? 'unknown'),
    type: 'http',
    label: `${req.method} ${req.path}`,
    startedAt: Date.now(),
  }
  queuedTasks.set(task.id, task)
  workerQueue.schedule(() => new Promise<void>((resolve) => {
    queuedTasks.delete(task.id)
    runningTasks.set(task.id, task)
    const done = () => resolve()
    res.once('finish', done)
    res.once('close', done)
    next()
  })).catch(error => {
    queuedTasks.delete(task.id)
    if (!res.headersSent) res.status(503).json({ ok: false, message: 'Worker queue is full', error: String(error) })
  }).finally(() => {
    runningTasks.delete(task.id)
  })
})

// Heavy route ownership lives on the worker. The public server proxies selected
// endpoints here so frontend URLs remain unchanged.
app.use(jiraRouter)
app.use(gameshowRouter)
app.use(autospinRouter)
app.use(osmUatRouter)
app.use(machineTestRouter)
app.use(scriptedBetRouter)
app.use('/api/ui-screenshot', uiScreenshotRouter)
app.use(frontendAutoRouter)

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(
  (error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      log('warn', getClientIP(req), getUser(req), `Worker validation error @ ${req.method} ${req.path}`, error.issues.map(i => i.message).join('; '))
      return res.status(400).json({ ok: false, message: 'Validation error', details: error.issues })
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    log('error', getClientIP(req), getUser(req), `Worker unhandled error @ ${req.method} ${req.path}`, message)
    console.error(`[Worker][Error] ${req.method} ${req.path}`, error)
    return res.status(500).json({ ok: false, message })
  },
)

const wss = new WebSocketServer({ server })
wss.on('error', () => {})

wss.on('connection', (ws, req) => {
  const path = req.url?.split('?')[0] ?? ''

  if (path === '/ws/machine-test/events') {
    viewerSockets.add(ws)
    for (const ev of broadcastBuffer) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev))
    }
    ws.on('close', () => viewerSockets.delete(ws))
    return
  }

  if (path === '/ws/agent') {
    let agentId = ''

    // Keepalive ping every 30s to prevent nginx proxy_read_timeout from dropping idle WebSockets
    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping()
      else clearInterval(pingTimer)
    }, 30_000)
    ws.on('close', () => clearInterval(pingTimer))

    ws.on('message', (raw) => {
      let msg: {
        type: string
        agentId?: string
        hostname?: string
        operatorKey?: string
        operatorName?: string
        agentToken?: string
        capabilities?: string[]
        version?: string
        sessionId?: string
        event?: unknown
        machineCode?: string
        failed?: boolean
      }
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (agentId) {
        const existing = agentConnections.get(agentId)
        if (existing) existing.lastSeenAt = Date.now()
      }

      if (msg.type === 'agent_ready' && msg.agentId) {
        agentId = msg.agentId
        const capabilities = Array.isArray(msg.capabilities) && msg.capabilities.length > 0
          ? msg.capabilities.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim())
          : ['machine-test']
        const ownerKey = typeof msg.operatorKey === 'string' ? msg.operatorKey.trim() : ''
        const token = typeof msg.agentToken === 'string' ? msg.agentToken.trim() : ''
        const verifiedToken = verifyLocalAgentToken(token, ownerKey)
        if (!verifiedToken) {
          log('warn', '-', '-', `Agent rejected: ${agentId} (${msg.hostname ?? agentId}) invalid token for owner=${ownerKey || 'empty'}`)
          ws.close(1008, 'Invalid agent token')
          return
        }
        const ownerName = verifiedToken.ownerName || (typeof msg.operatorName === 'string' ? msg.operatorName.trim() : ownerKey)
        const now = Date.now()
        const info: AgentInfo = {
          ws,
          agentId,
          hostname: msg.hostname ?? agentId,
          ownerKey,
          ownerName,
          tokenId: verifiedToken.id,
          capabilities,
          version: typeof msg.version === 'string' ? msg.version : undefined,
          connectedAt: now,
          lastSeenAt: now,
          busy: false,
          sessionId: null,
        }
        agentConnections.set(agentId, info)
        log('info', '-', '-', `Agent connected: ${agentId} (${info.hostname}) owner=${info.ownerName || 'unowned'} capabilities=${info.capabilities.join(',')}`)
        return
      }

      if (msg.type === 'event' && msg.sessionId && msg.event) {
        const ev = msg.event as TestEvent
        if (agentId) {
          const info = agentConnections.get(agentId)
          ev.agentHostname = info?.hostname ?? agentId
        }
        broadcastToViewers(ev)
        return
      }

      if (msg.type === 'scripted_bet_event' && msg.sessionId && msg.event) {
        handleScriptedBetAgentEvent(msg.sessionId, msg.event as ScriptedBetEvent)
        return
      }

      if (msg.type === 'scripted_bet_done' && msg.sessionId) {
        handleScriptedBetAgentDone(msg.sessionId)
        return
      }

      if (msg.type === 'claim_job' && msg.sessionId) {
        const code = claimJob(msg.sessionId, agentId)
        const statuses = getJobStatuses(msg.sessionId)
        if (statuses) broadcastToViewers({ type: 'queue_update', statuses, message: '', ts: new Date().toISOString() })
        if (code) ws.send(JSON.stringify({ type: 'job_assigned', machineCode: code }))
        else ws.send(JSON.stringify({ type: 'no_more_jobs' }))
        return
      }

      if (msg.type === 'job_done' && msg.sessionId && msg.machineCode) {
        const allDone = completeJob(msg.sessionId, msg.machineCode, msg.failed ?? false)
        const statuses = getJobStatuses(msg.sessionId)
        if (statuses) broadcastToViewers({ type: 'queue_update', statuses, message: '', ts: new Date().toISOString() })
        if (allDone) {
          broadcastToViewers({ type: 'session_done', message: '全部機台測試完成', ts: new Date().toISOString() })
          activeRunners.delete(msg.sessionId)
        }
        return
      }

      if (msg.type === 'agent_done' && msg.sessionId) {
        if (agentId) {
          const info = agentConnections.get(agentId)
          if (info) { info.busy = false; info.sessionId = null }
        }
        return
      }

      if (msg.type === 'sources_updated') {
        const result = msg as { type: 'sources_updated'; ok: boolean; results?: { file: string; ok: boolean; error?: string }[] }
        const pending = pendingSourceUpdates.get(agentId)
        if (pending) {
          const failedFiles = (result.results ?? []).filter(r => !r.ok).map(r => r.file)
          pending.resolve({ ok: result.ok, error: failedFiles.length > 0 ? `${failedFiles.join(', ')} 更新失敗` : undefined })
        }
        return
      }

      if (msg.type === 'uat_record_event' && msg.sessionId) {
        const ev = (msg as { type: string; sessionId: string; event: Record<string, unknown> }).event
        const sess = uatAgentSessions.get(msg.sessionId)
        if (!sess || !ev) return
        if (ev.kind === 'step' && ev.step) {
          sess.steps.push(ev.step as object)
        } else if (ev.kind === 'crop_image') {
          // Agent sends screenshot data + crop info; server saves to disk and inserts baseline
          void (async () => {
            try {
              const { randomUUID } = await import('crypto')
              const { writeFileSync, mkdirSync } = await import('fs')
              const { join } = await import('path')
              const { db } = await import('./shared.js')
              const imageDir = join(process.cwd(), 'server', 'frontend-auto', 'images')
              mkdirSync(imageDir, { recursive: true })
              const imageBase64 = ev.imageBase64 as string
              const filename = `${Date.now()}-${randomUUID()}.png`
              writeFileSync(join(imageDir, filename), Buffer.from(imageBase64, 'base64'))
              const imagePath = `/api/frontend-auto/images/${filename}`
              const id = (ev.id as string) || randomUUID()
              const name = (ev.name as string) || `框選截圖 ${Date.now()}`
              const cropX = Math.round(Number(ev.x) || 0)
              const cropY = Math.round(Number(ev.y) || 0)
              const cropW = Math.round(Number(ev.w) || 1)
              const cropH = Math.round(Number(ev.h) || 1)
              const threshold = Number(ev.threshold) || 0.08
              const platform = (ev.platform as string) || 'h5'
              const scriptId = (ev.scriptId as string) || ''
              const createdBy = (ev.createdBy as string) || 'unknown'
              db.prepare(`
                INSERT INTO frontend_auto_baselines
                  (id, script_id, crop_id, name, platform, crop_x, crop_y, crop_w, crop_h, image_path, threshold, created_by, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(id, scriptId, id, name, platform, cropX, cropY, cropW, cropH, imagePath, threshold, createdBy, Date.now())
              sess.lastCrop = { id, name, imagePath, x: cropX, y: cropY, w: cropW, h: cropH, threshold }
              sess.cropPending = false
              sess.steps.push({
                name: `尋找 ${name}`,
                action: 'find_baseline_scroll',
                baselineId: id,
                threshold,
                scrollStep: 600,
                maxScrolls: 20,
              })
            } catch (err) {
              log('error', '-', '-', `UAT agent crop save error: ${String(err)}`)
            }
          })()
        } else if (ev.kind === 'done') {
          if (Array.isArray(ev.steps)) sess.steps = ev.steps
          sess.done = true
          if (agentId) {
            const info = agentConnections.get(agentId)
            if (info) { info.busy = false; info.sessionId = null }
          }
        } else if (ev.kind === 'error') {
          sess.done = true
          if (agentId) {
            const info = agentConnections.get(agentId)
            if (info) { info.busy = false; info.sessionId = null }
          }
        } else if (ev.kind === 'cdp_warn') {
          // CDP connection failed but Chrome is running — keep session alive
          // Frontend will see recPolling=true but steps won't be captured
          ;(sess as Record<string, unknown>).cdpWarning = ev.message
        }
        return
      }

      if (msg.type === 'uat_run_event') {
        const runMsg = msg as unknown as { type: string; runId: string; event: Record<string, unknown> }
        const ev = runMsg.event
        const runId = runMsg.runId
        if (!ev || !runId) return

        if (ev.kind === 'log') {
          void pushLog(runId, String(ev.line ?? ''))
        } else if (ev.kind === 'done') {
          const passed = Number(ev.passed ?? 0)
          const failed = Number(ev.failed ?? 0)
          const skipped = Number(ev.skipped ?? 0)
          const result = String(ev.result ?? 'fail')
          try {
            db.prepare('UPDATE frontend_auto_runs SET passed=?,failed=?,skipped=?,result=?,finished_at=? WHERE id=?')
              .run(passed, failed, skipped, result, Date.now(), runId)
          } catch {}
          activeRuns.delete(runId)
          const runSess = uatRunSessions.get(runId)
          if (runSess) {
            runSess.done = true
            uatRunSessions.delete(runId)
            const info = agentConnections.get(runSess.agentId)
            if (info) { info.busy = false; info.sessionId = null }
          }
        } else if (ev.kind === 'error') {
          void pushLog(runId, `❌ Agent 執行失敗：${String(ev.message ?? '')}`)
          activeRuns.delete(runId)
          const runSess = uatRunSessions.get(runId)
          if (runSess) {
            runSess.done = true
            uatRunSessions.delete(runId)
            const info = agentConnections.get(runSess.agentId)
            if (info) { info.busy = false; info.sessionId = null }
          }
          try { db.prepare("UPDATE frontend_auto_runs SET result='fail',finished_at=? WHERE id=?").run(Date.now(), runId) } catch {}
        }
        return
      }
    })

    ws.on('close', () => {
      if (agentId) {
        const info = agentConnections.get(agentId)
        if (info?.sessionId) {
          if (info.sessionId.startsWith('sb_')) {
            handleScriptedBetAgentDisconnect(info.sessionId, `Agent ${info.hostname} 已斷線`)
          } else {
            cancelDistSession(info.sessionId)
            broadcastToViewers({ type: 'error', message: `Agent ${info.hostname} 已斷線`, ts: new Date().toISOString() })
            activeRunners.delete(info.sessionId)
          }
        }
        agentConnections.delete(agentId)
        log('info', '-', '-', `Agent disconnected: ${agentId}`)
      }
    })
    return
  }

  ws.close(1008, 'Invalid path')
})
let isShuttingDown = false
function shutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[Worker] ${signal} received, shutting down`)
  server.close(() => {
    console.log('[Worker] closed')
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', err => {
  console.error('[Worker] uncaughtException:', err)
})
process.on('unhandledRejection', reason => {
  console.error('[Worker] unhandledRejection:', reason)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[Worker] toppath-worker listening on http://localhost:${port}`)
})




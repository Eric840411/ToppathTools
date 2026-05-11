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
import { larkGenerateSchema, log } from './shared.js'
import { runGenerateTestcasesFileJob, runLarkGenerateTestcasesJob, type WorkerUploadFile } from './routes/integrations.js'
import { router as jiraRouter } from './routes/jira.js'
import { router as gameshowRouter } from './routes/gameshow.js'
import { router as autospinRouter } from './routes/autospin.js'
import { router as osmUatRouter } from './routes/osm-uat.js'
import { router as frontendAutoRouter } from './routes/frontend-auto.js'
import { activeRunners, router as machineTestRouter } from './routes/machine-test.js'
import {
  viewerSockets,
  broadcastBuffer,
  agentConnections,
  claimJob,
  completeJob,
  getJobStatuses,
  cancelDistSession,
  broadcastToViewers,
  type AgentInfo,
} from './agent-hub.js'
import type { TestEvent } from './machine-test/types.js'
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

app.post('/internal/worker/testcase/file-generate', async (req, res) => {
  const payload = req.body as {
    files?: WorkerUploadFile[]
    oldFiles?: WorkerUploadFile[]
    form?: Record<string, unknown>
    clientIp?: string
    user?: string
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
      let msg: { type: string; agentId?: string; hostname?: string; sessionId?: string; event?: unknown; machineCode?: string; failed?: boolean }
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.type === 'agent_ready' && msg.agentId) {
        agentId = msg.agentId
        const info: AgentInfo = { ws, agentId, hostname: msg.hostname ?? agentId, busy: false, sessionId: null }
        agentConnections.set(agentId, info)
        log('info', '-', '-', `Agent connected: ${agentId} (${info.hostname})`)
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
    })

    ws.on('close', () => {
      if (agentId) {
        const info = agentConnections.get(agentId)
        if (info?.sessionId) {
          cancelDistSession(info.sessionId)
          broadcastToViewers({ type: 'error', message: `Agent ${info.hostname} 已斷線`, ts: new Date().toISOString() })
          activeRunners.delete(info.sessionId)
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




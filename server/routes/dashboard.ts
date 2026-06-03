import { cpus, freemem, totalmem } from 'os'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { getActiveAuthSessions, getAuthAccount } from '../auth-session.js'
import { db, getClientIP } from '../shared.js'

export const router = Router()

const PRESENCE_TTL_MS = 60 * 1000
const REQUEST_WINDOW_MS = 60 * 1000
const RECENT_EVENT_LIMIT = 30
const EXCLUDED_METRIC_PATHS = new Set([
  '/api/health',
  '/api/dashboard/heartbeat',
  '/api/dashboard/summary',
  '/api/worker/status',
  '/api/heavy-tasks/me',
])

type PresenceRecord = {
  userKey: string
  userLabel: string
  role: string
  page: string
  ip: string
  userAgent: string
  lastSeenAt: number
}

type RequestSample = {
  path: string
  method: string
  statusCode: number
  durationMs: number
  finishedAt: number
}

type DashboardEvent = {
  id: string
  type: 'login' | 'request-error' | 'worker' | 'task' | 'system'
  title: string
  detail: string
  level: 'info' | 'warn' | 'error' | 'success'
  createdAt: number
}

const presence = new Map<string, PresenceRecord>()
const requestSamples: RequestSample[] = []
const dashboardEvents: DashboardEvent[] = []
let activeShortRequests = 0   // normal HTTP requests (finish when response sent)
let activeLongConnections = 0 // SSE / streaming connections (finish when client disconnects)

/** @deprecated use activeShortRequests + activeLongConnections */
let activeRequests = 0

function now() {
  return Date.now()
}

function prunePresence(ts = now()) {
  for (const [key, value] of presence.entries()) {
    if (ts - value.lastSeenAt > PRESENCE_TTL_MS) presence.delete(key)
  }
}

function pruneRequestSamples(ts = now()) {
  while (requestSamples.length > 0 && ts - requestSamples[0].finishedAt > REQUEST_WINDOW_MS) {
    requestSamples.shift()
  }
}

function addEvent(event: Omit<DashboardEvent, 'id' | 'createdAt'> & { createdAt?: number }) {
  dashboardEvents.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: event.createdAt ?? now(),
    type: event.type,
    title: event.title,
    detail: event.detail,
    level: event.level,
  })
  if (dashboardEvents.length > RECENT_EVENT_LIMIT) dashboardEvents.length = RECENT_EVENT_LIMIT
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index]
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function memorySnapshot() {
  const mem = process.memoryUsage()
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    systemFree: freemem(),
    systemTotal: totalmem(),
    rssText: formatBytes(mem.rss),
    heapUsedText: formatBytes(mem.heapUsed),
    systemUsedText: formatBytes(totalmem() - freemem()),
    systemTotalText: formatBytes(totalmem()),
  }
}

function cpuSnapshot() {
  const cpuCount = cpus().length
  return {
    cpuCount,
  }
}

function workerUrl() {
  return (process.env.WORKER_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '')
}

async function fetchWorkerStatus() {
  const baseUrl = workerUrl()
  const started = now()
  try {
    const [healthResponse, tasksResponse] = await Promise.all([
      fetch(`${baseUrl}/internal/worker/health`, { signal: AbortSignal.timeout(1800) }),
      fetch(`${baseUrl}/internal/worker/tasks`, { signal: AbortSignal.timeout(1800) }),
    ])
    const worker = await healthResponse.json().catch(() => null)
    const tasks = await tasksResponse.json().catch(() => null)
    const connected = healthResponse.ok
    return {
      ok: connected,
      connected,
      workerUrl: baseUrl,
      latencyMs: now() - started,
      worker,
      tasks,
    }
  } catch (error) {
    return {
      ok: false,
      connected: false,
      workerUrl: baseUrl,
      latencyMs: now() - started,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export function dashboardMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/') || EXCLUDED_METRIC_PATHS.has(req.path)) {
    next()
    return
  }
  if (req.path.startsWith('/api/machine-test/osm-status')) {
    next()
    return
  }

  activeShortRequests += 1
  activeRequests = activeShortRequests + activeLongConnections
  const startedAt = now()
  let isLongConn = false
  let cleaned = false

  // Intercept writeHead to detect SSE connections by Content-Type header.
  // When the route sets Content-Type: text/event-stream and flushes headers,
  // reclassify this request from short to long-lived.
  const origWriteHead = res.writeHead.bind(res)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(res as any).writeHead = function (...args: Parameters<typeof origWriteHead>) {
    if (!isLongConn) {
      const ct = res.getHeader('content-type')
      if (typeof ct === 'string' && ct.includes('text/event-stream')) {
        isLongConn = true
        activeShortRequests = Math.max(0, activeShortRequests - 1)
        activeLongConnections += 1
        activeRequests = activeShortRequests + activeLongConnections
      }
    }
    return origWriteHead(...args)
  }

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (isLongConn) {
      activeLongConnections = Math.max(0, activeLongConnections - 1)
    } else {
      activeShortRequests = Math.max(0, activeShortRequests - 1)
    }
    activeRequests = activeShortRequests + activeLongConnections
    if (!isLongConn) {
      const finishedAt = now()
      requestSamples.push({
        path: req.path,
        method: req.method,
        statusCode: res.statusCode,
        durationMs: finishedAt - startedAt,
        finishedAt,
      })
      pruneRequestSamples(finishedAt)
      if (res.statusCode >= 500) {
        addEvent({
          type: 'request-error',
          level: 'error',
          title: `${req.method} ${req.path} failed`,
          detail: `HTTP ${res.statusCode}, ${finishedAt - startedAt} ms`,
        })
      }
    }
  }

  res.on('finish', cleanup)
  // 'close' fires when the socket closes without a clean finish (e.g. SSE client disconnects)
  res.on('close', cleanup)
  next()
}

router.post('/api/dashboard/heartbeat', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })
  const body = req.body as { page?: string }
  const userKey = account.email
  const previous = presence.get(userKey)
  const record: PresenceRecord = {
    userKey,
    userLabel: account.label,
    role: account.role,
    page: String(body?.page ?? '').trim() || 'Dashboard',
    ip: getClientIP(req),
    userAgent: String(req.headers['user-agent'] ?? ''),
    lastSeenAt: now(),
  }
  presence.set(userKey, record)
  if (!previous || now() - previous.lastSeenAt > PRESENCE_TTL_MS) {
    addEvent({
      type: 'login',
      level: 'info',
      title: `${account.label} 在線`,
      detail: `${record.page} · ${record.ip}`,
    })
  }
  prunePresence(record.lastSeenAt)
  res.json({ ok: true })
})

router.get('/api/dashboard/summary', async (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })

  const ts = now()
  prunePresence(ts)
  pruneRequestSamples(ts)

  const durations = requestSamples.map(s => s.durationMs)
  const errorsPerMinute = requestSamples.filter(s => s.statusCode >= 500).length
  const workerStatus = await fetchWorkerStatus()
  if (!workerStatus.connected) {
    addEvent({
      type: 'worker',
      level: 'warn',
      title: 'Worker 無法連線',
      detail: workerStatus.message ?? 'health check failed',
    })
  }

  const activeHeavyTasks = db.prepare("SELECT id, user_label, type, label, status, created_at, started_at FROM heavy_tasks WHERE status IN ('queued', 'running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at ASC LIMIT 20").all() as Array<{
    id: string
    user_label: string
    type: string
    label: string
    status: string
    created_at: number
    started_at: number | null
  }>

  const workerTasks = workerStatus.tasks as { running?: unknown[]; queued?: unknown[]; counts?: { running?: number; queued?: number; limiterQueued?: number } } | undefined
  const workerMemory = (workerStatus.worker as { memory?: { rss?: number; heapUsed?: number; heapTotal?: number; systemFree?: number; systemTotal?: number } } | undefined)?.memory

  res.json({
    ok: true,
    generatedAt: ts,
    limits: {
      users: 8,
      tasks: 5,
      events: 6,
    },
    totals: {
      onlineUsers: presence.size,
      activeSessions: getActiveAuthSessions().length,
      activeRequests: activeShortRequests,
      activeLongConnections,
      requestsPerMinute: requestSamples.length,
      errorsPerMinute,
      runningTasks: activeHeavyTasks.filter(t => t.status === 'running').length + (workerTasks?.counts?.running ?? 0),
      queuedTasks: activeHeavyTasks.filter(t => t.status === 'queued').length + (workerTasks?.counts?.queued ?? 0) + (workerTasks?.counts?.limiterQueued ?? 0),
    },
    requests: {
      averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      p95Ms: percentile(durations, 95),
    },
    server: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      memory: memorySnapshot(),
      cpu: cpuSnapshot(),
    },
    worker: {
      ...workerStatus,
      memoryText: workerMemory ? {
        rss: formatBytes(workerMemory.rss ?? 0),
        heapUsed: formatBytes(workerMemory.heapUsed ?? 0),
        systemUsed: formatBytes((workerMemory.systemTotal ?? 0) - (workerMemory.systemFree ?? 0)),
        systemTotal: formatBytes(workerMemory.systemTotal ?? 0),
      } : null,
    },
    users: [...presence.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 8),
    tasks: activeHeavyTasks.slice(0, 5),
    events: dashboardEvents.slice(0, 6),
  })
})

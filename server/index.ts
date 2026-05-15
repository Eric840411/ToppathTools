/**
 * server/index.ts
 * Express app entry point — sets up middleware, mounts route files, and starts the server.
 * All business logic lives in server/routes/*.ts and server/shared.ts.
 */
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { existsSync } from 'fs'
import { createServer } from 'http'
import { networkInterfaces } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { z } from 'zod'
import { WebSocket, WebSocketServer } from 'ws'

// Route files
import { router as jiraRouter } from './routes/jira.js'
import { router as geminiRouter } from './routes/gemini.js'
import { router as osmRouter, restartCron, activeCronTask } from './routes/osm.js'
import { router as authRouter } from './routes/auth.js'
import { router as permissionsRouter } from './routes/permissions.js'
import { router as workerStatusRouter } from './routes/worker-status.js'
import { router as frontendAutoRouter } from './routes/frontend-auto.js'
import { router as audioRouter } from './routes/audio.js'
import { router as scriptedBetRouter } from './routes/scripted-bet.js'
import { getRequestContext, runWithRequestContext } from './request-context.js'
import { getAuthAccount } from './auth-session.js'

// Shared logger
import { db, getClientIP, getUser, log } from './shared.js'

dotenv.config()

// ─── Global Error Capture ─────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] unhandledRejection:', reason)
})

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express()
const server = createServer(app)
const port = Number(process.env.PORT ?? 3000)

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
// tsx --watch sends SIGTERM on file change. Full cleanup ensures port is released
// before the new process starts, so EADDRINUSE never happens.
let isShuttingDown = false
const gracefulShutdown = (signal: string) => {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[Shutdown] ${signal} received`)

  // 1. Terminate all WebSocket clients
  console.log('[Shutdown] closing ws clients...')
  wss.clients.forEach(ws => ws.terminate())
  wss.close()

  // 2. Stop cron job
  console.log('[Shutdown] stopping cron...')
  activeCronTask?.stop()

  // 3. Destroy Discord bot connection
  console.log('[Shutdown] stopping discord bot...')
  stopDiscordBotRef?.()

  // 4. Close HTTP server — closeAllConnections() force-closes SSE & keep-alive
  console.log('[Shutdown] closing http server...')
  if (typeof (server as any).closeAllConnections === 'function') {
    ;(server as any).closeAllConnections()
  }
  server.close(() => {
    console.log('[Shutdown] server closed — exiting')
    process.exit(0)
  })

  // Force exit after 3s if server.close() hangs on any remaining connection
  setTimeout(() => {
    console.log('[Shutdown] force exit after 3s timeout')
    process.exit(0)
  }, 3000).unref()
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))
const serverStartedAt = Date.now()
const serverBootId = `${process.pid}-${serverStartedAt}`
let stopDiscordBotRef: (() => void) | null = null
let integrationsRouterPromise: Promise<express.Router> | null = null

function shouldProxyPathToWorker(p: string): boolean {
  if (p.startsWith('/api/gs/')) return true
  if (p.startsWith('/api/image-check/')) return true
  if (p.startsWith('/api/machine-test/')) return true
  if (p.startsWith('/api/local-agent/')) return true
  if (p.startsWith('/api/scripted-bet/')) return true
  if (p === '/api/settings/tunnel-url') return true
  if (p.startsWith('/api/osm-uat/')) return true
  if (p.startsWith('/api/autospin/')) return true
  if (p === '/api/jira/batch-create') return true
  if (p === '/api/jira/batch-comment') return true
  if (p === '/api/jira/batch-transition') return true
  if (p === '/api/jira/pm-batch-create') return true
  if (p === '/api/jira/batch-comment/stream') return true
  if (p.startsWith('/api/jira/batch-comment/status/')) return true
  return false
}

app.use(cors())
const jsonParser = express.json({ limit: '20mb' })
app.use((req, res, next) => {
  if (shouldProxyPathToWorker(req.path)) return next()
  return jsonParser(req, res, next)
})

// ─── Activity Logger Middleware ───────────────────────────────────────────────

function toDisplayName(rawUser: string, req: express.Request): string {
  const labeled = req.headers['x-user-label']
  if (typeof labeled === 'string' && labeled.trim()) return labeled.trim()
  if (rawUser && rawUser.includes('@')) {
    const row = db.prepare('SELECT label FROM jira_accounts WHERE email = ?').get(rawUser) as { label?: string } | undefined
    if (row?.label?.trim()) return row.label.trim()
    return rawUser.split('@')[0]
  }
  return rawUser === '—' ? '未登入使用者' : rawUser
}

function extractIssueKeys(req: express.Request): string[] {
  const body = req.body as {
    items?: Array<{ issueKey?: string }>
    rows?: Array<{ issueKey?: string }>
    comments?: Array<{ issueKey?: string }>
    issues?: Array<{ issueKey?: string }>
  } | undefined
  const fromItems = Array.isArray(body?.items) ? body.items.map(i => String(i.issueKey ?? '').trim()).filter(Boolean) : []
  const fromRows = Array.isArray(body?.rows) ? body.rows.map(i => String(i.issueKey ?? '').trim()).filter(Boolean) : []
  const fromComments = Array.isArray(body?.comments) ? body.comments.map(i => String(i.issueKey ?? '').trim()).filter(Boolean) : []
  const fromIssues = Array.isArray(body?.issues) ? body.issues.map(i => String(i.issueKey ?? '').trim()).filter(Boolean) : []
  return [...new Set([...fromItems, ...fromRows, ...fromComments, ...fromIssues])]
}

function buildOperationLabel(req: express.Request): string {
  const p = req.path
  if (p === '/api/integrations/lark/generate-testcases') return '生成 TestCase'
  if (p === '/api/integrations/generate-testcases-file') return '生成 TestCase（檔案）'
  if (p === '/api/gs/pdf-testcase') return 'Game Show：PDF TestCase 生成'
  if (p === '/api/osm/config-compare') return 'OSM Config AI 分析'
  if (p === '/api/jira/batch-comment') {
    const keys = extractIssueKeys(req)
    if (keys.length === 0) return 'Jira 批次評論'
    const lead = keys.slice(0, 3).join(', ')
    return `Jira 批次評論（${lead}${keys.length > 3 ? ` +${keys.length - 3}` : ''}）`
  }
  if (p === '/api/jira/batch-create') {
    const keys = extractIssueKeys(req)
    if (keys.length === 0) return 'Jira 批次開單'
    const lead = keys.slice(0, 3).join(', ')
    return `Jira 批次開單（${lead}${keys.length > 3 ? ` +${keys.length - 3}` : ''}）`
  }
  if (p === '/api/jira/batch-transition') {
    const keys = extractIssueKeys(req)
    if (keys.length === 0) return 'Jira 批次切換狀態'
    const lead = keys.slice(0, 3).join(', ')
    return `Jira 批次切換狀態（${lead}${keys.length > 3 ? ` +${keys.length - 3}` : ''}）`
  }
  return `${req.method} ${p}`
}

app.use((req, _res, next) => {
  const ip = getClientIP(req)
  const authAccount = getAuthAccount(req)
  const headerUser = getUser(req)
  const user = headerUser !== '—' ? headerUser : authAccount?.email ?? '—'
  const userDisplay = authAccount?.label ?? toDisplayName(user, req)
  const operation = buildOperationLabel(req)
  runWithRequestContext(
    { ip, user, userDisplay, path: req.path, method: req.method, operation },
    () => {
      if (req.path.startsWith('/api/') && !shouldSkipAccessLog(req)) {
        log('info', ip, user, `${req.method} ${req.path}`)
      }
      next()
    },
  )
})

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'workflow-integrator-api',
    startedAt: serverStartedAt,
    bootId: serverBootId,
  })
})

// ─── Mount Route Files ────────────────────────────────────────────────────────

function workerUrl() {
  return (process.env.WORKER_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '')
}

function shouldProxyToWorker(req: express.Request): boolean {
  return shouldProxyPathToWorker(req.path)
}

function shouldSkipAccessLog(req: express.Request): boolean {
  return req.path === '/api/machine-test/osm-status'
}

function shouldUseIntegrationsRouter(path: string): boolean {
  return path.startsWith('/api/integrations/')
    || path.startsWith('/api/google/')
    || path.startsWith('/api/sheets/')
    || path.startsWith('/api/url-pool/')
    || path.startsWith('/internal/testcase-jobs/')
}

async function lazyIntegrationsRouter(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!shouldUseIntegrationsRouter(req.path)) return next()
  try {
    integrationsRouterPromise ??= import('./routes/integrations.js').then(mod => mod.router)
    const router = await integrationsRouterPromise
    return router(req, res, next)
  } catch (error) {
    return next(error)
  }
}

async function proxyToWorker(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!shouldProxyToWorker(req)) return next()

  try {
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'connection' || lower === 'content-length' || lower === 'expect') continue
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    if (req.headers.host) headers.set('x-forwarded-host', req.headers.host)
    headers.set('x-forwarded-proto', req.protocol)
    const ctx = getRequestContext()
    if (ctx?.user && ctx.user !== '—') headers.set('x-auth-user', ctx.user)
    if (ctx?.userDisplay && ctx.userDisplay !== '未登入使用者') headers.set('x-user-label', ctx.userDisplay)

    const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const contentType = req.headers['content-type'] ?? ''
      if (typeof contentType === 'string' && contentType.includes('application/json') && req.body !== undefined) {
        headers.set('content-type', 'application/json')
        init.body = JSON.stringify(req.body ?? {})
      } else {
        init.body = req as any
        init.duplex = 'half'
      }
    }

    const response = await fetch(`${workerUrl()}${req.originalUrl}`, init)
    res.status(response.status)
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'transfer-encoding') res.setHeader(key, value)
    })
    if (!response.body) return res.end()
    Readable.fromWeb(response.body as any).pipe(res)
  } catch (error) {
    next(error)
  }
}

app.use(proxyToWorker)

app.use(jiraRouter)
app.use(geminiRouter)
app.use(osmRouter)
app.use(lazyIntegrationsRouter)
app.use(authRouter)
app.use(permissionsRouter)
app.use(workerStatusRouter)
app.use(frontendAutoRouter)
app.use(audioRouter)
app.use(scriptedBetRouter)

// ─── Static Files (production build) ──────────────────────────────────────────

{
  const distDir = join(process.cwd(), 'dist')
  const indexHtml = join(distDir, 'index.html')
  if (existsSync(indexHtml)) {
    app.use(express.static(distDir))
    app.get(/.*/, (_req, res) => res.sendFile(indexHtml))
  }
}

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use(
  (error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      log('warn', getClientIP(req), getUser(req), `Validation error @ ${req.method} ${req.path}`, error.issues.map(i => i.message).join('; '))
      return res.status(400).json({ ok: false, message: 'Validation error', details: error.issues })
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    log('error', getClientIP(req), getUser(req), `Unhandled error @ ${req.method} ${req.path}`, message)
    console.error(`[Error] ${req.method} ${req.path}`, error)
    return res.status(500).json({ ok: false, message })
  },
)

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server })

// ws forwards HTTP server errors — must handle to prevent unhandled 'error' crash
wss.on('error', () => { /* handled by server.on('error') above */ })

function shouldProxyWsToWorker(path: string): boolean {
  return path === '/ws/machine-test/events' || path === '/ws/agent'
}

function proxyWsToWorker(clientWs: WebSocket, req: import('http').IncomingMessage, path: string) {
  const targetBase = workerUrl().replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  const targetWs = new WebSocket(`${targetBase}${req.url ?? path}`, {
    headers: {
      'x-forwarded-host': req.headers.host ?? '',
      'x-forwarded-proto': 'http',
    },
  })
  const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = []
  let clientClosed = false

  clientWs.on('message', (data, isBinary) => {
    if (targetWs.readyState === WebSocket.OPEN) targetWs.send(data, { binary: isBinary })
    else pending.push({ data, isBinary })
  })
  targetWs.on('open', () => {
    if (clientClosed) {
      targetWs.terminate()
      return
    }
    for (const item of pending.splice(0)) targetWs.send(item.data, { binary: item.isBinary })
  })
  targetWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary })
  })
  targetWs.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      clientWs.close(code, reason)
    }
  })
  clientWs.on('close', (code, reason) => {
    clientClosed = true
    pending.length = 0
    if (targetWs.readyState !== WebSocket.CLOSED) {
      targetWs.terminate()
    }
  })
  targetWs.on('error', () => {
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      clientWs.close(1011, 'Worker websocket error')
    }
  })
}

wss.on('connection', (ws, req) => {
  const path = req.url?.split('?')[0] ?? ''
  if (shouldProxyWsToWorker(path)) {
    proxyWsToWorker(ws, req, path)
    return
  }

  ws.close(1008, 'Invalid path')
})

// EADDRINUSE: the old process is still shutting down — wait and retry.
// Port cleanup is the old process's responsibility (gracefulShutdown above).
// We no longer kill the port here; that caused race conditions in dev.
let eaddrinuseRetries = 0
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    eaddrinuseRetries++
    if (eaddrinuseRetries > 8) {
      console.error(`[API] Port ${port} still in use after ${eaddrinuseRetries} retries, giving up.`)
      process.exit(1)
    }
    console.error(`[API] Port ${port} in use, retrying in 1s... (${eaddrinuseRetries}/8)`)
    setTimeout(() => server.listen(port, '0.0.0.0'), 1000)
  } else {
    console.error('[API] Server error:', err)
  }
})

server.listen(port, '0.0.0.0', () => {
  const nets = networkInterfaces()
  const localIPs: string[] = []
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) localIPs.push(iface.address)
    }
  }
  console.log('\n  API server ready\n')
  console.log(`  Local:   http://localhost:${port}`)
  localIPs.forEach((ip) => console.log(`  Network: http://${ip}:${port}`))
  console.log()

  // 啟動定時告警
  restartCron()

  // 啟動 Discord Bot
  if (process.env.DISCORD_BOT_TOKEN) {
    import('./discord-bot.js')
      .then(({ startDiscordBot, stopDiscordBot }) => {
        stopDiscordBotRef = stopDiscordBot
        startDiscordBot()
      })
      .catch((error) => console.error('[Discord] lazy load failed:', error))
  }
})



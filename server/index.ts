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
import { z } from 'zod'
import { WebSocketServer } from 'ws'
import { startDiscordBot, stopDiscordBot } from './discord-bot.js'

// Route files
import { router as jiraRouter } from './routes/jira.js'
import { router as geminiRouter } from './routes/gemini.js'
import { router as osmRouter, restartCron, activeCronTask } from './routes/osm.js'
import { router as integrationsRouter } from './routes/integrations.js'
import { router as machineTestRouter, osmMachineStatus, activeRunners } from './routes/machine-test.js'
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
import { router as gameshowRouter } from './routes/gameshow.js'
import { router as autospinRouter } from './routes/autospin.js'
import { router as osmUatRouter } from './routes/osm-uat.js'
import { runWithRequestContext } from './request-context.js'

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

  // 2. Stop active machine-test runners
  for (const runner of activeRunners.values()) {
    try { runner.stop() } catch {}
  }
  activeRunners.clear()

  // 3. Stop cron job
  console.log('[Shutdown] stopping cron...')
  activeCronTask?.stop()

  // 4. Destroy Discord bot connection
  console.log('[Shutdown] stopping discord bot...')
  stopDiscordBot()

  // 5. Close HTTP server — closeAllConnections() force-closes SSE & keep-alive
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

app.use(cors())
app.use(express.json({ limit: '20mb' }))

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
  const user = getUser(req)
  const userDisplay = toDisplayName(user, req)
  const operation = buildOperationLabel(req)
  runWithRequestContext(
    { ip, user, userDisplay, path: req.path, method: req.method, operation },
    () => {
      if (req.path.startsWith('/api/')) {
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

app.use(jiraRouter)
app.use(geminiRouter)
app.use(osmRouter)
app.use(integrationsRouter)
app.use(machineTestRouter)
app.use(gameshowRouter)
app.use(autospinRouter)
app.use(osmUatRouter)

// Export osmMachineStatus so discord-bot can read machine statuses if needed
export { osmMachineStatus }

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

wss.on('connection', (ws, req) => {
  const path = req.url?.split('?')[0] ?? ''

  // ── Viewer: browser clients watching test progress ──────────────────────────
  if (path === '/ws/machine-test/events') {
    viewerSockets.add(ws)
    // Replay buffered events so late-joining viewers catch up
    for (const ev of broadcastBuffer) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev))
    }
    ws.on('close', () => viewerSockets.delete(ws))
    return
  }

  // ── Agent: worker machines running Playwright ────────────────────────────────
  if (path === '/ws/agent') {
    let agentId = ''

    ws.on('message', (raw) => {
      let msg: { type: string; agentId?: string; hostname?: string; sessionId?: string; event?: unknown; machineCode?: string; failed?: boolean }
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.type === 'agent_ready' && msg.agentId) {
        agentId = msg.agentId
        const info: AgentInfo = { ws: ws as unknown as import('ws').WebSocket, agentId, hostname: msg.hostname ?? agentId, busy: false, sessionId: null }
        agentConnections.set(agentId, info)
        log('info', '-', '-', `Agent connected: ${agentId} (${info.hostname})`)
        return
      }

      if (msg.type === 'event' && msg.sessionId && msg.event) {
        // Inject agent hostname so viewers know which machine produced this log
        const ev = msg.event as import('./machine-test/types.js').TestEvent
        if (agentId) {
          const info = agentConnections.get(agentId)
          ev.agentHostname = info?.hostname ?? agentId
        }
        broadcastToViewers(ev)
        return
      }

      // Work-stealing: agent requests next machine to test
      if (msg.type === 'claim_job' && msg.sessionId) {
        const code = claimJob(msg.sessionId, agentId)
        const statuses = getJobStatuses(msg.sessionId)
        if (statuses) broadcastToViewers({ type: 'queue_update', statuses, message: '', ts: new Date().toISOString() })
        if (code) {
          ws.send(JSON.stringify({ type: 'job_assigned', machineCode: code }))
        } else {
          ws.send(JSON.stringify({ type: 'no_more_jobs' }))
        }
        return
      }

      // Work-stealing: agent reports a machine test result
      if (msg.type === 'job_done' && msg.sessionId && msg.machineCode) {
        const allDone = completeJob(msg.sessionId, msg.machineCode, msg.failed ?? false)
        const statuses = getJobStatuses(msg.sessionId)
        if (statuses) broadcastToViewers({ type: 'queue_update', statuses, message: '', ts: new Date().toISOString() })
        if (allDone) {
          broadcastToViewers({ type: 'session_done', message: '所有機台測試完成', ts: new Date().toISOString() })
          activeRunners.delete(msg.sessionId)
        }
        return
      }

      // Agent finished its claim-loop (got no_more_jobs) — mark as available
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
          // Agent disconnected mid-session — cancel its portion
          cancelDistSession(info.sessionId)
          broadcastToViewers({ type: 'error', message: `Agent ${info.hostname} 連線中斷`, ts: new Date().toISOString() })
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

// ─── Start ────────────────────────────────────────────────────────────────────

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
  startDiscordBot()
})

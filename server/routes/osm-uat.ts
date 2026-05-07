/**
 * server/routes/osm-uat.ts
 * OSM UAT TC 自動化測試路由
 * POST /api/osm-uat/run    — 啟動測試（SSE 推進度）
 * POST /api/osm-uat/stop   — 停止測試
 * GET  /api/osm-uat/status — 查詢目前狀態
 * GET  /api/osm-uat/scan   — 掃描 Lark Bitable TC 數量摘要
 */
import { Router } from 'express'
import { spawn, ChildProcess } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { getLarkToken } from '../shared.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const router = Router()

// ─── Session State ─────────────────────────────────────────────────────────────

interface UatSession {
  status: 'idle' | 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  logs: string[]
  process: ChildProcess | null
  heavyTask?: HeavyTaskToken
}

let session: UatSession = {
  status: 'idle',
  startedAt: 0,
  logs: [],
  process: null,
}

// SSE clients
const sseClients = new Set<import('express').Response>()

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    res.write(payload)
  }
}

function appendLog(line: string) {
  session.logs.push(line)
  broadcast('log', { line })
}

// ─── SSE 訂閱 ──────────────────────────────────────────────────────────────────

router.get('/api/osm-uat/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // 送歷史 log 給新連線
  for (const line of session.logs) {
    res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`)
  }
  // 送目前狀態
  res.write(`event: status\ndata: ${JSON.stringify({ status: session.status })}\n\n`)

  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

// ─── 查詢狀態 ──────────────────────────────────────────────────────────────────

router.get('/api/osm-uat/status', (_req, res) => {
  res.json({
    status: session.status,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    logCount: session.logs.length,
  })
})

// ─── 掃描 TC 數量 ──────────────────────────────────────────────────────────────

router.get('/api/osm-uat/scan', async (req, res, next) => {
  try {
    const larkUrl = (req.query.larkUrl as string) || ''
    const params = parseLarkBitableUrl(larkUrl)
    if (!params) {
      res.status(400).json({ ok: false, error: '無效的 Lark Bitable URL' })
      return
    }

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const { appToken, tableId } = params

    // Fetch all records with pagination
    const allRecords: Array<Record<string, unknown>> = []
    let pageToken: string | undefined
    do {
      const url = `${base}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json() as { data?: { items?: Array<{ fields: Record<string, unknown> }>; page_token?: string; has_more?: boolean } }
      const items = data.data?.items ?? []
      allRecords.push(...items.map(i => i.fields))
      pageToken = data.data?.has_more ? data.data.page_token : undefined
    } while (pageToken)

    // Group by 任務子類型 (subtype), fallback to 任務類型 (type)
    const counts = new Map<string, number>()
    for (const f of allRecords) {
      const key = String(f['任務子類型'] || f['任務類型'] || '未分類')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const groups = Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-TW'))
      .map(([name, count]) => ({ name, count }))

    res.json({ ok: true, total: allRecords.length, groups })
  } catch (err) {
    next(err)
  }
})

// ─── 啟動測試 ──────────────────────────────────────────────────────────────────

const SCRIPT_PATH = 'C:\\Users\\user\\Desktop\\osm-qa-agent\\run-lark-tc-backend.js'

const runSchema = z.object({
  larkUrl: z.string().min(1),
  filter: z.string().optional(),
  dashGameType: z.string().optional(),
  dashClientVersion: z.string().optional(),
})

function parseLarkBitableUrl(url: string): { appToken: string; tableId: string } | null {
  try {
    const u = new URL(url)
    // Path: /base/{APP_TOKEN}
    const pathMatch = u.pathname.match(/\/base\/([^/?#]+)/)
    const appToken = pathMatch?.[1]
    // Query: ?table={TABLE_ID}
    const tableId = u.searchParams.get('table')
    if (!appToken || !tableId) return null
    return { appToken, tableId }
  } catch {
    return null
  }
}

router.post('/api/osm-uat/run', (req, res) => {
  // Check if the process is actually still alive (not just session.status)
  // because frontend may detect completion from log before child process fully exits
  const processAlive = session.process !== null && session.process.exitCode === null
  if (processAlive) {
    res.status(409).json({ ok: false, error: '測試已在執行中' })
    return
  }

  const parsed = runSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }

  const { larkUrl, filter, dashGameType, dashClientVersion } = parsed.data
  const larkParams = parseLarkBitableUrl(larkUrl)
  if (!larkParams) {
    res.status(400).json({ ok: false, error: '無效的 Lark Bitable URL（需包含 /base/{token} 和 ?table={id}）' })
    return
  }

  const heavyTask = tryStartHeavyTask(req, 'osm-uat', 'OSM UAT 自動化測試')
  if (!heavyTask.ok) {
    res.status(429).json(heavyTaskConflict(heavyTask.task))
    return
  }

  // 清除舊 log
  session = {
    status: 'running',
    startedAt: Date.now(),
    logs: [],
    process: null,
    heavyTask: heavyTask.token,
  }
  broadcast('status', { status: 'running' })

  const args = [SCRIPT_PATH]
  if (filter) args.push(filter)

  const child = spawn('node', args, {
    cwd: dirname(SCRIPT_PATH),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      LARK_APP_TOKEN: larkParams.appToken,
      LARK_TABLE_ID: larkParams.tableId,
      ...(dashGameType ? { DASH_GAME_TYPE: dashGameType } : {}),
      ...(dashClientVersion ? { DASH_CLIENT_VERSION: dashClientVersion } : {}),
    },
    windowsHide: true,
  })

  session.process = child

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString()
    text.split('\n').forEach(line => {
      if (line.trim()) appendLog(line)
    })
  })

  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString()
    text.split('\n').forEach(line => {
      if (line.trim()) appendLog(`❌ [stderr] ${line}`)
    })
  })

  child.on('close', (code) => {
    session.status = code === 0 ? 'done' : 'error'
    session.finishedAt = Date.now()
    session.process = null
    finishHeavyTask(session.heavyTask)
    appendLog(`--- 執行結束（exit code: ${code}）---`)
    broadcast('status', { status: session.status, exitCode: code })
    // 送完最終狀態後關閉所有 SSE 連線，讓 client 乾淨地結束
    setTimeout(() => {
      for (const res of sseClients) {
        try { res.end() } catch {}
      }
      sseClients.clear()
    }, 500)
  })

  child.on('error', (err) => {
    session.status = 'error'
    session.finishedAt = Date.now()
    session.process = null
    finishHeavyTask(session.heavyTask)
    broadcast('status', { status: 'error', error: err.message })
    appendLog(`❌ 啟動失敗: ${err.message}`)
  })

  res.json({ ok: true })
})

// ─── 停止測試 ──────────────────────────────────────────────────────────────────

router.post('/api/osm-uat/stop', (_req, res) => {
  if (session.status !== 'running' || !session.process) {
    res.status(400).json({ ok: false, error: '目前沒有執行中的測試' })
    return
  }
  session.process.kill('SIGTERM')
  finishHeavyTask(session.heavyTask)
  appendLog('🛑 已手動停止測試')
  res.json({ ok: true })
})

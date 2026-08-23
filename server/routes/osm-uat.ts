/**
 * server/routes/osm-uat.ts
 * OSM UAT TC 自動化測試路由
 * GET  /api/osm-uat/agents — 列出可派工的 Local Agent
 * POST /api/osm-uat/run    — 啟動測試（SSE 推進度）
 * POST /api/osm-uat/stop   — 停止測試
 * GET  /api/osm-uat/status — 查詢目前狀態
 * GET  /api/osm-uat/scan   — 掃描 Lark Bitable TC 數量摘要
 *
 * 執行有兩種模式（2026-08-21 起）：
 *   agent  — 派工給有 backend-uat capability 的 Local Agent，Playwright 真正跑在
 *            agent 端；server 只負責建 session、挑 agent、把 log 轉進既有的 SSE。
 *   server — 舊行為，直接在 server 本機 spawn 腳本。保留當 fallback。
 * 這支 router 掛在 worker process（見 server/worker.ts），跟 /ws/agent 的連線是
 * 同一個 process，所以可以直接拿 agentConnections 發訊息，不用再跨 process 轉一手。
 */
import { Router } from 'express'
import { spawn, ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { agentConnections, type AgentInfo } from '../agent-hub.js'
import { getOperatorFromContext } from '../request-context.js'
import { parseStatsLine } from '../uat-runner/net-capture.js'
import { BLOCK_DEFS } from '../uat-runner/block-engine.js'
import { backendRecorderScript, RECORDER_MARKER, eventsToSteps, hasAssertion } from '../uat-runner/backend-recorder.js'
import { readFileSync as fsReadFileSync } from 'fs'
import {
  getLarkToken,
  writeLimiter,
  listUatBackendCredentials,
  getUatBackendCredentials,
  listUatTcSteps,
  getUatTcSteps,
  saveUatTcSteps,
  saveUatBackendCredential,
  UAT_BACKEND_PROFILES,
  type UatBackendProfile,
} from '../shared.js'
import { getAuthAccount } from '../auth-session.js'
import type { Request } from 'express'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const router = Router()

// ─── Session State ─────────────────────────────────────────────────────────────

interface UatSession {
  id: string
  status: 'idle' | 'running' | 'done' | 'error'
  /** agent = Playwright 跑在 Local Agent 上；server = 在本機 spawn（fallback）*/
  mode: 'agent' | 'server'
  agentId?: string
  agentHostname?: string
  startedAt: number
  finishedAt?: number
  logs: string[]
  process: ChildProcess | null
  heavyTask?: HeavyTaskToken
  /**
   * 這次執行用到的密碼，只留在記憶體裡供 log redaction 比對用。
   * 絕對不進 session.logs / SSE / 歷史紀錄——agent 端已經遮一次，這是第二層
   * （Playwright 例外堆疊、腳本自己 print env 都可能把密碼漏出來）。
   */
  secrets: string[]
  /** 最後一份網路量測快照。SSE 是「接上之後才收得到」，中途才開面板的人
   *  沒有這個就會一片空白到下一次 2 秒廣播為止 */
  stats?: unknown
}

function emptySession(): UatSession {
  return { id: '', status: 'idle', mode: 'server', startedAt: 0, logs: [], process: null, secrets: [], stats: undefined }
}

let session: UatSession = emptySession()

// SSE clients
const sseClients = new Set<import('express').Response>()

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    res.write(payload)
  }
}

/**
 * 把這次執行用到的密碼從 log 行裡遮掉。agent 端送出前已經遮過一次，
 * 這是 server 端第二層——兩邊都做是因為漏一次就永久寫進 session.logs，
 * 而 log 會被 SSE 推給所有訂閱者。空字串不比對（會把整行切碎）。
 */
function redactSecrets(line: string): string {
  let out = line
  for (const secret of session.secrets) {
    if (secret.length < 4) continue // 太短的字串到處都會誤中
    out = out.split(secret).join('***')
  }
  return out
}

/**
 * runner 的 stdout 是日誌與結構化快照共用的一條通道，用行前綴區分（見 net-capture.js）。
 * 統計行要在這裡就攔掉：它是資料不是日誌，混進 session.logs 會把執行日誌洗版，
 * 而且面板也拿不到——面板聽的是另一個 SSE event。
 * 回傳 true 代表這行已被當成統計處理掉，呼叫端不要再當日誌記。
 */
function captureStatsLine(rawLine: string): boolean {
  const stats = parseStatsLine(rawLine)
  if (!stats) return false
  session.stats = stats
  broadcast('stats', stats)
  return true
}

function appendLog(rawLine: string) {
  if (captureStatsLine(rawLine)) return
  const line = redactSecrets(rawLine)
  session.logs.push(line)
  broadcast('log', { line })
}

// ─── SSE 訂閱 ──────────────────────────────────────────────────────────────────

/**
 * 把發動者自己的後台帳密轉成環境變數格式；沒設定就是空物件，讓腳本走原本的 fallback。
 * 伺服器端模式直接當 spawn 的 env；agent 模式原封不動放進 backend_uat_start 的 payload，
 * 由 agent 端在自己那邊 spawn 時注入。兩邊用同一組 key，腳本不用分辨自己被誰啟動。
 *
 * ⚠️ agent 模式代表這組帳密會走 /ws/agent 這條線離開本機。目前 CENTRAL_URL 預設是
 * ws://（明文），所以這是「延續既有明文通道」而不是安全完成態——hub 換 wss 之前，
 * 這條路徑跟 v4.22.0 把帳密移進 DB 的保護是有落差的。詳見 docs/decisions.md。
 */
function uatCredEnv(req: Request): Record<string, string> {
  const account = getAuthAccount(req)
  if (!account) return {}
  const creds = getUatBackendCredentials(account.email)
  const env: Record<string, string> = {}
  if (creds.cpBackend) { env.UAT_CP_USERNAME = creds.cpBackend.username; env.UAT_CP_PASSWORD = creds.cpBackend.password }
  if (creds.nchBackend) { env.UAT_NCH_USERNAME = creds.nchBackend.username; env.UAT_NCH_PASSWORD = creds.nchBackend.password }
  return env
}

/** 從 cred env 取出密碼，給 log redaction 當比對用；只留在記憶體 */
function secretsFromCredEnv(env: Record<string, string>): string[] {
  return [env.UAT_CP_PASSWORD, env.UAT_NCH_PASSWORD].filter((v): v is string => !!v && v.length > 0)
}

// ─── 後台測試帳密（依登入帳號各存一份）─────────────────────────────────
// 密碼只進得去、出不來：GET 只回 hasPassword，PUT 留空代表沿用舊密碼。
// 真實帳密以前躺在 server/uat-runner/config/backend-test-params.json（已加進 .gitignore）。
router.get('/api/osm-uat/backend-credentials', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  res.json({ ok: true, credentials: listUatBackendCredentials(account.email) })
})

router.put('/api/osm-uat/backend-credentials', writeLimiter, (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  const parsed = z.object({
    profile: z.enum([UAT_BACKEND_PROFILES[0], ...UAT_BACKEND_PROFILES.slice(1)] as [string, ...string[]]),
    username: z.string().trim().min(1).max(100),
    password: z.string().max(200).optional(),
  }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, message: '參數格式錯誤' })
  saveUatBackendCredential(account.email, parsed.data.profile as UatBackendProfile, parsed.data.username, parsed.data.password ?? '')
  res.json({ ok: true, credentials: listUatBackendCredentials(account.email) })
})
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
  // 中途才開面板的人要看得到目前的量測數字，不然會空白到下一次 2 秒廣播
  if (session.stats) {
    res.write(`event: stats\ndata: ${JSON.stringify(session.stats)}\n\n`)
  }

  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

// ─── 查詢狀態 ──────────────────────────────────────────────────────────────────

router.get('/api/osm-uat/status', (_req, res) => {
  res.json({
    status: session.status,
    sessionId: session.id || undefined,
    mode: session.status === 'idle' ? undefined : session.mode,
    agentId: session.agentId,
    agentHostname: session.agentHostname,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    logCount: session.logs.length,
  })
})

// ─── 可派工的 Agent 清單 ───────────────────────────────────────────────────────
// 只列出「這個操作者自己的」agent，跟 scripted-bet / autospin 同一套規則：
// agent 是誰安裝的就只有誰能派工，不共用。
router.get('/api/osm-uat/agents', (_req, res) => {
  const operator = getOperatorFromContext()
  if (!operator?.key) return res.json({ ok: true, agents: [], outdated: 0 })
  const mine = [...agentConnections.values()].filter(agent => agent.ownerKey === operator.key)
  // 有連線但缺 capability 是最常見的情況（agent 還跑著舊版 agent-runner.ts，
  // 或舊版 start.command 把 capability 清單寫死了）。前端要能講出這件事，
  // 不然畫面只顯示「目前沒有」，使用者看著明明連上的 agent 完全無從判斷。
  const outdated = mine.filter(agent => !agent.capabilities.includes(BACKEND_UAT_CAPABILITY)).length
  const agents = mine
    .filter(agent => agent.capabilities.includes(BACKEND_UAT_CAPABILITY))
    .map(agent => ({
      agentId: agent.agentId,
      hostname: agent.hostname,
      ownerName: agent.ownerName,
      capabilities: agent.capabilities,
      busy: agent.busy,
      connectedAt: agent.connectedAt,
      lastSeenAt: agent.lastSeenAt,
      sessionId: agent.sessionId,
    }))
  res.json({ ok: true, agents, outdated })
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
      const data = await r.json() as { data?: { items?: Array<{ record_id?: string; fields: Record<string, unknown> }>; page_token?: string; has_more?: boolean } }
      const items = data.data?.items ?? []
      // 連 record_id 一起留著：積木是掛在「單筆 TC」上的，只有分類統計的話
      // 前端根本指不出要編哪一筆
      allRecords.push(...items.map(i => ({ ...i.fields, __recordId: i.record_id })))
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

    // 逐筆 TC：前端用它列出「這個模組收到哪幾筆」，點進去才有東西可以編積木。
    // text 取的是 TC 描述欄位；registry 那邊是用 record_id 當 key，兩邊要對得起來。
    const registry = readRegistryFile()
    const savedSteps = listUatTcSteps()
    const tcs = allRecords.map(f => {
      const recordId = String(f.__recordId ?? '')
      const entry = registry[recordId] as { verifierName?: string } | undefined
      return {
        recordId,
        text: String(f['測試項目'] ?? f['任務描述'] ?? f['描述'] ?? f['內容'] ?? '').slice(0, 300),
        sub: String(f['任務子類型'] ?? ''),
        taskType: String(f['任務類型'] ?? ''),
        stepCount: savedSteps[recordId]?.length ?? 0,
        verifierName: entry?.verifierName ?? null,
        source: 'live' as const,
      }
    }).filter(t => t.recordId)

    res.json({ ok: true, total: allRecords.length, groups, tcs })
  } catch (err) {
    next(err)
  }
})

// ─── 啟動測試 ──────────────────────────────────────────────────────────────────

const SCRIPT_PATH = process.env.OSM_QA_AGENT_SCRIPT
  ?? join(__dirname, '..', 'uat-runner', 'run-lark-tc-backend.js')

/** agent 端要有這個 capability 才收得到 backend_uat_start */
/** 錄製時要連的後台，跟 run-lark-tc-backend.js 的 BACKEND_URL 同一個環境。
 *  兩邊各有一份是因為 runner 是獨立 spawn 的程序，共用不了模組層級的常數。 */
const BACKEND_URL_FOR_RECORD = process.env.UAT_BACKEND_URL ?? 'http://uat-cp.osmslot.org'

export const BACKEND_UAT_CAPABILITY = 'backend-uat'
/** 前端用這個值明確要求走舊的伺服器端 spawn */
const SERVER_MODE_SENTINEL = 'server'

const modulePlanSchema = z.object({
  instanceId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  filters: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
})

const runSchema = z.object({
  larkUrl: z.string().min(1),
  /** 指定 agentId 派工；傳 'server' 代表明確要走伺服器端 spawn；不傳＝自動挑一台，沒有才 fallback */
  agentId: z.string().trim().max(120).optional(),
  filter: z.string().optional(),
  dashGameType: z.string().optional(),
  dashClientVersion: z.string().optional(),
  modulePlan: z.array(modulePlanSchema).min(1).max(40).superRefine((modules, context) => {
    const ids = new Set<string>()
    modules.forEach((module, index) => {
      if (ids.has(module.instanceId)) context.addIssue({ code: 'custom', path: [index, 'instanceId'], message: '模組 ID 不可重複' })
      ids.add(module.instanceId)
    })
  }).optional(),
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

function isSessionAlive(): boolean {
  if (session.status !== 'running') return false
  if (session.mode === 'server') return session.process !== null && session.process.exitCode === null
  // agent 模式：agent 斷線就當作沒在跑，否則 agent 拔網路線會把使用者永久鎖在 409
  const agent = session.agentId ? agentConnections.get(session.agentId) : undefined
  return !!agent && agent.ws.readyState === agent.ws.OPEN
}

/** 收尾：釋放重任務名額、通知 SSE、把 agent 標回空閒 */
function finishSession(status: 'done' | 'error', tailLine: string, extra: Record<string, unknown> = {}) {
  session.status = status
  session.finishedAt = Date.now()
  session.process = null
  finishHeavyTask(session.heavyTask)
  if (session.agentId) {
    const agent = agentConnections.get(session.agentId)
    if (agent && agent.sessionId === session.id) { agent.busy = false; agent.sessionId = null }
  }
  appendLog(tailLine)
  broadcast('status', { status, ...extra })
  // 送完最終狀態後關閉所有 SSE 連線，讓 client 乾淨地結束
  setTimeout(() => {
    for (const client of sseClients) {
      try { client.end() } catch { /* SSE client already disconnected */ }
    }
    sseClients.clear()
  }, 500)
}

// ─── Agent 回報（由 worker.ts 的 /ws/agent 收到訊息後呼叫）────────────────────

/** agent 端 spawn 的腳本每印一行就轉一次；sessionId 對不上代表是上一輪的殘留，直接丟掉 */
export function handleBackendUatAgentLog(sessionId: string, line: string, stream: 'stdout' | 'stderr') {
  if (!session.id || session.id !== sessionId) return
  appendLog(stream === 'stderr' ? `❌ [stderr] ${line}` : line)
}

/** agent 端腳本結束 */
export function handleBackendUatAgentDone(sessionId: string, exitCode: number | null, error?: string) {
  if (!session.id || session.id !== sessionId) return
  if (error) appendLog(`❌ Agent 執行失敗: ${error}`)
  finishSession(exitCode === 0 ? 'done' : 'error', `--- 執行結束（exit code: ${exitCode}）---`, { exitCode })
}

/**
 * agent 在測試途中斷線：不會有 done 訊息了，主動收尾避免 session 永遠卡在 running。
 * 回傳 true 代表這次斷線是這個 UAT session 的，worker 就不要再往 machine-test
 * 那條路徑處理（那邊會誤呼叫 cancelDistSession 並廣播機測錯誤）。
 */
export function handleBackendUatAgentDisconnect(agentId: string): boolean {
  if (session.status !== 'running' || session.mode !== 'agent' || session.agentId !== agentId) return false
  finishSession('error', '--- 執行結束（Agent 連線中斷）---', { error: 'agent disconnected' })
  return true
}

// ─── 啟動 ─────────────────────────────────────────────────────────────────────

// ─── TC 積木 ─────────────────────────────────────────────────────────────────
// 積木存在 DB（uat_tc_steps），**不是**存回 tc-registry.json——那個檔案在 runtime
// 是 dist-server/ 底下的建置產物，npm run build 會整個刪掉重建，寫回去等於使用者
// 編好的積木下次部署就消失（第一版這樣寫，測試時才發現）。
// registry 檔案繼續當「出廠預設的路由表」，唯讀，只拿 verifierName 來顯示。

function readRegistryFile(): Record<string, unknown> {
  try {
    const raw = fsReadFileSync(join(__dirname, '..', 'uat-runner', 'tc-registry.json'), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

// 積木是掛在單筆 TC 上的，存在 runner 讀的同一份 registry；前端改完就是改那個檔案，
// 下一次 spawn 的 runner 直接讀得到（runner 是每次執行才啟動，不是常駐）。

/**
 * 離線 TC 清單：直接讀 registry 快照，不用先掃描 Lark。
 *
 * 編輯積木需要的東西（recordId／文字／子類型）快照裡本來就有，沒有理由讓人
 * 先等一次 Lark 往返才開始編。掃描的價值在於「補上快照之後新增的 TC、並確認
 * 文字有沒有漂移」，所以掃描變成重新整理，不是進場門檻。
 *
 * source 要誠實標出來：`registry` 代表這筆只在 8/6 那份快照裡看過，
 * 有可能已經從 Lark 移除；掃描過才會變成 `live`。
 */
router.get('/api/osm-uat/tc-list', (_req, res) => {
  const registry = readRegistryFile()
  const savedSteps = listUatTcSteps()
  const tcs = Object.entries(registry).map(([recordId, raw]) => {
    const entry = raw as { canonicalText?: string; sub?: string; verifierName?: string }
    return {
      recordId,
      text: String(entry.canonicalText ?? '').slice(0, 300),
      sub: String(entry.sub ?? ''),
      taskType: '',
      stepCount: savedSteps[recordId]?.length ?? 0,
      verifierName: entry.verifierName ?? null,
      source: 'registry' as const,
    }
  })
  res.json({ ok: true, tcs, capturedAt: firstCapturedAt(registry) })
})

/** 快照時間，讓畫面講得出這份離線清單有多舊 */
function firstCapturedAt(registry: Record<string, unknown>): string | null {
  const times = Object.values(registry)
    .map(v => (v as { capturedAt?: string }).capturedAt)
    .filter((v): v is string => typeof v === 'string')
    .sort()
  return times[times.length - 1] ?? null
}

// ─── 錄製 ─────────────────────────────────────────────────────────────────────
// 開一個有頭的 Chromium、自動登入後台，注入錄製腳本：使用者的操作變積木，
// 按住 Alt 點元素當場標斷言。停止後轉成積木回傳，由前端塞進那筆 TC。
//
// 用 Playwright 而不是自己接 CDP（H5 那邊是接 CDP）：這裡需要「先自動登入再開始錄」，
// Playwright 的 fill/click 直接就能做，自己接 CDP 要重寫一遍輸入模擬。

interface RecordSession {
  id: string
  recordId: string
  browser: import('playwright').Browser | null
  events: unknown[]
  done: boolean
  error: string | null
  startedAt: number
}

const recordSessions = new Map<string, RecordSession>()
/** 錄製最長 30 分鐘，避免使用者關掉分頁就留一個瀏覽器在伺服器上 */
const RECORD_MAX_MS = 30 * 60_000

router.post('/api/osm-uat/record/start', writeLimiter, async (req, res, next) => {
  try {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    // recordId 選填：錄製本身完全不需要知道你在哪一筆 TC（開瀏覽器、登入、注入、
    // 收事件、轉積木都跟 TC 無關）。之前必填是因為錄製被做在編輯器裡，
    // 等於把「先選一筆 TC」變成了錄製的門檻——那是 UI 的安排不是功能的需要。
    // 現在可以從工作台直接開錄，停止後再決定積木要放哪一筆。
    const recordId = String((req.body as { recordId?: string })?.recordId ?? '')

    const creds = getUatBackendCredentials(account.email)
    if (!creds.cpBackend?.username || !creds.cpBackend?.password) {
      return res.status(400).json({ ok: false, message: '請先在執行設定填好 CP 後台帳密' })
    }

    const sessionId = randomUUID()
    const session: RecordSession = { id: sessionId, recordId, browser: null, events: [], done: false, error: null, startedAt: Date.now() }
    recordSessions.set(sessionId, session)

    const pw = await import('playwright')
    // headless: false —— 錄製本來就是要讓人在畫面上操作
    const browser = await pw.chromium.launch({ headless: false, args: ['--start-maximized'] })
    session.browser = browser
    const ctx = await browser.newContext({ viewport: null })
    const page = await ctx.newPage()

    // 錄製腳本要在頁面自己的程式碼之前執行，才不會漏掉早期的事件
    await ctx.addInitScript(backendRecorderScript())
    page.on('console', msg => {
      const text = msg.text()
      if (!text.startsWith(RECORDER_MARKER)) return
      try { session.events.push(JSON.parse(text.slice(RECORDER_MARKER.length).trim())) } catch { /* 壞掉的一筆跳過 */ }
    })
    page.on('close', () => { session.done = true })

    // 自動登入，讓使用者一開始就在已登入的後台，不用自己打帳密
    await page.goto(`${BACKEND_URL_FOR_RECORD}/login`, { waitUntil: 'networkidle', timeout: 30000 })
    await page.fill('input[type="text"], input[name*="user"], input[id*="user"]', creds.cpBackend.username).catch(() => {})
    await page.fill('input[type="password"]', creds.cpBackend.password).catch(() => {})
    await page.keyboard.press('Enter').catch(() => {})
    await page.waitForTimeout(2500)
    // 登入完成之後才開始錄。在這之前的輸入是我們自己打的帳密，
    // 錄進去等於把真實密碼寫成測試步驟（實測時真的錄到了才發現）。
    session.events.length = 0
    await page.evaluate(() => (window as unknown as { __toppathArmRecorder?: () => void }).__toppathArmRecorder?.()).catch(() => {})

    setTimeout(() => { void stopRecordSession(sessionId) }, RECORD_MAX_MS).unref?.()
    res.json({ ok: true, sessionId })
  } catch (error) {
    next(error)
  }
})

router.get('/api/osm-uat/record/status/:sessionId', (req, res) => {
  const session = recordSessions.get(String(req.params.sessionId))
  if (!session) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
  const steps = eventsToSteps(session.events)
  res.json({
    ok: true,
    done: session.done,
    error: session.error,
    eventCount: session.events.length,
    steps,
    // 沒有任何斷言的錄製跑起來永遠 PASS，前端要能在停止時提醒
    hasAssertion: hasAssertion(steps),
  })
})

router.post('/api/osm-uat/record/stop/:sessionId', async (req, res, next) => {
  try {
    const result = await stopRecordSession(String(req.params.sessionId))
    if (!result) return res.status(404).json({ ok: false, message: '找不到錄製 session' })
    res.json({ ok: true, ...result })
  } catch (error) {
    next(error)
  }
})

async function stopRecordSession(sessionId: string) {
  const session = recordSessions.get(sessionId)
  if (!session) return null
  session.done = true
  try { await session.browser?.close() } catch { /* 已經關掉了 */ }
  session.browser = null
  const steps = eventsToSteps(session.events)
  // 保留一小段時間讓前端來拿結果，之後才清掉
  setTimeout(() => recordSessions.delete(sessionId), 5 * 60_000).unref?.()
  return { steps, eventCount: session.events.length, hasAssertion: hasAssertion(steps) }
}

/** 積木定義給前端畫積木庫與參數表單用。刻意由後端提供，前端不要另抄一份 */
router.get('/api/osm-uat/blocks', (_req, res) => {
  res.json({ ok: true, blockDefs: BLOCK_DEFS })
})

/** 單筆 TC 的積木。verifierName 從 registry 檔案讀（那是出廠預設的路由表，唯讀）*/
router.get('/api/osm-uat/tc-steps/:recordId', (req, res) => {
  const recordId = String(req.params.recordId)
  const entry = readRegistryFile()[recordId] as { verifierName?: string } | undefined
  res.json({ ok: true, steps: getUatTcSteps(recordId), verifierName: entry?.verifierName ?? null })
})

const stepsSchema = z.object({
  steps: z.array(z.object({ action: z.string().min(1).max(60) }).passthrough()).max(60),
})

router.put('/api/osm-uat/tc-steps/:recordId', writeLimiter, (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  const parsed = stepsSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, message: '積木格式錯誤' })

  const unknown = parsed.data.steps.map(s => s.action).filter(a => !(a in BLOCK_DEFS))
  if (unknown.length) {
    // 存下不認得的積木，執行時才會失敗，那時已經離編輯很遠了；在存的時候就擋掉
    return res.status(400).json({ ok: false, message: `不認得的積木：${[...new Set(unknown)].join('、')}` })
  }

  saveUatTcSteps(String(req.params.recordId), parsed.data.steps, account.email)
  res.json({ ok: true, steps: parsed.data.steps })
})

router.post('/api/osm-uat/run', (req, res) => {
  // 用 isSessionAlive 而不是只看 session.status——前端可能從 log 判斷完成、
  // 但子程序還沒完全結束；反過來 agent 斷線時也不該把人鎖住
  if (isSessionAlive()) {
    res.status(409).json({ ok: false, error: '測試已在執行中' })
    return
  }

  const parsed = runSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }

  const { larkUrl, filter, dashGameType, dashClientVersion, modulePlan, agentId } = parsed.data
  const larkParams = parseLarkBitableUrl(larkUrl)
  if (!larkParams) {
    res.status(400).json({ ok: false, error: '無效的 Lark Bitable URL（需包含 /base/{token} 和 ?table={id}）' })
    return
  }

  // ── 挑 agent ──────────────────────────────────────────────────────────────
  // 只有兩種情況會落到伺服器端 spawn：明確選了 'server'，或是沒指名而且真的
  // 一台可用 agent 都沒有。指名了卻挑不到一定回 409——默默改跑在 server 上
  // 等於在公網環境偷偷開一顆 Chromium，使用者還以為跑在自己機器上。
  const wantServerMode = agentId === SERVER_MODE_SENTINEL
  const operator = getOperatorFromContext()
  let agent: AgentInfo | undefined
  if (!wantServerMode) {
    const mine = operator?.key
      ? [...agentConnections.values()].filter(a =>
          a.ownerKey === operator.key
          && a.capabilities.includes(BACKEND_UAT_CAPABILITY)
          && a.ws.readyState === a.ws.OPEN)
      : []
    if (agentId) {
      agent = mine.find(a => a.agentId === agentId)
      if (!agent) {
        res.status(409).json({ ok: false, error: '指定的 Agent 不在線上或沒有 backend-uat 能力' })
        return
      }
      if (agent.busy) {
        res.status(409).json({ ok: false, error: '指定的 Agent 正在執行其他任務' })
        return
      }
    } else {
      agent = mine.find(a => !a.busy)
    }
  }

  const heavyTask = tryStartHeavyTask(req, 'osm-uat', 'OSM UAT 自動化測試')
  if (heavyTask.ok === false) {
    res.status(429).json(heavyTaskConflict(heavyTask.task))
    return
  }

  const credEnv = uatCredEnv(req)
  // 積木存在 DB，runner 讀不到，所以執行時整包帶下去（跟 UAT_MODULE_PLAN 同一套做法）。
  // agent 派工也走這條，agent 端不需要有任何積木檔案。
  const tcSteps = listUatTcSteps()
  const tcStepsEnv = Object.keys(tcSteps).length ? { UAT_TC_STEPS: JSON.stringify(tcSteps) } : {}
  const sessionId = randomUUID()
  session = {
    id: sessionId,
    status: 'running',
    mode: agent ? 'agent' : 'server',
    agentId: agent?.agentId,
    agentHostname: agent?.hostname,
    startedAt: Date.now(),
    logs: [],
    process: null,
    heavyTask: heavyTask.token,
    secrets: secretsFromCredEnv(credEnv),
  }
  broadcast('status', { status: 'running', mode: session.mode, agentId: session.agentId, agentHostname: session.agentHostname })

  // ── A. 派工給 Agent ───────────────────────────────────────────────────────
  if (agent) {
    agent.busy = true
    agent.sessionId = sessionId
    appendLog(`\U0001f680 派工給 Agent：${agent.hostname}（${agent.agentId}）`)
    try {
      agent.ws.send(JSON.stringify({
        type: 'backend_uat_start',
        sessionId,
        larkAppToken: larkParams.appToken,
        larkTableId: larkParams.tableId,
        filter: filter || undefined,
        dashGameType: dashGameType || undefined,
        dashClientVersion: dashClientVersion || undefined,
        modulePlan: modulePlan?.length ? modulePlan : undefined,
        credEnv: { ...credEnv, ...tcStepsEnv },
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      finishSession('error', `❌ 派工失敗: ${message}`, { error: message })
      res.status(502).json({ ok: false, error: `派工失敗：${message}` })
      return
    }
    res.json({ ok: true, sessionId, mode: 'agent', agentId: agent.agentId, agentHostname: agent.hostname })
    return
  }

  // ── B. 伺服器端 spawn（fallback，舊行為）──────────────────────────────────
  appendLog(wantServerMode ? '\U0001f5a5️ 以伺服器端模式執行' : '\U0001f5a5️ 沒有可用的 Agent，改在伺服器端執行')

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
      ...(modulePlan?.length ? { UAT_MODULE_PLAN: JSON.stringify(modulePlan) } : {}),
      ...tcStepsEnv,
      // 帳密改成用「發動這次測試的人」自己設定的那份（存在 DB，設定頁填），
      // 腳本端優先吃這幾個環境變數、沒有才 fallback 到 config 檔（2026-08-21）
      ...credEnv,
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
    finishSession(code === 0 ? 'done' : 'error', `--- 執行結束（exit code: ${code}）---`, { exitCode: code })
  })

  child.on('error', (err) => {
    finishSession('error', `❌ 啟動失敗: ${err.message}`, { error: err.message })
  })

  res.json({ ok: true, sessionId, mode: 'server' })
})

// ─── 停止測試 ──────────────────────────────────────────────────────────────────

router.post('/api/osm-uat/stop', (_req, res) => {
  if (session.status !== 'running') {
    res.status(400).json({ ok: false, error: '目前沒有執行中的測試' })
    return
  }

  // agent 模式跟本機 spawn 模式的停止方式完全不同，不共用同一套 kill 假設
  if (session.mode === 'agent') {
    const agent = session.agentId ? agentConnections.get(session.agentId) : undefined
    if (agent && agent.ws.readyState === agent.ws.OPEN) {
      agent.ws.send(JSON.stringify({ type: 'backend_uat_stop', sessionId: session.id }))
      appendLog('\U0001f6d1 已送出停止指令給 Agent')
      // 不在這裡收尾——等 agent 回 backend_uat_done 才算真的停了
      res.json({ ok: true, mode: 'agent' })
      return
    }
    finishSession('error', '\U0001f6d1 Agent 已離線，直接標記為停止', { error: 'agent offline' })
    res.json({ ok: true, mode: 'agent', note: 'agent offline' })
    return
  }

  if (!session.process) {
    res.status(400).json({ ok: false, error: '目前沒有執行中的測試' })
    return
  }
  session.process.kill('SIGTERM')
  finishHeavyTask(session.heavyTask)
  appendLog('\U0001f6d1 已手動停止測試')
  res.json({ ok: true, mode: 'server' })
})

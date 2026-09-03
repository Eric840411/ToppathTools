/**
 * server/routes/autospin.ts
 * AutoSpin management: machine configs, template files, session control.
 */
import { Router } from 'express'
import { z } from 'zod'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, readdirSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { db, addHistory, upload } from '../shared.js'
import { getOperatorFromContext } from '../request-context.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'
import { fetchSlsErrors, fetchRecordBet, testSlsRecordBetConnection, type SlsBetRecord } from '../lib/sls.js'
import { randomUUID } from 'crypto'
import { agentConnections, getAvailableAgents } from '../agent-hub.js'
// 只讀取 Machine Test 現成維護的 OSMWatcher 狀態 map，不改動 machine-test.ts 本身
import { osmMachineStatus, agentUpdateStatus } from './machine-test.js'
import { matchesLogFilter, isEmptyFilter, type PinusCategory } from '../../shared/autospin-log-rules.js'
import { resolveGeminiKeyEntries } from './gemini.js'

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
  logApiEnv: string
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

// 前端畫面保留 10,000 行（MAX_VISIBLE_LOGS），server 這邊要跟上——
// 不然前端就算放寬也拿不到更多，使用者會以為是前端沒生效。
// ⚠️ 刻意不做「無限」：無限只是把記憶體爆掉的時間延後（跟 CodeX 討論定案）。
//    真正完整的紀錄要靠 server 落檔，那是另一版的事。
const MAX_LOGS = 10000  // cap per session to prevent unbounded memory growth

// ─── 執行日誌落檔（2026-09-02）────────────────────────────────────────────────
//
// ⚠️ 畫面只留最近 10,000 行，**再多就被丟掉**——長時間跑的 session 事後查問題時
//    最需要的往往正是被丟掉的那段。所以完整紀錄寫成檔案，畫面歸畫面。
//
// 沿用 machine-test 的 cctv-saves 那套慣例：固定目錄 + 保留天數 GC，
// 不另創一種做法。
const AUTOSPIN_LOG_DIR = join(SERVER_ROOT, 'autospin-logs')
const AUTOSPIN_LOG_RETENTION_DAYS = 14

function autospinLogPath(sessionId: string): string {
  // sessionId 會進檔名，一定要擋掉路徑穿越——它來自 URL 參數
  return join(AUTOSPIN_LOG_DIR, `${sessionId.replace(/[^\w.-]/g, '_')}.log`)
}

/** 檔案第一行寫擁有者。
 *
 *  ⚠️ **不能只靠記憶體裡的 session 判斷擁有者**——session 兩小時就被 GC，
 *     但檔案要留 14 天給事後查問題用。session 消失之後如果沒有別的依據，
 *     就變成「只要知道 sessionId 就能下載別人的執行日誌」。
 *     寫進檔案本身，是唯一跟檔案一樣長壽的作法。 */
const LOG_OWNER_PREFIX = '#owner='

function appendSessionLog(sessionId: string, line: string) {
  try {
    if (!existsSync(AUTOSPIN_LOG_DIR)) mkdirSync(AUTOSPIN_LOG_DIR, { recursive: true })
    const path = autospinLogPath(sessionId)
    if (!existsSync(path)) {
      const owner = agentSessions.get(sessionId)?.userLabel ?? ''
      writeFileSync(path, `${LOG_OWNER_PREFIX}${owner}\n`, 'utf8')
    }
    appendFileSync(path, line.endsWith('\n') ? line : line + '\n', 'utf8')
  } catch {
    // 寫不進去不能影響執行本身——日誌是紀錄不是功能
  }
}

/** 讀檔案第一行記的擁有者。'' 代表當時沒有帳號資訊（伺服器端 fallback 模式）。 */
function sessionLogOwner(path: string): string | null {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 200).split('\n')[0]
    return head.startsWith(LOG_OWNER_PREFIX) ? head.slice(LOG_OWNER_PREFIX.length) : null
  } catch { return null }
}

/** 超過保留天數的紀錄檔清掉。不清的話磁碟會一直長，
 *  而 AutoSpin 是會連跑好幾小時、每天跑的東西。 */
function gcAutospinLogs() {
  try {
    if (!existsSync(AUTOSPIN_LOG_DIR)) return
    const cutoff = Date.now() - AUTOSPIN_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(AUTOSPIN_LOG_DIR)) {
      const full = join(AUTOSPIN_LOG_DIR, name)
      try { if (statSync(full).mtimeMs < cutoff) unlinkSync(full) } catch { /* 單一檔案失敗不影響其他 */ }
    }
  } catch { /* 目錄有問題就跳過，不要讓 GC 拖垮啟動 */ }
}
gcAutospinLogs()
setInterval(gcAutospinLogs, 6 * 60 * 60 * 1000)

/**
 * GET /api/autospin/session-log/:id — 下載這次執行的**完整**紀錄檔。
 *
 * 使用者要求：「要根據使用者篩選的內容導出，如果沒有篩選則全導出」。
 * 所以篩選條件用 query 帶過來，在這裡用**跟畫面同一份規則**過濾
 * （`shared/autospin-log-rules.ts`）——兩邊各寫一份的話會出現
 * 「畫面 12 筆、導出 15 筆」這種沒人查得出來的落差。
 *
 * ⚠️ 這支給的是「檔案裡的全部」，不是畫面上那 10,000 行。
 *    畫面那顆舊的「下載」拿的是被截斷過的記憶體資料，兩者用途不同。
 */
router.get('/api/autospin/session-log/:id', (req, res) => {
  const path = autospinLogPath(String(req.params.id))
  if (!existsSync(path)) return res.status(404).json({ ok: false, message: '找不到這次執行的紀錄檔（可能已超過保留期限 14 天）' })

  // ⚠️ 擁有者以檔案裡記的為準，不是記憶體 session——session 兩小時就沒了，
  //    檔案留 14 天。owner 是空字串代表當時沒有帳號資訊（伺服器端 fallback 模式），
  //    那種沿用既有行為不擋（跟 SSE／截圖那幾支一致）。
  const owner = sessionLogOwner(path)
  if (owner) {
    // ⚠️ `requestUserLabel()` 讀的是 `x-user-label` header，單看它像是可以偽造。
    //    **實際上走正常路徑偽造不了**——proxy（server/index.ts 的 proxyToWorker）
    //    會用登入 cookie 推出來的身分覆寫這個 header：
    //        if (ctx?.userDisplay && ...) headers.set('x-user-label', ctx.userDisplay)
    //    我測的時候就是被這個擋掉的：對 3000 送假 label 完全無效，
    //    直打 worker 的 3010 才擋得下來（403）。
    //
    //    ⚠️ 但這代表安全性**依賴 worker 的 3010 不對外**。這是部署假設不是程式保證，
    //    跟 v4.10.0 收緊 Jira 身分邊界時處理的是同一類問題。
    //    這裡沿用 autospin 其他端點既有的信任模型，沒有另立一套。
    const who = requestUserLabel(req)
    if (!who || who !== owner) return res.status(403).json({ ok: false, message: '這不是你的執行紀錄' })
  }

  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter(l => l && !l.startsWith(LOG_OWNER_PREFIX))

  const pinusParam = typeof req.query.pinus === 'string' ? req.query.pinus : ''
  const filter = {
    cat: typeof req.query.cat === 'string' ? req.query.cat : 'all',
    search: typeof req.query.q === 'string' ? req.query.q : '',
    pinusCats: pinusParam ? pinusParam.split(',') as PinusCategory[] : undefined,
  }
  const filtered = isEmptyFilter(filter) ? lines : lines.filter(l => matchesLogFilter(l, filter))

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = isEmptyFilter(filter) ? '完整' : '已篩選'
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  // ⚠️ HTTP header 只能放 latin-1。檔名帶中文（「完整」「已篩選」）會讓 Express 直接
  //    丟 500 `Invalid character in header content`——實測踩到。
  //    ASCII 的放 filename=，中文的走 RFC 5987 的 filename*=，兩個都給，
  //    支援的瀏覽器用後者、不支援的退回前者。
  const asciiName = `autospin-${isEmptyFilter(filter) ? 'full' : 'filtered'}_${stamp}.txt`
  const utf8Name = encodeURIComponent(`autospin-${suffix}_${stamp}.txt`)
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`)
  // 開頭寫清楚這份是不是篩過的——不然拿到檔案的人分不出「只有 12 行」是
  // 因為篩選還是因為真的只跑了 12 行
  const header = isEmptyFilter(filter)
    ? `# AutoSpin 完整執行紀錄（共 ${lines.length} 行）\n`
    : `# AutoSpin 執行紀錄（已依畫面篩選：類別=${filter.cat}${filter.search ? ` 關鍵字=${filter.search}` : ''}）`
      + `　${filtered.length} / ${lines.length} 行\n`
  res.send(header + filtered.join('\n') + '\n')
})

function broadcastLog(sessionId: string, line: string) {
  appendSessionLog(sessionId, line)
  const state = sessions.get(sessionId)
  if (state) {
    state.logs.push(line)
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS)
  }
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
    logApiEnv: z.enum(['qat', 'prod']).default('qat'),
  }).parse(req.body)

  db.prepare(`
    INSERT OR REPLACE INTO autospin_configs
    (userLabel, machineType, gameUrl, rtmpName, rtmpUrl, gameTitleCode, templateType, errorTemplateType,
     enabled, enableRecording, enableTemplateDetection, notes,
     spinInterval, randomExitEnabled, randomExitChance, randomExitMinSpins, betRandomEnabled, lowBalanceThreshold, larkWebhook, machineNo, logApiEnv)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userLabel, body.machineType, body.gameUrl, body.rtmpName, body.rtmpUrl, body.gameTitleCode,
    body.templateType, body.errorTemplateType,
    body.enabled ? 1 : 0, body.enableRecording ? 1 : 0, body.enableTemplateDetection ? 1 : 0,
    body.notes,
    body.spinInterval, body.randomExitEnabled ? 1 : 0, body.randomExitChance,
    body.randomExitMinSpins, body.betRandomEnabled ? 1 : 0, body.lowBalanceThreshold, body.larkWebhook,
    body.machineNo, body.logApiEnv,
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

// 伺服器端 fallback 模式的截圖只會累積不會自動刪除，超過 48 小時的檔案定時清掉，避免佔滿硬碟
const CAPTURE_MAX_AGE_MS = 48 * 60 * 60 * 1000
function cleanOldCaptures() {
  if (!PROJECT_DIR) return
  const now = Date.now()
  for (const d of ['stream_captures', 'screenshots']) {
    const dir = join(PROJECT_DIR, d)
    if (!existsSync(dir)) continue
    try {
      for (const f of readdirSync(dir)) {
        const fp = join(dir, f)
        try { if (now - statSync(fp).mtimeMs > CAPTURE_MAX_AGE_MS) unlinkSync(fp) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

// GET /api/autospin/captures-list — list recent captures
router.get('/api/autospin/captures-list', async (_req, res) => {
  if (!PROJECT_DIR) return res.json({ ok: true, files: [] })
  cleanOldCaptures()
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

// ─── Discord Webhook 通知設定 ──────────────────────────────────────────────────
// URL / 標題模板 / 頁尾文字仍是全域共用（存在 settings 表，同一個頻道大家共用）；
// 通知啟用開關、顯示欄位、定時彙總報告設定改成依帳號分開（存在 autospin_notify_prefs，
// 見下方 getNotifyPrefsRow() 等 helper）——每個帳號自己決定自己派工的 session 要不要
// 通知、要顯示哪些欄位，不會互相影響。

// GET /api/autospin/discord-webhook — 取得目前設定的 Discord Webhook URL（全域）+ 啟用開關 + 訊息格式設定（依帳號）
router.get('/api/autospin/discord-webhook', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('discord_webhook_url') as { value: string } | undefined
  res.json({
    ok: true,
    url: row?.value ?? '',
    enabled: isDiscordNotifyEnabled(userLabel),
    fields: getDiscordNotifyFields(userLabel),
    titleTemplate: getDiscordTitleTemplate(),
    footer: getDiscordFooterText(),
  })
})

// POST /api/autospin/discord-webhook — url/titleTemplate/footer 寫全域設定；enabled/fields 寫該帳號自己的設定
router.post('/api/autospin/discord-webhook', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const { url, enabled, fields, titleTemplate, footer } = req.body as {
    url?: string; enabled?: boolean; fields?: Partial<Record<NotifyFieldKey, boolean>>
    titleTemplate?: string; footer?: string
  }
  if (typeof url !== 'string') return res.status(400).json({ ok: false, message: 'url required' })
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('discord_webhook_url', url)
  if (typeof enabled === 'boolean') {
    upsertNotifyPrefs(userLabel, { notifyEnabled: enabled ? 1 : 0 })
  }
  if (fields && typeof fields === 'object') {
    const merged = { ...getDiscordNotifyFields(userLabel), ...fields }
    upsertNotifyPrefs(userLabel, { notifyFields: JSON.stringify(merged) })
  }
  if (typeof titleTemplate === 'string') {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('discord_notify_title_template', titleTemplate)
  }
  if (typeof footer === 'string') {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('discord_notify_footer', footer)
  }
  res.json({ ok: true })
})

// POST /api/autospin/discord-webhook/test — 送一則測試訊息確認 webhook 設定正確
router.post('/api/autospin/discord-webhook/test', async (_req, res) => {
  const url = getDiscordWebhookUrl()
  if (!url) return res.status(400).json({ ok: false, message: '尚未設定 Discord Webhook URL' })
  try {
    const r = await fetch(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '✅ Toppath Tools 測試訊息',
          description: '這是一則測試訊息，確認 Discord Webhook 設定正確。',
          color: 0x22c55e,
          timestamp: new Date().toISOString(),
        }],
      }),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      return res.status(400).json({ ok: false, message: `Discord API 錯誤 ${r.status}: ${txt.slice(0, 200)}` })
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, message: `送出失敗: ${e}` })
  }
})

// ─── 帳號各自的通知偏好（autospin_notify_prefs）───────────────────────────────
// 通知啟用開關/顯示欄位/定時彙總報告設定依帳號分開；Webhook URL/標題模板/頁尾文字
// 仍是全域（見上方 discord-webhook 路由）。尚未存過偏好的帳號，getter 會 fallback
// 讀取舊版全域 settings 值（2026-07-31 前的行為），避免改版當下所有帳號的通知/報告
// 設定突然被重置成程式內建預設值。
interface NotifyPrefsRow {
  userLabel: string; notifyEnabled: number; notifyFields: string
  reportEnabled: number; reportIntervalMin: number; reportFields: string
  reportCustomNote: string; reportAiEnabled: number; compareEnabled: number; screenshotEnabled: number
}
function getNotifyPrefsRow(userLabel: string): NotifyPrefsRow | undefined {
  return db.prepare('SELECT * FROM autospin_notify_prefs WHERE userLabel = ?').get(userLabel) as NotifyPrefsRow | undefined
}
function upsertNotifyPrefs(userLabel: string, patch: Partial<Omit<NotifyPrefsRow, 'userLabel'>>) {
  const existing = getNotifyPrefsRow(userLabel) ?? {
    userLabel, notifyEnabled: 1, notifyFields: '', reportEnabled: 0, reportIntervalMin: 20, reportFields: '', reportCustomNote: '', reportAiEnabled: 0, compareEnabled: 1, screenshotEnabled: 1,
  }
  const merged = { ...existing, ...patch }
  db.prepare(`
    INSERT INTO autospin_notify_prefs (userLabel, notifyEnabled, notifyFields, reportEnabled, reportIntervalMin, reportFields, reportCustomNote, reportAiEnabled, compareEnabled, screenshotEnabled)
    VALUES (@userLabel, @notifyEnabled, @notifyFields, @reportEnabled, @reportIntervalMin, @reportFields, @reportCustomNote, @reportAiEnabled, @compareEnabled, @screenshotEnabled)
    ON CONFLICT(userLabel) DO UPDATE SET
      notifyEnabled = excluded.notifyEnabled, notifyFields = excluded.notifyFields,
      reportEnabled = excluded.reportEnabled, reportIntervalMin = excluded.reportIntervalMin,
      reportFields = excluded.reportFields, reportCustomNote = excluded.reportCustomNote, reportAiEnabled = excluded.reportAiEnabled,
      compareEnabled = excluded.compareEnabled, screenshotEnabled = excluded.screenshotEnabled
  `).run(merged)
}

// 三路對帳依帳號開關；沒存過偏好的帳號 fallback 預設開啟（避免現有流程突然少資料，符合 2026-08-10 討論結論）
function isCompareEnabled(userLabel: string): boolean {
  const row = getNotifyPrefsRow(userLabel)
  return row ? row.compareEnabled !== 0 : true
}
// 截圖監控依帳號開關（2026-08-17，使用者要求「不要常駐，讓使用者決定」）——只在 AutoSpin 啟動時
// 讀一次（見 /agent/start），啟動後切換此開關要等下次重啟 session 才生效，不是即時的（跟 CodeX
// 討論定案：即時生效要多一條 agent polling/server push，這版先做成本低的「下次啟動生效」）
function isScreenshotEnabled(userLabel: string): boolean {
  const row = getNotifyPrefsRow(userLabel)
  return row ? row.screenshotEnabled !== 0 : true
}
function legacySetting(key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

// ─── 定時彙總報告設定（RECOVER/errcode/CR checks/kickouts 等長時間穩定性統計）──────
// 跟啟動/結束的 Discord 通知共用同一個 webhook URL，只是另外開關+設定間隔跟顯示欄位。

function getStatusReportEnabled(userLabel: string): boolean {
  const row = getNotifyPrefsRow(userLabel)
  if (row) return row.reportEnabled === 1
  return legacySetting('autospin_status_report_enabled') === '1'
}

function getStatusReportIntervalMin(userLabel: string): number {
  const row = getNotifyPrefsRow(userLabel)
  if (row) return row.reportIntervalMin > 0 ? row.reportIntervalMin : 20
  const n = parseFloat(legacySetting('autospin_status_report_interval_min') ?? '')
  return Number.isFinite(n) && n > 0 ? n : 20
}

type StatusReportFieldKey = 'spins' | 'winRate' | 'errcodes' | 'recover' | 'kickouts' | 'crChecks' | 'uptime'
const DEFAULT_STATUS_REPORT_FIELDS: Record<StatusReportFieldKey, boolean> = {
  spins: true, winRate: true, errcodes: true, recover: true, kickouts: true, crChecks: true, uptime: true,
}
function getStatusReportFields(userLabel: string): Record<StatusReportFieldKey, boolean> {
  const row = getNotifyPrefsRow(userLabel)
  const raw = row ? row.reportFields : legacySetting('autospin_status_report_fields')
  if (!raw) return { ...DEFAULT_STATUS_REPORT_FIELDS }
  try { return { ...DEFAULT_STATUS_REPORT_FIELDS, ...JSON.parse(raw) } } catch { return { ...DEFAULT_STATUS_REPORT_FIELDS } }
}

/** 自訂備註欄位（選填），會附加在每則定時彙總報告的最下方。 */
function getStatusReportCustomNote(userLabel: string): string {
  const row = getNotifyPrefsRow(userLabel)
  if (row) return row.reportCustomNote
  return legacySetting('autospin_status_report_custom_note') ?? ''
}

/** AI 分析區塊開關（預設關閉）——關閉時完全不呼叫 Gemini，零額外開銷；開啟才會呼叫 generateStatusReportAiAnalysis()。 */
function getStatusReportAiEnabled(userLabel: string): boolean {
  const row = getNotifyPrefsRow(userLabel)
  if (row) return row.reportAiEnabled === 1
  return legacySetting('autospin_status_report_ai_enabled') === '1'
}

// GET /api/autospin/status-report-settings
router.get('/api/autospin/status-report-settings', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  res.json({
    ok: true,
    enabled: getStatusReportEnabled(userLabel),
    intervalMin: getStatusReportIntervalMin(userLabel),
    fields: getStatusReportFields(userLabel),
    customNote: getStatusReportCustomNote(userLabel),
    aiEnabled: getStatusReportAiEnabled(userLabel),
  })
})

// POST /api/autospin/status-report-settings
router.post('/api/autospin/status-report-settings', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const { enabled, intervalMin, fields, customNote, aiEnabled } = req.body as {
    enabled?: boolean; intervalMin?: number; fields?: Partial<Record<StatusReportFieldKey, boolean>>; customNote?: string; aiEnabled?: boolean
  }
  if (typeof enabled === 'boolean') upsertNotifyPrefs(userLabel, { reportEnabled: enabled ? 1 : 0 })
  if (typeof intervalMin === 'number' && Number.isFinite(intervalMin) && intervalMin > 0) {
    upsertNotifyPrefs(userLabel, { reportIntervalMin: intervalMin })
  }
  if (fields && typeof fields === 'object') {
    const merged = { ...getStatusReportFields(userLabel), ...fields }
    upsertNotifyPrefs(userLabel, { reportFields: JSON.stringify(merged) })
  }
  if (typeof customNote === 'string') upsertNotifyPrefs(userLabel, { reportCustomNote: customNote })
  if (typeof aiEnabled === 'boolean') upsertNotifyPrefs(userLabel, { reportAiEnabled: aiEnabled ? 1 : 0 })
  res.json({ ok: true })
})

/** 每個 errcode 的「影響」結論。Agent 端由 summarize_err_snapshots() 算好送上來。 */
interface ErrImpact {
  count: number
  /** 餘額有減少但這局沒轉成 —— 也就是「扣了錢沒東西」，這是唯一真正該升級的訊號 */
  deducted: number
  /** 當下讀不到餘額，判斷不了有沒有扣 */
  unknown: number
  /** 需要進一步對帳的筆數（扣款疑慮／狀態不明／長時間沒恢復）*/
  needsReconcile: number
  /** 從錯誤到下一次成功 spin 最久花了幾秒 —— 熱更新測試真正要回報的「多久恢復」*/
  maxRecoverSec: number | null
  /** 伺服器自己給的錯誤描述，回答「異常是什麼」*/
  lastDes: string
}

interface StatusReportStats {
  spinCount: number; okSpinCount: number; winCount: number; totalWin: number; lastCoin: number | null
  errcodeCounts: Record<string, number>; errcodeTimes?: Record<string, number[]>
  recoverCount: number; kickoutCount: number
  crChecks: number; crNoResponse: number
  /** 舊版 Agent 不會送這個欄位，所以是選填——沒有就退回只顯示次數 */
  errImpact?: Record<string, ErrImpact>
  /**
   * 局數分類。spinCount 是**按鈕嘗試次數**，這裡才是「跑了幾局」。
   * 實體機台上按 SPIN 可能落在動畫中或 FG/JP，那一下不會起局——
   * 兩者混在一起的話，「spins 90、ok 100%」會被誤讀成「跑了 90 局全部成功」。
   *
   * 舊版 Agent 沒有這個欄位，所以是選填；沒有就退回舊格式。
   */
  outcomeCounts?: {
    /** coin_update：有 moneyNtc 結算，確定完成一局 */
    completed?: number
    /** 原本逾時判成 unknown，但下一次 spin 前才觀察到 coin 更新 → 推定那一局其實跑完了。
     *
     *  ⚠️ **刻意不併進 completed**（跟 CodeX 討論定案）。`__coinUpdatedAt` 是「任何一則
     *     帶 coin 欄位的 pinus 訊息」都會更新，route 與 reason 都沒過濾，所以它只證明
     *     「這段期間曾經有 coin 更新」，證據等級低於 8 秒內收到的結算。併進去會讓
     *     「完成局數」從確定訊號變成混合訊號，而且改版前後不可比。
     *
     *  這個比例本身就是健康指標：變多代表結算訊號常常晚到或漏接。 */
    completed_late?: number
    /** button_disabled_toggle：按鈕進出 spinning，局跑過了但缺結算證據。
     *  這個數字變多本身就是訊號——代表 moneyNtc 收不到（pinus 補丁失效）*/
    suspected?: number
    /** timeout_8s：什麼訊號都沒收到。不代表沒跑，所以不能算成沒起局 */
    unknown?: number
    /** spin_rejected：伺服器明確拒絕，確定沒起 */
    not_started?: number
  }
}

/** errcode 發生時間（epoch ms）格式化成台北時區 HH:mm:ss，供報告內文顯示最近幾次發生時間。 */
function fmtErrTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
}

/** 組出定時彙總報告的 Discord embed；真實回報與「試發送」測試共用同一份格式邏輯。 */
function buildStatusReportEmbed(opts: {
  machineType: string
  gameTitleCode?: string | null
  periodMinutes: number
  cumulative: StatusReportStats
  period: StatusReportStats
  uptimeMinutes?: number | null
  fields: Record<StatusReportFieldKey, boolean>
  customNote: string
  isTest?: boolean
  aiAnalysis?: string | null
}) {
  const { machineType, gameTitleCode, periodMinutes, cumulative, period, uptimeMinutes, fields, customNote, isTest, aiAnalysis } = opts
  const fmtPct = (ok: number, total: number) => total > 0 ? `${((ok / total) * 100).toFixed(1)}%` : '—'
  /** 每個 errcode 一行（Discord 引用格式），有時間點的話換行縮排列在下面，避免一長串塞成一行看不清楚。 */
  /**
   * 「按了幾次」跟「跑了幾局」要分開列。
   *
   * ⚠️ 舊格式的 `ok%`（非拒絕比例 ÷ 按鈕次數）**已經拿掉**，因為它會誤導：
   *    button_disabled_toggle 跟 timeout_8s 都不等於「成功跑一局」，
   *    但都被算進 ok。而且「ok」聽起來像品質判定，它其實只是結束原因。
   *    一個百分比蓋不住四種狀態（跟 CodeX 討論定案）。
   *
   * 舊版 Agent 沒有 outcomeCounts，那就退回只印嘗試次數——不要憑空生一個局數。
   */
  const spinLines = (st: StatusReportStats): string[] => {
    const out = [`spin 嘗試: ${st.spinCount.toLocaleString()} 次`]
    const oc = st.outcomeCounts
    if (!oc) return out
    const n = (v?: number) => (v ?? 0).toLocaleString()
    // 主數字只放「確定完成」，延遲推定的另外標。合併成一個數字就沒辦法
    // 一眼看出結算訊號的品質——而那正是這台機器最該盯的東西。
    const late = oc.completed_late ?? 0
    out.push(late > 0
      ? `完成局數: **${n(oc.completed)}**（＋延遲推定 ${n(late)} = ${((oc.completed ?? 0) + late).toLocaleString()}）`
      : `完成局數: **${n(oc.completed)}**`)
    // 疑似完成一定要列在旁邊：它變多代表 moneyNtc 收不到，
    // 那是熱更新後 pinus 補丁失效的早期訊號，合併掉就看不見了
    const rest: string[] = []
    if ((oc.suspected ?? 0) > 0) rest.push(`疑似完成 ${n(oc.suspected)}（無結算證據）`)
    // 用詞是「延遲推定完成」不是「延遲完成」——它是推定不是確定（CodeX 要求，
    // 不要過度承諾）
    if (late > 0) rest.push(`延遲推定完成 ${n(late)}（逾時後才見到結算）`)
    if ((oc.unknown ?? 0) > 0) rest.push(`不確定 ${n(oc.unknown)}（逾時且無後續結算）`)
    if ((oc.not_started ?? 0) > 0) rest.push(`未起局 ${n(oc.not_started)}（伺服器拒絕）`)
    if (rest.length) out.push(`> ${rest.join('｜')}`)
    return out
  }

  const errcodeStr = (
    m: Record<string, number>,
    times?: Record<string, number[]>,
    impact?: Record<string, ErrImpact>,
  ) => {
    const entries = Object.entries(m).filter(([, n]) => n > 0)
    if (entries.length === 0) return '> 無'
    return entries.map(([code, n]) => {
      const ts = times?.[code]
      let line = `> \`err${code}\` × ${n}`
      // 「影響」結論。開發問的是「對玩家有什麼影響」，光給 errcode 次數答不出來——
      // 扣款疑慮把錯誤分成三種完全不同的嚴重度，恢復秒數回答「服務中斷多久」，
      // 描述回答「異常是什麼」。這三項合起來才是可以直接回覆開發的內容。
      const im = impact?.[code]
      if (im) {
        const parts: string[] = []
        parts.push(im.deducted > 0 ? `**扣款疑慮 ${im.deducted}**` : '扣款疑慮 0')
        if (im.unknown > 0) parts.push(`餘額不明 ${im.unknown}`)
        if (im.maxRecoverSec !== null) parts.push(`最長恢復 ${im.maxRecoverSec}s`)
        if (im.needsReconcile > 0) parts.push(`待查帳 ${im.needsReconcile}`)
        line += `\n> 　↳ ${parts.join('｜')}`
        if (im.lastDes) line += `\n> 　↳ 伺服器描述：${im.lastDes}`
      }
      return ts && ts.length > 0 ? `${line}\n> 　↳ 最近 ${ts.map(fmtErrTime).join('、')}` : line
    }).join('\n')
  }

  const lines: string[] = []
  if (isTest) lines.push('⚠️ **這是試發送測試訊息，以下為假資料，非真實 AutoSpin 執行結果**', '')
  lines.push(`**本期間**（約 ${periodMinutes.toFixed(1)} 分鐘）`)
  if (fields.spins) lines.push(...spinLines(period))
  if (fields.winRate) lines.push(`wins: ${period.winCount.toLocaleString()}, totalWin: ${period.totalWin.toLocaleString()}`)
  if (fields.errcodes) lines.push('errcode:', errcodeStr(period.errcodeCounts, undefined, period.errImpact))
  if (fields.recover) lines.push(`RECOVER: ${period.recoverCount}`)
  if (fields.kickouts) lines.push(`kickouts: ${period.kickoutCount}`)
  if (fields.crChecks) lines.push(`CR checks: ${period.crChecks}，無回應 ${period.crNoResponse}`)
  lines.push('')
  lines.push('**累計**')
  if (fields.spins) lines.push(...spinLines(cumulative))
  if (fields.winRate) lines.push(`wins: ${cumulative.winCount.toLocaleString()}, totalWin: ${cumulative.totalWin.toLocaleString()}${cumulative.lastCoin != null ? `, lastCoin: ~${cumulative.lastCoin.toLocaleString()}` : ''}`)
  if (fields.errcodes) lines.push('errcode:', errcodeStr(cumulative.errcodeCounts, cumulative.errcodeTimes, cumulative.errImpact))
  if (fields.recover) lines.push(`RECOVER: ${cumulative.recoverCount}`)
  if (fields.kickouts) lines.push(`kickouts: ${cumulative.kickoutCount}`)
  if (fields.crChecks) lines.push(`CR checks: ${cumulative.crChecks}，無回應 ${cumulative.crNoResponse}`)
  if (fields.uptime && uptimeMinutes != null) {
    const h = Math.floor(uptimeMinutes / 60), m = Math.round(uptimeMinutes % 60)
    lines.push(`已跑時間: ~${h}h${m}m`)
  }
  if (customNote.trim()) {
    lines.push('')
    lines.push(customNote.trim())
  }
  if (aiAnalysis && aiAnalysis.trim()) {
    lines.push('')
    lines.push('**🤖 AI 分析**')
    lines.push(aiAnalysis.trim())
  }

  return {
    title: `📊 AutoSpin 定時彙總報告${isTest ? '（測試）' : ''} — ${machineType}${gameTitleCode ? `（${gameTitleCode}）` : ''}`,
    description: lines.join('\n'),
    color: isTest ? 0xf59e0b : 0x2563eb,
    timestamp: new Date().toISOString(),
  }
}

/** 把定時彙總報告的統計數字丟給 Gemini，請它判斷是否異常、哪個時間段可能機器異常導致中斷。
 * Best-effort：沒有可用的 Gemini key、呼叫失敗、逾時，一律回傳 null，報告照常送出不含 AI 分析區塊，
 * 不會因為 AI 這段掛掉就拖累整個定時彙總報告功能。只嘗試第一組可用的 key，不做多 key 輪替重試——
 * 這是背景 best-effort 附加功能，不是使用者主動觸發、等待結果的前景操作。 */
async function generateStatusReportAiAnalysis(
  req: import('express').Request,
  machineType: string, periodMinutes: number, cumulative: StatusReportStats, period: StatusReportStats, uptimeMinutes?: number | null,
): Promise<string | null> {
  const keyEntries = resolveGeminiKeyEntries(req)
  if (keyEntries.length === 0) return null

  const errcodeDetail = Object.entries(cumulative.errcodeCounts ?? {})
    .filter(([, n]) => n > 0)
    .map(([code, n]) => {
      const times = cumulative.errcodeTimes?.[code]
      const recent = times && times.length > 0 ? `，最近發生時間：${times.map(fmtErrTime).join(', ')}` : ''
      return `err${code} 共 ${n} 次${recent}`
    })
    .join('\n') || '無 errcode 記錄'

  const prompt = `你是老虎機自動化測試（AutoSpin）的穩定性監控助手。以下是機台「${machineType}」目前累計約 ${(uptimeMinutes ?? 0).toFixed(0)} 分鐘的執行統計，請用繁體中文寫 2-4 句話的簡短分析：
1. 判斷目前狀況是否正常/異常
2. 如果有 errcode 或 RECOVER 斷線重連紀錄，根據下面列出的發生時間點，指出「哪個時間段」可能是機器異常導致中斷（沒有明顯時間群聚就不用勉強指出）
3. 不用逐項複述數字（數字已經在報告的其他欄位顯示過了），只講你的判斷結論

累計統計：
- Spin 數：${cumulative.spinCount}（成功 ${cumulative.okSpinCount}）
- 中獎次數：${cumulative.winCount}，總贏分：${cumulative.totalWin}
- errcode 明細：
${errcodeDetail}
- RECOVER（斷線重連）次數：${cumulative.recoverCount}
- kickouts（低餘額離機重進）次數：${cumulative.kickoutCount}
- CR checks：${cumulative.crChecks} 次，其中無回應 ${cumulative.crNoResponse} 次
- 本期間（約 ${periodMinutes.toFixed(1)} 分鐘）：Spin ${period.spinCount} 次、errcode ${Object.values(period.errcodeCounts ?? {}).reduce((a, b) => a + b, 0)} 次、RECOVER ${period.recoverCount} 次`

  const { key } = keyEntries[0]
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      },
    )
    const data = await resp.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    return text?.trim() || null
  } catch (e) {
    console.warn('[autospin] 定時彙總報告 AI 分析失敗:', e)
    return null
  }
}

// POST /api/autospin/agent/:id/status-report — Python 引擎定時（間隔可調整）回報累計/本期間統計，組成 Discord embed 發送
router.post('/api/autospin/agent/:id/status-report', async (req, res) => {
  const s = agentSessions.get(req.params.id)
  const { machineType, gameTitleCode, periodMinutes, cumulative, period, uptimeMinutes } = req.body as {
    machineType?: string; gameTitleCode?: string; periodMinutes?: number
    cumulative?: StatusReportStats; period?: StatusReportStats; uptimeMinutes?: number
  }
  if (!machineType || !cumulative || !period) return res.status(400).json({ ok: false, message: 'machineType/cumulative/period 為必填' })
  res.json({ ok: true })  // 先回應，Discord 發送不擋 Python 端

  const webhookUrl = getDiscordWebhookUrl()
  const userLabel = s?.userLabel ?? ''
  if (!webhookUrl || !isDiscordNotifyEnabled(userLabel) || !getStatusReportEnabled(userLabel)) return

  const aiAnalysis = getStatusReportAiEnabled(userLabel)
    ? await generateStatusReportAiAnalysis(req, machineType, periodMinutes ?? 0, cumulative, period, uptimeMinutes)
    : null

  const embed = buildStatusReportEmbed({
    machineType,
    gameTitleCode,
    periodMinutes: periodMinutes ?? 0,
    cumulative,
    period,
    uptimeMinutes,
    fields: getStatusReportFields(userLabel),
    customNote: getStatusReportCustomNote(userLabel),
    aiAnalysis,
  })

  const mention = mentionForUserLabel(userLabel)
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mention || undefined, embeds: [embed] }),
    })
  } catch (e) {
    console.warn('[autospin] 定時彙總報告發送失敗:', e)
  }
})

// POST /api/autospin/status-report-test — 用假資料試發送一則彙總報告，確認格式與 webhook 是否正常（不受啟用開關影響）
router.post('/api/autospin/status-report-test', async (req, res) => {
  const webhookUrl = getDiscordWebhookUrl()
  if (!webhookUrl) return res.status(400).json({ ok: false, message: '尚未設定 Discord Webhook URL' })
  const userLabel = (req.headers['x-user-label'] as string) || ''

  const now = Date.now()
  const sample: { period: StatusReportStats; cumulative: StatusReportStats } = {
    period: {
      spinCount: 42, okSpinCount: 41, winCount: 5, totalWin: 1234, lastCoin: null,
      errcodeCounts: { '5': 1 }, recoverCount: 0, kickoutCount: 1, crChecks: 8, crNoResponse: 0,
      // 假資料也示範「影響」欄位，這樣按試發送就看得到新格式長怎樣
      errImpact: { '5': { count: 1, deducted: 0, unknown: 0, needsReconcile: 0, maxRecoverSec: 2.4, lastDes: 'request timeout' } },
      outcomeCounts: { completed: 30, completed_late: 5, suspected: 8, unknown: 4, not_started: 0 },
    },
    cumulative: {
      spinCount: 1234, okSpinCount: 1200, winCount: 89, totalWin: 34210, lastCoin: 500000,
      errcodeCounts: { '5': 3, '29': 1 },
      errcodeTimes: { '5': [now - 12 * 60000, now - 8 * 60000, now - 3 * 60000], '29': [now - 15 * 60000] },
      recoverCount: 1, kickoutCount: 4, crChecks: 240, crNoResponse: 2,
      // 刻意讓 err29 有一筆扣款疑慮：試發送時才看得出「有問題」跟「沒問題」
      // 在版面上長得不一樣（扣款疑慮會粗體標出來）
      errImpact: {
        '5': { count: 3, deducted: 0, unknown: 0, needsReconcile: 0, maxRecoverSec: 8.2, lastDes: 'service restarting' },
        '29': { count: 1, deducted: 1, unknown: 0, needsReconcile: 1, maxRecoverSec: 31.5, lastDes: 'internal error' },
      },
      // 刻意讓「疑似完成」佔比明顯：試發送時才看得出這欄要拿來幹嘛
      outcomeCounts: { completed: 980, completed_late: 96, suspected: 180, unknown: 70, not_started: 4 },
    },
  }

  // 試發送也一併示範 AI 分析區塊（跟隨開關，關閉時不燒 token）+ tag（用目前登入的操作者當
  // 「發起人」測試對照表有沒有生效），兩者都是 best-effort，失敗不擋測試訊息送出。
  const aiAnalysis = getStatusReportAiEnabled(userLabel)
    ? await generateStatusReportAiAnalysis(req, 'TEST', getStatusReportIntervalMin(userLabel), sample.cumulative, sample.period, 125)
    : null
  const mention = mentionForUserLabel(userLabel || getOperatorFromContext()?.name)

  const embed = buildStatusReportEmbed({
    machineType: 'TEST',
    gameTitleCode: '873-TEST-0001',
    periodMinutes: getStatusReportIntervalMin(userLabel),
    cumulative: sample.cumulative,
    period: sample.period,
    uptimeMinutes: 125,
    fields: getStatusReportFields(userLabel),
    customNote: getStatusReportCustomNote(userLabel),
    isTest: true,
    aiAnalysis,
  })

  try {
    const r = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mention || undefined, embeds: [embed] }),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      return res.status(400).json({ ok: false, message: `Discord API 錯誤 ${r.status}: ${txt.slice(0, 200)}` })
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, message: `送出失敗: ${e}` })
  }
})

function getDiscordWebhookUrl(): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('discord_webhook_url') as { value: string } | undefined
  return row?.value ?? ''
}

// ─── 帳號 → Discord User ID 對照（通知 tag 發起人用）───────────────────────────
// 使用者自己維護「哪個帳號對應哪個 Discord User ID」，AutoSpin 通知（即時彙報 + 定時
// 彙總報告）依 session 是哪個帳號派工啟動的，找得到對照就在訊息 content（不是塞在
// embed 裡，那樣不會真的觸發 Discord 通知/ping）開頭 tag 那個人。

interface DiscordUserMapEntry { userLabel: string; discordUserId: string }

function getDiscordUserMap(): DiscordUserMapEntry[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('autospin_discord_user_map') as { value: string } | undefined
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 依 userLabel（session 派工時的帳號）找出對應的 Discord mention 字串（含結尾空白），找不到回傳空字串。 */
function mentionForUserLabel(userLabel: string | undefined): string {
  if (!userLabel) return ''
  const entry = getDiscordUserMap().find(e => e.userLabel === userLabel)
  return entry?.discordUserId ? `<@${entry.discordUserId}> ` : ''
}

// GET /api/autospin/discord-user-map
router.get('/api/autospin/discord-user-map', (_req, res) => {
  res.json({ ok: true, map: getDiscordUserMap() })
})

// POST /api/autospin/discord-user-map — 整份覆蓋儲存
router.post('/api/autospin/discord-user-map', (req, res) => {
  const body = z.object({
    map: z.array(z.object({ userLabel: z.string().min(1), discordUserId: z.string().min(1) })),
  }).parse(req.body)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('autospin_discord_user_map', JSON.stringify(body.map))
  res.json({ ok: true })
})

/** 預設啟用（尚未設定過開關時，維持既有行為：只要有填 URL 就會發送）。依帳號分開，
 * 尚未存過個人設定的帳號 fallback 讀舊版全域值。 */
function isDiscordNotifyEnabled(userLabel: string): boolean {
  const row = getNotifyPrefsRow(userLabel)
  if (row) return row.notifyEnabled !== 0
  return legacySetting('discord_notify_enabled') !== '0'
}

type NotifyFieldKey = 'gameUrl' | 'spinCount' | 'errorSummary' | 'screenshotUrl'
const DEFAULT_NOTIFY_FIELDS: Record<NotifyFieldKey, boolean> = {
  gameUrl: true, spinCount: true, errorSummary: true, screenshotUrl: true,
}

/** 哪些欄位要顯示在通知卡片上（狀態欄固定顯示，不受此設定影響）。依帳號分開。 */
function getDiscordNotifyFields(userLabel: string): Record<NotifyFieldKey, boolean> {
  const row = getNotifyPrefsRow(userLabel)
  const raw = row ? row.notifyFields : legacySetting('discord_notify_fields')
  if (!raw) return { ...DEFAULT_NOTIFY_FIELDS }
  try {
    return { ...DEFAULT_NOTIFY_FIELDS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_NOTIFY_FIELDS }
  }
}

const DEFAULT_TITLE_TEMPLATE = 'AutoSpin — {machineType}'

/** 訊息標題模板，{machineType} 會被實際機台代碼取代。 */
function getDiscordTitleTemplate(): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('discord_notify_title_template') as { value: string } | undefined
  const tpl = row?.value?.trim()
  return tpl || DEFAULT_TITLE_TEMPLATE
}

/** 自訂頁尾文字（選填，例如公司代號），空字串＝不顯示。 */
function getDiscordFooterText(): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('discord_notify_footer') as { value: string } | undefined
  return row?.value ?? ''
}

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
  const sessionOperator = getOperatorFromContext()

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
    addHistory('autospin', `AutoSpin 執行`, `已執行 ${Math.round((Date.now() - state.startedAt) / 1000)} 秒`, { sessionId, exitCode: code }, { operator: sessionOperator ?? undefined })
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
  // LuckyLink poller state — replayed on SSE reconnect so panel survives refresh
  luckylinkJpGroupCode?: string
  luckylinkConnected?: boolean
  luckylinkPoolSnapshot?: Record<string, unknown> | null
  luckylinkAlerts?: Record<string, unknown>[]
}

const agentSessions = new Map<string, AgentSession>()

// ─── agentSessions 持久化（worker 重啟不弄丟正在跑的 session）──────────────────
// agentSessions 本來完全只存在記憶體，worker process 一重啟（部署新代碼的日常操作）就整批
// 消失，正在跑的 AutoSpin session 只能依賴 Python 端「偵測 session 遺失 → 重連」這條有風險
// 的路徑復原（也是本次要一起修的 poll_stop() 重連日誌不夠明顯的問題）。改成每 5 秒把目前所有
// session 的快照（不含 logs/screenshots——那兩個純粹是即時檢視用的記憶體 buffer，重啟遺失也
// 沒差，Discord/歷史紀錄等真正重要的資料本來就有各自獨立寫入 DB）寫進 autospin_agent_sessions
// 表；worker 啟動時（模組載入當下）優先從這張表復原，不再需要仰賴 Python 端重連才能恢復。
// 復原後沿用既有的 30 秒心跳逾時自動過期邏輯（/agent/status 裡）判斷是真的還在跑還是已經死了，
// 不需要在這裡自己重複一套 staleness 判斷。
{
  const rows = db.prepare('SELECT id, data FROM autospin_agent_sessions').all() as { id: string; data: string }[]
  let restored = 0
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data) as Omit<AgentSession, 'logs' | 'screenshots'>
      agentSessions.set(row.id, { ...parsed, logs: [], screenshots: [] })
      restored++
    } catch {
      db.prepare('DELETE FROM autospin_agent_sessions WHERE id = ?').run(row.id)
    }
  }
  if (restored > 0) console.log(`[autospin] 已從 DB 復原 ${restored} 筆 AutoSpin agent session`)
}

function persistAgentSessionSnapshot() {
  const upsert = db.prepare(`
    INSERT INTO autospin_agent_sessions (id, data, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
  `)
  const del = db.prepare('DELETE FROM autospin_agent_sessions WHERE id = ?')
  const existingIds = new Set(
    (db.prepare('SELECT id FROM autospin_agent_sessions').all() as { id: string }[]).map(r => r.id),
  )
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const [id, s] of agentSessions.entries()) {
      const { logs: _logs, screenshots: _screenshots, ...rest } = s
      upsert.run(id, JSON.stringify(rest), now)
      existingIds.delete(id)
    }
    // 剩下的是記憶體裡已經不存在的 session（被 GC 掉了）——DB 也一併清掉，避免累積殭屍資料
    for (const staleId of existingIds) del.run(staleId)
  })
  tx()
}
setInterval(persistAgentSessionSnapshot, 5000)
const agentSseClients = new Map<string, Set<import('express').Response>>()

// ─── Discord 即時彙報通知 ───────────────────────────────────────────────────────
// 每台機台一則訊息：queued/running 建立訊息，之後狀態變化改用同一則訊息編輯（PATCH），
// 不會每次更新都發新訊息洗版。Webhook URL 從 settings 讀，不寫死頻道。
type NotifyStatus = 'queued' | 'running' | 'success' | 'failed' | 'stopped'
const NOTIFY_STATUS_META: Record<NotifyStatus, { label: string; color: number; emoji: string }> = {
  queued: { label: '排隊中', color: 0x6b7280, emoji: '⏳' },
  running: { label: '執行中', color: 0x3b82f6, emoji: '▶️' },
  success: { label: '已完成', color: 0x22c55e, emoji: '✅' },
  failed: { label: '失敗', color: 0xef4444, emoji: '❌' },
  stopped: { label: '已停止', color: 0x9ca3af, emoji: '⏹️' },
}
const discordNotifyState = new Map<string, { messageId: string; status: NotifyStatus }>()

function buildDiscordEmbed(
  status: NotifyStatus, machineType: string,
  opts: { gameUrl?: string; spinCount?: number; errorSummary?: string; screenshotUrl?: string },
  userLabel: string,
) {
  const meta = NOTIFY_STATUS_META[status]
  const enabledFields = getDiscordNotifyFields(userLabel)
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: '狀態', value: `${meta.emoji} ${meta.label}`, inline: true },
  ]
  if (enabledFields.spinCount) fields.push({ name: 'Spin 數', value: String(opts.spinCount ?? 0), inline: true })
  if (enabledFields.gameUrl && opts.gameUrl) fields.push({ name: 'Game URL', value: opts.gameUrl.length > 300 ? opts.gameUrl.slice(0, 300) + '…' : opts.gameUrl })
  if (enabledFields.errorSummary && opts.errorSummary) fields.push({ name: '錯誤摘要', value: opts.errorSummary.slice(0, 500) })
  if (enabledFields.screenshotUrl && opts.screenshotUrl) fields.push({ name: '截圖', value: opts.screenshotUrl })
  const title = `${meta.emoji} ${getDiscordTitleTemplate().replace(/\{machineType\}/g, machineType)}`
  const footer = getDiscordFooterText()
  return {
    title,
    color: meta.color,
    fields,
    timestamp: new Date().toISOString(),
    ...(footer ? { footer: { text: footer } } : {}),
  }
}

/** Session 結束時，對這個 session 底下每台機台送出最終狀態（success/failed，依是否曾有異常記錄判斷）。 */
async function finalizeSessionNotifications(sessionId: string) {
  const keys = [...discordNotifyState.keys()].filter(k => k.startsWith(`${sessionId}:`))
  const session = agentSessions.get(sessionId)
  for (const key of keys) {
    const state = discordNotifyState.get(key)
    if (!state || state.status === 'success' || state.status === 'failed' || state.status === 'stopped') continue
    const machineType = key.slice(sessionId.length + 1)
    const anomalyRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM autospin_history WHERE sessionId = ? AND machineType = ? AND isAnomaly = 1"
    ).get(sessionId, machineType) as { cnt: number } | undefined
    const lastRow = db.prepare(
      'SELECT spinCount FROM autospin_history WHERE sessionId = ? AND machineType = ? ORDER BY id DESC LIMIT 1'
    ).get(sessionId, machineType) as { spinCount: number } | undefined
    const status: NotifyStatus = (anomalyRow?.cnt ?? 0) > 0 ? 'failed' : 'success'
    await notifyDiscord(sessionId, machineType, status, {
      spinCount: lastRow?.spinCount ?? 0,
      screenshotUrl: session ? latestScreenshotUrl(session, machineType) : undefined,
    }).catch(() => {})
  }
}

/** 建立或更新（同一則訊息）指定機台的 Discord 通知。webhook 未設定或開關關閉時直接跳過。 */
async function notifyDiscord(
  sessionId: string, machineType: string, status: NotifyStatus,
  opts: { gameUrl?: string; spinCount?: number; errorSummary?: string; screenshotUrl?: string } = {},
) {
  const webhookUrl = getDiscordWebhookUrl()
  const userLabel = agentSessions.get(sessionId)?.userLabel ?? ''
  if (!webhookUrl || !isDiscordNotifyEnabled(userLabel)) return
  const key = `${sessionId}:${machineType}`
  const existing = discordNotifyState.get(key)
  const embed = buildDiscordEmbed(status, machineType, opts, userLabel)
  const mention = mentionForUserLabel(userLabel)
  try {
    if (existing) {
      const r = await fetch(`${webhookUrl}/messages/${existing.messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: mention || undefined, embeds: [embed] }),
      })
      if (r.ok) {
        existing.status = status
      } else {
        // 訊息可能已被刪除，改發一則新的
        discordNotifyState.delete(key)
        await notifyDiscord(sessionId, machineType, status, opts)
      }
    } else {
      const r = await fetch(`${webhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: mention || undefined, embeds: [embed] }),
      })
      if (r.ok) {
        const data = await r.json() as { id?: string }
        if (data.id) discordNotifyState.set(key, { messageId: data.id, status })
      }
    }
  } catch (e) {
    console.warn('[autospin] Discord 通知失敗:', e)
  }
}

// ── Periodic session GC ───────────────────────────────────────────────────────
// Purge stopped/old sessions older than 2 hours to prevent unbounded memory growth.
const SESSION_GC_MAX_AGE_MS = 2 * 60 * 60 * 1000  // 2 hours
setInterval(() => {
  const cutoff = Date.now() - SESSION_GC_MAX_AGE_MS
  // Python-subprocess sessions
  for (const [id, s] of sessions.entries()) {
    if (s.status !== 'running' && s.startedAt < cutoff) {
      sessions.delete(id)
      sseClients.get(id)?.forEach(r => { try { r.end() } catch { /* ignore */ } })
      sseClients.delete(id)
    }
  }
  // Agent sessions
  for (const [id, s] of agentSessions.entries()) {
    if (s.status !== 'running' && s.startedAt < cutoff) {
      agentSessions.delete(id)
      agentSseClients.get(id)?.forEach(r => { try { r.end() } catch { /* ignore */ } })
      agentSseClients.delete(id)
      // 同步清掉這個 session 底下所有機台的 Discord 通知狀態
      for (const key of discordNotifyState.keys()) {
        if (key.startsWith(`${id}:`)) discordNotifyState.delete(key)
      }
    }
  }
}, 15 * 60 * 1000)  // run every 15 min

function broadcastAgentLog(sessionId: string, line: string) {
  appendSessionLog(sessionId, line)
  const s = agentSessions.get(sessionId)
  if (s) {
    s.logs.push(line)
    if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS)
  }
  const clients = agentSseClients.get(sessionId)
  if (clients) for (const r of clients) r.write(`data: ${JSON.stringify({ line })}\n\n`)
}

/** Broadcast a structured LuckyLink event to SSE clients (parsed separately from log lines).
 *  Also persists the latest state so reconnecting clients get a snapshot replay. */
function broadcastLuckylinkEvent(sessionId: string, event: object) {
  const s = agentSessions.get(sessionId)
  if (s) {
    const evt = event as { type?: string; data?: Record<string, unknown> }
    if (evt.type === 'luckylink_start') {
      const d = (evt.data ?? {}) as { jpGroupCode?: string }
      s.luckylinkJpGroupCode = d.jpGroupCode ?? ''
      s.luckylinkConnected = true
      s.luckylinkPoolSnapshot = null
      s.luckylinkAlerts = []
    } else if (evt.type === 'luckylink_pool') {
      s.luckylinkPoolSnapshot = event as Record<string, unknown>
    } else if (evt.type === 'luckylink_alert') {
      s.luckylinkAlerts = [...(s.luckylinkAlerts ?? []).slice(-19), event as Record<string, unknown>]
    } else if (evt.type === 'luckylink_stop' || evt.type === 'luckylink_error') {
      s.luckylinkConnected = false
    }
  }
  const clients = agentSseClients.get(sessionId)
  if (clients) for (const r of clients) r.write(`data: ${JSON.stringify({ luckylink_event: event })}\n\n`)
}

/** Exported so worker.ts can forward luckylink_event from agent WebSocket into AutoSpin SSE */
export { broadcastAgentLog, broadcastLuckylinkEvent }

// POST /api/autospin/agent/start — agent registers and gets configs
router.post('/api/autospin/agent/start', (req, res) => {
  const userLabel = (req.body as { userLabel?: string }).userLabel ?? ''
  const heavyTask = tryStartHeavyTask(req, 'autospin-agent', 'AutoSpin Agent')
  let sessionId: string
  let isNewSession = false
  if (!heavyTask.ok) {
    // 多進程架構下（每台機台一個獨立 process），同一次派工底下的每個 machine_worker() 都各自
    // 獨立輪詢 /should-stop；一旦 session 遺失（例如伺服器重啟，記憶體內的 agentSessions 被清空），
    // 每個 process 會各自嘗試重新呼叫這支 API 登錄——第一個成功的會拿到新 session、佔走這個
    // userLabel 的 heavy-task 名額，緊接著幾乎同時打進來的其他 process 只會看到「已被佔用」而
    // 失敗（Python 端會出現 KeyError: 'sessionId'，因為衝突回應沒有這個欄位）。這種情況不是真的
    // 衝突（不是使用者手動又點了一次派工），只要衝突對象本身也是 autospin-agent、而且已經有一個
    // 屬於同一個 userLabel 的 running session（就是剛剛那個搶到名額的 process 建立的），直接讓
    // 這個 process 加入既有 session 就好，不要擋下來讓它永遠卡在重連失敗。
    const existing = [...agentSessions.values()].find(s => s.status === 'running' && s.userLabel === userLabel)
    if (heavyTask.task.type === 'autospin-agent' && existing) {
      sessionId = existing.id
    } else {
      return res.status(429).json(heavyTaskConflict(heavyTask.task))
    }
  } else {
    // Stop any existing agent sessions for this user
    for (const s of agentSessions.values()) {
      if (!userLabel || s.userLabel === userLabel) {
        s.status = 'stopped'
        finishHeavyTask(s.heavyTask)
      }
    }
    sessionId = `agent-${Date.now()}`
    isNewSession = true
    agentSessions.set(sessionId, {
      id: sessionId, status: 'running', startedAt: Date.now(), lastHeartbeat: Date.now(),
      logs: [], screenshots: [], stopRequested: false, pauseRequested: false, userLabel, spinIntervalOverride: null,
      heavyTask: heavyTask.token,
    })
  }
  // Return configs merged with machine_test_profiles selectors
  // （entryTouchPoints/entryTouchPoints2 讓 AutoSpin 的進入機台流程與 Machine Test 完全一致）
  const configs = readConfigs(userLabel)
  const profiles = db.prepare('SELECT machineType, spinSelector, balanceSelector, entryTouchPoints, entryTouchPoints2, bonusAction, touchPoints, clickTake, ideck_xpaths FROM machine_test_profiles').all() as
    { machineType: string; spinSelector: string | null; balanceSelector: string | null; entryTouchPoints: string | null; entryTouchPoints2: string | null; bonusAction: string | null; touchPoints: string | null; clickTake: number | null; ideck_xpaths: string | null }[]
  const profileMap = Object.fromEntries(profiles.map(p => [p.machineType, p]))
  const parseTouchPoints = (v: string | null | undefined): string[] => {
    if (!v) return []
    try { const arr = JSON.parse(v); return Array.isArray(arr) ? arr : [] } catch { return [] }
  }
  // 機種設定檔對應用 gameTitleCode 的中段（例如 "873-DFDC-0003" 取 "DFDC"）當 key，不用 AutoSpin
  // 自己那個使用者手打、格式不受控的 machineType —— 中段本來就是 machine_test_profiles.machineType
  // 的來源慣例（機種識別碼），比對更準；gameTitleCode 格式不對時 fallback 回 machineType。
  const profileKeyFor = (c: { machineType: string; gameTitleCode?: string }): string => {
    const parts = (c.gameTitleCode || '').split('-')
    return parts.length >= 3 ? parts[1].toUpperCase() : c.machineType
  }
  // bonusAction/touchPoints/clickTake/ideckXpaths：讓 AutoSpin 也能執行跟 Machine Test 一樣的特殊遊戲
  // 處理動作與隨機下注 XPath（只讀取 machine_test_profiles，不動 Machine Test 自己的程式碼）。
  // ideckXpaths 原本是獨立的 bet_random.json + 「隨機下注」頁面在管，2026-07-30 起改成完全共用
  // machine_test_profiles 的 ideck_xpaths（該欄位當初設計就是要取代 bet_random.json，見
  // machine-test/types.ts 的欄位註解「replaces ideckRowClass + betRandomConfig」，只是先前從未
  // 真的接上 AutoSpin 這邊）；舊資料已一次性遷移進 machine_test_profiles（沒有對應機種的新建、
  // 已有資料的補齊，已有資料且不同的保留原樣不覆蓋），沒有任何 XPath 因此次改動而遺失。
  const merged = configs.map(c => ({
    ...c,
    enabled: !!c.enabled,
    spinSelector: profileMap[profileKeyFor(c)]?.spinSelector ?? null,
    balanceSelector: profileMap[profileKeyFor(c)]?.balanceSelector ?? null,
    entryTouchPoints: parseTouchPoints(profileMap[profileKeyFor(c)]?.entryTouchPoints),
    entryTouchPoints2: parseTouchPoints(profileMap[profileKeyFor(c)]?.entryTouchPoints2),
    bonusAction: profileMap[profileKeyFor(c)]?.bonusAction ?? 'auto_wait',
    touchPoints: parseTouchPoints(profileMap[profileKeyFor(c)]?.touchPoints),
    clickTake: !!profileMap[profileKeyFor(c)]?.clickTake,
    ideckXpaths: parseTouchPoints(profileMap[profileKeyFor(c)]?.ideck_xpaths),
  }))
  // Load keyword_actions and machine_actions from actions.json
  let keywordActions: Record<string, string[]> = {}
  let machineActions: Record<string, { positions: string[]; clickTake: boolean }> = {}
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
  } catch { /* ignore */ }
  // 逐台已啟用機台送出「排隊中」Discord 通知（fire-and-forget，不影響回應速度）——只有真的新建
  // session 才發；重連加入既有 session 時機台可能早就在跑了，不能把通知蓋回「排隊中」。
  if (isNewSession) {
    for (const c of merged) {
      if (c.enabled) notifyDiscord(sessionId, c.machineType, 'queued', { gameUrl: c.gameUrl }).catch(() => {})
    }
  }
  // screenshotEnabled 是帳號層級偏好（不是逐機台設定），放頂層給 Python 端在 main() 存成全域變數
  res.json({ ok: true, sessionId, configs: merged, keywordActions, machineActions, screenshotEnabled: isScreenshotEnabled(userLabel) })
})

// POST /api/autospin/agent/:id/log — agent posts a log line（或一次多行 lines[]，供背景佇列批次上傳用）
router.post('/api/autospin/agent/:id/log', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  const { line, lines } = req.body as { line?: string; lines?: string[] }
  if (Array.isArray(lines)) {
    for (const l of lines) broadcastAgentLog(req.params.id, l ?? '')
  } else {
    broadcastAgentLog(req.params.id, line ?? '')
  }
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
    finalizeSessionNotifications(req.params.id).catch(() => {})
  }
  res.json({ ok: true })
})

// GET /api/autospin/agent/:id/should-stop — agent polls for stop command (also serves as heartbeat)
router.get('/api/autospin/agent/:id/should-stop', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) {
    // Session not found (server restarted) — tell agent to reconnect, not stop
    return res.json({ stop: false, sessionNotFound: true, pause: false, spinInterval: null })
  }
  if (s.status === 'running') s.lastHeartbeat = Date.now()
  res.json({
    stop: s.stopRequested || s.status === 'stopped',
    pause: s.pauseRequested ?? false,
    spinInterval: s.spinIntervalOverride ?? null,
    // OSMWatcher 狀態（key=gmid），AutoSpin 每 3 秒隨心跳一起拿到，判斷是否進入特殊遊戲
    osmStatus: Object.fromEntries(osmMachineStatus),
    // 定時彙總報告設定（間隔可即時調整，不用重啟 Agent；依派工帳號各自的設定）
    statusReportEnabled: getStatusReportEnabled(s.userLabel),
    statusReportIntervalMin: getStatusReportIntervalMin(s.userLabel),
  })
})

/** 前端呼叫帶自己的帳號（一般 fetch 用 x-user-label header；EventSource/<img> 這類無法自訂
 * header 的請求用 ?userLabel= query），跟 session 建立時記錄的 userLabel 比對，避免知道
 * 別人 sessionId 就能直接操作/讀取其他操作者的 session（agent 端自己上報用的端點不需要這個）。 */
function requestUserLabel(req: import('express').Request): string {
  return (req.headers['x-user-label'] as string) || (req.query.userLabel as string) || ''
}

// POST /api/autospin/agent/:id/pause — frontend pauses the agent
router.post('/api/autospin/agent/:id/pause', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  if (s.userLabel !== requestUserLabel(req)) return res.status(403).json({ ok: false, message: '無權限操作此 session' })
  s.pauseRequested = true
  broadcastAgentLog(req.params.id, '[Agent] 已暫停')
  return res.json({ ok: true })
})

// POST /api/autospin/agent/:id/resume — frontend resumes the agent
router.post('/api/autospin/agent/:id/resume', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  if (s.userLabel !== requestUserLabel(req)) return res.status(403).json({ ok: false, message: '無權限操作此 session' })
  s.pauseRequested = false
  broadcastAgentLog(req.params.id, '[Agent] 已繼續')
  return res.json({ ok: true })
})

// POST /api/autospin/agent/:id/spin-interval — frontend sets runtime spin interval
router.post('/api/autospin/agent/:id/spin-interval', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).json({ ok: false })
  if (s.userLabel !== requestUserLabel(req)) return res.status(403).json({ ok: false, message: '無權限操作此 session' })
  const v = parseFloat((req.body as { value?: string }).value ?? '')
  s.spinIntervalOverride = isNaN(v) ? null : Math.max(0.1, Math.min(60, v))
  return res.json({ ok: true, spinInterval: s.spinIntervalOverride })
})

// POST /api/autospin/agent/stop-all — frontend stops the agent（只停自己帳號的 session，
// 不能連其他操作者正在跑的機台也一起停掉）
router.post('/api/autospin/agent/stop-all', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  for (const s of agentSessions.values()) {
    if (s.status === 'running' && s.userLabel === userLabel) {
      s.stopRequested = true
      finishHeavyTask(s.heavyTask)
    }
  }
  res.json({ ok: true })
})

// GET /api/autospin/agent/status — frontend polls agent status
// 依 x-user-label 只回傳目前登入帳號自己派工的 session，不同帳號各自看到各自的畫面
// （不再是「不管誰的，抓第一個在跑的」，避免不同操作者互相看到彼此的執行日誌/截圖）。
router.get('/api/autospin/agent/status', (req, res) => {
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const HEARTBEAT_TIMEOUT = 30_000 // 30s — agent polls every 3s
  let active: AgentSession | undefined
  for (const s of agentSessions.values()) {
    if (s.status !== 'running') continue
    // Auto-expire if agent stopped sending heartbeats
    if (Date.now() - s.lastHeartbeat > HEARTBEAT_TIMEOUT) {
      s.status = 'stopped'
      finishHeavyTask(s.heavyTask)
      broadcastAgentLog(s.id, '[Agent] 連線逾時，已標記為離線')
      finalizeSessionNotifications(s.id).catch(() => {})
      continue
    }
    if (s.userLabel === userLabel) active = s
  }
  res.json({ ok: true, running: !!active, sessionId: active?.id ?? null, startedAt: active?.startedAt ?? null })
})

// ─── agent-hub 派工（A2）：把 AutoSpin 派給已連線的 Local Agent 執行 ───────────
// 列出此操作者擁有、支援 autospin 的線上 agent
router.get('/api/autospin/hub-agents', (_req, res) => {
  const operator = getOperatorFromContext()
  if (!operator?.key) return res.json({ ok: true, agents: [] })
  const agents = [...agentConnections.values()]
    .filter(a => a.ownerKey === operator.key && a.capabilities.includes('autospin'))
    .map(a => ({
      agentId: a.agentId,
      hostname: a.hostname,
      ownerName: a.ownerName,
      capabilities: a.capabilities,
      // 派工前先讓人知道這台是不是落後（顯示但不擋——落後不一定影響這次要跑的功能，
      // 急著測的時候被擋住更煩；跟 CodeX 討論定案）
      updateStatus: agentUpdateStatus(a),
      busy: a.busy,
      connectedAt: a.connectedAt,
      lastSeenAt: a.lastSeenAt,
      sessionId: a.sessionId,
    }))
  res.json({ ok: true, agents })
})

// POST /api/autospin/hub-dispatch { agentId, luckylinkConfig? } — 命令選定的 agent 啟動 AutoSpin（spawn Python 引擎）
router.post('/api/autospin/hub-dispatch', (req, res) => {
  const operator = getOperatorFromContext()
  if (!operator?.key) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const body = req.body as { agentId?: string; luckylinkConfig?: { enabled: boolean; jpGroupCode: string; pollIntervalSec: number } }
  const agentId = String(body.agentId ?? '').trim()
  // 指定 agentId 時直接查連線（即使 busy 旗標殘留也允許重新派工；agent-runner 會先 kill 舊 Python 再啟新的，不會雙開）
  let agent
  if (agentId) {
    const a = agentConnections.get(agentId)
    if (a && a.ownerKey === operator.key && a.capabilities.includes('autospin') && a.ws.readyState === a.ws.OPEN) agent = a
  } else {
    agent = getAvailableAgents({ operatorKey: operator.key, capability: 'autospin' })[0]
  }
  if (!agent) {
    return res.status(409).json({ ok: false, message: agentId ? '選定的 Agent 不可用（離線）' : '沒有可用的 AutoSpin Agent' })
  }

  // Resolve JP Group config from DB if luckylinkConfig is enabled
  let resolvedLuckylink: { enabled: boolean; jpGroupCode: string; pollIntervalSec: number; luckylinkUrl: string; luckylinkGroupName: string; loginUser: string; loginPass: string; gameCodes: string[]; environment: string } | undefined
  if (body.luckylinkConfig?.enabled) {
    // Fail loudly if caller sent enabled:true but omitted jpGroupCode
    if (!body.luckylinkConfig.jpGroupCode) {
      return res.status(400).json({ ok: false, message: 'luckylinkConfig.enabled=true 但未帶 jpGroupCode' })
    }
    // Clamp pollIntervalSec to 10–3600; reject non-numeric
    const rawPoll = body.luckylinkConfig.pollIntervalSec
    if (rawPoll !== undefined && (typeof rawPoll !== 'number' || !Number.isFinite(rawPoll))) {
      return res.status(400).json({ ok: false, message: 'luckylinkConfig.pollIntervalSec 必須為數字' })
    }
    const pollIntervalSec = typeof rawPoll === 'number' ? Math.max(10, Math.min(3600, Math.round(rawPoll))) : 60

    const jpGroup = db.prepare('SELECT * FROM jp_groups WHERE code=? AND enabled=1').get(body.luckylinkConfig.jpGroupCode) as JpGroupRow | undefined
    if (!jpGroup) return res.status(400).json({ ok: false, message: `JP Group "${body.luckylinkConfig.jpGroupCode}" 不存在或已停用` })
    let gameCodes: string[] = []
    try { gameCodes = JSON.parse(jpGroup.game_codes || '[]') } catch { /* bad data */ }
    resolvedLuckylink = {
      enabled: true,
      jpGroupCode: jpGroup.code,
      pollIntervalSec,
      luckylinkUrl: jpGroup.luckylink_url,
      luckylinkGroupName: jpGroup.luckylink_group_name,
      loginUser: jpGroup.login_user ?? 'admin',
      loginPass: jpGroup.login_pass ?? '123456',
      gameCodes,
      environment: jpGroup.environment,
    }
  }

  const dispatchId = `hub-${Date.now()}`
  agent.busy = true
  agent.sessionId = dispatchId
  agent.ws.send(JSON.stringify({ type: 'autospin_start', sessionId: dispatchId, userLabel, luckylinkConfig: resolvedLuckylink ?? { enabled: false } }))
  res.json({ ok: true, agentId: agent.agentId, hostname: agent.hostname, dispatchId })
})

// POST /api/autospin/hub-stop { agentId? } — 命令 agent 停止 AutoSpin
router.post('/api/autospin/hub-stop', (req, res) => {
  const operator = getOperatorFromContext()
  if (!operator?.key) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
  const userLabel = (req.headers['x-user-label'] as string) || ''
  const agentId = String((req.body as { agentId?: string }).agentId ?? '').trim()
  let stopped = 0
  for (const a of agentConnections.values()) {
    if (a.ownerKey !== operator.key || !a.capabilities.includes('autospin')) continue
    if (agentId && a.agentId !== agentId) continue
    if (a.ws.readyState === a.ws.OPEN) {
      a.ws.send(JSON.stringify({ type: 'stop', sessionId: a.sessionId ?? '' }))
      stopped++
    }
    // 立即釋放此 agent，避免 busy 旗標殘留導致無法重新派工 / UI 一直顯示忙碌
    a.busy = false
    a.sessionId = null
  }
  // 同步請求 Python 端的 agent session 停止（雙保險：should-stop 輪詢）
  for (const s of agentSessions.values()) {
    if (s.status === 'running' && (!userLabel || s.userLabel === userLabel)) s.stopRequested = true
  }
  res.json({ ok: true, stopped })
})

// GET /api/autospin/agent/stream/:id — SSE log stream for frontend
// Optional ?from=N skips the first N stored logs (avoids duplicate replay on reconnect)
router.get('/api/autospin/agent/stream/:id', (req, res) => {
  const { id } = req.params
  const fromIndex = parseInt(req.query.from as string ?? '0') || 0
  const s = agentSessions.get(id)
  if (s && s.userLabel !== requestUserLabel(req)) return res.status(403).end()
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  if (s) {
    for (const line of s.logs.slice(fromIndex)) res.write(`data: ${JSON.stringify({ line })}\n\n`)
    // Replay latest LuckyLink state so reconnecting clients can initialize the JP panel
    if (s.luckylinkJpGroupCode !== undefined) {
      const startEvt = { type: 'luckylink_start', data: { jpGroupCode: s.luckylinkJpGroupCode, replayed: true }, ts: new Date().toISOString() }
      res.write(`data: ${JSON.stringify({ luckylink_event: startEvt })}\n\n`)
      if (s.luckylinkPoolSnapshot) res.write(`data: ${JSON.stringify({ luckylink_event: s.luckylinkPoolSnapshot })}\n\n`)
      for (const a of (s.luckylinkAlerts ?? [])) res.write(`data: ${JSON.stringify({ luckylink_event: a })}\n\n`)
    }
  }
  if (!agentSseClients.has(id)) agentSseClients.set(id, new Set())
  agentSseClients.get(id)!.add(res)
  req.on('close', () => agentSseClients.get(id)?.delete(res))
})

// GET /api/autospin/agent/screenshot/:id/:name — serve a screenshot
router.get('/api/autospin/agent/screenshot/:id/:name', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.status(404).send('Not found')
  if (s.userLabel !== requestUserLabel(req)) return res.status(403).send('Forbidden')
  const shot = s.screenshots.find(sc => sc.name === req.params.name)
  if (!shot) return res.status(404).send('Not found')
  res.setHeader('Content-Type', 'image/png')
  res.send(shot.buffer)
})

// GET /api/autospin/agent/screenshots/:id — list screenshots
router.get('/api/autospin/agent/screenshots/:id', (req, res) => {
  const s = agentSessions.get(req.params.id)
  if (!s) return res.json({ ok: true, files: [] })
  if (s.userLabel !== requestUserLabel(req)) return res.status(403).json({ ok: false, files: [] })
  res.json({ ok: true, files: s.screenshots.map(sc => ({ name: sc.name, time: sc.time })).reverse() })
})

/** Resolve the public server base URL — env var overrides for reverse-proxy setups */
const resolveServerUrl = (req: import('express').Request): string => {
  if (process.env.TOPPATH_BASE_URL) return process.env.TOPPATH_BASE_URL
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http'
  const host  = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost:3000'
  return `${proto}://${host}`
}

/** 背景/通知用途取伺服器對外網址，沒設 env 就退回 localhost（僅影響 Discord 通知裡的截圖連結）*/
const backgroundServerUrl = (): string => process.env.TOPPATH_BASE_URL || 'http://localhost:3000'

/** 找出指定機台最新一張截圖的可存取網址，供 Discord 通知附上截圖連結 */
function latestScreenshotUrl(s: AgentSession, machineType: string): string | undefined {
  for (let i = s.screenshots.length - 1; i >= 0; i--) {
    if (s.screenshots[i].name.startsWith(`${machineType}_`)) {
      return `${backgroundServerUrl()}/api/autospin/agent/screenshot/${s.id}/${encodeURIComponent(s.screenshots[i].name)}`
    }
  }
  return undefined
}

// GET /api/autospin/agent/download/launcher.bat?server=... — serve launcher with embedded server URL
router.get('/api/autospin/agent/download/launcher.bat', (req, res) => {
  const serverUrl = (req.query.server as string) || resolveServerUrl(req)
  const bat = `@echo off\r\ncurl -fsSL -o "%~dp0toppath-agent.py" "${serverUrl}/api/autospin/agent/download/agent.py" >nul 2>&1\r\npython "%~dp0toppath-agent.py" "%1"\r\nif errorlevel 1 pause\r\n`
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', 'attachment; filename="launch-agent.bat"')
  res.send(bat)
})

// GET /api/autospin/agent/download/launcher-mac.sh?server=... — serve macOS launcher script
router.get('/api/autospin/agent/download/launcher-mac.sh', (req, res) => {
  const serverUrl = (req.query.server as string) || resolveServerUrl(req)
  const sh = `#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/toppath-agent"
PYTHON_BIN="$INSTALL_DIR/.venv/bin/python"
AGENT_SCRIPT="$INSTALL_DIR/toppath-agent.py"
SERVER_URL="${serverUrl}"
URI="\${1:-}"

mkdir -p "$INSTALL_DIR"
# Always download the latest agent script on each launch
curl -fsSL "$SERVER_URL/api/autospin/agent/download/agent.py" -o "$AGENT_SCRIPT"

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
  const serverUrl = resolveServerUrl(req)
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
curl -fsSL -o "%INSTALL_DIR%\\toppath-agent.py" "%TOPPATH_SERVER%/api/autospin/agent/download/agent.py"
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
curl -fsSL -o "%INSTALL_DIR%\\launch-agent.bat" "%TOPPATH_SERVER%/api/autospin/agent/download/launcher.bat?server=%TOPPATH_SERVER%"
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
  const serverUrl = resolveServerUrl(req)
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

  // Discord 通知：queued → running（第一筆 history 就代表 Python 引擎已進入機台開始跑），
  // 之後每筆 history 更新同一則訊息的 spin 數；低餘額等異常事件附上摘要
  const cfg = readConfigs(s.userLabel).find(c => c.machineType === body.machineType)
  const errorSummary = body.event === 'low_balance' || isAnomaly ? body.note || '偵測到餘額異常' : undefined
  notifyDiscord(s.id, body.machineType, 'running', {
    gameUrl: cfg?.gameUrl,
    spinCount: body.spinCount,
    errorSummary,
    screenshotUrl: latestScreenshotUrl(s, body.machineType),
  }).catch(() => {})

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
/**
 * 後台對帳的連線設定。
 *
 * ⚠️ 這頁原本有一整塊手填表單（Base URL／Origin／Token／Channel／帳密），存在自己的
 *    `reconcile_config` 表——但那張表**實際上是空的**（0 筆，從沒被存過），而
 *    Meter／DayCount 共用的 `meter_reconcile_config` 早就有完整一份、值還一模一樣
 *    （同樣的 backendservertest / qat-cp / 873 / 帳密），**而且兩邊打的是同一組 API**
 *    （`/egm/reports/gameRecordList`）。等於使用者被要求重填一份已經存在的設定。
 *
 *    所以改成直接讀共用設定，依環境取 `osm_` 或 `gcp_` 前綴那組。
 *
 * ⚠️ `reconcile_config` 仍然優先：它存的是登入後拿到的 token/lastlogintime
 *    （見 `/reconcile/login`），那是這支自己維護的登入狀態，不能被共用設定蓋掉。
 *    共用設定只補「連線目標與帳密」這些底層欄位。
 */
type ReconcileEnv = 'osm' | 'gcp'

function loadReconcileConfig(env: ReconcileEnv = 'osm') {
  const cfg: Record<string, string> = {}

  // 先鋪共用設定（依環境挑前綴），再讓自己的表覆蓋上去
  const shared = db.prepare('SELECT key, value FROM meter_reconcile_config').all() as { key: string; value: string }[]
  const prefix = `${env}_`
  // ⚠️ 兩張表的 key 命名不一樣，必須明確對應。共用設定是 snake_case
  //    （osm_channel_id），這支讀的是 camelCase（cfg.channelId）——
  //    不轉的話 channelId 永遠是 undefined、fallback 到寫死的 '873'。
  //    OSM 剛好就是 873 所以看不出來，但 **GCP 會靜默用錯 channel**（應為 892），
  //    查回來的是別的渠道的資料而且不會報錯。
  const KEY_MAP: Record<string, string> = {
    channel_id: 'channelId',
    player_studio_id: 'playerstudioid',
  }
  for (const r of shared) {
    if (!r.key.startsWith(prefix)) continue
    const bare = r.key.slice(prefix.length)
    cfg[KEY_MAP[bare] ?? bare] = r.value
  }
  // origin 有了就順便補 referer——後台會檢查，少了會被擋，
  // 而共用設定裡沒有這個欄位（Meter 那支是自己組的）
  if (cfg.origin && !cfg.referer) cfg.referer = cfg.origin.replace(/\/?$/, '/')

  const own = db.prepare('SELECT key, value FROM reconcile_config').all() as { key: string; value: string }[]
  for (const r of own) if (r.value) cfg[r.key] = r.value

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

/**
 * 後台查詢的失敗原因。
 *
 * ⚠️ 這個型別存在的理由：原本 `fetchBackendRecords()` **任何失敗都是 `break` 回空陣列**，
 *    於是「查詢失敗」跟「這段時間真的沒有資料」在畫面上長得**一模一樣**。
 *    使用者在正式環境查不到資料時完全無從判斷是壞在哪（2026-09-01 實際回報）。
 *
 * ⚠️ 更糟的是「測試連線」：它拿到空陣列還是回「連線成功，測試查詢回傳 0 筆」——
 *    token 沒有、登入失敗、權限不足通通會被說成連線成功。那不只是沒幫助，
 *    是**主動誤導排查方向**。
 *
 * `message` 是後台原始訊息，**只進 server log 不給前端**（跟 CodeX 討論定案）：
 * 外部系統的訊息可能含內部欄位、路徑或帳號資訊。前端只拿受控的 `userMessage`。
 */
type ReconcileFetchErrorType = 'missing_config' | 'auth_failed' | 'api_error' | 'network_error'
type ReconcileFetchError = {
  type: ReconcileFetchErrorType
  /** 後台原始訊息，只進 log */
  message: string
  /** 給畫面看的受控文字，不含外部系統內部細節 */
  userMessage: string
  backendCode?: number
  page?: number
  /** 已經抓到一些才失敗（例如第 3 頁掛掉）——資料仍有診斷價值但不完整 */
  partial: boolean
}

/** `auto_login` 這個 key 在兩張設定表裡都不存在，所以永遠是 undefined。
 *
 *  ⚠️ 原本兩個地方對「undefined」的解讀剛好相反：
 *     `fetchBackendRecords` 是 `!== 'false'`（預設**開**）
 *     `/reconcile/test`     是 `=== 'true'` （預設**關**）
 *  也就是同一組設定下，執行對帳會自動重登、測試連線不會——兩者行為不一致，
 *  而且測試連線比實際查詢還弱，等於測不出真實狀況。統一成預設開。 */
const autoLoginEnabled = (cfg: Record<string, string>) => cfg.auto_login !== 'false'

// Helper: fetch game records from backend API (mirrors BackendRecordClient.fetch_game_records)
async function fetchBackendRecords(
  cfg: Record<string, string>,
  startDt: string, endDt: string,
  playerId = '', pageSize = 50, maxPages = 5,
  /** token 過期要重讀設定時，得知道當初用的是哪個環境——不傳的話會退回 osm，
   *  在 GCP 情境下把設定悄悄換掉，而且只在過期那一刻發生 */
  env: ReconcileEnv = 'osm',
): Promise<{ records: unknown[]; error?: ReconcileFetchError }> {
  const baseUrl = (cfg.base_url || 'https://backendservertest.osmslot.org').replace(/\/$/, '')
  const endpoint = `${baseUrl}/egm/reports/gameRecordList`
  const channel = cfg.channelId || '873'
  const playerstudioid = cfg.playerstudioid || 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL'

  // 連 token 跟帳密都沒有 → 這不是「查無資料」，是根本沒辦法查。
  // 正式環境最常見的情況：`meter_reconcile_config` 從來沒在那個環境設定過
  // （本機跟 Spug 的 DB 是分開的），於是每次查詢都靜默回 0 筆。
  if (!cfg.token && !cfg.login_password) {
    return {
      records: [],
      error: {
        type: 'missing_config',
        message: `no token and no login_password for env=${env}`,
        userMessage: '這個環境還沒有後台連線設定。請先到「Performance Meter 對帳」頁面設定並測試登入。',
        partial: false,
      },
    }
  }

  let headers = reconcileHeaders(cfg)
  const all: unknown[] = []
  let reloginDone = false
  let error: ReconcileFetchError | undefined

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
        console.warn('[reconcile] token 過期，嘗試自動重新登入')
        const newToken = await reconcileLogin(cfg)
        if (!newToken) {
          console.warn('[reconcile] 自動重新登入失敗——帳密可能不對，或登入路徑不同')
          error = {
            type: 'auth_failed',
            message: 'relogin failed after backend code 40200',
            userMessage: 'token 已失效，自動重新登入失敗。請確認後台帳密是否正確。',
            backendCode: 40200, page, partial: all.length > 0,
          }
        }
        if (newToken) {
          // ⚠️ 重讀時要沿用同一個環境。用預設值會在 GCP 情境下把設定換成 OSM，
          //    而且只在 token 過期那一刻才發生，極難重現
          cfg = loadReconcileConfig(env)
          headers = reconcileHeaders(cfg)
          reloginDone = true
          page-- // retry this page
          continue
        }
        if (!error) error = {
          type: 'auth_failed',
          message: 'backend code 40200 and auto-login disabled or already retried',
          userMessage: 'token 已失效，且無法自動重新登入。',
          backendCode: 40200, page, partial: all.length > 0,
        }
        break
      }

      // 非預期的錯誤碼要留下痕跡。原本只有 40200 有處理，其他狀況（例如
      // 權限不足、參數被拒）會直接落到下面的 items 判斷、當成「沒資料」break，
      // 使用者看到的是「後台 0 筆」而不是錯誤——查不到是壞在哪
      if (d.code !== undefined && d.code !== 20000) {
        const raw = (d as { message?: string }).message ?? ''
        console.warn(`[reconcile] 後台回非成功碼 ${d.code}：${raw}`)
        // ⚠️ 原始 message 只留在 log。外部系統的訊息可能含內部欄位／路徑／帳號
        //    （跟 CodeX 討論定案），前端只拿受控文字 + code。
        error = {
          type: 'api_error',
          message: raw,
          userMessage: `後台 API 回應錯誤（代碼 ${d.code}）。`,
          backendCode: d.code, page, partial: all.length > 0,
        }
        break
      }

      const items = d.data?.items ?? []
      if (!Array.isArray(items) || items.length === 0) break
      all.push(...items)
      if (items.length < pageSize) break
    } catch (e) {
      // 原本是 `catch { break }`——把所有例外靜默吞掉，回 0 筆且不留任何痕跡。
      // 這正是「後台明明有 34 筆卻回 0」查不出原因的其中一個障礙
      const raw = e instanceof Error ? e.message : String(e)
      console.warn('[reconcile] 後台查詢失敗:', raw)
      error = {
        type: 'network_error',
        message: raw,
        userMessage: `後台查詢失敗（第 ${page} 頁）。可能是網路不通或後台無回應。`,
        page, partial: all.length > 0,
      }
      break
    }
  }
  return { records: all, error }
}

// POST /api/autospin/reconcile/test — test backend API connection
router.post('/api/autospin/reconcile/test', async (req, res) => {
  try {
    // 測試連線也要吃 env，否則選了 GCP 卻永遠在測 OSM——
    // 那會給出「連線正常」但實際上根本沒測到要用的那組設定
    const env = req.body?.env === 'gcp' ? 'gcp' as const : 'osm' as const
    const cfg = loadReconcileConfig(env)
    // ⚠️ 「完全沒設定過」要跟「帳密不對」分開講。
    //    這兩種的下一步完全不同：前者要去把設定建起來，後者是改帳密。
    //    先前兩種都回「自動登入失敗，請確認帳密」，在全新環境上等於把人
    //    導去檢查一組根本還不存在的帳密。
    if (!cfg.token && !cfg.login_password) {
      return res.json({ ok: false, message: '這個環境還沒有後台連線設定。請先到「Performance Meter 對帳」頁面設定並測試登入。' })
    }
    if (!cfg.token && autoLoginEnabled(cfg)) {
      const t = await reconcileLogin(cfg)
      if (!t) return res.json({ ok: false, message: '自動登入失敗，請確認帳密是否正確，或手動填入 token' })
    }
    // Test: fetch 1 record for last hour
    const now = new Date()
    const start = new Date(now.getTime() - 60 * 60 * 1000)
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
    const { records, error } = await fetchBackendRecords(cfg, fmt(start), fmt(now), '', 1, 1, env)
    // ⚠️ 這裡原本不管有沒有失敗都回「連線成功，測試查詢回傳 N 筆」——
    //    因為舊版 fetchBackendRecords 失敗時是回空陣列不是拋錯。
    //    結果 token 沒有／登入失敗／權限不足通通被說成連線成功，
    //    等於主動把排查引到錯的方向。有 error 一律回失敗。
    if (error) return res.json({ ok: false, message: error.userMessage })
    return res.json({ ok: true, message: `連線成功，測試查詢回傳 ${records.length} 筆` })
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
    // 環境：對應共用設定 meter_reconcile_config 的 osm_/gcp_ 兩組前綴。
    // 舊的呼叫端沒帶這個欄位，預設 osm 維持原本行為
    env: z.enum(['osm', 'gcp']).default('osm'),
  }).parse(req.body)

  const userLabel = (req.headers['x-user-label'] as string) || ''

  // 1. Fetch backend records
  const cfg = loadReconcileConfig(body.env)
  let backendItems: unknown[] = []
  let backendError: ReconcileFetchError | undefined
  try {
    const fetched = await fetchBackendRecords(cfg, body.rangeStart, body.rangeEnd, body.playerId, 50, 5, body.env)
    backendItems = fetched.records
    backendError = fetched.error
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

  // 4b. 反向：後台有、前端沒有
  //
  // 原本只從 normFront 那一側迭代，所以**前端 0 筆時清單完全是空的**——
  // 摘要寫「後台 34 筆」但畫面一筆都沒有，看起來就像壞掉。
  //
  // ⚠️ 但這一側**不能算進「未匹配」**（跟 CodeX 討論定案）：
  //    「前端有、後台沒有」= 掉單，是對帳真正要抓的問題
  //    「後台有、前端沒有」= AutoSpin 沒在跑的期間本來就會有（真人玩家的紀錄），
  //                        多數情況完全正常
  //    混成同一個數字，使用者看到 34 會以為有 34 筆異常，其實一筆問題都沒有。
  let backendOnly = 0
  normBackend.forEach((br, i) => {
    if (usedIdx.has(i)) return
    backendOnly++
    details.push({
      status: 'BACKEND_ONLY', uid: br.uid, time: br.time, bet: br.bet, win: br.win,
      note: br.orderId ? `局號 ${br.orderId}` : '',
    })
  })

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
  // 「掉單」跟「僅後台有」一定要分開列。前者是問題、後者多半只是查詢範圍內
  // 有真人玩家的紀錄——合成一個「未匹配」會讓人誤判嚴重程度。
  const summary = `前端 ${normFront.length} 筆 / 後台 ${normBackend.length} 筆 / 匹配 ${matched} / 掉單 ${unmatched} / 僅後台有 ${backendOnly} / 異常 ${anomalies.length}`
  const reportId = (db.prepare(`
    INSERT INTO reconcile_reports
    (rangeStart, rangeEnd, machineType, frontCount, backendCount, matchedCount, unmatchedCount, anomalyCount, summary, details, backendStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.rangeStart, body.rangeEnd, body.machineType,
    normFront.length, normBackend.length, matched, unmatched, anomalies.length,
    summary, JSON.stringify({ details, anomalies }),
    // 失敗的那次也要留下痕跡，否則歷史表上它跟「真的沒資料」長得一樣
    backendError ? (backendError.partial ? 'partial' : 'failed') : 'ok',
  ) as { lastInsertRowid: number }).lastInsertRowid

  return res.json({
    ok: true, reportId, summary, matched, unmatched,
    backendOnly,
    anomalies: anomalies.length, details, backendAnomalies: anomalies,
    // 前端 0 筆時要主動說明，不要讓使用者自己從「34 筆但沒有異常」去推
    notice: normFront.length === 0 && normBackend.length > 0
      ? `這段時間沒有 AutoSpin 前端紀錄，因此無法進行雙向比對。下方 ${normBackend.length} 筆為後台既有遊戲紀錄，不代表異常。`
      : '',
    // ── 後台查詢的狀態（2026-09-01）───────────────────────────────────
    // 「查詢失敗」跟「這段時間真的沒資料」原本在畫面上長得一模一樣，
    // 使用者在正式環境查不到資料時完全無從判斷壞在哪。
    //
    // ⚠️ partial（抓到一部分才失敗）**照常比對但一定要標示**（跟 CodeX 討論定案）：
    //    已抓到的資料仍有診斷價值，整個當失敗等於丟掉它；但不標示的話
    //    使用者會拿不完整的資料下結論，那比沒有結果更危險。
    backendStatus: backendError ? (backendError.partial ? 'partial' : 'failed') : 'ok',
    // 只給受控文字，後台原始 message 留在 server log
    backendError: backendError
      ? { type: backendError.type, message: backendError.userMessage, backendCode: backendError.backendCode, page: backendError.page }
      : null,
    backendIncomplete: Boolean(backendError),
  })
})

// GET /api/autospin/reconcile/reports — list saved reports
router.get('/api/autospin/reconcile/reports', (_req, res) => {
  const rows = db.prepare('SELECT id, runAt, rangeStart, rangeEnd, machineType, frontCount, backendCount, matchedCount, unmatchedCount, anomalyCount, summary, backendStatus FROM reconcile_reports ORDER BY id DESC LIMIT 50').all()
  res.json({ ok: true, reports: rows })
})

// GET /api/autospin/reconcile/reports/:id — get full report details
router.get('/api/autospin/reconcile/reports/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM reconcile_reports WHERE id = ?').get(req.params.id) as
    { details: string } & Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ ok: false })
  return res.json({ ok: true, report: { ...row, details: JSON.parse(row.details || '{}') } })
})

// ─── 三路對帳（SLS recordBet / 盒子日誌 / Pinus history）────────────────────────
// 跟上面的 reconcile/* 是不同工具：reconcile/* 是「事後手動選時間範圍跑一次」對後台
// gameRecordList；這裡是跟 AutoSpin 執行同步、背景持續跑的即時比對，比對欄位由使用者
// 自訂群組（不寫死要比哪些欄位），資料來源：
//   sls   — SLS recordBet log（fetchRecordBet，見 lib/sls.ts）
//   pinus — 前端 pinus historyListReq，agent 已經在跑的 reconcile_front_records 表
//   box   — 機台盒子硬體日誌（fresh_current_credits），目前尚未串接來源，一律回傳
//           undefined，任何包含 box 欄位的比對群組會固定停在 missing_data，UI 需明確
//           標示「尚未串接」而不是假裝比對過

interface CompareField { source: 'sls' | 'box' | 'pinus'; path: string; label?: string }
interface CompareGroupRow { id: string; name: string; fields: CompareField[]; tolerance: number; sortOrder: number }

function readCompareGroups(): CompareGroupRow[] {
  const rows = db.prepare('SELECT * FROM autospin_compare_groups ORDER BY sortOrder, createdAt').all() as
    { id: string; name: string; fields: string; tolerance: number; sortOrder: number }[]
  return rows.map(r => ({ id: r.id, name: r.name, fields: JSON.parse(r.fields || '[]'), tolerance: r.tolerance, sortOrder: r.sortOrder }))
}

// GET/PUT /api/autospin/compare/prefs — 三路對帳依帳號開關（2026-08-10 討論結論：比對規則全域共用，
// 要不要跑比對依帳號各自決定，預設開啟）；跟比對群組（下面 groups，全域共用）刻意分開兩支端點
router.get('/api/autospin/compare/prefs', (req, res) => {
  res.json({ ok: true, compareEnabled: isCompareEnabled(requestUserLabel(req)) })
})
router.put('/api/autospin/compare/prefs', (req, res) => {
  const body = z.object({ compareEnabled: z.boolean() }).parse(req.body)
  upsertNotifyPrefs(requestUserLabel(req), { compareEnabled: body.compareEnabled ? 1 : 0 })
  res.json({ ok: true })
})

// GET/PUT /api/autospin/screenshot-prefs — 截圖監控依帳號開關（2026-08-17，使用者要求「不要常駐，
// 讓使用者決定要不要開」）；只在下次啟動 AutoSpin 時生效（見 /agent/start），不是即時的
router.get('/api/autospin/screenshot-prefs', (req, res) => {
  res.json({ ok: true, screenshotEnabled: isScreenshotEnabled(requestUserLabel(req)) })
})
router.put('/api/autospin/screenshot-prefs', (req, res) => {
  const body = z.object({ screenshotEnabled: z.boolean() }).parse(req.body)
  upsertNotifyPrefs(requestUserLabel(req), { screenshotEnabled: body.screenshotEnabled ? 1 : 0 })
  res.json({ ok: true })
})

// GET /api/autospin/compare/groups
router.get('/api/autospin/compare/groups', (_req, res) => {
  res.json({ ok: true, groups: readCompareGroups() })
})

const compareFieldSchema = z.object({
  source: z.enum(['sls', 'box', 'pinus']),
  path: z.string().min(1),
  label: z.string().optional(),
})

// PUT /api/autospin/compare/groups — 整批覆蓋儲存（前端一次送出所有群組，比逐筆 CRUD 簡單，
// 群組數量少、使用者操作頻率低，不需要細粒度的單筆 API）
router.put('/api/autospin/compare/groups', (req, res) => {
  const body = z.object({
    groups: z.array(z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      fields: z.array(compareFieldSchema).default([]),
      tolerance: z.number().min(0).default(0.01),
    })),
  }).parse(req.body)

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM autospin_compare_groups').run()
    const insert = db.prepare(`
      INSERT INTO autospin_compare_groups (id, name, fields, tolerance, sortOrder, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    body.groups.forEach((g, i) => {
      insert.run(g.id || randomUUID(), g.name, JSON.stringify(g.fields), g.tolerance, i, Date.now())
    })
  })
  tx()
  res.json({ ok: true, groups: readCompareGroups() })
})

// POST /api/autospin/compare/sls-test — 憑證固定寫死在後端（server/lib/sls.ts），不提供前端
// 設定 UI；這支端點純粹留給後端診斷用（例如部署後用 curl 確認連線是否正常），不接前端畫面。
router.post('/api/autospin/compare/sls-test', async (_req, res) => {
  const result = await testSlsRecordBetConnection(60)
  res.json(result)
})

// ── 比對引擎 ──────────────────────────────────────────────────────────────────

interface CompareContext {
  sls?: Record<string, unknown>
  pinus?: Record<string, unknown>
  box?: Record<string, unknown>
}

function getPath(obj: unknown, path: string): unknown {
  if (obj === undefined || obj === null || !path) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === undefined || acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

/**
 * SLS 查詢的健康狀態與退避。
 *
 * ⚠️ **錯誤看得見跟節流要同時做**（CodeX review）。只把錯誤印出來的話，
 *    多人一起用時錯誤雖然看得見，但還是會繼續用同樣的頻率打爆 SLS。
 *
 * 請求量本來就是 `使用者數 × 機台數 × 3 次/分鐘` 線性成長，而
 * `fetchRecordBet()` 沒有任何 rate limit 或快取。所以連續失敗時一定要退避，
 * 不能每 20 秒照樣重試。
 */
type SlsFailKind = 'no_credentials' | 'throttled' | 'timeout' | 'other'
interface SlsHealth { fails: number; nextAttemptAt: number; kind: SlsFailKind; message: string; at: number }
const slsHealth = new Map<string, SlsHealth>()

/** 從錯誤訊息分類。分類本身要保守——認不出來一律 `other`，不要猜成限流。 */
function classifySlsError(e: unknown): { kind: SlsFailKind; message: string } {
  const msg = e instanceof Error ? e.message : String(e)
  const low = msg.toLowerCase()
  if (/憑證尚未設定|credential/i.test(msg)) return { kind: 'no_credentials', message: msg }
  if (low.includes('throttl') || low.includes('too many') || low.includes('quota') || low.includes('429')) return { kind: 'throttled', message: msg }
  if (low.includes('timeout') || low.includes('etimedout') || low.includes('econnreset')) return { kind: 'timeout', message: msg }
  return { kind: 'other', message: msg }
}

function noteSlsFail(key: string, e: unknown): void {
  const { kind, message } = classifySlsError(e)
  const prev = slsHealth.get(key)
  const fails = (prev?.fails ?? 0) + 1
  // 20s → 40 → 80 → 160 → 320，上限 5 分鐘。憑證沒設定的話重試也沒用，直接用上限。
  const delayMs = kind === 'no_credentials' ? 300_000 : Math.min(20_000 * 2 ** (fails - 1), 300_000)
  slsHealth.set(key, { fails, nextAttemptAt: Date.now() + delayMs, kind, message: message.slice(0, 300), at: Date.now() })
  // 第 1、2、3 次都印，之後每 5 次印一次——完全靜默是這次要修的問題，
  // 但每 20 秒印一行也會把日誌洗掉
  if (fails <= 3 || fails % 5 === 0) {
    console.error(`[三路對帳] SLS 查詢失敗（${key}，第 ${fails} 次，${kind}）：${message.slice(0, 200)}｜${Math.round(delayMs / 1000)} 秒後重試`)
  }
}

function noteSlsOk(key: string): void {
  const prev = slsHealth.get(key)
  if (prev && prev.fails > 0) console.log(`[三路對帳] SLS 查詢已恢復（${key}，先前連續失敗 ${prev.fails} 次）`)
  slsHealth.delete(key)
}

function slsBackedOff(key: string): boolean {
  const h = slsHealth.get(key)
  return !!h && Date.now() < h.nextAttemptAt
}

/** 給畫面用：目前有哪些機台的 SLS 查詢是壞的 */
export function slsHealthSnapshot(): Array<{ key: string; fails: number; kind: SlsFailKind; message: string; retryInSec: number }> {
  const now = Date.now()
  return [...slsHealth.entries()].map(([key, h]) => ({
    key, fails: h.fails, kind: h.kind, message: h.message,
    retryInSec: Math.max(0, Math.round((h.nextAttemptAt - now) / 1000)),
  }))
}

/**
 * SLS 一輪 ↔ Pinus 戰績紀錄的配對。**抽成純函式是為了測得到**——
 * 這段的失敗方式是「配錯人卻顯示相符」，比配不到更糟，一定要有回歸測試。
 */
/**
 * ⚠️ **這個值是用實測分布定的，不是憑感覺**（CodeX 要求）。
 *
 * 285 輪真實 SLS × 165 筆真實 Pinus 紀錄（BULLBLITZ，2026-09-03）重算的結果：
 *
 * | 窗寬 | 可配對 | 配不到 | 多筆拒絕 |
 * |------|-------|-------|---------|
 * | ±500ms  |  57 | 213 |  15 |
 * | **±1000ms** | **101** | 152 |  32 |
 * | ±1500ms | 101 | 152 |  32 |
 * | ±2000ms |  94 | 151 |  40 |
 * | ±3000ms |  49 | 148 |  88 |
 * | ±5000ms |   8 | 144 | 133 |
 *
 * **放寬反而更糟**：spin 間隔實測 3~4 秒，窗一放大就必然抓到相鄰輪次，
 * 全部變成 ambiguous。第一版設 ±3000ms 只配得到 49 筆，±1000ms 有 101 筆。
 *
 * 兩邊時間都是秒級，實際觀察到的真實時間差只有 `0` 與 `-1000ms` 兩種，
 * 所以 ±1000ms 剛好涵蓋「同一秒或相鄰一秒」，再寬就只是在製造歧義。
 *
 * 要再調的話**先用實際資料重算這張表**，不要直接改數字。
 */
export const PINUS_MATCH_WINDOW_MS = 1000

/** Pinus 的 recordTime 是本地時間字串（UTC+8），SLS 的 time 是 epoch 秒 */
export function pinusRecordTimeToMs(recordTime: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(recordTime ?? ''))
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  // ⚠️ 用 Date.UTC 疊出來再減 8 小時，不要用 `new Date("...")`——後者會依
  //    **伺服器的**本地時區解讀，同一份資料在不同機器上會算出不同時間。
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - 8 * 3600_000
}

export interface PinusMatchPick<T> {
  candidateCount: number
  /** 時間窗內剛好一筆、而且沒有被別輪搶走時才有值 */
  matched: T | null
  /** 唯一候選被兩輪以上同時選中 */
  contested: boolean
  timeDeltaMs: number | null
}

/**
 * ⚠️ 規則一律保守：**寧可 unmatched，不要假相符**（跟 CodeX 討論定案）。
 *
 * - 配對鍵只有「同 gmid + 時間窗內唯一候選」
 * - **不用 bet/win 縮候選**——連續同注額的輪次 bet 完全一樣、win 常常都是 0，
 *   拿來當配對鍵會製造「看似精準」的錯覺。它們只該當配對**之後**的驗證
 * - 候選 0 筆 → 配不到；>1 筆 → 拒絕猜
 * - **還要反向檢查**：spin 間隔 4~5 秒、窗 ±3 秒時，相鄰兩輪很可能各自
 *   「唯一」對到同一筆 Pinus。只看「一輪對到幾筆」抓不到這種，
 *   所以同一筆被搶兩次時兩邊都判成無法判定
 */
export function matchPinusRounds<T extends { gmid?: string; recordTime?: unknown }>(
  slsRounds: { timeSec: number; gmid: string }[],
  pinusRows: T[],
  windowMs: number = PINUS_MATCH_WINDOW_MS,
): PinusMatchPick<T>[] {
  const timed = pinusRows
    .map(row => ({ row, at: pinusRecordTimeToMs(row.recordTime) }))
    .filter((x): x is { row: T; at: number } => x.at !== null)

  const picked = slsRounds.map(sls => {
    const at = sls.timeSec * 1000
    const hits = timed.filter(x =>
      (!sls.gmid || !x.row.gmid || x.row.gmid === sls.gmid) && Math.abs(x.at - at) <= windowMs)
    return { at, count: hits.length, hit: hits.length === 1 ? hits[0] : null }
  })

  const claims = new Map<T, number>()
  for (const p of picked) if (p.hit) claims.set(p.hit.row, (claims.get(p.hit.row) ?? 0) + 1)

  return picked.map(p => {
    const contested = p.hit ? (claims.get(p.hit.row) ?? 0) > 1 : false
    return {
      candidateCount: p.count,
      matched: contested ? null : (p.hit?.row ?? null),
      contested,
      timeDeltaMs: p.hit && !contested ? p.hit.at - p.at : null,
    }
  })
}

function resolveFieldValue(field: CompareField, ctx: CompareContext): unknown {
  if (field.source === 'box') return undefined // 盒子日誌尚未串接
  return getPath(ctx[field.source], field.path)
}

interface GroupEvalResult {
  groupId: string; groupName: string
  values: { source: string; path: string; value: unknown }[]
  status: 'match' | 'mismatch' | 'missing_data'
  note: string
}

function evaluateGroup(group: CompareGroupRow, ctx: CompareContext): GroupEvalResult {
  const values = group.fields.map(f => ({ source: f.source, path: f.path, value: resolveFieldValue(f, ctx) }))
  const nums: number[] = []
  let missing = group.fields.length === 0
  for (const v of values) {
    if (v.value === undefined || v.value === null || v.value === '') { missing = true; continue }
    const n = typeof v.value === 'number' ? v.value : parseFloat(String(v.value))
    if (Number.isNaN(n)) { missing = true; continue }
    nums.push(n)
  }
  if (missing) {
    return { groupId: group.id, groupName: group.name, values, status: 'missing_data', note: '至少一個來源缺資料' }
  }
  const max = Math.max(...nums), min = Math.min(...nums)
  if (max - min > group.tolerance) {
    return { groupId: group.id, groupName: group.name, values, status: 'mismatch', note: `差 ${(max - min).toFixed(2)}` }
  }
  return { groupId: group.id, groupName: group.name, values, status: 'match', note: '' }
}

interface PinusFrontRow { orderId: string; bet: number; win: number; recordTime: string; gmid: string; gameid: string }

async function compareMachineCycle(sessionId: string, machineType: string, gameTitleCode: string, groups: CompareGroupRow[], sessionStartedAt?: number): Promise<void> {
  if (groups.length === 0 || !gameTitleCode) return

  const nowSec = Math.floor(Date.now() / 1000)
  /**
   * 每輪往回看 10 分鐘（含一點重疊），已存在的 round 靠
   * UNIQUE(sessionId, machineType, roundKey) upsert 自然去重。
   *
   * ⚠️ **但下界不能早於 session 開始時間。**
   *
   * SLS 是依**機台**抓的（`fetchRecordBet(from, now, gameTitleCode)`），
   * 而 Pinus 只查 `sessionId = 這一次`——兩邊範圍不對稱。session 剛啟動時，
   * 這 10 分鐘會撈到**上一個 session** 打的輪次，那些這次的 agent 根本沒觀測過，
   * 於是全部被標成 `unmatched`。
   *
   * 真實案例（2026-09-03）：164 筆裡 **147 筆是 session 開始前的**，
   * 使用者看到「148 筆配不到」以為配對壞了；真正在範圍內的 17 筆其實是
   * match 10 / ambiguous 7 / **unmatched 0**——matcher 是好的，是統計範圍錯了。
   *
   * 這個統計要回答的是「**本次 session 內**，agent 觀測到的資料能不能對上 SLS」，
   * 所以兩邊都要被 session 邊界約束（跟 CodeX 討論定案）。
   * 反過來放寬 Pinus 不限 sessionId 雖然覆蓋率會變好看，但會把上一個 session 的
   * 歷史資料混進這次的覆蓋率，之後分不出是即時撈取成功還是剛好被歷史補到。
   */
  const fromSec = Math.max(nowSec - 600, sessionStartedAt ? Math.floor(sessionStartedAt / 1000) : 0)

  // ⚠️ 被 backoff 擋住的機台這輪直接跳過（見 slsHealth 的說明）
  const backoffKey = `${sessionId}::${machineType}`
  if (slsBackedOff(backoffKey)) return

  let slsRecords: SlsBetRecord[] = []
  try {
    slsRecords = await fetchRecordBet(fromSec, nowSec, gameTitleCode, 300)
    noteSlsOk(backoffKey)
  } catch (e) {
    /**
     * ⚠️ 這裡原本是 `catch { return }`，**一個字都不印**。
     *
     * 後果：SLS 憑證沒設、逾時、被限流——全部長得一樣，就是「畫面數字不動」。
     * 使用者根本分不出是「這段時間真的沒下注」還是「查詢整個掛了」。
     * 跟今天早上 `historyListReq` 那個 uid 問題是同一種壞法：靜默吞掉訊號，
     * 於是問題可以存在很久沒人發現（CodeX review：先讓錯誤看得見，再談節流）。
     */
    noteSlsFail(backoffKey, e)
    return
  }
  if (slsRecords.length === 0) return

  const pinusRows = db.prepare(`
    SELECT orderId, bet, win, recordTime, gmid, gameid FROM reconcile_front_records
    WHERE sessionId = ? AND machineType = ? AND createdAt >= ?
  `).all(sessionId, machineType, fromSec * 1000) as PinusFrontRow[]
  // ⚠️ **Pinus 的 historyListReq 根本沒有 order id**（實測 BULLBLITZ 2026-09-03：
  //    欄位只有 time/gameid/gmid/bet/win/gmname），所以 orderId 一律是空字串，
  //    原本的 `pinusByOrderId.get(sls.roundId)` 精確比對永遠不可能命中。
  //    改用時間+機台的保守配對，規則與理由見 matchPinusRounds()。
  const picks = matchPinusRounds(
    slsRecords.map(r => ({ timeSec: r.time, gmid: String((r.raw as Record<string, unknown> | undefined)?.gmid ?? '') })),
    pinusRows,
  )

  let spinIndex = (db.prepare('SELECT COUNT(*) as c FROM autospin_compare_results WHERE sessionId = ? AND machineType = ?')
    .get(sessionId, machineType) as { c: number }).c
  const existingKeys = new Set(
    (db.prepare('SELECT roundKey FROM autospin_compare_results WHERE sessionId = ? AND machineType = ?')
      .all(sessionId, machineType) as { roundKey: string }[]).map(r => r.roundKey),
  )

  const upsert = db.prepare(`
    INSERT INTO autospin_compare_results (sessionId, machineType, roundKey, spinIndex, spinTime, status, groups)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId, machineType, roundKey) DO UPDATE SET status = excluded.status, groups = excluded.groups
  `)

  const tx = db.transaction(() => {
    for (let i = 0; i < slsRecords.length; i++) {
      const sls = slsRecords[i]
      const p = picks[i]
      const roundKey = sls.roundId || `sls-t:${sls.time}`
      if (!existingKeys.has(roundKey)) { spinIndex++; existingKeys.add(roundKey) }

      const { candidateCount: count, contested, matched: pinus, timeDeltaMs } = p
      const ctx: CompareContext = {
        sls: sls.raw,
        pinus: pinus
          ? { orderId: pinus.orderId, bet: pinus.bet, win: pinus.win, recordTime: pinus.recordTime, gmid: pinus.gmid, gameid: pinus.gameid }
          : undefined,
      }
      const groupResults = groups.map(g => evaluateGroup(g, ctx))

      /**
       * ⚠️ 狀態要分得開（CodeX review）。
       * 「找不到可配對的紀錄」跟「配到了但某一路缺欄位」是完全不同的事——
       * 混成一個 missing_data，看到的人不知道該去修配對規則還是去補資料來源。
       */
      let status: string
      if (count === 0) status = 'unmatched'
      else if (count > 1 || contested) status = 'ambiguous_match'
      else if (groupResults.some(g => g.status === 'mismatch')) status = 'mismatch'
      else if (groupResults.some(g => g.status === 'missing_data')) status = 'missing_data'
      else status = 'match'

      // 診斷欄位：之後要把 ±3 秒調成 ±5 秒時，才不會變成憑感覺調（CodeX 要求）
      const diag = {
        matchMethod: 'time_gmid',
        windowMs: PINUS_MATCH_WINDOW_MS,
        candidateCount: count,
        contested,
        timeDeltaMs,
      }
      upsert.run(sessionId, machineType, roundKey, spinIndex, new Date(sls.time * 1000).toISOString(),
        status, JSON.stringify({ groups: groupResults, match: diag }))
    }
  })
  tx()
}

// 掃描所有目前執行中的 session，逐台機器跑一次比對——判斷「機台有沒有在跑」用
// autospin_history 最近 5 分鐘內有沒有寫入紀錄（agent 本來就持續在寫），比自己維護一份
// 派工機台清單更準（hub-dispatch 當下沒有記錄實際派了哪些機台到 session 物件上）
async function runCompareCycle(): Promise<void> {
  const groups = readCompareGroups()
  if (groups.length === 0) return
  const runningSessions = [...agentSessions.values()].filter(s => s.status === 'running')
  if (runningSessions.length === 0) return

  for (const session of runningSessions) {
    if (!isCompareEnabled(session.userLabel)) continue // 該帳號關閉三路對帳，完全不打 SLS/Pinus 也不寫入結果
    const activeMachines = db.prepare(`
      SELECT DISTINCT machineType FROM autospin_history WHERE sessionId = ? AND createdAt >= ?
    `).all(session.id, Date.now() - 5 * 60_000) as { machineType: string }[]
    if (activeMachines.length === 0) continue
    const configs = readConfigs(session.userLabel)
    for (const { machineType } of activeMachines) {
      const gameTitleCode = configs.find(c => c.machineType === machineType)?.gameTitleCode || ''
      try {
        await compareMachineCycle(session.id, machineType, gameTitleCode, groups, session.startedAt)
      } catch (e) {
        console.error(`[autospin][compare] ${session.id}/${machineType} 比對失敗：`, e)
      }
    }
  }
}
setInterval(() => { runCompareCycle().catch(() => {}) }, 20_000)

// POST /api/autospin/compare/run-now — 手動觸發一次比對（不用等下一次 20 秒排程），
// 對應前端「試算目前資料」按鈕
router.post('/api/autospin/compare/run-now', async (_req, res) => {
  try {
    await runCompareCycle()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) })
  }
})

// GET /api/autospin/compare/status — 目前操作者所有執行中 session 的每台機器比對統計
router.get('/api/autospin/compare/status', (req, res) => {
  const userLabel = requestUserLabel(req)
  const sessions = [...agentSessions.values()].filter(s => s.status === 'running' && s.userLabel === userLabel)
  const machines: { sessionId: string; machineType: string; agentLabel: string; compared: number; matched: number; mismatched: number; missing: number }[] = []

  for (const session of sessions) {
    const rows = db.prepare(`
      SELECT machineType,
        COUNT(*) as compared,
        SUM(CASE WHEN status = 'match' THEN 1 ELSE 0 END) as matched,
        SUM(CASE WHEN status = 'mismatch' THEN 1 ELSE 0 END) as mismatched,
        SUM(CASE WHEN status = 'missing_data' THEN 1 ELSE 0 END) as missing,
        -- ⚠️ 這兩個一定要跟 missing 分開統計。「找不到可配對的紀錄」要去修配對規則，
        --    「配到了但缺欄位」要去補資料來源——合在一起看不出該做哪件事。
        SUM(CASE WHEN status = 'unmatched' THEN 1 ELSE 0 END) as unmatched,
        SUM(CASE WHEN status = 'ambiguous_match' THEN 1 ELSE 0 END) as ambiguous
      FROM autospin_compare_results
      -- ⚠️ 只統計 session 開始之後的輪次。SLS 是依機台抓的，session 剛啟動那 10 分鐘
      --    會含到**上一個 session** 打的輪次——那些這次的 agent 根本沒觀測過，
      --    算進來會讓「配不到」看起來爆表（真實案例：164 筆裡 147 筆是這種）。
      --    ⚠️ 舊資料**刻意不刪**（CodeX review）：那是當時規則下真實產生的結果，
      --       刪掉會讓排查紀錄斷掉。改的是報表口徑，不是竄改歷史。
      WHERE sessionId = ? AND spinTime >= ? GROUP BY machineType
    `).all(session.id, new Date(session.startedAt).toISOString()) as { machineType: string; compared: number; matched: number; mismatched: number; missing: number; unmatched: number; ambiguous: number }[]
    for (const r of rows) {
      machines.push({ sessionId: session.id, machineType: r.machineType, agentLabel: session.userLabel, ...r })
    }
  }

  const groups = readCompareGroups()
  res.json({
    ok: true,
    machines,
    groupCount: groups.length,
    sessionCount: sessions.length,
    // ⚠️ SLS 查詢壞掉時畫面一定要看得出來。原本失敗是靜默的，使用者只會看到
    //    「數字不動」，分不出是這段時間沒下注還是查詢整個掛了。
    slsHealth: slsHealthSnapshot(),
    hasBoxLeg: groups.some(g => g.fields.some(f => f.source === 'box')),
  })
})

// GET /api/autospin/compare/detail/:machineType — 該機台最近逐筆比對明細
router.get('/api/autospin/compare/detail/:machineType', (req, res) => {
  const userLabel = requestUserLabel(req)
  const sessionId = req.query.sessionId as string
  const session = sessionId ? agentSessions.get(sessionId) : undefined
  if (!session || session.userLabel !== userLabel) return res.status(403).json({ ok: false, message: '無權限查看此 session' })

  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500)
  const rows = db.prepare(`
    SELECT spinIndex, spinTime, status, groups FROM autospin_compare_results
    -- 逐筆明細也要跟統計同口徑，否則「148 筆配不到」的數字沒了、
    -- 展開卻還是一整排 unmatched，反而更難解釋
    WHERE sessionId = ? AND machineType = ? AND spinTime >= ? ORDER BY spinIndex DESC LIMIT ?
  `).all(sessionId, req.params.machineType, new Date(session.startedAt).toISOString(), limit) as { spinIndex: number; spinTime: string; status: string; groups: string }[]

  res.json({
    ok: true,
    // ⚠️ 這個欄位有兩種形狀：舊資料是「群組陣列」，v4.103.0 起是
    //    `{ groups, match }`（多帶配對診斷）。舊列一定要照樣讀得出來——
    //    這張表不會清空，直接改讀新形狀會讓所有既有紀錄的明細變成空白。
    rows: rows.reverse().map(r => {
      const parsed = JSON.parse(r.groups || '[]') as unknown
      const isNew = parsed && !Array.isArray(parsed) && typeof parsed === 'object'
      return {
        spinIndex: r.spinIndex, spinTime: r.spinTime, status: r.status,
        groups: isNew ? ((parsed as { groups?: unknown }).groups ?? []) : parsed,
        match: isNew ? (parsed as { match?: unknown }).match ?? null : null,
      }
    }),
  })
})

// ─── JP Group CRUD ────────────────────────────────────────────────────────────

interface JpGroupRow {
  id: number; code: string; display_name: string; environment: string
  luckylink_url: string; luckylink_group_name: string
  login_user: string; login_pass: string
  game_codes: string; enabled: number; created_at: string; updated_at: string
}

const jpGroupSchema = z.object({
  code: z.string().min(1).max(50),
  display_name: z.string().min(1).max(100),
  environment: z.enum(['QAT', 'UAT', 'PROD']),
  luckylink_url: z.string().url(),
  luckylink_group_name: z.string().min(1),
  login_user: z.string().default('admin'),
  login_pass: z.string().default('123456'),
  game_codes: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
})

// GET /api/autospin/jp-groups
router.get('/api/autospin/jp-groups', (_req, res) => {
  const rows = db.prepare('SELECT * FROM jp_groups ORDER BY code ASC').all() as JpGroupRow[]
  res.json({
    ok: true,
    groups: rows.map(r => {
      let game_codes: string[] = []
      try { game_codes = JSON.parse(r.game_codes || '[]') } catch { /* bad data */ }
      return { ...r, game_codes, enabled: r.enabled === 1 }
    }),
  })
})

// POST /api/autospin/jp-groups
router.post('/api/autospin/jp-groups', (req, res) => {
  const parsed = jpGroupSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, message: parsed.error.issues.map(i => i.message).join(', ') })
  const d = parsed.data
  try {
    const row = db.prepare(
      'INSERT INTO jp_groups (code,display_name,environment,luckylink_url,luckylink_group_name,login_user,login_pass,game_codes,enabled) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(d.code, d.display_name, d.environment, d.luckylink_url, d.luckylink_group_name, d.login_user, d.login_pass, JSON.stringify(d.game_codes), d.enabled ? 1 : 0) as { lastInsertRowid: number }
    return res.json({ ok: true, id: row.lastInsertRowid })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) return res.status(409).json({ ok: false, message: `代碼 "${d.code}" 已存在` })
    throw e
  }
})

// PUT /api/autospin/jp-groups/:id
router.put('/api/autospin/jp-groups/:id', (req, res) => {
  const id = Number(req.params.id)
  const parsed = jpGroupSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, message: parsed.error.issues.map(i => i.message).join(', ') })
  const d = parsed.data
  const sets: string[] = []
  const vals: unknown[] = []
  if (d.code !== undefined) { sets.push('code=?'); vals.push(d.code) }
  if (d.display_name !== undefined) { sets.push('display_name=?'); vals.push(d.display_name) }
  if (d.environment !== undefined) { sets.push('environment=?'); vals.push(d.environment) }
  if (d.luckylink_url !== undefined) { sets.push('luckylink_url=?'); vals.push(d.luckylink_url) }
  if (d.luckylink_group_name !== undefined) { sets.push('luckylink_group_name=?'); vals.push(d.luckylink_group_name) }
  if (d.login_user !== undefined) { sets.push('login_user=?'); vals.push(d.login_user) }
  if (d.login_pass !== undefined) { sets.push('login_pass=?'); vals.push(d.login_pass) }
  if (d.game_codes !== undefined) { sets.push('game_codes=?'); vals.push(JSON.stringify(d.game_codes)) }
  if (d.enabled !== undefined) { sets.push('enabled=?'); vals.push(d.enabled ? 1 : 0) }
  if (!sets.length) return res.status(400).json({ ok: false, message: '無更新欄位' })
  sets.push('updated_at=?'); vals.push(new Date().toISOString()); vals.push(id)
  try {
    db.prepare(`UPDATE jp_groups SET ${sets.join(',')} WHERE id=?`).run(...vals)
    return res.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) return res.status(409).json({ ok: false, message: '代碼已被其他 JP Group 使用' })
    throw e
  }
})

// DELETE /api/autospin/jp-groups/:id
router.delete('/api/autospin/jp-groups/:id', (req, res) => {
  db.prepare('DELETE FROM jp_groups WHERE id=?').run(Number(req.params.id))
  return res.json({ ok: true })
})

/**
 * server/routes/ui-screenshot.ts
 * UI Resolution Screenshot Tool — batch screenshot H5 games at multiple resolutions.
 * Architecture: Local Agent runs Playwright, uploads screenshots back to server.
 */
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, createReadStream, readdirSync, statSync, rmSync } from 'fs'
import { writeFile, readFile } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { addHistory, db, getLarkToken, parseLarkSheetUrl } from '../shared.js'
import { agentConnections } from '../agent-hub.js'
import { getOperatorFromContext } from '../request-context.js'
import { buildReportModel, renderReportHtml, type ReportTask } from '../lib/ui-screenshot-report.js'
import { createStoreZip } from '../lib/zip-store.js'
import { uploadFileToLarkFolder, parseLarkFolderToken } from '../lib/lark-drive.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
/**
 * 截圖存放位置。
 *
 * 🚨 **絕對不能放在 `dist-server` 底下。**原本是 `join(__dirname, '..', '..', 'server', …)`，
 *    在正式執行時（跑的是 `dist-server/server/routes/ui-screenshot.js`）會解析成
 *    `dist-server/server/ui-screenshot-saves`——而 `scripts/build-server.cjs` 的第一件事就是
 *    `rmSync(dist-server)`。**每次重建後端都會把所有截圖一起刪掉**，而資料庫紀錄還留著，
 *    症狀是「狀態 ok、路徑也在，但圖片 404」。2026-09-18 實測踩到，整批原圖消失。
 *
 * 改成以**工作目錄**為基準（PM2 的 cwd 就是專案根目錄，dev 的 `tsx server/index.ts` 也是），
 * 需要搬去別的磁碟時用 `UI_SS_SAVES_DIR` 覆寫。
 */
const SAVES_DIR = process.env.UI_SS_SAVES_DIR
  ? resolve(process.env.UI_SS_SAVES_DIR)
  : join(process.cwd(), 'server', 'ui-screenshot-saves')

// ─── DB Schema ────────────────────────────────────────────────────────────────

export const UI_SCREENSHOT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ui_screenshot_runs (
    id                TEXT PRIMARY KEY,
    status            TEXT NOT NULL DEFAULT 'pending',
    wiki_url          TEXT NOT NULL DEFAULT '',
    game_url_template TEXT NOT NULL DEFAULT '',
    gmids             TEXT NOT NULL DEFAULT '[]',
    resolutions       TEXT NOT NULL DEFAULT '[]',
    concurrency       INTEGER NOT NULL DEFAULT 3,
    options           TEXT NOT NULL DEFAULT '{}',
    agent_id          TEXT,
    history_saved     INTEGER NOT NULL DEFAULT 0,
    operator_key      TEXT NOT NULL DEFAULT '',
    operator_name     TEXT NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL,
    started_at        INTEGER,
    finished_at       INTEGER
  );
  CREATE TABLE IF NOT EXISTS ui_screenshot_tasks (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    gmid        TEXT NOT NULL,
    resolution  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    actual_gmid TEXT,
    server_path TEXT,
    error_msg   TEXT,
    started_at  INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ui_ss_tasks_run ON ui_screenshot_tasks (run_id, status);
`

// Run schema migration on module load
db.exec(UI_SCREENSHOT_SCHEMA)
{
  const taskCols = db.prepare('PRAGMA table_info(ui_screenshot_tasks)').all() as { name: string }[]
  if (!taskCols.find(c => c.name === 'actual_gmid')) {
    db.exec('ALTER TABLE ui_screenshot_tasks ADD COLUMN actual_gmid TEXT')
  }
  const cols = db.prepare('PRAGMA table_info(ui_screenshot_runs)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'history_saved')) {
    db.exec('ALTER TABLE ui_screenshot_runs ADD COLUMN history_saved INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.find(c => c.name === 'operator_key')) {
    db.exec("ALTER TABLE ui_screenshot_runs ADD COLUMN operator_key TEXT NOT NULL DEFAULT ''")
  }
  if (!cols.find(c => c.name === 'operator_name')) {
    db.exec("ALTER TABLE ui_screenshot_runs ADD COLUMN operator_name TEXT NOT NULL DEFAULT ''")
  }
}

// ─── SSE subscribers ──────────────────────────────────────────────────────────

type SseRes = express.Response
const sseSubscribers = new Map<string, Set<SseRes>>()

function emitToRun(runId: string, data: object) {
  const subs = sseSubscribers.get(runId)
  if (!subs) return
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const res of subs) {
    try { res.write(payload) } catch { subs.delete(res) }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * gmid 會被當成資料夾名稱，但自動選機模式下它是 **`遊戲 / model`**（含空白與斜線）。
 *
 * ⚠️ 不處理的話：`JJBX / Endless Treasure` 會被 `join()` 當成**兩層目錄**，
 *    檔案散在 `JJBX/ Endless Treasure/`，而讀圖的路由用同一個字串組不回來 → 圖片 404。
 *    斜線與 `..` 還有路徑穿越的風險。
 */
function safeSegment(value: string) {
  return (value || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/^\.+/, '_').slice(0, 120) || '_'
}

function taskDir(runId: string, gmid: string) {
  return join(SAVES_DIR, safeSegment(runId), safeSegment(gmid))
}

function screenshotPath(runId: string, gmid: string, resolution: string) {
  return join(taskDir(runId, gmid), `${safeSegment(resolution)}.png`)
}

function serverRelPath(runId: string, gmid: string, resolution: string) {
  return `ui-screenshot-saves/${safeSegment(runId)}/${safeSegment(gmid)}/${safeSegment(resolution)}.png`
}

function uiScreenshotCounts(runId: string) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_count,
      SUM(CASE WHEN status='popup' THEN 1 ELSE 0 END) AS popup_count,
      SUM(CASE WHEN status IN ('err','timeout') THEN 1 ELSE 0 END) AS err_count,
      SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped_count
    FROM ui_screenshot_tasks WHERE run_id = ?
  `).get(runId) as {
    total_count: number
    ok_count: number | null
    popup_count: number | null
    err_count: number | null
    skipped_count: number | null
  }
}

function saveUiScreenshotHistory(runId: string, finalStatus: 'done' | 'stopped') {
  const run = db.prepare(`SELECT * FROM ui_screenshot_runs WHERE id = ?`).get(runId) as {
    id: string
    status: string
    wiki_url: string
    game_url_template: string
    gmids: string
    resolutions: string
    options: string
    agent_id?: string
    history_saved: number
    operator_key?: string
    operator_name?: string
    created_at: number
    started_at?: number | null
    finished_at?: number | null
  } | undefined
  if (!run || run.history_saved) return

  const mark = db.prepare(`UPDATE ui_screenshot_runs SET history_saved = 1 WHERE id = ? AND history_saved = 0`).run(runId)
  if (mark.changes === 0) return

  const counts = uiScreenshotCounts(runId)
  const gmids = JSON.parse(run.gmids || '[]') as string[]
  const resolutions = JSON.parse(run.resolutions || '[]') as string[]
  const ok = counts.ok_count ?? 0
  const popup = counts.popup_count ?? 0
  const err = counts.err_count ?? 0
  const skipped = counts.skipped_count ?? 0
  const durationMs = Math.max(0, (run.finished_at ?? Date.now()) - (run.started_at ?? run.created_at))
  const stateLabel = finalStatus === 'stopped' ? 'STOPPED' : err > 0 ? 'DONE WITH ERRORS' : 'DONE'

  addHistory(
    'ui-screenshot',
    `UI 解析度截圖 - ${gmids.length} 台`,
    `${stateLabel}: tasks ${counts.total_count}, OK ${ok}, POPUP ${popup}, ERR ${err}, SKIP ${skipped}`,
    {
      runId,
      status: finalStatus,
      wikiUrl: run.wiki_url,
      gameUrlTemplate: run.game_url_template,
      gmids,
      resolutions,
      options: JSON.parse(run.options || '{}') as Record<string, unknown>,
      agentId: run.agent_id ?? null,
      counts: { total: counts.total_count, ok, popup, err, skipped },
      createdAt: run.created_at,
      startedAt: run.started_at ?? null,
      finishedAt: run.finished_at ?? null,
      durationMs,
    },
    { operator: run.operator_key ? { key: run.operator_key, name: run.operator_name ?? '' } : undefined },
  )
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// GET /agents/debug — temp: show all agent count without auth (for diagnostics)
router.get('/agents/debug', (_req, res) => {
  const all = [...agentConnections.values()].map(a => ({
    agentId: a.agentId, hostname: a.hostname, ownerKey: a.ownerKey,
    capabilities: a.capabilities, busy: a.busy, lastSeenAt: a.lastSeenAt,
  }))
  const operator = getOperatorFromContext()
  res.json({ totalAgents: all.length, operatorKey: operator?.key ?? null, agents: all })
})

// GET /agents — list agents belonging to the current operator
router.get('/agents', (_req, res) => {
  const operator = getOperatorFromContext()
  if (!operator?.key) return res.json({ ok: true, agents: [] })
  const agents = [...agentConnections.values()]
    .filter(agent => agent.ownerKey === operator.key)
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
  res.json({ ok: true, agents })
})

// POST /start — create run + tasks, dispatch to agent
// ─── 報告：產生 HTML、打包原圖、上傳 Lark ─────────────────────────────────────

/** 一次 run 的資料夾大小（位元組）與檔案數 */
function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0
  if (!existsSync(dir)) return { files, bytes }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = dirStats(p)
      files += sub.files; bytes += sub.bytes
    } else {
      files++; bytes += statSync(p).size
    }
  }
  return { files, bytes }
}

function collectRunFiles(runDir: string, prefix = ''): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = []
  if (!existsSync(runDir)) return out
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    const p = join(runDir, entry.name)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...collectRunFiles(p, name))
    else out.push({ name, path: p })
  }
  return out
}

/**
 * POST /run/:runId/report  { upload?: boolean; folderUrl?: string }
 * 產生報告 HTML（寫進 run 資料夾），可選擇連同**原圖 zip** 一起上傳到 Lark 雲端資料夾。
 *
 * ⚠️ 原圖走 zip 不是逐張上傳（使用者 2026-09-18 定案）：一次 run 可能上千張，
 *    逐張上傳等於上千次 API 呼叫，會跑十幾分鐘。
 */
router.post('/run/:runId/report', async (req, res, next) => {
  try {
    const { runId } = req.params
    const { upload, folderUrl } = req.body as { upload?: boolean; folderUrl?: string }
    const run = db.prepare(`SELECT * FROM ui_screenshot_runs WHERE id = ?`).get(runId) as {
      id: string; agent_id?: string | null; options: string; resolutions: string
      started_at?: number | null; finished_at?: number | null
    } | undefined
    if (!run) return res.status(404).json({ ok: false, message: 'Run not found' })

    const tasks = db.prepare(
      `SELECT gmid, resolution, status, actual_gmid, error_msg FROM ui_screenshot_tasks WHERE run_id = ?`,
    ).all(runId) as ReportTask[]
    const resolutions = JSON.parse(run.resolutions || '[]') as string[]

    const model = buildReportModel(
      {
        id: run.id,
        agent_id: run.agent_id ?? null,
        started_at: run.started_at ?? null,
        finished_at: run.finished_at ?? null,
        options: JSON.parse(run.options || '{}') as Record<string, unknown>,
      },
      tasks,
      resolutions,
    )

    // 報告放在 run 資料夾裡，圖用相對路徑——這樣連同 zip 一起解開後仍然看得到圖
    const html = renderReportHtml(model, {
      generatedAt: Date.now(),
      imgUrl: t => `${encodeURIComponent(safeSegment(t.gmid))}/${encodeURIComponent(safeSegment(t.resolution))}.png`,
    })
    const runDir = join(SAVES_DIR, safeSegment(runId))
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true })
    const reportPath = join(runDir, 'report.html')
    await writeFile(reportPath, html, 'utf8')

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const baseName = `解析度報告_${stamp}_${runId.slice(0, 8)}`
    const result: Record<string, unknown> = { ok: true, reportPath, groups: model.groups.length, totals: model.totals }

    if (upload) {
      const folderToken = parseLarkFolderToken(folderUrl || process.env.LARK_UI_SS_FOLDER_URL || '')
      if (!folderToken) {
        result.upload = { ok: false, message: '沒有可用的 Lark 資料夾連結（請在畫面上填，或設 LARK_UI_SS_FOLDER_URL）' }
      } else {
        // 報告單獨上傳一份（可以直接點開），原圖＋報告再打包一份
        const htmlUp = await uploadFileToLarkFolder(folderToken, `${baseName}.html`, Buffer.from(html, 'utf8'))
        const files = collectRunFiles(runDir)
        const entries = await Promise.all(files.map(async f => ({ name: f.name, data: await readFile(f.path) })))
        let zipUp: { ok: boolean; message?: string; fileToken?: string }
        try {
          zipUp = await uploadFileToLarkFolder(folderToken, `${baseName}.zip`, createStoreZip(entries))
        } catch (err) {
          zipUp = { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
        result.upload = { folderToken, html: htmlUp, zip: zipUp, files: files.length }
      }
    }

    res.json(result)
  } catch (err) {
    next(err)
  }
})

/** GET /storage — 截圖佔用多少空間、有幾次 run（前端顯示用） */
router.get('/storage', (_req, res) => {
  const runs = existsSync(SAVES_DIR)
    ? readdirSync(SAVES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
        const s = dirStats(join(SAVES_DIR, d.name))
        return { runId: d.name, files: s.files, bytes: s.bytes, mtime: statSync(join(SAVES_DIR, d.name)).mtimeMs }
      })
    : []
  runs.sort((a, b) => b.mtime - a.mtime)
  res.json({
    ok: true,
    dir: SAVES_DIR,
    runs: runs.length,
    files: runs.reduce((n, r) => n + r.files, 0),
    bytes: runs.reduce((n, r) => n + r.bytes, 0),
    detail: runs.slice(0, 50),
  })
})

/**
 * POST /storage/prune  { keepRuns?: number; keepDays?: number }
 * 清掉舊的截圖資料夾。⚠️ 只刪檔案，不動資料庫紀錄——歷史仍然查得到「當時拍了什麼、結果如何」，
 * 只是圖沒了。把紀錄一起刪掉的話，事後連「這批到底跑過沒」都查不出來。
 */
router.post('/storage/prune', (req, res) => {
  const { keepRuns = 10, keepDays = 14 } = req.body as { keepRuns?: number; keepDays?: number }
  if (!existsSync(SAVES_DIR)) return res.json({ ok: true, removed: [], freedBytes: 0 })

  const dirs = readdirSync(SAVES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ name: d.name, path: join(SAVES_DIR, d.name), mtime: statSync(join(SAVES_DIR, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  const cutoff = Date.now() - keepDays * 86_400_000
  const removed: string[] = []
  let freed = 0
  dirs.forEach((d, i) => {
    const tooOld = d.mtime < cutoff
    const tooMany = i >= keepRuns
    if (!tooOld && !tooMany) return
    freed += dirStats(d.path).bytes
    rmSync(d.path, { recursive: true, force: true })
    removed.push(d.name)
  })
  res.json({ ok: true, removed, freedBytes: freed, keepRuns, keepDays })
})

// ─── 掃大廳（給前端列出 model 勾選）────────────────────────────────────────────

interface ScanResult {
  ok: boolean
  message?: string
  scannedAt?: number
  cardCount?: number
  models?: Array<{ key: string; game: string; model: string; total: number; free: number; sample: string }>
  unparsed?: Array<{ gmid: string; text: string }>
}

/** scanId → 等著結果的 resolver。⚠️ 一定要設逾時，否則 Agent 掛掉時這個請求會永遠掛著 */
const pendingScans = new Map<string, (r: ScanResult) => void>()

/**
 * POST /scan-lobby  { agentId, gameUrlTemplate }
 * 叫 Agent 掃一次大廳，回傳「有哪些 model、各幾台、現在幾台可用」。
 *
 * ⚠️ 回報的「可用」是**掃描當下**的狀態，不是保證——真正要跑的時候可能已經被別人佔走。
 */
router.post('/scan-lobby', async (req, res, next) => {
  try {
    const { agentId, gameUrlTemplate, headed } = req.body as { agentId?: string; gameUrlTemplate?: string; headed?: boolean }
    if (!agentId || !gameUrlTemplate) return res.status(400).json({ ok: false, message: '缺少 agentId 或 gameUrlTemplate' })
    const agent = agentConnections.get(agentId)
    if (!agent) return res.status(409).json({ ok: false, message: '指定 Agent 不在線' })

    const scanId = randomUUID()
    const result = await new Promise<ScanResult>(resolve => {
      const timer = setTimeout(() => {
        pendingScans.delete(scanId)
        resolve({ ok: false, message: '掃描逾時（120 秒）——Agent 可能沒收到或大廳載不出來' })
      }, 120_000)
      pendingScans.set(scanId, r => { clearTimeout(timer); pendingScans.delete(scanId); resolve(r) })
      // headed 要一路傳到 agent：PC 版在 headless 下可能沒有 WebGL，
      // 而掃描原本寫死 headless，導致畫面上的開關對掃描完全沒作用
      agent.ws.send(JSON.stringify({ type: 'ui_screenshot_scan', scanId, gameUrlTemplate, headed: !!headed }))
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/** Agent 掃完之後回報結果 */
router.post('/scan-result/:scanId', (req, res) => {
  const resolve = pendingScans.get(req.params.scanId)
  if (!resolve) return res.status(404).json({ ok: false, message: 'scan not pending' })
  resolve(req.body as ScanResult)
  res.json({ ok: true })
})

router.post('/start', (req, res) => {
  const { wikiUrl, gameUrlTemplate, gmids, resolutions, concurrency, options, agentId } = req.body as {
    wikiUrl: string
    gameUrlTemplate: string
    gmids: string[]
    resolutions: string[]
    concurrency?: number
    options?: Record<string, boolean | number>
    agentId: string
  }

  if (!gameUrlTemplate || !gmids?.length || !resolutions?.length || !agentId) {
    return res.status(400).json({ ok: false, message: '缺少必要欄位' })
  }

  const agent = agentConnections.get(agentId)
  if (!agent || agent.busy) {
    return res.status(409).json({ ok: false, message: '指定 Agent 不存在或正在忙碌' })
  }

  const runId = randomUUID()
  const now = Date.now()
  const opts = options ?? {}
  const conc = concurrency ?? 3

  // Create run
  const runOperator = getOperatorFromContext()
  db.prepare(`
    INSERT INTO ui_screenshot_runs (id, status, wiki_url, game_url_template, gmids, resolutions, concurrency, options, agent_id, operator_key, operator_name, created_at)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, wikiUrl ?? '', gameUrlTemplate, JSON.stringify(gmids), JSON.stringify(resolutions), conc, JSON.stringify(opts), agentId, runOperator?.key ?? '', runOperator?.name ?? '', now)

  // Create tasks
  const insertTask = db.prepare(`
    INSERT INTO ui_screenshot_tasks (id, run_id, gmid, resolution, status)
    VALUES (?, ?, ?, ?, 'pending')
  `)
  const tasks: Array<{ id: string; gmid: string; resolution: string }> = []
  for (const gmid of gmids) {
    for (const resolution of resolutions) {
      const taskId = randomUUID()
      insertTask.run(taskId, runId, gmid, resolution)
      tasks.push({ id: taskId, gmid, resolution })
    }
  }

  // Update run status to running
  db.prepare(`UPDATE ui_screenshot_runs SET status = 'running', started_at = ? WHERE id = ?`).run(now, runId)

  // Dispatch to agent
  agent.busy = true
  agent.sessionId = runId
  agent.ws.send(JSON.stringify({
    type: 'ui_screenshot_start',
    sessionId: runId,
    run: {
      id: runId,
      gameUrlTemplate,
      tasks,
      options: opts,
      concurrency: conc,
    },
  }))

  res.json({ ok: true, runId, totalTasks: tasks.length })
})

// POST /stop/:runId
router.post('/stop/:runId', (req, res) => {
  const { runId } = req.params
  const run = db.prepare(`SELECT * FROM ui_screenshot_runs WHERE id = ?`).get(runId) as { agent_id?: string; status: string } | undefined
  if (!run) return res.status(404).json({ ok: false, message: 'Run not found' })

  db.prepare(`UPDATE ui_screenshot_runs SET status = 'stopped', finished_at = ? WHERE id = ?`).run(Date.now(), runId)
  db.prepare(`UPDATE ui_screenshot_tasks SET status = 'skipped' WHERE run_id = ? AND status IN ('pending','running')`).run(runId)
  saveUiScreenshotHistory(runId, 'stopped')

  // Notify agent
  if (run.agent_id) {
    const agent = agentConnections.get(run.agent_id)
    if (agent?.ws.readyState === 1 /* OPEN */) {
      agent.ws.send(JSON.stringify({ type: 'ui_screenshot_stop', sessionId: runId }))
    }
    if (agent) { agent.busy = false; agent.sessionId = null }
  }

  emitToRun(runId, { type: 'run_stopped', runId })
  res.json({ ok: true })
})

// GET /runs — list recent runs
router.get('/runs', (_req, res) => {
  const runs = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM ui_screenshot_tasks t WHERE t.run_id = r.id) AS total_tasks,
      (SELECT COUNT(*) FROM ui_screenshot_tasks t WHERE t.run_id = r.id AND t.status = 'ok') AS ok_count,
      (SELECT COUNT(*) FROM ui_screenshot_tasks t WHERE t.run_id = r.id AND t.status = 'popup') AS popup_count,
      (SELECT COUNT(*) FROM ui_screenshot_tasks t WHERE t.run_id = r.id AND t.status IN ('err','timeout')) AS err_count
    FROM ui_screenshot_runs r
    ORDER BY r.created_at DESC
    LIMIT 20
  `).all()
  res.json({ ok: true, runs })
})

// GET /run/:runId
router.get('/run/:runId', (req, res) => {
  const run = db.prepare(`SELECT * FROM ui_screenshot_runs WHERE id = ?`).get(req.params.runId)
  if (!run) return res.status(404).json({ ok: false, message: 'Run not found' })
  const tasks = db.prepare(`SELECT * FROM ui_screenshot_tasks WHERE run_id = ? ORDER BY gmid, resolution`).all(req.params.runId)
  res.json({ ok: true, run, tasks })
})

// GET /events/:runId — SSE
router.get('/events/:runId', (req, res) => {
  const { runId } = req.params
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  if (!sseSubscribers.has(runId)) sseSubscribers.set(runId, new Set())
  sseSubscribers.get(runId)!.add(res)

  // Send current state immediately
  const run = db.prepare(`SELECT * FROM ui_screenshot_runs WHERE id = ?`).get(runId)
  const tasks = db.prepare(`SELECT id, run_id, gmid, resolution, status, server_path, error_msg FROM ui_screenshot_tasks WHERE run_id = ?`).all(runId)
  res.write(`data: ${JSON.stringify({ type: 'snapshot', run, tasks })}\n\n`)

  req.on('close', () => sseSubscribers.get(runId)?.delete(res))
})

// POST /task/:taskId/upload — agent uploads screenshot
router.post('/task/:taskId/upload', upload.single('screenshot'), async (req, res) => {
  const { taskId } = req.params
  const task = db.prepare(`SELECT * FROM ui_screenshot_tasks WHERE id = ?`).get(taskId) as {
    run_id: string; gmid: string; resolution: string; status: string
  } | undefined
  if (!task) return res.status(404).json({ ok: false, message: 'Task not found' })
  if (!req.file) return res.status(400).json({ ok: false, message: '缺少截圖檔案' })

  const { status, errorMsg, actualGmid } = req.body as { status?: string; errorMsg?: string; actualGmid?: string }
  const taskStatus = status ?? 'ok'
  // ⚠️ 自動選機時 `gmid` 欄位放的是**遊戲代號**，實際進的是哪一台由大廳當下狀態決定，
  //    而且每個解析度都可能換台——不記下來的話，事後看到版型問題不知道是哪一台拍的
  const actual = (actualGmid ?? '').trim() || null
  const now = Date.now()

  // Save file
  const dir = taskDir(task.run_id, task.gmid)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const filePath = screenshotPath(task.run_id, task.gmid, task.resolution)
  await writeFile(filePath, req.file.buffer)

  const relPath = serverRelPath(task.run_id, task.gmid, task.resolution)
  db.prepare(`
    UPDATE ui_screenshot_tasks SET status = ?, server_path = ?, error_msg = ?, actual_gmid = ?, finished_at = ?
    WHERE id = ?
  `).run(taskStatus, relPath, errorMsg ?? null, actual, now, taskId)

  emitToRun(task.run_id, {
    type: 'task_update',
    runId: task.run_id,
    taskId,
    gmid: task.gmid,
    resolution: task.resolution,
    actualGmid: actual,
    status: taskStatus,
    serverPath: relPath,
    errorMsg: errorMsg ?? null,
  })

  // Check if run is complete
  const pending = db.prepare(
    `SELECT COUNT(*) as cnt FROM ui_screenshot_tasks WHERE run_id = ? AND status IN ('pending','running')`
  ).get(task.run_id) as { cnt: number }

  if (pending.cnt === 0) {
    const historyCounts = uiScreenshotCounts(task.run_id)
    const counts = {
      ok_count: historyCounts.ok_count ?? 0,
      popup_count: historyCounts.popup_count ?? 0,
      err_count: historyCounts.err_count ?? 0,
    }

    db.prepare(`UPDATE ui_screenshot_runs SET status = 'done', finished_at = ? WHERE id = ?`).run(now, task.run_id)
    saveUiScreenshotHistory(task.run_id, 'done')

    // Release agent
    const run = db.prepare(`SELECT agent_id FROM ui_screenshot_runs WHERE id = ?`).get(task.run_id) as { agent_id?: string } | undefined
    if (run?.agent_id) {
      const agent = agentConnections.get(run.agent_id)
      if (agent) { agent.busy = false; agent.sessionId = null }
    }

    emitToRun(task.run_id, { type: 'run_complete', runId: task.run_id, ...counts })
    sseSubscribers.delete(task.run_id)
  }

  res.json({ ok: true })
})

// POST /task/:taskId/status — agent reports task status without file (err/timeout)
router.post('/task/:taskId/status', (req, res) => {
  const { taskId } = req.params
  const task = db.prepare(`SELECT * FROM ui_screenshot_tasks WHERE id = ?`).get(taskId) as {
    run_id: string; gmid: string; resolution: string
  } | undefined
  if (!task) return res.status(404).json({ ok: false, message: 'Task not found' })

  const { status, errorMsg } = req.body as { status: string; errorMsg?: string }
  const now = Date.now()

  db.prepare(`UPDATE ui_screenshot_tasks SET status = ?, error_msg = ?, finished_at = ? WHERE id = ?`)
    .run(status, errorMsg ?? null, now, taskId)

  emitToRun(task.run_id, {
    type: 'task_update',
    runId: task.run_id,
    taskId,
    gmid: task.gmid,
    resolution: task.resolution,
    status,
    errorMsg: errorMsg ?? null,
  })

  // Check completion
  const pending = db.prepare(
    `SELECT COUNT(*) as cnt FROM ui_screenshot_tasks WHERE run_id = ? AND status IN ('pending','running')`
  ).get(task.run_id) as { cnt: number }

  if (pending.cnt === 0) {
    const historyCounts = uiScreenshotCounts(task.run_id)
    const counts = {
      ok_count: historyCounts.ok_count ?? 0,
      popup_count: historyCounts.popup_count ?? 0,
      err_count: historyCounts.err_count ?? 0,
    }

    db.prepare(`UPDATE ui_screenshot_runs SET status = 'done', finished_at = ? WHERE id = ?`).run(now, task.run_id)
    saveUiScreenshotHistory(task.run_id, 'done')
    const run = db.prepare(`SELECT agent_id FROM ui_screenshot_runs WHERE id = ?`).get(task.run_id) as { agent_id?: string } | undefined
    if (run?.agent_id) {
      const agent = agentConnections.get(run.agent_id)
      if (agent) { agent.busy = false; agent.sessionId = null }
    }
    emitToRun(task.run_id, { type: 'run_complete', runId: task.run_id, ...counts })
    sseSubscribers.delete(task.run_id)
  }

  res.json({ ok: true })
})

// GET /screenshot/:runId/:gmid/:resolution
router.get('/screenshot/:runId/:gmid/:resolution', (req, res) => {
  const { runId, gmid, resolution } = req.params
  const filePath = screenshotPath(runId, gmid, resolution)
  if (!existsSync(filePath)) return res.status(404).json({ ok: false, message: 'Screenshot not found' })
  res.setHeader('Content-Type', 'image/png')
  createReadStream(filePath).pipe(res)
})

// POST /fetch-gmids — read gmid column from a Lark Sheet (same pattern as machine-test/lark-machines)
router.post('/fetch-gmids', async (req, res) => {
  const { sheetUrl } = req.body as { sheetUrl?: string }
  if (!sheetUrl?.trim()) return res.status(400).json({ ok: false, message: '請填入 Lark Sheet URL' })

  try {
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)
    if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 Lark Sheet URL' })

    const larkToken = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

    // If no sheetId in URL, fetch metadata to get the first sheet's ID
    let resolvedSheetId = sheetId
    if (!resolvedSheetId) {
      const metaResp = await fetch(
        `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}`,
        { headers: { Authorization: `Bearer ${larkToken}` } },
      )
      const metaData = await metaResp.json() as { code?: number; data?: { sheets?: Array<{ sheet_id: string }> }; msg?: string }
      if (metaData.code === 0 && metaData.data?.sheets?.length) {
        resolvedSheetId = metaData.data.sheets[0].sheet_id
      }
    }

    const range = resolvedSheetId ? `${resolvedSheetId}!A1:Z2000` : 'A1:Z2000'
    const resp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
      { headers: { Authorization: `Bearer ${larkToken}` } },
    )
    const data = await resp.json() as { code?: number; data?: { valueRange?: { values?: unknown[][] } }; msg?: string }
    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: `Lark API 錯誤: ${data.msg ?? resp.status}` })
    }

    const rows = data.data?.valueRange?.values ?? []
    if (rows.length === 0) return res.json({ ok: true, gmids: [] })

    // Find gmid column header (may be in row 1 or row 2 for merged-header sheets)
    const findGmidCol = (row: unknown[]) =>
      row.findIndex(c => String(c ?? '').trim().toLowerCase() === 'gmid')

    let headerRowIdx = 0
    let gmidCol = findGmidCol(rows[0] as unknown[])
    if (gmidCol === -1 && rows.length > 1) {
      gmidCol = findGmidCol(rows[1] as unknown[])
      if (gmidCol !== -1) headerRowIdx = 1
    }

    if (gmidCol === -1) {
      return res.status(400).json({ ok: false, message: '找不到 "gmid" 欄位，請確認 Sheet 中有 gmid 標題列' })
    }

    const gmids = rows
      .slice(headerRowIdx + 1)
      .map(row => String((row as unknown[])[gmidCol] ?? '').trim())
      .filter(g => g.length > 0 && g !== 'null')

    res.json({ ok: true, gmids })
  } catch (err) {
    res.status(500).json({ ok: false, message: String(err) })
  }
})

// ─── Helpers for writeback ────────────────────────────────────────────────────

function colIndexToLetter(idx: number): string {
  if (idx < 26) return String.fromCharCode(65 + idx)
  return String.fromCharCode(64 + Math.floor(idx / 26)) + String.fromCharCode(65 + (idx % 26))
}

function resolveSheetToken(sheetUrl: string): { spreadsheetToken: string; sheetId: string } {
  return parseLarkSheetUrl(sheetUrl)
}

// POST /run/:runId/writeback — write screenshot images back to Lark Sheet
router.post('/run/:runId/writeback', async (req, res) => {
  const run = db.prepare(`SELECT * FROM ui_screenshot_runs WHERE id = ?`).get(req.params.runId) as {
    wiki_url: string; gmids: string; resolutions: string; status: string
  } | undefined
  if (!run) return res.status(404).json({ ok: false, message: 'Run not found' })
  if (!run.wiki_url?.trim()) return res.status(400).json({ ok: false, message: '此 Run 未設定 Lark Sheet URL' })

  const okTasks = db.prepare(`
    SELECT * FROM ui_screenshot_tasks
    WHERE run_id = ? AND status IN ('ok','popup') AND server_path IS NOT NULL
  `).all(req.params.runId) as Array<{
    id: string; gmid: string; resolution: string; run_id: string; server_path: string
  }>
  if (okTasks.length === 0) return res.json({ ok: true, written: 0, message: '沒有成功的截圖可回寫' })

  try {
    const larkToken = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

    const { spreadsheetToken, sheetId: rawSheetId } = resolveSheetToken(run.wiki_url)
    if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 spreadsheet token' })

    // If no sheetId in URL, fetch metadata to get the first sheet's ID
    let sheetId = rawSheetId
    if (!sheetId) {
      const metaResp = await fetch(
        `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}`,
        { headers: { Authorization: `Bearer ${larkToken}` } },
      )
      const metaData = await metaResp.json() as { code?: number; data?: { sheets?: Array<{ sheet_id: string }> } }
      if (metaData.code === 0 && metaData.data?.sheets?.length) {
        sheetId = metaData.data.sheets[0].sheet_id
      }
    }

    // ── Step 1: Read sheet to get headers + gmid row indices ───────────────────
    const range = sheetId ? `${sheetId}!A1:AZ2000` : 'A1:AZ2000'
    const sheetResp = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`, {
      headers: { Authorization: `Bearer ${larkToken}` },
    })
    const sheetData = await sheetResp.json() as { code?: number; data?: { valueRange?: { values?: unknown[][] } } }
    if (sheetData.code !== 0) return res.status(400).json({ ok: false, message: `讀取 Sheet 失敗: code=${sheetData.code}` })

    const rows = sheetData.data?.valueRange?.values ?? []
    const findGmidCol = (row: unknown[]) => row.findIndex(c => String(c ?? '').trim().toLowerCase() === 'gmid')
    let headerRowIdx = 0
    let gmidCol = findGmidCol(rows[0] as unknown[] ?? [])
    if (gmidCol === -1 && rows.length > 1) {
      gmidCol = findGmidCol(rows[1] as unknown[])
      if (gmidCol !== -1) headerRowIdx = 1
    }
    if (gmidCol === -1) return res.status(400).json({ ok: false, message: '找不到 gmid 欄位' })

    const headerRow = (rows[headerRowIdx] as unknown[]).map(c => String(c ?? '').trim())
    const gmidToRowIndex = new Map<string, number>()
    rows.slice(headerRowIdx + 1).forEach((row, i) => {
      const gmid = String((row as unknown[])[gmidCol] ?? '').trim()
      if (gmid && gmid !== 'null') gmidToRowIndex.set(gmid, headerRowIdx + 2 + i) // 1-based
    })

    // ── Step 2: Put screenshot columns immediately after gmid ────────────────
    // Lark can return sparse header rows padded to AZ/BA, so do not append by headerRow.length.
    const runResolutions = JSON.parse(run.resolutions || '[]') as string[]
    const resolutions = runResolutions.length
      ? runResolutions.filter(res => okTasks.some(t => t.resolution === res))
      : [...new Set(okTasks.map(t => t.resolution))]
    const resColMap = new Map<string, number>() // resolution → 0-based col index
    const firstScreenshotCol = gmidCol + 1

    if (resolutions.length > 0) {
      const headerStart = colIndexToLetter(firstScreenshotCol) + (headerRowIdx + 1)
      const headerEnd = colIndexToLetter(firstScreenshotCol + resolutions.length - 1) + (headerRowIdx + 1)
      const headerRange = sheetId ? `${sheetId}!${headerStart}:${headerEnd}` : `${headerStart}:${headerEnd}`
      const headerWriteResp = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${larkToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueRange: { range: headerRange, values: [resolutions] } }),
      })
      const headerWriteData = await headerWriteResp.json().catch(() => null) as { code?: number; msg?: string } | null
      if (!headerWriteResp.ok || headerWriteData?.code !== 0) {
        return res.status(400).json({ ok: false, message: `write resolution headers failed: ${headerWriteData?.msg ?? headerWriteResp.status}` })
      }
    }

    for (const [idx, res] of resolutions.entries()) {
      resColMap.set(res, firstScreenshotCol + idx)
    }

    // ── Step 3: Write each screenshot into its cell ──────────────────────────
    let written = 0
    const errors: string[] = []

    for (const task of okTasks) {
      const rowIdx = gmidToRowIndex.get(task.gmid)
      const colIdx = resColMap.get(task.resolution)
      if (!rowIdx || colIdx === undefined) {
        errors.push(`${task.gmid}@${task.resolution}: missing sheet row or resolution column`)
        continue
      }

      const filePath = screenshotPath(task.run_id, task.gmid, task.resolution)
      if (!existsSync(filePath)) {
        errors.push(`${task.gmid}@${task.resolution}: screenshot file not found`)
        continue
      }

      try {
        const fileBuffer = await readFile(filePath)

        const cell = colIndexToLetter(colIdx) + rowIdx
        const writeRange = sheetId ? `${sheetId}!${cell}:${cell}` : `${cell}:${cell}`
        const writeResp = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_image`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${larkToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            range: writeRange,
            image: [...new Uint8Array(fileBuffer)],
            name: `${task.gmid}_${task.resolution}.png`,
          }),
        })
        const writeData = await writeResp.json() as { code?: number; msg?: string }
        if (!writeResp.ok || writeData.code !== 0) {
          errors.push(`${task.gmid}@${task.resolution}: write image failed code=${writeData.code ?? writeResp.status} ${writeData.msg ?? ''}`)
          continue
        }
        written++
      } catch (err) {
        errors.push(`${task.gmid}@${task.resolution}: ${String(err)}`)
      }
    }

    res.json({ ok: true, written, total: okTasks.length, errors: errors.slice(0, 10) })
  } catch (err) {
    res.status(500).json({ ok: false, message: String(err) })
  }
})

export default router

/**
 * server/routes/ui-screenshot.ts
 * UI Resolution Screenshot Tool — batch screenshot H5 games at multiple resolutions.
 * Architecture: Local Agent runs Playwright, uploads screenshots back to server.
 */
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, createReadStream } from 'fs'
import { writeFile, readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { db, getLarkToken, parseLarkSheetUrl } from '../shared.js'
import { agentConnections } from '../agent-hub.js'
import { getOperatorFromContext } from '../request-context.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SAVES_DIR = join(__dirname, '..', '..', 'server', 'ui-screenshot-saves')

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
    server_path TEXT,
    error_msg   TEXT,
    started_at  INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ui_ss_tasks_run ON ui_screenshot_tasks (run_id, status);
`

// Run schema migration on module load
db.exec(UI_SCREENSHOT_SCHEMA)

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

function taskDir(runId: string, gmid: string) {
  return join(SAVES_DIR, runId, gmid)
}

function screenshotPath(runId: string, gmid: string, resolution: string) {
  return join(taskDir(runId, gmid), `${resolution}.png`)
}

function serverRelPath(runId: string, gmid: string, resolution: string) {
  return `ui-screenshot-saves/${runId}/${gmid}/${resolution}.png`
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
  db.prepare(`
    INSERT INTO ui_screenshot_runs (id, status, wiki_url, game_url_template, gmids, resolutions, concurrency, options, agent_id, created_at)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, wikiUrl ?? '', gameUrlTemplate, JSON.stringify(gmids), JSON.stringify(resolutions), conc, JSON.stringify(opts), agentId, now)

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

  const { status, errorMsg } = req.body as { status?: string; errorMsg?: string }
  const taskStatus = status ?? 'ok'
  const now = Date.now()

  // Save file
  const dir = taskDir(task.run_id, task.gmid)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const filePath = screenshotPath(task.run_id, task.gmid, task.resolution)
  await writeFile(filePath, req.file.buffer)

  const relPath = serverRelPath(task.run_id, task.gmid, task.resolution)
  db.prepare(`
    UPDATE ui_screenshot_tasks SET status = ?, server_path = ?, error_msg = ?, finished_at = ?
    WHERE id = ?
  `).run(taskStatus, relPath, errorMsg ?? null, now, taskId)

  emitToRun(task.run_id, {
    type: 'task_update',
    runId: task.run_id,
    taskId,
    gmid: task.gmid,
    resolution: task.resolution,
    status: taskStatus,
    serverPath: relPath,
    errorMsg: errorMsg ?? null,
  })

  // Check if run is complete
  const pending = db.prepare(
    `SELECT COUNT(*) as cnt FROM ui_screenshot_tasks WHERE run_id = ? AND status IN ('pending','running')`
  ).get(task.run_id) as { cnt: number }

  if (pending.cnt === 0) {
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN status='popup' THEN 1 ELSE 0 END) AS popup_count,
        SUM(CASE WHEN status IN ('err','timeout') THEN 1 ELSE 0 END) AS err_count
      FROM ui_screenshot_tasks WHERE run_id = ?
    `).get(task.run_id) as { ok_count: number; popup_count: number; err_count: number }

    db.prepare(`UPDATE ui_screenshot_runs SET status = 'done', finished_at = ? WHERE id = ?`).run(now, task.run_id)

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
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN status='popup' THEN 1 ELSE 0 END) AS popup_count,
        SUM(CASE WHEN status IN ('err','timeout') THEN 1 ELSE 0 END) AS err_count
      FROM ui_screenshot_tasks WHERE run_id = ?
    `).get(task.run_id) as { ok_count: number; popup_count: number; err_count: number }

    db.prepare(`UPDATE ui_screenshot_runs SET status = 'done', finished_at = ? WHERE id = ?`).run(now, task.run_id)
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

    const range = sheetId ? `${sheetId}!A1:Z2000` : 'A1:Z2000'
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

    const { spreadsheetToken, sheetId } = resolveSheetToken(run.wiki_url)
    if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 spreadsheet token' })

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

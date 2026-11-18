/**
 * API 參數紀錄 `/api/api-capture/*`（docs/features/35-api-capture.md）。
 *
 * 流程：派工給 Local Agent 錄前台（agent-hub，同 AutoSpin／機台測試）→ agent 回報結束 →
 * server 打後台 Log Third Http Req／Bet Req（同帳號同時段）→ 時間校正、彙整、算參數簽名 →
 * 跟「同環境＋同渠道＋同帳號＋同機台的上一筆成功紀錄」比對。
 *
 * 掛在 worker（agent WebSocket 在這支 process），main 用 proxyToWorker 轉過來。
 * 身分只認 getAuthEmailFromContext()（簽章驗過）；權限 key：api-capture；後台設定只限管理員。
 */
import { Router, type Response } from 'express'
import { z } from 'zod'
import { db, addHistory, accountHasPermission } from '../shared.js'
import { encryptSecret, decryptSecret } from '../secret-crypto.js'
import { agentConnections, getAvailableAgents, type AgentInfo } from '../agent-hub.js'
import { tryStartHeavyTask, finishHeavyTask, heavyTaskConflict, bindHeavyTaskOwner, releaseHeavyTaskById, type HeavyTaskToken } from '../heavy-task-guard.js'
import { getAuthEmailFromContext, getOperatorFromContext } from '../request-context.js'
import { agentUpdateStatus } from './machine-test.js'
import { maskText, maskUrl } from '../api-capture/mask.js'
import { machineKey, parseMachineInput } from '../api-capture/parse.js'
import {
  buildSignature, buildTimeline, calibrate, diffSignatures, splitByWindow, httpComparable, parsePinusConsole,
  type BackendItem, type Calibration, type Signature,
} from '../api-capture/core.js'
import { fetchBackendLogs, type BackendConfig } from '../api-capture/backend-client.js'
import { buildExcel, fmtTs } from '../api-capture/excel.js'
import type { ApiCaptureChunk, ApiCaptureDone, ApiCaptureProgress, ApiCaptureStartMessage, CaptureEnv, FrontEvent } from '../api-capture/types.js'

export const router = Router()

// ─── DB ───────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS api_capture_runs (
    id TEXT PRIMARY KEY,
    env TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL,
    machine TEXT NOT NULL,
    machine_key TEXT NOT NULL DEFAULT '',
    lobby_url_masked TEXT NOT NULL DEFAULT '',
    stop_condition TEXT NOT NULL,
    spins INTEGER,
    max_spins INTEGER,
    agent_id TEXT,
    agent_host TEXT,
    task_id TEXT,
    status TEXT NOT NULL,
    phase TEXT,
    message TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    front_started_at INTEGER,
    front_finished_at INTEGER,
    time_calibration TEXT,
    completeness TEXT,
    baseline_run_id TEXT,
    signature TEXT,
    summary TEXT,
    operator_key TEXT,
    operator_name TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_capture_runs_match ON api_capture_runs(env, channel_id, account, machine_key, started_at);
  CREATE TABLE IF NOT EXISTS api_capture_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    t INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE IF NOT EXISTS api_capture_backend (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    event TEXT NOT NULL,
    reqtime INTEGER NOT NULL,
    in_window INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
`)

type RunRow = {
  id: string; env: CaptureEnv; channel_id: string; account: string; machine: string; machine_key: string; lobby_url_masked: string
  stop_condition: string; spins: number | null; max_spins: number | null; agent_id: string | null; agent_host: string | null; task_id: string | null
  status: RunStatus; phase: string | null; message: string | null; started_at: number; finished_at: number | null
  front_started_at: number | null; front_finished_at: number | null; time_calibration: string | null; completeness: string | null
  baseline_run_id: string | null; signature: string | null; summary: string | null; operator_key: string | null; operator_name: string | null
}
type RunStatus = 'running' | 'collecting' | 'done' | 'incomplete' | 'failed' | 'cancelled'

const ENVS: CaptureEnv[] = ['qat', 'uat']
const ENV_LABEL: Record<CaptureEnv, string> = { qat: 'QAT', uat: 'UAT' }

// ─── 後台設定（帳密加密存 settings；只限管理員） ─────────────────────────────

/** 預設值。UAT 的網域來自 OSM QA 記憶（project_osm_channels.md：gameRecordList 實測過），log 端點**沒實測過** */
export const BACKEND_DEFAULTS: Record<CaptureEnv, { baseUrl: string; origin: string; channelId: string; verified: boolean }> = {
  qat: { baseUrl: 'https://backendservertest.osmslot.org', origin: 'https://qat-cp.osmslot.org', channelId: '873', verified: true },
  uat: { baseUrl: 'https://uat-backendservertest.osmslot.org', origin: 'http://uat-cp.osmslot.org', channelId: '4186', verified: false },
}
export const BACKEND_PASSWORD_KEYS = ENVS.map(e => `api_capture_backend_${e}_password`)

const getSetting = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? ''
const setSetting = (key: string, value: string) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

function loadBackendConfig(env: CaptureEnv): BackendConfig & { hasPassword: boolean } {
  let saved: Partial<BackendConfig> = {}
  try { saved = JSON.parse(getSetting(`api_capture_backend_${env}`) || '{}') } catch { /* 壞掉當沒設 */ }
  const stored = getSetting(`api_capture_backend_${env}_password`)
  let password = ''
  try { password = stored ? (decryptSecret(stored) ?? '') : '' } catch { password = '' }
  const d = BACKEND_DEFAULTS[env]
  return {
    baseUrl: saved.baseUrl || d.baseUrl, origin: saved.origin || d.origin, channelId: saved.channelId || d.channelId,
    username: saved.username || '', password, hasPassword: !!stored,
  }
}

// ─── 身分與權限 ────────────────────────────────────────────────────────────────

function me() {
  const email = getAuthEmailFromContext()
  if (!email) return null
  const row = db.prepare('SELECT role, label FROM jira_accounts WHERE email = ?').get(email) as { role?: string; label?: string } | undefined
  const role = row?.role ?? ''
  return { email, role, label: row?.label || getOperatorFromContext()?.name || email, isAdmin: role === 'admin' }
}

function need(res: Response, admin = false) {
  const u = me()
  if (!u) { res.status(401).json({ ok: false, message: '請先登入' }); return null }
  if (!accountHasPermission(u.email, u.role, 'api-capture')) { res.status(403).json({ ok: false, message: '沒有「API 參數紀錄」權限，請洽管理員' }); return null }
  if (admin && !u.isAdmin) { res.status(403).json({ ok: false, message: '只有管理員可以修改後台設定' }); return null }
  return u
}

// ─── 執行中的紀錄 ──────────────────────────────────────────────────────────────

interface Active {
  runId: string
  agentId: string
  heavy: HeavyTaskToken | null
  lockKeys: string[]
  received: number
  chunkSeqs: Set<number>
  watchdog: NodeJS.Timeout
  stopTimer: NodeJS.Timeout | null
  operatorKey: string
  /** 逾時觸發過（已送 stop，等 agent 回報） */
  timedOut: boolean
  /**
   * 送了 stop、寬限期內 agent 沒回報：紀錄標失敗，但**機台／帳號鎖、重任務鎖、agent 忙碌都保留**，
   * 直到 agent 回報結束或斷線（CodeX 1118 [P1]：沒確認停下注就放鎖，新任務會跟還在下注的舊 runner 撞在同一台）
   */
  quarantined: boolean
}
const active = new Map<string, Active>()
/** 鎖（含環境）：`qat|machine|144`、`qat|account|9421000006` → runId */
const lockOwners = new Map<string, string>()
/** 最多 300 局 × 一局約 5 秒＝25 分鐘，加上進出機台與看不到 moneyNtc 時的等待，留到 60 分鐘。環境變數只給冒煙測試縮短用 */
const RUN_TIMEOUT_MS = Number(process.env.API_CAPTURE_TIMEOUT_MS) || 60 * 60_000
/** 送 stop 之後等 agent 回報的寬限期 */
const STOP_GRACE_MS = Number(process.env.API_CAPTURE_STOP_GRACE_MS) || 90_000

export function lockKeysFor(env: CaptureEnv, machine: string, account: string): string[] {
  const m = parseMachineInput(machine)
  return [`${env}|machine|${m.num ?? machineKey(machine)}`, `${env}|account|${account.toLowerCase()}`]
}

function releaseRun(runId: string) {
  const a = active.get(runId)
  if (!a) return
  clearTimeout(a.watchdog)
  if (a.stopTimer) clearTimeout(a.stopTimer)
  for (const k of a.lockKeys) if (lockOwners.get(k) === runId) lockOwners.delete(k)
  finishHeavyTask(a.heavy)
  const agent = agentConnections.get(a.agentId)
  if (agent && agent.sessionId === runId) { agent.busy = false; agent.sessionId = null }
  active.delete(runId)
}

const getRun = (id: string) => db.prepare('SELECT * FROM api_capture_runs WHERE id = ?').get(id) as RunRow | undefined
function patchRun(id: string, patch: Partial<RunRow>) {
  const keys = Object.keys(patch)
  if (!keys.length) return
  db.prepare(`UPDATE api_capture_runs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => (patch as Record<string, unknown>)[k] as never), id)
}

/** 收尾失敗（斷線、逾時、伺服器重啟）：沒有前台結果就不查後台，直接標失敗 */
function failRun(runId: string, message: string) {
  const run = getRun(runId)
  releaseRun(runId)
  if (!run || !['running'].includes(run.status)) return
  patchRun(runId, { status: 'failed', phase: 'done', message, finished_at: Date.now() })
  saveHistory(runId)
}

/** 要 agent 停下來（退出機台），寬限期內沒回報就隔離（不放鎖） */
function requestStop(a: Active) {
  const agent: AgentInfo | undefined = agentConnections.get(a.agentId)
  if (agent && agent.ws.readyState === agent.ws.OPEN) agent.ws.send(JSON.stringify({ type: 'api_capture_stop', runId: a.runId }))
  a.stopTimer ??= setTimeout(() => quarantine(a.runId), STOP_GRACE_MS)
}

function onTimeout(runId: string) {
  const a = active.get(runId)
  if (!a) return
  a.timedOut = true
  patchRun(runId, { message: `超過 ${Math.round(RUN_TIMEOUT_MS / 60_000)} 分鐘沒有結束，已要求 agent 停止並退出機台` })
  requestStop(a)
}

function quarantine(runId: string) {
  const a = active.get(runId)
  if (!a || a.quarantined) return
  a.quarantined = true
  clearTimeout(a.watchdog)
  const run = getRun(runId)
  if (run && run.status === 'running') {
    patchRun(runId, { status: 'failed', phase: 'done', finished_at: Date.now(), message: `${a.timedOut ? '逾時' : '取消'}後 agent 沒有確認停止：機台／帳號鎖與這台 agent 先保留，等 agent 回報或斷線才釋放` })
    saveHistory(runId)
  }
}

/** worker 啟動時呼叫：上一個 process 留下的 running 一律標失敗，並放掉它們的重任務鎖（鎖會從 DB 復原，沒人放就一直擋） */
export function initApiCapture() {
  const n = db.prepare("UPDATE api_capture_runs SET status = 'failed', phase = 'done', message = '伺服器重啟，這筆紀錄中斷', finished_at = ? WHERE status IN ('running', 'collecting')").run(Date.now()).changes
  if (n) console.log(`[api-capture] 伺服器重啟：${n} 筆執行中的紀錄標成失敗`)
  // 重啟後記憶體裡沒有任何進行中的紀錄 → 這個功能所有 running 的重任務鎖都是孤兒（agent 也會因 WS 斷線停下 runner）
  const locks = db.prepare("SELECT id FROM heavy_tasks WHERE type = 'api-capture' AND status = 'running'").all() as { id: string }[]
  for (const l of locks) releaseHeavyTaskById(l.id, 'API 參數紀錄：伺服器重啟，釋放上一個 process 留下的鎖')
  if (locks.length) console.log(`[api-capture] 伺服器重啟：釋放 ${locks.length} 筆重任務鎖`)
  // 事件明細保留 180 天
  const old = Date.now() - 180 * 86400_000
  db.prepare('DELETE FROM api_capture_events WHERE run_id IN (SELECT id FROM api_capture_runs WHERE started_at < ?)').run(old)
  db.prepare('DELETE FROM api_capture_backend WHERE run_id IN (SELECT id FROM api_capture_runs WHERE started_at < ?)').run(old)
}

// ─── agent 訊息 ────────────────────────────────────────────────────────────────

/** worker 收到 agent 的 api_capture_* 訊息。owns：這條連線是不是這筆紀錄目前的 agent */
export function handleApiCaptureAgentMessage(msg: ApiCaptureProgress | ApiCaptureChunk | ApiCaptureDone, owns: (runId: string) => boolean) {
  const a = active.get(msg.runId)
  if (!a || !owns(msg.runId)) return
  if (msg.type === 'api_capture_progress') {
    patchRun(msg.runId, { phase: msg.phase, message: maskText(msg.message).slice(0, 300) })
    return
  }
  if (msg.type === 'api_capture_chunk') {
    if (a.chunkSeqs.has(msg.seq) || !Array.isArray(msg.items)) return
    a.chunkSeqs.add(msg.seq)
    const base = a.received
    const ins = db.prepare('INSERT OR IGNORE INTO api_capture_events (run_id, seq, kind, t, data) VALUES (?, ?, ?, ?, ?)')
    db.transaction(() => {
      msg.items.forEach((it, i) => {
        // 落盤前再遮一次（agent 已遮過，這是第二道）
        const clean = JSON.parse(maskText(JSON.stringify(it))) as FrontEvent
        ins.run(msg.runId, base + i, clean.kind, Number(clean.t) || 0, JSON.stringify(clean))
      })
    })()
    a.received += msg.items.length
    return
  }
  if (msg.type === 'api_capture_done') {
    if (a.quarantined) {
      // 已經判失敗、只是在等 agent 確認停下來：現在確認了，放鎖
      releaseRun(msg.runId)
      const r = getRun(msg.runId)
      patchRun(msg.runId, { message: `${r?.message ?? ''}；agent 已回報停止，鎖已釋放` })
      return
    }
    const run = getRun(msg.runId)
    const frontReasons: string[] = []
    if (a.received !== msg.total) frontReasons.push(`前台事件應有 ${msg.total} 筆，只收到 ${a.received} 筆`)
    if (a.chunkSeqs.size !== msg.chunks) frontReasons.push(`前台分批應有 ${msg.chunks} 批，只收到 ${a.chunkSeqs.size} 批`)
    if (!msg.payoutObservable) frontReasons.push('前台看不到 moneyNtc（判斷不了每局派彩與結束時間）')
    if (!msg.exitOk) frontReasons.push('退出機台沒有確認成功，位子可能還佔著')
    const agentToServerMs = Date.now() - Number(msg.agentNow || Date.now())
    releaseRun(msg.runId)
    if (!run) return
    patchRun(msg.runId, {
      status: 'collecting', phase: 'backend', message: '查後台日誌中',
      front_started_at: msg.startedAt, front_finished_at: msg.finishedAt,
      summary: JSON.stringify({ front: { ok: msg.ok, cancelled: msg.cancelled, error: msg.error ? maskText(msg.error) : null, stopReason: msg.stopReason, spins: msg.spins, exitOk: msg.exitOk, payoutObservable: msg.payoutObservable, total: msg.total }, frontReasons, agentToServerMs, timedOut: a.timedOut }),
    })
    void finalizeRun(msg.runId).catch(e => {
      console.error('[api-capture] 彙整失敗', e)
      patchRun(msg.runId, { status: 'failed', phase: 'done', message: `彙整失敗：${e instanceof Error ? e.message : String(e)}`, finished_at: Date.now() })
      saveHistory(msg.runId)
    })
  }
}

export function handleApiCaptureAgentDisconnect(runId: string, reason: string) {
  if (!active.has(runId)) return
  failRun(runId, `Local Agent 斷線（${reason}），這筆紀錄中斷`)
}

// ─── 彙整 ──────────────────────────────────────────────────────────────────────

function loadFront(runId: string): FrontEvent[] {
  return (db.prepare('SELECT data FROM api_capture_events WHERE run_id = ? ORDER BY seq').all(runId) as { data: string }[]).map(r => JSON.parse(r.data) as FrontEvent)
}
function loadBackend(runId: string, onlyInWindow = true): BackendItem[] {
  const sql = `SELECT data FROM api_capture_backend WHERE run_id = ? ${onlyInWindow ? 'AND in_window = 1' : ''} ORDER BY reqtime, seq`
  return (db.prepare(sql).all(runId) as { data: string }[]).map(r => JSON.parse(r.data) as BackendItem)
}

async function finalizeRun(runId: string, deps: { fetchLogs?: typeof fetchBackendLogs } = {}) {
  const run = getRun(runId)
  if (!run) return
  const summary = JSON.parse(run.summary || '{}') as { front?: { ok: boolean; cancelled: boolean; spins: ApiCaptureDone['spins']; stopReason: string }; frontReasons?: string[]; agentToServerMs?: number; timedOut?: boolean }
  const front = loadFront(runId)
  const cfg = loadBackendConfig(run.env)
  const agentToServer = typeof summary.agentToServerMs === 'number' ? summary.agentToServerMs : 0
  const fs0 = (run.front_started_at ?? run.started_at) + agentToServer
  const fs1 = (run.front_finished_at ?? Date.now()) + agentToServer
  // 查寬一點（前 10 分、後 5 分），校正完再裁回前台時間窗
  const fetched = await (deps.fetchLogs ?? fetchBackendLogs)({ ...cfg, channelId: run.channel_id || cfg.channelId }, { userName: run.account, fromMs: fs0 - 10 * 60_000, toMs: fs1 + 5 * 60_000 })
  const spins = summary.front?.spins ?? []
  const rbs = fetched.items.filter(i => i.event === 'recordBet' && i.reqtime >= fs0 - 10 * 60_000).map(recordBetPoint)
  const cal: Calibration = calibrate(spins, rbs, typeof summary.agentToServerMs === 'number' ? summary.agentToServerMs : null)
  // 有 recordBet 校正（誤差 < 3 秒）時前緣只留 10 秒：開大廳的 authenticate 一定在前台開始之後，更早的是別次嘗試；
  // 只有伺服器時差時誤差不明，留 60 秒
  const padBefore = cal.method === 'recordBet' ? 10_000 : 60_000
  const win = splitByWindow(fetched.items, (run.front_started_at ?? run.started_at) + cal.offsetMs, (run.front_finished_at ?? Date.now()) + cal.offsetMs, padBefore)
  const ins = db.prepare('INSERT OR REPLACE INTO api_capture_backend (run_id, seq, source, event, reqtime, in_window, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
  db.transaction(() => {
    db.prepare('DELETE FROM api_capture_backend WHERE run_id = ?').run(runId)
    ;[...win.inside.map(i => [i, 1] as const), ...win.outside.map(i => [i, 0] as const)].forEach(([it, w], i) => ins.run(runId, i, it.source, it.event, it.reqtime, w, JSON.stringify(it)))
  })()
  const backendReasons = [...fetched.reasons]
  const spinsSeen = spins.length
  const rbInside = win.inside.filter(i => i.event === 'recordBet').length
  if (spinsSeen && rbInside < spinsSeen) backendReasons.push(`前台跑了 ${spinsSeen} 局，時間窗內只有 ${rbInside} 筆 recordBet`)
  const backendComplete = fetched.complete && !(spinsSeen && rbInside < spinsSeen)
  const frontReasons = summary.frontReasons ?? []
  const frontComplete = !!summary.front?.ok && frontReasons.length === 0
  const signature = buildSignature({ backend: win.inside, front })
  const baseline = findDefaultBaseline(run)
  const status: RunStatus = summary.timedOut ? 'failed' : summary.front?.cancelled ? 'cancelled' : !summary.front?.ok ? 'failed'
    : frontComplete && backendComplete && cal.method !== 'none' ? 'done' : 'incomplete'
  const completeness = {
    front: { complete: frontComplete, reasons: frontReasons },
    backend: { complete: backendComplete, reasons: backendReasons, inWindow: win.inside.length, outsideWindow: win.outside.length, pages: fetched.pages, totals: fetched.totals },
  }
  const frontErr = (summary.front as { error?: string } | undefined)?.error
  patchRun(runId, {
    status, phase: 'done', finished_at: Date.now(),
    message: summary.timedOut ? `超過 ${Math.round(RUN_TIMEOUT_MS / 60_000)} 分鐘沒有結束，已停止（錄到的內容保留）` : status === 'done' ? '彙整完成' : status === 'incomplete' ? `資料不完整：${[...frontReasons, ...backendReasons][0] ?? cal.note}` : status === 'cancelled' ? '已取消（已錄到的內容保留）' : `前台失敗：${frontErr ?? '未知原因'}`,
    time_calibration: JSON.stringify(cal), completeness: JSON.stringify(completeness),
    baseline_run_id: baseline?.id ?? null, signature: JSON.stringify(signature),
  })
  saveHistory(runId)
}

/** recordBet → 校時用的點（時間＋派彩，派彩拿來辨認是哪一局） */
function recordBetPoint(b: BackendItem): { reqtime: number; payout: number | null } {
  let payout: number | null = null
  try { const pd = JSON.parse(b.postData) as { payout?: unknown }; if (typeof pd.payout === 'number') payout = pd.payout } catch { /* 不是 JSON 就沒有 */ }
  return { reqtime: b.reqtime, payout }
}

/** 預設基準：同環境＋同渠道＋同帳號＋同機台、比這筆早、狀態 done 的最新一筆 */
function findDefaultBaseline(run: RunRow): RunRow | undefined {
  return db.prepare(`SELECT * FROM api_capture_runs WHERE env = ? AND channel_id = ? AND account = ? AND machine_key = ? AND status = 'done' AND started_at < ? AND id <> ? ORDER BY started_at DESC LIMIT 1`)
    .get(run.env, run.channel_id, run.account, run.machine_key, run.started_at, run.id) as RunRow | undefined
}

function saveHistory(runId: string) {
  const r = getRun(runId)
  if (!r) return
  const cal = r.time_calibration ? JSON.parse(r.time_calibration) as Calibration : null
  const comp = r.completeness ? JSON.parse(r.completeness) : null
  addHistory('api-capture', `API 參數紀錄：${ENV_LABEL[r.env]} ${r.account} 機台 ${r.machine}`, `${STATUS_LABEL[r.status]}｜${r.message ?? ''}`.slice(0, 200), {
    runId: r.id, env: r.env, channelId: r.channel_id, account: r.account, machine: r.machine, status: r.status,
    agent: r.agent_host, baselineRunId: r.baseline_run_id, calibration: cal, completeness: comp,
    startedAt: r.started_at, finishedAt: r.finished_at,
  }, { operator: { key: r.operator_key ?? '', name: r.operator_name ?? '' } })
}

const STATUS_LABEL: Record<RunStatus, string> = { running: '執行中', collecting: '查後台中', done: '完成', incomplete: '資料不完整', failed: '失敗', cancelled: '已取消' }

// ─── 路由 ──────────────────────────────────────────────────────────────────────

const LOBBY_HOST = /(^|\.)(osmslot\.org|osmplay\.com|osmplay-new\.com|cliveslot\.com)$/i

const startSchema = z.object({
  env: z.enum(['qat', 'uat']),
  lobbyUrl: z.string().url().max(4000),
  machine: z.string().trim().min(1).max(80),
  channelId: z.string().trim().max(20).optional().default(''),
  stopCondition: z.enum(['payout', 'spins']).default('payout'),
  spins: z.number().int().min(1).max(300).default(10),
  maxSpins: z.number().int().min(1).max(300).default(100),
  agentId: z.string().trim().optional().default(''),
  headed: z.boolean().optional().default(false),
})

function agentList(email: string) {
  return [...agentConnections.values()].filter(a => a.ownerKey === email).map(a => ({
    agentId: a.agentId, hostname: a.hostname, busy: a.busy, capable: a.capabilities.includes('api-capture'), updateStatus: agentUpdateStatus(a),
  }))
}

router.get('/api/api-capture/meta', (_req, res) => {
  const u = need(res); if (!u) return
  const configured = Object.fromEntries(ENVS.map(e => { const c = loadBackendConfig(e); return [e, { ready: !!(c.username && c.hasPassword), channelId: c.channelId, verified: BACKEND_DEFAULTS[e].verified }] }))
  res.json({ ok: true, isAdmin: u.isAdmin, configured, agents: agentList(u.email) })
})

router.get('/api/api-capture/settings', (_req, res) => {
  const u = need(res, true); if (!u) return
  res.json({ ok: true, settings: Object.fromEntries(ENVS.map(e => { const c = loadBackendConfig(e); return [e, { baseUrl: c.baseUrl, origin: c.origin, username: c.username, channelId: c.channelId, hasPassword: c.hasPassword, verified: BACKEND_DEFAULTS[e].verified }] })) })
})

const settingsSchema = z.object({
  env: z.enum(['qat', 'uat']),
  baseUrl: z.string().trim().url().max(300),
  origin: z.string().trim().url().max(300),
  username: z.string().trim().min(1).max(100),
  channelId: z.string().trim().regex(/^\d{1,10}$/),
  /** 空字串＝沿用原本的密碼 */
  password: z.string().max(200).optional().default(''),
})

router.put('/api/api-capture/settings', (req, res) => {
  const u = need(res, true); if (!u) return
  const b = settingsSchema.parse(req.body)
  if (!/^https?:\/\/[^/]*\.osmslot\.org(\/|$)/i.test(b.baseUrl)) return res.status(400).json({ ok: false, message: '後台 API 網址只接受 *.osmslot.org' })
  try {
    if (b.password) setSetting(`api_capture_backend_${b.env}_password`, encryptSecret(b.password))
  } catch (e) {
    return res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
  setSetting(`api_capture_backend_${b.env}`, JSON.stringify({ baseUrl: b.baseUrl, origin: b.origin, username: b.username, channelId: b.channelId }))
  addHistory('api-capture', `API 參數紀錄：更新 ${ENV_LABEL[b.env]} 後台設定`, `帳號 ${b.username}、渠道 ${b.channelId}${b.password ? '、更新密碼' : ''}`, { env: b.env, baseUrl: b.baseUrl, username: b.username, channelId: b.channelId, passwordChanged: !!b.password }, { operator: { key: u.email, name: u.label } })
  res.json({ ok: true })
})

router.post('/api/api-capture/start', (req, res) => {
  const u = need(res); if (!u) return
  const b = startSchema.parse(req.body)
  let url: URL
  try { url = new URL(b.lobbyUrl) } catch { return res.status(400).json({ ok: false, message: '大廳連結格式不對' }) }
  if (url.protocol !== 'https:' || !LOBBY_HOST.test(url.hostname)) return res.status(400).json({ ok: false, message: '大廳連結只接受 OSM 的 https 網址' })
  const account = (url.searchParams.get('username') || '').trim()
  if (!account) return res.status(400).json({ ok: false, message: '大廳連結裡沒有 username，無法對應後台帳號' })
  const cfg = loadBackendConfig(b.env)
  if (!cfg.username || !cfg.hasPassword) return res.status(409).json({ ok: false, message: `${ENV_LABEL[b.env]} 的後台帳密還沒設定，請管理員先到「後台設定」填寫` })
  const lockKeys = lockKeysFor(b.env, b.machine, account)
  for (const k of lockKeys) {
    const owner = lockOwners.get(k)
    if (owner) return res.status(409).json({ ok: false, message: k.includes('|machine|') ? `這台機台（${ENV_LABEL[b.env]}）正在被另一筆紀錄使用` : `帳號 ${account} 正在被另一筆紀錄使用`, runId: owner })
  }
  const agents = getAvailableAgents({ operatorKey: u.email, capability: 'api-capture', ...(b.agentId ? { agentId: b.agentId } : {}) })
  const agent = agents[0]
  if (!agent) {
    const mine = agentList(u.email)
    const message = !mine.length ? '沒有連線中的 Local Agent（請先在本機啟動 agent）'
      : !mine.some(a => a.capable) ? '你的 Local Agent 版本太舊、沒有「API 參數紀錄」能力：請到 Local Agent 頁按「更新程式碼」，再重開 agent'
        : '你的 Local Agent 都在忙，請等它跑完'
    return res.status(409).json({ ok: false, message })
  }
  const heavy = tryStartHeavyTask(req, 'api-capture', 'API 參數紀錄')
  if (!heavy.ok) return res.status(429).json(heavyTaskConflict((heavy as Extract<typeof heavy, { ok: false }>).task))

  const runId = `ac_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  bindHeavyTaskOwner(heavy.token, runId)
  db.prepare(`INSERT INTO api_capture_runs (id, env, channel_id, account, machine, machine_key, lobby_url_masked, stop_condition, spins, max_spins, agent_id, agent_host, task_id, status, phase, message, started_at, operator_key, operator_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'login', '派工給 Local Agent', ?, ?, ?)`)
    .run(runId, b.env, b.channelId || cfg.channelId, account, b.machine, machineKey(b.machine), maskUrl(b.lobbyUrl), b.stopCondition, b.spins, b.maxSpins, agent.agentId, agent.hostname, heavy.token.id, Date.now(), u.email, u.label)
  for (const k of lockKeys) lockOwners.set(k, runId)
  active.set(runId, {
    runId, agentId: agent.agentId, heavy: heavy.token, lockKeys, received: 0, chunkSeqs: new Set(), stopTimer: null, operatorKey: u.email,
    timedOut: false, quarantined: false,
    watchdog: setTimeout(() => onTimeout(runId), RUN_TIMEOUT_MS),
  })
  agent.busy = true
  agent.sessionId = runId
  const startMsg: ApiCaptureStartMessage = { type: 'api_capture_start', runId, url: b.lobbyUrl, machine: b.machine, stopCondition: b.stopCondition, spins: b.spins, maxSpins: b.maxSpins, headed: b.headed }
  agent.ws.send(JSON.stringify(startMsg))
  res.json({ ok: true, runId, agent: agent.hostname })
})

router.post('/api/api-capture/runs/:id/stop', (req, res) => {
  const u = need(res); if (!u) return
  const a = active.get(req.params.id)
  if (!a) return res.status(404).json({ ok: false, message: '這筆紀錄不在執行中' })
  if (a.operatorKey !== u.email && !u.isAdmin) return res.status(403).json({ ok: false, message: '只能停止自己開的紀錄' })
  if (a.quarantined) return res.status(409).json({ ok: false, message: '已經在等 agent 確認停止' })
  patchRun(a.runId, { message: '取消中：等 agent 退出機台' })
  // agent 沒回應：紀錄判失敗，但鎖先保留到 agent 回報或斷線（不能放給新任務撞上還在下注的舊 runner）
  requestStop(a)
  res.json({ ok: true })
})

function publicRun(r: RunRow) {
  return {
    id: r.id, env: r.env, channelId: r.channel_id, account: r.account, machine: r.machine, machineKey: r.machine_key,
    lobbyUrl: r.lobby_url_masked, stopCondition: r.stop_condition, spins: r.spins, maxSpins: r.max_spins,
    agentHost: r.agent_host, status: r.status, statusLabel: STATUS_LABEL[r.status], phase: r.phase, message: r.message,
    startedAt: r.started_at, finishedAt: r.finished_at, frontStartedAt: r.front_started_at, frontFinishedAt: r.front_finished_at,
    calibration: r.time_calibration ? JSON.parse(r.time_calibration) : null,
    completeness: r.completeness ? JSON.parse(r.completeness) : null,
    summary: r.summary ? JSON.parse(r.summary) : null,
    baselineRunId: r.baseline_run_id, operatorName: r.operator_name,
  }
}

router.get('/api/api-capture/runs', (req, res) => {
  const u = need(res); if (!u) return
  const q = z.object({ env: z.enum(['qat', 'uat']).optional(), account: z.string().optional(), machineKey: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query)
  const where: string[] = [], args: unknown[] = []
  if (q.env) { where.push('env = ?'); args.push(q.env) }
  if (q.account) { where.push('account = ?'); args.push(q.account) }
  if (q.machineKey) { where.push('machine_key = ?'); args.push(q.machineKey) }
  const rows = db.prepare(`SELECT * FROM api_capture_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`).all(...args as never[], q.limit) as RunRow[]
  res.json({ ok: true, runs: rows.map(publicRun) })
})

function runOffset(r: RunRow) {
  const cal = r.time_calibration ? JSON.parse(r.time_calibration) as Calibration : null
  return cal?.offsetMs ?? 0
}

router.get('/api/api-capture/runs/:id', (req, res) => {
  const u = need(res); if (!u) return
  const r = getRun(req.params.id)
  if (!r) return res.status(404).json({ ok: false, message: '找不到這筆紀錄' })
  const front = loadFront(r.id)
  const off = runOffset(r)
  const steps = front.filter((e): e is Extract<FrontEvent, { kind: 'step' }> => e.kind === 'step')
  const timeline = buildTimeline(steps, loadBackend(r.id), off)
  const WS_MAX = 3000
  const wsAll = front.filter(e => e.kind === 'ws' || (e.kind === 'console' && parsePinusConsole(e.text)))
  // 畫面只看前段（完整內容在 Excel），每格截短，避免一次回幾十 MB
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
  const ws = wsAll.slice(0, WS_MAX).map(e => e.kind === 'ws'
    ? { t: e.t + off, source: 'frame', dir: e.dir, route: '', text: cut(e.text, 600) }
    : { t: e.t + off, source: 'console', dir: (e as { text: string }).text.trim().startsWith('SEND') ? 'send' : 'recv', route: parsePinusConsole((e as { text: string }).text)?.route ?? '', text: cut((e as { text: string }).text, 600) })
  const httpAll = front.filter((e): e is Extract<FrontEvent, { kind: 'http' }> => e.kind === 'http')
  const http = httpAll.map(e => ({ t: e.t + off, method: e.method, url: cut(e.url, 600), status: e.status, req: cut(e.req, 600), res: cut(e.res, 600), noise: e.noise, comparable: httpComparable(e) }))
  res.json({
    ok: true, run: publicRun(r), timeline, ws, wsTotal: wsAll.length, wsTruncated: wsAll.length > WS_MAX, http,
    backendOutside: loadBackend(r.id, false).filter(b => !timeline.some(t => t.backendId === b.id)).map(b => ({ t: b.reqtime, event: b.event, source: b.source })),
  })
})

function compareFor(r: RunRow, baselineId: string | undefined, ignoreVolatile: boolean) {
  const base = baselineId === 'none' ? undefined : baselineId ? getRun(baselineId) : (r.baseline_run_id ? getRun(r.baseline_run_id) : findDefaultBaseline(r))
  const cur = r.signature ? JSON.parse(r.signature) as Signature : null
  const bs = base?.signature ? JSON.parse(base.signature) as Signature : null
  const diff = cur ? diffSignatures(cur, bs, { ignoreVolatile }) : null
  return { base, diff }
}

router.get('/api/api-capture/runs/:id/compare', (req, res) => {
  const u = need(res); if (!u) return
  const r = getRun(req.params.id)
  if (!r) return res.status(404).json({ ok: false, message: '找不到這筆紀錄' })
  const q = z.object({ baseline: z.string().optional(), ignoreVolatile: z.enum(['0', '1']).default('1') }).parse(req.query)
  const { base, diff } = compareFor(r, q.baseline, q.ignoreVolatile === '1')
  const candidates = (db.prepare(`SELECT * FROM api_capture_runs WHERE id <> ? AND signature IS NOT NULL ORDER BY started_at DESC LIMIT 100`).all(r.id) as RunRow[])
    .map(c => ({ id: c.id, env: c.env, account: c.account, machine: c.machine, status: c.status, startedAt: c.started_at, sameTarget: c.env === r.env && c.channel_id === r.channel_id && c.account === r.account && c.machine_key === r.machine_key }))
  res.json({ ok: true, baseline: base ? publicRun(base) : null, defaultBaselineId: r.baseline_run_id ?? findDefaultBaseline(r)?.id ?? null, diff, candidates })
})

router.get('/api/api-capture/runs/:id/excel', (req, res) => {
  const u = need(res); if (!u) return
  const r = getRun(req.params.id)
  if (!r) return res.status(404).json({ ok: false, message: '找不到這筆紀錄' })
  const q = z.object({ baseline: z.string().optional(), ignoreVolatile: z.enum(['0', '1']).default('1'), noise: z.enum(['0', '1']).default('0') }).parse(req.query)
  const front = loadFront(r.id)
  const off = runOffset(r)
  const cal = r.time_calibration ? JSON.parse(r.time_calibration) as Calibration : null
  const comp = r.completeness ? JSON.parse(r.completeness) as { front: { complete: boolean; reasons: string[] }; backend: { complete: boolean; reasons: string[]; inWindow: number; outsideWindow: number } } : null
  const steps = front.filter((e): e is Extract<FrontEvent, { kind: 'step' }> => e.kind === 'step')
  const { base, diff } = compareFor(r, q.baseline, q.ignoreVolatile === '1')
  const buf = buildExcel({
    title: `API 參數紀錄｜${ENV_LABEL[r.env]}｜帳號 ${r.account}（渠道 ${r.channel_id}）｜機台 ${r.machine}`,
    infoLines: [
      `紀錄編號：${r.id}；狀態：${STATUS_LABEL[r.status]}${r.message ? `（${r.message}）` : ''}`,
      `開始：${fmtTs(r.started_at)}；前台：${r.front_started_at ? fmtTs(r.front_started_at + off) : '—'} ～ ${r.front_finished_at ? fmtTs(r.front_finished_at + off) : '—'}（後台時鐘）`,
      `停止條件：${r.stop_condition === 'payout' ? '有派彩就停' : `跑 ${r.spins} 局`}（最多 ${r.max_spins} 局）；Local Agent：${r.agent_host ?? '—'}；操作者：${r.operator_name ?? '—'}`,
      `時間校正：${cal ? `${cal.method === 'recordBet' ? '已校正' : cal.method === 'server-clock' ? '只用伺服器時差（未以 recordBet 校正）' : '未校正'}；前台時間 +${(cal.offsetMs / 1000).toFixed(1)} 秒；${cal.note}` : '—'}`,
      `前台資料：${comp ? (comp.front.complete ? '完整' : `不完整：${comp.front.reasons.join('；')}`) : '—'}`,
      `後台資料：${comp ? `${comp.backend.complete ? '完整' : `不完整：${comp.backend.reasons.join('；')}`}（時間窗內 ${comp.backend.inWindow} 筆、窗外 ${comp.backend.outsideWindow} 筆未列入時間軸）` : '—'}`,
      '後台來源：OSM 後台 Log Third Http Req／Log Third Bet Req（API 回傳內容＝Show Details 的完整內容），依同帳號、同時段查詢。',
      `token／密碼一律遮成 ***；前台 HTTP ${q.noise === '1' ? '包含' : '已排除'} GA、xtrace 等第三方統計。`,
    ],
    timeline: buildTimeline(steps, loadBackend(r.id), off),
    front, offsetMs: off, includeNoise: q.noise === '1', diff,
    baselineLabel: base ? `${base.id}（${fmtTs(base.started_at)}，${ENV_LABEL[base.env]} ${base.account} 機台 ${base.machine}）` : '無基準',
  })
  const name = `API參數紀錄_${ENV_LABEL[r.env]}_${r.account}_${r.machine_key}_${fmtTs(r.started_at).slice(0, 10).replace(/-/g, '')}.xlsx`
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="api-capture.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.send(buf)
})

/** 測試用：不經過 agent／後台網路，直接灌入資料跑彙整（只在 NODE_ENV=test 或腳本裡呼叫） */
export const __test = { finalizeRun, findDefaultBaseline, getRun, active, lockOwners, releaseRun, handleApiCaptureAgentMessage }

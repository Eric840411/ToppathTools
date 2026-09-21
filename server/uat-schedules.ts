/**
 * server/uat-schedules.ts
 *
 * 錄製腳本的**每日排程**：到點自動把**一組**腳本依序跑完，結果照常回寫 Lark。
 *
 * ## 為什麼要有
 * regression 的價值在「每天都跑」，而不是「想到才跑」。原本要人記得來按，
 * 於是最常見的狀況是——上線前一天才發現三週沒跑過。
 *
 * ## 組合式
 * 一個排程帶**一串腳本**（有順序）＋**要在星期幾跑**。所以「平日早上九點跑冒煙那三支、
 * 週五晚上跑完整那一輪」這種安排，用兩個排程就寫得出來。
 *
 * ## 怎麼觸發
 * 排程器**不自己開瀏覽器**，而是打自己的 `/api/osm-uat/run`，跟人按下去走完全一樣的路徑
 * （同一套鎖、同一套判定、同一套回寫）。另開一條執行路徑的話，兩條遲早會漂，
 * 而「排程跑出來的結果跟手動跑不一樣」是最難查的那種問題。
 *
 * ⚠️ **一支跑完才跑下一支**：UAT 一次只能有一個執行中的 session（後端會擋），
 *    同時丟出去的話第二支會直接被 409 打回來，而排程只會留下一句「啟動失敗」。
 *
 * ## 🚨 權限：借用**擁有者自己的登入 session**
 * 後台帳密是綁帳號存的，所以排程必須以建立者的身分執行。這裡從 `auth_sessions`
 * 找他還沒過期的 session 來呼叫 API。
 * ⚠️ **他的 session 過期時排程就跑不動**——這是刻意的（不要讓工具握著一組永不過期的權限）。
 *    跑不動時會把原因寫進 `last_status`，畫面上看得到，不會安靜地什麼都沒發生。
 */
import type { Router } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { db, writeLimiter } from './shared.js'
import { getAuthAccount } from './auth-session.js'

db.exec(`CREATE TABLE IF NOT EXISTS uat_schedules (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  hhmm TEXT NOT NULL,
  site TEXT NOT NULL DEFAULT 'cp',
  agent_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL
)`)
/**
 * 後加的兩欄。
 * ⚠️ 用 try/catch 而不是先查 schema：`ALTER TABLE ... ADD COLUMN` 在欄位已存在時
 *    會丟錯，這是唯一會發生的錯，吞掉它比多寫一段 pragma 查詢清楚。
 */
for (const sql of [
  `ALTER TABLE uat_schedules ADD COLUMN script_ids TEXT`,
  `ALTER TABLE uat_schedules ADD COLUMN weekdays TEXT`,
]) { try { db.exec(sql) } catch { /* 欄位已存在 */ } }

type ScheduleRow = {
  id: string; script_id: string; script_ids: string | null; owner: string; hhmm: string; site: string
  agent_id: string; weekdays: string | null; enabled: number; last_run_at: number | null; last_status: string | null
}

const scheduleSchema = z.object({
  id: z.string().max(80).optional(),
  /** 要依序跑的腳本（至少一支）。⚠️ 順序就是執行順序 */
  scriptIds: z.array(z.string().min(1).max(80)).min(1, '至少要選一支腳本').max(20, '一個排程最多 20 支'),
  /** 每天幾點跑，24 小時制 `HH:MM`（伺服器所在時區） */
  hhmm: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間要是 HH:MM（24 小時制）'),
  /** 星期幾跑（0=日 … 6=六）。空陣列＝每天 */
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  site: z.enum(['cp', 'nc']).default('cp'),
  agentId: z.string().max(80).default(''),
  enabled: z.boolean().default(true),
})

/** 這一刻的 HH:MM（伺服器時區）。排程比的是這個字串，不做時區換算 */
function nowHHMM(at = new Date()) {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** 這一列要跑哪幾支（相容只存單支的舊資料） */
function scriptsOf(row: ScheduleRow): string[] {
  if (row.script_ids) {
    try {
      const list = JSON.parse(row.script_ids) as unknown
      if (Array.isArray(list) && list.length) return list.map(String)
    } catch { /* 壞掉就退回單支 */ }
  }
  return row.script_id ? [row.script_id] : []
}

function weekdaysOf(row: ScheduleRow): number[] {
  if (!row.weekdays) return []
  return row.weekdays.split(',').map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
}

/**
 * 找這個帳號還沒過期的 session。
 * ⚠️ 找不到**不是**沉默跳過——呼叫端會把原因寫進 last_status。
 */
function liveSessionFor(owner: string): string | null {
  const row = db.prepare(
    'SELECT sid FROM auth_sessions WHERE email = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
  ).get(owner, Date.now()) as { sid?: string } | undefined
  return row?.sid ?? null
}

const BASE = () => `http://127.0.0.1:${process.env.PORT ?? '3000'}`

/** 等目前這一輪跑完（UAT 一次只能一個 session）。回傳是否在時限內結束 */
async function waitUntilIdle(cookie: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 5000))
    try {
      const status = await (await fetch(`${BASE()}/api/osm-uat/status`, { headers: { cookie } })).json() as { status?: string }
      if (status.status !== 'running') return true
    } catch { /* 網路抖一下就再等一輪 */ }
  }
  return false
}

/**
 * 依序把這個排程的腳本跑完，回傳給人看的摘要。
 *
 * ⚠️ **中間有一支啟動失敗不會整組放棄**——後面那幾支照跑，摘要裡逐支寫結果。
 *    整組中止的話，一支暫時性的失敗會讓當天的 regression 全部沒跑，而且只有一句話可看。
 */
async function runSchedule(row: ScheduleRow): Promise<string> {
  const sid = liveSessionFor(row.owner)
  if (!sid) return `沒有有效登入 session（請 ${row.owner} 重新登入一次，排程才跑得動）`
  const cookie = `toppath_auth=${sid}`
  const ids = scriptsOf(row)
  if (!ids.length) return '這個排程沒有指定任何腳本'
  const results: string[] = []
  for (const [index, scriptId] of ids.entries()) {
    const label = `${index + 1}/${ids.length}`
    try {
      const response = await fetch(`${BASE()}/api/osm-uat/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ recordedScriptId: scriptId, site: row.site, agentId: row.agent_id || undefined, dryRun: false }),
      })
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; message?: string }
      if (!response.ok || data.ok === false) {
        results.push(`${label} 啟動失敗（${data.error ?? data.message ?? response.status}）`)
        continue
      }
      // 一支最多等 30 分鐘。等不到就往下一支——卡住的那支會自己逾時，
      // 而把整個排程掛在這裡等的話，後面幾支永遠不會跑。
      const finished = await waitUntilIdle(cookie, 30 * 60 * 1000)
      results.push(finished ? `${label} 已跑完` : `${label} 逾時（超過 30 分鐘仍在執行）`)
    } catch (error) {
      results.push(`${label} 啟動失敗（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return results.join('；')
}

/**
 * 每分鐘檢查一次。
 *
 * ⚠️ **同一天只跑一次**：ticker 每分鐘醒來，不擋的話同一分鐘內會連續觸發好幾次
 *    （尤其是啟動失敗時的情況）。這裡用「上次執行距今超過 23 小時」當門檻。
 * ⚠️ 一整組跑起來可能要幾十分鐘，期間 ticker 還會醒來——所以**先寫 last_run_at 再開跑**，
 *    否則同一個排程會被重複觸發，而第二次只會拿到 409。
 */
export function startScheduleTicker() {
  const running = new Set<string>()
  const tick = async () => {
    const now = new Date()
    const hhmm = nowHHMM(now)
    const rows = db.prepare('SELECT * FROM uat_schedules WHERE enabled = 1 AND hhmm = ?').all(hhmm) as ScheduleRow[]
    for (const row of rows) {
      if (running.has(row.id)) continue
      if (row.last_run_at && Date.now() - row.last_run_at < 23 * 60 * 60 * 1000) continue
      const days = weekdaysOf(row)
      if (days.length && !days.includes(now.getDay())) continue
      running.add(row.id)
      db.prepare('UPDATE uat_schedules SET last_run_at = ?, last_status = ? WHERE id = ?').run(Date.now(), '執行中…', row.id)
      void runSchedule(row)
        .then(status => {
          db.prepare('UPDATE uat_schedules SET last_status = ? WHERE id = ?').run(status, row.id)
          console.log(`[uat-schedule] ${row.id} @${row.hhmm} → ${status}`)
        })
        .finally(() => running.delete(row.id))
    }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function registerUatScheduleRoutes(router: Router) {
  router.get('/api/osm-uat/schedules', (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const rows = db.prepare('SELECT * FROM uat_schedules ORDER BY hhmm').all() as ScheduleRow[]
    res.json({
      ok: true,
      schedules: rows.map(row => ({
        id: row.id, scriptIds: scriptsOf(row), owner: row.owner, hhmm: row.hhmm, site: row.site,
        agentId: row.agent_id, weekdays: weekdaysOf(row), enabled: row.enabled === 1,
        lastRunAt: row.last_run_at, lastStatus: row.last_status,
        // 別人建的排程可以看見但不能改——看不見的話會出現「我沒排啊怎麼自己跑了」
        mine: row.owner === account.email,
      })),
    })
  })

  router.put('/api/osm-uat/schedules', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const parsed = scheduleSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ ok: false, message: parsed.error.issues.map(i => i.message).join('；') })
    const value = parsed.data
    // ⚠️ 逐支確認腳本存在。少檢查的話，排程會在半夜安靜地留下一句「找不到腳本」
    const missing = value.scriptIds.filter(id => !db.prepare('SELECT id FROM uat_recorded_scripts WHERE id = ?').get(id))
    if (missing.length) return res.status(404).json({ ok: false, message: `有 ${missing.length} 支腳本找不到（可能已被刪除）` })
    const ids = JSON.stringify(value.scriptIds)
    const days = value.weekdays.join(',')
    if (value.id) {
      const owner = (db.prepare('SELECT owner FROM uat_schedules WHERE id = ?').get(value.id) as { owner?: string } | undefined)?.owner
      if (!owner) return res.status(404).json({ ok: false, message: '找不到這個排程' })
      if (owner !== account.email) return res.status(403).json({ ok: false, message: '只有建立者可以改這個排程' })
      db.prepare('UPDATE uat_schedules SET script_id = ?, script_ids = ?, hhmm = ?, weekdays = ?, site = ?, agent_id = ?, enabled = ? WHERE id = ?')
        .run(value.scriptIds[0], ids, value.hhmm, days, value.site, value.agentId, value.enabled ? 1 : 0, value.id)
      return res.json({ ok: true, id: value.id })
    }
    const id = randomUUID()
    db.prepare('INSERT INTO uat_schedules(id, script_id, script_ids, owner, hhmm, weekdays, site, agent_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, value.scriptIds[0], ids, account.email, value.hhmm, days, value.site, value.agentId, value.enabled ? 1 : 0, Date.now())
    res.json({ ok: true, id })
  })

  router.delete('/api/osm-uat/schedules/:id', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const owner = (db.prepare('SELECT owner FROM uat_schedules WHERE id = ?').get(req.params.id) as { owner?: string } | undefined)?.owner
    if (!owner) return res.status(404).json({ ok: false, message: '找不到這個排程' })
    if (owner !== account.email) return res.status(403).json({ ok: false, message: '只有建立者可以刪這個排程' })
    db.prepare('DELETE FROM uat_schedules WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  })
}

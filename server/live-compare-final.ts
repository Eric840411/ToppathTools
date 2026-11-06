/**
 * AutoSpin 停止後的即時對照：結算 → 凍結 → 發「後台對照總表」到 Lark 群（v5.81.0，同事 1106 需求、CodeX 1106 審過設計）。
 *
 * 狀態落庫（live_compare_run），worker 重啟後接著跑：
 *   running → （session 不再 running）settling → final／timeout，凍結 rowsJson 並排入通知（同一個 transaction）
 * 通知獨立一個狀態：pending → sent／failed；失敗退避重送，Lark 建訊息帶 uuid 去重，發過就不會再發。
 *
 * 判定（何時算收斂、總計怎麼算、卡片長怎樣）都在 live-compare-final-core.ts。
 */
import { db } from './shared.js'
import { liveCompareLocked, type LiveCompareRow } from './live-compare.js'
import { sendLarkCard } from './lark-notify.js'
import { decideSettle, summarizeMachine, buildFinalReportCard, type RunState } from './live-compare-final-core.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS live_compare_run (
    sessionId    TEXT PRIMARY KEY,
    env          TEXT NOT NULL,
    userLabel    TEXT NOT NULL DEFAULT '',
    startedAt    INTEGER NOT NULL,
    state        TEXT NOT NULL DEFAULT 'running',
    stoppedAt    INTEGER,
    spinCount    INTEGER NOT NULL DEFAULT 0,
    lastGrowthAt INTEGER,
    targetUp     INTEGER,
    reason       TEXT NOT NULL DEFAULT '',
    rowsJson     TEXT,
    rowsAt       INTEGER,
    finalizedAt  INTEGER,
    chatId       TEXT,
    notifyState  TEXT NOT NULL DEFAULT 'none',
    notifyAttempts INTEGER NOT NULL DEFAULT 0,
    notifyNextAt INTEGER,
    notifyMessageId TEXT,
    notifyError  TEXT
  )
`)

/** 停止總表要發到哪個群（管理員在 Lark 通知設定頁設定；空＝不發） */
export const FINAL_REPORT_CHAT_KEY = 'autospin_final_report_chat_id'
export const finalReportChatId = (): string =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(FINAL_REPORT_CHAT_KEY) as { value?: string } | undefined)?.value ?? ''
export function setFinalReportChatId(chatId: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FINAL_REPORT_CHAT_KEY, chatId)
}
const NOTIFY_MAX_ATTEMPTS = 5

export interface RunRow {
  sessionId: string; env: string; userLabel: string; startedAt: number; state: RunState
  stoppedAt: number | null; spinCount: number; lastGrowthAt: number | null; targetUp: number | null; reason: string
  rowsJson: string | null; rowsAt: number | null; finalizedAt: number | null
  chatId: string | null; notifyState: string; notifyAttempts: number; notifyNextAt: number | null; notifyMessageId: string | null; notifyError: string | null
}

export interface LiveSessionInfo { id: string; startedAt: number; userLabel: string; running: boolean }

/** 頁面輪詢正在跑的 session 之後呼叫：記下這一輪、存最近一次結果（停止後頁面要顯示） */
export function noteRunningRows(env: string, sessions: LiveSessionInfo[], rows: LiveCompareRow[], now = Date.now()) {
  const up = db.prepare(`
    INSERT INTO live_compare_run (sessionId, env, userLabel, startedAt, state, rowsJson, rowsAt)
    VALUES (?, ?, ?, ?, 'running', ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET rowsJson=excluded.rowsJson, rowsAt=excluded.rowsAt
      WHERE live_compare_run.state = 'running'
  `)
  for (const s of sessions) {
    up.run(s.id, env, s.userLabel, s.startedAt, JSON.stringify(rows.filter(r => r.sessionId === s.id)), now)
  }
}

/** 頁面沒有在跑的 session 時，顯示這個帳號最近一輪（預設 24 小時內）的結果 */
export function latestRunFor(env: string, userLabel: string, withinMs = 24 * 3600_000, now = Date.now()): RunRow | null {
  return (db.prepare(`
    SELECT * FROM live_compare_run WHERE env=? AND userLabel=? AND startedAt > ? AND rowsJson IS NOT NULL
    ORDER BY startedAt DESC LIMIT 1
  `).get(env, userLabel, now - withinMs) as RunRow | undefined) ?? null
}

function spinStats(env: string, sessionId: string): { count: number; lastAt: number | null } {
  const r = db.prepare('SELECT COUNT(*) c, MAX(observedAt) t FROM recon_spin WHERE env=? AND sessionId=?').get(env, sessionId) as { c: number; t: number | null }
  return { count: r.c, lastAt: r.t }
}

let ticking = false

/**
 * 背景每分鐘跑一次。getSessions：目前所有 AutoSpin session（含已停止的）。
 * ① 正在跑、但頁面 50 秒內沒輪詢過的 → 背景比對一次（沒開頁面也要有資料可以結算）
 * ② 記錄上是 running、session 已不在跑 → 進結算
 * ③ 結算中的 → 再比一次、判斷收斂；收斂或逾時就凍結＋排通知
 * ④ 送待發的通知
 */
export async function tickLiveCompareFinal(getSessions: () => LiveSessionInfo[], now = Date.now()) {
  if (ticking) return
  ticking = true
  try {
    const sessions = getSessions()
    const byId = new Map(sessions.map(s => [s.id, s]))

    // ①
    const stale = sessions.filter(s => s.running).filter(s => {
      const r = db.prepare('SELECT rowsAt FROM live_compare_run WHERE sessionId=?').get(s.id) as { rowsAt: number | null } | undefined
      return !r?.rowsAt || now - r.rowsAt > 50_000
    })
    if (stale.length) {
      const res = await liveCompareLocked('qat', stale.map(s => ({ id: s.id, startedAt: s.startedAt })))
      noteRunningRows('qat', stale, res.rows, Date.now())
    }

    // ②
    const running = db.prepare("SELECT sessionId FROM live_compare_run WHERE state='running'").all() as { sessionId: string }[]
    for (const r of running) {
      if (byId.get(r.sessionId)?.running) continue
      db.prepare("UPDATE live_compare_run SET state='settling', stoppedAt=? WHERE sessionId=? AND state='running'").run(now, r.sessionId)
    }

    // ③
    const settling = db.prepare("SELECT * FROM live_compare_run WHERE state='settling'").all() as RunRow[]
    for (const run of settling) {
      const t = Date.now()
      const sp = spinStats(run.env, run.sessionId)
      const lastGrowthAt = sp.count !== run.spinCount ? t : (run.lastGrowthAt ?? run.stoppedAt)
      const res = await liveCompareLocked('qat', [{ id: run.sessionId, startedAt: run.startedAt }])
      const rows = res.rows
      const d = decideSettle({ stopped: true, stoppedAt: run.stoppedAt, lastSpinAt: sp.lastAt, lastGrowthAt, now: Date.now(), rows })
      const freeze = d.state === 'final' || d.state === 'timeout'
      const chatId = freeze ? finalReportChatId() : null
      // ⚠️ 凍結結果與排通知要同一個 transaction：只寫了一半的話，重啟後不是重發就是永遠不發
      db.transaction(() => {
        db.prepare(`
          UPDATE live_compare_run SET spinCount=?, lastGrowthAt=?, targetUp=?, reason=?, rowsJson=?, rowsAt=?, state=?,
            finalizedAt=?, chatId=COALESCE(?, chatId), notifyState=CASE WHEN ? THEN ? ELSE notifyState END
          WHERE sessionId=? AND state='settling'
        `).run(sp.count, lastGrowthAt, d.targetUp, d.reason, JSON.stringify(rows), Date.now(), d.state,
          freeze ? Date.now() : null, chatId, freeze ? 1 : 0, chatId ? 'pending' : 'skipped', run.sessionId)
      })()
    }

    // ④
    await sendPendingReports(Date.now())
  } catch (e) {
    console.error('[live-compare-final] 背景結算失敗：', e)
  } finally {
    ticking = false
  }
}

export function cardForRun(run: RunRow): object {
  const rows = JSON.parse(run.rowsJson || '[]') as LiveCompareRow[]
  return buildFinalReportCard({
    userLabel: run.userLabel,
    startedAt: run.startedAt,
    stoppedAt: run.stoppedAt ?? run.finalizedAt ?? Date.now(),
    state: run.state === 'timeout' ? 'timeout' : 'final',
    reason: run.reason,
    machines: rows.map(r => summarizeMachine(r, run.targetUp)),
  })
}

async function sendPendingReports(now: number) {
  const due = db.prepare("SELECT * FROM live_compare_run WHERE notifyState='pending' AND (notifyNextAt IS NULL OR notifyNextAt <= ?)").all(now) as RunRow[]
  for (const run of due) {
    // uuid：Lark 對同一個 uuid 一小時內只建一則，重送不會變兩張
    const r = await sendLarkCard(run.chatId || '', cardForRun(run), { uuid: `lcfinal-${run.sessionId}`.slice(0, 50) })
    if (r.ok) {
      db.prepare("UPDATE live_compare_run SET notifyState='sent', notifyMessageId=?, notifyError=NULL WHERE sessionId=?").run(r.value, run.sessionId)
    } else {
      const attempts = run.notifyAttempts + 1
      const done = attempts >= NOTIFY_MAX_ATTEMPTS
      db.prepare('UPDATE live_compare_run SET notifyState=?, notifyAttempts=?, notifyNextAt=?, notifyError=? WHERE sessionId=?')
        .run(done ? 'failed' : 'pending', attempts, now + 60_000 * 2 ** attempts, `${r.code} ${r.message}`.slice(0, 300), run.sessionId)
      console.error(`[live-compare-final] 總表發送失敗（第 ${attempts} 次）${run.sessionId}：${r.code} ${r.message}`)
    }
  }
}

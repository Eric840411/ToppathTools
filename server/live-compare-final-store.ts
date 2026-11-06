/**
 * AutoSpin 停止後的即時對照：結算 → 凍結 → 發「後台對照總表」到 Lark 群（v5.81.0，同事 1106 需求、CodeX 1106 審過設計）。
 *
 * 狀態落庫（live_compare_run），worker 重啟後接著跑：
 *   running → （session 不再 running）settling → final／timeout，凍結 rowsJson 並排入通知（同一個 transaction）
 * 通知獨立一個狀態：pending → sent／failed；失敗退避重送，Lark 建訊息帶 uuid 去重，發過就不會再發。
 *
 * 這裡只吃傳進來的 db／比對／發送／時鐘，方便用記憶體 DB 測（live-compare-final-store.test.ts）；
 * 接正式 DB 與網路的是 live-compare-final.ts。判定（何時算收斂、總計、卡片）在 live-compare-final-core.ts。
 */
import type Database from 'better-sqlite3'
import type { LiveCompareRow, LiveSessionRef } from './live-compare.js'
import { decideSettle, summarizeMachine, buildFinalReportCard, targetFromSnaps, targetWithEvidence, evidenceCount, ownUntil, TAIL_QUIET_MS, SETTLE_MAX_MS, type RunState } from './live-compare-final-core.js'

export const FINAL_REPORT_CHAT_KEY = 'autospin_final_report_chat_id'
const NOTIFY_MAX_ATTEMPTS = 5
/** 已停止、但沒被登記過的 session，停止多久內還要補結算（短 session：開始後在第一次背景掃描前就停了） */
const LATE_REGISTER_MS = 30 * 60_000
/** 頁面多久內輪詢過就不用背景再比一次 */
const PAGE_FRESH_MS = 50_000

export interface RunRow {
  sessionId: string; env: string; userLabel: string; startedAt: number; state: RunState
  stoppedAt: number | null; spinCount: number; lastGrowthAt: number | null; targetUp: number | null; targetsJson: string | null; evidenceJson: string | null; reason: string
  rowsJson: string | null; rowsAt: number | null; finalizedAt: number | null
  chatId: string | null; notifyState: string; notifyAttempts: number; notifyNextAt: number | null; notifyMessageId: string | null; notifyError: string | null
}

export interface LiveSessionInfo {
  id: string; startedAt: number; userLabel: string; running: boolean
  /** 已停止的 session 最後一次心跳（伺服器時鐘）；拿來判斷是不是剛停的 */
  lastHeartbeat?: number
}

export interface FinalDeps {
  compare: (env: 'qat', sessions: LiveSessionRef[], opts?: { withEvidence?: boolean; untilMs?: number; untilExclusive?: boolean; ownNote?: string }) => Promise<{ rows: LiveCompareRow[] }>
  send: (chatId: string, card: object, opts: { uuid?: string }) => Promise<{ ok: true; value: string } | { ok: false; code: string; message: string }>
  now: () => number
}

export function ensureRunTable(db: Database.Database) {
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
      notifyError  TEXT,
      targetsJson  TEXT,
      evidenceJson TEXT
    )
  `)
  // v5.81.0 開發中建出來的本機表沒有這兩欄
  for (const col of ['targetsJson', 'evidenceJson']) {
    try { db.exec(`ALTER TABLE live_compare_run ADD COLUMN ${col} TEXT`) } catch { /* 已有 */ }
  }
}

export function createFinalizer(db: Database.Database, deps: FinalDeps) {
  const finalReportChatId = (): string =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(FINAL_REPORT_CHAT_KEY) as { value?: string } | undefined)?.value ?? ''
  const setFinalReportChatId = (chatId: string) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FINAL_REPORT_CHAT_KEY, chatId)
  }

  /** 頁面輪詢正在跑的 session 之後呼叫：記下這一輪、存最近一次結果（停止後頁面要顯示） */
  function noteRunningRows(env: string, sessions: LiveSessionInfo[], rows: LiveCompareRow[], now = deps.now()) {
    const up = db.prepare(`
      INSERT INTO live_compare_run (sessionId, env, userLabel, startedAt, state, rowsJson, rowsAt)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET rowsJson=excluded.rowsJson, rowsAt=excluded.rowsAt
        WHERE live_compare_run.state = 'running'
    `)
    for (const s of sessions) up.run(s.id, env, s.userLabel, s.startedAt, JSON.stringify(rows.filter(r => r.sessionId === s.id)), now)
  }

  /** 頁面沒有在跑的 session 時，顯示這個帳號最近一輪（預設 24 小時內）的結果 */
  function latestRunFor(env: string, userLabel: string, withinMs = 24 * 3600_000, now = deps.now()): RunRow | null {
    return (db.prepare(`
      SELECT * FROM live_compare_run WHERE env=? AND userLabel=? AND startedAt > ? AND rowsJson IS NOT NULL
      ORDER BY startedAt DESC LIMIT 1
    `).get(env, userLabel, now - withinMs) as RunRow | undefined) ?? null
  }

  function spinStats(env: string, sessionId: string): { count: number } {
    const r = db.prepare('SELECT COUNT(*) c FROM recon_spin WHERE env=? AND sessionId=?').get(env, sessionId) as { c: number }
    return { count: r.c }
  }

  function cardForRun(run: RunRow): object {
    const rows = JSON.parse(run.rowsJson || '[]') as LiveCompareRow[]
    const targets = JSON.parse(run.targetsJson || '{}') as Record<string, number | null>
    return buildFinalReportCard({
      userLabel: run.userLabel,
      startedAt: run.startedAt,
      stoppedAt: run.stoppedAt ?? run.finalizedAt ?? deps.now(),
      state: run.state === 'timeout' ? 'timeout' : 'final',
      reason: run.reason,
      machines: rows.map(r => summarizeMachine(r, targets[r.gmid] ?? null)),
    })
  }

  async function sendPendingReports() {
    const now = deps.now()
    const due = db.prepare("SELECT * FROM live_compare_run WHERE notifyState='pending' AND (notifyNextAt IS NULL OR notifyNextAt <= ?)").all(now) as RunRow[]
    for (const run of due) {
      // uuid：Lark 對同一個 uuid 一小時內只建一則，重送不會變兩張
      const r = await deps.send(run.chatId || '', cardForRun(run), { uuid: `lcfinal-${run.sessionId}`.slice(0, 50) })
      if ('value' in r) {
        db.prepare("UPDATE live_compare_run SET notifyState='sent', notifyMessageId=?, notifyError=NULL WHERE sessionId=?").run(r.value, run.sessionId)
      } else {
        const e = r as { code: string; message: string }
        const attempts = run.notifyAttempts + 1
        const done = attempts >= NOTIFY_MAX_ATTEMPTS
        db.prepare('UPDATE live_compare_run SET notifyState=?, notifyAttempts=?, notifyNextAt=?, notifyError=? WHERE sessionId=?')
          .run(done ? 'failed' : 'pending', attempts, now + 60_000 * 2 ** attempts, `${e.code} ${e.message}`.slice(0, 300), run.sessionId)
        console.error(`[live-compare-final] 總表發送失敗（第 ${attempts} 次）${run.sessionId}：${e.code} ${e.message}`)
      }
    }
  }

  let ticking = false

  /**
   * 背景每分鐘跑一次。getSessions：目前所有 AutoSpin session（含已停止的）。
   * ⓪ 登記正在跑的、或剛停止但沒被登記過的
   * ① 正在跑、但頁面 50 秒內沒輪詢過的 → 背景比對一次（沒開頁面也要有資料可以結算）
   * ② 記錄上是 running、session 已不在跑 → 進結算
   * ③ 結算中的 → 再比一次、判斷收斂；收斂或逾時就凍結＋排通知
   * ④ 送待發的通知
   */
  async function tick(getSessions: () => LiveSessionInfo[]) {
    if (ticking) return
    ticking = true
    try {
      const now = deps.now()
      const sessions = getSessions()
      const byId = new Map(sessions.map(s => [s.id, s]))

      // ⓪ 沒開頁面、在第一次掃描前就停了的短 session 也要結算（CodeX aa55b01 P1）
      const has = db.prepare('SELECT 1 FROM live_compare_run WHERE sessionId=?')
      const ins = db.prepare(`INSERT OR IGNORE INTO live_compare_run (sessionId, env, userLabel, startedAt, state, stoppedAt) VALUES (?, 'qat', ?, ?, ?, ?)`)
      for (const s of sessions) {
        if (has.get(s.id)) continue
        if (s.running) ins.run(s.id, s.userLabel, s.startedAt, 'running', null)
        else if (s.lastHeartbeat && now - s.lastHeartbeat <= LATE_REGISTER_MS) ins.run(s.id, s.userLabel, s.startedAt, 'settling', now)
      }

      // ①
      const stale = sessions.filter(s => s.running).filter(s => {
        const r = db.prepare('SELECT rowsAt FROM live_compare_run WHERE sessionId=?').get(s.id) as { rowsAt: number | null } | undefined
        return !r?.rowsAt || now - r.rowsAt > PAGE_FRESH_MS
      })
      if (stale.length) {
        const res = await deps.compare('qat', stale.map(s => ({ id: s.id, startedAt: s.startedAt })))
        noteRunningRows('qat', stale, res.rows, deps.now())
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
        const t = deps.now()
        const sp = spinStats(run.env, run.sessionId)
        let lastGrowthAt = sp.count !== run.spinCount ? t : (run.lastGrowthAt ?? run.stoppedAt)
        // 先比一次（這一次會記下一筆 Meter 快照），再用「尾筆收妥之後讀到的快照」定每台終點
        // 本帳號局數的範圍：開跑～min(停止＋1 分鐘, 同帳號下一輪開始)（CodeX b7f907e／431cd7c P1：下一輪不能混進來）。
        // 停止時間用這一輪最後一次心跳（伺服器時鐘），沒有就用發現停止的時間
        const info = byId.get(run.sessionId)
        const stopAt = info && !info.running && info.lastHeartbeat ? info.lastHeartbeat : (run.stoppedAt ?? t)
        const nexts = sessions.filter(x => x.id !== run.sessionId && x.userLabel === run.userLabel && x.startedAt > run.startedAt).map(x => x.startedAt)
        const ou = ownUntil(stopAt, nexts.length ? Math.min(...nexts) : null)
        const res = await deps.compare('qat', [{ id: run.sessionId, startedAt: run.startedAt }], { withEvidence: true, untilMs: ou.untilMs, untilExclusive: ou.cutByNext, ownNote: ou.note || undefined })
        const rows = res.rows
        // ⚠️ 比對要等網路，期間可能又進來新局：比完再數一次，變了就重算靜默期、這輪不定案（CodeX 7a44528 P1）。
        //    但超過結算上限就不能再等——照新筆數往下走，decideSettle 會給 timeout（CodeX 862a4fa P2：不能一直繞過 15 分鐘）
        const late = run.stoppedAt != null && deps.now() > run.stoppedAt + SETTLE_MAX_MS
        const after = spinStats(run.env, run.sessionId).count
        if (after !== sp.count) {
          if (!late) {
            db.prepare("UPDATE live_compare_run SET spinCount=?, lastGrowthAt=?, rowsJson=?, rowsAt=?, reason=? WHERE sessionId=? AND state='settling'")
              .run(after, deps.now(), JSON.stringify(rows), deps.now(), '等最後幾局寫完', run.sessionId)
            continue
          }
          sp.count = after
          lastGrowthAt = deps.now()
        }
        const quietFrom = (lastGrowthAt ?? run.stoppedAt ?? t) + TAIL_QUIET_MS
        const prevEv = JSON.parse(run.evidenceJson || '{}') as Record<string, number>
        const evidence: Record<string, number> = {}
        const targets: Record<string, number | null> = {}
        const whys: string[] = []
        for (const r of rows) {
          const snaps = db.prepare('SELECT upTime, readAt FROM live_compare_snap WHERE sessionId=? AND gmid=?').all(run.sessionId, r.gmid) as Array<{ upTime: number; readAt: number }>
          const ec = evidenceCount(r.own)
          if (ec != null) evidence[r.gmid] = ec
          const tw = targetWithEvidence({ snapTarget: targetFromSnaps(snaps, quietFrom), own: r.own, prevGrCount: prevEv[r.gmid] ?? null, now: deps.now(), quietFrom })
          targets[r.gmid] = tw.target
          if (tw.why) whys.push(`${r.clientMachineName || r.gmid}：${tw.why}`)
        }
        const d = decideSettle({ stopped: true, stoppedAt: run.stoppedAt, spinCount: sp.count, lastGrowthAt, now: deps.now(), rows, targets })
        const reason = d.state === 'timeout' && whys.length ? `${d.reason}（${whys.join('；')}）` : d.reason
        const freeze = d.state === 'final' || d.state === 'timeout'
        // 沒有機台可比（沒 spin、不是 QAT…）就不發總表
        const chatId = freeze ? (rows.length ? finalReportChatId() : '') : null
        // ⚠️ 凍結結果與排通知要同一個 transaction：只寫了一半的話，重啟後不是重發就是永遠不發。
        //    交易裡再數一次 spin，有變就不凍結（下一輪重來）
        db.transaction(() => {
          if (freeze && !late && spinStats(run.env, run.sessionId).count !== sp.count) return
          db.prepare(`
            UPDATE live_compare_run SET spinCount=?, lastGrowthAt=?, targetsJson=?, evidenceJson=?, reason=?, rowsJson=?, rowsAt=?, state=?,
              finalizedAt=?, chatId=COALESCE(?, chatId), notifyState=CASE WHEN ? THEN ? ELSE notifyState END
            WHERE sessionId=? AND state='settling'
          `).run(sp.count, lastGrowthAt, JSON.stringify(targets), JSON.stringify(evidence), reason, JSON.stringify(rows), deps.now(), d.state,
            freeze ? deps.now() : null, chatId, freeze ? 1 : 0, chatId ? 'pending' : 'skipped', run.sessionId)
        })()
      }

      // ④
      await sendPendingReports()
    } catch (e) {
      console.error('[live-compare-final] 背景結算失敗：', e)
    } finally {
      ticking = false
    }
  }

  return { finalReportChatId, setFinalReportChatId, noteRunningRows, latestRunFor, cardForRun, tick }
}

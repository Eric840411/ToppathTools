/**
 * Meter 固定窗口的狀態存取（快照表、窗口表）與每輪評估。從 live-compare.ts 抽出來，
 * 讓 db／後台查詢／現在時間都能注入，用記憶體 DB 模擬多輪輪詢測（live-compare-window-store.test.ts）。
 */
import type Database from 'better-sqlite3'
import type { Baseline, MeterReading } from './live-compare-core.js'
import { evaluateWindow, pickEvalSnapshot, chooseWindow, nextState, isSplitTiming, SPLIT_HANDPAY_GUARD_MS, type BackendRound, type Snapshot, type WindowState, type WindowResult } from './live-compare-window.js'

export type BackendFetcher = (clientMachineName: string, gmid: string, fromMs: number, toMs: number) => Promise<{ gr: BackendRound[]; handpay: BackendRound[] } | { error: string }>

/** 窗口＝(tStart, t1]，對上後下一個窗口從 t1 接續（v5.79.0，CodeX 1105 方案 B）。 */
export function ensureWindowTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_compare_snap (
      sessionId TEXT NOT NULL, gmid TEXT NOT NULL, upTime INTEGER NOT NULL,
      gamesPlayed REAL NOT NULL, coinIn REAL NOT NULL, denom REAL NOT NULL, readAt INTEGER NOT NULL,
      PRIMARY KEY (sessionId, gmid, upTime)
    );
    CREATE TABLE IF NOT EXISTS live_compare_win (
      sessionId TEXT NOT NULL, gmid TEXT NOT NULL,
      tStart INTEGER NOT NULL, gpStart REAL NOT NULL, coinStart REAL NOT NULL,
      t1 INTEGER, fails INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      okCount INTEGER NOT NULL DEFAULT 0, okAmount REAL NOT NULL DEFAULT 0, checkedAt INTEGER, lastJson TEXT,
      PRIMARY KEY (sessionId, gmid)
    )
  `)
  // v5.81.11：連續切點待確認次數（跨窗口累計），舊表補欄位
  const cols = db.prepare('PRAGMA table_info(live_compare_win)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'streak')) db.exec('ALTER TABLE live_compare_win ADD COLUMN streak INTEGER NOT NULL DEFAULT 0')
  if (!cols.some(c => c.name === 'streakT1')) {
    db.exec('ALTER TABLE live_compare_win ADD COLUMN streakT1 INTEGER')
    // 升級當下還停在切點待確認的窗口，目前這個 t1 已經算過了——不回填的話重查同一個快照會再加一次（CodeX b7b02e3 P2）
    db.exec("UPDATE live_compare_win SET streakT1 = t1 WHERE status = 'boundary' AND streak > 0 AND t1 IS NOT NULL")
  }
}

export interface WinView {
  tStart: number
  t1: number | null
  status: WindowState['status']
  fails: number
  /** 連續切點待確認次數（跨窗口累計，對上歸零）；到 BOUNDARY_MAX_STREAK 就算逾期待查 */
  streak: number
  meter: { count: number; amount: number } | null
  backend: WindowResult['backend'] | null
  boundary: boolean
  /** 起點上進行中、算進這一段的局數 */
  t0Absorbed: number
  /** 第一個窗口：起點同一秒內下注、Meter 起點快照已算的局數 */
  t0SameSecond: number
  conflicts: number
  /** split＝這台局數按派彩時間、金額按下注時間切 */
  timing: 'bet' | 'split'
  /** 最新收到的 Meter 快照時間——窗口卡住（待確認／逾期）時，t1 之後到這裡都還沒檢查 */
  latestUp: number | null
  diff: WindowResult['diff'] | null
  /** 之前已經對上的窗口累計（從起點算） */
  okCount: number
  okAmount: number
  checkedAt: number | null
}

interface WinRow { tStart: number; gpStart: number; coinStart: number; t1: number | null; fails: number; streak: number; streakT1: number | null; status: WindowState['status']; okCount: number; okAmount: number; checkedAt: number | null; lastJson: string | null }

/**
 * 一台的固定窗口：記快照 → 選窗口 → 查後台 → 更新狀態。
 * 窗口對上了、而且有更新的可比快照，起點才往前接到 t1；對不上就留在同一窗口重查。查詢失敗不算一次失敗。
 */
export async function evalMeterWindow(
  db: Database.Database,
  a: { sessionId: string; gmid: string; clientMachineName: string; base: Baseline; reading: MeterReading; readAt: number },
  fetchBackend: BackendFetcher,
  now: number,
): Promise<{ win: WinView } | { win: WinView; error: string }> {
  const { sessionId, gmid, clientMachineName, base, reading, readAt } = a
  db.prepare('INSERT OR IGNORE INTO live_compare_snap (sessionId, gmid, upTime, gamesPlayed, coinIn, denom, readAt) VALUES (?,?,?,?,?,?,?)')
    .run(sessionId, gmid, reading.upTime || readAt, reading.gamesPlayed, reading.coinIn, reading.denom, readAt)
  let ws = db.prepare('SELECT tStart, gpStart, coinStart, t1, fails, streak, streakT1, status, okCount, okAmount, checkedAt, lastJson FROM live_compare_win WHERE sessionId=? AND gmid=?').get(sessionId, gmid) as WinRow | undefined
  if (!ws) {
    ws = { tStart: base.t0, gpStart: base.gamesPlayed, coinStart: base.coinIn, t1: null, fails: 0, streak: 0, streakT1: null, status: 'pending', okCount: 0, okAmount: 0, checkedAt: null, lastJson: null }
    db.prepare('INSERT INTO live_compare_win (sessionId, gmid, tStart, gpStart, coinStart) VALUES (?,?,?,?,?)').run(sessionId, gmid, ws.tStart, ws.gpStart, ws.coinStart)
  }
  const w = ws
  const snapsOf = () => db.prepare('SELECT upTime, gamesPlayed, coinIn, denom, readAt FROM live_compare_snap WHERE sessionId=? AND gmid=? AND upTime>=?').all(sessionId, gmid, w.tStart) as Snapshot[]
  let snaps = snapsOf()
  let prev: WindowState | null = w.t1 != null ? { t1: w.t1, fails: w.fails, status: w.status, streak: w.streak, streakT1: w.streakT1 } : null
  const newer = pickEvalSnapshot(snaps, w.tStart, now)
  if (prev && prev.status === 'match' && newer && newer.upTime > prev.t1) {
    const s1 = snaps.find(x => x.upTime === prev!.t1)
    if (s1) {
      w.okCount += s1.gamesPlayed - w.gpStart
      w.okAmount = Math.round((w.okAmount + (s1.coinIn - w.coinStart) * base.denom) * 100) / 100
      w.tStart = s1.upTime; w.gpStart = s1.gamesPlayed; w.coinStart = s1.coinIn
      prev = null; w.lastJson = null
      db.prepare('DELETE FROM live_compare_snap WHERE sessionId=? AND gmid=? AND upTime<?').run(sessionId, gmid, w.tStart)
      snaps = snapsOf()
    }
  }
  const view = (st: WindowState | null, r: WindowResult | null, meter: WinView['meter']): WinView => ({
    tStart: w.tStart, t1: st?.t1 ?? null, status: st?.status ?? 'pending', fails: st?.fails ?? 0, streak: st?.streak ?? w.streak, meter,
    backend: r?.backend ?? null, boundary: r?.boundary ?? false, t0Absorbed: r?.t0Absorbed ?? 0, t0SameSecond: r?.t0SameSecond ?? 0, timing: isSplitTiming(gmid) ? 'split' : 'bet', conflicts: r?.conflicts ?? 0, diff: r?.diff ?? null,
    latestUp: snaps.length ? Math.max(...snaps.map(x => x.upTime)) : null,
    okCount: w.okCount, okAmount: w.okAmount, checkedAt: w.checkedAt,
  })
  const save = (st: WindowState | null, r: WindowResult | null) => {
    if (r) w.lastJson = JSON.stringify(r)
    if (st) { w.streak = st.streak ?? w.streak; w.streakT1 = st.streakT1 !== undefined ? st.streakT1 : w.streakT1 }
    db.prepare('UPDATE live_compare_win SET tStart=?, gpStart=?, coinStart=?, t1=?, fails=?, streak=?, streakT1=?, status=?, okCount=?, okAmount=?, checkedAt=?, lastJson=? WHERE sessionId=? AND gmid=?')
      .run(w.tStart, w.gpStart, w.coinStart, st?.t1 ?? null, st?.fails ?? 0, w.streak, w.streakT1, st?.status ?? 'pending', w.okCount, w.okAmount, w.checkedAt, w.lastJson, sessionId, gmid)
  }
  const carry = () => ({ streak: w.streak, streakT1: w.streakT1 })
  const t1 = chooseWindow(prev, pickEvalSnapshot(snaps, w.tStart, now))
  if (t1 == null) { save(prev, null); return { win: view(prev, null, null) } }
  const s1 = snaps.find(x => x.upTime === t1)
  if (!s1) { save(null, null); return { win: view(null, null, null) } }   // 快照不在了：下一輪重新選
  const meter = { count: s1.gamesPlayed - w.gpStart, amount: Math.round((s1.coinIn - w.coinStart) * base.denom * 100) / 100 }
  // 已經對上、也沒有更新的窗口：沿用上次結果，不用每輪重查
  if (prev && prev.status === 'match' && prev.t1 === t1 && w.lastJson) return { win: view(prev, JSON.parse(w.lastJson) as WindowResult, meter) }
  const same = prev && prev.t1 === t1 ? prev : null
  if (!clientMachineName) {
    const st = nextState(same, t1, null, carry(), now); save(st, null)
    return { win: view(st, null, meter), error: 'Instant Meter 沒有這台的機台名稱，查不了全部玩家的 Game Record' }
  }
  const b = await fetchBackend(clientMachineName, gmid, w.tStart - 60_000, t1 + 300_000)
  w.checkedAt = now
  if ('error' in b) { const st = nextState(same, t1, null, carry(), now); save(st, null); return { win: view(st, null, meter), error: b.error } }
  const split = isSplitTiming(gmid)
  if (split) {
    // 局數按派彩時間算的機種：缺派彩時間不能拿下注時間代填、附近有 handpay 也還沒有樣本——這輪不比，不算失敗（CodeX 1110）
    const noPay = b.gr.filter(r => r.payoutAt == null).length
    const hpNear = b.handpay.filter(r => r.betAt > w.tStart - SPLIT_HANDPAY_GUARD_MS && r.betAt <= t1 + 300_000).length
    const why = noPay ? `Game Record 有 ${noPay} 筆沒有派彩時間（這台局數按派彩時間算），這輪不比`
      : hpNear ? `窗口附近有 ${hpNear} 筆 handpay，這台按派彩時間算局數的規則還沒有 handpay 樣本，這輪不比` : ''
    if (why) { const st = nextState(same, t1, null, carry(), now); save(st, null); return { win: view(st, null, meter), error: why } }
  }
  const r = evaluateWindow({ t0: w.tStart, t1, meter, gr: b.gr, handpay: b.handpay, firstWindow: w.tStart === base.t0, split })
  const st = nextState(same, t1, r, carry(), now)
  save(st, r)
  return { win: view(st, r, meter) }
}

/**
 * AutoSpin 即時對照「Meter 固定窗口」判定（純函式，不碰 DB／網路）。
 *
 * 比的是同一個後台的兩份帳：Instant Meter 在 (t0, t1] 的增量，對同一窗口內**這台全部玩家**的
 * Game Record ＋ Jackpot Abnormality（handpay 的局不進 Game Record，等人工補）。
 * AutoSpin 自己記的局數只當參考，不參與判定（CodeX 1105 選 B）：
 *   - Game Record 會比 Meter 晚 2 分鐘左右（MOREPUFF-0134 實測，之後會補），拿 AutoSpin 即時局數比一定一直誤報
 *   - recon_spin 的單號是 Live Ledger 事後回填、observedAt 是 agent 時鐘，都不能當獨立證據
 *
 * ⚠️ 窗口要固定：t1 是一筆已經收到滿 MIN_SNAPSHOT_AGE_MS 的 Meter 快照。對不上就**同一個窗口**下一輪再查，
 *    連兩次完整查詢都對不上才算「逾期待查」，補齊就解除（不能對一直移動的窗口累計失敗次數）。
 * ⚠️ 驗證（2026-11-05，134-puff-NCH 13:00 後）：GR 432 局／13,250 ＋ handpay 4 筆／125 ＝ Meter 436／13,375。
 */

export const MIN_SNAPSHOT_AGE_MS = 180_000
/** 同一窗口連幾次對不上才算逾期待查 */
export const OVERDUE_FAILS = 2
const EPS = 0.005

export interface Snapshot { upTime: number; gamesPlayed: number; coinIn: number; denom: number; readAt: number }

/** 後台一局（Game Record 或 handpay 都轉成這個樣子） */
export interface BackendRound { orderId: string; betAt: number; payoutAt: number; bet: number; source: 'gr' | 'handpay'; handpay: number }

/** 要拿來比的那筆快照：收到滿 MIN_SNAPSHOT_AGE_MS、而且在起點之後。沒有就回 null（還不能比）。 */
export function pickEvalSnapshot(snaps: Snapshot[], t0: number, now: number): Snapshot | null {
  let best: Snapshot | null = null
  for (const s of snaps) {
    if (s.upTime <= t0 || now - s.readAt < MIN_SNAPSHOT_AGE_MS) continue
    if (!best || s.upTime > best.upTime) best = s
  }
  return best
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v.replace(/,/g, '')); return Number.isFinite(n) ? n : null }
  return null
}

/**
 * Game Record／handpay 原始列 → BackendRound。缺單號、下注時間、注額的任何一筆都讓整批無效
 * （不能丟掉那筆——局數會少算，CodeX 7b20fc6 同類問題）。
 */
export function toBackendRounds(raw: Record<string, unknown>[], source: 'gr' | 'handpay'): { rounds: BackendRound[] } | { error: string } {
  const rounds: BackendRound[] = []
  let bad = 0
  for (const r of raw) {
    const orderId = String(r.order_id ?? ''), betT = num(r.bet_time_precise), bet = num(r.bet)
    if (!orderId || betT == null || bet == null) { bad++; continue }
    rounds.push({ orderId, betAt: betT * 1000, payoutAt: (num(r.payout_precise) ?? betT) * 1000, bet, source, handpay: num(r.handpay) ?? 0 })
  }
  const name = source === 'gr' ? 'Game Record' : 'Jackpot Abnormality'
  return bad ? { error: `${name} 有 ${bad}/${raw.length} 筆缺單號／下注時間／注額，這輪不比` } : { rounds }
}

export interface WindowSide { count: number; amount: number }
export interface WindowResult {
  meter: WindowSide
  /** 後台（GR 全體＋handpay，單號去重）在窗口內的局，用下注時間切 */
  backend: WindowSide & { grCount: number; handpayCount: number; handpayBet: number; handpayAmount: number }
  /** 同一批用派彩時間切——窗口邊界剛好有一局「下注在前、派彩在後」時，Meter 可能是照這個算 */
  backendByPayout: WindowSide
  matched: boolean
  /** 用哪一種切法對上的 */
  matchedBy: 'bet' | 'payout' | null
  diff: WindowSide
}

/**
 * 窗口 (t0, t1] 的比對。meter＝快照差值（Coin In 要 ×Denom 才是金額）。
 * 後台兩份依單號去重：同一單如果後來也進了 Game Record，只算一次。
 */
export function evaluateWindow(x: { t0: number; t1: number; meter: WindowSide; gr: BackendRound[]; handpay: BackendRound[] }): WindowResult {
  const byId = new Map<string, BackendRound>()
  for (const r of x.gr) byId.set(r.orderId, r)
  for (const r of x.handpay) if (!byId.has(r.orderId)) byId.set(r.orderId, r)
  const all = [...byId.values()]
  const inWin = (t: number) => t > x.t0 && t <= x.t1
  const sumSide = (rs: BackendRound[]): WindowSide => ({ count: rs.length, amount: Math.round(rs.reduce((a, r) => a + r.bet, 0) * 100) / 100 })
  const byBet = all.filter(r => inWin(r.betAt))
  const byPay = all.filter(r => inWin(r.payoutAt))
  const hp = byBet.filter(r => r.source === 'handpay')
  const same = (a: WindowSide, b: WindowSide) => a.count === b.count && Math.abs(a.amount - b.amount) <= EPS
  const bet = sumSide(byBet), pay = sumSide(byPay)
  const matchedBy = same(x.meter, bet) ? 'bet' : same(x.meter, pay) ? 'payout' : null
  return {
    meter: x.meter,
    backend: {
      ...bet,
      grCount: byBet.length - hp.length,
      handpayCount: hp.length,
      handpayBet: Math.round(hp.reduce((a, r) => a + r.bet, 0) * 100) / 100,
      handpayAmount: Math.round(hp.reduce((a, r) => a + r.handpay, 0) * 100) / 100,
    },
    backendByPayout: pay,
    matched: matchedBy != null,
    matchedBy,
    diff: { count: x.meter.count - bet.count, amount: Math.round((x.meter.amount - bet.amount) * 100) / 100 },
  }
}

export type WindowStatus = 'match' | 'pending' | 'overdue'
export interface WindowState { t1: number; fails: number; status: WindowStatus }

/**
 * 下一輪要比哪個窗口。上一個窗口還沒對上（pending／overdue）就**留在同一個窗口**重查；
 * 對上了才往前換成最新可比的快照。
 */
export function chooseWindow(prev: WindowState | null, eligible: Snapshot | null): number | null {
  if (prev && prev.status !== 'match') return prev.t1
  return eligible ? eligible.upTime : prev?.t1 ?? null
}

/** 這一輪查完之後的狀態。查詢不完整（error）不算一次失敗，維持原狀。 */
export function nextState(prev: WindowState | null, t1: number, result: { matched: boolean } | null): WindowState {
  const sameWin = prev != null && prev.t1 === t1
  if (!result) return sameWin ? prev! : { t1, fails: 0, status: 'pending' }
  if (result.matched) return { t1, fails: 0, status: 'match' }
  const fails = (sameWin ? prev!.fails : 0) + 1
  return { t1, fails, status: fails >= OVERDUE_FAILS ? 'overdue' : 'pending' }
}

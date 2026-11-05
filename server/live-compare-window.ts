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
  matched: boolean
  /**
   * 對不上、而且切點上剛好有局「下注在切點前、派彩在切點後」——Meter 照哪個時間算還沒確認，
   * 不能判錯也不能判對，換下一個快照再比（CodeX bfb0623 P1：不能每段各自挑下注／派彩時間，同一局會被兩段各算一次）。
   */
  boundary: boolean
  /**
   * 起點 t0 上「下注在 t0 前、派彩在 t0 後」、而 Meter 算進這一段的局數。差額**剛好**由這幾局解釋時算一致
   * （Meter 在 t0 快照還沒算到它們，這一段算到了——每一局在整條帳上仍只算一次）。
   */
  t0Absorbed: number
  /** 同一單號在 GR 與 handpay 的注額不一致的筆數（有就不能判一致） */
  conflicts: number
  diff: WindowSide
}

/** 差額能不能剛好由切點上進行中的局解釋：A⊆起點那批（Meter 多算）、B⊆終點那批（Meter 少算），局數與金額都要對上。 */
function explain(diff: WindowSide, s0: BackendRound[], s1: BackendRound[]): { a: number; b: number } | null {
  if (s0.length + s1.length > 12) return null   // 太多就不猜
  let best: { a: number; b: number } | null = null
  for (let ma = 0; ma < 1 << s0.length; ma++) {
    let ca = 0, va = 0
    s0.forEach((r, i) => { if (ma >> i & 1) { ca++; va += r.bet } })
    for (let mb = 0; mb < 1 << s1.length; mb++) {
      let cb = 0, vb = 0
      s1.forEach((r, i) => { if (mb >> i & 1) { cb++; vb += r.bet } })
      if (ca - cb === diff.count && Math.abs(va - vb - diff.amount) <= EPS) {
        if (!best || (cb === 0 && best.b > 0)) best = { a: ca, b: cb }   // 只靠起點那批就能解釋的優先
      }
    }
  }
  return best
}

/**
 * 窗口 (t0, t1] 的比對，**一律用下注時間切**。meter＝快照差值（Coin In 要 ×Denom 才是金額）。
 * 後台兩份依單號去重：同一單如果也進了 Game Record，只算一次——但注額要一致，不一致算衝突。
 */
export function evaluateWindow(x: { t0: number; t1: number; meter: WindowSide; gr: BackendRound[]; handpay: BackendRound[]; firstWindow?: boolean }): WindowResult {
  const byId = new Map<string, BackendRound>()
  let conflicts = 0
  for (const r of x.gr) byId.set(r.orderId, r)
  for (const r of x.handpay) {
    const g = byId.get(r.orderId)
    if (!g) byId.set(r.orderId, r)
    else if (Math.abs(g.bet - r.bet) > EPS) conflicts++
  }
  const all = [...byId.values()]
  const inWin = (t: number) => t > x.t0 && t <= x.t1
  const sumSide = (rs: BackendRound[]): WindowSide => ({ count: rs.length, amount: Math.round(rs.reduce((a, r) => a + r.bet, 0) * 100) / 100 })
  const byBet = all.filter(r => inWin(r.betAt))
  const hp = byBet.filter(r => r.source === 'handpay')
  const bet = sumSide(byBet)
  const diff = { count: x.meter.count - bet.count, amount: Math.round((x.meter.amount - bet.amount) * 100) / 100 }
  let matched = conflicts === 0 && diff.count === 0 && Math.abs(diff.amount) <= EPS
  let boundary = false, t0Absorbed = 0
  // ⚠️ 「有邊界局」不等於「差額是邊界局造成的」：只有差額剛好由切點上的局解釋才放過（CodeX ebfb687 P1——
  //    一局邊界局曾讓 100／200／300 局的差額永遠停在待確認）
  if (!matched && conflicts === 0) {
    // ⚠️ 起點那批只能在**第一個窗口**用：之後的起點是上一段對上的切點，那幾局上一段已經照下注時間算過，
    //    再算進這一段就是同一局算兩次（CodeX bfb0623 P1 的重現）
    const s0 = x.firstWindow ? all.filter(r => r.betAt <= x.t0 && r.payoutAt > x.t0) : []
    const s1 = all.filter(r => r.betAt > x.t0 && r.betAt <= x.t1 && r.payoutAt > x.t1)
    const e = explain(diff, s0, s1)
    if (e && e.b === 0) { matched = true; t0Absorbed = e.a }   // 只有起點那批：Meter 這段算到了，帳上仍各算一次
    else if (e) boundary = true                                 // 終點那批：等下一個快照
  }
  return {
    meter: x.meter,
    backend: {
      ...bet,
      grCount: byBet.length - hp.length,
      handpayCount: hp.length,
      handpayBet: Math.round(hp.reduce((a, r) => a + r.bet, 0) * 100) / 100,
      handpayAmount: Math.round(hp.reduce((a, r) => a + r.handpay, 0) * 100) / 100,
    },
    matched,
    boundary,
    t0Absorbed,
    conflicts,
    diff,
  }
}

/** boundary＝切點上有局在進行，換下一個快照再比 */
export type WindowStatus = 'match' | 'pending' | 'overdue' | 'boundary'
export interface WindowState { t1: number; fails: number; status: WindowStatus }

/**
 * 下一輪要比哪個窗口。對不上（pending／overdue）就**留在同一個窗口**重查；
 * 對上了、或切點卡到進行中的局（boundary），才換成更新的可比快照。
 */
export function chooseWindow(prev: WindowState | null, eligible: Snapshot | null): number | null {
  if (prev && (prev.status === 'pending' || prev.status === 'overdue')) return prev.t1
  if (prev?.status === 'boundary') return eligible && eligible.upTime > prev.t1 ? eligible.upTime : prev.t1
  return eligible ? eligible.upTime : prev?.t1 ?? null
}

/** 這一輪查完之後的狀態。查詢不完整（error）不算一次失敗，維持原狀；切點卡到進行中的局也不算失敗。 */
export function nextState(prev: WindowState | null, t1: number, result: { matched: boolean; boundary?: boolean } | null): WindowState {
  const sameWin = prev != null && prev.t1 === t1
  if (!result) return sameWin ? prev! : { t1, fails: 0, status: 'pending' }
  if (result.matched) return { t1, fails: 0, status: 'match' }
  if (result.boundary) return { t1, fails: 0, status: 'boundary' }
  const fails = (sameWin ? prev!.fails : 0) + 1
  return { t1, fails, status: fails >= OVERDUE_FAILS ? 'overdue' : 'pending' }
}

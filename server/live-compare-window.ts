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
/**
 * 連續幾次「切點待確認」（換了快照還是只能用切點附近的局解釋）就算逾期待查。
 * 真漏一局時，每個新切點附近剛好有同注額的局就會一直被當成切點問題、永遠不報（CodeX 1109 P1 重現）。
 */
export const BOUNDARY_MAX_STREAK = 5
/** 同一個快照一直切點待確認（沒有更新的可比快照，例如 Meter 停更）多久就算逾期待查——streak 只算不同快照（CodeX 0730cf1 P2） */
export const BOUNDARY_SAME_SNAPSHOT_MAX_MS = 10 * 60_000
const EPS = 0.005
/** Instant Meter upTime 的時間精度（整秒） */
export const METER_TIME_RES_MS = 1000

export interface Snapshot { upTime: number; gamesPlayed: number; coinIn: number; denom: number; readAt: number }

/** 後台一局（Game Record 或 handpay 都轉成這個樣子） */
/** payoutAt＝null：後台沒給派彩時間。⚠️ 不能用下注時間代填（分開計時的機種會把進行中的局當成已派彩，CodeX 1110） */
export interface BackendRound { orderId: string; betAt: number; payoutAt: number | null; bet: number; source: 'gr' | 'handpay'; handpay: number }

/**
 * 局數按派彩時間、金額按下注時間切的機種（Meter 的 Coin In 在下注時加、Games Played 在派彩時加）。
 * 2026-11-10 873-SQUIDGAME-1199 實測：54 個快照逐一對全部玩家 48 局，「GP 按 payout、Coin 按 bet」54/54 全對，
 * 「GP 按 bet」錯 6 個（都是有一局已下注未派彩，最長一局 92 秒）。只有實測過的機種才放進來（CodeX 1110：不能推廣到全部 OSM）。
 */
export const SPLIT_TIMING_TYPES: ReadonlySet<string> = new Set(['SQUIDGAME'])
/** gmid 形如 873-SQUIDGAME-1199，中間那段是機種 */
export function isSplitTiming(gmid: string): boolean {
  const parts = gmid.split('-')
  return parts.length >= 3 && SPLIT_TIMING_TYPES.has(parts.slice(1, -1).join('-').toUpperCase())
}
/** 分開計時的機種：窗口前後這段時間內有 handpay 就不比（handpay 局的 Games Played 何時加還沒有樣本） */
export const SPLIT_HANDPAY_GUARD_MS = 10 * 60_000

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
    const payT = num(r.payout_precise)
    rounds.push({ orderId, betAt: betT * 1000, payoutAt: payT == null ? null : payT * 1000, bet, source, handpay: num(r.handpay) ?? 0 })
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
  /** 第一個窗口：起點同一秒內下注、Meter 在起點快照已算的局數（差額剛好由它們解釋時算一致） */
  t0SameSecond: number
  /** 同一單號在 GR 與 handpay 的注額不一致的筆數（有就不能判一致） */
  conflicts: number
  diff: WindowSide
  /** bet＝局數與金額都按下注時間切；split＝局數按派彩時間、金額按下注時間（SPLIT_TIMING_TYPES） */
  timing?: 'bet' | 'split'
}

/**
 * 差額能不能剛好由切點附近的局解釋（局數與金額都要對上）。
 *   pos＝Meter 這段可能多算的局（後台照下注時間不在窗口內）；neg＝Meter 這段可能少算的局（後台照下注時間在窗口內）。
 *   每局標 side：start＝只在起點那側（只有第一個窗口會給）、end＝只在終點那側、both＝兩側都說得通（同一局只列一次）。
 * 回傳：startOnly＝只用起點那側就能解釋的一組；other＝有沒有任何一組用到終點那側（含 both）。
 * ⚠️ 兩種解釋都成立時不能判一致：起點後幾毫秒下注、到終點還沒派彩的局，可能是「起點已算」也可能是「終點還沒算」，
 *    挑起點那種會提前判一致、把差額推到下一段（CodeX 1109 0730cf1 P1 重現）。
 */
type Cand = { r: BackendRound; side: 'start' | 'end' | 'both'; kind: 'inflight' | 'sameSecond' }
function explain(diff: WindowSide, pos: Cand[], neg: Cand[]): { startOnly: Cand[] | null; other: boolean } | null {
  const all = [...pos.map(c => ({ c, sign: 1 })), ...neg.map(c => ({ c, sign: -1 }))]
  if (all.length > 12) return null   // 太多就不猜
  let startOnly: Cand[] | null = null, other = false
  for (let m = 1; m < 1 << all.length; m++) {
    let cnt = 0, amt = 0
    const used: Cand[] = []
    all.forEach((x, i) => { if (m >> i & 1) { cnt += x.sign; amt += x.sign * x.c.r.bet; used.push(x.c) } })
    if (cnt !== diff.count || Math.abs(amt - diff.amount) > EPS) continue
    if (used.every(c => c.side === 'start')) startOnly ??= used
    else other = true
  }
  return startOnly || other ? { startOnly, other } : null
}

/**
 * 窗口 (t0, t1] 的比對，**一律用下注時間切**。meter＝快照差值（Coin In 要 ×Denom 才是金額）。
 * 後台兩份依單號去重：同一單如果也進了 Game Record，只算一次——但注額要一致，不一致算衝突。
 */
/** 一個指標的差額能不能剛好由切點精度範圍內的局解釋（pos＝Meter 可能多算、neg＝Meter 可能少算；值是該局對這個指標的貢獻） */
function explainMetric(diff: number, pos: number[], neg: number[]): boolean {
  const all = [...pos, ...neg.map(v => -v)]
  if (all.length > 12) return false   // 太多就不猜
  for (let m = 1; m < 1 << all.length; m++) {
    let sum = 0
    all.forEach((v, i) => { if (m >> i & 1) sum += v })
    if (Math.abs(sum - diff) <= EPS) return true
  }
  return false
}

/**
 * 分開計時的機種（SPLIT_TIMING_TYPES）：局數＝派彩時間在 (t0, t1] 的局、金額＝下注時間在 (t0, t1] 的局。
 * 每局的局數與金額各自只落在一個窗口，所以跨切點的進行中局不用另外吸收。
 * 對不上時，只有兩個指標的差額都能由切點精度範圍（±1 秒）內的局解釋才算切點待確認；**解釋得了也不判一致**。
 * 前提（由呼叫端保證，見 live-compare-window-store）：每筆 Game Record 都有派彩時間、窗口附近沒有 handpay。
 */
function evaluateSplitWindow(x: { t0: number; t1: number; meter: WindowSide; all: BackendRound[]; conflicts: number; firstWindow?: boolean }): WindowResult {
  const { t0, t1 } = x
  const R = METER_TIME_RES_MS
  const inWin = (t: number) => t > t0 && t <= t1
  // ⚠️ 派彩時間要先截到整秒再比：Meter upTime 只到整秒（14:53:10.91 派彩的局，14:53:10 的快照已經算了）。
  //    實測 54/54 用的是後台 payout_time（整秒）；用毫秒的 payout_precise 直接比第一段就差 1 局
  const paySec = (r: BackendRound) => r.payoutAt == null ? null : Math.floor(r.payoutAt / 1000) * 1000
  const paid = x.all.filter(r => { const p = paySec(r); return p != null && inWin(p) })
  const byBet = x.all.filter(r => inWin(r.betAt))
  const amount = Math.round(byBet.reduce((a, r) => a + r.bet, 0) * 100) / 100
  const diff = { count: x.meter.count - paid.length, amount: Math.round((x.meter.amount - amount) * 100) / 100 }
  const matched = x.conflicts === 0 && diff.count === 0 && Math.abs(diff.amount) <= EPS
  let boundary = false
  if (!matched && x.conflicts === 0) {
    const near = (t: number, cut: number) => t > cut - R && t < cut + R
    // 起點那側只在第一個窗口用（之後的起點是上一段對上的切點，再算一次就重複）
    const cuts = x.firstWindow ? [t0, t1] : [t1]
    const cntPos: number[] = [], cntNeg: number[] = [], amtPos: number[] = [], amtNeg: number[] = []
    for (const r of x.all) {
      const p = paySec(r)
      if (p != null && cuts.some(c => near(p, c))) (inWin(p) ? cntNeg : cntPos).push(1)
      if (cuts.some(c => near(r.betAt, c))) (inWin(r.betAt) ? amtNeg : amtPos).push(r.bet)
    }
    boundary = (diff.count === 0 || explainMetric(diff.count, cntPos, cntNeg))
      && (Math.abs(diff.amount) <= EPS || explainMetric(diff.amount, amtPos, amtNeg))
  }
  return {
    meter: x.meter,
    backend: { count: paid.length, amount, grCount: paid.length, handpayCount: 0, handpayBet: 0, handpayAmount: 0 },
    matched, boundary, t0Absorbed: 0, t0SameSecond: 0, conflicts: x.conflicts, diff, timing: 'split',
  }
}

export function evaluateWindow(x: { t0: number; t1: number; meter: WindowSide; gr: BackendRound[]; handpay: BackendRound[]; firstWindow?: boolean; split?: boolean }): WindowResult {
  const byId = new Map<string, BackendRound>()
  let conflicts = 0
  for (const r of x.gr) byId.set(r.orderId, r)
  for (const r of x.handpay) {
    const g = byId.get(r.orderId)
    if (!g) byId.set(r.orderId, r)
    else if (Math.abs(g.bet - r.bet) > EPS) conflicts++
  }
  const all = [...byId.values()]
  if (x.split) return evaluateSplitWindow({ t0: x.t0, t1: x.t1, meter: x.meter, all, conflicts, firstWindow: x.firstWindow })
  const inWin = (t: number) => t > x.t0 && t <= x.t1
  const sumSide = (rs: BackendRound[]): WindowSide => ({ count: rs.length, amount: Math.round(rs.reduce((a, r) => a + r.bet, 0) * 100) / 100 })
  const byBet = all.filter(r => inWin(r.betAt))
  const hp = byBet.filter(r => r.source === 'handpay')
  const bet = sumSide(byBet)
  const diff = { count: x.meter.count - bet.count, amount: Math.round((x.meter.amount - bet.amount) * 100) / 100 }
  let matched = conflicts === 0 && diff.count === 0 && Math.abs(diff.amount) <= EPS
  let boundary = false, t0Absorbed = 0, t0SameSecond = 0
  // ⚠️ 「有邊界局」不等於「差額是邊界局造成的」：只有差額剛好由切點上的局解釋才放過（CodeX ebfb687 P1——
  //    一局邊界局曾讓 100／200／300 局的差額永遠停在待確認）
  if (!matched && conflicts === 0) {
    // ⚠️ 起點那側只能在**第一個窗口**用：之後的起點是上一段對上的切點，那幾局上一段已經照下注時間算過，
    //    再算進這一段就是同一局算兩次（CodeX bfb0623 P1 的重現）
    // ⚠️ Meter 的 upTime 只到整秒、後台下注時間到毫秒，而且沒證實是截斷還是四捨五入：
    //    切點前後各 1 秒內下注的局，Meter 可能算在任一邊（2026-11-09 892-DRAGONLAW-0025：13:57:18.01 下注的局
    //    Meter 已算、照下注時間卻在窗口外，同一窗口卡逾期待查 38 次）。這只是精度範圍，不是時鐘容差（CodeX）。
    const R = METER_TIME_RES_MS
    const t0 = x.t0, t1 = x.t1
    // kind：切點那一刻還在進行（下注在前、派彩在後）＝inflight；其餘＝同一秒內下注的精度問題
    // 舊規則（局數金額都按下注時間）沿用原本行為：沒有派彩時間的局當成下注當下就結束
    const payAt = (r: BackendRound) => r.payoutAt ?? r.betAt
    const kindAt = (r: BackendRound, cut: number): Cand['kind'] => r.betAt <= cut && payAt(r) > cut ? 'inflight' : 'sameSecond'
    const tag = (rs: BackendRound[], side: Cand['side'], cut: number): Cand[] => rs.map(r => ({ r, side, kind: kindAt(r, cut) }))
    const startPos = x.firstWindow ? tag(all.filter(r => r.betAt <= t0 && (payAt(r) > t0 || r.betAt > t0 - R)), 'start', t0) : []
    const endPos = tag(all.filter(r => r.betAt > t1 && r.betAt < t1 + R), 'end', t1)
    // 窗口內的局：起點同一秒（只有第一窗）／終點進行中或同一秒——兩側都說得通的標 both、只列一次
    const neg: Cand[] = []
    for (const r of byBet) {
      const atStart = !!x.firstWindow && r.betAt < t0 + R
      const atEnd = payAt(r) > t1 || r.betAt > t1 - R
      if (atStart || atEnd) neg.push({ r, side: atStart && atEnd ? 'both' : atStart ? 'start' : 'end', kind: atStart ? kindAt(r, t0) : kindAt(r, t1) })
    }
    const e = explain(diff, [...startPos, ...endPos], neg)
    if (e?.startOnly && !e.other) {   // 只有起點那側解釋得了：Meter 這段的起點跟後台差這幾局，帳上仍各算一次
      matched = true
      t0Absorbed = e.startOnly.filter(c => c.kind === 'inflight').length
      t0SameSecond = e.startOnly.filter(c => c.kind === 'sameSecond').length
    } else if (e) boundary = true   // 用到終點那側、或兩側都說得通：t0 不動，等下一個快照
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
    t0SameSecond,
    conflicts,
    diff,
    timing: 'bet',
  }
}

/** boundary＝切點上有局在進行，換下一個快照再比 */
export type WindowStatus = 'match' | 'pending' | 'overdue' | 'boundary'
/**
 * streak＝連續幾個**不同快照**都切點待確認，跨窗口累計，對上才歸零；streakT1＝最後一個已計入的快照。
 * ⚠️ 不能用「跟上一輪同一個 t1」判斷算過沒：新快照第一次查詢失敗會先存成 pending（同一個 t1），
 *    重試成功判切點待確認時就漏算（CodeX be8d88b P1 重現：9 個不同快照 streak 都停在 1）。
 */
export interface WindowState { t1: number; fails: number; status: WindowStatus; streak?: number; streakT1?: number | null }
export interface StreakCarry { streak: number; streakT1: number | null }

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
export function nextState(
  prev: WindowState | null, t1: number, result: { matched: boolean; boundary?: boolean } | null,
  carry: StreakCarry = { streak: prev?.streak ?? 0, streakT1: prev?.streakT1 ?? null }, now = 0,
): WindowState {
  const sameWin = prev != null && prev.t1 === t1
  const keep = { streak: carry.streak, streakT1: carry.streakT1 }
  if (!result) return sameWin ? { ...prev!, ...keep } : { t1, fails: 0, status: 'pending', ...keep }
  if (result.matched) return { t1, fails: 0, status: 'match', streak: 0, streakT1: null }
  if (result.boundary) {
    // ⚠️ 換窗口不能讓「未收斂」重新計時：連續太多次就停在這個窗口報逾期，直到真的對上
    // 同一個快照只算一次（沒有更新的快照時每輪都會重查同一個 t1）；卡在同一個快照改用時間上限
    const streak = carry.streakT1 === t1 ? carry.streak : carry.streak + 1
    const stuck = sameWin && now > 0 && now - t1 > BOUNDARY_SAME_SNAPSHOT_MAX_MS
    const st = { t1, streak, streakT1: t1 }
    return streak >= BOUNDARY_MAX_STREAK || stuck ? { ...st, fails: sameWin ? prev!.fails : 0, status: 'overdue' } : { ...st, fails: 0, status: 'boundary' }
  }
  const fails = (sameWin ? prev!.fails : 0) + 1
  return { t1, fails, status: fails >= OVERDUE_FAILS ? 'overdue' : 'pending', ...keep }
}

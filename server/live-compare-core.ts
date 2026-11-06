/**
 * AutoSpin「即時對照」的判定規則（純函式，不碰 DB／網路，測試直接呼叫）。
 *
 * 三邊：AutoSpin 自己記的 spin（recon_spin）、OSM Game Record（本帳號＋這台）、
 * OSM Instant Meter（整台機台累計，起點→現在的差值）。
 *
 * ⚠️ 讀不到、快取值一律回 null，畫面顯示「—」，**不能當成 0**——0 會被讀成「這段沒有局」。
 */

export type CompareStatus = 'match' | 'pending' | 'mismatch' | 'cache' | 'unreadable'

/** 連續幾輪都對不上才標「不一致」（2026-11-05 使用者同意：2 輪，約 1 分鐘）。 */
export const MISMATCH_ROUNDS = 2
/** 金額比對容許的浮點誤差 */
export const AMOUNT_EPS = 0.005

export interface MeterReading {
  gamesPlayed: number
  coinIn: number
  denom: number
  /** 後台這筆 meter 的更新時間（epoch ms，來自 meterData.upTime） */
  upTime: number
  useCache: boolean
  cacheHourStr: string
}

export interface Baseline {
  t0: number
  gamesPlayed: number
  coinIn: number
  denom: number
}

/** egmMeterList 一列 → MeterReading。欄位缺就回 null（不猜）。 */
export function parseMeterItem(item: Record<string, unknown>): MeterReading | null {
  const md = (item?.meterData ?? {}) as Record<string, unknown>
  const d = (md.data ?? {}) as Record<string, unknown>
  // ⚠️ 先驗原值：Number(null)／Number('') 都是 0，缺值會被當成「累計 0」建出假起點（CodeX cd8a8b0 P2）
  const num = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN
  const gp = num(d['05']), ci = num(d['00']), den = num(d['Denom'])
  if (!Number.isFinite(gp) || !Number.isFinite(ci) || !Number.isFinite(den) || den <= 0) return null
  const up = Number(md.upTime)
  return {
    gamesPlayed: gp, coinIn: ci, denom: den,
    upTime: Number.isFinite(up) && up > 0 ? up * 1000 : 0,
    useCache: md.useCache === true,
    cacheHourStr: String(md.cacheHourStr ?? ''),
  }
}

/**
 * 起點還能不能用。累計回退（機台重置）或 Denom 改了，差值就沒有意義，要重新設起點。
 */
export function baselineInvalidReason(b: Baseline, now: MeterReading): string | null {
  if (now.denom !== b.denom) return `Denom 從 ${b.denom} 變成 ${now.denom}`
  if (now.gamesPlayed < b.gamesPlayed || now.coinIn < b.coinIn) return '累計值回退（機台可能重置）'
  return null
}

export interface SideValue { count: number | null; amount: number | null }

export interface EvalInput {
  /** AutoSpin 整段（開跑起）——跟 Game Record 比 */
  as: SideValue
  /** AutoSpin 在 Meter 起點之後的那段——跟 Meter 差值比（兩邊窗口要一樣才能減） */
  asSinceT0: SideValue | null
  gr: SideValue | null          // null＝讀取失敗
  meter: SideValue | null       // null＝讀取失敗或沒有起點
  meterCached: boolean
}

export interface EvalResult {
  /** 這一輪有沒有對不上（不含寬限判斷） */
  differs: boolean
  grMinusAs: SideValue
  meterMinusAs: SideValue
}

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : Math.round((a - b) * 100) / 100
}

export function evaluateSides(x: EvalInput): EvalResult {
  const grMinusAs: SideValue = { count: diff(x.gr?.count, x.as.count), amount: diff(x.gr?.amount, x.as.amount) }
  const meterMinusAs: SideValue = x.meterCached
    ? { count: null, amount: null }
    : { count: diff(x.meter?.count, x.asSinceT0?.count), amount: diff(x.meter?.amount, x.asSinceT0?.amount) }
  const off = (v: number | null) => v != null && Math.abs(v) > AMOUNT_EPS
  const differs = off(grMinusAs.count) || off(grMinusAs.amount) || off(meterMinusAs.count) || off(meterMinusAs.amount)
  return { differs, grMinusAs, meterMinusAs }
}

/**
 * 最終狀態。`streak` 是「連續幾輪對不上」（含這一輪）。
 *
 * ⚠️ 能比的那幾邊只要對不上，就先算等待入帳／不一致——Meter 是快取或某一邊讀不到，
 *    **不能把另一邊真的對不上的結果蓋掉**。全部能比的都對上了，才看缺了哪一邊。
 */
export function decideStatus(x: EvalInput, r: EvalResult, streak: number): CompareStatus {
  if (r.differs) return streak >= MISMATCH_ROUNDS ? 'mismatch' : 'pending'
  if (x.gr == null) return 'unreadable'
  if (x.meterCached) return 'cache'
  if (x.meter == null) return 'unreadable'
  return 'match'
}

/**
 * Meter 差值的窗口終點＝這次 Meter 的 upTime。
 * ⚠️ AutoSpin 要截在同一個終點，不能算到查詢當下——Meter 只反映到 upTime，
 *    之後才跑的局會被當成「AutoSpin 多一局」，連續兩輪就變成假的不一致（CodeX cd8a8b0 P1）。
 *    upTime 缺（0）就用讀取時間。
 */
export function meterWindowEnd(reading: Pick<MeterReading, 'upTime'>, readAt: number): number {
  return reading.upTime > 0 ? reading.upTime : readAt
}

/** Meter 的 upTime 落後多久、而且之後 AutoSpin 已經有新局，就算「Meter 未更新」 */
export const METER_STALE_MS = 120_000

/**
 * Meter 停更判定。⚠️ 窗口截在 upTime，Meter 停住時兩邊都只算到 upTime——0 對 0 會顯示假的「一致」
 * （CodeX 2ac32e6 P2）。upTime 之後 AutoSpin 已有新局、且落後超過 METER_STALE_MS，就不拿 Meter 比，只比 Game Record。
 */
export function meterStale(upTime: number, readAt: number, spinsAfterUpTime: number): boolean {
  return upTime > 0 && spinsAfterUpTime > 0 && readAt - upTime > METER_STALE_MS
}

/**
 * Game Record 分頁去重。⚠️ 跑的當下一直有新局寫入，新到舊排序的分頁會往後推，
 * 同一筆跨兩頁出現——不去重 201 局會算成 202 局（CodeX cd8a8b0 P2）。
 */
export function dedupeByOrderId<T extends { orderId: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(r => (seen.has(r.orderId) ? false : (seen.add(r.orderId), true)))
}

export interface OwnRound { orderId: string; gmid: string; bet: number; betTimePrecise: number }

/**
 * 本帳號 Game Record 的防呆（即時對照用）。跟 Live Ledger 的 guardFetchedRows 差在**不要求 spin_index**：
 * GCP 機台（bgtype gsa）的列沒有 spin_index（只有 spinid），套 Live Ledger 那道會讓所有 GCP 機台整批「讀不到」
 * （2026-11-06 892-DRAGONLAW-0025 實測 43/43 筆）。即時對照只用單號、機台、注額、下注時間。
 * 出現別的帳號、或任何一筆缺單號／下注時間／注額 → 整批不用（丟掉那筆局數會少算）。
 */
export function guardOwnRounds(raw: Record<string, unknown>[], username: string): { ok: true; rows: OwnRound[] } | { ok: false; message: string } {
  const foreign = raw.filter(r => String(r.username ?? '') !== username)
  if (foreign.length) {
    const names = [...new Set(foreign.map(r => String(r.username ?? '')))].slice(0, 3)
    return { ok: false, message: `回傳含非目標帳號（期待 ${username}，出現 ${names.join('/')}）：${foreign.length}/${raw.length} 筆` }
  }
  const rows: OwnRound[] = []
  let bad = 0
  for (const r of raw) {
    const orderId = strictStr(r.order_id), gmid = strictStr(r.uid), btp = strictNum(r.bet_time_precise), bet = strictNum(r.bet)
    if (!orderId || !gmid || btp == null || bet == null) { bad++; continue }
    rows.push({ orderId, gmid, bet, betTimePrecise: Math.round(btp * 1000) })
  }
  if (bad) return { ok: false, message: `${bad}/${raw.length} 筆缺單號、機台、下注時間或注額，這輪不比` }
  return { ok: true, rows }
}

/** 非空字串（去空白後）；其他型別或空白 → null */
function strictStr(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}
/** 有限數字；字串要去空白後非空才轉（Number(' ') 是 0，不能放過，CodeX 6dcda5d P2） */
function strictNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

export interface SiteLoginCandidate { username: string; password: string; source: string }
/**
 * 登入渠道後台要試的帳號，依序：渠道後台帳號（有填才有）→ OSM 主帳號 → GCP 那組。同帳號只試一次。
 * 每個帳號通常只能登自己的渠道，所以要逐一試，不能一組套全部（CodeX 6dcda5d P2）。
 */
export function siteLoginCandidates(osm: Record<string, string>, gcp: Record<string, string>): SiteLoginCandidate[] {
  const out: SiteLoginCandidate[] = []
  const add = (u: string | undefined, p: string | undefined, source: string) => {
    if (u && !out.some(c => c.username === u)) out.push({ username: u, password: p || '', source })
  }
  add(osm.site_username, osm.site_password, '渠道後台帳號')
  add(osm.login_username, osm.login_password, 'OSM 主帳號')
  add(gcp.login_username, gcp.login_password, 'GCP 帳號')
  return out
}

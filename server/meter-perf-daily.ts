/**
 * server/meter-perf-daily.ts — Performance Meter 對帳：後台 EGM Performance Meter 日報對照（v5.91.0，Eric 1118、CodeX 同意）
 *
 * 起因：後台 EGM Performance Meter 日報這次有錯，但工具只用 EGM Hourly Meter 快照相減，看不出日報哪裡錯。
 * 做法（CodeX 1118）：
 *   - 日報獨立一張卡，**不影響主判定**（主判定仍是 Hourly vs Game Record）；日報不一致另起警示。
 *   - 分三種結果：日報內部公式（欄 26 WIN/LOSE、欄 2 RTP 原值 vs 用 6/10/29 現算）、日報 vs Hourly 差值、日報 vs Game Record。
 *   - 日報只有整天；有自訂時間就不比。查無資料＝尚未產生（約 15:15 後才有當日）；API 失敗／缺欄＝無法比對，不能當 0。
 */
import { winLossJackpotTerm } from '../shared/meter-rtp.js'
import { isNum } from './meter-verdict.js'

export type PerfDailyStatus = 'ok' | 'partial' | 'mismatch' | 'missing' | 'skipped' | 'notReady' | 'apiError'

export type PerfDailyCheck = {
  group: 'formula' | 'hourly' | 'gameRecord'
  label: string
  daily: number | null
  /** 對照值（現算／Hourly 差值／Game Record 推算）；null＝沒有對照值 */
  other: number | null
  otherLabel: string
  diff: number | null
  ok: boolean | null
  note?: string
  /** 只列出參考、不算進判定 */
  info?: boolean
}

export type PerfDailyResult = {
  status: PerfDailyStatus
  why: string
  values?: {
    coinIn: number; coinOut: number; jackpotWins: number; gamesPlayed: number
    winLossRaw: number | null; rtpRaw: number | null
    winLossCalc: number; rtpCalc: number | null
  }
  checks: PerfDailyCheck[]
  raw?: Record<string, unknown> | null
}

const F = { rtp: '2', gamesPlayed: '5', coinIn: '6', coinOut: '10', winLoss: '26', jackpotWins: '29' } as const
const MONEY_TOL = 0.005

const eq = (a: number, b: number, tol = MONEY_TOL) => Math.abs(a - b) <= tol

/**
 * 欄 2（RTP）的尺度沒實測過是小數（0.0558）還是百分比（5.58）。CodeX d2f8585 [P2]：兩種都接受會把 100 倍錯誤放過
 * → 尺度確認前只顯示、不判定（ok:null＋info，列為「參考」，不算進「無法完整驗證」）。確認後改這裡。
 */
export const RTP_RAW_SCALE: 'fraction' | 'percent' | null = null

/** YYYY-MM-DD 相差天數（b − a） */
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)

export type PerfDailyInput = {
  profile: 'osm' | 'gcp'
  /** 有自訂時間 → 不比 */
  hasCustom: boolean
  /** egmPerformanceMeter 回應（已過 apiProblem 檢查才傳 row；apiError 傳字串） */
  apiError: string | null
  row: Record<string, unknown> | null
  /** Hourly 差值（usedDaily 或沒資料時 null） */
  hourly: { coinIn: number; coinOut: number; jackpotWins: number; gamesPlayed: number } | null
  gameRecord: { totalWin: number; recordCount: number }
  attendantPaidJp: number
  handpayCount: number
  /** CodeX d2f8585 [P2]：Game Record／Jackpot Abnormality 回應無效時不能拿轉成 0 的值比 */
  grValid: boolean
  jpValid: boolean
  /** 查詢日期與今天（UTC+8）——過了產生期限還查無日報＝缺報，不能當「尚未產生」 */
  date: string
  todayLocal: string
}

export function comparePerfDaily(p: PerfDailyInput): PerfDailyResult {
  if (p.hasCustom) return { status: 'skipped', why: '日報只有整天，有填自訂時間就不比對（清掉自訂時間再查）', checks: [] }
  if (p.apiError) return { status: 'apiError', why: `EGM Performance Meter 查詢失敗，無法比對：${p.apiError}`, checks: [] }
  if (!p.row) {
    // 日報約當天 15:15 後才有（Gaming Day 跨到隔天 06:00）；保守給到查詢日 +1 天，超過就算缺報
    if (dayDiff(p.date, p.todayLocal) >= 2) return { status: 'missing', why: `後台日報查無這台 ${p.date} 的資料——已過產生時間，可能缺報（或機台名稱／渠道不對）`, checks: [] }
    return { status: 'notReady', why: '後台日報查無這台這天的資料（當日數據約 15:15 後才產生；還在期限內，不算錯）', checks: [] }
  }

  const need = [F.coinIn, F.coinOut, F.jackpotWins, F.gamesPlayed]
  const miss = need.filter(k => !isNum(p.row![k]))
  if (miss.length) return { status: 'apiError', why: `EGM Performance Meter 缺數值欄位（${miss.join('、')}），無法比對`, checks: [], raw: p.row }

  const n = (k: string) => Number(p.row![k])
  const coinIn = n(F.coinIn), coinOut = n(F.coinOut), jackpotWins = n(F.jackpotWins), gamesPlayed = n(F.gamesPlayed)
  const winLossRaw = isNum(p.row[F.winLoss]) ? n(F.winLoss) : null
  const rtpRaw = isNum(p.row[F.rtp]) ? n(F.rtp) : null
  const winLossCalc = coinIn - coinOut - winLossJackpotTerm(p.profile, jackpotWins)
  const rtpCalc = coinIn !== 0 ? (winLossCalc / coinIn) * 100 : null

  const checks: PerfDailyCheck[] = []
  // ① 日報內部公式
  checks.push(winLossRaw === null
    ? { group: 'formula', label: 'WIN/LOSE', daily: null, other: winLossCalc, otherLabel: '用 Coin In／Out／JP 現算', diff: null, ok: null, note: '日報沒有欄位 26' }
    : { group: 'formula', label: 'WIN/LOSE', daily: winLossRaw, other: winLossCalc, otherLabel: '用 Coin In／Out／JP 現算', diff: winLossRaw - winLossCalc, ok: eq(winLossRaw, winLossCalc) })
  if (rtpRaw === null || rtpCalc === null) {
    checks.push({ group: 'formula', label: 'RTP', daily: rtpRaw, other: rtpCalc, otherLabel: 'WIN/LOSE ÷ Coin In（%）', diff: null, ok: null, note: rtpCalc === null ? 'Coin In 為 0，算不出 RTP' : '日報沒有欄位 2' })
  } else if (RTP_RAW_SCALE === null) {
    checks.push({ group: 'formula', label: 'RTP', daily: rtpRaw, other: rtpCalc, otherLabel: 'WIN/LOSE ÷ Coin In（%）', diff: null, ok: null, info: true, note: '欄 2 是小數還是 % 尚未確認，只列出、不判定' })
  } else {
    const rawPct = RTP_RAW_SCALE === 'fraction' ? rtpRaw * 100 : rtpRaw
    checks.push({ group: 'formula', label: 'RTP', daily: rtpRaw, other: rtpCalc, otherLabel: 'WIN/LOSE ÷ Coin In（%）', diff: rawPct - rtpCalc, ok: Math.abs(rawPct - rtpCalc) < 0.01 + 1e-9 })
  }

  // ② 日報 vs Hourly 差值
  if (p.hourly) {
    const h = p.hourly
    for (const [label, d, o] of [
      ['Coin In', coinIn, h.coinIn], ['Coin Out', coinOut, h.coinOut], ['Jackpot Wins', jackpotWins, h.jackpotWins], ['Games Played', gamesPlayed, h.gamesPlayed],
    ] as const) checks.push({ group: 'hourly', label, daily: d, other: o, otherLabel: 'Hourly 快照差值', diff: d - o, ok: eq(d, o) })
  }

  // ③ 日報 vs Game Record（OSM 的預期 Coin Out 要用日報自己的 Jackpot Wins；GCP 的 Game Record 已含 JP）
  const outLabel = p.profile === 'osm' ? 'GR 總 Win + Attendant Paid JP − 日報 JP' : 'GR 總 Win'
  const gamesLabel = p.handpayCount ? 'GR 筆數 + JP 筆數' : 'GR 筆數'
  if (!p.grValid || !p.jpValid) {
    const note = `${[!p.grValid && 'Game Record', !p.jpValid && 'Jackpot Abnormality'].filter(Boolean).join('、')} 回應無效，不比`
    checks.push({ group: 'gameRecord', label: 'Coin Out', daily: coinOut, other: null, otherLabel: outLabel, diff: null, ok: null, note })
    checks.push({ group: 'gameRecord', label: 'Games Played', daily: gamesPlayed, other: null, otherLabel: gamesLabel, diff: null, ok: null, note })
  } else {
    const expOut = p.profile === 'osm' ? p.gameRecord.totalWin + p.attendantPaidJp - jackpotWins : p.gameRecord.totalWin
    checks.push({ group: 'gameRecord', label: 'Coin Out', daily: coinOut, other: expOut, otherLabel: outLabel, diff: coinOut - expOut, ok: eq(coinOut, expOut) })
    const expGames = p.gameRecord.recordCount + p.handpayCount
    checks.push({ group: 'gameRecord', label: 'Games Played', daily: gamesPlayed, other: expGames, otherLabel: gamesLabel, diff: gamesPlayed - expGames, ok: gamesPlayed === expGames })
  }

  const bad = checks.filter(c => c.ok === false)
  const groupName = { formula: '日報內部公式', hourly: '與 Hourly 差值', gameRecord: '與 Game Record' } as const
  // CodeX d2f8585 [P2]：有列無法驗證（缺欄、來源無效）不能整卡顯示一致；info 列（RTP 尺度未確認）只是參考
  const unverified = checks.filter(c => c.ok === null && !c.info)
  const listOf = (cs: PerfDailyCheck[]) => [...new Set(cs.map(c => groupName[c.group]))].map(g => `${g}（${cs.filter(c => groupName[c.group] === g).map(c => c.label).join('、')}）`).join('；')
  const partial = unverified.length > 0 || !p.hourly
  const why = bad.length
    ? `後台日報不一致：${listOf(bad)}`
    : partial
      ? `沒發現不一致，但無法完整驗證：${[unverified.length ? listOf(unverified) : '', !p.hourly ? '沒有 Hourly 差值可比' : ''].filter(Boolean).join('；')}`
      : '後台日報與 Hourly、Game Record 都一致'
  return { status: bad.length ? 'mismatch' : partial ? 'partial' : 'ok', why, values: { coinIn, coinOut, jackpotWins, gamesPlayed, winLossRaw, rtpRaw, winLossCalc, rtpCalc }, checks, raw: p.row }
}

/**
 * server/meter-verdict.ts — Performance Meter 對帳（meter-reconcile.ts）的判定（v5.57.0，osm-qa-agent 1014 回報、CodeX 定案）
 *
 * 起因：EGM Hourly Meter 沒資料時 actualCoinOut = meter?.coinOut ?? 0，Game Record 又是 0 筆 → 「0 = 0」被判
 *       「通過 — Coin Out 完全吻合」。沒資料、沒活動都不能算通過。
 *
 * 規則（CodeX）：
 *   - 任何一支 API 回應無效（code 不是 20000、缺 items／sumData）→ apiError（不能被 ?? 0／num() 轉成 0 當成沒資料或沒活動）
 *   - Hourly 視窗內 0 個 bucket → noData（就算 fallback 到 daily、或 Game Record 有筆數；daily 只留作參考，不判通過）
 *   - 只有 1 個 bucket → noData：「最後 − 第一」必然是 0，算不出整段差值，也不能當成沒活動的證據
 *   - ≥ 2 個 bucket、Game Record 0 筆、而且 coinIn／coinOut／jackpotWins／gamesPlayed／Bet／Win／Attendant JP 全是 0 → noActivity
 *   - 其他照舊：差值 < 0.005 → pass，否則 fail
 */
export type MeterStatus = 'pass' | 'fail' | 'noData' | 'noActivity' | 'apiError'

export type MeterVerdictInput = {
  /** 各 API 的回應是否有效（code 20000 且資料欄位存在）；無效時給原因 */
  apiProblems: string[]
  /** Hourly 在查詢視窗內的 bucket 數 */
  hourBuckets: number
  /** 是否退回用 daily 總計（只當參考） */
  usedDaily: boolean
  meter: { coinIn: number; coinOut: number; jackpotWins: number; gamesPlayed: number } | null
  gameRecord: { totalBet: number; totalWin: number; recordCount: number }
  attendantPaidJp: number
  delta: number
}

const ZERO = (v: number) => Math.abs(v) < 0.005

export function meterVerdict(p: MeterVerdictInput): { status: MeterStatus; pass: boolean; why: string } {
  if (p.apiProblems.length) return { status: 'apiError', pass: false, why: `後台 API 回應無效（${p.apiProblems.join('；')}），無法對帳` }
  if (p.hourBuckets === 0) return { status: 'noData', pass: false, why: `沒有 EGM Hourly Meter 資料，無法對帳${p.usedDaily ? '（daily 總計只當參考，不判通過）' : ''}` }
  if (p.hourBuckets === 1) return { status: 'noData', pass: false, why: '這段時間只有 1 個 hourly bucket，算不出整段差值，無法對帳' }
  const m = p.meter
  const allZero = !!m && [m.coinIn, m.coinOut, m.jackpotWins, m.gamesPlayed, p.gameRecord.totalBet, p.gameRecord.totalWin, p.attendantPaidJp].every(ZERO)
  if (p.gameRecord.recordCount === 0 && allZero) return { status: 'noActivity', pass: false, why: '這段時間沒有下注（局數、金額、Game Record 都是 0），沒有可對帳的數字' }
  const pass = ZERO(p.delta)
  return { status: pass ? 'pass' : 'fail', pass, why: pass ? '一致 — Coin Out 完全吻合' : '不一致 — Coin Out 有落差' }
}

/** 後台 API 回應是否有效：code 20000，且 pick 拿得到預期的資料 */
export function apiProblem(name: string, d: unknown, valid: (d: any) => boolean): string | null {
  const code = (d as { code?: unknown } | null)?.code
  if (code !== 20000) return `${name} code=${code ?? '無'}`
  try { return valid(d) ? null : `${name} 回應缺少資料欄位` } catch { return `${name} 回應格式不對` }
}

/** 歷史紀錄的摘要（依 status，不能再用 pass ? 一致 : 不一致——沒資料會被寫成「不一致」） */
export function meterHistoryLine(head: string, v: { status: MeterStatus; why: string }, delta: number): string {
  if (v.status === 'pass') return `${head}— ✅ 一致`
  if (v.status === 'fail') return `${head}— ❌ 不一致（差值 ${delta.toFixed(2)}）`
  return `${head}— ⚪ ${v.why}`
}

/** 各 API 回應「資料欄位有效」的判斷（route 與測試共用這一份，免得規則寫兩份） */
export const METER_VALID = {
  hourly: (d: any) => Array.isArray(d.data.items),
  // 沒有紀錄時後台回 code 20000＋data:{}（1014 QAT 實測，查不存在的機台也一樣）＝0 筆，是有效回應；有欄位卻缺 sumData／total 才算無效
  // 有紀錄時 sumData 的 bet／win 必須是數字（CodeX 64cbfa8 [P2]：有 1 筆卻缺 sumData.win 會被 num() 轉成 0、照樣判通過）
  gameRecord: (d: any) => typeof d.data === 'object' && d.data !== null && (Object.keys(d.data).length === 0 || (typeof d.data.sumData === 'object' && d.data.sumData !== null && Number.isFinite(Number(d.data.total)) && (Number(d.data.total) === 0 || (isNum(d.data.sumData.bet) && isNum(d.data.sumData.win))))),
  handPay: (d: any) => Array.isArray(d.data.items),
}

/** CodeX 64cbfa8 [P2]：外層結構對了還不夠——必填數值缺了會被 num() 轉成 0、照樣判通過。數值要先驗得出來（字串數字也可以） */
// CodeX 2e9b441 [P2]：Number(' ')、Number(false)、Number([]) 都是 0 → 原本照樣算數字。只收有限 number，或 trim 後是十進位數字的字串
export const isNum = (v: unknown): boolean => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v.trim())
/** hourly bucket（meterRow／baselineRow）缺哪些必填 meter 欄位；fields＝欄位名 → 顯示名 */
export function missingMeterFields(rows: Array<Record<string, unknown> | null>, fields: Record<string, string>): string[] {
  const miss = new Set<string>()
  for (const r of rows) if (r) for (const [k, label] of Object.entries(fields)) if (!isNum(r[k])) miss.add(label)
  return [...miss]
}

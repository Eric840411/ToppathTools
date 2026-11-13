/** Performance Meter 對帳的查詢時間窗（v5.88.0 從 routes/meter-reconcile.ts 抽出，方便單元測試）。 */

/** 查詢日期的隔天（用於 dateTime[] 上界／gaming day 邊界跨日計算）。 */
export function nextDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** 後台自己的 Game Record 查詢介面（有 DevTools 截圖佐證）送出的 dateTime[] 其實是
 * ISO UTC 字串（例如 "2026-07-26T22:00:00.000Z"），不是單純日期字串——這才是真正能對齊
 * 整天邊界的格式，先前用 "YYYY-MM-DD HH:mm:ss" 這種空白分隔字串完全被後端忽略時分秒。
 * 使用者操作介面的時區固定是 UTC+8（已用真實請求反推驗證：本地 06:00 對應 UTC 前一天 22:00）。 */
export function toUtcIso(dateStr: string, hh: number, mm = 0, ss = 0): string {
  const t = `${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000+08:00`
  return new Date(t).toISOString()
}

/**
 * v5.88.0：自訂起始／結束時間（HH:mm 或 HH:mm:ss，皆選填）→ 查詢時間窗。
 * Gaming Day（06:00 起）時，早於 06:00 的時間算隔天凌晨（同一個 gaming day）。
 * 只覆蓋 Game Record／Jackpot Abnormality 那側；EGM Hourly Meter 仍是整天 bucket。
 */
export function resolveQueryWindow(date: string, boundary: 'gaming' | 'calendar', customStart?: string, customEnd?: string):
  { error: string } | { startIso: string; endIso: string; startLocal: string; endLocal: string; customStart: string | null; customEnd: string | null } {
  const dayStartHour = boundary === 'calendar' ? 0 : 6
  const nextDate = nextDateStr(date)
  const parse = (v: string | undefined, label: string) => {
    if (v == null || v === '') return null
    const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(v)
    if (!m) return { error: `${label}格式要是 HH:mm 或 HH:mm:ss` }
    const h = +m[1], mi = +m[2], se = m[3] ? +m[3] : 0
    const d = boundary === 'gaming' && h < dayStartHour ? nextDate : date
    const clock = `${m[1]}:${m[2]}:${String(se).padStart(2, '0')}`
    return { iso: toUtcIso(d, h, mi, se), local: `${d} ${clock}`, clock }
  }
  const cs = parse(customStart, '自訂起始時間'), ce = parse(customEnd, '自訂結束時間')
  if (cs && 'error' in cs) return { error: cs.error }
  if (ce && 'error' in ce) return { error: ce.error }
  const dayStart = `${String(dayStartHour).padStart(2, '0')}:00:00`
  const startIso = cs ? cs.iso : toUtcIso(date, dayStartHour)
  const endIso = ce ? ce.iso : toUtcIso(nextDate, dayStartHour)
  if (Date.parse(endIso) <= Date.parse(startIso)) return { error: '自訂結束時間要晚於起始時間' }
  return {
    startIso, endIso,
    startLocal: cs ? cs.local : `${date} ${dayStart}`,
    endLocal: ce ? ce.local : `${nextDate} ${dayStart}`,
    customStart: cs ? cs.clock : null, customEnd: ce ? ce.clock : null,
  }
}

/**
 * v5.89.0：EGM Hourly Meter 只有整點快照（快照 N 點＝N:00 當下的累計值），
 * 自訂時間時 Meter 也要跟著縮，不能整天（Eric 11-13：只填結束 14:00:00 就是查 06:00～14:00）。
 * 起點取「不晚於起點」的最後一個快照，終點取「不早於終點」的第一個快照；
 * 時間不在整點時 Meter 只能往外擴到整點，aligned=false 讓畫面註明。
 * 傳入的快照要先依 epoch 排序、只含查詢那一天（gaming／calendar day）範圍內的。
 */
export function pickMeterSnapshots<T extends { epoch: number }>(snaps: T[], windowStart: number, windowEnd: number):
  { first: T; last: T; count: number; aligned: boolean } | null {
  if (snaps.length === 0) return null
  let fi = 0
  for (let i = 0; i < snaps.length; i++) if (snaps[i].epoch <= windowStart) fi = i
  let li = snaps.length - 1
  for (let i = snaps.length - 1; i >= fi; i--) if (snaps[i].epoch >= windowEnd) li = i
  const first = snaps[fi], last = snaps[li]
  return { first, last, count: li - fi + 1, aligned: first.epoch === windowStart && last.epoch === windowEnd }
}

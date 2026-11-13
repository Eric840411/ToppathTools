/**
 * server/meter-count-diag.ts — Performance Meter 對帳「局數不同」時的分段定位（v5.84.0，Lusa 1113、CodeX 同意）
 *
 * 做法：相鄰兩個 EGM Hourly Meter 快照的 Games Played 差值 = 那段時間 Meter 記到的局數；
 *       同一段時間打一次 Game Record（pageSize 1，只讀 total）= 後台記到的筆數。兩邊逐段比，找出對不上的區間。
 *
 * 已實測（QAT 1112，Squid Game - 1199）：
 *   - Game Record 的 dateTime[] 是「含頭不含尾、以秒為單位」：[12:52:54, 12:53:00) 抓得到 12:52:54 派彩那局、
 *     [12:52:00, 12:52:54) 抓不到；起訖的小數秒會被捨到整秒 → 用快照時間切段不會重複算。
 *   - hourly 快照欄位 2 是該快照的 Unix 秒數（daily 才是 RTP）；自然日一天 26 筆（多 05:59:59、23:59:59）。
 *   - useLastData=1 = 那個整點沒收到新快照、數值是沿用的 → 那段的局數會落到下一個真快照，必須併段。
 *
 * 只能「定位可疑區間」，不能證實原因（CodeX）：Meter 的整點快照實際在整點後幾秒才讀，
 * 那幾秒內的局會被 Game Record 算在前一段、Meter 算在後一段 → 相鄰兩段一正一負互相抵銷，多半是這個。
 */

export type HourBucket = { epoch: number; label: string; games: number; stale: boolean }

export type CountInterval = {
  /** Unix 秒，含 */
  start: number
  /** Unix 秒，不含 */
  end: number
  label: string
  /** Meter 在這段記到的局數；計數器重置（差值為負）→ null */
  meterGames: number | null
  /** 這段跨了幾個 hourly 快照（> 1 ＝ 中間有沒更新的快照，併段了） */
  spans: number
  /** 起點或中間有 useLastData=1 的快照（時間範圍不精準） */
  stale: boolean
  reset: boolean
  /** 視窗起點到第一個快照、最後一個快照到視窗結尾：Meter 沒有快照涵蓋，只看 Game Record 有沒有筆數 */
  edge: boolean
}

export type IntervalResult = CountInterval & { grCount: number | null; diff: number | null; error?: string }

/** UTC+8 的 'YYYY-MM-DD HH:mm:ss'（跟 meter-reconcile 的 toUtcIso 同一個時區假設） */
export function fmtLocal(epoch: number): string {
  return new Date((epoch + 8 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * 把查詢視窗內的快照切成區間。windowStart／windowEnd 是整天視窗（Unix 秒，含頭不含尾），
 * 用來補頭尾兩段 edge（Meter 沒涵蓋、但 Game Record 那段可能有筆數）。
 */
export function buildCountIntervals(bucketsIn: HourBucket[], windowStart: number, windowEnd: number): CountInterval[] {
  const buckets = [...bucketsIn].sort((a, b) => a.epoch - b.epoch)
  const out: CountInterval[] = []
  if (buckets.length === 0) return out
  const edge = (start: number, end: number, label: string): CountInterval =>
    ({ start, end, label, meterGames: 0, spans: 0, stale: false, reset: false, edge: true })
  if (buckets[0].epoch > windowStart) out.push(edge(windowStart, buckets[0].epoch, `${fmtLocal(windowStart)} ～ 第一個快照`))
  let from = buckets[0]
  let stale = from.stale
  let spans = 0
  for (let i = 1; i < buckets.length; i++) {
    const b = buckets[i]
    spans++
    // 沒更新的快照（不是最後一個）→ 那段的局會落到下一個真快照，併段
    if (b.stale && i < buckets.length - 1) { stale = true; continue }
    if (b.epoch > from.epoch) {
      const d = b.games - from.games
      out.push({
        start: from.epoch, end: b.epoch, label: `${from.label} ～ ${b.label}`,
        meterGames: d >= 0 ? d : null, spans, stale: stale || b.stale, reset: d < 0, edge: false,
      })
    }
    from = b; stale = b.stale; spans = 0
  }
  const last = buckets[buckets.length - 1]
  if (last.epoch < windowEnd) out.push(edge(last.epoch, windowEnd, `最後一個快照 ～ ${fmtLocal(windowEnd)}`))
  return out
}

/** 併發上限的 map（CodeX：分時查詢要限制併發） */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

export type CountDiagSummary = {
  /** 每段都查得到 */
  complete: boolean
  /** 對不上的區間（含查詢失敗的） */
  mismatched: IntervalResult[]
  /** 相鄰兩段一正一負互相抵銷的（index 指 mismatched） */
  cancelled: Array<[number, number]>
  /** 給使用者看的說明 */
  notes: string[]
  /** 要使用者提供的資料 */
  dataRequests: string[]
}

const PAD = 5 * 60

export function summarizeCountDiag(results: IntervalResult[], day: { meterGames: number; grCount: number }): CountDiagSummary {
  const notes: string[] = []
  const failed = results.filter(r => r.grCount === null)
  const mismatched = results.filter(r => r.grCount === null || r.meterGames === null || r.diff !== 0)
  const cancelled: Array<[number, number]> = []
  for (let i = 0; i + 1 < mismatched.length; i++) {
    const a = mismatched[i], b = mismatched[i + 1]
    if (a.end === b.start && a.diff !== null && b.diff !== null && a.diff + b.diff === 0) { cancelled.push([i, i + 1]); i++ }
  }
  if (failed.length) notes.push(`${failed.length} 段 Game Record 查詢失敗，那幾段不能當成 0 筆，定位結果不完整`)
  const resets = results.filter(r => r.reset)
  if (resets.length) notes.push(`${resets.length} 段 Meter 局數變少（計數器重置過），那幾段算不出 Meter 局數`)
  if (cancelled.length) notes.push(`${cancelled.length} 組相鄰兩段一正一負互相抵銷：多半是 Meter 整點快照在整點後幾秒才讀，那幾秒的局被兩邊算到不同段，不影響整天筆數`)
  if (!failed.length) {
    const sumGr = results.reduce((s, r) => s + (r.grCount ?? 0), 0)
    if (sumGr !== day.grCount) notes.push(`分段 Game Record 加總 ${sumGr} 筆，跟整天查詢的 ${day.grCount} 筆不同（查詢期間可能有新紀錄寫入），請重查一次`)
  }
  const inCancel = new Set(cancelled.flat())
  const suspects = mismatched.filter((_, i) => !inCancel.has(i))
  const dataRequests = suspects.map(r => {
    const what = r.grCount === null ? 'Game Record 查詢失敗' : r.meterGames === null ? `Meter 計數器重置、Game Record ${r.grCount} 筆` : `Meter ${r.meterGames} 局、Game Record ${r.grCount} 筆`
    return `盒子日誌 ${fmtLocal(r.start - PAD)} ～ ${fmtLocal(r.end + PAD)}（${r.label}：${what}${r.spans > 1 ? `，Meter 這段跨 ${r.spans} 個快照` : ''}）`
  })
  if (suspects.length) dataRequests.push('如果開發要對單：上面時段的 Game Record 明細（後台匯出），看有沒有同一個 spinid 出現兩筆')
  return { complete: failed.length === 0, mismatched, cancelled, notes, dataRequests }
}

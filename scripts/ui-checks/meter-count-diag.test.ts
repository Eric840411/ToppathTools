/**
 * Performance Meter 局數分段定位（v5.84.0，Lusa 1113）。npx tsx scripts/ui-checks/meter-count-diag.test.ts
 * 跑的是產品那一份（server/meter-count-diag.ts），不在測試裡重寫切段規則。
 */
import { buildCountIntervals, summarizeCountDiag, fmtLocal, hourBucketFromRow, type HourBucket, type IntervalResult } from '../../server/meter-count-diag.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const H = 3600
const T0 = Date.parse('2026-11-11T00:00:00+08:00') / 1000
const B = (h: number, games: number, stale = false, sec = 0): HourBucket => ({ epoch: T0 + h * H + sec, label: fmtLocal(T0 + h * H + sec), games, stale })

ok(fmtLocal(T0) === '2026-11-11 00:00:00', 'fmtLocal 是 UTC+8', fmtLocal(T0))

// 一般：每小時一段，差值就是局數；視窗與快照對齊 → 沒有 edge
let s0: ReturnType<typeof summarizeCountDiag>
let iv = buildCountIntervals([B(0, 100), B(1, 110), B(2, 130)], T0, T0 + 2 * H)
ok(iv.length === 2 && iv[0].meterGames === 10 && iv[1].meterGames === 20 && !iv[0].edge, '每小時一段、差值＝局數', iv)
ok(iv[0].start === T0 && iv[0].end === T0 + H && iv[1].start === iv[0].end, '區間首尾相接（含頭不含尾，不重複算）', iv)

// 順序亂掉也要排好
iv = buildCountIntervals([B(2, 130), B(0, 100), B(1, 110)], T0, T0 + 2 * H)
ok(iv.map(x => x.meterGames).join() === '10,20', '快照順序亂 → 先排序', iv)

// useLastData=1 的快照 → 併到下一個真快照（CodeX：缺 bucket 時差值會跨數小時，不能說成單一小時）
iv = buildCountIntervals([B(0, 100), B(1, 100, true), B(2, 100, true), B(3, 140)], T0, T0 + 3 * H)
ok(iv.length === 1 && iv[0].meterGames === 40 && iv[0].spans === 3 && iv[0].stale, '⚠️ 中間兩個沒更新的快照 → 併成一段、跨 3 個快照', iv)
// 最後一個是 stale 也要收尾（不能整段丟掉）
iv = buildCountIntervals([B(0, 100), B(1, 120), B(2, 120, true)], T0, T0 + 2 * H)
ok(iv.length === 2 && iv[1].stale && iv[1].meterGames === 0, '最後一個快照沒更新 → 仍收成一段並標 stale', iv)

// 計數器重置：差值為負 → meterGames null，不能當成負局數或 0
iv = buildCountIntervals([B(0, 500), B(1, 3)], T0, T0 + H)
ok(iv[0].meterGames === null && iv[0].reset, '⚠️ 計數器重置 → meterGames null', iv)

// 自然日實測：多一筆 23:59:59、05:59:59 → 1 秒那段也照切
iv = buildCountIntervals([B(5, 10), B(6, 10, false, -1), B(6, 12)], T0, T0 + 6 * H)
ok(iv.length === 3 && iv[0].edge && iv[1].end - iv[1].start === H - 1 && iv[2].end - iv[2].start === 1, '05:59:59 與 06:00:00 之間 1 秒也是一段；視窗起點到第一個快照補 edge', iv)

// 視窗頭尾沒被快照涵蓋 → edge（Meter 0 局）
iv = buildCountIntervals([B(0, 1), B(23, 9, false, 3599)], T0, T0 + 24 * H)
ok(iv.length === 2 && iv[1].edge && iv[1].start === T0 + 24 * H - 1 && iv[1].meterGames === 0, '最後快照 23:59:59 到隔天 00:00 → edge 段', iv)

// 相同時間的重複快照 → 不產生 0 秒的段
iv = buildCountIntervals([B(0, 1), B(0, 1), B(1, 3)], T0, T0 + H)
ok(iv.length === 1 && iv[0].meterGames === 2, '重複時間的快照不產生 0 秒的段', iv)

// CodeX 5faf105：自訂起始時間 → 視窗前的快照不能用（不能把跨過起點的整段差值套進來）
iv = buildCountIntervals([B(0, 100), B(1, 110), B(2, 130), B(3, 160)], T0 + 90 * 60, T0 + 3 * H)
ok(iv.length === 2 && iv[0].edge && iv[0].start === T0 + 90 * 60 && iv[0].end === T0 + 2 * H && iv[1].meterGames === 30, '⚠️ 視窗從 01:30 起 → 00:00、01:00 快照不用；01:30～02:00 是 edge', iv)

// CodeX 5a46e0b [P2]：整日有快照、但自訂視窗內 0 個快照
iv = buildCountIntervals([B(0, 1), B(1, 2), B(2, 3)], T0 + 2 * H + 1800, T0 + 2 * H + 3000)
ok(iv.length === 0, '視窗晚於最後一個快照 → 沒有區間', iv)
s0 = summarizeCountDiag(iv.map(x => ({ ...x, grCount: 0, diff: 0 })), { meterGames: 2, grCount: 5 })
ok(!s0.complete && s0.notes.some(x => /沒有 hourly 快照/.test(x)), '⚠️ 沒有任何區間 → 不完整＋說明（不能回「每段都對得上」）', s0)

// 快照缺值不能被 Number() 轉成 0
ok(hourBucketFromRow({ '2': 1794412800, '5': 117, useLastData: 0 }, 'x', '5')?.games === 117, '正常快照 → HourBucket')
ok(hourBucketFromRow({ '2': '1794412800', '5': '117' }, 'x', '5')?.epoch === 1794412800, '字串數字也收')
for (const bad of [null, '', ' ', undefined]) {
  ok(hourBucketFromRow({ '2': bad, '5': 117 }, 'x', '5') === null, `⚠️ 欄位 2 = ${JSON.stringify(bad)} → null（不能當 0）`)
  ok(hourBucketFromRow({ '2': 1794412800, '5': bad }, 'x', '5') === null, `⚠️ 局數 = ${JSON.stringify(bad)} → null`)
}
ok(hourBucketFromRow({ '2': 1, '5': 1, useLastData: 1 }, 'x', '5')?.stale === true, 'useLastData=1 → stale')

// ── summarize ──
const R = (h1: number, h2: number, m: number | null, g: number | null, extra: Partial<IntervalResult> = {}): IntervalResult =>
  ({ start: T0 + h1 * H, end: T0 + h2 * H, label: `${h1}～${h2}`, meterGames: m, spans: 1, stale: false, reset: false, edge: false, grCount: g, diff: m === null || g === null ? null : m - g, ...extra })

// 11/11 情境：一段 Game Record 多 1 筆
let s = summarizeCountDiag([R(17, 18, 50, 50), R(18, 19, 40, 41), R(19, 20, 30, 30)], { meterGames: 120, grCount: 121 })
ok(s.complete && s.mismatched.length === 1 && s.mismatched[0].label === '18～19', '只列出對不上的那段', s)
ok(s.dataRequests.length === 2 && s.dataRequests[0].includes('2026-11-11 17:55:00 ～ 2026-11-11 19:05:00') && s.dataRequests[0].includes('Meter 40 局、Game Record 41 筆'), '索取盒子日誌：首尾各延伸 5 分鐘、寫出兩邊筆數', s.dataRequests)

// 11/12 情境：整點快照時間差 → 相鄰一正一負抵銷，不列為要查的區間
s = summarizeCountDiag([R(0, 1, 9, 10), R(1, 2, 11, 10), R(2, 3, 5, 5)], { meterGames: 25, grCount: 25 })
ok(s.cancelled.length === 1 && s.notes.some(x => /疑似.*快照/.test(x) && /漏寫/.test(x)), '相鄰一正一負互相抵銷 → 標「疑似快照時間差」，也說明可能是漏寫＋重複', s)
ok(s.dataRequests.length === 3 && s.dataRequests.slice(0, 2).every(x => x.includes('疑似快照時間差')), '⚠️ CodeX 5faf105：抵銷的兩段照樣索取日誌（不能據此免查）', s.dataRequests)
// 不相鄰的一正一負不能被當成抵銷
s = summarizeCountDiag([R(0, 1, 9, 10), R(1, 2, 5, 5), R(2, 3, 11, 10)], { meterGames: 25, grCount: 25 })
ok(s.cancelled.length === 0 && s.dataRequests.length === 3, '不相鄰的一正一負 → 不算抵銷，兩段都要查', s)

// 相鄰但同方向（兩段都少 1）→ 不是快照時間差，兩段都要查
s = summarizeCountDiag([R(0, 1, 9, 10), R(1, 2, 9, 10)], { meterGames: 18, grCount: 20 })
ok(s.cancelled.length === 0 && s.dataRequests.length === 3, '⚠️ 相鄰兩段同方向 → 不算抵銷', s)

// 查詢失敗不能當 0（CodeX）
s = summarizeCountDiag([R(0, 1, 9, 9), R(1, 2, 5, null, { error: 'Game Record code=50000' })], { meterGames: 14, grCount: 14 })
ok(!s.complete && s.mismatched.length === 1 && s.notes.some(x => /查詢失敗/.test(x)) && s.dataRequests[0].includes('查詢失敗'), '⚠️ 某段查詢失敗 → 標不完整、該段列入，不當 0 筆', s)
ok(!s.notes.some(x => /加總/.test(x)), '有查詢失敗時不做加總比對（會誤報）', s.notes)

// 略過缺值快照 → 不完整
s = summarizeCountDiag([R(0, 2, 9, 9)], { meterGames: 9, grCount: 9 }, { skippedBuckets: 1 })
ok(!s.complete && s.notes.some(x => /缺時間或局數/.test(x)), '⚠️ CodeX 5faf105：有快照缺值被略過 → 不能標 complete', s)

// 重置段
s = summarizeCountDiag([R(0, 1, null, 7, { reset: true })], { meterGames: 0, grCount: 7 })
ok(s.mismatched.length === 1 && s.notes.some(x => /重置/.test(x)) && s.dataRequests[0].includes('計數器重置'), '計數器重置段 → 列入並說明', s)

// 分段加總跟整天不同 → 提醒重查
s = summarizeCountDiag([R(0, 1, 9, 9)], { meterGames: 9, grCount: 10 })
ok(s.notes.some(x => /加總 9 筆.*10 筆/.test(x)), '分段加總 ≠ 整天 → 提醒重查', s.notes)

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)

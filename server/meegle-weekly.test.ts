/** 週報撈 Meegle：週期邊界與專案判斷。跑法：npx tsx server/meegle-weekly.test.ts */
import { createdDayVerdict, parseMqlUtc, projectFromTitle, weekBounds } from './meegle-weekly.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
// 週期 2026-09-25（五）～ 2026-10-01（四），台北
const b = weekBounds('2026-09-25', '2026-10-01')
eq('精準起點＝台北 9/25 00:00＝UTC 9/24 16:00', new Date(b.fromMs).toISOString(), '2026-09-24T16:00:00.000Z')
eq('精準終點（不含）＝台北 10/2 00:00', new Date(b.toMs).toISOString(), '2026-10-01T16:00:00.000Z')
eq('查詢放寬：9/24 ～ 10/3（不含）', [b.qStart, b.qEnd], ['2026-09-24', '2026-10-03'])
eq('MQL 時間是 UTC', parseMqlUtc('2026-10-02 05:59:12'), Date.parse('2026-10-02T05:59:12Z'))
eq('更新在台北 10/1 23:59（UTC 15:59）→ 在週期內', (() => { const m = parseMqlUtc('2026-10-01 15:59:00')!; return m >= b.fromMs && m < b.toMs })(), true)
eq('更新在台北 10/2 00:01（UTC 10/1 16:01）→ 不在', (() => { const m = parseMqlUtc('2026-10-01 16:01:00')!; return m >= b.fromMs && m < b.toMs })(), false)
eq('建立 UTC 9/25 → 一定在', createdDayVerdict('2026-09-25', '2026-09-25', '2026-10-01'), 'in')
eq('建立 UTC 9/30 → 一定在', createdDayVerdict('2026-09-30', '2026-09-25', '2026-10-01'), 'in')
eq('建立 UTC 9/24 → 不一定（台北可能已是 9/25）', createdDayVerdict('2026-09-24', '2026-09-25', '2026-10-01'), 'maybe')
eq('建立 UTC 10/1 → 不一定（台北可能是 10/2）', createdDayVerdict('2026-10-01', '2026-09-25', '2026-10-01'), 'maybe')
eq('建立 UTC 10/2 → 一定不在', createdDayVerdict('2026-10-02', '2026-09-25', '2026-10-01'), 'out')
eq('建立 UTC 9/23 → 一定不在', createdDayVerdict('2026-09-23', '2026-09-25', '2026-10-01'), 'out')
eq('專案：標題第一個中括號', projectFromTitle('[OSM][OSM後台]所有弹窗Sure按钮修改为Confirm'), 'OSM')
eq('專案：沒有中括號 → 空', projectFromTitle('teee'), '')
eq('專案：前面有空白也可以', projectFromTitle('  [設計][百家樂]Super Speed'), '設計')
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

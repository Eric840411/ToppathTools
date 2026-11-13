/**
 * server/meter-window 的單元測試。跑法：npx tsx server/meter-window.test.ts
 * 守：自訂起始／結束時間（可到秒、gaming day 早於 06:00 算隔天）、結束不能早於起始、格式錯要擋。
 */
import { pickMeterSnapshots, resolveQueryWindow } from './meter-window.js'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`)
}
const pick = (r: ReturnType<typeof resolveQueryWindow>) => 'error' in r ? r : [r.startLocal, r.endLocal, r.startIso, r.endIso]

eq('gaming 不填＝整個 gaming day', pick(resolveQueryWindow('2026-11-13', 'gaming')),
  ['2026-11-13 06:00:00', '2026-11-14 06:00:00', '2026-11-12T22:00:00.000Z', '2026-11-13T22:00:00.000Z'])
eq('calendar 不填＝00:00~24:00', pick(resolveQueryWindow('2026-11-13', 'calendar')),
  ['2026-11-13 00:00:00', '2026-11-14 00:00:00', '2026-11-12T16:00:00.000Z', '2026-11-13T16:00:00.000Z'])
eq('只填結束（到秒）', pick(resolveQueryWindow('2026-11-13', 'calendar', '', '16:39:01')),
  ['2026-11-13 00:00:00', '2026-11-13 16:39:01', '2026-11-12T16:00:00.000Z', '2026-11-13T08:39:01.000Z'])
eq('起始 HH:mm 補 :00（跟舊版一致）', pick(resolveQueryWindow('2026-11-13', 'gaming', '15:44')),
  ['2026-11-13 15:44:00', '2026-11-14 06:00:00', '2026-11-13T07:44:00.000Z', '2026-11-13T22:00:00.000Z'])
eq('gaming 結束早於 06:00 算隔天凌晨', pick(resolveQueryWindow('2026-11-13', 'gaming', '22:00', '03:30')),
  ['2026-11-13 22:00:00', '2026-11-14 03:30:00', '2026-11-13T14:00:00.000Z', '2026-11-13T19:30:00.000Z'])
eq('結束早於起始要擋', pick(resolveQueryWindow('2026-11-13', 'calendar', '16:00', '15:00')), { error: '自訂結束時間要晚於起始時間' })
eq('結束等於起始要擋', pick(resolveQueryWindow('2026-11-13', 'calendar', '16:00', '16:00:00')), { error: '自訂結束時間要晚於起始時間' })
eq('格式錯要擋', pick(resolveQueryWindow('2026-11-13', 'calendar', '', '25:00')), { error: '自訂結束時間格式要是 HH:mm 或 HH:mm:ss' })

// v5.89.0：Meter 快照跟著自訂時間縮（快照在整點，06:00..12:00）
const H = 3600, D0 = 1000 * H
const snaps = [0, 1, 2, 3, 4, 5, 6].map(i => ({ epoch: D0 + i * H, h: 6 + i }))
const ms = (ws: number, we: number) => { const r = pickMeterSnapshots(snaps, ws, we); return r && [r.first.h, r.last.h, r.count, r.aligned] }
eq('Meter 整天＝第一個到最後一個', ms(D0, D0 + 24 * H), [6, 12, 7, false])
eq('Meter 只填結束 10:00＝06～10 快照', ms(D0, D0 + 4 * H), [6, 10, 5, true])
eq('Meter 起訖 08:00～11:00', ms(D0 + 2 * H, D0 + 5 * H), [8, 11, 4, true])
eq('Meter 非整點往外擴到整點', ms(D0 + 2 * H + 1800, D0 + 4 * H + 1), [8, 11, 4, false])
eq('Meter 沒快照回 null', pickMeterSnapshots([], 0, 1), null)

if (fail) { console.log(`\n${fail} 項失敗`); process.exit(1) }
console.log('\n全部通過')

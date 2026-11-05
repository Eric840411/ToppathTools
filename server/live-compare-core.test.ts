/**
 * AutoSpin 即時對照判定規則的回歸。跑法：npx tsx server/live-compare-core.test.ts
 */
import { parseMeterItem, baselineInvalidReason, evaluateSides, decideStatus, meterWindowEnd, dedupeByOrderId, MISMATCH_ROUNDS, type EvalInput } from './live-compare-core.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

// 真實回應形狀（2026-11-04 QAT 實測，數字取自 873-JJBX-0004）
const cachedItem = { machineName: '873-JJBX-0004', meterData: { error: 0, data: { '05': 4008, '00': 903818600, Denom: 0.01 }, upTime: 1790128802, useCache: true, cacheHourStr: '2026-09-23 10:00:02' } }
const liveItem = { machineName: '873-RISINGROCKETS-0140', meterData: { error: 0, data: { '05': 1009616, '00': 270731971089, Denom: 0.01 }, upTime: 1793786166, isValidMeter: true } }

const c = parseMeterItem(cachedItem)!
eq('快取旗標', c.useCache, true)
eq('快取時間', c.cacheHourStr, '2026-09-23 10:00:02')
const l = parseMeterItem(liveItem)!
eq('即時沒有快取旗標', l.useCache, false)
eq('upTime 秒轉毫秒', l.upTime, 1793786166000)
eq('缺 Denom 不猜', parseMeterItem({ meterData: { data: { '05': 1, '00': 1 } } }), null)

const base = { t0: 0, gamesPlayed: 100, coinIn: 5000, denom: 0.01 }
eq('Denom 改變要重設', baselineInvalidReason(base, { ...l, gamesPlayed: 110, coinIn: 6000, denom: 0.05 }) !== null, true)
eq('累計回退要重設', baselineInvalidReason(base, { ...l, gamesPlayed: 90, coinIn: 6000, denom: 0.01 }) !== null, true)
eq('正常累加不重設', baselineInvalidReason(base, { ...l, gamesPlayed: 110, coinIn: 6000, denom: 0.01 }), null)

const s = (count: number | null, amount: number | null) => ({ count, amount })
const ok: EvalInput = { as: s(10, 100), asSinceT0: s(8, 80), gr: s(10, 100), meter: s(8, 80), meterCached: false }
const st = (x: EvalInput, streak: number) => decideStatus(x, evaluateSides(x), streak)

eq('三邊一致', st(ok, 0), 'match')
eq('Meter 跟起點後的 AutoSpin 比，不是跟整段比', evaluateSides(ok).meterMinusAs, s(0, 0))
eq('第一輪對不上＝等待入帳', st({ ...ok, gr: s(9, 90) }, 1), 'pending')
eq(`連續 ${MISMATCH_ROUNDS} 輪＝不一致`, st({ ...ok, gr: s(9, 90) }, MISMATCH_ROUNDS), 'mismatch')
eq('Meter 快取＋GR 一致＝快取不可比', st({ ...ok, meter: null, meterCached: true }, 0), 'cache')
eq('Meter 快取時 Meter 差值不算', evaluateSides({ ...ok, meter: s(0, 0), meterCached: true }).meterMinusAs, s(null, null))
// 快取不能把 Game Record 真的對不上蓋掉
eq('Meter 快取＋GR 對不上＝不一致', st({ ...ok, meterCached: true, meter: null, gr: s(7, 70) }, MISMATCH_ROUNDS), 'mismatch')
eq('GR 讀不到', st({ ...ok, gr: null }, 0), 'unreadable')
eq('Meter 讀不到', st({ ...ok, meter: null }, 0), 'unreadable')
// 注額未知（null）只比次數，不能當 0 去比金額
eq('AutoSpin 注額未知只比次數', st({ ...ok, as: s(10, null), asSinceT0: s(8, null) }, 0), 'match')
eq('金額對不上也算', st({ ...ok, gr: s(10, 120) }, MISMATCH_ROUNDS), 'mismatch')

// CodeX cd8a8b0 的三項
eq('05 為 null 不建起點', parseMeterItem({ meterData: { data: { '05': null, '00': 100, Denom: 0.01 } } }), null)
eq('00 為空字串不建起點', parseMeterItem({ meterData: { data: { '05': 1, '00': '', Denom: 0.01 } } }), null)
eq('字串數字照收', parseMeterItem({ meterData: { data: { '05': '3', '00': '10', Denom: '0.01' }, upTime: 1 } })?.gamesPlayed, 3)
eq('Meter 窗口終點＝upTime', meterWindowEnd({ upTime: 1000 }, 5000), 1000)
eq('upTime 缺就用讀取時間', meterWindowEnd({ upTime: 0 }, 5000), 5000)
eq('跨頁重複的局只算一次', dedupeByOrderId([{ orderId: 'a' }, { orderId: 'b' }, { orderId: 'a' }]).length, 2)

if (fails.length) { console.error(`FAIL ${fails.length}/${pass + fails.length}\n` + fails.join('\n')); process.exit(1) }
console.log(`PASS ${pass}`)

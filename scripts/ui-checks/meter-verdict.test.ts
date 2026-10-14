/**
 * Performance Meter 對帳判定（v5.57.0，osm-qa-agent 1014 回報、CodeX 定案）：沒資料／沒活動／API 無效都不能算通過。
 *   npx tsx scripts/ui-checks/meter-verdict.test.ts
 * 原本：EGM Hourly Meter 沒資料 → actualCoinOut = meter?.coinOut ?? 0，Game Record 0 筆 → 「0 = 0 通過 — Coin Out 完全吻合」
 */
import { meterVerdict, apiProblem, meterHistoryLine, METER_VALID, missingMeterFields, type MeterVerdictInput } from '../../server/meter-verdict.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const zeroMeter = { coinIn: 0, coinOut: 0, jackpotWins: 0, gamesPlayed: 0 }
const base: MeterVerdictInput = { apiProblems: [], hourBuckets: 24, usedDaily: false, meter: { coinIn: 500, coinOut: 300, jackpotWins: 0, gamesPlayed: 20 }, gameRecord: { totalBet: 500, totalWin: 300, recordCount: 20 }, attendantPaidJp: 0, delta: 0 }
const V = (p: Partial<MeterVerdictInput>) => meterVerdict({ ...base, ...p })

// 1014 回報的情境：Hourly 沒資料、Game Record 0 筆、差值 0 → 原本判通過
let v = V({ hourBuckets: 0, usedDaily: true, meter: null, gameRecord: { totalBet: 0, totalWin: 0, recordCount: 0 }, delta: 0 })
ok(v.status === 'noData' && !v.pass, '⚠️ 1014：Hourly 沒資料、Game Record 0 筆、0 = 0 → noData（不是通過）', v)
v = V({ hourBuckets: 0, usedDaily: true, meter: { coinIn: 9999, coinOut: 300, jackpotWins: 0, gamesPlayed: 50 }, delta: 0 })
ok(v.status === 'noData' && /daily 總計只當參考/.test(v.why), '缺 Hourly、fallback 到 daily 而且剛好對上 → 仍是 noData（daily 不判通過）', v)
v = V({ hourBuckets: 0, meter: null, gameRecord: { totalBet: 500, totalWin: 300, recordCount: 20 } })
ok(v.status === 'noData', '缺 meter 但 Game Record 有筆數 → noData', v)
v = V({ hourBuckets: 1, meter: zeroMeter, gameRecord: { totalBet: 0, totalWin: 0, recordCount: 0 }, delta: 0 })
ok(v.status === 'noData' && /只有 1 個/.test(v.why), '只有 1 個 bucket（最後 − 第一必然 0）→ noData，不能當沒活動的證據', v)
// 沒活動
v = V({ meter: zeroMeter, gameRecord: { totalBet: 0, totalWin: 0, recordCount: 0 }, delta: 0 })
ok(v.status === 'noActivity' && !v.pass, '≥2 個 bucket、全部是 0、Game Record 0 筆 → noActivity（不是通過）', v)
v = V({ meter: { ...zeroMeter, gamesPlayed: 3 }, gameRecord: { totalBet: 0, totalWin: 0, recordCount: 0 }, delta: 0 })
ok(v.status === 'pass', '局數有增加、金額全 0 → 不是 noActivity（照一般比對）', v)
// 有活動、Coin Out 0
v = V({ meter: { coinIn: 500, coinOut: 0, jackpotWins: 0, gamesPlayed: 20 }, gameRecord: { totalBet: 500, totalWin: 0, recordCount: 20 }, delta: 0 })
ok(v.status === 'pass', '有下注、Coin Out 0、預期也是 0 → pass（不能被當成沒活動）', v)
v = V({ meter: { coinIn: 500, coinOut: 0, jackpotWins: 0, gamesPlayed: 20 }, gameRecord: { totalBet: 500, totalWin: 120, recordCount: 20 }, delta: -120 })
ok(v.status === 'fail', '有下注、Coin Out 0、預期 120 → fail', v)
// API 無效
ok(apiProblem('EGM Hourly Meter', { code: 50000 }, d => Array.isArray(d.data.items)) === 'EGM Hourly Meter code=50000', 'code 不是 20000 → 寫出 code')
ok(apiProblem('Game Record', { code: 20000, data: {} }, d => typeof d.data.sumData === 'object' && d.data.sumData !== null) === 'Game Record 回應缺少資料欄位', 'code 20000 但缺 sumData → 缺少資料欄位')
ok(apiProblem('X', { code: 20000 }, d => Array.isArray(d.data.items)) === 'X 回應格式不對', '缺 data（讀欄位丟錯）→ 格式不對')
ok(apiProblem('X', null, () => true) === 'X code=無', '回應是 null → code=無')
// 1014 QAT 實測：沒有紀錄時 Game Record 回 code 20000＋data:{}（查不存在的機台也一樣）——是有效的 0 筆，不能判 apiError
const grValid = METER_VALID.gameRecord   // 跟 route 用同一份
ok(apiProblem('Game Record', { code: 20000, data: {} }, grValid) === null, '實測：Game Record 沒紀錄回 data:{} → 有效（0 筆）')
ok(apiProblem('Game Record', { code: 20000, data: { items: [], total: 3 } }, grValid) !== null, '有欄位卻缺 sumData → 無效')
// CodeX 64cbfa8 [P2]：必填數值缺了不能被 num() 轉成 0 判通過
ok(apiProblem('Game Record', { code: 20000, data: { total: 1, sumData: { bet: '880.00' } } }, grValid) !== null, '⚠️ Game Record 有 1 筆、sumData 缺 win → 無效（原本判通過）')
ok(apiProblem('Game Record', { code: 20000, data: { total: 1, sumData: { bet: '880.00', win: '' } } }, grValid) !== null, 'sumData.win 是空字串 → 無效')
ok(apiProblem('Game Record', { code: 20000, data: { total: 68, sumData: { bet: '50248.00', win: '63467.00' } } }, grValid) === null, 'DFDC4 實際的 sumData（字串數字）→ 有效')
ok(apiProblem('Game Record', { code: 20000, data: { total: 0, sumData: {} } }, grValid) === null, 'total 0、sumData 空 → 有效（0 筆）')
const FIELDS = { '6': 'Coin In', '10': 'Coin Out', '29': 'Jackpot Wins', '5': 'Games Played' }
ok(JSON.stringify(missingMeterFields([{ '6': '100', '10': '50', '29': '0', '5': '3' }, { '6': '200', '10': '80', '29': '0', '5': '9' }], FIELDS)) === '[]', '兩個 bucket 數值齊 → 沒有缺')
ok(JSON.stringify(missingMeterFields([{ '6': '100' }, { '6': '200', '10': null }], FIELDS).sort()) === '["Coin Out","Games Played","Jackpot Wins"]', '⚠️ bucket 缺 meter 數值 → 列出缺的欄位（原本被 num() 轉成 0、判通過）', missingMeterFields([{ '6': '100' }, { '6': '200', '10': null }], FIELDS))
ok(JSON.stringify(missingMeterFields([null, null], FIELDS)) === '[]', '沒有 bucket（null）→ 這裡不判，交給 noData')
v = V({ apiProblems: ['Game Record code=50000'], meter: zeroMeter, gameRecord: { totalBet: 0, totalWin: 0, recordCount: 0 }, delta: 0 })
ok(v.status === 'apiError' && !v.pass, '⚠️ API 失敗被轉成 0 → apiError（不是 noActivity／pass）', v)
// 歷史紀錄
const H = (p: Partial<MeterVerdictInput>, d = 0) => meterHistoryLine('2026-10-14（Gaming Day 06:00起）', V(p), d)
ok(H({}) === '2026-10-14（Gaming Day 06:00起）— ✅ 一致', '歷史：pass → ✅ 一致', H({}))
ok(H({ delta: -120 }, -120) === '2026-10-14（Gaming Day 06:00起）— ❌ 不一致（差值 -120.00）', '歷史：fail → ❌ 不一致', H({ delta: -120 }, -120))
ok(/— ⚪ 沒有 EGM Hourly Meter 資料/.test(H({ hourBuckets: 0, meter: null })), '⚠️ 歷史：noData → ⚪ 寫原因（原本會寫 ✅ 一致）', H({ hourBuckets: 0, meter: null }))
ok(/— ⚪ 這段時間沒有下注/.test(H({ meter: zeroMeter, gameRecord: { totalBet: 0, totalWin: 0, recordCount: 0 } })), '歷史：noActivity → ⚪ 沒有下注')

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)

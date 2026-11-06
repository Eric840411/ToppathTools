/**
 * 停止後結算與總表卡片的回歸。跑法：npx tsx server/live-compare-final-core.test.ts
 */
import { decideSettle, machineSettle, summarizeMachine, buildFinalReportCard, SETTLE_MAX_MS, TAIL_QUIET_MS, TAIL_MARGIN_MS } from './live-compare-final-core.js'
import type { LiveCompareRow } from './live-compare.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const MIN = 60_000
const STOP = 1_793_900_000_000
const LAST = STOP - 5_000
const TARGET = LAST + TAIL_MARGIN_MS
type Win = NonNullable<LiveCompareRow['win']>
const win = (o: Partial<Win>): Win => ({ tStart: STOP - 60 * MIN, t1: null, status: 'pending', fails: 0, meter: null, backend: null, boundary: false, t0Absorbed: 0, conflicts: 0, latestUp: null, diff: null, okCount: 0, okAmount: 0, checkedAt: null, ...o })
const row = (w: Win | null, extra: Partial<LiveCompareRow> = {}): LiveCompareRow => ({
  sessionId: 's', gmid: '892-DRAGONLAW-0025', machineType: 'DRAGONLAW', channelId: '892', channelName: 'NC', clientMachineName: 'Fortune Pots - NCH 25', meterKind: 'GCP',
  username: 'fixture01', status: 'pending', reason: '', startedAt: STOP - 120 * MIN, t0: STOP - 110 * MIN,
  as: { count: 300, amount: null, betKnown: 300, readAt: STOP }, asSinceT0: null, gr: null, meter: null, meterCached: false, meterStale: false, cacheHourStr: '',
  meterStart: null, meterNow: null, denom: 1, grMinusAs: { count: null, amount: null }, meterMinusAs: { count: null, amount: null }, chain: null, win: w, ...extra,
})
const base = { stopped: true, stoppedAt: STOP, lastSpinAt: LAST, lastGrowthAt: STOP, now: STOP + 5 * MIN }

// ── 一台的結算 ──
eq('窗口涵蓋到終點而且一致 → done', machineSettle(row(win({ status: 'match', t1: TARGET })), TARGET), 'done')
eq('一致但 t1 還在終點之前 → 還要等（前面那段一致不代表尾段）', machineSettle(row(win({ status: 'match', t1: TARGET - 1 })), TARGET), 'wait')
eq('逾期待查 → 照逾期定案', machineSettle(row(win({ status: 'overdue', t1: STOP - 10 * MIN })), TARGET), 'overdue')
eq('待確認 → 等', machineSettle(row(win({ status: 'pending', t1: TARGET })), TARGET), 'wait')
eq('沒有窗口 → 等', machineSettle(row(null), TARGET), 'wait')

// ── 整輪 ──
eq('還在跑 → running', decideSettle({ ...base, stopped: false }).state, 'running')
eq('剛停止、最後幾局還在寫 → settling（不能停止當下就定終點）',
  decideSettle({ ...base, lastGrowthAt: STOP + 4 * MIN + 50_000 }).state, 'settling')
eq('終點＝最後一局＋時鐘餘裕', decideSettle({ ...base, rows: [row(win({ status: 'match', t1: TARGET }))] }).targetUp, TARGET)
eq('每台都涵蓋到終點且一致 → final', decideSettle({ ...base, rows: [row(win({ status: 'match', t1: TARGET }))] }).state, 'final')
eq('一台一致、一台逾期 → final（逾期是定案）', decideSettle({ ...base, rows: [row(win({ status: 'match', t1: TARGET })), row(win({ status: 'overdue' }))] }).state, 'final')
eq('還有一台沒到終點 → settling', decideSettle({ ...base, rows: [row(win({ status: 'match', t1: TARGET })), row(win({ status: 'match', t1: TARGET - MIN }))] }).state, 'settling')
eq('超過結算上限還沒到終點 → timeout（不能當一致）', decideSettle({ ...base, now: STOP + SETTLE_MAX_MS + 1, rows: [row(win({ status: 'match', t1: TARGET - MIN }))] }).state, 'timeout')
eq('超過上限但其實都收斂了 → final', decideSettle({ ...base, now: STOP + SETTLE_MAX_MS + 1, rows: [row(win({ status: 'match', t1: TARGET }))] }).state, 'final')
eq('停止後一直有新局寫入超過上限 → timeout', decideSettle({ ...base, now: STOP + SETTLE_MAX_MS + 1, lastGrowthAt: STOP + SETTLE_MAX_MS - 1 }).state, 'timeout')
eq('尾筆安靜判斷用伺服器時鐘（lastGrowthAt），不拿 agent 時鐘比', decideSettle({ ...base, lastSpinAt: STOP + 99 * MIN, lastGrowthAt: STOP, rows: [row(win({ status: 'match', t1: STOP + 99 * MIN + TAIL_MARGIN_MS }))] }).state, 'final')
eq('沒有任何 spin → final（沒東西可比）', decideSettle({ ...base, lastSpinAt: null, rows: [] }).state, 'final')
eq('剛好安靜滿 TAIL_QUIET_MS 才往下判斷', decideSettle({ ...base, now: STOP + TAIL_QUIET_MS - 1, rows: [row(win({ status: 'match', t1: TARGET }))] }).state, 'settling')

// ── 總計：已對上的段＋目前這段（一致才算），只算一次 ──
{
  const m = summarizeMachine(row(win({ status: 'match', t1: TARGET, okCount: 400, okAmount: 20000, meter: { count: 11, amount: 550 } })), TARGET)
  eq('一致時總計＝累計＋這段', [m.matchedCount, m.matchedAmount], [411, 20550])
  eq('一致時已查到 t1', m.checkedTo, TARGET)
  eq('結論 done', m.settle, 'done')
  const p = summarizeMachine(row(win({ status: 'overdue', tStart: STOP - 30 * MIN, t1: STOP - 20 * MIN, okCount: 400, okAmount: 20000, meter: { count: 11, amount: 550 }, diff: { count: 1, amount: 50 }, latestUp: STOP + 2 * MIN })), TARGET)
  eq('對不上的那段不算進一致總計', [p.matchedCount, p.matchedAmount], [400, 20000])
  eq('對不上時已查到上一個對上的切點', p.checkedTo, STOP - 30 * MIN)
  eq('列出差額', p.diff, { count: 1, amount: 50 })
  eq('列出還沒檢查的尾段', p.uncheckedTo, STOP + 2 * MIN)
  const none = summarizeMachine(row(win({ status: 'pending', tStart: STOP - 110 * MIN })), TARGET)
  eq('一段都還沒對上 → 已查範圍是空的', [none.matchedCount, none.checkedTo], [0, null])
  const err = summarizeMachine(row(null, { status: 'unreadable', reason: '登入 NC 後台失敗', meterError: '登入 NC 後台失敗' }), TARGET)
  eq('讀取錯誤要列出來（同一句不重複）', err.error, '登入 NC 後台失敗')
}

// ── 卡片 ──
{
  const ok = summarizeMachine(row(win({ status: 'match', t1: TARGET, okCount: 400, okAmount: 20000, meter: { count: 11, amount: 550 } })), TARGET)
  const bad = summarizeMachine(row(win({ status: 'overdue', diff: { count: 2, amount: 100 } }), { clientMachineName: '<at id=all></at>X' }), TARGET)
  const card = JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - 120 * MIN, stoppedAt: STOP, state: 'final', reason: '', machines: [ok, bad] }))
  eq('有逾期 → 紅色、標題寫幾台逾期', [card.includes('"template":"red"'), card.includes('1 台逾期待查')], [true, true])
  eq('外來文字的 < > 換全形（不能 @所有人）', [card.includes('<at id=all>'), card.includes('＜at id=all＞')], [false, true])
  eq('註明是後台對照、不代表每局入帳', card.includes('不代表 AutoSpin 每一局都入帳'), true)
  eq('一致總計出現在卡片', card.includes('411 局／20,550'), true)
  const allOk = JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - 120 * MIN, stoppedAt: STOP, state: 'final', reason: '', machines: [ok] }))
  eq('全部一致 → 綠色', [allOk.includes('"template":"green"'), allOk.includes('全部一致')], [true, true])
  const to = JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - 120 * MIN, stoppedAt: STOP, state: 'timeout', reason: '停止後 15 分鐘仍有 1 台沒對到終點', machines: [summarizeMachine(row(win({ status: 'match', t1: TARGET - MIN })), TARGET)] }))
  eq('未收斂 → 橘色、明講不能當一致', [to.includes('"template":"orange"'), to.includes('不能當成一致'), to.includes('全部一致')], [true, true, false])
}

if (fails.length) { console.error(`FAIL ${fails.length}/${pass + fails.length}\n` + fails.join('\n')); process.exit(1) }
console.log(`PASS ${pass}`)

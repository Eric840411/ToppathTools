/**
 * 停止後結算與總表卡片的回歸。跑法：npx tsx server/live-compare-final-core.test.ts
 */
import { decideSettle, machineSettle, summarizeMachine, buildFinalReportCard, targetFromSnaps, targetWithEvidence, ownUntil, SETTLE_MAX_MS, TAIL_QUIET_MS, ZERO_SPIN_WAIT_MS, GR_SETTLE_MS } from './live-compare-final-core.js'
import type { LiveCompareRow } from './live-compare.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const MIN = 60_000
const STOP = 1_793_900_000_000
/** 終點：尾筆收妥後讀到的 Meter 快照 upTime */
const TARGET = STOP + 40_000
type Win = NonNullable<LiveCompareRow['win']>
const win = (o: Partial<Win>): Win => ({ tStart: STOP - 60 * MIN, t1: null, status: 'pending', fails: 0, meter: null, backend: null, boundary: false, t0Absorbed: 0, conflicts: 0, latestUp: null, diff: null, okCount: 0, okAmount: 0, checkedAt: null, ...o })
const row = (w: Win | null, extra: Partial<LiveCompareRow> = {}): LiveCompareRow => ({
  sessionId: 's', gmid: '892-DRAGONLAW-0025', machineType: 'DRAGONLAW', channelId: '892', channelName: 'NC', clientMachineName: 'Fortune Pots - NCH 25', meterKind: 'GCP',
  username: 'fixture01', status: 'pending', reason: '', startedAt: STOP - 120 * MIN, t0: STOP - 110 * MIN,
  as: { count: 300, amount: null, betKnown: 300, readAt: STOP }, asSinceT0: null, gr: null, meter: null, meterCached: false, meterStale: false, cacheHourStr: '',
  meterStart: null, meterNow: null, denom: 1, grMinusAs: { count: null, amount: null }, meterMinusAs: { count: null, amount: null }, chain: null, win: w, ...extra,
})
const G = '892-DRAGONLAW-0025', G2 = '892-MOREPUFF-0134'
const base = { stopped: true, stoppedAt: STOP, spinCount: 300, lastGrowthAt: STOP, now: STOP + 5 * MIN, targets: { [G]: TARGET, [G2]: TARGET } as Record<string, number | null> }

// ── 終點：尾筆收妥之後才讀到的快照（伺服器時鐘比 readAt，不用 agent 時鐘）──
const QF = STOP + TAIL_QUIET_MS
eq('取收妥之後最早那筆快照', targetFromSnaps([{ upTime: STOP - 9 * MIN, readAt: STOP - 1000 }, { upTime: TARGET, readAt: QF + 5000 }, { upTime: TARGET + MIN, readAt: QF + MIN }], QF), TARGET)
eq('收妥之前讀到的快照不算（可能還沒含最後一局）', targetFromSnaps([{ upTime: STOP + 99 * MIN, readAt: QF - 1 }], QF), null)
eq('沒有快照 → 定不出終點', targetFromSnaps([], QF), null)

// ── 終點要有 Meter 涵蓋尾局的證據（本帳號最後一局的後台下注時間，一般局＋handpay）──
{
  const own = (o: Record<string, unknown> = {}) => ({ autospin: 3, gr: 3, handpay: 0, lastBetAt: STOP, until: STOP + MIN, ...o })
  const ev = (o: Partial<Parameters<typeof targetWithEvidence>[0]>) => targetWithEvidence({ snapTarget: TARGET, own: own(), prevGrCount: 3, now: QF + GR_SETTLE_MS, quietFrom: QF, ...o })
  eq('證據齊 → 終點取快照與最後一局較晚者', ev({}).target, Math.max(TARGET, STOP))
  eq('Meter 停更（快照比最後一局舊）→ 終點拉到最後一局，舊窗口追不過', ev({ snapTarget: STOP - 120_000 }).target, STOP)
  eq('Game Record 還沒到齊 → 不給終點', ev({ now: QF + GR_SETTLE_MS - 1 }).target, null)
  eq('本帳號局數還在變 → 不給終點', ev({ prevGrCount: 2 }).target, null)
  eq('沒查本帳號（頁面輪詢）→ 沒有證據', ev({ own: undefined }).target, null)
  eq('handpay／GR 讀取失敗 → 沒有證據', ev({ own: { error: 'Jackpot Abnormality 回 code=500' } }).target, null)
  eq('handpay 筆數變了也算還在變', ev({ own: own({ handpay: 1 }) }).target, null)
  eq('本帳號一局都沒有 → 沒有證據', ev({ own: own({ lastBetAt: null }) }).target, null)
}

// ── 一台的結算 ──
eq('窗口涵蓋到終點而且一致 → done', machineSettle(row(win({ status: 'match', t1: TARGET })), TARGET), 'done')
eq('一致但 t1 還在終點之前 → 還要等（前面那段一致不代表尾段）', machineSettle(row(win({ status: 'match', t1: TARGET - 1 })), TARGET), 'wait')
eq('終點還定不出來 → 等', machineSettle(row(win({ status: 'match', t1: TARGET })), null), 'wait')
eq('逾期待查 → 照逾期定案', machineSettle(row(win({ status: 'overdue', t1: STOP - 10 * MIN })), TARGET), 'overdue')
eq('待確認 → 等', machineSettle(row(win({ status: 'pending', t1: TARGET })), TARGET), 'wait')
eq('沒有窗口 → 等', machineSettle(row(null), TARGET), 'wait')

// ── 整輪 ──
const ok1 = row(win({ status: 'match', t1: TARGET }))
eq('還在跑 → running', decideSettle({ ...base, stopped: false, rows: [] }).state, 'running')
eq('剛停止、最後幾局還在寫 → settling', decideSettle({ ...base, lastGrowthAt: STOP + 4 * MIN + 50_000, rows: [ok1] }).state, 'settling')
eq('每台都涵蓋到終點且一致 → final', decideSettle({ ...base, rows: [ok1] }).state, 'final')
eq('一台一致、一台逾期 → final（逾期是定案）', decideSettle({ ...base, rows: [ok1, row(win({ status: 'overdue' }), { gmid: G2 })] }).state, 'final')
eq('還有一台沒到終點 → settling', decideSettle({ ...base, rows: [ok1, row(win({ status: 'match', t1: TARGET - MIN }), { gmid: G2 })] }).state, 'settling')
eq('有一台終點還定不出來 → settling', decideSettle({ ...base, targets: { [G]: TARGET, [G2]: null }, rows: [ok1, row(win({ status: 'match', t1: TARGET }), { gmid: G2 })] }).state, 'settling')
eq('超過結算上限還沒到終點 → timeout（不能當一致）', decideSettle({ ...base, now: STOP + SETTLE_MAX_MS + 1, rows: [row(win({ status: 'match', t1: TARGET - MIN }))] }).state, 'timeout')
eq('超過上限但其實都收斂了 → final', decideSettle({ ...base, now: STOP + SETTLE_MAX_MS + 1, rows: [ok1] }).state, 'final')
eq('停止後一直有新局寫入超過上限 → timeout', decideSettle({ ...base, now: STOP + SETTLE_MAX_MS + 1, lastGrowthAt: STOP + SETTLE_MAX_MS - 1, rows: [ok1] }).state, 'timeout')
eq('剛好安靜滿 TAIL_QUIET_MS 才往下判斷', decideSettle({ ...base, now: STOP + TAIL_QUIET_MS - 1, rows: [ok1] }).state, 'settling')
// CodeX aa55b01 P1：零筆不能停止當下就凍結，第一筆可能還在路上
eq('零筆、剛停止 → 還要等', decideSettle({ ...base, spinCount: 0, now: STOP + TAIL_QUIET_MS + 1, rows: [] }).state, 'settling')
eq('零筆、等滿 ZERO_SPIN_WAIT_MS → final', decideSettle({ ...base, spinCount: 0, now: STOP + ZERO_SPIN_WAIT_MS, rows: [] }).state, 'final')
eq('零筆但又收到新局 → 回到等尾筆', decideSettle({ ...base, spinCount: 0, lastGrowthAt: STOP + ZERO_SPIN_WAIT_MS, now: STOP + ZERO_SPIN_WAIT_MS + 1, rows: [] }).state, 'settling')

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
  const ok = summarizeMachine(row(win({ status: 'match', t1: TARGET, okCount: 400, okAmount: 20000, meter: { count: 11, amount: 550 } }), { own: { autospin: 411, gr: 411, handpay: 0, lastBetAt: STOP, until: STOP + MIN } }), TARGET)
  const bad = summarizeMachine(row(win({ status: 'overdue', diff: { count: 2, amount: 100 } }), { clientMachineName: '<at id=all></at>X' }), TARGET)
  const card = JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - 120 * MIN, stoppedAt: STOP, state: 'final', reason: '', machines: [ok, bad] }))
  eq('有逾期 → 紅色、標題寫幾台逾期', [card.includes('"template":"red"'), card.includes('1 台逾期待查')], [true, true])
  eq('外來文字的 < > 換全形（不能 @所有人）', [card.includes('<at id=all>'), card.includes('＜at id=all＞')], [false, true])
  eq('說明兩種對照', card.includes('AutoSpin vs 你帳號 Game Record」看 AutoSpin 跑的局有沒有進後台'), true)
  eq('一致總計出現在卡片', card.includes('411 局／20,550'), true)
  const allOk = JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - 120 * MIN, stoppedAt: STOP, state: 'final', reason: '', machines: [ok] }))
  eq('全部一致 → 綠色', [allOk.includes('"template":"green"'), allOk.includes('全部一致')], [true, true])
  const to = JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - 120 * MIN, stoppedAt: STOP, state: 'timeout', reason: '停止後 15 分鐘仍有 1 台沒對到終點', machines: [summarizeMachine(row(win({ status: 'match', t1: TARGET - MIN })), TARGET)] }))
  eq('未收斂 → 橘色、明講不能當一致', [to.includes('"template":"orange"'), to.includes('不能當成一致'), to.includes('全部一致')], [true, true, false])
}

// ── AutoSpin vs 本帳號 Game Record＋handpay ──
{
  type Own = NonNullable<LiveCompareRow['own']>
  const own = (autospin: number, gr: number, handpay: number): Own => ({ autospin, gr, handpay, lastBetAt: STOP, until: STOP + MIN })
  const mk = (o: Own | undefined) => summarizeMachine(row(win({ status: 'match', t1: TARGET }), { own: o }), TARGET)
  eq('結算時查過 → 有這一行', mk(own(300, 299, 1)).own, { autospin: 300, gr: 299, handpay: 1 })
  eq('沒查（頁面輪詢）→ 不比', mk(undefined).own, null)
  eq('讀不到 → 不比、記原因', [mk({ error: 'code=500' }).own, mk({ error: 'code=500' }).ownError], [null, 'code=500'])
  const c = (o: Own | undefined) => JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - 60 * MIN, stoppedAt: STOP, state: 'final', reason: '', machines: [mk(o)] }))
  eq('局數相同（Game Record＋handpay）→ 綠勾、不寫成逐局一致', [c(own(300, 299, 1)).includes('AutoSpin 300 局 vs 你帳號 Game Record 299 局＋handpay 1'), c(own(300, 299, 1)).includes('局數相同')], [true, true])
  eq('局數相同不保證逐局對上，要註明', c(own(300, 299, 1)).includes('漏一局又多一局會互相抵掉'), true)
  eq('AutoSpin 多 → 紅字寫多幾局', c(own(302, 299, 1)).includes('AutoSpin 多 2 局'), true)
  // CodeX b7f907e P2：局數有差，標題不能還是綠色「全部一致」
  eq('局數有差 → 標題紅色、寫出來', [c(own(302, 299, 1)).includes('"template":"red"'), c(own(302, 299, 1)).includes('1 台 AutoSpin 局數有差'), c(own(302, 299, 1)).includes('全部一致')], [true, true, false])
  eq('沒查到 → 明講沒查到、標題不寫全部一致', [c({ error: 'code=500' }).includes('沒查到（code=500）'), c({ error: 'code=500' }).includes('全部一致'), c({ error: 'code=500' }).includes('"template":"orange"')], [true, false, true])
}

// ── 本帳號局數的上界（CodeX 431cd7c P1）──
eq('沒有下一輪 → 停止＋1 分鐘', ownUntil(STOP, null), { untilMs: STOP + MIN, note: '' })
eq('下一輪在 1 分鐘之後 → 停止＋1 分鐘', ownUntil(STOP, STOP + 2 * MIN), { untilMs: STOP + MIN, note: '' })
eq('下一輪 30 秒後開始 → 切在下一輪開始', ownUntil(STOP, STOP + 30_000), { untilMs: STOP + 30_000, note: '' })
eq('下一輪 10 秒後就開始 → 切在下一輪開始、標只供參考', ownUntil(STOP, STOP + 10_000).note !== '', true)
{
  type Own = NonNullable<LiveCompareRow['own']>
  const ref: Own = { autospin: 5, gr: 7, handpay: 0, lastBetAt: STOP, until: STOP + 10_000, note: '下一輪在停止後馬上開始' }
  const card = JSON.stringify(buildFinalReportCard({ userLabel: 'Siara', startedAt: STOP - MIN, stoppedAt: STOP, state: 'final', reason: '', machines: [summarizeMachine(row(win({ status: 'match', t1: TARGET }), { own: ref }), TARGET)] }))
  eq('只供參考的差異不標紅、不寫局數有差', [card.includes('只供參考'), card.includes('局數有差'), card.includes('"template":"red"'), card.includes('全部一致')], [true, false, false, false])
}

if (fails.length) { console.error(`FAIL ${fails.length}/${pass + fails.length}\n` + fails.join('\n')); process.exit(1) }
console.log(`PASS ${pass}`)

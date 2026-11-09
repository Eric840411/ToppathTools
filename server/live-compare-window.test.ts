/**
 * Meter 固定窗口判定的回歸。跑法：npx tsx server/live-compare-window.test.ts
 * fixture：QAT 892-MOREPUFF-0134 13:00～16:00 真資料——GR 432 ＋ handpay 4 ＝ Meter 436。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  toBackendRounds, evaluateWindow, pickEvalSnapshot, chooseWindow, nextState, MIN_SNAPSHOT_AGE_MS, BOUNDARY_MAX_STREAK, BOUNDARY_SAME_SNAPSHOT_MAX_MS,
  type BackendRound,
} from './live-compare-window.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/live-compare/qat-1105-morepuff-window.json', import.meta.url)), 'utf8')) as {
  meter: { t0: number; t1: number; count: number; amount: number }; gameRecord: Record<string, unknown>[]; handpay: Record<string, unknown>[]
}
const gr0 = toBackendRounds(fx.gameRecord, 'gr') as { rounds: BackendRound[] }
const hp0 = toBackendRounds(fx.handpay, 'handpay') as { rounds: BackendRound[] }
eq('fixture GR 全收', gr0.rounds.length, 432)
eq('fixture handpay 全收', hp0.rounds.length, 6)
const W = { t0: fx.meter.t0, t1: fx.meter.t1, meter: { count: fx.meter.count, amount: fx.meter.amount } }
const run = (gr = gr0.rounds, hp = hp0.rounds, meter = W.meter) => evaluateWindow({ ...W, meter, gr, handpay: hp })

// ── 真資料：GR＋handpay＝Meter ──
const ok = run()
eq('真資料對上', ok.matched, true)
eq('GR 432', ok.backend.grCount, 432)
eq('窗口內 handpay 4 筆（前一天 2 筆被排除）', ok.backend.handpayCount, 4)
eq('handpay 注額 125', ok.backend.handpayBet, 125)
eq('handpay 金額 6,410', ok.backend.handpayAmount, 6410)
eq('合計 436／13,375', [ok.backend.count, ok.backend.amount], [436, 13375])

// ── 注入：每一條都要紅 ──
eq('不算 handpay → 對不上（差 4 局）', run(gr0.rounds, []).diff, { count: 4, amount: 125 })
eq('GR 漏一局 → 對不上', run(gr0.rounds.slice(1)).matched, false)
eq('同一單也進了 GR → 只算一次', run([...gr0.rounds, { ...hp0.rounds[0], source: 'gr' }]).backend.count, 436)
eq('分頁重複 → 單號去重', run([...gr0.rounds, ...gr0.rounds.slice(0, 5)]).matched, true)
eq('窗口外的局不算', run([...gr0.rounds, { ...gr0.rounds[0], orderId: 'x1', betAt: W.t1 + 1000, payoutAt: W.t1 + 2000 }]).matched, true)
{ // 邊界那一局：下注在 t1 之前、派彩在 t1 之後，Meter 沒算到——不能判對也不能判錯
  const edge = { ...gr0.rounds[0], orderId: 'edge', betAt: W.t1 - 1000, payoutAt: W.t1 + 3000, bet: 25 }
  const x = run([...gr0.rounds, edge])
  eq('邊界局：照下注時間多一局', x.backend.count, 437)
  eq('邊界局：不算一致', x.matched, false)
  eq('邊界局：標切點待確認', x.boundary, true)
}
{ // CodeX bfb0623 P1：同一局不能前一段照下注、後一段照派彩各算一次
  const r = { orderId: 'z', betAt: 5, payoutAt: 15, bet: 1, source: 'gr' as const, handpay: 0 }
  const a = evaluateWindow({ t0: 0, t1: 10, meter: { count: 1, amount: 1 }, gr: [r], handpay: [] })
  const b = evaluateWindow({ t0: 10, t1: 20, meter: { count: 1, amount: 1 }, gr: [r], handpay: [] })
  eq('前一段照下注時間對上', a.matched, true)
  eq('後一段不能再照派彩時間算一次', b.matched, false)
}
{ // CodeX ebfb687 P1：有邊界局 ≠ 差額是邊界局造成的（時間用毫秒：切點前後 1 秒是 Meter 精度範圍）
  const r = { orderId: 'z', betAt: 5_000, payoutAt: 15_000, bet: 1, source: 'gr' as const, handpay: 0 }
  const many = Array.from({ length: 50 }, (_, i) => ({ orderId: 'm' + i, betAt: 11_000 + i * 100, payoutAt: 11_050 + i * 100, bet: 1, source: 'gr' as const, handpay: 0 }))
  const big = evaluateWindow({ t0: 10_000, t1: 20_000, meter: { count: 150, amount: 150 }, gr: [r, ...many], handpay: [] })
  eq('跨 t0 一局、差 100 局 → 不是邊界', [big.matched, big.boundary], [false, false])
  const one = evaluateWindow({ t0: 10_000, t1: 20_000, meter: { count: 51, amount: 51 }, gr: [r, ...many], handpay: [], firstWindow: true })
  eq('第一個窗口：跨起點一局、差剛好那一局 → 一致（算進這段）', [one.matched, one.t0Absorbed], [true, 1])
  const later = evaluateWindow({ t0: 10_000, t1: 20_000, meter: { count: 51, amount: 51 }, gr: [r, ...many], handpay: [] })
  eq('之後的窗口：那局上一段算過，不能再吸收', later.matched, false)
  const amt = evaluateWindow({ t0: 10_000, t1: 20_000, meter: { count: 51, amount: 60 }, gr: [r, ...many], handpay: [] })
  eq('局數對得上但金額對不上 → 不能用邊界局解釋', [amt.matched, amt.boundary], [false, false])
}
{ // 2026-11-09 892-DRAGONLAW-0025 真資料：Meter upTime 只到整秒，13:57:18.01 下注的局 Meter 已算、照下注時間卻在窗口外
  const T0 = 1794203811000, T1 = 1794203838000
  const bets = [1794203808.15, 1794203815.42, 1794203818.76, 1794203825.16, 1794203828.48, 1794203834.68, 1794203838.01, 1794203846.07]
  const rs = bets.map((b, i) => ({ orderId: 'd' + i, betAt: b * 1000, payoutAt: b * 1000 + 3000, bet: 100, source: 'gr' as const, handpay: 0 }))
  const x = evaluateWindow({ t0: T0, t1: T1, meter: { count: 6, amount: 600 }, gr: rs, handpay: [] })
  eq('同秒晚下注：後台照下注時間 5 局', x.backend.count, 5)
  eq('同秒晚下注：不判一致、標切點待確認', [x.matched, x.boundary], [false, true])
  const lateGone = evaluateWindow({ t0: T0, t1: T1, meter: { count: 6, amount: 600 }, gr: rs.filter(r => r.orderId !== 'd6'), handpay: [] })
  eq('同秒那局後台真的沒有 → 仍是對不上（不是切點）', [lateGone.matched, lateGone.boundary], [false, false])
  const farLate = evaluateWindow({ t0: T0, t1: T1, meter: { count: 6, amount: 600 }, gr: rs.map(r => r.orderId === 'd6' ? { ...r, betAt: T1 + 1000 } : r), handpay: [] })
  eq('晚一整秒以上下注 → 不能拿來解釋', [farLate.matched, farLate.boundary], [false, false])
  const amt = evaluateWindow({ t0: T0, t1: T1, meter: { count: 6, amount: 650 }, gr: rs, handpay: [] })
  eq('同秒晚下注但金額對不上 → 不能拿來解釋', [amt.matched, amt.boundary], [false, false])
}
{ // CodeX 0730cf1 P1：起點後 10ms 下注、到終點還沒派彩——「起點已算」與「終點還沒算」都說得通，不能提前判一致
  const T0 = 1_000_000, T1 = T0 + 10_000
  const r = { orderId: 'ov', betAt: T0 + 10, payoutAt: T0 + 15_000, bet: 1, source: 'gr' as const, handpay: 0 }
  const x = evaluateWindow({ t0: T0, t1: T1, meter: { count: 0, amount: 0 }, gr: [r], handpay: [], firstWindow: true })
  eq('兩側都說得通 → 切點待確認、不判一致', [x.matched, x.boundary, x.t0SameSecond], [false, true, 0])
  const paid = evaluateWindow({ t0: T0, t1: T1, meter: { count: 0, amount: 0 }, gr: [{ ...r, payoutAt: T0 + 3000 }], handpay: [], firstWindow: true })
  eq('終點前已派彩、只有起點說得通 → 一致', [paid.matched, paid.t0SameSecond], [true, 1])
  const b = { orderId: 'b', betAt: T1 - 5000, payoutAt: T1 + 2000, bet: 1, source: 'gr' as const, handpay: 0 }
  const two = evaluateWindow({ t0: T0, t1: T1, meter: { count: 1, amount: 1 }, gr: [{ ...r, payoutAt: T0 + 3000 }, b], handpay: [], firstWindow: true })
  eq('起點一局、終點另一局都能解釋 → 切點待確認', [two.matched, two.boundary], [false, true])
}
{ // CodeX bfb0623 P2：同單 GR 與 handpay 注額不一致不能被蓋掉
  const h = { ...gr0.rounds[0], source: 'handpay' as const, bet: 999 }
  const x = run(gr0.rounds, [...hp0.rounds, h])
  eq('同單注額衝突 → 不一致', x.matched, false)
  eq('同單注額衝突 → 記一筆', x.conflicts, 1)
}
{ // 缺欄位整批不比
  const bad = JSON.parse(JSON.stringify(fx.gameRecord)); delete bad[0].bet_time_precise
  eq('缺下注時間 → 整批拒收', 'error' in toBackendRounds(bad, 'gr'), true)
  const bad2 = JSON.parse(JSON.stringify(fx.handpay)); bad2[0].bet = ''
  eq('handpay 缺注額 → 整批拒收', 'error' in toBackendRounds(bad2, 'handpay'), true)
}

// ── 快照要收到滿 3 分鐘才比 ──
const snap = (upTime: number, readAt: number) => ({ upTime, readAt, gamesPlayed: 0, coinIn: 0, denom: 1 })
const now = 10_000_000
eq('未滿 3 分鐘不比', pickEvalSnapshot([snap(9_000_000, now - 60_000)], 0, now), null)
eq('滿 3 分鐘取最新', pickEvalSnapshot([snap(8_000_000, now - 900_000), snap(9_000_000, now - MIN_SNAPSHOT_AGE_MS), snap(9_900_000, now - 10_000)], 0, now)?.upTime, 9_000_000)
eq('起點之前的不算', pickEvalSnapshot([snap(5, now - 900_000)], 5, now), null)

// ── 固定窗口：對不上就留在同一窗口；連兩次才逾期；補齊解除 ──
const e = snap(2_000, 0)
eq('第一次：取可比快照', chooseWindow(null, e), 2_000)
const s1 = nextState(null, 2_000, { matched: false })
eq('第一次對不上 → 待確認', s1.status, 'pending')
eq('對不上時不換窗口', chooseWindow(s1, snap(3_000, 0)), 2_000)
const s2 = nextState(s1, 2_000, { matched: false })
eq('同窗口第二次對不上 → 逾期待查', s2.status, 'overdue')
eq('逾期也不換窗口', chooseWindow(s2, snap(3_000, 0)), 2_000)
eq('補齊 → 解除', nextState(s2, 2_000, { matched: true }).status, 'match')
eq('對上後換新窗口', chooseWindow({ t1: 2_000, fails: 0, status: 'match' }, snap(3_000, 0)), 3_000)
eq('換窗口後失敗次數重算', nextState({ t1: 2_000, fails: 1, status: 'pending' }, 3_000, { matched: false }).fails, 1)
eq('查詢不完整不算失敗', nextState(s1, 2_000, null), s1)
const sb = nextState(s1, 2_000, { matched: false, boundary: true })
eq('切點卡到進行中的局 → 不算失敗', [sb.status, sb.fails], ['boundary', 0])
eq('切點待確認 → 換更新的快照', chooseWindow(sb, snap(3_000, 0)), 3_000)
eq('切點待確認、沒有更新快照 → 留著', chooseWindow(sb, snap(1_500, 0)), 2_000)

{ // CodeX 0730cf1 P2：streak 只算不同快照；同一個快照卡住改用時間上限
  const t = 5_000_000
  let st = nextState(null, t, { matched: false, boundary: true }, { streak: 0, streakT1: null }, t + 4 * 60_000)
  for (let i = 0; i < 8; i++) st = nextState(st, t, { matched: false, boundary: true }, { streak: st.streak!, streakT1: st.streakT1! }, t + 5 * 60_000)
  eq('同一個快照重查 8 次 → 仍是 1 次、不逾期', [st.status, st.streak], ['boundary', 1])
  st = nextState(st, t, { matched: false, boundary: true }, { streak: st.streak!, streakT1: st.streakT1! }, t + BOUNDARY_SAME_SNAPSHOT_MAX_MS + 1)
  eq('同一個快照卡超過時間上限 → 逾期待查', st.status, 'overdue')
  let s2 = nextState(null, 1, { matched: false, boundary: true }, { streak: 0, streakT1: null }, 2)
  for (let k = 2; k <= BOUNDARY_MAX_STREAK; k++) s2 = nextState(s2, k, { matched: false, boundary: true }, { streak: s2.streak!, streakT1: s2.streakT1! }, k + 1)
  eq(`不同快照連 ${BOUNDARY_MAX_STREAK} 次 → 逾期待查`, [s2.status, s2.streak], ['overdue', BOUNDARY_MAX_STREAK])
}

console.log(`live-compare-window: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }

/**
 * Meter 固定窗口判定的回歸。跑法：npx tsx server/live-compare-window.test.ts
 * fixture：QAT 892-MOREPUFF-0134 13:00～16:00 真資料——GR 432 ＋ handpay 4 ＝ Meter 436。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  toBackendRounds, evaluateWindow, pickEvalSnapshot, chooseWindow, nextState, MIN_SNAPSHOT_AGE_MS,
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
{ // 邊界那一局：下注在 t1 之前、派彩在 t1 之後——Meter 若照派彩算也要對得上
  const edge = { ...gr0.rounds[0], orderId: 'edge', betAt: W.t1 - 1000, payoutAt: W.t1 + 3000, bet: 25 }
  const x = run([...gr0.rounds, edge])
  eq('邊界局：照下注時間多一局', x.backend.count, 437)
  eq('邊界局：照派彩時間對上', x.matchedBy, 'payout')
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

console.log(`live-compare-window: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }

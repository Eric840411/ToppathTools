/**
 * 「局數按派彩時間、金額按下注時間」機種（SPLIT_TIMING_TYPES）的回歸。跑法：npx tsx server/live-compare-window-split.test.ts
 * fixture：QAT 873-SQUIDGAME-1199 2026-11-10 真資料——54 個 Instant Meter 快照＋同時段全部玩家 48 局。
 * 用記憶體 DB 跑真正的多輪輪詢（evalMeterWindow），假後台照真 API 的行為用**派彩時間**篩（dateTimeType=0）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { ensureWindowTables, evalMeterWindow, type BackendFetcher } from './live-compare-window-store.js'
import { toBackendRounds, evaluateWindow, isSplitTiming, MIN_SNAPSHOT_AGE_MS, OVERDUE_FAILS, type BackendRound } from './live-compare-window.js'
import type { MeterReading } from './live-compare-core.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/live-compare/qat-1110-squidgame-split-timing.json', import.meta.url)), 'utf8')) as {
  gmid: string; snaps: Array<{ upTime: number; gamesPlayed: number; coinIn: number; denom: number }>; rounds: Record<string, unknown>[]
}
const parsed = toBackendRounds(fx.rounds, 'gr') as { rounds: BackendRound[] }
const ROUNDS = parsed.rounds
const SNAPS = fx.snaps
const S0 = SNAPS[0]
eq('fixture 48 局全收、都有派彩時間', [ROUNDS.length, ROUNDS.every(r => r.payoutAt != null)], [48, true])
eq('fixture 55 個快照', SNAPS.length, 55)

// ── 機種判斷 ──
eq('SQUIDGAME 分開計時', isSplitTiming('873-SQUIDGAME-1199'), true)
eq('DRAGONLAW（GCP）維持原規則', isSplitTiming('892-DRAGONLAW-0025'), false)
eq('格式不對不套用', isSplitTiming('SQUIDGAME'), false)

// ── 缺派彩時間不能拿下注時間代填 ──
{
  const r = toBackendRounds([{ order_id: 'x', bet_time_precise: 100.5, bet: 1000 }], 'gr') as { rounds: BackendRound[] }
  eq('缺 payout_precise → payoutAt＝null（不代填）', r.rounds[0].payoutAt, null)
}

interface Opts { gmid?: string; rounds?: BackendRound[]; handpay?: BackendRound[]; skewMs?: number; delayMs?: number; failAt?: number }
/**
 * 依序把每個快照當成新讀到的 Meter，在它收到滿 3 分鐘時輪詢一次。
 * skewMs＝本機時鐘比後台慢多少（readAt／now 用本機時鐘，upTime／下注／派彩用後台時間）。
 * delayMs＝Game Record 派彩後多久才查得到（真正的入帳延遲）。
 */
async function replay(o: Opts = {}) {
  const db = new Database(':memory:')
  ensureWindowTables(db)
  const rounds = o.rounds ?? ROUNDS, skew = o.skewMs ?? 0, delay = o.delayMs ?? 0
  const calls: Array<[number, number]> = []
  let backendNow = 0
  const fetcher: BackendFetcher = async (_n, _g, from, to, by = 'payout') => {
    if (by === 'payout') calls.push([from, to])
    // 真 API：dateTimeType=0 用派彩時間查、1 用下注時間查；還沒入帳（派彩後未滿 delay）的局都查不到
    const gr = rounds.filter(r => r.payoutAt != null && r.payoutAt + delay <= backendNow
      && (by === 'bet' ? r.betAt >= from && r.betAt <= to : r.payoutAt >= from && r.payoutAt <= to))
    return { gr, handpay: o.handpay ?? [] }
  }
  const base = { t0: S0.upTime, gamesPlayed: S0.gamesPlayed, coinIn: S0.coinIn, denom: S0.denom }
  const out: Array<{ t0: number; t1: number | null; status: string; error?: string; okCount: number; okAmount: number; diff: unknown }> = []
  const poll = async (s: typeof S0, backendT: number) => {
    backendNow = backendT
    const now = backendT - skew
    const reading: MeterReading = { upTime: s.upTime, gamesPlayed: s.gamesPlayed, coinIn: s.coinIn, denom: s.denom, useCache: false, cacheHourStr: '' }
    const r = await evalMeterWindow(db, { sessionId: 's', gmid: o.gmid ?? fx.gmid, clientMachineName: 'Squid Game - 1199', base, reading, readAt: s.upTime - skew }, fetcher, now)
    out.push({ t0: r.win.tStart, t1: r.win.t1, status: r.win.status, error: r.error, okCount: r.win.okCount, okAmount: r.win.okAmount, diff: r.win.diff })
  }
  for (let i = 0; i < SNAPS.length; i++) {
    if (o.failAt === i) continue
    await poll(SNAPS[i], SNAPS[i].upTime + MIN_SNAPSHOT_AGE_MS + 1000)
  }
  // 最後再輪幾次，讓卡住的窗口有機會重查
  const last = SNAPS.at(-1)!
  for (let k = 1; k <= 3; k++) await poll(last, last.upTime + MIN_SNAPSHOT_AGE_MS + 1000 + k * 30_000)
  return { out, calls }
}

const LAST = SNAPS.at(-1)!
const totalGp = LAST.gamesPlayed - S0.gamesPlayed
const totalAmt = Math.round((LAST.coinIn - S0.coinIn) * S0.denom * 100) / 100

{ // 真資料逐段接續：每段都一致，累計＝整段 Meter 增量（每局局數與金額各只算一次）
  const { out } = await replay()
  const bad = out.filter(x => x.t1 != null && x.status !== 'match')
  eq('真資料 54 段每段都一致', bad.length, 0)
  eq('累計局數＝Meter 整段增量', out.at(-1)!.okCount, totalGp)
  eq('累計金額＝Meter 整段增量', out.at(-1)!.okAmount, totalAmt)
  eq('最後一段停在最後一個快照', out.at(-1)!.t1, LAST.upTime)
}

{ // 防線有效：同一份資料用舊規則（局數也按下注時間）會卡住——這條沒紅代表上面那條沒在驗東西
  const { out } = await replay({ gmid: '873-OTHERTYPE-1199' })
  eq('舊規則在同一份資料上對不上', out.some(x => x.status === 'overdue'), true)
}

{ // 92 秒長局（14:55:46 下注、14:57:18 派彩）跨過切點：金額在下注那段、局數在派彩那段
  const long = ROUNDS.find(r => r.payoutAt! - r.betAt > 60_000)!
  eq('fixture 有長局', !!long, true)
  const cutInside = SNAPS.filter(s => s.upTime >= long.betAt && s.upTime < long.payoutAt!)
  eq('長局進行中有快照切過', cutInside.length > 0, true)
  const c = cutInside[0], prev = SNAPS[SNAPS.indexOf(c) - 1], next = SNAPS.find(s => s.upTime >= long.payoutAt!)!
  const win = (a: typeof S0, b: typeof S0) => evaluateWindow({
    t0: a.upTime, t1: b.upTime, gr: ROUNDS, handpay: [], split: true,
    meter: { count: b.gamesPlayed - a.gamesPlayed, amount: Math.round((b.coinIn - a.coinIn) * a.denom * 100) / 100 },
  })
  eq('下注那段（局數還沒加）一致', win(prev, c).matched, true)
  eq('派彩那段（長局起點在切點前）一致', win(c, next).matched, true)
  const old = evaluateWindow({ t0: prev.upTime, t1: c.upTime, gr: ROUNDS, handpay: [], meter: { count: c.gamesPlayed - prev.gamesPlayed, amount: Math.round((c.coinIn - prev.coinIn) * prev.denom * 100) / 100 } })
  eq('同一段用舊規則對不上', old.matched, false)
}

{ // 本機時鐘慢 160 秒：查詢範圍跟窗口都用後台時間，結果不變
  const { out, calls } = await replay({ skewMs: 160_000 })
  eq('時鐘慢 160 秒仍每段一致', out.filter(x => x.t1 != null && x.status !== 'match').length, 0)
  eq('查詢範圍用 Meter 時間（起點前 60 秒～終點後 300 秒）', calls[0], [S0.upTime - 60_000, SNAPS[1].upTime + 300_000])
}

{ // 真正的入帳延遲：派彩後 4 分鐘才查得到 → 先待確認、補齊後一致，不能假綠也不能一直卡
  const { out } = await replay({ delayMs: 4 * 60_000 })
  eq('入帳延遲時先待確認', out.some(x => x.status === 'pending'), true)
  eq('入帳延遲不會假一致（待確認那幾段差額不是 0）', out.filter(x => x.status === 'pending').every(x => JSON.stringify(x.diff) !== JSON.stringify({ count: 0, amount: 0 })), true)
}

{ // 真漏一局（窗口中間、離切點遠）：不能被當成切點問題
  const mid = ROUNDS.find(r => SNAPS.every(s => Math.abs(s.upTime - r.betAt) > 3000 && Math.abs(s.upTime - r.payoutAt!) > 3000))!
  const { out } = await replay({ rounds: ROUNDS.filter(r => r !== mid) })
  eq('真漏局 → 逾期待查', out.some(x => x.status === 'overdue'), true)
  eq('真漏局不會判成切點待確認', out.some(x => x.status === 'boundary'), false)
}

{ // 注額錯（後台記成 2 倍）
  const victim = ROUNDS[10]
  const { out } = await replay({ rounds: ROUNDS.map(r => r === victim ? { ...r, bet: r.bet * 2 } : r) })
  eq('注額錯 → 逾期待查', out.some(x => x.status === 'overdue'), true)
}

{ // 缺派彩時間：整輪不比、不算失敗、不能判一致
  const victim = ROUNDS[5]
  const noPay = ROUNDS.map(r => r === victim ? { ...r, payoutAt: null } : r)
  const db = new Database(':memory:'); ensureWindowTables(db)
  const fetcher: BackendFetcher = async () => ({ gr: noPay, handpay: [] })
  const s = SNAPS[3]
  const r = await evalMeterWindow(db, { sessionId: 's', gmid: fx.gmid, clientMachineName: 'M', base: { t0: S0.upTime, gamesPlayed: S0.gamesPlayed, coinIn: S0.coinIn, denom: S0.denom }, reading: { upTime: s.upTime, gamesPlayed: s.gamesPlayed, coinIn: s.coinIn, denom: s.denom, useCache: false, cacheHourStr: '' }, readAt: s.upTime }, fetcher, s.upTime + MIN_SNAPSHOT_AGE_MS + 1)
  eq('缺派彩時間 → 不比、說明原因', [r.win.status, r.win.fails, /派彩時間/.test(r.error ?? '')], ['pending', 0, true])
}

{ // 窗口附近有 handpay：這台還沒有 handpay 樣本，不比
  const hp: BackendRound = { orderId: 'hp1', betAt: SNAPS[2].upTime - 5000, payoutAt: null, bet: 1000, source: 'handpay', handpay: 50000 }
  const { out } = await replay({ handpay: [hp] })
  eq('附近有 handpay → 不比、說明原因', out.some(x => /handpay/.test(x.error ?? '')), true)
  eq('附近有 handpay 不會判一致或逾期', out.filter(x => /handpay/.test(x.error ?? '')).every(x => x.status === 'pending'), true)
  const far: BackendRound = { ...hp, betAt: S0.upTime - 24 * 3_600_000, payoutAt: S0.upTime - 24 * 3_600_000 + 60_000 }
  const { out: o2 } = await replay({ handpay: [far] })
  eq('一天前的 handpay 不影響', o2.filter(x => x.t1 != null && x.status !== 'match').length, 0)
}

{ // 切點精度：恰在終點那一秒派彩的局，Meter 可能還沒算 → 只能切點待確認，不能判一致
  const t0 = 1_000_000_000, t1 = t0 + 30_000
  const rs: BackendRound[] = [
    { orderId: 'a', betAt: t0 + 5_000, payoutAt: t0 + 8_000, bet: 1000, source: 'gr', handpay: 0 },
    { orderId: 'b', betAt: t1 - 3_000, payoutAt: t1, bet: 1000, source: 'gr', handpay: 0 },
  ]
  const r = evaluateWindow({ t0, t1, gr: rs, handpay: [], split: true, meter: { count: 1, amount: 2000 } })
  eq('終點同一秒派彩、Meter 少 1 局 → 切點待確認', [r.matched, r.boundary, r.timing], [false, true, 'split'])
  const r2 = evaluateWindow({ t0, t1, gr: rs, handpay: [], split: true, meter: { count: 0, amount: 2000 } })
  eq('差 2 局只有 1 局在切點 → 不是切點問題', [r2.matched, r2.boundary], [false, false])
  const r3 = evaluateWindow({ t0, t1, gr: rs, handpay: [], split: true, meter: { count: 1, amount: 1000 } })
  eq('局數金額都差、但金額差的那局不在切點 → 不是切點問題', [r3.matched, r3.boundary], [false, false])
  // 起點同一秒派彩的局：只有第一個窗口能拿來解釋；之後的起點是上一段對上的切點，那局上一段已經算過
  const atT0: BackendRound = { orderId: 'c', betAt: t0 - 4_000, payoutAt: t0 + 400, bet: 1000, source: 'gr', handpay: 0 }
  const rs4 = [atT0, rs[0]]
  const meter4 = { count: 2, amount: 1000 }   // Meter 這段把起點那秒派彩的局也算進來
  eq('第一個窗口：起點同一秒派彩 → 切點待確認', evaluateWindow({ t0, t1, gr: rs4, handpay: [], split: true, firstWindow: true, meter: meter4 }).boundary, true)
  eq('之後的窗口：起點那局上一段算過 → 不是切點問題', evaluateWindow({ t0, t1, gr: rs4, handpay: [], split: true, firstWindow: false, meter: meter4 }).boundary, false)
}

{ // CodeX 9dcb14c P1：窗口內下注、10 分鐘後才派彩的長局——只按派彩時間查永遠查不到，金額會一直少
  const MIN = 60_000, T0 = 1_800_000_000_000
  const rs: BackendRound[] = [
    { orderId: 'a', betAt: T0 + 5_000, payoutAt: T0 + 8_000, bet: 1000, source: 'gr', handpay: 0 },
    { orderId: 'long', betAt: T0 + 20_000, payoutAt: T0 + 30_000 + 10 * MIN, bet: 1000, source: 'gr', handpay: 0 },
  ]
  const db = new Database(':memory:'); ensureWindowTables(db)
  const fetcher: BackendFetcher = async (_n, _g, from, to, by = 'payout') => ({
    gr: rs.filter(r => by === 'bet' ? r.betAt >= from && r.betAt <= to : r.payoutAt! >= from && r.payoutAt! <= to), handpay: [],
  })
  const base = { t0: T0, gamesPlayed: 100, coinIn: 0, denom: 1 }
  const t1 = T0 + 30_000
  // Meter：(T0, T0+30s] 已下注 2 局（Coin 2,000），只派彩 1 局（GP +1）
  const now = t1 + 12 * MIN   // 長局已經派彩、Game Record 查得到
  const r = await evalMeterWindow(db, { sessionId: 's', gmid: '873-SQUIDGAME-1199', clientMachineName: 'M', base, reading: { upTime: t1, gamesPlayed: 101, coinIn: 2000, denom: 1, useCache: false, cacheHourStr: '' }, readAt: t1 }, fetcher, now)
  eq('長局 10 分鐘後才派彩：下注那段金額照樣算到 → 一致', [r.win.status, r.win.diff], ['match', { count: 0, amount: 0 }])
}

{ // CodeX 9dcb14c P1：handpay 早於防護範圍下注、在窗口內派彩——不能被漏掉當成一般局算進去
  const t0 = SNAPS[3].upTime
  const hp: BackendRound = { orderId: 'hpEarly', betAt: t0 - 11 * 60_000, payoutAt: t0 + 10_000, bet: 1000, source: 'handpay', handpay: 50000 }
  const { out } = await replay({ handpay: [hp] })
  eq('早下注、窗口內派彩的 handpay → 不比', out.some(x => /handpay/.test(x.error ?? '')), true)
  eq('早下注 handpay 不會判一致到它那段', out.filter(x => x.t1 != null && x.t1 > t0 && x.t1 < t0 + 5 * 60_000).every(x => x.status !== 'match'), true)
  // CodeX 的重現：Meter 把這局算進窗口——沒擋住就會假一致（GR=1、handpay=0）
  const T0 = 1_800_000_000_000, t1 = T0 + 30_000
  const hp2: BackendRound = { orderId: 'hp2', betAt: T0 - 11 * 60_000, payoutAt: T0 + 10_000, bet: 1000, source: 'handpay', handpay: 50000 }
  const db = new Database(':memory:'); ensureWindowTables(db)
  const f2: BackendFetcher = async () => ({ gr: [], handpay: [hp2] })
  const r = await evalMeterWindow(db, { sessionId: 's', gmid: '873-SQUIDGAME-1199', clientMachineName: 'M', base: { t0: T0, gamesPlayed: 100, coinIn: 0, denom: 1 }, reading: { upTime: t1, gamesPlayed: 101, coinIn: 0, denom: 1, useCache: false, cacheHourStr: '' }, readAt: t1 }, f2, t1 + 4 * 60_000)
  eq('Meter 算進窗口的早下注 handpay → 不比、不能假一致', [r.win.status, /handpay/.test(('error' in r ? r.error : '') ?? '')], ['pending', true])
  const noPay: BackendRound = { ...hp, orderId: 'hpNoPay', betAt: S0.upTime - 60 * 60_000, payoutAt: null }
  const { out: o2 } = await replay({ handpay: [noPay] })
  eq('沒有派彩時間的 handpay（不知道何時結束）→ 不比', o2.filter(x => x.t1 != null).every(x => /handpay/.test(x.error ?? '')), true)
}

eq('OVERDUE_FAILS 仍是 2（上面的逾期判斷依賴它）', OVERDUE_FAILS, 2)

console.log(`live-compare-window-split: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }

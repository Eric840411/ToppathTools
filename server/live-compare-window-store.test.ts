/**
 * Meter 固定窗口「多輪輪詢」的回歸（記憶體 DB、假後台、控制時間）。跑法：npx tsx server/live-compare-window-store.test.ts
 * 驗的是串接：快照未滿 3 分鐘不比 → 比第一個窗口 → 對上後接續下一個窗口 → 對不上留在同窗口 → 連兩次逾期 → 補齊解除；
 * 查詢失敗不算一次失敗；已對上的窗口不重查。
 */
import Database from 'better-sqlite3'
import { ensureWindowTables, evalMeterWindow, type BackendFetcher } from './live-compare-window-store.js'
import type { BackendRound } from './live-compare-window.js'
import type { MeterReading } from './live-compare-core.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const db = new Database(':memory:')
ensureWindowTables(db)
const MIN = 60_000
const T0 = 1_000 * MIN
const base = { t0: T0, gamesPlayed: 100, coinIn: 5000, denom: 0.01 }
const reading = (upTime: number, gp: number, coinIn: number): MeterReading => ({ upTime, gamesPlayed: gp, coinIn, denom: 0.01, useCache: false, cacheHourStr: '' })
/** 每分鐘一局、注額 1（Coin In ×Denom＝1 → coinIn 每局 +100） */
const round = (i: number): BackendRound => ({ orderId: `o${i}`, betAt: T0 + i * MIN - 30_000, payoutAt: T0 + i * MIN - 25_000, bet: 1, source: 'gr', handpay: 0 })
let backend: BackendRound[] = []
let fail: string | null = null
const calls: Array<[number, number]> = []
const fetcher: BackendFetcher = async (_n, _g, from, to) => { calls.push([from, to]); return fail ? { error: fail } : { gr: backend.filter(r => r.betAt >= from && r.betAt <= to), handpay: [] } }
const poll = async (now: number, up: number, gp: number, ci: number) =>
  evalMeterWindow(db, { sessionId: 's', gmid: 'g', clientMachineName: 'M', base, reading: reading(up, gp, ci), readAt: now }, fetcher, now)

// 第 1 輪：快照剛收到，不比
let r = await poll(T0 + 5 * MIN, T0 + 5 * MIN, 105, 5500)
eq('快照未滿 3 分鐘 → 沒有窗口', r.win.t1, null)
eq('未滿 3 分鐘不查後台', calls.length, 0)

// 第 2 輪（4 分鐘後）：第一個快照可比，後台 5 局全到
backend = [1, 2, 3, 4, 5].map(round)
r = await poll(T0 + 9 * MIN, T0 + 9 * MIN, 109, 5900)
eq('第一個窗口＝(t0, 5 分]', [r.win.tStart, r.win.t1], [T0, T0 + 5 * MIN])
eq('Meter 增量 5 局／5', r.win.meter, { count: 5, amount: 5 })
eq('後台全到 → 一致', r.win.status, 'match')

// 第 3 輪：沒有更新的可比快照 → 沿用結果、不重查
const n3 = calls.length
r = await poll(T0 + 10 * MIN, T0 + 9 * MIN, 109, 5900)
eq('已對上的窗口不重查', calls.length, n3)
eq('沿用一致', r.win.status, 'match')

// 第 4 輪（9 分快照滿 3 分鐘）：接續下一個窗口 (5, 9]，後台少了第 8 局
backend = [1, 2, 3, 4, 5, 6, 7, 9].map(round)
r = await poll(T0 + 13 * MIN, T0 + 13 * MIN, 113, 6300)
eq('接續窗口 (5, 9]', [r.win.tStart, r.win.t1], [T0 + 5 * MIN, T0 + 9 * MIN])
eq('之前對上的 5 局累計', r.win.okCount, 5)
eq('漏一局 → 待確認', [r.win.status, r.win.diff?.count], ['pending', 1])
eq('只查新窗口那段', calls.at(-1)![0], T0 + 5 * MIN - 60_000)

// 第 5 輪：有更新的快照也不能換窗口，同窗口第二次 → 逾期
r = await poll(T0 + 17 * MIN, T0 + 17 * MIN, 117, 6700)
eq('對不上時留在同一窗口', r.win.t1, T0 + 9 * MIN)
eq('同窗口第二次 → 逾期待查', r.win.status, 'overdue')

// 第 6 輪：查詢失敗 → 不算一次失敗、維持逾期
fail = 'Game Record 回 code=500'
r = await poll(T0 + 18 * MIN, T0 + 18 * MIN, 118, 6800)
eq('查詢失敗回錯誤', 'error' in r, true)
eq('查詢失敗不改狀態', [r.win.status, r.win.fails], ['overdue', 2])

// 第 7 輪：第 8 局補進來 → 解除
fail = null
backend = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(round)
r = await poll(T0 + 19 * MIN, T0 + 19 * MIN, 119, 6900)
eq('補齊 → 解除', r.win.status, 'match')

// 第 8 輪：解除後往前接續
backend = Array.from({ length: 19 }, (_, i) => round(i + 1))
r = await poll(T0 + 22 * MIN, T0 + 22 * MIN, 122, 7200)
eq('解除後接續到最新可比快照', r.win.tStart, T0 + 9 * MIN)
eq('累計 9 局', r.win.okCount, 9)

// ── CodeX ebfb687 P1：一局跨起點不能讓大量差額永遠停在待確認 ──
{
  const db2 = new Database(':memory:'); ensureWindowTables(db2)
  const b2 = { t0: T0, gamesPlayed: 0, coinIn: 0, denom: 1 }
  const straddle: BackendRound = { orderId: 'st', betAt: T0 - 1000, payoutAt: T0 + 5000, bet: 1, source: 'gr', handpay: 0 }
  const f2: BackendFetcher = async () => ({ gr: [straddle], handpay: [] })
  const p2 = (now: number, gp: number) => evalMeterWindow(db2, { sessionId: 's', gmid: 'g', clientMachineName: 'M', base: b2, reading: { upTime: now, gamesPlayed: gp, coinIn: gp, denom: 1, useCache: false, cacheHourStr: '' }, readAt: now }, f2, now)
  await p2(T0 + MIN, 100)
  let x = await p2(T0 + 5 * MIN, 200)
  eq('差 100 局 → 待確認（不是切點）', x.win.status, 'pending')
  x = await p2(T0 + 6 * MIN, 300)
  eq('同窗口第二次 → 逾期待查', x.win.status, 'overdue')
}

// ── CodeX 1109 P1：真漏一局、每個新切點後同一秒剛好都有同注額的局 → 不能永遠當切點問題 ──
{
  const db3 = new Database(':memory:'); ensureWindowTables(db3)
  const b3 = { t0: T0, gamesPlayed: 0, coinIn: 0, denom: 1 }
  const all3: BackendRound[] = []
  for (let k = 1; k <= 40; k++) {
    all3.push({ orderId: `late${k}`, betAt: T0 + k * MIN + 10, payoutAt: T0 + k * MIN + 3000, bet: 1, source: 'gr', handpay: 0 })
    all3.push({ orderId: `mid${k}`, betAt: T0 + k * MIN + 30_000, payoutAt: T0 + k * MIN + 33_000, bet: 1, source: 'gr', handpay: 0 })
  }
  let missing = 'mid2'
  const f3: BackendFetcher = async (_n, _g, from, to) => ({ gr: all3.filter(r => r.orderId !== missing && r.betAt >= from && r.betAt <= to), handpay: [] })
  const gpAt = (up: number) => all3.filter(r => r.betAt <= up).length   // Meter 沒算到切點後那幾毫秒的局
  const p3 = (now: number) => evalMeterWindow(db3, { sessionId: 's', gmid: 'g', clientMachineName: 'M', base: b3, reading: { upTime: now, gamesPlayed: gpAt(now), coinIn: gpAt(now), denom: 1, useCache: false, cacheHourStr: '' }, readAt: now }, f3, now)
  const seq: string[] = []
  let x = await p3(T0 + MIN)
  for (let k = 2; k <= 14; k++) { x = await p3(T0 + k * MIN); seq.push(x.win.status) }
  eq('真漏一局：切點待確認最多連 4 次，第 5 次逾期待查', seq.filter(st => st === 'boundary').length, 4)
  eq('真漏一局：最後停在逾期待查', x.win.status, 'overdue')
  const stuckAt = x.win.t1
  x = await p3(T0 + 15 * MIN)
  eq('逾期後不再往前換窗口', [x.win.status, x.win.t1], ['overdue', stuckAt])
  eq('逾期原因是切點連續待確認', x.win.streak >= 5, true)
  missing = ''
  x = await p3(T0 + 16 * MIN)
  eq('漏的那局補進來 → 解除', [x.win.status, x.win.streak], ['match', 0])
}

// ── CodeX 1109 P2：第一個窗口，起點快照已經算到 t0 後 10ms 下注的局 ──
{
  const db4 = new Database(':memory:'); ensureWindowTables(db4)
  const rs: BackendRound[] = [10, 20_000, 40_000].map((d, i) => ({ orderId: `f${i}`, betAt: T0 + d, payoutAt: T0 + d + 3000, bet: 1, source: 'gr', handpay: 0 }))
  const b4 = { t0: T0, gamesPlayed: 1, coinIn: 1, denom: 1 }   // 起點快照已含 T0+10ms 那局
  const f4: BackendFetcher = async () => ({ gr: rs, handpay: [] })
  const p4 = (now: number, gp: number) => evalMeterWindow(db4, { sessionId: 's', gmid: 'g', clientMachineName: 'M', base: b4, reading: { upTime: now, gamesPlayed: gp, coinIn: gp, denom: 1, useCache: false, cacheHourStr: '' }, readAt: now }, f4, now)
  await p4(T0 + MIN, 3)
  const x = await p4(T0 + 4 * MIN, 3)
  eq('起點同一秒內的局 → 第一窗一致', [x.win.status, x.win.t0SameSecond], ['match', 1])
}

// ── CodeX 0730cf1 P1：起點後 10ms 下注、第一個切點時還沒派彩（Meter 還沒算）→ 不能提前判一致把差額推到下一段 ──
{
  const db5 = new Database(':memory:'); ensureWindowTables(db5)
  const rs: BackendRound[] = [{ orderId: 'ov', betAt: T0 + 10, payoutAt: T0 + 15_000, bet: 1, source: 'gr', handpay: 0 }]
  const b5 = { t0: T0, gamesPlayed: 0, coinIn: 0, denom: 1 }
  const f5: BackendFetcher = async () => ({ gr: rs, handpay: [] })
  const p5 = (now: number, up: number, gp: number) => evalMeterWindow(db5, { sessionId: 's', gmid: 'g', clientMachineName: 'M', base: b5, reading: { upTime: up, gamesPlayed: gp, coinIn: gp, denom: 1, useCache: false, cacheHourStr: '' }, readAt: now }, f5, now)
  await p5(T0 + 10_000, T0 + 10_000, 0)        // 切點 t0+10 秒：那局還沒派彩，Meter 0
  await p5(T0 + 70_000, T0 + 70_000, 1)        // 下一個快照：Meter 算到了
  let x = await p5(T0 + 4 * MIN, T0 + 4 * MIN, 1)
  eq('第一個切點：兩側都說得通 → 切點待確認、起點不動', [x.win.status, x.win.tStart], ['boundary', T0])
  x = await p5(T0 + 5 * MIN, T0 + 5 * MIN, 1)
  eq('換下一個快照 → 一致', [x.win.status, x.win.tStart, x.win.meter?.count], ['match', T0, 1])
  x = await p5(T0 + 9 * MIN, T0 + 9 * MIN, 1)
  eq('之後那段不會多出一局', [x.win.status, x.win.diff?.count ?? 0], ['match', 0])
}

// ── CodeX be8d88b P1：真漏一局、每個新快照第一次查詢都失敗（先存成 pending）→ 重試成功判切點待確認時也要計入 ──
{
  const db6 = new Database(':memory:'); ensureWindowTables(db6)
  const b6 = { t0: T0, gamesPlayed: 0, coinIn: 0, denom: 1 }
  const all6: BackendRound[] = []
  for (let k = 1; k <= 60; k++) {
    all6.push({ orderId: `late${k}`, betAt: T0 + k * MIN + 10, payoutAt: T0 + k * MIN + 3000, bet: 1, source: 'gr', handpay: 0 })
    all6.push({ orderId: `mid${k}`, betAt: T0 + k * MIN + 30_000, payoutAt: T0 + k * MIN + 33_000, bet: 1, source: 'gr', handpay: 0 })
  }
  const seenTo = new Set<number>()
  const f6: BackendFetcher = async (_n, _g, from, to) => {
    if (!seenTo.has(to)) { seenTo.add(to); return { error: 'Game Record 回 code=500' } }
    return { gr: all6.filter(r => r.orderId !== 'mid2' && r.betAt >= from && r.betAt <= to), handpay: [] }
  }
  const gpAt = (up: number) => all6.filter(r => r.betAt <= up).length
  const p6 = (now: number, up: number) => evalMeterWindow(db6, { sessionId: 's', gmid: 'g', clientMachineName: 'M', base: b6, reading: { upTime: up, gamesPlayed: gpAt(up), coinIn: gpAt(up), denom: 1, useCache: false, cacheHourStr: '' }, readAt: now }, f6, now)
  // 每分鐘一個快照、每 30 秒輪詢一次：新快照第一次查詢失敗、30 秒後重試成功
  const boundaryT1 = new Set<number>()
  let x = await p6(T0 + MIN, T0 + MIN)
  for (let i = 3; i <= 60; i++) {
    const now = T0 + i * 30_000
    x = await p6(now, T0 + Math.floor(i / 2) * MIN)
    if (x.win.status === 'boundary' && x.win.t1 != null) boundaryT1.add(x.win.t1)
    if (x.win.status === 'overdue') break
  }
  eq('新快照先失敗再重試：第 5 個不同快照逾期待查', [x.win.status, x.win.streak], ['overdue', 5])
  eq('逾期前切點待確認的不同快照 4 個', boundaryT1.size, 4)
}

console.log(`live-compare-window-store: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }

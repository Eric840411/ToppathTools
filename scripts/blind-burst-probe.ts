// runBlindBurst 探針（2026-09-30，CodeX 要求用模擬驗證停止條件，不在實機花到上限）：npx tsx scripts/blind-burst-probe.ts
// 每個案例都用假時鐘＋假餘額，檢查：何時停（halt 原因）、總共真的送出幾下（sent）。
import { runBlindBurst, blindBudget, extraSpinDecision, noteBlindDebit, type BlindBurstState } from '../server/machine-test/verdicts.js'

type Opt = {
  presses?: number; bal0?: number | null; balAfter?: (sent: number) => number | null
  stopAt?: number; deadlineAt?: number; handpayAt?: number; maxPresses?: number
  spinCost?: number; maxSpend?: number; burstMs?: number
}
async function sim(o: Opt) {
  let t = 0, sent = 0
  const state: BlindBurstState = { presses: o.presses ?? 0, bal0: o.bal0 === undefined ? undefined : o.bal0 }
  const bal = o.balAfter ?? (n => 2_000_000 - n * 7_000)
  const r = await runBlindBurst({
    state, maxPresses: o.maxPresses ?? 96, maxSpend: o.maxSpend ?? 100_000, spinCost: o.spinCost ?? 10_000, burstMs: o.burstMs ?? 60_000, intervalMs: 5000,
    now: () => t, sleep: async ms => { t += ms },
    isStopped: () => o.stopAt !== undefined && sent >= o.stopAt,
    deadlineExceeded: () => o.deadlineAt !== undefined && sent >= o.deadlineAt,
    bodyText: async () => (o.handpayAt !== undefined && sent >= o.handpayAt ? 'HAND PAY — call attendant' : 'PRESS PLAY TO SPIN'),
    readBalance: async () => bal(sent),
    press: async () => { sent++ },
  })
  return { halt: r.halt ?? '-', sent, presses: state.presses }
}
const has = (h: string, s: string) => (h.includes(s) ? s : `✗「${h}」`)

const cases: Array<[string, () => Promise<string>, string]> = [
  ['一般一輪：60 秒每 5 秒一下＝12 下、不停', async () => { const r = await sim({}); return `${r.halt}/${r.sent}` }, '-/12'],
  ['第 97 下不會送出（已累計 90，再推 6 下停）', async () => { const r = await sim({ presses: 90 }); return `${has(r.halt, '單台上限 96')}/${r.sent}/${r.presses}` }, '單台上限 96/6/96'],
  ['已經 96 下 → 一下都不送', async () => { const r = await sim({ presses: 96 }); return `${r.sent}` }, '0'],
  ['每把 7,000：一輪 12 下最多花 84,000，未達停損不停', async () => { const r = await sim({ presses: 0, bal0: undefined, balAfter: n => 2_000_000 - n * 7_000 }); return `${r.halt}/${r.sent}` }, '-/12'],
  ['扣款硬上限：每把 20,000 → 送 5 把（已花 100,000 前停在剩 0）', async () => { const r = await sim({ balAfter: n => 2_000_000 - n * 20_000 }); return `${has(r.halt, '剩餘額度不夠')}/${r.sent}` }, '剩餘額度不夠/5'],
  ['扣款不超過上限（每把 20,000，總扣 ≤ 100,000）', async () => { const r = await sim({ balAfter: n => 2_000_000 - n * 20_000 }); return `${r.sent * 20_000 <= 100_000}` }, 'true'],
  ['Handpay 出現在第 3 下後 → 停、只送 3 下', async () => { const r = await sim({ handpayAt: 3 }); return `${has(r.halt, 'Handpay')}/${r.sent}` }, 'Handpay/3'],
  ['停止指令在第 4 下後 → 停、只送 4 下', async () => { const r = await sim({ stopAt: 4 }); return `${has(r.halt, '停止指令')}/${r.sent}` }, '停止指令/4'],
  ['20 分鐘到期在第 2 下後 → 停、只送 2 下', async () => { const r = await sim({ deadlineAt: 2 }); return `${has(r.halt, '時限到期')}/${r.sent}` }, '時限到期/2'],
  ['一開始讀不到餘額 → 一下都不送', async () => { const r = await sim({ balAfter: () => null }); return `${has(r.halt, '讀不到前端餘額')}/${r.sent}` }, '讀不到前端餘額/0'],
  ['中途讀不到餘額 → 停', async () => { const r = await sim({ balAfter: n => (n >= 5 ? null : 2_000_000) }); return `${has(r.halt, '讀不到前端餘額')}/${r.sent}` }, '讀不到前端餘額/5'],
  ['跨輪累計：同一個 state 連跑兩輪，基準餘額沿用第一輪', async () => {
    const state: BlindBurstState = { presses: 0, bal0: undefined }; let sent = 0, t = 0
    const run = () => runBlindBurst({ state, maxPresses: 96, maxSpend: 100_000, spinCost: 10_000, burstMs: 60_000, intervalMs: 5000, now: () => t, sleep: async ms => { t += ms }, isStopped: () => false, deadlineExceeded: () => false, bodyText: async () => '', readBalance: async () => 2_000_000 - sent * 7_000, press: async () => { sent++ } })
    const a = await run(); const b = await run()
    return `${a.halt ?? '-'}|${has(b.halt ?? '-', '剩餘額度不夠')}|${sent}`
  }, '-|剩餘額度不夠|13'],
  // 1007 合理性（CodeX：扣款與派彩分開，不取絕對值）
  ['大額派彩（第 3 下後餘額多 500 萬）→ 照推、不當成讀錯', async () => { const r = await sim({ balAfter: n => 2_000_000 - n * 7_000 + (n >= 3 ? 5_000_000 : 0) }); return `${r.halt}/${r.sent}` }, '-/12'],
  ['一次少掉遠超合理（讀錯，例 2,000,000 → 0）→ 停手待核對、不再按', async () => { const r = await sim({ balAfter: n => (n >= 2 ? 0 : 2_000_000 - n * 7_000) }); return `${has(r.halt, '待核對')}/${r.sent}` }, '待核對/2'],
  ['少掉剛好在合理範圍內（單把 2 倍）→ 不擋', async () => { const r = await sim({ balAfter: n => 2_000_000 - n * 20_000 }); return `${has(r.halt, '剩餘額度不夠')}/${r.sent}` }, '剩餘額度不夠/5'],
]

let fail = 0
// ── 1013 spec #7（CodeX）：單把成本＝實測注額、上限 14 倍、累積扣款（派彩不抵銷）、注額不明就停 ──
const lion = blindBudget(18)!
cases.push(['blindBudget：實測注額 18 → 單把 18、上限 252（14 倍）', async () => `${lion.spinCost}/${lion.maxSpend}`, '18/252'])
cases.push(['blindBudget：注額不明（null／0／NaN）→ null（不盲推）', async () => `${blindBudget(null)}/${blindBudget(0)}/${blindBudget(Number.NaN)}`, 'null/null/null'])
cases.push(['⚠️ 注額不明（spinCost 無限大）→ 一下都不按', async () => { const r = await sim({ spinCost: Number.POSITIVE_INFINITY, maxSpend: 0 }); return `${has(r.halt, '注額不明')}/${r.sent}` }, '注額不明/0'])
// LIONLINK：每把 18，第 3 下中 +1,000。淨額算法會把額度補回來（一直按到 20 下）；累積扣款到 14 下（252）就停
cases.push(['⚠️ 派彩不抵銷：每把 18、中途中 +1,000 → 累積扣到上限就停（不會因為中獎多按）', async () => {
  const r = await sim({ ...lion, burstMs: 100_000, balAfter: n => 2_000_000 - n * 18 + (n >= 3 ? 1_000 : 0) })
  return `${has(r.halt, '剩餘額度不夠再付一把')}/${r.sent}`
}, '剩餘額度不夠再付一把/14'])
cases.push(['noteBlindDebit：只加「變少」的部分', async () => { const st = {}; for (const b of [1000, 982, 2000, 1982, 1964]) noteBlindDebit(st, b); return String((st as { debited?: number }).debited) }, '54'])
cases.push(['extraSpinDecision：有給 state 用累積扣款（派彩不抵銷）', async () => {
  const st = { debited: 240, lastSeenBal: 5000 }
  const d = extraSpinDecision({ stopped: false, presses: 0, maxPresses: 96, bodyText: '', bal: 9000, bal0: 2000, maxSpend: 252, spinCost: 18, state: st })
  return `${d.ok}/${d.reason?.includes('已扣 240') ?? false}`
}, 'false/true'])
cases.push(['extraSpinDecision：注額不明 → 不按', async () => { const d = extraSpinDecision({ stopped: false, presses: 0, maxPresses: 96, bodyText: '', bal: 1000, bal0: 1000, maxSpend: 0, spinCost: Number.POSITIVE_INFINITY }); return `${d.ok}/${d.reason?.includes('注額不明') ?? false}` }, 'false/true'])

for (const [name, fn, want] of cases) {
  const got = await fn()
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}：${got}${ok ? '' : `（預期 ${want}）`}`)
}
console.log(fail ? `❌ ${fail}/${cases.length} 失敗` : `✅ ${cases.length}/${cases.length} 通過`)
process.exit(fail ? 1 : 0)

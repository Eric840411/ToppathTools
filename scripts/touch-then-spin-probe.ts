// runTouchThenSpin 探針（2026-09-30 JJBXGRAND 兩段式特殊流程，CodeX 要求先模擬）：npx tsx scripts/touch-then-spin-probe.ts
import { runTouchThenSpin, extraSpinDecision } from '../server/machine-test/verdicts.js'

async function sim(o: { thenSpin: boolean; guard?: 'ok' | 'stop' | 'noBalance' | 'noBudget' | 'none'; button?: boolean }) {
  const order: string[] = []
  let presses = 0
  const guards = {
    ok: { ok: true },
    stop: { ok: false, reason: '收到停止指令' },
    noBalance: { ok: false, reason: '讀不到前端餘額' },
    noBudget: { ok: false, reason: '剩餘額度不夠再付一把' },
  } as const
  const r = await runTouchThenSpin({
    thenSpin: o.thenSpin,
    taps: async () => { order.push('taps'); return true },
    guard: o.guard && o.guard !== 'none' ? async () => { order.push('guard'); return guards[o.guard as keyof typeof guards] } : undefined,
    pressSpin: async () => { order.push('spin'); presses++; return o.button ?? true },
  })
  return `${r.spin}/presses=${presses}/${order.join('>')}`
}

const cases: Array<[string, () => Promise<string>, string]> = [
  ['沒列在 bonus-sequence（其他觸屏機種）→ 只點觸屏、不按 SPIN', () => sim({ thenSpin: false, guard: 'ok' }), 'notListed/presses=0/taps'],
  ['有列但呼叫端沒給 guard（OSMWatcher 等待流程）→ 不按', () => sim({ thenSpin: true, guard: 'none' }), 'noGuard/presses=0/taps'],
  ['guard 通過 → 點完觸屏「之後」才判斷，然後按一下', () => sim({ thenSpin: true, guard: 'ok' }), 'pressed/presses=1/taps>guard>spin'],
  ['點觸屏期間收到停止 → 不按', () => sim({ thenSpin: true, guard: 'stop' }), 'blocked/presses=0/taps>guard'],
  ['讀不到餘額 → 不按', () => sim({ thenSpin: true, guard: 'noBalance' }), 'blocked/presses=0/taps>guard'],
  ['剩餘額度不夠 → 不按', () => sim({ thenSpin: true, guard: 'noBudget' }), 'blocked/presses=0/taps>guard'],
  ['找不到 SPIN（轉場中）→ 這輪只試一次、不緊接著重按', () => sim({ thenSpin: true, guard: 'ok', button: false }), 'noButton/presses=1/taps>guard>spin'],
]
// 關卡判定本身（runner extraSpinGuard 呼叫的純函式）：CodeX 0930 要求明列 Handpay、次數已滿
const base = { stopped: false, presses: 10, maxPresses: 96, bodyText: 'FREE GAMES', bal: 1_990_000, bal0: 2_000_000, maxSpend: 100_000, spinCost: 10_000 }
const D = (p: Partial<typeof base> & { bal0?: number | null; bal?: number | null }) => { const r = extraSpinDecision({ ...base, ...p }); return r.ok ? 'ok' : r.reason ?? '' }
cases.push(
  ['關卡：正常 → 可以按', async () => D({}), 'ok'],
  ['關卡：停止 → 不按', async () => D({ stopped: true }), '收到停止指令'],
  ['關卡：單台次數已滿（96）→ 不按', async () => D({ presses: 96 }), '已達單台上限 96 下'],
  ['關卡：畫面出現 HAND PAY → 不按', async () => D({ bodyText: 'HAND PAY — call attendant' }), '畫面出現 Handpay'],
  ['關卡：讀不到餘額 → 不按', async () => D({ bal: null }), '讀不到前端餘額'],
  ['關卡：沒有基準餘額 → 不按', async () => D({ bal0: null }), '讀不到前端餘額'],
  ['關卡：剩餘額度剛好一把（已少 90,000）→ 可以按', async () => D({ bal: 1_910_000 }), 'ok'],
  ['關卡：剩餘額度不到一把（已少 95,000）→ 不按', async () => D({ bal: 1_905_000 }).startsWith('剩餘額度不夠') ? '剩餘額度不夠' : D({ bal: 1_905_000 }), '剩餘額度不夠'],
)

let fail = 0
for (const [name, fn, want] of cases) {
  const got = await fn()
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}：${got}${ok ? '' : `（預期 ${want}）`}`)
}
console.log(fail ? `❌ ${fail}/${cases.length} 失敗` : `✅ ${cases.length}/${cases.length} 通過`)
process.exit(fail ? 1 : 0)

// SPIN 一律最小注（1008）：按鈕分組與挑最小值。npx tsx scripts/min-bet-probe.ts
import { classifyBetKey, pickMinBetKeys } from '../server/machine-test/verdicts.js'
let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }
ok(JSON.stringify(classifyBetKey('PLAY 9 Credits')) === '{"group":"credits","value":9}', 'PLAY 9 Credits → credits 9')
ok(classifyBetKey('88Credits')?.value === 88 && classifyBetKey('PLAY18 Credits')?.value === 18, '88Credits／PLAY18 Credits')
ok(JSON.stringify(classifyBetKey('BETx1')) === '{"group":"mult","value":1}' && classifyBetKey('BET x10')?.value === 10, 'BETx1／BET x10 → 倍數')
ok(JSON.stringify(classifyBetKey('₱ 0.50')) === '{"group":"denom","value":0.5}' && classifyBetKey('P5')?.value === 5, '₱ 0.50／P5 → 面額')
ok(classifyBetKey('SPIN') === null && classifyBetKey('MAX BET') === null, '看不懂的字 → null（不猜）')
// COINCOMBO：9／18／38／68／88 Credits＋x1／x2／x4／x6／x10
const cc = ['BETx1', 'BETx2', 'BETx4', 'BETx6', 'BETx10', 'PLAY 9 Credits', 'PLAY 18 Credits', 'PLAY 38 Credits', 'PLAY 68 Credits', 'PLAY 88 Credits'].map((text, idx) => ({ idx, text }))
const r = pickMinBetKeys(cc)
ok(r.picks.credits?.text === 'PLAY 9 Credits' && r.picks.mult?.text === 'BETx1' && !r.picks.denom && r.ambiguous.length === 0, 'COINCOMBO → PLAY 9 Credits＋BETx1', r)
// SBL：面額 4 顆＋注額 6 顆
const sbl = pickMinBetKeys(['₱ 0.50', '₱ 1.00', '₱ 2.00', '₱ 5.00', '88Credits', '176Credits', '264Credits', '352Credits', '440Credits', '880Credits'].map((text, idx) => ({ idx, text })))
ok(sbl.picks.denom?.value === 0.5 && sbl.picks.credits?.value === 88, 'SBL → ₱0.50＋88Credits', sbl)
ok(pickMinBetKeys([{ idx: 0, text: 'PLAY 9 Credits' }, { idx: 1, text: '9 Credits' }]).ambiguous.length === 1, '同一組最小值兩顆 → ambiguous（不 SPIN）')
ok(pickMinBetKeys([{ idx: 0, text: 'SPIN' }]).groups.length === 0, '沒有任何下注鍵 → groups 空（呼叫端不 SPIN）')
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)

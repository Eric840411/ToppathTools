// runFeatureTaps 探針（2026-10-06 ARUZE JP／FG 點選 fallback）：npx tsx scripts/feature-taps-probe.ts
import { runFeatureTaps, featureTapSummary } from '../server/machine-test/verdicts.js'

const PTS = ['3,3', '6,3', '9,3', '2,4', '6,4'].map((point, i) => ({ point, group: i < 3 ? 'JP' : 'FG' }))

/** script[i]＝第 i 次 check 的結果；missing＝找不到格的點位；stopAt＝第幾下之前收到停止 */
async function sim(o: { start?: number; script: Array<'done' | 'screen' | 'none'>; missing?: string[]; stopAt?: number }) {
  const tapped: string[] = []
  let k = 0
  const r = await runFeatureTaps({
    points: PTS, start: o.start ?? 0,
    stop: () => o.stopAt !== undefined && tapped.length >= o.stopAt,
    tap: async pt => { if (o.missing?.includes(pt)) return false; tapped.push(pt); return true },
    check: async () => ({ result: o.script[k++] ?? 'none' }),
  })
  return `${r.result}/cursor=${r.cursor}/tapped=${tapped.join(' ') || '-'}`
}

const cases: Array<[string, () => Promise<string>, string]> = [
  ['第一格就結束（moneyNtc end）→ 只點一下就停', () => sim({ script: ['done'] }), 'done/cursor=1/tapped=3,3'],
  ['JP：前兩顆畫面沒大變、第三顆結束 → 點三下', () => sim({ script: ['none', 'none', 'done'] }), 'done/cursor=3/tapped=3,3 6,3 9,3'],
  ['FG：選卡後畫面大變 → 停，cursor 指到下一格', () => sim({ script: ['screen'] }), 'screen/cursor=1/tapped=3,3'],
  ['從 cursor 接著點（不重點已點過的）', () => sim({ start: 1, script: ['done'] }), 'done/cursor=2/tapped=6,3'],
  ['全部沒進展 → 每格各點一次就停（不循環）', () => sim({ script: [] }), 'exhausted/cursor=5/tapped=3,3 6,3 9,3 2,4 6,4'],
  ['找不到的格子略過、不算 check', () => sim({ script: ['done'], missing: ['3,3', '6,3'] }), 'done/cursor=3/tapped=9,3'],
  ['收到停止 → 不再點下一格', () => sim({ script: [], stopAt: 2 }), 'stopped/cursor=2/tapped=3,3 6,3'],
  ['cursor 已到底 → 一下都不點', () => sim({ start: 5, script: ['done'] }), 'exhausted/cursor=5/tapped=-'],
]

let fail = 0
for (const [name, run, want] of cases) {
  const got = await run()
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   want ${want}\n   got  ${got}`}`)
}
const sum = featureTapSummary([{ point: '3,3', group: 'JP', result: 'none' }, { point: '6,3', group: 'JP', result: 'noElement' }, { point: '9,3', group: 'JP', result: 'done' }])
const sumOk = sum === '3,3→無、6,3→找不到格、9,3→結束'
if (!sumOk) fail++
console.log(`${sumOk ? '✅' : '❌'} 摘要格式：${sum}`)
console.log(fail ? `\n${fail} 項失敗` : `\n全部 ${cases.length + 1} 項通過`)
process.exit(fail ? 1 : 0)

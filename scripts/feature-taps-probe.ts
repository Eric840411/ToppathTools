// runFeatureTaps 探針（2026-10-06 ARUZE JP／FG 點選 fallback；CodeX 1006 review 的 P1 也在這裡）：npx tsx scripts/feature-taps-probe.ts
import { runFeatureTaps, featureTapSummary, onFeatureSelectScreen, exitFeatureState, planExitAdvance, applyFeatureRound, inFeatureHold } from '../server/machine-test/verdicts.js'

const PTS = ['3,3', '6,3', '9,3', '2,4', '6,4'].map((point, i) => ({ point, group: i < 3 ? 'JP' : 'FG' }))

/**
 * script[i]＝第 i 次 check 的結果；missing＝找不到格的點位；stopAt＝點了幾下之後收到停止；
 * noShotAt＝這格點之前截圖失敗；endBeforeTapAt＝這格點之前（截圖期間）moneyNtc end 已到
 */
async function sim(o: { start?: number; script: Array<'done' | 'screen' | 'none' | 'unsure'>; missing?: string[]; stopAt?: number; noShotAt?: string; endBeforeTapAt?: string }) {
  const tapped: string[] = []
  let k = 0
  const r = await runFeatureTaps({
    points: PTS, start: o.start ?? 0,
    stop: () => o.stopAt !== undefined && tapped.length >= o.stopAt,
    tap: async pt => {
      if (o.noShotAt === pt) return 'unsure'
      if (o.endBeforeTapAt === pt) return 'stop'
      if (o.missing?.includes(pt)) return 'noElement'
      tapped.push(pt)
      return 'ok'
    },
    check: async () => ({ result: o.script[k++] ?? 'none' }),
  })
  return `${r.result}/cursor=${r.cursor}/tapped=${tapped.join(' ') || '-'}`
}

const cases: Array<[string, () => Promise<string>, string]> = [
  ['第一格就結束（moneyNtc end）→ 只點一下就停', () => sim({ script: ['done'] }), 'done/cursor=1/tapped=3,3'],
  ['JP：前兩顆畫面沒大變、第三顆結束 → 點三下', () => sim({ script: ['none', 'none', 'done'] }), 'done/cursor=3/tapped=3,3 6,3 9,3'],
  ['FG：選卡後畫面大變 → 停（暫停觀察），cursor 指到下一格', () => sim({ script: ['screen'] }), 'screen/cursor=1/tapped=3,3'],
  ['從 cursor 接著點（不重點已點過的）', () => sim({ start: 1, script: ['done'] }), 'done/cursor=2/tapped=6,3'],
  ['全部沒進展 → 每格各點一次就停（不循環）', () => sim({ script: [] }), 'exhausted/cursor=5/tapped=3,3 6,3 9,3 2,4 6,4'],
  ['找不到的格子略過、不算 check', () => sim({ script: ['done'], missing: ['3,3', '6,3'] }), 'done/cursor=3/tapped=9,3'],
  ['收到停止 → 不再點下一格', () => sim({ script: [], stopAt: 2 }), 'stopped/cursor=2/tapped=3,3 6,3'],
  ['cursor 已到底 → 一下都不點', () => sim({ start: 5, script: ['done'] }), 'exhausted/cursor=5/tapped=-'],
  ['CodeX P1：點之前截圖失敗 → 立刻停手、這格不點', () => sim({ script: ['none'], noShotAt: '6,3' }), 'unsure/cursor=1/tapped=3,3'],
  ['CodeX P1：點之後截圖失敗（量不到）→ 立刻停手、不點下一格', () => sim({ script: ['unsure'] }), 'unsure/cursor=1/tapped=3,3'],
  ['CodeX：真的點下去之前才發現已結束 → 這格不點', () => sim({ script: ['none'], endBeforeTapAt: '6,3' }), 'stopped/cursor=1/tapped=3,3'],
]

let fail = 0
for (const [name, run, want] of cases) {
  const got = await run()
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   want ${want}\n   got  ${got}`}`)
}

// 選擇畫面判定（CodeX 1006：OCR 確認在 JP／FG 選擇畫面才點）——關鍵字同 feature-taps.json 的 ARUZE
const KW = ['MATCH 3', 'JACKPOT LEVEL', 'SELECT A FEATURE', 'FREE GAMES FEATURE']
const ocrCases: Array<[string, string, string | null]> = [
  ['JP 選元寶畫面', 'SELECT A\nMATCH 3 JACKPOT LEVEL SYMBOLS TO WIN JACKPOT', 'MATCH 3'],
  ['FG 選卡畫面（大小寫、換行、多空白不同）', 'Free Games\nFeature\nselect a  feature', 'SELECT A FEATURE'],
  ['一般盤面 → 不點', 'CREDIT 1,234 BET 10 WIN 0', null],
  ['選面額選單（別的機種）→ 不點', 'SELECT A DENOMINATION', null],
  ['OCR 失敗（空字串）→ 不點', '', null],
]
for (const [name, ocr, want] of ocrCases) {
  const got = onFeatureSelectScreen(ocr, KW)
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} 選擇畫面判定：${name} → ${got ?? '不點'}`)
}

// ── 退出迴圈模擬（CodeX 1006 第二、三輪：要驗「呼叫端」接著零操作，而且不能被 stepExit／手冊分支繞過）────────────
// 照 runner 退出迴圈的**實際順序**：每一輪先 stepExit（計 exits）→ 回大廳＝pass 結束；
//   沒有證據（retry）→ 觀察期（inFeatureHold）就只等；否則累計連續失敗，到門檻套手冊（計 playbook）或 halt；
//   遊戲進行中（inGame）→ planExitAdvance：handOff 結束／hold 只等／featureTap 跑一輪（applyFeatureRound：handOff 當輪結束、retryExit、legacy）／legacy 原本推進（計 legacy）。
// 用的判定函式跟 runner 是同一支（planExitAdvance／applyFeatureRound／inFeatureHold）；迴圈膠水是照抄，
// 所以這裡證明的是「這個順序下」不會繞過——runner 本身的真實行為要靠 0335 真機。
async function exitLoop(o: { exits: string[]; rounds?: string[]; total?: number; enabled?: boolean; stepMs?: number; streakLimit?: number; playbook?: boolean }) {
  let feat = exitFeatureState(o.total ?? 20)
  let now = 0, legacy = 0, featureRounds = 0, exits = 0, playbook = 0, streak = 0, k = 0
  let pbTried = false
  const trace: string[] = []
  const out = (end: string) => ({ end, legacy, featureRounds, exits, playbook, trace: trace.join(' ') })
  for (let attempt = 0; attempt < o.exits.length; attempt++) {
    now += o.stepMs ?? 5000
    exits++
    const e = o.exits[attempt]
    if (e === 'pass') { trace.push('exit:pass'); return out('pass') }
    if (e === 'retry') {
      if (inFeatureHold(feat, now)) { trace.push('holdWait'); continue }
      streak++
      if (streak >= (o.streakLimit ?? 3)) {
        if (o.playbook && !pbTried) { pbTried = true; playbook++; streak = 0; trace.push('playbook'); continue }
        trace.push('halt'); return out('halt')
      }
      trace.push('retry'); continue
    }
    streak = 0
    const plan = planExitAdvance(feat, now, o.enabled ?? true)
    if (plan === 'handOff') { trace.push('handOff'); return out('handOff') }
    if (plan === 'hold') { trace.push('hold'); continue }
    if (plan === 'featureTap') {
      featureRounds++
      const result = o.rounds?.[k++] ?? 'exhausted'
      trace.push(`tap:${result}`)
      const next = applyFeatureRound(feat, { result, cursor: result === 'exhausted' ? feat.total : feat.cursor + 1 }, now)
      feat = next.state
      if (next.then === 'handOff') { trace.push('handOff'); return out('handOff') }
      if (next.then === 'retryExit') continue
    }
    legacy++
    trace.push('legacy')
  }
  return out('attempts')
}
const rep = (n: number, x: string) => Array<string>(n).fill(x)
const loopCases: Array<[string, () => Promise<string>, string]> = [
  ['截圖失敗（unsure）→ **當輪**交人工；下一輪本來會退出成功也不能變 PASS', async () => { const r = await exitLoop({ exits: ['inGame', 'pass'], rounds: ['unsure'] }); return `${r.end}/exits=${r.exits}/legacy=${r.legacy}/playbook=${r.playbook}` }, 'handOff/exits=1/legacy=0/playbook=0'],
  ['截圖失敗後下一輪本來會進 retry＋手冊 → 手冊一次都沒套', async () => { const r = await exitLoop({ exits: ['inGame', 'retry', 'retry', 'retry'], rounds: ['unsure'], streakLimit: 1, playbook: true }); return `${r.end}/exits=${r.exits}/playbook=${r.playbook}` }, 'handOff/exits=1/playbook=0'],
  ['觀察期遇到 retry（沒有證據）→ 不套手冊、不累計、不 halt', async () => { const r = await exitLoop({ exits: ['inGame', ...rep(11, 'retry'), 'pass'], rounds: ['screen'], streakLimit: 1, playbook: true }); return `${r.end}/playbook=${r.playbook}/legacy=${r.legacy}/${r.trace}` },
    'pass/playbook=0/legacy=0/tap:screen holdWait holdWait holdWait holdWait holdWait holdWait holdWait holdWait holdWait holdWait holdWait exit:pass'],
  ['觀察期遇到遊戲進行中 → 零推進，過了才再點', async () => { const r = await exitLoop({ exits: rep(14, 'inGame'), rounds: ['screen', 'done'] }); return `legacy=${r.legacy}/${r.trace}` },
    'legacy=0/tap:screen hold hold hold hold hold hold hold hold hold hold hold tap:done hold'],
  ['觀察期結束後才 retry → 手冊照常', async () => { const r = await exitLoop({ exits: ['inGame', ...rep(11, 'retry'), 'retry', 'retry'], rounds: ['screen'], streakLimit: 2, playbook: true }); return `playbook=${r.playbook}/${r.trace.split(' ').slice(-2).join(' ')}` }, 'playbook=1/retry playbook'],
  ['不在選擇畫面（notOnScreen）→ 同一輪照原本流程推', async () => { const r = await exitLoop({ exits: ['inGame'], rounds: ['notOnScreen'] }); return `legacy=${r.legacy}/${r.trace}` }, 'legacy=1/tap:notOnScreen legacy'],
  ['OCR 最多 5 次，用完只走原本流程', async () => { const r = await exitLoop({ exits: rep(7, 'inGame'), rounds: rep(9, 'notOnScreen') }); return `rounds=${r.featureRounds}/legacy=${r.legacy}` }, 'rounds=5/legacy=7'],
  ['清單點完（exhausted）→ 之後只走原本流程', async () => { const r = await exitLoop({ exits: rep(3, 'inGame'), rounds: ['exhausted'] }); return `rounds=${r.featureRounds}/legacy=${r.legacy}` }, 'rounds=1/legacy=3'],
  ['被時限／上限擋下（stopped）→ 回去重試退出、不推', async () => { const r = await exitLoop({ exits: ['inGame'], rounds: ['stopped'] }); return `legacy=${r.legacy}/${r.trace}` }, 'legacy=0/tap:stopped'],
  ['沒設清單的機種（enabled=false）→ 跟改版前一樣只走原本流程', async () => { const r = await exitLoop({ exits: rep(3, 'inGame'), enabled: false }); return `rounds=${r.featureRounds}/legacy=${r.legacy}` }, 'rounds=0/legacy=3'],
]
for (const [name, run, want] of loopCases) {
  const got = await run()
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} 退出迴圈：${name}${ok ? '' : `\n   want ${want}\n   got  ${got}`}`)
}

const sum = featureTapSummary([
  { point: '3,3', group: 'JP', result: 'none' }, { point: '6,3', group: 'JP', result: 'noElement' },
  { point: '9,3', group: 'JP', result: 'done' }, { point: '2,4', group: 'FG', result: 'unsure' },
])
const sumOk = sum === '3,3→無、6,3→找不到格、9,3→結束、2,4→量不到'
if (!sumOk) fail++
console.log(`${sumOk ? '✅' : '❌'} 摘要格式：${sum}`)
const total = cases.length + ocrCases.length + loopCases.length + 1
console.log(fail ? `\n${fail}/${total} 項失敗` : `\n全部 ${total} 項通過`)
process.exit(fail ? 1 : 0)

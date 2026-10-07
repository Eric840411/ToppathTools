// verdicts.ts 探針（2026-09-29）：npx tsx scripts/verdicts-probe.ts
import { ideckVerdict, streamRoles, runIdeckSequence, ideckBackPick, touchVisualVerdict, touchVisualPrecheck, runTouchVisualFlow, type TouchSample, type IdeckOutcome, type IdeckResult } from '../server/machine-test/verdicts.js'

const O = (name: string | null, result: IdeckResult = 'ack'): IdeckOutcome => ({ label: name ?? 'x', text: '', name, result, note: '' })
const bzzf = () => [O('BetMultiple1'), O('BetMultiple2'), O('BetMultiple10'), O('Bet18'), O('Bet38')]
const V = (p: Partial<Parameters<typeof ideckVerdict>[0]>) => ideckVerdict({ outcomes: bzzf(), restore: O('BetMultiple1'), aborted: false, apiErr: 'CMDB', boxCount: 0, ...p })
const tag = (m: string) => m.match(/判定：(no response|flow fail)/)?.[1] ?? '-'

const cases: Array<[string, string, string]> = [
  ['全部回應＋還原成功（盒子查不到）', V({}).status, 'pass'],
  ['開轉逾時中止', (() => { const r = V({ outcomes: [O('BetMultiple1'), O('Bet38', 'spinTimeout')], restore: null, aborted: true }); return `${r.status}/${tag(r.message)}` })(), 'fail/flow fail'],
  ['有倍數鍵但找不到 BetMultiple1', (() => { const r = V({ outcomes: [O('BetMultiple2'), O('Bet38')], restore: null }); return `${r.status}/${tag(r.message)}` })(), 'fail/flow fail'],
  ['還原沒回應', (() => { const r = V({ restore: O('BetMultiple1', 'noAck') }); return `${r.status}/${tag(r.message)}` })(), 'fail/no response'],
  ['一顆沒回應', (() => { const r = V({ outcomes: [...bzzf().slice(0, 4), O('Bet38', 'noAck')] }); return `${r.status}/${tag(r.message)}` })(), 'fail/no response'],
  ['前端沒送出＝流程失敗（CodeX 0929）', (() => { const r = V({ outcomes: [...bzzf().slice(0, 4), O('Bet38', 'notSent')] }); return `${r.status}/${tag(r.message)}` })(), 'fail/flow fail'],
  ['找不到元素＝流程失敗', (() => { const r = V({ outcomes: [...bzzf().slice(0, 4), O('Bet38', 'noElement')] }); return `${r.status}/${tag(r.message)}` })(), 'fail/flow fail'],
  ['沒有倍數鍵、全部回應', V({ outcomes: [O('Bet30'), O('Bet60')], restore: null }).status, 'pass'],
  ['盒子查得到但 0 筆 → WARN', V({ apiErr: null, boxCount: 0 }).status, 'warn'],
  ['盒子 0 筆不能把 FAIL 降成 WARN', V({ apiErr: null, boxCount: 0, outcomes: [...bzzf().slice(0, 4), O('Bet38', 'noAck')] }).status, 'fail'],
  ['盒子有筆數 → PASS', V({ apiErr: null, boxCount: 5 }).status, 'pass'],
  ['沒按鈕', ideckVerdict({ outcomes: [], restore: null, aborted: false, apiErr: null, boxCount: 0 }).status, 'fail'],
  ['推流兩塊都在播', streamRoles([{ y: 0, h: 300, playing: true }, { y: 300, h: 300, playing: true }]).noShow.join(','), ''],
  ['上面(pool)沒播', streamRoles([{ y: 0, h: 300, playing: false }, { y: 300, h: 300, playing: true }]).noShow.join(','), 'poolstream no show'],
  ['陣列順序顛倒仍依 y 判', streamRoles([{ y: 300, h: 300, playing: true }, { y: 0, h: 300, playing: false }]).noShow.join(','), 'poolstream no show'],
  ['兩塊都沒播（main 在前）', streamRoles([{ y: 0, h: 300, playing: false }, { y: 300, h: 300, playing: false }]).noShow.join(','), 'mainstream no show,poolstream no show'],
  ['只有一塊且沒播＝main', streamRoles([{ y: 0, h: 300, playing: false }]).noShow.join(','), 'mainstream no show'],
]
// ── 流程探針：runIdeckSequence 逾時後零點擊（CodeX 0929）──
// press＝點一次；settle 會再點一次（關面額選單）；afterTimeout 不點
async function flow(results: Record<string, IdeckResult>) {
  const names = ['BetMultiple1', 'BetMultiple10', 'Bet18', 'Bet38', 'BetMultiple2']
  let clicks = 0; const pressed: string[] = []
  const r = await runIdeckSequence({
    buttons: names,
    press: async (b, idx) => { clicks++; pressed.push(idx === 'restore' ? 'restore' : b); return { name: b, result: (idx === 'restore' ? results.restore : results[b]) ?? 'ack' } },
    settle: async () => { clicks++ },
    afterTimeout: async () => { /* 不點 */ },
    shouldStop: () => false,
  })
  return { clicks, pressed: pressed.join(','), aborted: r.aborted, restored: !!r.restore }
}
const f1 = await flow({ Bet18: 'spinTimeout' })
cases.push(['逾時：只點到逾時那顆為止', f1.pressed, 'BetMultiple1,BetMultiple10,Bet18'])
cases.push(['逾時：那顆之後零點擊（不關面額選單）', String(f1.clicks), String(2 + 2 + 1)])
cases.push(['逾時：不還原、標中止', `${f1.aborted}/${f1.restored}`, 'true/false'])
const f2 = await flow({})
cases.push(['正常：全部點完再按回 BetMultiple1', f2.pressed, 'BetMultiple1,BetMultiple10,Bet18,Bet38,BetMultiple2,restore'])
const f3 = await flow({ restore: 'spinTimeout' })
cases.push(['還原逾時也標中止', `${f3.aborted}`, 'true'])

// ── 1007 learn 來回按：A → B → 按回 A（每組一次；A 或 B 開局不做；只在 back 有給的時候）──
async function bflow(names: string[], rounds: string[] = [], withBack = true) {
  const pressed: string[] = []
  const done = new Set<string>()
  const r = await runIdeckSequence({
    buttons: names,
    press: async (b, idx) => { pressed.push(idx.startsWith('back-') ? `↩${b}` : idx === 'restore' ? 'restore' : b); return { name: b, result: 'ack' as IdeckResult, round: rounds.includes(b) && !idx.startsWith('back-') } },
    settle: async () => {}, afterTimeout: async () => {}, shouldStop: () => false,
    ...(withBack ? { back: (os: Array<{ name: string | null; result: IdeckResult; round: boolean }>) => ideckBackPick(os, done) } : {}),
  })
  return { pressed: pressed.join(','), backs: r.backs.map(b => b.of).join(','), outcomes: r.outcomes.length }
}
const b1 = await bflow(['Denom0', 'Denom1', 'Denom2', 'Bet0', 'Bet1', 'Bet2'])
cases.push(['來回按：每組在第二顆後按回第一顆', b1.pressed, 'Denom0,Denom1,↩Denom0,Denom2,Bet0,Bet1,↩Bet0,Bet2'])
cases.push(['來回按：按回那一下不進 outcomes（不影響判定）', String(b1.outcomes), '6'])
const b2 = await bflow(['Denom0', 'Denom1', 'Bet0', 'Bet1', 'Bet2'], ['Bet0'])
cases.push(['來回按：A 開過局（88Credits 已選中）→ 不拿它當回程鍵，等同組下一對', b2.pressed, 'Denom0,Denom1,↩Denom0,Bet0,Bet1,Bet2,↩Bet1'])
const b3 = await bflow(['Bet0', 'Bet1', 'Bet2'], ['Bet1'])
cases.push(['來回按：B 開局 → 這一對不做', b3.pressed, 'Bet0,Bet1,Bet2,↩Bet1'.replace(',↩Bet1', '')])
const b4 = await bflow(['Denom0', 'Denom1', 'Denom2'], [], false)
cases.push(['來回按：沒開拍攝（沒給 back）→ 一下都不多按', b4.pressed, 'Denom0,Denom1,Denom2'])
const b5 = await bflow(['BetMultiple1', 'BetMultiple2', 'Bet18'])
cases.push(['來回按：倍數鍵組按回 BetMultiple1，最後照樣還原', b5.pressed, 'BetMultiple1,BetMultiple2,↩BetMultiple1,Bet18,restore'])
cases.push(['ideckBackPick：不同組不按回', String(ideckBackPick([{ name: 'Denom0', result: 'ack' }, { name: 'Bet0', result: 'ack' }], new Set())), 'null'])
cases.push(['ideckBackPick：B 沒回應不按回', String(ideckBackPick([{ name: 'Denom0', result: 'ack' }, { name: 'Denom1', result: 'noAck' }], new Set())), 'null'])

// ── 觸屏畫面判定 ──
const T = (p: Partial<Parameters<typeof touchVisualVerdict>[0]>) => { const r = touchVisualVerdict({ noise: 0.02, opened: [0.01, 0.4, 0.45], openFrozen: false, closed: [0.3, 0.03, 0.02], closeFrozen: false, expect: '賠率表', ...p }); const m = r.message.match(/判定：(no response|flow fail)/); return r.status + (m ? '/' + m[1] : '') }
cases.push(['觸屏：開了也關了', T({}), 'pass'])
cases.push(['觸屏：PASS 訊息寫明內容待確認', touchVisualVerdict({ noise: 0.02, opened: [0.4, 0.45], openFrozen: false, closed: [0.02, 0.02], closeFrozen: false, expect: '賠率表' }).message.includes('賠率表內容待人工確認') ? 'yes' : 'no', 'yes'])
cases.push(['觸屏：只有一張超過門檻（動畫閃一下）不算開', T({ opened: [0.01, 0.4, 0.02, 0.01] }), 'fail/no response'])
cases.push(['觸屏：開了又反轉（最後兩張不成立）不算開', T({ opened: [0.4, 0.45, 0.02, 0.01] }), 'fail/no response'])
cases.push(['觸屏：沒變', T({ opened: [0.01, 0.02, 0.01] }), 'fail/no response'])
cases.push(['觸屏：沒變但推流凍結 → 未驗', T({ opened: [0.0, 0.0, 0.0], openFrozen: true }), 'skip'])
cases.push(['觸屏：關不掉', T({ closed: [0.4, 0.42, 0.41] }), 'fail/flow fail'])
cases.push(['觸屏：關了又打開（最後兩張不成立）不算關', T({ closed: [0.02, 0.03, 0.4, 0.41] }), 'fail/flow fail'])
cases.push(['觸屏：關閉時凍結 → 未驗', T({ closed: [0.4, 0.4], closeFrozen: true }), 'skip'])
cases.push(['觸屏：沒執行關閉', T({ closed: null }), 'fail/flow fail'])
cases.push(['觸屏：門檻跟雜訊走（雜訊 10% → 門檻 30%，25% 不算開）', T({ noise: 0.1, opened: [0.25, 0.26, 0.25] }), 'fail/no response'])
cases.push(['閘門：推流沒播 → 不點', String(touchVisualPrecheck({ streamPlaying: false, frozen: false, noise: 0 })?.includes('沒點')), 'true'])
cases.push(['閘門：凍結 → 不點', String(touchVisualPrecheck({ streamPlaying: true, frozen: true, noise: 0 })?.includes('沒點')), 'true'])
cases.push(['閘門：雜訊太大 → 不點', String(touchVisualPrecheck({ streamPlaying: true, frozen: false, noise: 0.35 })?.includes('沒點')), 'true'])
cases.push(['閘門：正常 → 可以點', String(touchVisualPrecheck({ streamPlaying: true, frozen: false, noise: 0.02 })), 'null'])

// ── 觸屏流程探針（CodeX 0929 第三輪）：假的 sample／click，數點擊次數 ──
async function tflow(pre: Array<Partial<TouchSample>>, after: number[][], freezeAt?: { phase: number; idx: number }, noClose = false) {
  let clicks = 0, t = 0, i = 0, phase = 0, k = 0
  const saves: string[] = []
  const r = await runTouchVisualFlow({
    sample: async () => {
      if (phase === 0) { const p = pre[i++] ?? {}; t += p.time ?? 1; return { ratio: p.ratio ?? 0.01, time: t, playing: p.playing ?? true } }
      const seq = after[phase - 1] ?? []; const ratio = seq[Math.min(k, seq.length - 1)] ?? 0; const frozen = freezeAt && freezeAt.phase === phase && k >= freezeAt.idx; k++
      t += frozen ? 0 : 1; return { ratio, time: t, playing: true }
    },
    click: async () => { clicks++; phase++; k = 0 },
    wait: async () => {}, stop: () => false, save: tag => { saves.push(`${tag}@${k}`) }, expect: '賠率表', noClose,
  })
  lastSaves = saves.join(',')
  return `${r.status}/${clicks}`
}
let lastSaves = ''
const okPre = [{}, {}, {}, {}]
cases.push(['流程：正常開關 → PASS、點 2 次', await tflow(okPre, [[0.4, 0.5, 0.5, 0.5], [0.02, 0.02, 0.02, 0.02]]), 'pass/2'])
cases.push(['流程：正常時開／關各存一張，都是該段最後一張', lastSaves, '1-opened@4,2-closed@4'])
cases.push(['流程：推流沒播 → 未驗、0 次點擊', await tflow([{}, {}, {}, { playing: false }], []), 'skip/0'])
cases.push(['流程：點擊前中途凍結（頭尾差仍 ≥1 秒）→ 未驗、0 次', await tflow([{}, { time: 0 }, { time: 3 }, {}], []), 'skip/0'])
cases.push(['流程：雜訊太大 → 未驗、0 次', await tflow([{ ratio: 0.4 }, {}, {}, {}], []), 'skip/0'])
cases.push(['流程：沒變 → no response、只點 1 次', await tflow(okPre, [[0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]]), 'fail/1'])
cases.push(['流程：開了之後反轉（穩定窗看到）→ 不算開、只點 1 次', await tflow(okPre, [[0.4, 0.5, 0.01, 0.01]]), 'fail/1'])
cases.push(['流程：反轉時存的證據是最後一張（第 4 張），不是成立那張', lastSaves, '1-opened@4'])
cases.push(['流程：開啟時中途凍結、沒變 → 未驗', await tflow(okPre, [[0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]], { phase: 1, idx: 3 }), 'skip/1'])
cases.push(['流程：關不掉 → flow fail、點 2 次', await tflow(okPre, [[0.4, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]]), 'fail/2'])

cases.push(['流程：設定不關閉 → 打開就 PASS、只點 1 次（BZZF 18,9 選面額選單）', await tflow(okPre, [[0.3, 0.3, 0.3, 0.3]], undefined, true), 'pass/1'])
cases.push(['流程：設定不關閉但沒變 → 仍是 no response', await tflow(okPre, [[0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]], undefined, true), 'fail/1'])

// 雜訊重測：前 4 張很吵（中獎動畫），重拍基準後安靜 → 可以點、判得出打開
{
  let clicks = 0, t = 0, n = 0, rebases = 0, phase = 0, k = 0
  const r = await runTouchVisualFlow({
    sample: async () => { t += 1; if (phase === 0) { n++; return { ratio: rebases === 0 ? 0.28 : 0.01, time: t, playing: true } } const x = [0.41, 0.41, 0.41, 0.41][Math.min(k++, 3)]; return { ratio: x, time: t, playing: true } },
    click: async () => { clicks++; phase++ }, wait: async () => {}, stop: () => false, save: () => {}, rebase: async () => { rebases++ }, expect: '選面額選單', noClose: true,
  })
  cases.push(['流程：基準拍在動畫上 → 重拍基準後判 PASS（0237 實況）', `${r.status}/${clicks}/rebase${rebases}`, 'pass/1/rebase1'])
}

{
  let clicks = 0, rebases = 0, t = 0
  const r = await runTouchVisualFlow({
    sample: async () => { t += 1; return { ratio: 0.28, time: t, playing: true } },
    click: async () => { clicks++ }, wait: async () => {}, stop: () => false, save: () => {}, rebase: async () => { rebases++ }, expect: '選面額選單', noClose: true,
  })
  cases.push(['流程：重拍 3 輪都 28% → 基準不穩未驗、不點', `${r.status}/${clicks}/rebase${rebases}/${/基準畫面不穩/.test(r.message)}`, 'skip/0/rebase2/true'])
}

// ── 推流少畫面（0243：只剩上方獎池）──
const V2 = (rects: Array<{ y: number; h: number; playing: boolean }>) => streamRoles(rects, { expected: 2, viewportH: 932 })
cases.push(['推流：BZZF 只剩上方 pool → mainstream no show', V2([{ y: 107, h: 211, playing: true }]).noShow.join(','), 'mainstream no show'])
cases.push(['推流：BZZF 只剩下方 main → poolstream no show', V2([{ y: 318, h: 211, playing: true }]).noShow.join(','), 'poolstream no show'])
cases.push(['推流：BZZF 兩個都在 → 沒問題', V2([{ y: 107, h: 211, playing: true }, { y: 318, h: 211, playing: true }]).noShow.join(','), ''])
cases.push(['推流：BZZF 一個都沒有 → 兩個都 no show', V2([]).noShow.join(','), 'mainstream no show,poolstream no show'])
cases.push(['推流：沒設定畫面數的機種，只有一個仍當 main', streamRoles([{ y: 107, h: 211, playing: true }]).roles[0].role, 'main'])

// ── 參考圖比對（0245：選單本來就開著）──
async function rflow(preRef: number, openRef: number, openRatio = 0.3) {
  let clicks = 0, t = 0, phase = 0
  const r = await runTouchVisualFlow({
    sample: async () => { t += 1; return phase === 0 ? { ratio: 0.01, time: t, playing: true, refDiff: preRef } : { ratio: openRatio, time: t, playing: true, refDiff: openRef } },
    click: async () => { clicks++; phase++ }, wait: async () => {}, stop: () => false, save: () => {}, rebase: async () => {}, expect: '選面額選單', noClose: true,
  })
  return `${r.status}/${clicks}/${/確認是選面額選單/.test(r.message) ? 'confirmed' : /點之前畫面已經是/.test(r.message) ? 'already' : /不是選面額選單/.test(r.message) ? 'other' : '-'}`
}
cases.push(['參考圖：點之前選單已開（0245）→ 未驗、不點', await rflow(0.06, 0.06), 'skip/0/already'])
cases.push(['參考圖：點後打開且比得上 → PASS 確認是選單', await rflow(0.6, 0.0), 'pass/1/confirmed'])
cases.push(['參考圖：點後有變但不是選單（0243 獎池）→ 未驗', await rflow(0.6, 0.44), 'skip/1/other'])
cases.push(['參考圖：點後沒變 → 仍是 no response', await rflow(0.6, 0.6, 0.01), 'fail/1/-'])

// ── 已在選單時先點一次關掉（使用者 0929 選 B：同一格 18,9 就能關）──
// 狀態機：open=選單開著（refDiff 0.05、ratio 對基準看）；每點一次切換
async function cflow(closesOnTap: boolean) {
  let clicks = 0, t = 0, open = true, base = 'open'
  const r = await runTouchVisualFlow({
    sample: async () => { t += 1; const cur = open ? 'open' : 'closed'; return { ratio: cur === base ? 0.01 : 0.3, time: t, playing: true, refDiff: open ? 0.05 : 0.6 } },
    click: async () => { clicks++; if (clicks === 1 && !closesOnTap) return; open = !open },
    wait: async () => {}, stop: () => false, save: () => {}, rebase: async () => { base = open ? 'open' : 'closed' }, expect: '選面額選單', noClose: true, closeIfOpen: true,
  })
  return `${r.status}/${clicks}/${/先點一次關掉再驗/.test(r.message) ? 'closed-first' : /15 秒內沒反應/.test(r.message) ? 'wont-close' : '-'}`
}
cases.push(['已在選單：先點關掉 → 再點打開 → PASS、共點 2 次', await cflow(true), 'pass/2/closed-first'])
cases.push(['已在選單：點了關不掉 → touchscreen no response、只點 1 次（使用者 0929）', await cflow(false), 'fail/1/wont-close'])

let bad = 0
for (const [n, got, want] of cases) { const ok = got === want; if (!ok) bad++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${n}：${JSON.stringify(got)}${ok ? '' : `（應為 ${JSON.stringify(want)}）`}`) }
console.log(bad ? `\n${bad} 個案例不符` : `\n全部 ${cases.length} 個案例通過`)
process.exit(bad ? 1 : 0)

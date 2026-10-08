// 音頻靜音重錄（1008，osm-qa-agent 規格 spec-mt-audio-retry-1008、CodeX 定案）探針：npx tsx scripts/audio-retry-probe.ts
// 跑**產品的** audioSilenceRetry（假的 Spin／錄音／頁面狀態），再跑 batch 的判定（audioIssuesOf／classify／shortLine）。
import { audioSilenceRetry } from '../server/machine-test/runner.js'
import { audioRetryPrecheck, lastBetFromMoneyLog, isAudioTrueSilence } from '../server/machine-test/verdicts.js'
import type { StepResult } from '../server/machine-test/types.js'
// @ts-expect-error batch 是 .mjs
import { classify, audioIssuesOf } from './machine-test/machine-test-batch.mjs'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got).slice(0, 400)}` : ''}`) }

type Rec = { rmsDb: number; peakDb: number; crestFactor: number; method: string } | null
const SILENT: Rec = { rmsDb: -99.7, peakDb: -90.3, crestFactor: 9.4, method: 'vbcable' }
const LOUD: Rec = { rmsDb: -28.7, peakDb: -6.1, crestFactor: 12, method: 'vbcable' }
const audioMsg = (r: Rec) => r && isAudioTrueSilence(r.rmsDb, r.crestFactor) ? `VB-Cable 錄音：RMS ${r.rmsDb} dB｜問題: 靜音（RMS ${r.rmsDb} dB，無音頻輸出）` : `VB-Cable 錄音：RMS ${r?.rmsDb} dB`
const audioStep = (r: Rec): StepResult => ({ step: '音頻檢測', status: r && isAudioTrueSilence(r.rmsDb, r.crestFactor) ? 'warn' : 'pass', message: audioMsg(r), durationMs: 1 })
const spinStep: StepResult = { step: 'Spin 測試', status: 'pass', message: '✅ Spin 確認執行｜開局訊號 moneyNtc begin 3 次', durationMs: 1 }
const idleLog = [{ seq: 1, coin: 1000, reason: 'end', ts: 1 }, { seq: 2, coin: 990, reason: 'begin', ts: 2 }, { seq: 3, coin: 990, reason: 'end', ts: 3 }]

async function run(opts: { first: Rec; retries: Array<{ rec: Rec; spin?: Partial<StepResult> }>; snap?: () => Promise<{ log: typeof idleLog } | null>; balance?: number | null; popup?: { stop: boolean; unknown: boolean } }) {
  let spins = 0
  const firstRef = { data: opts.first as never }
  const r = await audioSilenceRetry({
    page: null as never, emit: () => {}, first: audioStep(opts.first), firstRef, spinStep, stopped: () => false,
    spinOnce: async ref => { const t = opts.retries[spins++]; (ref as { data: unknown }).data = t?.rec ?? null; return { step: 'Spin 測試', status: 'pass', message: '✅ Spin 確認執行｜開局訊號 moneyNtc begin 1 次', durationMs: 1, ...(t?.spin ?? {}) } },
    audioOf: async ref => audioStep((ref as { data: Rec }).data),
    probe: { snap: opts.snap ?? (async () => ({ log: idleLog })), balance: async () => opts.balance === undefined ? 1000 : opts.balance, popup: () => opts.popup ?? { stop: false, unknown: false }, idleWaitMs: 50 },
  })
  return { r, spins, final: JSON.parse(String(r.extraData?.audioFinal ?? 'null')) }
}
const judge = (r: StepResult) => classify(r)

// 規格的四個驗收情境
let x = await run({ first: SILENT, retries: [{ rec: LOUD }] })
ok(x.spins === 1 && x.final.silent === false && x.r.status === 'pass' && judge(x.r) === 'pass', '靜音 → 第 2 次錄音有聲音 → 用那次判（正常）、只多按 1 下', x)
ok(/前 1 次靜音（-99.7\/-90.3 dB），第 2 次錄到 -28.7\/-6.1 dB/.test(x.r.message), '訊息列出每次數值', x.r.message)
ok(!/靜音/.test(audioIssuesOf(x.r)), '重錄成功：訊息前面雖然有「靜音」兩個字，批次看 audioFinal → 不判 no sound', audioIssuesOf(x.r))
x = await run({ first: SILENT, retries: [{ rec: SILENT }, { rec: SILENT }] })
ok(x.spins === 2 && x.final.silent === true && x.final.recordings === 3 && judge(x.r) === 'fail', '三次都靜音 → no sound（首次＋重錄 2 次＝錄音 3 次）', x)
ok(/錄音 3 次（首次＋重錄 2 次）都靜音/.test(x.r.message), '訊息寫「錄音 3 次（首次＋重錄 2 次）」，不是「重錄 3 次」', x.r.message)
x = await run({ first: SILENT, retries: [], snap: async () => ({ log: [...idleLog, { seq: 4, coin: 980, reason: 'begin', ts: 4 }] }) })
ok(x.spins === 0 && x.final.silent === true && /還有一局沒結束/.test(x.final.stopReason), '局還沒結束（Handpay／FG／JP）→ 不重錄、用已有錄音判 no sound、寫原因', x.final)
x = await run({ first: { rmsDb: -65, peakDb: -40, crestFactor: 12, method: 'vbcable' }, retries: [{ rec: LOUD }] })
ok(x.spins === 0, '非靜音（low sound）→ 不重錄', x)

// CodeX 的邊界
x = await run({ first: SILENT, retries: [{ rec: null }] })
ok(x.final.silent === true && /錄音失敗或退回非 VB-Cable/.test(x.final.stopReason), '重錄錄音失敗 → 不算「有聲音」，停止、仍 no sound', x.final)
x = await run({ first: SILENT, retries: [{ rec: { ...LOUD!, method: 'webaudio' } }] })
ok(x.final.silent === true, '重錄退回非 VB-Cable 路徑 → 不算有聲音', x.final)
x = await run({ first: SILENT, retries: [{ rec: LOUD, spin: { message: '已點擊但餘額未變化｜開局訊號 moneyNtc begin 0 次' } }] })
ok(x.final.silent === true && /沒有開局/.test(x.final.stopReason), '重錄的 Spin 沒開局 → 停止（就算錄到聲音也不採用）', x.final)
x = await run({ first: SILENT, retries: [{ rec: LOUD, spin: { status: 'skip', message: '未驗：第 1 下 SPIN 被擋（提示框）' } }] })
ok(/skip/.test(x.final.stopReason), '重錄的 Spin 被提示框擋下 → 停止', x.final)
for (const [label, o, re] of [
  ['畫面有未知提示框', { popup: { stop: false, unknown: true } }, /未知提示框/],
  ['讀不到局狀態', { snap: async () => null }, /讀不到局狀態/],
  ['讀不到餘額', { balance: null }, /讀不到機台餘額/],
  ['餘額不夠一把', { balance: 5 }, /不夠一把/],
] as const) {
  const y = await run({ first: SILENT, retries: [{ rec: LOUD }], ...o })
  ok(y.spins === 0 && re.test(y.final.stopReason), `${label} → 不重錄`, y.final)
}
ok(audioRetryPrecheck({ popupStop: false, popupUnknown: false, lastSpinBegins: 0, roundState: 'idle', balance: 100, lastBet: 10 })?.includes('沒有開局') === true, '原本的 Spin 沒開局（選單可能開著）→ 不重錄')
ok(lastBetFromMoneyLog(idleLog) === 10 && lastBetFromMoneyLog([{ seq: 1, coin: 5, reason: 'end' }]) === null, '一把下注金額從 begin 那筆的 coin 差算；算不出來回 null')
// 舊結果（沒有 audioFinal）照舊看訊息
ok(audioIssuesOf({ step: '音頻檢測', status: 'warn', message: 'x｜問題: 靜音（RMS -99 dB）' }) .includes('靜音'), '舊結果沒有 audioFinal → 照舊看訊息')

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)

// 未監控機台「開局沒結束」＝疑似特殊遊戲（1007）：npx tsx scripts/open-round-probe.ts
// 假時鐘＋假 moneyNtc，檢查 superviseOpenRound／openRoundTrigger 什麼時候動、什麼時候停，以及**收到 end 之後一下都不能再按**。
import { superviseOpenRound, openRoundTrigger, OPEN_ROUND_SUSPECT_MS } from '../server/machine-test/verdicts.js'

type Sim = {
  endAt?: number                       // 第幾毫秒收到 end（undefined＝永遠不來）
  endDuringOverlay?: boolean           // 關遮罩途中收到 end
  endDuringScreen?: boolean            // OCR 途中收到 end
  screen?: 'spin' | 'touch' | 'wait' | 'unknown' | 'fail'
  lastMoneyAgo?: number
  action?: 'spin' | 'touchscreen' | 'takewin' | 'auto_wait'
  feature?: Array<'progress' | 'none' | 'giveUp'>
  stopAt?: number
  maxActs?: number
  touchesPerRound?: number
}
async function sim(o: Sim) {
  let t = 0, ended = false, presses = 0, touches = 0, pressAfterEnd = 0, ftCalls = 0
  const isEnded = () => { if (o.endAt !== undefined && t >= o.endAt) ended = true; return ended }
  const r = await superviseOpenRound({
    ended: async () => isEnded(),
    lastMoneyAgo: async () => o.lastMoneyAgo ?? 60_000,
    stop: () => o.stopAt !== undefined && t >= o.stopAt,
    closeOverlays: async () => { if (o.endDuringOverlay) ended = true },
    featureTaps: o.feature ? async () => { const k = o.feature![Math.min(ftCalls++, o.feature!.length - 1)]; return { kind: k, taps: k === 'progress' ? 1 : 0 } } : undefined,
    action: o.action ?? 'spin',
    screen: async () => { if (o.endDuringScreen) ended = true; return o.screen ?? 'spin' },
    pressSpin: async () => { if (ended) pressAfterEnd++; presses++; return true },
    touch: async (budget: number) => { const n = Math.min(o.touchesPerRound ?? 1, budget); for (let i = 0; i < n; i++) { if (ended) pressAfterEnd++; touches++ } return n },
    now: () => t, sleep: async ms => { t += ms },
    maxMs: 300_000, maxActs: o.maxActs ?? 40, quietMs: 8_000, pollMs: 5_000, stallMs: 120_000,
  })
  return { ...r, presses, touches, pressAfterEnd }
}

const cases: Array<[string, () => Promise<string>, string]> = [
  ['關遮罩途中收到 end → done、一下都沒按', async () => { const r = await sim({ endDuringOverlay: true }); return `${r.result}/${r.presses}` }, 'done/0'],
  ['OCR 途中收到 end → done、OCR 之後不按（按前重查）', async () => { const r = await sim({ endDuringScreen: true }); return `${r.result}/${r.presses}/${r.pressAfterEnd}` }, 'done/0/0'],
  ['end 沒來、畫面已回普通局（OCR 看不到 SPIN 指示）→ 不按、逾時 stalled', async () => { const r = await sim({ screen: 'unknown' }); return `${r.result}/${r.presses}` }, 'stalled/0'],
  ['截圖／OCR 失敗 → 不按', async () => { const r = await sim({ screen: 'fail', endAt: 30_000 }); return `${r.result}/${r.presses}` }, 'done/0'],
  ['畫面叫按 SPIN、安靜夠久 → 按到 end 為止，end 之後一下都沒有', async () => { const r = await sim({ endAt: 20_000 }); return `${r.result}/${r.presses}/${r.pressAfterEnd}` }, 'done/4/0'],
  ['畫面叫按 SPIN 但最後一則 moneyNtc 才 2 秒前 → 不按（節流）', async () => { const r = await sim({ lastMoneyAgo: 2_000, endAt: 30_000 }); return `${r.result}/${r.presses}` }, 'done/0'],
  ['停止指令 → stopped', async () => { const r = await sim({ stopAt: 10_000 }); return `${r.result}` }, 'stopped'],
  ['點擊上限 3 → 最多按 3 下，之後只等', async () => { const r = await sim({ maxActs: 3 }); return `${r.result}/${r.presses}` }, 'stalled/3'],
  ['有機種點位：觸屏推進有進展 → 收到 end 結束、不按 SPIN', async () => { const r = await sim({ feature: ['progress'], endAt: 12_000 }); return `${r.result}/${r.presses}/${r.how[0]}` }, 'done/0/featureTaps'],
  ['點位清單放棄（沒確認是選擇畫面）→ 退回 bonusAction（有證據才按）', async () => { const r = await sim({ feature: ['giveUp'], endAt: 12_000 }); return `${r.result}/${r.presses > 0}` }, 'done/true'],
  ['bonusAction=touchscreen：收到 end 之後不再點', async () => { const r = await sim({ action: 'touchscreen', endAt: 12_000 }); return `${r.result}/${r.pressAfterEnd}` }, 'done/0'],
  ['bonusAction=touchscreen：關遮罩途中收到 end → 一下都不點', async () => { const r = await sim({ action: 'touchscreen', endDuringOverlay: true }); return `${r.result}/${r.touches}/${r.pressAfterEnd}` }, 'done/0/0'],
  ['[P2] 一輪觸屏點 5 格、上限 12 → 實際點擊不超過 12 下', async () => { const r = await sim({ action: 'touchscreen', touchesPerRound: 5, maxActs: 12 }); return `${r.result}/${r.touches}` }, 'stalled/12'],
  ['auto_wait → 只等', async () => { const r = await sim({ action: 'auto_wait', endAt: 40_000 }); return `${r.result}/${r.presses}/${r.touches}` }, 'done/0/0'],
  // 啟動條件
  ['觸發：沒有任何 begin → 不啟動', async () => JSON.stringify(openRoundTrigger({ log: [], sinceSeq: 0, now: 100_000, osmStatus: undefined })), '{"start":false,"why":"noSignal"}'],
  ['觸發：上一台的 begin 不算（sinceSeq）', async () => openRoundTrigger({ log: [{ seq: 5, reason: 'begin', ts: 0 }], sinceSeq: 5, now: 100_000, osmStatus: undefined }).start ? 'start' : 'no', 'no'],
  ['觸發：最後是 end → 沒開著的局', async () => JSON.stringify(openRoundTrigger({ log: [{ seq: 1, reason: 'begin', ts: 0 }, { seq: 2, reason: 'end', ts: 1 }], sinceSeq: 0, now: 100_000, osmStatus: 0 })), '{"start":false,"why":"closed"}'],
  ['觸發：begin 才 10 秒 → 再等 25 秒', async () => JSON.stringify(openRoundTrigger({ log: [{ seq: 1, reason: 'begin', ts: 90_000 }], sinceSeq: 0, now: 100_000, osmStatus: 0 })), '{"start":false,"why":"young","waitMs":25000}'],
  ['觸發：begin 超過 35 秒沒 end、未監控 → 啟動並綁定那筆 begin', async () => JSON.stringify(openRoundTrigger({ log: [{ seq: 3, reason: 'begin', ts: 0 }], sinceSeq: 0, now: OPEN_ROUND_SUSPECT_MS, osmStatus: undefined })), `{"start":true,"beginSeq":3,"ageMs":${OPEN_ROUND_SUSPECT_MS}}`],
  ['觸發：OSMWatcher 判特殊狀態（非 0）→ 交給原流程', async () => JSON.stringify(openRoundTrigger({ log: [{ seq: 1, reason: 'begin', ts: 0 }], sinceSeq: 0, now: 100_000, osmStatus: 2 })), '{"start":false,"why":"monitored"}'],
]

let fail = 0
for (const [name, fn, want] of cases) {
  const got = await fn()
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}：${got}${ok ? '' : `（預期 ${want}）`}`)
}
console.log(fail ? `❌ ${fail}/${cases.length} 失敗` : `✅ ${cases.length}/${cases.length} 通過`)
process.exit(fail ? 1 : 0)

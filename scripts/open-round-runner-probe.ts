// 疑似特殊遊戲處理器的**實際 runner 路徑**探針（CodeX 2d513b6 要求）：npx tsx scripts/open-round-runner-probe.ts
// 跑 runner.ts 真正的 makeOpenRoundHandler（關遮罩、OCR 判斷、按 SPIN、逐格觸屏、停手快取），只把 Playwright Page 換成假的：
// 假頁面記錄每一下點擊，並可以在第 N 下之後「推來」moneyNtc end，檢查 end 之後還有沒有點。
import { makeOpenRoundHandler } from '../server/machine-test/runner.js'

type Ev = { seq: number; coin: number; reason: string; ts: number }
function fakePage(o: { body: string; endAfterClicks?: number; noMoney?: boolean; endDuringBox?: boolean; endDuringLookup?: boolean; stopDuringReadAfter?: number; stopFlag?: { v: boolean }; take?: boolean; debitOnSpin?: boolean; debitOnTap?: boolean }) {
  const log: Ev[] = o.noMoney ? [] : [{ seq: 1, coin: 2_000_000, reason: 'begin', ts: Date.now() - 40_000 }]
  let clicks = 0, clicksAfterEnd = 0, spins = 0, taps = 0, reads = 0, clicksAfterStop = 0, takes = 0
  // guardedClick 先取座標再用真滑鼠點：記下最後一個取座標的元素，mouse.click 才知道點的是哪一顆
  let lastBoxKind: 'spin' | 'tap' | 'take' = 'spin'
  const ended = () => log.some(e => e.reason === 'end')
  const pushEnd = () => { if (!ended()) log.push({ seq: 2, coin: 2_100_000, reason: 'end', ts: Date.now() }) }
  const onClick = (kind: 'spin' | 'tap' | 'take') => {
    if (ended()) clicksAfterEnd++
    if (o.stopFlag?.v) clicksAfterStop++
    clicks++; if (kind === 'spin') spins++; else if (kind === 'take') takes++; else taps++
    // 1013 #7：按 SPIN 其實開了一局付費局 → 新的 begin、餘額比這局 begin 少
    if (kind === 'spin' && o.debitOnSpin && !ended()) log.push({ seq: log.length + 1, coin: 2_000_000 - 18 * spins, reason: 'begin', ts: Date.now() })
    // CodeX 224801b [P1]：觸屏點一下就開了付費局
    if (kind === 'tap' && o.debitOnTap && !ended()) log.push({ seq: log.length + 1, coin: 2_000_000 - 18 * taps, reason: 'begin', ts: Date.now() })
    if (o.endAfterClicks !== undefined && clicks >= o.endAfterClicks && !ended()) log.push({ seq: 2, coin: 2_100_000, reason: 'end', ts: Date.now() })
  }
  const evaluate = async (fn: unknown) => {
    const src = String(fn)
    if (src.includes('__moneyLog')) {
      // 模擬：第 N 次讀流水的期間使用者按了停止（CodeX edd347b 補測）
      reads++
      if (o.stopDuringReadAfter !== undefined && o.stopFlag && reads >= o.stopDuringReadAfter) o.stopFlag.v = true   // 第 N 次讀的期間（含）
      return log.map(e => ({ ...e }))
    }
    if (src.includes('__lastMachineCoin')) return null
    if (src.includes('notification-close')) return 0
    if (src.includes('Want to reserve')) return false
    return o.body
  }
  const el = (kind: 'spin' | 'tap' | 'take') => ({
    isVisible: async () => true,
    click: async () => { onClick(kind) },
    // 1007 uiAct 會先用 evaluate 查禁點／頁面內攔截計數：只有真正的 click() 才算點
    evaluate: async (fn: unknown) => { if (String(fn).includes('.click()')) onClick(kind); return undefined },
    // 模擬：取座標的期間 end 推來了（CodeX 4c320d4 補測）
    boundingBox: async () => { lastBoxKind = kind; if (o.endDuringBox) pushEnd(); return { x: 0, y: 0, width: 10, height: 10 } },
  })
  const frame = {
    url: () => 'https://h5.example/game',
    evaluate,
    // 觸屏格；面額遮罩 .select-main 沒有。endDuringLookup：查元素的期間 end 推來了
    $$: async (sel: string) => { if (sel.startsWith('//span')) { if (o.endDuringLookup) pushEnd(); return [el('tap')] } return [] },
  }
  const page = {
    frames: () => [frame],
    evaluate,
    $$: async (sel: string) => (/btn_take/.test(sel) ? (o.take ? [el('take')] : []) : /spin/i.test(sel) ? [el('spin')] : []),
    screenshot: async () => Buffer.from('png'),
    mouse: { click: async () => { onClick(lastBoxKind) } },
    getByText: () => ({ count: async () => 0, nth: () => ({ isVisible: async () => false }) }),
    locator: () => ({ count: async () => 0 }),
  }
  return { page: page as never, stats: () => ({ clicks, clicksAfterEnd, clicksAfterStop, spins, taps, takes }) }
}
const quick = { pollMs: 5, quietMs: 0, maxMs: 300, maxActs: 20 }
async function run(o: { body: string; endAfterClicks?: number; noMoney?: boolean; endDuringBox?: boolean; endDuringLookup?: boolean; stopDuringReadAfter?: number; action?: string; touchPoints?: string[]; timing?: Partial<typeof quick>; take?: boolean; debitOnSpin?: boolean; debitOnTap?: boolean; clickTake?: boolean }) {
  const stopFlag = { v: false }
  const f = fakePage({ ...o, stopFlag })
  const h = makeOpenRoundHandler({
    page: f.page, emit: () => {}, machineCode: '000-FAKE-0001',
    getProfile: () => ({ machineType: 'FAKE', bonusAction: o.action ?? 'spin', touchPoints: o.touchPoints ?? [], clickTake: o.clickTake ?? false }) as never,
    sinceSeq: 0, osmStatus: () => undefined, stopped: () => stopFlag.v, filePrefix: 'probe-',
    ocr: async () => o.body, timing: { ...quick, ...(o.timing ?? {}) },
  })
  const r1 = await h('probe')
  const t = Date.now()
  const r2 = await h('probe again')
  return { r1: r1?.result ?? 'null', r2: r2?.result ?? 'null', secondMs: Date.now() - t, ...f.stats() }
}

let fail = 0
const check = (name: string, got: string, want: string) => { const ok = got === want; if (!ok) fail++; console.log(`${ok ? '✅' : '❌'} ${name}：${got}${ok ? '' : `（預期 ${want}）`}`) }

{ const r = await run({ body: 'CREDIT 2,000,000  BET 100  PRESS PLAY TO SPIN' })
  check('[P1] 普通局畫面「PRESS PLAY TO SPIN」、end 沒來 → 一下都不按、stalled', `${r.r1}/${r.spins}`, 'stalled/0')
  check('[P1] 同一局再問一次 → 直接回 stalled（不重跑）', `${r.r2}/${r.secondMs < 100}`, 'stalled/true') }
{ const r = await run({ body: 'GRAND JACKPOT 1,234,567  PRESS PLAY TO SPIN' })
  check('[P1] 普通局有獎池字樣「JACKPOT」＋PRESS PLAY TO SPIN → 0 下', `${r.r1}/${r.spins}`, 'stalled/0') }
{ const r = await run({ body: 'BONUS COMPLETE  TOTAL WIN 100  PRESS PLAY TO SPIN' })
  check('[P1] 結算畫面＋PRESS PLAY TO SPIN → 0 下', `${r.r1}/${r.spins}`, 'stalled/0') }
{ const r = await run({ body: '0 SPINS REMAINING  PRESS PLAY TO SPIN' })
  check('[P1] 剩 0 次「0 SPINS REMAINING」→ 0 下', `${r.r1}/${r.spins}`, 'stalled/0') }
{ const r = await run({ body: 'FREE GAMES 3  PRESS SPIN TO CONTINUE', endDuringBox: true })
  check('[P1] 取座標期間收到 end → 不點', `${r.r1}/${r.spins}/${r.clicksAfterEnd}`, 'done/0/0') }
{ const r = await run({ body: 'PICK A COIN', action: 'touchscreen', touchPoints: ['1,1', '2,1'], endDuringLookup: true })
  check('[P1] 觸屏查元素期間收到 end → 不點', `${r.r1}/${r.taps}/${r.clicksAfterEnd}`, 'done/0/0') }
// 讀流水期間按停止（CodeX edd347b [P1]）：讀到第 N 次之後停止旗標變 true，之後一下都不能點
for (const n of [1, 2, 3, 4, 5, 6]) {
  const r = await run({ body: 'FREE GAMES 3  PRESS SPIN TO CONTINUE', stopDuringReadAfter: n })
  check(`[P1] SPIN：第 ${n} 次讀流水期間按停止 → 停止後 0 下`, `${r.r1}/${r.clicksAfterStop}`, 'stopped/0')
}
for (const n of [1, 2, 3, 4, 5, 6]) {
  const r = await run({ body: 'PICK A COIN', action: 'touchscreen', touchPoints: ['1,1', '2,1', '3,1'], stopDuringReadAfter: n })
  check(`[P1] 觸屏：第 ${n} 次讀流水期間按停止 → 停止後 0 下`, `${r.r1}/${r.clicksAfterStop}`, 'stopped/0')
}
{ const r = await run({ body: 'FREE GAMES  3 SPINS REMAINING  PRESS SPIN TO CONTINUE', endAfterClicks: 2 })
  check('特殊遊戲畫面 → 按到 end 為止，end 之後一下都沒有', `${r.r1}/${r.spins}/${r.clicksAfterEnd}`, 'done/2/0') }
{ const r = await run({ body: 'PICK A COIN', action: 'touchscreen', touchPoints: ['1,1', '2,1', '3,1', '4,1', '5,1'], endAfterClicks: 1 })
  check('[P1] 逐格觸屏：第 1 格後收到 end → 第 2 格不點', `${r.r1}/${r.taps}/${r.clicksAfterEnd}`, 'done/1/0') }
{ const r = await run({ body: 'PICK A COIN', action: 'touchscreen', touchPoints: ['1,1', '2,1', '3,1', '4,1', '5,1'], timing: { maxActs: 3, maxMs: 15_000 } })
  check('[P2] 一輪 5 格、上限 3 → 實際只點 3 下', `${r.r1}/${r.taps}`, 'stalled/3') }
{ const r = await run({ body: 'FREE GAMES', noMoney: true })
  check('沒有任何 moneyNtc → 不啟動、不點', `${r.r1}/${r.clicks}`, 'null/0') }

// ── 1013 spec #7（CodeX）：Take 優先（只在機種確定 Take＝收分時）、扣款守門 ──
{ const r = await run({ body: 'FREE GAMES  3 SPINS REMAINING  PRESS SPIN TO CONTINUE', take: true, clickTake: true, endAfterClicks: 1 })
  check('#7 機種確定 Take＝收分、畫面有 Take → 先按 Take（不按 SPIN），收到 end 就停', `${r.r1}/${r.takes}/${r.spins}/${r.clicksAfterEnd}`, 'done/1/0/0') }
{ const r = await run({ body: 'FREE GAMES  3 SPINS REMAINING  PRESS SPIN TO CONTINUE', take: true, clickTake: false, endAfterClicks: 2 })
  check('#7 機種沒確定 Take＝收分 → 不按 Take，照舊 OCR＋SPIN', `${r.r1}/${r.takes}/${r.spins}`, 'done/0/2') }
{ const r = await run({ body: 'FREE GAMES  3 SPINS REMAINING  PRESS SPIN TO CONTINUE', take: true, clickTake: false, action: 'takewin', endAfterClicks: 1 })
  check('#7 bonusAction=takewin 也算確定收分 → 按 Take', `${r.r1}/${r.takes}`, 'done/1') }
{ const r = await run({ body: 'FREE GAMES  3 SPINS REMAINING  PRESS SPIN TO CONTINUE', debitOnSpin: true, timing: { maxActs: 20, maxMs: 2000 } })
  check('⚠️ #7 按 SPIN 後餘額比這局 begin 少、局還開著 → debit，只按了 1 下就停（不再按、不救援）', `${r.r1}/${r.spins}`, 'debit/1')
  check('#7 同一局再問 → 直接回 debit（不重跑）', `${r.r2}/${r.secondMs < 100}`, 'debit/true') }
{ const r = await run({ body: 'FREE GAMES  3 SPINS REMAINING  PRESS SPIN TO CONTINUE', endAfterClicks: 2 })
  check('#7 對照：沒有扣款 → 照舊按到 end', `${r.r1}/${r.spins}`, 'done/2') }
{ const r = await run({ body: 'PICK A COIN', action: 'touchscreen', touchPoints: ['1,1', '2,1', '3,1'], debitOnTap: true, timing: { maxActs: 20, maxMs: 2000 } })
  check('⚠️ #7 觸屏第 1 格就扣款 → debit，只點了 1 格（每一格點之前都看扣款，CodeX 224801b [P1]）', `${r.r1}/${r.taps}`, 'debit/1') }

console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

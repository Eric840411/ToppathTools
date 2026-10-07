// 機台測試提示框處理（1007，spec-mt-popup-handling-1007）的探針：npx tsx scripts/popup-handling-probe.ts
// 純函式（目錄／處理表／步驟關卡）＋真瀏覽器（Playwright，page.route 真導頁）：
// 每個案例都看「遊戲那邊的 handler 有沒有真的跑」（window.__ran），不是只看 runner 回傳什麼（CodeX：要證明 handler 沒執行）。
import { chromium, type Page } from 'playwright'
import { matchPopup, isNeverClick, NEVER_BLOCK_IN_PAGE, NEVER_CLICK_SERIALIZED } from '../server/uat-runner/popup-catalog.js'
import { decidePopup, popupStepBlock } from '../server/machine-test/verdicts.js'
import { attachPopupGuard, detachPopupGuard, uiAct, nativeClick, popupGuardOf, clearCctvOverlays, saveCctvEvidenceShot } from '../server/machine-test/runner.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${got !== undefined ? `：${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── 純函式 ──────────────────────────────────────────────
const d = (text: string, phase: 'test' | 'exit' = 'test', selectors: string[] = []) => decidePopup(matchPopup({ text, selectors }), text, phase)
ok(d('Tips Game is running and cannot be quit Confirm').kind === 'ack', 'cannot-quit → ack Confirm')
ok(d('Do you want to reserve this machine? Reserve Now').kind === 'close', '預約面板（測試中）→ close X')
ok(JSON.stringify(d('Do you want to reserve this machine?', 'exit')) .includes('exitToLobby'), '預約面板（退出時）→ Exit to Lobby')
ok(d('Cash out credit 1,000? Confirm').kind === 'unknown', 'cashout-credit 測試中出現（誤觸）→ unknown，不按')
ok(d('Cash out credit 1,000? Confirm', 'exit').kind === 'ack', 'cashout-credit 退出時 → ack')
const od = d('Your account is logged in from another device')
ok(od.kind === 'stop' && od.scope === 'account', 'other-device → stop（帳號）', od)
ok(d('Machine connection timeout').kind === 'stop', 'conn-timeout → stop（AFT error）')
ok(d('Error code: 1044').kind === 'stop', '進場錯誤碼 1044 → stop')
ok(d('Balance 10440 credits').kind === 'unknown', '餘額裡剛好有 1044 → 不當成錯誤碼（unknown）')
ok(d('Quit game, please wait').kind === 'wait', 'quit-wait → wait')
ok(d('Some brand-new box').kind === 'unknown', '認不得的框 → unknown')
ok(d('Game exception Machine connection timeout').kind === 'stop', '同時命中 stop 與 stop → stop')
ok(d('', 'test', ['.select-main']).kind === 'close', '面額選單（selector）→ close')
ok(isNeverClick({ text: 'Join', selectors: [] }, '') === null, 'Join 在大廳 → 不是禁點')
ok(isNeverClick({ text: 'Join', selectors: [] }, '', { inMachine: true }) === 'join-in-game', 'Join 在機台裡 → 禁點')
ok(isNeverClick({ text: 'Confirm', selectors: [] }, 'Recharge now') === 'recharge-confirm', '充值框的 Confirm → 禁點')
ok(isNeverClick({ text: 'Confirm', selectors: [] }, 'Game is running and cannot be quit') === null, '一般框的 Confirm → 可點')
const acc = popupStepBlock({ stop: { id: 'other-device', verdict: 'account in use', scope: 'account' }, unknown: null, unknownExpired: false, isExit: true })
ok(!!acc?.accountHalt && acc.skip?.status === 'fail', '帳號類 stop → 換帳號，連退出都不做', acc)
const mach = popupStepBlock({ stop: { id: 'conn-timeout', verdict: 'AFT error', scope: 'machine' }, unknown: null, unknownExpired: false, isExit: true })
ok(!!mach?.verdictStep && !mach.skip && !mach.accountHalt, '本台 stop → 退出照走、本台判定', mach)
ok(popupStepBlock({ stop: null, unknown: { text: 'x' }, unknownExpired: false, isExit: false })?.skip?.status === 'skip', 'unknown 未滿 30 秒 → 這步不做')
ok(!!popupStepBlock({ stop: null, unknown: { text: 'x' }, unknownExpired: true, isExit: false })?.verdictStep?.includes('unknown popup'), 'unknown 滿 30 秒 → unknown popup 判定')

// ── 真瀏覽器 ──────────────────────────────────────────────
const CSS = `body{margin:0;width:428px;height:739px;font:14px sans-serif}
.spin-btn{position:absolute;left:150px;top:600px;width:120px;height:60px}
.box-content{position:fixed;left:24px;top:200px;width:380px;height:260px;background:#223;color:#fff;z-index:10}
.mask-layer{position:fixed;inset:0;z-index:20}`
const BOX = (text: string, btns: string) => `<div class="box-content"><div class="box-title">${text}</div>${btns}</div>`
const SPIN = `<button class="spin-btn" onclick="(window.__ran=window.__ran||[]).push('spin')">SPIN</button>`
// 用真的導頁（page.route），不用 setContent：setContent 走 document.open，會清掉 window 上的監聽器，跟正式環境不一樣
let html = ''
async function setup(page: Page, body: string) {
  html = `<!doctype html><style>${CSS}</style><script>window.__ran=[]</script>${SPIN}${body}`
  await page.goto(`http://probe.local/${Date.now()}`)
}
const ran = (page: Page) => page.evaluate(() => (window as any).__ran as string[])

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 428, height: 739 }, hasTouch: true })
if (!process.env.MUT_NO_LAYER2) await ctx.addInitScript(NEVER_BLOCK_IN_PAGE, NEVER_CLICK_SERIALIZED)
const page = await ctx.newPage()
await page.route('http://probe.local/**', r => r.fulfill({ contentType: 'text/html', body: html }))
const notes: string[] = []
const emit = (m: string) => notes.push(m)
try {
  // 1. 已知可關的框（預約面板）：只按 X，不按 Reserve Now
  await setup(page, BOX('Do you want to reserve this machine?', `<span class="box-btn_text2" onclick="__ran.push('reserve-now')">Reserve Now</span><span class="btn-close" onclick="__ran.push('x');this.parentNode.remove()">X</span>`))
  let g = attachPopupGuard(page, emit, 'probe-1')
  await g.scan({ act: true, why: '同步' })
  ok(JSON.stringify(await ran(page)) === '["x"]', '預約面板 → 只按 X、沒按 Reserve Now', await ran(page))
  ok(!g.blockReason(), '關掉之後不擋遊戲')
  detachPopupGuard(page)

  // 2. 未知框：不點任何鍵、留證、擋遊戲操作（handler 沒跑）
  await setup(page, BOX('Brand new mystery box', `<span class="box-btn_text2" onclick="__ran.push('mystery-ok')">OK</span>`))
  g = attachPopupGuard(page, emit, 'probe-2')
  notes.length = 0
  await g.scan({ act: true, why: '同步' })
  ok((await ran(page)).length === 0, '未知框 → 一顆都沒按', await ran(page))
  ok(!!g.unknown && /截圖/.test(notes.join('｜')), '未知框 → 有記錄＋截圖', notes.join('｜').slice(0, 120))
  const spinEl = await page.$('.spin-btn')
  const r2 = await uiAct(page, 'game', 'SPIN', spinEl, () => spinEl!.click({ timeout: 1000 }))
  ok(r2 === 'blocked' && !(await ran(page)).includes('spin'), '未知框還在 → 按 SPIN 回 blocked、遊戲 handler 沒跑', r2)
  const nc = await nativeClick(page, ['.spin-btn'])
  ok(nc === 'blocked' && !(await ran(page)).includes('spin'), 'nativeClick 路徑 → blocked、沒有改用 force／座標再點', nc)
  const rTouch = await uiAct(page, 'game', 'SPIN（觸控）', spinEl, () => page.touchscreen.tap(210, 630))
  ok(rTouch === 'blocked' && !(await ran(page)).includes('spin'), '觸控路徑 → blocked、handler 沒跑', rTouch)
  ok(g.unknownExpired(Date.now() + 31_000), '未知框 30 秒 → 結案門檻到')
  await page.evaluate(() => document.querySelector('.box-content')!.remove())
  await g.scan({ act: true, why: '同步' })
  ok(!g.unknown && (await uiAct(page, 'game', 'SPIN', spinEl, () => spinEl!.click({ timeout: 1000 }))) === 'clicked' && (await ran(page)).includes('spin'), '框消失 → 解除、SPIN 真的按到')
  detachPopupGuard(page)

  // 3. 禁點名單：每一種點法都擋；第二層（頁面內攔截）繞過 uiAct 也擋
  await setup(page, BOX('Jackpot! Machine 0001', `<span class="box-btn_text2" onclick="__ran.push('play-now')">Play Now</span><span class="view" onclick="__ran.push('view')">View</span>`))
  g = attachPopupGuard(page, emit, 'probe-3')
  const playNow = await page.$('text=Play Now')
  const pb = await playNow!.boundingBox()
  for (const [name, fn] of [
    ['click', () => playNow!.click({ timeout: 1000 })],
    ['force', () => playNow!.click({ force: true, timeout: 1000 })],
    ['座標', () => page.mouse.click(pb!.x + pb!.width / 2, pb!.y + pb!.height / 2)],
    ['觸控', () => page.touchscreen.tap(pb!.x + pb!.width / 2, pb!.y + pb!.height / 2)],
    ['JS click', () => playNow!.evaluate((e: Element) => (e as HTMLElement).click())],
  ] as Array<[string, () => Promise<unknown>]>) {
    const r = await uiAct(page, 'popup', `Play Now（${name}）`, playNow, fn)
    ok(r === 'blocked', `禁點 Play Now（${name}）→ blocked`, r)
  }
  ok(!(await ran(page)).includes('play-now'), '禁點 Play Now → handler 一次都沒跑', await ran(page))
  // 繞過 uiAct 直接滑鼠點（模擬漏收斂的點擊路徑）：只剩頁面內那層
  await page.mouse.click(pb!.x + pb!.width / 2, pb!.y + pb!.height / 2)
  await page.touchscreen.tap(pb!.x + pb!.width / 2, pb!.y + pb!.height / 2)
  const vb = await (await page.$('.view'))!.boundingBox()
  await page.mouse.click(vb!.x + vb!.width / 2, vb!.y + vb!.height / 2)
  ok((await ran(page)).length === 0, '繞過 uiAct 的滑鼠／觸控點 Play Now、View → 頁面內攔截擋下', await ran(page))
  ok((await page.evaluate(() => (window as any).__mtBlockedClicks.length)) > 0, '頁面內攔截有記錄')
  // 第二層回報給 runner：el 本身不是禁點，但 fn 點到的是禁點 → blocked
  const rLayer2 = await uiAct(page, 'game', '座標點到別處', spinEl && await page.$('.spin-btn'), () => page.mouse.click(pb!.x + pb!.width / 2, pb!.y + pb!.height / 2))
  ok(rLayer2 === 'blocked', '頁面內攔下的點擊 → uiAct 回 blocked（不算點到）', rLayer2)
  detachPopupGuard(page)

  // 4. Join：大廳（沒掛 guard）可按；機台裡（掛 guard）兩層都擋
  await setup(page, `<button class="join" style="position:absolute;left:20px;top:20px;width:100px;height:40px" onclick="__ran.push('join')">Join</button>`)
  let join = await page.$('.join')
  ok((await uiAct(page, 'lobby', 'Join', join, () => join!.click({ timeout: 1000 }))) === 'clicked' && (await ran(page)).includes('join'), '大廳 Join → 按得到')
  await setup(page, `<button class="join" style="position:absolute;left:20px;top:20px;width:100px;height:40px" onclick="__ran.push('join')">Join</button>`)
  g = attachPopupGuard(page, emit, 'probe-4')
  await sleep(100)   // __mtInMachine 是非同步設的
  join = await page.$('.join')
  ok((await uiAct(page, 'exit', 'Join', join, () => join!.click({ timeout: 1000 }))) === 'blocked', '機台裡 Join（runner 層）→ blocked')
  await page.mouse.click(70, 40)
  ok(!(await ran(page)).includes('join'), '機台裡 Join（繞過 runner，頁面內層）→ handler 沒跑', await ran(page))
  detachPopupGuard(page)

  // 5. 點擊逾時：錯誤訊息講出蓋住它的元素
  await setup(page, `<div class="mask-layer"></div>`)
  const sp = await page.$('.spin-btn')
  let msg = ''
  try { await uiAct(page, 'game', 'SPIN', sp, () => sp!.click({ timeout: 800 })) } catch (e) { msg = String(e) }
  ok(/mask-layer/.test(msg) && /Timeout/i.test(msg), '逾時 → 訊息帶出蓋住的 .mask-layer、保留 TimeoutError', msg.slice(0, 140))

  // 6. 背景監看：擷取期間暫停、恢復立刻補掃
  await setup(page, '')
  g = attachPopupGuard(page, emit, 'probe-6')
  g.startWatch(30)
  g.pause()
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', `<div class="box-content"><div class="box-title">Do you want to reserve this machine?</div><span class="btn-close" onclick="__ran.push('x');this.parentNode.remove()">X</span></div>`) })
  await sleep(200)
  ok(!(await ran(page)).includes('x'), '暫停期間背景不點')
  await g.resume()
  ok((await ran(page)).includes('x'), '恢復 → 立刻補掃並關掉')

  // 7. 競態：遊戲點擊進行中出現可關的框 → 背景要等這下點完才動（同一把鎖）
  await setup(page, '')
  const order: string[] = []
  const sp7 = await page.$('.spin-btn')
  await uiAct(page, 'game', 'SPIN（慢）', sp7, async () => {
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', `<div class="box-content"><div class="box-title">Do you want to reserve this machine?</div><span class="btn-close" onclick="__ran.push('x');this.parentNode.remove()">X</span></div>`) })
    await sleep(250)
    order.push(`fn-end:${(await ran(page)).includes('x')}`)
  })
  await sleep(150)
  ok(order[0] === 'fn-end:false' && (await ran(page)).includes('x'), '遊戲點擊的鎖裡背景不會插進來；點完才關框', order)
  g.stopWatch()

  // 8. 帳號在別處登入 → stop（帳號）、擋遊戲、不點
  await setup(page, BOX('Your account is logged in from another device', `<span class="box-btn_text2" onclick="__ran.push('ok')">Confirm</span>`))
  await g.scan({ act: true, why: '同步' })
  ok(g.stop?.scope === 'account' && (await ran(page)).length === 0, '別處登入 → stop（換帳號）、Confirm 沒按', g.stop)
  const sp8 = await page.$('.spin-btn')
  ok((await uiAct(page, 'game', 'SPIN', sp8, () => sp8!.click({ timeout: 1000 }))) === 'blocked', '之後的 SPIN → blocked')
  detachPopupGuard(page)
  ok(!popupGuardOf(page), 'detach 後沒有 guard')

  // 9. cashout-credit：測試中不按（unknown），退出時才按 Confirm
  await setup(page, BOX('Cash out credit 1,000?', `<span class="box-btn_text2" onclick="__ran.push('cashout');this.parentNode.remove()">Confirm</span>`))
  g = attachPopupGuard(page, emit, 'probe-9')
  await g.scan({ act: true, why: '同步' })
  ok(!(await ran(page)).includes('cashout') && !!g.unknown, '測試中 Cash out credit → 不按、當 unknown')
  g.phase = 'exit'
  await g.scan({ act: true, why: '同步' })
  ok((await ran(page)).includes('cashout'), '退出時 Cash out credit → 按 Confirm')
  detachPopupGuard(page)
  // ── CodeX 56e3d1b 回歸 ──
  const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p.then(v => ({ v, timeout: false })), sleep(ms).then(() => ({ v: undefined as T | undefined, timeout: true }))])
  // 10. [P1] 面額框：scan（持鎖）→ dismissDenomOverlay → uiAct 不能互等
  await setup(page, `<script>
    function pickDenom(el){ __ran.push('denom'); el.parentNode.innerHTML = '<div class="my-button" style="width:80px;height:40px" onclick="pickYes()">YES</div><div class="my-button" style="width:80px;height:40px" onclick="pickNo()">NO</div>' }
    function pickYes(){ __ran.push('yes'); document.querySelector('.select-main').remove() }
    function pickNo(){ __ran.push('no') }
  </script><div class="select-main" style="position:fixed;left:20px;top:100px;width:380px;height:400px;background:#333">
    <div class="select-btn" style="width:100px;height:40px" onclick="pickDenom(this)">1</div></div>`)
  g = attachPopupGuard(page, emit, 'probe-10')
  const r10 = await within(g.scan({ act: true, why: '同步' }), 8000)
  ok(!r10.timeout, '[P1] 面額框在 scan 裡關 → 沒有死鎖', r10.timeout ? 'timeout' : 'ok')
  ok(JSON.stringify(await ran(page)) === '["denom","yes"]', '面額兩階段：選面額 → YES（不按 NO）', await ran(page))
  const sp10 = await page.$('.spin-btn')
  const r10b = await within(uiAct(page, 'game', 'SPIN', sp10, () => sp10!.click({ timeout: 1000 })), 3000)
  ok(!r10b.timeout && r10b.v === 'clicked', '之後的 SPIN 還拿得到鎖', r10b.v ?? 'timeout')
  detachPopupGuard(page)

  // 11. [P1] 退出的 Confirm 不能按到未知框
  await setup(page, BOX('Brand new mystery box', `<button class="box-btn_text2" onclick="__ran.push('mystery-confirm')">Confirm</button>`))
  g = attachPopupGuard(page, emit, 'probe-11')
  await g.scan({ act: true, why: '同步' })
  g.phase = 'exit'
  const c11 = await page.$('text=Confirm')
  ok((await uiAct(page, 'exit', '退出 Confirm', c11, () => c11!.click({ timeout: 1000 }))) === 'blocked' && !(await ran(page)).includes('mystery-confirm'), '[P1] 退出時未知框裡的 Confirm → blocked、handler 沒跑')
  detachPopupGuard(page)
  // 框外的 Confirm、但畫面上有未知框 → 也不按
  await setup(page, BOX('Brand new mystery box', '') + `<button class="loose" style="position:absolute;left:10px;top:10px;width:90px;height:30px" onclick="__ran.push('loose')">Confirm</button>`)
  g = attachPopupGuard(page, emit, 'probe-11b')
  await g.scan({ act: true, why: '同步' })
  const c11b = await page.$('.loose')
  ok((await uiAct(page, 'exit', '退出 Confirm', c11b, () => c11b!.click({ timeout: 1000 }))) === 'blocked' && !(await ran(page)).includes('loose'), '畫面有未知框時，框外的 Confirm → blocked')
  detachPopupGuard(page)
  // 已辨識的退出框（Cash out credit）→ 退出時照按
  await setup(page, BOX('Tips Cash out credit: 1,999,736', `<button class="box-btn_text2" onclick="__ran.push('cashout')">Confirm</button>`))
  g = attachPopupGuard(page, emit, 'probe-11c')
  g.phase = 'exit'
  const c11c = await page.$('text=Confirm')
  ok((await uiAct(page, 'exit', '退出 Confirm', c11c, () => c11c!.click({ timeout: 1000 }))) === 'clicked' && (await ran(page)).includes('cashout'), '退出時 Cash out credit 框的 Confirm → 照按')
  // stop 類的框（別處登入）→ 退出也不按它的 Confirm
  await setup(page, BOX('Your account is logged in from another device', `<button class="box-btn_text2" onclick="__ran.push('od')">Confirm</button>`))
  const c11d = await page.$('text=Confirm')
  ok((await uiAct(page, 'exit', '退出 Confirm', c11d, () => c11d!.click({ timeout: 1000 }))) === 'blocked' && !(await ran(page)).includes('od'), 'stop 類的框 → 退出的 Confirm 也不按')
  detachPopupGuard(page)

  // 12. [P2] 退出前等未知框：消失就放行；一直在就等到 30 秒門檻
  await setup(page, BOX('Brand new mystery box', ''))
  g = attachPopupGuard(page, emit, 'probe-12')
  await g.scan({ act: true, why: '同步' })
  setTimeout(() => { void page.evaluate(() => document.querySelector('.box-content')?.remove()) }, 300)
  const r12 = await within(g.settleUnknown(() => false, 100), 5000)
  ok(!r12.timeout && !g.unknown, '[P2] 未知框退出前消失 → 解除、不判定')
  await setup(page, BOX('Brand new mystery box', ''))
  await g.scan({ act: true, why: '同步' })
  g.unknown!.since = Date.now() - 29_500
  const r12b = await within(g.settleUnknown(() => false, 100), 5000)
  ok(!r12b.timeout && g.unknownExpired(), '[P2] 未知框一直在 → 等到滿 30 秒才往下（之後 popupStepBlock 記 unknown popup）')
  const stopFlag = { v: false }
  g.unknown!.since = Date.now()
  setTimeout(() => { stopFlag.v = true }, 300)
  const r12c = await within(g.settleUnknown(() => stopFlag.v, 100), 3000)
  ok(!r12c.timeout, '[P2] 等的期間按停止 → 立刻不等')
  detachPopupGuard(page)

  // 13. 背景計時器在鎖裡啟動，也不能繼承鎖（不然會插隊）
  await setup(page, '')
  g = attachPopupGuard(page, emit, 'probe-13')
  await g.withLock(async () => { g.startWatch(30) })
  const order13: string[] = []
  const sp13 = await page.$('.spin-btn')
  await uiAct(page, 'game', 'SPIN（慢）', sp13, async () => {
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', `<div class="box-content"><div class="box-title">Do you want to reserve this machine?</div><span class="btn-close" onclick="__ran.push('x');this.parentNode.remove()">X</span></div>`) })
    await sleep(250)
    order13.push(`fn-end:${(await ran(page)).includes('x')}`)
  })
  await sleep(150)
  ok(order13[0] === 'fn-end:false' && (await ran(page)).includes('x'), '鎖裡啟動的背景掃描 → 仍然排隊，不插隊', order13)
  detachPopupGuard(page)

  // 14. CCTV 前的 Lucky hour bonus：只按它自己框裡的 Confirm（旁邊的 Cash out 框不碰）
  await setup(page, BOX('Tips Lucky hour bonus has been transferred to the machine', `<span class="box-btn_text2" onclick="__ran.push('lhb');this.parentNode.remove()">Confirm</span>`)
    + `<div class="my-dialog" style="position:fixed;left:24px;top:480px;width:380px;height:200px;background:#432;color:#fff"><div>Cash out credit: 1,000</div><span class="box-btn_text2" onclick="__ran.push('cashout')">Confirm</span></div>`)
  g = attachPopupGuard(page, emit, 'probe-14')
  await g.scan({ act: true, why: 'CCTV 前' })
  ok(JSON.stringify(await ran(page)) === '["lhb"]', 'Lucky hour bonus → 只按它的 Confirm、Cash out 不碰', await ran(page))
  detachPopupGuard(page)
  // 15. CodeX c3831fe：讀不到框資訊 → 一律不按（guard 還沒記到任何框也一樣）
  await setup(page, BOX('Tips Cash out credit: 1,000', `<button class="box-btn_text2">Confirm</button>`))
  g = attachPopupGuard(page, emit, 'probe-15')
  g.phase = 'exit'
  const stale = await page.$('text=Confirm')
  await setup(page, '')   // 換頁 → 舊的 handle 讀不到
  let fnRan15 = false
  const r15 = await uiAct(page, 'exit', '退出 Confirm（讀不到）', stale, async () => { fnRan15 = true })
  ok(r15 === 'blocked' && !fnRan15 && !g.unknown && !g.stop, '[P1] 讀不到框資訊、guard 沒有未知框 → 仍然 blocked、fn 沒跑', r15)
  let fnRan15b = false
  ok((await uiAct(page, 'popup', '沒有元素', null, async () => { fnRan15b = true })) === 'blocked' && !fnRan15b, '沒有元素的關框點擊 → blocked')
  // wait 框（Quit game, please wait）的 Confirm 也不按
  await setup(page, BOX('Quit game, please wait...', `<button class="box-btn_text2" onclick="__ran.push('qw')">Confirm</button>`))
  const c15 = await page.$('text=Confirm')
  ok((await uiAct(page, 'exit', '退出 Confirm', c15, () => c15!.click({ timeout: 1000 }))) === 'blocked' && !(await ran(page)).includes('qw'), '[P2] wait 框的 Confirm → blocked、handler 沒跑')
  detachPopupGuard(page)
  // 16. CodeX 19d3b6b：CCTV 前清遮罩——未辨識的 bonus-popup、框外有關閉鍵 → 零操作（不點框外、不點本體、不送 Escape），回 blocked
  await setup(page, `<div class="bonus-popup-layer" style="position:fixed;left:20px;top:100px;width:380px;height:400px;background:#a60;color:#fff" onclick="__ran.push('body')">BIG WIN 12,345</div>
    <button class="close-btn" style="position:absolute;left:10px;top:10px;width:60px;height:30px" onclick="__ran.push('outside-close')">X</button>
    <script>addEventListener('keydown', e => { if (e.key === 'Escape') __ran.push('esc') })</script>`)
  g = attachPopupGuard(page, emit, 'probe-16')
  const r16 = await clearCctvOverlays(page, emit)
  ok(r16.blocked.length > 0 && (await ran(page)).length === 0, '未辨識的 bonus-popup＋框外關閉鍵 → 一下都沒點、沒送 Escape、回 blocked', { blocked: r16.blocked, ran: await ran(page) })
  detachPopupGuard(page)
  // 一般遮罩（div.bg，不是提示框）裡面有自己的關閉鍵 → 照關
  await setup(page, `<div class="bg" style="position:fixed;left:20px;top:100px;width:380px;height:400px;background:#036"><button class="close-btn" style="width:60px;height:30px" onclick="__ran.push('inside-close');this.parentNode.remove()">X</button></div>`)
  g = attachPopupGuard(page, emit, 'probe-16b')
  const r16b = await clearCctvOverlays(page, emit)
  ok(r16b.blocked.length === 0 && JSON.stringify(await ran(page)) === '["inside-close"]', '一般遮罩 → 按它自己的關閉鍵', await ran(page))
  detachPopupGuard(page)
  // 17. CodeX 2993fdf：同一輪多個遮罩——第一個被擋就整個停，後面的遮罩（float-layer 裡有自己的關閉鍵）也不處理
  await setup(page, `<div class="bonus-popup-layer" style="position:fixed;left:20px;top:100px;width:380px;height:300px;background:#a60" onclick="__ran.push('body')">BIG WIN</div>
    <div class="float-layer" style="position:fixed;left:20px;top:420px;width:380px;height:200px;background:#063"><button class="close-btn" style="width:60px;height:30px" onclick="__ran.push('float-close')">X</button></div>`)
  g = attachPopupGuard(page, emit, 'probe-17')
  const r17 = await clearCctvOverlays(page, emit)
  ok(r17.blocked.length === 1 && (await ran(page)).length === 0, '[P2] 第一個遮罩被擋 → 同一輪後面的遮罩也不點', { blocked: r17.blocked, ran: await ran(page) })
  // 被擋的留證：照當下畫面截，連 JACKPOT 廣播卡的 X 都不點
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', `<div class="content" style="position:fixed;left:20px;top:20px;width:300px;height:60px"><span class="view">View</span><span class="notification-close" style="display:inline-block;width:20px;height:20px" onclick="__ran.push('jp-close')">x</span></div>`) })
  const ev17 = await saveCctvEvidenceShot(page, emit, 'PROBE-17', 'probe-', true)
  ok(!!ev17 && !(await ran(page)).includes('jp-close'), '[P2] 被擋的留證 → 零點擊（JP 卡的 X 也不按）', { ev: ev17, ran: await ran(page) })
  const ev17b = await saveCctvEvidenceShot(page, emit, 'PROBE-17', 'probe-', false)
  ok(!!ev17b && (await ran(page)).includes('jp-close'), '一般留證 → 照舊先關 JP 卡（對照組）', await ran(page))
  detachPopupGuard(page)
} finally {
  await browser.close()
}
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)

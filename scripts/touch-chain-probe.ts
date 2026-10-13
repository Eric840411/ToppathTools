// 觸屏盒子三層判定的接線探針（v5.51.0，spec #2）：npx tsx scripts/touch-chain-probe.ts
// 真的 stepTouchscreen＋真瀏覽器、假頁面（兩個「列,行」span）＋假的 daily-analysis（stub 全域 fetch）。
// 驗的是 runner 真的用三層結果判：0237 那種「盒子送了、機台沒回」原本 matched.length＝2 → PASS 2/2。
// ⚠️ 每格點完等 5 秒、最後等 15 秒同步，一個情境約 25 秒
import { chromium } from 'playwright'
import { stepTouchscreen } from '../server/machine-test/runner.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${got !== undefined ? `：${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`) }

const at = (s: number) => { const d = new Date(Date.now() - 60_000 + s * 1000); return d.toTimeString().slice(0, 8) }
const S = (s: number, cmd: string) => ({ time: at(s), type: 'success_json', data: { cmd, error: 0, is_ideck: true, is_touch: true } })
const U = (s: number, coord: string) => ({ time: at(s), type: 'usb_coordinate', data: { coord } })
const H = (s: number) => ({ time: at(s), type: 'hw_response', data: { raw: 'x' } })
const END = (s: number) => ({ time: at(s), type: 'recv_msg', data: {} })

// 第一次 fetch＝點擊前基準（空），之後回 scenario 的 timeline
let scenario: unknown[] = [], calls = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).includes('daily-analysis')) { calls++; return new Response(JSON.stringify({ success: true, data: { timeline: calls === 1 ? [] : scenario } }), { headers: { 'content-type': 'application/json' } }) }
  return realFetch(url as never, init)
}) as typeof fetch

const html = `<!doctype html><div class="screen-touch"><span style="display:inline-block;width:40px;height:40px">6,4</span><span style="display:inline-block;width:40px;height:40px">8,4</span></div>`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.route('http://probe.local/**', r => r.fulfill({ contentType: 'text/html', body: html }))
const run = async (tl: unknown[]) => { scenario = tl; calls = 0; await page.goto(`http://probe.local/game/${Date.now()}`); return stepTouchscreen(page, () => {}, '873-PROBE-0001', { touchPoints: ['6,4', '8,4'] } as never, () => false, undefined, 'probe-') }
try {
  let r = await run([S(0, '6,4'), U(1, '6,4'), H(1), S(6, '8,4'), U(6, '8,4'), H(7), END(40)])
  ok(r.status === 'pass' && /API 確認 2\/2/.test(r.message), '正常：兩格三層都齊 → PASS 2/2', `${r.status}｜${r.message.slice(-120)}`)
  r = await run([S(0, '6,4'), U(1, '6,4'), S(6, '8,4'), U(6, '8,4'), END(40)])
  ok(r.status === 'fail' && /判定：no response（機台不回應：6,4、8,4）/.test(r.message), '⚠️ 0237 型：盒子送了、機台沒回 → FAIL no response（原本 PASS 2/2）', `${r.status}｜${r.message.slice(-140)}`)
  ok(/API 確認 0\/2/.test(r.message), '「API 確認」改算三層齊的格數（0/2）', r.message.match(/API 確認 \d+\/\d+/)?.[0])
  r = await run([S(0, '6,4'), S(6, '8,4'), END(40)])
  ok(r.status === 'fail' && /判定：flow fail（盒子沒送到機台/.test(r.message), '0245 型：盒子沒送 usb → FAIL flow fail', `${r.status}｜${r.message.slice(-120)}`)

  // ── iDeck：server 都 ack、盒子確定送了指令、機台一筆都沒回 → WARN（文案照 CodeX）──
  const BTNS = [{ name: 'Bet0', text: 'BET 18', aid: 10 }, { name: 'Bet1', text: 'BET 28', aid: 11 }]
  const ideckHtml = `<!doctype html><script>
window.__moneyLog = [{ seq: 1, coin: 1000, reason: 'begin', ts: Date.now() }, { seq: 2, coin: 1000, reason: 'end', ts: Date.now() }]; let rseq = 100;
const BTNS = ${JSON.stringify(BTNS)};
function press(i){ const b = BTNS[i]; const s = ++rseq;
  console.log('dealGMActionReq: ' + s + ' ' + b.name + ' ' + b.aid)
  console.log('SEND: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid, isspin: 0 })
  setTimeout(() => console.log('ON: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid }), 80) }
</script>${BTNS.map((b, i) => `<div class="btn_bet" id="b${i}" style="width:80px;height:40px;margin:4px" onclick="press(${i})">${b.text}</div>`).join('')}`
  await page.route('http://probe.local/ideck/**', rr => rr.fulfill({ contentType: 'text/html', body: ideckHtml }))
  const { stepIdeck } = await import('../server/machine-test/runner.js')
  const ideckRun = async (tl: unknown[]) => { scenario = tl; calls = 0; await page.goto(`http://probe.local/ideck/${Date.now()}`); return stepIdeck(page, () => {}, '873-PROBE-0001', undefined, undefined, ['//*[@id="b0"]', '//*[@id="b1"]'], () => false, undefined, 'probe-') }
  const I = (s: number, cmd: string) => ({ time: at(s), type: 'success_json', data: { cmd, error: 0, is_ideck: true, is_touch: true } })
  r = await ideckRun([I(0, 'BET18'), U(1, '?'), I(6, 'BET28'), U(6, '?'), END(40)])
  ok(r.status === 'warn' && /server 已回應；盒子已送出 2 筆，觀察窗口內未見機台回應/.test(r.message), '⚠️ iDeck：server 都回應、盒子送了 2 筆、機台 0 回應 → WARN（原本 PASS）', `${r.status}｜${r.message.slice(0, 200)}`)
  r = await ideckRun([I(0, 'BET18'), U(1, '?'), H(1), I(6, 'BET28'), U(6, '?'), H(7), END(40)])
  ok(r.status === 'pass' && /機台回應 2/.test(r.message), 'iDeck：機台有回應 → PASS，訊息寫出三層數字', `${r.status}｜${r.message.slice(0, 200)}`)
} finally { await browser.close(); globalThis.fetch = realFetch }

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)

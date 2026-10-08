// 1008 學習專用下注規則（betRules:'learn'）：Spin 前最小注＋iDeck 族群由小到大、開局族群不按大注；關著＝原本 /machine-test 行為。
//   npx tsx scripts/min-bet-family-probe.ts
// 真瀏覽器、假遊戲頁（照正式格式印 dealGMActionReq／SEND／ON／moneyNtc、寫 __moneyLog），跑**真的** stepIdeck 與 ensureMinBet。
import { chromium, type Page } from 'playwright'
import { stepIdeck, ensureMinBet, setBetRules } from '../server/machine-test/runner.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`) }

type Btn = { name: string; text: string; aid: number; round?: boolean }
const page_ = (btns: Btn[]) => `<!doctype html><script>
window.__moneyLog = []; window.__clicks = []; let mseq = 0, rseq = 100, coin = 1000;
function money(reason){ window.__moneyLog.push({ seq: ++mseq, coin, reason, ts: Date.now() }); console.log('moneyNtc', { reason, coin }) }
function press(i){ const b = BTNS[i]; window.__clicks.push(b.text); const s = ++rseq;
  console.log('dealGMActionReq: ' + s + ' ' + b.name + ' ' + b.aid)
  console.log('SEND: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid, isspin: 0 })
  setTimeout(() => console.log('ON: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid }), 80)
  if (b.round) setTimeout(() => { coin -= 9; money('begin'); setTimeout(() => money('end'), 600) }, 400)
}
const BTNS = ${JSON.stringify(btns)};
money('begin'); money('end')
</script>${btns.map((b, i) => `<div class="btn_bet" style="width:110px;height:40px;margin:4px;display:inline-block" onclick="press(${i})">${b.text}</div>`).join('')}`
let html = ''
const browser = await chromium.launch({ headless: true })
const page: Page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
await page.route('http://probe.local/**', r => r.fulfill({ contentType: 'text/html', body: html }))
const load = async (btns: Btn[]) => { html = page_(btns); await page.goto(`http://probe.local/game/${Date.now()}`) }
const clicks = () => page.evaluate(() => (window as any).__clicks as string[])
try {
  // ── 關著（/machine-test 預設）：跟 v5.40 之前一樣——DOM 順序全按、最後照舊按回 BetMultiple1 ──
  setBetRules(undefined)
  const OFF_ARUZE: Btn[] = [
    { name: 'Bet88', text: 'PLAY 88 Credits', aid: 88 }, { name: 'Bet9', text: 'PLAY 9 Credits', aid: 9 },
    { name: 'BetMultiple2', text: 'BETx2', aid: 2, round: true }, { name: 'BetMultiple1', text: 'BETx1', aid: 1, round: true },
  ]
  await load(OFF_ARUZE)
  const off1 = await stepIdeck(page, () => {}, '', undefined, undefined, undefined, () => false, undefined, 'probe-')
  const oc1 = await clicks()
  ok(JSON.stringify(oc1) === '["PLAY 88 Credits","PLAY 9 Credits","BETx2","BETx1","BETx1"]', '關著：DOM 順序全按（含開局的 x2），最後按回 x1（v5.40 之前）', oc1)
  ok(!/略過|不還原/.test(off1.message), '關著：沒有略過、沒有不還原', off1.message)
  const OFF_DFDC: Btn[] = [
    { name: 'BetMultiple1', text: 'BETx1', aid: 1 }, { name: 'BetMultiple2', text: 'BETx2', aid: 2 }, { name: 'BetMultiple10', text: 'BETx10', aid: 10 },
    { name: 'Bet8', text: 'PLAY 8 Credits', aid: 8, round: true }, { name: 'Bet18', text: 'PLAY 18 Credits', aid: 18, round: true }, { name: 'Bet88', text: 'PLAY 88 Credits', aid: 88, round: true },
  ]
  await load(OFF_DFDC)
  await stepIdeck(page, () => {}, '', undefined, undefined, undefined, () => false, undefined, 'probe-')
  ok(JSON.stringify(await clicks()) === '["BETx1","BETx2","BETx10","PLAY 8 Credits","PLAY 18 Credits","PLAY 88 Credits","BETx1"]', '關著：DFDC 也是 DOM 順序全按、最後按回 x1', await clicks())

  // ── 開著（batch --learn） ──
  setBetRules('learn')
  // DOM 順序故意打亂：88 在 9 前面、x2 在 x1 前面
  const ARUZE_LIKE: Btn[] = [
    { name: 'Bet88', text: 'PLAY 88 Credits', aid: 88 }, { name: 'Bet9', text: 'PLAY 9 Credits', aid: 9 },
    { name: 'BetMultiple2', text: 'BETx2', aid: 2, round: true }, { name: 'BetMultiple1', text: 'BETx1', aid: 1, round: true },
  ]
  await load(ARUZE_LIKE)
  const r = await stepIdeck(page, () => {}, '', undefined, undefined, undefined, () => false, undefined, 'probe-')
  const c = await clicks()
  ok(JSON.stringify(c.slice(0, 3)) === '["PLAY 9 Credits","PLAY 88 Credits","BETx1"]', '族群由小到大：9 → 88 → x1（x1 先於 x2）', c)
  ok(!c.includes('BETx2'), '倍數族群的 x1 會開局 → 比它大的 x2 不按（避免大注）', c)
  ok(c.filter(t => t === 'PLAY 9 Credits').length === 2 && c[c.length - 1] === 'PLAY 9 Credits', '還原：最後按回最小 Credits（PLAY 9），倍數是開局鍵所以不再按 x1', c)
  ok(/略過 1 顆（BETx2：/.test(r.message) && /不還原倍數（倍數鍵是開局鍵/.test(r.message), '訊息寫出略過哪顆、為什麼不還原', r.message)
  ok(r.status !== 'fail' || !/flow fail/.test(r.message), '略過與不還原不算流程失敗', { status: r.status, message: r.message })

  // ensureMinBet：Credits 族群不開局、倍數族群 x1 開局 → 不能 SPIN
  await load(ARUZE_LIKE)
  const m1 = await ensureMinBet(page, () => {})
  ok(m1.ok === false && /BETx1.*開了一局/.test(m1.ok === false ? m1.why : ''), 'Spin 前設最小注：x1 是開局鍵 → 不 SPIN（回原因）', m1)
  // 都不開局 → 可以 SPIN，而且按的是最小那幾顆
  await load([{ name: 'Bet88', text: 'PLAY 88 Credits', aid: 88 }, { name: 'Bet9', text: 'PLAY 9 Credits', aid: 9 }, { name: 'BetMultiple2', text: 'BETx2', aid: 2 }, { name: 'BetMultiple1', text: 'BETx1', aid: 1 }])
  const m2 = await ensureMinBet(page, () => {})
  const c2 = await clicks()
  ok(m2.ok === true && JSON.stringify(c2) === '["PLAY 9 Credits","BETx1"]', 'Spin 前設最小注：只按 PLAY 9＋x1、兩顆都確認 → 可以 SPIN', { m2, c2 })
  // 沒有下注鍵 → 不 SPIN
  await load([{ name: 'X', text: 'MAX BET', aid: 5 }])
  const m3 = await ensureMinBet(page, () => {})
  ok(m3.ok === false && /看不懂/.test(m3.ok === false ? m3.why : ''), '下注鍵的字看不懂 → 不 SPIN', m3)
} finally { await browser.close() }
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)

// iDeck：profile 有設、卻解析不到的 xpath 不能被跳過（1013 LIONLINK，osm-qa-agent spec #1-2，CodeX 同意）
//   npx tsx scripts/ideck-missing-xpath-probe.ts
// 真的 stepIdeck＋真瀏覽器、假遊戲頁：3 條 xpath，第 2 條開頭多一個 b（照 LIONLINK ideckXpaths[2] 的錯字）找不到元素。
// 修之前：那一顆只 emit「跳過」、不進 outcomes → PASS 2/2。修之後：outcomes 有一筆 noElement → FAIL（flow fail）
// ⚠️ stepIdeck 固定等 15 秒盒子 log，整支約 20 秒
import { chromium } from 'playwright'
import { stepIdeck } from '../server/machine-test/runner.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${got !== undefined ? `：${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`) }

const BTNS = [{ name: 'BetMultiple1', text: 'BETx1', aid: 1 }, { name: 'BetMultiple3', text: 'BETx3', aid: 3 }, { name: 'Bet0', text: 'BET 18', aid: 10 }]
const html = `<!doctype html><script>
window.__moneyLog = [{ seq: 1, coin: 1000, reason: 'begin', ts: Date.now() }, { seq: 2, coin: 1000, reason: 'end', ts: Date.now() }]; let rseq = 100;
const BTNS = ${JSON.stringify(BTNS)};
function press(i){ const b = BTNS[i]; const s = ++rseq;
  console.log('dealGMActionReq: ' + s + ' ' + b.name + ' ' + b.aid)
  console.log('SEND: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid, isspin: 0 })
  setTimeout(() => console.log('ON: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid }), 80) }
</script>${BTNS.map((b, i) => `<div class="btn_bet" id="b${i}" style="width:80px;height:40px;margin:4px" onclick="press(${i})">${b.text}</div>`).join('')}`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.route('http://probe.local/**', r => r.fulfill({ contentType: 'text/html', body: html }))
try {
  await page.goto('http://probe.local/game/1')
  const lines: string[] = []
  // 第 2 條＝LIONLINK 的錯字（開頭多一個 b），解析不到元素
  const xpaths = ['//*[@id="b0"]', 'b//*[@id="b1"]', '//*[@id="b2"]']
  const r = await stepIdeck(page, m => lines.push(m), '', undefined, undefined, xpaths, () => false, undefined, 'probe-')
  ok(r.status === 'fail', '⚠️ 有一條 xpath 找不到 → 不能 PASS（判 FAIL）', `${r.status}｜${r.message.slice(0, 160)}`)
  ok(/xpath\[2\]「」noElement\(profile xpath 找不到元素\)/.test(r.message), '訊息指名是 xpath[2]、noElement', r.message.slice(0, 260))
  ok(/判定：flow fail/.test(r.message), '找不到元素算流程失敗（不是 no response）')
  ok(/server 回應 2\/3/.test(r.message), '分母算進找不到的那條（2/3，不是 2/2）', r.message.slice(0, 80))
  ok(lines.some(l => /xpath\[2\] ⚠️ 找不到元素（記成 noElement/.test(l)), '日誌寫明記成 noElement')

  // 對照：三條都找得到 → 不會因為這個改動變紅（盒子 log 查不到時照舊依 server 回應判）
  await page.goto('http://probe.local/game/2')
  const r2 = await stepIdeck(page, () => {}, '', undefined, undefined, ['//*[@id="b0"]', '//*[@id="b1"]', '//*[@id="b2"]'], () => false, undefined, 'probe-')
  ok(!/noElement/.test(r2.message) && /server 回應 3\/3/.test(r2.message), '對照：三條都找得到 → 沒有 noElement、3/3', `${r2.status}｜${r2.message.slice(0, 120)}`)
} finally { await browser.close() }

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)

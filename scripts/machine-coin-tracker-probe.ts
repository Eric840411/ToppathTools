// 機台餘額只收 moneyNtc（1007，0330 少 315 億的修正）：npx tsx scripts/machine-coin-tracker-probe.ts
// 把注入頁面的 PINUS_TRACKER_SCRIPT 放進假 window 跑，重放 0322／0324 退出流程的訊息順序
// （osm-qa-agent/reports/aruze-0330-balance-evidence-1006.txt）：機台 moneyNtc ≈ 200 萬，退出時大廳錢包回傳 315 億。
import vm from 'node:vm'
import { PINUS_TRACKER_SCRIPT, parseCashOutCredit } from '../server/machine-test/runner.js'

type Cb = (d: unknown) => void
function page() {
  const listeners: Record<string, Cb[]> = {}
  const pending: Array<(resp: unknown) => void> = []
  const pinus = {
    request(_route: string, _msg: unknown, cb: (r: unknown) => void) { pending.push(cb) },
    on(route: string, cb: Cb) { (listeners[route] ??= []).push(cb) },
  }
  const win: Record<string, unknown> = { pinus }
  const ctx = vm.createContext({ window: win, Date, setInterval: (fn: () => void) => { fn(); return 0 } })
  vm.runInContext(PINUS_TRACKER_SCRIPT, ctx)
  // 遊戲在 patch 之後才註冊推播監聽（真實情況：tracker 先注入）
  for (const r of ['moneyNtc', 'leaveGMNtc', 'userInfoNtc']) (win.pinus as typeof pinus).on(r, () => {})
  const push = (route: string, data: unknown) => (listeners[route] ?? []).forEach(cb => cb(data))
  const request = (resp: unknown) => { (win.pinus as typeof pinus).request('hall.x', {}, () => {}); pending.shift()?.(resp) }
  return { win, push, request }
}

let fail = 0
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}：${JSON.stringify(got)}${ok ? '' : `（預期 ${JSON.stringify(want)}）`}`)
}

{
  const p = page()
  check('剛進機台、還沒有 moneyNtc → 機台餘額 null', p.win.__lastMachineCoin, null)
  p.request({ coin: 31_566_687_267.61 })              // 大廳錢包（進場時的回應）
  check('request 回應帶錢包 coin → 不算機台餘額', p.win.__lastMachineCoin, null)
  p.push('moneyNtc', { coin: 1_997_880, reason: 'begin' })
  p.push('moneyNtc', { coin: 2_000_000, reason: 'end' })
  check('moneyNtc → 機台餘額', p.win.__lastMachineCoin, 2_000_000)
  // 0322／0324：按了 Quit 之後伺服器回大廳錢包（request 回應與其他推播都帶 coin）
  p.request({ coin: 31_566_687_267.61, errcode: 0 })
  p.push('leaveGMNtc', { coin: 31_564_684_870.61 })
  p.push('userInfoNtc', { coin: 31_564_684_870.61 })
  check('退出時錢包 coin（request／其他路由）→ 機台餘額不被蓋掉（不會出現 315 億）', p.win.__lastMachineCoin, 2_000_000)
  check('__lastCoin 照舊會被錢包蓋（證明情境真的重現了）', p.win.__lastCoin, 31_564_684_870.61)
  check('moneyNtc 流水有 reason／seq', (p.win.__moneyLog as Array<{ seq: number; reason: string }>).map(e => `${e.seq}:${e.reason}`), ['1:begin', '2:end'])
}
check('Tips「Cash out credit:  1,997,880」（兩個空白）→ 1997880', parseCashOutCredit('Tips / Cash out credit:  1,997,880'), 1_997_880)
check('沒有 Cash out credit 字樣 → null', parseCashOutCredit('Tips / cannot be quit'), null)

console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

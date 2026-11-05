/**
 * 逐局餘額檢查的回歸。跑法：npx tsx server/live-compare-chain.test.ts
 * fixture：QAT 2026-11-04 一個測試帳號整天的真資料（去識別化），每一段都是好的——
 * 先證明真資料全過，再把壞的注入回去，確認紅在預期那一條。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normalizeRound, normalizeCredit, checkChains, summarize, tokenFromRoundid, parseReference,
  type ChainRound, type CreditTx,
} from './live-compare-chain.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/live-compare/qat-1104-session-chain.json', import.meta.url)), 'utf8')) as { gameRecord: Record<string, unknown>[]; creditLog: Record<string, unknown>[] }
const R0 = fx.gameRecord.map(normalizeRound).filter((x): x is ChainRound => !!x)
const C0 = fx.creditLog.map(normalizeCredit).filter((x): x is CreditTx => !!x)
eq('fixture 每筆 GR 都解析得出', R0.length, fx.gameRecord.length)
eq('fixture 每筆 Credit Log 都解析得出', C0.length, fx.creditLog.length)
eq('fixture 每局都拆得出進機台編號', R0.filter(r => !r.token).length, 0)

const DFDC = '873-DFDCGRAND-0144'
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
/** 預設在資料之後一天檢查（斷點都超過寬限）；要測「剛發生」就傳 now */
const LATER = Date.UTC(2026, 10, 5)
const run = (rs: ChainRound[], cs: CreditTx[], gmid = DFDC, now = LATER) => checkChains(rs, cs, gmid, now)

// ── 真資料全過 ──
for (const gmid of [...new Set(R0.map(r => r.gmid))]) {
  const x = run(R0, C0, gmid)
  eq(`真資料 ${gmid} 沒有異常`, summarize(x).anomaly, 0)
  eq(`真資料 ${gmid} 每段都是通過`, x.sessions.map(s => s.verdict).filter(v => v !== 'ok'), [])
}
const base = run(R0, C0)
eq('DFDC 有 3 段進機台', base.sessions.length, 3)
eq('DFDC 4 局', summarize(base).rounds, 4)
// 截圖那個「999,964 → 1,000,000」是兩段不同的進機台，不是斷鏈
eq('離開再進來不算斷鏈', base.sessions[0].rounds.map(r => r.after), [999982, 999964])
eq('下一段從帶入上限開始', base.sessions[1].inAmount, 1000000)

// ── 注入：每條規則都要紅在自己那一條 ──
const firstOf = (x: ReturnType<typeof run>, i = 0) => x.sessions[i]
{ // 中間局 Before 被改 → 前後局斷
  const rs = clone(R0); const r = rs.find(r => r.orderId === base.sessions[0].rounds[1].orderId)!
  r.before = 999990; r.after = 999990 - r.bet + r.win
  const s = firstOf(run(rs, C0))
  eq('Before 被改 → 異常', s.verdict, 'anomaly')
  eq('Before 被改 → 紅在前後局', s.rounds[1].problems.some(p => p.includes('上一局 After')), true)
}
{ // After 算錯（少派彩）
  const rs = clone(R0); const r = rs.find(r => r.gmid === DFDC && r.win === 5)!
  r.after = (r.after ?? 0) - 5
  const s = run(rs, C0).sessions[1]
  eq('After 算錯 → 異常', s.verdict, 'anomaly')
  eq('After 算錯 → 紅在列內公式', s.rounds[0].problems.some(p => p.includes('Before − Bet')), true)
  eq('After 算錯 → 也跟轉出對不上', s.rounds[0].problems.some(p => p.includes('轉出')), true)
}
{ // Lose/Win 欄錯
  const rs = clone(R0); const r = rs.find(r => r.gmid === DFDC && r.win === 5)!
  r.playerWin = 5
  eq('Lose/Win 錯 → 紅', run(rs, C0).sessions[1].rounds[0].problems.some(p => p.startsWith('Lose/Win')), true)
}
{ // 漏一局（中間那局不見）→ 下一局接不上
  const rs = clone(R0).filter(r => r.orderId !== base.sessions[0].rounds[0].orderId)
  const s = run(rs, C0).sessions[0]
  eq('漏首局（過了寬限）→ 異常', s.rounds[0].verdict, 'anomaly')
  eq('漏首局 → 紅在首局對轉入', s.rounds[0].problems.some(p => p.includes('轉入')), true)
  // 剛發生：可能只是 Game Record 晚到，不判錯
  const fresh = run(rs, C0, DFDC, s.rounds[0].betAt + 30_000).sessions[0]
  eq('漏首局（剛發生）→ 等待入帳', fresh.rounds[0].verdict, 'wait')
  eq('漏首局（剛發生）→ 段落待確認', fresh.verdict, 'pending')
}
{ // 轉出已到、最後一局 Game Record 晚到（CodeX 3f471e7 P1）
  const s0 = base.sessions[0]
  const rs = clone(R0).filter(r => r.orderId !== s0.rounds[1].orderId)
  const fresh = run(rs, C0, DFDC, (s0.outAt ?? 0) + 30_000).sessions[0]
  eq('末局晚到（剛轉出）→ 不判異常', fresh.rounds[0].verdict, 'wait')
  eq('末局晚到（過了寬限）→ 異常', run(rs, C0).sessions[0].rounds[0].verdict, 'anomaly')
}
{ // 缺欄位不能補 0 假通過（CodeX 3f471e7 P1）
  const raws = clone(fx.gameRecord.filter(r => r.uid === DFDC))
  for (const r of raws) { delete r.playerWin; delete r.bet_nima }
  const rs = raws.map(normalizeRound).filter((x): x is ChainRound => !!x)
  const sm = summarize(run(rs, C0))
  eq('缺 Lose/Win＋泥碼 → 一局都不算通過', sm.ok, 0)
  eq('缺欄位 → 未檢查', sm.unknown, 4)
  eq('缺欄位 → 不是異常', sm.anomaly, 0)
}
{ // 重複（分頁重疊）→ 去重後照樣通過
  const x = run([...R0, ...clone(R0)], C0)
  eq('重複局去重', summarize(x).rounds, 4)
  eq('重複局去重後無異常', summarize(x).anomaly, 0)
}
{ // 轉出還沒拿到 → 待確認，不判錯
  const cs = C0.filter(c => !(c.gmid === DFDC && c.dir === 'out' && c.amount === 999964))
  const s = run(R0, cs).sessions[0]
  eq('沒轉出 → 待確認', s.verdict, 'pending')
  eq('沒轉出 → 說明', s.notes.some(n => n.includes('尚未取得轉出')), true)
}
{ // 轉入在查詢起點之前 → 待確認
  const cs = C0.filter(c => !(c.gmid === DFDC && c.dir === 'in' && c.at < base.sessions[0].rounds[0].betAt && c.at > base.sessions[0].rounds[0].betAt - 60_000))
  eq('沒轉入 → 待確認', run(R0, cs).sessions[0].verdict, 'pending')
}
{ // 同一次進機台兩筆轉入 → 不硬湊
  const s0 = base.sessions[0]
  const extra = { ...C0.find(c => c.gmid === DFDC && c.dir === 'in' && c.token === s0.token)!, at: 1, amount: 36 }
  eq('兩筆轉入 → 待確認', run(R0, [...C0, extra]).sessions[0].verdict, 'pending')
  // 中途轉入 36（寶箱類）：第二局起餘額都多 36——規則要停用，不能報斷鏈（CodeX 3f471e7 P2）
  const rs = clone(R0); const r2 = rs.find(r => r.orderId === s0.rounds[1].orderId)!
  r2.before! += 36; r2.after! += 36
  const mid = { ...extra, at: s0.rounds[1].betAt - 1000 }
  const x = run(rs, [...C0, mid]).sessions[0]
  eq('中途轉入 → 不報異常', x.rounds.map(r => r.verdict), ['ok', 'ok'])
  eq('中途轉入 → 待確認', x.verdict, 'pending')
}
{ // 沒帶泥碼卻扣了泥碼
  const rs = clone(R0); rs.find(r => r.gmid === DFDC)!.betNima = 10
  const x = run(rs, C0)
  eq('沒帶泥碼卻有 bet_nima → 異常', x.sessions.some(s => s.rounds.some(r => r.problems.some(p => p.includes('沒帶泥碼')))), true)
}
{ // bet_nima 超過 bet
  const rs = clone(R0); rs.find(r => r.gmid === DFDC)!.betNima = 999
  eq('bet_nima > bet → 異常', summarize(run(rs, C0)).anomaly, 1)
}
{ // JP 局：After 端不驗，標含 JP
  const rs = clone(R0); const r = rs.find(r => r.gmid === DFDC && r.win === 5)!
  r.hasJp = true; r.after = (r.after ?? 0) + 50000
  const x = run(rs, C0)
  eq('JP 局不判異常', x.sessions[1].rounds[0].verdict, 'jp')
  eq('JP 局不算進通過（畫面不能全綠）', summarize(x).ok, 3)
}
{ // 同時間兩局 → 順序不唯一
  const rs = clone(R0); const s0 = base.sessions[0]
  rs.find(r => r.orderId === s0.rounds[1].orderId)!.betAt = s0.rounds[0].betAt
  eq('同時間兩局 → 待確認', run(rs, C0).sessions[0].verdict, 'pending')
  // 同時間時排序可能顛倒，首尾也不能比（CodeX 3f471e7 P2）
  const sw = rs.find(r => r.orderId === s0.rounds[1].orderId)!
  sw.orderId = '0' + sw.orderId   // 讓它排到前面
  eq('同時間兩局排序顛倒 → 不報異常', summarize(run(rs, C0)).anomaly, 0)
}
{ // roundid 拆不出編號 → 不可判定，不判錯
  const raw = clone(fx.gameRecord.find(r => r.uid === DFDC)!); raw.roundid = 'xxx'
  const r = normalizeRound(raw)!
  const x = run([r], [])
  eq('拆不出編號 → unknown', x.unkeyed.map(u => u.verdict), ['unknown'])
}

// ── 鍵要精確，不能只比結尾 ──
eq('roundid 拆 token', tokenFromRoundid('dfdcgrand873-DFDCGRAND-01449000011a1a5c14a57', 'dfdcgrand', '873-DFDCGRAND-0144', '900001'), '1a1a5c14a57')
eq('roundid 別台不收', tokenFromRoundid('dfdcgrand873-DFDCGRAND-01459000011a1a5c14a57', 'dfdcgrand', '873-DFDCGRAND-0144', '900001'), '')
eq('roundid 別人不收', tokenFromRoundid('dfdcgrand873-DFDCGRAND-01449000021a1a5c14a57', 'dfdcgrand', '873-DFDCGRAND-0144', '900001'), '')
eq('reference 拆', parseReference('dfdcgrand01449000011a1a5c14a57-ou', '873-DFDCGRAND-0144', '900001'), { token: '1a1a5c14a57', dir: 'out' })
eq('reference 別台不收', parseReference('dfdcgrand01459000011a1a5c14a57-ou', '873-DFDCGRAND-0144', '900001'), null)
eq('reference 結尾不對不收', parseReference('dfdcgrand01449000011a1a5c14a57', '873-DFDCGRAND-0144', '900001'), null)
eq('type 跟結尾矛盾不收', normalizeCredit({ gmid: '873-DFDCGRAND-0144', userid: '900001', reference: 'dfdcgrand01449000011a1a5c14a57-in', amount: 5, timestamp: 1, type: 2 }), null)

console.log(`live-compare-chain: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }

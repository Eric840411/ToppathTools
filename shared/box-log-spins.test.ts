/**
 * shared/box-log-spins 的單元測試。跑法：npx tsx shared/box-log-spins.test.ts
 * 守：spinid 循環不能誤配、重送／重複寫入要抓到、日誌沒涵蓋／斷檔／邊界／未結束不能判成漏寫或多出、
 *     多候選不強配、begin_time 不經浮點。
 */
import { parseBoxLogs, compareBoxLog, toMicros, GAP_SEC, type GrSpin } from './box-log-spins.js'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : '')) }
}

// 2026-11-12 00:00:00 +08:00 = 1794412800
const DAY0 = 1794412800
const hms = (sec: number) => {
  const t = ((sec - DAY0) % 86400 + 86400) % 86400
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}
/** 產生一局的兩行；begin 是 Unix 秒字串（保留原小數位） */
function spinLines(spinid: number, begin: string, bet: number, win: number, endAfter = 2, opts: { resend?: number; resendWin?: number; noEnd?: boolean; isError?: boolean } = {}) {
  const b = Number(begin)
  const out = [
    `${hms(b)}|INFO|DoactionResultReq action_type:4 {"spinid": ${spinid}, "machine_coin": 1000.0, "cur_coin": 1000.0, "bet": ${bet.toFixed(1)}, "begin_time": ${begin}}`,
    `extra: "{\\"spinid\\": ${spinid}}"`,
  ]
  if (opts.noEnd) return out
  const end = (w: number, dt: number) => `${hms(b + dt)}|INFO|DoactionResultReq action_type:5 {"spinid": ${spinid}, "machine_coin": 1000.0, "cur_coin": 1000.0, "win": ${w.toFixed(1)}, "begin_time": ${begin}, "isError": ${opts.isError ? 'true' : 'false'}, "nima": 0}`
  out.push(end(win, endAfter))
  for (let i = 0; i < (opts.resend ?? 0); i++) out.push(end(opts.resendWin ?? win, endAfter + 6 + i))
  return out
}
const heartbeat = (sec: number) => `${hms(sec)}|INFO|onMessage:DoactionResultRes,action_type: 2`
const gr = (orderId: string, spinid: number, bbt: number, bet: number, win: number, payout: number): GrSpin => ({ orderId, spinid, boxBeginTime: bbt, bet, win, payoutSec: payout })
const WIN = { start: DAY0, end: DAY0 + 86400 }

// ── toMicros ──
ok('toMicros 不經浮點（7 位小數截到 6 位）', toMicros('1794467107.1504447') === 1794467107150444)
ok('toMicros 位數不足補 0', toMicros('1794412800.4') === 1794412800400000)
ok('toMicros 整數', toMicros('1794412800') === 1794412800000000)
ok('toMicros 非數字 → null', toMicros('1e9') === null)

// ── 解析：真實格式 ──
{
  const t = [heartbeat(DAY0 + 1), ...spinLines(215, '1794412900.459583', 960, 0), ...spinLines(216, '1794412904.0689807', 960, 1000), heartbeat(DAY0 + 600)].join('\n')
  const p = parseBoxLogs([t])
  ok('解析出 2 局', p.spins.length === 2, p.spins.length)
  ok('bet／win 讀對', p.spins[0].bet === 960 && p.spins[1].win === 1000)
  ok('endSec 用那行時間定日期', p.spins[0].endSec !== null && Math.abs(p.spins[0].endSec - (1794412900.459583 + 2)) < 0.01, p.spins[0].endSec)
  ok('coverage 是第一行到最後一行', p.coverage?.start === DAY0 + 1 && p.coverage?.end === DAY0 + 600, p.coverage)
  ok('沒有斷檔', p.gaps.length === 0)
}
// 跨午夜
{
  const t = [heartbeat(DAY0 + 86400 - 5), ...spinLines(1, String(DAY0 + 86400 + 3) + '.5', 10, 0)].join('\n')
  const p = parseBoxLogs([t])
  ok('跨午夜：隔天那局 endSec 在隔天', p.spins[0].endSec !== null && p.spins[0].endSec > DAY0 + 86400, p.spins[0].endSec)
  ok('跨午夜：coverage.end 在隔天', (p.coverage?.end ?? 0) > DAY0 + 86400, p.coverage)
}
// 斷檔
{
  const t = [...spinLines(1, `${DAY0 + 100}.1`, 10, 0), heartbeat(DAY0 + 200), heartbeat(DAY0 + 200 + GAP_SEC + 60), ...spinLines(2, `${DAY0 + 200 + GAP_SEC + 100}.1`, 10, 0)].join('\n')
  const p = parseBoxLogs([t])
  ok('超過 GAP_SEC 沒紀錄 → 1 段斷檔', p.gaps.length === 1, p.gaps)
}
// 多檔重疊上傳去重
{
  const t = spinLines(5, `${DAY0 + 100}.25`, 10, 0).join('\n')
  const p = parseBoxLogs([t, t])
  ok('同一份日誌傳兩次 → 不算重送', p.spins.length === 1 && p.spins[0].endSends === 1, p.spins)
}

// ── 比對 ──
function run(lines: string[], rows: GrSpin[], win = WIN) {
  const p = parseBoxLogs([[heartbeat(DAY0 + 1), ...lines, heartbeat(DAY0 + 86399)].join('\n')])
  // 心跳只有頭尾 → 中間會被當斷檔；測試要整天涵蓋，補每 10 分鐘心跳
  const hb: string[] = []
  for (let s = DAY0 + 1; s < DAY0 + 86400; s += 600) hb.push(heartbeat(s))
  const p2 = parseBoxLogs([[...hb, ...lines].sort().join('\n')])
  void p
  return compareBoxLog(p2, rows, win)
}

// 後台 box_begin_time＝begin_time 四捨五入到 4 位（0150 11/11 實測 3310／3310 吻合四捨五入、0 吻合截斷）
{
  const r = run(spinLines(215, '1794412900.459583', 960, 0), [gr('A215', 215, 1794412900.4596, 960, 0, 1794412902)])
  ok('一對一四捨五入 → matched 1、沒有異常', r.counts.matched === 1 && r.items.length === 0, r)
}
{
  const r = run(spinLines(215, '1794412900.459583', 960, 0), [gr('A215', 215, 1794412900.4595, 960, 0, 1794412902)])
  ok('截斷值不算同一局（不放寬配對）', r.counts.matched === 0, r.counts)
}
// 真實樣本：.2879546 → 後台 .288（JSON 結尾 0 掉了）
{
  const r = run(spinLines(702, '1794412928.2879546', 264, 0), [gr('6AF43DE8702', 702, 1794412928.288, 264, 0, 1794412930)])
  ok('真實樣本 .2879546 ↔ .288 → matched', r.counts.matched === 1, r.counts)
}
// 平手（第 5、6 位剛好 50）：後台浮點四捨五入可能往下（實測 .55195 → .5519、.33055 → .3305）
{
  const r = run(spinLines(30, '1794412905.55195', 176, 760), [gr('6AF3C4B9030', 30, 1794412905.5519, 176, 760, 1794412907)])
  ok('平手往下取 → matched', r.counts.matched === 1 && r.items.length === 0, r.counts)
  const r2 = run(spinLines(30, '1794412905.55195', 176, 760), [gr('Y30', 30, 1794412905.552, 176, 760, 1794412907)])
  ok('平手往上取 → matched', r2.counts.matched === 1 && r2.items.length === 0, r2.counts)
  const r3 = run(spinLines(30, '1794412905.55194', 176, 760), [gr('Z30', 30, 1794412905.552, 176, 760, 1794412907)])
  ok('不是平手就不放寬（.55194 不配 .5520）', r3.counts.matched === 0, r3.counts)
}
// 跨日開始的局只有 action 5，靠 begin_time 照樣配
{
  const b = `${DAY0 + 3600}.5`
  const only5 = spinLines(52, b, 10, 7230).filter(l => l.includes('action_type:5'))
  const r = run(only5, [gr('X52', 52, DAY0 + 3600.5, 10, 7230, DAY0 + 3602)])
  ok('只有 action 5 → 照樣配上、不判押注不同', r.counts.matched === 1 && r.counts.amount_diff === 0, r.counts)
}
// spinid 循環：同 spinid、不同 begin_time 不能配在一起
{
  const r = run([...spinLines(696, `${DAY0 + 3600}.1234`, 10, 0), ...spinLines(696, `${DAY0 + 7200}.5678`, 10, 0)],
    [gr('X1', 696, DAY0 + 3600.1234, 10, 0, DAY0 + 3602)])
  ok('spinid 循環：第二個 696 疑似漏寫、第一個 matched', r.counts.matched === 1 && r.counts.suspect_missing === 1, r.counts)
  ok('漏寫那局是第二個 696', r.items.some(i => i.kind === 'suspect_missing' && Math.abs(i.beginSec - (DAY0 + 7200.5678)) < 0.001), r.items)
}
// 11/11 情境：同一局 GR 兩筆＋盒子重送
{
  const r = run(spinLines(696, `${DAY0 + 3600}.1234`, 10, 0, 2, { resend: 1 }),
    [gr('6AF43DC2696', 696, DAY0 + 3600.1234, 10, 0, DAY0 + 3602), gr('6AF43DCD696', 696, DAY0 + 3600.1234, 10, 0, DAY0 + 3608)])
  ok('同局 GR 兩筆 → duplicate 1，帶兩張單號', r.counts.duplicate === 1 && r.items.find(i => i.kind === 'duplicate')?.orderIds.length === 2, r.items)
  ok('結束訊息印兩次 → resent 1', r.counts.resent === 1, r.counts)
}
// 真實重送樣子：不再印 JSON，只印 resend!!!／start reconnect；歸給下一局開局前的那局
{
  const b = DAY0 + 3600
  const lines = [...spinLines(696, `${b}.314227`, 528, 0), `${hms(b + 10)}|INFO|thread_loop_check_action resend!!! 1`, `${hms(b + 12)}|INFO|thread_loop_check_action resend!!! 1`,
    `${hms(b + 16)}|INFO|start reconnect by on_error and delay 5`, `${hms(b + 22)}|INFO|thread_loop_check_action resend!!! 1`, ...spinLines(697, `${b + 25}.6154728`, 528, 0)]
  const r = run(lines, [gr('DB7', 696, b + 0.3142, 528, 0, b + 2), gr('DC2', 696, b + 0.3142, 528, 0, b + 12), gr('DCD', 696, b + 0.3142, 528, 0, b + 22), gr('DD0', 697, b + 25.6155, 528, 0, b + 27)])
  const dup = r.items.find(i => i.kind === 'duplicate')
  const rs = r.items.find(i => i.kind === 'resent')
  ok('696 三筆 → duplicate 帶 3 張單號', dup?.orderIds.length === 3 && dup.spinid === 696, r.items)
  ok('696 重送 3 次、斷線 1 次，算在 696 不算 697', rs?.spinid === 696 && rs.box?.resends === 3 && rs.box?.reconnects === 1 && r.items.filter(i => i.kind === 'resent').length === 1, r.items)
  ok('697 正常配上', r.counts.matched === 1, r.counts)
}
// 重送內容不同要留下差異
{
  const r = run(spinLines(7, `${DAY0 + 3600}.5`, 10, 0, 2, { resend: 1, resendWin: 50 }), [gr('B7', 7, DAY0 + 3600.5, 10, 0, DAY0 + 3602)])
  ok('重送內容不同 → endVariants 2', r.items.find(i => i.kind === 'resent')?.box?.endVariants === 2, r.items)
}
// 金額不同
{
  const r = run(spinLines(8, `${DAY0 + 3600}.5`, 10, 30), [gr('C8', 8, DAY0 + 3600.5, 10, 20, DAY0 + 3602)])
  ok('win 不同 → amount_diff', r.counts.amount_diff === 1 && r.counts.matched === 0, r.counts)
}
// GR 多出：日誌涵蓋時間內、日誌沒有這局
{
  const r = run(spinLines(1, `${DAY0 + 100}.5`, 10, 0), [gr('A1', 1, DAY0 + 100.5, 10, 0, DAY0 + 102), gr('D9', 9, DAY0 + 3600.5, 10, 0, DAY0 + 3602)])
  ok('日誌涵蓋內 GR 多一筆 → suspect_extra', r.counts.suspect_extra === 1, r.counts)
}
// 日誌沒涵蓋到的 GR 不能判多出
{
  const lines = [heartbeat(DAY0 + 1), ...spinLines(1, `${DAY0 + 100}.5`, 10, 0), heartbeat(DAY0 + 500)]
  const p = parseBoxLogs([lines.join('\n')])
  const r = compareBoxLog(p, [gr('A1', 1, DAY0 + 100.5, 10, 0, DAY0 + 102), gr('E1', 3, DAY0 + 40000.5, 10, 0, DAY0 + 40002)], WIN)
  ok('日誌沒涵蓋 → notCovered，不算 suspect_extra', r.counts.notCovered === 1 && r.counts.suspect_extra === 0, r.counts)
}
// 斷檔中間的 GR 不判
{
  const lines = [heartbeat(DAY0 + 1), heartbeat(DAY0 + 600), heartbeat(DAY0 + 600 + GAP_SEC * 2), heartbeat(DAY0 + 86000)]
  const p = parseBoxLogs([[...lines, ...spinLines(1, `${DAY0 + 100}.5`, 10, 0)].sort().join('\n')])
  const r = compareBoxLog(p, [gr('A1', 1, DAY0 + 100.5, 10, 0, DAY0 + 102), gr('G1', 4, DAY0 + 600 + GAP_SEC, 10, 0, DAY0 + 600 + GAP_SEC + 2)], WIN)
  ok('斷檔中的 GR → notCovered', r.counts.notCovered === 1 && r.counts.suspect_extra === 0, r.counts)
}
// 沒結束的局不判漏寫
{
  const r = run(spinLines(325, `${DAY0 + 3600}.15`, 10, 0, 2, { noEnd: true }), [])
  ok('日誌中沒結束 → unfinished，不算漏寫', r.counts.unfinished === 1 && r.counts.suspect_missing === 0, r.counts)
}
// 邊界局不判
{
  const r = run(spinLines(11, `${DAY0 + 86400 - 4}.5`, 10, 0, 2), [], WIN)
  ok('結算離視窗結尾 <10 秒 → edge，不算漏寫', r.counts.edge === 1 && r.counts.suspect_missing === 0, r.counts)
}
// 結算在視窗外的局不期待出現在 GR
{
  const r = run(spinLines(12, `${DAY0 + 3600}.5`, 10, 0), [], { start: DAY0 + 7200, end: DAY0 + 86400 })
  ok('自訂起始時間之前結算的局 → 不判', r.items.length === 0 && r.counts.suspect_missing === 0, r)
}
// isError 的局不算漏寫，但列出來
{
  const r = run(spinLines(13, `${DAY0 + 3600}.5`, 10, 0, 2, { isError: true }), [])
  ok('isError 局 → is_error、不算漏寫', r.counts.is_error === 1 && r.counts.suspect_missing === 0, r.counts)
}
// 多候選不強配：兩局同 spinid、begin_time 只差 <0.1ms
{
  const r = run([...spinLines(20, `${DAY0 + 3600}.12340`, 10, 0), ...spinLines(20, `${DAY0 + 3600}.12341`, 10, 0)], [gr('H20', 20, DAY0 + 3600.1234, 10, 0, DAY0 + 3602)])
  ok('多候選 → ambiguous，不強配', r.counts.ambiguous === 1 && r.counts.matched === 0, r.counts)
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) process.exit(1)

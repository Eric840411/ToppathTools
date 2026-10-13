// AFT 轉入失敗熔斷（v5.52.0，osm-qa-agent spec #5，CodeX 定案）：npx tsx scripts/aft-breaker-probe.ts
// 前半：純函式（aftBreaker／findAftInEnd／entryNeedsAftLookup）。
// 後半：**真的 runWorker**＋假的 runMachine（只回進場結果、呼叫真的 afterEntryAft）＋假的 daily-analysis（stub fetch）：
//   連續 2 台同 state 失敗 → 第 3 台不會被派出去（停批在派下一台之前）
// 10-13 實例：0233～0245 共 12 台 aft_in_end success:false state=87，一路打下去全部卡成 Occupied
import { aftBreaker, findAftInEnd, entryNeedsAftLookup, type AftLookup } from '../server/machine-test/verdicts.js'
import { MachineTestRunner } from '../server/machine-test/runner.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`) }

// ── 純函式 ──
const F = (state: string): AftLookup => ({ kind: 'fail', state, time: '19:00:00' })
let b = aftBreaker(null, 'A', F('87'))
ok(!b.halt && b.next?.state === '87', '第 1 台失敗 → 記下、不停', b)
b = aftBreaker({ code: 'A', state: '87' }, 'B', F('87'))
ok(!!b.halt && /連續 2 台 AFT 轉入失敗、state 相同（A、B：state=87）/.test(b.halt), '⚠️ 連續 2 台 state 相同 → 停批', b.halt)
ok(!aftBreaker({ code: 'A', state: '87' }, 'B', F('40')).halt, 'state 不同 → 不停（換成記 B）')
ok(!aftBreaker({ code: 'A', state: '87' }, 'B', F('?')).halt && aftBreaker({ code: 'A', state: '87' }, 'B', F('?')).next === null, 'state 不明 → 不算、歸零')
ok(aftBreaker({ code: 'A', state: '87' }, 'B', { kind: 'unknown', why: 'x' }).next === null, '查不到／無法確認 → 不算、歸零')
ok(aftBreaker({ code: 'A', state: '87' }, 'B', { kind: 'ok' }).next === null, 'AFT 成功 → 歸零')
ok(!entryNeedsAftLookup({ status: 'fail', message: '大廳找不到機台代碼: X' }) && !entryNeedsAftLookup({ status: 'fail', message: '機台 Occupied（AUDIT MODE：…）' }), '大廳找不到／AUDIT MODE 不查 AFT')
ok(entryNeedsAftLookup({ status: 'fail', message: '機台 Occupied（Game Preview 顯示 Occupied，沒有 Join）' }) && !entryNeedsAftLookup({ status: 'pass', message: '' }), '一般 Occupied 要查；進場成功不查')

const date = '2026-10-13', at = (hms: string) => Date.parse(`${date}T${hms}+08:00`)
const E = (time: string, uid: string, success: boolean, state = 87) => ({ time, type: 'aft_in_end', userid: uid, data: { success, ...(success ? {} : { state }) } })
const win = { uid: '328804', fromMs: at('19:00:00'), toMs: at('19:10:00'), date }
ok(findAftInEnd([E('19:01:00', '328804', false)], win)?.kind === 'fail', '窗口內、自己的帳號、success:false → fail')
ok(findAftInEnd([E('18:20:00', '328804', false)], win) === null, '⚠️ 窗口外的舊失敗紀錄不算（不會被當成這次進場）')
ok(findAftInEnd([E('19:01:00', '999999', false)], win) === null, '別的帳號的失敗不算')
ok(findAftInEnd([E('19:01:00', '328804', true)], win)?.kind === 'ok', '只有成功 → ok')
ok(findAftInEnd([], win) === null, '沒有紀錄 → null（呼叫端再等或判無法確認）')

// ── 真的 runWorker ──
const uid = '328804'
const lobby = `https://qat-cp.osmslot.org/?token=abc-${uid}&username=osmel004`
let failState: Record<string, number> = {}
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request) => {
  const u = new URL(String(url))
  const gmid = u.searchParams.get('gmid') ?? ''
  const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19)   // 盒子時間（UTC+8）
  const tl = gmid in failState ? [{ time: now, type: 'aft_in_end', gmid, userid: uid, data: failState[gmid] ? { success: false, state: failState[gmid] } : { success: true } }] : []
  return new Response(JSON.stringify({ success: true, data: { timeline: tl } }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

async function runQueue(codes: string[], entry: (code: string) => { status: 'pass' | 'fail'; message: string }) {
  const runner = new MachineTestRunner() as unknown as Record<string, any>
  const dispatched: string[] = [], events: string[] = []
  runner.on('event', (e: { type: string; message?: string }) => { if (e.type === 'error') events.push(e.message ?? '') })
  runner.runMachine = async function (_b: unknown, code: string, lobbyUrl: string) {
    dispatched.push(code)
    const steps = [{ step: '進入機台', ...entry(code), durationMs: 0 }]
    await this.afterEntryAft(code, lobbyUrl, new Date().toISOString(), steps, () => {})
  }
  const q = [...codes]
  await runner.runWorker(null, { next: () => q.shift() ?? null }, lobby, 1, {}, false)
  return { dispatched, events, haltReason: runner.haltReason as string | null }
}
const occupied = () => ({ status: 'fail' as const, message: '機台 Occupied（Game Preview 顯示 Occupied，沒有 Join）' })
try {
  failState = { 'T-1': 87, 'T-2': 87, 'T-3': 87, 'T-4': 87 }
  let r = await runQueue(['T-1', 'T-2', 'T-3', 'T-4'], occupied)
  ok(JSON.stringify(r.dispatched) === '["T-1","T-2"]', '⚠️ 連續 2 台 state=87 → T-3 不會被派出去（停批在派下一台之前）', r.dispatched)
  ok(r.events.some(e => /🛑 連續 2 台 AFT 轉入失敗/.test(e)), '停批訊息帶 🛑（batch 看到 🛑 不自動續跑）', r.events)

  failState = { 'T-1': 87, 'T-2': 40, 'T-3': 40, 'T-4': 87 }
  r = await runQueue(['T-1', 'T-2', 'T-3', 'T-4'], occupied)
  ok(JSON.stringify(r.dispatched) === '["T-1","T-2","T-3"]', 'state 87→40→40：第 2、3 台才是連續同 state → 停在 T-3 之後', r.dispatched)

  failState = { 'T-1': 87, 'T-2': 0, 'T-3': 87, 'T-4': 87 }
  r = await runQueue(['T-1', 'T-2', 'T-3', 'T-4'], occupied)
  // T-2 成功 → 歸零：T-3 是新的第 1 台（不會跟 T-1 湊成連續）；T-3、T-4 才是連續兩台
  ok(JSON.stringify(r.dispatched) === '["T-1","T-2","T-3","T-4"]' && /（T-3、T-4：state=87）/.test(r.haltReason ?? ''), '中間一台 AFT 成功 → 歸零（T-1 不跟 T-3 湊連續；停的是 T-3、T-4）', r)

  failState = { 'T-1': 87, 'T-2': 87 }
  r = await runQueue(['T-1', 'T-2', 'T-3'], code => code === 'T-2' ? { status: 'pass', message: '' } : occupied())
  ok(!r.haltReason, '中間一台進場成功 → 不算連續', r.haltReason)
} finally { globalThis.fetch = realFetch }

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)

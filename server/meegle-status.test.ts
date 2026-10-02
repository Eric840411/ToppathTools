/**
 * Meegle 批量更新狀態：共用規則＋送出流程。跑法：npx tsx server/meegle-status.test.ts
 * 假 Meegle 照 2026-10-02 #15190441 的實測行為：轉到 C服／完成 後過 N 秒，自動化把日期欄改成「今天」（台北 00:00）。
 * 時鐘是假的：sleep 只推進時間，到點就觸發自動化。
 */
import Database from 'better-sqlite3'
import { desiredDate, parseSheetDate, resolveTargetState, taipeiDay, taipeiDayStart, AUTO_DATE_FIELDS } from '../shared/meegle-status-rules.js'
import { initMeegleStatusSchema, claimStatusRow, getStatusSteps, dateDataOf, beginStatusStep } from './meegle-status-store.js'
import { runStatusRow, continueStatusRow, type StatusDeps } from './meegle-status-run.js'
import type { CallOutcome } from './meegle-workitem.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

// ── 共用規則 ──
const STATES = [
  { key: 'BAOjDk8Pv', name: '可本機測試' }, { key: 'rMaPpRVhj', name: 'C服' }, { key: 'Finished', name: '完成' },
  { key: '6Qsc4tJGz', name: '本機測試完成' }, { key: 'dupA', name: '重複' }, { key: 'dupB', name: '重複' },
]
eq('優先序：預覽手改最優先', resolveTargetState({ previewKey: 'Finished', sheetValue: 'C服', defaultKey: 'BAOjDk8Pv' }, STATES), { ok: true, key: 'Finished', name: '完成', source: 'preview' })
eq('優先序：Sheet 其次', resolveTargetState({ sheetValue: ' C服 ', defaultKey: 'BAOjDk8Pv' }, STATES), { ok: true, key: 'rMaPpRVhj', name: 'C服', source: 'sheet' })
eq('優先序：都沒有才用預設', resolveTargetState({ sheetValue: '', defaultKey: 'BAOjDk8Pv' }, STATES), { ok: true, key: 'BAOjDk8Pv', name: '可本機測試', source: 'default' })
eq('Sheet 狀態名對不到 → 擋，不退回預設', resolveTargetState({ sheetValue: 'C 服', defaultKey: 'BAOjDk8Pv' }, STATES).ok, false)
eq('Sheet 狀態名同名多個 → 擋', resolveTargetState({ sheetValue: '重複' }, STATES).ok, false)
eq('什麼都沒有 → 擋', resolveTargetState({}, STATES).ok, false)
eq('預覽給的 key 不在清單 → 擋', resolveTargetState({ previewKey: 'nope' }, STATES).ok, false)

eq('台北日期：自動化實測值 2026-10-01T16:00Z ＝ 10/02', taipeiDay(Date.parse('2026-10-01T16:00:00Z')), '2026-10-02')
eq('taipeiDayStart 跟自動化寫的同一個值', taipeiDayStart(2026, 10, 2), 1790870400000)
eq('Sheet 日期 2026/09/15', parseSheetDate('2026/09/15'), { ok: true, ms: taipeiDayStart(2026, 9, 15), day: '2026-09-15' })
eq('Sheet 日期 2026-9-5 帶時間', parseSheetDate('2026-9-5 14:30'), { ok: true, ms: taipeiDayStart(2026, 9, 5), day: '2026-09-05' })
eq('Sheet 日期空白＝沒指定', parseSheetDate('  '), { ok: true, ms: null, day: null })
eq('沒有年份 → 擋', parseSheetDate('9/15').ok, false)
eq('不存在的日期 → 擋', parseSheetDate('2026/02/30').ok, false)
eq('其他格式 → 擋', parseSheetDate('下週一').ok, false)
// 使用者 Sheet「日期」欄實測讀出 46289（Lark 序列數字）；週報同一個 epoch（1899-12-30）：2026-01-01＝46023，+266 天＝9/24
eq('Lark 日期序列數字 46289 → 2026-09-24', parseSheetDate('46289'), { ok: true, ms: taipeiDayStart(2026, 9, 24), day: '2026-09-24' })
eq('Lark 序列數字 46023 → 2026-01-01（年初對齊）', (parseSheetDate('46023') as { day?: string }).day, '2026-01-01')
eq('序列數字帶時間（小數）只取日', (parseSheetDate('46289.75') as { day?: string }).day, '2026-09-24')
eq('一般小數字不當成日期', parseSheetDate('5').ok, false)
eq('desired：keep 有原值＝原值', desiredDate('keep', 5, null), 5)
eq('desired：keep 原本空＝不動', desiredDate('keep', null, null), null)
eq('desired：set 有填＝Sheet', desiredDate('set', 5, 9), 9)
eq('desired：set 空白退回 keep', desiredDate('set', 5, null), 5)
eq('desired：auto＝不動', desiredDate('auto', 5, 9), null)

// ── 假 Meegle ──
const TODAY = taipeiDayStart(2026, 10, 2)
const D = (m: number, d: number) => taipeiDayStart(2026, m, d)
type Sim = {
  state: string; dates: Record<string, number | null>; clock: number
  automationDelay: number | null    // null＝這個空間沒有自動化
  pendingAuto: Array<{ at: number; field: string }>
  writes: Array<{ field: string; ms: number; at: number }>
  transitions: number
  transitionOutcome?: 'unknown-but-done' | 'rejected'
  readDateFails?: boolean
  sheetId?: string; sheetWrites: Array<Record<string, unknown>>
}
function makeSim(over: Partial<Sim> = {}): Sim {
  return { state: 'BAOjDk8Pv', dates: { field_cbc597: null, field_ce2cfc: null }, clock: Date.parse('2026-10-02T13:53:33Z'), automationDelay: 3000, pendingAuto: [], writes: [], transitions: 0, sheetId: '#15190441', sheetWrites: [], ...over }
}
function tick(sim: Sim) {
  for (const a of [...sim.pendingAuto]) if (a.at <= sim.clock) { sim.dates[a.field] = TODAY; sim.pendingAuto.splice(sim.pendingAuto.indexOf(a), 1) }
}
function depsFor(sim: Sim, db: Database.Database): StatusDeps {
  const ok = <T,>(value: T): CallOutcome<T> => ({ kind: 'ok', value })
  return {
    db,
    now: () => sim.clock,
    sleep: async ms => { sim.clock += ms; tick(sim) },
    readDate: async (_id, field) => { sim.clock += 200; tick(sim); return sim.readDateFails ? { kind: 'unknown', message: '連不上' } : ok(sim.dates[field] ?? null) },
    readState: async () => ok({ key: sim.state, name: STATES.find(s => s.key === sim.state)?.name ?? '' }),
    transition: async (_id, target) => {
      sim.clock += 500
      if (sim.transitionOutcome === 'rejected') return { kind: 'rejected', message: 'No Permission' }
      const from = sim.state
      if (from === target) return ok({ from, changed: false })
      sim.state = target; sim.transitions++
      const auto = AUTO_DATE_FIELDS[target]
      if (auto && sim.automationDelay != null) sim.pendingAuto.push({ at: sim.clock + sim.automationDelay, field: auto.field })
      if (sim.transitionOutcome === 'unknown-but-done') return { kind: 'unknown', message: '逾時' }
      return ok({ from, changed: true })
    },
    writeDate: async (_id, field, ms) => { sim.clock += 300; sim.dates[field] = ms; sim.writes.push({ field, ms, at: sim.clock }); tick(sim); return ok(true as const) },
    readRowCells: async () => ({ 'Meegle 單號': sim.sheetId ?? '' }),
    writeRow: async (_k, _r, cols) => { sim.sheetWrites.push(cols); return { ok: true } },
    fmtTime: () => '2026/10/02 21:53',
  }
}
const newDb = () => { const db = new Database(':memory:'); initMeegleStatusSchema(db); return db }
let n = 0
const payload = (over: Record<string, unknown> = {}) => ({
  batchId: `b${++n}`, workItemId: '15190441', sourceKey: 'lark:tok:sheet', sheetUrl: 'u', sheetRow: 5, summary: 's',
  ownerEmail: 'eric.wu@toppath.tw', targetKey: 'rMaPpRVhj', targetName: 'C服', dateMode: 'keep' as const, sheetDate: null as number | null, ...over,
})
const phases = (db: Database.Database, b: string) => Object.fromEntries(getStatusSteps(db, b, '15190441').map(s => [s.step, s.phase]))
/** 送完之後再讓時間往前跑 60 秒：還沒觸發的自動化都觸發完，看最後留在 Meegle 上的值 */
const settle = (sim: Sim) => { sim.clock += 60_000; tick(sim) }

async function scenario(name: string, simOver: Partial<Sim>, p: Record<string, unknown>, check: (sim: Sim, db: Database.Database, b: string) => void) {
  console.log(name)
  const sim = makeSim(simOver), db = newDb(), pl = payload(p)
  await runStatusRow(depsFor(sim, db), pl)
  settle(sim)
  check(sim, db, pl.batchId)
}

await scenario('保留原值：手填 9/15，轉 C服 後自動化改今天 → 等它跑完再寫回 9/15，最後留住', { dates: { field_cbc597: D(9, 15) } }, {}, (sim, db, b) => {
  eq('  最後的上C服時間', taipeiDay(sim.dates.field_cbc597!), '2026-09-15')
  eq('  三步都完成', phases(db, b), { state: 'done', date: 'done', writeback: 'done' })
  eq('  寫入發生在自動化之後（不是轉完立刻寫）', sim.writes.length === 1 && sim.writes[0].at > Date.parse('2026-10-02T13:53:33Z') + 500 + 3000, true)
})
await scenario('保留原值：原本空 → 用自動帶入的今天，不寫', {}, {}, (sim, db, b) => {
  eq('  最後是今天', taipeiDay(sim.dates.field_cbc597!), '2026-10-02')
  eq('  沒有寫', sim.writes.length, 0)
  eq('  日期 skipped、回填照做', phases(db, b), { state: 'done', date: 'skipped', writeback: 'done' })
})
await scenario('用自動帶入：手填 9/15 被蓋成今天也不管', { dates: { field_cbc597: D(9, 15) } }, { dateMode: 'auto' }, (sim, db, b) => {
  eq('  最後是今天', taipeiDay(sim.dates.field_cbc597!), '2026-10-02')
  eq('  沒有寫、日期 skipped', [sim.writes.length, phases(db, b).date], [0, 'skipped'])
})
await scenario('指定日期：Sheet 9/20、原本 9/15 → 最後 9/20', { dates: { field_cbc597: D(9, 15) } }, { dateMode: 'set', sheetDate: D(9, 20) }, (sim, db, b) => {
  eq('  最後是 9/20', taipeiDay(sim.dates.field_cbc597!), '2026-09-20')
  eq('  三步完成', phases(db, b), { state: 'done', date: 'done', writeback: 'done' })
})
await scenario('指定日期空白 → 退回保留原值', { dates: { field_cbc597: D(9, 15) } }, { dateMode: 'set', sheetDate: null }, sim => {
  eq('  最後是原值 9/15', taipeiDay(sim.dates.field_cbc597!), '2026-09-15')
})
await scenario('保留原值：原值本來就是今天 → 看不出自動化有沒有跑，但想要的就是今天 → done 不寫', { dates: { field_cbc597: TODAY } }, {}, (sim, db, b) => {
  eq('  沒有寫、完成', [sim.writes.length, phases(db, b).date], [0, 'done'])
})
await scenario('CodeX：指定 9/20 但原值本來就是今天 → 看不到變動，標日期待確認、不覆寫', { dates: { field_cbc597: TODAY } }, { dateMode: 'set', sheetDate: D(9, 20) }, (sim, db, b) => {
  eq('  沒有寫', sim.writes.length, 0)
  eq('  狀態成功、日期失敗分開記、沒回填', phases(db, b), { state: 'done', date: 'failed', writeback: 'none' })
  eq('  標成待確認', dateDataOf(getStatusSteps(db, b, '15190441').find(s => s.step === 'date'))?.pending, true)
})
await scenario('這個空間沒有自動化：等 20 秒看不到變動 → 待確認、不覆寫（逾時不能當成跑完）', { dates: { field_cbc597: D(9, 15) }, automationDelay: null }, {}, (sim, db, b) => {
  eq('  沒有寫、日期待確認', [sim.writes.length, phases(db, b).date], [0, 'failed'])
})
await scenario('自動化很慢（25 秒才跑，超過 20 秒）→ 待確認；之後自動化照樣蓋成今天', { dates: { field_cbc597: D(9, 15) }, automationDelay: 25_000 }, {}, (sim, db, b) => {
  eq('  日期待確認', phases(db, b).date, 'failed')
  eq('  （此時 Meegle 上是今天，等「只補日期」）', taipeiDay(sim.dates.field_cbc597!), '2026-10-02')
})
await scenario('本機測試完成沒有日期自動化 → 日期 skipped', { dates: { field_cbc597: D(9, 15) } }, { targetKey: '6Qsc4tJGz', targetName: '本機測試完成' }, (sim, db, b) => {
  eq('  沒有讀寫日期、skipped', [sim.writes.length, phases(db, b).date], [0, 'skipped'])
})
await scenario('已經是目標狀態（不轉）→ 自動化不會跑，值對就不寫', { state: 'rMaPpRVhj', dates: { field_cbc597: D(9, 15) } }, {}, (sim, db, b) => {
  eq('  沒轉、沒寫、完成', [sim.transitions, sim.writes.length, phases(db, b).date], [0, 0, 'done'])
})
await scenario('讀不到原本的日期 → 不轉狀態（否則保留不了）', { dates: { field_cbc597: D(9, 15) }, readDateFails: true }, {}, (sim, db, b) => {
  eq('  沒轉、狀態失敗', [sim.transitions, phases(db, b).state], [0, 'failed'])
  eq('  原值沒被蓋', taipeiDay(sim.dates.field_cbc597!), '2026-09-15')
})
await scenario('轉換回應不明但其實轉成功 → 重讀確認 done，日期照樣保留', { dates: { field_cbc597: D(9, 15) }, transitionOutcome: 'unknown-but-done' }, {}, (sim, db, b) => {
  eq('  狀態 done、日期留住', [phases(db, b).state, taipeiDay(sim.dates.field_cbc597!)], ['done', '2026-09-15'])
})
await scenario('Meegle 拒絕轉換 → 狀態失敗，不碰日期也不回填', { dates: { field_cbc597: D(9, 15) }, transitionOutcome: 'rejected' }, {}, (sim, db, b) => {
  eq('  狀態失敗、其餘 none', phases(db, b), { state: 'failed', date: 'none', writeback: 'none' })
})
await scenario('完成 → 上線時間 一樣保留', { dates: { field_ce2cfc: D(9, 1), field_cbc597: null } }, { targetKey: 'Finished', targetName: '完成' }, sim => {
  eq('  上線時間留住 9/1', taipeiDay(sim.dates.field_ce2cfc!), '2026-09-01')
})
await scenario('回填前那一列已經不是這張單 → 不寫', { sheetId: '#15190442' }, {}, (sim, db, b) => {
  eq('  回填失敗、沒寫 Sheet', [phases(db, b).writeback, sim.sheetWrites.length], ['failed', 0])
})
await scenario('回填內容跟 Jira 一樣', {}, {}, sim => {
  eq('  處理階段＝已切換狀態', sim.sheetWrites[0]?.['處理階段'], '已切換狀態')
})

// 只補日期：沿用第一次的原值（那時 Meegle 上已經是今天）
{
  const sim = makeSim({ dates: { field_cbc597: D(9, 15) }, automationDelay: 25_000 }), db = newDb(), pl = payload()
  const deps = depsFor(sim, db)
  await runStatusRow(deps, pl)
  settle(sim)   // 自動化終於跑了 → 今天
  eq('只補日期：重試前 Meegle 上是今天', taipeiDay(sim.dates.field_cbc597!), '2026-10-02')
  await continueStatusRow(deps, pl.batchId, '15190441')
  settle(sim)
  eq('只補日期：寫回第一次讀到的 9/15（不是重讀到的今天）', taipeiDay(sim.dates.field_cbc597!), '2026-09-15')
  eq('只補日期：沒有再轉一次狀態', sim.transitions, 1)
  eq('只補日期：三步完成', phases(db, pl.batchId), { state: 'done', date: 'done', writeback: 'done' })
}
// 狀態失敗重試：原值不重讀（第一次讀的才是真的）
{
  const sim = makeSim({ dates: { field_cbc597: D(9, 15) }, transitionOutcome: 'rejected' }), db = newDb(), pl = payload()
  const deps = depsFor(sim, db)
  await runStatusRow(deps, pl)
  sim.dates.field_cbc597 = D(9, 16)   // 中間有人改了
  sim.transitionOutcome = undefined
  await continueStatusRow(deps, pl.batchId, '15190441')
  settle(sim)
  eq('狀態重試：沿用首次保存的原值 9/15', taipeiDay(sim.dates.field_cbc597!), '2026-09-15')
}

// 認領
{
  const db = newDb()
  const a = payload(), b = payload()
  eq('認領：第一次 claimed', claimStatusRow(db, a).kind, 'claimed')
  beginStatusStep(db, a.batchId, '15190441', 'state')
  eq('認領：同一張單別批次正在轉 → busy', claimStatusRow(db, b).kind, 'busy')
  eq('認領：同批次換目標狀態 → 擋', claimStatusRow(db, { ...a, targetKey: 'Finished' }).kind, 'busy')
}
{
  const db = newDb(), a = payload()
  claimStatusRow(db, a)
  eq('認領：同批次換目標狀態（沒在跑）→ target-changed', claimStatusRow(db, { ...a, targetKey: 'Finished' }).kind, 'target-changed')
  eq('認領：同批次換日期模式 → target-changed', claimStatusRow(db, { ...a, dateMode: 'auto' }).kind, 'target-changed')
  eq('認領：別人的批次 → not-owner', claimStatusRow(db, { ...a, ownerEmail: 'x@toppath.tw' }).kind, 'not-owner')
  eq('認領：同批次同設定 → claimed', claimStatusRow(db, a).kind, 'claimed')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

/**
 * Meegle 補回填：Sheet 上被清掉的回填（v5.26.0）＋開單認列改用 Sheet 名稱。跑法：npx tsx server/meegle-backfill-cleared.test.ts
 * 用真的資料表（記憶體 DB）＋假 Sheet（記憶體），補寫走開單真正的 writebackRow。
 */
import Database from 'better-sqlite3'
import { claimRow, initMeegleBatchSchema } from './meegle-batch-store.js'
import { initMeegleEditSchema } from './meegle-edit-store.js'
import { classifyCleared, listDoneRecords, restoreCleared, type DoneRecord } from './meegle-backfill-cleared.js'
import { withSheetLock, writebackRow, type SheetCell, type WritebackDeps } from './meegle-sheet-writeback.js'
import { EDIT_STAGE_DONE } from '../shared/meegle-edit-rules.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const SRC = 'lark:tok:sh'
function fresh() { const db = new Database(':memory:'); initMeegleBatchSchema(db); initMeegleEditSchema(db); return db }
/** 開單成功＋回填成功的一列（走真的 claimRow，再把結果標成 created／done） */
function created(db: Database.Database, batch: string, row: number, wid: string, opts: { name?: string; sheetName?: string; owner?: string; at?: number; space?: 'test' | 'prod' } = {}) {
  const k = claimRow(db, { batchId: batch, rowKey: String(row), ownerEmail: opts.owner ?? 'me@t', sheetUrl: SRC, name: opts.name ?? 'Bug', sheetName: opts.sheetName, requirementId: '1', targetState: '', space: opts.space ?? 'test' }).kind
  db.prepare(`UPDATE meegle_batch_rows SET create_phase = 'created', work_item_id = ?, writeback_phase = 'done', writeback_at = ?, updated_at = ? WHERE batch_id = ? AND row_key = ?`).run(wid, opts.at ?? 100, opts.at ?? 100, batch, String(row))
  return k
}
function edited(db: Database.Database, batch: string, row: number, wid: string, at: number, owner = 'me@t') {
  db.prepare(`INSERT INTO meegle_edit_rows (batch_id, row_key, source_key, sheet_row, summary, work_item_id, owner_email, payload, created_at, updated_at) VALUES (?, ?, ?, ?, 'Bug', ?, ?, '{}', ?, ?)`).run(batch, wid, SRC, row, wid, owner, at, at)
  for (const s of ['fields', 'roles', 'verify', 'writeback']) db.prepare(`INSERT INTO meegle_edit_steps (batch_id, row_key, step, phase, updated_at) VALUES (?, ?, ?, 'done', ?)`).run(batch, wid, s, at)
}

// ── 判定 ──
{
  const withCreate = { workItemId: '15245900', create: { tool: 'create' as const, batchId: 'b', rowKey: '3', at: 1 } }
  eq('單號＝這張單、處理階段有字 → 沒被清', classifyCleared(withCreate, { id: '#15245900', stage: '已修改欄位' }), null)
  eq('單號＝這張單、處理階段空白 → 補處理階段', classifyCleared(withCreate, { id: '#15245900', stage: '' }), 'stage')
  eq('單號空白、有開單紀錄 → 全部補', classifyCleared(withCreate, { id: '  ', stage: '' }), 'all')
  eq('單號空白、沒有開單紀錄 → 不能補', classifyCleared({ workItemId: '15245900', create: null }, { id: '', stage: '' }), 'no-create')
  eq('單號是別張單 → 不覆蓋', classifyCleared(withCreate, { id: '#152459001', stage: '' }), 'conflict')
  eq('單號格是看不懂的字 → 不覆蓋', classifyCleared(withCreate, { id: 'CGFB-50', stage: '' }), 'conflict')
}

// ── 列出回填成功過的列 ──
{
  const db = fresh()
  created(db, 'b1', 3, '15245900', { at: 100 }); edited(db, 'e1', 3, '15245900', 200)       // 開單後又修改 → 最近是修改
  edited(db, 'e1', 4, '15245901', 150)                                                  // 只有修改（單號是人手打的）
  created(db, 'b1', 5, '15245902', { at: 100 }); created(db, 'b2', 5, '15245903', { at: 300, name: 'Other' })   // 同一列後來開了別張單
  created(db, 'b1', 6, '15245904', { owner: 'other@t' })                                // 別人的
  const recs = listDoneRecords(db, { match: k => k === SRC, owner: 'me@t' })
  eq('每列只留最近一次、只看自己的', recs.map(r => `${r.sheetRow}:${r.workItemId}:${r.latest.tool}:${r.create ? 'c' : '-'}`), ['3:15245900:edit:c', '4:15245901:edit:-', '5:15245903:create:c'])
  eq('非管理員看不到測試空間', listDoneRecords(db, { match: k => k === SRC, owner: 'me@t', excludeTest: true }).length, 0)
  const db2 = fresh()   // 同一份 Sheet 不能跨空間（claimRow 會擋），正式空間另開一個 DB
  created(db2, 'b3', 7, '15245905', { space: 'prod' })
  eq('正式空間的列非管理員看得到', listDoneRecords(db2, { match: k => k === SRC, owner: 'me@t', excludeTest: true }).map(r => r.sheetRow), [7])
  eq('別份 Sheet 不列', listDoneRecords(db, { match: k => k === 'lark:x:y', owner: null }).length, 0)
}

// ── 補寫（假 Sheet） ──
type Row = Record<string, string>
function fakeSheet(rows: Record<number, Row>) {
  const text = (c: SheetCell) => typeof c === 'string' ? c : c.segments.map(s => s.text).join('')
  const writes: Array<{ row: number; cols: string[] }> = []
  const writeback: WritebackDeps = {
    readRowNames: async (_k, r) => rows[r] ? { summary: rows[r]['摘要'] ?? '', title: rows[r]['標題'] ?? '', pasted: rows[r]['單子標題貼這'] ?? '' } : null,
    writeRow: async (_k, r, cols) => { rows[r] = { ...(rows[r] ?? {}) }; for (const [c, v] of Object.entries(cols)) rows[r][c] = text(v); writes.push({ row: r, cols: Object.keys(cols) }); return { ok: true } },
    now: () => 1_000,
  }
  const readRowCells = async (_k: string, r: number, names: string[]) => Object.fromEntries(names.map(n => [n, rows[r]?.[n] ?? '']))
  return { rows, writes, deps: (db: Database.Database) => ({ db, writeback, readRowCells, fmtTime: () => 'T' }) }
}
const recOf = (db: Database.Database, row: number): DoneRecord => listDoneRecords(db, { match: k => k === SRC, owner: null }).find(r => r.sheetRow === row)!

await (async () => {
  const db = fresh()
  created(db, 'b1', 3, '15245900', { at: 100 }); edited(db, 'e1', 3, '15245900', 200)
  const s = fakeSheet({ 3: { '摘要': 'Bug' } })
  const r = await restoreCleared(s.deps(db), recOf(db, 3))
  eq('全清：補回成功', r.ok, true)
  eq('全清：單號寫回', s.rows[3]['Meegle 單號'], '#15245900')
  eq('全清：處理階段停在最近一次（修改）', s.rows[3]['處理階段'], EDIT_STAGE_DONE)
})()

await (async () => {
  const db = fresh()
  created(db, 'b1', 3, '15245900')
  const s = fakeSheet({ 3: { '摘要': '別的列' } })
  const r = await restoreCleared(s.deps(db), recOf(db, 3))
  eq('列已變動（摘要不同）→ 不寫', [r.ok, s.writes.length], [false, 0])
})()

await (async () => {
  const db = fresh()
  created(db, 'b1', 3, '15245900')
  const s = fakeSheet({ 3: { '摘要': 'Bug', 'Meegle 單號': '#15240111' } })
  const r = await restoreCleared(s.deps(db), recOf(db, 3))
  eq('單號是別張單 → 不寫', [r.ok, s.writes.length], [false, 0])
})()

await (async () => {
  const db = fresh()
  edited(db, 'e1', 4, '15245901', 150)
  const s = fakeSheet({ 4: { '摘要': 'Bug', 'Meegle 單號': '#15245901' } })
  const r = await restoreCleared(s.deps(db), recOf(db, 4))
  eq('只清處理階段、單號還在（修改工具）→ 只補處理階段', [r.ok, s.rows[4]['處理階段'], s.writes.map(w => w.cols.sort().join('+'))], [true, EDIT_STAGE_DONE, ['處理時間+處理階段']])
})()

// ── CodeX 60c61d3 [P1]：排隊等鎖期間單號被換成別張單 → 不能蓋過去 ──
await (async () => {
  const db = fresh()
  created(db, 'b1', 3, '15245900')
  const s = fakeSheet({ 3: { '摘要': 'Bug' } })
  // 另一個回填先拿到這份 Sheet 的鎖，期間把第 3 列換成別張單
  const other = withSheetLock(SRC, async () => { await new Promise(r => setTimeout(r, 30)); s.rows[3]['Meegle 單號'] = '#15249999' })
  const r = await restoreCleared(s.deps(db), recOf(db, 3))
  await other
  eq('[P1] 等鎖期間被換成別張單 → 不寫、單號保持別張單', [r.ok, s.writes.length, s.rows[3]['Meegle 單號']], [false, 0, '#15249999'])
})()

// ── CodeX 60c61d3 [P2]：補過一次再補，處理階段不能倒退成開單 ──
await (async () => {
  const db = fresh()
  created(db, 'b1', 3, '15245900', { at: 100 }); edited(db, 'e1', 3, '15245900', 200)
  const s = fakeSheet({ 3: { '摘要': 'Bug' } })
  const r1 = await restoreCleared(s.deps(db), recOf(db, 3))
  s.rows[3]['處理階段'] = ''   // 補完又被清掉處理階段
  const rec2 = recOf(db, 3)
  const r2 = await restoreCleared(s.deps(db), rec2)
  eq('[P2] 第二次補：最近一次仍是修改、處理階段仍是「已修改欄位」', [r1.ok, r2.ok, rec2.latest.tool, s.rows[3]['處理階段']], [true, true, 'edit', EDIT_STAGE_DONE])
})()

// ── 開單認列改用 Sheet 名稱（AI／手改名稱） ──
await (async () => {
  const db = fresh()
  created(db, 'b1', 3, '15245900', { name: 'AI 產生的名稱', sheetName: 'Bug' })
  db.prepare("UPDATE meegle_batch_rows SET writeback_phase = 'pending'").run()
  const s = fakeSheet({ 3: { '摘要': 'Bug' } })
  const r = await writebackRow(db, 'b1', '3', s.deps(db).writeback)
  eq('改過名稱的列：回填用 Sheet 名稱核對 → 寫得進去', r.phase, 'done')
  eq('單子標題貼這用送出的任務名稱', s.rows[3]['單子標題貼這'], '#15245900\nAI 產生的名稱')
  eq('另一批再送同一列（AI 又給了不同名稱）→ 認得出已開過', claimRow(db, { batchId: 'b9', rowKey: '3', ownerEmail: 'me@t', sheetUrl: SRC, name: 'AI 第二次的名稱', sheetName: 'Bug', requirementId: '1', targetState: '', space: 'test' }).kind, 'already-created')
  // 舊資料（沒記 sheet_name）照舊用 name
  created(db, 'b1', 4, '15245901', { name: 'Old' })
  eq('舊資料沒記 Sheet 名稱 → 用 name 認', claimRow(db, { batchId: 'b9', rowKey: '4', ownerEmail: 'me@t', sheetUrl: SRC, name: 'Old', requirementId: '1', targetState: '', space: 'test' }).kind, 'already-created')
})()

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

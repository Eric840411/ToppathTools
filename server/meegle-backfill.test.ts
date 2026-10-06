/**
 * Meegle 補回填：哪些列該列出來。跑法：npx tsx server/meegle-backfill.test.ts
 * 用四個工具真的資料表（記憶體 DB）建資料，不另外假造表結構——表改了這裡會跟著壞，不會默默漏列。
 */
import Database from 'better-sqlite3'
import { initMeegleBatchSchema } from './meegle-batch-store.js'
import { initMeegleCommentSchema } from './meegle-comment-store.js'
import { initMeegleStatusSchema } from './meegle-status-store.js'
import { initMeegleEditSchema } from './meegle-edit-store.js'
import { EventEmitter } from 'events'
import { busyHandler, isWritebackBusy, withWritebackBusy } from './meegle-writeback-busy.js'
import { IDLE_MS, dismissBackfill, initBackfillDismissSchema, listPendingBackfill, retryBackfill } from './meegle-backfill.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const NOW = 10_000_000
const OLD = NOW - IDLE_MS - 1
const db = new Database(':memory:')
initMeegleBatchSchema(db); initMeegleCommentSchema(db); initMeegleStatusSchema(db); initMeegleEditSchema(db)

// ── 開單 ──
const createRow = (row: string, owner: string, phase: string, wb: string, updated: number, src = 'lark:t:s') => db.prepare(`INSERT INTO meegle_batch_rows
  (batch_id, row_key, owner_email, sheet_url, name, requirement_id, create_phase, work_item_id, writeback_phase, writeback_msg, created_at, updated_at)
  VALUES ('11111111-1111-4111-8111-111111111111', ?, ?, ?, '名稱', '1', ?, ?, ?, ?, ?, ?)`).run(row, owner, src, phase, phase === 'created' ? `9${row}` : null, wb, wb === 'failed' ? 'Sheet 鎖住' : null, updated, updated)
createRow('2', 'me@t', 'created', 'failed', NOW)          // ✔ 失敗
createRow('3', 'me@t', 'created', 'pending', NOW)         // ✘ 剛建、可能還在寫
createRow('4', 'me@t', 'created', 'pending', OLD)         // ✔ 卡住
createRow('5', 'me@t', 'created', 'done', OLD)            // ✘ 已寫回
createRow('6', 'me@t', 'unknown', 'none', OLD)            // ✘ 沒開成功
createRow('7', 'other@t', 'created', 'failed', NOW)       // 別人的
createRow('8', 'me@t', 'created', 'failed', NOW, 'https://docs.google.com/x')   // ✘ 不是 Lark

// ── 評論／狀態／修改：步驟表 ──
function stepRow(tool: 'comment' | 'status' | 'edit', batch: string, wid: string, steps: Record<string, string>, updated: number, owner = 'me@t', created = 1) {
  const rows = `meegle_${tool}_rows`, st = `meegle_${tool}_steps`
  if (tool === 'comment') db.prepare(`INSERT INTO ${rows} (batch_id, row_key, source_key, work_item_id, owner_email, created_at, updated_at) VALUES (?, ?, 'lark:t:s', ?, ?, ?, ?)`).run(batch, wid, wid, owner, created, updated)
  if (tool === 'status') db.prepare(`INSERT INTO ${rows} (batch_id, row_key, source_key, work_item_id, owner_email, target_key, date_mode, created_at, updated_at) VALUES (?, ?, 'lark:t:s', ?, ?, 'x', 'keep', ?, ?)`).run(batch, wid, wid, owner, created, updated)
  if (tool === 'edit') db.prepare(`INSERT INTO ${rows} (batch_id, row_key, source_key, work_item_id, owner_email, payload, created_at, updated_at) VALUES (?, ?, 'lark:t:s', ?, ?, '{}', ?, ?)`).run(batch, wid, wid, owner, created, updated)
  for (const [k, v] of Object.entries(steps)) db.prepare(`INSERT INTO ${st} (batch_id, row_key, step, phase, updated_at, message) VALUES (?, ?, ?, ?, ?, ?)`).run(batch, wid, k, v, updated, v === 'failed' ? '模擬失敗' : null)
}
stepRow('comment', 'c1', '101', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'failed' }, NOW)      // ✔
stepRow('comment', 'c1', '102', { desc: 'done', comment: 'unknown', review: 'skipped', writeback: 'none' }, OLD)     // ✘ 評論待確認，還不能回填
stepRow('comment', 'c1', '103', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'none' }, NOW)        // ✘ 剛完成、可能還在寫
stepRow('comment', 'c1', '104', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'none' }, OLD)        // ✔ 卡住
stepRow('status', 's1', '201', { state: 'done', date: 'skipped', writeback: 'failed' }, NOW)                          // ✔
stepRow('status', 's1', '202', { state: 'done', date: 'failed', writeback: 'none' }, OLD)                            // ✘ 日期待確認，不是回填的事
stepRow('edit', 'e1', '301', { fields: 'done', roles: 'skipped', verify: 'done', writeback: 'failed' }, NOW)         // ✔
stepRow('edit', 'e1', '302', { fields: 'done', roles: 'done', verify: 'failed', writeback: 'none' }, OLD)            // ✘ 讀回不符
// 同一張單：舊批次回填失敗、新批次已成功 → 舊的不列
stepRow('comment', 'c-old', '105', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'failed' }, NOW, 'me@t', 1)
stepRow('comment', 'c-new', '105', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'done' }, NOW, 'me@t', 2)

const mine = listPendingBackfill(db, { owner: 'me@t', now: NOW })
const keys = mine.map(i => `${i.tool}:${i.tool === 'create' ? i.rowKey : i.workItemId}:${i.phase}`).sort()
eq('自己的待補清單：只有失敗的、以及卡住的', keys, ['comment:101:failed', 'comment:104:stuck', 'create:2:failed', 'create:4:stuck', 'edit:301:failed', 'status:201:failed'])
eq('全部人：多一筆別人的', listPendingBackfill(db, { owner: null, now: NOW }).length, mine.length + 1)
eq('失敗原因帶出來', mine.find(i => i.tool === 'create' && i.rowKey === '2')?.message, 'Sheet 鎖住')

// retryBackfill 交給各工具自己的函式
const called: string[] = []
const runners = {
  create: async (b: string, r: string) => { called.push(`create:${r}`); return { ok: true, message: null } },
  comment: async () => { throw new Error('Lark 炸了') },
  status: async (_b: string, r: string) => { called.push(`status:${r}`); return { ok: false, message: '列已變動' } },
  edit: async () => ({ ok: true, message: null }),
}
eq('retry：開單交給開單的函式', await retryBackfill(runners, { tool: 'create', batchId: 'x', rowKey: '2' }), { ok: true, message: null })
eq('retry：狀態回報列已變動', await retryBackfill(runners, { tool: 'status', batchId: 's1', rowKey: '201' }), { ok: false, message: '列已變動' })
eq('retry：丟例外 → 失敗並帶原因，不整批中斷', await retryBackfill(runners, { tool: 'comment', batchId: 'c1', rowKey: '101' }), { ok: false, message: 'Lark 炸了' })
eq('retry：只呼叫對應工具', called, ['create:2', 'status:201'])

// ── 移出清單（v5.12.0，CodeX 2026-10-06 的驗收範圍）──
initBackfillDismissSchema(db)
// 下面這些是正式空間的列（v5.12.6 起非管理員碰不到測試空間；欄位預設的 test 是給舊資料用的）
const toProd = () => { for (const t of ['meegle_batch_rows', 'meegle_comment_rows', 'meegle_status_rows', 'meegle_edit_rows']) db.exec(`UPDATE ${t} SET space = 'prod' WHERE space = 'test'`) }
toProd()
const B = '11111111-1111-4111-8111-111111111111'
const hist: number[] = []
const me = { email: 'me@t', admin: false }
const rec = { recordHistory: (rows: unknown[]) => { hist.push(rows.length) }, now: NOW }
eq('越權：不能移別人的列', dismissBackfill(db, [{ tool: 'create', batchId: B, rowKey: '7' }], me, rec)[0].ok, false)
eq('越權被擋時不記歷史', hist, [])
const r1 = dismissBackfill(db, [{ tool: 'create', batchId: B, rowKey: '2' }, { tool: 'comment', batchId: 'c1', rowKey: '101' }], me, rec)
eq('移出兩筆 → 都成功、歷史記一次兩筆', [r1.map(r => r.ok), hist], [[true, true], [2]])
const after = listPendingBackfill(db, { owner: 'me@t', now: NOW }).map(i => `${i.tool}:${i.rowKey}`)
eq('移出後不在清單', [after.includes('create:2'), after.includes('comment:101')], [false, false])
eq('原本的 writeback 狀態不動（不偽造成 done）', (db.prepare(`SELECT writeback_phase FROM meegle_batch_rows WHERE batch_id = ? AND row_key = '2'`).get(B) as { writeback_phase: string }).writeback_phase, 'failed')
const r2 = dismissBackfill(db, [{ tool: 'create', batchId: B, rowKey: '2' }], { email: 'admin@t', admin: true }, rec)
eq('重複請求：回已經移出過、不重複記歷史、不覆蓋第一個移出的人', [r2[0].message, hist, (db.prepare(`SELECT dismissed_by FROM meegle_backfill_dismissed WHERE row_key = '2'`).get() as { dismissed_by: string }).dismissed_by], ['已經移出過', [2], 'me@t'])
eq('admin 可以移別人的', dismissBackfill(db, [{ tool: 'create', batchId: B, rowKey: '7' }], { email: 'admin@t', admin: true }, rec)[0].ok, true)
eq('正在補寫的列 → 不准移', dismissBackfill(db, [{ tool: 'status', batchId: 's1', rowKey: '201' }], me, { ...rec, busy: k => k === 'status:s1:201' })[0].message, '這一列正在補寫，結束後再移')
// 舊批次移出、新批次又失敗 → 新的仍要列出
stepRow('comment', 'c-old2', '106', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'failed' }, NOW, 'me@t', 3)
toProd()
dismissBackfill(db, [{ tool: 'comment', batchId: 'c-old2', rowKey: '106' }], me, rec)
stepRow('comment', 'c-new2', '106', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'failed' }, NOW, 'me@t', 4)
toProd()
eq('舊批次移出、新批次失敗 → 新批次仍列出', listPendingBackfill(db, { owner: 'me@t', now: NOW }).filter(i => i.workItemId === '106').map(i => i.batchId), ['c-new2'])

// 開單頁自己的「補寫回」寫到一半 → 移出要擋（各入口共用同一個標記，CodeX review 99ee76a [P2]）
{
  let release: () => void = () => {}
  const inflight = withWritebackBusy('create', B, '4', () => new Promise<void>(r => { release = r }))
  eq('開單頁補寫途中 → 標記為正在補寫', isWritebackBusy(`create:${B}:4`), true)
  eq('開單頁補寫途中移出 → 擋下', dismissBackfill(db, [{ tool: 'create', batchId: B, rowKey: '4' }], me, { now: NOW, busy: isWritebackBusy })[0].message, '這一列正在補寫，結束後再移')
  // 同一列兩個入口同時寫：一個寫完不能把另一個的標記清掉
  let release2: () => void = () => {}
  const second = withWritebackBusy('create', B, '4', () => new Promise<void>(r => { release2 = r }))
  release(); await inflight
  eq('兩個入口同時寫，一個寫完另一個還在 → 仍標記', isWritebackBusy(`create:${B}:4`), true)
  release2(); await second
  eq('都寫完 → 標記清掉、可以移出', [isWritebackBusy(`create:${B}:4`), dismissBackfill(db, [{ tool: 'create', batchId: B, rowKey: '4' }], me, { now: NOW, busy: isWritebackBusy })[0].ok], [false, true])
  // 寫的途中丟例外也要清掉標記
  await withWritebackBusy('status', 's1', '201', async () => { throw new Error('x') }).catch(() => {})
  eq('補寫丟例外 → 標記仍會清掉', isWritebackBusy('status:s1:201'), false)
}

// 路由的標記：整個 handler 期間都標（CodeX review 1e123a9／074271b [P2]）
// - 只包最後寫 Sheet 那段 → 前面核對空間的等待期間仍能被移出
// - 在回應 close 就放 → 斷線不會取消 handler，查詢回來後照樣補寫
{
  let releaseQuery: () => void = () => {}
  let handlerDone = false
  const wrapped = busyHandler('edit', b => ({ batchId: b.batchId, rowKey: b.rowKey }), async () => {
    await new Promise<void>(r => { releaseQuery = r })   // 卡在「核對空間」
    handlerDone = true
  })
  const res = new EventEmitter()
  const run = (wrapped as unknown as (req: unknown, res: unknown, next: unknown) => Promise<void>)({ body: { batchId: 'e1', rowKey: '301' } }, res, () => {})
  eq('handler 還卡在前置查詢 → 已標記', isWritebackBusy('edit:e1:301'), true)
  res.emit('close')   // 瀏覽器斷線
  eq('斷線（close）但 handler 還在跑 → 仍標記', isWritebackBusy('edit:e1:301'), true)
  eq('斷線後另一分頁移出 → 仍被擋', dismissBackfill(db, [{ tool: 'edit', batchId: 'e1', rowKey: '301' }], me, { now: NOW, busy: isWritebackBusy })[0].message, '這一列正在補寫，結束後再移')
  releaseQuery(); await run
  eq('handler 跑完才解鎖', [handlerDone, isWritebackBusy('edit:e1:301')], [true, false])
  // handler 丟例外也要放
  const boom = busyHandler('edit', b => ({ batchId: b.batchId, rowKey: b.rowKey }), async () => { throw new Error('x') })
  await (boom as unknown as (req: unknown, res: unknown, next: unknown) => Promise<void>)({ body: { batchId: 'e1', rowKey: '301' } }, new EventEmitter(), () => {}).catch(() => {})
  eq('handler 丟例外 → 仍會解鎖', isWritebackBusy('edit:e1:301'), false)
  let called = false
  await (busyHandler('edit', b => ({ batchId: b.batchId, rowKey: b.rowKey }), async () => { called = true }) as unknown as (req: unknown, res: unknown, next: unknown) => Promise<void>)({ body: { batchId: 1 } }, new EventEmitter(), () => {})
  eq('body 拿不到鍵 → 不標、照樣交給 handler 驗證', [called, isWritebackBusy('edit:1:undefined')], [true, false])
}

// ── 測試空間只給管理員（v5.12.6，CodeX：補回填也限 admin）──
{
  stepRow('comment', 'c-test', '107', { desc: 'done', comment: 'done', review: 'skipped', writeback: 'failed' }, NOW, 'me@t', 5)   // 預設 space=test（舊資料也是）
  const mine = (excludeTest: boolean) => listPendingBackfill(db, { owner: 'me@t', now: NOW, excludeTest }).some(i => i.batchId === 'c-test')
  eq('非管理員：待補清單看不到測試空間的列', mine(true), false)
  eq('管理員：看得到', mine(false), true)
  eq('非管理員：移出測試空間的列 → 不准（當成不在清單）', dismissBackfill(db, [{ tool: 'comment', batchId: 'c-test', rowKey: '107' }], me, { now: NOW })[0].ok, false)
  eq('舊資料沒有 space → 仍當測試，不會變成正式讓非管理員碰到', (db.prepare("SELECT space FROM meegle_comment_rows WHERE batch_id = 'c-test'").get() as { space: string }).space, 'test')
  eq('管理員可以移', dismissBackfill(db, [{ tool: 'comment', batchId: 'c-test', rowKey: '107' }], { email: 'admin@t', admin: true }, { now: NOW })[0].ok, true)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

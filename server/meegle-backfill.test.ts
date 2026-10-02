/**
 * Meegle 補回填：哪些列該列出來。跑法：npx tsx server/meegle-backfill.test.ts
 * 用四個工具真的資料表（記憶體 DB）建資料，不另外假造表結構——表改了這裡會跟著壞，不會默默漏列。
 */
import Database from 'better-sqlite3'
import { initMeegleBatchSchema } from './meegle-batch-store.js'
import { initMeegleCommentSchema } from './meegle-comment-store.js'
import { initMeegleStatusSchema } from './meegle-status-store.js'
import { initMeegleEditSchema } from './meegle-edit-store.js'
import { IDLE_MS, listPendingBackfill, retryBackfill } from './meegle-backfill.js'

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

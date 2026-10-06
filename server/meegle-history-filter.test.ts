/**
 * 非管理員的操作歷史過濾（v5.12.7）。跑法：npx tsx server/meegle-history-filter.test.ts（記憶體 DB）
 * CodeX review 1288024 [P1]：舊批次、補回填、移出清單的歷史都沒寫 space，只比字串會全部放行。
 */
import Database from 'better-sqlite3'
import { initMeegleBatchSchema } from './meegle-batch-store.js'
import { initMeegleCommentSchema } from './meegle-comment-store.js'
import { filterMeegleHistoryForNonAdmin } from './meegle-history-filter.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const db = new Database(':memory:')
initMeegleBatchSchema(db); initMeegleCommentSchema(db)
const ins = (batch: string, space: string | null) => db.prepare(`INSERT INTO meegle_batch_rows (batch_id, row_key, owner_email, sheet_url, name, requirement_id, create_phase, ${space ? 'space, ' : ''}created_at, updated_at)
  VALUES (?, '1', 'a@x', 's', 'n', '1', 'created', ${space ? '?, ' : ''}1, 1)`).run(...(space ? [batch, space] : [batch]))
ins('B-prod', 'prod'); ins('B-test', 'test'); ins('B-old', null)   // 舊資料：欄位預設 test
db.prepare("INSERT INTO meegle_comment_rows (batch_id, row_key, source_key, work_item_id, owner_email, space, created_at, updated_at) VALUES ('C-prod', '9', 's', '9', 'a@x', 'prod', 1, 1)").run()

const rec = (feature: string, detail: unknown, id = feature) => ({ id, feature, detail: JSON.stringify(detail) })
const records = [
  rec('meegle-batch-create', { batchId: 'B-prod', space: 'prod' }, 'p'),
  rec('meegle-batch-create', { batchId: 'B-test', space: 'test' }, 't'),
  rec('meegle-batch-create', { batchId: 'B-old' }, 'old'),                 // 舊批次歷史沒有 space
  rec('meegle-batch-create', { batchId: 'B-gone' }, 'gone'),               // 批次已不在 DB
  rec('meegle-backfill', { results: [{ tool: 'create', batchId: 'B-test', rowKey: '1' }, { tool: 'comment', batchId: 'C-prod', rowKey: '9' }] }, 'bf-mixed'),
  rec('meegle-backfill', { action: 'dismiss', rows: [{ tool: 'create', batchId: 'B-old', rowKey: '1' }] }, 'bf-test-only'),
  rec('meegle-account', { loginEmail: 'a@x' }, 'acct'),
  rec('ai-testcase', { x: 1 }, 'other'),
  { id: 'bad', feature: 'meegle-batch-create', detail: '{壞掉' },
]
const out = filterMeegleHistoryForNonAdmin(db, records)
eq('留下：正式批次、補回填混合的那筆、帳號綁定、非 Meegle 功能', out.map(r => r.id), ['p', 'bf-mixed', 'acct', 'other'])
eq('測試批次、舊批次（沒寫 space）、批次已不在、看不懂的 → 都不給看', ['t', 'old', 'gone', 'bad'].every(id => !out.some(r => r.id === id)), true)
eq('補回填混合的紀錄：只留正式空間那一列', JSON.parse(out.find(r => r.id === 'bf-mixed')!.detail!).results.map((x: { batchId: string }) => x.batchId), ['C-prod'])
eq('補回填只有測試空間的列 → 整筆拿掉', out.some(r => r.id === 'bf-test-only'), false)

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

/**
 * Meegle 雙空間（v5.10.0）。跑法：npx tsx server/meegle-space.test.ts（記憶體 DB、假 CLI）
 * 守三件事：一個批次只屬於一個空間；開單時同一列同名在另一個空間開過就擋（v5.60.0 起逐列，不再整份 Sheet 綁一個空間）；動既有單前核對它真正所屬的空間。
 */
import Database from 'better-sqlite3'
import { canUseSpace, checkItemSpace, spaceEnv, spaceProjectKey, spaceSchema } from './meegle-space.js'
import { meegleTarget, type Runner } from './meegle-workitem.js'
import { claimRow, initMeegleBatchSchema, listRowsFromSheet, listRowsFromSheetOtherSpace, takenWorkItemIds, finishCreate } from './meegle-batch-store.js'
import { claimCommentRow, initMeegleCommentSchema, listPreviousForSource } from './meegle-comment-store.js'
import { claimStatusRow, initMeegleStatusSchema, listPreviousStatusForSource } from './meegle-status-store.js'
import { claimEditRow, initMeegleEditSchema, listPreviousEditForSource } from './meegle-edit-store.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const TEST = '6abb348976c120f4f43c746a', PROD = '6ac081a48614642b450645c5'

// ── 設定 ──
eq('兩個空間的 project key', [spaceProjectKey('test', {}), spaceProjectKey('prod', {})], [TEST, PROD])
eq('spaceEnv 讓既有操作改用該空間的 key', [meegleTarget(spaceEnv('prod', {})).projectKey, meegleTarget(spaceEnv('test', {})).projectKey], [PROD, TEST])
eq('env 可覆寫正式 key', spaceProjectKey('prod', { MEEGLE_PROD_PROJECT_KEY: 'p2' }), 'p2')
eq('新請求沒帶 space／亂帶 → 驗證失敗（不默默當測試）', [spaceSchema.safeParse(undefined).success, spaceSchema.safeParse('').success, spaceSchema.safeParse('staging').success, spaceSchema.safeParse('prod').success], [false, false, false, true])

// ── 測試空間只給管理員（v5.12.6）──
eq('測試空間：管理員可以、舊多角色含 admin 也可以', [canUseSpace('admin', 'test'), canUseSpace('pm,admin', 'test')], [true, true])
eq('測試空間：其他角色、沒登入都不行', [canUseSpace('qa', 'test'), canUseSpace('r_custom', 'test'), canUseSpace(undefined, 'test')], [false, false, false])
eq('正式空間：誰都可以', [canUseSpace('qa', 'prod'), canUseSpace(undefined, 'prod')], [true, true])

// ── 開單 ──
{
  const db = new Database(':memory:'); initMeegleBatchSchema(db)
  const row = (o: Record<string, unknown> = {}) => ({ batchId: 'B1', rowKey: '3', ownerEmail: 'a@x', sheetUrl: 'lark:T:S1', name: 'Bug', requirementId: '1', targetState: '', space: 'test' as const, ...o })
  eq('開單：測試空間認領', claimRow(db, row()).kind, 'claimed')
  eq('開單：同一批次換成正式 → space-mismatch', claimRow(db, row({ rowKey: '4', space: 'prod' })).kind, 'space-mismatch')
  eq('開單：同列在測試開單中 → 正式新批次 busy（結果未明不分空間都擋）', claimRow(db, row({ batchId: 'B2', space: 'prod' })).kind, 'busy')
  eq('開單：別份 Sheet 送正式可以', claimRow(db, row({ batchId: 'B3', sheetUrl: 'lark:T:S2', space: 'prod' })).kind, 'claimed')
  eq('開單：紀錄記下空間', (db.prepare("SELECT space FROM meegle_batch_rows WHERE batch_id = 'B3'").get() as { space: string }).space, 'prod')
  eq('開單：之前送過的列只列同空間', [listRowsFromSheet(db, 'lark:T:S1', 'test').length, listRowsFromSheet(db, 'lark:T:S1', 'prod').length], [1, 0])
  eq('開單：另一個空間的紀錄逐列給前端', [listRowsFromSheetOtherSpace(db, 'lark:T:S1', 'prod').map(r => r.row_key), listRowsFromSheetOtherSpace(db, 'lark:T:S1', 'test').length], [['3'], 0])
  finishCreate(db, 'B1', '3', { phase: 'created', workItemId: '111', url: '' })
  finishCreate(db, 'B3', '3', { phase: 'created', workItemId: '222', url: '' })
  eq('開單：同列同名在自己空間開過 → already-created', claimRow(db, row({ batchId: 'B5', space: 'test' })).kind, 'already-created')
  eq('開單：同列同名已在測試開過 → 正式 space-conflict', claimRow(db, row({ batchId: 'B4', space: 'prod' })), { kind: 'space-conflict', other: 'test' })
  eq('開單：同列同名、送出名稱被改過也認得（比 Sheet 上的名稱）', claimRow(db, row({ batchId: 'B4', name: 'AI 改過', sheetName: 'Bug', space: 'prod' })), { kind: 'space-conflict', other: 'test' })
  eq('開單：同列換了名稱 → 正式可以開（同一份 Sheet 換內容重開）', claimRow(db, row({ batchId: 'B4', name: 'Bug v2', space: 'prod' })).kind, 'claimed')
  eq('開單：同 Sheet 別列 → 正式可以開', claimRow(db, row({ batchId: 'B4', rowKey: '5', name: 'Other', space: 'prod' })).kind, 'claimed')
  eq('開單：查結果時排除的已用單號只看同空間', [[...takenWorkItemIds(db, 'test')], [...takenWorkItemIds(db, 'prod')]], [['111'], ['222']])
  // 舊資料（加欄位前）一律算測試
  db.prepare("INSERT INTO meegle_batch_rows (batch_id, row_key, owner_email, sheet_url, name, requirement_id, create_phase, created_at, updated_at) VALUES ('OLD', '9', 'a@x', 'lark:T:S9', 'n', '1', 'created', 1, 1)").run()
  eq('開單：舊紀錄是測試空間', (db.prepare("SELECT space FROM meegle_batch_rows WHERE batch_id = 'OLD'").get() as { space: string }).space, 'test')
}

// ── 評論 ──
{
  const db = new Database(':memory:'); initMeegleCommentSchema(db)
  const base = (o: Record<string, unknown> = {}) => ({ batchId: 'c1', workItemId: '100', sourceKey: 'lark:T:S', sheetUrl: 'u', sheetRow: 5, summary: '', ownerEmail: 'a@x', asEmail: '', videos: [], withReview: false, space: 'prod' as const, ...o })
  eq('評論：正式空間認領', claimCommentRow(db, base()).kind, 'claimed')
  eq('評論：同批次換測試 → space-mismatch', claimCommentRow(db, base({ workItemId: '101', space: 'test' })).kind, 'space-mismatch')
  eq('評論：同 Sheet 新批次送測試 → 可以（單子所屬空間交給 checkItemSpace）', claimCommentRow(db, base({ batchId: 'c2', workItemId: '102', space: 'test' })).kind, 'claimed')
  eq('評論：之前送過的列只列同空間', [listPreviousForSource(db, 'lark:T:S', 'prod').length, listPreviousForSource(db, 'lark:T:S', 'test').length], [1, 1])
}

// ── 狀態 ──
{
  const db = new Database(':memory:'); initMeegleStatusSchema(db)
  const a = { batchId: 's1', workItemId: '100', sourceKey: 'lark:T:S', sheetUrl: 'u', sheetRow: 2, summary: '', ownerEmail: 'a@x', targetKey: 'k', targetName: '', dateMode: 'keep' as const, sheetDate: null, space: 'test' as const }
  eq('狀態：測試空間認領', claimStatusRow(db, a).kind, 'claimed')
  eq('狀態：同批次換正式 → space-mismatch', claimStatusRow(db, { ...a, workItemId: '101', space: 'prod' }).kind, 'space-mismatch')
  eq('狀態：同 Sheet 新批次送正式 → 可以', claimStatusRow(db, { ...a, batchId: 's2', workItemId: '102', space: 'prod' }).kind, 'claimed')
  eq('狀態：之前送過的列只列同空間', [listPreviousStatusForSource(db, 'lark:T:S', 'test').length, listPreviousStatusForSource(db, 'lark:T:S', 'prod').length], [1, 1])
}

// ── 修改 ──
{
  const db = new Database(':memory:'); initMeegleEditSchema(db)
  const a = { batchId: 'e1', workItemId: '100', sourceKey: 'lark:T:S', sheetUrl: '', sheetRow: 2, summary: '', ownerEmail: 'a@x', payload: '{}', space: 'test' as const }
  eq('修改：測試空間認領', claimEditRow(db, a).kind, 'claimed')
  eq('修改：同批次換正式 → space-mismatch', claimEditRow(db, { ...a, workItemId: '101', space: 'prod' }).kind, 'space-mismatch')
  eq('修改：同 Sheet 新批次送正式 → 可以', claimEditRow(db, { ...a, batchId: 'e2', workItemId: '102', space: 'prod' }).kind, 'claimed')
  eq('修改：之前送過的列只列同空間', [listPreviousEditForSource(db, 'lark:T:S', 'test').length, listPreviousEditForSource(db, 'lark:T:S', 'prod').length], [1, 1])
}

// ── 同一份 Sheet 換內容重開（使用者 2026-10-15；CodeX 要求補的情境）──
{
  const db = new Database(':memory:'); initMeegleBatchSchema(db); initMeegleCommentSchema(db); initMeegleStatusSchema(db); initMeegleEditSchema(db)
  const row = (o: Record<string, unknown>) => ({ batchId: 'X', rowKey: '3', ownerEmail: 'a@x', sheetUrl: 'lark:T:X', name: 'A', requirementId: '1', targetState: '', space: 'test' as const, ...o })
  eq('重開：測試開 A', claimRow(db, row({ batchId: 'T1' })).kind, 'claimed')
  finishCreate(db, 'T1', '3', { phase: 'created', workItemId: '500', url: '' })
  eq('重開：同列換成 B → 正式開 B', claimRow(db, row({ batchId: 'P1', name: 'B', space: 'prod' })).kind, 'claimed')
  finishCreate(db, 'P1', '3', { phase: 'created', workItemId: '600', url: '' })
  eq('重開：正式評論 B（同 Sheet 兩個空間都有紀錄也不卡）', claimCommentRow(db, { batchId: 'c1', workItemId: '600', sourceKey: 'lark:T:X', sheetUrl: 'u', sheetRow: 3, summary: '', ownerEmail: 'a@x', asEmail: '', videos: [], withReview: false, space: 'prod' }).kind, 'claimed')
  eq('重開：測試改 A 的狀態', claimStatusRow(db, { batchId: 's1', workItemId: '500', sourceKey: 'lark:T:X', sheetUrl: 'u', sheetRow: 3, summary: '', ownerEmail: 'a@x', targetKey: 'k', targetName: '', dateMode: 'keep', sheetDate: null, space: 'test' }).kind, 'claimed')
  eq('重開：正式修改 B', claimEditRow(db, { batchId: 'e1', workItemId: '600', sourceKey: 'lark:T:X', sheetUrl: '', sheetRow: 3, summary: '', ownerEmail: 'a@x', payload: '{}', space: 'prod' }).kind, 'claimed')
  eq('重開：B 換回 A 送正式 → space-conflict（A 在測試開過）', claimRow(db, row({ batchId: 'P2', name: 'A', space: 'prod' })), { kind: 'space-conflict', other: 'test' })
  // 結果未明時改名重送：不比名稱、不分空間都擋
  eq('未明：測試開 C', claimRow(db, row({ batchId: 'T2', rowKey: '7', name: 'C' })).kind, 'claimed')
  finishCreate(db, 'T2', '7', { phase: 'unknown', message: 'timeout' })
  eq('未明：同列改名後送測試 → busy', claimRow(db, row({ batchId: 'T3', rowKey: '7', name: 'C2' })).kind, 'busy')
  eq('未明：同列改名後送正式 → busy', claimRow(db, row({ batchId: 'P3', rowKey: '7', name: 'C2', space: 'prod' })).kind, 'busy')
  // 舊資料（沒有 sheet_name、沒有 space）：用 name、當測試
  db.prepare("INSERT INTO meegle_batch_rows (batch_id, row_key, owner_email, sheet_url, name, requirement_id, create_phase, created_at, updated_at) VALUES ('OLD', '9', 'a@x', 'lark:T:X', 'Old', '1', 'created', 1, 1)").run()
  eq('舊資料：同列同名（name）送正式 → space-conflict', claimRow(db, row({ batchId: 'P4', rowKey: '9', name: 'Old', space: 'prod' })), { kind: 'space-conflict', other: 'test' })
  eq('舊資料：同列換名送正式 → 可以', claimRow(db, row({ batchId: 'P4', rowKey: '9', name: 'New', space: 'prod' })).kind, 'claimed')
}

// ── 核對單子所屬空間（Meegle 不驗 project key：2026-10-05 拿正式 key 讀測試的單照樣 200）──
{
  const calls: string[][] = []
  const owned = (key: string | null): Runner => async args => {
    calls.push(args)
    const attr = key ? { owned_project: { key, name: 'x' } } : {}
    return { stdout: JSON.stringify({ work_item_attribute: attr }), stderr: '', exitCode: 0, timedOut: false }
  }
  const r1 = await checkItemSpace('tok', '15194995', 'test', owned(TEST), {})
  eq('核對：單子在測試、選測試 → ok', r1.kind, 'ok')
  eq('核對：查詢帶的是選的那個空間的 key', calls[0].slice(0, 5), ['workitem', 'get', '--project-key', TEST, '--work-item-id'])
  const r2 = await checkItemSpace('tok', '15194995', 'prod', owned(TEST), {})
  eq('核對：單子在測試、選正式 → rejected，訊息說出實際空間', [r2.kind, 'message' in r2 && /「測試」空間的單.*「正式」/.test(r2.message)], ['rejected', true])
  const r3 = await checkItemSpace('tok', '1', 'prod', owned('zzz'), {})
  eq('核對：別的空間 → rejected', r3.kind, 'rejected')
  const r4 = await checkItemSpace('tok', '1', 'test', owned(null), {})
  eq('核對：讀不到所屬空間 → unknown（不能當通過）', r4.kind, 'unknown')
  const r5 = await checkItemSpace('tok', '1', 'test', async () => ({ stdout: '', stderr: '{"error":{"message":"not found,retriable=false"}}', exitCode: 1, timedOut: false }), {})
  eq('核對：查詢失敗照原樣回傳', r5.kind, 'rejected')
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

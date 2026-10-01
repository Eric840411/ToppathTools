/**
 * Meegle 批量開單落地紀錄的測試。跑法：npx tsx server/meegle-batch-store.test.ts
 * 守的是「同一列不會開出兩張單」：重送、併發、逾時、伺服器重啟。
 */
import Database from 'better-sqlite3'
import { sheetSourceKey } from '../shared/lark-sheet-url.js'
import {
  adoptTarget, claimRow, expireStaleCreating, needsStatePush, listRowsFromSheet, finishCreate, finishState, getBatchRow, getPersonMap, initMeegleBatchSchema,
  resolveUnknown, upsertPersonMap,
} from './meegle-batch-store.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const fresh = () => { const db = new Database(':memory:'); initMeegleBatchSchema(db); return db }
const row = (over: Partial<{ batchId: string; rowKey: string; ownerEmail: string }> = {}) =>
  ({ batchId: 'B', rowKey: '3', ownerEmail: 'a@x.tw', name: 'Bug', requirementId: '15170734', targetState: '可本機測試', ...over })

{
  const db = fresh()
  eq('第一次認領', claimRow(db, row()).kind, 'claimed')
  eq('同一列開單中再送 → busy（不能開第二張）', claimRow(db, row()).kind, 'busy')
  finishCreate(db, 'B', '3', { phase: 'created', workItemId: '15190441', url: 'u' })
  eq('開成功後再送 → already-created（只補狀態）', claimRow(db, row()).kind, 'already-created')
  eq('單號有存下來', getBatchRow(db, 'B', '3')?.work_item_id, '15190441')
  eq('別人不能接手這一列', claimRow(db, row({ ownerEmail: 'b@x.tw' })).kind, 'not-owner')
  eq('email 大小寫不同仍是本人', claimRow(db, row({ ownerEmail: 'A@X.tw' })).kind, 'already-created')
}
{
  const db = fresh()
  claimRow(db, row())
  finishCreate(db, 'B', '3', { phase: 'unknown', message: '逾時' })
  eq('逾時 → 結果待確認，再送也不開', claimRow(db, row()).kind, 'busy')
  eq('查明有單 → 收成 created', resolveUnknown(db, 'B', '3', { workItemId: '9', url: 'u' }), true)
  eq('收成後狀態', getBatchRow(db, 'B', '3')?.create_phase, 'created')
}
{
  const db = fresh()
  claimRow(db, row())
  finishCreate(db, 'B', '3', { phase: 'unknown', message: '逾時' })
  resolveUnknown(db, 'B', '3', null)
  eq('查明沒有單 → failed，可以重送', claimRow(db, row()).kind, 'claimed')
}
{
  const db = fresh()
  claimRow(db, row())
  finishCreate(db, 'B', '3', { phase: 'failed', message: '人員無效' })
  eq('伺服器明確拒絕 → 可以修正後重送', claimRow(db, row()).kind, 'claimed')
  finishCreate(db, 'B', '3', { phase: 'created', workItemId: '1', url: '' })
  finishCreate(db, 'B', '3', { phase: 'failed', message: '晚到的舊結果' })
  eq('晚到的結果不能蓋掉已開成功的單', getBatchRow(db, 'B', '3')?.create_phase, 'created')
}
{
  const db = fresh()
  claimRow(db, row(), 1000)
  eq('還沒逾期的 creating 不動', expireStaleCreating(db, 10 * 60_000, 1000 + 60_000), 0)
  eq('伺服器重啟留下的 creating → 轉成待確認', expireStaleCreating(db, 10 * 60_000, 1000 + 11 * 60_000), 1)
  eq('轉成待確認後不能重送', claimRow(db, row()).kind, 'busy')
}
{
  const db = fresh()
  claimRow(db, row())
  finishState(db, 'B', '3', 'done', null)
  eq('還沒開成功時不能寫狀態結果', getBatchRow(db, 'B', '3')?.state_phase, 'none')
}
{
  const db = fresh()
  upsertPersonMap(db, '  James  Chang ', { userKey: 'u1', email: 'james@x.tw', name: 'James' }, 'a@x.tw')
  eq('人名正規化（大小寫、多餘空白）後對得到', getPersonMap(db, ['james chang'])['james chang']?.meegle_user_key, 'u1')
  upsertPersonMap(db, 'James Chang', { userKey: 'u2', email: 'j2@x.tw', name: 'J' }, 'a@x.tw')
  eq('Jenny Hsu 與 Jenny Lin 是兩筆', (upsertPersonMap(db, 'Jenny Lin', { userKey: 'u9', email: 'jl@x.tw', name: 'Jenny' }, 'a'), Object.keys(getPersonMap(db, ['Jenny Hsu', 'Jenny Lin']))), ['jenny lin'])
  eq('同名再存 → 更新，不會出現兩筆', getPersonMap(db, ['JAMES CHANG'])['james chang']?.meegle_user_key, 'u2')
}

{
  const db = fresh()
  claimRow(db, { ...row(), sheetUrl: 'S1' }); finishCreate(db, 'B', '3', { phase: 'created', workItemId: '11', url: 'u' })
  claimRow(db, { ...row({ rowKey: '4' }), sheetUrl: 'S1' }); finishCreate(db, 'B', '4', { phase: 'failed', message: 'x' })
  claimRow(db, { ...row({ batchId: 'C' }), sheetUrl: 'S2' }); finishCreate(db, 'C', '3', { phase: 'created', workItemId: '12', url: 'u' })
  eq('同一份 Sheet 送過的列（跨批次）不含 failed、不混別份 Sheet', listRowsFromSheet(db, 'S1').map(r => r.work_item_id), ['11'])
}
// ── CodeX review 999f895 [P1]：重整後 batchId 換新，不能繞過防重複 ──
{
  const db = fresh()
  claimRow(db, { ...row(), sheetUrl: 'S1' })
  finishCreate(db, 'B', '3', { phase: 'unknown', message: '逾時' })
  eq('重整後新批次送同一份 Sheet 同一列 → busy（原批次待確認）', claimRow(db, { ...row({ batchId: 'NEW' }), sheetUrl: 'S1' }).kind, 'busy')
  eq('回傳的是原批次那筆，前端才接得回去', (claimRow(db, { ...row({ batchId: 'NEW' }), sheetUrl: 'S1' }) as { row: { batch_id: string } }).row.batch_id, 'B')
  eq('新批次沒有被寫進任何紀錄', db.prepare("SELECT COUNT(*) c FROM meegle_batch_rows WHERE batch_id = 'NEW'").get(), { c: 0 })
  eq('別份 Sheet 的同列號不受影響', claimRow(db, { ...row({ batchId: 'X' }), sheetUrl: 'S2' }).kind, 'claimed')
  eq('待確認的列會出現在 Sheet 歷史裡（前端要接回原批次）', listRowsFromSheet(db, 'S1').map(r => [r.batch_id, r.create_phase]), [['B', 'unknown']])
}
// ── CodeX review 999f895 [P1]：換 Sheet 不能沿用舊批次 ──
{
  const db = fresh()
  claimRow(db, { ...row(), sheetUrl: 'A' }); finishCreate(db, 'B', '3', { phase: 'created', workItemId: '11', url: 'u' })
  eq('同一批次換成別份 Sheet → 拒絕（不能回傳 A 的單號）', claimRow(db, { ...row(), sheetUrl: 'B-sheet' }).kind, 'source-mismatch')
  eq('同一批次同一份 Sheet 照常', claimRow(db, { ...row(), sheetUrl: 'A' }).kind, 'already-created')
}

// ── CodeX review 999f895 [P2]：查回成功後要補推狀態 ──
{
  const db = fresh()
  claimRow(db, row())   // targetState = 可本機測試
  finishCreate(db, 'B', '3', { phase: 'unknown', message: '逾時' })
  resolveUnknown(db, 'B', '3', { workItemId: '9', url: 'u' })
  eq('查回收成 created 後，有目標狀態 → 需要補推', needsStatePush(getBatchRow(db, 'B', '3')!), true)
  finishState(db, 'B', '3', 'done', null)
  eq('推完就不再推', needsStatePush(getBatchRow(db, 'B', '3')!), false)
  eq('沒有目標狀態 → 不推', needsStatePush({ create_phase: 'created', work_item_id: '1', target_state: '', state_phase: 'none' }), false)
  eq('推失敗的也要補推', needsStatePush({ create_phase: 'created', work_item_id: '1', target_state: 'K', state_phase: 'failed' }), true)
}

// ── CodeX review 4bc4fa9 [P2]：雙分頁，B 收到 busy 後重推不能用 B 的目標 ──
{
  const db = fresh()
  // 分頁 A：目標「可本機測試」送出，開單成功、推狀態失敗
  claimRow(db, { ...row({ batchId: 'A' }), sheetUrl: 'S', targetState: 'BAOjDk8Pv' })
  finishCreate(db, 'A', '3', { phase: 'created', workItemId: '9', url: 'u' })
  finishState(db, 'A', '3', 'failed', 'x')
  // 分頁 B：選「完成」送同一列 → 撞到 A 的紀錄
  const b = claimRow(db, { ...row({ batchId: 'B' }), sheetUrl: 'S', targetState: 'Finished' })
  eq('B 送同一列（A 已開單）→ already-created，不會開第二張', b.kind, 'already-created')
  eq('回傳的是 A 的紀錄（帶 A 的目標）', b.kind === 'already-created' && [b.row.batch_id, b.row.target_state], ['A', 'BAOjDk8Pv'])
  eq('B 沒有寫任何紀錄', db.prepare("SELECT COUNT(*) c FROM meegle_batch_rows WHERE batch_id = 'B'").get(), { c: 0 })
  eq('同一列但名稱改了 → 視為新的一筆，可以開', claimRow(db, { ...row({ batchId: 'B' }), name: '改過的名稱', sheetUrl: 'S', targetState: 'Finished' }).kind, 'claimed')
  eq('重推 A 那列：用紀錄的目標，不用請求帶的「完成」', adoptTarget(db, 'A', '3', 'Finished'), 'BAOjDk8Pv')
  eq('紀錄的目標沒有被請求改掉', getBatchRow(db, 'A', '3')?.target_state, 'BAOjDk8Pv')
}
{
  const db = fresh()
  claimRow(db, { ...row(), targetState: '' })
  finishCreate(db, 'B', '3', { phase: 'created', workItemId: '9', url: 'u' })
  eq('紀錄沒有目標 → 採用請求帶的並寫回', adoptTarget(db, 'B', '3', 'Finished'), 'Finished')
  eq('寫回之後再帶別的也不會改', adoptTarget(db, 'B', '3', 'BAOjDk8Pv'), 'Finished')
  eq('紀錄沒目標、請求也沒帶 → 空', (claimRow(db, { ...row({ rowKey: '4' }), targetState: '' }), adoptTarget(db, 'B', '4', '')), '')
}

// ── CodeX review 0c30dde [P2]：同一份 Sheet 不同網址不能繞過防重複 ──
{
  const db = fresh()
  const u1 = 'https://x.larksuite.com/sheets/TOK123?sheet=S1'
  const u2 = 'https://x.larksuite.com/sheets/TOK123?from=share&sheet=S1'
  eq('兩種網址得到同一個識別值', sheetSourceKey(u1) === sheetSourceKey(u2), true)
  eq('不同分頁（sheet）是不同來源', sheetSourceKey(u1) === sheetSourceKey('https://x.larksuite.com/sheets/TOK123?sheet=S2'), false)
  claimRow(db, { ...row({ batchId: 'A' }), sheetUrl: sheetSourceKey(u1) }); finishCreate(db, 'A', '3', { phase: 'created', workItemId: '9', url: 'u' })
  eq('換個網址尾巴再送同一列 → 已開過，不重開', claimRow(db, { ...row({ batchId: 'B' }), sheetUrl: sheetSourceKey(u2) }).kind, 'already-created')
}

// ── 接線檢查（CodeX review 0c30dde [P2]×2）：/row 撞到「已開過」時不能在路由裡推狀態 ──
// 路由一 import 就會開 DB，所以這裡讀原始碼檢查那個分支。⚠️ 只證明「那段沒有呼叫」，不是行為測試。
{
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('./routes/meegle-batch.ts', import.meta.url), 'utf8')
  const start = src.indexOf("if (claim.kind === 'already-created')")
  const branch = start >= 0 ? src.slice(start, src.indexOf('\n    }', start)) : ''
  eq('找得到「已開過」分支', start >= 0, true)
  eq('「已開過」分支不推狀態（不能用我的 token 推別人的單）', /pushState\(/.test(branch), false)
  eq('「已開過」分支不採用請求帶來的目標', /adoptTarget\(/.test(branch), false)
  eq('/previous 與 /row 都用正規化的來源識別值', (src.match(/sheetSourceKey\(/g) ?? []).length >= 3, true)
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

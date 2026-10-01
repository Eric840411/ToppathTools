/**
 * Meegle 批量開單落地紀錄的測試。跑法：npx tsx server/meegle-batch-store.test.ts
 * 守的是「同一列不會開出兩張單」：重送、併發、逾時、伺服器重啟。
 */
import Database from 'better-sqlite3'
import {
  claimRow, expireStaleCreating, listCreatedFromSheet, finishCreate, finishState, getBatchRow, getPersonMap, initMeegleBatchSchema,
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
  eq('同一份 Sheet 開過的單（跨批次）只列成功的、不混別份 Sheet', listCreatedFromSheet(db, 'S1').map(r => r.work_item_id), ['11'])
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

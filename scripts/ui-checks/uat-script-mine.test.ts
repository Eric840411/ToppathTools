/**
 * 後台錄製腳本「我的」清單的資料規則（1007，CodeX 定案）。用記憶體 SQLite 跑**產品的** uat-script-mine.ts。
 *
 *   npx tsx scripts/ui-checks/uat-script-mine.test.ts
 */
import Database from 'better-sqlite3'
import { initScriptMine, readMine, addToMine, removeFromMine, reorderMine, bumpOwnersHolding, addNewScriptToMineTx } from '../../server/uat-script-mine.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const fresh = () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE uat_recorded_scripts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`)
  const add = (id: string, owner: string, at: number) => db.prepare('INSERT INTO uat_recorded_scripts VALUES (?, ?, ?, ?, ?, NULL)').run(id, owner, id, '{}', at)
  return { db, add }
}
const softDelete = (db: Database.Database, id: string) => { db.prepare('UPDATE uat_recorded_scripts SET deleted_at = 1 WHERE id = ?').run(id); bumpOwnersHolding(db, id) }
const restore = (db: Database.Database, id: string) => { db.prepare('UPDATE uat_recorded_scripts SET deleted_at = NULL WHERE id = ?').run(id); bumpOwnersHolding(db, id) }

// 補種：依建立者、依建立時間，只做一次（持久標記）
{
  const { db, add } = fresh()
  add('A1', 'eric', 1); add('B1', 'siara', 2); add('A2', 'eric', 3)
  initScriptMine(db)
  ok(JSON.stringify(readMine(db, 'eric').ids) === '["A1","A2"]' && JSON.stringify(readMine(db, 'siara').ids) === '["B1"]', '補種：既有腳本依建立者加入各自的「我的」', readMine(db, 'eric'))
  removeFromMine(db, 'eric', ['A1', 'A2'])
  initScriptMine(db)   // 重開機
  ok(readMine(db, 'eric').ids.length === 0, '補種只做一次：自己全部移除後重開機不會被補回（不靠「清單是空的」判斷）', readMine(db, 'eric'))
}

// 補種只做一次：只有一個人、他把清單全部移除之後重開機（整張表是空的）也不能被補回
{
  const { db, add } = fresh()
  add('S1', 'solo', 1); add('S2', 'solo', 2)
  initScriptMine(db)
  removeFromMine(db, 'solo', ['S1', 'S2'])
  initScriptMine(db)
  ok(readMine(db, 'solo').ids.length === 0, '補種只做一次：整張清單表是空的也不補回（靠持久標記）', readMine(db, 'solo'))
}

// 腳本被刪除 → 有它的每個人的清單版本 +1；最後一列被刪後追加，位置不能跟它撞
{
  const { db, add } = fresh()
  initScriptMine(db)
  add('X', 'eric', 1); addNewScriptToMineTx(db, 'eric', 'X'); add('Y', 'eric', 2); addNewScriptToMineTx(db, 'eric', 'Y')
  addToMine(db, 'siara', ['Y'])
  const e0 = readMine(db, 'eric').revision, s0 = readMine(db, 'siara').revision
  softDelete(db, 'Y')   // Y 是 eric 清單的最後一列
  ok(readMine(db, 'eric').revision === e0 + 1 && readMine(db, 'siara').revision === s0 + 1, '腳本被刪 → 有它的每個人清單版本 +1', { e0, s0, e: readMine(db, 'eric').revision, s: readMine(db, 'siara').revision })
  add('Z', 'eric', 3); addNewScriptToMineTx(db, 'eric', 'Z')
  restore(db, 'Y')
  const pos = db.prepare("SELECT script_id, position FROM uat_recorded_script_mine WHERE owner = 'eric'").all() as { script_id: string; position: number }[]
  ok(new Set(pos.map(p => p.position)).size === pos.length, '最後一列被刪後新增、再還原：位置不撞（追加要算看不到的列）', pos)
}

// 新建：加到最後；加入冪等；只收存在的腳本
{
  const { db, add } = fresh()
  initScriptMine(db)
  add('A1', 'eric', 1); addNewScriptToMineTx(db, 'eric', 'A1')
  add('B1', 'siara', 2)
  const r0 = readMine(db, 'eric').revision
  const r = addToMine(db, 'eric', ['B1', 'B1', 'A1', 'NOPE'])
  ok(JSON.stringify(r.ids) === '["A1","B1"]' && JSON.stringify(r.added) === '["B1"]' && r.revision === r0 + 1, '加入別人的：不重複、已在清單的不動位置、不存在的忽略、版本 +1', r)
  const r2 = addToMine(db, 'eric', ['B1'])
  ok(r2.added.length === 0 && r2.revision === r.revision, '重複加入：冪等、版本不變', r2)
}

// 排序：版本、完整性、看不到的列保留位置
{
  const { db, add } = fresh()
  initScriptMine(db)
  for (const [i, id] of ['A', 'B', 'C', 'D'].entries()) { add(id, 'eric', i); addNewScriptToMineTx(db, 'eric', id) }
  let m = readMine(db, 'eric')
  const r = reorderMine(db, 'eric', ['D', 'A', 'C', 'B'], m.revision)
  ok(r.ok && JSON.stringify(readMine(db, 'eric').ids) === '["D","A","C","B"]', '拖曳排序：照送來的順序存', r)
  const stale = reorderMine(db, 'eric', ['A', 'B', 'C', 'D'], m.revision)
  ok(!stale.ok && stale.code === 'revision_conflict' && JSON.stringify(readMine(db, 'eric').ids) === '["D","A","C","B"]', '舊版本（別的分頁）送來 → 409、不改', stale)
  m = readMine(db, 'eric')
  for (const [ids, why] of [[['D', 'A', 'C'], '少一個'], [['D', 'A', 'C', 'B', 'X'], '多一個'], [['D', 'A', 'A', 'B'], '重複'], [['D', 'A', 'C', 'X'], '換掉一個']] as Array<[string[], string]>) {
    const bad = reorderMine(db, 'eric', ids, m.revision)
    ok(!bad.ok && bad.code === 'mismatch', `完整性：${why} → 拒絕`, bad)
  }
  // C 被軟刪除 → 從清單消失、版本 +1；排序只排看得到的；還原後 C 回到原本的位置（不撞位）
  softDelete(db, 'C')
  m = readMine(db, 'eric')
  ok(JSON.stringify(m.ids) === '["D","A","B"]', '腳本被刪 → 從「我的」消失', m)
  const r3 = reorderMine(db, 'eric', ['B', 'D', 'A'], m.revision)
  ok(r3.ok, '刪除之後只排看得到的三個', r3)
  restore(db, 'C')
  const after = readMine(db, 'eric').ids
  ok(after.length === 4 && after.includes('C') && new Set(after).size === 4, '還原後回到清單、沒有重複或撞位', after)
  const pos = db.prepare("SELECT position FROM uat_recorded_script_mine WHERE owner = 'eric'").all() as { position: number }[]
  ok(new Set(pos.map(p => p.position)).size === pos.length, '所有列的位置都不重複', pos)
  // 追加位置把看不到的列算進去
  softDelete(db, 'C'); add('E', 'eric', 9); addNewScriptToMineTx(db, 'eric', 'E')
  const posE = (db.prepare("SELECT position FROM uat_recorded_script_mine WHERE owner = 'eric' AND script_id = 'E'").get() as { position: number }).position
  const maxOthers = (db.prepare("SELECT MAX(position) AS p FROM uat_recorded_script_mine WHERE owner = 'eric' AND script_id != 'E'").get() as { p: number }).p
  ok(posE > maxOthers, '追加到最後：位置大於所有列（含看不到的）', { posE, maxOthers })
}

// 移除只動自己的清單、不刪腳本、不影響別人
{
  const { db, add } = fresh()
  initScriptMine(db)
  add('A', 'eric', 1); addNewScriptToMineTx(db, 'eric', 'A'); addToMine(db, 'siara', ['A'])
  const r = removeFromMine(db, 'eric', ['A'])
  const still = db.prepare("SELECT deleted_at FROM uat_recorded_scripts WHERE id = 'A'").get() as { deleted_at: number | null }
  ok(r.removed === 1 && r.ids.length === 0 && still.deleted_at === null && readMine(db, 'siara').ids.includes('A'), '移除：只從自己的清單拿掉，腳本還在、別人的清單不受影響', r)
}

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)

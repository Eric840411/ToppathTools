/**
 * H5／PC 腳本清單改版（1007）：「我的」依平台分頁、軟刪除、刪除權限看登入帳號。用記憶體 SQLite 跑**產品的** uat-script-mine.ts。
 *
 *   npx tsx scripts/ui-checks/frontend-script-mine.test.ts
 */
import Database from 'better-sqlite3'
import { frontendMine, canDeleteFrontendScript, initScriptMine, readMine } from '../../server/uat-script-mine.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const db = new Database(':memory:')
db.exec(`CREATE TABLE frontend_auto_scripts (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, owner_email TEXT NOT NULL DEFAULT '', deleted_at INTEGER)`)
db.exec(`CREATE TABLE uat_recorded_scripts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`)
frontendMine.init(db)
initScriptMine(db)
const add = (id: string, platform: 'h5' | 'pc', owner = '') => {
  db.prepare('INSERT INTO frontend_auto_scripts (id, name, platform, owner_email) VALUES (?, ?, ?, ?)').run(id, id, platform, owner)
  if (owner) frontendMine.addNewScriptToMineTx(db, owner, id)
}
const ids = (platform: 'h5' | 'pc', who = 'eric') => JSON.stringify(frontendMine.readMine(db, who, platform).ids)

// 新建自動加入；依平台分開看
add('H1', 'h5', 'eric'); add('P1', 'pc', 'eric'); add('H2', 'h5', 'eric'); add('P2', 'pc', 'eric')
ok(ids('h5') === '["H1","H2"]' && ids('pc') === '["P1","P2"]', '新建自動加入「我的」；H5 只看到 H5、PC 只看到 PC', [ids('h5'), ids('pc')])

// 舊腳本（沒有登入帳號）不會被加進任何人的清單
add('OLD', 'h5')
ok(!ids('h5').includes('OLD'), '舊腳本沒有登入帳號 → 不自動加進任何人的「我的」')
frontendMine.addToMine(db, 'eric', ['OLD'], 'h5')
ok(ids('h5') === '["H1","H2","OLD"]', '舊腳本可以自己從「全部」加入', ids('h5'))

// 排序只重排這個平台；PC 那幾列的位置不動
const pcBefore = db.prepare("SELECT script_id, position FROM frontend_auto_script_mine WHERE script_id LIKE 'P%' ORDER BY script_id").all()
const rev = frontendMine.readMine(db, 'eric', 'h5').revision
const r = frontendMine.reorderMine(db, 'eric', ['OLD', 'H2', 'H1'], rev, 'h5')
const pcAfter = db.prepare("SELECT script_id, position FROM frontend_auto_script_mine WHERE script_id LIKE 'P%' ORDER BY script_id").all()
ok(r.ok && ids('h5') === '["OLD","H2","H1"]', 'H5 拖曳排序存得進去', [r, ids('h5')])
ok(JSON.stringify(pcBefore) === JSON.stringify(pcAfter) && ids('pc') === '["P1","P2"]', 'H5 排序不動到 PC 的位置', [pcBefore, pcAfter])
const posAll = (db.prepare("SELECT position FROM frontend_auto_script_mine WHERE owner = 'eric'").all() as { position: number }[]).map(x => x.position)
ok(new Set(posAll).size === posAll.length, 'H5 排序後 H5 和 PC 的位置不會撞在一起（只用 H5 原本佔的位置重排）', posAll)
ok(frontendMine.reorderMine(db, 'eric', ['H1', 'H2', 'OLD', 'P1'], frontendMine.readMine(db, 'eric', 'h5').revision, 'h5').ok === false, 'H5 排序夾帶 PC 的 id → mismatch（只認這個平台看得到的）')
const pr = frontendMine.reorderMine(db, 'eric', ['P2', 'P1'], frontendMine.readMine(db, 'eric', 'pc').revision, 'pc')
ok(pr.ok && ids('pc') === '["P2","P1"]' && ids('h5') === '["OLD","H2","H1"]', 'PC 排序也只動 PC', [ids('pc'), ids('h5')])
ok(frontendMine.reorderMine(db, 'eric', ['H1', 'H2', 'OLD'], rev, 'h5').ok === false, '舊的版本號 → revision_conflict')

// 軟刪除：從清單消失、還原後回到原位
db.prepare("UPDATE frontend_auto_scripts SET deleted_at = 1 WHERE id = 'H2'").run(); frontendMine.bumpOwnersHolding(db, 'H2')
ok(ids('h5') === '["OLD","H1"]', '軟刪除的腳本不在「我的」裡', ids('h5'))
ok(frontendMine.addToMine(db, 'siara', ['H2'], 'h5').added.length === 0, '已刪除的腳本加不進「我的」')
db.prepare("UPDATE frontend_auto_scripts SET deleted_at = NULL WHERE id = 'H2'").run(); frontendMine.bumpOwnersHolding(db, 'H2')
ok(ids('h5') === '["OLD","H2","H1"]', '還原後回到原本的位置', ids('h5'))

// 移除只影響自己的清單
frontendMine.addToMine(db, 'siara', ['H1'], 'h5')
frontendMine.removeFromMine(db, 'eric', ['H1'], 'h5')
ok(!ids('h5').includes('H1') && ids('h5', 'siara') === '["H1"]', '移除只從自己的清單拿掉，別人的不受影響', [ids('h5'), ids('h5', 'siara')])

// 跟後台的「我的」分開（不同表）
ok(readMine(db, 'eric').ids.length === 0, 'H5／PC 的「我的」跟後台的分開', readMine(db, 'eric'))

// 刪除權限：看登入帳號，不看瀏覽器填的 created_by
ok(canDeleteFrontendScript({ ownerEmail: 'eric@x.com', me: 'eric@x.com', isAdmin: false }).ok, '建立者可以刪')
ok(canDeleteFrontendScript({ ownerEmail: 'eric@x.com', me: 'ERIC@x.com', isAdmin: false }).ok, 'email 大小寫不同仍算同一人')
ok(!canDeleteFrontendScript({ ownerEmail: 'eric@x.com', me: 'siara@x.com', isAdmin: false }).ok, '別人的不能刪')
const legacy = canDeleteFrontendScript({ ownerEmail: '', me: 'eric@x.com', isAdmin: false })
ok(!legacy.ok && /舊腳本/.test(legacy.ok ? '' : legacy.why), '舊腳本（owner_email 空）一般人不能刪，原因寫明', legacy)
ok(canDeleteFrontendScript({ ownerEmail: '', me: 'admin@x.com', isAdmin: true }).ok, '舊腳本管理員能刪')
ok(canDeleteFrontendScript({ ownerEmail: 'eric@x.com', me: 'admin@x.com', isAdmin: true }).ok, '管理員能刪別人的')

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)

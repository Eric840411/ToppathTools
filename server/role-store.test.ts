/** 角色管理資料層。跑法：npx tsx server/role-store.test.ts（記憶體 DB，不動 data.db） */
import Database from 'better-sqlite3'
import { adminTargetError, createRole, deleteAccountGuarded, deleteRole, updateAccountGuarded, initRoles, isMultiRole, listRoles, roleExists, rolePermissionMap, setRolePermissions, updateRole, usersOfRole, withAssignableRole } from './role-store.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const db = new Database(':memory:')
db.exec('CREATE TABLE role_permissions (role TEXT NOT NULL, page_key TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (role, page_key))')
db.prepare("INSERT INTO role_permissions VALUES ('qa', 'osm', 1)").run()
db.exec("CREATE TABLE jira_accounts (email TEXT PRIMARY KEY, token TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', role TEXT, status TEXT, pin_hash TEXT)")
initRoles(db); initRoles(db)
const KEYS = ['osm', 'autospin', 'osm-uat'] as const

eq('內建三個角色、重跑 init 不重複', listRoles(db).map(r => [r.key, r.builtin]), [['qa', 1], ['pm', 1], ['other', 1]])
eq('admin 不在表裡（不能被一般指派產生）', roleExists(db, 'admin'), false)
eq('既有權限照舊', rolePermissionMap(db, 'qa', KEYS), { osm: true, autospin: false, 'osm-uat': false })

const c = createRole(db, { label: '測試協力', color: '#059669' })
const key = c.ok ? c.role.key : ''
eq('新增自建角色', c.ok && /^r_/.test(key) && roleExists(db, key), true)
eq('同名（不分大小寫）擋下', (createRole(db, { label: ' qa ', color: '#000000' }) as { code: string }).code, 'DUP_LABEL')
eq('不能叫「管理員」', (createRole(db, { label: '管理員', color: '#000000' }) as { code: string }).code, 'DUP_LABEL')
eq('名稱空白或太長擋下', [(createRole(db, { label: ' ', color: '#000000' }) as { code: string }).code, (createRole(db, { label: 'x'.repeat(21), color: '#000000' }) as { code: string }).code], ['BAD_LABEL', 'BAD_LABEL'])
eq('顏色格式錯擋下', (createRole(db, { label: '新角色', color: 'red' }) as { code: string }).code, 'BAD_COLOR')

eq('自建角色可改名，key 不變', [updateRole(db, key, { label: '測試夥伴' }).ok, listRoles(db).find(r => r.key === key)?.label], [true, '測試夥伴'])
eq('內建角色不能改名', (updateRole(db, 'qa', { label: 'QA 組' }) as { code: string }).code, 'BUILTIN')
eq('內建角色可以改色、可以存原名', [updateRole(db, 'qa', { color: '#111111' }).ok, updateRole(db, 'qa', { label: 'QA' }).ok], [true, true])
eq('admin 不能改', (updateRole(db, 'admin', { color: '#111111' }) as { code: string }).code, 'ADMIN')

eq('設可見功能', [setRolePermissions(db, key, { autospin: true }, KEYS).ok, rolePermissionMap(db, key, KEYS)], [true, { osm: false, autospin: true, 'osm-uat': false }])
eq('不認得的 key 擋下、不靜默忽略', (setRolePermissions(db, key, { nope: true }, KEYS) as { code: string }).code, 'BAD_KEY')
eq('admin 的權限不能設', (setRolePermissions(db, 'admin', {}, KEYS) as { code: string }).code, 'ADMIN')

const accounts = [{ email: 'a@x', role: key }, { email: 'b@x', role: 'pm,' + key }, { email: 'c@x', role: 'qa' }]
eq('使用中的帳號（含舊的多角色）', usersOfRole(accounts, key), ['a@x', 'b@x'])
const insAcct = db.prepare('INSERT OR REPLACE INTO jira_accounts (email, role) VALUES (?, ?)')
for (const a of accounts) insAcct.run(a.email, a.role)
const blocked = deleteRole(db, key) as { code: string; users: string[] }
eq('刪除使用中的角色 → 擋下並列出帳號', [blocked.code, blocked.users], ['IN_USE', ['a@x', 'b@x']])
eq('擋下時角色與權限都還在', [roleExists(db, key), rolePermissionMap(db, key, KEYS).autospin], [true, true])
eq('內建角色不能刪', (deleteRole(db, 'other') as { code: string }).code, 'BUILTIN')
// 刪除讀的是 DB 裡當下的帳號，不是呼叫端的快照（CodeX review P2）
db.prepare("UPDATE jira_accounts SET role = 'qa' WHERE email IN ('a@x', 'b@x')").run()
const assignLater = (r: string) => withAssignableRole(db, r, () => db.prepare('UPDATE jira_accounts SET role = ? WHERE email = ?').run(r, 'c@x'))
eq('指派存在的角色 → 寫入', [assignLater(key).ok, (db.prepare("SELECT role FROM jira_accounts WHERE email='c@x'").get() as { role: string }).role], [true, key])
eq('刪除前剛被指派 → 仍擋下（讀 DB 不讀快照）', (deleteRole(db, key) as { code: string; users: string[] }).users, ['c@x'])
db.prepare("UPDATE jira_accounts SET role = 'qa' WHERE email = 'c@x'").run()
eq('沒人用就刪掉、權限列一起清', [deleteRole(db, key).ok, roleExists(db, key), (db.prepare('SELECT COUNT(*) n FROM role_permissions WHERE role = ?').get(key) as { n: number }).n], [true, false, 0])
eq('角色刪掉後再指派 → 擋下、不寫入', [assignLater(key).ok, (db.prepare("SELECT role FROM jira_accounts WHERE email='c@x'").get() as { role: string }).role], [false, 'qa'])
eq('不能指派成 admin', withAssignableRole(db, 'admin', () => 1).ok, false)

const adm = { role: 'admin', status: 'active' }
eq('管理員：不能刪、不能改角色、不能停用', [adminTargetError(adm, { delete: true }), adminTargetError(adm, { role: 'qa' }), adminTargetError(adm, { status: 'disabled' })].map(x => !!x), [true, true, true])
eq('管理員：改名／送一樣的角色與狀態可以', [adminTargetError(adm, {}), adminTargetError(adm, { role: 'admin', status: 'active' })], [null, null])
eq('舊多角色裡含 admin 也算管理員', !!adminTargetError({ role: 'pm,admin' }, { role: 'pm' }), true)
eq('一般帳號不受限', adminTargetError({ role: 'qa' }, { delete: true }), null)
// 帳號更新：一律讀 transaction 裡的現況（CodeX review v5.9.1 P2：只改名卻把舊的已刪角色寫回）
const r2 = createRole(db, { label: '暫時角色', color: '#123456' })
const k2 = r2.ok ? r2.role.key : ''
db.prepare("INSERT OR REPLACE INTO jira_accounts (email, label, role, status, pin_hash) VALUES ('d@x', 'D', ?, 'active', 'h')").run(k2)
db.prepare("UPDATE jira_accounts SET role = 'qa' WHERE email = 'd@x'").run(); deleteRole(db, k2) // 另一個 process：改派 QA 後刪角色
const acct = (e: string) => db.prepare('SELECT label, role, status, pin_hash FROM jira_accounts WHERE email = ?').get(e)
eq('只改名 → 角色是 DB 當下的 qa（不會寫回已刪角色）、PIN 不被洗掉', [updateAccountGuarded(db, 'd@x', { label: 'D2' }).ok, acct('d@x')], [true, { label: 'D2', role: 'qa', status: 'active', pin_hash: 'h' }])
eq('指派已刪的角色 → 400、不寫入', [updateAccountGuarded(db, 'd@x', { role: k2 }), (acct('d@x') as { role: string }).role], [{ ok: false, status: 400, message: '沒有這個角色' }, 'qa'])
eq('指派成 admin → 400', (updateAccountGuarded(db, 'd@x', { role: 'admin' }) as { status: number }).status, 400)
eq('不存在的帳號 → 404', (updateAccountGuarded(db, 'nope@x', { label: 'x' }) as { status: number }).status, 404)
db.prepare("INSERT OR REPLACE INTO jira_accounts (email, label, role, status) VALUES ('adm@x', 'A', 'admin', 'active')").run()
eq('管理員：改角色／停用 → 400，改名可以', [updateAccountGuarded(db, 'adm@x', { role: 'qa' }).ok, updateAccountGuarded(db, 'adm@x', { status: 'disabled' }).ok, updateAccountGuarded(db, 'adm@x', { label: 'A2' }).ok, acct('adm@x')], [false, false, true, { label: 'A2', role: 'admin', status: 'active', pin_hash: null }])
eq('刪帳號：管理員擋、一般帳號可刪、不存在 404', [deleteAccountGuarded(db, 'adm@x').ok, deleteAccountGuarded(db, 'd@x').ok, !!acct('d@x'), (deleteAccountGuarded(db, 'd@x') as { status: number }).status], [false, true, false, 404])
eq('多角色判斷', [isMultiRole('pm,qa'), isMultiRole('qa'), isMultiRole(' qa , ')], [true, false, false])

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

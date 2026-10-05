/** 角色管理資料層。跑法：npx tsx server/role-store.test.ts（記憶體 DB，不動 data.db） */
import Database from 'better-sqlite3'
import { createRole, deleteRole, initRoles, isMultiRole, listRoles, roleExists, rolePermissionMap, setRolePermissions, updateRole, usersOfRole } from './role-store.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const db = new Database(':memory:')
db.exec('CREATE TABLE role_permissions (role TEXT NOT NULL, page_key TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (role, page_key))')
db.prepare("INSERT INTO role_permissions VALUES ('qa', 'osm', 1)").run()
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
const blocked = deleteRole(db, key, accounts) as { code: string; users: string[] }
eq('刪除使用中的角色 → 擋下並列出帳號', [blocked.code, blocked.users], ['IN_USE', ['a@x', 'b@x']])
eq('擋下時角色與權限都還在', [roleExists(db, key), rolePermissionMap(db, key, KEYS).autospin], [true, true])
eq('內建角色不能刪', (deleteRole(db, 'other', []) as { code: string }).code, 'BUILTIN')
eq('沒人用就刪掉、權限列一起清', [deleteRole(db, key, [{ email: 'c@x', role: 'qa' }]).ok, roleExists(db, key), (db.prepare('SELECT COUNT(*) n FROM role_permissions WHERE role = ?').get(key) as { n: number }).n], [true, false, 0])
eq('多角色判斷', [isMultiRole('pm,qa'), isMultiRole('qa'), isMultiRole(' qa , ')], [true, false, false])

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

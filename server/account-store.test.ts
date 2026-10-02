/**
 * 登入帳號寫入。跑法：npx tsx server/account-store.test.ts
 * 防的是 2026-10-02 CodeX 抓到的：管理員改帳號（名稱／角色／狀態）用 INSERT OR REPLACE，PIN 被清掉。
 */
import Database from 'better-sqlite3'
import { upsertAccountIn } from './account-store.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
const db = new Database(':memory:')
// 跟正式 DB 一樣的表結構（server/data.db 實測）
db.exec(`CREATE TABLE jira_accounts (email TEXT PRIMARY KEY, token TEXT NOT NULL, label TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'qa', pin_hash TEXT, status TEXT NOT NULL DEFAULT 'active')`)
const row = () => db.prepare('SELECT * FROM jira_accounts WHERE email = ?').get('a@t')

upsertAccountIn(db, { email: 'a@t', label: 'A' })
eq('新增：不帶 token 也能建（Jira 停用）', row(), { email: 'a@t', token: '', label: 'A', role: 'qa', pin_hash: null, status: 'active' })
db.prepare("UPDATE jira_accounts SET pin_hash = 'HASH' WHERE email = 'a@t'").run()
upsertAccountIn(db, { email: 'a@t', label: 'A2', role: 'pm', status: 'disabled', token: '' })
eq('管理員改名／角色／狀態：PIN 保留', row(), { email: 'a@t', token: '', label: 'A2', role: 'pm', pin_hash: 'HASH', status: 'disabled' })
eq('還是只有一列', (db.prepare('SELECT COUNT(*) n FROM jira_accounts').get() as { n: number }).n, 1)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

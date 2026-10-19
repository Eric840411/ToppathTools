/**
 * 機密欄位加密遷移＋secret-crypto 的回歸。跑法：npx tsx server/secret-migration.test.ts
 *
 * 用記憶體 DB 建出正式環境會有的表與明文值，跑遷移後驗：
 *  ① 該加密的都變成 v1 密文、解得回原值 ② 不該動的（非機密 key、空值）沒動
 *  ③ 跑第二次不會重複加密 ④ 沒金鑰時一筆都不動 ⑤ 換了金鑰解不開會丟錯（不回空字串）
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { migrateSecretsAtRest } from './secret-migration.js'
import { decryptSecret, encryptSecret, isEncryptedSecret, isSecretConfigKey } from './secret-crypto.js'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fails.push(`${name}${detail ? ': ' + detail : ''}`)
}

const env = { SECRETS_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv
const otherEnv = { SECRETS_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv

function seed() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE gemini_keys (label TEXT PRIMARY KEY, key TEXT NOT NULL);
    CREATE TABLE user_ai_keys (user_email TEXT, provider TEXT, api_key TEXT, label TEXT, created_at INTEGER, PRIMARY KEY (user_email, provider));
    CREATE TABLE jira_accounts (email TEXT PRIMARY KEY, token TEXT, label TEXT, role TEXT, pin_hash TEXT, status TEXT);
    CREATE TABLE jp_groups (id INTEGER PRIMARY KEY, code TEXT, login_pass TEXT);
    CREATE TABLE uat_backend_credentials (email TEXT, profile TEXT, username TEXT, password TEXT, updated_at INTEGER, PRIMARY KEY (email, profile));
    CREATE TABLE autospin_configs (userLabel TEXT, machineType TEXT, larkWebhook TEXT NOT NULL DEFAULT '', PRIMARY KEY (userLabel, machineType));
    CREATE TABLE alert_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE reconcile_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE meter_reconcile_config (key TEXT PRIMARY KEY, value TEXT);
  `)
  const ins = (sql: string, ...v: unknown[]) => db.prepare(sql).run(...v)
  ins(`INSERT INTO settings VALUES ('openai_api_key', 'sk-plain-openai')`)
  ins(`INSERT INTO settings VALUES ('internal_identity_secret', 'idsecret')`)
  ins(`INSERT INTO settings VALUES ('ui_theme', 'dark')`)
  ins(`INSERT INTO gemini_keys VALUES ('k1', 'AIza-plain')`)
  ins(`INSERT INTO user_ai_keys VALUES ('a@x', 'gemini', 'AIza-user', '', 0)`)
  ins(`INSERT INTO jira_accounts VALUES ('a@x', 'jira-tok', 'A', 'qa', 'hash', 'active')`)
  ins(`INSERT INTO jira_accounts VALUES ('b@x', '', 'B', 'qa', '', 'active')`)
  ins(`INSERT INTO jp_groups VALUES (1, 'G1', '123456')`)
  ins(`INSERT INTO uat_backend_credentials VALUES ('a@x', 'cpBackend', 'u', 'pw1', 0)`)
  ins(`INSERT INTO autospin_configs VALUES ('a@x', 'M1', 'https://open.larksuite.com/hook/x')`)
  ins(`INSERT INTO autospin_configs VALUES ('a@x', 'M2', '')`)
  ins(`INSERT INTO alert_config VALUES ('webhook_url', 'https://open.larksuite.com/hook/y')`)
  ins(`INSERT INTO alert_config VALUES ('schedule', '0 9 * * *')`)
  ins(`INSERT INTO reconcile_config VALUES ('token', 'rtok')`)
  ins(`INSERT INTO reconcile_config VALUES ('lastlogintime', '123')`)
  ins(`INSERT INTO meter_reconcile_config VALUES ('osm_token', 'mtok')`)
  ins(`INSERT INTO meter_reconcile_config VALUES ('osm_login_password', 'mpw')`)
  ins(`INSERT INTO meter_reconcile_config VALUES ('osm_base_url', 'https://b')`)
  return db
}
const val = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { v: string }).v

// ── crypto 本身 ──
ok('isSecretConfigKey token', isSecretConfigKey('osm_token'))
ok('isSecretConfigKey login_password', isSecretConfigKey('gcp_login_password'))
ok('isSecretConfigKey 非機密', !isSecretConfigKey('lastlogintime') && !isSecretConfigKey('osm_base_url'))
const c = encryptSecret('hello', env)
ok('加密成 v1', isEncryptedSecret(c))
ok('解得回', decryptSecret(c, env) === 'hello')
ok('不重複加密', encryptSecret(c, env) === c)
ok('明文原樣回傳', decryptSecret('plain', env) === 'plain')
ok('空值原樣', encryptSecret('', env) === '' && decryptSecret('', env) === '')
ok('沒金鑰時寫明文', encryptSecret('x', {} as NodeJS.ProcessEnv) === 'x')
let threw = false
try { decryptSecret(c, otherEnv) } catch { threw = true }
ok('換金鑰解不開會丟錯', threw)
threw = false
try { decryptSecret(c, {} as NodeJS.ProcessEnv) } catch { threw = true }
ok('沒金鑰讀密文會丟錯', threw)
ok('MEEGLE_TOKEN_KEY 也能當金鑰', decryptSecret(encryptSecret('m', { MEEGLE_TOKEN_KEY: env.SECRETS_KEY } as NodeJS.ProcessEnv), env) === 'm')

// ── 遷移 ──
const db = seed()
const r = migrateSecretsAtRest(db, env)
ok('狀態', r.status === 'SECRETS_KEY')
const enc = (name: string, sql: string, plain: string) => {
  const v = val(db, sql)
  ok(`${name} 已加密`, isEncryptedSecret(v), v)
  ok(`${name} 解得回`, isEncryptedSecret(v) && decryptSecret(v, env) === plain)
}
enc('openai', `SELECT value v FROM settings WHERE key='openai_api_key'`, 'sk-plain-openai')
enc('identity', `SELECT value v FROM settings WHERE key='internal_identity_secret'`, 'idsecret')
enc('gemini', `SELECT key v FROM gemini_keys`, 'AIza-plain')
enc('user_ai', `SELECT api_key v FROM user_ai_keys`, 'AIza-user')
enc('jira', `SELECT token v FROM jira_accounts WHERE email='a@x'`, 'jira-tok')
enc('jp', `SELECT login_pass v FROM jp_groups`, '123456')
enc('uat', `SELECT password v FROM uat_backend_credentials`, 'pw1')
enc('autospin webhook', `SELECT larkWebhook v FROM autospin_configs WHERE machineType='M1'`, 'https://open.larksuite.com/hook/x')
enc('alert webhook', `SELECT value v FROM alert_config WHERE key='webhook_url'`, 'https://open.larksuite.com/hook/y')
enc('reconcile token', `SELECT value v FROM reconcile_config WHERE key='token'`, 'rtok')
enc('meter token', `SELECT value v FROM meter_reconcile_config WHERE key='osm_token'`, 'mtok')
enc('meter password', `SELECT value v FROM meter_reconcile_config WHERE key='osm_login_password'`, 'mpw')
ok('非機密 settings 沒動', val(db, `SELECT value v FROM settings WHERE key='ui_theme'`) === 'dark')
ok('非機密 alert 沒動', val(db, `SELECT value v FROM alert_config WHERE key='schedule'`) === '0 9 * * *')
ok('非機密 reconcile 沒動', val(db, `SELECT value v FROM reconcile_config WHERE key='lastlogintime'`) === '123')
ok('非機密 meter 沒動', val(db, `SELECT value v FROM meter_reconcile_config WHERE key='osm_base_url'`) === 'https://b')
ok('空 token 沒動', val(db, `SELECT token v FROM jira_accounts WHERE email='b@x'`) === '')
ok('空 webhook 沒動', val(db, `SELECT larkWebhook v FROM autospin_configs WHERE machineType='M2'`) === '')
ok('不存在的表跳過', r.skipped.includes('url_pool_accounts.password'))

const before = val(db, `SELECT value v FROM settings WHERE key='openai_api_key'`)
const r2 = migrateSecretsAtRest(db, env)
ok('第二次不重複加密', val(db, `SELECT value v FROM settings WHERE key='openai_api_key'`) === before && Object.keys(r2.encrypted).length === 0)

const db2 = seed()
const r3 = migrateSecretsAtRest(db2, {} as NodeJS.ProcessEnv)
ok('沒金鑰一筆都不動', r3.status === 'missing' && val(db2, `SELECT value v FROM settings WHERE key='openai_api_key'`) === 'sk-plain-openai')

console.log(`secret-migration: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

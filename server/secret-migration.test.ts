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
import { createCipheriv } from 'crypto'
import { decryptSecret, encryptSecret, isEncryptedSecret, isSecretConfigKey, isCurrentKeySecret, currentKeyId } from './secret-crypto.js'

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
let threw = false
ok('加密成 v2（帶金鑰指紋）', isEncryptedSecret(c) && c.startsWith('v2:'))
ok('解得回', decryptSecret(c, env) === 'hello')
ok('不重複加密', encryptSecret(c, env) === c)
ok('明文原樣回傳', decryptSecret('plain', env) === 'plain')
ok('空值原樣', encryptSecret('', env) === '' && decryptSecret('', env) === '')
threw = false
try { encryptSecret('x', {} as NodeJS.ProcessEnv) } catch { threw = true }
ok('沒金鑰時拒絕寫入（不寫明文）', threw)
threw = false
try { encryptSecret('x', { SECRETS_KEY: 'too-short' } as NodeJS.ProcessEnv) } catch { threw = true }
ok('金鑰格式錯也拒絕', threw)
ok('沒金鑰時空值仍可寫（代表清空）', encryptSecret('', {} as NodeJS.ProcessEnv) === '')
threw = false
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

// ── 換金鑰（v5.66.4）──
// 手工做一筆 v1（v5.66.0～5.66.3 的格式）：舊資料要解得開，遷移時改成 v2
function legacyV1(plain: string, keyB64: string) {
  const key = Buffer.from(keyB64, 'base64'); const iv = randomBytes(12)
  const ci = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([ci.update(plain, 'utf8'), ci.final()])
  return ['v1', iv.toString('base64'), ci.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}
const keyA = randomBytes(32).toString('base64'), keyB = randomBytes(32).toString('base64')
const envMeegleOnly = { MEEGLE_TOKEN_KEY: keyA } as NodeJS.ProcessEnv
const v1 = legacyV1('old-secret', keyA)
ok('v1 舊資料解得開', decryptSecret(v1, envMeegleOnly) === 'old-secret')
ok('改設 SECRETS_KEY 後 v1 仍解得開（MEEGLE 留著）', decryptSecret(v1, { SECRETS_KEY: keyB, MEEGLE_TOKEN_KEY: keyA } as NodeJS.ProcessEnv) === 'old-secret')
const dbR = new Database(':memory:')
dbR.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`)
dbR.prepare(`INSERT INTO settings VALUES ('openai_api_key', ?)`).run(v1)
migrateSecretsAtRest(dbR, envMeegleOnly)
const afterV1 = val(dbR, `SELECT value v FROM settings WHERE key='openai_api_key'`)
ok('遷移把 v1 改成 v2', afterV1.startsWith('v2:') && decryptSecret(afterV1, envMeegleOnly) === 'old-secret')
// 換成 B，A 放到 OLD → 遷移重新加密成 B
const envRot = { SECRETS_KEY: keyB, SECRETS_KEYS_OLD: keyA } as NodeJS.ProcessEnv
ok('換金鑰前不是目前金鑰', !isCurrentKeySecret(afterV1, envRot))
const rr = migrateSecretsAtRest(dbR, envRot)
const afterRot = val(dbR, `SELECT value v FROM settings WHERE key='openai_api_key'`)
ok('換金鑰後是新金鑰的 kid', afterRot.split(':')[1] === currentKeyId(envRot) && rr.encrypted['settings.value'] === 1)
ok('只有新金鑰也解得開', decryptSecret(afterRot, { SECRETS_KEY: keyB } as NodeJS.ProcessEnv) === 'old-secret')
// 舊金鑰沒留：遷移不能弄壞資料，要記失敗數
const dbF = new Database(':memory:')
dbF.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`)
dbF.prepare(`INSERT INTO settings VALUES ('openai_api_key', ?)`).run(afterRot)
const rf = migrateSecretsAtRest(dbF, { SECRETS_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)
ok('舊金鑰沒留：資料原樣保留', val(dbF, `SELECT value v FROM settings WHERE key='openai_api_key'`) === afterRot)
ok('舊金鑰沒留：記失敗數', rf.failed['settings.value'] === 1)
let threwKid = false
try { decryptSecret(afterRot, { SECRETS_KEY: keyA } as NodeJS.ProcessEnv) } catch (e) { threwKid = /金鑰/.test(String(e)) }
ok('找不到 kid 的金鑰：明確丟錯', threwKid)

console.log(`secret-migration: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

// npx tsx server/meter-config.test.ts — 後台設定依環境拆分（v5.76.0）
import Database from 'better-sqlite3'
import {
  parseMeterEnv, classifyLegacySet, loadMeterConfigFrom, saveMeterConfigValueTo,
  migrateMeterConfigEnvOn, legacyUnclassifiedFrom,
} from './meter-config-core.js'

let pass = 0, fail = 0
const ok = (name: string, cond: unknown) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }

function fresh() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE meter_reconcile_config (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE recon_watermark (env TEXT, source TEXT, scope TEXT, cursorTs INTEGER, updatedAt INTEGER, PRIMARY KEY(env, source, scope))')
  return db
}
const put = (db: Database.Database, k: string, v: string) => db.prepare('INSERT OR REPLACE INTO meter_reconcile_config VALUES (?, ?)').run(k, v)

// env 參數
ok('env 沒帶＝qat', parseMeterEnv(undefined) === 'qat' && parseMeterEnv('') === 'qat')
ok('env uat', parseMeterEnv('uat') === 'uat')
ok('env 亂帶＝null（回 400，不默默當 qat）', parseMeterEnv('prod') === null && parseMeterEnv('UAT') === null)

// 判定規則：認 hostname，不認「有沒有 uat- 字樣」
ok('QAT 網址', classifyLegacySet({ base_url: 'https://backendservertest.osmslot.org', origin: 'https://qat-cp.osmslot.org' }) === 'qat')
ok('UAT 網址', classifyLegacySet({ base_url: 'https://uat-backendservertest.osmslot.org', origin: 'https://uat-cp.osmslot.org' }) === 'uat')
ok('沒填 origin 只看 base', classifyLegacySet({ base_url: 'https://uat-backendservertest.osmslot.org/' }) === 'uat')
ok('未知網址不猜', classifyLegacySet({ base_url: 'https://backendserver.osmslot.org' }) === null)
ok('路徑裡有 uat- 不算', classifyLegacySet({ base_url: 'https://backendservertest.osmslot.org/uat-x' }) === 'qat')
ok('空值不猜', classifyLegacySet({ base_url: '' }) === null)
ok('base 與 origin 不同環境不猜', classifyLegacySet({ base_url: 'https://backendservertest.osmslot.org', origin: 'https://uat-cp.osmslot.org' }) === null)
ok('origin 未知不猜', classifyLegacySet({ base_url: 'https://backendservertest.osmslot.org', origin: 'https://evil.example' }) === null)

// 搬移：使用者截圖那種情況（osm_ 改成 UAT、gcp_ 是 QAT）
{
  const db = fresh()
  put(db, 'osm_base_url', 'https://uat-backendservertest.osmslot.org'); put(db, 'osm_origin', 'https://uat-cp.osmslot.org')
  put(db, 'osm_channel_id', '4186'); put(db, 'osm_token', 'tok-uat')
  put(db, 'gcp_base_url', 'https://backendservertest.osmslot.org'); put(db, 'gcp_origin', 'https://qat-nc.osmslot.org')
  db.prepare("INSERT INTO recon_watermark VALUES ('qat', 'gameRecord', '', 123, 1)").run()
  db.prepare("INSERT INTO recon_watermark VALUES ('uat', 'gameRecord', '', 456, 1)").run()
  const r = migrateMeterConfigEnvOn(db)
  ok('osm 搬到 uat', loadMeterConfigFrom(db, 'uat', 'osm').channel_id === '4186' && loadMeterConfigFrom(db, 'uat', 'osm').token === 'tok-uat')
  ok('QAT osm 沒設定（不借 UAT 的值）', Object.keys(loadMeterConfigFrom(db, 'qat', 'osm')).length === 0)
  ok('gcp 搬到 qat', loadMeterConfigFrom(db, 'qat', 'gcp').origin === 'https://qat-nc.osmslot.org')
  ok('UAT gcp 沒設定', Object.keys(loadMeterConfigFrom(db, 'uat', 'gcp')).length === 0)
  ok('QAT 水位清掉、UAT 留著', !db.prepare("SELECT 1 FROM recon_watermark WHERE env='qat'").get() && !!db.prepare("SELECT 1 FROM recon_watermark WHERE env='uat'").get())
  ok('舊 key 保留', !!db.prepare("SELECT 1 FROM meter_reconcile_config WHERE key='osm_base_url'").get())
  ok('回報搬了哪些', r.moved.includes('osm→uat') && r.moved.includes('gcp→qat'))
  // 重啟不重搬：改了新設定後再跑一次，不能被舊值蓋回去
  saveMeterConfigValueTo(db, 'uat', 'osm', 'channel_id', '9999')
  const r2 = migrateMeterConfigEnvOn(db)
  ok('第二次不搬', r2.moved.length === 0 && loadMeterConfigFrom(db, 'uat', 'osm').channel_id === '9999')
}

// 判斷不出來：不搬、留提示，兩個環境都是空的
{
  const db = fresh()
  put(db, 'osm_base_url', 'https://somewhere.example'); put(db, 'osm_login_password', 'pw')
  migrateMeterConfigEnvOn(db)
  ok('未知不搬 qat', Object.keys(loadMeterConfigFrom(db, 'qat', 'osm')).length === 0)
  ok('未知不搬 uat', Object.keys(loadMeterConfigFrom(db, 'uat', 'osm')).length === 0)
  ok('留提示（只有網址）', legacyUnclassifiedFrom(db, 'osm') === 'https://somewhere.example')
  ok('gcp 沒舊設定就沒提示', legacyUnclassifiedFrom(db, 'gcp') === null)
}

// 目標已有新設定不覆蓋
{
  const db = fresh()
  put(db, 'osm_base_url', 'https://backendservertest.osmslot.org'); put(db, 'osm_channel_id', '873')
  saveMeterConfigValueTo(db, 'qat', 'osm', 'channel_id', '111')
  migrateMeterConfigEnvOn(db)
  ok('不覆蓋已有新設定', loadMeterConfigFrom(db, 'qat', 'osm').channel_id === '111')
}

// 前綴比對不能被 LIKE 底線萬用字元騙到
{
  const db = fresh()
  put(db, 'qatXosmYbase_url', 'https://x')
  ok('不會讀到形似的 key', Object.keys(loadMeterConfigFrom(db, 'qat', 'osm')).length === 0)
}

console.log(`meter-config: ${pass} 通過, ${fail} 失敗`)
if (fail) process.exit(1)

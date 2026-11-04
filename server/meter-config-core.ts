// 純邏輯（不碰 shared.ts 的正式 DB，測試用記憶體 DB）；綁好 db 的版本在 meter-config.ts。
// 後台連線設定（meter_reconcile_config）依「環境 × 後台」分四組：qat_osm_／qat_gcp_／uat_osm_／uat_gcp_。
//
// 為什麼要拆（2026-11-04）：原本只有 osm_／gcp_ 兩組，Performance Meter、Egm DayCount、AutoSpin 對帳台、
// Live Ledger 共用。使用者為了查 UAT 把 osm_ 改成 UAT 網址，等於 AutoSpin／Live Ledger 也跟著打到 UAT，
// 對帳結果默默變成另一個環境的資料。
//
// 規則（CodeX 1104 確認）：
//   - 某環境沒設定就是沒設定，**不退回另一個環境、也不退回寫死的 QAT 網址**
//   - 舊 osm_／gcp_ 一次性搬到新 key：用網址 hostname 比對已知清單判定環境；未知、空值、
//     base_url 與 origin 不一致 → 不搬，留給人重新填（畫面會提示）。舊 key 保留不刪、也不再讀
import type DatabaseT from 'better-sqlite3'
import { encryptSecret, decryptSecret, isSecretConfigKey } from './secret-crypto.js'

type Db = DatabaseT.Database

export type MeterEnv = 'qat' | 'uat'
export type MeterProfile = 'osm' | 'gcp'
export const METER_ENVS: readonly MeterEnv[] = ['qat', 'uat']

/** 請求帶的 env：沒帶＝qat（舊呼叫端相容）；帶了但不是 qat／uat → null（呼叫端回 400，不默默當 qat）。 */
export function parseMeterEnv(v: unknown): MeterEnv | null {
  if (v === undefined || v === null || v === '') return 'qat'
  return v === 'qat' || v === 'uat' ? v : null
}

const prefixOf = (env: MeterEnv, profile: MeterProfile) => `${env}_${profile}_`

export function loadMeterConfigFrom(db: Db, env: MeterEnv, profile: MeterProfile): Record<string, string> {
  const prefix = prefixOf(env, profile)
  // 不用 LIKE：底線在 LIKE 是萬用字元
  const rows = db.prepare('SELECT key, value FROM meter_reconcile_config WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as { key: string; value: string }[]
  const cfg: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.slice(prefix.length)
    cfg[k] = isSecretConfigKey(k) ? decryptSecret(r.value) : r.value
  }
  return cfg
}

export function saveMeterConfigValueTo(db: Db, env: MeterEnv, profile: MeterProfile, key: string, value: string) {
  // token／password 加密存放（資安審查 2026-10-19）
  db.prepare('INSERT OR REPLACE INTO meter_reconcile_config (key, value) VALUES (?, ?)')
    .run(prefixOf(env, profile) + key, isSecretConfigKey(key) ? encryptSecret(value) : value)
}

/** 已知後台網址 → 環境。不在清單上的一律不猜。 */
const KNOWN_HOSTS: Record<string, MeterEnv> = {
  'backendservertest.osmslot.org': 'qat',
  'qat-cp.osmslot.org': 'qat',
  'qat-nc.osmslot.org': 'qat',
  'uat-backendservertest.osmslot.org': 'uat',
  'uat-cp.osmslot.org': 'uat',
  'uat-nc.osmslot.org': 'uat',
}

export function classifyMeterHost(url: string | undefined): MeterEnv | null {
  if (!url) return null
  try { return KNOWN_HOSTS[new URL(url).hostname.toLowerCase()] ?? null } catch { return null }
}

/** 一組舊設定歸哪個環境：base_url 必須認得；origin 有填就必須認得而且同一個環境。 */
export function classifyLegacySet(cfg: Record<string, string>): MeterEnv | null {
  const base = classifyMeterHost(cfg.base_url)
  if (!base) return null
  if (cfg.origin) {
    const origin = classifyMeterHost(cfg.origin)
    if (origin !== base) return null
  }
  return base
}

const MIGRATED_KEY = '__env_split_v1'
/** 沒辦法判定環境的舊設定，記下它的網址給畫面提示（不是機密，不含帳密）。 */
const unclassifiedKey = (profile: MeterProfile) => `__legacy_unclassified_${profile}`

export function legacyUnclassifiedFrom(db: Db, profile: MeterProfile): string | null {
  const r = db.prepare('SELECT value FROM meter_reconcile_config WHERE key = ?').get(unclassifiedKey(profile)) as { value: string } | undefined
  return r ? r.value : null
}

/** 舊 osm_／gcp_ → {env}_{profile}_，只跑一次（transaction＋標記）。目標環境已經有設定就不覆蓋。 */
export function migrateMeterConfigEnvOn(db: Db): { moved: string[]; skipped: string[] } {
  const moved: string[] = [], skipped: string[] = []
  const run = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM meter_reconcile_config WHERE key = ?').get(MIGRATED_KEY)) return
    for (const profile of ['osm', 'gcp'] as const) {
      const prefix = `${profile}_`
      const rows = db.prepare('SELECT key, value FROM meter_reconcile_config WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as { key: string; value: string }[]
      if (!rows.length) continue
      const plain: Record<string, string> = {}
      // 判定只需要網址；機密欄位不解密（金鑰不在時解密會拋錯，整個搬移就失敗了）
      for (const r of rows) { const k = r.key.slice(prefix.length); if (!isSecretConfigKey(k)) plain[k] = r.value }
      const env = classifyLegacySet(plain)
      if (!env) {
        db.prepare('INSERT OR REPLACE INTO meter_reconcile_config (key, value) VALUES (?, ?)').run(unclassifiedKey(profile), plain.base_url || '')
        skipped.push(profile)
        continue
      }
      const target = prefixOf(env, profile)
      if (db.prepare('SELECT 1 FROM meter_reconcile_config WHERE substr(key, 1, ?) = ?').get(target.length, target)) { skipped.push(profile); continue }
      // 原樣複製（機密欄位本來就是密文，直接搬不用重新加密）
      const ins = db.prepare('INSERT INTO meter_reconcile_config (key, value) VALUES (?, ?)')
      for (const r of rows) ins.run(target + r.key.slice(prefix.length), r.value)
      moved.push(`${profile}→${env}`)
      // 舊 osm_ 其實是 UAT：Live Ledger 的 QAT 這段時間抓的是 UAT 後台，水位不能沿用（CodeX 1104）。
      // 只清水位讓它重新起算；已經抓進來的資料不在這裡刪，要人看過時段再處理
      if (env === 'uat' && profile === 'osm') {
        try { db.prepare("DELETE FROM recon_watermark WHERE env = 'qat'").run() } catch { /* 表還沒建就沒有水位 */ }
        db.prepare('INSERT OR REPLACE INTO meter_reconcile_config (key, value) VALUES (?, ?)').run('__qat_ledger_suspect_since_split', String(Date.now()))
      }
    }
    db.prepare('INSERT INTO meter_reconcile_config (key, value) VALUES (?, ?)').run(MIGRATED_KEY, String(Date.now()))
  })
  run()
  return { moved, skipped }
}

/** 某環境某後台還沒設定網址時的訊息（不退回別的環境）。 */
export function missingConfigMessage(env: MeterEnv, profile: MeterProfile): string {
  return `尚未設定 ${env.toUpperCase()} 的 ${profile === 'osm' ? 'OSM（CP）' : 'GCP（NC）'} 後台連線，請在「Performance Meter 對帳」頁的後台設定填寫`
}

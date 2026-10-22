/**
 * 啟動時把資料庫裡還是明文的機密欄位原地加密（資安審查 2026-10-19）。
 *
 * - 冪等：已經是 `v1:` 密文的跳過；空值跳過（空＝沒設定）
 * - 沒設金鑰（SECRETS_KEY／MEEGLE_TOKEN_KEY）時不動任何資料、印警告——
 *   這時讀取照舊吃明文，功能不受影響，只是還沒加密
 * - server 與 worker 兩支 process 都會 import shared.ts → 可能同時跑：
 *   用 immediate transaction，並在 UPDATE 時帶上「值還是原本那個」的條件，後到的自然什麼都不改
 * - 表不存在（新環境還沒建、或該功能從沒用過）就跳過
 *
 * ⚠️ 不可逆提醒：遷移後退版到舊程式，舊程式會把密文當成明文用（例如拿 `v1:...` 去打 OpenAI）。
 *    退版前要先把這些欄位解密回去，或改回舊版前重新輸入。步驟寫在 docs/features/32-security.md。
 */
import type Database from 'better-sqlite3'
import { encryptSecret, isCurrentKeySecret, isSecretConfigKey, secretKeyStatus } from './secret-crypto.js'

type Target = { table: string; column: string; where?: string; filter?: (row: Record<string, unknown>) => boolean; extra?: string }

export const SECRET_SETTINGS_KEYS = ['openai_api_key', 'tunnel_webhook_url', 'sls_accessKeyId', 'sls_accessKeySecret', 'internal_identity_secret']

export const SECRET_TARGETS: Target[] = [
  { table: 'settings', column: 'value', where: `key IN (${SECRET_SETTINGS_KEYS.map(k => `'${k}'`).join(',')})` },
  { table: 'gemini_keys', column: 'key' },
  { table: 'user_ai_keys', column: 'api_key' },
  { table: 'jira_accounts', column: 'token' },
  { table: 'jp_groups', column: 'login_pass' },
  { table: 'uat_backend_credentials', column: 'password' },
  { table: 'url_pool_accounts', column: 'password' },
  { table: 'autospin_configs', column: 'larkWebhook' },
  { table: 'alert_config', column: 'value', where: `key = 'webhook_url'` },
  { table: 'reconcile_config', column: 'value', extra: 'key', filter: r => isSecretConfigKey(String(r.key)) },
  // meter_reconcile_config 的 key 帶 profile 前綴（osm_token），isSecretConfigKey 看結尾
  { table: 'meter_reconcile_config', column: 'value', extra: 'key', filter: r => isSecretConfigKey(String(r.key)) },
]

export type SecretMigrationResult = { status: ReturnType<typeof secretKeyStatus>; encrypted: Record<string, number>; skipped: string[]; failed: Record<string, number> }

export function migrateSecretsAtRest(db: Database.Database, env: NodeJS.ProcessEnv = process.env): SecretMigrationResult {
  const status = secretKeyStatus(env)
  const result: SecretMigrationResult = { status, encrypted: {}, skipped: [], failed: {} }
  if (status === 'missing') return result
  for (const t of SECRET_TARGETS) {
    const label = `${t.table}.${t.column}`
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t.table)
    if (!exists) { result.skipped.push(label); continue }
    const cols = (db.prepare(`PRAGMA table_info(${t.table})`).all() as { name: string }[]).map(c => c.name)
    if (!cols.includes(t.column)) { result.skipped.push(label); continue }
    const select = `SELECT rowid AS __rid, ${t.column} AS __v${t.extra ? `, ${t.extra}` : ''} FROM ${t.table}${t.where ? ` WHERE ${t.where}` : ''}`
    const update = db.prepare(`UPDATE ${t.table} SET ${t.column} = ? WHERE rowid = ? AND ${t.column} = ?`)
    let n = 0
    let bad = 0
    db.transaction(() => {
      for (const row of db.prepare(select).all() as Record<string, unknown>[]) {
        const v = row.__v
        // 明文 → 加密；v1 或舊金鑰的 v2 → 用目前金鑰重新加密（換金鑰就靠這裡）；已是目前金鑰 → 跳過
        if (typeof v !== 'string' || !v || isCurrentKeySecret(v, env)) continue
        if (t.filter && !t.filter(row)) continue
        let next: string
        try { next = encryptSecret(v, env) } catch { bad++; continue } // 解不開（舊金鑰沒留）就留原樣、記數量
        n += update.run(next, row.__rid, v).changes
      }
    }).immediate()
    if (n) result.encrypted[label] = n
    if (bad) result.failed[label] = bad
  }
  return result
}

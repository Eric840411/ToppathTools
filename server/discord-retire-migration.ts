/**
 * server/discord-retire-migration.ts — v5.13.0 刪除 Discord 時的一次性設定搬遷（使用者 2026-10-05「Dc可以刪除」；範圍 CodeX 審過）。
 *
 * server 啟動時跑一次，**整段在同一個 transaction**，重跑沒有副作用：
 *  1. 舊 key 的值先備份到 `discord_retire_backup`（退版還原用，步驟見 docs/features/29-lark-notify.md）
 *  2. `discord_notify_*` → `autospin_notify_*`：**新 key 不存在才複製**，'0' 跟空字串照樣保留
 *     （'0' 是「通知關閉」，當成沒值跳過的話，升版後關掉的通知會被打開）
 *  3. 刪掉舊 key：webhook URL、Discord 使用者對照表、通知出口、discord_notify_*
 *  4. 補送佇列裡 side:'discord' 的項目丟掉（不改送 Lark——那則多半已經在 Lark 發過，轉送會重複）
 *
 * 純函式（傳入 db）。測試：npx tsx server/discord-retire-migration.test.ts
 */
import type Database from 'better-sqlite3'

export const RENAMED_KEYS = ['enabled', 'fields', 'title_template', 'footer'].map(k => [`discord_notify_${k}`, `autospin_notify_${k}`] as const)
export const DROPPED_KEYS = ['discord_webhook_url', 'autospin_discord_user_map', 'notify_outlets']
export const BACKUP_KEY = 'discord_retire_backup'
const RETRY_KEY = 'notify_retry_queue'

export type RetireResult = { copied: string[]; removed: string[]; droppedRetries: number; backedUp: boolean }

export function runDiscordRetireMigration(db: Database.Database, now = Date.now()): RetireResult {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?')
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  const del = db.prepare('DELETE FROM settings WHERE key = ?')
  const read = (k: string) => (get.get(k) as { value: string } | undefined)?.value
  return db.transaction((): RetireResult => {
    const oldKeys = [...RENAMED_KEYS.map(([from]) => from), ...DROPPED_KEYS]
    const present: Record<string, string> = {}
    for (const k of oldKeys) { const v = read(k); if (v !== undefined) present[k] = v }
    const result: RetireResult = { copied: [], removed: Object.keys(present), droppedRetries: 0, backedUp: false }

    if (result.removed.length) {
      // 已經有備份（例如退版後又升版）→ 合併，同名 key 以這次讀到的為準；不會把上一份整個蓋掉
      let prev: { keys?: Record<string, string> } = {}
      try { prev = JSON.parse(read(BACKUP_KEY) ?? '{}') } catch { /* 備份壞掉就重寫 */ }
      put.run(BACKUP_KEY, JSON.stringify({ takenAt: new Date(now).toISOString(), keys: { ...prev.keys, ...present } }))
      result.backedUp = true
    }
    for (const [from, to] of RENAMED_KEYS) {
      if (present[from] !== undefined && read(to) === undefined) { put.run(to, present[from]); result.copied.push(to) }
    }
    for (const k of result.removed) del.run(k)

    const rawQ = read(RETRY_KEY)
    if (rawQ) {
      try {
        const q = JSON.parse(rawQ) as Array<{ side?: string }>
        if (Array.isArray(q)) {
          const kept = q.filter(it => it?.side !== 'discord')
          result.droppedRetries = q.length - kept.length
          if (result.droppedRetries) put.run(RETRY_KEY, JSON.stringify(kept))
        }
      } catch { /* 佇列壞掉交給 notify-outlet 的讀取（當成空的） */ }
    }
    return result
  }).immediate()
}

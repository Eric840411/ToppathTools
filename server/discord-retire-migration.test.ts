/**
 * Discord 退場 migration（v5.13.0）。跑法：npx tsx server/discord-retire-migration.test.ts
 */
import Database from 'better-sqlite3'
import { BACKUP_KEY, runDiscordRetireMigration } from './discord-retire-migration.js'

let fail = 0
const check = (name: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const fresh = (rows: Record<string, string>) => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO settings VALUES (?, ?)').run(k, v)
  return db
}
const val = (db: Database.Database, k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value

console.log('[搬遷＋保留 0／空字串]')
{
  const db = fresh({
    discord_notify_enabled: '0', discord_notify_footer: '', discord_notify_title_template: 'T {machine}', discord_notify_fields: '["a"]',
    discord_webhook_url: 'https://discord.com/api/webhooks/x', autospin_discord_user_map: '[]', notify_outlets: '{"autospin":"discord"}',
    notify_retry_queue: JSON.stringify([{ id: '1', side: 'discord' }, { id: '2', side: 'lark' }, { id: '3', side: 'discord' }]),
    other: 'keep',
  })
  const r = runDiscordRetireMigration(db, 0)
  check('關閉（"0"）搬過去仍是關閉', val(db, 'autospin_notify_enabled') === '0')
  check('空字串頁尾照樣搬（不當成沒值）', val(db, 'autospin_notify_footer') === '')
  check('標題模板、欄位搬過去', val(db, 'autospin_notify_title_template') === 'T {machine}' && val(db, 'autospin_notify_fields') === '["a"]')
  check('舊 key 全部刪掉', ['discord_notify_enabled', 'discord_notify_footer', 'discord_webhook_url', 'autospin_discord_user_map', 'notify_outlets'].every(k => val(db, k) === undefined))
  const backup = JSON.parse(val(db, BACKUP_KEY) ?? '{}')
  check('備份含所有舊 key 原值', backup.keys?.discord_notify_enabled === '0' && backup.keys?.discord_webhook_url === 'https://discord.com/api/webhooks/x' && backup.keys?.notify_outlets === '{"autospin":"discord"}', JSON.stringify(Object.keys(backup.keys ?? {})))
  check('補送佇列只剩 Lark 項目', JSON.stringify(JSON.parse(val(db, 'notify_retry_queue')!).map((x: { id: string }) => x.id)) === '["2"]' && r.droppedRetries === 2)
  check('無關的設定不動', val(db, 'other') === 'keep')

  const before = JSON.stringify(db.prepare('SELECT * FROM settings ORDER BY key').all())
  const r2 = runDiscordRetireMigration(db, 1)
  check('重跑沒有任何變化', JSON.stringify(db.prepare('SELECT * FROM settings ORDER BY key').all()) === before && !r2.backedUp && !r2.copied.length && !r2.removed.length)
}

console.log('[新 key 已存在 → 不覆蓋]')
{
  const db = fresh({ discord_notify_enabled: '1', autospin_notify_enabled: '0' })
  runDiscordRetireMigration(db, 0)
  check('新 key 原值保留', val(db, 'autospin_notify_enabled') === '0')
  check('舊 key 仍刪掉（值在備份裡）', val(db, 'discord_notify_enabled') === undefined && JSON.parse(val(db, BACKUP_KEY)!).keys.discord_notify_enabled === '1')
}

console.log('[退版又升版：備份合併不整份蓋掉]')
{
  const db = fresh({ [BACKUP_KEY]: JSON.stringify({ keys: { discord_webhook_url: 'old-url', notify_outlets: '{}' } }), discord_webhook_url: 'new-url' })
  runDiscordRetireMigration(db, 0)
  const k = JSON.parse(val(db, BACKUP_KEY)!).keys
  check('上一份備份的其他 key 還在', k.notify_outlets === '{}')
  check('同名 key 用這次的值', k.discord_webhook_url === 'new-url')
}

console.log('[交易：中途失敗全部退回]')
{
  const db = fresh({ discord_notify_enabled: '0', discord_webhook_url: 'u' })
  db.exec(`CREATE TRIGGER boom BEFORE DELETE ON settings WHEN old.key = 'discord_webhook_url' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
  let threw = false
  try { runDiscordRetireMigration(db, 0) } catch { threw = true }
  check('有拋錯', threw)
  check('沒有留下半套（新 key 沒建、舊 key 還在、沒備份）', val(db, 'autospin_notify_enabled') === undefined && val(db, 'discord_notify_enabled') === '0' && val(db, BACKUP_KEY) === undefined)
}

console.log('[佇列寫入失敗：要拋出並全部退回，不能吞掉回報成功]（CodeX review 82d926e [P2]）')
{
  const db = fresh({ discord_webhook_url: 'u', notify_retry_queue: JSON.stringify([{ id: '1', side: 'discord' }]) })
  // put 是 INSERT OR REPLACE：只會觸發 INSERT trigger（REPLACE 的刪除不觸發 DELETE trigger）
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON settings WHEN new.key = 'notify_retry_queue' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
  let threw = false
  try { runDiscordRetireMigration(db, 0) } catch { threw = true }
  check('有拋錯', threw)
  check('舊 key 還在、佇列沒動、沒備份', val(db, 'discord_webhook_url') === 'u' && val(db, 'notify_retry_queue')!.includes('discord') && val(db, BACKUP_KEY) === undefined)
}

console.log('[佇列 JSON 壞掉：不擋搬遷]')
{
  const db = fresh({ discord_webhook_url: 'u', notify_retry_queue: '{not json' })
  const r = runDiscordRetireMigration(db, 0)
  check('照樣完成、佇列原樣留著', val(db, 'discord_webhook_url') === undefined && val(db, 'notify_retry_queue') === '{not json' && r.droppedRetries === 0)
}

console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)

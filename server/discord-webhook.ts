/**
 * server/discord-webhook.ts — Discord webhook 與「帳號 → Discord User ID」對照的**唯一來源**。
 *
 * ⚠️ 這兩件事原本寫在 `routes/autospin.ts` 裡面（module-private）。抽出來的理由不是「整齊」，
 *    而是 Live Ledger 的告警也要用同一組設定——而複製一份 getter 出去，
 *    等於把 `settings` 的 key 名稱寫死在兩個地方，之後改了一邊就會安靜地各發各的。
 *    這個 repo 已經被「分身」咬過好幾次（v4.159.1 的 label 解析有三份拷貝，
 *    修了其中一份等於沒修）。所以：**要用就從這裡 import，不要再抄一份。**
 *
 * 這裡刻意不放「要不要發送」的判斷——那是各功能自己的偏好（AutoSpin 依帳號、
 * Live Ledger 依 env），混進來會讓兩邊互相綁死。
 */
import { db } from './shared.js'

/** 全域設定的 Discord Webhook URL。沒設定回空字串（呼叫端要自己判斷並留下紀錄，不要靜默跳過）。 */
export function getDiscordWebhookUrl(): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('discord_webhook_url') as { value: string } | undefined
  return row?.value ?? ''
}

// ─── 帳號 → Discord User ID 對照（通知 tag 發起人用）───────────────────────────
// 使用者自己維護「哪個帳號對應哪個 Discord User ID」。找得到對照就在訊息 content
// （**不是**塞在 embed 裡，那樣不會真的觸發 Discord 通知/ping）開頭 tag 那個人。

export interface DiscordUserMapEntry { userLabel: string; discordUserId: string }

export function getDiscordUserMap(): DiscordUserMapEntry[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('autospin_discord_user_map') as { value: string } | undefined
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 依 userLabel（session 派工時的帳號）找出對應的 Discord mention 字串（含結尾空白），找不到回傳空字串。 */
export function mentionForUserLabel(userLabel: string | undefined): string {
  if (!userLabel) return ''
  const entry = getDiscordUserMap().find(e => e.userLabel === userLabel)
  return entry?.discordUserId ? `<@${entry.discordUserId}> ` : ''
}

/**
 * 多個 userLabel 的 mention（去重、保持順序）。一批告警可能跨好幾個人。
 *
 * ⚠️ 對不到 Discord ID 的 userLabel **不會**被靜默丟掉——呼叫端拿得到 `unmapped`，
 *    該讓人看見「這個人的告警沒人被 tag 到」，而不是以為大家都收到了。
 */
export function mentionsForUserLabels(labels: Iterable<string>): { mention: string; unmapped: string[] } {
  const map = getDiscordUserMap()
  const seen = new Set<string>()
  const ids: string[] = []
  const unmapped: string[] = []
  for (const label of labels) {
    if (!label || seen.has(label)) continue
    seen.add(label)
    const entry = map.find(e => e.userLabel === label)
    if (entry?.discordUserId) { if (!ids.includes(entry.discordUserId)) ids.push(entry.discordUserId) }
    else unmapped.push(label)
  }
  return { mention: ids.map(id => `<@${id}>`).join(' '), unmapped }
}

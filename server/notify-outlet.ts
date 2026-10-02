/**
 * 通知出口（Discord → Lark 遷移，使用者 2026-10-03；架構 CodeX 同意）。
 * 各功能只管「這則通知長什麼樣（沿用原本的 Discord embed）、要 @ 誰」，走哪邊由設定決定：discord／lark／both。
 *  - 預設 discord：沒切換的功能行為完全不變
 *  - both（過渡期雙發）：兩邊各自送、各自記結果；**失敗只重試失敗那一邊**（CodeX），不重發成功的
 *  - Lark 卡片由 Discord embed 轉出來（同一份內容，不各寫一份）
 *  - @人：Discord 用原本的對照表；Lark 用帳號 email 查 open_id，查不到或沒權限就只寫名字、不 @
 */
import { db, readAccounts } from './shared.js'
import { larkNotifyChatId, resolveLarkOpenIds, sendLarkCard, updateLarkCard, type LarkResult } from './lark-notify.js'

export type Outlet = 'discord' | 'lark' | 'both'
export const NOTIFY_FEATURES = [
  { key: 'autospin', label: 'AutoSpin' },
  { key: 'live-ledger', label: 'Live Ledger' },
  { key: 'weekly-reminder', label: '週報提醒' },
] as const
export type NotifyFeature = typeof NOTIFY_FEATURES[number]['key']

const OUTLETS_KEY = 'notify_outlets'
export function getOutlets(): Record<NotifyFeature, Outlet> {
  const raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(OUTLETS_KEY) as { value?: string } | undefined)?.value
  let parsed: Record<string, unknown> = {}
  try { parsed = raw ? JSON.parse(raw) : {} } catch { /* 壞掉當沒設 */ }
  const pick = (v: unknown): Outlet => (v === 'lark' || v === 'both' ? v : 'discord')
  return Object.fromEntries(NOTIFY_FEATURES.map(f => [f.key, pick(parsed[f.key])])) as Record<NotifyFeature, Outlet>
}
export function setOutlets(next: Partial<Record<NotifyFeature, Outlet>>) {
  const merged = { ...getOutlets(), ...next }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(OUTLETS_KEY, JSON.stringify(merged))
}
/**
 * 測試縫：換掉 Lark 發送、出口設定與重試佇列的儲存。
 * ⚠️ 檢查腳本若直接寫 data.db 的 settings，正在跑的 server／worker 會讀到假的出口設定，把真的通知送錯地方——所以給縫，不寫正式設定
 */
const deps = {
  outlets: (): Record<NotifyFeature, Outlet> => getOutlets(),
  sendLark: (chatId: string, card: object) => sendLarkCard(chatId, card),
  updateLark: (id: string, card: object) => updateLarkCard(id, card),
  chatId: () => larkNotifyChatId(),
  mention: (labels: string[]) => larkMentionLine(labels),
  readQueue: (): RetryItem[] => readQueueDb(),
  writeQueue: (q: RetryItem[]) => writeQueueDb(q),
  tx: <T>(fn: () => T): T => db.transaction(fn)(),
  discordSender: (url: string) => discordWebhookSender(url),
}
export const __notifyTestSeam = { deps, original: { ...deps } }

export const outletOf = (f: NotifyFeature): Outlet => deps.outlets()[f]
export const usesDiscord = (f: NotifyFeature) => outletOf(f) !== 'lark'
export const usesLark = (f: NotifyFeature) => outletOf(f) !== 'discord'

// ─── Discord embed → Lark 卡片 ──────────────────────────────────────────────
export type DiscordEmbed = {
  title?: string; description?: string; url?: string; color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: { text?: string }; timestamp?: string; image?: { url?: string }; thumbnail?: { url?: string }
}

/** Discord 顏色 → Lark 卡片標題顏色（只有固定幾種，取最接近的色系） */
export function larkTemplateFor(color?: number): string {
  if (color == null) return 'blue'
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255
  if (r > 180 && g < 120 && b < 120) return 'red'
  if (r > 200 && g > 140 && b < 100) return r > 230 && g < 200 ? 'orange' : 'yellow'
  if (g > 150 && r < 120) return b > 150 ? 'turquoise' : 'green'
  if (b > 150 && r < 120) return 'blue'
  if (r > 120 && b > 150) return 'purple'
  if (r < 140 && g < 140 && b < 140) return 'grey'
  return 'blue'
}

/** Discord 專用的 mention（<@123>）與時間戳（<t:…>）在 Lark 沒有意義，轉掉 */
const cleanText = (s: string) => s.replace(/<@!?\d+>/g, '').replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_m, t) => new Date(Number(t) * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }))

export function embedToLarkCard(embed: DiscordEmbed, mentionLine = ''): object {
  const elements: object[] = []
  const desc = [mentionLine, cleanText(embed.description ?? '')].filter(s => s.trim()).join('\n')
  if (desc) elements.push({ tag: 'markdown', content: desc })
  const fields = embed.fields ?? []
  for (let i = 0; i < fields.length;) {
    // 連續的 inline 欄位併成同一列（Lark 一列最多兩欄 is_short）
    const row: typeof fields = []
    while (i < fields.length && (row.length === 0 || (fields[i].inline && row[0].inline && row.length < 2))) { row.push(fields[i]); i++ }
    elements.push({ tag: 'div', fields: row.map(f => ({ is_short: !!f.inline, text: { tag: 'lark_md', content: `**${cleanText(f.name)}**\n${cleanText(f.value)}` } })) })
  }
  if (embed.image?.url) elements.push({ tag: 'markdown', content: `[查看截圖](${embed.image.url})` })
  if (embed.url) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '開啟' }, type: 'default', url: embed.url }] })
  const foot = [embed.footer?.text, embed.timestamp ? new Date(embed.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : ''].filter(Boolean).join('・')
  if (foot) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: cleanText(foot) }] })
  return { config: { wide_screen_mode: true, update_multi: true }, header: { template: larkTemplateFor(embed.color), title: { tag: 'plain_text', content: cleanText(embed.title ?? '通知') } }, elements }
}

// ─── @人（Lark）──────────────────────────────────────────────────────────────
/** 帳號名稱 → Lark @。沒權限／查不到 → 只寫名字（不 @），並回報哪些沒對到 */
export async function larkMentionLine(labels: string[]): Promise<{ line: string; unmapped: string[]; noPermission: boolean }> {
  const uniq = [...new Set(labels.filter(Boolean))]
  if (!uniq.length) return { line: '', unmapped: [], noPermission: false }
  const accounts = readAccounts()
  const emailOf = (label: string) => accounts.find(a => a.label === label || a.email === label)?.email ?? ''
  const emails = uniq.map(emailOf).filter(Boolean)
  const ids = emails.length ? await resolveLarkOpenIds(emails) : ({ ok: true, value: {} } as LarkResult<Record<string, string | null>>)
  const noPermission = !ids.ok && ids.code === 'NO_PERMISSION'
  const parts: string[] = [], unmapped: string[] = []
  for (const label of uniq) {
    const id = ids.ok ? ids.value[emailOf(label).toLowerCase()] : null
    if (id) parts.push(`<at id=${id}></at>`); else { parts.push(`@${label}`); unmapped.push(label) }
  }
  return { line: parts.join(' '), unmapped, noPermission }
}

// ─── 發送 ────────────────────────────────────────────────────────────────────
export type SideResult = { ok: boolean; messageId?: string; message?: string; skipped?: boolean }
export type DeliverResult = { discord?: SideResult; lark?: SideResult }

export type DeliverInput = {
  feature: NotifyFeature
  embed: DiscordEmbed
  /** Discord 那邊的 content（通常是 <@id> mention） */
  discordContent?: string
  /** 要 @ 的帳號名稱（Lark 用 email 查人） */
  mentionLabels?: string[]
  /** 已發過、要改同一則（各邊各自的 message id） */
  update?: { discordMessageId?: string; larkMessageId?: string }
  /** 只送這幾邊（重試失敗那一邊用）；不給＝依設定 */
  only?: Array<'discord' | 'lark'>
  /** 補送／試發用：不看功能的出口設定，only 指定哪邊就送哪邊 */
  ignoreOutlet?: boolean
}

export async function deliverNotice(p: DeliverInput, sendDiscord: (body: object, update?: string) => Promise<SideResult>): Promise<DeliverResult> {
  const out: DeliverResult = {}
  const wantDiscord = (!p.only || p.only.includes('discord')) && (p.ignoreOutlet || usesDiscord(p.feature))
  const wantLark = (!p.only || p.only.includes('lark')) && (p.ignoreOutlet || usesLark(p.feature))
  const tasks: Promise<void>[] = []
  if (wantDiscord) tasks.push((async () => {
    out.discord = await sendDiscord({ content: p.discordContent || undefined, embeds: [p.embed] }, p.update?.discordMessageId)
  })())
  if (wantLark) tasks.push((async () => {
    const m = await deps.mention(p.mentionLabels ?? [])
    const card = embedToLarkCard(p.embed, m.line)
    const r = p.update?.larkMessageId ? await deps.updateLark(p.update.larkMessageId, card) : await deps.sendLark(deps.chatId(), card)
    // 沒設定（沒憑證／沒選群）不是暫時性失敗，排重試也不會好；照樣回失敗讓呼叫端記下來，但標 skipped 不進佇列
    out.lark = r.ok ? { ok: true, messageId: p.update?.larkMessageId ?? (r.value as string) }
      : { ok: false, message: r.message, skipped: r.code === 'NOT_CONFIGURED' || r.code === 'NO_CHAT' }
    if (!r.ok) console.warn(`[notify:${p.feature}] Lark 發送失敗：${r.message}`)
  })())
  await Promise.all(tasks)
  return out
}

// ─── 只重試失敗那一邊（CodeX）────────────────────────────────────────────────
// 雙發時一邊成功一邊失敗：成功那邊不能重發（會重複），失敗那邊排進佇列，之後只往那邊補送。
// 存在 settings（server 與 worker 兩個 process 都會發通知，記憶體佇列重啟就沒了、也看不到對方的）。
// 取佇列用一個 transaction「讀出＋清空」，兩個 process 同時 flush 也不會重送同一則。
export type RetryItem = { feature: NotifyFeature; side: 'discord' | 'lark'; embed: DiscordEmbed; discordContent?: string; mentionLabels?: string[]; firstAt: number; tries: number; lastError?: string }
const RETRY_KEY = 'notify_retry_queue'
const RETRY_MAX_TRIES = 10
const RETRY_MAX_AGE_MS = 24 * 3600_000
function readQueueDb(): RetryItem[] {
  const raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(RETRY_KEY) as { value?: string } | undefined)?.value
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : [] } catch { return [] }
}
function writeQueueDb(q: RetryItem[]) { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(RETRY_KEY, JSON.stringify(q)) }
const readQueue = () => deps.readQueue()
const writeQueue = (q: RetryItem[]) => deps.writeQueue(q)

export function enqueueRetry(item: Omit<RetryItem, 'firstAt' | 'tries'>) {
  deps.tx(() => { const q = readQueue(); q.push({ ...item, firstAt: Date.now(), tries: 0 }); writeQueue(q.slice(-200)) })
}
export function retryQueueSize(): number { return readQueue().length }

/** 把結果裡失敗的那一邊排進重試（skipped＝那邊根本沒設定，不排） */
export function queueFailedSides(p: DeliverInput, r: DeliverResult) {
  for (const side of ['discord', 'lark'] as const) {
    const s = r[side]
    if (s && !s.ok && !s.skipped) enqueueRetry({ feature: p.feature, side, embed: p.embed, discordContent: p.discordContent, mentionLabels: p.mentionLabels, lastError: s.message })
  }
}

let flushing = false
export async function flushNotifyRetries(getWebhookUrl: () => string): Promise<{ sent: number; dropped: number; left: number }> {
  if (flushing) return { sent: 0, dropped: 0, left: 0 }
  flushing = true
  try {
    const taken = deps.tx(() => { const q = readQueue(); if (q.length) writeQueue([]); return q })
    let sent = 0, dropped = 0
    const keep: RetryItem[] = []
    for (const it of taken) {
      const r = await deliverNotice({ feature: it.feature, embed: it.embed, discordContent: it.discordContent, mentionLabels: it.mentionLabels, only: [it.side], ignoreOutlet: true }, deps.discordSender(getWebhookUrl()))
      const s = r[it.side]
      if (s?.ok) { sent++; continue }
      const next = { ...it, tries: it.tries + 1, lastError: s?.message }
      if (next.tries >= RETRY_MAX_TRIES || Date.now() - it.firstAt > RETRY_MAX_AGE_MS) { dropped++; console.warn(`[notify:${it.feature}] ${it.side} 補送放棄（${next.tries} 次）：${it.embed.title ?? ''}｜${next.lastError ?? ''}`) }
      else keep.push(next)
    }
    if (keep.length) deps.tx(() => writeQueue([...readQueue(), ...keep].slice(-200)))
    return { sent, dropped, left: keep.length }
  } finally { flushing = false }
}

/** 一般的 Discord webhook 發送（大部分功能用這個；要改同一則時帶 messageId） */
export function discordWebhookSender(webhookUrl: string) {
  return async (body: object, updateId?: string): Promise<SideResult> => {
    if (!webhookUrl) return { ok: false, skipped: true, message: '沒有設定 Discord Webhook' }
    try {
      const r = updateId
        ? await fetch(`${webhookUrl}/messages/${updateId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch(`${webhookUrl}?wait=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) return { ok: false, message: `Discord ${r.status}：${(await r.text().catch(() => '')).slice(0, 200)}` }
      const j = await r.json().catch(() => ({})) as { id?: string }
      return { ok: true, messageId: updateId ?? j.id }
    } catch (e) { return { ok: false, message: `Discord 送出失敗：${(e as Error).message}` } }
  }
}

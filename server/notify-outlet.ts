/**
 * 通知出口：一律發 **Lark**（v5.13.0 Discord 退場第二步，使用者 2026-10-06 確認刪除；CodeX 同意範圍）。
 *
 * 歷史：v5.1.0 加了 discord／lark／both 三種出口（Discord → Lark 遷移）；v5.5.0 第一步改成一律 Lark 但保留設定可退回；
 * 這一版把 Discord 的發送、出口設定、webhook 全部刪掉。
 *
 * 各功能只管「這則通知長什麼樣、要 @ 誰」：
 *  - 內容仍用 `DiscordEmbed` 這個形狀描述（標題、描述、欄位、顏色…）再轉成 Lark 卡片——名字是歷史包袱，
 *    它現在只是「通知內容」的格式，之後再改名（CodeX：這次不動，避免範圍擴大）
 *  - @人：用帳號 email 查 Lark open_id，查不到或沒權限就只寫名字、不 @
 *  - 失敗（不是沒設定）排進補送佇列，之後重送
 */
import { db, readAccounts } from './shared.js'
import { larkNotifyChatId, larkNotifyConfigured, resolveLarkOpenIds, sendLarkCard, updateLarkCard, type LarkResult } from './lark-notify.js'

export const NOTIFY_FEATURES = [
  { key: 'autospin', label: 'AutoSpin' },
  { key: 'live-ledger', label: 'Live Ledger' },
  { key: 'weekly-reminder', label: '週報提醒' },
] as const
export type NotifyFeature = typeof NOTIFY_FEATURES[number]['key']

/**
 * 測試縫：換掉 Lark 發送與重試佇列的儲存。
 * ⚠️ 檢查腳本若直接寫 data.db 的 settings，正在跑的 server／worker 會讀到假的設定，把真的通知送錯地方——所以給縫，不寫正式設定
 */
const deps = {
  sendLark: (chatId: string, card: object) => sendLarkCard(chatId, card),
  updateLark: (id: string, card: object) => updateLarkCard(id, card),
  configured: () => larkNotifyConfigured(),
  chatId: () => larkNotifyChatId(),
  mention: (labels: string[]) => larkMentionLine(labels),
  readQueue: (): RetryItem[] => readQueueDb(),
  writeQueue: (q: RetryItem[]) => writeQueueDb(q),
  tx: <T>(fn: () => T): T => db.transaction(fn)(),
}
export const __notifyTestSeam = { deps, original: { ...deps } }
/** Lark 通知有沒有設定（憑證＋目標群）。經過測試縫，檢查腳本才能模擬「沒設定」而不用改正式設定 */
export const notifyConfigured = () => deps.configured()

// ─── 通知內容 → Lark 卡片 ───────────────────────────────────────────────────
/** 通知內容的形狀（名字沿用 Discord embed，內容就是標題／描述／欄位／顏色；見檔頭） */
export type DiscordEmbed = {
  title?: string; description?: string; url?: string; color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: { text?: string }; timestamp?: string; image?: { url?: string }; thumbnail?: { url?: string }
}

/** 顏色 → Lark 卡片標題顏色（只有固定幾種，取最接近的色系） */
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

/** 舊內容裡可能殘留 Discord 的 mention（<@123>）與時間戳（<t:…>），在 Lark 沒有意義，轉掉 */
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
export type DeliverResult = { lark: SideResult }

export type DeliverInput = {
  feature: NotifyFeature
  embed: DiscordEmbed
  /** 要 @ 的帳號名稱（用 email 查人） */
  mentionLabels?: string[]
  /** 已發過、要改同一則（Lark message id） */
  update?: { larkMessageId?: string }
  /** Lark 專用卡片（拿 @人 那行組好）；不給就用 embedToLarkCard 從 embed 轉。目前只有 AutoSpin 定時彙總報告用（v5.8.0）。
   *  ⚠️ 補送佇列不存這個——它只存 embed，補送會退回轉換版；定時彙總報告本來就不排補送 */
  larkCard?: (mentionLine: string) => object
}

export async function deliverNotice(p: DeliverInput): Promise<DeliverResult> {
  const m = await deps.mention(p.mentionLabels ?? [])
  const card = p.larkCard ? p.larkCard(m.line) : embedToLarkCard(p.embed, m.line)
  const r = p.update?.larkMessageId ? await deps.updateLark(p.update.larkMessageId, card) : await deps.sendLark(deps.chatId(), card)
  // 沒設定（沒憑證／沒選群）不是暫時性失敗，排重試也不會好；照樣回失敗讓呼叫端記下來，但標 skipped 不進佇列
  const lark: SideResult = r.ok ? { ok: true, messageId: p.update?.larkMessageId ?? (r.value as string) }
    : { ok: false, message: r.message, skipped: r.code === 'NOT_CONFIGURED' || r.code === 'NO_CHAT' }
  if (!r.ok) console.warn(`[notify:${p.feature}] Lark 發送失敗：${r.message}`)
  return { lark }
}

// ─── 補送佇列 ────────────────────────────────────────────────────────────────
// 存在 settings（server 與 worker 兩個 process 都會發通知，記憶體佇列重啟就沒了、也看不到對方的）。
// 領取用**持久化租約**（CodeX review 2afdaeb [P1]）：在 transaction 裡標 leaseUntil，**成功才刪、失敗才放回**；
// process 中途死掉的話租約過期，下一次 flush（任一個 process）會重新領取。代價是極少數情況會重送一次（至少一次，不會漏）。
// 期限在**發送前**檢查（CodeX [P2]）。
// side：舊版本排進來的項目可能是 'discord'——一律丟掉、不改送 Lark（那則多半已經在 Lark 發過，轉送會重複；CodeX）
export type RetryItem = { id: string; feature: NotifyFeature; side: 'discord' | 'lark'; embed: DiscordEmbed; mentionLabels?: string[]; firstAt: number; tries: number; lastError?: string; leaseUntil?: number }
const RETRY_KEY = 'notify_retry_queue'
const RETRY_MAX_TRIES = 10
const RETRY_MAX_AGE_MS = 24 * 3600_000
const RETRY_LEASE_MS = 5 * 60_000
function readQueueDb(): RetryItem[] {
  const raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(RETRY_KEY) as { value?: string } | undefined)?.value
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : [] } catch { return [] }
}
function writeQueueDb(q: RetryItem[]) { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(RETRY_KEY, JSON.stringify(q)) }
const readQueue = () => deps.readQueue()
const writeQueue = (q: RetryItem[]) => deps.writeQueue(q)

const newRetryId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
export function enqueueRetry(item: Omit<RetryItem, 'id' | 'firstAt' | 'tries' | 'leaseUntil' | 'side'>) {
  deps.tx(() => { const q = readQueue(); q.push({ ...item, side: 'lark', id: newRetryId(), firstAt: Date.now(), tries: 0 }); writeQueue(q.slice(-200)) })
}
export function retryQueueSize(): number { return readQueue().length }

/** 失敗就排補送（skipped＝根本沒設定，不排） */
export function queueFailedSides(p: DeliverInput, r: DeliverResult) {
  if (!r.lark.ok && !r.lark.skipped) enqueueRetry({ feature: p.feature, embed: p.embed, mentionLabels: p.mentionLabels, lastError: r.lark.message })
}

let flushing = false
const expired = (it: RetryItem, now: number) => it.tries >= RETRY_MAX_TRIES || now - it.firstAt > RETRY_MAX_AGE_MS
export async function flushNotifyRetries(now = () => Date.now()): Promise<{ sent: number; dropped: number; left: number }> {
  if (flushing) return { sent: 0, dropped: 0, left: 0 }
  flushing = true
  try {
    // 領取：過期的直接移除（不送）；其餘沒人租或租約已過期的標上租約
    const dead: RetryItem[] = []
    const claimed = deps.tx(() => {
      const t = now(), mine: RetryItem[] = [], rest: RetryItem[] = []
      // v5.1.0 排進來的項目沒有 id（全是 undefined），成功刪除時會用 id 比對而整批誤刪（CodeX review 7027e12 [P1]）
      // → 領取前在同一個 transaction 裡補上唯一 id 並寫回
      let patched = false
      const q = readQueue().map(it => { if (it.id) return it; patched = true; return { ...it, id: newRetryId() } })
      for (const it of q) {
        if (expired(it, t)) { dead.push(it); continue }
        if (it.side === 'discord') { dead.push({ ...it, lastError: 'Discord 已移除，補送取消' }); continue }
        if (!it.leaseUntil || it.leaseUntil <= t) { const leased = { ...it, leaseUntil: t + RETRY_LEASE_MS }; mine.push(leased); rest.push(leased) }
        else rest.push(it)
      }
      if (mine.length || dead.length || patched) writeQueue(rest)
      return mine
    })
    for (const it of dead) console.warn(`[notify:${it.feature}] ${it.side} 補送放棄（${it.tries} 次、排了 ${Math.round((now() - it.firstAt) / 3600_000)} 小時）：${it.embed.title ?? ''}｜${it.lastError ?? ''}`)
    let sent = 0
    for (const it of claimed) {
      // 每筆發送前再判一次期限（CodeX [P2]）：整批領取時還沒過期，前面幾筆送得慢的話輪到它時可能已經過期
      if (expired(it, now())) {
        deps.tx(() => writeQueue(readQueue().filter(x => x.id !== it.id)))
        dead.push(it)
        console.warn(`[notify:${it.feature}] 補送放棄（輪到時已過期）：${it.embed.title ?? ''}`)
        continue
      }
      let s: SideResult | undefined
      try {
        s = (await deliverNotice({ feature: it.feature, embed: it.embed, mentionLabels: it.mentionLabels })).lark
      } catch (e) { s = { ok: false, message: (e as Error).message } }
      // 成功＝刪；失敗＝放回（次數 +1、解除租約），下一輪再領
      deps.tx(() => {
        const q = readQueue()
        writeQueue(s?.ok ? q.filter(x => x.id !== it.id) : q.map(x => x.id === it.id ? { ...x, tries: x.tries + 1, lastError: s?.message, leaseUntil: undefined } : x))
      })
      if (s?.ok) sent++
    }
    return { sent, dropped: dead.length, left: readQueue().length }
  } finally { flushing = false }
}

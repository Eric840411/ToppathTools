/**
 * Lark 通知機器人（取代 Discord 通知，使用者 2026-10-03）。用使用者在「Lark 通知設定」頁填的應用（目前是 OSM QA 機器人）發訊息。
 *
 * - **只發不收**：這個應用的長連線被 Claude 的 lark plugin 佔著；工具再連長連線會跟它搶事件（每則只會隨機送到其中一邊）。
 *   所以這裡只用 HTTP API 發訊息／改卡片／列群／查人，不接任何事件或卡片回呼（週報按鈕改成連結開確認頁）
 * - 憑證存在 settings：App ID 明文；**Secret 用伺服器金鑰加密**（MEEGLE_TOKEN_KEY，跟 Meegle token 同一把），
 *   沒設金鑰就拒絕儲存（CodeX）。Secret 不回傳前端、不進 log
 * - @人：帳號 email → Lark open_id（contact/v3/users/batch_get_id），需要應用有 `contact:user.id:readonly`；
 *   沒權限時回 NO_PERMISSION，呼叫端改成只寫名字、不 @（2026-10-03 實測 OSM QA 目前沒有這個權限）
 */
import { db } from './shared.js'
import { decryptMeegleToken, encryptMeegleToken, isMeegleKeyConfigured } from './meegle-token-crypto.js'

const BASE = () => process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
const K = { appId: 'lark_notify_app_id', secret: 'lark_notify_secret_enc', chatId: 'lark_notify_chat_id', toolUrl: 'lark_notify_tool_url' } as const

const getSetting = (k: string): string => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value?: string } | undefined)?.value ?? ''
const setSetting = (k: string, v: string) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v)

export type LarkNotifyConfig = { appId: string; hasSecret: boolean; secretTail: string; keyConfigured: boolean; chatId: string; toolUrl: string }

/** 給前端看的設定（Secret 只給尾碼） */
export function readLarkNotifyConfig(): LarkNotifyConfig {
  const enc = getSetting(K.secret)
  let tail = ''
  if (enc && isMeegleKeyConfigured()) { try { tail = decryptMeegleToken(enc).slice(-4) } catch { tail = '（解不開）' } }
  return { appId: getSetting(K.appId), hasSecret: !!enc, secretTail: tail, keyConfigured: isMeegleKeyConfigured(), chatId: getSetting(K.chatId), toolUrl: getSetting(K.toolUrl) }
}

/** 寫設定。secret 給空字串／undefined＝保留原值。沒有加密金鑰就拒絕存 Secret（不退回明文） */
export function writeLarkNotifyConfig(p: { appId?: string; secret?: string; chatId?: string; toolUrl?: string }): { ok: true } | { ok: false; message: string } {
  if (p.secret) {
    if (!isMeegleKeyConfigured()) return { ok: false, message: '伺服器沒有設定加密金鑰（MEEGLE_TOKEN_KEY），不能儲存 Secret' }
    setSetting(K.secret, encryptMeegleToken(p.secret.trim()))
    tokenCache = null
  }
  if (p.appId !== undefined) { setSetting(K.appId, p.appId.trim()); tokenCache = null }
  if (p.chatId !== undefined) setSetting(K.chatId, p.chatId.trim())
  if (p.toolUrl !== undefined) setSetting(K.toolUrl, p.toolUrl.trim().replace(/\/+$/, ''))
  return { ok: true }
}

function storedCreds(): { appId: string; secret: string } | null {
  const appId = getSetting(K.appId), enc = getSetting(K.secret)
  if (!appId || !enc || !isMeegleKeyConfigured()) return null
  try { return { appId, secret: decryptMeegleToken(enc) } } catch { return null }
}

let tokenCache: { appId: string; token: string; until: number } | null = null

// ⚠️ server 的 tsconfig 不是 strict，判別聯集不會因為 `if (!r.ok)` 收窄——失敗的結果要轉型時用 asFail()
export type LarkFail = { ok: false; value?: undefined; code: string; message: string }
export type LarkResult<T> = { ok: true; value: T; code?: undefined; message?: undefined } | LarkFail
export const asFail = (r: { code?: string; message?: string }): LarkFail => ({ ok: false, code: r.code ?? 'UNKNOWN', message: r.message ?? '' })

/** 換 tenant_access_token。creds 不給就用已存的 */
export async function larkTenantToken(creds?: { appId: string; secret: string }): Promise<LarkResult<string>> {
  const c = creds ?? storedCreds()
  if (!c) return { ok: false, code: 'NOT_CONFIGURED', message: '還沒設定 Lark 通知機器人（App ID／Secret）' }
  if (!creds && tokenCache && tokenCache.appId === c.appId && tokenCache.until > Date.now() + 60_000) return { ok: true, value: tokenCache.token }
  try {
    const r = await fetch(`${BASE()}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: c.appId, app_secret: c.secret }) })
    const j = await r.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (j.code !== 0 || !j.tenant_access_token) return { ok: false, code: 'BAD_CREDENTIALS', message: `Lark 拒絕這組 App ID／Secret（${j.code}：${j.msg ?? ''}）` }
    if (!creds) tokenCache = { appId: c.appId, token: j.tenant_access_token, until: Date.now() + (j.expire ?? 3600) * 1000 }
    return { ok: true, value: j.tenant_access_token }
  } catch (e) { return { ok: false, code: 'UNAVAILABLE', message: `連不上 Lark：${(e as Error).message}` } }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<LarkResult<T>> {
  const t = await larkTenantToken()
  if (!t.ok) return asFail(t)
  try {
    const r = await fetch(`${BASE()}${path}`, { method, headers: { Authorization: `Bearer ${t.value}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const j = await r.json() as { code?: number; msg?: string; data?: T }
    if (j.code !== 0) return { ok: false, code: j.code === 99991672 ? 'NO_PERMISSION' : String(j.code), message: `Lark API ${j.code}：${j.msg ?? ''}` }
    return { ok: true, value: (j.data ?? {}) as T }
  } catch (e) { return { ok: false, code: 'UNAVAILABLE', message: `連不上 Lark：${(e as Error).message}` } }
}

/** 機器人有加入的群（翻完所有頁，CodeX：群組清單要處理分頁） */
export async function listBotChats(): Promise<LarkResult<Array<{ chatId: string; name: string }>>> {
  const out: Array<{ chatId: string; name: string }> = []
  let pageToken = ''
  for (let i = 0; i < 50; i++) {
    const r = await api<{ items?: Array<{ chat_id: string; name: string }>; has_more?: boolean; page_token?: string }>('GET', `/open-apis/im/v1/chats?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`)
    if (!r.ok) return asFail(r)
    for (const it of r.value.items ?? []) out.push({ chatId: it.chat_id, name: it.name })
    if (!r.value.has_more || !r.value.page_token) return { ok: true, value: out }
    pageToken = r.value.page_token
  }
  return { ok: false, code: 'TOO_MANY', message: '群組清單超過 5000 個，沒有全部讀完' }
}

/** 發一張卡片到群，回 message_id */
export async function sendLarkCard(chatId: string, card: object): Promise<LarkResult<string>> {
  if (!chatId) return { ok: false, code: 'NO_CHAT', message: '還沒選要發到哪個群' }
  const r = await api<{ message_id?: string }>('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) })
  return r.ok ? (r.value.message_id ? { ok: true, value: r.value.message_id } : { ok: false, code: 'NO_ID', message: 'Lark 沒有回 message_id' }) : asFail(r)
}

/** 更新一張已發出的卡片（只能改應用自己發的卡片） */
export async function updateLarkCard(messageId: string, card: object): Promise<LarkResult<true>> {
  const r = await api<unknown>('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) })
  return r.ok ? { ok: true, value: true } : asFail(r)
}

/** email → open_id（1 小時快取）。沒權限整批回 NO_PERMISSION */
const idCache = new Map<string, { openId: string | null; at: number }>()
export async function resolveLarkOpenIds(emails: string[]): Promise<LarkResult<Record<string, string | null>>> {
  const want = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))]
  const out: Record<string, string | null> = {}
  const miss = want.filter(e => { const c = idCache.get(e); if (c && Date.now() - c.at < 3600_000) { out[e] = c.openId; return false } return true })
  for (let i = 0; i < miss.length; i += 50) {
    const r = await api<{ user_list?: Array<{ email?: string; user_id?: string }> }>('POST', '/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id', { emails: miss.slice(i, i + 50) })
    if (!r.ok) return asFail(r)
    for (const e of miss.slice(i, i + 50)) {
      const hit = (r.value.user_list ?? []).find(u => (u.email ?? '').toLowerCase() === e)
      out[e] = hit?.user_id ?? null
      idCache.set(e, { openId: out[e], at: Date.now() })
    }
  }
  return { ok: true, value: out }
}

export function larkNotifyChatId(): string { return getSetting(K.chatId) }
export function larkToolUrl(): string { return getSetting(K.toolUrl) }

/** 機器人名稱（設定頁標題旁的標籤用）。查不到就回空，不影響其他功能 */
export async function larkBotName(): Promise<string> {
  // ⚠️ 這支 API 的回應把 bot 放在最外層（不是 data 底下），所以不走 api()
  const t = await larkTenantToken()
  if (!t.ok) return ''
  try {
    const r = await fetch(`${BASE()}/open-apis/bot/v3/info`, { headers: { Authorization: `Bearer ${t.value}` } })
    const j = await r.json() as { code?: number; bot?: { app_name?: string } }
    return j.code === 0 ? j.bot?.app_name ?? '' : ''
  } catch { return '' }
}

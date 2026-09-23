/**
 * server/routes/lark-schedule.ts — Lark 排程提醒（時辰法旨）的 API。
 *
 * 回調端點是**公開路徑**，不能靠「沒人知道路徑」當防護。每一則回調都要過：
 *   1. 對 **原始 body bytes** 驗簽（parse 過再 stringify 回去會因鍵序/空白不同而簽不過）
 *   2. 解密後驗 verification token
 *   3. 時間窗（防重放）
 *   4. 群白名單（這隻 app 與其他群共用）
 *   5. 欄位完整性——缺任何一個直接拒絕，不猜
 * 任何一關不過就回 401/400，不進業務邏輯。
 *
 * ⚠️ 舊版（v1）卡片回調的驗簽規則跟 v2 不同，不能混用。這裡只收 v2（帶 encrypt 或
 *    帶 X-Lark-Signature 的 schema 2.0），v1 一律拒絕。
 */
import { Router } from 'express'
import crypto from 'node:crypto'
import {
  getSettings, saveSettings, isAllowedChat, listAllRecords,
  fText, fDate, scheduleCard, resultCard, sendCard, getRecord,
  ensureClaimTable,
} from '../lib/lark-schedule.js'
import { applyCardAction, runTick, expandRules, getLastTick, startScheduleTick } from '../lib/lark-schedule-runner.js'

export const router = Router()

const VERIFICATION_TOKEN = process.env.LARK_CALLBACK_VERIFICATION_TOKEN ?? ''
const ENCRYPT_KEY = process.env.LARK_CALLBACK_ENCRYPT_KEY ?? ''

/** 防重放的時間窗。Lark 的 timestamp 是秒。 */
const REPLAY_WINDOW_SEC = 300

// ─── 限流（回調端點公開，擋掉暴力嘗試） ────────────────────────────────────

const hits = new Map<string, number[]>()
const RATE_LIMIT = 60          // 每分鐘每 IP 最多 60 次
const RATE_WINDOW = 60_000

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const arr = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW)
  arr.push(now)
  hits.set(ip, arr)
  if (hits.size > 1000) hits.clear()   // 粗暴但夠用，避免無限長大
  return arr.length > RATE_LIMIT
}

// ─── 驗簽 / 解密 ─────────────────────────────────────────────────────────────

/** AES-256-CBC 解密，key = sha256(encryptKey)，前 16 bytes 是 IV。 */
function decrypt(encrypted: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest()
  const buf = Buffer.from(encrypted, 'base64')
  const iv = buf.subarray(0, 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8')
}

/** 簽章 = sha256(timestamp + nonce + encryptKey + rawBody)，對原始 bytes 算。 */
function verifySignature(args: {
  timestamp: string; nonce: string; signature: string; rawBody: Buffer; encryptKey: string
}): boolean {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(args.timestamp + args.nonce + args.encryptKey, 'utf8'))
  h.update(args.rawBody)
  const expected = h.digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(args.signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** 只描述我們真的會讀的欄位；其餘一律不碰，缺欄位在下面直接拒絕。 */
type CallbackPayload = {
  type?: string
  token?: string
  challenge?: string
  schema?: string
  header?: { token?: string; event_type?: string }
  event?: {
    operator?: { open_id?: string }
    context?: { open_chat_id?: string; open_message_id?: string }
    action?: { value?: { record?: string; action?: string; occ?: string } }
  }
}

// ─── 回調端點 ────────────────────────────────────────────────────────────────

router.post('/api/lark-schedule/callback', async (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  if (rateLimited(ip)) return res.status(429).json({ msg: 'rate limited' })

  const rawBody: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody
  const body = req.body as (CallbackPayload & { encrypt?: string }) | undefined
  if (!body) return res.status(400).json({ msg: 'empty body' })

  // ── 1. 解密（有設 Encrypt Key 就一定要是加密的）
  let payload: CallbackPayload
  if (ENCRYPT_KEY) {
    const encrypted = typeof body.encrypt === 'string' ? body.encrypt : ''
    if (!encrypted) return res.status(400).json({ msg: 'encrypt required' })

    // ── 2. 驗簽（對原始 bytes）
    const timestamp = String(req.headers['x-lark-request-timestamp'] ?? '')
    const nonce = String(req.headers['x-lark-request-nonce'] ?? '')
    const signature = String(req.headers['x-lark-signature'] ?? '')
    if (!timestamp || !nonce || !signature || !rawBody) {
      return res.status(401).json({ msg: 'missing signature headers' })
    }
    if (!verifySignature({ timestamp, nonce, signature, rawBody, encryptKey: ENCRYPT_KEY })) {
      return res.status(401).json({ msg: 'bad signature' })
    }
    // ── 3. 防重放
    const skew = Math.abs(Date.now() / 1000 - Number(timestamp))
    if (!Number.isFinite(skew) || skew > REPLAY_WINDOW_SEC) {
      return res.status(401).json({ msg: 'timestamp out of window' })
    }

    try {
      payload = JSON.parse(decrypt(encrypted, ENCRYPT_KEY))
    } catch {
      return res.status(400).json({ msg: 'decrypt failed' })
    }
  } else {
    payload = body
  }

  // URL 驗證握手（設定回調網址時 Lark 會先打這個）
  if (payload.type === 'url_verification') {
    if (VERIFICATION_TOKEN && payload.token !== VERIFICATION_TOKEN) {
      return res.status(401).json({ msg: 'bad token' })
    }
    return res.json({ challenge: payload.challenge })
  }

  // ── 4. verification token
  const token = payload.token ?? payload.header?.token
  if (VERIFICATION_TOKEN && token !== VERIFICATION_TOKEN) {
    return res.status(401).json({ msg: 'bad token' })
  }

  // ⚠️ 只收 v2。v1 卡片回調的驗簽規則不同，混用會讓防護形同虛設。
  const schema = String(payload.schema ?? '')
  const eventType = String(payload.header?.event_type ?? '')
  if (!schema.startsWith('2') || eventType !== 'card.action.trigger') {
    return res.status(400).json({ msg: 'unsupported callback' })
  }

  // ── 5. 欄位完整性：缺就拒絕，不猜
  const event = payload.event ?? {}
  const openId: string | undefined = event.operator?.open_id
  const chatId: string | undefined = event.context?.open_chat_id
  const messageId: string | undefined = event.context?.open_message_id
  const value = event.action?.value ?? {}
  const recordId: string | undefined = value.record
  const action: string | undefined = value.action

  if (!openId || !chatId || !recordId) return res.status(400).json({ msg: 'incomplete payload' })
  if (action !== 'done' && action !== 'cancel') return res.status(400).json({ msg: 'unknown action' })

  // 群白名單：這隻 app 與其他群共用，非指定群一律不處理
  if (!isAllowedChat(chatId)) {
    return res.json({ toast: { type: 'error', content: '這個群未啟用排程提醒' } })
  }

  // 訊息與行程的對應：卡片上的 record 必須真的屬於這張表
  const rec = await getRecord(getSettings().schedTable, recordId)
  if (!rec) return res.json({ toast: { type: 'error', content: '找不到這筆行程' } })

  const result = await applyCardAction({ recordId, action, openId, messageId })
  if (!result.ok) {
    return res.json({
      toast: { type: result.card ? 'info' : 'error', content: result.toast ?? '處理失敗，請再試一次' },
      ...(result.card ? { card: { type: 'raw', data: result.card } } : {}),
    })
  }
  return res.json({
    toast: { type: 'success', content: `已記錄：${result.status ?? ''}` },
    card: {
      type: 'raw',
      data: resultCard(result.name ?? '(未命名)', result.status ?? '已完成', result.who ?? '(未知)', result.at ?? Date.now()),
    },
  })
})

// ─── 設定 API ────────────────────────────────────────────────────────────────

router.get('/api/lark-schedule/settings', (_req, res) => {
  ensureClaimTable()
  res.json({
    ok: true,
    settings: getSettings(),
    lastTick: getLastTick(),
    callbackConfigured: Boolean(ENCRYPT_KEY && VERIFICATION_TOKEN),
  })
})

router.post('/api/lark-schedule/settings', (req, res) => {
  const patch = req.body as Record<string, unknown>
  const next = saveSettings(patch)
  if (next.enabled) startScheduleTick()
  res.json({ ok: true, settings: next })
})

// ─── 手動操作（配置頁用） ────────────────────────────────────────────────────

router.post('/api/lark-schedule/tick', async (_req, res) => {
  const summary = await runTick()
  res.json({ ok: !summary.error, summary })
})

router.post('/api/lark-schedule/expand', async (_req, res) => {
  try {
    const n = await expandRules()
    res.json({ ok: true, created: n })
  } catch (e) {
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

/** 發一張測試卡片，確認推播管道與 chat_id 正確 */
router.post('/api/lark-schedule/test', async (_req, res) => {
  const s = getSettings()
  if (!s.chatId) return res.status(400).json({ ok: false, message: '尚未設定 chat_id' })
  try {
    const { messageId } = await sendCard({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🧪 排程提醒 — 連線測試' }, template: 'grey' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '看到這則代表推播管道正常，chat_id 也對。' } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `chat_id: ${s.chatId}` }] },
      ],
    })
    res.json({ ok: true, messageId })
  } catch (e) {
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

/** 行程一覽（配置頁右側列表用） */
router.get('/api/lark-schedule/records', async (_req, res) => {
  const s = getSettings()
  if (!s.baseToken || !s.schedTable) return res.json({ ok: true, items: [] })
  try {
    const recs = await listAllRecords(s.schedTable)
    const items = recs
      .map(r => ({
        recordId: r.record_id,
        name: fText(r, '行程名稱'),
        start: fDate(r, '開始時間'),
        status: fText(r, '狀態'),
        pushedAt: fDate(r, '推播時間'),
        doneBy: fText(r, '完成者'),
      }))
      .filter(x => x.start != null)
      .sort((a, b) => (a.start! - b.start!))
    res.json({ ok: true, items })
  } catch (e) {
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

/** 預覽卡片長相（不發送），配置頁改設定後可以先看效果 */
router.get('/api/lark-schedule/preview', async (_req, res) => {
  const s = getSettings()
  try {
    const recs = await listAllRecords(s.schedTable)
    const sample = recs.find(r => fDate(r, '開始時間') != null)
    if (!sample) return res.json({ ok: true, card: null })
    res.json({ ok: true, card: scheduleCard(sample) })
  } catch (e) {
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

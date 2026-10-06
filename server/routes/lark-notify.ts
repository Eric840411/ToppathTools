/**
 * server/routes/lark-notify.ts — 「Lark 通知設定」頁的 API（使用者 2026-10-03；版面 CodeX 設計）。
 *
 * ⚠️ 全部只限管理員，**後端檢查**（前端藏按鈕不算）。
 * ⚠️ Secret 只寫不讀：GET 只回「有沒有設定＋尾碼」，送進來的 Secret 不進 log、不進歷史紀錄。
 * ⚠️ 工具只發不收（長連線是 Claude 的 lark plugin 在用），這裡沒有任何事件／回呼端點。
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { addHistory, readAccounts, writeLimiter } from '../shared.js'
import { larkBotName, larkTenantToken, listBotChats, readLarkNotifyConfig, resolveLarkOpenIds, sendLarkCard, writeLarkNotifyConfig, larkNotifyChatId } from '../lark-notify.js'
import { NOTIFY_FEATURES, embedToLarkCard, flushNotifyRetries, retryQueueSize } from '../notify-outlet.js'

export const router = Router()

function requireAdmin(req: Request, res: Response) {
  const account = getAuthAccount(req)
  // 停權的管理員也擋（getAuthAccount 不看 status；跟週報關卡同一條：不是 active 就算停權）
  const status = account ? readAccounts().find(a => a.email === account.email)?.status : undefined
  if (!account || account.role !== 'admin' || (status ?? 'active') !== 'active') { res.status(403).json({ ok: false, message: '需要管理員權限' }); return null }
  return account
}

router.get('/api/lark-notify/config', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const config = readLarkNotifyConfig()
  const botName = config.appId && config.hasSecret ? await larkBotName() : ''
  res.json({ ok: true, config, botName, features: NOTIFY_FEATURES, retryQueue: retryQueueSize() })
})

router.put('/api/lark-notify/config', writeLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return
  const parsed = z.object({
    appId: z.string().max(100).optional(),
    secret: z.string().max(200).optional(),
    chatId: z.string().max(100).optional(),
    toolUrl: z.string().max(300).optional(),
  }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, message: '格式不對' })
  const b = parsed.data
  if (b.toolUrl && !/^https?:\/\//i.test(b.toolUrl.trim())) return res.status(400).json({ ok: false, message: '工具網址要以 http:// 或 https:// 開頭' })
  const w = writeLarkNotifyConfig({ appId: b.appId, secret: b.secret || undefined, chatId: b.chatId, toolUrl: b.toolUrl })
  if (!w.ok) return res.status(400).json(w)
  // 歷史紀錄只記「改了什麼」，不記 Secret 內容
  addHistory('lark-notify', 'Lark 通知設定', [
    b.appId !== undefined ? 'App ID' : '', b.secret ? 'Secret（已更換）' : '', b.chatId !== undefined ? '目標群' : '',
    b.toolUrl !== undefined ? '工具網址' : '',
  ].filter(Boolean).join('、') || '沒有變更', { appId: b.appId, chatId: b.chatId, toolUrl: b.toolUrl, secretChanged: !!b.secret })
  res.json({ ok: true, config: readLarkNotifyConfig() })
})

/** 驗證憑證：有填就驗填的（還沒存），Secret 留空就用已存的。不寫入、不快取 */
router.post('/api/lark-notify/verify', writeLimiter, async (req, res) => {
  if (!requireAdmin(req, res)) return
  const b = z.object({ appId: z.string().max(100).optional(), secret: z.string().max(200).optional() }).safeParse(req.body)
  if (!b.success) return res.status(400).json({ ok: false, message: '格式不對' })
  const appId = b.data.appId?.trim(), secret = b.data.secret?.trim()
  const r = appId && secret ? await larkTenantToken({ appId, secret }) : await larkTenantToken()
  if (!r.ok) return res.json({ ok: false, code: r.code, message: r.message })
  // 機器人名稱只查已存的那組（未存的憑證不進快取，名稱等存了再顯示）
  const botName = appId && secret ? '' : await larkBotName()
  res.json({ ok: true, botName, message: appId && secret ? '這組憑證有效（還沒儲存）' : '已儲存的憑證有效' })
})

router.get('/api/lark-notify/chats', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const r = await listBotChats()
  if (!r.ok) return res.json({ ok: false, code: r.code, message: r.message })
  res.json({ ok: true, chats: r.value })
})

/** 試發：發到指定的群（沒給就用已存的），不受各功能出口設定影響 */
router.post('/api/lark-notify/test', writeLimiter, async (req, res) => {
  const admin = requireAdmin(req, res)
  if (!admin) return
  const b = z.object({ chatId: z.string().max(100).optional() }).safeParse(req.body)
  if (!b.success) return res.status(400).json({ ok: false, message: '格式不對' })
  const chatId = b.data.chatId?.trim() || larkNotifyChatId()
  const card = embedToLarkCard({
    title: '✅ Toppath Tools 測試訊息', color: 0x22c55e,
    description: '這是一則測試訊息，收得到就代表 Lark 通知機器人設定正確。',
    fields: [{ name: '發送者', value: admin.label || admin.email, inline: true }, { name: '目標群', value: chatId, inline: true }],
    footer: { text: 'Lark 通知設定 · 試發' }, timestamp: new Date().toISOString(),
  })
  const r = await sendLarkCard(chatId, card)
  addHistory('lark-notify', 'Lark 通知試發', r.ok ? `已送到 ${chatId}` : `失敗：${r.message}`, { chatId, ok: r.ok })
  res.json(r.ok ? { ok: true, message: '已送出測試訊息' } : { ok: false, code: r.code, message: r.message })
})

/** 帳號 → Lark 使用者對照狀態（@人用）。沒有 contact 權限時整批回 noPermission，畫面顯示「缺少權限」 */
router.get('/api/lark-notify/mentions', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const accounts = readAccounts().filter(a => a.status !== 'disabled')
  const r = await resolveLarkOpenIds(accounts.map(a => a.email))
  if (!r.ok) return res.json({ ok: true, noPermission: r.code === 'NO_PERMISSION', error: r.code === 'NO_PERMISSION' ? '' : r.message, rows: accounts.map(a => ({ label: a.label, email: a.email, status: 'unknown' })) })
  res.json({ ok: true, noPermission: false, rows: accounts.map(a => ({ label: a.label, email: a.email, status: r.value[a.email.toLowerCase()] ? 'mapped' : 'not_found' })) })
})

// server 這個 process 的補送（AutoSpin 雙發時失敗的那一邊）。Live Ledger 在自己的週期裡也會 flush，佇列有搶占所以不會重送
setInterval(() => { flushNotifyRetries().catch(e => console.warn('[notify] 補送失敗', e)) }, 2 * 60_000).unref()

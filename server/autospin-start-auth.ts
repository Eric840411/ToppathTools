/**
 * AutoSpin Python 引擎的啟動授權（CodeX 審 c538e86／db688cf [P1]）。
 *
 * /api/autospin/agent/start 不帶 cookie（Python 沒有登入身分），原本只靠自報的 userLabel——任何人都能用
 * 別人的名字開 session、把對方正在跑的 session 停掉，還會拿到解密後的 Lark webhook。現在只認兩種：
 *  ① 派工時發的一次性啟動票：hub-dispatch 由已登入的人觸發，票跟著 autospin_start 訊息傳給 Local Agent
 *     → Python 啟動參數 → /agent/start。10 分鐘內有效、用一次就失效、要配對同一個帳號
 *  ② 重連：帶 prevSessionId，而且查到的 session **id 必須完全相同**、同帳號、沒被停止、10 分鐘內有心跳
 *
 * ⚠️ 不再有「沒憑證的相容退路」。v5.66.2 曾放行「該帳號 10 分鐘內剛被派工」給舊版 Local Agent，
 *    CodeX 複審指出：匿名者只憑帳號名就能搶先兌換（拿到 webhook、干擾 session），而且兌換後原票還能再用。
 *    縮短時限解決不了冒名 → 舊版 Local Agent 一律要先「更新程式碼」才能跑 AutoSpin。
 * ⚠️ 重連的查找函式在查不到 id 時會退回「這個帳號最新一筆」（給舊流程用的），這裡**必須**再比對 id，
 *    不然亂填一個 id 就能借用別人的 session（CodeX 複審 [P1]）。
 */
import { createHash, randomBytes } from 'crypto'

export const START_GRANT_TTL_MS = 10 * 60 * 1000

type PrevSession = { id?: string; userLabel?: string; status?: string; stopRequested?: boolean; lastHeartbeat?: number } | null
export type StartBody = { userLabel?: string; startTicket?: string; reconnect?: boolean; prevSessionId?: string }

export function createAgentStartAuth(findPrev: (prevSessionId: string | undefined, userLabel: string) => PrevSession) {
  const tickets = new Map<string, { userLabel: string; exp: number }>()
  const hash = (t: string) => createHash('sha256').update(t).digest('hex')

  function issue(userLabel: string, now = Date.now()): string {
    for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k)
    const ticket = randomBytes(24).toString('hex')
    tickets.set(hash(ticket), { userLabel, exp: now + START_GRANT_TTL_MS })
    return ticket
  }

  function authorize(body: StartBody, now = Date.now()): 'ticket' | 'reconnect' | null {
    const userLabel = body.userLabel ?? ''
    if (typeof body.startTicket === 'string' && body.startTicket) {
      const k = hash(body.startTicket)
      const t = tickets.get(k)
      if (t && t.exp > now && t.userLabel === userLabel) {
        tickets.delete(k)
        return 'ticket'
      }
      return null
    }
    if (body.reconnect === true && typeof body.prevSessionId === 'string' && body.prevSessionId) {
      const prev = findPrev(body.prevSessionId, userLabel)
      if (prev && prev.id === body.prevSessionId && prev.userLabel === userLabel
        && prev.status !== 'stopped' && !prev.stopRequested
        && now - (prev.lastHeartbeat ?? 0) < START_GRANT_TTL_MS) return 'reconnect'
    }
    return null
  }

  return { issue, authorize }
}

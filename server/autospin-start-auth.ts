/**
 * AutoSpin Python 引擎的啟動授權（CodeX 審 c538e86 [P1]）。
 *
 * /api/autospin/agent/start 不帶 cookie（Python 沒有登入身分），原本只靠自報的 userLabel——任何人都能用
 * 別人的名字開 session、把對方正在跑的 session 停掉，還會拿到解密後的 Lark webhook。現在要符合其中一個：
 *  ① 帶派工時發的一次性啟動票（hub-dispatch 由已登入的人觸發，票跟著 autospin_start 訊息傳給 Local Agent
 *     → Python 啟動參數 → /agent/start）。10 分鐘內有效、用一次就失效
 *  ② 還沒更新的舊 Local Agent 不會帶票：退而看「這個帳號 10 分鐘內剛被派工過」（伺服器自己記的，不是自報），
 *     一樣用一次就失效。全部 Local Agent 更新後可以拿掉這條
 *  ③ 重連（reconnect + prevSessionId）：上一個 session 必須真的存在、同帳號、沒被停止、10 分鐘內有心跳
 * 帶了票但票不對 → 直接拒絕，不退回②（不然偽造的票等於沒帶）。
 */
import { createHash, randomBytes } from 'crypto'

export const START_GRANT_TTL_MS = 10 * 60 * 1000

type PrevSession = { userLabel?: string; status?: string; stopRequested?: boolean; lastHeartbeat?: number } | null
export type StartBody = { userLabel?: string; startTicket?: string; reconnect?: boolean; prevSessionId?: string }

export function createAgentStartAuth(findPrev: (prevSessionId: string | undefined, userLabel: string) => PrevSession) {
  const tickets = new Map<string, { userLabel: string; exp: number }>()
  const recentDispatches = new Map<string, number>()
  const hash = (t: string) => createHash('sha256').update(t).digest('hex')

  function issue(userLabel: string, now = Date.now()): string {
    for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k)
    const ticket = randomBytes(24).toString('hex')
    tickets.set(hash(ticket), { userLabel, exp: now + START_GRANT_TTL_MS })
    recentDispatches.set(userLabel, now + START_GRANT_TTL_MS)
    return ticket
  }

  function authorize(body: StartBody, now = Date.now()): 'ticket' | 'dispatch' | 'reconnect' | null {
    const userLabel = body.userLabel ?? ''
    if (typeof body.startTicket === 'string' && body.startTicket) {
      const k = hash(body.startTicket)
      const t = tickets.get(k)
      if (t && t.exp > now && t.userLabel === userLabel) {
        tickets.delete(k)
        recentDispatches.delete(userLabel)
        return 'ticket'
      }
      return null
    }
    if (body.reconnect === true) {
      // 一定要帶 prevSessionId 並對得上（不走「沒帶就找這個帳號最近一筆」——那等於只靠自報 userLabel）
      if (!body.prevSessionId) return null
      const prev = findPrev(body.prevSessionId, userLabel)
      if (prev && prev.userLabel === userLabel && prev.status !== 'stopped' && !prev.stopRequested
        && now - (prev.lastHeartbeat ?? 0) < START_GRANT_TTL_MS) return 'reconnect'
      return null
    }
    const d = recentDispatches.get(userLabel)
    if (d && d > now) {
      recentDispatches.delete(userLabel)
      return 'dispatch'
    }
    return null
  }

  return { issue, authorize }
}

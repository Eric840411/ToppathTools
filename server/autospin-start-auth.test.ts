/**
 * AutoSpin 啟動授權的回歸。跑法：npx tsx server/autospin-start-auth.test.ts
 *
 * ⚠️ 查找替身要跟正式的 findPreviousSessionForReconnect 一樣「查不到 id 就退回該帳號最新一筆」——
 *    v5.66.2 的替身沒有這段 fallback，亂填 id 借用別人 session 的洞就這樣漏掉（CodeX 複審 [P1]）。
 */
import { createAgentStartAuth, START_GRANT_TTL_MS } from './autospin-start-auth.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (got === want) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

type S = { id: string; userLabel: string; status: string; stopRequested?: boolean; lastHeartbeat: number }
const sessions: Record<string, S> = {}
// 跟正式查找函式同樣的行為：id 查得到就回那筆；查不到就退回這個帳號心跳最新的一筆
const findPrev = (id: string | undefined, userLabel: string): S | null => {
  if (id && sessions[id]) return sessions[id]
  let best: S | null = null
  for (const s of Object.values(sessions)) if (s.userLabel === userLabel && (!best || s.lastHeartbeat > best.lastHeartbeat)) best = s
  return best
}
const auth = createAgentStartAuth(findPrev)
const t0 = 1_000_000_000

eq('沒票：擋', auth.authorize({ userLabel: 'Eric' }, t0), null)

const ticket = auth.issue('Eric', t0)
eq('派工後沒帶票：仍擋（沒有剛派工退路）', auth.authorize({ userLabel: 'Eric' }, t0), null)
eq('偽造票：擋', auth.authorize({ userLabel: 'Eric', startTicket: 'deadbeef' }, t0), null)
eq('票配別的帳號：擋', auth.authorize({ userLabel: 'Amy', startTicket: ticket }, t0), null)
eq('正確票', auth.authorize({ userLabel: 'Eric', startTicket: ticket }, t0), 'ticket')
eq('票只能用一次', auth.authorize({ userLabel: 'Eric', startTicket: ticket }, t0), null)

const late = auth.issue('Eric', t0)
eq('票過期', auth.authorize({ userLabel: 'Eric', startTicket: late }, t0 + START_GRANT_TTL_MS + 1), null)

sessions['agent-1-abc'] = { id: 'agent-1-abc', userLabel: 'Eric', status: 'running', lastHeartbeat: t0 }
eq('重連：id 完全相符', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-1-abc' }, t0 + 1000), 'reconnect')
eq('重連：亂填 id（查找會退回最新一筆）也要擋', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-guess' }, t0 + 1000), null)
eq('重連：沒帶 prevSessionId', auth.authorize({ userLabel: 'Eric', reconnect: true }, t0 + 1000), null)
eq('重連：別人的 session', auth.authorize({ userLabel: 'Amy', reconnect: true, prevSessionId: 'agent-1-abc' }, t0 + 1000), null)
eq('重連：心跳太舊', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-1-abc' }, t0 + START_GRANT_TTL_MS + 1), null)
sessions['agent-2-def'] = { id: 'agent-2-def', userLabel: 'Eric', status: 'stopped', lastHeartbeat: t0 }
eq('重連：已停止', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-2-def' }, t0 + 1000), null)
sessions['agent-3-ghi'] = { id: 'agent-3-ghi', userLabel: 'Eric', status: 'running', stopRequested: true, lastHeartbeat: t0 }
eq('重連：要求停止中', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-3-ghi' }, t0 + 1000), null)

console.log(`autospin-start-auth: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

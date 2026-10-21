/**
 * AutoSpin 啟動授權的回歸。跑法：npx tsx server/autospin-start-auth.test.ts
 */
import { createAgentStartAuth, START_GRANT_TTL_MS } from './autospin-start-auth.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (got === want) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const sessions: Record<string, { userLabel: string; status: string; stopRequested?: boolean; lastHeartbeat: number }> = {}
const auth = createAgentStartAuth(id => (id ? sessions[id] ?? null : null))
const t0 = 1_000_000_000

eq('沒派工、沒票：擋', auth.authorize({ userLabel: 'Eric' }, t0), null)
eq('自報別人名字：擋', auth.authorize({ userLabel: 'Amy' }, t0), null)

const ticket = auth.issue('Eric', t0)
eq('偽造票：擋（不退回剛派工）', auth.authorize({ userLabel: 'Eric', startTicket: 'deadbeef' }, t0), null)
eq('票配別的帳號：擋', auth.authorize({ userLabel: 'Amy', startTicket: ticket }, t0), null)
eq('正確票', auth.authorize({ userLabel: 'Eric', startTicket: ticket }, t0), 'ticket')
eq('票只能用一次', auth.authorize({ userLabel: 'Eric', startTicket: ticket }, t0), null)
eq('用過票後剛派工也一起失效', auth.authorize({ userLabel: 'Eric' }, t0), null)

auth.issue('Eric', t0)
eq('舊 agent 沒帶票：剛派工可以', auth.authorize({ userLabel: 'Eric' }, t0 + 1000), 'dispatch')
eq('剛派工只能用一次', auth.authorize({ userLabel: 'Eric' }, t0 + 2000), null)

const late = auth.issue('Eric', t0)
eq('票過期', auth.authorize({ userLabel: 'Eric', startTicket: late }, t0 + START_GRANT_TTL_MS + 1), null)
eq('剛派工過期', auth.authorize({ userLabel: 'Eric' }, t0 + START_GRANT_TTL_MS + 1), null)

sessions['agent-1-abc'] = { userLabel: 'Eric', status: 'running', lastHeartbeat: t0 }
eq('重連：session 對得上', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-1-abc' }, t0 + 1000), 'reconnect')
eq('重連：沒帶 prevSessionId', auth.authorize({ userLabel: 'Eric', reconnect: true }, t0 + 1000), null)
eq('重連：別人的 session', auth.authorize({ userLabel: 'Amy', reconnect: true, prevSessionId: 'agent-1-abc' }, t0 + 1000), null)
eq('重連：不存在', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-x' }, t0 + 1000), null)
eq('重連：心跳太舊', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-1-abc' }, t0 + START_GRANT_TTL_MS + 1), null)
sessions['agent-2-def'] = { userLabel: 'Eric', status: 'stopped', lastHeartbeat: t0 }
eq('重連：已停止', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-2-def' }, t0 + 1000), null)
sessions['agent-3-ghi'] = { userLabel: 'Eric', status: 'running', stopRequested: true, lastHeartbeat: t0 }
eq('重連：要求停止中', auth.authorize({ userLabel: 'Eric', reconnect: true, prevSessionId: 'agent-3-ghi' }, t0 + 1000), null)

console.log(`autospin-start-auth: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

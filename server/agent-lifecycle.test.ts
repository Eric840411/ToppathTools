/**
 * Agent 連線生命週期。跑法：npx tsx server/agent-lifecycle.test.ts
 * CodeX 2026-10-06 的驗收範圍：close／ready 兩種順序、重複收尾、舊訊息晚到、多 agent 取消。
 */
import type { AgentInfo } from './agent-hub.js'
import { abortMachineTestSession, createAgentLifecycle } from './agent-lifecycle.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const mk = (agentId: string, tag: string, sessionId: string | null = null): AgentInfo => ({
  ws: { terminate() { (this as { terminated?: boolean }).terminated = true } } as never,
  agentId, hostname: `${agentId}-${tag}`, ownerKey: 'k', ownerName: 'n', tokenId: 't', capabilities: ['machine-test'],
  connectedAt: 0, lastSeenAt: 0, busy: !!sessionId, sessionId,
})
function setup() {
  const connections = new Map<string, AgentInfo>()
  const lost: Array<{ host: string; session: string | null; reason: string }> = []
  const life = createAgentLifecycle({ connections, onLost: (info, reason) => lost.push({ host: info.hostname, session: info.sessionId, reason }) })
  return { connections, lost, life }
}

// ── 正式站那次的順序：重連（ready）先到、舊 close 後到 ──
{
  const { connections, lost, life } = setup()
  const old = mk('A', 'old'); life.register(old)
  old.sessionId = 'mt_1'; old.busy = true          // 派工時改的就是這個物件
  const neu = mk('A', 'new'); life.register(neu)   // 5 秒後重連
  eq('ready 先到：舊連線手上的 session 被收尾（用舊 info 的 sessionId）', lost.map(l => [l.host, l.session]), [['A-old', 'mt_1']])
  eq('ready 先到：舊 socket 被 terminate', (old.ws as unknown as { terminated?: boolean }).terminated, true)
  eq('ready 先到：map 裡是新連線', connections.get('A') === neu, true)
  life.closed(old)                                 // 舊 socket 的 close 晚到
  eq('舊 close 晚到：不重複收尾', lost.length, 1)
  eq('舊 close 晚到：不會把新連線從 map 刪掉', connections.get('A') === neu, true)
}

// ── 一般順序：close 先到、再重連 ──
{
  const { connections, lost, life } = setup()
  const old = mk('B', 'old', 'mt_2'); life.register(old)
  life.closed(old)
  eq('close 先到：收尾一次、map 清掉', [lost.map(l => l.session), connections.has('B')], [['mt_2'], false])
  const neu = mk('B', 'new'); life.register(neu)
  eq('之後重連：不會再收尾一次', lost.length, 1)
  life.closed(old)
  eq('同一個舊 info 再 close 一次：仍只收尾一次', lost.length, 1)
}

// ── 舊連線晚到的訊息不算數 ──
{
  const { life } = setup()
  const old = mk('C', 'old'); life.register(old); old.sessionId = 'mt_3'
  eq('目前的連線、手上的 session → 算數', life.ownsSession(old, 'mt_3'), true)
  eq('別的 session → 不算數', life.ownsSession(old, 'mt_x'), false)
  const neu = mk('C', 'new'); life.register(neu)
  eq('被重連取代後，舊連線的 job_done／agent_done／claim_job → 不算數', life.ownsSession(old, 'mt_3'), false)
  eq('新連線還沒被派工 → 舊 session 的訊息也不算它的', life.ownsSession(neu, 'mt_3'), false)
  eq('沒有 info（還沒 agent_ready）→ 不算數', life.ownsSession(null, 'mt_3'), false)
}

// ── 機台測試中斷：整個 session 取消（多 agent）──
{
  const events: Array<{ type: string; message: string; statuses?: unknown[] }> = []
  const stopped: string[] = []
  const stopFns = ['A', 'B'].map(id => () => stopped.push(id))      // 兩台 agent 都參與
  let runnerAlive = true
  abortMachineTestSession('mt_9', 'Agent A 已斷線', {
    abortQueue: () => [{ machineCode: '0214', state: 'failed' }, { machineCode: '0215', state: 'failed' }],
    stopRunner: () => { if (!runnerAlive) return false; runnerAlive = false; stopFns.forEach(f => f()); return true },
    broadcast: ev => events.push(ev),
  })
  eq('停掉所有參與的 agent', stopped, ['A', 'B'])
  eq('沒跑完的機台標失敗並廣播佇列', events[0]?.type === 'queue_update' && (events[0].statuses as Array<{ state: string }>).every(s => s.state === 'failed'), true)
  eq('廣播錯誤與 session 結束（畫面不會卡在執行中）', events.slice(1).map(e => e.type), ['error', 'session_done'])
  // session 已經被手動 stop 過：abortQueue 回 null、stopRunner 回 false，照樣只廣播結束、不報錯
  const ev2: string[] = []
  abortMachineTestSession('mt_9', 'x', { abortQueue: () => null, stopRunner: () => false, broadcast: e => ev2.push(e.type) })
  eq('session 已不在 → 不廣播佇列，只通知結束', ev2, ['error', 'session_done'])
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

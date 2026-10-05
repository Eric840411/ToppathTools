/**
 * 撤銷 token 時的斷線處理。跑法：npx tsx server/agent-token-disconnect.test.ts
 * 守的是「close handler 要靠連線表裡的 sessionId 收任務」——在它跑之前把表刪掉，任務就沒人收。
 */
import { disconnectAgentsByToken, type TokenAgent } from './agent-token-disconnect.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }

/** 假 socket：close() 之後先變 CLOSING，handler 晚一點才跑（模擬真實的延遲 close） */
function agent(tokenId: string, state = WS.OPEN) {
  const calls: number[] = []
  const ws = { ...WS, readyState: state, close(code?: number) { calls.push(code ?? 0); ws.readyState = WS.CLOSING } }
  return { a: { tokenId, ws, sessionId: 'sess-' + tokenId } as TokenAgent & { sessionId: string }, calls }
}

{
  const m = new Map<string, TokenAgent>()
  const busy = agent('t1'); const other = agent('t2')
  m.set('A', busy.a); m.set('B', other.a)
  eq('只關被撤的那把', disconnectAgentsByToken(m, new Set(['t1'])), 1)
  eq('關的是 1008', busy.calls, [1008])
  eq('沒被撤的不動', other.calls, [])
  eq('關了但還沒觸發 close handler 前，連線表要留著（handler 要讀 sessionId）', m.has('A'), true)
  // 連續撤銷：第一次已經進 CLOSING、handler 還沒跑，又撤一次
  eq('CLOSING 時再撤一次：不重複 close', disconnectAgentsByToken(m, new Set(['t1'])), 0)
  eq('CLOSING 時再撤一次：連線表照樣留著', m.has('A') && (m.get('A') as { sessionId: string }).sessionId, 'sess-t1')
  // close handler 跑完會自己刪
  m.delete('A')
  eq('handler 刪掉之後再撤：沒事發生', disconnectAgentsByToken(m, new Set(['t1'])), 0)
}
{
  const m = new Map<string, TokenAgent>()
  const stale = agent('t3', WS.CLOSED)
  m.set('C', stale.a)
  eq('早就 CLOSED 的殘留：清掉、不呼叫 close', [disconnectAgentsByToken(m, new Set(['t3'])), m.has('C'), stale.calls.length], [0, false, 0])
}
{
  const m = new Map<string, TokenAgent>()
  const conn = agent('t4', WS.CONNECTING)
  m.set('D', conn.a)
  eq('CONNECTING 也要關', disconnectAgentsByToken(m, new Set(['t4'])), 1)
  m.set('E', { tokenId: null, ws: agent('x').a.ws })
  eq('沒有 tokenId 的連線不碰', disconnectAgentsByToken(m, new Set(['t4'])), 0)
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

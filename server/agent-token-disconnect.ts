/**
 * 撤銷 Local Agent token 時，斷掉用那些 token 連進來的 agent。
 *
 * ⚠️ **只關 socket，不在這裡刪連線表**：worker 的 ws close handler（worker.ts 的 `ws.on('close')`）
 *    要靠表裡的 sessionId 收掉進行中的機測／UAT／錄製。先刪的話那些任務就成了沒人收的殘骸（CodeX review）。
 * ⚠️ **CLOSING 也不能刪**：連線正在關的時候又撤一次，close handler 還沒跑，刪了它就拿不到 sessionId。
 *    只有已經 CLOSED、卻還留在表裡的殘留才在這裡刪（那種 close handler 已經跑過或永遠不會跑）。
 * 純函式（傳入連線表），測試直接打這裡：npx tsx server/agent-token-disconnect.test.ts
 */
export type DisconnectableSocket = { readyState: number; OPEN: number; CONNECTING: number; CLOSING: number; CLOSED: number; close(code?: number, reason?: string): void }
export type TokenAgent = { tokenId?: string | null; ws: DisconnectableSocket }

export function disconnectAgentsByToken(connections: Map<string, TokenAgent>, tokenIds: Set<string>): number {
  let closed = 0
  for (const [agentId, agent] of connections.entries()) {
    if (!agent.tokenId || !tokenIds.has(agent.tokenId)) continue
    const s = agent.ws.readyState
    if (s === agent.ws.OPEN || s === agent.ws.CONNECTING) { agent.ws.close(1008, 'Agent token revoked'); closed++ }
    else if (s === agent.ws.CLOSED) connections.delete(agentId)
    // CLOSING：什麼都不做，交給 close handler
  }
  return closed
}

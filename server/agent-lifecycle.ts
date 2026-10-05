/**
 * Agent 連線的生命週期（v5.12.4，CodeX 2026-10-06 同意）。
 *
 * ## 為什麼要有這層（正式站 2026-10-06 01:05 實際發生）
 * agent 跑機台測試到一半斷線（1006），5 秒後用**同一個 agentId** 重連：
 * 1. 新連線的 `agent_ready` 直接 `agentConnections.set(agentId, 新 info)` 覆蓋——舊連線手上的 sessionId 就不見了
 * 2. 舊 socket 的 close 比重連晚到，讀 map 拿到的是**新** info（沒有 sessionId）→ 不取消 session，
 *    還把**新**連線從 map 刪掉
 * 結果機台 0214 卡在 running 40 分鐘，要人手動 stop。
 *
 * ## 規則
 * - 每條 socket 持有**自己的** AgentInfo（派工、完成時更新的就是這個物件），收尾一律看它，不讀 map
 * - 收尾（onLost）**每個 AgentInfo 只做一次**：重連時與舊 socket 晚到的 close 走同一個入口
 * - close 只在 map 裡還是自己時才刪 map
 * - 舊連線晚到的 claim_job／job_done／agent_done 一律不算數（`ownsSession`）
 *
 * 純邏輯、相依從外面傳入，測試：npx tsx server/agent-lifecycle.test.ts
 */
import type { AgentInfo } from './agent-hub.js'

type Lifecycle = {
  /** 新連線驗證成功後呼叫：同一個 agentId 還掛著舊連線 → 先把舊的當成斷線收尾，再登記新的 */
  register(info: AgentInfo): void
  /** socket close 時呼叫（帶這條 socket 自己的 info） */
  closed(info: AgentInfo): void
  /** 這條 socket 還是這個 agentId 目前的連線嗎 */
  isCurrent(info: AgentInfo | null | undefined): boolean
  /** 這條 socket 是目前的連線、而且手上就是這個 session（舊連線晚到的訊息不算數） */
  ownsSession(info: AgentInfo | null | undefined, sessionId: string): boolean
}

export function createAgentLifecycle(deps: {
  connections: Map<string, AgentInfo>
  /** 斷線收尾（UAT、AutoSpin 下注、機台測試各自的規則都在這裡面）。每個 info 只會被呼叫一次 */
  onLost: (info: AgentInfo, reason: string) => void
}): Lifecycle {
  const handled = new WeakSet<AgentInfo>()
  const lost = (info: AgentInfo, reason: string) => {
    if (handled.has(info)) return
    handled.add(info)
    deps.onLost(info, reason)
  }
  const isCurrent = (info: AgentInfo | null | undefined) => !!info && deps.connections.get(info.agentId) === info
  return {
    register(info) {
      const prev = deps.connections.get(info.agentId)
      if (prev && prev !== info) {
        lost(prev, `Agent ${prev.hostname} 重新連線，舊連線已中斷`)
        try { prev.ws.terminate() } catch { /* 已經關了 */ }
      }
      deps.connections.set(info.agentId, info)
    },
    closed(info) {
      lost(info, `Agent ${info.hostname} 已斷線`)
      if (deps.connections.get(info.agentId) === info) deps.connections.delete(info.agentId)
    },
    isCurrent,
    ownsSession: (info, sessionId) => isCurrent(info) && !!sessionId && info!.sessionId === sessionId,
  }
}

/**
 * 機台測試 session 因為 agent 斷線而中斷：**整個 session 取消**（維持既有斷線語意，CodeX：只讓那台失敗、其他繼續是另一項行為改動）。
 * 原本的斷線收尾只刪佇列（cancelDistSession），漏了：停止其他參與的 agent、釋放重任務鎖（finishHeavyTask）、
 * 把沒跑完的機台標成失敗、通知畫面——畫面會一直顯示「執行中」。
 */
export function abortMachineTestSession(sessionId: string, reason: string, deps: {
  /** 把佇列裡沒跑完的機台標成失敗並刪掉 session；回傳最後的狀態（session 已經不在就回 null） */
  abortQueue: (sessionId: string) => unknown[] | null
  /** activeRunners 裡這個 session 的 stop（會送 stop 給所有參與的 agent、釋放重任務鎖、從 activeRunners 移除） */
  stopRunner: (sessionId: string) => boolean
  broadcast: (ev: { type: string; message: string; statuses?: unknown[]; ts: string }) => void
}) {
  const ts = new Date().toISOString()
  const statuses = deps.abortQueue(sessionId)
  if (statuses) deps.broadcast({ type: 'queue_update', statuses, message: '', ts })
  deps.stopRunner(sessionId)
  deps.broadcast({ type: 'error', message: reason, ts })
  deps.broadcast({ type: 'session_done', message: `機台測試已中斷：${reason}`, ts })
}

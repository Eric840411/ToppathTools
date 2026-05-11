/**
 * server/agent-hub.ts
 * Shared state for distributed machine test execution.
 *  - Viewer broadcast: push events to all connected browser clients
 *  - Agent pool: track connected worker agents
 *  - Distributed session tracking: work-stealing job queue per session
 */
import type { WebSocket } from 'ws'
import type { TestEvent, JobStatus } from './machine-test/types.js'

// ─── Viewer Broadcast ─────────────────────────────────────────────────────────

/** All browser clients watching the test progress */
export const viewerSockets = new Set<WebSocket>()

/** Buffered events for the current session — replayed to late-joining viewers */
export const broadcastBuffer: TestEvent[] = []
const BROADCAST_BUFFER_MAX = 2000

export function broadcastToViewers(ev: TestEvent) {
  broadcastBuffer.push(ev)
  // Cap buffer size to prevent unbounded memory growth
  if (broadcastBuffer.length > BROADCAST_BUFFER_MAX) {
    broadcastBuffer.splice(0, broadcastBuffer.length - BROADCAST_BUFFER_MAX)
  }
  for (const ws of viewerSockets) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev))
    else viewerSockets.delete(ws) // evict dead sockets
  }
}

export function clearBroadcastBuffer() {
  broadcastBuffer.length = 0
}

// ─── Agent Pool ───────────────────────────────────────────────────────────────

export interface AgentInfo {
  ws: WebSocket
  agentId: string
  hostname: string
  busy: boolean
  sessionId: string | null
}

export const agentConnections = new Map<string, AgentInfo>()

export function getAvailableAgents(): AgentInfo[] {
  return [...agentConnections.values()].filter(a => !a.busy)
}

// ─── Work-Stealing Job Queue ──────────────────────────────────────────────────

export { type JobStatus }

class JobQueue {
  private jobs: Map<string, JobStatus> = new Map()
  private order: string[] = []

  constructor(codes: string[]) {
    for (const code of codes) {
      this.jobs.set(code, { machineCode: code, state: 'pending' })
      this.order.push(code)
    }
  }

  /** Claim the next pending job for the given agent. Returns null when queue is empty. */
  claim(agentId: string): string | null {
    for (const code of this.order) {
      const job = this.jobs.get(code)!
      if (job.state === 'pending') {
        job.state = 'running'
        job.agentId = agentId
        job.startedAt = Date.now()
        return code
      }
    }
    return null
  }

  /** Mark a previously claimed job as done or failed. */
  complete(machineCode: string, failed = false) {
    const job = this.jobs.get(machineCode)
    if (job && job.state === 'running') {
      job.state = failed ? 'failed' : 'done'
      job.finishedAt = Date.now()
    }
  }

  isAllDone(): boolean {
    return [...this.jobs.values()].every(j => j.state === 'done' || j.state === 'failed')
  }

  getStatuses(): JobStatus[] {
    return this.order.map(c => ({ ...this.jobs.get(c)! }))
  }
}

// ─── Distributed Session Tracking ────────────────────────────────────────────

interface DistSession {
  jobQueue: JobQueue
  onAllDone: () => void
}

const distSessions = new Map<string, DistSession>()

export function registerDistSession(sessionId: string, codes: string[], onAllDone: () => void) {
  distSessions.set(sessionId, { jobQueue: new JobQueue(codes), onAllDone })
}

/**
 * Agent requests the next machine to test. Returns the machine code, or null if queue is exhausted.
 */
export function claimJob(sessionId: string, agentId: string): string | null {
  return distSessions.get(sessionId)?.jobQueue.claim(agentId) ?? null
}

/**
 * Agent reports a machine test as done/failed.
 * Returns true if this was the last job (session complete).
 */
export function completeJob(sessionId: string, machineCode: string, failed = false): boolean {
  const s = distSessions.get(sessionId)
  if (!s) return false
  s.jobQueue.complete(machineCode, failed)
  if (s.jobQueue.isAllDone()) {
    s.onAllDone()
    distSessions.delete(sessionId)
    return true
  }
  return false
}

/** Get current queue statuses for a session (for UI display). */
export function getJobStatuses(sessionId: string): JobStatus[] | null {
  return distSessions.get(sessionId)?.jobQueue.getStatuses() ?? null
}

export function cancelDistSession(sessionId: string) {
  distSessions.delete(sessionId)
}

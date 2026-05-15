/**
 * server/agent-runner.ts
 * Standalone worker agent — connects to central server via WebSocket,
 * joins a session, then claims machines one at a time (work-stealing),
 * runs each locally, and reports events back.
 *
 * Usage (on worker machine, from project root):
 *   CENTRAL_URL=ws://192.168.1.100:3000 node dist/server/agent-runner.js
 *
 * Optional env vars:
 *   CENTRAL_URL    WebSocket URL of the central server (default: ws://localhost:3000)
 *   AGENT_LABEL    Display name for this agent (default: machine hostname)
 *   AGENT_OWNER_KEY   Operator key this agent belongs to
 *   AGENT_OWNER_NAME  Operator display name
 *   AGENT_TOKEN       Local Agent registration token
 *   AGENT_CAPABILITIES Comma-separated capability list (default: machine-test,scripted-bet)
 *   GEMINI_API_KEY Gemini API key for CCTV vision test (optional)
 */
import WebSocket from 'ws'
import { hostname } from 'os'
import { MachineTestRunner } from './machine-test/runner.js'
import type { MachineTestSession, MachineProfile, TestEvent } from './machine-test/types.js'
import { ScriptedBetRunner } from './scripted-bet/runner.js'
import type { ScriptedBetAccount, ScriptedBetConfig, ScriptedBetEvent } from './scripted-bet/types.js'

const CENTRAL_URL = (process.env.CENTRAL_URL ?? 'ws://localhost:3000').trim().replace(/\/$/, '')
const AGENT_LABEL = process.env.AGENT_LABEL ?? hostname()
const AGENT_ID = `${AGENT_LABEL}_${process.pid}`
const AGENT_OWNER_KEY = (process.env.AGENT_OWNER_KEY ?? '').trim()
const AGENT_OWNER_NAME = (process.env.AGENT_OWNER_NAME ?? AGENT_OWNER_KEY).trim()
const AGENT_TOKEN = (process.env.AGENT_TOKEN ?? '').trim()
const AGENT_CAPABILITIES = (process.env.AGENT_CAPABILITIES ?? 'machine-test,scripted-bet')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const AGENT_VERSION = '2026-05-agent-owner-v1'

let currentRunner: { stop: () => void } | null = null

interface SessionJoinMessage {
  type: 'session_join'
  sessionId: string
  /** Base session config — machineCodes is empty; agent claims codes via claim_job */
  session: MachineTestSession
  profiles: MachineProfile[]
  betRandomConfig: Record<string, string[]>
  osmMachineStatus: [string, number][]
  geminiKey?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
}

interface ScriptedBetStartMessage {
  type: 'scripted_bet_start'
  sessionId: string
  accounts: ScriptedBetAccount[]
  config: ScriptedBetConfig
}

type IncomingMessage =
  | SessionJoinMessage
  | ScriptedBetStartMessage
  | { type: 'job_assigned'; machineCode: string }
  | { type: 'no_more_jobs' }
  | { type: 'stop' }
  | { type: string }

/** Promise resolve for the pending claim_job → job_assigned/no_more_jobs round-trip */
let pendingClaimResolve: ((code: string | null) => void) | null = null

/** Live OSM machine status — updated in real-time by server pushes */
const currentOsmMap = new Map<string, number>()

function connect() {
  const url = `${CENTRAL_URL}/ws/agent`
  console.log(`[Agent:${AGENT_LABEL}] Connecting to ${url} ...`)
  const ws = new WebSocket(url)

  ws.on('open', () => {
    console.log(`[Agent:${AGENT_LABEL}] Connected — ready`)
    ws.send(JSON.stringify({
      type: 'agent_ready',
      agentId: AGENT_ID,
      hostname: AGENT_LABEL,
      operatorKey: AGENT_OWNER_KEY,
      operatorName: AGENT_OWNER_NAME,
      agentToken: AGENT_TOKEN,
      capabilities: AGENT_CAPABILITIES,
      version: AGENT_VERSION,
    }))
  })

  ws.on('message', async (raw) => {
    let msg: IncomingMessage
    try { msg = JSON.parse(raw.toString()) } catch { return }

    // ── Server response: next machine to test ──────────────────────────────────
    // ── Live OSM status push from server ──────────────────────────────────────
    if (msg.type === 'osm_status_update') {
      const updates = (msg as { type: 'osm_status_update'; updates: { machineId: string; status: number }[] }).updates
      if (Array.isArray(updates)) {
        for (const { machineId, status } of updates) {
          currentOsmMap.set(machineId, status)
        }
      }
      return
    }

    if (msg.type === 'job_assigned') {
      pendingClaimResolve?.((msg as { type: 'job_assigned'; machineCode: string }).machineCode)
      pendingClaimResolve = null
      return
    }

    if (msg.type === 'no_more_jobs') {
      pendingClaimResolve?.(null)
      pendingClaimResolve = null
      return
    }

    // ── Stop: kill current runner immediately ─────────────────────────────────
    if (msg.type === 'stop') {
      console.log(`[Agent:${AGENT_LABEL}] Stop requested`)
      currentRunner?.stop()
      // Abort any pending claim
      pendingClaimResolve?.(null)
      pendingClaimResolve = null
      return
    }

    // ── Session join: start claim-loop for the given session ──────────────────
    if (msg.type === 'scripted_bet_start') {
      const { sessionId, accounts, config } = msg as ScriptedBetStartMessage
      console.log(`[Agent:${AGENT_LABEL}] Scripted Bet session ${sessionId} started (${accounts.length} accounts)`)
      const runner = new ScriptedBetRunner(sessionId, accounts, config)
      currentRunner = runner

      runner.on('event', (ev: ScriptedBetEvent) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'scripted_bet_event', sessionId, event: ev }))
        }
      })

      runner.run()
        .catch(err => {
          console.error(`[Agent:${AGENT_LABEL}] Scripted Bet ${sessionId} error:`, err)
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'scripted_bet_event',
              sessionId,
              event: {
                type: 'error',
                sessionId,
                status: 'stopped',
                message: String(err),
                ts: new Date().toISOString(),
              } satisfies ScriptedBetEvent,
            }))
          }
        })
        .finally(() => {
          if (currentRunner === runner) currentRunner = null
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'scripted_bet_done', sessionId }))
          }
        })
      return
    }

    if (msg.type === 'session_join') {
      const { sessionId, session, profiles, betRandomConfig, osmMachineStatus, geminiKey, ollamaBaseUrl, ollamaModel } = msg as SessionJoinMessage

      // Configure AI/runtime env vars
      if (geminiKey) process.env.GEMINI_API_KEY = geminiKey
      if (ollamaBaseUrl) process.env.OLLAMA_BASE_URL = ollamaBaseUrl
      if (ollamaModel) process.env.OLLAMA_MODEL = ollamaModel
      if (session.cctvModelSpec) process.env.CCTV_MODEL_SPEC = session.cctvModelSpec
      else delete process.env.CCTV_MODEL_SPEC

      // Seed the module-level osmMap with the session snapshot; live updates will keep it current
      currentOsmMap.clear()
      for (const [k, v] of osmMachineStatus) currentOsmMap.set(k, v)
      const profileMap = new Map<string, MachineProfile>(profiles.map(p => [p.machineType, p]))

      console.log(`[Agent:${AGENT_LABEL}] Joined session ${sessionId} — starting claim-loop`)

      const runClaimLoop = async () => {
        while (true) {
          // Request the next available machine from the central queue
          const code = await new Promise<string | null>((resolve) => {
            pendingClaimResolve = resolve
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'claim_job', sessionId }))
            } else {
              resolve(null)
            }
          })

          if (!code) break  // no_more_jobs or WS closed

          console.log(`[Agent:${AGENT_LABEL}] Claimed machine: ${code}`)
          let failed = false

          try {
            // Create a fresh runner for each machine (avoids stale state)
            const runner = new MachineTestRunner(currentOsmMap, profileMap, betRandomConfig)
            currentRunner = runner

            runner.on('event', (ev: TestEvent) => {
              // Filter out session lifecycle events — central server manages these directly
              if (ev.type === 'session_done') return   // server emits unified session_done
              if (ev.type === 'session_start') return  // each machine run() sends one; would clear viewer results
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'event', sessionId, event: ev }))
              }
            })

            // Agent always runs headless — ignore headedMode from main UI
            await runner.run({ ...session, sessionId, machineCodes: [code], headedMode: session.headedMode === true })
          } catch (err) {
            console.error(`[Agent:${AGENT_LABEL}] Machine ${code} error:`, err)
            failed = true
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'event',
                sessionId,
                event: {
                  type: 'error',
                  message: `機台 ${code} 執行錯誤：${String(err)}`,
                  ts: new Date().toISOString(),
                } as TestEvent,
              }))
            }
          } finally {
            currentRunner = null
          }

          // Report this machine's result to the central queue
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'job_done', sessionId, machineCode: code, failed }))
          }
        }

        // Claim-loop exhausted — signal done and release agent slot
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
        }
        console.log(`[Agent:${AGENT_LABEL}] No more jobs — session ${sessionId} complete`)
      }

      runClaimLoop().catch(err => {
        console.error(`[Agent:${AGENT_LABEL}] Claim loop error:`, err)
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
        }
      })
    }
  })

  ws.on('close', (code) => {
    console.log(`[Agent:${AGENT_LABEL}] Disconnected (code=${code}), reconnecting in 5s ...`)
    currentRunner = null
    // Abort any in-flight claim
    pendingClaimResolve?.(null)
    pendingClaimResolve = null
    setTimeout(connect, 5000)
  })

  ws.on('error', (err) => {
    console.error(`[Agent:${AGENT_LABEL}] WS error:`, err.message)
  })
}

connect()

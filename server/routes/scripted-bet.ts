import { Router } from 'express'
import { z } from 'zod'
import { addHistory } from '../shared.js'
import { ScriptedBetRunner } from '../scripted-bet/runner.js'
import { agentConnections, getAvailableAgents, type AgentInfo } from '../agent-hub.js'
import type { ScriptedBetAccount, ScriptedBetAccountStatus, ScriptedBetConfig, ScriptedBetEvent } from '../scripted-bet/types.js'
import { getOperatorFromContext, type OperatorInfo } from '../request-context.js'

export const router = Router()

const accountSchema = z.object({
  account: z.string().min(1),
  username: z.string().min(1),
  label: z.string().optional().default(''),
  url: z.string().url(),
})

const startSchema = z.object({
  accounts: z.array(accountSchema).min(1),
  agentId: z.string().optional().default(''),
  targetMachineCode: z.string().min(1),
  spinMin: z.number().int().min(1).max(999),
  spinMax: z.number().int().min(1).max(999),
  spinDelayMinMs: z.number().int().min(0).max(60_000).default(800),
  spinDelayMaxMs: z.number().int().min(0).max(60_000).default(1500),
  maxExitRetries: z.number().int().min(1).max(50).default(5),
  exitFailTouchPoints: z.array(z.string().min(1)).optional().default([]),
  headedMode: z.boolean().optional().default(true),
})

type SseClient = import('express').Response

type ScriptedBetRunState = 'running' | 'done' | 'stopped' | 'error'

type ScriptedBetRunnerLike = {
  snapshot: () => ScriptedBetAccountStatus[]
  stop: () => void
}

interface ActiveSession {
  runner: ScriptedBetRunnerLike
  events: ScriptedBetEvent[]
  clients: Set<SseClient>
  accounts: ScriptedBetAccount[]
  config: ScriptedBetConfig
  operator?: OperatorInfo
  agentId?: string
  createdAt: number
  updatedAt: number
  runState: ScriptedBetRunState
  historySaved: boolean
}

const activeSessions = new Map<string, ActiveSession>()

function createInitialStatuses(accounts: ScriptedBetAccount[], targetMachineCode: string): ScriptedBetAccountStatus[] {
  return accounts.map(account => ({
    account: account.account,
    username: account.username,
    label: account.label,
    state: 'pending',
    targetMachineCode,
    spinDone: 0,
    exitAttempts: 0,
    message: 'pending',
  }))
}

function createAgentRunner(agent: AgentInfo, sessionId: string, statuses: ScriptedBetAccountStatus[]): ScriptedBetRunnerLike {
  return {
    snapshot: () => statuses,
    stop: () => {
      if (agent.ws.readyState === agent.ws.OPEN) {
        agent.ws.send(JSON.stringify({ type: 'stop', sessionId }))
      }
    },
  }
}

function saveSessionHistory(sessionId: string, session: ActiveSession) {
  if (session.historySaved) return
  session.historySaved = true

  try {
    const statuses = session.runner.snapshot()
    const done = statuses.filter(row => row.state === 'done').length
    const failed = statuses.filter(row => row.state === 'failed' || row.state === 'skipped').length
    const stopped = statuses.filter(row => row.state === 'stopped').length
    const spinDone = statuses.reduce((sum, row) => sum + (row.spinDone ?? 0), 0)
    const exitAttempts = statuses.reduce((sum, row) => sum + (row.exitAttempts ?? 0), 0)
    const durationMs = Math.max(0, session.updatedAt - session.createdAt)
    const target = session.config.targetMachineCode
    const stateLabel = session.runState.toUpperCase()

    addHistory(
      'scripted-bet',
      `Scripted Bet - ${target}`,
      `${stateLabel}: accounts ${statuses.length}, done ${done}, failed ${failed}, stopped ${stopped}, spin ${spinDone}`,
      {
        sessionId,
        operator: session.operator,
        runState: session.runState,
        targetMachineCode: target,
        config: session.config,
        accounts: session.accounts.map(account => ({
          account: account.account,
          username: account.username,
          label: account.label,
        })),
        counts: {
          total: statuses.length,
          done,
          failed,
          stopped,
          spinDone,
          exitAttempts,
        },
        statuses,
        events: session.events.slice(-300),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        durationMs,
      },
      { operator: session.operator },
    )
  } catch (error) {
    console.warn('[scripted-bet] failed to save history', error)
  }
}

function updateRunState(session: ActiveSession, event: ScriptedBetEvent) {
  session.updatedAt = Date.now()
  if (event.statuses) {
    const current = session.runner.snapshot()
    current.splice(0, current.length, ...event.statuses)
  }
  if (event.type === 'session_done') {
    session.runState = event.status === 'stopped' ? 'stopped' : 'done'
  } else if (event.type === 'error') {
    session.runState = 'error'
  }
}

function broadcast(sessionId: string, event: ScriptedBetEvent) {
  const session = activeSessions.get(sessionId)
  if (!session) return
  updateRunState(session, event)
  session.events.push(event)
  if (session.events.length > 300) session.events.splice(0, session.events.length - 300)
  if (event.type === 'session_done' || event.type === 'error') {
    saveSessionHistory(sessionId, session)
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const client of session.clients) {
    try {
      client.write(payload)
    } catch {
      session.clients.delete(client)
    }
  }
}

export function handleScriptedBetAgentEvent(sessionId: string, event: ScriptedBetEvent) {
  broadcast(sessionId, event)
}

export function handleScriptedBetAgentDone(sessionId: string) {
  const session = activeSessions.get(sessionId)
  if (!session) return
  if (session.agentId) {
    const agent = agentConnections.get(session.agentId)
    if (agent?.sessionId === sessionId) {
      agent.busy = false
      agent.sessionId = null
    }
  }
  setTimeout(() => {
    const current = activeSessions.get(sessionId)
    if (!current || current.clients.size > 0) return
    activeSessions.delete(sessionId)
  }, 10 * 60_000).unref()
}

export function handleScriptedBetAgentDisconnect(sessionId: string, message: string) {
  const session = activeSessions.get(sessionId)
  if (!session) return
  broadcast(sessionId, {
    type: 'error',
    sessionId,
    status: 'stopped',
    message,
    statuses: session.runner.snapshot(),
    ts: new Date().toISOString(),
  })
  session.runState = 'error'
  saveSessionHistory(sessionId, session)
}

router.post('/api/scripted-bet/start', (req, res, next) => {
  try {
    const body = startSchema.parse(req.body)
    const sessionId = `sb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const operator = getOperatorFromContext()
    if (!operator?.key) {
      return res.status(401).json({ ok: false, message: 'login required' })
    }
    const existingSession = [...activeSessions.values()].find(session => session.operator?.key === operator.key && session.runState === 'running')
    if (existingSession) {
      return res.status(409).json({ ok: false, message: 'Scripted Bet is already running for current operator' })
    }
    const config: ScriptedBetConfig = {
      targetMachineCode: body.targetMachineCode.trim(),
      spinMin: body.spinMin,
      spinMax: body.spinMax,
      spinDelayMinMs: Math.min(body.spinDelayMinMs, body.spinDelayMaxMs),
      spinDelayMaxMs: Math.max(body.spinDelayMinMs, body.spinDelayMaxMs),
      maxExitRetries: body.maxExitRetries,
      exitFailTouchPoints: body.exitFailTouchPoints,
      headedMode: body.headedMode,
    }

    const selectedAgentId = body.agentId.trim()
    const availableAgents = getAvailableAgents({
      operatorKey: operator.key,
      capability: 'scripted-bet',
      ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
    })
    const allowServerRunner = process.env.SCRIPTED_BET_ALLOW_SERVER_RUNNER === 'true'
    const agent = availableAgents[0]
    if (!agent && !allowServerRunner) {
      return res.status(409).json({
        ok: false,
        message: selectedAgentId
          ? 'Selected Scripted Bet Agent is not available'
          : 'No available Scripted Bet Agent for current operator',
      })
    }

    const statuses = createInitialStatuses(body.accounts, config.targetMachineCode)
    const runner = agent
      ? createAgentRunner(agent, sessionId, statuses)
      : new ScriptedBetRunner(sessionId, body.accounts, config)

    activeSessions.set(sessionId, {
      runner,
      events: [],
      clients: new Set(),
      accounts: body.accounts,
      config,
      operator,
      agentId: agent?.agentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runState: 'running',
      historySaved: false,
    })

    if (agent) {
      agent.busy = true
      agent.sessionId = sessionId
      agent.ws.send(JSON.stringify({
        type: 'scripted_bet_start',
        sessionId,
        accounts: body.accounts,
        config,
      }))
    } else if (runner instanceof ScriptedBetRunner) {
      runner.on('event', (event: ScriptedBetEvent) => broadcast(sessionId, event))
      void runner.run().finally(() => {
        setTimeout(() => {
          const session = activeSessions.get(sessionId)
          if (!session || session.clients.size > 0) return
          activeSessions.delete(sessionId)
        }, 10 * 60_000).unref()
      })
    }

    res.json({ ok: true, sessionId, mode: agent ? 'agent' : 'server', agentId: agent?.agentId, statuses: runner.snapshot() })
  } catch (error) {
    next(error)
  }
})

router.get('/api/scripted-bet/current', (_req, res) => {
  const operator = getOperatorFromContext()
  const sessions = [...activeSessions.entries()]
    .filter(([, session]) => operator?.key && session.operator?.key === operator.key)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
  const current = sessions.find(([, session]) => session.runState === 'running') ?? sessions[0]

  if (!current) {
    return res.json({ ok: true, session: null })
  }

  const [sessionId, session] = current
  res.json({
    ok: true,
    session: {
      sessionId,
      runState: session.runState,
      statuses: session.runner.snapshot(),
      events: session.events.slice(-300),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
  })
})

router.get('/api/scripted-bet/agents', (_req, res) => {
  const operator = getOperatorFromContext()
  if (!operator?.key) return res.json({ ok: true, agents: [] })
  const agents = [...agentConnections.values()]
    .filter(agent => agent.ownerKey === operator.key && agent.capabilities.includes('scripted-bet'))
    .map(agent => ({
      agentId: agent.agentId,
      hostname: agent.hostname,
      ownerName: agent.ownerName,
      capabilities: agent.capabilities,
      busy: agent.busy,
      connectedAt: agent.connectedAt,
      lastSeenAt: agent.lastSeenAt,
      sessionId: agent.sessionId,
    }))
  res.json({ ok: true, agents })
})

router.get('/api/scripted-bet/status/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ ok: false, message: 'session not found' })
  const operator = getOperatorFromContext()
  if (!operator?.key || session.operator?.key !== operator.key) return res.status(404).json({ ok: false, message: 'session not found' })
  res.json({ ok: true, statuses: session.runner.snapshot() })
})

router.get('/api/scripted-bet/events/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ ok: false, message: 'session not found' })
  const operator = getOperatorFromContext()
  if (!operator?.key || session.operator?.key !== operator.key) return res.status(404).json({ ok: false, message: 'session not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  session.clients.add(res)
  for (const event of session.events.slice(-50)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  req.on('close', () => {
    session.clients.delete(res)
  })
})

router.post('/api/scripted-bet/stop/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ ok: false, message: 'session not found' })
  const operator = getOperatorFromContext()
  if (!operator?.key || session.operator?.key !== operator.key) return res.status(404).json({ ok: false, message: 'session not found' })
  session.runner.stop()
  res.json({ ok: true })
})

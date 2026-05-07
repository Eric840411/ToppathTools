import type { Request } from 'express'
import { getAuthAccount } from './auth-session.js'
import { db } from './shared.js'

type HeavyTask = {
  id: string
  userKey: string
  userLabel: string
  type: string
  label: string
  startedAt: number
}

export type HeavyTaskToken = {
  id: string
  userKey: string
}

type HeavyTaskRow = {
  id: string
  user_key: string
  user_label: string
  type: string
  label: string
  status: string
  created_at: number
  started_at: number | null
  finished_at: number | null
  error: string | null
}

const activeTasks = new Map<string, HeavyTask>()

function workerUrl() {
  return (process.env.WORKER_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '')
}

function notifyWorker(path: string, payload: unknown) {
  fetch(`${workerUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1000),
  }).catch(() => {
    // Worker visibility is best-effort; task execution must not depend on it.
  })
}

function taskUser(req: Request): { key: string; label: string } {
  const account = getAuthAccount(req)
  if (account) return { key: account.email, label: account.label || account.email }

  const jiraEmail = req.headers['x-jira-email']
  if (typeof jiraEmail === 'string' && jiraEmail) return { key: jiraEmail, label: jiraEmail }

  const body = req.body as { account?: string; jiraEmail?: string } | undefined
  const bodyAccount = body?.account || body?.jiraEmail
  if (bodyAccount) return { key: bodyAccount, label: bodyAccount }

  return { key: req.ip ?? req.socket.remoteAddress ?? 'guest', label: 'guest' }
}

function toPublicTask(row: HeavyTaskRow) {
  return {
    id: row.id,
    userKey: row.user_key,
    userLabel: row.user_label,
    type: row.type,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

export function tryStartHeavyTask(
  req: Request,
  type: string,
  label: string,
): { ok: true; token: HeavyTaskToken } | { ok: false; task: HeavyTask } {
  const user = taskUser(req)
  const existing = activeTasks.get(user.key)
  if (existing) return { ok: false, task: existing }

  const now = Date.now()
  const task: HeavyTask = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    userKey: user.key,
    userLabel: user.label,
    type,
    label,
    startedAt: now,
  }
  activeTasks.set(user.key, task)
  db.prepare(`
    INSERT OR REPLACE INTO heavy_tasks
      (id, user_key, user_label, type, label, status, created_at, started_at, finished_at, error)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?, NULL, NULL)
  `).run(task.id, task.userKey, task.userLabel, task.type, task.label, now, now)
  notifyWorker('/internal/worker/tasks/start', task)
  return { ok: true, token: { id: task.id, userKey: user.key } }
}

export function finishHeavyTask(token: HeavyTaskToken | null | undefined) {
  if (!token) return
  const current = activeTasks.get(token.userKey)
  if (current?.id !== token.id) return
  activeTasks.delete(token.userKey)
  db.prepare("UPDATE heavy_tasks SET status = 'done', finished_at = ? WHERE id = ?").run(Date.now(), current.id)
  notifyWorker('/internal/worker/tasks/finish', {
    id: current.id,
    userKey: current.userKey,
    userLabel: current.userLabel,
    type: current.type,
    label: current.label,
    startedAt: current.startedAt,
    finishedAt: Date.now(),
  })
}

export function heavyTaskConflict(task: HeavyTask) {
  return {
    ok: false,
    code: 'HEAVY_TASK_RUNNING',
    message: `你目前已有重任務正在執行：${task.label}`,
    task: {
      id: task.id,
      type: task.type,
      label: task.label,
      status: 'running',
      startedAt: task.startedAt,
      userLabel: task.userLabel,
    },
  }
}

export function getHeavyTaskForRequest(req: Request) {
  const user = taskUser(req)
  const active = activeTasks.get(user.key)
  if (active) return active
  const row = db.prepare(`
    SELECT * FROM heavy_tasks
    WHERE user_key = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(user.key) as HeavyTaskRow | undefined
  return row ? toPublicTask(row) : null
}

export function getActiveHeavyTasks() {
  const rows = db.prepare(`
    SELECT * FROM heavy_tasks
    WHERE status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 100
  `).all() as HeavyTaskRow[]
  return rows.map(toPublicTask)
}

export function getRecentHeavyTasksForRequest(req: Request) {
  const user = taskUser(req)
  const rows = db.prepare(`
    SELECT * FROM heavy_tasks
    WHERE user_key = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(user.key) as HeavyTaskRow[]
  return rows.map(toPublicTask)
}
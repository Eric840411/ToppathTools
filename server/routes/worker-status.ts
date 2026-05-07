import { Router } from 'express'

export const router = Router()

const workerUrl = () => (process.env.WORKER_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '')

router.get('/api/worker/status', async (_req, res) => {
  const baseUrl = workerUrl()
  const started = Date.now()
  try {
    const [healthResponse, tasksResponse] = await Promise.all([
      fetch(`${baseUrl}/internal/worker/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${baseUrl}/internal/worker/tasks`, { signal: AbortSignal.timeout(2000) }),
    ])
    const data = await healthResponse.json().catch(() => null)
    const tasks = await tasksResponse.json().catch(() => null)
    if (!healthResponse.ok) {
      return res.status(502).json({
        ok: false,
        connected: false,
        workerUrl: baseUrl,
        latencyMs: Date.now() - started,
        message: `worker responded HTTP ${healthResponse.status}`,
        worker: data,
        tasks,
      })
    }
    return res.json({
      ok: true,
      connected: true,
      workerUrl: baseUrl,
      latencyMs: Date.now() - started,
      worker: data,
      tasks,
    })
  } catch (error) {
    return res.status(503).json({
      ok: false,
      connected: false,
      workerUrl: baseUrl,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

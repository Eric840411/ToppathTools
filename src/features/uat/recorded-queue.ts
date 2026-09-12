import type { MultiResult } from './MultiTcResults'
export type QueueEntry = { id: string; title: string; state: 'waiting' | 'running' | 'done' | 'error' | 'cancelled'; results: MultiResult[]; sessionId?: string; error?: string; durationMs?: number }
export async function queueRequest(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok || data.ok === false) throw new Error(data.message || data.error || '請求失敗')
  return data
}
export async function runRecordedQueue(entries: QueueEntry[], options: {
  agentId: string; dryRun: boolean; cancelled: () => boolean;
  update: (index: number, patch: Partial<QueueEntry>) => void;
  started: () => void;
  request?: typeof queueRequest; pause?: () => Promise<void>
}) {
  const request = options.request || queueRequest
  const pause = options.pause || (() => new Promise<void>(resolve => setTimeout(resolve, 1500)))
  for (let index = 0; index < entries.length; index++) {
    if (options.cancelled()) { options.update(index, { state: 'cancelled' }); continue }
    const entry = entries[index], startedAt = Date.now()
    try {
      const start = await request('/api/osm-uat/run', { recordedScriptId: entry.id, agentId: options.agentId || undefined, dryRun: options.dryRun })
      if (!start.sessionId) throw new Error('未取得執行編號，已停止後續派工；請確認即時日誌。')
      options.update(index, { state: 'running', sessionId: start.sessionId }); options.started()
      if (options.cancelled()) {
        const status = await request('/api/osm-uat/status')
        if (status.sessionId === start.sessionId && status.status === 'running') await request('/api/osm-uat/stop', {})
      }
      // Only a matching terminal session can advance the queue. Never use old results.
      while (true) {
        await pause()
        const status = await request('/api/osm-uat/status')
        if (status.sessionId !== start.sessionId) throw new Error('執行編號已改變，為避免混用其他測試結果，已停止佇列。')
        if (status.status === 'running') continue
        let found: { results: MultiResult[]; stopped?: boolean } | undefined
        for (let attempt = 0; attempt < 3 && !found; attempt++) {
          const data = await request(`/api/osm-uat/recorded-scripts/${entry.id}/results`)
          found = data.runs?.find((run: { runId: string }) => run.runId === start.sessionId)
          if (!found && attempt < 2) await pause()
        }
        if (options.cancelled() || found?.stopped) {
          options.update(index, { state: 'cancelled', results: found?.results || [], durationMs: Date.now() - startedAt })
          for (let next = index + 1; next < entries.length; next++) options.update(next, { state: 'cancelled' })
          return
        }
        if (!found) throw new Error('本次執行結束但沒有取得結果，已停止後續腳本。請查看即時日誌。')
        options.update(index, { state: 'done', results: found.results, durationMs: Date.now() - startedAt })
        break
      }
    } catch (error) {
      options.update(index, { state: 'error', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt })
      for (let next = index + 1; next < entries.length; next++) options.update(next, { state: 'cancelled' })
      return
    }
  }
}

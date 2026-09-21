import type { MultiResult } from './MultiTcResults'
import { runScriptQueue, type QueueItem } from './script-queue'

/**
 * Backend 錄製腳本的批次執行。
 *
 * ⚠️ **排隊的規則本身在 `script-queue.ts`，H5／PC 跑的是同一支。**
 * 這裡只剩「Backend 的端點長什麼樣」。原本整套迴圈寫在這裡，H5 要用時若照抄一份，
 * 「session 對不上要停」「取不到結果不能當通過」這些**安靜出錯**的規則就會有一邊漏掉。
 */
export type QueueEntry = QueueItem<MultiResult>

export async function queueRequest(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok || data.ok === false) throw new Error(data.message || data.error || '請求失敗')
  return data
}

export async function runRecordedQueue(entries: QueueEntry[], options: {
  agentId: string; dryRun: boolean; cancelled: () => boolean;
  /** 後台站台（cp／nc）。⚠️ 要跟錄製時選的同一個 */
  site?: 'cp' | 'nc';
  update: (index: number, patch: Partial<QueueEntry>) => void;
  started: () => void;
  request?: typeof queueRequest; pause?: () => Promise<void>
}) {
  const request = options.request || queueRequest
  await runScriptQueue<MultiResult>(entries, {
    start: async entry => {
      const started = await request('/api/osm-uat/run', { recordedScriptId: entry.id, agentId: options.agentId || undefined, dryRun: options.dryRun, site: options.site ?? 'cp' })
      return { sessionId: started.sessionId }
    },
    status: async () => {
      const status = await request('/api/osm-uat/status')
      return { sessionId: status.sessionId, running: status.status === 'running' }
    },
    stop: async () => { await request('/api/osm-uat/stop', {}) },
    results: async (entry, sessionId) => {
      const data = await request(`/api/osm-uat/recorded-scripts/${entry.id}/results`)
      return data.runs?.find((run: { runId: string }) => run.runId === sessionId)
    },
  }, {
    cancelled: options.cancelled,
    update: options.update,
    started: options.started,
    pause: options.pause,
  })
}

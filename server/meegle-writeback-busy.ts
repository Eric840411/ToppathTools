/**
 * 「這一列正在補寫 Sheet」的共用標記（v5.12.1，CodeX review 99ee76a [P2]）。
 *
 * 補回填的「移出清單」不能跟補寫同時發生——移出成功了、補寫還在跑，結果是「清單說我自己處理了，Sheet 卻被工具又寫了一次」。
 * 補寫的入口不只補回填分頁：開單頁的補寫回／重推狀態／查詢結果、評論的補寫回／繼續送出、狀態與修改的重試都會寫回 Sheet。
 * **所有入口共用這一個標記**；移出時遇到標記中的列就擋。
 *
 * 用計數不用布林：同一列可能同時有兩個入口在寫（例如兩個分頁），一個寫完不能把另一個的標記清掉。
 * 這些路由都掛在 server 同一個程序裡，所以記憶體就夠。
 */
import type { RequestHandler } from 'express'
import { backfillKey } from './meegle-backfill.js'
import type { BackfillTool } from './meegle-backfill.js'

const counts = new Map<string, number>()

export const isWritebackBusy = (key: string) => (counts.get(key) ?? 0) > 0

export async function withWritebackBusy<T>(tool: BackfillTool, batchId: string, rowKey: string, fn: () => Promise<T>): Promise<T> {
  const k = backfillKey({ tool, batchId, rowKey })
  counts.set(k, (counts.get(k) ?? 0) + 1)
  try { return await fn() } finally {
    const n = (counts.get(k) ?? 1) - 1
    if (n > 0) counts.set(k, n); else counts.delete(k)
  }
}

/**
 * 路由用：把整個 async handler 包起來——**請求一進來就標記，handler 跑完（finally）才放**。
 * - 不能只包最後寫 Sheet 那段：前面核對空間、推狀態的等待期間另一個分頁仍能移出（CodeX review 1e123a9 [P2]）
 * - 也不能在回應 close 就放：瀏覽器斷線不會取消 handler，查詢回來後照樣補寫——那時候標記已經放掉了（CodeX review 074271b [P2]）
 * body 拿不到鍵就不標，交給 handler 自己的驗證回錯。
 */
export function busyHandler(tool: BackfillTool, keyOf: (body: Record<string, unknown>) => { batchId: unknown; rowKey: unknown }, handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    const { batchId, rowKey } = keyOf((req.body ?? {}) as Record<string, unknown>)
    if (typeof batchId !== 'string' || typeof rowKey !== 'string' || !batchId || !rowKey) return handler(req, res, next)
    const k = backfillKey({ tool, batchId, rowKey })
    counts.set(k, (counts.get(k) ?? 0) + 1)
    try { await handler(req, res, next) } finally {
      const n = (counts.get(k) ?? 1) - 1
      if (n > 0) counts.set(k, n); else counts.delete(k)
    }
  }
}

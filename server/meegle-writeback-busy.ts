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

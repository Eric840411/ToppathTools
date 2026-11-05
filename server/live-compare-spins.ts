/**
 * AutoSpin 即時對照：從 recon_spin 算某段時間的局數與注額（抽出來是為了能用記憶體 DB 測 SQL 邊界）。
 *
 * ⚠️ 窗口邊界兩種：
 *   - 整段（跟 Game Record 比）：[開跑, 現在]，含起點。
 *   - Meter 那段：(t0, upTime]——**不含起點**。t0 那一刻的局已經在起點累計裡，
 *     含進來會多算一局，連續兩輪就變成假的不一致（CodeX 42f906e P2）。
 */
import type Database from 'better-sqlite3'
import type { SideValue } from './live-compare-core.js'

const NON_ROUND = `('not_started','no_bet')`

export function countSpins(
  db: Database.Database, env: string, sessionId: string, gmid: string,
  from: number, to: number, fromExclusive: boolean,
): SideValue & { betKnown: number } {
  const a = db.prepare(`
    SELECT COUNT(*) n, SUM(CASE WHEN betSource<>'' THEN 1 ELSE 0 END) known,
           SUM(CASE WHEN betSource<>'' THEN betAmount ELSE 0 END) bet
    FROM recon_spin WHERE env=? AND sessionId=? AND gmid=?
      AND observedAt ${fromExclusive ? '>' : '>='} ? AND observedAt<=?
      AND COALESCE(outcome,'') NOT IN ${NON_ROUND}
  `).get(env, sessionId, gmid, from, to) as { n: number; known: number | null; bet: number | null }
  const known = a.known ?? 0
  // 有任何一局不知道注額，總額就不能算（顯示「—」），次數照算。betAmount 沒推出來時存的是 0，要看 betSource
  return { count: a.n, amount: a.n === 0 ? 0 : known === a.n ? Math.round((a.bet ?? 0) * 100) / 100 : null, betKnown: known }
}

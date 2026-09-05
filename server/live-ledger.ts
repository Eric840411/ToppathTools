/**
 * server/live-ledger.ts — AutoSpin 即時對帳（Live Ledger）P0：對帳鍵。
 *
 * 這一期**只做綁定，不做任何金額比對**。理由是規格書開頭那四個數字：
 * 舊的 `/reconcile/*` 30 份報告完成雙向比對的有 0 份、`/compare/*` 的 1,860 筆
 * mismatch 永遠是 0——**沒有穩定的對帳鍵，後面每一期都沒有意義**。
 *
 * ## 三段式綁定
 *   ① 觀測落庫（0 秒）  agent 每按一次 spin 就寫 recon_spin，orderId 留空、狀態 PENDING
 *   ② 回填（15~90 秒） worker 拉後台增量，用「同 gmid + 時間窗 + bet 相等」補上 orderId
 *   ③ 之後所有比對都以 orderId 為鍵，**時間只在 ② 用一次**
 *
 * ⚠️ 現況的做法是「每一輪都用時間重新猜一次」，所以每一輪都有猜錯的機會、
 *    而且錯誤不會收斂。**綁定成功就寫死、永不重算**才是這次的關鍵差異。
 */
import { db } from './shared.js'

export type ReconEnv = 'qat' | 'uat'
/** 狀態命名以規格書那張表為準，不要另生別名 */
export type ReconStatus = 'PENDING' | 'MATCH' | 'MISSING' | 'AMBIGUOUS'
export type BindResult = 'resolved' | 'ambiguous' | 'not_found'

export interface PendingSpin {
  id: number
  gmid: string
  betAmount: number
  observedAt: number
}
export interface BackendRecord {
  orderId: string
  gmid: string
  bet: number
  dateTime: number
}
export interface BindConfig {
  /** 時間窗下界：後台時間可以比 spin 早幾秒 */
  beforeMs: number
  /** 時間窗上界：後台時間可以比 spin 晚幾秒 */
  afterMs: number
}
export interface BindDecision {
  spinId: number
  result: BindResult
  orderId?: string
  candidateCount: number
  /** 唯一候選卻被別的 spin 同時選中 */
  contested: boolean
  timeDeltaMs?: number
}

/** 金額比較的容差。兩邊都是後台/前端送來的數字，浮點誤差要容忍，但不能寬到跨檔位。 */
const BET_EPSILON = 0.005

/**
 * 把 pending 的 spin 綁到後台局號。**純函式**——不碰 DB，才驗得動。
 *
 * ⚠️ 規則一律保守（規格書：「不允許勉強配一個」）：
 *   - 候選 = 同 gmid + 後台時間落在窗內 + bet 相等
 *   - 恰好 1 筆 → `resolved`
 *   - 0 筆 → `not_found`（維持 PENDING，之後再試）
 *   - >1 筆 → `ambiguous`，**不猜**
 *   - 一筆局號被兩筆 spin 同時選中 → **兩邊都退回 ambiguous**
 *
 * ⚠️ 最後一條是反向檢查。只看「一筆 spin 對到幾張單」抓不到「兩筆 spin 搶同一張單」，
 *    而後者一樣是猜——只是方向相反。這個坑在舊的三路對帳上實際踩過。
 *
 * ⚠️ **擴大時間窗不是解法**。舊工具實測：spin 間隔 3~4 秒，窗一放寬就全部變 ambiguous。
 *    擴窗製造的是假對帳，比配不到更糟。
 */
export function bindSpins(
  spins: PendingSpin[],
  records: BackendRecord[],
  cfg: BindConfig,
  /** 已經被綁走的局號，不能再當候選 */
  alreadyBound: ReadonlySet<string> = new Set(),
): BindDecision[] {
  const usable = records.filter(r => !alreadyBound.has(r.orderId))

  const picked = spins.map(s => {
    const lo = s.observedAt - cfg.beforeMs
    const hi = s.observedAt + cfg.afterMs
    const hits = usable.filter(r =>
      r.gmid === s.gmid
      && r.dateTime >= lo && r.dateTime <= hi
      && Math.abs(r.bet - s.betAmount) <= BET_EPSILON)
    return { spin: s, hits }
  })

  // 反向檢查：同一張單被幾筆 spin 選中
  const claims = new Map<string, number>()
  for (const p of picked) {
    if (p.hits.length === 1) claims.set(p.hits[0].orderId, (claims.get(p.hits[0].orderId) ?? 0) + 1)
  }

  return picked.map(({ spin, hits }) => {
    if (hits.length === 0) {
      return { spinId: spin.id, result: 'not_found' as const, candidateCount: 0, contested: false }
    }
    if (hits.length > 1) {
      return { spinId: spin.id, result: 'ambiguous' as const, candidateCount: hits.length, contested: false }
    }
    const only = hits[0]
    if ((claims.get(only.orderId) ?? 0) > 1) {
      return { spinId: spin.id, result: 'ambiguous' as const, candidateCount: 1, contested: true }
    }
    return {
      spinId: spin.id,
      result: 'resolved' as const,
      orderId: only.orderId,
      candidateCount: 1,
      contested: false,
      timeDeltaMs: only.dateTime - spin.observedAt,
    }
  })
}

// ─── 設定（存 DB，不寫死）────────────────────────────────────────────────

const SETTING_FALLBACK: Record<string, string> = {
  pendingTimeoutSec: '90',
  bindWindowBeforeSec: '2',
  bindWindowAfterSec: '30',
  fetchIntervalSec: '15',
  sessionGraceSec: '300',
}

export function reconSetting(env: ReconEnv, key: string): number {
  try {
    const row = db.prepare('SELECT value FROM recon_settings WHERE env=? AND key=?').get(env, key) as { value: string } | undefined
    const n = Number(row?.value ?? SETTING_FALLBACK[key])
    // ⚠️ 讀到壞值時退回預設而不是 NaN。NaN 會讓時間窗比較全部變 false，
    //    症狀是「全部配不到」，看起來像後台掛了。
    return Number.isFinite(n) ? n : Number(SETTING_FALLBACK[key] ?? 0)
  } catch {
    return Number(SETTING_FALLBACK[key] ?? 0)
  }
}

export function bindConfigOf(env: ReconEnv): BindConfig {
  return {
    beforeMs: reconSetting(env, 'bindWindowBeforeSec') * 1000,
    afterMs: reconSetting(env, 'bindWindowAfterSec') * 1000,
  }
}

// ─── 落庫 ────────────────────────────────────────────────────────────────

/** agent 每按一次 spin 就寫一筆。orderId 留空、狀態 PENDING。 */
export function recordSpinObservation(row: {
  env: ReconEnv; sessionId: string; machineType: string; gmid: string; spinSeq: number
  betAmount: number; balanceBefore?: number | null; balanceAfter?: number | null
  winObserved?: number | null; observedAt: number
}): void {
  db.prepare(`
    INSERT INTO recon_spin (env, sessionId, machineType, gmid, spinSeq, betAmount,
      balanceBefore, balanceAfter, winObserved, status, observedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
    ON CONFLICT(env, sessionId, machineType, spinSeq) DO UPDATE SET
      betAmount=excluded.betAmount, balanceBefore=excluded.balanceBefore,
      balanceAfter=excluded.balanceAfter, winObserved=excluded.winObserved
  `).run(row.env, row.sessionId, row.machineType, row.gmid, row.spinSeq, row.betAmount,
    row.balanceBefore ?? null, row.balanceAfter ?? null, row.winObserved ?? null, row.observedAt)
}

/** 後台增量落庫。⚠️ upsert：重啟後重疊拉取不能產生重複，也不能覆蓋成舊值。 */
export function upsertBackendRecords(env: ReconEnv, rows: Array<{
  orderId: string; gmid: string; playerId: string; bet: number; win: number
  balanceBefore?: number | null; balanceAfter?: number | null; dateTime: number; raw: unknown
}>): number {
  const stmt = db.prepare(`
    INSERT INTO recon_backend_record (env, orderId, gmid, playerId, bet, win, balanceBefore, balanceAfter, dateTime, fetchedAt, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(env, orderId) DO UPDATE SET
      bet=excluded.bet, win=excluded.win, balanceBefore=excluded.balanceBefore,
      balanceAfter=excluded.balanceAfter, dateTime=excluded.dateTime, fetchedAt=excluded.fetchedAt, raw=excluded.raw
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(env, r.orderId, r.gmid, r.playerId, r.bet, r.win,
        r.balanceBefore ?? null, r.balanceAfter ?? null, r.dateTime, now, JSON.stringify(r.raw ?? null))
    }
  })
  tx()
  return rows.length
}

// ─── watermark ───────────────────────────────────────────────────────────

export function readWatermark(env: ReconEnv, source: string, scope = ''): number {
  const r = db.prepare('SELECT cursorTs FROM recon_watermark WHERE env=? AND source=? AND scope=?')
    .get(env, source, scope) as { cursorTs: number } | undefined
  return r?.cursorTs ?? 0
}

export function writeWatermark(env: ReconEnv, source: string, cursorTs: number, scope = ''): void {
  db.prepare(`
    INSERT INTO recon_watermark (env, source, scope, cursorTs, updatedAt) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(env, source, scope) DO UPDATE SET cursorTs=excluded.cursorTs, updatedAt=excluded.updatedAt
  `).run(env, source, scope, cursorTs, Date.now())
}

// ─── 綁定一輪 ────────────────────────────────────────────────────────────

/**
 * 跑一次回填。回傳這一輪的統計。
 *
 * ⚠️ `firstQueriedAt` 只在**第一次**去找它時寫入。之後每輪都覆蓋的話，
 *    「從按下 spin 到入帳花多久」就永遠算不出來——而那正是校準 90 秒門檻的依據。
 */
export function runBindCycle(env: ReconEnv, now = Date.now()): {
  scanned: number; resolved: number; ambiguous: number; notFound: number; missing: number
} {
  const cfg = bindConfigOf(env)
  const pendingTimeoutMs = reconSetting(env, 'pendingTimeoutSec') * 1000

  const spins = db.prepare(`
    SELECT id, gmid, betAmount, observedAt FROM recon_spin
    WHERE env=? AND status IN ('PENDING','AMBIGUOUS') AND orderId IS NULL
  `).all(env) as PendingSpin[]
  if (spins.length === 0) return { scanned: 0, resolved: 0, ambiguous: 0, notFound: 0, missing: 0 }

  const oldest = Math.min(...spins.map(s => s.observedAt))
  const records = db.prepare(`
    SELECT orderId, gmid, bet, dateTime FROM recon_backend_record
    WHERE env=? AND dateTime >= ? AND dateTime <= ?
  `).all(env, oldest - cfg.beforeMs, now + cfg.afterMs) as BackendRecord[]

  const bound = new Set(
    (db.prepare('SELECT orderId FROM recon_spin WHERE env=? AND orderId IS NOT NULL').all(env) as { orderId: string }[])
      .map(r => r.orderId))

  const decisions = bindSpins(spins, records, cfg, bound)

  const markFirstQuery = db.prepare('UPDATE recon_spin SET firstQueriedAt=? WHERE id=? AND firstQueriedAt IS NULL')
  const setResolved = db.prepare(`
    UPDATE recon_spin SET orderId=?, status='MATCH', bindResult='resolved', boundAt=?, latencyMs=? WHERE id=?
  `)
  const setAmbiguous = db.prepare(`UPDATE recon_spin SET status='AMBIGUOUS', bindResult='ambiguous' WHERE id=?`)
  const setNotFound = db.prepare(`UPDATE recon_spin SET status='PENDING', bindResult='not_found' WHERE id=?`)
  const setMissing = db.prepare(`UPDATE recon_spin SET status='MISSING', bindResult='not_found' WHERE id=?`)

  let resolved = 0, ambiguous = 0, notFound = 0, missing = 0
  const byId = new Map(spins.map(s => [s.id, s]))
  const tx = db.transaction(() => {
    for (const d of decisions) {
      markFirstQuery.run(now, d.spinId)
      const s = byId.get(d.spinId)!
      if (d.result === 'resolved') {
        // ⚠️ 這裡可能撞唯一索引（同一張單被別的 env/session 綁走）。撞到就退回 ambiguous，
        //    不要讓整個交易炸掉——一筆綁不上不該讓其他幾百筆都失敗。
        try {
          setResolved.run(d.orderId!, now, now - s.observedAt, d.spinId)
          resolved++
        } catch {
          setAmbiguous.run(d.spinId); ambiguous++
        }
      } else if (d.result === 'ambiguous') {
        setAmbiguous.run(d.spinId); ambiguous++
      } else if (now - s.observedAt > pendingTimeoutMs) {
        // 超過門檻還沒綁上 → 掉單
        setMissing.run(d.spinId); missing++
      } else {
        setNotFound.run(d.spinId); notFound++
      }
    }
  })
  tx()
  return { scanned: spins.length, resolved, ambiguous, notFound, missing }
}

/** P0 驗收用的統計：回填成功率與 AMBIGUOUS 佔比。 */
export function bindStats(env: ReconEnv, sinceMs?: number): {
  total: number; match: number; pending: number; missing: number; ambiguous: number
  resolveRate: number; ambiguousRate: number
} {
  const where = sinceMs ? 'AND observedAt >= ?' : ''
  const args: unknown[] = sinceMs ? [env, sinceMs] : [env]
  const r = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN status='MATCH' THEN 1 ELSE 0 END) m,
      SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) p,
      SUM(CASE WHEN status='MISSING' THEN 1 ELSE 0 END) x,
      SUM(CASE WHEN status='AMBIGUOUS' THEN 1 ELSE 0 END) a
    FROM recon_spin WHERE env=? ${where}
  `).get(...args) as { total: number; m: number; p: number; x: number; a: number }
  const total = r.total || 0
  // ⚠️ 分母排除還在 PENDING 的——它們還沒有結論，算進去會讓成功率在剛開跑時假性偏低。
  //    但 MISSING 要算進去，那是明確的失敗。
  const decided = (r.m || 0) + (r.x || 0) + (r.a || 0)
  return {
    total, match: r.m || 0, pending: r.p || 0, missing: r.x || 0, ambiguous: r.a || 0,
    resolveRate: decided > 0 ? (r.m || 0) / decided : 0,
    ambiguousRate: decided > 0 ? (r.a || 0) / decided : 0,
  }
}

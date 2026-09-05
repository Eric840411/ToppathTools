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

// ─── D 方案：username 過濾 + spin_index 序列對齊 ─────────────────────────
//
// ⚠️ **時間窗不能當鑑別器。**實測（本機 13,876 筆 dealGMActionReq）spin 間隔中位數
//    6 秒，而規格原本的窗 −2s~+30s 寬 32 秒 → 每筆約 5.3 個候選，全部判 AMBIGUOUS。
//    根因是 bet 固定 1250，窗內沒有第二個鑑別特徵。後台側實測局間隔 p90 9 秒、
//    max 146 秒——單看時間的話那筆 146 秒的會被誤判成掉單。
//
// 改用後台自己給的 `spin_index`（逐局遞增序號）做序列對齊。實測 200 筆連續樣本
// **跳號率 0.0%**，`bet_time_precise` 單調遞增，所以這個順序是可信的。
//
// ⚠️ 候選集在**查詢階段**就砍掉（帶 playerName 過濾），不是在比對階段篩。
//    別人的局根本不會進來。

export interface BackendRound {
  orderId: string
  gmid: string
  username: string
  spinIndex: number
  bet: number
  betTimePrecise: number
}
export interface AlignDecision {
  spinId: number
  result: BindResult
  orderId?: string
  spinIndex?: number
  /** 對齊之後的驗證結果——不通過就不算 resolved */
  verify?: { betOk: boolean; timeOk: boolean; latencyOk?: boolean; deltaMs?: number }
  reason?: string
}

/**
 * spin_index 序列對齊。
 *
 * 前提：`rounds` 已經是**單一帳號 × 單一機台**的集合（查詢階段用 playerName 過濾），
 * 且 `spins` 與 `rounds` 都各自有序。
 *
 * ⚠️ **錨定之後才遞推，而且每一筆都要驗**（規格方要求）。「錯位整段偏移」是序列
 *    對齊最危險的失敗模式——一旦錨錯，後面每一筆都錯而且看起來都「成功」。
 *    所以：
 *      - spin_index 跳號 → 該筆標 AMBIGUOUS 並**重新錨定**，不硬推
 *      - 每筆用 bet 相等 + bet_time_precise 單調性做 sanity check，不過就不算 resolved
 *
 * ⚠️ 對齊用「已綁定的最後一筆」當錨。第一次沒有錨時，用時間最接近的唯一候選錨一次；
 *    錨不出來就整批 not_found，**不猜**——寧可這一輪不綁，下一輪後台資料更完整再試。
 */
export function alignBySpinIndex(
  spins: Array<PendingSpin & { spinSeq: number }>,
  rounds: BackendRound[],
  opts: {
    /** 錨定時的時間窗（單一候選才錨） */
    anchorWindowMs: number
    /** 逐筆容忍的最大入帳延遲。⚠️ 必須小於 spin 間隔，否則平移一格也會通過 */
    maxLatencyMs: number
    /** 後台時間比 spin 早多少仍可接受（時鐘偏移用，通常很小） */
    maxLeadMs: number
  },
  alreadyBound: ReadonlySet<string> = new Set(),
): AlignDecision[] {
  const free = rounds.filter(r => !alreadyBound.has(r.orderId)).slice()
    .sort((a, b) => a.spinIndex - b.spinIndex)
  const ordered = spins.slice().sort((a, b) => a.spinSeq - b.spinSeq)
  if (ordered.length === 0) return []
  if (free.length === 0) {
    return ordered.map(s => ({ spinId: s.id, result: 'not_found' as const, reason: 'no_backend_rounds' }))
  }

  const out: AlignDecision[] = []
  let cursor = -1          // free[] 的索引
  let lastIndex: number | null = null
  let lastTime = -Infinity
  /**
   * ⚠️ 這一輪之內已經配掉的位置。**重新錨定時一定要排除它們。**
   *    少了這個，跳號後重新錨定會往回搜到已經配過的那幾筆，
   *    於是同一張後台單在同一次呼叫裡被配給兩筆 spin——兩邊都顯示 resolved。
   *    （DB 那層有 unique index 會擋下第二筆，但那時已經是「一筆綁成、一筆莫名失敗」，
   *    看起來像偶發錯誤而不是邏輯錯誤，很難查。）
   */
  const used = new Set<number>()

  for (const s of ordered) {
    // ① 還沒錨定 → 用時間找唯一候選錨一次
    if (cursor < 0) {
      const near = free
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => !used.has(i)
          && Math.abs(r.betTimePrecise - s.observedAt) <= opts.anchorWindowMs
          && Math.abs(r.bet - s.betAmount) <= BET_EPSILON)
      if (near.length !== 1) {
        // ⚠️ 錨不出來就不錨。硬錨會讓後面整段偏移，而且每一筆看起來都成功。
        out.push({ spinId: s.id, result: 'not_found', reason: near.length === 0 ? 'no_anchor' : 'anchor_ambiguous' })
        continue
      }
      cursor = near[0].i
    } else {
      cursor++
    }
    // 遞推也可能走到已經用掉的位置（重新錨定之後），一樣要跳過
    while (cursor < free.length && used.has(cursor)) cursor++

    if (cursor >= free.length) {
      out.push({ spinId: s.id, result: 'not_found', reason: 'beyond_backend' })
      continue
    }
    const r = free[cursor]

    // ② 跳號 → 不硬推，重新錨定
    if (lastIndex !== null && r.spinIndex !== lastIndex + 1) {
      out.push({ spinId: s.id, result: 'ambiguous', reason: `index_gap:${lastIndex}->${r.spinIndex}` })
      cursor = -1; lastIndex = null
      continue
    }

    /**
     * ③ 每一筆都驗，不通過就不算 resolved。
     *
     * ⚠️ **`latencyOk` 這一條是反向驗收逼出來的，不是可有可無的加分項。**
     *    第一版只驗 bet 相等 + 時間單調，結果把後台序列整體平移一格之後
     *    **回填率還有 95%**——因為 bet 是常數、平移後時間依然單調遞增，
     *    兩個檢查都通過。那正是「看起來成功」的失敗模式：整段配到隔壁那一局。
     *
     * ⚠️ 逐筆的時間差上界**必須小於 spin 間隔**，否則差一位仍落在容忍範圍內、
     *    這條就形同虛設。實測 spin 間隔中位數 6 秒，所以上界要明顯小於 6 秒。
     *
     * ⚠️ **決定這個上界的是「配對抖動」，不是「入帳延遲」——兩者是不同的量**
     *    （我原本混為一談，規格方更正）：
     *
     *      配對抖動 = `bet_time_precise − observedAt` 的**變異**
     *                 ← 決定容忍上界能設多低。實測目前 max 500ms，對 6 秒間隔約 12 倍餘裕
     *      入帳延遲 = `fetchedAt − bet_time_precise`（紀錄多久後才查得到）
     *                 ← 決定 PENDING → MISSING 的 90 秒門檻，**跟配對鑑別力無關**
     *
     *    理由：`bet_time_precise` 是後端自己記的下注時間，不是紀錄可見的時間。
     *    所以就算入帳延遲 60 秒，只要延遲得「一致」，抖動仍然是穩定的 500ms，
     *    配對完全不受影響。
     *
     * ⚠️ 如果 P0 實測的**抖動 max** 逼近 spin 間隔的一半，**不要自己放寬上界**——
     *    那時的正解是加第三個鑑別特徵。備援已經現成：`begin_machine_coin` /
     *    `bet_coin_now` 是逐局遞變的執行餘額，鑑別力比時間強得多，而且 L2 本來
     *    就要收它。屆時把它從「配對後驗證」升格為「配對鍵」即可，不用重新設計。
     */
    const betOk = Math.abs(r.bet - s.betAmount) <= BET_EPSILON
    const timeOk = r.betTimePrecise >= lastTime
    const delta = r.betTimePrecise - s.observedAt
    const latencyOk = delta >= -opts.maxLeadMs && delta <= opts.maxLatencyMs
    if (!betOk || !timeOk || !latencyOk) {
      out.push({
        spinId: s.id, result: 'ambiguous',
        verify: { betOk, timeOk, latencyOk, deltaMs: delta },
        reason: !betOk ? `bet_mismatch:${r.bet}!=${s.betAmount}`
          : !timeOk ? 'time_not_monotonic'
          : `latency_out_of_band:${delta}ms`,
      })
      cursor = -1; lastIndex = null
      continue
    }

    out.push({ spinId: s.id, result: 'resolved', orderId: r.orderId, spinIndex: r.spinIndex,
      verify: { betOk, timeOk, latencyOk, deltaMs: delta } })
    used.add(cursor)
    lastIndex = r.spinIndex
    lastTime = r.betTimePrecise
  }
  return out
}

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

// ─── 後台拉取 ────────────────────────────────────────────────────────────

/**
 * 把 gameRecordList 的一列正規化。
 *
 * ⚠️ 時間一律轉成 **epoch ms (UTC)**。`bet_time_precise` 是 epoch **秒**（帶小數），
 *    直接當毫秒用會差 1000 倍，而症狀是「全部配不到」——看起來像後台掛了。
 */
export function normalizeBackendRow(raw: Record<string, unknown>): BackendRound & { win: number; playerId: string } | null {
  const orderId = String(raw.order_id ?? '')
  if (!orderId) return null
  const btp = Number(raw.bet_time_precise)
  return {
    orderId,
    gmid: String(raw.uid ?? ''),
    username: String(raw.username ?? ''),
    spinIndex: Number(raw.spin_index ?? -1),
    bet: Number(raw.bet ?? 0),
    win: Number(raw.win ?? 0),
    playerId: String(raw.userid ?? ''),
    betTimePrecise: Number.isFinite(btp) ? Math.round(btp * 1000) : NaN,
  }
}

export interface FetchGuardResult {
  ok: boolean
  rows: Array<ReturnType<typeof normalizeBackendRow>>
  /** 不 ok 時的原因，會寫進 recon_source_health */
  errKind?: 'wrong_account' | 'bad_shape'
  message?: string
}

/**
 * ⚠️ **拉取後必驗「回傳的 username 全部等於我們要的那一個」**（規格方升格為必做）。
 *
 * 實測：`playerId` 傳 username 時後台**不報錯，直接回傳未過濾的全部 16,824 筆**。
 * 少了這道防呆，一個參數打錯就會讓整套對帳靜默地對到別人的資料上，
 * 而且畫面會顯示得很正常——這正是這份規格從頭在防的失敗類型。
 *
 * 不一致時整批標 DEGRADED、**不進綁定**。寧可這一輪沒有資料，也不要對到別人的局。
 */
export function guardFetchedRows(rawItems: unknown[], expectUsername: string): FetchGuardResult {
  const rows = rawItems
    .map(x => normalizeBackendRow(x as Record<string, unknown>))
    .filter((x): x is NonNullable<ReturnType<typeof normalizeBackendRow>> => x !== null)

  const foreign = rows.filter(r => r.username !== expectUsername)
  if (foreign.length > 0) {
    const names = [...new Set(foreign.map(r => r.username))].slice(0, 3)
    return {
      ok: false, rows: [], errKind: 'wrong_account',
      message: `回傳含非目標帳號（期待 ${expectUsername}，出現 ${names.join('/')}${names.length < new Set(foreign.map(r => r.username)).size ? '…' : ''}）：${foreign.length}/${rows.length} 筆`,
    }
  }
  // spin_index / bet_time_precise 缺一不可——序列對齊完全依賴這兩個欄位
  const broken = rows.filter(r => !Number.isFinite(r.betTimePrecise) || r.spinIndex < 0)
  if (broken.length > 0) {
    return {
      ok: false, rows: [], errKind: 'bad_shape',
      message: `${broken.length}/${rows.length} 筆缺 spin_index 或 bet_time_precise，序列對齊無法進行`,
    }
  }
  return { ok: true, rows }
}

/** 記錄資料源健康狀態。DEGRADED 判定與畫面健康列都讀這張。 */
export function noteSourceHealth(env: ReconEnv, source: string, ok: boolean, errKind?: string, message?: string): void {
  const now = Date.now()
  if (ok) {
    db.prepare(`
      INSERT INTO recon_source_health (env, source, lastOkAt, failCount) VALUES (?, ?, ?, 0)
      ON CONFLICT(env, source) DO UPDATE SET lastOkAt=excluded.lastOkAt, failCount=0, errKind=NULL, message=NULL, backoffUntil=NULL
    `).run(env, source, now)
    return
  }
  db.prepare(`
    INSERT INTO recon_source_health (env, source, lastErrAt, failCount, errKind, message) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(env, source) DO UPDATE SET
      lastErrAt=excluded.lastErrAt, failCount=recon_source_health.failCount+1,
      errKind=excluded.errKind, message=excluded.message
  `).run(env, source, now, errKind ?? 'unknown', (message ?? '').slice(0, 300))
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

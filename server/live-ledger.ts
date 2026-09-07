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
/**
 * 這一筆是用哪種時間判準綁上的。
 *
 * ⚠️ **兩者信心度差一個數量級，統計時一定要分開算。**
 *    `residual` 是扣掉系統性偏移後比殘差（±5s，嚴格）；
 *    `absolute_window` 是樣本不足時的退路（±30s，寬鬆）。
 *    混成同一個回填率＝把「嚴格對上的」和「寬鬆撿到的」當成同一件事。
 */
export type BindMethod = 'nearest' | 'residual' | 'residual_global' | 'absolute_window'

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
  /** `betOk` 為 undefined 代表 agent 側沒有 bet 可比——是**跳過**不是通過 */
  verify?: { betOk?: boolean; timeOk: boolean; latencyOk?: boolean; deltaMs?: number }
  /** 用殘差還是絕對窗綁上的——驗收要分開統計 */
  bindMethod?: BindMethod
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
    /**
     * `Δt = betTimePrecise − observedAt` 的**系統性偏移**（估不出來時傳 null）。
     *
     * ⚠️ 這個值一定要**用配對過的樣本估**，不能拿 HTTP `Date` header 算的時鐘差來代替。
     *    實測（2026-09-05）：`Date` header 偏移 +93 秒，而 Δt 中位數是 +29 秒，
     *    兩者差 64.5 秒——`bet_time_precise` 跟後台 web 不是同一個時鐘。
     *    拿 Date 去校正會**比不校正更錯**。
     */
    offsetMs?: number | null
    /**
     * 扣掉 offset 之後的殘差容忍值。實測殘差 p95 = 2,960ms、max = 4,364ms，
     * 所以 ±5 秒綽綽有餘，而且比原本的 30 秒絕對窗**嚴格 6 倍**。
     */
    residualToleranceMs?: number
    /** 這個 offset 是逐機台估的還是全域估的——信心度不同，要標記出來 */
    offsetScope?: 'machine' | 'global' | null
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

  /**
   * 有沒有可用的 offset 估計，決定這一輪用哪一種時間判準：
   *   `residual`        —— 扣掉系統性偏移後比殘差（嚴格 6 倍，正常路徑）
   *   `absolute_window` —— 樣本不足時的退路，寬鬆很多
   *
   * ⚠️ **兩者一定要標記，不能混成同一個回填率。**它們的信心度差一個數量級；
   *    混在一起算，等於把「嚴格對上的」和「寬鬆撿到的」當成同一件事——
   *    那正是這個專案一再踩到的那類問題（規格方要求）。
   */
  const offset = (typeof opts.offsetMs === 'number' && Number.isFinite(opts.offsetMs))
    ? opts.offsetMs : null
  const residualTol = opts.residualToleranceMs ?? 5000
  const bindMethod: BindMethod = offset === null ? 'absolute_window'
    : opts.offsetScope === 'global' ? 'residual_global' : 'residual'
  // 錨定窗：有 offset 時用殘差容忍值，沒有時沿用原本的絕對窗
  const anchorTol = offset === null ? opts.anchorWindowMs : residualTol

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
      // ⚠️ bet 未知時**錨定也要跳過 bet 比對**，否則永遠錨不到（betAmount=0 對不上任何一張單），
      //    結果會是「全部 no_anchor、回填率 0%」——看起來像設計失敗，其實只是我們沒有這個欄位。
      //    這個坑我差點帶進驗收。
      const anchorBetKnown = Number.isFinite(s.betAmount) && s.betAmount > 0
      // ⚠️ **錨定也要扣掉系統性偏移。**實測偏移是 +29 秒、而錨定窗是 30 秒——
      //    不扣的話整個分布貼在窗的邊緣（實測 max 剛好等於 30,000ms，那是被切斷的痕跡），
      //    偏移只要微幅右移，新的每一筆就全部掉出窗外、再也錨不到。
      const near = free
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => !used.has(i)
          && Math.abs((r.betTimePrecise - s.observedAt) - (offset ?? 0)) <= anchorTol
          && (!anchorBetKnown || Math.abs(r.bet - s.betAmount) <= BET_EPSILON))
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
    /**
     * ⚠️ **agent 側的 bet 目前拿不到，所以未知時要跳過這項而不是判失敗。**
     *
     * 實測：`dealGMActionReq` 的請求裡沒有 bet 欄位（下注額是另一個動作設定的），
     * 而實測 session 的餘額完全沒有變動（31567505770.86 → 相同），也推不出來。
     * 判失敗的話**每一筆都會變 AMBIGUOUS**，驗收直接歸零——而那不是配對錯，
     * 是我們沒有這個資料。
     *
     * ⚠️ 但這等於少一道保護，要誠實記錄：`betOk` 會是 `undefined` 而不是 `true`，
     *    畫面與驗收報告要看得出「這批是在沒有 bet 驗證的情況下對上的」。
     *    補這個資料的兩條路（待規格方裁示）：從下注設定動作攔 bet，
     *    或改用 begin/end_machine_coin 的差值。
     */
    const betKnown = Number.isFinite(s.betAmount) && s.betAmount > 0
    const betOk = betKnown ? Math.abs(r.bet - s.betAmount) <= BET_EPSILON : undefined
    const timeOk = r.betTimePrecise >= lastTime
    const delta = r.betTimePrecise - s.observedAt
    // 有 offset 就比殘差；沒有才退回絕對窗（並由 bindMethod 標記出來）
    const latencyOk = offset === null
      ? (delta >= -opts.maxLeadMs && delta <= opts.maxLatencyMs)
      : Math.abs(delta - offset) <= residualTol
    if (betOk === false || !timeOk || !latencyOk) {
      out.push({
        spinId: s.id, result: 'ambiguous',
        verify: { betOk, timeOk, latencyOk, deltaMs: delta },
        reason: betOk === false ? `bet_mismatch:${r.bet}!=${s.betAmount}`
          : !timeOk ? 'time_not_monotonic'
          : `latency_out_of_band:${delta}ms`,
      })
      cursor = -1; lastIndex = null
      continue
    }

    out.push({ spinId: s.id, result: 'resolved', orderId: r.orderId, spinIndex: r.spinIndex,
      verify: { betOk, timeOk, latencyOk, deltaMs: delta }, bindMethod })
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
  /**
   * agent 對這一下 spin 的判定：completed / completed_late / suspected /
   * unknown / not_started。
   *
   * ⚠️ **這是回填率的分母。**沒成局的嘗試本來就不會有後台紀錄，混進分母會讓
   *    對帳看起來像壞了（實測 timeout 約 29%，48/139=34.5% vs 48/59=81.4%）。
   */
  outcome?: string
  /**
   * 這筆觀測屬於哪個帳號。⚠️ **由端點從 session 取，不要相信 client 送的值。**
   *    而且這是**顯示分流不是權限隔離**——過濾用的 header 任何人都能偽造。
   */
  userLabel?: string
}): void {
  db.prepare(`
    INSERT INTO recon_spin (env, sessionId, machineType, gmid, spinSeq, betAmount,
      balanceBefore, balanceAfter, winObserved, status, observedAt, outcome, userLabel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
    ON CONFLICT(env, sessionId, machineType, spinSeq) DO UPDATE SET
      -- ⚠️ **已知值不准被 null 覆蓋。**agent 會用同一個 spinSeq 重送來補
      --    「餘額後 / win」（那兩個要等結算才算得出來，見下方說明）。
      --    寫成 excluded.x 的話，任何一次帶 null 的重送都會把先前補好的值**抹掉**——
      --    而且完全沒有徵兆，只會看到欄位又變回空的。
      --    代價是無法再把某個值改回 null；那是刻意的取捨：這裡的 null 一律代表
      --    「還算不出來」，不是一個有意義的值。
      betAmount=COALESCE(excluded.betAmount, recon_spin.betAmount),
      balanceBefore=COALESCE(excluded.balanceBefore, recon_spin.balanceBefore),
      balanceAfter=COALESCE(excluded.balanceAfter, recon_spin.balanceAfter),
      winObserved=COALESCE(excluded.winObserved, recon_spin.winObserved),
      -- outcome 仍然可以被改寫（unknown → completed_late 這種補判要蓋得過去），
      -- 但空字串不算答案，不要用它蓋掉已經定案的分類
      outcome=CASE WHEN excluded.outcome='' THEN recon_spin.outcome ELSE excluded.outcome END,
      -- ⚠️ userLabel 只在還沒歸屬時才補；已經有主人的不要被後來的寫入改掉
      userLabel=CASE WHEN recon_spin.userLabel='' THEN excluded.userLabel ELSE recon_spin.userLabel END
  `).run(row.env, row.sessionId, row.machineType, row.gmid, row.spinSeq, row.betAmount,
    row.balanceBefore ?? null, row.balanceAfter ?? null, row.winObserved ?? null, row.observedAt,
    row.outcome ?? '', row.userLabel ?? '')
}

/** 後台增量落庫。⚠️ upsert：重啟後重疊拉取不能產生重複，也不能覆蓋成舊值。 */
export function upsertBackendRecords(env: ReconEnv, rows: Array<{
  orderId: string; gmid: string; playerId: string; bet: number; win: number
  balanceBefore?: number | null; balanceAfter?: number | null; dateTime: number; raw: unknown
  spinIndex?: number | null; betTimePrecise?: number | null; username?: string
}>, filter?: { field: string; value: string }): number {
  const stmt = db.prepare(`
    INSERT INTO recon_backend_record (env, orderId, gmid, playerId, bet, win, balanceBefore, balanceAfter,
      dateTime, fetchedAt, raw, spinIndex, betTimePrecise, username, filterField, filterValue)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(env, orderId) DO UPDATE SET
      bet=excluded.bet, win=excluded.win, balanceBefore=excluded.balanceBefore,
      balanceAfter=excluded.balanceAfter, dateTime=excluded.dateTime, fetchedAt=excluded.fetchedAt,
      raw=excluded.raw, spinIndex=excluded.spinIndex, betTimePrecise=excluded.betTimePrecise,
      username=excluded.username, filterField=excluded.filterField, filterValue=excluded.filterValue
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(env, r.orderId, r.gmid, r.playerId, r.bet, r.win,
        r.balanceBefore ?? null, r.balanceAfter ?? null, r.dateTime, now, JSON.stringify(r.raw ?? null),
        r.spinIndex ?? null, r.betTimePrecise ?? null, r.username ?? '',
        filter?.field ?? '', filter?.value ?? '')
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
/**
 * 已經判成 MISSING 之後，還願意回頭重綁多久。
 *
 * ⚠️ **MISSING 必須可逆。**原本它是終局狀態，所以門檻只要訂得比實際入帳延遲緊一點,
 *    資料就被永久污染——而畫面上顯示的是「掉單」。**對一筆其實有入帳的局說掉單,
 *    比不報還糟。**實測首輪就有 14 筆後台紀錄晚到、對應的 spin 早已被判 MISSING。
 *
 * ⚠️ 但也不能無上限回頭掃，否則掃描集合會無限長大。30 分鐘遠大於實測的入帳延遲
 *    （p95 約 60 秒），又不會讓每一輪都在重掃整個歷史。
 */
export const LATE_REBIND_WINDOW_MS = 30 * 60 * 1000

/**
 * 殘差容忍值。實測（2026-09-05，57 筆）殘差 p50 = 707ms、p95 = 2,960ms、max = 4,364ms,
 * 所以 ±5 秒有足夠餘裕，而且比原本的 30 秒絕對窗**嚴格 6 倍**。
 *
 * ⚠️ 要調這個值一定要**用實際分布重算**，不要憑感覺（跟當初定 ±1000ms 那個窗同一個做法）。
 */
export const RESIDUAL_TOLERANCE_MS = 5000

/** 估 offset 至少要幾筆樣本。不足就退回絕對窗，並且**標記出來**。 */
export const MIN_OFFSET_SAMPLES = 10

/**
 * 用**已經配對成功的樣本**估 `Δt = betTimePrecise − observedAt` 的系統性偏移（取中位數）。
 *
 * ⚠️ **絕對不能拿 HTTP `Date` header 的時鐘差來代替。**實測 2026-09-05：
 *    `Date` header 偏移 +93 秒、Δt 中位數 +29 秒，**兩者差 64.5 秒**——
 *    `bet_time_precise` 跟後台 web 根本不是同一個時鐘。用 Date 校正會比不校正更錯。
 *
 * ⚠️ 逐 `(env, machineType)` 估、而且只取最近 N 筆滾動更新：offset 是三個東西的合成
 *    （本機時鐘偏差 ＋ 來源時鐘偏差 ＋ `bet_time_precise` 的語意差異），
 *    只有第一項是全域的。時鐘也會被 NTP 校正、會漂，所以不能在 session 開頭估一次就固定。
 */
/**
⚠️ **冷啟動的雞生蛋問題**：要 10 筆配對樣本才估得出偏移，但偏移本身就把配對截斷了。
 *
 * 實測（897-BIGFULINK-2065 第一次上線）：Δt = 26068 / 29692 / 29684，全部貼在 30 秒
 * 絕對窗的邊緣，28 筆後台紀錄只綁上 3 筆——而 3 < 10，所以永遠切不到殘差模式。
 * 新機台會**永久卡在寬鬆模式而且配對率極低**。
 *
 * 解法：逐機台樣本不足時，退而用**同 env 的全域偏移**。理由是那個偏移主要來自
 * 本機時鐘偏差（全域的），逐機台的部分只是次要成分。用全域值仍然比 30 秒絕對窗準得多。
 *
 * ⚠️ 但這兩者要**分得出來**（`residual` vs `residual_global`）——全域值沒有把
 *    該機台特有的成分算進去，信心度不同，統計時不能混。
 */
export function estimateGlobalOffset(env: ReconEnv, limit = 200): number | null {
  const rows = db.prepare(`
    SELECT b.betTimePrecise - s.observedAt AS dt
    FROM recon_spin s JOIN recon_backend_record b ON b.orderId = s.orderId AND b.env = s.env
    WHERE s.env = ? AND s.status = 'MATCH' AND s.orderId IS NOT NULL
    ORDER BY s.observedAt DESC LIMIT ?
  `).all(env, limit) as { dt: number }[]
  if (rows.length < MIN_OFFSET_SAMPLES) return null
  const d = rows.map(r => r.dt).sort((x, y) => x - y)
  const m = Math.floor(d.length / 2)
  return d.length % 2 ? d[m] : Math.round((d[m - 1] + d[m]) / 2)
}

export function estimateMatchOffset(env: ReconEnv, machineType: string, limit = 50): number | null {
  const rows = db.prepare(`
    SELECT b.betTimePrecise - s.observedAt AS dt
    FROM recon_spin s JOIN recon_backend_record b ON b.orderId = s.orderId AND b.env = s.env
    WHERE s.env = ? AND s.machineType = ? AND s.status = 'MATCH' AND s.orderId IS NOT NULL
    ORDER BY s.observedAt DESC LIMIT ?
  `).all(env, machineType, limit) as { dt: number }[]
  if (rows.length < MIN_OFFSET_SAMPLES) return null
  const d = rows.map(r => r.dt).sort((a, b) => a - b)
  const m = Math.floor(d.length / 2)
  return d.length % 2 ? d[m] : Math.round((d[m - 1] + d[m]) / 2)
}

export function runBindCycle(env: ReconEnv, now = Date.now()): {
  scanned: number; resolved: number; ambiguous: number; notFound: number; missing: number
  /**
   * 本來已判掉單、因後台紀錄晚到而綁回來的筆數。
   * ⚠️ 持續 > 0 代表 `pendingTimeoutSec` 訂得比實際入帳延遲緊——那是門檻要調，
   *    不是資料有問題。這個數字就是用來看見這件事的。
   */
  lateRebound: number
} {
  const cfg = bindConfigOf(env)
  const pendingTimeoutMs = reconSetting(env, 'pendingTimeoutSec') * 1000
  // ⚠️ 老化一律用**校正到 observedAt 那條軸**的時間（見 nowOnObservedAxis）。
  //    用未校正的 now 的話，90 秒門檻實際會變成 183 秒。
  const nowObs = nowOnObservedAxis(env, now)

  const allPending = db.prepare(`
    SELECT id, sessionId, machineType, gmid, spinSeq, betAmount, observedAt, status, outcome FROM recon_spin
    WHERE env=? AND status IN ('PENDING','AMBIGUOUS','MISSING') AND orderId IS NULL
      AND observedAt >= ?
    ORDER BY sessionId, machineType, spinSeq
  `).all(env, now - LATE_REBIND_WINDOW_MS) as Array<PendingSpin & {
    sessionId: string; machineType: string; spinSeq: number; status: string; outcome?: string
  }>
  // 不可能擁有一局的那些不參與配對；但**不是丟掉**——它們要進 shadow check（見下）
  const spins = allPending.filter(s => !NON_ROUND_OUTCOMES.has(s.outcome ?? ''))
  const nonRoundSpins = allPending.filter(s => NON_ROUND_OUTCOMES.has(s.outcome ?? ''))
  if (allPending.length === 0) return { scanned: 0, resolved: 0, ambiguous: 0, notFound: 0, missing: 0, lateRebound: 0 }

  const oldest = Math.min(...allPending.map(s => s.observedAt))
  const records = db.prepare(`
    SELECT orderId, gmid, username, spinIndex, bet, betTimePrecise FROM recon_backend_record
    WHERE env=? AND betTimePrecise IS NOT NULL AND betTimePrecise >= ? AND betTimePrecise <= ?
  `).all(env, oldest - cfg.beforeMs, now + cfg.afterMs) as BackendRound[]

  const bound = new Set(
    (db.prepare('SELECT orderId FROM recon_spin WHERE env=? AND orderId IS NOT NULL').all(env) as { orderId: string }[])
      .map(r => r.orderId))

  // ⚠️ 序列對齊的前提是「單一帳號 × 單一機台」——spin_index 是那一台自己的序號，
  //    把兩台的觀測混在同一個序列裡會從第一筆就錯位，而且錯位之後每一筆看起來都對得上。
  //    所以先分組，各組各自錨定；`bound` 跨組共用，避免同一張單被兩組搶走。
  const groups = new Map<string, typeof spins>()
  for (const s of spins) {
    const k = `${s.sessionId}|${s.machineType}`
    const g = groups.get(k); if (g) g.push(s); else groups.set(k, [s])
  }
  const decisions: AlignDecision[] = []
  for (const g of groups.values()) {
    const gmids = new Set(g.map(s => s.gmid).filter(Boolean))
    const scoped = gmids.size ? records.filter(r => gmids.has(r.gmid)) : records
    // offset 逐 (env, machineType) 估。估不出來（樣本 < 10）就退回絕對窗，
    // 由 bindMethod 標記成 absolute_window，驗收時分開算。
    // 逐機台優先；樣本不足退全域（見 estimateGlobalOffset 的雞生蛋說明）
    // 🚨 **不再用歷史偏移。**v4.115.0 那套（逐機台→全域 fallback）會把舊 session
    //    的時鐘偏差帶進來污染現在：實測拿到 +29 秒的陳舊偏移，把配對推去 29 秒外，
    //    53 局完美資料（全部落在某個 spin 的 ±2 秒內）只綁上 4 筆而且**4 筆全錯**，
    //    還餓死正主——真正對應的 spin 被標成 MISSING。那是假相符，是最壞的輸出。
    //    改用「這一輪自己算偏移」的最近鄰配對，見 bindNearestNeighbour。
    const nn = bindNearestNeighbour(g, scoped, { residualToleranceMs: RESIDUAL_TOLERANCE_MS }, bound)
    decisions.push(...nn.decisions)
    // 這一組綁掉的單要立刻進 bound，否則下一組可能重複配到同一張
    for (const d of decisions) if (d.result === 'resolved' && d.orderId) bound.add(d.orderId)
  }

  const markFirstQuery = db.prepare('UPDATE recon_spin SET firstQueriedAt=? WHERE id=? AND firstQueriedAt IS NULL')
  const setResolved = db.prepare(`
    UPDATE recon_spin SET orderId=?, status='MATCH', bindResult='resolved', boundAt=?, latencyMs=?,
      bindMethod=?, lateArrival=? WHERE id=?
  `)
  const setAmbiguous = db.prepare(`UPDATE recon_spin SET status='AMBIGUOUS', bindResult='ambiguous' WHERE id=?`)
  const setNotFound = db.prepare(`UPDATE recon_spin SET status='PENDING', bindResult='not_found' WHERE id=?`)
  const setMissing = db.prepare(`UPDATE recon_spin SET status='MISSING', bindResult='not_found' WHERE id=?`)

  let resolved = 0, ambiguous = 0, notFound = 0, missing = 0, lateRebound = 0
  const byId = new Map(spins.map(s => [s.id, s]))
  const tx = db.transaction(() => {
    for (const d of decisions) {
      markFirstQuery.run(now, d.spinId)
      const s = byId.get(d.spinId)!
      if (d.result === 'resolved') {
        // ⚠️ 這裡可能撞唯一索引（同一張單被別的 env/session 綁走）。撞到就退回 ambiguous，
        //    不要讓整個交易炸掉——一筆綁不上不該讓其他幾百筆都失敗。
        try {
          // lateArrival：這一筆本來已經被判成掉單，是紀錄晚到才綁回來的。
          // 一定要標記——不標的話，統計上看不出「門檻訂太緊」這件事。
          const wasMissing = s.status === 'MISSING'
          // 曾判掉單、現在綁回來了 → 標成已解決但保留紀錄，那正是門檻訂太緊的證據
          if (wasMissing) resolveFinding(env, 'missing', d.spinId, '紀錄晚到，已回綁')
          setResolved.run(d.orderId!, now, nowObs - s.observedAt,
            d.bindMethod ?? '', wasMissing ? 1 : 0, d.spinId)
          if (wasMissing) lateRebound++
          resolved++
        } catch {
          setAmbiguous.run(d.spinId); ambiguous++
        }
      } else if (d.result === 'ambiguous') {
        setAmbiguous.run(d.spinId); ambiguous++
        recordFinding(env, 'ambiguous', d.spinId, { severity: 'warn', note: d.reason ?? '' })
      } else if (nowObs - s.observedAt > pendingTimeoutMs) {
        // 超過門檻還沒綁上 → 掉單
        setMissing.run(d.spinId); missing++
        recordFinding(env, 'missing', d.spinId, { severity: 'critical',
          note: `超過 ${Math.round(pendingTimeoutMs / 1000)} 秒仍查無對應後台紀錄` })
      } else {
        setNotFound.run(d.spinId); notFound++
      }
    }
  })
  tx()
  /**
   * ── shadow check：唯一能真的分辨「FG」跟「begin 訊號壞掉」的訊號 ──────────
   *
   * 🚨 agent 端分不出這兩件事——兩者的症狀都是「沒有 begin、有 end、餘額有變」。
   *    能分開的只有後台：
   *
   *      FG          → 沒 begin、**後台也沒有新的一般局**
   *      begin 壞掉  → 沒 begin、**後台仍然有新的一般局**
   *
   *    所以這裡對「已經判成不可能起局」的那些 spin **仍然算一次配對，但不綁定**。
   *    如果它在後台真的找得到一張**還沒被別人認領**的單，就代表我們把真實的一局
   *    判成了沒起注——那是 begin 規則失效的實證，要立刻告警。
   *
   * ⚠️ **一定要在正式綁定「之後」才做，而且只看還沒被認領的單。**
   *    先做的話會跟真正的主人搶單；不看認領狀態的話，FG 前後相鄰的正常局
   *    會落在容忍窗內、被誤報成訊號故障。
   *
   * ⚠️ 這裡**不改任何 spin 的狀態**，只產生 finding。shadow 的意思就是不影響主流程——
   *    真要恢復配對，是人看到告警後去修 begin 偵測，不是讓它自己偷偷改判。
   */
  let beginSuspect = 0
  if (nonRoundSpins.length > 0) {
    const unclaimed = records.filter(r => !bound.has(r.orderId))
    if (unclaimed.length > 0) {
      const shadowTx = db.transaction(() => {
        // 分組規則跟正式配對完全一致（session × machineType），不另寫一套
        const shadowGroups = new Map<string, typeof nonRoundSpins>()
        for (const s of nonRoundSpins) {
          const k = `${s.sessionId}|${s.machineType}`
          const g = shadowGroups.get(k); if (g) g.push(s); else shadowGroups.set(k, [s])
        }
        for (const g of shadowGroups.values()) {
          const gmids = new Set(g.map(s => s.gmid).filter(Boolean))
          const scoped = gmids.size ? unclaimed.filter(r => gmids.has(r.gmid)) : unclaimed
          if (scoped.length === 0) continue
          const nn = bindNearestNeighbour(g, scoped, { residualToleranceMs: RESIDUAL_TOLERANCE_MS }, bound)
          for (const d of nn.decisions) {
            if (d.result !== 'resolved' || !d.orderId) continue
            if (recordFinding(env, 'begin_signal_suspect', d.spinId, {
              severity: 'warn',
              note: `判成「沒起注」的 spin 在後台找得到對應的局（${d.orderId}）`
                + '——begin 訊號可能已失效，這一局被漏記了。請檢查 pinus 攔截是否還有效。',
            })) beginSuspect++
          }
        }
      })
      shadowTx()
    }
  }
  if (beginSuspect > 0) {
    console.log(`[live-ledger] ⚠️ ${env} begin 訊號疑似失效：${beginSuspect} 筆判成沒起注的 spin 在後台找得到對應局`)
  }

  return { scanned: spins.length, resolved, ambiguous, notFound, missing, lateRebound }
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

// ─── findings（近期告警）────────────────────────────────────────────────
//
// ⚠️ **這一期能產生的是「綁定層」的 finding，不是金額 finding。**
//
// L1 的定義是「agent 觀測 bet/win ↔ 後台 bet/win」，但實測 agent 側**兩個都沒有**
// （184 筆觀測：hasBet=0、hasWin=0）——`dealGMActionReq` 的請求裡沒有 bet 欄位，
// win 也沒有被攔下來。A 側是空的，比對就不成立。這跟 L2 卡的是同一個根因
// （agent 對 pinus 訊息的攔截範圍不夠），不是這裡漏做。
//
// 所以現在寫進 recon_finding 的是：掉單、無法判定、晚到回綁。這三件都是真的、
// 都值得看，只是它們回答的是「對帳鍵健不健康」而不是「金額對不對」。
// **畫面上必須講清楚是哪一種**，否則使用者會以為金額已經驗過了。

export type FindingKind = 'missing' | 'ambiguous' | 'late_arrival' | 'l1_amount' | 'l2_balance' | 'unobserved'
  | 'begin_signal_suspect'

/**
 * 這些 outcome 的 spin **不可能擁有一局**，一律不參與配對、也不產生掉單告警。
 *
 * 🚨 **為什麼需要這條**：每按一次 Spin 就送一筆對帳紀錄，但特殊遊戲（FG/JP）期間
 *    按 Spin 不會起新的一局，後台自然沒有紀錄 → 全部被標成「後台查無此局」。
 *    實測 51 段連續 ≥5 次、最長連續 56 次，而且**其中一筆 not_started 還被綁到
 *    某張後台單**——一局根本沒起卻搶走別局的紀錄，真正的主人反而配不到。
 *
 *   `not_started`  伺服器回 errcode 明確拒絕，確定沒起
 *   `no_bet`       沒收到 moneyNtc begin，代表沒有起注扣款（多半在 FG/JP 期間）
 *
 * ⚠️ **`unknown` 刻意不列入。**它是「沒收到訊號」不是「沒發生」——實際上目前
 *    有 172 筆 unknown 已經配對成功。把不確定當成沒發生，會一次丟掉那些真實資料。
 */
const NON_ROUND_OUTCOMES = new Set(['not_started', 'no_bet'])

/**
 * 寫入 finding。同一筆 spin 的同一種 finding 只記一次——
 * ⚠️ 不去重的話，每 15 秒一輪的迴圈會把同一筆掉單重複寫成幾百列，
 *    「近期告警」就變成一直在刷同一件事，真正的新問題反而被埋掉。
 */
export function recordFinding(env: ReconEnv, kind: FindingKind, spinId: number, opts: {
  severity?: 'info' | 'warn' | 'critical'; note?: string; amountDelta?: number | null
} = {}): boolean {
  // 由 spin 衍生的 finding 沿用該 spin 的歸屬——不然異常清單還是全公開。
  // 查不到就留空字串（系統級），**不要**歸給當下的檢視者。
  const owner = (db.prepare('SELECT userLabel FROM recon_spin WHERE id=?')
    .get(spinId) as { userLabel?: string } | undefined)?.userLabel ?? ''
  const exists = db.prepare(
    `SELECT 1 FROM recon_finding WHERE env=? AND line=? AND refType='spin' AND refId=?`
  ).get(env, kind, String(spinId))
  if (exists) return false
  db.prepare(`
    INSERT INTO recon_finding (env, line, severity, refType, refId, amountDelta, detectedAt, note, userLabel)
    VALUES (?, ?, ?, 'spin', ?, ?, ?, ?, ?)
  `).run(env, kind, opts.severity ?? (kind === 'missing' ? 'critical' : 'warn'),
    String(spinId), opts.amountDelta ?? null, Date.now(), opts.note ?? '', owner)
  return true
}

export interface FindingRow {
  id: number; env: string; line: string; severity: string
  refType: string; refId: string; amountDelta: number | null
  detectedAt: number; resolvedAt: number | null; note: string
  machineType?: string; spinSeq?: number
}

/** 近期告警。已解決的（例如掉單後來回綁成功）預設不列。 */
export function recentFindings(env: ReconEnv, limit = 20, includeResolved = false, viewer: string | null = null): FindingRow[] {
  return db.prepare(`
    SELECT f.*, s.machineType, s.spinSeq
    FROM recon_finding f
    LEFT JOIN recon_spin s ON s.id = CAST(f.refId AS INTEGER) AND s.env = f.env
    WHERE f.env = ? ${includeResolved ? '' : 'AND f.resolvedAt IS NULL'}
      ${viewer === null ? '' : 'AND f.userLabel = ?'}
    ORDER BY f.detectedAt DESC LIMIT ?
  `).all(...(viewer === null ? [env, limit] : [env, viewer, limit])) as FindingRow[]
}

/**
 * 掉單後來又綁上了 → 把那筆 finding 標成已解決。
 *
 * ⚠️ **不能只是不再顯示，要留下「曾經被判成掉單」的紀錄。**
 *    那正是「pendingTimeout 訂太緊」的證據；刪掉就看不出門檻該不該調。
 */
export function resolveFinding(env: ReconEnv, kind: FindingKind, spinId: number, note = ''): void {
  db.prepare(`
    UPDATE recon_finding SET resolvedAt=?, note = CASE WHEN ?='' THEN note ELSE note || ' / ' || ? END
    WHERE env=? AND line=? AND refType='spin' AND refId=? AND resolvedAt IS NULL
  `).run(Date.now(), note, note, env, kind, String(spinId))
}

/**
 * 把「已經是 MISSING／AMBIGUOUS、但還沒有對應 finding」的舊列補上。
 *
 * ⚠️ 沒有這一步的話，畫面上的「近期告警」會是 **0 筆，而 DB 裡有 127 筆掉單**——
 *    `0` 會被讀成「沒問題」，那正是這整份規格在防的假結論。
 *    findings 是後來才加的，那些列當時沒有機會被記錄。
 *
 * 只回填最近 7 天、而且靠 `recordFinding()` 自己去重，重跑安全。
 */
/**
 * 一次性收拾「不可能起局的 spin 卻被標成掉單」的既有紀錄。
 *
 * ⚠️ **不刪任何 spin 列，也不改它的 status。**那些列是當時真實產生的觀測，
 *    改掉等於竄改歷史。這裡只做兩件事：
 *      ① 把它們既有的 `missing` 告警標成已解決，並寫明理由
 *      ② 解除「一局根本沒起，卻被綁到某張後台單」的錯誤綁定——
 *         那張單要還給真正的主人，否則正主永遠配不到（實測有 1 筆）
 *
 * 重跑安全：已解決的不會再動，已解除的不會再被選出來。
 */
export function cleanupNonRoundFindings(env: ReconEnv): { resolved: number; unbound: number } {
  const bad = db.prepare(`
    SELECT id, orderId FROM recon_spin
    WHERE env=? AND COALESCE(outcome,'') IN ('not_started','no_bet')
  `).all(env) as { id: number; orderId: string | null }[]
  let resolved = 0, unbound = 0
  const tx = db.transaction(() => {
    for (const r of bad) {
      const before = db.prepare(
        `SELECT COUNT(*) n FROM recon_finding WHERE env=? AND line='missing' AND refType='spin' AND refId=? AND resolvedAt IS NULL`
      ).get(env, String(r.id)) as { n: number }
      if (before.n > 0) {
        resolveFinding(env, 'missing', r.id,
          '這一下沒有起注（FG/JP 期間或伺服器拒絕），後台本來就不會有這一局——原本的掉單告警是誤報')
        resolved++
      }
      if (r.orderId) {
        // 一局沒起卻綁到單＝把別局的紀錄搶過來，一定是錯的
        db.prepare(`UPDATE recon_spin SET orderId=NULL, status='PENDING', bindResult=NULL,
          bindMethod='', boundAt=NULL WHERE id=?`).run(r.id)
        unbound++
      }
    }
  })
  tx()
  return { resolved, unbound }
}

export function backfillFindings(env: ReconEnv, days = 7): number {
  const since = Date.now() - days * 86400_000
  const rows = db.prepare(`
    SELECT id, status, observedAt FROM recon_spin
    WHERE env=? AND observedAt >= ? AND status IN ('MISSING','AMBIGUOUS')
      AND COALESCE(outcome,'') NOT IN ('not_started','no_bet')
  `).all(env, since) as { id: number; status: string; observedAt: number }[]
  let n = 0
  for (const r of rows) {
    const kind: FindingKind = r.status === 'MISSING' ? 'missing' : 'ambiguous'
    if (recordFinding(env, kind, r.id, {
      severity: kind === 'missing' ? 'critical' : 'warn',
      note: '（回填：findings 機制上線前就已判定）',
    })) n++
  }
  return n
}

// ─── L1 單局 / L2 餘額：金額比對 ────────────────────────────────────────
//
// ⚠️ 這兩條線在 v4.115.0 之前做不了——agent 側 `betAmount`／`winObserved` 全是 0。
//    v4.116.0 起 agent 從 `moneyNtc` 的 `reason`（begin/end）算得出來：
//      bet = 前一則 end 的 coin − 這一局 begin 的 coin
//      win = 這一局 end 的 coin − 這一局 begin 的 coin
//    實測對照後台：88 對 88、10 對 10。
//
// ⚠️ **金額為 null 一律跳過，不要當成 0 去比。**沒起局的 spin 本來就沒有金額，
//    拿 0 去比會製造一整批假不符——而假警報會訓練人忽略告警，比不比還糟。

/** 金額比對的容差。跟 BET_EPSILON 同一個量級，只留浮點誤差空間。 */
const AMOUNT_EPSILON = 0.005

export interface AmountCompareResult {
  checked: number; l1Bad: number; l2Bad: number; skipped: number
}

/**
 * 對已綁定（MATCH）且兩側金額都齊的列做 L1／L2 比對。
 *
 * L1：agent 的 bet/win ↔ 後台的 bet/win
 * L2：agent 觀測的餘額變化 ↔ (win − bet)
 *     ——「扣款但未轉成」只有這條抓得到，是整份規格價值最高的一條。
 */
export function compareAmounts(env: ReconEnv, sinceMs: number): AmountCompareResult {
  const rows = db.prepare(`
    SELECT s.id, s.spinSeq, s.betAmount aBet, s.winObserved aWin,
           s.balanceBefore, s.balanceAfter, b.bet bBet, b.win bWin
    FROM recon_spin s JOIN recon_backend_record b ON b.orderId = s.orderId AND b.env = s.env
    WHERE s.env = ? AND s.status = 'MATCH' AND s.observedAt >= ?
  `).all(env, sinceMs) as {
    id: number; spinSeq: number; aBet: number | null; aWin: number | null
    balanceBefore: number | null; balanceAfter: number | null; bBet: number; bWin: number
  }[]

  const out: AmountCompareResult = { checked: 0, l1Bad: 0, l2Bad: 0, skipped: 0 }
  for (const r of rows) {
    /**
     * 🚨 **上游資料源已知不可信時，這條線不得產生 critical。**
     *
     * 實測（2026-09-07）：123 筆 l1_amount CRITICAL **全部是假警報**——
     * 「前端 bet」是 2500／500／2250／1600 這種湊出來的數字，
     * 而後台一律 1250。成因是 `balanceAfter` 33/34 是 null，
     * 金額推導拿不到這一局的 `end`，湊出的值不是這一局的。
     *
     * 也就是說：**對帳把自己的已知壞資料當成了對方的錯。**
     *
     * ⚠️ 這不是技術問題是信任問題：對帳工具第一天喊 123 次狼，
     *    之後沒有人會再看它的告警。我們花這麼多力氣修綁定，
     *    就是為了讓它說的話有人信——這個會一次全毀。
     *
     * 判準：`balanceAfter` 是 null 就代表這一局的後半段沒抓到，
     * 金額推導不完整 → **跳過，不比對**。寧可少一筆樣本。
     */
    const derivationComplete = r.balanceAfter !== null
    const hasBet = derivationComplete && r.aBet !== null && r.aBet > 0
    const hasWin = derivationComplete && r.aWin !== null
    if (!hasBet && !hasWin) { out.skipped++; continue }
    out.checked++

    // L1：逐欄比對。缺的那一側跳過而不是當 0。
    const betBad = hasBet && Math.abs(r.aBet! - r.bBet) > AMOUNT_EPSILON
    const winBad = hasWin && Math.abs(r.aWin! - r.bWin) > AMOUNT_EPSILON
    if (betBad || winBad) {
      out.l1Bad++
      const delta = (winBad ? r.aWin! - r.bWin : 0) - (betBad ? r.aBet! - r.bBet : 0)
      recordFinding(env, 'l1_amount', r.id, {
        severity: 'critical', amountDelta: delta,
        note: [
          betBad ? `bet 前端 ${r.aBet} ≠ 後台 ${r.bBet}` : '',
          winBad ? `win 前端 ${r.aWin} ≠ 後台 ${r.bWin}` : '',
        ].filter(Boolean).join('；'),
      })
    }

    // L2：餘額變化應該等於 win − bet。
    // ⚠️ **這條是「扣款但未轉成」的唯一偵測手段。**餘額少了 bet 卻沒有對應的局，
    //    或扣了款但 win 沒進來，都會在這裡浮出來。
    if (r.balanceBefore !== null && r.balanceAfter !== null && hasBet) {
      const observed = r.balanceAfter - r.balanceBefore
      const expected = (hasWin ? r.aWin! : r.bWin) - r.aBet!
      if (Math.abs(observed - expected) > AMOUNT_EPSILON) {
        out.l2Bad++
        recordFinding(env, 'l2_balance', r.id, {
          severity: 'critical', amountDelta: observed - expected,
          note: `餘額變化 ${observed}，但依 bet/win 應為 ${expected}`,
        })
      }
    }
  }
  return out
}

// ─── 最近鄰配對（取代全域偏移那套）────────────────────────────────────
//
// 🚨 **v4.115.0 的全域偏移 fallback 會主動製造假相符。**
//
// 實測（2026-09-07，873-BULLBLITZ-0136）：後台 53 局**全部**落在某個 spin 的
// ±2 秒內，資料完美。但實際只綁上 4 筆而且**4 筆全錯**（差 27／34／28／34 秒），
// 全部標 `residual_global`。
//
// 成因：`estimateGlobalOffset()` 從整個 env 的歷史 MATCH 樣本估偏移，估出 +29 秒
// ——那是**舊 session 時鐘慢 93 秒時的產物**。現在時鐘對齊了（Δt≈0），
// 這個陳舊偏移把配對主動推去 29 秒外的那一局，而且**餓死正主**（真正對應的
// spin 被標成 MISSING）。
//
// ⚠️ 教訓：**「全域」這個假設本身要被檢驗。**偏移是時鐘關係，而時鐘關係會變；
//    拿跨時段的歷史樣本去校正當下，等於用過去的錯誤去污染現在。
//
// ⚠️ 另一條同樣重要：**金額在這裡沒有鑑別力**。後台 `bet` 恆為 1250，
//    拿常數去分辨 53 局等於沒有條件。規格書把配對鍵定成
//    「playerName ＋ 時間最近鄰 ＋ spinIndex 單調性」正是因為這件事。

/** 每一輪自我校準出來的偏移與配對結果。 */
export interface NearestBindResult {
  decisions: AlignDecision[]
  /** 這一輪從候選集自己算出來的系統性偏移（毫秒）。⚠️ 不吃歷史資料 */
  offsetMs: number
  /** 判定用的殘差上界。取「設定值」與「spin 間隔一半」的較小者 */
  toleranceMs: number
  spinGapMedianMs: number | null
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}

/**
 * 時間最近鄰配對 + spinIndex 單調性檢查。
 *
 * ⚠️ **偏移從這一輪的候選集自己算**（每一局對最近的 spin 取中位數），不吃歷史。
 *    這樣時鐘關係改變時會自動跟上，而且不可能被別的 session 污染。
 *
 * ⚠️ **距離要有上界**，而且上界要跟 spin 間隔掛鉤：最近鄰若超過半個間隔，
 *    那多半是配到隔壁那一局。實測的錯配就是 27~34 秒，而 spin 間隔約 3 秒。
 *
 * ⚠️ 一對一：一局只能配一個 spin，一個 spin 只能配一局。按殘差由小到大貪婪指派，
 *    先配最有把握的，避免「差的先搶走好的位置」。
 */
export function bindNearestNeighbour(
  spins: Array<PendingSpin & { spinSeq: number }>,
  rounds: BackendRound[],
  opts: { residualToleranceMs?: number } = {},
  alreadyBound: ReadonlySet<string> = new Set(),
): NearestBindResult {
  const free = rounds.filter(r => !alreadyBound.has(r.orderId) && Number.isFinite(r.betTimePrecise))
  const ordered = [...spins].sort((a, b) => a.spinSeq - b.spinSeq)
  const empty = { decisions: [] as AlignDecision[], offsetMs: 0, toleranceMs: 0, spinGapMedianMs: null }
  if (!ordered.length) return empty
  if (!free.length) {
    return { ...empty, decisions: ordered.map(s => ({ spinId: s.id, result: 'not_found' as const, reason: 'no_backend_rounds' })) }
  }

  // ① spin 間隔中位數（先算，因為偏移估計要用它當可信範圍）
  const gaps: number[] = []
  for (let i = 1; i < ordered.length; i++) {
    const g = ordered[i].observedAt - ordered[i - 1].observedAt
    if (g > 0 && g < 5 * 60_000) gaps.push(g)
  }
  const gapMedian = median(gaps)

  // ② 自我校準：每一局對「時間最近的 spin」的有號差，取中位數當偏移
  //
  // ⚠️ **只能用「看起來真的成對」的那些來估。**實測（2026-09-07）：
  //    873-DFDCGRAND-1111 有 16/30 的局根本沒有對應的 spin（agent 漏觀測），
  //    那些局的「最近 spin 距離」是雜訊（41~85 秒），把中位數拉到 3,194ms
  //    ——而實際多數配對只差 0.3 秒。結果是容忍值 1,458ms 反而把真正的配對
  //    全部擋在外面：**離 spin 只有 0.3 秒的局配不上**。
  //
  //    這是「用雜訊校準訊號」：漏觀測越多，偏移估得越歪，配對率越低，
  //    看起來就越像綁定器壞掉——而其實是 agent 漏觀測造成的二次傷害。
  const allDeltas = free.map(r => {
    let best = Infinity
    for (const s of ordered) {
      const d = r.betTimePrecise - s.observedAt
      if (Math.abs(d) < Math.abs(best)) best = d
    }
    return best
  }).filter(Number.isFinite)
  // 可信範圍：一個 spin 間隔以內（再寬就可能是配到隔壁那一局），至少 5 秒
  const plausible = Math.max(gapMedian ?? 5000, 5000)
  const trusted = allDeltas.filter(d => Math.abs(d) <= plausible)
  // ⚠️ **可信樣本不足時用 0，不要退回未過濾的中位數。**
  //    我第一版寫 `trusted.length >= 3 ? trusted : allDeltas`——那是拿雜訊當預設值：
  //    候選集裡若沒有幾對真的成對，`allDeltas` 的中位數可能是好幾小時，
  //    再套上 ±2.6 秒的容忍，就會把幾小時外的局配上來。實測這個 fallback
  //    一次製造了 **48 筆配錯**。
  //
  //    偏移 0 是安全的失敗方式：配不到就是配不到，不會配錯。
  //    跟「缺值就補一個保守的預設」同一條——退路不能比沒有退路更危險。
  const offsetMs = trusted.length >= 3 ? (median(trusted) ?? 0) : 0
  const configured = opts.residualToleranceMs ?? RESIDUAL_TOLERANCE_MS
  /**
   * 上界。⚠️ **一定要小於 spin 間隔**，否則「差一位」也落在容忍內、這條就形同虛設。
   *
   * ⚠️ 但也不能取半個間隔——那是在「貪婪一對一 + spinIndex 單調性」兩道保護
   *    加進來之前訂的保守值。實測（2026-09-07）真實抖動達 2.0~2.8 秒，
   *    而 spin 間隔約 2.9 秒 → 半個間隔 1.46 秒**把合法配對擋在外面**：
   *    離 spin 只有 1.2~2.0 秒的局配不上，看起來像綁定率低，其實是門檻太緊。
   *
   *    取 0.9 個間隔：仍然小於一個間隔（差一位到不了），而且真正的配對因為
   *    殘差更小、在貪婪指派時會先被配走，隔壁那局搶不到。
   */
  const toleranceMs = gapMedian
    ? Math.max(500, Math.min(configured, Math.floor(gapMedian * 0.9)))
    : configured

  // ③ 產生所有可接受的配對，按殘差由小到大貪婪一對一指派
  type Pair = { si: number; ri: number; residual: number; delta: number }
  const pairs: Pair[] = []
  ordered.forEach((s, si) => {
    free.forEach((r, ri) => {
      const delta = r.betTimePrecise - s.observedAt
      const residual = Math.abs(delta - offsetMs)
      if (residual <= toleranceMs) pairs.push({ si, ri, residual, delta })
    })
  })
  pairs.sort((a, b) => a.residual - b.residual)
  const spinTaken = new Map<number, Pair>()
  const roundTaken = new Set<number>()
  for (const p of pairs) {
    if (spinTaken.has(p.si) || roundTaken.has(p.ri)) continue
    spinTaken.set(p.si, p); roundTaken.add(p.ri)
  }

  // ④ spinIndex 單調性：配好之後，spinIndex 必須隨 spinSeq 遞增
  //    ⚠️ 違反就退回 AMBIGUOUS，**不硬綁**——那是「整段偏移」的唯一徵兆。
  const assigned = [...spinTaken.entries()].sort((a, b) => a[0] - b[0])
  const bad = new Set<number>()
  let lastIdx = -Infinity
  for (const [si, p] of assigned) {
    const idx = free[p.ri].spinIndex
    if (idx <= lastIdx) bad.add(si)
    else lastIdx = idx
  }

  const decisions: AlignDecision[] = ordered.map((s, si) => {
    const p = spinTaken.get(si)
    if (!p) return { spinId: s.id, result: 'not_found', reason: 'no_candidate_in_tolerance' }
    if (bad.has(si)) {
      return {
        spinId: s.id, result: 'ambiguous',
        reason: `spin_index_not_monotonic:${free[p.ri].spinIndex}`,
        verify: { timeOk: false, deltaMs: p.delta },
      }
    }
    return {
      spinId: s.id, result: 'resolved',
      orderId: free[p.ri].orderId, spinIndex: free[p.ri].spinIndex,
      bindMethod: 'nearest',
      verify: { timeOk: true, latencyOk: true, deltaMs: p.delta },
    }
  })
  return { decisions, offsetMs, toleranceMs, spinGapMedianMs: gapMedian }
}

/**
 * 把伺服器的 `now` 換算到 `observedAt` 所在的時間軸。
 *
 * ⚠️ **老化計算一邊校正一邊不校正，門檻就會變成別的數字。**
 *
 * 實測（2026-09-07）：`recon_source_health.clockOffsetMs = 92914`（本機比後台慢 93 秒），
 * 而 `observedAt` 跟後台 `dateTime` 對得到同一秒（53 局全部落在 ±2 秒內）。
 * 也就是說 `observedAt` 在「後台時間軸」上，而 `now` 在「本機時間軸」上——
 * 兩者相減會少算 93 秒，**90 秒的 MISSING 門檻實際變成 183 秒**。
 *
 * 實證分界：MISSING/PENDING 的界線落在 01:46:23，正好等於
 * `now(01:49:26) − 93s − 90s`。不是推論，是對得上的。
 *
 * ⚠️ 這裡用的是「本機 vs 後台 web」的偏移，而它**跟配對用的偏移不是同一個**
 *    （配對那個要從資料自己算，見 bindNearestNeighbour）。這裡可以用它，是因為
 *    實測 `observedAt` 與後台 `dateTime` 幾乎重合——agent 的時鐘跟後台對得上。
 *    這個前提哪天不成立，這個換算也要跟著重新驗。
 */
export function nowOnObservedAxis(env: ReconEnv, now = Date.now()): number {
  try {
    const r = db.prepare(`SELECT clockOffsetMs FROM recon_source_health WHERE env=? AND source='clock'`)
      .get(env) as { clockOffsetMs: number | null } | undefined
    const off = r?.clockOffsetMs
    return Number.isFinite(off) ? now + (off as number) : now
  } catch { return now }
}

// ─── 反向檢查：後台有局、但前端從頭到尾沒觀測到 ──────────────────────
//
// 🚨 **這是整個資料流的方向盲點，不是邊角案例。**
//
// 現況是 **spin-driven**：`recon_spin` 是驅動表，後台紀錄只是拿來配對的素材。
// 所以「後台有一局、agent 從頭到尾沒觀測到」這件事**不會出現在任何地方**
// ——不是被標成異常，是**根本不存在於畫面上**。
//
// 實測（2026-09-07）：後台在 25 秒內連續成局 8 次（spinIndex 5671~5678 無缺口），
// 而整段只有 1 筆 spin 觀測。舊的查法完全看不到這 8 局。
//
// ⚠️ 對 QA 來說這恰好是最值錢的一類發現，因為它有三種可能、每一種的處理都不同：
//   ① agent 漏觀測（跟「按了 34 次只成局 11 次」是同一問題的反面）
//   ② 機台自己連續跑（免費遊戲／自動旋轉），一次動作產生多局
//   ③ **同一個帳號有別人在玩** ← 不報出來的話，所有金額比對都在跟別人的局混算
//
// ⚠️ 一定要排除「還在等 spin 上報」的尾端窗口，否則最近幾秒的局會一直誤報。

export interface UnobservedRound {
  orderId: string; gmid: string; username: string
  spinIndex: number; bet: number; win: number; betTimePrecise: number
}

/**
 * 找出「後台有紀錄、但沒有任何 spin 綁到」的局。
 *
 * `tailGraceMs` 是尾端寬限——比這個新的局不算，因為 agent 的觀測可能還在路上。
 * 預設用跟 MISSING 同一個門檻，兩邊的「等多久才算異常」保持一致。
 */
export function findUnobservedRounds(
  env: ReconEnv, sinceMs: number, now = Date.now(), tailGraceMs?: number,
): UnobservedRound[] {
  const grace = tailGraceMs ?? reconSetting(env, 'pendingTimeoutSec') * 1000
  // ⚠️ 時間比較一律用校正後的軸——betTimePrecise 在後台軸上（見 nowOnObservedAxis）
  const cutoff = nowOnObservedAxis(env, now) - grace
  return db.prepare(`
    SELECT b.orderId, b.gmid, b.username, b.spinIndex, b.bet, b.win, b.betTimePrecise
    FROM recon_backend_record b
    WHERE b.env = ? AND b.betTimePrecise >= ? AND b.betTimePrecise <= ?
      AND NOT EXISTS (
        SELECT 1 FROM recon_spin s WHERE s.env = b.env AND s.orderId = b.orderId
      )
    ORDER BY b.betTimePrecise
  `).all(env, sinceMs, cutoff) as UnobservedRound[]
}

/**
 * 把「有單無 spin」落成 finding。
 *
 * ⚠️ 這類 finding 的 `refType` 是 `round` 不是 `spin`——它本來就沒有對應的 spin，
 *    硬塞進 spin 的命名空間會讓「哪一筆」查不回去。
 */
export function recordUnobservedFindings(env: ReconEnv, rounds: UnobservedRound[]): number {
  const exists = db.prepare(
    `SELECT 1 FROM recon_finding WHERE env=? AND line='unobserved' AND refType='round' AND refId=?`)
  const ins = db.prepare(`
    INSERT INTO recon_finding (env, line, severity, refType, refId, amountDelta, detectedAt, note, userLabel)
    VALUES (?, 'unobserved', 'warn', 'round', ?, ?, ?, ?, '')
  `)
  let n = 0
  const tx = db.transaction(() => {
    for (const r of rounds) {
      if (exists.get(env, r.orderId)) continue
      ins.run(env, r.orderId, r.bet ?? null, Date.now(),
        `後台有局但前端沒有觀測到（${r.gmid} idx=${r.spinIndex} bet=${r.bet}）`
        + '——可能是 agent 漏觀測、機台自己連續跑，或**同一個帳號有別人在玩**')
      n++
    }
  })
  tx()
  return n
}

/**
 * 後來綁上了的局，把它的 `unobserved` finding 標成已解決。
 *
 * ⚠️ **任何「由缺席推導出來的狀態」都必須可撤銷。**缺席隨時可能只是還沒到。
 *    這正是 MISSING 那個舊陷阱在新線上重演——當初 MISSING 就是因為
 *    「一旦標記就不再回頭看」而失真，實測 29 筆裡有 9 筆是這樣來的誤報。
 *
 * ⚠️ 保留紀錄不刪：那是「寬限窗訂太緊」的證據，刪掉就看不出門檻該不該調
 *    （跟 MISSING 的 lateArrival 同一個理由）。
 */
export function resolveBoundUnobserved(env: ReconEnv): number {
  return db.prepare(`
    UPDATE recon_finding SET resolvedAt = ?,
      note = note || '｜後來綁上了（誤報，寬限窗可能太緊）'
    WHERE env = ? AND line = 'unobserved' AND refType = 'round' AND resolvedAt IS NULL
      AND EXISTS (SELECT 1 FROM recon_spin s WHERE s.env = recon_finding.env AND s.orderId = recon_finding.refId)
  `).run(Date.now(), env).changes
}

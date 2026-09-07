/**
 * server/live-ledger-query.ts — 對帳台畫面要的查詢。
 *
 * ⚠️ 這一層最重要的責任是**誠實回報「沒有結論」**。
 *
 * 規格書第一條原則：「對帳工具最危險的失敗不是報錯，是安靜地報一切正常。」
 * 對應到資料層就是：
 *
 *   · 還沒實作的對帳線回 `implemented: false` + `reason`，**不回 0**
 *   · 資料源掛掉回 `state: 'bad'`，該區間的數字回 `null`，**不回 0**
 *   · 每個比率都附樣本數（3 筆對到 3 筆也是 100%）
 *
 * `0` 是一個結論，`null`（畫面上的「—」）是沒有結論。這兩者在對帳工具上
 * 是完全不同的意思，混用等於主動誤導。
 */
import { db } from './shared.js'
import { recentFindings, nowOnObservedAxis, findUnobservedRounds, type FindingRow } from './live-ledger.js'
import { jpSummary } from './live-ledger-jp.js'
import type { ReconEnv } from './live-ledger.js'

export type LampState = 'ok' | 'warn' | 'bad' | 'unwired'

export interface Lamp {
  key: string
  label: string
  state: LampState
  /** 距上次成功多久（秒）。⚠️ 健康列要顯示這個，不是「延遲幾毫秒」——
   *  延遲數字在資料源斷掉那一刻會**停住不動**，看起來永遠健康。 */
  agoSec: number | null
  note: string
  /** 附註數值（例如時鐘偏移量）。延遲毫秒只能當附註，不能當主指標 */
  detail?: string
}

export interface LedgerLine {
  id: string
  name: string
  desc: string
  implemented: boolean
  /** 金額比對過的筆數 / 其中不符的筆數。⚠️ 附樣本數，3 筆對到 3 筆也是 100% */
  amountChecked?: number
  amountBad?: number
  /** 未實作時說明缺什麼——不寫的話畫面上只會是一個空格，看不出是「沒問題」還是「沒做」 */
  reason?: string
  counts?: { match: number; pending: number; missing: number; ambiguous: number }
  /** 金額差。P0 沒有金額比對，所以一律 null（畫面顯示「—」） */
  delta: number | null
}

const PENDING_TIMEOUT_DEFAULT = 90

function setting(env: ReconEnv, key: string, dflt: number): number {
  try {
    const r = db.prepare('SELECT value FROM recon_settings WHERE env=? AND key=?').get(env, key) as { value: number } | undefined
    return r?.value ?? dflt
  } catch { return dflt }
}

/** 資料源健康列。⚠️ LuckyLink 是 `unwired` 不是 `ok`——沒串接不等於健康。 */
export function healthLamps(env: ReconEnv, now = Date.now()): Lamp[] {
  const ago = (ts: number | null | undefined) => (ts ? Math.round((now - ts) / 1000) : null)

  // agent：最近一筆觀測進來多久了
  const lastSpin = db.prepare('SELECT MAX(observedAt) t FROM recon_spin WHERE env=?').get(env) as { t: number | null }
  const agentAgo = ago(lastSpin?.t)

  // 後台拉取與寫入點的健康，來自 recon_source_health
  const rows = db.prepare('SELECT source, lastOkAt, lastErrAt, failCount, errKind, message, clockOffsetMs, clockCheckedAt FROM recon_source_health WHERE env=?')
    .all(env) as { source: string; lastOkAt: number | null; lastErrAt: number | null; failCount: number; errKind: string | null; message: string | null; clockOffsetMs: number | null; clockCheckedAt: number | null }[]
  const bySource = new Map(rows.map(r => [r.source, r]))

  const backend = bySource.get('gameRecordList')
  const backendAgo = ago(backend?.lastOkAt)
  // 失敗次數比「多久沒成功」更早反映問題，但兩者都要看
  const backendState: LampState = !backend ? 'warn'
    : (backend.failCount > 0 ? 'bad' : (backendAgo !== null && backendAgo > 120 ? 'warn' : 'ok'))

  const writer = bySource.get('recon-spin')

  return [
    {
      key: 'agent', label: 'AutoSpin agent',
      state: agentAgo === null ? 'warn' : (agentAgo > 120 ? 'bad' : agentAgo > 30 ? 'warn' : 'ok'),
      agoSec: agentAgo,
      note: agentAgo === null ? '沒有任何觀測' : '距最後一筆觀測',
    },
    {
      key: 'backend', label: 'OSM 後台',
      state: backendState, agoSec: backendAgo,
      note: backend?.failCount ? (backend.message || backend.errKind || '拉取失敗')
        : (backendAgo === null ? '尚未成功拉取過' : '距上次成功拉取'),
    },
    {
      key: 'luckylink', label: 'LuckyLink',
      // ⚠️ 兩支報表分開看——合成一盞燈的話，哪一支壞掉分不出來。
      //    任一支失敗就亮紅；都沒量測過才是 warn（不是綠）。
      state: (() => {
        const pc = bySource.get('poolChangeReport'); const aw = bySource.get('awardsReport')
        if (!pc && !aw) return 'warn' as LampState
        if ((pc?.failCount ?? 0) > 0 || (aw?.failCount ?? 0) > 0) return 'bad' as LampState
        return 'ok' as LampState
      })(),
      agoSec: ago(bySource.get('poolChangeReport')?.lastOkAt),
      note: (() => {
        const pc = bySource.get('poolChangeReport'); const aw = bySource.get('awardsReport')
        const bad = [pc?.failCount ? `池變動：${pc.message || pc.errKind}` : '', aw?.failCount ? `中獎：${aw.message || aw.errKind}` : ''].filter(Boolean)
        return bad.length ? bad.join('；') : '池變動／中獎兩支報表'
      })(),
    },
    (() => {
      // 時鐘偏移燈。⚠️ 這盞只反映「本機 vs 後台 web」，**不是**配對用的偏移——
      //    兩者實測差 64.5 秒。它的用途是：偏移大到離譜時要看得見（那 94 秒
      //    如果早就顯示出來，就不用查到最後）。
      const c = bySource.get('clock')
      const off = c?.clockOffsetMs ?? null
      const bad = off !== null && Math.abs(off) > 5000
      return {
        key: 'clock', label: '時鐘偏移',
        state: (off === null ? 'warn' : bad ? 'warn' : 'ok') as LampState,
        agoSec: ago(c?.clockCheckedAt),
        note: off === null ? '尚未量測'
          : `本機比後台 web ${off > 0 ? '慢' : '快'} ${Math.abs(Math.round(off / 1000))} 秒`
            + '（僅供觀測，不參與配對校正）',
        detail: off === null ? '—' : `${off > 0 ? '+' : ''}${(off / 1000).toFixed(1)}s`,
      }
    })(),
    {
      key: 'engine', label: '對帳引擎',
      state: writer?.failCount ? 'bad' : 'ok',
      agoSec: ago(writer?.lastOkAt) ?? agentAgo,
      note: writer?.failCount ? `觀測落庫連續失敗：${writer.message || ''}` : '15 秒週期',
    },
  ]
}

export interface Overview {
  ok: true
  env: ReconEnv
  windowMinutes: number
  /** 這一頁在看誰的資料。null＝跨使用者檢視（除錯用）。⚠️ 顯示分流，不是權限 */
  viewer: string | null
  /** 這個範圍內有多少筆歸不了戶（早於 userLabel 欄位上線）。⚠️ 不能預設歸給檢視者 */
  unattributed: number
  session: { sessionId: string; machineType: string; firstAt: number; lastAt: number } | null
  health: Lamp[]
  kpi: {
    coverage: { matched: number; eligible: number; total: number; ratio: number | null
      strict: number; fallback: number; unlabelled: number }
    /** ⚠️ 規格書說這是「這頁的頭號數字」，但 P0 只做綁定不做金額比對 → null */
    netDelta: null
    netDeltaReason: string
    missing: { count: number; oldestAgeSec: number | null }
    mismatch: null
    mismatchReason: string
    pending: { total: number; a0_30: number; a30_90: number; a90: number }
    ambiguous: number
  }
  lines: LedgerLine[]
  timeline: { at: number; worst: string; n: number }[]
  bindMethods: { residual: number; absolute_window: number; unknown: number }
  lateRebound: number
  pendingTimeoutSec: number
  findings: FindingRow[]
  /** 後台有局、前端從頭到尾沒觀測到的筆數。⚠️ 這個方向原本完全看不到 */
  unobserved: number
  jp: ReturnType<typeof jpSummary>
}

/**
 * 主畫面資料。
 *
 * ⚠️ `eligible`（覆蓋率的分母）**只算真的成局的 spin**。實測約 29% 的 spin
 *    根本沒起局，那些本來就不會有後台紀錄——混進分母會讓對帳看起來像壞了
 *    （48/139 = 34.5% vs 48/59 = 81.4%，兩個數字導向完全相反的結論）。
 *    舊資料沒有 outcome 欄位，那時一律算進 eligible（保守，寧可低估覆蓋率）。
 */
/**
 * ⚠️ `viewer` 是**顯示分流**，不是權限隔離——過濾值來自 client 自己送的 header。
 *    傳 null 代表跨使用者檢視（除錯用），畫面上要標清楚。
 */
export function overview(env: ReconEnv, windowMinutes = 30, now = Date.now(), viewer: string | null = null): Overview {
  const since = now - windowMinutes * 60_000
  const timeoutSec = setting(env, 'pendingTimeoutSec', PENDING_TIMEOUT_DEFAULT)

  const rows = db.prepare(`
    SELECT id, sessionId, machineType, status, observedAt, outcome, bindMethod, lateArrival, userLabel
    FROM recon_spin WHERE env=? AND observedAt >= ?
      ${viewer === null ? '' : 'AND userLabel = ?'}
    ORDER BY observedAt
  `).all(...(viewer === null ? [env, since] : [env, since, viewer])) as {
    id: number; sessionId: string; machineType: string; status: string
    observedAt: number; outcome: string; bindMethod: string; lateArrival: number; userLabel: string
  }[]

  /**
   * 這些 outcome 的 spin **不可能起局**，所以不該出現在任何「還在等」的數字裡。
   *
   * 🚨 `no_bet` 原本漏了：它的 status 停在 `PENDING`，於是畫面把它算進
   *    「等待入帳」、逐筆明細也寫「尚未入帳（還在等，不是問題）」——
   *    **但它按設計永遠不會入帳。**把不會發生的事說成「還在等」，
   *    比不顯示更糟：使用者會一直等一個不會來的東西
   *    （2026-09-07 使用者直接指出這點）。
   */
  const NOT_STARTED = new Set(['not_started', 'no_bet'])
  const eligibleRows = rows.filter(r => !r.outcome || !NOT_STARTED.has(r.outcome))
  const matched = rows.filter(r => r.status === 'MATCH').length
  const missingRows = rows.filter(r => r.status === 'MISSING')
  // ⚠️ 待入帳只算「真的有起局、只是還沒回來」的那些
  const pendingRows = rows.filter(r => r.status === 'PENDING' && !NOT_STARTED.has(r.outcome ?? ''))
  const noRoundCount = rows.filter(r => NOT_STARTED.has(r.outcome ?? '')).length
  const ambiguous = rows.filter(r => r.status === 'AMBIGUOUS').length

  // ⚠️ 年齡也要用校正後的時間軸，否則畫面上的 0–30s／30–90s 分桶跟
  //    MISSING 判定用的是兩把不同的尺（見 nowOnObservedAxis）。
  const nowObs = nowOnObservedAxis(env, now)
  const age = (r: { observedAt: number }) => (nowObs - r.observedAt) / 1000
  const pending = {
    total: pendingRows.length,
    /** 沒起注、不需入帳的筆數。分開報，不要混進待入帳。 */
    noRound: noRoundCount,
    a0_30: pendingRows.filter(r => age(r) < 30).length,
    a30_90: pendingRows.filter(r => age(r) >= 30 && age(r) < 90).length,
    a90: pendingRows.filter(r => age(r) >= 90).length,
  }

  const last = rows[rows.length - 1]
  const sessionRows = last ? rows.filter(r => r.sessionId === last.sessionId) : []
  const session = last ? {
    sessionId: last.sessionId, machineType: last.machineType,
    firstAt: sessionRows[0]!.observedAt, lastAt: last.observedAt,
  } : null

  // 時間軸：每 5 分鐘一格，顏色取該格**最嚴重**的狀態（不是平均）。
  // ⚠️ 平均會把「一格內有一筆掉單」稀釋掉，而那正是要看見的東西。
  const SEVERITY = ['match', 'pending', 'ambiguous', 'missing']
  const buckets = new Map<number, { worst: string; n: number }>()
  for (const r of rows) {
    const k = Math.floor(r.observedAt / 300_000) * 300_000
    const s = r.status.toLowerCase()
    const cur = buckets.get(k)
    if (!cur) buckets.set(k, { worst: s, n: 1 })
    else {
      cur.n++
      if (SEVERITY.indexOf(s) > SEVERITY.indexOf(cur.worst)) cur.worst = s
    }
  }
  // 補上沒有 spin 的空格——「沒有 spin」跟「有 spin 但沒問題」要分得出來
  const timeline: { at: number; worst: string; n: number }[] = []
  const firstBucket = Math.floor(since / 300_000) * 300_000
  for (let t = firstBucket; t <= now; t += 300_000) {
    const b = buckets.get(t)
    timeline.push({ at: t, worst: b?.worst ?? 'none', n: b?.n ?? 0 })
  }

  const bindMethods = { residual: 0, absolute_window: 0, unknown: 0 }
  for (const r of rows) {
    if (r.status !== 'MATCH') continue
    if (r.bindMethod === 'residual') bindMethods.residual++
    else if (r.bindMethod === 'absolute_window') bindMethods.absolute_window++
    else bindMethods.unknown++
  }

  const oldestMissing = missingRows.length ? Math.max(...missingRows.map(age)) : null

  // L4/L5 的統計來自 JP 那兩張表（跟 spin 無關——池是整個群組共用的）
  const jp = jpSummary(env, since)
  // L1/L2 的金額比對統計（只算已 MATCH 且兩側金額都齊的列）
  const amt = amountStats(env, since, viewer)
  const lines: LedgerLine[] = [
    {
      id: 'L1', name: '單局', desc: 'agent 觀測 ↔ gameRecordList · key=orderId',
      implemented: true,
      counts: { match: matched, pending: pending.total, missing: missingRows.length, ambiguous },
      delta: null,
      // 金額比對的樣本數與不符筆數（v4.116.0 起 agent 有 bet/win 了）
      amountChecked: amt.checked, amountBad: amt.l1Bad,
    },
    {
      id: 'L2', name: '餘額', desc: '觀測餘額變化 ↔ (win − bet) · 抓「扣款但未轉成」',
      implemented: true, delta: null,
      counts: { match: amt.checked - amt.l2Bad, pending: 0, missing: 0, ambiguous: amt.l2Bad },
      amountChecked: amt.checked, amountBad: amt.l2Bad,
    },
    {
      id: 'L3', name: '上下分', desc: '入離機事件 ↔ EGM Transfer',
      implemented: false, delta: null,
      reason: '尚未拉取 EGM Transfer 報表。',
    },
    {
      id: 'L4', name: 'JP 中獎', desc: 'awardsReport 三條等式 · 自洽／basevalue／跨報表',
      implemented: true, delta: null,
      counts: { match: jp.awards - jp.awardsBad, pending: 0, missing: 0, ambiguous: jp.awardsBad },
    },
    {
      id: 'L5', name: 'JP 池', desc: 'poolChangeReport · change ≈ coinInΔ × increment%',
      implemented: true, delta: null,
      // skipped 歸在 pending：它們是「刻意沒驗」（中獎那筆／池已滿頂），不是問題也不是通過
      counts: { match: jp.poolOk, pending: jp.poolSkipped, missing: 0, ambiguous: jp.poolMismatch },
    },
  ]

  return {
    ok: true, env, windowMinutes, viewer,
    unattributed: viewer === null ? rows.filter(r => !r.userLabel).length : 0,
    session,
    health: healthLamps(env, now),
    kpi: {
      coverage: {
        matched, eligible: eligibleRows.length, total: rows.length,
        ratio: eligibleRows.length ? matched / eligibleRows.length : null,
        // ⚠️ 嚴格與寬鬆一定要分開。兩者信心度差一個數量級（殘差 ±5s vs 絕對窗 ±30s），
        //    混成一個回填率＝把「嚴格對上的」和「寬鬆撿到的」當成同一件事。
        strict: bindMethods.residual,
        fallback: bindMethods.absolute_window,
        unlabelled: bindMethods.unknown,
      },
      netDelta: null,
      netDeltaReason: 'P0 只建立對帳鍵（綁定），還沒做任何金額比對。有了金額比對才算得出累計差額。',
      missing: { count: missingRows.length, oldestAgeSec: oldestMissing === null ? null : Math.round(oldestMissing) },
      mismatch: null,
      mismatchReason: '金額比對尚未實作，因此不會有「不符」判定——這裡顯示 0 會讓人以為已經驗過了。',
      pending, ambiguous,
    },
    lines, timeline, bindMethods,
    lateRebound: rows.filter(r => r.lateArrival === 1).length,
    findings: recentFindings(env, 20, false, viewer),
    // 🚨 後台有局但前端沒觀測到。⚠️ **不套 viewer 過濾**——它本來就沒有對應的
    //    spin，也就沒有歸屬；而且「有別人在玩同一個帳號」正是它要抓的其中一種可能，
    //    照 viewer 篩會把那種情況篩掉。
    unobserved: findUnobservedRounds(env, since, now).length,
    jp,
    pendingTimeoutSec: timeoutSec,
  }
}

export interface LedgerRow {
  id: number
  observedAt: number
  machineType: string
  gmid: string
  spinSeq: number
  status: string
  outcome: string
  bindMethod: string
  lateArrival: number
  latencyMs: number | null
  orderId: string | null
  betFront: number | null
  balanceBefore: number | null
  balanceAfter: number | null
  betBackend: number | null
  winBackend: number | null
  spinIndex: number | null
  betTimePrecise: number | null
}

/**
 * 逐筆對帳表。游標分頁（不是頁碼）——即時流上用翻頁會跟新資料打架。
 *
 * ⚠️ 前端與後台的同一個欄位要**並排**顯示，不是只給差值。並排才看得出是誰記錯；
 *    只給差值就只能相信工具（規格書明訂）。缺的一側回 null，畫面顯示「—」不是 0。
 */
export function ledgerRows(env: ReconEnv, opts: {
  limit?: number; cursor?: number | null; filter?: 'all' | 'abnormal' | 'pending'
  /** ⚠️ 顯示分流用，不是權限隔離。null＝跨使用者檢視 */
  viewer?: string | null
  /** ⚠️ 一定要跟 overview 吃同一個時間視窗。少了它，KPI 顯示「掉單 0」而下面
   *  表格滿是掉單——同一畫面兩個分母，使用者不知道該信哪個。 */
  minutes?: number
  now?: number
} = {}): { rows: LedgerRow[]; nextCursor: number | null } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const where: string[] = ['s.env = ?']
  const args: unknown[] = [env]
  if (opts.minutes) {
    where.push('s.observedAt >= ?')
    args.push((opts.now ?? Date.now()) - opts.minutes * 60_000)
  }
  if (opts.cursor) { where.push('s.observedAt < ?'); args.push(opts.cursor) }
  if (opts.viewer) { where.push('s.userLabel = ?'); args.push(opts.viewer) }
  if (opts.filter === 'abnormal') where.push(`s.status IN ('MISSING','AMBIGUOUS')`)
  else if (opts.filter === 'pending') where.push(`s.status = 'PENDING'`)

  const rows = db.prepare(`
    SELECT s.id, s.observedAt, s.machineType, s.gmid, s.spinSeq, s.status, s.outcome,
           s.bindMethod, s.lateArrival, s.latencyMs, s.orderId,
           s.betAmount AS betFront, s.balanceBefore, s.balanceAfter,
           b.bet AS betBackend, b.win AS winBackend, b.spinIndex, b.betTimePrecise
    FROM recon_spin s
    LEFT JOIN recon_backend_record b ON b.orderId = s.orderId AND b.env = s.env
    WHERE ${where.join(' AND ')}
    ORDER BY s.observedAt DESC LIMIT ?
  `).all(...args, limit + 1) as LedgerRow[]

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    rows: page.map(r => ({
      ...r,
      // ⚠️ agent 側目前拿不到 bet，落庫是 0。回 null 讓畫面顯示「—」——
      //    顯示 0 會被讀成「這局下注 0 元」，那是假資料不是缺資料。
      betFront: r.betFront && r.betFront > 0 ? r.betFront : null,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.observedAt : null,
  }
}

/** 單筆下鑽：三方原始資料。這是**唯一**顯示原始資料的地方，上面都是結論。 */
export function ledgerDetail(env: ReconEnv, id: number, viewer: string | null = null): {
  ok: boolean
  spin?: Record<string, unknown>
  backend?: Record<string, unknown> | null
  backendRaw?: unknown
  luckylink: { available: false; reason: string }
} {
  const spin = db.prepare('SELECT * FROM recon_spin WHERE env=? AND id=?').get(env, id) as Record<string, unknown> | undefined
  // 不是自己的就當作找不到（顯示分流；真要擋要用登入身分）
  if (spin && viewer && spin.userLabel !== viewer) return { ok: false, luckylink: { available: false, reason: '不在目前檢視範圍' } }
  if (!spin) return { ok: false, luckylink: { available: false, reason: '尚未串接' } }
  let backend: Record<string, unknown> | null = null
  let backendRaw: unknown = null
  if (spin.orderId) {
    const b = db.prepare('SELECT * FROM recon_backend_record WHERE env=? AND orderId=?')
      .get(env, spin.orderId) as Record<string, unknown> | undefined
    if (b) {
      backend = b
      try { backendRaw = b.raw ? JSON.parse(String(b.raw)) : null } catch { backendRaw = b.raw }
    }
  }
  return {
    ok: true, spin, backend, backendRaw,
    // ⚠️ 「本來就沒有」跟「該有卻沒抓到」要分開講（規格書要求）。
    //
    // 🚨 **這句原本寫「L4／L5 未實作」，那是錯的**——它們早就實作了，
    //    JP cycle 每 60 秒還在跑。使用者因此來問「L4/L5 什麼時候要做」。
    //
    //    真正的原因是**它們不是逐 spin 的線**：JP 池與中獎是整個群組共用的，
    //    跟哪一次 spin 無關，所以單筆明細本來就不會有 LuckyLink 資料。
    //    要看它們得去上方的線別統計。
    luckylink: {
      available: false,
      reason: 'L4／L5 是群組層級的比對（JP 池／中獎），不掛在單一 spin 上——請看上方的線別統計',
    },
  }
}

/**
 * 金額比對的統計（純讀，不重算——重算會在每次開畫面時重複寫 finding）。
 *
 * ⚠️ `checked` 是**分母**：只算「已 MATCH 且 agent 側金額算得出來」的列。
 *    沒起局的 spin 本來就沒有金額，混進分母會讓不符率看起來很低。
 */
export function amountStats(env: ReconEnv, sinceMs: number, viewer: string | null = null): {
  checked: number; l1Bad: number; l2Bad: number
} {
  const r = db.prepare(`
    SELECT COUNT(*) checked FROM recon_spin s
    JOIN recon_backend_record b ON b.orderId = s.orderId AND b.env = s.env
    WHERE s.env=? AND s.status='MATCH' AND s.observedAt >= ?
      AND (s.betAmount > 0 OR s.winObserved IS NOT NULL)
      ${viewer === null ? '' : 'AND s.userLabel = ?'}
  `).get(...(viewer === null ? [env, sinceMs] : [env, sinceMs, viewer])) as { checked: number }
  const f = db.prepare(`
    SELECT line, COUNT(*) n FROM recon_finding
    WHERE env=? AND detectedAt >= ? AND line IN ('l1_amount','l2_balance')
      ${viewer === null ? '' : 'AND userLabel = ?'}
    GROUP BY line
  `).all(...(viewer === null ? [env, sinceMs] : [env, sinceMs, viewer])) as { line: string; n: number }[]
  const by = new Map(f.map(x => [x.line, x.n]))
  return { checked: r?.checked ?? 0, l1Bad: by.get('l1_amount') ?? 0, l2Bad: by.get('l2_balance') ?? 0 }
}

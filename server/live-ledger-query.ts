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
}

export interface LedgerLine {
  id: string
  name: string
  desc: string
  implemented: boolean
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
  const rows = db.prepare('SELECT source, lastOkAt, lastErrAt, failCount, errKind, message FROM recon_source_health WHERE env=?')
    .all(env) as { source: string; lastOkAt: number | null; lastErrAt: number | null; failCount: number; errKind: string | null; message: string | null }[]
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
      // ⚠️ 刻意是 unwired 不是 ok。JP 那兩條線（L4/L5）一支 API 都還沒串，
      //    畫成綠燈等於宣稱「JP 對帳正常」，而它根本沒在對。
      state: 'unwired', agoSec: null, note: '尚未串接（L4／L5 未實作）',
    },
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
  session: { sessionId: string; machineType: string; firstAt: number; lastAt: number } | null
  health: Lamp[]
  kpi: {
    coverage: { matched: number; eligible: number; total: number; ratio: number | null }
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
}

/**
 * 主畫面資料。
 *
 * ⚠️ `eligible`（覆蓋率的分母）**只算真的成局的 spin**。實測約 29% 的 spin
 *    根本沒起局，那些本來就不會有後台紀錄——混進分母會讓對帳看起來像壞了
 *    （48/139 = 34.5% vs 48/59 = 81.4%，兩個數字導向完全相反的結論）。
 *    舊資料沒有 outcome 欄位，那時一律算進 eligible（保守，寧可低估覆蓋率）。
 */
export function overview(env: ReconEnv, windowMinutes = 30, now = Date.now()): Overview {
  const since = now - windowMinutes * 60_000
  const timeoutSec = setting(env, 'pendingTimeoutSec', PENDING_TIMEOUT_DEFAULT)

  const rows = db.prepare(`
    SELECT id, sessionId, machineType, status, observedAt, outcome, bindMethod, lateArrival
    FROM recon_spin WHERE env=? AND observedAt >= ? ORDER BY observedAt
  `).all(env, since) as {
    id: number; sessionId: string; machineType: string; status: string
    observedAt: number; outcome: string; bindMethod: string; lateArrival: number
  }[]

  const NOT_STARTED = new Set(['not_started'])
  const eligibleRows = rows.filter(r => !r.outcome || !NOT_STARTED.has(r.outcome))
  const matched = rows.filter(r => r.status === 'MATCH').length
  const missingRows = rows.filter(r => r.status === 'MISSING')
  const pendingRows = rows.filter(r => r.status === 'PENDING')
  const ambiguous = rows.filter(r => r.status === 'AMBIGUOUS').length

  const age = (r: { observedAt: number }) => (now - r.observedAt) / 1000
  const pending = {
    total: pendingRows.length,
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

  const lines: LedgerLine[] = [
    {
      id: 'L1', name: '單局', desc: 'agent 觀測 ↔ gameRecordList · key=orderId',
      implemented: true,
      counts: { match: matched, pending: pending.total, missing: missingRows.length, ambiguous },
      // P0 只綁定不比金額，所以連 L1 也還沒有差額
      delta: null,
    },
    {
      id: 'L2', name: '餘額', desc: '觀測餘額差 ↔ balanceBefore/After 串接',
      implemented: false, delta: null,
      reason: 'agent 端的餘額不是「這一局」的——讀的是共用的 __lastCoin 全域，任何路由帶 coin 都會覆蓋它。要先改成逐局對齊擷取（只認這次 spin 之後的第一則 moneyNtc）。',
    },
    {
      id: 'L3', name: '上下分', desc: '入離機事件 ↔ EGM Transfer',
      implemented: false, delta: null,
      reason: '尚未拉取 EGM Transfer 報表。',
    },
    {
      id: 'L4', name: 'JP 中獎', desc: 'awardsReport ↔ 後台 JP 紀錄',
      implemented: false, delta: null,
      reason: 'LuckyLink awardsReport 尚未串接。',
    },
    {
      id: 'L5', name: 'JP 池', desc: 'poolChangeReport ↔ coinIn × increment%',
      implemented: false, delta: null,
      reason: 'LuckyLink poolChangeReport 尚未串接。',
    },
  ]

  return {
    ok: true, env, windowMinutes, session,
    health: healthLamps(env, now),
    kpi: {
      coverage: {
        matched, eligible: eligibleRows.length, total: rows.length,
        ratio: eligibleRows.length ? matched / eligibleRows.length : null,
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
export function ledgerDetail(env: ReconEnv, id: number): {
  ok: boolean
  spin?: Record<string, unknown>
  backend?: Record<string, unknown> | null
  backendRaw?: unknown
  luckylink: { available: false; reason: string }
} {
  const spin = db.prepare('SELECT * FROM recon_spin WHERE env=? AND id=?').get(env, id) as Record<string, unknown> | undefined
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
    //    這裡是前者：整個 LuckyLink 都還沒串，不是這一筆抓不到。
    luckylink: { available: false, reason: 'LuckyLink 尚未串接，L4／L5 未實作' },
  }
}

/**
 * src/components/LiveLedgerTab.tsx — 對帳台（Live Ledger）
 *
 * 版面照規格書：由上而下四層，每一層都能單獨回答問題。
 *   ① 資料源健康 → ② KPI → ③ 五條線 + 時間軸 → ④ 逐筆明細
 *
 * ⚠️ 四條不可妥協的顯示規則（規格書明訂，這裡逐條落實）：
 *   1. 缺資料顯示「—」，**永遠不顯示 0**。0 是一個結論，— 是沒有結論。
 *   2. 資料源 degraded／未串接時整塊變灰並標示，不允許在殘缺資料上顯示綠色。
 *   3. 每個聚合數字旁標樣本數（3 筆對到 3 筆也是 100%）。
 *   4. 顏色只承載狀態，不承載品牌：綠＝相符、黃＝等待、紅＝不符或掉單、
 *      紫＝無法判定、灰＝工具問題。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const C = {
  match: '#22c55e', pending: '#eab308', bad: '#ef4444',
  ambiguous: '#a78bfa', tool: '#64748b',
  ink: '#e2e8f0', ink2: '#94a3b8', ink3: '#64748b',
  line: '#2d3f55', panel: '#16202e', panel2: '#1b2739',
}

/**
 * 這些 outcome 的 spin **不可能起局**，所以不該顯示成「等待入帳」。
 *
 * 🚨 `no_bet` 的 status 停在 `PENDING`，畫面原本因此寫「等待入帳」與
 *    「尚未入帳（還在等，不是問題）」——**但它按設計永遠不會入帳**。
 *    把不會發生的事說成「還在等」比不顯示更糟：使用者會一直等一個不會來的東西。
 */
const NO_ROUND_OUTCOMES = new Set(['not_started', 'no_bet'])
const noRound = (outcome?: string) => !!outcome && NO_ROUND_OUTCOMES.has(outcome)
const NO_ROUND_LABEL: Record<string, string> = {
  no_bet: '未起注', not_started: '未起局',
}

const STATUS_LABEL: Record<string, string> = {
  MATCH: '相符', MISMATCH: '不符', MISSING: '掉單', PENDING: '等待入帳',
  AMBIGUOUS: '無法判定', DEGRADED: '資料源異常', HANDPAY: '人工派彩',
}
const STATUS_COLOR: Record<string, string> = {
  MATCH: C.match, MISMATCH: C.bad, MISSING: C.bad, PENDING: C.pending,
  AMBIGUOUS: C.ambiguous, DEGRADED: C.tool, HANDPAY: C.tool,
}

/** 缺資料一律走這裡——把「顯示 0」這個選項從程式裡拿掉 */
const dash = (v: number | null | undefined, fmt?: (n: number) => string) =>
  v === null || v === undefined ? '—' : (fmt ? fmt(v) : String(v))

const fmtAgo = (s: number | null) => {
  if (s === null) return '—'
  if (s < 60) return `${s}s 前`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''} 前`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m 前`
}
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString('zh-TW', { hour12: false })
/** 局號太長（`897-BIGFULINK-2065|6AB02E83089`），表格只顯示 `|` 後面那段，完整的放 title */
const shortOrderId = (id: string | null) => (id ? (id.includes('|') ? id.split('|').pop() ?? id : id) : '—')
/** 時間窗的說法要跟選單一致——畫面上選「近 24 小時」，明細標題就不該寫「近 1440 分鐘」 */
const fmtWindow = (min: number) =>
  min >= 2880 && min % 1440 === 0 ? `近 ${min / 1440} 天`
    : min % 60 === 0 ? `近 ${min / 60} 小時` : `近 ${min} 分鐘`

interface Lamp { key: string; label: string; state: string; agoSec: number | null; note: string; detail?: string }
interface Finding {
  id: number; line: string; severity: string; refId: string; detectedAt: number
  note: string; machineType?: string; spinSeq?: number; resolvedAt: number | null
}
interface Setting { key: string; label: string; unit: string; dflt: number; value: number; isDefault: boolean; effect: string
  /** 開關類（0/1）。⚠️ 數字輸入框的 `min={1}` 會讓「關閉」連打都打不進去 */
  bool?: boolean }
/** 告警送出的現況。⚠️ `neverNotified` 要顯示——水位線之前那些永遠不補送的歷史告警
 *  有幾千筆，只看到「已送出 0」會被讀成「系統沒在動」。 */
interface NotifyStatus {
  enabled: boolean; configured: boolean; queued: number; held: number
  lastSentAt: number | null; watermarkTs: number | null; neverNotified: number
}
interface Line {
  id: string; name: string; desc: string; implemented: boolean; reason?: string
  counts?: { match: number; pending: number; missing: number; ambiguous: number }
  amountChecked?: number; amountBad?: number
  delta: number | null
}
interface Overview {
  ok: boolean; env: string; windowMinutes: number
  viewer: string | null; unattributed: number
  session: { sessionId: string; machineType: string; firstAt: number; lastAt: number } | null
  health: Lamp[]
  kpi: {
    coverage: { matched: number; eligible: number; total: number; ratio: number | null
      strict: number; fallback: number; unlabelled: number }
    netDelta: null; netDeltaReason: string
    missing: { count: number; oldestAgeSec: number | null }
    mismatch: null; mismatchReason: string
    pending: { total: number; a0_30: number; a30_90: number; a90: number }
    ambiguous: number
  }
  lines: Line[]
  timeline: { at: number; worst: string; n: number }[]
  bindMethods: { residual: number; absolute_window: number; unknown: number }
  lateRebound: number
  pendingTimeoutSec: number
  findings: Finding[]
}
interface Row {
  id: number; observedAt: number; machineType: string; gmid: string; spinSeq: number
  status: string; outcome: string; bindMethod: string; lateArrival: number
  latencyMs: number | null; orderId: string | null
  betFront: number | null; balanceBefore: number | null; balanceAfter: number | null
  betBackend: number | null; winBackend: number | null
  spinIndex: number | null; betTimePrecise: number | null
}

interface PoolLevel {
  levelName: string; machineCount: number; sampleMachine: string
  current: number | null; maxValue: number | null; basevalue: number | null
  incrementPercent: number | null
  /** ⚠️ 占**設定上限**的百分比，不是拿獎池名稱裡的數字算的 */
  waterPct: number | null
  atCap: boolean; mismatch: number; samples: number
  /** 這個池底下有沒有「我現在正在跑」的機台。有的話排最上面並標色。 */
  mine: boolean
  myMachines: string[]
}
/** 獎池逐筆明細的一列——一次投注對這個 Level 的貢獻 */
interface PoolChangeRow {
  ts: number; machineName: string; levelName: string
  /** 投入額變化（新 coinIn − 舊 coinIn）。負值＝meter 倒退 */
  coinIn: number
  change: number; before: number; after: number
  /** 從這個窗的第一筆算到這一筆為止的累積增額 */
  cumulative: number
  verify: string; verifyDelta: number | null; reason: string
  /** ⚠️ 池變動報表**沒有局號**，這是配上去的；配不出來就是 null，不猜 */
  orderId: string | null
  spinIndex: number | null
  joinDelta: number | null
  joinNote: 'matched' | 'no_round' | 'ambiguous'
  /** 同一筆投注在各 Level 共用同一個 reqmd5——配不到局號時仍分得出是同一筆 */
  reqmd5: string
}
interface PoolDetailPayload {
  ok: boolean; env: string; minutes: number
  detail: {
    levelName: string; machines: string[]; total: number; rows: PoolChangeRow[]
    /** 每一筆 change 的加總 */
    sumChange: number
    /** 最後一筆 after − 第一筆 before。⚠️ 跟 sumChange 不一樣時代表中間有中獎歸零／溢流 */
    netMove: number | null
    negativeCoinIn: number; mismatch: number
    incrementPercent: number | null; firstTs: number | null; lastTs: number | null
    joined: number; joinAmbiguous: number; joinSanityMs: number
  }
}
interface PoolMismatch {
  ts: number; machineName: string; levelName: string
  coinIn: number; expected: number | null; actual: number; delta: number | null
  before: number; basevalue: number | null
  cause: 'coinin_negative' | 'at_basevalue' | 'unknown'
}
interface MachineRow {
  machineType: string; gmid: string
  matched: number; eligible: number; coverage: number | null
  missing: number; pending: number; noRound: number; ambiguous: number
  lastAt: number | null
}
interface PoolsPayload {
  env: string; minutes: number
  summary: { poolRows: number; poolOk: number; poolMismatch: number; poolSkipped: number
    awards: number; awardsBad: number; machines: number; levels: number }
  levels: PoolLevel[]
  mismatches: PoolMismatch[]
  atCapCount: number
  machines: MachineRow[]
  myGmids: string[]
  envAudit?: EnvAuditRow[]
  betPool?: BetPoolRow[]
  credit?: CreditRow[]
  machineSls?: MachineSlsRow[]
}

/**
 * L6 SLS 服務健康 —— **只有使用者正在跑的那幾台**。
 *
 * ⚠️ `unmapped` 是「查不了」不是「沒問題」：logstore 索引是觀測來的，
 *    這台的群組最近沒流量就不會有紀錄。畫面上必須跟「服務正常」分得出來。
 */
interface MachineSlsRow {
  machineName: string
  groupIds: string[]
  unmapped: boolean
  note: string
  events: { kind: string; label: string; times: number[]; count: number; logstore: string }[]
}

/** L3 上下分：後台每局分數戳記推出的帳外異動。只回「有異動」與「查不了」的。 */
interface CreditRow {
  machineName: string
  rounds: number
  pairs: number
  transfersIn: number
  transfersOut: number
  transfers: { spinIndex: number; amount: number; at: number | null }[]
  stampAnomalies: number
  stampNet: number
  verdict: 'clean' | 'transfers' | 'no_stamps' | 'too_few'
  note: string
}

/**
 * 跨源對帳：後台 bet ↔ 獎池增量。
 *
 * ⚠️ 這是**唯一**能證明「玩家真的下了這些注」的線。現有的 L5 驗的是
 *    LuckyLink 自己前後一致——它就算整段少收了投注，自己的算式仍然成立、仍然判 ok。
 */
interface BetPoolRow {
  machineName: string
  spins: number
  betSum: number
  coinInDelta: number
  coinInGap: number
  /** 面額係數，只接受 10 的次方；拒絕採用時為 null */
  factor: number | null
  observedRatio: number | null
  expectedChange: number | null
  actualChange: number | null
  delta: number | null
  /**
   * ⚠️ 這個 union 必須跟後端 `live-ledger-betpool.ts` 的 `verdict` 保持同步。
   *
   * 🚨 它**不是** import 來的，是這裡自己抄的——所以後端加了新值時 `tsc` 不會吭聲。
   *    實際發生過：v4.179.0 後端新增 `denom_unknown`／`denom_changed`，這裡沒跟上，
   *    於是 `denom_changed`（= 比值跟釘住的係數不符，是**異常**）在畫面上
   *    既不算 `bad`、也不是 `match`，被畫成中性灰字——後端抓到了，畫面不說。
   *    下面的 `KNOWN_VERDICTS` 就是為了讓「又漏掉一個」變成畫面上的紅字而不是沉默。
   */
  verdict: 'match' | 'mismatch' | 'no_pool' | 'no_bet' | 'too_few' | 'ratio_not_clean'
    | 'denom_unknown' | 'denom_changed'
  /** `denom_unknown` 時給的建議係數——只是建議，要人確認過才算釘住 */
  suggestedFactor?: number | null
  note: string
}

/**
 * 畫面認得的所有判定。**不在這裡面的值一律當成異常顯示，不可以靜靜地畫成灰字。**
 * 「畫面不認得」跟「沒問題」在使用者眼裡長得一樣，那正是這次要修掉的東西。
 */
const KNOWN_VERDICTS = ['match', 'mismatch', 'no_pool', 'no_bet', 'too_few',
  'ratio_not_clean', 'denom_unknown', 'denom_changed'] as const
/** 確定是異常的。⚠️ `denom_changed` 一定要在裡面——它就是 v4.179.0 拿來取代假 match 的那個判定。 */
const BAD_VERDICTS = ['mismatch', 'denom_changed', 'ratio_not_clean'] as const
/** 「沒有結論」——既不是相符也不是異常。要**單獨報出比例**，不能混進「相符」裡。 */
const UNDECIDED_VERDICTS = ['denom_unknown', 'no_pool', 'no_bet', 'too_few'] as const

/** 跨環境機台稽核。⚠️ 這一塊是唯一不跟著上方 env 切換的資料——它要看的就是跨環境。 */
interface EnvAuditRow {
  machineName: string
  poolEnvs: string[]
  spinEnvs: string[]
  lastPoolAt: number | null
  lastSpinAt: number | null
  /** ⚠️ 每個環境各自的最後池變動時間——沒有它，「同時掛兩邊」跟「搬過環境」讀起來一樣 */
  lastPoolByEnv?: Partial<Record<string, number>>
  issue: 'both_envs' | 'env_mismatch' | 'no_pool' | 'blank_name'
  severity: 'critical' | 'warn' | 'info'
  note: string
}

const lampColor = (s: string) =>
  s === 'ok' ? C.match : s === 'warn' ? C.pending : s === 'bad' ? C.bad : C.tool

export default function LiveLedgerTab({ userLabel }: { userLabel?: string }) {
  const [env, setEnv] = useState<'qat' | 'uat'>('qat')
  const [minutes, setMinutes] = useState(30)
  const [ov, setOv] = useState<Overview | null>(null)
  const [err, setErr] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [filter, setFilter] = useState<'all' | 'abnormal' | 'pending'>('all')
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  /** 使用者捲到表格中間時新資料不自動插入，只在頂端提示。傳統翻頁在即時流上會打架。 */
  const [buffered, setBuffered] = useState<Row[]>([])
  const scrolledRef = useRef(false)
  const [settings, setSettings] = useState<Setting[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingMsg, setSettingMsg] = useState('')
  const [notifySt, setNotifySt] = useState<NotifyStatus | null>(null)
  const [notifyMsg, setNotifyMsg] = useState('')
  /** 跨使用者檢視。⚠️ 這是除錯用的，不是權限——過濾值本來就是 client 送的 header */
  const [showAll, setShowAll] = useState(false)
  /** 獎池與機台總覽。⚠️ 跟 overview 共用同一個 minutes——分開帶會讓上下兩塊用不同分母。 */
  const [pools, setPools] = useState<PoolsPayload | null>(null)
  /** 點機台那一列會把逐筆明細篩成那台；再點一次取消。 */
  const [machineFilter, setMachineFilter] = useState<string>('')
  /** 展開中的獎池明細（Level 名稱）；null＝沒展開 */
  const [poolDetailLevel, setPoolDetailLevel] = useState<string | null>(null)
  /** 明細要不要只看自己的機台。⚠️ 池是整個 Level 共用的，這個切換會改變分母 */
  const [poolDetailMineOnly, setPoolDetailMineOnly] = useState(true)
  const [poolDetail, setPoolDetail] = useState<PoolDetailPayload | null>(null)
  const [poolDetailBusy, setPoolDetailBusy] = useState(false)

  const h = useCallback((): Record<string, string> =>
    userLabel ? { 'x-user-label': userLabel } : {}, [userLabel])

  const loadOverview = useCallback(async () => {
    try {
      const r = await fetch(`/api/autospin/live-ledger/overview?env=${env}&minutes=${minutes}${showAll ? '&scope=all' : ''}`, { headers: h() })
      const d = await r.json()
      if (d.ok) { setOv(d); setErr('') } else setErr(d.reason || '讀取失敗')
    } catch (e) { setErr(String(e)) }
  }, [env, minutes, h, showAll])

  /**
   * 告警送出的現況。
   *
   * ⚠️ 宣告位置要在下面那個 5 秒輪詢的 effect **之前**——雖然 effect 的內容是
   *    掛載後才跑、執行期不會踩到 TDZ，但 lint 會擋（Cannot access variable
   *    before it is declared），而這個檔案的 lint 已經夠亂了。
   */
  const loadNotify = useCallback(async () => {
    try {
      const r = await fetch(`/api/autospin/live-ledger/notify?env=${env}`, { headers: h() })
      const d = await r.json()
      if (d.ok) setNotifySt(d)
    } catch { /* 下次再試 */ }
  }, [env, h])

  const loadPools = useCallback(async () => {
    try {
      const r = await fetch(`/api/autospin/live-ledger/pools?env=${env}&minutes=${minutes}${showAll ? '&scope=all' : ''}`, { headers: h() })
      const d = await r.json() as PoolsPayload & { ok: boolean }
      if (d.ok) setPools(d)
    } catch { /* 獎池讀不到不該讓整頁掛掉——下面的區塊自己會顯示「讀取中」 */ }
  }, [env, minutes, h, showAll])

  /**
   * 單一獎池 Level 的逐筆明細。
   *
   * ⚠️ 只在「有展開」時才打——這支要掃整個窗的 pool change 才算得出累積值，
   *    跟著 5 秒輪詢一起無條件打會變成白費的重負載。
   */
  /** 明細要帶哪幾台（逗號串）。空字串＝整個 Level（池是共用的） */
  const detailMachines = useMemo(() => {
    if (!poolDetailLevel || !poolDetailMineOnly) return ''
    const lv = pools?.levels.find(l => l.levelName === poolDetailLevel)
    return (lv?.myMachines ?? []).join(',')
  }, [poolDetailLevel, poolDetailMineOnly, pools])

  const loadPoolDetail = useCallback(async () => {
    if (!poolDetailLevel) { setPoolDetail(null); return }
    setPoolDetailBusy(true)
    try {
      const q = new URLSearchParams({ env, minutes: String(minutes), level: poolDetailLevel, limit: '200' })
      // 只看自己的機台時才帶 machines；沒有自己的機台就退回整個 Level（並在畫面上講明）
      if (detailMachines) q.set('machines', detailMachines)
      const r = await fetch(`/api/autospin/live-ledger/pool-detail?${q}`, { headers: h() })
      const d = await r.json() as PoolDetailPayload
      if (d.ok) setPoolDetail(d)
    } catch { /* 明細讀不到不影響上面的總覽 */ }
    finally { setPoolDetailBusy(false) }
    // ⚠️ 相依只到 `detailMachines`（字串），不是整個 `pools` 物件——
    //    後者每 5 秒輪詢都會換一個新的物件身分，會讓這支跟著重打。
  }, [poolDetailLevel, detailMachines, env, minutes, h])

  useEffect(() => { void loadPoolDetail() }, [loadPoolDetail])

  const loadRows = useCallback(async (reset: boolean) => {
    try {
      // ⚠️ 一定要帶 minutes——KPI 吃視窗、表格不吃的話，同一畫面會出現兩個分母
      const q = new URLSearchParams({ env, filter, limit: '50', minutes: String(minutes) })
      if (machineFilter) q.set('machineType', machineFilter)
      if (showAll) q.set('scope', 'all')
      if (!reset && cursor) q.set('cursor', String(cursor))
      const r = await fetch(`/api/autospin/live-ledger/rows?${q}`, { headers: h() })
      const d = await r.json()
      if (!d.ok) return
      if (reset) {
        // 捲動中就不直接插入，先進暫存列
        if (scrolledRef.current && rows.length) {
          const known = new Set(rows.map(x => x.id))
          const fresh = (d.rows as Row[]).filter(x => !known.has(x.id))
          if (fresh.length) setBuffered(fresh)
        } else { setRows(d.rows); setBuffered([]) }
      } else setRows(prev => [...prev, ...d.rows])
      setCursor(d.nextCursor)
    } catch { /* 靜默：下一輪會再試 */ }
  // ⚠️ machineFilter 一定要進 deps。少了它，useCallback 會抓到上一輪的值——
  //    症狀是「點了機台但表格沒篩，再點一次才對」，看起來像是要點兩下。
  }, [env, filter, cursor, h, rows, minutes, showAll, machineFilter])

  useEffect(() => { loadOverview(); loadPools(); loadRows(true) /* eslint-disable-next-line */ }, [env, minutes, filter, showAll])
  // 機台篩選只影響逐筆明細——上面的獎池與機台總覽不跟著變（那兩塊是全域的）
  useEffect(() => { loadRows(true) /* eslint-disable-next-line */ }, [machineFilter])
  useEffect(() => {
    /**
     * 🚨 **獎池那一塊原本不在輪詢裡**（2026-09-21 使用者回報：「停留在對帳表上，
     *    LuckyLink 的獎池不會跟著刷新，必須重新整理頁面」）。
     *    它只在掛載與切換 env／時間窗時載入一次，所以池值、水位、逐筆明細
     *    全部停在進頁面那一刻——而畫面上**完全看不出資料是舊的**。
     *
     * ⚠️ 不跟其他幾支一樣每 5 秒打：`/pools` 一次要算水位、不符明細、
     *    跨源比對、上下分、機台總覽（SLS 那段自己有 60 秒快取），
     *    比 overview 重得多。**每兩拍打一次（10 秒）**，足夠即時又不會加倍負載。
     */
    let tick = 0
    const t = setInterval(() => {
      loadOverview(); loadRows(true); loadNotify()
      if (++tick % 2 === 0) loadPools()
    }, 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line
  }, [env, minutes, filter, rows, showAll])

  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch(`/api/autospin/live-ledger/settings?env=${env}`, { headers: h() })
      const d = await r.json()
      if (d.ok) setSettings(d.settings)
    } catch { /* 下次再試 */ }
  }, [env, h])

  // ⚠️ 刻意不另開一個 useEffect——這個檔案已經有三個「在 effect 裡 setState」的
  //    lint 錯誤，再加一個只是讓它更難清。掛在既有的設定載入與 5 秒輪詢上就夠了。
  useEffect(() => { loadSettings(); loadNotify() }, [loadSettings, loadNotify])

  /** 試發一則確認 webhook 通不通。不受開關與節流限制，也不會把告警標成已通知。 */
  const testNotify = async () => {
    setNotifyMsg('送出中…')
    try {
      const r = await fetch(`/api/autospin/live-ledger/notify-test?env=${env}`, { method: 'POST', headers: h() })
      const d = await r.json()
      setNotifyMsg(d.ok ? `✅ ${d.message}` : `❌ ${d.message ?? '送出失敗'}`)
      loadOverview()
    } catch (e) { setNotifyMsg(`❌ ${e}`) }
  }

  const saveSetting = async (key: string, value: number) => {
    setSettingMsg('')
    try {
      const r = await fetch(`/api/autospin/live-ledger/settings?env=${env}`, {
        method: 'PUT', headers: { ...h(), 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      const d = await r.json()
      // ⚠️ 失敗要講原因。靜默失敗會讓使用者以為改成功了，之後拿舊門檻的結果下結論。
      setSettingMsg(d.ok ? `已更新 ${key}` : `更新失敗：${d.reason ?? '未知原因'}`)
      if (d.ok) { loadSettings(); loadOverview() }
    } catch (e) { setSettingMsg(`更新失敗：${e}`) }
  }

  const openDetail = async (id: number) => {
    if (openId === id) { setOpenId(null); setDetail(null); return }
    setOpenId(id); setDetail(null)
    try {
      const r = await fetch(`/api/autospin/live-ledger/row/${id}?env=${env}${showAll ? '&scope=all' : ''}`, { headers: h() })
      setDetail(await r.json())
    } catch { setDetail({ ok: false }) }
  }

  const k = ov?.kpi

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
      {/* 標題列 + 篩選 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: C.ink2 }}>
          {/* ⚠️ 一定要明寫在看誰的資料。不寫的話使用者會把「自己沒有資料」
              誤讀成「系統沒有資料」。 */}
          <span style={{
            display: 'inline-block', padding: '1px 9px', borderRadius: 99, marginRight: 9,
            fontSize: 11.5, background: showAll ? '#3a2a12' : '#16304a',
            color: showAll ? C.pending : '#7dd3fc', border: `1px solid ${showAll ? C.pending : '#2563eb'}55`,
          }}>
            {showAll ? '跨使用者檢視（除錯用）' : `目前顯示：${userLabel || '（未指定帳號）'}`}
          </span>
          {ov?.session
            ? <>session <b style={{ color: C.ink }}>{ov.session.sessionId}</b> · {ov.session.machineType}
              · 最後觀測 {fmtClock(ov.session.lastAt)}</>
            : '目前沒有觀測資料'}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={env} onChange={e => setEnv(e.target.value as 'qat' | 'uat')}
            style={{ background: C.panel2, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 6, padding: '4px 8px', fontSize: 12 }}>
            <option value="qat">QAT</option><option value="uat">UAT</option>
          </select>
          <button onClick={() => setShowAll(v => !v)}
            title="跨使用者檢視是除錯用的。⚠️ 這一頁的分流依據是 client 送的 header，本來就不是權限隔離。"
            style={{
              padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer',
              background: showAll ? '#3a2a12' : 'transparent',
              color: showAll ? C.pending : C.ink2,
              border: `1px solid ${showAll ? C.pending : C.line}`,
            }}>{showAll ? '顯示全部（含他人）' : '只顯示自己'}</button>
          <select value={minutes} onChange={e => setMinutes(Number(e.target.value))}
            style={{ background: C.panel2, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 6, padding: '4px 8px', fontSize: 12 }}>
            <option value={30}>近 30 分鐘</option><option value={120}>近 2 小時</option>
            <option value={720}>近 12 小時</option><option value={1440}>近 24 小時</option>
          </select>
        </div>
      </div>

      {showAll && (ov?.unattributed ?? 0) > 0 && (
        <div style={{ padding: '8px 12px', background: '#2a2418', border: `1px solid ${C.pending}55`, borderRadius: 6, fontSize: 12, color: C.pending }}>
          {/* ⚠️ JSX 不渲染 markdown——這裡原本寫 `**…**`，畫面上是字面上的星號 */}
          其中 {ov!.unattributed} 筆<b>無法歸屬到任何帳號</b>（早於歸屬欄位上線）。
          這些不會出現在任何人的個人檢視裡——刻意不預設歸給檢視者，保留期到了會自然淘汰。
        </div>
      )}
      {err && <div style={{ padding: 10, background: '#3b1a1a', border: `1px solid ${C.bad}`, borderRadius: 6, fontSize: 12.5 }}>{err}</div>}

      {/* ① 資料源健康列 —— 放最上面是刻意的：底下所有數字的意義都取決於這幾盞燈 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0, border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel, overflow: 'hidden' }}>
        {(ov?.health ?? []).map((l, i) => (
          <div key={l.key} title={l.note} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', fontSize: 12.5,
            borderRight: i < (ov!.health.length - 1) ? `1px solid ${C.line}` : undefined,
            opacity: l.state === 'unwired' ? 0.65 : 1,
          }}>
            <span style={{
              width: 9, height: 9, borderRadius: '50%', background: lampColor(l.state), flex: 'none',
              boxShadow: `0 0 0 3px ${lampColor(l.state)}33`,
            }} />
            <span style={{ color: C.ink }}>{l.label}</span>
            {/* ⚠️ 顯示「距上次成功多久」而不是「延遲幾毫秒」——延遲數字在資料源
                斷掉那一刻會停住不動，看起來永遠健康 */}
            <span style={{ color: C.ink3, fontVariantNumeric: 'tabular-nums' }}>
              {l.state === 'unwired' ? '未串接' : (l.detail ?? fmtAgo(l.agoSec))}
            </span>
          </div>
        ))}
      </div>

      {/* ② KPI 帶 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(168px,1fr))', gap: 10 }}>
        <Kpi label="已對帳 / 可對帳 spin"
          value={k ? `${k.coverage.matched} / ${k.coverage.eligible}` : '—'}
          sub={k?.coverage.ratio === null || !k ? '無樣本'
            : `覆蓋率 ${(k.coverage.ratio * 100).toFixed(1)}% · 嚴格 ${k.coverage.strict} / 寬鬆 ${k.coverage.fallback}`            + (k.coverage.unlabelled ? ` / 未標記 ${k.coverage.unlabelled}` : '')}
          title="嚴格＝扣掉系統性偏移後比殘差（±5s）；寬鬆＝樣本不足時退回絕對窗（±30s）。兩者信心度差一個數量級，所以分開列。"
          tone={k && k.coverage.ratio !== null && k.coverage.ratio > 0.95 ? 'good' : undefined} />
        {/* ⚠️ 規格書說累計差額是「這頁的頭號數字」，但 P0 只綁定不比金額。
            這格顯示 0 會讓人以為「今天沒差錢」——那是主動誤導。 */}
        <Kpi label="累計差額" value="—" sub="金額比對未實作" muted title={ov?.kpi.netDeltaReason} />
        <Kpi label="掉單" value={dash(k?.missing.count)}
          sub={k?.missing.oldestAgeSec ? `最久 ${fmtAgo(k.missing.oldestAgeSec).replace(' 前', '')} 未入帳` : '—'}
          tone={k && k.missing.count > 0 ? 'bad' : undefined} />
        <Kpi label="不符" value="—" sub="金額比對未實作" muted title={ov?.kpi.mismatchReason} />
        <Kpi label="等待入帳" value={dash(k?.pending.total)}
          sub={k ? `0–30s ${k.pending.a0_30} · 30–90s ${k.pending.a30_90} · >90s ${k.pending.a90}` : '—'} />
        <Kpi label="無法判定" value={dash(k?.ambiguous)}
          tone={k && k.ambiguous > 0 ? 'amb' : undefined}
          sub={ov ? `晚到回綁 ${ov.lateRebound} 筆` : '—'} />
      </div>


      {/* ── ②b 獎池 ──────────────────────────────────────────────────────────
          🚨 **放在 KPI 之後、對帳線之前是刻意的。**這張表要回答的是
             「LuckyLink 獎池的增減值有沒有符合預期、有沒有超出」——
             spin 逐局對帳是手段，獎池才是目的（使用者 2026-09-08 指正）。 */}
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, background: C.panel, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.tool, letterSpacing: '.05em' }}>獎池</span>
          <span style={{ fontSize: 11, color: C.ink3 }}>L4 / L5 · 每 60 秒自動比對</span>
          {/* ⚠️ 有「我的池」時要講出來，否則使用者看到順序變了會以為排序壞了 */}
          {pools && pools.levels.some(l => l.mine) && (
            <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 99,
              background: 'rgba(56,189,248,.13)', color: C.tool, border: `1px solid ${C.tool}44` }}>
              你正在跑的機台所屬的池已排到最上面
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.ink3 }}>
            {pools ? `${pools.summary.levels} 個 Level · ${pools.summary.machines} 台` : '讀取中…'}
          </span>
        </div>

        {/* ⚠️ 不符收成一條橫幅，不是逐列讓人讀。實測 7 筆全部是同一種情況
            （投入額倒退）——分開列會讓人以為有七個獨立問題。 */}
        {pools && pools.mismatches.length > 0 && (() => {
          const neg = pools.mismatches.filter(m => m.cause === 'coinin_negative').length
          const machines = [...new Set(pools.mismatches.map(m => m.machineName))]
          return (
            <div style={{ borderLeft: `2px solid ${C.bad}`, background: 'rgba(248,113,113,.07)',
              padding: '8px 11px', borderRadius: '0 7px 7px 0', fontSize: 12, color: C.ink2, marginBottom: 9 }}>
              <b style={{ color: C.ink }}>{pools.mismatches.length} 筆增減值不符</b>
              {neg === pools.mismatches.length
                ? <>，<b style={{ color: C.ink }}>全部是同一種情況：投入額倒退</b>。
                  投入額變成負值時公式會推出負的預期增額，差額因此很大——
                  <b style={{ color: C.ink }}>這不代表獎池真的被多加了錢</b>。</>
                : <>，其中 {neg} 筆是投入額倒退。</>}
              <span style={{ color: C.ink3 }}>{'　'}分佈：{machines.join('、')}</span>
            </div>
          )
        })()}

        {/* ── L6 SLS 服務健康（只看正在跑的機台）─────────────────────────
            🚨 使用者要求：「操作 A 獎池就只監控 A 的 LOG，其餘不管」。
               所以這裡只列 `myGmids`，不是全部 46 個 logstore。
            ⚠️ 「查不了」與「服務正常」用不同顏色與文案分開 —— 索引是觀測來的，
               沒流量就沒紀錄，那時候我們是不知道，不是沒事。 */}
        {pools?.machineSls && pools.machineSls.length > 0 && (() => {
          const bad = pools.machineSls.filter(m => m.events.length > 0)
          const blind = pools.machineSls.filter(m => m.unmapped)
          const tone = bad.length ? C.bad : blind.length ? C.pending : C.match
          return (
            <div style={{ borderLeft: `2px solid ${tone}`,
              background: bad.length ? 'rgba(248,113,113,.07)' : 'transparent',
              padding: '8px 11px', borderRadius: '0 7px 7px 0', fontSize: 12, color: C.ink2, marginBottom: 9 }}>
              <b style={{ color: C.ink }}>SLS 服務健康</b>
              <span style={{ color: C.ink3, fontSize: 11 }}>{'　'}只看你正在跑的 {pools.machineSls.length} 台</span>
              {bad.length > 0 && <b style={{ color: C.bad }}>{'　'}{bad.length} 台有異常</b>}
              {blind.length > 0 && <b style={{ color: C.pending }}>{'　'}{blind.length} 台查不了</b>}
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {pools.machineSls.map(m => (
                  <div key={m.machineName} style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                    <b style={{ color: m.events.length ? C.bad : m.unmapped ? C.pending : C.match }}>
                      {m.machineName}
                    </b>
                    <span style={{ color: C.ink3 }}>
                      {m.groupIds.length ? `${'　'}groupId ${m.groupIds.join('、')}` : ''}
                    </span>
                    {m.unmapped && <div style={{ color: C.pending, paddingLeft: 2 }}>⚠️ {m.note}</div>}
                    {!m.unmapped && !m.events.length && (
                      <span style={{ color: C.match }}>{'　'}服務正常</span>
                    )}
                    {m.events.map(ev => (
                      <div key={`${m.machineName}-${ev.kind}-${ev.logstore}`} style={{ color: C.ink2, paddingLeft: 2 }}>
                        {ev.label} × {ev.count}
                        <span style={{ color: C.ink3 }}>
                          {'　'}<code style={{ fontSize: 10.5 }}>
                            {ev.logstore.replace(/^test-liveslots-luckylink(mml|g2s)-/, '').replace(/-logs$/, '')}
                          </code>
                          {ev.times.length > 0 && <>
                            {'　'}最近 {ev.times.map(t => new Date(t).toLocaleTimeString('zh-TW', { hour12: false })).join('、')}
                          </>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* ── L3 上下分 ─────────────────────────────────────────────────
            分數在「不是打這一局」的時候變動就是上下分。⚠️ `no_stamps` 一定要
            顯示——那是「這台查不了」不是「這台沒問題」。 */}
        {pools?.credit && pools.credit.length > 0 && (() => {
          const xfer = pools.credit.filter(c => c.verdict === 'transfers')
          const blind = pools.credit.filter(c => c.verdict === 'no_stamps')
          return (
            <div style={{ borderLeft: `2px solid ${xfer.length ? C.pending : C.ink3}`,
              background: xfer.length ? 'rgba(251,191,36,.07)' : 'transparent',
              padding: '8px 11px', borderRadius: '0 7px 7px 0', fontSize: 12, color: C.ink2, marginBottom: 9 }}>
              <b style={{ color: C.ink }}>L3 上下分 · 帳外分數異動</b>
              {xfer.length > 0 && <b style={{ color: C.pending }}>{'　'}{xfer.length} 台有異動</b>}
              {blind.length > 0 && <b style={{ color: C.ink3 }}>{'　'}{blind.length} 台查不了</b>}
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {pools.credit.slice(0, 6).map(c => (
                  <div key={c.machineName} style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                    <b style={{ color: c.verdict === 'transfers' ? C.pending : C.ink3 }}>{c.machineName}</b>
                    <span style={{ color: C.ink3 }}>
                      {'　'}{c.rounds} 局 / {c.pairs} 對可比
                      {c.verdict === 'transfers' && <>
                        {'　'}上分 {c.transfersIn.toLocaleString()} · 下分 {c.transfersOut.toLocaleString()}
                      </>}
                    </span>
                    <div style={{ color: C.ink2, paddingLeft: 2 }}>{c.note}</div>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* ── 跨源對帳：後台 bet ↔ 獎池增量 ──────────────────────────────
            🚨 這一塊是唯一能證明「玩家真的下了這些注」的線。上面那些數字
               都是 LuckyLink 自己跟自己對，少收了它也不會知道。 */}
        {pools?.betPool && pools.betPool.length > 0 && (() => {
          const has = (list: readonly string[], v: string) => list.includes(v)
          const bad = pools.betPool.filter(b => has(BAD_VERDICTS, b.verdict))
          const matched = pools.betPool.filter(b => b.verdict === 'match')
          const undecided = pools.betPool.filter(b => has(UNDECIDED_VERDICTS, b.verdict))
          const unpinned = pools.betPool.filter(b => b.verdict === 'denom_unknown')
          // 後端加了新判定而這裡沒跟上時，要在畫面上炸開，不是安靜地畫成灰字
          const unknown = pools.betPool.filter(b => !has(KNOWN_VERDICTS, b.verdict))
          // ⚠️ 全部都「沒有結論」時**不可以**顯示成綠色。那不是沒問題，是沒在比。
          const tone = (bad.length || unknown.length) ? C.bad
            : matched.length ? C.match
            : C.pending
          return (
            <div style={{ borderLeft: `2px solid ${tone}`,
              background: bad.length ? 'rgba(248,113,113,.07)' : 'transparent',
              padding: '8px 11px', borderRadius: '0 7px 7px 0', fontSize: 12, color: C.ink2, marginBottom: 9 }}>
              <b style={{ color: C.ink }}>跨源對帳 · 後台下注 ↔ 獎池增量</b>
              {bad.length > 0 && <b style={{ color: C.bad }}>{'　'}{bad.length} 台不符</b>}
              {/* ⚠️ 文案是「沒看到矛盾」不是「相符」——沒有獨立的占用證據時，
                  污染有可能剛好湊出乾淨比值，結論只能到這裡為止（CodeX review） */}
              {matched.length > 0 && <b style={{ color: C.match }}>{'　'}{matched.length} 台沒看到矛盾</b>}
              {/* 🚨 未判定的比例一定要露出來。全部未判定卻只顯示「0 台不符」，
                  就是把「功能沒在運作」畫成「一切正常」——這正是 v4.179.0 修完
                  面額 bug 之後的實際狀態（一台都沒釘係數，全台 denom_unknown）。 */}
              {undecided.length > 0 && (
                <b style={{ color: C.pending }}>
                  {'　'}{undecided.length}/{pools.betPool.length} 台無法判定
                </b>
              )}
              {unknown.length > 0 && (
                <b style={{ color: C.bad }}>{'　'}⚠️ {unknown.length} 台的判定畫面不認得（前端要更新）</b>
              )}
              <span style={{ color: C.ink3, fontSize: 11 }}>{'　'}按 session 切窗</span>
              {unpinned.length > 0 && (
                <div style={{ color: C.pending, fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
                  {unpinned.length} 台還沒釘住面額係數，<b>在釘住之前不做判定</b>
                  （係數若從待檢查的資料現推，真實落差剛好 10 倍時會被整個吃掉）。
                  {unpinned.some(b => b.suggestedFactor != null) && <>
                    {' '}建議值：{unpinned.filter(b => b.suggestedFactor != null).slice(0, 3)
                      .map(b => `${b.machineName} ×${b.suggestedFactor}`).join('、')}
                    ——要人確認過才算數。
                  </>}
                </div>
              )}
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {/* 排序：異常 → 未判定 → 其餘。未判定排在相符前面，因為它才是要人處理的 */}
                {[...bad, ...undecided, ...pools.betPool.filter(b => !bad.includes(b) && !undecided.includes(b))]
                  .slice(0, 6).map(b => (
                  <div key={`${b.machineName}-${b.spins}-${b.betSum}`} style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                    <b style={{ color: b.verdict === 'match' ? C.match
                      : bad.includes(b) ? C.bad
                      : undecided.includes(b) ? C.pending
                      : C.ink3 }}>
                      {b.machineName}
                    </b>
                    <span style={{ color: C.ink3 }}>
                      {'　'}{b.spins} 局 · 下注 {b.betSum.toLocaleString()}
                      {/* ⚠️ 面額係數一定要顯示。看不到它的話，「×100 的機台對上了」
                          跟「係數被拿來吸收落差」在畫面上完全一樣 */}
                      {b.factor !== null && b.factor !== 1 && <> · 面額 ×{b.factor}</>}
                      {b.expectedChange !== null && b.actualChange !== null && <>
                        {'　'}預期增額 {b.expectedChange.toFixed(3)} / 實際 {b.actualChange.toFixed(3)}
                      </>}
                    </span>
                    {b.verdict !== 'match' && <div style={{ color: C.ink2, paddingLeft: 2 }}>{b.note}</div>}
                    {b.coinInGap > 0 && (
                      <div style={{ color: C.pending, paddingLeft: 2 }}>
                        ⚠️ 另有 {b.coinInGap.toLocaleString()} 的投入額是我們漏抓的（端點差 vs 逐筆加總）
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* ── 跨環境機台稽核 ─────────────────────────────────────────────
            🚨 這一塊**不跟著上方的 env 切換**，因為它要看的就是跨環境。
               機台↔獎池是從 poolChangeReport 反推的，所以一台 QAT 機台若掛在
               UAT 的池上，它會**整台從 QAT 的矩陣上消失**而不是被標紅——
               兩個環境擺在一起才看得出來。 */}
        {pools?.envAudit && pools.envAudit.length > 0 && (() => {
          const crit = pools.envAudit.filter(a => a.severity === 'critical')
          const warn = pools.envAudit.filter(a => a.severity === 'warn')
          const tone = crit.length ? C.bad : C.pending
          return (
            <div style={{ borderLeft: `2px solid ${tone}`, background: crit.length ? 'rgba(248,113,113,.07)' : 'rgba(251,191,36,.07)',
              padding: '8px 11px', borderRadius: '0 7px 7px 0', fontSize: 12, color: C.ink2, marginBottom: 9 }}>
              <b style={{ color: C.ink }}>跨環境機台稽核</b>
              <span style={{ color: C.ink3, fontSize: 11 }}>{'　'}近 7 天 · 不受上方環境切換影響</span>
              {crit.length > 0 && <b style={{ color: C.bad }}>{'　'}{crit.length} 台異常</b>}
              {warn.length > 0 && <b style={{ color: C.pending }}>{'　'}{warn.length} 台待確認</b>}
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {pools.envAudit.slice(0, 8).map(a => (
                  <div key={`${a.machineName}|${a.issue}`} style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                    <b style={{ color: a.severity === 'critical' ? C.bad : C.pending }}>
                      {a.machineName || '(空白名稱)'}
                    </b>
                    <span style={{ color: C.ink3 }}>
                      {'　'}spin: {a.spinEnvs.map(e => e.toUpperCase()).join('／') || '—'}
                      {/* ⚠️ 池要連「各自最後一次變動是多久以前」一起給——只列環境名稱的話，
                          「真的同時掛兩邊」跟「三天前搬過來」在畫面上完全一樣 */}
                      {'　'}池: {a.poolEnvs.length
                        ? a.poolEnvs.map(e => {
                          const at = a.lastPoolByEnv?.[e]
                          return `${e.toUpperCase()}${at ? `(${new Date(at).toLocaleString()})` : ''}`
                        }).join('／')
                        : '—'}
                    </span>
                    <div style={{ color: C.ink2, paddingLeft: 2 }}>{a.note}</div>
                  </div>
                ))}
                {pools.envAudit.length > 8 && (
                  <div style={{ fontSize: 11, color: C.ink3 }}>…另外 {pools.envAudit.length - 8} 台</div>
                )}
              </div>
            </div>
          )
        })()}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(146px,1fr))', gap: 8 }}>
          <Kpi label="已達設定上限" value={dash(pools?.atCapCount)}
            sub={pools ? `台 · ${pools.levels.filter(l => l.atCap).map(l => l.levelName).join('、') || '—'}` : '—'}
            tone={pools && pools.atCapCount > 0 ? 'bad' : undefined}
            title="池值已經等於設定的 maxValue，累積改走溢流池。⚠️ 這是用實際池值比對設定上限算的，不是數 skipped_overflow——那個狀態的意思是「這筆沒驗」。" />
          <Kpi label="增減值不符" value={dash(pools?.summary.poolMismatch)}
            sub={pools ? `共驗 ${pools.summary.poolRows.toLocaleString()} 筆` : '—'}
            tone={pools && pools.summary.poolMismatch > 0 ? 'amb' : undefined}
            title="change ≈ (新投入額 − 舊投入額) × 增額%，誤差 > 0.01 就算不符" />
          <Kpi label="相符" value={pools ? pools.summary.poolOk.toLocaleString() : '—'}
            sub="誤差 ≤ 0.01" tone={pools && pools.summary.poolMismatch === 0 ? 'good' : undefined} />
          {/* 🚨 **不能取 levels[0]。**排序改成「我正在跑的池排最上面」之後，
              第一列不再是水位最高的那個——實測會顯示「最高水位 3.0%」，
              而真正的最高是 100%（JPBZZF3）。這種錯特別危險：數字看起來很正常，
              只是**默默把最嚴重的那個藏起來**。 */}
          {(() => {
            const top = (pools?.levels ?? []).reduce<PoolLevel | null>(
              (best, l) => l.waterPct === null ? best
                : (best === null || l.waterPct > (best.waterPct ?? -1)) ? l : best, null)
            return <Kpi label="最高水位" value={top ? `${top.waterPct!.toFixed(1)}%` : '—'}
              sub={top ? top.levelName : '—'}
              tone={top && top.waterPct! >= 100 ? 'bad' : undefined}
              title="占設定 maxValue 的百分比。⚠️ 這是全部獎池裡的最大值，不是表格第一列——表格是依「我正在跑的」優先排序的。" />
          })()}
        </div>

        {/* ⚠️ 水位一律用設定的 maxValue 算。獎池名稱裡的數字是 basevalue——
            2026-09-08 拿名稱當上限判斷過一次「已超出」，結論完全相反。 */}
        <div style={{ fontSize: 10.5, color: C.ink3, margin: '11px 0 4px' }}>
          各獎池水位 —— 一律用設定的 <code style={{ color: C.ink2 }}>maxValue</code> 計算，獎池名稱裡的數字是 basevalue 不是上限
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 620 }}>
            <thead><tr>
              {['獎池 Level', '水位（占上限）', '目前池值', '設定上限', '增額%', '不符', '狀態', ''].map((t, i) => (
                <th key={t || `sp${i}`} style={th}>{t}</th>))}
            </tr></thead>
            <tbody>
              {/* ⚠️ 上限要含「我的池」全部——我的池被截掉的話，這整個優先顯示就白做了。
                  我的池 3 個就顯示 3+8，不是只顯示前 8。 */}
              {(pools?.levels ?? []).slice(0, 8 + (pools?.levels.filter(l => l.mine).length ?? 0)).map(l => (
                <tr key={l.levelName} style={l.mine ? { background: 'rgba(56,189,248,.06)' } : undefined}>
                  <td style={td}>
                    <span style={{ display: 'inline-block', width: 3, height: 14, borderRadius: 2, verticalAlign: -3, marginRight: 7,
                      background: l.atCap ? C.bad : l.mismatch > 0 ? C.pending : C.match }} />
                    <b>{l.levelName}</b>
                    {/* ⚠️ gmid 用**跟狀態色不同**的顏色。狀態色（紅／黃／綠）已經在講
                        「這個池有沒有問題」，拿同一組色講「這是不是我的」會分不出來。 */}
                    <div style={{ fontSize: 10.5, marginLeft: 10 }}>
                      <span style={{ color: l.mine ? C.tool : C.ink3, fontWeight: l.mine ? 700 : 400 }}>
                        {l.sampleMachine}</span>
                      {l.machineCount > 1 && <span style={{ color: C.ink3 }}> · {l.machineCount} 台</span>}
                      {l.mine && l.myMachines.length > 1 && (
                        <span style={{ color: C.tool }}>（我的 {l.myMachines.length} 台）</span>
                      )}
                    </div>
                  </td>
                  <td style={td}>
                    {l.waterPct === null ? <span style={{ color: C.ink3 }}>—</span> : <>
                      <span style={{ display: 'inline-block', width: 74, height: 5, borderRadius: 3, background: '#1e3350',
                        overflow: 'hidden', verticalAlign: 'middle', marginRight: 7 }}>
                        <span style={{ display: 'block', height: '100%', width: `${Math.min(100, l.waterPct)}%`,
                          background: l.atCap ? C.bad : l.waterPct > 80 ? C.pending : C.match }} />
                      </span>
                      <span style={{ color: l.atCap ? C.bad : C.ink, fontWeight: l.atCap ? 700 : 400 }}>
                        {l.waterPct.toFixed(2)}%</span>
                    </>}
                  </td>
                  <td style={{ ...td, color: l.atCap ? C.bad : C.ink, fontWeight: l.atCap ? 700 : 400 }}>
                    {l.current === null ? '—' : Math.round(l.current).toLocaleString()}</td>
                  <td style={td}>{l.maxValue === null ? '—' : l.maxValue.toLocaleString()}</td>
                  <td style={{ ...td, color: (l.incrementPercent ?? 0) > 0.1 ? C.bad : C.ink }}>
                    {l.incrementPercent ?? '—'}</td>
                  <td style={{ ...td, color: l.mismatch > 0 ? C.bad : C.ink3, fontWeight: l.mismatch > 0 ? 700 : 400 }}>
                    {l.mismatch}</td>
                  <td style={td}>
                    <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 5,
                      background: l.atCap ? C.bad : l.mismatch > 0 ? C.pending : C.match }} />
                    {l.atCap ? '已滿頂 · 走溢流' : l.mismatch > 0 ? '有不符' : '正常'}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button type="button"
                      onClick={() => setPoolDetailLevel(poolDetailLevel === l.levelName ? null : l.levelName)}
                      style={{ background: poolDetailLevel === l.levelName ? C.tool : 'transparent',
                        color: poolDetailLevel === l.levelName ? '#06121f' : C.tool,
                        border: `1px solid ${C.tool}`, borderRadius: 5, padding: '2px 9px',
                        fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      {poolDetailLevel === l.levelName ? '收合' : '明細'}
                    </button>
                  </td>
                </tr>
              ))}
              {pools && pools.levels.length === 0 && (
                <tr><td colSpan={8} style={{ ...td, color: C.ink3 }}>這個時間窗內沒有獎池資料</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ── 單一獎池的逐筆明細 ────────────────────────────────────────────
            🚨 **「累積增額」跟「池淨變化」一定要並排放。**
               前者是「投注推上去多少」，後者是「池實際移動多少」。
               只給一個數字的話，中間發生過**中獎歸零或溢流**這件事會被藏起來——
               而那正是看明細的人最需要知道的事。 */}
        {poolDetailLevel && (() => {
          const lv = pools?.levels.find(l => l.levelName === poolDetailLevel)
          const d = poolDetail?.detail
          const scoped = detailMachines.length > 0
          const gap = d && d.netMove !== null ? d.netMove - d.sumChange : null
          return (
            <div style={{ marginTop: 12, border: `1px solid ${C.tool}44`, borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '8px 11px', background: 'rgba(56,189,248,.07)' }}>
                <b style={{ color: C.ink, fontSize: 12.5 }}>{poolDetailLevel}</b>
                <span style={{ color: C.ink3, fontSize: 11 }}>
                  逐筆明細 · {fmtWindow(minutes)}
                  {d && <> · 共 {d.total.toLocaleString()} 筆{d.total > d.rows.length && `（只列最近 ${d.rows.length} 筆）`} · 新的在上</>}
                </span>
                {/* ⚠️ 這個切換會改變分母，一定要看得到現在是哪一種 */}
                <button type="button" onClick={() => setPoolDetailMineOnly(v => !v)}
                  disabled={!lv?.myMachines.length}
                  title={lv?.myMachines.length ? '' : '這個池底下沒有你正在跑的機台，只能看整個 Level'}
                  style={{ marginLeft: 'auto', background: 'transparent', color: C.tool,
                    border: `1px solid ${C.tool}`, borderRadius: 5, padding: '2px 9px',
                    fontSize: 11, cursor: lv?.myMachines.length ? 'pointer' : 'not-allowed',
                    opacity: lv?.myMachines.length ? 1 : .45 }}>
                  {scoped ? `只看我的 ${lv?.myMachines.length} 台` : `整個 Level（${lv?.machineCount ?? '?'} 台）`}
                </button>
                <button type="button" onClick={() => setPoolDetailLevel(null)}
                  style={{ background: 'transparent', color: C.ink3, border: 'none', fontSize: 14, cursor: 'pointer' }}>✕</button>
              </div>

              {/* 摘要：累積 vs 淨變化擺在一起，差額自己說話 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(132px,1fr))',
                gap: 1, background: '#22304322' }}>
                {[
                  { k: '累積增額（窗內）', v: d ? d.sumChange.toFixed(3) : '—',
                    t: '這個時間窗內，每一筆投注推高的金額加總' },
                  { k: '池淨變化', v: d && d.netMove !== null ? d.netMove.toFixed(3) : '—',
                    t: '最後一筆的池值 − 第一筆之前的池值' },
                  { k: '兩者差額', v: gap === null ? '—' : (gap > 0 ? '+' : '') + gap.toFixed(3),
                    tone: gap !== null && Math.abs(gap) > 0.01 ? C.pending : undefined,
                    t: '差不多是 0 才代表「只有投注、沒發生別的事」。差很多通常是中獎歸零或溢流' },
                  { k: '增額%', v: d?.incrementPercent ?? lv?.incrementPercent ?? '—',
                    t: '每一單位投入額提撥到這個池的比率' },
                  { k: '驗證不符', v: d ? d.mismatch : '—', tone: d && d.mismatch > 0 ? C.bad : undefined,
                    t: 'change ≈ 投入額差 × 增額%，誤差 > 0.01 就算不符' },
                  { k: '投入額倒退', v: d ? d.negativeCoinIn : '—', tone: d && d.negativeCoinIn > 0 ? C.pending : undefined,
                    t: 'meter 重置會讓投入額變負；這種筆數多時，累積增額不可信' },
                  // ⚠️ 分母是**整個窗**（d.total），不是畫面上列的那幾筆——
                  //    `rows` 只是最近 200 筆，拿它當分母會把比率灌高
                  { k: '配到局號', v: d ? `${d.joined}/${d.total}` : '—',
                    t: '池變動報表沒有局號，是用投入額計數器（newcoinin ↔ total_bet）配上去的，不是用時間' },
                ].map(c => (
                  <div key={c.k} title={c.t} style={{ background: C.panel, padding: '7px 11px' }}>
                    <div style={{ fontSize: 10, color: C.ink3 }}>{c.k}</div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: c.tone ?? C.ink,
                      fontVariantNumeric: 'tabular-nums' }}>{c.v}</div>
                  </div>
                ))}
              </div>

              {/* 🚨 局號的**來源**一定要寫在畫面上。它不是報表帶的，是我們用時間配的；
                  不講清楚的話，看的人會以為那是池變動報表自己的欄位。 */}
              {d && d.rows.length > 0 && (
                <div style={{ fontSize: 11, color: C.ink3, padding: '6px 11px' }}>
                  局號是<b style={{ color: C.ink2 }}>配上去的</b>——池變動報表沒有局號。
                  配對鍵是<b style={{ color: C.ink2 }}>投入額計數器</b>（池的 <code>newcoinin</code> ↔ 後台該局的
                  {/* ⚠️ JSX 不會渲染 markdown，強調一律用 <b>，不要寫 ** ** */}
                  <code> total_bet</code>，同一段期間只差一個常數），<b style={{ color: C.ink2 }}>不是時間</b>——
                  實測兩邊時間差中位 −11.6 秒，用時間配會整段偏移一格。
                  時間只用來決定「這一筆屬於哪一段」（重新進機台會讓計數器歸零重算）。
                  這個窗內 {d.total} 筆裡配到 <b style={{ color: C.ink2 }}>{d.joined}</b> 筆
                  {d.joinAmbiguous > 0 && <>、<b style={{ color: C.pending }}>{d.joinAmbiguous}</b> 筆因為不只一局而不配</>}。
                  配不到多半是<b style={{ color: C.ink2 }}>別人打的那幾局</b>——池記的是整台機台的投注，
                  後台紀錄只有我們這個帳號的。
                </div>
              )}

              {/* ⚠️ 這段只在「真的有別台也在推同一個池」時才講。這個池只掛我這一台時
                  講「本來就會小於」是錯的——那時兩個數字本來就該相等。 */}
              {scoped && (lv?.machineCount ?? 0) > (lv?.myMachines.length ?? 0) && (
                <div style={{ fontSize: 11, color: C.ink3, padding: '6px 11px' }}>
                  ⚠️ 現在只算 <b style={{ color: C.tool }}>{lv?.myMachines.join('、')}</b>。
                  這個池整個 Level 共掛 {lv?.machineCount} 台，別台打的也會推高它，
                  所以<b style={{ color: C.ink2 }}>累積增額本來就會小於池淨變化</b>——那不是對不起來。
                </div>
              )}

              <div style={{ maxHeight: 300, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, minWidth: 640 }}>
                  <thead style={{ position: 'sticky', top: 0, background: C.panel2 }}><tr>
                    {['時間 ↓', '局號', '機台', '投入額變化', '本筆增加', '累積增加', '池值', '驗證'].map(t => (
                      <th key={t} style={th}>{t}</th>))}
                  </tr></thead>
                  <tbody>
                    {/* ⚠️ **最新的排最上面**（使用者要求）。`rows` 從後端來是由舊到新
                        （`cumulative` 要照那個順序才算得出來），這裡只反轉顯示——
                        每一列的「累積增加」仍然是**從這個窗的第一筆算到它為止**的值，
                        所以往下看會遞減，那是對的，不是算錯。 */}
                    {(d?.rows ?? []).slice().reverse().map((r, i) => (
                      <tr key={`${r.ts}-${r.machineName}-${i}`}>
                        <td style={{ ...td, color: C.ink3 }}>{fmtClock(r.ts)}</td>
                        {/* ⚠️ 局號是**配上去的**，不是池變動報表自己帶的。
                            配不出來就寫「—」並在 title 說明原因，不要挑最近的那一局充數。 */}
                        <td style={td} title={r.joinNote === 'matched'
                          ? `${r.orderId}｜spin_index ${r.spinIndex ?? '—'}｜與後台記錄時間差 ${r.joinDelta}ms（僅供診斷，配對用的是投入額計數器）`
                          : r.joinNote === 'ambiguous'
                            ? '同一個投入額計數值對到不只一局，配不出唯一對應 → 不猜'
                            : '找不到計數值對得上的局——可能是別人打的那幾筆（池記的是整台機台的投注），也可能是這一段的後台紀錄我們沒拉到'}>
                          {r.joinNote === 'matched'
                            ? <span style={{ color: C.ink }}>{shortOrderId(r.orderId)}</span>
                            : <span style={{ color: r.joinNote === 'ambiguous' ? C.pending : C.ink3 }}>
                              {r.joinNote === 'ambiguous' ? '多筆' : '—'}</span>}
                        </td>
                        <td style={td}>{r.machineName}</td>
                        <td style={{ ...td, fontVariantNumeric: 'tabular-nums',
                          color: r.coinIn < 0 ? C.bad : C.ink2, fontWeight: r.coinIn < 0 ? 700 : 400 }}>
                          {r.coinIn.toLocaleString()}</td>
                        <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: C.ink }}>
                          +{r.change.toFixed(3)}</td>
                        <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: C.tool, fontWeight: 600 }}>
                          {r.cumulative.toFixed(3)}</td>
                        <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: C.ink3 }}>
                          {r.before.toFixed(3)} → {r.after.toFixed(3)}</td>
                        <td style={td}>
                          {r.verify === 'mismatch'
                            ? <span style={{ color: C.bad, fontWeight: 700 }}>
                              不符{r.verifyDelta !== null && ` ${(r.verifyDelta > 0 ? '+' : '') + r.verifyDelta.toFixed(2)}`}</span>
                            : r.verify === 'ok' ? <span style={{ color: C.match }}>✓</span>
                              /* ⚠️ skipped_overflow 的字面意思是「這筆沒驗」，不是「池滿了」 */
                              : <span style={{ color: C.ink3 }}>{r.verify === 'skipped_overflow' ? '未驗（溢流）' : r.verify || '—'}</span>}
                        </td>
                      </tr>
                    ))}
                    {d && d.rows.length === 0 && (
                      <tr><td colSpan={8} style={{ ...td, color: C.ink3 }}>
                        這個時間窗內{scoped ? '、這幾台機台' : ''}沒有池變動</td></tr>
                    )}
                    {!poolDetail && (
                      <tr><td colSpan={8} style={{ ...td, color: C.ink3 }}>
                        {poolDetailBusy ? '讀取中…' : '讀不到明細'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })()}

        {/* ⚠️ 「可能原因」欄不是裝飾：只寫「加太多 10,409」會讓人去追一筆不存在的超發 */}
        {pools && pools.mismatches.length > 0 && (<>
          <div style={{ fontSize: 10.5, color: C.ink3, margin: '12px 0 4px' }}>不符明細 —— 每一筆都要講出「可能原因」</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 620 }}>
              <thead><tr>
                {['時間', '機台 / Level', '投入額變化', '預期增額', '實際增額', '差', '可能原因'].map(t => (
                  <th key={t} style={th}>{t}</th>))}
              </tr></thead>
              <tbody>
                {pools.mismatches.slice(0, 10).map((m, i) => (
                  <tr key={`${m.ts}-${m.levelName}-${i}`}>
                    <td style={{ ...td, color: C.ink3 }}>{fmtClock(m.ts)}</td>
                    <td style={td}>{m.machineName}<div style={{ color: C.ink3, fontSize: 10.5 }}>{m.levelName}</div></td>
                    <td style={{ ...td, color: m.coinIn < 0 ? C.bad : C.ink, fontWeight: m.coinIn < 0 ? 700 : 400 }}>
                      {m.coinIn.toLocaleString()}</td>
                    <td style={td}>{m.expected === null ? '—' : m.expected.toFixed(2)}</td>
                    <td style={td}>{m.actual}</td>
                    <td style={{ ...td, color: C.bad, fontWeight: 700 }}>
                      {m.delta === null ? '—' : (m.delta > 0 ? '+' : '') + m.delta.toFixed(2)}</td>
                    <td style={td}>
                      {m.cause === 'coinin_negative' ? <>
                        <span style={{ padding: '0 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                          background: 'rgba(251,191,36,.13)', color: C.pending }}>投入額倒退</span>
                        <span style={{ color: C.ink3, marginLeft: 6 }}>疑似 meter 重置</span>
                      </> : m.cause === 'at_basevalue' ? <>
                        <span style={{ padding: '0 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                          background: 'rgba(251,191,36,.13)', color: C.pending }}>池值＝basevalue</span>
                        <span style={{ color: C.ink3, marginLeft: 6 }}>疑似中獎歸零</span>
                      </> : <span style={{ color: C.ink3 }}>未分類 —— 需要人工看</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>)}
      </div>

      {/* ── ②c 機台總覽 ──────────────────────────────────────────────────────
          🚨 **一台一列，有問題的排前面。**多台一起跑時把數字加總會把問題藏起來：
             實測「掉單 1,250」其中 1,118 筆全在 BIGFULINK-2065 一台上。
          ⚠️ 刻意**不做**「總健康分數」——覆蓋率 58.8% 跟 100% 壓成一個數字，
             看到的人會去修沒壞的那台。 */}
      {pools && pools.machines.length > 0 && (
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, background: C.panel, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: C.tool, letterSpacing: '.05em' }}>機台總覽</span>
            <span style={{ fontSize: 11, color: C.ink3 }}>
              {machineFilter ? `已篩：${machineFilter}（再點一次取消）` : '點一列可篩選下方逐筆明細'}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 620 }}>
              <thead><tr>
                {['機台', '覆蓋率', '已對帳', '掉單', '待入帳', '未起注', '最後觀測'].map(t => (
                  <th key={t} style={th}>{t}</th>))}
              </tr></thead>
              <tbody>
                {pools.machines.map(m => {
                  const sel = machineFilter === m.machineType
                  const pct = m.coverage === null ? null : m.coverage * 100
                  return (
                    <tr key={`${m.machineType}|${m.gmid}`}
                      onClick={() => setMachineFilter(sel ? '' : m.machineType)}
                      style={{ cursor: 'pointer', background: sel ? '#14263c' : undefined }}>
                      <td style={td}>
                        <span style={{ display: 'inline-block', width: 3, height: 14, borderRadius: 2, verticalAlign: -3, marginRight: 7,
                          background: m.missing > 0 ? C.bad : pct !== null && pct < 95 ? C.pending : C.match }} />
                        <b>{m.machineType}</b>
                        <div style={{ color: C.ink3, fontSize: 10.5, marginLeft: 10 }}>{m.gmid}</div>
                      </td>
                      <td style={td}>
                        {pct === null ? <span style={{ color: C.ink3 }}>—</span> : <>
                          <span style={{ display: 'inline-block', width: 62, height: 5, borderRadius: 3, background: '#1e3350',
                            overflow: 'hidden', verticalAlign: 'middle', marginRight: 7 }}>
                            <span style={{ display: 'block', height: '100%', width: `${pct}%`,
                              background: pct < 80 ? C.bad : pct < 95 ? C.pending : C.match }} />
                          </span>
                          <span style={{ color: pct < 80 ? C.bad : C.ink }}>{pct.toFixed(1)}%</span>
                        </>}
                      </td>
                      <td style={td}>{m.matched.toLocaleString()} / {m.eligible.toLocaleString()}</td>
                      <td style={{ ...td, color: m.missing > 0 ? C.bad : C.ink3, fontWeight: m.missing > 0 ? 700 : 400 }}>
                        {m.missing}</td>
                      <td style={td}>{m.pending}</td>
                      {/* 未起注不是問題，用灰的——它本來就不需要入帳 */}
                      <td style={{ ...td, color: C.ink3 }}>{m.noRound}</td>
                      <td style={{ ...td, color: C.ink3 }}>{m.lastAt ? fmtClock(m.lastAt) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 12 }}>
        {/* ③a 五條對帳線 */}
        <Panel title="五條對帳線" right={`視窗 ${ov?.windowMinutes ?? '—'} 分鐘`}>
          {(ov?.lines ?? []).map(l => {
            const c = l.counts
            const tot = c ? c.match + c.pending + c.missing + c.ambiguous : 0
            const seg = (n: number, col: string) => tot ? <i style={{ width: `${(n / tot) * 100}%`, background: col, height: '100%', display: 'block' }} /> : null
            return (
              <div key={l.id} style={{
                display: 'grid', gridTemplateColumns: '1fr 120px 76px', alignItems: 'center', gap: 10,
                padding: '9px 12px', borderBottom: `1px solid ${C.line}`, fontSize: 12.5,
                opacity: l.implemented ? 1 : 0.55,
              }}>
                <div>
                  <b style={{ color: C.ink }}>{l.id} {l.name}</b>
                  <span style={{ display: 'block', fontSize: 10.5, color: C.ink3, marginTop: 1 }}>
                    {l.implemented ? l.desc : `未實作 · ${l.reason}`}
                    {/* ⚠️ 附樣本數——3 筆對到 3 筆也是 100%。金額比對 0 筆時要看得出來，
                        否則「不符 0」會被讀成「驗過了、沒問題」 */}
                    {l.amountChecked !== undefined && (
                      <span style={{ display: 'block', marginTop: 1, color: l.amountChecked === 0 ? C.pending : C.ink3 }}>
                        {l.amountChecked === 0 ? '金額比對：尚無樣本（agent 端要更新程式碼才會送 bet／win）'
                          : `金額比對 ${l.amountChecked} 筆 · 不符 ${l.amountBad}`}
                      </span>
                    )}
                  </span>
                </div>
                {l.implemented && c
                  ? <div style={{ display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', background: C.panel2 }}>
                    {seg(c.match, C.match)}{seg(c.pending, C.pending)}{seg(c.missing, C.bad)}{seg(c.ambiguous, C.ambiguous)}
                  </div>
                  : <div style={{ fontSize: 10.5, color: C.ink3, textAlign: 'center' }}>無資料</div>}
                {/* 差額為 null 顯示「—」；有值才用紅色加粗 */}
                <div style={{
                  textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                  color: l.delta ? C.bad : C.ink3, fontWeight: l.delta ? 700 : 400,
                }}>{dash(l.delta)}</div>
              </div>
            )
          })}
        </Panel>

        {/* ③b 時間軸 */}
        <Panel title="時間軸" right="每格 5 分鐘 · 顏色＝該格最嚴重狀態">
          <div style={{ padding: '14px 12px' }}>
            {/* ⚠️ 每格 minWidth 2px，選 24 小時（288 格）時總寬會超過欄寬——
                實測 1166px 塞進 697px 的欄位。加 overflowX 讓它自己捲，
                不要把整個面板撐開（那會連帶推歪隔壁的對帳線）。 */}
            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 34, overflowX: 'auto' }}>
              {(ov?.timeline ?? []).map(b => (
                <div key={b.at} title={`${fmtClock(b.at)} · ${b.n} 筆 · ${STATUS_LABEL[b.worst.toUpperCase()] ?? '無 spin'}`}
                  style={{
                    flex: 1, minWidth: 2, height: b.worst === 'missing' ? 34 : 26, borderRadius: 2,
                    background: b.worst === 'none' ? 'transparent' : `${STATUS_COLOR[b.worst.toUpperCase()] ?? C.tool}33`,
                    // 虛線＝該區間沒有 spin，要跟「有 spin 但沒問題」分得出來
                    borderBottom: b.worst === 'none' ? `2px dashed ${C.line}` : `2px solid ${STATUS_COLOR[b.worst.toUpperCase()] ?? C.tool}`,
                  }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.ink3, marginTop: 6 }}>
              <span>{ov?.timeline.length ? fmtClock(ov.timeline[0].at) : '—'}</span>
              <span>現在</span>
            </div>
            {ov && (
              <div style={{ marginTop: 12, fontSize: 11.5, color: C.ink3, lineHeight: 1.7 }}>
                綁定方式：殘差 <b style={{ color: C.ink }}>{ov.bindMethods.residual}</b> ·
                絕對窗 <b style={{ color: C.ink }}>{ov.bindMethods.absolute_window}</b> ·
                未標記 <b style={{ color: C.ink }}>{ov.bindMethods.unknown}</b>
                <span style={{ display: 'block', marginTop: 2 }}>
                  ⚠️ 兩種信心度差一個數量級，所以分開列——混成同一個回填率會把「嚴格對上的」
                  和「寬鬆撿到的」當成同一件事。
                </span>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* 近期告警 + 門檻設定 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 12 }}>
        <Panel title="近期告警" right={`未解決 ${ov?.findings.length ?? 0} 筆`}>
          {/* ⚠️ 這裡列的是**綁定層**的告警（掉單／無法判定），不是金額不符——
              agent 側目前沒有 bet／win，金額比對還做不了。不寫清楚的話，
              使用者會以為金額已經驗過了。 */}
          <div style={{ padding: '8px 13px', fontSize: 10.5, color: C.ink3, borderBottom: `1px solid ${C.line}` }}>
            綁定層告警（掉單／無法判定）。金額不符尚未實作——agent 端沒有 bet／win 可比。
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto' }}>
            {(ov?.findings ?? []).map(f => (
              <div key={f.id} style={{ display: 'flex', gap: 9, alignItems: 'baseline', padding: '7px 13px', borderBottom: `1px solid ${C.line}`, fontSize: 12 }}>
                <span style={{
                  fontSize: 10, padding: '1px 7px', borderRadius: 99, flex: 'none',
                  color: f.severity === 'critical' ? C.bad : C.pending,
                  background: `${f.severity === 'critical' ? C.bad : C.pending}22`,
                }}>{f.line === 'missing' ? '掉單' : f.line === 'ambiguous' ? '無法判定' : f.line}</span>
                <span style={{ color: C.ink3, fontVariantNumeric: 'tabular-nums' }}>{fmtClock(f.detectedAt)}</span>
                <span style={{ color: C.ink }}>{f.machineType ?? '—'} #{f.spinSeq ?? '—'}</span>
                <span style={{ color: C.ink3, fontSize: 11, marginLeft: 'auto', textAlign: 'right' }}>{f.note}</span>
              </div>
            ))}
            {ov && ov.findings.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: C.ink3, fontSize: 12 }}>
                {showAll ? '目前沒有未解決的綁定層告警' : '你目前沒有未解決的告警（不代表系統沒有異常——這裡只顯示屬於你的）'}
              </div>
            )}
          </div>
        </Panel>

        <Panel title="門檻設定" right={
          <button onClick={() => setSettingsOpen(o => !o)} style={{
            padding: '2px 9px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
            background: 'transparent', color: C.ink2, border: `1px solid ${C.line}`,
          }}>{settingsOpen ? '收合' : '展開'}</button>
        }>
          {settingsOpen ? (
            <div style={{ padding: '4px 0' }}>
              {settings.map(s => (
                <div key={s.key} style={{ padding: '10px 13px', borderBottom: `1px solid ${C.line}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b style={{ fontSize: 12.5, color: C.ink }}>{s.label}</b>
                    {s.bool ? (
                      /* ⚠️ 開關不能用數字輸入框：那個 min={1} 會讓「關閉」連打都打不進去，
                         使用者以為關掉了，其實值從來沒被寫進去 */
                      <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.ink2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={s.value === 1}
                          onChange={e => saveSetting(s.key, e.target.checked ? 1 : 0)} />
                        {s.value === 1 ? '開啟' : '關閉'}
                      </label>
                    ) : (
                      <>
                        <input type="number" defaultValue={s.value} min={1}
                          onBlur={e => { const v = Number(e.target.value); if (v !== s.value) saveSetting(s.key, v) }}
                          style={{ width: 78, marginLeft: 'auto', background: C.panel2, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 5, padding: '3px 7px', fontSize: 12, textAlign: 'right' }} />
                        <span style={{ fontSize: 11, color: C.ink3, width: 18 }}>{s.unit}</span>
                      </>
                    )}
                  </div>
                  {/* ⚠️ 每個參數都要寫「預設值」與「這個值影響什麼」——
                      不寫的話沒有人敢動它，也沒有人知道動了會怎樣 */}
                  <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 4, lineHeight: 1.6 }}>
                    預設 {s.dflt}{s.unit}{s.isDefault ? '' : '（已調整）'} · {s.effect}
                  </div>
                </div>
              ))}
              {settingMsg && <div style={{ padding: '8px 13px', fontSize: 11.5, color: settingMsg.includes('失敗') ? C.bad : C.match }}>{settingMsg}</div>}

              {/* ── 告警送出現況 ────────────────────────────────────────
                  ⚠️ 這一塊存在的理由：在它之前，「沒有告警」與「告警根本沒接」
                     在畫面上長得一模一樣。數字要把三種狀態分開講：
                     等著送的、被靜置期擋著的、水位線之前永遠不補送的。 */}
              <div style={{ padding: '10px 13px', borderTop: `1px solid ${C.line}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <b style={{ fontSize: 12.5, color: C.ink }}>告警送出現況</b>
                  <button onClick={testNotify} style={{
                    marginLeft: 'auto', padding: '2px 9px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                    background: 'transparent', color: C.ink2, border: `1px solid ${C.line}`,
                  }}>試發一則</button>
                </div>
                {notifySt ? (
                  <div style={{ fontSize: 11, color: C.ink3, lineHeight: 1.75 }}>
                    {!notifySt.configured && <div style={{ color: C.bad }}>⚠️ 尚未設定 Discord Webhook URL，告警無處可送</div>}
                    {notifySt.configured && !notifySt.enabled && <div style={{ color: C.pending }}>⚠️ 告警已關閉——findings 仍在累積，只是不送出</div>}
                    <div>
                      等著送 <b style={{ color: notifySt.queued ? C.pending : C.ink2 }}>{notifySt.queued}</b> 筆
                      {' · '}靜置期內 <b style={{ color: C.ink2 }}>{notifySt.held}</b> 筆
                      {' · '}上次送出 {notifySt.lastSentAt ? new Date(notifySt.lastSentAt).toLocaleString() : '從未'}
                    </div>
                    {notifySt.neverNotified > notifySt.queued && (
                      <div>
                        另有 <b style={{ color: C.ink2 }}>{notifySt.neverNotified - notifySt.queued}</b> 筆在水位線
                        （{notifySt.watermarkTs ? new Date(notifySt.watermarkTs).toLocaleString() : '尚未建立'}）之前，
                        <b>不會補送</b>——避免歷史告警一次灌進頻道。
                      </div>
                    )}
                  </div>
                ) : <div style={{ fontSize: 11, color: C.ink3 }}>讀取中…</div>}
                {notifyMsg && <div style={{ fontSize: 11.5, marginTop: 6, color: notifyMsg.startsWith('❌') ? C.bad : C.match }}>{notifyMsg}</div>}
              </div>
            </div>
          ) : (
            <div style={{ padding: '12px 13px', fontSize: 11.5, color: C.ink3 }}>
              {settings.length} 個可調參數（掉單門檻、時間窗、拉取間隔、收尾窗、告警送出）。
              {settings.some(s => !s.isDefault) && <b style={{ color: C.pending }}> 有參數已被調整過。</b>}
              {notifySt && !notifySt.configured && <b style={{ color: C.bad }}> 告警無處可送（未設 webhook）。</b>}
              {notifySt && notifySt.configured && !notifySt.enabled && <b style={{ color: C.pending }}> 告警已關閉。</b>}
            </div>
          )}
        </Panel>
      </div>

      {/* ④ 逐筆對帳 */}
      <Panel title="逐筆對帳" right={
        <span style={{ display: 'flex', gap: 6 }}>
          {(['all', 'abnormal', 'pending'] as const).map(f => (
            <button key={f} onClick={() => { setFilter(f); setCursor(null) }}
              style={{
                padding: '2px 9px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                background: filter === f ? '#2563eb' : 'transparent', color: filter === f ? '#fff' : C.ink2,
                border: `1px solid ${filter === f ? '#2563eb' : C.line}`,
              }}>{f === 'all' ? '全部' : f === 'abnormal' ? '僅異常' : '僅等待中'}</button>
          ))}
        </span>
      }>
        {/* 新資料暫存列：使用者在看表格中間時不自動插入 */}
        {buffered.length > 0 && (
          <button onClick={() => { setRows(prev => [...buffered, ...prev]); setBuffered([]); scrolledRef.current = false }}
            style={{
              width: '100%', padding: '7px', background: '#1e3a5f', color: C.ink, border: 'none',
              borderBottom: `1px solid ${C.line}`, cursor: 'pointer', fontSize: 12,
            }}>有 {buffered.length} 筆新資料，點此載入</button>
        )}
        <div onScroll={() => { scrolledRef.current = true }} style={{ maxHeight: 460, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: C.panel2, zIndex: 1 }}>
                {['時間', '機台', '局號', 'bet 前端', 'bet 後台', 'win 後台', '延遲', '綁定', '狀態'].map(t => (
                  <th key={t} style={{ padding: '7px 10px', textAlign: 'left', color: C.ink3, fontWeight: 600, fontSize: 10.5, letterSpacing: '.05em', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' }}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <>
                  <tr key={r.id} onClick={() => openDetail(r.id)} style={{
                    cursor: 'pointer',
                    // 整列上色，讓異常在滾動時也能被餘光抓到
                    background: r.status === 'MISSING' ? '#3b1a1a55' : r.status === 'AMBIGUOUS' ? '#2e2545' : r.status === 'PENDING' ? '#3a301355' : undefined,
                  }}>
                    <td style={td}>{fmtClock(r.observedAt)}</td>
                    <td style={td}>{r.machineType}<span style={{ color: C.ink3, fontSize: 10.5 }}> #{r.spinSeq}</span></td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 11, color: r.orderId ? C.ink : C.ink3 }}>
                      {r.orderId ? r.orderId.split('|').pop() : '—'}
                    </td>
                    {/* ⚠️ 前端與後台同一欄位並排，不是只給差值——並排才看得出是誰記錯 */}
                    <td style={tdN}>{dash(r.betFront)}</td>
                    <td style={tdN}>{dash(r.betBackend)}</td>
                    <td style={tdN}>{dash(r.winBackend)}</td>
                    <td style={tdN}>{dash(r.latencyMs, n => `${(n / 1000).toFixed(1)}s`)}</td>
                    <td style={{ ...td, fontSize: 10.5, color: C.ink3 }}>
                      {r.bindMethod === 'residual' ? '殘差' : r.bindMethod === 'absolute_window' ? '絕對窗' : '—'}
                      {r.lateArrival === 1 && <span style={{ color: C.pending }}> · 晚到</span>}
                    </td>
                    <td style={td}>
                      <span style={{
                        display: 'inline-block', padding: '1px 8px', borderRadius: 99, fontSize: 10.5,
                        // ⚠️ 顏色也要換掉。沿用「等待入帳」那個色等於還在暗示它會入帳——
                        //    用中性灰表示「這一筆不在流程裡」，不是一種待處理狀態。
                        color: noRound(r.outcome) ? C.ink3 : (STATUS_COLOR[r.status] ?? C.tool),
                        background: `${noRound(r.outcome) ? C.ink3 : (STATUS_COLOR[r.status] ?? C.tool)}22`,
                        border: `1px solid ${noRound(r.outcome) ? C.ink3 : (STATUS_COLOR[r.status] ?? C.tool)}55`,
                      }}>{noRound(r.outcome) ? (NO_ROUND_LABEL[r.outcome] ?? '未起注')
                        : (STATUS_LABEL[r.status] ?? r.status)}</span>
                    </td>
                  </tr>
                  {openId === r.id && (
                    <tr key={`${r.id}-d`}>
                      <td colSpan={9} style={{ padding: 12, background: C.panel2, borderBottom: `1px solid ${C.line}` }}>
                        <Detail d={detail} row={r} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: C.ink3, fontSize: 12.5 }}>
                  {/* ⚠️ **不能寫成「沒有異常」**——那會讓人以為系統驗過了、一切正常。
                      實際是「這個範圍內沒有屬於你的資料」，兩件事差很多。 */}
                  {showAll ? '這個範圍內沒有任何觀測紀錄'
                    : `你目前沒有對帳資料（${userLabel || '未指定帳號'}）。換個時間範圍，或切到「顯示全部」看看是不是別人的。`}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {cursor && (
          <button onClick={() => loadRows(false)} style={{
            width: '100%', padding: '8px', background: 'transparent', color: C.ink2,
            border: 'none', borderTop: `1px solid ${C.line}`, cursor: 'pointer', fontSize: 12,
          }}>載入更舊的紀錄</button>
        )}
      </Panel>
    </div>
  )
}

const th: React.CSSProperties = { textAlign: 'left', fontWeight: 600, color: C.ink3, fontSize: 10.5,
  padding: '6px 10px', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #22304310', color: C.ink2, whiteSpace: 'nowrap' }
const tdN: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: C.ink }

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 13px',
        borderBottom: `1px solid ${C.line}`, background: C.panel2, fontSize: 12, fontWeight: 600, color: C.ink,
      }}>
        {title}
        <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 400, color: C.ink3 }}>{right}</span>
      </div>
      {children}
    </div>
  )
}

function Kpi({ label, value, sub, tone, muted, title }: {
  label: string; value: string; sub?: string
  tone?: 'good' | 'bad' | 'amb'; muted?: boolean; title?: string
}) {
  const col = tone === 'good' ? C.match : tone === 'bad' ? C.bad : tone === 'amb' ? C.ambiguous : C.ink
  return (
    <div title={title} style={{
      border: `1px solid ${tone === 'bad' ? `${C.bad}66` : C.line}`, borderRadius: 8,
      padding: '11px 13px', background: tone === 'bad' ? '#3b1a1a33' : C.panel,
      // 未實作的格子整塊淡化——不允許在殘缺資料上顯示看起來正常的樣子
      opacity: muted ? 0.6 : 1,
    }}>
      <div style={{ fontSize: 10.5, letterSpacing: '.06em', color: C.ink3, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, marginTop: 3, color: muted ? C.ink3 : col, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

/** 下鑽：三方原始資料。這是唯一顯示原始資料的地方，上面所有畫面都是結論。 */
function Detail({ d, row }: { d: Record<string, unknown> | null; row: Row }) {
  if (!d) return <div style={{ fontSize: 12, color: C.ink3 }}>載入中…</div>
  const backend = d.backend as Record<string, unknown> | null
  const card = (title: string, body: React.ReactNode, absent?: boolean) => (
    <div style={{
      background: C.panel, border: `1px ${absent ? 'dashed' : 'solid'} ${C.line}`,
      borderRadius: 6, padding: '10px 12px', opacity: absent ? 0.75 : 1,
    }}>
      <div style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: C.ink3, marginBottom: 7 }}>{title}</div>
      {body}
    </div>
  )
  const kv = (k: string, v: unknown) => (
    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '2px 0', fontFamily: 'monospace' }}>
      <span style={{ color: C.ink3 }}>{k}</span>
      <span style={{ color: C.ink }}>{v === null || v === undefined || v === '' ? '—' : String(v)}</span>
    </div>
  )
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 10 }}>
      {card('A · AutoSpin 觀測', <>
        {kv('observedAt', new Date(row.observedAt).toISOString())}
        {kv('spinSeq', row.spinSeq)}
        {kv('outcome', row.outcome || '—')}
        {kv('bet', row.betFront)}
        {kv('餘額 前', row.balanceBefore)}
        {kv('餘額 後', row.balanceAfter)}
      </>)}
      {backend
        ? card('B · OSM 後台 gameRecordList', <>
          {kv('order_id', backend.orderId)}
          {kv('spin_index', backend.spinIndex)}
          {kv('bet', backend.bet)}
          {kv('win', backend.win)}
          {kv('bet_time_precise', backend.betTimePrecise ? new Date(Number(backend.betTimePrecise)).toISOString() : null)}
          {kv('username', backend.username)}
        </>)
        : card('B · OSM 後台', <div style={{ fontSize: 11.5, color: C.ink3 }}>
          {noRound(row.outcome)
            ? (row.outcome === 'not_started'
              ? '這一下被伺服器明確拒絕，沒有起局 → 後台本來就不會有紀錄，不需入帳'
              : '這一下沒有收到起注訊號（多半在特殊遊戲期間）→ 後台本來就不會有紀錄，不需入帳')
            : row.status === 'PENDING' ? '尚未入帳（還在等，不是問題）'
              : row.status === 'MISSING' ? '超過門檻仍查無對應紀錄 → 判定掉單'
                : '沒有綁定到後台紀錄'}
        </div>, true)}
      {/* ⚠️「本來就沒有」跟「該有卻沒抓到」要分開講 */}
      {card('C · LuckyLink', <div style={{ fontSize: 11.5, color: C.ink3 }}>
        {(d.luckylink as { reason?: string })?.reason ?? '尚未串接'}
        <span style={{ display: 'block', marginTop: 4 }}>（整條線未實作，不是這一筆抓不到）</span>
      </div>, true)}
    </div>
  )
}

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
import { useCallback, useEffect, useRef, useState } from 'react'

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

interface Lamp { key: string; label: string; state: string; agoSec: number | null; note: string; detail?: string }
interface Finding {
  id: number; line: string; severity: string; refId: string; detectedAt: number
  note: string; machineType?: string; spinSeq?: number; resolvedAt: number | null
}
interface Setting { key: string; label: string; unit: string; dflt: number; value: number; isDefault: boolean; effect: string }
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
  /** 跨使用者檢視。⚠️ 這是除錯用的，不是權限——過濾值本來就是 client 送的 header */
  const [showAll, setShowAll] = useState(false)
  /** 獎池與機台總覽。⚠️ 跟 overview 共用同一個 minutes——分開帶會讓上下兩塊用不同分母。 */
  const [pools, setPools] = useState<PoolsPayload | null>(null)
  /** 點機台那一列會把逐筆明細篩成那台；再點一次取消。 */
  const [machineFilter, setMachineFilter] = useState<string>('')

  const h = useCallback((): Record<string, string> =>
    userLabel ? { 'x-user-label': userLabel } : {}, [userLabel])

  const loadOverview = useCallback(async () => {
    try {
      const r = await fetch(`/api/autospin/live-ledger/overview?env=${env}&minutes=${minutes}${showAll ? '&scope=all' : ''}`, { headers: h() })
      const d = await r.json()
      if (d.ok) { setOv(d); setErr('') } else setErr(d.reason || '讀取失敗')
    } catch (e) { setErr(String(e)) }
  }, [env, minutes, h, showAll])

  const loadPools = useCallback(async () => {
    try {
      const r = await fetch(`/api/autospin/live-ledger/pools?env=${env}&minutes=${minutes}${showAll ? '&scope=all' : ''}`, { headers: h() })
      const d = await r.json() as PoolsPayload & { ok: boolean }
      if (d.ok) setPools(d)
    } catch { /* 獎池讀不到不該讓整頁掛掉——下面的區塊自己會顯示「讀取中」 */ }
  }, [env, minutes, h, showAll])

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
    const t = setInterval(() => { loadOverview(); loadRows(true) }, 5000)
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
  useEffect(() => { loadSettings() }, [loadSettings])

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
          其中 {ov!.unattributed} 筆**無法歸屬到任何帳號**（早於歸屬欄位上線）。
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
              <span style={{ color: C.ink3 }}>　分佈：{machines.join('、')}</span>
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
              {['獎池 Level', '水位（占上限）', '目前池值', '設定上限', '增額%', '不符', '狀態'].map(t => (
                <th key={t} style={th}>{t}</th>))}
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
                </tr>
              ))}
              {pools && pools.levels.length === 0 && (
                <tr><td colSpan={7} style={{ ...td, color: C.ink3 }}>這個時間窗內沒有獎池資料</td></tr>
              )}
            </tbody>
          </table>
        </div>

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
                    <input type="number" defaultValue={s.value} min={1}
                      onBlur={e => { const v = Number(e.target.value); if (v !== s.value) saveSetting(s.key, v) }}
                      style={{ width: 78, marginLeft: 'auto', background: C.panel2, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 5, padding: '3px 7px', fontSize: 12, textAlign: 'right' }} />
                    <span style={{ fontSize: 11, color: C.ink3, width: 18 }}>{s.unit}</span>
                  </div>
                  {/* ⚠️ 每個參數都要寫「預設值」與「這個值影響什麼」——
                      不寫的話沒有人敢動它，也沒有人知道動了會怎樣 */}
                  <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 4, lineHeight: 1.6 }}>
                    預設 {s.dflt}{s.unit}{s.isDefault ? '' : '（已調整）'} · {s.effect}
                  </div>
                </div>
              ))}
              {settingMsg && <div style={{ padding: '8px 13px', fontSize: 11.5, color: settingMsg.includes('失敗') ? C.bad : C.match }}>{settingMsg}</div>}
            </div>
          ) : (
            <div style={{ padding: '12px 13px', fontSize: 11.5, color: C.ink3 }}>
              {settings.length} 個可調參數（掉單門檻、時間窗、拉取間隔、收尾窗）。
              {settings.some(s => !s.isDefault) && <b style={{ color: C.pending }}> 有參數已被調整過。</b>}
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

import { useState, useEffect, useRef } from 'react'
import { type MeterEnv, METER_ENV_LABEL, METER_PLACEHOLDER, readMeterEnv, writeMeterEnv } from './meter-env'
import { rtpTrunc2, winLossJackpotTerm } from '../../shared/meter-rtp'
import { parseBoxLogs, mergeResentRows, boxProblemSummary, BOX_BAD_KINDS, type BoxCompareItem, type BoxCompareKind } from '../../shared/box-log-spins'

interface MeterInfo {
  coinIn: number
  coinOut: number
  jackpotWins: number
  winLoss: number
  rtp: number
  gamesPlayed: number
}

interface HandPayItem {
  handpay?: number
  payoutTime?: string
  betTime?: string
  username?: string
}

interface CountInterval {
  start: number; end: number; label: string
  meterGames: number | null; grCount: number | null; diff: number | null
  spans: number; stale: boolean; reset: boolean; edge: boolean; error?: string
}
interface CountDiag {
  complete: boolean
  mismatched: CountInterval[]
  cancelled: Array<[number, number]>
  notes: string[]
  dataRequests: string[]
  intervals: CountInterval[]
}

interface MeterResult {
  ok: boolean
  machineName: string
  source: 'osm' | 'gcp'
  date: string
  dayBoundary: 'gaming' | 'calendar'
  customStartTime: string | null
  /** v5.88.0 */
  customEndTime?: string | null
  windowStartLocal?: string
  windowEndLocal?: string
  /** v5.89.0：有自訂時間時 Meter 實際取的整點快照範圍；aligned=false 代表非整點、往外擴了 */
  meterWindow?: { startLocal: string; endLocal: string; aligned: boolean } | null
  pass: boolean
  /** v5.57.0：沒資料／沒活動／API 無效都不是 pass（舊的歷史紀錄沒有這欄，退回看 pass） */
  status?: 'pass' | 'fail' | 'noData' | 'noActivity' | 'apiError'
  statusWhy?: string
  expectedCoinOut: number
  actualCoinOut: number
  delta: number
  attendantPaidJp: number
  meter: MeterInfo | null
  gameRecord: { totalBet: number; totalWin: number; betRewardCredits: number; recordCount: number }
  jackpotAbnormality: { records: HandPayItem[]; sumHandpay: number; count: number }
  rawMeterRow: Record<string, unknown> | null
  /** v5.84.0：局數不同時的分段定位（舊紀錄沒有這欄） */
  countDiag?: CountDiag | { error: string } | null
  message?: string
}

interface BackendConfig {
  base_url: string
  origin: string
  channelId: string
  login_username: string
  login_password: string
  hasPassword: boolean
  hasToken: boolean
}

const EMPTY_CFG: BackendConfig = { base_url: '', origin: '', channelId: '', login_username: '', login_password: '', hasPassword: false, hasToken: false }

const KNOWN_FIELDS: { key: string; label: string }[] = [
  { key: '2', label: 'RTP' },
  { key: '5', label: 'Games Played' },
  { key: '6', label: 'Coin In' },
  { key: '10', label: 'Coin Out' },
  { key: '26', label: 'WIN/LOSE' },
  { key: '29', label: 'Jackpot Wins' },
]

function fmt(n: number | undefined | null, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** RTP 小數兩位直接捨去，跟後台一致；用原始 meter 值精確算（規則與邊界測試在 shared/meter-rtp.ts） */
function fmtRtp(m: { coinIn: number; coinOut: number; jackpotWins: number; rtp: number }, source: 'osm' | 'gcp'): string {
  const exact = rtpTrunc2(m.coinIn, m.coinOut, winLossJackpotTerm(source, m.jackpotWins))
  if (exact !== null) return fmt(exact)
  // 值大到只能用指數表示：退回後端的浮點 rtp，畫面照樣捨去
  return Number.isFinite(m.rtp) ? fmt(Math.trunc(m.rtp * 100) / 100) : '—'
}

/** v5.84.0：局數不同時，逐段比 Meter 局數與 Game Record 筆數，列出對不上的區間與要提供的資料 */
function CountDiagCard({ diag }: { diag: CountDiag | { error: string } }) {
  if ('error' in diag) {
    return (
      <section className="section-card st-card">
        <h3 className="section-title">局數差異定位</h3>
        <p className="st-msg-err" style={{ margin: 0 }}>{diag.error}（判定不受影響，仍是不一致）</p>
      </section>
    )
  }
  const inCancel = new Set(diag.cancelled.flat())
  return (
    <section className="section-card st-card">
      <h3 className="section-title">局數差異定位</h3>
      <div className="st-hint" style={{ marginBottom: 6 }}>
        逐段比對 Meter 每小時快照的局數與同時段 Game Record 筆數，只列出對不上的區間。只能縮小範圍，原因要看盒子日誌確認。
      </div>
      {diag.mismatched.length === 0
        ? <div className="st-dim">{diag.complete ? '每一段都對得上（差異可能在整天查詢的頭尾邊界），請重查一次確認。' : '沒有完成分段定位，原因見下方說明。'}</div>
        : (
          <table className="st-diag-table">
            <thead><tr><th>時段</th><th>Meter 局數</th><th>Game Record 筆數</th><th>差</th><th>備註</th></tr></thead>
            <tbody>
              {diag.mismatched.map((r, i) => (
                <tr key={r.start}>
                  <td>{r.label}</td>
                  <td>{r.meterGames ?? '—'}</td>
                  <td>{r.grCount ?? '—'}</td>
                  <td style={{ color: '#f87171' }}>{r.diff === null ? '—' : r.diff > 0 ? `+${r.diff}` : r.diff}</td>
                  <td className="st-dim">
                    {[
                      inCancel.has(i) && '與相鄰時段抵銷，疑似快照時間差',
                      r.edge && 'Meter 沒有快照涵蓋',
                      r.spans > 1 && `Meter 跨 ${r.spans} 個快照`,
                      r.reset && '計數器重置',
                      r.error && `查詢失敗：${r.error}`,
                    ].filter(Boolean).join('、')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {diag.notes.length > 0 && (
        <ul className="st-diag-notes">{diag.notes.map(n => <li key={n}>{n}</li>)}</ul>
      )}
      {diag.dataRequests.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 10 }}>請提供</h3>
          <ul className="st-diag-notes">{diag.dataRequests.map(n => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </section>
  )
}

/** v5.85.0：盒子日誌逐局比對結果 */
interface BoxLogResult {
  complete: boolean
  grTotal: number
  items: BoxCompareItem[]
  counts: Record<BoxCompareKind, number> & { matched: number; notCovered: number; edge: number; unfinished: number; nearBadLine: number }
  notes: string[]
  /** 前端解析資訊 */
  parsed: { files: number; spins: number; coverage: string; gaps: number; badLines: number; inWindow: number | null }
}

const BOX_KIND_LABEL: Record<BoxCompareKind, string> = {
  duplicate: '重複寫入（同一局 Game Record 有多筆）',
  suspect_missing: '疑似漏寫（日誌有、Game Record 沒有）',
  suspect_extra: '疑似多出（Game Record 有、日誌沒有）',
  amount_diff: '押注或贏分不同',
  ambiguous: '對到多局，無法確定',
  resent: '盒子重送／斷線重連',
  is_error: '盒子標記錯誤（isError）',
}
const BOX_KIND_BAD = BOX_BAD_KINDS

function fmtLocalSec(sec: number): string {
  return new Date((sec + 8 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 23)
}

function BoxLogCard({ box, loading, error }: { box: BoxLogResult | null; loading: boolean; error: string }) {
  return (
    <section className="section-card st-card">
      <h3 className="section-title">盒子日誌逐局比對</h3>
      {loading && <div className="st-dim">比對中…（解析日誌、抓整段 Game Record 明細）</div>}
      {error && <p className="st-msg-err" style={{ margin: 0 }}>{error}（對帳判定不受影響）</p>}
      {box && (() => {
        const bad = BOX_KIND_BAD.reduce((n, k) => n + box.counts[k], 0)
        const rows = mergeResentRows(box.items)
        const problems = boxProblemSummary(box.items)
        return (
          <>
            <div className="st-hint" style={{ marginBottom: 6 }}>
              日誌 {box.parsed.files} 個檔、{box.parsed.spins} 局（{box.parsed.coverage}）
              {box.parsed.inWindow !== null && box.parsed.inWindow !== box.parsed.spins && `，查詢時間內 ${box.parsed.inWindow} 局，另 ${box.parsed.spins - box.parsed.inWindow} 局在時間外不比對`} · Game Record {box.grTotal} 筆 · 對上 {box.counts.matched} 局
              {bad ? '' : '，沒有發現異常'}
              {!box.complete && <span style={{ color: '#fbbf24' }}> · 比對不完整，原因見下方說明</span>}
            </div>
            {problems.length > 0 && (
              <div style={{ color: '#f87171', fontWeight: 600, marginBottom: 6 }}>發現：{problems.join('、')}</div>
            )}
            {rows.length > 0 && (
              <table className="st-diag-table">
                <thead><tr><th>類型</th><th>spinid</th><th>開局時間</th><th>Game Record 單號</th><th>日誌 押注／贏分</th><th>Game Record 押注／贏分</th></tr></thead>
                <tbody>
                  {rows.map((it, i) => {
                    // 有問題的列整列紅字（使用者 1113：單號、金額一眼看得出來）
                    const isBad = BOX_KIND_BAD.includes(it.kind)
                    return (
                    <tr key={i} className={isBad ? 'st-diag-bad' : undefined}>
                      <td>{BOX_KIND_LABEL[it.kind]}</td>
                      <td>{it.spinid}</td>
                      <td>{fmtLocalSec(it.beginSec)}</td>
                      <td>{it.orderIds.length ? it.orderIds.map(id => <div key={id} style={{ whiteSpace: 'nowrap' }}>{id}</div>) : '—'}</td>
                      <td>
                        {it.box ? `${it.box.bet ?? '—'}／${it.box.win ?? '—'}` : '—'}
                        {it.box && (it.box.resends > 0 || it.box.reconnects > 0 || it.box.endSends > 1) && (
                          <span className={isBad ? undefined : 'st-dim'}>（{[
                            it.box.resends > 0 && `重送 ${it.box.resends} 次`,
                            it.box.reconnects > 0 && `斷線重連 ${it.box.reconnects} 次`,
                            it.box.endSends > 1 && `結束訊息印 ${it.box.endSends} 次${it.box.endVariants > 1 ? '、內容不同' : ''}`,
                          ].filter(Boolean).join('、')}）</span>
                        )}
                      </td>
                      <td>{it.gr?.length ? it.gr.map((g, i) => <div key={i} style={{ whiteSpace: 'nowrap' }}>{g.bet}／{g.win}</div>) : '—'}</td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {box.notes.length > 0 && <ul className="st-diag-notes">{box.notes.map(n => <li key={n}>{n}</li>)}</ul>}
          </>
        )
      })()}
    </section>
  )
}

/** Game Record／JP 卡片副標的時間範圍（舊歷史紀錄只有 customStartTime） */
function grRangeLabel(r: MeterResult): string {
  if (r.customEndTime || (r.customStartTime && r.windowStartLocal)) return `${r.windowStartLocal} ~ ${r.windowEndLocal}`
  return r.customStartTime ? `${r.date} ${r.customStartTime} 起` : `${r.date} 整日`
}

export function MeterReconcilePage() {
  // 環境（QAT／UAT）：決定查哪個後台、後台設定顯示哪一組。放在查詢列最前面（使用者 1104 選）
  const [env, setEnvState] = useState<MeterEnv>(() => readMeterEnv('meter'))
  // 切環境時，還沒回來的舊請求不能蓋掉新畫面（CodeX 1104）
  const envSeq = useRef(0)
  const querySeq = useRef(0)
  const [machineName, setMachineName] = useState('')
  const [source, setSource] = useState<'osm' | 'gcp'>('osm')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [dayBoundary, setDayBoundary] = useState<'gaming' | 'calendar'>('gaming')
  const [customStartTime, setCustomStartTime] = useState('')
  const [customEndTime, setCustomEndTime] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<MeterResult | null>(null)
  const [error, setError] = useState('')
  // v5.85.0：盒子日誌（選填）——只在瀏覽器解析，不上傳原檔
  const [boxFiles, setBoxFiles] = useState<File[]>([])
  const boxInputRef = useRef<HTMLInputElement>(null)
  // 按「清除」後，還在跑的日誌比對回來也不能再把結果放回畫面
  const boxClearSeq = useRef(0)
  const [box, setBox] = useState<BoxLogResult | null>(null)
  const [boxLoading, setBoxLoading] = useState(false)
  const [boxError, setBoxError] = useState('')

  const [configOpen, setConfigOpen] = useState(false)
  const [osmConfig, setOsmConfig] = useState<BackendConfig>(EMPTY_CFG)
  const [gcpConfig, setGcpConfig] = useState<BackendConfig>(EMPTY_CFG)
  const [savingCfg, setSavingCfg] = useState<'osm' | 'gcp' | null>(null)
  const [testingCfg, setTestingCfg] = useState<'osm' | 'gcp' | null>(null)
  const [cfgMsg, setCfgMsg] = useState<{ profile: 'osm' | 'gcp'; text: string; ok: boolean } | null>(null)
  const [legacy, setLegacy] = useState<{ osm: string | null; gcp: string | null }>({ osm: null, gcp: null })

  function setEnv(next: MeterEnv) {
    if (next === env) return
    envSeq.current++
    writeMeterEnv('meter', next)
    setEnvState(next)
    setResult(null); setError(''); setLoading(false); setCfgMsg(null); setBox(null); setBoxError(''); setBoxLoading(false)
    setOsmConfig(EMPTY_CFG); setGcpConfig(EMPTY_CFG)
  }

  async function loadConfig(profile: 'osm' | 'gcp', forEnv: MeterEnv = env) {
    const seq = envSeq.current
    const res = await fetch(`/api/osm/meter-reconcile/config?env=${forEnv}&profile=${profile}`)
    const d = await res.json()
    if (seq !== envSeq.current) return
    setLegacy(l => ({ ...l, [profile]: d.legacyUnclassified ?? null }))
    const setter = profile === 'osm' ? setOsmConfig : setGcpConfig
    setter({
      base_url: d.base_url || '', origin: d.origin || '', channelId: d.channelId || '',
      login_username: d.login_username || '', login_password: '',
      hasPassword: !!d.hasPassword, hasToken: !!d.hasToken,
    })
  }

  useEffect(() => { loadConfig('osm', env); loadConfig('gcp', env) }, [env])

  // 儲存／測試從按下那一刻就固定環境與序號：途中切了環境，結果不能填進另一個環境的畫面（CodeX 1104 P1）
  async function saveConfig(profile: 'osm' | 'gcp') {
    const seq = envSeq.current, forEnv = env
    setSavingCfg(profile)
    const cfg = profile === 'osm' ? osmConfig : gcpConfig
    try {
      const res = await fetch('/api/osm/meter-reconcile/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          env: forEnv, profile, base_url: cfg.base_url, origin: cfg.origin, channelId: cfg.channelId,
          login_username: cfg.login_username, login_password: cfg.login_password,
        }),
      })
      const d = await res.json()
      if (seq !== envSeq.current) return
      setCfgMsg({ profile, text: d.ok ? '已儲存' : `失敗：${d.message}`, ok: !!d.ok })
      await loadConfig(profile, forEnv)
    } finally {
      setSavingCfg(null)
    }
  }

  async function testConfig(profile: 'osm' | 'gcp') {
    const seq = envSeq.current, forEnv = env
    setTestingCfg(profile)
    try {
      const res = await fetch('/api/osm/meter-reconcile/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: forEnv, profile }),
      })
      const d = await res.json()
      if (seq !== envSeq.current) return
      setCfgMsg({ profile, text: d.message ?? (d.ok ? '成功' : '失敗'), ok: !!d.ok })
    } finally {
      setTestingCfg(null)
    }
  }

  /** 盒子日誌逐局比對：瀏覽器解析，只送每局清單給 server 對 Game Record 明細 */
  async function runBoxCompare(seq: number, q: number, clearSeq: number) {
    // CodeX 4581462：切環境（envSeq）或又按了一次查詢（querySeq）都讓這次結果作廢——上一台還沒回來就查下一台，舊回應不能蓋掉新結果
    const stale = () => seq !== envSeq.current || q !== querySeq.current || clearSeq !== boxClearSeq.current
    setBoxLoading(true); setBoxError(''); setBox(null)
    try {
      const files = [...boxFiles].sort((a, b) => a.name.localeCompare(b.name))
      const texts = await Promise.all(files.map(f => f.text()))
      if (stale()) return
      const p = parseBoxLogs(texts)
      if (!p.coverage) { setBoxError('日誌裡找不到任何一局（action_type:4／5），請確認是盒子日誌'); return }
      const res = await fetch('/api/osm/meter-reconcile/box-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env, machineName: machineName.trim(), source, date, dayBoundary, customStartTime: customStartTime || undefined, customEndTime: customEndTime || undefined,
          log: { spins: p.spins, coverage: p.coverage, gaps: p.gaps, badSecs: p.badSecs } }),
      })
      const d = await res.json()
      if (stale()) return
      if (!d.ok) { setBoxError(d.message || '比對失敗'); return }
      const notes: string[] = [...d.notes]
      if (p.badLines) notes.unshift(`日誌有 ${p.badLines} 行看起來是開局／結束紀錄但解析不了（可能被截斷），已略過，比對不完整`)
      // 跟 compareBoxLog 同一個判準：有結束的局看結算時間，沒結束的看開局時間
      const w = d.window as { start?: number; end?: number } | undefined
      const inWindow = w && Number.isFinite(w.start) && Number.isFinite(w.end)
        ? p.spins.filter(s => { const t = s.ended && s.endSec !== null ? s.endSec : s.beginUs / 1e6; return t >= w.start! && t < w.end! }).length
        : null
      setBox({ ...d, notes, complete: d.complete && p.badLines === 0,
        parsed: { files: files.length, spins: p.spins.length, coverage: `${fmtLocalSec(p.coverage.start).slice(0, 19)} ～ ${fmtLocalSec(p.coverage.end).slice(0, 19)}`, gaps: p.gaps.length, badLines: p.badLines, inWindow } })
    } catch (e) {
      if (stale()) return
      setBoxError(`比對失敗：${e}`)
    } finally {
      if (!stale()) setBoxLoading(false)
    }
  }

  /** 取消已選的盒子日誌：清掉檔案選擇與這份日誌的比對結果，對帳結果不動 */
  function clearBoxFiles() {
    boxClearSeq.current++
    setBoxFiles([])
    if (boxInputRef.current) boxInputRef.current.value = ''
    setBox(null); setBoxError(''); setBoxLoading(false)
  }

  async function handleQuery() {
    if (!machineName.trim()) { setError('請輸入機台名稱'); return }
    setLoading(true); setError(''); setResult(null); setBox(null); setBoxError(''); setBoxLoading(false)
    const seq = envSeq.current
    const q = ++querySeq.current
    // CodeX 1113：對帳還沒回來就按清除，回來時不能再拿舊的檔案啟動日誌比對
    const clearSeq = boxClearSeq.current
    const stale = () => seq !== envSeq.current || q !== querySeq.current
    try {
      const res = await fetch('/api/osm/meter-reconcile/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env, machineName: machineName.trim(), source, date, dayBoundary, customStartTime: customStartTime || undefined, customEndTime: customEndTime || undefined }),
      })
      const d = await res.json()
      if (stale()) return
      if (!d.ok) { setError(d.message || '查詢失敗'); return }
      setResult(d)
      if (boxFiles.length && clearSeq === boxClearSeq.current) void runBoxCompare(seq, q, clearSeq)
    } catch (e) {
      if (stale()) return
      setError(`查詢失敗：${e}`)
    } finally {
      if (!stale()) setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--rd-bg-2, #0b1322)', border: '1px solid var(--rd-line-2, #2d3f55)', borderRadius: 6, color: 'var(--rd-fg, #e2e8f0)',
    height: 30, padding: '0 8px', fontSize: 12,
  }
  const kvRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--rd-line, #0f172a)', fontVariantNumeric: 'tabular-nums' }

  return (
    <div className="st-q-page">
      {/* 新版（原型 v7）：查詢條件收成一列（短標籤在上、長說明降成底下一行小字）；結果每一塊都是原型面板。樣式在 redesign/pages/settings.css */}

      {/* Query bar */}
      <section className="section-card st-card st-q">
        <div className="st-q-row">
          <div className="st-q-f">
            <span className="st-q-l">環境</span>
            <div className="rd-tabs st-seg">
              {(['qat', 'uat'] as const).map(e => (
                <button key={e} type="button" className="rd-tab" aria-pressed={env === e} onClick={() => setEnv(e)}>{METER_ENV_LABEL[e]}</button>
              ))}
            </div>
          </div>
          <div className="st-q-f st-q-f--grow">
            <label className="st-q-l" htmlFor="pm-machine">機台名稱（Client Machine Name）</label>
            <input id="pm-machine" className="lst-field" value={machineName} onChange={e => setMachineName(e.target.value)}
              placeholder="例：Triple Treasure Pot(4321aruze)" />
          </div>
          <div className="st-q-f">
            <span className="st-q-l">資料來源</span>
            <div className="rd-tabs st-seg">
              {(['osm', 'gcp'] as const).map(s => (
                <button key={s} type="button" className="rd-tab" aria-pressed={source === s} onClick={() => setSource(s)}>
                  {s === 'osm' ? 'OSM（CP）' : 'GCP（NC）'}
                </button>
              ))}
            </div>
          </div>
          <div className="st-q-f">
            <label className="st-q-l" htmlFor="pm-date">日期</label>
            <input id="pm-date" className="lst-field" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="st-q-f">
            <span className="st-q-l">查詢範圍</span>
            <div className="rd-tabs st-seg">
              {([
                { key: 'gaming' as const, label: 'Gaming Day（06:00~隔天06:00）' },
                { key: 'calendar' as const, label: '自然日（00:00~24:00）' },
              ]).map(o => (
                <button key={o.key} type="button" className="rd-tab" aria-pressed={dayBoundary === o.key} onClick={() => setDayBoundary(o.key)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="st-q-f">
            <label className="st-q-l" htmlFor="pm-start">自訂時間（選填）</label>
            <div className="st-q-range">
              <input id="pm-start" className="lst-field st-q-time" type="time" step={1} aria-label="自訂起始時間" title="自訂起始時間"
                value={customStartTime} onChange={e => setCustomStartTime(e.target.value)} />
              <span className="st-q-range-to">to</span>
              <input id="pm-end" className="lst-field st-q-time" type="time" step={1} aria-label="自訂結束時間" title="自訂結束時間"
                value={customEndTime} onChange={e => setCustomEndTime(e.target.value)} />
              {(customStartTime || customEndTime) && (
                <button type="button" className="lst-btn" onClick={() => { setCustomStartTime(''); setCustomEndTime('') }} title="清掉自訂時間，回到整天">清除</button>
              )}
            </div>
          </div>
          <div className="st-q-f">
            <label className="st-q-l" htmlFor="pm-boxlog">盒子日誌（選填）</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input id="pm-boxlog" ref={boxInputRef} className="lst-field st-q-file" type="file" multiple accept=".log,.txt,text/plain"
                onChange={e => setBoxFiles(Array.from(e.target.files ?? []))} />
              {boxFiles.length > 0 && (
                <button type="button" className="lst-btn" onClick={clearBoxFiles} title="取消已選的盒子日誌，連同這份日誌的比對結果一起清掉">清除</button>
              )}
            </div>
          </div>
          <button type="button" className="submit-btn lst-btn st-q-go" onClick={handleQuery} disabled={loading}>
            {loading ? '查詢中…' : '查詢對帳'}
          </button>
        </div>
        <p className="st-q-hint">
          查詢範圍：比照 OSM/GCP 後台 EGM Hourly Meter 頁面的 Gaming Day 選項——這支報表只支援整天邊界，做不到像 Game Record 一樣精準到分秒。
          自訂時間：選填，可只填起始或結束、可到秒；Game Record／Jackpot Abnormality 照填的時間查，EGM Hourly Meter 取對應的整點快照相減（只有整點快照，填非整點會往外擴到整點）。Gaming Day 下早於 06:00 的時間算隔天凌晨。
          盒子日誌：選填，可一次選多個檔，只在瀏覽器解析、原檔不會上傳；有選的話會逐局對 Game Record，找出重複寫入、漏寫、多出、金額不同的局。
        </p>
      </section>

      {error && <div className="st-error">{error}</div>}

      {result && (() => {
        // v5.57.0：依 status 顯示——沒資料／沒活動／API 無效是灰色卡片，不是通過也不是失敗
        const st = result.status ?? (result.pass ? 'pass' : 'fail')
        const neutral = st === 'noData' || st === 'noActivity' || st === 'apiError'
        const noNumbers = st === 'noData' || st === 'apiError'   // 實際值／差值沒有意義 → 顯示「—」
        const tone = st === 'pass' ? { border: 'rgba(34,197,94,.45)', bg: 'rgba(34,197,94,.06)', fg: '#4ade80' }
          : neutral ? { border: 'rgba(148,163,184,.4)', bg: 'rgba(148,163,184,.06)', fg: '#cbd5e1' }
          : { border: 'rgba(239,68,68,.45)', bg: 'rgba(239,68,68,.06)', fg: '#f87171' }
        const label = st === 'pass' ? '通過' : st === 'fail' ? '失敗' : st === 'noActivity' ? '沒有活動' : '無法對帳'
        const why = result.statusWhy ?? (st === 'pass' ? '一致 — Coin Out 完全吻合' : '不一致 — Coin Out 有落差')
        return (
        <>
          {/* Verdict */}
          <section className="section-card st-card st-verdict" style={{ borderColor: tone.border, background: tone.bg }}>
            <span className={`lst-pill st-verdict-pill ${st === 'pass' ? 'lst-pill--pass' : neutral ? '' : 'lst-pill--fail'}`}>{label}</span>
            <div className="st-verdict-main">
              <div className="st-verdict-why" style={{ color: tone.fg }}>
                {why}
              </div>
              <div className="st-verdict-sub">
                {result.machineName} · {result.source === 'osm' ? 'OSM（CP）' : 'GCP（NC）'} · {result.date}（{result.dayBoundary === 'gaming' ? 'Gaming Day 06:00~隔天06:00' : '自然日 00:00~24:00'}）
                {result.customStartTime || result.customEndTime
                  ? <span style={{ color: '#fbbf24' }}> · 查詢範圍 {result.windowStartLocal ?? result.customStartTime} ~ {result.windowEndLocal ?? result.customEndTime}</span>
                  : '整天加總'}
              </div>
            </div>
            <div className="st-verdict-num">
              <div className="st-verdict-k">Coin Out 實際 − 預期</div>
              <div className="st-verdict-v" style={{ color: tone.fg }}>{noNumbers ? '—' : fmt(result.delta)}</div>
              {!noNumbers && result.meter && (() => {
                // v5.86.0：Jackpot Abnormality 的 JP 局不進 Game Record，要加回來比
                const hp = result.jackpotAbnormality?.count ?? 0
                const cd = result.meter.gamesPlayed - result.gameRecord.recordCount - hp
                return (
                  <>
                    <div className="st-verdict-k" style={{ marginTop: 6 }}>局數 Meter − Game Record{hp ? ' − JP' : ''}</div>
                    <div className="st-verdict-v" style={{ color: cd === 0 ? undefined : '#f87171' }}>{cd > 0 ? `+${cd}` : cd}</div>
                  </>
                )
              })()}
            </div>
          </section>

          {/* Formula */}
          <section className="section-card st-card st-formula">
            <b>公式（{result.source === 'osm' ? 'OSM' : 'GCP'}）</b>：預期 Coin Out =
            {result.source === 'osm' ? (
              <>
                <b>Game Record 總 Win</b> +
                <b>Attendant Paid JP</b> −
                <b>Jackpot Wins</b>（Jackpot Wins 有沒有被同一筆 Game Record 吃掉，取決於這次中獎走哪個派彩管道；沒被吃掉的部分會走 Attendant Paid JP，兩邊互補）
              </>
            ) : (
              <b>Game Record 總 Win</b>
            )}
            　＝<b style={{ color: '#7dd3fc' }}>{fmt(result.expectedCoinOut)}</b>
            　實際（EGM Meter Coin Out）＝<b style={{ color: tone.fg }}>{noNumbers ? '—' : fmt(result.actualCoinOut)}</b>
            <br />
            WIN / LOSE ＝{result.source === 'osm'
              ? <><b>Coin In</b> − <b>Coin Out</b> − <b>Jackpot Wins</b></>
              : <><b>Coin In</b> − <b>Coin Out</b>（NC 的 Coin Out 已含 Jackpot Wins，不再另扣）</>}
            　RTP ＝ <b>WIN / LOSE</b> ÷ <b>Coin In</b>
          </section>

          {/* Three source cards */}
          <div className="st-g3">
            <section className="section-card st-card">
              <h3 className="section-title">EGM Hourly Meter（差異值）</h3>
              <div className="st-hint st-card-sub">
                {result.source === 'osm' ? 'OSM（CP）' : 'GCP（NC）'} · {result.meterWindow
                  ? <span style={{ color: '#fbbf24' }}>{result.meterWindow.startLocal} ~ {result.meterWindow.endLocal} 快照相減{result.meterWindow.aligned ? '' : '（Meter 只有整點快照，已往外擴到整點，可能跟 Game Record 對不齊）'}</span>
                  : '查詢範圍內最後一個 bucket − 第一個 bucket'} · 可拿來對照 EGM Performance Meter（該報表通常要等到約 15:15 才有當日數據）
              </div>
              {result.meter ? (
                <>
                  <div style={kvRow}><span className="st-k">Coin In</span><span className="st-v">{fmt(result.meter.coinIn)}</span></div>
                  <div style={kvRow}><span className="st-k">Coin Out</span><span className="st-v" style={{ color: '#7dd3fc' }}>{fmt(result.meter.coinOut)}</span></div>
                  <div style={kvRow}><span className="st-k">Jackpot Wins</span><span className="st-v">{fmt(result.meter.jackpotWins)}</span></div>
                  <div style={kvRow}><span className="st-k">WIN / LOSE</span><span className="st-v" style={{ color: result.meter.winLoss < 0 ? '#f87171' : undefined }}>{fmt(result.meter.winLoss)}</span></div>
                  <div style={kvRow}><span className="st-k">RTP</span><span className="st-v" style={{ color: result.meter.rtp < 0 ? '#f87171' : undefined }}>{fmtRtp(result.meter, result.source)}%</span></div>
                  <div style={{ ...kvRow, borderBottom: 'none' }}><span className="st-k">Games Played</span><span className="st-v">{fmt(result.meter.gamesPlayed, 0)}</span></div>
                </>
              ) : <p className="st-dim">查無資料</p>}
            </section>

            <section className="section-card st-card">
              <h3 className="section-title">Game Record 加總</h3>
              <div className="st-hint st-card-sub">
                gameRecordList · {grRangeLabel(result)} · {result.gameRecord.recordCount} 筆
              </div>
              <div style={kvRow}><span className="st-k">總 Bet</span><span className="st-v">{fmt(result.gameRecord.totalBet)}</span></div>
              <div style={kvRow}><span className="st-k">總 Win</span><span className="st-v" style={{ color: '#7dd3fc' }}>{fmt(result.gameRecord.totalWin)}</span></div>
              <div style={kvRow}><span className="st-k">Bet Reward Credits（泥碼下注額）</span><span className="st-v" style={{ color: '#fbbf24' }}>{fmt(result.gameRecord.betRewardCredits)}</span></div>
              <div style={{ ...kvRow, borderBottom: 'none' }}><span className="st-k">記錄筆數</span><span className="st-v">{result.gameRecord.recordCount}</span></div>
            </section>

            <section className="section-card st-card">
              <h3 className="section-title">Jackpot Abnormality（Attendant Paid JP）</h3>
              <div className="st-hint st-card-sub">
                getHandPayRecord · {grRangeLabel(result)} · {result.jackpotAbnormality.count} 筆
              </div>
              {result.jackpotAbnormality.records.length === 0
                ? <p className="st-dim">當日無 Handpay 記錄</p>
                : result.jackpotAbnormality.records.slice(0, 5).map((it, i) => (
                  <div key={i} className="st-hp-row">
                    <span>{it.payoutTime?.slice(11, 16) ?? '—'} · {it.username ?? '—'}</span>
                    <span style={{ color: '#fbbf24', fontWeight: 700 }}>{fmt(it.handpay)}</span>
                  </div>
                ))
              }
              {result.jackpotAbnormality.records.length > 5 && (
                <div className="st-hint">...還有 {result.jackpotAbnormality.records.length - 5} 筆</div>
              )}
              <div style={{ ...kvRow, marginTop: 4, borderBottom: 'none' }}><span className="st-k">Attendant Paid JP 小計</span><span className="st-v" style={{ color: '#7dd3fc' }}>{fmt(result.attendantPaidJp)}</span></div>
            </section>
          </div>

          {result.countDiag && <CountDiagCard diag={result.countDiag} />}
          {(boxLoading || box || boxError) && <BoxLogCard box={box} loading={boxLoading} error={boxError} />}

          {/* Raw field debug */}
          <details className="section-card st-card st-details">
            <summary>原始欄位對照表（除錯用，已驗證欄位標色）</summary>
            <div className="st-raw-grid">
              {result.rawMeterRow && Object.entries(result.rawMeterRow)
                .filter(([k]) => !['0', '1', 'useLastData', 'debug'].includes(k))
                .map(([k, v]) => {
                  const known = KNOWN_FIELDS.find(f => f.key === k)
                  return (
                    <div key={k} className="st-raw-cell" style={known ? { borderColor: 'rgba(34,197,94,.35)' } : undefined}>
                      <div style={{ color: known ? '#4ade80' : undefined }}>
                        欄位 {k}{known ? ` · ${known.label}` : ''}{!known && <span className="st-dim" style={{ fontSize: 9.5 }}> 語意未確認</span>}
                      </div>
                      <div className="st-raw-v">{String(v)}</div>
                    </div>
                  )
                })}
            </div>
          </details>
        </>
        )
      })()}

      {/* Backend config */}
      <details className="section-card st-card st-details" open={configOpen} onToggle={e => setConfigOpen((e.target as HTMLDetailsElement).open)}>
        <summary>後台設定 · {METER_ENV_LABEL[env]}（OSM / GCP 兩組後台連線資訊；QAT、UAT 各存一組，跟著上方環境切換）</summary>
        {(legacy.osm || legacy.gcp) && (
          <p className="st-msg-err" style={{ margin: '8px 0 0' }}>
            舊版只有一組設定，其中 {[legacy.osm && `OSM（${legacy.osm || '空白網址'}）`, legacy.gcp && `GCP（${legacy.gcp || '空白網址'}）`].filter(Boolean).join('、')} 判斷不出是 QAT 還是 UAT，沒有自動搬過來，請在對應環境重新填寫。
          </p>
        )}
        <div className="st-cfg-grid">
          {(['osm', 'gcp'] as const).map(profile => {
            const cfg = profile === 'osm' ? osmConfig : gcpConfig
            const setCfg = profile === 'osm' ? setOsmConfig : setGcpConfig
            return (
              <div key={profile} className="st-cfg">
                <div className="st-cfg-h">{profile === 'osm' ? 'OSM（CP）' : 'GCP（NC）'}</div>
                {([
                  ['base_url', 'Base URL', METER_PLACEHOLDER[env][profile].base_url],
                  ['origin', 'Origin', METER_PLACEHOLDER[env][profile].origin],
                  ['channelId', 'Channel ID', METER_PLACEHOLDER[env][profile].channelId],
                  ['login_username', '登入帳號', ''],
                  ['login_password', '登入密碼（留空＝不變更）', ''],
                ] as const).map(([key, label, ph]) => (
                  <div key={key} className="st-cfg-row">
                    <label className="st-cfg-l">{label}</label>
                    <input value={cfg[key]} onChange={e => setCfg(c => ({ ...c, [key]: e.target.value }))}
                      placeholder={ph} type={key === 'login_password' ? 'password' : 'text'}
                      style={{ flex: 1, minWidth: 0, ...inputStyle }} />
                  </div>
                ))}
                <div className="st-cfg-actions">
                  {cfgMsg?.profile === profile && (
                    <span className={cfgMsg.ok ? 'st-msg-ok' : 'st-msg-err'}>{cfgMsg.text}</span>
                  )}
                  <button type="button" className="btn-ghost lst-btn" onClick={() => testConfig(profile)} disabled={testingCfg === profile}>
                    {testingCfg === profile ? '測試中…' : '測試登入'}
                  </button>
                  <button type="button" className="submit-btn lst-btn" onClick={() => saveConfig(profile)} disabled={savingCfg === profile}>
                    {savingCfg === profile ? '儲存中…' : '儲存設定'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </details>
    </div>
  )
}

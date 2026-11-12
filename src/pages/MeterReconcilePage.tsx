import { useState, useEffect, useRef } from 'react'
import { type MeterEnv, METER_ENV_LABEL, METER_PLACEHOLDER, readMeterEnv, writeMeterEnv } from './meter-env'
import { truncRtp2 } from '../../shared/meter-rtp'

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

interface MeterResult {
  ok: boolean
  machineName: string
  source: 'osm' | 'gcp'
  date: string
  dayBoundary: 'gaming' | 'calendar'
  customStartTime: string | null
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

/** RTP 小數兩位直接捨去，跟後台一致；規則與邊界測試在 shared/meter-rtp.ts */
function fmtRtp(n: number | undefined | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return fmt(truncRtp2(n))
}

export function MeterReconcilePage() {
  // 環境（QAT／UAT）：決定查哪個後台、後台設定顯示哪一組。放在查詢列最前面（使用者 1104 選）
  const [env, setEnvState] = useState<MeterEnv>(() => readMeterEnv('meter'))
  // 切環境時，還沒回來的舊請求不能蓋掉新畫面（CodeX 1104）
  const envSeq = useRef(0)
  const [machineName, setMachineName] = useState('')
  const [source, setSource] = useState<'osm' | 'gcp'>('osm')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [dayBoundary, setDayBoundary] = useState<'gaming' | 'calendar'>('gaming')
  const [customStartTime, setCustomStartTime] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<MeterResult | null>(null)
  const [error, setError] = useState('')

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
    setResult(null); setError(''); setLoading(false); setCfgMsg(null)
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

  async function handleQuery() {
    if (!machineName.trim()) { setError('請輸入機台名稱'); return }
    setLoading(true); setError(''); setResult(null)
    const seq = envSeq.current
    try {
      const res = await fetch('/api/osm/meter-reconcile/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env, machineName: machineName.trim(), source, date, dayBoundary, customStartTime: customStartTime || undefined }),
      })
      const d = await res.json()
      if (seq !== envSeq.current) return
      if (!d.ok) { setError(d.message || '查詢失敗'); return }
      setResult(d)
    } catch (e) {
      if (seq !== envSeq.current) return
      setError(`查詢失敗：${e}`)
    } finally {
      if (seq === envSeq.current) setLoading(false)
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
            <label className="st-q-l" htmlFor="pm-start">自訂起始時間</label>
            <input id="pm-start" className="lst-field st-q-time" type="time" value={customStartTime} onChange={e => setCustomStartTime(e.target.value)} />
          </div>
          <button type="button" className="submit-btn lst-btn st-q-go" onClick={handleQuery} disabled={loading}>
            {loading ? '查詢中…' : '查詢對帳'}
          </button>
        </div>
        <p className="st-q-hint">
          查詢範圍：比照 OSM/GCP 後台 EGM Hourly Meter 頁面的 Gaming Day 選項——這支報表只支援整天邊界，做不到像 Game Record 一樣精準到分秒。
          自訂起始時間：選填，機台當天有 meter reset 時用。
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
                {result.customStartTime
                  ? <span style={{ color: '#fbbf24' }}> · Game Record 自 {result.customStartTime} 起算</span>
                  : '整天加總'}
              </div>
            </div>
            <div className="st-verdict-num">
              <div className="st-verdict-k">實際 − 預期（差值）</div>
              <div className="st-verdict-v" style={{ color: tone.fg }}>{noNumbers ? '—' : fmt(result.delta)}</div>
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
          </section>

          {/* Three source cards */}
          <div className="st-g3">
            <section className="section-card st-card">
              <h3 className="section-title">EGM Hourly Meter（差異值）</h3>
              <div className="st-hint st-card-sub">
                {result.source === 'osm' ? 'OSM（CP）' : 'GCP（NC）'} · 查詢範圍內最後一個 bucket − 第一個 bucket · 可拿來對照 EGM Performance Meter（該報表通常要等到約 15:15 才有當日數據）
              </div>
              {result.meter ? (
                <>
                  <div style={kvRow}><span className="st-k">Coin In</span><span className="st-v">{fmt(result.meter.coinIn)}</span></div>
                  <div style={kvRow}><span className="st-k">Coin Out</span><span className="st-v" style={{ color: '#7dd3fc' }}>{fmt(result.meter.coinOut)}</span></div>
                  <div style={kvRow}><span className="st-k">Jackpot Wins</span><span className="st-v">{fmt(result.meter.jackpotWins)}</span></div>
                  <div style={kvRow}><span className="st-k">WIN / LOSE</span><span className="st-v" style={{ color: result.meter.winLoss < 0 ? '#f87171' : undefined }}>{fmt(result.meter.winLoss)}</span></div>
                  <div style={kvRow}><span className="st-k">RTP</span><span className="st-v" style={{ color: result.meter.rtp < 0 ? '#f87171' : undefined }}>{fmtRtp(result.meter.rtp)}%</span></div>
                  <div style={{ ...kvRow, borderBottom: 'none' }}><span className="st-k">Games Played</span><span className="st-v">{fmt(result.meter.gamesPlayed, 0)}</span></div>
                </>
              ) : <p className="st-dim">查無資料</p>}
            </section>

            <section className="section-card st-card">
              <h3 className="section-title">Game Record 加總</h3>
              <div className="st-hint st-card-sub">
                gameRecordList · {result.date}{result.customStartTime ? ` ${result.customStartTime} 起` : ' 整日'} · {result.gameRecord.recordCount} 筆
              </div>
              <div style={kvRow}><span className="st-k">總 Bet</span><span className="st-v">{fmt(result.gameRecord.totalBet)}</span></div>
              <div style={kvRow}><span className="st-k">總 Win</span><span className="st-v" style={{ color: '#7dd3fc' }}>{fmt(result.gameRecord.totalWin)}</span></div>
              <div style={kvRow}><span className="st-k">Bet Reward Credits（泥碼下注額）</span><span className="st-v" style={{ color: '#fbbf24' }}>{fmt(result.gameRecord.betRewardCredits)}</span></div>
              <div style={{ ...kvRow, borderBottom: 'none' }}><span className="st-k">記錄筆數</span><span className="st-v">{result.gameRecord.recordCount}</span></div>
            </section>

            <section className="section-card st-card">
              <h3 className="section-title">Jackpot Abnormality（Attendant Paid JP）</h3>
              <div className="st-hint st-card-sub">
                getHandPayRecord · {result.date}{result.customStartTime ? ` ${result.customStartTime} 起` : ' 整日'} · {result.jackpotAbnormality.count} 筆
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

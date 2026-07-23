import { useState, useEffect } from 'react'

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
  hour: string
  pass: boolean
  expectedCoinOut: number
  actualCoinOut: number
  delta: number
  attendantPaidJp: number
  meter: MeterInfo | null
  gameRecord: { totalBet: number; totalWin: number; recordCount: number }
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

export function MeterReconcilePage() {
  const [machineName, setMachineName] = useState('')
  const [source, setSource] = useState<'osm' | 'gcp'>('osm')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [hour, setHour] = useState('12:00')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<MeterResult | null>(null)
  const [error, setError] = useState('')

  const [configOpen, setConfigOpen] = useState(false)
  const [osmConfig, setOsmConfig] = useState<BackendConfig>(EMPTY_CFG)
  const [gcpConfig, setGcpConfig] = useState<BackendConfig>(EMPTY_CFG)
  const [savingCfg, setSavingCfg] = useState<'osm' | 'gcp' | null>(null)
  const [testingCfg, setTestingCfg] = useState<'osm' | 'gcp' | null>(null)
  const [cfgMsg, setCfgMsg] = useState<{ profile: 'osm' | 'gcp'; text: string; ok: boolean } | null>(null)

  async function loadConfig(profile: 'osm' | 'gcp') {
    const res = await fetch(`/api/osm/meter-reconcile/config?profile=${profile}`)
    const d = await res.json()
    const setter = profile === 'osm' ? setOsmConfig : setGcpConfig
    setter({
      base_url: d.base_url || '', origin: d.origin || '', channelId: d.channelId || '',
      login_username: d.login_username || '', login_password: '',
      hasPassword: !!d.hasPassword, hasToken: !!d.hasToken,
    })
  }

  useEffect(() => { loadConfig('osm'); loadConfig('gcp') }, [])

  async function saveConfig(profile: 'osm' | 'gcp') {
    setSavingCfg(profile)
    const cfg = profile === 'osm' ? osmConfig : gcpConfig
    try {
      const res = await fetch('/api/osm/meter-reconcile/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile, base_url: cfg.base_url, origin: cfg.origin, channelId: cfg.channelId,
          login_username: cfg.login_username, login_password: cfg.login_password,
        }),
      })
      const d = await res.json()
      setCfgMsg({ profile, text: d.ok ? '✅ 已儲存' : `失敗：${d.message}`, ok: !!d.ok })
      await loadConfig(profile)
    } finally {
      setSavingCfg(null)
    }
  }

  async function testConfig(profile: 'osm' | 'gcp') {
    setTestingCfg(profile)
    try {
      const res = await fetch('/api/osm/meter-reconcile/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }),
      })
      const d = await res.json()
      setCfgMsg({ profile, text: d.message ?? (d.ok ? '✅ 成功' : '失敗'), ok: !!d.ok })
    } finally {
      setTestingCfg(null)
    }
  }

  async function handleQuery() {
    if (!machineName.trim()) { setError('請輸入機台名稱'); return }
    setLoading(true); setError(''); setResult(null)
    try {
      const res = await fetch('/api/osm/meter-reconcile/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineName: machineName.trim(), source, date, hour }),
      })
      const d = await res.json()
      if (!d.ok) { setError(d.message || '查詢失敗'); return }
      setResult(d)
    } catch (e) {
      setError(`查詢失敗：${e}`)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    background: '#0f172a', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0',
    padding: '8px 10px', fontSize: 13,
  }
  const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 5, display: 'block' }
  const card: React.CSSProperties = { background: '#162032', border: '1px solid #2d3f55', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }
  const kvRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #0f172a', fontVariantNumeric: 'tabular-nums' }

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
          🧮 Performance Meter 對帳
        </h2>
        <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
          OSM / GCP EGM Metering 對 Game Record + Jackpot Abnormality，驗證 Coin Out 是否一致
        </p>
      </div>

      {/* Query bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', background: '#111c30', border: '1px solid #23344d', borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div>
          <label style={labelStyle}>機台名稱（Client Machine Name）</label>
          <input value={machineName} onChange={e => setMachineName(e.target.value)}
            placeholder="例：Triple Treasure Pot(4321aruze)" style={{ ...inputStyle, minWidth: 260 }} />
        </div>
        <div>
          <label style={labelStyle}>資料來源</label>
          <div style={{ display: 'flex', border: '1px solid #2d3f55', borderRadius: 7, overflow: 'hidden' }}>
            {(['osm', 'gcp'] as const).map(s => (
              <button key={s} onClick={() => setSource(s)}
                style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer',
                  background: source === s ? '#2563eb' : '#0f172a', color: source === s ? '#fff' : '#94a3b8' }}>
                {s === 'osm' ? 'OSM（CP）' : 'GCP（NC）'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle}>日期</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>時間（到小時，用於 EGM Meter 讀數；Game Record / Jackpot 為整日加總）</label>
          <input type="time" step={3600} value={hour} onChange={e => setHour(e.target.value)} style={inputStyle} />
        </div>
        <button onClick={handleQuery} disabled={loading}
          style={{ marginLeft: 'auto', padding: '9px 22px', background: loading ? '#475569' : '#2563eb', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: loading ? 'default' : 'pointer' }}>
          {loading ? '查詢中…' : '🔍 查詢對帳'}
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.35)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#f87171', fontSize: 13 }}>
          {error}
        </div>
      )}

      {result && (
        <>
          {/* Verdict */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, borderRadius: 12, padding: '16px 20px', marginBottom: 16,
            border: `1px solid ${result.pass ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'}`,
            background: result.pass ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
          }}>
            <div style={{ fontSize: 28 }}>{result.pass ? '✅' : '❌'}</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: result.pass ? '#4ade80' : '#f87171' }}>
                {result.pass ? '一致 — Coin Out 完全吻合' : '不一致 — Coin Out 有落差'}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                {result.machineName} · {result.source === 'osm' ? 'OSM（CP）' : 'GCP（NC）'} · {result.date} {result.hour} 前累計
              </div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: result.pass ? '#4ade80' : '#f87171' }}>{fmt(result.delta)}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>實際 − 預期（差值）</div>
            </div>
          </div>

          {/* Formula */}
          <div style={{ background: '#0f172a', border: '1px solid #23344d', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
            <b style={{ color: '#e2e8f0' }}>公式（{result.source === 'osm' ? 'OSM' : 'GCP'}）</b>：預期 Coin Out =
            {result.source === 'osm' ? (
              <>
                <b style={{ color: '#e2e8f0' }}>Game Record 總 Win</b> −
                <b style={{ color: '#e2e8f0' }}>Jackpot Wins</b> −
                <b style={{ color: '#e2e8f0' }}>Attendant Paid JP</b> ＝
                <b style={{ color: '#e2e8f0' }}>{fmt(result.gameRecord.totalWin)}</b> −
                <b style={{ color: '#e2e8f0' }}>{fmt(result.meter?.jackpotWins)}</b> −
                <b style={{ color: '#e2e8f0' }}>{fmt(result.attendantPaidJp)}</b> ＝
              </>
            ) : (
              <>
                <b style={{ color: '#e2e8f0' }}>Game Record 總 Win</b>（含 Jackpot Wins + Attendant Paid JP）＝
              </>
            )}
            <b style={{ color: '#7dd3fc' }}>{fmt(result.expectedCoinOut)}</b>
            　實際（EGM Meter Coin Out）＝<b style={{ color: result.pass ? '#4ade80' : '#f87171' }}>{fmt(result.actualCoinOut)}</b>
          </div>

          {/* Three source cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 16 }}>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6' }} />
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800 }}>EGM Performance Meter</h3>
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: -6 }}>
                {result.source === 'osm' ? 'OSM（CP）' : 'GCP（NC）'} · 截至 {result.hour}
              </div>
              {result.meter ? (
                <>
                  <div style={kvRow}><span style={{ fontSize: 12, color: '#94a3b8' }}>Coin In</span><span style={{ fontSize: 13, fontWeight: 700 }}>{fmt(result.meter.coinIn)}</span></div>
                  <div style={kvRow}><span style={{ fontSize: 12, color: '#94a3b8' }}>Coin Out</span><span style={{ fontSize: 13, fontWeight: 700, color: '#7dd3fc' }}>{fmt(result.meter.coinOut)}</span></div>
                  <div style={kvRow}><span style={{ fontSize: 12, color: '#94a3b8' }}>Jackpot Wins</span><span style={{ fontSize: 13, fontWeight: 700 }}>{fmt(result.meter.jackpotWins)}</span></div>
                  <div style={kvRow}><span style={{ fontSize: 12, color: '#94a3b8' }}>WIN / LOSE</span><span style={{ fontSize: 13, fontWeight: 700, color: result.meter.winLoss < 0 ? '#f87171' : '#e2e8f0' }}>{fmt(result.meter.winLoss)}</span></div>
                  <div style={{ ...kvRow, borderBottom: 'none' }}><span style={{ fontSize: 12, color: '#94a3b8' }}>RTP</span><span style={{ fontSize: 13, fontWeight: 700, color: result.meter.rtp < 0 ? '#f87171' : '#e2e8f0' }}>{fmt(result.meter.rtp)}%</span></div>
                  <div style={kvRow}><span style={{ fontSize: 12, color: '#94a3b8' }}>Games Played</span><span style={{ fontSize: 13, fontWeight: 700 }}>{fmt(result.meter.gamesPlayed, 0)}</span></div>
                </>
              ) : <p style={{ fontSize: 12, color: '#64748b' }}>查無資料</p>}
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#a78bfa' }} />
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800 }}>Game Record 加總</h3>
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: -6 }}>gameRecordList · {result.date} 整日 · {result.gameRecord.recordCount} 筆</div>
              <div style={kvRow}><span style={{ fontSize: 12, color: '#94a3b8' }}>總 Bet</span><span style={{ fontSize: 13, fontWeight: 700 }}>{fmt(result.gameRecord.totalBet)}</span></div>
              <div style={{ ...kvRow, borderBottom: 'none' }}><span style={{ fontSize: 12, color: '#94a3b8' }}>總 Win</span><span style={{ fontSize: 13, fontWeight: 700, color: '#7dd3fc' }}>{fmt(result.gameRecord.totalWin)}</span></div>
              <div style={kvRow}><span style={{ fontSize: 12, color: '#94a3b8' }}>記錄筆數</span><span style={{ fontSize: 13, fontWeight: 700 }}>{result.gameRecord.recordCount}</span></div>
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fbbf24' }} />
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800 }}>Jackpot Abnormality（Attendant Paid JP）</h3>
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: -6 }}>getHandPayRecord · {result.date} 整日 · {result.jackpotAbnormality.count} 筆</div>
              {result.jackpotAbnormality.records.length === 0
                ? <p style={{ fontSize: 12, color: '#64748b' }}>當日無 Handpay 記錄</p>
                : result.jackpotAbnormality.records.slice(0, 5).map((it, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, padding: '6px 8px', border: '1px solid #23344d', borderRadius: 6, background: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                    <span>{it.payoutTime?.slice(11, 16) ?? '—'} · {it.username ?? '—'}</span>
                    <span style={{ color: '#fbbf24', fontWeight: 700 }}>{fmt(it.handpay)}</span>
                  </div>
                ))
              }
              {result.jackpotAbnormality.records.length > 5 && (
                <div style={{ fontSize: 11, color: '#64748b' }}>...還有 {result.jackpotAbnormality.records.length - 5} 筆</div>
              )}
              <div style={{ ...kvRow, marginTop: 4, borderBottom: 'none' }}><span style={{ fontSize: 12, color: '#94a3b8' }}>Attendant Paid JP 小計</span><span style={{ fontSize: 13, fontWeight: 700, color: '#7dd3fc' }}>{fmt(result.attendantPaidJp)}</span></div>
            </div>
          </div>

          {/* Raw field debug */}
          <details style={{ background: '#162338', border: '1px solid #23344d', borderRadius: 10, padding: '2px 16px', marginBottom: 16 }}>
            <summary style={{ cursor: 'pointer', padding: '10px 0', fontSize: 12, color: '#94a3b8', fontWeight: 700 }}>原始欄位對照表（除錯用，已驗證欄位標色）</summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, paddingBottom: 14 }}>
              {result.rawMeterRow && Object.entries(result.rawMeterRow)
                .filter(([k]) => !['0', '1', 'useLastData', 'debug'].includes(k))
                .map(([k, v]) => {
                  const known = KNOWN_FIELDS.find(f => f.key === k)
                  return (
                    <div key={k} style={{ background: '#0f172a', border: `1px solid ${known ? 'rgba(34,197,94,.3)' : '#23344d'}`, borderRadius: 6, padding: '6px 9px', fontSize: 11 }}>
                      <div style={{ color: known ? '#4ade80' : '#94a3b8' }}>
                        欄位 {k}{known ? ` · ${known.label}` : ''}{!known && <span style={{ color: '#64748b', fontSize: 9.5 }}> 語意未確認</span>}
                      </div>
                      <div style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{String(v)}</div>
                    </div>
                  )
                })}
            </div>
          </details>
        </>
      )}

      {/* Backend config */}
      <details open={configOpen} onToggle={e => setConfigOpen((e.target as HTMLDetailsElement).open)}
        style={{ background: '#111c30', border: '1px solid #23344d', borderRadius: 10, padding: '2px 16px' }}>
        <summary style={{ cursor: 'pointer', padding: '10px 0', fontSize: 12, color: '#94a3b8', fontWeight: 700 }}>⚙️ 後台設定（OSM / GCP 兩組後台連線資訊）</summary>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, paddingBottom: 16 }}>
          {(['osm', 'gcp'] as const).map(profile => {
            const cfg = profile === 'osm' ? osmConfig : gcpConfig
            const setCfg = profile === 'osm' ? setOsmConfig : setGcpConfig
            return (
              <div key={profile} style={{ display: 'flex', flexDirection: 'column', gap: 8, background: '#0f172a', border: '1px solid #23344d', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{profile === 'osm' ? 'OSM（CP）' : 'GCP（NC）'}</div>
                {([
                  ['base_url', 'Base URL', 'https://backendservertest.osmslot.org'],
                  ['origin', 'Origin', profile === 'osm' ? 'https://qat-cp.osmslot.org' : 'https://qat-nc.osmslot.org'],
                  ['channelId', 'Channel ID', profile === 'osm' ? '873' : '892'],
                  ['login_username', '登入帳號', ''],
                  ['login_password', '登入密碼（留空＝不變更）', ''],
                ] as const).map(([key, label, ph]) => (
                  <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <label style={{ fontSize: 11, color: '#94a3b8', minWidth: 160, textAlign: 'right' }}>{label}</label>
                    <input value={cfg[key]} onChange={e => setCfg(c => ({ ...c, [key]: e.target.value }))}
                      placeholder={ph} type={key === 'login_password' ? 'password' : 'text'}
                      style={{ flex: 1, ...inputStyle, padding: '5px 8px', fontSize: 12 }} />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                  <button onClick={() => saveConfig(profile)} disabled={savingCfg === profile}
                    style={{ padding: '5px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    {savingCfg === profile ? '儲存中…' : '儲存設定'}
                  </button>
                  <button onClick={() => testConfig(profile)} disabled={testingCfg === profile}
                    style={{ padding: '5px 14px', background: '#0f172a', color: '#93c5fd', border: '1px solid #2563eb', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    {testingCfg === profile ? '測試中…' : '測試登入'}
                  </button>
                  {cfgMsg?.profile === profile && (
                    <span style={{ fontSize: 12, color: cfgMsg.ok ? '#4ade80' : '#f87171' }}>{cfgMsg.text}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </details>
    </div>
  )
}

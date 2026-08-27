import { useState, useEffect } from 'react'

interface EgmDayCountField {
  key: string
  label: string
  egmDayCount: number
  userDetail: number
  delta: number
  pass: boolean
}
interface EgmDayCountRow {
  playerId?: string; playerName?: string; clientMachineName?: string
  win?: string; betTimes?: string; bet?: string
  machineIn?: string; machineOut?: string; playerWin?: string
}
interface BettingUser {
  playerId: string; playerName: string; betNumber: number; betAmount: number; machineCount: number
}
interface EgmDayCountResult {
  ok: boolean
  date: string
  dayBoundary: 'gaming' | 'calendar'
  allChannels: boolean
  gameType: string
  allPass: boolean
  comparison: EgmDayCountField[]
  egmDayCount: { betUsers: number; betNumber: number; betAmount: number; transferIn: number; transferOut: number; winOrLose: number; winLoseRatio: number; jackpotAmount: number }
  userDetail: { betUsers: number; betNumber: number; betAmount: number; transferIn: number; transferOut: number; winOrLose: number; winLoseRatio: number; jackpotAmount: number; recordCount: number }
  udTruncated: boolean
  udItems: EgmDayCountRow[]
  bettingUsers: BettingUser[]
  message?: string
}

function fmt(n: number | undefined | null, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

interface GameTypeOption { name: string; gameTag: string; id: number }

export function EgmDayCountPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [dayBoundary, setDayBoundary] = useState<'gaming' | 'calendar'>('gaming')
  const [allChannels, setAllChannels] = useState(false)
  const [gameType, setGameType] = useState('')
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<EgmDayCountResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/osm/meter-reconcile/game-types')
      .then(r => r.json())
      .then(d => { if (d.ok) setGameTypes(d.gameTypes ?? []) })
      .catch(() => {})
  }, [])

  async function handleQuery() {
    setLoading(true); setError(''); setResult(null)
    try {
      const res = await fetch('/api/osm/meter-reconcile/egm-daycount', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, dayBoundary, allChannels, gameType }),
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
    background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0',
    padding: '8px 10px', fontSize: 13,
  }
  const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 5, display: 'block' }

  return (
    <div style={{ width: '100%' }}>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', background: '#10182a', border: '1px solid #2d3f55', borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div>
          <label style={labelStyle}>日期</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>查詢範圍</label>
          <div style={{ display: 'flex', border: '1px solid #2d3f55', borderRadius: 7, overflow: 'hidden' }}>
            {([
              { key: 'gaming' as const, label: 'Gaming Day（06:00~隔天06:00）' },
              { key: 'calendar' as const, label: '自然日（00:00~24:00）' },
            ]).map(o => (
              <button key={o.key} onClick={() => setDayBoundary(o.key)}
                style={{ padding: '8px 14px', fontSize: 12.5, fontWeight: 700, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                  background: dayBoundary === o.key ? '#2563eb' : '#0f172a', color: dayBoundary === o.key ? '#fff' : '#94a3b8' }}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle}>Game Type</label>
          <select value={gameType} onChange={e => setGameType(e.target.value)} style={{ ...inputStyle, minWidth: 160 }}>
            <option value="">All Game</option>
            {gameTypes.map(g => (
              <option key={g.id} value={g.name}>{g.gameTag}</option>
            ))}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#94a3b8', cursor: 'pointer', paddingBottom: 8 }}>
          <input type="checkbox" checked={allChannels} onChange={e => setAllChannels(e.target.checked)} />
          All（含全部渠道，不受 Player Channel「np +11」篩選限制）
        </label>
        <button onClick={handleQuery} disabled={loading}
          style={{ marginLeft: 'auto', padding: '9px 22px', background: loading ? '#475569' : '#2563eb', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: loading ? 'default' : 'pointer' }}>
          {loading ? '查詢中…' : '查詢對帳'}
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.35)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#f87171', fontSize: 13 }}>
          {error}
        </div>
      )}

      {result && (<>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRadius: 10, marginBottom: 16,
          border: `1px solid ${result.allPass ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'}`,
          background: result.allPass ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
        }}>
          <div style={{ fontSize: 28 }}>{result.allPass ? '通過' : '失敗'}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: result.allPass ? '#4ade80' : '#f87171' }}>
              {result.allPass ? '一致 — 全部欄位吻合' : `不一致 — ${result.comparison.filter(c => !c.pass).length} 個欄位有落差`}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
              {result.date} · {result.dayBoundary === 'gaming' ? 'Gaming Day 06:00~隔天06:00' : '自然日 00:00~24:00'} · {result.allChannels ? 'All 渠道' : 'Player Channel: np +11'}{result.gameType ? ` · Game Type: ${result.gameType}` : ''}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right', fontSize: 12, color: '#94a3b8' }}>
            <b style={{ fontSize: 16, color: '#e2e8f0', display: 'block' }}>{result.comparison.filter(c => c.pass).length} / {result.comparison.length}</b>
            致
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', marginBottom: 8 }}>
          <thead>
            <tr>
              <th style={{ width: 40 }}></th>
              <th style={{ textAlign: 'left', padding: '9px 12px', background: '#162032', color: '#94a3b8', fontSize: 11, borderBottom: '1px solid #2d3f55' }}>欄位</th>
              <th style={{ textAlign: 'right', padding: '9px 12px', background: '#162032', color: '#94a3b8', fontSize: 11, borderBottom: '1px solid #2d3f55' }}>Egm DayCount</th>
              <th style={{ textAlign: 'right', padding: '9px 12px', background: '#162032', color: '#94a3b8', fontSize: 11, borderBottom: '1px solid #2d3f55' }}>User Detail 回推</th>
              <th style={{ textAlign: 'right', padding: '9px 12px', background: '#162032', color: '#94a3b8', fontSize: 11, borderBottom: '1px solid #2d3f55' }}>差值</th>
            </tr>
          </thead>
          <tbody>
            {result.comparison.map(c => (
              <tr key={c.key} style={{ background: c.pass ? 'transparent' : 'rgba(239,68,68,.06)' }}>
                <td style={{ textAlign: 'center', padding: '9px 12px', borderBottom: '1px solid #1e293b' }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999,
                    background: c.pass ? 'rgba(74,222,128,.15)' : 'rgba(239,68,68,.15)', color: c.pass ? '#4ade80' : '#f87171' }}>
                    {c.pass ? '通過' : '失敗'}
                  </span>
                </td>
                <td style={{ padding: '9px 12px', color: '#94a3b8', borderBottom: '1px solid #1e293b' }}>{c.label}</td>
                <td style={{ textAlign: 'right', padding: '9px 12px', borderBottom: '1px solid #1e293b' }}>{fmt(c.egmDayCount, c.key === 'winLoseRatio' ? 2 : 0)}{c.key === 'winLoseRatio' ? '%' : ''}</td>
                <td style={{ textAlign: 'right', padding: '9px 12px', borderBottom: '1px solid #1e293b' }}>{fmt(c.userDetail, c.key === 'winLoseRatio' ? 2 : 0)}{c.key === 'winLoseRatio' ? '%' : ''}</td>
                <td style={{ textAlign: 'right', padding: '9px 12px', borderBottom: '1px solid #1e293b', color: c.pass ? '#64748b' : '#f87171' }}>{fmt(c.delta, c.key === 'winLoseRatio' ? 2 : 0)}{c.key === 'winLoseRatio' ? '%' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 16px' }}>
          Jackpot Amount 對照的是 Jackpot Record 報表（jackpotRecordList）逐筆中獎紀錄加總，不是 User Detail。
          Total Bet User 是從 User Detail 逐筆列裡「Bet Number &gt; 0」的不重複 UserId 數出來的（不是 API 直接提供的欄位）。
          兩張報表若非同一時刻查詢，短時間內若有機台持續在跑（例如 AutoSpin），數字可能會有些微落差，不代表算錯。
        </p>

        <div style={{ background: '#10182a', border: '1px solid #2d3f55', borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 8 }}>
            有下注的帳號（{result.bettingUsers.length} 個，跨機台已彙整，不重複）
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr style={{ color: '#64748b' }}>
                <th style={{ textAlign: 'left', padding: '5px 8px' }}>UserId</th>
                <th style={{ textAlign: 'left', padding: '5px 8px' }}>Account</th>
                <th style={{ textAlign: 'right', padding: '5px 8px' }}>玩過幾台機台</th>
                <th style={{ textAlign: 'right', padding: '5px 8px' }}>Bet Number 合計</th>
                <th style={{ textAlign: 'right', padding: '5px 8px' }}>Bet 合計</th>
              </tr>
            </thead>
            <tbody>
              {result.bettingUsers.map(u => (
                <tr key={u.playerId} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '5px 8px' }}>{u.playerId}</td>
                  <td style={{ padding: '5px 8px' }}>{u.playerName}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px' }}>{u.machineCount}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px' }}>{u.betNumber}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px' }}>{fmt(u.betAmount, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <details style={{ background: '#10182a', border: '1px solid #2d3f55', borderRadius: 10, padding: '2px 16px' }}>
          <summary style={{ cursor: 'pointer', padding: '10px 0', fontSize: 12, color: '#94a3b8', fontWeight: 700 }}>
            ▸ User Detail 逐筆明細（{result.userDetail.recordCount} 筆{result.udTruncated ? '，警 超過單次查詢上限，以下可能不完整' : ''}）
          </summary>
          <div style={{ overflowX: 'auto', paddingBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr style={{ color: '#64748b' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>UserId</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Machine Name</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>Bet Number</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>Bet</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>Transfer In</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>Transfer Out</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>計入 Bet User？</th>
                </tr>
              </thead>
              <tbody>
                {result.udItems.map((r, i) => {
                  const betNum = parseFloat(r.betTimes || '0')
                  const counted = betNum > 0
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid #1e293b', opacity: counted ? 1 : 0.55 }}>
                      <td style={{ padding: '6px 8px' }}>{r.playerId}</td>
                      <td style={{ padding: '6px 8px' }}>{r.clientMachineName}</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px', textDecoration: counted ? 'none' : 'line-through' }}>{r.betTimes}</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px' }}>{fmt(parseFloat(r.bet || '0'), 0)}</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px' }}>{fmt(parseFloat(r.machineIn || '0'), 0)}</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px' }}>{fmt(parseFloat(r.machineOut || '0'), 0)}</td>
                      <td style={{ padding: '6px 8px', color: counted ? '#4ade80' : '#64748b' }}>{counted ? '是' : '否'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      </>)}
    </div>
  )
}

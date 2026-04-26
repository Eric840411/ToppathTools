import { useEffect, useRef, useState } from 'react'

interface StatRow { type: string; count: number; pct: number }

interface StatsStatus {
  status: 'idle' | 'running' | 'stopped' | 'error'
  rounds: number
  distribution: Record<string, number>
  error?: string
}

export function GsStatsPage() {
  const [url, setUrl] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [statsStatus, setStatsStatus] = useState<StatsStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const handleStart = async () => {
    if (!url.trim()) return
    setLoading(true); setError(''); setSessionId(null); setStatsStatus(null)
    try {
      const r = await fetch('/api/gs/stats/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const d = await r.json() as { ok: boolean; sessionId?: string; message?: string }
      if (!d.ok || !d.sessionId) throw new Error(d.message ?? '啟動失敗')
      setSessionId(d.sessionId)
      pollRef.current = setInterval(async () => {
        const sr = await fetch(`/api/gs/stats/status/${d.sessionId}`)
        const sd = await sr.json() as StatsStatus
        setStatsStatus(sd)
        if (sd.status === 'stopped' || sd.status === 'error') {
          clearInterval(pollRef.current!); pollRef.current = null; setLoading(false)
        }
      }, 2000)
    } catch (e) {
      setError(String(e)); setLoading(false)
    }
  }

  const handleStop = async () => {
    if (!sessionId) return
    await fetch(`/api/gs/stats/stop/${sessionId}`, { method: 'POST' }).catch(() => {})
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    setLoading(false)
    setStatsStatus(prev => prev ? { ...prev, status: 'stopped' } : null)
  }

  const rows: StatRow[] = statsStatus?.distribution
    ? Object.entries(statsStatus.distribution)
        .map(([type, count]) => ({
          type,
          count,
          pct: statsStatus.rounds > 0 ? (count / statsStatus.rounds) * 100 : 0,
        }))
        .sort((a, b) => b.count - a.count)
    : []

  const handleExportCsv = () => {
    if (!rows.length) return
    const csv = [['骰型', '出現次數', '實際%'], ...rows.map(r => [r.type, r.count, r.pct.toFixed(2) + '%'])]
      .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'stats.csv'; a.click()
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div className="section-card" style={{ marginBottom: 16 }}>
        <h2 className="section-title">🎲 500x 機率統計</h2>
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 12, lineHeight: 1.6 }}>
          以 Playwright 開啟遊戲頁面，即時攔截 WebSocket 訊息，統計各骰型機率分布。
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={url} onChange={e => setUrl(e.target.value)}
            placeholder="輸入 Bonus V2 遊戲 URL..."
            style={{ flex: 1, minWidth: 280, padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 14 }}
            disabled={loading}
          />
          {!loading ? (
            <button type="button" onClick={handleStart} disabled={!url.trim()}
              style={{ padding: '9px 24px', borderRadius: 8, background: !url.trim() ? '#a5b4fc' : '#6366f1', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: !url.trim() ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
              🚀 開始攔截
            </button>
          ) : (
            <button type="button" onClick={handleStop}
              style={{ padding: '9px 24px', borderRadius: 8, background: '#dc2626', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              ⏹ 停止
            </button>
          )}
        </div>
        {error && <div className="alert-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {statsStatus && (
        <div className="section-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13 }}>
              狀態：<span style={{ fontWeight: 700, color: statsStatus.status === 'running' ? '#6366f1' : '#16a34a' }}>
                {statsStatus.status === 'running' ? '⏳ 擷取中' : '✅ 已停止'}
              </span>
            </div>
            <div style={{ fontSize: 13 }}>總回合：<b>{statsStatus.rounds.toLocaleString()}</b></div>
            <div style={{ fontSize: 13 }}>骰型種類：<b>{rows.length}</b></div>
            {rows.length > 0 && (
              <button type="button" onClick={handleExportCsv}
                style={{ marginLeft: 'auto', padding: '6px 16px', borderRadius: 6, background: '#0f172a', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                ⬇ CSV
              </button>
            )}
          </div>
          {statsStatus.error && <div className="alert-error" style={{ marginTop: 10, fontSize: 12 }}>{statsStatus.error}</div>}
        </div>
      )}

      {rows.length > 0 ? (
        <div className="section-card">
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr><th>#</th><th>骰型</th><th>出現次數</th><th>實際%</th><th>分布</th></tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const color = row.pct > 20 ? '#dc2626' : row.pct > 10 ? '#d97706' : '#6366f1'
                  return (
                    <tr key={row.type}>
                      <td style={{ color: '#94a3b8', fontSize: 12 }}>{i + 1}</td>
                      <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{row.type}</td>
                      <td>{row.count.toLocaleString()}</td>
                      <td style={{ fontWeight: 600, color }}>{row.pct.toFixed(2)}%</td>
                      <td style={{ width: 160, minWidth: 120 }}>
                        <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(row.pct * 3, 100)}%`, background: color, borderRadius: 4, transition: 'width 0.3s' }} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : statsStatus?.status === 'running' ? (
        <div className="section-card" style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 14 }}>
          ⏳ 等待遊戲 WebSocket 資料...
        </div>
      ) : null}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

interface StatRow { type: string; count: number; pct: number }

interface BonusDistribution {
  single_m2: Record<string, number>
  single_m3: Record<string, number>
  any_double: Record<string, number>
  any_triple: Record<string, number>
}

interface StatsStatus {
  status: 'idle' | 'running' | 'stopped' | 'error'
  rounds: number
  distribution: Record<string, number>
  mode?: 'generic' | 'bonus-v2'
  bonusRounds?: number
  bonusDistribution?: BonusDistribution
  error?: string
}

const COLOR_EMOJI: Record<string, string> = { '黃': '🟡', '白': '⚪', '粉': '🩷', '藍': '🔵', '紅': '🔴', '綠': '🟢' }

export function GsStatsPage() {
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<'generic' | 'bonus-v2'>('generic')
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
        body: JSON.stringify({ url: url.trim(), mode }),
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

  const handleExportBonusCsv = () => {
    const bd = statsStatus?.bonusDistribution
    if (!bd) return
    const allColors = ['黃', '白', '粉', '藍', '紅', '綠']
    const rows2: string[][] = [['類型', '顏色', '出現次數', '比率%']]
    const total = statsStatus?.bonusRounds ?? 0
    const pushRows = (label: string, dist: Record<string, number>) => {
      for (const color of allColors) {
        const count = dist[color] ?? 0
        rows2.push([label, color, String(count), total > 0 ? (count / total * 100).toFixed(2) + '%' : '0%'])
      }
    }
    pushRows('Single 2同', bd.single_m2)
    pushRows('Single 3同', bd.single_m3)
    const dbl = Object.values(bd.any_double).reduce((a, b) => a + b, 0)
    const trp = Object.values(bd.any_triple).reduce((a, b) => a + b, 0)
    rows2.push(['任意2同', '-', String(dbl), total > 0 ? (dbl / total * 100).toFixed(2) + '%' : '0%'])
    rows2.push(['任意3同', '-', String(trp), total > 0 ? (trp / total * 100).toFixed(2) + '%' : '0%'])
    const csv = rows2.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bonus-v2-stats.csv'; a.click()
  }

  const isBonus = statsStatus?.mode === 'bonus-v2'

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div className="section-card" style={{ marginBottom: 16 }}>
        <h2 className="section-title">🎲 500x 機率統計</h2>
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 12, lineHeight: 1.6 }}>
          以 Playwright 開啟遊戲頁面，即時攔截 WebSocket 訊息，統計各骰型機率分布。
        </div>

        {/* 模式選擇 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {(['generic', 'bonus-v2'] as const).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)} disabled={loading}
              style={{ padding: '6px 16px', borderRadius: 6, border: '1.5px solid', fontSize: 13, fontWeight: 600, cursor: loading ? 'default' : 'pointer',
                borderColor: mode === m ? '#6366f1' : '#e2e8f0',
                background: mode === m ? '#ede9fe' : '#f8fafc',
                color: mode === m ? '#4f46e5' : '#475569' }}>
              {m === 'generic' ? '通用 WS' : '🎰 ColorGame V2 電子骰'}
            </button>
          ))}
        </div>
        {mode === 'bonus-v2' && (
          <div style={{ fontSize: 12, color: '#6366f1', background: '#ede9fe', padding: '6px 12px', borderRadius: 6, marginBottom: 10 }}>
            解析 <code>prepareBonusResult</code> 事件，統計 d.v[10][143] 電子骰配置（Single 2同/3同、任意2同/3同）
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={url} onChange={e => setUrl(e.target.value)}
            placeholder={mode === 'bonus-v2' ? '輸入 ColorGame V2 遊戲 URL...' : '輸入遊戲 URL...'}
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
            <div style={{ fontSize: 13 }}>
              {isBonus ? '電子骰局數' : '總回合'}：<b>{statsStatus.rounds.toLocaleString()}</b>
            </div>
            {!isBonus && <div style={{ fontSize: 13 }}>骰型種類：<b>{rows.length}</b></div>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {rows.length > 0 && (
                <button type="button" onClick={handleExportCsv}
                  style={{ padding: '6px 16px', borderRadius: 6, background: '#0f172a', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  ⬇ CSV
                </button>
              )}
              {isBonus && statsStatus.bonusDistribution && (
                <button type="button" onClick={handleExportBonusCsv}
                  style={{ padding: '6px 16px', borderRadius: 6, background: '#7c3aed', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  ⬇ 電子骰 CSV
                </button>
              )}
            </div>
          </div>
          {statsStatus.error && <div className="alert-error" style={{ marginTop: 10, fontSize: 12 }}>{statsStatus.error}</div>}
        </div>
      )}

      {/* ColorGame V2 電子骰專用統計表 */}
      {isBonus && statsStatus?.bonusDistribution && statsStatus.rounds > 0 && (
        <div className="section-card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 12 }}>🎰 電子骰配置統計</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Single 2同 / 3同 */}
            {(['single_m2', 'single_m3'] as const).map(key => {
              const label = key === 'single_m2' ? 'Single 2同' : 'Single 3同'
              const dist = statsStatus.bonusDistribution![key]
              const allColors = ['黃', '白', '粉', '藍', '紅', '綠']
              return (
                <div key={key} style={{ background: '#f8fafc', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#374151' }}>{label}</div>
                  {allColors.map(color => {
                    const count = dist[color] ?? 0
                    const pct = statsStatus.rounds > 0 ? count / statsStatus.rounds * 100 : 0
                    return (
                      <div key={color} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ width: 40, fontSize: 12 }}>{COLOR_EMOJI[color] ?? ''} {color}</span>
                        <div style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(pct * 5, 100)}%`, background: '#6366f1', borderRadius: 3 }} />
                        </div>
                        <span style={{ fontSize: 11, color: '#64748b', width: 60, textAlign: 'right' }}>{count} ({pct.toFixed(1)}%)</span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {/* 任意2同 / 任意3同 */}
            {(['any_double', 'any_triple'] as const).map(key => {
              const label = key === 'any_double' ? '任意2同 (k807)' : '任意3同 (k808)'
              const dist = statsStatus.bonusDistribution![key]
              const total = Object.values(dist).reduce((a, b) => a + b, 0)
              const pct = statsStatus.rounds > 0 ? total / statsStatus.rounds * 100 : 0
              return (
                <div key={key} style={{ background: '#f8fafc', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#374151' }}>{label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#6366f1' }}>{total.toLocaleString()}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>佔所有局數 {pct.toFixed(2)}%</div>
                  <div style={{ marginTop: 8 }}>
                    {Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([color, count]) => (
                      <span key={color} style={{ display: 'inline-block', marginRight: 6, marginBottom: 4, padding: '2px 8px', background: '#ede9fe', borderRadius: 10, fontSize: 11, color: '#4f46e5' }}>
                        {COLOR_EMOJI[color] ?? ''} {color}: {count}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 通用分布表 */}
      {rows.length > 0 ? (
        <div className="section-card">
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 10 }}>
            {isBonus ? '骨牌類型分布' : '骰型分布'}
          </h3>
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr><th>#</th><th>{isBonus ? '類型' : '骰型'}</th><th>出現次數</th><th>實際%</th><th>分布</th></tr>
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
          {isBonus ? '⏳ 等待 prepareBonusResult 事件...' : '⏳ 等待遊戲 WebSocket 資料...'}
        </div>
      ) : null}
    </div>
  )
}

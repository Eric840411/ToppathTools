import { useEffect, useRef, useState } from 'react'

interface CaptureStatus { done: boolean; count: number; queued?: boolean; queueSize?: number; error?: string }
interface CapturedImage { idx: number; url: string; filename: string; size: number; status: number }
interface PairedResult {
  a: CapturedImage | null
  b: CapturedImage | null
  similarity?: number
}

type Tab = 'overview' | 'visual'
type VisualFilter = 'all' | 'diff' | 'only-a' | 'only-b'

function sizeDiffPct(a: CapturedImage, b: CapturedImage): number | null {
  if (!a.size || !b.size) return null
  return ((b.size - a.size) / a.size) * 100
}

function imgSrc(sessionId: string, side: 'a' | 'b', idx: number) {
  return `/api/gs/img-compare/img/${sessionId}/${side}/${idx}`
}

function Thumb({ src, alt }: { src: string; alt: string }) {
  const [err, setErr] = useState(false)
  if (err) return <div style={{ width: 52, height: 40, background: '#f1f5f9', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#94a3b8' }}>無圖</div>
  return <img src={src} alt={alt} onError={() => setErr(true)} style={{ width: 52, height: 40, objectFit: 'contain', borderRadius: 4, background: '#f8fafc', border: '1px solid #e2e8f0', display: 'block' }} />
}

export function GsImgComparePage() {
  const [urlA, setUrlA] = useState('')
  const [urlB, setUrlB] = useState('')
  const [mode, setMode] = useState<'standard' | 'polling'>('standard')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [statusA, setStatusA] = useState<CaptureStatus | null>(null)
  const [statusB, setStatusB] = useState<CaptureStatus | null>(null)
  const [pairs, setPairs] = useState<PairedResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [visualFilter, setVisualFilter] = useState<VisualFilter>('all')
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // close lightbox on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxIdx(null)
      if (e.key === 'ArrowLeft' && lightboxIdx !== null) setLightboxIdx(i => i !== null && i > 0 ? i - 1 : i)
      if (e.key === 'ArrowRight' && lightboxIdx !== null) setLightboxIdx(i => i !== null && i < pairs.length - 1 ? i + 1 : i)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxIdx, pairs.length])

  const handleStart = async () => {
    if (!urlA.trim() || !urlB.trim()) return
    setLoading(true); setError(''); setSessionId(null); setPairs([]); setStatusA(null); setStatusB(null)
    try {
      const r = await fetch('/api/gs/img-compare/session', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urlA: urlA.trim(), urlB: urlB.trim(), mode }) })
      const d = await r.json() as { ok: boolean; sessionId?: string; message?: string }
      if (!d.ok || !d.sessionId) throw new Error(d.message ?? '啟動失敗')
      setSessionId(d.sessionId)
      pollRef.current = setInterval(async () => {
        const sr = await fetch(`/api/gs/img-compare/status/${d.sessionId}`)
        const sd = await sr.json() as { ok: boolean; a?: CaptureStatus; b?: CaptureStatus; pairs?: PairedResult[] }
        if (!sd.ok) return
        if (sd.a) setStatusA(sd.a)
        if (sd.b) setStatusB(sd.b)
        if (sd.pairs) setPairs(sd.pairs)
        if (sd.a?.done && sd.b?.done) {
          clearInterval(pollRef.current!); pollRef.current = null; setLoading(false)
        }
      }, 2000)
    } catch (e) {
      setError(String(e)); setLoading(false)
    }
  }

  const handleExportCsv = () => {
    const headers = ['#', '圖片名稱', 'A狀態', 'B狀態', 'A大小(KB)', 'B大小(KB)', '大小差異%']
    const rows = pairs.map((p, i) => {
      const pct = p.a && p.b ? sizeDiffPct(p.a, p.b) : null
      return [
        i + 1,
        p.a?.filename ?? p.b?.filename ?? '',
        p.a ? '✓' : '—',
        p.b ? '✓' : '—',
        p.a ? (p.a.size / 1024).toFixed(1) : '—',
        p.b ? (p.b.size / 1024).toFixed(1) : '—',
        pct !== null ? pct.toFixed(1) + '%' : '—',
      ]
    })
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'img-compare.csv'; a.click()
  }

  const totalPairs = pairs.length
  const matchedPairs = pairs.filter(p => p.a && p.b).length
  const onlyA = pairs.filter(p => p.a && !p.b).length
  const onlyB = pairs.filter(p => !p.a && p.b).length
  const sizeDiffCount = pairs.filter(p => {
    if (!p.a || !p.b) return false
    const pct = sizeDiffPct(p.a, p.b)
    return pct !== null && Math.abs(pct) > 1
  }).length

  const filteredVisual = pairs.filter(p => {
    if (visualFilter === 'only-a') return p.a && !p.b
    if (visualFilter === 'only-b') return !p.a && p.b
    if (visualFilter === 'diff') {
      if (!p.a || !p.b) return false
      const pct = sizeDiffPct(p.a, p.b)
      return pct !== null && Math.abs(pct) > 1
    }
    return true
  })

  const lbPair = lightboxIdx !== null ? pairs[lightboxIdx] : null

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {/* ── Input ── */}
      <div className="section-card" style={{ marginBottom: 16 }}>
        <h2 className="section-title">⚖️ 圖片比對</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <label className="field">
            <span>URL A（新版 / 待測）</span>
            <input value={urlA} onChange={e => setUrlA(e.target.value)} placeholder="https://..." disabled={loading} />
          </label>
          <label className="field">
            <span>URL B（舊版 / 參考）</span>
            <input value={urlB} onChange={e => setUrlB(e.target.value)} placeholder="https://..." disabled={loading} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" checked={mode === 'standard'} onChange={() => setMode('standard')} disabled={loading} />
            標準模式（靜態頁面，約 30 秒）
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" checked={mode === 'polling'} onChange={() => setMode('polling')} disabled={loading} />
            輪詢模式（動態/懶載入，約 90 秒）
          </label>
          <button type="button" onClick={handleStart} disabled={loading || !urlA.trim() || !urlB.trim()}
            style={{ marginLeft: 'auto', padding: '9px 24px', borderRadius: 8, background: loading ? '#a5b4fc' : '#6366f1', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: loading ? 'default' : 'pointer' }}>
            {loading ? '⏳ 擷取中...' : '🚀 開始比對'}
          </button>
        </div>
        {error && <div className="alert-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {/* ── Progress ── */}
      {(statusA || statusB) && (
        <div className="section-card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>擷取進度</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[{ label: 'URL A', s: statusA }, { label: 'URL B', s: statusB }].map(({ label, s }) => (
              <div key={label} style={{ padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>{label}</div>
                {s ? (
                  <div style={{ fontSize: 13, color: s.done ? '#16a34a' : s.queued ? '#d97706' : '#6366f1' }}>
                    {s.done
                      ? `✅ 完成，共 ${s.count} 張圖片`
                      : s.queued
                        ? `⌛ 排隊中${s.queueSize ? `（前方 ${s.queueSize} 個任務）` : ''}...`
                        : `⏳ 已攔截 ${s.count} 張...`}
                    {s.error && <span style={{ color: '#dc2626', marginLeft: 8 }}>{s.error}</span>}
                  </div>
                ) : <div style={{ fontSize: 13, color: '#94a3b8' }}>等待中...</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {pairs.length > 0 && !loading && (
        <div className="section-card">
          {/* Tab bar + stats */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['overview', 'visual'] as Tab[]).map(t => (
                <button key={t} type="button" onClick={() => setActiveTab(t)}
                  style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13, fontWeight: activeTab === t ? 700 : 400, background: activeTab === t ? '#0f172a' : '#fff', color: activeTab === t ? '#fff' : '#374151', cursor: 'pointer' }}>
                  {t === 'overview' ? '總覽' : '視覺比對'}
                </button>
              ))}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, fontSize: 13, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>共 <b>{totalPairs}</b> 對</span>
              <span style={{ color: '#16a34a' }}>配對 <b>{matchedPairs}</b></span>
              <span style={{ color: '#d97706' }}>僅 A <b>{onlyA}</b></span>
              <span style={{ color: '#6366f1' }}>僅 B <b>{onlyB}</b></span>
              <span style={{ color: '#dc2626' }}>大小差異 <b>{sizeDiffCount}</b></span>
              <button type="button" onClick={handleExportCsv}
                style={{ padding: '5px 14px', borderRadius: 6, background: '#0f172a', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                ⬇ CSV
              </button>
            </div>
          </div>

          {/* ── Overview Tab ── */}
          {activeTab === 'overview' && (
            <div className="table-wrap">
              <table className="version-table">
                <thead>
                  <tr>
                    <th>A 預覽</th>
                    <th>B 預覽</th>
                    <th>圖片名稱</th>
                    <th>A 大小</th>
                    <th>B 大小</th>
                    <th>大小差異</th>
                    <th>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((p, i) => {
                    const pct = p.a && p.b ? sizeDiffPct(p.a, p.b) : null
                    const absPct = pct !== null ? Math.abs(pct) : null
                    const pctColor = absPct === null ? '#94a3b8' : absPct <= 1 ? '#16a34a' : absPct <= 10 ? '#d97706' : '#dc2626'
                    const statusLabel = !p.a ? '僅 B' : !p.b ? '僅 A' : absPct !== null && absPct > 1 ? '大小差異' : '✅ 相同'
                    const statusColor = !p.a || !p.b ? '#d97706' : absPct !== null && absPct > 1 ? '#dc2626' : '#16a34a'
                    return (
                      <tr key={i} style={{ cursor: 'pointer' }} onClick={() => { setActiveTab('visual'); setLightboxIdx(i) }}>
                        <td>
                          {p.a && sessionId
                            ? <Thumb src={imgSrc(sessionId, 'a', p.a.idx)} alt="A" />
                            : <span style={{ color: '#dc2626', fontSize: 18 }}>—</span>}
                        </td>
                        <td>
                          {p.b && sessionId
                            ? <Thumb src={imgSrc(sessionId, 'b', p.b.idx)} alt="B" />
                            : <span style={{ color: '#dc2626', fontSize: 18 }}>—</span>}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.a?.filename ?? p.b?.filename ?? `#${i}`}
                        </td>
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{p.a ? `${(p.a.size / 1024).toFixed(1)} KB` : '—'}</td>
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{p.b ? `${(p.b.size / 1024).toFixed(1)} KB` : '—'}</td>
                        <td style={{ color: pctColor, fontWeight: 600, fontSize: 12 }}>
                          {pct !== null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                        </td>
                        <td><span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{statusLabel}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>點擊任一列可在視覺比對中放大查看</div>
            </div>
          )}

          {/* ── Visual Tab ── */}
          {activeTab === 'visual' && sessionId && (
            <>
              {/* Filter bar */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                {([
                  { key: 'all', label: `全部 (${pairs.length})` },
                  { key: 'diff', label: `大小差異 (${sizeDiffCount})` },
                  { key: 'only-a', label: `僅 A (${onlyA})` },
                  { key: 'only-b', label: `僅 B (${onlyB})` },
                ] as { key: VisualFilter; label: string }[]).map(f => (
                  <button key={f.key} type="button" onClick={() => setVisualFilter(f.key)}
                    style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, fontWeight: visualFilter === f.key ? 700 : 400, background: visualFilter === f.key ? '#0f172a' : '#fff', color: visualFilter === f.key ? '#fff' : '#374151', cursor: 'pointer' }}>
                    {f.label}
                  </button>
                ))}
              </div>

              {filteredVisual.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>沒有符合條件的配對</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
                  {filteredVisual.slice(0, 60).map((p) => {
                    const realIdx = pairs.indexOf(p)
                    const pct = p.a && p.b ? sizeDiffPct(p.a, p.b) : null
                    const absPct = pct !== null ? Math.abs(pct) : null
                    const hasDiff = absPct !== null && absPct > 1
                    const borderColor = !p.a || !p.b ? '#fed7aa' : hasDiff ? '#fecaca' : '#bbf7d0'
                    const bgColor = !p.a || !p.b ? '#fff7ed' : hasDiff ? '#fef2f2' : '#f0fdf4'
                    return (
                      <div key={realIdx} style={{ border: `1px solid ${borderColor}`, borderRadius: 10, overflow: 'hidden', background: bgColor, cursor: 'pointer' }}
                        onClick={() => setLightboxIdx(realIdx)}>
                        {/* Header */}
                        <div style={{ padding: '7px 10px', fontSize: 11, fontFamily: 'monospace', borderBottom: `1px solid ${borderColor}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, color: '#374151' }}>{p.a?.filename ?? p.b?.filename ?? `#${realIdx}`}</span>
                          {pct !== null && <span style={{ fontWeight: 700, color: hasDiff ? '#dc2626' : '#16a34a', whiteSpace: 'nowrap' }}>{pct > 0 ? '+' : ''}{pct.toFixed(1)}%</span>}
                          {(!p.a || !p.b) && <span style={{ color: '#d97706', fontWeight: 700, fontSize: 10 }}>{!p.a ? '僅 B' : '僅 A'}</span>}
                        </div>
                        {/* Images side by side */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#e2e8f0' }}>
                          <div style={{ background: '#fff', padding: 6 }}>
                            <div style={{ fontSize: 10, color: '#6366f1', fontWeight: 700, marginBottom: 4 }}>A 版</div>
                            {p.a
                              ? <img src={imgSrc(sessionId, 'a', p.a.idx)} alt="A"
                                  style={{ width: '100%', display: 'block', maxHeight: 160, objectFit: 'contain', background: '#f8fafc' }} />
                              : <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', fontSize: 12 }}>— 無圖 —</div>}
                            {p.a && <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>{(p.a.size / 1024).toFixed(1)} KB</div>}
                          </div>
                          <div style={{ background: '#fff', padding: 6 }}>
                            <div style={{ fontSize: 10, color: '#8b5cf6', fontWeight: 700, marginBottom: 4 }}>B 版</div>
                            {p.b
                              ? <img src={imgSrc(sessionId, 'b', p.b.idx)} alt="B"
                                  style={{ width: '100%', display: 'block', maxHeight: 160, objectFit: 'contain', background: '#f8fafc' }} />
                              : <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', fontSize: 12 }}>— 無圖 —</div>}
                            {p.b && <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>{(p.b.size / 1024).toFixed(1)} KB</div>}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Lightbox ── */}
      {lbPair && lightboxIdx !== null && sessionId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => setLightboxIdx(null)}>
          <div style={{ background: '#fff', borderRadius: 12, overflow: 'hidden', maxWidth: 900, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}>
            {/* LB header */}
            <div style={{ padding: '10px 16px', background: '#0f172a', color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lbPair.a?.filename ?? lbPair.b?.filename ?? `#${lightboxIdx}`}
              </span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{lightboxIdx + 1} / {pairs.length}</span>
              <button type="button" onClick={() => setLightboxIdx(i => i !== null && i > 0 ? i - 1 : i)} style={{ background: '#334155', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: 4, cursor: 'pointer' }}>◀</button>
              <button type="button" onClick={() => setLightboxIdx(i => i !== null && i < pairs.length - 1 ? i + 1 : i)} style={{ background: '#334155', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: 4, cursor: 'pointer' }}>▶</button>
              <button type="button" onClick={() => setLightboxIdx(null)} style={{ background: '#dc2626', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: 4, cursor: 'pointer' }}>✕</button>
            </div>
            {/* LB body */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#e2e8f0', overflow: 'auto', flex: 1 }}>
              {(['a', 'b'] as const).map(side => {
                const img = lbPair[side]
                const label = side === 'a' ? 'A 版（新版/待測）' : 'B 版（舊版/參考）'
                const color = side === 'a' ? '#6366f1' : '#8b5cf6'
                return (
                  <div key={side} style={{ background: '#fff', padding: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 8 }}>{label}</div>
                    {img
                      ? <>
                          <img src={imgSrc(sessionId, side, img.idx)} alt={side.toUpperCase()}
                            style={{ width: '100%', maxHeight: '55vh', objectFit: 'contain', display: 'block', background: '#f8fafc', borderRadius: 6 }} />
                          <div style={{ marginTop: 10, fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>
                            <div>大小：<b>{(img.size / 1024).toFixed(1)} KB</b></div>
                            <div style={{ wordBreak: 'break-all', fontSize: 11, color: '#94a3b8' }}>{img.url}</div>
                          </div>
                        </>
                      : <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', fontSize: 14 }}>— 無此圖片 —</div>}
                  </div>
                )
              })}
            </div>
            {/* LB footer - size comparison */}
            {lbPair.a && lbPair.b && (
              <div style={{ padding: '10px 16px', background: '#f8fafc', borderTop: '1px solid #e2e8f0', fontSize: 13, display: 'flex', gap: 16, alignItems: 'center' }}>
                <span>A：<b>{(lbPair.a.size / 1024).toFixed(1)} KB</b></span>
                <span>B：<b>{(lbPair.b.size / 1024).toFixed(1)} KB</b></span>
                {(() => {
                  const pct = sizeDiffPct(lbPair.a, lbPair.b)
                  if (pct === null) return null
                  const color = Math.abs(pct) <= 1 ? '#16a34a' : Math.abs(pct) <= 10 ? '#d97706' : '#dc2626'
                  return <span>差異：<b style={{ color }}>{pct > 0 ? '+' : ''}{pct.toFixed(1)}%</b></span>
                })()}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

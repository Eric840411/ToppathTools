import { useEffect, useRef, useState } from 'react'
import {
  classifyLogLine, classifyPinusRoute, downloadExecutionLog, extractSpinNo, relativeShotTime,
  PINUS_CATEGORY_META, type AutospinConfig, type LogCategory, type PinusCategory,
} from './AutoSpinPage'
import { useAgentSession } from './useAgentSession'

interface SlsEntry { time: number; timeStr: string; project: string; logstore: string; content: string; level: string }

interface DeviceSessionPanelProps {
  sessionId: string
  agentId: string
  hostname: string
  startedAt: number
  userLabel: string
  isPrimary: boolean
  configs: AutospinConfig[]
  onSetLightbox: (src: string | null) => void
  /** 精簡卡片點擊時觸發（切換為主視角）；主視角卡片本身不需要這個 */
  onPromote?: () => void
}

/** 多裝置並行監控——一個 session 一個實例，各自獨立管理 SSE/日誌/截圖/LuckyLink 狀態
 *（透過 useAgentSession），identity 以 sessionId 為主。isPrimary=false 時渲染精簡卡片
 * （狀態＋機台摘要＋日誌尾巴＋異常提示，點擊可切換為主視角），isPrimary=true 時渲染完整
 * 三層版面（狀態列／機台清單+日誌／LuckyLink+SLS+截圖 tabs），對應 mockup 的情境 A/B。 */
export function DeviceSessionPanel({
  sessionId, agentId, hostname, startedAt, userLabel, isPrimary, configs, onSetLightbox, onPromote,
}: DeviceSessionPanelProps) {
  const { logs, screenshots, luckylinkStatus, paused, stopping, spinInterval, spinIntervalSaving, actionError, actions } =
    useAgentSession(sessionId, agentId, userLabel)

  const [sideTab, setSideTab] = useState<'ll' | 'sls' | 'shot'>('ll')
  const [logFilter, setLogFilter] = useState<'all' | 'sys' | 'spin' | 'shot' | 'error'>('all')
  const [logSearch, setLogSearch] = useState('')
  const [visiblePinusCats, setVisiblePinusCats] = useState<Set<PinusCategory>>(new Set())
  const [slsMachineNo, setSlsMachineNo] = useState('')
  const [slsEntries, setSlsEntries] = useState<SlsEntry[]>([])
  const [slsLoading, setSlsLoading] = useState(false)
  const [slsError, setSlsError] = useState('')
  const logBoxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
  }, [logs])

  const fetchSlsErrors = async (machineNo: string) => {
    if (!machineNo.trim()) return
    setSlsLoading(true); setSlsError('')
    try {
      const r = await fetch(`/api/autospin/sls-errors?machineNo=${encodeURIComponent(machineNo)}&limit=20`)
      const d = await r.json() as { ok: boolean; entries?: SlsEntry[]; message?: string }
      if (d.ok) setSlsEntries(d.entries ?? [])
      else setSlsError(d.message ?? '查詢失敗')
    } catch (e) {
      setSlsError(String(e))
    } finally {
      setSlsLoading(false)
    }
  }

  const errorCount = logs.filter(l => classifyLogLine(l) === 'err').length
  const warnCount = logs.filter(l => classifyLogLine(l) === 'warn').length
  const hasError = errorCount > 0

  const uptimeLabel = (() => {
    const mins = Math.max(0, Math.round((Date.now() - startedAt) / 60000))
    if (mins < 60) return `${mins}m`
    return `${Math.floor(mins / 60)}h ${mins % 60}m`
  })()

  const handleStopClick = () => {
    if (!confirm(`確定要停止 ${hostname} 嗎？\n這台裝置正在執行的 AutoSpin 會立即停止，其他裝置不受影響。`)) return
    void actions.stop()
  }

  // ── 精簡卡片（非主視角）──────────────────────────────────────────────────────
  if (!isPrimary) {
    const tailLines = logs.slice(-4)
    return (
      <div
        className={`autospin-condensed-card${hasError ? ' autospin-condensed-card--error' : ''}`}
        onClick={onPromote}
        style={{
          background: hasError ? 'rgba(239,68,68,0.07)' : '#131c2e', border: '1px solid #223350', borderLeftWidth: 3,
          borderLeftColor: hasError ? '#ef4444' : '#223350', borderRadius: 10, padding: '10px 14px',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasError
            ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', flexShrink: 0, boxShadow: '0 0 0 0 rgba(239,68,68,0.5)' }} className="autospin-err-pulse" />
            : <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', flexShrink: 0, boxShadow: '0 0 6px #22c55e' }} />}
          <span style={{ fontWeight: 700, fontSize: 12.5 }}>{hostname}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: '#64748b' }}>點擊切換為主視角 →</span>
        </div>
        <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
          <span>已跑 <b style={{ color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>{uptimeLabel}</b></span>
          {hasError
            ? <span style={{ color: '#ef4444', fontWeight: 700 }}>⚠ {errorCount} 筆錯誤</span>
            : warnCount > 0
              ? <span style={{ color: '#f59e0b' }}>{warnCount} 筆警告</span>
              : <span style={{ color: '#22c55e' }}>正常</span>}
        </div>
        <div style={{ marginTop: 8, height: 60, overflow: 'hidden', fontFamily: 'monospace', fontSize: 10.5, color: '#64748b', lineHeight: 1.5, position: 'relative' }}>
          {tailLines.length === 0
            ? <span style={{ color: '#475569' }}>等待日誌...</span>
            : tailLines.map((l, i) => <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>)}
        </div>
      </div>
    )
  }

  // ── 主視角（完整三層版面）────────────────────────────────────────────────────
  const categorized = logs.map(l => {
    const cat = classifyLogLine(l)
    return { text: l, cat, pinusCat: cat === 'pinus' ? classifyPinusRoute(l) : null }
  })
  const pinusCatCounts = new Map<PinusCategory, number>()
  for (const c of categorized) {
    if (c.pinusCat) pinusCatCounts.set(c.pinusCat, (pinusCatCounts.get(c.pinusCat) ?? 0) + 1)
  }
  const visible = categorized.filter(c => {
    if (c.pinusCat && !visiblePinusCats.has(c.pinusCat)) return false
    if (logFilter === 'sys' && c.cat !== 'sys') return false
    if (logFilter === 'spin' && c.cat !== 'spin') return false
    if (logFilter === 'shot' && c.cat !== 'shot') return false
    if (logFilter === 'error' && c.cat !== 'warn' && c.cat !== 'err') return false
    if (logSearch && !c.text.toLowerCase().includes(logSearch.toLowerCase())) return false
    return true
  })
  const catColor: Record<LogCategory, string> = {
    sys: 'var(--cr-cyan)', spin: '#e2e8f0', shot: 'var(--cr-violet)', warn: '#ead8a6', err: 'var(--cr-rose)', pinus: '#5b6b85', other: '#94a3b8',
  }
  const catBg: Partial<Record<LogCategory, string>> = { spin: 'rgba(117,215,207,0.06)' }

  const shotItems = [...screenshots].reverse().map(f => ({
    name: f.name,
    ts: f.time,
    src: `/api/autospin/agent/screenshot/${sessionId}/${encodeURIComponent(f.name)}?userLabel=${encodeURIComponent(userLabel)}`,
    spinNo: extractSpinNo(f.name),
  }))

  return (
    <div className="autospin-device-card" style={{ background: '#131c2e', border: '1px solid #223350', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* ① 狀態列 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: '#1a2740', borderBottom: '1px solid #223350', flexWrap: 'wrap' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: paused ? '#f59e0b' : '#22c55e', boxShadow: `0 0 6px ${paused ? '#f59e0b' : '#22c55e'}`, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{hostname}</span>
        <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#94a3b8', marginLeft: 6, flexWrap: 'wrap' }}>
          <span>Session <b style={{ color: '#e2e8f0' }}>{sessionId.slice(0, 8)}…</b></span>
          <span>已跑 <b style={{ color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>{uptimeLabel}</b></span>
          {paused && <span style={{ color: '#f59e0b', fontWeight: 700 }}>已暫停</span>}
        </div>
        <div style={{ flex: 1 }} />
        {!paused
          ? <button className="cr-btn cr-btn--gold" onClick={() => void actions.pause()} style={{ padding: '5px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 6, border: 'none', background: 'var(--xx-gold-solid)', color: '#fff', cursor: 'pointer' }}>暫停</button>
          : <button className="cr-btn cr-btn--jade" onClick={() => void actions.resume()} style={{ padding: '5px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 6, border: 'none', background: 'var(--xx-jade-solid)', color: '#fff', cursor: 'pointer' }}>繼續</button>}
        <button onClick={handleStopClick} disabled={stopping}
          style={{ background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', fontSize: 11, fontWeight: 600, padding: '5px 11px', borderRadius: 7, cursor: stopping ? 'default' : 'pointer', opacity: stopping ? 0.6 : 1, whiteSpace: 'nowrap' }}>
          {stopping ? '停止中…' : '停止此裝置'}
        </button>
      </div>

      {actionError && (
        <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--cr-rose)', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid #223350' }}>{actionError}</div>
      )}

      {/* Spin 間隔 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid #223350', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>Spin 間隔</span>
        <input type="range" min={0.1} max={10} step={0.1} value={spinInterval} onChange={e => actions.setSpinInterval(parseFloat(e.target.value))} style={{ width: 110 }} />
        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 32 }}>{spinInterval.toFixed(1)}s</span>
        <button type="button" disabled={spinIntervalSaving} onClick={() => void actions.applySpinInterval()}
          style={{ padding: '3px 12px', fontSize: 12, borderRadius: 6, border: '1px solid var(--cr-cyan-border)', background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', cursor: 'pointer' }}>
          {spinIntervalSaving ? '...' : '套用'}
        </button>
        <span style={{ fontSize: 10.5, color: '#64748b' }}>覆蓋此裝置所有機台間隔，3秒內生效</span>
      </div>

      {/* ② 主區＋③ 側區 */}
      <div className="autospin-device-card-body" style={{ display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1.4, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #223350' }}>
          {/* 日誌 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#162032', borderBottom: '1px solid #223350', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>執行日誌</span>
            <span style={{ fontSize: 11, color: '#64748b' }}>{visible.length} / {logs.length} 行</span>
            <div style={{ flex: 1 }} />
            <input value={logSearch} onChange={e => setLogSearch(e.target.value)} placeholder="搜尋日誌內容…"
              style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #2d3f55', borderRadius: 5, background: '#0f172a', color: '#e2e8f0', width: 110 }} />
            <button className="cr-pill" onClick={() => downloadExecutionLog(logs)}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, border: '1px solid #2d3f55', background: '#0f172a', color: '#94a3b8', cursor: 'pointer' }}>下載</button>
            <button className="cr-pill" onClick={actions.clearLogs}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, border: '1px solid #2d3f55', background: '#0f172a', color: '#94a3b8', cursor: 'pointer' }}>清空</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#162032', borderBottom: '1px solid #223350', flexWrap: 'wrap' }}>
            {([['all', '全部'], ['sys', '系統'], ['spin', 'Spin'], ['shot', '截圖'], ['error', '錯誤/警告']] as const).map(([key, label]) => (
              <button key={key} className={`cr-pill${logFilter === key ? ' cr-pill--active' : ''}`} onClick={() => setLogFilter(key)}
                style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${logFilter === key ? 'var(--cr-cyan)' : '#2d3f55'}`,
                  background: logFilter === key ? 'var(--cr-cyan)' : '#0f172a', color: logFilter === key ? '#03222b' : '#94a3b8' }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#101827', borderBottom: '1px solid #223350', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: '#64748b', fontWeight: 700 }}>pinus 分類：</span>
            {PINUS_CATEGORY_META.map(({ key, label }) => {
              const count = pinusCatCounts.get(key) ?? 0
              const on = visiblePinusCats.has(key)
              return (
                <button key={key} className={`cr-pill${on ? ' cr-pill--active-soft' : ''}`}
                  onClick={() => setVisiblePinusCats(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })}
                  style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--cr-cyan)' : '#2d3f55'}`,
                    background: on ? 'var(--cr-cyan-soft)' : '#0f172a', color: on ? 'var(--cr-cyan)' : '#64748b' }}>
                  {label}{count > 0 ? `（${count}）` : ''}
                </button>
              )
            })}
          </div>
          <div ref={logBoxRef} className="autospin-log-scroll" style={{ height: 200, minHeight: 0, background: '#0f172a', padding: '8px 12px', overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7 }}>
            {logs.length === 0
              ? <span style={{ color: '#475569' }}>等待啟動...</span>
              : visible.length === 0
                ? <span style={{ color: '#475569' }}>沒有符合篩選條件的日誌</span>
                : visible.map((c, i) => (
                  <div key={i} style={{ color: catColor[c.cat], background: catBg[c.cat] ?? 'transparent', borderRadius: 3, padding: '0 3px' }}>{c.text}</div>
                ))}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="autospin-side-tabs" style={{ display: 'flex', borderBottom: '1px solid #223350', padding: '0 10px', gap: 4, overflowX: 'auto' }}>
            {([['ll', 'LuckyLink JP'], ['sls', 'SLS 對帳'], ['shot', '截圖監控']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setSideTab(key)}
                style={{ background: 'transparent', border: 'none', color: sideTab === key ? '#e2e8f0' : '#64748b',
                  fontSize: 11.5, fontWeight: 600, padding: '8px 10px 9px', cursor: 'pointer', whiteSpace: 'nowrap',
                  borderBottom: `2px solid ${sideTab === key ? 'var(--cr-cyan)' : 'transparent'}`, marginBottom: -1 }}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ height: 236, overflowY: 'auto', padding: '10px 12px 12px' }}>
            {sideTab === 'll' && (
              !luckylinkStatus ? (
                <div style={{ fontSize: 11, color: '#64748b' }}>等待 Poller 啟動...</div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 10, color: '#94a3b8' }}>
                    <span>Group: <b style={{ color: '#cbd5e1' }}>{luckylinkStatus.jpGroupCode}</b></span>
                    {luckylinkStatus.lastPollTs && <span>更新: <b style={{ color: '#cbd5e1' }}>{new Date(luckylinkStatus.lastPollTs).toLocaleTimeString('zh-TW')}</b></span>}
                    <span style={{ color: luckylinkStatus.connected ? '#22c55e' : '#f59e0b' }}>{luckylinkStatus.connected ? '連線中' : '已停止'}</span>
                  </div>
                  {luckylinkStatus.error && <div style={{ fontSize: 11, color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderRadius: 4, padding: '4px 6px', marginTop: 6 }}>{luckylinkStatus.error}</div>}
                  {(luckylinkStatus.diffs.length > 0 || luckylinkStatus.pool.length > 0) && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, marginTop: 6 }}>
                      <thead><tr style={{ color: '#64748b' }}>
                        <th style={{ textAlign: 'left', paddingBottom: 3 }}>Level</th>
                        <th style={{ textAlign: 'right', paddingBottom: 3 }}>金額</th>
                        <th style={{ textAlign: 'right', paddingBottom: 3 }}>變化</th>
                      </tr></thead>
                      <tbody>
                        {(luckylinkStatus.diffs.length > 0 ? luckylinkStatus.diffs : luckylinkStatus.pool.map(p => ({ name: p.name, curr: p.displayValue, prev: null, delta: null, state: 'init' as const, matchedGameCodes: [] }))).map((d, i) => {
                          const stateColor = d.state === 'drop' ? '#ef4444' : d.state === 'reset' ? '#22c55e' : d.state === 'increase' ? '#38bdf8' : d.state === 'frozen' ? '#f59e0b' : '#94a3b8'
                          const hasMatch = d.matchedGameCodes && d.matchedGameCodes.length > 0
                          const fmtPHP = (v: number) => `₱${v >= 1000 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(2)}`
                          return (
                            <tr key={i} style={{ borderTop: '1px solid #0f172a' }}>
                              <td style={{ padding: '2px 0', color: hasMatch ? '#7dd3fc' : '#cbd5e1' }} title={hasMatch ? `匹配: ${d.matchedGameCodes!.join(', ')}` : undefined}>{d.name}</td>
                              <td style={{ textAlign: 'right', color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>{typeof d.curr === 'number' ? fmtPHP(d.curr) : d.curr}</td>
                              <td style={{ textAlign: 'right', color: stateColor }}>{d.delta !== null && d.delta !== undefined ? `${d.delta >= 0 ? '+' : '-'}₱${Math.abs(d.delta).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                  {luckylinkStatus.alerts.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, borderTop: '1px solid #0f172a', paddingTop: 4, marginTop: 6 }}>
                      {luckylinkStatus.alerts.slice(-5).map((a, i) => (
                        <div key={i} style={{ fontSize: 10, borderLeft: `3px solid ${a.level === 'error' ? 'var(--cr-rose)' : a.level === 'warn' ? '#ead8a6' : 'var(--cr-cyan)'}`, paddingLeft: 6, color: '#cbd5e1' }}>
                          <span style={{ color: a.level === 'error' ? 'var(--cr-rose)' : a.level === 'warn' ? '#ead8a6' : 'var(--cr-cyan)' }}>{a.name} [{a.state}]</span>
                          {a.message && <span style={{ color: '#94a3b8' }}> {a.message}</span>}
                          {a.prev !== undefined && <span style={{ color: '#64748b' }}> ({a.prev}→{a.curr})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )
            )}

            {sideTab === 'sls' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select value={slsMachineNo} onChange={e => { setSlsMachineNo(e.target.value); setSlsEntries([]) }}
                    style={{ flex: 1, fontSize: 11, padding: '4px 6px', border: '1px solid #2d3f55', borderRadius: 5, background: '#0f172a', color: '#e2e8f0' }}>
                    <option value=''>— 選擇機台 —</option>
                    {configs.filter(c => c.machineNo).map(c => (
                      <option key={c.machineType} value={c.machineNo}>{c.machineType} ({c.machineNo})</option>
                    ))}
                  </select>
                  <button onClick={() => void fetchSlsErrors(slsMachineNo)} disabled={!slsMachineNo || slsLoading}
                    style={{ fontSize: 11, padding: '4px 8px', background: slsMachineNo ? 'var(--xx-jade-solid)' : '#334155', color: slsMachineNo ? '#fff' : '#9ca3af', border: 'none', borderRadius: 5, cursor: slsMachineNo ? 'pointer' : 'default' }}>
                    {slsLoading ? '...' : '查詢'}
                  </button>
                </div>
                {slsError && <div style={{ fontSize: 11, color: 'var(--cr-rose)' }}>{slsError}</div>}
                {slsEntries.length === 0 && !slsLoading && !slsError && slsMachineNo && (
                  <div style={{ fontSize: 11, color: '#64748b' }}>近 24 小時無錯誤記錄</div>
                )}
                {slsEntries.map((e, i) => (
                  <div key={i} style={{ fontSize: 10, borderLeft: `3px solid ${e.level === 'ERROR' ? 'var(--cr-rose)' : e.level === 'WARN' || e.level === 'WARNING' ? '#ead8a6' : '#6b7280'}`, paddingLeft: 6, color: '#cbd5e1' }}>
                    <div style={{ color: '#94a3b8', marginBottom: 2 }}>{e.timeStr} · <span style={{ color: e.level === 'ERROR' ? 'var(--cr-rose)' : '#ead8a6', fontWeight: 700 }}>{e.level}</span></div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{e.content.slice(0, 160)}{e.content.length > 160 ? '…' : ''}</div>
                  </div>
                ))}
              </div>
            )}

            {sideTab === 'shot' && (
              shotItems.length === 0 ? <p style={{ color: '#64748b', fontSize: 12 }}>尚無截圖</p> : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {shotItems.map((it, i) => (
                    <div key={it.name} onClick={() => onSetLightbox(it.src)}
                      style={{ position: 'relative', border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden', aspectRatio: '1 / 1', background: '#0f172a', cursor: 'zoom-in' }}>
                      <img src={it.src} alt={it.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      {i === 0 && <span style={{ position: 'absolute', top: 4, right: 4, background: 'var(--xx-jade-solid)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>最新</span>}
                      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '4px 6px', background: 'linear-gradient(0deg, rgba(0,0,0,0.75), transparent)', fontSize: 9.5, color: '#e2e8f0', display: 'flex', justifyContent: 'space-between' }}>
                        <span>{it.spinNo ? `Spin #${it.spinNo}` : it.name}</span>
                        <b style={{ color: 'var(--cr-cyan)' }}>{relativeShotTime(it.ts)}</b>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

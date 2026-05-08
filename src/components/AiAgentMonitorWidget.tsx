import { useEffect, useRef, useState } from 'react'
import { useIsGameMode } from './GameModeContext'
import { PixelStudioWidget } from '../game/components/PixelStudioWidget'

type Provider = 'gemini' | 'openai' | 'ollama'
type TaskStatus = 'running' | 'done' | 'error'

interface AiTask {
  id: string
  provider: Provider
  kind: 'text' | 'vision'
  model: string
  operation: string
  user: string
  status: TaskStatus
  startedAt: number
  durationMs?: number
}

interface MonitorResponse {
  ok: boolean
  runningCount?: number
  runningByProvider?: Record<Provider, number>
  latest?: AiTask[]
}

export default function AiAgentMonitorWidget() {
  const isGame = useIsGameMode()
  if (isGame) return <PixelStudioWidget />

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return <LegacyAiAgentMonitorWidget />
}

function LegacyAiAgentMonitorWidget() {
  const [backendOnline, setBackendOnline] = useState(true)
  const [runningCount, setRunningCount] = useState(0)
  const [runningByProvider, setRunningByProvider] = useState<Record<Provider, number>>({ gemini: 0, openai: 0, ollama: 0 })
  const [latest, setLatest] = useState<AiTask[]>([])
  const [minimized, setMinimized] = useState(false)
  const [pos, setPos] = useState(() => {
    const defaultHeight = 300
    if (typeof window === 'undefined') return { x: 24, y: 24 }
    return {
      x: 24,
      y: Math.max(24, window.innerHeight - defaultHeight - 24),
    }
  })
  const draggingRef = useRef(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const h = await fetch('/api/health')
        if (!alive) return
        setBackendOnline(h.ok)
      } catch {
        if (!alive) return
        setBackendOnline(false)
      }
      try {
        const r = await fetch('/api/ai-agent/monitor')
        const d = await r.json() as MonitorResponse
        if (!alive || !d.ok) return
        setRunningCount(d.runningCount ?? 0)
        setRunningByProvider(d.runningByProvider ?? { gemini: 0, openai: 0, ollama: 0 })
        setLatest((d.latest ?? []).slice(0, 5))
      } catch {
        if (!alive) return
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const maxX = Math.max(0, window.innerWidth - (minimized ? 220 : 420))
      const maxY = Math.max(0, window.innerHeight - 56)
      const x = Math.min(Math.max(0, e.clientX - dragOffsetRef.current.x), maxX)
      const y = Math.min(Math.max(0, e.clientY - dragOffsetRef.current.y), maxY)
      setPos({ x, y })
    }
    const onMouseUp = () => { draggingRef.current = false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [minimized])

  const onDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    draggingRef.current = true
    dragOffsetRef.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: minimized ? 220 : 420,
        zIndex: 9999,
        border: '1px solid #cbd5e1',
        borderRadius: 10,
        background: '#fff',
        boxShadow: '0 10px 24px rgba(2, 6, 23, 0.16)',
        overflow: 'hidden',
      }}
    >
      <div
        onMouseDown={onDragStart}
        style={{
          cursor: 'move',
          padding: '8px 10px',
          background: backendOnline ? '#eff6ff' : '#fef2f2',
          borderBottom: minimized ? 'none' : '1px solid #e5e7eb',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: backendOnline ? '#1d4ed8' : '#b91c1c',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span style={{ flex: 1 }}>AI Agent 監控</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMinimized(v => !v) }}
          className="btn-ghost"
          style={{ fontSize: 11, padding: '2px 8px' }}
        >
          {minimized ? '展開' : '縮小'}
        </button>
      </div>

      {!minimized && (
        <div style={{ padding: 10 }}>
          <div style={{ fontSize: 12, marginBottom: 8, color: backendOnline ? '#1f2937' : '#b91c1c' }}>
            {backendOnline ? `後端連線正常，AI 執行中：${runningCount} 筆` : '前端目前無法連線後端（可能網路中斷）'}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 12 }}>
            <span style={{ background: '#eef2ff', borderRadius: 999, padding: '2px 8px', color: '#3730a3' }}>Gemini {runningByProvider.gemini}</span>
            <span style={{ background: '#fdf2f8', borderRadius: 999, padding: '2px 8px', color: '#be185d' }}>OpenAI {runningByProvider.openai}</span>
            <span style={{ background: '#ecfeff', borderRadius: 999, padding: '2px 8px', color: '#0e7490' }}>Ollama {runningByProvider.ollama}</span>
          </div>

          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>最近 AI 任務（最多 5 筆）</div>
          {latest.length === 0 ? (
            <div style={{ fontSize: 12, color: '#9ca3af' }}>目前沒有可顯示的任務紀錄</div>
          ) : (
            <div style={{ display: 'grid', gap: 4, maxHeight: 200, overflow: 'auto' }}>
              {latest.map(job => (
                <div key={job.id} style={{ display: 'grid', gridTemplateColumns: '62px 56px 1fr auto', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <span style={{ textAlign: 'center', borderRadius: 999, padding: '1px 8px', background: job.status === 'running' ? '#dbeafe' : job.status === 'done' ? '#dcfce7' : '#fee2e2', color: job.status === 'running' ? '#1d4ed8' : job.status === 'done' ? '#166534' : '#b91c1c' }}>
                    {job.status}
                  </span>
                  <span style={{ color: '#6b7280' }}>{job.provider}</span>
                  <span style={{ color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${job.kind} • ${job.model} • ${job.operation} • 使用者:${job.user}`}>
                    {job.kind} • {job.model}
                  </span>
                  <span style={{ color: '#6b7280' }}>
                    {new Date(job.startedAt).toLocaleTimeString('zh-TW', { hour12: false })}
                  </span>
                  <span style={{ gridColumn: '2 / span 3', color: '#64748b', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {job.user} ｜ {job.operation}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

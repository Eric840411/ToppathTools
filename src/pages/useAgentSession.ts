import { useCallback, useEffect, useRef, useState } from 'react'

// ─── LuckyLink JP types (moved out of AutoSpinPage so both the page and
// DeviceSessionPanel/useAgentSession can share them without duplication) ────────
export interface LuckylinkPoolEntry { name: string; rawValue: number; displayValue: number; basevalue: number; maxValue: number; overageValue: number }
export interface LuckylinkDiff { name: string; prev: number | null; curr: number; delta: number | null; state: string; matchedGameCodes?: string[] }
export interface LuckylinkAlertEntry { level: 'error' | 'warn' | 'info'; name: string; state: string; message?: string; ts: string; prev?: number; curr?: number; delta?: number }
export interface LuckylinkStatus { connected: boolean; jpGroupCode: string; pollCount: number; lastPollTs: string | null; pool: LuckylinkPoolEntry[]; diffs: LuckylinkDiff[]; alerts: LuckylinkAlertEntry[]; error: string | null }

export interface AgentScreenshotFile { name: string; time: number }

export interface AgentSessionActions {
  stop: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  setSpinInterval: (v: number) => void
  applySpinInterval: () => Promise<void>
  clearLogs: () => void
  refreshScreenshots: () => Promise<void>
}

export interface AgentSessionResult {
  logs: string[]
  screenshots: AgentScreenshotFile[]
  luckylinkStatus: LuckylinkStatus | null
  paused: boolean
  stopping: boolean
  spinInterval: number
  spinIntervalSaving: boolean
  actionError: string
  actions: AgentSessionActions
}

/**
 * 單一 AutoSpin session 的即時資料來源（SSE 日誌/LuckyLink 事件、截圖輪詢、暫停/繼續/Spin間隔）。
 * identity 以 sessionId 為主（見 CLAUDE.md AutoSpin 多裝置並行章節）——agentId 只用來組
 * hub-stop 的請求 body（那支端點是「命令哪個裝置的 Local Agent」，不是 session 操作），
 * 不能拿 agentId 當這個 hook 的 key，否則同一台裝置停掉又開新 session 時，舊 session 的
 * log/截圖/LuckyLink 狀態會殘留跨到新 session 上。
 *
 * sessionId 變更（含 null → 有值、有值 → 別的 sessionId）都會重新開一條 SSE、重置所有 state；
 * unmount 或 sessionId 變成 null 時完整清掉：EventSource.close()、reconnect timer、screenshot
 * polling interval 三者都要 cleanup，避免多個 DeviceSessionPanel 實例互相殘留計時器。
 */
export function useAgentSession(sessionId: string | null, agentId: string, userLabel: string): AgentSessionResult {
  const [logs, setLogs] = useState<string[]>([])
  const [screenshots, setScreenshots] = useState<AgentScreenshotFile[]>([])
  const [luckylinkStatus, setLuckylinkStatus] = useState<LuckylinkStatus | null>(null)
  const [paused, setPaused] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [spinInterval, setSpinIntervalState] = useState(1.0)
  const [spinIntervalSaving, setSpinIntervalSaving] = useState(false)
  const [actionError, setActionError] = useState('')

  const evtSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshScreenshots = useCallback(async () => {
    if (!sessionId) return
    try {
      const r = await fetch(`/api/autospin/agent/screenshots/${sessionId}`, { headers: { 'x-user-label': userLabel } })
      const d = await r.json() as { files?: AgentScreenshotFile[] }
      setScreenshots(d.files ?? [])
    } catch { /* best-effort polling, ignore transient failures */ }
  }, [sessionId, userLabel])

  useEffect(() => {
    // Reset everything on session change — a fresh sessionId means a fresh device session,
    // 舊 session 的資料不能延續顯示（即使剛好同一個 agentId 重新派工）
    setLogs([]); setScreenshots([]); setLuckylinkStatus(null); setPaused(false); setActionError('')
    if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null }
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
    if (captureTimerRef.current) { clearInterval(captureTimerRef.current); captureTimerRef.current = null }
    if (!sessionId) return

    const connect = (fromIndex: number) => {
      const from = fromIndex > 0 ? `&from=${fromIndex}` : ''
      const es = new EventSource(`/api/autospin/agent/stream/${sessionId}?userLabel=${encodeURIComponent(userLabel)}${from}`)
      es.onmessage = (e) => {
        const data = JSON.parse(e.data) as { line?: string; luckylink_event?: Record<string, unknown> }
        if (data.luckylink_event) {
          const evt = data.luckylink_event as { type?: string; data?: Record<string, unknown>; ts?: string }
          if (evt.type === 'luckylink_start') {
            const d = evt.data as { jpGroupCode?: string }
            setLuckylinkStatus({ connected: true, jpGroupCode: d?.jpGroupCode ?? '', pollCount: 0, lastPollTs: null, pool: [], diffs: [], alerts: [], error: null })
          } else if (evt.type === 'luckylink_pool') {
            const d = evt.data as { poll?: number; pool?: LuckylinkPoolEntry[]; diffs?: LuckylinkDiff[] }
            setLuckylinkStatus(prev => prev ? { ...prev, pollCount: d.poll ?? prev.pollCount, lastPollTs: evt.ts ?? null, pool: d.pool ?? [], diffs: d.diffs ?? [] } : prev)
          } else if (evt.type === 'luckylink_alert') {
            const d = evt.data as { level?: string; name?: string; state?: string; message?: string; prev?: number; curr?: number; delta?: number }
            const alert: LuckylinkAlertEntry = { level: (d.level ?? 'info') as 'error' | 'warn' | 'info', name: d.name ?? '', state: d.state ?? '', message: d.message, ts: evt.ts ?? new Date().toISOString(), prev: d.prev, curr: d.curr, delta: d.delta }
            setLuckylinkStatus(prev => prev ? { ...prev, alerts: [...prev.alerts.slice(-20), alert] } : prev)
          } else if (evt.type === 'luckylink_error') {
            const d = evt.data as { message?: string; fatal?: boolean }
            setLuckylinkStatus(prev => prev
              ? { ...prev, error: d.message ?? '未知錯誤', connected: !d.fatal }
              : { connected: !d.fatal, jpGroupCode: '', pollCount: 0, lastPollTs: null, pool: [], diffs: [], alerts: [], error: d.message ?? '未知錯誤' })
          } else if (evt.type === 'luckylink_stop') {
            setLuckylinkStatus(prev => prev ? { ...prev, connected: false } : prev)
          }
          return
        }
        const line = data.line ?? ''
        setLogs(prev => [...prev.slice(-500), line])
      }
      es.onerror = () => {
        es.close()
        // 只有這條連線還是「目前使用中」的那條才自動重連——避免 unpin/session 結束後，
        // 舊連線的重連計時器還在跑，把已經不該顯示的資料又拉回來
        if (evtSourceRef.current !== es) return
        reconnectTimerRef.current = setTimeout(() => {
          if (evtSourceRef.current !== es) return
          setLogs([])
          connect(0)
        }, 2000)
      }
      evtSourceRef.current = es
    }
    connect(0)
    void refreshScreenshots()
    captureTimerRef.current = setInterval(refreshScreenshots, 5000)

    return () => {
      if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null }
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      if (captureTimerRef.current) { clearInterval(captureTimerRef.current); captureTimerRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, userLabel])

  const stop = useCallback(async () => {
    if (!agentId) return
    setStopping(true)
    setLogs(prev => [...prev, '[系統] 正在停止此裝置...'])
    try {
      // 只命令這一台裝置（hub-stop 帶 agentId 時，伺服器端 WS 停止指令＋should-stop 雙保險迴圈
      // 都只會作用在這個 agentId，不會連帶停掉其他裝置的 session——不能改呼叫 agent/stop-all，
      // 那支是「整個帳號全部停」，會誤停其他還在跑的裝置）
      await fetch('/api/autospin/hub-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-label': userLabel },
        body: JSON.stringify({ agentId }),
      })
    } catch { /* best-effort; parent's status polling will reflect the real outcome */ }
    finally { setStopping(false) }
  }, [agentId, userLabel])

  const pause = useCallback(async () => {
    if (!sessionId) return
    setActionError('')
    try {
      await fetch(`/api/autospin/agent/${sessionId}/pause`, { method: 'POST', headers: { 'x-user-label': userLabel } })
      setPaused(true)
    } catch (e) { setActionError('暫停失敗：' + String(e)) }
  }, [sessionId, userLabel])

  const resume = useCallback(async () => {
    if (!sessionId) return
    setActionError('')
    try {
      await fetch(`/api/autospin/agent/${sessionId}/resume`, { method: 'POST', headers: { 'x-user-label': userLabel } })
      setPaused(false)
    } catch (e) { setActionError('繼續失敗：' + String(e)) }
  }, [sessionId, userLabel])

  const applySpinInterval = useCallback(async () => {
    if (!sessionId) { setActionError('尚未取得執行中的 Session，請稍候幾秒再試一次'); return }
    setSpinIntervalSaving(true); setActionError('')
    try {
      const r = await fetch(`/api/autospin/agent/${sessionId}/spin-interval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-label': userLabel },
        body: JSON.stringify({ value: spinInterval }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({} as { message?: string }))
        setActionError(d.message ?? `套用 Spin 間隔失敗（HTTP ${r.status}）`)
      }
    } catch (e) {
      setActionError('套用 Spin 間隔失敗：' + String(e))
    } finally {
      setSpinIntervalSaving(false)
    }
  }, [sessionId, userLabel, spinInterval])

  const clearLogs = useCallback(() => setLogs([]), [])

  return {
    logs, screenshots, luckylinkStatus, paused, stopping, spinInterval, spinIntervalSaving, actionError,
    actions: { stop, pause, resume, setSpinInterval: setSpinIntervalState, applySpinInterval, clearLogs, refreshScreenshots },
  }
}

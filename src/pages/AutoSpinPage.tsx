import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AutospinConfig {
  machineType: string
  gameUrl: string
  rtmpName: string
  rtmpUrl: string
  gameTitleCode: string
  templateType: string
  errorTemplateType: string
  enabled: boolean
  enableRecording: boolean
  enableTemplateDetection: boolean
  notes: string
  spinInterval: number
  randomExitEnabled: boolean
  randomExitChance: number
  randomExitMinSpins: number
  betRandomEnabled: boolean
  lowBalanceThreshold: number
  larkWebhook: string
  machineNo: string
}

interface CaptureFile {
  name: string
  dir: string
  mtime: number
}

const EMPTY_CONFIG: AutospinConfig = {
  machineType: '', gameUrl: '', rtmpName: '', rtmpUrl: '',
  gameTitleCode: '', templateType: '', errorTemplateType: '',
  enabled: true, enableRecording: true, enableTemplateDetection: true, notes: '',
  spinInterval: 1.0, randomExitEnabled: false, randomExitChance: 0.02,
  randomExitMinSpins: 50, betRandomEnabled: false, lowBalanceThreshold: 0, larkWebhook: '', machineNo: '',
}

// ─── Component ─────────────────────────────────────────────────────────────────

function getGlobalUserLabel(): string {
  try {
    const acc = JSON.parse(sessionStorage.getItem('global_jira_account') ?? 'null')
    return acc?.label ?? ''
  } catch { return '' }
}

export function AutoSpinPage() {
  const [tab, setTab] = useState<'configs' | 'templates' | 'betrandom' | 'history' | 'reconcile' | 'run'>('configs')

  // ── Config tab ──────────────────────────────────────────────────────────────
  const [configs, setConfigs] = useState<AutospinConfig[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingType, setEditingType] = useState<string | null>(null)
  const [form, setForm] = useState<AutospinConfig>(EMPTY_CONFIG)
  const [configMsg, setConfigMsg] = useState('')

  const userLabel = getGlobalUserLabel()
  const userHeaders = { 'Content-Type': 'application/json', 'x-user-label': userLabel }

  // ── OSM Jackpot state ───────────────────────────────────────────────────────
  interface JackpotEntry { gtype: number; gameName: string; grand?: number; fortunate?: number; updatedAt: number }
  const [jackpots, setJackpots] = useState<JackpotEntry[]>([])
  const [jackpotPanelOpen, setJackpotPanelOpen] = useState(false)

  const fetchConfigs = async () => {
    const r = await fetch('/api/autospin/configs', { headers: { 'x-user-label': getGlobalUserLabel() } })
    const d = await r.json() as { configs?: AutospinConfig[] }
    setConfigs((d.configs ?? []).map(c => ({
      ...c,
      enabled: !!c.enabled, enableRecording: !!c.enableRecording, enableTemplateDetection: !!c.enableTemplateDetection,
      randomExitEnabled: !!c.randomExitEnabled, betRandomEnabled: !!c.betRandomEnabled,
      spinInterval: c.spinInterval ?? 1.0, randomExitChance: c.randomExitChance ?? 0.02, randomExitMinSpins: c.randomExitMinSpins ?? 50,
      lowBalanceThreshold: c.lowBalanceThreshold ?? 0,
      larkWebhook: c.larkWebhook ?? '',
      machineNo: c.machineNo ?? '',
    })))
  }

  const handleSaveConfig = async () => {
    if (!form.machineType.trim()) { setConfigMsg('機台類型不得為空'); return }
    const r = await fetch('/api/autospin/configs', {
      method: 'POST', headers: userHeaders, body: JSON.stringify(form),
    })
    const d = await r.json() as { ok: boolean; message?: string }
    if (d.ok) { setShowForm(false); setEditingType(null); setForm(EMPTY_CONFIG); fetchConfigs() }
    else setConfigMsg(d.message ?? '儲存失敗')
  }

  const handleDeleteConfig = async (machineType: string) => {
    if (!confirm(`確定刪除「${machineType}」？`)) return
    await fetch(`/api/autospin/configs/${encodeURIComponent(machineType)}`, { method: 'DELETE', headers: { 'x-user-label': userLabel } })
    fetchConfigs()
  }

  const handleEditConfig = (c: AutospinConfig) => {
    setEditingType(c.machineType)
    setForm({ ...c })
    setConfigMsg('')
    setShowForm(true)
  }

  // ── Templates tab ───────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<{ name: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchTemplates = async () => {
    const r = await fetch('/api/autospin/templates')
    const d = await r.json() as { files?: { name: string }[] }
    setTemplates(d.files ?? [])
  }

  const handleUploadTemplate = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const fd = new FormData(); fd.append('file', file)
    await fetch('/api/autospin/templates', { method: 'POST', body: fd })
    setUploading(false)
    fetchTemplates()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDeleteTemplate = async (name: string) => {
    if (!confirm(`確定刪除模板「${name}」？`)) return
    await fetch(`/api/autospin/templates/${encodeURIComponent(name)}`, { method: 'DELETE' })
    fetchTemplates()
  }

  // ── Reconcile tab ───────────────────────────────────────────────────────────
  const [rcConfig, setRcConfig] = useState<Record<string, string>>({})
  const [rcConfigMsg, setRcConfigMsg] = useState('')
  const [rcRunning, setRcRunning] = useState(false)
  const [rcRangeStart, setRcRangeStart] = useState('')
  const [rcRangeEnd, setRcRangeEnd] = useState('')
  const [rcMachineType, setRcMachineType] = useState('')
  const [rcPlayerId, setRcPlayerId] = useState('')
  const [rcResult, setRcResult] = useState<null | { summary: string; details: {status:string;uid:string;time:string;bet:number;win:number;note:string}[]; backendAnomalies: {uid:string;time:string;bet:number;win:number;note:string}[] }>(null)
  const [rcReports, setRcReports] = useState<{id:number;runAt:number;rangeStart:string;rangeEnd:string;machineType:string;frontCount:number;backendCount:number;matchedCount:number;unmatchedCount:number;anomalyCount:number;summary:string}[]>([])

  const fetchRcConfig = async () => {
    const r = await fetch('/api/autospin/reconcile/config')
    const d = await r.json() as { config?: Record<string, string> }
    setRcConfig(d.config ?? {})
  }

  const saveRcConfig = async () => {
    setRcConfigMsg('')
    const r = await fetch('/api/autospin/reconcile/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: rcConfig.base_url ?? '',
        login_path: rcConfig.login_path ?? '/auth/login',
        token: rcConfig.token ?? '',
        lastlogintime: rcConfig.lastlogintime ?? '',
        channelId: rcConfig.channelId ?? '873',
        playerstudioid: rcConfig.playerstudioid ?? '',
        origin: rcConfig.origin ?? '',
        referer: rcConfig.referer ?? '',
        login_username: rcConfig.login_username ?? '',
        login_password: rcConfig.login_password ?? '',
        auto_login: rcConfig.auto_login !== 'false',
      }),
    })
    const d = await r.json() as { ok: boolean }
    setRcConfigMsg(d.ok ? '✅ 已儲存' : '❌ 儲存失敗')
  }

  const testRcConnection = async () => {
    setRcConfigMsg('測試中...')
    const r = await fetch('/api/autospin/reconcile/test', { method: 'POST' })
    const d = await r.json() as { ok: boolean; message?: string }
    setRcConfigMsg(d.ok ? `✅ ${d.message}` : `❌ ${d.message}`)
  }

  const runReconcile = async () => {
    if (!rcRangeStart || !rcRangeEnd) { setRcConfigMsg('請填寫時間範圍'); return }
    setRcRunning(true); setRcResult(null)
    try {
      const r = await fetch('/api/autospin/reconcile/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-label': getGlobalUserLabel() },
        body: JSON.stringify({ rangeStart: rcRangeStart, rangeEnd: rcRangeEnd, machineType: rcMachineType, playerId: rcPlayerId }),
      })
      type RcDetail = { status: string; uid: string; time: string; bet: number; win: number; note: string }
      type RcAnomaly = { uid: string; time: string; bet: number; win: number; note: string }
      const d = await r.json() as { ok: boolean; summary?: string; details?: RcDetail[]; backendAnomalies?: RcAnomaly[]; message?: string }
      if (d.ok) setRcResult({ summary: d.summary ?? '', details: d.details ?? [], backendAnomalies: d.backendAnomalies ?? [] })
      else setRcConfigMsg(`❌ ${d.message}`)
      fetchRcReports()
    } finally { setRcRunning(false) }
  }

  const fetchRcReports = async () => {
    const r = await fetch('/api/autospin/reconcile/reports')
    const d = await r.json() as { reports?: typeof rcReports }
    setRcReports(d.reports ?? [])
  }

  // ── History tab ─────────────────────────────────────────────────────────────
  interface HistoryRow {
    id: number; sessionId: string; machineType: string; userLabel: string
    balance: number | null; spinCount: number; event: string; note: string
    isAnomaly: number; createdAt: number
  }
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([])
  const [historyFilter, setHistoryFilter] = useState('')

  const fetchHistory = async () => {
    const params = new URLSearchParams()
    if (historyFilter) params.set('machineType', historyFilter)
    params.set('limit', '200')
    const r = await fetch(`/api/autospin/history?${params}`, { headers: { 'x-user-label': getGlobalUserLabel() } })
    const d = await r.json() as { rows?: HistoryRow[] }
    setHistoryRows(d.rows ?? [])
  }

  const handleClearHistory = async () => {
    if (!confirm('確定清除所有歷史戰績？')) return
    await fetch('/api/autospin/history', { method: 'DELETE', headers: { 'x-user-label': getGlobalUserLabel() } })
    setHistoryRows([])
  }

  const EVENT_LABEL: Record<string, string> = {
    balance: '餘額快照', start: '開始', stop: '結束',
    bonus: '🎯 Bonus 偵測', low_balance: '💰 低餘額', error: '⚠️ 錯誤',
  }

  // ── Bet Random tab ──────────────────────────────────────────────────────────
  const [betRandomData, setBetRandomData] = useState<Record<string, string[]>>({})
  const [betRandomMsg, setBetRandomMsg] = useState('')
  const [brShowForm, setBrShowForm] = useState(false)
  const [brEditKey, setBrEditKey] = useState<string | null>(null)
  const [brFormKey, setBrFormKey] = useState('')
  const [brFormSelectors, setBrFormSelectors] = useState<string[]>([''])

  const fetchBetRandom = async () => {
    const r = await fetch('/api/autospin/bet-random')
    const d = await r.json() as { ok: boolean; data?: Record<string, string[]> }
    setBetRandomData(d.data ?? {})
  }

  const saveBetRandom = async (data: Record<string, string[]>) => {
    const r = await fetch('/api/autospin/bet-random', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    })
    const d = await r.json() as { ok: boolean; message?: string; details?: { message: string; path: (string|number)[] }[] }
    if (!d.ok) {
      const detail = d.details?.map(i => `[${i.path.join('.')}] ${i.message}`).join('；') ?? ''
      setBetRandomMsg((d.message ?? '儲存失敗') + (detail ? `：${detail}` : ''))
    }
    return d.ok
  }

  const handleSaveBrEntry = async () => {
    const key = brFormKey.trim()
    if (!key) { setBetRandomMsg('Game Title Code 不得為空'); return }
    const selectors = brFormSelectors.map(s => s.trim()).filter(Boolean)
    if (selectors.length === 0) { setBetRandomMsg('至少需要一個 XPath'); return }
    if (!brEditKey && betRandomData[key] !== undefined) { setBetRandomMsg('此 Game Title Code 已存在'); return }
    const newData = { ...betRandomData }
    if (brEditKey && brEditKey !== key) delete newData[brEditKey]
    newData[key] = selectors
    if (await saveBetRandom(newData)) {
      setBetRandomData(newData)
      setBrShowForm(false); setBrEditKey(null); setBrFormKey(''); setBrFormSelectors(['']); setBetRandomMsg('')
    }
  }

  const handleDeleteBrEntry = async (key: string) => {
    if (!confirm(`確定刪除「${key}」的所有隨機下注設定？`)) return
    const newData = { ...betRandomData }
    delete newData[key]
    if (await saveBetRandom(newData)) setBetRandomData(newData)
  }

  const openBrEdit = (key: string) => {
    setBrEditKey(key); setBrFormKey(key)
    setBrFormSelectors([...(betRandomData[key] ?? []), ''])
    setBetRandomMsg(''); setBrShowForm(true)
  }

  // ── Run tab ─────────────────────────────────────────────────────────────────
  const [runMode, setRunMode] = useState<'server' | 'local'>('local')
  const [running, setRunning] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [agentLogs, setAgentLogs] = useState<string[]>([])
  const [captures, setCaptures] = useState<CaptureFile[]>([])
  const [agentCaptures, setAgentCaptures] = useState<{ name: string; time: number }[]>([])
  const [startError, setStartError] = useState('')
  const [liveSpinInterval, setLiveSpinInterval] = useState<number>(1.0)
  const [liveIntervalSaving, setLiveIntervalSaving] = useState(false)
  const logBoxRef = useRef<HTMLDivElement>(null)

  // ── SLS error logs ───────────────────────────────────────────────────────────
  interface SlsEntry { time: number; timeStr: string; project: string; logstore: string; content: string; level: string }
  const [slsMachineNo, setSlsMachineNo] = useState('')
  const [slsEntries, setSlsEntries] = useState<SlsEntry[]>([])
  const [slsLoading, setSlsLoading] = useState(false)
  const [slsError, setSlsError] = useState('')
  const [slsPanelOpen, setSlsPanelOpen] = useState(false)
  const slsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSlsErrors = useCallback(async (machineNo: string) => {
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
  }, [])

  // auto-refresh SLS every 60s while running
  useEffect(() => {
    if (slsTimerRef.current) { clearInterval(slsTimerRef.current); slsTimerRef.current = null }
    if ((running || agentRunning) && slsMachineNo.trim()) {
      slsTimerRef.current = setInterval(() => fetchSlsErrors(slsMachineNo), 60_000)
    }
    return () => { if (slsTimerRef.current) clearInterval(slsTimerRef.current) }
  }, [running, agentRunning, slsMachineNo, fetchSlsErrors])
  const evtSourceRef = useRef<EventSource | null>(null)
  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Ref to always hold latest agentSessionId for interval callbacks (avoids stale closure)
  const agentSessionIdRef = useRef<string | null>(null)

  const fetchStatus = useCallback(async () => {
    const r = await fetch('/api/autospin/status')
    const d = await r.json() as { running: boolean; sessionId: string | null }
    setRunning(d.running)
    if (d.sessionId && d.sessionId !== sessionId) setSessionId(d.sessionId)
    // Agent status — also auto-connect SSE if a new session is detected
    const ar = await fetch('/api/autospin/agent/status')
    const ad = await ar.json() as { running: boolean; sessionId: string | null }
    setAgentRunning(ad.running)
    if (ad.running && ad.sessionId && ad.sessionId !== agentSessionIdRef.current) {
      agentSessionIdRef.current = ad.sessionId
      setAgentSessionId(ad.sessionId)
      connectSSE(ad.sessionId, true)
      if (!captureTimerRef.current) {
        captureTimerRef.current = setInterval(() => fetchAgentCaptures(ad.sessionId!), 5000)
      }
    }
    if (!ad.running) {
      agentSessionIdRef.current = null
      setAgentSessionId(null)
    }
  }, [sessionId])

  const fetchCaptures = useCallback(async () => {
    const r = await fetch('/api/autospin/captures-list')
    const d = await r.json() as { files?: CaptureFile[] }
    setCaptures(d.files ?? [])
  }, [])

  const fetchAgentCaptures = useCallback(async (sid: string) => {
    const r = await fetch(`/api/autospin/agent/screenshots/${sid}`)
    const d = await r.json() as { files?: { name: string; time: number }[] }
    setAgentCaptures(d.files ?? [])
  }, [])

  const connectSSE = useCallback((sid: string, isAgent = false, fromIndex = 0) => {
    if (evtSourceRef.current) evtSourceRef.current.close()
    const from = fromIndex > 0 ? `?from=${fromIndex}` : ''
    const url = isAgent ? `/api/autospin/agent/stream/${sid}${from}` : `/api/autospin/stream/${sid}`
    const es = new EventSource(url)
    es.onmessage = (e) => {
      const { line } = JSON.parse(e.data) as { line: string }
      if (isAgent) setAgentLogs(prev => [...prev.slice(-500), line])
      else setLogs(prev => [...prev.slice(-500), line])
    }
    es.onerror = () => es.close()
    evtSourceRef.current = es
  }, [])

  const handleStart = async () => {
    setStartError(''); setLogs([])
    const r = await fetch('/api/autospin/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const d = await r.json() as { ok: boolean; sessionId?: string; message?: string }
    if (!d.ok) { setStartError(d.message ?? '啟動失敗'); return }
    setRunning(true)
    setSessionId(d.sessionId!)
    connectSSE(d.sessionId!)
    captureTimerRef.current = setInterval(fetchCaptures, 5000)
  }

  const handleStop = async () => {
    await fetch('/api/autospin/stop', { method: 'POST' })
    setRunning(false)
    if (captureTimerRef.current) { clearInterval(captureTimerRef.current); captureTimerRef.current = null }
    if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null }
  }

  const handleStartLocal = async () => {
    setStartError(''); setAgentLogs([]); setAgentCaptures([])
    // Clear old session first
    await fetch('/api/autospin/agent/stop-all', { method: 'POST' })
    setAgentRunning(false); setAgentSessionId(null)
    if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null }
    // In dev mode Vite runs on :5173 but the API is on :3000
    const apiPort = window.location.port === '5173' ? '3000' : window.location.port
    const serverUrl = `${window.location.protocol}//${window.location.hostname}${apiPort ? ':' + apiPort : ''}`
    const label = getGlobalUserLabel()
    const uri = `toppath-agent://start?server=${encodeURIComponent(serverUrl)}&user=${encodeURIComponent(label)}`
    window.location.href = uri
    // Poll for agent connection (90s timeout to accommodate slow Terminal launch on Mac)
    const timer = setInterval(async () => {
      const r = await fetch('/api/autospin/agent/status')
      const d = await r.json() as { running: boolean; sessionId: string | null }
      if (d.running && d.sessionId) {
        agentSessionIdRef.current = d.sessionId
        setAgentRunning(true)
        setAgentSessionId(d.sessionId)
        connectSSE(d.sessionId, true)
        captureTimerRef.current = setInterval(() => fetchAgentCaptures(d.sessionId!), 5000)
        clearInterval(timer)
      }
    }, 2000)
    setTimeout(() => clearInterval(timer), 90000) // stop polling after 90s
  }

  const handleStopLocal = async () => {
    setAgentLogs(prev => [...prev, '[系統] 正在停止 Agent...'])
    // First get/connect SSE so we can see the stop feedback (handles "未連線" case)
    const ar = await fetch('/api/autospin/agent/status')
    const ad = await ar.json() as { running: boolean; sessionId: string | null }
    if (ad.sessionId && ad.sessionId !== agentSessionIdRef.current) {
      agentSessionIdRef.current = ad.sessionId
      setAgentSessionId(ad.sessionId)
      // Skip log replay — only want new stop feedback messages, not old logs
      connectSSE(ad.sessionId, true, Number.MAX_SAFE_INTEGER)
    }
    await fetch('/api/autospin/agent/stop-all', { method: 'POST' })
    setAgentPaused(false)
    if (captureTimerRef.current) { clearInterval(captureTimerRef.current); captureTimerRef.current = null }
    // Keep SSE open so agent's "[Agent] 已停止" message comes through.
    // Auto-cleanup after 10 seconds.
    setTimeout(() => {
      setAgentRunning(false)
      agentSessionIdRef.current = null
      setAgentSessionId(null)
      if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null }
    }, 10000)
  }

  const [agentPaused, setAgentPaused] = useState(false)

  const handlePause = async () => {
    if (!agentSessionId) return
    await fetch(`/api/autospin/agent/${agentSessionId}/pause`, { method: 'POST' })
    setAgentPaused(true)
  }

  const handleResume = async () => {
    if (!agentSessionId) return
    await fetch(`/api/autospin/agent/${agentSessionId}/resume`, { method: 'POST' })
    setAgentPaused(false)
  }

  const handleSetLiveInterval = async (val: number) => {
    if (!agentSessionId) return
    setLiveIntervalSaving(true)
    try {
      await fetch(`/api/autospin/agent/${agentSessionId}/spin-interval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: val }),
      })
    } finally {
      setLiveIntervalSaving(false)
    }
  }

  // Auto-scroll logs
  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
  }, [logs])

  useEffect(() => {
    fetchConfigs(); fetchTemplates(); fetchStatus(); fetchBetRandom()
    // Periodically sync agent status — catches Mac agent connections that miss the initial polling window
    const statusTimer = setInterval(fetchStatus, 10000)
    return () => {
      clearInterval(statusTimer)
      if (evtSourceRef.current) evtSourceRef.current.close()
      if (captureTimerRef.current) clearInterval(captureTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const poll = () => {
      fetch('/api/machine-test/osm-jackpot')
        .then(r => r.json())
        .then((d: { jackpots?: JackpotEntry[] }) => setJackpots(d.jackpots ?? []))
        .catch(() => {})
    }
    poll()
    const t = setInterval(poll, 10000)
    return () => clearInterval(t)
  }, [])

  // ─── Render ───────────────────────────────────────────────────────────────

  const tabStyle = (t: string) => ({
    padding: '6px 16px', border: 'none', borderBottom: `2px solid ${tab === t ? '#2563eb' : 'transparent'}`,
    background: 'none', fontWeight: tab === t ? 700 : 400, color: tab === t ? '#2563eb' : '#6b7280',
    cursor: 'pointer', fontSize: 13,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>

      {/* Account warning */}
      {!userLabel && (
        <div style={{ padding: '8px 12px', background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>
          ⚠️ 請先在右上角選擇帳號，機台設定將會個人化儲存
        </div>
      )}
      {userLabel && (
        <div style={{ padding: '6px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, marginBottom: 10, fontSize: 12, color: '#1d4ed8' }}>
          👤 目前帳號：{userLabel}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: 16 }}>
        <button style={tabStyle('configs')} onClick={() => setTab('configs')}>⚙️ 機台設定</button>
        <button style={tabStyle('templates')} onClick={() => { setTab('templates'); fetchTemplates() }}>🖼 模板管理</button>
        <button style={tabStyle('betrandom')} onClick={() => { setTab('betrandom'); fetchBetRandom() }}>🎲 隨機下注</button>
        <button style={tabStyle('history')} onClick={() => { setTab('history'); fetchHistory() }}>📊 歷史戰績</button>
        <button style={tabStyle('reconcile')} onClick={() => { setTab('reconcile'); fetchRcConfig(); fetchRcReports() }}>🔍 後台對帳</button>
        <button style={tabStyle('run')} onClick={() => { setTab('run'); fetchCaptures() }}>▶️ 執行監控</button>
      </div>

      {/* ── Configs tab ─────────────────────────────────────────────────────── */}
      {tab === 'configs' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => { setForm(EMPTY_CONFIG); setEditingType(null); setConfigMsg(''); setShowForm(true) }}
              style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              + 新增機台
            </button>
          </div>

          {configs.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>尚未設定任何機台。請點「+ 新增機台」。</p>}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                {['機台類型', 'Game Title Code', '模板類型', 'RTMP', '錄影', '模板偵測', '啟用', '操作'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {configs.map(c => (
                <tr key={c.machineType} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '7px 10px', fontWeight: 600 }}>{c.machineType}</td>
                  <td style={{ padding: '7px 10px', color: '#6b7280', fontSize: 11 }}>{c.gameTitleCode || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#6b7280', fontSize: 11 }}>{c.templateType || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#6b7280', fontSize: 11 }}>{c.rtmpName || '—'}</td>
                  {[c.enableRecording, c.enableTemplateDetection, c.enabled].map((v, i) => (
                    <td key={i} style={{ padding: '7px 10px', textAlign: 'center' }}>
                      <span style={{ color: v ? '#16a34a' : '#9ca3af' }}>{v ? '✅' : '—'}</span>
                    </td>
                  ))}
                  <td style={{ padding: '7px 10px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => handleEditConfig(c)}
                        style={{ padding: '2px 8px', background: '#eff6ff', color: '#1d4ed8', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>編輯</button>
                      <button onClick={() => handleDeleteConfig(c.machineType)}
                        style={{ padding: '2px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>刪除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Add/Edit modal */}
          {showForm && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 560, maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{editingType ? `編輯：${editingType}` : '新增機台設定'}</div>

                {[
                  { key: 'machineType', label: '機台類型 *', placeholder: 'e.g. JJBXGRAND', disabled: !!editingType },
                  { key: 'gameUrl', label: 'Game URL', placeholder: 'https://...' },
                  { key: 'rtmpName', label: 'RTMP 名稱', placeholder: 'e.g. JJBXGRAND_MAIN' },
                  { key: 'rtmpUrl', label: 'RTMP URL', placeholder: 'rtmp://...' },
                  { key: 'gameTitleCode', label: 'Game Title Code', placeholder: 'e.g. 873-JJBXGRAND' },
                  { key: 'templateType', label: '模板類型', placeholder: 'e.g. JJBX' },
                  { key: 'errorTemplateType', label: '錯誤模板類型', placeholder: 'e.g. ERROR' },
                  { key: 'machineNo', label: 'Machine No.（SLS 日誌查詢用，如 6312745）', placeholder: 'e.g. 6312745' },
                  { key: 'notes', label: '備註', placeholder: '' },
                  { key: 'larkWebhook', label: 'Lark Webhook URL（推播通知，可留空）', placeholder: 'https://open.larksuite.com/open-apis/bot/v2/hook/...' },
                ].map(({ key, label, placeholder, disabled }) => (
                  <div key={key}>
                    <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 3 }}>{label}</label>
                    <input
                      value={(form as unknown as Record<string, string>)[key]}
                      onChange={e => setForm(f => ({ ...f, [key]: key === 'machineType' ? e.target.value.toUpperCase() : e.target.value }))}
                      placeholder={placeholder} disabled={disabled}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: disabled ? '#f9fafb' : '#fff' }}
                    />
                  </div>
                ))}

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {[
                    { key: 'enabled', label: '啟用' },
                    { key: 'enableRecording', label: '啟用錄影' },
                    { key: 'enableTemplateDetection', label: '啟用模板偵測' },
                    { key: 'betRandomEnabled', label: '隨機下注' },
                    { key: 'randomExitEnabled', label: '隨機離開' },
                  ].map(({ key, label }) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox" checked={(form as unknown as Record<string, boolean>)[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))} />
                      {label}
                    </label>
                  ))}
                </div>

                {/* ── 頻率 / 隨機離開參數 ─────────────────────────────────── */}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Spin 間隔（秒）</div>
                    <input type="number" min={0.1} max={60} step={0.1}
                      value={form.spinInterval}
                      onChange={e => setForm(f => ({ ...f, spinInterval: parseFloat(e.target.value) || 1.0 }))}
                      style={{ width: 90, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                  </div>
                  {form.randomExitEnabled && (<>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>離開機率（0~1）</div>
                      <input type="number" min={0.001} max={1} step={0.01}
                        value={form.randomExitChance}
                        onChange={e => setForm(f => ({ ...f, randomExitChance: parseFloat(e.target.value) || 0.02 }))}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>最少 Spin 次數</div>
                      <input type="number" min={1} step={1}
                        value={form.randomExitMinSpins}
                        onChange={e => setForm(f => ({ ...f, randomExitMinSpins: parseInt(e.target.value) || 50 }))}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                    </div>
                  </>)}
                </div>

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>低餘額閾值（0 = 不偵測）</div>
                  <input type="number" min={0} step={1}
                    value={form.lowBalanceThreshold}
                    onChange={e => setForm(f => ({ ...f, lowBalanceThreshold: parseFloat(e.target.value) || 0 }))}
                    style={{ width: 120, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                </div>
                </div>

                {configMsg && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>❌ {configMsg}</p>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button onClick={() => { setShowForm(false); setConfigMsg('') }}
                    style={{ padding: '6px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer' }}>取消</button>
                  <button onClick={handleSaveConfig}
                    style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>儲存</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Templates tab ───────────────────────────────────────────────────── */}
      {tab === 'templates' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input ref={fileInputRef} type="file" accept=".png,.jpg,.jpeg,.bmp" onChange={handleUploadTemplate}
              style={{ display: 'none' }} id="tpl-upload" />
            <label htmlFor="tpl-upload"
              style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              {uploading ? '上傳中...' : '+ 上傳模板圖片'}
            </label>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>支援 .png / .jpg / .bmp，檔名即為模板名稱</span>
          </div>

          {templates.length === 0
            ? <p style={{ color: '#9ca3af', fontSize: 13 }}>templates/ 資料夾中尚無圖片</p>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {templates.map(t => (
                  <div key={t.name} style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', width: 140, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                    <div
                      onClick={() => setLightbox(`/api/autospin/template-img/${encodeURIComponent(t.name)}`)}
                      style={{ cursor: 'zoom-in', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 100, overflow: 'hidden' }}
                    >
                      <img
                        src={`/api/autospin/template-img/${encodeURIComponent(t.name)}`}
                        alt={t.name}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    </div>
                    <div style={{ padding: '6px 8px', borderTop: '1px solid #f1f5f9' }}>
                      <div style={{ fontSize: 10, color: '#374151', wordBreak: 'break-all', marginBottom: 4 }}>{t.name}</div>
                      <button onClick={() => handleDeleteTemplate(t.name)}
                        style={{ width: '100%', padding: '2px 0', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>刪除</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        </div>
      )}

      {/* ── Bet Random tab ──────────────────────────────────────────────────── */}
      {tab === 'betrandom' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              設定各機台的隨機下注 XPath，Agent 執行時會隨機點擊其中一個按鈕
            </span>
            <button onClick={() => { setBrEditKey(null); setBrFormKey(''); setBrFormSelectors(['']); setBetRandomMsg(''); setBrShowForm(true) }}
              style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              + 新增機台
            </button>
          </div>

          {Object.keys(betRandomData).length === 0
            ? <p style={{ color: '#9ca3af', fontSize: 13 }}>尚無設定。點「+ 新增機台」加入 Game Title Code 與對應的 XPath。</p>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Game Title Code</th>
                    <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>XPath 數量</th>
                    <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(betRandomData).map(([key, selectors]) => (
                    <tr key={key} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '7px 10px', fontWeight: 600, fontFamily: 'monospace', fontSize: 11 }}>{key}</td>
                      <td style={{ padding: '7px 10px', color: '#6b7280' }}>{selectors.length} 個</td>
                      <td style={{ padding: '7px 10px' }}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => openBrEdit(key)}
                            style={{ padding: '2px 8px', background: '#eff6ff', color: '#1d4ed8', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>編輯</button>
                          <button onClick={() => handleDeleteBrEntry(key)}
                            style={{ padding: '2px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>刪除</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }

          {/* Add/Edit modal */}
          {brShowForm && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 600, maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{brEditKey ? `編輯：${brEditKey}` : '新增隨機下注設定'}</div>

                <div>
                  <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 3 }}>Game Title Code *</label>
                  <input value={brFormKey} disabled={!!brEditKey}
                    onChange={e => setBrFormKey(e.target.value)}
                    placeholder="e.g. 873-TIANCIJINLONG-0017"
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: brEditKey ? '#f9fafb' : '#fff' }} />
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <label style={{ fontSize: 12, color: '#374151' }}>XPath 列表（每行一個）</label>
                    <button type="button" onClick={() => setBrFormSelectors(s => [...s, ''])}
                      style={{ padding: '2px 10px', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                      + 新增行
                    </button>
                  </div>
                  {brFormSelectors.map((sel, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                      <input value={sel}
                        onChange={e => setBrFormSelectors(s => s.map((x, i) => i === idx ? e.target.value : x))}
                        placeholder="//div[@class='row2']//div[contains(@class,'btn_bet')]"
                        style={{ flex: 1, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontFamily: 'monospace' }} />
                      <button type="button" onClick={() => setBrFormSelectors(s => s.filter((_, i) => i !== idx))}
                        disabled={brFormSelectors.length <= 1}
                        style={{ padding: '4px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>✕</button>
                    </div>
                  ))}
                </div>

                {betRandomMsg && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>❌ {betRandomMsg}</p>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button onClick={() => { setBrShowForm(false); setBetRandomMsg('') }}
                    style={{ padding: '6px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer' }}>取消</button>
                  <button onClick={handleSaveBrEntry}
                    style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>儲存</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Reconcile tab ───────────────────────────────────────────────────── */}
      {tab === 'reconcile' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>

          {/* Auth Config */}
          <details open>
            <summary style={{ fontWeight: 700, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>⚙️ 後台 API 設定</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 4px' }}>
              {[
                { key: 'base_url', label: 'Base URL', placeholder: 'https://backendservertest.osmslot.org' },
                { key: 'origin', label: 'Origin', placeholder: 'https://qat-cp.osmslot.org' },
                { key: 'token', label: 'Token（直接填入可跳過登入）', placeholder: '0000873_1-...' },
                { key: 'channelId', label: 'Channel ID', placeholder: '873' },
                { key: 'playerstudioid', label: 'Player Studio ID', placeholder: 'cp,wf,tbr,...' },
                { key: 'login_username', label: '登入帳號（自動登入用）', placeholder: 'admin' },
                { key: 'login_password', label: '登入密碼', placeholder: '' },
              ].map(({ key, label, placeholder }) => (
                <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label style={{ fontSize: 11, color: '#6b7280', minWidth: 200, textAlign: 'right' }}>{label}</label>
                  <input value={rcConfig[key] ?? ''} onChange={e => setRcConfig(c => ({ ...c, [key]: e.target.value }))}
                    placeholder={placeholder} type={key === 'login_password' ? 'password' : 'text'}
                    style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={saveRcConfig} style={{ padding: '5px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>儲存設定</button>
                <button onClick={testRcConnection} style={{ padding: '5px 14px', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>測試連線</button>
                {rcConfigMsg && <span style={{ fontSize: 12, color: rcConfigMsg.startsWith('✅') ? '#16a34a' : '#dc2626', alignSelf: 'center' }}>{rcConfigMsg}</span>}
              </div>
            </div>
          </details>

          {/* Run Reconciliation */}
          <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>▶ 執行對帳</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {[
                { label: '開始時間', val: rcRangeStart, set: setRcRangeStart, ph: '2026-04-06 00:00:00' },
                { label: '結束時間', val: rcRangeEnd, set: setRcRangeEnd, ph: '2026-04-06 23:59:59' },
                { label: '機台類型（留空=全部）', val: rcMachineType, set: setRcMachineType, ph: 'JJBXGRAND' },
                { label: 'Player ID（留空=全部）', val: rcPlayerId, set: setRcPlayerId, ph: '' },
              ].map(({ label, val, set, ph }) => (
                <div key={label}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>{label}</div>
                  <input value={val} onChange={e => set(e.target.value)} placeholder={ph}
                    style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, width: 180 }} />
                </div>
              ))}
              <button onClick={runReconcile} disabled={rcRunning}
                style={{ padding: '7px 20px', background: rcRunning ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: rcRunning ? 'default' : 'pointer' }}>
                {rcRunning ? '對帳中...' : '執行對帳'}
              </button>
            </div>
          </div>

          {/* Latest result */}
          {rcResult && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>📋 對帳結果</div>
              <div style={{ fontSize: 12, color: '#374151', marginBottom: 10, padding: '6px 10px', background: '#f1f5f9', borderRadius: 6 }}>{rcResult.summary}</div>

              {rcResult.backendAnomalies.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#d97706', marginBottom: 4 }}>⚠️ 後台異常 ({rcResult.backendAnomalies.length} 筆)</div>
                  {rcResult.backendAnomalies.map((a, i) => (
                    <div key={i} style={{ fontSize: 11, color: '#92400e', padding: '2px 8px', background: '#fef3c7', borderRadius: 4, marginBottom: 2 }}>
                      {a.note} | uid={a.uid} time={a.time} bet={a.bet} win={a.win}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>前端紀錄比對 ({rcResult.details.length} 筆)</div>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead><tr style={{ background: '#f9fafb' }}>
                    {['狀態', 'UID', '時間', 'Bet', 'Win', '備註'].map(h => <th key={h} style={{ padding: '5px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {rcResult.details.map((d, i) => (
                      <tr key={i} style={{ background: d.status === 'MISSING' ? '#fef2f2' : 'transparent', borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '4px 8px' }}>
                          <span style={{ padding: '1px 6px', borderRadius: 4, background: d.status === 'MATCH' ? '#dcfce7' : '#fee2e2', color: d.status === 'MATCH' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{d.status}</span>
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 10 }}>{d.uid}</td>
                        <td style={{ padding: '4px 8px', color: '#6b7280' }}>{d.time}</td>
                        <td style={{ padding: '4px 8px' }}>{d.bet}</td>
                        <td style={{ padding: '4px 8px' }}>{d.win}</td>
                        <td style={{ padding: '4px 8px', color: '#6b7280' }}>{d.note || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* History of reports */}
          {rcReports.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>📜 歷史對帳紀錄</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead><tr style={{ background: '#f9fafb' }}>
                  {['時間', '範圍', '機台', '前端', '後台', '匹配', '未匹配', '異常'].map(h => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {rcReports.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6', background: r.unmatchedCount > 0 ? '#fef2f2' : 'transparent' }}>
                      <td style={{ padding: '5px 8px', color: '#6b7280' }}>{new Date(r.runAt).toLocaleString('zh-TW')}</td>
                      <td style={{ padding: '5px 8px', fontSize: 10 }}>{r.rangeStart.slice(0, 16)} ~ {r.rangeEnd.slice(0, 16)}</td>
                      <td style={{ padding: '5px 8px' }}>{r.machineType || '全部'}</td>
                      <td style={{ padding: '5px 8px' }}>{r.frontCount}</td>
                      <td style={{ padding: '5px 8px' }}>{r.backendCount}</td>
                      <td style={{ padding: '5px 8px', color: '#16a34a', fontWeight: 600 }}>{r.matchedCount}</td>
                      <td style={{ padding: '5px 8px', color: r.unmatchedCount > 0 ? '#dc2626' : '#374151', fontWeight: r.unmatchedCount > 0 ? 700 : 400 }}>{r.unmatchedCount}</td>
                      <td style={{ padding: '5px 8px', color: r.anomalyCount > 0 ? '#d97706' : '#374151' }}>{r.anomalyCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={historyFilter} onChange={e => setHistoryFilter(e.target.value)}
              placeholder="篩選機台類型（留空顯示全部）"
              style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, width: 220 }} />
            <button onClick={fetchHistory}
              style={{ padding: '5px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
              查詢
            </button>
            <button onClick={handleClearHistory}
              style={{ padding: '5px 14px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
              清除記錄
            </button>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>共 {historyRows.length} 筆</span>
          </div>

          {/* Anomaly summary */}
          {historyRows.some(r => r.isAnomaly) && (
            <div style={{ padding: '8px 12px', background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 6, fontSize: 12 }}>
              ⚠️ 偵測到 {historyRows.filter(r => r.isAnomaly).length} 筆異常（餘額相比開局下降超過 30%）
            </div>
          )}

          {historyRows.length === 0
            ? <p style={{ color: '#9ca3af', fontSize: 13 }}>尚無戰績記錄。Agent 執行中會每 20 次 Spin 記錄一次餘額快照。</p>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                    {['時間', '機台', 'Spin#', '餘額', '事件', '備註'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6', background: r.isAnomaly ? '#fef3c7' : 'transparent' }}>
                      <td style={{ padding: '6px 10px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {new Date(r.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.machineType}</td>
                      <td style={{ padding: '6px 10px', color: '#6b7280' }}>{r.spinCount}</td>
                      <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: r.balance !== null && r.balance < 100 ? '#dc2626' : '#374151' }}>
                        {r.balance !== null ? r.balance.toFixed(2) : '—'}
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11,
                          background: r.event === 'bonus' ? '#dcfce7' : r.event === 'low_balance' ? '#fef3c7' : r.event === 'error' ? '#fee2e2' : '#f3f4f6',
                          color: r.event === 'bonus' ? '#16a34a' : r.event === 'low_balance' ? '#d97706' : r.event === 'error' ? '#dc2626' : '#6b7280',
                        }}>
                          {EVENT_LABEL[r.event] ?? r.event}
                        </span>
                        {r.isAnomaly ? ' ⚠️' : ''}
                      </td>
                      <td style={{ padding: '6px 10px', color: '#6b7280' }}>{r.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </div>
      )}

      {/* ── Lightbox ─────────────────────────────────────────────────────────── */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
        >
          <img src={lightbox} alt="preview"
            style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
          <div style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 28, fontWeight: 300, cursor: 'pointer', lineHeight: 1 }}>×</div>
          <div style={{ position: 'absolute', bottom: 20, color: '#94a3b8', fontSize: 12 }}>
            {decodeURIComponent(lightbox.split('/').pop() ?? '')}
          </div>
        </div>
      )}

      {/* ── Run tab ─────────────────────────────────────────────────────────── */}
      {tab === 'run' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'hidden' }}>

          {/* OSMWatcher Jackpot Banner */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
              borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: jackpots.length > 0 ? 'pointer' : 'default',
              background: jackpots.length > 0 ? '#f0fdf4' : '#f8fafc',
              border: `1px solid ${jackpots.length > 0 ? '#86efac' : '#e2e8f0'}`,
              color: jackpots.length > 0 ? '#15803d' : '#94a3b8',
              userSelect: 'none',
            }}
            onClick={() => jackpots.length > 0 && setJackpotPanelOpen(v => !v)}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: jackpots.length > 0 ? '#22c55e' : '#cbd5e1', flexShrink: 0 }} />
            {jackpots.length > 0
              ? `✅ OSMWatcher 已連線（${jackpots.filter(j => j.grand != null || j.fortunate != null).length} 個遊戲獎池）`
              : '⚪ OSMWatcher 未連線 — 獎池資料尚未接收'}
            {jackpots.length > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>{jackpotPanelOpen ? '▲ 收合' : '▼ 展開獎池'}</span>
            )}
          </div>

          {jackpotPanelOpen && jackpots.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>即時獎池 — 每 10 秒自動更新（只顯示 Grand / Fortune）</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
                {jackpots.filter(j => j.grand != null || j.fortunate != null).map(j => (
                  <div key={j.gtype} style={{
                    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6,
                    padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4,
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{j.gameName}</div>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                      {j.grand != null && (
                        <span style={{ color: '#b45309', fontWeight: 700 }}>
                          Grand: {j.grand.toLocaleString()}
                        </span>
                      )}
                      {j.fortunate != null && (
                        <span style={{ color: '#7c3aed', fontWeight: 700 }}>
                          Fortune: {j.fortunate.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Mode toggle */}
          <div style={{ display: 'flex', gap: 0, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', alignSelf: 'flex-start' }}>
            {(['server', 'local'] as const).map(m => (
              <button key={m} onClick={() => setRunMode(m)}
                style={{ padding: '7px 20px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: runMode === m ? '#2563eb' : '#f9fafb', color: runMode === m ? '#fff' : '#374151' }}>
                {m === 'server' ? '🖥 伺服器端' : '💻 本機端（Agent）'}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0, overflow: 'hidden' }}>

            {/* Left: controls + log */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>

              {runMode === 'server' ? (
                /* ── Server mode controls ── */
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button onClick={handleStart} disabled={running}
                      style={{ padding: '8px 20px', background: running ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: running ? 'default' : 'pointer' }}>
                      ▶ 啟動 AutoSpin
                    </button>
                    <button onClick={handleStop} disabled={!running}
                      style={{ padding: '8px 20px', background: !running ? '#9ca3af' : '#dc2626', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: !running ? 'default' : 'pointer' }}>
                      ⏹ 停止
                    </button>
                    <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 12, background: running ? '#dcfce7' : '#f1f5f9', color: running ? '#16a34a' : '#6b7280', fontWeight: 600 }}>
                      {running ? '🟢 執行中' : '⚪ 未執行'}
                    </span>
                    {startError && <span style={{ color: '#dc2626', fontSize: 12 }}>❌ {startError}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    執行中的機台：{configs.filter(c => c.enabled).length} 台（已啟用）
                  </div>
                </>
              ) : (
                /* ── Local agent mode controls ── */
                <>
                  {/* Status + controls row */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button onClick={handleStartLocal} disabled={agentRunning}
                      style={{ padding: '8px 20px', background: agentRunning ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: agentRunning ? 'default' : 'pointer' }}>
                      ▶ 啟動（本機）
                    </button>
                    <button onClick={handleStopLocal}
                      style={{ padding: '8px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                      ⏹ 停止
                    </button>
                    {agentRunning && !agentPaused && (
                      <button onClick={handlePause}
                        style={{ padding: '8px 16px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                        ⏸ 暫停
                      </button>
                    )}
                    {agentRunning && agentPaused && (
                      <button onClick={handleResume}
                        style={{ padding: '8px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                        ▶ 繼續
                      </button>
                    )}
                    <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 12, background: agentPaused ? '#fef3c7' : agentRunning ? '#dcfce7' : '#f1f5f9', color: agentPaused ? '#d97706' : agentRunning ? '#16a34a' : '#6b7280', fontWeight: 600 }}>
                      {agentPaused ? '⏸ 已暫停' : agentRunning ? '🟢 Agent 執行中' : '⚪ 未連線'}
                    </span>
                    {agentSessionId && <span style={{ fontSize: 11, color: '#2563eb' }}>Session: {agentSessionId.slice(0, 8)}…</span>}
                  </div>

                  {/* Live Spin Interval */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>⏱ Spin 間隔</span>
                    <input
                      type="range" min={0.1} max={10} step={0.1}
                      value={liveSpinInterval}
                      onChange={e => setLiveSpinInterval(parseFloat(e.target.value))}
                      style={{ width: 140 }}
                      disabled={!agentRunning}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 36 }}>{liveSpinInterval.toFixed(1)}s</span>
                    <button
                      type="button"
                      disabled={!agentRunning || liveIntervalSaving}
                      onClick={() => handleSetLiveInterval(liveSpinInterval)}
                      style={{ padding: '3px 12px', fontSize: 12, borderRadius: 6, border: '1px solid #2563eb', background: '#eff6ff', color: '#2563eb', cursor: agentRunning ? 'pointer' : 'default' }}
                    >
                      {liveIntervalSaving ? '...' : '套用'}
                    </button>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>覆蓋所有機台間隔，Agent 3秒內生效</span>
                  </div>
                </>
              )}

              {/* Log box */}
              <div ref={logBoxRef}
                style={{ flex: 1, background: '#0f172a', borderRadius: 8, padding: '10px 14px', overflowY: 'auto', minHeight: 200, fontFamily: 'monospace', fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
                {(runMode === 'server' ? logs : agentLogs).length === 0
                  ? <span style={{ color: '#475569' }}>等待啟動...</span>
                  : (runMode === 'server' ? logs : agentLogs).map((l, i) => {
                    const color = l.includes('[stderr]') || l.includes('ERROR') ? '#f87171'
                      : l.includes('WARNING') ? '#fbbf24'
                      : l.includes('[系統]') || l.includes('[Agent]') ? '#38bdf8'
                      : '#94a3b8'
                    return <div key={i} style={{ color }}>{l}</div>
                  })
                }
              </div>

              {/* Windows + macOS install guide — shown in local agent mode only */}
              {runMode === 'local' && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {/* Windows box */}
                  <div style={{ flex: '1 1 260px', border: '1px solid #dbeafe', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ background: '#eff6ff', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 16 }}>🪟</span>
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#1d4ed8' }}>Windows Agent</span>
                    </div>
                    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ background: '#2563eb', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>1</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, color: '#374151', marginBottom: 4 }}>下載安裝包並執行（需安裝 Python 3）</div>
                          <a href="/api/autospin/agent/download/install.bat" download
                            style={{ display: 'inline-block', padding: '5px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 5, fontWeight: 600, fontSize: 12, textDecoration: 'none' }}>
                            📥 下載 install.bat
                          </a>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ background: '#2563eb', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>2</span>
                        <div style={{ fontSize: 12, color: '#374151' }}>安裝完成後，點上方「▶ 啟動（本機）」即可連線</div>
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', borderTop: '1px solid #e5e7eb', paddingTop: 8, marginTop: 2 }}>
                        安裝內容：Python venv、Playwright Chromium、自動 UAC 提權
                      </div>
                    </div>
                  </div>

                  {/* macOS box */}
                  <div style={{ flex: '1 1 260px', border: '1px solid #d1fae5', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ background: '#ecfdf5', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 16 }}>🍎</span>
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#065f46' }}>macOS Agent</span>
                    </div>
                    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ background: '#059669', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>1</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, color: '#374151', marginBottom: 4 }}>下載安裝腳本，Terminal 執行（需 Python 3）</div>
                          <a href="/api/autospin/agent/download/install-mac.sh" download
                            style={{ display: 'inline-block', padding: '5px 12px', background: '#059669', color: '#fff', border: 'none', borderRadius: 5, fontWeight: 600, fontSize: 12, textDecoration: 'none' }}>
                            📥 下載 install-mac.sh
                          </a>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ background: '#059669', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>2</span>
                        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
                          Terminal 執行：<br />
                          <code style={{ background: '#f0fdf4', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>bash install-toppath-agent-mac.sh</code>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ background: '#059669', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>3</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, color: '#374151', marginBottom: 4 }}>安裝完成後，複製啟動指令貼到 Terminal</div>
                          <button onClick={() => {
                            const apiPort = window.location.port === '5173' ? '3000' : window.location.port
                            const serverUrl = `${window.location.protocol}//${window.location.hostname}${apiPort ? ':' + apiPort : ''}`
                            const label = getGlobalUserLabel()
                            const uri = `toppath-agent://start?server=${encodeURIComponent(serverUrl)}&user=${encodeURIComponent(label)}`
                            const cmd = `~/toppath-agent/launch-agent-mac.sh "${uri}"`
                            if (navigator.clipboard) {
                              navigator.clipboard.writeText(cmd)
                                .then(() => alert('已複製！貼到 Mac Terminal 執行即可。'))
                                .catch(() => prompt('複製以下指令到 Mac Terminal：', cmd))
                            } else {
                              prompt('複製以下指令到 Mac Terminal：', cmd)
                            }
                          }}
                            style={{ padding: '5px 12px', background: '#059669', color: '#fff', border: 'none', borderRadius: 5, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                            📋 複製啟動指令
                          </button>
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', borderTop: '1px solid #d1fae5', paddingTop: 8, marginTop: 2 }}>
                        安裝內容：Python venv、Playwright Chromium、launchd 服務、toppath-agent:// URL scheme
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right: screenshots + SLS errors */}
            <div style={{ flex: '0 0 260px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
              {/* SLS Error Logs panel */}
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: slsEntries.some(e => e.level === 'ERROR') ? '#fef2f2' : '#f8fafc', cursor: 'pointer' }}
                  onClick={() => setSlsPanelOpen(v => !v)}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: slsEntries.length > 0 ? (slsEntries.some(e => e.level === 'ERROR') ? '#ef4444' : '#f59e0b') : '#cbd5e1', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', flex: 1 }}>
                    SLS 錯誤日誌 {slsEntries.length > 0 ? `(${slsEntries.length})` : ''}
                  </span>
                  <span style={{ fontSize: 10, color: '#9ca3af' }}>{slsPanelOpen ? '▲' : '▼'}</span>
                </div>
                {slsPanelOpen && (
                  <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: '#fff' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select value={slsMachineNo} onChange={e => { setSlsMachineNo(e.target.value); setSlsEntries([]) }}
                        style={{ flex: 1, fontSize: 11, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 5 }}>
                        <option value=''>— 選擇機台 —</option>
                        {configs.filter(c => c.machineNo).map(c => (
                          <option key={c.machineType} value={c.machineNo}>{c.machineType} ({c.machineNo})</option>
                        ))}
                      </select>
                      <button onClick={() => fetchSlsErrors(slsMachineNo)} disabled={!slsMachineNo || slsLoading}
                        style={{ fontSize: 11, padding: '4px 8px', background: slsMachineNo ? '#2563eb' : '#e5e7eb', color: slsMachineNo ? '#fff' : '#9ca3af', border: 'none', borderRadius: 5, cursor: slsMachineNo ? 'pointer' : 'default' }}>
                        {slsLoading ? '...' : '🔍'}
                      </button>
                    </div>
                    {slsError && <div style={{ fontSize: 11, color: '#ef4444' }}>{slsError}</div>}
                    {slsEntries.length === 0 && !slsLoading && !slsError && slsMachineNo && (
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>近 24 小時無錯誤記錄</div>
                    )}
                    {slsEntries.map((e, i) => (
                      <div key={i} style={{ fontSize: 10, borderLeft: `3px solid ${e.level === 'ERROR' ? '#ef4444' : e.level === 'WARN' || e.level === 'WARNING' ? '#f59e0b' : '#6b7280'}`, paddingLeft: 6, color: '#374151' }}>
                        <div style={{ color: '#6b7280', marginBottom: 2 }}>{e.timeStr} · <span style={{ color: e.level === 'ERROR' ? '#ef4444' : '#f59e0b', fontWeight: 700 }}>{e.level}</span></div>
                        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#1e293b' }}>{e.content.slice(0, 160)}{e.content.length > 160 ? '…' : ''}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>截圖監控</span>
                <button onClick={fetchCaptures} style={{ fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer' }}>🔄 重新整理</button>
              </div>
              {(runMode === 'server' ? captures : agentCaptures).length === 0
                ? <p style={{ color: '#9ca3af', fontSize: 12 }}>尚無截圖</p>
                : (runMode === 'server' ? captures : agentCaptures).map(f => (
                  <div key={f.name} style={{ border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
                    <img
                      src={runMode === 'server'
                        ? `/api/autospin/captures/${encodeURIComponent(f.name)}`
                        : `/api/autospin/agent/captures/${encodeURIComponent(f.name)}`}
                      alt={f.name}
                      style={{ width: '100%', display: 'block', objectFit: 'cover', maxHeight: 140 }}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    <div style={{ padding: '4px 8px', fontSize: 10, color: '#9ca3af', background: '#f9fafb' }}>
                      {f.name}
                      {'dir' in f && <span style={{ float: 'right' }}>{(f as unknown as { dir: string }).dir}</span>}
                    </div>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

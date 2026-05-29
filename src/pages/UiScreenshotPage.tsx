import { useCallback, useEffect, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalAgentInfo {
  agentId: string
  hostname: string
  ownerName: string
  capabilities: string[]
  busy: boolean
  connectedAt: number
  lastSeenAt: number
  sessionId?: string | null
}

type TaskStatus = 'pending' | 'running' | 'ok' | 'popup' | 'err' | 'timeout' | 'skipped'
type RunStatus = 'pending' | 'running' | 'done' | 'stopped'

interface ScreenshotTask {
  id: string
  run_id: string
  gmid: string
  resolution: string
  status: TaskStatus
  server_path: string | null
  error_msg: string | null
  started_at: number | null
  finished_at: number | null
}

interface ScreenshotRun {
  id: string
  status: RunStatus
  wiki_url: string
  game_url_template: string
  gmids: string
  resolutions: string
  concurrency: number
  options: string
  agent_id: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  total_tasks?: number
  ok_count?: number
  popup_count?: number
  err_count?: number
}

interface SseTaskUpdate {
  type: 'task_update'
  runId: string
  taskId: string
  gmid: string
  resolution: string
  status: TaskStatus
  serverPath: string | null
  errorMsg: string | null
}

interface SseRunComplete {
  type: 'run_complete'
  runId: string
  ok_count?: number
  popup_count?: number
  err_count?: number
}

interface SseSnapshot {
  type: 'snapshot'
  run: ScreenshotRun
  tasks: ScreenshotTask[]
}

type SseEvent = SseTaskUpdate | SseRunComplete | SseSnapshot | { type: 'run_stopped'; runId: string }

// ─── Constants ────────────────────────────────────────────────────────────────

const RESOLUTIONS: { key: string; label: string; w: number; h: number; group: string }[] = [
  // Mobile Portrait
  { key: '375x667',  label: 'iPhone SE',    w: 375,  h: 667,  group: 'Mobile Portrait' },
  { key: '390x844',  label: 'iPhone 14',    w: 390,  h: 844,  group: 'Mobile Portrait' },
  { key: '412x915',  label: 'Android XL',  w: 412,  h: 915,  group: 'Mobile Portrait' },
  { key: '360x800',  label: 'Android M',   w: 360,  h: 800,  group: 'Mobile Portrait' },
  // Mobile Landscape
  { key: '667x375',  label: 'iPhone SE LS', w: 667,  h: 375,  group: 'Mobile Landscape' },
  { key: '844x390',  label: 'iPhone 14 LS', w: 844,  h: 390,  group: 'Mobile Landscape' },
  { key: '915x412',  label: 'Android LS',  w: 915,  h: 412,  group: 'Mobile Landscape' },
  { key: '800x360',  label: 'Andr M LS',   w: 800,  h: 360,  group: 'Mobile Landscape' },
  // Tablet
  { key: '768x1024', label: 'iPad Mini',   w: 768,  h: 1024, group: 'Tablet' },
  { key: '1024x768', label: 'iPad LS',     w: 1024, h: 768,  group: 'Tablet' },
  { key: '820x1180', label: 'iPad Air',    w: 820,  h: 1180, group: 'Tablet' },
]

const RESOLUTION_GROUPS = ['Mobile Portrait', 'Mobile Landscape', 'Tablet']

const DEFAULT_RESOLUTIONS = RESOLUTIONS.map(r => r.key)

const SETTINGS_KEY = 'toppath.uiScreenshot.settings'

interface Settings {
  wikiUrl: string
  gmidText: string
  gameUrlTemplate: string
  selectedResolutions: string[]
  dismissPopup: boolean
  waitForVideo: boolean
  headedMode: boolean
  screenshotDelaySeconds: number
  selectedAgentId: string
}

const DEFAULT_SETTINGS: Settings = {
  wikiUrl: '',
  gmidText: '',
  gameUrlTemplate: 'https://osm-h5-prod.osmslot.org/?token=ec8942c14e4b88ea2f223e7b2901058e-111716868&platform=pc&mode=live&language=en_us&studioid=cp&gameid={gmid}&lang=zh_cn&username=cposmtest3&device=mobile&isPwaClaimed=1',
  selectedResolutions: DEFAULT_RESOLUTIONS,
  dismissPopup: true,
  waitForVideo: true,
  headedMode: false,
  screenshotDelaySeconds: 5,
  selectedAgentId: '',
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) as Partial<Settings> }
  } catch { return { ...DEFAULT_SETTINGS } }
}

function saveSettings(s: Partial<Settings>) {
  try {
    const current = loadSettings()
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...s }))
  } catch { /* ignore */ }
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function taskBadgeClass(status: TaskStatus) {
  if (status === 'ok') return 'badge badge--ok'
  if (status === 'popup') return 'badge badge--warn'
  if (status === 'err' || status === 'timeout') return 'badge badge--error'
  if (status === 'running') return 'badge badge--blue'
  return 'badge'
}

function taskStatusLabel(status: TaskStatus) {
  const map: Record<TaskStatus, string> = {
    pending: '待執行', running: '執行中', ok: 'OK',
    popup: 'POPUP', err: 'ERR', timeout: 'TIMEOUT', skipped: 'SKIP',
  }
  return map[status] ?? status
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, color }: { label: string; value: string | number; sub: string; color?: string }) {
  return (
    <div className="section-card ui-ss-metric-card">
      <div className="ui-ss-metric-label">{label}</div>
      <div className="ui-ss-metric-value" style={color ? { color } : undefined}>{value}</div>
      <div className="ui-ss-metric-sub">{sub}</div>
    </div>
  )
}

function ResCheckbox({
  res, checked, onChange, disabled,
}: { res: typeof RESOLUTIONS[0]; checked: boolean; onChange: (k: string) => void; disabled: boolean }) {
  return (
    <label className={`ui-ss-res-item${checked ? ' checked' : ''}`} onClick={() => !disabled && onChange(res.key)}>
      <input type="checkbox" checked={checked} readOnly style={{ accentColor: '#3b82f6', cursor: 'pointer', flexShrink: 0 }} />
      <div>
        <div className="ui-ss-res-lbl">{res.label}</div>
        <div className="ui-ss-res-nm">{res.w}×{res.h}</div>
      </div>
    </label>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function UiScreenshotPage() {
  const init = loadSettings()

  const [wikiUrl, setWikiUrl] = useState(init.wikiUrl)
  const [gmidText, setGmidText] = useState(init.gmidText)
  const [gameUrlTemplate, setGameUrlTemplate] = useState(init.gameUrlTemplate)
  const [selectedResolutions, setSelectedResolutions] = useState<string[]>(init.selectedResolutions)
  const [dismissPopup, setDismissPopup] = useState(init.dismissPopup)
  const [waitForVideo, setWaitForVideo] = useState(init.waitForVideo)
  const [headedMode, setHeadedMode] = useState(init.headedMode)
  const [screenshotDelaySeconds, setScreenshotDelaySeconds] = useState(init.screenshotDelaySeconds)

  const [agents, setAgents] = useState<LocalAgentInfo[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState(init.selectedAgentId)
  const [agentError, setAgentError] = useState('')

  const [runId, setRunId] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null)
  const [tasks, setTasks] = useState<Map<string, ScreenshotTask>>(new Map())
  const [gmids, setGmids] = useState<string[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState('')
  const [writingBack, setWritingBack] = useState(false)
  const [writebackMsg, setWritebackMsg] = useState('')
  const [previewTask, setPreviewTask] = useState<ScreenshotTask | null>(null)
  const [fetchingGmids, setFetchingGmids] = useState(false)
  const [fetchGmidMsg, setFetchGmidMsg] = useState('')

  const [viewMode, setViewMode] = useState<'heatmap' | 'list'>('heatmap')

  const esRef = useRef<EventSource | null>(null)
  const logPanelRef = useRef<HTMLDivElement>(null)

  // ── Persist settings ────────────────────────────────────────────────────────

  useEffect(() => { saveSettings({ wikiUrl }) }, [wikiUrl])
  useEffect(() => { saveSettings({ gmidText }) }, [gmidText])
  useEffect(() => { saveSettings({ gameUrlTemplate }) }, [gameUrlTemplate])
  useEffect(() => { saveSettings({ selectedResolutions }) }, [selectedResolutions])
  useEffect(() => { saveSettings({ dismissPopup }) }, [dismissPopup])
  useEffect(() => { saveSettings({ waitForVideo }) }, [waitForVideo])
  useEffect(() => { saveSettings({ headedMode }) }, [headedMode])
  useEffect(() => { saveSettings({ screenshotDelaySeconds }) }, [screenshotDelaySeconds])
  useEffect(() => { saveSettings({ selectedAgentId }) }, [selectedAgentId])

  // ── Agents polling ──────────────────────────────────────────────────────────

  const refreshAgents = useCallback(() => {
    fetch('/api/ui-screenshot/agents')
      .then(r => r.json())
      .then((data: { ok: boolean; agents?: LocalAgentInfo[] }) => {
        if (!data.ok) return
        const list = data.agents ?? []
        setAgents(list)
        setAgentError('')
        setSelectedAgentId(cur => {
          if (cur && list.some(a => a.agentId === cur && !a.busy)) return cur
          return list.find(a => !a.busy)?.agentId ?? list[0]?.agentId ?? ''
        })
      })
      .catch(() => setAgentError('無法取得 Agent 狀態'))
  }, [])

  useEffect(() => {
    refreshAgents()
    const t = window.setInterval(refreshAgents, 6000)
    return () => window.clearInterval(t)
  }, [refreshAgents])

  // ── SSE connection ──────────────────────────────────────────────────────────

  const connectSse = useCallback((rid: string) => {
    esRef.current?.close()
    const es = new EventSource(`/api/ui-screenshot/events/${rid}`)
    esRef.current = es
    es.onmessage = ev => {
      try {
        const data = JSON.parse(ev.data) as SseEvent
        if (data.type === 'snapshot') {
          const snap = data as SseSnapshot
          setRunStatus(snap.run.status)
          setGmids(JSON.parse(snap.run.gmids) as string[])
          const m = new Map<string, ScreenshotTask>()
          snap.tasks.forEach(t => m.set(t.id, t))
          setTasks(m)
        } else if (data.type === 'task_update') {
          const u = data as SseTaskUpdate
          setTasks(prev => {
            const next = new Map(prev)
            const existing = [...next.values()].find(t => t.id === u.taskId)
            if (existing) {
              next.set(existing.id, {
                ...existing,
                status: u.status,
                server_path: u.serverPath,
                error_msg: u.errorMsg,
              })
            }
            return next
          })
          const msg = `[${u.gmid}] ${u.resolution} → ${u.status}${u.errorMsg ? ` (${u.errorMsg})` : ''}`
          setLogs(prev => [...prev.slice(-200), msg])
        } else if (data.type === 'run_complete') {
          setRunStatus('done')
          const c = data as SseRunComplete
          const msg = `✅ Run 完成｜OK:${c.ok_count ?? '?'} POPUP:${c.popup_count ?? '?'} ERR:${c.err_count ?? '?'}`
          setLogs(prev => [...prev, msg])
          es.close()
        } else if (data.type === 'run_stopped') {
          setRunStatus('stopped')
          setLogs(prev => [...prev, '⏹ Run 已停止'])
          es.close()
        }
      } catch { /* ignore */ }
    }
    es.onerror = () => {
      setLogs(prev => [...prev, '⚠️ SSE 連線中斷'])
    }
  }, [])

  // ── Auto-scroll logs (only when new entries arrive, not on mount) ───────────

  const prevLogLenRef = useRef(0)
  useEffect(() => {
    if (logs.length > prevLogLenRef.current && logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight
    }
    prevLogLenRef.current = logs.length
  }, [logs])

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  useEffect(() => () => { esRef.current?.close() }, [])

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function fetchGmidsFromLark() {
    if (!wikiUrl.trim()) { setFetchGmidMsg('請先填入 Lark Sheet URL'); return }
    setFetchingGmids(true)
    setFetchGmidMsg('')
    try {
      const r = await fetch('/api/ui-screenshot/fetch-gmids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: wikiUrl.trim() }),
      })
      const d = await r.json() as { ok: boolean; gmids?: string[]; message?: string }
      if (!d.ok) { setFetchGmidMsg(d.message ?? '讀取失敗'); return }
      const list = d.gmids ?? []
      setGmidText(list.join('\n'))
      setFetchGmidMsg(`成功讀取 ${list.length} 個 gmid`)
    } catch (e) {
      setFetchGmidMsg(String(e))
    }
    setFetchingGmids(false)
  }

  async function start() {
    setError('')
    if (!gameUrlTemplate.trim()) { setError('請填入遊戲 URL Template'); return }
    if (selectedResolutions.length === 0) { setError('請至少選擇一個解析度'); return }
    if (!selectedAgentId) { setError('請選擇一個可用的 Local Agent'); return }

    const agent = agents.find(a => a.agentId === selectedAgentId)
    if (!agent || agent.busy) { setError('選擇的 Agent 不存在或正在忙碌'); refreshAgents(); return }

    // Parse gmids from textarea (one per line, or comma/space separated)
    const parsedGmids = gmidText
      .split(/[\n,\s]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)

    if (parsedGmids.length === 0) { setError('請輸入至少一個 gmid'); return }

    setLogs([])
    setTasks(new Map())
    setWritebackMsg('')

    try {
      const body: Record<string, unknown> = {
        wikiUrl: wikiUrl.trim(),
        gameUrlTemplate: gameUrlTemplate.trim(),
        gmids: parsedGmids,
        resolutions: selectedResolutions,
        concurrency: 1,
        options: { dismissPopup, waitForVideo, headedMode, screenshotDelaySeconds },
        agentId: selectedAgentId,
      }
      const r = await fetch('/api/ui-screenshot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json() as { ok: boolean; runId?: string; totalTasks?: number; message?: string; gmids?: string[] }
      if (!d.ok) { setError(d.message ?? '啟動失敗'); return }
      const rid = d.runId!
      setRunId(rid)
      setRunStatus('running')
      if (d.gmids) setGmids(d.gmids)
      setLogs([`🚀 Run ${rid.slice(0, 8)} 啟動，共 ${d.totalTasks ?? '?'} 個任務`])
      connectSse(rid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function stop() {
    if (!runId) return
    await fetch(`/api/ui-screenshot/stop/${runId}`, { method: 'POST' }).catch(() => {})
    setRunStatus('stopped')
    setLogs(prev => [...prev, '⏹ 已送出停止指令'])
    esRef.current?.close()
  }

  async function writeback() {
    if (!runId) return
    setWritingBack(true)
    setWritebackMsg('')
    try {
      const r = await fetch(`/api/ui-screenshot/run/${runId}/writeback`, { method: 'POST' })
      const d = await r.json() as { ok: boolean; written?: number; total?: number; errors?: string[]; message?: string }
      if (d.ok) {
        const firstError = d.errors?.[0] ? `；${d.errors[0]}` : ''
        setWritebackMsg(`回寫完成：${d.written ?? 0}/${d.total ?? 0} 張${d.errors?.length ? `，${d.errors.length} 個錯誤${firstError}` : ''}`)
        const readableError = d.errors?.[0] ? `; ${d.errors[0]}` : ''
        setWritebackMsg(`Writeback done: ${d.written ?? 0}/${d.total ?? 0} images${d.errors?.length ? `, ${d.errors.length} errors${readableError}` : ''}`)
      } else {
        setWritebackMsg(d.message ?? '回寫失敗')
      }
    } catch { setWritebackMsg('回寫失敗') }
    setWritingBack(false)
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  const taskList = [...tasks.values()]
  const okCount = taskList.filter(t => t.status === 'ok').length
  const popupCount = taskList.filter(t => t.status === 'popup').length
  const errCount = taskList.filter(t => t.status === 'err' || t.status === 'timeout').length
  const doneCount = okCount + popupCount + errCount
  const totalCount = taskList.length
  const pctDone = totalCount > 0 ? (doneCount / totalCount) * 100 : 0

  const selectedAgent = agents.find(a => a.agentId === selectedAgentId)
  const readyCount = agents.filter(a => !a.busy).length
  const running = runStatus === 'running'

  // Build task index: gmid → resolution → task
  const taskIndex = new Map<string, Map<string, ScreenshotTask>>()
  for (const t of taskList) {
    if (!taskIndex.has(t.gmid)) taskIndex.set(t.gmid, new Map())
    taskIndex.get(t.gmid)!.set(t.resolution, t)
  }

  // Active resolutions (from current run or selected)
  const activeResolutions = taskList.length > 0
    ? [...new Set(taskList.map(t => t.resolution))]
    : selectedResolutions

  function toggleResolution(key: string) {
    if (running) return
    setSelectedResolutions(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    )
  }

  function selectGroup(group: string) {
    if (running) return
    const keys = RESOLUTIONS.filter(r => r.group === group).map(r => r.key)
    setSelectedResolutions(prev => {
      const existing = new Set(prev)
      const allIn = keys.every(k => existing.has(k))
      if (allIn) return prev.filter(k => !keys.includes(k))
      return [...new Set([...prev, ...keys])]
    })
  }

  function selectAll() {
    if (running) return
    setSelectedResolutions(RESOLUTIONS.map(r => r.key))
  }

  function clearAll() {
    if (running) return
    setSelectedResolutions([])
  }

  // ── Status color ─────────────────────────────────────────────────────────────
  const runStateColor = runStatus === 'running' ? '#60a5fa' : runStatus === 'done' ? '#34d399' : runStatus === 'stopped' ? '#fbbf24' : undefined

  return (
    <div className="ui-screenshot-page">
      {/* ── Page Header ── */}
      <div className="scripted-bet-head">
        <div>
          <h1 className="scripted-bet-title">UI 解析度截圖</h1>
          <p className="scripted-bet-sub">
            從 Lark Wiki 讀取 gmid 清單，批量對 H5 遊戲進行多解析度截圖，結果回寫至 Wiki TABLE。
          </p>
        </div>
        <div className="scripted-bet-actions">
          {running
            ? <button className="submit-btn submit-btn--sm submit-btn--stop" type="button" onClick={stop}>停止</button>
            : <button className="submit-btn submit-btn--sm" type="button" onClick={start}>開始截圖</button>
          }
        </div>
      </div>

      {/* ── Metrics ── */}
      <div className="ui-ss-metrics">
        <MetricCard label="Tasks" value={totalCount || '—'} sub={`共 ${gmids.length} gmids × ${activeResolutions.length} 解析度`} />
        <MetricCard label="OK" value={okCount} sub="截圖成功" color={okCount > 0 ? '#34d399' : undefined} />
        <MetricCard label="POPUP / ERR" value={`${popupCount} / ${errCount}`} sub="有彈窗 / 失敗" color={(popupCount + errCount) > 0 ? '#fbbf24' : undefined} />
        <MetricCard label="Status" value={runStatus?.toUpperCase() ?? 'IDLE'} sub={running ? `${doneCount}/${totalCount} 完成` : '可設定後執行'} color={runStateColor} />
      </div>

      {/* ── Main Layout ── */}
      <div className="ui-ss-main-grid">
        {/* ── LEFT: Config ── */}
        <div className="ui-ss-left">
          {/* Agent */}
          <section className="section-card">
            <h2 className="section-title">Local Agent</h2>
            <div className="ui-ss-agent-status">
              <span className={selectedAgent && !selectedAgent.busy ? 'badge badge--ok' : 'badge badge--warn'}>
                {selectedAgent && !selectedAgent.busy ? '可用' : selectedAgent?.busy ? '執行中' : '未連線'}
              </span>
              <span className="ui-ss-agent-hostname">
                {selectedAgent ? selectedAgent.hostname : '請先啟動 Toppath Local Agent'}
              </span>
              {selectedAgent && !selectedAgent.busy && (
                <span className="field-hint">{readyCount} 台空閒</span>
              )}
            </div>
            <label className="field">
              <span>執行裝置</span>
              <select
                value={selectedAgentId}
                disabled={running || agents.length === 0}
                onChange={e => setSelectedAgentId(e.target.value)}
              >
                {agents.length === 0 && <option value="">No local agent</option>}
                {agents.map(a => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.hostname}{a.busy ? ' - busy' : ' - ready'}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-ghost" type="button" onClick={refreshAgents} disabled={running}>重新整理</button>
            {agentError && <div className="ui-ss-agent-error">{agentError}</div>}
          </section>

          {/* Source */}
          <section className="section-card">
            <h2 className="section-title">資料來源</h2>

            {/* Lark Sheet URL + fetch button */}
            <label className="field">
              <span>Lark Sheet URL</span>
              <input
                value={wikiUrl}
                onChange={e => { setWikiUrl(e.target.value); setFetchGmidMsg('') }}
                disabled={running}
                placeholder="https://casinoplus.sg.larksuite.com/sheets/..."
              />
              <span className="field-hint">含 gmid 欄位的 Lark Sheet，貼上後點「從 Lark 讀取 gmid」</span>
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <button
                className="submit-btn submit-btn--sm"
                type="button"
                disabled={running || fetchingGmids || !wikiUrl.trim()}
                onClick={fetchGmidsFromLark}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                {fetchingGmids ? '讀取中…' : '從 Lark 讀取 gmid'}
              </button>
              {fetchGmidMsg && (
                <span style={{ fontSize: 12, color: fetchGmidMsg.startsWith('成功') ? '#34d399' : '#f87171' }}>
                  {fetchGmidMsg}
                </span>
              )}
            </div>

            {/* Manual gmid textarea */}
            <label className="field">
              <span>
                gmid 清單
                <span className="badge badge--blue" style={{ marginLeft: 8, fontSize: 10 }}>
                  {gmidText.split(/[\n,\s]+/).filter(s => s.trim().length > 0).length} 個
                </span>
              </span>
              <textarea
                value={gmidText}
                onChange={e => setGmidText(e.target.value)}
                disabled={running}
                placeholder={'從 Lark 讀取後自動填入，或手動輸入：\n4179-ARUZE-3062\nJJBX001'}
                style={{ fontFamily: 'monospace', fontSize: 12, minHeight: 90, resize: 'vertical' }}
              />
              <span className="field-hint">每行一個 gmid，或以逗號 / 空格分隔皆可；可手動修改</span>
            </label>

            <label className="field" style={{ marginBottom: 0 }}>
              <span>遊戲 URL Template</span>
              <input
                value={gameUrlTemplate}
                onChange={e => setGameUrlTemplate(e.target.value)}
                disabled={running}
                placeholder="https://osm-h5-prod.osmslot.org/?token=...&gameid={gmid}&..."
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              <span className="field-hint">以 {'{gmid}'} 替換 gameid= 的值，其餘參數固定</span>
            </label>
          </section>

          {/* Resolutions */}
          <section className="section-card">
            <h2 className="section-title">
              解析度選擇
              <span className="badge badge--blue" style={{ marginLeft: 'auto' }}>{selectedResolutions.length}/{RESOLUTIONS.length}</span>
            </h2>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={selectAll} disabled={running}>全選</button>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={clearAll} disabled={running}>清除</button>
            </div>
            {RESOLUTION_GROUPS.map(group => (
              <div key={group} style={{ marginBottom: 10 }}>
                <div
                  className="ui-ss-group-label"
                  onClick={() => selectGroup(group)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && selectGroup(group)}
                >
                  {group}
                  <span style={{ marginLeft: 4, fontSize: 10, color: '#475569' }}>
                    ({RESOLUTIONS.filter(r => r.group === group && selectedResolutions.includes(r.key)).length}/{RESOLUTIONS.filter(r => r.group === group).length})
                  </span>
                </div>
                <div className="ui-ss-res-grid">
                  {RESOLUTIONS.filter(r => r.group === group).map(res => (
                    <ResCheckbox
                      key={res.key}
                      res={res}
                      checked={selectedResolutions.includes(res.key)}
                      onChange={toggleResolution}
                      disabled={running}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>

          {/* Options */}
          <section className="section-card">
            <h2 className="section-title">執行選項</h2>
            <div className="ui-ss-toggle-row">
              <div>
                <div className="ui-ss-tgl-label">自動關閉面額彈窗</div>
                <div className="ui-ss-tgl-sub">偵測到 .select-bg 時自動點擊第一個選項</div>
              </div>
              <div
                className={`ui-ss-toggle${dismissPopup ? ' on' : ''}`}
                onClick={() => !running && setDismissPopup(v => !v)}
                role="switch"
                aria-checked={dismissPopup}
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && !running && setDismissPopup(v => !v)}
              />
            </div>
            <div className="ui-ss-toggle-row">
              <div>
                <div className="ui-ss-tgl-label">等待推流 {'<video>'} 就緒</div>
                <div className="ui-ss-tgl-sub">偵測到 video.readyState≥2 且有寬度後才截圖</div>
              </div>
              <div
                className={`ui-ss-toggle${waitForVideo ? ' on' : ''}`}
                onClick={() => !running && setWaitForVideo(v => !v)}
                role="switch"
                aria-checked={waitForVideo}
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && !running && setWaitForVideo(v => !v)}
              />
            </div>
            <div className="ui-ss-toggle-row">
              <div>
                <div className="ui-ss-tgl-label">Headed 模式</div>
                <div className="ui-ss-tgl-sub">顯示瀏覽器視窗（預設隱藏）</div>
              </div>
              <div
                className={`ui-ss-toggle${headedMode ? ' on' : ''}`}
                onClick={() => !running && setHeadedMode(v => !v)}
                role="switch"
                aria-checked={headedMode}
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && !running && setHeadedMode(v => !v)}
              />
            </div>
            <label className="field" style={{ marginTop: 10, marginBottom: 0 }}>
              <span>截圖延遲秒數</span>
              <input
                type="number"
                min={0}
                max={60}
                value={screenshotDelaySeconds}
                disabled={running}
                onChange={e => setScreenshotDelaySeconds(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
              />
              <span className="field-hint">進入機器且偵測到遊戲畫面後，再等待資源載入完成才截圖。</span>
            </label>
          </section>

          {error && (
            <div className="ui-ss-error-msg">{error}</div>
          )}
        </div>

        {/* ── RIGHT: Results ── */}
        <div className="ui-ss-right">
          {/* Progress */}
          {totalCount > 0 && (
            <div className="section-card" style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>進度</span>
                <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                  <span style={{ color: '#34d399', fontWeight: 600 }}>OK: {okCount}</span>
                  <span style={{ color: '#fbbf24', fontWeight: 600 }}>POPUP: {popupCount}</span>
                  <span style={{ color: '#f87171', fontWeight: 600 }}>ERR: {errCount}</span>
                  <span style={{ color: '#475569' }}>待執行: {totalCount - doneCount}</span>
                </div>
              </div>
              <div style={{ height: 5, background: '#0f172a', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                <div style={{ width: `${(okCount / totalCount) * 100}%`, background: '#10b981', transition: 'width 0.3s' }} />
                <div style={{ width: `${(popupCount / totalCount) * 100}%`, background: '#f59e0b', transition: 'width 0.3s' }} />
                <div style={{ width: `${(errCount / totalCount) * 100}%`, background: '#ef4444', transition: 'width 0.3s' }} />
              </div>
              <div style={{ fontSize: 11, color: '#475569', marginTop: 5 }}>
                {doneCount}/{totalCount} 完成（{pctDone.toFixed(0)}%）
              </div>
            </div>
          )}

          {/* Heatmap / List Panel */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 className="section-title" style={{ margin: 0 }}>截圖結果</h2>
              <div style={{ display: 'flex', border: '1px solid #2d3f55', borderRadius: 5, overflow: 'hidden' }}>
                {(['heatmap', 'list'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setViewMode(m)}
                    style={{
                      padding: '4px 12px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
                      background: viewMode === m ? '#3b82f6' : 'transparent',
                      color: viewMode === m ? '#fff' : '#64748b',
                      border: 'none', borderRight: m === 'heatmap' ? '1px solid #2d3f55' : 'none',
                    }}
                  >
                    {m === 'heatmap' ? '熱圖' : '清單'}
                  </button>
                ))}
              </div>
            </div>

            {taskList.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#334155', padding: '32px 0', fontSize: 13 }}>
                尚未有截圖資料，設定完成後點擊「開始截圖」
              </div>
            ) : viewMode === 'heatmap' ? (
              <div className="ui-ss-table-scroll">
                <table className="ui-ss-heatmap-table">
                  <thead>
                    <tr>
                      <th>gmid</th>
                      {activeResolutions.map(r => {
                        const info = RESOLUTIONS.find(x => x.key === r)
                        return (
                          <th key={r} title={`${r}`}>
                            <div>{info?.label ?? r}</div>
                            <div style={{ fontSize: 9, color: '#475569', fontWeight: 400 }}>{r}</div>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {gmids.map(gmid => (
                      <tr key={gmid}>
                        <td className="ui-ss-gmid-cell" title={gmid}>{gmid}</td>
                        {activeResolutions.map(res => {
                          const t = taskIndex.get(gmid)?.get(res)
                          if (!t) return <td key={res} style={{ background: '#0f172a' }} />
                          return (
                            <td
                              key={res}
                              className={`ui-ss-cell ui-ss-cell--${t.status}`}
                              onClick={() => t.server_path ? setPreviewTask(t) : undefined}
                              title={t.error_msg ?? t.status}
                            >
                              {t.server_path
                                ? <img
                                    src={`/api/ui-screenshot/screenshot/${t.run_id}/${t.gmid}/${t.resolution}`}
                                    alt={`${gmid} ${res}`}
                                    className="ui-ss-thumb"
                                  />
                                : <span className={taskBadgeClass(t.status)} style={{ fontSize: 9, padding: '1px 5px' }}>
                                    {taskStatusLabel(t.status)}
                                  </span>
                              }
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="ui-ss-table-scroll ui-ss-list-scroll">
                <table className="ui-ss-list-table">
                  <thead>
                    <tr>
                      <th>gmid</th>
                      <th>解析度</th>
                      <th>狀態</th>
                      <th>訊息</th>
                      <th>截圖</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taskList.sort((a, b) => a.gmid.localeCompare(b.gmid) || a.resolution.localeCompare(b.resolution)).map(t => (
                      <tr key={t.id}>
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.gmid}</td>
                        <td style={{ fontSize: 11 }}>{t.resolution}</td>
                        <td><span className={taskBadgeClass(t.status)}>{taskStatusLabel(t.status)}</span></td>
                        <td style={{ fontSize: 11, color: '#64748b', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.error_msg ?? '—'}
                        </td>
                        <td>
                          {t.server_path && (
                            <button
                              className="btn-ghost"
                              style={{ fontSize: 10, padding: '2px 7px' }}
                              onClick={() => setPreviewTask(t)}
                            >
                              查看
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Logs */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <h2 className="section-title">執行日誌</h2>
            <div className="ui-ss-log-panel" ref={logPanelRef}>
              {logs.length === 0
                ? <span style={{ color: '#334155' }}>（等待任務開始）</span>
                : logs.map((l, i) => <div key={i} className="ui-ss-log-line">{l}</div>)
              }
            </div>
          </div>

          {/* Export / Writeback */}
          {runStatus === 'done' && runId && (
            <div className="section-card">
              <h2 className="section-title">匯出與回寫</h2>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="submit-btn submit-btn--sm"
                  type="button"
                  onClick={writeback}
                  disabled={writingBack}
                  style={{ background: '#059669' }}
                >
                  {writingBack ? '回寫中…' : '回寫至 Lark Wiki'}
                </button>
                {writebackMsg && (
                  <span style={{ fontSize: 12, color: writebackMsg.includes('失敗') ? '#f87171' : '#34d399' }}>
                    {writebackMsg}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Image Preview Modal ── */}
      {previewTask && (
        <div
          className="ui-ss-modal-backdrop"
          onClick={() => setPreviewTask(null)}
        >
          <div className="ui-ss-modal" onClick={e => e.stopPropagation()}>
            <div className="ui-ss-modal-head">
              <span style={{ fontWeight: 700, color: '#f1f5f9' }}>{previewTask.gmid} — {previewTask.resolution}</span>
              <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setPreviewTask(null)}>關閉</button>
            </div>
            <div className="ui-ss-modal-body">
              <img
                src={`/api/ui-screenshot/screenshot/${previewTask.run_id}/${previewTask.gmid}/${previewTask.resolution}`}
                alt={`${previewTask.gmid} ${previewTask.resolution}`}
                style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 6 }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

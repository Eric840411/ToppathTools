import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface UatConfig {
  larkUrl: string
  filter: string
  dashGameType: string
  dashClientVersion: string
}

type RunStatus = 'idle' | 'running' | 'done' | 'error'

interface TcGroup { name: string; count: number }

type MainTab = '後端' | 'H5' | 'PC'
type AutoPlatform = 'h5' | 'pc'
type AutoFilter = 'all' | 'mine' | 'public'
type AutoStepStatus = 'pending' | 'pass' | 'fail'

interface AutoScript {
  id: string
  name: string
  platform: AutoPlatform
  steps: string
  created_by: string
  is_public: number
}

interface AutoBaseline {
  id: string
  script_id: string
  name: string
  image_path: string
}

interface AutoTemplate {
  id: string
  name: string
  image_path: string
  last_confidence: number | null
}

interface OcrRegion {
  id: string
  name: string
  label: string
  crop_x: number
  crop_y: number
  crop_w: number
  crop_h: number
  accuracy: number | null
}

interface AutoRun {
  id: string
  script_id: string
  result: string
}

function autoUser() {
  const saved = localStorage.getItem('frontend_auto_user')
  if (saved) return saved
  localStorage.setItem('frontend_auto_user', 'local-user')
  return 'local-user'
}

function parseAutoSteps(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map((item, index) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>
        const label = row.name ?? row.title ?? row.action
        if (typeof label === 'string' && label.trim()) return label
      }
      return `Step ${index + 1}`
    })
  } catch {
    return []
  }
}

// ─── Storage helpers ───────────────────────────────────────────────────────────

const STORAGE_KEY = 'osm_uat_config'

function loadConfig(): UatConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return {
    larkUrl: '',
    filter: '',
    dashGameType: '',
    dashClientVersion: '',
  }
}

function saveConfig(cfg: UatConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

// ─── Log line parser ───────────────────────────────────────────────────────────

function parseLogLine(line: string): { icon: string; color: string } {
  if (/^✅/.test(line)) return { icon: '✅', color: '#16a34a' }
  if (/^❌/.test(line)) return { icon: '❌', color: '#dc2626' }
  if (/^⚠️|^⚠/.test(line)) return { icon: '⚠️', color: '#d97706' }
  if (/^🔧/.test(line)) return { icon: '🔧', color: '#7c3aed' }
  if (/^⏳/.test(line)) return { icon: '⏳', color: '#2563eb' }
  if (/^⏰/.test(line)) return { icon: '⏰', color: '#2563eb' }
  if (/^📥|^📋/.test(line)) return { icon: '📋', color: '#475569' }
  if (/^\[/.test(line)) return { icon: '▶', color: '#1d4ed8' }
  return { icon: '·', color: '#64748b' }
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function OsmUatPage() {
  const [activeTab, setActiveTab] = useState<MainTab>('後端')
  const [config, setConfig] = useState<UatConfig>(loadConfig)
  const [status, setStatus] = useState<RunStatus>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [tcGroups, setTcGroups] = useState<TcGroup[] | null>(null)
  const [tcTotal, setTcTotal] = useState<number>(0)
  const [scanning, setScanning] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const statusRef = useRef<RunStatus>('idle')

  // ── SSE 訂閱 ────────────────────────────────────────────────────────────────

  const connectSSE = useCallback(() => {
    if (esRef.current) esRef.current.close()
    const es = new EventSource('/api/osm-uat/stream')
    esRef.current = es

    es.addEventListener('log', (e) => {
      const data = JSON.parse(e.data)
      setLogs(prev => [...prev, data.line])
      // Auto-detect completion from log line (backup in case status event is missed)
      if (/完成！/.test(data.line) && statusRef.current === 'running') {
        statusRef.current = 'done'
        setStatus('done')
        es.close()
        esRef.current = null
      }
    })

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      statusRef.current = data.status
      setStatus(data.status)
      // 完成或錯誤後關閉 SSE，不再重連
      if (data.status === 'done' || data.status === 'error') {
        es.close()
        esRef.current = null
      }
    })

    es.onerror = () => {
      es.close()
      esRef.current = null
      // 只在仍為 running 狀態時重連（用 ref 避免 closure 問題）
      if (statusRef.current === 'running') {
        setTimeout(connectSSE, 3000)
      }
    }
  }, [])

  useEffect(() => {
    connectSSE()
    return () => esRef.current?.close()
  }, [connectSSE])

  // ── 自動捲動 ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (autoScroll && status === 'running') {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll, status])

  // ── Config 變更 ─────────────────────────────────────────────────────────────

  function updateConfig(patch: Partial<UatConfig>) {
    setConfig(prev => {
      const next = { ...prev, ...patch }
      saveConfig(next)
      return next
    })
  }

  // ── 啟動測試 ────────────────────────────────────────────────────────────────

  async function handleRun() {
    setLogs([])
    statusRef.current = 'running'
    setStatus('running')
    connectSSE()   // re-establish SSE connection for the new run
    const res = await fetch('/api/osm-uat/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        larkUrl: config.larkUrl,
        filter: config.filter || undefined,
        dashGameType: config.dashGameType || undefined,
        dashClientVersion: config.dashClientVersion || undefined,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '未知錯誤' }))
      statusRef.current = 'idle'
      setStatus('idle')
      alert(`啟動失敗: ${err.error}`)
    }
  }

  // ── 停止測試 ────────────────────────────────────────────────────────────────

  async function handleStop() {
    await fetch('/api/osm-uat/stop', { method: 'POST' })
  }

  // ── 統計（從所有 log 中找最後一筆摘要，預設為 0）──────────────────────────

  const summary = (() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      const m = logs[i].match(/通過:\s*(\d+).*需人工:\s*(\d+).*跳過:\s*(\d+).*失敗:\s*(\d+)/)
      if (m) return { pass: +m[1], manual: +m[2], skip: +m[3], fail: +m[4] }
    }
    return { pass: 0, manual: 0, skip: 0, fail: 0 }
  })()

  // ── TC 掃描 ──────────────────────────────────────────────────────────────────

  async function handleScan() {
    if (!config.larkUrl) return
    setScanning(true)
    setTcGroups(null)
    try {
      const r = await fetch(`/api/osm-uat/scan?larkUrl=${encodeURIComponent(config.larkUrl)}`)
      const data: { ok: boolean; total: number; groups: TcGroup[]; error?: string } = await r.json()
      if (data.ok) {
        setTcTotal(data.total)
        setTcGroups(data.groups)
      } else {
        alert(`掃描失敗: ${data.error}`)
      }
    } catch {
      alert('掃描失敗')
    } finally {
      setScanning(false)
    }
  }

  // ── Frontend automation ────────────────────────────────────────────────────

  const actor = autoUser()
  const [apiReady, setApiReady] = useState(false)
  const [autoScripts, setAutoScripts] = useState<Record<AutoPlatform, AutoScript[]>>({ h5: [], pc: [] })
  const [autoRuns, setAutoRuns] = useState<Record<AutoPlatform, AutoRun[]>>({ h5: [], pc: [] })
  const [selectedScriptIds, setSelectedScriptIds] = useState<Record<AutoPlatform, string>>({ h5: '', pc: '' })
  const [autoBaselines, setAutoBaselines] = useState<Record<string, AutoBaseline[]>>({})
  const [autoTemplates, setAutoTemplates] = useState<AutoTemplate[]>([])
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>([])
  const [autoLogs, setAutoLogs] = useState<Record<AutoPlatform, string[]>>({ h5: [], pc: [] })
  const [autoStats, setAutoStats] = useState<Record<AutoPlatform, { pass: number; fail: number; skip: number }>>({ h5: { pass: 0, fail: 0, skip: 0 }, pc: { pass: 0, fail: 0, skip: 0 } })
  const [stepStatuses, setStepStatuses] = useState<Record<AutoPlatform, AutoStepStatus[]>>({ h5: [], pc: [] })
  const [newScriptOpen, setNewScriptOpen] = useState<Record<AutoPlatform, boolean>>({ h5: false, pc: false })
  const [newScriptDraft, setNewScriptDraft] = useState<Record<AutoPlatform, { name: string; steps: string }>>({
    h5: { name: '', steps: '[\n  { "name": "Open page", "action": "goto" }\n]' },
    pc: { name: '', steps: '[\n  { "name": "Open page", "action": "goto" }\n]' },
  })
  const [runConfig, setRunConfig] = useState<Record<AutoPlatform, { url: string; resolution: string; failureMode: string; headed: boolean }>>({
    h5: { url: '', resolution: '390x844', failureMode: 'continue', headed: false },
    pc: { url: '', resolution: '1366x768', failureMode: 'continue', headed: false },
  })
  const autoStreams = useRef<Record<AutoPlatform, EventSource | null>>({ h5: null, pc: null })

  const loadAutoScripts = useCallback(async (platform: AutoPlatform) => {
    const res = await fetch(`/api/frontend-auto/scripts?platform=${platform}`)
    setApiReady(res.ok)
    if (!res.ok) return
    const data = await res.json() as { scripts?: AutoScript[] }
    const rows = data.scripts ?? []
    setAutoScripts(prev => ({ ...prev, [platform]: rows }))
    setSelectedScriptIds(prev => ({ ...prev, [platform]: prev[platform] || rows[0]?.id || '' }))
  }, [])

  const loadAutoRuns = useCallback(async (platform: AutoPlatform) => {
    const res = await fetch(`/api/frontend-auto/runs?platform=${platform}&limit=50`)
    if (!res.ok) return
    const data = await res.json() as { runs?: AutoRun[] }
    setAutoRuns(prev => ({ ...prev, [platform]: data.runs ?? [] }))
  }, [])

  const loadBaselines = useCallback(async (scriptId: string) => {
    if (!scriptId) return
    const res = await fetch(`/api/frontend-auto/baselines?scriptId=${encodeURIComponent(scriptId)}`)
    if (!res.ok) return
    const data = await res.json() as { baselines?: AutoBaseline[] }
    setAutoBaselines(prev => ({ ...prev, [scriptId]: data.baselines ?? [] }))
  }, [])

  const loadTemplates = useCallback(async () => {
    const res = await fetch('/api/frontend-auto/templates')
    if (!res.ok) return
    const data = await res.json() as { templates?: AutoTemplate[] }
    setAutoTemplates(data.templates ?? [])
  }, [])

  const loadOcr = useCallback(async () => {
    const res = await fetch('/api/frontend-auto/ocr-regions')
    if (!res.ok) return
    const data = await res.json() as { regions?: OcrRegion[] }
    setOcrRegions(data.regions ?? [])
  }, [])

  useEffect(() => {
    void loadAutoScripts('h5')
    void loadAutoScripts('pc')
    void loadAutoRuns('h5')
    void loadAutoRuns('pc')
    void loadTemplates()
    void loadOcr()
  }, [loadAutoScripts, loadAutoRuns, loadTemplates, loadOcr])

  useEffect(() => { if (selectedScriptIds.h5) void loadBaselines(selectedScriptIds.h5) }, [selectedScriptIds.h5, loadBaselines])
  useEffect(() => { if (selectedScriptIds.pc) void loadBaselines(selectedScriptIds.pc) }, [selectedScriptIds.pc, loadBaselines])

  async function createAutoScript(platform: AutoPlatform) {
    const draft = newScriptDraft[platform]
    const res = await fetch('/api/frontend-auto/scripts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: draft.name, platform, steps: draft.steps, createdBy: actor, isPublic: true }),
    })
    if (!res.ok) return alert('Create script failed')
    setNewScriptOpen(prev => ({ ...prev, [platform]: false }))
    setNewScriptDraft(prev => ({ ...prev, [platform]: { ...prev[platform], name: '' } }))
    await loadAutoScripts(platform)
  }

  async function deleteAutoScript(platform: AutoPlatform, script: AutoScript) {
    const res = await fetch(`/api/frontend-auto/scripts/${script.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ createdBy: actor }),
    })
    if (!res.ok) return alert('Delete script failed')
    setSelectedScriptIds(prev => ({ ...prev, [platform]: prev[platform] === script.id ? '' : prev[platform] }))
    await loadAutoScripts(platform)
  }

  async function runAutoScript(platform: AutoPlatform) {
    const script = autoScripts[platform].find(item => item.id === selectedScriptIds[platform])
    if (!script) return
    const steps = parseAutoSteps(script.steps)
    setAutoStats(prev => ({ ...prev, [platform]: { pass: 0, fail: 0, skip: 0 } }))
    setStepStatuses(prev => ({ ...prev, [platform]: steps.map(() => 'pending') }))
    setAutoLogs(prev => ({ ...prev, [platform]: [`Starting ${script.name}`, `URL: ${runConfig[platform].url || '(not set)'}`] }))
    const res = await fetch('/api/frontend-auto/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptId: script.id, scriptName: script.name, platform, ranBy: actor, totalSteps: steps.length, result: 'running', startedAt: Date.now() }),
    })
    if (!res.ok) return
    const data = await res.json() as { run?: { id: string } }
    if (!data.run?.id) return
    autoStreams.current[platform]?.close()
    const stream = new EventSource(`/api/frontend-auto/log-stream/${data.run.id}`)
    autoStreams.current[platform] = stream
    stream.addEventListener('log', event => {
      const payload = JSON.parse(event.data) as { line: string }
      setAutoLogs(prev => ({ ...prev, [platform]: [...prev[platform], payload.line] }))
    })
    stream.onerror = () => stream.close()
    await fetch(`/api/frontend-auto/runs/${data.run.id}/log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: `Queued ${steps.length} steps for ${platform.toUpperCase()}` }),
    })
    await loadAutoRuns(platform)
  }

  function stopAuto(platform: AutoPlatform) {
    autoStreams.current[platform]?.close()
    autoStreams.current[platform] = null
    setAutoLogs(prev => ({ ...prev, [platform]: [...prev[platform], 'Stopped by user'] }))
  }

  async function uploadBaseline(platform: AutoPlatform, file: File | undefined) {
    const scriptId = selectedScriptIds[platform]
    if (!file || !scriptId) return
    const form = new FormData()
    form.append('image', file); form.append('scriptId', scriptId); form.append('cropId', `crop-${Date.now()}`); form.append('name', file.name); form.append('platform', platform); form.append('createdBy', actor)
    const res = await fetch('/api/frontend-auto/baselines', { method: 'POST', body: form })
    if (res.ok) await loadBaselines(scriptId)
  }

  async function deleteBaseline(scriptId: string, id: string) {
    const res = await fetch(`/api/frontend-auto/baselines/${id}`, { method: 'DELETE' })
    if (res.ok) await loadBaselines(scriptId)
  }

  async function uploadTemplate(file: File | undefined) {
    if (!file) return
    const form = new FormData()
    form.append('image', file); form.append('name', file.name); form.append('createdBy', actor)
    const res = await fetch('/api/frontend-auto/templates', { method: 'POST', body: form })
    if (res.ok) await loadTemplates()
  }

  async function addOcrRegion() {
    const name = window.prompt('Region name')?.trim()
    if (!name) return
    const label = window.prompt('Label')?.trim() ?? ''
    const res = await fetch('/api/frontend-auto/ocr-regions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, label, cropX: 0, cropY: 0, cropW: 100, cropH: 40, accuracy: 0 }),
    })
    if (res.ok) await loadOcr()
  }

  const AutoPanel = ({ platform }: { platform: AutoPlatform }) => {
    const [filter, setFilter] = useState<AutoFilter>('all')
    const [search, setSearch] = useState('')
    const selected = autoScripts[platform].find(item => item.id === selectedScriptIds[platform])
    const steps = selected ? parseAutoSteps(selected.steps) : []
    const baselineRows = selected ? autoBaselines[selected.id] ?? [] : []
    const latest = new Map(autoRuns[platform].map(run => [run.script_id, run.result]))
    const visible = autoScripts[platform].filter(script => (filter === 'mine' ? script.created_by === actor : filter === 'public' ? !!script.is_public : true) && script.name.toLowerCase().includes(search.toLowerCase()))
    const resolutions = platform === 'h5' ? ['375x667', '390x844', '414x896'] : ['1366x768', '1440x900', '1920x1080']
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...panelStyle, display: 'flex', alignItems: 'center', gap: 16, padding: 12 }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', fontWeight: 600 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: apiReady ? '#16a34a' : '#94a3b8' }} />Node.js / Playwright 安裝套件</span><a href="/api/frontend-auto/setup/install.bat" style={downloadStyle}>install.bat</a><a href="/api/frontend-auto/setup/install.sh" style={downloadStyle}>install.sh</a></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16 }}>
          <section style={panelStyle}><div style={panelHeadStyle}><h3 style={h3Style}>腳本清單</h3><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋腳本名稱" style={{ ...inputStyle, width: 180 }} /></div><div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>{(['all', 'mine', 'public'] as const).map(item => <button key={item} onClick={() => setFilter(item)} style={filter === item ? activePillStyle : pillStyle}>{item === 'all' ? '全部' : item === 'mine' ? '我的' : '公開'}</button>)}</div><table style={tableStyle}><thead><tr><th style={thStyle}>名稱</th><th style={thStyle}>步驟數</th><th style={thStyle}>上次結果</th><th style={thStyle}>操作</th></tr></thead><tbody>{visible.map(script => <tr key={script.id} onClick={() => setSelectedScriptIds(prev => ({ ...prev, [platform]: script.id }))} style={{ background: selectedScriptIds[platform] === script.id ? '#eff6ff' : '#fff', cursor: 'pointer' }}><td style={tdStyle}>{script.name}</td><td style={tdStyle}>{parseAutoSteps(script.steps).length}</td><td style={tdStyle}>{latest.get(script.id) ?? '未知'}</td><td style={tdStyle}><button style={smallBtnStyle} onClick={e => { e.stopPropagation(); setSelectedScriptIds(prev => ({ ...prev, [platform]: script.id })); void runAutoScript(platform) }}>執行</button><button style={dangerBtnStyle} onClick={e => { e.stopPropagation(); void deleteAutoScript(platform, script) }}>刪除</button></td></tr>)}</tbody></table><button style={{ ...btnStyle, background: '#1d4ed8', marginTop: 12 }} onClick={() => setNewScriptOpen(prev => ({ ...prev, [platform]: !prev[platform] }))}>＋ 新增腳本</button>{newScriptOpen[platform] && <div style={{ display: 'grid', gap: 8, marginTop: 12 }}><input value={newScriptDraft[platform].name} onChange={e => setNewScriptDraft(prev => ({ ...prev, [platform]: { ...prev[platform], name: e.target.value } }))} placeholder="腳本名稱" style={inputStyle} /><textarea value={newScriptDraft[platform].steps} onChange={e => setNewScriptDraft(prev => ({ ...prev, [platform]: { ...prev[platform], steps: e.target.value } }))} rows={6} style={{ ...inputStyle, fontFamily: 'Consolas, Monaco, monospace' }} /><button style={{ ...btnStyle, background: '#16a34a', width: 110 }} onClick={() => void createAutoScript(platform)}>儲存</button></div>}</section>
          <section style={panelStyle}><h3 style={h3Style}>執行設定</h3><div style={{ display: 'grid', gap: 10, marginTop: 12 }}><input value={runConfig[platform].url} onChange={e => setRunConfig(prev => ({ ...prev, [platform]: { ...prev[platform], url: e.target.value } }))} placeholder="目標 URL" style={inputStyle} /><select value={runConfig[platform].resolution} onChange={e => setRunConfig(prev => ({ ...prev, [platform]: { ...prev[platform], resolution: e.target.value } }))} style={inputStyle}>{resolutions.map(size => <option key={size}>{size}</option>)}</select><select value={runConfig[platform].failureMode} onChange={e => setRunConfig(prev => ({ ...prev, [platform]: { ...prev[platform], failureMode: e.target.value } }))} style={inputStyle}><option value="continue">失敗後繼續</option><option value="stop">失敗後停止</option></select><label style={{ fontSize: 12, color: '#334155' }}><input type="checkbox" checked={runConfig[platform].headed} onChange={e => setRunConfig(prev => ({ ...prev, [platform]: { ...prev[platform], headed: e.target.checked } }))} /> 顯示瀏覽器視窗</label><div style={{ display: 'flex', gap: 8 }}><button disabled={!selected} style={{ ...btnStyle, background: selected ? '#1d4ed8' : '#94a3b8' }} onClick={() => void runAutoScript(platform)}>▶ 執行所選腳本</button><button style={{ ...btnStyle, background: '#dc2626' }} onClick={() => stopAuto(platform)}>■ 停止</button></div><div style={{ display: 'flex', gap: 10, fontSize: 12, fontWeight: 700 }}><span style={{ color: '#16a34a' }}>通過 {autoStats[platform].pass}</span><span style={{ color: '#dc2626' }}>失敗 {autoStats[platform].fail}</span><span style={{ color: '#64748b' }}>跳過 {autoStats[platform].skip}</span></div><div style={autoLogStyle}>{autoLogs[platform].length ? autoLogs[platform].map((line, i) => <div key={i}>{line}</div>) : <span style={{ color: '#64748b' }}>等待執行...</span>}</div></div></section>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}><section style={panelStyle}><h3 style={h3Style}>步驟進度</h3><div style={{ display: 'grid', gap: 8, marginTop: 12 }}>{steps.length ? steps.map((step, i) => <div key={`${step}-${i}`} style={stepRowStyle}><span>{stepStatuses[platform][i] === 'pass' ? '✅' : stepStatuses[platform][i] === 'fail' ? '❌' : '○'}</span><span>{step}</span></div>) : <span style={emptyStyle}>尚未選擇腳本</span>}</div></section><section style={panelStyle}><div style={panelHeadStyle}><h3 style={h3Style}>基準截圖管理</h3><label style={uploadStyle}>上傳基準圖<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { void uploadBaseline(platform, e.target.files?.[0]); e.target.value = '' }} /></label></div><div style={thumbGridStyle}>{baselineRows.map(row => <div key={row.id} style={thumbCardStyle}><img src={row.image_path} alt={row.name} style={thumbImageStyle} /><span style={cardTitleStyle}>{row.name}</span><button style={dangerBtnStyle} onClick={() => void deleteBaseline(row.script_id, row.id)}>刪除</button></div>)}</div></section></div>
        {platform === 'pc' && <><section style={panelStyle}><div style={panelHeadStyle}><h3 style={h3Style}>模板圖庫</h3><label style={uploadStyle}>上傳模板<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { void uploadTemplate(e.target.files?.[0]); e.target.value = '' }} /></label></div><div style={thumbGridStyle}>{autoTemplates.map(t => <div key={t.id} style={thumbCardStyle}><img src={t.image_path} alt={t.name} style={thumbImageStyle} /><span style={cardTitleStyle}>{t.name}</span><div style={barTrackStyle}><span style={{ ...barFillStyle, width: `${Math.round((t.last_confidence ?? 0) * 100)}%` }} /></div><button style={dangerBtnStyle} onClick={() => { void fetch(`/api/frontend-auto/templates/${t.id}`, { method: 'DELETE' }).then(loadTemplates) }}>刪除</button></div>)}</div></section><section style={panelStyle}><div style={panelHeadStyle}><h3 style={h3Style}>OCR 區域定義</h3><button style={smallBtnStyle} onClick={() => void addOcrRegion()}>新增區域</button></div><table style={tableStyle}><thead><tr><th style={thStyle}>名稱</th><th style={thStyle}>標籤</th><th style={thStyle}>裁切範圍</th><th style={thStyle}>準確率</th><th style={thStyle}>操作</th></tr></thead><tbody>{ocrRegions.map(r => <tr key={r.id}><td style={tdStyle}>{r.name}</td><td style={tdStyle}>{r.label}</td><td style={tdStyle}>{r.crop_x},{r.crop_y},{r.crop_w},{r.crop_h}</td><td style={tdStyle}>{r.accuracy ?? '-'}</td><td style={tdStyle}><button style={dangerBtnStyle} onClick={() => { void fetch(`/api/frontend-auto/ocr-regions/${r.id}`, { method: 'DELETE' }).then(loadOcr) }}>刪除</button></td></tr>)}</tbody></table></section></>}
      </div>
    )
  }
  // ── 狀態顏色 ────────────────────────────────────────────────────────────────

  const statusColor: Record<RunStatus, string> = {
    idle: '#94a3b8',
    running: '#2563eb',
    done: '#16a34a',
    error: '#dc2626',
  }
  const statusLabel: Record<RunStatus, string> = {
    idle: '待機',
    running: '執行中...',
    done: '完成',
    error: '錯誤',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 4px' }}>

      {/* ── 測試類型分頁 ── */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e2e8f0', paddingBottom: 0 }}>
        {(['後端', 'H5', 'PC'] as const).map(tab => {
          const active = tab === activeTab
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '8px 20px',
                border: 'none',
                borderBottom: active ? '2px solid #1d4ed8' : '2px solid transparent',
                marginBottom: -2,
                background: 'none',
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                color: active ? '#1d4ed8' : '#64748b',
                cursor: 'pointer',
                borderRadius: '6px 6px 0 0',
              }}
            >
              {tab}
            </button>
          )
        })}
      </div>

      {activeTab === '後端' ? (
        <>
      {/* ── 設定區 ── */}
      <section style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
          ⚙️ 測試設定
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Lark TC 路徑</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={config.larkUrl}
                onChange={e => updateConfig({ larkUrl: e.target.value })}
                placeholder="https://xxx.larksuite.com/base/{token}?table={id}"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={handleScan}
                disabled={scanning || !config.larkUrl}
                style={{
                  ...btnStyle,
                  background: scanning || !config.larkUrl ? '#94a3b8' : '#0891b2',
                  cursor: scanning || !config.larkUrl ? 'not-allowed' : 'pointer',
                  padding: '6px 14px',
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                }}
              >
                {scanning ? '掃描中...' : '🔍 掃描'}
              </button>
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              TC 篩選（留空 = 全跑）
            </span>
            <input
              type="text"
              value={config.filter}
              onChange={e => updateConfig({ filter: e.target.value })}
              placeholder="例：Daily Ranking, Daily Dashboard"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              Dashboard Game Type（留空 = BWJL）
            </span>
            <input
              type="text"
              value={config.dashGameType}
              onChange={e => updateConfig({ dashGameType: e.target.value })}
              placeholder="例：BWJL"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              Dashboard Client Version（留空 = H5(1.5)）
            </span>
            <input
              type="text"
              value={config.dashClientVersion}
              onChange={e => updateConfig({ dashClientVersion: e.target.value })}
              placeholder="例：H5(1.5)"
              style={inputStyle}
            />
          </label>
        </div>
      </section>

      {/* ── TC 掃描結果 ── */}
      {tcGroups && (
        <section style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0369a1' }}>📋 TC 摘要</span>
            <span style={{ fontSize: 12, color: '#64748b' }}>共 {tcTotal} 筆</span>
            <button
              type="button"
              onClick={() => setTcGroups(null)}
              style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tcGroups.map(g => (
              <span
                key={g.name}
                style={{
                  padding: '3px 10px',
                  background: '#e0f2fe',
                  border: '1px solid #7dd3fc',
                  borderRadius: 12,
                  fontSize: 12,
                  color: '#0369a1',
                  whiteSpace: 'nowrap',
                }}
              >
                {g.name} <strong>({g.count})</strong>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ── 控制列 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleRun}
          disabled={status === 'running'}
          style={{
            ...btnStyle,
            background: status === 'running' ? '#94a3b8' : '#1d4ed8',
            cursor: status === 'running' ? 'not-allowed' : 'pointer',
          }}
        >
          ▶ 執行測試
        </button>
        <button
          onClick={handleStop}
          disabled={status !== 'running'}
          style={{
            ...btnStyle,
            background: status === 'running' ? '#dc2626' : '#94a3b8',
            cursor: status !== 'running' ? 'not-allowed' : 'pointer',
          }}
        >
          ■ 停止
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <span
            style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: statusColor[status],
            }}
          />
          <span style={{ fontSize: 13, color: statusColor[status], fontWeight: 600 }}>
            {statusLabel[status]}
          </span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
          />
          自動捲動
        </label>
        <button
          onClick={() => setLogs([])}
          style={{ fontSize: 12, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
        >
          清除
        </button>
      </div>

      {/* ── 統計摘要（長駐）── */}
      <div style={{
        display: 'flex', gap: 12, padding: '10px 16px',
        background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8,
        fontSize: 13, fontWeight: 600,
      }}>
        <span style={{ color: '#16a34a' }}>✅ 通過: {summary.pass}</span>
        <span style={{ color: '#7c3aed' }}>🔧 需人工: {summary.manual}</span>
        <span style={{ color: '#94a3b8' }}>⏭ 跳過: {summary.skip}</span>
        <span style={{ color: '#dc2626' }}>❌ 失敗: {summary.fail}</span>
      </div>

      {/* ── Log 面板 ── */}
      <section
        style={{
          background: '#0f172a', borderRadius: 8, padding: 16,
          fontFamily: 'Consolas, Monaco, monospace', fontSize: 12,
          height: 480, overflowY: 'auto', lineHeight: 1.7,
        }}
        onScroll={e => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          setAutoScroll(atBottom)
        }}
      >
        {logs.length === 0 ? (
          <span style={{ color: '#475569' }}>等待執行...</span>
        ) : (
          logs.map((line, i) => {
            const { color } = parseLogLine(line)
            return (
              <div key={i} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {line}
              </div>
            )
          })
        )}
        <div ref={logEndRef} />
      </section>
        </>
      ) : activeTab === 'H5' ? (
        <AutoPanel platform="h5" />
      ) : (
        <AutoPanel platform="pc" />
      )}
    </div>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  fontSize: 12,
  color: '#1e293b',
  background: '#fff',
  outline: 'none',
}

const btnStyle: React.CSSProperties = {
  padding: '8px 20px',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
}

const panelStyle: React.CSSProperties = {
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: 16,
}

const panelHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
}

const h3Style: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: '#1e293b',
}

const cardTitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  display: 'block',
  marginTop: 4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
}

const barTrackStyle: React.CSSProperties = {
  background: '#e2e8f0',
  borderRadius: 4,
  height: 4,
  overflow: 'hidden',
  marginTop: 4,
}

const barFillStyle: React.CSSProperties = {
  display: 'block',
  height: '100%',
  background: '#1d4ed8',
  borderRadius: 4,
}

const dangerBtnStyle: React.CSSProperties = {
  padding: '3px 8px',
  border: 'none',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: '#dc2626',
  cursor: 'pointer',
}

const smallBtnStyle: React.CSSProperties = {
  padding: '3px 8px',
  border: 'none',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: '#1d4ed8',
  cursor: 'pointer',
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
}

const thStyle: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  borderBottom: '1px solid #e2e8f0',
  fontSize: 11,
  fontWeight: 600,
  color: '#64748b',
  background: '#f8fafc',
}

const tdStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid #f1f5f9',
  color: '#1e293b',
  fontSize: 12,
}

const downloadStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: '#e0f2fe',
  color: '#0369a1',
  borderRadius: 4,
  textDecoration: 'none',
  fontSize: 12,
  fontWeight: 500,
}

const activePillStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: 'none',
  borderRadius: 12,
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: '#1d4ed8',
  cursor: 'pointer',
}

const pillStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: '1px solid #e2e8f0',
  borderRadius: 12,
  fontSize: 11,
  fontWeight: 600,
  color: '#64748b',
  background: '#fff',
  cursor: 'pointer',
}

const autoLogStyle: React.CSSProperties = {
  background: '#0f172a',
  borderRadius: 6,
  padding: 10,
  fontFamily: 'Consolas, Monaco, monospace',
  fontSize: 11,
  height: 160,
  overflowY: 'auto',
  color: '#94a3b8',
  lineHeight: 1.6,
}

const stepRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: '#334155',
}

const emptyStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#94a3b8',
}

const uploadStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: '#e0f2fe',
  color: '#0369a1',
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
}

const thumbGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
  gap: 8,
  marginTop: 12,
}

const thumbCardStyle: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: 6,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
}

const thumbImageStyle: React.CSSProperties = {
  width: '100%',
  aspectRatio: '4 / 3',
  objectFit: 'cover',
  borderRadius: 4,
}






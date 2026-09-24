import { useCallback, useEffect, useRef, useState } from 'react'
import Portal from '../components/Portal'

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

/**
 * 要跑哪一套客戶端。掃大廳與截圖兩段共用同一個值。
 *
 * ⚠️ **不從網址推。**原本是 `/osm-pc|[?&]platform=pc/` 打整條網址，但 H5 的正式網址
 *    本身就帶 `&platform=pc&device=mobile`，於是 H5 永遠命中 PC 分支、去讀根本不存在的
 *    Cocos 場景樹，錯誤訊息卻長得像「大廳載不出來」。改成使用者明確指定。
 */
type ClientType = 'h5' | 'pc'

const CLIENT_OPTIONS: Array<{ key: ClientType; label: string; sub: string }> = [
  { key: 'h5', label: 'H5', sub: '讀 DOM 卡片' },
  { key: 'pc', label: 'PC', sub: '讀 Cocos 場景樹' },
]

/**
 * 從主機名猜客戶端。**只用來提示「你選的跟網址對不上」，不用來決定走哪條流程。**
 * 只看 hostname 不看 query——正是 query 裡的 `platform=pc` 造成原本那個誤判。
 */
function guessClientFromHost(url: string): ClientType | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (/^osm-pc[-.]/.test(host)) return 'pc'
    if (/^osm-h5[-.]/.test(host)) return 'h5'
  } catch {
    // 網址還在打、還不是合法 URL——沒得猜就不猜，不要亂提示
  }
  return null
}

interface ScreenshotTask {
  id: string
  run_id: string
  gmid: string
  resolution: string
  status: TaskStatus
  server_path: string | null
  error_msg: string | null
  /** 自動選機時，這張圖實際用的機台（可能跟同一組的其他張不同台） */
  actual_gmid?: string | null
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
  /** 自動選機時實際用的機台號 */
  actualGmid?: string | null
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
  { key: '414x730',  label: '模擬A',          w: 414,  h: 730,  group: 'Mobile Portrait' },
  { key: '376x636',  label: '模擬B',          w: 376,  h: 636,  group: 'Mobile Portrait' },
  { key: '344x882',  label: 'FOLD/Flip 折',  w: 344,  h: 882,  group: 'Mobile Portrait' },
  { key: '884x1104', label: 'FOLD/Flip 展',  w: 884,  h: 1104, group: 'Mobile Portrait' },
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
  /**
   * 要跑哪一種客戶端。**由使用者明確指定，不從網址猜。**
   * ⚠️ 原本是用網址判（`platform=pc` 命中就當 PC），但 H5 的正式網址本身就帶
   *    `&platform=pc&device=mobile`，於是 H5 一直被判成 PC、走 Cocos 場景樹分支掃不到東西。
   */
  clientType: ClientType
  selectedResolutions: string[]
  dismissPopup: boolean
  waitForVideo: boolean
  /** 每個解析度都用該尺寸重新載入（慢但準）；關掉就只改視窗大小 */
  reloadPerResolution: boolean
  /** 自動選機：清單裡放的是「遊戲 / model」，實際進哪一台由大廳當下狀態決定 */
  autoPickByGame: boolean
  /** 也拍大廳本身 */
  captureLobby: boolean
  /** 報告要上傳到哪個 Lark 雲端資料夾 */
  larkFolderUrl: string
  headedMode: boolean
  screenshotDelaySeconds: number
  selectedAgentId: string
}

/** 自動建 Lark Sheet 的進度（後端 `sheetExportSummary`） */
interface SheetExportSummary {
  id: string
  status: 'running' | 'done' | 'partial' | 'interrupted'
  running: boolean
  url: string
  no_machine: number
  message: string
  images: { ok: number; fail: number; pending: number }
  texts: { ok: number; fail: number; pending: number }
  failures: Array<{ row_num: number; col_num: number; kind: string; error: string | null }>
}

const DEFAULT_SETTINGS: Settings = {
  wikiUrl: '',
  gmidText: '',
  clientType: 'h5',
  gameUrlTemplate: 'https://osm-h5-prod.osmslot.org/?token=ec8942c14e4b88ea2f223e7b2901058e-111716868&platform=pc&mode=live&language=en_us&studioid=cp&gameid={gmid}&lang=zh_cn&username=cposmtest3&device=mobile&isPwaClaimed=1',
  selectedResolutions: DEFAULT_RESOLUTIONS,
  dismissPopup: true,
  waitForVideo: true,
  reloadPerResolution: true,
  autoPickByGame: true,
  captureLobby: false,
  larkFolderUrl: '',
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
  const [clientType, setClientType] = useState<ClientType>(init.clientType)
  const hostGuess = guessClientFromHost(gameUrlTemplate)
  const [selectedResolutions, setSelectedResolutions] = useState<string[]>(init.selectedResolutions)
  const [dismissPopup, setDismissPopup] = useState(init.dismissPopup)
  const [waitForVideo, setWaitForVideo] = useState(init.waitForVideo)
  const [reloadPerResolution, setReloadPerResolution] = useState(init.reloadPerResolution)
  const [autoPickByGame, setAutoPickByGame] = useState(init.autoPickByGame)
  const [captureLobby, setCaptureLobby] = useState(init.captureLobby)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [models, setModels] = useState<Array<{ key: string; game: string; model: string; total: number; free: number; sample: string }>>([])
  const [unparsed, setUnparsed] = useState<Array<{ gmid: string; text: string }>>([])
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [larkFolderUrl, setLarkFolderUrl] = useState(init.larkFolderUrl)
  const [reporting, setReporting] = useState(false)
  const [reportMsg, setReportMsg] = useState<string | null>(null)
  const [sheetExport, setSheetExport] = useState<SheetExportSummary | null>(null)
  const [sheetBusy, setSheetBusy] = useState(false)
  const [sheetMsg, setSheetMsg] = useState<string | null>(null)
  const [storage, setStorage] = useState<{ runs: number; files: number; bytes: number } | null>(null)
  const [storageMsg, setStorageMsg] = useState<string | null>(null)
  const [modelFilter, setModelFilter] = useState('')
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

  // 進頁面就算一次佔用空間——不主動顯示的話沒人會去按「重新計算」，
  // 而「容量什麼時候會爆」正是最需要被看見的數字
  useEffect(() => { void loadStorage() }, [])

  useEffect(() => { saveSettings({ wikiUrl }) }, [wikiUrl])
  useEffect(() => { saveSettings({ gmidText }) }, [gmidText])
  useEffect(() => { saveSettings({ gameUrlTemplate }) }, [gameUrlTemplate])
  useEffect(() => { saveSettings({ clientType }) }, [clientType])
  useEffect(() => { saveSettings({ selectedResolutions }) }, [selectedResolutions])
  useEffect(() => { saveSettings({ dismissPopup }) }, [dismissPopup])
  useEffect(() => { saveSettings({ waitForVideo }) }, [waitForVideo])
  useEffect(() => { saveSettings({ reloadPerResolution }) }, [reloadPerResolution])
  useEffect(() => { saveSettings({ autoPickByGame }) }, [autoPickByGame])
  useEffect(() => { saveSettings({ captureLobby }) }, [captureLobby])
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
                actual_gmid: u.actualGmid ?? existing.actual_gmid ?? null,
              })
            }
            return next
          })
          const machine = u.actualGmid && u.actualGmid !== u.gmid ? ` @${u.actualGmid}` : ''
          const msg = `[${u.gmid}${machine}] ${u.resolution} → ${u.status}${u.errorMsg ? ` (${u.errorMsg})` : ''}`
          setLogs(prev => [...prev.slice(-200), msg])
        } else if (data.type === 'run_complete') {
          setRunStatus('done')
          const c = data as SseRunComplete
          const msg = `通過 Run 完成｜OK:${c.ok_count ?? '?'} POPUP:${c.popup_count ?? '?'} ERR:${c.err_count ?? '?'}`
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
      setLogs(prev => [...prev, 'SSE 連線中斷'])
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

  // ── Lark Sheet 進度：換 run 時接回上次建的表；背景寫入中就每 2 秒問一次 ──────
  useEffect(() => {
    setSheetExport(null)
    setSheetMsg(null)
    if (!runId || runStatus !== 'done') return
    fetch(`/api/ui-screenshot/run/${runId}/sheet-export`)
      .then(r => r.json())
      .then((d: { ok: boolean; summary: SheetExportSummary | null }) => { if (d.ok) setSheetExport(d.summary) })
      .catch(() => { /* 沒有就當成還沒建過 */ })
  }, [runId, runStatus])

  const sheetRunning = !!sheetExport?.running
  const sheetExportId = sheetExport?.id
  useEffect(() => {
    if (!sheetRunning || !sheetExportId) return
    const timer = setInterval(() => {
      fetch(`/api/ui-screenshot/sheet-export/${sheetExportId}`)
        .then(r => r.json())
        .then((d: { ok: boolean; summary?: SheetExportSummary }) => { if (d.ok && d.summary) setSheetExport(d.summary) })
        .catch(() => { /* 下一輪再問 */ })
    }, 2000)
    return () => clearInterval(timer)
  }, [sheetRunning, sheetExportId])

  // ── Actions ─────────────────────────────────────────────────────────────────

  /** 在 Lark 資料夾建一份新 Sheet（gmid × 尺寸，格子放截圖），圖在背景一格一格塞 */
  async function createLarkSheet() {
    if (!runId) return
    setSheetBusy(true)
    setSheetMsg(null)
    try {
      const r = await fetch(`/api/ui-screenshot/run/${runId}/sheet-export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderUrl: larkFolderUrl.trim() }),
      })
      const d = await r.json() as { ok: boolean; message?: string; summary?: SheetExportSummary }
      if (!d.ok) { setSheetMsg(`建立失敗：${d.message ?? '未知錯誤'}`); return }
      setSheetExport(d.summary ?? null)
    } catch {
      setSheetMsg('建立失敗（網路錯誤）')
    } finally {
      setSheetBusy(false)
    }
  }

  /** 只重送沒成功的格子，寫回同一張表 */
  async function resumeLarkSheet() {
    if (!sheetExport) return
    setSheetMsg(null)
    try {
      const r = await fetch(`/api/ui-screenshot/sheet-export/${sheetExport.id}/resume`, { method: 'POST' })
      const d = await r.json() as { ok: boolean; message?: string; summary?: SheetExportSummary }
      if (!d.ok) { setSheetMsg(`補傳失敗：${d.message ?? '未知錯誤'}`); return }
      setSheetExport(d.summary ?? null)
    } catch {
      setSheetMsg('補傳失敗（網路錯誤）')
    }
  }

  const visibleModels = models.filter(m => {
    const q = modelFilter.trim().toLowerCase()
    return !q || m.key.toLowerCase().includes(q)
  })

  /**
   * 產生驗收報告；`upload` 為 true 時連同原圖 zip 一起送到 Lark 雲端資料夾。
   * ⚠️ 上傳結果要逐項回報（報告、zip 各自成敗）——只說「完成」的話，
   *    zip 太大被擋下來時畫面上看不出來，人會以為原圖也上去了。
   */
  async function generateReport(upload: boolean) {
    if (!runId) return
    setReporting(true)
    setReportMsg(null)
    try {
      const r = await fetch(`/api/ui-screenshot/run/${runId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload, folderUrl: larkFolderUrl.trim() }),
      })
      const data = await r.json() as {
        ok: boolean; message?: string; groups?: number
        upload?: { folderToken?: string; message?: string; files?: number
          html?: { ok: boolean; message?: string }; zip?: { ok: boolean; message?: string } }
      }
      if (!data.ok) { setReportMsg(`產生失敗：${data.message ?? '未知錯誤'}`); return }
      if (!upload) { setReportMsg(`報告已產生（${data.groups ?? 0} 組）`); return }
      const u = data.upload
      if (!u) { setReportMsg('報告已產生，但沒有上傳資訊'); return }
      if (u.message) { setReportMsg(`報告已產生，上傳失敗：${u.message}`); return }
      const htmlOk = u.html?.ok ? '報告 ✓' : `報告 ✗（${u.html?.message ?? '失敗'}）`
      const zipOk = u.zip?.ok ? `原圖 zip ✓（${u.files ?? 0} 檔）` : `原圖 zip ✗（${u.zip?.message ?? '失敗'}）`
      setReportMsg(`${htmlOk}｜${zipOk}`)
    } catch {
      setReportMsg('產生失敗（網路錯誤）')
    } finally {
      setReporting(false)
    }
  }

  async function loadStorage() {
    try {
      const r = await fetch('/api/ui-screenshot/storage')
      const d = await r.json() as { ok: boolean; runs: number; files: number; bytes: number }
      if (d.ok) setStorage({ runs: d.runs, files: d.files, bytes: d.bytes })
    } catch { /* 顯示成「—」就好 */ }
  }

  async function pruneStorage() {
    setStorageMsg(null)
    try {
      const r = await fetch('/api/ui-screenshot/storage/prune', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepRuns: 10, keepDays: 14 }),
      })
      const d = await r.json() as { ok: boolean; removed: string[]; freedBytes: number }
      if (d.ok) {
        setStorageMsg(`已清掉 ${d.removed.length} 次 run，釋放 ${(d.freedBytes / 1048576).toFixed(1)} MB`)
        loadStorage()
      }
    } catch { setStorageMsg('清理失敗') }
  }

  /** 叫 Agent 掃一次大廳，列出有哪些 model 可以拍 */
  async function scanLobby() {
    setScanning(true)
    setScanMsg(null)
    try {
      const r = await fetch('/api/ui-screenshot/scan-lobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ⚠️ 掃描也要吃 Headed 開關：PC 版在無頭瀏覽器下可能沒有 WebGL，
        //    開關對掃描沒作用的話，使用者打開了也不會有任何改變
        body: JSON.stringify({ agentId: selectedAgentId, gameUrlTemplate: gameUrlTemplate.trim(), headed: headedMode, clientType }),
      })
      const data = await r.json() as {
        ok: boolean; message?: string; cardCount?: number
        models?: Array<{ key: string; game: string; model: string; total: number; free: number; sample: string }>
        unparsed?: Array<{ gmid: string; text: string }>
      }
      if (!data.ok) { setScanMsg(data.message ?? '掃描失敗'); return }
      setModels(data.models ?? [])
      setUnparsed(data.unparsed ?? [])
      setScanMsg(`掃描完成：${data.cardCount ?? 0} 台、${(data.models ?? []).length} 個 model`)
    } catch {
      setScanMsg('掃描失敗（網路錯誤）')
    } finally {
      setScanning(false)
    }
  }

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

    // 自動選機模式：清單放「遊戲 / model」，實際機台由 Agent 在大廳當下決定
    const targets = autoPickByGame ? [...selectedModels] : parsedGmids
    if (captureLobby) targets.unshift('__LOBBY__')
    if (targets.length === 0) {
      setError(autoPickByGame ? '請先掃描大廳並勾選要拍的 model（或勾「也拍大廳」）' : '請輸入至少一個 gmid')
      return
    }

    setLogs([])
    setTasks(new Map())
    setWritebackMsg('')

    try {
      const body: Record<string, unknown> = {
        wikiUrl: wikiUrl.trim(),
        gameUrlTemplate: gameUrlTemplate.trim(),
        clientType,
        gmids: targets,
        resolutions: selectedResolutions,
        concurrency: 1,
        options: { dismissPopup, waitForVideo, headedMode, screenshotDelaySeconds, reloadPerResolution, autoPickByGame },
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
      setLogs([`Run ${rid.slice(0, 8)} 啟動，共 ${d.totalTasks ?? '?'} 個任務`])
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

            {/* 客戶端：**使用者自己選**，不從網址猜（H5 的正式網址就帶 platform=pc，猜必錯） */}
            <div className="field" style={{ marginBottom: 12 }}>
              <span>客戶端</span>
              <div className="ui-ss-client-seg">
                {CLIENT_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={running}
                    className={`ui-ss-client-opt${clientType === opt.key ? ' on' : ''}`}
                    onClick={() => setClientType(opt.key)}
                    aria-pressed={clientType === opt.key}
                  >
                    <span className="ui-ss-client-nm">{opt.label}</span>
                    <span className="ui-ss-client-sub">{opt.sub}</span>
                  </button>
                ))}
              </div>
              <span className="field-hint">掃大廳與截圖都用這個值決定流程，<b>不會從網址自動判斷</b></span>
              {hostGuess && hostGuess !== clientType && (
                <span style={{ fontSize: 11.5, color: '#eab308', lineHeight: 1.7 }}>
                  ⚠️ 下面網址的主機看起來是 <b>{hostGuess.toUpperCase()}</b>，跟這裡選的 <b>{clientType.toUpperCase()}</b> 不一致——確認一下是不是選錯了
                </span>
              )}
            </div>

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

            {/* ⚠️ 自動選機以 **model** 為單位，不是遊戲代號：實測一個遊戲代號底下常有多個 model
                （WLZBHELIX 39 台有 14 種），只用遊戲代號分組的話其餘 model 永遠不會被拍到，
                而畫面上看起來「這款有拍」。 */}
            <div className="ui-ss-toggle-row" style={{ marginBottom: 10 }}>
              <div>
                <div className="ui-ss-tgl-label">自動選機（依 model）</div>
                <div className="ui-ss-tgl-sub">
                  掃大廳 → 勾選要拍的 model → 每個 model 自動挑一台沒被佔用的機台。關掉則使用下面的 gmid 清單
                </div>
              </div>
              <div
                className={`ui-ss-toggle${autoPickByGame ? ' on' : ''}`}
                onClick={() => !running && setAutoPickByGame(v => !v)}
                role="switch"
                aria-checked={autoPickByGame}
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && !running && setAutoPickByGame(v => !v)}
              />
            </div>

            {autoPickByGame && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <button
                    className="submit-btn submit-btn--sm" type="button"
                    disabled={running || scanning || !selectedAgentId || !gameUrlTemplate.trim()}
                    onClick={scanLobby}
                    style={{ fontSize: 12, padding: '6px 14px' }}
                  >{scanning ? '掃描中…（最多 2 分鐘）' : '掃描大廳'}</button>
                  {models.length > 0 && (
                    <button className="submit-btn submit-btn--sm" type="button" disabled={running}
                      onClick={() => setShowModelPicker(true)} style={{ fontSize: 12, padding: '6px 14px' }}>
                      選擇 model（已選 {selectedModels.length}）
                    </button>
                  )}
                  {scanMsg && <span style={{ fontSize: 12, color: scanMsg.startsWith('掃描完成') ? '#34d399' : '#f87171' }}>{scanMsg}</span>}
                </div>

                {models.length > 0 && (
                  <div style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.9 }}>
                    已選 <b style={{ color: '#e2e8f0' }}>{selectedModels.length}</b> / {models.length} 個 model
                    ｜預估約 <b style={{ color: '#e2e8f0' }}>
                      {Math.round(selectedModels.length * selectedResolutions.length * (reloadPerResolution ? 25 : 3) / 60)}
                    </b> 分鐘（粗估，不含找台與失敗重試）
                    {unparsed.length > 0 && (
                      <span style={{ color: '#eab308' }}>｜{unparsed.length} 台無法判斷 model（未列入）</span>
                    )}
                  </div>
                )}

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8, color: '#cbd5e1' }}>
                  <input type="checkbox" disabled={running} checked={captureLobby} onChange={e => setCaptureLobby(e.target.checked)} />
                  也拍大廳本身（不進機台）
                </label>
              </div>
            )}

            {/* Manual gmid textarea */}
            <label className="field" style={{ display: autoPickByGame ? 'none' : undefined }}>
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
                <div className="ui-ss-tgl-label">自動關閉彈窗</div>
                {/* ⚠️ 這個開關管的**不只是面額選單**：面額選單、大廳中獎彈窗的 ✕、
                    以及 `Tips: Game exception...(39)` 這類 Confirm 框都歸它管。
                    標題原本寫「自動關閉面額彈窗」、說明只提 `.select-bg`——
                    照字面讀會以為關掉它只是不選面額，實際上是**整套都不關**。 */}
                <div className="ui-ss-tgl-sub">
                  面額選單、大廳中獎彈窗的 ✕、Tips／錯誤提示的 Confirm 都會自動關掉。
                  <b style={{ color: '#eab308' }}>關掉這個開關＝以上全部都不關</b>
                </div>
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
            {/* ⚠️ 預設開。這些遊戲的版型是載入當下依視窗大小決定的——只改視窗大小再截圖，
                拍到的是「用 A 尺寸載入、硬撐成 B 尺寸」，那種畫面看起來有拍到，
                但正是這個工具要抓的版型問題永遠不會出現。 */}
            <div className="ui-ss-toggle-row">
              <div>
                <div className="ui-ss-tgl-label">每個解析度重新載入</div>
                <div className="ui-ss-tgl-sub">
                  關掉會改成「只改視窗大小」：快很多，但版型在載入時決定的遊戲會拍不到真實版型。
                  開著時每張都要重進一次機台，**每台機台約需「解析度數 × 20～30 秒」**
                </div>
              </div>
              <div
                className={`ui-ss-toggle${reloadPerResolution ? ' on' : ''}`}
                onClick={() => !running && setReloadPerResolution(v => !v)}
                role="switch"
                aria-checked={reloadPerResolution}
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && !running && setReloadPerResolution(v => !v)}
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
                                    src={`/api/ui-screenshot/screenshot/${encodeURIComponent(t.run_id)}/${encodeURIComponent(t.gmid)}/${encodeURIComponent(t.resolution)}`}
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
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {t.gmid}
                          {/* 自動選機時實際進的是哪一台——同一組的每張可能不同台 */}
                          {t.actual_gmid && t.actual_gmid !== t.gmid && (
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>@{t.actual_gmid}</div>
                          )}
                        </td>
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

              {/* ── 驗收報告：產生 HTML，可連同原圖 zip 一起上傳 Lark 雲端資料夾 ── */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule, #2d3f55)' }}>
                <label className="field" style={{ marginBottom: 8 }}>
                  <span>Lark 雲端資料夾（報告要傳去哪）</span>
                  <input
                    value={larkFolderUrl}
                    onChange={e => { setLarkFolderUrl(e.target.value); saveSettings({ larkFolderUrl: e.target.value }) }}
                    placeholder="https://xxx.larksuite.com/drive/folder/…"
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                  {/* ⚠️ 這是雲端資料夾（Drive），跟 Wiki／Sheets 是三套不同的 API——貼錯會失敗 */}
                  <span className="field-hint">貼資料夾網址即可；留空則不上傳，只在本機產生報告</span>
                </label>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    className="submit-btn submit-btn--sm" type="button" disabled={reporting}
                    onClick={() => generateReport(false)}
                  >{reporting ? '產生中…' : '產生報告'}</button>
                  <button
                    className="submit-btn submit-btn--sm" type="button" disabled={reporting || !larkFolderUrl.trim()}
                    onClick={() => generateReport(true)}
                    style={{ background: '#2563eb' }}
                  >{reporting ? '處理中…' : '產生並上傳 Lark（含原圖 zip）'}</button>
                  {reportMsg && (
                    <span style={{ fontSize: 12, color: reportMsg.includes('失敗') ? '#f87171' : '#34d399' }}>{reportMsg}</span>
                  )}
                </div>

                {/* ── 自動建 Lark Sheet：只放 gmid＋各尺寸截圖（使用者 2026-09-24 定的版面） ── */}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  <button
                    className="submit-btn submit-btn--sm" type="button"
                    disabled={sheetBusy || sheetRunning || !larkFolderUrl.trim()}
                    onClick={createLarkSheet}
                    style={{ background: '#2563eb' }}
                  >{sheetBusy ? '建立中…' : '建立 Lark Sheet（gmid＋截圖）'}</button>
                  {sheetExport && (() => {
                    const im = sheetExport.images
                    const total = im.ok + im.fail + im.pending
                    const textFail = sheetExport.texts.fail + (sheetExport.running ? 0 : sheetExport.texts.pending)
                    const bad = im.fail + textFail
                    const label = sheetExport.running ? '寫入中'
                      : sheetExport.status === 'done' ? '完成'
                      : sheetExport.status === 'interrupted' ? '中斷（伺服器重啟）' : '部分失敗'
                    return (
                      <span style={{ fontSize: 12, color: bad > 0 || sheetExport.status === 'interrupted' ? '#fbbf24' : '#34d399' }}>
                        {label}｜圖片 {im.ok}/{total}
                        {im.fail > 0 && `，失敗 ${im.fail}`}
                        {textFail > 0 && `｜文字格失敗 ${textFail}`}
                        {sheetExport.no_machine > 0 && `｜${sheetExport.no_machine} 張未取得機台號（列名有標示）`}
                        {sheetExport.message && `｜${sheetExport.message}`}
                        {sheetExport.url && <> ｜<a href={sheetExport.url} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>開啟 Sheet</a></>}
                      </span>
                    )
                  })()}
                  {sheetExport && !sheetExport.running && sheetExport.status !== 'done' && (
                    <button className="btn-ghost" type="button" style={{ fontSize: 12 }} onClick={resumeLarkSheet}>
                      補傳沒成功的格子
                    </button>
                  )}
                  {sheetMsg && <span style={{ fontSize: 12, color: '#f87171' }}>{sheetMsg}</span>}
                </div>
                {sheetExport && sheetExport.failures.length > 0 && !sheetExport.running && (
                  <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6, fontFamily: 'monospace' }}>
                    {sheetExport.failures.slice(0, 5).map(f => (
                      <div key={`${f.row_num}-${f.col_num}`}>第 {f.row_num + 1} 列第 {f.col_num + 1} 欄：{f.error ?? '失敗'}</div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── 儲存空間：截圖不會自己消失，要看得到也要清得掉 ── */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule, #2d3f55)' }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
                  <span style={{ color: '#94a3b8' }}>
                    截圖佔用：
                    {storage
                      ? <b style={{ color: '#e2e8f0' }}> {(storage.bytes / 1048576).toFixed(1)} MB</b>
                      : ' —'}
                    {storage && <span style={{ color: '#64748b' }}>（{storage.runs} 次 run、{storage.files} 個檔案）</span>}
                  </span>
                  <button className="btn-ghost" type="button" style={{ fontSize: 12 }} onClick={loadStorage}>重新計算</button>
                  <button
                    className="btn-ghost" type="button" style={{ fontSize: 12 }}
                    onClick={pruneStorage}
                  >清理舊資料（保留最近 10 次 / 14 天）</button>
                  {storageMsg && <span style={{ fontSize: 12, color: '#34d399' }}>{storageMsg}</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Model 選取彈窗 ──
          ⚠️ 走 Portal：修仙版的 `.osm-page` 帶 transform，會讓裡面的 `position: fixed`
             以它為基準而不是視窗——遮罩會縮成一小塊、內容被切掉（Jackpot 那邊踩過同一個坑）。 */}
      {showModelPicker && (
        <Portal>
        <div className="ui-ss-modal-backdrop" onClick={() => setShowModelPicker(false)}>
          {/* 高度用 maxHeight 不用 height：model 少的時候不要撐出一大片空白 */}
          <div className="ui-ss-modal" style={{ width: 860, maxWidth: '92vw', maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
            <div className="ui-ss-modal-head">
              <span style={{ fontWeight: 700, color: '#f1f5f9' }}>
                選擇要拍的 model
                <span style={{ fontWeight: 400, fontSize: 12, color: '#94a3b8', marginLeft: 10 }}>
                  已選 {selectedModels.length} / {models.length}
                </span>
              </span>
              <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setShowModelPicker(false)}>關閉</button>
            </div>

            <div style={{ padding: '10px 16px', borderBottom: '1px solid #2d3f55', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={modelFilter}
                onChange={e => setModelFilter(e.target.value)}
                placeholder="搜尋遊戲或 model…"
                style={{ flex: '1 1 220px', fontSize: 12, padding: '5px 10px', borderRadius: 6 }}
              />
              <button className="btn-ghost" type="button" style={{ fontSize: 12 }}
                onClick={() => setSelectedModels(visibleModels.map(m => m.key))}>全選（{visibleModels.length}）</button>
              <button className="btn-ghost" type="button" style={{ fontSize: 12 }}
                onClick={() => setSelectedModels(visibleModels.filter(m => m.free > 0).map(m => m.key))}>
                只選有空機（{visibleModels.filter(m => m.free > 0).length}）
              </button>
              <button className="btn-ghost" type="button" style={{ fontSize: 12 }} onClick={() => setSelectedModels([])}>清除</button>
            </div>

            {/* 清單本身：兩欄、名稱完整顯示不截斷 */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '2px 16px' }}>
                {visibleModels.map(m => {
                  const checked = selectedModels.includes(m.key)
                  return (
                    <label key={m.key} style={{
                      display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '6px 8px',
                      borderRadius: 6, cursor: 'pointer',
                      background: checked ? 'rgba(59,130,246,.10)' : 'transparent',
                      opacity: m.free === 0 ? 0.6 : 1,
                    }}>
                      <input
                        type="checkbox" checked={checked}
                        onChange={e => setSelectedModels(prev => e.target.checked ? [...prev, m.key] : prev.filter(k => k !== m.key))}
                        style={{ flexShrink: 0 }}
                      />
                      <span style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 11, flexShrink: 0, width: 130 }}>{m.game}</span>
                      <span style={{ color: '#e2e8f0', flex: 1 }}>{m.model}</span>
                      <span style={{ color: m.free === 0 ? '#f87171' : '#94a3b8', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {m.total} 台・可用 {m.free}
                      </span>
                    </label>
                  )
                })}
                {visibleModels.length === 0 && (
                  <div style={{ color: '#64748b', fontSize: 12, padding: 12 }}>沒有符合搜尋的 model</div>
                )}
              </div>

              {/* ⚠️ 解析不出 model 的機台要看得見，不可以默默消失 */}
              {unparsed.length > 0 && (
                <div style={{ marginTop: 14, fontSize: 11.5, color: '#eab308', lineHeight: 1.8 }}>
                  <b>{unparsed.length} 台無法判斷 model，沒有列在上面</b>（名稱格式不符，需要時請用「自動選機」關閉後手填 gmid）：
                  <div style={{ color: '#a1a1aa', fontFamily: 'monospace', fontSize: 11 }}>
                    {unparsed.slice(0, 12).map(u => u.gmid).join('、')}{unparsed.length > 12 ? ` …共 ${unparsed.length} 台` : ''}
                  </div>
                </div>
              )}
            </div>

            <div style={{ padding: '10px 16px', borderTop: '1px solid #2d3f55', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                已選 {selectedModels.length} 個 × {selectedResolutions.length} 個解析度
                ｜預估約 <b style={{ color: '#e2e8f0' }}>
                  {Math.round(selectedModels.length * selectedResolutions.length * (reloadPerResolution ? 25 : 3) / 60)}
                </b> 分鐘
              </span>
              <span style={{ fontSize: 11, color: '#64748b' }}>「可用」是掃描當下的狀態，實際跑時可能已被佔走（會自動換同 model 的另一台）</span>
              <button className="submit-btn submit-btn--sm" style={{ marginLeft: 'auto', fontSize: 12, padding: '6px 16px' }}
                onClick={() => setShowModelPicker(false)}>完成</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Image Preview Modal ── */}
      {previewTask && (
        <Portal>
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
                src={`/api/ui-screenshot/screenshot/${encodeURIComponent(previewTask.run_id)}/${encodeURIComponent(previewTask.gmid)}/${encodeURIComponent(previewTask.resolution)}`}
                alt={`${previewTask.gmid} ${previewTask.resolution}`}
                style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 6 }}
              />
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  )
}

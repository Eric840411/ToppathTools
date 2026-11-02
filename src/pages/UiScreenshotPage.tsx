import { useCallback, useEffect, useRef, useState } from 'react'
import { PageActions } from '../redesign/PageActions'
import { groupByMachineModel, poolTarget, type LobbyMachine, type MachineModelGroup } from '../../shared/ui-ss-machine-model'
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
  | { type: 'agent_log'; level?: 'warn' | 'info'; message?: string }
  | { type: 'agent_hold'; runId: string; message: string }

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

function MetricCard({ label, value, sub, tone }: { label: string; value: string | number; sub: string; tone?: 'run' | 'pass' | 'warn' | 'fail' }) {
  return (
    <div className={`rn-stat${tone ? ` rn-stat--${tone}` : ''}`}>
      <div className="rn-stat-k">{label}</div>
      <div className="rn-stat-v">{value}</div>
      <div className="rn-stat-s">{sub}</div>
    </div>
  )
}

function ResCheckbox({
  res, checked, onChange, disabled,
}: { res: typeof RESOLUTIONS[0]; checked: boolean; onChange: (k: string) => void; disabled: boolean }) {
  return (
    <label className={`rn-res-item${checked ? ' checked' : ''}`} onClick={() => !disabled && onChange(res.key)} title={`${res.w}×${res.h}`}>
      <input type="checkbox" checked={checked} readOnly />
      <span className="rn-res-lbl">{res.label}</span>
      <span className="rn-res-nm">{res.w}×{res.h}</span>
    </label>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

/** 掃描回來的一個「遊戲 / model」。新版 agent 會帶整組機台，伺服器再按 Machine Model 分組 */
type ScanModel = { key: string; game: string; model: string; total: number; free: number; sample: string; machines?: LobbyMachine[]; machineModels?: MachineModelGroup[] }

/**
 * 選取清單裡的一項：沒有 Machine Model 資料的 model 直接是 `遊戲 / model`；
 * 有的話是 `遊戲 / model::machineType`（每個 Machine Model 一個任務，只從那組 gmid 挑機）
 */
const MM_SEP = '::'
const mmKey = (modelKey: string, machineType: string) => `${modelKey}${MM_SEP}${machineType}`
/** 可以勾的 Machine Model（未同步的那組不能選——不猜） */
const selectableMMs = (m: ScanModel) => (m.machineModels ?? []).filter(g => g.machineType)

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
  const [models, setModels] = useState<ScanModel[]>([])
  /** 這次掃描的 agent 支不支援 Machine Model 白名單（舊 agent 只能選 model） */
  const [poolSupported, setPoolSupported] = useState(false)
  /** Machine Model 資料最後同步時間（機台版本 Dashboard 的 OSM 同步）；null＝從沒同步過 */
  const [osmSyncedAt, setOsmSyncedAt] = useState<number | null>(null)
  const [osmSyncing, setOsmSyncing] = useState(false)
  /** 個別 Machine Model 是否展開 gmid 清單（key = model key + MM_SEP + machineType；未同步用 '_'） */
  const [expandedMMs, setExpandedMMs] = useState<Set<string>>(new Set())
  /** 同分類多款遊戲時，各遊戲名稱底下的 Machine Model 清單可以收起來（預設展開；key = model key） */
  const [collapsedGames, setCollapsedGames] = useState<Set<string>>(new Set())
  const [unparsed, setUnparsed] = useState<Array<{ gmid: string; text: string }>>([])
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [larkFolderUrl, setLarkFolderUrl] = useState(init.larkFolderUrl)
  const [reporting, setReporting] = useState(false)
  const [reportMsg, setReportMsg] = useState<string | null>(null)
  const [sheetExport, setSheetExport] = useState<SheetExportSummary | null>(null)
  const [sheetBusy, setSheetBusy] = useState(false)
  /** agent 收尾後座位不明 → 伺服器把 agent 鎖著，等人確認後手動解除 */
  const [agentHold, setAgentHold] = useState('')
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
        } else if (data.type === 'agent_log') {
          // agent 端不屬於任何一張圖的警告（例如拍完退出機台失敗）
          const m = data
          setLogs(prev => [...prev.slice(-200), `${m.level === 'warn' ? '警告：' : ''}${m.message ?? ''}`])
        } else if (data.type === 'agent_hold') {
          setAgentHold(data.message)
        } else if (data.type === 'run_complete') {
          setRunStatus('done')
          const c = data as SseRunComplete
          const msg = `Run 完成｜OK:${c.ok_count ?? '?'} POPUP:${c.popup_count ?? '?'} ERR:${c.err_count ?? '?'}`
          setLogs(prev => [...prev, msg])
          // ⚠️ 不在這裡關連線：完成事件是**最後一張圖回報時**就發了，agent 之後還要退出機台，
          //    退出失敗的警告（agent_log）會在這之後才來。關掉就收不到了（CodeX 2026-09-24）
        } else if (data.type === 'run_stopped') {
          setRunStatus('stopped')
          setLogs(prev => [...prev, 'Run 已停止'])
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

  // ── agent 鎖定狀態：重新整理頁面後也要看得到（SSE 只推即時的）──────────────
  useEffect(() => {
    setAgentHold('')
    if (!runId) return
    fetch(`/api/ui-screenshot/run/${runId}`)
      .then(r => r.json())
      .then((d: { ok: boolean; run?: { agent_hold?: string } }) => { if (d.ok) setAgentHold(d.run?.agent_hold ?? '') })
      .catch(() => { /* 看不到就不顯示 */ })
  }, [runId, runStatus])

  async function releaseAgent() {
    if (!runId) return
    const r = await fetch(`/api/ui-screenshot/run/${runId}/release-agent`, { method: 'POST' }).catch(() => null)
    if (r?.ok) setAgentHold('')
  }

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
    return !q || m.key.toLowerCase().includes(q) || (m.machineModels ?? []).some(g => (g.machineType ?? '').toLowerCase().includes(q))
  })
    // 同一款遊戲排在一起（使用者 10/02：WLZBHELIX 散在各處不好找）；sort 是穩定排序，同遊戲內維持掃描回來的順序
    .sort((a, b) => a.game.localeCompare(b.game))
  // 已選的統計：Machine Model 選項各自是一個任務
  const selectedMMCount = selectedModels.filter(k => k.includes(MM_SEP)).length
  const selectedModelCount = new Set(selectedModels.map(k => k.split(MM_SEP)[0])).size

  /** 重新同步 OSM（機台版本 Dashboard 那一套），再把目前掃到的機台重新分組——不用再叫 agent 掃一次大廳 */
  async function resyncMachineModels() {
    setOsmSyncing(true)
    try {
      const r = await fetch('/api/osm/sync', { method: 'POST' })
      if (!r.ok && r.status !== 429) throw new Error(`OSM 同步失敗（HTTP ${r.status}）`)
      const gmids = models.flatMap(m => (m.machines ?? []).map(x => x.gmid))
      const t = await fetch('/api/ui-screenshot/machine-types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gmids }) })
      const d = await t.json() as { ok: boolean; types: Record<string, string>; syncedAt: number | null }
      if (d.ok) {
        setModels(prev => prev.map(m => m.machines ? { ...m, machineModels: groupByMachineModel(m.machines, d.types) } : m))
        setOsmSyncedAt(d.syncedAt)
        setSelectedModels([])
      }
    } catch (e) { setScanMsg(String(e)) } finally { setOsmSyncing(false) }
  }

  /** 一個 model 底下的 Machine Model 列：各自點開才列 gmid（紅字＝被佔用）；只有一個可勾的 Machine Model 時不放子勾 */
  function renderMMItems(m: ScanModel) {
    const groups = m.machineModels ?? []
    const subCheck = selectableMMs(m).length > 1
    return (
      <div className="ui-ss-mm-sub">
        {groups.map(g => {
          const k = g.machineType ? mmKey(m.key, g.machineType) : ''
          const on = !!k && selectedModels.includes(k)
          const ek = mmKey(m.key, g.machineType ?? '_')
          const mmOpen = expandedMMs.has(ek)
          const toggleOpen = () => setExpandedMMs(prev => { const n = new Set(prev); if (n.has(ek)) n.delete(ek); else n.add(ek); return n })
          return (
            <div key={g.machineType ?? '_'} className={`ui-ss-mm-item${g.machineType ? '' : ' is-unsynced'}`}>
              <div className="ui-ss-mm-item-row">
                <button type="button" className="ui-ss-mm-caret" aria-expanded={mmOpen} aria-label={mmOpen ? '收合 gmid' : '展開 gmid'} onClick={toggleOpen}>{mmOpen ? '▾' : '▸'}</button>
                {subCheck && (
                  <input type="checkbox" checked={on} disabled={!g.machineType} aria-label={`選取 ${g.machineType ?? '未同步'}`}
                    onChange={e => setSelectedModels(prev => e.target.checked ? [...prev, k] : prev.filter(x => x !== k))} />
                )}
                <button type="button" className="ui-ss-mm-tag ui-ss-mm-tag-btn" onClick={toggleOpen}>{g.machineType ?? '未同步'}</button>
                <span className={`ui-ss-mm-cnt${g.free === 0 ? ' is-full' : ''}`}>{g.total} 台・可用 {g.free}</span>
              </div>
              {mmOpen && (
                <div className="ui-ss-mm-gmids">
                  {g.machines.map((x, i) => <span key={x.gmid} className={x.occupied ? 'is-busy' : ''}>{i ? '、' : ''}{x.gmid}</span>)}
                  {!g.machineType && <em>（機台版本 Dashboard 查不到這幾台，先重新同步）</em>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  /** 三態勾選框：keys 全選＝勾、部分＝半勾；勾／取消一次處理全部 keys */
  function triBox(keys: string[], label: string) {
    const picked = keys.filter(k => selectedModels.includes(k)).length
    const all = keys.length > 0 && picked === keys.length
    return (
      <input type="checkbox" checked={all} disabled={!keys.length} aria-label={label}
        ref={el => { if (el) el.indeterminate = picked > 0 && !all }}
        onChange={e => { const on = e.target.checked; setSelectedModels(prev => on ? [...new Set([...prev, ...keys])] : prev.filter(k => !keys.includes(k))) }} />
    )
  }

  /**
   * 同一個分類（灰字遊戲代碼）一張卡。2026-10-02 需求方：同分類的排在一起、兩邊遊戲名稱都保留、各自的 Machine Model 在底下。
   * - 只有一款遊戲：分類＋名稱同一列（跟以前一樣）
   * - 多款遊戲：分類一列（勾＝全部）＋每款遊戲名稱一列（可收合，勾＝這款全部）＋各自的 Machine Model
   * 只是顯示分組，勾選的 key 還是「model＋Machine Model」，送出的白名單不變。
   */
  function renderMMCategory(cat: string, ms: ScanModel[]) {
    const keysOf = (m: ScanModel) => selectableMMs(m).map(g => mmKey(m.key, g.machineType!))
    const allKeys = ms.flatMap(keysOf)
    const anyOn = allKeys.some(k => selectedModels.includes(k))
    const total = ms.reduce((n, m) => n + m.total, 0)
    const free = ms.reduce((n, m) => n + m.free, 0)
    if (ms.length === 1) {
      const m = ms[0]
      return (
        <div key={m.key} className={`ui-ss-mm${anyOn ? ' is-on' : ''}`}>
          <div className="ui-ss-mm-row">
            {triBox(allKeys, `選取 ${m.key} 底下全部 Machine Model`)}
            <span className="ui-ss-mm-game">{m.game}</span>
            <span className="ui-ss-mm-name">{m.model}</span>
            <span className={`ui-ss-mm-cnt${m.free === 0 ? ' is-full' : ''}`}>{m.total} 台・可用 {m.free}</span>
          </div>
          {renderMMItems(m)}
        </div>
      )
    }
    return (
      <div key={`cat:${cat}`} className={`ui-ss-mm ui-ss-mm-cat${anyOn ? ' is-on' : ''}`}>
        <div className="ui-ss-mm-row">
          {triBox(allKeys, `選取分類 ${cat} 全部遊戲`)}
          <span className="ui-ss-mm-game">{cat}</span>
          <span className="ui-ss-mm-catnote">{ms.length} 款遊戲</span>
          <span className={`ui-ss-mm-cnt${free === 0 ? ' is-full' : ''}`}>{total} 台・可用 {free}</span>
        </div>
        {ms.map(m => {
          const open = !collapsedGames.has(m.key)
          return (
            <div key={m.key} className="ui-ss-mm-sec">
              <div className="ui-ss-mm-row ui-ss-mm-title">
                <button type="button" className="ui-ss-mm-caret" aria-expanded={open} aria-label={open ? `收合 ${m.model}` : `展開 ${m.model}`}
                  onClick={() => setCollapsedGames(prev => { const n = new Set(prev); if (n.has(m.key)) n.delete(m.key); else n.add(m.key); return n })}>{open ? '▾' : '▸'}</button>
                {triBox(keysOf(m), `選取 ${m.model} 底下全部 Machine Model`)}
                <span className="ui-ss-mm-name">{m.model}</span>
                {/* 遊戲名稱這列不放台數：底下每個 Machine Model 自己有，分類那列有總數（需求方：重複、多餘） */}
              </div>
              {open && renderMMItems(m)}
            </div>
          )
        })}
      </div>
    )
  }

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
        models?: ScanModel[]
        unparsed?: Array<{ gmid: string; text: string }>
        features?: string[]
        osmSyncedAt?: number | null
      }
      if (!data.ok) { setScanMsg(data.message ?? '掃描失敗'); return }
      setModels(data.models ?? [])
      setPoolSupported((data.features ?? []).includes('ui-ss-pool'))
      setOsmSyncedAt(data.osmSyncedAt ?? null)
      // 換了一批掃描結果：舊的勾選可能對不上（Machine Model 分組會變），清掉重選，不要留著看不見的勾
      setSelectedModels([])
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
    // Machine Model 選項 → 任務名稱「遊戲 / model / machineType」＋白名單（那組 gmid）
    const pools: Record<string, string[]> = {}
    const pickedTargets = selectedModels.map(k => {
      if (!k.includes(MM_SEP)) return k
      const [modelKey, mt] = k.split(MM_SEP)
      const m = models.find(x => x.key === modelKey)
      const g = m?.machineModels?.find(x => x.machineType === mt)
      if (!m || !g) return ''
      const target = poolTarget(m.game, m.model, mt)
      pools[target] = g.machines.map(x => x.gmid)
      return target
    }).filter(Boolean)
    const targets = autoPickByGame ? pickedTargets : parsedGmids
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
        ...(autoPickByGame && Object.keys(pools).length ? { pools } : {}),
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
    setLogs(prev => [...prev, '已送出停止指令'])
    // ⚠️ 不關連線：按停止之後 agent 還要退出機台，退出失敗的警告要收得到
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
  const runStateTone = runStatus === 'running' ? 'run' as const : runStatus === 'done' ? 'pass' as const : runStatus === 'stopped' ? 'warn' as const : undefined

  return (
    <div className="ui-screenshot-page rn-page">
      {/* ── Page Header ── */}
      <div className="scripted-bet-head">
        <div>
          <h1 className="scripted-bet-title">UI 解析度截圖</h1>
          <p className="scripted-bet-sub">
            從 Lark Wiki 讀取 gmid 清單，批量對 H5 遊戲進行多解析度截圖，結果回寫至 Wiki TABLE。
          </p>
        </div>
        <PageActions className="scripted-bet-actions">
          {running
            ? <button className="submit-btn submit-btn--sm submit-btn--stop rn-btn" type="button" onClick={stop}>停止</button>
            : <button className="submit-btn submit-btn--sm rn-btn" type="button" onClick={start}>開始截圖</button>
          }
        </PageActions>
      </div>

      {/* ── Metrics ── */}
      <div className="rn-stats">
        <MetricCard label="Tasks" value={totalCount || '—'} sub={`共 ${gmids.length} gmids × ${activeResolutions.length} 解析度`} />
        <MetricCard label="OK" value={okCount} sub="截圖成功" tone={okCount > 0 ? 'pass' : undefined} />
        <MetricCard label="POPUP / ERR" value={`${popupCount} / ${errCount}`} sub="有彈窗 / 失敗" tone={(popupCount + errCount) > 0 ? 'warn' : undefined} />
        <MetricCard label="Status" value={runStatus?.toUpperCase() ?? 'IDLE'} sub={running ? `${doneCount}/${totalCount} 完成` : '可設定後執行'} tone={runStateTone} />
      </div>

      {/* ── Main Layout ── */}
      <div className="rn-side-l">
        {/* ── LEFT: Config ── */}
        <div className="rn-col">
          {/* Source */}
          <section className="section-card">
            <h2 className="section-title">資料來源</h2>
            <div className="rn-form">
              {/* 客戶端：**使用者自己選**，不從網址猜（H5 的正式網址就帶 platform=pc，猜必錯） */}
              <span className="rn-l">客戶端</span>
              <div className="rn-tabs rn-tabs--fill" role="group" aria-label="客戶端">
                {CLIENT_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={running}
                    className="rn-tab"
                    onClick={() => setClientType(opt.key)}
                    aria-pressed={clientType === opt.key}
                    title={`${opt.label} ${opt.sub}`}
                  >
                    {opt.label} <span className="rn-tab-sub">{opt.sub}</span>
                  </button>
                ))}
              </div>
              <div className="rn-c2 rn-hint">掃大廳與截圖都用這個值決定流程，<b>不會從網址自動判斷</b></div>
              {hostGuess && hostGuess !== clientType && (
                <div className="rn-c2 rn-hint rn-warn">
                  下面網址的主機看起來是 <b>{hostGuess.toUpperCase()}</b>，跟這裡選的 <b>{clientType.toUpperCase()}</b> 不一致——確認一下是不是選錯了
                </div>
              )}

              {/* Lark Sheet URL + fetch button */}
              <label className="rn-l" htmlFor="uiss-wiki">Lark Sheet URL</label>
              <input
                id="uiss-wiki"
                className="rn-field"
                value={wikiUrl}
                onChange={e => { setWikiUrl(e.target.value); setFetchGmidMsg('') }}
                disabled={running}
                placeholder="https://casinoplus.sg.larksuite.com/sheets/..."
              />
              <div className="rn-c2 rn-inline">
                <button
                  className="btn-ghost rn-btn rn-btn--sm"
                  type="button"
                  disabled={running || fetchingGmids || !wikiUrl.trim()}
                  onClick={fetchGmidsFromLark}
                >
                  {fetchingGmids ? '讀取中…' : '從 Lark 讀取 gmid'}
                </button>
                {fetchGmidMsg && (
                  <span className={`rn-msg-inline ${fetchGmidMsg.startsWith('成功') ? 'rn-ok' : 'rn-err'}`}>
                    {fetchGmidMsg}
                  </span>
                )}
              </div>

              {/* ⚠️ 自動選機以 **model** 為單位，不是遊戲代號：實測一個遊戲代號底下常有多個 model
                  （WLZBHELIX 39 台有 14 種），只用遊戲代號分組的話其餘 model 永遠不會被拍到，
                  而畫面上看起來「這款有拍」。 */}
              <div className="rn-switch-row rn-full">
                <div
                  className={`ui-ss-toggle${autoPickByGame ? ' on' : ''}`}
                  onClick={() => !running && setAutoPickByGame(v => !v)}
                  role="switch"
                  aria-checked={autoPickByGame}
                  aria-label="自動選機（依 model）"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && !running && setAutoPickByGame(v => !v)}
                />
                <div>
                  <div className="rn-switch-label">自動選機（依 model）</div>
                  <div className="rn-hint">
                    掃大廳 → 勾選要拍的 model → 每個 model 自動挑一台沒被佔用的機台。關掉則使用下面的 gmid 清單
                  </div>
                </div>
              </div>

              {autoPickByGame && (
                <div className="rn-full rn-indent">
                  <div className="rn-inline">
                    <button
                      className="btn-ghost rn-btn rn-btn--sm" type="button"
                      disabled={running || scanning || !selectedAgentId || !gameUrlTemplate.trim()}
                      onClick={scanLobby}
                    >{scanning ? '掃描中…（最多 2 分鐘）' : '掃描大廳'}</button>
                    {models.length > 0 && (
                      <button className="btn-ghost rn-btn rn-btn--sm" type="button" disabled={running}
                        onClick={() => setShowModelPicker(true)}>
                        選擇 model（已選 {selectedModels.length}）
                      </button>
                    )}
                    {scanMsg && <span className={`rn-msg-inline ${scanMsg.startsWith('掃描完成') ? 'rn-ok' : 'rn-err'}`}>{scanMsg}</span>}
                  </div>

                  {models.length > 0 && (
                    <div className="rn-hint rn-hint--below">
                      已選 <b>{selectedModelCount}</b> / {models.length} 個 model{selectedMMCount > 0 && <> ・ <b>{selectedMMCount}</b> 種 Machine Model</>}
                      ｜預估約 <b>
                        {Math.round(selectedModels.length * selectedResolutions.length * (reloadPerResolution ? 25 : 3) / 60)}
                      </b> 分鐘（粗估，不含找台與失敗重試）
                      {unparsed.length > 0 && (
                        <span className="rn-warn">｜{unparsed.length} 台無法判斷 model（未列入）</span>
                      )}
                    </div>
                  )}

                  <label className="rn-chk rn-chk--below">
                    <input type="checkbox" disabled={running} checked={captureLobby} onChange={e => setCaptureLobby(e.target.checked)} />
                    <span>也拍大廳本身（不進機台）</span>
                  </label>
                </div>
              )}

              {/* Manual gmid textarea */}
              <div className="rn-form-row" style={{ display: autoPickByGame ? 'none' : undefined }}>
                  <label className="rn-l rn-l--top" htmlFor="uiss-gmids">
                    gmid 清單
                    <span className="rn-l-count">
                      {gmidText.split(/[\n,\s]+/).filter(s => s.trim().length > 0).length} 個
                    </span>
                  </label>
                  <div>
                    <textarea
                      id="uiss-gmids"
                      className="rn-field rn-textarea"
                      value={gmidText}
                      onChange={e => setGmidText(e.target.value)}
                      disabled={running}
                      placeholder={'從 Lark 讀取後自動填入，或手動輸入：\n4179-ARUZE-3062\nJJBX001'}
                    />
                    <div className="rn-hint rn-hint--below">每行一個 gmid，或以逗號 / 空格分隔皆可；可手動修改</div>
                  </div>
              </div>

              <label className="rn-l" htmlFor="uiss-tpl">遊戲 URL Template</label>
              <input
                id="uiss-tpl"
                className="rn-field rn-mono"
                value={gameUrlTemplate}
                onChange={e => setGameUrlTemplate(e.target.value)}
                disabled={running}
                placeholder="https://osm-h5-prod.osmslot.org/?token=...&gameid={gmid}&..."
              />
              <div className="rn-c2 rn-hint">以 {'{gmid}'} 替換 gameid= 的值，其餘參數固定</div>
            </div>
          </section>

          {/* Resolutions */}
          <section className="section-card">
            <h2 className="section-title">
              解析度選擇 {selectedResolutions.length}/{RESOLUTIONS.length}
              <span className="rn-title-meta">
                <button type="button" className="rn-link" onClick={selectAll} disabled={running}>全選</button>
                <span aria-hidden="true">·</span>
                <button type="button" className="rn-link" onClick={clearAll} disabled={running}>清除</button>
              </span>
            </h2>
            {RESOLUTION_GROUPS.map(group => (
              <div key={group} className="rn-res-group">
                <div
                  className="ui-ss-group-label"
                  onClick={() => selectGroup(group)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && selectGroup(group)}
                >
                  {group}
                  <span className="rn-group-count">
                    ({RESOLUTIONS.filter(r => r.group === group && selectedResolutions.includes(r.key)).length}/{RESOLUTIONS.filter(r => r.group === group).length})
                  </span>
                </div>
                <div className="rn-res-grid">
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

          {/* Options（執行裝置＝原本獨立的 Local Agent 面板，原型沒有這塊，併進執行選項第一列） */}
          <section className="section-card">
            <h2 className="section-title">執行選項</h2>
            <div className="rn-form">
              <label className="rn-l" htmlFor="uiss-agent">執行裝置</label>
              <div className="rn-inline">
                <select
                  id="uiss-agent"
                  className="rn-field rn-grow"
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
                <button className="btn-ghost rn-btn rn-btn--sm" type="button" onClick={refreshAgents} disabled={running}>重新整理</button>
              </div>
              <div className="rn-c2 rn-inline rn-agent-line">
                <span className={selectedAgent && !selectedAgent.busy ? 'badge badge--ok' : 'badge badge--warn'}>
                  {selectedAgent && !selectedAgent.busy ? '可用' : selectedAgent?.busy ? '執行中' : '未連線'}
                </span>
                <span className="rn-text-fg">
                  {selectedAgent ? selectedAgent.hostname : '請先啟動 Toppath Local Agent'}
                </span>
                {selectedAgent && !selectedAgent.busy && (
                  <span className="rn-hint">{readyCount} 台空閒</span>
                )}
              </div>
              {agentError && <div className="rn-c2 ui-ss-agent-error">{agentError}</div>}
              <div className="rn-sep" />
            </div>

            <div className="rn-switches">
              <div className="rn-switch-row">
                <div
                  className={`ui-ss-toggle${dismissPopup ? ' on' : ''}`}
                  onClick={() => !running && setDismissPopup(v => !v)}
                  role="switch"
                  aria-checked={dismissPopup}
                  aria-label="自動關閉彈窗"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && !running && setDismissPopup(v => !v)}
                />
                <div>
                  <div className="rn-switch-label">自動關閉彈窗</div>
                  {/* ⚠️ 這個開關管的**不只是面額選單**：面額選單、大廳中獎彈窗的 ✕、
                      以及 `Tips: Game exception...(39)` 這類 Confirm 框都歸它管。
                      標題原本寫「自動關閉面額彈窗」、說明只提 `.select-bg`——
                      照字面讀會以為關掉它只是不選面額，實際上是**整套都不關**。 */}
                  <div className="rn-hint">
                    面額選單、大廳中獎彈窗的 ✕、Tips／錯誤提示的 Confirm 都會自動關掉。
                    <b className="rn-warn">關掉這個開關＝以上全部都不關</b>
                  </div>
                </div>
              </div>
              <div className="rn-switch-row">
                <div
                  className={`ui-ss-toggle${waitForVideo ? ' on' : ''}`}
                  onClick={() => !running && setWaitForVideo(v => !v)}
                  role="switch"
                  aria-checked={waitForVideo}
                  aria-label="等待推流 video 就緒"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && !running && setWaitForVideo(v => !v)}
                />
                <div>
                  <div className="rn-switch-label">等待推流 {'<video>'} 就緒</div>
                  <div className="rn-hint">偵測到 video.readyState≥2 且有寬度後才截圖</div>
                </div>
              </div>
              {/* ⚠️ 預設開。這些遊戲的版型是載入當下依視窗大小決定的——只改視窗大小再截圖，
                  拍到的是「用 A 尺寸載入、硬撐成 B 尺寸」，那種畫面看起來有拍到，
                  但正是這個工具要抓的版型問題永遠不會出現。 */}
              <div className="rn-switch-row">
                <div
                  className={`ui-ss-toggle${reloadPerResolution ? ' on' : ''}`}
                  onClick={() => !running && setReloadPerResolution(v => !v)}
                  role="switch"
                  aria-checked={reloadPerResolution}
                  aria-label="每個解析度重新載入"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && !running && setReloadPerResolution(v => !v)}
                />
                <div>
                  <div className="rn-switch-label">每個解析度重新載入</div>
                  <div className="rn-hint">
                    關掉會改成「只改視窗大小」：快很多，但版型在載入時決定的遊戲會拍不到真實版型。
                    開著時每張都要重進一次機台，<b>每台機台約需「解析度數 × 20～30 秒」</b>
                  </div>
                </div>
              </div>
              <div className="rn-switch-row">
                <div
                  className={`ui-ss-toggle${headedMode ? ' on' : ''}`}
                  onClick={() => !running && setHeadedMode(v => !v)}
                  role="switch"
                  aria-checked={headedMode}
                  aria-label="Headed 模式"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && !running && setHeadedMode(v => !v)}
                />
                <div>
                  <div className="rn-switch-label">Headed 模式</div>
                  <div className="rn-hint">顯示瀏覽器視窗（預設隱藏）</div>
                </div>
              </div>
            </div>

            <div className="rn-form rn-form--after">
              <label className="rn-l" htmlFor="uiss-delay">截圖延遲秒數</label>
              <div className="rn-inline">
                <input
                  id="uiss-delay"
                  className="rn-field rn-w120"
                  type="number"
                  min={0}
                  max={60}
                  value={screenshotDelaySeconds}
                  disabled={running}
                  onChange={e => setScreenshotDelaySeconds(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                />
              </div>
              <div className="rn-c2 rn-hint">進入機器且偵測到遊戲畫面後，再等待資源載入完成才截圖。</div>
            </div>
          </section>

          {error && (
            <div className="ui-ss-error-msg">{error}</div>
          )}
        </div>

        {/* ── RIGHT: Results ── */}
        <div className="rn-col">
          {/* Progress */}
          {totalCount > 0 && (
            <section className="section-card">
              <h2 className="section-title">
                進度
                <span className="rn-title-meta rn-mono">
                  <span className="rn-ok">OK {okCount}</span>
                  <span className="rn-warn">POPUP {popupCount}</span>
                  <span className="rn-err">ERR {errCount}</span>
                  <span>待執行 {totalCount - doneCount}</span>
                </span>
              </h2>
              <div className="rn-meter rn-meter--stack">
                <i className="rn-seg-ok" style={{ width: `${(okCount / totalCount) * 100}%` }} />
                <i className="rn-seg-warn" style={{ width: `${(popupCount / totalCount) * 100}%` }} />
                <i className="rn-seg-err" style={{ width: `${(errCount / totalCount) * 100}%` }} />
              </div>
              <div className="rn-mono rn-hint rn-hint--below">
                {doneCount}/{totalCount} 完成（{pctDone.toFixed(0)}%）
              </div>
            </section>
          )}

          {/* Heatmap / List Panel */}
          <section className="section-card rn-table-panel">
            <h2 className="section-title">
              截圖結果
              <span className="rn-title-meta">
                {(['heatmap', 'list'] as const).map((m, i) => (
                  <span key={m} className="rn-inline-pair">
                    {i > 0 && <span aria-hidden="true">·</span>}
                    <button
                      type="button"
                      className={`rn-link${viewMode === m ? ' is-on' : ''}`}
                      aria-pressed={viewMode === m}
                      onClick={() => setViewMode(m)}
                    >
                      {m === 'heatmap' ? '熱圖' : '清單'}
                    </button>
                  </span>
                ))}
              </span>
            </h2>

            {taskList.length === 0 ? (
              <div className="rn-empty">
                尚未有截圖資料，設定完成後點擊「開始截圖」
              </div>
            ) : viewMode === 'heatmap' ? (
              <div className="table-wrap ui-ss-table-scroll rn-table-wrap">
                <table className="version-table ui-ss-heatmap-table">
                  <thead>
                    <tr>
                      <th>gmid</th>
                      {activeResolutions.map(r => {
                        const info = RESOLUTIONS.find(x => x.key === r)
                        return (
                          <th key={r} title={`${r}`}>
                            <div>{info?.label ?? r}</div>
                            <div className="rn-th-sub">{r}</div>
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
                          if (!t) return <td key={res} className="rn-cell-empty" />
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
                                : <span className={taskBadgeClass(t.status)}>
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
              <div className="table-wrap ui-ss-table-scroll ui-ss-list-scroll rn-table-wrap">
                <table className="version-table ui-ss-list-table">
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
                        <td className="rn-mono">
                          {t.gmid}
                          {/* 自動選機時實際進的是哪一台——同一組的每張可能不同台 */}
                          {t.actual_gmid && t.actual_gmid !== t.gmid && (
                            <div className="rn-th-sub">@{t.actual_gmid}</div>
                          )}
                        </td>
                        <td className="rn-mono">{t.resolution}</td>
                        <td><span className={taskBadgeClass(t.status)}>{taskStatusLabel(t.status)}</span></td>
                        <td className="rn-cell-msg">
                          {t.error_msg ?? '—'}
                        </td>
                        <td>
                          {t.server_path && (
                            <button
                              className="btn-ghost rn-btn rn-btn--xs"
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
          </section>

          {/* Logs */}
          <section className="section-card">
            <h2 className="section-title">執行日誌</h2>
            {/* 座位不明時 agent 被鎖著：不處理的話下一輪開不了，而且畫面上看不出為什麼 */}
            {agentHold && (
              <div className="rn-notice rn-notice--warn">
                <span>{agentHold}。agent 已鎖住，請先到該機台確認座位已釋放。</span>
                <button className="btn-ghost rn-btn rn-btn--sm" type="button" onClick={releaseAgent}>
                  我已確認座位釋放，解除 agent 鎖定
                </button>
              </div>
            )}
            <div className="ui-ss-log-panel rn-log" ref={logPanelRef}>
              {logs.length === 0
                ? <span className="rn-dim">（等待任務開始）</span>
                : logs.map((l, i) => <div key={i} className="ui-ss-log-line">{l}</div>)
              }
            </div>
          </section>

          {/* Export / Writeback */}
          {runStatus === 'done' && runId && (
            <section className="section-card">
              <h2 className="section-title">匯出與回寫</h2>
              <div className="rn-inline">
                <button
                  className="submit-btn submit-btn--sm rn-btn"
                  type="button"
                  onClick={writeback}
                  disabled={writingBack}
                >
                  {writingBack ? '回寫中…' : '回寫至 Lark Wiki'}
                </button>
                {writebackMsg && (
                  <span className={`rn-msg-inline ${writebackMsg.includes('失敗') ? 'rn-err' : 'rn-ok'}`}>
                    {writebackMsg}
                  </span>
                )}
              </div>

              {/* ── 驗收報告：產生 HTML，可連同原圖 zip 一起上傳 Lark 雲端資料夾 ── */}
              <div className="rn-subsec">
                <div className="rn-form">
                  <label className="rn-l rn-l--top" htmlFor="uiss-folder">Lark 雲端資料夾</label>
                  <div>
                    <input
                      id="uiss-folder"
                      className="rn-field rn-mono"
                      value={larkFolderUrl}
                      onChange={e => { setLarkFolderUrl(e.target.value); saveSettings({ larkFolderUrl: e.target.value }) }}
                      placeholder="https://xxx.larksuite.com/drive/folder/…"
                    />
                    {/* ⚠️ 這是雲端資料夾（Drive），跟 Wiki／Sheets 是三套不同的 API——貼錯會失敗 */}
                    <div className="rn-hint rn-hint--below">報告要傳去哪。貼資料夾網址即可；留空則不上傳，只在本機產生報告</div>
                  </div>
                </div>
                <div className="rn-inline rn-row-gap">
                  <button
                    className="btn-ghost rn-btn rn-btn--sm" type="button" disabled={reporting}
                    onClick={() => generateReport(false)}
                  >{reporting ? '產生中…' : '產生報告'}</button>
                  <button
                    className="submit-btn submit-btn--sm rn-btn rn-btn--sm" type="button" disabled={reporting || !larkFolderUrl.trim()}
                    onClick={() => generateReport(true)}
                  >{reporting ? '處理中…' : '產生並上傳 Lark（含原圖 zip）'}</button>
                  {reportMsg && (
                    <span className={`rn-msg-inline ${reportMsg.includes('失敗') ? 'rn-err' : 'rn-ok'}`}>{reportMsg}</span>
                  )}
                </div>

                {/* ── 自動建 Lark Sheet：只放 gmid＋各尺寸截圖（使用者 2026-09-24 定的版面） ── */}
                <div className="rn-inline rn-row-gap">
                  <button
                    className="submit-btn submit-btn--sm rn-btn rn-btn--sm" type="button"
                    disabled={sheetBusy || sheetRunning || !larkFolderUrl.trim()}
                    onClick={createLarkSheet}
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
                      <span className={`rn-msg-inline ${bad > 0 || sheetExport.status === 'interrupted' ? 'rn-warn' : 'rn-ok'}`}>
                        {label}｜圖片 {im.ok}/{total}
                        {im.fail > 0 && `，失敗 ${im.fail}`}
                        {textFail > 0 && `｜文字格失敗 ${textFail}`}
                        {sheetExport.no_machine > 0 && `｜${sheetExport.no_machine} 張未取得機台號（列名有標示）`}
                        {sheetExport.message && `｜${sheetExport.message}`}
                        {sheetExport.url && <> ｜<a href={sheetExport.url} target="_blank" rel="noreferrer" className="rn-a">開啟 Sheet</a></>}
                      </span>
                    )
                  })()}
                  {sheetExport && !sheetExport.running && sheetExport.status !== 'done' && (
                    <button className="btn-ghost rn-btn rn-btn--sm" type="button" onClick={resumeLarkSheet}>
                      補傳沒成功的格子
                    </button>
                  )}
                  {sheetMsg && <span className="rn-msg-inline rn-err">{sheetMsg}</span>}
                </div>
                {sheetExport && sheetExport.failures.length > 0 && !sheetExport.running && (
                  <div className="rn-mono rn-hint rn-hint--below">
                    {sheetExport.failures.slice(0, 5).map(f => (
                      <div key={`${f.row_num}-${f.col_num}`}>第 {f.row_num + 1} 列第 {f.col_num + 1} 欄：{f.error ?? '失敗'}</div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── 儲存空間：截圖不會自己消失，要看得到也要清得掉 ── */}
              <div className="rn-subsec">
                <div className="rn-inline">
                  <span className="rn-text">
                    截圖佔用：
                    {storage
                      ? <b className="rn-text-fg"> {(storage.bytes / 1048576).toFixed(1)} MB</b>
                      : ' —'}
                    {storage && <span className="rn-dim">（{storage.runs} 次 run、{storage.files} 個檔案）</span>}
                  </span>
                  <button className="btn-ghost rn-btn rn-btn--sm" type="button" onClick={loadStorage}>重新計算</button>
                  <button
                    className="btn-ghost rn-btn rn-btn--sm" type="button"
                    onClick={pruneStorage}
                  >清理舊資料（保留最近 10 次 / 14 天）</button>
                  {storageMsg && <span className="rn-msg-inline rn-ok">{storageMsg}</span>}
                </div>
              </div>
            </section>
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
                  已選 {selectedModelCount} 個 model{selectedMMCount > 0 ? ` ・ ${selectedMMCount} 種 Machine Model` : ''}
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
                onClick={() => setSelectedModels(visibleModels.flatMap(m => selectableMMs(m).length ? selectableMMs(m).map(g => mmKey(m.key, g.machineType!)) : (m.machineModels ? [] : [m.key])))}>全選（{visibleModels.length}）</button>
              <button className="btn-ghost" type="button" style={{ fontSize: 12 }}
                onClick={() => setSelectedModels(visibleModels.flatMap(m => m.machineModels ? selectableMMs(m).filter(g => g.free > 0).map(g => mmKey(m.key, g.machineType!)) : (m.free > 0 ? [m.key] : [])))}>
                只選有空機（{visibleModels.filter(m => m.free > 0).length}）
              </button>
              <button className="btn-ghost" type="button" style={{ fontSize: 12 }}
                onClick={() => setExpandedMMs(prev => prev.size ? new Set() : new Set(visibleModels.flatMap(m => (m.machineModels ?? []).map(g => mmKey(m.key, g.machineType ?? '_')))))}>
                {expandedMMs.size ? '全部收合' : '全部展開'}
              </button>
              <button className="btn-ghost" type="button" style={{ fontSize: 12 }} onClick={() => setSelectedModels([])}>清除</button>
            </div>

            {/* Machine Model 來源：機台版本 Dashboard 的 OSM 同步。舊 agent 沒有整組 gmid，只能選 model */}
            <div className="ui-ss-mm-sync">
              {poolSupported ? (
                <>
                  <span className={`ui-ss-mm-dot${osmSyncedAt ? '' : ' is-off'}`} />
                  Machine Model 來源：機台版本 Dashboard，{osmSyncedAt ? `最近同步 ${new Date(osmSyncedAt).toLocaleString('zh-TW', { hour12: false })}` : '還沒同步過（全部會是「未同步」）'}
                  <button className="btn-ghost" type="button" style={{ fontSize: 11, padding: '2px 10px' }} disabled={osmSyncing} onClick={() => void resyncMachineModels()}>
                    {osmSyncing ? '同步中…' : '重新同步'}
                  </button>
                </>
              ) : (
                <span style={{ color: '#eab308' }}>這台 Local Agent 版本較舊，只能選 model。更新 agent 後重新掃描，才能選 Machine Model。</span>
              )}
            </div>

            {/* 清單本身：兩欄、名稱完整顯示不截斷 */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '2px 16px' }}>
                {visibleModels.flatMap((m, i) => {
                  if (m.machineModels) {
                    // visibleModels 已依分類排序：同分類只在第一個出現時畫一張卡，後面的併進去
                    const prev = visibleModels[i - 1]
                    if (prev?.machineModels && prev.game === m.game) return []
                    const same: ScanModel[] = []
                    for (let j = i; j < visibleModels.length && visibleModels[j].game === m.game && visibleModels[j].machineModels; j++) same.push(visibleModels[j])
                    return [renderMMCategory(m.game, same)]
                  }
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
              <span style={{ fontSize: 11, color: '#64748b' }}>「可用」是掃描當下的狀態，實際跑時可能已被佔走（會自動換同 model 的另一台；勾了 Machine Model 的只會在那組裡換，全被佔就該項失敗）</span>
              <button className="submit-btn submit-btn--sm" style={{ marginLeft: 'auto', fontSize: 12, padding: '6px 16px', whiteSpace: 'nowrap', flexShrink: 0 }}
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

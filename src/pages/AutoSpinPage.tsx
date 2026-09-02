import { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import { UrlPoolPickerModal } from '../components/UrlPoolPickerModal'

/** 下載完整執行日誌（不受目前的搜尋/分類篩選影響，永遠是全部原始內容）——
 * 先前使用者只能手動選取複製，長日誌貼進 Discord 會被截斷成 message.txt
 * 附件，格式跟排版都會跑掉，不方便拿來對照時間軸。 */
function downloadExecutionLog(lines: string[]) {
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  a.download = `autospin-log_${ts}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

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
  logApiEnv: string
}

interface CaptureFile {
  name: string
  dir: string
  mtime: number
}

// ─── Log classification (for filter chips / hide-pinus toggle) ─────────────────

type LogCategory = 'sys' | 'spin' | 'shot' | 'warn' | 'err' | 'pinus' | 'other'

function classifyLogLine(l: string): LogCategory {
  if (l.includes('[pinus:')) return 'pinus'
  if (l.includes('[console:error]')) return 'err'
  if (l.includes('[console:warn]')) return 'warn'
  if (l.includes('ERROR') || l.includes('[stderr]') || l.includes('錯誤') || l.includes('失敗') || l.includes('逾時')) return 'err'
  if (l.includes('WARNING') || l.includes('警') || l.includes('警告')) return 'warn'
  if (l.includes('[截圖]') || l.includes('截圖已上傳')) return 'shot'
  if (/Spin #\d+/.test(l) || l.includes('Spin 耗時')) return 'spin'
  if (l.includes('[系統]') || l.includes('[Agent]')) return 'sys'
  return 'other'
}

// ─── Pinus sub-categories (for the pinus category chips) ───────────────────────

type PinusCategory = 'connect' | 'enter' | 'spin' | 'money' | 'broadcast' | 'heartbeat' | 'other'

const PINUS_CATEGORY_META: { key: PinusCategory; label: string }[] = [
  { key: 'spin', label: 'Spin 動作' },
  { key: 'money', label: '餘額異動' },
  { key: 'broadcast', label: '狀態廣播' },
  { key: 'enter', label: '進入遊戲' },
  { key: 'connect', label: '連線/登入' },
  { key: 'heartbeat', label: '心跳/列表' },
  { key: 'other', label: '其他' },
]

function classifyPinusRoute(l: string): PinusCategory {
  if (l.includes('dealGMActionReq')) return 'spin'
  if (l.includes('moneyNtc')) return 'money'
  if (l.includes('broadcastReq')) return 'broadcast'
  if (l.includes('enterGMNtc') || l.includes('leaveGMNtc')) return 'enter'
  if (l.includes('gateHandler.loginReq') || l.includes('entryHandler.enterReq') || l.includes('[push] close')) return 'connect'
  if (l.includes('heartReq') || l.includes('getGMLockListReq') || l.includes('getAllGMListReq')) return 'heartbeat'
  return 'other'
}

function relativeShotTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return '剛剛'
  if (s < 60) return `${s}秒前`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}分前`
  const h = Math.round(m / 60)
  return `${h}小時前`
}

function extractSpinNo(name: string): string | null {
  const m = name.match(/_(\d+)\.png$/i)
  return m ? String(parseInt(m[1], 10)) : null
}

const EMPTY_CONFIG: AutospinConfig = {
  machineType: '', gameUrl: '', rtmpName: '', rtmpUrl: '',
  gameTitleCode: '', templateType: '', errorTemplateType: '',
  enabled: true, enableRecording: true, enableTemplateDetection: true, notes: '',
  spinInterval: 1.0, randomExitEnabled: false, randomExitChance: 0.02,
  randomExitMinSpins: 50, betRandomEnabled: false, lowBalanceThreshold: 0, larkWebhook: '', machineNo: '',
  logApiEnv: 'qat',
}

// ─── Component ─────────────────────────────────────────────────────────────────

function getGlobalUserLabel(): string {
  try {
    const acc = JSON.parse(sessionStorage.getItem('global_jira_account') ?? 'null')
    return acc?.label ?? ''
  } catch { return '' }
}

/** 簡易開關按鈕，點擊即切換，不用進編輯視窗 */
function ToggleSwitch({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={checked ? '點擊停用' : '點擊啟用'}
      style={{
        width: 36, height: 20, borderRadius: 10, padding: 0, flexShrink: 0,
        background: checked ? 'var(--xx-jade, #75d7cf)' : '#1e2733',
        border: `1px solid ${checked ? 'var(--xx-jade, #75d7cf)' : '#3a4552'}`,
        boxShadow: checked ? '0 0 10px 1px rgba(117, 215, 207, .55)' : 'none',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        position: 'relative',
        transition: 'background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 1, left: checked ? 17 : 1, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s ease',
      }} />
    </button>
  )
}

/**
 * 這頁原本完全沒有 themeMode，所以普通版／修仙版看起來一模一樣
 * （使用者 2026-08-31 回報）。差異只有 xianxia-complete.css 全域規則
 * 意外掃到的部分（例如表頭變成古金襯線），不是設計出來的。
 *
 * 皮膚只換「外框語言」——標題用詞與字體。**資料欄位的用詞兩版完全相同**：
 * 相符／掉單／僅後台有／查詢區間／機台篩選 都是使用者剛反映過看不懂才改清楚的，
 * 再套一層修仙詞會把剛修好的可讀性弄丟（見 feedback_theme_skin_vs_architecture）。
 */
export function AutoSpinPage({ themeMode = 'classic' }: { themeMode?: 'classic' | 'xianxia' } = {}) {
  const isXianxia = themeMode === 'xianxia'
  /** 面板標題：修仙版古金襯線 + 角標，普通版乾淨無襯線 */
  const panelTitle = (_t: string, size = 13): React.CSSProperties => ({
    fontWeight: 700, fontSize: size, marginBottom: 8,
    color: isXianxia ? 'var(--cr-violet)' : '#e2e8f0',
    fontFamily: isXianxia ? '"Noto Serif TC", serif' : 'inherit',
    letterSpacing: isXianxia ? '.06em' : undefined,
  })
  const T = (classic: string, xianxia: string) => (isXianxia ? xianxia : classic)

  const [tab, setTab] = useState<'configs' | 'templates' | 'history' | 'reconcile' | 'compare3' | 'run' | 'jpgroups'>('configs')

  // ── Config tab ──────────────────────────────────────────────────────────────
  const [configs, setConfigs] = useState<AutospinConfig[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingType, setEditingType] = useState<string | null>(null)
  const [form, setForm] = useState<AutospinConfig>(EMPTY_CONFIG)
  const [showUrlPicker, setShowUrlPicker] = useState(false)
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
      logApiEnv: c.logApiEnv ?? 'qat',
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

  // 複製既有機台設定當作新機台的起點——machineType 是主鍵必須清空重填，其餘欄位（模板/RTMP/
  // 隨機下注等）原樣帶入，不用使用者從頭重新填一次
  const handleCopyConfig = (c: AutospinConfig) => {
    setEditingType(null)
    setForm({ ...c, machineType: '' })
    setConfigMsg('')
    setShowForm(true)
  }

  // 直接在列表切換布林欄位（啟用/啟用錄影/啟用模板偵測/隨機下注/隨機離開），不用點進編輯視窗
  const [togglingKey, setTogglingKey] = useState<string | null>(null)
  const handleToggleField = async (c: AutospinConfig, field: 'enabled' | 'enableRecording' | 'enableTemplateDetection' | 'betRandomEnabled' | 'randomExitEnabled') => {
    const toggleKey = `${c.machineType}:${field}`
    setTogglingKey(toggleKey)
    const nextValue = !c[field]
    setConfigs(prev => prev.map(x => x.machineType === c.machineType ? { ...x, [field]: nextValue } : x))
    try {
      const r = await fetch('/api/autospin/configs', {
        method: 'POST', headers: userHeaders, body: JSON.stringify({ ...c, [field]: nextValue }),
      })
      const d = await r.json() as { ok: boolean; message?: string }
      if (!d.ok) {
        setConfigs(prev => prev.map(x => x.machineType === c.machineType ? { ...x, [field]: c[field] } : x))
        setConfigMsg(d.message ?? '切換失敗')
      }
    } catch {
      setConfigs(prev => prev.map(x => x.machineType === c.machineType ? { ...x, [field]: c[field] } : x))
      setConfigMsg('切換失敗：網路錯誤')
    } finally {
      setTogglingKey(null)
    }
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
  const [rcConfigMsg, setRcConfigMsg] = useState('')
  const [rcRunning, setRcRunning] = useState(false)
  /** 對帳用哪個環境。對應共用設定 meter_reconcile_config 的 osm_/gcp_ 兩組前綴 */
  const [rcEnv, setRcEnv] = useState<'osm' | 'gcp'>('osm')
  /** 日期快捷。'custom' 才展開起訖日期輸入 */
  const [rcDatePreset, setRcDatePreset] = useState<'today' | 'yesterday' | '7d' | 'custom'>('yesterday')

  // ⚠️ 預設快捷一定要**同時**把日期填進去。
  //    只設 preset 不設日期的話，按鈕看起來是選中的、但 rcRangeStart/End 是空字串，
  //    而 runReconcile() 開頭有 `if (!rcRangeStart || !rcRangeEnd) return` ——
  //    使用者一載入頁面就按「執行對帳」會**完全沒反應**（請求根本沒發出去），
  //    只有一行容易錯過的小字提示。實測就是這樣，驗證時發現 reconcile/run 從未被呼叫。
  useEffect(() => {
    if (rcRangeStart || rcRangeEnd) return   // 使用者已經動過就不要覆蓋
    const d = new Date()
    d.setDate(d.getDate() - 1)               // 對應預設的「昨天」
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    setRcRangeStart(`${day} 00:00:00`)
    setRcRangeEnd(`${day} 23:59:59`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [rcRangeStart, setRcRangeStart] = useState('')
  const [rcRangeEnd, setRcRangeEnd] = useState('')
  const [rcMachineType, setRcMachineType] = useState('')
  const [rcPlayerId, setRcPlayerId] = useState('')
  const [rcResult, setRcResult] = useState<null | { summary: string; notice?: string; backendOnly?: number; backendStatus?: string; backendError?: { type: string; message: string; backendCode?: number; page?: number } | null; details: {status:string;uid:string;time:string;bet:number;win:number;note:string}[]; backendAnomalies: {uid:string;time:string;bet:number;win:number;note:string}[] }>(null)
  const [rcReports, setRcReports] = useState<{id:number;runAt:number;rangeStart:string;rangeEnd:string;machineType:string;frontCount:number;backendCount:number;matchedCount:number;unmatchedCount:number;anomalyCount:number;summary:string;backendStatus?:string}[]>([])

  // 連線設定改成讀共用的 meter_reconcile_config（由後端依環境挑），
  // 前端不再自己抓一份、也不再有畫面可以編輯它——原本的 fetchRcConfig 與
  // rcConfig state 都已移除，留著只會讓人以為這頁還有自己的設定。


  const testRcConnection = async () => {
    setRcConfigMsg('測試中...')
    const r = await fetch('/api/autospin/reconcile/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: rcEnv }) })
    const d = await r.json() as { ok: boolean; message?: string }
    setRcConfigMsg(d.ok ? `通過 ${d.message}` : `失敗 ${d.message}`)
  }

  const runReconcile = async () => {
    if (!rcRangeStart || !rcRangeEnd) { setRcConfigMsg('請填寫時間範圍'); return }
    setRcRunning(true); setRcResult(null)
    try {
      const r = await fetch('/api/autospin/reconcile/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-label': getGlobalUserLabel() },
        body: JSON.stringify({ rangeStart: rcRangeStart, rangeEnd: rcRangeEnd, machineType: rcMachineType, playerId: rcPlayerId, env: rcEnv }),
      })
      type RcDetail = { status: string; uid: string; time: string; bet: number; win: number; note: string }
      type RcAnomaly = { uid: string; time: string; bet: number; win: number; note: string }
      const d = await r.json() as { ok: boolean; summary?: string; notice?: string; backendOnly?: number; backendStatus?: string; backendError?: { type: string; message: string; backendCode?: number; page?: number } | null; details?: RcDetail[]; backendAnomalies?: RcAnomaly[]; message?: string }
      if (d.ok) setRcResult({ summary: d.summary ?? '', notice: d.notice ?? '', backendOnly: d.backendOnly ?? 0, backendStatus: d.backendStatus, backendError: d.backendError ?? null, details: d.details ?? [], backendAnomalies: d.backendAnomalies ?? [] })
      else setRcConfigMsg(`失敗 ${d.message}`)
      fetchRcReports()
    } finally { setRcRunning(false) }
  }

  const fetchRcReports = async () => {
    const r = await fetch('/api/autospin/reconcile/reports')
    const d = await r.json() as { reports?: typeof rcReports }
    setRcReports(d.reports ?? [])
  }

  // ── 三路對帳 tab（SLS recordBet / 盒子日誌 / Pinus history）───────────────────
  interface CompareField { source: 'sls' | 'box' | 'pinus'; path: string; label?: string }
  interface CompareGroupDef { id: string; name: string; fields: CompareField[]; tolerance: number }
  interface CompareMachineRow { sessionId: string; machineType: string; agentLabel: string; compared: number; matched: number; mismatched: number; missing: number }
  interface CompareDetailGroup { groupId: string; groupName: string; values: { source: string; path: string; value: unknown }[]; status: string; note: string }
  interface CompareDetailRow { spinIndex: number; spinTime: string; status: string; groups: CompareDetailGroup[] }

  const SRC_LABEL: Record<CompareField['source'], string> = { sls: 'SLS', box: '盒子', pinus: 'Pinus' }
  const SRC_COLOR: Record<CompareField['source'], { bg: string; fg: string }> = {
    sls: { bg: 'rgba(56,189,248,.15)', fg: '#38bdf8' },
    box: { bg: 'rgba(251,146,60,.15)', fg: '#fb923c' },
    pinus: { bg: 'var(--cr-violet-soft)', fg: 'var(--cr-violet)' },
  }
  // 每個來源實際存在的欄位（不讓使用者手打路徑，直接從真實資料結構挑）——
  // SLS 取自 recordBet log 的 requestJSON/responseJSON（server/lib/sls.ts SlsBetRecord.raw 結構）；
  // Pinus 取自 reconcile_front_records 正規化後的欄位；盒子日誌尚未串接，只先預留使用者原本提過的
  // 欄位名稱（fresh_current_credits），選了也會固定顯示缺資料直到真的串接
  const FIELD_CATALOG: Record<CompareField['source'], { path: string; label: string }[]> = {
    sls: [
      { path: 'requestJSON.amount', label: '下注金額（amount）' },
      { path: 'requestJSON.validBet', label: '有效下注（validBet）' },
      { path: 'requestJSON.payout', label: '派彩金額（payout）' },
      { path: 'requestJSON.moneyAfter', label: '下注後餘額（moneyAfter）' },
      { path: 'requestJSON.usedCash', label: '使用現金（usedCash）' },
      { path: 'requestJSON.usedMoneyMud', label: '使用泥碼（usedMoneyMud）' },
      { path: 'requestJSON.remainingMoneyMud', label: '剩餘泥碼（remainingMoneyMud）' },
      { path: 'requestJSON.initialMoneyMud', label: '初始泥碼（initialMoneyMud）' },
      { path: 'requestJSON.roundId', label: '回合 ID（roundId）' },
      { path: 'requestJSON.machineId', label: '機台代碼（machineId）' },
      { path: 'requestJSON.betTimestamp', label: '下注時間戳（betTimestamp）' },
      { path: 'requestJSON.payoutTimestamp', label: '派彩時間戳（payoutTimestamp）' },
      { path: 'responseJSON.balance', label: '即時餘額（balance）' },
      { path: 'responseJSON.moneyMud', label: '泥碼餘額（moneyMud）' },
      { path: 'responseJSON.error', label: '錯誤碼（error）' },
    ],
    pinus: [
      { path: 'bet', label: '下注額（bet）' },
      { path: 'win', label: '贏分（win）' },
      { path: 'orderId', label: '訂單 ID（orderId）' },
      { path: 'recordTime', label: '紀錄時間（recordTime）' },
      { path: 'gmid', label: 'gmid' },
      { path: 'gameid', label: 'gameid' },
    ],
    box: [
      { path: 'fresh_current_credits', label: '目前分數（fresh_current_credits，尚未串接）' },
    ],
  }

  const [cmpGroups, setCmpGroups] = useState<CompareGroupDef[]>([])
  const [cmpGroupsMsg, setCmpGroupsMsg] = useState('')
  const [cmpMachines, setCmpMachines] = useState<CompareMachineRow[]>([])
  const [cmpSessionCount, setCmpSessionCount] = useState(0)
  const [cmpHasBoxLeg, setCmpHasBoxLeg] = useState(false)
  /** 從執行監控的摘要點進來時要聚焦哪一台。點總摘要就是 null（不聚焦） */
  const [cmpFocusMachine, setCmpFocusMachine] = useState<string | null>(null)
  const [cmpExpanded, setCmpExpanded] = useState<string | null>(null)
  const [cmpDetail, setCmpDetail] = useState<Record<string, CompareDetailRow[]>>({})
  const [cmpConfigOpen, setCmpConfigOpen] = useState(false)
  const [cmpLastUpdated, setCmpLastUpdated] = useState<number | null>(null)
  const [cmpRunNowMsg, setCmpRunNowMsg] = useState('')
  const [cmpEnabled, setCmpEnabled] = useState(true)
  const [cmpEnabledLoading, setCmpEnabledLoading] = useState(false)

  const fetchComparePrefs = async () => {
    const r = await fetch('/api/autospin/compare/prefs', { headers: { 'x-user-label': getGlobalUserLabel() } })
    const d = await r.json() as { ok: boolean; compareEnabled?: boolean }
    if (d.ok) setCmpEnabled(d.compareEnabled ?? true)
  }
  const toggleCompareEnabled = async () => {
    setCmpEnabledLoading(true)
    const next = !cmpEnabled
    try {
      await fetch('/api/autospin/compare/prefs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user-label': getGlobalUserLabel() },
        body: JSON.stringify({ compareEnabled: next }),
      })
      setCmpEnabled(next)
    } finally { setCmpEnabledLoading(false) }
  }

  const fetchCompareDetail = useCallback(async (sessionId: string, machineType: string) => {
    const r = await fetch(`/api/autospin/compare/detail/${encodeURIComponent(machineType)}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { 'x-user-label': getGlobalUserLabel() } })
    const d = await r.json() as { ok: boolean; rows?: CompareDetailRow[] }
    if (d.ok) setCmpDetail(prev => ({ ...prev, [`${sessionId}:${machineType}`]: d.rows ?? [] }))
  }, [])

  const fetchCompareStatus = useCallback(async () => {
    const r = await fetch('/api/autospin/compare/status', { headers: { 'x-user-label': getGlobalUserLabel() } })
    const d = await r.json() as { ok: boolean; machines?: CompareMachineRow[]; sessionCount?: number; hasBoxLeg?: boolean }
    if (!d.ok) return
    setCmpMachines(d.machines ?? [])
    setCmpSessionCount(d.sessionCount ?? 0)
    setCmpHasBoxLeg(!!d.hasBoxLeg)
    setCmpLastUpdated(Date.now())
    if (cmpExpanded) {
      const [sid, mt] = cmpExpanded.split(':')
      if (sid && mt) fetchCompareDetail(sid, mt)
    }
  }, [cmpExpanded, fetchCompareDetail])

  const toggleCompareDetail = (sessionId: string, machineType: string) => {
    const key = `${sessionId}:${machineType}`
    if (cmpExpanded === key) { setCmpExpanded(null); return }
    setCmpExpanded(key)
    fetchCompareDetail(sessionId, machineType)
  }

  const fetchCompareGroups = async () => {
    const r = await fetch('/api/autospin/compare/groups')
    const d = await r.json() as { ok: boolean; groups?: CompareGroupDef[] }
    setCmpGroups(d.groups ?? [])
  }

  const saveCompareGroups = async () => {
    setCmpGroupsMsg('')
    const r = await fetch('/api/autospin/compare/groups', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: cmpGroups }),
    })
    const d = await r.json() as { ok: boolean; groups?: CompareGroupDef[] }
    if (d.ok) { setCmpGroups(d.groups ?? []); setCmpGroupsMsg('通過 已儲存') } else setCmpGroupsMsg('失敗 儲存失敗')
  }

  const runCompareNow = async () => {
    setCmpRunNowMsg('試算中...')
    const r = await fetch('/api/autospin/compare/run-now', { method: 'POST' })
    const d = await r.json() as { ok: boolean }
    setCmpRunNowMsg(d.ok ? '通過 已試算' : '失敗 試算失敗')
    fetchCompareStatus()
  }

  const addCompareGroup = () => setCmpGroups(gs => [...gs, { id: '', name: '新群組', fields: [], tolerance: 0.01 }])
  const removeCompareGroup = (idx: number) => setCmpGroups(gs => gs.filter((_, i) => i !== idx))
  const updateCompareGroupName = (idx: number, name: string) => setCmpGroups(gs => gs.map((g, i) => i === idx ? { ...g, name } : g))
  const addCompareField = (idx: number, source: CompareField['source'], path: string) => {
    if (!path) return
    setCmpGroups(gs => gs.map((g, i) => {
      if (i !== idx) return g
      if (g.fields.some(f => f.source === source && f.path === path)) return g // 已經選過同一個欄位，不重複加
      return { ...g, fields: [...g.fields, { source, path }] }
    }))
  }
  const removeCompareField = (gIdx: number, fIdx: number) =>
    setCmpGroups(gs => gs.map((g, i) => i === gIdx ? { ...g, fields: g.fields.filter((_, j) => j !== fIdx) } : g))

  // ⚠️ 執行監控（run）也要輪詢，不是只有三路對帳分頁。
  //    v4.84.0 把對帳摘要放到執行日誌上方之後，如果這裡還只認 compare3，
  //    摘要列會**永遠顯示「尚無資料」**——而且在本機看不出來，
  //    因為本機真的沒有比對資料，「尚無資料」剛好也是正確的顯示。
  //    這種「錯誤狀態跟正確狀態長得一樣」的 bug 只有餵合成資料才驗得出來。
  useEffect(() => {
    if (tab !== 'compare3' && tab !== 'run') return
    fetchCompareStatus()
    const t = setInterval(() => { if (!document.hidden) fetchCompareStatus() }, 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

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
    bonus: 'Bonus 偵測', low_balance: '低餘額', error: '錯誤',
  }


  // ── JP Groups tab ──────────────────────────────────────────────────────────
  const JP_ENV_PRESETS: Record<string, { luckylink_url: string; login_user: string; login_pass: string }> = {
    QAT:  { luckylink_url: 'https://luckylink-backendserver.osmslot.org',      login_user: 'admin',    login_pass: '123456' },
    UAT:  { luckylink_url: 'https://luckylink-uat-backendserver.osmslot.org',    login_user: 'admin',    login_pass: '123456' },
    PROD: { luckylink_url: 'https://luckylink-prod-backendserver.cliveslot.com', login_user: 'qa-eric', login_pass: 'qa-eric' },
  }

  interface JpGroup { id: number; code: string; display_name: string; environment: string; luckylink_url: string; luckylink_group_name: string; login_user: string; login_pass: string; game_codes: string[]; enabled: boolean }
  const [jpGroups, setJpGroups] = useState<JpGroup[]>([])
  const [jpGroupMsg, setJpGroupMsg] = useState('')
  const [jpGroupForm, setJpGroupForm] = useState({ code: '', display_name: '', environment: 'QAT', luckylink_url: 'https://luckylink-backendserver.osmslot.org', luckylink_group_name: '', login_user: 'admin', login_pass: '123456', game_codes: '', enabled: true })
  const [jpGroupEditing, setJpGroupEditing] = useState<number | null>(null)
  const [jpGroupShowForm, setJpGroupShowForm] = useState(false)

  const fetchJpGroups = async () => {
    try {
      const r = await fetch('/api/autospin/jp-groups')
      const d = await r.json() as { groups?: JpGroup[] }
      setJpGroups(d.groups ?? [])
    } catch { setJpGroups([]) }
  }

  const handleSaveJpGroup = async () => {
    setJpGroupMsg('')
    try {
      const payload = { ...jpGroupForm, game_codes: jpGroupForm.game_codes.split(',').map(s => s.trim()).filter(Boolean) }
      const url = jpGroupEditing !== null ? `/api/autospin/jp-groups/${jpGroupEditing}` : '/api/autospin/jp-groups'
      const method = jpGroupEditing !== null ? 'PUT' : 'POST'
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await r.json() as { ok: boolean; message?: string }
      if (d.ok) { setJpGroupShowForm(false); setJpGroupEditing(null); setJpGroupForm({ code: '', display_name: '', environment: 'QAT', luckylink_url: '', luckylink_group_name: '', login_user: 'admin', login_pass: '123456', game_codes: '', enabled: true }); fetchJpGroups() }
      else setJpGroupMsg(d.message ?? '儲存失敗')
    } catch (e) { setJpGroupMsg('網路錯誤：' + String(e)) }
  }

  const handleDeleteJpGroup = async (id: number, code: string) => {
    if (!confirm(`確定刪除 JP Group「${code}」？`)) return
    try {
      await fetch(`/api/autospin/jp-groups/${id}`, { method: 'DELETE' })
      fetchJpGroups()
    } catch { setJpGroupMsg('刪除失敗，請重試') }
  }

  // ── Run tab ─────────────────────────────────────────────────────────────────
  const [runMode, setRunMode] = useState<'server' | 'hub'>('hub')
  // agent-hub 派工（A2）
  interface HubAgent { agentId: string; hostname: string; ownerName: string; capabilities: string[]; busy: boolean; sessionId: string | null; updateStatus?: string }
  const [hubAgents, setHubAgents] = useState<HubAgent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [hubDispatching, setHubDispatching] = useState(false)
  const [hubStopping, setHubStopping] = useState(false)
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
  const [logFilter, setLogFilter] = useState<'all' | 'sys' | 'spin' | 'shot' | 'error'>('all')
  const [logSearch, setLogSearch] = useState('')
  const [visiblePinusCats, setVisiblePinusCats] = useState<Set<PinusCategory>>(new Set())
  const [autoScrollLog, setAutoScrollLog] = useState(true)

  // ── LuckyLink JP compare (dispatch options) ──────────────────────────────────
  const [luckylinkEnabled, setLuckylinkEnabled] = useState(false)
  const [luckylinkJpGroupCode, setLuckylinkJpGroupCode] = useState('')
  const [luckylinkPollIntervalSec, setLuckylinkPollIntervalSec] = useState(60)

  // ── 截圖監控依帳號開關（2026-08-17，使用者要求「不要常駐，讓使用者決定」）──────────────
  // 跟三路對帳的 cmpEnabled 同一套模式：伺服器持久化的每帳號偏好，不是純前端 state；
  // 只在下次啟動 AutoSpin session 時生效，不是即時的（見 server 端註解）
  const [screenshotEnabled, setScreenshotEnabled] = useState(true)
  const [screenshotEnabledLoading, setScreenshotEnabledLoading] = useState(false)
  const fetchScreenshotPrefs = async () => {
    const r = await fetch('/api/autospin/screenshot-prefs', { headers: { 'x-user-label': getGlobalUserLabel() } })
    const d = await r.json() as { ok: boolean; screenshotEnabled?: boolean }
    if (d.ok) setScreenshotEnabled(d.screenshotEnabled ?? true)
  }
  const toggleScreenshotEnabled = async () => {
    setScreenshotEnabledLoading(true)
    const next = !screenshotEnabled
    try {
      await fetch('/api/autospin/screenshot-prefs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user-label': getGlobalUserLabel() },
        body: JSON.stringify({ screenshotEnabled: next }),
      })
      setScreenshotEnabled(next)
    } finally { setScreenshotEnabledLoading(false) }
  }
  useEffect(() => { fetchScreenshotPrefs() }, [])

  // ── LuckyLink runtime status (populated from SSE luckylink_event) ─────────────
  interface LuckylinkPoolEntry { name: string; rawValue: number; displayValue: number; basevalue: number; maxValue: number; overageValue: number }
  interface LuckylinkDiff { name: string; prev: number | null; curr: number; delta: number | null; state: string; matchedGameCodes?: string[] }
  interface LuckylinkAlertEntry { level: 'error' | 'warn' | 'info'; name: string; state: string; message?: string; ts: string; prev?: number; curr?: number; delta?: number }
  interface LuckylinkStatus { connected: boolean; jpGroupCode: string; pollCount: number; lastPollTs: string | null; pool: LuckylinkPoolEntry[]; diffs: LuckylinkDiff[]; alerts: LuckylinkAlertEntry[]; error: string | null }
  const [luckylinkStatus, setLuckylinkStatus] = useState<LuckylinkStatus | null>(null)
  const [llPanelOpen, setLlPanelOpen] = useState(true)

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
    // Agent status — also auto-connect SSE if a new session is detected（帳號各自的 session，不共用）
    const ar = await fetch('/api/autospin/agent/status', { headers: { 'x-user-label': getGlobalUserLabel() } })
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
    const r = await fetch(`/api/autospin/agent/screenshots/${sid}`, { headers: { 'x-user-label': getGlobalUserLabel() } })
    const d = await r.json() as { files?: { name: string; time: number }[] }
    setAgentCaptures(d.files ?? [])
  }, [])

  const connectSSE = useCallback((sid: string, isAgent = false, fromIndex = 0) => {
    if (evtSourceRef.current) evtSourceRef.current.close()
    // EventSource 不能自訂 header，帳號改用 query string 傳（伺服器端 stream/:id 只認自己帳號的 session）
    const from = fromIndex > 0 ? `&from=${fromIndex}` : ''
    const url = isAgent
      ? `/api/autospin/agent/stream/${sid}?userLabel=${encodeURIComponent(getGlobalUserLabel())}${from}`
      : `/api/autospin/stream/${sid}${fromIndex > 0 ? `?from=${fromIndex}` : ''}`
    const es = new EventSource(url)
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
          setLuckylinkStatus(prev => prev ? { ...prev, error: d.message ?? '未知錯誤', connected: !d.fatal } : prev)
        } else if (evt.type === 'luckylink_stop') {
          setLuckylinkStatus(prev => prev ? { ...prev, connected: false } : prev)
        }
        return
      }
      const line = data.line ?? ''
      if (isAgent) setAgentLogs(prev => [...prev.slice(-500), line])
      else setLogs(prev => [...prev.slice(-500), line])
    }
    es.onerror = () => {
      es.close()
      // 只有這條連線還是「目前使用中」的那條才自動重連（避免手動停止或啟動新連線後，舊連線的重連計時器還跑）
      if (evtSourceRef.current !== es) return
      setTimeout(() => {
        if (evtSourceRef.current !== es) return
        if (isAgent) setAgentLogs([]); else setLogs([])
        connectSSE(sid, isAgent)
      }, 2000)
    }
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

  // ─── agent-hub 派工（A2）─────────────────────────────────────────────────────
  const fetchHubAgents = useCallback(async () => {
    try {
      const r = await fetch('/api/autospin/hub-agents', { headers: { 'x-user-label': getGlobalUserLabel() } })
      const d = await r.json() as { ok: boolean; agents?: HubAgent[] }
      const list = d.agents ?? []
      setHubAgents(list)
      setSelectedAgentId(prev => (prev && list.some(a => a.agentId === prev) ? prev : (list.find(a => !a.busy)?.agentId ?? '')))
    } catch { setHubAgents([]) }
  }, [])

  // agentRunning 一變 true（由 fetchStatus() 全域輪詢偵測到）就收掉「派工中…」，
  // 不用 handleDispatchAgent 自己另開一個輪詢計時器去追（見下方註解，避免競態）
  useEffect(() => {
    if (agentRunning) setHubDispatching(false)
  }, [agentRunning])

  const handleDispatchAgent = async () => {
    setStartError(''); setAgentLogs([]); setAgentCaptures([]); setLuckylinkStatus(null)
    setHubDispatching(true)
    try {
      const r = await fetch('/api/autospin/hub-dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-label': getGlobalUserLabel() },
        body: JSON.stringify({
          agentId: selectedAgentId,
          luckylinkConfig: luckylinkEnabled
            ? { enabled: true, jpGroupCode: luckylinkJpGroupCode, pollIntervalSec: luckylinkPollIntervalSec }
            : { enabled: false },
        }),
      })
      const d = await r.json() as { ok: boolean; message?: string }
      if (!d.ok) { setStartError(d.message ?? '派工失敗'); setHubDispatching(false); return }
      // Agent 收到後會 spawn Python 引擎並向伺服器註冊 session；偵測 running 交給下方
      // fetchStatus() 那顆全域輪詢（每 4 秒，本來就會做一樣的事：偵測 running/sessionId、
      // 接 SSE、開 capture timer），這裡不再另外開一個 2 秒輪詢——兩個計時器同時搶著設
      // agentRunning，先跑完的那個設 true 之後，比它晚一點點解析完的另一個可能用比較舊的
      // 資料把它蓋回 false，畫面上會看到「剛顯示啟動中，立刻又跳回派工啟動」的閃爍。
      // hubDispatching 改成交給下方 useEffect，agentRunning 一變 true 就自動收掉。
      setTimeout(() => setHubDispatching(false), 90000)
    } catch (e) {
      setStartError('派工失敗：' + String(e))
      setHubDispatching(false)
    }
  }

  const handleStopHub = async () => {
    if (hubStopping) return
    setHubStopping(true)
    setAgentPaused(false)
    setAgentLogs(prev => [...prev, '[系統] 正在停止 Agent...'])
    try {
      await fetch('/api/autospin/hub-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-label': getGlobalUserLabel() },
        body: JSON.stringify({ agentId: selectedAgentId }),
      })
    } catch { /* ignore */ }
    await fetch('/api/autospin/agent/stop-all', { method: 'POST', headers: { 'x-user-label': getGlobalUserLabel() } }).catch(() => {})
    if (captureTimerRef.current) { clearInterval(captureTimerRef.current); captureTimerRef.current = null }
    // 輪詢實際狀態，停掉就立刻更新 UI（不再固定等 8 秒）
    const t0 = Date.now()
    const poll = setInterval(async () => {
      let running = true
      try {
        const r = await fetch('/api/autospin/agent/status', { headers: { 'x-user-label': getGlobalUserLabel() } })
        const d = await r.json() as { running: boolean }
        running = !!d.running
      } catch { /* ignore */ }
      if (!running || Date.now() - t0 > 20000) {
        clearInterval(poll)
        setAgentRunning(false)
        agentSessionIdRef.current = null
        setAgentSessionId(null)
        setHubStopping(false)
        setAgentLogs(prev => [...prev, '[系統] Agent 已停止'])
        setTimeout(() => { if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null } }, 3000)
        void fetchHubAgents()
      }
    }, 1500)
  }

  const [agentPaused, setAgentPaused] = useState(false)

  const handlePause = async () => {
    if (!agentSessionId) return
    await fetch(`/api/autospin/agent/${agentSessionId}/pause`, { method: 'POST', headers: { 'x-user-label': getGlobalUserLabel() } })
    setAgentPaused(true)
  }

  const handleResume = async () => {
    if (!agentSessionId) return
    await fetch(`/api/autospin/agent/${agentSessionId}/resume`, { method: 'POST', headers: { 'x-user-label': getGlobalUserLabel() } })
    setAgentPaused(false)
  }

  const handleSetLiveInterval = async (val: number) => {
    if (!agentSessionId) {
      // 先前這裡直接 silent return——如果畫面上 Session 其實還沒同步到（例如剛派工、
      // 全域輪詢還沒抓到 sessionId），使用者會看到「套用」按鈕正常跑完 loading，
      // 但實際上這次設定完全沒送出去，也不會有任何錯誤提示。改成明確告知。
      setStartError('尚未取得執行中的 Session，請稍候幾秒再試一次')
      return
    }
    setLiveIntervalSaving(true)
    try {
      const r = await fetch(`/api/autospin/agent/${agentSessionId}/spin-interval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-label': getGlobalUserLabel() },
        body: JSON.stringify({ value: val }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({} as { message?: string }))
        setStartError(d.message ?? `套用 Spin 間隔失敗（HTTP ${r.status}）`)
      }
    } catch (e) {
      setStartError('套用 Spin 間隔失敗：' + String(e))
    } finally {
      setLiveIntervalSaving(false)
    }
  }

  // Auto-scroll logs
  useEffect(() => {
    if (autoScrollLog && logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
  }, [logs, agentLogs, autoScrollLog])

  useEffect(() => {
    fetchConfigs(); fetchTemplates(); fetchStatus(); fetchHubAgents()
    // Periodically sync agent status + hub agent list — single source of truth for UI（每 4 秒）
    const statusTimer = setInterval(() => { if (!document.hidden) { fetchStatus(); fetchHubAgents() } }, 4000)
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
        <div style={{ padding: '8px 12px', background: 'rgba(251,191,36,0.12)', border: '1px solid #fbbf24', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>
          請先在右上角選擇帳號，機台設定將會個人化儲存
        </div>
      )}
      {userLabel && (
        <div style={{ padding: '6px 12px', background: 'rgba(59,130,246,.10)', border: '1px solid rgba(59,130,246,.28)', borderRadius: 8, marginBottom: 10, fontSize: 12, color: '#93c5fd' }}>
          目前帳號：{userLabel}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #2d3f55', marginBottom: 16 }}>
        <button style={tabStyle('configs')} onClick={() => setTab('configs')}>機台設定</button>
        <button style={tabStyle('templates')} onClick={() => { setTab('templates'); fetchTemplates() }}>模板管理</button>
        <button style={tabStyle('history')} onClick={() => { setTab('history'); fetchHistory() }}>歷史戰績</button>
        <button style={tabStyle('reconcile')} onClick={() => { setTab('reconcile'); fetchRcReports() }}>後台對帳</button>
        <button style={tabStyle('compare3')} onClick={() => { setTab('compare3'); fetchCompareGroups(); fetchComparePrefs() }}>三路對帳</button>
        <button style={tabStyle('jpgroups')} onClick={() => { setTab('jpgroups'); fetchJpGroups() }}>JP Group</button>
        <button style={tabStyle('run')} onClick={() => { setTab('run'); fetchCaptures(); fetchHubAgents(); fetchJpGroups() }}>▶ 執行監控</button>
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

          {configs.length === 0 && <p style={{ color: '#64748b', fontSize: 13 }}>尚未設定任何機台。請點「+ 新增機台」。</p>}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#162032', textAlign: 'left' }}>
                {['機台類型', 'Game Title Code', '模板類型', 'RTMP', '錄影', '模板偵測', '隨機下注', '隨機離開', '啟用', '操作'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', borderBottom: '1px solid #2d3f55', whiteSpace: 'nowrap' }}
                    title={h === '隨機下注' ? '這裡只是開關，實際點擊用的 XPath 清單改到「機台自動化測試」的機種設定檔（ideck_xpaths）配置，跟 iDeck 測試共用同一份' : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {configs.map(c => (
                <tr key={c.machineType} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '7px 10px', fontWeight: 600 }}>{c.machineType}</td>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', fontSize: 11 }}>{c.gameTitleCode || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', fontSize: 11 }}>{c.templateType || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', fontSize: 11 }}>{c.rtmpName || '—'}</td>
                  {(['enableRecording', 'enableTemplateDetection', 'betRandomEnabled', 'randomExitEnabled'] as const).map(field => (
                    <td key={field} style={{ padding: '7px 10px', textAlign: 'center' }}>
                      <ToggleSwitch checked={c[field]} disabled={togglingKey === `${c.machineType}:${field}`} onToggle={() => handleToggleField(c, field)} />
                    </td>
                  ))}
                  <td style={{ padding: '7px 10px', textAlign: 'center' }}>
                    <ToggleSwitch checked={c.enabled} disabled={togglingKey === `${c.machineType}:enabled`} onToggle={() => handleToggleField(c, 'enabled')} />
                  </td>
                  <td style={{ padding: '7px 10px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => handleEditConfig(c)}
                        style={{ padding: '2px 8px', background: 'rgba(59,130,246,.14)', color: '#93c5fd', border: '1px solid rgba(59,130,246,.26)', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>編輯</button>
                      <button onClick={() => handleCopyConfig(c)} title="複製這台的設定當作新機台的起點"
                        style={{ padding: '2px 8px', background: 'rgba(117,215,207,.14)', color: 'var(--cr-emerald)', border: '1px solid rgba(117,215,207,.26)', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>複製配置</button>
                      <button onClick={() => handleDeleteConfig(c.machineType)}
                        style={{ padding: '2px 8px', background: 'rgba(239,68,68,0.12)', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>刪除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Add/Edit modal */}
          {showForm && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 24, width: 560, maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{editingType ? `編輯：${editingType}` : '新增機台設定'}</div>

                {[
                  { key: 'machineType', label: '機台類型 *', placeholder: 'e.g. JJBXGRAND', disabled: !!editingType },
                ].map(({ key, label, placeholder, disabled }) => (
                  <div key={key}>
                    <label style={{ fontSize: 12, color: '#cbd5e1', display: 'block', marginBottom: 3 }}>{label}</label>
                    <input
                      value={(form as unknown as Record<string, string>)[key]}
                      onChange={e => setForm(f => ({ ...f, [key]: key === 'machineType' ? e.target.value.toUpperCase() : e.target.value }))}
                      placeholder={placeholder} disabled={disabled}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: '#0f172a' }}
                    />
                  </div>
                ))}

                <div>
                  <label style={{ fontSize: 12, color: '#cbd5e1', display: 'block', marginBottom: 3 }}>Game URL</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={form.gameUrl}
                      onChange={e => setForm(f => ({ ...f, gameUrl: e.target.value }))}
                      placeholder="https://..."
                      style={{ flex: 1, padding: '6px 10px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: '#0f172a' }}
                    />
                    <button type="button" className="btn-ghost"
                      title="從帳號池選取"
                      style={{ fontSize: 13, padding: '4px 8px', flexShrink: 0, color: '#2563eb' }}
                      onClick={() => setShowUrlPicker(true)}>
                      選取
                    </button>
                  </div>
                  {showUrlPicker && (
                    <UrlPoolPickerModal
                      title={`選取 ${form.machineType || '機台'} Game URL`}
                      claimedByLabel="autospin"
                      onSelect={url => setForm(f => ({ ...f, gameUrl: url }))}
                      onClose={() => setShowUrlPicker(false)}
                    />
                  )}
                </div>

                {[
                  { key: 'rtmpName', label: 'RTMP 名稱', placeholder: 'e.g. JJBXGRAND_MAIN' },
                  { key: 'rtmpUrl', label: 'RTMP URL', placeholder: 'rtmp://...' },
                  { key: 'gameTitleCode', label: 'Game Title Code', placeholder: 'e.g. 873-JJBXGRAND' },
                  { key: 'templateType', label: '模板類型', placeholder: 'e.g. JJBX' },
                  { key: 'errorTemplateType', label: '錯誤模板類型', placeholder: 'e.g. ERROR' },
                  { key: 'machineNo', label: 'Machine No.（SLS 日誌查詢用，如 6312745）', placeholder: 'e.g. 6312745' },
                  { key: 'notes', label: '備註', placeholder: '' },
                  { key: 'larkWebhook', label: 'Lark Webhook URL（推播通知，可留空）', placeholder: 'https://open.larksuite.com/open-apis/bot/v2/hook/...' },
                ].map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label style={{ fontSize: 12, color: '#cbd5e1', display: 'block', marginBottom: 3 }}>{label}</label>
                    <input
                      value={(form as unknown as Record<string, string>)[key]}
                      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                      placeholder={placeholder}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: '#0f172a' }}
                    />
                  </div>
                ))}

                {/* ── 頻率 / 隨機離開參數 ─────────────────────────────────── */}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>Spin 間隔（秒）</div>
                    <input type="number" min={0.1} max={60} step={0.1}
                      value={form.spinInterval}
                      onChange={e => setForm(f => ({ ...f, spinInterval: parseFloat(e.target.value) || 1.0 }))}
                      style={{ width: 90, padding: '5px 8px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13 }} />
                  </div>
                  {form.randomExitEnabled && (<>
                    <div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>離開機率（0~1）</div>
                      <input type="number" min={0.001} max={1} step={0.01}
                        value={form.randomExitChance}
                        onChange={e => setForm(f => ({ ...f, randomExitChance: parseFloat(e.target.value) || 0.02 }))}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13 }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>最少 Spin 次數</div>
                      <input type="number" min={1} step={1}
                        value={form.randomExitMinSpins}
                        onChange={e => setForm(f => ({ ...f, randomExitMinSpins: parseInt(e.target.value) || 50 }))}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13 }} />
                    </div>
                  </>)}
                </div>

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>低餘額閾值（0 = 不偵測）</div>
                  <input type="number" min={0} step={1}
                    value={form.lowBalanceThreshold}
                    onChange={e => setForm(f => ({ ...f, lowBalanceThreshold: parseFloat(e.target.value) || 0 }))}
                    style={{ width: 120, padding: '5px 8px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13 }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>日誌 API 環境（daily-analysis，遊玩時自動印出新日誌）</div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', height: 30 }}>
                    {(['qat', 'prod'] as const).map(envKey => (
                      <label key={envKey} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#e2e8f0', cursor: 'pointer' }}>
                        <input type="radio" name="logApiEnv" checked={form.logApiEnv === envKey}
                          onChange={() => setForm(f => ({ ...f, logApiEnv: envKey }))} />
                        {envKey.toUpperCase()}
                      </label>
                    ))}
                  </div>
                </div>
                </div>

                {configMsg && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>失敗 {configMsg}</p>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button onClick={() => { setShowForm(false); setConfigMsg('') }}
                    style={{ padding: '6px 16px', border: '1px solid #2d3f55', borderRadius: 6, background: '#1e293b', color: '#94a3b8', fontSize: 13, cursor: 'pointer' }}>取消</button>
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
            <span style={{ fontSize: 11, color: '#64748b' }}>支援 .png / .jpg / .bmp，檔名即為模板名稱</span>
          </div>

          {templates.length === 0
            ? <p style={{ color: '#64748b', fontSize: 13 }}>templates/ 資料夾中尚無圖片</p>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {templates.map(t => (
                  <div key={t.name} style={{ border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden', width: 140, background: '#1e293b', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                    <div
                      onClick={() => setLightbox(`/api/autospin/template-img/${encodeURIComponent(t.name)}`)}
                      style={{ cursor: 'zoom-in', background: '#162032', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 100, overflow: 'hidden' }}
                    >
                      <img
                        src={`/api/autospin/template-img/${encodeURIComponent(t.name)}`}
                        alt={t.name}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    </div>
                    <div style={{ padding: '6px 8px', borderTop: '1px solid #f1f5f9' }}>
                      <div style={{ fontSize: 10, color: '#cbd5e1', wordBreak: 'break-all', marginBottom: 4 }}>{t.name}</div>
                      <button onClick={() => handleDeleteTemplate(t.name)}
                        style={{ width: '100%', padding: '2px 0', background: 'rgba(239,68,68,0.12)', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>刪除</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        </div>
      )}

      {/* ── Reconcile tab ───────────────────────────────────────────────────── */}
      {tab === 'reconcile' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>

          {/* ── 連線設定：從手填改成選環境（2026-08-31）────────────────────────
              原本這裡是一整塊要手填的表單（Base URL／Origin／Token／Channel／
              Player Studio ID／登入帳密），存在自己的 `reconcile_config` 表。

              ⚠️ 但那張表**實際上是空的**（0 筆，從沒被存過），而 Meter／DayCount
                 共用的 `meter_reconcile_config` 早就有完整一份、值還一模一樣，
                 **而且兩邊打的是同一組 API**（/egm/reports/gameRecordList）。
                 等於要使用者重填一份已經存在的設定，而且填了才發現沒人存過。

              所以整塊換成「選一個環境」。設定本身到「Performance Meter 對帳」
              那頁維護，這裡不再有第二份。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '2px 4px' }}>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{T('環境', '道場')}</span>
            {([['osm', 'OSM（CP 後台）'], ['gcp', 'GCP（NC 後台）']] as const).map(([v, label]) => (
              <button
                key={v} type="button" onClick={() => setRcEnv(v)}
                style={{
                  padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${rcEnv === v ? 'var(--cr-cyan)' : '#2d3f55'}`,
                  background: rcEnv === v ? 'rgba(117,215,207,.12)' : 'transparent',
                  color: rcEnv === v ? 'var(--cr-cyan)' : '#94a3b8', fontWeight: rcEnv === v ? 700 : 400,
                }}
              >{label}</button>
            ))}
            <button onClick={testRcConnection} type="button"
              style={{ padding: '5px 12px', background: 'transparent', color: '#94a3b8', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
              測試連線
            </button>
            {rcConfigMsg && <span style={{ fontSize: 12, color: rcConfigMsg.startsWith('通過') ? '#16a34a' : '#dc2626' }}>{rcConfigMsg}</span>}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: '#64748b' }}>
              連線設定沿用「Performance Meter 對帳」那頁，這裡不用再填一次
            </span>
          </div>

          {/* Run Reconciliation */}
          <div style={{ background: '#162032', border: '1px solid #2d3f55', borderRadius: 8, padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>▶ 執行對帳</div>
            {/* 日期快捷。原本只有兩個純文字框，要自己打「2026-04-06 00:00:00」——
                格式錯了也不會有人提醒。這種後台 game record 對帳日常排查多半是
                「某一天」或「昨天某段時間」，不是長期報表，所以給快捷比給空白框實用。
                （近 7 天會拉比較多資料，標示出來讓人知道那是重活。）*/}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{T('快捷', '速選')}</span>
              {([
                ['today', '今天', 0],
                ['yesterday', '昨天', 1],
                ['7d', '近 7 天', 6],
              ] as const).map(([key, label, backDays]) => (
                <button
                  key={key} type="button"
                  onClick={() => {
                    // 用本地時間組，不要用 toISOString——那是 UTC，台灣早上會變成前一天
                    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                    const end = new Date()
                    const start = new Date()
                    if (key === 'yesterday') { end.setDate(end.getDate() - 1); start.setDate(start.getDate() - 1) }
                    else start.setDate(start.getDate() - backDays)
                    setRcDatePreset(key)
                    setRcRangeStart(`${fmt(start)} 00:00:00`)
                    setRcRangeEnd(`${fmt(end)} 23:59:59`)
                  }}
                  style={{
                    padding: '4px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                    border: `1px solid ${rcDatePreset === key ? 'var(--cr-cyan)' : '#2d3f55'}`,
                    background: rcDatePreset === key ? 'rgba(117,215,207,.12)' : 'transparent',
                    color: rcDatePreset === key ? 'var(--cr-cyan)' : '#94a3b8',
                  }}
                >{label}</button>
              ))}
              <button type="button" onClick={() => setRcDatePreset('custom')}
                style={{
                  padding: '4px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                  border: `1px solid ${rcDatePreset === 'custom' ? 'var(--cr-cyan)' : '#2d3f55'}`,
                  background: rcDatePreset === 'custom' ? 'rgba(117,215,207,.12)' : 'transparent',
                  color: rcDatePreset === 'custom' ? 'var(--cr-cyan)' : '#94a3b8',
                }}
              >自訂</button>
              {rcDatePreset === '7d' && (
                <span style={{ fontSize: 11, color: '#eab308' }}>近 7 天資料量大，查詢會比較久</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {/* 自訂時才展開起訖日期；選了快捷就不用看到兩個輸入框 */}
              {rcDatePreset === 'custom' && ([
                { label: '開始日期', val: rcRangeStart, set: setRcRangeStart, tail: '00:00:00' },
                { label: '結束日期', val: rcRangeEnd, set: setRcRangeEnd, tail: '23:59:59' },
              ] as const).map(({ label, val, set, tail }) => (
                <div key={label}>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{label}</div>
                  {/* 後端要的是「YYYY-MM-DD HH:mm:ss」，但 <input type="date"> 只給日期，
                      所以把時分秒補在這裡，使用者不用自己打格式 */}
                  <input type="date" value={(val || '').slice(0, 10)}
                    onChange={e => set(e.target.value ? `${e.target.value} ${tail}` : '')}
                    style={{ padding: '5px 8px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 12, width: 180 }} />
                </div>
              ))}
              {([
                { label: '機台類型（留空=全部）', val: rcMachineType, set: setRcMachineType, ph: 'JJBXGRAND' },
                { label: 'Player ID（留空=全部）', val: rcPlayerId, set: setRcPlayerId, ph: '' },
              ] as const).map(({ label, val, set, ph }) => (
                <div key={label}>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{label}</div>
                  <input value={val} onChange={e => set(e.target.value)} placeholder={ph}
                    style={{ padding: '5px 8px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 12, width: 180 }} />
                </div>
              ))}
              <button onClick={runReconcile} disabled={rcRunning}
                style={{ padding: '7px 20px', background: rcRunning ? '#475569' : (isXianxia ? 'var(--xx-jade-solid)' : '#16a34a'), color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: rcRunning ? 'default' : 'pointer' }}>
                {rcRunning ? T('對帳中…', '勘校中…') : T('執行對帳', '起帳勘校')}
              </button>
            </div>
          </div>

          {/* Latest result */}
          {rcResult && (
            <div style={{ background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 8, padding: 14 }}>
              <div style={panelTitle('t')}>{T('對帳結果', '◈ 勘帳結果')}</div>
              {/* ⚠️ 警告一定要放在摘要「上面」。查詢根本沒成功時，摘要那排 0
                      是沒有意義的數字——先看到 0 再看到警告，結論已經下完了。
                      partial 用黃色（資料有但不完整）、failed 用紅色（完全沒查到），
                      兩種嚴重度不同，共用一個顏色會讓人分不出還能不能參考。 */}
              {rcResult.backendError && (() => {
                const partial = rcResult.backendStatus === 'partial'
                const tone = partial
                  ? { fg: 'var(--cr-amber)', bg: 'rgba(234,216,166,.10)', bd: 'rgba(234,216,166,.30)', title: '後台資料不完整' }
                  : { fg: 'var(--cr-rose)', bg: 'rgba(223,118,94,.10)', bd: 'rgba(223,118,94,.32)', title: '後台查詢失敗' }
                const detail = [
                  rcResult.backendError.backendCode ? `代碼 ${rcResult.backendError.backendCode}` : '',
                  rcResult.backendError.page ? `第 ${rcResult.backendError.page} 頁` : '',
                ].filter(Boolean).join('・')
                return (
                  <div style={{ marginBottom: 10, padding: '9px 12px', background: tone.bg, border: `1px solid ${tone.bd}`, borderRadius: 6 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: tone.fg, marginBottom: 3 }}>
                      {tone.title}{detail ? `（${detail}）` : ''}
                    </div>
                    <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.55 }}>
                      {rcResult.backendError.message}
                      {partial && '　下方結果只涵蓋已取得的部分，不能當成完整結論。'}
                    </div>
                  </div>
                )
              })()}
              {/* 這行原本是 #cbd5e1 的淺灰字配 #f1f5f9 的近白底——淺色主題時代的殘留。
                      整頁換成深底之後就變成「白底上的淺灰字」，等於看不見（使用者實際回報）。 */}
              <div style={{
                fontSize: 12.5, color: '#e2e8f0', marginBottom: 6, padding: '8px 11px',
                background: 'rgba(148,163,184,.10)', border: '1px solid #2d3f55',
                borderRadius: 6, fontVariantNumeric: 'tabular-nums',
              }}>{rcResult.summary}</div>
              {/* 前端 0 筆時主動說明。不講的話使用者看到「後台 34 筆」但沒有異常，
                  只能自己猜是不是壞了——實際上那只是「這段時間 AutoSpin 沒在跑」*/}
              {rcResult.notice && (
                <div style={{ fontSize: 12, color: '#93c5fd', marginBottom: 10, padding: '7px 10px', background: 'rgba(59,130,246,.10)', border: '1px solid rgba(59,130,246,.28)', borderRadius: 6 }}>
                  {rcResult.notice}
                </div>
              )}

              {rcResult.backendAnomalies.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cr-amber)', marginBottom: 4 }}>後台異常 ({rcResult.backendAnomalies.length} 筆)</div>
                  {rcResult.backendAnomalies.map((a, i) => (
                    /* #92400e 是深褐色，在淺色底上才讀得到；深底上幾乎跟背景一樣暗 */
                    <div key={i} style={{ fontSize: 11, color: 'var(--cr-amber)', padding: '3px 8px', background: 'rgba(234,216,166,0.10)', border: '1px solid rgba(234,216,166,.20)', borderRadius: 4, marginBottom: 3 }}>
                      {a.note} | uid={a.uid} time={a.time} bet={a.bet} win={a.win}
                    </div>
                  ))}
                </div>
              )}

              {/* 原本叫「前端紀錄比對」，但現在兩側都列了（含僅後台有的），
                  沿用舊名字會讓人以為下面只有前端紀錄 */}
              <div style={{ ...panelTitle('t', 12), marginBottom: 4, marginTop: 2 }}>{T('比對明細', '逐局明細')} ({rcResult.details.length} 筆)</div>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead><tr style={{ background: '#162032' }}>
                    {['狀態', 'UID', '時間', 'Bet', 'Win', '備註'].map(h => <th key={h} style={{ padding: '5px 8px', borderBottom: '1px solid #2d3f55', textAlign: 'left' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {rcResult.details.map((d, i) => (
                      /* ⚠️ 「僅後台有」不能用紅色。它多半只是查詢範圍內有真人玩家的紀錄，
                            不是異常；標紅會讓人以為有 34 筆問題（跟 CodeX 討論定案）。
                            紅色只留給真正的掉單。 */
                      <tr key={i} style={{ background: d.status === 'MISSING' ? 'rgba(239,68,68,0.08)' : 'transparent', borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '4px 8px' }}>
                          {(() => {
                            const tone = d.status === 'MATCH'
                              ? { bg: 'rgba(117,215,207,0.15)', fg: 'var(--cr-emerald)', label: '相符' }
                              : d.status === 'BACKEND_ONLY'
                                ? { bg: 'rgba(148,163,184,0.14)', fg: '#94a3b8', label: '僅後台有' }
                                : { bg: 'rgba(223,118,94,0.16)', fg: 'var(--cr-rose)', label: '掉單' }
                            return <span style={{ padding: '1px 6px', borderRadius: 4, background: tone.bg, color: tone.fg, fontWeight: 600 }}>{tone.label}</span>
                          })()}
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 10 }}>{d.uid}</td>
                        <td style={{ padding: '4px 8px', color: '#94a3b8' }}>{d.time}</td>
                        <td style={{ padding: '4px 8px' }}>{d.bet}</td>
                        <td style={{ padding: '4px 8px' }}>{d.win}</td>
                        <td style={{ padding: '4px 8px', color: '#94a3b8' }}>{d.note || '—'}</td>
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
              <div style={panelTitle('t')}>{T('歷史對帳紀錄', '◈ 歷代勘帳錄')}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead><tr style={{ background: '#162032' }}>
                  {/* 「範圍」改成「查詢區間」、「機台」改成「機台篩選」——
                      原本那兩個欄名讓人以為是資料本身的屬性，其實都是「這次查詢用的條件」。
                      使用者原話：「機台寫全部根本看不懂，範圍的用意也看不懂」。
                      逐筆的局號在上面的比對明細裡（一列一局），歷史這張是一次查詢一列，
                      塞不下 34 個局號。 */}
                  {['執行時間', '查詢區間', '機台篩選', '狀態', '前端', '後台', '相符', '掉單', '異常'].map(h => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #2d3f55', textAlign: 'left' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {rcReports.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #1e293b', background: r.unmatchedCount > 0 ? 'rgba(239,68,68,0.08)' : 'transparent' }}>
                      <td style={{ padding: '5px 8px', color: '#94a3b8' }}>{new Date(r.runAt).toLocaleString('zh-TW')}</td>
                      <td style={{ padding: '5px 8px', fontSize: 10 }}>{r.rangeStart.slice(0, 16)} ~ {r.rangeEnd.slice(0, 16)}</td>
                      {/* 空值代表「沒有指定機台」，不是有一台叫「全部」的機器 */}
                      <td style={{ padding: '5px 8px', color: r.machineType ? undefined : '#64748b' }}>{r.machineType || '不限'}</td>
                      {/* ⚠️ 沒有這一欄的話，失敗那次會被存成看起來正常的一列——
                          畫面上有紅色警告，但歷史表只留下「後台 0」，之後回看
                          完全分不出是查詢失敗還是真的沒資料。
                          空字串＝加這欄之前跑的，**顯示「—」不顯示「正常」**：
                          那些列我們根本不知道當時成不成功，標成正常等於幫過去的
                          資料做出沒有根據的宣稱。 */}
                      <td style={{ padding: '5px 8px' }}>
                        {(() => {
                          const st = r.backendStatus || ''
                          if (st === 'failed') return <span style={{ color: 'var(--cr-rose)', fontWeight: 700 }}>查詢失敗</span>
                          if (st === 'partial') return <span style={{ color: 'var(--cr-amber)', fontWeight: 700 }}>不完整</span>
                          if (st === 'ok') return <span style={{ color: '#64748b' }}>正常</span>
                          return <span style={{ color: '#475569' }} title="這筆是加上狀態記錄之前跑的，無法得知當時後台查詢是否成功">—</span>
                        })()}
                      </td>
                      <td style={{ padding: '5px 8px' }}>{r.frontCount}</td>
                      <td style={{ padding: '5px 8px' }}>{r.backendCount}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--cr-emerald)', fontWeight: 600 }}>{r.matchedCount}</td>
                      <td style={{ padding: '5px 8px', color: r.unmatchedCount > 0 ? 'var(--cr-rose)' : '#64748b', fontWeight: r.unmatchedCount > 0 ? 700 : 400 }}>{r.unmatchedCount}</td>
                      <td style={{ padding: '5px 8px', color: r.anomalyCount > 0 ? 'var(--cr-amber)' : '#64748b' }}>{r.anomalyCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── 三路對帳 tab ─────────────────────────────────────────────────────── */}
      {tab === 'compare3' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11.5, color: '#64748b', flex: 1 }}>與 AutoSpin 執行同步即時比對，多機台並行 — 每台獨立統計，展開查看逐筆 Spin</div>
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>啟用三路對帳（依帳號設定）</span>
            <ToggleSwitch checked={cmpEnabled} disabled={cmpEnabledLoading} onToggle={toggleCompareEnabled} />
          </div>
          {!cmpEnabled && (
            <div style={{ fontSize: 11.5, color: '#94a3b8', background: 'rgba(148,163,184,.08)', border: '1px solid #2d3f55', borderRadius: 6, padding: '6px 10px' }}>
              已關閉——你目前執行中的機台不會再打 SLS/Pinus 查詢，也不會產生新的比對紀錄；比對群組定義仍是全域共用，重新開啟就會繼續累積
            </div>
          )}

          {cmpHasBoxLeg && (
            <div style={{ fontSize: 11.5, color: '#fb923c', background: 'rgba(251,146,60,.1)', border: '1px solid rgba(251,146,60,.3)', borderRadius: 6, padding: '6px 10px' }}>
              ⚠ 目前有比對群組包含「盒子」欄位，機台盒子硬體日誌（fresh_current_credits）尚未串接資料來源，這些群組會固定顯示「缺資料」
            </div>
          )}

          {/* Live per-machine table */}
          <div style={{ border: '1px solid #2d3f55', borderRadius: 9, overflow: 'hidden', background: '#10182a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#162032' }}>
              <span className={cmpSessionCount > 0 ? 'cr-status-dot' : undefined} style={{ width: 7, height: 7, borderRadius: '50%', background: cmpSessionCount > 0 ? 'var(--cr-cyan)' : '#475569', flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>即時比對</span>
              <span style={{ fontSize: 10.5, color: '#64748b' }}>{cmpSessionCount} 個 session 執行中</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)' }}>
                {cmpMachines.reduce((s, m) => s + m.matched, 0)} 相符
              </span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--cr-rose-soft, rgba(223,118,94,.12))', color: 'var(--cr-rose)' }}>
                {cmpMachines.reduce((s, m) => s + m.mismatched, 0)} 不符
              </span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(234,216,166,.14)', color: 'var(--cr-amber)' }}>
                {cmpMachines.reduce((s, m) => s + m.missing, 0)} 缺資料
              </span>
            </div>
            <div style={{ padding: 12, background: '#0f172a' }}>
              {cmpGroups.length === 0 ? (
                <div style={{ fontSize: 12, color: '#64748b', padding: '10px 4px' }}>尚未設定任何比對群組，請先在下方「比對群組設定」新增至少一組欄位</div>
              ) : cmpMachines.length === 0 ? (
                <div style={{ fontSize: 12, color: '#64748b', padding: '10px 4px' }}>目前沒有偵測到執行中的機台比對資料（AutoSpin 需在跑，且有機台已產生 Spin 紀錄）</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr>
                      {['機台', 'Agent', '已比對', '相符', '不符', '缺資料', '狀態'].map((h, i) => (
                        <th key={h} style={{ textAlign: i >= 2 && i <= 5 ? 'right' : 'left', padding: '6px 10px', color: '#64748b', fontWeight: 600, borderBottom: '1px solid #1e293b' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cmpMachines.map(m => {
                      const key = `${m.sessionId}:${m.machineType}`
                      const attn = m.mismatched > 0 || m.missing > 0
                      // 從執行監控的摘要點進來時，把那一台標出來——不然跳過來還要自己找，
                      // 「帶 filter 到該機台」就只做了一半（CodeX 設計裡的要求）
                      const focused = cmpFocusMachine === m.machineType
                      return (
                        <Fragment key={key}>
                          <tr onClick={() => toggleCompareDetail(m.sessionId, m.machineType)}
                            style={{ cursor: 'pointer', background: focused ? 'rgba(117,215,207,.10)' : undefined,
                              boxShadow: focused ? 'inset 3px 0 0 var(--cr-cyan)' : undefined }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(117,215,207,.05)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = focused ? 'rgba(117,215,207,.10)' : 'transparent' }}>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #182236', fontWeight: 700 }}>{m.machineType}</td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #182236', color: '#64748b', fontSize: 10.5 }}>{m.agentLabel}</td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #182236', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.compared}</td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #182236', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--cr-cyan)', fontWeight: 700 }}>{m.matched}</td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #182236', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: m.mismatched > 0 ? 'var(--cr-rose)' : undefined, fontWeight: m.mismatched > 0 ? 700 : 400 }}>{m.mismatched}</td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #182236', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.missing}</td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #182236' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: attn ? 'var(--cr-rose-soft, rgba(223,118,94,.12))' : 'var(--cr-cyan-soft)', color: attn ? 'var(--cr-rose)' : 'var(--cr-cyan)' }}>
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: attn ? 'var(--cr-amber)' : 'var(--cr-cyan)' }} />
                                {attn
                                  ? [m.mismatched > 0 ? `${m.mismatched} 筆不符` : '', m.missing > 0 ? `${m.missing} 筆缺資料` : ''].filter(Boolean).join(' · ')
                                  : '正常'}
                              </span>
                            </td>
                          </tr>
                          {cmpExpanded === key && (
                            <tr>
                              <td colSpan={7} style={{ padding: 0 }}>
                                <div style={{ padding: '10px 14px 14px', background: '#0b1322', borderBottom: '1px solid #182236' }}>
                                  {!cmpDetail[key] || cmpDetail[key].length === 0 ? (
                                    <div style={{ fontSize: 11, color: '#64748b' }}>尚無逐筆資料</div>
                                  ) : (
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
                                      <thead>
                                        <tr>
                                          <th style={{ padding: '5px 8px', textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>Spin</th>
                                          <th style={{ padding: '5px 8px', textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>時間</th>
                                          {cmpGroups.map(g => (
                                            <th key={g.id} style={{ padding: '5px 8px', textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>{g.name}</th>
                                          ))}
                                          <th style={{ padding: '5px 8px', textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>狀態</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {cmpDetail[key].map(row => (
                                          <tr key={row.spinIndex} style={{ background: row.status === 'mismatch' ? 'rgba(223,118,94,.06)' : 'transparent' }}>
                                            <td style={{ padding: '4px 8px', borderBottom: '1px solid #131d30', fontFamily: 'ui-monospace, Consolas, monospace', color: '#cbd5e1' }}>#{row.spinIndex}</td>
                                            <td style={{ padding: '4px 8px', borderBottom: '1px solid #131d30', fontFamily: 'ui-monospace, Consolas, monospace', color: '#cbd5e1' }}>{row.spinTime ? new Date(row.spinTime).toLocaleTimeString('zh-TW') : '—'}</td>
                                            {row.groups.map(g => (
                                              <td key={g.groupId} style={{ padding: '4px 8px', borderBottom: '1px solid #131d30', fontFamily: 'ui-monospace, Consolas, monospace' }}>
                                                {g.values.map((v, i) => (
                                                  <span key={i} style={{ marginRight: 6 }}>
                                                    <span style={{ fontSize: 8.5, fontWeight: 800, padding: '1px 5px', borderRadius: 3, marginRight: 3, background: SRC_COLOR[v.source as CompareField['source']].bg, color: SRC_COLOR[v.source as CompareField['source']].fg }}>
                                                      {SRC_LABEL[v.source as CompareField['source']]}
                                                    </span>
                                                    <span style={{ color: v.value === undefined || v.value === null ? '#475569' : g.status === 'mismatch' ? 'var(--cr-rose)' : '#cbd5e1', fontWeight: g.status === 'mismatch' ? 700 : 400 }}>
                                                      {v.value === undefined || v.value === null ? '—' : String(v.value)}
                                                    </span>
                                                  </span>
                                                ))}
                                              </td>
                                            ))}
                                            <td style={{ padding: '4px 8px', borderBottom: '1px solid #131d30' }}>
                                              {row.status === 'match' && <span style={{ color: 'var(--cr-cyan)' }}>✓ 相符</span>}
                                              {row.status === 'mismatch' && <span style={{ color: 'var(--cr-rose)', fontWeight: 700 }}>✕ 不符</span>}
                                              {row.status === 'missing_data' && <span style={{ color: '#475569' }}>缺資料</span>}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '8px 12px', background: '#0d1626', borderTop: '1px solid #1e293b', fontSize: 10.5, color: '#64748b' }}>
              <span>最後更新 <b style={{ color: '#cbd5e1' }}>{cmpLastUpdated ? `${Math.max(0, Math.round((Date.now() - cmpLastUpdated) / 1000))} 秒前` : '尚未更新'}</b></span>
              <span style={{ marginLeft: 'auto' }}>資料來源：<b style={{ color: '#cbd5e1' }}>SLS recordBet</b> · <b style={{ color: '#cbd5e1' }}>盒子日誌（尚未串接）</b> · <b style={{ color: '#cbd5e1' }}>Pinus history</b></span>
            </div>
          </div>

          {/* Comparison groups config */}
          <div style={{ border: '1px solid #2d3f55', borderRadius: 9, overflow: 'hidden', background: '#10182a' }}>
            <div onClick={() => setCmpConfigOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#162032', cursor: 'pointer' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#475569', flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>比對群組設定</span>
              <span style={{ fontSize: 10.5, color: '#64748b' }}>{cmpGroups.length} 組</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: '#64748b', transform: cmpConfigOpen ? 'rotate(90deg)' : undefined, transition: 'transform .2s' }}>▶</span>
            </div>
            {cmpConfigOpen && (
              <div style={{ padding: 12, background: '#0f172a' }}>
                {cmpGroups.map((g, idx) => (
                  <div key={idx} style={{ border: '1px solid #22314a', borderRadius: 8, padding: '10px 12px', marginBottom: 8, background: '#0d1626' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <input value={g.name} onChange={e => updateCompareGroupName(idx, e.target.value)}
                        style={{ background: 'transparent', border: 'none', borderBottom: '1px dashed #334155', color: 'var(--cr-violet)', fontWeight: 700, fontSize: 12, padding: '2px 0', width: 160 }} />
                      <span style={{ fontSize: 10, color: '#64748b' }}>比對這組欄位的數字是否一致</span>
                      <span style={{ flex: 1 }} />
                      <button onClick={() => removeCompareGroup(idx)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12 }}>✕ 刪除群組</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {g.fields.map((f, fIdx) => {
                        const known = FIELD_CATALOG[f.source].find(c => c.path === f.path)
                        return (
                          <span key={fIdx} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, padding: '3px 9px 3px 7px', borderRadius: 999, background: '#16223a', border: '1px solid #2d3f55', color: '#cbd5e1' }}>
                            <span style={{ fontSize: 8.5, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: SRC_COLOR[f.source].bg, color: SRC_COLOR[f.source].fg }}>{SRC_LABEL[f.source]}</span>
                            {known ? known.label : f.path}
                            <button onClick={() => removeCompareField(idx, fIdx)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}>✕</button>
                          </span>
                        )
                      })}
                      {(['sls', 'pinus', 'box'] as const).map(src => (
                        <select key={src} value="" onChange={e => addCompareField(idx, src, e.target.value)}
                          style={{ fontSize: 10.5, padding: '3px 8px', borderRadius: 999, border: '1px dashed #334155', background: 'transparent', color: '#64748b', cursor: 'pointer' }}>
                          <option value="">+ {SRC_LABEL[src]} 欄位</option>
                          {FIELD_CATALOG[src].map(f => (
                            <option key={f.path} value={f.path} style={{ color: '#0f172a' }}>{f.label}</option>
                          ))}
                        </select>
                      ))}
                    </div>
                  </div>
                ))}
                <button onClick={addCompareGroup} style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 999, border: '1px dashed #334155', background: 'transparent', color: '#64748b', cursor: 'pointer', marginTop: 2 }}>+ 新增比對群組</button>
                <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
                  <button onClick={saveCompareGroups} style={{ padding: '7px 16px', background: 'var(--xx-jade-solid)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>儲存設定</button>
                  <button onClick={runCompareNow} style={{ padding: '7px 16px', background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>試算目前資料</button>
                  {cmpGroupsMsg && <span style={{ fontSize: 12, color: cmpGroupsMsg.startsWith('通過') ? '#16a34a' : '#dc2626' }}>{cmpGroupsMsg}</span>}
                  {cmpRunNowMsg && <span style={{ fontSize: 12, color: '#64748b' }}>{cmpRunNowMsg}</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={historyFilter} onChange={e => setHistoryFilter(e.target.value)}
              placeholder="篩選機台類型（留空顯示全部）"
              style={{ padding: '5px 10px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 12, width: 220 }} />
            <button onClick={fetchHistory}
              style={{ padding: '5px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
              查詢
            </button>
            <button onClick={handleClearHistory}
              style={{ padding: '5px 14px', background: 'rgba(239,68,68,0.12)', color: '#dc2626', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
              清除記錄
            </button>
            <span style={{ fontSize: 11, color: '#64748b' }}>共 {historyRows.length} 筆</span>
          </div>

          {/* Anomaly summary */}
          {historyRows.some(r => r.isAnomaly) && (
            <div style={{ padding: '8px 12px', background: 'rgba(251,191,36,0.12)', border: '1px solid #fbbf24', borderRadius: 6, fontSize: 12 }}>
              偵測到 {historyRows.filter(r => r.isAnomaly).length} 筆異常（餘額相比開局下降超過 30%）
            </div>
          )}

          {historyRows.length === 0
            ? <p style={{ color: '#64748b', fontSize: 13 }}>尚無戰績記錄。Agent 執行中會每 20 次 Spin 記錄一次餘額快照。</p>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#162032', textAlign: 'left' }}>
                    {['時間', '機台', 'Spin#', '餘額', '事件', '備註'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', borderBottom: '1px solid #2d3f55', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #1e293b', background: r.isAnomaly ? 'rgba(251,191,36,0.12)' : 'transparent' }}>
                      <td style={{ padding: '6px 10px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                        {new Date(r.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.machineType}</td>
                      <td style={{ padding: '6px 10px', color: '#94a3b8' }}>{r.spinCount}</td>
                      <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: r.balance !== null && r.balance < 100 ? '#dc2626' : '#374151' }}>
                        {r.balance !== null ? r.balance.toFixed(2) : '—'}
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11,
                          background: r.event === 'bonus' ? 'rgba(16,185,129,0.15)' : r.event === 'low_balance' ? 'rgba(251,191,36,0.12)' : r.event === 'error' ? 'rgba(239,68,68,0.12)' : '#1e293b',
                          color: r.event === 'bonus' ? '#16a34a' : r.event === 'low_balance' ? '#d97706' : r.event === 'error' ? '#dc2626' : '#6b7280',
                        }}>
                          {EVENT_LABEL[r.event] ?? r.event}
                        </span>
                        {r.isAnomaly ? '（異常）' : ''}
                      </td>
                      <td style={{ padding: '6px 10px', color: '#94a3b8' }}>{r.note || '—'}</td>
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

      {/* ── JP Groups tab ───────────────────────────────────────────────────── */}
      {tab === 'jpgroups' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>JP Group 設定</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>管理 LuckyLink JP 群組設定，供 AutoSpin 壓測使用</div>
            </div>
            <button className="submit-btn submit-btn--sm" onClick={() => { setJpGroupShowForm(true); setJpGroupEditing(null); setJpGroupForm({ code: '', display_name: '', environment: 'QAT', luckylink_url: '', luckylink_group_name: '', login_user: 'admin', login_pass: '123456', game_codes: '', enabled: true }) }}>+ 新增</button>
          </div>

          {jpGroupMsg && <div style={{ color: '#ef4444', fontSize: 13 }}>{jpGroupMsg}</div>}

          {jpGroups.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 13 }}>尚未設定任何 JP Group。</p>
          ) : (
            <table className="sheet-preview-table" style={{ width: '100%' }}>
              <thead><tr>
                <th>代碼</th><th>名稱</th><th>環境</th><th>LuckyLink Group</th><th>Game Codes</th><th>狀態</th><th></th>
              </tr></thead>
              <tbody>
                {jpGroups.map(g => (
                  <tr key={g.id}>
                    <td><code>{g.code}</code></td>
                    <td>{g.display_name}</td>
                    <td><span style={{ background: g.environment === 'PROD' ? '#dc2626' : g.environment === 'UAT' ? '#d97706' : '#0891b2', color: '#fff', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>{g.environment}</span></td>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.luckylink_group_name}</td>
                    <td style={{ fontSize: 12, color: '#94a3b8' }}>{g.game_codes.join(', ') || '—'}</td>
                    <td>{g.enabled ? <span style={{ color: '#22c55e' }}>啟用</span> : <span style={{ color: '#94a3b8' }}>停用</span>}</td>
                    <td>
                      <button className="settings-btn" style={{ marginRight: 6 }} onClick={() => { setJpGroupEditing(g.id); setJpGroupForm({ code: g.code, display_name: g.display_name, environment: g.environment, luckylink_url: g.luckylink_url, luckylink_group_name: g.luckylink_group_name, login_user: g.login_user ?? 'admin', login_pass: g.login_pass ?? '123456', game_codes: g.game_codes.join(', '), enabled: g.enabled }); setJpGroupShowForm(true) }}>編輯</button>
                      <button className="settings-btn" style={{ color: '#ef4444' }} onClick={() => handleDeleteJpGroup(g.id, g.code)}>刪除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {jpGroupShowForm && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 24, width: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{jpGroupEditing !== null ? '編輯 JP Group' : '新增 JP Group'}</div>
                {[
                  { label: '代碼 *', key: 'code', placeholder: '例：DFDC', disabled: jpGroupEditing !== null },
                  { label: '顯示名稱 *', key: 'display_name', placeholder: '例：DFDC Jackpot Group' },
                  { label: 'LuckyLink URL *', key: 'luckylink_url', placeholder: 'https://luckylink-backendtest.osmslot.org' },
                  { label: 'LuckyLink Group 名稱 *', key: 'luckylink_group_name', placeholder: '後台 JP Group 名稱' },
                  { label: '登入帳號', key: 'login_user', placeholder: 'admin' },
                  { label: '登入密碼', key: 'login_pass', placeholder: '123456', isPassword: true },
                  { label: 'Game Codes（逗號分隔）', key: 'game_codes', placeholder: '例：873-DFDC-0001, 873-DFDC-0003' },
                ].map(({ label, key, placeholder, disabled, isPassword }) => (
                  <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 13, color: '#94a3b8' }}>{label}</label>
                    <input className="lark-url-input" placeholder={placeholder} disabled={disabled} type={isPassword ? 'password' : 'text'}
                      value={jpGroupForm[key as keyof typeof jpGroupForm] as string}
                      onChange={e => setJpGroupForm(f => ({ ...f, [key]: e.target.value }))} />
                  </div>
                ))}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 13, color: '#94a3b8' }}>環境</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['QAT', 'UAT', 'PROD'] as const).map(env => (
                      <button key={env} onClick={() => {
                        const preset = JP_ENV_PRESETS[env]
                        setJpGroupForm(f => ({ ...f, environment: env, ...(jpGroupEditing === null ? preset : {}) }))
                      }} style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: `2px solid ${jpGroupForm.environment === env ? (env === 'PROD' ? '#f59e0b' : env === 'UAT' ? '#22c55e' : '#38bdf8') : '#334155'}`, background: jpGroupForm.environment === env ? (env === 'PROD' ? 'rgba(245,158,11,0.15)' : env === 'UAT' ? 'rgba(34,197,94,0.15)' : 'rgba(56,189,248,0.15)') : 'transparent', color: jpGroupForm.environment === env ? '#f1f5f9' : '#64748b', fontWeight: jpGroupForm.environment === env ? 700 : 400, cursor: 'pointer', fontSize: 13 }}>
                        {env}
                      </button>
                    ))}
                  </div>
                  {jpGroupEditing === null && JP_ENV_PRESETS[jpGroupForm.environment]?.luckylink_url && (
                    <div style={{ fontSize: 10, color: '#475569' }}>自動填入：{JP_ENV_PRESETS[jpGroupForm.environment].luckylink_url}</div>
                  )}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={jpGroupForm.enabled} onChange={e => setJpGroupForm(f => ({ ...f, enabled: e.target.checked }))} />
                  啟用此 JP Group
                </label>
                {jpGroupMsg && <div style={{ color: '#ef4444', fontSize: 13 }}>{jpGroupMsg}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button className="settings-btn" onClick={() => { setJpGroupShowForm(false); setJpGroupMsg('') }}>取消</button>
                  <button className="submit-btn submit-btn--sm" onClick={handleSaveJpGroup}>儲存</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Run tab ─────────────────────────────────────────────────────────── */}
      {tab === 'run' && (
        // 固定視窗高度＋內部 flex 撐滿：不然上層 .main-content/.app-main 都只有 min-height（會隨內容長高、
        // 讓整個頁面往下捲），下面的 flex:1/overflow:hidden 就永遠沒有實際邊界可以撐滿，執行日誌只能
        // 跟著長高、把版面往下推。230px ≈ sticky topbar(52) + .main-content 上下 padding(24+48) + 帳號提示/分頁列(~106)。
        <div style={{ height: 'calc(100vh - 230px)', minHeight: 420, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>

          {/* OSMWatcher Jackpot Banner */}
          <div
            className={`mt-osm-banner ${jackpots.length > 0 ? 'mt-osm-banner--on' : 'mt-osm-banner--off'}`}
            style={{ cursor: jackpots.length > 0 ? 'pointer' : 'default' }}
            onClick={() => jackpots.length > 0 && setJackpotPanelOpen(v => !v)}
          >
            <span className={`mt-osm-dot ${jackpots.length > 0 ? 'mt-osm-dot--on' : ''}`} />
            {jackpots.length > 0
              ? `通過 OSMWatcher 已連線（${jackpots.filter(j => j.grand != null || j.fortunate != null).length} 個遊戲獎池）`
              : 'OSMWatcher 未連線 — 獎池資料尚未接收'}
            {jackpots.length > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>{jackpotPanelOpen ? '▲ 收合' : '▼ 展開獎池'}</span>
            )}
          </div>

          {jackpotPanelOpen && jackpots.length > 0 && (
            <div style={{ background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 8, padding: 12, marginBottom: 0 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>即時獎池 — 每 10 秒自動更新（只顯示 Grand / Fortune）</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
                {jackpots.filter(j => j.grand != null || j.fortunate != null).map(j => (
                  <div key={j.gtype} style={{
                    background: '#162032', border: '1px solid #2d3f55', borderRadius: 6,
                    padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 4,
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#94a3b8' }}>{j.gameName}</div>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                      {j.grand != null && (
                        <span style={{ color: '#fbbf24', fontWeight: 700 }}>
                          Grand: {j.grand.toLocaleString()}
                        </span>
                      )}
                      {j.fortunate != null && (
                        <span style={{ color: '#a78bfa', fontWeight: 700 }}>
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
          <div style={{ display: 'flex', gap: 0, border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden', alignSelf: 'flex-start' }}>
            {(['hub', 'server'] as const).map(m => (
              <button key={m} onClick={() => setRunMode(m)}
                style={{ padding: '7px 20px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: runMode === m ? '#2563eb' : '#1e293b', color: runMode === m ? '#fff' : '#94a3b8' }}>
                {m === 'hub' ? '遠端 Agent' : '伺服器端（fallback）'}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0, overflow: 'hidden' }}>

            {/* Left: controls + log */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>

              {runMode === 'server' ? (
                /* ── Server mode controls ── */
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="cr-btn cr-btn--jade" onClick={handleStart} disabled={running}
                      style={{ padding: '8px 20px', background: running ? '#4b5563' : 'var(--xx-jade-solid)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: running ? 'default' : 'pointer' }}>
                      啟動 AutoSpin
                    </button>
                    <button className="cr-btn cr-btn--cinnabar" onClick={handleStop} disabled={!running}
                      style={{ padding: '8px 20px', background: !running ? '#4b5563' : 'var(--xx-cinnabar-solid)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: !running ? 'default' : 'pointer' }}>
                      停止
                    </button>
                    <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 12, background: running ? 'var(--cr-cyan-soft)' : '#1e293b', color: running ? 'var(--cr-cyan)' : '#6b7280', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className={running ? 'cr-status-dot' : undefined} style={{ width: 6, height: 6, borderRadius: '50%', background: running ? 'var(--cr-cyan)' : '#6b7280', flexShrink: 0 }} />
                      {running ? '執行中' : '未執行'}
                    </span>
                    {startError && <span style={{ color: 'var(--cr-rose)', fontSize: 12, borderLeft: '2px solid var(--cr-rose)', paddingLeft: 6 }}>{startError}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    執行中的機台：{configs.filter(c => c.enabled).length} 台（已啟用）
                  </div>
                </>
              ) : (
                /* ── Remote agent (agent-hub) mode controls ──
                   跟 mockup 討論的方向一致：原本 4 個各自獨立、有自己 border/background 的區塊
                   （Agent 選擇/LuckyLink/按鈕列/Spin 間隔）合併成一個緊湊的控制區塊，內部用細分隔線
                   取代各自的外框，減少堆疊起來的高度。*/
                <div style={{ background: '#0f172a', border: '1px solid #2d3f55', borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>

                  {/* ① Agent picker */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: '#94a3b8' }}>① 選擇執行 Agent</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: '#64748b' }}>線上、支援 autospin 的 agent</span>
                      <button className="cr-icon-btn" onClick={fetchHubAgents} title="重新整理" style={{ marginLeft: 10, color: 'var(--cr-cyan)', background: 'none', border: 'none', cursor: 'pointer' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>
                      </button>
                    </div>
                    {hubAgents.length === 0 ? (
                      <div style={{ padding: 10, textAlign: 'center', color: '#64748b', fontSize: 12, border: '1px dashed #2d3f55', borderRadius: 8 }}>
                        沒有可用 agent。在機器執行 <code style={{ background: '#162032', padding: '1px 5px', borderRadius: 4 }}>start-agent.sh</code>（Mac）或 <code style={{ background: '#162032', padding: '1px 5px', borderRadius: 4 }}>start-agent.bat</code>（Windows）並完成配對後會出現在這裡。
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {hubAgents.map(a => {
                          const sel = selectedAgentId === a.agentId
                          return (
                            <div key={a.agentId} onClick={() => !a.busy && setSelectedAgentId(a.agentId)}
                              className={`autospin-agent-card${sel ? ' autospin-agent-card--selected' : ''}`}
                              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 11px', borderRadius: 9, cursor: a.busy ? 'not-allowed' : 'pointer',
                                opacity: a.busy ? 0.6 : 1 }}>
                              <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${sel ? 'var(--cr-cyan)' : '#475569'}`, flexShrink: 0, position: 'relative' }}>
                                {sel && <div style={{ position: 'absolute', inset: 3, borderRadius: '50%', background: 'var(--cr-cyan)' }} />}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <span style={{ fontWeight: 700, fontSize: 13, color: '#e2e8f0' }}>{a.hostname}</span>
                                <span style={{ fontSize: 10, color: '#64748b', marginLeft: 8 }}>{a.capabilities.join(' · ')}</span>
                                {/* 派工前先讓人看到這台落後。**顯示但不擋**——落後不一定影響這次要跑的功能，
                                    急著測時被擋住更煩（跟 CodeX 討論定案）。 */}
                                {a.updateStatus && a.updateStatus !== 'current' && (
                                  <div style={{ fontSize: 10.5, marginTop: 2, color: a.updateStatus === 'needs_restart' ? 'var(--cr-amber)' : 'var(--cr-rose)' }}>
                                    {a.updateStatus === 'needs_restart' ? '⚠ 這台需要重開 agent 才會吃到新程式'
                                      : a.updateStatus === 'unknown' ? '⚠ 這台沒回報版本，可能是舊版'
                                      : '⚠ 這台程式碼落後，部分功能可能吃不到（可照樣派工）'}
                                  </div>
                                )}
                              </div>
                              <span style={{ fontSize: 11, color: a.busy ? '#ead8a6' : 'var(--cr-cyan)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <span className={a.busy ? undefined : 'cr-status-dot'} style={{ width: 6, height: 6, borderRadius: '50%', background: a.busy ? '#ead8a6' : 'var(--cr-cyan)' }} />
                                {a.busy ? '忙碌' : '可派工'}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  <div style={{ borderTop: '1px solid #1e293b' }} />

                  {/* ② LuckyLink JP Compare options */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                      <input type="checkbox" checked={luckylinkEnabled} onChange={e => setLuckylinkEnabled(e.target.checked)} style={{ width: 15, height: 15 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#93c5fd' }}>啟用 LuckyLink JP 比對</span>
                    </label>
                    {luckylinkEnabled && (
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span style={{ fontSize: 11, color: '#64748b' }}>JP Group</span>
                          <select value={luckylinkJpGroupCode} onChange={e => setLuckylinkJpGroupCode(e.target.value)}
                            style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 5, color: '#e2e8f0', padding: '4px 8px', fontSize: 13, minWidth: 160 }}>
                            <option value=''>-- 選擇 JP Group --</option>
                            {jpGroups.filter(g => g.enabled).map(g => (
                              <option key={g.code} value={g.code}>{g.display_name} ({g.environment})</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span style={{ fontSize: 11, color: '#64748b' }}>輪詢間隔（秒）</span>
                          <input type="number" min={10} max={600} value={luckylinkPollIntervalSec} onChange={e => setLuckylinkPollIntervalSec(Number(e.target.value))}
                            style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 5, color: '#e2e8f0', padding: '4px 8px', fontSize: 13, width: 90 }} />
                        </div>
                        {!luckylinkJpGroupCode && (
                          <span style={{ fontSize: 11, color: '#ead8a6', borderLeft: '2px solid #ead8a6', paddingLeft: 6, alignSelf: 'flex-end', paddingBottom: 4 }}>請選擇 JP Group</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ borderTop: '1px solid #1e293b' }} />

                  {/* ③ 截圖監控依帳號開關（2026-08-17）——只在下次啟動 session 生效，不是即時的，
                      文案直接寫明避免使用者以為切換當下就會立即停止/恢復截圖 */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: screenshotEnabledLoading ? 'default' : 'pointer', userSelect: 'none', opacity: screenshotEnabledLoading ? 0.6 : 1 }}>
                      <input type="checkbox" checked={screenshotEnabled} disabled={screenshotEnabledLoading} onChange={toggleScreenshotEnabled} style={{ width: 15, height: 15 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#93c5fd' }}>啟用截圖監控</span>
                    </label>
                    <span style={{ fontSize: 11, color: '#64748b', paddingLeft: 23 }}>關閉後不會再定期截圖上傳；下次啟動 AutoSpin session 才會生效，執行中切換不會立即改變</span>
                  </div>

                  <div style={{ borderTop: '1px solid #1e293b' }} />

                  {/* ④ Status + controls row */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="cr-btn cr-btn--jade" onClick={handleDispatchAgent} disabled={agentRunning || hubDispatching || !selectedAgentId || (luckylinkEnabled && !luckylinkJpGroupCode)}
                      style={{ padding: '7px 18px', background: (agentRunning || hubDispatching || !selectedAgentId || (luckylinkEnabled && !luckylinkJpGroupCode)) ? '#4b5563' : 'var(--xx-jade-solid)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13.5, cursor: (agentRunning || hubDispatching || !selectedAgentId || (luckylinkEnabled && !luckylinkJpGroupCode)) ? 'default' : 'pointer' }}>
                      {hubDispatching ? '派工中…' : '派工啟動'}
                    </button>
                    <button className="cr-btn cr-btn--cinnabar" onClick={handleStopHub} disabled={hubStopping || (!agentRunning && !hubDispatching)}
                      style={{ padding: '7px 18px', background: (hubStopping || (!agentRunning && !hubDispatching)) ? '#4b5563' : 'var(--xx-cinnabar-solid)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13.5, cursor: (hubStopping || (!agentRunning && !hubDispatching)) ? 'default' : 'pointer' }}>
                      {hubStopping ? '停止中…' : '停止'}
                    </button>
                    {agentRunning && !agentPaused && !hubStopping && (
                      <button className="cr-btn cr-btn--gold" onClick={handlePause}
                        style={{ padding: '7px 14px', background: 'var(--xx-gold-solid)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>
                        暫停
                      </button>
                    )}
                    {agentRunning && agentPaused && (
                      <button className="cr-btn cr-btn--jade" onClick={handleResume}
                        style={{ padding: '7px 14px', background: 'var(--xx-jade-solid)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>
                        繼續
                      </button>
                    )}
                    <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 12, background: hubStopping ? 'rgba(223,118,94,0.14)' : agentPaused ? 'rgba(199,169,107,0.14)' : agentRunning ? 'var(--cr-cyan-soft)' : '#1e293b', color: hubStopping ? 'var(--cr-rose)' : agentPaused ? 'var(--cr-violet)' : agentRunning ? 'var(--cr-cyan)' : '#6b7280', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className={agentRunning && !hubStopping ? 'cr-status-dot' : undefined} style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: hubStopping ? 'var(--cr-rose)' : agentPaused ? 'var(--cr-violet)' : agentRunning ? 'var(--cr-cyan)' : '#6b7280' }} />
                      {hubStopping ? '停止中…' : agentPaused ? '已暫停' : agentRunning ? 'Agent 執行中' : '未連線'}
                    </span>
                    {agentSessionId && <span style={{ fontSize: 11, color: 'var(--cr-cyan)' }}>Session: {agentSessionId.slice(0, 8)}…</span>}

                    <span style={{ width: 1, height: 20, background: '#2d3f55', margin: '0 2px' }} />

                    {/* Live Spin Interval — 併進同一列，跟 mockup 一致 */}
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>Spin 間隔</span>
                    <input
                      type="range" min={0.1} max={10} step={0.1}
                      value={liveSpinInterval}
                      onChange={e => setLiveSpinInterval(parseFloat(e.target.value))}
                      style={{ width: 120 }}
                      disabled={!agentRunning}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 32 }}>{liveSpinInterval.toFixed(1)}s</span>
                    <button
                      type="button"
                      className="cr-btn"
                      disabled={!agentRunning || liveIntervalSaving}
                      onClick={() => handleSetLiveInterval(liveSpinInterval)}
                      style={{ padding: '3px 12px', fontSize: 12, borderRadius: 6, border: '1px solid var(--cr-cyan-border)', background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', cursor: agentRunning ? 'pointer' : 'default' }}
                    >
                      {liveIntervalSaving ? '...' : '套用'}
                    </button>
                    <span style={{ fontSize: 11, color: '#64748b' }}>覆蓋所有機台間隔，Agent 3秒內生效</span>
                  </div>
                </div>
              )}

              {/* ── 三路對帳摘要（2026-08-31，CodeX 設計）──────────────────────────
                  放在執行日誌**上方**，不是右欄。理由（CodeX 的判斷，我同意）：
                  右欄是「觀察輔助資訊」，左欄才是跑測試時的主流程，而對帳摘要
                  本質上是「本次執行的健康度」，該跟日誌同層。

                  ⚠️ 刻意**不搬整套對帳 UI 過來**：右欄已經有三個面板（截圖監控／
                     LuckyLink JP／SLS 錯誤日誌），而且之前才因為擠爆修過一次
                     （截圖監控限高 420px）。再塞一個完整面板會重演同樣問題。
                     明細留在「三路對帳」分頁，這裡只出告警級摘要。

                  ⚠️ 顏色**只標異常**。全部相符時保持中性，不然一排彩色 chip
                     反而看不出哪一台要處理。 */}
              {(() => {
                if (!cmpEnabled) return null
                const total = cmpMachines.reduce((a, m) => ({
                  compared: a.compared + m.compared,
                  matched: a.matched + m.matched,
                  mismatched: a.mismatched + m.mismatched,
                  missing: a.missing + m.missing,
                }), { compared: 0, matched: 0, mismatched: 0, missing: 0 })
                const jump = (mt?: string) => {
                  setTab('compare3')
                  fetchCompareGroups()
                  fetchComparePrefs()
                  if (mt) setCmpFocusMachine(mt)
                }
                const badge = (label: string, n: number, tone: 'bad' | 'warn' | 'ok') => {
                  if (n === 0 && tone !== 'ok') return null
                  const c = tone === 'bad'
                    ? { bg: 'rgba(244,63,94,.14)', fg: '#fb7185', bd: 'rgba(244,63,94,.35)' }
                    : tone === 'warn'
                      ? { bg: 'rgba(234,179,8,.13)', fg: '#eab308', bd: 'rgba(234,179,8,.32)' }
                      : { bg: 'transparent', fg: '#94a3b8', bd: 'transparent' }
                  return (
                    <span style={{
                      fontSize: 11, padding: '2px 7px', borderRadius: 4,
                      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, whiteSpace: 'nowrap',
                    }}>{label} {n}</span>
                  )
                }
                return (
                  <div
                    /* 給一個穩定識別：分頁列上也有一顆叫「三路對帳」的按鈕，
                       只靠文字找會抓錯元素（驗證腳本第一版就是這樣抓到分頁列的）*/
                    data-testid="autospin-compare-bar"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '7px 10px', marginBottom: 8,
                      border: '1px solid #2d3f55', borderRadius: 8, background: '#162032',
                    }}>
                    <button
                      type="button" onClick={() => jump()}
                      style={{
                        fontSize: 12, fontWeight: 700, color: '#e2e8f0', background: 'none',
                        border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline dotted',
                      }}
                      title="跳到「三路對帳」分頁看逐筆明細"
                    >三路對帳</button>
                    {total.compared === 0 ? (
                      <span style={{ fontSize: 11, color: '#64748b' }}>
                        尚無資料{cmpMachines.length === 0 ? '（這次執行還沒有機台被比對到）' : ''}
                      </span>
                    ) : (
                      <>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>已比對 {total.compared} 筆</span>
                        {badge('不符', total.mismatched, 'bad')}
                        {badge('缺資料', total.missing, 'warn')}
                        {total.mismatched === 0 && total.missing === 0 && (
                          <span style={{ fontSize: 11, color: '#4ade80' }}>全部相符</span>
                        )}
                      </>
                    )}
                    <div style={{ flex: 1 }} />
                    {/* 逐台只在有異常時才列出來——正常的機台不需要佔位置 */}
                    {cmpMachines.filter(m => m.mismatched > 0 || m.missing > 0).slice(0, 4).map(m => (
                      <button
                        key={`${m.sessionId}:${m.machineType}`} type="button"
                        onClick={() => jump(m.machineType)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5, fontSize: 11,
                          padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
                          background: 'rgba(244,63,94,.08)', border: '1px solid rgba(244,63,94,.25)', color: '#e2e8f0',
                        }}
                        title="跳到三路對帳並聚焦這台"
                      >
                        <b style={{ fontWeight: 700 }}>{m.machineType}</b>
                        {m.mismatched > 0 && <span style={{ color: '#fb7185' }}>不符 {m.mismatched}</span>}
                        {m.missing > 0 && <span style={{ color: '#eab308' }}>缺 {m.missing}</span>}
                      </button>
                    ))}
                  </div>
                )
              })()}

              {/* Log panel: filter/search + pinus category chips + bounded scrollable body */}
              {(() => {
                const rawLogs = runMode === 'server' ? logs : agentLogs
                const categorized = rawLogs.map(l => {
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
                return (
                  <div className="autospin-log-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden' }}>
                    {/* Header: title/count + search + auto-scroll + clear */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#162032', borderBottom: '1px solid #2d3f55', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>執行日誌</span>
                      <span style={{ fontSize: 11, color: '#64748b' }}>{visible.length} / {rawLogs.length} 行</span>
                      <div style={{ flex: 1 }} />
                      <input value={logSearch} onChange={e => setLogSearch(e.target.value)} placeholder="搜尋日誌內容…"
                        style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #2d3f55', borderRadius: 5, background: '#0f172a', color: '#e2e8f0', width: 130 }} />
                      <button className={`cr-pill${autoScrollLog ? ' cr-pill--active' : ''}`} onClick={() => setAutoScrollLog(v => !v)}
                        style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, border: '1px solid #2d3f55', cursor: 'pointer',
                          background: autoScrollLog ? 'var(--cr-cyan-soft)' : '#0f172a', color: autoScrollLog ? 'var(--cr-cyan)' : '#94a3b8' }}>
                        自動捲到底
                      </button>
                      <button className="cr-pill" onClick={() => downloadExecutionLog(rawLogs)}
                        style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, border: '1px solid #2d3f55', background: '#0f172a', color: '#94a3b8', cursor: 'pointer' }}>
                        下載
                      </button>
                      <button className="cr-pill" onClick={() => (runMode === 'server' ? setLogs([]) : setAgentLogs([]))}
                        style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, border: '1px solid #2d3f55', background: '#0f172a', color: '#94a3b8', cursor: 'pointer' }}>
                        清空
                      </button>
                    </div>
                    {/* Filter chips */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#162032', borderBottom: '1px solid #2d3f55', flexWrap: 'wrap' }}>
                      {([['all', '全部'], ['sys', '系統'], ['spin', 'Spin'], ['shot', '截圖'], ['error', '錯誤/警告']] as const).map(([key, label]) => (
                        <button key={key} className={`cr-pill${logFilter === key ? ' cr-pill--active' : ''}`} onClick={() => setLogFilter(key)}
                          style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                            border: `1px solid ${logFilter === key ? 'var(--cr-cyan)' : '#2d3f55'}`,
                            background: logFilter === key ? 'var(--cr-cyan)' : '#0f172a', color: logFilter === key ? '#03222b' : '#94a3b8' }}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {/* Pinus category chips: 預設全部收合，個別勾選才顯示該類 pinus 訊息 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#101827', borderBottom: '1px solid #2d3f55', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: '#64748b', fontWeight: 700 }}>pinus 分類：</span>
                      {PINUS_CATEGORY_META.map(({ key, label }) => {
                        const count = pinusCatCounts.get(key) ?? 0
                        const on = visiblePinusCats.has(key)
                        return (
                          <button key={key} className={`cr-pill${on ? ' cr-pill--active-soft' : ''}`}
                            onClick={() => setVisiblePinusCats(prev => {
                              const next = new Set(prev)
                              if (next.has(key)) next.delete(key); else next.add(key)
                              return next
                            })}
                            style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
                              border: `1px solid ${on ? 'var(--cr-cyan)' : '#2d3f55'}`,
                              background: on ? 'var(--cr-cyan-soft)' : '#0f172a', color: on ? 'var(--cr-cyan)' : '#64748b' }}>
                            {label}{count > 0 ? `（${count}）` : ''}
                          </button>
                        )
                      })}
                    </div>
                    {/* Body */}
                    <div ref={logBoxRef}
                      style={{ flex: 1, minHeight: 0, background: '#0f172a', padding: '8px 12px', overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7 }}>
                      {rawLogs.length === 0
                        ? <span style={{ color: '#475569' }}>等待啟動...</span>
                        : visible.length === 0
                          ? <span style={{ color: '#475569' }}>沒有符合篩選條件的日誌</span>
                          : visible.map((c, i) => (
                            <div key={i} style={{ color: catColor[c.cat], background: catBg[c.cat] ?? 'transparent', borderRadius: 3, padding: '0 3px' }}>{c.text}</div>
                          ))
                      }
                    </div>
                  </div>
                )
              })()}

              {/* Agent 機器環境準備 — hub 模式 */}
              {runMode === 'hub' && hubAgents.length === 0 && (
                <div style={{ fontSize: 12, color: '#64748b', padding: '8px 2px' }}>
                  沒看到 agent？請到左側「Local Agent」頁面下載安裝並啟動 Agent（含 macOS 安裝教學），完成配對後就會出現在上方清單。
                </div>
              )}
            </div>

            {/* Right: screenshots + SLS errors */}
            <div style={{ flex: '0 0 260px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
              {/* LuckyLink JP 監控 panel — visible when LL enabled */}
              {luckylinkEnabled && (
                <div style={{ border: `1px solid ${luckylinkStatus?.alerts.some(a => a.level === 'error') ? '#7f1d1d' : '#2d3f55'}`, borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: luckylinkStatus?.alerts.some(a => a.level === 'error') ? 'rgba(239,68,68,0.08)' : '#162032', cursor: 'pointer' }}
                    onClick={() => setLlPanelOpen(v => !v)}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: !luckylinkStatus ? '#6b7280' : luckylinkStatus.error ? '#ef4444' : luckylinkStatus.connected ? '#22c55e' : '#f59e0b' }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1', flex: 1 }}>
                      LuckyLink JP {luckylinkStatus?.pollCount ? `Poll#${luckylinkStatus.pollCount}` : ''}
                      {luckylinkStatus?.alerts.some(a => a.level === 'error') ? <span style={{ color: 'var(--cr-rose)' }}> · 異常</span> : luckylinkStatus?.alerts.some(a => a.level === 'warn') ? <span style={{ color: '#ead8a6' }}> · 警告</span> : ''}
                    </span>
                    <span style={{ fontSize: 10, color: '#64748b' }}>{llPanelOpen ? '▲' : '▼'}</span>
                  </div>
                  {llPanelOpen && (
                    <div style={{ padding: 8, background: '#1e293b', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {!luckylinkStatus ? (
                        <div style={{ fontSize: 11, color: '#64748b' }}>等待 Poller 啟動...</div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 10, color: '#94a3b8' }}>
                            <span>Group: <b style={{ color: '#cbd5e1' }}>{luckylinkStatus.jpGroupCode}</b></span>
                            {luckylinkStatus.lastPollTs && <span>更新: <b style={{ color: '#cbd5e1' }}>{new Date(luckylinkStatus.lastPollTs).toLocaleTimeString('zh-TW')}</b></span>}
                            <span style={{ color: luckylinkStatus.connected ? '#22c55e' : '#f59e0b' }}>{luckylinkStatus.connected ? '連線中' : '已停止'}</span>
                          </div>
                          {luckylinkStatus.error && <div style={{ fontSize: 11, color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderRadius: 4, padding: '4px 6px' }}>{luckylinkStatus.error}</div>}
                          {(luckylinkStatus.diffs.length > 0 || luckylinkStatus.pool.length > 0) && (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
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
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, borderTop: '1px solid #0f172a', paddingTop: 4 }}>
                              {luckylinkStatus.alerts.slice(-5).map((a, i) => (
                                <div key={i} style={{ fontSize: 10, borderLeft: `3px solid ${a.level === 'error' ? 'var(--cr-rose)' : a.level === 'warn' ? '#ead8a6' : 'var(--cr-cyan)'}`, paddingLeft: 6, color: '#cbd5e1' }}>
                                  <span style={{ color: a.level === 'error' ? 'var(--cr-rose)' : a.level === 'warn' ? '#ead8a6' : 'var(--cr-cyan)' }}>
                                    {a.name} [{a.state}]
                                  </span>
                                  {a.message && <span style={{ color: '#94a3b8' }}> {a.message}</span>}
                                  {a.prev !== undefined && <span style={{ color: '#64748b' }}> ({a.prev}→{a.curr})</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* SLS Error Logs panel */}
              <div style={{ border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: slsEntries.some(e => e.level === 'ERROR') ? 'rgba(239,68,68,0.08)' : '#162032', cursor: 'pointer' }}
                  onClick={() => setSlsPanelOpen(v => !v)}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: slsEntries.length > 0 ? (slsEntries.some(e => e.level === 'ERROR') ? '#ef4444' : '#f59e0b') : '#cbd5e1', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1', flex: 1 }}>
                    SLS 錯誤日誌 {slsEntries.length > 0 ? `(${slsEntries.length})` : ''}
                  </span>
                  <span style={{ fontSize: 10, color: '#64748b' }}>{slsPanelOpen ? '▲' : '▼'}</span>
                </div>
                {slsPanelOpen && (
                  <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: '#1e293b' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select value={slsMachineNo} onChange={e => { setSlsMachineNo(e.target.value); setSlsEntries([]) }}
                        style={{ flex: 1, fontSize: 11, padding: '4px 6px', border: '1px solid #2d3f55', borderRadius: 5 }}>
                        <option value=''>— 選擇機台 —</option>
                        {configs.filter(c => c.machineNo).map(c => (
                          <option key={c.machineType} value={c.machineNo}>{c.machineType} ({c.machineNo})</option>
                        ))}
                      </select>
                      <button className="cr-btn" onClick={() => fetchSlsErrors(slsMachineNo)} disabled={!slsMachineNo || slsLoading}
                        style={{ fontSize: 11, padding: '4px 8px', background: slsMachineNo ? 'var(--xx-jade-solid)' : '#334155', color: slsMachineNo ? '#fff' : '#9ca3af', border: 'none', borderRadius: 5, cursor: slsMachineNo ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center' }}>
                        {slsLoading ? '...' : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                        )}
                      </button>
                    </div>
                    {slsError && <div style={{ fontSize: 11, color: 'var(--cr-rose)' }}>{slsError}</div>}
                    {slsEntries.length === 0 && !slsLoading && !slsError && slsMachineNo && (
                      <div style={{ fontSize: 11, color: '#64748b' }}>近 24 小時無錯誤記錄</div>
                    )}
                    {slsEntries.map((e, i) => (
                      <div key={i} style={{ fontSize: 10, borderLeft: `3px solid ${e.level === 'ERROR' ? 'var(--cr-rose)' : e.level === 'WARN' || e.level === 'WARNING' ? '#ead8a6' : '#6b7280'}`, paddingLeft: 6, color: '#cbd5e1' }}>
                        <div style={{ color: '#94a3b8', marginBottom: 2 }}>{e.timeStr} · <span style={{ color: e.level === 'ERROR' ? 'var(--cr-rose)' : '#ead8a6', fontWeight: 700 }}>{e.level}</span></div>
                        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#1e293b' }}>{e.content.slice(0, 160)}{e.content.length > 160 ? '…' : ''}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 截圖監控獨立限高＋自己捲動（2026-08-17 使用者回報：機台一多，截圖越疊越多，會把
                  上面 LuckyLink JP／SLS 錯誤日誌兩個面板一起往上推出可視範圍，要滑很久才看得到）。
                  截圖區塊限制最高 420px、自己 overflow-y 捲動，LuckyLink/SLS 面板留在外層 column
                  的一般排版流裡，不受截圖數量影響，永遠可見在上方，不用捲。 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto', paddingRight: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#cbd5e1' }}>截圖監控</span>
                  <button className="cr-icon-btn" onClick={fetchCaptures} style={{ fontSize: 11, color: 'var(--cr-cyan)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>
                    重新整理
                  </button>
                </div>
                {(() => {
                  const raw = runMode === 'server' ? captures : agentCaptures
                  if (raw.length === 0) return <p style={{ color: '#64748b', fontSize: 12 }}>尚無截圖</p>
                  const items = [...raw].reverse().map(f => ({
                    name: f.name,
                    ts: 'mtime' in f ? f.mtime : f.time,
                    src: runMode === 'server'
                      ? `/api/autospin/captures/${encodeURIComponent(f.name)}`
                      : `/api/autospin/agent/screenshot/${agentSessionId}/${encodeURIComponent(f.name)}?userLabel=${encodeURIComponent(getGlobalUserLabel())}`,
                    spinNo: extractSpinNo(f.name),
                  }))
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {items.map((it, i) => (
                        <div key={it.name} onClick={() => setLightbox(it.src)}
                          className={`autospin-shot${i === 0 ? ' autospin-shot--latest' : ''}`}
                          style={{ position: 'relative', border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden', aspectRatio: '1 / 1', background: '#0f172a', cursor: 'zoom-in' }}>
                          <img
                            src={it.src}
                            alt={it.name}
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          {i === 0 && (
                            <>
                              <span className="cr-status-dot" style={{ position: 'absolute', top: 6, left: 6, width: 6, height: 6, borderRadius: '50%', background: 'var(--cr-cyan)' }} />
                              <span style={{ position: 'absolute', top: 4, right: 4, background: 'var(--xx-jade-solid)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>最新</span>
                            </>
                          )}
                          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '4px 6px', background: 'linear-gradient(0deg, rgba(0,0,0,0.75), transparent)', fontSize: 9.5, color: '#e2e8f0', display: 'flex', justifyContent: 'space-between' }}>
                            <span>{it.spinNo ? `Spin #${it.spinNo}` : it.name}</span>
                            <b style={{ color: 'var(--cr-cyan)' }}>{relativeShotTime(it.ts)}</b>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

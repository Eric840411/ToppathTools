import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BACKEND_MODULES, createBackendModule, createCustomBackendModule, createDefaultBackendPlan, matchesBackendModule } from './backend-modules'
import type { BackendModuleId, BackendModuleTone, BackendPlanModule, RunStatus, TcGroup, UatConfig, UatThemeMode } from './types'
import { NetworkPanel, type UatStatsPayload } from './NetworkPanel'
import { BackendTcEditor, type BackendTc, type Step } from './BackendTcEditor'

const STORAGE_KEY = 'osm_uat_config'
const TONES: BackendModuleTone[] = ['blue', 'cyan', 'violet', 'amber', 'orange', 'green', 'rose', 'slate']

function newInstanceId(prefix = 'custom') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function sanitizeModule(value: unknown): BackendPlanModule | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<BackendPlanModule>
  if (typeof item.instanceId !== 'string' || typeof item.name !== 'string' || !Array.isArray(item.filters)) return null
  const filters = item.filters.filter((filter): filter is string => typeof filter === 'string' && filter.trim().length > 0).map(filter => filter.trim())
  if (!filters.length) return null
  return {
    instanceId: item.instanceId,
    sourceId: item.sourceId ?? 'custom',
    name: item.name,
    xianxiaName: typeof item.xianxiaName === 'string' ? item.xianxiaName : item.name,
    description: typeof item.description === 'string' ? item.description : '',
    tone: TONES.includes(item.tone as BackendModuleTone) ? item.tone as BackendModuleTone : 'blue',
    filters,
  }
}

function loadConfig(): UatConfig {
  const defaults: UatConfig = { larkUrl: '', filter: '', dashGameType: '', dashClientVersion: '', modulePlan: createDefaultBackendPlan() }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<UatConfig> & { modulePlan?: unknown[] }
    let modulePlan = defaults.modulePlan
    if (Array.isArray(stored.modulePlan) && stored.modulePlan.length) {
      if (stored.modulePlan.every(item => typeof item === 'string')) {
        modulePlan = stored.modulePlan.flatMap(id => {
          const definition = BACKEND_MODULES.find(module => module.id === id)
          return definition ? [createBackendModule(definition)] : []
        })
      } else {
        modulePlan = stored.modulePlan.map(sanitizeModule).filter((module): module is BackendPlanModule => Boolean(module))
      }
    }
    return { ...defaults, ...stored, modulePlan: modulePlan.length ? modulePlan : defaults.modulePlan }
  } catch { return defaults }
}

interface RecNetCall {
  method: string
  url: string
  /** 收斂過的網址（拿掉 query、id 換成 *），之後要把這筆變成斷言時是比對這個 */
  urlPattern: string
  status: number | null
  durationMs: number | null
  ts: number
}

interface BackendUatAgent {
  agentId: string
  hostname: string
  ownerName: string
  busy: boolean
  lastSeenAt: number
}

export function BackendUatPanel({ themeMode }: { themeMode: UatThemeMode }) {
  const xianxia = themeMode === 'xianxia'
  const [config, setConfig] = useState(loadConfig)
  const [status, setStatus] = useState<RunStatus>('idle')
  const statusRef = useRef<RunStatus>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [groups, setGroups] = useState<TcGroup[] | null>(null)
  const [total, setTotal] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [draggedModule, setDraggedModule] = useState<string | null>(null)
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(config.modulePlan[0]?.instanceId ?? null)
  const [settingsView, setSettingsView] = useState<'run' | 'module'>('run')
  // 後台測試帳密：依登入帳號各存一份在後端（不再放 repo 裡的 config 檔）。
  // 這裡永遠拿不到密碼本身，只知道「有沒有設過」；密碼欄留空送出＝沿用舊密碼。
  const [creds, setCreds] = useState<{ profile: string; username: string; hasPassword: boolean }[]>([])
  const [credDraft, setCredDraft] = useState<Record<string, { username: string; password: string }>>({})
  const [credMsg, setCredMsg] = useState<{ text: string; tone: 'ok' | 'error' | 'busy' } | null>(null)
  // 網路量測快照：由 SSE 的 stats event 推上來，跟執行日誌同一條連線不同事件名
  const [netStats, setNetStats] = useState<UatStatsPayload | null>(null)
  const [statsAt, setStatsAt] = useState<number | null>(null)
  // 單筆 TC 這一層：掃描才拿得到，模組展開後才看得見。積木是掛在 TC 上的，
  // 沒有這層就沒有地方可以編（v4.27.0 之前整個畫面只有模組層級）
  const [tcs, setTcs] = useState<BackendTc[]>([])
  const [expandedModule, setExpandedModule] = useState<string | null>(null)
  const [selectedTcId, setSelectedTcId] = useState<string | null>(null)
  // 工作台層級的錄製：不用先選 TC，停止之後才問積木要放哪一筆。
  // 錄製本身跟 TC 完全無關（後端也不再需要 recordId），先選 TC 只是舊 UI 的包袱。
  const [recSession, setRecSession] = useState<string | null>(null)
  const [recCount, setRecCount] = useState(0)
  const [recMsg, setRecMsg] = useState('')
  const [pendingSteps, setPendingSteps] = useState<Step[] | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  /** 選擇器是否展開。跟 pendingSteps 分開——收起彈框不等於丟掉錄到的積木 */
  const [pickerOpen, setPickerOpen] = useState(false)
  // 錄製期間打到的 API。錄製只錄得到 DOM 操作，但要決定「這一步該下什麼
  // pass/fail」時，最需要知道的是它打了哪些後端——很多成功／失敗根本不在 DOM，
  // 在 API 有沒有送出、回什麼碼。
  const [recNet, setRecNet] = useState<RecNetCall[]>([])
  // 子類型篩選改成彈框複選。原本是自由輸入——使用者不知道有哪些可選、又容易打錯，
  // 而且這個欄位會靜默縮小執行範圍（實際踩過：以為「執行模組流程」壞了）
  const [subtypeModal, setSubtypeModal] = useState(false)
  const [subtypeQuery, setSubtypeQuery] = useState('')
  // 錄到的是 Lark 上還沒有的新流程時，積木要有地方放。硬塞給既有 TC 會把那筆
  // 原本該驗的東西蓋掉，所以另存成自訂 TC——它帶一個歸戶關鍵字，之後掃到文字
  // 命中的 Lark TC 就能把積木搬過去。這不是第二份測試清單，是暫存區。
  const [newTcTitle, setNewTcTitle] = useState('')
  const [newTcKeyword, setNewTcKeyword] = useState('')
  const [savingNewTc, setSavingNewTc] = useState(false)
  const [customTcs, setCustomTcs] = useState<{ id: string; title: string; linkKeyword: string; steps: unknown[] }[]>([])
  const loadCustomTcs = useCallback(async () => {
    try {
      const r = await fetch('/api/osm-uat/custom-tcs')
      const d = await r.json() as { ok: boolean; customTcs?: typeof customTcs }
      if (d.ok) setCustomTcs(d.customTcs ?? [])
    } catch { /* 載不到就當作沒有，不擋住主要流程 */ }
  }, [])
  useEffect(() => { void loadCustomTcs() }, [loadCustomTcs])
  const [tcSnapshotAt, setTcSnapshotAt] = useState<string | null>(null)
  const [tcScanned, setTcScanned] = useState(false)
  // 掛載就載入 registry 快照的 TC 清單——編積木需要的東西快照裡都有，
  // 沒有理由讓人先等一次 Lark 往返才能開始編。掃描是「重新整理」不是進場門檻。
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/osm-uat/tc-list')
        const d = await r.json() as { ok: boolean; tcs?: BackendTc[]; capturedAt?: string | null }
        if (!d.ok) return
        // 已經掃描過就不要用快照蓋掉線上資料
        setTcs(prev => prev.length ? prev : (d.tcs ?? []))
        setTcSnapshotAt(d.capturedAt ?? null)
      } catch { /* 離線清單載不到就等掃描，不擋住其他操作 */ }
    })()
  }, [])
  const credProfileLabel = (profile: string) => profile === 'cpBackend' ? 'CP 後台' : 'NC 後台'
  // 執行位置：Playwright 跑在哪台機器上。'' = 自動挑一台線上的 agent，
  // 'server' = 明確要求跑在伺服器本機（fallback，公網環境不一定裝得動瀏覽器）
  const [agents, setAgents] = useState<BackendUatAgent[]>([])
  /** 有連線、屬於自己、但缺 backend-uat capability 的 agent 數（多半是還沒更新程式碼） */
  const [outdatedAgents, setOutdatedAgents] = useState(0)
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [runMode, setRunMode] = useState<{ mode: 'agent' | 'server'; agentHostname?: string } | null>(null)
  const loadAgents = useCallback(async () => {
    try {
      const response = await fetch('/api/osm-uat/agents')
      const data = await response.json() as { ok: boolean; agents?: BackendUatAgent[]; outdated?: number }
      if (data.ok) { setAgents(data.agents ?? []); setOutdatedAgents(data.outdated ?? 0) }
    } catch { /* agent 清單抓不到就當作沒有可用 agent，不擋住主要流程 */ }
  }, [])
  useEffect(() => {
    void loadAgents()
    const timer = window.setInterval(() => void loadAgents(), 10_000)
    return () => window.clearInterval(timer)
  }, [loadAgents])
  const loadCreds = useCallback(async () => {
    try {
      const response = await fetch('/api/osm-uat/backend-credentials')
      const data = await response.json() as { ok: boolean; credentials?: { profile: string; username: string; hasPassword: boolean }[] }
      if (data.ok) setCreds(data.credentials ?? [])
    } catch { /* 設定讀不到就讓畫面留空，不擋住主要流程 */ }
  }, [])
  useEffect(() => { void loadCreds() }, [loadCreds])
  const saveCred = async (profile: string) => {
    const draft = credDraft[profile] ?? { username: '', password: '' }
    const username = draft.username || creds.find(item => item.profile === profile)?.username || ''
    if (!username) { setCredMsg({ text: `${credProfileLabel(profile)}：請先填帳號`, tone: 'error' }); return }
    setCredMsg({ text: '儲存中…', tone: 'busy' })
    try {
      const response = await fetch('/api/osm-uat/backend-credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, username, password: draft.password || undefined }),
      })
      const data = await response.json() as { ok: boolean; message?: string; credentials?: typeof creds }
      if (data.ok) {
        setCreds(data.credentials ?? [])
        setCredDraft(prev => ({ ...prev, [profile]: { username: '', password: '' } }))
        setCredMsg({ text: `${credProfileLabel(profile)}已儲存`, tone: 'ok' })
      } else {
        setCredMsg({ text: data.message ?? `${credProfileLabel(profile)}儲存失敗`, tone: 'error' })
      }
    } catch { setCredMsg({ text: `${credProfileLabel(profile)}儲存失敗`, tone: 'error' }) }
  }
  const streamRef = useRef<EventSource | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  const connect = useCallback(() => {
    streamRef.current?.close()
    const stream = new EventSource('/api/osm-uat/stream')
    streamRef.current = stream
    stream.addEventListener('log', event => setLogs(lines => [...lines, (JSON.parse(event.data) as { line: string }).line]))
    stream.addEventListener('stats', event => {
      try { setNetStats(JSON.parse(event.data) as UatStatsPayload); setStatsAt(Date.now()) } catch { /* 壞掉的一筆跳過就好，不要讓面板整個掛掉 */ }
    })
    stream.addEventListener('status', event => {
      const next = (JSON.parse(event.data) as { status: RunStatus }).status
      statusRef.current = next
      setStatus(next)
      if (next === 'done' || next === 'error') { stream.close(); streamRef.current = null }
    })
    stream.onerror = () => {
      stream.close(); streamRef.current = null
      if (statusRef.current === 'running') window.setTimeout(connect, 3000)
    }
  }, [])

  useEffect(() => { connect(); return () => streamRef.current?.close() }, [connect])
  useEffect(() => { if (autoScroll && status === 'running') logEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [autoScroll, logs, status])

  const update = (patch: Partial<UatConfig>) => setConfig(value => {
    const next = { ...value, ...patch }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return next
  })

  const selectedModule = config.modulePlan.find(module => module.instanceId === selectedModuleId) ?? null
  const modulePlanValid = config.modulePlan.length > 0 && config.modulePlan.every(module => module.name.trim() && module.filters.length > 0)
  const moduleCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const group of groups ?? []) {
      const specific = config.modulePlan.find(module => !module.filters.includes('*') && matchesBackendModule(module, group.name))
      const fallback = config.modulePlan.find(module => module.filters.includes('*'))
      const match = specific ?? fallback
      if (match) counts.set(match.instanceId, (counts.get(match.instanceId) ?? 0) + group.count)
    }
    return counts
  }, [config.modulePlan, groups])

  /**
   * 每個模組收到哪幾筆 TC。比對規則沿用 moduleCounts 那一套（specific 優先、
   * 沒有才落到 * 的 fallback 模組），不要另外寫一份——兩份比對邏輯遲早會漂移，
   * 症狀是「清單顯示 4 筆但實際跑了 5 筆」。
   */
  const moduleTcs = useMemo(() => {
    const out = new Map<string, BackendTc[]>()
    const fallback = config.modulePlan.find(module => module.filters.includes('*'))
    for (const tc of tcs) {
      const key = tc.sub || tc.taskType || '未分類'
      const specific = config.modulePlan.find(module => !module.filters.includes('*') && matchesBackendModule(module, key))
      const match = specific ?? fallback
      if (!match) continue
      const list = out.get(match.instanceId) ?? []
      list.push(tc)
      out.set(match.instanceId, list)
    }
    return out
  }, [config.modulePlan, tcs])

  const selectedTc = tcs.find(tc => tc.recordId === selectedTcId) ?? null

  const importInput = useRef<HTMLInputElement | null>(null)
  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''   // 選同一個檔案兩次也要能觸發
    if (!file) return
    try {
      const body = JSON.parse(await file.text()) as unknown
      const response = await fetch('/api/osm-uat/tc-steps/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await response.json() as { ok: boolean; added?: number; updated?: number; total?: number; message?: string }
      if (!data.ok) { setRecMsg(data.message ?? '匯入失敗'); return }
      setRecMsg(`匯入完成：新增 ${data.added} 筆、覆蓋 ${data.updated} 筆，目前共 ${data.total} 筆有積木`)
      // 清單上的「N 積木」徽章要跟著更新
      const listed = await fetch('/api/osm-uat/tc-list').then(r => r.json()).catch(() => null) as { ok?: boolean; tcs?: BackendTc[] } | null
      if (listed?.ok && listed.tcs) {
        const counts = new Map(listed.tcs.map(t => [t.recordId, t.stepCount]))
        setTcs(prev => prev.map(t => ({ ...t, stepCount: counts.get(t.recordId) ?? t.stepCount })))
      }
    } catch { setRecMsg('匯入失敗：檔案不是合法的 JSON') }
  }

  const startWorkbenchRecord = async () => {
    setRecMsg('正在開啟後台並登入…')
    try {
      const response = await fetch('/api/osm-uat/record/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 帶上「執行位置」選的那台。錄製的瀏覽器會開在那台機器上，
        // 不帶的話會自動挑一台，使用者選了卻沒被採用
        body: JSON.stringify({ agentId: selectedAgentId || undefined }),
      })
      const data = await response.json() as { ok: boolean; sessionId?: string; message?: string; agentLabel?: string }
      if (!data.ok || !data.sessionId) { setRecMsg(data.message ?? '錄製啟動失敗'); return }
      setRecSession(data.sessionId); setRecCount(0); setRecNet([])
      setRecMsg(`錄製中：瀏覽器已開在 ${data.agentLabel || '你的 Local Agent'} 上。要標檢查條件：點視窗右下角的「標記模式」再點元素，或按住 Alt／⌥ Option 點`)
    } catch { setRecMsg('錄製啟動失敗') }
  }

  const finishWorkbenchRecord = useCallback(async (sessionId: string) => {
    setRecSession(null)
    try {
      const response = await fetch(`/api/osm-uat/record/stop/${sessionId}`, { method: 'POST' })
      const data = await response.json() as { ok: boolean; steps?: Step[]; hasAssertion?: boolean }
      const recorded = data.steps ?? []
      if (!recorded.length) { setRecMsg('這次沒有錄到任何操作'); return }
      // 沒有斷言的腳本跑起來永遠 PASS，那不是測試是重播——問清楚而不是安靜收下
      if (!data.hasAssertion) {
        const warn = `錄到 ${recorded.length} 顆積木，但一個檢查條件都沒有。\n\n`
          + '這樣的腳本跑起來永遠 PASS（等於只是重播操作，不會驗任何東西）。\n'
          + '仍要保留嗎？（也可以取消，重錄時用視窗右下角的「標記模式」，或按住 Alt／⌥ Option 點元素）'
        if (!window.confirm(warn)) { setRecMsg('已捨棄這次錄製'); return }
      }
      setPendingSteps(recorded)
      setPickerOpen(true)
      setPickerQuery('')
      setRecMsg(`錄到 ${recorded.length} 顆積木，選一筆 TC 放進去`)
    } catch { setRecMsg('取得錄製結果失敗') }
  }, [])

  // 錄製期間輪詢：讓按鈕看得出已經錄到幾顆；使用者自己關掉瀏覽器時也要收尾
  useEffect(() => {
    if (!recSession) return
    let stopped = false
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/osm-uat/record/status/${recSession}`)
        const data = await response.json() as { ok: boolean; done?: boolean; error?: string | null; steps?: Step[]; netCalls?: RecNetCall[] }
        if (!data.ok || stopped) return
        setRecCount(data.steps?.length ?? 0)
        setRecNet(data.netCalls ?? [])
        if (data.done) {
          stopped = true; window.clearInterval(timer)
          // 有 error 代表這輪根本沒開起來（最常見是 agent 沒重啟）。
          // 這種情況不要走「拿積木」那條路——那會顯示「這次沒錄到任何操作」，
          // 把一個明確的失敗說成使用者自己沒操作。
          if (data.error) { setRecSession(null); setRecMsg(data.error); return }
          void finishWorkbenchRecord(recSession)
        }
      } catch { /* 一次查不到不用中斷輪詢 */ }
    }, 2000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [recSession, finishWorkbenchRecord])

  /**
   * 把一筆錄到的 API 變成斷言積木。
   *
   * 只「看得到」的話，使用者還是得自己把「這支 API 應該回 200」翻譯成積木——
   * 中間那段轉換正是不熟的人卡住的地方。
   *
   * 用 urlPattern 不用原始網址：原始網址裡的 id／token／時間戳會讓斷言
   * 錄完當天可以跑、隔天全紅。
   */
  const addApiAssertion = (call: RecNetCall) => {
    const is2xx = !!call.status && call.status >= 200 && call.status < 300
    const step: Step = {
      action: 'assert_api_called',
      urlPattern: call.urlPattern,
      // 錄到 2xx 就設成「要 2xx」；錄到非 2xx 則固定成當下那個碼——
      // 那種情況使用者要的多半是「這裡本來就會這樣」或「這裡不該錯」，
      // 兩種都得先看到實際的碼才好決定，預設成 2xx 等於我們幫他猜
      expectStatus: is2xx ? '2xx' : 'exact',
      ...(is2xx ? {} : { statusCode: call.status }),
    }
    setPendingSteps(prev => [...(prev ?? []), step])
    setRecMsg(`已加一顆斷言：${call.method} ${call.urlPattern}（可在積木編輯器再調整）`)
  }

  const saveAsCustomTc = async () => {
    if (!pendingSteps?.length) return
    const title = newTcTitle.trim()
    if (!title) { setRecMsg('請先給這筆新 TC 一個名稱'); return }
    setSavingNewTc(true)
    try {
      const response = await fetch('/api/osm-uat/custom-tcs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, linkKeyword: newTcKeyword.trim(), steps: pendingSteps }),
      })
      const data = await response.json() as { ok: boolean; message?: string }
      if (!data.ok) { setRecMsg(data.message ?? '存成自訂 TC 失敗'); return }
      setPendingSteps(null); setPickerOpen(false)
      setNewTcTitle(''); setNewTcKeyword('')
      setRecMsg(newTcKeyword.trim()
        ? `已存成自訂 TC「${title}」，之後掃到符合關鍵字的 Lark TC 可以一鍵歸戶`
        : `已存成自訂 TC「${title}」（沒填歸戶關鍵字，之後想歸戶再補）`)
      void loadCustomTcs()
    } catch { setRecMsg('存成自訂 TC 失敗') } finally { setSavingNewTc(false) }
  }

  /** 可選的子類型與各自筆數。來源是已載入的 TC 清單（離線快照就有），不用先掃描 */
  const subtypeOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tc of tcs) {
      const key = (tc.sub || '').trim()
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-TW')).map(([name, count]) => ({ name, count }))
  }, [tcs])

  /** 目前選了哪些。沿用既有的逗號分隔字串當儲存格式，後端契約完全不用改 */
  const selectedSubtypes = useMemo(
    () => config.filter.split(',').map(v => v.trim()).filter(Boolean),
    [config.filter])
  const toggleSubtype = (name: string) => {
    const next = selectedSubtypes.includes(name)
      ? selectedSubtypes.filter(v => v !== name)
      : [...selectedSubtypes, name]
    update({ filter: next.join(',') })
  }

  const updateModule = (instanceId: string, patch: Partial<BackendPlanModule>) => update({
    modulePlan: config.modulePlan.map(module => module.instanceId === instanceId ? { ...module, ...patch } : module),
  })
  const selectModule = (instanceId: string) => { setSelectedModuleId(instanceId); setSettingsView('module') }
  const addModule = (id: BackendModuleId) => {
    const definition = BACKEND_MODULES.find(module => module.id === id)
    if (!definition) return
    const module = createBackendModule(definition, newInstanceId(id))
    update({ modulePlan: [...config.modulePlan, module] }); selectModule(module.instanceId)
  }
  const addCustomModule = () => {
    const module = createCustomBackendModule(newInstanceId())
    update({ modulePlan: [...config.modulePlan, module] }); selectModule(module.instanceId)
  }
  const duplicateModule = (instanceId: string) => {
    const source = config.modulePlan.find(module => module.instanceId === instanceId)
    if (!source) return
    const copy = { ...source, instanceId: newInstanceId(source.sourceId), name: `${source.name} 副本`, xianxiaName: `${source.xianxiaName} 副本`, filters: [...source.filters] }
    const index = config.modulePlan.findIndex(module => module.instanceId === instanceId)
    const next = [...config.modulePlan]; next.splice(index + 1, 0, copy)
    update({ modulePlan: next }); selectModule(copy.instanceId)
  }
  const removeModule = (instanceId: string) => {
    const next = config.modulePlan.filter(module => module.instanceId !== instanceId)
    update({ modulePlan: next })
    if (selectedModuleId === instanceId) { setSelectedModuleId(next[0]?.instanceId ?? null); setSettingsView(next.length ? 'module' : 'run') }
  }
  const moveModule = (source: string, target: string) => {
    if (source === target) return
    const next = [...config.modulePlan]
    const from = next.findIndex(module => module.instanceId === source); const to = next.findIndex(module => module.instanceId === target)
    if (from < 0 || to < 0) return
    const [moved] = next.splice(from, 1); next.splice(to, 0, moved)
    update({ modulePlan: next })
  }
  const moveModuleBy = (instanceId: string, offset: -1 | 1) => {
    const from = config.modulePlan.findIndex(module => module.instanceId === instanceId); const to = from + offset
    if (from < 0 || to < 0 || to >= config.modulePlan.length) return
    const next = [...config.modulePlan]; [next[from], next[to]] = [next[to], next[from]]; update({ modulePlan: next })
  }

  const scan = async () => {
    if (!config.larkUrl) return
    setScanning(true); setGroups(null)
    try {
      const response = await fetch(`/api/osm-uat/scan?larkUrl=${encodeURIComponent(config.larkUrl)}`)
      const data = await response.json() as { ok: boolean; error?: string; total?: number; groups?: TcGroup[]; tcs?: BackendTc[] }
      if (!data.ok) return window.alert(data.error ?? '掃描失敗')
      setTotal(data.total ?? 0); setGroups(data.groups ?? [])
      // 線上結果為準；只存在於快照、這次沒掃到的保留下來但維持 registry 標記——
      // 那多半是已經從 Lark 移除的 TC，直接消失的話使用者會以為自己編的積木不見了
      setTcs(prev => {
        const live = data.tcs ?? []
        const liveIds = new Set(live.map(t => t.recordId))
        const snapshotOnly = prev.filter(t => t.source !== 'live' && !liveIds.has(t.recordId))
        return [...live, ...snapshotOnly]
      })
      setTcScanned(true)
    } finally { setScanning(false) }
  }

  const run = async () => {
    if (!config.modulePlan.length) return window.alert('請至少加入一個 Backend 測試模組')
    if (!modulePlanValid) return window.alert('每個模組都必須有名稱與至少一條 TC 匹配規則')
    setLogs([]); statusRef.current = 'running'; setStatus('running'); setRunMode(null); setNetStats(null); setStatsAt(null)
    const response = await fetch('/api/osm-uat/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, filter: config.filter || undefined, dashGameType: config.dashGameType || undefined, dashClientVersion: config.dashClientVersion || undefined, agentId: selectedAgentId || undefined }) })
    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: '啟動失敗' })) as { error?: string }
      statusRef.current = 'idle'; setStatus('idle'); return window.alert(`啟動失敗：${data.error}`)
    }
    const data = await response.json().catch(() => null) as { mode?: 'agent' | 'server'; agentHostname?: string } | null
    if (data?.mode) setRunMode({ mode: data.mode, agentHostname: data.agentHostname })
    void loadAgents()
    connect()
  }

  const summary = logs.reduce((result, line) => {
    const match = line.match(/通過:\s*(\d+).*需人工:\s*(\d+).*跳過:\s*(\d+).*失敗:\s*(\d+)/)
    return match ? { pass: +match[1], manual: +match[2], skip: +match[3], fail: +match[4] } : result
  }, { pass: 0, manual: 0, skip: 0, fail: 0 })
  const statusLabel = status === 'idle' ? (xianxia ? '玉簡未啟' : '待機') : status === 'running' ? (xianxia ? '推演中' : '執行中') : status === 'done' ? (xianxia ? '推演完成' : '完成') : (xianxia ? '陣眼失守' : '錯誤')

  // ── 第一屏行動列要用的資訊（2026-08-29）──
  // 量過：原本「執行模組流程」在 y=1298、視窗高 1000，**要捲兩屏才看得到**。
  // 新使用者第一個問題是「我要怎麼開始跑」，第一屏卻只有設定沒有動作。
  // 這裡不搬走任何既有控制項，只是把主要動作補到第一屏並說明它會做什麼。
  const plannedTcTotal = groups
    ? config.modulePlan.reduce((sum, module) => sum + (moduleCounts.get(module.instanceId) ?? 0), 0)
    : null
  const targetAgent = selectedAgentId
    ? agents.find(agent => agent.agentId === selectedAgentId)?.hostname ?? selectedAgentId
    : agents.some(agent => !agent.busy)
      ? `自動挑一台（${agents.filter(agent => !agent.busy).length} 台可用）`
      : null
  // 三個起手步驟各自的完成狀態。**這不只是新手教學，也是「按鈕為什麼是灰的」的答案**
  // ——原本按鈕 disabled 時畫面上沒有任何地方說明原因。
  const startSteps = [
    { label: xianxia ? '選要推演的術式' : '選要跑的模組', done: modulePlanValid },
    { label: xianxia ? '選在哪具傀儡上跑' : '選在哪台機器跑', done: !!targetAgent },
    { label: xianxia ? '啟陣' : '開始執行', done: false },
  ]
  const blockedReason = !config.larkUrl
    ? 'Lark TC 路徑還沒填（在右邊「執行設定」）'
    : !modulePlanValid
      ? '每個模組都要有名稱與至少一條 TC 匹配規則'
      : null

  return (
    <div className="uat-backend-workbench">
      {/* 第一屏行動列：整頁唯一的主要按鈕，外加「按下去會發生什麼」。
          放在 workbench 最上面而不是頁首——頁首在 OsmUatPage，把狀態拉上去要動到
          元件邊界，這裡放一樣在第一屏內，改動範圍小很多。 */}
      <div className="uat-backend-launch">
        <div className="uat-backend-launch-steps">
          {startSteps.map((step, index) => (
            <span className={`uat-launch-step${step.done ? ' is-done' : ''}`} key={step.label}>
              <i>{index + 1}</i>{step.label}
            </span>
          ))}
          {blockedReason
            ? <span className="uat-launch-block">{blockedReason}</span>
            : <span className="uat-launch-ready">{xianxia ? '陣眼齊備，可以啟陣' : '前兩步都好了，可以執行'}</span>}
        </div>
        <div className="uat-backend-launch-cta">
          <div className="uat-backend-launch-meta">
            <b>{config.modulePlan.length}</b> 個模組
            {plannedTcTotal !== null && <> · 共 <b>{plannedTcTotal}</b> 筆 TC</>}
            {targetAgent && <> · 跑在 <b>{targetAgent}</b></>}
          </div>
          {status === 'running'
            ? <button type="button" className="uat-btn is-danger is-wide" onClick={() => fetch('/api/osm-uat/stop', { method: 'POST' })}>{xianxia ? '收陣' : '停止執行'}</button>
            : <button type="button" className="uat-btn is-primary is-wide" disabled={!modulePlanValid || !config.larkUrl} onClick={run}>{xianxia ? '依序啟陣' : '開始執行'}</button>}
        </div>
      </div>

      <aside className="uat-backend-library">
        <div className="uat-pane-heading"><div><span>{xianxia ? 'SPELL LIBRARY' : 'MODULE LIBRARY'}</span><h3>{xianxia ? '術式庫' : '模組庫'}</h3><small>模板可重複加入並獨立編輯</small></div></div>
        <button type="button" className="uat-btn is-primary is-wide uat-backend-create" disabled={status === 'running'} onClick={addCustomModule}>{xianxia ? '新增自訂術式' : '新增自訂模組'}</button>
        {(['核心資料', '營運驗證', '系統治理'] as const).map(category => (
          <section className="uat-backend-library-group" key={category}><h4>{category}</h4>
            {BACKEND_MODULES.filter(module => module.category === category).map(module => <button type="button" className={`uat-backend-library-item is-${module.tone}`} onClick={() => addModule(module.id)} disabled={status === 'running'} key={module.id}><i /><span><strong>{xianxia ? module.xianxiaName : module.name}</strong><small>{module.description}</small></span><b>加入</b></button>)}
          </section>
        ))}
      </aside>

      <main className="uat-backend-flow">
        <div className="uat-backend-flow-head">
          <div className="uat-section-title"><span>{xianxia ? 'TRIAL SEQUENCE' : 'EXECUTION FLOW'}</span><h3>{xianxia ? '推演順序' : '執行流程'} <small>{config.modulePlan.length + 1} 個模組</small></h3><p>拖曳調整順序；點選卡片可編輯名稱、說明與 TC 匹配規則。</p></div>
          <div className="uat-backend-flow-actions">
            <button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={addCustomModule}>新增模組</button>
            <button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={() => { const plan = createDefaultBackendPlan(); update({ modulePlan: plan }); setSelectedModuleId(plan[0]?.instanceId ?? null) }}>還原預設</button>
            {recSession
              ? <button type="button" className="uat-btn is-danger" onClick={() => void finishWorkbenchRecord(recSession)}>停止錄製（{recCount} 顆）</button>
              : <button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={() => void startWorkbenchRecord()}>錄製</button>}
            <button type="button" className="uat-btn is-quiet" title="把所有 TC 的積木匯出成一個檔案，帶到別的環境匯入" onClick={() => { window.location.href = '/api/osm-uat/tc-steps/export' }}>匯出積木</button>
            <button type="button" className="uat-btn is-quiet" title="從匯出的檔案匯入積木（同一筆以檔案為準，沒提到的保留）" onClick={() => importInput.current?.click()}>匯入積木</button>
            {/* 破壞性動作排在最後、用分隔線隔開。刻意不加確認彈窗——那只會養成
                無腦點確認的習慣，真正該做的是讓它「看起來就不一樣」且不順手誤按 */}
            <span className="uat-action-sep" aria-hidden="true" />
            <button type="button" className="uat-btn is-danger-quiet" disabled={status === 'running'} onClick={() => { update({ modulePlan: [] }); setSelectedModuleId(null); setSettingsView('run') }}>清空流程</button>
            <input ref={importInput} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={event => void handleImport(event)} />
          </div>
        </div>
        <div className="uat-backend-module-list">
          <article className="uat-backend-module is-fixed is-cyan"><span className="uat-backend-module-grip" aria-hidden="true"><i /><i /><i /></span><div><strong>{xianxia ? '共用登入傀儡' : '共用登入與初始化'}</strong><small>取得 Lark token、載入 TC registry、啟動 Chromium 並登入 CP Backend</small></div><em>固定</em></article>
          {config.modulePlan.map((module, index) => (
            <Fragment key={module.instanceId}>
            <article className={`uat-backend-module is-${module.tone}${draggedModule === module.instanceId ? ' is-dragging' : ''}${selectedModuleId === module.instanceId ? ' is-selected' : ''}`} draggable={status !== 'running'} onClick={() => selectModule(module.instanceId)} onDragStart={() => setDraggedModule(module.instanceId)} onDragEnd={() => setDraggedModule(null)} onDragOver={event => event.preventDefault()} onDrop={() => { if (draggedModule) moveModule(draggedModule, module.instanceId); setDraggedModule(null) }}>
              <span className="uat-backend-module-grip" aria-hidden="true"><i /><i /><i /></span><span className="uat-backend-module-index">{String(index + 1).padStart(2, '0')}</span>
              <div><strong>{xianxia ? module.xianxiaName : module.name}{module.sourceId === 'custom' && <b className="uat-backend-custom-badge">自訂</b>}</strong><small>{module.description}</small><span className="uat-backend-rule-preview">{module.filters.join(' · ')}</span></div>
              {tcs.length > 0 && <em className="uat-backend-module-count" role="button" tabIndex={0}
                title="展開看這個模組收到哪幾筆 TC，點進去可以編積木"
                onClick={event => { event.stopPropagation(); setExpandedModule(prev => prev === module.instanceId ? null : module.instanceId) }}
                onKeyDown={event => { if (event.key === "Enter") { event.stopPropagation(); setExpandedModule(prev => prev === module.instanceId ? null : module.instanceId) } }}>
                {(moduleTcs.get(module.instanceId) ?? []).length} TC {expandedModule === module.instanceId ? "▾" : "▸"}</em>}
              <span className="uat-backend-module-actions"><button type="button" disabled={status === 'running' || index === 0} onClick={event => { event.stopPropagation(); moveModuleBy(module.instanceId, -1) }}>上移</button><button type="button" disabled={status === 'running' || index === config.modulePlan.length - 1} onClick={event => { event.stopPropagation(); moveModuleBy(module.instanceId, 1) }}>下移</button><button type="button" disabled={status === 'running'} onClick={event => { event.stopPropagation(); duplicateModule(module.instanceId) }}>複製</button><button type="button" disabled={status === 'running'} onClick={event => { event.stopPropagation(); removeModule(module.instanceId) }}>移除</button></span>
            </article>
              {expandedModule === module.instanceId && (
                <div className="uat-backend-tc-list" onClick={event => event.stopPropagation()}>
                  {(moduleTcs.get(module.instanceId) ?? []).slice(0, 40).map(tc => (
                    <button type="button" key={tc.recordId}
                      className={`uat-backend-tc${selectedTcId === tc.recordId ? " is-selected" : ""}`}
                      onClick={() => setSelectedTcId(tc.recordId)}>
                      <span title={tc.text}>
                        {tc.source !== 'live' && tcScanned && <b className="uat-backend-tc-stale" title="這次掃描沒有在 Lark 上找到，可能已被移除">快照</b>}
                        {tc.text || tc.recordId}
                      </span>
                      <em className={tc.stepCount ? "has-steps" : ""}>{tc.stepCount ? `${tc.stepCount} 積木` : "內建"}</em>
                    </button>
                  ))}
                  {!(moduleTcs.get(module.instanceId) ?? []).length && <div className="uat-backend-tc-more">這個模組目前沒有收到 TC</div>}
                  {(moduleTcs.get(module.instanceId) ?? []).length > 40 && <div className="uat-backend-tc-more">…另外還有 {(moduleTcs.get(module.instanceId) ?? []).length - 40} 筆</div>}
                </div>
              )}
            </Fragment>
          ))}
          {!config.modulePlan.length && <div className="uat-backend-flow-empty"><strong>尚未加入測試模組</strong><span>新增自訂模組，或從左側模板庫加入。</span></div>}
        </div>
        <footer className="uat-backend-flow-foot"><span>每個模組都是獨立實例，設定會儲存在此瀏覽器並傳入新的 runner process。{!tcScanned && tcs.length > 0 && ` TC 清單來自 ${tcSnapshotAt ? tcSnapshotAt.slice(0, 10) + ' 的' : ''}離線快照，掃描後會補上之後新增的。`}</span><b>{groups ? `已掃描 ${total} TC` : '尚未掃描 TC'}</b></footer>
      </main>

      <aside className="uat-backend-settings">
        <div className="uat-backend-settings-tabs"><button type="button" className={settingsView === 'run' ? 'is-active' : ''} onClick={() => setSettingsView('run')}>執行設定</button><button type="button" className={settingsView === 'module' ? 'is-active' : ''} disabled={!selectedModule} onClick={() => setSettingsView('module')}>模組編輯</button></div>
        {settingsView === 'module' && selectedModule ? <>
          <div className="uat-pane-heading"><div><span>{xianxia ? 'SPELL CONTRACT' : 'MODULE CONTRACT'}</span><h3>{xianxia ? '術式設定' : '模組編輯'}</h3><small>修改會即時保存到目前流程</small></div></div>
          <div className="uat-backend-settings-form uat-backend-module-editor">
            <label>普通版名稱<input className="uat-field" value={selectedModule.name} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { name: event.target.value })} /></label>
            <label>修仙版名稱<input className="uat-field" value={selectedModule.xianxiaName} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { xianxiaName: event.target.value })} /></label>
            <label>模組說明<textarea className="uat-field" value={selectedModule.description} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { description: event.target.value })} /></label>
            <label>TC 匹配規則<textarea className="uat-field uat-code-field uat-backend-rules" value={selectedModule.filters.join('\n')} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { filters: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} placeholder={'每行一個關鍵字\n例如：Daily Ranking'} /><small>不區分大小寫，匹配任務類型或子類型；單獨輸入 * 代表接收未分類 TC。</small></label>
            <label>識別色<select className="uat-field" value={selectedModule.tone} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { tone: event.target.value as BackendModuleTone })}>{TONES.map(tone => <option value={tone} key={tone}>{tone}</option>)}</select></label>
          </div>
          <div className="uat-backend-editor-meta"><span>模組 ID</span><code>{selectedModule.instanceId}</code><b>{groups ? `${moduleCounts.get(selectedModule.instanceId) ?? 0} TC` : `${selectedModule.filters.length} 條規則`}</b></div>
          <div className="uat-backend-editor-actions"><button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={() => duplicateModule(selectedModule.instanceId)}>複製模組</button><button type="button" className="uat-btn is-danger" disabled={status === 'running'} onClick={() => removeModule(selectedModule.instanceId)}>移除模組</button></div>
        </> : <>
          <div className="uat-pane-heading"><div><span>{xianxia ? 'ARRAY SETTINGS' : 'RUN SETTINGS'}</span><h3>{xianxia ? '陣眼設定' : '執行設定'}</h3><small>套用至本次模組流程</small></div></div>
          <div className="uat-backend-settings-form">
            <div className="uat-backend-cred-box">
              <b>執行位置</b>
              <small>Playwright 實際跑在哪台機器。派工給 Local Agent 時，伺服器只負責建 session、轉日誌。</small>
              <select className="uat-field" value={selectedAgentId} disabled={status === 'running'}
                onChange={event => setSelectedAgentId(event.target.value)}>
                <option value="">自動挑一台線上 Agent{agents.length ? `（目前 ${agents.filter(a => !a.busy).length} 台可用）` : '（目前沒有）'}</option>
                {agents.map(agent => (
                  <option value={agent.agentId} key={agent.agentId}>
                    {agent.hostname}{agent.busy ? '（忙碌中）' : ''}
                  </option>
                ))}
                <option value="server">伺服器端（fallback）</option>
              </select>
              {!agents.length && outdatedAgents > 0 && (
                <span className="uat-backend-cred-msg is-error">
                  有 {outdatedAgents} 台 Agent 連線中，但版本太舊（沒有 backend-uat 能力）。
                  請到「Local Agent」頁面按「更新程式碼」，然後重新啟動 Agent。
                </span>
              )}
              {runMode && (
                <span className="uat-backend-cred-msg">
                  {runMode.mode === 'agent' ? `本次派工給 ${runMode.agentHostname ?? 'Agent'}` : '本次跑在伺服器端'}
                </span>
              )}
            </div>
            <div className="uat-backend-cred-box">
              <b>後台登入帳密</b>
              <small>用你自己的帳號跑測試；密碼只存在伺服器，畫面不顯示。</small>
              {creds.map(item => {
                const draft = credDraft[item.profile] ?? { username: '', password: '' }
                return (
                  <div className="uat-backend-cred-row" key={item.profile}>
                    <div className="uat-backend-cred-head">
                      <strong>{credProfileLabel(item.profile)}</strong>
                      <span className={`uat-backend-cred-state${item.hasPassword ? ' is-set' : ''}`}><i />{item.hasPassword ? '已設定' : '未設定'}</span>
                    </div>
                    <input className="uat-field" placeholder={item.username || '帳號'} value={draft.username}
                      onChange={event => setCredDraft(prev => ({ ...prev, [item.profile]: { ...draft, username: event.target.value } }))} />
                    <div className="uat-backend-cred-pair">
                      <input className="uat-field" type="password" placeholder={item.hasPassword ? '密碼留空＝不修改' : '密碼'} value={draft.password}
                        onChange={event => setCredDraft(prev => ({ ...prev, [item.profile]: { ...draft, password: event.target.value } }))} />
                      <button type="button" className="uat-btn is-quiet" onClick={() => void saveCred(item.profile)}>儲存</button>
                    </div>
                  </div>
                )
              })}
              {credMsg && <span className={`uat-backend-cred-msg${credMsg.tone === 'error' ? ' is-error' : ''}`}>{credMsg.tone === 'ok' ? '✓ ' : ''}{credMsg.text}</span>}
            </div>
            <label>{xianxia ? 'Lark 玉簡路徑' : 'Lark TC 路徑'}<textarea className="uat-field uat-backend-url" value={config.larkUrl} onChange={event => update({ larkUrl: event.target.value })} placeholder="https://xxx.larksuite.com/base/...?table=..." /></label>
            <button type="button" className="uat-btn is-quiet is-wide" disabled={!config.larkUrl || scanning} onClick={scan}>{scanning ? '掃描中' : (xianxia ? '重整玉簡索引' : '掃描 Lark TC')}</button>
            <label>{xianxia ? '玉簡篩選' : 'Subtype 追加篩選'}
              <button type="button" className="uat-field uat-subtype-trigger" onClick={() => setSubtypeModal(true)}>
                {selectedSubtypes.length
                  ? `已選 ${selectedSubtypes.length} 個子類型`
                  : '全部（套用模組範圍）'}
                <em>選擇…</em>
              </button>
              <small>不選就是照模組流程跑；選了會在模組範圍內再縮小。</small>
            </label>
            {/* 這個欄位存在 localStorage 會一直記著，而且它會蓋掉模組範圍——
                使用者忘記自己填過，就會以為「執行模組流程」壞掉了（實際回報過：
                「不會抓目前設定好的模塊，只會執行 gameRecord 的 TC」）。
                填著的時候要講清楚，並且給一鍵清除 */}
            {config.filter.trim() && (
              <div className="uat-filter-warn">
                <span>
                  目前只會跑子類型含「<b>{config.filter.trim()}</b>」的 TC，
                  <b>模組流程裡其他的都會被跳過</b>。
                </span>
                <button type="button" className="uat-btn is-quiet" onClick={() => update({ filter: '' })}>清除篩選</button>
              </div>
            )}
            <div className="uat-backend-setting-pair"><label>Game Type<input className="uat-field" value={config.dashGameType} onChange={event => update({ dashGameType: event.target.value })} placeholder="BWJL" /></label><label>Client Version<input className="uat-field" value={config.dashClientVersion} onChange={event => update({ dashClientVersion: event.target.value })} placeholder="H5(1.5)" /></label></div>
          </div>
          <div className="uat-backend-run-summary"><span><b>{config.modulePlan.length}</b> 個可執行模組</span><span><b>{groups ? config.modulePlan.reduce((sum, module) => sum + (moduleCounts.get(module.instanceId) ?? 0), 0) : '—'}</b> 個匹配 TC</span></div>
          {/* 執行／停止已移到第一屏的行動列（.uat-backend-launch）。這裡不再放第二組——
              兩顆做同一件事的按鈕會讓人不確定哪顆才是對的。 */}
          <span className={`uat-run-status is-${status}`}><i />{statusLabel}</span>
        </>}
      </aside>

      {/* 錄製期間即時列出打到的 API。放在狀態列下面而不是彈框裡——
          使用者是「一邊操作一邊看」的，塞進彈框等於還要多開一次 */}
      {recSession && !!recNet.length && (
        <div className="uat-rec-net">
          <h4>這次錄製打到的 API <em>{recNet.length}</em></h4>
          <div className="uat-rec-net-list">
            {[...recNet].reverse().slice(0, 40).map((c, i) => (
              <button type="button" className="uat-rec-net-row" key={`${c.ts}-${i}`}
                title="點一下把這支 API 變成斷言積木"
                onClick={() => addApiAssertion(c)}>
                <span className={`uat-net-method is-${c.method.toLowerCase()}`}>{c.method}</span>
                {/* 非 2xx 標出來——那通常就是最值得下斷言的地方 */}
                <b className={c.status && c.status >= 400 ? 'is-bad' : ''}>{c.status ?? '—'}</b>
                <i>{c.durationMs == null ? '—' : `${c.durationMs}ms`}</i>
                <span className="uat-rec-net-url" title={`${c.url}\n比對用樣式：${c.urlPattern}`}>{c.urlPattern}</span>
                <em className="uat-rec-net-add">+ 斷言</em>
              </button>
            ))}
          </div>
          <small>點任一列可以直接把它變成斷言積木。網址已收斂（拿掉 query、id 換成 *），滑鼠移上去看原始的。</small>
        </div>
      )}

      {recMsg && (
        <div className="uat-backend-rec-bar">
          {recSession && <i />}{recMsg}
          {/* 彈框收起來之後要有辦法叫回來，不然錄好的積木等於卡在半空中 */}
          {pendingSteps && !pickerOpen && (
            <button type="button" className="uat-btn is-quiet" onClick={() => setPickerOpen(true)}>
              選擇 TC（{pendingSteps.length} 顆待放）
            </button>
          )}
        </div>
      )}

      {/* 錄完才問要放哪一筆：先錄下來、再決定它屬於哪個 TC，比先選再錄更接近實際流程 */}
      {/* 子類型複選彈框。選項從已載入的 TC 清單算，不用先掃描；
          一樣要 portal（外層 backdrop-filter 會困住 fixed） */}
      {subtypeModal && createPortal((
        <div className="uat-studio uat-tc-modal" role="dialog" aria-modal="true"
          onMouseDown={event => { if (event.target === event.currentTarget) setSubtypeModal(false) }}>
          <div className="uat-tc-picker">
            <div className="uat-tc-picker-head">
              <div>
                <span className="uat-net-kicker">SUBTYPE</span>
                <h3>選擇要跑的子類型</h3>
                <small>
                  {selectedSubtypes.length
                    ? `已選 ${selectedSubtypes.length} 個——只有這些會跑，模組流程裡其他的都會被跳過。`
                    : '目前沒有選任何子類型，會照模組流程跑全部。'}
                </small>
              </div>
              <button type="button" className="uat-btn is-quiet" onClick={() => setSubtypeModal(false)}>完成</button>
            </div>

            <div className="uat-subtype-bar">
              <input className="uat-field" value={subtypeQuery} placeholder="搜尋子類型…"
                onChange={event => setSubtypeQuery(event.target.value)} />
              <button type="button" className="uat-btn is-quiet" disabled={!selectedSubtypes.length}
                onClick={() => update({ filter: '' })}>全部清除</button>
            </div>

            <div className="uat-tc-picker-list">
              {subtypeOptions
                .filter(o => !subtypeQuery.trim() || o.name.toLowerCase().includes(subtypeQuery.trim().toLowerCase()))
                .map(o => {
                  const on = selectedSubtypes.includes(o.name)
                  return (
                    <button type="button" key={o.name}
                      className={'uat-backend-tc uat-subtype-row' + (on ? ' is-on' : '')}
                      onClick={() => toggleSubtype(o.name)}>
                      <span><i className="uat-subtype-check">{on ? '✓' : ''}</i>{o.name}</span>
                      <em>{o.count} TC</em>
                    </button>
                  )
                })}
              {!subtypeOptions.length && (
                <div className="uat-backend-tc-more">
                  還沒有子類型可選——TC 清單還沒載入完，或這份 registry 是空的。
                </div>
              )}
            </div>
          </div>
        </div>
      ), document.body)}

      {/* 一定要 portal 出去：外層有 backdrop-filter 的祖先，position: fixed 會被困在
          那個容器裡畫不出來。積木編輯器踩過同一個坑，這裡是第二次——這個 studio 版面
          只要是彈框就得 portal，不要再用一般的絕對定位試 */}
      {pendingSteps && pickerOpen && createPortal((
        <div className="uat-studio uat-tc-modal" role="dialog" aria-modal="true"
          // 點背景只收起彈框，不丟掉錄到的積木。錄一次要花好幾分鐘，
          // 一個誤點就整批消失是不能接受的；要丟掉得按「捨棄」明確表示。
          onMouseDown={event => { if (event.target === event.currentTarget) setPickerOpen(false) }}>
          <div className="uat-tc-picker">
            <div className="uat-tc-picker-head">
              <div>
                <span className="uat-net-kicker">RECORDED</span>
                <h3>錄到 {pendingSteps.length} 顆積木</h3>
                <small>選一筆 TC 接上去。接上之後可以再編輯，確認沒問題才按儲存。</small>
              </div>
              <button type="button" className="uat-btn is-quiet"
                onClick={() => {
                  if (!window.confirm(`確定要丟掉這 ${pendingSteps.length} 顆積木嗎？丟掉之後要重錄一次。`)) return
                  setPendingSteps(null); setPickerOpen(false); setRecMsg('')
                }}>捨棄</button>
            </div>
            {/* 兩條路：接到既有 Lark TC（這件事本來就要測、只是還沒有積木），
                或另存成自訂 TC（Lark 上根本沒有這筆）。第二條原本完全沒有，
                只能硬塞給不相干的既有 TC——那會蓋掉那筆原本該驗的東西 */}
            <div className="uat-tc-picker-new">
              <h4>這是 Lark 上還沒有的新流程？</h4>
              <div className="uat-tc-picker-new-row">
                <input className="uat-field" value={newTcTitle} placeholder="給這筆新 TC 一個名稱（必填）"
                  onChange={event => setNewTcTitle(event.target.value)} />
                <input className="uat-field" value={newTcKeyword} placeholder="歸戶關鍵字（選填）"
                  onChange={event => setNewTcKeyword(event.target.value)} />
                <button type="button" className="uat-btn" disabled={savingNewTc || !newTcTitle.trim()}
                  onClick={() => void saveAsCustomTc()}>另存成新 TC</button>
              </div>
              <small>
                自訂 TC 存在這個工具裡、跟其他 TC 一起跑，但<b>不會回寫 Lark</b>（那邊沒有對應的列）。
                填了歸戶關鍵字之後，掃描時只要有 Lark TC 的文字命中，就能一鍵把積木搬過去。
              </small>
            </div>

            <div className="uat-tc-picker-or">或接到既有的 Lark TC</div>
            <input className="uat-field" value={pickerQuery} placeholder="搜尋 TC 描述或子類型…"
              onChange={event => setPickerQuery(event.target.value)} />
            <div className="uat-tc-picker-list">
              {tcs
                .filter(tc => {
                  const q = pickerQuery.trim().toLowerCase()
                  return !q || [tc.text, tc.sub, tc.recordId].some(v => v.toLowerCase().includes(q))
                })
                .slice(0, 80)
                .map(tc => (
                  <button type="button" className="uat-backend-tc" key={tc.recordId}
                    onClick={() => { setSelectedTcId(tc.recordId) }}>
                    <span title={tc.text}>[{tc.sub || '未分類'}] {tc.text || tc.recordId}</span>
                    <em className={tc.stepCount ? 'has-steps' : ''}>{tc.stepCount ? `${tc.stepCount} 積木` : '內建'}</em>
                  </button>
                ))}
              {!tcs.length && (
                <div className="uat-backend-tc-more">
                  還沒有 TC 可以選——請先在上面貼 Lark 網址按「掃描 TC」，掃完這裡就會列出來。
                  <br />錄到的積木會留著，掃描完再回來選就行。
                </div>
              )}
            </div>
          </div>
        </div>
      ), document.body)}

      {/* 積木編輯器改成彈框：三欄（積木庫／步驟／參數）在工作台的欄位裡怎麼放都太窄，
          彈框才拿得到整個視窗的寬度 */}
      {selectedTc && (
        <BackendTcEditor
          tc={selectedTc}
          allTcs={tcs}
          themeMode={themeMode}
          pendingSteps={pendingSteps}
          onPendingConsumed={() => { setPendingSteps(null); setRecMsg('') }}
          onClose={() => setSelectedTcId(null)}
          onSaved={(recordId, stepCount) => setTcs(prev => prev.map(t => t.recordId === recordId ? { ...t, stepCount } : t))}
        />
      )}

      <section className="uat-backend-results"><div className="uat-stat-grid"><Stat label={xianxia ? '試煉通過' : '通過'} value={summary.pass} tone="pass" /><Stat label={xianxia ? '待真人覆核' : '需人工'} value={summary.manual} tone="manual" /><Stat label={xianxia ? '略過' : '跳過'} value={summary.skip} tone="skip" /><Stat label={xianxia ? '陣眼失守' : '失敗'} value={summary.fail} tone="fail" /></div><NetworkPanel stats={netStats} themeMode={themeMode} updatedAt={statsAt} /><section className="uat-panel uat-backend-log"><div className="uat-log-toolbar"><div className="uat-section-title"><span>{xianxia ? 'ARRAY RECORD' : 'PROCESS OUTPUT'}</span><h3>{xianxia ? '陣法行跡錄' : '即時執行日誌'}</h3></div><label className="uat-check"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />{xianxia ? '追隨靈流' : '自動捲動'}</label><button type="button" className="uat-btn is-quiet" onClick={() => setLogs([])}>{xianxia ? '拂去殘痕' : '清除'}</button></div><pre onScroll={event => { const el = event.currentTarget; setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40) }}>{logs.length ? logs.join('\n') : (xianxia ? '玉簡未啟，靈息未至。' : '等待執行...')}<span ref={logEnd} /></pre></section></section>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <article className={`uat-stat is-${tone}`}><span>{label}</span><strong>{value}</strong></article>
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunStatus, TcGroup, UatConfig, UatThemeMode } from './types'
import { NetworkPanel, type UatStatsPayload } from './NetworkPanel'
import { BackendTcEditor, type BackendTc, type Step } from './BackendTcEditor'
import { MultiTcRecorder, type RecordedScript } from './MultiTcRecorder'
import { RecordedScriptLibrary } from './RecordedScriptLibrary'
import { RecordedScriptBatch } from './RecordedScriptBatch'

const STORAGE_KEY = 'osm_uat_config'
function loadConfig(): UatConfig {
  const defaults: UatConfig = { larkUrl: '', filter: '', dashGameType: '', dashClientVersion: '' }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<UatConfig>
    return { ...defaults, ...stored }
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
  kind?: 'api' | 'image' | 'other'
  resourceType?: string
  failure?: string | null
}

interface RecNetSummary {
  total: number
  failed: number
  api: { count: number; avgMs: number | null; maxMs: number | null }
  image: { count: number; avgMs: number | null; maxMs: number | null }
  other: { count: number; avgMs: number | null; maxMs: number | null }
  slow: RecNetCall[]
}

interface RecConsoleLog {
  type: string
  text: string
  location?: string
  ts: number
}

interface RecWsFrame {
  direction: 'sent' | 'received' | 'open' | 'close'
  url: string
  payload: string
  ts: number
}

interface BackendUatAgent {
  agentId: string
  hostname: string
  ownerName: string
  capabilities: string[]
  busy: boolean
  lastSeenAt: number
  /** 'current' | 'needs_update' | 'needs_restart' | 'unknown'——伺服器比對原始碼指紋算出來的 */
  updateStatus?: string
}

export function BackendUatPanel({ themeMode }: { themeMode: UatThemeMode }) {
  const xianxia = themeMode === 'xianxia'
  const [config, setConfig] = useState(loadConfig)
  const [multiRecorderOpen, setMultiRecorderOpen] = useState(false)
  const [legacyMode, setLegacyMode] = useState(false)
  const [recordedScripts, setRecordedScripts] = useState<RecordedScript[]>([])
  const [selectedScriptIds, setSelectedScriptIds] = useState<string[]>([])
  const [batchBusy, setBatchBusy] = useState(false)
  const [initialScript, setInitialScript] = useState<RecordedScript>()
  const [libraryRevision, setLibraryRevision] = useState(0)
  const openScript = (script?: RecordedScript) => { setInitialScript(script); setMultiRecorderOpen(true) }
  const [status, setStatus] = useState<RunStatus>('idle')
  const statusRef = useRef<RunStatus>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [groups, setGroups] = useState<TcGroup[] | null>(null)
  const [total, setTotal] = useState(0)
  const [scanning, setScanning] = useState(false)
  // 後台測試帳密：依登入帳號各存一份在後端（不再放 repo 裡的 config 檔）。
  // 這裡永遠拿不到密碼本身，只知道「有沒有設過」；密碼欄留空送出＝沿用舊密碼。
  const [creds, setCreds] = useState<{ profile: string; username: string; hasPassword: boolean }[]>([])
  const [credDraft, setCredDraft] = useState<Record<string, { username: string; password: string }>>({})
  const [credMsg, setCredMsg] = useState<{ text: string; tone: 'ok' | 'error' | 'busy' } | null>(null)
  // 網路量測快照：由 SSE 的 stats event 推上來，跟執行日誌同一條連線不同事件名
  // ── 風險佇列（2026-08-30）──
  // 「哪裡需要人處理」比一堆統計圖表實用——它給的是待辦清單不是數字。
  // 三欄的資料來源刻意不同：失敗來自「這一輪的實際結果」、需人工來自「靜態分類」、
  // Flaky 來自「跨輪歷史」。混成同一個來源就會答錯——例如把這輪沒跑到的
  // 人工判讀 TC 當成「這輪需要處理」。
  const [riskFailed, setRiskFailed] = useState<Array<{ record_id: string; subtype: string; task: string; reasons: string }>>([])
  const [riskManual, setRiskManual] = useState<Array<{ recordId: string; sub: string; reason: string; task: string }>>([])
  const [riskFlaky, setRiskFlaky] = useState<Array<{ record_id: string; subtype: string; task: string; fails: number }>>([])
  // 本次耗時與跟上一輪比。**跟上一輪比而不是跟平均比**——「這次是不是變慢了」
  // 才是每天實際會問的；跟平均比會被一次異常值長期拉歪。
  const [runTiming, setRunTiming] = useState<{ durationMs: number; deltaMs: number | null } | null>(null)
  const [coverage, setCoverage] = useState<{ total: number; machine: number; manual: number; uncovered: number; machinePercent: number } | null>(null)
  // 模組庫預設收起：它是「加新模組」的管理動作，本次要跑什麼才是主角
  // 設計圖每欄固定顯示 5 筆，超出的收進「查看全部」。**三欄等高才掃得快**——
  // 全部攤開的話待人工那欄會拉到很長，另外兩欄空著，反而看不出比重。
  const RISK_PREVIEW = 5
  const [riskModal, setRiskModal] = useState<null | 'all' | 'failed' | 'manual' | 'flaky'>(null)
  const [netStats, setNetStats] = useState<UatStatsPayload | null>(null)
  const [statsAt, setStatsAt] = useState<number | null>(null)
  // 單筆 TC 這一層：掃描才拿得到，模組展開後才看得見。積木是掛在 TC 上的，
  // 沒有這層就沒有地方可以編（v4.27.0 之前整個畫面只有模組層級）
  const [tcs, setTcs] = useState<BackendTc[]>([])
  const [selectedTcKey, setSelectedTcKey] = useState<string | null>(null)
  // 工作台層級的錄製：不用先選 TC，停止之後才問積木要放哪一筆。
  // 錄製本身跟 TC 完全無關（後端也不再需要 recordId），先選 TC 只是舊 UI 的包袱。
  const [recSession, setRecSession] = useState<string | null>(null)
  const [recCount, setRecCount] = useState(0)
  const [recMsg, setRecMsg] = useState('')
  const [recToast, setRecToast] = useState<{ id: number; message: string } | null>(null)
  const [pendingSteps, setPendingSteps] = useState<Step[] | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  /** 選擇器是否展開。跟 pendingSteps 分開——收起彈框不等於丟掉錄到的積木 */
  const [pickerOpen, setPickerOpen] = useState(false)
  // 錄製期間打到的 API。錄製只錄得到 DOM 操作，但要決定「這一步該下什麼
  // pass/fail」時，最需要知道的是它打了哪些後端——很多成功／失敗根本不在 DOM，
  // 在 API 有沒有送出、回什麼碼。
  const [recNet, setRecNet] = useState<RecNetCall[]>([])
  const [recNetSummary, setRecNetSummary] = useState<RecNetSummary | null>(null)
  const [recConsole, setRecConsole] = useState<RecConsoleLog[]>([])
  const [recWsFrames, setRecWsFrames] = useState<RecWsFrame[]>([])
  useEffect(() => {
    if (!recToast) return
    const timer = window.setTimeout(() => setRecToast(current => current?.id === recToast.id ? null : current), 7000)
    return () => window.clearTimeout(timer)
  }, [recToast])
  // 子類型篩選使用彈框複選，選項直接來自 TC 清單，避免自由輸入打錯。
  const [subtypeModal, setSubtypeModal] = useState(false)
  const [subtypeQuery, setSubtypeQuery] = useState('')
  // 錄到的是 Lark 上還沒有的新流程時，積木要有地方放。硬塞給既有 TC 會把那筆
  // 原本該驗的東西蓋掉，所以另存成自訂 TC——它帶一個 Lark 編號，之後以編號
  // 精確找到候選列再把積木搬過去。任務文案改寫不會影響歸戶。
  const [newTcTitle, setNewTcTitle] = useState('')
  const [newTcNumber, setNewTcNumber] = useState('')
  const [savingNewTc, setSavingNewTc] = useState(false)
  const [customTcs, setCustomTcs] = useState<{ id: string; title: string; linkNumber: string; steps: unknown[] }[]>([])
  const loadCustomTcs = useCallback(async () => {
    try {
      const r = await fetch('/api/osm-uat/custom-tcs')
      const d = await r.json() as { ok: boolean; customTcs?: typeof customTcs }
      if (d.ok) setCustomTcs(d.customTcs ?? [])
    } catch { /* 載不到就當作沒有，不擋住主要流程 */ }
  }, [])
  useEffect(() => { void loadCustomTcs() }, [loadCustomTcs])
  /** 正在歸戶的那筆自訂 TC（展開候選清單用） */
  const [adoptFor, setAdoptFor] = useState<string | null>(null)
  const [adoptCands, setAdoptCands] = useState<{ recordId: string; storageKey: string; tableId: string; number: string; text: string; sub: string; existingStepCount: number }[]>([])
  const [adoptReason, setAdoptReason] = useState('')
  const [adoptBusy, setAdoptBusy] = useState(false)
  /** 補填 Lark 編號用的暫存（key = 自訂 TC id） */
  const [numberDraft, setNumberDraft] = useState<Record<string, string>>({})
  const [selectedAgentId, setSelectedAgentId] = useState('')

  const openAdopt = useCallback(async (item: { id: string; title: string; linkNumber: string }) => {
    setAdoptFor(item.id); setAdoptCands([]); setAdoptReason('')
    try {
      const query = new URLSearchParams({ larkUrl: config.larkUrl, number: item.linkNumber })
      const r = await fetch(`/api/osm-uat/custom-tcs/${item.id}/adopt-candidates?${query}`)
      const d = await r.json() as { ok: boolean; candidates?: typeof adoptCands; reason?: string }
      setAdoptCands(d.candidates ?? [])
      setAdoptReason(d.reason ?? (d.candidates?.length ? '' : `編號 ${item.linkNumber || '（未填）'} 沒有命中任何 Lark TC`))
    } catch { setAdoptReason('讀取候選失敗') }
  }, [config.larkUrl])

  /** 補填／修改 Lark 編號。用同一支 PUT（帶 id 就是更新），不另開端點 */
  const saveNumber = useCallback(async (item: { id: string; title: string; steps: unknown[] }, number: string) => {
    setAdoptBusy(true)
    try {
      await fetch('/api/osm-uat/custom-tcs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, title: item.title, linkNumber: number.trim(), steps: item.steps }),
      })
      await loadCustomTcs()
    } finally { setAdoptBusy(false) }
  }, [loadCustomTcs])

  const doAdopt = useCallback(async (customId: string, candidate: typeof adoptCands[number]) => {
    const { recordId, storageKey, tableId, text, existingStepCount } = candidate
    // ⚠️ 預設是「接在既有積木後面」不是覆蓋——既有積木是別人花時間拆的。
    //    只有使用者在這裡明確二次確認過才送 replace（後端也只認這兩種）。
    let mode: 'append' | 'replace' = 'append'
    if (existingStepCount > 0) {
      mode = window.confirm(
        `這筆 Lark TC 已經有 ${existingStepCount} 顆積木。

` +
        `按「確定」＝改成只用自訂 TC 的積木（原本那 ${existingStepCount} 顆會被取代）
` +
        `按「取消」＝接在後面，兩邊都留著`,
      ) ? 'replace' : 'append'
    }
    setAdoptBusy(true)
    try {
      const r = await fetch(`/api/osm-uat/custom-tcs/${customId}/adopt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId, tableId, larkText: text, mode }),
      })
      const d = await r.json() as { ok: boolean; stepCount?: number; message?: string }
      if (!d.ok) { setAdoptReason(d.message ?? '歸戶失敗'); return }
      setAdoptFor(null)
      await loadCustomTcs()
      setTcs(prev => prev.map(t => t.storageKey === storageKey ? { ...t, stepCount: d.stepCount ?? t.stepCount } : t))
      setRecMsg(`已把 ${d.stepCount ?? '?'} 顆積木歸戶到 ${candidate.number}／${recordId}（${mode === 'replace' ? '取代原有' : '接在後面'}）`)
    } finally { setAdoptBusy(false) }
  }, [loadCustomTcs])

  const runCustomTrial = useCallback(async (item: { id: string; title: string; steps: unknown[] }) => {
    if (status === 'running') { setRecMsg('目前已有 UAT 在執行，請等它結束再試跑'); return }
    setRecMsg(`試跑中：${item.title}。不需要先歸戶，這輪也不會回寫 Lark。`)
    try {
      const response = await fetch('/api/osm-uat/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId || undefined,
          dashGameType: config.dashGameType || undefined,
          dashClientVersion: config.dashClientVersion || undefined,
          dryRun: true,
          customTrial: { id: item.id, title: item.title, steps: item.steps },
        }),
      })
      const data = await response.json() as { ok: boolean; error?: string; message?: string }
      if (!data.ok) { setRecMsg(data.error ?? data.message ?? '試跑啟動失敗'); return }
      setStatus('running')
    } catch {
      setRecMsg('試跑啟動失敗')
    }
  }, [config.dashGameType, config.dashClientVersion, selectedAgentId, status])

  const deleteCustomTc = useCallback(async (item: { id: string; title: string; steps: unknown[] }) => {
    if (!window.confirm(`確定要刪掉自訂 TC「${item.title}」嗎？裡面有 ${item.steps.length} 顆積木，刪掉要重錄。`)) return
    await fetch(`/api/osm-uat/custom-tcs/${item.id}`, { method: 'DELETE' })
    if (adoptFor === item.id) setAdoptFor(null)
    await loadCustomTcs()
  }, [adoptFor, loadCustomTcs])
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
  const [runMode, setRunMode] = useState<{ mode: 'agent' | 'server'; agentHostname?: string } | null>(null)
  const loadAgents = useCallback(async () => {
    try {
      const response = await fetch('/api/osm-uat/agents')
      const data = await response.json() as { ok: boolean; agents?: BackendUatAgent[]; outdated?: number }
      if (!data.ok) return null
      const online = data.agents ?? []
      const outdated = data.outdated ?? 0
      setAgents(online)
      setOutdatedAgents(outdated)
      // agentId 內含 PID，Agent 每次重啟都會換 ID。保留舊選擇會讓錄製送出一個
      // 已離線的 ID，即使同一台機器已重新連線，後端仍只能回 409。
      setSelectedAgentId(current => current && !online.some(agent => agent.agentId === current) ? '' : current)
      return { online, outdated }
    } catch {
      // 清單抓不到與「確定沒有 Agent」是兩件事；開始錄製時要分開提示。
      return null
    }
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
  // A completed run closes its SSE stream. Multi-TC starts reconnect above; polling also
  // reconciles missed completion notifications without touching the unsaved script.
  useEffect(() => {
    if (status !== 'running') return
    let cancelled = false
    const refresh = async () => {
      try {
        const response = await fetch('/api/osm-uat/status')
        if (!response.ok) return
        const snapshot = await response.json() as { status?: RunStatus }
        if (!cancelled && snapshot.status && ['idle', 'running', 'done', 'error'].includes(snapshot.status)) {
          statusRef.current = snapshot.status; setStatus(snapshot.status)
        }
      } catch { /* preserve current state until a confirmed response */ }
    }
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [status])
  // ⚠️ `block: 'nearest'` 不能省。預設值會連**整頁**一起捲到這個元素——
  //    日誌以前在頁面最底下，捲過去剛好就是你要看的位置，所以看不出問題；
  //    v4.79.2 把它搬到第一屏之後，每來一行日誌就會把整頁往下拉 760px，
  //    等於把使用者從剛搬上來的日誌旁邊拖走。
  //    'nearest' 只捲最近的可捲祖先（也就是日誌自己的 <pre>），不動視窗。
  useEffect(() => {
    if (autoScroll && status === 'running') logEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [autoScroll, logs, status])

  const update = (patch: Partial<UatConfig>) => setConfig(value => {
    const next = { ...value, ...patch }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return next
  })

  const selectedTc = tcs.find(tc => tc.storageKey === selectedTcKey) ?? null

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
        const counts = new Map(listed.tcs.map(t => [t.storageKey, t.stepCount]))
        setTcs(prev => prev.map(t => ({ ...t, stepCount: counts.get(t.storageKey) ?? t.stepCount })))
      }
    } catch { setRecMsg('匯入失敗：檔案不是合法的 JSON') }
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
        const data = await response.json() as {
          ok: boolean
          done?: boolean
          error?: string | null
          steps?: Step[]
          netCalls?: RecNetCall[]
          netSummary?: RecNetSummary
          consoleLogs?: RecConsoleLog[]
          wsFrames?: RecWsFrame[]
        }
        if (!data.ok || stopped) return
        setRecCount(data.steps?.length ?? 0)
        setRecNet(data.netCalls ?? [])
        setRecNetSummary(data.netSummary ?? null)
        setRecConsole(data.consoleLogs ?? [])
        setRecWsFrames(data.wsFrames ?? [])
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
        body: JSON.stringify({ title, linkNumber: newTcNumber.trim(), steps: pendingSteps }),
      })
      const data = await response.json() as { ok: boolean; message?: string }
      if (!data.ok) { setRecMsg(data.message ?? '存成自訂 TC 失敗'); return }
      setPendingSteps(null); setPickerOpen(false)
      setNewTcTitle(''); setNewTcNumber('')
      setRecMsg(newTcNumber.trim()
        ? `已存成自訂 TC「${title}」，可用 Lark 編號 ${newTcNumber.trim()} 精確找歸戶對象`
        : `已存成自訂 TC「${title}」（沒填 Lark 編號，之後想歸戶再補）`)
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
        const liveKeys = new Set(live.map(t => t.storageKey))
        const snapshotOnly = prev.filter(t => t.source !== 'live' && !liveKeys.has(t.storageKey))
        return [...live, ...snapshotOnly]
      })
      setTcScanned(true)
    } finally { setScanning(false) }
  }

  const run = async () => {
    if (!config.larkUrl.trim()) return window.alert('請先填入 Lark TC 路徑')
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

  // 覆蓋率與 flaky 跟「有沒有在跑」無關，掛載時抓一次就好
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [cov, flaky] = await Promise.all([
          fetch('/api/osm-uat/coverage').then(r => r.json()),
          fetch('/api/osm-uat/history/flaky').then(r => r.json()),
        ])
        if (cancelled) return
        if (cov.ok) { setCoverage(cov); setRiskManual(cov.manualList ?? []) }
        if (flaky.ok) setRiskFlaky(flaky.flaky ?? [])
      } catch { /* 風險佇列拿不到不該讓整頁壞掉 */ }
    })()
    return () => { cancelled = true }
  }, [])

  // 跑完才有「這一輪失敗了哪些」。**用歷史紀錄而不是解析日誌**——日誌只有計數，
  // 而且正則比對很脆；歷史紀錄本來就逐筆存了失敗原因。
  useEffect(() => {
    if (status !== 'done') return
    let cancelled = false
    void (async () => {
      try {
        // 拿兩筆才算得出「較上次」
        const runs = await fetch('/api/osm-uat/history?limit=2').then(r => r.json())
        const runId = runs?.runs?.[0]?.id
        if (!runId || cancelled) return
        const cur = runs.runs[0], prev = runs.runs[1]
        setRunTiming({
          durationMs: Number(cur.duration_ms) || 0,
          deltaMs: prev ? (Number(cur.duration_ms) || 0) - (Number(prev.duration_ms) || 0) : null,
        })
        const detail = await fetch(`/api/osm-uat/history/${runId}`).then(r => r.json())
        if (cancelled || !detail.ok) return
        setRiskFailed((detail.results ?? []).filter((r: { outcome: string }) => r.outcome === 'fail'))
        // 跑完順便更新 flaky——這一輪的結果會改變判定
        const flaky = await fetch('/api/osm-uat/history/flaky').then(r => r.json())
        if (!cancelled && flaky.ok) setRiskFlaky(flaky.flaky ?? [])
      } catch { /* 同上 */ }
    })()
    return () => { cancelled = true }
  }, [status])

  // 三欄形狀不同（失敗來自執行歷史、需人工來自靜態分類、flaky 來自跨輪統計），
  // 先正規化成同一個形狀，清單與彈框才不用各寫一份渲染
  const riskItems = {
    failed: riskFailed.map(r => ({ id: r.record_id, group: r.subtype, text: r.task, why: r.reasons })),
    manual: riskManual.map(r => ({ id: r.recordId, group: r.sub, text: r.task, why: r.reason })),
    flaky: riskFlaky.map(r => ({ id: r.record_id, group: r.subtype, text: r.task, why: `最近幾輪失敗 ${r.fails} 次` })),
  }
  const riskTotal = riskItems.failed.length + riskItems.manual.length + riskItems.flaky.length
  const RISK_COLS = [
    { key: 'failed' as const, label: '失敗的測試', scope: '這一輪跑出來的', empty: status === 'done' ? '這一輪沒有失敗' : '跑完才知道' },
    { key: 'manual' as const, label: '需人工確認', scope: '機器判不了，跟這輪跑不跑無關', empty: '沒有' },
    { key: 'flaky' as const, label: 'Flaky 候選', scope: '最近幾輪裡有過有敗', empty: '歷史還不夠，或目前沒有' },
  ]

  const summary = logs.reduce((result, line) => {
    const match = line.match(/通過:\s*(\d+).*需人工:\s*(\d+).*跳過:\s*(\d+).*失敗:\s*(\d+)/)
    return match ? { pass: +match[1], manual: +match[2], skip: +match[3], fail: +match[4] } : result
  }, { pass: 0, manual: 0, skip: 0, fail: 0 })
  const statusLabel = status === 'idle' ? (xianxia ? '玉簡未啟' : '待機') : status === 'running' ? (xianxia ? '推演中' : '執行中') : status === 'done' ? (xianxia ? '推演完成' : '完成') : (xianxia ? '陣眼失守' : '錯誤')

  const targetAgent = selectedAgentId
    ? agents.find(agent => agent.agentId === selectedAgentId)?.hostname ?? selectedAgentId
    : agents.some(agent => !agent.busy)
      ? `自動挑一台（${agents.filter(agent => !agent.busy).length} 台可用）`
      : null
  const startSteps = [
    { label: xianxia ? '載入玉簡' : '設定 Lark TC', done: !!config.larkUrl.trim() },
    { label: xianxia ? '選在哪具傀儡上跑' : '選在哪台機器跑', done: !!targetAgent },
    { label: legacyMode ? '執行舊版 TC' : '選擇或錄製腳本', done: false },
  ]
  const blockedReason = !config.larkUrl
    ? 'Lark TC 路徑還沒填（在右邊「執行設定」）'
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
            : <span className="uat-launch-ready">{legacyMode ? '可執行舊版 TC 批次測試' : '選擇已儲存腳本，或新增腳本開始錄製'}</span>}
        </div>
        <div className="uat-backend-launch-cta">
          <div className="uat-backend-launch-meta">
            {groups ? <>已讀取 <b>{total}</b> 筆 TC</> : <>尚未讀取 Lark TC</>}
            {targetAgent && <> · 跑在 <b>{targetAgent}</b></>}
          </div>
          {status === 'running' && !batchBusy
            ? <button type="button" className="uat-btn is-danger is-wide" onClick={() => fetch('/api/osm-uat/stop', { method: 'POST' })}>{xianxia ? '收陣' : '停止執行'}</button>
            : <button type="button" className="uat-btn is-primary is-wide" disabled={batchBusy || !config.larkUrl} onClick={legacyMode ? run : () => openScript()}>{legacyMode ? '執行舊版 TC' : '錄製腳本'}</button>}
        </div>
      </div>

      {/* 下排（網路量測＋執行日誌）刻意放在三欄**之前**。
          原本在最下面，實測日誌頂端在 y=1580、要捲 580px 才看得到——
          而那正是跑測試時最需要盯的東西。
          grid 的視覺順序跟著 DOM 走，所以搬 DOM 就夠，不用另外設 order。 */}
      <section className="uat-backend-bottom">
<NetworkPanel stats={netStats} themeMode={themeMode} updatedAt={statsAt} />
<section className="uat-panel uat-backend-log"><div className="uat-log-toolbar"><div className="uat-section-title"><span>{xianxia ? 'ARRAY RECORD' : 'PROCESS OUTPUT'}</span><h3>{xianxia ? '陣法行跡錄' : '即時執行日誌'}</h3></div><label className="uat-check"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />{xianxia ? '追隨靈流' : '自動捲動'}</label><button type="button" className="uat-btn is-quiet" onClick={() => setLogs([])}>{xianxia ? '拂去殘痕' : '清除'}</button></div><pre onScroll={event => { const el = event.currentTarget; setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40) }}>{logs.length ? logs.join('\n') : (xianxia ? '玉簡未啟，靈息未至。' : '等待執行...')}<span ref={logEnd} /></pre></section>
      </section>

      <aside className="uat-backend-plan">
        <button type="button" className="uat-btn is-quiet" disabled={batchBusy || !!recSession || status === 'running'} onClick={() => setLegacyMode(value => !value)}>{legacyMode ? '返回錄製腳本' : '舊版 TC 模式'}</button>
        {!legacyMode ? <RecordedScriptLibrary revision={libraryRevision} disabled={batchBusy || !!recSession || status === 'running'} onOpen={openScript} selectedIds={selectedScriptIds} onSelection={setSelectedScriptIds} onScripts={setRecordedScripts} /> : <>
        <p>舊版模式：逐筆 TC、內建驗證器及積木檔案。此處的批次執行不會執行錄製腳本。</p>
        <div className="uat-backend-flow-head">
          <div className="uat-section-title"><span>{xianxia ? 'TC INDEX' : 'TC LIBRARY'}</span><h3>{xianxia ? '玉簡清單' : 'TC 清單'} <small>{tcs.length} 筆</small></h3><p>直接從 Lark 表格讀取；點選 TC 可查看與編輯積木。</p></div>
        </div>
        <div className="uat-tc-toolbar">
          <div className="uat-tc-record-actions" aria-label="錄製工具">
          <button type="button" className="uat-btn" disabled={!!recSession} onClick={() => openScript()}>錄製腳本</button>
          {recSession
            && <button type="button" className="uat-btn is-danger" onClick={() => void finishWorkbenchRecord(recSession)}>停止錄製（{recCount} 顆）</button>}
          </div>
          <div className="uat-tc-file-actions" aria-label="積木檔案管理">
            <span>積木檔案</span>
            <button type="button" aria-label="匯入積木" onClick={() => importInput.current?.click()}>匯入</button>
            <button type="button" aria-label="匯出積木" onClick={() => { window.location.href = '/api/osm-uat/tc-steps/export' }}>匯出</button>
          </div>
          <input ref={importInput} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={event => void handleImport(event)} />
        </div>
        <div className="uat-backend-tc-list uat-backend-all-tcs">
          {tcs.map(tc => (
            <button type="button" key={tc.storageKey}
              className={`uat-backend-tc${selectedTcKey === tc.storageKey ? ' is-selected' : ''}`}
              onClick={() => setSelectedTcKey(tc.storageKey)}>
              <span title={tc.text}>
                {tc.source !== 'live' && tcScanned && <b className="uat-backend-tc-stale" title="這次掃描沒有在 Lark 上找到，可能已被移除">快照</b>}
                {tc.number && <b>{tc.number} </b>}{tc.text || tc.recordId}
              </span>
              <em className={tc.stepCount ? 'has-steps' : ''}>{tc.stepCount ? `${tc.stepCount} 積木` : '內建'}</em>
            </button>
          ))}
          {!tcs.length && <div className="uat-backend-flow-empty"><strong>尚未載入 TC</strong><span>填入 Lark TC 路徑後按「掃描 Lark TC」。</span></div>}
        </div>
        <footer className="uat-backend-flow-foot"><span>{!tcScanned && tcs.length > 0 && `目前是 ${tcSnapshotAt ? tcSnapshotAt.slice(0, 10) + ' 的' : ''}離線快照；掃描後會同步 Lark 新增的 TC。`}</span><b>{groups ? `已讀取 ${total} TC` : '尚未讀取 Lark'}</b></footer>

        {customTcs.length > 0 && (
          <section className="uat-backend-customtc">
            <div className="uat-backend-customtc-head">
              <strong>自訂 TC <em>{customTcs.length}</em></strong>
              <small>可以先獨立試跑，確認後再用 Lark 編號選擇歸戶對象。</small>
            </div>
            {customTcs.map(item => {
              const draft = numberDraft[item.id] ?? item.linkNumber
              return (
                <article key={item.id} className="uat-backend-customtc-row">
                  <div className="uat-backend-customtc-main">
                    <strong>{item.title}</strong>
                    <span>{item.steps.length} 顆積木</span>
                  </div>
                  {/* 動作列排在輸入框「前面」是刻意的：這欄是窄的側欄，
                      標題＋輸入框＋三顆按鈕三欄並排會把輸入框壓到看不見佔位文字
                      （實測只剩「歸戶關」還溢出）。改成第一列放標題與動作、
                      輸入框獨佔第二列。 */}
                  <div className="uat-backend-customtc-actions">
                    <button type="button" className="uat-btn is-primary" disabled={adoptBusy || status === 'running'}
                      onClick={() => void runCustomTrial(item)}>試跑</button>
                    {draft !== item.linkNumber && (
                      <button type="button" className="uat-btn is-quiet" disabled={adoptBusy}
                        onClick={() => void saveNumber(item, draft)}>存編號</button>
                    )}
                    <button type="button" className="uat-btn" disabled={adoptBusy}
                      onClick={() => void openAdopt({ ...item, linkNumber: draft })}>找歸戶對象</button>
                    <button type="button" className="uat-btn is-quiet" disabled={adoptBusy}
                      onClick={() => void deleteCustomTc(item)}>刪除</button>
                  </div>
                  <input className="uat-field uat-backend-customtc-kw" value={draft}
                    placeholder="Lark 編號，例如 T-A-002"
                    onChange={event => setNumberDraft(prev => ({ ...prev, [item.id]: event.target.value }))} />
                  {adoptFor === item.id && (
                    <div className="uat-backend-customtc-cands">
                      {adoptReason && <p>{adoptReason}</p>}
                      {/* 編號在同一張表可能重複，所以命中多筆仍全部列出讓人挑。 */}
                      {adoptCands.map(c => (
                        <div key={c.storageKey} className="uat-backend-customtc-cand">
                          <div>
                            <span><b>{c.number}</b> {c.text || c.recordId}</span>
                            <small>{c.sub}{c.existingStepCount > 0 && ` · 已有 ${c.existingStepCount} 顆積木`}</small>
                          </div>
                          <button type="button" className="uat-btn" disabled={adoptBusy}
                            onClick={() => void doAdopt(item.id, c)}>歸戶</button>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              )
            })}
          </section>
        )}

        </>}
      </aside>

      <main className="uat-backend-center">
        {legacyMode ? <>

        {/* 本次總覽。除了四種結果，補上覆蓋率與這一輪耗時——
            「這次跑了什麼」跟「整體驗到多少」是兩個不同的問題，並排才看得懂。 */}
        <div className="uat-stat-grid">
          <Stat label={xianxia ? '試煉通過' : '通過'} value={summary.pass} tone="pass" />
          <Stat label={xianxia ? '待真人覆核' : '需人工'} value={summary.manual} tone="manual" />
          <Stat label={xianxia ? '略過' : '跳過'} value={summary.skip} tone="skip" />
          <Stat label={xianxia ? '陣眼失守' : '失敗'} value={summary.fail} tone="fail" />
          {/* 耗時放進同一排。沒有它就答不出「這次是不是變慢了」——
              而變慢往往是退化最早出現的訊號，比失敗更早。 */}
          <article className="uat-stat is-time">
            <span>{xianxia ? '推演耗時' : '本次耗時'}</span>
            <strong>{runTiming ? formatDuration(runTiming.durationMs) : '—'}</strong>
            {runTiming?.deltaMs != null && runTiming.deltaMs !== 0 && (
              <em className={runTiming.deltaMs > 0 ? 'is-slower' : 'is-faster'}>
                {runTiming.deltaMs > 0 ? '慢' : '快'} {formatDuration(Math.abs(runTiming.deltaMs))}
              </em>
            )}
          </article>
        </div>

        {/* ── 風險佇列 ──
            三欄的資料來源刻意不同，也各自標明時間範圍：
              失敗＝這一輪的實際結果／需人工＝靜態分類（跟這輪跑不跑無關）／Flaky＝跨輪歷史
            不標的話使用者會以為三個都是「這次跑出來的」。 */}
        <section className="uat-panel uat-risk-queue">
          <div className="uat-risk-head">
            <div className="uat-section-title">
              <span>RISK QUEUE</span>
              <h3>{xianxia ? '待處危局' : '風險佇列'} <small>{riskTotal}</small></h3>
              <p>這裡列的是「需要人處理」的，不是統計數字。</p>
            </div>
            {riskTotal > 0 && (
              <button type="button" className="uat-risk-all" onClick={() => setRiskModal('all')}>
                查看全部 <i>›</i>
              </button>
            )}
          </div>
          <div className="uat-risk-cols">
            {RISK_COLS.map(col => {
              const items = riskItems[col.key]
              return (
                <div className={`uat-risk-col is-${col.key}`} key={col.key}>
                  <h4><span className="uat-risk-mark" aria-hidden="true" />{col.label} <b>{items.length}</b></h4>
                  <small>{col.scope}</small>
                  {items.length === 0
                    ? <p className="uat-risk-empty">{col.empty}</p>
                    : <ul>{items.slice(0, RISK_PREVIEW).map(item => (
                        // 一列一筆、不換行——設計圖那欄是掃描用的，原因收進 title 與彈框。
                        // 全部攤開的話三欄高度會差很多，掃起來反而慢
                        <li key={item.id} title={`${item.text}\n${item.why}`}>
                          <em>{item.group}</em><span>{item.text}</span>
                        </li>))}</ul>}
                  {/* 超過就壓縮成一行連結，不用「…另有 N 筆」——那句話沒有出口，
                      使用者知道還有卻不知道去哪看 */}
                  {items.length > RISK_PREVIEW && (
                    <button type="button" className="uat-risk-more-btn" onClick={() => setRiskModal(col.key)}>
                      查看全部 {items.length} 筆 <i>›</i>
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {coverage && (
            <div className="uat-coverage-row">
              <span className="uat-coverage-main"><b>{coverage.machinePercent}%</b> 機器驗過</span>
              <span className="uat-coverage-part is-machine">機器驗過 <b>{coverage.machine}</b></span>
              <span className="uat-coverage-part is-manual">已分類、待人工 <b>{coverage.manual}</b></span>
              <span className="uat-coverage-part is-none">未涵蓋 <b>{coverage.uncovered}</b></span>
              <span className="uat-coverage-note">共 {coverage.total} 筆．待人工那些機器沒有跑任何斷言</span>
            </div>
          )}
        </section>
        </> : <RecordedScriptBatch scripts={recordedScripts} selectedIds={selectedScriptIds} onOrder={setSelectedScriptIds} agentId={selectedAgentId} running={status === 'running'} busy={batchBusy} onBusy={setBatchBusy} onRun={() => { statusRef.current = 'running'; setStatus('running'); connect() }} />}

      </main>

      <aside className="uat-backend-settings">
          <div className="uat-pane-heading"><div><span>{xianxia ? 'ARRAY SETTINGS' : 'RUN SETTINGS'}</span><h3>{xianxia ? '陣眼設定' : '執行設定'}</h3><small>套用至本次 TC 執行</small></div></div>
          <div className="uat-backend-settings-form">
            <div className="uat-backend-cred-box">
              <b>執行位置</b>
              <small>Playwright 實際跑在哪台機器。派工給 Local Agent 時，伺服器只負責建 session、轉日誌。</small>
              <select className="uat-field" value={selectedAgentId} disabled={batchBusy || status === 'running'}
                onChange={event => setSelectedAgentId(event.target.value)}>
                <option value="">自動挑一台線上 Agent{agents.length ? `（目前 ${agents.filter(a => !a.busy).length} 台可用）` : '（目前沒有）'}</option>
                {agents.map(agent => (
                  <option value={agent.agentId} key={agent.agentId}>
                    {agent.hostname}{agent.busy ? '（忙碌中）' : ''}
                    {agent.updateStatus === 'needs_update' ? '　⚠ 程式碼落後'
                      : agent.updateStatus === 'needs_restart' ? '　⚠ 需重開 agent'
                      : agent.updateStatus === 'unknown' ? '　⚠ 版本未知' : ''}
                  </option>
                ))}
                <option value="server">伺服器端（fallback）</option>
              </select>
              {/* 選到落後的 agent 時說清楚，但**不擋**——落後不一定影響這次要跑的東西。
                  訊息刻意寫「可能吃不到」不是「會失敗」，避免使用者以為一定跑不動。 */}
              {(() => {
                const picked = agents.find(a => a.agentId === selectedAgentId)
                if (!picked || !picked.updateStatus || picked.updateStatus === 'current') return null
                const msg = picked.updateStatus === 'needs_restart'
                  ? '這台 agent 的檔案已是最新，但跑著的程式是更新前載入的——重開 agent 才會生效。可以照樣派工，只是可能吃不到新功能。'
                  : picked.updateStatus === 'unknown'
                    ? '這台 agent 沒有回報版本（多半是舊版）。建議到 Local Agent 頁更新一次並重開。可以照樣派工。'
                    : '這台 agent 的程式碼落後於伺服器，可能吃不到新功能。到 Local Agent 頁按「更新程式碼」即可。可以照樣派工。'
                return <p className="uat-hint" style={{ color: 'var(--cr-amber)' }}>{msg}</p>
              })()}
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
            {legacyMode && <><label>{xianxia ? '玉簡篩選' : 'Subtype 追加篩選'}
              <button type="button" className="uat-field uat-subtype-trigger" onClick={() => setSubtypeModal(true)}>
                {selectedSubtypes.length
                  ? `已選 ${selectedSubtypes.length} 個子類型`
                  : '全部 TC'}
                <em>選擇…</em>
              </button>
              <small>不選會執行表格內所有符合 UAT 後台條件的 TC；選擇後只跑指定子類型。</small>
            </label>
            {config.filter.trim() && (
              <div className="uat-filter-warn">
                <span>
                  目前只會跑子類型含「<b>{config.filter.trim()}</b>」的 TC。
                </span>
                <button type="button" className="uat-btn is-quiet" onClick={() => update({ filter: '' })}>清除篩選</button>
              </div>
            )}
            <div className="uat-backend-setting-pair"><label>Game Type<input className="uat-field" value={config.dashGameType} onChange={event => update({ dashGameType: event.target.value })} placeholder="BWJL" /></label><label>Client Version<input className="uat-field" value={config.dashClientVersion} onChange={event => update({ dashClientVersion: event.target.value })} placeholder="H5(1.5)" /></label></div>
            </>}
          </div>
          <div className="uat-backend-run-summary"><span><b>{groups ? total : '—'}</b> 個 Lark TC</span>{legacyMode && <span><b>{selectedSubtypes.length || '全部'}</b> 子類型範圍</span>}</div>
          {/* 執行／停止已移到第一屏的行動列（.uat-backend-launch）。這裡不再放第二組——
              兩顆做同一件事的按鈕會讓人不確定哪顆才是對的。 */}
          <span className={`uat-run-status is-${status}`}><i />{statusLabel}</span>
      </aside>



      {/* 錄製期間即時列出打到的 API。放在狀態列下面而不是彈框裡——
          使用者是「一邊操作一邊看」的，塞進彈框等於還要多開一次 */}
      {recSession && (recNetSummary || recNet.length > 0 || recConsole.length > 0 || recWsFrames.length > 0) && (
        <div className="uat-rec-net">
          <h4>錄製監控 <em>Network {recNetSummary?.total ?? recNet.length} · Console {recConsole.length} · WebSocket {recWsFrames.length}</em></h4>
          {recNetSummary && (
            <div className="uat-rec-net-summary">
              <span>API <b>{recNetSummary.api.count}</b>{recNetSummary.api.avgMs !== null && <i>avg {recNetSummary.api.avgMs}ms</i>}</span>
              <span>圖檔 <b>{recNetSummary.image.count}</b>{recNetSummary.image.avgMs !== null && <i>avg {recNetSummary.image.avgMs}ms</i>}</span>
              <span>其他 <b>{recNetSummary.other.count}</b>{recNetSummary.other.avgMs !== null && <i>avg {recNetSummary.other.avgMs}ms</i>}</span>
              <span className={recNetSummary.failed ? 'is-bad' : ''}>失敗 <b>{recNetSummary.failed}</b></span>
              <span className={recNetSummary.slow.length ? 'is-bad' : ''}>慢速 <b>{recNetSummary.slow.length}</b></span>
            </div>
          )}
          {!!recNet.filter(c => (c.kind ?? 'api') === 'api').length && (
            <div className="uat-rec-net-list">
            {[...recNet].filter(c => (c.kind ?? 'api') === 'api').reverse().slice(0, 40).map((c, i) => (
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
          )}
          {!!recConsole.length && (
            <div className="uat-rec-console-list">
              {[...recConsole].reverse().slice(0, 30).map((row, i) => (
                <div className={`uat-rec-console-row is-${row.type}`} key={`${row.ts}-${i}`} title={row.location}>
                  <b>{row.type}</b>
                  <span>{row.text}</span>
                </div>
              ))}
            </div>
          )}
          {!!recWsFrames.length && (
            <div className="uat-rec-console-list">
              {[...recWsFrames].reverse().slice(0, 30).map((row, i) => (
                <div className="uat-rec-console-row" key={`${row.ts}-${i}`} title={row.url}>
                  <b>WS {row.direction === 'sent' ? '→' : row.direction === 'received' ? '←' : row.direction.toUpperCase()}</b>
                  <span>{row.payload || row.url}</span>
                </div>
              ))}
            </div>
          )}
          <small>API 列可直接變成斷言積木；Network 摘要用來看網速、慢速與失敗請求；Console 會收 JS error/warn/log；WebSocket 顯示雙向封包。</small>
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

      {recToast && (
        <div className="uat-record-toast" role="alert" aria-live="assertive">
          <div><strong>無法開始錄製</strong><span>{recToast.message}</span></div>
          <button type="button" aria-label="關閉提示" onClick={() => setRecToast(null)}>×</button>
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
                    ? `已選 ${selectedSubtypes.length} 個——只會執行這些子類型。`
                    : '目前沒有選任何子類型，會執行表格內全部符合條件的 TC。'}
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
      {multiRecorderOpen && <MultiTcRecorder initialScript={initialScript} open={multiRecorderOpen} onClose={() => { setMultiRecorderOpen(false); setLibraryRevision(n => n + 1) }} tcs={tcs}
        larkUrl={config.larkUrl} agentId={selectedAgentId} running={status === 'running'} themeMode={themeMode}
        onRun={() => { statusRef.current = 'running'; setStatus('running'); connect() }} />}
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
                <input className="uat-field" value={newTcNumber} placeholder="Lark 編號，例如 T-A-002（選填）"
                  onChange={event => setNewTcNumber(event.target.value)} />
                <button type="button" className="uat-btn" disabled={savingNewTc || !newTcTitle.trim()}
                  onClick={() => void saveAsCustomTc()}>另存成新 TC</button>
              </div>
              <small>
                自訂 TC 會先存在工具裡，儲存後即可獨立試跑；確認腳本沒問題，再填入 Lark「編號」精確找歸戶候選。
              </small>
            </div>

            <div className="uat-tc-picker-or">或接到既有的 Lark TC</div>
            <input className="uat-field" value={pickerQuery} placeholder="搜尋 TC 描述或子類型…"
              onChange={event => setPickerQuery(event.target.value)} />
            <div className="uat-tc-picker-list">
              {tcs
                .filter(tc => {
                  const q = pickerQuery.trim().toLowerCase()
                  return !q || [tc.number, tc.text, tc.sub, tc.recordId].some(v => v.toLowerCase().includes(q))
                })
                .slice(0, 80)
                .map(tc => (
                  <button type="button" className="uat-backend-tc" key={tc.storageKey}
                    onClick={() => { setSelectedTcKey(tc.storageKey) }}>
                    <span title={tc.text}>[{tc.number || tc.sub || '未分類'}] {tc.text || tc.recordId}</span>
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
        {/* 「查看全部」的彈框。**一定要 portal**：這個 studio 版面的祖先有
            backdrop-filter，position: fixed 會被困在容器裡畫不出來——積木編輯器
            與 TC 選擇器都踩過同一個坑，這是第三次，不要再用一般絕對定位試。 */}
        {riskModal && createPortal((
          <div className="uat-studio uat-tc-modal" role="dialog" aria-modal="true"
            onMouseDown={event => { if (event.target === event.currentTarget) setRiskModal(null) }}>
            <div className="uat-tc-picker uat-risk-modal">
              <div className="uat-tc-picker-head">
                <div>
                  <span className="uat-net-kicker">RISK QUEUE</span>
                  <h3>{riskModal === 'all' ? '全部待處理項目' : RISK_COLS.find(c => c.key === riskModal)?.label}</h3>
                  <small>
                    {riskModal === 'all'
                      ? '三類合在一起，每一筆都標了它是哪一類、以及為什麼。'
                      : RISK_COLS.find(c => c.key === riskModal)?.scope}
                  </small>
                </div>
                <button type="button" className="uat-btn is-quiet" onClick={() => setRiskModal(null)}>關閉</button>
              </div>
              <div className="uat-risk-modal-list">
                {(riskModal === 'all'
                  ? RISK_COLS.flatMap(c => riskItems[c.key].map(i => ({ ...i, kind: c.key, kindLabel: c.label })))
                  : riskItems[riskModal].map(i => ({ ...i, kind: riskModal, kindLabel: '' }))
                ).map(item => (
                  <div className={`uat-risk-modal-row is-${item.kind}`} key={`${item.kind}-${item.id}`}>
                    <div className="uat-risk-modal-main">
                      {item.kindLabel && <b className="uat-risk-modal-kind">{item.kindLabel}</b>}
                      <em>{item.group}</em>
                      <span>{item.text}</span>
                    </div>
                    {/* 原因在這裡才完整顯示——這是彈框存在的理由，只是把清單變長沒有意義 */}
                    {item.why && <p className="uat-risk-modal-why">{item.why}</p>}
                  </div>
                ))}
                {(riskModal === 'all' ? riskTotal : riskItems[riskModal].length) === 0 && (
                  <div className="uat-backend-tc-more">目前沒有這一類的項目。</div>
                )}
              </div>
            </div>
          </div>
        ), document.body)}

      {selectedTc && (
        <BackendTcEditor
          tc={selectedTc}
          allTcs={tcs}
          themeMode={themeMode}
          pendingSteps={pendingSteps}
          onPendingConsumed={() => { setPendingSteps(null); setRecMsg('') }}
          onRecordScript={() => { setSelectedTcKey(null); openScript() }}
          onClose={() => setSelectedTcKey(null)}
          onSaved={(storageKey, stepCount) => setTcs(prev => prev.map(t => t.storageKey === storageKey ? { ...t, stepCount } : t))}
        />
      )}

    </div>
  )
}

/** 毫秒轉人看得懂的時間。**不用小數秒**——測試耗時的量級是分鐘，
 *  顯示到毫秒只會讓數字變長而且每次都不一樣，看不出趨勢。 */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const sec = total % 60
  return sec ? `${m}m ${sec}s` : `${m}m`
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <article className={`uat-stat is-${tone}`}><span>{label}</span><strong>{value}</strong></article>
}

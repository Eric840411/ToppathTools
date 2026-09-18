import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XianxiaIcon } from '../../components/XianxiaIcon'
import { BlockEditor } from './BlockEditor'
import { NetworkPanel, type UatStatsPayload } from './NetworkPanel'
import { SELECTOR_CHECK_LABEL } from '../../../shared/uat-selector-check'
import { compileExecutableSteps, countExecutableSteps, createStep, parseSteps, serializeSteps } from './step-model'
import { createPauseGate } from './pause-gate'
import type { AgentOption, AutoBaseline, AutoFilter, AutoPlatform, AutoRun, AutoScript, AutoStep, AutoTemplate, OcrRegion, UatThemeMode } from './types'

type StudioView = 'editor' | 'run' | 'assets' | 'history'

interface Props { platform: AutoPlatform; themeMode: UatThemeMode }

function currentActor() {
  const saved = localStorage.getItem('frontend_auto_user')
  if (saved) return saved
  localStorage.setItem('frontend_auto_user', 'local-user')
  return 'local-user'
}

function isLocalHost() {
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname.toLowerCase())
}

export function FrontendAutomationStudio({ platform, themeMode }: Props) {
  const xianxia = themeMode === 'xianxia'
  const copy = xianxia ? {
    cases: '玉簡卷宗', addScript: '新立試煉玉簡', editor: '陣圖編排', run: '啟陣控制', assets: '靈影素材', history: '試煉錄',
    record: '觀照錄術', stopRecord: '停止觀照', pauseRecord: '暫歇觀照', resumeRecord: '續行觀照', save: '封存玉簡', saving: '封存中', scriptName: '玉簡名號', unsaved: '尚未封存', synced: '已入藏經閣', newScript: '新玉簡',
  } : {
    cases: '腳本', addScript: '新增測試腳本', editor: '流程編輯', run: '執行控制', assets: '視覺資產', history: '執行紀錄',
    record: 'Playwright 錄製', stopRecord: '停止錄製', pauseRecord: '暫停錄製', resumeRecord: '繼續錄製', save: '儲存腳本', saving: '儲存中', scriptName: '腳本名稱', unsaved: '尚未儲存', synced: '已同步', newScript: '新腳本',
  }
  const actor = currentActor()
  const [scripts, setScripts] = useState<AutoScript[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [steps, setSteps] = useState<AutoStep[]>([])
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [isPublic, setIsPublic] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState<AutoFilter>('all')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<StudioView>('editor')
  const [baselines, setBaselines] = useState<AutoBaseline[]>([])
  const [templates, setTemplates] = useState<AutoTemplate[]>([])
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>([])
  const [runs, setRuns] = useState<AutoRun[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  /**
   * 自己的 agent 裡「有連線但缺 uat-record 能力」的數量。
   * ⚠️ 要跟「一台都沒有」分開講——多半是 agent 還跑著舊程式碼，
   * 只說「目前沒有」的話，使用者看著明明連上的機器完全無從判斷。
   */
  const [agentsOutdated, setAgentsOutdated] = useState(0)
  const [agentId, setAgentId] = useState('')
  const [recorderAvailable, setRecorderAvailable] = useState(isLocalHost())
  const [recordSessionId, setRecordSessionId] = useState<string | null>(null)
  const [recordLabel, setRecordLabel] = useState('')
  /**
   * 這一輪錄製暫停中。**跟錄製視窗裡的浮動面板共用同一個狀態**（來源都是 host），
   * 主畫面自己記一份的話會出現「面板顯示已暫停、主畫面顯示錄製中」。
   */
  const [recPaused, setRecPaused] = useState(false)
  /** 暫停指令送出去、還沒被 agent 確認。⚠️ 確認之前不能顯示成已完成，也不能重複送 */
  const [pausePending, setPausePending] = useState(false)
  /**
   * 等待狀態機。**時序邏輯全在 `pause-gate.ts`**，這裡只負責呼叫——
   * 那支有自己的行為測試（送出前起跑的逾時、遲到的回應不得清掉新的那一筆）。
   * ⚠️ 不要在這裡再寫一份判斷，兩份一定會漂。
   */
  const pauseGate = useRef(createPauseGate({
    timeoutMs: 8000,
    setPending: setPausePending,
    onTimeout: () => setNotice('暫停指令沒有得到確認，狀態未變更——請確認 Local Agent 仍在線並已更新程式碼。'),
  })).current
  const pollRecorder = useRef<ReturnType<typeof setInterval> | null>(null)
  const runStream = useRef<EventSource | null>(null)
  const activeRunId = useRef<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  // 網路量測快照：跟 log 走同一條 SSE，不同 event 名稱
  const [netStats, setNetStats] = useState<UatStatsPayload | null>(null)
  const [statsAt, setStatsAt] = useState<number | null>(null)
  /** 錄製時攔到的 console／pageerror。跟執行日誌分開——兩者來源與生命週期都不同 */
  const [recConsole, setRecConsole] = useState<{ type: string; text: string; location?: string; ts: number }[]>([])
  const [recConsoleDropped, setRecConsoleDropped] = useState(0)
  /** pinus 補丁打在哪。null 代表這頁沒有 pinus（後台站就會是這樣），不是攔截壞了 */
  const [pinusPatched, setPinusPatched] = useState<string | null>(null)
  /** 錄製時抓到的 API，用來一鍵變成 assert_api_called */
  const [recApiCalls, setRecApiCalls] = useState<{ method?: string; url: string; urlPattern?: string; status?: number | null }[]>([])
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState('')
  const [runConfig, setRunConfig] = useState({
    url: '', resolution: platform === 'h5' ? '500x877' : '1366x768', failureMode: 'continue', headed: false,
  })

  const loadScripts = useCallback(async (preferId?: string) => {
    const response = await fetch(`/api/frontend-auto/scripts?platform=${platform}`)
    if (!response.ok) return
    const data = await response.json() as { scripts?: AutoScript[] }
    const rows = data.scripts ?? []
    setScripts(rows)
    setSelectedId(current => preferId ?? (current || rows[0]?.id || ''))
  }, [platform])

  const loadRuns = useCallback(async () => {
    const response = await fetch(`/api/frontend-auto/runs?platform=${platform}&limit=50`)
    if (!response.ok) return
    const data = await response.json() as { runs?: AutoRun[] }
    setRuns(data.runs ?? [])
  }, [platform])

  const loadAssets = useCallback(async (scriptId = selectedId) => {
    const requests = [
      scriptId ? fetch(`/api/frontend-auto/baselines?scriptId=${encodeURIComponent(scriptId)}`) : Promise.resolve(null),
      fetch('/api/frontend-auto/templates'), fetch('/api/frontend-auto/ocr-regions'),
    ] as const
    const [baseResponse, templateResponse, ocrResponse] = await Promise.all(requests)
    if (baseResponse?.ok) setBaselines(((await baseResponse.json()) as { baselines?: AutoBaseline[] }).baselines ?? [])
    else setBaselines([])
    if (templateResponse.ok) setTemplates(((await templateResponse.json()) as { templates?: AutoTemplate[] }).templates ?? [])
    if (ocrResponse.ok) setOcrRegions(((await ocrResponse.json()) as { regions?: OcrRegion[] }).regions ?? [])
  }, [selectedId])

  useEffect(() => {
    // API 資料只在平台切換時載入；狀態更新發生於非同步回應，不會形成同步 effect 迴圈。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadScripts()
    void loadRuns()
  }, [loadScripts, loadRuns])
  useEffect(() => {
    fetch('/api/frontend-auto/record/available').then(response => response.json()).then((data: { available?: boolean; agents?: AgentOption[]; outdated?: number }) => {
      setRecorderAvailable(!!data.available)
      setAgents(data.agents ?? [])
      setAgentsOutdated(Number(data.outdated) || 0)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    const selected = scripts.find(script => script.id === selectedId)
    if (!selected) return
    // selectedId 是清單的單一真實來源，這裡建立該版本的可編輯草稿快照。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(selected.name)
    setSteps(parseSteps(selected.steps))
    setIsPublic(!!selected.is_public)
    setSelectedStepId(null)
    setDirty(false)
    void loadAssets(selected.id)
  }, [selectedId, scripts, loadAssets])
  useEffect(() => () => {
    if (pollRecorder.current) clearInterval(pollRecorder.current)
    pauseGate.cancel()
    runStream.current?.close()
  }, [pauseGate])

  const visibleScripts = useMemo(() => scripts.filter(script => {
    const matchFilter = filter === 'all' || filter === 'mine' && script.created_by === actor || filter === 'public' && !!script.is_public
    return matchFilter && script.name.toLowerCase().includes(search.toLowerCase())
  }), [actor, filter, scripts, search])
  const latestResult = useMemo(() => new Map(runs.map(run => [run.script_id, run.result])), [runs])

  const newScript = () => {
    if (dirty && !window.confirm('目前有尚未儲存的調整，仍要建立新腳本嗎？')) return
    setSelectedId('')
    setName(`新的 ${platform.toUpperCase()} 測試`)
    setSteps([createStep('goto')])
    setIsPublic(true)
    setSelectedStepId(null)
    setDirty(true)
    setView('editor')
  }

  const selectScript = (id: string) => {
    if (id === selectedId) return
    if (dirty && !window.confirm('目前有尚未儲存的調整，仍要切換腳本嗎？')) return
    setSelectedId(id)
  }

  const saveScript = async () => {
    if (!name.trim()) return setNotice(xianxia ? '請為玉簡題名' : '請輸入腳本名稱')
    setSaving(true)
    const payload = { name: name.trim(), platform, steps: serializeSteps(steps), createdBy: actor, isPublic }
    const response = await fetch(selectedId ? `/api/frontend-auto/scripts/${selectedId}` : '/api/frontend-auto/scripts', {
      method: selectedId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const data = await response.json().catch(() => ({})) as { script?: AutoScript; message?: string }
    setSaving(false)
    if (!response.ok || !data.script) return setNotice(data.message ?? (xianxia ? '封存玉簡失敗' : '儲存失敗'))
    setNotice(xianxia ? '玉簡已封存入閣' : '腳本已儲存')
    setDirty(false)
    await loadScripts(data.script.id)
  }

  const deleteScript = async () => {
    if (!selectedId || !window.confirm(`確定刪除「${name}」？這會一併移除腳本基準圖。`)) return
    const response = await fetch(`/api/frontend-auto/scripts/${selectedId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ createdBy: actor }) })
    if (!response.ok) return setNotice(xianxia ? '焚毀失敗，請確認玉簡歸屬' : '刪除失敗，請確認腳本擁有者')
    setSelectedId('')
    setSteps([])
    setName('')
    await loadScripts()
  }

  // 錄製當下驗過的結果。跟 Backend 錄製共用同一張措辭表，不要各寫一份。
  // ⚠️ `unknown`（非原生 CSS 驗不了、元素已消失、shadow DOM）刻意不算問題——
  //    把它標紅會讓人去修根本沒壞的步驟。
  const selectorWarnings = useMemo(() => {
    const flat: AutoStep[] = []
    const walk = (list: AutoStep[]) => list.forEach(step => { flat.push(step); if (step.children?.length) walk(step.children) })
    walk(steps)
    return {
      bad: flat.flatMap((step, i) => SELECTOR_CHECK_LABEL[String(step.selectorCheck)]
        ? [{ index: i + 1, why: SELECTOR_CHECK_LABEL[String(step.selectorCheck)] }] : []),
      weak: flat.flatMap((step, i) => step.selectorStrategy === 'cssPath' ? [i + 1] : []),
    }
  }, [steps])

  const startRecording = async () => {
    if (!(recorderAvailable || agents.length)) {
      // 「有連線但缺能力」跟「一台都沒有」要分開講——前者按「更新程式碼」就好。
      return setNotice(agentsOutdated
        ? `你有 ${agentsOutdated} 台 Local Agent 在線，但都缺少錄製能力——請到 Local Agent 頁面按「更新程式碼」再重啟。`
        : '沒有可用錄製器；請從 localhost 開啟，或連接具備 uat-record 的 Local Agent（它必須是你自己的）。')
    }
    const target = runConfig.url || window.prompt('請輸入要錄製的目標 URL')?.trim() || ''
    if (!target) return
    setRunConfig(value => ({ ...value, url: target }))
    const response = await fetch('/api/frontend-auto/record/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // theme 只決定錄製視窗裡那個浮動面板的配色與用詞，不影響錄到什麼
      body: JSON.stringify({ url: target, platform, resolution: runConfig.resolution, theme: xianxia ? 'xianxia' : 'normal', ...(agentId ? { agentId } : {}) }),
    })
    const data = await response.json() as { ok?: boolean; sessionId?: string; displayUrl?: string; via?: string; agentHostname?: string; message?: string }
    if (!response.ok || !data.sessionId) return setNotice(data.message ?? '錄製啟動失敗')
    setRecordSessionId(data.sessionId)
    setRecPaused(false)
    setRecordLabel(data.via === 'agent' ? `Local Agent · ${data.agentHostname ?? agentId}` : '本機 Chrome')
    setNotice('錄製中；請在新開啟的 Chrome 視窗操作')
    pollRecorder.current = setInterval(async () => {
      const poll = await fetch(`/api/frontend-auto/record/status/${data.sessionId}`)
      const status = await poll.json() as {
        done?: boolean; error?: string | null; steps?: unknown[]; cdpWarning?: string
        paused?: boolean
        stats?: UatStatsPayload | null
        consoleLogs?: { type: string; text: string; location?: string; ts: number }[]
        consoleDropped?: number
        pinusPatched?: string | null
      }
      if (status.steps?.length) {
        setSteps(status.steps.map((step, index) => parseSteps(JSON.stringify([step]))[0] ?? { ...createStep('wait'), name: `錄製步驟 ${index + 1}` }))
        setDirty(true)
      }
      // 錄製時的 network／pinus 走跟執行時同一個面板——資料形狀本來就一樣，
      // 沒有理由做第二套 UI。
      if (status.stats) {
        setNetStats(status.stats); setStatsAt(Date.now())
        // ⚠️ 兩條路（輪詢與停止）都要更新。少一邊的話「停止之後才想加斷言」會拿到舊清單。
        if (status.stats.net?.apiCalls) setRecApiCalls(status.stats.net.apiCalls)
      }
      // console 整包覆蓋而不是 append：server 端已經裁到上限了，
      // 這裡再 append 會跟它重複，變成同一行出現很多次。
      if (status.consoleLogs) setRecConsole(status.consoleLogs)
      if (typeof status.consoleDropped === 'number') setRecConsoleDropped(status.consoleDropped)
      if (status.pinusPatched !== undefined) setPinusPatched(status.pinusPatched ?? null)
      // ⚠️ 暫停狀態一律以輪詢回來的為準。按下去就樂觀改畫面的話，agent 沒收到
      //    指令時主畫面會顯示已暫停，而錄製其實還在繼續。
      if (typeof status.paused === 'boolean') {
        setRecPaused(status.paused)
        // 等到的是我們要求的那個狀態才算確認。收到相反的不清掉等待——
        // 那代表 agent 還沒處理完，交給逾時去收，不要把它誤報成已完成。
        pauseGate.confirm(status.paused)
      }
      if (status.cdpWarning) setNotice(status.cdpWarning)
      if (status.done) {
        if (pollRecorder.current) clearInterval(pollRecorder.current)
        pollRecorder.current = null
        setRecordSessionId(null)
        setRecordLabel('')
        setRecPaused(false)
        pauseGate.cancel()
        // ⚠️ 中斷跟完成要分得開。步驟一樣會帶回來（上面已經併進腳本），
        //    但「錄製完成」會讓人以為東西都錄到了，實際上是斷在半路。
        setNotice(status.error
          ? `⚠️ ${status.error}；已取回 ${status.steps?.length ?? 0} 個步驟`
          : `錄製完成，共 ${status.steps?.length ?? 0} 個步驟`)
      }
    }, 2000)
  }

  /**
   * 切換暫停。⚠️ **不要樂觀更新畫面**——agent 模式是把指令丟過去、等它回報，
   * 先把畫面改成「已暫停」的話，agent 沒收到時會顯示暫停而錄製其實還在繼續。
   * 狀態一律由輪詢帶回來（本機模式是同步的，回應就帶了結果）。
   */
  const togglePause = async () => {
    if (!recordSessionId || pausePending) return
    const next = !recPaused
    // gate 會在這一行**先起跑逾時計時器**再回來，所以「請求永遠不回來」也一定會結束等待。
    const token = pauseGate.begin(next)
    try {
      const response = await fetch(`/api/frontend-auto/record/pause/${recordSessionId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: next }),
      })
      // ⚠️ 回應不是 JSON 也要有結論（Nginx 的 502 頁面就是這種）。
      const data = await response.json().catch(() => ({})) as { ok?: boolean; paused?: boolean; pending?: boolean; message?: string }
      // ⚠️ **遲到的回應什麼都不能做**（CodeX 2026-09-18 複驗指出）：A 逾時之後使用者
      //    又按了一次送出 B，A 的回應這時才回來——它不可以把 B 的等待一起清掉。
      if (!pauseGate.isCurrent(token)) return
      if (!response.ok) { pauseGate.settle(token); return setNotice(data.message ?? '切換暫停失敗') }
      // 本機模式是同步的，回應就帶了結果，不必等輪詢
      if (typeof data.paused === 'boolean') { setRecPaused(data.paused); pauseGate.settle(token); return }
      // agent 模式只是把指令丟過去——等輪詢帶回 agent 真的回報的狀態，
      // 等不到就由 gate 裡那個計時器收尾。
    } catch {
      if (!pauseGate.isCurrent(token)) return
      pauseGate.settle(token)
      setNotice('切換暫停失敗：連線中斷，狀態未變更。')
    }
  }

  const stopRecording = async () => {
    if (!recordSessionId) return
    if (pollRecorder.current) clearInterval(pollRecorder.current)
    pollRecorder.current = null
    const response = await fetch(`/api/frontend-auto/record/stop/${recordSessionId}`, { method: 'POST' })
    const data = await response.json() as {
      steps?: unknown[]
      stats?: UatStatsPayload | null
      consoleLogs?: { type: string; text: string; location?: string; ts: number }[]
      consoleDropped?: number
      pinusPatched?: string | null
    }
    if (data.steps?.length) setSteps(parseSteps(JSON.stringify(data.steps)))
    // ⚠️ 停止之後 session 就被移除了，再打 /record/status 只會拿到 found:false。
    //    最後一份量測只有這個回應帶得回來，不接的話畫面會在停止當下**突然清空**。
    if (data.stats) {
      setNetStats(data.stats); setStatsAt(Date.now())
      if (data.stats.net?.apiCalls) setRecApiCalls(data.stats.net.apiCalls)
    }
    if (data.consoleLogs) setRecConsole(data.consoleLogs)
    if (typeof data.consoleDropped === 'number') setRecConsoleDropped(data.consoleDropped)
    if (data.pinusPatched !== undefined) setPinusPatched(data.pinusPatched ?? null)
    setDirty(true)
    setRecordSessionId(null)
    setRecordLabel('')
    setRecPaused(false)
    pauseGate.cancel()
    setNotice(`錄製已停止，共 ${data.steps?.length ?? 0} 個步驟`)
  }

  const runScript = async () => {
    if (!selectedId) return setNotice('請先儲存腳本再執行')
    if (dirty) await saveScript()
    const executable = compileExecutableSteps(steps)
    if (!executable.length) return setNotice('腳本沒有可執行步驟')
    setLogs([`準備執行 ${name}`, `已將 ${steps.length} 個區塊編譯為 ${executable.length} 個步驟`])
    const createResponse = await fetch('/api/frontend-auto/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptId: selectedId, scriptName: name, platform, ranBy: actor, totalSteps: executable.length, result: 'running', startedAt: Date.now() }),
    })
    const createData = await createResponse.json() as { run?: { id: string } }
    if (!createData.run?.id) return setNotice('建立執行紀錄失敗')
    const runId = createData.run.id
    activeRunId.current = runId
    setRunning(true)
    setNetStats(null); setStatsAt(null)
    runStream.current?.close()
    const stream = new EventSource(`/api/frontend-auto/log-stream/${runId}`)
    runStream.current = stream
    stream.addEventListener('log', event => {
      const payload = JSON.parse(event.data) as { line: string }
      setLogs(lines => [...lines, payload.line])
      if (payload.line.includes('完成')) { setRunning(false); void loadRuns() }
    })
    stream.addEventListener('stats', event => {
      try { setNetStats(JSON.parse(event.data) as UatStatsPayload); setStatsAt(Date.now()) } catch { /* 壞掉的一筆跳過就好，不要讓面板整個掛掉 */ }
    })
    await fetch(`/api/frontend-auto/runs/${runId}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: JSON.stringify(executable), url: runConfig.url, platform, resolution: runConfig.resolution, failureMode: runConfig.failureMode, headed: runConfig.headed, ...(agentId ? { agentId } : {}) }),
    })
  }

  const stopRun = async () => {
    if (!activeRunId.current) return
    await fetch(`/api/frontend-auto/runs/${activeRunId.current}/stop`, { method: 'POST' })
    setRunning(false)
    runStream.current?.close()
    setLogs(lines => [...lines, '執行已由使用者停止'])
    void loadRuns()
  }

  const uploadBaseline = async (file?: File) => {
    if (!file || !selectedId) return setNotice('請先儲存或選擇腳本')
    const form = new FormData()
    form.append('image', file); form.append('scriptId', selectedId); form.append('cropId', crypto.randomUUID()); form.append('name', file.name); form.append('platform', platform); form.append('createdBy', actor)
    if ((await fetch('/api/frontend-auto/baselines', { method: 'POST', body: form })).ok) void loadAssets()
  }
  const uploadTemplate = async (file?: File) => {
    if (!file) return
    const form = new FormData(); form.append('image', file); form.append('name', file.name); form.append('createdBy', actor)
    if ((await fetch('/api/frontend-auto/templates', { method: 'POST', body: form })).ok) void loadAssets()
  }
  const removeAsset = async (kind: 'baselines' | 'templates' | 'ocr-regions', id: string) => {
    if ((await fetch(`/api/frontend-auto/${kind}/${id}`, { method: 'DELETE' })).ok) void loadAssets()
  }
  const addOcr = async () => {
    const name = window.prompt('OCR 區域名稱')?.trim()
    if (!name) return
    await fetch('/api/frontend-auto/ocr-regions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, label: '', cropX: 0, cropY: 0, cropW: 100, cropH: 40 }) })
    void loadAssets()
  }

  return (
    <div className="uat-automation-shell">
      <aside className="uat-script-sidebar">
        <div className="uat-pane-heading"><div><span>{xianxia ? 'JADE ARCHIVE' : 'TEST CASES'}</span><h3>{platform.toUpperCase()} {copy.cases}</h3></div><button type="button" className="uat-icon-btn" onClick={newScript} aria-label={xianxia ? '新立玉簡' : '新增腳本'}>＋</button></div>
        <input className="uat-field" value={search} onChange={event => setSearch(event.target.value)} placeholder={xianxia ? '尋找玉簡' : '搜尋腳本'} />
        <div className="uat-filter-row">{(['all', 'mine', 'public'] as const).map(value => <button type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)} key={value}>{value === 'all' ? '全部' : value === 'mine' ? (xianxia ? '本門' : '我的') : (xianxia ? '公傳' : '公開')}</button>)}</div>
        <div className="uat-script-list">
          {visibleScripts.map(script => <button type="button" className={`uat-script-item${selectedId === script.id ? ' is-active' : ''}`} key={script.id} onClick={() => selectScript(script.id)}><span className={`uat-result-dot is-${latestResult.get(script.id) ?? 'idle'}`} /><span><strong>{script.name}</strong><small>{script.created_by} · {parseSteps(script.steps).length} {xianxia ? '陣眼' : '區塊'}</small></span></button>)}
          {!visibleScripts.length && <div className="uat-list-empty">{xianxia ? '藏經閣中尚無相符玉簡' : '尚無符合條件的腳本'}</div>}
        </div>
        <button type="button" className="uat-btn is-primary is-wide" onClick={newScript}>{copy.addScript}</button>
      </aside>

      <div className="uat-studio-main">
        <header className="uat-studio-toolbar">
          <div className="uat-script-title"><input value={name} onChange={event => { setName(event.target.value); setDirty(true) }} placeholder={copy.scriptName} /><span>{dirty ? copy.unsaved : selectedId ? copy.synced : copy.newScript} · {countExecutableSteps(steps)} {xianxia ? '道可執行術式' : '個執行步驟'}</span></div>
          <nav>{(['editor', 'run', 'assets', 'history'] as const).map(item => <button type="button" className={view === item ? 'is-active' : ''} onClick={() => setView(item)} key={item}>{item === 'editor' ? copy.editor : item === 'run' ? copy.run : item === 'assets' ? copy.assets : copy.history}</button>)}</nav>
          <div className="uat-toolbar-actions">
            {recordSessionId ? <>
              <button type="button" className="uat-btn is-quiet" onClick={togglePause} disabled={pausePending}>{pausePending ? '同步中…' : recPaused ? copy.resumeRecord : copy.pauseRecord}</button>
              <button type="button" className="uat-btn is-danger" onClick={stopRecording}>{copy.stopRecord}</button>
            </> : <button type="button" className="uat-btn is-quiet" onClick={startRecording}>{copy.record}</button>}
            <button type="button" className="uat-btn is-primary" onClick={saveScript} disabled={saving}>{saving ? copy.saving : copy.save}</button>
          </div>
        </header>
        {(notice || recordLabel) && <div className="uat-notice"><XianxiaIcon name="notification" size={16} /><span>{recordLabel ? `${recordLabel} ${recPaused ? (xianxia ? '已暫歇' : '已暫停') : (xianxia ? '觀照錄術中' : '錄製中')}` : notice}</span><button type="button" onClick={() => setNotice('')}>{xianxia ? '收起符訊' : '關閉'}</button></div>}

        {view === 'editor' && !!selectorWarnings.bad.length && <div className="uat-multi-alert" role="alert">
          <p>⚠️ 這些步驟的定位在<strong>錄製當下就已經不對</strong>，直接執行會失敗：</p>
          {selectorWarnings.bad.map(bad => <div key={bad.index}>第 {bad.index} 步——{bad.why}</div>)}
        </div>}
        {view === 'editor' && !!selectorWarnings.weak.length && <p className="uat-multi-alert">共 {selectorWarnings.weak.length} 個步驟用結構路徑定位（第 {selectorWarnings.weak.join('、')} 步），這是最脆的一階，請試跑確認找得到正確元素。</p>}
        {view === 'editor' && <BlockEditor steps={steps} baselines={baselines} selectedId={selectedStepId} onSelectedIdChange={setSelectedStepId} onChange={next => { setSteps(next); setDirty(true) }} themeMode={themeMode} />}
        {view === 'run' && (
          <div className="uat-run-layout">
            <section className="uat-panel uat-inscribed-panel">
              <div className="uat-section-title"><span>{xianxia ? 'ARRAY CONTROL' : 'RUN CONFIG'}</span><h3>{xianxia ? '啟陣設定' : '執行設定'}</h3></div>
              <div className="uat-form-grid">
                <label>{xianxia ? '幻境入口' : '目標網址'}<input className="uat-field" value={runConfig.url} onChange={event => setRunConfig(value => ({ ...value, url: event.target.value }))} placeholder="https://..." /></label>
                <label>{xianxia ? '觀照尺寸' : '解析度'}<select className="uat-field" value={runConfig.resolution} onChange={event => setRunConfig(value => ({ ...value, resolution: event.target.value }))}>{(platform === 'h5' ? ['390x844', '500x877'] : ['1366x768', '1440x900', '1920x1080']).map(value => <option key={value}>{value}</option>)}</select></label>
                <label>{xianxia ? '陣眼失守時' : '失敗處理'}<select className="uat-field" value={runConfig.failureMode} onChange={event => setRunConfig(value => ({ ...value, failureMode: event.target.value }))}><option value="continue">{xianxia ? '續行推演' : '繼續執行'}</option><option value="stop">{xianxia ? '立即收陣' : '立即停止'}</option></select></label>
                <label>{xianxia ? '傀儡節點' : '執行節點'}<select className="uat-field" value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">{xianxia ? '自動調度' : '自動選擇'}</option>{agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.label ?? agent.hostname ?? agent.agentId}</option>)}</select></label>
              </div>
              <label className="uat-check"><input type="checkbox" checked={runConfig.headed} onChange={event => setRunConfig(value => ({ ...value, headed: event.target.checked }))} />{xianxia ? '顯現幻境視窗' : '顯示瀏覽器視窗'}</label>
              <label className="uat-check"><input type="checkbox" checked={isPublic} onChange={event => { setIsPublic(event.target.checked); setDirty(true) }} />{xianxia ? '允許同門啟用此玉簡' : '允許其他使用者執行此腳本'}</label>
              <div className="uat-run-actions">{running ? <button type="button" className="uat-btn is-danger" onClick={stopRun}>{xianxia ? '收陣' : '停止執行'}</button> : <button type="button" className="uat-btn is-primary" onClick={runScript}>{xianxia ? '啟陣推演' : '執行所選腳本'}</button>}<button type="button" className="uat-btn is-quiet" onClick={deleteScript} disabled={!selectedId}>{xianxia ? '焚毀玉簡' : '刪除腳本'}</button></div>
            </section>
            <NetworkPanel stats={netStats} themeMode={themeMode} updatedAt={statsAt} />
            {/* 錄製時攔到的 console／pageerror。沒有錄過就整塊不顯示——
                空面板會讓人以為「攔到了但沒東西」，而實際上是還沒錄。 */}
            {/* 錄製時抓到的 API，可以直接變成一顆「這支 API 必須被呼叫」。
                存的是 urlPattern 不是原始網址——原始網址裡的 id／token／時間戳
                直接當條件的話，換一筆資料或隔一天重跑就全紅。 */}
            {!!recApiCalls.length && (
              <section className="uat-panel uat-inscribed-panel">
                <div className="uat-section-title">
                  <span>{xianxia ? 'TRACED CALLS' : 'RECORDED API'}</span>
                  <h3>{xianxia ? '錄製時的往來符訊' : '錄製時的 API'}</h3>
                </div>
                <p className="uat-hint">
                  {xianxia ? '點「加入檢查」可把該符訊化為驗證術式，並自行移到對應步驟之後。'
                    : '點「加入檢查」會在步驟最後加一顆斷言，請自行拖到對應操作之後——它只檢查「那一步之後」有沒有打到。'}
                </p>
                {recApiCalls.map((call, i) => (
                  <div className="uat-multi-api" key={`${call.url}-${i}`}>
                    <code>{call.method ?? 'GET'} {call.urlPattern || call.url} — {call.status ?? '—'}</code>
                    <button
                      type="button"
                      className="uat-btn is-quiet"
                      disabled={call.status === null || call.status === undefined}
                      title={call.status === null || call.status === undefined
                        ? '這筆沒有狀態碼（可能還沒完成或失敗了），不能當成斷言'
                        : call.url}
                      onClick={() => {
                        const step = createStep('assert_api_called')
                        step.name = `API：${call.urlPattern || call.url}`
                        step.urlPattern = call.urlPattern || call.url
                        setSteps(prev => [...prev, step])
                        setDirty(true)
                        setNotice(`已加入斷言：${step.urlPattern}（請拖到對應操作之後）`)
                      }}
                    >{xianxia ? '化為術式' : '加入檢查'}</button>
                  </div>
                ))}
              </section>
            )}
            {(recConsole.length > 0 || pinusPatched !== null) && (
              <section className="uat-panel uat-log-panel uat-inscribed-panel">
                <div className="uat-section-title">
                  <span>{xianxia ? 'ECHO OF FAULTS' : 'RECORDED CONSOLE'}</span>
                  <h3>{xianxia ? '錄製雜訊' : '錄製時的 Console'}</h3>
                </div>
                <p className="uat-hint">
                  {pinusPatched
                    ? `pinus 已攔截（補在 ${pinusPatched}）`
                    : ' 這一頁沒有偵測到 pinus——多半是它本來就沒有，不是攔截失敗'}
                  {recConsoleDropped > 0 && `；因超過上限未保留 ${recConsoleDropped} 筆`}
                </p>
                <pre>{recConsole.length
                  ? recConsole.map(e => `[${e.type}] ${e.text}${e.location ? `  (${e.location})` : ''}`).join('\n')
                  : (xianxia ? '此番觀照未聞雜訊。' : '這次錄製沒有攔到 console 訊息。')}</pre>
              </section>
            )}
            <section className="uat-panel uat-log-panel uat-inscribed-panel"><div className="uat-section-title"><span>{xianxia ? 'SPIRIT FLOW' : 'LIVE LOG'}</span><h3>{xianxia ? '靈流行跡' : '即時日誌'}</h3></div><pre>{logs.length ? logs.join('\n') : (xianxia ? '玉簡未啟，靈息未至。' : '尚未執行。設定完成後啟動腳本，日誌會顯示在這裡。')}</pre></section>
          </div>
        )}
        {view === 'assets' && <div className="uat-assets-grid"><AssetSection title={xianxia ? '玉簡基準靈影' : '腳本基準圖'} count={baselines.length} uploadLabel={xianxia ? '納入基準靈影' : '上傳基準圖'} onUpload={uploadBaseline} xianxia={xianxia}>{baselines.map(item => <AssetCard key={item.id} name={item.name} image={item.image_path} meta={`${xianxia ? '偏移界線' : '門檻'} ${item.threshold ?? 0.08}`} onDelete={() => removeAsset('baselines', item.id)} deleteLabel={xianxia ? '撤去' : '刪除'} />)}</AssetSection><AssetSection title={xianxia ? 'PC 靈影藏庫' : 'PC 模板圖庫'} count={templates.length} uploadLabel={xianxia ? '納入靈影' : '上傳模板'} onUpload={uploadTemplate} xianxia={xianxia}>{templates.map(item => <AssetCard key={item.id} name={item.name} image={item.image_path} meta={item.last_confidence == null ? (xianxia ? '尚未照驗' : '尚未比對') : `${xianxia ? '靈契' : '信心'} ${Math.round(item.last_confidence * 100)}%`} onDelete={() => removeAsset('templates', item.id)} deleteLabel={xianxia ? '撤去' : '刪除'} />)}</AssetSection><section className="uat-panel uat-asset-section uat-inscribed-panel"><div className="uat-section-title"><span>OCR SPIRIT SCRIPT</span><h3>{xianxia ? '靈文辨識區' : '辨識區域'} <small>{ocrRegions.length}</small></h3></div><button type="button" className="uat-btn is-quiet" onClick={addOcr}>{xianxia ? '新立靈文區' : '新增 OCR 區域'}</button><div className="uat-ocr-list">{ocrRegions.map(item => <div key={item.id}><span><strong>{item.name}</strong><small>{item.crop_x}, {item.crop_y} · {item.crop_w} × {item.crop_h}</small></span><button type="button" onClick={() => removeAsset('ocr-regions', item.id)}>{xianxia ? '撤去' : '刪除'}</button></div>)}</div></section></div>}
        {view === 'history' && <section className="uat-panel uat-history uat-inscribed-panel"><div className="uat-section-title"><span>{xianxia ? 'TRIAL CHRONICLE' : 'RUN HISTORY'}</span><h3>{xianxia ? '近五十卷試煉錄' : '最近 50 次執行'}</h3></div><div className="uat-history-table"><div className="is-head"><span>{xianxia ? '命燈' : '結果'}</span><span>{xianxia ? '玉簡' : '腳本'}</span><span>{xianxia ? '推演統計' : '統計'}</span><span>{xianxia ? '天時' : '時間'}</span></div>{runs.map(run => <div key={run.id}><span><i className={`uat-result-dot is-${run.result}`} />{run.result}</span><span>{scripts.find(script => script.id === run.script_id)?.name ?? run.script_id}</span><span>{run.passed ?? 0} / {run.failed ?? 0} / {run.skipped ?? 0}</span><span>{run.started_at ? new Date(run.started_at).toLocaleString('zh-TW') : '—'}</span></div>)}</div></section>}
      </div>
    </div>
  )
}

function AssetSection({ title, count, uploadLabel, onUpload, children, xianxia }: { title: string; count: number; uploadLabel: string; onUpload: (file?: File) => void; children: React.ReactNode; xianxia: boolean }) {
  return <section className="uat-panel uat-asset-section uat-inscribed-panel"><div className="uat-section-title"><span>{xianxia ? 'SPIRIT IMAGES' : 'VISUAL ASSETS'}</span><h3>{title} <small>{count}</small></h3></div><label className="uat-btn is-quiet uat-upload">{uploadLabel}<input type="file" accept="image/*" onChange={event => onUpload(event.target.files?.[0])} /></label><div className="uat-asset-list">{children}</div></section>
}

function AssetCard({ name, image, meta, onDelete, deleteLabel }: { name: string; image: string; meta: string; onDelete: () => void; deleteLabel: string }) {
  return <article className="uat-asset-card"><img src={image} alt="" /><span><strong>{name}</strong><small>{meta}</small></span><button type="button" onClick={onDelete}>{deleteLabel}</button></article>
}

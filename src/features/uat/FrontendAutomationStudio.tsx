import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XianxiaIcon } from '../../components/XianxiaIcon'
import { createPortal } from 'react-dom'
import { BlockEditor, needsTc, tcShortLabel, type BackendSnippetOption, type TcBindingOption } from './BlockEditor'
import { NetworkPanel, type UatStatsPayload } from './NetworkPanel'
import { SELECTOR_CHECK_LABEL } from '../../../shared/uat-selector-check'
import { TcRetargetDialog } from './TcRetargetDialog'
import { compileExecutableSteps, countExecutableSteps, createStep, newStepId, parseSteps, serializeSteps } from './step-model'
import { createPauseGate } from './pause-gate'
// ⚠️ 排隊的規則跟 Backend 共用同一支——各寫一份的話，「session 對不上要停」
//    「取不到結果不能當通過」這些安靜出錯的規則一定會有一邊漏掉。
import { runScriptQueue, type QueueItem } from './script-queue'
import { focusPanel } from './focusPanel'
import type { AgentOption, AutoBaseline, AutoFilter, AutoPlatform, AutoRun, AutoScript, AutoStep, AutoTemplate, OcrRegion, UatThemeMode } from './types'

/* 分頁已移除：版面照 Backend 的模板改成單一畫面（視覺資產與執行紀錄走彈框）。 */

interface Props { platform: AutoPlatform; themeMode: UatThemeMode; agentId: string }

/** 後端存的是 JSON 字串。⚠️ 壞掉的一律當成「沒綁」，不要整頁掛掉 */
function parseBindings(raw?: string): TcBindingOption[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as TcBindingOption[]
    return Array.isArray(parsed) ? parsed.filter(item => item?.recordId) : []
  } catch { return [] }
}

/**
 * 從 Lark 表格網址拆出 tableId。
 * ⚠️ 拆不出來回空字串讓後端擋，**不要猜**——猜錯的結果是「回寫到另一張表」。
 */
function tableIdFromUrl(url: string) {
  try { return new URL(url).searchParams.get('table') ?? '' } catch { return '' }
}

function currentActor() {
  const saved = localStorage.getItem('frontend_auto_user')
  if (saved) return saved
  localStorage.setItem('frontend_auto_user', 'local-user')
  return 'local-user'
}

function isLocalHost() {
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname.toLowerCase())
}

export function FrontendAutomationStudio({ platform, themeMode, agentId }: Props) {
  const xianxia = themeMode === 'xianxia'
  const copy = xianxia ? {
    cases: '玉簡卷宗', addScript: '新立試煉玉簡', editor: '陣圖編排', run: '啟陣控制', assets: '靈影素材', history: '試煉錄',
    record: '觀照錄術', stopRecord: '停止觀照', pauseRecord: '暫歇觀照', resumeRecord: '續行觀照', save: '封存玉簡', saving: '封存中', scriptName: '玉簡名號', unsaved: '尚未封存', synced: '已入藏經閣', newScript: '新玉簡',
  } : {
    cases: '腳本', addScript: '手動新增腳本', editor: '流程編輯', run: '執行控制', assets: '視覺資產', history: '執行紀錄',
    record: '錄製新腳本', stopRecord: '停止錄製', pauseRecord: '暫停錄製', resumeRecord: '繼續錄製', save: '儲存腳本', saving: '儲存中', scriptName: '腳本名稱', unsaved: '尚未儲存', synced: '已同步', newScript: '新腳本',
  }
  const actor = currentActor()
  const [scripts, setScripts] = useState<AutoScript[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [steps, setSteps] = useState<AutoStep[]>([])
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [isPublic, setIsPublic] = useState(true)
  /**
   * Lark TC 綁定。**跟 Backend 同一個模式**：一份腳本綁多筆 TC，每顆積木標所屬。
   * ⚠️ 沒綁的腳本照舊能跑，只是不回寫——空的不代表壞掉。
   */
  const [larkUrl, setLarkUrl] = useState('')
  const [retargetOpen, setRetargetOpen] = useState(false)
  const [bindings, setBindings] = useState<TcBindingOption[]>([])
  /** Lark 上這張表現有的 TC（給勾選用）。載入失敗要講，不要留一個空清單讓人以為沒 TC */
  const [tcPool, setTcPool] = useState<{ recordId: string; number: string; text: string }[]>([])
  const [tcLoading, setTcLoading] = useState(false)
  const [tcError, setTcError] = useState('')
  /** 編輯器改成彈框（使用者 2026-09-18 定案，跟 Backend 一致） */
  const [editorOpen, setEditorOpen] = useState(false)
  /** 視覺資產／執行紀錄改成彈框（版面照 Backend 的模板，單一畫面不再分頁） */
  const [panel, setPanel] = useState<'' | 'assets' | 'history'>('')
  /** 佇列：勾選哪幾份腳本、目前跑到哪 */
  const [queueIds, setQueueIds] = useState<string[]>([])
  const [queue, setQueue] = useState<QueueItem<never>[]>([])
  const [queueBusy, setQueueBusy] = useState(false)
  const queueCancelled = useRef(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const logEnd = useRef<HTMLSpanElement | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState<AutoFilter>('all')
  const [search, setSearch] = useState('')
  const [baselines, setBaselines] = useState<AutoBaseline[]>([])
  const [templates, setTemplates] = useState<AutoTemplate[]>([])
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>([])
  /** 後台設定片段清單（給「後台設定」積木選）。⚠️ 只存清單，內容留在 server */
  const [snippets, setSnippets] = useState<BackendSnippetOption[]>([])
  const [runs, setRuns] = useState<AutoRun[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  /**
   * 自己的 agent 裡「有連線但缺 uat-record 能力」的數量。
   * ⚠️ 要跟「一台都沒有」分開講——多半是 agent 還跑著舊程式碼，
   * 只說「目前沒有」的話，使用者看著明明連上的機器完全無從判斷。
   */
  const [agentsOutdated, setAgentsOutdated] = useState(0)
  const [recorderAvailable, setRecorderAvailable] = useState(isLocalHost())
  const [recordSessionId, setRecordSessionId] = useState<string | null>(null)
  const [recordLabel, setRecordLabel] = useState('')
  /**
   * 這一輪**實際**跑在哪。
   *
   * ⚠️ 原本前端根本沒讀執行的回應——所以同一顆按鈕可能跑在你的機器上、也可能
   *    在挑不到 Agent 時**安靜地跑在伺服器上**，而畫面長得一模一樣。
   *    Backend 早就有這個顯示（`runMode`），只有 H5/PC 這條沒有。
   */
  const [runWhere, setRunWhere] = useState('')
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
    fetch('/api/osm-uat/backend-snippets')
      .then(response => response.json())
      .then((data: { snippets?: BackendSnippetOption[] }) => setSnippets(data.snippets ?? []))
      .catch(() => { /* 拿不到就當沒有片段——積木會顯示「目前沒有片段」 */ })
  }, [])
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
    setLarkUrl(selected.lark_url ?? '')
    setBindings(parseBindings(selected.bindings))
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

  const newScript = () => {
    if (dirty && !window.confirm('目前有尚未儲存的調整，仍要建立新腳本嗎？')) return
    setSelectedId('')
    setName(`新的 ${platform.toUpperCase()} 測試`)
    setSteps([createStep('goto')])
    setIsPublic(true)
    // ⚠️ 綁定一定要清掉。不清的話新腳本會**繼承上一份的 TC**，而畫面上看起來完全正常——
    //    跑完就把結果寫到別人的那幾筆去了。
    setLarkUrl('')
    setBindings([])
    setTcPool([])
    setSelectedStepId(null)
    setDirty(true)
  }

  /**
   * 去 Lark 讀這張表現有的 TC。走 Backend 已經在用的那支 `/api/osm-uat/scan`——
   * 再寫一支等於兩份對 Lark 的解讀。
   *
   * ⚠️ **失敗一定要講出來**。回一個空清單的話，畫面看起來像「這張表沒有 TC」，
   *    而實際上可能是網址打錯或沒權限。
   */
  const loadTcPool = useCallback(async (url: string) => {
    if (!url.trim()) { setTcPool([]); setTcError(''); return }
    setTcLoading(true); setTcError('')
    try {
      const response = await fetch(`/api/osm-uat/scan?larkUrl=${encodeURIComponent(url.trim())}`)
      const data = await response.json().catch(() => ({})) as { ok?: boolean; tcs?: Record<string, unknown>[]; message?: string }
      if (!response.ok || !data.tcs) throw new Error(data.message ?? `HTTP ${response.status}`)
      setTcPool(data.tcs
        .filter(tc => tc.source === 'live' && tc.recordId)
        // ⚠️ 欄位名以**實際回應**為準（2026-09-18 拉真表確認）：敘述欄位是 `text`，沒有 `task`。
        //    原本寫 `tc.task ?? tc.text` 是照別處的印象抄的——`tc.task` 永遠 undefined。
        .map(tc => ({ recordId: String(tc.recordId), number: String(tc.number ?? ''), text: String(tc.text ?? '') })))
    } catch (error) {
      setTcPool([])
      setTcError(error instanceof Error ? error.message : String(error))
    } finally { setTcLoading(false) }
  }, [])

  const toggleBinding = (tc: TcBindingOption) => {
    setBindings(prev => prev.some(item => item.recordId === tc.recordId)
      ? prev.filter(item => item.recordId !== tc.recordId)
      : [...prev, tc])
    setDirty(true)
  }

  /** 綁了 TC 但還沒指定所屬的檢查／截圖——這些會讓執行**直接被擋**，要先講 */
  const unassignedSteps = useMemo(() => {
    if (!bindings.length) return []
    const walk = (list: AutoStep[], path: number[] = []): string[] => list.flatMap((step, i) => [
      ...(needsTc(step.action) && !step.tcId ? [`第 ${[...path, i + 1].join('-')} 步「${step.name || step.action}」`] : []),
      ...walk(step.children ?? [], [...path, i + 1]),
    ])
    return walk(steps)
  }, [steps, bindings.length])

  const selectScript = (id: string) => {
    if (id === selectedId) return
    if (dirty && !window.confirm('目前有尚未儲存的調整，仍要切換腳本嗎？')) return
    setSelectedId(id)
  }

  const saveScript = async () => {
    if (!name.trim()) return setNotice(xianxia ? '請為玉簡題名' : '請輸入腳本名稱')
    setSaving(true)
    const payload = {
      name: name.trim(), platform, steps: serializeSteps(steps), createdBy: actor, isPublic,
      // ⚠️ 三個欄位要**一起送**。少送一個後端會保留舊值（那是刻意的），
      //    但在這裡漏掉會讓畫面上的「已解除綁定」存不進去。
      larkUrl: larkUrl.trim(),
      tableId: tableIdFromUrl(larkUrl),
      bindings,
    }
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
    setRecordLabel(data.via === 'agent'
      ? `Local Agent · ${data.agentHostname ?? agentId}`
      : agentId === 'server' ? '伺服器端 Chrome' : '本機 Chrome')
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

  /**
   * 派一支腳本去跑，回傳 runId。**單支執行與佇列都走這一支。**
   *
   * ⚠️ 失敗一律 `throw`（帶著伺服器的訊息）。回 null 讓呼叫端自己判斷的話，
   *    佇列會把「派工被拒」當成「跑完了」繼續派下一支。
   */
  const startRun = useCallback(async (script: { id: string; name: string; steps: AutoStep[] }) => {
    const executable = compileExecutableSteps(script.steps)
    if (!executable.length) throw new Error(`「${script.name}」沒有可執行步驟`)
    const createResponse = await fetch('/api/frontend-auto/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptId: script.id, scriptName: script.name, platform, ranBy: actor, totalSteps: executable.length, result: 'running', startedAt: Date.now() }),
    })
    const createData = await createResponse.json().catch(() => ({})) as { run?: { id: string } }
    if (!createData.run?.id) throw new Error('建立執行紀錄失敗')
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
      // 🚨 **不要再用日誌文字判斷跑完了沒。** 原本是看行裡有沒有「完成」，
      //    而「後台設定：○○ 完成」也含那兩個字——腳本跑到一半就被當成結束。
      //    收尾改由下面的輪詢（讀 run 的 finished_at）負責。
    })
    stream.addEventListener('stats', event => {
      try { setNetStats(JSON.parse(event.data) as UatStatsPayload); setStatsAt(Date.now()) } catch { /* 壞掉的一筆跳過就好，不要讓面板整個掛掉 */ }
    })
    // ⚠️ **一定要讀回應。** 原本這裡整包丟掉，所以「挑不到 Agent 就跑在伺服器上」
    //    這個 fallback 是隱形的——使用者以為跑在自己機器上。
    const response = await fetch(`/api/frontend-auto/runs/${runId}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: JSON.stringify(executable), url: runConfig.url, platform, resolution: runConfig.resolution, failureMode: runConfig.failureMode, headed: runConfig.headed, ...(agentId ? { agentId } : {}) }),
    })
    const data = await response.json().catch(() => ({})) as { ok?: boolean; via?: string; agentId?: string; message?: string }
    if (!response.ok) { setRunWhere(''); setRunning(false); throw new Error(data.message ?? '執行啟動失敗') }
    setRunWhere(data.via === 'agent'
      ? `本次派工給 ${agents.find(a => a.agentId === data.agentId)?.hostname ?? data.agentId ?? 'Agent'}`
      : '本次跑在伺服器端')
    return runId
  }, [platform, actor, runConfig, agentId, agents])

  /** 這一次跑完了沒。**唯一的判斷來源**（不是日誌文字）。 */
  const runStatus = useCallback(async (runId: string) => {
    const response = await fetch(`/api/frontend-auto/runs/${runId}`)
    const data = await response.json().catch(() => ({})) as { run?: { id: string; result?: string; finished_at?: number | null }; running?: boolean }
    if (!data.run) throw new Error('查不到這一次的執行紀錄')
    return { sessionId: data.run.id, running: !!data.running || !data.run.finished_at, result: data.run.result ?? 'unknown' }
  }, [])

  /** 單支執行：跑完要把「執行中」關掉，靠輪詢不靠日誌文字 */
  const runScript = async () => {
    if (!selectedId) return setNotice('請先儲存腳本再執行')
    if (dirty) await saveScript()
    setLogs([`準備執行 ${name}`])
    try {
      const runId = await startRun({ id: selectedId, name, steps })
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        if (activeRunId.current !== runId) return   // 被停掉或換了一支
        const status = await runStatus(runId).catch(() => null)
        if (!status || status.running) continue
        setRunning(false)
        void loadRuns()
        return
      }
    } catch (error) {
      setRunning(false)
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 佇列：勾選的腳本依序跑完。
   *
   * ⚠️ **同時只能有一支在跑**由後端擋（`/execute` 會回 409 `already running`），
   *    這裡不去輪詢猜——查到閒置、派工、對方也派了，那是競態。
   */
  const runQueue = async () => {
    const picked = queueIds
      .map(id => scripts.find(script => script.id === id))
      .filter((script): script is AutoScript => !!script)
    if (!picked.length) return setNotice(xianxia ? '請先勾選要推演的玉簡' : '請先勾選要執行的腳本')
    if (dirty && !window.confirm('目前這一份有尚未儲存的調整，佇列會跑已存檔的版本。仍要開始嗎？')) return
    queueCancelled.current = false
    setQueueBusy(true)
    const entries: QueueItem<never>[] = picked.map(script => ({ id: script.id, title: script.name, state: 'waiting', results: [] }))
    setQueue(entries)
    setLogs([`佇列開始：共 ${entries.length} 份腳本`])
    await runScriptQueue<never>(entries, {
      start: async item => {
        const script = picked.find(row => row.id === item.id)!
        setLogs(lines => [...lines, `▶ ${script.name}`])
        return { sessionId: await startRun({ id: script.id, name: script.name, steps: parseSteps(script.steps) }) }
      },
      status: async sessionId => {
        const status = await runStatus(sessionId)
        return { sessionId: status.sessionId, running: status.running }
      },
      stop: async sessionId => { await fetch(`/api/frontend-auto/runs/${sessionId}/stop`, { method: 'POST' }) },
      // 這一層要的只是「有沒有結束」，判定明細在執行紀錄與日誌裡。
      // ⚠️ 仍然要回一個物件——回 undefined 會被當成「取不到結果」而中止整個佇列。
      results: async (_item, sessionId) => {
        const status = await runStatus(sessionId)
        return { results: [] as never[], stopped: status.result === 'stopped' }
      },
    }, {
      cancelled: () => queueCancelled.current,
      update: (index, patch) => setQueue(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row)),
      started: () => {},
    })
    setQueueBusy(false)
    setRunning(false)
    void loadRuns()
  }

  const cancelQueue = async () => {
    queueCancelled.current = true
    setLogs(lines => [...lines, '已要求取消佇列——目前這一支跑完（或被停止）之後不再往下派'])
    if (activeRunId.current) await fetch(`/api/frontend-auto/runs/${activeRunId.current}/stop`, { method: 'POST' })
  }

  const stopRun = async () => {
    setRunWhere('')
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
    form.append('image', file); form.append('scriptId', selectedId); form.append('cropId', newStepId());   // ⚠️ 不能用 crypto.randomUUID()——區網 HTTP 下不存在，見 step-model.ts form.append('name', file.name); form.append('platform', platform); form.append('createdBy', actor)
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

  // ── 第一屏的三步引導（照 Backend 的模板）──────────────────────────────
  // ⚠️ 這裡拿到的 agent 清單**沒有忙碌狀態**（那在最上面那條共用狀態列才有）。
  //    不要在這裡寫「N 台可用」——會變成一個看起來精確、實際是猜的數字。
  const targetAgent = agentId === 'server'
    ? '伺服器端'
    : agentId
      ? agents.find(agent => agent.agentId === agentId)?.hostname ?? agentId
      : agents.length
        ? `自動挑一台（共 ${agents.length} 台連線中）`
        : null
  /**
   * ①②③ 每一步都要**點得下去**並帶人到對應的面板（見 focusPanel.ts）。
   * ⚠️ `focus` 指的是「缺的東西在哪」，不是「這一步的說明在哪」——
   *    使用者點它的時機就是不知道該去哪填。
   */
  const startSteps = [
    { label: xianxia ? '選定玉簡' : '選擇或錄製腳本', done: !!selectedId, focus: 'uat-focus-scripts' },
    { label: xianxia ? '選在哪具傀儡上跑' : '選在哪台機器跑', done: !!targetAgent, focus: 'uat-focus-agent' },
    { label: xianxia ? '歸屬試煉（可略）' : '綁 Lark TC（可略過）', done: !!bindings.length, focus: 'uat-focus-lark' },
  ]
  // ⚠️ 「不能跑」的理由要講得出來。只把按鈕反灰的話，使用者只會看到一顆沒反應的按鈕。
  const blocked = !selectedId
    ? { why: xianxia ? '尚未選定玉簡——點此前往' : '還沒選腳本——點這裡前往清單', focus: 'uat-focus-scripts' }
    : !runConfig.url.trim()
      ? { why: xianxia ? '幻境入口還沒填——點此前往' : '目標網址還沒填——點這裡前往', focus: 'uat-focus-url' }
      : unassignedSteps.length
        ? { why: xianxia ? `有 ${unassignedSteps.length} 道校驗尚未歸屬試煉` : `有 ${unassignedSteps.length} 個檢查還沒指定所屬 TC`, focus: 'uat-focus-flow' }
        : null
  const blockedReason = blocked?.why ?? null
  /**
   * 卡片上的「綁幾筆 TC」與「上次跑的結果」。
   *
   * ⚠️ `bindings` 是後端存的 JSON 字串，舊腳本沒有這個欄位——parse 失敗一律當成 0，
   *    不要讓一份舊腳本把整個清單炸掉。
   */
  const bindingCount = (script: AutoScript) => {
    try { return JSON.parse(script.bindings ?? '[]').length as number } catch { return 0 }
  }
  /** runs 本來就已經抓進來了（右欄「執行紀錄」用的同一份），直接取最近一筆 */
  const lastRunOf = (scriptId: string) => runs.find(run => run.script_id === scriptId)
  const lastRunText = (run: AutoRun) => {
    const when = run.finished_at ?? run.started_at
    const stamp = when ? new Date(when).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
    // ⚠️ 只認得 pass／fail 兩種就好。其他狀態（執行中、取消）寫「—」而不是猜一個圖示，
    //    猜錯的話畫面會說「上次成功」而其實是被取消的。
    const mark = run.result === 'pass' ? '✅' : run.result === 'fail' ? '❌' : '—'
    return `${xianxia ? '前次' : '上次'} ${mark} ${stamp}`
  }

  const queueDone = queue.filter(item => item.state === 'done').length
  const queueFailed = queue.filter(item => item.state === 'error').length

  return (
    <div className="uat-backend-workbench">
      {/* ── 第一屏行動列 ─────────────────────────────────────────────── */}
      <div className="uat-backend-launch">
        <div className="uat-backend-launch-steps">
          {startSteps.map((step, index) => (
            <button type="button" className={`uat-launch-step${step.done ? ' is-done' : ''}`} key={step.label}
              title={xianxia ? '點一下前往此步驟' : '點一下跳到這一步要填的地方'}
              onClick={() => focusPanel(step.focus)}>
              <i>{index + 1}</i>{step.label}
            </button>
          ))}
          {blocked
            ? <button type="button" className="uat-launch-block" onClick={() => focusPanel(blocked.focus)}>{blocked.why}</button>
            : <span className="uat-launch-ready">{xianxia ? '可啟陣推演' : '可以開始執行'}</span>}
        </div>
        <div className="uat-backend-launch-cta">
          <div className="uat-backend-launch-meta">
            {bindings.length ? <>已綁 <b>{bindings.length}</b> 筆 TC</> : <>未綁 Lark TC（不回寫）</>}
            {targetAgent && <> · 跑在 <b>{targetAgent}</b></>}
            {/* ⚠️ 只有**已存檔**的腳本能改綁：改綁是伺服器端動作（要備份、要驗目標表） */}
            {selectedId && <> · <button type="button" className="uat-linkish" onClick={() => setRetargetOpen(true)}>改綁 TC 表格</button></>}
          </div>
          {selectedId && <TcRetargetDialog kind="frontend" scriptId={selectedId}
            scriptName={name || selectedId} currentTableId={tableIdFromUrl(larkUrl)}
            open={retargetOpen} onClose={() => setRetargetOpen(false)}
            onApplied={() => {
              setRetargetOpen(false)
              // ⚠️ 表格／綁定／步驟歸屬三樣都是**伺服器端**改的，一定要重新載入；
              //    不重載的話畫面還是舊的，下一次存檔會把伺服器的結果蓋回去。
              void loadScripts(selectedId)
            }} />}
          {recordSessionId ? <>
            <button type="button" className="uat-btn is-quiet" onClick={togglePause} disabled={pausePending}>{pausePending ? '同步中…' : recPaused ? copy.resumeRecord : copy.pauseRecord}</button>
            <button type="button" className="uat-btn is-danger" onClick={stopRecording}>{copy.stopRecord}</button>
          </> : running || queueBusy
            ? <button type="button" className="uat-btn is-danger is-wide" onClick={queueBusy ? cancelQueue : stopRun}>{queueBusy ? (xianxia ? '中止佇列' : '取消佇列') : (xianxia ? '收陣' : '停止執行')}</button>
            : <button type="button" className="uat-btn is-primary is-wide" disabled={!!blockedReason} onClick={runScript}>{xianxia ? '啟陣推演' : '執行所選腳本'}</button>}
        </div>
      </div>

      {(notice || recordLabel) && <div className="uat-notice"><XianxiaIcon name="notification" size={16} /><span>{recordLabel ? `${recordLabel} ${recPaused ? (xianxia ? '已暫歇' : '已暫停') : (xianxia ? '觀照錄術中' : '錄製中')}` : notice}</span>{runWhere ? <em className="uat-run-where">{runWhere}</em> : null}<button type="button" onClick={() => setNotice('')}>{xianxia ? '收起符訊' : '關閉'}</button></div>}

      {/* ── 網路監測 ＋ 即時日誌（刻意排在三欄之前，跑測試時最需要盯）── */}
      <section className="uat-backend-bottom">
        <NetworkPanel stats={netStats} themeMode={themeMode} updatedAt={statsAt} />
        <section className="uat-panel uat-backend-log">
          <div className="uat-log-toolbar">
            <div className="uat-section-title"><span>{xianxia ? 'SPIRIT FLOW' : 'PROCESS OUTPUT'}</span><h3>{xianxia ? '靈流行跡' : '即時執行日誌'}</h3></div>
            <label className="uat-check"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />{xianxia ? '追隨靈流' : '自動捲動'}</label>
            <button type="button" className="uat-btn is-quiet" onClick={() => setLogs([])}>{xianxia ? '拂去殘痕' : '清除'}</button>
          </div>
          <pre onScroll={event => { const el = event.currentTarget; setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40) }}>
            {logs.length ? logs.join('\n') : (xianxia ? '玉簡未啟，靈息未至。' : '等待執行...')}
            <span ref={logEnd} />
          </pre>
        </section>
      </section>

      {/* ── 左：腳本庫 ──────────────────────────────────────────────── */}
      <aside className="uat-backend-plan">
        <div className="uat-backend-flow-head">
          <div className="uat-section-title">
            <span>{xianxia ? 'JADE ARCHIVE' : 'SCRIPT LIBRARY'}</span>
            <h3>{platform.toUpperCase()} {copy.cases} <small>{visibleScripts.length}</small></h3>
            <p>{xianxia ? '點選玉簡可編排、推演與查閱結果。勾選可排入佇列。' : '點一下開啟編輯；勾選可排進佇列一起跑。'}</p>
          </div>
        </div>
        <div className="uat-tc-record-actions" id="uat-focus-scripts">
          <button type="button" className="uat-btn is-quiet" onClick={newScript}>{copy.addScript}</button>
          <button type="button" className="uat-btn" disabled={!!recordSessionId} onClick={startRecording}>{copy.record}</button>
        </div>
        {/* ⚠️ 兩顆按鈕長得像但做的事完全不同，不寫清楚的話只能靠試。
            （原本一顆叫「新增測試腳本」、一顆叫「Playwright 錄製」——
            一個講結果、一個講技術，看不出是同一組選擇。） */}
        <p className="uat-inline-hint">{xianxia
          ? '錄術＝開幻境側錄你的操作；新立＝自空白編排陣圖。'
          : '錄製＝開瀏覽器把你的操作錄成積木；手動＝從空白自己拉積木。'}</p>
        <input className="uat-field" value={search} onChange={event => setSearch(event.target.value)} placeholder={xianxia ? '尋找玉簡' : '搜尋腳本'} />
        <div className="uat-filter-row">{(['all', 'mine', 'public'] as const).map(value => <button type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)} key={value}>{value === 'all' ? '全部' : value === 'mine' ? (xianxia ? '本門' : '我的') : (xianxia ? '公傳' : '公開')}</button>)}</div>
        <div className="uat-script-list">
          {visibleScripts.map(script => (
            <div className={`uat-script-item${selectedId === script.id ? ' is-active' : ''}`} key={script.id}>
              {/* ⚠️ 勾選跟「開啟編輯」要分開：兩件事綁在一起的話，想排隊就會被迫換掉手上編的那一份 */}
              <input
                type="checkbox"
                aria-label={`${xianxia ? '排入佇列' : '排入佇列'}：${script.name}`}
                checked={queueIds.includes(script.id)}
                disabled={queueBusy}
                onChange={() => setQueueIds(prev => prev.includes(script.id) ? prev.filter(id => id !== script.id) : [...prev, script.id])}
              />
              {/* ⚠️ 上次執行結果的**小圓點**已移除（使用者 2026-09-18 指定）——
                  這裡是 2026-09-20 依使用者要求改回**文字**：一個色點只說得出
                  「紅或綠」，說不出什麼時候跑的；而「這支上次跑成功了嗎」正是
                  決定要不要點開的依據。要再拿掉的話拿掉文字就好，別把圓點加回來。 */}
              <button type="button" onClick={() => selectScript(script.id)}>
                <span><strong>{script.name}</strong><small>
                  {script.created_by} · {parseSteps(script.steps).length} {xianxia ? '陣眼' : '區塊'}
                  {bindingCount(script) > 0 && <> · {xianxia ? `繫 ${bindingCount(script)} 試煉` : `綁 ${bindingCount(script)} TC`}</>}
                  {lastRunOf(script.id) && <> · {lastRunText(lastRunOf(script.id)!)}</>}
                </small></span>
              </button>
            </div>
          ))}
          {!visibleScripts.length && <div className="uat-list-empty">{xianxia ? '藏經閣中尚無相符玉簡' : '尚無符合條件的腳本'}</div>}
        </div>
        {/* 全選／清除／已勾幾份擺同一列（使用者 2026-09-18 指定）——
            三樣都是「這次要跑哪幾份」，拆三行只是把一件事佔掉三倍高度。 */}
        <div className="uat-script-select-bar">
          <button type="button" className="uat-btn is-quiet" disabled={queueBusy || !visibleScripts.length} onClick={() => setQueueIds(visibleScripts.map(script => script.id))}>{xianxia ? '全選所列' : '全選'}</button>
          <button type="button" className="uat-btn is-quiet" disabled={queueBusy || !queueIds.length} onClick={() => setQueueIds([])}>{xianxia ? '清除' : '清除勾選'}</button>
          <span>{xianxia ? `已擇 ${queueIds.length} 卷` : `已勾 ${queueIds.length} 份`}</span>
        </div>
      </aside>

      {/* ── 中：統計卡 ＋ 佇列 ＋ 這一份的流程 ────────────────────────── */}
      <main className="uat-backend-center">
        <div className="uat-stat-grid">
          <article className="uat-stat is-pass"><span>{xianxia ? '試煉通過' : '通過'}</span><strong>{queueDone}</strong></article>
          <article className="uat-stat is-fail"><span>{xianxia ? '陣眼失守' : '失敗'}</span><strong>{queueFailed}</strong></article>
          <article className="uat-stat"><span>{xianxia ? '歸屬試煉' : '綁定 TC'}</span><strong>{bindings.length}</strong></article>
          <article className="uat-stat"><span>{xianxia ? '陣眼數' : '執行步驟'}</span><strong>{countExecutableSteps(steps)}</strong></article>
          <article className="uat-stat is-time"><span>{xianxia ? '佇列進度' : '佇列進度'}</span><strong>{queue.length ? `${queueDone + queueFailed} / ${queue.length}` : '—'}</strong></article>
        </div>

        {/* ── 腳本佇列 ─────────────────────────────────────────────── */}
        <section className="uat-panel uat-inscribed-panel">
          <div className="uat-section-title">
            <span>SCRIPT QUEUE</span>
            <h3>{xianxia ? '推演順序' : '腳本執行順序'} <small>{queueIds.length}</small></h3>
            <p>{xianxia ? '由上往下逐份推演；上下移動可調整先後。' : '由上往下逐份執行；上下移動可調整順序。'}</p>
          </div>
          {!queueIds.length
            ? <p className="uat-hint">{xianxia ? '請先於左側勾選要推演的玉簡。' : '請從左側勾選要執行的腳本。'}</p>
            : <div className="uat-step-summary">
                {queueIds.map((id, index) => {
                  const script = scripts.find(row => row.id === id)
                  const state = queue.find(row => row.id === id)
                  return (
                    <div key={id}>
                      <span className="uat-step-index">{String(index + 1).padStart(2, '0')}</span>
                      <strong>{script?.name ?? id}</strong>
                      {state && <em className={`is-${state.state}`} title={state.error ?? ''}>
                        {state.state === 'waiting' ? '等待' : state.state === 'running' ? '執行中' : state.state === 'done' ? '完成' : state.state === 'error' ? '失敗' : '取消'}
                      </em>}
                      {!queueBusy && <span className="uat-step-move">
                        <button type="button" aria-label="往上移" disabled={index === 0} onClick={() => setQueueIds(prev => { const next = [...prev]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next })}>▲</button>
                        <button type="button" aria-label="往下移" disabled={index === queueIds.length - 1} onClick={() => setQueueIds(prev => { const next = [...prev]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next })}>▼</button>
                      </span>}
                    </div>
                  )
                })}
              </div>}
          <div className="uat-run-actions">
            {queueBusy
              ? <button type="button" className="uat-btn is-danger" onClick={cancelQueue}>{xianxia ? '中止佇列' : '取消佇列'}</button>
              : <button type="button" className="uat-btn is-primary" disabled={!queueIds.length || running} onClick={runQueue}>{xianxia ? '依序推演' : '依序執行勾選的腳本'}</button>}
          </div>
          <p className="uat-hint">
            {xianxia ? '⚠️ 一次只推演一份；中途失敗或中止，後面的一律標為取消，不會偷偷續行。'
              : '⚠️ 一次只跑一份。中途失敗或取消，後面的會全部標成「取消」而不是留在等待中——留著的話你會以為它還會跑。'}
          </p>
        </section>

        {/* ── 這一份腳本 ───────────────────────────────────────────── */}
        <section className="uat-panel uat-inscribed-panel">
          <div className="uat-section-title">
            <span>{xianxia ? 'TRIAL ARRAY' : 'WORKFLOW'}</span>
            <h3>{name || (xianxia ? '未題名玉簡' : '未命名腳本')} <small>{countExecutableSteps(steps)}</small></h3>
            <p>{dirty ? copy.unsaved : selectedId ? copy.synced : copy.newScript}</p>
          </div>
          <label>{copy.scriptName}<input className="uat-field" value={name} onChange={event => { setName(event.target.value); setDirty(true) }} placeholder={copy.scriptName} /></label>
          {!!selectorWarnings.bad.length && <div className="uat-multi-alert" role="alert">
            <p>⚠️ 這些步驟的定位在<strong>錄製當下就已經不對</strong>，直接執行會失敗：</p>
            {selectorWarnings.bad.map(bad => <div key={bad.index}>第 {bad.index} 步——{bad.why}</div>)}
          </div>}
          {!!selectorWarnings.weak.length && <p className="uat-multi-alert">共 {selectorWarnings.weak.length} 個步驟用結構路徑定位（第 {selectorWarnings.weak.join('、')} 步），這是最脆的一階，請試跑確認找得到正確元素。</p>}
          {!!unassignedSteps.length && <div className="uat-multi-alert" role="alert">
            <p>⚠️ 這些檢查／截圖<strong>還沒指定所屬 TC</strong>，直接執行會被擋下來（結果不知道要回寫到哪一筆）：</p>
            {unassignedSteps.map(line => <div key={line}>{line}</div>)}
          </div>}
          <div className="uat-step-summary">
            {steps.slice(0, 8).map((step, i) => (
              <div key={step.id}>
                <span className="uat-step-index">{String(i + 1).padStart(2, '0')}</span>
                <strong>{step.name || step.action}</strong>
                {step.tcId && <em>{tcShortLabel(bindings.find(b => b.recordId === step.tcId), step.tcId)}</em>}
              </div>
            ))}
            {steps.length > 8 && <div><span className="uat-step-index">⋯</span><strong>還有 {steps.length - 8} 步</strong></div>}
            {!steps.length && <div className="is-empty"><span className="uat-step-index">—</span><strong>{xianxia ? '尚無術式，先錄一段或手動新增' : '還沒有步驟，先錄一段或手動新增'}</strong></div>}
          </div>
          <div className="uat-run-actions">
            <button type="button" className="uat-btn is-primary" onClick={() => setEditorOpen(true)}>{xianxia ? '開啟陣圖編排' : '編輯流程'}</button>
            <button type="button" className="uat-btn is-quiet" onClick={saveScript} disabled={saving}>{saving ? copy.saving : copy.save}</button>
            <button type="button" className="uat-btn is-quiet" onClick={deleteScript} disabled={!selectedId}>{xianxia ? '焚毀玉簡' : '刪除腳本'}</button>
          </div>
        </section>

        {/* 錄製時抓到的 API：可以直接變成一顆「這支 API 必須被呼叫」 */}
        {!!recApiCalls.length && (
          <section className="uat-panel uat-inscribed-panel">
            <div className="uat-section-title"><span>{xianxia ? 'TRACED CALLS' : 'RECORDED API'}</span><h3>{xianxia ? '錄製時的往來符訊' : '錄製時的 API'} <small>{recApiCalls.length}</small></h3>
              <p>{xianxia ? '點「化為術式」可把該符訊化為驗證術式，並自行移到對應步驟之後。' : '點「加入檢查」會在步驟最後加一顆斷言，請自行移到對應操作之後——它只檢查「那一步之後」有沒有打到。'}</p>
            </div>
            {recApiCalls.map((call, i) => (
              <div className="uat-multi-api" key={`${call.url}-${i}`}>
                <code>{call.method ?? 'GET'} {call.urlPattern || call.url} — {call.status ?? '—'}</code>
                <button
                  type="button"
                  className="uat-btn is-quiet"
                  disabled={call.status === null || call.status === undefined}
                  title={call.status === null || call.status === undefined ? '這筆沒有狀態碼（可能還沒完成或失敗了），不能當成斷言' : call.url}
                  onClick={() => {
                    const step = createStep('assert_api_called')
                    step.name = `API：${call.urlPattern || call.url}`
                    step.urlPattern = call.urlPattern || call.url
                    setSteps(prev => [...prev, step])
                    setDirty(true)
                    setNotice(`已加入斷言：${step.urlPattern}（請移到對應操作之後）`)
                  }}
                >{xianxia ? '化為術式' : '加入檢查'}</button>
              </div>
            ))}
          </section>
        )}
        {(recConsole.length > 0 || pinusPatched !== null) && (
          <section className="uat-panel uat-log-panel uat-inscribed-panel">
            <div className="uat-section-title"><span>{xianxia ? 'ECHO OF FAULTS' : 'RECORDED CONSOLE'}</span><h3>{xianxia ? '錄製雜訊' : '錄製時的 Console'}</h3></div>
            <p className="uat-hint">
              {pinusPatched ? `pinus 已攔截（補在 ${pinusPatched}）` : ' 這一頁沒有偵測到 pinus——多半是它本來就沒有，不是攔截失敗'}
              {recConsoleDropped > 0 && `；因超過上限未保留 ${recConsoleDropped} 筆`}
            </p>
            <pre>{recConsole.length ? recConsole.map(e => `[${e.type}] ${e.text}${e.location ? `  (${e.location})` : ''}`).join('\n') : (xianxia ? '此番觀照未聞雜訊。' : '這次錄製沒有攔到 console 訊息。')}</pre>
          </section>
        )}
      </main>

      {/* ── 右：執行設定 ────────────────────────────────────────────── */}
      <aside className="uat-backend-settings">
        <div className="uat-pane-heading"><div><span>{xianxia ? 'ARRAY SETTINGS' : 'RUN SETTINGS'}</span><h3>{xianxia ? '啟陣設定' : '執行設定'}</h3><small>{xianxia ? '套用至本次推演' : '套用至本次執行'}</small></div></div>
        <div className="uat-backend-settings-form">
          <label id="uat-focus-url">{xianxia ? '幻境入口' : '目標網址'}<input className="uat-field" value={runConfig.url} onChange={event => setRunConfig(value => ({ ...value, url: event.target.value }))} placeholder="https://..." /></label>
          <label>{xianxia ? '觀照尺寸' : '解析度'}<select className="uat-field" value={runConfig.resolution} onChange={event => setRunConfig(value => ({ ...value, resolution: event.target.value }))}>{(platform === 'h5' ? ['390x844', '500x877'] : ['1366x768', '1440x900', '1920x1080']).map(value => <option key={value}>{value}</option>)}</select>
            <small>{xianxia ? '幻境視窗大小。太小會讓術式點不到畫面外之物。' : '瀏覽器視窗大小。太小的話畫面外的東西點不到，PC 版尤其明顯。'}</small></label>
          <label>{xianxia ? '陣眼失守時' : '失敗處理'}<select className="uat-field" value={runConfig.failureMode} onChange={event => setRunConfig(value => ({ ...value, failureMode: event.target.value }))}><option value="continue">{xianxia ? '續行推演' : '繼續執行'}</option><option value="stop">{xianxia ? '立即收陣' : '立即停止'}</option></select>
            <small>{xianxia ? '某一術式失守時，是續行其餘、還是當下收陣。' : '某一步失敗時：「繼續執行」會把剩下的步驟跑完（看得到後面還有沒有問題），「立即停止」則當場中斷。'}</small></label>
          <label className="uat-check"><input type="checkbox" checked={runConfig.headed} onChange={event => setRunConfig(value => ({ ...value, headed: event.target.checked }))} />{xianxia ? '顯現幻境視窗' : '顯示瀏覽器視窗'}
            <small>{xianxia ? '看得到幻境推演過程；不開則在背景推演，較快。' : '看得到瀏覽器實際在做什麼（查問題用）；不開就在背景跑，比較快。'}</small></label>
          <label className="uat-check"><input type="checkbox" checked={isPublic} onChange={event => { setIsPublic(event.target.checked); setDirty(true) }} />{xianxia ? '允許同門啟用此玉簡' : '允許其他使用者執行此腳本'}
            <small>{xianxia ? '關閉後僅你自己看得到、跑得動。' : '關掉之後只有你看得到這份腳本（清單的「我的／公開」就是在分這個）。'}</small></label>

          {/* ── Lark TC 綁定 ─────────────────────────────────────── */}
          <label id="uat-focus-lark">{xianxia ? '玉牒路徑' : 'Lark TC 路徑'}
            <small>{xianxia ? '綁定後推演完會依試煉分判並回填；不綁亦可推演，只是不回填。' : '綁了之後跑完會依 TC 分別判定、上傳截圖、回寫 Lark。不綁也能跑，只是不回寫。'}</small>
            <textarea className="uat-field" rows={2} value={larkUrl}
              onChange={event => { setLarkUrl(event.target.value); setDirty(true) }}
              onBlur={event => void loadTcPool(event.target.value)}
              placeholder="https://xxx.larksuite.com/base/...?table=..." />
          </label>
          {/* ⚠️ 拆不出 table= 要當場講。不講的話存得下去、跑起來才被擋 */}
          {larkUrl.trim() && !tableIdFromUrl(larkUrl) && (
            <p className="uat-hint" style={{ color: 'var(--uat-danger)' }}>這個網址看不出是哪一張表（少了 <code>?table=tblXXXX</code>），存了也回寫不了。</p>
          )}
          <button type="button" className="uat-btn is-quiet" disabled={tcLoading || !larkUrl.trim()} onClick={() => void loadTcPool(larkUrl)}>
            {tcLoading ? (xianxia ? '參閱玉牒中…' : '載入中…') : (xianxia ? '掃描玉牒' : '掃描 Lark TC')}
          </button>
          {tcError && <p className="uat-hint" style={{ color: 'var(--uat-danger)' }}>{xianxia ? '參閱玉牒失敗' : '讀不到這張表的 TC'}：{tcError}</p>}
          {!!tcPool.length && (
            <div className="uat-tc-pool">
              {tcPool.map(tc => {
                const picked = bindings.some(item => item.recordId === tc.recordId)
                return (
                  <label className={`uat-tc-row${picked ? ' is-picked' : ''}`} key={tc.recordId}>
                    <input type="checkbox" checked={picked} onChange={() => toggleBinding(tc)} />
                    <strong>{tc.number || tc.recordId}</strong><span>{tc.text}</span>
                  </label>
                )
              })}
            </div>
          )}
          {bindings.filter(b => tcPool.length && !tcPool.some(tc => tc.recordId === b.recordId)).map(b => (
            <p className="uat-hint" style={{ color: 'var(--uat-danger)' }} key={b.recordId}>綁著「{b.number || b.recordId}」，但這張表現在找不到它——可能被刪了，或網址換過。</p>
          ))}
          <div className="uat-tc-summary"><strong>{bindings.length}</strong> {xianxia ? '道歸屬試煉' : '個 Lark TC'}</div>
          <button type="button" className="uat-btn is-quiet" onClick={() => setPanel('assets')}>{copy.assets}（{baselines.length + templates.length + ocrRegions.length}）</button>
          <button type="button" className="uat-btn is-quiet" onClick={() => setPanel('history')}>{copy.history}（{runs.length}）</button>
        </div>
        <div className={`uat-run-status${running || queueBusy ? ' is-running' : ''}`}><i />{running || queueBusy ? (xianxia ? '推演中' : '執行中') : (xianxia ? '玉簡未啟' : '待機')}</div>
      </aside>

      {/* ⚠️ 彈框一律走 createPortal 掛 document.body：這個版面的祖先有 backdrop-filter／
          transform，position: fixed 會被困在容器裡裁掉（這個 repo 踩過好幾次）。 */}
      {editorOpen && createPortal(
        <div className="modal-overlay" onClick={() => setEditorOpen(false)}>
          <div className="modal uat-editor-modal" onClick={event => event.stopPropagation()}>
            <div className="uat-section-title">
              <span>{xianxia ? 'ARRAY COMPOSER' : 'WORKFLOW EDITOR'}</span>
              <h3>{name || (xianxia ? '未題名玉簡' : '未命名腳本')}</h3>
              <button type="button" className="uat-btn is-quiet" onClick={() => setEditorOpen(false)}>{xianxia ? '收起' : '關閉'}</button>
            </div>
            <BlockEditor
              steps={steps} snippets={snippets} baselines={baselines} bindings={bindings}
              selectedId={selectedStepId} onSelectedIdChange={setSelectedStepId}
              onChange={next => { setSteps(next); setDirty(true) }} themeMode={themeMode}
            />
          </div>
        </div>,
        document.body,
      )}

      {panel && createPortal(
        <div className="modal-overlay" onClick={() => setPanel('')}>
          <div className="modal uat-editor-modal" onClick={event => event.stopPropagation()}>
            <div className="uat-section-title">
              <span>{panel === 'assets' ? 'VISUAL ASSETS' : 'RUN HISTORY'}</span>
              <h3>{panel === 'assets' ? copy.assets : copy.history}</h3>
              <button type="button" className="uat-btn is-quiet" onClick={() => setPanel('')}>{xianxia ? '收起' : '關閉'}</button>
            </div>
            <div className="uat-modal-body">
              {panel === 'assets' ? (
                <div className="uat-assets-grid">
                  <AssetSection title={xianxia ? '玉簡基準靈影' : '腳本基準圖'} count={baselines.length} uploadLabel={xianxia ? '納入基準靈影' : '上傳基準圖'} onUpload={uploadBaseline} xianxia={xianxia}>
                    {baselines.map(item => <AssetCard key={item.id} name={item.name} image={item.image_path} meta={`${xianxia ? '偏移界線' : '門檻'} ${item.threshold ?? 0.08}`} onDelete={() => removeAsset('baselines', item.id)} deleteLabel={xianxia ? '撤去' : '刪除'} />)}
                  </AssetSection>
                  <AssetSection title={xianxia ? 'PC 靈影藏庫' : 'PC 模板圖庫'} count={templates.length} uploadLabel={xianxia ? '納入靈影' : '上傳模板'} onUpload={uploadTemplate} xianxia={xianxia}>
                    {templates.map(item => <AssetCard key={item.id} name={item.name} image={item.image_path} meta={item.last_confidence == null ? (xianxia ? '尚未照驗' : '尚未比對') : `${xianxia ? '靈契' : '信心'} ${Math.round(item.last_confidence * 100)}%`} onDelete={() => removeAsset('templates', item.id)} deleteLabel={xianxia ? '撤去' : '刪除'} />)}
                  </AssetSection>
                  <section className="uat-panel uat-asset-section uat-inscribed-panel">
                    <div className="uat-section-title"><span>OCR SPIRIT SCRIPT</span><h3>{xianxia ? '靈文辨識區' : '辨識區域'} <small>{ocrRegions.length}</small></h3></div>
                    <button type="button" className="uat-btn is-quiet" onClick={addOcr}>{xianxia ? '新立靈文區' : '新增 OCR 區域'}</button>
                    <div className="uat-ocr-list">{ocrRegions.map(item => <div key={item.id}><span><strong>{item.name}</strong><small>{item.crop_x}, {item.crop_y} · {item.crop_w} × {item.crop_h}</small></span><button type="button" onClick={() => removeAsset('ocr-regions', item.id)}>{xianxia ? '撤去' : '刪除'}</button></div>)}</div>
                  </section>
                </div>
              ) : (
                <div className="uat-history-table">
                  <div className="is-head"><span>{xianxia ? '命燈' : '結果'}</span><span>{xianxia ? '玉簡' : '腳本'}</span><span>{xianxia ? '推演統計' : '統計'}</span><span>{xianxia ? '天時' : '時間'}</span></div>
                  {runs.map(run => <div key={run.id}><span><i className={`uat-result-dot is-${run.result}`} />{run.result}</span><span>{scripts.find(script => script.id === run.script_id)?.name ?? run.script_id}</span><span>{run.passed ?? 0} / {run.failed ?? 0} / {run.skipped ?? 0}</span><span>{run.started_at ? new Date(run.started_at).toLocaleString('zh-TW') : '—'}</span></div>)}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function AssetSection({ title, count, uploadLabel, onUpload, children, xianxia }: { title: string; count: number; uploadLabel: string; onUpload: (file?: File) => void; children: React.ReactNode; xianxia: boolean }) {
  return <section className="uat-panel uat-asset-section uat-inscribed-panel"><div className="uat-section-title"><span>{xianxia ? 'SPIRIT IMAGES' : 'VISUAL ASSETS'}</span><h3>{title} <small>{count}</small></h3></div><label className="uat-btn is-quiet uat-upload">{uploadLabel}<input type="file" accept="image/*" onChange={event => onUpload(event.target.files?.[0])} /></label><div className="uat-asset-list">{children}</div></section>
}

function AssetCard({ name, image, meta, onDelete, deleteLabel }: { name: string; image: string; meta: string; onDelete: () => void; deleteLabel: string }) {
  return <article className="uat-asset-card"><img src={image} alt="" /><span><strong>{name}</strong><small>{meta}</small></span><button type="button" onClick={onDelete}>{deleteLabel}</button></article>
}

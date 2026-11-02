import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageActions } from '../redesign/PageActions'
import type { AccountInfo } from '../accountTypes'
import { type UrlPoolEntry } from '../data/urlPoolData'
import { POOL_SOURCE, POOL_LABEL, POOL_ENVS, type PoolEnv } from '../data/urlPoolEnv'

interface MachineProfile {
  machineType: string
  entryTouchPoints?: string[] | null
  entryTouchPoints2?: string[] | null
  touchPoints?: string[] | null
  bonusAction?: string | null
  spinSelector?: string | null
  exitSelector?: string | null
}

type RunState = 'idle' | 'running' | 'done' | 'stopped' | 'error'

type AccountState =
  | 'pending'
  | 'opening'
  | 'entering'
  | 'spinning'
  | 'exiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'stopped'

interface AccountStatus {
  account: string
  username: string
  label: string
  state: AccountState
  targetMachineCode: string
  spinTarget?: number
  spinDone: number
  exitAttempts: number
  message: string
  startedAt?: number
  finishedAt?: number
}

interface ScriptedBetEvent {
  type: 'session_start' | 'account_update' | 'log' | 'session_done' | 'error'
  sessionId: string
  account?: string
  status?: AccountState | 'info'
  message: string
  statuses?: AccountStatus[]
  ts: string
}

interface CurrentSession {
  sessionId: string
  runState: RunState
  statuses: AccountStatus[]
  events: ScriptedBetEvent[]
  config?: Partial<ScriptedBetSettings>
}

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

interface Props {
  currentAccount: AccountInfo | null
}

interface ScriptedBetSettings {
  targetMachineCode: string
  spinMin: number
  spinMax: number
  spinDelayMinMs: number
  spinDelayMaxMs: number
  maxExitRetries: number
  headedMode: boolean
}

const SCRIPTED_BET_SETTINGS_KEY = 'toppath.scriptedBet.settings'

const DEFAULT_SCRIPTED_BET_SETTINGS: ScriptedBetSettings = {
  targetMachineCode: '873-JJBX-001',
  spinMin: 3,
  spinMax: 8,
  spinDelayMinMs: 800,
  spinDelayMaxMs: 1500,
  maxExitRetries: 5,
  headedMode: true,
}

function loadScriptedBetSettings(): ScriptedBetSettings {
  try {
    const raw = window.localStorage.getItem(SCRIPTED_BET_SETTINGS_KEY)
    if (!raw) return DEFAULT_SCRIPTED_BET_SETTINGS
    const parsed = JSON.parse(raw) as Partial<ScriptedBetSettings>
    return { ...DEFAULT_SCRIPTED_BET_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_SCRIPTED_BET_SETTINGS
  }
}

function saveScriptedBetSettings(settings: ScriptedBetSettings) {
  try {
    window.localStorage.setItem(SCRIPTED_BET_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage failures so the runner form remains usable in restricted browsers.
  }
}

const stateLabel: Record<AccountState, string> = {
  pending: 'Pending',
  opening: 'Opening',
  entering: 'Entering',
  spinning: 'Spinning',
  exiting: 'Exiting',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  stopped: 'Stopped',
}

function statusBadgeClass(state: AccountState) {
  if (state === 'done') return 'badge badge--ok'
  if (state === 'failed' || state === 'skipped') return 'badge badge--error'
  if (state === 'stopped') return 'badge badge--warn'
  if (state === 'opening' || state === 'entering' || state === 'spinning' || state === 'exiting') return 'badge badge--blue'
  return 'badge'
}

function ScriptMetric({ label, value, sub, tone }: { label: string; value: string | number; sub: string; tone?: 'run' | 'pass' | 'warn' | 'fail' }) {
  return (
    <div className={`rn-stat${tone ? ` rn-stat--${tone}` : ''}`}>
      <div className="rn-stat-k">{label}</div>
      <div className="rn-stat-v">{value}</div>
      <div className="rn-stat-s">{sub}</div>
    </div>
  )
}

/** 原型的橫向步驟條：active＝目前這一步；排在第一個 active 之前的步驟視為已走過（只從現有狀態推，不另外算進度） */
function FlowStep({ n, name, note, active, done }: { n: number; name: string; note: string; active?: boolean; done?: boolean }) {
  return (
    <div className={`rn-stp${active ? ' cur' : done ? ' done' : ''}`}>
      <i>{done && !active ? '✓' : n}</i>
      <span className="rn-stp-name">{name}</span>
      <span className="rn-stp-note">{note}</span>
    </div>
  )
}

export function ScriptedBetPage({ currentAccount }: Props) {
  const initialSettings = loadScriptedBetSettings()
  /**
   * ⚠️ 這頁也吃帳號池。加 UAT 時如果只改彈窗，這裡會**默默停在只有 QAT**——
   *    跟今天已經發生兩次的「加了東西但漏掉某個讀取端」同一種。
   *    環境定義一律從 `urlPoolEnv` 拿，不要自己 import 兩個資料檔再組。
   */
  const [poolEnv, setPoolEnv] = useState<PoolEnv>('qat')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  // 跟著分頁重算；override 在這裡才套上（存成 state 的話切分頁不會更新）
  const rows: UrlPoolEntry[] = POOL_SOURCE[poolEnv].map(r => ({ ...r, url: overrides[r.account] ?? r.url }))
  // ⚠️ 只選有 URL 的當預設。UAT 有 27 筆沒有 URL（產 token 的腳本沒跑出來），
  //    預設勾進去會讓那幾台帶著空網址去跑。
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(POOL_SOURCE.qat.filter(r => r.url).slice(0, 20).map(r => r.account)))
  const [targetMachineCode, setTargetMachineCode] = useState(initialSettings.targetMachineCode)
  const [spinMin, setSpinMin] = useState(initialSettings.spinMin)
  const [spinMax, setSpinMax] = useState(initialSettings.spinMax)
  const [spinDelayMinMs, setSpinDelayMinMs] = useState(initialSettings.spinDelayMinMs)
  const [spinDelayMaxMs, setSpinDelayMaxMs] = useState(initialSettings.spinDelayMaxMs)
  const [maxExitRetries, setMaxExitRetries] = useState(initialSettings.maxExitRetries)
  const [headedMode, setHeadedMode] = useState(initialSettings.headedMode)
  const [matchedProfile, setMatchedProfile] = useState<MachineProfile | null>(null)
  const [allProfiles, setAllProfiles] = useState<MachineProfile[]>([])
  const [search, setSearch] = useState('')
  const [agents, setAgents] = useState<LocalAgentInfo[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [agentError, setAgentError] = useState('')
  const [runState, setRunState] = useState<RunState>('idle')
  const [sessionId, setSessionId] = useState('')
  const [statuses, setStatuses] = useState<AccountStatus[]>([])
  const [logs, setLogs] = useState<ScriptedBetEvent[]>([])
  const eventSourceRef = useRef<EventSource | null>(null)
  const runStateRef = useRef<RunState>('idle')

  useEffect(() => {
    runStateRef.current = runState
  }, [runState])

  useEffect(() => {
    saveScriptedBetSettings({
      targetMachineCode,
      spinMin,
      spinMax,
      spinDelayMinMs,
      spinDelayMaxMs,
      maxExitRetries,
      headedMode,
    })
  }, [targetMachineCode, spinMin, spinMax, spinDelayMinMs, spinDelayMaxMs, maxExitRetries, headedMode])

  // Load all machine profiles on mount
  useEffect(() => {
    fetch('/api/machine-test/profiles')
      .then(r => r.json())
      .then((d: { ok: boolean; profiles?: MachineProfile[] }) => {
        if (d.ok && d.profiles) setAllProfiles(d.profiles)
      })
      .catch(() => {})
  }, [])

  // Auto-match profile when machine code or profiles change
  useEffect(() => {
    const parts = targetMachineCode.trim().split('-')
    const machineType = parts.find(p => /^[A-Z]+$/.test(p)) ?? ''
    const found = machineType ? allProfiles.find(p => p.machineType === machineType) ?? null : null
    setMatchedProfile(found)
  }, [targetMachineCode, allProfiles])

  const appendLog = useCallback((event: ScriptedBetEvent) => {
    setLogs(prev => {
      const key = `${event.ts}|${event.type}|${event.account ?? ''}|${event.message}`
      if (prev.some(log => `${log.ts}|${log.type}|${log.account ?? ''}|${log.message}` === key)) return prev
      return [...prev.slice(-120), event]
    })
  }, [])

  const applyEvent = useCallback((event: ScriptedBetEvent, source?: EventSource) => {
    if (event.statuses) setStatuses(event.statuses)
    appendLog(event)
    if (event.type === 'session_done') {
      setRunState(event.status === 'stopped' ? 'stopped' : 'done')
      source?.close()
    }
    if (event.type === 'error') {
      setRunState('error')
      source?.close()
    }
  }, [appendLog])

  const connectSession = useCallback((nextSessionId: string) => {
    eventSourceRef.current?.close()
    const es = new EventSource(`/api/scripted-bet/events/${nextSessionId}`)
    eventSourceRef.current = es
    es.onmessage = event => {
      try {
        applyEvent(JSON.parse(event.data) as ScriptedBetEvent, es)
      } catch {
        // ignore malformed SSE event
      }
    }
    es.onerror = () => {
      if (runStateRef.current === 'running') {
        appendLog({
          type: 'error',
          sessionId: nextSessionId,
          message: 'SSE 連線中斷',
          ts: new Date().toISOString(),
        })
      }
    }
  }, [appendLog, applyEvent])

  useEffect(() => {
    fetch('/api/url-pool/overrides')
      .then(r => r.json())
      .then((overrides: Record<string, string>) => {
        setOverrides(overrides)
      })
      .catch(() => {})
  }, [])

  const refreshAgents = useCallback(() => {
    fetch('/api/scripted-bet/agents')
      .then(r => r.json())
      .then((data: { ok: boolean; agents?: LocalAgentInfo[] }) => {
        if (!data.ok) return
        const nextAgents = data.agents ?? []
        setAgents(nextAgents)
        setAgentError('')
        setSelectedAgentId(current => {
          if (current && nextAgents.some(agent => agent.agentId === current && !agent.busy)) return current
          return nextAgents.find(agent => !agent.busy)?.agentId ?? nextAgents[0]?.agentId ?? ''
        })
      })
      .catch(() => setAgentError('無法取得本機 Agent 狀態'))
  }, [])

  useEffect(() => {
    refreshAgents()
    const timer = window.setInterval(refreshAgents, 5000)
    return () => window.clearInterval(timer)
  }, [refreshAgents])

  useEffect(() => {
    let cancelled = false
    fetch('/api/scripted-bet/current')
      .then(r => r.json())
      .then((data: { ok: boolean; session: CurrentSession | null }) => {
        if (cancelled || !data.ok || !data.session) return
        const session = data.session
        setSessionId(session.sessionId)
        setStatuses(session.statuses ?? [])
        setLogs(session.events ?? [])
        setRunState(session.runState)
        const restoredTarget = session.config?.targetMachineCode || session.statuses?.find(row => row.targetMachineCode)?.targetMachineCode
        if (restoredTarget) setTargetMachineCode(restoredTarget)
        if (session.runState === 'running') connectSession(session.sessionId)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      eventSourceRef.current?.close()
    }
  }, [connectSession])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(row =>
      row.account.includes(q) ||
      row.username.toLowerCase().includes(q) ||
      row.label.toLowerCase().includes(q) ||
      row.url.toLowerCase().includes(q)
    )
  }, [rows, search])

  const selectedRows = useMemo(() => rows.filter(row => selected.has(row.account)), [rows, selected])
  const doneCount = statuses.filter(s => s.state === 'done').length
  const failedCount = statuses.filter(s => s.state === 'failed' || s.state === 'skipped').length
  const runningStatus = statuses.find(s => ['opening', 'entering', 'spinning', 'exiting'].includes(s.state))
  const restoredTargetMachineCode = statuses.find(s => s.targetMachineCode)?.targetMachineCode
  const flowTargetMachineCode = runningStatus?.targetMachineCode || restoredTargetMachineCode || targetMachineCode

  function toggle(account: string) {
    if (runState === 'running') return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(account)) next.delete(account)
      else next.add(account)
      return next
    })
  }

  function selectVisible() {
    setSelected(prev => {
      const next = new Set(prev)
      filteredRows.forEach(row => next.add(row.account))
      return next
    })
  }

  function clearVisible() {
    setSelected(prev => {
      const next = new Set(prev)
      filteredRows.forEach(row => next.delete(row.account))
      return next
    })
  }

  async function start() {
    const selectedAgent = agents.find(agent => agent.agentId === selectedAgentId)
    if (!selectedAgent) {
      alert('請先啟動你的 Toppath Local Agent，再開始投注腳本。')
      refreshAgents()
      return
    }
    if (selectedAgent.busy) {
      alert('選擇的 Toppath Local Agent 正在執行其他任務，請選擇空閒 Agent 或稍後再試。')
      refreshAgents()
      return
    }
    if (!targetMachineCode.trim()) {
      alert('請輸入目標 gmid / 機台代碼')
      return
    }
    if (selectedRows.length === 0) {
      alert('請至少選擇一個帳號')
      return
    }

    eventSourceRef.current?.close()
    setLogs([])
    setRunState('running')

    try {
      const res = await fetch('/api/scripted-bet/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accounts: selectedRows.map(row => ({
            account: row.account,
            username: row.username,
            label: row.label,
            url: row.url,
          })),
          agentId: selectedAgent.agentId,
          targetMachineCode: targetMachineCode.trim(),
          spinMin: Number(spinMin),
          spinMax: Number(spinMax),
          spinDelayMinMs: Number(spinDelayMinMs),
          spinDelayMaxMs: Number(spinDelayMaxMs),
          maxExitRetries: Number(maxExitRetries),
          headedMode,
          operator: currentAccount?.label ?? '',
        }),
      })
      const data = await res.json() as { ok: boolean; sessionId?: string; statuses?: AccountStatus[]; message?: string }
      if (!res.ok || !data.ok || !data.sessionId) {
        const friendly = res.status === 409
          ? '找不到可用的本機 Agent。請確認 Toppath Local Agent 已啟動，且不是正在執行其他任務。'
          : data.message
        throw new Error(friendly ?? '啟動失敗')
      }
      setSessionId(data.sessionId)
      setStatuses(data.statuses ?? [])
      connectSession(data.sessionId)
    } catch (error) {
      setRunState('error')
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  async function stop() {
    if (!sessionId) return
    await fetch(`/api/scripted-bet/stop/${sessionId}`, { method: 'POST' }).catch(() => {})
    eventSourceRef.current?.close()
    setRunState('stopped')
    appendLog({
      type: 'session_done',
      sessionId,
      status: 'stopped',
      message: '已送出立即停止，正在關閉目前瀏覽器',
      ts: new Date().toISOString(),
    })
    setStatuses(prev => prev.map(row => (
      ['opening', 'entering', 'spinning', 'exiting', 'pending'].includes(row.state)
        ? { ...row, state: 'stopped', finishedAt: Date.now(), message: row.state === 'pending' ? '已停止，未執行' : '立即停止，瀏覽器已關閉' }
        : row
    )))
  }

  const currentStep = runningStatus?.state
  const selectedAgent = agents.find(agent => agent.agentId === selectedAgentId)
  const readyAgentCount = agents.filter(agent => !agent.busy).length
  const flowSteps = [
    { name: '領取帳號', note: runningStatus?.username ?? '等待開始', active: currentStep === 'opening' },
    { name: '進入大廳', note: '等待可操作', active: currentStep === 'opening' },
    { name: '進入機台', note: flowTargetMachineCode || '-', active: currentStep === 'entering' },
    { name: '隨機 Spin', note: runningStatus?.spinTarget ? `目標 ${runningStatus.spinTarget} 次` : '每帳號抽一次', active: currentStep === 'spinning' },
    { name: '退出機台', note: '失敗則補 Spin', active: currentStep === 'exiting' },
    { name: '關閉視窗', note: '換下一帳號', active: runningStatus?.state === 'done' },
  ]
  const firstActiveStep = flowSteps.findIndex(step => step.active)
  const formDisabled = runState === 'running'

  return (
    <div className="scripted-bet-page rn-page">
      <div className="scripted-bet-head">
        <div>
          <h1 className="scripted-bet-title">腳本化投注紀錄</h1>
          <p className="scripted-bet-sub">依序領取 URL 帳號，進入指定機台並執行隨機 Spin，退出成功後關閉視窗並換下一個帳號。</p>
        </div>
        <PageActions className="scripted-bet-actions">
          <button className="btn-ghost rn-btn" type="button" disabled={runState === 'running'} onClick={selectVisible}>全選目前清單</button>
          <button className="btn-ghost rn-btn" type="button" disabled={runState === 'running'} onClick={clearVisible}>清除目前清單</button>
          {runState === 'running'
            ? <button className="submit-btn submit-btn--sm scripted-stop-btn rn-btn" type="button" onClick={stop}>停止</button>
            : <button className="submit-btn submit-btn--sm rn-btn" type="button" onClick={start}>開始測試</button>}
        </PageActions>
      </div>

      <div className="rn-stats">
        <ScriptMetric label="Account Pool" value={rows.length} sub="URL 帳號表已載入" />
        <ScriptMetric label="Selected" value={selectedRows.length} sub="本次會執行" tone="run" />
        <ScriptMetric label="Progress" value={`${doneCount} / ${statuses.length || selectedRows.length}`} sub={runningStatus ? `目前 ${runningStatus.username}` : '尚未開始'} tone="pass" />
        <ScriptMetric label="Session State" value={runState.toUpperCase()} sub={failedCount > 0 ? `${failedCount} 筆失敗/略過` : '可手動停止'} tone={runState === 'running' ? 'run' : runState === 'done' ? 'pass' : undefined} />
      </div>

      <div className="rn-grid2">
        <section className="section-card">
          <h2 className="section-title">執行設定</h2>
          <div className="rn-form">
            <label className="rn-l" htmlFor="sb-agent">執行裝置</label>
            <div className="rn-inline">
              <select
                id="sb-agent"
                className="rn-field rn-grow"
                value={selectedAgentId}
                disabled={runState === 'running' || agents.length === 0}
                onChange={e => setSelectedAgentId(e.target.value)}
              >
                {agents.length === 0 && <option value="">No local agent</option>}
                {agents.map(agent => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.hostname}{agent.busy ? ' - busy' : ' - ready'}
                  </option>
                ))}
              </select>
              <button className="btn-ghost rn-btn" type="button" onClick={refreshAgents} disabled={runState === 'running'}>重新整理</button>
            </div>
            <div className="rn-c2 rn-inline rn-agent-line">
              <span className={selectedAgent && !selectedAgent.busy ? 'badge badge--ok' : 'badge badge--warn'}>Local Agent</span>
              <span className="rn-text-fg">{selectedAgent ? selectedAgent.hostname : '未連線'}</span>
              <span className="rn-hint">
                {selectedAgent
                  ? selectedAgent.busy ? '執行中' : `可用，${readyAgentCount} 台空閒`
                  : '請先啟動 Toppath Local Agent'}
              </span>
              {agentError && <span className="scripted-agent-error">{agentError}</span>}
            </div>

            <label className="rn-l" htmlFor="sb-source">帳號來源</label>
            <div className="rn-inline">
              <select id="sb-source" className="rn-field rn-grow" value="url-pool" disabled>
                <option value="url-pool">URL 帳號池</option>
              </select>
            </div>

            <label className="rn-l" htmlFor="sb-target">目標 gmid / 機台代碼</label>
            <div className="rn-inline">
              <input id="sb-target" className="rn-field rn-grow" value={targetMachineCode} onChange={e => setTargetMachineCode(e.target.value)} disabled={formDisabled} placeholder="873-JJBX-001" />
            </div>

            <label className="rn-l" htmlFor="sb-spin-min">Spin 次數</label>
            <div className="rn-inline rn-range">
              <input id="sb-spin-min" className="rn-field" aria-label="Spin 最小次數" type="number" min={1} value={spinMin} onChange={e => setSpinMin(Number(e.target.value))} disabled={formDisabled} />
              <span className="rn-tilde">～</span>
              <input className="rn-field" aria-label="Spin 最大次數" type="number" min={1} value={spinMax} onChange={e => setSpinMax(Number(e.target.value))} disabled={formDisabled} />
            </div>

            <label className="rn-l" htmlFor="sb-delay-min">Spin 間隔 ms</label>
            <div className="rn-inline rn-range">
              <input id="sb-delay-min" className="rn-field" aria-label="Spin 間隔最小 ms" type="number" min={0} value={spinDelayMinMs} onChange={e => setSpinDelayMinMs(Number(e.target.value))} disabled={formDisabled} />
              <span className="rn-tilde">～</span>
              <input className="rn-field" aria-label="Spin 間隔最大 ms" type="number" min={0} value={spinDelayMaxMs} onChange={e => setSpinDelayMaxMs(Number(e.target.value))} disabled={formDisabled} />
            </div>

            <label className="rn-l" htmlFor="sb-exit">退出重試上限</label>
            <div className="rn-inline">
              <input id="sb-exit" className="rn-field rn-grow" type="number" min={1} value={maxExitRetries} onChange={e => setMaxExitRetries(Number(e.target.value))} disabled={formDisabled} />
              <span className="rn-hint">退出失敗會補 Spin，再嘗試退出</span>
            </div>

            <span className="rn-l">瀏覽器模式</span>
            <div className="rn-inline">
              <label className="rn-chk">
                <input type="checkbox" checked={headedMode} onChange={e => setHeadedMode(e.target.checked)} disabled={formDisabled} />
                <span>Headed 模式顯示瀏覽器視窗</span>
              </label>
            </div>

            <span className="rn-l rn-l--top">機台配置</span>
            <div>
              {matchedProfile ? (
                <div className="rn-profile">
                  <span className="rn-profile-name">{matchedProfile.machineType}</span>
                  {matchedProfile.entryTouchPoints?.length ? <span>進入觸屏：{matchedProfile.entryTouchPoints.join(', ')}</span> : null}
                  {matchedProfile.entryTouchPoints2?.length ? <span>進入確認：{matchedProfile.entryTouchPoints2.join(', ')}</span> : null}
                  {matchedProfile.touchPoints?.length ? <span>退出補救 touchPoints：{matchedProfile.touchPoints.join(', ')}</span> : null}
                  {matchedProfile.bonusAction ? <span>特殊遊戲處理：{matchedProfile.bonusAction}</span> : null}
                  {matchedProfile.spinSelector ? <span>Spin selector：{matchedProfile.spinSelector}</span> : null}
                </div>
              ) : (
                <div className="rn-profile rn-profile--none">
                  未找到配置（機台代碼中段需為全大寫字母，如 JJBX）
                </div>
              )}
              <div className="rn-hint rn-hint--below">自動從 Machine Test 機台配置檔讀取進入觸屏、退出補救 touchPoints 等設定。</div>
            </div>
          </div>
          <div className="rn-inline rn-tags">
            <span className="rn-tag">序列執行</span>
            <span className="rn-tag">一帳號一視窗</span>
            <span className="rn-tag">退出成功才換帳號</span>
            <span className="rn-tag">停止後不再領新帳號</span>
          </div>
        </section>

        <section className="section-card rn-flow-panel">
          <h2 className="section-title">流程狀態</h2>
          <div className="rn-steps">
            {flowSteps.map((step, idx) => (
              <FlowStep key={step.name} n={idx + 1} name={step.name} note={step.note} active={step.active} done={firstActiveStep > 0 && idx < firstActiveStep} />
            ))}
          </div>
          <div className="rn-current">
            <div className="rn-current-top">
              <span>{runningStatus ? `${runningStatus.account} / ${runningStatus.username}` : '尚未執行'}</span>
              <span className="rn-mono">Spin {runningStatus?.spinDone ?? 0} / {runningStatus?.spinTarget ?? '?'}</span>
            </div>
            <div className="rn-meter rn-meter--run"><i style={{ width: runningStatus?.spinTarget ? `${Math.min(100, runningStatus.spinDone / runningStatus.spinTarget * 100)}%` : '0%' }} /></div>
          </div>
          <div className="scripted-console rn-log">
            {logs.length === 0 && <div><span className="scripted-log-time">--:--:--</span> 等待開始測試...</div>}
            {logs.slice(-12).map((log, idx) => {
              const time = new Date(log.ts).toTimeString().slice(0, 8)
              return (
                <div key={`${log.ts}-${idx}`}>
                  <span className="scripted-log-time">[{time}]</span>{' '}
                  <span className={log.type === 'error' ? 'scripted-log-error' : log.type === 'session_done' ? 'scripted-log-ok' : 'scripted-log-blue'}>{log.type}</span>{' '}
                  {log.account && <span className="scripted-log-account">{log.account}</span>} {log.message}
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <section className="section-card rn-table-panel">
        <h2 className="section-title">帳號執行清單</h2>
        <div className="rn-toolbar">
          {/* ⚠️ 環境分頁。跟 URL 帳號池頁與帳號池選取彈窗同一套心智模型。
              執行中不給切——切了會換掉整份清單，但勾選的帳號還是舊環境的。 */}
          <div className="rn-tabs" role="tablist">
            {POOL_ENVS.map(e => (
              <button
                key={e} type="button" data-testid={`scripted-env-${e}`}
                className="rn-tab"
                role="tab"
                aria-selected={poolEnv === e}
                disabled={runState === 'running'}
                onClick={() => { setPoolEnv(e); setSelected(new Set()) }}
              >
                {POOL_LABEL[e]}
                <span className="rn-tab-count">
                  {POOL_SOURCE[e].filter(r => r.url).length}
                </span>
              </button>
            ))}
          </div>
          <span className="rn-spacer" />
          <input className="rn-field rn-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋帳號 / username / label / url..." disabled={runState === 'running'} />
        </div>
        <div className="table-wrap rn-table-wrap">
          <table className="version-table scripted-table rn-table">
            <thead>
              <tr>
                <th>帳號</th>
                <th>狀態</th>
                <th>目標機台</th>
                <th>Spin</th>
                <th>退出</th>
                <th>最後訊息</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(row => {
                const status = statuses.find(s => s.account === row.account)
                const state = status?.state ?? (selected.has(row.account) ? 'pending' : 'skipped')
                const spinTarget = status?.spinTarget ?? '?'
                const spinDone = status?.spinDone ?? 0
                const progress = typeof spinTarget === 'number' && spinTarget > 0 ? Math.min(100, spinDone / spinTarget * 100) : 0
                return (
                  <tr key={row.account}>
                    <td>
                      <span className="rn-account">
                        <button type="button" className={`scripted-check ${selected.has(row.account) ? 'on' : ''}`} onClick={() => toggle(row.account)} disabled={runState === 'running'} aria-label="toggle account" />
                        <span className="scripted-account-cell">
                          <strong>{row.account}</strong>
                          <span>{row.username}</span>
                        </span>
                      </span>
                    </td>
                    <td><span className={statusBadgeClass(state)}>{stateLabel[state]}</span></td>
                    <td><span className="rn-mono">{status?.targetMachineCode || targetMachineCode || '-'}</span></td>
                    <td>
                      <div className="rn-spin">
                        <span className="rn-mono">{spinDone} / {spinTarget}</span>
                        <div className="rn-meter rn-meter--run"><i style={{ width: `${progress}%` }} /></div>
                      </div>
                    </td>
                    <td><span className={status?.exitAttempts ? 'rn-tag rn-tag--warn' : 'rn-tag'}>{status?.exitAttempts ?? 0}</span></td>
                    <td className="rn-msg">{status?.message ?? (selected.has(row.account) ? '等待執行' : '未勾選，不納入本次批次')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

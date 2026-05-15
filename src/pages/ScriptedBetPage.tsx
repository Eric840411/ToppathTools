import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountInfo } from '../components/JiraAccountModal'
import { URL_POOL_DATA, type UrlPoolEntry } from '../data/urlPoolData'

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

function ScriptMetric({ label, value, sub, color }: { label: string; value: string | number; sub: string; color?: string }) {
  return (
    <div className="scripted-bet-metric">
      <div className="scripted-bet-metric-label">{label}</div>
      <div className="scripted-bet-metric-value" style={color ? { color } : undefined}>{value}</div>
      <div className="scripted-bet-metric-sub">{sub}</div>
    </div>
  )
}

function FlowStep({ n, name, note, active }: { n: number; name: string; note: string; active?: boolean }) {
  return (
    <div className={`scripted-flow-step ${active ? 'active' : ''}`}>
      <span className="scripted-flow-num">{n}</span>
      <div className="scripted-flow-name">{name}</div>
      <div className="scripted-flow-note">{note}</div>
    </div>
  )
}

export function ScriptedBetPage({ currentAccount }: Props) {
  const [rows, setRows] = useState<UrlPoolEntry[]>(() => URL_POOL_DATA.map(r => ({ ...r })))
  const [selected, setSelected] = useState<Set<string>>(() => new Set(URL_POOL_DATA.slice(0, 20).map(r => r.account)))
  const [targetMachineCode, setTargetMachineCode] = useState('873-JJBX-001')
  const [spinMin, setSpinMin] = useState(3)
  const [spinMax, setSpinMax] = useState(8)
  const [spinDelayMinMs, setSpinDelayMinMs] = useState(800)
  const [spinDelayMaxMs, setSpinDelayMaxMs] = useState(1500)
  const [maxExitRetries, setMaxExitRetries] = useState(5)
  const [exitFailTouchPointsInput, setExitFailTouchPointsInput] = useState('')
  const [headedMode, setHeadedMode] = useState(true)
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
        setRows(URL_POOL_DATA.map(r => ({ ...r, url: overrides[r.account] ?? r.url })))
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

  function parseExitFailTouchPoints(raw: string): string[] {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const parts = line.split(',').map(p => p.trim())
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`touchPoint 格式錯誤（第 ${i + 1} 行）：${line}`)
    }
    return lines
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
      const exitFailTouchPoints = parseExitFailTouchPoints(exitFailTouchPointsInput)
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
          exitFailTouchPoints,
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

  return (
    <div className="scripted-bet-page">
      <div className="scripted-bet-head">
        <div>
          <h1 className="scripted-bet-title">腳本化投注紀錄</h1>
          <p className="scripted-bet-sub">依序領取 URL 帳號，進入指定機台並執行隨機 Spin，退出成功後關閉視窗並換下一個帳號。</p>
        </div>
        <div className="scripted-bet-actions">
          <button className="btn-ghost" type="button" disabled={runState === 'running'} onClick={selectVisible}>全選目前清單</button>
          <button className="btn-ghost" type="button" disabled={runState === 'running'} onClick={clearVisible}>清除目前清單</button>
          {runState === 'running'
            ? <button className="submit-btn submit-btn--sm scripted-stop-btn" type="button" onClick={stop}>停止</button>
            : <button className="submit-btn submit-btn--sm" type="button" onClick={start}>開始測試</button>}
        </div>
      </div>

      <div className="scripted-bet-metrics">
        <ScriptMetric label="Account Pool" value={rows.length} sub="URL 帳號表已載入" />
        <ScriptMetric label="Selected" value={selectedRows.length} sub="本次會執行" />
        <ScriptMetric label="Progress" value={`${doneCount} / ${statuses.length || selectedRows.length}`} sub={runningStatus ? `目前 ${runningStatus.username}` : '尚未開始'} />
        <ScriptMetric label="Session State" value={runState.toUpperCase()} sub={failedCount > 0 ? `${failedCount} 筆失敗/略過` : '可手動停止'} color={runState === 'running' ? '#60a5fa' : runState === 'done' ? '#34d399' : undefined} />
      </div>

      <div className="two-col scripted-bet-main-grid">
        <section className="section-card">
          <h2 className="section-title">執行設定</h2>
          <div className="scripted-agent-panel">
            <div>
              <span className={selectedAgent && !selectedAgent.busy ? 'badge badge--ok' : 'badge badge--warn'}>Local Agent</span>
              <strong>{selectedAgent ? selectedAgent.hostname : '未連線'}</strong>
              <span className="field-hint">
                {selectedAgent
                  ? selectedAgent.busy ? '執行中' : `可用，${readyAgentCount} 台空閒`
                  : '請先啟動 Toppath Local Agent'}
              </span>
            </div>
            <label className="field scripted-agent-select">
              <span>執行裝置</span>
              <select
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
            </label>
            <button className="btn-ghost" type="button" onClick={refreshAgents} disabled={runState === 'running'}>重新整理</button>
            {agentError && <span className="scripted-agent-error">{agentError}</span>}
          </div>
          <div className="field-row">
            <label className="field">
              <span>帳號來源</span>
              <select value="url-pool" disabled>
                <option value="url-pool">URL 帳號池</option>
              </select>
              <span className="field-hint">讀取現有 UrlPoolData 與後台 URL override。</span>
            </label>
            <label className="field">
              <span>目標 gmid / 機台代碼</span>
              <input value={targetMachineCode} onChange={e => setTargetMachineCode(e.target.value)} disabled={runState === 'running'} placeholder="873-JJBX-001" />
              <span className="field-hint">使用可進入機器投注的機台代碼。</span>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Spin 最小次數</span>
              <input type="number" min={1} value={spinMin} onChange={e => setSpinMin(Number(e.target.value))} disabled={runState === 'running'} />
            </label>
            <label className="field">
              <span>Spin 最大次數</span>
              <input type="number" min={1} value={spinMax} onChange={e => setSpinMax(Number(e.target.value))} disabled={runState === 'running'} />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Spin 間隔最小 ms</span>
              <input type="number" min={0} value={spinDelayMinMs} onChange={e => setSpinDelayMinMs(Number(e.target.value))} disabled={runState === 'running'} />
            </label>
            <label className="field">
              <span>Spin 間隔最大 ms</span>
              <input type="number" min={0} value={spinDelayMaxMs} onChange={e => setSpinDelayMaxMs(Number(e.target.value))} disabled={runState === 'running'} />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>退出重試上限</span>
              <input type="number" min={1} value={maxExitRetries} onChange={e => setMaxExitRetries(Number(e.target.value))} disabled={runState === 'running'} />
              <span className="field-hint">退出失敗會補 Spin，再嘗試退出。</span>
            </label>
            <label className="field scripted-checkbox-field">
              <span>瀏覽器模式</span>
              <label className="scripted-checkbox-row">
                <input type="checkbox" checked={headedMode} onChange={e => setHeadedMode(e.target.checked)} disabled={runState === 'running'} />
                <span>Headed 模式顯示瀏覽器視窗</span>
              </label>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>退出失敗 touchPoints</span>
              <textarea
                value={exitFailTouchPointsInput}
                onChange={e => setExitFailTouchPointsInput(e.target.value)}
                disabled={runState === 'running'}
                rows={3}
                placeholder={'3,2\n6,5'}
              />
              <span className="field-hint">每行一組 MachineTest touchPoint，例如 3,2。退出失敗時會依序點擊對應 span，然後補 Spin 重試。</span>
            </label>
          </div>
          <div className="op-plan scripted-plan">
            <span>本次策略</span>
            <span className="scripted-chip">序列執行</span>
            <span className="scripted-chip">一帳號一視窗</span>
            <span className="scripted-chip">退出成功才換帳號</span>
            <span className="scripted-chip">停止後不再領新帳號</span>
          </div>
        </section>

        <section className="section-card">
          <h2 className="section-title">流程狀態</h2>
          <div className="scripted-flow">
            <FlowStep n={1} name="領取帳號" note={runningStatus?.username ?? '等待開始'} active={currentStep === 'opening'} />
            <FlowStep n={2} name="進入大廳" note="等待可操作" active={currentStep === 'opening'} />
            <FlowStep n={3} name="進入機台" note={targetMachineCode || '-'} active={currentStep === 'entering'} />
            <FlowStep n={4} name="隨機 Spin" note={runningStatus?.spinTarget ? `目標 ${runningStatus.spinTarget} 次` : '每帳號抽一次'} active={currentStep === 'spinning'} />
            <FlowStep n={5} name="退出機台" note="失敗則補 Spin" active={currentStep === 'exiting'} />
            <FlowStep n={6} name="關閉視窗" note="換下一帳號" active={runningStatus?.state === 'done'} />
          </div>
          <div className="scripted-current-row">
            <div>
              <span className="badge badge--blue">Current Account</span>
              <span className="scripted-current-account">{runningStatus ? `${runningStatus.account} / ${runningStatus.username}` : '尚未執行'}</span>
            </div>
            <div className="scripted-progress">
              <span className="field-hint">Spin {runningStatus?.spinDone ?? 0} / {runningStatus?.spinTarget ?? '?'}</span>
              <div className="scripted-bar"><span style={{ width: runningStatus?.spinTarget ? `${Math.min(100, runningStatus.spinDone / runningStatus.spinTarget * 100)}%` : '0%' }} /></div>
            </div>
          </div>
          <div className="scripted-console">
            {logs.length === 0 && <div><span className="scripted-log-time">--:--:--</span> 等待開始測試...</div>}
            {logs.slice(-12).map((log, idx) => {
              const time = new Date(log.ts).toTimeString().slice(0, 8)
              return (
                <div key={`${log.ts}-${idx}`}>
                  <span className="scripted-log-time">{time}</span>{' '}
                  <span className={log.type === 'error' ? 'scripted-log-error' : log.type === 'session_done' ? 'scripted-log-ok' : 'scripted-log-blue'}>{log.type}</span>{' '}
                  {log.account && <span className="scripted-log-account">{log.account}</span>} {log.message}
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <section className="section-card">
        <div className="scripted-table-head">
          <h2 className="section-title" style={{ margin: 0 }}>帳號執行清單</h2>
          <label className="field scripted-search">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋帳號 / username / label / url..." disabled={runState === 'running'} />
          </label>
        </div>
        <div className="scripted-table-wrap">
          <table className="scripted-table">
            <thead>
              <tr>
                <th>帳號</th>
                <th>URL 標籤</th>
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
                      <button type="button" className={`scripted-check ${selected.has(row.account) ? 'on' : ''}`} onClick={() => toggle(row.account)} disabled={runState === 'running'} aria-label="toggle account" />
                      <span className="scripted-account-cell">
                        <strong>{row.account}</strong>
                        <span>{row.username}</span>
                      </span>
                    </td>
                    <td><code>{row.label}</code></td>
                    <td><span className={statusBadgeClass(state)}>{stateLabel[state]}</span></td>
                    <td><code>{targetMachineCode || '-'}</code></td>
                    <td>
                      <div className="scripted-progress">
                        <span>{spinDone} / {spinTarget}</span>
                        <div className="scripted-bar"><span style={{ width: `${progress}%` }} /></div>
                      </div>
                    </td>
                    <td><span className={status?.exitAttempts ? 'badge badge--warn' : 'badge'}>{status?.exitAttempts ?? 0}</span></td>
                    <td>{status?.message ?? (selected.has(row.account) ? '等待執行' : '未勾選，不納入本次批次')}</td>
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

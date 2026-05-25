import { useEffect, useMemo, useState } from 'react'

type DashboardSummary = {
  ok: boolean
  generatedAt: number
  limits: {
    users: number
    tasks: number
    events: number
  }
  totals: {
    onlineUsers: number
    activeSessions: number
    activeRequests: number
    requestsPerMinute: number
    errors15m: number
    runningTasks: number
    queuedTasks: number
  }
  requests: {
    averageMs: number
    p95Ms: number
  }
  server: {
    pid: number
    uptimeMs: number
    memory: {
      rss: number
      heapUsed: number
      heapTotal: number
      systemFree: number
      systemTotal: number
      rssText: string
      heapUsedText: string
      systemUsedText: string
      systemTotalText: string
    }
  }
  worker: {
    connected: boolean
    latencyMs: number
    message?: string
    worker?: {
      uptimeMs?: number
      memory?: {
        rss?: number
        heapUsed?: number
        heapTotal?: number
        systemFree?: number
        systemTotal?: number
      }
    }
    memoryText?: {
      rss: string
      heapUsed: string
      systemUsed: string
      systemTotal: string
    } | null
  }
  users: Array<{
    userKey: string
    userLabel: string
    role: string
    page: string
    ip: string
    lastSeenAt: number
  }>
  tasks: Array<{
    id: string
    user_label: string
    type: string
    label: string
    status: string
    created_at: number
    started_at: number | null
  }>
  events: Array<{
    id: string
    type: string
    title: string
    detail: string
    level: 'info' | 'warn' | 'error' | 'success'
    createdAt: number
  }>
}

function formatAgo(ts: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小時前`
}

function formatClock(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
}

function formatUptime(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

function pct(value: number, max: number) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)))
}

function initials(label: string) {
  const compact = label.trim()
  if (!compact) return 'U'
  const parts = compact.split(/\s+/)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return compact.slice(0, 2).toUpperCase()
}

function taskBadge(status: string) {
  if (status === 'running') return '執行中'
  if (status === 'queued') return '等待中'
  return status
}

function eventDotClass(level: string) {
  if (level === 'success') return ' dashboard-event-dot--success'
  if (level === 'warn') return ' dashboard-event-dot--warn'
  if (level === 'error') return ' dashboard-event-dot--error'
  return ''
}

export function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(Date.now())

  async function loadSummary() {
    try {
      const response = await fetch('/api/dashboard/summary')
      const data = await response.json() as DashboardSummary | { ok?: boolean; message?: string }
      if (!response.ok || !data.ok) throw new Error('message' in data ? data.message ?? '載入失敗' : '載入失敗')
      setSummary(data as DashboardSummary)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSummary()
    const refresh = window.setInterval(() => void loadSummary(), 30000)
    const ticker = window.setInterval(() => setTick(Date.now()), 1000)
    return () => {
      window.clearInterval(refresh)
      window.clearInterval(ticker)
    }
  }, [])

  const pressure = useMemo(() => {
    if (!summary) return { label: 'LOW', className: 'dashboard-chip--good' }
    if (summary.totals.errors15m > 0 || !summary.worker.connected) return { label: 'WATCH', className: 'dashboard-chip--warn' }
    if (summary.totals.activeRequests >= 8 || summary.requests.p95Ms >= 2000) return { label: 'HIGH', className: 'dashboard-chip--warn' }
    return { label: 'LOW', className: 'dashboard-chip--good' }
  }, [summary])

  if (loading && !summary) {
    return <div className="dashboard-page"><div className="dashboard-empty">正在載入監控資料...</div></div>
  }

  if (!summary) {
    return <div className="dashboard-page"><div className="dashboard-empty">監控資料載入失敗：{error}</div></div>
  }

  const serverMemPct = pct(summary.server.memory.rss, 800 * 1024 * 1024)
  const workerRss = summary.worker.worker?.memory?.rss ?? 0
  const workerMemPct = pct(workerRss, 700 * 1024 * 1024)
  const systemTotal = summary.server.memory.systemTotal
  const systemUsed = systemTotal - summary.server.memory.systemFree
  const systemMemPct = pct(systemUsed, systemTotal)
  const requestPct = Math.min(100, Math.round((summary.totals.requestsPerMinute / 300) * 100))
  const taskOverflow = Math.max(0, summary.totals.runningTasks + summary.totals.queuedTasks - summary.tasks.length)
  const userOverflow = Math.max(0, summary.totals.onlineUsers - summary.users.length)
  const eventOverflow = Math.max(0, 30 - summary.events.length)

  return (
    <div className="dashboard-page">
      <div className="dashboard-intro">
        <div>
          <h1>即時監控</h1>
          <p>登入後第一眼掌握目前使用人數、背景任務與服務壓力。</p>
        </div>
        <div className="dashboard-intro-meta">
          <span>自動更新：30 秒</span>
          <span>更新於 {formatClock(summary.generatedAt)}</span>
        </div>
      </div>

      {error && <div className="dashboard-alert">上次更新失敗：{error}</div>}

      <section className="dashboard-metrics">
        <article className="dashboard-metric">
          <div className="dashboard-metric-label">正在使用 <span className="dashboard-chip dashboard-chip--good">LIVE</span></div>
          <div className="dashboard-metric-value">{summary.totals.onlineUsers}<span>人</span></div>
          <div className="dashboard-metric-note">最近 60 秒內仍有 heartbeat 的使用者</div>
        </article>
        <article className="dashboard-metric">
          <div className="dashboard-metric-label">有效登入 <span className="dashboard-chip dashboard-chip--blue">SESSION</span></div>
          <div className="dashboard-metric-value">{summary.totals.activeSessions}<span>組</span></div>
          <div className="dashboard-metric-note">尚未過期的登入 session</div>
        </article>
        <article className="dashboard-metric">
          <div className="dashboard-metric-label">伺服器負載 <span className={`dashboard-chip ${pressure.className}`}>{pressure.label}</span></div>
          <div className="dashboard-metric-value">{summary.totals.activeRequests}<span>req</span></div>
          <div className="dashboard-metric-note">{summary.totals.requestsPerMinute} req/min，平均回應 {summary.requests.averageMs} ms</div>
        </article>
        <article className="dashboard-metric">
          <div className="dashboard-metric-label">記憶體佔用 <span className="dashboard-chip dashboard-chip--warn">WATCH</span></div>
          <div className="dashboard-metric-value">{summary.server.memory.rssText.replace(' MB', '')}<span>MB</span></div>
          <div className="dashboard-metric-note">Server RSS，目前低於 PM2 重啟門檻</div>
        </article>
      </section>

      <section className="dashboard-grid">
        <div>
          <article className="dashboard-panel">
            <div className="dashboard-panel-head">
              <div>
                <h2>即時使用者</h2>
                <p>最多顯示 {summary.limits.users} 位，依最後活動時間排序</p>
              </div>
              <span className="dashboard-chip">更新於 {formatClock(summary.generatedAt)}</span>
            </div>
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>使用者</th>
                  <th style={{ width: '22%' }}>目前頁面</th>
                  <th style={{ width: '18%' }}>IP</th>
                  <th style={{ width: '15%' }}>角色</th>
                  <th style={{ width: '15%' }}>最後活動</th>
                </tr>
              </thead>
              <tbody>
                {summary.users.map(user => (
                  <tr key={user.userKey}>
                    <td>
                      <div className="dashboard-user">
                        <span className="dashboard-avatar">{initials(user.userLabel)}</span>
                        <div>
                          <div className="dashboard-user-name">{user.userLabel}</div>
                          <div className="dashboard-user-key">{user.userKey}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className="dashboard-page-badge">{user.page}</span></td>
                    <td>{user.ip}</td>
                    <td><span className="dashboard-chip dashboard-chip--blue">{user.role}</span></td>
                    <td>{formatAgo(user.lastSeenAt, tick)}</td>
                  </tr>
                ))}
                {summary.users.length === 0 && (
                  <tr><td colSpan={5} className="dashboard-table-empty">目前沒有在線使用者</td></tr>
                )}
              </tbody>
            </table>
            <div className="dashboard-panel-foot">
              共 {summary.totals.onlineUsers} 位在線{userOverflow > 0 ? ` · 另有 ${userOverflow} 位未顯示` : ''}
            </div>
          </article>

          <article className="dashboard-panel dashboard-panel--spaced">
            <div className="dashboard-panel-head">
              <div>
                <h2>背景任務佇列</h2>
                <p>最多顯示 {summary.limits.tasks} 筆，優先顯示 running 與 queued</p>
              </div>
              <span className="dashboard-chip dashboard-chip--warn">{summary.totals.runningTasks} running / {summary.totals.queuedTasks} queued</span>
            </div>
            <div className="dashboard-panel-body">
              <div className="dashboard-task-list">
                {summary.tasks.map(task => (
                  <div className="dashboard-task" key={task.id}>
                    <div>
                      <div className="dashboard-task-title">{task.label}</div>
                      <div className="dashboard-task-meta">
                        {task.user_label} · {taskBadge(task.status)} · {task.started_at ? `已執行 ${formatAgo(task.started_at, tick)}` : `建立於 ${formatAgo(task.created_at, tick)}`}
                      </div>
                    </div>
                    <span className={`dashboard-chip ${task.status === 'running' ? 'dashboard-chip--warn' : ''}`}>{task.type}</span>
                  </div>
                ))}
                {summary.tasks.length === 0 && <div className="dashboard-empty dashboard-empty--compact">目前沒有背景任務</div>}
              </div>
            </div>
            <div className="dashboard-panel-foot">
              共 {summary.totals.runningTasks + summary.totals.queuedTasks} 筆活躍任務{taskOverflow > 0 ? ` · 另有 ${taskOverflow} 筆未顯示` : ''}
            </div>
          </article>
        </div>

        <aside>
          <article className="dashboard-panel">
            <div className="dashboard-panel-head">
              <div>
                <h2>資源使用量</h2>
                <p>Server 與 Worker 即時記憶體、請求與佇列壓力</p>
              </div>
            </div>
            <div className="dashboard-panel-body">
              <div className="dashboard-bars">
                <div className="dashboard-bar-row">
                  <div className="dashboard-bar-top"><span>Server RSS</span><b>{summary.server.memory.rssText} / 800 MB</b></div>
                  <div className="dashboard-bar-track"><span className="dashboard-bar-fill dashboard-bar-fill--green" style={{ width: `${serverMemPct}%` }} /></div>
                </div>
                <div className="dashboard-bar-row">
                  <div className="dashboard-bar-top"><span>Worker RSS</span><b>{summary.worker.memoryText?.rss ?? 'N/A'} / 700 MB</b></div>
                  <div className="dashboard-bar-track"><span className="dashboard-bar-fill dashboard-bar-fill--yellow" style={{ width: `${workerMemPct}%` }} /></div>
                </div>
                <div className="dashboard-bar-row">
                  <div className="dashboard-bar-top"><span>System Memory</span><b>{summary.server.memory.systemUsedText} / {summary.server.memory.systemTotalText}</b></div>
                  <div className="dashboard-bar-track"><span className="dashboard-bar-fill dashboard-bar-fill--indigo" style={{ width: `${systemMemPct}%` }} /></div>
                </div>
                <div className="dashboard-bar-row">
                  <div className="dashboard-bar-top"><span>Request Pressure</span><b>{summary.totals.requestsPerMinute} req/min</b></div>
                  <div className="dashboard-bar-track"><span className="dashboard-bar-fill" style={{ width: `${requestPct}%` }} /></div>
                </div>
              </div>
              <div className="dashboard-mini-grid">
                <div className="dashboard-mini-stat"><span>Server Uptime</span><b>{formatUptime(summary.server.uptimeMs)}</b></div>
                <div className="dashboard-mini-stat"><span>Worker Latency</span><b>{summary.worker.connected ? `${summary.worker.latencyMs} ms` : '離線'}</b></div>
                <div className="dashboard-mini-stat"><span>p95 Response</span><b>{summary.requests.p95Ms} ms</b></div>
                <div className="dashboard-mini-stat"><span>Errors / 15m</span><b>{summary.totals.errors15m}</b></div>
              </div>
            </div>
          </article>

          <article className="dashboard-panel dashboard-panel--spaced">
            <div className="dashboard-panel-head">
              <div>
                <h2>最近系統事件</h2>
                <p>最多顯示 {summary.limits.events} 筆登入、任務與 worker 狀態</p>
              </div>
            </div>
            <div className="dashboard-panel-body">
              <div className="dashboard-events">
                {summary.events.map(event => (
                  <div className="dashboard-event" key={event.id}>
                    <span className={`dashboard-event-dot${eventDotClass(event.level)}`} />
                    <div>
                      <div className="dashboard-event-title">{event.title}</div>
                      <div className="dashboard-event-detail">{event.detail}</div>
                    </div>
                    <time>{formatClock(event.createdAt)}</time>
                  </div>
                ))}
                {summary.events.length === 0 && <div className="dashboard-empty dashboard-empty--compact">目前沒有系統事件</div>}
              </div>
            </div>
            <div className="dashboard-panel-foot">
              顯示最近 {summary.events.length} 筆{eventOverflow > 0 ? ' · 完整事件紀錄保留於服務端記憶體' : ''}
            </div>
          </article>
        </aside>
      </section>
    </div>
  )
}

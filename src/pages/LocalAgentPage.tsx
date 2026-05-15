import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AccountInfo } from '../components/JiraAccountModal'

interface LocalAgent {
  agentId: string
  hostname: string
  ownerName: string
  tokenId: string
  capabilities: string[]
  version?: string
  busy: boolean
  sessionId?: string | null
  connectedAt: number
  lastSeenAt: number
}

interface LocalAgentToken {
  id: string
  label: string
  ownerName: string
  revoked: boolean
  createdAt: number
  lastSeenAt?: number | null
  connected: boolean
}

interface LocalAgentStatus {
  ok: boolean
  operator: { key: string; name: string } | null
  agents: LocalAgent[]
  tokens: LocalAgentToken[]
  counts: {
    connected: number
    ready: number
    busy: number
    tokens: number
  }
}

interface Props {
  currentAccount: AccountInfo | null
}

function formatTime(ts?: number | null) {
  if (!ts) return '尚未連線'
  return new Date(ts).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function relativeTime(ts?: number | null) {
  if (!ts) return '尚未連線'
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  return formatTime(ts)
}

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub: string; tone?: string }) {
  return (
    <div className="local-agent-metric">
      <div className="local-agent-metric-label">{label}</div>
      <div className={`local-agent-metric-value ${tone ? `local-agent-tone-${tone}` : ''}`}>{value}</div>
      <div className="local-agent-metric-sub">{sub}</div>
    </div>
  )
}

export function LocalAgentPage({ currentAccount }: Props) {
  const [status, setStatus] = useState<LocalAgentStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    setLoading(true)
    fetch('/api/local-agent/status')
      .then(res => res.json())
      .then((data: LocalAgentStatus) => {
        if (!data.ok) throw new Error('讀取 Local Agent 狀態失敗')
        setStatus(data)
        setError('')
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function revokeToken(id: string) {
    if (!window.confirm('確定要撤銷這個 Local Agent token 嗎？該 Agent 會被中斷，需要重新下載安裝。')) return
    const res = await fetch(`/api/local-agent/tokens/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
    if (!res.ok) {
      alert('撤銷失敗')
      return
    }
    refresh()
  }

  const agents = status?.agents ?? []
  const tokens = status?.tokens ?? []
  const activeTokens = tokens.filter(token => !token.revoked)
  const readyAgents = agents.filter(agent => !agent.busy)
  const capabilities = useMemo(() => {
    const set = new Set<string>()
    agents.forEach(agent => agent.capabilities.forEach(cap => set.add(cap)))
    return [...set]
  }, [agents])

  return (
    <div className="local-agent-page">
      <div className="local-agent-head">
        <div>
          <h1 className="local-agent-title">Toppath Local Agent</h1>
          <p className="local-agent-sub">管理本機 Agent 下載、連線狀態與安全 token。MachineTest 與 Scripted Bet 都會透過這裡註冊的本機 Agent 執行。</p>
        </div>
        <div className="local-agent-actions">
          <button className="btn-ghost" type="button" onClick={refresh} disabled={loading}>重新整理</button>
          <a className="submit-btn submit-btn--sm local-agent-download" href="/api/machine-test/agent/install.bat">下載 Local Agent</a>
        </div>
      </div>

      {error && <div className="local-agent-alert local-agent-alert--error">{error}</div>}

      <div className="local-agent-metrics">
        <Metric label="Connected" value={status?.counts.connected ?? 0} sub="目前可派工的本機 Agent" tone="ok" />
        <Metric label="Ready" value={readyAgents.length} sub="空閒可執行任務" tone="blue" />
        <Metric label="Busy" value={status?.counts.busy ?? 0} sub="正在執行中的 Agent" tone="warn" />
        <Metric label="Security" value={activeTokens.length ? 'Token' : 'None'} sub="Agent 連線需通過 owner token" tone={activeTokens.length ? 'ok' : 'warn'} />
      </div>

      <div className="local-agent-grid">
        <section className="section-card local-agent-card">
          <div className="local-agent-section-head">
            <h2 className="section-title">下載與安裝</h2>
            <span className="badge badge--ok">目前登入：{status?.operator?.name ?? currentAccount?.label ?? '未登入'}</span>
          </div>

          <div className="local-agent-download-box">
            <div>
              <div className="local-agent-download-title">
                <span className="tab-icon tab-icon--machinetest">A</span>
                Toppath Local Agent Installer
              </div>
              <p>下載的安裝檔會自動包含你的 owner key 與一次性 Agent token。請勿轉傳給其他操作者。</p>
            </div>
            <a className="submit-btn submit-btn--sm" href="/api/machine-test/agent/install.bat">下載 install.bat</a>
          </div>

          <div className="local-agent-steps">
            <div className="local-agent-step">
              <span>1</span>
              <div>
                <strong>下載 installer</strong>
                <p>從目前登入帳號下載，系統會產生只屬於你的 Agent token。</p>
              </div>
            </div>
            <div className="local-agent-step">
              <span>2</span>
              <div>
                <strong>在要執行測試的電腦安裝</strong>
                <p>安裝位置預設為 <code>C:\machine-test-agent</code>，會安裝 Node dependencies 與 Playwright Chromium。</p>
              </div>
            </div>
            <div className="local-agent-step">
              <span>3</span>
              <div>
                <strong>啟動 start.bat</strong>
                <p>啟動後 Agent 會連回公網 Worker，通過 token 驗證後才會出現在可派工清單。</p>
              </div>
            </div>
          </div>

          <div className="local-agent-field-grid">
            <label className="field">
              <span>Server URL</span>
              <input value={window.location.origin} readOnly />
            </label>
            <label className="field">
              <span>目前能力</span>
              <input value={capabilities.length ? capabilities.join(', ') : 'machine-test, scripted-bet'} readOnly />
            </label>
          </div>
        </section>

        <section className="section-card local-agent-card">
          <div className="local-agent-section-head">
            <h2 className="section-title">安全與 Token</h2>
            <span className="badge badge--warn">不要共用 installer</span>
          </div>
          <p className="local-agent-card-note">Agent token 只在 installer 產生時寫入本機 start.bat，伺服器只保存 hash。若裝置遺失或換人使用，可撤銷 token 後重新下載。</p>

          <div className="local-agent-token-list">
            {tokens.length === 0 && (
              <div className="local-agent-empty">尚未建立 token。下載 Local Agent installer 後會出現在這裡。</div>
            )}
            {tokens.map(token => (
              <div className="local-agent-token-row" key={token.id}>
                <div>
                  <div className="local-agent-token-title">
                    <span>{token.label || 'Toppath Local Agent'}</span>
                    <span className={token.revoked ? 'badge badge--error' : token.connected ? 'badge badge--ok' : 'badge'}>{token.revoked ? 'Revoked' : token.connected ? 'Connected' : 'Issued'}</span>
                  </div>
                  <div className="local-agent-token-meta">建立：{formatTime(token.createdAt)} · 最後連線：{relativeTime(token.lastSeenAt)}</div>
                  <code>{token.id}</code>
                </div>
                {!token.revoked && (
                  <button className="btn-ghost local-agent-danger" type="button" onClick={() => revokeToken(token.id)}>撤銷</button>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="section-card local-agent-card local-agent-full">
        <div className="local-agent-section-head">
          <h2 className="section-title">Machine Test 額外安裝</h2>
          <span className="field-hint">音頻測試與 CCTV 需要額外設定</span>
        </div>
        <div className="local-agent-extra-grid">
          <div className="local-agent-extra-item">
            <div className="local-agent-extra-head">
              <span className="badge badge--warn">音頻測試</span>
              <strong>VB-Cable 虛擬音效卡</strong>
            </div>
            <p>錄製遊戲音頻需要 VB-Audio Virtual Cable，安裝後系統會出現「CABLE Input」虛擬音效裝置。</p>
            <ol>
              <li>前往 <a href="https://vb-audio.com/Cable/" target="_blank" rel="noreferrer">https://vb-audio.com/Cable/</a> 下載安裝</li>
              <li>安裝後<strong>重新開機</strong></li>
              <li>確認「CABLE Input (VB-Audio Virtual Cable)」已出現在音效裝置清單</li>
            </ol>
            <div className="local-agent-note">不安裝則音頻測試步驟自動標記 SKIP，不影響其他測試項目。</div>
          </div>
          <div className="local-agent-extra-item">
            <div className="local-agent-extra-head">
              <span className="badge badge--warn">CCTV 測試</span>
              <strong>GEMINI_API_KEY 設定</strong>
            </div>
            <p>CCTV 號碼比對使用 Gemini Vision OCR，Agent 機台需要有可用的 Gemini API Key。</p>
            <ol>
              <li>在 <code>C:\machine-test-agent\start.bat</code> 中加入：</li>
              <li><code>set GEMINI_API_KEY=你的金鑰</code></li>
              <li>重新啟動 Agent（關掉 start.bat 視窗再重開）</li>
            </ol>
            <div className="local-agent-note">也可以在工具的「AI 模型和 Prompt 設定」頁面新增 Gemini Key，Agent 會優先使用 start.bat 中的設定。</div>
          </div>
          <div className="local-agent-extra-item">
            <div className="local-agent-extra-head">
              <span className="badge">注意事項</span>
              <strong>更新 Agent 版本</strong>
            </div>
            <p>伺服器更新後，Agent 機台的 runner.ts 也需要同步更新，否則新功能不會生效。</p>
            <ol>
              <li>重新點「下載 install.bat」取得最新安裝包</li>
              <li>在 Agent 機台執行新的 install.bat（會覆蓋舊版原始碼）</li>
              <li>重新啟動 start.bat</li>
            </ol>
            <div className="local-agent-note">同一台電腦可多次安裝，不影響現有設定。Token 會重新產生，舊連線會自動斷開。</div>
          </div>
        </div>
      </section>

      <section className="section-card local-agent-card local-agent-full">
        <div className="local-agent-section-head">
          <h2 className="section-title">已連線 Agent</h2>
          <span className="field-hint">功能頁會從這裡選擇可用 Agent</span>
        </div>

        <div className="local-agent-list">
          {agents.length === 0 && (
            <div className="local-agent-empty">目前沒有 Local Agent 連線。請下載 installer，並在要執行測試的電腦啟動 start.bat。</div>
          )}
          {agents.map(agent => (
            <div className="local-agent-row" key={agent.agentId}>
              <div>
                <div className="local-agent-row-title">
                  <span className={agent.busy ? 'badge badge--warn' : 'badge badge--ok'}>{agent.busy ? 'BUSY' : 'READY'}</span>
                  <strong>{agent.hostname}</strong>
                </div>
                <div className="local-agent-row-meta">
                  <span>Owner：{agent.ownerName}</span>
                  <span>Agent ID：{agent.agentId}</span>
                  <span>最後心跳：{relativeTime(agent.lastSeenAt)}</span>
                  {agent.sessionId && <span>任務：{agent.sessionId}</span>}
                </div>
                <div className="local-agent-caps">
                  {agent.capabilities.map(cap => <span className="local-agent-cap" key={cap}>{cap}</span>)}
                  {agent.version && <span className="local-agent-cap">{agent.version}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

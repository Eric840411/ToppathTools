import { useState } from 'react'

type StatusState = 'idle' | 'loading' | 'ok' | 'error'

interface VersionRecord {
  server: string
  ip: string
  foundVersion: string
  status: string
  targetVersion: string
}

interface ReportSummary {
  targetFound: number | null
  differentVersions: number | null
  errors: number | null
  total: number | null
  successRate: number | null
}

const API = ''
const DEFAULT_QUERY = 'from:SNSoft-OSM subject:"Image Recon Version Check Report" in:inbox'

export function GmailPage() {
  const [query, setQuery] = useState(DEFAULT_QUERY)
  const [fetchStatus, setFetchStatus] = useState<StatusState>('idle')
  const [fetchResult, setFetchResult] = useState<unknown>(null)
  const [records, setRecords] = useState<VersionRecord[]>([])
  const [summary, setSummary] = useState<ReportSummary | null>(null)
  const [targetVersion, setTargetVersion] = useState('')
  const [generated, setGenerated] = useState('')

  const [syncStatus, setSyncStatus] = useState<StatusState>('idle')
  const [syncResult, setSyncResult] = useState<unknown>(null)

  const handleFetch = async () => {
    setFetchStatus('loading')
    setFetchResult(null)
    setRecords([])
    setSummary(null)
    setTargetVersion('')
    setGenerated('')
    try {
      const resp = await fetch(`${API}/api/integrations/gmail/latest-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = await resp.json()
      setFetchResult(data)
      if (data.ok) {
        setRecords(Array.isArray(data.records) ? data.records : [])
        setSummary(data.summary ?? null)
        setTargetVersion(data.targetVersion ?? '')
        setGenerated(data.generated ?? '')
      }
      setFetchStatus(data.ok ? 'ok' : 'error')
    } catch (e) {
      setFetchResult({ message: String(e) })
      setFetchStatus('error')
    }
  }

  const handleSync = async () => {
    if (records.length === 0) return
    setSyncStatus('loading')
    setSyncResult(null)
    try {
      const resp = await fetch(`${API}/api/integrations/osm/version-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: records }),
      })
      const data = await resp.json()
      setSyncResult(data)
      setSyncStatus(data.ok ? 'ok' : 'error')
    } catch (e) {
      setSyncResult({ message: String(e) })
      setSyncStatus('error')
    }
  }

  return (
    <div className="page-layout">
      <div className="two-col">
        <div className="section-card">
          <h2 className="section-title">📬 抓取最新 Gmail 週報</h2>
          <div className="form-stack">
            <label className="field">
              <span>Gmail 搜尋條件</span>
              <textarea
                rows={3}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <span className="field-hint">預設搜尋 SNSoft OSM Image Recon 版本報告</span>
            </label>
          </div>
          <button
            type="button"
            className={`submit-btn${fetchStatus === 'loading' ? ' loading' : ''}`}
            disabled={fetchStatus === 'loading'}
            onClick={handleFetch}
          >
            {fetchStatus === 'loading' ? '取得中...' : '取得最新週報'}
          </button>

          <div className="info-block" style={{ marginTop: 16 }}>
            <h3>流程說明</h3>
            <ol>
              <li>後端以 Gmail OAuth token 搜尋最新一封週報信件</li>
              <li>取得完整 email 內容（text/plain）並解碼</li>
              <li>Regex 抽取 Target Version / Server / IP / Found Version / Status</li>
              <li>顯示於下方表格，供確認後同步</li>
            </ol>
            <p className="info-note">⚙️ Gmail Token 設定於後端 <code>.env</code></p>
          </div>
        </div>

        <div className="section-card">
          <h2 className="section-title">API 回傳</h2>
          {fetchStatus === 'ok' && summary && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <div className="stat-chip stat-chip--ok">✅ 符合目標 {summary.targetFound ?? '—'}</div>
              <div className="stat-chip stat-chip--warn">⚠️ 版本不同 {summary.differentVersions ?? '—'}</div>
              <div className="stat-chip stat-chip--error">❌ 錯誤 {summary.errors ?? '—'}</div>
              <div className="stat-chip">🖥️ 總計 {summary.total ?? '—'}</div>
              <div className="stat-chip">📊 成功率 {summary.successRate ?? '—'}%</div>
            </div>
          )}
          {fetchStatus === 'ok' && targetVersion && (
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
              目標版本：<code>{targetVersion}</code>　產生時間：{generated}
            </div>
          )}
          <div className={`result-box${fetchStatus === 'ok' ? ' ok' : fetchStatus === 'error' ? ' error' : ''}`}>
            {fetchStatus === 'idle' && <span className="idle-hint">按左側「取得最新週報」</span>}
            {fetchStatus === 'loading' && <span className="idle-hint">呼叫 Gmail API 中...</span>}
            {fetchResult !== null && <pre>{JSON.stringify(fetchResult, null, 2)}</pre>}
          </div>
        </div>
      </div>

      {records.length > 0 && (
        <div className="section-card">
          <div className="table-header">
            <h2 className="section-title" style={{ margin: 0 }}>
              版本記錄（{records.length} 筆）
            </h2>
            <button
              type="button"
              className={`submit-btn submit-btn--sm${syncStatus === 'loading' ? ' loading' : ''}`}
              disabled={syncStatus === 'loading'}
              onClick={handleSync}
            >
              {syncStatus === 'loading' ? '同步中...' : '同步至 Lark Bitable'}
            </button>
          </div>
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>IP</th>
                  <th>目標版本</th>
                  <th>實際版本</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={i}>
                    <td><code>{r.server}</code></td>
                    <td>{r.ip}</td>
                    <td><span className="badge">{r.targetVersion}</span></td>
                    <td>
                      <span className={`badge${r.foundVersion === r.targetVersion ? ' badge--ok' : ' badge--warn'}`}>
                        {r.foundVersion}
                      </span>
                    </td>
                    <td>
                      <span className={`badge${r.status === 'OK' ? ' badge--ok' : r.status ? ' badge--warn' : ''}`}>
                        {r.status || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {syncResult !== null && (
            <div className={`result-box${syncStatus === 'ok' ? ' ok' : ' error'}`} style={{ marginTop: 12 }}>
              <pre>{JSON.stringify(syncResult, null, 2)}</pre>
            </div>
          )}
        </div>
      )}

      {records.length === 0 && fetchStatus === 'ok' && (
        <div className="section-card">
          <div className="result-box">
            <span className="idle-hint">信件已取得，但未找到符合格式的伺服器版本記錄</span>
          </div>
        </div>
      )}

      {fetchStatus === 'error' && (
        <div className="section-card">
          <div className="result-box error">
            <span className="idle-hint">取得失敗，請確認 Gmail Token 設定</span>
          </div>
        </div>
      )}
    </div>
  )
}

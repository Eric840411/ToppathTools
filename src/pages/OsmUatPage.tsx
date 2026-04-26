import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface UatConfig {
  larkUrl: string
  filter: string
  dashGameType: string
  dashClientVersion: string
}

type RunStatus = 'idle' | 'running' | 'done' | 'error'

interface TcGroup { name: string; count: number }

// ─── Storage helpers ───────────────────────────────────────────────────────────

const STORAGE_KEY = 'osm_uat_config'

function loadConfig(): UatConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return {
    larkUrl: '',
    filter: '',
    dashGameType: '',
    dashClientVersion: '',
  }
}

function saveConfig(cfg: UatConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

// ─── Log line parser ───────────────────────────────────────────────────────────

function parseLogLine(line: string): { icon: string; color: string } {
  if (/^✅/.test(line)) return { icon: '✅', color: '#16a34a' }
  if (/^❌/.test(line)) return { icon: '❌', color: '#dc2626' }
  if (/^⚠️|^⚠/.test(line)) return { icon: '⚠️', color: '#d97706' }
  if (/^🔧/.test(line)) return { icon: '🔧', color: '#7c3aed' }
  if (/^⏳/.test(line)) return { icon: '⏳', color: '#2563eb' }
  if (/^⏰/.test(line)) return { icon: '⏰', color: '#2563eb' }
  if (/^📥|^📋/.test(line)) return { icon: '📋', color: '#475569' }
  if (/^\[/.test(line)) return { icon: '▶', color: '#1d4ed8' }
  return { icon: '·', color: '#64748b' }
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function OsmUatPage() {
  const [config, setConfig] = useState<UatConfig>(loadConfig)
  const [status, setStatus] = useState<RunStatus>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [tcGroups, setTcGroups] = useState<TcGroup[] | null>(null)
  const [tcTotal, setTcTotal] = useState<number>(0)
  const [scanning, setScanning] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const statusRef = useRef<RunStatus>('idle')

  // ── SSE 訂閱 ────────────────────────────────────────────────────────────────

  const connectSSE = useCallback(() => {
    if (esRef.current) esRef.current.close()
    const es = new EventSource('/api/osm-uat/stream')
    esRef.current = es

    es.addEventListener('log', (e) => {
      const data = JSON.parse(e.data)
      setLogs(prev => [...prev, data.line])
      // Auto-detect completion from log line (backup in case status event is missed)
      if (/完成！/.test(data.line) && statusRef.current === 'running') {
        statusRef.current = 'done'
        setStatus('done')
        es.close()
        esRef.current = null
      }
    })

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      statusRef.current = data.status
      setStatus(data.status)
      // 完成或錯誤後關閉 SSE，不再重連
      if (data.status === 'done' || data.status === 'error') {
        es.close()
        esRef.current = null
      }
    })

    es.onerror = () => {
      es.close()
      esRef.current = null
      // 只在仍為 running 狀態時重連（用 ref 避免 closure 問題）
      if (statusRef.current === 'running') {
        setTimeout(connectSSE, 3000)
      }
    }
  }, [])

  useEffect(() => {
    connectSSE()
    return () => esRef.current?.close()
  }, [connectSSE])

  // ── 自動捲動 ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (autoScroll && status === 'running') {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll, status])

  // ── Config 變更 ─────────────────────────────────────────────────────────────

  function updateConfig(patch: Partial<UatConfig>) {
    setConfig(prev => {
      const next = { ...prev, ...patch }
      saveConfig(next)
      return next
    })
  }

  // ── 啟動測試 ────────────────────────────────────────────────────────────────

  async function handleRun() {
    setLogs([])
    statusRef.current = 'running'
    setStatus('running')
    connectSSE()   // re-establish SSE connection for the new run
    const res = await fetch('/api/osm-uat/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        larkUrl: config.larkUrl,
        filter: config.filter || undefined,
        dashGameType: config.dashGameType || undefined,
        dashClientVersion: config.dashClientVersion || undefined,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '未知錯誤' }))
      statusRef.current = 'idle'
      setStatus('idle')
      alert(`啟動失敗: ${err.error}`)
    }
  }

  // ── 停止測試 ────────────────────────────────────────────────────────────────

  async function handleStop() {
    await fetch('/api/osm-uat/stop', { method: 'POST' })
  }

  // ── 統計（從所有 log 中找最後一筆摘要，預設為 0）──────────────────────────

  const summary = (() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      const m = logs[i].match(/通過:\s*(\d+).*需人工:\s*(\d+).*跳過:\s*(\d+).*失敗:\s*(\d+)/)
      if (m) return { pass: +m[1], manual: +m[2], skip: +m[3], fail: +m[4] }
    }
    return { pass: 0, manual: 0, skip: 0, fail: 0 }
  })()

  // ── TC 掃描 ──────────────────────────────────────────────────────────────────

  async function handleScan() {
    if (!config.larkUrl) return
    setScanning(true)
    setTcGroups(null)
    try {
      const r = await fetch(`/api/osm-uat/scan?larkUrl=${encodeURIComponent(config.larkUrl)}`)
      const data: { ok: boolean; total: number; groups: TcGroup[]; error?: string } = await r.json()
      if (data.ok) {
        setTcTotal(data.total)
        setTcGroups(data.groups)
      } else {
        alert(`掃描失敗: ${data.error}`)
      }
    } catch {
      alert('掃描失敗')
    } finally {
      setScanning(false)
    }
  }

  // ── 狀態顏色 ────────────────────────────────────────────────────────────────

  const statusColor: Record<RunStatus, string> = {
    idle: '#94a3b8',
    running: '#2563eb',
    done: '#16a34a',
    error: '#dc2626',
  }
  const statusLabel: Record<RunStatus, string> = {
    idle: '待機',
    running: '執行中...',
    done: '完成',
    error: '錯誤',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 4px' }}>

      {/* ── 測試類型分頁 ── */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e2e8f0', paddingBottom: 0 }}>
        {(['後端', 'H5', 'PC'] as const).map(tab => {
          const active = tab === '後端'
          const disabled = tab !== '後端'
          return (
            <button
              key={tab}
              disabled={disabled}
              style={{
                padding: '8px 20px',
                border: 'none',
                borderBottom: active ? '2px solid #1d4ed8' : '2px solid transparent',
                marginBottom: -2,
                background: 'none',
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                color: disabled ? '#cbd5e1' : active ? '#1d4ed8' : '#64748b',
                cursor: disabled ? 'not-allowed' : 'pointer',
                borderRadius: '6px 6px 0 0',
              }}
            >
              {tab}
              {disabled && <span style={{ fontSize: 10, marginLeft: 4, color: '#cbd5e1' }}>（即將推出）</span>}
            </button>
          )
        })}
      </div>

      {/* ── 設定區 ── */}
      <section style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
          ⚙️ 測試設定
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Lark TC 路徑</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={config.larkUrl}
                onChange={e => updateConfig({ larkUrl: e.target.value })}
                placeholder="https://xxx.larksuite.com/base/{token}?table={id}"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={handleScan}
                disabled={scanning || !config.larkUrl}
                style={{
                  ...btnStyle,
                  background: scanning || !config.larkUrl ? '#94a3b8' : '#0891b2',
                  cursor: scanning || !config.larkUrl ? 'not-allowed' : 'pointer',
                  padding: '6px 14px',
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                }}
              >
                {scanning ? '掃描中...' : '🔍 掃描'}
              </button>
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              TC 篩選（留空 = 全跑）
            </span>
            <input
              type="text"
              value={config.filter}
              onChange={e => updateConfig({ filter: e.target.value })}
              placeholder="例：Daily Ranking, Daily Dashboard"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              Dashboard Game Type（留空 = BWJL）
            </span>
            <input
              type="text"
              value={config.dashGameType}
              onChange={e => updateConfig({ dashGameType: e.target.value })}
              placeholder="例：BWJL"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              Dashboard Client Version（留空 = H5(1.5)）
            </span>
            <input
              type="text"
              value={config.dashClientVersion}
              onChange={e => updateConfig({ dashClientVersion: e.target.value })}
              placeholder="例：H5(1.5)"
              style={inputStyle}
            />
          </label>
        </div>
      </section>

      {/* ── TC 掃描結果 ── */}
      {tcGroups && (
        <section style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0369a1' }}>📋 TC 摘要</span>
            <span style={{ fontSize: 12, color: '#64748b' }}>共 {tcTotal} 筆</span>
            <button
              type="button"
              onClick={() => setTcGroups(null)}
              style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tcGroups.map(g => (
              <span
                key={g.name}
                style={{
                  padding: '3px 10px',
                  background: '#e0f2fe',
                  border: '1px solid #7dd3fc',
                  borderRadius: 12,
                  fontSize: 12,
                  color: '#0369a1',
                  whiteSpace: 'nowrap',
                }}
              >
                {g.name} <strong>({g.count})</strong>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ── 控制列 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleRun}
          disabled={status === 'running'}
          style={{
            ...btnStyle,
            background: status === 'running' ? '#94a3b8' : '#1d4ed8',
            cursor: status === 'running' ? 'not-allowed' : 'pointer',
          }}
        >
          ▶ 執行測試
        </button>
        <button
          onClick={handleStop}
          disabled={status !== 'running'}
          style={{
            ...btnStyle,
            background: status === 'running' ? '#dc2626' : '#94a3b8',
            cursor: status !== 'running' ? 'not-allowed' : 'pointer',
          }}
        >
          ■ 停止
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <span
            style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: statusColor[status],
            }}
          />
          <span style={{ fontSize: 13, color: statusColor[status], fontWeight: 600 }}>
            {statusLabel[status]}
          </span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
          />
          自動捲動
        </label>
        <button
          onClick={() => setLogs([])}
          style={{ fontSize: 12, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
        >
          清除
        </button>
      </div>

      {/* ── 統計摘要（長駐）── */}
      <div style={{
        display: 'flex', gap: 12, padding: '10px 16px',
        background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8,
        fontSize: 13, fontWeight: 600,
      }}>
        <span style={{ color: '#16a34a' }}>✅ 通過: {summary.pass}</span>
        <span style={{ color: '#7c3aed' }}>🔧 需人工: {summary.manual}</span>
        <span style={{ color: '#94a3b8' }}>⏭ 跳過: {summary.skip}</span>
        <span style={{ color: '#dc2626' }}>❌ 失敗: {summary.fail}</span>
      </div>

      {/* ── Log 面板 ── */}
      <section
        style={{
          background: '#0f172a', borderRadius: 8, padding: 16,
          fontFamily: 'Consolas, Monaco, monospace', fontSize: 12,
          height: 480, overflowY: 'auto', lineHeight: 1.7,
        }}
        onScroll={e => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          setAutoScroll(atBottom)
        }}
      >
        {logs.length === 0 ? (
          <span style={{ color: '#475569' }}>等待執行...</span>
        ) : (
          logs.map((line, i) => {
            const { color } = parseLogLine(line)
            return (
              <div key={i} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {line}
              </div>
            )
          })
        )}
        <div ref={logEndRef} />
      </section>
    </div>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  fontSize: 12,
  color: '#1e293b',
  background: '#fff',
  outline: 'none',
}

const btnStyle: React.CSSProperties = {
  padding: '8px 20px',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
}

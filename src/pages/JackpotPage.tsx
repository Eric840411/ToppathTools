import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface JackpotGame {
  gameid: string
  grand?: number
  major?: number
  minor?: number
  mini?: number
  fortunate?: number
}

type JpLevel = 'grand' | 'major' | 'minor' | 'mini' | 'fortunate'

interface AnomalyRecord {
  gameId: string
  level: JpLevel
  value: number
  prevValue?: number
  reason: string
  time: string
}

interface SettingRow {
  gameid: string
  level: JpLevel
  min_val: number
  max_val: number
  enabled: number
}

interface DraftEntry {
  min_val: number
  max_val: number
  enabled: boolean
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const MIN_DEFAULT: Record<JpLevel, number> = {
  grand: 1_000_000, major: 1_000, minor: 100, mini: 10, fortunate: 1_000,
}
const MAX_DEFAULT: Record<JpLevel, number> = {
  grand: 999_999_999, major: 999_999_999, minor: 99_999_999, mini: 9_999_999, fortunate: 999_999_999,
}

// ─── Component ────────────────────────────────────────────────────────────────

const LEVELS: JpLevel[] = ['grand', 'major', 'minor', 'mini', 'fortunate']
const LEVEL_COLORS: Record<JpLevel, string> = {
  grand: '#f59e0b', major: '#8b5cf6', minor: '#3b82f6', mini: '#10b981', fortunate: '#ec4899',
}

export function JackpotPage() {
  const [, setChannelId] = useState('4171')
  const [pendingChannelId, setPendingChannelId] = useState('4171')
  const [games, setGames] = useState<JackpotGame[]>([])
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [lastAttemptAt, setLastAttemptAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastRequestBody, setLastRequestBody] = useState<string | null>(null)
  const [anomalyLog, setAnomalyLog] = useState<AnomalyRecord[]>([])
  const [larkSentAt, setLarkSentAt] = useState<string | null>(null)

  // settingsMap key = 'gameid:level'
  const [settingsMap, setSettingsMap] = useState<Map<string, DraftEntry>>(new Map())

  // settings modal
  const [showSettings, setShowSettings] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinVerified, setPinVerified] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Map<string, DraftEntry>>(new Map())
  const [settingsSaving, setSettingsSaving] = useState(false)

  const channelUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load settings on mount
  useEffect(() => {
    fetch('/api/osm/jackpot/settings')
      .then(r => r.json())
      .then((data: { ok: boolean; settings: SettingRow[] }) => {
        if (data.ok) {
          const m = new Map<string, DraftEntry>()
          for (const row of data.settings) {
            m.set(`${row.gameid}:${row.level}`, { min_val: row.min_val, max_val: row.max_val, enabled: row.enabled !== 0 })
          }
          setSettingsMap(m)
        }
      })
      .catch(() => {})
  }, [])

  // Poll backend state every 5s — backend handles the actual 15s Jackpot polling
  const fetchState = useCallback(() => {
    fetch('/api/osm/jackpot/state')
      .then(r => r.json())
      .then((data: { ok: boolean; channelId: string; games: JackpotGame[]; lastUpdated: string | null; lastAttemptAt: string | null; anomalyLog: AnomalyRecord[]; larkSentAt: string | null; lastError: string | null; lastRequestBody: string | null }) => {
        if (!data.ok) return
        setGames(data.games)
        setLastUpdated(data.lastUpdated)
        setLastAttemptAt(data.lastAttemptAt)
        setAnomalyLog(data.anomalyLog)
        setLarkSentAt(data.larkSentAt)
        setChannelId(data.channelId)
        setError(data.lastError)
        setLastRequestBody(data.lastRequestBody)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchState()
    const timer = setInterval(fetchState, 5_000)
    return () => clearInterval(timer)
  }, [fetchState])

  function getSetting(gameid: string, level: JpLevel): DraftEntry {
    return settingsMap.get(`${gameid}:${level}`) ?? {
      min_val: MIN_DEFAULT[level], max_val: MAX_DEFAULT[level], enabled: true,
    }
  }

  // Debounce channel ID changes — send to backend 800ms after user stops typing
  const handleChannelIdChange = (val: string) => {
    setPendingChannelId(val)
    if (channelUpdateTimer.current) clearTimeout(channelUpdateTimer.current)
    channelUpdateTimer.current = setTimeout(() => {
      fetch('/api/osm/jackpot/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: val }),
      }).then(() => fetchState()).catch(() => {})
    }, 800)
  }

  function openSettings() {
    const d = new Map<string, DraftEntry>()
    const allIds = Array.from(new Set([
      ...games.map(g => g.gameid),
      ...[...settingsMap.keys()].map(k => k.split(':')[0]),
    ]))
    for (const gid of allIds) {
      for (const level of LEVELS) {
        d.set(`${gid}:${level}`, { ...getSetting(gid, level) })
      }
    }
    setDraft(d)
    setPinInput(''); setPinVerified(false); setPinError(null)
    setShowSettings(true)
  }

  async function handleVerifyPin() {
    setPinError(null)
    try {
      const r = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinInput }),
      })
      const data = await r.json() as { ok: boolean; message?: string }
      if (data.ok) setPinVerified(true)
      else setPinError(data.message ?? 'PIN 錯誤')
    } catch {
      setPinError('驗證失敗，請稍後再試')
    }
  }

  async function handleSaveSettings() {
    setSettingsSaving(true)
    const settings: { gameid: string; level: JpLevel; min_val: number; max_val: number; enabled: boolean }[] = []
    for (const [key, val] of draft.entries()) {
      const [gameid, level] = key.split(':')
      settings.push({ gameid, level: level as JpLevel, min_val: val.min_val, max_val: val.max_val, enabled: val.enabled })
    }
    try {
      await fetch('/api/osm/jackpot/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-pin': pinInput },
        body: JSON.stringify({ settings }),
      })
      const r = await fetch('/api/osm/jackpot/settings')
      const data = await r.json() as { ok: boolean; settings: SettingRow[] }
      if (data.ok) {
        const m = new Map<string, DraftEntry>()
        for (const row of data.settings) m.set(`${row.gameid}:${row.level}`, { min_val: row.min_val, max_val: row.max_val, enabled: row.enabled !== 0 })
        setSettingsMap(m)
      }
      setShowSettings(false)
      // Refresh state so anomaly re-evaluation is visible immediately
      setTimeout(fetchState, 500)
    } catch {
      // ignore
    } finally {
      setSettingsSaving(false)
    }
  }

  function updateDraft(gameid: string, level: JpLevel, field: keyof DraftEntry, value: number | boolean) {
    setDraft(prev => {
      const next = new Map(prev)
      const key = `${gameid}:${level}`
      const cur = next.get(key) ?? { min_val: MIN_DEFAULT[level], max_val: MAX_DEFAULT[level], enabled: true }
      next.set(key, { ...cur, [field]: value })
      return next
    })
  }

  const anomalyKeys = new Set(anomalyLog.map(a => `${a.gameId}:${a.level}`))

  const settingGameIds = Array.from(new Set([
    ...games.map(g => g.gameid),
    ...[...draft.keys()].map(k => k.split(':')[0]),
  ]))

  return (
    <div className="osm-page">
      {/* Header */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">🎰 Jackpot 獎池監控</h2>
            <p className="osm-section-sub">後端每 15 秒自動拉取一次獎池數據，異常自動推送 Lark 告警（頁面關閉也持續運行）</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>● 後端監控中</span>
            <label style={{ fontSize: 13, color: '#64748b', marginLeft: 8 }}>Channel ID</label>
            <input
              value={pendingChannelId}
              onChange={e => handleChannelIdChange(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, width: 100 }}
            />
            <button
              type="button"
              className="osm-btn"
              style={{ background: '#f1f5f9', color: '#475569', border: '1px solid #cbd5e1' }}
              onClick={openSettings}
              title="管理員：設定各遊戲閾值與 Lark 告警"
            >
              ⚙️ 告警設定
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: '#64748b', marginTop: 4 }}>
          {lastAttemptAt
            ? <span>
                最後嘗試：{lastAttemptAt}
                {lastUpdated && lastUpdated !== lastAttemptAt && <span style={{ color: '#f59e0b' }}>　上次成功：{lastUpdated}</span>}
                {lastUpdated === lastAttemptAt && <span style={{ color: '#22c55e' }}>　✓ 成功</span>}
                　<span style={{ color: '#22c55e' }}>● 後端 15s 輪詢</span>
              </span>
            : <span style={{ color: '#94a3b8' }}>正在連線中...</span>
          }
          {larkSentAt && <span>✅ 已發送告警 Lark（{larkSentAt}）</span>}
        </div>

        {error && <div className="osm-alert osm-alert--error" style={{ marginTop: 8 }}>{error}</div>}
        {lastRequestBody && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
            最後請求體：{lastRequestBody}
          </div>
        )}
      </section>

      {/* Jackpot table */}
      {games.length > 0 && (
        <section className="osm-section">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#334155' }}>獎池數據</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0' }}>Game ID</th>
                  {LEVELS.map(lv => (
                    <th key={lv} style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0', color: LEVEL_COLORS[lv], textTransform: 'capitalize' }}>
                      {lv.charAt(0).toUpperCase() + lv.slice(1)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {games.map((g, i) => {
                  const gid = g.gameid
                  const rowHasAnomaly = LEVELS.some(lv => anomalyKeys.has(`${gid}:${lv}`))
                  return (
                    <tr key={gid} style={{
                      background: rowHasAnomaly ? 'rgba(251,146,60,0.1)' : i % 2 === 0 ? '#1e293b' : '#162032',
                      borderLeft: rowHasAnomaly ? '3px solid #f97316' : '3px solid transparent',
                    }}>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #f1f5f9', fontFamily: 'monospace', fontWeight: rowHasAnomaly ? 600 : undefined }}>
                        {rowHasAnomaly && '⚠️ '}{gid}
                      </td>
                      {LEVELS.map(lv => {
                        const val = g[lv]
                        const isAnomaly = anomalyKeys.has(`${gid}:${lv}`)
                        const alertOn = getSetting(gid, lv).enabled
                        return (
                          <td key={lv} style={{
                            padding: '7px 12px', borderBottom: '1px solid #f1f5f9', textAlign: 'right',
                            color: isAnomaly ? '#dc2626' : undefined,
                            fontWeight: isAnomaly ? 600 : undefined,
                          }}>
                            {val !== undefined && val >= 0
                              ? val.toLocaleString()
                              : <span style={{ color: '#cbd5e1' }}>—</span>}
                            {!alertOn && (
                              <span title="Lark 告警已關閉" style={{ marginLeft: 4, fontSize: 10, color: '#94a3b8' }}>🔕</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Anomaly log */}
      {anomalyLog.length > 0 && (
        <section className="osm-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#334155' }}>⚠️ 異常記錄（{anomalyLog.length} 筆）</h3>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {anomalyLog.map((a, i) => (
              <div key={i} style={{ background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.25)', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{a.gameId}</span>
                  <span style={{ background: LEVEL_COLORS[a.level], color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 11, textTransform: 'capitalize' }}>{a.level}</span>
                  {!getSetting(a.gameId, a.level).enabled && (
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>🔕 未發 Lark</span>
                  )}
                  <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 'auto' }}>{a.time}</span>
                </div>
                <div style={{ color: '#92400e' }}>{a.reason}</div>
                {a.prevValue !== undefined && (
                  <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                    {a.prevValue.toLocaleString()} → {a.value.toLocaleString()}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {games.length === 0 && !error && (
        <section className="osm-section">
          <div className="osm-empty">
            <p>後端監控啟動中，正在載入獎池資料...</p>
            <p style={{ marginTop: 6, fontSize: 12, color: '#94a3b8' }}>
              異常偵測規則：位數異常（±2位）、數值超出合理範圍、單次暴增 &gt;50%
            </p>
          </div>
        </section>
      )}

      {/* ─── Settings Modal ─── */}
      {showSettings && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#1e293b', borderRadius: 12, padding: 24, width: 680, maxWidth: '95vw',
            maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e293b', margin: 0 }}>⚙️ Jackpot 告警設定</h2>
              <button type="button" onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>

            {!pinVerified ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: '24px 0' }}>
                <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>此設定僅限管理員使用，請輸入管理員 PIN</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    value={pinInput}
                    onChange={e => setPinInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleVerifyPin()}
                    placeholder="Admin PIN"
                    style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 14, width: 160 }}
                  />
                  <button type="button" className="osm-btn osm-btn--primary" onClick={handleVerifyPin}>確認</button>
                </div>
                {pinError && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{pinError}</p>}
              </div>
            ) : (
              <>
                <p style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
                  設定每個獎池等級的合理數值範圍，並選擇是否發送 Lark 告警。儲存後後端立即套用新閾值。
                </p>
                {settingGameIds.length === 0 ? (
                  <p style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: '24px 0' }}>
                    尚無遊戲資料，請等待後端完成第一次拉取。
                  </p>
                ) : (
                  settingGameIds.map(gid => (
                    <div key={gid} style={{ marginBottom: 24 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#334155', marginBottom: 8, padding: '4px 0', borderBottom: '1px solid #e2e8f0' }}>
                        {gid}
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: '#162032' }}>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#64748b', fontWeight: 500, width: 100 }}>等級</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#64748b', fontWeight: 500 }}>最小值</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#64748b', fontWeight: 500 }}>最大值</th>
                            <th style={{ padding: '6px 10px', textAlign: 'center', color: '#64748b', fontWeight: 500 }}>發 Lark</th>
                          </tr>
                        </thead>
                        <tbody>
                          {LEVELS.map(level => {
                            const d = draft.get(`${gid}:${level}`) ?? { min_val: MIN_DEFAULT[level], max_val: MAX_DEFAULT[level], enabled: true }
                            return (
                              <tr key={level} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                <td style={{ padding: '6px 10px' }}>
                                  <span style={{ background: LEVEL_COLORS[level], color: '#fff', borderRadius: 4, padding: '2px 10px', fontSize: 11, textTransform: 'capitalize' }}>
                                    {level}
                                  </span>
                                </td>
                                <td style={{ padding: '6px 10px' }}>
                                  <input
                                    type="number"
                                    value={d.min_val}
                                    onChange={e => updateDraft(gid, level, 'min_val', parseInt(e.target.value) || 0)}
                                    style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, width: 130 }}
                                  />
                                </td>
                                <td style={{ padding: '6px 10px' }}>
                                  <input
                                    type="number"
                                    value={d.max_val}
                                    onChange={e => updateDraft(gid, level, 'max_val', parseInt(e.target.value) || 0)}
                                    style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, width: 130 }}
                                  />
                                </td>
                                <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                                  <input
                                    type="checkbox"
                                    checked={d.enabled}
                                    onChange={e => updateDraft(gid, level, 'enabled', e.target.checked)}
                                    style={{ width: 16, height: 16, accentColor: LEVEL_COLORS[level], cursor: 'pointer' }}
                                  />
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                  <button type="button" className="btn-ghost" onClick={() => setShowSettings(false)}>取消</button>
                  <button
                    type="button"
                    className="osm-btn osm-btn--primary"
                    onClick={handleSaveSettings}
                    disabled={settingsSaving || settingGameIds.length === 0}
                  >
                    {settingsSaving ? '儲存中...' : '儲存設定'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

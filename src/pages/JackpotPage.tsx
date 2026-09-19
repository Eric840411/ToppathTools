import { useState, useEffect, useRef, useCallback } from 'react'
import Portal from '../components/Portal'
import { watchCompareState, type WatchThresholdRow, type WatchRole } from '../data/watchCompare'

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

/**
 * 一格門檻的值與來歷。後端算好送來，前端只負責顯示——
 * ⚠️ 兩邊各算一次的話，畫面顯示的門檻跟實際告警用的門檻會不同步，那是最難查的一種 bug。
 */
interface ThresholdView {
  min: number
  max: number
  minSource: 'watch' | 'watch_stale' | 'manual' | 'default'
  maxSource: 'watch' | 'watch_stale' | 'manual' | 'default'
  flags: string[]
  servers: string[]
  note: string
}

interface CoverageSummary { games: number; full: number; partial: number; none: number; conflict: number; unmatched: number }

interface WatchStatus {
  fetchedAt: number | null
  ageSec: number | null
  lastError: string | null
  stale: boolean
  never: boolean
  stats: Record<string, number> | null
}

/**
 * 告警設定視窗對照用的 list.json 門檻（型別在 `data/watchCompare.ts`）。
 * ⚠️ 走獨立端點拿，不從 `/state` 拿——`/state` 的 thresholds 只有在獎池上游抓成功時才有，
 *    那支掛掉時設定視窗會整片空白，但 list.json 其實還好好的。
 */

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
  // key = 'gameid:level'
  const [thresholds, setThresholds] = useState<Record<string, ThresholdView>>({})
  const [coverage, setCoverage] = useState<CoverageSummary | null>(null)
  const [watch, setWatch] = useState<WatchStatus | null>(null)
  const [watchRefreshing, setWatchRefreshing] = useState(false)

  // settingsMap key = 'gameid:level'
  const [settingsMap, setSettingsMap] = useState<Map<string, DraftEntry>>(new Map())

  // settings modal
  const [showSettings, setShowSettings] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinVerified, setPinVerified] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Map<string, DraftEntry>>(new Map())
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [watchRows, setWatchRows] = useState<Record<string, WatchThresholdRow>>({})
  const [watchRowsError, setWatchRowsError] = useState<string | null>(null)
  /**
   * 每款遊戲把哪個等級當「最大獎池／第二獎池」。
   * ⚠️ 不能寫死 Grand/Major——有些遊戲最大的是 Fortunate，有些沒有第二層。
   */
  const [levelMap, setLevelMap] = useState<Record<string, { top: JpLevel | null; second: JpLevel | null }>>({})

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
      .then((data: { ok: boolean; channelId: string; games: JackpotGame[]; lastUpdated: string | null; lastAttemptAt: string | null; anomalyLog: AnomalyRecord[]; larkSentAt: string | null; lastError: string | null; lastRequestBody: string | null; thresholds?: Record<string, ThresholdView>; coverage?: CoverageSummary | null; watch?: WatchStatus | null }) => {
        if (!data.ok) return
        setThresholds(data.thresholds ?? {})
        setCoverage(data.coverage ?? null)
        setWatch(data.watch ?? null)
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

  /** 這款遊戲的等級對應；沒設過就是預設 grand/major（等同舊行為） */
  function getLevelMap(gid: string): { top: JpLevel | null; second: JpLevel | null } {
    return levelMap[gid] ?? { top: 'grand', second: 'major' }
  }

  function roleOf(gid: string, level: JpLevel): WatchRole {
    const m = getLevelMap(gid)
    if (m.top === level) return 'top'
    if (m.second === level) return 'second'
    return null
  }

  function setLevelRole(gid: string, role: 'top' | 'second', level: JpLevel | null) {
    setLevelMap(prev => {
      const cur = prev[gid] ?? { top: 'grand' as JpLevel | null, second: 'major' as JpLevel | null }
      const next = { ...cur, [role]: level }
      // 同一個等級不能同時是最大與第二大——會讓同一格門檻有兩種解釋
      if (role === 'top' && next.second === level) next.second = null
      if (role === 'second' && next.top === level) next.top = null
      return { ...prev, [gid]: next }
    })
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

    // list.json 的對照值。⚠️ 失敗要說出來——沒有這行的話，「來源沒設」跟「查不到」
    // 在畫面上會長得一模一樣（整排「未提供」），而它們的處理方式完全不同。
    setWatchRowsError(null)
    fetch('/api/osm/jackpot/watch-thresholds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameids: allIds }),
    })
      .then(r => r.json())
      .then((data: { ok: boolean; thresholds?: Record<string, WatchThresholdRow>; levelMap?: Record<string, { top: JpLevel | null; second: JpLevel | null }>; watch?: { never: boolean; lastError: string | null } }) => {
        if (!data.ok) { setWatchRowsError('讀不到 list.json 門檻'); return }
        setWatchRows(data.thresholds ?? {})
        setLevelMap(data.levelMap ?? {})
        if (data.watch?.never) setWatchRowsError('尚未成功讀取過 list.json，下面的對照欄無法顯示')
        else if (data.watch?.lastError) setWatchRowsError(`list.json 最近一次更新失敗（${data.watch.lastError}），對照的是上次讀取值`)
      })
      .catch(() => setWatchRowsError('讀不到 list.json 門檻（網路錯誤）'))
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
    // 等級對應（最大／第二大）跟門檻一起存。只送這次視窗裡出現過的遊戲，
    // 沒動過的也要送——後端會把「跟預設一樣」的那幾筆刪掉，資料庫只留真的被改過的
    const map: Record<string, { top: JpLevel | null; second: JpLevel | null }> = {}
    for (const key of draft.keys()) {
      const gid = key.split(':')[0]
      if (!map[gid]) map[gid] = getLevelMap(gid)
    }
    try {
      await fetch('/api/osm/jackpot/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-pin': pinInput },
        body: JSON.stringify({ settings }),
      })
      const lv = await fetch('/api/osm/jackpot/level-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-pin': pinInput },
        body: JSON.stringify({ map }),
      })
      // ⚠️ 等級對應存失敗要講。靜默失敗的話，畫面上的選單看起來已經改好，
      //    但判定仍用舊的對應——那種落差不會有任何徵兆
      const lvData = await lv.json().catch(() => ({ ok: false, message: '回應解析失敗' })) as { ok: boolean; message?: string }
      if (!lvData.ok) alert(`等級對應沒有存成功：${lvData.message ?? '未知錯誤'}`)
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
            <h2 className="osm-section-title">Jackpot 獎池監控</h2>
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
              告警設定
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: '#64748b', marginTop: 4 }}>
          {lastAttemptAt
            ? <span>
                最後嘗試：{lastAttemptAt}
                {lastUpdated && lastUpdated !== lastAttemptAt && <span style={{ color: '#f59e0b' }}>　上次成功：{lastUpdated}</span>}
                {lastUpdated === lastAttemptAt && <span style={{ color: '#22c55e' }}>　通過 成功</span>}
                　<span style={{ color: '#22c55e' }}>● 後端 15s 輪詢</span>
              </span>
            : <span style={{ color: '#94a3b8' }}>正在連線中...</span>
          }
          {larkSentAt && <span>通過 已發送告警 Lark（{larkSentAt}）</span>}
        </div>

        {/* ── 門檻來源（list.json）狀態 ────────────────────────────────────────
            ⚠️ 三件事刻意分開講，混在一起就會誤導：
              ①「這次沒抓到」修得好；②「來源沒設門檻」修接口也不會有值；
              ③ 抓得到 list.json **不等於**辨識機已經載入它——所以一律稱「設定值」。 */}
        <div style={{ marginTop: 8, padding: '8px 12px', background: '#162032', border: '1px solid #2d3f55', borderRadius: 8, fontSize: 12, lineHeight: 1.8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ color: '#cbd5e1' }}>門檻來源：list.json</b>
            {watch?.never
              ? <span style={{ color: '#ef4444' }}>從未取得——目前全部用手動設定／內建預設</span>
              : watch?.stale
              ? <span style={{ color: '#f59e0b' }}>更新失敗，沿用 {fmtTime(watch.fetchedAt)} 的讀取值{watch.lastError ? `（${watch.lastError}）` : ''}</span>
              : watch
              ? <span style={{ color: '#22c55e' }}>讀取於 {fmtTime(watch.fetchedAt)}{watch.ageSec !== null && `（${Math.round(watch.ageSec / 60)} 分前）`}</span>
              : <span style={{ color: '#94a3b8' }}>尚未載入</span>}
            <button
              type="button" className="osm-btn" disabled={watchRefreshing}
              style={{ padding: '2px 10px', fontSize: 11, background: '#1e293b', color: '#94a3b8', border: '1px solid #2d3f55' }}
              onClick={async () => {
                setWatchRefreshing(true)
                try { await fetch('/api/osm/jackpot/watch-refresh', { method: 'POST' }); fetchState() }
                finally { setWatchRefreshing(false) }
              }}
            >{watchRefreshing ? '讀取中…' : '重新讀取'}</button>
          </div>
          {coverage && (
            <div style={{ color: '#94a3b8' }}>
              覆蓋率（以目前監控的 {coverage.games} 款為分母，只算最大池／第二池）：
              <b style={{ color: '#22c55e', margin: '0 4px' }}>完整 {coverage.full}</b>／
              <b style={{ color: '#f59e0b', margin: '0 4px' }}>部分 {coverage.partial}</b>／
              <b style={{ color: '#ef4444', margin: '0 4px' }}>無 {coverage.none}</b>
              {coverage.unmatched > 0 && <span>{'　'}list.json 查無此機種 {coverage.unmatched}</span>}
              {coverage.conflict > 0 && <span style={{ color: '#ef4444' }}>{'　'}範圍衝突 {coverage.conflict}</span>}
              <span style={{ marginLeft: 8, opacity: .8 }}>（接口正常不代表門檻齊全；「無」是來源沒設，不是這次沒抓到）</span>
            </div>
          )}
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
                        {rowHasAnomaly && ''}{gid}
                      </td>
                      {LEVELS.map(lv => {
                        const val = g[lv]
                        const isAnomaly = anomalyKeys.has(`${gid}:${lv}`)
                        const alertOn = getSetting(gid, lv).enabled
                        const th = thresholds[`${gid}:${lv}`]
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
                              <span title="Lark 告警已關閉" style={{ marginLeft: 4, fontSize: 10, color: '#94a3b8' }}>已靜音</span>
                            )}
                            {/* ⚠️ 判定用的門檻是哪來的，要跟數值擺在一起。
                                只看綠燈的話，「用內建預設判過關」會被當成「符合這台的 list.json 範圍」。 */}
                            {th && <ThresholdChip view={th} level={lv} />}
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
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#334155' }}>異常記錄（{anomalyLog.length} 筆）</h3>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {anomalyLog.map((a, i) => (
              <div key={i} style={{ background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.25)', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{a.gameId}</span>
                  <span style={{ background: LEVEL_COLORS[a.level], color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 11, textTransform: 'capitalize' }}>{a.level}</span>
                  {!getSetting(a.gameId, a.level).enabled && (
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>未發 Lark</span>
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
      {/* ⚠️ **一定要走 Portal。**修仙版的 `.osm-page` 帶了 `transform`（即使是 identity matrix），
          那會建立新的 containing block——裡面的 `position: fixed` 就不再以視窗為基準，而是被關在
          `.osm-page` 的盒子裡。實測：遮罩高度只有 258px（視窗是 950），modal 的 top 變成 -177，
          上緣直接被切掉，sticky 標題列也跟著失效。**普通版看起來正常，只有修仙版壞**，
          而且症狀（「打開是一片沒有標題的表格」）完全不像是 CSS 造成的。
          這個 repo 其他 modal 早就都走 `Portal`，所以沒踩到。 */}
      {showSettings && (
        <Portal>
        {/* ⚠️ 用 `.modal-overlay` / `.modal` 這兩個既有 class，不要自己刻。
            修仙版的樣式（金框、模糊底、輸入框配色）都是掛在這兩個 class 上的；
            Portal 之後 scope 在 `.osm-page` 底下的規則不再套用，改用全域 class 才拿得回來。 */}
        <div className="modal-overlay">
          {/* ⚠️ 版面是 **flex 直欄 + 中間那段自己捲**，不是「整個 modal 捲 + sticky 標題」。
              sticky 的做法需要標題列自己有底色去蓋住捲過去的內容，而 modal 底色在修仙版
              是**漸層**——用任何單色去蓋都會變成一塊看得出來的補丁（使用者回報「為什麼有兩個顏色」）。
              改成固定頭尾之後標題列不覆蓋任何東西，底色直接讓 modal 自己的漸層透出來。 */}
          <div className="modal" style={{
            width: 680, maxWidth: '95vw', maxHeight: '85vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0,
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              flexShrink: 0, padding: '18px 24px 12px',
              borderBottom: '1px solid var(--modal-sticky-line, #2d3f55)',
            }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>Jackpot 告警設定</h2>
              <button type="button" onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8' }}>關閉</button>
            </div>

            {/* 中間這段才是會捲的部分（minHeight: 0 是必要的，否則 flex 子元素不會縮） */}
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: '14px 24px 4px' }}>
            {!pinVerified ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: '24px 0' }}>
                <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>此設定僅限管理員使用，請輸入管理員 PIN</p>
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
                <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
                  設定每個獎池等級的合理數值範圍，並選擇是否發送 Lark 告警。儲存後後端立即套用新閾值。
                </p>
                {/* ⚠️ 講清楚誰說了算：判定用的是 list.json，手動值只在 list.json 沒有時才會被用到。
                    不講的話，人會以為在這裡改了就一定生效。 */}
                <p style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 16, lineHeight: 1.8 }}>
                  輸入框下方灰字是 <b style={{ color: '#cbd5e1' }}>list.json 的設定值</b>（Grand 對 <code>low/high</code>、Major 對 <code>mlow/mhigh</code>）。
                  判定時 <b style={{ color: '#cbd5e1' }}>list.json 優先</b>，這裡填的值只有在 list.json 沒提供時才會被採用；
                  兩邊不一致時會標成橘色，按「套用」可以把 list.json 的值帶進來。
                </p>
                {watchRowsError && (
                  <div style={{ fontSize: 11.5, color: '#eab308', background: 'rgba(234,179,8,.08)', border: '1px solid rgba(234,179,8,.3)', borderRadius: 6, padding: '6px 10px', marginBottom: 12 }}>
                    {watchRowsError}
                  </div>
                )}
                {settingGameIds.length === 0 ? (
                  <p style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: '24px 0' }}>
                    尚無遊戲資料，請等待後端完成第一次拉取。
                  </p>
                ) : (
                  settingGameIds.map(gid => (
                    <div key={gid} style={{ marginBottom: 24 }}>
                      {/* ⚠️ 哪一層是「最大獎池」每款遊戲不一樣（有些是 Grand、有些是 Fortunate、
                          有些沒有第二層），所以這裡讓使用者自己指定，不寫死。
                          list.json 只說得出「最大」與「第二大」兩組範圍，對到哪一層由這兩個選單決定。 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8, padding: '4px 0', borderBottom: '1px solid #2d3f55' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#cbd5e1' }}>{gid}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#64748b' }}>list.json 對應：</span>
                        <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                          最大獎池
                          <select
                            value={getLevelMap(gid).top ?? ''}
                            onChange={e => setLevelRole(gid, 'top', (e.target.value || null) as JpLevel | null)}
                            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4 }}
                          >
                            <option value="">（無）</option>
                            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                          </select>
                        </label>
                        <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                          第二獎池
                          <select
                            value={getLevelMap(gid).second ?? ''}
                            onChange={e => setLevelRole(gid, 'second', (e.target.value || null) as JpLevel | null)}
                            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4 }}
                          >
                            <option value="">（無）</option>
                            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                          </select>
                        </label>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: '#162032' }}>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 500, width: 100 }}>等級</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>最小值</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 500 }}>最大值</th>
                            <th style={{ padding: '6px 10px', textAlign: 'center', color: '#94a3b8', fontWeight: 500 }}>發 Lark</th>
                          </tr>
                        </thead>
                        <tbody>
                          {LEVELS.map(level => {
                            const d = draft.get(`${gid}:${level}`) ?? { min_val: MIN_DEFAULT[level], max_val: MAX_DEFAULT[level], enabled: true }
                            return (
                              <tr key={level} style={{ borderBottom: '1px solid #223045' }}>
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
                                  {/* list.json 的對照值就放在輸入框正下方、同一欄——上下對齊才看得出差在哪 */}
                                  <WatchCompare
                                    row={watchRows[gid]} role={roleOf(gid, level)} bound="min" current={d.min_val}
                                    onApply={v => updateDraft(gid, level, 'min_val', v)}
                                  />
                                </td>
                                <td style={{ padding: '6px 10px' }}>
                                  <input
                                    type="number"
                                    value={d.max_val}
                                    onChange={e => updateDraft(gid, level, 'max_val', parseInt(e.target.value) || 0)}
                                    style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, width: 130 }}
                                  />
                                  <WatchCompare
                                    row={watchRows[gid]} role={roleOf(gid, level)} bound="max" current={d.max_val}
                                    onApply={v => updateDraft(gid, level, 'max_val', v)}
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
              </>
            )}
            </div>

            {/* 底部按鈕列固定在 modal 下緣，不參與捲動 */}
            {pinVerified && (
              <div style={{
                display: 'flex', justifyContent: 'flex-end', gap: 8,
                flexShrink: 0, padding: '12px 24px 18px',
                borderTop: '1px solid var(--modal-sticky-line, #2d3f55)',
              }}>
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
            )}
          </div>
        </div>
        </Portal>
      )}
    </div>
  )
}

// ─── 門檻來源顯示 ──────────────────────────────────────────────────────────────

function fmtTime(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleTimeString('zh-TW', { hour12: false })
}

/**
 * 門檻來源標籤。
 *
 * ⚠️ 用詞守則（CodeX review）：抓得到 list.json **不等於**辨識機已載入它，
 *    所以一律寫「list.json 設定值」／「上次讀取值」，不要寫「實際生效」。
 *
 * ⚠️ 「來源未提供」與「這次沒抓到」要長得不一樣。前者修接口也不會有值，
 *    後者才是暫時性的——混成同一個樣子，人會一直等一個永遠不會來的修復。
 */
function ThresholdChip({ view, level }: { view: ThresholdView; level: JpLevel }) {
  const watchLevel = level === 'grand' || level === 'major'
  // Minor/Mini/Fortunate：list.json 本來就沒有這幾層，用預設是正常狀態，不用佔版面
  if (!watchLevel && view.minSource === 'default') return null

  const f = view.flags
  let label: string
  let color: string
  if (f.includes('watch_conflict')) { label = '衝突'; color = '#ef4444' }
  else if (view.minSource === 'watch' && view.maxSource === 'watch') { label = 'list.json'; color = '#22c55e' }
  else if (view.minSource === 'watch_stale' || view.maxSource === 'watch_stale') { label = '上次讀取'; color = '#f59e0b' }
  else if (view.minSource === 'watch' || view.maxSource === 'watch') { label = 'list.json 單邊'; color = '#84cc16' }
  else if (view.minSource === 'manual') { label = '手動'; color = '#60a5fa' }
  else { label = '預設'; color = '#94a3b8' }

  const extra: string[] = []
  if (f.includes('manual_mismatch')) extra.push('手動≠來源')
  if (f.includes('watch_partial')) extra.push('部分辨識機未設')

  const title = [
    `判定範圍：${view.min.toLocaleString()} ～ ${view.max.toLocaleString()}`,
    view.note,
    view.servers.length ? `辨識機：${[...new Set(view.servers)].join('、')}` : '',
  ].filter(Boolean).join('\n')

  return (
    <div title={title} style={{ fontSize: 10, color, marginTop: 2, whiteSpace: 'nowrap' }}>
      {label}
      {extra.length > 0 && <span style={{ color: '#f59e0b' }}>・{extra.join('・')}</span>}
    </div>
  )
}

/**
 * 輸入框下方的 list.json 對照值。
 *
 * ⚠️ 四種「沒有數字」的情況要**講不一樣的話**，它們的處理方式完全不同：
 *   ① 這一層 list.json 根本沒有（Minor/Mini/Fortunate）——永遠不會有值，不是壞掉
 *   ② list.json 查無此機種——要去 list.json 補這台的設定
 *   ③ 有這個機種但沒設門檻——同上，但至少機台是被看著的
 *   ④ 多台辨識機給了不同範圍——要去修到一致，不是我們挑一個
 * 全部寫成「—」的話，看到的人只會覺得功能壞了。
 */
function WatchCompare({ row, role, bound, current, onApply }: {
  row: WatchThresholdRow | undefined
  role: WatchRole
  bound: 'min' | 'max'
  current: number
  onApply: (v: number) => void
}) {
  const st = watchCompareState(row, role, bound, current)
  const note = (text: string, color = '#64748b') => (
    <div style={{ fontSize: 10, color, marginTop: 3, whiteSpace: 'nowrap' }}>{text}</div>
  )

  if (st.kind === 'not_applicable') return note('未指定為最大／第二大')
  if (st.kind === 'loading') return note('list.json 讀取中…')
  if (st.kind === 'unmatched') return note('list.json 查無此機種', '#94a3b8')
  if (st.kind === 'missing') return note('list.json 未提供', '#94a3b8')
  if (st.kind === 'conflict') return note('list.json 範圍衝突', '#ef4444')

  return (
    <div style={{ fontSize: 10, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span
        style={{ color: st.differs ? '#f59e0b' : '#22c55e' }}
        title={[
          st.servers.length ? `辨識機：${st.servers.join('、')}` : '',
          st.channels.length ? `channel：${st.channels.join('、')}（比對不看 channel）` : '',
        ].filter(Boolean).join('\n') || undefined}
      >
        list.json {st.value.toLocaleString()}
      </span>
      {st.differs && (
        <button
          type="button"
          onClick={() => onApply(st.value)}
          style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', cursor: 'pointer' }}
          title="把 list.json 的值帶進上面的輸入框"
        >套用</button>
      )}
    </div>
  )
}

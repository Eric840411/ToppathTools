import { useState, useEffect } from 'react'

interface EgmDayCountField {
  key: string
  label: string
  egmDayCount: number
  userDetail: number
  delta: number
  pass: boolean
}
interface EgmDayCountRow {
  playerId?: string; playerName?: string; clientMachineName?: string
  win?: string; betTimes?: string; bet?: string
  machineIn?: string; machineOut?: string; playerWin?: string
}
interface BettingUser {
  playerId: string; playerName: string; betNumber: number; betAmount: number; machineCount: number
}
interface EgmDayCountResult {
  ok: boolean
  date: string
  dayBoundary: 'gaming' | 'calendar'
  allChannels: boolean
  gameType: string
  allPass: boolean
  comparison: EgmDayCountField[]
  egmDayCount: { betUsers: number; betNumber: number; betAmount: number; transferIn: number; transferOut: number; winOrLose: number; winLoseRatio: number; jackpotAmount: number }
  userDetail: { betUsers: number; betNumber: number; betAmount: number; transferIn: number; transferOut: number; winOrLose: number; winLoseRatio: number; jackpotAmount: number; recordCount: number }
  udTruncated: boolean
  udItems: EgmDayCountRow[]
  bettingUsers: BettingUser[]
  message?: string
}

function fmt(n: number | undefined | null, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

interface GameTypeOption { name: string; gameTag: string; id: number }

export function EgmDayCountPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [dayBoundary, setDayBoundary] = useState<'gaming' | 'calendar'>('gaming')
  const [allChannels, setAllChannels] = useState(false)
  const [gameType, setGameType] = useState('')
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<EgmDayCountResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/osm/meter-reconcile/game-types')
      .then(r => r.json())
      .then(d => { if (d.ok) setGameTypes(d.gameTypes ?? []) })
      .catch(() => {})
  }, [])

  async function handleQuery() {
    setLoading(true); setError(''); setResult(null)
    try {
      const res = await fetch('/api/osm/meter-reconcile/egm-daycount', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, dayBoundary, allChannels, gameType }),
      })
      const d = await res.json()
      if (!d.ok) { setError(d.message || '查詢失敗'); return }
      setResult(d)
    } catch (e) {
      setError(`查詢失敗：${e}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="st-q-page">
      {/* 新版（原型 v7）：查詢條件收成一列，篩選說明降成底下一行小字；結果每一塊都是原型面板、表格貼在標題帶下。樣式在 redesign/pages/settings.css */}
      <section className="section-card st-card st-q">
        <div className="st-q-row">
          <div className="st-q-f">
            <label className="st-q-l" htmlFor="egm-date">日期</label>
            <input id="egm-date" className="lst-field" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="st-q-f">
            <span className="st-q-l">查詢範圍</span>
            <div className="rd-tabs st-seg">
              {([
                { key: 'gaming' as const, label: 'Gaming Day（06:00~隔天06:00）' },
                { key: 'calendar' as const, label: '自然日（00:00~24:00）' },
              ]).map(o => (
                <button key={o.key} type="button" className="rd-tab" aria-pressed={dayBoundary === o.key} onClick={() => setDayBoundary(o.key)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="st-q-f st-q-f--grow">
            <label className="st-q-l" htmlFor="egm-type">Game Type</label>
            <select id="egm-type" className="lst-field" value={gameType} onChange={e => setGameType(e.target.value)}>
              <option value="">All Game</option>
              {gameTypes.map(g => (
                <option key={g.id} value={g.name}>{g.gameTag}</option>
              ))}
            </select>
          </div>
          <label className="st-chk st-q-chk">
            <input type="checkbox" checked={allChannels} onChange={e => setAllChannels(e.target.checked)} />
            All（含全部渠道）
          </label>
          <button type="button" className="submit-btn lst-btn st-q-go" onClick={handleQuery} disabled={loading}>
            {loading ? '查詢中…' : '查詢對帳'}
          </button>
        </div>
        <p className="st-q-hint">All：含全部渠道，不受 Player Channel「np +11」篩選限制。</p>
      </section>

      {error && <div className="st-error">{error}</div>}

      {result && (<>
        <section className="section-card st-card st-verdict" style={{
          borderColor: result.allPass ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)',
          background: result.allPass ? 'rgba(34,197,94,.06)' : 'rgba(239,68,68,.06)',
        }}>
          <span className={`lst-pill st-verdict-pill ${result.allPass ? 'lst-pill--pass' : 'lst-pill--fail'}`}>{result.allPass ? '通過' : '失敗'}</span>
          <div className="st-verdict-main">
            <div className="st-verdict-why" style={{ color: result.allPass ? '#4ade80' : '#f87171' }}>
              {result.allPass ? '一致 — 全部欄位吻合' : `不一致 — ${result.comparison.filter(c => !c.pass).length} 個欄位有落差`}
            </div>
            <div className="st-verdict-sub">
              {result.date} · {result.dayBoundary === 'gaming' ? 'Gaming Day 06:00~隔天06:00' : '自然日 00:00~24:00'} · {result.allChannels ? 'All 渠道' : 'Player Channel: np +11'}{result.gameType ? ` · Game Type: ${result.gameType}` : ''}
            </div>
          </div>
          <div className="st-verdict-num">
            <div className="st-verdict-v st-verdict-v--sm">{result.comparison.filter(c => c.pass).length} / {result.comparison.length}</div>
            <div className="st-verdict-k">致</div>
          </div>
        </section>

        <section className="section-card st-card st-raw">
          <h2 className="section-title">欄位比對</h2>
          <div className="table-wrap lst-tbl">
            <table className="version-table st-tbl st-num">
              <thead>
                <tr>
                  <th style={{ width: 64 }}></th>
                  <th>欄位</th>
                  <th className="st-r">Egm DayCount</th>
                  <th className="st-r">User Detail 回推</th>
                  <th className="st-r">差值</th>
                </tr>
              </thead>
              <tbody>
                {result.comparison.map(c => (
                  <tr key={c.key} style={{ background: c.pass ? undefined : 'rgba(239,68,68,.06)' }}>
                    <td>
                      <span className={`lst-pill ${c.pass ? 'lst-pill--pass' : 'lst-pill--fail'}`}>
                        {c.pass ? '通過' : '失敗'}
                      </span>
                    </td>
                    <td className="st-strong">{c.label}</td>
                    <td className="st-r">{fmt(c.egmDayCount, c.key === 'winLoseRatio' ? 2 : 0)}{c.key === 'winLoseRatio' ? '%' : ''}</td>
                    <td className="st-r">{fmt(c.userDetail, c.key === 'winLoseRatio' ? 2 : 0)}{c.key === 'winLoseRatio' ? '%' : ''}</td>
                    <td className="st-r" style={{ color: c.pass ? 'var(--rd-fg-3, #64748b)' : '#f87171' }}>{fmt(c.delta, c.key === 'winLoseRatio' ? 2 : 0)}{c.key === 'winLoseRatio' ? '%' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="st-note st-pad">
            Jackpot Amount 對照的是 Jackpot Record 報表（jackpotRecordList）逐筆中獎紀錄加總，不是 User Detail。
            Total Bet User 是從 User Detail 逐筆列裡「Bet Number &gt; 0」的不重複 UserId 數出來的（不是 API 直接提供的欄位）。
            兩張報表若非同一時刻查詢，短時間內若有機台持續在跑（例如 AutoSpin），數字可能會有些微落差，不代表算錯。
          </p>
        </section>

        <section className="section-card st-card st-raw">
          <h2 className="section-title">有下注的帳號（{result.bettingUsers.length} 個，跨機台已彙整，不重複）</h2>
          <div className="table-wrap lst-tbl">
            <table className="version-table st-tbl st-num">
              <thead>
                <tr>
                  <th>UserId</th>
                  <th>Account</th>
                  <th className="st-r">玩過幾台機台</th>
                  <th className="st-r">Bet Number 合計</th>
                  <th className="st-r">Bet 合計</th>
                </tr>
              </thead>
              <tbody>
                {result.bettingUsers.map(u => (
                  <tr key={u.playerId}>
                    <td className="lst-mono-sm">{u.playerId}</td>
                    <td className="st-strong">{u.playerName}</td>
                    <td className="st-r">{u.machineCount}</td>
                    <td className="st-r">{u.betNumber}</td>
                    <td className="st-r">{fmt(u.betAmount, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <details className="section-card st-card st-details">
          <summary>
            User Detail 逐筆明細（{result.userDetail.recordCount} 筆{result.udTruncated ? '，超過單次查詢上限，以下可能不完整' : ''}）
          </summary>
          <div className="table-wrap lst-tbl">
            <table className="version-table st-tbl st-num">
              <thead>
                <tr>
                  <th>UserId</th>
                  <th>Machine Name</th>
                  <th className="st-r">Bet Number</th>
                  <th className="st-r">Bet</th>
                  <th className="st-r">Transfer In</th>
                  <th className="st-r">Transfer Out</th>
                  <th>計入 Bet User？</th>
                </tr>
              </thead>
              <tbody>
                {result.udItems.map((r, i) => {
                  const betNum = parseFloat(r.betTimes || '0')
                  const counted = betNum > 0
                  return (
                    <tr key={i} style={{ opacity: counted ? 1 : 0.55 }}>
                      <td className="lst-mono-sm">{r.playerId}</td>
                      <td>{r.clientMachineName}</td>
                      <td className="st-r" style={{ textDecoration: counted ? 'none' : 'line-through' }}>{r.betTimes}</td>
                      <td className="st-r">{fmt(parseFloat(r.bet || '0'), 0)}</td>
                      <td className="st-r">{fmt(parseFloat(r.machineIn || '0'), 0)}</td>
                      <td className="st-r">{fmt(parseFloat(r.machineOut || '0'), 0)}</td>
                      <td style={{ color: counted ? '#4ade80' : 'var(--rd-fg-3, #64748b)' }}>{counted ? '是' : '否'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      </>)}
    </div>
  )
}

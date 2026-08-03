import { useEffect, useState } from 'react'

type LeaderboardEntry = {
  email: string
  label: string
  role: string
  level: string
  levelIndex: number
  activeDays: number
  nextLevel: string | null
  nextThreshold: number | null
}

function initials(label: string) {
  const compact = label.trim()
  if (!compact) return 'U'
  const parts = compact.split(/\s+/)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return compact.slice(0, 2).toUpperCase()
}

export function CultivationLeaderboardPage({ currentEmail }: { currentEmail: string | null }) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/account/cultivation/leaderboard')
      .then(r => r.json())
      .then((d: { ok: boolean; entries?: LeaderboardEntry[]; message?: string }) => {
        if (cancelled) return
        if (!d.ok) { setError(d.message ?? '載入失敗'); return }
        setEntries(d.entries ?? [])
      })
      .catch(() => { if (!cancelled) setError('載入失敗') })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="page-layout">
      <div className="section-card">
        <h2 className="section-title">群英榜</h2>
        <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 14px' }}>
          依累計登入天數排名——同一天內重複登入只算一天，境界一路從練氣期修煉到渡劫期。
        </p>

        {error && <div className="dashboard-alert">{error}</div>}
        {!entries && !error && <div className="dashboard-empty">載入中...</div>}

        {entries && entries.length === 0 && (
          <div className="dashboard-empty dashboard-empty--compact">目前沒有帳號資料</div>
        )}

        {entries && entries.length > 0 && (
          <table className="dashboard-table">
            <thead>
              <tr>
                <th style={{ width: '8%' }}>名次</th>
                <th style={{ width: '32%' }}>道友</th>
                <th style={{ width: '20%' }}>境界</th>
                <th style={{ width: '20%' }}>累計登入天數</th>
                <th style={{ width: '20%' }}>距離下一階</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const isMe = currentEmail !== null && e.email === currentEmail
                return (
                  <tr key={e.email} className={isMe ? 'cultivation-row--me' : undefined}>
                    <td style={{ fontWeight: 700, color: i < 3 ? 'var(--cr-violet, #c7a96b)' : undefined }}>
                      {i + 1}
                    </td>
                    <td>
                      <div className="dashboard-user">
                        <span className="dashboard-avatar">{initials(e.label)}</span>
                        <div>
                          <div className="dashboard-user-name">{e.label}{isMe ? '（你）' : ''}</div>
                          <div className="dashboard-user-key">{e.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className="dashboard-chip dashboard-chip--blue">{e.level}</span></td>
                    <td>{e.activeDays} 天</td>
                    <td>{e.nextLevel ? `還差 ${e.nextThreshold! - e.activeDays} 天晉升「${e.nextLevel}」` : '已達最高境界'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState, type CSSProperties } from 'react'

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

type Realm = {
  name: string
  threshold: number
  slug: string
  epithet: string
  accent: string
}

const REALMS: Realm[] = [
  { name: '練氣期', threshold: 0, slug: 'qi-refining', epithet: '引氣入體', accent: '#7bded6' },
  { name: '築基期', threshold: 7, slug: 'foundation', epithet: '道基初成', accent: '#68b9e8' },
  { name: '金丹期', threshold: 30, slug: 'golden-core', epithet: '一粒金丹', accent: '#e8c45f' },
  { name: '元嬰期', threshold: 90, slug: 'nascent-soul', epithet: '靈胎化嬰', accent: '#b89aff' },
  { name: '化神期', threshold: 180, slug: 'spirit-transformation', epithet: '神遊太虛', accent: '#f3a97d' },
  { name: '煉虛期', threshold: 365, slug: 'void-refining', epithet: '煉虛合道', accent: '#8978ff' },
  { name: '合體期', threshold: 730, slug: 'body-integration', epithet: '神形合一', accent: '#71d5b1' },
  { name: '大乘期', threshold: 1460, slug: 'mahayana', epithet: '大道將成', accent: '#f4d887' },
  { name: '渡劫期', threshold: 2555, slug: 'tribulation', epithet: '九霄問劫', accent: '#a791ff' },
]

function realmFor(entry: Pick<LeaderboardEntry, 'level' | 'levelIndex'>) {
  return REALMS.find(realm => realm.name === entry.level) ?? REALMS[Math.max(0, Math.min(entry.levelIndex, REALMS.length - 1))]
}

function initials(label: string) {
  const compact = label.trim()
  if (!compact) return 'U'
  const parts = compact.split(/\s+/)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return compact.slice(0, 2).toUpperCase()
}

function RealmArt({ realm, compact = false }: { realm: Realm; compact?: boolean }) {
  const realmIndex = REALMS.indexOf(realm)
  return (
    <span
      className={`realm-art${compact ? ' realm-art--compact' : ''}`}
      style={{ '--realm-accent': realm.accent, '--realm-index': realmIndex } as CSSProperties}
      aria-hidden="true"
    >
      <picture>
        <source
          media="(prefers-reduced-motion: no-preference)"
          srcSet={`/themes/xianxia/realms-animated-v2/${realm.slug}.webp`}
          type="image/webp"
        />
        <img src={`/themes/xianxia/realms-v1/${realm.slug}.png`} alt="" loading="lazy" />
      </picture>
    </span>
  )
}

export function CultivationLeaderboardPage({ currentEmail, onPreviewRealm }: { currentEmail: string | null; onPreviewRealm?: (level: string) => void }) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/account/cultivation/leaderboard')
      .then(response => response.json())
      .then((data: { ok: boolean; entries?: LeaderboardEntry[]; message?: string }) => {
        if (cancelled) return
        if (!data.ok) {
          setError(data.message ?? '群英榜暫時無法讀取')
          return
        }
        setEntries(data.entries ?? [])
      })
      .catch(() => {
        if (!cancelled) setError('群英榜暫時無法讀取')
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="page-layout cultivation-board">
      <section className="cultivation-hero">
        <div className="cultivation-hero__copy">
          <span className="cultivation-kicker">CULTIVATION RANKING</span>
          <h2>群英榜</h2>
          <p>以加入宗門的有效天數累積修為。九境循序而上，榜中可見眾修士當前境界與下一次突破之期。</p>
        </div>
        <div className="cultivation-hero__seal" aria-hidden="true">
          <span>九境</span>
          <small>問道</small>
        </div>
      </section>

      <section className="realm-atlas" aria-labelledby="realm-atlas-title">
        <div className="realm-atlas__heading">
          <div>
            <span className="cultivation-kicker">NINE REALMS</span>
            <h3 id="realm-atlas-title">九境圖譜</h3>
          </div>
          <p>每一境皆有獨立法相與靈光</p>
        </div>
        <div className="realm-atlas__track">
          {REALMS.map((realm, index) => (
            <article className="realm-card" key={realm.name} style={{ '--realm-accent': realm.accent } as CSSProperties}>
              <span className="realm-card__order">{String(index + 1).padStart(2, '0')}</span>
              <RealmArt realm={realm} />
              <div className="realm-card__copy">
                <h4>{realm.name}</h4>
                <p>{realm.epithet}</p>
                <span>{realm.threshold === 0 ? '初入宗門' : `${realm.threshold.toLocaleString()} 天`}</span>
                {onPreviewRealm && (
                  <button type="button" className="realm-card__preview" onClick={() => onPreviewRealm(realm.name)}>
                    預覽突破
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="cultivation-ranking" aria-labelledby="cultivation-ranking-title">
        <div className="cultivation-ranking__heading">
          <div>
            <span className="cultivation-kicker">HALL OF CULTIVATORS</span>
            <h3 id="cultivation-ranking-title">宗門名次</h3>
          </div>
          <span className="cultivation-ranking__count">{entries?.length ?? 0} 位修士</span>
        </div>

        {error && <div className="dashboard-alert">{error}</div>}
        {!entries && !error && <div className="dashboard-empty">正在觀照群英榜…</div>}
        {entries?.length === 0 && <div className="dashboard-empty dashboard-empty--compact">目前尚無修士登榜</div>}

        {entries && entries.length > 0 && (
          <div className="cultivation-list">
            {entries.map((entry, index) => {
              const isMe = currentEmail !== null && entry.email === currentEmail
              const realm = realmFor(entry)
              const remainingDays = entry.nextThreshold === null ? null : Math.max(0, entry.nextThreshold - entry.activeDays)
              return (
                <article className={`cultivation-entry${isMe ? ' cultivation-entry--me' : ''}`} key={entry.email}>
                  <div className={`cultivation-rank${index < 3 ? ' cultivation-rank--top' : ''}`}>
                    <small>名次</small>
                    <strong>{String(index + 1).padStart(2, '0')}</strong>
                  </div>
                  <div className="cultivation-user">
                    <span className="dashboard-avatar">{initials(entry.label)}</span>
                    <div>
                      <strong>{entry.label}{isMe && <em>本尊</em>}</strong>
                      <span>{entry.email}</span>
                    </div>
                  </div>
                  <div className="cultivation-realm">
                    <RealmArt realm={realm} compact />
                    <div>
                      <small>當前境界</small>
                      <strong>{entry.level}</strong>
                      <span>{realm.epithet}</span>
                    </div>
                  </div>
                  <div className="cultivation-days">
                    <small>入門修行</small>
                    <strong>{entry.activeDays.toLocaleString()}</strong>
                    <span>天</span>
                  </div>
                  <div className="cultivation-next">
                    <small>下次突破</small>
                    {entry.nextLevel && remainingDays !== null ? (
                      <>
                        <strong>{entry.nextLevel}</strong>
                        <span>尚餘 {remainingDays.toLocaleString()} 天</span>
                      </>
                    ) : (
                      <>
                        <strong>渡劫圓滿</strong>
                        <span>已至九境之巔</span>
                      </>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

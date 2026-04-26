import { useGameProfileCtx } from '../context/GameProfileContext'
import type { GameNotification } from '../hooks/useGameProfile'

const TYPE_COLORS: Record<GameNotification['type'], string> = {
  xp:          'var(--neon-cyan)',
  levelup:     'var(--neon-gold)',
  achievement: 'var(--neon-purple)',
  quest:       'var(--neon-green)',
}

export function GameNotifications() {
  const { notifications, dismissNotif } = useGameProfileCtx()

  if (!notifications.length) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 99998,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      pointerEvents: 'none',
    }}>
      {notifications.map(n => {
        const color = TYPE_COLORS[n.type]
        return (
          <div
            key={n.id}
            onClick={() => dismissNotif(n.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 18px',
              background: 'rgba(2,6,16,0.95)',
              border: `2px solid ${color}`,
              boxShadow: `0 0 16px ${color}88, 0 0 32px ${color}44`,
              fontFamily: 'var(--font-pixel)',
              fontSize: 9,
              color,
              pointerEvents: 'auto',
              cursor: 'pointer',
              animation: 'px-slide-in 150ms steps(4) forwards',
              minWidth: 240,
              maxWidth: 360,
              imageRendering: 'pixelated',
            }}
          >
            <span style={{ fontSize: 20, flexShrink: 0 }}>{n.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ letterSpacing: 1, marginBottom: 3, textShadow: `0 0 6px ${color}` }}>
                {n.message}
              </div>
              {n.sub && (
                <div style={{ fontSize: 7, color: 'var(--text-primary)', letterSpacing: 0.5 }}>
                  {n.sub}
                </div>
              )}
            </div>
            {n.xp && (
              <div style={{ fontSize: 8, color, flexShrink: 0, textShadow: `0 0 6px ${color}` }}>
                +{n.xp}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

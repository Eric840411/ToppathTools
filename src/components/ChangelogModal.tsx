import { APP_VERSION, CHANGELOG } from '../version'
import Portal from './Portal'
import { DungeonIcon } from './DungeonIcon'
import { useIsGameMode } from './GameModeContext'

interface Props { onClose: () => void }

export default function ChangelogModal({ onClose }: Props) {
  const isGame = useIsGameMode()
  return (
    <Portal>
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ width: 620, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0 }}>📋 更新日誌</h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>Workflow Integrator</span>
          </div>
          <button className={`modal-close${isGame ? ' dng-modal-close' : ''}`} onClick={onClose}>
            {isGame ? <DungeonIcon name="close" tone="slate" /> : '✕'}
          </button>
        </div>

        <div className="changelog-scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {CHANGELOG.map((entry, i) => (
            <div key={entry.version} style={{ display: 'flex', gap: 14 }}>
              {/* 時間軸線 */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 14px' }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                  background: i === 0 ? '#6366f1' : '#334155',
                  border: i === 0 ? '2px solid #a5b4fc' : '2px solid #475569',
                  marginTop: 4,
                }} />
                {i < CHANGELOG.length - 1 && (
                  <div style={{ flex: 1, width: 2, background: '#1e293b', marginTop: 4 }} />
                )}
              </div>

              {/* 內容 */}
              <div style={{ flex: 1, paddingBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontWeight: 700, fontSize: 15,
                    color: i === 0 ? '#a5b4fc' : '#94a3b8',
                  }}>
                    v{entry.version}
                  </span>
                  {i === 0 && (
                    <span style={{
                      fontSize: 11, padding: '1px 7px', borderRadius: 99,
                      background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', fontWeight: 600,
                    }}>
                      最新
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: '#475569' }}>{entry.date}</span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {entry.changes.map((c, j) => {
                    const match = c.match(/^(feat|fix|chore|docs|refactor|perf|style|test)(\([^)]+\))?:\s*(.*)/)
                    if (match) {
                      const type = match[1]
                      const scope = match[2] ?? ''
                      const msg = match[3]
                      const colors: Record<string, string> = {
                        feat: '#34d399', fix: '#f87171', chore: '#64748b',
                        docs: '#60a5fa', refactor: '#a78bfa', perf: '#fbbf24',
                        style: '#f0abfc', test: '#fbbf24',
                      }
                      const color = colors[type] ?? '#94a3b8'
                      return (
                        <li key={j} style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.55, listStyle: 'none', marginLeft: -18 }}>
                          <span style={{
                            fontSize: 11, fontWeight: 700, color,
                            background: `${color}18`, border: `1px solid ${color}30`,
                            borderRadius: 4, padding: '1px 6px',
                            marginRight: 7, fontFamily: 'monospace', letterSpacing: '.3px',
                          }}>
                            {type}{scope}
                          </span>
                          {msg}
                        </li>
                      )
                    }
                    return (
                      <li key={j} style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.55 }}>{c}</li>
                    )
                  })}
                </ul>
              </div>
            </div>
          ))}
        </div>

        <div style={{
          borderTop: '1px solid #1e293b',
          padding: '12px 20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: '#64748b',
          fontSize: 12,
        }}>
          <span>目前版本：<strong style={{ color: '#a5b4fc' }}>v{APP_VERSION}</strong></span>
          <button
            onClick={onClose}
            style={{ padding: '6px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
          >
            關閉
          </button>
        </div>
      </div>
    </div>
    </Portal>
  )
}

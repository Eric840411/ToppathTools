import { APP_VERSION, CHANGELOG } from '../version'
import Portal from './Portal'

interface Props { onClose: () => void }

export default function ChangelogModal({ onClose }: Props) {
  return (
    <Portal>
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ width: 620, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0 }}>📋 更新日誌</h2>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Workflow Integrator</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {CHANGELOG.map((entry, i) => (
            <div key={entry.version} style={{ display: 'flex', gap: 14 }}>
              {/* 時間軸線 */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 14px' }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                  background: i === 0 ? '#6366f1' : '#d1d5db',
                  border: i === 0 ? '2px solid #a5b4fc' : '2px solid #e5e7eb',
                  marginTop: 4,
                }} />
                {i < CHANGELOG.length - 1 && (
                  <div style={{ flex: 1, width: 2, background: '#e5e7eb', marginTop: 4 }} />
                )}
              </div>

              {/* 內容 */}
              <div style={{ flex: 1, paddingBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontWeight: 700, fontSize: 15,
                    color: i === 0 ? '#6366f1' : '#374151',
                  }}>
                    v{entry.version}
                  </span>
                  {i === 0 && (
                    <span style={{
                      fontSize: 11, padding: '1px 7px', borderRadius: 99,
                      background: '#ede9fe', color: '#7c3aed', fontWeight: 600,
                    }}>
                      最新
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>{entry.date}</span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {entry.changes.map((c, j) => (
                    <li key={j} style={{ fontSize: 13, color: '#4b5563', lineHeight: 1.55 }}>{c}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>

        <div style={{
          borderTop: '1px solid #f3f4f6',
          padding: '12px 20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: '#9ca3af',
          fontSize: 12,
        }}>
          <span>目前版本：<strong style={{ color: '#6366f1' }}>v{APP_VERSION}</strong></span>
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

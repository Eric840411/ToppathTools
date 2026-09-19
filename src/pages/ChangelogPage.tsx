import { APP_VERSION, CHANGELOG } from '../version'
// ⚠️ 跟 ChangelogModal 共用同一個渲染——原本兩邊各有一份一樣的 regex
import { ChangeLine } from '../features/changelog/ChangeLine'

export function ChangelogPage() {
  return (
    <div style={{ width: '100%', padding: '8px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 28 }}>
        <div style={{
          padding: '6px 14px', background: 'rgba(99,102,241,.15)', border: '1px solid rgba(99,102,241,.3)',
          borderRadius: 99, fontSize: 13, fontWeight: 700, color: '#a5b4fc',
        }}>
          目前版本 v{APP_VERSION}
        </div>
      </div>

      {/* Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {CHANGELOG.map((entry, i) => (
          <div key={entry.version} style={{ display: 'flex', gap: 16 }}>
            {/* Timeline axis */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 16 }}>
              <div style={{
                width: 14, height: 14, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                background: i === 0 ? '#6366f1' : '#334155',
                border: i === 0 ? '2px solid #a5b4fc' : '2px solid #475569',
                boxShadow: i === 0 ? '0 0 0 4px rgba(99,102,241,.15)' : 'none',
              }} />
              {i < CHANGELOG.length - 1 && (
                <div style={{ flex: 1, width: 2, background: '#1e293b', minHeight: 24, marginTop: 4 }} />
              )}
            </div>

            {/* Content */}
            <div style={{
              flex: 1,
              background: '#1e293b',
              border: `1px solid ${i === 0 ? 'rgba(99,102,241,.3)' : '#334155'}`,
              borderRadius: 10,
              padding: '16px 20px',
              marginBottom: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: i === 0 ? '#a5b4fc' : '#94a3b8' }}>
                  v{entry.version}
                </span>
                {i === 0 && (
                  <span style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 99,
                    background: 'rgba(99,102,241,.2)', color: '#a5b4fc', fontWeight: 700, letterSpacing: '.3px',
                  }}>
                    最新
                  </span>
                )}
                <span style={{ fontSize: 12, color: '#475569', marginLeft: 'auto' }}>{entry.date}</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {entry.changes.map((c, j) => <ChangeLine key={j} line={c} />)}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

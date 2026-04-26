import { useEffect, useState } from 'react'

interface HistoryRecord {
  id: string
  feature: string
  title: string
  summary: string
  detail: string
  created_at: number
}

interface Props {
  feature: string
  refreshKey?: number   // bump to re-fetch
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (m < 1) return '剛剛'
  if (h < 1) return `${m} 分鐘前`
  if (d < 1) return `${h} 小時前`
  return `${d} 天前`
}

export default function HistoryPanel({ feature, refreshKey }: Props) {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    fetch(`/api/history?feature=${feature}`)
      .then(r => r.json())
      .then((d: { records?: HistoryRecord[] }) => setRecords(d.records ?? []))
      .catch(() => {})
  }, [open, feature, refreshKey])

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 13, color: '#6366f1', padding: '4px 0',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>歷史紀錄{records.length > 0 && open ? `（${records.length} 筆）` : ''}</span>
      </button>

      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {records.length === 0 ? (
            <span style={{ fontSize: 13, color: '#9ca3af' }}>尚無紀錄（最多保留 7 天）</span>
          ) : (
            records.map(r => (
              <div
                key={r.id}
                style={{
                  border: '1px solid #e5e7eb', borderRadius: 8,
                  padding: '10px 12px', background: '#f9fafb',
                  cursor: 'pointer',
                }}
                onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{r.title}</span>
                  <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0, marginLeft: 8 }}>{timeAgo(r.created_at)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{r.summary}</div>
                {expandedId === r.id && (
                  <pre style={{
                    marginTop: 8, fontSize: 11, color: '#374151',
                    background: '#f1f5f9', borderRadius: 6, padding: 8,
                    overflowX: 'auto', maxHeight: 240, overflowY: 'auto',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  }}>
                    {JSON.stringify(JSON.parse(r.detail), null, 2)}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

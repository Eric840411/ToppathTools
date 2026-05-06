import { useEffect, useState } from 'react'

interface HistoryRecord {
  id: string
  feature: string
  title: string
  summary: string
  detail: string
  created_at: number
}

type DaysFilter = 1 | 3 | 7
type FeatureFilter = 'all' | 'testcase' | 'machine-test' | 'jira' | 'jira-comment' | 'osm-sync' | 'osm-components' | 'luckylink-components' | 'toppath-components' | 'osm-alert' | 'imagerecon' | 'image-check' | 'gs-pdf-testcase' | 'gs-img-compare' | 'gs-logchecker' | 'gs-bonusv2' | 'osm-config-compare'

const FEATURE_LABELS: Record<string, string> = {
  'testcase': 'TestCase 生成',
  'machine-test': '機台測試',
  'jira': 'Jira 批量開單',
  'jira-comment': 'Jira 批次評論',
  'osm-sync': 'OSM 機台同步',
  'osm-components': 'OSM 元件版本',
  'luckylink-components': 'LuckyLink 元件',
  'toppath-components': 'Toppath 元件',
  'osm-alert': '版本告警',
  'imagerecon': 'ImageRecon 週報',
  'image-check': '圖片刪除驗證',
  'gs-pdf-testcase': 'GS PDF TestCase',
  'gs-img-compare': 'GS 圖片比對',
  'gs-logchecker': 'GS Log 攔截',
  'gs-bonusv2': 'GS Bonus V2 統計',
  'osm-config-compare': 'Config 比對',
}

const FEATURE_COLORS: Record<string, string> = {
  'testcase': '#6366f1',
  'machine-test': '#0891b2',
  'jira': '#0052cc',
  'jira-comment': '#1d4ed8',
  'osm-sync': '#16a34a',
  'osm-components': '#059669',
  'luckylink-components': '#7c3aed',
  'toppath-components': '#0e7490',
  'osm-alert': '#dc2626',
  'imagerecon': '#b45309',
  'image-check': '#9333ea',
  'gs-pdf-testcase': '#c026d3',
  'gs-img-compare': '#0369a1',
  'gs-logchecker': '#475569',
  'gs-bonusv2': '#b45309',
  'osm-config-compare': '#065f46',
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (m < 1) return '剛剛'
  if (m < 60) return `${m} 分鐘前`
  if (h < 24) return `${h} 小時前`
  return `${d} 天前`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const PAGE_SIZE = 10

export function HistoryPage() {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [days, setDays] = useState<DaysFilter>(7)
  const [feature, setFeature] = useState<FeatureFilter>('all')
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const fetchRecords = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/history?days=${days}&feature=${feature}`)
      const d = await r.json()
      setRecords(d.records ?? [])
      setPage(1)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRecords() }, [days, feature])

  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE))
  const pagedRecords = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const grouped = pagedRecords.reduce<Record<string, HistoryRecord[]>>((acc, rec) => {
    const date = new Date(rec.created_at).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
    ;(acc[date] ??= []).push(rec)
    return acc
  }, {})

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        {/* Days */}
        <div style={{ display: 'flex', gap: 4 }}>
          {([1, 3, 7] as DaysFilter[]).map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: days === d ? '1.5px solid #6366f1' : '1.5px solid #d1d5db',
                background: days === d ? '#6366f1' : '#fff',
                color: days === d ? '#fff' : '#374151',
                fontWeight: days === d ? 700 : 400,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {d === 1 ? '今日' : `${d} 天`}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 24, background: '#e5e7eb' }} />

        {/* Feature */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(['all', 'jira', 'jira-comment', 'testcase', 'machine-test', 'image-check', 'osm-sync', 'osm-components', 'luckylink-components', 'toppath-components', 'osm-alert', 'imagerecon', 'gs-pdf-testcase', 'gs-img-compare', 'gs-logchecker', 'gs-bonusv2', 'osm-config-compare'] as FeatureFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFeature(f)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: feature === f ? `1.5px solid ${f === 'all' ? '#6366f1' : FEATURE_COLORS[f]}` : '1.5px solid #e5e7eb',
                background: feature === f ? (f === 'all' ? '#ede9fe' : `${FEATURE_COLORS[f]}18`) : '#fff',
                color: feature === f ? (f === 'all' ? '#6366f1' : FEATURE_COLORS[f]) : '#6b7280',
                fontWeight: feature === f ? 700 : 400,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {f === 'all' ? '全部' : FEATURE_LABELS[f]}
            </button>
          ))}
        </div>

        <button
          onClick={fetchRecords}
          disabled={loading}
          style={{ marginLeft: 'auto', padding: '6px 14px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#374151' }}
        >
          {loading ? '載入中...' : '🔄 重新整理'}
        </button>
      </div>

      {loading && <p style={{ color: '#9ca3af', fontSize: 14 }}>載入中...</p>}

      {!loading && records.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af', fontSize: 14 }}>
          此時間範圍內沒有操作紀錄
        </div>
      )}

      {!loading && records.length > 0 && (
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>
          共 {records.length} 筆，第 {page} / {totalPages} 頁
        </div>
      )}

      {Object.entries(grouped).map(([date, recs]) => (
        <div key={date} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #f3f4f6' }}>
            {date} · {recs.length} 筆
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recs.map(rec => {
              const isExpanded = expandedId === rec.id
              const featureColor = FEATURE_COLORS[rec.feature] ?? '#6b7280'
              let detail: Record<string, unknown> = {}
              try { detail = JSON.parse(rec.detail) as Record<string, unknown> } catch { detail = { raw: rec.detail } }

              const cases = Array.isArray(detail.cases) ? detail.cases : null
              const bitableUrl = typeof detail.bitableUrl === 'string' ? detail.bitableUrl : null

              const handleDownload = (e: React.MouseEvent) => {
                e.stopPropagation()
                const blob = new Blob([JSON.stringify(cases, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `testcase_${new Date(rec.created_at).toISOString().slice(0, 16).replace('T', '_')}.json`
                a.click()
                URL.revokeObjectURL(url)
              }

              return (
                <div
                  key={rec.id}
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}
                >
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', userSelect: 'none' }}
                  >
                    <span style={{
                      flex: '0 0 auto',
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 700,
                      background: `${featureColor}18`,
                      color: featureColor,
                      whiteSpace: 'nowrap',
                    }}>
                      {FEATURE_LABELS[rec.feature] ?? rec.feature}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {rec.title}
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{rec.summary}</div>
                    </div>
                    {cases && (
                      <button
                        onClick={handleDownload}
                        title="下載 TestCase JSON"
                        style={{ flex: '0 0 auto', padding: '4px 10px', background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}
                      >
                        📥 下載
                      </button>
                    )}
                    <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{timeAgo(rec.created_at)}</div>
                      <div style={{ fontSize: 11, color: '#d1d5db' }}>{formatDate(rec.created_at)}</div>
                    </div>
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid #f3f4f6', padding: '12px 16px', background: '#f9fafb' }}>
                      {bitableUrl && (
                        <div style={{ marginBottom: 10 }}>
                          <a href={bitableUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#6366f1', fontWeight: 600 }}>
                            🔗 前往 Lark Bitable
                          </a>
                        </div>
                      )}
                      <pre style={{ margin: 0, fontSize: 11, color: '#374151', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflowY: 'auto' }}>
                        {JSON.stringify(detail, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 24, flexWrap: 'wrap' }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: page === 1 ? '#f9fafb' : '#fff', color: page === 1 ? '#d1d5db' : '#374151', cursor: page === 1 ? 'default' : 'pointer', fontSize: 13 }}
          >
            ← 上一頁
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              onClick={() => setPage(p)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: p === page ? '1.5px solid #6366f1' : '1px solid #e5e7eb',
                background: p === page ? '#6366f1' : '#fff',
                color: p === page ? '#fff' : '#374151',
                fontWeight: p === page ? 700 : 400,
                cursor: 'pointer',
                fontSize: 13,
                minWidth: 36,
              }}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: page === totalPages ? '#f9fafb' : '#fff', color: page === totalPages ? '#d1d5db' : '#374151', cursor: page === totalPages ? 'default' : 'pointer', fontSize: 13 }}
          >
            下一頁 →
          </button>
        </div>
      )}
    </div>
  )
}

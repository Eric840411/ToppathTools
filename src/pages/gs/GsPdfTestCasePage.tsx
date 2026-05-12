import { useRef, useState } from 'react'

interface TestCase {
  id: string
  type: string
  priority: string
  title: string
  steps: string
  expected: string
  source: string
  tag?: string
}

interface GenResult {
  ok: boolean
  cases?: TestCase[]
  message?: string
  diffSummary?: { added: number; changed: number; removed: number }
}

function downloadCsv(cases: TestCase[]) {
  const headers = ['#', '類型', '優先級', '標題', '操作步驟', '預期結果', '來源', '標籤']
  const rows = cases.map((c, i) => [
    i + 1, c.type, c.priority, c.title, c.steps, c.expected, c.source, c.tag ?? '',
  ])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'testcases.csv'; a.click()
  URL.revokeObjectURL(url)
}

const PRIORITY_COLOR: Record<string, string> = {
  P0: '#dc2626', P1: '#d97706', P2: '#16a34a',
  高: '#dc2626', 中: '#d97706', 低: '#16a34a',
}

export function GsPdfTestCasePage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [diffMode, setDiffMode] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GenResult | null>(null)
  const [expandedRow, setExpandedRow] = useState<number | null>(null)
  const [filterType, setFilterType] = useState('')

  const handleSubmit = async () => {
    if (!file) return
    setLoading(true); setResult(null); setExpandedRow(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('diffMode', diffMode ? '1' : '0')
      const resp = await fetch('/api/gs/pdf-testcase', { method: 'POST', body: form })
      const data = await resp.json() as GenResult
      setResult(data)
      if (data.ok && data.cases) {
        // cache for diff mode
        localStorage.setItem('gs_pdf_lastcases', JSON.stringify(data.cases))
      }
    } catch (e) {
      setResult({ ok: false, message: String(e) })
    } finally {
      setLoading(false)
    }
  }

  const hasCached = !!localStorage.getItem('gs_pdf_lastcases')
  const allTypes = result?.cases ? [...new Set(result.cases.map(c => c.type))] : []
  const filtered = result?.cases?.filter(c => !filterType || c.type === filterType) ?? []

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="section-card" style={{ marginBottom: 16 }}>
        <h2 className="section-title">📄 PDF TestCase 生成</h2>

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#cbd5e1', marginBottom: 6 }}>規格書檔案</div>
            <input ref={fileInputRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }}
              onChange={e => setFile(e.target.files?.[0] ?? null)} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" onClick={() => fileInputRef.current?.click()}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #2d3f55', background: '#162032', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                📎 選擇檔案
              </button>
              <span style={{ fontSize: 13, color: file ? '#374151' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file ? file.name : '支援 PDF、.docx，最大 20MB'}
              </span>
            </div>
          </div>

          {hasCached && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#6366f1', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={diffMode} onChange={e => setDiffMode(e.target.checked)} />
              🔄 差異比對模式（與上次結果比對）
            </label>
          )}

          <button type="button" onClick={handleSubmit}
            disabled={!file || loading}
            style={{ padding: '9px 24px', borderRadius: 8, background: !file || loading ? '#a5b4fc' : '#6366f1', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: !file || loading ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
            {loading ? '⏳ 生成中...' : '開始生成'}
          </button>
        </div>

        {loading && (
          <div style={{ marginTop: 16, padding: '12px 16px', background: '#f5f3ff', borderRadius: 8, fontSize: 13, color: '#6366f1' }}>
            🤖 AI 分析規格書中，約需 30–60 秒...
          </div>
        )}
      </div>

      {result && !result.ok && (
        <div className="alert-error">{result.message}</div>
      )}

      {result?.ok && result.cases && (
        <div className="section-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h2 className="section-title" style={{ margin: 0 }}>生成結果（{result.cases.length} 筆）</h2>
              {result.diffSummary && (
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  新增 <b style={{ color: '#16a34a' }}>{result.diffSummary.added}</b>
                  變更 <b style={{ color: '#d97706' }}>{result.diffSummary.changed}</b>
                  移除 <b style={{ color: '#dc2626' }}>{result.diffSummary.removed}</b>
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {allTypes.length > 1 && (
                <select value={filterType} onChange={e => setFilterType(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', fontSize: 13 }}>
                  <option value="">全部類型</option>
                  {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              <button type="button" onClick={() => downloadCsv(result.cases!)}
                style={{ padding: '7px 16px', borderRadius: 6, background: '#0f172a', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                ⬇ CSV
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>類型</th>
                  <th>優先級</th>
                  <th>測試標題</th>
                  <th>標籤</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tc, i) => (
                  <>
                    <tr key={i}>
                      <td style={{ color: '#94a3b8', fontSize: 12 }}>{tc.id || i + 1}</td>
                      <td><span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, background: '#f1f5f9', color: '#475569', fontWeight: 600 }}>{tc.type}</span></td>
                      <td>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, background: (PRIORITY_COLOR[tc.priority] ?? '#475569') + '20', color: PRIORITY_COLOR[tc.priority] ?? '#475569', fontWeight: 700 }}>
                          {tc.priority}
                        </span>
                      </td>
                      <td style={{ fontWeight: 500 }}>{tc.title}</td>
                      <td style={{ fontSize: 11, color: '#94a3b8' }}>{tc.tag}</td>
                      <td>
                        <button type="button" className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }}
                          onClick={() => setExpandedRow(expandedRow === i ? null : i)}>
                          {expandedRow === i ? '收起' : '展開'}
                        </button>
                      </td>
                    </tr>
                    {expandedRow === i && (
                      <tr key={`${i}-d`} className="tc-detail-row">
                        <td colSpan={6}>
                          <div className="tc-detail">
                            <div className="tc-detail-item"><strong>操作步驟</strong><p style={{ whiteSpace: 'pre-wrap' }}>{tc.steps}</p></div>
                            <div className="tc-detail-item"><strong>預期結果</strong><p>{tc.expected}</p></div>
                            <div className="tc-detail-item"><strong>來源依據</strong><p style={{ color: '#6366f1' }}>{tc.source}</p></div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

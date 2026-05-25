import { useEffect, useState } from 'react'

interface KnowledgeDoc {
  id: number
  name: string
  type: 'lark_wiki' | 'pdf' | 'google_doc' | 'text'
  source_url: string | null
  tags: string           // JSON string
  cached_at: number | null
  created_at: number
  content_length: number
}

const TYPE_LABELS: Record<string, string> = {
  lark_wiki: 'Lark Wiki',
  pdf: 'PDF URL',
  google_doc: 'Google Doc',
  text: '純文字',
}

const TYPE_ICONS: Record<string, string> = {
  lark_wiki: '📄',
  pdf: '📑',
  google_doc: '📋',
  text: '📝',
}

function parseTags(raw: string): string[] {
  try { return JSON.parse(raw) } catch { return [] }
}

function fmtDate(ms: number | null) {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtSize(len: number) {
  if (len === 0) return '無快取'
  if (len < 1000) return `${len} 字`
  return `${(len / 1000).toFixed(1)}k 字`
}

function daysSince(ms: number | null) {
  if (!ms) return 999
  return Math.floor((Date.now() - ms) / 86400000)
}

export function KnowledgePage() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [refreshingId, setRefreshingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // form state
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<'lark_wiki' | 'pdf' | 'google_doc' | 'text'>('lark_wiki')
  const [formUrl, setFormUrl] = useState('')
  const [formText, setFormText] = useState('')
  const [formTags, setFormTags] = useState('')

  async function loadDocs() {
    setLoading(true)
    try {
      const r = await fetch('/api/knowledge/docs')
      const d = await r.json() as { ok: boolean; docs: KnowledgeDoc[] }
      if (d.ok) setDocs(d.docs)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadDocs() }, [])

  function resetForm() {
    setFormName(''); setFormType('lark_wiki'); setFormUrl(''); setFormText(''); setFormTags(''); setError('')
  }

  async function handleSave() {
    if (!formName.trim()) { setError('請填入名稱'); return }
    if (formType !== 'text' && !formUrl.trim()) { setError('請填入來源 URL'); return }
    if (formType === 'text' && !formText.trim()) { setError('請貼上文字內容'); return }
    setSaving(true); setError('')
    try {
      const tags = formTags.split(',').map(t => t.trim()).filter(Boolean)
      const body: Record<string, unknown> = { name: formName.trim(), type: formType, tags }
      if (formType === 'text') body.text_content = formText
      else body.source_url = formUrl.trim()

      const r = await fetch('/api/knowledge/docs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json() as { ok: boolean; error?: string }
      if (d.ok) { setShowForm(false); resetForm(); loadDocs() }
      else setError(d.error ?? '儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  async function handleRefresh(id: number) {
    setRefreshingId(id)
    try {
      const r = await fetch(`/api/knowledge/docs/${id}/refresh`, { method: 'POST' })
      const d = await r.json() as { ok: boolean; error?: string }
      if (d.ok) loadDocs()
      else alert(`重抓失敗：${d.error}`)
    } finally {
      setRefreshingId(null)
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`確定刪除「${name}」？`)) return
    setDeletingId(id)
    try {
      await fetch(`/api/knowledge/docs/${id}`, { method: 'DELETE' })
      loadDocs()
    } finally {
      setDeletingId(null)
    }
  }

  const s: Record<string, React.CSSProperties> = {
    page: { padding: 24, maxWidth: 960, margin: '0 auto' },
    header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 },
    title: { fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 },
    sub: { fontSize: 12, color: '#475569' },
    card: { background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 10, padding: 20, marginBottom: 16 },
    formRow: { display: 'flex', gap: 10, marginBottom: 10, alignItems: 'flex-start' },
    label: { width: 72, fontSize: 12, color: '#64748b', flexShrink: 0, paddingTop: 8 },
    input: { flex: 1, background: '#162032', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', padding: '7px 10px', fontSize: 13 },
    select: { flex: 1, background: '#162032', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', padding: '7px 10px', fontSize: 13, maxWidth: 200 },
    textarea: { flex: 1, background: '#162032', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', padding: '8px 10px', fontSize: 12, fontFamily: 'monospace', resize: 'vertical', minHeight: 100 },
    btnPrimary: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    btnGhost: { background: 'transparent', color: '#64748b', border: '1px solid #2d3f55', borderRadius: 6, padding: '7px 14px', fontSize: 12, cursor: 'pointer' },
    btnDanger: { background: 'rgba(239,68,68,.1)', color: '#f87171', border: '1px solid rgba(239,68,68,.2)', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer' },
    btnSm: { background: 'transparent', color: '#64748b', border: '1px solid #2d3f55', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer' },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 },
    docCard: { background: '#162032', border: '1px solid #2d3f55', borderRadius: 8, padding: 14 },
    hint: { fontSize: 11, color: '#475569', padding: '8px 10px', background: '#162032', borderRadius: 6, borderLeft: '3px solid #2d3f55', lineHeight: 1.7, marginTop: 12 },
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <div style={s.title}>📚 知識庫</div>
          <div style={s.sub}>預存規格書、已知問題清單等文件，供批次評論 / TestCase 生成 AI 調用</div>
        </div>
        <button style={s.btnPrimary} onClick={() => { setShowForm(true); resetForm() }}>＋ 新增文件</button>
      </div>

      {/* ── Add form ── */}
      {showForm && (
        <div style={{ ...s.card, borderColor: '#3b82f6', background: '#162032' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 14, display: 'flex', justifyContent: 'space-between' }}>
            ➕ 新增文件
            <button style={s.btnGhost} onClick={() => { setShowForm(false); resetForm() }}>取消</button>
          </div>

          <div style={s.formRow}>
            <span style={s.label}>名稱</span>
            <input style={s.input} placeholder="自訂名稱，供選單顯示" value={formName} onChange={e => setFormName(e.target.value)} />
          </div>
          <div style={s.formRow}>
            <span style={s.label}>類型</span>
            <select style={s.select} value={formType} onChange={e => setFormType(e.target.value as typeof formType)}>
              <option value="lark_wiki">Lark Wiki</option>
              <option value="pdf">PDF URL</option>
              <option value="google_doc">Google Doc</option>
              <option value="text">純文字貼上</option>
            </select>
          </div>
          {formType !== 'text' ? (
            <div style={s.formRow}>
              <span style={s.label}>來源 URL</span>
              <input style={s.input} placeholder={
                formType === 'lark_wiki' ? 'https://xxx.feishu.cn/wiki/...' :
                formType === 'pdf' ? 'https://example.com/spec.pdf' :
                'https://docs.google.com/document/d/...'
              } value={formUrl} onChange={e => setFormUrl(e.target.value)} />
            </div>
          ) : (
            <div style={s.formRow}>
              <span style={s.label}>內容</span>
              <textarea style={s.textarea} placeholder="貼上文字內容..." value={formText} onChange={e => setFormText(e.target.value)} />
            </div>
          )}
          <div style={s.formRow}>
            <span style={s.label}>標籤</span>
            <input style={s.input} placeholder="逗號分隔，例：OSM, 版本說明, C服" value={formTags} onChange={e => setFormTags(e.target.value)} />
          </div>

          {error && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 8 }}>❌ {error}</div>}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
            <button style={{ ...s.btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={handleSave}>
              {saving ? '⏳ 抓取中...' : '抓取並儲存'}
            </button>
            <span style={{ fontSize: 11, color: '#334155' }}>抓取後自動快取純文字，下次調用不需重抓</span>
          </div>
        </div>
      )}

      {/* ── Doc list ── */}
      {loading ? (
        <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: 40 }}>載入中...</div>
      ) : docs.length === 0 && !showForm ? (
        <div style={{ ...s.card, textAlign: 'center', padding: '40px 20px', color: '#334155' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📚</div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>知識庫是空的</div>
          <div style={{ fontSize: 12 }}>點擊「＋ 新增文件」新增第一份規格書</div>
        </div>
      ) : (
        <div style={s.grid}>
          {docs.map(doc => {
            const tags = parseTags(doc.tags)
            const days = daysSince(doc.cached_at)
            const stale = days >= 7
            const isRefreshing = refreshingId === doc.id
            const isDeleting = deletingId === doc.id
            return (
              <div key={doc.id} style={s.docCard}>
                {/* Top */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 22, flexShrink: 0, marginTop: 2 }}>{TYPE_ICONS[doc.type]}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0', lineHeight: 1.3, wordBreak: 'break-word' }}>{doc.name}</div>
                    <div style={{ fontSize: 11, color: '#334155', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {TYPE_LABELS[doc.type]}{doc.source_url ? ` · ${doc.source_url.replace(/^https?:\/\//, '').slice(0, 36)}…` : ''}
                    </div>
                  </div>
                </div>

                {/* Tags */}
                {tags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {tags.map(t => (
                      <span key={t} style={{ background: '#1e293b', color: '#64748b', borderRadius: 4, padding: '2px 7px', fontSize: 11 }}>{t}</span>
                    ))}
                  </div>
                )}

                {/* Status */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: stale ? '#fbbf24' : '#334155', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: doc.cached_at ? (stale ? '#fbbf24' : '#22c55e') : '#475569', display: 'inline-block' }} />
                    {doc.cached_at
                      ? `${fmtSize(doc.content_length)} · ${fmtDate(doc.cached_at)}${stale ? ' · 建議重抓' : ''}`
                      : '無快取'}
                  </span>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {doc.type !== 'text' && (
                      <button style={s.btnSm} disabled={isRefreshing} onClick={() => handleRefresh(doc.id)}>
                        {isRefreshing ? '⏳' : '↻'}
                      </button>
                    )}
                    <button style={s.btnDanger} disabled={isDeleting} onClick={() => handleDelete(doc.id, doc.name)}>
                      {isDeleting ? '...' : '刪除'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}

          {/* Add card */}
          <div
            style={{ background: '#162032', border: '1px dashed #2d3f55', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120, cursor: 'pointer', color: '#334155', fontSize: 13, transition: 'border-color .15s' }}
            onClick={() => { setShowForm(true); resetForm() }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#475569')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#2d3f55')}
          >
            ＋ 新增文件
          </div>
        </div>
      )}

      <div style={s.hint}>
        文件在儲存時自動抓取並快取，後續調用不需重抓。若規格書有更新，點 ↻ 重新抓取。<br />
        支援：<code style={{ background: '#1e293b', color: '#94a3b8', padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', fontSize: 11 }}>Lark Wiki</code>、
        <code style={{ background: '#1e293b', color: '#94a3b8', padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', fontSize: 11 }}>PDF URL</code>、
        <code style={{ background: '#1e293b', color: '#94a3b8', padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', fontSize: 11 }}>Google Doc</code>、
        <code style={{ background: '#1e293b', color: '#94a3b8', padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', fontSize: 11 }}>純文字</code>
      </div>
    </div>
  )
}

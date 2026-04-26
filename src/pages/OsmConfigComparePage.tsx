import { useState, useEffect } from 'react'

interface ConfigTemplate {
  id: string
  name: string
  version: string
  template: string
  created_at: number
}

interface DiffItem {
  path: string
  type: 'mismatch' | 'missing_in_live' | 'extra_in_live'
  templateValue?: unknown
  liveValue?: unknown
}

interface CompareResult {
  diffs: DiffItem[]
  summary: string
  geminiAnalysis: string | null
  templateName: string
  templateVersion: string
}

const TYPE_LABEL: Record<DiffItem['type'], string> = {
  mismatch: '值不一致',
  missing_in_live: '線上缺少',
  extra_in_live: '線上多出',
}

const TYPE_COLOR: Record<DiffItem['type'], { bg: string; text: string; border: string }> = {
  mismatch:        { bg: '#fef3c7', text: '#92400e', border: '#fcd34d' },
  missing_in_live: { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' },
  extra_in_live:   { bg: '#eff6ff', text: '#1e40af', border: '#93c5fd' },
}

function fmtVal(v: unknown): string {
  if (v === undefined) return '—'
  if (typeof v === 'string') return `"${v}"`
  return JSON.stringify(v)
}

export function OsmConfigComparePage() {
  const [templates, setTemplates] = useState<ConfigTemplate[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [url, setUrl] = useState('')
  const [useGemini, setUseGemini] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CompareResult | null>(null)
  const [error, setError] = useState('')
  const [filterType, setFilterType] = useState<'all' | DiffItem['type']>('all')

  // Template management
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)  // null = new, string = editing
  const [newName, setNewName] = useState('')
  const [newVersion, setNewVersion] = useState('')
  const [newTemplate, setNewTemplate] = useState('')
  const [addError, setAddError] = useState('')
  const [addLoading, setAddLoading] = useState(false)

  const fetchTemplates = async () => {
    const r = await fetch('/api/osm/config-templates')
    const d = await r.json() as { templates?: ConfigTemplate[] }
    setTemplates(d.templates ?? [])
  }

  useEffect(() => { fetchTemplates() }, [])

  const handleCompare = async () => {
    if (!selectedId) { setError('請先選擇模板'); return }
    if (!url.trim()) { setError('請輸入 URL'); return }
    setLoading(true); setError(''); setResult(null)
    try {
      const r = await fetch('/api/osm/config-compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: selectedId, url: url.trim(), useGemini }),
      })
      const d = await r.json() as { ok: boolean; message?: string } & Partial<CompareResult>
      if (!d.ok) { setError(d.message ?? '比對失敗'); return }
      setResult({ diffs: d.diffs ?? [], summary: d.summary ?? '', geminiAnalysis: d.geminiAnalysis ?? null, templateName: d.templateName ?? '', templateVersion: d.templateVersion ?? '' })
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleAddTemplate = async () => {
    if (!newName.trim() || !newTemplate.trim()) { setAddError('名稱和模板內容不得為空'); return }
    // Accept both JSON and JS (window._ServerCfg = {...}) formats
    let templateStr = newTemplate.trim()
    if (templateStr.includes('_ServerCfg')) {
      const match = templateStr.match(/window\._ServerCfg\s*=\s*([\s\S]+?);?\s*$/)
      if (!match) { setAddError('無法解析 JavaScript 格式，請確認內容完整'); return }
      try {
        // eslint-disable-next-line no-new-func
        const obj = new Function(`return ${match[1]}`)()
        templateStr = JSON.stringify(obj)
      } catch { setAddError('JavaScript 物件解析失敗，請確認格式正確'); return }
    } else {
      try { JSON.parse(templateStr) } catch { setAddError('模板不是有效的 JSON'); return }
    }
    setAddLoading(true); setAddError('')
    const id = editingId ?? `tpl-${Date.now()}`
    const r = await fetch('/api/osm/config-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: newName.trim(), version: newVersion.trim(), template: templateStr }),
    })
    const d = await r.json() as { ok: boolean; message?: string }
    if (d.ok) {
      setShowAddModal(false); setEditingId(null); setNewName(''); setNewVersion(''); setNewTemplate(''); fetchTemplates()
    } else {
      setAddError(d.message ?? '儲存失敗')
    }
    setAddLoading(false)
  }

  const handleEdit = (t: ConfigTemplate) => {
    setEditingId(t.id)
    setNewName(t.name)
    setNewVersion(t.version)
    // Pretty-print the stored JSON for editing
    try { setNewTemplate(JSON.stringify(JSON.parse(t.template), null, 2)) } catch { setNewTemplate(t.template) }
    setAddError('')
    setShowAddModal(true)
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`確定刪除模板「${name}」？`)) return
    await fetch(`/api/osm/config-templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (selectedId === id) setSelectedId('')
    fetchTemplates()
  }

  const filtered = result ? (filterType === 'all' ? result.diffs : result.diffs.filter(d => d.type === filterType)) : []
  const counts = result ? {
    mismatch: result.diffs.filter(d => d.type === 'mismatch').length,
    missing_in_live: result.diffs.filter(d => d.type === 'missing_in_live').length,
    extra_in_live: result.diffs.filter(d => d.type === 'extra_in_live').length,
  } : null

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>

      {/* ── Left panel: templates ── */}
      <div style={{ flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: 8, borderRight: '1px solid #e5e7eb', paddingRight: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: '#374151' }}>模板管理</span>
          <button
            onClick={() => setShowAddModal(true)}
            style={{ padding: '3px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: 'pointer' }}
          >+ 新增</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {templates.length === 0 && <p style={{ color: '#9ca3af', fontSize: 12 }}>尚無模板</p>}
          {templates.map(t => (
            <div
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              style={{
                padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                border: `1px solid ${selectedId === t.id ? '#2563eb' : '#e5e7eb'}`,
                background: selectedId === t.id ? '#eff6ff' : '#fff',
                color: selectedId === t.id ? '#1d4ed8' : '#374151',
              }}
            >
              <div style={{ fontWeight: 600 }}>{t.name}</div>
              {t.version && <div style={{ color: '#6b7280', fontSize: 11 }}>v{t.version}</div>}
              <div style={{ marginTop: 4, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                <button
                  onClick={e => { e.stopPropagation(); handleEdit(t) }}
                  style={{ padding: '1px 8px', background: '#eff6ff', color: '#1d4ed8', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                >編輯</button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(t.id, t.name) }}
                  style={{ padding: '1px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                >刪除</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right panel: compare + results ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

        {/* Input row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={url} onChange={e => setUrl(e.target.value)}
            placeholder="貼上 OSM URL（含 token），例如：https://osm-redirect.osmslot.org/?token=..."
            style={{ flex: 1, minWidth: 300, padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#6b7280', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={useGemini} onChange={e => setUseGemini(e.target.checked)} />
            Gemini 分析
          </label>
          <button
            onClick={handleCompare} disabled={loading}
            style={{ padding: '7px 18px', background: loading ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: loading ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
          >
            {loading ? '比對中...' : '🔍 開始比對'}
          </button>
        </div>

        {!selectedId && <p style={{ color: '#f59e0b', fontSize: 12 }}>⚠️ 請先在左側選擇一個模板</p>}
        {error && <p style={{ color: '#dc2626', fontSize: 13 }}>❌ {error}</p>}

        {/* Result */}
        {result && (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Summary bar */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: '#374151' }}>
                {result.templateName}{result.templateVersion ? ` v${result.templateVersion}` : ''} 比對結果
              </span>
              {result.diffs.length === 0
                ? <span style={{ padding: '3px 10px', background: '#dcfce7', color: '#16a34a', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>✅ 完全一致</span>
                : <>
                  {(['mismatch', 'missing_in_live', 'extra_in_live'] as DiffItem['type'][]).map(t => counts![t] > 0 && (
                    <span key={t} style={{ padding: '3px 10px', background: TYPE_COLOR[t].bg, color: TYPE_COLOR[t].text, border: `1px solid ${TYPE_COLOR[t].border}`, borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
                      {TYPE_LABEL[t]}: {counts![t]}
                    </span>
                  ))}
                </>
              }
            </div>

            {/* Filter tabs */}
            {result.diffs.length > 0 && (
              <div style={{ display: 'flex', gap: 6 }}>
                {(['all', 'mismatch', 'missing_in_live', 'extra_in_live'] as const).map(f => {
                  const active = filterType === f
                  const count = f === 'all' ? result.diffs.length : counts![f]
                  return (
                    <button key={f} onClick={() => setFilterType(f)}
                      style={{ padding: '4px 12px', border: `1px solid ${active ? '#2563eb' : '#e5e7eb'}`, borderRadius: 20, fontSize: 12, fontWeight: active ? 600 : 400, background: active ? '#eff6ff' : '#fff', color: active ? '#1d4ed8' : '#6b7280', cursor: 'pointer' }}>
                      {f === 'all' ? `全部 (${count})` : `${TYPE_LABEL[f]} (${count})`}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Diff table */}
            {filtered.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb', width: 100 }}>類型</th>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb' }}>路徑</th>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb' }}>模板值</th>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb' }}>線上值</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d, i) => {
                    const c = TYPE_COLOR[d.type]
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '6px 10px' }}>
                          <span style={{ padding: '2px 8px', background: c.bg, color: c.text, border: `1px solid ${c.border}`, borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                            {TYPE_LABEL[d.type]}
                          </span>
                        </td>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#374151', wordBreak: 'break-all' }}>{d.path}</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#6b7280', wordBreak: 'break-all', maxWidth: 200 }}>{fmtVal(d.templateValue)}</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#6b7280', wordBreak: 'break-all', maxWidth: 200 }}>{fmtVal(d.liveValue)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {/* Gemini analysis */}
            {result.geminiAnalysis && (
              <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ fontWeight: 600, color: '#16a34a', fontSize: 13, marginBottom: 8 }}>🤖 Gemini 分析</div>
                <pre style={{ fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.6 }}>{result.geminiAnalysis}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Add template modal ── */}
      {showAddModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{editingId ? '編輯 Config 模板' : '新增 Config 模板'}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="模板名稱（如：QAT 正式版）"
                style={{ flex: 1, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
              <input value={newVersion} onChange={e => setNewVersion(e.target.value)} placeholder="版本（選填）"
                style={{ width: 100, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
            </div>
            <textarea
              value={newTemplate} onChange={e => setNewTemplate(e.target.value)}
              placeholder={'直接貼上 DevTools 中 serverCfg.js 的完整內容即可\n（支援 JS 格式：window._ServerCfg = {...}; 或純 JSON）'}
              style={{ flex: 1, minHeight: 280, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }}
            />
            {addError && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>❌ {addError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAddModal(false); setEditingId(null); setAddError('') }}
                style={{ padding: '6px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer' }}>取消</button>
              <button onClick={handleAddTemplate} disabled={addLoading}
                style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                {addLoading ? '儲存中...' : '儲存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

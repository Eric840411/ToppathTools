import { useState, useEffect } from 'react'
import Portal from '../components/Portal'
import { parseServerCfgSource } from '../../shared/server-cfg-parse'

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
  mismatch:        { bg: 'rgba(251,191,36,0.12)', text: '#fbbf24', border: 'rgba(251,191,36,0.3)' },
  missing_in_live: { bg: 'rgba(239,68,68,0.12)',  text: '#f87171', border: 'rgba(239,68,68,0.3)' },
  extra_in_live:   { bg: 'rgba(59,130,246,0.12)', text: '#60a5fa', border: 'rgba(59,130,246,0.3)' },
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
      // 只解析不執行（原本 new Function 會執行貼上的內容）
      try {
        templateStr = JSON.stringify(parseServerCfgSource(templateStr))
      } catch (e) { setAddError(`JavaScript 物件解析失敗：${(e as Error).message}`); return }
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

      {/* ── Left panel: templates ── 新版（原型 v7）：300px「模板管理」面板，標題帶滿版；卡片＝名稱＋版本籤、底下靠左兩顆一般尺寸按鈕；「+ 新增」放清單最下面。樣式在 redesign/pages/osm.css 的 .cfg-* */}
      <section className="section-card cfg-tpl-panel">
        <h2 className="section-title">模板管理</h2>
        <div className="cfg-tpl-list">
          {templates.length === 0 && <p className="cfg-tpl-empty">尚無模板</p>}
          {templates.map(t => (
            <div
              key={t.id}
              className={selectedId === t.id ? 'cfg-tpl is-on' : 'cfg-tpl'}
              onClick={() => setSelectedId(t.id)}
            >
              <div className="cfg-tpl-head">
                <span className="cfg-tpl-name">{t.name}</span>
                {t.version && <span className="cfg-tpl-ver">v{t.version}</span>}
              </div>
              <div className="cfg-tpl-actions">
                <button type="button" className="btn-ghost cfg-btn"
                  onClick={e => { e.stopPropagation(); handleEdit(t) }}
                >編輯</button>
                <button type="button" className="btn-ghost cfg-btn cfg-btn--danger"
                  onClick={e => { e.stopPropagation(); handleDelete(t.id, t.name) }}
                >刪除</button>
              </div>
            </div>
          ))}
          <button type="button" className="btn-ghost cfg-btn cfg-add" onClick={() => setShowAddModal(true)}>+ 新增</button>
        </div>
      </section>

      {/* ── Right panel: compare + results ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

        {/* Input row 新版：放進面板（原型 v7） */}
        <div className="section-card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 0 }}>
          <input
            value={url} onChange={e => setUrl(e.target.value)}
            placeholder="貼上 OSM URL（含 token），例如：https://osm-redirect.osmslot.org/?token=..."
            style={{ flex: 1, minWidth: 300, padding: '7px 12px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#94a3b8', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={useGemini} onChange={e => setUseGemini(e.target.checked)} />
            Gemini 分析
          </label>
          <button className="cfg-run"
            onClick={handleCompare} disabled={loading}
            style={{ padding: '7px 18px', background: loading ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: loading ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
          >
            {loading ? '比對中...' : '開始比對'}
          </button>
        </div>

        {!selectedId && <p style={{ color: '#f59e0b', fontSize: 12 }}>請先在左側選擇一個模板</p>}
        {error && <p style={{ color: '#dc2626', fontSize: 13 }}>失敗 {error}</p>}

        {/* Result */}
        {result && (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Summary bar */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: '#cbd5e1' }}>
                {result.templateName}{result.templateVersion ? ` v${result.templateVersion}` : ''} 比對結果
              </span>
              {result.diffs.length === 0
                ? <span style={{ padding: '3px 10px', background: 'rgba(22,163,74,0.15)', color: '#4ade80', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>通過 完全一致</span>
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
                    <button key={f} className={active ? 'cfg-filter is-on' : 'cfg-filter'} onClick={() => setFilterType(f)}
                      style={{ padding: '4px 12px', border: `1px solid ${active ? '#2563eb' : '#2d3f55'}`, borderRadius: 20, fontSize: 12, fontWeight: active ? 600 : 400, background: active ? 'rgba(37,99,235,0.15)' : '#1e293b', color: active ? '#60a5fa' : '#94a3b8', cursor: 'pointer' }}>
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
                  <tr style={{ background: '#162032', textAlign: 'left' }}>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #2d3f55', width: 100, color: '#94a3b8' }}>類型</th>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #2d3f55', color: '#94a3b8' }}>路徑</th>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #2d3f55', color: '#94a3b8' }}>模板值</th>
                    <th style={{ padding: '7px 10px', borderBottom: '1px solid #2d3f55', color: '#94a3b8' }}>線上值</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d, i) => {
                    const c = TYPE_COLOR[d.type]
                    return (
                      <tr key={i} className="cfg-diff-row" style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '6px 10px' }}>
                          <span style={{ padding: '2px 8px', background: c.bg, color: c.text, border: `1px solid ${c.border}`, borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                            {TYPE_LABEL[d.type]}
                          </span>
                        </td>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#cbd5e1', wordBreak: 'break-all' }}>{d.path}</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#94a3b8', wordBreak: 'break-all', maxWidth: 200 }}>{fmtVal(d.templateValue)}</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#94a3b8', wordBreak: 'break-all', maxWidth: 200 }}>{fmtVal(d.liveValue)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {/* Gemini analysis */}
            {result.geminiAnalysis && (
              <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ fontWeight: 600, color: '#16a34a', fontSize: 13, marginBottom: 8 }}>Gemini 分析</div>
                <pre style={{ fontSize: 12, color: '#cbd5e1', whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.6 }}>{result.geminiAnalysis}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Add template modal ── */}
      {showAddModal && (
        <Portal>
        <div className="rd-modal-back">
          <div className="rd-modal" role="dialog" aria-modal="true" aria-labelledby="cfg-tpl-modal-title" style={{ width: 640 }}>
            <div className="rd-modal-h"><h2 id="cfg-tpl-modal-title">{editingId ? '編輯 Config 模板' : '新增 Config 模板'}</h2></div>
            <div className="rd-modal-b">
              <div className="rd-form">
                <label className="rd-l" htmlFor="cfg-tpl-name">模板名稱</label>
                <input id="cfg-tpl-name" className="rd-field" value={newName} onChange={e => setNewName(e.target.value)} placeholder="模板名稱（如：QAT 正式版）" />
                <label className="rd-l" htmlFor="cfg-tpl-version">版本</label>
                <input id="cfg-tpl-version" className="rd-field" value={newVersion} onChange={e => setNewVersion(e.target.value)} placeholder="版本（選填）" style={{ maxWidth: 200 }} />
                <label className="rd-l rd-l--top" htmlFor="cfg-tpl-body">serverCfg 內容</label>
                <textarea
                  id="cfg-tpl-body" className="rd-field"
                  value={newTemplate} onChange={e => setNewTemplate(e.target.value)}
                  placeholder={'直接貼上 DevTools 中 serverCfg.js 的完整內容即可\n（支援 JS 格式：window._ServerCfg = {...}; 或純 JSON）'}
                  style={{ minHeight: 280 }}
                />
                {addError && <p className="rd-modal-err rd-span">失敗 {addError}</p>}
              </div>
            </div>
            <div className="rd-modal-f">
              <button className="rd-btn" onClick={() => { setShowAddModal(false); setEditingId(null); setAddError('') }}>取消</button>
              <button className="rd-btn is-primary" onClick={handleAddTemplate} disabled={addLoading}>
                {addLoading ? '儲存中...' : '儲存'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  )
}

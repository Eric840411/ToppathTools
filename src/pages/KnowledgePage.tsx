import { useEffect, useRef, useState } from 'react'

interface KnowledgeFolder {
  id: number
  name: string
  color: string
  created_at: number
  doc_count: number
}

interface KnowledgeDoc {
  id: number
  name: string
  type: 'lark_wiki' | 'pdf' | 'google_doc' | 'text' | 'file_upload'
  source_url: string | null
  tags: string
  cached_at: number | null
  created_at: number
  content_length: number
  folder_id: number | null
}

const TYPE_LABELS: Record<string, string> = {
  lark_wiki: 'Lark Wiki', pdf: 'PDF URL', google_doc: 'Google Doc', text: '純文字', file_upload: '上傳文件',
}
const TYPE_ICONS: Record<string, string> = {
  lark_wiki: '📄', pdf: '📑', google_doc: '📋', text: '📝', file_upload: '📁',
}
const FOLDER_COLORS: Record<string, string> = {
  blue: '#3b82f6', green: '#22c55e', yellow: '#fbbf24',
  purple: '#a78bfa', red: '#f87171', cyan: '#22d3ee', gray: '#64748b',
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
  const [folders, setFolders] = useState<KnowledgeFolder[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<number | null | 'all'>('all')
  const [allDocs, setAllDocs] = useState<KnowledgeDoc[]>([]) // full list, used for tab counts
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  // Add folder inline
  const [showAddFolder, setShowAddFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderColor, setNewFolderColor] = useState('blue')
  const [folderSaving, setFolderSaving] = useState(false)

  // Add doc modal
  const [showAddDoc, setShowAddDoc] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<KnowledgeDoc['type']>('lark_wiki')
  const [formUrl, setFormUrl] = useState('')
  const [formText, setFormText] = useState('')
  const [formTags, setFormTags] = useState('')
  const [formFile, setFormFile] = useState<File | null>(null)
  const [formFolderId, setFormFolderId] = useState<number | null>(null)
  const [formError, setFormError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Preview
  const [previewDoc, setPreviewDoc] = useState<{ id: number; name: string; content: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Actions
  const [refreshingId, setRefreshingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  // Edit doc
  const [editDoc, setEditDoc] = useState<KnowledgeDoc | null>(null)
  const [editName, setEditName] = useState('')
  const [editTags, setEditTags] = useState('')
  const [editFolderId, setEditFolderId] = useState<number | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')

  async function loadFolders() {
    try {
      const r = await fetch('/api/knowledge/folders')
      if (!r.ok) return
      const d = await r.json() as { ok: boolean; folders: KnowledgeFolder[] }
      if (d.ok) setFolders(d.folders)
    } catch { /* folder names will still show, counts derive from allDocs */ }
  }

  async function loadAllDocs() {
    const r = await fetch('/api/knowledge/docs')
    const d = await r.json() as { ok: boolean; docs: KnowledgeDoc[] }
    if (d.ok) setAllDocs(d.docs)
  }

  async function loadDocs(folderId: number | null | 'all') {
    setDocsLoading(true)
    try {
      const qs = folderId === 'all' ? '' : folderId === null ? '?folder_id=null' : `?folder_id=${folderId}`
      const r = await fetch(`/api/knowledge/docs${qs}`)
      const d = await r.json() as { ok: boolean; docs: KnowledgeDoc[] }
      if (d.ok) setDocs(d.docs)
    } finally { setDocsLoading(false) }
  }

  useEffect(() => {
    loadFolders()
    loadDocs('all')
    loadAllDocs()
  }, [])

  // Always compute from allDocs (full list) — avoids stale API count vs actual data mismatch
  // Use == null (loose) to catch both null and undefined
  const effectiveUnclassified = allDocs.filter(d => d.folder_id == null).length
  const effectiveTotal = allDocs.length

  function selectFolder(id: number | null | 'all') {
    setSelectedFolderId(id)
    setSearch(''); setTypeFilter('')
    loadDocs(id)
    setFormFolderId(typeof id === 'number' ? id : null)
  }

  async function handleAddFolder() {
    if (!newFolderName.trim()) return
    setFolderSaving(true)
    try {
      const r = await fetch('/api/knowledge/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim(), color: newFolderColor }),
      })
      const d = await r.json() as { ok: boolean; error?: string }
      if (!d.ok) { alert(`新增資料夾失敗：${d.error ?? '請確認伺服器已重啟'}`); return }
      setNewFolderName(''); setShowAddFolder(false)
      loadFolders(); loadAllDocs()
    } catch { alert('連線失敗，請重新整理或重啟伺服器') }
    finally { setFolderSaving(false) }
  }

  async function handleDeleteFolder(id: number, name: string) {
    if (!confirm(`刪除資料夾「${name}」？內部文件將移至未分類。`)) return
    await fetch(`/api/knowledge/folders/${id}`, { method: 'DELETE' })
    if (selectedFolderId === id) selectFolder('all')
    loadFolders(); loadAllDocs()
  }

  function openAddDoc() {
    setFormName(''); setFormType('lark_wiki'); setFormUrl(''); setFormText('')
    setFormTags(''); setFormFile(null); setFormError('')
    setFormFolderId(typeof selectedFolderId === 'number' ? selectedFolderId : null)
    setShowAddDoc(true)
  }

  async function handleSaveDoc() {
    if (!formName.trim()) { setFormError('請填入名稱'); return }
    if (formType === 'file_upload' && !formFile) { setFormError('請選擇要上傳的文件'); return }
    if (formType !== 'text' && formType !== 'file_upload' && !formUrl.trim()) { setFormError('請填入來源 URL'); return }
    if (formType === 'text' && !formText.trim()) { setFormError('請貼上文字內容'); return }
    setSaving(true); setFormError('')
    try {
      const tags = formTags.split(',').map(t => t.trim()).filter(Boolean)
      if (formType === 'file_upload' && formFile) {
        const fd = new FormData()
        fd.append('file', formFile)
        fd.append('name', formName.trim())
        fd.append('tags', JSON.stringify(tags))
        if (formFolderId != null) fd.append('folder_id', String(formFolderId))
        const r = await fetch('/api/knowledge/docs/upload', { method: 'POST', body: fd })
        const d = await r.json() as { ok: boolean; error?: string }
        if (!d.ok) { setFormError(d.error ?? '上傳失敗'); return }
      } else {
        const body: Record<string, unknown> = { name: formName.trim(), type: formType, tags, folder_id: formFolderId ?? null }
        if (formType === 'text') body.text_content = formText
        else body.source_url = formUrl.trim()
        const r = await fetch('/api/knowledge/docs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        const d = await r.json() as { ok: boolean; error?: string }
        if (!d.ok) { setFormError(d.error ?? '儲存失敗'); return }
      }
      setShowAddDoc(false)
      loadFolders(); loadAllDocs(); loadDocs(selectedFolderId)
    } finally { setSaving(false) }
  }

  async function handleRefresh(id: number) {
    setRefreshingId(id)
    try {
      const r = await fetch(`/api/knowledge/docs/${id}/refresh`, { method: 'POST' })
      const d = await r.json() as { ok: boolean; error?: string }
      if (!d.ok) alert(`重抓失敗：${d.error}`)
      else { loadAllDocs(); loadDocs(selectedFolderId) }
    } finally { setRefreshingId(null) }
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`確定刪除「${name}」？`)) return
    setDeletingId(id)
    try {
      await fetch(`/api/knowledge/docs/${id}`, { method: 'DELETE' })
      loadFolders(); loadAllDocs(); loadDocs(selectedFolderId)
    } finally { setDeletingId(null) }
  }

  function openEditDoc(doc: KnowledgeDoc) {
    setEditDoc(doc)
    setEditName(doc.name)
    setEditTags(parseTags(doc.tags).join(', '))
    setEditFolderId(doc.folder_id)
    setEditUrl(doc.source_url ?? '')
    setEditError('')
  }

  async function handleSaveEdit() {
    if (!editDoc) return
    if (!editName.trim()) { setEditError('名稱不能為空'); return }
    setEditSaving(true)
    setEditError('')
    try {
      const tags = editTags.split(',').map(t => t.trim()).filter(Boolean)
      const body: Record<string, unknown> = { name: editName.trim(), tags, folder_id: editFolderId }
      if (editDoc.type !== 'file_upload') body.source_url = editUrl.trim() || null
      const r = await fetch(`/api/knowledge/docs/${editDoc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json() as { ok: boolean; error?: string }
      if (!d.ok) { setEditError(d.error ?? '儲存失敗'); return }
      setEditDoc(null)
      await Promise.all([loadAllDocs(), loadDocs(selectedFolderId)])
    } catch {
      setEditError('儲存失敗')
    } finally {
      setEditSaving(false)
    }
  }

  async function handlePreview(id: number, name: string) {
    setPreviewLoading(true)
    setPreviewDoc({ id, name, content: '載入中...' })
    try {
      const r = await fetch(`/api/knowledge/docs/${id}/content`)
      const d = await r.json() as { ok: boolean; content?: string; error?: string }
      setPreviewDoc({ id, name, content: d.ok ? (d.content ?? '') : `載入失敗：${d.error}` })
    } finally { setPreviewLoading(false) }
  }

  const filteredDocs = docs.filter(doc => {
    const matchName = !search || doc.name.toLowerCase().includes(search.toLowerCase())
    const matchType = !typeFilter || doc.type === typeFilter
    return matchName && matchType
  })

  const currentFolder = typeof selectedFolderId === 'number' ? folders.find(f => f.id === selectedFolderId) : null

  return (
    <div style={{ padding: '20px 28px', maxWidth: 1280, margin: '0 auto' }}>

      {/* ── Folder tabs bar ── */}
      <div className="section-card" style={{ marginBottom: 20, padding: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>

          <FolderTab label="全部" count={effectiveTotal}
            active={selectedFolderId === 'all'} onClick={() => selectFolder('all')} />

          <FolderTab label="未分類" count={effectiveUnclassified}
            active={selectedFolderId === null} onClick={() => selectFolder(null)} />

          {folders.map(f => (
            <FolderTab key={f.id} label={f.name}
              count={allDocs.filter(d => d.folder_id === f.id).length}
              color={FOLDER_COLORS[f.color]}
              active={selectedFolderId === f.id}
              onClick={() => selectFolder(f.id)}
              onDelete={() => handleDeleteFolder(f.id, f.name)} />
          ))}

          <div style={{ width: 1, height: 22, background: '#2d3f55', margin: '0 4px' }} />

          {/* Add folder inline */}
          {showAddFolder ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input autoFocus value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddFolder(); if (e.key === 'Escape') setShowAddFolder(false) }}
                placeholder="資料夾名稱..."
                style={{ background: '#162032', border: '1px solid #3b82f6', borderRadius: 6, color: '#e2e8f0', padding: '5px 10px', fontSize: 13, outline: 'none', width: 140 }} />
              {Object.entries(FOLDER_COLORS).map(([key, hex]) => (
                <span key={key} onClick={() => setNewFolderColor(key)}
                  style={{ width: 14, height: 14, borderRadius: '50%', background: hex, cursor: 'pointer', flexShrink: 0, border: newFolderColor === key ? '2px solid #fff' : '2px solid transparent' }} />
              ))}
              <button onClick={handleAddFolder} disabled={folderSaving}
                style={{ background: '#2563eb', border: 'none', borderRadius: 6, color: '#fff', padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                {folderSaving ? '...' : '確認'}
              </button>
              <button onClick={() => setShowAddFolder(false)}
                style={{ background: 'transparent', border: '1px solid #2d3f55', borderRadius: 6, color: '#64748b', padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>取消</button>
            </div>
          ) : (
            <button onClick={() => setShowAddFolder(true)}
              style={{ background: 'transparent', border: '1px dashed #3b4d6a', borderRadius: 6, color: '#94a3b8', padding: '5px 12px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
              ＋ 新增資料夾
            </button>
          )}
        </div>
      </div>

      {/* ── Doc list card ── */}
      <div className="section-card">
        {/* Card header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <h2 className="section-title" style={{ fontSize: 15, marginBottom: 0 }}>
              {selectedFolderId === 'all' && '全部文件'}
              {selectedFolderId === null && '未分類'}
              {currentFolder && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: FOLDER_COLORS[currentFolder.color], display: 'inline-block' }} />
                  {currentFolder.name}
                </span>
              )}
              <span style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8', marginLeft: 10 }}>
                {filteredDocs.length} 份文件
              </span>
            </h2>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 搜尋名稱..."
              style={{ background: '#162032', border: '1px solid #2d3f55', borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 13, outline: 'none', width: 180 }} />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              style={{ background: '#162032', border: '1px solid #2d3f55', borderRadius: 6, color: '#94a3b8', padding: '6px 10px', fontSize: 13, outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              <option value="">全部類型</option>
              <option value="lark_wiki">Lark Wiki</option>
              <option value="pdf">PDF URL</option>
              <option value="google_doc">Google Doc</option>
              <option value="file_upload">上傳文件</option>
              <option value="text">純文字</option>
            </select>
            <button className="submit-btn" onClick={openAddDoc}
              style={{ padding: '7px 18px', fontSize: 13, whiteSpace: 'nowrap', width: 'auto' }}>
              ＋ 新增文件
            </button>
          </div>
        </div>

        {/* Table */}
        {docsLoading ? (
          <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: '48px 0' }}>載入中...</div>
        ) : filteredDocs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 20px', color: '#334155' }}>
            <div style={{ fontSize: 36, marginBottom: 12, opacity: .35 }}>📂</div>
            <div style={{ fontSize: 14, color: '#475569', marginBottom: 6 }}>
              {search || typeFilter ? '沒有符合篩選條件的文件' : '這個資料夾還是空的'}
            </div>
            {!search && !typeFilter && (
              <div style={{ fontSize: 12, color: '#334155' }}>點擊右上角「＋ 新增文件」加入第一份規格書</div>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}></th>
                  <th>文件名稱</th>
                  <th style={{ width: 96 }}>類型</th>
                  <th>標籤</th>
                  <th style={{ width: 180 }}>快取狀態</th>
                  <th style={{ width: 150, textAlign: 'left' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocs.map(doc => {
                  const tags = parseTags(doc.tags)
                  const days = daysSince(doc.cached_at)
                  const stale = days >= 7
                  const isRefreshing = refreshingId === doc.id
                  const isDeleting = deletingId === doc.id
                  return (
                    <tr key={doc.id}>
                      <td style={{ textAlign: 'center', fontSize: 16 }}>{TYPE_ICONS[doc.type]}</td>
                      <td>
                        <div onClick={() => handlePreview(doc.id, doc.name)}
                          style={{ color: '#cbd5e1', fontWeight: 500, fontSize: 13, cursor: 'pointer', marginBottom: 3 }}
                          onMouseEnter={e => (e.currentTarget.style.color = '#93c5fd')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#cbd5e1')}>
                          {doc.name}
                        </div>
                        {doc.source_url && (
                          <div style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }}>
                            {doc.source_url.replace(/^https?:\/\//, '').slice(0, 65)}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${
                          doc.type === 'lark_wiki' ? 'badge--blue' :
                          doc.type === 'pdf' ? 'badge--error' :
                          doc.type === 'google_doc' ? 'badge--ok' :
                          doc.type === 'file_upload' ? 'badge--warn' : ''
                        }`} style={{ fontSize: 11, padding: '2px 7px' }}>
                          {TYPE_LABELS[doc.type]}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {tags.map(t => (
                            <span key={t} style={{ fontSize: 11, padding: '1px 7px', background: '#1e293b', color: '#94a3b8', borderRadius: 4, border: '1px solid #3b4d6a', whiteSpace: 'nowrap' }}>{t}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: stale && doc.cached_at ? '#fbbf24' : '#94a3b8', whiteSpace: 'nowrap' }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: doc.cached_at ? (stale ? '#fbbf24' : '#22c55e') : '#64748b', flexShrink: 0 }} />
                          {doc.cached_at
                            ? `${fmtSize(doc.content_length)} · ${fmtDate(doc.cached_at)}${stale ? ' ⚠' : ''}`
                            : '無快取'}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-start', flexWrap: 'nowrap' }}>
                          {doc.content_length > 0 && (
                            <button className="btn-ghost btn-ghost--step" style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => handlePreview(doc.id, doc.name)}>預覽</button>
                          )}
                          {doc.type !== 'text' && doc.type !== 'file_upload' && (
                            <button className="btn-ghost btn-ghost--step" style={{ padding: '4px 10px', fontSize: 12 }}
                              disabled={isRefreshing} onClick={() => handleRefresh(doc.id)}>
                              {isRefreshing ? '⏳' : '重抓'}
                            </button>
                          )}
                          <button className="btn-ghost btn-ghost--step" style={{ padding: '4px 10px', fontSize: 12 }}
                            onClick={() => openEditDoc(doc)}>編輯</button>
                          <button disabled={isDeleting} onClick={() => handleDelete(doc.id, doc.name)}
                            style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 5, color: '#f87171', padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                            {isDeleting ? '...' : '刪除'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add Doc Modal ── */}
      {showAddDoc && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddDoc(false) }}>
          <div style={{ background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 12, width: '100%', maxWidth: 560, boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 22px', borderBottom: '1px solid #2d3f55' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>新增知識庫文件</span>
              <button onClick={() => setShowAddDoc(false)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Name */}
              <FormRow label="名稱 *">
                <input value={formName} onChange={e => setFormName(e.target.value)}
                  placeholder="自訂名稱，供選單顯示" style={mInput} />
              </FormRow>
              {/* Folder + Type side by side */}
              <div style={{ display: 'flex', gap: 12 }}>
                <FormRow label="資料夾" style={{ flex: 1 }}>
                  <select value={formFolderId ?? ''} onChange={e => setFormFolderId(e.target.value ? Number(e.target.value) : null)} style={mInput}>
                    <option value="">未分類</option>
                    {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </FormRow>
                <FormRow label="類型" style={{ flex: 1 }}>
                  <select value={formType} onChange={e => { setFormType(e.target.value as KnowledgeDoc['type']); setFormFile(null) }} style={mInput}>
                    <option value="lark_wiki">Lark Wiki</option>
                    <option value="pdf">PDF URL</option>
                    <option value="google_doc">Google Doc</option>
                    <option value="text">純文字貼上</option>
                    <option value="file_upload">上傳文件</option>
                  </select>
                </FormRow>
              </div>
              {/* Dynamic content field */}
              {formType === 'file_upload' ? (
                <FormRow label="上傳文件 *">
                  <div onClick={() => fileInputRef.current?.click()}
                    style={{ border: `2px dashed ${formFile ? '#3b82f6' : '#2d3f55'}`, borderRadius: 8, padding: '20px 16px', textAlign: 'center', cursor: 'pointer', background: formFile ? 'rgba(59,130,246,.05)' : 'transparent' }}>
                    {formFile ? (
                      <>
                        <div style={{ fontSize: 22, marginBottom: 4 }}>📄</div>
                        <div style={{ fontSize: 14, color: '#93c5fd', fontWeight: 600 }}>{formFile.name}</div>
                        <div style={{ fontSize: 11, color: '#475569', marginTop: 3 }}>{(formFile.size / 1024).toFixed(0)} KB · 點擊更換</div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 28, marginBottom: 6, opacity: .5 }}>📂</div>
                        <div style={{ fontSize: 13, color: '#64748b' }}>點擊選擇文件</div>
                        <div style={{ fontSize: 11, color: '#334155', marginTop: 4 }}>PDF / Word (.docx) / HTML，最大 20MB</div>
                      </>
                    )}
                  </div>
                  <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.html,.htm" style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null; setFormFile(f)
                      if (f && !formName.trim()) setFormName(f.name.replace(/\.[^.]+$/, ''))
                    }} />
                </FormRow>
              ) : formType !== 'text' ? (
                <FormRow label="來源 URL *">
                  <input value={formUrl} onChange={e => setFormUrl(e.target.value)}
                    placeholder={formType === 'lark_wiki' ? 'https://xxx.feishu.cn/wiki/...' : formType === 'pdf' ? 'https://example.com/spec.pdf' : 'https://docs.google.com/document/d/...'}
                    style={mInput} />
                </FormRow>
              ) : (
                <FormRow label="內容 *">
                  <textarea value={formText} onChange={e => setFormText(e.target.value)}
                    placeholder="貼上文字內容..." rows={5}
                    style={{ ...mInput, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' as const }} />
                </FormRow>
              )}
              {/* Tags */}
              <FormRow label="標籤">
                <input value={formTags} onChange={e => setFormTags(e.target.value)}
                  placeholder="逗號分隔，例：百家樂, 規格書, v2.3" style={mInput} />
              </FormRow>
              {formError && <div style={{ color: '#f87171', fontSize: 13, marginTop: -6 }}>❌ {formError}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 22px', borderTop: '1px solid #2d3f55' }}>
              <button className={`submit-btn${saving ? ' loading' : ''}`} onClick={handleSaveDoc} disabled={saving}
                style={{ padding: '8px 22px', fontSize: 13, width: 'auto' }}>
                {saving ? '⏳ 處理中...' : '抓取並儲存'}
              </button>
              <button onClick={() => setShowAddDoc(false)}
                style={{ background: 'transparent', border: '1px solid #2d3f55', borderRadius: 6, color: '#64748b', padding: '7px 14px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                取消
              </button>
              <span style={{ fontSize: 11, color: '#334155' }}>抓取後自動快取純文字</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Preview Modal ── */}
      {previewDoc && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setPreviewDoc(null) }}>
          <div style={{ background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 12, width: '100%', maxWidth: 800, maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,.55)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 22px', borderBottom: '1px solid #2d3f55', flexShrink: 0 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0' }}>👁 預覽：{previewDoc.name}</div>
                <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>快取純文字內容（AI 批次評論時使用的資料）</div>
              </div>
              <button onClick={() => setPreviewDoc(null)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px' }}>
              {previewLoading
                ? <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: 40 }}>載入中...</div>
                : <pre style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'monospace' }}>{previewDoc.content || '（無內容）'}</pre>
              }
            </div>
            <div style={{ padding: '10px 22px', borderTop: '1px solid #2d3f55', fontSize: 11, color: '#334155', flexShrink: 0 }}>
              共 {previewDoc.content.length.toLocaleString()} 字 · 點擊外部或 × 關閉
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Doc Modal ── */}
      {editDoc && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setEditDoc(null) }}>
          <div style={{ background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 12, width: '100%', maxWidth: 520, boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 22px', borderBottom: '1px solid #2d3f55' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>編輯文件</span>
              <button onClick={() => setEditDoc(null)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <FormRow label="名稱 *">
                <input value={editName} onChange={e => setEditName(e.target.value)} style={mInput} />
              </FormRow>
              <FormRow label="資料夾">
                <select value={editFolderId ?? ''} onChange={e => setEditFolderId(e.target.value ? Number(e.target.value) : null)} style={mInput}>
                  <option value="">未分類</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </FormRow>
              {editDoc.type !== 'file_upload' && (
                <FormRow label="來源 URL">
                  <input value={editUrl} onChange={e => setEditUrl(e.target.value)} style={mInput} />
                </FormRow>
              )}
              <FormRow label="標籤">
                <input value={editTags} onChange={e => setEditTags(e.target.value)}
                  placeholder="逗號分隔，例：百家樂, 規格書" style={mInput} />
              </FormRow>
              {editError && <div style={{ color: '#f87171', fontSize: 13, marginTop: -6 }}>❌ {editError}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 22px', borderTop: '1px solid #2d3f55' }}>
              <button className={`submit-btn${editSaving ? ' loading' : ''}`} onClick={() => void handleSaveEdit()} disabled={editSaving}
                style={{ padding: '8px 22px', fontSize: 13, width: 'auto' }}>
                {editSaving ? '⏳ 儲存中...' : '儲存'}
              </button>
              <button onClick={() => setEditDoc(null)}
                style={{ background: 'transparent', border: '1px solid #2d3f55', borderRadius: 6, color: '#64748b', padding: '7px 14px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── FolderTab ─────────────────────────────────────────────────────────────────

function FolderTab({ label, count, color, active, onClick, onDelete }: {
  label: string; count: number; color?: string; active: boolean
  onClick: () => void; onDelete?: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button onClick={onClick}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: onDelete ? '6px 28px 6px 12px' : '6px 12px',
          borderRadius: 7, border: `1px solid ${active ? (color ?? '#6366f1') : '#2d3f55'}`,
          background: active ? (color ? `${color}22` : 'rgba(99,102,241,.15)') : hover ? 'rgba(255,255,255,.04)' : 'transparent',
          color: active ? (color ?? '#a5b4fc') : '#94a3b8',
          fontSize: 13, cursor: 'pointer', fontWeight: active ? 600 : 400, transition: 'all .12s',
          whiteSpace: 'nowrap' as const, fontFamily: 'inherit',
        }}>
        {color && <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />}
        {label}
        <span style={{
          fontSize: 11, borderRadius: 9, padding: '0 6px', minWidth: 18, textAlign: 'center',
          background: active ? (color ? `${color}33` : 'rgba(99,102,241,.25)') : '#1e293b',
          color: active ? (color ?? '#a5b4fc') : '#94a3b8',
        }}>{count}</span>
      </button>
      {onDelete && hover && (
        <button onClick={e => { e.stopPropagation(); onDelete() }} title="刪除資料夾"
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '1px 2px', fontFamily: 'inherit' }}>
          ×
        </button>
      )}
    </div>
  )
}

// ── FormRow ───────────────────────────────────────────────────────────────────

function FormRow({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, ...style }}>
      <span style={{ fontSize: 12, color: '#64748b' }}>{label}</span>
      {children}
    </div>
  )
}

const mInput: React.CSSProperties = {
  width: '100%', background: '#162032', border: '1px solid #2d3f55',
  borderRadius: 6, color: '#e2e8f0', padding: '8px 11px', fontSize: 13, outline: 'none',
  fontFamily: 'inherit',
}

import { useEffect, useRef, useState } from 'react'
import { XianxiaIcon, type XianxiaIconName } from '../components/XianxiaIcon'
import Portal from '../components/Portal'

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
const TYPE_ICONS: Record<string, XianxiaIconName> = {
  lark_wiki: 'knowledge', pdf: 'document', google_doc: 'knowledge', text: 'document', file_upload: 'guide',
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
    <div className="st-kb">
      {/* 新版（原型 v7）：資料夾＝原型 .tabs（不包面板）；清單面板＝標題帶＋寬工具列＋表格，操作欄是文字連結。樣式在 redesign/pages/settings.css */}

      {/* ── Folder tabs bar ── */}
      <div className="rd-tabs kb-tabs" role="tablist">
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

        {/* Add folder inline */}
        {showAddFolder ? (
          <div className="kb-addfolder">
            <input autoFocus value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddFolder(); if (e.key === 'Escape') setShowAddFolder(false) }}
              placeholder="資料夾名稱..."
              className="lst-field lst-field--sm kb-addfolder-input" />
            {Object.entries(FOLDER_COLORS).map(([key, hex]) => (
              <span key={key} onClick={() => setNewFolderColor(key)}
                className="kb-color" style={{ background: hex, borderColor: newFolderColor === key ? '#fff' : 'transparent' }} />
            ))}
            <button type="button" onClick={handleAddFolder} disabled={folderSaving} className="lst-sbtn lst-sbtn--info">
              {folderSaving ? '...' : '確認'}
            </button>
            <button type="button" onClick={() => setShowAddFolder(false)} className="lst-sbtn">取消</button>
          </div>
        ) : (
          <button type="button" className="rd-tab kb-tab-add" onClick={() => setShowAddFolder(true)}>
            ＋ 新增資料夾
          </button>
        )}
      </div>

      {/* ── Doc list card ── */}
      <section className="section-card st-card st-raw">
        <h2 className="section-title">
          {selectedFolderId === 'all' && '全部文件'}
          {selectedFolderId === null && '未分類'}
          {currentFolder && (
            <span className="kb-title-folder">
              <span className="kb-dot" style={{ background: FOLDER_COLORS[currentFolder.color] }} />
              {currentFolder.name}
            </span>
          )}
          <span className="st-meta">{filteredDocs.length} 份文件</span>
        </h2>
        <div className="lst-toolbar">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋名稱..."
            className="lst-field st-grow" aria-label="搜尋名稱" />
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="lst-field kb-type" aria-label="類型">
            <option value="">全部類型</option>
            <option value="lark_wiki">Lark Wiki</option>
            <option value="pdf">PDF URL</option>
            <option value="google_doc">Google Doc</option>
            <option value="file_upload">上傳文件</option>
            <option value="text">純文字</option>
          </select>
          <button type="button" className="submit-btn lst-btn" onClick={openAddDoc}>
            ＋ 新增文件
          </button>
        </div>

        {/* Table */}
        {docsLoading ? (
          <div className="lst-empty">載入中...</div>
        ) : filteredDocs.length === 0 ? (
          <div className="lst-empty kb-empty">
            <div className="kb-empty-t">
              {search || typeFilter ? '沒有符合篩選條件的文件' : '這個資料夾還是空的'}
            </div>
            {!search && !typeFilter && (
              <div className="st-hint">點擊右上角「＋ 新增文件」加入第一份規格書</div>
            )}
          </div>
        ) : (
          <div className="table-wrap lst-tbl">
            <table className="version-table st-tbl kb-table">
              <thead>
                <tr>
                  <th className="kb-ic-col"></th>
                  <th>文件名稱</th>
                  <th>類型</th>
                  <th>標籤</th>
                  <th>快取狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocs.map(doc => {
                  const tags = parseTags(doc.tags)
                  const days = daysSince(doc.cached_at)
                  const stale = days >= 7
                  const isRefreshing = refreshingId === doc.id
                  const isDeleting = deletingId === doc.id
                  const actions: React.ReactNode[] = []
                  if (doc.content_length > 0) actions.push(
                    <button key="pv" type="button" className="lst-link" onClick={() => handlePreview(doc.id, doc.name)}>預覽</button>)
                  if (doc.type !== 'text' && doc.type !== 'file_upload') actions.push(
                    <button key="rf" type="button" className="lst-link" disabled={isRefreshing} onClick={() => handleRefresh(doc.id)}>
                      {isRefreshing ? '重抓中…' : '重抓'}
                    </button>)
                  actions.push(<button key="ed" type="button" className="lst-link" onClick={() => openEditDoc(doc)}>編輯</button>)
                  actions.push(
                    <button key="del" type="button" className="lst-link st-link--danger" disabled={isDeleting} onClick={() => handleDelete(doc.id, doc.name)}>
                      {isDeleting ? '...' : '刪除'}
                    </button>)
                  return (
                    <tr key={doc.id}>
                      <td className="kb-ic-col"><XianxiaIcon name={TYPE_ICONS[doc.type]} size={22} /></td>
                      <td>
                        <button type="button" className="kb-name" onClick={() => handlePreview(doc.id, doc.name)}>
                          {doc.name}
                        </button>
                        {doc.source_url && (
                          <div className="kb-url">
                            {doc.source_url.replace(/^https?:\/\//, '').slice(0, 65)}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`lst-pill kb-src kb-src--${doc.type} ${
                          doc.type === 'lark_wiki' ? 'lst-pill--run' :
                          doc.type === 'pdf' ? 'lst-pill--fail' :
                          doc.type === 'google_doc' ? 'lst-pill--pass' :
                          doc.type === 'file_upload' ? 'lst-pill--warn' : ''
                        }`}>
                          {TYPE_LABELS[doc.type]}
                        </span>
                      </td>
                      <td>
                        <div className="lst-tags kb-tags">
                          {tags.map(t => <span key={t} className="lst-tag">{t}</span>)}
                          {!tags.length && <span className="st-dim">—</span>}
                        </div>
                      </td>
                      <td>
                        <span className={`lst-pill ${doc.cached_at ? (stale ? 'lst-pill--warn' : 'lst-pill--pass') : ''}`}>
                          {doc.cached_at
                            ? `${fmtSize(doc.content_length)} · ${fmtDate(doc.cached_at)}${stale ? '（已過期）' : ''}`
                            : '無快取'}
                        </span>
                      </td>
                      <td>
                        <div className="st-links">
                          {actions.map((a, i) => <span key={i} className="st-links-i">{i > 0 && <span className="st-dot" aria-hidden="true">·</span>}{a}</span>)}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Add Doc Modal ── */}
      {showAddDoc && (
        <Portal>
        <div className="rd-modal-back"
          onClick={e => { if (e.target === e.currentTarget) setShowAddDoc(false) }}>
          <div className="rd-modal" role="dialog" aria-modal="true" style={{ width: 580 }}>
            <div className="rd-modal-h">
              <span>新增知識庫文件</span>
              <button className="rd-modal-x" onClick={() => setShowAddDoc(false)}>關閉</button>
            </div>
            <div className="rd-modal-b rd-modal-stack">
              {/* Name */}
              <FormRow label="名稱 *">
                <input value={formName} onChange={e => setFormName(e.target.value)}
                  placeholder="自訂名稱，供選單顯示" style={mInput} />
              </FormRow>
              {/* Folder + Type side by side */}
              <div className="rd-row-group" style={{ display: 'flex', gap: 12 }}>
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
                        <div style={{ fontSize: 14, color: '#93c5fd', fontWeight: 600 }}>{formFile.name}</div>
                        <div style={{ fontSize: 11, color: '#475569', marginTop: 3 }}>{(formFile.size / 1024).toFixed(0)} KB · 點擊更換</div>
                      </>
                    ) : (
                      <>
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
              {formError && <div className="rd-modal-err">{formError}</div>}
            </div>
            <div className="rd-modal-f">
              <span className="rd-modal-f-note">抓取後自動快取純文字</span>
              <button className="rd-btn" onClick={() => setShowAddDoc(false)}>
                取消
              </button>
              <button className="rd-btn is-primary" onClick={handleSaveDoc} disabled={saving}>
                {saving ? '處理中...' : '抓取並儲存'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Preview Modal ── */}
      {previewDoc && (
        <Portal>
        <div className="rd-modal-back"
          onClick={e => { if (e.target === e.currentTarget) setPreviewDoc(null) }}>
          <div className="rd-modal rd-modal--wide" role="dialog" aria-modal="true" style={{ width: 800, maxHeight: '82vh' }}>
            <div className="rd-modal-h">
              <span>預覽：{previewDoc.name}</span>
              <small className="rd-modal-meta">快取純文字內容（AI 批次評論時使用的資料）</small>
              <button className="rd-modal-x" style={{ marginLeft: 12 }} onClick={() => setPreviewDoc(null)}>關閉</button>
            </div>
            <div className="rd-modal-b">
              {previewLoading
                ? <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: 40 }}>載入中...</div>
                : <pre style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'monospace' }}>{previewDoc.content || '（無內容）'}</pre>
              }
            </div>
            <div className="rd-modal-f" style={{ justifyContent: 'flex-start' }}>
              共 {previewDoc.content.length.toLocaleString()} 字 · 點擊外部或「關閉」關閉
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Edit Doc Modal ── */}
      {editDoc && (
        <Portal>
        <div className="rd-modal-back"
          onClick={e => { if (e.target === e.currentTarget) setEditDoc(null) }}>
          <div className="rd-modal" role="dialog" aria-modal="true" style={{ width: 540 }}>
            <div className="rd-modal-h">
              <span>編輯文件</span>
              <button className="rd-modal-x" onClick={() => setEditDoc(null)}>關閉</button>
            </div>
            <div className="rd-modal-b rd-modal-stack">
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
              {editError && <div className="rd-modal-err">{editError}</div>}
            </div>
            <div className="rd-modal-f">
              <button className="rd-btn" onClick={() => setEditDoc(null)}>
                取消
              </button>
              <button className="rd-btn is-primary" onClick={() => void handleSaveEdit()} disabled={editSaving}>
                {editSaving ? '儲存中...' : '儲存'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  )
}

// ── FolderTab ─────────────────────────────────────────────────────────────────

function FolderTab({ label, count, color, active, onClick, onDelete }: {
  label: string; count: number; color?: string; active: boolean
  onClick: () => void; onDelete?: () => void
}) {
  // 新版：原型 .tab（選中＝強調色漸層），資料夾顏色只留前面的小圓點；數字照原型放括號裡
  return (
    <div className={`kb-tab-wrap${onDelete ? ' has-del' : ''}`}>
      <button type="button" role="tab" className="rd-tab kb-tab" aria-selected={active} onClick={onClick}>
        {color && <span className="kb-dot" style={{ background: color }} />}
        {label}
        <span className="kb-count">({count})</span>
      </button>
      {onDelete && (
        <button type="button" className="kb-tab-del" onClick={e => { e.stopPropagation(); onDelete() }} title="刪除資料夾">
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
      <span className="rd-l" style={{ fontSize: 12, color: '#64748b' }}>{label}</span>
      {children}
    </div>
  )
}

const mInput: React.CSSProperties = {
  width: '100%', background: '#162032', border: '1px solid #2d3f55',
  borderRadius: 6, color: '#e2e8f0', padding: '8px 11px', fontSize: 13, outline: 'none',
  fontFamily: 'inherit',
}

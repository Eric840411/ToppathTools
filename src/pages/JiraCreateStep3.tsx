import { ModelSelector } from '../components/ModelSelector'
import { StepGuide, ReloadSheetButton } from '../components/JiraStepWidgets'
import type { AccountInfo } from '../components/JiraAccountModal'
import {
  UserFieldSearch, getField, needsCreate, stageBadgeClass, stageLabel, SHEET_FIELD,
} from './JiraPage'
import type { SheetRecord, NormalizedJiraField, CachedAttachment } from './JiraPage'

/**
 * 批量開單 Step 3（動態欄位開單）——這個流程最大最複雜的一段：欄位選擇器、
 * 批量填入面板、AI 摘要生成面板、逐列動態欄位表格（含附件上傳）、Lark 原始
 * 資料 fallback 表格。純畫面元件，狀態留在 JiraPage.tsx 以 props 傳入。
 *
 * JSX 內容是直接從 JiraPage.tsx 用 sed 逐行搬過來的（不是手動重打），
 * 避免大範圍手動搬移時手滑打錯字的風險。
 *
 * getField/needsCreate/stageBadgeClass/stageLabel/SHEET_FIELD/UserFieldSearch
 * 都是 module-level 的純函式/元件（沒有閉包依賴 JiraPage 內部 state），直接
 * export 後在這裡 import，不需要當 props 傳。
 */
export function JiraCreateStep3(props: {
  fieldsLoading: boolean
  jiraFields: NormalizedJiraField[]
  filteredRecords: SheetRecord[]
  selectedRows: Set<number>
  setSelectedRows: (fn: (prev: Set<number>) => Set<number>) => void
  fieldsError: string
  sheetLoading: boolean
  createReloadMsg: string
  handleReloadCreateSheet: () => void
  larkPrefillApplied: boolean
  applyLarkPrefill: () => void
  cellErrors: Record<number, Record<string, string>>
  renderSummaryPrefixPanel: (headers: string[], records?: Array<Record<string, unknown>>, summaryColKey?: string) => React.ReactNode
  sheetHeaders: string[]
  filterableColumns: string[]
  columnFilters: Record<string, string>
  setColumnFilters: (v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void
  columnUniqueValues: Record<string, string[]>
  planCreate: SheetRecord[]
  planComment: SheetRecord[]
  planTransition: SheetRecord[]
  sheetRecords: SheetRecord[]
  showFieldPicker: boolean
  setShowFieldPicker: (v: boolean | ((prev: boolean) => boolean)) => void
  fieldPickerSearch: string
  setFieldPickerSearch: (v: string) => void
  inactiveOptionalJiraFields: NormalizedJiraField[]
  setActiveOptionalKeys: (fn: (prev: string[]) => string[]) => void
  showBulkPanel: boolean
  setShowBulkPanel: (fn: (prev: boolean) => boolean) => void
  visibleJiraFields: NormalizedJiraField[]
  bulkValues: Record<string, string>
  setBulkValues: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  isFieldRequired: (f: NormalizedJiraField) => boolean
  userLabelForField: (field: NormalizedJiraField, accountId: string) => string
  userOptionsForField: (field: NormalizedJiraField) => { id: string; label: string }[]
  searchProjectKey: string
  selectedIssueTypeId: string
  searchIssueTypeName: string
  currentAccount: AccountInfo | null
  mergeFieldUsers: (fieldKey: string, users: { id: string; label: string }[]) => void
  applyBulkColumn: (fieldKey: string, val: string) => void
  aiSummaryEnabled: boolean
  setAiSummaryEnabled: (fn: (prev: boolean) => boolean) => void
  aiPrefixColumns: string[]
  setAiPrefixColumns: (fn: (prev: string[]) => string[]) => void
  aiContentColumn: string
  setAiContentColumn: (v: string) => void
  aiSummaryModel: string
  setAiSummaryModel: (v: string) => void
  summaryGenerating: boolean
  handleGenerateSummaries: () => void
  summaryProgress: { done: number; total: number; failed?: number } | null
  generatedSummaries: Record<number, string>
  setGeneratedSummaries: (v: Record<number, string> | ((prev: Record<number, string>) => Record<number, string>)) => void
  setSummaryProgress: (v: { done: number; total: number; failed?: number } | null) => void
  requiredJiraFields: NormalizedJiraField[]
  activeOptionalJiraFields: NormalizedJiraField[]
  descPrefetchLoading: boolean
  cellValues: Record<number, Record<string, string>>
  setCellValue: (rowIdx: number, fieldKey: string, value: string) => void
  toggleMultiuser: (rowIdx: number, fieldKey: string, accountId: string) => void
  toggleRow: (i: number) => void
  descAttachMap: Record<number, CachedAttachment[]>
  setDescAttachMap: (fn: (prev: Record<number, CachedAttachment[]>) => Record<number, CachedAttachment[]>) => void
  descUploadErrors: Record<number, string>
  setDescUploadErrors: (fn: (prev: Record<number, string>) => Record<number, string>) => void
  emailHeader: Record<string, string>
  setDescLightboxSrc: (v: string | null) => void
  members: { accountId: string; displayName: string; avatarUrl: string }[]
  createProgress: { done: number; total: number } | null
  submitting: boolean
  setStep: (v: 1 | 2 | 3 | 4) => void
  handleCreate: () => void
}) {
  const {
    fieldsLoading, jiraFields, filteredRecords, selectedRows, setSelectedRows, fieldsError, sheetLoading,
    createReloadMsg, handleReloadCreateSheet, larkPrefillApplied, applyLarkPrefill, cellErrors,
    renderSummaryPrefixPanel, sheetHeaders, filterableColumns, columnFilters, setColumnFilters,
    columnUniqueValues, planCreate, planComment, planTransition, sheetRecords,
    showFieldPicker, setShowFieldPicker, fieldPickerSearch, setFieldPickerSearch,
    inactiveOptionalJiraFields, setActiveOptionalKeys, showBulkPanel, setShowBulkPanel, visibleJiraFields,
    bulkValues, setBulkValues, isFieldRequired, userLabelForField, userOptionsForField, searchProjectKey,
    selectedIssueTypeId, searchIssueTypeName, currentAccount, mergeFieldUsers, applyBulkColumn,
    aiSummaryEnabled, setAiSummaryEnabled, aiPrefixColumns, setAiPrefixColumns, aiContentColumn,
    setAiContentColumn, aiSummaryModel, setAiSummaryModel, summaryGenerating, handleGenerateSummaries,
    summaryProgress, generatedSummaries, setGeneratedSummaries, setSummaryProgress, requiredJiraFields,
    activeOptionalJiraFields, descPrefetchLoading, cellValues, setCellValue, toggleMultiuser, toggleRow,
    descAttachMap, setDescAttachMap, descUploadErrors, setDescUploadErrors, emailHeader, setDescLightboxSrc,
    members, createProgress, submitting, setStep, handleCreate,
  } = props

  return (
        <div className="section-card">
          <h2 className="section-title">
            Step 3 — 填寫 Issue 欄位
            {fieldsLoading && <span style={{ fontSize: 12, color: '#64748b', marginLeft: 8, fontWeight: 400 }}>載入欄位定義中...</span>}
            {!fieldsLoading && jiraFields.length > 0 && (
              <span style={{ marginLeft: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                <span style={{ fontSize: 13, color: '#94a3b8' }}>{filteredRecords.length} 筆</span>
                <span style={{ color: '#334155' }}>·</span>
                <span style={{ fontSize: 14, color: '#60a5fa', fontWeight: 600 }}>已勾選 {filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex))).length} 筆</span>
              </span>
            )}
          </h2>

          {fieldsError && <div className="alert-warn" style={{ marginBottom: 12 }}>{fieldsError}</div>}

          {/* Lark pre-fill hint */}
          {jiraFields.length > 0 ? (
            <div style={{ background: '#162130', border: '1px solid #ca8a0440', borderRadius: 8, padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#fde047', fontWeight: 600 }}>可選：從 Lark 帶入預填值</span>
              <span style={{ fontSize: 11, color: '#64748b', flex: 1 }}>系統會嘗試用 Lark 欄名對應 Jira field，對不上的欄位需手動填寫；重新讀取 Sheet 後會自動重新帶入。</span>
              <ReloadSheetButton loading={sheetLoading} msg={createReloadMsg} onClick={handleReloadCreateSheet} />
              <button type="button"
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid #ca8a0460', background: larkPrefillApplied ? '#16a34a20' : '#ca8a0420', color: larkPrefillApplied ? '#4ade80' : '#fde047', cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={applyLarkPrefill}>
                {larkPrefillApplied ? '通過 已帶入（可重新帶入）' : '從 Lark 帶入'}
              </button>
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <ReloadSheetButton loading={sheetLoading} msg={createReloadMsg} onClick={handleReloadCreateSheet} />
            </div>
          )}

          <StepGuide title="操作說明 — 填寫與帶入欄位">
            <li>表格欄位由 Jira <code>createmeta</code> 即時載入，摘要/描述/受託人/RD負責人/回報人 自動顯示為必填</li>
            <li>點「冊 從 Lark 帶入」可用 Sheet 欄名自動對應 Jira 欄位；對不上的欄位需手動填寫</li>
            <li>可用「AI 生成摘要」：選前綴欄位（組成 [值1][值2]摘要格式）+ 內容來源欄位，批次呼叫 Gemini 產生標題</li>
            <li>「附件」欄可從 Sheet 圖片欄自動讀取，或手動上傳；送出後以 <code>!filename!</code> wiki markup 嵌入描述，影片以 <code>[^filename]</code> 方式嵌入</li>
            <li>有未上傳的影片列，送出前會跳出確認視窗</li>
          </StepGuide>

          {/* Validation error summary */}
          {Object.keys(cellErrors).length > 0 && (
            <div className="alert-warn" style={{ marginBottom: 12 }}>
              {Object.keys(cellErrors).length} 列有必填欄位未填，請填寫後再執行（第&nbsp;
              {Object.keys(cellErrors).map(Number).sort((a, b) => a - b).map((idx, i, arr) => (
                <span key={idx}>
                  <span
                    style={{ cursor: 'pointer', textDecoration: 'underline', color: '#fbbf24' }}
                    onClick={() => document.getElementById(`jira-dyn-row-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                  >{idx}</span>{i < arr.length - 1 ? '、' : ''}
                </span>
              ))}
              &nbsp;列）
            </div>
          )}

          {renderSummaryPrefixPanel(sheetHeaders, filteredRecords as Array<Record<string, unknown>>, SHEET_FIELD.summary)}

          {/* 欄位篩選器 */}
          {filterableColumns.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>篩選：</span>
              {filterableColumns.map(col => (
                <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
                  <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{col}</span>
                  <select
                    value={columnFilters[col] ?? ''}
                    onChange={e => setColumnFilters(prev => ({ ...prev, [col]: e.target.value }))}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160 }}>
                    <option value="">全部</option>
                    {(columnUniqueValues[col] ?? []).map((v, i) => (
                      <option key={v || `val-${i}`} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
              ))}
              {Object.values(columnFilters).some(Boolean) && (
                <button type="button"
                  onClick={() => setColumnFilters({})}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                  清除篩選
                </button>
              )}
            </div>
          )}

          {/* Operation plan preview */}
          {selectedRows.size > 0 && (
            <div className="op-plan" style={{ marginBottom: 12 }}>
              <span className="op-plan-title">選取後將執行：</span>
              {planCreate.length > 0 && <span className="badge badge--blue">建立 Issues {planCreate.length} 筆</span>}
              {planComment.length > 0 && <span className="badge badge--ok">添加評論 {planComment.length} 筆（已開單）</span>}
              {planTransition.length > 0 && <span className="badge badge--purple">更新 切換狀態 {planTransition.length} 筆（已評論）</span>}
            </div>
          )}

          {fieldsLoading && (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
              正在向 Jira 載入欄位定義...
            </div>
          )}

          {sheetRecords.length === 0
            ? <div className="alert-warn">沒有待處理的列（所有列皆已完成）</div>
            : jiraFields.length > 0 ? (
              /* ── Dynamic field grid ── */
              <>
                {/* ── 欄位管理區塊 ── */}
                <div style={{ background: '#0d1e30', border: '1px solid #1e3a5f', borderRadius: 10, padding: '12px 16px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>欄位管理</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', position: 'relative' }}>
                    {requiredJiraFields.map(f => (
                      <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#162a40', border: '1px solid #3b82f640', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#7dd3fc' }}>
                        <span style={{ color: '#f87171', fontSize: 10 }}>*</span>
                        {f.name}
                        <span style={{ fontSize: 10, color: '#475569', marginLeft: 2 }}>{f.type}</span>
                      </span>
                    ))}
                    {activeOptionalJiraFields.map(f => (
                      <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#1a2f45', border: '1px solid #2563eb40', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#93c5fd' }}>
                        {f.name}
                        <span style={{ fontSize: 10, color: '#475569', marginLeft: 2 }}>{f.type}</span>
                        <button type="button"
                          title="移除此欄位"
                          onClick={() => setActiveOptionalKeys(prev => prev.filter(k => k !== f.key))}
                          style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 0 0 2px' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#f87171' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#475569' }}>×</button>
                      </span>
                    ))}
                    <div style={{ position: 'relative' }}>
                      <button type="button"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px dashed #2563eb60', background: showFieldPicker ? '#2563eb20' : '#2563eb10', color: '#60a5fa', cursor: 'pointer' }}
                        onClick={() => { setShowFieldPicker(v => !v); setFieldPickerSearch('') }}>
                        + 新增欄位
                      </button>
                      {showFieldPicker && (() => {
                        const q = fieldPickerSearch.trim().toLowerCase()
                        const matched = q
                          ? inactiveOptionalJiraFields.filter(f => f.name.toLowerCase().includes(q) || f.key.toLowerCase().includes(q))
                          : inactiveOptionalJiraFields
                        return (
                        <div style={{ position: 'absolute', top: '100%', left: 0, background: '#1e293b', border: '1px solid #334155', borderRadius: 8, width: 240, zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', marginTop: 6 }}>
                          <div style={{ padding: '8px 12px', borderBottom: '1px solid #334155', fontSize: 12, fontWeight: 600, color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                            新增選填欄位
                            <button type="button" style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer' }} onClick={() => setShowFieldPicker(false)}>關閉</button>
                          </div>
                          <div style={{ padding: '8px 10px', borderBottom: '1px solid #334155' }}>
                            <input
                              autoFocus
                              type="text"
                              value={fieldPickerSearch}
                              onChange={e => setFieldPickerSearch(e.target.value)}
                              placeholder="搜尋欄位名稱..."
                              style={{ width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #334155', borderRadius: 5, color: '#e2e8f0', fontSize: 12, padding: '5px 8px', outline: 'none' }} />
                          </div>
                          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                            {inactiveOptionalJiraFields.length === 0
                              ? <div style={{ padding: '10px 12px', fontSize: 12, color: '#64748b' }}>所有可用欄位都已加入</div>
                              : matched.length === 0
                              ? <div style={{ padding: '10px 12px', fontSize: 12, color: '#64748b' }}>找不到符合「{fieldPickerSearch}」的欄位</div>
                              : matched.map(f => (
                                <button key={f.key} type="button"
                                  style={{ width: '100%', padding: '7px 12px', fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', color: '#cbd5e1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2563eb15' }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                                  onClick={() => { setActiveOptionalKeys(prev => [...prev, f.key]); setShowFieldPicker(false); setFieldPickerSearch('') }}>
                                  <span>{f.name}</span>
                                  <span style={{ color: '#475569', fontSize: 10, fontFamily: 'monospace' }}>{f.type}</span>
                                </button>
                              ))
                            }
                          </div>
                        </div>
                        )
                      })()}
                    </div>
                  </div>
                </div>

                {/* ── 批量填入面板 ── */}
                <div style={{ background: '#0d1e30', border: '1px solid #1e3a5f', borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setShowBulkPanel(v => !v)}>
                    <span style={{ fontSize: 12, color: '#475569', transition: 'transform .2s', display: 'inline-block', transform: showBulkPanel ? 'rotate(90deg)' : 'none' }}>▶</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa' }}>批量填入</span>
                    <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>展開後可一鍵套用至所有篩選列</span>
                  </div>
                  {showBulkPanel && (
                    <div style={{ padding: '12px 16px 14px', borderTop: '1px solid #1e3a5f', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                      {visibleJiraFields.map(field => {
                        const bVal = bulkValues[field.key] ?? ''
                        const bulkInputStyle: React.CSSProperties = { background: '#0f172a', border: '1px solid #2563eb30', borderRadius: 5, color: '#e2e8f0', fontSize: 12, padding: '4px 8px', minWidth: 130, width: '100%' }
                        const bulkSelectedIds = field.type === 'multiuser' ? bVal.split(',').map(s => s.trim()).filter(Boolean) : []
                        return (
                          <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={{ fontSize: 11, color: '#64748b' }}>{field.name}{isFieldRequired(field) ? <span style={{ color: '#f87171' }}> *</span> : ''}</span>
                            {(field.type === 'select' && field.options) ? (
                              <select value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                style={{ ...bulkInputStyle, cursor: 'pointer' }}>
                                <option value="">— 批量 —</option>
                                {field.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                              </select>
                            ) : field.type === 'multiuser' ? (
                              <div>
                                {bulkSelectedIds.map(id => {
                                  return (
                                    <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#1e3a5f', borderRadius: 4, padding: '1px 5px', margin: '2px 2px', fontSize: 11, color: '#93c5fd' }}>
                                      {userLabelForField(field, id)}
                                      <button type="button" onClick={() => {
                                        const next = bulkSelectedIds.filter(x => x !== id)
                                        setBulkValues(p => ({ ...p, [field.key]: next.join(',') }))
                                      }} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                                    </span>
                                  )
                                })}
                                <select value="" onChange={e => {
                                  if (!e.target.value) return
                                  const next = [...bulkSelectedIds, e.target.value]
                                  setBulkValues(p => ({ ...p, [field.key]: next.join(',') }))
                                }} style={{ ...bulkInputStyle, marginTop: bulkSelectedIds.length ? 3 : 0, cursor: 'pointer' }}>
                                  <option value="">+ 批量新增</option>
                                  {userOptionsForField(field).filter(m => !bulkSelectedIds.includes(m.id)).map(m => (
                                    <option key={m.id} value={m.id}>{m.label}</option>
                                  ))}
                                </select>
                                <div style={{ marginTop: 3 }}>
                                  <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                    onPick={u => { mergeFieldUsers(field.key, [u]); if (!bulkSelectedIds.includes(u.id)) setBulkValues(p => ({ ...p, [field.key]: [...bulkSelectedIds, u.id].join(',') })) }} />
                                </div>
                              </div>
                            ) : field.type === 'user' ? (
                              <div>
                                <select value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                  style={{ ...bulkInputStyle, cursor: 'pointer' }}>
                                  <option value="">— 批量 —</option>
                                  {userOptionsForField(field).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                                </select>
                                <div style={{ marginTop: 3 }}>
                                  <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                    onPick={u => { mergeFieldUsers(field.key, [u]); setBulkValues(p => ({ ...p, [field.key]: u.id })) }} />
                                </div>
                              </div>
                            ) : field.type === 'date' ? (
                              <input type="date" value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                style={{ ...bulkInputStyle, colorScheme: 'dark' }} />
                            ) : field.type === 'datetime' ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <input type="date" value={bVal.split('T')[0] ?? ''} onChange={e => {
                                  const t = bVal.split('T')[1] ?? '00:00'
                                  setBulkValues(p => ({ ...p, [field.key]: `${e.target.value}T${t}` }))
                                }} style={{ ...bulkInputStyle, colorScheme: 'dark' }} />
                                <input type="time" value={bVal.split('T')[1] ?? ''} onChange={e => {
                                  const d = bVal.split('T')[0] ?? ''
                                  setBulkValues(p => ({ ...p, [field.key]: `${d}T${e.target.value}` }))
                                }} style={{ ...bulkInputStyle, colorScheme: 'dark' }} />
                              </div>
                            ) : field.type === 'text' ? (
                              <textarea value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                style={{ ...bulkInputStyle, resize: 'vertical', minHeight: 36 }} />
                            ) : (
                              <input type={field.type === 'number' ? 'number' : 'text'} value={bVal}
                                onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                placeholder="批量填入" style={bulkInputStyle} />
                            )}
                            {bVal && (
                              <button type="button"
                                onClick={() => applyBulkColumn(field.key, bVal)}
                                style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: '1px solid #2563eb50', background: '#2563eb20', color: '#60a5fa', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                ⬇ 套用至 {filteredRecords.length} 列
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* ── AI 摘要生成面板 ── */}
                <div style={{ background: '#0d1e30', border: `1px solid ${aiSummaryEnabled ? '#7c3aed40' : '#1e3a5f'}`, borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setAiSummaryEnabled(v => !v)}>
                    <span style={{ fontSize: 12, color: '#475569', transition: 'transform .2s', display: 'inline-block', transform: aiSummaryEnabled ? 'rotate(90deg)' : 'none' }}>▶</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: aiSummaryEnabled ? '#a78bfa' : '#60a5fa' }}>AI 摘要生成</span>
                    {aiSummaryEnabled && <span style={{ fontSize: 11, background: '#2e1065', color: '#a78bfa', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>已啟用</span>}
                    <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>開啟後可用 AI 根據欄位內容自動生成 Issue 標題</span>
                  </div>
                  {aiSummaryEnabled && (
                    <div style={{ padding: '14px 16px 16px', borderTop: '1px solid #1e3a5f' }}>
                      {/* 前綴欄位 */}
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>前綴欄位（從 Sheet 取值，依序組合 [值1][值2]...）</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                          {aiPrefixColumns.map((col, idx) => (
                            <span key={col} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#1e3a5f', border: '1px solid #2563eb40', borderRadius: 6, padding: '4px 9px', fontSize: 12, color: '#93c5fd' }}>
                              {col}
                              <button type="button" onClick={() => setAiPrefixColumns(p => p.filter((_, i) => i !== idx))}
                                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                            </span>
                          ))}
                          <select value="" onChange={e => { if (e.target.value && !aiPrefixColumns.includes(e.target.value)) setAiPrefixColumns(p => [...p, e.target.value]) }}
                            style={{ background: '#0f172a', border: '1px dashed #2d3f55', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#64748b', cursor: 'pointer', outline: 'none' }}>
                            <option value="">＋ 加入欄位</option>
                            {sheetHeaders.filter(h => h && !aiPrefixColumns.includes(h)).map((h, i) => (
                              <option key={h || `h-${i}`} value={h}>{h}</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ fontSize: 11, color: '#334155', marginTop: 4 }}>空白值自動跳過，不輸出空括號。</div>
                      </div>
                      {/* 內容來源 + 模型 */}
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>內容來源欄位 <span style={{ color: '#f87171' }}>*</span></span>
                          <select value={aiContentColumn} onChange={e => setAiContentColumn(e.target.value)}
                            style={{ background: '#0f172a', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12, outline: 'none' }}>
                            <option value="">— 選擇欄位 —</option>
                            {sheetHeaders.filter(h => h).map((h, i) => <option key={h || `h-${i}`} value={h}>{h}</option>)}
                          </select>
                          <span style={{ fontSize: 11, color: '#334155' }}>此欄位文字餵給 AI 生成標題</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 160px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI 模型</span>
                          <ModelSelector value={aiSummaryModel} onChange={setAiSummaryModel} />
                        </div>
                      </div>
                      {/* 前綴預覽 */}
                      {(aiPrefixColumns.length > 0 || aiContentColumn) && filteredRecords.find(r => selectedRows.has(Number(r._rowIndex)) && needsCreate(r)) && (() => {
                        const exRow = filteredRecords.find(r => selectedRows.has(Number(r._rowIndex)) && needsCreate(r))!
                        const exPrefix = aiPrefixColumns.map(col => { const v = (exRow[col] ?? '').trim(); return v ? `[${v}]` : '' }).join('')
                        const exContent = aiContentColumn ? (exRow[aiContentColumn] ?? '').slice(0, 40) : ''
                        return (
                          <div style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', marginBottom: 12 }}>
                            <span style={{ color: '#475569', fontSize: 11 }}>範例：</span>
                            {exPrefix && <span style={{ color: '#60a5fa' }}>{exPrefix}</span>}
                            {exPrefix && <span style={{ color: '#475569' }}> + </span>}
                            <span style={{ color: '#34d399' }}>AI({exContent}{exContent.length >= 40 ? '...' : ''})</span>
                          </div>
                        )
                      })()}
                      {/* 生成按鈕 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <button type="button"
                          disabled={!aiContentColumn || summaryGenerating}
                          onClick={handleGenerateSummaries}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: summaryGenerating ? '#1e1b4b' : 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: 'white', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: !aiContentColumn || summaryGenerating ? 'not-allowed' : 'pointer', opacity: !aiContentColumn ? 0.5 : 1 }}>
                          {summaryGenerating ? '生成中...' : `批量生成摘要（${filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex)) && needsCreate(r)).length} 筆）`}
                        </button>
                        {summaryProgress && (
                          <span style={{ fontSize: 12, color: summaryProgress.done >= summaryProgress.total ? (summaryProgress.failed ? '#f87171' : '#4ade80') : '#a78bfa' }}>
                            {summaryProgress.done >= summaryProgress.total
                              ? summaryProgress.failed
                                ? `通過 ${summaryProgress.total - (summaryProgress.failed ?? 0)} 筆完成，${summaryProgress.failed} 筆失敗`
                                : `通過 完成 ${summaryProgress.total} 筆`
                              : `${summaryProgress.done} / ${summaryProgress.total}`}
                          </span>
                        )}
                        {Object.keys(generatedSummaries).length > 0 && !summaryGenerating && (
                          <button type="button" onClick={() => { setGeneratedSummaries({}); setSummaryProgress(null) }}
                            style={{ background: 'none', border: '1px solid #334155', borderRadius: 6, color: '#64748b', padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>
                            清除生成結果
                          </button>
                        )}
                      </div>
                      {summaryGenerating && summaryProgress && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ background: '#1e293b', borderRadius: 4, height: 5, overflow: 'hidden' }}>
                            <div style={{ background: 'linear-gradient(90deg, #7c3aed, #a78bfa)', height: '100%', width: `${Math.round(summaryProgress.done / summaryProgress.total * 100)}%`, transition: 'width .3s' }} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="table-wrap" style={{ overflowX: 'auto' }}>
                <table className="version-table" style={{ minWidth: 'max-content' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox"
                          checked={filteredRecords.length > 0 && filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))}
                          onChange={() => {
                            const allSelected = filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))
                            setSelectedRows(prev => {
                              const n = new Set(prev)
                              filteredRecords.forEach(r => allSelected ? n.delete(Number(r._rowIndex)) : n.add(Number(r._rowIndex)))
                              return n
                            })
                          }} />
                      </th>
                      <th style={{ width: 44 }}>#</th>
                      <th style={{ width: 80 }}>階段</th>
                      {requiredJiraFields.map(f => (
                        <th key={f.key} style={{ minWidth: f.key === 'summary' ? 220 : 130 }}>
                          {f.name} <span style={{ color: '#f87171' }}>*</span>
                          <div style={{ fontSize: 10, color: '#475569', fontWeight: 400, fontFamily: 'monospace' }}>{f.type}</div>
                        </th>
                      ))}
                      {activeOptionalJiraFields.map(f => (
                        <th key={f.key} style={{ minWidth: 120, background: '#162138', borderLeft: '2px solid #334155' }}>
                          <span style={{ color: '#93c5fd' }}>{f.name}</span>
                          <div style={{ fontSize: 10, color: '#334155', fontWeight: 400, fontFamily: 'monospace' }}>{f.type}</div>
                        </th>
                      ))}
                      <th style={{ minWidth: 90, width: 100, background: '#12201a', borderLeft: '2px solid #334155' }}>
                        <span style={{ color: '#4ade80' }}>附件</span>
                        {descPrefetchLoading && <span style={{ display: 'block', fontSize: 10, color: '#64748b' }}>載入中…</span>}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(r => {
                      const rowIdx = Number(r._rowIndex)
                      const rowCells = cellValues[rowIdx] ?? {}
                      const rowErrors = cellErrors[rowIdx] ?? {}
                      const hasRowError = Object.keys(rowErrors).length > 0
                      return (
                        <tr key={rowIdx} id={`jira-dyn-row-${rowIdx}`} style={hasRowError ? { background: 'rgba(239,68,68,0.18)', borderLeft: '3px solid #ef4444' } : undefined}>
                          <td>
                            <input type="checkbox"
                              checked={selectedRows.has(rowIdx)}
                              onChange={() => toggleRow(rowIdx)} />
                          </td>
                          <td style={{ color: '#94a3b8', fontSize: 12 }}>{rowIdx}</td>
                          <td><span className={stageBadgeClass(r)}>{stageLabel(r)}</span></td>
                          {visibleJiraFields.map(field => {
                            const val = rowCells[field.key] ?? ''
                            const err = rowErrors[field.key]
                            const inputStyle: React.CSSProperties = {
                              width: '100%', background: '#0f172a', border: `1px solid ${err ? '#ef4444' : '#2d3f55'}`,
                              borderRadius: 5, color: '#e2e8f0', fontSize: 12, padding: '4px 7px', outline: 'none',
                              minWidth: field.key === 'summary' ? 200 : 100,
                            }
                            const selectedIds = field.type === 'multiuser' ? val.split(',').map(s => s.trim()).filter(Boolean) : []
                            // For summary field with AI enabled: show generated value
                            if (field.key === 'summary' && aiSummaryEnabled && needsCreate(r)) {
                              const genVal = generatedSummaries[rowIdx]
                              return (
                                <td key={field.key}>
                                  {genVal ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <span style={{ background: '#2e1065', color: '#a78bfa', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>AI 靈</span>
                                      <input value={genVal}
                                        onChange={e => setGeneratedSummaries(p => ({ ...p, [rowIdx]: e.target.value }))}
                                        style={{ ...inputStyle, border: '1px solid #7c3aed40', flex: 1 }} />
                                    </div>
                                  ) : summaryGenerating ? (
                                    <span style={{ fontSize: 12, color: '#7c3aed', display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <span style={{ width: 10, height: 10, border: '2px solid #7c3aed30', borderTopColor: '#7c3aed', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
                                      生成中...
                                    </span>
                                  ) : (
                                    <input type="text" value={val || getField(r, SHEET_FIELD.summary)}
                                      onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                      placeholder="點批量生成或直接填寫" style={{ ...inputStyle, color: '#64748b' }} />
                                  )}
                                  {err && <div style={{ fontSize: 10, color: '#f87171', marginTop: 2 }}>{err}</div>}
                                </td>
                              )
                            }
                            return (
                              <td key={field.key} style={isFieldRequired(field) ? undefined : { background: '#0e1e2e' }}>
                                {(field.type === 'select' && field.options) ? (
                                  <select value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, cursor: 'pointer' }}>
                                    <option value="">— 選擇 —</option>
                                    {field.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                                  </select>
                                ) : field.type === 'multiuser' ? (
                                  <div style={{ minWidth: 140 }}>
                                    {selectedIds.map(id => {
                                      return (
                                        <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#1e3a5f', border: '1px solid #2563eb40', borderRadius: 4, padding: '1px 5px', margin: '2px 2px', fontSize: 11, color: '#93c5fd' }}>
                                          {userLabelForField(field, id)}
                                          <button type="button" onClick={() => toggleMultiuser(rowIdx, field.key, id)}
                                            style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                                        </span>
                                      )
                                    })}
                                    <select value="" onChange={e => { if (e.target.value) toggleMultiuser(rowIdx, field.key, e.target.value) }}
                                      style={{ ...inputStyle, marginTop: selectedIds.length ? 3 : 0, cursor: 'pointer' }}>
                                      <option value="">+ 新增成員</option>
                                      {userOptionsForField(field).filter(m => !selectedIds.includes(m.id)).map(m => (
                                        <option key={m.id} value={m.id}>{m.label}</option>
                                      ))}
                                    </select>
                                    <div style={{ marginTop: 3 }}>
                                      <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                        onPick={u => { mergeFieldUsers(field.key, [u]); if (!selectedIds.includes(u.id)) toggleMultiuser(rowIdx, field.key, u.id) }} />
                                    </div>
                                  </div>
                                ) : field.type === 'user' ? (
                                  <div style={{ minWidth: 120 }}>
                                    <select value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                      style={{ ...inputStyle, cursor: 'pointer' }}>
                                      <option value="">— 選擇 —</option>
                                      {userOptionsForField(field).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                                    </select>
                                    <div style={{ marginTop: 3 }}>
                                      <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                        onPick={u => { mergeFieldUsers(field.key, [u]); setCellValue(rowIdx, field.key, u.id) }} />
                                    </div>
                                  </div>
                                ) : field.type === 'text' ? (
                                  <textarea value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, minHeight: 40, resize: 'vertical' }} />
                                ) : field.type === 'date' ? (
                                  <input type="date" value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, colorScheme: 'dark' }} />
                                ) : field.type === 'datetime' ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 130 }}>
                                    <input type="date" value={val.split('T')[0] ?? ''} onChange={e => {
                                      const t = val.split('T')[1] ?? '00:00'
                                      setCellValue(rowIdx, field.key, `${e.target.value}T${t}`)
                                    }} style={{ ...inputStyle, colorScheme: 'dark' }} />
                                    <input type="time" value={val.split('T')[1] ?? ''} onChange={e => {
                                      const d = val.split('T')[0] ?? ''
                                      setCellValue(rowIdx, field.key, `${d}T${e.target.value}`)
                                    }} style={{ ...inputStyle, colorScheme: 'dark' }} />
                                  </div>
                                ) : (
                                  <input type={field.type === 'number' ? 'number' : 'text'}
                                    value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    placeholder={field.required ? '' : '可選填'}
                                    style={inputStyle} />
                                )}
                                {err && <div style={{ fontSize: 10, color: '#f87171', marginTop: 2 }}>{err}</div>}
                              </td>
                            )
                          })}
                          {/* Attachment cell */}
                          <td style={{ background: '#0c1a13', borderLeft: '2px solid #1a3a2a', verticalAlign: 'top' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'flex-start', minWidth: 72 }}>
                              {(descAttachMap[rowIdx] ?? []).filter(a => a.cacheId && !a.error).map((att, ai) => (
                                att.isImage ? (
                                  <img key={ai} src={`/api/jira/attachment-cache/${att.cacheId}`} alt={att.filename}
                                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, border: '1px solid #2d4a2d', cursor: 'pointer', flexShrink: 0 }}
                                    onClick={() => setDescLightboxSrc(`/api/jira/attachment-cache/${att.cacheId}`)} />
                                ) : (
                                  <span key={ai} title={att.filename} style={{ fontSize: 10, color: '#d29922', padding: '2px 4px', background: 'rgba(210,153,34,0.1)', border: '1px solid rgba(210,153,34,0.3)', borderRadius: 4 }}>啟</span>
                                )
                              ))}
                              {(descAttachMap[rowIdx] ?? []).filter(a => !a.cacheId).map((att, ai) => (
                                att.isVideo
                                  ? <span key={`v-${ai}`} title={`${att.filename} — Sheet 影片無法自動下載，請用 + 手動上傳`} style={{ fontSize: 10, color: '#f59e0b', padding: '2px 5px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 3 }}>需重新上傳</span>
                                  : <span key={`err-${ai}`} title={att.error ?? att.filename} style={{ fontSize: 10, color: '#f87171', padding: '2px 5px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 4 }}>{att.filename.slice(0, 12)}{att.filename.length > 12 ? '…' : ''}</span>
                              ))}
                              <label style={{ cursor: 'pointer', fontSize: 11, color: '#60a5fa', padding: '2px 5px', background: '#1a2f45', border: '1px solid #2d3f55', borderRadius: 4, flexShrink: 0, lineHeight: '18px' }}>
                                +
                                <input type="file" accept="image/*,video/*" multiple style={{ display: 'none' }}
                                  onChange={async e => {
                                    const files = Array.from(e.target.files ?? [])
                                    for (const file of files) {
                                      const formData = new FormData()
                                      formData.append('file', file)
                                      try {
                                        const resp = await fetch('/api/jira/attachment-upload', { method: 'POST', headers: { ...emailHeader }, body: formData })
                                        const data = await resp.json() as CachedAttachment & { ok: boolean; message?: string }
                                        if (data.ok) {
                                          setDescAttachMap(prev => ({ ...prev, [rowIdx]: [...(prev[rowIdx] ?? []), data] }))
                                        } else {
                                          setDescUploadErrors(prev => ({ ...prev, [rowIdx]: data.message ?? '上傳失敗' }))
                                        }
                                      } catch { setDescUploadErrors(prev => ({ ...prev, [rowIdx]: '網路錯誤' })) }
                                    }
                                    e.target.value = ''
                                  }} />
                              </label>
                              {descUploadErrors[rowIdx] && (
                                <span style={{ fontSize: 10, color: '#f87171', width: '100%' }}>{descUploadErrors[rowIdx]}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              </>
            ) : !fieldsLoading ? (
              /* Fallback: show Lark data if fields failed to load */
              <>
              <div className="alert-warn" style={{ marginBottom: 8, fontSize: 12 }}>
                動態欄位未載入（Jira fields API 未回傳資料），顯示 Lark 原始資料。請開啟 F12 → Console 查看 [jira-fields] 日誌。
              </div>
              <div className="table-wrap">
                <table className="version-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox"
                          checked={filteredRecords.length > 0 && filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))}
                          onChange={() => {
                            const allSelected = filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))
                            setSelectedRows(prev => {
                              const n = new Set(prev)
                              filteredRecords.forEach(r => allSelected ? n.delete(Number(r._rowIndex)) : n.add(Number(r._rowIndex)))
                              return n
                            })
                          }} />
                      </th>
                      <th style={{ width: 52 }}>列</th>
                      <th style={{ width: 90 }}>階段</th>
                      {sheetHeaders.map((h, i) => <th key={h || `sh-${i}`}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(r => (
                      <tr key={r._rowIndex}>
                        <td><input type="checkbox" checked={selectedRows.has(Number(r._rowIndex))} onChange={() => toggleRow(Number(r._rowIndex))} /></td>
                        <td style={{ color: '#94a3b8', fontSize: 12 }}>{r._rowIndex}</td>
                        <td><span className={stageBadgeClass(r)}>{stageLabel(r)}</span></td>
                        {sheetHeaders.map((h, i) => {
                          const val = r[h] ?? ''
                          const member = members.find(m => m.accountId === val)
                          return (
                            <td key={h || `sh-${i}`} title={val}>
                              {member
                                ? <span className="member-chip">
                                    {member.avatarUrl && <img src={member.avatarUrl} alt={member.displayName} className="chip-avatar" />}
                                    {member.displayName}
                                  </span>
                                : <span className="cell-text">{val || '—'}</span>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            ) : null}

          {submitting && (() => {
            const cp = createProgress
            const cpct = cp ? Math.round(cp.done / cp.total * 100) : 0
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8' }}>
                  <span>{cp ? `處理中 ${cp.done} / ${cp.total}` : '提交中...'}</span>
                  {cp && <span>{cpct}%</span>}
                </div>
                <div style={{ height: 6, borderRadius: 3, background: '#1e2d3d', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, background: '#3b82f6', width: `${cpct}%`, transition: 'width 0.3s ease' }} />
                </div>
              </div>
            )
          })()}
          <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(2)}>上一步</button>
            <button type="button"
              className={`submit-btn submit-btn--step${submitting ? ' loading' : ''}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              disabled={filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex))).length === 0 || submitting || !currentAccount || fieldsLoading}
              onClick={handleCreate}>
              {submitting ? '處理中...' : `開始執行（${filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex))).length} 筆）`}
            </button>
            {Object.keys(cellErrors).length > 0 && (
              <span style={{ fontSize: 12, color: '#f87171' }}>
                {Object.keys(cellErrors).length} 列有必填未填，第&nbsp;
                {Object.keys(cellErrors).map(Number).sort((a, b) => a - b).map((idx, i, arr) => (
                  <span key={idx}>
                    <span
                      style={{ cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => document.getElementById(`jira-dyn-row-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                    >{idx}</span>{i < arr.length - 1 ? '、' : ''}
                  </span>
                ))}
                &nbsp;列
              </span>
            )}
          </div>
        </div>
  )
}

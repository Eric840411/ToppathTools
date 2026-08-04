import { StepGuide, ReloadSheetButton } from '../components/JiraStepWidgets'
import type { AccountInfo } from '../components/JiraAccountModal'
import type {
  SheetSource, SheetRecord, CachedAttachment, Member, NormalizedJiraField,
} from './JiraPage'
import { MultiEditUserPicker, EditUserPicker } from './JiraPage'

type EditFieldMapping = {
  jiraField: string
  fieldType: NormalizedJiraField['type']
  fieldOptions: { id: string; label: string }[]
  mode: 'sheet' | 'manual'
  sheetColumn: string
  manualValue: string
  manualAccountId: string
  manualAccountIds: string[]
  manualLabels: string[]
}

/**
 * 批量修改分頁（Step 1 讀表格 → Step 2 選 Issue → Step 3 設定欄位對應 → Step 4 結果）。
 * 純畫面元件，狀態留在 JiraPage.tsx 以 props 傳入。
 *
 * 附件預覽用的 Lightbox（editDescLightboxSrc）render 本身位於 JiraPage.tsx 頂層、不屬於這個
 * qaSubMode==='edit' 區塊（跟批量評論的 lightboxSrc 不一樣，那個是完全包在區塊內可以整個搬過來），
 * 所以這裡只傳 setEditDescLightboxSrc 觸發它，不搬這段 render。
 *
 * 摘要前綴功能（renderSummaryPrefixPanel/computeSummaryPrefix/summaryPrefixEnabled）跟批次開單
 * 流程共用同一份狀態，維持用 props 傳入，不複製一份。
 */
export function JiraBatchEditTab(props: {
  editTabStep: 1 | 2 | 3 | 4
  setEditTabStep: (v: 1 | 2 | 3 | 4) => void
  editTabSource: SheetSource
  setEditTabSource: (v: SheetSource) => void
  editTabUrl: string
  setEditTabUrl: (v: string) => void
  editTabError: string
  setEditTabError: (v: string) => void
  handleEditTabLoad: () => void
  editTabLoading: boolean
  editTabIssues: { rowIndex: number; issueKey: string }[]
  editTabJiraLoading: boolean
  editReloadMsg: string
  handleReloadEditSheet: () => void
  editTabJiraError: string
  fetchEditTabJiraData: (issueKeys: string[]) => void
  editFilterableColumns: string[]
  editTabColFilters: Record<string, string>
  setEditTabColFilters: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  editColumnUniqueValues: Record<string, string[]>
  editFilteredIssues: { rowIndex: number; issueKey: string }[]
  editTabSelectedKeys: Set<string>
  setEditTabSelectedKeys: (fn: (prev: Set<string>) => Set<string>) => void
  editAlreadyEditedKeys: Set<string>
  editTabJiraData: Record<string, Record<string, string>>
  renderSummaryPrefixPanel: (headers: string[], records?: Array<Record<string, unknown>>, summaryColKey?: string) => React.ReactNode
  editTabHeaders: string[]
  editTabRecords: SheetRecord[]
  editFieldMappings: EditFieldMapping[]
  setEditFieldMappings: (fn: (prev: EditFieldMapping[]) => EditFieldMapping[]) => void
  editTabAvailableFields: NormalizedJiraField[]
  editTabMembers: Member[]
  editTabMembersLoading: boolean
  blankMapping: () => EditFieldMapping
  editDescAttachCol: string
  setEditDescAttachCol: (v: string) => void
  handleEditDescPrefetch: () => void
  editDescPrefetchLoading: boolean
  summaryPrefixEnabled: boolean
  computeSummaryPrefix: (row: Record<string, unknown>) => string
  editDescAttachMap: Record<string, CachedAttachment[]>
  setEditDescAttachMap: (fn: (prev: Record<string, CachedAttachment[]>) => Record<string, CachedAttachment[]>) => void
  setEditDescLightboxSrc: (v: string | null) => void
  emailHeader: Record<string, string>
  editDescUploadErrors: Record<string, string>
  setEditDescUploadErrors: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  editTabSubmitting: boolean
  editProgress: { done: number; total: number } | null
  currentAccount: AccountInfo | null
  handleEditTabSubmit: () => void
  editTabResults: { issueKey: string; ok: boolean; error?: string }[]
  setEditTabIssues: (v: { rowIndex: number; issueKey: string }[]) => void
  setEditTabRecords: (v: SheetRecord[]) => void
  setEditTabHeaders: (v: string[]) => void
  setEditTabResults: (v: { issueKey: string; ok: boolean; error?: string }[]) => void
}) {
  const {
    editTabStep, setEditTabStep, editTabSource, setEditTabSource, editTabUrl, setEditTabUrl,
    editTabError, setEditTabError, handleEditTabLoad, editTabLoading, editTabIssues, editTabJiraLoading,
    editReloadMsg, handleReloadEditSheet, editTabJiraError, fetchEditTabJiraData, editFilterableColumns,
    editTabColFilters, setEditTabColFilters, editColumnUniqueValues, editFilteredIssues, editTabSelectedKeys,
    setEditTabSelectedKeys, editAlreadyEditedKeys, editTabJiraData, renderSummaryPrefixPanel, editTabHeaders,
    editTabRecords, editFieldMappings, setEditFieldMappings, editTabAvailableFields, editTabMembers,
    editTabMembersLoading, blankMapping, editDescAttachCol, setEditDescAttachCol, handleEditDescPrefetch,
    editDescPrefetchLoading, summaryPrefixEnabled, computeSummaryPrefix, editDescAttachMap, setEditDescAttachMap,
    setEditDescLightboxSrc, emailHeader, editDescUploadErrors, setEditDescUploadErrors, editTabSubmitting,
    editProgress, currentAccount, handleEditTabSubmit, editTabResults,
    setEditTabIssues, setEditTabRecords, setEditTabHeaders, setEditTabResults,
  } = props

  return (
    <>
      {/* Step 1: 讀表格 */}
      {editTabStep === 1 && (
        <div className="section-card">
          <h2 className="section-title">批量修改</h2>
          <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
            貼入 Sheet URL，系統自動偵測含 Jira Issue Key 的列，批量修改指定欄位。
          </p>
          <div className="source-toggle">
            <button type="button" className={`source-btn source-btn--step${editTabSource === 'lark' ? ' active' : ''}`}
              onClick={() => { setEditTabSource('lark'); setEditTabUrl(''); setEditTabError('') }}>
              <span className="source-icon lark-icon">L</span>Lark Spreadsheet
            </button>
            <button type="button" className={`source-btn source-btn--step${editTabSource === 'google' ? ' active' : ''}`}
              onClick={() => { setEditTabSource('google'); setEditTabUrl(''); setEditTabError('') }}>
              <span className="source-icon google-icon">G</span>Google Sheets
            </button>
          </div>
          {editTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{editTabError}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <input
              value={editTabUrl}
              onChange={e => setEditTabUrl(e.target.value)}
              placeholder={editTabSource === 'lark'
                ? 'https://casinoplus.sg.larksuite.com/wiki/... 或 Lark Sheet URL'
                : 'https://docs.google.com/spreadsheets/d/xxx/edit#gid=0'}
              style={{ flex: 1, padding: '7px 12px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
              onKeyDown={e => e.key === 'Enter' && handleEditTabLoad()}
            />
            <button
              type="button"
              className="submit-btn submit-btn--step"
              disabled={editTabLoading || !editTabUrl.trim()}
              onClick={handleEditTabLoad}
              style={{ whiteSpace: 'nowrap' }}
            >
              {editTabLoading ? '讀取中…' : '讀取'}
            </button>
          </div>

          <StepGuide title="操作說明 — 這個功能需要什麼樣的 Sheet">
            <li>同批量評論：只要有一欄是 <b>Jira Issue Key</b>（如 <code>ABC-123</code>）即可，不限欄位名稱或位置</li>
            <li>讀取後會自動帶入該 Issue 目前的 Jira 欄位值（摘要/受託人/狀態），供 Step 3 對照修改前後差異</li>
            <li>支援 Lark Sheet / Google Sheets 兩種來源</li>
          </StepGuide>
        </div>
      )}

      {/* Step 2: 選擇 Issue */}
      {editTabStep === 2 && (
        <div className="section-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              選擇要修改的 Issue（共 {editTabIssues.length} 筆）
              {editTabJiraLoading && <span style={{ fontSize: 11, color: '#60a5fa', marginLeft: 8 }}>載入 Jira 資料中…</span>}
            </h2>
            <ReloadSheetButton loading={editTabLoading} msg={editReloadMsg} onClick={handleReloadEditSheet} />
          </div>

          <StepGuide title="操作說明 — 篩選與勾選">
            <li>與批量評論相同的欄位篩選機制，自動偵測 2–15 個唯一值的欄位</li>
            <li>選好後系統會在背景載入這些 Issue 的可編輯欄位定義（editmeta）與專案成員清單，供 Step 3 使用</li>
          </StepGuide>

          {editTabJiraError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#1e1010', border: '1px solid #7f1d1d60', borderRadius: 6, padding: '8px 12px', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: '#f87171', flex: 1 }}>{editTabJiraError}</span>
              <button type="button"
                style={{ fontSize: 12, padding: '4px 12px', borderRadius: 5, border: '1px solid #f8717160', background: '#7f1d1d30', color: '#fca5a5', cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={() => fetchEditTabJiraData(editTabIssues.map(i => i.issueKey))}>
                重新載入 Jira 資料
              </button>
            </div>
          )}

          {/* Column filters */}
          {editFilterableColumns.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>篩選：</span>
              {editFilterableColumns.map(col => (
                <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
                  <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{col}</span>
                  <select value={editTabColFilters[col] ?? ''} onChange={e => setEditTabColFilters(prev => ({ ...prev, [col]: e.target.value }))}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155' }}>
                    <option value="">全部</option>
                    {(editColumnUniqueValues[col] ?? []).map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              ))}
              {Object.values(editTabColFilters).some(Boolean) && (
                <button type="button" onClick={() => setEditTabColFilters(() => ({}))}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #334155', background: 'none', cursor: 'pointer', color: '#94a3b8' }}>
                  清除篩選
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: '#94a3b8' }}>
              <input
                type="checkbox"
                checked={editFilteredIssues.length > 0 && editFilteredIssues.every(i => editTabSelectedKeys.has(i.issueKey))}
                onChange={e => setEditTabSelectedKeys(prev => {
                  const n = new Set(prev)
                  editFilteredIssues.forEach(i => e.target.checked ? n.add(i.issueKey) : n.delete(i.issueKey))
                  return n
                })}
              />
              全選 / 取消全選
            </label>
            <span style={{ fontSize: 11, color: '#60a5fa' }}>
              已選 {editTabSelectedKeys.size} / {editTabIssues.length} 筆
              {editFilteredIssues.length < editTabIssues.length && <span style={{ color: '#94a3b8' }}>{`（篩選顯示 ${editFilteredIssues.length} 筆）`}</span>}
            </span>
          </div>

          {(() => {
            const jiraCols = ['summary', 'assignee', 'status'] as const
            const jiraLabels: Record<string, string> = { summary: '摘要 (Jira)', assignee: '受託人 (Jira)', status: '狀態 (Jira)' }
            const thStyle: React.CSSProperties = { padding: '7px 10px', borderBottom: '2px solid #1e3a5f', borderRight: '1px solid #1e3a5f', fontSize: 11, fontWeight: 700, color: '#60a5fa', whiteSpace: 'nowrap', textAlign: 'left', background: '#0f2744' }
            const tdBase: React.CSSProperties = { padding: '5px 10px', borderRight: '1px solid #1e293b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }
            return (
              <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 600 }}>
                    <colgroup>
                      <col style={{ width: 36 }} />
                      <col style={{ width: 110 }} />
                      <col style={{ width: '40%' }} />
                      <col style={{ width: 120 }} />
                      <col style={{ width: 100 }} />
                    </colgroup>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr>
                        <th style={{ ...thStyle, textAlign: 'center' }} />
                        <th style={thStyle}>Issue Key</th>
                        {jiraCols.map(f => <th key={f} style={thStyle}>{jiraLabels[f]}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {editFilteredIssues.length === 0 ? (
                        <tr><td colSpan={5} style={{ padding: '12px 16px', fontSize: 12, color: '#64748b', textAlign: 'center' }}>篩選條件下無符合的 Issue</td></tr>
                      ) : editFilteredIssues.map((issue, idx) => {
                        const isSelected = editTabSelectedKeys.has(issue.issueKey)
                        const jira = editTabJiraData[issue.issueKey]
                        return (
                          <tr key={issue.issueKey}
                            onClick={() => setEditTabSelectedKeys(prev => { const n = new Set(prev); isSelected ? n.delete(issue.issueKey) : n.add(issue.issueKey); return n })}
                            style={{ background: isSelected ? (idx % 2 === 0 ? '#0a1628' : '#0d1e38') : '#070f1e', opacity: isSelected ? 1 : 0.45, cursor: 'pointer', borderBottom: '1px solid #1e293b' }}>
                            <td style={{ ...tdBase, width: 36, textAlign: 'center' }}>
                              <input type="checkbox" checked={isSelected} readOnly
                                onChange={e => { e.stopPropagation(); setEditTabSelectedKeys(prev => { const n = new Set(prev); e.target.checked ? n.add(issue.issueKey) : n.delete(issue.issueKey); return n }) }}
                                onClick={e => e.stopPropagation()}
                              />
                            </td>
                            <td style={{ ...tdBase, whiteSpace: 'nowrap' }}>
                              <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${issue.issueKey}`} target="_blank" rel="noreferrer"
                                onClick={e => e.stopPropagation()}
                                style={{ color: '#93c5fd', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}>
                                {issue.issueKey}
                              </a>
                              {editAlreadyEditedKeys.has(issue.issueKey) && (
                                <span title="這筆先前已經批量修改過，重複執行可能導致附件/描述重複疊加"
                                  style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#3f2d0f', color: '#fbbf24', border: '1px solid #78500f' }}>
                                  已改過
                                </span>
                              )}
                            </td>
                            {jiraCols.map(f => (
                              <td key={f} style={{ ...tdBase, color: '#94a3b8' }}>
                                {editTabJiraLoading && !jira
                                  ? <span style={{ color: '#374151' }}>載入中…</span>
                                  : (jira?.[f] || <span style={{ color: '#374151' }}>—</span>)}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}
          <div className="stage-nav">
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setEditTabStep(1)}>← 重新讀取</button>
            <button type="button" className="submit-btn submit-btn--step"
              disabled={editTabSelectedKeys.size === 0}
              onClick={() => setEditTabStep(3)}>
              下一步：設定欄位（{editTabSelectedKeys.size} 筆）→
            </button>
          </div>
        </div>
      )}

      {/* Step 3: 設定欄位對應 */}
      {editTabStep === 3 && (
        <div className="section-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 className="section-title" style={{ margin: 0 }}>設定欄位對應（{editTabSelectedKeys.size} 筆 Issue）</h2>
            <ReloadSheetButton loading={editTabLoading} msg={editReloadMsg} onClick={handleReloadEditSheet} />
          </div>
          <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
            選擇要修改的 Jira 欄位，並選擇來源（Sheet 欄位 或 手動設定）。
          </p>
          {editTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{editTabError}</div>}

          <StepGuide title="操作說明 — 欄位對應模式">
            <li>可用欄位清單來自 Jira <code>editmeta</code>（該 Issue 實際可編輯的欄位），不是寫死的固定清單</li>
            <li>每個欄位可選兩種模式：<b>從 Sheet 欄位對應</b>（依 Sheet 欄名抓值）或 <b>手動設定固定值</b>（所有勾選列套用同一個值）</li>
            <li>user / multiuser 類型欄位（如受託人、RD負責人）提供可搜尋人員選單，依專案成員即時查詢</li>
            <li>select / multiselect 類型欄位會顯示 Jira 該欄位允許的選項清單，不會讓你填出不合法的值</li>
            <li>下方預覽表會即時顯示「現有值 → 新值」，有差異的欄位以綠色標示，方便送出前核對</li>
            <li>「描述附件」欄可上傳圖片，送出時自動上傳並以 wiki markup 嵌入描述</li>
          </StepGuide>

          {renderSummaryPrefixPanel(
            editTabHeaders,
            editTabRecords as Array<Record<string, unknown>>,
            editFieldMappings.find(m => m.jiraField === 'summary' && m.mode === 'sheet')?.sheetColumn
          )}

          {/* Field mappings */}
          <div className="form-stack" style={{ marginBottom: 12 }}>
            {editFieldMappings.map((mapping, idx) => {
              const updateMapping = (patch: Partial<EditFieldMapping>) =>
                setEditFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, ...patch } : m))
              const isManual = mapping.mode === 'manual'
              return (
                <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
                  {/* Jira field selector */}
                  <select
                    value={mapping.jiraField}
                    onChange={e => {
                      const field = editTabAvailableFields.find(f => f.key === e.target.value)
                      updateMapping({ jiraField: e.target.value, fieldType: field?.type ?? 'string', fieldOptions: field?.options ?? [], manualValue: '', manualAccountId: '', manualAccountIds: [], manualLabels: [] })
                    }}
                    style={{ width: 190, flexShrink: 0, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                  >
                    {editTabAvailableFields.length > 0 ? (
                      editTabAvailableFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)
                    ) : (
                      <>
                        <option value="summary">摘要 (Summary)</option>
                        <option value="description">描述 (Description)</option>
                        <option value="priority">優先級 (Priority)</option>
                        <option value="assignee">受託人 (Assignee)</option>
                        <option value="labels">標籤 (Labels)</option>
                      </>
                    )}
                  </select>
                  <span style={{ color: '#64748b', fontSize: 13, flexShrink: 0 }}>←</span>
                  {/* Mode toggle */}
                  <span style={{ display: 'flex', border: '1px solid #2d3f55', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
                    {(['sheet', 'manual'] as const).map(m => (
                      <button key={m} type="button"
                        onClick={() => updateMapping({ mode: m, sheetColumn: '', manualValue: '', manualAccountId: '', manualAccountIds: [], manualLabels: [] })}
                        style={{
                          fontSize: 11, padding: '5px 10px', cursor: 'pointer', border: 'none',
                          background: mapping.mode === m ? '#1e3a5f' : '#0f172a',
                          color: mapping.mode === m ? '#93c5fd' : '#64748b',
                          fontWeight: mapping.mode === m ? 700 : 400,
                        }}
                      >{m === 'sheet' ? 'Sheet 欄' : '手動'}</button>
                    ))}
                  </span>
                  {/* Value input */}
                  {isManual ? (
                    (mapping.fieldType === 'multiuser') ? (
                      // Multi-user field: chips + searchable multi-select
                      <MultiEditUserPicker
                        members={mapping.fieldOptions.length ? mapping.fieldOptions : editTabMembers.map(m => ({ id: m.accountId, label: m.displayName }))}
                        loading={editTabMembersLoading && !mapping.fieldOptions.length}
                        values={mapping.manualAccountIds}
                        labels={mapping.manualLabels}
                        onChange={(ids, lbls) => updateMapping({ manualAccountIds: ids, manualLabels: lbls })}
                      />
                    ) : (mapping.fieldType === 'user' || mapping.jiraField === 'assignee') ? (
                      // Single user field: searchable picker from project members
                      <EditUserPicker
                        members={mapping.fieldOptions.length ? mapping.fieldOptions : editTabMembers.map(m => ({ id: m.accountId, label: m.displayName }))}
                        loading={editTabMembersLoading && !mapping.fieldOptions.length}
                        value={mapping.manualAccountId}
                        label={mapping.manualValue}
                        onChange={(id, lbl) => updateMapping({ manualAccountId: id, manualValue: lbl })}
                      />
                    ) : (mapping.fieldType === 'select' || mapping.fieldType === 'multiselect' || mapping.jiraField === 'priority') ? (
                      // Select field: dropdown from options or priority list
                      <select
                        value={mapping.manualValue}
                        onChange={e => updateMapping({ manualValue: e.target.value })}
                        style={{ flex: '1 1 0', minWidth: 160, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                      >
                        <option value="">— 選擇值 —</option>
                        {(mapping.fieldOptions.length ? mapping.fieldOptions.map(o => o.label) : ['Highest', 'High', 'Medium', 'Low', 'Lowest']).map(v => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    ) : mapping.fieldType === 'date' ? (
                      <input type="date" value={mapping.manualValue} onChange={e => updateMapping({ manualValue: e.target.value })}
                        style={{ flex: '1 1 0', minWidth: 160, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }} />
                    ) : mapping.fieldType === 'number' ? (
                      <input type="number" value={mapping.manualValue} onChange={e => updateMapping({ manualValue: e.target.value })}
                        placeholder="數字" style={{ flex: '1 1 0', minWidth: 160, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }} />
                    ) : (
                      <input
                        value={mapping.manualValue}
                        onChange={e => updateMapping({ manualValue: e.target.value })}
                        placeholder={mapping.jiraField === 'labels' ? '標籤1, 標籤2（逗號分隔）' : '輸入值'}
                        style={{ flex: '1 1 0', minWidth: 160, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                      />
                    )
                  ) : (
                    <select
                      value={mapping.sheetColumn}
                      onChange={e => updateMapping({ sheetColumn: e.target.value })}
                      style={{ flex: '1 1 0', minWidth: 160, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                    >
                      <option value="">— 選擇 Sheet 欄位 —</option>
                      {editTabHeaders.map((h, i) => <option key={h || `h-${i}`} value={h}>{h}</option>)}
                    </select>
                  )}
                  {editFieldMappings.length > 1 && (
                    <button type="button" onClick={() => setEditFieldMappings(prev => prev.filter((_, i) => i !== idx))}
                      style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>×</button>
                  )}
                </div>
              )
            })}
            <button type="button" className="btn-ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }}
              onClick={() => setEditFieldMappings(prev => [...prev, blankMapping()])}>
              + 新增欄位
            </button>
          </div>

          {/* Sheet 圖片欄 prefetch */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 10px', background: '#0c1a13', border: '1px solid #1a3a2a', borderRadius: 6 }}>
            <span style={{ fontSize: 12, color: '#4ade80', flexShrink: 0 }}>Sheet 圖片欄</span>
            <select
              value={editDescAttachCol}
              onChange={e => setEditDescAttachCol(e.target.value)}
              style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 5, border: '1px solid #1a3a2a', background: '#0f172a', color: '#e2e8f0', fontSize: 12 }}
            >
              <option value="">— 不從 Sheet 讀取圖片 —</option>
              {editTabHeaders.map((h, i) => <option key={h || `h-${i}`} value={h}>{h}</option>)}
            </select>
            <button type="button"
              onClick={handleEditDescPrefetch}
              disabled={!editDescAttachCol || editDescPrefetchLoading}
              style={{ padding: '5px 12px', borderRadius: 5, border: '1px solid #1a3a2a', background: editDescAttachCol ? '#1a3a2a' : '#0f172a', color: editDescAttachCol ? '#4ade80' : '#374151', fontSize: 12, cursor: editDescAttachCol ? 'pointer' : 'default', flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {editDescPrefetchLoading ? '讀取中…' : '讀取附件'}
            </button>
            <span style={{ fontSize: 11, color: '#475569', flexShrink: 0 }}>圖片自動快取，影片需手動上傳</span>
          </div>

          {/* Preview table */}
          {editTabSelectedKeys.size > 0 && (() => {
            const activeMaps = editFieldMappings.filter(m =>
              m.mode === 'sheet' ? !!m.sheetColumn : !!(m.manualValue || m.manualAccountId || m.manualAccountIds.length > 0)
            )
            const fieldLabel: Record<string, string> = { summary: '摘要', description: '描述', priority: '優先級', assignee: '受託人', labels: '標籤' }
            const selectedIssues = editTabIssues.filter(i => editTabSelectedKeys.has(i.issueKey))
            const jiraCols = ['summary', 'assignee', 'status'] as const
            const jiraColLabels: Record<string, string> = { summary: '摘要', assignee: '受託人', status: '狀態' }
            const thBase: React.CSSProperties = { padding: '6px 8px', borderBottom: '2px solid #1e3a5f', borderRight: '1px solid #1e3a5f', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', textAlign: 'left', background: '#0f2744' }
            const tdBase: React.CSSProperties = { padding: '4px 8px', borderRight: '1px solid #1e293b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220, verticalAlign: 'middle' }
            return (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa', marginBottom: 6 }}>
                  預覽變更（{editTabSelectedKeys.size} 筆）{activeMaps.length === 0 && <span style={{ fontSize: 11, color: '#475569', fontWeight: 400, marginLeft: 6 }}>← 選擇 Sheet 欄位後顯示對應欄</span>}
                </div>
                <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: `${110 + jiraCols.length * 120 + activeMaps.length * 360 + 100}px` }}>
                      <colgroup>
                        <col style={{ width: 110 }} />
                        {jiraCols.map(f => <col key={f} style={{ width: 140 }} />)}
                        {activeMaps.map((_, i) => (
                          <span key={i} style={{ display: 'contents' }}>
                            <col style={{ width: 'auto', minWidth: 140 }} />
                            <col style={{ width: 28 }} />
                            <col style={{ width: 'auto', minWidth: 140 }} />
                          </span>
                        ))}
                        <col style={{ width: 100 }} />
                      </colgroup>
                      <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                        <tr>
                          <th style={{ ...thBase, color: '#60a5fa' }}>Issue Key</th>
                          {jiraCols.map(f => <th key={f} style={{ ...thBase, color: '#94a3b8' }}>{jiraColLabels[f]}</th>)}
                          {activeMaps.map((m, i) => {
                            const fieldDisplayName = editTabAvailableFields.find(f => f.key === m.jiraField)?.name ?? fieldLabel[m.jiraField] ?? m.jiraField
                            return (
                              <span key={i} style={{ display: 'contents' }}>
                                <th style={{ ...thBase, color: '#6b7280', borderLeft: i === 0 ? '2px solid #2563eb40' : undefined }}>{fieldDisplayName} →</th>
                                <th style={{ ...thBase, color: '#475569', textAlign: 'center', width: 28 }} />
                                <th style={{ ...thBase, color: '#4ade80' }}>{m.mode === 'manual' ? '手動' : m.sheetColumn}</th>
                              </span>
                            )
                          })}
                          <th style={{ ...thBase, color: '#4ade80', background: '#12201a', borderLeft: '2px solid #1a3a2a' }}>附件</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedIssues.map((issue, idx) => {
                          const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
                          const jira = editTabJiraData[issue.issueKey]
                          const issueAtts = editDescAttachMap[issue.issueKey] ?? []
                          return (
                            <tr key={issue.issueKey} style={{ background: idx % 2 === 0 ? '#0a1628' : '#0d1e38', borderBottom: '1px solid #1e293b' }}>
                              <td style={{ ...tdBase }}>
                                <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${issue.issueKey}`} target="_blank" rel="noreferrer"
                                  style={{ color: '#93c5fd', fontWeight: 700, textDecoration: 'none' }}>{issue.issueKey}</a>
                              </td>
                              {jiraCols.map(f => (
                                <td key={f} style={{ ...tdBase, color: '#64748b' }}>
                                  {editTabJiraLoading && !jira ? <span style={{ color: '#374151' }}>…</span> : (jira?.[f] || '—')}
                                </td>
                              ))}
                              {activeMaps.map((m, i) => {
                                const current = jira?.[m.jiraField] ?? ''
                                const rawNext = m.mode === 'manual'
                                  ? (m.fieldType === 'multiuser' && m.manualAccountIds.length > 0
                                    ? m.manualLabels.join(', ')
                                    : m.manualValue || m.manualAccountId || '')
                                  : (rec?.[m.sheetColumn] ?? '').toString().trim()
                                const next = (() => {
                                  if (m.jiraField === 'summary' && summaryPrefixEnabled && rawNext && rec) {
                                    const prefix = computeSummaryPrefix(rec as Record<string, unknown>)
                                    return prefix ? prefix + rawNext : rawNext
                                  }
                                  return rawNext
                                })()
                                const changed = !!next && current !== next
                                return (
                                  <span key={i} style={{ display: 'contents' }}>
                                    <td style={{ ...tdBase, color: '#64748b', borderLeft: i === 0 ? '2px solid #2563eb40' : undefined }}>{current || '—'}</td>
                                    <td style={{ ...tdBase, color: '#475569', textAlign: 'center', padding: '4px 2px' }}>→</td>
                                    <td style={{ ...tdBase, color: changed ? '#4ade80' : '#374151', fontWeight: changed ? 600 : 400 }}>
                                      {next || <span style={{ color: '#374151' }}>（未設定）</span>}
                                      {m.mode === 'manual' && <span style={{ fontSize: 10, color: '#60a5fa', marginLeft: 4 }}>手動</span>}
                                    </td>
                                  </span>
                                )
                              })}
                              {/* Attachment cell */}
                              <td style={{ ...tdBase, background: '#0c1a13', borderLeft: '2px solid #1a3a2a', verticalAlign: 'top', overflow: 'visible', maxWidth: 'none', whiteSpace: 'normal' }}>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'flex-start', minWidth: 72 }}>
                                  {issueAtts.filter(a => a.cacheId && !a.error).map((att, ai) => (
                                    att.isImage ? (
                                      <img key={ai} src={`/api/jira/attachment-cache/${att.cacheId}`} alt={att.filename}
                                        style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4, border: '1px solid #2d4a2d', cursor: 'pointer', flexShrink: 0 }}
                                        onClick={() => setEditDescLightboxSrc(`/api/jira/attachment-cache/${att.cacheId}`)} />
                                    ) : (
                                      <span key={ai} title={att.filename} style={{ fontSize: 10, color: '#d29922', padding: '2px 4px', background: 'rgba(210,153,34,0.1)', border: '1px solid rgba(210,153,34,0.3)', borderRadius: 4 }}>啟</span>
                                    )
                                  ))}
                                  {issueAtts.filter(a => !a.cacheId).map((att, ai) => (
                                    att.isVideo
                                      ? <span key={`v-${ai}`} title={`${att.filename} — 影片無法自動下載，請用 + 手動上傳`} style={{ fontSize: 10, color: '#f59e0b', padding: '2px 4px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4 }}>需重新上傳</span>
                                      : <span key={`err-${ai}`} title={att.error ?? att.filename} style={{ fontSize: 10, color: '#f87171', padding: '2px 4px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 4 }}>{att.filename.slice(0, 10)}{att.filename.length > 10 ? '…' : ''}</span>
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
                                              setEditDescAttachMap(prev => ({
                                                ...prev,
                                                [issue.issueKey]: [
                                                  ...(prev[issue.issueKey] ?? []).filter(a => !!a.cacheId),
                                                  data,
                                                ],
                                              }))
                                            } else {
                                              setEditDescUploadErrors(prev => ({ ...prev, [issue.issueKey]: data.message ?? '上傳失敗' }))
                                            }
                                          } catch { setEditDescUploadErrors(prev => ({ ...prev, [issue.issueKey]: '網路錯誤' })) }
                                        }
                                        e.target.value = ''
                                      }} />
                                  </label>
                                  {editDescUploadErrors[issue.issueKey] && (
                                    <span style={{ fontSize: 10, color: '#f87171', width: '100%' }}>{editDescUploadErrors[issue.issueKey]}</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )
          })()}

          {editTabSubmitting && (() => {
            const ep = editProgress
            const epct = ep ? Math.round(ep.done / ep.total * 100) : 0
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8' }}>
                  <span>{ep ? `處理中 ${ep.done} / ${ep.total}` : '提交中...'}</span>
                  {ep && <span>{epct}%</span>}
                </div>
                <div style={{ height: 6, borderRadius: 3, background: '#1e2d3d', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, background: '#3b82f6', width: `${epct}%`, transition: 'width 0.3s ease', animation: epct === 0 ? 'progressPulse 1.5s ease-in-out infinite' : 'none' }} />
                </div>
              </div>
            )
          })()}
          <div className="stage-nav" style={{ marginTop: 16 }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setEditTabStep(2)}>上一步</button>
            <button type="button"
              className={`submit-btn submit-btn--step${editTabSubmitting ? ' loading' : ''}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              disabled={editTabSubmitting || !editFieldMappings.some(m => m.mode === 'sheet' ? !!m.sheetColumn : !!(m.manualValue || m.manualAccountId || m.manualAccountIds.length > 0)) || !currentAccount}
              onClick={handleEditTabSubmit}
            >
              {editTabSubmitting ? '修改中...' : `確認修改（${editTabSelectedKeys.size} 筆）`}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: 結果 */}
      {editTabStep === 4 && (
        <div className="section-card">
          <h2 className="section-title">批量修改結果</h2>

          <StepGuide title="操作說明 — 結果">
            <li>逐筆呼叫 Jira 修改 API（一次一筆），進度條依完成比例即時前進</li>
            <li>失敗的列會顯示 Jira 回傳的錯誤原因，方便判斷是欄位格式問題還是權限問題</li>
          </StepGuide>

          {editTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{editTabError}</div>}
          <div className="result-group" style={{ marginTop: 8 }}>
            {editTabResults.map(r => (
              <div key={r.issueKey} className={`result-row ${r.ok ? 'ok' : 'error'}`}>
                <code>
                  <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${r.issueKey}`} target="_blank" rel="noreferrer"
                    style={{ color: '#58a6ff', textDecoration: 'none' }}>
                    {r.issueKey}
                  </a>
                </code>
                {r.ok
                  ? <span className="badge badge--ok">修改成功 通過</span>
                  : <span className="err-msg">{r.error ?? '失敗'}</span>}
              </div>
            ))}
          </div>
          <div className="stage-nav" style={{ marginTop: 16 }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setEditTabStep(3)}>上一步</button>
            <button type="button" className="submit-btn submit-btn--step" style={{ background: '#166534' }}
              onClick={() => { setEditTabStep(1); setEditTabUrl(''); setEditTabIssues([]); setEditTabSelectedKeys(() => new Set()); setEditTabRecords([]); setEditTabHeaders([]); setEditTabResults([]); setEditTabError('') }}>
              完成，重新開始
            </button>
          </div>
        </div>
      )}
    </>
  )
}

import { StepGuide, ReloadSheetButton } from '../components/JiraStepWidgets'
import type { SheetRecord, TrackedIssue, SheetSource } from './JiraPage'

/**
 * 批量評論分頁 Step 1（貼 Sheet URL）與 Step 2（勾選要評論的 Issue）的畫面。
 * 純畫面元件，狀態仍留在 JiraPage.tsx（trackedIssues 等狀態跟批次開單流程共用，
 * 不是這個分頁自己獨立管理的一份，抽出去改成本地 state 會切斷這個共用連結）。
 * Step 3（實際設定評論內容 + 預覽送出）目前還留在 JiraPage.tsx 內，尚未拆出。
 */
export function JiraBatchCommentTab(props: {
  commentTabStep: 1 | 2 | 3
  commentTabSource: SheetSource
  setCommentTabSource: (v: SheetSource) => void
  commentTabUrl: string
  setCommentTabUrl: (v: string) => void
  commentTabError: string
  setCommentTabError: (v: string) => void
  commentTabLoading: boolean
  handleCommentTabLoad: () => void
  trackedIssues: TrackedIssue[]
  setTrackedIssues: (fn: (prev: TrackedIssue[]) => TrackedIssue[]) => void
  commentReloadMsg: string
  handleReloadCommentSheet: () => void
  commentFilterableColumns: string[]
  commentTabColFilters: Record<string, string>
  setCommentTabColFilters: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  commentColumnUniqueValues: Record<string, string[]>
  commentFilteredIssues: TrackedIssue[]
  commentTabSelectedKeys: Set<string>
  setCommentTabSelectedKeys: (fn: (prev: Set<string>) => Set<string>) => void
  sheetHeaders: string[]
  sheetRecords: SheetRecord[]
  setCommentTabStep: (v: 1 | 2 | 3) => void
}) {
  const {
    commentTabStep, commentTabSource, setCommentTabSource, commentTabUrl, setCommentTabUrl,
    commentTabError, setCommentTabError, commentTabLoading, handleCommentTabLoad,
    trackedIssues, setTrackedIssues, commentReloadMsg, handleReloadCommentSheet,
    commentFilterableColumns, commentTabColFilters, setCommentTabColFilters,
    commentColumnUniqueValues, commentFilteredIssues, commentTabSelectedKeys,
    setCommentTabSelectedKeys, sheetHeaders, sheetRecords, setCommentTabStep,
  } = props

  if (commentTabStep === 1) {
    return (
      <div className="section-card">
        <h2 className="section-title">批量評論</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
          貼入 Sheet URL，系統自動偵測含 Jira Issue Key 的列（格式如 ABC-123），批量添加評論與附件。
        </p>
        <div className="source-toggle">
          <button type="button" className={`source-btn source-btn--step${commentTabSource === 'lark' ? ' active' : ''}`}
            onClick={() => { setCommentTabSource('lark'); setCommentTabUrl(''); setCommentTabError('') }}>
            <span className="source-icon lark-icon">L</span>Lark Spreadsheet
          </button>
          <button type="button" className={`source-btn source-btn--step${commentTabSource === 'google' ? ' active' : ''}`}
            onClick={() => { setCommentTabSource('google'); setCommentTabUrl(''); setCommentTabError('') }}>
            <span className="source-icon google-icon">G</span>Google Sheets
          </button>
        </div>
        {commentTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{commentTabError}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <input
            value={commentTabUrl}
            onChange={e => setCommentTabUrl(e.target.value)}
            placeholder={commentTabSource === 'lark'
              ? 'https://casinoplus.sg.larksuite.com/wiki/... 或 Lark Sheet URL'
              : 'https://docs.google.com/spreadsheets/d/xxx/edit#gid=0'}
            style={{ flex: 1, padding: '7px 12px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
            onKeyDown={e => e.key === 'Enter' && handleCommentTabLoad()}
          />
          <button
            type="button"
            className="submit-btn submit-btn--step"
            disabled={commentTabLoading || !commentTabUrl.trim()}
            onClick={handleCommentTabLoad}
            style={{ whiteSpace: 'nowrap' }}
          >
            {commentTabLoading ? '讀取中…' : '讀取'}
          </button>
        </div>

        <StepGuide title="操作說明 — 這個功能需要什麼樣的 Sheet">
          <li>不需要先跑過「批量開單」流程 — 只要 Sheet 裡有一欄是 <b>Jira Issue Key</b>（格式如 <code>ABC-123</code>）就能用</li>
          <li>系統會自動掃描全表，抓出所有格式符合的 Issue Key，不限定欄位名稱或位置</li>
          <li>支援 Lark Sheet / Google Sheets 兩種來源，切換上方按鈕即可</li>
          <li>若表格完全找不到符合格式的 Issue Key，會顯示「找不到已開單的 Jira Issue Key」錯誤</li>
        </StepGuide>
      </div>
    )
  }

  if (commentTabStep === 2) {
    return (
      <div className="section-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
          <h2 className="section-title" style={{ margin: 0 }}>選擇要評論的 Issue（共 {trackedIssues.length} 筆）</h2>
          <ReloadSheetButton loading={commentTabLoading} msg={commentReloadMsg} onClick={handleReloadCommentSheet} />
        </div>

        <StepGuide title="操作說明 — 篩選與勾選">
          <li>系統自動偵測表格中「2–15 個唯一值」的欄位（如嚴重度、類別、進度）顯示為篩選 dropdown</li>
          <li>可先用篩選器縮小範圍，再用「全選 / 取消全選」快速勾選符合條件的列</li>
          <li>下方會展示該列 Sheet 原始欄位內容，方便核對是不是要評論的單子</li>
        </StepGuide>

        {/* Column filters */}
        {commentFilterableColumns.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>篩選：</span>
            {commentFilterableColumns.map(col => (
              <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
                <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{col}</span>
                <select value={commentTabColFilters[col] ?? ''} onChange={e => setCommentTabColFilters(prev => ({ ...prev, [col]: e.target.value }))}
                  style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155' }}>
                  <option value="">全部</option>
                  {(commentColumnUniqueValues[col] ?? []).map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            ))}
            {Object.values(commentTabColFilters).some(Boolean) && (
              <button type="button" onClick={() => setCommentTabColFilters(() => ({}))}
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
              checked={commentFilteredIssues.length > 0 && commentFilteredIssues.every(i => commentTabSelectedKeys.has(i.issueKey))}
              onChange={e => setCommentTabSelectedKeys(prev => {
                const n = new Set(prev)
                commentFilteredIssues.forEach(i => e.target.checked ? n.add(i.issueKey) : n.delete(i.issueKey))
                return n
              })}
            />
            全選 / 取消全選
          </label>
          <span style={{ fontSize: 11, color: '#60a5fa' }}>
            已選 {commentTabSelectedKeys.size} / {trackedIssues.length} 筆
            {commentFilteredIssues.length < trackedIssues.length && <span style={{ color: '#94a3b8' }}>{`（篩選顯示 ${commentFilteredIssues.length} 筆）`}</span>}
          </span>
        </div>

        {(() => {
          const visibleCols = sheetHeaders.filter(h => !h.endsWith('__url') && h !== '_rowIndex' && !commentFilteredIssues.every(i => {
            const rec = sheetRecords.find(r => Number(r._rowIndex) === i.rowIndex)
            return !(rec?.[h] ?? '').trim()
          })).slice(0, 7)
          const thStyle: React.CSSProperties = { padding: '7px 10px', borderBottom: '2px solid #1e3a5f', borderRight: '1px solid #1e3a5f', fontSize: 11, fontWeight: 700, color: '#60a5fa', whiteSpace: 'nowrap', textAlign: 'left', background: '#0f2744' }
          const tdBase: React.CSSProperties = { padding: '5px 10px', borderRight: '1px solid #1e293b', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }
          return (
            <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: `${36 + 110 + visibleCols.length * 160}px` }}>
                  <colgroup>
                    <col style={{ width: 36 }} />
                    <col style={{ width: 110 }} />
                    {visibleCols.map(h => <col key={h} style={{ width: 160 }} />)}
                  </colgroup>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={{ ...thStyle, width: 36, textAlign: 'center' }} />
                      <th style={thStyle}>Issue Key</th>
                      {visibleCols.map(h => <th key={h} style={thStyle}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {commentFilteredIssues.length === 0 ? (
                      <tr><td colSpan={2 + visibleCols.length} style={{ padding: '12px 16px', fontSize: 12, color: '#64748b', textAlign: 'center' }}>篩選條件下無符合的 Issue</td></tr>
                    ) : commentFilteredIssues.map((issue, idx) => {
                      const isSelected = commentTabSelectedKeys.has(issue.issueKey)
                      const rec = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
                      return (
                        <tr key={issue.issueKey}
                          onClick={() => setCommentTabSelectedKeys(prev => { const n = new Set(prev); isSelected ? n.delete(issue.issueKey) : n.add(issue.issueKey); return n })}
                          style={{ background: isSelected ? (idx % 2 === 0 ? '#0a1628' : '#0d1e38') : '#070f1e', opacity: isSelected ? 1 : 0.45, cursor: 'pointer', borderBottom: '1px solid #1e293b' }}>
                          <td style={{ ...tdBase, width: 36, textAlign: 'center' }}>
                            <input type="checkbox" checked={isSelected} readOnly
                              onChange={e => { e.stopPropagation(); setCommentTabSelectedKeys(prev => { const n = new Set(prev); e.target.checked ? n.add(issue.issueKey) : n.delete(issue.issueKey); return n }) }}
                              onClick={e => e.stopPropagation()}
                            />
                          </td>
                          <td style={{ ...tdBase, whiteSpace: 'nowrap' }}>
                            <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${issue.issueKey}`} target="_blank" rel="noreferrer"
                              onClick={e => e.stopPropagation()}
                              style={{ color: '#93c5fd', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}>
                              {issue.issueKey}
                            </a>
                          </td>
                          {visibleCols.map(h => (
                            <td key={h} style={{ ...tdBase, color: '#94a3b8' }}>
                              {(rec?.[h] ?? '').trim() || <span style={{ color: '#374151' }}>—</span>}
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
          <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setCommentTabStep(1)}>← 重新讀取</button>
          <button type="button" className="submit-btn submit-btn--step"
            disabled={commentTabSelectedKeys.size === 0}
            onClick={() => {
              setTrackedIssues(prev => prev.filter(i => commentTabSelectedKeys.has(i.issueKey)))
              setCommentTabStep(3)
            }}>
            下一步：設定評論（{commentTabSelectedKeys.size} 筆）→
          </button>
        </div>
      </div>
    )
  }

  return null
}

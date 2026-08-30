import { XianxiaIcon } from '../components/XianxiaIcon'
import { StepGuide, ReloadSheetButton } from '../components/JiraStepWidgets'
import { SheetUrlEntryStep } from '../components/SheetUrlEntryStep'
import type { AccountInfo } from '../components/JiraAccountModal'
import type { JiraTransitionOption, SheetSource } from './JiraPage'

type UpdateStep = 1 | 2 | 3
type UpdateRecord = { issueKey: string; rowIndex: number }

/**
 * 批量更新狀態分頁（Step 1 讀表格 → Step 2 選帳號/動作 → Step 3 結果）。
 * 純畫面元件，狀態留在 JiraPage.tsx 以 props 傳入——這個分頁的狀態本來就是
 * 自己獨立一份（updateXxx 系列），不像批量評論那樣跟批次開單流程共用 trackedIssues。
 */
export function JiraBatchUpdateTab(props: {
  updateStep: UpdateStep
  setUpdateStep: (v: UpdateStep) => void
  updateTabSource: SheetSource
  setUpdateTabSource: (v: SheetSource) => void
  updateBitableUrl: string
  setUpdateBitableUrl: (v: string) => void
  updateError: string
  setUpdateError: (v: string) => void
  handleUpdateFetchBitable: () => void
  updateLoading: boolean
  updateReloadMsg: string
  handleReloadUpdateSheet: () => void
  updateRecords: UpdateRecord[]
  updateFilterableColumns: string[]
  updateTabColFilters: Record<string, string>
  setUpdateTabColFilters: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  updateColumnUniqueValues: Record<string, string[]>
  updateFilteredRecords: UpdateRecord[]
  updateJiraStatusFilter: string
  setUpdateJiraStatusFilter: (v: string) => void
  updateJiraStatusOptions: string[]
  currentAccount: AccountInfo | null
  updateTransitions: JiraTransitionOption[]
  updateTransitionId: string
  setUpdateTransitionId: (v: string) => void
  updateJiraError: string
  fetchUpdateJiraData: (issueKeys: string[]) => void
  rdFieldDetecting: boolean
  setRdFieldDetecting: (v: boolean) => void
  rdFieldCandidates: { fieldId: string; fieldName: string; value: string }[] | null
  setRdFieldCandidates: (v: { fieldId: string; fieldName: string; value: string }[] | null) => void
  emailHeader: Record<string, string>
  updateJiraData: Record<string, Record<string, string>>
  updateSelectedKeys: Set<string>
  setUpdateSelectedKeys: (fn: (prev: Set<string>) => Set<string>) => void
  updateJiraLoading: boolean
  updateValidationErrors: { issueKey: string; missing: string[] }[]
  updateSubmitting: boolean
  updateProgress: { done: number; total: number } | null
  updateTitleWritebackLoading: boolean
  handleUpdateTitleWriteback: () => void
  updateTitleWritebackMsg: string
  handleUpdateExecute: () => void
  updateResults: { issueKey: string; ok: boolean; skipped?: boolean; error?: string }[]
  handleUpdateReset: () => void
}) {
  const {
    updateStep, setUpdateStep, updateTabSource, setUpdateTabSource, updateBitableUrl, setUpdateBitableUrl,
    updateError, setUpdateError, handleUpdateFetchBitable, updateLoading, updateReloadMsg, handleReloadUpdateSheet,
    updateRecords, updateFilterableColumns, updateTabColFilters, setUpdateTabColFilters, updateColumnUniqueValues,
    updateFilteredRecords, updateJiraStatusFilter, setUpdateJiraStatusFilter, updateJiraStatusOptions,
    currentAccount, updateTransitions, updateTransitionId, setUpdateTransitionId, updateJiraError,
    fetchUpdateJiraData, rdFieldDetecting, setRdFieldDetecting, rdFieldCandidates, setRdFieldCandidates,
    emailHeader, updateJiraData, updateSelectedKeys, setUpdateSelectedKeys, updateJiraLoading,
    updateValidationErrors, updateSubmitting, updateProgress, updateTitleWritebackLoading,
    handleUpdateTitleWriteback, updateTitleWritebackMsg, handleUpdateExecute, updateResults, handleUpdateReset,
  } = props

  return (
    <>
      {/* Step 1: 讀取表格 */}
      {updateStep === 1 && (
        <SheetUrlEntryStep
          title="Step 1 — 讀取表格"
          description="貼入 Sheet URL，系統自動偵測含 Jira 單號的列"
          source={updateTabSource}
          onSourceChange={s => { setUpdateTabSource(s); setUpdateBitableUrl(''); setUpdateError('') }}
          url={updateBitableUrl}
          onUrlChange={setUpdateBitableUrl}
          error={updateError}
          loading={updateLoading}
          onSubmit={handleUpdateFetchBitable}
          larkPlaceholder="Lark Sheet URL（/wiki/ 或 /sheets/）"
          guideTitle="操作說明 — 這個功能需要什麼樣的 Sheet"
        >
          <li>只要有一欄是 <b>Jira Issue Key</b>（如 <code>ABC-123</code>）即可，不限欄位名稱或位置</li>
          <li>讀取後會自動嘗試載入可用的狀態轉換（Transition）選項，供 Step 2 選擇</li>
          <li>支援 Lark Sheet / Google Sheets 兩種來源</li>
        </SheetUrlEntryStep>
      )}

      {/* Step 2: 設定帳號 & 動作 */}
      {updateStep === 2 && (
        <div className="section-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 className="section-title" style={{ margin: 0 }}>Step 2 — 選擇帳號 & 動作</h2>
            <ReloadSheetButton loading={updateLoading} msg={updateReloadMsg} onClick={handleReloadUpdateSheet} />
          </div>
          <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 12px' }}>
            共 <b style={{ color: '#e2e8f0' }}>{updateRecords.length}</b> 張單
          </p>

          <StepGuide title="操作說明 — 狀態切換與驗證">
            <li>系統會依序用「目前帳號」與「所有已儲存帳號」嘗試讀取該 Issue 可用的 Transition 選項（不同帳號權限可能不同）</li>
            <li>執行前會重新從 Jira 抓最新資料，驗證 <b>摘要 / 描述 / 受託人 / RD負責人</b> 是否都有值，缺漏會擋下並列出問題單號（可點擊捲動定位）</li>
            <li>「察 偵測 RD 欄位」：掃描該 Issue 所有 custom user field，列出欄位 ID / 名稱 / 目前值，方便確認 RD負責人抓的是哪個欄位</li>
            <li>「文 回填單子標題」：把 Jira Key 超連結 + 摘要寫回 Sheet 的「單子標題貼這」欄，與正式執行分開，可單獨先跑</li>
          </StepGuide>

          {/* 切換狀態 */}
          <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>切換狀態：</span>
            {updateTransitions.length > 0 ? (
              <select
                value={updateTransitionId}
                onChange={e => setUpdateTransitionId(e.target.value)}
                style={{ fontSize: 12, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '4px 8px' }}
              >
                <option value="">（不切換）</option>
                {updateTransitions.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.toName ?? t.name}{t.toName && t.toName !== t.name ? `（${t.name}）` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontSize: 12, color: '#64748b' }}>
                {currentAccount ? '讀取轉換選項失敗，可跳過' : '請先選擇帳號（右上角）'}
              </span>
            )}
          </div>

          {/* Jira error */}
          {updateJiraError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#1e1010', border: '1px solid #7f1d1d60', borderRadius: 6, padding: '8px 12px', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: '#f87171', flex: 1 }}>{updateJiraError}</span>
              <button type="button"
                style={{ fontSize: 12, padding: '4px 12px', borderRadius: 5, border: '1px solid #f8717160', background: '#7f1d1d30', color: '#fca5a5', cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={() => fetchUpdateJiraData(updateRecords.map(r => r.issueKey))}>
                重新載入 Jira 資料
              </button>
            </div>
          )}

          {/* Column filters */}
          {updateFilterableColumns.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>篩選：</span>
              {updateFilterableColumns.map(col => (
                <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
                  <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{col}</span>
                  <select value={updateTabColFilters[col] ?? ''} onChange={e => setUpdateTabColFilters(prev => ({ ...prev, [col]: e.target.value }))}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155' }}>
                    <option value="">全部</option>
                    {(updateColumnUniqueValues[col] ?? []).map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              ))}
              {Object.values(updateTabColFilters).some(Boolean) && (
                <button type="button" onClick={() => setUpdateTabColFilters(() => ({}))}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #334155', background: 'none', cursor: 'pointer', color: '#94a3b8' }}>
                  清除篩選
                </button>
              )}
            </div>
          )}

          {/* Jira 即時狀態篩選——跟上面的 Sheet 欄位篩選是不同資料來源（這欄是即時抓回的 Jira 狀態，
              不是 Sheet 本身的欄位），獨立一排並標明來源避免使用者搞混 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>Jira 目前狀態篩選：</span>
            <select value={updateJiraStatusFilter} onChange={e => setUpdateJiraStatusFilter(e.target.value)}
              disabled={updateJiraStatusOptions.length === 0}
              style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155' }}>
              <option value="">全部</option>
              {updateJiraStatusOptions.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
            {updateJiraStatusOptions.length === 0 && (
              <span style={{ fontSize: 11, color: '#64748b' }}>（Jira 狀態載入中，選項會陸續補齊）</span>
            )}
            {updateJiraStatusFilter && (
              <button type="button" onClick={() => setUpdateJiraStatusFilter('')}
                style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #334155', background: 'none', cursor: 'pointer', color: '#94a3b8' }}>
                清除
              </button>
            )}
          </div>

          {/* Preview table */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa' }}>
                預覽（共 {updateRecords.length} 張）
              </div>
              <span style={{ fontSize: 11, color: '#60a5fa' }}>
                已選 {updateRecords.filter(r => updateSelectedKeys.has(r.issueKey)).length} / {updateRecords.length} 張
                {updateFilteredRecords.length < updateRecords.length && <span style={{ color: '#94a3b8' }}>{`（篩選顯示 ${updateFilteredRecords.length} 筆）`}</span>}
              </span>
              <button type="button"
                disabled={rdFieldDetecting || updateRecords.length === 0 || !currentAccount}
                style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid #334155', background: '#1e293b', color: '#94a3b8', cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={async () => {
                  const sampleKey = updateRecords[0]?.issueKey
                  if (!sampleKey || !currentAccount) return
                  setRdFieldDetecting(true); setRdFieldCandidates(null)
                  try {
                    const r = await fetch('/api/jira/detect-rd-fields', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', ...emailHeader },
                      body: JSON.stringify({ issueKey: sampleKey }),
                    })
                    const d = await r.json() as { ok: boolean; candidates?: { fieldId: string; fieldName: string; value: string }[] }
                    setRdFieldCandidates(d.candidates ?? [])
                  } catch { setRdFieldCandidates([]) } finally { setRdFieldDetecting(false) }
                }}>
                {rdFieldDetecting ? '偵測中...' : '偵測 RD 欄位'}
              </button>
            </div>
            {rdFieldCandidates !== null && (
              <div style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 12 }}>
                <div style={{ color: '#60a5fa', fontWeight: 700, marginBottom: 6 }}>
                  以 {updateRecords[0]?.issueKey} 掃描到的 custom user fields：
                </div>
                {rdFieldCandidates.length === 0
                  ? <span style={{ color: '#94a3b8' }}>未找到任何 custom user field 有值</span>
                  : rdFieldCandidates.map(c => (
                    <div key={c.fieldId} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                      <code style={{ color: '#f59e0b', background: '#1e293b', padding: '1px 6px', borderRadius: 3 }}>{c.fieldId}</code>
                      <span style={{ color: '#e2e8f0' }}>{c.fieldName}</span>
                      <span style={{ color: '#64748b' }}>= {c.value}</span>
                    </div>
                  ))
                }
                <div style={{ marginTop: 6, color: '#64748b', fontSize: 11 }}>
                  系統目前使用的 RD 欄位：{updateJiraData[updateRecords[0]?.issueKey ?? '']?.rdOwner !== undefined ? '已抓到值' : '值為空（可能需更新偵測）'}
                </div>
                <button type="button" style={{ marginTop: 4, fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setRdFieldCandidates(null)}>關閉</button>
              </div>
            )}
            <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: 36 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 90 }} />
                    <col />
                    <col style={{ width: 110 }} />
                  </colgroup>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr style={{ background: '#0f2744', borderBottom: '1px solid #1e3a5f' }}>
                      <th style={{ padding: '5px 8px', borderRight: '1px solid #1e3a5f' }}>
                        <input type="checkbox"
                          checked={updateFilteredRecords.length > 0 && updateFilteredRecords.every(r => updateSelectedKeys.has(r.issueKey))}
                          onChange={e => {
                            setUpdateSelectedKeys(prev => {
                              const next = new Set(prev)
                              updateFilteredRecords.forEach(r => e.target.checked ? next.add(r.issueKey) : next.delete(r.issueKey))
                              return next
                            })
                          }}
                        />
                      </th>
                      <th style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', textAlign: 'left', borderRight: '1px solid #1e3a5f' }}>單號</th>
                      <th style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', textAlign: 'left', borderRight: '1px solid #1e3a5f' }}>狀態</th>
                      <th style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', textAlign: 'left', borderRight: '1px solid #1e3a5f' }}>摘要</th>
                      <th style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', textAlign: 'left' }}>受託人</th>
                    </tr>
                  </thead>
                  <tbody>
                    {updateFilteredRecords.length === 0 ? (
                      <tr><td colSpan={5} style={{ padding: '12px 16px', fontSize: 12, color: '#64748b', textAlign: 'center' }}>篩選條件下無符合的 Issue</td></tr>
                    ) : updateFilteredRecords.slice(0, 200).map((r, idx) => {
                      const isSelected = updateSelectedKeys.has(r.issueKey)
                      const jira = updateJiraData[r.issueKey]
                      return (
                        <tr key={r.issueKey}
                          onClick={() => setUpdateSelectedKeys(prev => { const n = new Set(prev); isSelected ? n.delete(r.issueKey) : n.add(r.issueKey); return n })}
                          style={{ background: isSelected ? (idx % 2 === 0 ? '#0a1628' : '#0d1e38') : '#070f1e', opacity: isSelected ? 1 : 0.45, cursor: 'pointer', borderBottom: '1px solid #1e293b' }}>
                          <td style={{ padding: '5px 8px', borderRight: '1px solid #1e293b', textAlign: 'center' }}
                            onClick={e => e.stopPropagation()}>
                            <input type="checkbox" checked={isSelected}
                              onChange={e => {
                                setUpdateSelectedKeys(prev => {
                                  const next = new Set(prev)
                                  e.target.checked ? next.add(r.issueKey) : next.delete(r.issueKey)
                                  return next
                                })
                              }}
                            />
                          </td>
                          <td style={{ padding: '5px 10px', borderRight: '1px solid #1e293b' }}
                            onClick={e => e.stopPropagation()}>
                            <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${r.issueKey}`} target="_blank" rel="noreferrer"
                              style={{ color: '#93c5fd', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}
                              onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                              onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                            >{r.issueKey}</a>
                          </td>
                          <td style={{ padding: '5px 10px', borderRight: '1px solid #1e293b', fontSize: 11, color: '#94a3b8' }}>
                            {updateJiraLoading && !jira ? <span style={{ color: '#374151' }}>載入中…</span>
                              : jira ? (jira.status || '—') : '—'}
                          </td>
                          <td style={{ padding: '5px 10px', borderRight: '1px solid #1e293b', fontSize: 11, color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {updateJiraLoading && !jira ? <span style={{ color: '#374151' }}>載入中…</span>
                              : jira ? (jira.summary || '—') : '—'}
                          </td>
                          <td style={{ padding: '5px 10px', fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {jira ? (jira.assignee || '—') : '—'}
                          </td>
                        </tr>
                      )
                    })}
                    {updateFilteredRecords.length > 200 && (
                      <tr><td colSpan={5} style={{ fontSize: 11, color: '#64748b', textAlign: 'center', padding: '6px 0' }}>...還有 {updateFilteredRecords.length - 200} 張</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Validation errors */}
          {updateValidationErrors.length > 0 && (
            <div style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f87171', marginBottom: 8 }}>
                警 {updateValidationErrors.length} 張單欄位不完整，無法送出：
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
                {updateValidationErrors.map(e => (
                  <div key={e.issueKey} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                    <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${e.issueKey}`} target="_blank" rel="noreferrer"
                      style={{ color: '#93c5fd', fontWeight: 700, textDecoration: 'none', flexShrink: 0 }}>{e.issueKey}</a>
                    <span style={{ color: '#fca5a5' }}>缺：{e.missing.join('、')}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                請補齊以上欄位後再執行，或取消勾選這些單
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {updateSubmitting && (() => {
              const up = updateProgress
              const upct = up ? Math.round(up.done / up.total * 100) : 0
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8' }}>
                    <span>{up ? `處理中 ${up.done} / ${up.total}` : '提交中...'}</span>
                    {up && <span>{upct}%</span>}
                  </div>
                  <div className="batch-progress-track" style={{ height: 6, borderRadius: 3, background: '#1e2d3d', overflow: 'hidden' }}>
                    <div className="batch-progress-fill" style={{ height: '100%', borderRadius: 3, background: '#3b82f6', width: `${upct}%`, transition: 'width 0.3s ease' }} />
                  </div>
                </div>
              )
            })()}
            <div className="stage-nav" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setUpdateStep(1)}>上一步</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={handleUpdateTitleWriteback}
                  disabled={updateTitleWritebackLoading || updateSelectedKeys.size === 0}
                  style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #1a3a2a', background: updateSelectedKeys.size > 0 ? '#1a3a2a' : '#0f172a', color: updateSelectedKeys.size > 0 ? '#4ade80' : '#374151', fontSize: 13, cursor: updateSelectedKeys.size > 0 ? 'pointer' : 'default', whiteSpace: 'nowrap' }}
                >
                  {updateTitleWritebackLoading ? '回填中…' : `回填單子標題（${updateSelectedKeys.size} 筆）`}
                </button>
                {updateTitleWritebackMsg && (
                  <span style={{ fontSize: 12, color: updateTitleWritebackMsg.startsWith('通過') ? '#4ade80' : '#f87171' }}>
                    {updateTitleWritebackMsg}
                  </span>
                )}
                <button
                  type="button"
                  className={`submit-btn submit-btn--step${updateSubmitting ? ' loading' : ''}`}
                  disabled={updateSubmitting || !currentAccount || updateRecords.filter(r => updateSelectedKeys.has(r.issueKey)).length === 0}
                  onClick={handleUpdateExecute}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {updateSubmitting ? '執行中…' : `▶ 執行（${updateRecords.filter(r => updateSelectedKeys.has(r.issueKey)).length} 張）`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: 結果 */}
      {updateStep === 3 && (
        <div className="section-card">
          <h2 className="section-title">執行結果</h2>

          <StepGuide title="操作說明 — 結果與回填">
            <li>逐筆呼叫狀態轉換（一次一筆），進度條依完成比例即時前進</li>
            <li>成功的列會自動回寫「處理階段＝已切換狀態」與「處理時間」到來源 Sheet</li>
          </StepGuide>

          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: '#4ade80', fontWeight: 700 }}>
              通過 成功 {updateResults.filter(r => r.ok && !r.skipped).length} 張
            </span>
            {updateResults.some(r => r.skipped) && (
              <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 700 }}>
                ⏭ 跳過（未選擇目標狀態）{updateResults.filter(r => r.skipped).length} 張
              </span>
            )}
            {updateResults.some(r => !r.ok) && (
              <span style={{ fontSize: 13, color: '#f87171', fontWeight: 700 }}>
                失敗 失敗 {updateResults.filter(r => !r.ok).length} 張
              </span>
            )}
          </div>
          <div style={{ maxHeight: 400, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {updateResults.map(r => (
              <div key={r.issueKey} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px', background: r.skipped ? 'rgba(148,163,184,0.06)' : r.ok ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)', border: `1px solid ${r.skipped ? 'rgba(148,163,184,0.2)' : r.ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`, borderRadius: 6, fontSize: 12 }}>
                <span><XianxiaIcon name={r.skipped || !r.ok ? 'warning' : 'overview'} size={18} /></span>
                <code style={{ color: '#93c5fd', fontWeight: 700 }}>{r.issueKey}</code>
                {r.skipped
                  ? <span style={{ color: '#94a3b8', fontSize: 11 }}>未選擇目標狀態，未呼叫 Jira</span>
                  : r.ok ? <span className="badge badge--ok">已更新</span> : <span style={{ color: '#fca5a5', fontSize: 11 }}>{r.error}</span>}
              </div>
            ))}
          </div>
          <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 16, background: '#166534' }} onClick={handleUpdateReset}>
            重新開始
          </button>
        </div>
      )}
    </>
  )
}

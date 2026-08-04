import { DungeonIcon } from '../components/DungeonIcon'
import { useIsGameMode } from '../components/GameModeContext'
import type { AccountInfo } from '../components/JiraAccountModal'
import type { PMRecord, PMResult } from './JiraPage'

/**
 * PM 模式（從 Lark PM 規格讀取、批次建立 Epic + Story）。純畫面元件，狀態留在
 * JiraPage.tsx 以 props 傳入——這個模式的狀態本來就是獨立一份（pmXxx 系列），
 * 跟 QA 模式的 trackedIssues 完全無關。
 */
export function JiraPmModeTab(props: {
  pmStep: 1 | 2 | 3
  setPmStep: (v: 1 | 2 | 3) => void
  pmBitableUrl: string
  setPmBitableUrl: (v: string) => void
  pmParentKey: string
  setPmParentKey: (v: string) => void
  pmError: string
  setPmError: (v: string) => void
  pmLoading: boolean
  handlePmFetchBitable: () => void
  currentAccount: AccountInfo | null
  pmRecords: PMRecord[]
  pmSelectedIds: Set<string>
  setPmSelectedIds: (v: Set<string>) => void
  pmSubmitting: boolean
  handlePmCreate: () => void
  pmResults: PMResult[]
  handlePmReset: () => void
}) {
  const isGame = useIsGameMode()
  const {
    pmStep, setPmStep, pmBitableUrl, setPmBitableUrl, pmParentKey, setPmParentKey, pmError, setPmError,
    pmLoading, handlePmFetchBitable, currentAccount, pmRecords, pmSelectedIds, setPmSelectedIds,
    pmSubmitting, handlePmCreate, pmResults, handlePmReset,
  } = props

  return (
    <>
      {/* PM Step 1: 貼 Bitable URL */}
      {pmStep === 1 && (
        <div className="section-card">
          <h2 className="section-title">Step 1 — 讀取 Lark 表格</h2>
          {!currentAccount && <div className="alert-warn" style={{ marginBottom: 12 }}>請先點右上角「選擇帳號」</div>}
          <div className="form-stack">
            <label className="field">
              <span>Lark Bitable 網址<em className="req"> *</em></span>
              <input value={pmBitableUrl} onChange={e => setPmBitableUrl(e.target.value)}
                placeholder="https://casinoplus.sg.larksuite.com/base/xxx?table=tblxxx" />
              <span className="field-hint">貼上含 ?table=xxx 的完整網址，系統會自動讀取待開單列（JIRA索引鍵為空的列）</span>
            </label>
            <label className="field">
              <span>主單號（可選）</span>
              <input value={pmParentKey} onChange={e => setPmParentKey(e.target.value)}
                placeholder="例如 DSFT-100" />
              <span className="field-hint">
                通常可留空。填入時機：<br />
                • <strong>不填</strong>：若 Bitable 的「選擇主單並關聯」欄位已填好標題，系統會自動在同批次 Issue 之間建立關聯，不需要這裡輸入任何東西。<br />
                • <strong>填入已有單號（如 DSFT-100）</strong>：將本次批次中，沒有在「選擇主單並關聯」填值的 Issue，全部連結到這張已存在的 Jira 單下。
              </span>
            </label>
            {pmError && <div className="alert-error">{pmError}</div>}
          </div>
          <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 16 }}
            disabled={!currentAccount || !pmBitableUrl.trim() || pmLoading} onClick={handlePmFetchBitable}>
            {pmLoading ? '讀取中...' : '讀取表格'}
          </button>
        </div>
      )}

      {/* PM Step 2: 確認清單 */}
      {pmStep === 2 && (
        <div className="section-card">
          <h2 className="section-title">Step 2 — 確認開單清單</h2>

          {/* Summary bar */}
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16, padding: '10px 14px', background: '#162032', borderRadius: 8, border: '1px solid #2d3f55' }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>
              共 <strong style={{ color: '#e2e8f0' }}>{pmRecords.length}</strong> 筆，已選 <strong style={{ color: '#a5b4fc' }}>{pmSelectedIds.size}</strong> 筆
            </span>
            {pmRecords.some(r => r.isParent) && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(124,58,237,0.15)', color: '#c4b5fd', fontWeight: 600, borderRadius: 20, padding: '3px 10px', fontSize: 12 }}>
                偵測到主單，填有「主單標題」的子單將自動關聯
              </span>
            )}
            {!pmRecords.some(r => r.isParent) && pmParentKey && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(124,58,237,0.15)', color: '#c4b5fd', fontWeight: 600, borderRadius: 20, padding: '3px 10px', fontSize: 12 }}>
                手動主單：{pmParentKey}
              </span>
            )}
          </div>

          <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #2d3f55' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#162032', borderBottom: '1px solid #2d3f55' }}>
                  <th style={{ width: 40, padding: '10px 12px', textAlign: 'center' }}>
                    <input type="checkbox"
                      checked={pmSelectedIds.size === pmRecords.length && pmRecords.length > 0}
                      onChange={e => setPmSelectedIds(e.target.checked ? new Set(pmRecords.map(r => r.recordId)) : new Set())} />
                  </th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8' }}>標題</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>專案</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>類型</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8' }}>受託人</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>難易度</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>所屬主單</th>
                </tr>
              </thead>
              <tbody>
                {pmRecords.map((r, i) => (
                  <tr key={r.recordId} style={{
                    opacity: pmSelectedIds.has(r.recordId) ? 1 : 0.45,
                    borderBottom: i < pmRecords.length - 1 ? '1px solid #1e293b' : 'none',
                    background: r.isParent ? 'rgba(124,58,237,0.08)' : 'transparent',
                    borderLeft: r.isParent ? '3px solid #7c3aed' : '3px solid transparent',
                  }}>
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <input type="checkbox" checked={pmSelectedIds.has(r.recordId)}
                        onChange={e => {
                          const next = new Set(pmSelectedIds)
                          e.target.checked ? next.add(r.recordId) : next.delete(r.recordId)
                          setPmSelectedIds(next)
                        }} />
                    </td>
                    <td style={{ padding: '10px 12px', maxWidth: 360 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {r.isParent && (
                          <span style={{ background: '#7c3aed', color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}>主單</span>
                        )}
                        <span style={{ color: '#e2e8f0', lineHeight: 1.4 }}>{r.summary}</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#64748b', whiteSpace: 'nowrap' }}>{r.jiraProjectName}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ background: 'rgba(99,102,241,0.1)', color: '#a5b4fc', borderRadius: 4, padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' }}>{r.issueTypeName}</span>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#64748b', fontSize: 12 }}>{r.assigneeEmail || '—'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {r.difficulty ? (
                        <span style={{ background: 'rgba(16,185,129,0.1)', color: '#34d399', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>{r.difficulty}</span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: r.parentTitle ? '#7c3aed' : '#d1d5db', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.parentTitle || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pmError && <div className="alert-error" style={{ marginTop: 12 }}>{pmError}</div>}

          <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
            <button type="button" className="btn-ghost btn-ghost--step" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => { setPmStep(1); setPmError('') }}>← 返回</button>
            <button type="button" className="submit-btn submit-btn--step" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              disabled={pmSelectedIds.size === 0 || pmSubmitting} onClick={handlePmCreate}>
              {pmSubmitting ? `開單中...` : `建立 ${pmSelectedIds.size} 筆 Issues`}
            </button>
          </div>
        </div>
      )}

      {/* PM Step 3: 結果 */}
      {pmStep === 3 && (
        <div className="section-card">
          <h2 className="section-title">Step 3 — 開單結果</h2>

          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            <div style={{ flex: 1, padding: '16px 20px', background: 'rgba(16,185,129,0.08)', borderRadius: 10, border: '1px solid rgba(16,185,129,0.25)', textAlign: 'center' }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: '#34d399', lineHeight: 1 }}>{pmResults.filter(r => r.issueKey).length}</div>
              <div style={{ fontSize: 13, color: '#6ee7b7', marginTop: 4, fontWeight: 600 }}>通過 成功建立</div>
            </div>
            <div style={{ flex: 1, padding: '16px 20px', background: pmResults.some(r => r.error) ? 'rgba(239,68,68,0.08)' : '#162032', borderRadius: 10, border: `1px solid ${pmResults.some(r => r.error) ? 'rgba(239,68,68,0.3)' : '#2d3f55'}`, textAlign: 'center' }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: pmResults.some(r => r.error) ? '#f87171' : '#475569', lineHeight: 1 }}>{pmResults.filter(r => r.error).length}</div>
              <div style={{ fontSize: 13, color: pmResults.some(r => r.error) ? '#fca5a5' : '#475569', marginTop: 4, fontWeight: 600 }}>失敗 失敗</div>
            </div>
          </div>

          {/* Result rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pmResults.map(r => (
              <div key={r.recordId} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                borderRadius: 8, border: `1px solid ${r.issueKey ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
                background: r.issueKey ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
              }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{r.issueKey ? (isGame ? <DungeonIcon name="status-ok" tone="green" plain /> : '通過') : (isGame ? <DungeonIcon name="status-error" tone="red" plain /> : '失敗')}</span>
                {r.issueKey && (
                  <span style={{ fontWeight: 700, color: '#a5b4fc', fontSize: 13, whiteSpace: 'nowrap' }}>{r.issueKey}</span>
                )}
                <span style={{ fontSize: 13, color: '#cbd5e1', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.summary ?? '—'}
                </span>
                {r.error && (
                  <span style={{ fontSize: 11, color: '#fca5a5', flexShrink: 0, maxWidth: 260, textAlign: 'right' }}>{r.error}</span>
                )}
              </div>
            ))}
          </div>

          <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 20, background: 'linear-gradient(135deg, #059669, #047857)' }} onClick={handlePmReset}>
            重新開始
          </button>
        </div>
      )}
    </>
  )
}

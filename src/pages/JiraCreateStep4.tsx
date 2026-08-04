import { DungeonIcon } from '../components/DungeonIcon'
import { StepGuide } from '../components/JiraStepWidgets'
import type { AccountInfo } from '../components/JiraAccountModal'
import { getField, stageBadgeClass, stageLabel } from './JiraPage'
import type { SheetRecord, IssueCreateResult } from './JiraPage'

/**
 * 批量開單 Step 4（建立結果 + 待補回寫）。純畫面元件，狀態留在 JiraPage.tsx
 * 以 props 傳入。JSX 內容用 sed 從 JiraPage.tsx 逐行搬過來，避免手動重打
 * 大範圍內容時手滑打錯字的風險。
 */
export function JiraCreateStep4(props: {
  planCreate: SheetRecord[]
  pendingWritebackCount: number
  retryingWriteback: boolean
  setRetryingWriteback: (v: boolean) => void
  currentAccount: AccountInfo | null
  sheetUrl: string
  setPendingWritebackCount: (v: number) => void
  createResults: IssueCreateResult[]
  isGame: boolean
  planComment: SheetRecord[]
  planTransition: SheetRecord[]
  handleReset: () => void
}) {
  const {
    planCreate, pendingWritebackCount, retryingWriteback, setRetryingWriteback, currentAccount, sheetUrl,
    setPendingWritebackCount, createResults, isGame, planComment, planTransition, handleReset,
  } = props

  return (
        <div className="section-card">
          <h2 className="section-title">Step 4 — 建立 Issues 結果</h2>

          <StepGuide title="操作說明 — 結果與回填">
            <li>逐筆呼叫建立 Issue（一次一筆），進度條依完成比例即時前進</li>
            <li>成功的列會自動回寫 <b>Jira Issue Key / Jira URL / 處理階段 / 處理時間 / 單子標題貼這</b> 五個欄位到 Sheet</li>
            <li>若回寫失敗（斷線等），紀錄會保留在「待回填佇列」，可用下方「補回填工具」重試，不會遺失</li>
          </StepGuide>

          {planCreate.length === 0 && (
            <div className="alert-info">
              本批次無需建立新 Issue，已將現有 Issue 帶入後續流程。
            </div>
          )}

          {pendingWritebackCount > 0 && (
            <div className="alert-warn" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span>有 {pendingWritebackCount} 筆回寫未完成（可能因斷線中斷）</span>
              <button
                className="btn btn-sm btn-secondary"
                disabled={retryingWriteback}
                onClick={async () => {
                  setRetryingWriteback(true)
                  try {
                    const r = await fetch('/api/jira/pending-writebacks/retry', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', ...(currentAccount ? { 'x-jira-email': currentAccount.email } : {}) },
                      body: JSON.stringify({ sheetUrl }),
                    })
                    const d = await r.json() as { ok: boolean; succeeded: number; retried: number }
                    if (d.ok) {
                      alert(`補回填完成：${d.succeeded}/${d.retried} 筆成功`)
                      setPendingWritebackCount(d.retried - d.succeeded)
                    }
                  } catch (e) { alert(`重試失敗：${e}`) }
                  finally { setRetryingWriteback(false) }
                }}
              >
                {retryingWriteback ? '重試中...' : '重行 重試回寫'}
              </button>
            </div>
          )}

          {createResults.length > 0 && (
            <>
              <div className="result-summary">
                <div className="summary-item ok">{isGame ? <DungeonIcon name="status-ok" tone="green" size="xs" plain /> : '通過'} 成功 {createResults.filter(r => r.issueKey).length} 筆</div>
                <div className={`summary-item${createResults.filter(r => r.error).length > 0 ? ' error' : ''}`}>
                  {createResults.filter(r => r.error).length > 0
                    ? <>{isGame ? <DungeonIcon name="status-error" tone="red" size="xs" plain /> : '失敗'} 失敗 {createResults.filter(r => r.error).length} 筆</> : '通過 無失敗'}
                </div>
              </div>
              <div className="result-group">
                {createResults.filter(r => r.issueKey).map(r => (
                  <div key={r.rowIndex} className="result-row ok">
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>Row {r.rowIndex}</span>
                    <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${r.issueKey}`} target="_blank" rel="noreferrer">
                      <code>{r.issueKey}</code>
                    </a>
                    {r.writebackSkipped
                      ? <span className="badge badge--warn">待手動填回</span>
                      : r.writebackOk
                        ? <span className="badge badge--ok">已回寫 通過</span>
                        : <span className="badge badge--error">回寫失敗</span>}
                    {!r.writebackSkipped && !r.writebackOk && r.writebackError && (
                      <span className="err-msg">{r.writebackError}</span>
                    )}
                  </div>
                ))}
                {createResults.filter(r => r.error).map(r => (
                  <div key={r.rowIndex} className="result-row error">
                    <span>Row {r.rowIndex}</span>
                    <span className="err-msg">{r.error}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 帶入的現有 Issues */}
          {planComment.length + planTransition.length > 0 && (
            <div className="result-group">
              <h3>現有 Issues（帶入後續流程）</h3>
              {[...planComment, ...planTransition].map(r => {
                const key = getField(r, 'Jira Issue Key') || getField(r, 'jira issue key')
                return (
                  <div key={r._rowIndex} className="result-row ok">
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>Row {r._rowIndex}</span>
                    <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${key}`} target="_blank" rel="noreferrer">
                      <code>{key}</code>
                    </a>
                    <span className={stageBadgeClass(r)}>{stageLabel(r)}</span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="stage-nav" style={{ marginTop: 16 }}>
            <button type="button" className="submit-btn submit-btn--step" style={{ background: '#166534' }} onClick={handleReset}>
              完成，重新開始
            </button>
          </div>
        </div>
  )
}

import { SearchSelect } from '../components/SearchSelect'
import { XianxiaIcon } from '../components/XianxiaIcon'
import { StepGuide } from '../components/JiraStepWidgets'
import { SheetSourceToggle } from '../components/SheetSourceToggle'
import type { AccountInfo } from '../components/JiraAccountModal'
import type { SheetSource, Step } from './JiraPage'

/**
 * 批量開單 Step 1（選擇專案/Issue 類型）與 Step 2（選擇資料來源）。純畫面元件，
 * 狀態留在 JiraPage.tsx 以 props 傳入——trackedIssues 等後續步驟共用的狀態
 * 都是從這裡開始累積的，不適合改成這個元件自己獨立管理。
 */
export function JiraCreateStep12(props: {
  step: Step
  setStep: (v: Step) => void
  currentAccount: AccountInfo | null
  projectsLoading: boolean
  projects: { id: string; key: string; name: string }[]
  selectedProjectId: string
  setSelectedProjectId: (v: string) => void
  issueTypes: { id: string; name: string }[]
  selectedIssueTypeId: string
  setSelectedIssueTypeId: (v: string) => void
  sheetSource: SheetSource
  setSheetSource: (v: SheetSource) => void
  sheetUrl: string
  setSheetUrl: (v: string) => void
  sheetError: string
  setSheetError: (v: string) => void
  sheetLoading: boolean
  handleFetchSheet: () => void
}) {
  const {
    step, setStep, currentAccount, projectsLoading, projects, selectedProjectId, setSelectedProjectId,
    issueTypes, selectedIssueTypeId, setSelectedIssueTypeId, sheetSource, setSheetSource, sheetUrl, setSheetUrl,
    sheetError, setSheetError, sheetLoading, handleFetchSheet,
  } = props

  return (
    <>
      {/* ── Step 1 ── */}
      {step === 1 && (
        <div className="section-card">
          <h2 className="section-title">Step 1 — 設定開單資訊</h2>
          {!currentAccount && <div className="alert-warn">請先點右上角「選擇帳號」</div>}

          {/* Project & Issue Type — 側欄並排 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <label className="field">
              <span>Jira 專案<em className="req"> *</em></span>
              <SearchSelect
                loading={projectsLoading}
                options={projects.map(p => ({ value: p.id, label: `${p.key} — ${p.name}` }))}
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                placeholder="— 選擇專案 —"
              />
            </label>
            <label className="field">
              <span>Issue 類型<em className="req"> *</em></span>
              <SearchSelect
                options={issueTypes.map(t => ({ value: t.id, label: t.name }))}
                value={selectedIssueTypeId}
                onChange={setSelectedIssueTypeId}
                placeholder="— 選擇類型 —"
                disabled={!selectedProjectId || issueTypes.length === 0}
              />
            </label>
          </div>

          <StepGuide title="操作說明 — 選擇專案與 Issue 類型">
            <li>專案清單依「目前登入帳號」在 Jira 的存取權限動態載入；清單是空的代表此帳號沒有任何專案權限</li>
            <li>選好專案後才會載入該專案可用的 Issue 類型（Bug / Task / Story...），請先選專案</li>
            <li>Issue 類型會影響 Step 3 能填寫的欄位（不同類型的必填欄位可能不同）</li>
          </StepGuide>

          <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 20 }}
            disabled={!selectedProjectId || !selectedIssueTypeId} onClick={() => setStep(2)}>
            下一步 →
          </button>
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div className="section-card">
          <h2 className="section-title">Step 2 — 選擇資料來源</h2>
          <SheetSourceToggle value={sheetSource} onChange={s => { setSheetSource(s); setSheetUrl(''); setSheetError('') }} />
          <div className="form-stack" style={{ marginTop: 16 }}>
            <label className="field">
              <span>{sheetSource === 'lark' ? 'Lark Sheet 網址' : 'Google Sheets 網址'}<em className="req"> *</em></span>
              <input value={sheetUrl} onChange={e => setSheetUrl(e.target.value)}
                placeholder={sheetSource === 'lark'
                  ? 'https://casinoplus.sg.larksuite.com/sheets/xxx?sheet=yyy'
                  : 'https://docs.google.com/spreadsheets/d/xxx/edit#gid=0'} />
              <span className="field-hint">
                若 Sheet 有「處理階段」欄，自動顯示「已完成」以外的所有列；<br />
                否則只顯示「Jira Issue Key」為空的列
              </span>
            </label>
            <span className="field-hint" style={{ color: '#64748b', fontSize: 11 }}>
              含「單子標題貼這」的欄位有值的列會自動過濾（視為已開單）
            </span>
            {sheetError && <div className="alert-error">{sheetError}</div>}
          </div>

          {/* ── Sheet 欄位說明 ── */}
          <div className="jira-sheet-guide" style={{ marginBottom: 20, maxWidth: '100%' }}>
            <details>
              <summary className="jira-sheet-guide-summary"><XianxiaIcon name="guide" size={17} /> Sheet 欄位說明 — 查看必要 / 選填欄位與範例資料</summary>
              <div className="jira-sheet-guide-legend">
                <span className="jira-col-tag jira-col-req">必填</span>必須有值才能建立 Issue
                <span className="jira-col-tag jira-col-opt" style={{ marginLeft: 14 }}>選填</span>可留空，系統會略過
                <span className="jira-col-tag jira-col-auto" style={{ marginLeft: 14 }}>自動</span>系統寫回，請勿手動修改
              </div>
              <div className="sheet-preview-wrap" style={{ marginTop: 10 }}>
                <table className="sheet-preview-table">
                  <thead>
                    <tr>
                      <th><span className="jira-col-tag jira-col-req">必填</span> 摘要</th>
                      <th><span className="jira-col-tag jira-col-req">必填</span> 描述</th>
                      <th><span className="jira-col-tag jira-col-req">必填</span> 受託人</th>
                      <th><span className="jira-col-tag jira-col-req">必填</span> RD負責人</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> 回報人</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> Actual Start</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> Actual End</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> 其他動態欄位...</th>
                      <th><span className="jira-col-tag jira-col-auto">自動</span> Jira Issue Key</th>
                      <th><span className="jira-col-tag jira-col-auto">自動</span> Jira URL</th>
                      <th><span className="jira-col-tag jira-col-auto">自動</span> 處理階段</th>
                      <th><span className="jira-col-tag jira-col-auto">自動</span> 處理時間</th>
                      <th><span className="jira-col-tag jira-col-auto">自動</span> 單子標題貼這</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>[BUG] 登入頁面白屏</td>
                      <td>使用者點擊登入後頁面無回應，錯誤碼 500</td>
                      <td>王小明</td>
                      <td>陳大文</td>
                      <td>李四</td>
                      <td>2025-03-20</td>
                      <td>2025-03-22</td>
                      <td>—</td>
                      <td style={{ color: '#94a3b8', fontStyle: 'italic' }}>（系統填入）</td>
                      <td style={{ color: '#94a3b8', fontStyle: 'italic' }}>（系統填入）</td>
                      <td style={{ color: '#94a3b8', fontStyle: 'italic' }}>（系統填入）</td>
                      <td style={{ color: '#94a3b8', fontStyle: 'italic' }}>（系統填入）</td>
                      <td style={{ color: '#94a3b8', fontStyle: 'italic' }}>（系統填入）</td>
                    </tr>
                    <tr>
                      <td>[FEAT] 新增匯出 PDF 功能</td>
                      <td>在報表頁提供 PDF 匯出按鈕，支援中文字體</td>
                      <td>王小明</td>
                      <td>陳大文</td>
                      <td>—</td>
                      <td>2025-03-21</td>
                      <td>2025-03-25</td>
                      <td>—</td>
                      <td style={{ color: '#2563eb', fontWeight: 600 }}>PRJ-1023</td>
                      <td style={{ color: '#2563eb', fontSize: 11 }}>.../browse/PRJ-1023</td>
                      <td><span className="badge badge--ok" style={{ fontSize: 11 }}>已開單</span></td>
                      <td>2025-03-21 10:02</td>
                      <td>PRJ-1023↵摘要</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#94a3b8', lineHeight: 1.7 }}>
                <li><b>摘要 / 描述 / 受託人 / RD負責人</b> 為強制必填，缺一筆都無法送出（Step 3 會擋下並列出問題列）</li>
                <li>「動態欄位開單」模式下，實際欄位清單依 Jira 專案 + Issue 類型即時載入，不限於上表範例</li>
                <li>若 Sheet 有「處理階段」欄，自動顯示「已完成」以外的所有列；否則只顯示「Jira Issue Key」為空的列</li>
                <li>含「單子標題貼這」欄位有值的列會自動過濾（視為已開單，跳過不重複建立）</li>
              </ul>
              <p className="field-hint" style={{ marginTop: 8 }}>
                <XianxiaIcon name="warning" size={18} /> 欄位名稱需完全符合（不區分大小寫）。「Jira Issue Key」「Jira URL」「處理階段」「處理時間」「單子標題貼這」由系統自動回寫，請保留欄位但不要手動填入。
              </p>
            </details>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(1)}>上一步</button>
            <button type="button" className={`submit-btn submit-btn--step${sheetLoading ? ' loading' : ''}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={!sheetUrl.trim() || sheetLoading} onClick={handleFetchSheet}>
              {sheetLoading ? '讀取中...' : '讀取 Sheet'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

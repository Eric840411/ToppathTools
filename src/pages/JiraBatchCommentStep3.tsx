import { useState } from 'react'
import { XianxiaIcon } from '../components/XianxiaIcon'
import { StepGuide, ReloadSheetButton } from '../components/JiraStepWidgets'
import { ModelSelector } from '../components/ModelSelector'
import type { SheetRecord, TrackedIssue, StageOpResult, PreviewItem, PersonResolveResult } from './JiraPage'

/**
 * 批量評論分頁 Step 3（設定評論內容 + 預覽送出）。純畫面元件，狀態留在 JiraPage.tsx 以 props 傳入
 * （trackedIssues 等狀態跟批次開單流程共用，見 JiraBatchCommentTab.tsx 的說明）。
 *
 * 這段 JSX 原本是跟批次開單流程「Step 5 — 添加評論」共用同一塊，用 qaSubMode === 'comment' 三元判斷
 * 切換文案/按鈕。但外層渲染條件已經強制要求 qaSubMode === 'comment' 才會渲染到這裡，
 * 所以 qaSubMode !== 'comment' 的分支其實從未被執行到（批次開單流程本身也早就沒有 Step 5 的畫面了，
 * 見 JiraPage.tsx 裡被 `{false && ...}` 停用的 Step 6 區塊）。搬過來時把這些不可達的死分支拿掉了，
 * 行為不變（原本就沒人會走到那些分支），只是不用再假裝支援一個已經不存在的模式。
 */
export function JiraBatchCommentStep3(props: {
  toComment: TrackedIssue[]
  commentTabLoading: boolean
  commentReloadMsg: string
  handleReloadCommentSheet: () => void
  setCommentTabStep: (v: 1 | 2 | 3) => void
  setTrackedIssues: (fn: (prev: TrackedIssue[]) => TrackedIssue[]) => void
  setCommentResults: (v: StageOpResult[]) => void
  setPreviewMode: (v: boolean) => void
  setPreviewItems: (v: PreviewItem[]) => void
  commentColumn: string
  setCommentColumn: (v: string) => void
  sheetHeaders: string[]
  attachmentColumn: string
  setAttachmentColumn: (v: string) => void
  isAdmin: boolean
  canAiFormat: boolean
  personColumn: string
  setPersonColumn: (v: string) => void
  personResolve: PersonResolveResult[]
  personResolving: boolean
  personBlocking: PersonResolveResult[]
  canAiReview: boolean
  useAiReview: boolean
  setUseAiReview: (v: boolean) => void
  useAiComment: boolean
  setUseAiComment: (v: boolean) => void
  selectedPromptId: string
  setSelectedPromptId: (v: string) => void
  availablePrompts: { id: string; name: string }[]
  commentModel: string
  setCommentModel: (v: string) => void
  kbDocs: { id: number; name: string; tags: string; content_length: number }[]
  selectedKbDocIds: number[]
  setSelectedKbDocIds: (fn: (prev: number[]) => number[]) => void
  specContext: string
  setSpecContext: (v: string) => void
  commentResults: StageOpResult[]
  pendingCommentRequestId: string
  previewMode: boolean
  prefetchLoading: boolean
  handleEnterPreview: () => void
  commentSubmitting: boolean
  COMMENT_TEMPLATE: string
  COMMENT_TEMPLATE_SECTIONS: { header: string; items: string[] }[]
  handleBatchAppendTemplate: () => void
  previewItems: PreviewItem[]
  prefetchError: string
  updatePreviewComment: (rowIndex: number, text: string) => void
  handleRemoveAttachment: (rowIndex: number, attachmentIndex: number) => void
  uploadingRows: Set<number>
  handleManualUpload: (rowIndex: number, files: FileList | null) => void
  uploadErrors: Record<number, string>
  commentProgress: { done: number; total: number; current: string } | null
  handleSubmitFromPreview: () => void
  sheetRecords: SheetRecord[]
}) {
  const {
    toComment, commentTabLoading, commentReloadMsg, handleReloadCommentSheet, setCommentTabStep,
    setTrackedIssues, setCommentResults, setPreviewMode, setPreviewItems, commentColumn, setCommentColumn,
    sheetHeaders, attachmentColumn, setAttachmentColumn, useAiComment, setUseAiComment,
    canAiFormat, canAiReview, useAiReview, setUseAiReview,
    personColumn, setPersonColumn, personResolve, personResolving, personBlocking,
    selectedPromptId, setSelectedPromptId, availablePrompts, commentModel, setCommentModel, kbDocs,
    selectedKbDocIds, setSelectedKbDocIds, specContext, setSpecContext, commentResults,
    pendingCommentRequestId, previewMode, prefetchLoading, handleEnterPreview, commentSubmitting,
    COMMENT_TEMPLATE, COMMENT_TEMPLATE_SECTIONS, handleBatchAppendTemplate, previewItems, prefetchError,
    updatePreviewComment, handleRemoveAttachment, uploadingRows, handleManualUpload, uploadErrors,
    commentProgress, handleSubmitFromPreview,
  } = props

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  return (
    <>
      <div className="section-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            批量評論（{toComment.length} 筆）
          </h2>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ReloadSheetButton loading={commentTabLoading} msg={commentReloadMsg} onClick={handleReloadCommentSheet} />
            <button type="button" className="btn-ghost" style={{ whiteSpace: 'nowrap', fontSize: 13 }}
              onClick={() => { setCommentTabStep(1); setTrackedIssues(() => []); setCommentResults([]); setPreviewMode(false); setPreviewItems([]) }}>
              ← 重新載入
            </button>
          </span>
        </div>

        <StepGuide title="操作說明 — 評論格式與附件">
          <li>評論需包含 5 大區塊：<b>【功能目的】【前置條件】【測試步驟】【說明與備註】【驗證結果】</b>，每個區塊下有必填細項</li>
          <li>格式不完整只會顯示 警 警示，仍可強制送出（非硬性擋下）</li>
          <li>可勾選「AI 優化」，對已寫的評論做二次分析，補上完整性總結（限管理員帳號）</li>
          <li>每筆可手動上傳圖片附件，送出後以 <code>!filename!</code> wiki markup 直接嵌入評論內文；影片附件用 <code>[^filename]</code> 顯示為下載連結</li>
          <li>送出成功的列，會自動回寫「處理階段＝添加評論」與「處理時間」到來源 Sheet</li>
        </StepGuide>

        {toComment.length === 0
          ? <div className="alert-info">目前無需添加評論的 Issue。</div>
          : (
            <div className="form-stack">
              {/* 逐列代發：選填寫人欄位後，每一列各自用該列填寫人的身分張貼 */}
              <label className="field">
                <span>填寫人欄位（選填 — 逐列以該列填寫人的身分張貼）</span>
                <select value={personColumn} onChange={e => setPersonColumn(e.target.value)}>
                  <option value="">— 全部用我自己的身分送出 —</option>
                  {sheetHeaders.map((h, i) => <option key={h || `ph-${i}`} value={h}>{h}</option>)}
                </select>
                <span className="field-hint">
                  選了之後，系統會把這一欄的名字對應到後台帳號，並用對應帳號的身分張貼該列的評論。
                  Jira 上會顯示成那個人留的言；系統操作紀錄仍會記下實際操作者是你。
                </span>
              </label>

              {personColumn && (
                <div style={{ background: '#162032', border: `1px solid ${personBlocking.length > 0 ? '#7f1d1d' : '#2d3f55'}`, borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
                    送出前檢查{personResolving ? '（解析中…）' : `（${personResolve.length} 個填寫人）`}
                  </div>
                  {personResolve.length === 0 && !personResolving && (
                    <div style={{ fontSize: 12, color: '#64748b' }}>這批勾選的列在這一欄沒有填任何名字，會全部用你自己的身分送出。</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {personResolve.map(r => {
                      const ok = r.status === 'ok'
                      const hint = {
                        no_account: '後台查無此人 → 請先建立帳號',
                        ambiguous: '對應到多個帳號 → 請確認要用哪一個',
                        no_token: '尚未建立 Jira API Token → 請該帳號去設定',
                        not_authorized: '你沒有代理張貼授權 → 請管理員到「Jira 代理張貼授權」開通',
                        ok: '',
                      }[r.status]
                      return (
                        <div key={r.name} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ color: ok ? '#4ade80' : '#f87171', fontWeight: 600, minWidth: 90 }}>{r.name}</span>
                          <span style={{ color: ok ? '#94a3b8' : '#fca5a5' }}>
                            {ok ? `→ ${r.label}（${r.email}）` : hint}
                            {r.status === 'ambiguous' && r.candidates && `：${r.candidates.join('、')}`}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  {personBlocking.length > 0 && (
                    <div style={{ fontSize: 12, color: '#fca5a5', marginTop: 8 }}>
                      有 {personBlocking.length} 個填寫人無法代發，處理完才能送出（評論送出去收不回來，所以這裡直接擋住）。
                    </div>
                  )}
                </div>
              )}

              <label className="field">
                <span>評論內容來源欄位 <em className="req">*</em></span>
                <select value={commentColumn} onChange={e => setCommentColumn(e.target.value)}>
                  <option value="">— 選擇欄位 —</option>
                  {sheetHeaders.map((h, i) => <option key={h || `sh-${i}`} value={h}>{h}</option>)}
                </select>
                <span className="field-hint">選擇試算表中要作為 Jira 評論內容的欄位（如：驗證結果）</span>
              </label>
              <label className="field">
                <span>附件欄位（選填）</span>
                <select value={attachmentColumn} onChange={e => setAttachmentColumn(e.target.value)}>
                  <option value="">— 不上傳附件 —</option>
                  {sheetHeaders.map((h, i) => <option key={h || `sh-${i}`} value={h}>{h}</option>)}
                </select>
                <span className="field-hint">支援 Lark Drive 連結 和 Google Drive 分享連結（drive.google.com/file/d/...）；多個連結換行分隔。圖片自動上傳為 Jira 附件，影片自動寫入評論內文。</span>
              </label>
              {/* 2026-08-20：原本一個「AI 優化」勾選框同時做兩件事，拆成兩個獨立項目，
                  各自受權限控管（個人權限覆寫，見 SystemAdminPage 的「功能權限」）。 */}
              {(canAiFormat || canAiReview) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {canAiFormat && (
                    <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, margin: 0 }}>
                      <input type="checkbox" checked={useAiComment} onChange={e => setUseAiComment(e.target.checked)} />
                      <span>AI 排版評論（用 Prompt 模板重寫評論本文，取代原文送出）</span>
                    </label>
                  )}
                  {canAiReview && (
                    <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, margin: 0 }}>
                      <input type="checkbox" checked={useAiReview} onChange={e => setUseAiReview(e.target.checked)} />
                      <span>AI 完整性分析（另外貼一則獨立評論，不影響本文）</span>
                    </label>
                  )}
                  {(useAiComment || useAiReview) && (
                    <span className="field-hint" style={{ marginLeft: 2 }}>
                      每張單會產生 {useAiReview ? 2 : 1} 則評論
                      {useAiReview && !useAiComment && '：第一則貼原文，第二則分析原文'}
                      {useAiReview && useAiComment && '：第一則貼 AI 改寫後的正文，第二則分析實際貼出的內容'}
                    </span>
                  )}
                </div>
              )}

              {(useAiComment || useAiReview) && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <label className="field" style={{ flex: 1, margin: 0 }}>
                      <span>使用 Prompt 模板</span>
                      <select value={selectedPromptId} onChange={e => setSelectedPromptId(e.target.value)}>
                        {availablePrompts.length === 0
                          ? <option value="default">標準 QA 報告（預設）</option>
                          : availablePrompts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)
                        }
                      </select>
                    </label>
                    <label className="field" style={{ margin: 0, minWidth: 180 }}>
                      <span>AI 模型</span>
                      <ModelSelector value={commentModel} onChange={setCommentModel} />
                    </label>
                  </div>
                  {/* 知識庫選擇器 */}
                  {kbDocs.length > 0 && (
                    <div style={{ background: '#162032', border: '1px solid #2d3f55', borderRadius: 8, padding: '10px 14px' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        知識庫來源
                        <span style={{ fontWeight: 400, color: '#334155' }}>（勾選的文件內容會附加到 AI context）</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {kbDocs.map(doc => {
                          const on = selectedKbDocIds.includes(doc.id)
                          const tags: string[] = (() => { try { return JSON.parse(doc.tags) } catch { return [] } })()
                          return (
                            <div key={doc.id}
                              onClick={() => setSelectedKbDocIds(prev => on ? prev.filter(id => id !== doc.id) : [...prev, doc.id])}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 5, borderRadius: 6,
                                padding: '5px 10px', fontSize: 12, cursor: 'pointer', userSelect: 'none',
                                background: on ? 'rgba(37,99,235,.15)' : '#1e293b',
                                border: `1px solid ${on ? 'rgba(59,130,246,.4)' : '#2d3f55'}`,
                                color: on ? '#93c5fd' : '#475569',
                              }}>
                              {on && <span style={{ color: '#3b82f6', fontSize: 11 }}>通過</span>}
                              {doc.name}
                              {tags.length > 0 && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>· {tags.slice(0, 2).join(' · ')}</span>}
                            </div>
                          )
                        })}
                      </div>
                      {selectedKbDocIds.length > 0 && (
                        <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>
                          已選 {selectedKbDocIds.length} 份文件，內容將附入 AI context（超過模型上限時自動截斷）
                        </div>
                      )}
                    </div>
                  )}

                  <label className="field">
                    <span>規格書參考段落 <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>（選填 — 對應模板中 {'{{'+'specContext'+'}}'} 佔位符，所有 Issue 共用）</span></span>
                    <textarea
                      value={specContext}
                      onChange={e => setSpecContext(e.target.value)}
                      placeholder={'貼上相關規格書段落，AI 會以此作為判斷依據（留空則忽略）'}
                      rows={4}
                      style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                    />
                  </label>
                </>
              )}
            </div>
          )}

        <div className="stage-issues">
          {toComment.map(t => (
            <span key={t.rowIndex} className="issue-chip">
              <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${t.issueKey}`} target="_blank" rel="noreferrer">
                {t.issueKey}
              </a>
            </span>
          ))}
        </div>

        {commentResults.length > 0 && (
          <div className="result-group" style={{ marginTop: 12 }}>
            {commentResults.map(r => (
              <div key={r.rowIndex} className={`result-row ${r.ok ? 'ok' : 'error'}`}>
                <code>{r.issueKey}</code>
                {r.ok
                  ? <>
                      <span className="badge badge--ok">評論已添加 通過</span>
                      {r.usedAi
                        ? <span className="badge badge--purple"><XianxiaIcon name="ai" size={16} /> AI 優化</span>
                        : useAiComment
                          ? <span className="badge badge--warn"><XianxiaIcon name="warning" size={16} /> AI 跳過（欄位空白）</span>
                          : null}
                    </>
                  : <span className="err-msg">{r.error ?? '失敗'}</span>}
              </div>
            ))}
          </div>
        )}

        {!!pendingCommentRequestId && !commentSubmitting && (
          <div style={{ margin: '10px 0 4px', fontSize: 12, color: '#b45309' }}>
            串流已中斷，正在嘗試從後端恢復結果，完成前將暫時鎖定提交按鈕。
          </div>
        )}

        {/* ── 預覽模式開關 ── */}
        {!previewMode && toComment.length > 0 && (
          <div className="stage-nav" style={{ marginTop: 16 }}>
            <button type="button"
              className={`submit-btn submit-btn--step${prefetchLoading ? ' loading' : ''}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              disabled={!commentColumn || prefetchLoading}
              onClick={handleEnterPreview}>
              {prefetchLoading ? '載入附件中...' : `預覽評論（${toComment.length} 筆）→`}
            </button>
          </div>
        )}

        {/* ── 預覽表格 ── */}
        {previewMode && (
          <div style={{ marginTop: 16 }}>
            {/* Template section */}
            <div style={{ marginBottom: 12, padding: '10px 12px', background: '#0d1117', border: '1px solid #2d3f55', borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>評論模板</span>
                <button type="button"
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(31,111,235,0.15)', color: '#58a6ff', border: '1px solid rgba(31,111,235,0.3)', cursor: 'pointer' }}
                  onClick={() => {
                    if (navigator.clipboard) {
                      navigator.clipboard.writeText(COMMENT_TEMPLATE).catch(() => {})
                    } else {
                      const ta = document.createElement('textarea')
                      ta.value = COMMENT_TEMPLATE
                      ta.style.position = 'fixed'; ta.style.opacity = '0'
                      document.body.appendChild(ta); ta.select()
                      document.execCommand('copy')
                      document.body.removeChild(ta)
                    }
                  }}>
                  複製
                </button>
                <button type="button"
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(63,185,80,0.15)', color: '#3fb950', border: '1px solid rgba(63,185,80,0.3)', cursor: 'pointer' }}
                  onClick={handleBatchAppendTemplate}>
                  批量往下貼入所有評論
                </button>
              </div>
              <pre style={{ margin: 0, fontSize: 11, color: '#64748b', fontFamily: 'monospace', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{COMMENT_TEMPLATE}</pre>
            </div>

            {/* Stats bar */}
            {(() => {
              const okCount = previewItems.filter(i => !i.hasError).length
              const errCount = previewItems.filter(i => i.hasError).length
              return (
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3fb950', display: 'inline-block' }} />
                    <span style={{ color: '#94a3b8' }}>格式通過</span>
                    <strong style={{ color: '#e2e8f0' }}>{okCount}</strong>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f85149', display: 'inline-block' }} />
                    <span style={{ color: '#94a3b8' }}>格式錯誤</span>
                    <strong style={{ color: '#e2e8f0' }}>{errCount}</strong>
                  </span>
                  <span style={{ marginLeft: 'auto', color: '#475569', fontSize: 11 }}>點擊評論可直接編輯</span>
                </div>
              )
            })()}

            {prefetchError && (
              <div className="alert-warn" style={{ marginBottom: 8, fontSize: 12 }}>{prefetchError}</div>
            )}

            {/* Preview table */}
            <div style={{ border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#162032', borderBottom: '1px solid #2d3f55' }}>
                    <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', width: 80, whiteSpace: 'nowrap' }}>Jira 單號</th>
                    <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', width: 180 }}>摘要</th>
                    <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px' }}>評論內容（可編輯）+ 附件</th>
                    <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', width: 140, whiteSpace: 'nowrap' }}>驗證狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {previewItems.map(item => (
                    <tr key={item.rowIndex}
                      style={{
                        borderBottom: '1px solid #1e2d3d',
                        background: item.hasError ? 'rgba(248,81,73,0.04)' : 'transparent',
                      }}>
                      <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                        <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${item.issueKey}`}
                          target="_blank" rel="noreferrer"
                          style={{ color: '#58a6ff', fontFamily: 'monospace', fontWeight: 600, fontSize: 12, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                          {item.issueKey}
                        </a>
                      </td>
                      <td style={{ padding: '8px 10px', verticalAlign: 'top', color: '#94a3b8', fontSize: 12, lineHeight: 1.4 }}>
                        {item.summary || '—'}
                      </td>
                      <td style={{ padding: '8px 10px', verticalAlign: 'top', minWidth: 320 }}>
                        <textarea
                          value={item.commentText}
                          onChange={e => updatePreviewComment(item.rowIndex, e.target.value)}
                          rows={5}
                          style={{
                            width: '100%', background: '#0d1117', color: '#c9d1d9',
                            border: `1px solid ${item.hasError ? 'rgba(248,81,73,0.5)' : '#2d3f55'}`,
                            borderRadius: 6, padding: '7px 9px', fontSize: 11, lineHeight: 1.6,
                            fontFamily: 'monospace', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                          }}
                        />
                        {/* Section indicator */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                          {COMMENT_TEMPLATE_SECTIONS.map(sec => {
                            const headerMissing = item.missingSections.includes(sec.header)
                            const itemProblem = sec.items.some(i => item.missingSections.includes(i) || item.missingSections.includes(`${i}（缺欄位）`))
                            const resultProblem = sec.items.length === 0 && item.missingSections.includes(`${sec.header} 未填結果`)
                            const ok = !headerMissing && !itemProblem && !resultProblem
                            return (
                              <span key={sec.header} style={{
                                fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 500,
                                background: ok ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.12)',
                                color: ok ? '#3fb950' : '#f85149',
                              }}>
                                {sec.header.replace('【', '').replace('】', '')}{ok ? ' 通過' : ' 失敗'}
                              </span>
                            )
                          })}
                        </div>
                        {/* Attachments + manual upload */}
                        <div style={{ marginTop: 8 }}>
                          {item.cachedAttachments.length > 0 && (
                            <div style={{ padding: '6px 8px', background: '#0d1117', border: '1px solid #2d3f55', borderRadius: 6, marginBottom: 6 }}>
                              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                                附件（{item.cachedAttachments.filter(a => !a.error).length} 個）
                                {item.cachedAttachments.some(a => a.isImage && !a.error) && (
                                  <span style={{ background: 'rgba(31,111,235,0.15)', color: '#58a6ff', border: '1px solid rgba(31,111,235,0.3)', borderRadius: 3, padding: '1px 5px', fontSize: 10 }}>圖片</span>
                                )}
                                {item.cachedAttachments.some(a => a.isVideo) && (
                                  <span style={{ background: 'rgba(210,153,34,0.15)', color: '#d29922', border: '1px solid rgba(210,153,34,0.3)', borderRadius: 3, padding: '1px 5px', fontSize: 10 }}>影片連結</span>
                                )}
                              </div>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {item.cachedAttachments.map((att, ai) => {
                                  const RemoveBtn = () => (
                                    <button type="button"
                                      onClick={e => { e.stopPropagation(); handleRemoveAttachment(item.rowIndex, ai) }}
                                      title="移除這個附件"
                                      style={{
                                        position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%',
                                        background: '#7f1d1d', color: '#fca5a5', border: '1px solid #f8717160',
                                        fontSize: 11, lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                                      }}>×</button>
                                  )
                                  return att.error ? (
                                    <div key={ai} style={{ position: 'relative', fontSize: 10, color: '#f87171', padding: '2px 14px 2px 6px', background: 'rgba(248,81,73,0.1)', borderRadius: 4, border: '1px solid rgba(248,81,73,0.2)' }}>
                                      警 {att.filename.length > 30 ? att.filename.slice(0, 30) + '…' : att.filename}: {att.error}
                                      <RemoveBtn />
                                    </div>
                                  ) : att.isVideo ? (
                                    <div key={ai} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, position: 'relative' }}>
                                      {att.cacheId ? (
                                        <video src={`/api/jira/attachment-cache/${att.cacheId}`}
                                          style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4, border: '1px solid #2d3f55' }} />
                                      ) : (
                                        <div style={{ width: 60, height: 60, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.4)', borderRadius: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 18, gap: 2, cursor: 'default' }}>
                                          <span>啟</span>
                                          <span style={{ fontSize: 9, color: '#f59e0b' }}>未上傳</span>
                                        </div>
                                      )}
                                      <RemoveBtn />
                                      <div style={{ fontSize: 9, color: att.cacheId ? '#64748b' : '#f59e0b', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
                                        {att.filename.length > 20 ? att.filename.slice(0, 20) + '…' : att.filename}
                                      </div>
                                    </div>
                                  ) : att.cacheId ? (
                                    <div key={ai} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: 'pointer', position: 'relative' }}
                                      onClick={() => setLightboxSrc(`/api/jira/attachment-cache/${att.cacheId}`)}>
                                      <img
                                        src={`/api/jira/attachment-cache/${att.cacheId}`}
                                        alt={att.filename}
                                        style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4, border: '1px solid #2d3f55' }}
                                      />
                                      <RemoveBtn />
                                      <div style={{ fontSize: 9, color: '#64748b', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
                                        {att.filename}
                                      </div>
                                    </div>
                                  ) : null
                                })}
                              </div>
                              <div style={{ fontSize: 10, color: '#3fb950', marginTop: 5 }}>
                                圖片上傳至 Jira 附件區，評論末自動嵌入
                              </div>
                              {(() => {
                                const pendingLinks = item.cachedAttachments.filter(a => a.mimeType === 'video/link' && !a.cacheId).length
                                const uploadedVideos = item.cachedAttachments.filter(a => a.isVideo && !!a.cacheId).length
                                return pendingLinks > uploadedVideos
                              })() && (
                                <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 4, padding: '3px 6px', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 4 }}>
                                  有影片未上傳（Lark 插入附件格式無法自動下載），請用下方「上傳圖片/影片」手動上傳
                                </div>
                              )}
                            </div>
                          )}
                          {/* Manual upload button */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 9px', borderRadius: 4, background: 'rgba(31,111,235,0.1)', color: '#58a6ff', border: '1px solid rgba(31,111,235,0.25)', cursor: uploadingRows.has(item.rowIndex) ? 'wait' : 'pointer' }}>
                              <input type="file" accept="image/*,video/*" multiple style={{ display: 'none' }}
                                onChange={e => handleManualUpload(item.rowIndex, e.target.files)}
                              />
                              {uploadingRows.has(item.rowIndex) ? '上傳中...' : '＋ 上傳圖片/影片'}
                            </label>
                            <span style={{ fontSize: 10, color: '#475569' }}>單檔上限 10MB</span>
                          </div>
                          {uploadErrors[item.rowIndex] && (
                            <div style={{ marginTop: 5, fontSize: 11, color: '#f85149', display: 'flex', alignItems: 'center', gap: 4 }}>
                              警 {uploadErrors[item.rowIndex]}
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                        {item.hasError ? (
                          <>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 500, background: 'rgba(248,81,73,0.15)', color: '#f85149', border: '1px solid rgba(248,81,73,0.3)', whiteSpace: 'nowrap' }}>失敗 未完成</span>
                            <div style={{ marginTop: 5, fontSize: 10, color: '#f85149' }}>
                              缺漏：{item.missingSections.map(s => (
                                <span key={s} style={{ display: 'inline-block', background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: 3, padding: '1px 4px', margin: '1px 2px', fontSize: 10 }}>
                                  {s.replace('【', '').replace('】', '')}
                                </span>
                              ))}
                            </div>
                          </>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 500, background: 'rgba(63,185,80,0.15)', color: '#3fb950', border: '1px solid rgba(63,185,80,0.3)', whiteSpace: 'nowrap' }}>通過 格式通過</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Preview submit bar */}
            {(() => {
              const errCount = previewItems.filter(i => i.hasError).length
              const pct = commentProgress ? Math.round(commentProgress.done / commentProgress.total * 100) : 0
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {commentSubmitting && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8' }}>
                        <span>{commentProgress ? `處理中 ${commentProgress.done} / ${commentProgress.total}` : '提交中...'}</span>
                        {commentProgress && <span>{pct}%</span>}
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: '#1e2d3d', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 3, background: '#3b82f6', width: `${pct}%`, transition: 'width 0.3s ease' }} />
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button type="button" className="btn-ghost btn-ghost--step"
                      disabled={commentSubmitting}
                      onClick={() => setPreviewMode(false)}>
                      ← 返回設定
                    </button>
                    {errCount > 0 && (
                      <span style={{ fontSize: 12, color: '#d29922', display: 'flex', alignItems: 'center', gap: 5 }}>
                        警 {errCount} 筆格式不完整，仍可強制送出
                      </span>
                    )}
                    <button type="button"
                      className={`submit-btn submit-btn--step${commentSubmitting ? ' loading' : ''}`}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 'auto' }}
                      disabled={commentSubmitting || !!pendingCommentRequestId || personBlocking.length > 0 || personResolving}
                      onClick={handleSubmitFromPreview}>
                      {commentSubmitting ? '處理中...' : `確認送出（${previewItems.length} 筆）`}
                    </button>
                  </div>
                </div>
              )
            })()}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setLightboxSrc(null)}>
          <button type="button" onClick={() => setLightboxSrc(null)}
            style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 28, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>關閉</button>
          <img src={lightboxSrc} alt="attachment preview"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, border: '1px solid #2d3f55' }} />
        </div>
      )}
    </>
  )
}

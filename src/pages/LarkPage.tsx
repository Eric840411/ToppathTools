import { useEffect, useRef, useState } from 'react'
import { ModelSelector } from '../components/ModelSelector'

type ActionType = 'generate' | 'compare'
type SpecSource = 'lark' | 'file' | 'gdocs'
type StatusState = 'idle' | 'loading' | 'ok' | 'warn' | 'error'

interface SourceEntry {
  id: string
  type: SpecSource
  url: string
  file?: File
}

interface TestCase {
  測試模組: string
  測試維度: string
  測試標題: string
  前置條件: string
  操作步驟: string
  預期結果: string
  優先級: string
}

interface JiraTestCase {
  test_type: string
  category_type: string
  category_reason: string
  function_module: string
  test_title: string
  expected_result: string
  source_reference: string
  jira_reference: string
}

interface GenerateResult {
  ok: boolean
  generated?: number
  written?: number
  cases?: TestCase[] | JiraTestCase[]
  message?: string
  bitableUrl?: string
  featureName?: string
  format?: 'jira'
}

interface GenerateStatusResponse {
  ok: boolean
  status?: 'running' | 'done' | 'error' | 'missing'
  message?: string
  result?: GenerateResult
}

export function LarkPage() {
  const [action, setAction] = useState<ActionType>('generate')
  // Multi-source state
  const [sources, setSources] = useState<SourceEntry[]>([{ id: '1', type: 'lark', url: '' }])
  const fileInputRefs = useRef<Map<string, HTMLInputElement>>(new Map())
  // Legacy compare mode
  const [specUrl, setSpecUrl] = useState('')
  const [testcaseUrl, setTestcaseUrl] = useState('')

  function addSource() {
    setSources(prev => [...prev, { id: Date.now().toString(), type: 'lark', url: '' }])
  }
  function removeSource(id: string) {
    setSources(prev => prev.filter(s => s.id !== id))
  }
  function updateSource(id: string, patch: Partial<SourceEntry>) {
    setSources(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
  }
  const [status, setStatus] = useState<StatusState>('idle')
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null)
  const [expandedRow, setExpandedRow] = useState<number | null>(null)

  const [availablePrompts, setAvailablePrompts] = useState<{ id: string; name: string }[]>([])
  const [selectedPromptId, setSelectedPromptId] = useState('testcase-default')
  const [selectedModel, setSelectedModel] = useState('gemini')

  // Jira 整合（可選）
  const [useJira, setUseJira] = useState(false)
  const [jiraAccounts, setJiraAccounts] = useState<{ email: string; label: string }[]>([])
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraKeysInput, setJiraKeysInput] = useState('')

  const LARK_PENDING_KEY = 'lark_pending_request_id'

  useEffect(() => {
    fetch('/api/gemini/prompts')
      .then(r => r.json())
      .then((d: { prompts?: { id: string; name: string }[] }) => {
        if (d.prompts) setAvailablePrompts(d.prompts.map(p => ({ id: p.id, name: p.name })))
      })
      .catch(() => {})
    fetch('/api/jira/accounts')
      .then(r => r.json())
      .then((d: { ok: boolean; accounts?: { email: string; label: string }[] }) => {
        if (d.ok && d.accounts) setJiraAccounts(d.accounts)
      })
      .catch(() => {})
  }, [])

  // Restore pending request on page mount (survives navigation / refresh)
  useEffect(() => {
    const savedId = localStorage.getItem(LARK_PENDING_KEY)
    if (!savedId) return
    setStatus('loading')
    setPendingRequestId(savedId)

    let done = false
    const es = new EventSource(`/api/integrations/lark/generate-testcases/stream?requestId=${encodeURIComponent(savedId)}`)

    es.addEventListener('result', (e: MessageEvent) => {
      done = true
      es.close()
      const data = JSON.parse(e.data) as GenerateResult
      setResult(data)
      setStatus(data.ok ? 'ok' : 'error')
      setPendingRequestId(null)
      localStorage.removeItem(LARK_PENDING_KEY)
    })

    es.onerror = () => {
      if (done) return
      es.close()
      recoverResultByPolling(savedId).then(recovered => {
        if (recovered) {
          localStorage.removeItem(LARK_PENDING_KEY)
        } else {
          setStatus('warn')
          setPendingRequestId(savedId)
        }
      })
    }

    return () => { if (!done) es.close() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const recoverResultByPolling = async (requestId: string): Promise<boolean> => {
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`/api/integrations/lark/generate-testcases/status/${encodeURIComponent(requestId)}`)
        const d = await r.json() as GenerateStatusResponse
        if (!d.ok) return false
        if (d.status === 'running') {
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        }
        if (d.result) {
          setResult(d.result)
          setStatus(d.result.ok ? 'ok' : 'error')
          setPendingRequestId(null)
          localStorage.removeItem(LARK_PENDING_KEY)
          return true
        }
        return false
      } catch {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    return false
  }

  useEffect(() => {
    if (!pendingRequestId || status !== 'warn') return
    let alive = true
    const timer = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/integrations/lark/generate-testcases/status/${encodeURIComponent(pendingRequestId)}`)
        const d = await r.json() as GenerateStatusResponse
        if (!alive || !d.ok) return
        if (d.status === 'running') return
        if (d.result) {
          setResult(d.result)
          setStatus(d.result.ok ? 'ok' : 'error')
          setPendingRequestId(null)
          return
        }
        setResult({ ok: false, message: d.message ?? '任務狀態異常，請重新提交' })
        setStatus('error')
        setPendingRequestId(null)
      } catch {
        // keep waiting; monitor widget will show backend connectivity
      }
    }, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [pendingRequestId, status])


  const handleSubmit = async () => {
    let submittedRequestId: string | null = null
    setStatus('loading')
    setPendingRequestId(null)
    setExpandedRow(null)
    localStorage.removeItem(LARK_PENDING_KEY)
    try {
      // If any source is a file upload, use FormData endpoint
      const hasFile = sources.some(s => s.type === 'file')
      if (hasFile) {
        const fileSources = sources.filter(s => s.type === 'file')
        if (fileSources.some(s => !s.file)) throw new Error('請選擇所有規格書檔案')
        const form = new FormData()
        for (const s of fileSources) form.append('files', s.file!)
        form.append('promptId', selectedPromptId)
        form.append('modelSpec', selectedModel)
        const resp = await fetch('/api/integrations/generate-testcases-file', { method: 'POST', body: form })
        const data = await resp.json() as GenerateResult
        setResult(data)
        setStatus(data.ok ? 'ok' : 'error')
        return
      }

      // URL-only sources: submit via JSON → wait via SSE
      const urlSources = sources.map(s => ({ type: s.type as 'lark' | 'gdocs', url: s.url }))
      const resp = await fetch('/api/integrations/lark/generate-testcases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: urlSources,
          manualTestCases: testcaseUrl ? [{ url: testcaseUrl }] : [],
          promptId: selectedPromptId,
          jiraKeys: useJira ? jiraKeysInput.split(/[,\s\n]+/).map(k => k.trim()).filter(Boolean) : [],
          jiraEmail: useJira ? jiraEmail : undefined,
          modelSpec: selectedModel,
        }),
      })
      const submitData = await resp.json() as { ok: boolean; requestId?: string; message?: string }
      if (!resp.ok || !submitData.requestId) {
        throw new Error(submitData.message ?? '提交失敗')
      }
      const requestId = submitData.requestId
      submittedRequestId = requestId
      setPendingRequestId(requestId)
      localStorage.setItem(LARK_PENDING_KEY, requestId)

      // Open SSE and wait for result — no polling, server pushes when done
      await new Promise<void>((resolve, reject) => {
        const es = new EventSource(`/api/integrations/lark/generate-testcases/stream?requestId=${encodeURIComponent(requestId)}`)
        let done = false

        es.addEventListener('result', (e: MessageEvent) => {
          done = true
          es.close()
          const data = JSON.parse(e.data) as GenerateResult
          setResult(data)
          setStatus(data.ok ? 'ok' : 'error')
          setPendingRequestId(null)
          localStorage.removeItem(LARK_PENDING_KEY)
          resolve()
        })

        es.onerror = () => {
          if (done) return  // server closed after sending result — normal
          es.close()
          reject(new Error('SSE 連線中斷'))
        }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('SSE 連線中斷') && submittedRequestId) {
        setStatus('warn')
        const recovered = await recoverResultByPolling(submittedRequestId)
        if (!recovered) {
          setResult({ ok: false, message: '前端串流中斷；後端任務可能仍在執行中，請稍後查看歷史紀錄或重新查詢。' })
          setStatus('warn')
        }
      } else {
        setResult({ ok: false, message: msg })
        setStatus('error')
        setPendingRequestId(null)
        localStorage.removeItem(LARK_PENDING_KEY)
      }
    }
  }

  const isSubmitDisabled = status === 'loading' || !!pendingRequestId ||
    (action === 'compare' && (!specUrl || !testcaseUrl)) ||
    (action === 'generate' && sources.some(s =>
      (s.type === 'lark' && !s.url) ||
      (s.type === 'gdocs' && !s.url) ||
      (s.type === 'file' && !s.file)
    ))

  const priorityColor = (p: string) => {
    if (p === '高') return 'badge--error'
    if (p === '中') return 'badge--warn'
    return 'badge--ok'
  }

  return (
    <div className="page-layout">
      <div className="section-card">
        <h2 className="section-title">操作類型</h2>
        <div className="action-tabs">
          <button
            type="button"
            className={`action-tab${action === 'generate' ? ' active' : ''}`}
            onClick={() => { setAction('generate'); setStatus('idle'); setResult(null) }}
          >
            🤖 AI 生成 TestCase
          </button>
          <button
            type="button"
            className={`action-tab${action === 'compare' ? ' active' : ''}`}
            onClick={() => { setAction('compare'); setStatus('idle'); setResult(null) }}
          >
            🔍 人工 vs AI 比對
          </button>
        </div>
      </div>

      <div className="two-col">
        <div className="section-card">
          <h2 className="section-title">
            {action === 'generate' ? '輸入規格書網址' : '輸入兩份資料來源'}
          </h2>

          <div className="form-stack">
            {action === 'compare' && (
              <>
                <label className="field">
                  <span>Lark 規格書 URL <em className="req">*</em></span>
                  <input
                    value={specUrl}
                    onChange={(e) => setSpecUrl(e.target.value)}
                    placeholder="https://casinoplus.sg.larksuite.com/wiki/ABCD1234"
                  />
                  <span className="field-hint">系統會自動抽取 /wiki/&#123;documentId&#125;</span>
                </label>
                <label className="field">
                  <span>你的 TestCase Bitable URL <em className="req">*</em></span>
                  <input
                    value={testcaseUrl}
                    onChange={(e) => setTestcaseUrl(e.target.value)}
                    placeholder="https://casinoplus.sg.larksuite.com/base/RehgXXX?table=tblXXX"
                  />
                </label>
              </>
            )}

            {action === 'generate' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {sources.map((src, idx) => (
                  <div key={src.id} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', background: '#fafafa', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>規格書 {idx + 1}</span>
                      {/* Type selector */}
                      <div style={{ display: 'flex', gap: 4 }}>
                        {([
                          { key: 'lark', label: '📄 Lark Wiki' },
                          { key: 'file', label: '📎 PDF / Word' },
                          { key: 'gdocs', label: '🌐 Google 文檔' },
                        ] as { key: SpecSource; label: string }[]).map(({ key, label }) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => updateSource(src.id, { type: key, url: '', file: undefined })}
                            style={{
                              padding: '3px 10px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
                              border: src.type === key ? '2px solid #4f46e5' : '1px solid #e2e8f0',
                              background: src.type === key ? '#eef2ff' : '#fff',
                              color: src.type === key ? '#4f46e5' : '#374151',
                              fontWeight: src.type === key ? 600 : 400,
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {sources.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeSource(src.id)}
                          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1 }}
                          title="移除此規格書"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {src.type === 'lark' && (
                      <input
                        value={src.url}
                        onChange={e => updateSource(src.id, { url: e.target.value })}
                        placeholder="https://casinoplus.sg.larksuite.com/wiki/ABCD1234"
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }}
                      />
                    )}
                    {src.type === 'gdocs' && (
                      <input
                        value={src.url}
                        onChange={e => updateSource(src.id, { url: e.target.value })}
                        placeholder="https://docs.google.com/document/d/XXXX/edit"
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }}
                      />
                    )}
                    {src.type === 'file' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input
                          ref={el => { if (el) fileInputRefs.current.set(src.id, el) }}
                          type="file"
                          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                          onChange={e => updateSource(src.id, { file: e.target.files?.[0] ?? undefined })}
                          style={{ display: 'none' }}
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRefs.current.get(src.id)?.click()}
                          style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #e2e8f0', background: '#f8fafc', color: '#374151', whiteSpace: 'nowrap' }}
                        >
                          📎 選擇檔案
                        </button>
                        <span style={{ fontSize: 12, color: src.file ? '#374151' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {src.file ? src.file.name : '尚未選擇檔案（PDF / .docx，最大 20 MB）'}
                        </span>
                      </div>
                    )}
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addSource}
                  style={{
                    padding: '7px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                    border: '1px dashed #cbd5e1', background: '#fff', color: '#64748b',
                    textAlign: 'left',
                  }}
                >
                  + 新增規格書
                </button>
              </div>
            )}
          </div>

          {action === 'generate' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 4 }}>
              <label className="field" style={{ flex: 1, margin: 0 }}>
                <span>AI Prompt 模板</span>
                <select
                  value={selectedPromptId}
                  onChange={e => setSelectedPromptId(e.target.value)}
                  style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 14 }}
                >
                  {availablePrompts.length === 0
                    ? <option value="testcase-default">TestCase 生成（標準）</option>
                    : availablePrompts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)
                  }
                </select>
              </label>
              <label className="field" style={{ margin: 0, minWidth: 180 }}>
                <span>AI 模型</span>
                <ModelSelector value={selectedModel} onChange={setSelectedModel} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 14 }} />
              </label>
            </div>
          )}

          {action === 'generate' && (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 16px', marginBottom: 4 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={useJira} onChange={e => setUseJira(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>整合 Jira 單號（可選）</span>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>AI 將同時參考 Jira Issues 與規格書生成 TestCase</span>
              </label>

              {useJira && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <label className="field" style={{ margin: 0 }}>
                    <span>Jira 帳號</span>
                    <select
                      value={jiraEmail}
                      onChange={e => setJiraEmail(e.target.value)}
                      style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }}
                    >
                      <option value="">請選擇帳號</option>
                      {jiraAccounts.map(a => (
                        <option key={a.email} value={a.email}>{a.label} ({a.email})</option>
                      ))}
                    </select>
                  </label>
                  <label className="field" style={{ margin: 0 }}>
                    <span>Jira 單號（逗號或換行分隔，如 CGSG-220, CGSG-221）</span>
                    <textarea
                      value={jiraKeysInput}
                      onChange={e => setJiraKeysInput(e.target.value)}
                      placeholder="CGSG-220&#10;CGSG-221"
                      rows={3}
                      style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, resize: 'vertical', fontFamily: 'monospace' }}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className={`submit-btn${status === 'loading' ? ' loading' : ''}`}
            disabled={isSubmitDisabled}
            onClick={handleSubmit}
          >
            {status === 'loading'
              ? '⏳ AI 分析中，請稍候（約 30-60 秒）...'
              : action === 'generate'
                ? '開始生成'
                : '開始比對'}
          </button>

          <div className="info-block" style={{ marginTop: 20 }}>
            <h3>流程說明</h3>
            {action === 'generate' ? (
              <ol>
                <li>新增一份或多份規格書（Lark Wiki / PDF / Google 文檔，可混合）</li>
                <li>後端逐份讀取文件全文並合併</li>
                <li>Google Gemini 整合分析所有規格書，生成完整 TestCase</li>
                <li>批次寫入 Lark Bitable 多維表格</li>
              </ol>
            ) : (
              <ol>
                <li>貼上規格書網址 + 你自己的 TestCase Bitable</li>
                <li>同步讀取 AI 生成案例與人工案例</li>
                <li>Gemini 分析覆蓋率、缺漏、版本衝突</li>
              </ol>
            )}
            <p className="info-note">⚙️ Lark API Token 設定於後端 <code>.env</code>，前端不持有任何密鑰</p>
          </div>

        </div>

        <div className="section-card">
          <h2 className="section-title">執行結果</h2>

          {status === 'idle' && (
            <span className="idle-hint">填寫左側表單後按「開始生成」</span>
          )}

          {status === 'loading' && (
            <div className="loading-state">
              <div className="loading-spinner" />
              <p>AI 正在分析規格書並生成測試案例...</p>
              <p className="loading-sub">讀取文件 → AI 生成 → 寫入 Bitable</p>
            </div>
          )}

          {status === 'warn' && (
            <div className="alert-error" style={{ whiteSpace: 'pre-wrap', background: '#fffbeb', borderColor: '#fcd34d', color: '#92400e' }}>
              {result?.message ?? '前端連線異常，但後端可能仍在執行。'}
            </div>
          )}

          {status === 'error' && result && (
            <div className="alert-error" style={{ whiteSpace: 'pre-wrap' }}>
              {result.message ?? '發生錯誤'}
            </div>
          )}

          {status === 'ok' && result && (
            <div className="generate-summary">
              <div className="result-summary">
                <div className="summary-item ok">📝 生成 {result.generated} 筆</div>
                <div className="summary-item ok">✅ 已寫入 Bitable {result.written} 筆</div>
              </div>
              {result.bitableUrl && (
                <a
                  href={result.bitableUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bitable-link-btn"
                >
                  📋 前往 Lark Bitable 查看結果 →
                </a>
              )}
              <p style={{ fontSize: 13, color: '#64748b', margin: '8px 0 12px' }}>
                點選任一列查看詳細內容
              </p>
            </div>
          )}
        </div>
      </div>

      {/* TestCase 預覽表格 — 舊格式 */}
      {status === 'ok' && result?.cases && result.cases.length > 0 && result.format !== 'jira' && (
        <div className="section-card">
          <h2 className="section-title">生成的 TestCase 預覽（{result.cases.length} 筆）</h2>
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>模組</th>
                  <th>維度</th>
                  <th>測試標題</th>
                  <th>優先級</th>
                  <th>展開</th>
                </tr>
              </thead>
              <tbody>
                {(result.cases as TestCase[]).map((tc, i) => (
                  <>
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{tc.測試模組}</td>
                      <td>{tc.測試維度}</td>
                      <td>{tc.測試標題}</td>
                      <td>
                        <span className={`badge ${priorityColor(tc.優先級)}`}>{tc.優先級}</span>
                      </td>
                      <td>
                        <button type="button" className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setExpandedRow(expandedRow === i ? null : i)}>
                          {expandedRow === i ? '收起' : '展開'}
                        </button>
                      </td>
                    </tr>
                    {expandedRow === i && (
                      <tr key={`${i}-detail`} className="tc-detail-row">
                        <td colSpan={6}>
                          <div className="tc-detail">
                            <div className="tc-detail-item"><strong>前置條件</strong><p>{tc.前置條件}</p></div>
                            <div className="tc-detail-item"><strong>操作步驟</strong><p style={{ whiteSpace: 'pre-wrap' }}>{tc.操作步驟}</p></div>
                            <div className="tc-detail-item"><strong>預期結果</strong><p>{tc.預期結果}</p></div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TestCase 預覽表格 — Jira 整合格式 */}
      {status === 'ok' && result?.cases && result.cases.length > 0 && result.format === 'jira' && (
        <div className="section-card">
          <h2 className="section-title">
            生成的 TestCase 預覽（{result.cases.length} 筆）
            {result.featureName && <span style={{ marginLeft: 10, fontSize: 13, color: '#6366f1', fontWeight: 400 }}>— {result.featureName}</span>}
          </h2>
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>功能模組</th>
                  <th>測試類型</th>
                  <th>類型</th>
                  <th>測試標題</th>
                  <th>JIRA</th>
                  <th>展開</th>
                </tr>
              </thead>
              <tbody>
                {(result.cases as JiraTestCase[]).map((tc, i) => (
                  <>
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{tc.function_module}</td>
                      <td><span className="badge badge--ok" style={{ fontSize: 11 }}>{tc.test_type}</span></td>
                      <td>{tc.category_type}</td>
                      <td>{tc.test_title}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12, color: '#6366f1' }}>{tc.jira_reference || '—'}</td>
                      <td>
                        <button type="button" className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setExpandedRow(expandedRow === i ? null : i)}>
                          {expandedRow === i ? '收起' : '展開'}
                        </button>
                      </td>
                    </tr>
                    {expandedRow === i && (
                      <tr key={`${i}-detail`} className="tc-detail-row">
                        <td colSpan={7}>
                          <div className="tc-detail">
                            <div className="tc-detail-item"><strong>預期結果</strong><p>{tc.expected_result}</p></div>
                            <div className="tc-detail-item"><strong>來源依據</strong><p>{tc.source_reference}</p></div>
                            <div className="tc-detail-item"><strong>類型判定依據</strong><p>{tc.category_reason}</p></div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section-card">
        <h2 className="section-title">📋 Lark Bitable 欄位結構 &amp; 範例</h2>

        {/* 標準格式 */}
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 8, fontWeight: 600 }}>標準格式（TestCase 生成（標準））</p>
        <div className="sheet-preview-wrap" style={{ marginBottom: 24 }}>
          <table className="sheet-preview-table">
            <thead>
              <tr>
                <th className="sheet-col--module">測試模組</th>
                <th className="sheet-col--dim">測試維度</th>
                <th className="sheet-col--title">測試標題</th>
                <th className="sheet-col--pre">前置條件</th>
                <th className="sheet-col--steps">操作步驟</th>
                <th className="sheet-col--expect">預期結果</th>
                <th className="sheet-col--priority">優先級</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>登入模組</td>
                <td><span className="dim-badge dim-badge--positive">正向邏輯</span></td>
                <td>使用正確帳號密碼成功登入</td>
                <td>已註冊帳號、網路正常</td>
                <td className="steps-cell">1. 開啟 App 登入頁<br/>2. 輸入正確帳號密碼<br/>3. 點擊「登入」</td>
                <td>成功進入首頁，顯示歡迎訊息</td>
                <td><span className="badge badge--error">高</span></td>
              </tr>
              <tr className="sheet-preview-more">
                <td colSpan={7}>… AI 依據規格書內容自動生成更多案例</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Jira 整合格式 */}
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 8, fontWeight: 600 }}>Jira 整合格式（TestCase 生成（Jira 整合版））</p>
        <div className="sheet-preview-wrap">
          <table className="sheet-preview-table">
            <thead>
              <tr>
                <th>測試標題</th>
                <th>功能模組</th>
                <th>測試類型</th>
                <th>類型</th>
                <th>預期結果</th>
                <th>來源依據</th>
                <th>JIRA單號</th>
                <th>類型判定依據</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>進入房間後房內 UI 顯示正常</td>
                <td>房內 UI</td>
                <td><span className="dim-badge dim-badge--positive">正向測試</span></td>
                <td>房內</td>
                <td>房內所有元素正確顯示，無錯位</td>
                <td>JIRA CGSG-220</td>
                <td style={{ fontFamily: 'monospace', color: '#6366f1' }}>CGSG-220</td>
                <td>JIRA 描述房內 UI 改動</td>
              </tr>
              <tr>
                <td>派彩金額正確結算至餘額</td>
                <td>派彩結算</td>
                <td><span className="dim-badge dim-badge--positive">正向測試</span></td>
                <td>派彩</td>
                <td>中獎後餘額增加金額與派彩一致</td>
                <td>Spec 5.2.i + JIRA CGSG-221</td>
                <td style={{ fontFamily: 'monospace', color: '#6366f1' }}>CGSG-221</td>
                <td>Spec 與 JIRA 均描述派彩流程</td>
              </tr>
              <tr className="sheet-preview-more">
                <td colSpan={8}>… AI 依據 Jira Issues 與規格書自動生成更多案例</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 10 }}>
          測試類型：正向測試 / 反向測試 / 邊界測試 / 異常測試 &nbsp;｜&nbsp;
          標準格式測試維度：正向邏輯 / 邊界分析 / 異常阻斷 / 版本變更 / 使用者體驗 / 搶登與裝置衝突
        </p>
      </div>

    </div>
  )
}

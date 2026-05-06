import { useEffect, useRef, useState } from 'react'
import { ModelSelector } from '../components/ModelSelector'
import { DungeonIcon } from '../components/DungeonIcon'
import { useIsGameMode } from '../components/GameModeContext'

/** Safe ArrayBuffer → base64, works for files of any size */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

type ActionType = 'generate' | 'compare' | 'secondpass'
type SpecSource = 'lark' | 'file' | 'gdocs'
type OldSpecSource = 'lark' | 'gdocs' | 'pdf' | 'csv'
type StatusState = 'idle' | 'loading' | 'ok' | 'warn' | 'error'

interface SourceEntry {
  id: string
  type: SpecSource
  url: string
  file?: File
}

interface OldSourceEntry {
  id: string
  type: OldSpecSource
  url: string
  file?: File
  content?: string // csv text or pdf base64
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
  const isGame = useIsGameMode()
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
  function addOldSource() {
    setOldSources(prev => [...prev, { id: 'old-' + Date.now(), type: 'lark' as OldSpecSource, url: '' }])
  }
  function removeOldSource(id: string) {
    setOldSources(prev => prev.filter(s => s.id !== id))
  }
  function updateOldSource(id: string, patch: Partial<OldSourceEntry>) {
    setOldSources(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
  }
  const [status, setStatus] = useState<StatusState>('idle')
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null)
  const [expandedRow, setExpandedRow] = useState<number | null>(null)

  const [availablePrompts, setAvailablePrompts] = useState<{ id: string; name: string }[]>([])
  const [selectedPromptId, setSelectedPromptId] = useState('testcase-default')
  const [selectedModel, setSelectedModel] = useState('gemini')
  const [testcaseMode, setTestcaseMode] = useState<'full' | 'diff' | 'baseline'>('full')
  const [oldSources, setOldSources] = useState<OldSourceEntry[]>([{ id: 'old-1', type: 'lark', url: '' }])
  const oldFileInputRefs = useRef<Map<string, HTMLInputElement>>(new Map())
  // Baseline mode source
  type BaselineSourceType = 'json' | 'lark' | 'csv' | 'xlsx'
  const [baselineType, setBaselineType] = useState<BaselineSourceType>('json')
  const [baselineContent, setBaselineContent] = useState('') // json/csv text
  const [baselineLarkUrl, setBaselineLarkUrl] = useState('')
  const [baselineCsvFile, setBaselineCsvFile] = useState<File | null>(null)
  const [baselineXlsxFile, setBaselineXlsxFile] = useState<File | null>(null)
  const [baselineXlsxB64, setBaselineXlsxB64] = useState('')

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

  useEffect(() => {
    if (testcaseMode === 'diff') setSelectedPromptId('testcase-diff')
    else if (testcaseMode === 'baseline') setSelectedPromptId('testcase-baseline')
    else setSelectedPromptId('testcase-default')
  }, [testcaseMode])

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
      // Second Pass: spec sources + incomplete TC
      if (action === 'secondpass') {
        const hasFile = sources.some(s => s.type === 'file')
        if (hasFile) {
          const fileSources = sources.filter(s => s.type === 'file')
          if (fileSources.some(s => !s.file)) throw new Error('請選擇所有規格書檔案')
          const form = new FormData()
          for (const s of fileSources) form.append('files', s.file!)
          form.append('promptId', 'testcase-second-pass')
          form.append('modelSpec', selectedModel)
          form.append('existingCasesSource', JSON.stringify({
            type: baselineType,
            ...(baselineType === 'lark' ? { url: baselineLarkUrl } : {}),
            ...(baselineType !== 'lark' ? { content: baselineType === 'xlsx' ? baselineXlsxB64 : baselineContent } : {}),
          }))
          const resp = await fetch('/api/integrations/generate-testcases-file', { method: 'POST', body: form })
          const data = await resp.json() as GenerateResult
          setResult(data)
          setStatus(data.ok ? 'ok' : 'error')
          return
        }
        const urlSources = sources.map(s => ({ type: s.type as 'lark' | 'gdocs', url: s.url }))
        const resp = await fetch('/api/integrations/lark/generate-testcases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sources: urlSources,
            existingCasesSource: {
              type: baselineType,
              ...(baselineType === 'lark' ? { url: baselineLarkUrl } : {}),
              ...(baselineType !== 'lark' ? { content: baselineType === 'xlsx' ? baselineXlsxB64 : baselineContent } : {}),
            },
            promptId: 'testcase-second-pass',
            modelSpec: selectedModel,
          }),
        })
        const submitData = await resp.json() as { ok: boolean; requestId?: string; message?: string }
        if (!resp.ok || !submitData.requestId) throw new Error(submitData.message ?? '提交失敗')
        const requestId = submitData.requestId
        submittedRequestId = requestId
        setPendingRequestId(requestId)
        localStorage.setItem(LARK_PENDING_KEY, requestId)
        await new Promise<void>((resolve, reject) => {
          const es = new EventSource(`/api/integrations/lark/generate-testcases/stream?requestId=${encodeURIComponent(requestId)}`)
          let done = false
          es.addEventListener('result', (e: MessageEvent) => {
            done = true; es.close()
            const data = JSON.parse(e.data) as GenerateResult
            setResult(data); setStatus(data.ok ? 'ok' : 'error')
            setPendingRequestId(null); localStorage.removeItem(LARK_PENDING_KEY)
            resolve()
          })
          es.onerror = () => { if (done) return; es.close(); reject(new Error('SSE 連線中斷')) }
        })
        return
      }

      // If any source is a file upload, use FormData endpoint
      const hasFile = sources.some(s => s.type === 'file')
      if (hasFile) {
        const fileSources = sources.filter(s => s.type === 'file')
        if (fileSources.some(s => !s.file)) throw new Error('請選擇所有規格書檔案')
        const form = new FormData()
        for (const s of fileSources) form.append('files', s.file!)
        form.append('promptId', selectedPromptId)
        form.append('modelSpec', selectedModel)
        // Pass diff/baseline extra data as JSON strings
        if (testcaseMode === 'diff') {
          // PDF old sources → real files in oldFiles[]; CSV/URL → keep in JSON
          const oldMeta = oldSources.map(s => ({
            type: s.type,
            ...(s.url ? { url: s.url } : {}),
            // CSV content stays in JSON; PDF files are appended below
            ...(s.type === 'csv' && s.content ? { content: s.content } : {}),
          }))
          form.append('oldSources', JSON.stringify(oldMeta))
          for (const s of oldSources) {
            if (s.type === 'pdf' && s.file) form.append('oldFiles', s.file)
          }
        }
        if (testcaseMode === 'baseline') {
          form.append('existingCasesSource', JSON.stringify({
            type: baselineType,
            ...(baselineType === 'lark' ? { url: baselineLarkUrl } : {}),
            ...(baselineType !== 'lark' ? { content: baselineType === 'xlsx' ? baselineXlsxB64 : baselineContent } : {}),
          }))
        }
        const resp = await fetch('/api/integrations/generate-testcases-file', { method: 'POST', body: form })
        const data = await resp.json() as GenerateResult
        setResult(data)
        setStatus(data.ok ? 'ok' : 'error')
        return
      }

      // URL-only sources: submit via JSON → wait via SSE
      const urlSources = sources.map(s => ({ type: s.type as 'lark' | 'gdocs', url: s.url }))
      const oldUrlSources = oldSources.map(s => ({
        type: s.type as 'lark' | 'gdocs' | 'pdf' | 'csv',
        ...(s.url ? { url: s.url } : {}),
        ...(s.content ? { content: s.content } : {}),
      }))
      const resp = await fetch('/api/integrations/lark/generate-testcases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: urlSources,
          ...(testcaseMode === 'diff' ? { oldSources: oldUrlSources } : {}),
          ...(testcaseMode === 'baseline' ? { existingCasesSource: {
            type: baselineType,
            ...(baselineType === 'lark' ? { url: baselineLarkUrl } : {}),
            ...(baselineType !== 'lark' ? { content: baselineType === 'xlsx' ? baselineXlsxB64 : baselineContent } : {}),
          } } : {}),
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

  const sourcesIncomplete = sources.some(s =>
    (s.type === 'lark' && !s.url) ||
    (s.type === 'gdocs' && !s.url) ||
    (s.type === 'file' && !s.file)
  )
  const baselineCasesIncomplete =
    (baselineType === 'json' && !baselineContent.trim()) ||
    (baselineType === 'lark' && !baselineLarkUrl.trim()) ||
    (baselineType === 'csv' && !baselineCsvFile) ||
    (baselineType === 'xlsx' && !baselineXlsxFile)

  const isSubmitDisabled = status === 'loading' || !!pendingRequestId ||
    (action === 'compare' && (!specUrl || !testcaseUrl)) ||
    (action === 'secondpass' && (sourcesIncomplete || baselineCasesIncomplete)) ||
    (action === 'generate' && (
      sourcesIncomplete ||
      (testcaseMode === 'diff' && oldSources.some(s =>
        (s.type === 'lark' && !s.url) ||
        (s.type === 'gdocs' && !s.url) ||
        (s.type === 'pdf' && !s.file) ||
        (s.type === 'csv' && !s.content)
      )) ||
      (testcaseMode === 'baseline' && baselineCasesIncomplete)
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
            {isGame ? <DungeonIcon name="ai" tone="violet" plain /> : '🤖'} AI 生成 TestCase
          </button>
          <button
            type="button"
            className={`action-tab${action === 'compare' ? ' active' : ''}`}
            onClick={() => { setAction('compare'); setStatus('idle'); setResult(null) }}
          >
            {isGame ? <DungeonIcon name="compare" tone="gold" plain /> : '🔍'} 人工 vs AI 比對
          </button>
          <button
            type="button"
            className={`action-tab${action === 'secondpass' ? ' active' : ''}`}
            onClick={() => { setAction('secondpass'); setStatus('idle'); setResult(null); setSelectedPromptId('testcase-second-pass') }}
          >
            ✏️ AI 補填（Second Pass）
          </button>
        </div>
      </div>

      <div className="two-col">
        <div className="section-card">
          <h2 className="section-title">
            {action === 'generate' ? '輸入規格書網址' : action === 'secondpass' ? '輸入規格書與待補填案例' : '輸入兩份資料來源'}
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

            {action === 'secondpass' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Spec source — AI needs this to know which fields should exist */}
                {sources.map((src, idx) => (
                  <div key={src.id} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', background: '#fafafa', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>規格書 {idx + 1}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {([
                          { key: 'lark',  label: 'Lark Wiki',   emoji: '📄', icon: 'wiki'  as const },
                          { key: 'file',  label: 'PDF / Word',  emoji: '📎', icon: 'file'  as const },
                          { key: 'gdocs', label: 'Google 文檔', emoji: '🌐', icon: 'gdocs' as const },
                        ] as { key: SpecSource; label: string; emoji: string; icon: 'wiki' | 'file' | 'gdocs' }[]).map(({ key, label, emoji, icon }) => (
                          <button key={key} type="button"
                            onClick={() => updateSource(src.id, { type: key, url: '', file: undefined })}
                            style={{ padding: '3px 10px', borderRadius: 5, fontSize: 12, cursor: 'pointer', border: src.type === key ? '2px solid #4f46e5' : '1px solid #e2e8f0', background: src.type === key ? '#eef2ff' : '#fff', color: src.type === key ? '#4f46e5' : '#374151', fontWeight: src.type === key ? 600 : 400 }}
                          >
                            {isGame ? <DungeonIcon name={icon} tone={src.type === key ? 'violet' : 'slate'} plain /> : emoji} {label}
                          </button>
                        ))}
                      </div>
                      {sources.length > 1 && (
                        <button type="button" onClick={() => removeSource(src.id)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16 }}>
                          {isGame ? <DungeonIcon name="close" tone="slate" size="xs" plain /> : '✕'}
                        </button>
                      )}
                    </div>
                    {src.type === 'lark' && <input value={src.url} onChange={e => updateSource(src.id, { url: e.target.value })} placeholder="https://casinoplus.sg.larksuite.com/wiki/ABCD1234" style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }} />}
                    {src.type === 'gdocs' && <input value={src.url} onChange={e => updateSource(src.id, { url: e.target.value })} placeholder="https://docs.google.com/document/d/XXXX/edit" style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }} />}
                    {src.type === 'file' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input id={`sp-file-${src.id}`} ref={el => { if (el) fileInputRefs.current.set(src.id, el); else fileInputRefs.current.delete(src.id) }} type="file" accept=".pdf,.docx" style={{ display: 'none' }} onChange={e => updateSource(src.id, { file: e.target.files?.[0] ?? undefined })} />
                        <button type="button" onClick={() => fileInputRefs.current.get(src.id)?.click()} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #e2e8f0', background: '#f8fafc', color: '#374151', whiteSpace: 'nowrap' }}>
                          {isGame ? <DungeonIcon name="file" tone="violet" size="xs" plain /> : '📎'} 選擇檔案
                        </button>
                        <span style={{ fontSize: 12, color: src.file ? '#374151' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {src.file ? src.file.name : '尚未選擇檔案（PDF / .docx，最大 30 MB）'}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
                <button type="button" onClick={addSource} style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: '1px dashed #cbd5e1', background: '#fff', color: '#64748b', textAlign: 'left' }}>+ 新增規格書</button>

                {/* Incomplete cases input */}
                <div style={{ border: '1px solid #a5b4fc', borderRadius: 10, padding: '12px 14px', background: '#eef2ff', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ color: '#3730a3', fontWeight: 600, fontSize: 13 }}>待補填的 TestCase <em style={{ color: '#dc2626' }}>*</em></span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['json', 'lark', 'csv', 'xlsx'] as const).map(t => (
                      <button key={t} type="button" onClick={() => setBaselineType(t)} style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid', borderColor: baselineType === t ? '#4f46e5' : '#c7d2fe', background: baselineType === t ? '#4f46e5' : '#fff', color: baselineType === t ? '#fff' : '#3730a3', fontWeight: baselineType === t ? 700 : 400 }}>
                        {t.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  {baselineType === 'json' && <textarea value={baselineContent} onChange={e => setBaselineContent(e.target.value)} placeholder='[{"測試標題":"...","預期結果":""}]' rows={5} style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #a5b4fc', fontSize: 13, resize: 'vertical', fontFamily: 'monospace', background: '#fff' }} />}
                  {baselineType === 'lark' && <input type="text" value={baselineLarkUrl} onChange={e => setBaselineLarkUrl(e.target.value)} placeholder="https://xxx.feishu.cn/base/AppToken?table=tblXxx" style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #a5b4fc', fontSize: 13, background: '#fff' }} />}
                  {(baselineType === 'csv' || baselineType === 'xlsx') && (() => {
                    const isCsv = baselineType === 'csv'
                    const accept = isCsv ? '.csv,text/csv' : '.xlsx,.xls'
                    const currentFile = isCsv ? baselineCsvFile : baselineXlsxFile
                    const inputId = isCsv ? 'sp-baseline-csv' : 'sp-baseline-xlsx'
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input id={inputId} type="file" accept={accept} style={{ display: 'none' }}
                          onChange={e => {
                            const file = e.target.files?.[0] ?? null
                            if (isCsv) { setBaselineCsvFile(file); if (file) { const r = new FileReader(); r.onload = ev => setBaselineContent(ev.target!.result as string); r.readAsText(file, 'utf-8') } else setBaselineContent('') }
                            else { setBaselineXlsxFile(file); if (file) { const r = new FileReader(); r.onload = ev => setBaselineXlsxB64(arrayBufferToBase64(ev.target!.result as ArrayBuffer)); r.readAsArrayBuffer(file) } else setBaselineXlsxB64('') }
                          }}
                        />
                        <button type="button" onClick={() => document.getElementById(inputId)?.click()} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #a5b4fc', background: '#fff', color: '#3730a3', whiteSpace: 'nowrap' }}>📎 選擇檔案</button>
                        <span style={{ fontSize: 12, color: currentFile ? '#3730a3' : '#818cf8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {currentFile ? `${currentFile.name} (${(currentFile.size / 1024).toFixed(1)} KB)` : `尚未選擇檔案（.${baselineType}）`}
                        </span>
                      </div>
                    )
                  })()}
                </div>
              </div>
            )}

            {action === 'generate' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 6, padding: 4, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                  {([
                    { key: 'full', label: 'Full' },
                    { key: 'diff', label: 'Diff' },
                    { key: 'baseline', label: 'Baseline' },
                  ] as { key: 'full' | 'diff' | 'baseline'; label: string }[]).map(mode => (
                    <button
                      key={mode.key}
                      type="button"
                      onClick={() => setTestcaseMode(mode.key)}
                      style={{
                        flex: 1,
                        padding: '7px 10px',
                        borderRadius: 6,
                        fontSize: 13,
                        cursor: 'pointer',
                        border: testcaseMode === mode.key ? '2px solid #4f46e5' : '1px solid transparent',
                        background: testcaseMode === mode.key ? '#eef2ff' : '#fff',
                        color: testcaseMode === mode.key ? '#4f46e5' : '#475569',
                        fontWeight: testcaseMode === mode.key ? 700 : 500,
                      }}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>

                {sources.map((src, idx) => (
                  <div key={src.id} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', background: '#fafafa', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>規格書 {idx + 1}</span>
                      {/* Type selector */}
                      <div style={{ display: 'flex', gap: 4 }}>
                        {([
                          { key: 'lark',  label: 'Lark Wiki',  emoji: '📄', icon: 'wiki'  as const },
                          { key: 'file',  label: 'PDF / Word', emoji: '📎', icon: 'file'  as const },
                          { key: 'gdocs', label: 'Google 文檔', emoji: '🌐', icon: 'gdocs' as const },
                        ] as { key: SpecSource; label: string; emoji: string; icon: 'wiki' | 'file' | 'gdocs' }[]).map(({ key, label, emoji, icon }) => (
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
                            {isGame ? <DungeonIcon name={icon} tone={src.type === key ? 'violet' : 'slate'} plain /> : emoji} {label}
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
                          {isGame ? <DungeonIcon name="close" tone="slate" size="xs" plain /> : '✕'}
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
                          {isGame ? <DungeonIcon name="file" tone="violet" size="xs" plain /> : '📎'} 選擇檔案
                        </button>
                        <span style={{ fontSize: 12, color: src.file ? '#374151' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {src.file ? src.file.name : '尚未選擇檔案（PDF / .docx，最大 30 MB）'}
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
                {testcaseMode === 'diff' && (
                  <div style={{ border: '1px solid #facc15', borderRadius: 10, padding: '12px 14px', background: '#fffbeb', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>舊版規格書</div>
                    {oldSources.map((src, idx) => (
                      <div key={src.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 44, fontSize: 12, fontWeight: 600, color: '#92400e', flexShrink: 0 }}>Old {idx + 1}</span>
                          <select
                            value={src.type}
                            onChange={e => updateOldSource(src.id, { type: e.target.value as OldSpecSource, url: '', file: undefined, content: undefined })}
                            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #fde68a', fontSize: 13, background: '#fff' }}
                          >
                            <option value="lark">Lark Wiki</option>
                            <option value="gdocs">Google Docs</option>
                            <option value="pdf">PDF</option>
                            <option value="csv">CSV</option>
                          </select>
                          {(src.type === 'lark' || src.type === 'gdocs') && (
                            <input
                              value={src.url}
                              onChange={e => updateOldSource(src.id, { url: e.target.value })}
                              placeholder={src.type === 'gdocs' ? 'https://docs.google.com/document/d/XXXX/edit' : 'https://casinoplus.sg.larksuite.com/wiki/ABCD1234'}
                              style={{ flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 6, border: '1px solid #fde68a', fontSize: 13 }}
                            />
                          )}
                          {(src.type === 'pdf' || src.type === 'csv') && (
                            <>
                              <input
                                id={`old-file-${src.id}`}
                                ref={el => { if (el) oldFileInputRefs.current.set(src.id, el); else oldFileInputRefs.current.delete(src.id) }}
                                type="file"
                                accept={src.type === 'pdf' ? '.pdf' : '.csv,text/csv'}
                                style={{ display: 'none' }}
                                onChange={e => {
                                  const file = e.target.files?.[0] ?? null
                                  if (!file) return
                                  updateOldSource(src.id, { file, content: undefined })
                                  if (src.type === 'csv') {
                                    // CSV: read as text for JSON payload
                                    const reader = new FileReader()
                                    reader.onload = ev => updateOldSource(src.id, { content: ev.target!.result as string })
                                    reader.readAsText(file, 'utf-8')
                                  }
                                  // PDF: sent as real file in FormData, no base64 needed
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => oldFileInputRefs.current.get(src.id)?.click()}
                                style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #fde68a', background: '#fff', color: '#92400e', whiteSpace: 'nowrap' }}
                              >
                                📎 選擇檔案
                              </button>
                              <span style={{ fontSize: 12, color: src.file ? '#92400e' : '#d97706', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                                {src.file ? src.file.name : `尚未選擇檔案（.${src.type}）`}
                              </span>
                            </>
                          )}
                          {oldSources.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeOldSource(src.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400e', fontSize: 16, lineHeight: 1, flexShrink: 0 }}
                              title="移除"
                            >✕</button>
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={addOldSource}
                      style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: '1px dashed #facc15', background: '#fff', color: '#92400e', textAlign: 'left' }}
                    >
                      + 新增舊版規格書
                    </button>
                  </div>
                )}

                {testcaseMode === 'baseline' && (
                  <div style={{ border: '1px solid #86efac', borderRadius: 10, padding: '12px 14px', background: '#f0fdf4', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <span style={{ color: '#166534', fontWeight: 600, fontSize: 13 }}>既有 TestCase 來源 <em style={{ color: '#dc2626' }}>*</em></span>
                    {/* Source type selector */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      {(['json', 'lark', 'csv', 'xlsx'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setBaselineType(t)}
                          style={{
                            padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid',
                            borderColor: baselineType === t ? '#16a34a' : '#d1fae5',
                            background: baselineType === t ? '#16a34a' : '#fff',
                            color: baselineType === t ? '#fff' : '#166534',
                            fontWeight: baselineType === t ? 700 : 400,
                          }}
                        >{t.toUpperCase()}</button>
                      ))}
                    </div>
                    {/* JSON */}
                    {(baselineType === 'json') && (
                      <textarea
                        value={baselineContent}
                        onChange={e => setBaselineContent(e.target.value)}
                        placeholder='[{"測試標題":"...","預期結果":"..."}]'
                        rows={7}
                        style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #86efac', fontSize: 13, resize: 'vertical', fontFamily: 'monospace', background: '#fff' }}
                      />
                    )}
                    {/* Lark Bitable URL */}
                    {baselineType === 'lark' && (
                      <input
                        type="text"
                        value={baselineLarkUrl}
                        onChange={e => setBaselineLarkUrl(e.target.value)}
                        placeholder="https://xxx.feishu.cn/base/AppToken?table=tblXxx"
                        style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #86efac', fontSize: 13, background: '#fff' }}
                      />
                    )}
                    {/* CSV / XLSX upload — same style as PDF/Word picker */}
                    {(baselineType === 'csv' || baselineType === 'xlsx') && (() => {
                      const isCsv = baselineType === 'csv'
                      const accept = isCsv ? '.csv,text/csv' : '.xlsx,.xls'
                      const currentFile = isCsv ? baselineCsvFile : baselineXlsxFile
                      const inputId = isCsv ? 'baseline-csv-input' : 'baseline-xlsx-input'
                      const hint = isCsv ? '尚未選擇檔案（.csv）' : '尚未選擇檔案（.xlsx / .xls）'
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <input
                            id={inputId}
                            type="file"
                            accept={accept}
                            style={{ display: 'none' }}
                            onChange={e => {
                              const file = e.target.files?.[0] ?? null
                              if (isCsv) {
                                setBaselineCsvFile(file)
                                if (file) {
                                  const reader = new FileReader()
                                  reader.onload = ev => setBaselineContent(ev.target!.result as string)
                                  reader.readAsText(file, 'utf-8')
                                } else { setBaselineContent('') }
                              } else {
                                setBaselineXlsxFile(file)
                                if (file) {
                                  const reader = new FileReader()
                                  reader.onload = ev => {
                                    const b64 = arrayBufferToBase64(ev.target!.result as ArrayBuffer)
                                    setBaselineXlsxB64(b64)
                                  }
                                  reader.readAsArrayBuffer(file)
                                } else { setBaselineXlsxB64('') }
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => document.getElementById(inputId)?.click()}
                            style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #e2e8f0', background: '#f8fafc', color: '#374151', whiteSpace: 'nowrap' }}
                          >
                            📎 選擇檔案
                          </button>
                          <span style={{ fontSize: 12, color: currentFile ? '#374151' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {currentFile ? `${currentFile.name} (${(currentFile.size / 1024).toFixed(1)} KB)` : hint}
                          </span>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>

          {(action === 'generate' || action === 'secondpass') && (
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
              ? <>{isGame ? <DungeonIcon name="ai" tone="violet" size="xs" plain /> : '⏳'} AI 分析中，請稍候（約 30-60 秒）...</>

              : action === 'secondpass'
                ? '開始補填'
                : action === 'generate'
                  ? '開始生成'
                  : '開始比對'}
          </button>

          <div className="info-block" style={{ marginTop: 20 }}>
            <h3>流程說明</h3>
            {action === 'generate' && testcaseMode === 'full' && (
              <ol>
                <li>新增一份或多份規格書（Lark Wiki / PDF / Google 文檔，可混合）</li>
                <li>後端逐份讀取文件全文並合併</li>
                <li>Google Gemini 整合分析所有規格書，生成完整 TestCase</li>
                <li>批次寫入 Lark Bitable 多維表格</li>
              </ol>
            )}
            {action === 'generate' && testcaseMode === 'diff' && (
              <ol>
                <li>上方輸入<strong>新版規格書</strong>（Lark Wiki / PDF / Google 文檔）</li>
                <li>下方輸入<strong>舊版規格書</strong> URL（支援多份 Lark / Google Docs）</li>
                <li>Gemini 比對新舊差異，只生成<strong>變動</strong>（[變更]）或<strong>新增</strong>（[新增]）的 TestCase</li>
                <li>未變動的案例不重複產出，節省 token 並避免重複</li>
                <li>批次寫入 Lark Bitable（含編號、規格來源、版本標籤欄位）</li>
              </ol>
            )}
            {action === 'generate' && testcaseMode === 'baseline' && (
              <ol>
                <li>上方輸入<strong>新版規格書</strong>（Lark Wiki / PDF / Google 文檔）</li>
                <li>下方提供<strong>既有 TestCase</strong>（JSON 貼上 / Lark Bitable / CSV / XLSX）</li>
                <li>Gemini 覆蓋比對：<strong>valid</strong>（保留有效）、<strong>obsolete</strong>（標記過時 + 填 replacedBy）、<strong>new</strong>（新增案例）</li>
                <li>批次寫入 Lark Bitable（含 狀態、取代者、編號、規格來源、版本標籤欄位）</li>
              </ol>
            )}
            {action === 'compare' && (
              <ol>
                <li>貼上規格書網址 + 你自己的 TestCase Bitable</li>
                <li>同步讀取 AI 生成案例與人工案例</li>
                <li>Gemini 分析覆蓋率、缺漏、版本衝突</li>
              </ol>
            )}
            {action === 'secondpass' && (
              <ol>
                <li>提供原始規格書（Lark Wiki / PDF / Google 文檔）作為 AI 的判斷依據</li>
                <li>上傳或貼上<strong>已生成但有空白欄位</strong>的 TestCase（JSON / Lark / CSV / XLSX）</li>
                <li>Gemini 對照規格書，識別應填入但缺漏的欄位並補全</li>
                <li>不覆蓋已有內容，只填補缺漏項目，回傳完整 TestCase</li>
              </ol>
            )}
            <p className="info-note">{isGame ? <DungeonIcon name="settings" tone="slate" size="xs" plain /> : '⚙️'} Lark API Token 設定於後端 <code>.env</code>，前端不持有任何密鑰</p>
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
                <div className="summary-item ok">{isGame ? <DungeonIcon name="result" tone="cyan" size="xs" plain /> : '📝'} 生成 {result.generated} 筆</div>
                <div className="summary-item ok">{isGame ? <DungeonIcon name="status-ok" tone="green" size="xs" plain /> : '✅'} 已寫入 Bitable {result.written} 筆</div>
              </div>
              {result.bitableUrl && (
                <a
                  href={result.bitableUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bitable-link-btn"
                >
                  {isGame ? <DungeonIcon name="guide" tone="cyan" size="xs" plain /> : '📋'} 前往 Lark Bitable 查看結果 →
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
        <h2 className="section-title">{isGame ? <DungeonIcon name="guide" tone="cyan" size="xs" plain /> : '📋'} Lark Bitable 欄位結構 &amp; 範例</h2>

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

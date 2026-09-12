import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { recordingSaveErrors } from '../../../shared/uat-recording-schema'
import { stepDependencyIssues } from '../../../server/uat-runner/step-dependencies.js'
import { MultiTcResults, type MultiResult } from './MultiTcResults'
import type { BackendTc, Step } from './BackendTcEditor'
import type { UatThemeMode } from './types'

type Binding = { recordId: string; tableId: string; number: string; text: string; sub: string }
type Script = { id?: string; title: string; larkUrl: string; tableId: string; bindings: Binding[]; steps: Step[] }
export type RecordedScript = Script
type Param = { key: string; label: string; type: string; options?: string[]; default?: unknown; help?: string }
type Def = { label: string; category: string; params?: Param[] }
type Result = MultiResult
type Run = { runId: string; dryRun: boolean; stopped?: boolean; results: Result[]; createdAt: number }
const empty = (larkUrl: string): Script => {
  let tableId = ''
  try { tableId = new URL(larkUrl).searchParams.get('table') || '' } catch { /* waiting for URL */ }
  return { title: '', larkUrl, tableId, bindings: [], steps: [] }
}
const label = (b: Binding) => `${b.number || b.recordId}｜${b.text}`

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const data = await response.json()
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || '請求失敗')
  return data
}

export function MultiTcRecorder({ open, onClose, tcs, larkUrl, agentId, running, themeMode, onRun, initialScript }: {
  initialScript?: Script;
  open: boolean; onClose: () => void; tcs: BackendTc[]; larkUrl: string; agentId: string;
  running: boolean; themeMode: UatThemeMode; onRun: () => void;
}) {
  const [script, setScript] = useState<Script>(() => initialScript || empty(larkUrl))
  const [scripts, setScripts] = useState<Script[]>([])
  const [defs, setDefs] = useState<Record<string, Def>>({})
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const titleInput = useRef<HTMLInputElement>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [recId, setRecId] = useState<string | null>(null)
  const [liveSteps, setLiveSteps] = useState<Step[]>([])
  const [query, setQuery] = useState('')
  const [tcScan, setTcScan] = useState<{ url: string; tcs: BackendTc[] } | null>(null)
  const [tcLoading, setTcLoading] = useState(false)
  const [tcError, setTcError] = useState('')
  const [tcRefresh, setTcRefresh] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [addAction, setAddAction] = useState('screenshot')
  const [addOwner, setAddOwner] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [json, setJson] = useState('')
  const [jsonOpen, setJsonOpen] = useState(false)
  const [confirmRun, setConfirmRun] = useState(false)
  const recordingInsert = useRef<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [insertHere, setInsertHere] = useState(false)
  const [liveNet, setLiveNet] = useState<{ urlPattern: string; method: string; status: number | null }[]>([])
  const edit = (next: Script) => { setScript(next); setDirty(true); setConfirmRun(false) }
  useEffect(() => {
    if (!open) return
    setTcError('')
    if (!script.larkUrl || !script.tableId) { setTcLoading(false); return }
    const controller = new AbortController()
    const url = script.larkUrl
    setTcLoading(true)
    void request(`/api/osm-uat/scan?larkUrl=${encodeURIComponent(url)}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setTcScan({ url, tcs: data.tcs || [] }) })
      .catch(e => { if (!controller.signal.aborted) setTcError(`載入 TC 失敗：${e instanceof Error ? e.message : String(e)}`) })
      .finally(() => { if (!controller.signal.aborted) setTcLoading(false) })
    return () => controller.abort()
  }, [open, script.larkUrl, script.tableId, tcRefresh])
  useEffect(() => {
    if (!script.id && !dirty && !recId && script.larkUrl !== larkUrl) setScript(empty(larkUrl))
  }, [larkUrl, script.id, script.larkUrl, dirty, recId])
  const loadLibrary = useCallback(async () => {
    const data = await request('/api/osm-uat/recorded-scripts')
    setScripts(data.scripts)
  }, [])
  useEffect(() => {
    if (!open) return
    void Promise.all([loadLibrary(), request('/api/osm-uat/blocks').then(d => setDefs(d.blockDefs))]).catch(e => setMessage(e.message))
  }, [open, loadLibrary])
  useEffect(() => {
    if (!open || !script.id) return
    let stopped = false
    const refresh = async () => {
      try { const data = await request(`/api/osm-uat/recorded-scripts/${script.id}/results`); if (!stopped) setRuns(data.runs) } catch (e) { if (!stopped) setMessage(String(e)) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [open, script.id])

  const appendRecording = useCallback((steps: Step[]) => {
    // Another recording starts its read variables at v1; retain references without collisions.
    const prefix = `rec${Date.now()}_`
    const names = new Set(steps.map(s => s.as).filter((v): v is string => typeof v === 'string'))
    const renamed = steps.map(step => Object.fromEntries(Object.entries(step).map(([key, value]) => {
      if (['as', 'from', 'left', 'right'].includes(key) && typeof value === 'string') {
        const root = value.split('.')[0]
        if (names.has(root)) return [key, prefix + value]
      }
      return [key, value]
    })) as Step)
    const insertion = recordingInsert.current
    setScript(prev => { const at = insertion === null ? prev.steps.length : Math.min(insertion, prev.steps.length); return { ...prev, steps: [...prev.steps.slice(0, at), ...renamed, ...prev.steps.slice(at)] } })
    recordingInsert.current = null
    setDirty(true); setRecId(null); setLiveSteps([])
    setMessage(`已加入 ${steps.length} 步。請在對照表確認各 TC 的檢查與截圖，再儲存試跑。`)
  }, [])

  useEffect(() => {
    if (!recId) return
    let stopped = false
    let fetching = false
    const timer = window.setInterval(async () => {
      if (fetching) return
      fetching = true
      try {
        const data = await request(`/api/osm-uat/record/status/${recId}`)
        if (stopped) return
        setLiveSteps(data.steps || []); setLiveNet(data.netCalls || [])
        if (data.done) {
          stopped = true; clearInterval(timer)
          appendRecording(data.steps || [])
          if (data.error) setMessage(`錄製已結束：${data.error}。已保留收到的步驟。`)
        }
      } catch (e) { if (!stopped) setMessage(String(e)) }
      finally { fetching = false }
    }, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [recId, appendRecording])

  const rows = useMemo(() => script.bindings.map(binding => {
    const owned = script.steps.filter(step => step.tcId === binding.recordId && step.disabled !== true)
    return { binding, declared: owned.find(s => s.action === 'set_tc_result')?.outcome, checks: owned.filter(s => ['assert', 'compare'].includes(defs[s.action]?.category)).length,
      shots: owned.filter(s => s.action === 'screenshot').length }
  }), [script, defs])
  const unassignedSteps = script.steps.flatMap((s, i) => s.disabled !== true && !s.tcId && ['read', 'assert', 'compare', 'evidence', 'result'].includes(defs[s.action]?.category) ? [i + 1] : [])
  const weakSteps = script.steps.flatMap((s, i) => s.disabled !== true && s.selectorStrategy === 'cssPath' ? [i + 1] : [])
  const unassigned = unassignedSteps.length
  const candidates = (tcScan?.url === script.larkUrl ? tcScan.tcs : tcs).filter(tc => tc.source === 'live' && tc.storageKey.startsWith(`${script.tableId}:`)
    && `${tc.number} ${tc.text}`.toLowerCase().includes(query.toLowerCase()))
  const patchStep = (index: number, patch: Partial<Step>) => edit({ ...script, steps: script.steps.map((s, i) => i === index ? { ...s, ...patch } : s) })
  const moveStep = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= script.steps.length || to >= script.steps.length) return
    const steps = [...script.steps]; const [moving] = steps.splice(from, 1); steps.splice(to, 0, moving)
    edit({ ...script, steps }); setSelected(to)
  }
  const loadBaseline = async (file: File, index: number) => {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('PNG 不可超過 2 MB')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if ([137,80,78,71,13,10,26,10].some((v, i) => bytes[i] !== v)) throw new Error('請選 PNG 圖片')
      const image = await createImageBitmap(file)
      const pixels = image.width * image.height; image.close()
      if (pixels > 4_000_000) throw new Error('PNG 最多 400 萬像素')
      const reader = new FileReader()
      reader.onload = () => { patchStep(index, { baselinePng: String(reader.result) }); setMessage('基準圖已加入，請儲存腳本。比對時要求圖片尺寸一致。') }
      reader.readAsDataURL(file)
    } catch (e) { setMessage(String(e)) }
  }
  const saveErrors = recordingSaveErrors(script)
  const dependencyIssues = stepDependencyIssues(script.steps)
  const save = async () => {
    if (saveErrors.length) { if (!script.title.trim()) titleInput.current?.focus(); throw new Error(saveErrors.join('；')) }
    const data = await request('/api/osm-uat/recorded-scripts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(script) })
    setScript(data.script); setDirty(false); await loadLibrary(); return data.script as Script
  }
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(''); setActionError('')
    try { await fn() } catch (e) { const text = e instanceof Error ? e.message : String(e); setMessage(text); setActionError(text) } finally { setBusy(false) }
  }
  const startRecording = (at: number | null = null) => act(async () => {
    recordingInsert.current = at
    const data = await request('/api/osm-uat/record/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId || undefined, bindings: script.bindings }) })
    setRecId(data.sessionId); setLiveSteps([]); setLiveNet([])
    setMessage(`正在 ${data.agentLabel} 錄製。到瀏覽器右下角選擇檢查與截圖歸屬；一般操作預設共用。`)
  })
  const stopRecording = () => act(async () => {
    const id = recId
    setRecId(null) // cancel polling before asking the agent to flush/close
    try { const data = await request(`/api/osm-uat/record/stop/${id}`, { method: 'POST' }); appendRecording(data.steps || []) }
    catch (e) { setRecId(id); throw e }
  })
  const run = (dryRun: boolean, stopAfter?: number) => act(async () => {
    const issues = stepDependencyIssues(stopAfter === undefined ? script.steps : script.steps.slice(0, stopAfter + 1))
    if (issues.length) throw new Error(issues.map(issue => issue.message).join('；'))
    const saved = await save()
    await request('/api/osm-uat/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordedScriptId: saved.id, agentId: agentId || undefined, dryRun, ...(stopAfter !== undefined ? { stopAfter } : {}) }) })
    onRun(); setConfirmRun(false); setMessage(stopAfter !== undefined ? `局部試跑已開始：從頭執行至第 ${stopAfter + 1} 步，不回寫 Lark。` : dryRun ? '試跑已開始：仍會操作後台，但不會上傳圖片或回寫 Lark。' : '正式執行已開始：各 TC 將分別上傳圖片與回寫判定。')
  })
  const resetEditor = (next: Script) => {
    setScript(next); setSelected(null); setRuns([]); setDirty(false); setMessage(''); setConfirmRun(false)
    setQuery(''); setAddOwner(''); setAddAction('screenshot'); setJson(''); setJsonOpen(false)
    setActionError(''); setInsertHere(false); setDragIndex(null); setLiveNet([]); setLiveSteps([])
    recordingInsert.current = null
  }
  const fresh = () => {
    if (dirty && !window.confirm('目前有未儲存修改，確定另開新腳本？')) return
    resetEditor(empty(larkUrl))
  }
  if (!open) return null
  return createPortal(<div className={`uat-studio uat-multi-overlay ${themeMode === 'xianxia' ? 'is-xianxia' : ''}`} role="dialog" aria-modal="true" aria-label="錄製腳本工作台">
    <section className="uat-multi-workbench">
      <header className="uat-multi-header"><div><h2>錄製腳本工作台</h2><p>一份腳本，共用操作；每筆 TC 分別檢查、配圖與判定。</p></div>
        <button className="uat-btn is-quiet" disabled={!!recId || busy} onClick={() => { if (!dirty || window.confirm('尚有未儲存修改，確定關閉？')) onClose() }}>關閉</button></header>
      <div className="uat-multi-toolbar">
        <select aria-label="已儲存的錄製腳本" value={script.id || ''} disabled={!!recId || busy} onChange={e => {
          if (!e.target.value) { fresh(); return }
          const found = scripts.find(s => s.id === e.target.value)
          if (found && (!dirty || window.confirm('放棄目前未儲存修改，載入另一份腳本？'))) resetEditor(found)
        }}><option value="">新腳本／初始畫面</option>{scripts.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
        <button className="uat-btn is-quiet" disabled={!!recId || busy} onClick={fresh}>新腳本</button>
        <input ref={titleInput} aria-label="腳本名稱" required placeholder="例如 Dashboard 四區檢查" value={script.title} disabled={!!recId} onChange={e => edit({ ...script, title: e.target.value })} />
        <button className="uat-btn" disabled={busy || !!recId || !script.title || !script.bindings.length} onClick={() => void act(async () => { await save(); setMessage('腳本已儲存。') })}>儲存{dirty ? ' *' : ''}</button>
      </div>
      <p className="uat-multi-message" role="status">{message || '先綁定 Lark TC，再開始錄製；相同編號的不同列會分開保存。'}</p>
      <div className="uat-multi-layout">
        <aside className="uat-multi-bindings">
          <h3>1. 綁定 Lark TC</h3><p>最多 20 筆。勾選下方 TC 即可加入目前腳本。</p>
          <small>表格：{script.tableId || '尚未選擇'}</small>
          <button className="uat-btn is-quiet" disabled={tcLoading || !script.tableId || !!recId || busy} onClick={() => setTcRefresh(n => n + 1)}>{tcLoading ? '載入 TC 中…' : '重新載入 Lark TC'}</button>
          {tcError && <p role="alert">{tcError}。可重新載入；已綁定 TC 與步驟仍保留。</p>}
          <input aria-label="搜尋可綁定 TC" placeholder="搜尋編號或描述" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="uat-multi-candidates">{candidates.map(tc => <label key={tc.recordId}>
            <input type="checkbox" disabled={!!recId || busy || (script.bindings.length >= 20 && !script.bindings.some(b => b.recordId === tc.recordId))} checked={script.bindings.some(b => b.recordId === tc.recordId)} onChange={e => {
              if (e.target.checked) edit({ ...script, bindings: [...script.bindings, { recordId: tc.recordId, tableId: script.tableId, number: tc.number, text: tc.text, sub: tc.sub }] })
              else if (!script.steps.some(s => s.tcId === tc.recordId) || window.confirm('移除綁定後，相關步驟會變成待指定 TC；步驟仍會保留。')) edit({ ...script, bindings: script.bindings.filter(b => b.recordId !== tc.recordId), steps: script.steps.map(s => s.tcId === tc.recordId ? { ...s, tcId: null } : s) })
            }} /><span><b>{tc.number || tc.recordId}</b>{tc.text}<small>{tc.recordId}</small></span>
          </label>)}</div>
          {!candidates.length && !tcLoading && <p>{query ? '沒有符合搜尋條件的 TC，請調整搜尋文字。' : !script.tableId ? '請先在主畫面填入 Lark 表格網址。' : '尚無可選 TC，請按「重新載入 Lark TC」。'}</p>}
          <h3>各 TC 對照</h3>{rows.map(({ binding, checks, shots, declared }) => <div className="uat-multi-review" key={binding.recordId}><strong>{label(binding)}</strong><span>{checks} 個檢查 · {shots} 張預定截圖</span>{declared ? <small>人工指定 {String(declared)}；實際執行失敗仍為 FAIL</small> : !checks && <small className="uat-multi-alert">没有檢查或指定判定，執行後將列為未驗證</small>}{!shots && <small>尚未指定截圖證據</small>}</div>)}
        </aside>
        <main className="uat-multi-editor">
          <h3>2. 錄製與調整步驟</h3><p>{agentId === 'server' ? '錄製位置：伺服器桌面。瀏覽器會開在伺服器這台電腦，請在該桌面操作。' : '錄製位置：Local Agent。瀏覽器會開在選取的 Agent 電腦。'}</p>
          <div className="uat-multi-toolbar">
            {recId ? <button className="uat-btn is-danger" disabled={busy} onClick={() => void stopRecording()}>停止錄製（{liveSteps.length} 步）</button>
              : <button className="uat-btn" disabled={busy || running || !script.bindings.length} onClick={() => void startRecording()}>錄製並接在後面</button>}
            {!recId && selected !== null && <button className="uat-btn is-quiet" disabled={busy || running || !script.bindings.length} onClick={() => void startRecording(selected + 1)}>補錄至第 {selected + 1} 步後</button>}
            <small>補錄會新開錄製視窗，請自行操作至需要補錄的位置；可用暫停略過準備動作。切換 TC 只影響檢查與截圖；一般操作預設共用。暫停可在錄製視窗操作。</small>
          </div>
          {!!recId && <div className="uat-multi-live"><strong>即時錄製步驟</strong>{liveSteps.slice(-8).map((s, i) => <div key={i}>{defs[s.action]?.label || s.action} · {script.bindings.find(b => b.recordId === s.tcId)?.text || '共用'} · {String(s.selector || s.path || s.name || '')}</div>)}</div>}
          {!recId && <>
            <div className="uat-multi-toolbar">
              <select aria-label="新增積木種類" value={addAction} onChange={e => setAddAction(e.target.value)}>{Object.entries(defs).filter(([key]) => key !== 'builtin_verifier').map(([key, d]) => <option key={key} value={key}>{d.label}</option>)}</select>
              <select aria-label="新增步驟歸屬" value={addOwner} onChange={e => setAddOwner(e.target.value)}><option value="">共用／尚未指定</option>{script.bindings.map(b => <option key={b.recordId} value={b.recordId}>{label(b)}</option>)}</select>
              <label><input type="checkbox" checked={insertHere} disabled={selected === null} onChange={e => setInsertHere(e.target.checked)} />插入選取步驟之後</label>
              <button className="uat-btn is-quiet" onClick={() => {
                const defaults = Object.fromEntries((defs[addAction]?.params || []).filter(p => p.default !== undefined).map(p => [p.key, p.default]))
                const at = insertHere && selected !== null ? selected + 1 : script.steps.length
                const steps = [...script.steps]; steps.splice(at, 0, { ...defaults, action: addAction, tcId: addOwner || null }); edit({ ...script, steps }); setSelected(at)
              }}>加入步驟</button>
              <button className="uat-btn is-quiet" onClick={() => { setJson(JSON.stringify(script.steps, null, 2)); setJsonOpen(!jsonOpen) }}>JSON 編輯</button>
            </div>
            {!!unassigned && <p className="uat-multi-alert">共 {unassigned} 個步驟尚未指定 TC（第 {unassignedSteps.join('、')} 步）。檢查、讀值、截圖與回填判定都需指定 TC，才能試跑或正式執行。</p>}
            {!!weakSteps.length && <p className="uat-multi-alert">共 {weakSteps.length} 個步驟使用結構路徑定位（第 {weakSteps.join('、')} 步），請試跑確認能找到正確元素。</p>}
            {jsonOpen && <div><textarea aria-label="多 TC 步驟 JSON" className="uat-multi-json" value={json} onChange={e => setJson(e.target.value)} /><button className="uat-btn" onClick={() => {
              try { const steps: unknown = JSON.parse(json); if (!Array.isArray(steps) || steps.some(s => !s || typeof s.action !== 'string')) throw new Error('必須是積木陣列'); edit({ ...script, steps }); setJsonOpen(false) }
              catch (e) { setMessage(`JSON 錯誤：${String(e)}`) }
            }}>套用 JSON</button></div>}
            <ol className="uat-multi-steps">{script.steps.map((step, i) => <li key={i} className={`${selected === i ? 'is-selected' : ''} ${step.disabled ? 'is-disabled' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragIndex !== null) moveStep(dragIndex, i); setDragIndex(null) }}>
              <button className="uat-drag-handle" aria-label={`拖曳第 ${i + 1} 步`} draggable onDragStart={e => { setDragIndex(i); e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => setDragIndex(null)}>拖曳</button>
              <button className="uat-multi-step-name" onClick={() => setSelected(selected === i ? null : i)}>{i + 1}. {defs[step.action]?.label || step.action}<small>{String(step.selector || step.path || step.name || step.from || '')}</small></button>
              <select aria-label={`第 ${i + 1} 步歸屬`} value={String(step.tcId || '')} onChange={e => patchStep(i, { tcId: e.target.value || null })}><option value="">共用／尚未指定</option>{script.bindings.map(b => <option key={b.recordId} value={b.recordId}>{label(b)}</option>)}</select>
              <div className="uat-multi-step-actions"><button onClick={() => patchStep(i, { disabled: !step.disabled })}>{step.disabled ? '啟用' : '停用'}</button><button onClick={() => {
                const copy = structuredClone(step); if (typeof copy.as === 'string') copy.as = `${copy.as}_copy${Date.now()}`
                const steps = [...script.steps]; steps.splice(i + 1, 0, copy); edit({ ...script, steps }); setSelected(i + 1)
              }}>複製</button>{[-1, 1].map(delta => <button key={delta} aria-label={`第 ${i + 1} 步${delta < 0 ? '上移' : '下移'}`} disabled={i + delta < 0 || i + delta >= script.steps.length} onClick={() => {
                const steps = [...script.steps]; [steps[i], steps[i + delta]] = [steps[i + delta], steps[i]]; edit({ ...script, steps }); setSelected(i + delta)
              }}>{delta < 0 ? '上移' : '下移'}</button>)}<button onClick={() => { edit({ ...script, steps: script.steps.filter((_, j) => j !== i) }); setSelected(null) }}>刪除</button></div>
              {selected === i && <div className="uat-multi-params">{(defs[step.action]?.params || []).map(param => <label key={param.key}>{param.label}
                {param.key === 'baselinePng' ? <div><input aria-label="上傳 PNG 基準圖" type="file" accept="image/png" onChange={e => { const f = e.target.files?.[0]; if (f) void loadBaseline(f, i) }} />{typeof step.baselinePng === 'string' && step.baselinePng.startsWith('data:image/png;base64,') && <img className="uat-baseline-preview" src={step.baselinePng} alt="目前基準圖" />}<small>上傳人工確認的區域 PNG；尺寸須與執行截圖相同，最多 2 MB。</small></div> : param.type === 'boolean' ? <input type="checkbox" checked={!!step[param.key]} onChange={e => patchStep(i, { [param.key]: e.target.checked })} />
                  : param.type === 'select' ? <select aria-label={param.label} value={String(step[param.key] ?? param.default ?? '')} onChange={e => patchStep(i, { [param.key]: e.target.value })}>{param.options?.map(o => <option key={o} value={o}>{o || '請選擇判定'}</option>)}</select>
                    : <input type={param.type === 'number' ? 'number' : 'text'} value={String(step[param.key] ?? '')} onChange={e => patchStep(i, { [param.key]: param.type === 'number' ? e.target.value === '' ? undefined : Number(e.target.value) : e.target.value })} />}
                {param.help && <small>{param.help}</small>}</label>)}{['read_block', 'read_table'].includes(step.action) && <small>此步驟在執行時讀取畫面並建立變數，後面的檢查會使用它；請保留在檢查之前。</small>}<small>刪除與調整只修改腳本，不會撤銷後台已執行的操作。</small></div>}
            </li>)}</ol>
            {!!liveNet.length && <details><summary>錄製時的 API（可加入檢查）</summary>{liveNet.slice(-20).map((call, i) => <div className="uat-multi-api" key={i}><code>{call.method} {call.urlPattern} — {call.status}</code><button className="uat-btn is-quiet" disabled={!addOwner || call.status === null} onClick={() => edit({ ...script, steps: [...script.steps, { action: 'assert_api_called', tcId: addOwner, urlPattern: call.urlPattern, expectStatus: '2xx' }] })}>加入目前歸屬</button></div>)}<small>請先選「新增步驟歸屬」，並把新增斷言移到對應操作後。</small></details>}
          </>}
          {selected !== null && <button className="uat-btn is-quiet" disabled={busy || !!recId || running || !!unassigned || !!saveErrors.length || !!dependencyIssues.length} onClick={() => void run(true, selected)}>從頭試跑至第 {selected + 1} 步</button>}
          <h3>3. 試跑與回寫</h3>
          {!recId && dependencyIssues.map(issue => <div key={`${issue.index}:${issue.name}`} className="uat-multi-alert" role="alert"><p>{issue.message}</p>
            <button className="uat-btn is-quiet" onClick={() => setSelected(issue.index)}>定位問題步驟</button>
            {['assert_filled', 'assert_sorted'].includes(script.steps[issue.index].action) && !script.steps.some(s => s.as === issue.name) && <button className="uat-btn is-quiet" disabled={busy || !!recId} onClick={() => {
              const source = script.steps[issue.index]
              const steps = [...script.steps]
              steps.splice(issue.index, 0, { action: source.action === 'assert_sorted' ? 'read_table' : 'read_block', as: issue.name, selector: '', tcId: source.tcId })
              edit({ ...script, steps }); setSelected(issue.index)
              setMessage('已補上讀取步驟。請填入原本元素的 selector；若不確定，請重新錄製「必須有值」，保留讀取與檢查兩步。')
            }}>補上來源讀取步驟</button>}
          </div>)}
          {running && <p role="status">目前有測試執行中，完成後會自動開放再次試跑。</p>}
          {!!recId && <p>目前顯示本輪即時步驟，尚未合併到腳本。按「停止錄製」會收齊步驟、關閉錄製視窗並返回編輯；接著再儲存試跑。補錄會新增步驟，原有錯誤步驟仍需修正或刪除。</p>}
          {!!saveErrors.length && <div className="uat-multi-alert" role="alert">{saveErrors.join('；')}{!script.title.trim() && <button className="uat-btn is-quiet" onClick={() => titleInput.current?.focus()}>填寫腳本名稱</button>}</div>}
          {!!actionError && <p className="uat-multi-alert" role="alert">{actionError}。錄製步驟仍保留，修正後可重試。</p>}<p>試跑會操作後台，但不寫 Lark；正式執行會以本次圖片取代各筆 TC 的附圖。</p>
          <div className="uat-multi-toolbar"><button className="uat-btn" disabled={busy || !!recId || running || !script.steps.length || !!unassigned || !!saveErrors.length || !!dependencyIssues.length} onClick={() => void run(true)}>儲存並試跑</button><button className="uat-btn" disabled={busy || !!recId || running || !script.steps.length || !!unassigned || !!saveErrors.length || !!dependencyIssues.length} onClick={() => setConfirmRun(true)}>正式執行並回寫 Lark</button></div>
          {confirmRun && <div className="uat-multi-confirm"><strong>本次將更新 {script.bindings.length} 筆 TC 的附圖與 PASS／FAIL。</strong><p>未驗證／受阻將清除兩個勾選；一筆 TC 失敗不會讓其他 TC 自動失敗。</p><button className="uat-btn" disabled={busy} onClick={() => void run(false)}>確認執行</button><button className="uat-btn is-quiet" onClick={() => setConfirmRun(false)}>取消</button></div>}
          {!!runs.length && <div className="uat-multi-results"><h3>最近結果</h3><p>{new Date(runs[0].createdAt).toLocaleString()} · {runs[0].dryRun ? '試跑' : '正式執行'}{runs[0].stopped ? ' · 已停止' : ''}</p><MultiTcResults results={runs[0].results} dryRun={runs[0].dryRun} /></div>}
        </main>
      </div>
    </section>
  </div>, document.body)
}

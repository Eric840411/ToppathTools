import { useEffect, useState } from 'react'
import type { RecordedScript } from './MultiTcRecorder'

export function RecordedScriptLibrary({ revision, disabled, onOpen, selectedIds, onSelection, onScripts }: {
  revision: number; disabled: boolean; onOpen: (script?: RecordedScript) => void;
  selectedIds: string[]; onSelection: (ids: string[]) => void; onScripts: (scripts: RecordedScript[]) => void
}) {
  const [scripts, setScripts] = useState<RecordedScript[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch('/api/osm-uat/recorded-scripts', { signal: controller.signal }).then(async response => {
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.message || '載入腳本失敗')
      if (!controller.signal.aborted) { setScripts(data.scripts || []); onScripts(data.scripts || []) }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision, refresh, onScripts])
  const filtered = scripts.filter(s => `${s.title} ${s.bindings.map(b => `${b.number} ${b.text}`).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  return <>
    <div className="uat-section-title"><span>SCRIPT LIBRARY</span><h3>錄製腳本 <small>{scripts.length} 份</small></h3><p>點選腳本可編輯、試跑、查看結果與回寫 Lark。</p></div>
    <div className="uat-tc-record-actions"><button className="uat-btn" disabled={disabled} onClick={() => onOpen()}>錄製腳本</button><button className="uat-btn is-quiet" disabled={loading} onClick={() => setRefresh(n => n + 1)}>重新整理</button></div>
    <input className="uat-field" aria-label="搜尋錄製腳本" placeholder="搜尋腳本名稱或 TC" value={query} onChange={e => setQuery(e.target.value)} />
    {loading && <p role="status">載入腳本中…</p>}
    {error && <p role="alert">{error}，請重新整理清單。</p>}
    <div className="uat-tc-record-actions"><button className="uat-btn is-quiet" disabled={disabled || loading} onClick={() => onSelection([...new Set([...selectedIds, ...filtered.flatMap(s => s.id ? [s.id] : [])])])}>全選搜尋結果</button><button className="uat-btn is-quiet" disabled={disabled || !selectedIds.length} onClick={() => onSelection([])}>清除選取</button></div>
    <small>已選 {selectedIds.length} 份。勾選一份即單選，多份依中間清單順序執行。</small>
    <div className="uat-backend-tc-list uat-backend-all-tcs">{filtered.map(script => <div className="uat-script-select-row" key={script.id}><input type="checkbox" aria-label={`執行 ${script.title}`} disabled={disabled || !script.id} checked={selectedIds.includes(script.id || '')} onChange={e => onSelection(e.target.checked ? [...selectedIds, script.id!] : selectedIds.filter(id => id !== script.id))} /><button className="uat-backend-tc" disabled={disabled} onClick={() => onOpen(script)}>
      <span title={script.title}>{script.title}</span><em className="has-steps">{script.bindings.length} TC · {script.steps.filter(s => !s.disabled).length} 步</em>
    </button></div>)}</div>
    {!loading && !error && !filtered.length && <p>{query ? '沒有符合搜尋條件的腳本。' : '尚無錄製腳本。按「錄製腳本」，綁定 Lark TC 後開始錄製。'}</p>}
  </>
}

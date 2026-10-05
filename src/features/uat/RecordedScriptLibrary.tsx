import { useEffect, useState } from 'react'
import type { RecordedScript } from './MultiTcRecorder'

/** 列表 API 多回的欄位：running（誰都看得到）、lock（只有管理員拿得到，人工解除要用） */
type ScriptRow = RecordedScript & { running?: boolean; lock?: { holder: string; sessionId: string; since: number } }

export function RecordedScriptLibrary({ revision, disabled, onOpen, selectedIds, onSelection, onScripts }: {
  revision: number; disabled: boolean; onOpen: (script?: RecordedScript) => void;
  selectedIds: string[]; onSelection: (ids: string[]) => void; onScripts: (scripts: RecordedScript[]) => void
}) {
  const [scripts, setScripts] = useState<ScriptRow[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  // 管理員人工解除執行鎖（救援用）：先在列上展開確認，再送出那一輪的 sessionId
  // 確認框綁定「展開當下看到的那一輪」：重新整理後換成別輪，就撤銷確認、要求重新確認——
  // 不然確認框開著時鎖換到新的一輪，按確認會送出新那輪的 sessionId、解掉正在正常執行的鎖（CodeX review 94cd396 [P2]）
  const [unlockAsk, setUnlockAsk] = useState<{ scriptId: string; sessionId: string } | null>(null)
  const [unlockMsg, setUnlockMsg] = useState<Record<string, string>>({})
  const [unlocking, setUnlocking] = useState(false)
  async function forceUnlock(script: ScriptRow) {
    // 送出的一定是展開確認時記下的那一輪，不是畫面現在的
    if (!script.id || !unlockAsk || unlockAsk.scriptId !== script.id) return
    setUnlocking(true)
    try {
      const r = await fetch(`/api/osm-uat/recorded-scripts/${encodeURIComponent(script.id)}/force-unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: unlockAsk.sessionId }) })
      const d = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }))
      setUnlockMsg(m => ({ ...m, [script.id!]: d.ok ? `已解除（原本是 ${d.previousHolder}）` : (d.message || d.error || '解除失敗') }))
      if (d.ok) { setUnlockAsk(null); setRefresh(n => n + 1) }
    } catch (e) {
      setUnlockMsg(m => ({ ...m, [script.id!]: `解除失敗：${(e as Error).message}` }))
    } finally { setUnlocking(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch('/api/osm-uat/recorded-scripts', { signal: controller.signal }).then(async response => {
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.message || '載入腳本失敗')
      if (!controller.signal.aborted) {
        const next: ScriptRow[] = data.scripts || []
        setScripts(next); onScripts(next)
        // 重新整理後鎖已經不是確認時那一輪（換輪或已解除）→ 撤銷確認
        setUnlockAsk(ask => {
          if (!ask) return ask
          const now = next.find(x => x.id === ask.scriptId)?.lock
          if (now?.sessionId === ask.sessionId) return ask
          setUnlockMsg(m => ({ ...m, [ask.scriptId]: now ? '執行鎖已經換到另一輪了，請重新確認後再解除' : '' }))
          return null
        })
      }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision, refresh, onScripts])
  const filtered = scripts.filter(s => `${s.title} ${s.bindings.map(b => `${b.number} ${b.text}`).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  return <>
    <div className="uat-section-title"><span>SCRIPT LIBRARY</span><h3>錄製腳本 <small>{scripts.length} 份</small></h3><p>點選腳本可編輯、試跑、查看結果與回寫 Lark。</p></div>
    <div className="uat-tc-record-actions" id="uat-focus-scripts"><button className="uat-btn is-primary" disabled={disabled} onClick={() => onOpen()}>錄製新腳本</button><button className="uat-btn is-quiet" disabled={loading} onClick={() => setRefresh(n => n + 1)}>重新整理</button></div>
    <input className="uat-field" aria-label="搜尋錄製腳本" placeholder="搜尋腳本名稱或 TC" value={query} onChange={e => setQuery(e.target.value)} />
    {loading && <p role="status">載入腳本中…</p>}
    {error && <p role="alert">{error}，請重新整理清單。</p>}
    <div className="uat-tc-record-actions"><button className="uat-btn is-quiet" disabled={disabled || loading} onClick={() => onSelection([...new Set([...selectedIds, ...filtered.flatMap(s => s.id ? [s.id] : [])])])}>全選搜尋結果</button><button className="uat-btn is-quiet" disabled={disabled || !selectedIds.length} onClick={() => onSelection([])}>清除選取</button></div>
    <small>已選 {selectedIds.length} 份。勾選一份即單選，多份依中間清單順序執行。</small>
    <div className="uat-backend-tc-list uat-backend-all-tcs">{filtered.map(script => <div className="uat-script-select-row" key={script.id}><input type="checkbox" aria-label={`執行 ${script.title}`} disabled={disabled || !script.id} checked={selectedIds.includes(script.id || '')} onChange={e => onSelection(e.target.checked ? [...selectedIds, script.id!] : selectedIds.filter(id => id !== script.id))} /><button className="uat-backend-tc" disabled={disabled} onClick={() => onOpen(script)}>
      <span title={script.title}>{script.title}</span><em className="has-steps">{script.bindings.length} TC · {script.steps.filter(s => !s.disabled).length} 步{script.running ? ' · 執行中' : ''}</em>
    </button>
      {script.lock && script.id && <div className="uat-script-lock">
        <small>執行鎖：{script.lock.holder}，{new Date(script.lock.since).toLocaleString('zh-TW', { hour12: false })} 開始</small>
        {!(unlockAsk && unlockAsk.scriptId === script.id && unlockAsk.sessionId === script.lock.sessionId)
          ? <button className="uat-btn is-quiet" disabled={unlocking} onClick={() => { setUnlockAsk({ scriptId: script.id!, sessionId: script.lock!.sessionId }); setUnlockMsg(m => ({ ...m, [script.id!]: '' })) }}>解除執行鎖</button>
          : <div role="alertdialog" aria-label="確認解除執行鎖" className="uat-script-lock-confirm">
              <p>請先確認 <strong>{script.lock.holder}</strong> 那台機器上這份腳本<strong>已經沒有在跑</strong>（Agent 斷線不代表已經停止，可能還在回寫 Lark）。解除後別人就能重跑或刪除這份腳本。</p>
              <button className="uat-btn is-primary" disabled={unlocking} onClick={() => void forceUnlock(script)}>{unlocking ? '解除中…' : '確認沒在跑，解除'}</button>
              <button className="uat-btn is-quiet" disabled={unlocking} onClick={() => setUnlockAsk(null)}>取消</button>
            </div>}
        {unlockMsg[script.id] && <small role="status">{unlockMsg[script.id]}</small>}
      </div>}
    </div>)}</div>
    {!loading && !error && !filtered.length && <p>{query ? '沒有符合搜尋條件的腳本。' : '尚無錄製腳本。按「錄製新腳本」，綁定 Lark TC 後開始錄製。'}</p>}
  </>
}

import { useEffect, useState } from 'react'
import type { RecordedScript } from './MultiTcRecorder'
import { buildScriptRows, lastRunText, type LastRun } from './script-sort'

/** 列表 API 多回的欄位：running（誰都看得到）、lock（只有管理員拿得到，人工解除要用）、建立者、上次執行摘要 */
type ScriptRow = RecordedScript & { running?: boolean; lock?: { holder: string; sessionId: string; since: number }; createdBy?: string; lastRun?: LastRun | null }
type Mine = { ids: string[]; revision: number }
const TAB_KEY = 'uat-backend-script-tab'

/**
 * 後台錄製腳本清單。
 *
 * 1007 改版（使用者經 claude-osm-2 提出、mockup 確認；「我的」的資料做法 CodeX 定案，見 docs/decisions.md）：
 *   - 跟 H5／PC 一樣一列一份，頁籤只有「全部」「我的」
 *   - 全部：所有人的腳本，照名稱開頭的編號排（script-sort.ts）；下方「加入我的」「刪除」
 *   - 我的：個人清單（自己建立／新錄的自動加入、可加別人的），拖 ⋮⋮ 排序；下方「移除」（只從清單拿掉，不刪腳本）
 *   - 刪除只限建立者或管理員（server 擋），沒有二次確認（使用者決定），沒刪成的列出原因
 */
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
  // 1007：頁籤、我的清單、批次動作的結果訊息、拖曳中的那一列
  const [tab, setTab] = useState<'all' | 'mine'>(() => { try { return localStorage.getItem(TAB_KEY) === 'mine' ? 'mine' : 'all' } catch { return 'all' } })
  const [mine, setMine] = useState<Mine>({ ids: [], revision: 0 })
  const [busy, setBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  // 登入帳號（server 回傳）。⚠️ 標「別人的」要用它，不能從清單猜（CodeX a26744e [P2]）
  const [me, setMe] = useState('')

  const chooseTab = (t: 'all' | 'mine') => { setTab(t); setActionMsg(''); try { localStorage.setItem(TAB_KEY, t) } catch { /* 存不了就算了 */ } }
  const send = async (url: string, method: string, body: unknown) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }))
    return { status: r.status, d }
  }
  async function addToMine(ids: string[]) {
    setBusy(true); setActionMsg('')
    try {
      const { d } = await send('/api/osm-uat/recorded-scripts/mine/add', 'POST', { ids })
      if (!d.ok) throw new Error(d.message || '加入失敗')
      setMine({ ids: d.ids, revision: d.revision })
      const dup = ids.length - d.added.length
      setActionMsg(`已加入「我的」${d.added.length} 份${dup ? `（${dup} 份本來就在）` : ''}`)
    } catch (e) { setActionMsg((e as Error).message) } finally { setBusy(false) }
  }
  async function removeFromMine(ids: string[]) {
    setBusy(true); setActionMsg('')
    try {
      const { d } = await send('/api/osm-uat/recorded-scripts/mine/remove', 'POST', { ids })
      if (!d.ok) throw new Error(d.message || '移除失敗')
      setMine({ ids: d.ids, revision: d.revision })
      onSelection(selectedIds.filter(id => !ids.includes(id)))
      setActionMsg(`已從「我的」移除 ${d.removed} 份（腳本還在「全部」）`)
    } catch (e) { setActionMsg((e as Error).message) } finally { setBusy(false) }
  }
  /** 刪除（只在「全部」）：沒權限／執行中的由 server 擋下，這裡跳過並列出原因 */
  async function deleteScripts(ids: string[]) {
    setBusy(true); setActionMsg('')
    const done: string[] = [], skipped: string[] = []
    for (const id of ids) {
      const title = scripts.find(s => s.id === id)?.title ?? id
      try {
        const r = await fetch(`/api/osm-uat/recorded-scripts/${encodeURIComponent(id)}`, { method: 'DELETE' })
        const d = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }))
        if (d.ok) done.push(id); else skipped.push(`${title}：${d.message || '刪除失敗'}`)
      } catch (e) { skipped.push(`${title}：${(e as Error).message}`) }
    }
    onSelection(selectedIds.filter(id => !done.includes(id)))
    setActionMsg(`已刪除 ${done.length} 份${skipped.length ? `；沒刪 ${skipped.length} 份——${skipped.join('；')}` : ''}`)
    setBusy(false); setRefresh(n => n + 1)
  }
  /** 拖曳排序：送整串看得到的 id＋目前版本；別的分頁改過（409）就換成伺服器的版本 */
  async function saveOrder(ids: string[]) {
    const prev = mine
    setMine({ ...mine, ids }); setBusy(true); setActionMsg('')
    try {
      const { status, d } = await send('/api/osm-uat/recorded-scripts/mine/order', 'PUT', { ids, expectedRevision: prev.revision })
      if (d.ok) setMine({ ids: d.ids, revision: d.revision })
      else {
        setMine(prev); setActionMsg(d.message || '排序沒有存到')
        // 409：別的分頁可能新建／加入了這頁還沒有的腳本——只換 mine 的話，下次拖曳會把那份濾掉、一直 mismatch。
        // 整份清單（腳本＋mine）重新載入（CodeX a26744e [P2]）
        if (status === 409) setRefresh(n => n + 1)
      }
    } catch (e) { setMine(prev); setActionMsg(`排序沒有存到：${(e as Error).message}`) } finally { setBusy(false) }
  }

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
        if (data.mine) setMine(data.mine)
        if (typeof data.me === 'string') setMe(data.me)
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

  const matches = (s: ScriptRow) => `${s.title} ${s.bindings.map(b => `${b.number} ${b.text}`).join(' ')}`.toLowerCase().includes(query.toLowerCase())
  const byId = new Map(scripts.map(s => [s.id, s]))
  const mineRows = mine.ids.flatMap(id => { const s = byId.get(id); return s ? [s] : [] })
  const rows = buildScriptRows({ scripts, mineIds: mine.ids, me, tab, match: matches })
  const filtered = rows.map(r => r.script)
  const rowInfo = new Map(rows.map(r => [r.script.id, r]))
  // 拖曳只在「我的」、沒有搜尋時才開（搜尋時看到的不是整串，排出來的順序對不上）
  const canDrag = tab === 'mine' && !query && !busy && !disabled
  const checked = selectedIds.filter(id => filtered.some(s => s.id === id))
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); return }
    const ids = mine.ids.filter(id => id !== dragId && byId.has(id))
    ids.splice(ids.indexOf(targetId), 0, dragId)
    setDragId(null)
    void saveOrder(ids)
  }

  return <>
    <div className="uat-section-title"><span>SCRIPT LIBRARY</span><h3>錄製腳本 <small>{scripts.length} 份</small></h3><p>點選腳本可編輯、試跑、查看結果與回寫 Lark。</p></div>
    <div className="uat-tc-record-actions" id="uat-focus-scripts"><button className="uat-btn is-primary" disabled={disabled} onClick={() => onOpen()}>錄製新腳本</button><button className="uat-btn is-quiet" disabled={loading} onClick={() => setRefresh(n => n + 1)}>重新整理</button></div>
    <input className="uat-field" aria-label="搜尋錄製腳本" placeholder="搜尋腳本名稱或 TC" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="uat-filter-row" role="tablist" aria-label="腳本範圍">
      <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'is-active' : ''} onClick={() => chooseTab('all')}>全部 {scripts.length}</button>
      <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'is-active' : ''} onClick={() => chooseTab('mine')}>我的 {mineRows.length}</button>
    </div>
    {tab === 'mine' && <small>拖 ⋮⋮ 可以排順序{query ? '（搜尋時不能拖曳，先清掉搜尋）' : ''}；「移除」只是從「我的」拿掉，腳本還在「全部」。</small>}
    {loading && <p role="status">載入腳本中…</p>}
    {error && <p role="alert">{error}，請重新整理清單。</p>}
    <div className="uat-backend-tc-list uat-backend-all-tcs uat-script-library-list">{filtered.map(script => {
      const lr = lastRunText(script.lastRun)
      const info = rowInfo.get(script.id)
      const others = !!info?.others
      return <div className={`uat-script-select-row${dragId === script.id ? ' is-dragging' : ''}`} key={script.id}
        draggable={canDrag}
        onDragStart={e => { if (!canDrag || !script.id) return; setDragId(script.id); e.dataTransfer.effectAllowed = 'move' }}
        onDragOver={e => { if (canDrag && dragId) e.preventDefault() }}
        onDrop={e => { e.preventDefault(); if (canDrag && script.id) dropOn(script.id); else setDragId(null) }}
        onDragEnd={() => setDragId(null)}>
        {tab === 'mine' && <span className={`uat-drag-grip${canDrag ? '' : ' is-off'}`} aria-hidden="true">⋮⋮</span>}
        <input type="checkbox" aria-label={`勾選 ${script.title}`} disabled={disabled || !script.id} checked={selectedIds.includes(script.id || '')} onChange={e => onSelection(e.target.checked ? [...selectedIds, script.id!] : selectedIds.filter(id => id !== script.id))} />
        <button className="uat-backend-tc" disabled={disabled} onClick={() => onOpen(script)}>
          <span title={script.title}>{script.title}</span>
          <em className="has-steps">{script.createdBy ? `${script.createdBy.split('@')[0]} · ` : ''}{script.steps.filter(s => !s.disabled).length} 步 · 綁 {script.bindings.length} TC · <b className={`uat-last-run ${lr.cls}`}>{lr.text}</b>{script.running ? ' · 執行中' : ''}</em>
        </button>
        {tab === 'all' && info?.inMine && <span className="uat-row-tag">已在我的</span>}
        {others && <span className="uat-row-tag">別人的</span>}
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
      </div>
    })}</div>
    {!loading && !error && !filtered.length && <p>{query ? '沒有符合搜尋條件的腳本。' : tab === 'mine' ? '「我的」還沒有腳本。到「全部」勾選後按「加入我的」，或錄製新腳本（會自動加入）。' : '尚無錄製腳本。按「錄製新腳本」，綁定 Lark TC 後開始錄製。'}</p>}
    {/* 1007：全選／清除／動作／已勾幾份擺同一列（跟 H5／PC 一樣）。刪除只在「全部」、移除只在「我的」，都沒有二次確認（使用者決定） */}
    <div className="uat-script-select-bar">
      <button type="button" className="uat-btn is-quiet" disabled={disabled || loading || !filtered.length} onClick={() => onSelection([...new Set([...selectedIds, ...filtered.flatMap(s => s.id ? [s.id] : [])])])}>全選</button>
      <button type="button" className="uat-btn is-quiet" disabled={disabled || !selectedIds.length} onClick={() => onSelection([])}>清除勾選</button>
      {tab === 'all'
        ? <>
            <button type="button" className="uat-btn is-primary" disabled={disabled || busy || !checked.length} onClick={() => void addToMine(checked)}>加入我的</button>
            <button type="button" className="uat-btn is-danger" disabled={disabled || busy || !checked.length} onClick={() => void deleteScripts(checked)}>刪除</button>
          </>
        : <button type="button" className="uat-btn is-quiet" disabled={disabled || busy || !checked.length} onClick={() => void removeFromMine(checked)}>移除</button>}
      <span>已勾 {selectedIds.length} 份</span>
    </div>
    <small>勾選一份即單選，多份依中間清單順序執行。</small>
    {actionMsg && <p role="status" className="uat-inline-hint">{actionMsg}</p>}
  </>
}

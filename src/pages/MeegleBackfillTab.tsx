import { useEffect, useMemo, useState } from 'react'
import './MeegleBatchCreateTab.css'
import './MeegleBatchCommentTab.css'
import './MeegleBackfillTab.css'

/**
 * Meegle 補回填（Jira 頁「Meegle 補回填」分頁）。只做「待補記錄」（使用者 2026-10-02 選 B，不做標題對帳）。
 * 版面：CodeX 2026-10-02 設計圖；v5.7.0 待補清單改成依 Sheet 分組（使用者看樣稿確認：失敗多的時候一大坨分不出來）。
 * 上：待補清單（一份 Sheet 一塊，標題列有筆數、最常見原因、這份全選）；下：逐列結果。
 * 清單規則與補寫都在後端（server/meegle-backfill.ts、routes/meegle-backfill.ts）：補寫交給各工具原本的回填，
 * 執行時後端會再確認那列仍在待補清單、而且是你的（admin 可補全部人的）。
 * 設計：docs/features/28-meegle.md「28f」
 */

type Item = {
  tool: 'create' | 'comment' | 'status' | 'edit'; toolLabel: string; stage: string; batchId: string; rowKey: string; workItemId: string
  sheetLabel: string; sourceKey: string; sheetRow: number; summary: string; owner: string; phase: 'failed' | 'stuck'; message: string | null; lastAt: number
}
type Result = { tool: string; batchId: string; rowKey: string; workItemId: string; ok: boolean; message: string | null }

const ICON_PATHS = {
  refresh: 'M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3',
  info: 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM8 7v4.5M8 4.8v.2',
  clock: 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM8 4.5V8l2.5 1.5',
  warn: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2',
} as const
function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return <svg className="mb-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={ICON_PATHS[name]} /></svg>
}

const key = (i: { tool: string; batchId: string; rowKey: string }) => `${i.tool}:${i.batchId}:${i.rowKey}`
const fmt = (ms: number) => new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
/** 結果分三類（設計圖）：成功／列已變動不寫（略過）／Sheet 失敗。列已變動是回填函式的保護，不是錯誤 */
const resultKind = (r: Result) => r.ok ? 'ok' : /列已變動|不是 #|不在待補清單/.test(r.message ?? '') ? 'skip' : 'bad'
const RESULT_TEXT = { ok: '成功', skip: '列已變動不寫', bad: 'Sheet 失敗' } as const

type Group = { key: string; label: string; items: Item[]; failed: number; stuck: number; lastAt: number; topReason: { text: string; n: number } | null }
/** 依 Sheet 分組：最近有動靜的那份排最上面；每份算出最常見的失敗原因（同一份通常是同一個原因，例如權限被拿掉）。
 *  ⚠️ 分組用完整的來源識別 sourceKey，不用 sheetLabel——那是截短的顯示名稱，兩份 Sheet 撞名時會被合成一組，「這份全選」就選到別份（CodeX review） */
function groupBySheet(items: Item[]): Group[] {
  const m = new Map<string, Item[]>()
  for (const i of items) { const k = i.sourceKey || i.sheetLabel; m.set(k, [...(m.get(k) ?? []), i]) }
  return [...m.entries()].map(([key, list]) => {
    const label = list[0].sheetLabel
    const reasons = new Map<string, number>()
    for (const i of list) if (i.phase === 'failed' && i.message) reasons.set(i.message, (reasons.get(i.message) ?? 0) + 1)
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      key, label, items: [...list].sort((a, b) => a.sheetRow - b.sheetRow),
      failed: list.filter(i => i.phase === 'failed').length, stuck: list.filter(i => i.phase !== 'failed').length,
      lastAt: Math.max(...list.map(i => i.lastAt)), topReason: top ? { text: top[0], n: top[1] } : null,
    }
  }).sort((a, b) => b.lastAt - a.lastAt)
}

export function MeegleBackfillTab() {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [canSeeAll, setCanSeeAll] = useState(false)
  const [toolFilter, setToolFilter] = useState('')
  // 收合狀態：記「使用者手動動過的」，沒動過的照預設（只展開第一份）
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Result[]>([])
  const [ranAt, setRanAt] = useState<number | null>(null)

  async function load(s = scope) {
    setLoading(true); setError('')
    try {
      const r = await fetch(`/api/meegle/backfill/pending${s === 'all' ? '?all=1' : ''}`)
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.message || `HTTP ${r.status}`)
      setItems(j.items); setCanSeeAll(!!j.canSeeAll)
      setSelected(new Set((j.items as Item[]).map(key)))
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const visible = items.filter(i => !toolFilter || i.tool === toolFilter)
  const groups = useMemo(() => groupBySheet(visible), [visible])   // eslint-disable-line react-hooks/exhaustive-deps
  const isOpen = (g: Group, idx: number) => openOverride[g.key] ?? idx === 0
  const toggleSel = (list: Item[], on: boolean) => setSelected(prev => { const n = new Set(prev); list.forEach(i => on ? n.add(key(i)) : n.delete(key(i))); return n })
  const chosen = visible.filter(i => selected.has(key(i)))

  async function run() {
    if (!chosen.length) return
    setRunning(true); setError('')
    try {
      const r = await fetch('/api/meegle/backfill/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: chosen.map(i => ({ tool: i.tool, batchId: i.batchId, rowKey: i.rowKey })) }) })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.message || `HTTP ${r.status}`)
      setResults(j.results); setRanAt(Date.now())
      await load()
    } catch (e) { setError((e as Error).message) } finally { setRunning(false) }
  }

  const tally = { ok: results.filter(r => resultKind(r) === 'ok').length, skip: results.filter(r => resultKind(r) === 'skip').length, bad: results.filter(r => resultKind(r) === 'bad').length }

  return (
    <div className="mb-page mc-page bf-page">
      <section className="mb-card mb-shell">
        <header className="bf-head">
          <h2 className="mb-shell-title">待補清單</h2>
          <span className="bf-count">待補 <b className="bf-n-warn">{visible.length}</b> 筆・<b>{groups.length}</b> 份 Sheet・已選 <b className="bf-n-sel">{chosen.length}</b> 筆</span>
          <button type="button" className="mb-btn mb-btn--outline bf-refresh" disabled={loading} onClick={() => void load()}><Icon name="refresh" /> {loading ? '讀取中…' : '重新整理'}</button>
        </header>
        <p className="mb-hint bf-sub">Meegle 已完成，Sheet 待回填或回填失敗（開單／評論／狀態／修改）</p>
        <div className="bf-filters">
          <select className="mb-select" value={toolFilter} onChange={e => setToolFilter(e.target.value)} aria-label="工具">
            <option value="">工具：全部</option>
            {(['create', 'comment', 'status', 'edit'] as const).map(t => <option key={t} value={t}>工具：{({ create: '開單', comment: '評論', status: '狀態', edit: '修改' })[t]}</option>)}
          </select>
          <div className="bf-scope" role="group" aria-label="範圍">
            <button type="button" className={scope === 'mine' ? 'is-on' : ''} onClick={() => { setScope('mine'); void load('mine') }}>只看我的</button>
            <button type="button" className={scope === 'all' ? 'is-on' : ''} disabled={!canSeeAll} title={canSeeAll ? '' : '只有管理員能看全部人的'} onClick={() => { setScope('all'); void load('all') }}>全部人</button>
          </div>
          {canSeeAll && <span className="mb-badge mb-badge--warn bf-admin">管理員</span>}
        </div>
        <div className="bf-actions">
          <span>已選 <b className="bf-n-sel">{chosen.length}</b> 筆</span>
          <button type="button" className="mb-btn mb-btn--primary mb-btn--big" disabled={!chosen.length || running} onClick={() => void run()}>{running ? '補寫中…' : `補寫回 ${chosen.length} 筆`}</button>
        </div>
        {error && <div className="mb-alert mb-alert--bad"><Icon name="warn" /> {error}</div>}
        <p className="mb-hint bf-group-hint"><Icon name="info" /> 依 Sheet 分組，最近有動靜的排最上面；同一份通常是同一個原因，修好後勾「這份全選」一次補</p>
        <div className="bf-groups">
          {groups.map((g, idx) => {
            const open = isOpen(g, idx)
            const allOn = g.items.every(i => selected.has(key(i)))
            const someOn = !allOn && g.items.some(i => selected.has(key(i)))
            return (
              <div key={g.key} className={`bf-group${open ? ' is-open' : ''}`}>
                <div className="bf-group-head">
                  <button type="button" className="bf-group-toggle" aria-expanded={open} onClick={() => setOpenOverride(o => ({ ...o, [g.key]: !open }))}>
                    <span className="bf-caret" aria-hidden>▾</span>
                    <span className="bf-group-name" title={g.items[0]?.summary}>{g.label}</span>
                    {g.failed > 0 && <span className="mb-badge mb-badge--bad">失敗 {g.failed}</span>}
                    {g.stuck > 0 && <span className="mb-badge bf-badge-pending">待回填 {g.stuck}</span>}
                    {g.topReason && <span className="bf-group-reason">最常見：<b>{g.topReason.text}</b> ×{g.topReason.n}</span>}
                  </button>
                  <span className="bf-group-right">
                    <span className="mb-muted">最近 {fmt(g.lastAt)}</span>
                    <label className="bf-group-all">
                      <input type="checkbox" checked={allOn} ref={el => { if (el) el.indeterminate = someOn }} onChange={e => toggleSel(g.items, e.target.checked)} aria-label={`${g.label} 這份全選`} /> 這份全選
                    </label>
                  </span>
                </div>
                {open && (
                  <div className="mb-table-wrap bf-group-body">
                    <table className="mb-table bf-table">
                      <thead><tr>
                        <th className="mb-col-check"></th>
                        <th>來源／單號</th><th>列號</th><th>處理階段</th><th>回填狀態</th><th>失敗原因</th><th>上次嘗試</th>{scope === 'all' && <th>送出的人</th>}
                      </tr></thead>
                      <tbody>
                        {g.items.map(i => (
                          <tr key={key(i)}>
                            <td className="mb-col-check"><input type="checkbox" checked={selected.has(key(i))} aria-label={`選取 #${i.workItemId}`}
                              onChange={e => toggleSel([i], e.target.checked)} /></td>
                            <td><span className={`bf-tool bf-tool--${i.tool}`}>{i.toolLabel}</span><div className="bf-id">#{i.workItemId}</div></td>
                            <td className="mb-num">第 {i.sheetRow} 列</td>
                            <td>{i.stage}</td>
                            <td>{i.phase === 'failed' ? <span className="mb-badge mb-badge--bad">失敗</span> : <span className="mb-badge bf-badge-pending" title="超過 2 分鐘沒寫成，可能中斷了">待回填</span>}</td>
                            <td className="bf-msg">{i.message || '—'}</td>
                            <td className="mb-num">{fmt(i.lastAt)}</td>
                            {scope === 'all' && <td className="mb-muted">{i.owner}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
          {!groups.length && !loading && <div className="mb-empty bf-empty">沒有待補的列</div>}
        </div>
        <div className="bf-foot"><span className="mb-muted"><Icon name="info" /> 補寫前核對單號與列資料：那一列已經不是這張單就不寫</span><span>已選 <b className="bf-n-sel">{chosen.length}</b> 筆</span></div>
      </section>

      <section className="mb-card mb-shell">
        <header className="bf-head">
          <h2 className="mb-shell-title">逐列結果</h2>
          <span className="mb-badge bf-badge-last">上次執行</span>
          <span className="bf-tally">
            <span className="mb-chip mb-chip--ok is-on">成功 <b>{tally.ok}</b></span>
            <span className="mb-chip bf-chip-skip is-on">略過 <b>{tally.skip}</b></span>
            <span className="mb-chip mb-chip--blocked is-on">失敗 <b>{tally.bad}</b></span>
          </span>
        </header>
        <div className="mb-table-wrap">
          <table className="mb-table">
            <thead><tr><th>單號</th><th>結果</th><th>說明</th></tr></thead>
            <tbody>
              {results.map(r => {
                const k = resultKind(r)
                return (
                  <tr key={key(r)}>
                    <td className="mb-num">#{r.workItemId || r.rowKey}</td>
                    <td><span className={`bf-result bf-result--${k}`}>{RESULT_TEXT[k]}</span></td>
                    <td>{r.ok ? '已補寫處理階段' : r.message}{k === 'bad' ? '，可再補寫' : ''}</td>
                  </tr>
                )
              })}
              {!results.length && <tr><td colSpan={3} className="mb-empty">還沒有執行過</td></tr>}
            </tbody>
          </table>
        </div>
        {ranAt && <div className="bf-ran"><Icon name="clock" /> {fmt(ranAt)}・{results.length} 筆處理完成</div>}
      </section>
    </div>
  )
}

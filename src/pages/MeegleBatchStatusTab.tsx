import { Fragment, useEffect, useMemo, useState } from 'react'
import { getField } from '../features/batch-comment/comment-text'
import { MEEGLE_ID_COLUMN, parseMeegleIdCell } from '../../shared/meegle-comment-rules'
import {
  AUTO_DATE_FIELDS, desiredDate, parseSheetDate, resolveTargetState, STATUS_STAGE_DONE, taipeiDay, TARGET_STATE_COLUMN,
  type DateMode, type StateOption,
} from '../../shared/meegle-status-rules'
import { newStepId } from '../features/uat/step-model'
import './MeegleBatchCreateTab.css'
import './MeegleBatchCommentTab.css'
import './MeegleBatchStatusTab.css'
import { OtherSpaceNotice, useProdConfirm } from '../components/MeegleSpace'
import type { MeegleSpace } from '../../shared/meegle-space'

/**
 * Meegle 批量更新狀態（Jira 頁「Meegle 狀態」分頁）。取代 Jira 批量更新狀態，Sheet 不變。
 * 版面：CodeX 2026-10-02 設計圖（使用者確認 1:1）。① 讀取與選列 → ② 狀態與日期 → ③ 逐列預覽 → ④ 送出結果。
 *
 * - 目標狀態優先序、日期三選一、Sheet 日期解析：shared/meegle-status-rules.ts（後端用同一份）
 * - 轉狀態、等自動化、寫回日期、回填都在後端（server/meegle-status-run.ts），這裡只負責組資料與顯示
 * 設計與踩坑：docs/features/28-meegle.md「28d」
 */

type Rec = Record<string, string> & { _rowIndex: number }
type Phase = 'none' | 'creating' | 'done' | 'failed' | 'skipped'
type StepInfo = { step: string; phase: Phase; message: string | null; attemptAt: number | null; date?: { label: string; original: number | null; desired: number | null; pending: boolean } }
type Current = { status: 'idle' | 'loading' | 'ok' | 'error'; stateKey?: string; stateName?: string; dates?: Record<string, number | null>; error?: string }
type Previous = { batchId: string; workItemId: string; sheetRow: number; summary?: string; mine: boolean; targetName: string; steps: StepInfo[] }
type Result = { rowIndex: number; workItemId: string; summary: string; batchId: string; target: string; steps: StepInfo[]; error?: string; claim?: string }

const ICON_PATHS = {
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1',
  search: 'M7 2.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM10.3 10.3l3.2 3.2',
  warn: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2',
  refresh: 'M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3',
  arrow: 'M3 8h10M9.5 4.5L13 8l-3.5 3.5',
  calendar: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
} as const
function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return <svg className="mb-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={ICON_PATHS[name]} /></svg>
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }))
  if (!r.ok || j.ok === false) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.code })
  return j as T
}

const STEP_LABEL: Record<string, string> = { state: '轉狀態', date: '日期', writeback: 'Sheet 回填' }
const PHASE_TEXT: Record<Phase, string> = { none: '未執行', creating: '處理中', done: '完成', failed: '失敗', skipped: '略過' }
const SOURCE_TEXT = { preview: '預覽', sheet: 'Sheet', default: '預設' } as const
const fmtDay = (ms: number | null | undefined) => (ms == null ? '未設定' : taipeiDay(ms).slice(5).replace('-', '/'))
const rowDone = (steps: StepInfo[]) => steps.length > 0 && steps.every(s => s.phase === 'done' || s.phase === 'skipped')
const datePending = (steps: StepInfo[]) => steps.some(s => s.step === 'date' && s.phase === 'failed' && s.date?.pending)

export function MeegleBatchStatusTab({ space, onBusyChange, initialSheetUrl, onSheetLoaded }: { space: MeegleSpace; onBusyChange?: (busy: boolean) => void; initialSheetUrl: string; onSheetLoaded?: (url: string) => void }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)

  // 共用：狀態清單、單子網址前綴
  const [states, setStates] = useState<StateOption[]>([])
  const [metaError, setMetaError] = useState('')
  const [detailBase, setDetailBase] = useState('')

  // ① 讀取與選列
  const [sheetUrl, setSheetUrl] = useState(initialSheetUrl)
  // 這份 Sheet 已經在另一個空間送過（伺服器回的）；有的話整頁不能送
  const [otherSpace, setOtherSpace] = useState<MeegleSpace | null>(null)
  const [confirmProd, prodModal] = useProdConfirm(space)
  const [loadedUrl, setLoadedUrl] = useState('')
  const [records, setRecords] = useState<Rec[] | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [previous, setPrevious] = useState<Previous[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')

  // ② 狀態與日期
  const [defaultKey, setDefaultKey] = useState('')
  const [targetColumn, setTargetColumn] = useState('')
  const [dateMode, setDateMode] = useState<DateMode>('keep')
  /** 指定日期：每個自動化日期欄各自對應一個 Sheet 欄（key＝Meegle 欄位 key） */
  const [dateColumns, setDateColumns] = useState<Record<string, string>>({})
  /** 指定日期：整批同一天（YYYY-MM-DD）。優先序：該列 Sheet 有填 ＞ 整批同一天 ＞ 退回保留原值（使用者 10/02 要兩種都給） */
  const [dateFixed, setDateFixed] = useState<Record<string, string>>({})

  // ③ 逐列預覽
  const [overrides, setOverrides] = useState<Record<number, string>>({})
  const [currents, setCurrents] = useState<Record<string, Current>>({})
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [focus, setFocus] = useState<number | null>(null)

  // ④ 送出
  const [batchId, setBatchId] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api<{ states: StateOption[]; detailBase: string }>('/api/meegle/status/meta', { space })
      .then(j => { setStates(j.states); setDetailBase(j.detailBase) })
      .catch(e => setMetaError((e as Error).message))
  }, [])

  const autoFields = useMemo(() => [...new Map(Object.values(AUTO_DATE_FIELDS).map(f => [f.field, f])).values()], [])

  // ── ① 讀 Sheet ──
  const rows = useMemo(() => {
    if (!records) return []
    const ids = new Map<string, number>()
    for (const r of records) { const id = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN)); if (id) ids.set(id, (ids.get(id) ?? 0) + 1) }
    return records.map(r => {
      const workItemId = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN))
      const stage = getField(r, '處理階段')
      const block = !workItemId ? '缺 Meegle 單號' : (ids.get(workItemId) ?? 0) > 1 ? '重複單號' : ''
      return { rec: r, rowIndex: r._rowIndex, workItemId: workItemId ?? '', summary: getField(r, '摘要') || getField(r, '標題'), stage, block, prev: workItemId ? previous.find(p => p.workItemId === workItemId) : undefined }
    }).filter(x => x.workItemId || getField(x.rec, MEEGLE_ID_COLUMN).trim())
  }, [records, previous])

  async function loadSheet() {
    if (!sheetUrl.trim()) return
    setLoading(true); setLoadError('')
    try {
      const j = await api<{ records: Rec[]; headers?: string[] }>('/api/lark/sheets/records', { sheetUrl: sheetUrl.trim(), includeCreated: true })
      const prev = await api<{ rows: Previous[]; otherSpace?: MeegleSpace | null }>('/api/meegle/status/previous', { sheetUrl: sheetUrl.trim(), space }).catch(() => ({ rows: [] as Previous[], otherSpace: null }))
      setRecords(j.records); setLoadedUrl(sheetUrl.trim()); setPrevious(prev.rows); setOtherSpace(prev.otherSpace ?? null)
      onSheetLoaded?.(sheetUrl.trim())
      const hs = (j.headers?.length ? j.headers : Object.keys(j.records[0] ?? {})).filter(h => h && h !== '_rowIndex' && !h.endsWith('__url'))
      setHeaders(hs)
      setBatchId(''); setResults([]); setOverrides({}); setCurrents({})
      setTargetColumn(c => c && hs.includes(c) ? c : (hs.includes(TARGET_STATE_COLUMN) ? TARGET_STATE_COLUMN : ''))
      setDateColumns(prevCols => Object.fromEntries(autoFields.map(f => [f.field, prevCols[f.field] && hs.includes(prevCols[f.field]) ? prevCols[f.field] : (hs.find(h => h.includes(f.label)) ?? '')])))
      // 上次沒收尾的（日期待確認、只剩回填）接回 ④
      setResults(prev.rows.filter(p => p.mine && !rowDone(p.steps) && !p.steps.some(s => s.phase === 'creating'))
        .map(p => ({ rowIndex: p.sheetRow, workItemId: p.workItemId, summary: p.summary ?? '', batchId: p.batchId, target: p.targetName, steps: p.steps })))
      // 預設勾選：沒被擋、處理階段不是「已切換狀態」（跟 Jira 版一樣，已處理過的預設不勾）
      const ids = new Map<string, number>()
      for (const r of j.records) { const id = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN)); if (id) ids.set(id, (ids.get(id) ?? 0) + 1) }
      setSelected(new Set(j.records.filter(r => {
        const id = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN))
        return id && ids.get(id) === 1 && getField(r, '處理階段').trim() !== STATUS_STAGE_DONE
      }).map(r => r._rowIndex)))
    } catch (e) { setLoadError((e as Error).message) } finally { setLoading(false) }
  }

  const visibleRows = rows.filter(r => !query.trim() || `${r.workItemId} ${r.summary}`.toLowerCase().includes(query.trim().toLowerCase()))
  const chosen = rows.filter(r => selected.has(r.rowIndex) && !r.block)

  // ── ③ 逐列預覽：讀每張單的目前狀態與日期（同時最多 3 張）──
  async function readCurrent(workItemId: string) {
    setCurrents(c => ({ ...c, [workItemId]: { status: 'loading' } }))
    try {
      const j = await api<{ stateKey: string; stateName: string; dates: Record<string, number | null> }>('/api/meegle/status/current', { workItemId, space })
      setCurrents(c => ({ ...c, [workItemId]: { status: 'ok', stateKey: j.stateKey, stateName: j.stateName, dates: j.dates } }))
    } catch (e) { setCurrents(c => ({ ...c, [workItemId]: { status: 'error', error: (e as Error).message } })) }
  }
  function goPreview() {
    setStep(3)
    setChecked(new Set(chosen.map(r => r.rowIndex)))
    setFocus(chosen[0]?.rowIndex ?? null)
    const queue = chosen.map(r => r.workItemId).filter(id => currents[id]?.status !== 'ok')
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { for (let id = queue.shift(); id; id = queue.shift()) await readCurrent(id) }))
  }

  type Plan = {
    rowIndex: number; workItemId: string; summary: string
    target: ReturnType<typeof resolveTargetState>
    cur: Current; issue: string
    date: { label: string; field: string; original: number | null; expected: string; note: string; sheetMs: number | null } | null
  }
  const plans: Plan[] = chosen.map(r => {
    const target = resolveTargetState({ previewKey: overrides[r.rowIndex] || null, sheetValue: targetColumn ? getField(r.rec, targetColumn) : '', defaultKey: defaultKey || null }, states)
    const cur = currents[r.workItemId] ?? { status: 'idle' }
    let issue = ''
    let date: Plan['date'] = null
    if (!target.ok) issue = target.reason
    else if (cur.status === 'error') issue = cur.error ?? '讀不到 Meegle 現況'
    else if (cur.status !== 'ok') issue = '讀取 Meegle 中'
    if (target.ok) {
      const auto = AUTO_DATE_FIELDS[target.key]
      if (auto) {
        const original = cur.dates?.[auto.field] ?? null
        let sheetMs: number | null = null
        if (dateMode === 'set') {
          const col = dateColumns[auto.field]
          const parsed = parseSheetDate(col ? getField(r.rec, col) : '')
          // Sheet 格式錯就擋列，不退回整批日期（填了卻看不懂＝使用者想要的值我們不知道）
          if (!parsed.ok) issue = issue || parsed.reason
          else if (parsed.ms != null) sheetMs = parsed.ms
          else if (dateFixed[auto.field]) {
            // 整批日期看不懂也擋列（CodeX）：指定了卻默默退回原值＝使用者以為改了其實沒改
            const f = parseSheetDate(dateFixed[auto.field])
            if (!f.ok) issue = issue || `整批${auto.label}：${f.reason}`
            else sheetMs = f.ms
          }
        }
        const want = desiredDate(dateMode, original, sheetMs)
        // 退回保留原值、原值也空白 → 接受自動化帶入今天（不是維持空白——CodeX：預覽要講清楚）
        const expected = dateMode === 'auto' || want == null ? '今天' : fmtDay(want)
        const note = dateMode === 'auto' ? '用自動帶入' : want == null ? '原本空白，用自動帶入' : want === original ? '保留原值' : '指定日期'
        date = { label: auto.label, field: auto.field, original, expected, note, sheetMs }
      }
    }
    return { rowIndex: r.rowIndex, workItemId: r.workItemId, summary: r.summary, target, cur, issue, date }
  })
  const sendable = plans.filter(p => checked.has(p.rowIndex) && !p.issue)
  const blockedCount = plans.filter(p => p.issue && p.cur.status !== 'loading' && p.cur.status !== 'idle').length
  const focusPlan = plans.find(p => p.rowIndex === focus) ?? plans[0]

  // ── ④ 送出（同時最多 3 列：每列可能要等自動化 20 秒）──
  // 送出中、單列重試／繼續送出中都算忙：這時切空間會卸掉畫面，但後端還在寫（CodeX review 025fe7c [P2]）
  const anyRowBusy = Object.values(rowBusy).some(Boolean)
  useEffect(() => { onBusyChange?.(running || anyRowBusy) }, [running, anyRowBusy, onBusyChange])

  async function submit() {
    const list = sendable
    if (!list.length || otherSpace) return
    // 正式空間：每批送出前確認一次（CodeX）
    if (!(await confirmProd({ op: 'Meegle 更新狀態', sheet: loadedUrl, count: list.length }))) return
    const id = batchId || newStepId()
    if (!batchId) setBatchId(id)
    setStep(4); setRunning(true); setProgress({ done: 0, total: list.length })
    const queue = [...list]
    try {
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          const t = p.target as Extract<Plan['target'], { ok: true }>
          let res: Result
          try {
            const j = await api<{ claim: { kind: string }; steps: StepInfo[] }>('/api/meegle/status/row', {
              batchId: id, sheetUrl: loadedUrl, sheetRow: p.rowIndex, summary: p.summary, workItemId: p.workItemId,
              targetKey: t.key, targetName: t.name, dateMode, sheetDate: p.date?.sheetMs ?? null, space,
            })
            res = { rowIndex: p.rowIndex, workItemId: p.workItemId, summary: p.summary, batchId: id, target: t.name, steps: j.steps, claim: j.claim.kind }
          } catch (e) {
            // 請求本身失敗：伺服器那邊可能已經做了；後端紀錄是準的，重新讀 Sheet 會接回
            res = { rowIndex: p.rowIndex, workItemId: p.workItemId, summary: p.summary, batchId: id, target: t.name, steps: [], error: (e as Error).message }
          }
          setResults(prev => [...prev.filter(r => r.workItemId !== p!.workItemId), res])
          setProgress(x => ({ ...x, done: x.done + 1 }))
        }
      }))
    } finally {
      setRunning(false)
      void api('/api/meegle/status/finish', { batchId: id, sheetUrl: loadedUrl }).catch(() => {})
    }
  }

  async function retry(r: Result) {
    setRowBusy(b => ({ ...b, [r.workItemId]: true }))
    try {
      const j = await api<{ steps: StepInfo[] }>('/api/meegle/status/row/retry', { batchId: r.batchId, rowKey: r.workItemId })
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, steps: j.steps, error: undefined } : x))
    } catch (e) {
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, error: (e as Error).message } : x))
    } finally { setRowBusy(b => ({ ...b, [r.workItemId]: false })) }
  }

  // ── 畫面 ──
  const STEPS = [
    { n: 1, label: '讀取與選列' },
    { n: 2, label: '狀態與日期' },
    { n: 3, label: '逐列預覽' },
    { n: 4, label: '送出結果' },
  ] as const
  const canGo = (n: number) => n === 1 || (n === 2 ? chosen.length > 0 : n === 3 ? chosen.length > 0 && step >= 3 : results.length > 0)
  const tally = {
    ok: results.filter(r => rowDone(r.steps)).length,
    pending: results.filter(r => datePending(r.steps)).length,
    bad: results.filter(r => r.error || (r.steps.some(s => s.phase === 'failed') && !datePending(r.steps))).length,
  }
  const stateOptions = states.map(s => <option key={s.key} value={s.key}>{s.name}</option>)

  return (
    <div className="mb-page mc-page ms-page">
      {prodModal}
      <section className="mb-card mb-shell">
        <header className="mb-shell-head">
          <h2 className="mb-shell-title">Meegle 批量更新狀態</h2>
          <span className="mb-shell-sub">{records ? `Lark Sheet ・ ${rows.length} 列` : '尚未讀取 Sheet'}</span>
        </header>

        <nav className="mb-stepper" aria-label="步驟">
          {STEPS.map((s, i) => {
            const state = s.n === step ? 'current' : s.n < step ? 'done' : 'todo'
            return (
              <Fragment key={s.n}>
                {i > 0 && <span className={`mb-step-line${s.n <= step ? ' is-done' : ''}`} />}
                <button type="button" className={`mb-step mb-step--${state}`} disabled={!canGo(s.n) || running} onClick={() => (s.n === 3 && step < 3 ? goPreview() : setStep(s.n))} aria-current={state === 'current' ? 'step' : undefined}>
                  <span className="mb-step-dot">{state === 'done' ? '✓' : state === 'current' ? String(s.n).padStart(2, '0') : '✕'}</span>
                  <span className="mb-step-label">{state === 'current' ? s.label : `${String(s.n).padStart(2, '0')}  ${s.label}`}</span>
                </button>
              </Fragment>
            )
          })}
        </nav>
        {metaError && <div className="mb-alert mb-alert--bad"><Icon name="warn" /> {metaError}</div>}

        {/* ── ① 讀取與選列 ── */}
        {step === 1 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">讀取與選列</h3>
            <div className="mc-loadbar">
              <input className="mb-input" placeholder="https://xxx.larksuite.com/wiki/…?sheet=…" value={sheetUrl}
                onChange={e => setSheetUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void loadSheet() }} />
              <button type="button" className="mb-btn mb-btn--primary" disabled={loading || !sheetUrl.trim()} onClick={() => void loadSheet()}>
                <Icon name="link" /> {loading ? '讀取中…' : records ? '重新讀取 Sheet' : '讀取 Sheet'}
              </button>
            </div>
            {loadError && <div className="mb-alert mb-alert--bad">{loadError}</div>}
            <OtherSpaceNotice other={otherSpace} space={space} />
            <p className="mb-hint">用開單時回填的「{MEEGLE_ID_COLUMN}」欄認單。處理階段已是「{STATUS_STAGE_DONE}」的列預設不勾。</p>
            {records && (
              <>
                <div className="mb-toolbar">
                  <span className="mb-search-wrap"><Icon name="search" /><input className="mb-input" placeholder="搜尋單號或摘要…" value={query} onChange={e => setQuery(e.target.value)} /></span>
                  <span className="mb-muted">已勾選 <b>{chosen.length}</b> 筆</span>
                </div>
                <div className="mb-table-wrap">
                  <table className="mb-table">
                    <thead><tr>
                      <th className="mb-col-check"><input type="checkbox" aria-label="全選"
                        checked={visibleRows.some(r => !r.block) && visibleRows.filter(r => !r.block).every(r => selected.has(r.rowIndex))}
                        onChange={e => setSelected(prev => { const n = new Set(prev); visibleRows.filter(r => !r.block).forEach(r => e.target.checked ? n.add(r.rowIndex) : n.delete(r.rowIndex)); return n })} /></th>
                      <th>列</th><th>Meegle 單號</th><th>摘要</th><th>處理階段</th><th>狀態</th>
                    </tr></thead>
                    <tbody>
                      {visibleRows.map(r => (
                        <tr key={r.rowIndex} className={r.block ? 'is-blocked' : ''}>
                          <td className="mb-col-check"><input type="checkbox" disabled={!!r.block} checked={selected.has(r.rowIndex)} aria-label={`選取第 ${r.rowIndex} 列`}
                            onChange={e => setSelected(prev => { const n = new Set(prev); e.target.checked ? n.add(r.rowIndex) : n.delete(r.rowIndex); return n })} /></td>
                          <td className="mb-num">{r.rowIndex}</td>
                          <td>{r.workItemId ? (detailBase ? <a href={`${detailBase}${r.workItemId}`} target="_blank" rel="noreferrer">#{r.workItemId}</a> : `#${r.workItemId}`) : <span className="mb-muted">{getField(r.rec, MEEGLE_ID_COLUMN)}</span>}</td>
                          <td className="mb-name">{r.summary || <span className="mb-muted">（沒有摘要）</span>}</td>
                          <td>{r.stage || <span className="mb-muted">—</span>}</td>
                          <td>{r.block ? <span className="mb-badge mb-badge--bad">{r.block}</span>
                            : r.prev && datePending(r.prev.steps) ? <span className="mb-badge mb-badge--warn">上次日期待確認</span>
                            : r.stage === STATUS_STAGE_DONE ? <span className="mb-badge mb-badge--pending">已切換過</span>
                            : <span className="mb-badge mb-badge--ok">可更新</span>}</td>
                        </tr>
                      ))}
                      {!visibleRows.length && <tr><td colSpan={6} className="mb-empty">這份 Sheet 沒有帶 Meegle 單號的列</td></tr>}
                    </tbody>
                  </table>
                </div>
                {rows.some(r => r.block === '重複單號') && <div className="mb-alert mb-alert--warn"><Icon name="warn" /> 有兩列指到同一張 Meegle 單，為了不寫錯列，這幾列先不送。請先修 Sheet。</div>}
              </>
            )}
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" disabled={loading || !records} onClick={() => void loadSheet()}><Icon name="refresh" /> 重新讀取 Sheet</button>
              <button type="button" className="mb-btn mb-btn--primary" disabled={!chosen.length} onClick={() => setStep(2)}>下一步</button>
            </div>
          </div>
        )}

        {/* ── ② 狀態與日期 ── */}
        {step === 2 && (
          <div className="mb-pane mb-pane--narrow">
            <h3 className="mb-pane-title">狀態與日期</h3>
            <div className="ms-grid">
              <label className="mb-field"><span>目標狀態（整批預設）</span>
                <select className="mb-select" value={defaultKey} onChange={e => setDefaultKey(e.target.value)}>
                  <option value="">— 不設預設（只用 Sheet 欄）—</option>
                  {stateOptions}
                </select>
              </label>
              <label className="mb-field"><span>Sheet 覆寫欄（每列不同的目標狀態）</span>
                <select className="mb-select" value={targetColumn} onChange={e => setTargetColumn(e.target.value)}>
                  <option value="">— 不使用 —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            </div>
            <p className="mb-hint">優先順序：③ 預覽手改 ＞ Sheet 覆寫欄 ＞ 整批預設。Sheet 填的狀態名對不到 Meegle 狀態的列會擋下，不會猜。</p>

            <div className="ms-date-box">
              <div className="ms-date-head"><Icon name="calendar" /> 日期處理（只影響轉到 C服／完成 時的 上C服時間／上線時間）</div>
              <div className="ms-radios" role="radiogroup" aria-label="日期處理">
                {([['keep', '保留原值', '原本有填就寫回原值；原本空的用自動帶入的今天'], ['auto', '用自動帶入', '交給 Meegle 自動化，填今天'], ['set', '指定日期', 'Sheet 欄有填用它，沒填用整批同一天，都沒有退回保留原值（原值也空白就用自動帶入的今天）']] as const).map(([k, label, hint]) => (
                  <label key={k} className={`ms-radio${dateMode === k ? ' is-on' : ''}`}>
                    <input type="radio" name="ms-date-mode" checked={dateMode === k} onChange={() => setDateMode(k)} />
                    <span><b>{label}</b><small>{hint}</small></span>
                  </label>
                ))}
              </div>
              {dateMode === 'set' && (
                <div className="ms-grid">
                  {autoFields.map(f => (
                    <div key={f.field} className="ms-date-field">
                      <span className="ms-date-label">{f.label}</span>
                      <label className="mb-field"><span>Sheet 欄（每列不同）</span>
                        <select className="mb-select" value={dateColumns[f.field] ?? ''} onChange={e => setDateColumns(c => ({ ...c, [f.field]: e.target.value }))}>
                          <option value="">— 不使用 —</option>
                          {headers.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </label>
                      <label className="mb-field"><span>整批同一天</span>
                        <input type="date" className="mb-input" value={dateFixed[f.field] ?? ''} onChange={e => setDateFixed(c => ({ ...c, [f.field]: e.target.value }))} />
                      </label>
                    </div>
                  ))}
                </div>
              )}
              <p className="mb-hint">Meegle 轉到 C服／完成 後幾秒會把日期改成今天、蓋掉手填值；工具會等它跑完再寫回並讀回確認。看不到它跑完時標「日期待確認」，不會硬寫。</p>
            </div>
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" onClick={() => setStep(1)}>上一步</button>
              <button type="button" className="mb-btn mb-btn--primary" disabled={!chosen.length || !states.length || (!defaultKey && !targetColumn)} onClick={goPreview}>下一步</button>
            </div>
          </div>
        )}

        {/* ── ③ 逐列預覽 ── */}
        {step === 3 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">逐列預覽</h3>
            <div className="ms-preview">
              <div className="mb-table-wrap">
                <table className="mb-table ms-table">
                  <thead><tr>
                    <th className="mb-col-check"><input type="checkbox" aria-label="全選" checked={plans.length > 0 && plans.every(p => checked.has(p.rowIndex))}
                      onChange={e => setChecked(e.target.checked ? new Set(plans.map(p => p.rowIndex)) : new Set())} /></th>
                    <th>單號</th><th>名稱</th><th>目前 → 目標</th><th>來源</th>
                  </tr></thead>
                  <tbody>
                    {plans.map(p => (
                      <tr key={p.rowIndex} className={`${focusPlan?.rowIndex === p.rowIndex ? 'is-focus' : ''}${p.issue && p.cur.status !== 'loading' && p.cur.status !== 'idle' ? ' is-blocked-soft' : ''}`} onClick={() => setFocus(p.rowIndex)}>
                        <td className="mb-col-check" onClick={e => e.stopPropagation()}><input type="checkbox" checked={checked.has(p.rowIndex)} aria-label={`選取 #${p.workItemId}`}
                          onChange={e => setChecked(prev => { const n = new Set(prev); e.target.checked ? n.add(p.rowIndex) : n.delete(p.rowIndex); return n })} /></td>
                        <td className="mb-num">#{p.workItemId}</td>
                        <td className="mb-name">{p.summary || <span className="mb-muted">（沒有摘要）</span>}</td>
                        <td className="ms-transition" onClick={e => e.stopPropagation()}>
                          <span className="ms-from">{p.cur.status === 'ok' ? p.cur.stateName : p.cur.status === 'error' ? '讀不到' : '讀取中…'}</span>
                          <Icon name="arrow" />
                          <select className="mb-select ms-target" value={overrides[p.rowIndex] ?? ''} aria-label={`#${p.workItemId} 目標狀態`}
                            onChange={e => setOverrides(o => ({ ...o, [p.rowIndex]: e.target.value }))}>
                            <option value="">{p.target.ok && p.target.source !== 'preview' ? p.target.name : '（未決定）'}</option>
                            {stateOptions}
                          </select>
                        </td>
                        <td>{p.issue && p.cur.status !== 'loading' && p.cur.status !== 'idle'
                          ? <span className="mb-badge mb-badge--bad" title={p.issue}>{p.target.ok ? (p.cur.status === 'error' ? '讀不到' : '日期格式錯') : '狀態對不到'}</span>
                          : p.target.ok ? <span className={`mb-badge ms-src ms-src--${p.target.source}`}>{SOURCE_TEXT[p.target.source]}</span> : <span className="mb-muted">—</span>}
                          {p.target.ok && p.cur.status === 'ok' && p.cur.stateKey === p.target.key && <span className="mb-badge mb-badge--pending ms-same">已是目標</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {focusPlan && (
                <section className="mc-panel ms-detail">
                  <div className="mc-panel-head">單列詳情 <span className="mb-muted">#{focusPlan.workItemId}</span></div>
                  <div className="ms-detail-trans">
                    <b>{focusPlan.cur.status === 'ok' ? focusPlan.cur.stateName : '…'}</b><Icon name="arrow" /><b>{focusPlan.target.ok ? focusPlan.target.name : '未決定'}</b>
                  </div>
                  {focusPlan.date ? (
                    <div className="ms-detail-date">
                      <span className="mb-muted">{focusPlan.date.label}</span>
                      <div className="ms-detail-vals"><b>{focusPlan.cur.status === 'ok' ? fmtDay(focusPlan.date.original) : '…'}</b><Icon name="arrow" /><b>{focusPlan.date.expected}</b></div>
                      <small className="mb-muted">原值 → 預計值（{focusPlan.date.note}）</small>
                    </div>
                  ) : focusPlan.target.ok && <div className="mb-muted ms-detail-none">這個狀態不會動到日期欄</div>}
                  {focusPlan.issue && focusPlan.cur.status !== 'loading' && focusPlan.cur.status !== 'idle' && <div className="mb-hint mb-hint--warn"><Icon name="warn" /> {focusPlan.issue}</div>}
                  {focusPlan.cur.status === 'error' && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => void readCurrent(focusPlan.workItemId)}><Icon name="refresh" /> 重讀</button>}
                  {detailBase && <a className="mb-btn mb-btn--small mb-btn--outline" href={`${detailBase}${focusPlan.workItemId}`} target="_blank" rel="noreferrer">在 Meegle 開啟</a>}
                </section>
              )}
            </div>
            <footer className="mb-foot ms-foot">
              <button type="button" className="mb-btn mb-btn--outline mb-btn--wide" onClick={() => setStep(2)}>上一步</button>
              <span className="mb-foot-sum">已選 <b className="ms-n-sel">{checked.size}</b> ／ 可送 <b className="ms-n-ok">{sendable.length}</b> ／ 受阻 <b className="ms-n-bad">{blockedCount}</b></span>
              <button type="button" className="mb-btn mb-btn--primary mb-btn--big" disabled={!sendable.length || running || !!otherSpace} onClick={() => void submit()}>前往送出</button>
            </footer>
          </div>
        )}

        {/* ── ④ 送出結果 ── */}
        {step === 4 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">送出結果</h3>
            <div className="mb-chips mb-tally">
              <span className="mb-chip mb-chip--ok is-on">全部完成 <b>{tally.ok}</b></span>
              <span className="mb-chip ms-chip--pending is-on">日期待確認 <b>{tally.pending}</b></span>
              <span className="mb-chip mb-chip--blocked is-on">有失敗 <b>{tally.bad}</b></span>
            </div>
            <div className="mb-results">
              {results.map(r => {
                const failed = r.steps.filter(s => s.phase === 'failed')
                const pending = datePending(r.steps)
                const onlyDate = failed.length > 0 && failed.every(s => s.step === 'date')
                const onlyWb = failed.length > 0 && failed.every(s => s.step === 'writeback')
                return (
                  <div key={`${r.batchId}:${r.workItemId}`} className="mb-result">
                    <div className="mb-result-main">
                      <div className="mb-result-name">{r.summary || `第 ${r.rowIndex} 列`} <span className="mb-muted">→ {r.target}</span></div>
                      <div className="mb-result-sub">
                        <span>#{r.workItemId}</span>
                        {r.steps.map(s => (
                          <span key={s.step} className={`mc-step mc-step--${s.step === 'date' && s.phase === 'failed' && s.date?.pending ? 'unknown' : s.phase}`} title={s.message ?? ''}>
                            {STEP_LABEL[s.step] ?? s.step}：{s.step === 'date' && s.phase === 'creating' ? '等待自動化' : s.step === 'date' && s.phase === 'failed' && s.date?.pending ? '待確認' : PHASE_TEXT[s.phase]}
                            {s.step === 'date' && s.date && s.phase === 'done' ? `（${s.date.label} ${fmtDay(s.date.desired)}）` : ''}
                          </span>
                        ))}
                        {pending && <span className="mb-badge mb-badge--warn">日期待確認</span>}
                        {r.claim && r.claim !== 'claimed' && <span className="mb-badge mb-badge--warn">{({ busy: '另一個分頁正在送這張單', 'not-owner': '別人送出的列', 'source-mismatch': '批次的 Sheet 不同', 'target-changed': '這批已用別的目標送過，請重新讀取 Sheet 開新批次' } as Record<string, string>)[r.claim] ?? r.claim}</span>}
                        {r.error && <span className="mb-msg">{r.error}</span>}
                        {failed.filter(s => s.message).map(s => <span key={`m-${s.step}`} className="mb-msg">{STEP_LABEL[s.step] ?? s.step}：{s.message}</span>)}
                      </div>
                    </div>
                    <div className="mb-result-actions">
                      {failed.length > 0 && (
                        <button type="button" className={`mb-btn mb-btn--small ${onlyDate ? 'mb-btn--outline ms-btn-date' : 'mb-btn--outline'}`} disabled={rowBusy[r.workItemId]} onClick={() => void retry(r)}>
                          {rowBusy[r.workItemId] ? '處理中…' : onlyDate ? '只補日期' : onlyWb ? '補寫回' : '重試'}
                        </button>
                      )}
                      {detailBase && <a className="mb-btn mb-btn--small mb-btn--outline" href={`${detailBase}${r.workItemId}`} target="_blank" rel="noreferrer">開啟</a>}
                    </div>
                  </div>
                )
              })}
              {!results.length && <div className="mb-muted mb-empty">還沒有送出結果</div>}
            </div>
            <div className="mb-done-line"><span>處理完成 <b>{progress.done}</b> / {progress.total || results.length}</span></div>
            <div className="dashboard-bar-track mb-progress-track"><span className="dashboard-bar-fill" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : (results.length ? 100 : 0)}%` }} /></div>
            <div className="mb-done-note">轉狀態成功、日期完成或略過，才會回填 Sheet「{STATUS_STAGE_DONE}」。「只補日期」沿用第一次讀到的原值。</div>
          </div>
        )}
      </section>
    </div>
  )
}

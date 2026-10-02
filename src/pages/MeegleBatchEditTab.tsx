import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { getField } from '../features/batch-comment/comment-text'
import { MEEGLE_ID_COLUMN, parseMeegleIdCell } from '../../shared/meegle-comment-rules'
import { EDIT_FIELDS, EDIT_STAGE_DONE, rawEditsForRow, type FieldMode, type Option, type RawEdit } from '../../shared/meegle-edit-rules'
import { newStepId } from '../features/uat/step-model'
import type { UploadedAttachment } from '../lib/jiraAttachmentUpload'
import './MeegleBatchCreateTab.css'
import './MeegleBatchCommentTab.css'
import './MeegleBatchStatusTab.css'
import './MeegleBatchEditTab.css'

/**
 * Meegle 批量修改（Jira 頁「Meegle 修改」分頁）。取代 Jira 批量修改，Sheet 不變。
 * 版面：CodeX 2026-10-02 設計圖（使用者確認 1:1）。① 讀取與選列 → ② 欄位與人員 → ③ 預覽 → ④ 送出結果。
 *
 * - 每欄四選一（不修改／Sheet 欄／固定值／明確清空）與「Sheet 空白＝不改」：shared/meegle-edit-rules.ts（後端用同一份）
 * - **預覽由後端算**（/api/meegle/edit/preview）：回原值→新值、擋列原因、planHash；送出帶 planHash，後端重算不同就要求重新預覽
 * - 單列修改（✎）只改這一列，蓋過 ② 的設定
 * 設計與踩坑：docs/features/28-meegle.md「28e」
 */

type Rec = Record<string, string> & { _rowIndex: number }
type Phase = 'none' | 'creating' | 'done' | 'failed' | 'skipped'
type StepInfo = { step: string; phase: Phase; message: string | null; attemptAt: number | null }
type Att = UploadedAttachment & { error?: string }
type Change = { key: string; from: string; to: string; same: boolean; error?: string }
type Preview = { status: 'idle' | 'loading' | 'ok' | 'error'; error?: string; issues?: string[]; changes?: Change[]; planHash?: string; baseline?: Record<string, string | string[]> }
type RowAtt = { loading: boolean; images: Att[]; error: string; skip: boolean }
type Result = { rowIndex: number; workItemId: string; summary: string; batchId: string; steps: StepInfo[]; error?: string; claim?: string }
type Previous = { batchId: string; workItemId: string; sheetRow: number; summary?: string; mine: boolean; steps: StepInfo[] }
type Person = { alias: string; name: string; email: string }

const ICON_PATHS = {
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1',
  search: 'M7 2.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM10.3 10.3l3.2 3.2',
  warn: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2',
  refresh: 'M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3',
  arrow: 'M3 8h10M9.5 4.5L13 8l-3.5 3.5',
  edit: 'M10.5 2.5l3 3-7.5 7.5h-3v-3z',
  check: 'M3.5 8.5l3 3 6-7',
  close: 'M4 4l8 8M12 4l-8 8',
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

const STEP_LABEL: Record<string, string> = { fields: '欄位（含圖片）', roles: '角色', verify: '讀回確認', writeback: 'Sheet 回填' }
const PHASE_TEXT: Record<Phase, string> = { none: '未執行', creating: '處理中', done: '完成', failed: '失敗', skipped: '略過' }
const MODE_LABEL = { skip: '不修改', sheet: 'Sheet 欄', fixed: '固定值', clear: '明確清空' } as const
const GROUPS = [...new Set(EDIT_FIELDS.map(f => f.group))]
const labelOf = (key: string) => EDIT_FIELDS.find(f => f.key === key)?.label ?? key
const rowDone = (steps: StepInfo[]) => steps.length > 0 && steps.every(s => s.phase === 'done' || s.phase === 'skipped')
const splitNames = (s: string) => s.split(/[,，、\n]/).map(x => x.trim()).filter(Boolean)
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

export function MeegleBatchEditTab({ initialSheetUrl }: { initialSheetUrl: string }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [options, setOptions] = useState<Record<string, Option[]>>({})
  const [people, setPeople] = useState<Person[]>([])
  const [metaError, setMetaError] = useState('')
  const [detailBase, setDetailBase] = useState('')

  // ① 讀取與選列
  const [sheetUrl, setSheetUrl] = useState(initialSheetUrl)
  const [loadedUrl, setLoadedUrl] = useState('')
  const [records, setRecords] = useState<Rec[] | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [previous, setPrevious] = useState<Previous[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')

  // ② 欄位與人員
  const [modes, setModes] = useState<Record<string, FieldMode>>({})
  const [imageColumn, setImageColumn] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({})   // 對不到的名字 → 選的人的 email
  const [mapBusy, setMapBusy] = useState('')
  const [mapError, setMapError] = useState('')

  // ③ 預覽
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [focus, setFocus] = useState<number | null>(null)
  const [previews, setPreviews] = useState<Record<number, Preview>>({})
  const [atts, setAtts] = useState<Record<number, RowAtt>>({})
  /** 單列修改：只改這一列，蓋過 ② 的設定（key＝欄位 key） */
  const [overrides, setOverrides] = useState<Record<number, Record<string, RawEdit | null>>>({})
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null)

  // ④ 送出
  const [batchId, setBatchId] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})
  const previewSeq = useRef<Record<number, number>>({})

  useEffect(() => {
    api<{ options: Record<string, Option[]>; people: Person[]; detailBase: string }>('/api/meegle/edit/meta', {})
      .then(j => { setOptions(j.options); setPeople(j.people); setDetailBase(j.detailBase) })
      .catch(e => setMetaError((e as Error).message))
  }, [])

  // ── ① ──
  const rows = useMemo(() => {
    if (!records) return []
    const ids = new Map<string, number>()
    for (const r of records) { const id = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN)); if (id) ids.set(id, (ids.get(id) ?? 0) + 1) }
    return records.map(r => {
      const workItemId = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN)) ?? ''
      const block = !workItemId ? '缺 Meegle 單號' : (ids.get(workItemId) ?? 0) > 1 ? '重複單號' : ''
      return { rec: r, rowIndex: r._rowIndex, workItemId, summary: getField(r, '摘要') || getField(r, '標題'), stage: getField(r, '處理階段'), block, prev: previous.find(p => p.workItemId === workItemId) }
    }).filter(x => x.workItemId || getField(x.rec, MEEGLE_ID_COLUMN).trim())
  }, [records, previous])

  async function loadSheet() {
    if (!sheetUrl.trim()) return
    setLoading(true); setLoadError('')
    try {
      const j = await api<{ records: Rec[]; headers?: string[] }>('/api/lark/sheets/records', { sheetUrl: sheetUrl.trim(), includeCreated: true })
      const prev = await api<{ rows: Previous[] }>('/api/meegle/edit/previous', { sheetUrl: sheetUrl.trim() }).catch(() => ({ rows: [] as Previous[] }))
      setRecords(j.records); setLoadedUrl(sheetUrl.trim()); setPrevious(prev.rows)
      const hs = (j.headers?.length ? j.headers : Object.keys(j.records[0] ?? {})).filter(h => h && h !== '_rowIndex' && !h.endsWith('__url'))
      setHeaders(hs)
      setBatchId(''); setPreviews({}); setAtts({}); setOverrides({})
      setResults(prev.rows.filter(p => p.mine && !rowDone(p.steps) && !p.steps.some(s => s.phase === 'creating'))
        .map(p => ({ rowIndex: p.sheetRow, workItemId: p.workItemId, summary: p.summary ?? '', batchId: p.batchId, steps: p.steps })))
      const ids = new Map<string, number>()
      for (const r of j.records) { const id = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN)); if (id) ids.set(id, (ids.get(id) ?? 0) + 1) }
      // 預設勾選：沒被擋、處理階段不是「已修改欄位」（跟 Jira 版一樣，改過的預設不勾）
      setSelected(new Set(j.records.filter(r => { const id = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN)); return id && ids.get(id) === 1 && getField(r, '處理階段').trim() !== EDIT_STAGE_DONE }).map(r => r._rowIndex)))
    } catch (e) { setLoadError((e as Error).message) } finally { setLoading(false) }
  }
  const visibleRows = rows.filter(r => !query.trim() || `${r.workItemId} ${r.summary}`.toLowerCase().includes(query.trim().toLowerCase()))
  const chosen = rows.filter(r => selected.has(r.rowIndex) && !r.block)

  // ── ② 人員對照：選到的列裡，角色欄對不到的名字 ──
  const knownAliases = useMemo(() => new Set(people.map(p => norm(p.alias))), [people])
  const unmapped = useMemo(() => {
    const names = new Set<string>()
    for (const r of chosen) for (const e of rawEditsForRow(r.rec, modes)) if (e.key.startsWith('role:') && e.op === 'set') for (const n of splitNames(e.raw)) if (!knownAliases.has(norm(n))) names.add(n)
    return [...names]
  }, [chosen, modes, knownAliases])
  async function mapPerson(alias: string) {
    const email = mapping[alias]
    if (!email) return
    setMapBusy(alias); setMapError('')
    try {
      await api('/api/meegle/batch/people/verify', { alias, email })
      setPeople(p => [...p, { alias: norm(alias), name: people.find(x => x.email === email)?.name ?? email, email }])
    } catch (e) { setMapError(`${alias}：${(e as Error).message}`) } finally { setMapBusy('') }
  }

  // ── ③ 預覽 ──
  const rawsFor = (r: typeof rows[number]): RawEdit[] => {
    const base = rawEditsForRow(r.rec, modes)
    const ov = overrides[r.rowIndex] ?? {}
    const out = base.filter(e => !(e.key in ov))
    for (const v of Object.values(ov)) if (v) out.push(v)
    return out
  }
  /** 回傳載到的圖片：呼叫端接著算預覽要用（planHash 含圖片內容 hash），不能等 state 更新 */
  async function loadImages(rowIndex: number): Promise<Att[]> {
    const r = rows.find(x => x.rowIndex === rowIndex)
    if (!r || !imageColumn) { setAtts(a => ({ ...a, [rowIndex]: { loading: false, images: [], error: '', skip: false } })); return [] }
    setAtts(a => ({ ...a, [rowIndex]: { ...(a[rowIndex] ?? { images: [], error: '', skip: false }), loading: true } }))
    const colIdx = headers.indexOf(imageColumn)
    let letter = ''
    for (let i = colIdx + 1; i > 0; i = Math.floor((i - 1) / 26)) letter = String.fromCharCode(65 + (i - 1) % 26) + letter
    const src = r.rec[`${imageColumn}__url`] || getField(r.rec, imageColumn)
    try {
      const d = await api<{ result?: Array<{ rowIndex: number; attachments: Att[] }> }>('/api/jira/attachment-prefetch', { groups: [{ rowIndex, urls: src ? src.split(/[\n,]/).map(x => x.trim()).filter(Boolean) : [] }], larkSheetContext: colIdx >= 0 ? { sheetUrl: loadedUrl, columnLetter: letter } : undefined })
      const list = d.result?.find(g => g.rowIndex === rowIndex)?.attachments ?? []
      const bad = list.filter(x => x.error || !x.cacheId)
      const images = list.filter(x => x.cacheId && !x.error && x.isImage)
      setAtts(a => ({ ...a, [rowIndex]: { loading: false, skip: false, images, error: bad.length ? `${bad.length} 張圖沒載到：${bad.map(x => x.filename).join('、')}` : '' } }))
      return images
    } catch (e) { setAtts(a => ({ ...a, [rowIndex]: { loading: false, skip: false, images: [], error: `圖片載入失敗：${(e as Error).message}` } })); return [] }
  }
  async function loadPreview(rowIndex: number, imgs?: Att[]) {
    const r = rows.find(x => x.rowIndex === rowIndex)
    if (!r) return
    const seq = (previewSeq.current[rowIndex] ?? 0) + 1
    previewSeq.current[rowIndex] = seq
    setPreviews(p => ({ ...p, [rowIndex]: { ...(p[rowIndex] ?? {}), status: 'loading' } }))
    try {
      const images = (imgs ?? atts[rowIndex]?.images ?? []).map(a => ({ cacheId: a.cacheId, name: a.filename }))
      const j = await api<{ issues: string[]; changes: Change[]; planHash: string; baseline: Record<string, string | string[]> }>('/api/meegle/edit/preview', { workItemId: r.workItemId, raws: rawsFor(r), images })
      if (previewSeq.current[rowIndex] !== seq) return   // 晚回的舊預覽不蓋新的
      setPreviews(p => ({ ...p, [rowIndex]: { status: 'ok', issues: j.issues, changes: j.changes, planHash: j.planHash, baseline: j.baseline } }))
    } catch (e) {
      if (previewSeq.current[rowIndex] !== seq) return
      setPreviews(p => ({ ...p, [rowIndex]: { status: 'error', error: (e as Error).message } }))
    }
  }
  async function goPreview() {
    setStep(3)
    setChecked(new Set(chosen.map(r => r.rowIndex)))
    setFocus(chosen[0]?.rowIndex ?? null)
    const queue = [...chosen]
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const imgs = imageColumn ? await loadImages(r.rowIndex) : []
        await loadPreview(r.rowIndex, imgs)
      }
    }))
  }

  const issueOf = (rowIndex: number): string => {
    const p = previews[rowIndex]
    const a = atts[rowIndex]
    if (!p || p.status === 'idle' || p.status === 'loading') return '讀取中'
    if (a?.loading) return '圖片載入中'
    if (p.status === 'error') return p.error ?? '讀不到 Meegle 現況'
    if (p.issues?.length) return p.issues.join('；')
    if (a?.error && !a.skip) return a.error
    if (!p.changes?.length && !(a?.images.length)) return '沒有要改的欄位'
    return ''
  }
  const plans = chosen.map(r => ({ r, issue: issueOf(r.rowIndex) }))
  const sendable = plans.filter(p => checked.has(p.r.rowIndex) && !p.issue)
  const blocked = plans.filter(p => p.issue && p.issue !== '讀取中' && p.issue !== '圖片載入中')
  const focusRow = chosen.find(r => r.rowIndex === focus) ?? chosen[0]

  function setOverride(rowIndex: number, key: string, edit: RawEdit | null | undefined) {
    setOverrides(o => {
      const cur = { ...(o[rowIndex] ?? {}) }
      if (edit === undefined) delete cur[key]; else cur[key] = edit
      return { ...o, [rowIndex]: cur }
    })
  }
  // 單列修改後重新預覽那一列
  useEffect(() => {
    if (step === 3 && focusRow && overrides[focusRow.rowIndex]) void loadPreview(focusRow.rowIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides])

  // ── ④ 送出（同時最多 2 列）──
  async function submit() {
    const list = sendable
    if (!list.length) return
    const id = batchId || newStepId()
    if (!batchId) setBatchId(id)
    setStep(4); setRunning(true); setProgress({ done: 0, total: list.length })
    const queue = [...list]
    try {
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          const r = p.r
          const pv = previews[r.rowIndex]
          const a = atts[r.rowIndex]
          let res: Result
          try {
            const j = await api<{ claim: { kind: string; message?: string }; steps: StepInfo[] }>('/api/meegle/edit/row', {
              batchId: id, sheetUrl: loadedUrl, sheetRow: r.rowIndex, summary: r.summary, workItemId: r.workItemId,
              raws: rawsFor(r), images: (a?.images ?? []).map(x => ({ cacheId: x.cacheId, name: x.filename })),
              baseline: pv?.baseline ?? {}, planHash: pv?.planHash,
            })
            res = { rowIndex: r.rowIndex, workItemId: r.workItemId, summary: r.summary, batchId: id, steps: j.steps, claim: j.claim.kind }
          } catch (e) {
            res = { rowIndex: r.rowIndex, workItemId: r.workItemId, summary: r.summary, batchId: id, steps: [], error: (e as Error).message }
          }
          setResults(prev => [...prev.filter(x => x.workItemId !== r.workItemId), res])
          setProgress(x => ({ ...x, done: x.done + 1 }))
        }
      }))
    } finally {
      setRunning(false)
      void api('/api/meegle/edit/finish', { batchId: id, sheetUrl: loadedUrl }).catch(() => {})
    }
  }
  async function retry(r: Result) {
    setRowBusy(b => ({ ...b, [r.workItemId]: true }))
    try {
      const j = await api<{ steps: StepInfo[] }>('/api/meegle/edit/row/retry', { batchId: r.batchId, rowKey: r.workItemId })
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, steps: j.steps, error: undefined } : x))
    } catch (e) {
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, error: (e as Error).message } : x))
    } finally { setRowBusy(b => ({ ...b, [r.workItemId]: false })) }
  }

  // ── 畫面 ──
  const STEPS = [{ n: 1, label: '讀取與選列' }, { n: 2, label: '欄位與人員' }, { n: 3, label: '預覽' }, { n: 4, label: '送出結果' }] as const
  const canGo = (n: number) => n === 1 || (n === 2 ? chosen.length > 0 : n === 3 ? chosen.length > 0 && step >= 3 : results.length > 0)
  const tally = { ok: results.filter(r => rowDone(r.steps)).length, bad: results.filter(r => r.error || r.steps.some(s => s.phase === 'failed')).length }
  const modeOf = (key: string): FieldMode => modes[key] ?? { mode: 'skip' }
  const setMode = (key: string, m: FieldMode) => setModes(x => ({ ...x, [key]: m }))
  const activeCount = EDIT_FIELDS.filter(f => modeOf(f.key).mode !== 'skip').length + (imageColumn ? 1 : 0)

  /** 固定值輸入框。是函式不是元件：寫成元件每次 render 都會重新掛載，打一個字就失焦 */
  function fixedInput(fkey: string) {
    const f = EDIT_FIELDS.find(x => x.key === fkey)!
    const m = modeOf(fkey)
    const value = m.mode === 'fixed' ? m.value : ''
    const onChange = (v: string) => setMode(fkey, { mode: 'fixed', value: v })
    if (f.kind === 'select') return (
      <select className="mb-select" value={value} onChange={e => onChange(e.target.value)} aria-label={`${f.label} 固定值`}>
        <option value="">— 選擇 —</option>
        {(options[fkey] ?? []).map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
      </select>
    )
    if (f.kind === 'date') return <input type="date" className="mb-input" value={value.replace(/\//g, '-')} onChange={e => onChange(e.target.value)} aria-label={`${f.label} 固定值`} />
    if (f.kind === 'multi') return <textarea className="mb-input me-fixed-text" rows={2} value={value} onChange={e => onChange(e.target.value)} aria-label={`${f.label} 固定值`} />
    return <input className="mb-input" value={value} placeholder={f.kind === 'role' ? '人名，多人用逗號分隔' : ''} onChange={e => onChange(e.target.value)} aria-label={`${f.label} 固定值`} />
  }

  const pv = focusRow ? previews[focusRow.rowIndex] : undefined
  const fa = focusRow ? atts[focusRow.rowIndex] : undefined
  const focusIssue = focusRow ? issueOf(focusRow.rowIndex) : ''

  return (
    <div className="mb-page mc-page ms-page me-page">
      <section className="mb-card mb-shell">
        <header className="mb-shell-head">
          <h2 className="mb-shell-title">Meegle 批量修改</h2>
          <span className="mb-shell-sub">{records ? `Lark Sheet ・ ${rows.length} 列` : '尚未讀取 Sheet'}</span>
        </header>
        <nav className="mb-stepper" aria-label="步驟">
          {STEPS.map((s, i) => {
            const state = s.n === step ? 'current' : s.n < step ? 'done' : 'todo'
            return (
              <Fragment key={s.n}>
                {i > 0 && <span className={`mb-step-line${s.n <= step ? ' is-done' : ''}`} />}
                <button type="button" className={`mb-step mb-step--${state}`} disabled={!canGo(s.n) || running} onClick={() => setStep(s.n)} aria-current={state === 'current' ? 'step' : undefined}>
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
              <input className="mb-input" placeholder="https://xxx.larksuite.com/wiki/…?sheet=…" value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void loadSheet() }} />
              <button type="button" className="mb-btn mb-btn--primary" disabled={loading || !sheetUrl.trim()} onClick={() => void loadSheet()}><Icon name="link" /> {loading ? '讀取中…' : records ? '重新讀取' : '讀取資料'}</button>
            </div>
            {loadError && <div className="mb-alert mb-alert--bad">{loadError}</div>}
            <p className="mb-hint">用開單時回填的「{MEEGLE_ID_COLUMN}」欄認單。處理階段已是「{EDIT_STAGE_DONE}」的列預設不勾。</p>
            {records && (
              <>
                <div className="mb-toolbar">
                  <span className="mb-search-wrap"><Icon name="search" /><input className="mb-input" placeholder="搜尋單號或摘要…" value={query} onChange={e => setQuery(e.target.value)} /></span>
                  <span className="mb-muted">已讀取 <b>{rows.length}</b> 列・已勾選 <b>{chosen.length}</b> 列</span>
                </div>
                <div className="mb-table-wrap">
                  <table className="mb-table">
                    <thead><tr>
                      <th className="mb-col-check"><input type="checkbox" aria-label="全選" checked={visibleRows.some(r => !r.block) && visibleRows.filter(r => !r.block).every(r => selected.has(r.rowIndex))}
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
                            : r.prev && !rowDone(r.prev.steps) ? <span className="mb-badge mb-badge--warn">上次有失敗</span>
                            : r.stage === EDIT_STAGE_DONE ? <span className="mb-badge mb-badge--pending">已改過</span>
                            : <span className="mb-badge mb-badge--ok">可修改</span>}</td>
                        </tr>
                      ))}
                      {!visibleRows.length && <tr><td colSpan={6} className="mb-empty">這份 Sheet 沒有帶 Meegle 單號的列</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" disabled={loading || !records} onClick={() => void loadSheet()}><Icon name="refresh" /> 重新讀取</button>
              <button type="button" className="mb-btn mb-btn--primary" disabled={!chosen.length} onClick={() => setStep(2)}>下一步</button>
            </div>
          </div>
        )}

        {/* ── ② 欄位與人員 ── */}
        {step === 2 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">欄位與人員</h3>
            <p className="mb-hint">每欄四選一。<b>Sheet 欄模式下，該列空白＝這欄不改</b>（不是清空）；要清空請選「明確清空」。任何一欄換不出 Meegle 的值（選項對不到、人員沒對照、日期看不懂）→ 整列擋下，不送半套。</p>
            <div className="me-groups">
              {GROUPS.map(g => (
                <section key={g} className="me-group">
                  <div className="me-group-title">{g}</div>
                  {EDIT_FIELDS.filter(f => f.group === g).map(f => {
                    const m = modeOf(f.key)
                    return (
                      <div key={f.key} className="me-field">
                        <span className="me-field-label">{f.label}</span>
                        <select className="mb-select me-mode" value={m.mode} aria-label={`${f.label} 怎麼改`}
                          onChange={e => { const v = e.target.value as FieldMode['mode']; setMode(f.key, v === 'sheet' ? { mode: 'sheet', column: headers.find(h => h.trim() === f.label) ?? '' } : v === 'fixed' ? { mode: 'fixed', value: '' } : { mode: v } as FieldMode) }}>
                          {(['skip', 'sheet', 'fixed', 'clear'] as const).filter(k => k !== 'clear' || f.clearable).map(k => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}
                        </select>
                        <span className="me-field-value">
                          {m.mode === 'sheet' && (
                            <select className="mb-select" value={m.column} aria-label={`${f.label} Sheet 欄`} onChange={e => setMode(f.key, { mode: 'sheet', column: e.target.value })}>
                              <option value="">— 選擇欄位 —</option>
                              {headers.map(h => <option key={h} value={h}>{h}</option>)}
                            </select>
                          )}
                          {m.mode === 'fixed' && fixedInput(f.key)}
                          {m.mode === 'clear' && <span className="me-clear-note">送出會把這欄清空</span>}
                        </span>
                      </div>
                    )
                  })}
                  {g === '描述與圖片' && (
                    <div className="me-field">
                      <span className="me-field-label">圖片</span>
                      <span className="me-mode me-mode--static">Sheet 欄</span>
                      <span className="me-field-value">
                        <select className="mb-select" value={imageColumn} aria-label="圖片 Sheet 欄" onChange={e => setImageColumn(e.target.value)}>
                          <option value="">— 不帶圖片 —</option>
                          {headers.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </span>
                    </div>
                  )}
                </section>
              ))}
            </div>
            <p className="mb-hint">圖片接在描述最後面：沒改描述文字 → 原本的描述（含舊圖）保留、新圖接在後面；有改描述 → 新文字＋新圖，原本的圖不保留（描述是整格覆寫）。</p>

            <section className="me-people">
              <div className="me-group-title">人員對照</div>
              {!unmapped.length && <div className="mb-muted">選到的列裡，角色欄的名字都有對照。</div>}
              {unmapped.map(n => (
                <div key={n} className="me-person">
                  <span className="me-person-name">{n}</span><Icon name="arrow" /><span className="me-person-miss">未找到人員</span>
                  <select className="mb-select" value={mapping[n] ?? ''} aria-label={`${n} 對照到`} onChange={e => setMapping(x => ({ ...x, [n]: e.target.value }))}>
                    <option value="">選擇人員</option>
                    {[...new Map(people.map(p => [p.email, p])).values()].map(p => <option key={p.email} value={p.email}>{p.name}（{p.email}）</option>)}
                  </select>
                  <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={!mapping[n] || mapBusy === n} onClick={() => void mapPerson(n)}>{mapBusy === n ? '對照中…' : '建立對照'}</button>
                </div>
              ))}
              {unmapped.length > 0 && <p className="mb-hint">清單只有已經對照過的人；全新的人請到「Meegle 開單」分頁填 email 建立對照。沒對照的名字，那幾列會被擋下。</p>}
              {mapError && <div className="mb-alert mb-alert--bad">{mapError}</div>}
            </section>
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" onClick={() => setStep(1)}>上一步</button>
              <button type="button" className="mb-btn mb-btn--primary" disabled={!chosen.length || !activeCount} onClick={() => void goPreview()}>下一步</button>
            </div>
          </div>
        )}

        {/* ── ③ 預覽 ── */}
        {step === 3 && (
          <div className="mb-pane">
            <div className="me-preview-head">
              <h3 className="mb-pane-title">預覽</h3>
              <span className="mb-chip mb-chip--prev is-on">已選 <b>{checked.size}</b> 筆</span>
              <span className="mb-chip mb-chip--ok is-on">可送出 <b>{sendable.length}</b> 筆</span>
              <span className="mb-chip mb-chip--blocked is-on">受阻 <b>{blocked.length}</b> 筆</span>
              <button type="button" className="mb-btn mb-btn--small mb-btn--outline me-repreview" onClick={() => void goPreview()}><Icon name="refresh" /> 重新預覽</button>
            </div>
            <div className="me-preview">
              <aside className="mc-list me-list">
                <div className="me-list-head"><span>選取</span><span>工作項目</span><span>狀態</span></div>
                {chosen.map(r => {
                  const issue = issueOf(r.rowIndex)
                  const st = !checked.has(r.rowIndex) ? { cls: 'muted', text: '未選取' } : issue === '讀取中' || issue === '圖片載入中' ? { cls: 'info', text: issue } : issue ? { cls: 'bad', text: '受阻' } : { cls: 'ok', text: '可送出' }
                  return (
                    <div key={r.rowIndex} role="button" tabIndex={0} className={`mc-list-row me-list-row${focusRow?.rowIndex === r.rowIndex ? ' is-on' : ''}`} onClick={() => { setFocus(r.rowIndex); setEditing(null) }} onKeyDown={e => { if (e.key === 'Enter') setFocus(r.rowIndex) }}>
                      <input type="checkbox" checked={checked.has(r.rowIndex)} aria-label={`選取 #${r.workItemId}`} onClick={e => e.stopPropagation()}
                        onChange={e => setChecked(prev => { const n = new Set(prev); e.target.checked ? n.add(r.rowIndex) : n.delete(r.rowIndex); return n })} />
                      <span className="me-list-name"><b>#{r.workItemId}</b><small>{r.summary}</small></span>
                      <span className={`me-st me-st--${st.cls}`}>{st.text}</span>
                    </div>
                  )
                })}
              </aside>
              {focusRow && (
                <section className="mc-panel me-detail">
                  <div className="mc-panel-head">#{focusRow.workItemId} <span className="me-detail-name">{focusRow.summary}</span>
                    {detailBase && <a className="mb-btn mb-btn--small mb-btn--outline me-open" href={`${detailBase}${focusRow.workItemId}`} target="_blank" rel="noreferrer">在 Meegle 開啟</a>}
                  </div>
                  <table className="mb-table me-changes">
                    <thead><tr><th>欄位</th><th>原值 → 新值</th><th className="me-op">操作</th></tr></thead>
                    <tbody>
                      {pv?.status === 'loading' && <tr><td colSpan={3} className="mb-muted">讀取 Meegle 現況中…</td></tr>}
                      {pv?.status === 'ok' && pv.changes?.map(c => (
                        <tr key={c.key} className={c.error ? 'is-error' : c.same ? 'is-same' : ''}>
                          <td className="me-fname">{labelOf(c.key)}{overrides[focusRow.rowIndex]?.[c.key] !== undefined && <span className="mb-badge mb-badge--pending me-ov">單列</span>}</td>
                          <td className="me-vals"><span className="me-from">{c.from}</span><Icon name="arrow" /><span className="me-to">{c.to}</span>{c.same && <small className="mb-muted">（已經是這個值）</small>}{c.error && <small className="me-err">{c.error}</small>}</td>
                          <td className="me-op"><button type="button" className="mc-x" aria-label={`單列修改 ${labelOf(c.key)}`} onClick={() => setEditing({ key: c.key, value: c.to === '（清空）' ? '' : c.to })}><Icon name="edit" /></button></td>
                        </tr>
                      ))}
                      {(fa?.images.length ?? 0) > 0 && (
                        <tr>
                          <td className="me-fname">圖片</td>
                          <td className="me-vals"><span className="me-thumbs">{fa!.images.map(a => <img key={a.cacheId} src={`/api/jira/attachment-cache/${a.cacheId}`} alt={a.filename} loading="lazy" />)}</span><small className="mb-muted">接在描述後面 {fa!.images.length} 張</small></td>
                          <td className="me-op"><button type="button" className="mc-x" aria-label="重新載入圖片" onClick={() => { void loadImages(focusRow.rowIndex).then(imgs => loadPreview(focusRow.rowIndex, imgs)) }}><Icon name="refresh" /></button></td>
                        </tr>
                      )}
                      {pv?.status === 'ok' && !pv.changes?.length && !(fa?.images.length) && <tr><td colSpan={3} className="mb-muted">這一列沒有要改的欄位（Sheet 該欄空白＝不改）</td></tr>}
                    </tbody>
                  </table>
                  {editing && (
                    <div className="me-editing">
                      <span>只改這一列：<b>{labelOf(editing.key)}</b></span>
                      <input className="mb-input" value={editing.value} onChange={e => setEditing({ ...editing, value: e.target.value })} aria-label="單列新值" />
                      <button type="button" className="mb-btn mb-btn--small mb-btn--primary" onClick={() => { setOverride(focusRow.rowIndex, editing.key, editing.value.trim() ? { key: editing.key, op: 'set', raw: editing.value } : null); setEditing(null) }}>套用</button>
                      <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => { setOverride(focusRow.rowIndex, editing.key, null); setEditing(null) }}>這列不改這欄</button>
                      <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => { setOverride(focusRow.rowIndex, editing.key, undefined); setEditing(null) }}>還原</button>
                    </div>
                  )}
                  {fa?.error && (
                    <div className="mc-missing"><Icon name="warn" /> {fa.error}
                      <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => { void loadImages(focusRow.rowIndex).then(imgs => loadPreview(focusRow.rowIndex, imgs)) }}><Icon name="refresh" /> 重新載入圖片</button>
                      <label className="mc-switch"><input type="checkbox" checked={!!fa.skip} onChange={e => setAtts(a => ({ ...a, [focusRow.rowIndex]: { ...a[focusRow.rowIndex], skip: e.target.checked } }))} /> 不帶這些圖片送出</label>
                    </div>
                  )}
                  {focusIssue && focusIssue !== '讀取中' && focusIssue !== '圖片載入中' && <div className="mb-alert mb-alert--bad me-block"><Icon name="warn" /> #{focusRow.workItemId}：{focusIssue}，暫不送出</div>}
                  {pv?.status === 'error' && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => void loadPreview(focusRow.rowIndex)}><Icon name="refresh" /> 重讀</button>}
                </section>
              )}
            </div>
            <footer className="mb-foot me-foot">
              <button type="button" className="mb-btn mb-btn--outline mb-btn--wide" onClick={() => setStep(2)}>上一步</button>
              {Object.values(overrides).some(o => Object.keys(o).length) && <span className="me-ov-note"><Icon name="check" /> 單列修改已套用</span>}
              <button type="button" className="mb-btn mb-btn--primary mb-btn--big" disabled={!sendable.length || running} onClick={() => void submit()}>送出 {sendable.length} 筆</button>
              {blocked.length > 0 && <span className="mb-muted">受阻列已排除</span>}
            </footer>
          </div>
        )}

        {/* ── ④ 送出結果 ── */}
        {step === 4 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">送出結果</h3>
            <div className="mb-chips mb-tally">
              <span className="mb-chip mb-chip--ok is-on">成功 <b>{tally.ok}</b></span>
              <span className="mb-chip mb-chip--blocked is-on">失敗 <b>{tally.bad}</b></span>
            </div>
            <div className="mb-results">
              {results.map(r => {
                const failed = r.steps.filter(s => s.phase === 'failed')
                const onlyWb = failed.length > 0 && failed.every(s => s.step === 'writeback')
                return (
                  <div key={`${r.batchId}:${r.workItemId}`} className="mb-result">
                    <div className="mb-result-main">
                      <div className="mb-result-name">#{r.workItemId} <span className="mb-muted">{r.summary}</span></div>
                      <div className="mb-result-sub">
                        {r.steps.map((s, i) => <span key={s.step} className={`mc-step mc-step--${s.phase}`} title={s.message ?? ''}>{i + 1} {STEP_LABEL[s.step] ?? s.step}：{PHASE_TEXT[s.phase]}</span>)}
                        {r.claim && r.claim !== 'claimed' && <span className="mb-badge mb-badge--warn">{({ busy: '另一個分頁正在改這張單', 'not-owner': '別人送出的列', 'source-mismatch': '批次的 Sheet 不同', 'already-sent': '這批已經送過這張，用「重試失敗步驟」接著做' } as Record<string, string>)[r.claim] ?? r.claim}</span>}
                        {r.error && <span className="mb-msg">{r.error}</span>}
                        {failed.filter(s => s.message).map(s => <span key={`m-${s.step}`} className="mb-msg">{STEP_LABEL[s.step]}：{s.message}</span>)}
                      </div>
                    </div>
                    <div className="mb-result-actions">
                      {failed.length > 0 && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[r.workItemId]} onClick={() => void retry(r)}>{rowBusy[r.workItemId] ? '處理中…' : onlyWb ? '補寫回' : '重試失敗步驟'}</button>}
                      {detailBase && <a className="mb-btn mb-btn--small mb-btn--outline" href={`${detailBase}${r.workItemId}`} target="_blank" rel="noreferrer">開啟</a>}
                    </div>
                  </div>
                )
              })}
              {chosen.filter(r => issueOf(r.rowIndex) && checked.has(r.rowIndex) && !results.some(x => x.workItemId === r.workItemId)).map(r => (
                <div key={`blk-${r.rowIndex}`} className="mb-result"><div className="mb-result-main"><div className="mb-result-name">#{r.workItemId} <span className="me-st me-st--bad">受阻未送出</span></div><div className="mb-result-sub"><span className="mb-msg">{issueOf(r.rowIndex)}</span></div></div></div>
              ))}
              {!results.length && <div className="mb-muted mb-empty">還沒有送出結果</div>}
            </div>
            <div className="mb-done-line"><span>處理完成 <b>{progress.done}</b> / {progress.total || results.length}</span></div>
            <div className="dashboard-bar-track mb-progress-track"><span className="dashboard-bar-fill" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : (results.length ? 100 : 0)}%` }} /></div>
            <div className="mb-done-note">○ 僅重試失敗步驟　✓ 成功步驟不重跑。全部步驟成功才回填 Sheet「{EDIT_STAGE_DONE}」。</div>
          </div>
        )}
      </section>
    </div>
  )
}

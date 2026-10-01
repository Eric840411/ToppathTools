import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  MEEGLE_ROLE_DEFS, collectAliases, isRestorablePrevious, normAlias, planRow,
  type BatchDefaults, type MappedPerson, type MeegleRoleKey, type Requirement, type RowPlan,
} from '../../shared/meegle-batch-rules'
import './MeegleBatchCreateTab.css'

/**
 * Meegle 批量開單（Jira 頁的「Meegle 開單」分頁）。版面由 CodeX 設計：01 預覽表／02 人員對照／03 送出結果。
 * 列規則（能不能送、人員怎麼對）在 shared/meegle-batch-rules.ts，跟後端同一份。
 * 防重複開單由後端落地紀錄負責（batchId＋列號）；這裡只負責逐列呼叫與顯示。
 * 設計與踩坑：docs/features/28-meegle.md
 */

type SheetRecord = Record<string, unknown> & { _rowIndex: number }
type Person = MappedPerson & { alias: string }
type Meta = { requirements: Requirement[]; states: Array<{ key: string; name: string }>; statesError: string | null }
// targetStateKey：伺服器紀錄裡這列的目標狀態（伺服器回什麼就是什麼，前端不自己記——CodeX review 4bc4fa9 [P2]）
type RowResult = { batchId: string; rowKey: string; targetStateKey?: string; createPhase: 'creating' | 'created' | 'failed' | 'unknown'; workItemId: string | null; url: string | null; statePhase: 'none' | 'done' | 'failed' | 'unknown'; message: string | null }
type Previous = RowResult & { name: string; owner: string }
type Override = { requirementId?: string; roles?: Partial<Record<MeegleRoleKey, string[]>> }

const PAGE_SIZE = 25
const ROLE_SHORT: Record<MeegleRoleKey, string> = { assignee: '受托', rdOwner: 'RD', reporter: '回報', codeReview: 'CR', qaVerifier: 'QA' }

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }))
  if (!r.ok || j.ok === false) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.code })
  return j as T
}

function resultLabel(r: RowResult): { text: string; tone: 'ok' | 'warn' | 'pending' | 'bad' } {
  if (r.createPhase === 'created') {
    if (r.statePhase === 'failed' || r.statePhase === 'unknown') return { text: '已開單但推狀態失敗', tone: 'warn' }
    if (r.targetStateKey && r.statePhase !== 'done') return { text: '已開單但狀態未推', tone: 'warn' }
    return { text: '已開單', tone: 'ok' }
  }
  if (r.createPhase === 'unknown' || r.createPhase === 'creating') return { text: '結果待確認', tone: 'pending' }
  return { text: '開單失敗', tone: 'bad' }
}

export function MeegleBatchCreateTab({ initialSheetUrl }: { initialSheetUrl: string }) {
  const [sheetUrl, setSheetUrl] = useState(initialSheetUrl)
  const [records, setRecords] = useState<SheetRecord[] | null>(null)
  const [loadedUrl, setLoadedUrl] = useState('')
  const [sheetLoading, setSheetLoading] = useState(false)
  const [sheetError, setSheetError] = useState('')

  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaError, setMetaError] = useState<{ code?: string; message: string } | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [previous, setPrevious] = useState<Previous[]>([])

  const [defaults, setDefaults] = useState<BatchDefaults>({ requirementId: '', roles: {} })
  const [targetStateKey, setTargetStateKey] = useState('')
  const [overrides, setOverrides] = useState<Record<number, Override>>({})
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [needsPreselect, setNeedsPreselect] = useState(false)
  const [filter, setFilter] = useState<'all' | 'ok' | 'blocked'>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const [emailDraft, setEmailDraft] = useState<Record<string, string>>({})
  const [verifying, setVerifying] = useState<Record<string, boolean>>({})
  const [verifyError, setVerifyError] = useState<Record<string, string>>({})
  const [editingAlias, setEditingAlias] = useState<Set<string>>(new Set())

  const [batchId, setBatchId] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState<Record<number, RowResult>>({})
  const [rowBusy, setRowBusy] = useState<Record<number, boolean>>({})
  const [rowNote, setRowNote] = useState<Record<number, string>>({})

  // ── 載入 ──
  const loadMeta = useCallback(async () => {
    setMetaError(null)
    try {
      const j = await api<Meta & { ok: true }>('/api/meegle/batch/meta')
      setMeta({ requirements: j.requirements, states: j.states, statesError: j.statesError })
    } catch (e) { setMetaError({ code: (e as { code?: string }).code, message: (e as Error).message }) }
  }, [])
  const loadPeople = useCallback(async () => {
    try {
      const j = await api<{ people: Array<{ alias: string; userKey: string; email: string; name: string }> }>('/api/meegle/batch/people')
      setPeople(j.people)
    } catch { /* 對照表讀不到時，所有人都會顯示成未對照，不會誤送 */ }
  }, [])
  useEffect(() => { void loadMeta(); void loadPeople() }, [loadMeta, loadPeople])

  async function loadSheet(url = sheetUrl) {
    if (!url.trim()) return
    setSheetLoading(true); setSheetError('')
    try {
      const j = await api<{ records: SheetRecord[] }>('/api/lark/sheets/records', { sheetUrl: url.trim(), includeCreated: true })
      const prev = await api<{ rows: Previous[] }>('/api/meegle/batch/previous', { sheetUrl: url.trim() }).catch(() => ({ rows: [] as Previous[] }))
      setRecords(j.records); setLoadedUrl(url.trim()); setPrevious(prev.rows)
      // 每次讀 Sheet 都換新批次——批次綁定來源 Sheet，伺服器也會擋「換 Sheet 沿用舊批次」（CodeX review 999f895 [P1]）
      setBatchId('')
      // 上次送出還沒收尾的列（待確認、或已開單但狀態沒推完）：接回原批次與原目標，才有「查詢結果」「重推狀態」可按
      const pending: Record<number, RowResult> = {}
      for (const p of prev.rows) if (isRestorablePrevious(p)) pending[Number(p.rowKey)] = p
      setOverrides({}); setResults(pending); setRowNote({}); setPage(1); setEditingRow(null)
      setSelected(new Set())  // 下面的 effect 依規則重新預選
      setNeedsPreselect(true)
    } catch (e) { setSheetError((e as Error).message) } finally { setSheetLoading(false) }
  }

  // ── 每列的規劃（跟後端同一份規則）──
  const personMap = useMemo(() => {
    const m: Record<string, MappedPerson> = {}
    for (const p of people) m[normAlias(p.alias)] = { userKey: p.userKey, email: p.email, name: p.name }
    return m
  }, [people])
  const requirements = meta?.requirements ?? []
  const prevByRow = useMemo(() => {
    const m = new Map<string, Previous[]>()
    for (const p of previous) m.set(p.rowKey, [...(m.get(p.rowKey) ?? []), p])
    return m
  }, [previous])

  const rows = useMemo(() => (records ?? []).map(rec => {
    const ov = overrides[rec._rowIndex] ?? {}
    const plan: RowPlan = planRow({ record: rec, requirementOverride: ov.requirementId, roleOverrides: ov.roles }, defaults, requirements, personMap)
    // 這份 Sheet 之前從同一列、同一個名稱開過 → 標出來，預設不勾（跨批次的重複開單只能靠這裡擋）
    const all = prevByRow.get(String(rec._rowIndex)) ?? []
    const prev = all.filter(p => p.createPhase === 'created' && p.name === plan.name)
    // 同一列還有開單中／待確認的紀錄（任何批次）→ 不能送，伺服器也會擋。
    // 這次已經查過（results 有新結果）就以新結果為準，不然查明後這列還會一直卡著
    const cur = results[rec._rowIndex]
    const isPending = (p: { createPhase: string }) => p.createPhase === 'creating' || p.createPhase === 'unknown'
    const pendingPrev = cur ? isPending(cur) : all.some(isPending)
    const jiraKey = String(rec['Jira issue key'] ?? '').trim()
    return { rec, plan, prev, pendingPrev, jiraKey, source: ov.requirementId ? '覆寫' : String(rec['關聯需求'] ?? '').trim() ? 'Sheet' : '預設' }
  }), [records, overrides, defaults, requirements, personMap, prevByRow, results])

  useEffect(() => {
    if (!needsPreselect || !records || !meta) return
    // 預選：沒開過 Meegle、也還沒在 Jira 開過單的列。不看「被擋下」——剛讀完還沒選整批預設需求時每列都會被擋，
    // 看的話選完預設也不會有任何列被勾。被擋下的列就算勾著也不會送（送出只取可送出的）。
    setSelected(new Set(rows.filter(r => r.plan.name && !r.prev.length && !r.pendingPrev && !r.jiraKey).map(r => r.rec._rowIndex)))
    setNeedsPreselect(false)
  }, [needsPreselect, records, meta, rows])

  const visible = rows.filter(r => {
    if (filter === 'ok' && r.plan.blocks.length) return false
    if (filter === 'blocked' && !r.plan.blocks.length) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return r.plan.name.toLowerCase().includes(q) || MEEGLE_ROLE_DEFS.some(d => r.plan.roles[d.key].aliases.some(a => a.toLowerCase().includes(q)))
  })
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const pageRows = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const okCount = rows.filter(r => !r.plan.blocks.length).length
  // 已在 Meegle 開過（同列同名）的不送，伺服器也會擋並回傳原本那張
  const sendable = rows.filter(r => selected.has(r.rec._rowIndex) && !r.plan.blocks.length && !r.pendingPrev && !r.prev.length)

  // ── 人員對照 ──
  const aliasRows = useMemo(() => {
    if (!records) return []
    const aliases = collectAliases(rows.map(r => ({ record: r.rec, roleOverrides: overrides[r.rec._rowIndex]?.roles })), defaults)
    return aliases.map(alias => {
      const k = normAlias(alias)
      const affected = rows.filter(r => MEEGLE_ROLE_DEFS.some(d => r.plan.roles[d.key].aliases.some(a => normAlias(a) === k))).length
      return { alias, person: personMap[k] ?? null, affected }
    }).sort((a, b) => Number(!!a.person) - Number(!!b.person) || b.affected - a.affected)
  }, [records, rows, overrides, defaults, personMap])

  async function verifyAlias(alias: string) {
    const email = (emailDraft[alias] ?? '').trim()
    if (!email) return
    setVerifying(v => ({ ...v, [alias]: true })); setVerifyError(v => ({ ...v, [alias]: '' }))
    try {
      await api('/api/meegle/batch/people/verify', { alias, email })
      await loadPeople()
      setEditingAlias(s => { const n = new Set(s); n.delete(alias); return n })
    } catch (e) { setVerifyError(v => ({ ...v, [alias]: (e as Error).message })) } finally { setVerifying(v => ({ ...v, [alias]: false })) }
  }

  // ── 送出 ──
  function rowPayload(r: typeof rows[number]) {
    const roles = {} as Record<MeegleRoleKey, string[]>
    for (const d of MEEGLE_ROLE_DEFS) roles[d.key] = r.plan.roles[d.key].aliases
    return { rowKey: String(r.rec._rowIndex), sheetUrl: loadedUrl, name: r.plan.name, description: r.plan.description, requirementId: r.plan.requirement!.id, roles, targetStateKey }
  }

  function ensureBatch() {
    const id = batchId || crypto.randomUUID()
    if (!batchId) setBatchId(id)
    return id
  }

  async function submit() {
    const list = sendable
    if (!list.length) return
    const id = ensureBatch()
    setRunning(true); setProgress({ done: 0, total: list.length })
    for (const r of list) {
      try {
        const j = await api<{ row: RowResult }>('/api/meegle/batch/row', { batchId: id, ...rowPayload(r) })
        setResults(m => ({ ...m, [r.rec._rowIndex]: j.row }))
      } catch (e) {
        // 請求本身失敗（斷線、伺服器錯誤）：伺服器那邊可能已經開了，標成待確認，用「查詢結果」去釐清
        setResults(m => ({ ...m, [r.rec._rowIndex]: { batchId: id, rowKey: String(r.rec._rowIndex), createPhase: 'unknown', workItemId: null, url: null, statePhase: 'none', message: (e as Error).message } }))
      }
      setProgress(p => ({ ...p, done: p.done + 1 }))
    }
    setRunning(false)
    void api('/api/meegle/batch/finish', { batchId: id }).catch(() => {})
  }

  async function rowAction(rowIndex: number, kind: 'retry-state' | 'confirm') {
    setRowBusy(b => ({ ...b, [rowIndex]: true })); setRowNote(n => ({ ...n, [rowIndex]: '' }))
    try {
      // 用這一列自己的批次（可能是重整前的舊批次）
      const prevResult = results[rowIndex]
      const rowBatch = prevResult?.batchId || batchId
      // 畫面上選的目標只是「紀錄沒有目標時」的備案，伺服器以紀錄為準
      const j = await api<{ row: RowResult | null; message?: string }>(`/api/meegle/batch/row/${kind}`, { batchId: rowBatch, rowKey: String(rowIndex), ...(kind === 'retry-state' ? { targetStateKey } : {}) })
      if (j.row) setResults(m => ({ ...m, [rowIndex]: j.row! }))
      if (j.message) setRowNote(n => ({ ...n, [rowIndex]: j.message! }))
    } catch (e) { setRowNote(n => ({ ...n, [rowIndex]: (e as Error).message })) } finally { setRowBusy(b => ({ ...b, [rowIndex]: false })) }
  }

  async function resendFailed(rowIndex: number) {
    const r = rows.find(x => x.rec._rowIndex === rowIndex)
    if (!r || r.plan.blocks.length) return
    setRowBusy(b => ({ ...b, [rowIndex]: true }))
    try {
      const j = await api<{ row: RowResult }>('/api/meegle/batch/row', { batchId: ensureBatch(), ...rowPayload(r) })
      setResults(m => ({ ...m, [rowIndex]: j.row }))
    } catch (e) { setRowNote(n => ({ ...n, [rowIndex]: (e as Error).message })) } finally { setRowBusy(b => ({ ...b, [rowIndex]: false })) }
  }

  function exportCsv() {
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const lines = [['列', '任務名稱', 'Meegle 單號', '結果', '說明', '連結'].map(esc).join(',')]
    for (const r of rows) {
      const res = results[r.rec._rowIndex]
      if (!res) continue
      lines.push([r.rec._rowIndex, r.plan.name, res.workItemId ?? '', resultLabel(res).text, res.message ?? '', res.url ?? ''].map(esc).join(','))
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `meegle-batch-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`; a.click()
    URL.revokeObjectURL(a.href)
  }

  const resultEntries = rows.filter(r => results[r.rec._rowIndex])
  const tally = { ok: 0, warn: 0, pending: 0, bad: 0 }
  for (const r of resultEntries) tally[resultLabel(results[r.rec._rowIndex]).tone]++
  const blockedSelected = rows.filter(r => selected.has(r.rec._rowIndex) && r.plan.blocks.length).length

  const personOptions = people.map(p => ({ value: p.alias, label: `${p.alias}（${p.name || p.email}）` }))

  // ── 畫面 ──
  if (metaError) {
    const bindIssue = metaError.code === 'NOT_BOUND' || metaError.code === 'BINDING_INVALID' || metaError.code === 'DECRYPT_FAILED'
    return (
      <div className="mb-page">
        <div className={`mb-alert ${bindIssue ? 'mb-alert--warn' : 'mb-alert--bad'}`}>
          {metaError.message}
          {!bindIssue && <button type="button" className="mb-btn mb-btn--small" style={{ marginLeft: 10 }} onClick={() => void loadMeta()}>重試</button>}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-page">
      {/* ── 01 預覽表 ── */}
      <section className="mb-card">
        <header className="mb-head">
          <h2 className="mb-title"><span className="mb-no">01</span>預覽表<span className="mb-sub">檢視資料與設定對應規則，確認後送出</span></h2>
          <div className="mb-sheet">
            <input className="mb-input" placeholder="貼上 Lark Sheet 網址" value={sheetUrl} onChange={e => setSheetUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void loadSheet() }} />
            <button type="button" className="mb-btn" disabled={sheetLoading || !sheetUrl.trim()} onClick={() => void loadSheet()}>
              {sheetLoading ? '讀取中…' : records ? '重新讀取' : '讀取'}
            </button>
          </div>
        </header>
        {sheetError && <div className="mb-alert mb-alert--bad">{sheetError}</div>}
        {!meta && <div className="mb-muted">正在讀取 Meegle 需求清單…</div>}

        {meta && (
          <div className="mb-defaults">
            <label className="mb-field"><span>關聯需求預設</span>
              <select className="mb-select" value={defaults.requirementId} onChange={e => setDefaults(d => ({ ...d, requirementId: e.target.value }))}>
                <option value="">— 選擇需求 —</option>
                {requirements.map(r => <option key={r.id} value={r.id}>{r.name}（#{r.id}）</option>)}
              </select>
            </label>
            {(['assignee', 'codeReview'] as const).map(k => (
              <label key={k} className="mb-field"><span>{k === 'assignee' ? '受托人' : 'Code Review'}</span>
                <select className="mb-select" value={defaults.roles[k]?.[0] ?? ''} onChange={e => setDefaults(d => ({ ...d, roles: { ...d.roles, [k]: e.target.value ? [e.target.value] : [] } }))}>
                  <option value="">— 留空 —</option>
                  {personOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            ))}
            <label className="mb-field"><span>開單後推到</span>
              <select className="mb-select" value={targetStateKey} onChange={e => setTargetStateKey(e.target.value)} disabled={!meta.states.length}>
                <option value="">— 不推（停在初始狀態）—</option>
                {meta.states.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </label>
            <p className="mb-hint">
              Sheet 只有 RD負責人／回報者／QA驗證人員；受托人和 Code Review 由這裡整批帶入（下拉只列已對照過的人），可逐列修改。
              Sheet 若有「關聯需求」欄，填了就以該欄為準，對不到會擋下，不會改用預設。
              {meta.statesError && <><br />⚠️ 讀不到狀態清單：{meta.statesError}</>}
            </p>
          </div>
        )}

        {records && meta && (
          <>
            <div className="mb-toolbar">
              <div className="mb-chips">
                {([['all', `全部 ${rows.length}`], ['ok', `可送出 ${okCount}`], ['blocked', `被擋下 ${rows.length - okCount}`]] as const).map(([k, label]) => (
                  <button key={k} type="button" className={`mb-chip mb-chip--${k}${filter === k ? ' is-on' : ''}`} onClick={() => { setFilter(k); setPage(1) }}>{label}</button>
                ))}
              </div>
              <input className="mb-input mb-search" placeholder="搜尋任務或人名" value={query} onChange={e => { setQuery(e.target.value); setPage(1) }} />
            </div>

            <div className="mb-table-wrap">
              <table className="mb-table">
                <thead><tr>
                  <th><input type="checkbox" aria-label="全選這一頁可送出的列"
                    checked={pageRows.some(r => !r.plan.blocks.length) && pageRows.filter(r => !r.plan.blocks.length).every(r => selected.has(r.rec._rowIndex))}
                    onChange={e => setSelected(s => { const n = new Set(s); for (const r of pageRows) if (!r.plan.blocks.length) { if (e.target.checked) n.add(r.rec._rowIndex); else n.delete(r.rec._rowIndex) } return n })} /></th>
                  <th>列</th><th>任務名稱</th><th>關聯需求</th><th>人員（5 角色）</th><th>檢查</th><th></th>
                </tr></thead>
                <tbody>
                  {pageRows.map(r => {
                    const idx = r.rec._rowIndex
                    const ov = overrides[idx] ?? {}
                    return (
                      <Fragment key={idx}>
                        <tr className={r.plan.blocks.length ? 'is-blocked' : r.plan.warnings.length ? 'is-warn' : ''}>
                          <td><input type="checkbox" disabled={!!r.plan.blocks.length || r.pendingPrev || r.prev.length > 0} checked={selected.has(idx)} aria-label={`選取第 ${idx} 列`}
                            onChange={e => setSelected(s => { const n = new Set(s); if (e.target.checked) n.add(idx); else n.delete(idx); return n })} /></td>
                          <td className="mb-num">{idx}</td>
                          <td className="mb-name">{r.plan.name || <span className="mb-muted">（空白）</span>}</td>
                          <td>{r.plan.requirement ? <>{r.plan.requirement.name} <span className={`mb-tag mb-tag--${r.source === '預設' ? 'default' : 'override'}`}>{r.source}</span></> : <span className="mb-muted">—</span>}</td>
                          <td className="mb-people">
                            {MEEGLE_ROLE_DEFS.map(d => {
                              const role = r.plan.roles[d.key]
                              if (!role.aliases.length) return <span key={d.key} className="mb-role mb-muted">{ROLE_SHORT[d.key]} —</span>
                              return <span key={d.key} className="mb-role">{ROLE_SHORT[d.key]} {role.aliases.map((a, i) => (
                                <span key={i} className={role.unmapped.includes(a) ? 'mb-unmapped' : ''}>{i ? '、' : ''}{a}</span>))}</span>
                            })}
                          </td>
                          <td className="mb-check">
                            {r.plan.blocks.map((b, i) => <div key={i} className="mb-badge mb-badge--bad">{b}</div>)}
                            {!r.plan.blocks.length && r.plan.warnings.map((w, i) => <div key={i} className="mb-badge mb-badge--warn">{w}</div>)}
                            {r.prev.map(p => <div key={p.workItemId} className="mb-badge mb-badge--info">已在 Meegle 開過 {p.url ? <a href={p.url} target="_blank" rel="noreferrer">#{p.workItemId}</a> : `#${p.workItemId}`}</div>)}
                            {r.pendingPrev && <div className="mb-badge mb-badge--pending">上次送出結果待確認，請在「送出結果」按查詢結果</div>}
                            {r.jiraKey && <div className="mb-badge mb-badge--info">Jira 已開 {r.jiraKey}</div>}
                            {!r.plan.blocks.length && !r.plan.warnings.length && !r.prev.length && !r.pendingPrev && !r.jiraKey && <div className="mb-badge mb-badge--ok">可送出</div>}
                          </td>
                          <td><button type="button" className="mb-btn mb-btn--small" onClick={() => setEditingRow(editingRow === idx ? null : idx)}>{editingRow === idx ? '收起' : '編輯'}</button></td>
                        </tr>
                        {editingRow === idx && (
                          <tr className="mb-edit-row"><td colSpan={7}>
                            <div className="mb-edit">
                              <label className="mb-field"><span>關聯需求（這列）</span>
                                <select className="mb-select" value={ov.requirementId ?? ''} onChange={e => setOverrides(o => ({ ...o, [idx]: { ...o[idx], requirementId: e.target.value || undefined } }))}>
                                  <option value="">— 跟隨 Sheet／預設 —</option>
                                  {requirements.map(q => <option key={q.id} value={q.id}>{q.name}（#{q.id}）</option>)}
                                </select>
                              </label>
                              {MEEGLE_ROLE_DEFS.map(d => (
                                <label key={d.key} className="mb-field"><span>{d.label}</span>
                                  <input className="mb-input" placeholder={d.sheetColumn ? `跟隨 Sheet（${d.sheetColumn}）` : '跟隨整批預設'}
                                    value={ov.roles?.[d.key]?.join(', ') ?? ''}
                                    onChange={e => {
                                      const v = e.target.value
                                      setOverrides(o => {
                                        const roles = { ...(o[idx]?.roles ?? {}) }
                                        if (v.trim()) roles[d.key] = v.split(/[,，、]/).map(s => s.trim()).filter(Boolean); else delete roles[d.key]
                                        return { ...o, [idx]: { ...o[idx], roles } }
                                      })
                                    }} />
                                </label>
                              ))}
                            </div>
                            <p className="mb-hint">人名欄留空＝沿用 Sheet 或整批預設；要清空某個角色，請到 Meegle 開單後再改。新名字要先在下方「人員對照」填 email。</p>
                          </td></tr>
                        )}
                      </Fragment>
                    )
                  })}
                  {!pageRows.length && <tr><td colSpan={7} className="mb-muted mb-empty">沒有符合條件的列</td></tr>}
                </tbody>
              </table>
            </div>

            <footer className="mb-foot">
              <div className="mb-pager">
                <button type="button" className="mb-btn mb-btn--small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
                <span>{visible.length ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, visible.length)} / ${visible.length}` : '0 / 0'}</span>
                <button type="button" className="mb-btn mb-btn--small" disabled={page >= pageCount} onClick={() => setPage(p => p + 1)}>›</button>
              </div>
              <span className="mb-muted">
                已勾 {selected.size} 列{blockedSelected ? `（其中 ${blockedSelected} 列被擋下，不會送出）` : ''}
                <button type="button" className="mb-btn mb-btn--small mb-gap" onClick={() => setSelected(new Set(visible.filter(r => !r.plan.blocks.length).map(r => r.rec._rowIndex)))}>勾選篩選結果中可送出的</button>
                <button type="button" className="mb-btn mb-btn--small mb-gap" disabled={!selected.size} onClick={() => setSelected(new Set())}>清除勾選</button>
              </span>
              <button type="button" className="mb-btn mb-btn--primary" disabled={running || !sendable.length} onClick={() => void submit()}>
                {running ? `送出中 ${progress.done}/${progress.total}` : `送出 ${sendable.length} 列`}
              </button>
            </footer>
          </>
        )}
      </section>

      {/* ── 02 人員對照 ── */}
      {records && meta && (
        <section className="mb-card">
          <header className="mb-head">
            <h2 className="mb-title"><span className="mb-no">02</span>人員對照<span className="mb-sub">Sheet 上的名字對到 Meegle 帳號；驗證過會記住，下次自動帶入</span></h2>
          </header>
          {!aliasRows.length ? <div className="mb-muted">這份 Sheet 沒有人員欄位的資料</div> : (
            <div className="mb-table-wrap">
              <table className="mb-table mb-people-table">
                <thead><tr><th>Sheet 名字</th><th>Meegle 帳號</th><th>狀態</th><th>影響列</th><th></th></tr></thead>
                <tbody>
                  {aliasRows.map(({ alias, person, affected }) => {
                    const editing = !person || editingAlias.has(alias)
                    return (
                      <tr key={alias}>
                        <td>{alias}</td>
                        <td>
                          {editing ? (
                            <input className="mb-input" type="email" placeholder="輸入 email" value={emailDraft[alias] ?? person?.email ?? ''}
                              onChange={e => setEmailDraft(d => ({ ...d, [alias]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') void verifyAlias(alias) }} />
                          ) : <>{person!.name} <span className="mb-muted">{person!.email}</span></>}
                          {verifyError[alias] && <div className="mb-badge mb-badge--bad">{verifyError[alias]}</div>}
                        </td>
                        <td>{person && !editingAlias.has(alias) ? <span className="mb-badge mb-badge--ok">已對照</span> : <span className="mb-badge mb-badge--warn">未對照（角色留空）</span>}</td>
                        <td className="mb-num">{affected}</td>
                        <td>
                          {editing
                            ? <button type="button" className="mb-btn mb-btn--small mb-btn--primary" disabled={verifying[alias] || !(emailDraft[alias] ?? '').trim()} onClick={() => void verifyAlias(alias)}>{verifying[alias] ? '驗證中…' : '驗證'}</button>
                            : <button type="button" className="mb-btn mb-btn--small" onClick={() => { setEditingAlias(s => new Set(s).add(alias)); setEmailDraft(d => ({ ...d, [alias]: person!.email })) }}>修改</button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mb-hint">未對照的名字不會擋下整列，但那個角色會留空。對照是用 Sheet 上的完整寫法：「Jenny Hsu」和「Jenny Lin」是兩筆。驗證時一定要 email 完全相同才算數，不會用名字猜人。</p>
        </section>
      )}

      {/* ── 03 送出結果 ── */}
      {resultEntries.length > 0 && (
        <section className="mb-card">
          <header className="mb-head">
            <h2 className="mb-title"><span className="mb-no">03</span>送出結果<span className="mb-sub">逾時的列先查明結果，不會自動重送；重推狀態只更新既有的單</span></h2>
            <button type="button" className="mb-btn mb-btn--small" disabled={!resultEntries.length} onClick={exportCsv}>匯出結果</button>
          </header>
          <div className="mb-progress"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div className="mb-chips mb-tally">
            <span className="mb-chip mb-chip--ok is-on">已開單 {tally.ok}</span>
            <span className="mb-chip mb-chip--warn is-on">已開單但推狀態失敗 {tally.warn}</span>
            <span className="mb-chip mb-chip--pending is-on">結果待確認 {tally.pending}</span>
            <span className="mb-chip mb-chip--blocked is-on">開單失敗 {tally.bad}</span>
          </div>
          <div className="mb-table-wrap">
            <table className="mb-table">
              <thead><tr><th>列</th><th>任務名稱</th><th>Meegle 單號</th><th>結果</th><th>說明</th><th></th></tr></thead>
              <tbody>
                {resultEntries.map(r => {
                  const idx = r.rec._rowIndex
                  const res = results[idx]
                  const label = resultLabel(res)
                  return (
                    <tr key={idx}>
                      <td className="mb-num">{idx}</td>
                      <td className="mb-name">{r.plan.name}</td>
                      <td>{res.workItemId ? (res.url ? <a href={res.url} target="_blank" rel="noreferrer">#{res.workItemId}</a> : `#${res.workItemId}`) : '—'}</td>
                      <td><span className={`mb-badge mb-badge--${label.tone === 'pending' ? 'pending' : label.tone}`}>{label.text}</span></td>
                      <td className="mb-msg">{rowNote[idx] || res.message || ''}</td>
                      <td>
                        {label.tone === 'warn' && <button type="button" className="mb-btn mb-btn--small" disabled={rowBusy[idx] || !(res.targetStateKey || targetStateKey)} onClick={() => void rowAction(idx, 'retry-state')}>重推狀態</button>}
                        {label.tone === 'pending' && <button type="button" className="mb-btn mb-btn--small" disabled={rowBusy[idx]} onClick={() => void rowAction(idx, 'confirm')}>查詢結果</button>}
                        {label.tone === 'bad' && <button type="button" className="mb-btn mb-btn--small" disabled={rowBusy[idx] || !!r.plan.blocks.length} onClick={() => void resendFailed(idx)}>修正後重送</button>}
                        {res.url && label.tone === 'ok' && <a className="mb-btn mb-btn--small" href={res.url} target="_blank" rel="noreferrer">開啟</a>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

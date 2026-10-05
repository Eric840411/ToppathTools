import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MEEGLE_ROLE_DEFS, collectAliases, isRestorablePrevious, normAlias, planRow,
  type BatchDefaults, type MappedPerson, type MeegleRoleKey, type Requirement, type RowPlan,
} from '../../shared/meegle-batch-rules'
import type { RosterPerson } from '../../shared/meegle-people-match'
import { newStepId } from '../features/uat/step-model'
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
type RowResult = { batchId: string; rowKey: string; targetStateKey?: string; createPhase: 'creating' | 'created' | 'failed' | 'unknown'; workItemId: string | null; url: string | null; statePhase: 'none' | 'done' | 'failed' | 'unknown'; message: string | null; writebackPhase?: 'none' | 'pending' | 'done' | 'failed'; writebackMsg?: string | null }
type Previous = RowResult & { name: string; owner: string }
type Override = { requirementId?: string; roles?: Partial<Record<MeegleRoleKey, string[]>> }
/** 後端猜人結果（只是建議；寫入一律走 verify）。bulkOk＝完整名字＋名單唯一＋租戶名錄也唯一，才能進「全部確認」 */
type Suggestion = { alias: string; status: 'unique' | 'ambiguous' | 'none'; confidence?: 'exact' | 'partial'; user?: RosterPerson; users?: RosterPerson[]; bulkOk: boolean; note: string }

/** 目前是普通版還是修仙版：App 切換時會改 <html data-theme-mode>，這裡跟著它（只換文字，樣式交給 CSS） */
function useThemeMode(): string {
  const read = () => document.documentElement.dataset.themeMode ?? ''
  const [mode, setMode] = useState(read)
  useEffect(() => {
    const ob = new MutationObserver(() => setMode(read()))
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode'] })
    return () => ob.disconnect()
  }, [])
  return mode
}

/** 小圖示：線條 SVG、跟著文字顏色（視覺規範不用原生 emoji——各平台長得不一樣，修仙版也換不了色） */
const ICON_PATHS = {
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1',
  gear: 'M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  search: 'M7 2.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM10.3 10.3l3.2 3.2',
  download: 'M8 2v8M4.5 7L8 10.5 11.5 7M3 13.5h10',
  warn: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2',
} as const
function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return <svg className="mb-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={ICON_PATHS[name]} /></svg>
}

/**
 * 批量設定的人員欄：可以選多個人（使用者 2026-10-05：QA 驗證要複選）。
 * 值仍是逗號分隔的字串，跟原本的套用邏輯（split 逗號）同一個格式——資料層本來就支援多人，只是原本的單選輸入框選第二個會蓋掉第一個。
 * 選到名單裡的名字、按 Enter 或打逗號就加成一個標籤；× 移除。空的＝不改。
 */
function PeoplePicker({ value, onChange, listId, label }: { value: string; onChange: (v: string) => void; listId: string; label: string }) {
  const names = value.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const more = raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
    if (!more.length) return
    const next = [...names]
    for (const n of more) if (!next.some(x => x.toLowerCase() === n.toLowerCase())) next.push(n)
    onChange(next.join(', '))
    setDraft('')
  }
  return (
    <div className="mb-picker">
      {names.map(n => (
        <span key={n} className="mb-picker-chip">{n}<button type="button" aria-label={`移除 ${n}`} onClick={() => onChange(names.filter(x => x !== n).join(', '))}>×</button></span>
      ))}
      <input className="mb-picker-input" list={listId} aria-label={label} placeholder={names.length ? '＋加人' : '— 不改 —'} value={draft}
        onChange={e => {
          const v = e.target.value
          // 從下拉選到名單裡的人 → 直接加成標籤（不用再按 Enter）。
          // ⚠️ 名單要在這裡才去抓：render 當下抓的話，第一次 render 時 datalist 還沒掛上去（排在欄位後面），會一直是 null
          const options = document.getElementById(listId) as HTMLDataListElement | null
          if (options && [...options.options].some(o => o.value === v)) { add(v); return }
          if (/[,，、]$/.test(v)) { add(v); return }
          setDraft(v)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft) }
          if (e.key === 'Backspace' && !draft && names.length) onChange(names.slice(0, -1).join(', '))
        }}
        onBlur={() => add(draft)} />
    </div>
  )
}

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

export function MeegleBatchCreateTab({ initialSheetUrl, onSheetLoaded }: { initialSheetUrl: string; onSheetLoaded?: (url: string) => void }) {
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
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [needsPreselect, setNeedsPreselect] = useState(false)
  const [filter, setFilter] = useState<'all' | 'ok' | 'blocked' | 'prev'>('all')
  // 分步驟版面（CodeX 設計，使用者選 A）：① 讀取與預設 → ② 人員對照 → ③ 預覽與勾選 → ④ 送出結果
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [peopleTab, setPeopleTab] = useState<'unmapped' | 'mapped'>('unmapped')
  const xianxia = useThemeMode() === 'xianxia'
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const [emailDraft, setEmailDraft] = useState<Record<string, string>>({})
  // 非同步流程（全部確認、verify／建議晚回）要讀「現在」的值，不能用點下去那一刻的快照（CodeX review [P1]）
  const draftRef = useRef(emailDraft)
  draftRef.current = emailDraft
  // 每列的編輯版本：使用者每動一次 +1。送出前後比對，版本變了＝使用者改過，舊流程不能再動這列
  const editVer = useRef<Record<string, number>>({})
  // 使用者親手打過字的列（含打完又清空）：晚回的建議不再預填、也不進全部確認（CodeX review [P2]）
  const [touched, setTouched] = useState<Set<string>>(new Set())
  // 這次驗證成功時那列的版本與 email。之後只要版本又變（不管是驗證等回應時、還是驗完才改）＝新填的還沒驗證
  // → 留在「未對照」顯示，不能因為刷新對照表就被移到「已對照」藏起來（CodeX review 兩輪 [P1]）
  const [verified, setVerified] = useState<Record<string, { ver: number; email: string }>>({})
  const needsReverify = (alias: string) => alias in verified && (editVer.current[alias] ?? 0) !== verified[alias].ver
  const touchedRef = useRef(touched)
  touchedRef.current = touched
  /** 使用者改了某列的 email。manual＝親手打字；從建議／候選點選的不算 */
  function editDraft(alias: string, value: string, manual: boolean) {
    editVer.current[alias] = (editVer.current[alias] ?? 0) + 1
    setEmailDraft(d => ({ ...d, [alias]: value }))
    setTouched(t => { if (manual === t.has(alias)) return t; const n = new Set(t); if (manual) n.add(alias); else n.delete(alias); return n })
  }
  const [verifying, setVerifying] = useState<Record<string, boolean>>({})
  const [verifyError, setVerifyError] = useState<Record<string, string>>({})
  const [editingAlias, setEditingAlias] = useState<Set<string>>(new Set())
  // ② 空間角色人員名單（下拉選人）與猜人建議。key 一律用 normAlias
  const [roster, setRoster] = useState<RosterPerson[] | null>(null)
  const [rosterState, setRosterState] = useState<{ loading: boolean; error: string; at: number }>({ loading: false, error: '', at: 0 })
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({})
  const [bulkConfirming, setBulkConfirming] = useState(false)
  // 晚回保護：每次讀 Sheet／重查都換一個序號，舊的回應回來時序號對不上就丟掉（CodeX 2026-10-05）
  const suggestSeq = useRef(0)
  const suggestedFor = useRef(false)

  const [batchId, setBatchId] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [progressDismissed, setProgressDismissed] = useState(false)

  // 批量填寫：對已勾選的列一次寫入逐列覆寫（留空的欄位不動）
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulk, setBulk] = useState<{ requirementId: string; roles: Partial<Record<MeegleRoleKey, string>> }>({ requirementId: '', roles: {} })
  const [bulkMsg, setBulkMsg] = useState('')
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
    // 一開始讀就作廢舊的建議與進行中的全部確認——不能等新 Sheet 回來才作廢，讀得慢的話舊批次會繼續送（CodeX review [P1]）
    suggestSeq.current++
    setSheetLoading(true); setSheetError('')
    try {
      const j = await api<{ records: SheetRecord[] }>('/api/lark/sheets/records', { sheetUrl: url.trim(), includeCreated: true })
      const prev = await api<{ rows: Previous[] }>('/api/meegle/batch/previous', { sheetUrl: url.trim() }).catch(() => ({ rows: [] as Previous[] }))
      setRecords(j.records); setLoadedUrl(url.trim()); setPrevious(prev.rows)
      onSheetLoaded?.(url.trim())
      // 每次讀 Sheet 都換新批次——批次綁定來源 Sheet，伺服器也會擋「換 Sheet 沿用舊批次」（CodeX review 999f895 [P1]）
      setBatchId('')
      // 上次送出還沒收尾的列（待確認、或已開單但狀態沒推完）：接回原批次與原目標，才有「查詢結果」「重推狀態」可按
      const pending: Record<number, RowResult> = {}
      // 回填 Sheet 沒完成（失敗／待寫）的也接回來，才有「補寫回」可以按
      for (const p of prev.rows) if (isRestorablePrevious(p) || p.writebackPhase === 'failed' || p.writebackPhase === 'pending') pending[Number(p.rowKey)] = p
      setOverrides({}); setResults(pending); setRowNote({}); setPage(1)
      // touched 不清：使用者親手打過（含清空）的意圖跨 Sheet 也保留
      suggestSeq.current++; suggestedFor.current = false; setSuggestions({})
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
    if (filter === 'ok' && (r.plan.blocks.length || r.prev.length || r.pendingPrev)) return false
    if (filter === 'blocked' && !r.plan.blocks.length) return false
    if (filter === 'prev' && !r.prev.length) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return r.plan.name.toLowerCase().includes(q) || MEEGLE_ROLE_DEFS.some(d => r.plan.roles[d.key].aliases.some(a => a.toLowerCase().includes(q)))
  })
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const pageRows = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const okCount = rows.filter(r => !r.plan.blocks.length && !r.prev.length && !r.pendingPrev).length
  const blockedCount = rows.filter(r => r.plan.blocks.length).length
  const prevCount = rows.filter(r => r.prev.length).length
  // 已在 Meegle 開過（同列同名）的不送，伺服器也會擋並回傳原本那張
  // 被擋下的列也能勾（批量填寫要能補它們的設定），但送出只取通過檢查的；已開過／待確認的不能勾
  const isSelectable = (r: typeof rows[number]) => !r.pendingPrev && r.prev.length === 0
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

  /** email 對到名單上恰好一個人 → 帶 userKey 給後端（後端仍會自己重新核對，不相信這個值） */
  function rosterByEmail(email: string): RosterPerson | null {
    const hits = (roster ?? []).filter(u => u.email && u.email.toLowerCase() === email.trim().toLowerCase())
    return hits.length === 1 ? hits[0] : null
  }

  async function verifyAlias(alias: string, reload = true): Promise<boolean> {
    const email = (draftRef.current[alias] ?? '').trim()
    if (!email) return false
    const ver = editVer.current[alias] ?? 0
    setVerifying(v => ({ ...v, [alias]: true })); setVerifyError(v => ({ ...v, [alias]: '' }))
    try {
      const picked = rosterByEmail(email)
      await api('/api/meegle/batch/people/verify', { alias, email, ...(picked ? { userKey: picked.userKey } : {}) })
      if (reload) await loadPeople()
      // 等回應期間使用者又改了這列 → 不收起編輯框，保留他新打的（不然新編輯會被藏到「已對照」裡）
      setVerified(v => ({ ...v, [alias]: { ver, email } }))
      // 等回應期間使用者又改了這列 → 不收起編輯框，保留他新打的
      if ((editVer.current[alias] ?? 0) !== ver) setEditingAlias(s => new Set(s).add(alias))
      else setEditingAlias(s => { const n = new Set(s); n.delete(alias); return n })
      return true
    } catch (e) { setVerifyError(v => ({ ...v, [alias]: (e as Error).message })); return false } finally { setVerifying(v => ({ ...v, [alias]: false })) }
  }

  // 進 ② 時：讀名單＋猜人。只猜未對照的；建議只預填「還沒手動填過」的格子，不蓋掉使用者打的字
  async function loadSuggestions(refresh = false) {
    const aliases = aliasRows.filter(a => !a.person).map(a => a.alias)
    const seq = ++suggestSeq.current
    setRosterState(s => ({ ...s, loading: true, error: '' }))
    try {
      const r = await api<{ users: RosterPerson[]; fetchedAt: number }>('/api/meegle/batch/people/roster', { refresh })
      if (seq !== suggestSeq.current) return
      setRoster(r.users)
      const j = aliases.length ? await api<{ suggestions: Suggestion[] }>('/api/meegle/batch/people/suggest', { aliases }) : { suggestions: [] }
      if (seq !== suggestSeq.current) return
      const m: Record<string, Suggestion> = {}
      for (const sg of j.suggestions) m[normAlias(sg.alias)] = sg
      setSuggestions(m)
      setEmailDraft(d => {
        const n = { ...d }
        // 只填「空白而且使用者沒親手碰過」的格子：打完又清空也算碰過，不能被晚回的建議填回去
        for (const a of aliases) { const sg = m[normAlias(a)]; if (sg?.status === 'unique' && sg.user && !(n[a] ?? '').trim() && !touchedRef.current.has(a)) n[a] = sg.user.email }
        return n
      })
      setRosterState({ loading: false, error: '', at: r.fetchedAt })
    } catch (e) {
      if (seq !== suggestSeq.current) return
      setRosterState(s => ({ ...s, loading: false, error: (e as Error).message }))
    }
  }

  /** 全部確認：只確認 bulkOk、使用者沒親手改過、格子裡還是建議那個 email 的列；逐一走 verify */
  const bulkTargets = aliasRows.filter(a => {
    if (a.person || touched.has(a.alias)) return false
    const sg = suggestions[normAlias(a.alias)]
    return !!sg?.bulkOk && sg.status === 'unique' && !!sg.user && (emailDraft[a.alias] ?? '').trim().toLowerCase() === sg.user.email.toLowerCase()
  })
  async function confirmAllSuggested() {
    // 點下去時記下批次序號與每列的「預期 email＋版本」；每筆送出前重新核對，對不上就跳過（換 Sheet 就整批停）
    const seq = suggestSeq.current
    const plan = bulkTargets.map(a => ({ alias: a.alias, email: (draftRef.current[a.alias] ?? '').trim().toLowerCase(), ver: editVer.current[a.alias] ?? 0 }))
    setBulkConfirming(true)
    try {
      for (const t of plan) {
        if (suggestSeq.current !== seq) break
        if ((editVer.current[t.alias] ?? 0) !== t.ver || (draftRef.current[t.alias] ?? '').trim().toLowerCase() !== t.email) continue
        await verifyAlias(t.alias, false)
      }
    } finally { await loadPeople(); setBulkConfirming(false) }
  }

  // ── 送出 ──
  function rowPayload(r: typeof rows[number]) {
    const roles = {} as Record<MeegleRoleKey, string[]>
    for (const d of MEEGLE_ROLE_DEFS) roles[d.key] = r.plan.roles[d.key].aliases
    return { rowKey: String(r.rec._rowIndex), sheetUrl: loadedUrl, name: r.plan.name, description: r.plan.description, requirementId: r.plan.requirement!.id, roles, targetStateKey, targetStateName: meta?.states.find(x => x.key === targetStateKey)?.name ?? '' }
  }

  function ensureBatch() {
    // ⚠️ 不能直接用 crypto.randomUUID()：從區網 IP（http://192.168.x.x）開時不存在（2026-10-01 使用者實測送出就報錯）
    const id = batchId || newStepId()
    if (!batchId) setBatchId(id)
    return id
  }

  async function submit() {
    const list = sendable
    if (!list.length) return
    const id = ensureBatch()
    setRunning(true); setProgress({ done: 0, total: list.length }); setProgressDismissed(false)
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
    void api('/api/meegle/batch/finish', { batchId: id, sheetUrl: loadedUrl, requirementNames: Object.fromEntries(requirements.map(q => [q.id, q.name])) }).catch(() => {})
  }

  async function rowAction(rowIndex: number, kind: 'retry-state' | 'confirm' | 'writeback') {
    setRowBusy(b => ({ ...b, [rowIndex]: true })); setRowNote(n => ({ ...n, [rowIndex]: '' }))
    try {
      // 用這一列自己的批次（可能是重整前的舊批次）
      const prevResult = results[rowIndex]
      const rowBatch = prevResult?.batchId || batchId
      // 畫面上選的目標只是「紀錄沒有目標時」的備案，伺服器以紀錄為準
      const j = await api<{ row: RowResult | null; message?: string }>(`/api/meegle/batch/row/${kind}`, { batchId: rowBatch, rowKey: String(rowIndex), ...(kind === 'retry-state' ? { targetStateKey, targetStateName: meta?.states.find(x => x.key === targetStateKey)?.name ?? '' } : {}) })
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

  const unmappedAliases = aliasRows.filter(a => !a.person || needsReverify(a.alias))
  const mappedAliases = aliasRows.filter(a => a.person && !needsReverify(a.alias))

  /** ① → 下一步：全員已對照就直接進 ③（CodeX 建議），② 仍可從步驟列點回去看 */
  // 進到 ② 且這次讀的 Sheet 還沒猜過 → 自動讀名單＋猜人（每次讀 Sheet 會把 suggestedFor 清掉，所以會重猜）
  useEffect(() => {
    if (step !== 2 || !records || suggestedFor.current) return
    suggestedFor.current = true
    void loadSuggestions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, records])

  function goNextFromLoad() {
    setStep(unmappedAliases.length ? 2 : 3)
  }

  async function submitAndShow() {
    setStep(4)
    await submit()
  }

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

  const STEPS = [
    { n: 1, label: '讀取與預設' },
    { n: 2, label: '人員對照' },
    { n: 3, label: '預覽與勾選' },
    { n: 4, label: '送出結果' },
  ] as const
  // 能不能點到某一步：② ③ 要先讀好 Sheet；④ 要有結果
  const canGo = (n: number) => n === 1 || (n <= 3 ? !!records && !!meta : resultEntries.length > 0)

  return (
    <div className="mb-page">
      <section className="mb-card mb-shell">
        <header className="mb-shell-head">
          <h2 className="mb-shell-title">Meegle 批量開單</h2>
          <span className="mb-shell-sub">{records ? `Lark Sheet ・ ${rows.length} 列` : '尚未讀取 Sheet'}</span>
        </header>

        {/* 步驟列：完成＝勾、目前＝實心數字、還沒到＝空心 ✕ */}
        <nav className="mb-stepper" aria-label="步驟">
          {STEPS.map((s, i) => {
            const state = s.n === step ? 'current' : s.n < step ? 'done' : 'todo'
            return (
              <Fragment key={s.n}>
                {i > 0 && <span className={`mb-step-line${s.n <= step ? ' is-done' : ''}`} />}
                <button type="button" className={`mb-step mb-step--${state}`} disabled={!canGo(s.n) || running} onClick={() => setStep(s.n)}
                  aria-current={state === 'current' ? 'step' : undefined}>
                  <span className="mb-step-dot">{state === 'done' ? '✓' : state === 'current' ? String(s.n).padStart(2, '0') : '✕'}</span>
                  <span className="mb-step-label">{state === 'current' ? s.label : `${String(s.n).padStart(2, '0')}  ${s.label}`}</span>
                </button>
              </Fragment>
            )
          })}
        </nav>

        {/* ── ① 讀取與預設 ── */}
        {step === 1 && (
          <div className="mb-pane mb-pane--narrow">
            <h3 className="mb-pane-title">讀取與整批預設</h3>
            <label className="mb-field"><span>Sheet URL</span>
              <input className="mb-input" placeholder="https://xxx.larksuite.com/wiki/…?sheet=…" value={sheetUrl}
                onChange={e => setSheetUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void loadSheet() }} />
            </label>
            <button type="button" className="mb-btn mb-btn--primary mb-btn--block" disabled={sheetLoading || !sheetUrl.trim()} onClick={() => void loadSheet()}>
              <Icon name="link" /> {sheetLoading ? '讀取中…' : records ? '重新讀取 Sheet' : '讀取 Sheet'}
            </button>
            {sheetError && <div className="mb-alert mb-alert--bad">{sheetError}</div>}
            {records && <div className="mb-muted mb-loaded">已讀取 {rows.length} 列{unmappedAliases.length ? `・${unmappedAliases.length} 個名字未對照` : '・人員都已對照'}</div>}
            {!meta && <div className="mb-muted">正在讀取 Meegle 需求清單…</div>}
            {meta && (
              <div className="mb-grid2">
                <label className="mb-field"><span>關聯需求</span>
                  <select className="mb-select" value={defaults.requirementId} onChange={e => setDefaults(d => ({ ...d, requirementId: e.target.value }))}>
                    <option value="">選擇需求</option>
                    {requirements.map(r => <option key={r.id} value={r.id}>{r.name}（#{r.id}）</option>)}
                  </select>
                </label>
                <label className="mb-field"><span>受托人</span>
                  <select className="mb-select" value={defaults.roles.assignee?.[0] ?? ''} onChange={e => setDefaults(d => ({ ...d, roles: { ...d.roles, assignee: e.target.value ? [e.target.value] : [] } }))}>
                    <option value="">選擇人員</option>
                    {personOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label className="mb-field"><span>CR</span>
                  <select className="mb-select" value={defaults.roles.codeReview?.[0] ?? ''} onChange={e => setDefaults(d => ({ ...d, roles: { ...d.roles, codeReview: e.target.value ? [e.target.value] : [] } }))}>
                    <option value="">選擇人員</option>
                    {personOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label className="mb-field"><span>開單後推到</span>
                  <select className="mb-select" value={targetStateKey} onChange={e => setTargetStateKey(e.target.value)} disabled={!meta.states.length}>
                    <option value="">選擇狀態（不選＝不推）</option>
                    {meta.states.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                  </select>
                </label>
              </div>
            )}
            {meta?.statesError && <div className="mb-hint mb-hint--warn"><Icon name="warn" /> 讀不到狀態清單：{meta.statesError}</div>}
            <p className="mb-hint">人員欄認：回報者／回報人／填寫人、RD負責人／RD、QA驗證人員。Sheet 有「關聯需求」欄就以該欄為準，對不到會擋下、不會改用預設。</p>
            <button type="button" className="mb-btn mb-btn--primary mb-btn--block" disabled={!records || !meta} onClick={goNextFromLoad}>下一步</button>
          </div>
        )}

        {/* ── ② 人員對照 ── */}
        {step === 2 && records && (
          <div className="mb-pane mb-pane--narrow">
            <h3 className="mb-pane-title">人員對照</h3>
            <div className="mb-tabs" role="tablist">
              <button type="button" role="tab" className={`mb-tab${peopleTab === 'unmapped' ? ' is-on mb-tab--warn' : ''}`} aria-selected={peopleTab === 'unmapped'} onClick={() => setPeopleTab('unmapped')}>未對照 <b>{unmappedAliases.length}</b></button>
              <button type="button" role="tab" className={`mb-tab${peopleTab === 'mapped' ? ' is-on' : ''}`} aria-selected={peopleTab === 'mapped'} onClick={() => setPeopleTab('mapped')}>已對照 <b>{mappedAliases.length}</b></button>
            </div>
            <div className="mb-roster-bar">
              <span className="mb-muted">
                {rosterState.loading ? '正在讀取空間角色人員、比對名字…（約 20 秒）'
                  : rosterState.error ? <span className="mb-badge mb-badge--bad">讀不到人員名單：{rosterState.error}（仍可直接輸入 email）</span>
                  : roster ? `空間角色人員 ${roster.filter(u => u.email).length} 人` : ''}
              </span>
              <button type="button" className="mb-btn mb-btn--small" disabled={rosterState.loading} onClick={() => void loadSuggestions(true)}>重新整理名單</button>
              {peopleTab === 'unmapped' && (
                <button type="button" className="mb-btn mb-btn--small mb-btn--primary" disabled={bulkConfirming || !bulkTargets.length} onClick={() => void confirmAllSuggested()}
                  title="只確認名字完全相同、而且 Meegle 上只有一個同名帳號的建議；其他請逐列確認">
                  {bulkConfirming ? '確認中…' : `全部確認（${bulkTargets.length}）`}
                </button>
              )}
            </div>
            <datalist id="mb-roster-options">
              {(roster ?? []).filter(u => u.email).map(u => <option key={u.userKey} value={u.email}>{u.name}</option>)}
            </datalist>
            <div className="mb-people-list">
              {(peopleTab === 'unmapped' ? unmappedAliases : mappedAliases).map(({ alias, person, affected }) => {
                const editing = !person || editingAlias.has(alias) || needsReverify(alias)
                const sg = person ? undefined : suggestions[normAlias(alias)]
                const draft = (emailDraft[alias] ?? '').trim().toLowerCase()
                const draftIsSuggested = sg?.status === 'unique' && !!sg.user && draft === sg.user.email.toLowerCase()
                const picked = draft ? rosterByEmail(draft) : null
                return (
                  <div key={alias} className="mb-person">
                    <div className="mb-person-row">
                      <span className="mb-person-name">{alias}</span>
                      {editing ? (
                        <input className="mb-input mb-person-email" type="email" list="mb-roster-options" placeholder={roster ? '選人（可打名字或 email 搜尋）或輸入 email' : '輸入 email'} value={emailDraft[alias] ?? person?.email ?? ''}
                          onChange={e => editDraft(alias, e.target.value, true)}
                          onKeyDown={e => { if (e.key === 'Enter') void verifyAlias(alias) }} />
                      ) : <span className="mb-person-email mb-muted">{person!.name} ・ {person!.email}</span>}
                      {editing
                        ? <button type="button" className="mb-btn mb-btn--small mb-btn--primary" disabled={verifying[alias] || !(emailDraft[alias] ?? '').trim()} onClick={() => void verifyAlias(alias)}>{verifying[alias] ? '驗證中…' : '驗證'}</button>
                        : <button type="button" className="mb-btn mb-btn--small" onClick={() => { setEditingAlias(s => new Set(s).add(alias)); editDraft(alias, person!.email, false) }}>修改</button>}
                    </div>
                    <div className="mb-person-meta">影響 {affected} 列</div>
                    {editing && !person && (
                      <div className="mb-suggest">
                        {picked && !draftIsSuggested && <span className="mb-muted">Meegle：{picked.name}</span>}
                        {sg?.status === 'unique' && sg.user && (
                          <span className={`mb-badge ${sg.bulkOk && draftIsSuggested ? 'mb-badge--ok' : 'mb-badge--warn'}`}>
                            建議{sg.confidence === 'partial' ? '（部分名字相同）' : ''}：{sg.user.name}・{sg.user.email}
                            {!draftIsSuggested && <> <button type="button" className="mb-link" onClick={() => editDraft(alias, sg.user!.email, false)}>套用</button></>}
                          </span>
                        )}
                        {sg?.status === 'ambiguous' && (
                          <span className="mb-badge mb-badge--warn">
                            {sg.users!.length} 個可能的人：
                            {sg.users!.filter(u => u.email).map(u => <button key={u.userKey} type="button" className="mb-link" onClick={() => editDraft(alias, u.email, false)}>{u.name}（{u.email}）</button>)}
                            {sg.users!.some(u => !u.email) && <> ・{sg.users!.filter(u => !u.email).length} 人沒有 email</>}
                          </span>
                        )}
                        {sg?.note && <span className="mb-muted">{sg.note}</span>}
                      </div>
                    )}
                    {needsReverify(alias) && <div className="mb-badge mb-badge--warn">已用 {verified[alias].email} 對照；你之後改的 email 還沒驗證，要改成新的請按「驗證」</div>}
                    {verifyError[alias] && <div className="mb-badge mb-badge--bad">{verifyError[alias]}</div>}
                  </div>
                )
              })}
              {peopleTab === 'unmapped' && !unmappedAliases.length && <div className="mb-muted mb-empty">全部都已對照 ✓</div>}
              {peopleTab === 'mapped' && !mappedAliases.length && <div className="mb-muted mb-empty">還沒有對照過的人</div>}
            </div>
            <p className="mb-hint">ⓘ 未對照角色留空，預覽保留警告。對照用 Sheet 上的完整寫法；email 必須完全相同才算數。
              名單是「這個空間任務項上掛過角色的人」，不是完整名錄——找不到的人直接輸入 email。建議只是預填，一定要按「驗證」或「全部確認」才會記住。</p>
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" onClick={() => setStep(1)}>上一步</button>
              <button type="button" className="mb-btn mb-btn--primary" onClick={() => setStep(3)}>前往預覽</button>
            </div>
          </div>
        )}

        {/* ── ③ 預覽與勾選 ── */}
        {step === 3 && records && meta && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">預覽與勾選</h3>
            {unmappedAliases.length > 0 && (
              <div className="mb-alert mb-alert--warn mb-alert--row">
                有 {unmappedAliases.length} 個名字未對照（{unmappedAliases.slice(0, 4).map(a => a.alias).join('、')}{unmappedAliases.length > 4 ? '…' : ''}），那些角色會留空。
                <button type="button" className="mb-btn mb-btn--small" onClick={() => { setPeopleTab('unmapped'); setStep(2) }}>回 ② 驗證</button>
              </div>
            )}
            <div className="mb-toolbar">
              <div className="mb-search-wrap"><span aria-hidden><Icon name="search" /></span><input className="mb-input mb-search" placeholder="搜尋任務或人名" value={query} onChange={e => { setQuery(e.target.value); setPage(1) }} /></div>
              <div className="mb-chips">
                {([['all', '全部', rows.length], ['ok', '可送出', okCount], ['blocked', '被擋下', blockedCount], ['prev', '已開過', prevCount]] as const).map(([k, label, n]) => (
                  <button key={k} type="button" className={`mb-chip mb-chip--${k}${filter === k ? ' is-on' : ''}`} onClick={() => { setFilter(k); setPage(1) }}>{label} <b>{n}</b></button>
                ))}
              </div>
            </div>

            <div className="mb-selbar">
              <label className="mb-selbar-all">
                <input type="checkbox" checked={selected.size > 0 && rows.filter(isSelectable).every(r => selected.has(r.rec._rowIndex))}
                  onChange={e => setSelected(e.target.checked ? new Set(rows.filter(isSelectable).map(r => r.rec._rowIndex)) : new Set())} />
                已勾選 <b>{selected.size}</b> 列
              </label>
              <button type="button" className={`mb-btn mb-btn--small mb-btn--outline${bulkOpen ? ' is-on' : ''}`} disabled={!selected.size} onClick={() => { setBulkOpen(o => !o); setBulkMsg('') }}><Icon name="gear" /> 批量設定</button>
              <span className="mb-selbar-hint">留空不改・僅套用勾選列</span>
            </div>

            {bulkOpen && (
              <div className="mb-bulk">
                <div className="mb-edit">
                  <label className="mb-field"><span>關聯需求</span>
                    <select className="mb-select" value={bulk.requirementId} onChange={e => setBulk(b => ({ ...b, requirementId: e.target.value }))}>
                      <option value="">— 不改 —</option>
                      {requirements.map(q => <option key={q.id} value={q.id}>{q.name}（#{q.id}）</option>)}
                    </select>
                  </label>
                  {MEEGLE_ROLE_DEFS.map(d => (
                    <div key={d.key} className="mb-field"><span>{d.label}</span>
                      <PeoplePicker listId="mb-people-options" label={d.label} value={bulk.roles[d.key] ?? ''}
                        onChange={v => setBulk(b => ({ ...b, roles: { ...b.roles, [d.key]: v } }))} />
                    </div>
                  ))}
                  <datalist id="mb-people-options">{people.map(p => <option key={p.alias} value={p.alias}>{p.name || p.email}</option>)}</datalist>
                </div>
                <div className="mb-bulk-actions">
                  <button type="button" className="mb-btn mb-btn--small mb-btn--primary"
                    disabled={!selected.size || (!bulk.requirementId && !Object.values(bulk.roles).some(v => v?.trim()))}
                    onClick={() => {
                      // 只寫有填的欄位；人名逗號分隔、取代 Sheet 值
                      setOverrides(o => {
                        const next = { ...o }
                        for (const idx of selected) {
                          const cur = next[idx] ?? {}
                          const roles = { ...(cur.roles ?? {}) }
                          for (const [k, v] of Object.entries(bulk.roles) as [MeegleRoleKey, string | undefined][]) {
                            if (v?.trim()) roles[k] = v.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
                          }
                          next[idx] = { ...cur, requirementId: bulk.requirementId || cur.requirementId, roles }
                        }
                        return next
                      })
                      setBulkMsg(`已套用到 ${selected.size} 列`)
                    }}>套用到已勾選的列</button>
                  <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={!selected.size}
                    onClick={() => {
                      setOverrides(o => { const next = { ...o }; for (const idx of selected) delete next[idx]; return next })
                      setBulkMsg(`已清除 ${selected.size} 列的手動設定，回到 Sheet／整批預設`)
                    }}>清除這些列的手動設定</button>
                  {bulkMsg && <span className="mb-muted">{bulkMsg}</span>}
                </div>
                <p className="mb-hint">只勾一列就等於單列修改。人員欄可以選多個人（選完會變成標籤，× 移除）。被擋下的列也能勾來補設定，仍要通過檢查才會送出。新名字要先到 ② 驗證。</p>
              </div>
            )}

            <div className="mb-table-wrap">
              <table className="mb-table">
                <thead><tr>
                  <th className="mb-col-check"><input type="checkbox" aria-label="全選這一頁"
                    checked={pageRows.some(isSelectable) && pageRows.filter(isSelectable).every(r => selected.has(r.rec._rowIndex))}
                    onChange={e => setSelected(s => { const n = new Set(s); for (const r of pageRows) if (isSelectable(r)) { if (e.target.checked) n.add(r.rec._rowIndex); else n.delete(r.rec._rowIndex) } return n })} /></th>
                  <th>列</th><th>任務名稱</th><th>關聯需求</th><th>人員</th><th>檢查</th>
                </tr></thead>
                <tbody>
                  {pageRows.map(r => {
                    const idx = r.rec._rowIndex
                    const filled = MEEGLE_ROLE_DEFS.filter(d => r.plan.roles[d.key].aliases.length)
                    return (
                      <tr key={idx}>
                        <td className="mb-col-check"><input type="checkbox" disabled={!isSelectable(r)} checked={selected.has(idx)} aria-label={`選取第 ${idx} 列`}
                          onChange={e => setSelected(s => { const n = new Set(s); if (e.target.checked) n.add(idx); else n.delete(idx); return n })} /></td>
                        <td className="mb-num">{idx}</td>
                        <td className="mb-name">{r.plan.name || <span className="mb-muted">（空白）</span>}</td>
                        <td className="mb-req">{r.plan.requirement ? r.plan.requirement.name : <span className="mb-muted">—</span>}</td>
                        <td className="mb-people">
                          {filled.length ? filled.map((d, i) => (
                            <span key={d.key}>{i ? ' ・ ' : ''}{ROLE_SHORT[d.key]} {r.plan.roles[d.key].aliases.map((a, j) => (
                              <span key={j} className={r.plan.roles[d.key].unmapped.includes(a) ? 'mb-unmapped' : ''}>{j ? '、' : ''}{a}</span>))}</span>
                          )) : <span className="mb-muted">—</span>}
                        </td>
                        <td className="mb-check">
                          {r.plan.blocks.length > 0 ? r.plan.blocks.map((b, i) => <div key={i} className="mb-status mb-status--bad"><i>!</i>被擋：{b}</div>)
                            : r.pendingPrev ? <div className="mb-status mb-status--pending"><i>…</i>上次送出待確認</div>
                            : r.prev.length ? r.prev.map(p => <div key={p.workItemId} className="mb-status mb-status--info"><i>i</i>已在 Meegle 開過 {p.url ? <a href={p.url} target="_blank" rel="noreferrer">#{p.workItemId}</a> : `#${p.workItemId}`}</div>)
                            : r.plan.warnings.length ? <div className="mb-status mb-status--warn" title={r.plan.warnings.join(String.fromCharCode(10))}><i>!</i>警告：{[...new Set(MEEGLE_ROLE_DEFS.flatMap(d => r.plan.roles[d.key].unmapped))].join('、')} 未對照</div>
                            : <div className="mb-status mb-status--ok"><i /> 可送出</div>}
                          {r.jiraKey && <div className="mb-status mb-status--muted">Jira 已開 {r.jiraKey}</div>}
                        </td>
                      </tr>
                    )
                  })}
                  {!pageRows.length && <tr><td colSpan={6} className="mb-muted mb-empty">沒有符合條件的列</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="mb-pager">
              <span>{visible.length ? `${(page - 1) * PAGE_SIZE + 1} – ${Math.min(page * PAGE_SIZE, visible.length)} / ${visible.length}` : '0 / 0'}</span>
              {pageCount > 1 && <>
                <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
                <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={page >= pageCount} onClick={() => setPage(p => p + 1)}>›</button>
              </>}
            </div>
            <footer className="mb-foot">
              <button type="button" className="mb-btn mb-btn--outline mb-btn--wide" onClick={() => setStep(unmappedAliases.length || aliasRows.length ? 2 : 1)}>上一步</button>
              <div className="mb-foot-sum">勾選 <b className="mb-c-sel">{selected.size}</b> ・ 可送 <b className="mb-c-ok">{sendable.length}</b> ・ 被擋 <b className="mb-c-bad">{blockedSelected}</b></div>
              <button type="button" className="mb-btn mb-btn--primary mb-btn--wide mb-btn--big" disabled={running || !sendable.length} onClick={() => void submitAndShow()}>
                {running ? `送出中 ${progress.done}/${progress.total}` : `送出 ${sendable.length} 列`}
              </button>
            </footer>
          </div>
        )}

        {/* ── ④ 送出結果 ── */}
        {step === 4 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">送出結果</h3>
            <div className="mb-chips mb-tally">
              <span className="mb-chip mb-chip--ok is-on">已開單 <b>{tally.ok}</b></span>
              <span className="mb-chip mb-chip--blocked is-on">推狀態失敗 <b>{tally.warn}</b></span>
              <span className="mb-chip mb-chip--pending is-on">待確認 <b>{tally.pending}</b></span>
              {tally.bad > 0 && <span className="mb-chip mb-chip--blocked is-on">開單失敗 <b>{tally.bad}</b></span>}
            </div>
            <div className="mb-results">
              {resultEntries.map(r => {
                const idx = r.rec._rowIndex
                const res = results[idx]
                const label = resultLabel(res)
                return (
                  <div key={idx} className="mb-result">
                    <div className="mb-result-main">
                      <div className="mb-result-name">{r.plan.name}</div>
                      <div className="mb-result-sub">
                        {res.workItemId ? (res.url ? <a href={res.url} target="_blank" rel="noreferrer">#{res.workItemId}</a> : `#${res.workItemId}`) : `第 ${idx} 列`}
                        <span className={`mb-badge mb-badge--${label.tone}`}>{label.text}</span>
                        {res.createPhase === 'created' && res.writebackPhase === 'done' && (res.writebackMsg
                          ? <span className="mb-wb mb-wb--pending" title={res.writebackMsg}>已寫回 Sheet（{res.writebackMsg}）</span>
                          : <span className="mb-wb mb-wb--done">已寫回 Sheet</span>)}
                        {res.createPhase === 'created' && res.writebackPhase === 'pending' && <span className="mb-wb mb-wb--pending">待寫回 Sheet</span>}
                        {res.createPhase === 'created' && res.writebackPhase === 'failed' && <span className="mb-wb mb-wb--bad" title={res.writebackMsg ?? ''}>回填失敗：{res.writebackMsg}</span>}
                        {(rowNote[idx] || res.message) && <span className="mb-msg">{rowNote[idx] || res.message}</span>}
                      </div>
                    </div>
                    <div className="mb-result-actions">
                      {label.tone === 'warn' && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[idx] || !(res.targetStateKey || targetStateKey)} onClick={() => void rowAction(idx, 'retry-state')}>重推狀態</button>}
                      {label.tone === 'pending' && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[idx]} onClick={() => void rowAction(idx, 'confirm')}>查詢結果</button>}
                      {res.createPhase === 'created' && (res.writebackPhase === 'failed' || res.writebackPhase === 'pending') && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[idx]} onClick={() => void rowAction(idx, 'writeback')}>補寫回</button>}
                      {label.tone === 'bad' && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[idx] || !!r.plan.blocks.length} onClick={() => void resendFailed(idx)}>修正後重送</button>}
                      {res.url && label.tone === 'ok' && <a className="mb-btn mb-btn--small mb-btn--outline" href={res.url} target="_blank" rel="noreferrer">開啟</a>}
                    </div>
                  </div>
                )
              })}
              {!resultEntries.length && <div className="mb-muted mb-empty">還沒有送出結果</div>}
            </div>
            <button type="button" className="mb-btn mb-btn--outline mb-btn--block mb-export" disabled={!resultEntries.length} onClick={exportCsv}>
              <Icon name="download" /> {xianxia ? <>封存玉簡<small>匯出結果</small></> : '匯出結果'}
            </button>
            <div className="mb-done-line">
              <span>處理完成 <b>{progress.done}</b> / {progress.total || resultEntries.length}</span>
            </div>
            <div className="dashboard-bar-track mb-progress-track"><span className="dashboard-bar-fill" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : (resultEntries.length ? 100 : 0)}%` }} /></div>
            <div className="mb-done-note">完成不代表全數成功，請看上方各列結果</div>
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" disabled={running} onClick={() => setStep(3)}>上一步</button>
            </div>
          </div>
        )}
      </section>

      {/* 固定在畫面下方的進度列：跨步驟保留（CodeX 設計） */}
      {/* ④ 不顯示：④ 頁面內已有自己那條進度，兩條重複（使用者 10/02 決定保留頁面內那條、刪固定列；取代 CodeX review 34e4e1e [P2]「④ 也保留」） */}
      {progress.total > 0 && !progressDismissed && step !== 4 && (
        <div className="mb-dock" role="status" aria-live="polite">
          <div className="mb-dock-text">
            <b>{running ? `送出中 ${progress.done} / ${progress.total}` : `送出完成 ${progress.done} / ${progress.total}`}</b>
            <span className="mb-dock-ok">已開單 {tally.ok}</span>
            {tally.warn > 0 && <span className="mb-dock-warn">推狀態失敗 {tally.warn}</span>}
            {tally.pending > 0 && <span className="mb-dock-pending">待確認 {tally.pending}</span>}
            {tally.bad > 0 && <span className="mb-dock-bad">失敗 {tally.bad}</span>}
          </div>
          <div className="dashboard-bar-track mb-progress-track mb-dock-bar"><span className="dashboard-bar-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
          <div className="mb-dock-actions">
            <button type="button" className="mb-btn mb-btn--small" onClick={() => setStep(4)}>看結果</button>
            {!running && <button type="button" className="mb-btn mb-btn--small" aria-label="關閉進度列" onClick={() => setProgressDismissed(true)}>✕</button>}
          </div>
        </div>
      )}
    </div>
  )
}

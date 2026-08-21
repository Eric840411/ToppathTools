import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { JiraAccountModal, type AccountInfo } from '../components/JiraAccountModal'
import { useIsGameMode } from '../components/GameModeContext'
import { fetchAuthAccount, GLOBAL_ACCOUNT_KEY } from '../authSession'
import { XianxiaIcon } from '../components/XianxiaIcon'
import { JiraBatchCommentTab } from './JiraBatchCommentTab'
import { JiraBatchCommentStep3 } from './JiraBatchCommentStep3'
import { JiraBatchUpdateTab } from './JiraBatchUpdateTab'
import { JiraBatchEditTab } from './JiraBatchEditTab'
import { JiraCreateStep12 } from './JiraCreateStep12'
import { JiraCreateStep3 } from './JiraCreateStep3'
import { JiraCreateStep4 } from './JiraCreateStep4'

export interface Member {
  accountId: string
  displayName: string
  avatarUrl: string
}

export interface PersonResolveResult {
  name: string
  status: 'ok' | 'no_account' | 'ambiguous' | 'no_token' | 'not_authorized'
  email?: string
  label?: string
  candidates?: string[]
}

export interface SheetRecord {
  [key: string]: string
  _rowIndex: string
}

// 每列在工作流中的追蹤資訊
export interface TrackedIssue {
  rowIndex: number
  issueKey: string   // 已有 or 新建完成後填入
  stage: string      // 讀自 sheet 或本 session 更新後的值
}

export interface IssueCreateResult {
  rowIndex: number
  issueKey?: string
  error?: string
  writebackOk?: boolean
  writebackSkipped?: boolean
  writebackError?: string
}

export interface StageOpResult {
  rowIndex: number
  issueKey: string
  ok: boolean
  usedAi?: boolean
  error?: string
}

export type Step = 1 | 2 | 3 | 4 | 5 | 6
export type SheetSource = 'lark' | 'google'

export interface NormalizedJiraField {
  key: string
  name: string
  required: boolean
  type: 'string' | 'text' | 'number' | 'date' | 'datetime' | 'select' | 'multiselect' | 'user' | 'multiuser' | 'unknown'
  options?: { id: string; label: string }[]
  autoCompleteUrl?: string
}

export interface JiraTransitionOption {
  id: string
  name: string
  toName?: string
}

const STEP_LABELS: Record<Step, string> = {
  1: '選擇專案',
  2: '選擇來源',
  3: '確認清單',
  4: '建立 Issues',
  5: '添加評論',
  6: '切換狀態',
}

const SESSION_KEY = 'jira_current_account'
const BACKEND_BOOT_KEY = 'jira_backend_boot_id'
const ACCOUNT_BOOT_KEY = 'jira_account_boot_id'
const COMMENT_PENDING_KEY = 'jira_pending_comment_request_id'

const JIRA_KEY_COL = 'jira issue key'
const STAGE_COL = '處理階段'
// 批量修改（獨立 Tab）用的處理階段標記——跟開單/評論/切換狀態共用同一個欄位名稱，但值域不同，
// 純粹用來記錄「這筆已經被批量修改過」，防止同一份 Sheet 不小心重複執行造成附件/描述重複疊加
const EDIT_STAGE_DONE = '已修改欄位'
// 批量評論預設勾選的白名單：只有「還沒開始處理」或「只開了單」才代表這一列可能還需要補評論。
// 刻意用白名單而不是列黑名單——處理階段的值域會越加越多（批量修改就自己加了「已修改欄位」），
// 黑名單漏掉一個值，等於預設幫使用者重複送出評論，而評論送出去收不回來（跟 CodeX 討論定案）。
const COMMENT_PENDING_STAGES = ['', '已開單']
const stillNeedsComment = (stage: string) => COMMENT_PENDING_STAGES.includes(stage.trim())

function loadSessionAccount(): AccountInfo | null {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(GLOBAL_ACCOUNT_KEY) ?? 'null')
  } catch {
    return null
  }
}
function saveSessionAccount(a: AccountInfo) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(a))
  sessionStorage.setItem(GLOBAL_ACCOUNT_KEY, JSON.stringify(a))
}

export const getField = (r: SheetRecord, fieldName: string): string => {
  const lower = fieldName.toLowerCase()
  const key = Object.keys(r).find(k => k.toLowerCase() === lower)
  return key ? r[key] : ''
}

const getFieldByHeaderMatch = (r: SheetRecord, names: string[]): string => {
  for (const name of names) {
    const exact = getField(r, name).trim()
    if (exact) return exact
  }
  const keys = Object.keys(r).filter(k => k !== '_rowIndex')
  const key = keys.find(k => names.some(name => k.toLowerCase().includes(name.toLowerCase())))
  return key ? (r[key] ?? '').trim() : ''
}



const appendRawSection = (parts: string[], label: string, value: string) => {
  const clean = value.trim()
  if (!clean) return
  if (parts.some(p => p.endsWith(`：${clean}`))) return
  parts.push(`${label}：${clean}`)
}

const buildAiCommentRawText = (record: SheetRecord, commentColumn: string): string => {
  const parts: string[] = []
  appendRawSection(parts, '摘要', getField(record, SHEET_FIELD.summary) || getFieldByHeaderMatch(record, ['摘要', 'summary']))
  appendRawSection(parts, '內容', getField(record, SHEET_FIELD.description) || getFieldByHeaderMatch(record, ['內容', 'description']))
  appendRawSection(parts, commentColumn || '回覆欄位', commentColumn ? getField(record, commentColumn) : '')
  appendRawSection(parts, '類別', getFieldByHeaderMatch(record, ['類別', '測試平台', '平台']))
  appendRawSection(parts, '進度', getFieldByHeaderMatch(record, ['進度']))
  appendRawSection(parts, 'QA確認OK', getFieldByHeaderMatch(record, ['QA確認OK', 'QA 確認 OK', 'QA']))
  appendRawSection(parts, '開發確認OK', getFieldByHeaderMatch(record, ['開發確認OK', '開發 確認 OK', '開發']))
  appendRawSection(parts, '備註', getFieldByHeaderMatch(record, ['備註', 'remark', 'note']))
  return parts.join('\n')
}

const deriveEnvironment = (record: SheetRecord, rawText: string): string | undefined => {
  const explicit = getFieldByHeaderMatch(record, ['環境', '測試環境'])
  if (explicit) return explicit
  const match = rawText.match(/(?:通過-|於|在)?([A-ZＣ]服)/i)
  return match?.[1]
}

const deriveVersion = (record: SheetRecord, rawText: string): string | undefined => {
  const explicit = getFieldByHeaderMatch(record, ['版本', '版號'])
  if (explicit) return explicit
  const match = rawText.match(/(?:\(|（)?[A-Z]?(?:\)|）)?\.?\s*([0-9]+(?:\.[0-9]+)?版)/i)
  return match?.[1]
}

const nowString = () => new Date().toLocaleString('zh-TW', { hour12: false })

/** 批量評論中斷時的提示文字，依中斷原因分開文案——worker 重啟跟 Gemini 用量上限是完全不同的
 *狀況，不能套用同一句「Gemini API 用量已達上限」。 */
const buildCommentStoppedRow = (stoppedReason: string, stoppedKind?: 'ai_quota' | 'worker_restart') => ({
  rowIndex: -1, issueKey: '已中斷', ok: false,
  error: stoppedKind === 'worker_restart'
    ? stoppedReason
    : `Gemini API 用量已達上限。原因：${stoppedReason}`,
})

// 依 處理階段 決定下一步需要做什麼
export const needsCreate  = (r: SheetRecord) => !getField(r, JIRA_KEY_COL).trim()
const needsComment = (r: SheetRecord) => {
  const key = getField(r, JIRA_KEY_COL).trim()
  const stage = getField(r, STAGE_COL).trim()
  return !!key && (stage === '已開單' || stage === '')
}
const needsTransition = (r: SheetRecord) => {
  const key = getField(r, JIRA_KEY_COL).trim()
  const stage = getField(r, STAGE_COL).trim()
  return !!key && stage === '添加評論'
}

export const stageBadgeClass = (r: SheetRecord) => {
  if (needsCreate(r))     return 'badge badge--blue'
  if (needsComment(r))    return 'badge badge--ok'
  if (needsTransition(r)) return 'badge badge--purple'
  return 'badge'
}
export const stageLabel = (r: SheetRecord) => {
  if (needsCreate(r))     return '待開單'
  if (needsComment(r))    return '已開單'
  if (needsTransition(r)) return '已評論'
  return getField(r, STAGE_COL) || '—'
}

export const SHEET_FIELD: Record<string, string> = {
  summary: '摘要',
  description: '內容',
  assigneeAccountId: '受託人',
  rdOwnerAccountId: 'RD負責人',
  reporter: '回報人',
  verifierAccountIds: '驗證人員',
  actualStart: 'Actual Start',
  actualEnd: 'Actual End',
  localTestDone: '本機完成測試時間',
  stagingDeploy: '上C服時間',
  releaseDate: '上線日期',
}

// 動態開單模式：強制必填欄位 → Lark 欄位名稱對照（供自動帶入使用）
const FORCED_LARK_ALIAS: Record<string, string> = {
  description: '內容',
  assignee: '受託人',
  reporter: '回報人',
  customfield_10428: 'RD負責人',
}

export interface CachedAttachment {
  cacheId: string
  filename: string
  mimeType: string
  isImage: boolean
  isVideo: boolean
  size: number
  error?: string
}

export interface PreviewItem {
  rowIndex: number
  issueKey: string
  summary: string
  commentText: string
  cachedAttachments: CachedAttachment[]
  missingSections: string[]
  hasError: boolean
}

interface JiraPageProps {
  account?: AccountInfo | null
  isAdmin?: boolean
  /** 目前帳號的有效權限（角色預設 ∪ 個人覆寫），來自 /api/admin/my-permissions */
  permissions?: string[]
}

// 使用者欄位即時搜尋（reporter 等空查詢只回前 ~50 推薦人，必須打名字才找得到其他人）
export function UserFieldSearch({ field, projectKey, issueTypeId, issueTypeName, email, onPick }: {
  field: NormalizedJiraField
  projectKey: string
  issueTypeId: string
  issueTypeName: string
  email: string
  onPick: (user: { id: string; label: string }) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ id: string; label: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const updateRect = () => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.bottom + 2, left: r.left, width: r.width })
  }

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const term = q.trim()
    if (term.length < 1) { setResults([]); setLoading(false); setOpen(false); return }
    setLoading(true); setOpen(true); updateRect()
    timer.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ projectKey, issueTypeId, issueTypeName, fieldKey: field.key, query: term })
        const r = await fetch(`/api/jira/field-users?${params.toString()}`, { headers: { 'x-jira-email': email } })
        const d = await r.json()
        setResults(d.ok && Array.isArray(d.users) ? d.users : [])
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 300)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q, projectKey, issueTypeId, issueTypeName, field.key, email])

  // 跟著捲動/縮放更新浮層位置（dropdown 用 portal+fixed 避免被表格裁切）
  useEffect(() => {
    if (!open) return
    const handler = () => updateRect()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => { window.removeEventListener('scroll', handler, true); window.removeEventListener('resize', handler) }
  }, [open])

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        value={q}
        onChange={e => setQ(e.target.value)}
        onFocus={() => { if (q.trim()) { setOpen(true); updateRect() } }}
        onBlur={() => { setTimeout(() => setOpen(false), 150) }}
        placeholder="搜尋使用者…"
        style={{ width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #2563eb30', borderRadius: 5, color: '#e2e8f0', fontSize: 11, padding: '3px 7px', outline: 'none' }} />
      {open && q.trim() && rect && createPortal(
        <div style={{ position: 'fixed', top: rect.top, left: rect.left, width: Math.max(rect.width, 190), zIndex: 9999, background: '#1e293b', border: '1px solid #334155', borderRadius: 6, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {loading ? <div style={{ padding: '6px 10px', fontSize: 11, color: '#64748b' }}>搜尋中…</div>
            : results.length === 0 ? <div style={{ padding: '6px 10px', fontSize: 11, color: '#64748b' }}>查無使用者</div>
            : results.map(u => (
              <button key={u.id} type="button"
                onMouseDown={e => { e.preventDefault(); onPick(u); setQ(''); setResults([]); setOpen(false) }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px', fontSize: 11, background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2563eb20' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
                {u.label}
              </button>
            ))}
        </div>, document.body)}
    </div>
  )
}

// Multi-user picker for 批量修改 multiuser fields (e.g. QA驗證人員)
export function MultiEditUserPicker({ members, loading, values, labels, onChange }: {
  members: { id: string; label: string }[]
  loading?: boolean
  values: string[]
  labels: string[]
  onChange: (ids: string[], labels: string[]) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (term ? members.filter(m => m.label.toLowerCase().includes(term)) : members)
      .filter(m => !values.includes(m.id))
  }, [q, members, values])

  const updateRect = () => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.bottom + 2, left: r.left, width: r.width })
  }

  const addUser = (id: string, lbl: string) => {
    onChange([...values, id], [...labels, lbl])
    setQ('')
    // Keep dropdown open for chaining additional selections
    setTimeout(() => { inputRef.current?.focus(); updateRect() }, 0)
  }
  const removeUser = (idx: number) => {
    onChange(values.filter((_, i) => i !== idx), labels.filter((_, i) => i !== idx))
  }

  return (
    <div style={{ flex: '1 1 0', minWidth: 160 }}>
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {values.map((id, i) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#1e3a5f', border: '1px solid #2563eb40', borderRadius: 4, padding: '2px 6px 2px 8px', fontSize: 11, color: '#93c5fd' }}>
              {labels[i] ?? id}
              <button type="button" onMouseDown={e => { e.preventDefault(); removeUser(i) }}
                style={{ background: 'none', border: 'none', color: '#f87149', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); updateRect() }}
          onFocus={() => { setOpen(true); updateRect() }}
          onBlur={() => setTimeout(() => { setOpen(false); setQ('') }, 150)}
          placeholder={loading ? '載入人員中…' : '搜尋並新增人員…'}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
        />
        {open && rect && createPortal(
          <div style={{ position: 'fixed', top: rect.top, left: rect.left, width: Math.max(rect.width, 220), zIndex: 9999, background: '#1e293b', border: '1px solid #334155', borderRadius: 6, maxHeight: 260, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
            {loading
              ? <div style={{ padding: '8px 12px', fontSize: 12, color: '#64748b' }}>載入中…</div>
              : filtered.length === 0
                ? <div style={{ padding: '8px 12px', fontSize: 12, color: '#64748b' }}>查無使用者（已選或查無符合）</div>
                : filtered.map(u => (
                  <button key={u.id} type="button"
                    onMouseDown={e => { e.preventDefault(); addUser(u.id, u.label) }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 12, background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2563eb30' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
                    {u.label}
                  </button>
                ))
            }
          </div>, document.body
        )}
      </div>
    </div>
  )
}

// Searchable user picker for 批量修改 manual mode
export function EditUserPicker({ members, loading, value, label, onChange }: {
  members: { id: string; label: string }[]
  loading?: boolean
  value: string
  label: string
  onChange: (id: string, label: string) => void
}) {
  const [q, setQ] = useState(label)
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setQ(label) }, [label])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return term ? members.filter(m => m.label.toLowerCase().includes(term)) : members
  }, [q, members])

  const updateRect = () => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.bottom + 2, left: r.left, width: r.width })
  }

  return (
    <div style={{ flex: '1 1 0', minWidth: 160, position: 'relative' }}>
      <input
        ref={inputRef}
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); updateRect() }}
        onFocus={() => { setOpen(true); updateRect() }}
        onBlur={() => setTimeout(() => { setOpen(false); if (!value) setQ('') }, 150)}
        placeholder={loading ? '載入人員中…' : '搜尋人員…'}
        style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, border: `1px solid ${value ? '#2563eb60' : '#2d3f55'}`, background: '#0f172a', color: value ? '#e2e8f0' : '#64748b', fontSize: 13 }}
      />
      {open && rect && createPortal(
        <div style={{ position: 'fixed', top: rect.top, left: rect.left, width: Math.max(rect.width, 220), zIndex: 9999, background: '#1e293b', border: '1px solid #334155', borderRadius: 6, maxHeight: 260, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {loading
            ? <div style={{ padding: '8px 12px', fontSize: 12, color: '#64748b' }}>載入中…</div>
            : filtered.length === 0
              ? <div style={{ padding: '8px 12px', fontSize: 12, color: '#64748b' }}>查無使用者</div>
              : filtered.map(u => (
                <button key={u.id} type="button"
                  onMouseDown={e => { e.preventDefault(); onChange(u.id, u.label); setQ(u.label); setOpen(false) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 12, background: u.id === value ? '#1e3a5f' : 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2563eb30' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = u.id === value ? '#1e3a5f' : 'none' }}>
                  {u.label}
                </button>
              ))
          }
        </div>, document.body
      )}
    </div>
  )
}

export function JiraPage({ account = null, isAdmin = false, permissions = [] }: JiraPageProps) {
  const isGame = useIsGameMode()
  const [qaSubMode, setQaSubMode] = useState<'create' | 'comment' | 'update' | 'edit'>('create')
  const [step, setStep] = useState<Step>(1)
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [currentAccount, setCurrentAccount] = useState<AccountInfo | null>(account)

  // Step 1
  const [members, setMembers] = useState<Member[]>([])
  const [, setMembersLoading] = useState(false)
  const [, setMembersError] = useState('')
  const [selectedAssignee, setSelectedAssignee] = useState('')
  const [projects, setProjects] = useState<{ id: string; key: string; name: string }[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [issueTypes, setIssueTypes] = useState<{ id: string; name: string }[]>([])
  const [selectedIssueTypeId, setSelectedIssueTypeId] = useState('')
  const [projectsLoading, setProjectsLoading] = useState(false)

  // Step 2
  const [sheetSource, setSheetSource] = useState<SheetSource>('lark')
  const [sheetUrl, setSheetUrl] = useState('')
  const [sheetLoading, setSheetLoading] = useState(false)
  const [sheetError, setSheetError] = useState('')
  const [sheetRecords, setSheetRecords] = useState<SheetRecord[]>([])
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([])

  // 跨批量工具共用「最後使用的 Sheet」——切換分頁時自動帶入網址 + 自動重新讀取一次，
  // 不用重複貼網址。只記錄「最後成功讀取的網址/來源」，不直接動各工具自己的原始資料
  // 狀態（sheetRecords 等），避免跟各工具既有的處理邏輯（trackedIssues 共用機制等）打架。
  const [lastSheetUrl, setLastSheetUrl] = useState('')
  const [lastSheetSource, setLastSheetSource] = useState<SheetSource>('lark')
  // 記錄「這個分頁上一次自動套用的是哪個 Sheet（url::source）」——不是單純
  // 「這個分頁本輪自動讀過了嗎」，這樣換了新 Sheet 後切回已經自動讀過的分頁
  // 還是會再自動讀一次最新的，只有同一份 Sheet 不會重複觸發（Codex review 建議）。
  const autoLoadedSubModes = useRef(new Map<string, string>())

  // Step 3
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})

  // Auto-detect filterable columns: 2–15 unique non-empty values
  const filterableColumns = useMemo(() => {
    if (!sheetRecords.length) return []
    return sheetHeaders.filter(h => {
      const vals = [...new Set(sheetRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))]
      return vals.length >= 2 && vals.length <= 15
    })
  }, [sheetHeaders, sheetRecords])

  // Unique values per filterable column (for dropdown options)
  const columnUniqueValues = useMemo<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {}
    for (const h of filterableColumns) {
      result[h] = [...new Set(sheetRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))].sort()
    }
    return result
  }, [filterableColumns, sheetRecords])

  // Apply column filters to records; always skip rows where "單子標題貼這" column is filled (already created)
  // Use flexible name matching to handle ↓ variants or extra whitespace in the column name
  const skipCreatedColKey = useMemo(() =>
    sheetHeaders.find(h => h.replace(/[\s↓]+/g, '').includes('單子標題貼這'))
  , [sheetHeaders])

  const filteredRecords = useMemo(() => {
    return sheetRecords.filter(r => {
      if (!Object.entries(columnFilters).every(([col, val]) => !val || (r[col] ?? '').trim() === val)) return false
      if (skipCreatedColKey && (r[skipCreatedColKey] ?? '').trim()) return false
      return true
    })
  }, [sheetRecords, columnFilters, skipCreatedColKey])

  // ── Comment/Edit Tab selection filters (step 2) — state only; memos declared after trackedIssues ──
  const [commentTabColFilters, setCommentTabColFilters] = useState<Record<string, string>>({})
  const [editTabColFilters, setEditTabColFilters] = useState<Record<string, string>>({})
  // 2026-08-12：Jira 即時狀態篩選——跟上面 Sheet 欄位篩選是不同資料來源（sheet 欄位 vs 即時抓回的 Jira
  // 狀態），單一字串不是 per-column，因為只有一個「目前狀態」欄位可篩
  const [editJiraStatusFilter, setEditJiraStatusFilter] = useState('')

  // Step 4 (create)
  const [submitting, setSubmitting] = useState(false)
  const [createProgress, setCreateProgress] = useState<{ done: number; total: number } | null>(null)
  const [createResults, setCreateResults] = useState<IssueCreateResult[]>([])
  const [pendingWritebackCount, setPendingWritebackCount] = useState(0)
  const [retryingWriteback, setRetryingWriteback] = useState(false)
  // Pending writebacks panel (persistent)
  const [pendingRows, setPendingRows] = useState<{ id: number; row_index: number; jira_key: string; jira_url: string; summary: string; status: string; error: string | null; attempt_count: number; created_at: number }[]>([])
  const [showPendingPanel, setShowPendingPanel] = useState(false)
  // Reconcile panel
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [reconcileProjectKey, setReconcileProjectKey] = useState('')
  const [reconcileSheetUrl, setReconcileSheetUrl] = useState('')
  const [reconcileFrom, setReconcileFrom] = useState('')
  const [reconcileTo, setReconcileTo] = useState('')
  const [reconcileLoading, setReconcileLoading] = useState(false)
  const [reconcileMatches, setReconcileMatches] = useState<{ rowIndex: number; sheetSummary: string; jiraKey: string; jiraSummary: string; jiraCreated: string; confidence: string }[]>([])
  const [reconcileUnmatchedJira, setReconcileUnmatchedJira] = useState<{ key: string; summary: string; created: string }[]>([])
  const [reconcileUnmatchedRows, setReconcileUnmatchedRows] = useState<{ rowIndex: number; sheetSummary: string }[]>([])
  const [reconcileSelected, setReconcileSelected] = useState<Set<number>>(new Set())
  const [reconcileApplying, setReconcileApplying] = useState(false)
  const [reconcileMsg, setReconcileMsg] = useState('')

  // Step 5 (comment)
  const [commentColumn, setCommentColumn] = useState('')
  const [attachmentColumn, setAttachmentColumn] = useState('')
  // 2026-08-20：原本一個 useAiComment 同時代表「AI 排版」與「AI 完整性分析」，拆成兩個獨立開關。
  // useAiComment 沿用原名代表「AI 排版」，避免把既有的其他引用點一起改名增加風險。
  const [useAiComment, setUseAiComment] = useState(false)
  const [useAiReview, setUseAiReview] = useState(false)
  // 逐列代發：選一個「填寫人」欄位，每一列各自用該列填寫人的身分張貼評論。
  // 名字→帳號的比對與授權判斷全在後端（/api/jira/comment-as-resolve），前端只顯示結果。
  const [personColumn, setPersonColumn] = useState('')
  const [personResolve, setPersonResolve] = useState<PersonResolveResult[]>([])
  const [personResolving, setPersonResolving] = useState(false)
  // 逐列覆寫「這一列用誰的身分張貼」。刻意是暫時性的：重進預覽／重新讀取 Sheet 都會清掉——
  // 那時候每一列的內容可能都不一樣了，沿用舊的指定有機會把評論用錯人的身分送出去
  // （跟 CodeX 討論定案）。
  const [rowCommentAs, setRowCommentAs] = useState<Record<number, string>>({})
  const [commentAsCandidates, setCommentAsCandidates] = useState<{ email: string; label: string; self: boolean }[]>([])
  const canAiFormat = isAdmin || permissions.includes('jira-ai-format')
  const canAiReview = isAdmin || permissions.includes('jira-ai-review')
  const aiFormatOn = useAiComment && canAiFormat
  const aiReviewOn = useAiReview && canAiReview
  const [selectedPromptId, setSelectedPromptId] = useState('default')
  const [availablePrompts, setAvailablePrompts] = useState<{ id: string; name: string }[]>([])
  const [commentModel, setCommentModel] = useState('gemini')
  const [specContext, setSpecContext] = useState('')
  const [kbDocs, setKbDocs] = useState<{ id: number; name: string; tags: string; content_length: number }[]>([])
  const [selectedKbDocIds, setSelectedKbDocIds] = useState<number[]>([])
  // Step 3 人員設定（批次預設）
  const [batchAssigneeIds, setBatchAssigneeIds] = useState<string[]>([])
  const [batchRdOwnerIds, setBatchRdOwnerIds] = useState<string[]>([])
  const [batchVerifierIds, setBatchVerifierIds] = useState<string[]>([])

  // Dynamic Jira field grid (Step 3 new UI)
  const [jiraFields, setJiraFields] = useState<NormalizedJiraField[]>([])
  const [fieldsLoading, setFieldsLoading] = useState(false)
  const [fieldsError, setFieldsError] = useState('')
  const [activeOptionalKeys, setActiveOptionalKeys] = useState<string[]>([])
  const [cellValues, setCellValues] = useState<Record<number, Record<string, string>>>({})
  const [cellErrors, setCellErrors] = useState<Record<number, Record<string, string>>>({})
  const [showFieldPicker, setShowFieldPicker] = useState(false)
  const [fieldPickerSearch, setFieldPickerSearch] = useState('')
  const [showBulkPanel, setShowBulkPanel] = useState(false)
  const [larkPrefillApplied, setLarkPrefillApplied] = useState(false)
  const [bulkValues, setBulkValues] = useState<Record<string, string>>({})

  // AI 摘要生成
  const [aiSummaryEnabled, setAiSummaryEnabled] = useState(false)
  const [aiPrefixColumns, setAiPrefixColumns] = useState<string[]>([])
  const [aiContentColumn, setAiContentColumn] = useState('')
  const [aiSummaryModel, setAiSummaryModel] = useState('')
  const [generatedSummaries, setGeneratedSummaries] = useState<Record<number, string>>({})
  const [summaryGenerating, setSummaryGenerating] = useState(false)
  const [summaryProgress, setSummaryProgress] = useState<{ done: number; total: number; failed?: number } | null>(null)

  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [pendingCommentRequestId, setPendingCommentRequestId] = useState('')
  const [commentProgress, setCommentProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [commentResults, setCommentResults] = useState<StageOpResult[]>([])

  // Preview mode state
  const [previewMode, setPreviewMode] = useState(false)
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([])
  const [prefetchLoading, setPrefetchLoading] = useState(false)
  const [prefetchError, setPrefetchError] = useState('')
  const [uploadingRows, setUploadingRows] = useState<Set<number>>(new Set())
  const [uploadErrors, setUploadErrors] = useState<Record<number, string>>({})

  // Step 6 (transition)
  const [transitionSubmitting, setTransitionSubmitting] = useState(false)
  const [transitionProgress, setTransitionProgress] = useState<{ done: number; total: number } | null>(null)
  const [transitionResults, setTransitionResults] = useState<StageOpResult[]>([])
  const [transitionOptions, setTransitionOptions] = useState<JiraTransitionOption[]>([])
  const [selectedTransitionId, setSelectedTransitionId] = useState('')
  const [transitionOptionsLoading, setTransitionOptionsLoading] = useState(false)
  const [transitionOptionsError, setTransitionOptionsError] = useState('')

  // ── Update mode ──
  type UpdateStep = 1 | 2 | 3
  type UpdateRecord = { issueKey: string; rowIndex: number }
  const [updateStep, setUpdateStep] = useState<UpdateStep>(1)
  const [updateBitableUrl, setUpdateBitableUrl] = useState('')
  const [updateTabSource, setUpdateTabSource] = useState<SheetSource>('lark')
  const [updateLoading, setUpdateLoading] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [updateRecords, setUpdateRecords] = useState<UpdateRecord[]>([])
  const [updateTabHeaders, setUpdateTabHeaders] = useState<string[]>([])
  const [updateTabRecords, setUpdateTabRecords] = useState<SheetRecord[]>([])
  const [updateTabColFilters, setUpdateTabColFilters] = useState<Record<string, string>>({})
  const [updateJiraStatusFilter, setUpdateJiraStatusFilter] = useState('')
  // Transitions
  const [updateTransitions, setUpdateTransitions] = useState<JiraTransitionOption[]>([])
  const [updateTransitionId, setUpdateTransitionId] = useState('')
  const [updateSubmitting, setUpdateSubmitting] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(null)
  const [updateResults, setUpdateResults] = useState<{ issueKey: string; ok: boolean; skipped?: boolean; error?: string }[]>([])
  const [updateJiraData, setUpdateJiraData] = useState<Record<string, Record<string, string>>>({})
  const [updateJiraLoading, setUpdateJiraLoading] = useState(false)
  const [updateJiraError, setUpdateJiraError] = useState('')
  const [updateSelectedKeys, setUpdateSelectedKeys] = useState<Set<string>>(new Set())
  const [updateValidationErrors, setUpdateValidationErrors] = useState<{ issueKey: string; missing: string[] }[]>([])
  const [updateTitleWritebackLoading, setUpdateTitleWritebackLoading] = useState(false)
  const [updateTitleWritebackMsg, setUpdateTitleWritebackMsg] = useState('')
  const [rdFieldDetecting, setRdFieldDetecting] = useState(false)
  const [rdFieldCandidates, setRdFieldCandidates] = useState<{ fieldId: string; fieldName: string; value: string }[] | null>(null)

  // ── Comment Tab (standalone 批量評論) ──
  const [commentTabUrl, setCommentTabUrl] = useState('')
  const [commentTabSource, setCommentTabSource] = useState<SheetSource>('lark')
  const [commentTabLoading, setCommentTabLoading] = useState(false)
  const [commentTabError, setCommentTabError] = useState('')
  const [commentTabStep, setCommentTabStep] = useState<1 | 2 | 3>(1) // 1=URL input, 2=select issues, 3=comment panel
  const [commentTabSelectedKeys, setCommentTabSelectedKeys] = useState<Set<string>>(new Set())

  // ── Edit Tab (批量修改) ──
  const [editTabUrl, setEditTabUrl] = useState('')
  const [editTabSource, setEditTabSource] = useState<SheetSource>('lark')
  const [editTabLoading, setEditTabLoading] = useState(false)
  const [editTabError, setEditTabError] = useState('')
  const [editTabStep, setEditTabStep] = useState<1 | 2 | 3 | 4>(1) // 1=URL, 2=select, 3=fields, 4=results
  const [editTabRecords, setEditTabRecords] = useState<SheetRecord[]>([])
  const [editTabHeaders, setEditTabHeaders] = useState<string[]>([])
  const [editTabIssues, setEditTabIssues] = useState<{ rowIndex: number; issueKey: string }[]>([])
  const [editTabSelectedKeys, setEditTabSelectedKeys] = useState<Set<string>>(new Set())
  type EditFieldMapping = {
    jiraField: string
    fieldType: NormalizedJiraField['type']
    fieldOptions: { id: string; label: string }[]
    mode: 'sheet' | 'manual'
    sheetColumn: string
    manualValue: string
    manualAccountId: string
    manualAccountIds: string[]
    manualLabels: string[]
  }
  const blankMapping = (): EditFieldMapping => ({ jiraField: 'summary', fieldType: 'string', fieldOptions: [], mode: 'sheet', sheetColumn: '', manualValue: '', manualAccountId: '', manualAccountIds: [], manualLabels: [] })
  const [editFieldMappings, setEditFieldMappings] = useState<EditFieldMapping[]>([blankMapping()])
  const [editTabSubmitting, setEditTabSubmitting] = useState(false)
  const [editProgress, setEditProgress] = useState<{ done: number; total: number } | null>(null)
  const [editTabResults, setEditTabResults] = useState<{ issueKey: string; ok: boolean; error?: string }[]>([])
  const [editTabJiraData, setEditTabJiraData] = useState<Record<string, Record<string, string>>>({})
  const [editTabJiraLoading, setEditTabJiraLoading] = useState(false)
  const [editTabJiraError, setEditTabJiraError] = useState('')
  const [editTabMembers, setEditTabMembers] = useState<Member[]>([])
  const [editTabMembersLoading, setEditTabMembersLoading] = useState(false)
  const [editTabAvailableFields, setEditTabAvailableFields] = useState<NormalizedJiraField[]>([])

  // ── 共用摘要前綴設定（批量開單 & 批量修改共用）──
  const [summaryPrefixEnabled, setSummaryPrefixEnabled] = useState(false)
  const [summaryPrefixTheme, setSummaryPrefixTheme] = useState('')
  const [summaryPrefixCols, setSummaryPrefixCols] = useState<string[]>([])

  // ── 批量開單 Step 3 — 描述圖片附件 ──
  const [descAttachCol, setDescAttachCol] = useState('')
  const [descAttachMap, setDescAttachMap] = useState<Record<number, CachedAttachment[]>>({})
  const [descPrefetchLoading, setDescPrefetchLoading] = useState(false)
  const [descUploadErrors, setDescUploadErrors] = useState<Record<number, string>>({})
  const [descLightboxSrc, setDescLightboxSrc] = useState<string | null>(null)

  // ── 批量修改 Step 3 — 描述圖片附件 ──
  const [editDescAttachMap, setEditDescAttachMap] = useState<Record<string, CachedAttachment[]>>({})
  const [editDescUploadErrors, setEditDescUploadErrors] = useState<Record<string, string>>({})
  const [editDescLightboxSrc, setEditDescLightboxSrc] = useState<string | null>(null)
  const [editDescAttachCol, setEditDescAttachCol] = useState('')
  const [editDescPrefetchLoading, setEditDescPrefetchLoading] = useState(false)

  // 追蹤所有已進入流程的 issue（本次 session 合併最新 stage）
  const [trackedIssues, setTrackedIssues] = useState<TrackedIssue[]>([])

  const emailHeader: Record<string, string> = currentAccount ? { 'x-jira-email': currentAccount.email } : {}

  // Compute summary prefix from a Sheet row (used in both create and edit flows)
  const computeSummaryPrefix = (row: Record<string, unknown>): string => {
    if (!summaryPrefixEnabled) return ''
    const parts: string[] = []
    if (summaryPrefixTheme.trim()) parts.push(`[${summaryPrefixTheme.trim()}]`)
    for (const col of summaryPrefixCols.filter(Boolean)) {
      const val = ((row[col] ?? '') as string).toString().trim()
      if (val) parts.push(`[${val}]`)
    }
    return parts.join('')
  }

  // Render shared summary prefix panel (called from both tabs)
  const renderSummaryPrefixPanel = (headers: string[], records?: Array<Record<string, unknown>>, summaryColKey?: string) => {
    const exampleRecord = records?.[0]
    const livePrefix = summaryPrefixEnabled && exampleRecord ? computeSummaryPrefix(exampleRecord) : null
    const exampleSummary = exampleRecord && summaryColKey ? ((exampleRecord[summaryColKey] ?? '') as string).toString().trim() : null
    return (
      <div style={{ marginBottom: 12, padding: '10px 14px', background: '#0b1929', border: `1px solid ${summaryPrefixEnabled ? '#2563eb60' : '#1e293b'}`, borderRadius: 8, overflow: 'hidden' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: summaryPrefixEnabled ? 12 : 0 }}>
          <input type="checkbox" checked={summaryPrefixEnabled} onChange={e => setSummaryPrefixEnabled(e.target.checked)} />
          <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 600 }}>自動組合摘要前綴</span>
          <span style={{ fontSize: 11, color: '#475569' }}>格式：[主題][類別1][類別2]...摘要</span>
        </label>
        {summaryPrefixEnabled && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: '#60a5fa', flexShrink: 0, width: 36 }}>主題：</span>
              <input value={summaryPrefixTheme} onChange={e => setSummaryPrefixTheme(e.target.value)}
                placeholder="輸入共用主題，例如：遊戲測試"
                style={{ flex: 1, padding: '5px 10px', borderRadius: 5, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
              />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: '#60a5fa', width: 36, flexShrink: 0 }}>類別：</span>
                <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: '3px 10px' }}
                  onClick={() => setSummaryPrefixCols(prev => [...prev, ''])}>+ 新增類別欄位</button>
              </div>
              {summaryPrefixCols.map((col, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, paddingLeft: 44, minWidth: 0 }}>
                  <select value={col} onChange={e => setSummaryPrefixCols(prev => prev.map((c, j) => j === i ? e.target.value : c))}
                    style={{ flex: '1 1 0', minWidth: 0, padding: '5px 10px', borderRadius: 5, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}>
                    <option value="">— 選擇 Sheet 欄位 —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <button type="button" onClick={() => setSummaryPrefixCols(prev => prev.filter((_, j) => j !== i))}
                    style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, paddingLeft: 44, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              {livePrefix !== null ? (
                <>
                  <span style={{ color: '#64748b' }}>第 1 列實際結果：</span>
                  <span style={{ color: '#34d399', fontWeight: 600 }}>{livePrefix || '（無前綴）'}</span>
                  <span style={{ color: '#94a3b8' }}>{exampleSummary ? exampleSummary.slice(0, 40) + (exampleSummary.length > 40 ? '...' : '') : '摘要內容'}</span>
                </>
              ) : (
                <>
                  <span style={{ color: '#475569' }}>預覽格式：</span>
                  <span style={{ color: '#60a5fa' }}>
                    {summaryPrefixTheme.trim() ? `[${summaryPrefixTheme.trim()}]` : ''}
                    {summaryPrefixCols.filter(Boolean).map((c, i) => <span key={i}>[{c}的值]</span>)}
                  </span>
                  <span style={{ color: '#94a3b8' }}>摘要內容</span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    )
  }


  useEffect(() => {
    if (!account) return
    setCurrentAccount(account)
    saveSessionAccount(account)
    const knownBoot = sessionStorage.getItem(BACKEND_BOOT_KEY) ?? ''
    if (knownBoot) sessionStorage.setItem(ACCOUNT_BOOT_KEY, knownBoot)
  }, [account])

  // 從 trackedIssues 中取出需要評論/切換的列
  const toComment    = trackedIssues.filter(t => t.stage === '已開單' || t.stage === '')
  const toTransition = trackedIssues.filter(t => t.stage === '添加評論')
  const transitionIssueKeyList = toTransition.map(t => t.issueKey).join('|')

  // ── Comment Tab selection filters (memos — declared after trackedIssues) ──
  const commentFilterableColumns = useMemo(() => {
    if (!sheetRecords.length) return []
    return sheetHeaders.filter(h => {
      const vals = [...new Set(sheetRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))]
      return vals.length >= 2 && vals.length <= 15
    })
  }, [sheetHeaders, sheetRecords])

  const commentColumnUniqueValues = useMemo<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {}
    for (const h of commentFilterableColumns) {
      result[h] = [...new Set(sheetRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))].sort()
    }
    return result
  }, [commentFilterableColumns, sheetRecords])

  const commentFilteredIssues = useMemo(() =>
    trackedIssues.filter(issue => {
      const rec = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      if (!rec) return true
      return Object.entries(commentTabColFilters).every(([col, val]) => !val || (rec[col] ?? '').trim() === val)
    })
  , [trackedIssues, sheetRecords, commentTabColFilters])

  // ── Edit Tab selection filters (memos — declared after editTabIssues) ──
  const editFilterableColumns = useMemo(() => {
    if (!editTabRecords.length) return []
    return editTabHeaders.filter(h => {
      const vals = [...new Set(editTabRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))]
      return vals.length >= 2 && vals.length <= 15
    })
  }, [editTabHeaders, editTabRecords])

  const editColumnUniqueValues = useMemo<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {}
    for (const h of editFilterableColumns) {
      result[h] = [...new Set(editTabRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))].sort()
    }
    return result
  }, [editFilterableColumns, editTabRecords])

  // Jira 即時狀態篩選選項——從目前已載入的 editTabJiraData 動態收集，不寫死 workflow 狀態清單，
  // 因為資料是非同步陸續回來的，用 editTabJiraData 整包當 dep，載入更多筆時選項自動補齊
  const editJiraStatusOptions = useMemo(() =>
    [...new Set(Object.values(editTabJiraData).map(d => (d.status ?? '').trim()).filter(Boolean))].sort()
  , [editTabJiraData])

  const editFilteredIssues = useMemo(() =>
    editTabIssues.filter(issue => {
      const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      const colOk = !rec || Object.entries(editTabColFilters).every(([col, val]) => !val || (rec[col] ?? '').trim() === val)
      if (!colOk) return false
      if (!editJiraStatusFilter) return true
      // 狀態篩選啟用時，還沒載入到 Jira 資料的列直接排除，不要模糊顯示（語意才準確）
      const status = editTabJiraData[issue.issueKey]?.status
      return status === editJiraStatusFilter
    })
  , [editTabIssues, editTabRecords, editTabColFilters, editJiraStatusFilter, editTabJiraData])

  // ── Update Tab selection filters (memos — declared after updateRecords) ──
  const updateFilterableColumns = useMemo(() => {
    if (!updateTabRecords.length) return []
    return updateTabHeaders.filter(h => {
      const vals = [...new Set(updateTabRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))]
      return vals.length >= 2 && vals.length <= 15
    })
  }, [updateTabHeaders, updateTabRecords])

  const updateColumnUniqueValues = useMemo<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {}
    for (const h of updateFilterableColumns) {
      result[h] = [...new Set(updateTabRecords.map(r => (r[h] ?? '').trim()).filter(Boolean))].sort()
    }
    return result
  }, [updateFilterableColumns, updateTabRecords])

  const updateJiraStatusOptions = useMemo(() =>
    [...new Set(Object.values(updateJiraData).map(d => (d.status ?? '').trim()).filter(Boolean))].sort()
  , [updateJiraData])

  const updateFilteredRecords = useMemo(() =>
    updateRecords.filter(rec => {
      const row = updateTabRecords.find(r => Number(r._rowIndex) === rec.rowIndex)
      const colOk = !row || Object.entries(updateTabColFilters).every(([col, val]) => !val || (row[col] ?? '').trim() === val)
      if (!colOk) return false
      if (!updateJiraStatusFilter) return true
      const status = updateJiraData[rec.issueKey]?.status
      return status === updateJiraStatusFilter
    })
  , [updateRecords, updateTabRecords, updateTabColFilters, updateJiraStatusFilter, updateJiraData])

  // 已經批量修改過的 issue key（處理階段＝已修改欄位），畫面上標示提醒使用者留意重複執行
  const editAlreadyEditedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const issue of editTabIssues) {
      const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      if (rec && getField(rec, STAGE_COL).trim() === EDIT_STAGE_DONE) set.add(issue.issueKey)
    }
    return set
  }, [editTabIssues, editTabRecords])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch('/api/health')
        const data = await resp.json() as { bootId?: string }
        const bootId = String(data.bootId ?? '')
        if (bootId) sessionStorage.setItem(BACKEND_BOOT_KEY, bootId)

        const acc = loadSessionAccount()
        const accountBootId = sessionStorage.getItem(ACCOUNT_BOOT_KEY) ?? ''
        if (acc && bootId && accountBootId && accountBootId === bootId) {
          if (!cancelled) setCurrentAccount(acc)
          return
        }

        if (acc) {
          sessionStorage.removeItem(SESSION_KEY)
          sessionStorage.removeItem(ACCOUNT_BOOT_KEY)
        }

        const authAccount = await fetchAuthAccount()
        if (!authAccount) return
        saveSessionAccount(authAccount)
        if (bootId) sessionStorage.setItem(ACCOUNT_BOOT_KEY, bootId)
        if (!cancelled) setCurrentAccount(authAccount)
      } catch {
        // 若 health 失敗，不做自動恢復，避免綁到未知後端實例
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let timer: number | undefined
    let stopped = false

    const clearAccountAfterBackendRestart = () => {
      if (!currentAccount) return
      setCurrentAccount(null)
      sessionStorage.removeItem(SESSION_KEY)
      sessionStorage.removeItem(ACCOUNT_BOOT_KEY)
      // 同步清掉流程資料，避免殘留上一個後端實例的執行狀態
      setStep(1)
      setCreateResults([]); setCommentResults([]); setTransitionResults([])
      setTrackedIssues([])
      setSheetRecords([]); setSheetHeaders([]); setSheetUrl(''); setSheetSource('lark')
      setSheetError('')
      setSelectedRows(new Set())
      setSelectedAssignee(''); setBatchAssigneeIds([]); setBatchRdOwnerIds([]); setBatchVerifierIds([])
      setCommentColumn(''); setAttachmentColumn(''); setUseAiComment(false); setSelectedPromptId('default')
      setDescAttachCol(''); setDescAttachMap({}); setDescUploadErrors({})
      setSelectedProjectId(''); setSelectedIssueTypeId(''); setIssueTypes([])
      setMembers([]); setMembersError(''); setMembersLoading(false)
      setPendingCommentRequestId(''); setCommentProgress(null)
    prevCommentKeysRef.current = new Set()
      setSubmitting(false); setCommentSubmitting(false); setTransitionSubmitting(false)
      setTransitionOptions([]); setSelectedTransitionId(''); setTransitionOptionsError(''); setTransitionOptionsLoading(false)
      setGeneratedSummaries({}); setSummaryProgress(null); setSummaryGenerating(false)
    }

    const checkBackendBoot = async () => {
      try {
        const resp = await fetch('/api/health')
        const data = await resp.json() as { ok?: boolean; bootId?: string }
        const bootId = String(data.bootId ?? '')
        if (!bootId) return
        const prev = sessionStorage.getItem(BACKEND_BOOT_KEY)
        if (!prev) {
          sessionStorage.setItem(BACKEND_BOOT_KEY, bootId)
          return
        }
        if (prev !== bootId) {
          sessionStorage.setItem(BACKEND_BOOT_KEY, bootId)
          clearAccountAfterBackendRestart()
        }
      } catch {
        // health 暫時不可用時忽略，待下一次輪詢
      }
    }

    void checkBackendBoot()
    timer = window.setInterval(() => {
      if (stopped) return
      void checkBackendBoot()
    }, 5000)

    return () => {
      stopped = true
      if (timer) window.clearInterval(timer)
    }
  }, [currentAccount])

  // Restore pending comment request on page mount (survives navigation / refresh)
  useEffect(() => {
    const savedId = localStorage.getItem(COMMENT_PENDING_KEY)
    if (!savedId) return
    const acc = loadSessionAccount()
    if (!acc) { localStorage.removeItem(COMMENT_PENDING_KEY); return }

    let alive = true
    ;(async () => {
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(
            `/api/jira/batch-comment/status/${encodeURIComponent(savedId)}`,
            { headers: { 'x-jira-email': acc.email } },
          )
          const d = await r.json() as {
            ok: boolean
            status?: 'running' | 'done' | 'missing'
            progress?: { done: number; total: number; current: string }
            result?: { ok: boolean; results?: StageOpResult[]; stopped?: boolean; stoppedReason?: string; stoppedKind?: 'ai_quota' | 'worker_restart' }
          }
          if (!alive) return
          if (!d.ok || d.status === 'missing') { localStorage.removeItem(COMMENT_PENDING_KEY); return }
          if (d.progress) setCommentProgress(d.progress)
          if (d.status === 'running') {
            await new Promise(resolve => setTimeout(resolve, 2000))
            continue
          }
          if (d.result) {
            const results = d.result.results ?? []
            if (d.result.stopped && d.result.stoppedReason) {
              results.push(buildCommentStoppedRow(d.result.stoppedReason, d.result.stoppedKind))
            }
            setCommentResults(results)
            setStep(5)
            localStorage.removeItem(COMMENT_PENDING_KEY)
            return
          }
          localStorage.removeItem(COMMENT_PENDING_KEY)
          return
        } catch {
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }
    })()

    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 逐列下拉的候選名單（自己 ＋ 對我有代理授權的帳號），由後端算好回傳
  useEffect(() => {
    if (!currentAccount) { setCommentAsCandidates([]); return }
    let alive = true
    ;(async () => {
      try {
        const r = await fetch('/api/jira/comment-as-candidates')
        const d = await r.json() as { ok: boolean; candidates?: { email: string; label: string; self: boolean }[] }
        if (alive) setCommentAsCandidates(d.ok ? (d.candidates ?? []) : [])
      } catch { if (alive) setCommentAsCandidates([]) }
    })()
    return () => { alive = false }
  }, [currentAccount])

  // 選了填寫人欄位後，把這批要處理的列上出現過的名字送去後端解析（不重複），
  // 回傳每個名字對應的帳號與狀態，送出前用來擋住有問題的批次。
  useEffect(() => {
    if (!personColumn || toComment.length === 0) { setPersonResolve([]); return }
    const names = Array.from(new Set(
      toComment.map(issue => {
        const rec = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
        return rec ? getField(rec, personColumn).trim() : ''
      }).filter(Boolean),
    ))
    if (names.length === 0) { setPersonResolve([]); return }
    let alive = true
    setPersonResolving(true)
    ;(async () => {
      try {
        const r = await fetch('/api/jira/comment-as-resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...emailHeader },
          body: JSON.stringify({ names }),
        })
        const d = await r.json() as { ok: boolean; results?: PersonResolveResult[] }
        if (!alive) return
        setPersonResolve(d.ok ? (d.results ?? []) : [])
      } catch { if (alive) setPersonResolve([]) }
      finally { if (alive) setPersonResolving(false) }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personColumn, trackedIssues, sheetRecords])

  const fetchMembers = useCallback(async (email: string, projectKey?: string) => {
    setMembersLoading(true); setMembersError(''); setMembers([])
    try {
      const url = projectKey
        ? `/api/jira/members?projectKey=${encodeURIComponent(projectKey)}`
        : '/api/jira/members'
      const resp = await fetch(url, { headers: { 'x-jira-email': email } })
      const data = await resp.json()
      if (!data.ok) setMembersError(data.message ?? '取得成員失敗')
      else setMembers(data.members)
    } catch { setMembersError('網路錯誤') }
    finally { setMembersLoading(false) }
  }, [])

  const fetchProjects = useCallback(async (email: string) => {
    setProjectsLoading(true)
    try {
      const resp = await fetch('/api/jira/projects', { headers: { 'x-jira-email': email } })
      const data = await resp.json()
      if (data.ok) {
        setProjects(data.projects)
        if (data.projects.length === 1) setSelectedProjectId(data.projects[0].id)
      }
    } catch {}
    finally { setProjectsLoading(false) }
  }, [])

  const fetchIssueTypes = useCallback(async (email: string, projectId: string) => {
    setIssueTypes([]); setSelectedIssueTypeId('')
    try {
      const resp = await fetch(`/api/jira/issuetypes?projectId=${projectId}`, { headers: { 'x-jira-email': email } })
      const data = await resp.json()
      if (data.ok) {
        setIssueTypes(data.issueTypes)
        if (data.issueTypes.length === 1) setSelectedIssueTypeId(data.issueTypes[0].id)
      }
    } catch {}
  }, [])

  useEffect(() => { if (currentAccount) fetchProjects(currentAccount.email) }, [currentAccount, fetchProjects])
  useEffect(() => {
    if (currentAccount && selectedProjectId) {
      const project = projects.find(p => p.id === selectedProjectId)
      fetchIssueTypes(currentAccount.email, selectedProjectId)
      if (project) fetchMembers(currentAccount.email, project.key)
    }
  }, [currentAccount, selectedProjectId, projects, fetchIssueTypes, fetchMembers])

  // Fetch Jira dynamic fields when entering Step 3
  useEffect(() => {
    console.log('[jira-fields] effect fired', { step, selectedProjectId, selectedIssueTypeId, projectsLoaded: projects.length, issueTypesLoaded: issueTypes.length, account: currentAccount?.email })
    if (step !== 3 || !currentAccount || !selectedProjectId || !selectedIssueTypeId) {
      console.log('[jira-fields] early return: guard failed', { step, hasAccount: !!currentAccount, selectedProjectId, selectedIssueTypeId })
      return
    }
    const project = projects.find(p => p.id === selectedProjectId)
    const issueType = issueTypes.find(t => t.id === selectedIssueTypeId)
    console.log('[jira-fields] found project:', project, 'issueType:', issueType)
    // If projects/issueTypes not yet loaded, wait for next render (they're in deps below)
    if (!project || !issueType) {
      console.log('[jira-fields] early return: project/issueType not found in arrays')
      return
    }
    console.log('[jira-fields] calling API', `/api/jira/fields?projectKey=${project.key}&issueTypeId=${issueType.id}&issueTypeName=${issueType.name}`)
    setFieldsLoading(true); setFieldsError(''); setJiraFields([]); setActiveOptionalKeys([]); setCellValues({}); setCellErrors({}); setLarkPrefillApplied(false)
    fetch(`/api/jira/fields?projectKey=${encodeURIComponent(project.key)}&issueTypeId=${encodeURIComponent(issueType.id)}&issueTypeName=${encodeURIComponent(issueType.name)}`, {
      headers: { 'x-jira-email': currentAccount.email },
    })
      .then(r => r.json())
      .then((d: { ok: boolean; fields?: NormalizedJiraField[]; message?: string }) => {
        console.log('[jira-fields] API response:', d)
        if (d.ok && d.fields) setJiraFields(d.fields)
        else setFieldsError(d.message ?? '載入欄位失敗')
      })
      .catch((err) => {
        console.error('[jira-fields] fetch error:', err)
        setFieldsError('網路錯誤，無法載入欄位')
      })
      .finally(() => setFieldsLoading(false))
  }, [step, selectedProjectId, selectedIssueTypeId, projects, issueTypes, currentAccount])

  // 載入 Prompt 清單
  useEffect(() => {
    fetch('/api/gemini/prompts')
      .then(r => r.json())
      .then((d: { prompts?: { id: string; name: string }[] }) => {
        if (d.prompts) setAvailablePrompts(d.prompts.map(p => ({ id: p.id, name: p.name })))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (step !== 6 || !currentAccount || toTransition.length === 0) {
      setTransitionOptions([])
      setSelectedTransitionId('')
      setTransitionOptionsError('')
      return
    }

    let alive = true
    const firstIssueKey = toTransition[0].issueKey
    setTransitionOptionsLoading(true)
    setTransitionOptionsError('')

    fetch(`/api/jira/transitions?issueKey=${encodeURIComponent(firstIssueKey)}`, {
      headers: { 'x-jira-email': currentAccount.email },
    })
      .then(r => r.json())
      .then((data: { ok: boolean; transitions?: JiraTransitionOption[]; message?: string }) => {
        if (!alive) return
        const transitions = data.transitions ?? []
        if (data.ok && transitions.length > 0) {
          setTransitionOptions(transitions)
          setSelectedTransitionId(prev => transitions.some(t => t.id === prev) ? prev : transitions[0].id)
        } else {
          setTransitionOptions([])
          setSelectedTransitionId('')
          setTransitionOptionsError(data.message ?? '無法取得可切換狀態')
        }
      })
      .catch((error) => {
        if (!alive) return
        setTransitionOptions([])
        setSelectedTransitionId('')
        setTransitionOptionsError(String(error))
      })
      .finally(() => {
        if (alive) setTransitionOptionsLoading(false)
      })

    return () => { alive = false }
  }, [step, currentAccount, transitionIssueKeyList])

  // 載入知識庫文件清單
  useEffect(() => {
    fetch('/api/knowledge/docs')
      .then(r => r.json())
      .then((d: { ok: boolean; docs?: { id: number; name: string; tags: string; content_length: number }[] }) => {
        if (d.ok && d.docs) setKbDocs(d.docs.filter(doc => doc.content_length > 0))
      })
      .catch(() => {})
  }, [])

  // Auto-detect "圖" column for attachment prefetch
  useEffect(() => {
    if (sheetHeaders.includes('圖') && !descAttachCol) {
      setDescAttachCol('圖')
    }
  }, [sheetHeaders]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAccountSelected = (acc: AccountInfo) => {
    setCurrentAccount(acc)
    saveSessionAccount(acc)
    const knownBoot = sessionStorage.getItem(BACKEND_BOOT_KEY) ?? ''
    if (knownBoot) {
      sessionStorage.setItem(ACCOUNT_BOOT_KEY, knownBoot)
    } else {
      void fetch('/api/health')
        .then(r => r.json())
        .then((d: { bootId?: string }) => {
          const bootId = String(d.bootId ?? '')
          if (!bootId) return
          sessionStorage.setItem(BACKEND_BOOT_KEY, bootId)
          sessionStorage.setItem(ACCOUNT_BOOT_KEY, bootId)
        })
        .catch(() => {})
    }
    setMembers([]); setProjects([]); setIssueTypes([])
    setSelectedProjectId(''); setSelectedIssueTypeId('')
    fetchProjects(acc.email)
  }

  // ── Step 2: 讀 Sheet ──
  const handleFetchSheet = async () => {
    if (!sheetUrl.trim()) return
    setSheetLoading(true); setSheetError(''); setSheetRecords([])
    const endpoint = sheetSource === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: sheetUrl.trim() }),
      })
      const data = await resp.json()
      if (!data.ok) {
        const detail = data.detail ? `\n${JSON.stringify(data.detail, null, 2)}` : ''
        setSheetError((data.message ?? '讀取失敗') + detail)
      } else {
        setSheetHeaders(data.headers)
        setSheetRecords(data.records)
        // Auto-select all rows; already-created rows will be excluded by filteredRecords filter
        setSelectedRows(new Set(data.records.map((r: SheetRecord) => Number(r._rowIndex))))
        setColumnFilters({})
        setStep(3)
        setLastSheetUrl(sheetUrl.trim()); setLastSheetSource(sheetSource)
      }
    } catch { setSheetError('網路錯誤') }
    finally { setSheetLoading(false) }
  }

  // ── 重新讀取 Sheet（不切換 step，避免使用者中途更新 Sheet 後要整頁重來）──
  // 每個 Tab 各自獨立的「已重新讀取」訊息，切換 Tab 不會互相殘留
  const [createReloadMsg, setCreateReloadMsg] = useState('')
  const [commentReloadMsg, setCommentReloadMsg] = useState('')
  // 重新讀取時要分辨「這個 key 上次就在清單裡（沿用使用者的勾選）」還是「這次才新出現（套白名單）」
  const prevCommentKeysRef = useRef<Set<string>>(new Set())
  const [editReloadMsg, setEditReloadMsg] = useState('')
  const [updateReloadMsg, setUpdateReloadMsg] = useState('')
  const handleReloadCreateSheet = async () => {
    if (!sheetUrl.trim()) return
    setSheetLoading(true); setSheetError(''); setCreateReloadMsg('')
    try {
      const endpoint = sheetSource === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: sheetUrl.trim() }),
      })
      const data = await resp.json()
      if (!data.ok) { setSheetError(data.message ?? '讀取失敗'); return }
      setSheetHeaders(data.headers)
      setSheetRecords(data.records)
      const freshIdx: Set<number> = new Set(data.records.map((r: SheetRecord) => Number(r._rowIndex)))
      setSelectedRows(prev => new Set([...prev, ...freshIdx].filter(i => freshIdx.has(i))))
      setCreateReloadMsg(`通過 已重新讀取（${data.records.length} 筆）`)
    } catch { setSheetError('網路錯誤') }
    finally { setSheetLoading(false) }
  }

  const toggleRow = (i: number) => {
    setSelectedRows(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })
  }

  // ── AI 摘要生成 ──
  const handleGenerateSummaries = async () => {
    if (!aiContentColumn || summaryGenerating) return
    const targets = filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex)) && needsCreate(r))
    if (targets.length === 0) return
    setSummaryGenerating(true)
    setSummaryProgress({ done: 0, total: targets.length, failed: 0 })
    const batchSize = 5
    const newSummaries: Record<number, string> = { ...generatedSummaries }
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize)
      const rows = batch.map(r => {
        const rowIdx = Number(r._rowIndex)
        const prefix = aiPrefixColumns
          .map(col => { const v = (r[col] ?? '').trim(); return v ? `[${v}]` : '' })
          .join('')
        const content = (r[aiContentColumn] ?? '').trim()
        return { rowIndex: rowIdx, prefix, content }
      })
      try {
        const resp = await fetch('/api/jira/generate-summaries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...emailHeader },
          body: JSON.stringify({ rows, modelSpec: aiSummaryModel || undefined }),
        })
        const data = await resp.json() as { ok: boolean; results?: { rowIndex: number; summary: string; error?: string }[] }
        if (data.ok && data.results) {
          let batchFailed = 0
          data.results.forEach(r => {
            if (r.error) { batchFailed++; return }
            newSummaries[r.rowIndex] = r.summary
          })
          setGeneratedSummaries({ ...newSummaries })
          if (batchFailed > 0) setSummaryProgress(p => p ? { ...p, failed: (p.failed ?? 0) + batchFailed } : p)
        }
      } catch { /* continue on error */ }
      setSummaryProgress(p => p ? { ...p, done: Math.min(i + batchSize, targets.length) } : p)
    }
    setSummaryGenerating(false)
  }

  // ── Dynamic field helpers ──
  // 強制必填欄位：即使 Jira 標記為選填，這幾欄也一律自動顯示並要求填寫
  // （摘要 = summary 已是 Jira 必填；這裡補上 描述/受託人/RD負責人/回報人）
  const isForcedRequiredField = (f: NormalizedJiraField) =>
    f.key === 'description' ||
    f.key === 'assignee' ||
    f.key === 'reporter' ||
    f.key === 'customfield_10428' ||
    f.name.includes('RD負責人')
  const isFieldRequired = (f: NormalizedJiraField) => f.required || isForcedRequiredField(f)
  const requiredJiraFields = jiraFields.filter(isFieldRequired)
  const optionalJiraFields = jiraFields.filter(f => !isFieldRequired(f))
  const activeOptionalJiraFields = optionalJiraFields.filter(f => activeOptionalKeys.includes(f.key))
  const inactiveOptionalJiraFields = optionalJiraFields.filter(f => !activeOptionalKeys.includes(f.key))
  const visibleJiraFields = [...requiredJiraFields, ...activeOptionalJiraFields]

  const setCellValue = (rowIdx: number, fieldKey: string, value: string) => {
    setCellValues(prev => ({ ...prev, [rowIdx]: { ...(prev[rowIdx] ?? {}), [fieldKey]: value } }))
    setCellErrors(prev => {
      if (!prev[rowIdx]?.[fieldKey]) return prev
      const rowErrs = { ...prev[rowIdx] }
      delete rowErrs[fieldKey]
      return { ...prev, [rowIdx]: rowErrs }
    })
  }

  const applyBulkColumn = (fieldKey: string, val: string) => {
    setCellValues(prev => {
      const next = { ...prev }
      for (const r of filteredRecords) {
        const rowIdx = Number(r._rowIndex)
        next[rowIdx] = { ...(next[rowIdx] ?? {}), [fieldKey]: val }
      }
      return next
    })
  }

  // 把即時搜尋到的使用者併入欄位 options（去重），讓批量與每列下拉都選得到
  const mergeFieldUsers = (fieldKey: string, users: { id: string; label: string }[]) => {
    setJiraFields(prev => prev.map(f => {
      if (f.key !== fieldKey) return f
      const existing = f.options ?? []
      const ids = new Set(existing.map(o => o.id))
      const merged = [...existing, ...users.filter(u => u.id && !ids.has(u.id))]
      return { ...f, options: merged }
    }))
  }
  const searchProjectKey = projects.find(p => p.id === selectedProjectId)?.key ?? ''
  const searchIssueTypeName = issueTypes.find(t => t.id === selectedIssueTypeId)?.name ?? ''

  const userOptionsForField = (field: NormalizedJiraField) => {
    const memberOptions = members.map(m => ({ id: m.accountId, label: m.displayName }))
    if (!field.options?.length) return memberOptions
    const ids = new Set(field.options.map(o => o.id))
    return [...field.options, ...memberOptions.filter(m => !ids.has(m.id))]
  }

  const userLabelForField = (field: NormalizedJiraField, accountId: string) =>
    userOptionsForField(field).find(x => x.id === accountId)?.label ?? accountId

  const resolveUserValueForField = (field: NormalizedJiraField, rawValue: string) => {
    const value = rawValue.trim()
    const lowered = value.toLowerCase()
    const option = userOptionsForField(field).find(x =>
      x.id.toLowerCase() === lowered || x.label.toLowerCase() === lowered
    )
    return option?.id ?? value
  }

  const handleDescPrefetch = async (colOverride?: string) => {
    const targetCol = colOverride ?? descAttachCol
    if (!targetCol) return
    setDescPrefetchLoading(true)
    const colIdx = sheetHeaders.indexOf(targetCol)
    const columnLetter = colIdx >= 0 ? (() => {
      let i = colIdx + 1; let letter = ''
      while (i > 0) { letter = String.fromCharCode(64 + (i % 26 || 26)) + letter; i = Math.floor((i - 1) / 26) }
      return letter
    })() : undefined
    const allRows = filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex)))
    const groups = allRows.map(r => {
      const rowIndex = Number(r._rowIndex)
      const linkRaw = (r[`${targetCol}__url`] ?? '') as string
      const raw = getField(r, targetCol)
      const sourceText = linkRaw || raw
      const urls = sourceText ? sourceText.split(/[\n,]/).map((s: string) => s.trim()).filter(Boolean) : []
      return { rowIndex, urls }
    })
    const larkSheetContext = columnLetter ? { sheetUrl, columnLetter } : undefined
    try {
      const resp = await fetch('/api/jira/attachment-prefetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ groups, larkSheetContext }),
      })
      const data = await resp.json() as { ok: boolean; result?: { rowIndex: number; attachments: CachedAttachment[] }[] }
      if (data.ok && data.result) {
        const newMap: Record<number, CachedAttachment[]> = {}
        for (const g of data.result) {
          if (g.attachments.length > 0) newMap[g.rowIndex] = g.attachments
        }
        setDescAttachMap(prev => ({ ...prev, ...newMap }))
      }
    } catch { /* ignore */ }
    finally { setDescPrefetchLoading(false) }
  }

  const handleEditDescPrefetch = async () => {
    if (!editDescAttachCol) return
    setEditDescPrefetchLoading(true)
    const colIdx = editTabHeaders.indexOf(editDescAttachCol)
    const columnLetter = colIdx >= 0 ? (() => {
      let i = colIdx + 1; let letter = ''
      while (i > 0) { letter = String.fromCharCode(64 + (i % 26 || 26)) + letter; i = Math.floor((i - 1) / 26) }
      return letter
    })() : undefined
    const selectedIssues = editTabIssues.filter(i => editTabSelectedKeys.has(i.issueKey))
    const groups = selectedIssues.map(issue => {
      const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      const linkRaw = rec ? ((rec[`${editDescAttachCol}__url`] ?? '') as string) : ''
      const raw = rec ? getField(rec, editDescAttachCol) : ''
      const sourceText = linkRaw || raw
      const urls = sourceText ? sourceText.split(/[\n,]/).map((s: string) => s.trim()).filter(Boolean) : []
      return { rowIndex: issue.rowIndex, urls }
    })
    const larkSheetContext = columnLetter ? { sheetUrl: editTabUrl, columnLetter } : undefined
    try {
      const resp = await fetch('/api/jira/attachment-prefetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ groups, larkSheetContext }),
      })
      const data = await resp.json() as { ok: boolean; result?: { rowIndex: number; attachments: CachedAttachment[] }[] }
      if (data.ok && data.result) {
        const rowToIssue = new Map(selectedIssues.map(i => [i.rowIndex, i.issueKey]))
        const newMap: Record<string, CachedAttachment[]> = {}
        for (const g of data.result) {
          const issueKey = rowToIssue.get(g.rowIndex)
          if (issueKey && g.attachments.length > 0) newMap[issueKey] = g.attachments
        }
        setEditDescAttachMap(prev => ({ ...prev, ...newMap }))
      }
    } catch { /* ignore */ }
    finally { setEditDescPrefetchLoading(false) }
  }

  const applyLarkPrefill = () => {
    const newVals: Record<number, Record<string, string>> = {}
    // select/multiselect：Sheet 原始文字（例如「簡單」）要先解析成 Jira 選項 id 才能存進 cellValues，
    // 不然 <select> 元素比對不到任何 option value，畫面上只會顯示空白「— 選擇 —」，帶入等於白做。
    // 解析不到的情況（Sheet 有值但不是有效選項）不寫進 cellValues（反正 <select> 也放不進去），改記
    // 進 prefillErrors，馬上讓使用者看到紅框+原因，不用等按送出才發現這格資料其實沒有真的帶進去
    // （2026-08-12，跟 CodeX 討論定案：不要靜默跳過，避免看起來帶了、實際上資料默默不見）
    const prefillErrors: Record<number, Record<string, string>> = {}
    for (const record of filteredRecords) {
      const rowIdx = Number(record._rowIndex)
      const rowVals: Record<string, string> = {}
      for (const field of jiraFields) {
        // Try exact column name match (case-insensitive), also try Lark aliases
        const aliases = field.key === 'summary'
          ? [field.name, '摘要', 'summary']
          : FORCED_LARK_ALIAS[field.key]
            ? [field.name, FORCED_LARK_ALIAS[field.key], field.key]
            : [field.name, field.key]
        for (const alias of aliases) {
          let val = getField(record, alias).trim()
          if (!val) continue
          // For user/multiuser fields: resolve to valid accountId, skip if not found
          if (field.type === 'user' || field.type === 'multiuser') {
            const ids = val.split(',').map(v => v.trim()).filter(Boolean)
            const resolved = ids.map(id => {
              if (members.some(m => m.accountId === id)) return id
              return members.find(m => m.displayName?.toLowerCase() === id.toLowerCase())?.accountId ?? ''
            }).filter(Boolean)
            val = resolved.join(',')
          }
          // For select/multiselect: resolve Sheet label text to the Jira option id
          if ((field.type === 'select' || field.type === 'multiselect') && field.options) {
            const parts = field.type === 'multiselect' ? splitMultiselectRaw(val) : [val]
            const resolvedIds = parts.map(p => resolveSelectOptionId(field, p))
            if (resolvedIds.some(id => !id)) {
              const badParts = parts.filter((_, i) => !resolvedIds[i])
              if (!prefillErrors[rowIdx]) prefillErrors[rowIdx] = {}
              const preview = field.options.slice(0, 3).map(o => o.label).join('、')
              const more = field.options.length > 3 ? '...' : ''
              prefillErrors[rowIdx][field.key] = `${field.name}：Sheet 值「${badParts.join('、')}」對不到 Jira 選項。可選：${preview}${more}`
              val = ''
            } else {
              val = resolvedIds.join(',')
            }
          }
          // For date: Sheet 原始值可能是 Lark 序列數字或格式化字串，轉成 <input type="date"> 需要的 YYYY-MM-DD
          if (field.type === 'date') {
            const iso = normalizeDateValue(val)
            if (!iso) {
              if (!prefillErrors[rowIdx]) prefillErrors[rowIdx] = {}
              prefillErrors[rowIdx][field.key] = `${field.name}：「${val}」不是可辨識的日期格式`
              val = ''
            } else {
              val = iso
            }
          }
          if (val) { rowVals[field.key] = val; break }
        }
      }
      if (Object.keys(rowVals).length > 0) newVals[rowIdx] = rowVals
    }
    if (Object.keys(prefillErrors).length > 0) {
      setCellErrors(prev => {
        const merged: Record<number, Record<string, string>> = { ...prev }
        for (const [ri, errs] of Object.entries(prefillErrors)) {
          merged[Number(ri)] = { ...(merged[Number(ri)] ?? {}), ...errs }
        }
        return merged
      })
    }
    setCellValues(prev => {
      const merged: Record<number, Record<string, string>> = { ...prev }
      for (const [ri, vals] of Object.entries(newVals)) {
        merged[Number(ri)] = { ...(merged[Number(ri)] ?? {}), ...vals }
      }
      return merged
    })
    setLarkPrefillApplied(true)
    // Auto-prefetch the "圖" attachment column if it exists
    const attachCol = descAttachCol || (sheetHeaders.includes('圖') ? '圖' : '')
    if (attachCol) {
      if (!descAttachCol) setDescAttachCol(attachCol)
      void handleDescPrefetch(attachCol)
    }
  }

  // 動態欄位模式下，欄位定義載入完成後、或重新讀取 Sheet 後，自動套用 Lark 帶入（不用再手動點一次）
  useEffect(() => {
    if (step !== 3 || jiraFields.length === 0 || filteredRecords.length === 0) return
    applyLarkPrefill()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jiraFields, sheetRecords])

  // 2026-08-12 修正：select/multiselect 從 Lark 帶入時，Sheet 打的是人看得懂的文字（例如「簡單」），
  // 但 Jira 真正的選項 id 是內部代碼（例如「10023」），先前直接把 Sheet 文字當 id 送出去，格式一定不對、
  // 開單會失敗。改成拿 rawVal 去比對 field.options[].label（trim、不分大小寫），比對不到才退而比對 .id
  // 本身（方便進階使用者直接填 id）。跟 CodeX 討論後決定：任何比對不到的值都要在送出前擋下來、寫進
  // cellErrors 讓使用者自己修正或清空，不能靜默跳過欄位——否則畫面上看得到值、送出後卻悄悄不見，
  // 使用者完全不會發現資料遺失。
  const resolveSelectOptionId = (field: NormalizedJiraField, rawVal: string): string | null => {
    if (!field.options) return null
    const v = rawVal.trim()
    const byLabel = field.options.find(o => o.label.trim().toLowerCase() === v.toLowerCase())
    if (byLabel) return byLabel.id
    const byId = field.options.find(o => o.id === v)
    return byId ? byId.id : null
  }
  // multiselect 的 Sheet 原始值可能用逗號或頓號或換行分隔多個選項
  const splitMultiselectRaw = (rawVal: string): string[] =>
    rawVal.split(/[,、\n]+/).map(v => v.trim()).filter(Boolean)

  // 2026-08-12：date 欄位從 Lark 帶入——已用真實 Sheet 資料驗證，Lark Sheets API 的日期欄位原始值
  // 不是字串，是「序列數字」（Excel/Lotus 慣例，第 0 天 = 1899-12-30），畫面上看到的「2026/8/1」是
  // Lark 前端自己格式化顯示的，API 給的原始值其實是 46235 這種數字（已用真實資料反推驗證吻合）。
  // 也順便接受已經是 YYYY-MM-DD / YYYY/MM/DD 字串格式的情況（保險，不同 Sheet 欄位設定可能不同）。
  // 兩種都解析不出來就回傳 null，不用 new Date(rawVal) 硬吞字串（時區/瀏覽器解析容易產生偏移）。
  const LARK_DATE_SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30)
  // 驗證真的是存在的日曆日期（拒絕 2026-02-31 這種會被 JS Date 自動 rollover 成 2026-03-03 的無效日期）
  const isValidCalendarDate = (y: number, mo: number, d: number): boolean => {
    if (mo < 1 || mo > 12 || d < 1) return false
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    return d <= daysInMonth
  }
  const normalizeDateValue = (rawVal: string): string | null => {
    const v = rawVal.trim()
    if (!v) return null
    // 只接受整數序列（沒有真實資料證實 Lark 會用小數表示時分，先不處理，避免猜錯語意）
    if (/^\d+$/.test(v)) {
      const serial = parseInt(v, 10)
      if (serial <= 0) return null
      const d = new Date(LARK_DATE_SERIAL_EPOCH_MS + serial * 86400000)
      if (isNaN(d.getTime())) return null
      const year = d.getUTCFullYear()
      if (year < 1900 || year > 2447) return null // 換算後的年份要落在合理範圍，避免誤判其他數字欄位
      return d.toISOString().slice(0, 10)
    }
    const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
    if (m) {
      const [, y, mo, d] = m
      const year = Number(y), mon = Number(mo), day = Number(d)
      if (isValidCalendarDate(year, mon, day)) return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
    return null
  }

  // ── 開單摘要的單一取值來源 ──
  // 摘要有三個可能來源（AI 生成 / Step 3 手動填寫 / Sheet 原始欄位），先前散在四個地方各自
  // 寫一組 fallback，順序還不一致：validateDynamicFields() 只讀 cellValues，但 AI 生成的摘要
  // 其實存在另一個 state（generatedSummaries），造成「畫面看得到摘要、驗證卻說是空的」——
  // Sheet 沒有「摘要」欄時（改用 AI 生成的情境）必填驗證會整批擋下來。統一由這支 helper 供
  // 驗證/送出/回填共用，避免再長出第四套順序（2026-08-19，跟 CodeX 討論定案）。
  const resolveRowSummary = (rowIdx: number, record?: SheetRecord): string => {
    const fromAi = generatedSummaries[rowIdx]?.trim()
    if (fromAi) return fromAi
    const fromCell = cellValues[rowIdx]?.['summary']?.trim()
    if (fromCell) return fromCell
    return record ? getField(record, SHEET_FIELD.summary).trim() : ''
  }

  const validateDynamicFields = (): boolean => {
    const errors: Record<number, Record<string, string>> = {}
    const fieldsToCheck = [...requiredJiraFields, ...activeOptionalJiraFields]
    for (const record of planCreate) {
      const rowIdx = Number(record._rowIndex)
      const rowVals = cellValues[rowIdx] ?? {}
      for (const field of fieldsToCheck) {
        // summary 走共用 resolver（AI 生成的值不在 cellValues 裡），其餘欄位仍只看 cellValues
        const val = field.key === 'summary' ? resolveRowSummary(rowIdx, record) : rowVals[field.key]?.trim()
        if (field.required && !val) {
          if (!errors[rowIdx]) errors[rowIdx] = {}
          errors[rowIdx][field.key] = `${field.name} 為必填`
          continue
        }
        if (!val) continue
        if ((field.type === 'select' || field.type === 'multiselect') && field.options) {
          const parts = field.type === 'multiselect' ? splitMultiselectRaw(val) : [val]
          const badParts = parts.filter(p => !resolveSelectOptionId(field, p))
          if (badParts.length > 0) {
            if (!errors[rowIdx]) errors[rowIdx] = {}
            const preview = field.options.slice(0, 3).map(o => o.label).join('、')
            const more = field.options.length > 3 ? '...' : ''
            errors[rowIdx][field.key] = `${field.name}：Sheet 值「${badParts.join('、')}」對不到 Jira 選項。可選：${preview}${more}`
          }
        }
        if (field.type === 'date' && !normalizeDateValue(val)) {
          if (!errors[rowIdx]) errors[rowIdx] = {}
          errors[rowIdx][field.key] = `${field.name}：「${val}」不是可辨識的日期格式`
        }
      }
    }
    setCellErrors(errors)
    return Object.keys(errors).length === 0
  }

  const formatDynamicFieldValue = (field: NormalizedJiraField, rawVal: string): unknown => {
    if (!rawVal.trim()) return undefined
    switch (field.type) {
      case 'user': return { accountId: resolveUserValueForField(field, rawVal) }
      case 'multiuser': return rawVal.split(',').map(id => ({ accountId: resolveUserValueForField(field, id) })).filter(x => x.accountId)
      case 'select': {
        if (!field.options) return { name: rawVal }
        const id = resolveSelectOptionId(field, rawVal)
        return id ? { id } : undefined
      }
      case 'multiselect': {
        const parts = splitMultiselectRaw(rawVal)
        if (!field.options) return parts.map(name => ({ name }))
        const resolved = parts.map(p => resolveSelectOptionId(field, p))
        if (resolved.some(id => !id)) return undefined // validateDynamicFields() 已經在送出前擋下這種情況
        return resolved.map(id => ({ id }))
      }
      case 'date': return normalizeDateValue(rawVal) ?? undefined
      case 'number': return isNaN(Number(rawVal)) ? rawVal : Number(rawVal)
      case 'datetime': return rawVal.includes('T') ? rawVal.replace('T', ' ') : rawVal
      default: return rawVal
    }
  }

  // Toggle a member accountId in a comma-separated multiuser cell value
  const toggleMultiuser = (rowIdx: number, fieldKey: string, accountId: string) => {
    const cur = (cellValues[rowIdx]?.[fieldKey] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const next = cur.includes(accountId) ? cur.filter(id => id !== accountId) : [...cur, accountId]
    setCellValue(rowIdx, fieldKey, next.join(','))
  }

  // ── Step 3 → 4: 計算操作計畫 ──
  // Use filteredRecords (not sheetRecords) so already-created rows are never included
  const selectedRecords = filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex)))
  const planCreate     = selectedRecords.filter(needsCreate)
  const planComment    = selectedRecords.filter(needsComment)
  const planTransition = selectedRecords.filter(needsTransition)

  // ── Step 4: 建立 Issues（僅對 needsCreate 的列；其餘直接帶入 trackedIssues）──
  const handleCreate = async () => {
    if (!currentAccount || selectedRows.size === 0) return
    setSubmitting(true); setCreateResults([]); setCreateProgress(null)

    // 非開單列直接帶入 trackedIssues
    const preExisting: TrackedIssue[] = [
      ...planComment.map(r => ({
        rowIndex: Number(r._rowIndex),
        issueKey: getField(r, 'Jira Issue Key') || getField(r, 'jira issue key'),
        stage: '已開單',
      })),
      ...planTransition.map(r => ({
        rowIndex: Number(r._rowIndex),
        issueKey: getField(r, 'Jira Issue Key') || getField(r, 'jira issue key'),
        stage: '添加評論',
      })),
    ]

    console.log('[batch-create] planCreate:', planCreate.length, 'planComment:', planComment.length, 'planTransition:', planTransition.length)
    if (planCreate.length === 0) {
      console.log('[batch-create] nothing to create, going to step 4')
      setTrackedIssues(preExisting)
      setStep(4)
      setSubmitting(false)
      return
    }

    // Warn if any selected rows have unuploaded video links from Sheet
    const rowsWithPendingVideos = planCreate.filter(r => {
      const rowIdx = Number(r._rowIndex)
      return (descAttachMap[rowIdx] ?? []).some(a => a.isVideo && !a.cacheId)
    })
    if (rowsWithPendingVideos.length > 0) {
      const rowNums = rowsWithPendingVideos.map(r => Number(r._rowIndex)).join(', ')
      const confirmed = window.confirm(
        `以下 ${rowsWithPendingVideos.length} 筆資料有從 Sheet 匯入的影片，無法自動下載，送出後不會附到 Jira 描述：\n第 ${rowNums} 列\n\n請先用「+」按鈕手動上傳影片，或確認繼續送出（不含影片）？`
      )
      if (!confirmed) {
        setSubmitting(false)
        return
      }
    }

    // If we have dynamic Jira fields loaded, validate required fields first
    if (jiraFields.length > 0 && !validateDynamicFields()) {
      setSubmitting(false)
      return
    }

    // 驗證 Lark 欄位值是否為已知成員的 accountId（避免 email / displayName 直接送給 Jira）
    const knownIds = new Set(members.map(m => m.accountId))
    const validId = (val: string) => val && knownIds.has(val) ? val : ''

    // 傳統模式的必填欄位驗證（摘要、描述、受託人、RD負責人）
    if (jiraFields.length === 0) {
      const missingErrors: { rowIndex: number; error: string }[] = []
      for (const r of planCreate) {
        const rowIdx = Number(r._rowIndex)
        const missing: string[] = []
        const summaryVal = resolveRowSummary(rowIdx, r).replace(/[\r\n]+/g, ' ').trim()
        if (!summaryVal) missing.push('摘要')
        if (!getField(r, SHEET_FIELD.description)?.trim()) missing.push('描述')
        const assigneeId = batchAssigneeIds[0] || validId(getField(r, SHEET_FIELD.assigneeAccountId)) || selectedAssignee
        if (!assigneeId) missing.push('受託人')
        const rdOwnerId = batchRdOwnerIds[0] || validId(getField(r, SHEET_FIELD.rdOwnerAccountId))
        if (!rdOwnerId) missing.push('RD負責人')
        if (missing.length > 0) missingErrors.push({ rowIndex: rowIdx, error: `必填欄位缺失：${missing.join('、')}` })
      }
      if (missingErrors.length > 0) {
        setCreateResults(missingErrors)
        setStep(4)
        setSubmitting(false)
        return
      }
    }

    const rows = planCreate.map(r => {
      const rowIdx = Number(r._rowIndex)

      if (jiraFields.length > 0) {
        // New dynamic field mode: build dynamicFields from cellValues
        const rowCells = cellValues[rowIdx] ?? {}
        const dynamicFields: Record<string, unknown> = {}
        for (const field of visibleJiraFields) {
          if (field.key === 'summary') continue // handled separately
          const rawVal = rowCells[field.key]?.trim()
          if (!rawVal) continue
          const formatted = formatDynamicFieldValue(field, rawVal)
          if (formatted !== undefined) dynamicFields[field.key] = formatted
        }
        const rawFinalSummary = resolveRowSummary(rowIdx, r).replace(/[\r\n]+/g, ' ').trim()
        const summaryPrefix = computeSummaryPrefix(r as Record<string, unknown>)
        const finalSummary = summaryPrefix ? summaryPrefix + rawFinalSummary : rawFinalSummary
        return {
          summary: finalSummary,
          description: rowCells['description'] || getField(r, SHEET_FIELD.description),
          assigneeAccountId: undefined,
          rdOwnerAccountId: undefined,
          reporterAccountId: undefined as string | undefined,
          verifierAccountIds: [] as string[],
          rowIndex: rowIdx,
          dynamicFields,
          cachedAttachments: (descAttachMap[rowIdx] ?? []).filter(a => !!a.cacheId && !a.error),
        }
      }

      // Legacy mode: use hardcoded Lark field mappings
      const verifiers = getField(r, SHEET_FIELD.verifierAccountIds)
      const larkVerifierIds = verifiers
        ? verifiers.split(',').map(s => s.trim()).filter(s => knownIds.has(s))
        : []
      const rawTradSummary = resolveRowSummary(rowIdx, r).replace(/[\r\n]+/g, ' ').trim()
      const tradSummaryPrefix = computeSummaryPrefix(r as Record<string, unknown>)
      return {
        summary: tradSummaryPrefix ? tradSummaryPrefix + rawTradSummary : rawTradSummary,
        description: getField(r, SHEET_FIELD.description),
        assigneeAccountId: batchAssigneeIds[0] || validId(getField(r, SHEET_FIELD.assigneeAccountId)) || selectedAssignee || undefined,
        rdOwnerAccountId: batchRdOwnerIds[0] || validId(getField(r, SHEET_FIELD.rdOwnerAccountId)) || undefined,
        reporterAccountId: validId(getField(r, SHEET_FIELD.reporter)) || undefined,
        verifierAccountIds: batchVerifierIds.length > 0 ? batchVerifierIds : larkVerifierIds,
        actualStart: getField(r, SHEET_FIELD.actualStart) || undefined,
        actualEnd: getField(r, SHEET_FIELD.actualEnd) || undefined,
        localTestDone: getField(r, SHEET_FIELD.localTestDone) || undefined,
        stagingDeploy: getField(r, SHEET_FIELD.stagingDeploy) || undefined,
        releaseDate: getField(r, SHEET_FIELD.releaseDate) || undefined,
        rowIndex: rowIdx,
        cachedAttachments: (descAttachMap[rowIdx] ?? []).filter(a => !!a.cacheId && !a.error),
      }
    })

    setCreateProgress({ done: 0, total: rows.length })
    let batchToken: string | undefined
    try {
      // 先拿整批鎖（batchToken），逐筆請求都帶著它——避免鎖只在「每一筆」的 HTTP round-trip
      // 之間才有效，兩個分頁同時跑同一個帳號的批次開單有機會交錯執行、重複開單
      const beginResp = await fetch('/api/jira/batch-create/begin', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...emailHeader },
      })
      const beginData = await beginResp.json() as { ok: boolean; batchToken?: string; message?: string }
      if (!beginData.ok || !beginData.batchToken) {
        setCreateResults([{ rowIndex: 0, error: beginData.message ?? '無法啟動批次開單（可能有其他重任務正在執行）' }])
        setStep(4)
        return
      }
      batchToken = beginData.batchToken

      console.log('[batch-create] sending rows:', rows.length, 'rows[0]:', rows[0])
      const project = projects.find(p => p.id === selectedProjectId)
      const results: IssueCreateResult[] = []
      for (let i = 0; i < rows.length; i++) {
        try {
          const resp = await fetch('/api/jira/batch-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...emailHeader },
            body: JSON.stringify({ rows: [rows[i]], sheetUrl, projectId: selectedProjectId, projectKey: project?.key, issueTypeId: selectedIssueTypeId, batchToken }),
          })
          const data = await resp.json() as { ok: boolean; results?: IssueCreateResult[]; message?: string }
          if (data.ok && data.results) results.push(...data.results)
          else results.push({ rowIndex: rows[i].rowIndex, error: data.message ?? `HTTP ${resp.status}` })
        } catch (e) {
          results.push({ rowIndex: rows[i].rowIndex, error: String(e) })
        }
        setCreateProgress({ done: i + 1, total: rows.length })
      }

      console.log('[batch-create] results:', results)
      const succeeded = results.filter(r => r.issueKey)

      // 寫回多欄位
      let writebackResultMap: Record<number, boolean> = {}
      let writebackSkipped = false
      let writebackError = ''
      const jiraBase = import.meta.env.VITE_JIRA_BASE_URL ?? ''
      if (succeeded.length > 0) {
        try {
          const wbResp = await fetch('/api/sheets/writeback-multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sheetUrl, source: sheetSource,
              writes: succeeded.map(r => {
                const rec = filteredRecords.find(fr => Number(fr._rowIndex) === r.rowIndex)
                const rawSummary = resolveRowSummary(r.rowIndex, rec).replace(/[\r\n]+/g, ' ').trim()
                const summaryPrefix = rec ? computeSummaryPrefix(rec as Record<string, unknown>) : ''
                const finalSummary = summaryPrefix ? summaryPrefix + rawSummary : rawSummary
                const jiraUrl = `${jiraBase}/browse/${r.issueKey!}`
                return {
                  rowIndex: r.rowIndex,
                  columns: {
                    'Jira issue key': r.issueKey!,
                    'Jira URL': jiraUrl,
                    '處理階段': '已開單',
                    '處理時間': nowString(),
                    '單子標題貼這': {
                      type: 'richtext',
                      segments: [
                        { text: r.issueKey!, link: jiraUrl },
                        { text: `\n${finalSummary}` },
                      ],
                    },
                  },
                }
              }),
            }),
          })
          const wbData = await wbResp.json() as { ok: boolean; results?: { rowIndex: number; ok: boolean; error?: string }[]; needsSetup?: boolean; message?: string }
          if (wbData.ok && wbData.results) {
            wbData.results.forEach(r => {
              writebackResultMap[r.rowIndex] = r.ok
              if (!r.ok && r.error) writebackError = r.error
            })
          } else if (wbData.needsSetup) {
            writebackSkipped = true
          } else {
            writebackError = wbData.message ?? '回寫失敗'
          }
        } catch (e) { writebackError = String(e) }
      }

      setCreateResults(results.map(r => ({
        ...r,
        writebackOk: writebackResultMap[r.rowIndex] === true,
        writebackSkipped: writebackSkipped && !!r.issueKey,
        writebackError: (!writebackSkipped && r.issueKey && !writebackResultMap[r.rowIndex]) ? writebackError : undefined,
      })))

      // 查詢 server 端 pending writeback 數量（斷線時 server 已持久化，可補救）
      if (sheetUrl && succeeded.length > 0) {
        try {
          const pResp = await fetch(`/api/jira/pending-writebacks?sheetUrl=${encodeURIComponent(sheetUrl)}&status=pending,failed`)
          const pData = await pResp.json() as { ok: boolean; rows?: unknown[] }
          setPendingWritebackCount(pData.ok ? (pData.rows?.length ?? 0) : 0)
        } catch { /* ignore */ }
      }

      // 合併 trackedIssues
      const newIssues: TrackedIssue[] = succeeded.map(r => ({
        rowIndex: r.rowIndex, issueKey: r.issueKey!, stage: '已開單',
      }))
      setTrackedIssues([...preExisting, ...newIssues])
      setStep(4)
    } catch {
      setCreateResults([{ rowIndex: 0, error: '網路錯誤' }])
      setStep(4)
    } finally {
      setSubmitting(false); setCreateProgress(null)
      if (batchToken) {
        fetch('/api/jira/batch-create/end', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchToken }),
        }).catch(() => {})
      }
    }
  }

  // ── Step 5: 添加評論 ──
  // 評論範本結構：每個區塊含必填細項（細項用「：」結尾，偵測冒號後是否有內容）
  const COMMENT_TEMPLATE_SECTIONS: { header: string; items: string[] }[] = [
    { header: '【功能目的】', items: ['目的', '影響範圍'] },
    { header: '【前置條件】', items: ['環境', '版本', '測試平台', '測試資料', '情境', '參數 / 設定'] },
    { header: '【測試步驟】', items: ['主要流程', '延伸測試'] },
    { header: '【說明與備註】', items: ['特殊行為 / 已知限制', '風險或需留意事項'] },
    { header: '【驗證結果】', items: [] },
  ]

  // 回傳所有「缺漏」項目：缺少區塊標題、缺欄位、或細項冒號後沒填內容
  const validateCommentSections = (text: string): string[] => {
    const problems: string[] = []
    const lines = text.split(/\r?\n/)
    for (const sec of COMMENT_TEMPLATE_SECTIONS) {
      const headerIdx = lines.findIndex(l => l.includes(sec.header))
      if (headerIdx === -1) { problems.push(sec.header); continue }
      if (sec.items.length === 0) {
        // 【驗證結果】：標題之後（到下一個 【 區塊前）需有內容
        let hasContent = false
        for (let i = headerIdx + 1; i < lines.length; i++) {
          if (/^\s*【/.test(lines[i])) break
          if (lines[i].trim()) { hasContent = true; break }
        }
        if (!hasContent) problems.push(`${sec.header} 未填結果`)
      } else {
        for (const item of sec.items) {
          const line = lines.find(l => {
            const t = l.trim()
            return t.startsWith(`${item}：`) || t.startsWith(`${item}:`)
          })
          if (!line) { problems.push(`${item}（缺欄位）`); continue }
          const after = line.replace(/^[^：:]*[：:]/, '').trim()
          if (!after) problems.push(item)
        }
      }
    }
    return problems
  }

  // Enter preview mode: fetch attachment cache then show preview table
  const handleEnterPreview = async () => {
    if (!commentColumn || toComment.length === 0) return
    setRowCommentAs({}) // 重新產生預覽＝重新算一次身分，舊的逐列覆寫不沿用
    setPrefetchLoading(true)
    setPrefetchError('')

    const items: PreviewItem[] = toComment.map(issue => {
      const record = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      const text = record
        ? aiFormatOn ? buildAiCommentRawText(record, commentColumn) : getField(record, commentColumn)
        : ''
      const missing = validateCommentSections(text)
      return {
        rowIndex: issue.rowIndex,
        issueKey: issue.issueKey,
        summary: record ? getField(record, SHEET_FIELD.summary) : issue.issueKey,
        commentText: text,
        cachedAttachments: [],
        missingSections: missing,
        hasError: missing.length > 0,
      }
    })

    // Prefetch attachments in the background
    if (attachmentColumn) {
      // Convert column name to letter (A=index 0, B=1, ...) for Lark cell_images API
      const colIdx = sheetHeaders.indexOf(attachmentColumn)
      const columnLetter = colIdx >= 0
        ? (() => {
            let i = colIdx + 1; let letter = ''
            while (i > 0) { letter = String.fromCharCode(65 + (i - 1) % 26) + letter; i = Math.floor((i - 1) / 26) }
            return letter
          })()
        : ''

      const groups = toComment.map(issue => {
        const record = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
        // Prefer __url (actual hyperlink URLs) over display text to avoid Drive 404 on hyperlink cells
        const linkRaw = record ? (record[`${attachmentColumn}__url`] ?? '') : ''
        const raw = record ? getField(record, attachmentColumn) : ''
        const sourceText = linkRaw || raw
        const urls = sourceText ? sourceText.split(/[\n,]/).map((s: string) => s.trim()).filter(Boolean) : []
        return { rowIndex: issue.rowIndex, urls }
      })
      // Include ALL rows — empty-URL rows may have inline Lark Sheet images

      const larkSheetContext = columnLetter ? { sheetUrl, columnLetter } : undefined

      try {
        const resp = await fetch('/api/jira/attachment-prefetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...emailHeader },
          body: JSON.stringify({ groups, larkSheetContext }),
        })
        const data = await resp.json() as { ok: boolean; result?: { rowIndex: number; attachments: CachedAttachment[] }[] }
        if (data.ok && data.result) {
          for (const g of data.result) {
            const item = items.find(i => i.rowIndex === g.rowIndex)
            if (item) item.cachedAttachments = g.attachments
          }
        }
      } catch (err) {
        console.warn('[prefetch] failed:', err)
        setPrefetchError('附件載入失敗，可繼續編輯評論後送出')
      }
    }

    setPreviewItems(items)
    setPreviewMode(true)
    setPrefetchLoading(false)
  }

  const updatePreviewComment = (rowIndex: number, text: string) => {
    setPreviewItems(prev => prev.map(item => {
      if (item.rowIndex !== rowIndex) return item
      const missing = validateCommentSections(text)
      return { ...item, commentText: text, missingSections: missing, hasError: missing.length > 0 }
    }))
  }

  const COMMENT_TEMPLATE = COMMENT_TEMPLATE_SECTIONS
    .map(s => [s.header, ...s.items.map(i => `${i}：`)].join('\n'))
    .join('\n\n') + '\n'

  const handleBatchAppendTemplate = () => {
    setPreviewItems(prev => prev.map(item => {
      const newText = item.commentText ? item.commentText + '\n\n' + COMMENT_TEMPLATE : COMMENT_TEMPLATE
      const missing = validateCommentSections(newText)
      return { ...item, commentText: newText, missingSections: missing, hasError: missing.length > 0 }
    }))
  }

  const handleRemoveAttachment = (rowIndex: number, attachmentIndex: number) => {
    let removedCacheId: string | undefined
    setPreviewItems(prev => prev.map(item => {
      if (item.rowIndex !== rowIndex) return item
      removedCacheId = item.cachedAttachments[attachmentIndex]?.cacheId
      return { ...item, cachedAttachments: item.cachedAttachments.filter((_, i) => i !== attachmentIndex) }
    }))
    // 立即刪除暫存檔，不用等 2 小時 TTL 清理，避免容量爆滿
    if (removedCacheId) {
      fetch(`/api/jira/attachment-cache/${removedCacheId}`, { method: 'DELETE' }).catch(() => {})
    }
  }

  const handleManualUpload = async (rowIndex: number, files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploadingRows(prev => new Set([...prev, rowIndex]))
    setUploadErrors(prev => { const n = { ...prev }; delete n[rowIndex]; return n })
    for (const file of Array.from(files)) {
      try {
        const formData = new FormData()
        formData.append('file', file)
        const resp = await fetch('/api/jira/attachment-upload', {
          method: 'POST',
          headers: { ...emailHeader },
          body: formData,
        })
        const data = await resp.json() as CachedAttachment & { ok: boolean; message?: string }
        if (data.ok) {
          setPreviewItems(prev => prev.map(item => {
            if (item.rowIndex !== rowIndex) return item
            return { ...item, cachedAttachments: [...item.cachedAttachments, { cacheId: data.cacheId, filename: data.filename, mimeType: data.mimeType, isImage: data.isImage, isVideo: data.isVideo, size: data.size }] }
          }))
        } else {
          setUploadErrors(prev => ({ ...prev, [rowIndex]: `${file.name}：${data.message ?? '上傳失敗'}` }))
        }
      } catch (err) {
        console.warn('[manual-upload] failed:', err)
        setUploadErrors(prev => ({ ...prev, [rowIndex]: `${file.name}：上傳失敗` }))
      }
    }
    setUploadingRows(prev => { const s = new Set([...prev]); s.delete(rowIndex); return s })
  }

  /** 這一列實際會用誰的身分張貼。優先序：逐列覆寫 → 填寫人欄位解析結果 → 自己。
   *  回空字串代表「未設定」——Sheet 上的名字對不到帳號、或我沒有代理授權，這種情況**不會**
   *  把 Sheet 上那個原始名字顯示出去（會讓人以為已經能用那個身分送出，實際送出才爆）。 */
  const identityEmailForRow = (rowIndex: number): string => {
    const override = rowCommentAs[rowIndex]
    if (override) return override
    const selfEmail = currentAccount?.email ?? ''
    if (!personColumn) return selfEmail
    const rec = sheetRecords.find(r => Number(r._rowIndex) === rowIndex)
    const name = rec ? getField(rec, personColumn).trim() : ''
    if (!name) return selfEmail
    const hit = personResolve.find(x => x.name.toLowerCase() === name.toLowerCase())
    return hit && hit.status === 'ok' ? (hit.email ?? '') : ''
  }
  /** 送出 payload 用：跟自己相同就不帶 commentAsEmail，維持「沒指定＝用自己的 token」的既有語意 */
  const personEmailForRow = (rowIndex: number): string | undefined => {
    const email = identityEmailForRow(rowIndex)
    if (!email || email === currentAccount?.email) return undefined
    return email
  }
  // 擋送出的依據是「逐列真的解析不出身分」，不是「名字清單上有紅字」——使用者可以在預覽表
  // 直接用下拉補一個授權過的帳號，補完就該放行（送出前一樣會再跑一次 personEmailForRow，
  // 不是只相信 UI 狀態，CodeX review 要求）。
  const rowIdentityMissing = toComment.filter(i => !identityEmailForRow(i.rowIndex))
  const personBlocking = personResolve.filter(x => x.status !== 'ok')

  type CommentPayload = {
    issueKey: string; rowIndex: number; rawComment: string; useAi: boolean; aiFormat?: boolean; aiReview?: boolean; promptId?: string
    cachedAttachments?: CachedAttachment[]; attachmentUrls: string[]
    issueSummary?: string; issueDescription?: string
    machineId?: string; gameMode?: string; environment?: string; version?: string; platform?: string
  }

  // Shared core: submit batch-comment job and wait for SSE result
  const runBatchCommentJob = async (comments: CommentPayload[]) => {
    if (!currentAccount) return
    let submitRequestId = ''
    let sseResolved = false
    try {
      const resp = await fetch('/api/jira/batch-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({
          comments,
          modelSpec: (aiFormatOn || aiReviewOn) ? commentModel : undefined,
          specContext: aiFormatOn && specContext.trim() ? specContext.trim() : undefined,
          knowledgeDocIds: aiFormatOn && selectedKbDocIds.length > 0 ? selectedKbDocIds : undefined,
        }),
      })
      const submitData = await resp.json() as { ok: boolean; requestId?: string; message?: string; validationErrors?: unknown }
      if (!submitData.ok || !submitData.requestId) {
        setCommentResults([{ rowIndex: 0, issueKey: '', ok: false, error: submitData.message ?? '提交失敗' }])
        setStep(5)
        setCommentSubmitting(false)
        return
      }
      submitRequestId = submitData.requestId
      setPendingCommentRequestId(submitRequestId)
      localStorage.setItem(COMMENT_PENDING_KEY, submitRequestId)

      const data = await new Promise<{ ok: boolean; results?: StageOpResult[]; stopped?: boolean; stoppedReason?: string; stoppedKind?: 'ai_quota' | 'worker_restart' }>((resolve, reject) => {
        const es = new EventSource(`/api/jira/batch-comment/stream?requestId=${encodeURIComponent(submitData.requestId!)}&email=${encodeURIComponent(currentAccount.email)}`)
        let done = false
        const sseTimeout = setTimeout(() => { if (!done) { es.close(); reject(new Error('SSE 逾時')) } }, 30 * 60 * 1000)
        es.addEventListener('progress', (e: MessageEvent) => { setCommentProgress(JSON.parse(e.data)) })
        es.addEventListener('result', (e: MessageEvent) => { done = true; clearTimeout(sseTimeout); es.close(); resolve(JSON.parse(e.data)) })
        es.onerror = () => { if (done) return }
      })

      const results = data.results ?? []
      if (data.stopped && data.stoppedReason) {
        results.push(buildCommentStoppedRow(data.stoppedReason, data.stoppedKind))
      }
      sseResolved = true
      setCommentResults(results)
      setCommentSubmitting(false)
      setPendingCommentRequestId('')
      setCommentProgress(null)
      localStorage.removeItem(COMMENT_PENDING_KEY)
      setPreviewMode(false)
      setStep(5)

      const successRows = results.filter(r => r.ok)
      if (successRows.length > 0) {
        const wbUrl = qaSubMode === 'comment' ? commentTabUrl : sheetUrl
        if (wbUrl) {
          await fetch('/api/sheets/writeback-multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sheetUrl: wbUrl, source: qaSubMode === 'comment' ? commentTabSource : sheetSource,
              writes: successRows.map(r => ({ rowIndex: r.rowIndex, columns: { '處理階段': '添加評論', '處理時間': nowString() } })),
            }),
          })
        }
        setTrackedIssues(prev => prev.map(t => successRows.some(r => r.rowIndex === t.rowIndex) ? { ...t, stage: '添加評論' } : t))
      }
    } catch {
      if (sseResolved) return
      if (submitRequestId) {
        // Polling fallback
        let recovered = false
        const maxPollMs = 5 * 60 * 1000
        const pollStart = Date.now()
        while (Date.now() - pollStart < maxPollMs) {
          try {
            const r = await fetch(`/api/jira/batch-comment/status/${encodeURIComponent(submitRequestId)}`, { headers: { ...emailHeader } })
            const d = await r.json() as { ok: boolean; status?: string; progress?: { done: number; total: number; current: string }; result?: { ok: boolean; results?: StageOpResult[]; stopped?: boolean; stoppedReason?: string } }
            if (!d.ok) break
            if (d.progress) setCommentProgress(d.progress)
            if (d.status === 'running') { await new Promise(res => setTimeout(res, 2000)); continue }
            if (d.result) {
              const rr = d.result.results ?? []
              setCommentResults(rr)
              setCommentSubmitting(false)
              setPendingCommentRequestId('')
              setCommentProgress(null)
              localStorage.removeItem(COMMENT_PENDING_KEY)
              setPreviewMode(false)
              setStep(5)
              recovered = true
              break
            }
            break
          } catch { break }
        }
        if (!recovered) {
          setCommentResults([{ rowIndex: 0, issueKey: '', ok: false, error: '連線中斷，請重新整理後查看結果' }])
          setCommentSubmitting(false)
          setPendingCommentRequestId('')
          setCommentProgress(null)
          localStorage.removeItem(COMMENT_PENDING_KEY)
          setStep(5)
        }
      } else {
        setCommentResults([{ rowIndex: 0, issueKey: '', ok: false, error: '連線錯誤，請重試' }])
        setCommentSubmitting(false)
        setStep(5)
      }
    }
  }

  // Submit from preview — uses edited comment text + cached attachments
  const handleSubmitFromPreview = async () => {
    if (!currentAccount) return

    // Warn if any items still have unuploaded video attachments
    const unuploadedVideos = previewItems.filter(item => {
      const pendingLinks = item.cachedAttachments.filter(a => a.mimeType === 'video/link' && !a.cacheId).length
      const uploadedVideos = item.cachedAttachments.filter(a => a.isVideo && !!a.cacheId).length
      return pendingLinks > uploadedVideos
    })
    if (unuploadedVideos.length > 0) {
      const keys = unuploadedVideos.map(i => i.issueKey).join(', ')
      const confirmed = window.confirm(
        `以下 ${unuploadedVideos.length} 筆 Issue 有影片尚未上傳，送出後不會附到 Jira 評論：\n${keys}\n\n確定繼續送出評論（不含影片）？`
      )
      if (!confirmed) return
    }

    setCommentSubmitting(true)
    setPendingCommentRequestId('')
    setCommentProgress(null)
    setCommentResults([])

    const comments: CommentPayload[] = previewItems.map(item => {
      const record = sheetRecords.find(r => Number(r._rowIndex) === item.rowIndex)
      const validCached = item.cachedAttachments.filter(a => !!a.cacheId && !a.error)
      // Fallback: if prefetch failed, pass original URLs so server downloads them during submit
      const linkRawFallback = (attachmentColumn && record) ? (record[`${attachmentColumn}__url`] ?? '') : ''
      const rawAttachText = (attachmentColumn && record) ? getField(record, attachmentColumn) : ''
      const fallbackSource = linkRawFallback || rawAttachText
      const fallbackUrls = validCached.length === 0 && fallbackSource
        ? fallbackSource.split(/[\n,]/).map((s: string) => s.trim()).filter(Boolean)
        : []
      return {
        issueKey: item.issueKey,
        rowIndex: item.rowIndex,
        rawComment: item.commentText,
        // useAi 保留給尚未更新的後端版本當 fallback；新的兩個旗標才是實際判斷依據
        useAi: aiFormatOn || aiReviewOn,
        aiFormat: aiFormatOn,
        aiReview: aiReviewOn,
        promptId: aiFormatOn ? selectedPromptId : undefined,
        // 逐列代發：這一列的填寫人對應到的帳號（後端仍會重新驗證授權，不信前端）
        commentAsEmail: personEmailForRow(item.rowIndex),
        cachedAttachments: validCached,
        attachmentUrls: fallbackUrls,
        issueSummary: item.summary,
        issueDescription: record ? getField(record, SHEET_FIELD.description) || undefined : undefined,
        machineId:   record ? getField(record, '機台編號') || undefined : undefined,
        gameMode:    record ? getField(record, '遊戲模式') || undefined : undefined,
        environment: record ? deriveEnvironment(record, item.commentText) || undefined : undefined,
        version:     record ? deriveVersion(record, item.commentText) || undefined : undefined,
        platform:    record ? getFieldByHeaderMatch(record, ['測試平台', '平台', '類別']) || undefined : undefined,
      }
    })
    await runBatchCommentJob(comments)
  }

  // ── Step 6: 切換狀態 ──
  const handleTransition = async () => {
    if (!currentAccount || toTransition.length === 0 || !selectedTransitionId) return
    setTransitionSubmitting(true); setTransitionProgress({ done: 0, total: toTransition.length })

    const issues = toTransition.map(t => ({
      issueKey: t.issueKey,
      rowIndex: t.rowIndex,
      transitionId: selectedTransitionId,
    }))

    let batchToken: string | undefined
    try {
      const beginResp = await fetch('/api/jira/batch-transition/begin', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...emailHeader },
      })
      const beginData = await beginResp.json() as { ok: boolean; batchToken?: string; message?: string }
      if (!beginData.ok || !beginData.batchToken) {
        setTransitionResults([{ rowIndex: 0, issueKey: '', ok: false, error: beginData.message ?? '無法啟動批次轉換狀態（可能有其他重任務正在執行）' }])
        setStep(6)
        return
      }
      batchToken = beginData.batchToken

      // Send one issue at a time for real-time progress updates
      const allResults: StageOpResult[] = []
      for (let i = 0; i < issues.length; i++) {
        try {
          const resp = await fetch('/api/jira/batch-transition', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...emailHeader },
            body: JSON.stringify({ issues: [issues[i]], batchToken }),
          })
          const data = await resp.json() as { ok: boolean; results?: StageOpResult[] }
          allResults.push(...(data.results ?? [{ rowIndex: issues[i].rowIndex, issueKey: issues[i].issueKey, ok: false, error: `HTTP ${resp.status}` }]))
        } catch (e) {
          allResults.push({ rowIndex: issues[i].rowIndex, issueKey: issues[i].issueKey, ok: false, error: String(e) })
        }
        setTransitionProgress({ done: i + 1, total: issues.length })
      }

      const results = allResults
      setTransitionResults(results)

      const successRows = results.filter(r => r.ok)
      if (successRows.length > 0) {
        await fetch('/api/sheets/writeback-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheetUrl, source: sheetSource,
            writes: successRows.map(r => ({
              rowIndex: r.rowIndex,
              columns: { '處理階段': '已切換狀態', '處理時間': nowString() },
            })),
          }),
        })
        setTrackedIssues(prev => prev.map(t =>
          successRows.some(r => r.rowIndex === t.rowIndex) ? { ...t, stage: '已切換狀態' } : t
        ))
      }
      setStep(6)
    } catch { setTransitionResults([{ rowIndex: 0, issueKey: '', ok: false, error: '網路錯誤' }]); setStep(6) }
    finally {
      setTransitionSubmitting(false); setTransitionProgress(null)
      if (batchToken) {
        fetch('/api/jira/batch-transition/end', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchToken }),
        }).catch(() => {})
      }
    }
  }

  /** 「重新開始」時需清空所有流程狀態（保留已登入帳號）。 */
  const clearWorkflowState = useCallback(() => {
    setStep(1)
    setCreateResults([]); setCommentResults([]); setTransitionResults([])
    setTrackedIssues([])
    setSheetRecords([]); setSheetHeaders([]); setSheetUrl(''); setSheetSource('lark')
    setSheetError('')
    setSelectedRows(new Set())
    setSelectedAssignee(''); setBatchAssigneeIds([]); setBatchRdOwnerIds([]); setBatchVerifierIds([])
    setCommentColumn(''); setAttachmentColumn(''); setUseAiComment(false); setSelectedPromptId('default')
    setSelectedProjectId(''); setSelectedIssueTypeId(''); setIssueTypes([])
    setMembers([]); setMembersError(''); setMembersLoading(false)
    setPendingCommentRequestId(''); setCommentProgress(null)
    setSubmitting(false); setCommentSubmitting(false); setTransitionSubmitting(false)
    setTransitionOptions([]); setSelectedTransitionId(''); setTransitionOptionsError(''); setTransitionOptionsLoading(false)
    localStorage.removeItem(COMMENT_PENDING_KEY)
  }, [])

  const handleReset = () => {
    clearWorkflowState()
  }

  // ── Comment Tab handler ──

  // Smarter Jira key extraction: checks __url fields for browse URLs + text starting with key
  const extractJiraIssuesFromRecords = (records: SheetRecord[], headers: string[]) => {
    const BROWSE_RE = /\/browse\/([A-Z]{2,}[0-9]*-\d+)/
    const START_RE = /^([A-Z]{2,}[0-9]*-\d+)/
    const issues: { rowIndex: number; issueKey: string; stage: string }[] = []
    const seenKeys = new Set<string>()
    for (const rec of records) {
      let foundKey: string | null = null
      // Pass 1: __url fields (hyperlink cells) → most reliable
      for (const h of headers) {
        const urlVal = (rec[`${h}__url`] ?? '').toString().trim()
        if (!urlVal) continue
        const m = urlVal.match(BROWSE_RE)
        if (m) { foundKey = m[1]; break }
      }
      // Pass 2: text values starting with a Jira key
      if (!foundKey) {
        for (const h of headers) {
          if (h.endsWith('__url') || h === '_rowIndex') continue
          const val = (rec[h] ?? '').toString().trim()
          if (!val) continue
          const m = val.match(START_RE)
          if (m) { foundKey = m[1]; break }
        }
      }
      if (foundKey && !seenKeys.has(foundKey)) {
        seenKeys.add(foundKey)
        // 只負責誠實把 Sheet 上的處理階段讀出來；這個值代表「可不可以送」「要不要預設勾選」
        // 由各流程自己解讀，不在這裡下判斷（CodeX review：避免共用 extractor 污染其他流程）
        issues.push({ rowIndex: Number(rec._rowIndex), issueKey: foundKey, stage: getField(rec, STAGE_COL).trim() })
      }
    }
    return issues
  }

  const handleCommentTabLoad = async (urlOverride?: string, sourceOverride?: SheetSource) => {
    const url = urlOverride ?? commentTabUrl
    const source = sourceOverride ?? commentTabSource
    if (!url.trim()) return
    // 換一份 Sheet／重新讀取一次＝這批資料跟上一批無關，先把「上次讀到哪些 key」清掉，
    // 否則不同資料批次之間 key 剛好重複時會被誤判成舊列而沿用上一批的勾選（CodeX review 提醒）
    prevCommentKeysRef.current = new Set()
    setCommentTabLoading(true); setCommentTabError(''); setCommentTabStep(1)
    try {
      const endpoint = source === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: url.trim(), includeCreated: true }),
      })
      const data = await resp.json() as { ok: boolean; records?: SheetRecord[]; headers?: string[]; message?: string }
      if (!data.ok) { setCommentTabError(data.message ?? '讀取失敗'); return }
      const records = data.records ?? []
      const headers = data.headers ?? []
      const issues = extractJiraIssuesFromRecords(records, headers) as TrackedIssue[]
      if (issues.length === 0) {
        setCommentTabError('找不到已開單的 Jira Issue Key，請確認「Jira issue key」欄位有資料')
        return
      }
      setSheetHeaders(headers)
      setSheetRecords(records)
      setTrackedIssues(issues)
      setCommentResults([])
      setPreviewMode(false)
      setPreviewItems([])
      // 處理階段已經是「添加評論」或更後面階段的列預設不勾選，避免不小心重複送出評論；
      // 使用者仍可手動勾回去（只是預設值，不是強制擋掉），跟批量修改的既有行為一致
      setCommentTabSelectedKeys(new Set(issues.filter(i => stillNeedsComment(i.stage)).map(i => i.issueKey)))
      prevCommentKeysRef.current = new Set(issues.map(i => i.issueKey))
      setCommentTabStep(2)
      setLastSheetUrl(url.trim()); setLastSheetSource(source)
    } catch { setCommentTabError('網路錯誤') }
    finally { setCommentTabLoading(false) }
  }

  // 重新讀取 Sheet（不切換 step，保留已勾選 Issue / 已寫的評論內容）
  const handleReloadCommentSheet = async () => {
    if (!commentTabUrl.trim()) return
    setCommentTabLoading(true); setCommentTabError(''); setCommentReloadMsg('')
    try {
      const endpoint = commentTabSource === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: commentTabUrl.trim(), includeCreated: true }),
      })
      const data = await resp.json() as { ok: boolean; records?: SheetRecord[]; headers?: string[]; message?: string }
      if (!data.ok) { setCommentTabError(data.message ?? '讀取失敗'); return }
      const records = data.records ?? []
      const headers = data.headers ?? []
      const issues = extractJiraIssuesFromRecords(records, headers) as TrackedIssue[]
      setSheetHeaders(headers)
      setSheetRecords(records)
      setTrackedIssues(issues)
      const freshKeys = new Set(issues.map(i => i.issueKey))
      // 原本這裡是 [...prev, ...freshKeys] 再過濾——union 完每個 fresh key 都會通過過濾，等於
      // 每次重新讀取都把所有列重新勾回來，使用者手動取消勾選的動作會被洗掉（跟這段程式碼
      // 自己的註解「保留已勾選 Issue」相矛盾）。改成：本來就在清單裡的沿用使用者的選擇，
      // 這次新出現的列才套「還需要評論」的白名單。
      // 先把「上一次讀到哪些 key」抓成區域變數再進 functional update——setState 的 updater 是延後
      // 執行的，如果在裡面才讀 ref，這行下面的 ref 覆寫早就跑完了，新出現的列會全部被當成舊的
      const knownBefore = prevCommentKeysRef.current
      setCommentTabSelectedKeys(prev => {
        const next = new Set<string>()
        for (const iss of issues) {
          const wasKnown = knownBefore.has(iss.issueKey)
          const keep = wasKnown ? prev.has(iss.issueKey) : stillNeedsComment(iss.stage)
          if (keep) next.add(iss.issueKey)
        }
        return next
      })
      prevCommentKeysRef.current = freshKeys
      setCommentReloadMsg(`通過 已重新讀取（${issues.length} 筆）`)
    } catch { setCommentTabError('網路錯誤') }
    finally { setCommentTabLoading(false) }
  }

  // ── Edit Tab handlers ──
  const fetchEditTabJiraData = async (issueKeys: string[]) => {
    if (!currentAccount) { setEditTabJiraError('請先選擇 Jira 帳號才能載入 Jira 欄位資料'); return }
    setEditTabJiraLoading(true); setEditTabJiraError('')
    try {
      const r = await fetch('/api/jira/batch-fetch-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ issueKeys }),
      })
      const d = await r.json() as { ok: boolean; issues?: Record<string, Record<string, string>>; message?: string }
      if (d.ok) { setEditTabJiraData(d.issues ?? {}) }
      else { setEditTabJiraError(d.message ?? 'Jira 資料載入失敗') }
    } catch { setEditTabJiraError('載入 Jira 資料時網路錯誤') }
    finally { setEditTabJiraLoading(false) }
  }

  const handleEditTabLoad = async (urlOverride?: string, sourceOverride?: SheetSource) => {
    const url = urlOverride ?? editTabUrl
    const source = sourceOverride ?? editTabSource
    if (!url.trim()) return
    setEditTabLoading(true); setEditTabError(''); setEditTabJiraError(''); setEditTabIssues([]); setEditTabResults([]); setEditTabJiraData({})
    try {
      const endpoint = source === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: url.trim(), includeCreated: true }),
      })
      const data = await resp.json() as { ok: boolean; records?: SheetRecord[]; headers?: string[]; message?: string }
      if (!data.ok) { setEditTabError(data.message ?? '讀取失敗'); return }
      const records = data.records ?? []
      const headers = data.headers ?? []
      const issues = extractJiraIssuesFromRecords(records, headers)
      if (issues.length === 0) {
        setEditTabError('找不到已開單的 Jira Issue Key，請確認「Jira issue key」欄位有資料')
        return
      }
      setEditTabRecords(records)
      setEditTabHeaders(headers)
      setEditTabIssues(issues)
      // 已經批量修改過的列（處理階段＝已修改欄位）預設不勾選，避免不小心重複執行造成附件/
      // 描述重複疊加——使用者仍可手動勾回去，這只是預設值，不是強制擋掉
      const alreadyEditedKeys = new Set(
        issues.filter(iss => {
          const rec = records.find(r => Number(r._rowIndex) === iss.rowIndex)
          return rec ? getField(rec, STAGE_COL).trim() === EDIT_STAGE_DONE : false
        }).map(iss => iss.issueKey),
      )
      setEditTabSelectedKeys(new Set(issues.map(i => i.issueKey).filter(k => !alreadyEditedKeys.has(k))))
      setEditFieldMappings([blankMapping()])
      setEditTabStep(2)
      setLastSheetUrl(url.trim()); setLastSheetSource(source)
      // Async fetch current Jira data for preview
      void fetchEditTabJiraData(issues.map(i => i.issueKey))
      // Async fetch members — extract project key from first issue key (e.g. "DSFT-7908" → "DSFT")
      if (currentAccount) {
        setEditTabMembersLoading(true)
        const projKey = issues[0]?.issueKey.split('-')[0] ?? ''
        const membersUrl = projKey
          ? `/api/jira/members?projectKey=${encodeURIComponent(projKey)}`
          : '/api/jira/members'
        fetch(membersUrl, { headers: { 'x-jira-email': currentAccount.email } })
          .then(r => r.json()).then((d: { ok: boolean; members?: Member[] }) => {
            if (d.ok) setEditTabMembers(d.members ?? [])
          }).catch(() => {}).finally(() => setEditTabMembersLoading(false))
      }
      // Async fetch editmeta for first issue to get all editable fields
      if (currentAccount && issues.length > 0) {
        fetch(`/api/jira/editmeta?issueKey=${encodeURIComponent(issues[0].issueKey)}`, {
          headers: { 'x-jira-email': currentAccount.email },
        }).then(r => r.json()).then((d: { ok: boolean; fields?: NormalizedJiraField[] }) => {
          if (d.ok && d.fields) setEditTabAvailableFields(d.fields)
        }).catch(() => {})
      }
    } catch { setEditTabError('網路錯誤') }
    finally { setEditTabLoading(false) }
  }

  // 重新讀取 Sheet（不切換 step，保留已勾選 Issue / 已設定的欄位對應）
  const handleReloadEditSheet = async () => {
    if (!editTabUrl.trim()) return
    setEditTabLoading(true); setEditTabError(''); setEditReloadMsg('')
    try {
      const endpoint = editTabSource === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: editTabUrl.trim(), includeCreated: true }),
      })
      const data = await resp.json() as { ok: boolean; records?: SheetRecord[]; headers?: string[]; message?: string }
      if (!data.ok) { setEditTabError(data.message ?? '讀取失敗'); return }
      const records = data.records ?? []
      const headers = data.headers ?? []
      const issues = extractJiraIssuesFromRecords(records, headers)
      setEditTabRecords(records)
      setEditTabHeaders(headers)
      setEditTabIssues(issues)
      const freshKeys = new Set(issues.map(i => i.issueKey))
      const alreadyEditedKeys = new Set(
        issues.filter(iss => {
          const rec = records.find(r => Number(r._rowIndex) === iss.rowIndex)
          return rec ? getField(rec, STAGE_COL).trim() === EDIT_STAGE_DONE : false
        }).map(iss => iss.issueKey),
      )
      // 保留使用者原本的勾選；新出現的列預設勾選，除非已經被批量修改過
      setEditTabSelectedKeys(prev => {
        const next = new Set<string>()
        for (const k of freshKeys) {
          if (prev.has(k) || !alreadyEditedKeys.has(k)) next.add(k)
        }
        return next
      })
      setEditReloadMsg(`通過 已重新讀取（${issues.length} 筆）`)
    } catch { setEditTabError('網路錯誤') }
    finally { setEditTabLoading(false) }
  }

  const handleEditTabSubmit = async () => {
    const activeMappings = editFieldMappings.filter(m =>
      m.mode === 'sheet' ? !!m.sheetColumn : !!(m.manualValue || m.manualAccountId || m.manualAccountIds.length > 0)
    )
    if (!activeMappings.length || !currentAccount) return

    // Warn if any issue has pending video attachments
    const hasPendingVideo = editTabIssues
      .filter(issue => editTabSelectedKeys.has(issue.issueKey))
      .some(issue => (editDescAttachMap[issue.issueKey] ?? []).some(a => a.isVideo && !a.cacheId))
    if (hasPendingVideo && !window.confirm('部分影片尚未手動上傳，確認繼續送出（影片不會附加至描述）？')) return

    // 送出前重新確認選中的 Issue 是否還存在/可存取——避免 Step 2 讀取之後，Issue 被刪除、
    // 搬移專案或權限變更，這種情況下再送出修改只會拿到 Jira 錯誤，不如先過濾掉並讓使用者知道
    let effectiveSelectedKeys = editTabSelectedKeys
    {
      const selectedIssues = editTabIssues.filter(issue => editTabSelectedKeys.has(issue.issueKey))
      try {
        const checkResp = await fetch('/api/jira/batch-fetch-fields', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...emailHeader },
          body: JSON.stringify({ issueKeys: selectedIssues.map(i => i.issueKey) }),
        })
        const checkData = await checkResp.json() as { ok: boolean; issues?: Record<string, Record<string, string>> }
        if (checkData.ok && checkData.issues) {
          const missing = selectedIssues.filter(i => !checkData.issues![i.issueKey]).map(i => i.issueKey)
          if (missing.length > 0) {
            const proceed = window.confirm(
              `以下 ${missing.length} 筆 Issue 目前無法存取（可能已被刪除或權限變更），將略過這些筆：\n${missing.join('、')}\n\n是否繼續執行其餘 ${selectedIssues.length - missing.length} 筆？`
            )
            if (!proceed) return
            effectiveSelectedKeys = new Set([...editTabSelectedKeys].filter(k => !missing.includes(k)))
            setEditTabSelectedKeys(effectiveSelectedKeys)
          }
        }
      } catch { /* best-effort，網路問題不擋執行 */ }
    }

    setEditTabSubmitting(true); setEditTabError('')
    setEditProgress({ done: 0, total: editTabIssues.filter(i => effectiveSelectedKeys.has(i.issueKey)).length })
    try {
      const items = editTabIssues.filter(issue => effectiveSelectedKeys.has(issue.issueKey)).map(issue => {
        const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
        const fields: Record<string, unknown> = {}
        for (const m of activeMappings) {
          const ftype = m.fieldType
          const fopts = m.fieldOptions

          const buildFieldValue = (rawVal: string): unknown => {
            if (!rawVal) return undefined
            const ft = ftype || (m.jiraField === 'assignee' ? 'user' : m.jiraField === 'priority' ? 'select' : 'string')
            // labels: always plain string array regardless of type
            if (m.jiraField === 'labels') {
              return rawVal.split(',').map(s => s.trim()).filter(Boolean)
            }
            if (ft === 'user' || ft === 'multiuser') {
              const allMembers = editTabMembers.map(mb => ({ id: mb.accountId, label: mb.displayName }))
              const opts = fopts.length ? fopts : allMembers
              // resolve single token (display name or accountId) → accountId
              const resolveOne = (token: string) => opts.find(o => o.id === token || o.label === token)?.id ?? token
              if (ft === 'multiuser') {
                // split comma-separated names/ids, resolve each to accountId
                return rawVal.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ accountId: resolveOne(s) }))
              }
              const accountId = resolveOne(rawVal)
              // assignee uses { id }, custom user fields use { accountId }
              return m.jiraField === 'assignee' ? { id: accountId } : { accountId }
            }
            if (ft === 'select') {
              // priority uses { name }, generic select uses { id }
              if (m.jiraField === 'priority') return { name: rawVal }
              const opt = fopts.find(o => o.label === rawVal || o.id === rawVal)
              return opt ? { id: opt.id } : { name: rawVal }
            }
            if (ft === 'multiselect') {
              return rawVal.split(',').map(s => s.trim()).filter(Boolean).map(v => {
                const opt = fopts.find(o => o.label === v || o.id === v)
                return opt ? { id: opt.id } : { value: v }
              })
            }
            if (ft === 'number') {
              const n = Number(rawVal)
              return isNaN(n) ? undefined : n
            }
            return rawVal  // string / text / date / datetime
          }

          if (m.mode === 'manual') {
            if (ftype === 'multiuser' && m.manualAccountIds.length > 0) {
              fields[m.jiraField] = m.manualAccountIds.map(id => ({ accountId: id }))
            } else {
              const rawVal = m.manualAccountId || m.manualValue
              const val = buildFieldValue(rawVal)
              if (val !== undefined && val !== '') fields[m.jiraField] = val
            }
          } else {
            const rawVal = (rec?.[m.sheetColumn] ?? '').toString().trim()
            let val = buildFieldValue(rawVal)
            // Apply summary prefix when prefix is enabled and field is summary
            if (m.jiraField === 'summary' && summaryPrefixEnabled && rec) {
              const prefix = computeSummaryPrefix(rec as Record<string, unknown>)
              if (prefix && typeof val === 'string' && val) val = prefix + val
            }
            if (val !== undefined && val !== '') fields[m.jiraField] = val
          }
        }
        const cachedAttachments = (editDescAttachMap[issue.issueKey] ?? []).filter(a => !!a.cacheId && !a.error)
        return { issueKey: issue.issueKey, fields, cachedAttachments }
      }).filter(item => Object.keys(item.fields).length > 0 || item.cachedAttachments.length > 0)

      if (!items.length) { setEditTabError('所有 Issue 均無有效更新欄位，請檢查欄位對應設定'); return }

      // Send one item at a time for real-time progress updates
      const allEditResults: { issueKey: string; ok: boolean; error?: string }[] = []
      for (let i = 0; i < items.length; i++) {
        try {
          const resp = await fetch('/api/jira/batch-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...emailHeader },
            body: JSON.stringify({ items: [items[i]] }),
          })
          const result = await resp.json() as { ok: boolean; results?: { issueKey: string; ok: boolean; error?: string }[]; message?: string }
          if (result.results) allEditResults.push(...result.results)
          else allEditResults.push({ issueKey: items[i].issueKey, ok: false, error: result.message ?? `HTTP ${resp.status}` })
        } catch (e) {
          allEditResults.push({ issueKey: items[i].issueKey, ok: false, error: String(e) })
        }
        setEditProgress({ done: i + 1, total: items.length })
      }
      setEditTabResults(allEditResults); setEditTabStep(4)

      // Writeback 處理階段＝已修改欄位（只有真的成功的才寫），防止同一份 Sheet 之後不小心
      // 重複執行同一批修改——重新讀取時這個標記會讓已處理過的列預設不勾選
      const succeededKeys = new Set(allEditResults.filter(r => r.ok).map(r => r.issueKey))
      const succeededRows = editTabIssues.filter(iss => succeededKeys.has(iss.issueKey))
      if (succeededRows.length > 0 && editTabUrl) {
        fetch('/api/sheets/writeback-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheetUrl: editTabUrl, source: editTabSource,
            writes: succeededRows.map(r => ({
              rowIndex: r.rowIndex,
              columns: { [STAGE_COL]: EDIT_STAGE_DONE, '處理時間': nowString() },
            })),
          }),
        }).catch(() => {})
      }
    } catch { setEditTabError('網路錯誤') }
    finally { setEditTabSubmitting(false); setEditProgress(null) }
  }

  // ── Update Mode handlers ──
  const fetchUpdateJiraData = async (issueKeys: string[]) => {
    if (!currentAccount) { setUpdateJiraError('請先選擇 Jira 帳號才能載入 Jira 資料'); return }
    setUpdateJiraLoading(true); setUpdateJiraError('')
    try {
      const r = await fetch('/api/jira/batch-fetch-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ issueKeys }),
      })
      const d = await r.json() as { ok: boolean; issues?: Record<string, Record<string, string>>; message?: string }
      if (d.ok) { setUpdateJiraData(d.issues ?? {}) }
      else { setUpdateJiraError(d.message ?? 'Jira 資料載入失敗') }
    } catch { setUpdateJiraError('載入 Jira 資料時網路錯誤') }
    finally { setUpdateJiraLoading(false) }
  }

  const handleUpdateFetchBitable = async (urlOverride?: string, sourceOverride?: SheetSource) => {
    const url = urlOverride ?? updateBitableUrl
    const source = sourceOverride ?? updateTabSource
    if (!url.trim()) return
    setUpdateLoading(true); setUpdateError(''); setUpdateRecords([]); setUpdateJiraData({}); setUpdateJiraError(''); setUpdateTabColFilters({})
    try {
      const endpoint = source === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: url.trim(), includeCreated: true }),
      })
      const data = await resp.json() as { ok: boolean; records?: SheetRecord[]; headers?: string[]; message?: string }
      if (!data.ok) { setUpdateError(data.message ?? '讀取失敗'); return }
      const sheetRecords = data.records ?? []
      const headers = data.headers ?? []
      const issues = extractJiraIssuesFromRecords(sheetRecords, headers)
      if (issues.length === 0) { setUpdateError('找不到已開單的 Jira Issue Key，請確認「Jira issue key」欄位有資料'); return }
      const records: UpdateRecord[] = issues.map(i => ({ issueKey: i.issueKey, rowIndex: i.rowIndex }))
      setUpdateRecords(records)
      setUpdateTabHeaders(headers)
      setUpdateTabRecords(sheetRecords)
      setUpdateSelectedKeys(new Set(records.map(r => r.issueKey)))

      // Load Jira data (summary, status, assignee)
      fetchUpdateJiraData(records.map(r => r.issueKey))

      // Fetch transitions — try currentAccount first, then all stored accounts
      const emailsToTry: string[] = []
      if (currentAccount?.email) emailsToTry.push(currentAccount.email)
      try {
        const accResp = await fetch('/api/jira/accounts')
        const accData = await accResp.json() as { accounts?: { email: string }[] }
        for (const a of accData.accounts ?? []) {
          if (!emailsToTry.includes(a.email)) emailsToTry.push(a.email)
        }
      } catch { /* ignore */ }
      const firstKey = records[0].issueKey
      for (const email of emailsToTry) {
        try {
          const transResp = await fetch(`/api/jira/transitions?issueKey=${firstKey}`, {
            headers: { 'x-jira-email': email },
          })
          const transData = await transResp.json() as { ok: boolean; transitions?: JiraTransitionOption[] }
          if (transData.ok && (transData.transitions ?? []).length > 0) {
            setUpdateTransitions(transData.transitions ?? [])
            setUpdateTransitionId(transData.transitions![0].id)
            break
          }
        } catch { /* try next */ }
      }

      setUpdateStep(2)
      setLastSheetUrl(url.trim()); setLastSheetSource(source)
    } catch (e) {
      setUpdateError(String(e))
    } finally {
      setUpdateLoading(false)
    }
  }

  // 重新讀取 Sheet（不切換 step，保留已勾選單號 / 已選的轉換狀態）
  const handleReloadUpdateSheet = async () => {
    if (!updateBitableUrl.trim()) return
    setUpdateLoading(true); setUpdateError(''); setUpdateReloadMsg('')
    try {
      const endpoint = updateTabSource === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: updateBitableUrl.trim(), includeCreated: true }),
      })
      const data = await resp.json() as { ok: boolean; records?: SheetRecord[]; headers?: string[]; message?: string }
      if (!data.ok) { setUpdateError(data.message ?? '讀取失敗'); return }
      const sheetRecordsFresh = data.records ?? []
      const headers = data.headers ?? []
      const issues = extractJiraIssuesFromRecords(sheetRecordsFresh, headers)
      const records: UpdateRecord[] = issues.map(i => ({ issueKey: i.issueKey, rowIndex: i.rowIndex }))
      setUpdateRecords(records)
      setUpdateTabHeaders(headers)
      setUpdateTabRecords(sheetRecordsFresh)
      const freshKeys = new Set(records.map(r => r.issueKey))
      setUpdateSelectedKeys(prev => new Set([...prev, ...freshKeys].filter(k => freshKeys.has(k))))
      void fetchUpdateJiraData(records.map(r => r.issueKey))
      setUpdateReloadMsg(`通過 已重新讀取（${records.length} 筆）`)
    } catch (e) {
      setUpdateError(String(e))
    } finally {
      setUpdateLoading(false)
    }
  }

  const handleUpdateExecute = async () => {
    if (updateSubmitting) return

    // ── 送出前重新從 Jira fetch 最新資料，再做必填欄位驗證 ──
    const filtered = updateRecords.filter(r => updateSelectedKeys.has(r.issueKey))
    setUpdateValidationErrors([])

    // Re-fetch fresh Jira data before validating
    let freshJiraData = updateJiraData
    if (currentAccount && filtered.length > 0) {
      try {
        const r = await fetch('/api/jira/batch-fetch-fields', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-jira-email': currentAccount.email },
          body: JSON.stringify({ issueKeys: filtered.map(r => r.issueKey) }),
        })
        const d = await r.json() as { ok: boolean; issues?: Record<string, Record<string, string>>; _debugCf?: Record<string, unknown>; _detectedRdFieldIds?: string[] }
        if (d.ok && d.issues) {
          freshJiraData = { ...updateJiraData, ...d.issues }
          setUpdateJiraData(freshJiraData)
        }
        console.log('[batch-update] detectedRdFieldIds:', d._detectedRdFieldIds)
        console.log('[batch-update] _debugCf:', d._debugCf)
      } catch { /* use cached data */ }
    }

    console.log('[batch-update] freshJiraData:', freshJiraData)
    const validationErrors: { issueKey: string; missing: string[] }[] = []
    for (const r of filtered) {
      const jira = freshJiraData[r.issueKey]
      if (!jira) continue
      const missing: string[] = []
      if (!jira.summary?.trim()) missing.push('摘要')
      if (!jira.description?.trim()) missing.push('描述')
      if (!jira.assignee?.trim()) missing.push('受託人')
      if (!jira.rdOwner?.trim()) missing.push('RD負責人')
      if (missing.length > 0) {
        console.log(`[batch-update] ${r.issueKey} missing:`, missing, 'jira fields:', jira)
        validationErrors.push({ issueKey: r.issueKey, missing })
      }
    }
    if (validationErrors.length > 0) {
      setUpdateValidationErrors(validationErrors)
      return
    }

    setUpdateSubmitting(true); setUpdateResults([])
    const execEmail = currentAccount?.email ?? ''
    const selectedTransitionName = updateTransitions.find(t => t.id === updateTransitionId)
    const transitionLabel = selectedTransitionName ? (selectedTransitionName.toName ?? selectedTransitionName.name) : undefined
    const items = filtered.map(r => ({
      issueKey: r.issueKey,
      email: execEmail,
      transitionId: updateTransitionId || undefined,
      transitionName: updateTransitionId ? transitionLabel : undefined,
    }))
    setUpdateProgress({ done: 0, total: items.length })
    try {
      const allResults: { issueKey: string; ok: boolean; skipped?: boolean; error?: string }[] = []
      for (let i = 0; i < items.length; i++) {
        try {
          const resp = await fetch('/api/jira/bulk-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [items[i]] }),
          })
          const data = await resp.json() as { ok: boolean; results?: { issueKey: string; ok: boolean; skipped?: boolean; error?: string }[]; message?: string }
          if (data.results) allResults.push(...data.results)
          else allResults.push({ issueKey: items[i].issueKey, ok: false, error: data.message ?? `HTTP ${resp.status}` })
        } catch (e) {
          allResults.push({ issueKey: items[i].issueKey, ok: false, error: String(e) })
        }
        setUpdateProgress({ done: i + 1, total: items.length })
      }
      const results = allResults
      setUpdateResults(results)
      setUpdateStep(3)

      // Writeback 處理階段 to Lark Sheet——只有真的成功切換狀態的才寫「已切換狀態」，
      // skipped（沒選目標狀態，Jira 端根本沒被呼叫）不能算「已切換」，寫回去會誤導之後的比對
      const succeededKeys = new Set(results.filter(r => r.ok && !r.skipped).map(r => r.issueKey))
      const succeededRows = filtered.filter(r => succeededKeys.has(r.issueKey))
      if (succeededRows.length > 0 && updateBitableUrl) {
        fetch('/api/sheets/writeback-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheetUrl: updateBitableUrl, source: updateTabSource,
            writes: succeededRows.map(r => ({
              rowIndex: r.rowIndex,
              columns: { '處理階段': '已切換狀態', '處理時間': nowString() },
            })),
          }),
        }).catch(() => {})
      }
    } catch (e) {
      setUpdateError(String(e))
    } finally {
      setUpdateSubmitting(false)
      setUpdateProgress(null)
    }
  }

  const handleUpdateReset = () => {
    setUpdateStep(1); setUpdateBitableUrl(''); setUpdateRecords([]); setUpdateError('')
    setUpdateTransitions([]); setUpdateTransitionId(''); setUpdateResults([])
    setUpdateJiraData({}); setUpdateJiraError(''); setUpdateSelectedKeys(new Set())
    setUpdateValidationErrors([])
  }

  const handleUpdateTitleWriteback = async () => {
    const selectedRecs = updateRecords.filter(r => updateSelectedKeys.has(r.issueKey))
    if (!selectedRecs.length) return
    setUpdateTitleWritebackLoading(true)
    setUpdateTitleWritebackMsg('')
    const jiraBase = import.meta.env.VITE_JIRA_BASE_URL ?? ''
    try {
      const resp = await fetch('/api/sheets/writeback-multi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheetUrl: updateBitableUrl, source: updateTabSource,
          writes: selectedRecs.map(r => {
            const summary = updateJiraData[r.issueKey]?.summary ?? ''
            const jiraUrl = `${jiraBase}/browse/${r.issueKey}`
            return {
              rowIndex: r.rowIndex,
              columns: {
                '單子標題貼這': {
                  type: 'richtext',
                  segments: [
                    { text: r.issueKey, link: jiraUrl },
                    { text: `\n${summary}` },
                  ],
                },
              },
            }
          }),
        }),
      })
      const data = await resp.json() as { ok: boolean; results?: { rowIndex: number; ok: boolean }[] }
      const ok = data.results?.filter(r => r.ok).length ?? 0
      const fail = (data.results?.length ?? 0) - ok
      setUpdateTitleWritebackMsg(fail > 0 ? `回填完成：${ok} 成功，${fail} 失敗` : `通過 已回填 ${ok} 筆`)
    } catch { setUpdateTitleWritebackMsg('失敗 回填失敗：網路錯誤') }
    finally { setUpdateTitleWritebackLoading(false) }
  }

  // 每個 Tab 各自的「重新讀取 Sheet」按鈕 — 各自獨立的 loading / 訊息狀態，切換 Tab 不會互相殘留
  const StepDot = ({ s }: { s: Step }) => (
    <span className={`step-dot${step === s ? ' active' : step > s ? ' done' : ''}`}>
      {step > s ? '通過' : s}
    </span>
  )

  // 切換批量工具分頁時，自動帶入「最後使用的 Sheet」網址並自動重新讀取一次，
  // 不用每次切換都重貼網址；每個工具原本的手動「讀取」/「重新讀取」按鈕仍保留，
  // 可以隨時換一份不同的 Sheet。用 (分頁, url, source) 組合記錄「這個分頁上次
  // 自動套用的是哪份 Sheet」——同一份 Sheet 不會對同一個分頁重複自動觸發，但只要
  // 換了新 Sheet（在其他分頁重新讀取過），切回已經自動讀過的分頁還是會再自動讀
  // 一次最新的（Codex code review 建議修正）。
  useEffect(() => {
    if (!lastSheetUrl.trim()) return
    const comboKey = `${lastSheetUrl}::${lastSheetSource}`
    if (autoLoadedSubModes.current.get(qaSubMode) === comboKey) return
    autoLoadedSubModes.current.set(qaSubMode, comboKey)
    if (qaSubMode === 'comment') {
      setCommentTabSource(lastSheetSource); setCommentTabUrl(lastSheetUrl)
      void handleCommentTabLoad(lastSheetUrl, lastSheetSource)
    } else if (qaSubMode === 'update') {
      setUpdateTabSource(lastSheetSource); setUpdateBitableUrl(lastSheetUrl)
      void handleUpdateFetchBitable(lastSheetUrl, lastSheetSource)
    } else if (qaSubMode === 'edit') {
      setEditTabSource(lastSheetSource); setEditTabUrl(lastSheetUrl)
      void handleEditTabLoad(lastSheetUrl, lastSheetSource)
    } else if (qaSubMode === 'create') {
      // 批量開單 Step 2 之前還有 Step 1（選專案/Issue 類型）要先完成，
      // 只帶入網址方便使用者，不自動送出讀取請求
      setSheetSource(lastSheetSource); setSheetUrl(lastSheetUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qaSubMode, lastSheetUrl, lastSheetSource])

  return (
    <div className="page-layout">
      {/* QA sub-tabs */}
      <div style={{ display: 'flex', gap: 8, padding: '6px 0 2px', flexWrap: 'wrap' }}>
        {(['create', 'comment', 'update', 'edit'] as const).map(sub => (
          <button
            key={sub}
            type="button"
            onClick={() => { setQaSubMode(sub); if (sub === 'create' && step >= 5) setStep(1) }}
            style={{
              padding: '5px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${qaSubMode === sub ? '#3b82f6' : '#2d3f55'}`,
              background: qaSubMode === sub ? '#1e3a5f' : 'transparent',
              color: qaSubMode === sub ? '#93c5fd' : '#64748b',
            }}
          >
            {sub === 'create' ? '批量開單' : sub === 'comment' ? '批量評論' : sub === 'update' ? '批量更新狀態' : '批量修改'}
          </button>
        ))}
      </div>

      {/* Top bar */}
      <div className="page-topbar">
        <div className="step-indicator">
          {qaSubMode === 'create'
            ? ([1, 2, 3, 4] as Step[]).map(s => <StepDot key={s} s={s} />)
            : qaSubMode === 'comment'
              ? ([1, 2, 3] as const).map(s => (
                  <span key={s} className={`step-dot${commentTabStep === s ? ' active' : commentTabStep > s ? ' done' : ''}`}>
                    {commentTabStep > s ? '通過' : s}
                  </span>
                ))
            : qaSubMode === 'edit'
              ? ([1, 2, 3, 4] as const).map(s => (
                  <span key={s} className={`step-dot${editTabStep === s ? ' active' : editTabStep > s ? ' done' : ''}`}>
                    {editTabStep > s ? '通過' : s}
                  </span>
                ))
            : ([1, 2, 3] as const).map(s => (
                <span key={s} className={`step-dot${
                  updateStep === s ? ' active' :
                  updateStep > s ? ' done' : ''}`}>
                  {updateStep > s ? '通過' : s}
                </span>
              ))
          }
          <span className="step-label">
            {qaSubMode === 'create' ? (STEP_LABELS[step] ?? '')
              : qaSubMode === 'comment'
                ? ({ 1: '讀取表格', 2: '選擇單子', 3: '設定評論' } as Record<number, string>)[commentTabStep]
              : qaSubMode === 'edit'
                ? ({ 1: '讀取表格', 2: '選擇單子', 3: '設定欄位', 4: '修改結果' } as Record<number, string>)[editTabStep]
              : ({ 1: '讀取表格', 2: '設定帳號 & 動作', 3: '執行結果' } as Record<number, string>)[updateStep]}
          </span>
        </div>
        <div style={{ display: 'none' }}>
          <button type="button"
            className={`settings-btn${currentAccount ? ' has-creds' : ''}`}
            onClick={() => setShowAccountModal(true)}>
            <XianxiaIcon name="account" size={17} /> {currentAccount ? currentAccount.label : '選擇帳號'}
          </button>
        </div>
      </div>

      {/* ── Update Mode (inside QA) ── */}
      {qaSubMode === 'update' && (
        <JiraBatchUpdateTab
          updateStep={updateStep}
          setUpdateStep={setUpdateStep}
          updateTabSource={updateTabSource}
          setUpdateTabSource={setUpdateTabSource}
          updateBitableUrl={updateBitableUrl}
          setUpdateBitableUrl={setUpdateBitableUrl}
          updateError={updateError}
          setUpdateError={setUpdateError}
          handleUpdateFetchBitable={handleUpdateFetchBitable}
          updateLoading={updateLoading}
          updateReloadMsg={updateReloadMsg}
          handleReloadUpdateSheet={handleReloadUpdateSheet}
          updateRecords={updateRecords}
          updateFilterableColumns={updateFilterableColumns}
          updateTabColFilters={updateTabColFilters}
          setUpdateTabColFilters={setUpdateTabColFilters}
          updateColumnUniqueValues={updateColumnUniqueValues}
          updateFilteredRecords={updateFilteredRecords}
          updateJiraStatusFilter={updateJiraStatusFilter}
          setUpdateJiraStatusFilter={setUpdateJiraStatusFilter}
          updateJiraStatusOptions={updateJiraStatusOptions}
          currentAccount={currentAccount}
          updateTransitions={updateTransitions}
          updateTransitionId={updateTransitionId}
          setUpdateTransitionId={setUpdateTransitionId}
          updateJiraError={updateJiraError}
          fetchUpdateJiraData={fetchUpdateJiraData}
          rdFieldDetecting={rdFieldDetecting}
          setRdFieldDetecting={setRdFieldDetecting}
          rdFieldCandidates={rdFieldCandidates}
          setRdFieldCandidates={setRdFieldCandidates}
          emailHeader={emailHeader}
          updateJiraData={updateJiraData}
          updateSelectedKeys={updateSelectedKeys}
          setUpdateSelectedKeys={setUpdateSelectedKeys}
          updateJiraLoading={updateJiraLoading}
          updateValidationErrors={updateValidationErrors}
          updateSubmitting={updateSubmitting}
          updateProgress={updateProgress}
          updateTitleWritebackLoading={updateTitleWritebackLoading}
          handleUpdateTitleWriteback={handleUpdateTitleWriteback}
          updateTitleWritebackMsg={updateTitleWritebackMsg}
          handleUpdateExecute={handleUpdateExecute}
          updateResults={updateResults}
          handleUpdateReset={handleUpdateReset}
        />
      )}

      {/* ── QA Mode — 批量開單 ── */}
      {qaSubMode === 'create' && (
      <>

      <JiraCreateStep12
        step={step}
        setStep={setStep}
        currentAccount={currentAccount}
        projectsLoading={projectsLoading}
        projects={projects}
        selectedProjectId={selectedProjectId}
        setSelectedProjectId={setSelectedProjectId}
        issueTypes={issueTypes}
        selectedIssueTypeId={selectedIssueTypeId}
        setSelectedIssueTypeId={setSelectedIssueTypeId}
        sheetSource={sheetSource}
        setSheetSource={setSheetSource}
        sheetUrl={sheetUrl}
        setSheetUrl={setSheetUrl}
        sheetError={sheetError}
        setSheetError={setSheetError}
        sheetLoading={sheetLoading}
        handleFetchSheet={handleFetchSheet}
      />

      {/* ── Step 3 ── */}
      {step === 3 && (
        <JiraCreateStep3
          fieldsLoading={fieldsLoading}
          jiraFields={jiraFields}
          filteredRecords={filteredRecords}
          selectedRows={selectedRows}
          setSelectedRows={setSelectedRows}
          fieldsError={fieldsError}
          sheetLoading={sheetLoading}
          createReloadMsg={createReloadMsg}
          handleReloadCreateSheet={handleReloadCreateSheet}
          larkPrefillApplied={larkPrefillApplied}
          applyLarkPrefill={applyLarkPrefill}
          cellErrors={cellErrors}
          renderSummaryPrefixPanel={renderSummaryPrefixPanel}
          sheetHeaders={sheetHeaders}
          filterableColumns={filterableColumns}
          columnFilters={columnFilters}
          setColumnFilters={setColumnFilters}
          columnUniqueValues={columnUniqueValues}
          planCreate={planCreate}
          planComment={planComment}
          planTransition={planTransition}
          sheetRecords={sheetRecords}
          showFieldPicker={showFieldPicker}
          setShowFieldPicker={setShowFieldPicker}
          fieldPickerSearch={fieldPickerSearch}
          setFieldPickerSearch={setFieldPickerSearch}
          inactiveOptionalJiraFields={inactiveOptionalJiraFields}
          setActiveOptionalKeys={setActiveOptionalKeys}
          showBulkPanel={showBulkPanel}
          setShowBulkPanel={setShowBulkPanel}
          visibleJiraFields={visibleJiraFields}
          bulkValues={bulkValues}
          setBulkValues={setBulkValues}
          isFieldRequired={isFieldRequired}
          userLabelForField={userLabelForField}
          userOptionsForField={userOptionsForField}
          searchProjectKey={searchProjectKey}
          selectedIssueTypeId={selectedIssueTypeId}
          searchIssueTypeName={searchIssueTypeName}
          currentAccount={currentAccount}
          mergeFieldUsers={mergeFieldUsers}
          applyBulkColumn={applyBulkColumn}
          aiSummaryEnabled={aiSummaryEnabled}
          setAiSummaryEnabled={setAiSummaryEnabled}
          aiPrefixColumns={aiPrefixColumns}
          setAiPrefixColumns={setAiPrefixColumns}
          aiContentColumn={aiContentColumn}
          setAiContentColumn={setAiContentColumn}
          aiSummaryModel={aiSummaryModel}
          setAiSummaryModel={setAiSummaryModel}
          summaryGenerating={summaryGenerating}
          handleGenerateSummaries={handleGenerateSummaries}
          summaryProgress={summaryProgress}
          generatedSummaries={generatedSummaries}
          setGeneratedSummaries={setGeneratedSummaries}
          setSummaryProgress={setSummaryProgress}
          requiredJiraFields={requiredJiraFields}
          activeOptionalJiraFields={activeOptionalJiraFields}
          descPrefetchLoading={descPrefetchLoading}
          cellValues={cellValues}
          setCellValue={setCellValue}
          toggleMultiuser={toggleMultiuser}
          toggleRow={toggleRow}
          descAttachMap={descAttachMap}
          setDescAttachMap={setDescAttachMap}
          descUploadErrors={descUploadErrors}
          setDescUploadErrors={setDescUploadErrors}
          emailHeader={emailHeader}
          setDescLightboxSrc={setDescLightboxSrc}
          members={members}
          createProgress={createProgress}
          submitting={submitting}
          setStep={setStep}
          handleCreate={handleCreate}
        />
      )}

      {/* Attachment lightbox */}
      {descLightboxSrc && (
        <div onClick={() => setDescLightboxSrc(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
          <button type="button" onClick={() => setDescLightboxSrc(null)}
            style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 28, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>關閉</button>
          <img src={descLightboxSrc} alt="attachment preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, border: '1px solid #2d3f55' }} />
        </div>
      )}
      {editDescLightboxSrc && (
        <div onClick={() => setEditDescLightboxSrc(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
          <button type="button" onClick={() => setEditDescLightboxSrc(null)}
            style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 28, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>關閉</button>
          <img src={editDescLightboxSrc} alt="attachment preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, border: '1px solid #2d3f55' }} />
        </div>
      )}

      {/* ── Step 4: 建立結果 ── */}
      {step === 4 && (
        <JiraCreateStep4
          planCreate={planCreate}
          pendingWritebackCount={pendingWritebackCount}
          retryingWriteback={retryingWriteback}
          setRetryingWriteback={setRetryingWriteback}
          currentAccount={currentAccount}
          sheetUrl={sheetUrl}
          setPendingWritebackCount={setPendingWritebackCount}
          createResults={createResults}
          isGame={isGame}
          planComment={planComment}
          planTransition={planTransition}
          handleReset={handleReset}
        />
      )}

      </> // end create block
      )}

      {/* ── Comment Tab: 批量評論（standalone 入口） ── */}
      {qaSubMode === 'comment' && (commentTabStep === 1 || commentTabStep === 2) && (
        <JiraBatchCommentTab
          commentTabStep={commentTabStep}
          commentTabSource={commentTabSource}
          setCommentTabSource={setCommentTabSource}
          commentTabUrl={commentTabUrl}
          setCommentTabUrl={setCommentTabUrl}
          commentTabError={commentTabError}
          setCommentTabError={setCommentTabError}
          commentTabLoading={commentTabLoading}
          handleCommentTabLoad={handleCommentTabLoad}
          trackedIssues={trackedIssues}
          setTrackedIssues={setTrackedIssues}
          commentReloadMsg={commentReloadMsg}
          handleReloadCommentSheet={handleReloadCommentSheet}
          commentFilterableColumns={commentFilterableColumns}
          commentTabColFilters={commentTabColFilters}
          setCommentTabColFilters={setCommentTabColFilters}
          commentColumnUniqueValues={commentColumnUniqueValues}
          commentFilteredIssues={commentFilteredIssues}
          commentTabSelectedKeys={commentTabSelectedKeys}
          setCommentTabSelectedKeys={setCommentTabSelectedKeys}
          sheetHeaders={sheetHeaders}
          sheetRecords={sheetRecords}
          setCommentTabStep={setCommentTabStep}
        />
      )}

      {/* ── Step 5: 添加評論 ── */}
      {(qaSubMode === 'comment' && commentTabStep === 3) && (
        <JiraBatchCommentStep3
          toComment={toComment}
          commentTabLoading={commentTabLoading}
          commentReloadMsg={commentReloadMsg}
          handleReloadCommentSheet={handleReloadCommentSheet}
          setCommentTabStep={setCommentTabStep}
          setTrackedIssues={setTrackedIssues}
          setCommentResults={setCommentResults}
          setPreviewMode={setPreviewMode}
          setPreviewItems={setPreviewItems}
          commentColumn={commentColumn}
          setCommentColumn={setCommentColumn}
          sheetHeaders={sheetHeaders}
          attachmentColumn={attachmentColumn}
          setAttachmentColumn={setAttachmentColumn}
          isAdmin={isAdmin}
          useAiComment={useAiComment}
          setUseAiComment={setUseAiComment}
          canAiFormat={canAiFormat}
          canAiReview={canAiReview}
          personColumn={personColumn}
          setPersonColumn={setPersonColumn}
          personResolve={personResolve}
          personResolving={personResolving}
          personBlocking={personBlocking}
          rowIdentityMissing={rowIdentityMissing.length}
          commentAsCandidates={commentAsCandidates}
          identityEmailForRow={identityEmailForRow}
          setRowCommentAs={setRowCommentAs}
          useAiReview={useAiReview}
          setUseAiReview={setUseAiReview}
          selectedPromptId={selectedPromptId}
          setSelectedPromptId={setSelectedPromptId}
          availablePrompts={availablePrompts}
          commentModel={commentModel}
          setCommentModel={setCommentModel}
          kbDocs={kbDocs}
          selectedKbDocIds={selectedKbDocIds}
          setSelectedKbDocIds={setSelectedKbDocIds}
          specContext={specContext}
          setSpecContext={setSpecContext}
          commentResults={commentResults}
          pendingCommentRequestId={pendingCommentRequestId}
          previewMode={previewMode}
          prefetchLoading={prefetchLoading}
          handleEnterPreview={handleEnterPreview}
          commentSubmitting={commentSubmitting}
          COMMENT_TEMPLATE={COMMENT_TEMPLATE}
          COMMENT_TEMPLATE_SECTIONS={COMMENT_TEMPLATE_SECTIONS}
          handleBatchAppendTemplate={handleBatchAppendTemplate}
          previewItems={previewItems}
          prefetchError={prefetchError}
          updatePreviewComment={updatePreviewComment}
          handleRemoveAttachment={handleRemoveAttachment}
          uploadingRows={uploadingRows}
          handleManualUpload={handleManualUpload}
          uploadErrors={uploadErrors}
          commentProgress={commentProgress}
          handleSubmitFromPreview={handleSubmitFromPreview}
          sheetRecords={sheetRecords}
        />
      )}

      {/* ── Step 6: 切換狀態 ── */}
      {false && qaSubMode === 'create' && step === 6 && (
        <div className="section-card">
          <h2 className="section-title">Step 6 — 切換狀態（{toTransition.length} 筆）</h2>

          {toTransition.length === 0
            ? <div className="alert-info">目前無需切換狀態的 Issue（可能尚未添加評論，或已全部完成）。</div>
            : (
              <div className="form-stack" style={{ marginBottom: 12 }}>
                <label className="field" style={{ maxWidth: 360 }}>
                  <span>要切換成的狀態 <em className="req">*</em></span>
                  <select
                    value={selectedTransitionId}
                    onChange={e => setSelectedTransitionId(e.target.value)}
                    disabled={transitionOptionsLoading || transitionOptions.length === 0}
                  >
                    {transitionOptionsLoading
                      ? <option value="">載入狀態中...</option>
                      : transitionOptions.length === 0
                        ? <option value="">無可用狀態</option>
                        : transitionOptions.map(t => (
                          <option key={t.id} value={t.id}>
                            {t.toName ?? t.name}{t.toName && t.toName !== t.name ? `（${t.name}）` : ''}
                          </option>
                        ))}
                  </select>
                  <span className="field-hint">依第一張待切換 Issue 動態讀取 Jira 可用 transition。</span>
                </label>
                {transitionOptionsError && <div className="alert-error">{transitionOptionsError}</div>}
              </div>
            )}

          <div className="stage-issues">
            {toTransition.map(t => (
              <span key={t.rowIndex} className="issue-chip">
                <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${t.issueKey}`} target="_blank" rel="noreferrer">
                  {t.issueKey}
                </a>
              </span>
            ))}
          </div>

          {transitionResults.length > 0 && (
            <div className="result-group" style={{ marginTop: 12 }}>
              {transitionResults.map(r => (
                <div key={r.rowIndex} className={`result-row ${r.ok ? 'ok' : 'error'}`}>
                  <code>{r.issueKey}</code>
                  {r.ok
                    ? <span className="badge badge--ok">狀態已更新 通過</span>
                    : <span className="err-msg">{r.error ?? '失敗'}</span>}
                </div>
              ))}
            </div>
          )}

          {transitionSubmitting && (() => {
            const transDone = transitionProgress?.done ?? 0
            const transTotal = transitionProgress?.total ?? 1
            const hasTransProg = transitionProgress != null
            const transct = hasTransProg ? Math.round(transDone / transTotal * 100) : 0
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8' }}>
                  <span>{hasTransProg ? `處理中 ${transDone} / ${transTotal}` : '提交中...'}</span>
                  {hasTransProg && <span>{transct}%</span>}
                </div>
                <div style={{ height: 6, borderRadius: 3, background: '#1e2d3d', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, background: '#3b82f6', width: `${transct}%`, transition: 'width 0.3s ease', animation: transct === 0 ? 'progressPulse 1.5s ease-in-out infinite' : 'none' }} />
                </div>
              </div>
            )
          })()}
          <div className="stage-nav" style={{ marginTop: 16 }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(5)}>上一步</button>
            {toTransition.length > 0 && (
              <button type="button" className={`submit-btn submit-btn--step${transitionSubmitting ? ' loading' : ''}`}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={transitionSubmitting || !selectedTransitionId} onClick={handleTransition}>
                {transitionSubmitting ? '更新中...' : `批次切換狀態（${toTransition.length} 筆）`}
              </button>
            )}
          </div>
          {(transitionResults.length > 0 || toTransition.length === 0) && (
            <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 12, background: '#166534' }} onClick={handleReset}>
              完成，重新開始
            </button>
          )}
        </div>
      )}

      {/* ── Edit Tab: 批量修改 ── */}
      {qaSubMode === 'edit' && (
        <JiraBatchEditTab
          editTabStep={editTabStep}
          setEditTabStep={setEditTabStep}
          editTabSource={editTabSource}
          setEditTabSource={setEditTabSource}
          editTabUrl={editTabUrl}
          setEditTabUrl={setEditTabUrl}
          editTabError={editTabError}
          setEditTabError={setEditTabError}
          handleEditTabLoad={handleEditTabLoad}
          editTabLoading={editTabLoading}
          editTabIssues={editTabIssues}
          editTabJiraLoading={editTabJiraLoading}
          editReloadMsg={editReloadMsg}
          handleReloadEditSheet={handleReloadEditSheet}
          editTabJiraError={editTabJiraError}
          fetchEditTabJiraData={fetchEditTabJiraData}
          editFilterableColumns={editFilterableColumns}
          editTabColFilters={editTabColFilters}
          setEditTabColFilters={setEditTabColFilters}
          editColumnUniqueValues={editColumnUniqueValues}
          editFilteredIssues={editFilteredIssues}
          editJiraStatusFilter={editJiraStatusFilter}
          setEditJiraStatusFilter={setEditJiraStatusFilter}
          editJiraStatusOptions={editJiraStatusOptions}
          editTabSelectedKeys={editTabSelectedKeys}
          setEditTabSelectedKeys={setEditTabSelectedKeys}
          editAlreadyEditedKeys={editAlreadyEditedKeys}
          editTabJiraData={editTabJiraData}
          renderSummaryPrefixPanel={renderSummaryPrefixPanel}
          editTabHeaders={editTabHeaders}
          editTabRecords={editTabRecords}
          editFieldMappings={editFieldMappings}
          setEditFieldMappings={setEditFieldMappings}
          editTabAvailableFields={editTabAvailableFields}
          editTabMembers={editTabMembers}
          editTabMembersLoading={editTabMembersLoading}
          blankMapping={blankMapping}
          editDescAttachCol={editDescAttachCol}
          setEditDescAttachCol={setEditDescAttachCol}
          handleEditDescPrefetch={handleEditDescPrefetch}
          editDescPrefetchLoading={editDescPrefetchLoading}
          summaryPrefixEnabled={summaryPrefixEnabled}
          computeSummaryPrefix={computeSummaryPrefix}
          editDescAttachMap={editDescAttachMap}
          setEditDescAttachMap={setEditDescAttachMap}
          setEditDescLightboxSrc={setEditDescLightboxSrc}
          emailHeader={emailHeader}
          editDescUploadErrors={editDescUploadErrors}
          setEditDescUploadErrors={setEditDescUploadErrors}
          editTabSubmitting={editTabSubmitting}
          editProgress={editProgress}
          currentAccount={currentAccount}
          handleEditTabSubmit={handleEditTabSubmit}
          editTabResults={editTabResults}
          setEditTabIssues={setEditTabIssues}
          setEditTabRecords={setEditTabRecords}
          setEditTabHeaders={setEditTabHeaders}
          setEditTabResults={setEditTabResults}
        />
      )}

      {/* ── 待補回寫面板（persistent，有 pending/failed 才顯示觸發按鈕）── */}
      {qaSubMode === 'create' && (
        <div style={{ marginTop: 16 }}>
          {/* Collapsed trigger — low-profile unless there are pending records */}
          {!showPendingPanel && !reconcileOpen && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {pendingWritebackCount > 0 && (
                <span style={{ fontSize: 12, color: '#f59e0b' }}>有 {pendingWritebackCount} 筆回寫失敗</span>
              )}
              <button
                style={{ background: 'none', border: 'none', color: '#475569', fontSize: 12, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                onClick={async () => {
                  const r = await fetch('/api/jira/pending-writebacks?status=pending,failed').then(r => r.json()) as { ok: boolean; rows?: typeof pendingRows }
                  if (r.ok) { setPendingRows(r.rows ?? []); setPendingWritebackCount(r.rows?.length ?? 0) }
                  setShowPendingPanel(true)
                }}
              >補回填工具</button>
            </div>
          )}

        <div className="section-card" style={{ marginTop: 8, display: (showPendingPanel || reconcileOpen) ? 'block' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 className="section-title" style={{ margin: 0 }}>補回填工具</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="settings-btn" onClick={async () => {
                const r = await fetch('/api/jira/pending-writebacks?status=pending,failed').then(r => r.json()) as { ok: boolean; rows?: typeof pendingRows }
                if (r.ok) setPendingRows(r.rows ?? [])
                setShowPendingPanel(s => !s)
              }}>{showPendingPanel ? '▲ 收起' : '待補記錄'}</button>
              <button className="settings-btn" onClick={() => setReconcileOpen(o => !o)}>
                {reconcileOpen ? '▲ 收起對帳' : '對帳補回填'}
              </button>
              <button
                style={{ background: 'none', border: 'none', color: '#475569', fontSize: 12, cursor: 'pointer', padding: '0 4px' }}
                onClick={() => { setShowPendingPanel(false); setReconcileOpen(false) }}
              >關閉</button>
            </div>
          </div>
          <div style={{ marginTop: 10, padding: '10px 14px', background: '#0f1f35', borderRadius: 8, fontSize: 12, color: '#94a3b8', lineHeight: 1.7 }}>
            <strong style={{ color: '#93c5fd' }}>使用說明</strong>
            <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
              <div>
                <span style={{ color: '#e2e8f0' }}>查看待補記錄</span><br />
                當批次開單後因斷線或 Lark timeout 導致回寫 Sheet 失敗，系統會自動保留這些記錄。點此查看所有 pending / failed 的紀錄，確認後點「全部重試」補寫回 Sheet。
              </div>
              <div>
                <span style={{ color: '#e2e8f0' }}>對帳補回填</span><br />
                適用於已遺失單號的舊資料。輸入 Jira 專案 Key、Lark Sheet URL 和開單日期範圍，系統會從 Jira 查出該時段建立的 Issue，與 Sheet 空白列做位置比對，高信心配對自動勾選，確認後寫回 Sheet。
              </div>
            </div>
          </div>

          {/* Pending writebacks list */}
          {showPendingPanel && (
            <div style={{ marginTop: 12 }}>
              {pendingRows.length === 0
                ? <p style={{ color: '#94a3b8', fontSize: 13 }}>目前沒有待補的回寫記錄。</p>
                : <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button className="submit-btn submit-btn--sm" disabled={retryingWriteback} onClick={async () => {
                      setRetryingWriteback(true)
                      try {
                        const ids = pendingRows.filter(r => r.status !== 'done').map(r => r.id)
                        if (ids.length === 0) return
                        const resp = await fetch('/api/jira/pending-writebacks/retry', {
                          method: 'POST', headers: { 'Content-Type': 'application/json', ...(currentAccount ? { 'x-jira-email': currentAccount.email } : {}) },
                          body: JSON.stringify({ ids }),
                        }).then(r => r.json()) as { ok: boolean; succeeded: number; retried: number }
                        if (resp.ok) {
                          alert(`補回填完成：${resp.succeeded}/${resp.retried} 筆成功`)
                          const fresh = await fetch('/api/jira/pending-writebacks?status=pending,failed').then(r => r.json()) as { ok: boolean; rows?: typeof pendingRows }
                          if (fresh.ok) setPendingRows(fresh.rows ?? [])
                          setPendingWritebackCount(fresh.rows?.length ?? 0)
                        }
                      } finally { setRetryingWriteback(false) }
                    }}>
                      {retryingWriteback ? '重試中...' : `重行 全部重試（${pendingRows.filter(r => r.status !== 'done').length} 筆）`}
                    </button>
                  </div>
                  <div className="table-wrap" style={{ overflowX: 'auto' }}>
                    <table className="sheet-preview-table">
                      <thead>
                        <tr>
                          <th>Jira Key</th>
                          <th>Row</th>
                          <th>摘要</th>
                          <th>狀態</th>
                          <th>嘗試</th>
                          <th>錯誤</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingRows.map(r => (
                          <tr key={r.id}>
                            <td><a href={r.jira_url} target="_blank" rel="noreferrer"><code>{r.jira_key}</code></a></td>
                            <td style={{ color: '#94a3b8' }}>{r.row_index}</td>
                            <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary}</td>
                            <td>
                              <span style={{ color: r.status === 'done' ? '#22c55e' : r.status === 'failed' ? '#ef4444' : '#f59e0b' }}>
                                {r.status}
                              </span>
                            </td>
                            <td style={{ color: '#94a3b8' }}>{r.attempt_count}</td>
                            <td style={{ color: '#ef4444', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.error ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              }
            </div>
          )}

          {/* Reconcile tool */}
          {reconcileOpen && (
            <div style={{ marginTop: 16, borderTop: '1px solid #334155', paddingTop: 16 }}>
              <h4 style={{ marginBottom: 12, color: '#e2e8f0' }}>對帳補回填 — 查詢 Jira 已建立的 Issue 並補寫 Sheet</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Jira 專案 Key *</label>
                  <input className="lark-url-input" style={{ width: '100%' }} placeholder="CGMN" value={reconcileProjectKey} onChange={e => setReconcileProjectKey(e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Lark Sheet URL *</label>
                  <input className="lark-url-input" style={{ width: '100%' }} placeholder="https://..." value={reconcileSheetUrl} onChange={e => setReconcileSheetUrl(e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>建立時間 從</label>
                  <div style={{ position: 'relative' }}>
                    <input type="date" className="lark-url-input date-input-custom" style={{ width: '100%', WebkitTextFillColor: reconcileFrom ? undefined : 'transparent', boxSizing: 'border-box' }} value={reconcileFrom} onChange={e => setReconcileFrom(e.target.value)} />
                    {!reconcileFrom && <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569', fontSize: 13, pointerEvents: 'none' }}>yyyy/mm/dd</span>}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>建立時間 至</label>
                  <div style={{ position: 'relative' }}>
                    <input type="date" className="lark-url-input date-input-custom" style={{ width: '100%', WebkitTextFillColor: reconcileTo ? undefined : 'transparent', boxSizing: 'border-box' }} value={reconcileTo} onChange={e => setReconcileTo(e.target.value)} />
                    {!reconcileTo && <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569', fontSize: 13, pointerEvents: 'none' }}>yyyy/mm/dd</span>}
                  </div>
                </div>
              </div>
              <button className="submit-btn submit-btn--sm" style={{ marginTop: 4 }} disabled={reconcileLoading || !reconcileProjectKey || !reconcileSheetUrl} onClick={async () => {
                setReconcileLoading(true)
                setReconcileMatches([]); setReconcileUnmatchedJira([]); setReconcileUnmatchedRows([]); setReconcileMsg('')
                try {
                  const raw = await fetch('/api/jira/reconcile/preview', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', ...(currentAccount ? { 'x-jira-email': currentAccount.email } : {}) },
                    body: JSON.stringify({
                      projectKey: reconcileProjectKey,
                      sheetUrl: reconcileSheetUrl,
                      createdFrom: reconcileFrom || new Date(Date.now() - 86400000).toISOString().slice(0,10),
                      createdTo: reconcileTo || new Date().toISOString().slice(0,10),
                    }),
                  })
                  const text = await raw.text()
                  let resp: { ok: boolean; matches?: typeof reconcileMatches; unmatchedJiraIssues?: typeof reconcileUnmatchedJira; unmatchedSheetRows?: typeof reconcileUnmatchedRows; message?: string }
                  try { resp = JSON.parse(text) } catch { setReconcileMsg(`Server 回傳非 JSON（HTTP ${raw.status}）：${text.slice(0, 200)}`); return }
                  if (!resp.ok) { setReconcileMsg(resp.message ?? '查詢失敗'); return }
                  setReconcileMatches(resp.matches ?? [])
                  setReconcileUnmatchedJira(resp.unmatchedJiraIssues ?? [])
                  setReconcileUnmatchedRows(resp.unmatchedSheetRows ?? [])
                  setReconcileSelected(new Set((resp.matches ?? []).filter(m => m.confidence === 'high').map(m => m.rowIndex)))
                  setReconcileMsg('')
                } catch (e) { setReconcileMsg(String(e)) }
                finally { setReconcileLoading(false) }
              }}>
                {reconcileLoading ? '查詢中...' : '查詢比對'}
              </button>

              {reconcileMsg && <p style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{reconcileMsg === '請先選擇帳號' ? '請先在頁面上方選擇 Jira 帳號，再使用對帳功能' : reconcileMsg}</p>}

              {reconcileMatches.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, color: '#e2e8f0' }}>找到 {reconcileMatches.length} 筆配對（可勾選後補回填）</span>
                    <button className="submit-btn submit-btn--sm" disabled={reconcileApplying || reconcileSelected.size === 0} onClick={async () => {
                      setReconcileApplying(true)
                      try {
                        const selected = reconcileMatches.filter(m => reconcileSelected.has(m.rowIndex))
                        const resp = await fetch('/api/jira/reconcile/apply', {
                          method: 'POST', headers: { 'Content-Type': 'application/json', ...(currentAccount ? { 'x-jira-email': currentAccount.email } : {}) },
                          body: JSON.stringify({
                            sheetUrl: reconcileSheetUrl,
                            matches: selected.map(m => ({ rowIndex: m.rowIndex, jiraKey: m.jiraKey, jiraSummary: m.jiraSummary })),
                          }),
                        }).then(r => r.json()) as { ok: boolean; succeeded: number; failed: number; message?: string }
                        if (resp.ok) {
                          setReconcileMsg(`通過 補回填完成：${resp.succeeded} 成功，${resp.failed} 失敗`)
                        } else {
                          setReconcileMsg(resp.message ?? '補回填失敗')
                        }
                      } catch (e) { setReconcileMsg(String(e)) }
                      finally { setReconcileApplying(false) }
                    }}>
                      {reconcileApplying ? '補回填中...' : `補回填選取（${reconcileSelected.size} 筆）`}
                    </button>
                  </div>
                  <table className="sheet-preview-table">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}><input type="checkbox"
                            checked={reconcileMatches.filter(m => m.confidence === 'high').every(m => reconcileSelected.has(m.rowIndex)) && reconcileMatches.filter(m => m.confidence === 'high').length > 0}
                            title="全選只選高信心配對"
                            onChange={e => setReconcileSelected(e.target.checked ? new Set(reconcileMatches.filter(m => m.confidence === 'high').map(m => m.rowIndex)) : new Set())} /></th>
                        <th>Row</th>
                        <th>Jira Key</th>
                        <th>Jira 摘要</th>
                        <th>Sheet 摘要</th>
                        <th>信心度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconcileMatches.map(m => (
                        <tr key={m.rowIndex}>
                          <td><input type="checkbox" checked={reconcileSelected.has(m.rowIndex)} onChange={e => setReconcileSelected(s => { const n = new Set(s); e.target.checked ? n.add(m.rowIndex) : n.delete(m.rowIndex); return n })} /></td>
                          <td style={{ color: '#94a3b8' }}>{m.rowIndex}</td>
                          <td><code>{m.jiraKey}</code></td>
                          <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.jiraSummary}</td>
                          <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#94a3b8' }}>{m.sheetSummary}</td>
                          <td><span style={{ color: m.confidence === 'high' ? '#22c55e' : '#f59e0b' }}>{m.confidence === 'high' ? '高' : '低'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(reconcileUnmatchedJira.length > 0 || reconcileUnmatchedRows.length > 0) && (
                    <p style={{ fontSize: 12, color: '#f59e0b', marginTop: 8 }}>
                      未配對：Jira {reconcileUnmatchedJira.length} 筆，Sheet {reconcileUnmatchedRows.length} 列（數量不一致，請手動確認）
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        </div>
      )}

      {showAccountModal && (
        <JiraAccountModal
          currentEmail={currentAccount?.email ?? ''}
          onClose={() => setShowAccountModal(false)}
          onSelect={handleAccountSelected}
          onClearCurrent={() => {
            setCurrentAccount(null)
            sessionStorage.removeItem(SESSION_KEY)
            sessionStorage.removeItem(ACCOUNT_BOOT_KEY)
            setMembers([]); setSelectedAssignee(''); setBatchAssigneeIds([]); setBatchRdOwnerIds([]); setBatchVerifierIds([]); setSheetUrl('')
            setSheetRecords([]); setSheetHeaders([]); setSelectedRows(new Set())
            setCreateResults([]); setCommentResults([]); setTransitionResults([])
            setTransitionOptions([]); setSelectedTransitionId(''); setTransitionOptionsError(''); setTransitionOptionsLoading(false)
            setTrackedIssues([])
            setStep(1)
          }}
        />
      )}

    </div>
  )
}

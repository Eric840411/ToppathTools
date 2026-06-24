import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { JiraAccountModal, accountHasRole, type AccountInfo } from '../components/JiraAccountModal'
import { SearchSelect } from '../components/SearchSelect'
import { ModelSelector } from '../components/ModelSelector'
import { DungeonIcon } from '../components/DungeonIcon'
import { useIsGameMode } from '../components/GameModeContext'
import { fetchAuthAccount, GLOBAL_ACCOUNT_KEY } from '../authSession'

interface Member {
  accountId: string
  displayName: string
  avatarUrl: string
}

interface SheetRecord {
  [key: string]: string
  _rowIndex: string
}

// 每列在工作流中的追蹤資訊
interface TrackedIssue {
  rowIndex: number
  issueKey: string   // 已有 or 新建完成後填入
  stage: string      // 讀自 sheet 或本 session 更新後的值
}

interface PMRecord {
  recordId: string
  summary: string
  description: string
  assigneeEmail: string
  rdOwnerEmail: string
  issueTypeName: string
  jiraProjectName: string
  parentTitle: string
  difficulty: string
  jiraKey: string
  isParent: boolean
}

interface PMResult {
  recordId: string
  issueKey?: string
  summary?: string
  error?: string
}

interface IssueCreateResult {
  rowIndex: number
  issueKey?: string
  error?: string
  writebackOk?: boolean
  writebackSkipped?: boolean
  writebackError?: string
}

interface StageOpResult {
  rowIndex: number
  issueKey: string
  ok: boolean
  usedAi?: boolean
  error?: string
}

type Step = 1 | 2 | 3 | 4 | 5 | 6
type SheetSource = 'lark' | 'google'

interface NormalizedJiraField {
  key: string
  name: string
  required: boolean
  type: 'string' | 'text' | 'number' | 'date' | 'datetime' | 'select' | 'multiselect' | 'user' | 'multiuser' | 'unknown'
  options?: { id: string; label: string }[]
  autoCompleteUrl?: string
}

interface JiraTransitionOption {
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

const getField = (r: SheetRecord, fieldName: string): string => {
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

// 依 處理階段 決定下一步需要做什麼
const needsCreate  = (r: SheetRecord) => !getField(r, JIRA_KEY_COL).trim()
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

const stageBadgeClass = (r: SheetRecord) => {
  if (needsCreate(r))     return 'badge badge--blue'
  if (needsComment(r))    return 'badge badge--ok'
  if (needsTransition(r)) return 'badge badge--purple'
  return 'badge'
}
const stageLabel = (r: SheetRecord) => {
  if (needsCreate(r))     return '待開單'
  if (needsComment(r))    return '已開單'
  if (needsTransition(r)) return '已評論'
  return getField(r, STAGE_COL) || '—'
}

const SHEET_FIELD: Record<string, string> = {
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

interface CachedAttachment {
  cacheId: string
  filename: string
  mimeType: string
  isImage: boolean
  isVideo: boolean
  size: number
  error?: string
}

interface PreviewItem {
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
  allowedModes?: string[]
  isAdmin?: boolean
}

// 使用者欄位即時搜尋（reporter 等空查詢只回前 ~50 推薦人，必須打名字才找得到其他人）
function UserFieldSearch({ field, projectKey, issueTypeId, issueTypeName, email, onPick }: {
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
        placeholder="🔍 搜尋使用者…"
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

export function JiraPage({ account = null, allowedModes, isAdmin = false }: JiraPageProps) {
  const isGame = useIsGameMode()
  const [mode, setMode] = useState<'qa' | 'pm'>('qa')
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

  // PM mode state
  const [pmStep, setPmStep] = useState<1 | 2 | 3>(1)
  const [pmBitableUrl, setPmBitableUrl] = useState('')
  const [pmParentKey, setPmParentKey] = useState('')
  const [pmLoading, setPmLoading] = useState(false)
  const [pmError, setPmError] = useState('')
  const [pmRecords, setPmRecords] = useState<PMRecord[]>([])
  const [pmSelectedIds, setPmSelectedIds] = useState<Set<string>>(new Set())
  const [pmSubmitting, setPmSubmitting] = useState(false)
  const [pmResults, setPmResults] = useState<PMResult[]>([])

  // Step 2
  const [sheetSource, setSheetSource] = useState<SheetSource>('lark')
  const [sheetUrl, setSheetUrl] = useState('')
  const [sheetLoading, setSheetLoading] = useState(false)
  const [sheetError, setSheetError] = useState('')
  const [sheetRecords, setSheetRecords] = useState<SheetRecord[]>([])
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([])

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

  // Step 4 (create)
  const [submitting, setSubmitting] = useState(false)
  const [createResults, setCreateResults] = useState<IssueCreateResult[]>([])

  // Step 5 (comment)
  const [commentColumn, setCommentColumn] = useState('')
  const [attachmentColumn, setAttachmentColumn] = useState('')
  const [useAiComment, setUseAiComment] = useState(false)
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
  const [summaryProgress, setSummaryProgress] = useState<{ done: number; total: number } | null>(null)

  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [pendingCommentRequestId, setPendingCommentRequestId] = useState('')
  const [commentProgress, setCommentProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [commentResults, setCommentResults] = useState<StageOpResult[]>([])

  // Preview mode state
  const [previewMode, setPreviewMode] = useState(false)
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([])
  const [prefetchLoading, setPrefetchLoading] = useState(false)
  const [prefetchError, setPrefetchError] = useState('')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [uploadingRows, setUploadingRows] = useState<Set<number>>(new Set())
  const [uploadErrors, setUploadErrors] = useState<Record<number, string>>({})

  // Step 6 (transition)
  const [transitionSubmitting, setTransitionSubmitting] = useState(false)
  const [transitionResults, setTransitionResults] = useState<StageOpResult[]>([])
  const [transitionOptions, setTransitionOptions] = useState<JiraTransitionOption[]>([])
  const [selectedTransitionId, setSelectedTransitionId] = useState('')
  const [transitionOptionsLoading, setTransitionOptionsLoading] = useState(false)
  const [transitionOptionsError, setTransitionOptionsError] = useState('')

  // ── Update mode ──
  type UpdateStep = 1 | 2 | 3
  type UpdateRecord = { issueKey: string; fillPerson: string; title: string; rowIndex: number }
  const [updateStep, setUpdateStep] = useState<UpdateStep>(1)
  const [updateBitableUrl, setUpdateBitableUrl] = useState('')
  const [updateLoading, setUpdateLoading] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [updateRecords, setUpdateRecords] = useState<UpdateRecord[]>([])
  const [updateJiraBaseUrl, setUpdateJiraBaseUrl] = useState('')
  // Transitions
  const [updateTransitions, setUpdateTransitions] = useState<JiraTransitionOption[]>([])
  const [updateTransitionId, setUpdateTransitionId] = useState('')
  const [updateSubmitting, setUpdateSubmitting] = useState(false)
  const [updateResults, setUpdateResults] = useState<{ issueKey: string; ok: boolean; error?: string }[]>([])
  const [updateStats, setUpdateStats] = useState<{ totalRows: number; found: number; skippedEmpty: number; skippedInvalid: number } | null>(null)
  const [updatePersonFilter, setUpdatePersonFilter] = useState<string>('') // '' = 全部, '__none__' = 無填寫人, else = 填寫人名
  const [updateSummaries, setUpdateSummaries] = useState<Record<string, string>>({}) // issueKey → Jira summary
  const [updateSelectedKeys, setUpdateSelectedKeys] = useState<Set<string>>(new Set()) // 勾選的 issue keys

  // ── Comment Tab (standalone 批量評論) ──
  const [commentTabUrl, setCommentTabUrl] = useState('')
  const [commentTabLoading, setCommentTabLoading] = useState(false)
  const [commentTabError, setCommentTabError] = useState('')
  const [commentTabStep, setCommentTabStep] = useState<1 | 2 | 3>(1) // 1=URL input, 2=select issues, 3=comment panel
  const [commentTabSelectedKeys, setCommentTabSelectedKeys] = useState<Set<string>>(new Set())

  // ── Edit Tab (批量修改) ──
  const [editTabUrl, setEditTabUrl] = useState('')
  const [editTabLoading, setEditTabLoading] = useState(false)
  const [editTabError, setEditTabError] = useState('')
  const [editTabStep, setEditTabStep] = useState<1 | 2 | 3 | 4>(1) // 1=URL, 2=select, 3=fields, 4=results
  const [editTabRecords, setEditTabRecords] = useState<SheetRecord[]>([])
  const [editTabHeaders, setEditTabHeaders] = useState<string[]>([])
  const [editTabIssues, setEditTabIssues] = useState<{ rowIndex: number; issueKey: string }[]>([])
  const [editTabSelectedKeys, setEditTabSelectedKeys] = useState<Set<string>>(new Set())
  const [editFieldMappings, setEditFieldMappings] = useState<{ jiraField: string; sheetColumn: string }[]>([
    { jiraField: 'summary', sheetColumn: '' },
  ])
  const [editTabSubmitting, setEditTabSubmitting] = useState(false)
  const [editTabResults, setEditTabResults] = useState<{ issueKey: string; ok: boolean; error?: string }[]>([])
  const [editTabJiraData, setEditTabJiraData] = useState<Record<string, Record<string, string>>>({})
  const [editTabJiraLoading, setEditTabJiraLoading] = useState(false)
  const [editTabJiraError, setEditTabJiraError] = useState('')

  // 追蹤所有已進入流程的 issue（本次 session 合併最新 stage）
  const [trackedIssues, setTrackedIssues] = useState<TrackedIssue[]>([])

  const emailHeader: Record<string, string> = currentAccount ? { 'x-jira-email': currentAccount.email } : {}

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

  const editFilteredIssues = useMemo(() =>
    editTabIssues.filter(issue => {
      const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      if (!rec) return true
      return Object.entries(editTabColFilters).every(([col, val]) => !val || (rec[col] ?? '').trim() === val)
    })
  , [editTabIssues, editTabRecords, editTabColFilters])

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
      setSelectedProjectId(''); setSelectedIssueTypeId(''); setIssueTypes([])
      setMembers([]); setMembersError(''); setMembersLoading(false)
      setPendingCommentRequestId(''); setCommentProgress(null)
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
            result?: { ok: boolean; results?: StageOpResult[]; stopped?: boolean; stoppedReason?: string }
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
              results.push({ rowIndex: -1, issueKey: '⚠️ 已中斷', ok: false, error: `Gemini API 用量已達上限。原因：${d.result.stoppedReason}` })
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
    // 若目前 mode 不在帳號的允許範圍，自動切換
    setMode(prev => {
      if (accountHasRole(acc, prev)) return prev
      return accountHasRole(acc, 'qa') ? 'qa' : 'pm'
    })
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
      }
    } catch { setSheetError('網路錯誤') }
    finally { setSheetLoading(false) }
  }

  const [refreshingSheet, setRefreshingSheet] = useState(false)
  // ── Step 5: 重新讀取 Sheet，過濾已評論完的單號 ──
  const handleRefreshSheetForComment = async () => {
    if (!sheetUrl.trim()) return
    setRefreshingSheet(true)
    const endpoint = sheetSource === 'lark' ? '/api/lark/sheets/records' : '/api/google/sheets/records'
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: sheetUrl.trim() }),
      })
      const data = await resp.json()
      if (data.ok) {
        const freshRecords: SheetRecord[] = data.records
        setSheetHeaders(data.headers)
        setSheetRecords(freshRecords)
        // 重建 trackedIssues：只保留仍需評論的列（有 key 且尚未評論）
        setTrackedIssues(prev => prev.map(t => {
          const freshRow = freshRecords.find(r => Number(r._rowIndex) === t.rowIndex)
          if (!freshRow) return t
          const freshStage = getField(freshRow, STAGE_COL).trim()
          // 若 Sheet 上 處理階段 已是「添加評論」或更後段，更新本地 stage 讓它從 toComment 移出
          if (freshStage === '添加評論' || freshStage === '已轉換') {
            return { ...t, stage: freshStage }
          }
          return t
        }))
      }
    } catch { /* silent */ }
    finally { setRefreshingSheet(false) }
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
    setSummaryProgress({ done: 0, total: targets.length })
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
        const data = await resp.json() as { ok: boolean; results?: { rowIndex: number; summary: string }[] }
        if (data.ok && data.results) {
          data.results.forEach(r => { newSummaries[r.rowIndex] = r.summary })
          setGeneratedSummaries({ ...newSummaries })
        }
      } catch { /* continue on error */ }
      setSummaryProgress({ done: Math.min(i + batchSize, targets.length), total: targets.length })
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

  const userOptionsForField = (field: NormalizedJiraField) =>
    field.options?.length
      ? field.options
      : members.map(m => ({ id: m.accountId, label: m.displayName }))

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

  const applyLarkPrefill = () => {
    const newVals: Record<number, Record<string, string>> = {}
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
          if (val) { rowVals[field.key] = val; break }
        }
      }
      if (Object.keys(rowVals).length > 0) newVals[rowIdx] = rowVals
    }
    setCellValues(prev => {
      const merged: Record<number, Record<string, string>> = { ...prev }
      for (const [ri, vals] of Object.entries(newVals)) {
        merged[Number(ri)] = { ...(merged[Number(ri)] ?? {}), ...vals }
      }
      return merged
    })
    setLarkPrefillApplied(true)
  }

  const validateDynamicFields = (): boolean => {
    const errors: Record<number, Record<string, string>> = {}
    for (const record of planCreate) {
      const rowIdx = Number(record._rowIndex)
      const rowVals = cellValues[rowIdx] ?? {}
      for (const field of requiredJiraFields) {
        const val = rowVals[field.key]?.trim()
        if (!val) {
          if (!errors[rowIdx]) errors[rowIdx] = {}
          errors[rowIdx][field.key] = `${field.name} 為必填`
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
      case 'select': return field.options ? { id: rawVal } : { name: rawVal }
      case 'multiselect': return rawVal.split(',').map(id => id.trim()).filter(Boolean).map(id => field.options ? { id } : { name: id })
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
    setSubmitting(true); setCreateResults([])

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
        const summaryVal = (generatedSummaries[rowIdx] || getField(r, SHEET_FIELD.summary)).replace(/[\r\n]+/g, ' ').trim()
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
        const summaryFromCell = rowCells['summary']?.trim()
        const finalSummary = (generatedSummaries[rowIdx] || summaryFromCell || getField(r, SHEET_FIELD.summary)).replace(/[\r\n]+/g, ' ').trim()
        return {
          summary: finalSummary,
          description: rowCells['description'] || getField(r, SHEET_FIELD.description),
          assigneeAccountId: undefined,
          rdOwnerAccountId: undefined,
          reporterAccountId: undefined as string | undefined,
          verifierAccountIds: [] as string[],
          rowIndex: rowIdx,
          dynamicFields,
        }
      }

      // Legacy mode: use hardcoded Lark field mappings
      const verifiers = getField(r, SHEET_FIELD.verifierAccountIds)
      const larkVerifierIds = verifiers
        ? verifiers.split(',').map(s => s.trim()).filter(s => knownIds.has(s))
        : []
      return {
        summary: (generatedSummaries[rowIdx] || getField(r, SHEET_FIELD.summary)).replace(/[\r\n]+/g, ' ').trim(),
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
      }
    })

    try {
      console.log('[batch-create] sending rows:', rows.length, 'rows[0]:', rows[0])
      const project = projects.find(p => p.id === selectedProjectId)
      const resp = await fetch('/api/jira/batch-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ rows, sheetUrl, projectId: selectedProjectId, projectKey: project?.key, issueTypeId: selectedIssueTypeId }),
      })
      const data = await resp.json()
      console.log('[batch-create] response:', data)
      if (!resp.ok || (!data.results && data.message)) {
        setCreateResults([{ rowIndex: 0, error: data.message ?? `HTTP ${resp.status}` }])
        setStep(4)
        setSubmitting(false)
        return
      }
      const results: IssueCreateResult[] = data.results ?? []
      const succeeded = results.filter(r => r.issueKey)

      // 寫回多欄位
      let writebackResultMap: Record<number, boolean> = {}
      let writebackSkipped = false
      let writebackError = ''
      if (succeeded.length > 0) {
        try {
          const wbResp = await fetch('/api/sheets/writeback-multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sheetUrl, source: sheetSource,
              writes: succeeded.map(r => ({
                rowIndex: r.rowIndex,
                columns: {
                  'Jira issue key': r.issueKey!,
                  'Jira URL': `${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${r.issueKey!}`,
                  '處理階段': '已開單',
                  '處理時間': nowString(),
                },
              })),
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

      // 合併 trackedIssues
      const newIssues: TrackedIssue[] = succeeded.map(r => ({
        rowIndex: r.rowIndex, issueKey: r.issueKey!, stage: '已開單',
      }))
      setTrackedIssues([...preExisting, ...newIssues])
      setStep(4)
    } catch {
      setCreateResults([{ rowIndex: 0, error: '網路錯誤' }])
      setStep(4)
    } finally { setSubmitting(false) }
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
    setPrefetchLoading(true)
    setPrefetchError('')

    const items: PreviewItem[] = toComment.map(issue => {
      const record = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      const text = record
        ? (useAiComment && isAdmin) ? buildAiCommentRawText(record, commentColumn) : getField(record, commentColumn)
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

  type CommentPayload = {
    issueKey: string; rowIndex: number; rawComment: string; useAi: boolean; promptId?: string
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
          modelSpec: useAiComment ? commentModel : undefined,
          specContext: useAiComment && specContext.trim() ? specContext.trim() : undefined,
          knowledgeDocIds: useAiComment && selectedKbDocIds.length > 0 ? selectedKbDocIds : undefined,
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

      const data = await new Promise<{ ok: boolean; results?: StageOpResult[]; stopped?: boolean; stoppedReason?: string }>((resolve, reject) => {
        const es = new EventSource(`/api/jira/batch-comment/stream?requestId=${encodeURIComponent(submitData.requestId!)}&email=${encodeURIComponent(currentAccount.email)}`)
        let done = false
        const sseTimeout = setTimeout(() => { if (!done) { es.close(); reject(new Error('SSE 逾時')) } }, 30 * 60 * 1000)
        es.addEventListener('progress', (e: MessageEvent) => { setCommentProgress(JSON.parse(e.data)) })
        es.addEventListener('result', (e: MessageEvent) => { done = true; clearTimeout(sseTimeout); es.close(); resolve(JSON.parse(e.data)) })
        es.onerror = () => { if (done) return }
      })

      const results = data.results ?? []
      if (data.stopped && data.stoppedReason) {
        results.push({ rowIndex: -1, issueKey: '⚠️ 已中斷', ok: false, error: `Gemini API 用量已達上限，剩餘筆數未處理。原因：${data.stoppedReason}` })
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
        await fetch('/api/sheets/writeback-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheetUrl, source: sheetSource,
            writes: successRows.map(r => ({ rowIndex: r.rowIndex, columns: { '處理階段': '添加評論', '處理時間': nowString() } })),
          }),
        })
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
        useAi: useAiComment && isAdmin,
        promptId: (useAiComment && isAdmin) ? selectedPromptId : undefined,
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
    setTransitionSubmitting(true)

    const issues = toTransition.map(t => ({
      issueKey: t.issueKey,
      rowIndex: t.rowIndex,
      transitionId: selectedTransitionId,
    }))

    try {
      const resp = await fetch('/api/jira/batch-transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ issues }),
      })
      const data = await resp.json() as { ok: boolean; results?: StageOpResult[] }
      const results = data.results ?? []
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
              columns: { '處理階段': '已完成', '處理時間': nowString() },
            })),
          }),
        })
        setTrackedIssues(prev => prev.map(t =>
          successRows.some(r => r.rowIndex === t.rowIndex) ? { ...t, stage: '已完成' } : t
        ))
      }
      setStep(6)
    } catch { setTransitionResults([{ rowIndex: 0, issueKey: '', ok: false, error: '網路錯誤' }]); setStep(6) }
    finally { setTransitionSubmitting(false) }
  }

  /** QA / PM 使用不同 Sheet 模板，切換模式或「重新開始」時需清空所有流程狀態（保留已登入帳號）。 */
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

  // ── PM Mode handlers ──
  const handlePmFetchBitable = async () => {
    if (!pmBitableUrl.trim()) return
    setPmLoading(true); setPmError(''); setPmRecords([])
    try {
      const resp = await fetch('/api/jira/pm-read-bitable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bitableUrl: pmBitableUrl.trim() }),
      })
      const data = await resp.json() as { ok: boolean; records?: PMRecord[]; message?: string }
      if (!data.ok) { setPmError(data.message ?? '讀取失敗'); return }
      setPmRecords(data.records ?? [])
      setPmSelectedIds(new Set((data.records ?? []).map(r => r.recordId)))
      setPmStep(2)
    } catch { setPmError('網路錯誤') }
    finally { setPmLoading(false) }
  }

  const handlePmCreate = async () => {
    if (!currentAccount || pmSelectedIds.size === 0) return
    setPmSubmitting(true); setPmResults([]); setPmError('')
    try {
      const resp = await fetch('/api/jira/pm-batch-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-jira-email': currentAccount.email },
        body: JSON.stringify({
          bitableUrl: pmBitableUrl.trim(),
          parentIssueKey: pmParentKey.trim() || undefined,
          recordIds: Array.from(pmSelectedIds),
        }),
      })
      const data = await resp.json() as { ok: boolean; results?: PMResult[]; message?: string }
      if (!data.ok) { setPmError(data.message ?? '開單失敗'); return }
      setPmResults(data.results ?? [])
      setPmStep(3)
    } catch { setPmError('網路錯誤') }
    finally { setPmSubmitting(false) }
  }

  const handlePmReset = () => {
    setPmStep(1); setPmBitableUrl(''); setPmParentKey(''); setPmRecords([])
    setPmSelectedIds(new Set()); setPmResults([]); setPmError('')
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
        issues.push({ rowIndex: Number(rec._rowIndex), issueKey: foundKey, stage: '' })
      }
    }
    return issues
  }

  const handleCommentTabLoad = async () => {
    if (!commentTabUrl.trim()) return
    setCommentTabLoading(true); setCommentTabError(''); setCommentTabStep(1)
    try {
      const resp = await fetch('/api/lark/sheets/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: commentTabUrl.trim(), includeCreated: true }),
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
      setCommentTabSelectedKeys(new Set(issues.map(i => i.issueKey)))
      setCommentTabStep(2)
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

  const handleEditTabLoad = async () => {
    if (!editTabUrl.trim()) return
    setEditTabLoading(true); setEditTabError(''); setEditTabJiraError(''); setEditTabIssues([]); setEditTabResults([]); setEditTabJiraData({})
    try {
      const resp = await fetch('/api/lark/sheets/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: editTabUrl.trim(), includeCreated: true }),
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
      setEditTabSelectedKeys(new Set(issues.map(i => i.issueKey)))
      setEditFieldMappings([{ jiraField: 'summary', sheetColumn: '' }])
      setEditTabStep(2)
      // Async fetch current Jira data for preview
      void fetchEditTabJiraData(issues.map(i => i.issueKey))
    } catch { setEditTabError('網路錯誤') }
    finally { setEditTabLoading(false) }
  }

  const handleEditTabSubmit = async () => {
    const activeMappings = editFieldMappings.filter(m => m.sheetColumn)
    if (!activeMappings.length || !currentAccount) return
    setEditTabSubmitting(true); setEditTabError('')
    try {
      const items = editTabIssues.filter(issue => editTabSelectedKeys.has(issue.issueKey)).map(issue => {
        const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
        const fields: Record<string, unknown> = {}
        for (const { jiraField, sheetColumn } of activeMappings) {
          const val = (rec?.[sheetColumn] ?? '').trim()
          if (!val) continue
          if (jiraField === 'summary') {
            fields.summary = val
          } else if (jiraField === 'description') {
            fields.description = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: val }] }] }
          } else {
            fields[jiraField] = val
          }
        }
        return { issueKey: issue.issueKey, fields }
      }).filter(item => Object.keys(item.fields).length > 0)

      if (!items.length) { setEditTabError('所有 Issue 均無有效更新欄位，請檢查欄位對應設定'); return }

      const resp = await fetch('/api/jira/batch-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ items }),
      })
      const result = await resp.json() as { ok: boolean; results?: { issueKey: string; ok: boolean; error?: string }[]; message?: string }
      if (!result.ok) { setEditTabError(result.message ?? '批量修改失敗') }
      else { setEditTabResults(result.results ?? []); setEditTabStep(4) }
    } catch { setEditTabError('網路錯誤') }
    finally { setEditTabSubmitting(false) }
  }

  // ── Update Mode handlers ──
  const handleUpdateFetchBitable = async () => {
    if (!updateBitableUrl.trim()) return
    setUpdateLoading(true); setUpdateError(''); setUpdateRecords([])
    try {
      const resp = await fetch('/api/jira/update-read-bitable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bitableUrl: updateBitableUrl.trim() }),
      })
      const data = await resp.json() as { ok: boolean; records?: UpdateRecord[]; message?: string; stats?: { totalRows: number; found: number; skippedEmpty: number; skippedInvalid: number }; jiraBaseUrl?: string }
      if (!data.ok) { setUpdateError(data.message ?? '讀取失敗'); return }
      const records = data.records ?? []
      if (records.length === 0) { setUpdateError('找不到 Jira Issue Key，請確認 Bitable 有 URL 欄且含有單號'); return }
      setUpdateRecords(records)
      setUpdateStats(data.stats ?? null)
      setUpdatePersonFilter('')
      setUpdateSelectedKeys(new Set(records.map(r => r.issueKey)))
      setUpdateSummaries({})
      if (data.jiraBaseUrl) setUpdateJiraBaseUrl(data.jiraBaseUrl)

      // Background-fetch Jira summaries
      if (records.length > 0 && currentAccount) {
        fetch('/api/jira/batch-fetch-summaries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-jira-email': currentAccount.email },
          body: JSON.stringify({ issueKeys: records.map(r => r.issueKey) }),
        }).then(r => r.json()).then((d: { ok: boolean; summaries?: { issueKey: string; summary: string }[] }) => {
          const map: Record<string, string> = {}
          if (d.ok && d.summaries) {
            d.summaries.forEach(s => { map[s.issueKey] = s.summary })
          } else {
            // Mark all as failed so UI shows '—' instead of '載入中...'
            records.forEach(r => { map[r.issueKey] = r.title || '' })
          }
          setUpdateSummaries(map)
        }).catch(() => {
          // On error, fall back to title from Lark cell
          const map: Record<string, string> = {}
          records.forEach(r => { map[r.issueKey] = r.title || '' })
          setUpdateSummaries(map)
        })
      }

      // Fetch transitions — try currentAccount first, then all stored accounts
      if (records.length > 0) {
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
      }

      setUpdateStep(2)
    } catch (e) {
      setUpdateError(String(e))
    } finally {
      setUpdateLoading(false)
    }
  }

  const handleUpdateExecute = async () => {
    if (updateSubmitting) return
    setUpdateSubmitting(true); setUpdateResults([])
    const filtered = (updatePersonFilter === ''
      ? updateRecords
      : updatePersonFilter === '__none__'
        ? updateRecords.filter(r => !r.fillPerson)
        : updateRecords.filter(r => r.fillPerson === updatePersonFilter)
    ).filter(r => updateSelectedKeys.has(r.issueKey))
    const execEmail = currentAccount?.email ?? ''
    const items = filtered.map(r => ({
      issueKey: r.issueKey,
      email: execEmail,
      transitionId: updateTransitionId || undefined,
    }))
    try {
      const resp = await fetch('/api/jira/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const data = await resp.json() as { ok: boolean; results?: { issueKey: string; ok: boolean; error?: string }[] }
      setUpdateResults(data.results ?? [])
      setUpdateStep(3)
    } catch (e) {
      setUpdateError(String(e))
    } finally {
      setUpdateSubmitting(false)
    }
  }

  const handleUpdateReset = () => {
    setUpdateStep(1); setUpdateBitableUrl(''); setUpdateRecords([]); setUpdateError('')
    setUpdateTransitions([]); setUpdateTransitionId(''); setUpdateResults([]); setUpdatePersonFilter('')
    setUpdateSummaries({}); setUpdateSelectedKeys(new Set())
  }

  const StepDot = ({ s }: { s: Step }) => (
    <span className={`step-dot${step === s ? ' active' : step > s ? ' done' : ''}`}>
      {step > s ? '✓' : s}
    </span>
  )

  return (
    <div className="page-layout">
      {/* Mode toggle */}
      <div className="mode-toggle">
        {(['qa', 'pm'] as const).map(m => {
          const allowed = allowedModes ? allowedModes.includes(m) : accountHasRole(currentAccount, m)
          const label = m === 'qa' ? 'QA 模式' : 'PM 模式'
          return (
            <button
              key={m}
              type="button"
              disabled={!allowed}
              title={!allowed ? `目前帳號沒有此模式權限` : undefined}
              onClick={() => {
                if (m === mode || !allowed) return
                setMode(m)
                clearWorkflowState()
              }}
              className={`mode-toggle-btn${mode === m ? ' active' : ''}`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* QA sub-tabs */}
      {mode === 'qa' && (
        <div style={{ display: 'flex', gap: 8, padding: '6px 0 2px', flexWrap: 'wrap' }}>
          {(['create', 'comment', 'update', 'edit'] as const).map(sub => (
            <button
              key={sub}
              type="button"
              onClick={() => setQaSubMode(sub)}
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
      )}

      {/* Top bar */}
      <div className="page-topbar">
        <div className="step-indicator">
          {mode === 'qa' && qaSubMode === 'create'
            ? ([1, 2, 3, 4] as Step[]).map(s => <StepDot key={s} s={s} />)
            : mode === 'qa' && qaSubMode === 'comment'
              ? ([1, 2, 3] as const).map(s => (
                  <span key={s} className={`step-dot${commentTabStep === s ? ' active' : commentTabStep > s ? ' done' : ''}`}>
                    {commentTabStep > s ? '✓' : s}
                  </span>
                ))
            : mode === 'qa' && qaSubMode === 'edit'
              ? ([1, 2, 3, 4] as const).map(s => (
                  <span key={s} className={`step-dot${editTabStep === s ? ' active' : editTabStep > s ? ' done' : ''}`}>
                    {editTabStep > s ? '✓' : s}
                  </span>
                ))
            : ([1, 2, 3] as const).map(s => (
                <span key={s} className={`step-dot${
                  (mode === 'pm' ? pmStep : updateStep) === s ? ' active' :
                  (mode === 'pm' ? pmStep : updateStep) > s ? ' done' : ''}`}>
                  {(mode === 'pm' ? pmStep : updateStep) > s ? '✓' : s}
                </span>
              ))
          }
          <span className="step-label">
            {mode === 'qa' && qaSubMode === 'create' ? (STEP_LABELS[step] ?? '')
              : mode === 'qa' && qaSubMode === 'comment'
                ? ({ 1: '讀取表格', 2: '選擇單子', 3: '設定評論' } as Record<number, string>)[commentTabStep]
              : mode === 'qa' && qaSubMode === 'edit'
                ? ({ 1: '讀取表格', 2: '選擇單子', 3: '設定欄位', 4: '修改結果' } as Record<number, string>)[editTabStep]
              : mode === 'pm' ? ({ 1: '讀取表格', 2: '確認清單', 3: '開單結果' } as Record<number, string>)[pmStep]
              : ({ 1: '讀取 Bitable', 2: '設定帳號 & 動作', 3: '執行結果' } as Record<number, string>)[updateStep]}
          </span>
        </div>
        <div style={{ display: 'none' }}>
          <button type="button"
            className={`settings-btn${currentAccount ? ' has-creds' : ''}`}
            onClick={() => setShowAccountModal(true)}>
            {isGame ? <DungeonIcon name="account" tone="cyan" size="xs" plain /> : '👤'} {currentAccount ? currentAccount.label : '選擇帳號'}
          </button>
        </div>
      </div>

      {/* ── PM Mode ── */}
      {mode === 'pm' && (
        <>
          {/* PM Step 1: 貼 Bitable URL */}
          {pmStep === 1 && (
            <div className="section-card">
              <h2 className="section-title">Step 1 — 讀取 Lark 表格</h2>
              {!currentAccount && <div className="alert-warn" style={{ marginBottom: 12 }}>請先點右上角「選擇帳號」</div>}
              <div className="form-stack">
                <label className="field">
                  <span>Lark Bitable 網址<em className="req"> *</em></span>
                  <input value={pmBitableUrl} onChange={e => setPmBitableUrl(e.target.value)}
                    placeholder="https://casinoplus.sg.larksuite.com/base/xxx?table=tblxxx" />
                  <span className="field-hint">貼上含 ?table=xxx 的完整網址，系統會自動讀取待開單列（JIRA索引鍵為空的列）</span>
                </label>
                <label className="field">
                  <span>主單號（可選）</span>
                  <input value={pmParentKey} onChange={e => setPmParentKey(e.target.value)}
                    placeholder="例如 DSFT-100" />
                  <span className="field-hint">
                    通常可留空。填入時機：<br />
                    • <strong>不填</strong>：若 Bitable 的「選擇主單並關聯」欄位已填好標題，系統會自動在同批次 Issue 之間建立關聯，不需要這裡輸入任何東西。<br />
                    • <strong>填入已有單號（如 DSFT-100）</strong>：將本次批次中，沒有在「選擇主單並關聯」填值的 Issue，全部連結到這張已存在的 Jira 單下。
                  </span>
                </label>
                {pmError && <div className="alert-error">{pmError}</div>}
              </div>
              <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 16 }}
                disabled={!currentAccount || !pmBitableUrl.trim() || pmLoading} onClick={handlePmFetchBitable}>
                {pmLoading ? '讀取中...' : '讀取表格'}
              </button>
            </div>
          )}

          {/* PM Step 2: 確認清單 */}
          {pmStep === 2 && (
            <div className="section-card">
              <h2 className="section-title">Step 2 — 確認開單清單</h2>

              {/* Summary bar */}
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16, padding: '10px 14px', background: '#162032', borderRadius: 8, border: '1px solid #2d3f55' }}>
                <span style={{ fontSize: 13, color: '#94a3b8' }}>
                  共 <strong style={{ color: '#e2e8f0' }}>{pmRecords.length}</strong> 筆，已選 <strong style={{ color: '#a5b4fc' }}>{pmSelectedIds.size}</strong> 筆
                </span>
                {pmRecords.some(r => r.isParent) && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(124,58,237,0.15)', color: '#c4b5fd', fontWeight: 600, borderRadius: 20, padding: '3px 10px', fontSize: 12 }}>
                    🔗 偵測到主單，填有「主單標題」的子單將自動關聯
                  </span>
                )}
                {!pmRecords.some(r => r.isParent) && pmParentKey && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(124,58,237,0.15)', color: '#c4b5fd', fontWeight: 600, borderRadius: 20, padding: '3px 10px', fontSize: 12 }}>
                    🔗 手動主單：{pmParentKey}
                  </span>
                )}
              </div>

              <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #2d3f55' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#162032', borderBottom: '1px solid #2d3f55' }}>
                      <th style={{ width: 40, padding: '10px 12px', textAlign: 'center' }}>
                        <input type="checkbox"
                          checked={pmSelectedIds.size === pmRecords.length && pmRecords.length > 0}
                          onChange={e => setPmSelectedIds(e.target.checked ? new Set(pmRecords.map(r => r.recordId)) : new Set())} />
                      </th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8' }}>標題</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>專案</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>類型</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8' }}>受託人</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>難易度</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>所屬主單</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pmRecords.map((r, i) => (
                      <tr key={r.recordId} style={{
                        opacity: pmSelectedIds.has(r.recordId) ? 1 : 0.45,
                        borderBottom: i < pmRecords.length - 1 ? '1px solid #1e293b' : 'none',
                        background: r.isParent ? 'rgba(124,58,237,0.08)' : 'transparent',
                        borderLeft: r.isParent ? '3px solid #7c3aed' : '3px solid transparent',
                      }}>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                          <input type="checkbox" checked={pmSelectedIds.has(r.recordId)}
                            onChange={e => {
                              const next = new Set(pmSelectedIds)
                              e.target.checked ? next.add(r.recordId) : next.delete(r.recordId)
                              setPmSelectedIds(next)
                            }} />
                        </td>
                        <td style={{ padding: '10px 12px', maxWidth: 360 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {r.isParent && (
                              <span style={{ background: '#7c3aed', color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}>主單</span>
                            )}
                            <span style={{ color: '#e2e8f0', lineHeight: 1.4 }}>{r.summary}</span>
                          </div>
                        </td>
                        <td style={{ padding: '10px 12px', color: '#64748b', whiteSpace: 'nowrap' }}>{r.jiraProjectName}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ background: 'rgba(99,102,241,0.1)', color: '#a5b4fc', borderRadius: 4, padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' }}>{r.issueTypeName}</span>
                        </td>
                        <td style={{ padding: '10px 12px', color: '#64748b', fontSize: 12 }}>{r.assigneeEmail || '—'}</td>
                        <td style={{ padding: '10px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {r.difficulty ? (
                            <span style={{ background: 'rgba(16,185,129,0.1)', color: '#34d399', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>{r.difficulty}</span>
                          ) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: r.parentTitle ? '#7c3aed' : '#d1d5db', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.parentTitle || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {pmError && <div className="alert-error" style={{ marginTop: 12 }}>{pmError}</div>}

              <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
                <button type="button" className="btn-ghost btn-ghost--step" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => { setPmStep(1); setPmError('') }}>← 返回</button>
                <button type="button" className="submit-btn submit-btn--step" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  disabled={pmSelectedIds.size === 0 || pmSubmitting} onClick={handlePmCreate}>
                  {pmSubmitting ? `開單中...` : `建立 ${pmSelectedIds.size} 筆 Issues`}
                </button>
              </div>
            </div>
          )}

          {/* PM Step 3: 結果 */}
          {pmStep === 3 && (
            <div className="section-card">
              <h2 className="section-title">Step 3 — 開單結果</h2>

              {/* Summary cards */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                <div style={{ flex: 1, padding: '16px 20px', background: 'rgba(16,185,129,0.08)', borderRadius: 10, border: '1px solid rgba(16,185,129,0.25)', textAlign: 'center' }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: '#34d399', lineHeight: 1 }}>{pmResults.filter(r => r.issueKey).length}</div>
                  <div style={{ fontSize: 13, color: '#6ee7b7', marginTop: 4, fontWeight: 600 }}>✓ 成功建立</div>
                </div>
                <div style={{ flex: 1, padding: '16px 20px', background: pmResults.some(r => r.error) ? 'rgba(239,68,68,0.08)' : '#162032', borderRadius: 10, border: `1px solid ${pmResults.some(r => r.error) ? 'rgba(239,68,68,0.3)' : '#2d3f55'}`, textAlign: 'center' }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: pmResults.some(r => r.error) ? '#f87171' : '#475569', lineHeight: 1 }}>{pmResults.filter(r => r.error).length}</div>
                  <div style={{ fontSize: 13, color: pmResults.some(r => r.error) ? '#fca5a5' : '#475569', marginTop: 4, fontWeight: 600 }}>✗ 失敗</div>
                </div>
              </div>

              {/* Result rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pmResults.map(r => (
                  <div key={r.recordId} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                    borderRadius: 8, border: `1px solid ${r.issueKey ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
                    background: r.issueKey ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
                  }}>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>{r.issueKey ? (isGame ? <DungeonIcon name="status-ok" tone="green" plain /> : '✅') : (isGame ? <DungeonIcon name="status-error" tone="red" plain /> : '❌')}</span>
                    {r.issueKey && (
                      <span style={{ fontWeight: 700, color: '#a5b4fc', fontSize: 13, whiteSpace: 'nowrap' }}>{r.issueKey}</span>
                    )}
                    <span style={{ fontSize: 13, color: '#cbd5e1', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.summary ?? '—'}
                    </span>
                    {r.error && (
                      <span style={{ fontSize: 11, color: '#fca5a5', flexShrink: 0, maxWidth: 260, textAlign: 'right' }}>{r.error}</span>
                    )}
                  </div>
                ))}
              </div>

              <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 20, background: 'linear-gradient(135deg, #059669, #047857)' }} onClick={handlePmReset}>
                重新開始
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Update Mode (inside QA) ── */}
      {mode === 'qa' && qaSubMode === 'update' && (
        <>
          {/* Step 1: 讀取 Bitable */}
          {updateStep === 1 && (
            <div className="section-card">
              <h2 className="section-title">Step 1 — 讀取 Bitable</h2>
              <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 12px' }}>
                貼入 Lark Bitable URL，系統自動偵測 URL 欄（含 Jira 單號）與填寫人欄
              </p>
              {updateError && <div className="alert-error" style={{ marginBottom: 10 }}>{updateError}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={updateBitableUrl}
                  onChange={e => setUpdateBitableUrl(e.target.value)}
                  placeholder="Lark Sheet URL（/wiki/ 或 /sheets/）或 Bitable URL"
                  style={{ flex: 1, padding: '7px 12px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                  onKeyDown={e => e.key === 'Enter' && handleUpdateFetchBitable()}
                />
                <button
                  type="button"
                  className="submit-btn submit-btn--step"
                  disabled={updateLoading || !updateBitableUrl.trim()}
                  onClick={handleUpdateFetchBitable}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {updateLoading ? '讀取中…' : '📥 讀取'}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: 設定帳號 & 動作 */}
          {updateStep === 2 && (() => {
            const uniquePersons = [...new Set(updateRecords.map(r => r.fillPerson).filter(Boolean))]
            const noneCount = updateRecords.filter(r => !r.fillPerson).length
            const filteredRecords = updatePersonFilter === ''
              ? updateRecords
              : updatePersonFilter === '__none__'
                ? updateRecords.filter(r => !r.fillPerson)
                : updateRecords.filter(r => r.fillPerson === updatePersonFilter)
            return (
            <div className="section-card">
              <h2 className="section-title">Step 2 — 選擇帳號 & 動作</h2>
              <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 6px' }}>
                共 <b style={{ color: '#e2e8f0' }}>{updateRecords.length}</b> 張單
                {updatePersonFilter ? <>，篩選顯示 <b style={{ color: '#60a5fa' }}>{filteredRecords.length}</b> 張</> : ''}
              </p>
              {updateStats && (
                <p style={{ fontSize: 11, color: '#475569', margin: '0 0 12px' }}>
                  讀取 {updateStats.totalRows} 列 → 找到 {updateStats.found} 張
                  {updateStats.skippedEmpty > 0 ? `，跳過 ${updateStats.skippedEmpty} 空列` : ''}
                  {updateStats.skippedInvalid > 0 ? `，${updateStats.skippedInvalid} 列格式不符` : ''}
                </p>
              )}

              {/* 填寫人篩選 */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa', marginBottom: 8 }}>填寫人篩選</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {[
                    { key: '', label: `全部 (${updateRecords.length})` },
                    ...uniquePersons.map(p => ({ key: p, label: `${p} (${updateRecords.filter(r => r.fillPerson === p).length})` })),
                    ...(noneCount > 0 ? [{ key: '__none__', label: `無 (${noneCount})` }] : []),
                  ].map(opt => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setUpdatePersonFilter(opt.key)}
                      style={{
                        fontSize: 12, padding: '4px 10px', borderRadius: 16, cursor: 'pointer',
                        border: `1px solid ${updatePersonFilter === opt.key ? '#60a5fa' : '#334155'}`,
                        background: updatePersonFilter === opt.key ? '#1e3a5f' : '#162032',
                        color: updatePersonFilter === opt.key ? '#93c5fd' : '#94a3b8',
                        fontWeight: updatePersonFilter === opt.key ? 700 : 400,
                      }}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>

              {/* 切換狀態 */}
              <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>切換狀態：</span>
                {updateTransitions.length > 0 ? (
                  <select
                    value={updateTransitionId}
                    onChange={e => setUpdateTransitionId(e.target.value)}
                    style={{ fontSize: 12, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '4px 8px' }}
                  >
                    <option value="">（不切換）</option>
                    {updateTransitions.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.toName ?? t.name}{t.toName && t.toName !== t.name ? `（${t.name}）` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span style={{ fontSize: 12, color: '#64748b' }}>
                    {currentAccount ? '讀取轉換選項失敗，可跳過' : '請先選擇帳號（右上角）'}
                  </span>
                )}
              </div>

              {/* Preview */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa', marginBottom: 6 }}>
                  預覽（共 {filteredRecords.length} 張）
                </div>
                {/* Select-all row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: '#94a3b8' }}>
                    <input
                      type="checkbox"
                      checked={filteredRecords.length > 0 && filteredRecords.every(r => updateSelectedKeys.has(r.issueKey))}
                      onChange={e => {
                        setUpdateSelectedKeys(prev => {
                          const next = new Set(prev)
                          filteredRecords.forEach(r => e.target.checked ? next.add(r.issueKey) : next.delete(r.issueKey))
                          return next
                        })
                      }}
                    />
                    全選 / 取消全選
                  </label>
                  <span style={{ fontSize: 11, color: '#60a5fa' }}>
                    已選 {filteredRecords.filter(r => updateSelectedKeys.has(r.issueKey)).length} / {filteredRecords.length} 張
                  </span>
                </div>
                <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden' }}>
                  {/* Table header */}
                  <div style={{ display: 'grid', gridTemplateColumns: '32px 110px 80px 1fr', gap: 0, background: '#0f2744', borderBottom: '1px solid #1e3a5f' }}>
                    <div style={{ padding: '5px 8px', borderRight: '1px solid #1e3a5f' }} />
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', borderRight: '1px solid #1e3a5f' }}>單號</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', borderRight: '1px solid #1e3a5f' }}>填寫人</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px' }}>摘要</div>
                  </div>
                  {/* Rows */}
                  <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                    {filteredRecords.slice(0, 200).map((r, idx) => {
                      const isSelected = updateSelectedKeys.has(r.issueKey)
                      const summary = updateSummaries[r.issueKey] || r.title || ''
                      return (
                        <div key={r.issueKey} style={{ display: 'grid', gridTemplateColumns: '32px 110px 80px 1fr', background: isSelected ? (idx % 2 === 0 ? '#0a1628' : '#0d1e38') : '#070f1e', borderBottom: '1px solid #1e293b', opacity: isSelected ? 1 : 0.45 }}>
                          <div style={{ padding: '5px 8px', borderRight: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <input type="checkbox" checked={isSelected}
                              onChange={e => {
                                setUpdateSelectedKeys(prev => {
                                  const next = new Set(prev)
                                  e.target.checked ? next.add(r.issueKey) : next.delete(r.issueKey)
                                  return next
                                })
                              }}
                            />
                          </div>
                          <div style={{ padding: '5px 10px', borderRight: '1px solid #1e293b', display: 'flex', alignItems: 'center' }}>
                            {updateJiraBaseUrl ? (
                              <a href={`${updateJiraBaseUrl}/browse/${r.issueKey}`} target="_blank" rel="noreferrer"
                                style={{ color: '#93c5fd', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}
                                onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                              >{r.issueKey}</a>
                            ) : (
                              <code style={{ color: '#93c5fd', fontWeight: 700, fontSize: 12 }}>{r.issueKey}</code>
                            )}
                          </div>
                          <div style={{ padding: '5px 10px', borderRight: '1px solid #1e293b', fontSize: 11, color: r.fillPerson ? '#94a3b8' : '#475569', display: 'flex', alignItems: 'center' }}>
                            {r.fillPerson || '無'}
                          </div>
                          <div style={{ padding: '5px 10px', fontSize: 11, color: summary ? '#cbd5e1' : '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.issueKey in updateSummaries
                              ? (summary || <span style={{ color: '#475569' }}>—</span>)
                              : <span style={{ color: '#374151' }}>載入中...</span>}
                          </div>
                        </div>
                      )
                    })}
                    {filteredRecords.length > 200 && (
                      <div style={{ fontSize: 11, color: '#64748b', textAlign: 'center', padding: '6px 0' }}>...還有 {filteredRecords.length - 200} 張</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="stage-nav">
                <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setUpdateStep(1)}>上一步</button>
                <button
                  type="button"
                  className={`submit-btn submit-btn--step${updateSubmitting ? ' loading' : ''}`}
                  disabled={updateSubmitting || !currentAccount || filteredRecords.filter(r => updateSelectedKeys.has(r.issueKey)).length === 0}
                  onClick={handleUpdateExecute}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {updateSubmitting ? '執行中…' : `▶ 執行（${filteredRecords.filter(r => updateSelectedKeys.has(r.issueKey)).length} 張）`}
                </button>
              </div>
            </div>
            )
          })()}

          {/* Step 3: 結果 */}
          {updateStep === 3 && (
            <div className="section-card">
              <h2 className="section-title">執行結果</h2>
              <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: '#4ade80', fontWeight: 700 }}>
                  ✅ 成功 {updateResults.filter(r => r.ok).length} 張
                </span>
                {updateResults.some(r => !r.ok) && (
                  <span style={{ fontSize: 13, color: '#f87171', fontWeight: 700 }}>
                    ❌ 失敗 {updateResults.filter(r => !r.ok).length} 張
                  </span>
                )}
              </div>
              <div style={{ maxHeight: 400, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {updateResults.map(r => (
                  <div key={r.issueKey} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px', background: r.ok ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)', border: `1px solid ${r.ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`, borderRadius: 6, fontSize: 12 }}>
                    <span>{r.ok ? '✅' : '❌'}</span>
                    <code style={{ color: '#93c5fd', fontWeight: 700 }}>{r.issueKey}</code>
                    {r.ok ? <span className="badge badge--ok">已更新</span> : <span style={{ color: '#fca5a5', fontSize: 11 }}>{r.error}</span>}
                  </div>
                ))}
              </div>
              <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 16, background: '#166534' }} onClick={handleUpdateReset}>
                重新開始
              </button>
            </div>
          )}
        </>
      )}

      {/* ── QA Mode — 批量開單 ── */}
      {mode === 'qa' && qaSubMode === 'create' && (
      <>

      {/* ── Step 1 ── */}
      {step === 1 && (
        <div className="section-card">
          <h2 className="section-title">Step 1 — 設定開單資訊</h2>
          {!currentAccount && <div className="alert-warn">請先點右上角「選擇帳號」</div>}

          {/* Project & Issue Type — 側欄並排 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <label className="field">
              <span>Jira 專案<em className="req"> *</em></span>
              <SearchSelect
                loading={projectsLoading}
                options={projects.map(p => ({ value: p.id, label: `${p.key} — ${p.name}` }))}
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                placeholder="— 選擇專案 —"
              />
            </label>
            <label className="field">
              <span>Issue 類型<em className="req"> *</em></span>
              <SearchSelect
                options={issueTypes.map(t => ({ value: t.id, label: t.name }))}
                value={selectedIssueTypeId}
                onChange={setSelectedIssueTypeId}
                placeholder="— 選擇類型 —"
                disabled={!selectedProjectId || issueTypes.length === 0}
              />
            </label>
          </div>


          <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 20 }}
            disabled={!selectedProjectId || !selectedIssueTypeId} onClick={() => setStep(2)}>
            下一步 →
          </button>
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div className="section-card">
          <h2 className="section-title">Step 2 — 選擇資料來源</h2>
          <div className="source-toggle">
            <button type="button" className={`source-btn source-btn--step${sheetSource === 'lark' ? ' active' : ''}`}
              onClick={() => { setSheetSource('lark'); setSheetUrl(''); setSheetError('') }}>
              <span className="source-icon lark-icon">L</span>Lark Spreadsheet
            </button>
            <button type="button" className={`source-btn source-btn--step${sheetSource === 'google' ? ' active' : ''}`}
              onClick={() => { setSheetSource('google'); setSheetUrl(''); setSheetError('') }}>
              <span className="source-icon google-icon">G</span>Google Sheets
            </button>
          </div>
          <div className="form-stack" style={{ marginTop: 16 }}>
            <label className="field">
              <span>{sheetSource === 'lark' ? 'Lark Sheet 網址' : 'Google Sheets 網址'}<em className="req"> *</em></span>
              <input value={sheetUrl} onChange={e => setSheetUrl(e.target.value)}
                placeholder={sheetSource === 'lark'
                  ? 'https://casinoplus.sg.larksuite.com/sheets/xxx?sheet=yyy'
                  : 'https://docs.google.com/spreadsheets/d/xxx/edit#gid=0'} />
              <span className="field-hint">
                若 Sheet 有「處理階段」欄，自動顯示「已完成」以外的所有列；<br />
                否則只顯示「Jira Issue Key」為空的列
              </span>
            </label>
            <span className="field-hint" style={{ color: '#64748b', fontSize: 11 }}>
              含「單子標題貼這」的欄位有值的列會自動過濾（視為已開單）
            </span>
            {sheetError && <div className="alert-error">{sheetError}</div>}
          </div>

          {/* ── Sheet 欄位說明 ── */}
          <div className="jira-sheet-guide">
            <details>
              <summary className="jira-sheet-guide-summary">{isGame ? <DungeonIcon name="guide" tone="cyan" size="xs" plain /> : '📋'} Sheet 欄位說明 — 查看必要 / 選填欄位與範例資料</summary>
              <div className="jira-sheet-guide-legend">
                <span className="jira-col-tag jira-col-req">必填</span>必須有值才能建立 Issue
                <span className="jira-col-tag jira-col-opt" style={{ marginLeft: 14 }}>選填</span>可留空，系統會略過
                <span className="jira-col-tag jira-col-auto" style={{ marginLeft: 14 }}>自動</span>系統寫回，請勿手動修改
              </div>
              <div className="sheet-preview-wrap" style={{ marginTop: 10 }}>
                <table className="sheet-preview-table">
                  <thead>
                    <tr>
                      <th><span className="jira-col-tag jira-col-req">必填</span> 摘要</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> 內容</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> Actual Start</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> Actual End</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> 本機完成測試時間</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> 上C服時間</th>
                      <th><span className="jira-col-tag jira-col-opt">選填</span> 上線日期</th>
                      <th><span className="jira-col-tag jira-col-auto">自動</span> Jira Issue Key</th>
                      <th><span className="jira-col-tag jira-col-auto">自動</span> 處理階段</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>[BUG] 登入頁面白屏</td>
                      <td>使用者點擊登入後頁面無回應，錯誤碼 500</td>
                      <td>2025-03-20</td>
                      <td>2025-03-22</td>
                      <td></td>
                      <td></td>
                      <td></td>
                      <td style={{ color: '#94a3b8', fontStyle: 'italic' }}>（系統填入）</td>
                      <td style={{ color: '#94a3b8', fontStyle: 'italic' }}>（系統填入）</td>
                    </tr>
                    <tr>
                      <td>[FEAT] 新增匯出 PDF 功能</td>
                      <td>在報表頁提供 PDF 匯出按鈕，支援中文字體</td>
                      <td>2025-03-21</td>
                      <td>2025-03-25</td>
                      <td>2025-03-23 18:00</td>
                      <td>2025-03-24 10:00</td>
                      <td>2025-03-26</td>
                      <td style={{ color: '#2563eb', fontWeight: 600 }}>PRJ-1023</td>
                      <td><span className="badge badge--ok" style={{ fontSize: 11 }}>已開單</span></td>
                    </tr>
                    <tr>
                      <td>[TASK] 更新第三方 SDK 版本</td>
                      <td></td>
                      <td></td>
                      <td></td>
                      <td></td>
                      <td></td>
                      <td></td>
                      <td style={{ color: '#2563eb', fontWeight: 600 }}>PRJ-1024</td>
                      <td><span className="badge badge--purple" style={{ fontSize: 11 }}>添加評論</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="field-hint" style={{ marginTop: 8 }}>
                {isGame ? <DungeonIcon name="status-warn" tone="gold" size="xs" plain /> : '⚠️'} 欄位名稱需完全符合（不區分大小寫）。「Jira Issue Key」與「處理階段」由系統自動回寫，請保留這兩欄但不要手動填入。
              </p>
            </details>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(1)}>上一步</button>
            <button type="button" className={`submit-btn submit-btn--step${sheetLoading ? ' loading' : ''}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={!sheetUrl.trim() || sheetLoading} onClick={handleFetchSheet}>
              {sheetLoading ? '讀取中...' : '讀取 Sheet'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3 ── */}
      {step === 3 && (
        <div className="section-card">
          <h2 className="section-title">
            Step 3 — 填寫 Issue 欄位
            {fieldsLoading && <span style={{ fontSize: 12, color: '#64748b', marginLeft: 8, fontWeight: 400 }}>載入欄位定義中...</span>}
            {!fieldsLoading && jiraFields.length > 0 && (
              <span style={{ marginLeft: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                <span style={{ fontSize: 13, color: '#94a3b8' }}>{filteredRecords.length} 筆</span>
                <span style={{ color: '#334155' }}>·</span>
                <span style={{ fontSize: 14, color: '#60a5fa', fontWeight: 600 }}>已勾選 {filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex))).length} 筆</span>
              </span>
            )}
          </h2>

          {fieldsError && <div className="alert-warn" style={{ marginBottom: 12 }}>{fieldsError}</div>}

          {/* Lark pre-fill hint */}
          {jiraFields.length > 0 && (
            <div style={{ background: '#162130', border: '1px solid #ca8a0440', borderRadius: 8, padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#fde047', fontWeight: 600 }}>💡 可選：從 Lark 帶入預填值</span>
              <span style={{ fontSize: 11, color: '#64748b', flex: 1 }}>系統會嘗試用 Lark 欄名對應 Jira field，對不上的欄位需手動填寫。</span>
              <button type="button"
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid #ca8a0460', background: larkPrefillApplied ? '#16a34a20' : '#ca8a0420', color: larkPrefillApplied ? '#4ade80' : '#fde047', cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={applyLarkPrefill}>
                {larkPrefillApplied ? '✓ 已帶入（可重新帶入）' : '📋 從 Lark 帶入'}
              </button>
            </div>
          )}

          {/* Validation error summary */}
          {Object.keys(cellErrors).length > 0 && (
            <div className="alert-warn" style={{ marginBottom: 12 }}>
              {Object.keys(cellErrors).length} 列有必填欄位未填，請填寫後再執行（第&nbsp;
              {Object.keys(cellErrors).map(Number).sort((a, b) => a - b).map((idx, i, arr) => (
                <span key={idx}>
                  <span
                    style={{ cursor: 'pointer', textDecoration: 'underline', color: '#fbbf24' }}
                    onClick={() => document.getElementById(`jira-dyn-row-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                  >{idx}</span>{i < arr.length - 1 ? '、' : ''}
                </span>
              ))}
              &nbsp;列）
            </div>
          )}

          {/* 欄位篩選器 */}
          {filterableColumns.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>篩選：</span>
              {filterableColumns.map(col => (
                <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
                  <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{col}</span>
                  <select
                    value={columnFilters[col] ?? ''}
                    onChange={e => setColumnFilters(prev => ({ ...prev, [col]: e.target.value }))}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160 }}>
                    <option value="">全部</option>
                    {(columnUniqueValues[col] ?? []).map((v, i) => (
                      <option key={v || `val-${i}`} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
              ))}
              {Object.values(columnFilters).some(Boolean) && (
                <button type="button"
                  onClick={() => setColumnFilters({})}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                  清除篩選
                </button>
              )}
            </div>
          )}

          {/* Operation plan preview */}
          {selectedRows.size > 0 && (
            <div className="op-plan" style={{ marginBottom: 12 }}>
              <span className="op-plan-title">選取後將執行：</span>
              {planCreate.length > 0 && <span className="badge badge--blue">➕ 建立 Issues {planCreate.length} 筆</span>}
              {planComment.length > 0 && <span className="badge badge--ok">💬 添加評論 {planComment.length} 筆（已開單）</span>}
              {planTransition.length > 0 && <span className="badge badge--purple">🔄 切換狀態 {planTransition.length} 筆（已評論）</span>}
            </div>
          )}

          {fieldsLoading && (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
              正在向 Jira 載入欄位定義...
            </div>
          )}

          {sheetRecords.length === 0
            ? <div className="alert-warn">沒有待處理的列（所有列皆已完成）</div>
            : jiraFields.length > 0 ? (
              /* ── Dynamic field grid ── */
              <>
                {/* ── 欄位管理區塊 ── */}
                <div style={{ background: '#0d1e30', border: '1px solid #1e3a5f', borderRadius: 10, padding: '12px 16px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>欄位管理</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', position: 'relative' }}>
                    {requiredJiraFields.map(f => (
                      <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#162a40', border: '1px solid #3b82f640', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#7dd3fc' }}>
                        <span style={{ color: '#f87171', fontSize: 10 }}>*</span>
                        {f.name}
                        <span style={{ fontSize: 10, color: '#475569', marginLeft: 2 }}>{f.type}</span>
                      </span>
                    ))}
                    {activeOptionalJiraFields.map(f => (
                      <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#1a2f45', border: '1px solid #2563eb40', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#93c5fd' }}>
                        {f.name}
                        <span style={{ fontSize: 10, color: '#475569', marginLeft: 2 }}>{f.type}</span>
                        <button type="button"
                          title="移除此欄位"
                          onClick={() => setActiveOptionalKeys(prev => prev.filter(k => k !== f.key))}
                          style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 0 0 2px' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#f87171' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#475569' }}>×</button>
                      </span>
                    ))}
                    <div style={{ position: 'relative' }}>
                      <button type="button"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px dashed #2563eb60', background: showFieldPicker ? '#2563eb20' : '#2563eb10', color: '#60a5fa', cursor: 'pointer' }}
                        onClick={() => { setShowFieldPicker(v => !v); setFieldPickerSearch('') }}>
                        + 新增欄位
                      </button>
                      {showFieldPicker && (() => {
                        const q = fieldPickerSearch.trim().toLowerCase()
                        const matched = q
                          ? inactiveOptionalJiraFields.filter(f => f.name.toLowerCase().includes(q) || f.key.toLowerCase().includes(q))
                          : inactiveOptionalJiraFields
                        return (
                        <div style={{ position: 'absolute', top: '100%', left: 0, background: '#1e293b', border: '1px solid #334155', borderRadius: 8, width: 240, zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', marginTop: 6 }}>
                          <div style={{ padding: '8px 12px', borderBottom: '1px solid #334155', fontSize: 12, fontWeight: 600, color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                            新增選填欄位
                            <button type="button" style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer' }} onClick={() => setShowFieldPicker(false)}>✕</button>
                          </div>
                          <div style={{ padding: '8px 10px', borderBottom: '1px solid #334155' }}>
                            <input
                              autoFocus
                              type="text"
                              value={fieldPickerSearch}
                              onChange={e => setFieldPickerSearch(e.target.value)}
                              placeholder="搜尋欄位名稱..."
                              style={{ width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #334155', borderRadius: 5, color: '#e2e8f0', fontSize: 12, padding: '5px 8px', outline: 'none' }} />
                          </div>
                          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                            {inactiveOptionalJiraFields.length === 0
                              ? <div style={{ padding: '10px 12px', fontSize: 12, color: '#64748b' }}>所有可用欄位都已加入</div>
                              : matched.length === 0
                              ? <div style={{ padding: '10px 12px', fontSize: 12, color: '#64748b' }}>找不到符合「{fieldPickerSearch}」的欄位</div>
                              : matched.map(f => (
                                <button key={f.key} type="button"
                                  style={{ width: '100%', padding: '7px 12px', fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', color: '#cbd5e1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2563eb15' }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                                  onClick={() => { setActiveOptionalKeys(prev => [...prev, f.key]); setShowFieldPicker(false); setFieldPickerSearch('') }}>
                                  <span>{f.name}</span>
                                  <span style={{ color: '#475569', fontSize: 10, fontFamily: 'monospace' }}>{f.type}</span>
                                </button>
                              ))
                            }
                          </div>
                        </div>
                        )
                      })()}
                    </div>
                  </div>
                </div>

                {/* ── 批量填入面板 ── */}
                <div style={{ background: '#0d1e30', border: '1px solid #1e3a5f', borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setShowBulkPanel(v => !v)}>
                    <span style={{ fontSize: 12, color: '#475569', transition: 'transform .2s', display: 'inline-block', transform: showBulkPanel ? 'rotate(90deg)' : 'none' }}>▶</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa' }}>批量填入</span>
                    <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>展開後可一鍵套用至所有篩選列</span>
                  </div>
                  {showBulkPanel && (
                    <div style={{ padding: '12px 16px 14px', borderTop: '1px solid #1e3a5f', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                      {visibleJiraFields.map(field => {
                        const bVal = bulkValues[field.key] ?? ''
                        const bulkInputStyle: React.CSSProperties = { background: '#0f172a', border: '1px solid #2563eb30', borderRadius: 5, color: '#e2e8f0', fontSize: 12, padding: '4px 8px', minWidth: 130, width: '100%' }
                        const bulkSelectedIds = field.type === 'multiuser' ? bVal.split(',').map(s => s.trim()).filter(Boolean) : []
                        return (
                          <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={{ fontSize: 11, color: '#64748b' }}>{field.name}{isFieldRequired(field) ? <span style={{ color: '#f87171' }}> *</span> : ''}</span>
                            {(field.type === 'select' && field.options) ? (
                              <select value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                style={{ ...bulkInputStyle, cursor: 'pointer' }}>
                                <option value="">— 批量 —</option>
                                {field.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                              </select>
                            ) : field.type === 'multiuser' ? (
                              <div>
                                {bulkSelectedIds.map(id => {
                                  return (
                                    <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#1e3a5f', borderRadius: 4, padding: '1px 5px', margin: '2px 2px', fontSize: 11, color: '#93c5fd' }}>
                                      {userLabelForField(field, id)}
                                      <button type="button" onClick={() => {
                                        const next = bulkSelectedIds.filter(x => x !== id)
                                        setBulkValues(p => ({ ...p, [field.key]: next.join(',') }))
                                      }} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                                    </span>
                                  )
                                })}
                                <select value="" onChange={e => {
                                  if (!e.target.value) return
                                  const next = [...bulkSelectedIds, e.target.value]
                                  setBulkValues(p => ({ ...p, [field.key]: next.join(',') }))
                                }} style={{ ...bulkInputStyle, marginTop: bulkSelectedIds.length ? 3 : 0, cursor: 'pointer' }}>
                                  <option value="">+ 批量新增</option>
                                  {userOptionsForField(field).filter(m => !bulkSelectedIds.includes(m.id)).map(m => (
                                    <option key={m.id} value={m.id}>{m.label}</option>
                                  ))}
                                </select>
                                <div style={{ marginTop: 3 }}>
                                  <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                    onPick={u => { mergeFieldUsers(field.key, [u]); if (!bulkSelectedIds.includes(u.id)) setBulkValues(p => ({ ...p, [field.key]: [...bulkSelectedIds, u.id].join(',') })) }} />
                                </div>
                              </div>
                            ) : field.type === 'user' ? (
                              <div>
                                <select value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                  style={{ ...bulkInputStyle, cursor: 'pointer' }}>
                                  <option value="">— 批量 —</option>
                                  {userOptionsForField(field).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                                </select>
                                <div style={{ marginTop: 3 }}>
                                  <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                    onPick={u => { mergeFieldUsers(field.key, [u]); setBulkValues(p => ({ ...p, [field.key]: u.id })) }} />
                                </div>
                              </div>
                            ) : field.type === 'date' ? (
                              <input type="date" value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                style={{ ...bulkInputStyle, colorScheme: 'dark' }} />
                            ) : field.type === 'datetime' ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <input type="date" value={bVal.split('T')[0] ?? ''} onChange={e => {
                                  const t = bVal.split('T')[1] ?? '00:00'
                                  setBulkValues(p => ({ ...p, [field.key]: `${e.target.value}T${t}` }))
                                }} style={{ ...bulkInputStyle, colorScheme: 'dark' }} />
                                <input type="time" value={bVal.split('T')[1] ?? ''} onChange={e => {
                                  const d = bVal.split('T')[0] ?? ''
                                  setBulkValues(p => ({ ...p, [field.key]: `${d}T${e.target.value}` }))
                                }} style={{ ...bulkInputStyle, colorScheme: 'dark' }} />
                              </div>
                            ) : field.type === 'text' ? (
                              <textarea value={bVal} onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                style={{ ...bulkInputStyle, resize: 'vertical', minHeight: 36 }} />
                            ) : (
                              <input type={field.type === 'number' ? 'number' : 'text'} value={bVal}
                                onChange={e => setBulkValues(p => ({ ...p, [field.key]: e.target.value }))}
                                placeholder="批量填入" style={bulkInputStyle} />
                            )}
                            {bVal && (
                              <button type="button"
                                onClick={() => applyBulkColumn(field.key, bVal)}
                                style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: '1px solid #2563eb50', background: '#2563eb20', color: '#60a5fa', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                ⬇ 套用至 {filteredRecords.length} 列
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* ── AI 摘要生成面板 ── */}
                <div style={{ background: '#0d1e30', border: `1px solid ${aiSummaryEnabled ? '#7c3aed40' : '#1e3a5f'}`, borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setAiSummaryEnabled(v => !v)}>
                    <span style={{ fontSize: 12, color: '#475569', transition: 'transform .2s', display: 'inline-block', transform: aiSummaryEnabled ? 'rotate(90deg)' : 'none' }}>▶</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: aiSummaryEnabled ? '#a78bfa' : '#60a5fa' }}>✦ AI 摘要生成</span>
                    {aiSummaryEnabled && <span style={{ fontSize: 11, background: '#2e1065', color: '#a78bfa', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>已啟用</span>}
                    <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>開啟後可用 AI 根據欄位內容自動生成 Issue 標題</span>
                  </div>
                  {aiSummaryEnabled && (
                    <div style={{ padding: '14px 16px 16px', borderTop: '1px solid #1e3a5f' }}>
                      {/* 前綴欄位 */}
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>前綴欄位（從 Sheet 取值，依序組合 [值1][值2]...）</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                          {aiPrefixColumns.map((col, idx) => (
                            <span key={col} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#1e3a5f', border: '1px solid #2563eb40', borderRadius: 6, padding: '4px 9px', fontSize: 12, color: '#93c5fd' }}>
                              {col}
                              <button type="button" onClick={() => setAiPrefixColumns(p => p.filter((_, i) => i !== idx))}
                                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                            </span>
                          ))}
                          <select value="" onChange={e => { if (e.target.value && !aiPrefixColumns.includes(e.target.value)) setAiPrefixColumns(p => [...p, e.target.value]) }}
                            style={{ background: '#0f172a', border: '1px dashed #2d3f55', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#64748b', cursor: 'pointer', outline: 'none' }}>
                            <option value="">＋ 加入欄位</option>
                            {sheetHeaders.filter(h => h && !aiPrefixColumns.includes(h)).map((h, i) => (
                              <option key={h || `h-${i}`} value={h}>{h}</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ fontSize: 11, color: '#334155', marginTop: 4 }}>空白值自動跳過，不輸出空括號。</div>
                      </div>
                      {/* 內容來源 + 模型 */}
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>內容來源欄位 <span style={{ color: '#f87171' }}>*</span></span>
                          <select value={aiContentColumn} onChange={e => setAiContentColumn(e.target.value)}
                            style={{ background: '#0f172a', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12, outline: 'none' }}>
                            <option value="">— 選擇欄位 —</option>
                            {sheetHeaders.filter(h => h).map((h, i) => <option key={h || `h-${i}`} value={h}>{h}</option>)}
                          </select>
                          <span style={{ fontSize: 11, color: '#334155' }}>此欄位文字餵給 AI 生成標題</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 160px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI 模型</span>
                          <ModelSelector value={aiSummaryModel} onChange={setAiSummaryModel} />
                        </div>
                      </div>
                      {/* 前綴預覽 */}
                      {(aiPrefixColumns.length > 0 || aiContentColumn) && filteredRecords.find(r => selectedRows.has(Number(r._rowIndex)) && needsCreate(r)) && (() => {
                        const exRow = filteredRecords.find(r => selectedRows.has(Number(r._rowIndex)) && needsCreate(r))!
                        const exPrefix = aiPrefixColumns.map(col => { const v = (exRow[col] ?? '').trim(); return v ? `[${v}]` : '' }).join('')
                        const exContent = aiContentColumn ? (exRow[aiContentColumn] ?? '').slice(0, 40) : ''
                        return (
                          <div style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', marginBottom: 12 }}>
                            <span style={{ color: '#475569', fontSize: 11 }}>範例：</span>
                            {exPrefix && <span style={{ color: '#60a5fa' }}>{exPrefix}</span>}
                            {exPrefix && <span style={{ color: '#475569' }}> + </span>}
                            <span style={{ color: '#34d399' }}>AI({exContent}{exContent.length >= 40 ? '...' : ''})</span>
                          </div>
                        )
                      })()}
                      {/* 生成按鈕 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <button type="button"
                          disabled={!aiContentColumn || summaryGenerating}
                          onClick={handleGenerateSummaries}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: summaryGenerating ? '#1e1b4b' : 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: 'white', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: !aiContentColumn || summaryGenerating ? 'not-allowed' : 'pointer', opacity: !aiContentColumn ? 0.5 : 1 }}>
                          {summaryGenerating ? '✦ 生成中...' : `✦ 批量生成摘要（${filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex)) && needsCreate(r)).length} 筆）`}
                        </button>
                        {summaryProgress && (
                          <span style={{ fontSize: 12, color: summaryProgress.done >= summaryProgress.total ? '#4ade80' : '#a78bfa' }}>
                            {summaryProgress.done >= summaryProgress.total ? `✓ 完成 ${summaryProgress.total} 筆` : `${summaryProgress.done} / ${summaryProgress.total}`}
                          </span>
                        )}
                        {Object.keys(generatedSummaries).length > 0 && !summaryGenerating && (
                          <button type="button" onClick={() => { setGeneratedSummaries({}); setSummaryProgress(null) }}
                            style={{ background: 'none', border: '1px solid #334155', borderRadius: 6, color: '#64748b', padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>
                            清除生成結果
                          </button>
                        )}
                      </div>
                      {summaryGenerating && summaryProgress && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ background: '#1e293b', borderRadius: 4, height: 5, overflow: 'hidden' }}>
                            <div style={{ background: 'linear-gradient(90deg, #7c3aed, #a78bfa)', height: '100%', width: `${Math.round(summaryProgress.done / summaryProgress.total * 100)}%`, transition: 'width .3s' }} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="table-wrap" style={{ overflowX: 'auto' }}>
                <table className="version-table" style={{ minWidth: 'max-content' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox"
                          checked={filteredRecords.length > 0 && filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))}
                          onChange={() => {
                            const allSelected = filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))
                            setSelectedRows(prev => {
                              const n = new Set(prev)
                              filteredRecords.forEach(r => allSelected ? n.delete(Number(r._rowIndex)) : n.add(Number(r._rowIndex)))
                              return n
                            })
                          }} />
                      </th>
                      <th style={{ width: 44 }}>#</th>
                      <th style={{ width: 80 }}>階段</th>
                      {requiredJiraFields.map(f => (
                        <th key={f.key} style={{ minWidth: f.key === 'summary' ? 220 : 130 }}>
                          {f.name} <span style={{ color: '#f87171' }}>*</span>
                          <div style={{ fontSize: 10, color: '#475569', fontWeight: 400, fontFamily: 'monospace' }}>{f.type}</div>
                        </th>
                      ))}
                      {activeOptionalJiraFields.map(f => (
                        <th key={f.key} style={{ minWidth: 120, background: '#162138', borderLeft: '2px solid #334155' }}>
                          <span style={{ color: '#93c5fd' }}>{f.name}</span>
                          <div style={{ fontSize: 10, color: '#334155', fontWeight: 400, fontFamily: 'monospace' }}>{f.type}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(r => {
                      const rowIdx = Number(r._rowIndex)
                      const rowCells = cellValues[rowIdx] ?? {}
                      const rowErrors = cellErrors[rowIdx] ?? {}
                      const hasRowError = Object.keys(rowErrors).length > 0
                      return (
                        <tr key={rowIdx} id={`jira-dyn-row-${rowIdx}`} style={hasRowError ? { background: 'rgba(239,68,68,0.18)', borderLeft: '3px solid #ef4444' } : undefined}>
                          <td>
                            <input type="checkbox"
                              checked={selectedRows.has(rowIdx)}
                              onChange={() => toggleRow(rowIdx)} />
                          </td>
                          <td style={{ color: '#94a3b8', fontSize: 12 }}>{rowIdx}</td>
                          <td><span className={stageBadgeClass(r)}>{stageLabel(r)}</span></td>
                          {visibleJiraFields.map(field => {
                            const val = rowCells[field.key] ?? ''
                            const err = rowErrors[field.key]
                            const inputStyle: React.CSSProperties = {
                              width: '100%', background: '#0f172a', border: `1px solid ${err ? '#ef4444' : '#2d3f55'}`,
                              borderRadius: 5, color: '#e2e8f0', fontSize: 12, padding: '4px 7px', outline: 'none',
                              minWidth: field.key === 'summary' ? 200 : 100,
                            }
                            const selectedIds = field.type === 'multiuser' ? val.split(',').map(s => s.trim()).filter(Boolean) : []
                            // For summary field with AI enabled: show generated value
                            if (field.key === 'summary' && aiSummaryEnabled && needsCreate(r)) {
                              const genVal = generatedSummaries[rowIdx]
                              return (
                                <td key={field.key}>
                                  {genVal ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <span style={{ background: '#2e1065', color: '#a78bfa', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>AI ✦</span>
                                      <input value={genVal}
                                        onChange={e => setGeneratedSummaries(p => ({ ...p, [rowIdx]: e.target.value }))}
                                        style={{ ...inputStyle, border: '1px solid #7c3aed40', flex: 1 }} />
                                    </div>
                                  ) : summaryGenerating ? (
                                    <span style={{ fontSize: 12, color: '#7c3aed', display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <span style={{ width: 10, height: 10, border: '2px solid #7c3aed30', borderTopColor: '#7c3aed', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
                                      生成中...
                                    </span>
                                  ) : (
                                    <input type="text" value={val || getField(r, SHEET_FIELD.summary)}
                                      onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                      placeholder="點批量生成或直接填寫" style={{ ...inputStyle, color: '#64748b' }} />
                                  )}
                                  {err && <div style={{ fontSize: 10, color: '#f87171', marginTop: 2 }}>{err}</div>}
                                </td>
                              )
                            }
                            return (
                              <td key={field.key} style={isFieldRequired(field) ? undefined : { background: '#0e1e2e' }}>
                                {(field.type === 'select' && field.options) ? (
                                  <select value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, cursor: 'pointer' }}>
                                    <option value="">— 選擇 —</option>
                                    {field.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                                  </select>
                                ) : field.type === 'multiuser' ? (
                                  <div style={{ minWidth: 140 }}>
                                    {selectedIds.map(id => {
                                      return (
                                        <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#1e3a5f', border: '1px solid #2563eb40', borderRadius: 4, padding: '1px 5px', margin: '2px 2px', fontSize: 11, color: '#93c5fd' }}>
                                          {userLabelForField(field, id)}
                                          <button type="button" onClick={() => toggleMultiuser(rowIdx, field.key, id)}
                                            style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                                        </span>
                                      )
                                    })}
                                    <select value="" onChange={e => { if (e.target.value) toggleMultiuser(rowIdx, field.key, e.target.value) }}
                                      style={{ ...inputStyle, marginTop: selectedIds.length ? 3 : 0, cursor: 'pointer' }}>
                                      <option value="">+ 新增成員</option>
                                      {userOptionsForField(field).filter(m => !selectedIds.includes(m.id)).map(m => (
                                        <option key={m.id} value={m.id}>{m.label}</option>
                                      ))}
                                    </select>
                                    <div style={{ marginTop: 3 }}>
                                      <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                        onPick={u => { mergeFieldUsers(field.key, [u]); if (!selectedIds.includes(u.id)) toggleMultiuser(rowIdx, field.key, u.id) }} />
                                    </div>
                                  </div>
                                ) : field.type === 'user' ? (
                                  <div style={{ minWidth: 120 }}>
                                    <select value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                      style={{ ...inputStyle, cursor: 'pointer' }}>
                                      <option value="">— 選擇 —</option>
                                      {userOptionsForField(field).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                                    </select>
                                    <div style={{ marginTop: 3 }}>
                                      <UserFieldSearch field={field} projectKey={searchProjectKey} issueTypeId={selectedIssueTypeId} issueTypeName={searchIssueTypeName} email={currentAccount?.email ?? ''}
                                        onPick={u => { mergeFieldUsers(field.key, [u]); setCellValue(rowIdx, field.key, u.id) }} />
                                    </div>
                                  </div>
                                ) : field.type === 'text' ? (
                                  <textarea value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, minHeight: 40, resize: 'vertical' }} />
                                ) : field.type === 'date' ? (
                                  <input type="date" value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, colorScheme: 'dark' }} />
                                ) : field.type === 'datetime' ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 130 }}>
                                    <input type="date" value={val.split('T')[0] ?? ''} onChange={e => {
                                      const t = val.split('T')[1] ?? '00:00'
                                      setCellValue(rowIdx, field.key, `${e.target.value}T${t}`)
                                    }} style={{ ...inputStyle, colorScheme: 'dark' }} />
                                    <input type="time" value={val.split('T')[1] ?? ''} onChange={e => {
                                      const d = val.split('T')[0] ?? ''
                                      setCellValue(rowIdx, field.key, `${d}T${e.target.value}`)
                                    }} style={{ ...inputStyle, colorScheme: 'dark' }} />
                                  </div>
                                ) : (
                                  <input type={field.type === 'number' ? 'number' : 'text'}
                                    value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    placeholder={field.required ? '' : '可選填'}
                                    style={inputStyle} />
                                )}
                                {err && <div style={{ fontSize: 10, color: '#f87171', marginTop: 2 }}>{err}</div>}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              </>
            ) : !fieldsLoading ? (
              /* Fallback: show Lark data if fields failed to load */
              <>
              <div className="alert-warn" style={{ marginBottom: 8, fontSize: 12 }}>
                ⚠️ 動態欄位未載入（Jira fields API 未回傳資料），顯示 Lark 原始資料。請開啟 F12 → Console 查看 [jira-fields] 日誌。
              </div>
              <div className="table-wrap">
                <table className="version-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox"
                          checked={filteredRecords.length > 0 && filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))}
                          onChange={() => {
                            const allSelected = filteredRecords.every(r => selectedRows.has(Number(r._rowIndex)))
                            setSelectedRows(prev => {
                              const n = new Set(prev)
                              filteredRecords.forEach(r => allSelected ? n.delete(Number(r._rowIndex)) : n.add(Number(r._rowIndex)))
                              return n
                            })
                          }} />
                      </th>
                      <th style={{ width: 52 }}>列</th>
                      <th style={{ width: 90 }}>階段</th>
                      {sheetHeaders.map((h, i) => <th key={h || `sh-${i}`}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(r => (
                      <tr key={r._rowIndex}>
                        <td><input type="checkbox" checked={selectedRows.has(Number(r._rowIndex))} onChange={() => toggleRow(Number(r._rowIndex))} /></td>
                        <td style={{ color: '#94a3b8', fontSize: 12 }}>{r._rowIndex}</td>
                        <td><span className={stageBadgeClass(r)}>{stageLabel(r)}</span></td>
                        {sheetHeaders.map((h, i) => {
                          const val = r[h] ?? ''
                          const member = members.find(m => m.accountId === val)
                          return (
                            <td key={h || `sh-${i}`} title={val}>
                              {member
                                ? <span className="member-chip">
                                    {member.avatarUrl && <img src={member.avatarUrl} alt={member.displayName} className="chip-avatar" />}
                                    {member.displayName}
                                  </span>
                                : <span className="cell-text">{val || '—'}</span>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            ) : null}

          <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(2)}>上一步</button>
            <button type="button"
              className={`submit-btn submit-btn--step${submitting ? ' loading' : ''}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              disabled={filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex))).length === 0 || submitting || !currentAccount || fieldsLoading}
              onClick={handleCreate}>
              {submitting ? '處理中...' : `開始執行（${filteredRecords.filter(r => selectedRows.has(Number(r._rowIndex))).length} 筆）`}
            </button>
            {Object.keys(cellErrors).length > 0 && (
              <span style={{ fontSize: 12, color: '#f87171' }}>
                {Object.keys(cellErrors).length} 列有必填未填，第&nbsp;
                {Object.keys(cellErrors).map(Number).sort((a, b) => a - b).map((idx, i, arr) => (
                  <span key={idx}>
                    <span
                      style={{ cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => document.getElementById(`jira-dyn-row-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                    >{idx}</span>{i < arr.length - 1 ? '、' : ''}
                  </span>
                ))}
                &nbsp;列
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Step 4: 建立結果 ── */}
      {step === 4 && (
        <div className="section-card">
          <h2 className="section-title">Step 4 — 建立 Issues 結果</h2>

          {planCreate.length === 0 && (
            <div className="alert-info">
              本批次無需建立新 Issue，已將現有 Issue 帶入後續流程。
            </div>
          )}

          {createResults.length > 0 && (
            <>
              <div className="result-summary">
                <div className="summary-item ok">{isGame ? <DungeonIcon name="status-ok" tone="green" size="xs" plain /> : '✅'} 成功 {createResults.filter(r => r.issueKey).length} 筆</div>
                <div className={`summary-item${createResults.filter(r => r.error).length > 0 ? ' error' : ''}`}>
                  {createResults.filter(r => r.error).length > 0
                    ? <>{isGame ? <DungeonIcon name="status-error" tone="red" size="xs" plain /> : '❌'} 失敗 {createResults.filter(r => r.error).length} 筆</> : '✓ 無失敗'}
                </div>
              </div>
              <div className="result-group">
                {createResults.filter(r => r.issueKey).map(r => (
                  <div key={r.rowIndex} className="result-row ok">
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>Row {r.rowIndex}</span>
                    <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${r.issueKey}`} target="_blank" rel="noreferrer">
                      <code>{r.issueKey}</code>
                    </a>
                    {r.writebackSkipped
                      ? <span className="badge badge--warn">待手動填回</span>
                      : r.writebackOk
                        ? <span className="badge badge--ok">已回寫 ✓</span>
                        : <span className="badge badge--error">回寫失敗</span>}
                    {!r.writebackSkipped && !r.writebackOk && r.writebackError && (
                      <span className="err-msg">{r.writebackError}</span>
                    )}
                  </div>
                ))}
                {createResults.filter(r => r.error).map(r => (
                  <div key={r.rowIndex} className="result-row error">
                    <span>Row {r.rowIndex}</span>
                    <span className="err-msg">{r.error}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 帶入的現有 Issues */}
          {planComment.length + planTransition.length > 0 && (
            <div className="result-group">
              <h3>現有 Issues（帶入後續流程）</h3>
              {[...planComment, ...planTransition].map(r => {
                const key = getField(r, 'Jira Issue Key') || getField(r, 'jira issue key')
                return (
                  <div key={r._rowIndex} className="result-row ok">
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>Row {r._rowIndex}</span>
                    <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${key}`} target="_blank" rel="noreferrer">
                      <code>{key}</code>
                    </a>
                    <span className={stageBadgeClass(r)}>{stageLabel(r)}</span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="stage-nav" style={{ marginTop: 16 }}>
            <button type="button" className="submit-btn submit-btn--step" style={{ background: '#166534' }} onClick={handleReset}>
              完成，重新開始
            </button>
          </div>
        </div>
      )}

      </> // end create block
      )}

      {/* ── Comment Tab: 批量評論（standalone 入口） ── */}
      {mode === 'qa' && qaSubMode === 'comment' && commentTabStep === 1 && (
        <div className="section-card">
          <h2 className="section-title">批量評論</h2>
          <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
            貼入 Lark Sheet URL，系統自動偵測含 Jira Issue Key 的列（格式如 ABC-123），批量添加評論與附件。
          </p>
          {commentTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{commentTabError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={commentTabUrl}
              onChange={e => setCommentTabUrl(e.target.value)}
              placeholder="https://casinoplus.sg.larksuite.com/wiki/... 或 Lark Sheet URL"
              style={{ flex: 1, padding: '7px 12px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
              onKeyDown={e => e.key === 'Enter' && handleCommentTabLoad()}
            />
            <button
              type="button"
              className="submit-btn submit-btn--step"
              disabled={commentTabLoading || !commentTabUrl.trim()}
              onClick={handleCommentTabLoad}
              style={{ whiteSpace: 'nowrap' }}
            >
              {commentTabLoading ? '讀取中…' : '📥 讀取'}
            </button>
          </div>
        </div>
      )}

      {/* ── Comment Tab Step 2: 選擇要評論的 Issue ── */}
      {mode === 'qa' && qaSubMode === 'comment' && commentTabStep === 2 && (
        <div className="section-card">
          <h2 className="section-title">選擇要評論的 Issue（共 {trackedIssues.length} 筆）</h2>

          {/* Column filters */}
          {commentFilterableColumns.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>篩選：</span>
              {commentFilterableColumns.map(col => (
                <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
                  <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{col}</span>
                  <select value={commentTabColFilters[col] ?? ''} onChange={e => setCommentTabColFilters(prev => ({ ...prev, [col]: e.target.value }))}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155' }}>
                    <option value="">全部</option>
                    {(commentColumnUniqueValues[col] ?? []).map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              ))}
              {Object.values(commentTabColFilters).some(Boolean) && (
                <button type="button" onClick={() => setCommentTabColFilters({})}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #334155', background: 'none', cursor: 'pointer', color: '#94a3b8' }}>
                  清除篩選
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: '#94a3b8' }}>
              <input
                type="checkbox"
                checked={commentFilteredIssues.length > 0 && commentFilteredIssues.every(i => commentTabSelectedKeys.has(i.issueKey))}
                onChange={e => setCommentTabSelectedKeys(prev => {
                  const n = new Set(prev)
                  commentFilteredIssues.forEach(i => e.target.checked ? n.add(i.issueKey) : n.delete(i.issueKey))
                  return n
                })}
              />
              全選 / 取消全選
            </label>
            <span style={{ fontSize: 11, color: '#60a5fa' }}>
              已選 {commentTabSelectedKeys.size} / {trackedIssues.length} 筆
              {commentFilteredIssues.length < trackedIssues.length && <span style={{ color: '#94a3b8' }}>{`（篩選顯示 ${commentFilteredIssues.length} 筆）`}</span>}
            </span>
          </div>

          {(() => {
            const visibleCols = sheetHeaders.filter(h => !h.endsWith('__url') && h !== '_rowIndex' && !commentFilteredIssues.every(i => {
              const rec = sheetRecords.find(r => Number(r._rowIndex) === i.rowIndex)
              return !(rec?.[h] ?? '').trim()
            })).slice(0, 7)
            const thStyle: React.CSSProperties = { padding: '7px 10px', borderBottom: '2px solid #1e3a5f', borderRight: '1px solid #1e3a5f', fontSize: 11, fontWeight: 700, color: '#60a5fa', whiteSpace: 'nowrap', textAlign: 'left', background: '#0f2744' }
            const tdBase: React.CSSProperties = { padding: '5px 10px', borderRight: '1px solid #1e293b', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }
            return (
              <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: `${36 + 110 + visibleCols.length * 160}px` }}>
                    <colgroup>
                      <col style={{ width: 36 }} />
                      <col style={{ width: 110 }} />
                      {visibleCols.map(h => <col key={h} style={{ width: 160 }} />)}
                    </colgroup>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr>
                        <th style={{ ...thStyle, width: 36, textAlign: 'center' }} />
                        <th style={thStyle}>Issue Key</th>
                        {visibleCols.map(h => <th key={h} style={thStyle}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {commentFilteredIssues.length === 0 ? (
                        <tr><td colSpan={2 + visibleCols.length} style={{ padding: '12px 16px', fontSize: 12, color: '#64748b', textAlign: 'center' }}>篩選條件下無符合的 Issue</td></tr>
                      ) : commentFilteredIssues.map((issue, idx) => {
                        const isSelected = commentTabSelectedKeys.has(issue.issueKey)
                        const rec = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
                        return (
                          <tr key={issue.issueKey}
                            onClick={() => setCommentTabSelectedKeys(prev => { const n = new Set(prev); isSelected ? n.delete(issue.issueKey) : n.add(issue.issueKey); return n })}
                            style={{ background: isSelected ? (idx % 2 === 0 ? '#0a1628' : '#0d1e38') : '#070f1e', opacity: isSelected ? 1 : 0.45, cursor: 'pointer', borderBottom: '1px solid #1e293b' }}>
                            <td style={{ ...tdBase, width: 36, textAlign: 'center' }}>
                              <input type="checkbox" checked={isSelected} readOnly
                                onChange={e => { e.stopPropagation(); setCommentTabSelectedKeys(prev => { const n = new Set(prev); e.target.checked ? n.add(issue.issueKey) : n.delete(issue.issueKey); return n }) }}
                                onClick={e => e.stopPropagation()}
                              />
                            </td>
                            <td style={{ ...tdBase, whiteSpace: 'nowrap' }}>
                              <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${issue.issueKey}`} target="_blank" rel="noreferrer"
                                onClick={e => e.stopPropagation()}
                                style={{ color: '#93c5fd', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}>
                                {issue.issueKey}
                              </a>
                            </td>
                            {visibleCols.map(h => (
                              <td key={h} style={{ ...tdBase, color: '#94a3b8' }}>
                                {(rec?.[h] ?? '').trim() || <span style={{ color: '#374151' }}>—</span>}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}
          <div className="stage-nav">
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setCommentTabStep(1)}>← 重新讀取</button>
            <button type="button" className="submit-btn submit-btn--step"
              disabled={commentTabSelectedKeys.size === 0}
              onClick={() => {
                setTrackedIssues(prev => prev.filter(i => commentTabSelectedKeys.has(i.issueKey)))
                setCommentTabStep(3)
              }}>
              下一步：設定評論（{commentTabSelectedKeys.size} 筆）→
            </button>
          </div>
        </div>
      )}

      {/* ── Step 5: 添加評論 ── */}
      {((mode === 'qa' && qaSubMode === 'create' && step === 5) || (mode === 'qa' && qaSubMode === 'comment' && commentTabStep === 3)) && (
        <div className="section-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              {qaSubMode === 'comment' ? `批量評論（${toComment.length} 筆）` : `Step 5 — 添加評論（${toComment.length} 筆）`}
            </h2>
            {qaSubMode === 'comment'
              ? <button type="button" className="btn-ghost" style={{ whiteSpace: 'nowrap', fontSize: 13 }}
                  onClick={() => { setCommentTabStep(1); setTrackedIssues([]); setCommentResults([]); setPreviewMode(false); setPreviewItems([]) }}>
                  ← 重新載入
                </button>
              : <button type="button" className="btn-ghost" style={{ whiteSpace: 'nowrap', fontSize: 13 }}
                  disabled={refreshingSheet || commentSubmitting}
                  onClick={handleRefreshSheetForComment}>
                  {refreshingSheet ? '讀取中...' : '↻ 重新讀取 Sheet'}
                </button>
            }
          </div>

          {toComment.length === 0
            ? <div className="alert-info">目前無需添加評論的 Issue。</div>
            : (
              <div className="form-stack">
                <label className="field">
                  <span>評論內容來源欄位 <em className="req">*</em></span>
                  <select value={commentColumn} onChange={e => setCommentColumn(e.target.value)}>
                    <option value="">— 選擇欄位 —</option>
                    {sheetHeaders.map((h, i) => <option key={h || `sh-${i}`} value={h}>{h}</option>)}
                  </select>
                  <span className="field-hint">選擇試算表中要作為 Jira 評論內容的欄位（如：驗證結果）</span>
                </label>
                <label className="field">
                  <span>附件欄位（選填）</span>
                  <select value={attachmentColumn} onChange={e => setAttachmentColumn(e.target.value)}>
                    <option value="">— 不上傳附件 —</option>
                    {sheetHeaders.map((h, i) => <option key={h || `sh-${i}`} value={h}>{h}</option>)}
                  </select>
                  <span className="field-hint">支援 Lark Drive 連結 和 Google Drive 分享連結（drive.google.com/file/d/...）；多個連結換行分隔。圖片自動上傳為 Jira 附件，影片自動寫入評論內文。</span>
                </label>
                {isAdmin && (
                  <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <input type="checkbox" checked={useAiComment} onChange={e => setUseAiComment(e.target.checked)} />
                    <span>AI 優化（管理員限定：Gemini 整理評論內容 + 二次分析）</span>
                  </label>
                )}

                {(useAiComment && isAdmin) && (
                  <>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <label className="field" style={{ flex: 1, margin: 0 }}>
                        <span>使用 Prompt 模板</span>
                        <select value={selectedPromptId} onChange={e => setSelectedPromptId(e.target.value)}>
                          {availablePrompts.length === 0
                            ? <option value="default">標準 QA 報告（預設）</option>
                            : availablePrompts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)
                          }
                        </select>
                      </label>
                      <label className="field" style={{ margin: 0, minWidth: 180 }}>
                        <span>AI 模型</span>
                        <ModelSelector value={commentModel} onChange={setCommentModel} />
                      </label>
                    </div>
                    {/* 知識庫選擇器 */}
                    {kbDocs.length > 0 && (
                      <div style={{ background: '#162032', border: '1px solid #2d3f55', borderRadius: 8, padding: '10px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                          📚 知識庫來源
                          <span style={{ fontWeight: 400, color: '#334155' }}>（勾選的文件內容會附加到 AI context）</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {kbDocs.map(doc => {
                            const on = selectedKbDocIds.includes(doc.id)
                            const tags: string[] = (() => { try { return JSON.parse(doc.tags) } catch { return [] } })()
                            return (
                              <div key={doc.id}
                                onClick={() => setSelectedKbDocIds(prev => on ? prev.filter(id => id !== doc.id) : [...prev, doc.id])}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 5, borderRadius: 6,
                                  padding: '5px 10px', fontSize: 12, cursor: 'pointer', userSelect: 'none',
                                  background: on ? 'rgba(37,99,235,.15)' : '#1e293b',
                                  border: `1px solid ${on ? 'rgba(59,130,246,.4)' : '#2d3f55'}`,
                                  color: on ? '#93c5fd' : '#475569',
                                }}>
                                {on && <span style={{ color: '#3b82f6', fontSize: 11 }}>✓</span>}
                                {doc.name}
                                {tags.length > 0 && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>· {tags.slice(0, 2).join(' · ')}</span>}
                              </div>
                            )
                          })}
                        </div>
                        {selectedKbDocIds.length > 0 && (
                          <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>
                            已選 {selectedKbDocIds.length} 份文件，內容將附入 AI context（超過模型上限時自動截斷）
                          </div>
                        )}
                      </div>
                    )}

                    <label className="field">
                      <span>規格書參考段落 <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>（選填 — 對應模板中 {'{{'+'specContext'+'}}'} 佔位符，所有 Issue 共用）</span></span>
                      <textarea
                        value={specContext}
                        onChange={e => setSpecContext(e.target.value)}
                        placeholder={'貼上相關規格書段落，AI 會以此作為判斷依據（留空則忽略）'}
                        rows={4}
                        style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                      />
                    </label>
                  </>
                )}
              </div>
            )}

          <div className="stage-issues">
            {toComment.map(t => (
              <span key={t.rowIndex} className="issue-chip">
                <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${t.issueKey}`} target="_blank" rel="noreferrer">
                  {t.issueKey}
                </a>
              </span>
            ))}
          </div>

          {commentResults.length > 0 && (
            <div className="result-group" style={{ marginTop: 12 }}>
              {commentResults.map(r => (
                <div key={r.rowIndex} className={`result-row ${r.ok ? 'ok' : 'error'}`}>
                  <code>{r.issueKey}</code>
                  {r.ok
                    ? <>
                        <span className="badge badge--ok">評論已添加 ✓</span>
                        {r.usedAi
                          ? <span className="badge badge--purple">{isGame ? <DungeonIcon name="ai" tone="violet" size="xs" plain /> : '🤖'} AI 優化</span>
                          : useAiComment
                            ? <span className="badge badge--warn">{isGame ? <DungeonIcon name="status-warn" tone="gold" size="xs" plain /> : '⚠'} AI 跳過（欄位空白）</span>
                            : null}
                      </>
                    : <span className="err-msg">{r.error ?? '失敗'}</span>}
                </div>
              ))}
            </div>
          )}

          {!!pendingCommentRequestId && !commentSubmitting && (
            <div style={{ margin: '10px 0 4px', fontSize: 12, color: '#b45309' }}>
              串流已中斷，正在嘗試從後端恢復結果，完成前將暫時鎖定提交按鈕。
            </div>
          )}

          {/* ── 預覽模式開關 ── */}
          {!previewMode && toComment.length > 0 && (
            <div className="stage-nav" style={{ marginTop: 16 }}>
              {qaSubMode === 'comment'
                ? null
                : <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(4)}>上一步</button>}
              <button type="button"
                className={`submit-btn submit-btn--step${prefetchLoading ? ' loading' : ''}`}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                disabled={!commentColumn || prefetchLoading}
                onClick={handleEnterPreview}>
                {prefetchLoading ? '載入附件中...' : `預覽評論（${toComment.length} 筆）→`}
              </button>
              {qaSubMode !== 'comment' && (
                <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(6)}>
                  {toTransition.length > 0 ? `切換狀態 (${toTransition.length} 筆) →` : '跳過 →'}
                </button>
              )}
            </div>
          )}
          {!previewMode && toComment.length === 0 && qaSubMode !== 'comment' && (
            <div className="stage-nav" style={{ marginTop: 16 }}>
              <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(4)}>上一步</button>
              <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(6)}>
                {toTransition.length > 0 ? `切換狀態 (${toTransition.length} 筆) →` : '跳過 →'}
              </button>
            </div>
          )}

          {/* ── 預覽表格 ── */}
          {previewMode && (
            <div style={{ marginTop: 16 }}>
              {/* Template section */}
              <div style={{ marginBottom: 12, padding: '10px 12px', background: '#0d1117', border: '1px solid #2d3f55', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>📋 評論模板</span>
                  <button type="button"
                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(31,111,235,0.15)', color: '#58a6ff', border: '1px solid rgba(31,111,235,0.3)', cursor: 'pointer' }}
                    onClick={() => {
                      if (navigator.clipboard) {
                        navigator.clipboard.writeText(COMMENT_TEMPLATE).catch(() => {})
                      } else {
                        const ta = document.createElement('textarea')
                        ta.value = COMMENT_TEMPLATE
                        ta.style.position = 'fixed'; ta.style.opacity = '0'
                        document.body.appendChild(ta); ta.select()
                        document.execCommand('copy')
                        document.body.removeChild(ta)
                      }
                    }}>
                    複製
                  </button>
                  <button type="button"
                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(63,185,80,0.15)', color: '#3fb950', border: '1px solid rgba(63,185,80,0.3)', cursor: 'pointer' }}
                    onClick={handleBatchAppendTemplate}>
                    批量往下貼入所有評論
                  </button>
                </div>
                <pre style={{ margin: 0, fontSize: 11, color: '#64748b', fontFamily: 'monospace', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{COMMENT_TEMPLATE}</pre>
              </div>

              {/* Stats bar */}
              {(() => {
                const okCount = previewItems.filter(i => !i.hasError).length
                const errCount = previewItems.filter(i => i.hasError).length
                return (
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3fb950', display: 'inline-block' }} />
                      <span style={{ color: '#94a3b8' }}>格式通過</span>
                      <strong style={{ color: '#e2e8f0' }}>{okCount}</strong>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f85149', display: 'inline-block' }} />
                      <span style={{ color: '#94a3b8' }}>格式錯誤</span>
                      <strong style={{ color: '#e2e8f0' }}>{errCount}</strong>
                    </span>
                    <span style={{ marginLeft: 'auto', color: '#475569', fontSize: 11 }}>✏️ 點擊評論可直接編輯</span>
                  </div>
                )
              })()}

              {prefetchError && (
                <div className="alert-warn" style={{ marginBottom: 8, fontSize: 12 }}>{prefetchError}</div>
              )}

              {/* Preview table */}
              <div style={{ border: '1px solid #2d3f55', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#162032', borderBottom: '1px solid #2d3f55' }}>
                      <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', width: 80, whiteSpace: 'nowrap' }}>Jira 單號</th>
                      <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', width: 180 }}>摘要</th>
                      <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px' }}>評論內容（可編輯）+ 附件</th>
                      <th style={{ padding: '9px 10px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', width: 140, whiteSpace: 'nowrap' }}>驗證狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewItems.map(item => (
                      <tr key={item.rowIndex}
                        style={{
                          borderBottom: '1px solid #1e2d3d',
                          background: item.hasError ? 'rgba(248,81,73,0.04)' : 'transparent',
                        }}>
                        <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                          <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${item.issueKey}`}
                            target="_blank" rel="noreferrer"
                            style={{ color: '#58a6ff', fontFamily: 'monospace', fontWeight: 600, fontSize: 12, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                            {item.issueKey}
                          </a>
                        </td>
                        <td style={{ padding: '8px 10px', verticalAlign: 'top', color: '#94a3b8', fontSize: 12, lineHeight: 1.4 }}>
                          {item.summary || '—'}
                        </td>
                        <td style={{ padding: '8px 10px', verticalAlign: 'top', minWidth: 320 }}>
                          <textarea
                            value={item.commentText}
                            onChange={e => updatePreviewComment(item.rowIndex, e.target.value)}
                            rows={5}
                            style={{
                              width: '100%', background: '#0d1117', color: '#c9d1d9',
                              border: `1px solid ${item.hasError ? 'rgba(248,81,73,0.5)' : '#2d3f55'}`,
                              borderRadius: 6, padding: '7px 9px', fontSize: 11, lineHeight: 1.6,
                              fontFamily: 'monospace', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                            }}
                          />
                          {/* Section indicator */}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                            {COMMENT_TEMPLATE_SECTIONS.map(sec => {
                              const headerMissing = item.missingSections.includes(sec.header)
                              const itemProblem = sec.items.some(i => item.missingSections.includes(i) || item.missingSections.includes(`${i}（缺欄位）`))
                              const resultProblem = sec.items.length === 0 && item.missingSections.includes(`${sec.header} 未填結果`)
                              const ok = !headerMissing && !itemProblem && !resultProblem
                              return (
                                <span key={sec.header} style={{
                                  fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 500,
                                  background: ok ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.12)',
                                  color: ok ? '#3fb950' : '#f85149',
                                }}>
                                  {sec.header.replace('【', '').replace('】', '')}{ok ? ' ✓' : ' ✗'}
                                </span>
                              )
                            })}
                          </div>
                          {/* Attachments + manual upload */}
                          <div style={{ marginTop: 8 }}>
                            {item.cachedAttachments.length > 0 && (
                              <div style={{ padding: '6px 8px', background: '#0d1117', border: '1px solid #2d3f55', borderRadius: 6, marginBottom: 6 }}>
                                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                                  📎 附件（{item.cachedAttachments.filter(a => !a.error).length} 個）
                                  {item.cachedAttachments.some(a => a.isImage && !a.error) && (
                                    <span style={{ background: 'rgba(31,111,235,0.15)', color: '#58a6ff', border: '1px solid rgba(31,111,235,0.3)', borderRadius: 3, padding: '1px 5px', fontSize: 10 }}>圖片</span>
                                  )}
                                  {item.cachedAttachments.some(a => a.isVideo) && (
                                    <span style={{ background: 'rgba(210,153,34,0.15)', color: '#d29922', border: '1px solid rgba(210,153,34,0.3)', borderRadius: 3, padding: '1px 5px', fontSize: 10 }}>影片連結</span>
                                  )}
                                </div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                  {item.cachedAttachments.map((att, ai) => (
                                    att.error ? (
                                      <div key={ai} style={{ fontSize: 10, color: '#f87171', padding: '2px 6px', background: 'rgba(248,81,73,0.1)', borderRadius: 4, border: '1px solid rgba(248,81,73,0.2)' }}>
                                        ⚠ {att.filename.length > 30 ? att.filename.slice(0, 30) + '…' : att.filename}: {att.error}
                                      </div>
                                    ) : att.isVideo ? (
                                      <div key={ai} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                        {att.cacheId ? (
                                          <video src={`/api/jira/attachment-cache/${att.cacheId}`}
                                            style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4, border: '1px solid #2d3f55' }} />
                                        ) : (
                                          <div style={{ width: 60, height: 60, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.4)', borderRadius: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 18, gap: 2, cursor: 'default' }}>
                                            <span>🎬</span>
                                            <span style={{ fontSize: 9, color: '#f59e0b' }}>未上傳</span>
                                          </div>
                                        )}
                                        <div style={{ fontSize: 9, color: att.cacheId ? '#64748b' : '#f59e0b', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
                                          {att.filename.length > 20 ? att.filename.slice(0, 20) + '…' : att.filename}
                                        </div>
                                      </div>
                                    ) : att.cacheId ? (
                                      <div key={ai} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: 'pointer', position: 'relative' }}
                                        onClick={() => setLightboxSrc(`/api/jira/attachment-cache/${att.cacheId}`)}>
                                        <img
                                          src={`/api/jira/attachment-cache/${att.cacheId}`}
                                          alt={att.filename}
                                          style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4, border: '1px solid #2d3f55' }}
                                        />
                                        <div style={{ fontSize: 9, color: '#64748b', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
                                          {att.filename}
                                        </div>
                                      </div>
                                    ) : null
                                  ))}
                                </div>
                                <div style={{ fontSize: 10, color: '#3fb950', marginTop: 5 }}>
                                  ✦ 圖片上傳至 Jira 附件區，評論末自動嵌入
                                </div>
                                {(() => {
                                  const pendingLinks = item.cachedAttachments.filter(a => a.mimeType === 'video/link' && !a.cacheId).length
                                  const uploadedVideos = item.cachedAttachments.filter(a => a.isVideo && !!a.cacheId).length
                                  return pendingLinks > uploadedVideos
                                })() && (
                                  <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 4, padding: '3px 6px', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 4 }}>
                                    ⚠ 有影片未上傳（Lark 插入附件格式無法自動下載），請用下方「上傳圖片/影片」手動上傳
                                  </div>
                                )}
                              </div>
                            )}
                            {/* Manual upload button */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 9px', borderRadius: 4, background: 'rgba(31,111,235,0.1)', color: '#58a6ff', border: '1px solid rgba(31,111,235,0.25)', cursor: uploadingRows.has(item.rowIndex) ? 'wait' : 'pointer' }}>
                                <input type="file" accept="image/*,video/*" multiple style={{ display: 'none' }}
                                  onChange={e => handleManualUpload(item.rowIndex, e.target.files)}
                                />
                                {uploadingRows.has(item.rowIndex) ? '上傳中...' : '＋ 上傳圖片/影片'}
                              </label>
                              <span style={{ fontSize: 10, color: '#475569' }}>單檔上限 10MB</span>
                            </div>
                            {uploadErrors[item.rowIndex] && (
                              <div style={{ marginTop: 5, fontSize: 11, color: '#f85149', display: 'flex', alignItems: 'center', gap: 4 }}>
                                ⚠ {uploadErrors[item.rowIndex]}
                              </div>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                          {item.hasError ? (
                            <>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 500, background: 'rgba(248,81,73,0.15)', color: '#f85149', border: '1px solid rgba(248,81,73,0.3)', whiteSpace: 'nowrap' }}>✗ 未完成</span>
                              <div style={{ marginTop: 5, fontSize: 10, color: '#f85149' }}>
                                缺漏：{item.missingSections.map(s => (
                                  <span key={s} style={{ display: 'inline-block', background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: 3, padding: '1px 4px', margin: '1px 2px', fontSize: 10 }}>
                                    {s.replace('【', '').replace('】', '')}
                                  </span>
                                ))}
                              </div>
                            </>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 500, background: 'rgba(63,185,80,0.15)', color: '#3fb950', border: '1px solid rgba(63,185,80,0.3)', whiteSpace: 'nowrap' }}>✓ 格式通過</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Preview submit bar */}
              {(() => {
                const errCount = previewItems.filter(i => i.hasError).length
                const pct = commentProgress ? Math.round(commentProgress.done / commentProgress.total * 100) : 0
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {commentSubmitting && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8' }}>
                          <span>{commentProgress ? `處理中 ${commentProgress.done} / ${commentProgress.total}` : '提交中...'}</span>
                          {commentProgress && <span>{pct}%</span>}
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: '#1e2d3d', overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 3, background: '#3b82f6', width: `${pct}%`, transition: 'width 0.3s ease' }} />
                        </div>
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <button type="button" className="btn-ghost btn-ghost--step"
                        disabled={commentSubmitting}
                        onClick={() => setPreviewMode(false)}>
                        ← 返回設定
                      </button>
                      {errCount > 0 && (
                        <span style={{ fontSize: 12, color: '#d29922', display: 'flex', alignItems: 'center', gap: 5 }}>
                          ⚠ {errCount} 筆格式不完整，仍可強制送出
                        </span>
                      )}
                      <button type="button"
                        className={`submit-btn submit-btn--step${commentSubmitting ? ' loading' : ''}`}
                        style={{ whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 'auto' }}
                        disabled={commentSubmitting || !!pendingCommentRequestId}
                        onClick={handleSubmitFromPreview}>
                        {commentSubmitting ? '處理中...' : `確認送出（${previewItems.length} 筆）`}
                      </button>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setLightboxSrc(null)}>
          <button type="button" onClick={() => setLightboxSrc(null)}
            style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 28, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
          <img src={lightboxSrc} alt="attachment preview"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, border: '1px solid #2d3f55' }} />
        </div>
      )}

      {/* ── Step 6: 切換狀態 ── */}
      {mode === 'qa' && qaSubMode === 'create' && step === 6 && (
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
                    ? <span className="badge badge--ok">狀態已更新 ✓</span>
                    : <span className="err-msg">{r.error ?? '失敗'}</span>}
                </div>
              ))}
            </div>
          )}

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
      {mode === 'qa' && qaSubMode === 'edit' && (
        <>
          {/* Step 1: 讀表格 */}
          {editTabStep === 1 && (
            <div className="section-card">
              <h2 className="section-title">批量修改</h2>
              <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
                貼入 Lark Sheet URL，系統自動偵測含 Jira Issue Key 的列，批量修改指定欄位。
              </p>
              {editTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{editTabError}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={editTabUrl}
                  onChange={e => setEditTabUrl(e.target.value)}
                  placeholder="https://casinoplus.sg.larksuite.com/wiki/... 或 Lark Sheet URL"
                  style={{ flex: 1, padding: '7px 12px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                  onKeyDown={e => e.key === 'Enter' && handleEditTabLoad()}
                />
                <button
                  type="button"
                  className="submit-btn submit-btn--step"
                  disabled={editTabLoading || !editTabUrl.trim()}
                  onClick={handleEditTabLoad}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {editTabLoading ? '讀取中…' : '📥 讀取'}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: 選擇 Issue */}
          {editTabStep === 2 && (
            <div className="section-card">
              <h2 className="section-title">
                選擇要修改的 Issue（共 {editTabIssues.length} 筆）
                {editTabJiraLoading && <span style={{ fontSize: 11, color: '#60a5fa', marginLeft: 8 }}>載入 Jira 資料中…</span>}
              </h2>

              {editTabJiraError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#1e1010', border: '1px solid #7f1d1d60', borderRadius: 6, padding: '8px 12px', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: '#f87171', flex: 1 }}>⚠ {editTabJiraError}</span>
                  <button type="button"
                    style={{ fontSize: 12, padding: '4px 12px', borderRadius: 5, border: '1px solid #f8717160', background: '#7f1d1d30', color: '#fca5a5', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    onClick={() => fetchEditTabJiraData(editTabIssues.map(i => i.issueKey))}>
                    重新載入 Jira 資料
                  </button>
                </div>
              )}

              {/* Column filters */}
              {editFilterableColumns.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>篩選：</span>
                  {editFilterableColumns.map(col => (
                    <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
                      <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{col}</span>
                      <select value={editTabColFilters[col] ?? ''} onChange={e => setEditTabColFilters(prev => ({ ...prev, [col]: e.target.value }))}
                        style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, maxWidth: 160, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155' }}>
                        <option value="">全部</option>
                        {(editColumnUniqueValues[col] ?? []).map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                  ))}
                  {Object.values(editTabColFilters).some(Boolean) && (
                    <button type="button" onClick={() => setEditTabColFilters({})}
                      style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #334155', background: 'none', cursor: 'pointer', color: '#94a3b8' }}>
                      清除篩選
                    </button>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: '#94a3b8' }}>
                  <input
                    type="checkbox"
                    checked={editFilteredIssues.length > 0 && editFilteredIssues.every(i => editTabSelectedKeys.has(i.issueKey))}
                    onChange={e => setEditTabSelectedKeys(prev => {
                      const n = new Set(prev)
                      editFilteredIssues.forEach(i => e.target.checked ? n.add(i.issueKey) : n.delete(i.issueKey))
                      return n
                    })}
                  />
                  全選 / 取消全選
                </label>
                <span style={{ fontSize: 11, color: '#60a5fa' }}>
                  已選 {editTabSelectedKeys.size} / {editTabIssues.length} 筆
                  {editFilteredIssues.length < editTabIssues.length && <span style={{ color: '#94a3b8' }}>{`（篩選顯示 ${editFilteredIssues.length} 筆）`}</span>}
                </span>
              </div>

              {(() => {
                const jiraCols = ['summary', 'assignee', 'status'] as const
                const jiraLabels: Record<string, string> = { summary: '摘要 (Jira)', assignee: '受託人 (Jira)', status: '狀態 (Jira)' }
                const thStyle: React.CSSProperties = { padding: '7px 10px', borderBottom: '2px solid #1e3a5f', borderRight: '1px solid #1e3a5f', fontSize: 11, fontWeight: 700, color: '#60a5fa', whiteSpace: 'nowrap', textAlign: 'left', background: '#0f2744' }
                const tdBase: React.CSSProperties = { padding: '5px 10px', borderRight: '1px solid #1e293b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }
                return (
                  <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
                    <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 600 }}>
                        <colgroup>
                          <col style={{ width: 36 }} />
                          <col style={{ width: 110 }} />
                          <col style={{ width: '40%' }} />
                          <col style={{ width: 120 }} />
                          <col style={{ width: 100 }} />
                        </colgroup>
                        <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                          <tr>
                            <th style={{ ...thStyle, textAlign: 'center' }} />
                            <th style={thStyle}>Issue Key</th>
                            {jiraCols.map(f => <th key={f} style={thStyle}>{jiraLabels[f]}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {editFilteredIssues.length === 0 ? (
                            <tr><td colSpan={5} style={{ padding: '12px 16px', fontSize: 12, color: '#64748b', textAlign: 'center' }}>篩選條件下無符合的 Issue</td></tr>
                          ) : editFilteredIssues.map((issue, idx) => {
                            const isSelected = editTabSelectedKeys.has(issue.issueKey)
                            const jira = editTabJiraData[issue.issueKey]
                            return (
                              <tr key={issue.issueKey}
                                onClick={() => setEditTabSelectedKeys(prev => { const n = new Set(prev); isSelected ? n.delete(issue.issueKey) : n.add(issue.issueKey); return n })}
                                style={{ background: isSelected ? (idx % 2 === 0 ? '#0a1628' : '#0d1e38') : '#070f1e', opacity: isSelected ? 1 : 0.45, cursor: 'pointer', borderBottom: '1px solid #1e293b' }}>
                                <td style={{ ...tdBase, width: 36, textAlign: 'center' }}>
                                  <input type="checkbox" checked={isSelected} readOnly
                                    onChange={e => { e.stopPropagation(); setEditTabSelectedKeys(prev => { const n = new Set(prev); e.target.checked ? n.add(issue.issueKey) : n.delete(issue.issueKey); return n }) }}
                                    onClick={e => e.stopPropagation()}
                                  />
                                </td>
                                <td style={{ ...tdBase, whiteSpace: 'nowrap' }}>
                                  <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${issue.issueKey}`} target="_blank" rel="noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    style={{ color: '#93c5fd', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}>
                                    {issue.issueKey}
                                  </a>
                                </td>
                                {jiraCols.map(f => (
                                  <td key={f} style={{ ...tdBase, color: '#94a3b8' }}>
                                    {editTabJiraLoading && !jira
                                      ? <span style={{ color: '#374151' }}>載入中…</span>
                                      : (jira?.[f] || <span style={{ color: '#374151' }}>—</span>)}
                                  </td>
                                ))}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })()}
              <div className="stage-nav">
                <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setEditTabStep(1)}>← 重新讀取</button>
                <button type="button" className="submit-btn submit-btn--step"
                  disabled={editTabSelectedKeys.size === 0}
                  onClick={() => setEditTabStep(3)}>
                  下一步：設定欄位（{editTabSelectedKeys.size} 筆）→
                </button>
              </div>
            </div>
          )}

          {/* Step 3: 設定欄位對應 */}
          {editTabStep === 3 && (
            <div className="section-card">
              <h2 className="section-title">設定欄位對應（{editTabSelectedKeys.size} 筆 Issue）</h2>
              <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
                選擇要修改的 Jira 欄位，並指定從 Lark Sheet 哪一欄取值。多個欄位可同時修改。
              </p>
              {editTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{editTabError}</div>}

              {/* Field mappings */}
              <div className="form-stack" style={{ marginBottom: 12 }}>
                {editFieldMappings.map((mapping, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
                    <select
                      value={mapping.jiraField}
                      onChange={e => setEditFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, jiraField: e.target.value } : m))}
                      style={{ width: 160, flexShrink: 0, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                    >
                      <option value="summary">摘要 (Summary)</option>
                      <option value="description">描述 (Description)</option>
                      <option value="priority">優先級 (Priority)</option>
                      <option value="assignee">受託人 (Assignee)</option>
                      <option value="labels">標籤 (Labels)</option>
                    </select>
                    <span style={{ color: '#64748b', fontSize: 13, flexShrink: 0 }}>←</span>
                    <select
                      value={mapping.sheetColumn}
                      onChange={e => setEditFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, sheetColumn: e.target.value } : m))}
                      style={{ flex: '1 1 0', minWidth: 0, padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
                    >
                      <option value="">— 選擇 Sheet 欄位 —</option>
                      {editTabHeaders.map((h, i) => <option key={h || `h-${i}`} value={h}>{h}</option>)}
                    </select>
                    {editFieldMappings.length > 1 && (
                      <button type="button" onClick={() => setEditFieldMappings(prev => prev.filter((_, i) => i !== idx))}
                        style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>×</button>
                    )}
                  </div>
                ))}
                <button type="button" className="btn-ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }}
                  onClick={() => setEditFieldMappings(prev => [...prev, { jiraField: 'summary', sheetColumn: '' }])}>
                  + 新增欄位
                </button>
              </div>

              {/* Preview table */}
              {editFieldMappings.some(m => m.sheetColumn) && editTabSelectedKeys.size > 0 && (() => {
                const activeMaps = editFieldMappings.filter(m => m.sheetColumn)
                const fieldLabel: Record<string, string> = { summary: '摘要', description: '描述', priority: '優先級', assignee: '受託人', labels: '標籤' }
                const selectedIssues = editTabIssues.filter(i => editTabSelectedKeys.has(i.issueKey)).slice(0, 50)
                const thBase: React.CSSProperties = { padding: '6px 8px', borderBottom: '2px solid #1e3a5f', borderRight: '1px solid #1e3a5f', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', textAlign: 'left', background: '#0f2744' }
                const tdBase: React.CSSProperties = { padding: '4px 8px', borderRight: '1px solid #1e293b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220, verticalAlign: 'middle' }
                return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa', marginBottom: 6 }}>
                      預覽變更（{editTabSelectedKeys.size} 筆）
                    </div>
                    <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: `${110 + activeMaps.length * 360}px` }}>
                          <colgroup>
                            <col style={{ width: 110 }} />
                            {activeMaps.map((_, i) => (
                              <span key={i} style={{ display: 'contents' }}>
                                <col style={{ width: 'auto', minWidth: 140 }} />
                                <col style={{ width: 28 }} />
                                <col style={{ width: 'auto', minWidth: 140 }} />
                              </span>
                            ))}
                          </colgroup>
                          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                            <tr>
                              <th style={{ ...thBase, color: '#60a5fa' }}>Issue Key</th>
                              {activeMaps.map((m, i) => (
                                <span key={i} style={{ display: 'contents' }}>
                                  <th style={{ ...thBase, color: '#94a3b8' }}>{fieldLabel[m.jiraField] ?? m.jiraField} (現有)</th>
                                  <th style={{ ...thBase, color: '#475569', textAlign: 'center', width: 28 }} />
                                  <th style={{ ...thBase, color: '#4ade80' }}>{m.sheetColumn} (Sheet)</th>
                                </span>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {selectedIssues.map((issue, idx) => {
                              const rec = editTabRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
                              const jira = editTabJiraData[issue.issueKey]
                              return (
                                <tr key={issue.issueKey} style={{ background: idx % 2 === 0 ? '#0a1628' : '#0d1e38', borderBottom: '1px solid #1e293b' }}>
                                  <td style={{ ...tdBase }}>
                                    <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${issue.issueKey}`} target="_blank" rel="noreferrer"
                                      style={{ color: '#93c5fd', fontWeight: 700, textDecoration: 'none' }}>{issue.issueKey}</a>
                                  </td>
                                  {activeMaps.map((m, i) => {
                                    const current = jira?.[m.jiraField] ?? ''
                                    const next = (rec?.[m.sheetColumn] ?? '').toString().trim()
                                    const changed = next && current !== next
                                    return (
                                      <span key={i} style={{ display: 'contents' }}>
                                        <td style={{ ...tdBase, color: '#64748b' }}>{current || '—'}</td>
                                        <td style={{ ...tdBase, color: '#475569', textAlign: 'center', padding: '4px 2px' }}>→</td>
                                        <td style={{ ...tdBase, color: changed ? '#4ade80' : '#374151', fontWeight: changed ? 600 : 400 }}>{next || '（無資料）'}</td>
                                      </span>
                                    )
                                  })}
                                </tr>
                              )
                            })}
                            {editTabSelectedKeys.size > 50 && (
                              <tr><td colSpan={1 + activeMaps.length * 3} style={{ padding: '6px 12px', fontSize: 11, color: '#64748b', textAlign: 'center' }}>…還有 {editTabSelectedKeys.size - 50} 筆</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )
              })()}

              <div className="stage-nav" style={{ marginTop: 16 }}>
                <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setEditTabStep(2)}>上一步</button>
                <button type="button"
                  className={`submit-btn submit-btn--step${editTabSubmitting ? ' loading' : ''}`}
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  disabled={editTabSubmitting || !editFieldMappings.some(m => m.sheetColumn) || !currentAccount}
                  onClick={handleEditTabSubmit}
                >
                  {editTabSubmitting ? '修改中...' : `確認修改（${editTabSelectedKeys.size} 筆）`}
                </button>
              </div>
            </div>
          )}

          {/* Step 4: 結果 */}
          {editTabStep === 4 && (
            <div className="section-card">
              <h2 className="section-title">批量修改結果</h2>
              {editTabError && <div className="alert-error" style={{ marginBottom: 10 }}>{editTabError}</div>}
              <div className="result-group" style={{ marginTop: 8 }}>
                {editTabResults.map(r => (
                  <div key={r.issueKey} className={`result-row ${r.ok ? 'ok' : 'error'}`}>
                    <code>
                      <a href={`${import.meta.env.VITE_JIRA_BASE_URL ?? ''}/browse/${r.issueKey}`} target="_blank" rel="noreferrer"
                        style={{ color: '#58a6ff', textDecoration: 'none' }}>
                        {r.issueKey}
                      </a>
                    </code>
                    {r.ok
                      ? <span className="badge badge--ok">修改成功 ✓</span>
                      : <span className="err-msg">{r.error ?? '失敗'}</span>}
                  </div>
                ))}
              </div>
              <div className="stage-nav" style={{ marginTop: 16 }}>
                <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setEditTabStep(3)}>上一步</button>
                <button type="button" className="submit-btn submit-btn--step" style={{ background: '#166534' }}
                  onClick={() => { setEditTabStep(1); setEditTabUrl(''); setEditTabIssues([]); setEditTabSelectedKeys(new Set()); setEditTabRecords([]); setEditTabHeaders([]); setEditTabResults([]); setEditTabError('') }}>
                  完成，重新開始
                </button>
              </div>
            </div>
          )}
        </>
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

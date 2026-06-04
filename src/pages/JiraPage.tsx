import { useCallback, useEffect, useMemo, useState } from 'react'
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
}

const STEP_LABELS: Record<Step, string> = {
  1: '選擇受託人',
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
  verifierAccountIds: '驗證人員',
  actualStart: 'Actual Start',
  actualEnd: 'Actual End',
  localTestDone: '本機完成測試時間',
  stagingDeploy: '上C服時間',
  releaseDate: '上線日期',
}

interface JiraPageProps {
  account?: AccountInfo | null
  allowedModes?: string[]
}

export function JiraPage({ account = null, allowedModes }: JiraPageProps) {
  const isGame = useIsGameMode()
  const [mode, setMode] = useState<'qa' | 'pm'>('qa')
  const [qaSubMode, setQaSubMode] = useState<'create' | 'update'>('create')
  const [step, setStep] = useState<Step>(1)
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [currentAccount, setCurrentAccount] = useState<AccountInfo | null>(account)

  // Step 1
  const [members, setMembers] = useState<Member[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState('')
  const [selectedAssignee, setSelectedAssignee] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
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

  // Apply column filters to records
  const filteredRecords = useMemo(() => {
    return sheetRecords.filter(r =>
      Object.entries(columnFilters).every(([col, val]) => !val || (r[col] ?? '').trim() === val)
    )
  }, [sheetRecords, columnFilters])

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
  const [larkPrefillApplied, setLarkPrefillApplied] = useState(false)

  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [pendingCommentRequestId, setPendingCommentRequestId] = useState('')
  const [commentProgress, setCommentProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [commentResults, setCommentResults] = useState<StageOpResult[]>([])

  // Step 6 (transition)
  const [transitionSubmitting, setTransitionSubmitting] = useState(false)
  const [transitionResults, setTransitionResults] = useState<StageOpResult[]>([])

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
  const [updateTransitions, setUpdateTransitions] = useState<{ id: string; name: string }[]>([])
  const [updateTransitionId, setUpdateTransitionId] = useState('')
  const [updateSubmitting, setUpdateSubmitting] = useState(false)
  const [updateResults, setUpdateResults] = useState<{ issueKey: string; ok: boolean; error?: string }[]>([])
  const [updateStats, setUpdateStats] = useState<{ totalRows: number; found: number; skippedEmpty: number; skippedInvalid: number } | null>(null)
  const [updatePersonFilter, setUpdatePersonFilter] = useState<string>('') // '' = 全部, '__none__' = 無填寫人, else = 填寫人名

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
    if (step !== 3 || !currentAccount || !selectedProjectId || !selectedIssueTypeId) return
    const project = projects.find(p => p.id === selectedProjectId)
    const issueType = issueTypes.find(t => t.id === selectedIssueTypeId)
    // If projects/issueTypes not yet loaded, wait for next render (they're in deps below)
    if (!project || !issueType) return
    setFieldsLoading(true); setFieldsError(''); setJiraFields([]); setActiveOptionalKeys([]); setCellValues({}); setCellErrors({}); setLarkPrefillApplied(false)
    fetch(`/api/jira/fields?projectKey=${encodeURIComponent(project.key)}&issueTypeName=${encodeURIComponent(issueType.name)}`, {
      headers: { 'x-jira-email': currentAccount.email },
    })
      .then(r => r.json())
      .then((d: { ok: boolean; fields?: NormalizedJiraField[]; message?: string }) => {
        if (d.ok && d.fields) setJiraFields(d.fields)
        else setFieldsError(d.message ?? '載入欄位失敗')
      })
      .catch(() => setFieldsError('網路錯誤，無法載入欄位'))
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
        setSelectedRows(new Set(data.records.map((r: SheetRecord) => Number(r._rowIndex))))
        setColumnFilters({})
        setStep(3)
      }
    } catch { setSheetError('網路錯誤') }
    finally { setSheetLoading(false) }
  }

  const toggleRow = (i: number) => {
    setSelectedRows(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })
  }

  // ── Dynamic field helpers ──
  const requiredJiraFields = jiraFields.filter(f => f.required)
  const optionalJiraFields = jiraFields.filter(f => !f.required)
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

  const applyLarkPrefill = () => {
    const newVals: Record<number, Record<string, string>> = {}
    for (const record of filteredRecords) {
      const rowIdx = Number(record._rowIndex)
      const rowVals: Record<string, string> = {}
      for (const field of jiraFields) {
        // Try exact column name match (case-insensitive), also try Lark aliases
        const aliases = field.key === 'summary' ? [field.name, '摘要', 'summary'] : [field.name, field.key]
        for (const alias of aliases) {
          const val = getField(record, alias).trim()
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
      case 'user': return { accountId: rawVal }
      case 'multiuser': return rawVal.split(',').map(id => ({ accountId: id.trim() })).filter(x => x.accountId)
      case 'select': return field.options ? { id: rawVal } : { name: rawVal }
      case 'multiselect': return rawVal.split(',').map(id => id.trim()).filter(Boolean).map(id => field.options ? { id } : { name: id })
      case 'number': return isNaN(Number(rawVal)) ? rawVal : Number(rawVal)
      default: return rawVal
    }
  }

  // ── Step 3 → 4: 計算操作計畫 ──
  const selectedRecords = sheetRecords.filter(r => selectedRows.has(Number(r._rowIndex)))
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

    if (planCreate.length === 0) {
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
        return {
          summary: (summaryFromCell || getField(r, SHEET_FIELD.summary)).replace(/[\r\n]+/g, ' ').trim(),
          description: rowCells['description'] || getField(r, SHEET_FIELD.description),
          assigneeAccountId: undefined,
          rdOwnerAccountId: undefined,
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
        summary: getField(r, SHEET_FIELD.summary).replace(/[\r\n]+/g, ' ').trim(),
        description: getField(r, SHEET_FIELD.description),
        assigneeAccountId: batchAssigneeIds[0] || validId(getField(r, SHEET_FIELD.assigneeAccountId)) || selectedAssignee || undefined,
        rdOwnerAccountId: batchRdOwnerIds[0] || validId(getField(r, SHEET_FIELD.rdOwnerAccountId)) || undefined,
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
      const resp = await fetch('/api/jira/batch-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ rows, sheetUrl, projectId: selectedProjectId, issueTypeId: selectedIssueTypeId }),
      })
      const data = await resp.json()
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
                columns: { 'Jira issue key': r.issueKey!, '處理階段': '已開單', '處理時間': nowString() },
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
  const handleAddComments = async () => {
    if (!currentAccount || toComment.length === 0 || !commentColumn) return
    setCommentSubmitting(true)
    setPendingCommentRequestId('')
    setCommentProgress(null)

    const comments = toComment.map(issue => {
      const record = sheetRecords.find(r => Number(r._rowIndex) === issue.rowIndex)
      const rawAttachText = (attachmentColumn && record) ? getField(record, attachmentColumn) : ''
      const attachmentUrls = rawAttachText
        ? rawAttachText.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
        : []
      const rawComment = record ? buildAiCommentRawText(record, commentColumn) : ''
      return {
        issueKey: issue.issueKey,
        rowIndex: issue.rowIndex,
        rawComment,
        useAi: useAiComment,
        promptId: useAiComment ? selectedPromptId : undefined,
        // AI 格式化使用的額外欄位（欄位不存在時為 undefined，後端自動忽略）
        machineId:   record ? getField(record, '機台編號') || undefined : undefined,
        gameMode:    record ? getField(record, '遊戲模式') || undefined : undefined,
        environment: record ? deriveEnvironment(record, rawComment) || undefined : undefined,
        version:     record ? deriveVersion(record, rawComment) || undefined : undefined,
        platform:    record ? getFieldByHeaderMatch(record, ['測試平台', '平台', '類別']) || undefined : undefined,
        attachmentUrls,
      }
    })

    let submitRequestId = ''
    try {
      // Submit job and get requestId immediately
      const resp = await fetch('/api/jira/batch-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...emailHeader },
        body: JSON.stringify({ comments, modelSpec: useAiComment ? commentModel : undefined, specContext: useAiComment && specContext.trim() ? specContext.trim() : undefined, knowledgeDocIds: useAiComment && selectedKbDocIds.length > 0 ? selectedKbDocIds : undefined }),
      })
      const submitData = await resp.json() as { ok: boolean; requestId?: string; message?: string }
      if (!submitData.ok || !submitData.requestId) {
        setCommentResults([{ rowIndex: 0, issueKey: '', ok: false, error: submitData.message ?? '提交失敗' }])
        setStep(5)
        return
      }
      submitRequestId = submitData.requestId
      setPendingCommentRequestId(submitRequestId)
      localStorage.setItem(COMMENT_PENDING_KEY, submitRequestId)

      // Wait for background job via SSE, with per-item progress updates.
      // If SSE disconnects, fall back to polling status endpoint.
      const data = await new Promise<{ ok: boolean; results?: StageOpResult[]; stopped?: boolean; stoppedReason?: string }>((resolve, reject) => {
        const es = new EventSource(`/api/jira/batch-comment/stream?requestId=${encodeURIComponent(submitData.requestId!)}&email=${encodeURIComponent(currentAccount.email)}`)
        let done = false
        es.addEventListener('progress', (e: MessageEvent) => {
          setCommentProgress(JSON.parse(e.data))
        })
        es.addEventListener('result', (e: MessageEvent) => {
          done = true
          es.close()
          resolve(JSON.parse(e.data))
        })
        es.onerror = () => {
          if (done) return
          es.close()
          reject(new Error('SSE 連線中斷'))
        }
      })

      const results = data.results ?? []

      // AI 中斷時在結果中插入一筆提示
      if (data.stopped && data.stoppedReason) {
        results.push({
          rowIndex: -1,
          issueKey: '⚠️ 已中斷',
          ok: false,
          error: `Gemini API 用量已達上限，剩餘筆數未處理。原因：${data.stoppedReason}`,
        })
      }
      setCommentResults(results)

      const successRows = results.filter(r => r.ok)
      if (successRows.length > 0) {
        await fetch('/api/sheets/writeback-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheetUrl, source: sheetSource,
            writes: successRows.map(r => ({
              rowIndex: r.rowIndex,
              columns: { '處理階段': '添加評論', '處理時間': nowString() },
            })),
          }),
        })
        // 更新本地 trackedIssues stage
        setTrackedIssues(prev => prev.map(t =>
          successRows.some(r => r.rowIndex === t.rowIndex) ? { ...t, stage: '添加評論' } : t
        ))
      }
      setStep(5)
    } catch {
      if (submitRequestId) {
        // Stream/network error happened after submit.
        // Backend job may still be running, so always try polling fallback.
        // Poll status endpoint to recover final result.
        let recovered = false
        for (let i = 0; i < 30; i++) {
          try {
            const r = await fetch(`/api/jira/batch-comment/status/${encodeURIComponent(submitRequestId)}`, { headers: { ...emailHeader } })
            const d = await r.json() as {
              ok: boolean
              status?: 'running' | 'done' | 'missing'
              progress?: { done: number; total: number; current: string }
              result?: { ok: boolean; results?: StageOpResult[]; stopped?: boolean; stoppedReason?: string }
            }
            if (!d.ok) break
            if (d.progress) setCommentProgress(d.progress)
            if (d.status === 'running') {
              await new Promise(resolve => setTimeout(resolve, 2000))
              continue
            }
            if (d.result) {
              const recoveredResults = d.result.results ?? []
              if (d.result.stopped && d.result.stoppedReason) {
                recoveredResults.push({
                  rowIndex: -1,
                  issueKey: '⚠️ 已中斷',
                  ok: false,
                  error: `Gemini API 用量已達上限，剩餘筆數未處理。原因：${d.result.stoppedReason}`,
                })
              }
              setCommentResults(recoveredResults)
              const successRows = recoveredResults.filter(r => r.ok)
              if (successRows.length > 0) {
                await fetch('/api/sheets/writeback-multi', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    sheetUrl, source: sheetSource,
                    writes: successRows.map(r => ({
                      rowIndex: r.rowIndex,
                      columns: { '處理階段': '添加評論', '處理時間': nowString() },
                    })),
                  }),
                })
                setTrackedIssues(prev => prev.map(t =>
                  successRows.some(r => r.rowIndex === t.rowIndex) ? { ...t, stage: '添加評論' } : t
                ))
              }
              setStep(5)
              recovered = true
              break
            }
            break
          } catch {
            await new Promise(resolve => setTimeout(resolve, 2000))
          }
        }
        if (!recovered) {
          setCommentResults([{ rowIndex: 0, issueKey: '', ok: false, error: '串流中斷，且未能從後端恢復結果' }])
          setStep(5)
        }
      } else {
        setCommentResults([{ rowIndex: 0, issueKey: '', ok: false, error: '網路錯誤' }])
        setStep(5)
      }
    }
    finally {
      setCommentSubmitting(false)
      setPendingCommentRequestId('')
      setCommentProgress(null)
      localStorage.removeItem(COMMENT_PENDING_KEY)
    }
  }

  // ── Step 6: 切換狀態 ──
  const handleTransition = async () => {
    if (!currentAccount || toTransition.length === 0) return
    setTransitionSubmitting(true)

    const issues = toTransition.map(t => ({ issueKey: t.issueKey, rowIndex: t.rowIndex }))

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
      if (data.jiraBaseUrl) setUpdateJiraBaseUrl(data.jiraBaseUrl)

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
            const transData = await transResp.json() as { ok: boolean; transitions?: { id: string; name: string }[] }
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
    const filtered = updatePersonFilter === ''
      ? updateRecords
      : updatePersonFilter === '__none__'
        ? updateRecords.filter(r => !r.fillPerson)
        : updateRecords.filter(r => r.fillPerson === updatePersonFilter)
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
        <div style={{ display: 'flex', gap: 8, padding: '6px 0 2px' }}>
          {(['create', 'update'] as const).map(sub => (
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
              {sub === 'create' ? '批量開單' : '批量更新狀態'}
            </button>
          ))}
        </div>
      )}

      {/* Top bar */}
      <div className="page-topbar">
        <div className="step-indicator">
          {mode === 'qa' && qaSubMode === 'create'
            ? ([1, 2, 3, 4, 5, 6] as Step[]).map(s => <StepDot key={s} s={s} />)
            : ([1, 2, 3] as const).map(s => (
                <span key={s} className={`step-dot${
                  (mode === 'pm' ? pmStep : updateStep) === s ? ' active' :
                  (mode === 'pm' ? pmStep : updateStep) > s ? ' done' : ''}`}>
                  {(mode === 'pm' ? pmStep : updateStep) > s ? '✓' : s}
                </span>
              ))
          }
          <span className="step-label">
            {mode === 'qa' && qaSubMode === 'create' ? STEP_LABELS[step]
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
                  placeholder="https://casinoplus.sg.larksuite.com/wiki/... 或 Bitable URL"
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
                    {updateTransitions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
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
                  預覽（{filteredRecords.length} 張）
                </div>
                <div style={{ border: '1px solid #1e3a5f', borderRadius: 6, overflow: 'hidden' }}>
                  {/* Table header */}
                  <div style={{ display: 'grid', gridTemplateColumns: '110px 90px 1fr', gap: 0, background: '#0f2744', borderBottom: '1px solid #1e3a5f' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', borderRight: '1px solid #1e3a5f' }}>單號</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px', borderRight: '1px solid #1e3a5f' }}>填寫人</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', padding: '5px 10px' }}>內容</div>
                  </div>
                  {/* Rows */}
                  <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                    {filteredRecords.slice(0, 200).map((r, idx) => (
                      <div key={r.issueKey} style={{ display: 'grid', gridTemplateColumns: '110px 90px 1fr', background: idx % 2 === 0 ? '#0a1628' : '#0d1e38', borderBottom: '1px solid #1e293b' }}>
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
                        <div style={{ padding: '5px 10px', fontSize: 11, color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.title || '—'}
                        </div>
                      </div>
                    ))}
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
                  disabled={updateSubmitting || !currentAccount}
                  onClick={handleUpdateExecute}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {updateSubmitting ? '執行中…' : `▶ 執行（${filteredRecords.length} 張）`}
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

          {/* Assignee */}
          <div style={{ marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#cbd5e1' }}>
              受託人<em className="req"> *</em>
            </span>
            {selectedProjectId && !membersLoading && members.length === 0 && (
              <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>此專案無可指派成員</span>
            )}
          </div>
          {membersLoading && <p className="idle-hint">載入成員中...</p>}
          {membersError && <div className="alert-error">{membersError}</div>}
          {!membersLoading && members.length > 0 && (
            <>
              <div style={{ position: 'relative', marginBottom: 10 }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', fontSize: 14, pointerEvents: 'none' }}>{isGame ? <DungeonIcon name="search" tone="slate" size="xs" plain /> : '🔍'}</span>
                <input
                  value={memberSearch}
                  onChange={e => setMemberSearch(e.target.value)}
                  placeholder="搜尋成員名稱..."
                  style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #2d3f55', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', background: '#0f172a', color: '#e2e8f0' }}
                />
              </div>
              <div className="member-list">
                {members.filter(m => m.displayName.toLowerCase().includes(memberSearch.toLowerCase())).map(m => (
                  <button key={m.accountId} type="button"
                    className={`member-card${selectedAssignee === m.accountId ? ' selected' : ''}`}
                    onClick={() => setSelectedAssignee(m.accountId)}>
                    {m.avatarUrl
                      ? <img src={m.avatarUrl} alt={m.displayName} className="member-avatar" />
                      : <span className="member-avatar-placeholder">{m.displayName.charAt(0).toUpperCase()}</span>
                    }
                    <span>{m.displayName}</span>
                  </button>
                ))}
                {members.filter(m => m.displayName.toLowerCase().includes(memberSearch.toLowerCase())).length === 0 && (
                  <span style={{ fontSize: 13, color: '#94a3b8', padding: '8px 4px' }}>找不到「{memberSearch}」</span>
                )}
              </div>
            </>
          )}

          <button type="button" className="submit-btn submit-btn--step" style={{ marginTop: 20 }}
            disabled={!selectedAssignee || !selectedProjectId || !selectedIssueTypeId} onClick={() => setStep(2)}>
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
              <span style={{ fontSize: 12, color: '#475569', marginLeft: 8, fontWeight: 400 }}>
                {filteredRecords.length} 筆 · 已勾選 {selectedRows.size} 筆
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
              {Object.keys(cellErrors).length} 列有必填欄位未填，請填寫後再執行
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

          {sheetRecords.length === 0
            ? <div className="alert-warn">沒有待處理的列（所有列皆已完成）</div>
            : jiraFields.length > 0 ? (
              /* ── Dynamic field grid ── */
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
                          <button type="button"
                            style={{ marginLeft: 4, background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}
                            title="移除此欄位"
                            onClick={() => setActiveOptionalKeys(prev => prev.filter(k => k !== f.key))}>×</button>
                          <div style={{ fontSize: 10, color: '#334155', fontWeight: 400, fontFamily: 'monospace' }}>{f.type}</div>
                        </th>
                      ))}
                      {/* Add field column */}
                      <th style={{ background: '#0e1e2e', position: 'relative', width: 80 }}>
                        <div style={{ position: 'relative' }}>
                          <button type="button"
                            style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, border: '1px dashed #3b82f660', background: 'none', color: '#60a5fa', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            onClick={() => setShowFieldPicker(v => !v)}>
                            + 欄位
                          </button>
                          {showFieldPicker && inactiveOptionalJiraFields.length > 0 && (
                            <div style={{ position: 'absolute', top: '100%', right: 0, background: '#1e293b', border: '1px solid #334155', borderRadius: 8, width: 240, zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', marginTop: 4 }}>
                              <div style={{ padding: '8px 12px', borderBottom: '1px solid #334155', fontSize: 12, fontWeight: 600, color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                                新增選填欄位
                                <button type="button" style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer' }} onClick={() => setShowFieldPicker(false)}>✕</button>
                              </div>
                              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                                {inactiveOptionalJiraFields.map(f => (
                                  <button key={f.key} type="button"
                                    style={{ width: '100%', padding: '7px 12px', fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', color: '#cbd5e1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2563eb15' }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                                    onClick={() => { setActiveOptionalKeys(prev => [...prev, f.key]); setShowFieldPicker(false) }}>
                                    <span>{f.name}</span>
                                    <span style={{ color: '#475569', fontSize: 10, fontFamily: 'monospace' }}>{f.type}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          {showFieldPicker && inactiveOptionalJiraFields.length === 0 && (
                            <div style={{ position: 'absolute', top: '100%', right: 0, background: '#1e293b', border: '1px solid #334155', borderRadius: 8, width: 200, zIndex: 100, padding: '10px 12px', fontSize: 12, color: '#64748b', marginTop: 4 }}>
                              所有可用欄位都已加入
                            </div>
                          )}
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(r => {
                      const rowIdx = Number(r._rowIndex)
                      const rowCells = cellValues[rowIdx] ?? {}
                      const rowErrors = cellErrors[rowIdx] ?? {}
                      const hasRowError = Object.keys(rowErrors).length > 0
                      return (
                        <tr key={rowIdx} style={hasRowError ? { background: 'rgba(239,68,68,0.05)' } : undefined}>
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
                            return (
                              <td key={field.key} style={field.required ? undefined : { background: '#0e1e2e' }}>
                                {(field.type === 'select' && field.options) ? (
                                  <select value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, cursor: 'pointer' }}>
                                    <option value="">— 選擇 —</option>
                                    {field.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                                  </select>
                                ) : (field.type === 'user' || field.type === 'multiuser') ? (
                                  <select value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, cursor: 'pointer' }}>
                                    <option value="">— 選擇 —</option>
                                    {members.map(m => <option key={m.accountId} value={m.accountId}>{m.displayName}</option>)}
                                  </select>
                                ) : field.type === 'text' ? (
                                  <textarea value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, minHeight: 40, resize: 'vertical' }} />
                                ) : field.type === 'date' ? (
                                  <input type="date" value={val} onChange={e => setCellValue(rowIdx, field.key, e.target.value)}
                                    style={{ ...inputStyle, colorScheme: 'dark' }} />
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
                          <td style={{ background: '#0e1e2e' }} />
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : !fieldsLoading ? (
              /* Fallback: show Lark data if fields failed to load */
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
                      {sheetHeaders.map(h => <th key={h}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(r => (
                      <tr key={r._rowIndex}>
                        <td><input type="checkbox" checked={selectedRows.has(Number(r._rowIndex))} onChange={() => toggleRow(Number(r._rowIndex))} /></td>
                        <td style={{ color: '#94a3b8', fontSize: 12 }}>{r._rowIndex}</td>
                        <td><span className={stageBadgeClass(r)}>{stageLabel(r)}</span></td>
                        {sheetHeaders.map(h => {
                          const val = r[h] ?? ''
                          const member = members.find(m => m.accountId === val)
                          return (
                            <td key={h} title={val}>
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
            ) : null}

          <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(2)}>上一步</button>
            <button type="button"
              className={`submit-btn submit-btn--step${submitting ? ' loading' : ''}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              disabled={selectedRows.size === 0 || submitting || !currentAccount || fieldsLoading}
              onClick={handleCreate}>
              {submitting ? '處理中...' : `開始執行（${selectedRows.size} 筆）`}
            </button>
            {Object.keys(cellErrors).length > 0 && (
              <span style={{ fontSize: 12, color: '#f87171' }}>{Object.keys(cellErrors).length} 列有必填未填</span>
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
            {toComment.length > 0
              ? <button type="button" className="submit-btn submit-btn--step" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => setStep(5)}>
                  下一步：添加評論 ({toComment.length} 筆) →
                </button>
              : toTransition.length > 0
                ? <button type="button" className="submit-btn submit-btn--step" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => setStep(6)}>
                    跳至：切換狀態 ({toTransition.length} 筆) →
                  </button>
                : null}
            <button type="button" className="btn-ghost btn-ghost--step" onClick={handleReset}>重新開始</button>
          </div>
        </div>
      )}

      {/* ── Step 5: 添加評論 ── */}
      {step === 5 && (
        <div className="section-card">
          <h2 className="section-title">Step 5 — 添加評論（{toComment.length} 筆）</h2>

          {toComment.length === 0
            ? <div className="alert-info">目前無需添加評論的 Issue。</div>
            : (
              <div className="form-stack">
                <label className="field">
                  <span>評論內容來源欄位 <em className="req">*</em></span>
                  <select value={commentColumn} onChange={e => setCommentColumn(e.target.value)}>
                    <option value="">— 選擇欄位 —</option>
                    {sheetHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <span className="field-hint">選擇試算表中要作為 Jira 評論內容的欄位（如：驗證結果）</span>
                </label>
                <label className="field">
                  <span>附件欄位（選填）</span>
                  <select value={attachmentColumn} onChange={e => setAttachmentColumn(e.target.value)}>
                    <option value="">— 不上傳附件 —</option>
                    {sheetHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <span className="field-hint">支援 Lark Drive 連結 和 Google Drive 分享連結（drive.google.com/file/d/...）；多個連結換行分隔。圖片自動上傳為 Jira 附件，影片自動寫入評論內文。</span>
                </label>
                <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <input type="checkbox" checked={useAiComment} onChange={e => setUseAiComment(e.target.checked)} />
                  <span>AI 優化（Gemini 將原始內容整理成專業評論格式）</span>
                </label>

                {useAiComment && (
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

          {(commentSubmitting || !!pendingCommentRequestId) && commentProgress && (
            <div style={{ margin: '12px 0 4px', fontSize: 13, color: '#475569' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>處理中：<strong>{commentProgress.current || '...'}</strong></span>
                <span>{commentProgress.done} / {commentProgress.total} 筆</span>
              </div>
              <div style={{ background: '#e2e8f0', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                <div style={{
                  background: '#3b82f6',
                  height: '100%',
                  width: `${Math.round(commentProgress.done / commentProgress.total * 100)}%`,
                  transition: 'width 0.3s ease',
                }} />
              </div>
            </div>
          )}
          {!!pendingCommentRequestId && !commentSubmitting && (
            <div style={{ margin: '10px 0 4px', fontSize: 12, color: '#b45309' }}>
              串流已中斷，正在嘗試從後端恢復結果，完成前將暫時鎖定提交按鈕。
            </div>
          )}

          <div className="stage-nav" style={{ marginTop: 16 }}>
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(4)}>上一步</button>
            {toComment.length > 0
              ? <button type="button" className={`submit-btn submit-btn--step${(commentSubmitting || !!pendingCommentRequestId) ? ' loading' : ''}`}
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={!commentColumn || commentSubmitting || !!pendingCommentRequestId}
                  onClick={handleAddComments}>
                  {(commentSubmitting || !!pendingCommentRequestId)
                    ? commentProgress
                      ? `處理中 ${commentProgress.done}/${commentProgress.total}...`
                      : pendingCommentRequestId
                        ? '恢復中...'
                        : '提交中...'
                    : `批次添加評論（${toComment.length} 筆）`}
                </button>
              : null}
            <button type="button" className="btn-ghost btn-ghost--step" onClick={() => setStep(6)}>
              {toTransition.length > 0 ? `切換狀態 (${toTransition.length} 筆) →` : '跳過 →'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 6: 切換狀態 ── */}
      {step === 6 && (
        <div className="section-card">
          <h2 className="section-title">Step 6 — 切換狀態（{toTransition.length} 筆）</h2>

          {toTransition.length === 0
            ? <div className="alert-info">目前無需切換狀態的 Issue（可能尚未添加評論，或已全部完成）。</div>
            : <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 12px' }}>
                使用後端 <code>JIRA_TRANSITION_ID</code> 批次切換以下 Issue 狀態
              </p>}

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
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={transitionSubmitting} onClick={handleTransition}>
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

      </> // end QA mode
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
            setTrackedIssues([])
            setStep(1)
          }}
        />
      )}

    </div>
  )
}

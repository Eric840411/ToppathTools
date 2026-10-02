import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ModelSelector } from '../components/ModelSelector'
import { acquireAttachmentLease, uploadJiraAttachment, type UploadedAttachment } from '../lib/jiraAttachmentUpload'
import { aiContextFor, buildAiCommentRawText, getField, validateCommentSections } from '../features/batch-comment/comment-text'
import { isCommentPendingStage, MEEGLE_ID_COLUMN, parseMeegleIdCell } from '../../shared/meegle-comment-rules'
import { newStepId } from '../features/uat/step-model'
import './MeegleBatchCreateTab.css'
import './MeegleBatchCommentTab.css'

/**
 * Meegle 批量評論（Jira 頁「Meegle 評論」分頁）。取代 Jira 批量評論，Sheet 不變。
 * 版面：CodeX 2026-10-02 設計圖（使用者確認，選 B：不逐列確認，只有遠端被改過的列要確認）。
 * ① 讀取與選列 → ② 欄位與身分 → ③ 逐列預覽 → ④ 送出結果。
 *
 * - 每列送出做的事、防重送、覆寫保護都在後端（server/meegle-comment-run.ts），這裡只負責組內容與顯示
 * - AI 在③預覽時跑（docs/decisions.md）；送出的是畫面上最後的內容。手改正文後舊分析標「需重新分析」，晚回的 AI 結果不蓋新稿
 * - Sheet 文字規則（AI 原文、環境推導、五區塊檢查）跟 Jira 批量評論共用 src/features/batch-comment/comment-text.ts
 * 設計與踩坑：docs/features/28-meegle.md「28c」
 */

type Rec = Record<string, string> & { _rowIndex: number }
type Phase = 'none' | 'creating' | 'done' | 'failed' | 'unknown' | 'skipped'
type StepInfo = { step: string; phase: Phase; message: string | null; attemptAt: number | null; name?: string }
type Att = UploadedAttachment & { error?: string; manual?: boolean }
type RemoteState = 'empty' | 'same' | 'changed' | 'has-content'
type Identity = { name: string; status: string; email?: string; label?: string; message?: string; candidates?: string[] }
type Previous = { batchId: string; workItemId: string; sheetRow: number; summary?: string; mine: boolean; hasPayload?: boolean; steps: StepInfo[] }

type Item = {
  rowIndex: number; workItemId: string; summary: string; person: string; asEmail: string
  text: string; commentText: string; images: Att[]; videos: Att[]; attError: string
  /** 使用者手改過評論 → 之後改測試說明（含 AI 整理）不再自動同步評論 */
  commentEdited: boolean
  /** 附件有沒載到的，使用者明確勾「不帶這些附件送出」才放行（CodeX review 64f53aa [P1]：原本失敗的附件直接消失、照樣送） */
  skipMissingAtt: boolean
  /** 這一列的附件正在（重新）載入 */
  attLoading: boolean
  /** queued＝開了 AI 但還沒輪到：跟 running 一樣不能送（CodeX review 64f53aa [P2]：原本排隊中的列會直接送原文） */
  ai: 'idle' | 'queued' | 'running' | 'done' | 'error'; aiError: string; aiFormatted: boolean
  review: string | null; reviewStale: boolean
  remote: { status: 'idle' | 'loading' | 'ok' | 'error'; state?: RemoteState; hash?: string; current?: string; error?: string }
  confirmHash: string | null
  /** 每次手改正文 +1；AI 回來時版本不同就不套用（晚回的舊結果不能蓋新稿） */
  rev: number
}
type Result = { rowIndex: number; workItemId: string; summary: string; batchId: string; steps: StepInfo[]; error?: string; claim?: string }

const ICON_PATHS = {
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1',
  search: 'M7 2.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM10.3 10.3l3.2 3.2',
  warn: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2',
  doc: 'M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5',
  chat: 'M2.5 3h11v7.5h-6l-3 2.5v-2.5h-2z',
  play: 'M5 3.5l7 4.5-7 4.5z',
  edit: 'M10.5 2.5l3 3-7.5 7.5h-3v-3z',
  upload: 'M8 11V3M4.5 6L8 2.5 11.5 6M3 13.5h10',
  close: 'M4 4l8 8M12 4l-8 8',
  refresh: 'M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3',
  check: 'M3.5 8.5l3 3 6-7',
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

const JIRA_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/
const STEP_LABEL: Record<string, string> = { desc: '覆寫測試說明', comment: '評論', review: 'AI 分析', writeback: 'Sheet 回填' }
const stepLabel = (s: string, name?: string) => STEP_LABEL[s] ?? (s.startsWith('video:') ? `影片${name ? ` ${name}` : ''}` : s)
const PHASE_TEXT: Record<Phase, string> = { none: '未執行', creating: '處理中', done: '完成', failed: '失敗', unknown: '待確認', skipped: '略過' }

/**
 * 評論預設內容＝測試說明的內容（使用者 10/02：評論跟測試說明輸出一樣，不要另外加「QA 已更新測試頁」那句）。
 * 之後若不再覆寫測試說明、只留評論，評論本身就是完整內容。
 */
function defaultComment(text: string): string {
  return text
}

const rowDone = (steps: StepInfo[]) => steps.length > 0 && steps.every(s => s.phase === 'done' || s.phase === 'skipped')

export function MeegleBatchCommentTab({ initialSheetUrl, canAiFormat, canAiReview }: { initialSheetUrl: string; canAiFormat: boolean; canAiReview: boolean }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)

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
  const [needsPreselect, setNeedsPreselect] = useState(false)
  /** 單子網址前綴（後端查空間簡稱／類型名稱）；查不到就只顯示單號、不放連結 */
  const [detailBase, setDetailBase] = useState('')

  // ② 欄位與身分
  const [commentColumn, setCommentColumn] = useState('')
  const [attachmentColumn, setAttachmentColumn] = useState('')
  const [personColumn, setPersonColumn] = useState('')
  const [useAiFormat, setUseAiFormat] = useState(false)
  const [useAiReview, setUseAiReview] = useState(false)
  const [promptId, setPromptId] = useState('default')
  const [prompts, setPrompts] = useState<Array<{ id: string; name: string }>>([])
  const [model, setModel] = useState('gemini')
  const [identities, setIdentities] = useState<Identity[]>([])
  const [selfOk, setSelfOk] = useState<boolean | null>(null)
  const [selfEmail, setSelfEmail] = useState('')
  const [identityLoading, setIdentityLoading] = useState(false)

  // ③ 逐列預覽
  const [items, setItems] = useState<Item[]>([])
  const [current, setCurrent] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const [prepError, setPrepError] = useState('')

  // ④ 送出
  const [batchId, setBatchId] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [progressDismissed, setProgressDismissed] = useState(false)
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})
  const [candidates, setCandidates] = useState<{ workItemId: string; batchId: string; step: string; list: Array<{ commentId: string; content: string; createdAt: string; fileUrl: string }> | null; error: string } | null>(null)

  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    api<{ detailBase: string }>('/api/meegle/comment/meta', {}).then(j => setDetailBase(j.detailBase)).catch(() => {})
    fetch('/api/gemini/prompts').then(r => r.json()).then((d: { prompts?: Array<{ id: string; name: string }> }) => {
      if (d.prompts) setPrompts(d.prompts.map(p => ({ id: p.id, name: p.name })))
    }).catch(() => {})
  }, [])

  // ── ① 讀 Sheet ──
  const rows = useMemo(() => {
    if (!records) return []
    const ids = new Map<string, number>()
    for (const r of records) { const id = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN)); if (id) ids.set(id, (ids.get(id) ?? 0) + 1) }
    return records.map(r => {
      const workItemId = parseMeegleIdCell(getField(r, MEEGLE_ID_COLUMN))
      const jiraKey = !workItemId ? (String(Object.entries(r).find(([k, v]) => k !== '_rowIndex' && typeof v === 'string' && JIRA_KEY_RE.test(v))?.[1] ?? '').match(JIRA_KEY_RE)?.[0] ?? '') : ''
      const prev = workItemId ? previous.find(p => p.workItemId === workItemId) : undefined
      const stage = getField(r, '處理階段')
      const block = !workItemId ? '缺 Meegle 單號，不送出' : (ids.get(workItemId) ?? 0) > 1 ? '重複單號：同一張單出現在兩列，先修 Sheet' : ''
      const commented = !!prev && prev.steps.some(s => s.step === 'comment' && s.phase === 'done')
      return { rec: r, rowIndex: r._rowIndex, workItemId, jiraKey, summary: getField(r, '摘要') || getField(r, '標題'), stage, block, prev, commented }
    }).filter(x => x.workItemId || x.jiraKey)
  }, [records, previous])

  async function loadSheet() {
    if (!sheetUrl.trim()) return
    setLoading(true); setLoadError('')
    try {
      const j = await api<{ records: Rec[]; headers?: string[] }>('/api/lark/sheets/records', { sheetUrl: sheetUrl.trim(), includeCreated: true })
      const prev = await api<{ rows: Previous[] }>('/api/meegle/comment/previous', { sheetUrl: sheetUrl.trim() }).catch(() => ({ rows: [] as Previous[] }))
      setRecords(j.records); setLoadedUrl(sheetUrl.trim()); setPrevious(prev.rows)
      const hs = (j.headers?.length ? j.headers : Object.keys(j.records[0] ?? {})).filter(h => h && h !== '_rowIndex' && !h.endsWith('__url'))
      setHeaders(hs)
      // 每次讀 Sheet 換新批次（批次綁來源 Sheet）
      setBatchId(''); setItems([]); setResults([])
      // 欄位預設：沿用 Jira 批量評論常見欄名
      setCommentColumn(c => c && hs.includes(c) ? c : (hs.find(h => /驗證結果|評論/.test(h)) ?? ''))
      setAttachmentColumn(c => c && hs.includes(c) ? c : (hs.find(h => /附件|截圖/.test(h)) ?? ''))
      setPersonColumn(c => c && hs.includes(c) ? c : (hs.find(h => /填寫人|回報者|回報人/.test(h)) ?? ''))
      // 上次沒收尾的（待確認、只剩回填）接回 ④
      setResults(prev.rows.filter(p => p.mine && !rowDone(p.steps) && !p.steps.some(s => s.phase === 'creating'))
        .map(p => ({ rowIndex: p.sheetRow, workItemId: p.workItemId, summary: p.summary ?? '', batchId: p.batchId, steps: p.steps })))
      setNeedsPreselect(true)
    } catch (e) { setLoadError((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => {
    if (!needsPreselect || !records) return
    // 預設勾選：處理階段空白或「已開單…」、沒被擋、沒評論過（跟 Jira 批量評論同一個意思）
    setSelected(new Set(rows.filter(r => !r.block && !r.commented && isCommentPendingStage(r.stage)).map(r => r.rowIndex)))
    setNeedsPreselect(false)
  }, [needsPreselect, records, rows])

  const visibleRows = rows.filter(r => !query.trim() || `${r.workItemId} ${r.summary} ${r.jiraKey}`.toLowerCase().includes(query.trim().toLowerCase()))
  const chosen = rows.filter(r => selected.has(r.rowIndex) && !r.block)

  // ── ② 身分 ──
  const personOf = useCallback((r: Rec) => personColumn ? getField(r, personColumn).trim() : '', [personColumn])
  useEffect(() => {
    if (step !== 2) return
    const names = [...new Set(chosen.map(r => personOf(r.rec)).filter(Boolean))]
    setIdentityLoading(true)
    api<{ self: boolean; selfEmail: string; results: Identity[] }>('/api/meegle/comment/identities', { names })
      .then(j => { setIdentities(j.results); setSelfOk(j.self); setSelfEmail(j.selfEmail) })
      .catch(() => { setIdentities([]); setSelfOk(null) })
      .finally(() => setIdentityLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, personColumn, selected])
  const identityFor = (name: string) => identities.find(i => i.name.toLowerCase() === name.toLowerCase())
  /** 這一列能用的身分：沒填人＝自己；填了人要 ok 才行 */
  const rowIdentity = (name: string): { ok: boolean; email: string; label: string; message?: string } => {
    if (!name) return selfOk ? { ok: true, email: '', label: '我自己' } : { ok: false, email: '', label: '我自己', message: '你還沒綁定 Meegle' }
    const id = identityFor(name)
    if (!id) return { ok: false, email: '', label: name, message: '查詢中' }
    return id.status === 'ok' ? { ok: true, email: id.email ?? '', label: id.label ?? name } : { ok: false, email: id.email ?? '', label: id.label ?? name, message: id.message ?? id.status }
  }
  const blockedPeople = [...new Set(chosen.map(r => personOf(r.rec)))].filter(n => !rowIdentity(n).ok)

  /**
   * 不要每次進 ③ 都重跑 AI（使用者 10/02：按上一步再回來又燒一次 AI）：
   * - 設定（選的列、欄位、AI 開關、Prompt、模型）沒變 → 直接回到 ③，不重建（手改的內容也保留）
   * - 設定變了要重建 → AI 結果按「輸入」快取：同一列、同樣原文與設定就沿用上次結果，不打 API
   * - 只有按「重試」「重新分析」或原文變了才會真的再跑
   */
  const previewKeyRef = useRef('')
  const aiCacheRef = useRef(new Map<string, { text: string; review: string | null }>())
  // 同一列同時只跑一個附件請求（CodeX 10/02）：疊兩個時先回來的會提早把 attLoading 清掉、解除送出限制
  // 重建預覽（例如換了附件欄）就換一組：舊請求晚回來不蓋新清單、也不擋新請求
  const attInflightRef = useRef(new Set<number>())
  const previewKey = JSON.stringify({ rows: chosen.map(r => r.rowIndex), commentColumn, attachmentColumn, personColumn, useAiFormat, useAiReview, promptId, model, loadedUrl })
  function goPreview() {
    if (items.length && previewKeyRef.current === previewKey) { setStep(3); return }
    void buildPreview()
  }

  // ── ③ 建預覽：附件預載 → 逐列讀遠端 → 逐列跑 AI ──
  async function buildPreview() {
    previewKeyRef.current = previewKey
    attInflightRef.current = new Set()
    setPreparing(true); setPrepError('')
    const recs = chosen
    const base: Item[] = recs.map(r => {
      const text = (getField(r.rec, commentColumn) ?? '').replace(/\r\n/g, '\n')
      const id = rowIdentity(personOf(r.rec))
      return {
        rowIndex: r.rowIndex, workItemId: r.workItemId!, summary: r.summary, person: personOf(r.rec), asEmail: id.email,
        text, commentText: defaultComment(text), commentEdited: false, images: [], videos: [], attError: '', skipMissingAtt: false, attLoading: !!attachmentColumn,
        ai: useAiFormat || useAiReview ? 'queued' : 'idle', aiError: '', aiFormatted: false, review: null, reviewStale: false,
        remote: { status: 'idle' }, confirmHash: null, rev: 0,
      }
    })
    setItems(base); setCurrent(0); setStep(3)
    // 附件：沿用 Jira 批量評論的預載（Lark Drive／Google Drive／儲存格圖片／插入的附件）。
    // **一列一個請求、同時 2 列**（使用者 10/02：預覽時附件可能整批載入失敗）——原本整批一個請求，
    // 伺服器重啟、或某一列的大影片拖太久，整批一起失敗；改成逐列，壞一列不影響別列，也能單列重新載入
    setPreparing(false)
    const attQueue = attachmentColumn ? [...base] : []
    await Promise.all(Array.from({ length: Math.min(2, attQueue.length) }, async () => { for (let it = attQueue.shift(); it; it = attQueue.shift()) await loadAttachments(it.rowIndex) }))
    // 讀 Meegle 現況：同時最多 3 張（一張一個 CLI 呼叫，24 列一張一張讀要一分多鐘）
    const queue = [...base]
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { for (let it = queue.shift(); it; it = queue.shift()) await readRemote(it.workItemId) }))
    if (useAiFormat || useAiReview) for (const it of base) await runAi(it.rowIndex, useAiFormat, useAiReview)
  }

  /** 載入（或重新載入）一列的附件。失敗原因逐個列出來，要使用者明確略過或重試 */
  async function loadAttachments(rowIndex: number) {
    const r = records?.find(x => x._rowIndex === rowIndex)
    const inflight = attInflightRef.current
    if (!r || !attachmentColumn || inflight.has(rowIndex)) return
    inflight.add(rowIndex)
    const stale = () => attInflightRef.current !== inflight
    setItems(prev => prev.map(it => it.rowIndex === rowIndex ? { ...it, attLoading: true } : it))
    const colIdx = headers.indexOf(attachmentColumn)
    let letter = ''
    for (let i = colIdx + 1; i > 0; i = Math.floor((i - 1) / 26)) letter = String.fromCharCode(65 + (i - 1) % 26) + letter
    const src = r[`${attachmentColumn}__url`] || getField(r, attachmentColumn)
    const groups = [{ rowIndex, urls: src ? src.split(/[\n,]/).map(x => x.trim()).filter(Boolean) : [] }]
    try {
      const d = await api<{ result?: Array<{ rowIndex: number; attachments: Att[] }> }>('/api/attachments/prefetch', { groups, larkSheetContext: colIdx >= 0 ? { sheetUrl: loadedUrl, columnLetter: letter } : undefined })
      if (stale()) return
      const atts = d.result?.find(g => g.rowIndex === rowIndex)?.attachments ?? []
      const ok = atts.filter(x => x.cacheId && !x.error)
      const bad = atts.filter(x => x.error || !x.cacheId)
      setItems(prev => prev.map(it => it.rowIndex !== rowIndex ? it : {
        ...it, attLoading: false, skipMissingAtt: false,
        // 重新載入時保留使用者手動加的附件（不在這次結果裡的 cacheId）
        images: [...ok.filter(x => x.isImage), ...it.images.filter(x => x.manual)],
        videos: [...ok.filter(x => !x.isImage), ...it.videos.filter(x => x.manual)],
        attError: bad.length ? `${bad.length} 個附件沒載到：${bad.map(x => `${x.filename}${x.error ? `（${x.error}）` : ''}`).join('、').slice(0, 300)}` : '',
      }))
    } catch (e) {
      if (stale()) return
      setItems(prev => prev.map(it => it.rowIndex === rowIndex ? { ...it, attLoading: false, skipMissingAtt: false, attError: `附件載入失敗：${(e as Error).message}` } : it))
    } finally {
      inflight.delete(rowIndex)
    }
  }

  async function readRemote(workItemId: string) {
    setItems(prev => prev.map(it => it.workItemId === workItemId ? { ...it, remote: { status: 'loading' } } : it))
    try {
      const j = await api<{ current: string; hash: string; state: RemoteState }>('/api/meegle/comment/remote', { workItemId })
      setItems(prev => prev.map(it => it.workItemId === workItemId ? {
        ...it, remote: { status: 'ok', state: j.state, hash: j.hash, current: j.current },
        // 確認綁定遠端版本：版本變了，舊的確認不算數
        confirmHash: it.confirmHash === j.hash ? it.confirmHash : null,
      } : it))
    } catch (e) {
      setItems(prev => prev.map(it => it.workItemId === workItemId ? { ...it, remote: { status: 'error', error: (e as Error).message } } : it))
    }
  }

  async function runAi(rowIndex: number, format: boolean, review: boolean, force = false) {
    const it = itemsRef.current.find(x => x.rowIndex === rowIndex)
    const rec = records?.find(r => r._rowIndex === rowIndex)
    if (!it || !rec || (!format && !review)) return
    const startRev = it.rev
    setItems(prev => prev.map(x => x.rowIndex === rowIndex ? { ...x, ai: 'running', aiError: '' } : x))
    try {
      const raw = format ? buildAiCommentRawText(rec, commentColumn) : it.text
      const cacheKey = JSON.stringify({ rowIndex, raw, format, review, promptId, model })
      const cached = force ? undefined : aiCacheRef.current.get(cacheKey)
      const j = cached ?? await api<{ text: string; review: string | null }>('/api/meegle/comment/ai', {
        rawText: raw, summary: it.summary, format, review, promptId, modelSpec: model, ...aiContextFor(rec, it.text),
      })
      aiCacheRef.current.set(cacheKey, { text: j.text, review: j.review })
      setItems(prev => prev.map(x => {
        if (x.rowIndex !== rowIndex) return x
        // 這段期間使用者手改過 → AI 結果不套用（不蓋新稿），只把狀態收掉
        if (x.rev !== startRev) return { ...x, ai: 'done', reviewStale: x.review != null || review }
        const text = format ? j.text : x.text
        return { ...x, ai: 'done', text, aiFormatted: format || x.aiFormatted, commentText: format && !x.commentEdited ? defaultComment(text) : x.commentText, review: review ? j.review : x.review, reviewStale: false }
      }))
    } catch (e) {
      // AI 失敗要明示，不默默當成功（CodeX）
      setItems(prev => prev.map(x => x.rowIndex === rowIndex ? { ...x, ai: 'error', aiError: (e as Error).message } : x))
    }
  }

  const editItem = (rowIndex: number, patch: Partial<Item>, bumpRev = false) =>
    setItems(prev => prev.map(x => x.rowIndex === rowIndex ? { ...x, ...patch, ...(bumpRev ? { rev: x.rev + 1, reviewStale: x.review != null ? true : x.reviewStale } : {}) } : x))

  async function addAttachment(rowIndex: number, file: File) {
    const r = await uploadJiraAttachment(file)
    if (!r.ok) { editItem(rowIndex, { attError: r.message }); return }
    setItems(prev => prev.map(x => x.rowIndex !== rowIndex ? x : r.data.isImage ? { ...x, images: [...x.images, { ...r.data, manual: true }] } : { ...x, videos: [...x.videos, { ...r.data, manual: true }] }))
  }

  /** 這一列能不能送（「可送出 N 列」排除衝突、處理中、驗證失敗——CodeX） */
  const itemIssue = (it: Item): string => {
    if (!rowIdentity(it.person).ok) return '身分不能用'
    if (it.remote.status !== 'ok') return it.remote.status === 'error' ? '讀不到 Meegle 現況' : '讀取 Meegle 中'
    if (it.remote.state === 'changed' && it.confirmHash !== it.remote.hash) return '遠端已被修改，需確認'
    if (it.ai === 'running' || it.ai === 'queued') return it.ai === 'queued' ? 'AI 排隊中' : 'AI 處理中'
    if (it.attLoading) return '附件載入中'
    if (it.attError && !it.skipMissingAtt) return '有附件沒載到'
    if (!it.text.trim()) return '測試說明是空的'
    if (!it.commentText.trim()) return '評論是空的'
    return ''
  }
  const sendable = items.filter(it => !itemIssue(it))

  // ── ④ 送出 ──
  async function submit() {
    const list = sendable
    if (!list.length) return
    const id = batchId || newStepId()
    if (!batchId) setBatchId(id)
    setStep(4); setRunning(true); setProgress({ done: 0, total: list.length }); setProgressDismissed(false)
    const lease = await acquireAttachmentLease(list.flatMap(it => [...it.images, ...it.videos].map(a => a.cacheId)))
    try {
      for (const it of list) {
        lease.renew()
        const row = rows.find(r => r.rowIndex === it.rowIndex)
        let res: Result
        try {
          const j = await api<{ claim: { kind: string }; steps: StepInfo[] }>('/api/meegle/comment/row', {
            batchId: id, sheetUrl: loadedUrl, sheetRow: it.rowIndex, summary: it.summary, workItemId: it.workItemId, asEmail: it.asEmail,
            description: it.text, images: it.images.map(a => ({ cacheId: a.cacheId, name: a.filename })),
            commentText: it.commentText, videos: it.videos.map(a => ({ cacheId: a.cacheId, name: a.filename })),
            reviewText: useAiReview && it.review ? it.review : null,
            expectedRemoteHash: it.remote.hash, confirmedRemoteHash: it.confirmHash,
            allowRepeat: !!row?.commented,
          })
          res = { rowIndex: it.rowIndex, workItemId: it.workItemId, summary: it.summary, batchId: id, steps: j.steps, claim: j.claim.kind }
        } catch (e) {
          // 請求本身失敗：伺服器那邊可能已經做了，畫面標待確認（後端紀錄是準的，重整後會接回）
          res = { rowIndex: it.rowIndex, workItemId: it.workItemId, summary: it.summary, batchId: id, steps: [], error: (e as Error).message }
        }
        setResults(prev => [...prev.filter(r => r.workItemId !== it.workItemId), res])
        setProgress(p => ({ ...p, done: p.done + 1 }))
      }
    } finally {
      lease.release()
      setRunning(false)
      void api('/api/meegle/comment/finish', { batchId: id, sheetUrl: loadedUrl }).catch(() => {})
    }
  }

  async function rowAction(r: Result, kind: 'writeback' | 'resolve-done' | 'resolve-failed', stepName = '') {
    const k = `${r.workItemId}:${kind}`
    setRowBusy(b => ({ ...b, [k]: true }))
    try {
      const j = kind === 'writeback'
        ? await api<{ steps: StepInfo[] }>('/api/meegle/comment/row/writeback', { batchId: r.batchId, rowKey: r.workItemId })
        : await api<{ steps: StepInfo[] }>('/api/meegle/comment/row/resolve', { batchId: r.batchId, rowKey: r.workItemId, step: stepName, outcome: kind === 'resolve-done' ? 'done' : 'failed' })
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, steps: j.steps, error: undefined } : x))
      setCandidates(null)
    } catch (e) {
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, error: (e as Error).message } : x))
    } finally { setRowBusy(b => ({ ...b, [k]: false })) }
  }

  async function showCandidates(r: Result, stepName: string) {
    const it = items.find(x => x.workItemId === r.workItemId)
    const content = stepName === 'comment' ? it?.commentText ?? '' : stepName === 'review' ? `AI 完整性分析\n\n${(it?.review ?? '').trim()}` : ''
    setCandidates({ workItemId: r.workItemId, batchId: r.batchId, step: stepName, list: null, error: '' })
    try {
      const j = await api<{ candidates: Array<{ commentId: string; content: string; createdAt: string; fileUrl: string }> }>('/api/meegle/comment/row/candidates', { batchId: r.batchId, rowKey: r.workItemId, step: stepName, content })
      setCandidates(c => c && c.workItemId === r.workItemId ? { ...c, list: j.candidates } : c)
    } catch (e) { setCandidates(c => c && c.workItemId === r.workItemId ? { ...c, error: (e as Error).message, list: [] } : c) }
  }

  /** 接著做還沒做的步驟：後端用上次存的內容跑，不需要前端草稿 */
  async function continueRow(r: Result) {
    setRowBusy(b => ({ ...b, [`${r.workItemId}:continue`]: true }))
    try {
      const j = await api<{ claim: { kind: string }; steps: StepInfo[] }>('/api/meegle/comment/row/continue', { batchId: r.batchId, rowKey: r.workItemId })
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, steps: j.steps, claim: j.claim.kind, error: undefined } : x))
    } catch (e) {
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, error: (e as Error).message } : x))
    } finally { setRowBusy(b => ({ ...b, [`${r.workItemId}:continue`]: false })) }
  }

  async function resend(r: Result) {
    const it = items.find(x => x.workItemId === r.workItemId)
    if (!it) return
    setBatchId(r.batchId)
    setRowBusy(b => ({ ...b, [`${r.workItemId}:resend`]: true }))
    try {
      const j = await api<{ claim: { kind: string }; steps: StepInfo[] }>('/api/meegle/comment/row', {
        batchId: r.batchId, sheetUrl: loadedUrl, sheetRow: it.rowIndex, summary: it.summary, workItemId: it.workItemId, asEmail: it.asEmail,
        description: it.text, images: it.images.map(a => ({ cacheId: a.cacheId, name: a.filename })), commentText: it.commentText,
        videos: it.videos.map(a => ({ cacheId: a.cacheId, name: a.filename })), reviewText: useAiReview && it.review ? it.review : null,
        expectedRemoteHash: it.remote.hash, confirmedRemoteHash: it.confirmHash, allowRepeat: !!rows.find(x => x.rowIndex === it.rowIndex)?.commented,
      })
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, steps: j.steps, claim: j.claim.kind, error: undefined } : x))
    } catch (e) {
      setResults(prev => prev.map(x => x.workItemId === r.workItemId ? { ...x, error: (e as Error).message } : x))
    } finally { setRowBusy(b => ({ ...b, [`${r.workItemId}:resend`]: false })) }
  }

  // ── 畫面 ──
  const STEPS = [
    { n: 1, label: '讀取與選列' },
    { n: 2, label: '欄位與身分' },
    { n: 3, label: '逐列預覽' },
    { n: 4, label: '送出結果' },
  ] as const
  const canGo = (n: number) => n === 1 || (n === 2 ? chosen.length > 0 : n === 3 ? items.length > 0 : results.length > 0)
  const tally = {
    ok: results.filter(r => rowDone(r.steps)).length,
    pending: results.filter(r => r.steps.some(s => s.phase === 'unknown') || (r.error && !r.steps.length)).length,
    bad: results.filter(r => r.steps.some(s => s.phase === 'failed')).length,
  }
  const cur = items[current]
  const curIssue = cur ? itemIssue(cur) : ''
  const missing = cur ? validateCommentSections(cur.text) : []

  const statusOf = (it: Item): { cls: string; text: string } => {
    if (it.remote.status === 'ok' && it.remote.state === 'changed' && it.confirmHash !== it.remote.hash) return { cls: 'bad', text: '遠端變更' }
    if (it.ai === 'running' || it.ai === 'queued' || it.remote.status === 'loading' || it.remote.status === 'idle' || it.attLoading) return { cls: 'info', text: it.ai === 'running' ? 'AI 處理中' : it.ai === 'queued' ? 'AI 排隊中' : it.attLoading ? '附件載入中' : '讀取中' }
    if (itemIssue(it)) return { cls: 'warn', text: '待處理' }
    if (validateCommentSections(it.text).length) return { cls: 'pending', text: '待補資料' }
    return { cls: 'ok', text: '可送出' }
  }

  return (
    <div className="mb-page mc-page">
      <section className="mb-card mb-shell">
        <header className="mb-shell-head">
          <h2 className="mb-shell-title">Meegle 批量評論</h2>
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

        {/* ── ① 讀取與選列 ── */}
        {step === 1 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">讀取與選列</h3>
            <div className="mc-loadbar">
              <input className="mb-input" placeholder="https://xxx.larksuite.com/wiki/…?sheet=…" value={sheetUrl}
                onChange={e => setSheetUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void loadSheet() }} />
              <button type="button" className="mb-btn mb-btn--primary" disabled={loading || !sheetUrl.trim()} onClick={() => void loadSheet()}>
                <Icon name="link" /> {loading ? '讀取中…' : records ? '重新讀取' : '讀取 Sheet'}
              </button>
            </div>
            {loadError && <div className="mb-alert mb-alert--bad">{loadError}</div>}
            <p className="mb-hint">用開單時回填的「{MEEGLE_ID_COLUMN}」欄認單。只有 Jira 單號的列不送；處理階段已有值、或之前評論過的列預設不勾（勾了＝再送一輪）。</p>
            {records && (
              <>
                <div className="mb-toolbar">
                  <span className="mb-search-wrap"><Icon name="search" /><input className="mb-input" placeholder="搜尋單號或摘要…" value={query} onChange={e => setQuery(e.target.value)} /></span>
                  <span className="mb-muted">已勾選 <b>{chosen.length}</b> 列</span>
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
                          <td>{r.workItemId ? (detailBase ? <a href={`${detailBase}${r.workItemId}`} target="_blank" rel="noreferrer">#{r.workItemId}</a> : `#${r.workItemId}`) : <span className="mb-muted">{r.jiraKey}</span>}</td>
                          <td className="mb-name">{r.summary || <span className="mb-muted">（沒有摘要）</span>}</td>
                          <td>{r.stage || <span className="mb-muted">—</span>}</td>
                          <td>
                            {r.block ? <span className="mb-badge mb-badge--bad">{r.block.startsWith('缺') ? '缺 Meegle 單號' : '重複單號'}</span>
                              : r.commented ? <span className="mb-badge mb-badge--pending" title="之前已評論過；勾選＝再送一輪">已評論</span>
                              : r.prev?.steps.some(s => s.phase === 'unknown') ? <span className="mb-badge mb-badge--warn">上次待確認</span>
                              : <span className="mb-badge mb-badge--ok">可評論</span>}
                          </td>
                        </tr>
                      ))}
                      {!visibleRows.length && <tr><td colSpan={6} className="mb-empty">這份 Sheet 沒有帶 Meegle 單號或 Jira 單號的列</td></tr>}
                    </tbody>
                  </table>
                </div>
                {rows.some(r => r.block?.startsWith('重複')) && <div className="mb-alert mb-alert--warn"><Icon name="warn" /> 有兩列指到同一張 Meegle 單，為了不寫錯列，這幾列先不送。請先修 Sheet。</div>}
              </>
            )}
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" disabled={loading || !records} onClick={() => void loadSheet()}><Icon name="refresh" /> 重新讀取</button>
              <button type="button" className="mb-btn mb-btn--primary" disabled={!chosen.length} onClick={() => setStep(2)}>下一步</button>
            </div>
          </div>
        )}

        {/* ── ② 欄位與身分 ── */}
        {step === 2 && (
          <div className="mb-pane mb-pane--narrow">
            <h3 className="mb-pane-title">欄位與身分</h3>
            <label className="mb-field"><span>評論內容欄 <em className="mb-req">*</em></span>
              <select className="mb-select" value={commentColumn} onChange={e => setCommentColumn(e.target.value)}>
                <option value="">— 選擇欄位 —</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <p className="mb-hint">內容會<b>整格覆寫</b> Meegle「測試頁 → 測試說明」（五區塊跟 Jira 評論同一個格式）。</p>
            <label className="mb-field"><span>附件欄（選填）</span>
              <select className="mb-select" value={attachmentColumn} onChange={e => setAttachmentColumn(e.target.value)}>
                <option value="">— 不上傳附件 —</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <p className="mb-hint">圖片嵌進測試說明；影片每支各留一則評論附件。</p>
            <label className="mb-field"><span>填寫人欄（選填，以該列填寫人的身分送出）</span>
              <select className="mb-select" value={personColumn} onChange={e => setPersonColumn(e.target.value)}>
                <option value="">— 全部用我自己的身分 —</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <div className="mc-identity">
              {identityLoading ? <span className="mb-muted">檢查身分中…</span> : (
                <>
                  {!personColumn && <div className={`mc-id ${selfOk ? 'is-ok' : 'is-bad'}`}><Icon name={selfOk ? 'check' : 'warn'} /> {selfOk ? '我自己：已綁定 Meegle' : '你還沒綁定 Meegle（側欄「個人帳號」）'}</div>}
                  {personColumn && [...new Set(chosen.map(r => personOf(r.rec)))].map(n => {
                    const id = rowIdentity(n)
                    return <div key={n || '_self'} className={`mc-id ${id.ok ? 'is-ok' : 'is-bad'}`}><Icon name={id.ok ? 'check' : 'warn'} /> <b>{n || '（填寫人空白）'}</b>{id.ok ? ` → 用${!id.email || id.email === selfEmail ? '我自己' : ` ${id.label} `}的身分送出` : `：${id.message}`}</div>
                  })}
                </>
              )}
            </div>
            {blockedPeople.length > 0 && <div className="mb-alert mb-alert--warn"><Icon name="warn" /> 有 {blockedPeople.length} 位填寫人不能用（沒綁 Meegle 或沒有「Meegle 批量評論」代理授權），那幾列會被擋下、其他列照常送。</div>}
            {(canAiFormat || canAiReview) && (
              <div className="mc-ai">
                {canAiFormat && <label className="mc-switch"><input type="checkbox" checked={useAiFormat} onChange={e => setUseAiFormat(e.target.checked)} /> AI 整理測試說明（用 Prompt 模板改寫，③ 可再手改）</label>}
                {canAiReview && <label className="mc-switch"><input type="checkbox" checked={useAiReview} onChange={e => setUseAiReview(e.target.checked)} /> AI 完整性分析（另留一則評論）</label>}
                {(useAiFormat || useAiReview) && (
                  <div className="mb-grid2">
                    <label className="mb-field"><span>Prompt 模板</span>
                      <select className="mb-select" value={promptId} onChange={e => setPromptId(e.target.value)}>
                        {prompts.length === 0 ? <option value="default">標準 QA 報告（預設）</option> : prompts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </label>
                    <label className="mb-field"><span>AI 模型</span><ModelSelector value={model} onChange={setModel} /></label>
                  </div>
                )}
              </div>
            )}
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" onClick={() => setStep(1)}>上一步</button>
              <button type="button" className="mb-btn mb-btn--primary" disabled={!commentColumn || preparing} onClick={goPreview}>{preparing ? '準備中…' : '產生預覽'}</button>
            </div>
          </div>
        )}

        {/* ── ③ 逐列預覽 ── */}
        {step === 3 && (
          <div className="mb-pane">
            <div className="mc-overwrite"><Icon name="warn" /> 將整格覆寫測試說明</div>
            <div className="mc-head">
              <h3 className="mb-pane-title">逐列預覽</h3>
              {items.length > 0 && (
                <div className="mc-nav">
                  <span className="mb-muted">當前：{current + 1} / {items.length} 列</span>
                  <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={current === 0} onClick={() => setCurrent(c => c - 1)} aria-label="上一列">‹</button>
                  <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={current >= items.length - 1} onClick={() => setCurrent(c => c + 1)} aria-label="下一列">›</button>
                </div>
              )}
            </div>
            {prepError && <div className="mb-alert mb-alert--warn">{prepError}</div>}
            {items.some(it => it.attError && !it.attLoading) && (
              <div className="mb-alert mb-alert--warn mc-att-banner"><Icon name="warn" /> {items.filter(it => it.attError).length} 列有附件沒載到
                <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => { for (const it of items.filter(x => x.attError && !x.attLoading)) void loadAttachments(it.rowIndex) }}>重新載入失敗的附件</button>
              </div>
            )}
            <div className="mc-preview">
              <aside className="mc-list">
                {items.map((it, i) => {
                  const st = statusOf(it)
                  return (
                    <button type="button" key={it.rowIndex} className={`mc-list-row${i === current ? ' is-on' : ''}`} onClick={() => setCurrent(i)}>
                      <span className="mc-list-no">{String(i + 1).padStart(2, '0')}</span>
                      <span className="mc-list-name">{it.summary || `#${it.workItemId}`}</span>
                      <span className={`mc-dot mc-dot--${st.cls}`}>{st.text}</span>
                    </button>
                  )
                })}
              </aside>
              {cur && (
                <>
                  <section className="mc-panel">
                    <div className="mc-panel-head"><Icon name="doc" /> 測試說明 <span className="mb-muted">#{cur.workItemId}</span>
                      {cur.ai === 'running' && <span className="mb-badge mb-badge--pending">AI 處理中</span>}
                      {cur.aiFormatted && cur.ai !== 'running' && <span className="mb-badge mb-badge--ok">AI 已整理</span>}
                    </div>
                    {cur.ai === 'error' && <div className="mb-alert mb-alert--bad">AI 失敗：{cur.aiError}（內容維持原文，可重試）
                      <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => void runAi(cur.rowIndex, useAiFormat, useAiReview, true)}>重試</button></div>}
                    <textarea className="mc-text" value={cur.text} onChange={e => editItem(cur.rowIndex, { text: e.target.value, ...(cur.commentEdited ? {} : { commentText: defaultComment(e.target.value) }) }, true)} rows={14} aria-label="測試說明內容" />
                    {missing.length > 0 && <div className="mc-missing"><Icon name="warn" /> 格式不完整（仍可送出）：{missing.join('、')}</div>}
                    {cur.images.length > 0 && (
                      <div className="mc-thumbs">
                        {cur.images.map(a => (
                          <figure key={a.cacheId} className="mc-thumb">
                            <img src={`/api/attachments/cache/${a.cacheId}`} alt={a.filename} loading="lazy" />
                            <figcaption>{a.filename}
                              <button type="button" className="mc-x" aria-label={`移除 ${a.filename}`} onClick={() => editItem(cur.rowIndex, { images: cur.images.filter(x => x.cacheId !== a.cacheId) })}><Icon name="close" /></button>
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    )}
                  </section>
                  <section className="mc-panel">
                    <div className="mc-panel-head"><Icon name="chat" /> Comments</div>
                    <textarea className="mc-text mc-text--short" value={cur.commentText} onChange={e => editItem(cur.rowIndex, { commentText: e.target.value, commentEdited: true })} rows={4} aria-label="評論內容" />
                    <div className="mc-sub-head">影片附件
                      <span className="mc-sub-actions">
                        {/* 常駐（使用者 10/02）：Sheet 有附件卻讀成 0 個時不會報錯，沒有這顆就沒地方重抓。只做每列、不做全域——重載會把清單換回 Sheet 版本 */}
                        {attachmentColumn && (
                          <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={cur.attLoading} onClick={() => void loadAttachments(cur.rowIndex)}><Icon name="refresh" /> {cur.attLoading ? '載入中…' : '重新載入附件'}</button>
                        )}
                        <label className="mb-btn mb-btn--small mb-btn--outline mc-upload"><Icon name="upload" /> 新增附件
                          <input type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void addAttachment(cur.rowIndex, f); e.target.value = '' }} />
                        </label>
                      </span>
                    </div>
                    {attachmentColumn && <p className="mb-hint mc-reload-hint">重新載入＝從 Sheet 重抓圖片與影片：預覽時手動移除的會回來，手動新增的保留。</p>}
                    {cur.attLoading && <div className="mb-muted mc-empty">附件載入中…</div>}
                    {!cur.attLoading && cur.videos.length === 0 && <div className="mb-muted mc-empty">沒有影片</div>}
                    {cur.videos.map(a => (
                      <div key={a.cacheId} className="mc-video"><Icon name="play" /><span className="mc-video-name">{a.filename}<small>{(a.size / 1048576).toFixed(1)} MB ・ 已載入</small></span>
                        <button type="button" className="mc-x" aria-label={`移除 ${a.filename}`} onClick={() => editItem(cur.rowIndex, { videos: cur.videos.filter(x => x.cacheId !== a.cacheId) })}><Icon name="close" /></button></div>
                    ))}
                    {cur.attError && (
                      <div className="mc-missing mc-att-error">
                        <span><Icon name="warn" /> {cur.attError}</span>
                        <div className="mc-att-actions">
                          <label className="mc-switch"><input type="checkbox" checked={cur.skipMissingAtt} onChange={e => editItem(cur.rowIndex, { skipMissingAtt: e.target.checked })} /> 不帶這些附件送出</label>
                        </div>
                      </div>
                    )}
                    {useAiReview && (
                      <div className="mc-review">
                        <div className="mc-sub-head">AI 完整性分析
                          <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={cur.ai === 'running'} onClick={() => void runAi(cur.rowIndex, false, true, true)}>{cur.review ? '重新分析' : '分析'}</button>
                        </div>
                        {cur.reviewStale && <div className="mc-missing"><Icon name="warn" /> 內容已變更，需重新分析</div>}
                        {cur.review ? <div className="mc-review-text">{cur.review}</div> : <div className="mb-muted mc-empty">{cur.ai === 'running' ? '分析中…' : '還沒分析（沒有分析就不會留這則）'}</div>}
                      </div>
                    )}
                    {cur.remote.status === 'ok' && cur.remote.state === 'changed' && (
                      <div className="mc-remote">
                        <div className="mc-remote-title"><Icon name="warn" /> 遠端已被修改</div>
                        <div className="mc-remote-cmp">
                          <div><b>原文（Meegle 現在）</b><pre>{cur.remote.current}</pre></div>
                          <div><b>新版（將寫入）</b><pre>{cur.text}</pre></div>
                        </div>
                        <label className="mc-switch"><input type="checkbox" checked={cur.confirmHash === cur.remote.hash}
                          onChange={e => editItem(cur.rowIndex, { confirmHash: e.target.checked ? cur.remote.hash ?? null : null })} /> 確認覆寫</label>
                      </div>
                    )}
                    {cur.remote.status === 'ok' && cur.remote.state === 'has-content' && <div className="mb-hint">Meegle 上這格已有內容（之前不是工具寫的），送出會整格覆寫。</div>}
                    {cur.remote.status === 'error' && <div className="mb-alert mb-alert--bad">{cur.remote.error} <button type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => void readRemote(cur.workItemId)}>重讀</button></div>}
                    {curIssue && cur.remote.status === 'ok' && <div className="mb-hint mb-hint--warn">這一列目前不能送：{curIssue}</div>}
                  </section>
                </>
              )}
            </div>
            <footer className="mb-foot mc-foot">
              <button type="button" className="mb-btn mb-btn--outline mb-btn--wide" onClick={() => setStep(2)}>上一步</button>
              <span className="mb-foot-sum">可送出 <b>{sendable.length}</b> / {items.length} 列</span>
              <button type="button" className="mb-btn mb-btn--primary mb-btn--big" disabled={!sendable.length || running} onClick={() => void submit()}>前往送出</button>
            </footer>
          </div>
        )}

        {/* ── ④ 送出結果 ── */}
        {step === 4 && (
          <div className="mb-pane">
            <h3 className="mb-pane-title">送出結果</h3>
            <div className="mb-chips mb-tally">
              <span className="mb-chip mb-chip--ok is-on">全部完成 <b>{tally.ok}</b></span>
              <span className="mb-chip mb-chip--pending is-on">待確認 <b>{tally.pending}</b></span>
              <span className="mb-chip mb-chip--blocked is-on">有失敗 <b>{tally.bad}</b></span>
            </div>
            <div className="mb-results">
              {results.map(r => {
                const unknownSteps = r.steps.filter(s => s.phase === 'unknown')
                const failed = r.steps.some(s => s.phase === 'failed' && s.step !== 'writeback')
                const wbFailed = r.steps.find(s => s.step === 'writeback')?.phase === 'failed'
                const descNotDone = r.steps.find(s => s.step === 'desc')?.phase !== 'done'
                // 測試說明已完成、沒有待確認／處理中，但還有沒做完的步驟（不含只剩回填）→ 可以接著送
                const canContinue = !descNotDone && !unknownSteps.length && !r.steps.some(s => s.phase === 'creating')
                  && r.steps.some(s => s.step !== 'writeback' && s.step !== 'desc' && (s.phase === 'none' || s.phase === 'failed'))
                return (
                  <div key={`${r.batchId}:${r.workItemId}`} className="mb-result">
                    <div className="mb-result-main">
                      <div className="mb-result-name">{r.summary || `第 ${r.rowIndex} 列`}</div>
                      <div className="mb-result-sub">
                        <span>#{r.workItemId}</span>
                        {r.steps.map(s => (
                          <span key={s.step} className={`mc-step mc-step--${s.phase}`} title={s.message ?? ''}>{stepLabel(s.step, s.name)}：{PHASE_TEXT[s.phase]}</span>
                        ))}
                        {r.claim && r.claim !== 'claimed' && <span className="mb-badge mb-badge--warn">{({ busy: '另一個分頁正在送這張單', unknown: '有步驟待確認，先處理', 'already-commented': '這張單已評論過', 'not-owner': '別人送出的列', 'source-mismatch': '批次的 Sheet 不同' } as Record<string, string>)[r.claim] ?? r.claim}</span>}
                        {r.error && <span className="mb-msg">{r.error}</span>}
                        {r.steps.filter(s => s.message && (s.phase === 'failed' || s.phase === 'unknown')).map(s => <span key={`m-${s.step}`} className="mb-msg">{stepLabel(s.step, s.name)}：{s.message}</span>)}
                      </div>
                    </div>
                    <div className="mb-result-actions">
                      {unknownSteps.filter(s => s.step !== 'desc').map(s => (
                        <button key={s.step} type="button" className="mb-btn mb-btn--small mb-btn--outline" onClick={() => void showCandidates(r, s.step)}>查詢候選（{stepLabel(s.step, s.name)}）</button>
                      ))}
                      {unknownSteps.some(s => s.step === 'desc') && (
                        <>
                          <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[`${r.workItemId}:resolve-done`]} onClick={() => void rowAction(r, 'resolve-done', 'desc')}>測試說明已寫入</button>
                          <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[`${r.workItemId}:resolve-failed`]} onClick={() => void rowAction(r, 'resolve-failed', 'desc')}>沒有寫入</button>
                        </>
                      )}
                      {canContinue && <button type="button" className="mb-btn mb-btn--small mb-btn--primary" disabled={rowBusy[`${r.workItemId}:continue`]} onClick={() => void continueRow(r)}>{rowBusy[`${r.workItemId}:continue`] ? '送出中…' : '繼續送出'}</button>}
                      {failed && descNotDone && !unknownSteps.length && items.some(x => x.workItemId === r.workItemId) && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[`${r.workItemId}:resend`]} onClick={() => void resend(r)}>修正後重送</button>}
                      {failed && descNotDone && !unknownSteps.length && !items.some(x => x.workItemId === r.workItemId) && <span className="mb-msg">測試說明還沒成功：回 ③ 重新預覽這一列再送</span>}
                      {wbFailed && !failed && !unknownSteps.length && <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={rowBusy[`${r.workItemId}:writeback`]} onClick={() => void rowAction(r, 'writeback')}>補寫回</button>}
                      {detailBase && <a className="mb-btn mb-btn--small mb-btn--outline" href={`${detailBase}${r.workItemId}`} target="_blank" rel="noreferrer">開啟</a>}
                    </div>
                    {candidates && candidates.workItemId === r.workItemId && (
                      <div className="mc-cands">
                        <div className="mc-sub-head">待確認候選評論（{stepLabel(candidates.step)}）<button type="button" className="mc-x" aria-label="關閉" onClick={() => setCandidates(null)}><Icon name="close" /></button></div>
                        {candidates.error && <div className="mb-alert mb-alert--bad">{candidates.error}</div>}
                        {!candidates.list && !candidates.error && <div className="mb-muted">查詢中…</div>}
                        {candidates.list?.length === 0 && !candidates.error && <div className="mb-muted">找不到相符的評論。若確定 Meegle 上沒有這則，可按「確定沒有送出」再重送。</div>}
                        {candidates.list?.map(c => <div key={c.commentId} className="mc-cand"><small>{c.createdAt}</small><span>{c.content || (c.fileUrl ? '（附件）' : '（空白）')}</span></div>)}
                        <div className="mb-pane-actions">
                          <button type="button" className="mb-btn mb-btn--small mb-btn--primary" disabled={!candidates.list?.length} onClick={() => void rowAction(r, 'resolve-done', candidates.step)}>就是這則（已送出）</button>
                          <button type="button" className="mb-btn mb-btn--small mb-btn--outline" disabled={!candidates.list} onClick={() => void rowAction(r, 'resolve-failed', candidates.step)}>確定沒有送出</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {!results.length && <div className="mb-muted mb-empty">還沒有送出結果</div>}
            </div>
            <div className="mb-done-line"><span>處理完成 <b>{progress.done}</b> / {progress.total || results.length}</span></div>
            <div className="dashboard-bar-track mb-progress-track"><span className="dashboard-bar-fill" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : (results.length ? 100 : 0)}%` }} /></div>
            <div className="mb-done-note">全部步驟成功才會回填 Sheet「添加評論」</div>
            <div className="mb-pane-actions">
              <button type="button" className="mb-btn mb-btn--outline" disabled={running || !items.length} onClick={() => setStep(3)}>上一步</button>
            </div>
          </div>
        )}
      </section>

      {/* 固定在畫面下方的進度列：①～③ 顯示，④ 頁面內有自己的進度（跟開單版 v4.268.2 一致） */}
      {progress.total > 0 && !progressDismissed && step !== 4 && (
        <div className="mb-dock" role="status" aria-live="polite">
          <div className="mb-dock-text">
            <b>{running ? `送出中 ${progress.done} / ${progress.total}` : `送出完成 ${progress.done} / ${progress.total}`}</b>
            <span className="mb-dock-ok">完成 {tally.ok}</span>
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

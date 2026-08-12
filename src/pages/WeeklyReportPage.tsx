import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { loadGlobalAccount } from '../authSession'

interface FieldOption { id: string; name: string }
interface ParsedTable { appToken: string; tableId: string; members: FieldOption[]; projects: FieldOption[] }
interface RangeIssue { key: string; summary: string; status: string; created: string; updated: string; role: 'reporter' | 'verifier' | 'both' }
interface MatchedCell { column: string; cellValue: string; alias: string }
interface AnalyzedRow { rowIndex: number; cells: Record<string, string>; confidence: 'high' | 'mid' | 'low' | 'none'; matchedCells: MatchedCell[] }
interface AnalyzedSource { sourceLabel: string; tabName: string; error: string; rows: AnalyzedRow[] }

const LAST_URL_KEY = 'weekly_report_last_url'
const STACK_BREAKPOINT = 1100

function toDateInputValue(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
/** 本週一（週日算上週的最後一天，往回推 6 天；其餘往回推 day-1 天） */
function thisMondayDate(): Date {
  const d = new Date()
  const day = d.getDay()
  const diff = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - diff)
  return d
}
function formatDateShort(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 10)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/** 視窗寬度 < 1100px 時 Step2/3 從左右兩欄改回上下堆疊（2026-08-11：純 flexbox 縮小在小筆電寬度下
 * textarea 會被壓到只剩 ~340px，堪用但偏窄，改成真正的斷點比較可預期） */
function useIsNarrow(breakpoint: number): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpoint)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [breakpoint])
  return narrow
}

/** 成員/專案選項太多（45/59 個），原生 select 很難找——打字篩選的搜尋下拉
 * （2026-08-11：第一版用 input+datalist，實測 Chrome 要點兩次同一欄位下拉建議清單才會跳出來，
 * 體驗不直覺，跟 CodeX 討論後升級成自刻 combobox——問題根源是原生 datalist 的開啟時機不可控，
 * 不是 CSS/樣式能修的，改成自己控制 open/filter/keyboard 狀態）。
 * value 是「目前已提交的值」，外部用它判斷是否合法選項（配合 memberValid/projectValid）；
 * 打字中顯示的文字用 query 這個內部 state，跟 value 分開避免每個按鍵都觸發外部驗證閃爍。 */
function SearchableSelect({ value, onChange, options, placeholder, invalid }: {
  value: string
  onChange: (v: string) => void
  options: FieldOption[]
  placeholder: string
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const [highlight, setHighlight] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setQuery(value) }, [value])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const filtered = query.trim() === ''
    ? options
    : options.filter(o => o.name.toLowerCase().includes(query.trim().toLowerCase()))

  const select = (name: string) => {
    onChange(name)
    setQuery(name)
    setOpen(false)
    setHighlight(-1)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(i => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlight >= 0 && filtered[highlight]) select(filtered[highlight].name)
    } else if (e.key === 'Escape') { setOpen(false); setHighlight(-1) }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        value={query}
        onChange={e => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); setHighlight(-1) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '8px 10px', background: '#0b1322',
          border: `1px solid ${invalid ? 'var(--cr-rose)' : '#2d3f55'}`, borderRadius: 7,
          color: '#e2e8f0', fontSize: 12.5,
        }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
          maxHeight: 220, overflowY: 'auto', background: '#0b1322', border: '1px solid #2d3f55',
          borderRadius: 7, boxShadow: '0 12px 30px rgba(0,0,0,.4)',
        }}>
          {filtered.map((o, i) => (
            <div
              key={o.id}
              // mousedown + preventDefault 讓選項點擊搶在 input 的 onBlur 關閉下拉之前完成，
              // 不然點下去的瞬間 input 先失焦、下拉清單被 onBlur 關掉，click 事件永遠選不到東西
              onMouseDown={e => { e.preventDefault(); select(o.name) }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: '7px 10px', fontSize: 12.5, cursor: 'pointer',
                background: i === highlight ? 'var(--cr-cyan-soft)' : 'transparent',
                color: i === highlight ? 'var(--cr-cyan)' : '#e2e8f0',
              }}
            >
              {o.name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function WeeklyReportPage({ themeMode }: { themeMode: 'classic' | 'xianxia' }) {
  const isXianxia = themeMode === 'xianxia'
  const t = isXianxia
    ? {
        title: '行跡呈報',
        sub: '每週貼上當週玉簡（Lark Base）鏈印，擇己身道號、記本週行跡，直入宗門卷宗一列',
        step1: '貼上本週玉簡鏈印', step1Sub: '每週卷宗不同，貼上鏈印後自動啟卷讀取選項',
        reload: '重新啟卷', parseOkPrefix: '已啟卷', projectLabel: '職司選項', memberLabel: '道友選項',
        step2: '擇己身道號', step2Sub: '道號為必填，主司職務為選填',
        memberField: '道號', projectField: '主司職務', projectPlaceholder: '不指定（行跡自行標註）',
        step3: '本週行跡', step3Sub: '可查探時辰內的令牌編號、與親筆手記混寫，最終合併成同一段行跡紀要',
        submit: '呈報宗門', submitNote: '呈報後會在該卷宗新增一列（道號 / 主司職務 / 行跡紀要）',
        selectPlaceholder: '請擇一...',
        invalidMemberHint: '找不到這個道號，請從清單中選擇',
        invalidProjectHint: '找不到這個職務，請從清單中選擇或留空',
        rangeBtn: '📅 依時辰查探令牌', rangeTitle: '依時辰範圍查探令牌',
        rangeStart: '起始時辰', rangeEnd: '終止時辰', rangeSearchBtn: '查探', rangeSearching: '查探中…',
        rangeConditionNote: '條件：呈報者是你 或 驗證道友是你，符合其一即現形；「立牌」或「異動」落於此時辰範圍內皆算，不限令牌所處哪個階段。',
        rangeSearchFailed: '查探失敗', rangeNoResults: '此時辰範圍內未見符合條件的令牌',
        rangeResultPrefix: '查探所得', rangeSelectAll: '全選', rangeSelectedCountPrefix: '已選',
        rangeApply: '納入行跡', rangeCancel: '取消',
        roleReporter: '呈報者', roleVerifier: '驗證道友', roleBoth: '呈報者+驗證道友',
        sheetBtn: '📊 查探玉簡以記行跡', sheetTitle: '依玉簡查探本週行跡',
        sheetUrlLabel: (i: number) => `玉簡 ${i}${i === 3 ? '（選填）' : ''}`,
        sheetAliasLabel: '比對道號（用來在玉簡內容裡找出屬於你的列）', sheetAliasAdd: '+ 新增道號',
        sheetAliasHint: '道號需至少 3 字元才有效，太短容易誤判',
        sheetNoAliasWarn: '尚未設定比對道號，請先在「擇己身道號」選好自己，或手動新增道號', sheetNoUrlWarn: '請至少貼上一份玉簡鏈印',
        sheetRunBtn: '查探並比對', sheetRunning: '查探中…',
        sheetNoResults: '此玉簡內未見符合條件的行跡', sheetSearchFailed: '查探失敗',
        sheetConfHigh: '高信心', sheetConfMid: '建議確認', sheetConfLow: '可能多人相關', sheetConfNone: '無使用者',
        sheetNoUserSection: (n: number) => `無使用者 ${n} 筆（未比對到任何道號，展開後可自行勾選撿漏）`,
        sheetGenerateBtn: 'AI 生成草稿', sheetGenerating: '生成中…', sheetDraftLabel: 'AI 草稿預覽',
        sheetApply: '納入行跡', sheetCancel: '取消',
        sheetSourcePrefix: '玉簡', sheetTabPrefix: '分頁：',
      }
    : {
        title: '週報彙整',
        sub: '每週貼上當週 Lark Base 網址，選擇自己、填寫本週工作內容，直接送出成一列紀錄',
        step1: '貼上本週 Lark Base 網址', step1Sub: '每週表格不同，貼上網址後自動讀取欄位選項',
        reload: '重新讀取', parseOkPrefix: '已讀取表格', projectLabel: '專案選項', memberLabel: '成員選項',
        step2: '選擇自己', step2Sub: '成員為必填，主要專案為選填',
        memberField: '成員', projectField: '主要專案', projectPlaceholder: '不指定（內容自己標專案）',
        step3: '本週工作內容', step3Sub: '可依時間範圍撈取 Jira 單號、與手寫文字混寫，最終合併成同一段補充說明',
        submit: '送出至 Lark', submitNote: '送出後會在該表新增一列（成員 / 主要專案 / 補充說明）',
        selectPlaceholder: '請選擇...',
        invalidMemberHint: '找不到這個成員，請從清單中選擇',
        invalidProjectHint: '找不到這個專案，請從清單中選擇或留空',
        rangeBtn: '📅 依時間範圍撈 Jira 單', rangeTitle: '依時間範圍查詢 Jira 單',
        rangeStart: '開始日期', rangeEnd: '結束日期', rangeSearchBtn: '查詢', rangeSearching: '查詢中…',
        rangeConditionNote: '條件：Reporter 是你 或 QA驗證人員是你，符合其一即列出；「建立」或「更新」落在這個時間範圍內的單都算，不限工作流程階段。',
        rangeSearchFailed: '查詢失敗', rangeNoResults: '這段時間內沒有符合條件的 Jira 單',
        rangeResultPrefix: '查詢結果', rangeSelectAll: '全選', rangeSelectedCountPrefix: '已勾選',
        rangeApply: '套用到內容', rangeCancel: '取消',
        roleReporter: 'Reporter', roleVerifier: 'QA驗證人員', roleBoth: 'Reporter + QA驗證人員',
        sheetBtn: '📊 從 Sheet 分析本週內容', sheetTitle: '依 Lark Sheet 分析本週內容',
        sheetUrlLabel: (i: number) => `Sheet ${i}${i === 3 ? '（選填）' : ''}`,
        sheetAliasLabel: '比對別名（用來在 sheet 內容裡找出屬於你的列）', sheetAliasAdd: '+ 新增別名',
        sheetAliasHint: '別名需至少 3 字元才有效，太短容易誤判',
        sheetNoAliasWarn: '尚未設定比對別名，請先在「選擇自己」選好成員，或手動新增別名', sheetNoUrlWarn: '請至少貼上一個 Sheet 網址',
        sheetRunBtn: '讀取並比對', sheetRunning: '讀取中…',
        sheetNoResults: '這份 Sheet 內未見符合條件的列', sheetSearchFailed: '讀取失敗',
        sheetConfHigh: '高信心', sheetConfMid: '建議確認', sheetConfLow: '可能多人相關', sheetConfNone: '無使用者',
        sheetNoUserSection: (n: number) => `無使用者 ${n} 筆（未比對到任何別名，展開後可自行勾選撿漏）`,
        sheetGenerateBtn: 'AI 生成草稿', sheetGenerating: '生成中…', sheetDraftLabel: 'AI 草稿預覽',
        sheetApply: '插入到內容', sheetCancel: '取消',
        sheetSourcePrefix: 'Sheet', sheetTabPrefix: '分頁：',
      }

  const [url, setUrl] = useState(() => localStorage.getItem(LAST_URL_KEY) ?? '')
  const [parsed, setParsed] = useState<ParsedTable | null>(null)
  const [parseMsg, setParseMsg] = useState('')
  const [parsing, setParsing] = useState(false)

  const [member, setMember] = useState('')
  const [project, setProject] = useState('')
  const [content, setContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [rangeOpen, setRangeOpen] = useState(false)
  const [rangeStart, setRangeStart] = useState(() => toDateInputValue(thisMondayDate()))
  const [rangeEnd, setRangeEnd] = useState(() => toDateInputValue(new Date()))
  const [rangeLoading, setRangeLoading] = useState(false)
  const [rangeMsg, setRangeMsg] = useState('')
  const [rangeIssues, setRangeIssues] = useState<RangeIssue[] | null>(null)
  const [rangeChecked, setRangeChecked] = useState<Set<string>>(new Set())

  // ── 「從 Sheet 分析本週內容」（2026-08-12，跟 CodeX 討論定案）──
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetUrls, setSheetUrls] = useState(['', '', ''])
  const [sheetAliases, setSheetAliases] = useState<string[]>([])
  const [sheetAliasInput, setSheetAliasInput] = useState('')
  const [sheetLoading, setSheetLoading] = useState(false)
  const [sheetMsg, setSheetMsg] = useState('')
  const [sheetSources, setSheetSources] = useState<AnalyzedSource[] | null>(null)
  // checked key 格式："{sourceIndex}:{rowIndex}"，跨 source 也不會撞
  const [sheetChecked, setSheetChecked] = useState<Set<string>>(new Set())
  const [sheetDraftLoading, setSheetDraftLoading] = useState(false)
  const [sheetDraftMsg, setSheetDraftMsg] = useState('')
  const [sheetDraft, setSheetDraft] = useState('')
  // 「無使用者」區塊預設收合，依 source index 記錄哪些已展開（2026-08-12，跟 CodeX 討論定案）
  const [sheetNoUserExpanded, setSheetNoUserExpanded] = useState<Set<number>>(new Set())

  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState('')

  const isNarrow = useIsNarrow(STACK_BREAKPOINT)

  // datalist 允許打進去的值不在清單裡，必填的成員欄位要擋非合法值才能送出；
  // 主要專案選填，留空可以送出，但填了就一樣要是合法選項
  const memberValid = !parsed || parsed.members.some(m => m.name === member)
  const projectValid = !parsed || project === '' || parsed.projects.some(p => p.name === project)

  const handleParse = async () => {
    if (!url.trim()) return
    setParsing(true); setParseMsg(''); setParsed(null); setMember(''); setProject('')
    try {
      const r = await fetch('/api/weekly-report/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      })
      const d = await r.json() as { ok: boolean; message?: string; appToken?: string; tableId?: string; members?: FieldOption[]; projects?: FieldOption[] }
      if (d.ok && d.appToken && d.tableId) {
        setParsed({ appToken: d.appToken, tableId: d.tableId, members: d.members ?? [], projects: d.projects ?? [] })
        setParseMsg(`${t.parseOkPrefix} — ${t.projectLabel} ${d.projects?.length ?? 0} 個、${t.memberLabel} ${d.members?.length ?? 0} 個`)
        localStorage.setItem(LAST_URL_KEY, url)
      } else {
        setParseMsg(d.message || '讀取失敗')
      }
    } catch (e) {
      setParseMsg(`讀取失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setParsing(false)
    }
  }

  /** 把選取的 issue key 插入到 textarea 游標處，自成一行（前面需要的話補換行，不黏在既有文字後面） */
  const insertAtCursor = (text: string) => {
    const ta = textareaRef.current
    if (ta) {
      const start = ta.selectionStart ?? content.length
      const end = ta.selectionEnd ?? content.length
      const before = content.slice(0, start)
      const leading = before.length > 0 && !before.endsWith('\n') ? '\n' : ''
      const insertText = `${leading}${text}\n`
      const next = before + insertText + content.slice(end)
      setContent(next)
      const cursor = start + insertText.length
      requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(cursor, cursor) })
    } else {
      setContent(c => c + (c && !c.endsWith('\n') ? '\n' : '') + `${text}\n`)
    }
  }

  const handleRangeSearch = async () => {
    if (!rangeStart || !rangeEnd) return
    const account = loadGlobalAccount()
    if (!account?.email) { setRangeMsg('找不到目前登入帳號，請重新登入'); return }
    setRangeLoading(true); setRangeMsg(''); setRangeIssues(null)
    try {
      const r = await fetch('/api/weekly-report/jira-by-range', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-jira-email': account.email },
        body: JSON.stringify({ startDate: rangeStart, endDate: rangeEnd }),
      })
      const d = await r.json() as { ok: boolean; message?: string; issues?: RangeIssue[] }
      if (!d.ok) { setRangeMsg(d.message || t.rangeSearchFailed); return }
      const issues = d.issues ?? []
      setRangeIssues(issues)
      setRangeChecked(new Set(issues.map(i => i.key)))
    } catch (e) {
      setRangeMsg(`${t.rangeSearchFailed}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRangeLoading(false)
    }
  }

  const toggleRangeChecked = (key: string) => {
    setRangeChecked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }
  const toggleAllRange = () => {
    if (!rangeIssues) return
    setRangeChecked(prev => prev.size === rangeIssues.length ? new Set() : new Set(rangeIssues.map(i => i.key)))
  }
  const handleRangeCancel = () => {
    setRangeOpen(false); setRangeIssues(null); setRangeChecked(new Set()); setRangeMsg('')
  }
  const handleRangeApply = () => {
    if (!rangeIssues) return
    const keys = rangeIssues.filter(i => rangeChecked.has(i.key)).map(i => i.key)
    if (keys.length === 0) return
    insertAtCursor(keys.join('、'))
    setRangeOpen(false); setRangeIssues(null); setRangeChecked(new Set())
  }

  // ── 「從 Sheet 分析本週內容」handlers ──
  // 2026-08-12 修正：原本只在「打開面板那瞬間」把 Step 2 成員名塞進別名，如果打開面板時
  // Step 2 還沒選好成員、之後才選，別名會永遠是空的——查探並比對按鈕因此被 disabled 擋住送出，
  // 但按鈕樣式沒反映這個狀態，使用者以為按鈕沒反應（實際案例）。改成面板開著時 member 才選好
  // 也能自動補上，且只在清單仍是空的時候才自動帶入，不會覆蓋使用者已手動編輯過的清單。
  useEffect(() => {
    if (sheetOpen && sheetAliases.length === 0 && member) setSheetAliases([member])
  }, [sheetOpen, member, sheetAliases.length])
  const openSheetPanel = () => setSheetOpen(o => !o)
  const addSheetAlias = () => {
    const v = sheetAliasInput.trim()
    if (!v || sheetAliases.includes(v)) { setSheetAliasInput(''); return }
    setSheetAliases(prev => [...prev, v])
    setSheetAliasInput('')
  }
  const removeSheetAlias = (v: string) => setSheetAliases(prev => prev.filter(a => a !== v))

  // disabled 判斷跟按鈕樣式共用同一個值，避免視覺狀態跟實際能不能點擊不同步
  // （2026-08-12 修正：先前樣式只吃 sheetLoading，按鈕在 alias/url 為空時實際被 disabled 擋住
  // 卻看起來還是亮著可點，使用者點了以為沒反應）
  const sheetHasUrl = sheetUrls.some(u => u.trim())
  const sheetSubmitDisabled = sheetLoading || !sheetHasUrl || sheetAliases.length === 0

  const handleSheetRun = async () => {
    const urls = sheetUrls.map(u => u.trim()).filter(Boolean)
    if (urls.length === 0 || sheetAliases.length === 0) return
    setSheetLoading(true); setSheetMsg(''); setSheetSources(null); setSheetChecked(new Set()); setSheetDraft(''); setSheetDraftMsg(''); setSheetNoUserExpanded(new Set())
    try {
      const r = await fetch('/api/weekly-report/sheet-analysis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrls: urls, aliases: sheetAliases }),
      })
      const d = await r.json() as { ok: boolean; message?: string; sources?: AnalyzedSource[] }
      if (!d.ok) { setSheetMsg(d.message || t.sheetSearchFailed); return }
      const sources = d.sources ?? []
      setSheetSources(sources)
      // 預設勾選規則：高信心預勾，中/低信心不預勾
      const initChecked = new Set<string>()
      sources.forEach((s, si) => s.rows.forEach(row => { if (row.confidence === 'high') initChecked.add(`${si}:${row.rowIndex}`) }))
      setSheetChecked(initChecked)
    } catch (e) {
      setSheetMsg(`${t.sheetSearchFailed}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSheetLoading(false)
    }
  }

  const toggleSheetChecked = (key: string) => {
    setSheetChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }
  const toggleNoUserExpanded = (si: number) => {
    setSheetNoUserExpanded(prev => { const n = new Set(prev); n.has(si) ? n.delete(si) : n.add(si); return n })
  }

  const handleSheetCancel = () => {
    setSheetOpen(false); setSheetSources(null); setSheetChecked(new Set()); setSheetMsg(''); setSheetDraft(''); setSheetDraftMsg(''); setSheetNoUserExpanded(new Set())
  }

  const handleSheetGenerateDraft = async () => {
    if (!sheetSources) return
    const selections = sheetSources.map((s, si) => ({
      sourceLabel: s.sourceLabel,
      tabName: s.tabName,
      rows: s.rows.filter(row => sheetChecked.has(`${si}:${row.rowIndex}`)).map(row => ({ cells: row.cells })),
    })).filter(s => s.rows.length > 0)
    if (selections.length === 0) return
    setSheetDraftLoading(true); setSheetDraftMsg(''); setSheetDraft('')
    try {
      const r = await fetch('/api/weekly-report/sheet-analysis-draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections }),
      })
      const d = await r.json() as { ok: boolean; message?: string; draft?: string }
      if (!d.ok) { setSheetDraftMsg(d.message || '生成失敗'); return }
      setSheetDraft(d.draft ?? '')
    } catch (e) {
      setSheetDraftMsg(`生成失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSheetDraftLoading(false)
    }
  }

  const handleSheetApply = () => {
    if (!sheetDraft.trim()) return
    insertAtCursor(sheetDraft.trim())
    setSheetOpen(false); setSheetSources(null); setSheetChecked(new Set()); setSheetDraft(''); setSheetDraftMsg(''); setSheetNoUserExpanded(new Set())
  }

  const canSubmit = !!parsed && !!member && memberValid && projectValid && content.trim().length > 0 && !submitting

  const handleSubmit = async () => {
    if (!parsed || !member || !content.trim() || !memberValid || !projectValid) return
    setSubmitting(true); setSubmitMsg('')
    try {
      const r = await fetch('/api/weekly-report/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appToken: parsed.appToken, tableId: parsed.tableId, member, project: project || undefined, content }),
      })
      const d = await r.json() as { ok: boolean; message?: string }
      if (d.ok) { setSubmitMsg('通過 已送出'); setContent('') }
      else setSubmitMsg(`失敗 ${d.message}`)
    } catch (e) {
      setSubmitMsg(`失敗 ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ maxWidth: 1200, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* topbar 已經顯示標題，這裡不重複顯示大標題，只留說明文字 */}
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>{t.sub}</div>

      {/* Step 1 — 全寬，網址本來就長 */}
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', background: parsed ? 'var(--xx-jade-solid)' : 'var(--cr-cyan-soft)', color: parsed ? '#fff' : 'var(--cr-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{parsed ? '✓' : '1'}</span>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>
            {t.step1}
            <small style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: '#64748b', marginTop: 2 }}>{t.step1Sub}</small>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://.../base/{appToken}?table={tableId}"
            style={{ flex: 1, padding: '8px 10px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12.5 }} />
          <button onClick={handleParse} disabled={parsing || !url.trim()}
            style={{ padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: parsing ? 'default' : 'pointer', opacity: parsing ? .6 : 1 }}>
            {parsing ? '讀取中…' : t.reload}
          </button>
        </div>
        {parseMsg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 11.5, borderRadius: 7, padding: '8px 10px', color: parsed ? 'var(--cr-cyan)' : 'var(--cr-rose)', background: parsed ? 'var(--cr-cyan-soft)' : 'var(--cr-rose-soft, rgba(223,118,94,.12))', border: `1px solid ${parsed ? 'var(--cr-cyan-border)' : 'transparent'}` }}>
            <span>{parsed ? '✓' : '⚠'}</span>
            <span>{parseMsg}</span>
          </div>
        )}
      </div>

      {/* Step 2 + 3 — 寬螢幕左右兩欄利用空間，<1100px 斷回上下堆疊（純 flex 縮小在小筆電寬度下
          textarea 會被壓太窄，改用真正的斷點） */}
      <div style={{ display: 'flex', flexDirection: isNarrow ? 'column' : 'row', gap: 14, alignItems: 'stretch', marginBottom: 14 }}>
        {/* Step 2 */}
        <div style={{ flex: isNarrow ? '1 1 auto' : '0 0 340px', width: isNarrow ? '100%' : undefined, border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px', opacity: parsed ? 1 : .5, pointerEvents: parsed ? 'auto' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>2</span>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>
              {t.step2}
              <small style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: '#64748b', marginTop: 2 }}>{t.step2Sub}</small>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: '#94a3b8', marginBottom: 5 }}>
                {t.memberField} <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--cr-rose-soft, rgba(223,118,94,.12))', color: 'var(--cr-rose)', marginLeft: 6 }}>必填</span>
              </label>
              <SearchableSelect value={member} onChange={setMember}
                options={parsed?.members ?? []} placeholder={t.selectPlaceholder}
                invalid={member.length > 0 && !memberValid} />
              {member.length > 0 && !memberValid && (
                <div style={{ fontSize: 10.5, color: 'var(--cr-rose)', marginTop: 4 }}>{t.invalidMemberHint}</div>
              )}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: '#94a3b8', marginBottom: 5 }}>
                {t.projectField} <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'rgba(148,163,184,.12)', color: '#94a3b8', marginLeft: 6 }}>選填</span>
              </label>
              <SearchableSelect value={project} onChange={setProject}
                options={parsed?.projects ?? []} placeholder={t.projectPlaceholder}
                invalid={project.length > 0 && !projectValid} />
              {project.length > 0 && !projectValid && (
                <div style={{ fontSize: 10.5, color: 'var(--cr-rose)', marginTop: 4 }}>{t.invalidProjectHint}</div>
              )}
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div style={{ flex: 1, minWidth: 0, border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px', opacity: parsed ? 1 : .5, pointerEvents: parsed ? 'auto' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>3</span>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>
              {t.step3}
              <small style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: '#64748b', marginTop: 2 }}>{t.step3Sub}</small>
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: (rangeOpen || sheetOpen) ? 10 : 8, flexWrap: 'wrap' }}>
            <button onClick={() => setRangeOpen(o => !o)}
              style={{ padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: rangeOpen ? 'var(--cr-cyan-soft)' : 'transparent', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: 'pointer' }}>
              {t.rangeBtn}
            </button>
            <button onClick={openSheetPanel}
              style={{ padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: sheetOpen ? 'var(--cr-cyan-soft)' : 'transparent', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: 'pointer' }}>
              {t.sheetBtn}
            </button>
          </div>

          {rangeOpen && (
            <div style={{ border: '1px solid #2d3f55', borderRadius: 8, background: '#0b1322', padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}>{t.rangeTitle}</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginBottom: 4 }}>{t.rangeStart}</label>
                  <input type="date" value={rangeStart} onChange={e => setRangeStart(e.target.value)}
                    style={{ background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginBottom: 4 }}>{t.rangeEnd}</label>
                  <input type="date" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)}
                    style={{ background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                </div>
                <button onClick={handleRangeSearch} disabled={rangeLoading || !rangeStart || !rangeEnd}
                  style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: rangeLoading ? 'default' : 'pointer', opacity: rangeLoading ? .6 : 1, height: 32 }}>
                  {rangeLoading ? t.rangeSearching : t.rangeSearchBtn}
                </button>
              </div>
              <div style={{ fontSize: 10.5, color: '#64748b', lineHeight: 1.6, background: 'rgba(255,255,255,.03)', border: '1px dashed #2d3f55', borderRadius: 7, padding: '8px 10px', marginBottom: 10 }}>
                {t.rangeConditionNote}
              </div>
              {rangeMsg && <div style={{ fontSize: 11, color: 'var(--cr-rose)', marginBottom: 10 }}>{rangeMsg}</div>}
              {rangeIssues && rangeIssues.length === 0 && (
                <div style={{ fontSize: 11.5, color: '#64748b' }}>{t.rangeNoResults}</div>
              )}
              {rangeIssues && rangeIssues.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10.5, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: .04, margin: '4px 0 8px' }}>
                    <span>{t.rangeResultPrefix} · {rangeIssues.length}</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--cr-cyan)' }}>
                      <input type="checkbox" checked={rangeChecked.size === rangeIssues.length} onChange={toggleAllRange}
                        style={{ accentColor: 'var(--cr-cyan)', cursor: 'pointer' }} />
                      {t.rangeSelectAll}
                    </label>
                  </div>
                  <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                    {rangeIssues.map(iss => (
                      <label key={iss.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 6px', borderRadius: 7, cursor: 'pointer' }}>
                        <input type="checkbox" checked={rangeChecked.has(iss.key)} onChange={() => toggleRangeChecked(iss.key)}
                          style={{ marginTop: 2, width: 15, height: 15, accentColor: 'var(--cr-cyan)', flexShrink: 0, cursor: 'pointer' }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, color: '#e2e8f0', lineHeight: 1.5 }}>
                            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 700, color: 'var(--cr-cyan)', background: 'var(--cr-cyan-soft)', padding: '1px 6px', borderRadius: 5, marginRight: 6 }}>{iss.key}</span>
                            {iss.summary}
                          </div>
                          <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: iss.role === 'verifier' ? 'var(--cr-cyan-soft)' : 'var(--cr-emerald-soft, rgba(127,217,154,.14))', color: iss.role === 'verifier' ? 'var(--cr-cyan)' : '#7fd99a' }}>
                              {iss.role === 'verifier' ? t.roleVerifier : iss.role === 'both' ? t.roleBoth : t.roleReporter}
                            </span>
                            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'rgba(255,255,255,.06)' }}>{iss.status}</span>
                            <span>{formatDateShort(iss.updated)}</span>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, borderTop: '1px solid #2d3f55', paddingTop: 10 }}>
                    <span style={{ fontSize: 10.5, color: '#64748b', marginRight: 'auto', alignSelf: 'center' }}>
                      {t.rangeSelectedCountPrefix} <b style={{ color: 'var(--cr-cyan)' }}>{rangeChecked.size}</b> / {rangeIssues.length}
                    </span>
                    <button onClick={handleRangeCancel}
                      style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, border: '1px solid #2d3f55', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>
                      {t.rangeCancel}
                    </button>
                    <button onClick={handleRangeApply} disabled={rangeChecked.size === 0}
                      style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: rangeChecked.size === 0 ? 'default' : 'pointer', opacity: rangeChecked.size === 0 ? .5 : 1 }}>
                      {t.rangeApply}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {sheetOpen && (
            <div style={{ border: '1px solid #2d3f55', borderRadius: 8, background: '#0b1322', padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}>{t.sheetTitle}</div>

              {[0, 1, 2].map(i => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <label style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginBottom: 4 }}>{t.sheetUrlLabel(i + 1)}</label>
                  <input type="text" value={sheetUrls[i]} onChange={e => setSheetUrls(prev => prev.map((v, idx) => idx === i ? e.target.value : v))}
                    placeholder="https://.../sheets/{token} 或 /wiki/{token}"
                    style={{ width: '100%', padding: '7px 9px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12, fontFamily: 'inherit' }} />
                </div>
              ))}

              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginBottom: 4 }}>{t.sheetAliasLabel}</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {sheetAliases.map(a => (
                    <span key={a} style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px 3px 10px', borderRadius: 999, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', display: 'flex', alignItems: 'center', gap: 5 }}>
                      {a}
                      <span onClick={() => removeSheetAlias(a)} style={{ cursor: 'pointer', opacity: .7 }}>✕</span>
                    </span>
                  ))}
                  <input type="text" value={sheetAliasInput} onChange={e => setSheetAliasInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSheetAlias() } }}
                    placeholder={t.sheetAliasAdd}
                    style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, border: '1px dashed #2d3f55', background: 'transparent', color: '#e2e8f0', width: 100 }} />
                </div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>{t.sheetAliasHint}</div>
                {sheetAliases.length === 0 && (
                  <div style={{ fontSize: 10.5, color: 'var(--cr-rose)', marginTop: 4 }}>{t.sheetNoAliasWarn}</div>
                )}
              </div>

              {!sheetHasUrl && (
                <div style={{ fontSize: 10.5, color: 'var(--cr-rose)', marginBottom: 8 }}>{t.sheetNoUrlWarn}</div>
              )}
              <button onClick={handleSheetRun} disabled={sheetSubmitDisabled}
                style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: sheetSubmitDisabled ? 'default' : 'pointer', opacity: sheetSubmitDisabled ? .5 : 1, marginBottom: 10 }}>
                {sheetLoading ? t.sheetRunning : t.sheetRunBtn}
              </button>

              {sheetMsg && <div style={{ fontSize: 11, color: 'var(--cr-rose)', marginBottom: 10 }}>{sheetMsg}</div>}

              {sheetSources && sheetSources.map((s, si) => {
                const matchedRows = s.rows.filter(r => r.confidence !== 'none')
                const noUserRows = s.rows.filter(r => r.confidence === 'none')
                const noUserOpen = sheetNoUserExpanded.has(si)
                const renderRow = (row: AnalyzedRow) => {
                  const key = `${si}:${row.rowIndex}`
                  const confColor = row.confidence === 'high' ? 'var(--cr-emerald, #7fd99a)' : row.confidence === 'mid' ? 'var(--cr-amber, #e0b45f)' : row.confidence === 'low' ? 'var(--cr-rose)' : '#64748b'
                  const confSoft = row.confidence === 'high' ? 'rgba(127,217,154,.14)' : row.confidence === 'mid' ? 'rgba(224,180,95,.14)' : row.confidence === 'low' ? 'var(--cr-rose-soft, rgba(223,118,94,.12))' : 'rgba(255,255,255,.06)'
                  const confLabel = row.confidence === 'high' ? t.sheetConfHigh : row.confidence === 'mid' ? t.sheetConfMid : row.confidence === 'low' ? t.sheetConfLow : t.sheetConfNone
                  const cellsText = Object.entries(row.cells).filter(([, v]) => v.trim()).map(([k, v]) => `${k}：${v}`).join('　')
                  return (
                    <label key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', borderTop: '1px solid #2d3f55', cursor: 'pointer' }}>
                      <input type="checkbox" checked={sheetChecked.has(key)} onChange={() => toggleSheetChecked(key)}
                        style={{ marginTop: 2, width: 15, height: 15, accentColor: confColor, flexShrink: 0, cursor: 'pointer' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.5 }}>
                          {cellsText}
                          <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 999, marginLeft: 8, background: confSoft, color: confColor, whiteSpace: 'nowrap' }}>{confLabel}</span>
                        </div>
                        {row.matchedCells.length > 0 && (
                          <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>
                            {row.matchedCells.map((m, mi) => (
                              <span key={mi}>{mi > 0 ? '、' : ''}命中 <b style={{ color: 'var(--cr-cyan)' }}>{m.column}</b> = 「{m.alias}」</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </label>
                  )
                }
                return (
                  <div key={si} style={{ border: '1px solid #2d3f55', borderRadius: 8, marginTop: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '9px 12px', background: 'rgba(255,255,255,.03)', fontSize: 12, fontWeight: 700, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <span>{t.sheetSourcePrefix} {si + 1}{s.tabName ? `　${t.sheetTabPrefix}${s.tabName}` : ''}</span>
                    </div>
                    {s.error && <div style={{ padding: '9px 12px', fontSize: 11.5, color: 'var(--cr-rose)' }}>{s.error}</div>}
                    {!s.error && s.rows.length === 0 && (
                      <div style={{ padding: '9px 12px', fontSize: 11.5, color: '#64748b' }}>{t.sheetNoResults}</div>
                    )}
                    {matchedRows.map(renderRow)}
                    {noUserRows.length > 0 && (
                      <div style={{ borderTop: '1px solid #2d3f55' }}>
                        <button type="button" onClick={() => toggleNoUserExpanded(si)}
                          style={{ width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#64748b', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>{noUserOpen ? '▾' : '▸'}</span>
                          <span>{t.sheetNoUserSection(noUserRows.length)}</span>
                        </button>
                        {noUserOpen && noUserRows.map(renderRow)}
                      </div>
                    )}
                  </div>
                )
              })}

              {sheetSources && sheetSources.some(s => s.rows.length > 0) && (
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                  <button onClick={handleSheetCancel}
                    style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, border: '1px solid #2d3f55', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>
                    {t.sheetCancel}
                  </button>
                  <button onClick={handleSheetGenerateDraft} disabled={sheetDraftLoading || sheetChecked.size === 0}
                    style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: (sheetDraftLoading || sheetChecked.size === 0) ? 'default' : 'pointer', opacity: (sheetDraftLoading || sheetChecked.size === 0) ? .5 : 1 }}>
                    {sheetDraftLoading ? t.sheetGenerating : t.sheetGenerateBtn}
                  </button>
                </div>
              )}

              {sheetDraftMsg && <div style={{ fontSize: 11, color: 'var(--cr-rose)', marginTop: 10 }}>{sheetDraftMsg}</div>}

              {sheetDraft && (
                <div style={{ marginTop: 12, border: '1px solid var(--cr-cyan-border, #2d3f55)', borderRadius: 8, padding: '12px 14px', background: 'rgba(95,212,208,.05)' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--cr-cyan)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{t.sheetDraftLabel}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>{sheetDraft}</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                    <button onClick={handleSheetApply}
                      style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: 'pointer' }}>
                      {t.sheetApply}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <textarea ref={textareaRef} value={content} onChange={e => setContent(e.target.value)}
            style={{ width: '100%', minHeight: 260, padding: '8px 10px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12.5, lineHeight: 1.6, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={handleSubmit} disabled={!canSubmit}
          style={{ padding: '8px 16px', fontSize: 12.5, fontWeight: 700, borderRadius: 7, background: canSubmit ? 'var(--xx-jade-solid)' : '#334155', color: '#fff', border: 'none', cursor: canSubmit ? 'pointer' : 'default' }}>
          {submitting ? '送出中…' : t.submit}
        </button>
        <span style={{ fontSize: 11, color: '#64748b' }}>{t.submitNote}</span>
        {submitMsg && <span style={{ fontSize: 12, color: submitMsg.startsWith('通過') ? '#16a34a' : '#dc2626' }}>{submitMsg}</span>}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
// 週報的呈現規則前後端共用同一份（shared/ 只放純函式，不碰 fs/DB/env/React）——
// 在 server 再寫一份的話，之後改規則一定會漏一邊，症狀是「Discord 送出去的跟頁面上看到的不一樣」
import {
  DEFAULT_TAB_DATE_PROJECT_NAME, MERGE_PROJECT_NAME, DEFAULT_SCAN_SHEET_URL,
  MERGE_CONTENT, matchLarkProjectByJiraName, buildPreviewItems, countMergeable, countJiraTagAffected,
  applyDefaultScanSheetProject, AUTO_IMPORT_TARGET_KEYWORDS, matchesAutoImportTarget,
} from '../../shared/weekly-report-rules.js'

/** 原生 emoji 替代圖示——docs/visual-style.md「禁忌」規定禁用原生 emoji 渲染，改用 icon asset。
 *  currentColor 描邊，一份線稿兩個版面（普通版/仙俠版）共用，外層文字顏色決定圖示顏色。 */
function CalendarIcon({ size = 14, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: -2, flexShrink: 0, ...style }}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M8 3v3M16 3v3M3 10h18" />
      <rect x="7" y="13" width="2.4" height="2.4" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="11.3" y="13" width="2.4" height="2.4" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="15.6" y="13" width="2.4" height="2.4" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}
function WarningIcon({ size = 14, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: -2, flexShrink: 0, ...style }}>
      <path d="M12 3.6 21.5 20H2.5L12 3.6Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.15" fill="currentColor" stroke="currentColor" strokeWidth={2} />
    </svg>
  )
}

interface FieldOption { id: string; name: string }
interface ParsedTable { appToken: string; tableId: string; members: FieldOption[]; projects: FieldOption[] }
interface RangeIssue { key: string; summary: string; status: string; created: string; updated: string; role: 'reporter' | 'verifier' | 'assignee' | 'both' | 'unknown'; jiraProjectName: string }

// ── 批次掃描審核（2026-08-16）：掃描來源 Sheet、抓出所有出現的人、一次幫全部人產草稿 ──
// jiraIssues：Jira 撈單套用進來的原始資料（單號 + 標題成對存，不是兩個平行陣列——只存 summaries[]
// 的話跟 key 的對應是隱性的，之後要追「這個標題是哪張單」會很痛，CodeX review 建議）。
// content 仍然是使用者看得到、可編輯的單號串；標籤歸集是「送出前的呈現規則」而不是草稿內容改寫，
// 所以原始資料留著、轉換放在 preview pipeline，開關才能隨時切回去。
interface DraftItem {
  sourceRowId: string; content: string; projectId: string; projectName: string
  jiraIssues?: { key: string; summary: string }[]
}
interface BatchScanStats {
  peopleCount: number; itemCount: number; missingProjectCount: number
  unidentifiedCount: number; excludedOutOfRange: number; excludedUnparsableDate: number
}
interface BatchScanResult {
  weekRange: { startLabel: string; endLabel: string; todayLabel: string }
  stats: BatchScanStats
  draftsByPerson: Record<string, DraftItem[]>
  unidentified: Array<{ sourceRowId: string; rawName: string; content: string }>
  sourceErrors: Array<{ sheetIndex: number; message: string }>
}
interface ScanSheetConfig {
  url: string
  headers: string[]
  headersMsg: string
  dateColumn: string
  personColumn: string
  contentColumns: string[]
  /**
   * 只用表單名稱、不讀裡面的內容。
   *
   * 有些來源表加進來只是要記「這週有處理這份表」，內容逐列展開反而是雜訊。
   * 勾了之後這份表不掃列，改成一個項目、內容就是表單名稱，手動指派給誰。
   * **逐份獨立**——勾這份不影響其他份（使用者 2026-08-27 特別強調）。
   */
  nameOnly: boolean
  /** 表單（分頁）名稱，讀表頭時一併拿到。勾了 nameOnly 就是拿它當內容 */
  tabName: string
}
const WEEKDAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']

function newScanSheetConfig(): ScanSheetConfig {
  return { url: '', headers: [], headersMsg: '', dateColumn: '', personColumn: '', contentColumns: [], nameOnly: false, tabName: '' }
}

const LAST_URL_KEY = 'weekly_report_last_url'
/** 每週表格網址固定，預設帶入並開啟頁面自動讀取一次，不用每次手動貼（2026-08-16 使用者要求）；
 *  欄位本身仍可編輯、仍可手動改成別的連結重新讀取，不是鎖死不能改 */
const DEFAULT_WEEKLY_URL = 'https://casinoplus.sg.larksuite.com/base/FEyTb3Y7Ua6ntgsXt0nlKg5yg8e?table=tblBIv21zkPymWCO&view=vew1ruXx0v'

/** 「來源 Sheet」第一筆固定帶入這份「OSM需求單」（2026-08-17 使用者要求，跟頁籤日期式報表
 *  是兩回事——這份是一般的一欄式 Sheet，有「日期」/「填寫人」欄位），頁面載入時自動讀表頭+套用
 *  已知的欄位對應，不用使用者自己選（日期/填寫人欄名很明確；內容欄位使用者確認只要「摘要」）。
 *  仍可手動改成別的網址重新讀取，不是鎖死。名稱原本也叫「線上機台測試表單」，跟頁籤日期式報表的
 *  來源改名成同名後撞名，2026-08-17 同一天使用者改口這份叫「OSM需求單」。 */
const DEFAULT_SCAN_SHEET_DATE_COLUMN = '日期'
const DEFAULT_SCAN_SHEET_PERSON_COLUMN = '填寫人'
const DEFAULT_SCAN_SHEET_CONTENT_COLUMNS = ['摘要']
// 這兩個來源的內容欄位不是乾淨的關鍵字（「摘要」是完整句子、頁籤標題是機台代碼），既有的關鍵字比對
// 抓不到，2026-08-17 使用者要求直接寫死預設專案（已用真實資料驗證 Lark 選項實際字串是連字號格式
// 「P7-005-OSM」/「P7-007-第三方測試」，不是使用者說的空格格式，但下面用既有的 matchLarkProjectByJiraName
// 模糊比對，兩種寫法都吃得進去，不用要求使用者字元對字元打對）
// 合併選項：歸類到這個專案的項目可以選擇「每人各自合併成一條」，補充說明統一寫成下面這句。
// 使用者的實際情境是同一人一週有十幾筆 OSM 需求，逐條寫進週報沒有意義（2026-08-20）。
const MERGE_PREF_KEY = 'toppath-weekly-merge-osm'
const JIRA_TAG_PREF_KEY = 'toppath-weekly-merge-jira-tags'

/** 頁首即時時鐘顯示用，固定用 Asia/Taipei（跟後端 getFridayAnchoredWeekRange() 同一個時區基準），
 *  不用瀏覽器當地時區，避免使用者裝置時區不是台灣時顯示的時間跟撈取週期對不上 */
function formatClock(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** 成員/專案選項太多（45/59 個），原生 select 很難找——打字篩選的搜尋下拉
 * （2026-08-11：第一版用 input+datalist，實測 Chrome 要點兩次同一欄位下拉建議清單才會跳出來，
 * 體驗不直覺，跟 CodeX 討論後升級成自刻 combobox——問題根源是原生 datalist 的開啟時機不可控，
 * 不是 CSS/樣式能修的，改成自己控制 open/filter/keyboard 狀態）。
 * value 是「目前已提交的值」，外部用它判斷是否為合法選項（配合 invalid prop）；
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

/** SearchableSelect 的多選版本（2026-08-17，「頁籤日期式報表」勾選成員用，使用者反應原本的
 *  <select multiple> 原生清單框不好用，要換成下拉+搜尋）。跟單選版最大差異：選項點擊不關閉下拉
 *  （才能連續勾多個），改用 checkbox 顯示已選狀態；輸入框在關閉時顯示「已選 N 人：...」摘要，
 *  聚焦時清空成搜尋字串，不會互相干擾。 */
function SearchableMultiSelect({ selected, onChange, options, placeholder }: {
  selected: string[]
  onChange: (names: string[]) => void
  options: FieldOption[]
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

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

  const toggle = (name: string) => {
    onChange(selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name])
  }

  const displaySummary = selected.length > 0 ? `已選 ${selected.length} 人：${selected.join('、')}` : ''

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        value={open ? query : displaySummary}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => { setOpen(true); setQuery('') }}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '6px 8px', background: '#0b1322',
          border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', fontSize: 11,
          textOverflow: 'ellipsis',
        }}
      />
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 60, minWidth: 200,
          maxHeight: 220, overflowY: 'auto', background: '#0b1322', border: '1px solid #2d3f55',
          borderRadius: 7, boxShadow: '0 12px 30px rgba(0,0,0,.4)',
        }}>
          {filtered.length === 0 && <div style={{ padding: '8px 10px', fontSize: 11.5, color: '#64748b' }}>沒有符合的成員</div>}
          {filtered.map(o => {
            const checked = selected.includes(o.name)
            return (
              <label key={o.id}
                // mousedown + preventDefault：跟單選版同樣理由，避免 input onBlur 搶在 click 前把下拉關掉
                onMouseDown={e => e.preventDefault()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 12, cursor: 'pointer',
                  background: checked ? 'var(--cr-cyan-soft)' : 'transparent', color: checked ? 'var(--cr-cyan)' : '#e2e8f0',
                }}>
                <input type="checkbox" checked={checked} onChange={() => toggle(o.name)} style={{ accentColor: 'var(--cr-cyan)', cursor: 'pointer' }} />
                {o.name}
              </label>
            )
          })}
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
        sub: '每週貼上當週玉簡（Lark Base）鏈印，批次查探玉簡／令牌依道友拆分後一次呈報',
        step1: '貼上本週玉簡鏈印', step1Sub: '每週卷宗不同，貼上鏈印後自動啟卷讀取選項',
        reload: '重新啟卷', parseOkPrefix: '已啟卷', projectLabel: '職司選項', memberLabel: '道友選項',
      }
    : {
        title: '週報彙整',
        sub: '每週貼上當週 Lark Base 網址，批次掃描來源 Sheet／Jira 依成員拆分後一次送出',
        step1: '貼上本週 Lark Base 網址', step1Sub: '每週表格不同，貼上網址後自動讀取欄位選項',
        reload: '重新讀取', parseOkPrefix: '已讀取表格', projectLabel: '專案選項', memberLabel: '成員選項',
      }

  const [url, setUrl] = useState(() => localStorage.getItem(LAST_URL_KEY) ?? DEFAULT_WEEKLY_URL)
  const [parsed, setParsed] = useState<ParsedTable | null>(null)
  const [parseMsg, setParseMsg] = useState('')
  const [parsing, setParsing] = useState(false)

  // ── 批次掃描審核（2026-08-16；2026-08-16 移除「個人自助」舊流程後成為唯一模式）──
  const [scanSheets, setScanSheets] = useState<ScanSheetConfig[]>([{ ...newScanSheetConfig(), url: DEFAULT_SCAN_SHEET_URL }])
  const [scanHeadersLoading, setScanHeadersLoading] = useState<number | null>(null)
  const [scanLoading, setScanLoading] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [scanResult, setScanResult] = useState<BatchScanResult | null>(null)
  const [draftEdits, setDraftEdits] = useState<Record<string, DraftItem[]>>({})
  const [activePerson, setActivePerson] = useState('')
  // 預設關閉——使用者要的是「可以選」而不是「自動幫我合併」；開過一次記住選擇，不用每週重點
  const [mergeOsm, setMergeOsm] = useState<boolean>(() => {
    try { return localStorage.getItem(MERGE_PREF_KEY) === '1' } catch { return false }
  })
  const toggleMergeOsm = (v: boolean) => {
    setMergeOsm(v)
    try { localStorage.setItem(MERGE_PREF_KEY, v ? '1' : '0') } catch { /* 隱私模式等情況忽略 */ }
  }
  const [mergeJiraTags, setMergeJiraTags] = useState<boolean>(() => {
    try { return localStorage.getItem(JIRA_TAG_PREF_KEY) === '1' } catch { return false }
  })
  const toggleMergeJiraTags = (v: boolean) => {
    setMergeJiraTags(v)
    try { localStorage.setItem(JIRA_TAG_PREF_KEY, v ? '1' : '0') } catch { /* 同上 */ }
  }
  const [unidentifiedResolved, setUnidentifiedResolved] = useState<Set<number>>(new Set())
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [batchSubmitMsg, setBatchSubmitMsg] = useState('')
  const [batchSubmitResult, setBatchSubmitResult] = useState<{ successCount: number; failCount: number } | null>(null)

  // ── 批次掃描：依時間範圍撈 Jira 單（可多選帳號，2026-08-16）──
  // 帳號只是用來查詢 Jira（每個帳號各自的 token 都存在後端），不是用來自動判斷單子要歸給哪個人——
  // 撈完之後一律手動選要塞進哪個人的哪個新項目，避免「Jira 帳號 label」跟「Lark 成員名字」對不上的問題
  const [jiraPanelOpen, setJiraPanelOpen] = useState(false)
  const [jiraAccountList, setJiraAccountList] = useState<Array<{ email: string; label: string }>>([])
  const [jiraSelectedEmails, setJiraSelectedEmails] = useState<Set<string>>(new Set())
  const [jiraLoading, setJiraLoading] = useState(false)
  const [jiraMsg, setJiraMsg] = useState('')
  const [jiraIssues, setJiraIssues] = useState<Array<RangeIssue & { accountLabels: string[] }> | null>(null)
  const [jiraChecked, setJiraChecked] = useState<Set<string>>(new Set())
  const [jiraTargetPerson, setJiraTargetPerson] = useState('')

  // ── 「頁籤日期式報表」（2026-08-17，跟 CodeX 討論定案）──
  // 文件寫死在後端，沒有填寫人欄位，命中的頁籤標題整串當內容，全部手動指派——且支援一次勾選多個成員
  // （不像未識別人員那樣一次只能選一個），用 <select multiple> 承接 CodeX review 建議的多選需求
  const [tabDateOpen, setTabDateOpen] = useState(false)
  const [tabDateLoading, setTabDateLoading] = useState(false)
  const [tabDateMsg, setTabDateMsg] = useState('')
  const [tabDateSources, setTabDateSources] = useState<Array<{ key: string; label: string; matchedTabs: Array<{ sheetId: string; title: string }> }> | null>(null)
  const [tabDateSourceErrors, setTabDateSourceErrors] = useState<Array<{ key: string; label: string; message: string }>>([])
  // key 格式："{sourceKey}:{sheetId}" → 目前勾選的成員集合
  const [tabDateSelectedMembers, setTabDateSelectedMembers] = useState<Record<string, Set<string>>>({})

  // ── 頁首常駐週期 banner（2026-08-17）：Jira 撈單不再手動選日期，固定跟 Sheet 掃描同一套
  // 「週五~週四」週期（後端 getFridayAnchoredWeekRange()），掛載時抓一次；即時時鐘只影響顯示，
  // 不會觸發重新抓取 week-range（跟 CodeX 討論定案：兩者關注點分開，頁面長開跨週五午夜的情況
  // 靠使用者下次操作前重新整理/重抓，不用額外做自動偵測）
  const [weekRangeInfo, setWeekRangeInfo] = useState<{ startDate: string; endDate: string; startLabel: string; endLabel: string; todayLabel: string } | null>(null)
  const [weekRangeError, setWeekRangeError] = useState('')
  const [nowClock, setNowClock] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNowClock(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    fetch('/api/weekly-report/week-range')
      .then(r => r.json())
      .then((d: { ok: boolean; startDate?: string; endDate?: string; startLabel?: string; endLabel?: string; todayLabel?: string }) => {
        if (d.ok && d.startDate && d.endDate && d.startLabel && d.endLabel && d.todayLabel) {
          setWeekRangeInfo({ startDate: d.startDate, endDate: d.endDate, startLabel: d.startLabel, endLabel: d.endLabel, todayLabel: d.todayLabel })
        } else {
          setWeekRangeError('無法取得本週撈取範圍')
        }
      })
      .catch(() => setWeekRangeError('無法取得本週撈取範圍'))
  }, [])

  // 「來源 Sheet」第一筆固定帶入的網址（DEFAULT_SCAN_SHEET_URL）自動讀表頭+套用已知欄位對應，
  // 不用使用者自己點「讀取表頭」再選一次。用 s.url === DEFAULT_SCAN_SHEET_URL 判斷 slot 0 是否
  // 還是預設值（避免這支 fetch 回來時使用者已經手動改了網址，結果被回應蓋掉）。
  useEffect(() => {
    fetch('/api/weekly-report/sheet-headers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: DEFAULT_SCAN_SHEET_URL }),
    })
      .then(r => r.json())
      // tabName 也要收下——「只用表單名稱」那個勾選框要有它才顯示得出來，
      // 手動「讀取表頭」那條路徑本來就有存，這條自動路徑漏了就會變成「預設那份表勾不到」
      .then((d: { ok: boolean; headers?: string[]; tabName?: string }) => {
        if (!d.ok) return
        const headers = d.headers ?? []
        setScanSheets(prev => prev.map((s, i) => (i === 0 && s.url === DEFAULT_SCAN_SHEET_URL) ? {
          ...s, headers, tabName: d.tabName ?? '', headersMsg: `已讀取 ${headers.length} 個欄位`,
          dateColumn: headers.includes(DEFAULT_SCAN_SHEET_DATE_COLUMN) ? DEFAULT_SCAN_SHEET_DATE_COLUMN : '',
          personColumn: headers.includes(DEFAULT_SCAN_SHEET_PERSON_COLUMN) ? DEFAULT_SCAN_SHEET_PERSON_COLUMN : '',
          contentColumns: DEFAULT_SCAN_SHEET_CONTENT_COLUMNS.filter(c => headers.includes(c)),
        } : s))
      })
      .catch(() => {})
  }, [])

  const handleParse = async () => {
    if (!url.trim()) return
    setParsing(true); setParseMsg(''); setParsed(null)
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

  // 開啟頁面時若網址欄位有值（預設帶入或上次記住的），自動讀取一次，不用手動點「重新讀取」
  useEffect(() => {
    if (url.trim()) handleParse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 批次掃描審核 handlers（2026-08-16）──

  const updateScanSheet = (idx: number, patch: Partial<ScanSheetConfig>) => {
    setScanSheets(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s))
  }

  const handleLoadSheetHeaders = async (idx: number) => {
    const sheetUrl = scanSheets[idx].url.trim()
    if (!sheetUrl) return
    setScanHeadersLoading(idx)
    updateScanSheet(idx, { headersMsg: '' })
    try {
      const r = await fetch('/api/weekly-report/sheet-headers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sheetUrl }),
      })
      const d = await r.json() as { ok: boolean; message?: string; headers?: string[]; tabName?: string }
      if (d.ok) {
        updateScanSheet(idx, { headers: d.headers ?? [], tabName: d.tabName ?? '', dateColumn: '', personColumn: '', contentColumns: [], headersMsg: `已讀取 ${d.headers?.length ?? 0} 個欄位` })
      } else {
        updateScanSheet(idx, { headers: [], headersMsg: d.message || '讀取失敗' })
      }
    } catch (e) {
      updateScanSheet(idx, { headers: [], headersMsg: `讀取失敗：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setScanHeadersLoading(null)
    }
  }

  const addScanSheet = () => setScanSheets(prev => prev.length >= 3 ? prev : [...prev, newScanSheetConfig()])
  const removeScanSheet = (idx: number) => setScanSheets(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx))
  const toggleScanContentColumn = (idx: number, col: string) => {
    setScanSheets(prev => prev.map((s, i) => {
      if (i !== idx) return s
      const has = s.contentColumns.includes(col)
      return { ...s, contentColumns: has ? s.contentColumns.filter(c => c !== col) : [...s.contentColumns, col] }
    }))
  }

  // 勾了「只用表單名稱」的那幾份不讀內容，自然不需要選日期／填寫人／內容欄位。
  // 沒有這個豁免的話，勾了之後掃描按鈕會一直是鎖住的。
  const scanReady = scanSheets.every(s =>
    s.url.trim() && (s.nameOnly ? !!s.tabName : (s.dateColumn && s.personColumn && s.contentColumns.length > 0)))

  const handleRunScan = async () => {
    if (!parsed || !scanReady) return
    setScanLoading(true); setScanMsg(''); setScanResult(null); setBatchSubmitResult(null); setBatchSubmitMsg('')
    try {
      const r = await fetch('/api/weekly-report/batch-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 只用表單名稱的那幾份不送去掃描——後端掃的是「列」，而它們要的是表單名稱本身。
          // 它們在前端直接產生項目，跟頁籤日期式報表同一套做法。
          sheets: scanSheets.filter(s => !s.nameOnly)
            .map(s => ({ url: s.url, dateColumn: s.dateColumn, personColumn: s.personColumn, contentColumns: s.contentColumns })),
          members: parsed.members.map(m => m.name),
          projects: parsed.projects,
        }),
      })
      const d = await r.json() as { ok: boolean; message?: string } & Partial<BatchScanResult>
      if (d.ok && d.draftsByPerson && d.stats && d.weekRange) {
        // 「預設來源 Sheet 沒比對到專案就補 P7-005-OSM」這條規則在 shared/，後端算 Discord
        // 送出內容時走的是同一支，不是複製一份
        const freshDrafts: Record<string, DraftItem[]> =
          applyDefaultScanSheetProject(d.draftsByPerson, scanSheets[0]?.url, parsed.projects)
        setScanResult({ weekRange: d.weekRange, stats: d.stats, draftsByPerson: freshDrafts, unidentified: d.unidentified ?? [], sourceErrors: d.sourceErrors ?? [] })
        // Sheet 重掃時「Sheet 來源重建、非 Sheet 來源（Jira 套用／手動新增／未識別人員手動指派）保留併回」——
        // 不能整包 setDraftEdits(d.draftsByPerson) 覆蓋，否則先前加進去的項目會被蓋掉（2026-08-16 bug，
        // 跟 CodeX 討論後的修法）。後端 batch-scan 產生的 sourceRowId 固定是 "{sheetIndex}-{rowIndex}"
        // 格式，用它判斷這個項目是不是這次 Sheet 掃描的產物；不是的話保留下來併回去。用 functional update
        // 讀最新的 prev（CodeX review 抓到：closure 裡的 draftEdits 若跟 fetch 期間使用者又加了新項目
        // 會用到過期 state，把這段時間新增的非 Sheet 項目吃掉）。
        const isSheetSourced = (id: string) => /^\d+-\d+$/.test(id)
        setDraftEdits(prev => {
          const merged: Record<string, DraftItem[]> = { ...freshDrafts }
          for (const [person, items] of Object.entries(prev)) {
            const kept = items.filter(it => !isSheetSourced(it.sourceRowId))
            if (kept.length > 0) merged[person] = [...(merged[person] ?? []), ...kept]
          }
          return merged
        })
        setUnidentifiedResolved(new Set())
        // 把「這次用的來源設定」存給後端，定時提醒的預覽才知道要掃哪幾份表（v4.55.0）。
        // 只在掃描成功後存＝存的一定是能跑得動的設定；fire-and-forget，存失敗不影響掃描結果。
        fetch('/api/weekly-report/reminder/sources', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            weeklyUrl: url,
            sheets: scanSheets.filter(sh => !sh.nameOnly).map(sh => ({
              url: sh.url, dateColumn: sh.dateColumn, personColumn: sh.personColumn, contentColumns: sh.contentColumns,
            })),
            // 兩個合併開關存在 localStorage，server 讀不到——不一起送過去的話，Discord 送出的
            // 結果會跟畫面上勾的不一致
            mergeOsm, mergeJiraTags,
          }),
        }).catch(() => { /* 預覽來源存不起來不該打斷使用者 */ })
        // 只是挑「預設顯示哪個人」的 UI 便利判斷，不是資料本身，這裡用呼叫當下的 draftEdits（closure）
        // 做近似判斷即可接受——資料正確性已經由上面 setDraftEdits 的 functional update 保證
        setActivePerson(current => {
          if (current && freshDrafts[current]) return current
          if (current && draftEdits[current]) return current
          return Object.keys(freshDrafts)[0] ?? current ?? ''
        })
      } else {
        setScanMsg(d.message || '掃描失敗')
      }
    } catch (e) {
      setScanMsg(`掃描失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setScanLoading(false)
    }
  }

  // 「來源 Sheet」第一筆自動導入後，使用者反應希望連「開始掃描」也自動觸發，不用手動點一次
  // （2026-08-17）。只在「Step1 Base 已解析＋唯一一筆 Sheet 就是預設帶入的那份＋欄位都已套用好」
  // 時觸發一次，用 ref 擋住重複觸發（例如使用者手動編輯過欄位、或 parsed/scanSheets 之後又變動，
  // 都不該再自動重跑一次，只有「頁面剛載入、一切都還是預設值」這個瞬間才自動掃描一次）。
  const autoScanTriggeredRef = useRef(false)
  useEffect(() => {
    if (autoScanTriggeredRef.current) return
    if (!parsed) return
    if (scanSheets.length !== 1) return
    const s = scanSheets[0]
    if (s.url !== DEFAULT_SCAN_SHEET_URL) return
    if (!s.dateColumn || !s.personColumn || s.contentColumns.length === 0) return
    autoScanTriggeredRef.current = true
    handleRunScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, scanSheets])

  const updateDraftItem = (person: string, index: number, patch: Partial<DraftItem>) => {
    setDraftEdits(prev => ({ ...prev, [person]: prev[person].map((it, i) => i === index ? { ...it, ...patch } : it) }))
  }
  const removeDraftItem = (person: string, index: number) => {
    setDraftEdits(prev => ({ ...prev, [person]: prev[person].filter((_, i) => i !== index) }))
  }
  const addDraftItem = (person: string) => {
    setDraftEdits(prev => ({ ...prev, [person]: [...(prev[person] ?? []), { sourceRowId: '手動新增', content: '', projectId: '', projectName: '' }] }))
  }

  const assignUnidentified = (index: number, member: string) => {
    if (!scanResult) return
    const row = scanResult.unidentified[index]
    if (member !== '__ignore__') {
      // sourceRowId 刻意改成「手動指派 · ...」而不是沿用 row.sourceRowId 原本的 Sheet 格式——這是使用者
      // 手動做的指派決定，跟 Jira 套用／手動新增同一類，Sheet 重掃時不該被當成舊 Sheet 產物清掉重建
      // （CodeX review 抓到：原本沿用會導致重跑 Sheet 掃描後這筆手動指派消失）
      setDraftEdits(prev => ({ ...prev, [member]: [...(prev[member] ?? []), { sourceRowId: `手動指派 · ${row.sourceRowId}`, content: row.content, projectId: '', projectName: '' }] }))
    }
    setUnidentifiedResolved(prev => new Set(prev).add(index))
  }

  const peopleList = Object.keys(draftEdits).sort((a, b) => a.localeCompare(b, 'zh-Hant'))

  // 合併是「衍生轉換」，不動 draftEdits 原始資料——關掉開關就完全恢復逐筆，草稿裡個別編輯過的
  // 內容不會因為切換開關而消失。這一層同時是「預期結果預覽」和「送出 payload」的唯一來源，
  // 在這裡合併，畫面跟實際寫進 Lark 的內容一定一致（跟 CodeX 討論定案）。
  // 規則本體在 shared/weekly-report-rules.ts，後端的 Discord 送出走的是同一份，不是複製一份。
  const flatPreviewItems = buildPreviewItems(draftEdits, { mergeJiraTags, mergeOsm })
  const mergeableCount = countMergeable(draftEdits)
  const jiraTagAffected = !mergeJiraTags ? 0 : countJiraTagAffected(draftEdits)
  const missingProjectTotal = flatPreviewItems.filter(({ item }) => !item.projectName).length
  const totalItemCount = flatPreviewItems.length
  const unresolvedUnidentifiedCount = (scanResult?.unidentified.length ?? 0) - unidentifiedResolved.size

  const handleBatchSubmit = async () => {
    if (!parsed || totalItemCount === 0 || missingProjectTotal > 0) return
    setBatchSubmitting(true); setBatchSubmitMsg(''); setBatchSubmitResult(null)
    try {
      const r = await fetch('/api/weekly-report/batch-submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appToken: parsed.appToken, tableId: parsed.tableId,
          items: flatPreviewItems.map(({ person, item }) => ({ member: person, project: item.projectName || undefined, content: item.content })),
        }),
      })
      const d = await r.json() as { ok: boolean; message?: string; successCount?: number; failCount?: number; results?: Array<{ index: number; ok: boolean; message?: string }> }
      if (d.ok) {
        setBatchSubmitResult({ successCount: d.successCount ?? 0, failCount: d.failCount ?? 0 })
        if (!d.failCount) {
          setBatchSubmitMsg('通過 全部送出成功')
          setScanResult(null); setDraftEdits({})
        } else {
          // 部分失敗時不能整批保留重送——已成功的項目會從清單移除，避免使用者修正失敗項目後重新送出時，
          // 已經成功建立的那幾筆又被重複建立一次（CodeX review 抓到的風險）。用 flatPreviewItems 的順序
          // 對應後端回傳的 index（跟送出當下 payload 的順序完全一致，不是重新從 draftEdits 的 key 順序推算，
          // 避免物件 key 迭代順序跟送出時不一致造成錯位）
          setBatchSubmitMsg(`完成，但有 ${d.failCount} 筆失敗——已成功的項目已從清單移除，避免重送造成重複建立；修正剩下的項目後可以再送一次`)
          const successIdx = new Set((d.results ?? []).filter(x => x.ok).map(x => x.index))
          const remaining = flatPreviewItems.filter((_, i) => !successIdx.has(i))
          const rebuilt: Record<string, DraftItem[]> = {}
          for (const { person, item } of remaining) {
            if (!rebuilt[person]) rebuilt[person] = []
            rebuilt[person].push(item)
          }
          setDraftEdits(rebuilt)
          if (!rebuilt[activePerson]) setActivePerson(Object.keys(rebuilt)[0] ?? '')
        }
      } else {
        setBatchSubmitMsg(d.message || '送出失敗')
      }
    } catch (e) {
      setBatchSubmitMsg(`送出失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBatchSubmitting(false)
    }
  }

  const openJiraPanel = async () => {
    setJiraPanelOpen(o => !o)
    if (jiraAccountList.length === 0) {
      try {
        const r = await fetch('/api/jira/accounts')
        const d = await r.json() as { ok: boolean; accounts?: Array<{ email: string; label: string }> }
        if (d.ok) setJiraAccountList(d.accounts ?? [])
      } catch { /* 帳號清單讀取失敗不擋面板開啟，查詢時會再擋一次 */ }
    }
  }

  const toggleJiraAccount = (email: string) => {
    setJiraSelectedEmails(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  // 多選帳號各自用自己的 token 查詢（帳號只是查詢工具，不是自動分類依據——見上方 state 註解），
  // 同一張單如果被多個帳號都查到（例如互為 reporter/verifier），合併成一筆、accountLabels 疊加顯示
  const handleJiraRangeSearch = async () => {
    if (jiraSelectedEmails.size === 0) return
    if (!weekRangeInfo) { setJiraMsg(weekRangeError || '無法取得本週撈取範圍'); return }
    setJiraLoading(true); setJiraMsg(''); setJiraIssues(null)
    try {
      const selected = jiraAccountList.filter(a => jiraSelectedEmails.has(a.email))
      const results = await Promise.all(selected.map(async acc => {
        const r = await fetch('/api/weekly-report/jira-by-range', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-jira-email': acc.email },
          body: JSON.stringify({ startDate: weekRangeInfo.startDate, endDate: weekRangeInfo.endDate }),
        })
        const d = await r.json() as { ok: boolean; message?: string; issues?: RangeIssue[] }
        return { account: acc, ok: d.ok, message: d.message, issues: d.issues ?? [] }
      }))
      const failed = results.filter(r => !r.ok)
      const merged = new Map<string, RangeIssue & { accountLabels: string[] }>()
      for (const r of results) {
        if (!r.ok) continue
        for (const issue of r.issues) {
          const existing = merged.get(issue.key)
          if (existing) existing.accountLabels.push(r.account.label)
          else merged.set(issue.key, { ...issue, accountLabels: [r.account.label] })
        }
      }
      const issues = [...merged.values()]
      setJiraIssues(issues)
      setJiraChecked(new Set(issues.map(i => i.key)))
      if (failed.length > 0) setJiraMsg(`${failed.map(f => f.account.label).join('、')} 查詢失敗：${failed[0].message}`)
    } catch (e) {
      setJiraMsg(`查詢失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setJiraLoading(false)
    }
  }

  const toggleJiraChecked = (key: string) => {
    setJiraChecked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 手動指定人員時的備援路徑（給自動套用擋下來的那些用）——同一專案的多張單一樣合併成一個項目，
  // 只是人員固定用手動選的這個，不用再比對成員名單（既然是手動選，一定是合法值）
  const applyJiraToPerson = () => {
    if (!jiraTargetPerson.trim() || jiraChecked.size === 0 || !jiraIssues || !parsed) return
    const person = jiraTargetPerson.trim()
    const checkedIssues = jiraIssues.filter(i => jiraChecked.has(i.key))

    type GroupAcc = { projectId: string; projectName: string; keys: string[]; accountLabels: Set<string>; issues: { key: string; summary: string }[] }
    const groups = new Map<string, GroupAcc>()
    for (const iss of checkedIssues) {
      const matchedProject = matchLarkProjectByJiraName(iss.jiraProjectName, parsed.projects)
      const groupKey = matchedProject?.name ?? ''
      let g = groups.get(groupKey)
      if (!g) { g = { projectId: matchedProject?.id ?? '', projectName: matchedProject?.name ?? '', keys: [], accountLabels: new Set(), issues: [] }; groups.set(groupKey, g) }
      g.keys.push(iss.key)
      g.issues.push({ key: iss.key, summary: iss.summary })
      for (const a of iss.accountLabels) g.accountLabels.add(a)
    }

    const newItems: DraftItem[] = [...groups.values()].map(g => ({
      sourceRowId: `Jira · ${[...g.accountLabels].join('、')}`,
      content: g.keys.join('、'),
      projectId: g.projectId, projectName: g.projectName,
      jiraIssues: g.issues,
    }))
    setDraftEdits(prev => ({ ...prev, [person]: [...(prev[person] ?? []), ...newItems] }))
    setActivePerson(person)
    setJiraPanelOpen(false); setJiraIssues(null); setJiraChecked(new Set())
  }

  // 直接用查詢帳號的 label 當成員（不用手動選人）——但帳號 label 不保證是 Lark 成員名單裡真的存在的
  // 值（已用真實資料證實至少「Eric Wu」不在裡面），比對不到就擋下來，保留在清單裡讓使用者改用下方
  // 「加入到哪個人」手動處理，不會靜默寫入可能無效的成員名稱（2026-08-16，使用者要求）。
  // 同一人同一專案的多張單合併成一個項目（單號用「、」分隔），不同專案各自獨立成項目——
  // 專案用 Jira 單真實所屬專案名稱（issue.fields.project.name）比對 Lark 專案選項，不是用單號前綴猜
  // （已用真實資料驗證：DSFT 對應的 Jira 專案名稱是「P7-007 第三方測試」，正規化後跟 Lark 選項「P7-007-第三方測試」完全相等）
  // 一張單如果被多個帳號查到（都是 reporter/verifier），代表這幾個人都跟這張單有關，要各自拿到一份，
  // 不是只取第一個帳號——跟 Sheet 掃描「填寫人」欄位多人時拆成多筆是同一個原則（2026-08-16 修正，
  // 之前漏掉這點，多選帳號查詢時只有第一個帳號會實際拿到項目，其他共同帳號被吃掉）
  const applyJiraAuto = () => {
    if (!jiraIssues || jiraChecked.size === 0 || !parsed) return
    // 不分大小寫比對（跟後端 Sheet 掃描的成員比對同一套邏輯）——已用真實資料證實 Jira 帳號 label
    // 跟 Lark 成員名字大小寫可能不一致（帳號是 "lusa"，Lark 選項是 "Lusa"），比對到後一律用 Lark
    // 那邊的真實大小寫寫回草稿，不是用 Jira 帳號原始的大小寫，確保送出時對得上真實選項
    const memberByLowerName = new Map(parsed.members.map(m => [m.name.trim().toLowerCase(), m.name]))
    const checkedIssues = jiraIssues.filter(i => jiraChecked.has(i.key))

    type GroupAcc = { person: string; projectId: string; projectName: string; keys: string[]; issues: { key: string; summary: string }[] }
    const groups = new Map<string, GroupAcc>()
    const stillNeedsManual = new Set<string>()
    const unmatchedAccountNames = new Set<string>()

    for (const iss of checkedIssues) {
      const matchedProject = matchLarkProjectByJiraName(iss.jiraProjectName, parsed.projects)
      for (const rawPerson of iss.accountLabels) {
        const person = memberByLowerName.get(rawPerson.trim().toLowerCase())
        if (!person) {
          stillNeedsManual.add(iss.key)
          unmatchedAccountNames.add(rawPerson)
          continue
        }
        const groupKey = `${person}::${matchedProject?.name ?? ''}`
        let g = groups.get(groupKey)
        if (!g) {
          g = { person, projectId: matchedProject?.id ?? '', projectName: matchedProject?.name ?? '', keys: [], issues: [] }
          groups.set(groupKey, g)
        }
        g.keys.push(iss.key)
        g.issues.push({ key: iss.key, summary: iss.summary })
      }
    }

    if (groups.size > 0) {
      setDraftEdits(prev => {
        const next = { ...prev }
        for (const g of groups.values()) {
          const item: DraftItem = { sourceRowId: `Jira · ${g.person}`, content: g.keys.join('、'), projectId: g.projectId, projectName: g.projectName, jiraIssues: g.issues }
          next[g.person] = [...(next[g.person] ?? []), item]
        }
        return next
      })
      setActivePerson([...groups.values()][0].person)
    }

    if (stillNeedsManual.size > 0) {
      setJiraChecked(stillNeedsManual)
      setJiraMsg(`已自動加入 ${groups.size} 個項目；還有 ${stillNeedsManual.size} 張單涉及帳號「${[...unmatchedAccountNames].join('、')}」不在成員名單裡，請在下面手動選要歸給誰`)
    } else {
      setJiraPanelOpen(false); setJiraIssues(null); setJiraChecked(new Set()); setJiraMsg('')
    }
  }

  // ── 「頁籤日期式報表」handlers（2026-08-17）──
  const openTabDatePanel = () => setTabDateOpen(o => !o)

  const handleTabDateScan = async () => {
    setTabDateLoading(true); setTabDateMsg(''); setTabDateSources(null); setTabDateSourceErrors([])
    try {
      const r = await fetch('/api/weekly-report/tab-date-scan')
      const d = await r.json() as {
        ok: boolean; message?: string
        sources?: Array<{ key: string; label: string; matchedTabs: Array<{ sheetId: string; title: string }> }>
        sourceErrors?: Array<{ key: string; label: string; message: string }>
      }
      if (d.ok) {
        setTabDateSources(d.sources ?? [])
        setTabDateSourceErrors(d.sourceErrors ?? [])
      } else {
        setTabDateMsg(d.message || '掃描失敗')
      }
    } catch (e) {
      setTabDateMsg(`掃描失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTabDateLoading(false)
    }
  }

  const setTabDateMembersFor = (tabKey: string, names: string[]) => {
    setTabDateSelectedMembers(prev => ({ ...prev, [tabKey]: new Set(names) }))
  }

  // ── 定時備稿提醒（2026-08-27）──
  // 只提醒、不自動送出（使用者選 B）。後端 cron 到點發 Discord，開頁面之後既有的全自動載入
  // 本來就會自己備好稿，最後仍由使用者確認內容再按送出。設定見 server/routes/weekly-report.ts。
  const [reminderOpen, setReminderOpen] = useState(false)
  const [reminder, setReminder] = useState<{ enabled: boolean; weekday: number; time: string; mentionAll: boolean; jiraActorEmail?: string } | null>(null)
  const [reminderMeta, setReminderMeta] = useState<{
    effectiveJiraActor: string; fallbackActorLabel: string
    candidates: Array<{ email: string; label: string }>
    me: { email: string; isAdmin: boolean } | null
  } | null>(null)
  const [reminderCron, setReminderCron] = useState<string | null>(null)
  const [reminderMsg, setReminderMsg] = useState('')
  const [reminderSaving, setReminderSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/weekly-report/reminder').then(r => r.json()).then((d: {
      ok: boolean; config?: typeof reminder; cronExpr?: string | null
      effectiveJiraActor?: string; fallbackActorLabel?: string
      candidates?: Array<{ email: string; label: string }>
      me?: { email: string; isAdmin: boolean } | null
    }) => {
      if (cancelled || !d.ok || !d.config) return
      setReminder(d.config)
      setReminderCron(d.cronExpr ?? null)
      setReminderMeta({
        effectiveJiraActor: d.effectiveJiraActor ?? '',
        fallbackActorLabel: d.fallbackActorLabel ?? '',
        candidates: d.candidates ?? [],
        me: d.me ?? null,
      })
    }).catch(() => { /* 讀不到就維持 null，畫面顯示讀取中，不擋住週報本身 */ })
    return () => { cancelled = true }
  }, [])

  const saveReminder = async (patch: Partial<NonNullable<typeof reminder>>) => {
    if (!reminder) return
    const next = { ...reminder, ...patch }
    setReminder(next)  // 樂觀更新，開關切下去要立刻有反應
    setReminderSaving(true)
    setReminderMsg('')
    try {
      const r = await fetch('/api/weekly-report/reminder', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      })
      const d = await r.json() as { ok: boolean; message?: string; config?: typeof reminder; cronExpr?: string | null }
      if (d.ok && d.config) {
        setReminder(d.config)
        setReminderCron(d.cronExpr ?? null)
        setReminderMsg('已儲存')
        // 儲存成功後同步「目前實際會用誰」，不然畫面上還顯示舊的
        setReminderMeta(m => m ? { ...m, effectiveJiraActor: d.config?.jiraActorEmail || m.effectiveJiraActor } : m)
      } else {
        setReminderMsg(d.message || '儲存失敗')
      }
    } catch (e) {
      setReminderMsg(`儲存失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReminderSaving(false)
    }
  }

  const testReminder = async () => {
    setReminderMsg('送出中…')
    try {
      const r = await fetch('/api/weekly-report/reminder/test', { method: 'POST' })
      const d = await r.json() as { ok: boolean; message?: string }
      setReminderMsg(d.ok ? '已送出一則測試提醒到 Discord' : (d.message || '送出失敗'))
    } catch (e) {
      setReminderMsg(`送出失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── 只用表單名稱的來源 Sheet（2026-08-27）──
  // 勾了 nameOnly 的那份不會進 batch-scan（後端根本沒讀到它），內容就是表單名稱本身，
  // 沒有填寫人欄位可以自動分類，所以跟頁籤日期式報表同一套：手動勾成員、可複選、按套用。
  // key 用網址不用陣列 index——移除中間那份時 index 會位移，勾好的成員會跑到別份表上。
  const [nameOnlyMembers, setNameOnlyMembers] = useState<Record<string, Set<string>>>({})
  const setNameOnlyMembersFor = (key: string, names: string[]) =>
    setNameOnlyMembers(prev => ({ ...prev, [key]: new Set(names) }))

  const applyNameOnlySheet = (url: string, tabName: string) => {
    const members = [...(nameOnlyMembers[url] ?? [])]
    if (members.length === 0) return
    // 「手動指派 · 」前綴＝非 Sheet 來源，重跑掃描時 isSheetSourced() 判定為 false 會被保留，
    // 跟 Jira 套用／手動新增／未識別人員指派待遇一致（2026-08-16 那個被覆蓋的 bug 的修法）
    const sourceRowId = `手動指派 · 表單 · ${url}`
    const matched = parsed ? matchLarkProjectByJiraName(tabName, parsed.projects) : undefined
    setDraftEdits(prev => {
      const next = { ...prev }
      for (const member of members) {
        const existing = next[member] ?? []
        if (existing.some(it => it.sourceRowId === sourceRowId)) continue
        next[member] = [...existing, { sourceRowId, content: tabName, projectId: matched?.id ?? '', projectName: matched?.name ?? '' }]
      }
      return next
    })
    setNameOnlyMembers(prev => ({ ...prev, [url]: new Set() }))
  }

  // membersOverride：全自動載入用（2026-08-17）——跳過畫面上的勾選 state，直接傳入要套用的成員清單，
  // 避免透過 setState 再讀 state 造成的非同步時序問題（setTabDateSelectedMembers 之後立刻呼叫這支，
  // state 還沒真的更新，會讀到舊值）。手動流程（畫面上點套用）不傳這個參數，行為完全不變。
  const applyTabDateItem = (sourceKey: string, sheetId: string, title: string, membersOverride?: string[]) => {
    const tabKey = `${sourceKey}:${sheetId}`
    const members = membersOverride ?? [...(tabDateSelectedMembers[tabKey] ?? [])]
    if (members.length === 0) return
    // sourceRowId 帶來源 key 避免兩份文件 sheetId 剛好撞名時難追（CodeX review 建議），格式跟現有
    // 「手動指派 · ...」（未識別人員）同一套非 Sheet 來源前綴，Sheet 重掃不會被清掉
    const sourceRowId = `手動指派 · 頁籤 · ${sourceKey}:${sheetId}`
    // 頁籤標題是機台代碼，不是乾淨關鍵字，比對不到專案，2026-08-17 使用者要求直接預設「機台測試」來源固定帶入這個專案
    const defaultProject = parsed ? matchLarkProjectByJiraName(DEFAULT_TAB_DATE_PROJECT_NAME, parsed.projects) : undefined
    setDraftEdits(prev => {
      const next = { ...prev }
      for (const member of members) {
        const existing = next[member] ?? []
        // 避免同一個頁籤對同一成員重複套用（CodeX review 建議）
        if (existing.some(it => it.sourceRowId === sourceRowId)) continue
        next[member] = [...existing, { sourceRowId, content: title, projectId: defaultProject?.id ?? '', projectName: defaultProject?.name ?? '' }]
      }
      return next
    })
    setTabDateSelectedMembers(prev => ({ ...prev, [tabKey]: new Set() }))
  }

  // ── 全自動載入：Jira 撈單 + 頁籤日期式報表（2026-08-17，使用者要求比照「來源 Sheet」自動化）──
  // 兩邊都只在「使用者手動編輯過任何東西之前」的頁面載入瞬間自動跑一次（ref 擋重複），跟 Source Sheet
  // 的 autoScanTriggeredRef 同一個模式；跑完之後最終的「呈報宗門」送出仍需要使用者手動確認，
  // 這裡只是自動把草稿準備好，不會真的自動寫進 Lark。

  // Jira：帳號 label 跟 Lark 成員名字用「關鍵字」對應（不是既有 applyJiraAuto() 的精確比對）——
  // 因為正式服帳號「Siara Lin」對不上 Lark 成員「Siara」，精確比對會失敗；這裡刻意寫一份獨立邏輯，
  // 不去改動既有 applyJiraAuto()（那支給手動「自動套用」按鈕用，範圍是全部帳號，精確比對比較安全，
  // 不該為了這 3 個人的特例放寬變成模糊比對，会影響到其他人手動使用時的準確度）。
  const autoJiraImportTriggeredRef = useRef(false)
  useEffect(() => {
    if (autoJiraImportTriggeredRef.current) return
    if (!parsed || !weekRangeInfo) return
    autoJiraImportTriggeredRef.current = true
    ;(async () => {
      try {
        let accounts = jiraAccountList
        if (accounts.length === 0) {
          const r = await fetch('/api/jira/accounts')
          const d = await r.json() as { ok: boolean; accounts?: Array<{ email: string; label: string }> }
          accounts = d.ok ? (d.accounts ?? []) : []
          setJiraAccountList(accounts)
        }
        const matchedAccounts = accounts.filter(a => matchesAutoImportTarget(a.label))
        if (matchedAccounts.length === 0) return
        setJiraPanelOpen(true)
        setJiraSelectedEmails(new Set(matchedAccounts.map(a => a.email)))

        setJiraLoading(true)
        const results = await Promise.all(matchedAccounts.map(async acc => {
          const r = await fetch('/api/weekly-report/jira-by-range', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-jira-email': acc.email },
            body: JSON.stringify({ startDate: weekRangeInfo.startDate, endDate: weekRangeInfo.endDate }),
          })
          const d = await r.json() as { ok: boolean; message?: string; issues?: RangeIssue[] }
          return { account: acc, ok: d.ok, message: d.message, issues: d.issues ?? [] }
        }))
        const failed = results.filter(r => !r.ok)
        const merged = new Map<string, RangeIssue & { accountLabels: string[] }>()
        for (const r of results) {
          if (!r.ok) continue
          for (const issue of r.issues) {
            const existing = merged.get(issue.key)
            if (existing) existing.accountLabels.push(r.account.label)
            else merged.set(issue.key, { ...issue, accountLabels: [r.account.label] })
          }
        }
        const issues = [...merged.values()]
        setJiraIssues(issues)
        setJiraChecked(new Set(issues.map(i => i.key)))
        if (failed.length > 0) setJiraMsg(`${failed.map(f => f.account.label).join('、')} 查詢失敗：${failed[0].message}`)

        if (!parsed) return
        // keyword → 目標 Lark 成員名字（用同一個關鍵字分別在帳號清單/成員清單各自找第一個符合的）
        const keywordToMember = new Map<string, string>()
        for (const kw of AUTO_IMPORT_TARGET_KEYWORDS) {
          const member = parsed.members.find(m => m.name.toLowerCase().includes(kw))
          if (member) keywordToMember.set(kw, member.name)
        }
        type GroupAcc = { person: string; projectId: string; projectName: string; keys: string[]; issues: { key: string; summary: string }[] }
        const groups = new Map<string, GroupAcc>()
        for (const iss of issues) {
          const matchedProject = matchLarkProjectByJiraName(iss.jiraProjectName, parsed.projects)
          const targetPersons = new Set<string>()
          for (const label of iss.accountLabels) {
            for (const [kw, member] of keywordToMember) {
              if (label.toLowerCase().includes(kw)) targetPersons.add(member)
            }
          }
          for (const person of targetPersons) {
            const groupKey = `${person}::${matchedProject?.name ?? ''}`
            let g = groups.get(groupKey)
            if (!g) { g = { person, projectId: matchedProject?.id ?? '', projectName: matchedProject?.name ?? '', keys: [], issues: [] }; groups.set(groupKey, g) }
            g.keys.push(iss.key)
            g.issues.push({ key: iss.key, summary: iss.summary })
          }
        }
        if (groups.size > 0) {
          setDraftEdits(prev => {
            const next = { ...prev }
            for (const g of groups.values()) {
              const item: DraftItem = { sourceRowId: `Jira · ${g.person}`, content: g.keys.join('、'), projectId: g.projectId, projectName: g.projectName, jiraIssues: g.issues }
              next[g.person] = [...(next[g.person] ?? []), item]
            }
            return next
          })
        }
      } catch {
        // 全自動載入失敗不用跳錯誤訊息干擾使用者——這條路徑只是省略手動點擊，失敗了使用者仍可以照
        // 原本手動流程操作，不影響功能可用性
      } finally {
        setJiraLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, weekRangeInfo])

  // 頁籤日期式報表：先自動觸發「開始查探」，等結果回來後（見下一個 effect）再自動勾選+套用
  const autoTabDateScanTriggeredRef = useRef(false)
  useEffect(() => {
    if (autoTabDateScanTriggeredRef.current) return
    if (!parsed) return
    autoTabDateScanTriggeredRef.current = true
    setTabDateOpen(true)
    handleTabDateScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed])

  const autoTabDateApplyTriggeredRef = useRef(false)
  useEffect(() => {
    if (autoTabDateApplyTriggeredRef.current) return
    if (!tabDateSources || !parsed) return
    autoTabDateApplyTriggeredRef.current = true
    const targetMembers = parsed.members.filter(m => matchesAutoImportTarget(m.name)).map(m => m.name)
    if (targetMembers.length === 0) return
    for (const src of tabDateSources) {
      for (const tab of src.matchedTabs) {
        applyTabDateItem(src.key, tab.sheetId, tab.title, targetMembers)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabDateSources, parsed])

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* topbar 已經顯示標題，這裡不重複顯示大標題，只留說明文字 */}
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>{t.sub}</div>

      {/* 頁首常駐週期 banner（2026-08-17）：即時時鐘 + 本次 Jira/週期撈取範圍，掛載時抓一次，
          不隨時鐘 tick 重新計算（跟 CodeX 討論定案，兩者關注點分開） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '9px 14px', background: 'var(--cr-cyan-soft)', border: '1px solid var(--cr-cyan-border)', borderRadius: 10, fontSize: 11.5, marginBottom: 14 }}>
        <span style={{ color: '#94a3b8' }}>現在時間：<b style={{ color: '#e2e8f0', fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{formatClock(nowClock)}</b></span>
        {weekRangeInfo ? (
          <span style={{ color: '#94a3b8' }}>本次資料撈取範圍：<b style={{ color: 'var(--cr-cyan)', fontFamily: 'ui-monospace, monospace' }}>{weekRangeInfo.startLabel} — {weekRangeInfo.endLabel}</b></span>
        ) : weekRangeError ? (
          <span style={{ color: 'var(--cr-rose)' }}><WarningIcon size={11} /> {weekRangeError}</span>
        ) : (
          <span style={{ color: '#64748b' }}>撈取範圍讀取中…</span>
        )}
      </div>

      {/* 定時備稿提醒（2026-08-27）：預設收合——這是「設定一次就不用再看」的東西，
          常駐展開會把真正要操作的 Step 1 推下去 */}
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', marginBottom: 14 }}>
        <button onClick={() => setReminderOpen(o => !o)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          <span style={{ color: '#64748b', fontSize: 10 }}>{reminderOpen ? '▼' : '▶'}</span>
          <span>定時備稿提醒</span>
          {reminder && (
            <span style={{ fontSize: 11, fontWeight: 500, color: reminder.enabled ? 'var(--cr-cyan)' : '#64748b' }}>
              {reminder.enabled ? '每' + WEEKDAY_LABELS[reminder.weekday] + ' ' + reminder.time + ' 發 Discord 提醒' : '未啟用'}
            </span>
          )}
        </button>

        {reminderOpen && (
          <div style={{ padding: '0 16px 14px', borderTop: '1px solid #263345', paddingTop: 12 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.75, marginBottom: 10 }}>
              到點只發一則 Discord 提醒，<b style={{ color: '#e2e8f0' }}>不會自動送出週報</b>。
              開頁面之後掃描／Jira 撈單／頁籤報表本來就會自己跑完備稿，內容確認過再自己按送出。
            </div>
            {!reminder ? (
              <div style={{ fontSize: 11, color: '#64748b' }}>讀取設定中…</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: '#cbd5e1', cursor: 'pointer' }}>
                  <input type="checkbox" checked={reminder.enabled} onChange={e => saveReminder({ enabled: e.target.checked })} />
                  <span>啟用</span>
                </label>
                <select value={reminder.weekday} onChange={e => saveReminder({ weekday: Number(e.target.value) })}
                  style={{ padding: '6px 9px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 11.5, fontFamily: 'inherit' }}>
                  {WEEKDAY_LABELS.map((w, i) => <option key={i} value={i}>每{w}</option>)}
                </select>
                <input type="time" value={reminder.time} onChange={e => e.target.value && saveReminder({ time: e.target.value })}
                  style={{ padding: '5px 9px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 11.5, fontFamily: 'ui-monospace, monospace' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: '#cbd5e1', cursor: 'pointer' }}>
                  <input type="checkbox" checked={reminder.mentionAll} onChange={e => saveReminder({ mentionAll: e.target.checked })} />
                  <span>@ 對照表裡的所有人</span>
                </label>
                <button onClick={testReminder}
                  style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, borderRadius: 7, background: 'transparent', border: '1px solid #2d3f55', color: '#94a3b8', cursor: 'pointer' }}>
                  試發送
                </button>
              </div>
            )}

            {/* 以誰的身分撈 Jira。**明確指定**而不是「誰最後在頁面跑過掃描」——後者會讓授權
                身分被誰路過決定，而且畫面上完全看不出來變了（2026-08-27 使用者要求改掉）。
                只能選自己；要選別人得是管理員（後端也會再擋一次，不只靠這裡的下拉限制）。 */}
            {reminder && reminderMeta && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #263345' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.7, marginBottom: 8 }}>
                  <b style={{ color: '#e2e8f0' }}>以誰的身分撈 Jira</b>——排程沒有登入者，要有一個人明確授權。
                  撈別人的單仍需要「Jira 代理張貼授權」，沒有的話那個帳號會被跳過並在訊息裡標明。
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <select value={reminder.jiraActorEmail ?? ''} onChange={e => saveReminder({ jiraActorEmail: e.target.value })}
                    style={{ padding: '6px 9px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 11.5, fontFamily: 'inherit', minWidth: 200 }}>
                    <option value="">（未指定）</option>
                    {reminderMeta.candidates
                      .filter(c => reminderMeta.me?.isAdmin || c.email.toLowerCase() === (reminderMeta.me?.email ?? '').toLowerCase())
                      .map(c => <option key={c.email} value={c.email}>{c.label}</option>)}
                  </select>
                  {!reminderMeta.me?.isAdmin && (
                    <span style={{ fontSize: 10.5, color: '#64748b' }}>只能指定自己；要指定別人需要管理員權限</span>
                  )}
                </div>
                {!reminder.jiraActorEmail && reminderMeta.effectiveJiraActor && (
                  <div style={{ fontSize: 10.5, color: '#d8b45a', marginTop: 7 }}>
                    尚未明確指定，目前會沿用最後一次跑掃描的人
                    {reminderMeta.fallbackActorLabel ? '（' + reminderMeta.fallbackActorLabel + '）' : ''}
                    ——那會隨著誰開過頁面而改變，建議明確指定一個。
                  </div>
                )}
                {!reminder.jiraActorEmail && !reminderMeta.effectiveJiraActor && (
                  <div style={{ fontSize: 10.5, color: 'var(--cr-rose)', marginTop: 7 }}>
                    還沒有任何身分可用，Discord 那條路不會撈 Jira。
                  </div>
                )}
              </div>
            )}

            {reminder && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
                {reminderSaving && <span style={{ fontSize: 11, color: '#64748b' }}>儲存中…</span>}
                {!reminderSaving && reminderMsg && <span style={{ fontSize: 11, color: reminderMsg.includes('失敗') ? 'var(--cr-rose)' : 'var(--cr-cyan)' }}>{reminderMsg}</span>}
              </div>
            )}
            {reminder?.enabled && reminderCron && (
              <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 9, fontFamily: 'ui-monospace, monospace' }}>
                cron：{reminderCron}（Asia/Taipei）｜Webhook 沿用「Discord 通知」設定頁那一組
              </div>
            )}
          </div>
        )}
      </div>

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
            <span>{parsed ? '✓' : <WarningIcon />}</span>
            <span>{parseMsg}</span>
          </div>
        )}
      </div>

      <BatchScanSection
          parsed={parsed}
          scanSheets={scanSheets}
          scanHeadersLoading={scanHeadersLoading}
          scanLoading={scanLoading}
          scanMsg={scanMsg}
          scanResult={scanResult}
          draftEdits={draftEdits}
          activePerson={activePerson}
          setActivePerson={setActivePerson}
          unidentifiedResolved={unidentifiedResolved}
          batchSubmitting={batchSubmitting}
          batchSubmitMsg={batchSubmitMsg}
          batchSubmitResult={batchSubmitResult}
          scanReady={scanReady}
          peopleList={peopleList}
          flatPreviewItems={flatPreviewItems}
          mergeOsm={mergeOsm}
          toggleMergeOsm={toggleMergeOsm}
          mergeableCount={mergeableCount}
          mergeJiraTags={mergeJiraTags}
          toggleMergeJiraTags={toggleMergeJiraTags}
          jiraTagAffected={jiraTagAffected}
          missingProjectTotal={missingProjectTotal}
          totalItemCount={totalItemCount}
          unresolvedUnidentifiedCount={unresolvedUnidentifiedCount}
          nameOnlyMembers={nameOnlyMembers}
          setNameOnlyMembersFor={setNameOnlyMembersFor}
          applyNameOnlySheet={applyNameOnlySheet}
          updateScanSheet={updateScanSheet}
          handleLoadSheetHeaders={handleLoadSheetHeaders}
          addScanSheet={addScanSheet}
          removeScanSheet={removeScanSheet}
          toggleScanContentColumn={toggleScanContentColumn}
          handleRunScan={handleRunScan}
          updateDraftItem={updateDraftItem}
          removeDraftItem={removeDraftItem}
          addDraftItem={addDraftItem}
          assignUnidentified={assignUnidentified}
          handleBatchSubmit={handleBatchSubmit}
          jiraPanelOpen={jiraPanelOpen}
          jiraAccountList={jiraAccountList}
          jiraSelectedEmails={jiraSelectedEmails}
          weekRangeInfo={weekRangeInfo}
          weekRangeError={weekRangeError}
          jiraLoading={jiraLoading}
          jiraMsg={jiraMsg}
          jiraIssues={jiraIssues}
          jiraChecked={jiraChecked}
          jiraTargetPerson={jiraTargetPerson}
          setJiraTargetPerson={setJiraTargetPerson}
          openJiraPanel={openJiraPanel}
          toggleJiraAccount={toggleJiraAccount}
          handleJiraRangeSearch={handleJiraRangeSearch}
          toggleJiraChecked={toggleJiraChecked}
          applyJiraToPerson={applyJiraToPerson}
          applyJiraAuto={applyJiraAuto}
          tabDateOpen={tabDateOpen}
          openTabDatePanel={openTabDatePanel}
          tabDateLoading={tabDateLoading}
          tabDateMsg={tabDateMsg}
          tabDateSources={tabDateSources}
          tabDateSourceErrors={tabDateSourceErrors}
          handleTabDateScan={handleTabDateScan}
          tabDateSelectedMembers={tabDateSelectedMembers}
          setTabDateMembersFor={setTabDateMembersFor}
          applyTabDateItem={applyTabDateItem}
        />
    </div>
  )
}

// ── 批次掃描審核區塊（2026-08-16）─────────────────────────────────────────
// 讀取來源 Sheet（欄位對應可能因 Sheet 而異，需要使用者自己選日期/填寫人/內容欄位）→ 掃描週五起始
// 時間窗內的列 → 依填寫人拆分成每人草稿、比對真實成員名單 → 依人員分組可編輯清單 → 唯讀預期結果
// 預覽（欄位對齊真實 Lark Base）→ 送出前統計 → 一次批次建立多筆記錄。
function BatchScanSection({
  parsed, scanSheets, scanHeadersLoading, scanLoading, scanMsg, scanResult,
  draftEdits, activePerson, setActivePerson, unidentifiedResolved,
  batchSubmitting, batchSubmitMsg, batchSubmitResult,
  scanReady, peopleList, flatPreviewItems, missingProjectTotal, totalItemCount, unresolvedUnidentifiedCount,
  mergeOsm, toggleMergeOsm, mergeableCount, mergeJiraTags, toggleMergeJiraTags, jiraTagAffected,
  updateScanSheet, handleLoadSheetHeaders, addScanSheet, removeScanSheet, toggleScanContentColumn,
  handleRunScan, updateDraftItem, removeDraftItem, addDraftItem, assignUnidentified, handleBatchSubmit,
  jiraPanelOpen, jiraAccountList, jiraSelectedEmails, weekRangeInfo, weekRangeError, jiraLoading, jiraMsg, jiraIssues, jiraChecked, jiraTargetPerson,
  setJiraTargetPerson, openJiraPanel, toggleJiraAccount, handleJiraRangeSearch, toggleJiraChecked, applyJiraToPerson, applyJiraAuto,
  tabDateOpen, openTabDatePanel, tabDateLoading, tabDateMsg, tabDateSources, tabDateSourceErrors,
  handleTabDateScan, tabDateSelectedMembers, setTabDateMembersFor, applyTabDateItem,
  nameOnlyMembers, setNameOnlyMembersFor, applyNameOnlySheet,
}: {
  parsed: ParsedTable | null
  scanSheets: ScanSheetConfig[]
  scanHeadersLoading: number | null
  scanLoading: boolean
  scanMsg: string
  scanResult: BatchScanResult | null
  draftEdits: Record<string, DraftItem[]>
  activePerson: string
  setActivePerson: (p: string) => void
  unidentifiedResolved: Set<number>
  batchSubmitting: boolean
  batchSubmitMsg: string
  batchSubmitResult: { successCount: number; failCount: number } | null
  scanReady: boolean
  peopleList: string[]
  flatPreviewItems: Array<{ person: string; item: DraftItem }>
  mergeOsm: boolean
  toggleMergeOsm: (v: boolean) => void
  mergeableCount: number
  mergeJiraTags: boolean
  toggleMergeJiraTags: (v: boolean) => void
  jiraTagAffected: number
  missingProjectTotal: number
  totalItemCount: number
  unresolvedUnidentifiedCount: number
  updateScanSheet: (idx: number, patch: Partial<ScanSheetConfig>) => void
  handleLoadSheetHeaders: (idx: number) => void
  addScanSheet: () => void
  removeScanSheet: (idx: number) => void
  toggleScanContentColumn: (idx: number, col: string) => void
  handleRunScan: () => void
  updateDraftItem: (person: string, index: number, patch: Partial<DraftItem>) => void
  removeDraftItem: (person: string, index: number) => void
  addDraftItem: (person: string) => void
  assignUnidentified: (index: number, member: string) => void
  handleBatchSubmit: () => void
  jiraPanelOpen: boolean
  jiraAccountList: Array<{ email: string; label: string }>
  jiraSelectedEmails: Set<string>
  weekRangeInfo: { startDate: string; endDate: string; startLabel: string; endLabel: string; todayLabel: string } | null
  weekRangeError: string
  jiraLoading: boolean
  jiraMsg: string
  jiraIssues: Array<RangeIssue & { accountLabels: string[] }> | null
  jiraChecked: Set<string>
  jiraTargetPerson: string
  setJiraTargetPerson: (v: string) => void
  openJiraPanel: () => void
  toggleJiraAccount: (email: string) => void
  handleJiraRangeSearch: () => void
  toggleJiraChecked: (key: string) => void
  applyJiraToPerson: () => void
  applyJiraAuto: () => void
  tabDateOpen: boolean
  openTabDatePanel: () => void
  tabDateLoading: boolean
  tabDateMsg: string
  tabDateSources: Array<{ key: string; label: string; matchedTabs: Array<{ sheetId: string; title: string }> }> | null
  tabDateSourceErrors: Array<{ key: string; label: string; message: string }>
  handleTabDateScan: () => void
  tabDateSelectedMembers: Record<string, Set<string>>
  setTabDateMembersFor: (tabKey: string, names: string[]) => void
  applyTabDateItem: (sourceKey: string, sheetId: string, title: string) => void
  nameOnlyMembers: Record<string, Set<string>>
  setNameOnlyMembersFor: (key: string, names: string[]) => void
  applyNameOnlySheet: (url: string, tabName: string) => void
}) {
  if (!parsed) {
    return (
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px', color: '#64748b', fontSize: 12.5 }}>
        請先在上方 Step 1 讀取 Lark Base 網址，才能開始批次掃描
      </div>
    )
  }

  const activeItems = draftEdits[activePerson] ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 14 }}>
      {/* 依時間範圍撈 Jira 單（可多選帳號）*/}
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px' }}>
        <button onClick={openJiraPanel} style={{ padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 7, background: jiraPanelOpen ? 'var(--cr-cyan-soft)' : 'transparent', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <CalendarIcon /> 依時間範圍撈 Jira 單（可多選帳號）
        </button>
        {jiraPanelOpen && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>帳號只是用來查詢 Jira（各自的 token 在後端），撈完之後手動選要塞進哪個人的哪個新項目，不會自動用帳號名字判斷歸屬</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {jiraAccountList.map(a => {
                const checked = jiraSelectedEmails.has(a.email)
                return (
                  <label key={a.email} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '3px 9px', borderRadius: 999, border: `1px solid ${checked ? 'var(--cr-cyan-border)' : '#2d3f55'}`, background: checked ? 'var(--cr-cyan-soft)' : 'transparent', color: checked ? 'var(--cr-cyan)' : '#94a3b8', cursor: 'pointer' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleJiraAccount(a.email)} style={{ accentColor: 'var(--cr-cyan)' }} />
                    {a.label}
                  </label>
                )
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                撈取範圍固定跟隨本週週期：
                {weekRangeInfo
                  ? <b style={{ color: 'var(--cr-cyan)', fontFamily: 'ui-monospace, monospace' }}>{weekRangeInfo.startLabel} — {weekRangeInfo.endLabel}</b>
                  : weekRangeError
                    ? <b style={{ color: 'var(--cr-rose)' }}><WarningIcon size={11} /> {weekRangeError}</b>
                    : <b style={{ color: '#64748b' }}>讀取中…</b>}
              </span>
              <button onClick={handleJiraRangeSearch} disabled={jiraLoading || jiraSelectedEmails.size === 0 || !weekRangeInfo}
                style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: jiraLoading ? 'default' : 'pointer', opacity: (jiraSelectedEmails.size === 0 || !weekRangeInfo) ? .5 : 1, height: 32 }}>
                {jiraLoading ? '查詢中…' : '查詢'}
              </button>
            </div>
            {jiraSelectedEmails.size === 0 && <div style={{ fontSize: 10.5, color: 'var(--cr-rose)', marginBottom: 8 }}>請至少勾選一個帳號</div>}
            {jiraSelectedEmails.size > 0 && !weekRangeInfo && (
              <div style={{ fontSize: 10.5, color: 'var(--cr-rose)', marginBottom: 8 }}>
                {weekRangeError ? '撈取範圍尚未取得，查詢按鈕暫時無法使用' : '撈取範圍讀取中，請稍候…'}
              </div>
            )}
            {jiraMsg && <div style={{ fontSize: 11, color: jiraMsg.startsWith('已自動加入') ? 'var(--cr-cyan)' : 'var(--cr-rose)', marginBottom: 10 }}>{jiraMsg}</div>}

            {jiraIssues && jiraIssues.length === 0 && <div style={{ fontSize: 11.5, color: '#64748b' }}>這段時間內沒有符合條件的 Jira 單</div>}
            {jiraIssues && jiraIssues.length > 0 && (
              <>
                <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #263345', borderRadius: 7 }}>
                  {jiraIssues.map(iss => (
                    <label key={iss.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', borderTop: '1px solid #263345', cursor: 'pointer' }}>
                      <input type="checkbox" checked={jiraChecked.has(iss.key)} onChange={() => toggleJiraChecked(iss.key)}
                        style={{ marginTop: 2, width: 15, height: 15, accentColor: 'var(--cr-cyan)', flexShrink: 0, cursor: 'pointer' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: '#e2e8f0' }}>
                          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 700, color: 'var(--cr-cyan)', background: 'var(--cr-cyan-soft)', padding: '1px 6px', borderRadius: 5, marginRight: 6 }}>{iss.key}</span>
                          {iss.summary}
                        </div>
                        <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{iss.status} · 來源帳號：{iss.accountLabels.join('、')}{iss.jiraProjectName ? ` · Jira 專案：${iss.jiraProjectName}` : ''}</div>
                      </div>
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button onClick={applyJiraAuto} disabled={jiraChecked.size === 0}
                    style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--xx-jade-solid)', color: '#fff', border: 'none', cursor: jiraChecked.size === 0 ? 'default' : 'pointer', opacity: jiraChecked.size === 0 ? .5 : 1 }}>
                    自動套用（依帳號建立項目）
                  </button>
                  <span style={{ fontSize: 10.5, color: '#64748b' }}>對不上成員名單的會自動擋下，保留在上面清單裡</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px dashed #263345' }}>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>或手動指定加入到哪個人：</span>
                  <SearchableSelect value={jiraTargetPerson} onChange={setJiraTargetPerson}
                    options={parsed.members} placeholder="選擇成員..." />
                  <button onClick={applyJiraToPerson} disabled={!jiraTargetPerson.trim() || jiraChecked.size === 0}
                    style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: (!jiraTargetPerson.trim() || jiraChecked.size === 0) ? 'default' : 'pointer', opacity: (!jiraTargetPerson.trim() || jiraChecked.size === 0) ? .5 : 1 }}>
                    套用（新增一個項目）
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 頁籤日期式報表（2026-08-17）：文件寫死在後端，沒有填寫人欄位，命中的頁籤標題整串當內容，
          全部手動指派給一或多個成員 */}
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px' }}>
        <button onClick={openTabDatePanel} style={{ padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 7, background: tabDateOpen ? 'var(--cr-cyan-soft)' : 'transparent', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: 'pointer' }}>
          查探頁籤日期式報表
        </button>
        {tabDateOpen && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>來源文件固定，只掃描頁籤標題開頭是本週日期的頁籤，命中的頁籤整個標題文字當一個項目；沒有填寫人欄位，全部手動勾選要歸給誰（可複選）</div>
            <button onClick={handleTabDateScan} disabled={tabDateLoading}
              style={{ padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: tabDateLoading ? 'default' : 'pointer', opacity: tabDateLoading ? .6 : 1, marginBottom: 10 }}>
              {tabDateLoading ? '查探中…' : '開始查探'}
            </button>
            {tabDateMsg && <div style={{ fontSize: 11, color: 'var(--cr-rose)', marginBottom: 10 }}>{tabDateMsg}</div>}

            {tabDateSourceErrors.length > 0 && (
              <div style={{ padding: '9px 12px', background: 'var(--cr-rose-soft, rgba(223,118,94,.12))', border: '1px solid rgba(223,118,94,.4)', borderRadius: 7, fontSize: 11, color: 'var(--cr-rose)', marginBottom: 10 }}>
                {tabDateSourceErrors.map(e => <div key={e.key}><WarningIcon size={11} /> {e.label}：{e.message}</div>)}
              </div>
            )}

            {tabDateSources && tabDateSources.every(s => s.matchedTabs.length === 0) && tabDateSourceErrors.length === 0 && (
              <div style={{ fontSize: 11.5, color: '#64748b' }}>本週範圍內沒有符合日期的頁籤</div>
            )}

            {tabDateSources && tabDateSources.map(src => src.matchedTabs.length === 0 ? null : (
              // 這層原本用 overflow:'hidden' 讓標題背景色跟著外框圓角裁切，但這樣連帶把下面
              // SearchableMultiSelect 往下展開的下拉選單也切掉（2026-08-17 使用者截圖回報「看不到
              // 人員名單」）——改成只在標題那格自己套圓角，外層不再需要 overflow:hidden 裁切
              <div key={src.key} style={{ border: '1px solid #263345', borderRadius: 8, marginBottom: 10 }}>
                <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,.03)', fontSize: 12, fontWeight: 700, borderRadius: '8px 8px 0 0' }}>{src.label}</div>
                {src.matchedTabs.map(tab => {
                  const tabKey = `${src.key}:${tab.sheetId}`
                  const selected = tabDateSelectedMembers[tabKey] ?? new Set<string>()
                  return (
                    <div key={tab.sheetId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderTop: '1px solid #263345', flexWrap: 'wrap' }}>
                      <span style={{ flex: 1, minWidth: 160, fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#e2e8f0' }}>{tab.title}</span>
                      <div style={{ width: 220, flexShrink: 0 }}>
                        <SearchableMultiSelect selected={[...selected]} onChange={names => setTabDateMembersFor(tabKey, names)}
                          options={parsed.members} placeholder="選擇成員（可複選）..." />
                      </div>
                      <button onClick={() => applyTabDateItem(src.key, tab.sheetId, tab.title)} disabled={selected.size === 0}
                        style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: selected.size === 0 ? 'default' : 'pointer', opacity: selected.size === 0 ? .5 : 1 }}>
                        套用（{selected.size || 0} 人）
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 來源 Sheet + 欄位對應 */}
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>來源 Sheet</div>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 12 }}>不同 Sheet 欄位可能長得不一樣，讀取表頭後自己選哪一欄是日期／填寫人／內容，設定一次即可，之後重新讀取同一份不用重選</div>

        {scanSheets.map((s, idx) => (
          <div key={idx} style={{ border: '1px solid #263345', borderRadius: 8, padding: '12px 14px', marginBottom: 10, background: '#0b1322' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input type="text" value={s.url} onChange={e => updateScanSheet(idx, { url: e.target.value })}
                placeholder="https://.../sheets/{token} 或 /wiki/{token}"
                style={{ flex: 1, padding: '7px 9px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12, fontFamily: 'inherit' }} />
              <button onClick={() => handleLoadSheetHeaders(idx)} disabled={scanHeadersLoading === idx || !s.url.trim()}
                style={{ padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: scanHeadersLoading === idx ? 'default' : 'pointer', opacity: scanHeadersLoading === idx ? .6 : 1, whiteSpace: 'nowrap' }}>
                {scanHeadersLoading === idx ? '讀取中…' : '讀取表頭'}
              </button>
              {scanSheets.length > 1 && (
                <button onClick={() => removeScanSheet(idx)}
                  style={{ padding: '6px 10px', fontSize: 11.5, borderRadius: 7, background: 'transparent', border: '1px solid #2d3f55', color: '#94a3b8', cursor: 'pointer' }}>
                  移除
                </button>
              )}
            </div>
            {s.headersMsg && <div style={{ fontSize: 10.5, color: s.headers.length ? '#64748b' : 'var(--cr-rose)', marginBottom: 8 }}>{s.headersMsg}</div>}

            {/* 只用表單名稱：這份表加進來只是要記「這週有處理它」，內容逐列展開反而是雜訊。
                勾了就不掃列，改成一個項目、內容就是表單名稱。**逐份獨立，不影響其他份**。
                讀到表頭才顯示——沒讀之前不知道表單叫什麼，勾了也沒東西可用。 */}
            {!!s.tabName && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8, fontSize: 11.5, color: '#cbd5e1', cursor: 'pointer' }}>
                <input type="checkbox" checked={s.nameOnly}
                  onChange={e => updateScanSheet(idx, { nameOnly: e.target.checked })} />
                <span>
                  只用表單名稱，不讀裡面的內容
                  <b style={{ color: 'var(--cr-cyan)', marginLeft: 6 }}>{s.tabName}</b>
                </span>
              </label>
            )}

            {s.nameOnly ? (
              <div style={{ padding: '9px 11px', borderRadius: 7, background: '#0f1a2e', border: '1px dashed #2d3f55' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.7, marginBottom: 8 }}>
                  這份表不會逐列掃描，也沒有填寫人欄位可以自動分類——直接勾要記給誰，
                  每個人各拿到一筆內容為「<b style={{ color: 'var(--cr-cyan)' }}>{s.tabName}</b>」的項目。
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ width: 240, flexShrink: 0 }}>
                    <SearchableMultiSelect selected={[...(nameOnlyMembers[s.url] ?? [])]}
                      onChange={names => setNameOnlyMembersFor(s.url, names)}
                      options={parsed.members} placeholder="選擇成員（可複選）..." />
                  </div>
                  <button onClick={() => applyNameOnlySheet(s.url, s.tabName)}
                    disabled={(nameOnlyMembers[s.url]?.size ?? 0) === 0}
                    style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: (nameOnlyMembers[s.url]?.size ?? 0) === 0 ? 'default' : 'pointer', opacity: (nameOnlyMembers[s.url]?.size ?? 0) === 0 ? .5 : 1 }}>
                    套用（{nameOnlyMembers[s.url]?.size ?? 0} 人）
                  </button>
                </div>
              </div>
            ) : s.headers.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginBottom: 4 }}>日期欄位 <span style={{ color: 'var(--cr-rose)' }}>必選</span></label>
                    <select value={s.dateColumn} onChange={e => updateScanSheet(idx, { dateColumn: e.target.value })}
                      style={{ padding: '6px 8px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', fontSize: 12 }}>
                      <option value="">請選擇...</option>
                      {s.headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginBottom: 4 }}>填寫人欄位 <span style={{ color: 'var(--cr-rose)' }}>必選</span></label>
                    <select value={s.personColumn} onChange={e => updateScanSheet(idx, { personColumn: e.target.value })}
                      style={{ padding: '6px 8px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', fontSize: 12 }}>
                      <option value="">請選擇...</option>
                      {s.headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginBottom: 4 }}>內容欄位（可複選，依勾選順序組合成備註）</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {s.headers.map(h => {
                      const checked = s.contentColumns.includes(h)
                      return (
                        <label key={h} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '3px 9px', borderRadius: 999, border: `1px solid ${checked ? 'var(--cr-cyan-border)' : '#2d3f55'}`, background: checked ? 'var(--cr-cyan-soft)' : 'transparent', color: checked ? 'var(--cr-cyan)' : '#94a3b8', cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked} onChange={() => toggleScanContentColumn(idx, h)} style={{ accentColor: 'var(--cr-cyan)' }} />
                          {h}
                        </label>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {scanSheets.length < 3 && (
            <button onClick={addScanSheet} style={{ padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, border: '1px dashed #2d3f55', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>
              ＋ 新增 Sheet
            </button>
          )}
          <button onClick={handleRunScan} disabled={!scanReady || scanLoading}
            style={{ padding: '7px 16px', fontSize: 12, fontWeight: 700, borderRadius: 7, background: (!scanReady || scanLoading) ? '#334155' : 'var(--xx-jade-solid)', color: '#fff', border: 'none', cursor: (!scanReady || scanLoading) ? 'default' : 'pointer' }}>
            {scanLoading ? '掃描中…' : '開始掃描'}
          </button>
          {!scanReady && <span style={{ fontSize: 10.5, color: '#64748b' }}>每個 Sheet 都要選好日期／填寫人／至少一個內容欄位才能掃描</span>}
        </div>
        {scanMsg && <div style={{ fontSize: 11, color: 'var(--cr-rose)', marginTop: 8 }}>{scanMsg}</div>}
      </div>

      {scanResult && (
        <>
          {/* 今天/撈取範圍已經在頁首常駐 banner 顯示，這裡只保留排除筆數警示（沒有排除筆數就不渲染） */}
          {(scanResult.stats.excludedOutOfRange + scanResult.stats.excludedUnparsableDate) > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '9px 14px', background: 'var(--warn-soft, rgba(224,180,95,.12))', border: '1px solid rgba(224,180,95,.4)', borderRadius: 10, fontSize: 11.5, color: '#e0b45f' }}>
              <WarningIcon /> 已排除範圍外 {scanResult.stats.excludedOutOfRange} 筆{scanResult.stats.excludedUnparsableDate > 0 ? `、日期無法解析 ${scanResult.stats.excludedUnparsableDate} 筆` : ''}
            </div>
          )}

          {scanResult.sourceErrors.length > 0 && (
            <div style={{ padding: '10px 14px', background: 'var(--cr-rose-soft, rgba(223,118,94,.12))', border: '1px solid rgba(223,118,94,.4)', borderRadius: 10, fontSize: 11.5, color: 'var(--cr-rose)', lineHeight: 1.7 }}>
              <WarningIcon /> {scanResult.sourceErrors.length} 個來源讀取失敗，掃描結果不完整（不是全部 Sheet 都掃到了）：
              {scanResult.sourceErrors.map((e, i) => (
                <div key={i}>Sheet {e.sheetIndex + 1}：{e.message}</div>
              ))}
            </div>
          )}

          {/* 統計 */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[
              { val: scanResult.stats.peopleCount, lbl: '識別到的人員' },
              { val: totalItemCount, lbl: '草稿項目' },
              { val: missingProjectTotal, lbl: '缺專案待補', warn: missingProjectTotal > 0 },
              { val: unresolvedUnidentifiedCount, lbl: '未識別人員', warn: unresolvedUnidentifiedCount > 0 },
            ].map((c, i) => (
              <div key={i} style={{ padding: '8px 14px', borderRadius: 8, background: '#0b1322', border: `1px solid ${c.warn ? 'var(--cr-rose)' : '#2d3f55'}`, minWidth: 96 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: c.warn ? 'var(--cr-rose)' : '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>{c.val}</div>
                <div style={{ fontSize: 10, color: '#64748b' }}>{c.lbl}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 以下不綁定 scanResult——就算沒跑過 Sheet 掃描（例如只用 Jira 撈單手動加項目），
          草稿清單/預覽/送出也要能正常運作，2026-08-16 修正「常態顯示」問題 */}

      {/* 依人員分組草稿 */}
      {peopleList.length > 0 && (
            <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>依人員分組草稿</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#94a3b8', cursor: 'pointer' }}>
                    <input type="checkbox" checked={mergeJiraTags} onChange={e => toggleMergeJiraTags(e.target.checked)} />
                    <span>Jira 單依標題中括號標籤歸集（[OSM][GM] + [OSM][後端] → OSM相關需求測試）</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#94a3b8', cursor: 'pointer' }}>
                    <input type="checkbox" checked={mergeOsm} onChange={e => toggleMergeOsm(e.target.checked)} />
                    <span>{MERGE_PROJECT_NAME} 每人各自合併成一條（補充說明寫「{MERGE_CONTENT}」）</span>
                  </label>
                </div>
              </div>
              {mergeJiraTags && jiraTagAffected > 0 && (
                <div style={{ fontSize: 11, color: 'var(--cr-cyan, #38bdf8)', marginBottom: 8, padding: '6px 10px', borderRadius: 6, background: 'rgba(56,189,248,.08)', border: '1px solid rgba(56,189,248,.25)' }}>
                  已開啟 Jira 標籤歸集：{jiraTagAffected} 個 Jira 項目會依標題標籤改寫成描述（同標籤的併成一條、不同標籤的各自拆成一條）。下面清單仍顯示原本的單號，關掉開關就恢復。
                </div>
              )}
              {mergeOsm && mergeableCount > 0 && (
                <div style={{ fontSize: 11, color: 'var(--cr-cyan, #38bdf8)', marginBottom: 12, padding: '6px 10px', borderRadius: 6, background: 'rgba(56,189,248,.08)', border: '1px solid rgba(56,189,248,.25)' }}>
                  已開啟合併：{MERGE_PROJECT_NAME} 共 {mergeableCount} 筆，會<b>依每個人各自</b>合併成一條送出（下面清單仍顯示原始逐筆，可繼續編輯；關掉開關就恢復）。實際會寫進 Lark 的內容以下方「預期結果」為準。
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {peopleList.map(p => (
                  <button key={p} onClick={() => setActivePerson(p)}
                    style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 999, border: `1px solid ${p === activePerson ? 'var(--cr-cyan-border)' : '#2d3f55'}`, background: p === activePerson ? 'var(--cr-cyan-soft)' : 'transparent', color: p === activePerson ? 'var(--cr-cyan)' : '#94a3b8', cursor: 'pointer' }}>
                    {p} <span style={{ fontSize: 10, opacity: .7 }}>{draftEdits[p]?.length ?? 0}</span>
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {activeItems.map((item, i) => (
                  <div key={i} style={{ border: '1px solid #263345', borderRadius: 8, background: '#0b1322', padding: '9px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ width: 200, flexShrink: 0 }}>
                      <SearchableSelect value={item.projectName}
                        onChange={v => updateDraftItem(activePerson, i, { projectName: v, projectId: parsed.projects.find(p => p.name === v)?.id ?? '' })}
                        options={parsed.projects} placeholder="選擇專案..." invalid={!item.projectName} />
                    </div>
                    <input type="text" value={item.content} onChange={e => updateDraftItem(activePerson, i, { content: e.target.value })}
                      style={{ flex: 1, minWidth: 160, padding: '7px 9px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', fontSize: 12 }} />
                    <span style={{ fontSize: 9.5, color: '#64748b', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>{item.sourceRowId}</span>
                    <button onClick={() => removeDraftItem(activePerson, i)}
                      style={{ width: 24, height: 24, borderRadius: 6, border: '1px solid #2d3f55', background: 'transparent', color: '#94a3b8', cursor: 'pointer', flexShrink: 0 }}>✕</button>
                  </div>
                ))}
                {activePerson && (
                  <button onClick={() => addDraftItem(activePerson)}
                    style={{ alignSelf: 'flex-start', padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, border: '1px dashed #2d3f55', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>
                    ＋ 新增項目
                  </button>
                )}
              </div>
            </div>
          )}

      {/* 未識別人員 */}
      {scanResult && scanResult.unidentified.length > 0 && unresolvedUnidentifiedCount > 0 && (
            <div style={{ border: '1px solid rgba(224,180,95,.4)', borderRadius: 10, background: 'rgba(224,180,95,.06)', padding: '18px 20px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4, color: '#e0b45f', display: 'flex', alignItems: 'center', gap: 6 }}><WarningIcon /> 未識別人員（不會被吞掉，需手動處理）</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>「填寫人」欄位有值，但比對不到現有成員名單裡的任何一個，決定要不要手動指派</div>
              {scanResult.unidentified.map((u, i) => unidentifiedResolved.has(i) ? null : (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 7, background: 'rgba(0,0,0,.15)', marginBottom: 6, fontSize: 12 }}>
                  <span style={{ fontWeight: 700, color: '#e0b45f', fontFamily: 'ui-monospace, monospace' }}>"{u.rawName}"</span>
                  <span style={{ flex: 1, color: '#94a3b8' }}>{u.content}</span>
                  <select onChange={e => { if (e.target.value) assignUnidentified(i, e.target.value) }} defaultValue=""
                    style={{ padding: '5px 8px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 6, color: '#e2e8f0', fontSize: 11.5 }}>
                    <option value="">指派給...</option>
                    {parsed.members.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                    <option value="__ignore__">忽略這筆</option>
                  </select>
                </div>
              ))}
            </div>
          )}

      {/* 預期結果預覽（唯讀，跟實際會寫進 Lark 的列一模一樣）——常態顯示，不用等有項目才出現，
          有項目就即時同步，沒有項目顯示空狀態，不管是來自 Sheet 掃描還是 Jira 撈單都一樣會反映在這裡 */}
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>預期結果（唯讀）</div>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 12 }}>跟實際會寫進 Lark 的列一模一樣，編輯上面的清單、或用 Jira 撈單套用後這裡會即時同步</div>
        {flatPreviewItems.length === 0 ? (
          <div style={{ fontSize: 11.5, color: '#64748b', padding: '10px 0' }}>尚無草稿項目——執行 Sheet 掃描或用上方「依時間範圍撈 Jira 單」加入項目後，這裡會即時顯示</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['No', '專案', '成員', '補充說明'].map(h => (
                    <th key={h} style={{ padding: '7px 10px', textAlign: 'left', background: '#0b1322', fontSize: 10.5, fontWeight: 700, color: '#64748b', borderBottom: '1px solid #2d3f55', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {flatPreviewItems.map(({ person, item }, i) => (
                  <tr key={i}>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #263345', color: '#64748b', whiteSpace: 'nowrap' }}>{i + 1}</td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #263345', whiteSpace: 'nowrap' }}>
                      {item.projectName
                        ? <span style={{ padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: 'rgba(96,165,250,.14)', color: '#60a5fa' }}>{item.projectName}</span>
                        : <span style={{ padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: 'var(--cr-rose-soft, rgba(223,118,94,.12))', color: 'var(--cr-rose)', border: '1px solid rgba(223,118,94,.4)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><WarningIcon size={11} /> 未選專案</span>}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #263345', whiteSpace: 'nowrap' }}>
                      <span style={{ padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: '#1a2436', color: '#e2e8f0' }}>{person}</span>
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #263345', color: '#e2e8f0' }}>{item.content}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 確認送出——常態顯示，沒有項目時鎖住按鈕 */}
      <div style={{ border: '1px solid var(--cr-cyan-border)', borderRadius: 10, background: '#10182a', padding: '18px 20px' }}>
        <div style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 12, lineHeight: 1.8 }}>
          {totalItemCount === 0 ? '尚無草稿項目可送出' : (
            <>
              將為 <b style={{ color: '#e2e8f0' }}>{peopleList.length}</b> 位成員建立共 <b style={{ color: '#e2e8f0' }}>{totalItemCount}</b> 筆記錄
              {unresolvedUnidentifiedCount > 0 && <>；還有 <b style={{ color: '#e0b45f' }}>{unresolvedUnidentifiedCount}</b> 筆未識別人員尚未處理（不影響送出，只是那幾筆不會被建立）</>}
              {missingProjectTotal > 0 && <><br />其中 <b style={{ color: 'var(--cr-rose)' }}>{missingProjectTotal}</b> 筆尚未選專案，送出前必須補齊</>}
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={handleBatchSubmit} disabled={batchSubmitting || missingProjectTotal > 0 || totalItemCount === 0}
            style={{ padding: '8px 18px', fontSize: 12.5, fontWeight: 700, borderRadius: 7, background: (batchSubmitting || missingProjectTotal > 0 || totalItemCount === 0) ? '#334155' : 'var(--xx-jade-solid)', color: '#fff', border: 'none', cursor: (batchSubmitting || missingProjectTotal > 0 || totalItemCount === 0) ? 'default' : 'pointer' }}>
            {batchSubmitting ? '送出中…' : missingProjectTotal > 0 ? `呈報宗門（尚有 ${missingProjectTotal} 筆缺專案，無法送出）` : '呈報宗門'}
          </button>
          {batchSubmitMsg && <span style={{ fontSize: 12, color: batchSubmitMsg.startsWith('通過') ? '#16a34a' : '#dc2626' }}>{batchSubmitMsg}</span>}
        </div>
        {batchSubmitResult && (
          <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 8 }}>
            上次送出：已建立 <b style={{ color: '#16a34a' }}>{batchSubmitResult.successCount}</b> 筆，失敗 <b style={{ color: batchSubmitResult.failCount ? 'var(--cr-rose)' : '#64748b' }}>{batchSubmitResult.failCount}</b> 筆
          </div>
        )}
      </div>
    </div>
  )
}

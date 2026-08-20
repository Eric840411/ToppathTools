/**
 * server/routes/weekly-report.ts
 * 週報彙整 — 獨立工具（不掛在 OSM Tools 底下）。每週貼上當週 Lark Base 網址，
 * 動態讀取「成员」/「专案」下拉選項，填寫補充說明後直接新增一列到該表。
 * 詳見 CLAUDE.md 第 23 節。
 */
import { Router } from 'express'
import { z } from 'zod'
import { addHistory, getLarkToken, mustEnv, userJiraAuth, parseLarkSheetUrl } from '../shared.js'

export const router = Router()

/** 週報「依時間範圍撈 Jira 單」——沿用 jira.ts 批次開單時寫入的驗證人員欄位 id，不用另外動態偵測 */
const WEEKLY_REPORT_VERIFIER_FIELD_ID = process.env.JIRA_VERIFIER_FIELD_ID ?? 'customfield_10440'

/** Lark Sheets API 儲存格可能是字串/數字/布林/富文本陣列/物件，統一抽出純文字（跟 jira.ts 的 extractCell 同一套邏輯） */
function extractSheetCell(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
  if (typeof cell === 'string') return cell
  if (Array.isArray(cell)) return (cell as Array<{ text?: string }>).map(run => run.text ?? '').join('')
  if (typeof cell === 'object') {
    const c = cell as Record<string, unknown>
    if (typeof c.text === 'string') return c.text
    if (Array.isArray(c.text)) return (c.text as Array<{ text?: string }>).map(t => t.text ?? '').join('')
    if (typeof c.value === 'string') return c.value
    if (c.value !== undefined && c.value !== null) return String(c.value)
  }
  return ''
}

/** Lark Sheets API 讀公式儲存格時給的是公式原始文字（例如 `"["&F2&"]["&E2&"]"&I2`），不是算好的結果
 *  （已用真實資料證實，見 CLAUDE.md 第 23 節）。這裡只處理最常見的「字串字面值 + 同列儲存格參照，用 & 串接」
 *  這個窄範圍樣式——不做通用公式引擎，任何不符合這個樣式的 token 都直接放棄評估、回傳 null 讓呼叫端保留原始文字，
 *  不會硬猜錯的結果。*/
function evaluateConcatFormula(formulaText: string, rowRaw: unknown[]): string | null {
  const tokens = formulaText.split('&').map(t => t.trim())
  if (tokens.length < 2) return null
  const parts: string[] = []
  for (const tok of tokens) {
    const strMatch = tok.match(/^"([^"]*)"$/)
    if (strMatch) { parts.push(strMatch[1]); continue }
    const cellMatch = tok.match(/^([A-Z]+)(\d+)$/)
    if (cellMatch) {
      let colIdx = 0
      for (const ch of cellMatch[1]) colIdx = colIdx * 26 + (ch.charCodeAt(0) - 64)
      colIdx -= 1 // 轉成 0-based array index
      parts.push(extractSheetCell(rowRaw[colIdx]))
      continue
    }
    return null // 不認得的 token 樣式，整條放棄，不猜
  }
  return parts.join('')
}

/** 判斷抽出來的文字看起來像公式原始碼而不是真正的內容——以 `"` 開頭、含 `&` 是這類字串串接公式的典型樣式，
 *  正常填寫的文字內容幾乎不會長這樣，用這個當偵測依據 */
function looksLikeFormulaText(text: string): boolean {
  return text.startsWith('"') && text.includes('&')
}

interface SheetTabResult { ok: true; tabName: string; headers: string[]; rows: Record<string, string>[] }
interface SheetTabError { ok: false; message: string }

/** 讀取一份 Lark Sheet（URL 有指定分頁就讀該分頁，沒有就讀第一個分頁），回傳分頁名稱＋表頭＋所有列 */
async function readLarkSheetTab(sheetUrl: string): Promise<SheetTabResult | SheetTabError> {
  const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)
  if (!spreadsheetToken) return { ok: false, message: '無法解析 Lark Sheet 網址' }

  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

  const metaResp = await fetch(`${base}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const metaData = await metaResp.json() as { code?: number; msg?: string; data?: { sheets?: Array<{ sheet_id: string; title: string }> } }
  if (!metaResp.ok || metaData.code !== 0) return { ok: false, message: `讀取分頁清單失敗：${metaData.msg ?? metaResp.statusText}` }
  const sheets = metaData.data?.sheets ?? []
  const target = sheetId ? sheets.find(s => s.sheet_id === sheetId) : sheets[0]
  if (!target) return { ok: false, message: '找不到分頁，請確認網址正確' }

  const range = `${target.sheet_id}!A1:ZZ2000`
  const dataResp = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await dataResp.json() as { code?: number; msg?: string; data?: { valueRange?: { values?: unknown[][] } } }
  if (!dataResp.ok || data.code !== 0) return { ok: false, message: `讀取內容失敗：${data.msg ?? dataResp.statusText}` }

  const raw = data.data?.valueRange?.values ?? []
  if (raw.length < 2) return { ok: true, tabName: target.title, headers: [], rows: [] }

  const headers = (raw[0] as unknown[]).map(extractSheetCell)
  const rows = raw.slice(1).map(r => {
    const rowRaw = r as unknown[]
    const rec: Record<string, string> = {}
    headers.forEach((h, i) => {
      if (!h) return
      let val = extractSheetCell(rowRaw[i])
      // 公式儲存格（例如常見的「摘要」欄位）讀到的是公式原始文字，不是算好的結果——嘗試評估
      // 窄範圍的字串串接公式，評估不出來就保留原始文字（不會比現況更糟，只是沒修到）
      if (looksLikeFormulaText(val)) {
        const evaluated = evaluateConcatFormula(val, rowRaw)
        if (evaluated !== null) val = evaluated
      }
      rec[h] = val
    })
    return rec
  }).filter(rec => Object.values(rec).some(v => v.trim()))

  return { ok: true, tabName: target.title, headers, rows }
}

interface SheetTabsListResult { ok: true; tabs: Array<{ sheetId: string; title: string }> }
interface SheetTabsListError { ok: false; message: string }

/** 列出一份 Lark Sheet 文件底下所有頁籤（sheetId+title），不讀內容——給「頁籤日期式報表」掃描用。
 *  刻意跟 readLarkSheetTab() 各自獨立、不共用內部邏輯（CodeX review 建議），避免影響既有的一欄式
 *  Sheet 流程；兩者都是打同一支 sheets/v3/.../sheets/query metadata API，只是這裡要全部頁籤不挑一個。*/
async function listLarkSheetTabs(spreadsheetToken: string): Promise<SheetTabsListResult | SheetTabsListError> {
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const metaResp = await fetch(`${base}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const metaData = await metaResp.json() as { code?: number; msg?: string; data?: { sheets?: Array<{ sheet_id: string; title: string }> } }
  if (!metaResp.ok || metaData.code !== 0) return { ok: false, message: `讀取分頁清單失敗：${metaData.msg ?? metaResp.statusText}` }
  return { ok: true, tabs: (metaData.data?.sheets ?? []).map(s => ({ sheetId: s.sheet_id, title: s.title })) }
}

/** 「頁籤日期式報表」固定來源（2026-08-17，使用者要求寫死——文件本身固定不變，只有頁籤持續新增，
 *  不需要使用者每次貼網址）。spreadsheetToken 從使用者提供的網址解析出來，不吃前端輸入。
 *  2026-08-17 使用者澄清：JjLosMhsShlrfatriEBlX3d7gLd（OSM需求單）其實不是這種頁籤日期式
 *  結構，是一般的一欄式 Sheet（有 日期/填寫人 欄位），要走「來源 Sheet 第一筆自動導入」那條路，
 *  不屬於這裡——一度誤加進來，已移除。report1 的 label 原本是「測種測試表」（Lark 文件本身的名稱），
 *  同一天使用者要求改成「線上機台測試表單」這個對外顯示用的名字。 */
const TAB_DATE_REPORT_SOURCES: Array<{ key: string; label: string; spreadsheetToken: string }> = [
  { key: 'report1', label: '線上機台測試表單', spreadsheetToken: 'JFplspG3Mh8LAXtFxsRlSgTRgmg' },
]

/** 頁籤標題開頭抓 8 位數日期（例如「20260811 NP 5台」→ 2026-08-11），驗證是合法日曆日期；
 *  解析不出來（例如可能存在的說明/範本頁籤）回傳 null，不當成命中也不當成錯誤，直接跳過 */
function parseTabTitleDate(title: string): Date | null {
  const m = title.match(/^(\d{4})(\d{2})(\d{2})/)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (!isValidCalendarDate(y, mo, d)) return null
  return new Date(Date.UTC(y, mo - 1, d))
}

/** 解析 Lark Base 網址（/base/{appToken}?table={tableId}），跟 parseLarkSheetUrl（/sheets、/wiki 用）是不同格式 */
function parseLarkBaseUrl(url: string): { appToken: string; tableId: string } | null {
  const appMatch = url.match(/\/base\/([A-Za-z0-9]+)/)
  const tableMatch = url.match(/[?&]table=([A-Za-z0-9]+)/)
  if (!appMatch || !tableMatch) return null
  return { appToken: appMatch[1], tableId: tableMatch[1] }
}

const REQUIRED_FIELDS = ['成员', '专案', '补充说明'] as const

interface LarkFieldOption { id: string; name: string }
interface LarkField { field_name: string; type: number; property?: { options?: { id: string; name: string }[] } | null }

// POST /api/weekly-report/parse — 貼上網址，讀取欄位選項並驗證必要欄位存在
router.post('/api/weekly-report/parse', async (req, res) => {
  const body = z.object({ url: z.string().min(1) }).parse(req.body)
  const parsed = parseLarkBaseUrl(body.url)
  if (!parsed) return res.status(400).json({ ok: false, message: '網址格式不正確，需要包含 /base/{appToken} 與 ?table={tableId}' })

  try {
    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${parsed.appToken}/tables/${parsed.tableId}/fields?page_size=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await resp.json() as { code?: number; msg?: string; data?: { items?: LarkField[] } }
    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: `讀取表格失敗：${data.msg ?? resp.statusText}（請確認網址正確、且此帳號有存取權限）` })
    }
    const fields = data.data?.items ?? []
    const fieldNames = new Set(fields.map(f => f.field_name))
    const missingFields = REQUIRED_FIELDS.filter(f => !fieldNames.has(f))
    if (missingFields.length > 0) {
      return res.status(400).json({ ok: false, message: `這張表缺少必要欄位：${missingFields.join('、')}`, missingFields })
    }

    const memberField = fields.find(f => f.field_name === '成员')
    const projectField = fields.find(f => f.field_name === '专案')
    const members: LarkFieldOption[] = (memberField?.property?.options ?? []).map(o => ({ id: o.id, name: o.name }))
    const projects: LarkFieldOption[] = (projectField?.property?.options ?? []).map(o => ({ id: o.id, name: o.name }))

    res.json({ ok: true, appToken: parsed.appToken, tableId: parsed.tableId, members, projects })
  } catch (e) {
    res.status(500).json({ ok: false, message: `讀取失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

// POST /api/weekly-report/jira-by-range — 依時間範圍撈這個人的 Jira 單
// 2026-08-11 討論結論：拿掉原本設計的 operation_history 來源（雜訊太多），改成單純撈
// Jira——reporter 是這個人「或」QA驗證人員是這個人，符合其一即列出；created 或 updated
// 落在時間範圍內都算，不限工作流程階段。驗證人員欄位沿用 jira.ts 批次開單時寫入的同一個
// customfield id，不用另外動態偵測。不限制 project，撈這個人 token 能看到的所有專案。
router.post('/api/weekly-report/jira-by-range', async (req, res) => {
  try {
    // 這支端點是既有的「跨帳號讀取」正式功能：週報彙整的全自動載入會用 Eric／Lusa／Siara 三個
    // 帳號的 email 平行呼叫，各自用各自的 token 撈自己的單（v4.5.0）。userJiraAuth() 2026-08-20
    // 起預設只允許本人，所以這裡必須明確標成代理讀取，否則週報會當場壞掉。過渡期先 fallback 放行
    // 並印 JIRA_DELEGATION_FALLBACK_ALLOW 警告，等實際用到的關係都補進授權表後再關掉 fallback。
    const userAuth = userJiraAuth(req, { allowDelegationScope: 'jira.read.asOther', fallbackAllowUnauthorized: true })
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { startDate, endDate } = z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body)

    // 結束日 +1 天、用 `<` 排除，避免 Jira 日期只算到當天 00:00 的邊界問題
    const endExclusive = new Date(`${endDate}T00:00:00Z`)
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
    const endExclusiveStr = endExclusive.toISOString().slice(0, 10)

    // 2026-08-20 修正：原本查寫死的 cf[10440]，但「QA驗證人員」在這個 Jira 實例是**每個專案
    // 各自一個自訂欄位**（列 /rest/api/3/field 有三十幾個同名的 people 欄位），10440 只是 DSFT
    // 專案在用的那一個。結果是「QA驗證人員是我」這個條件長期只對一個專案有效，其他專案全部漏抓
    // （真實案例：P5MA-9303 的 QA驗證人員確實有 Eric Wu，但那個專案用的是 cf[10087]，撈不到）。
    // 改用欄位名稱查詢，Jira 會跨所有同名欄位比對。已實測確認是超集合不是替換：
    // project = DSFT AND cf[10440] = currentUser() 與 project = DSFT AND "QA驗證人員" = currentUser()
    // 回傳完全相同的單，而後者另外還抓得到 P5MA／P5BU／LBCMS／HYSL 等專案的單。
    const jql = `(reporter = currentUser() OR "QA驗證人員" = currentUser()) AND ((created >= "${startDate}" AND created < "${endExclusiveStr}") OR (updated >= "${startDate}" AND updated < "${endExclusiveStr}")) ORDER BY updated DESC`

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const resp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        maxResults: 200,
        fields: ['summary', 'status', 'created', 'updated', 'reporter', 'project', WEEKLY_REPORT_VERIFIER_FIELD_ID],
      }),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return res.json({ ok: false, message: `Jira 查詢失敗 HTTP ${resp.status}：${errText.slice(0, 200)}` })
    }
    type JiraSearchIssue = {
      key: string
      fields: {
        summary?: string
        status?: { name?: string }
        created?: string
        updated?: string
        reporter?: { accountId?: string }
        project?: { name?: string; key?: string }
        [key: string]: unknown
      }
    }
    const data = (await resp.json()) as { issues?: JiraSearchIssue[] }
    const meAccountId = await resolveMyAccountId(baseUrl, userAuth.auth)

    const seen = new Set<string>()
    const issues = (data.issues ?? [])
      .filter(i => {
        if (seen.has(i.key)) return false
        seen.add(i.key)
        return true
      })
      .map(i => {
        const verifierField = i.fields[WEEKLY_REPORT_VERIFIER_FIELD_ID]
        const verifierIds: string[] = Array.isArray(verifierField)
          ? verifierField.map((v: unknown) => (v as { accountId?: string })?.accountId).filter((x): x is string => !!x)
          : verifierField && typeof verifierField === 'object'
            ? [((verifierField as { accountId?: string }).accountId ?? '')].filter(Boolean)
            : []
        const isReporter = meAccountId ? i.fields.reporter?.accountId === meAccountId : false
        // 我們只拿得到 WEEKLY_REPORT_VERIFIER_FIELD_ID 這一個欄位的值，但每個專案的「QA驗證人員」
        // 是不同的 customfield id，其他專案的值不在回應裡。用 JQL 語意反推：條件是
        // (reporter = 我 OR QA驗證人員 = 我)，所以「不是 reporter 卻被撈出來」的唯一可能就是驗證人員。
        // 已知代價：既是 reporter 又是驗證人員、但該專案驗證人員在其他欄位 id 的單，會被標成
        // reporter 而不是 both——只是標籤精細度，不影響有沒有撈到。
        const isVerifierByField = meAccountId ? verifierIds.includes(meAccountId) : false
        const isVerifier = isVerifierByField || !isReporter
        return {
          key: i.key,
          summary: i.fields.summary ?? '',
          status: i.fields.status?.name ?? '',
          created: i.fields.created ?? '',
          updated: i.fields.updated ?? '',
          // 拿不到自己的 accountId 時（/myself 失敗）根本無從判斷身分——舊寫法會讓 isReporter
          // 一律 false，配合上面的反推就會把所有單都標成 verifier，等於用一個假答案蓋掉「不知道」。
          // 標成 unknown 誠實得多（CodeX review 指出）。
          role: !meAccountId ? 'unknown' : isReporter && isVerifier ? 'both' : isVerifier ? 'verifier' : 'reporter',
          jiraProjectName: i.fields.project?.name ?? '',
        }
      })

    res.json({ ok: true, issues })
  } catch (e) {
    res.status(500).json({ ok: false, message: `查詢失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

/** 取得目前 Jira token 擁有者的 accountId，用來判斷每張單是因為 reporter 還是驗證人員身份被撈出來 */
async function resolveMyAccountId(baseUrl: string, auth: string): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl}/rest/api/3/myself`, { headers: { Authorization: auth, Accept: 'application/json' } })
    if (!resp.ok) return null
    const data = await resp.json() as { accountId?: string }
    return data.accountId ?? null
  } catch {
    return null
  }
}

// POST /api/weekly-report/sheet-headers — 欄位對應設定用，讀一份 Sheet 只回表頭（不同來源 Sheet 欄位可能長得不一樣，需要使用者自己選哪欄是日期/填寫人/內容）
router.post('/api/weekly-report/sheet-headers', async (req, res) => {
  try {
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body)
    const result = await readLarkSheetTab(url)
    if (result.ok === false) return res.json({ ok: false, message: result.message })
    // 讀取範圍固定到 ZZ 欄，實際表格通常沒用到那麼多欄，空白表頭（含重複空字串）過濾掉，不然下拉選單會被灌爆
    const headers = [...new Set(result.headers.filter(h => h.trim()))]
    res.json({ ok: true, tabName: result.tabName, headers })
  } catch (e) {
    res.status(500).json({ ok: false, message: `讀取失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

// ── 批次掃描審核（2026-08-16，跟 CodeX 討論定案的設計）─────────────────────
// 從「個人自助送出、成員手動選一次」改成「掃描來源 Sheet、抓出所有出現的人、一次幫全部人產草稿」。
// sourceRow／draftItem 資料分離（CodeX 建議）：draftItem 永遠帶著 sourceRowId，可回溯是哪一列展開出來的。

/** 週期固定「週五 00:00 ～ 下週四 23:59:59」，本地時區（Asia/Taipei）固定算，不用 UTC 當下時間
 *  今天剛好是週五時起日就是今天；週四時屬於上一個週五開的週期。不用特判跨月跨年，單純日期加減。 */
function getFridayAnchoredWeekRange(): { startUTC: Date; endUTC: Date; startLabel: string; endLabel: string; todayLabel: string } {
  const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六']
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const y = Number(parts.find(p => p.type === 'year')!.value)
  const m = Number(parts.find(p => p.type === 'month')!.value)
  const d = Number(parts.find(p => p.type === 'day')!.value)
  const todayUTC = new Date(Date.UTC(y, m - 1, d))

  const dow = todayUTC.getUTCDay() // 0=Sun ... 5=Fri ... 6=Sat
  const daysSinceFriday = (dow - 5 + 7) % 7
  const startUTC = new Date(todayUTC)
  startUTC.setUTCDate(startUTC.getUTCDate() - daysSinceFriday)
  const endUTC = new Date(startUTC)
  endUTC.setUTCDate(endUTC.getUTCDate() + 6)

  const fmt = (dt: Date) => `${dt.getUTCFullYear()}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}（${WEEKDAY_LABEL[dt.getUTCDay()]}）`
  return { startUTC, endUTC, startLabel: fmt(startUTC), endLabel: fmt(endUTC), todayLabel: fmt(todayUTC) }
}

// GET /api/weekly-report/week-range — 目前週五起始週期的邊界，給前端頁首常駐 banner 顯示、也給
// 「依時間範圍撈 Jira 單」當查詢參數用（2026-08-17，取代原本手動選日期，固定跟 Sheet 掃描同一套週期）。
// startDate/endDate 直接從 startUTC/endUTC slice ISO 字串取得——這兩個 Date 是用 Date.UTC(y,m-1,d) 疊
// 純日曆年月日組出來的，不是真正的 UTC 時間點，slice(0,10) 拿到的年月日不會因時區換算跑掉。
router.get('/api/weekly-report/week-range', (req, res) => {
  const { startUTC, endUTC, startLabel, endLabel, todayLabel } = getFridayAnchoredWeekRange()
  res.json({
    ok: true,
    startDate: startUTC.toISOString().slice(0, 10),
    endDate: endUTC.toISOString().slice(0, 10),
    startLabel, endLabel, todayLabel,
  })
})

// GET /api/weekly-report/tab-date-scan — 「頁籤日期式報表」（2026-08-17，跟 CodeX 討論定案）：文件
// 固定寫死在 TAB_DATE_REPORT_SOURCES，沒有填寫人欄位、頁籤標題本身就是日期，不走一欄式 Sheet 那套
// 掃描邏輯。每份文件各自讀取失敗互不影響（回 sourceErrors，不整支端點失敗），比照 batch-scan 的做法。
router.get('/api/weekly-report/tab-date-scan', async (req, res) => {
  try {
    const { startUTC, endUTC, startLabel, endLabel, todayLabel } = getFridayAnchoredWeekRange()
    const sources: Array<{ key: string; label: string; matchedTabs: Array<{ sheetId: string; title: string }> }> = []
    const sourceErrors: Array<{ key: string; label: string; message: string }> = []

    for (const src of TAB_DATE_REPORT_SOURCES) {
      const result = await listLarkSheetTabs(src.spreadsheetToken)
      if (result.ok === false) {
        sourceErrors.push({ key: src.key, label: src.label, message: result.message })
        continue
      }
      const matchedTabs = result.tabs.filter(t => {
        const d = parseTabTitleDate(t.title)
        return d !== null && d.getTime() >= startUTC.getTime() && d.getTime() <= endUTC.getTime()
      })
      sources.push({ key: src.key, label: src.label, matchedTabs })
    }

    res.json({ ok: true, weekRange: { startLabel, endLabel, todayLabel }, sources, sourceErrors })
  } catch (e) {
    res.status(500).json({ ok: false, message: `掃描失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

const LARK_DATE_SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30)
function isValidCalendarDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return d <= daysInMonth
}

/** 來源 Sheet 的日期欄位可能是 Lark 序列數字（跟 Jira 開單帶入功能踩過同一種坑）或 YYYY-MM-DD／YYYY/MM/DD 字串，回傳 UTC 午夜 Date 或 null（無法解析） */
function parseSheetDateCell(raw: string): Date | null {
  const v = raw.trim()
  if (!v) return null
  if (/^\d+$/.test(v)) {
    const serial = parseInt(v, 10)
    const ms = LARK_DATE_SERIAL_EPOCH_MS + serial * 86400000
    const dt = new Date(ms)
    const y = dt.getUTCFullYear()
    if (y < 1900 || y > 2447) return null
    return new Date(Date.UTC(y, dt.getUTCMonth(), dt.getUTCDate()))
  }
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
    if (!isValidCalendarDate(y, mo, d)) return null
    return new Date(Date.UTC(y, mo - 1, d))
  }
  return null
}

/** 拆分「填寫人」欄位——真實資料證實是純文字逗號分隔（"Eric Wu,Jack"），不是 Lark 結構化多選欄位；
 *  也防禦半形/全形逗號、頓號混用，並排除字面上就是欄位表頭本身的殘留（真實資料出現過這種情況） */
function splitPersonCell(raw: string, columnHeader: string): string[] {
  return raw.split(/[,，、]/).map(s => s.trim()).filter(s => s && s.toLowerCase() !== columnHeader.trim().toLowerCase())
}

/** 內容欄位比對專案的 fallback：找「最長」命中的內容欄位值（不是第一個命中就用），且最短 3 字元才參與比對
 *  （CodeX review：原本 >=2 字元太寬鬆，"v2"/"QA" 這類泛用短字容易誤配到不相關的專案；3 字元門檻仍保留
 *  "OSM" 這類已用真實資料驗證過的合法短代碼可以命中，只排除更容易誤判的極短泛用字） */
function findBestProjectByContentColumns(projects: LarkFieldOption[], contentColumns: string[], row: Record<string, string>): LarkFieldOption | undefined {
  let best: LarkFieldOption | undefined
  let bestLen = 0
  for (const p of projects) {
    if (!p.name) continue
    for (const c of contentColumns) {
      const v = (row[c] ?? '').trim()
      if (v.length >= 3 && v.length > bestLen && p.name.toLowerCase().includes(v.toLowerCase())) {
        best = p
        bestLen = v.length
      }
    }
  }
  return best
}

interface SheetColumnMapping { url: string; dateColumn: string; personColumn: string; contentColumns: string[] }
interface DraftItem { sourceRowId: string; content: string; projectId: string; projectName: string }

// POST /api/weekly-report/batch-scan
router.post('/api/weekly-report/batch-scan', async (req, res) => {
  try {
    const { sheets, members, projects } = z.object({
      sheets: z.array(z.object({
        url: z.string().min(1),
        dateColumn: z.string().min(1),
        personColumn: z.string().min(1),
        contentColumns: z.array(z.string()).min(1),
      })).min(1).max(3),
      members: z.array(z.string()),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }).parse(req.body) as { sheets: SheetColumnMapping[]; members: string[]; projects: LarkFieldOption[] }

    const { startUTC, endUTC, startLabel, endLabel, todayLabel } = getFridayAnchoredWeekRange()
    const memberSet = new Map(members.map(m => [m.trim().toLowerCase(), m]))

    const draftsByPerson: Record<string, DraftItem[]> = {}
    const unidentified: Array<{ sourceRowId: string; rawName: string; content: string }> = []
    const sourceErrors: Array<{ sheetIndex: number; message: string }> = []
    let excludedOutOfRange = 0
    let excludedUnparsableDate = 0

    for (let sIdx = 0; sIdx < sheets.length; sIdx++) {
      const sheet = sheets[sIdx]
      const result = await readLarkSheetTab(sheet.url)
      // 讀取失敗的來源不靜默略過（CodeX review：多來源時會變成「看起來掃描成功但其實少一份」），
      // 記錄下來讓前端明確顯示是哪個來源失敗，但仍繼續處理其他成功的來源，不整個擋下來
      if (result.ok === false) {
        sourceErrors.push({ sheetIndex: sIdx, message: result.message })
        continue
      }

      result.rows.forEach((row, rIdx) => {
        const sourceRowId = `${sIdx}-${rIdx}`
        const dateRaw = row[sheet.dateColumn] ?? ''
        const dateVal = parseSheetDateCell(dateRaw)
        if (dateVal === null) {
          if (dateRaw.trim()) excludedUnparsableDate++
          return
        }
        if (dateVal.getTime() < startUTC.getTime() || dateVal.getTime() > endUTC.getTime()) {
          excludedOutOfRange++
          return
        }

        const personRaw = row[sheet.personColumn] ?? ''
        const names = splitPersonCell(personRaw, sheet.personColumn)
        if (names.length === 0) return

        const content = sheet.contentColumns.map(c => (row[c] ?? '').trim()).filter(Boolean).join(' ')
        if (!content) return

        const matchedProject = projects.find(p => p.name && content.toLowerCase().includes(p.name.toLowerCase()))
          ?? findBestProjectByContentColumns(projects, sheet.contentColumns, row)

        for (const name of names) {
          const knownMember = memberSet.get(name.toLowerCase())
          if (knownMember) {
            if (!draftsByPerson[knownMember]) draftsByPerson[knownMember] = []
            draftsByPerson[knownMember].push({
              sourceRowId, content,
              projectId: matchedProject?.id ?? '', projectName: matchedProject?.name ?? '',
            })
          } else {
            unidentified.push({ sourceRowId, rawName: name, content })
          }
        }
      })
    }

    const itemCount = Object.values(draftsByPerson).reduce((sum, items) => sum + items.length, 0)
    const missingProjectCount = Object.values(draftsByPerson).reduce((sum, items) => sum + items.filter(i => !i.projectId).length, 0)

    res.json({
      ok: true,
      weekRange: { startLabel, endLabel, todayLabel },
      stats: {
        peopleCount: Object.keys(draftsByPerson).length,
        itemCount,
        missingProjectCount,
        unidentifiedCount: unidentified.length,
        excludedOutOfRange,
        excludedUnparsableDate,
      },
      draftsByPerson,
      unidentified,
      sourceErrors,
    })
  } catch (e) {
    res.status(500).json({ ok: false, message: `掃描失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

// POST /api/weekly-report/batch-submit — 一次建立多筆記錄，逐筆送出、個別記錄成功/失敗（不做同批 all-or-nothing），
// append-only 不 PATCH（跟既有 /submit 同一個併發考量：見上方單筆 submit 端點註解）
router.post('/api/weekly-report/batch-submit', async (req, res) => {
  // 整個 handler 包在 try/catch 裡（CodeX review：原本 z.parse/getLarkToken 在 try 外面，跟其他端點
  // 的錯誤格式不一致，未捕捉的例外會變成非 JSON 的預設錯誤頁而不是 { ok:false, message }）
  try {
    const body = z.object({
      appToken: z.string().min(1),
      tableId: z.string().min(1),
      items: z.array(z.object({
        member: z.string().min(1),
        project: z.string().optional(),
        content: z.string().min(1),
      })).min(1).max(200),
    }).parse(req.body)

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const results: Array<{ index: number; ok: boolean; recordId?: string; message?: string }> = []

    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]
      try {
        const fields: Record<string, string> = { '成员': item.member, '补充说明': item.content }
        if (item.project) fields['专案'] = item.project

        const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${body.appToken}/tables/${body.tableId}/records`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }),
        })
        const data = await resp.json() as { code?: number; msg?: string; data?: { record?: { record_id?: string } } }
        if (!resp.ok || data.code !== 0) {
          results.push({ index: i, ok: false, message: data.msg ?? resp.statusText })
        } else {
          results.push({ index: i, ok: true, recordId: data.data?.record?.record_id ?? '' })
        }
      } catch (e) {
        results.push({ index: i, ok: false, message: e instanceof Error ? e.message : String(e) })
      }
    }

    const successCount = results.filter(r => r.ok).length
    const failCount = results.length - successCount

    addHistory('weekly-report', `週報彙整（批次）— ${successCount} 筆成功`,
      body.items.slice(0, 10).map(i => `${i.member}：${i.content}`).join('\n').slice(0, 300),
      { appToken: body.appToken, tableId: body.tableId, itemCount: body.items.length, successCount, failCount })

    res.json({ ok: true, results, successCount, failCount })
  } catch (e) {
    res.status(500).json({ ok: false, message: `送出失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})


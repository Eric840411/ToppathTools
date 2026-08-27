/**
 * server/routes/weekly-report.ts
 * 週報彙整 — 獨立工具（不掛在 OSM Tools 底下）。每週貼上當週 Lark Base 網址，
 * 動態讀取「成员」/「专案」下拉選項，填寫補充說明後直接新增一列到該表。
 * 詳見 CLAUDE.md 第 23 節。
 */
import { Router } from 'express'
import { z } from 'zod'
import cron from 'node-cron'
import { createHash } from 'crypto'
import {
  addHistory, db, getLarkToken, mustEnv, userJiraAuth, parseLarkSheetUrl,
  hasJiraDelegation, jiraAuthForAccount, readAccounts, authEmailFromRequest,
} from '../shared.js'
// 週報呈現規則前後端共用同一份——server 這邊要算出「跟頁面一模一樣的內容」才能讓 Discord
// 按鈕直接送出。複製一份到 server 的話，之後改規則會漏一邊，症狀是送出去的跟看到的不一樣。
import {
  applyDefaultScanSheetProject, buildPreviewItems,
  matchesAutoImportTarget, groupJiraIssuesToDrafts,
  type DraftItem as SharedDraftItem, type FlatItem,
} from '../../shared/weekly-report-rules.js'

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
/** 讀週報 Lark Base 的成員/專案下拉選項。抽出來讓定時提醒的預覽也能用同一份讀法，
 *  不用在 cron 那邊再寫一次欄位判斷。失敗一律回 { ok: false, message }，
 *  呼叫端自己決定要回 400 還是靜靜跳過。*/
async function loadWeeklyBaseOptions(url: string): Promise<
  { ok: true; appToken: string; tableId: string; members: LarkFieldOption[]; projects: LarkFieldOption[] }
  | { ok: false; message: string; missingFields?: string[] }
> {
  const parsed = parseLarkBaseUrl(url)
  if (!parsed) return { ok: false, message: '網址格式不正確，需要包含 /base/{appToken} 與 ?table={tableId}' }
  try {
    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${parsed.appToken}/tables/${parsed.tableId}/fields?page_size=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await resp.json() as { code?: number; msg?: string; data?: { items?: LarkField[] } }
    if (!resp.ok || data.code !== 0) {
      return { ok: false, message: `讀取表格失敗：${data.msg ?? resp.statusText}（請確認網址正確、且此帳號有存取權限）` }
    }
    const fields = data.data?.items ?? []
    const fieldNames = new Set(fields.map(f => f.field_name))
    const missingFields = REQUIRED_FIELDS.filter(f => !fieldNames.has(f))
    if (missingFields.length > 0) {
      return { ok: false, message: `這張表缺少必要欄位：${missingFields.join('、')}`, missingFields }
    }
    const memberField = fields.find(f => f.field_name === '成员')
    const projectField = fields.find(f => f.field_name === '专案')
    return {
      ok: true, appToken: parsed.appToken, tableId: parsed.tableId,
      members: (memberField?.property?.options ?? []).map(o => ({ id: o.id, name: o.name })),
      projects: (projectField?.property?.options ?? []).map(o => ({ id: o.id, name: o.name })),
    }
  } catch (e) {
    return { ok: false, message: `讀取失敗：${e instanceof Error ? e.message : String(e)}` }
  }
}

router.post('/api/weekly-report/parse', async (req, res) => {
  const body = z.object({ url: z.string().min(1) }).parse(req.body)
  const result = await loadWeeklyBaseOptions(body.url)
  // 用 === false 不用 !result.ok：這個 tsconfig 下後者不會把 union 收窄（readLarkSheetTab 的
  // 呼叫端也是同一個寫法，見上面 runBatchScan 裡的 result.ok === false）
  if (result.ok === false) {
    return res.status(400).json({
      ok: false, message: result.message,
      ...(result.missingFields ? { missingFields: result.missingFields } : {}),
    })
  }
  res.json({ ok: true, appToken: result.appToken, tableId: result.tableId, members: result.members, projects: result.projects })
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
    const jql = `(reporter = currentUser() OR assignee = currentUser() OR "QA驗證人員" = currentUser()) AND ((created >= "${startDate}" AND created < "${endExclusiveStr}") OR (updated >= "${startDate}" AND updated < "${endExclusiveStr}")) ORDER BY updated DESC`

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const resp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        maxResults: 200,
        fields: ['summary', 'status', 'created', 'updated', 'reporter', 'assignee', 'project', WEEKLY_REPORT_VERIFIER_FIELD_ID],
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
        assignee?: { accountId?: string } | null
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
        const isAssignee = meAccountId ? i.fields.assignee?.accountId === meAccountId : false
        // 2026-08-20：撈單條件加上 assignee 之後，原本「不是 reporter 就推定是驗證人員」的反推不再成立
        // （可能只是被指派的）。收緊成「不是 reporter、也不是 assignee，且已知的驗證人員欄位裡沒有我」→
        // 那就只剩下「其他專案的驗證人員欄位」這一種可能（那些欄位 id 不同，值不在回應裡）。
        const isVerifier = isVerifierByField || (!isReporter && !isAssignee)
        return {
          key: i.key,
          summary: i.fields.summary ?? '',
          status: i.fields.status?.name ?? '',
          created: i.fields.created ?? '',
          updated: i.fields.updated ?? '',
          // 拿不到自己的 accountId 時（/myself 失敗）根本無從判斷身分——舊寫法會讓 isReporter
          // 一律 false，配合上面的反推就會把所有單都標成 verifier，等於用一個假答案蓋掉「不知道」。
          // 標成 unknown 誠實得多（CodeX review 指出）。
          role: !meAccountId ? 'unknown' : isReporter && isVerifier ? 'both' : isVerifier ? 'verifier' : isReporter ? 'reporter' : 'assignee',
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

/** 掃描邏輯本體。抽出來是為了讓「定時提醒的預覽」也能跑同一份——複製一份到 cron 那邊，
 *  之後改比對規則一定會漏一邊（這正是不把整條備稿鏈搬到後端的同一個理由）。*/
export async function runBatchScan(input: { sheets: SheetColumnMapping[]; members: string[]; projects: LarkFieldOption[] }) {
  const { sheets, members, projects } = input

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

  return {
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
  }
}

// POST /api/weekly-report/batch-scan
router.post('/api/weekly-report/batch-scan', async (req, res) => {
  try {
    const parsed = z.object({
      sheets: z.array(z.object({
        url: z.string().min(1),
        dateColumn: z.string().min(1),
        personColumn: z.string().min(1),
        contentColumns: z.array(z.string()).min(1),
      })).min(1).max(3),
      members: z.array(z.string()),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }).parse(req.body) as { sheets: SheetColumnMapping[]; members: string[]; projects: LarkFieldOption[] }
    res.json({ ok: true, ...await runBatchScan(parsed) })
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
          // 記一筆給 Discord 按鈕那條路查重用。**只記錄不擋**——頁面本來就有自己的防重複
          // 設計（append-only + 部分失敗時移除已成功的），改成會擋是行為變更。
          try {
            recordSubmitted(getFridayAnchoredWeekRange().startLabel, item.member, item.content, item.project ?? '', data.data?.record?.record_id ?? '', 'page', '')
          } catch (e) {
            console.warn('[WeeklyReport] 記錄送出紀錄失敗（不影響送出本身）：', e)
          }
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


// ─── 定時備稿提醒（v4.53.0，2026-08-27）──────────────────────────────────────
// 使用者要的是「定時自動備稿＋通知」，但**刻意只做提醒、不自動送出**（使用者選 B）。
//
// 為什麼不是後端自己把草稿產好：備稿整條鏈都在前端——Sheet 掃描、Jira 撈單、專案關鍵字
// 比對、P7-005-OSM 合併、Jira 標籤歸集、手動指派，全部是 `WeeklyReportPage.tsx` 的狀態。
// 搬到 server 等於同一套規則前後端各維護一份，之後改比對規則一定會漏一邊（跟 CodeX 討論
// 定案：要做的前提是先把週報核心邏輯抽成前後端共用的 service，不是現在直接複製一份）。
// 所以這裡只負責「到點提醒去開頁面」，開頁面之後既有的全自動載入本來就會自己跑完備稿。

interface WeeklyReminderConfig {
  enabled: boolean
  /** 0=週日 … 6=週六。預設 4（週四）——週期是週五~週四，週四提醒剛好在收尾當天 */
  weekday: number
  /** HH:mm，Asia/Taipei */
  time: string
  /** 開啟時 @ 「帳號 → Discord Tag 對照表」裡的所有人（沿用 AutoSpin 那份，不另建一份名單）*/
  mentionAll: boolean
}

const WEEKLY_REMINDER_KEY = 'weekly_report_reminder'
const WEEKLY_REMINDER_SOURCES_KEY = 'weekly_report_reminder_sources'

/** 提醒訊息要附預覽，就得知道「掃哪幾份表、哪些欄位」——但那是 WeeklyReportPage 的前端 state，
 *  server 完全不知道。所以由前端在每次掃描成功當下把設定存過來，cron 用「你上次實際用的設定」跑。
 *  刻意不在 server 端另外寫一份預設來源常數：那等於同一組設定前後端各一份，改了一邊就不一致。*/
interface WeeklyReminderSources {
  savedAt: number
  weeklyUrl: string
  sheets: Array<{ url: string; dateColumn: string; personColumn: string; contentColumns: string[] }>
  /** 兩個合併開關原本存在瀏覽器 localStorage，server 讀不到。不一起存過來的話，
   *  Discord 送出的結果會跟使用者在頁面上勾的開關不一致——那正是這整件事要避免的不一致。*/
  mergeOsm: boolean
  mergeJiraTags: boolean
  /** 設定當下的登入者。**一定是後端從 cookie 判定的，不吃前端傳的值**——這是背景撈 Jira
   *  時唯一的授權依據，可被前端指定就等於誰都能冒用別人的 token。*/
  actorEmail?: string
  actorLabel?: string
  /** 授權時間。之後查「這份設定是誰、什麼時候留下的」會需要（CodeX review 要求）*/
  authorizedAt?: number
}

function getReminderSources(): WeeklyReminderSources | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(WEEKLY_REMINDER_SOURCES_KEY) as { value: string } | undefined
  if (!row?.value) return null
  try {
    const v = JSON.parse(row.value) as WeeklyReminderSources
    if (!v || !Array.isArray(v.sheets) || typeof v.weeklyUrl !== 'string') return null
    // 舊資料沒有這兩個欄位，補上預設（跟前端 localStorage 沒設過時的預設一致：兩個都關）
    return { ...v, mergeOsm: v.mergeOsm === true, mergeJiraTags: v.mergeJiraTags === true }
  } catch {
    return null
  }
}
const DEFAULT_REMINDER: WeeklyReminderConfig = { enabled: false, weekday: 4, time: '10:00', mentionAll: false }

function getReminderConfig(): WeeklyReminderConfig {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(WEEKLY_REMINDER_KEY) as { value: string } | undefined
  if (!row?.value) return { ...DEFAULT_REMINDER }
  try {
    const parsed = JSON.parse(row.value) as Partial<WeeklyReminderConfig>
    return {
      enabled: parsed.enabled === true,
      weekday: typeof parsed.weekday === 'number' && parsed.weekday >= 0 && parsed.weekday <= 6 ? parsed.weekday : DEFAULT_REMINDER.weekday,
      time: typeof parsed.time === 'string' && /^\d{1,2}:\d{2}$/.test(parsed.time) ? parsed.time : DEFAULT_REMINDER.time,
      mentionAll: parsed.mentionAll === true,
    }
  } catch {
    return { ...DEFAULT_REMINDER }
  }
}

/** HH:mm + 週幾 → cron 表達式。時分先轉成數字再組，避免 "09:05" 這種前導零直接進 cron 表達式 */
function reminderCronExpr(cfg: WeeklyReminderConfig): string {
  const [hh, mm] = cfg.time.split(':')
  return `${Number(mm)} ${Number(hh)} * * ${cfg.weekday}`
}

let weeklyReminderTask: cron.ScheduledTask | null = null

// ─── 背景撈 Jira：受 delegation 約束 ─────────────────────────────────────────
//
// v4.10.0 把身分邊界收緊成「以登入 cookie 為準」。排程沒有請求也沒有登入者，所以**不能**
// 直接拿別人的 token 去撈。但這個場景本來就有機制：`jira_account_delegates` 的
// `jira.read.asOther` scope，`/api/weekly-report/jira-by-range` 就是它唯一的使用者。
//
// 做法（跟 CodeX 定案）：
// 1. 來源設定存下「設定當下的登入者」當 actor（**從 cookie 判定，不吃前端傳的值**），
//    等於一個登入過的人明確授權了這件排程
// 2. 背景撈某個帳號的 Jira 前，要求 actor→該帳號有有效的 `jira.read.asOther`，或該帳號
//    就是 actor 本人
// 3. **不套用 `fallbackAllowUnauthorized`**——前景頁面為了相容舊流程可以 warning 放行，
//    背景排程不行。沒授權就跳過那個帳號，並在訊息裡明講「◯◯ 未授權，Jira 未撈」，
//    不默默少資料
// 4. 「預設帳號」只代表要嘗試撈誰，**不代表 actor 自動有權撈誰**

/** 撈某個 Jira 帳號在區間內的單。auth 由呼叫端負責取得（也就是由呼叫端負責通過授權檢查）。*/
async function fetchJiraIssuesInRange(auth: string, startDate: string, endDate: string): Promise<RangeIssueRaw[]> {
  const endExclusive = new Date(`${endDate}T00:00:00Z`)
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
  const endExclusiveStr = endExclusive.toISOString().slice(0, 10)
  const jql = `(reporter = currentUser() OR assignee = currentUser() OR "QA驗證人員" = currentUser()) AND ((created >= "${startDate}" AND created < "${endExclusiveStr}") OR (updated >= "${startDate}" AND updated < "${endExclusiveStr}")) ORDER BY updated DESC`
  const baseUrl = mustEnv('JIRA_BASE_URL')
  const resp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, maxResults: 200, fields: ['summary', 'status', 'created', 'updated', 'project'] }),
  })
  if (!resp.ok) throw new Error(`Jira 查詢失敗 HTTP ${resp.status}`)
  const data = await resp.json() as { issues?: Array<{ key: string; fields: { summary?: string; project?: { name?: string } } }> }
  return (data.issues ?? []).map(i => ({
    key: i.key,
    summary: i.fields.summary ?? '',
    jiraProjectName: i.fields.project?.name ?? '',
  }))
}

interface RangeIssueRaw { key: string; summary: string; jiraProjectName: string }

export interface JiraCronOutcome {
  drafts: Array<{ person: string; item: SharedDraftItem }>
  /** 沒撈成的帳號與原因，一定要讓使用者看到——默默少資料比少一個功能糟得多 */
  skipped: Array<{ label: string; reason: string }>
}

/**
 * 用來源設定裡記下的 actor 身分，撈預設目標帳號（Eric／Lusa／Siara）的 Jira 單。
 *
 * 沒有 actor（舊資料、或設定時沒有登入 session）就整段跳過——**不猜一個身分出來**。
 */
async function fetchJiraDraftsForCron(
  sources: WeeklyReminderSources,
  members: LarkFieldOption[],
  projects: LarkFieldOption[],
  startDate: string,
  endDate: string,
): Promise<JiraCronOutcome> {
  const out: JiraCronOutcome = { drafts: [], skipped: [] }
  const actor = (sources.actorEmail ?? '').toLowerCase()
  if (!actor) {
    out.skipped.push({ label: 'Jira', reason: '來源設定沒有記錄授權者——請重新開一次週報頁跑掃描' })
    return out
  }

  const candidates = readAccounts().filter(a => matchesAutoImportTarget(a.label || a.email))
  if (candidates.length === 0) {
    out.skipped.push({ label: 'Jira', reason: '找不到符合 Eric／Lusa／Siara 的後台帳號' })
    return out
  }

  const byIssue = new Map<string, { key: string; summary: string; jiraProjectName: string; accountLabels: string[] }>()
  for (const acc of candidates) {
    const label = acc.label || acc.email
    const isSelf = acc.email.toLowerCase() === actor
    // 「預設帳號」只代表要嘗試撈誰，不代表有權撈誰
    if (!isSelf && !hasJiraDelegation(actor, acc.email, 'jira.read.asOther')) {
      out.skipped.push({ label, reason: '沒有代理讀取授權（請管理員到「Jira 代理張貼授權」開通）' })
      continue
    }
    const auth = jiraAuthForAccount(acc.email)
    if (!auth) {
      out.skipped.push({ label, reason: '這個帳號還沒建 Jira API Token' })
      continue
    }
    try {
      for (const iss of await fetchJiraIssuesInRange(auth.auth, startDate, endDate)) {
        const existing = byIssue.get(iss.key)
        if (existing) { if (!existing.accountLabels.includes(label)) existing.accountLabels.push(label) }
        else byIssue.set(iss.key, { ...iss, accountLabels: [label] })
      }
    } catch (e) {
      out.skipped.push({ label, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  out.drafts = groupJiraIssuesToDrafts([...byIssue.values()], members, projects)
  return out
}

/**
 * 後端版的「算出這週要送什麼」。走的是 shared/weekly-report-rules 那份規則，
 * 跟頁面上跑的是同一套，不是複製一份。
 *
 * ## 跟頁面比，這裡少了什麼（**很重要，不要當成等價**）
 * 1. **Jira 撈單**——要用某個人的 Jira token，而身分一律以登入 cookie 為準（v4.10.0 收緊的
 *    邊界）。cron 沒有請求也沒有登入者，要撈就得繞過那條邊界，不做。
 * 2. **手動指派**——頁籤日期式報表、未識別人員指派，本質上要有人看著決定。
 * 3. **只用表單名稱的來源 Sheet**——那也是手動勾成員的，同上。
 *
 * 所以這支算出來的是「Sheet 掃描這條路上、可以自動判定的部分」。剩下的一律列進
 * `blockers`，讓 Discord 訊息明講「這些要你自己去頁面處理」，而不是安靜地漏掉。
 */
export interface WeeklyDraftResult {
  ok: true
  weekRange: { startLabel: string; endLabel: string; todayLabel: string }
  /** 可以直接送出的項目（專案已確定） */
  items: FlatItem[]
  /** 送不了、要人處理的事，附原因 */
  blockers: Array<{ kind: 'missing_project' | 'unidentified' | 'source_error' | 'jira_skipped'; detail: string }>
  stats: { peopleCount: number; itemCount: number }
}

export async function buildWeeklyDraft(sources: WeeklyReminderSources): Promise<
  WeeklyDraftResult | { ok: false; message: string }
> {
  const base = await loadWeeklyBaseOptions(sources.weeklyUrl)
  if (base.ok === false) return { ok: false, message: base.message }

  const scan = await runBatchScan({
    sheets: sources.sheets,
    members: base.members.map(m => m.name),
    projects: base.projects,
  })

  const withDefaults = applyDefaultScanSheetProject(
    scan.draftsByPerson as Record<string, SharedDraftItem[]>,
    sources.sheets[0]?.url,
    base.projects,
  )

  // 週期的 ISO 日期直接從 getFridayAnchoredWeekRange() 取——那兩個 Date 是用 Date.UTC(y,m-1,d)
  // 疊純日曆年月日組出來的，不是真正的 UTC 時間點，slice 拿到的年月日不會因時區換算跑掉
  const wr = getFridayAnchoredWeekRange()
  const weekStartISO = wr.startUTC.toISOString().slice(0, 10)
  const weekEndISO = wr.endUTC.toISOString().slice(0, 10)

  // Jira 撈單併進來。跟頁面同一套：Sheet 來源建好之後，把 Jira 產生的項目疊上去
  // （不是取代）。撈不到的帳號一律進 skipped，最後會出現在訊息的「需要你處理」欄位裡。
  const jira = await fetchJiraDraftsForCron(
    sources, base.members, base.projects,
    weekStartISO, weekEndISO,
  )
  for (const { person, item } of jira.drafts) {
    withDefaults[person] = [...(withDefaults[person] ?? []), item]
  }
  const flat = buildPreviewItems(withDefaults, {
    mergeOsm: sources.mergeOsm,
    mergeJiraTags: sources.mergeJiraTags,
  })

  // 缺專案的送不了——Lark 那欄是單選，沒有值等於沒填。頁面上本來就會擋住送出，
  // 這裡的行為要一致，不能因為走 Discord 就放寬
  const items = flat.filter(x => !!x.item.projectId)
  const blockers: WeeklyDraftResult['blockers'] = []
  for (const x of flat) {
    if (!x.item.projectId) {
      blockers.push({ kind: 'missing_project', detail: `${x.person}：${x.item.content.slice(0, 40)}（比對不到專案）` })
    }
  }
  for (const u of scan.unidentified) {
    blockers.push({ kind: 'unidentified', detail: `填寫人「${u.rawName}」對不到成員名單：${u.content.slice(0, 30)}` })
  }
  for (const e of scan.sourceErrors) {
    blockers.push({ kind: 'source_error', detail: `第 ${e.sheetIndex + 1} 份來源讀取失敗：${e.message}` })
  }
  // 沒撈到的 Jira 帳號要明講，不能默默少資料（CodeX review 要求）
  for (const sk of jira.skipped) {
    blockers.push({ kind: 'jira_skipped', detail: `${sk.label} 的 Jira 沒撈到：${sk.reason}` })
  }

  return {
    ok: true,
    weekRange: scan.weekRange,
    items,
    blockers,
    stats: { peopleCount: new Set(items.map(i => i.person)).size, itemCount: items.length },
  }
}

// ─── Discord 按鈕送出：防重複 ─────────────────────────────────────────────────
//
// 按鈕會被連按、被多人按、Discord 自己也可能重送 interaction。**不能用「送出前查、送出後寫」**
// ——中間有 race，兩個 request 會同時查到不存在（CodeX review 抓到）。
//
// 正確做法是**先搶再送**：用 unique key 直接 INSERT 成 `processing`，搶到的人才去寫 Lark，
// 寫完再標 `sent`。INSERT 撞 unique 就代表別人已經在處理或處理完了，直接跳過。
db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_report_submissions (
    dedupe_key  TEXT PRIMARY KEY,
    week_start  TEXT NOT NULL,
    person      TEXT NOT NULL,
    content     TEXT NOT NULL,
    project     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'processing',
    record_id   TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    actor       TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`)

/** 同一週、同一人、同一段內容、同一個專案就算同一筆。內容原樣進 key（不做正規化）——
 *  正規化過頭會把「刻意寫兩條相近內容」誤判成重複，那是把資料吃掉，比留下重複更糟。*/
function submissionKey(weekStart: string, person: string, content: string, projectName: string): string {
  return createHash('sha256').update([weekStart, person, content, projectName].join('\u0000')).digest('hex').slice(0, 32)
}

/** 記一筆已經送出去的（給頁面那條路用）。**只記錄不擋**——頁面本來就有自己的防重複設計
 *  （append-only + 部分失敗時移除已成功的），改成會擋是行為變更；這裡只是讓 Discord 那條路
 *  知道「這筆頁面已經送過了」，按鈕就會跳過它。*/
function recordSubmitted(weekStart: string, person: string, content: string, projectName: string, recordId: string, source: string, actor: string) {
  const now = Date.now()
  db.prepare(`
    INSERT INTO weekly_report_submissions
      (dedupe_key, week_start, person, content, project, status, record_id, source, actor, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET status = 'sent', record_id = excluded.record_id, updated_at = excluded.updated_at
  `).run(submissionKey(weekStart, person, content, projectName), weekStart, person, content, projectName, recordId, source, actor, now, now)
}

export interface WeeklySubmitOutcome {
  sent: Array<{ person: string; content: string }>
  skipped: Array<{ person: string; content: string; reason: string }>
  failed: Array<{ person: string; content: string; message: string }>
  blockers: WeeklyDraftResult['blockers']
}

/**
 * 算出這週的草稿並寫進 Lark。給 Discord 按鈕用。
 *
 * **部分送出**：能自動判定的先送，需要人處理的留著並回報（跟 CodeX 定案）——因為使用者按下
 * 按鈕的期待是「能送的先幫我送」，不是因為一個未識別人員就讓整週卡住。
 */
export async function submitWeeklyDraft(actor: string): Promise<
  { ok: true; outcome: WeeklySubmitOutcome } | { ok: false; message: string }
> {
  const sources = getReminderSources()
  if (!sources) return { ok: false, message: '還沒有來源設定——先開一次週報頁跑過掃描' }

  const parsedBase = parseLarkBaseUrl(sources.weeklyUrl)
  if (!parsedBase) return { ok: false, message: '週報表網址格式不正確' }

  const draft = await buildWeeklyDraft(sources)
  if (draft.ok === false) return { ok: false, message: draft.message }

  const weekStart = draft.weekRange.startLabel
  const outcome: WeeklySubmitOutcome = { sent: [], skipped: [], failed: [], blockers: draft.blockers }

  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const claim = db.prepare(`
    INSERT INTO weekly_report_submissions
      (dedupe_key, week_start, person, content, project, status, source, actor, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'processing', 'discord', ?, ?, ?)
  `)

  for (const { person, item } of draft.items) {
    const key = submissionKey(weekStart, person, item.content, item.projectName)
    // 先搶再送：撞 unique 代表別人已經在處理或處理完了
    try {
      const now = Date.now()
      claim.run(key, weekStart, person, item.content, item.projectName, actor, now, now)
    } catch {
      const row = db.prepare('SELECT status FROM weekly_report_submissions WHERE dedupe_key = ?').get(key) as { status: string } | undefined
      outcome.skipped.push({ person, content: item.content, reason: row?.status === 'sent' ? '已經送過了' : '另一個請求正在處理' })
      continue
    }

    try {
      const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${parsedBase.appToken}/tables/${parsedBase.tableId}/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { 成员: person, 专案: item.projectName, 补充说明: item.content } }),
      })
      const data = await resp.json() as { code?: number; msg?: string; data?: { record?: { record_id?: string } } }
      if (!resp.ok || data.code !== 0) throw new Error(data.msg ?? resp.statusText)
      db.prepare("UPDATE weekly_report_submissions SET status = 'sent', record_id = ?, updated_at = ? WHERE dedupe_key = ?")
        .run(data.data?.record?.record_id ?? '', Date.now(), key)
      outcome.sent.push({ person, content: item.content })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // 失敗的要放回去可以重試的狀態，不然這筆會被自己的 claim 永久卡住
      db.prepare("UPDATE weekly_report_submissions SET status = 'failed', error = ?, updated_at = ? WHERE dedupe_key = ?")
        .run(message.slice(0, 300), Date.now(), key)
      outcome.failed.push({ person, content: item.content, message })
    }
  }

  addHistory('weekly-report', `週報送出（Discord 按鈕）— ${outcome.sent.length} 筆成功`,
    outcome.sent.slice(0, 10).map(i => `${i.person}：${i.content}`).join('\n').slice(0, 300),
    {
      actor, weekStart,
      sentCount: outcome.sent.length, skippedCount: outcome.skipped.length,
      failedCount: outcome.failed.length, blockerCount: outcome.blockers.length,
    })

  return { ok: true, outcome }
}

/** `failed` 的可以重試——把它從表上拿掉，下次按按鈕就會重新嘗試。
 *  `processing` 卡住超過 10 分鐘的也一併清掉（程序中途掛掉會留下這種殭屍狀態）。*/
export function clearRetryableSubmissions(): number {
  const cutoff = Date.now() - 10 * 60 * 1000
  const r = db.prepare("DELETE FROM weekly_report_submissions WHERE status = 'failed' OR (status = 'processing' AND updated_at < ?)").run(cutoff)
  return r.changes
}

/** 組提醒訊息裡的預覽區塊。
 *
 *  ⚠️ 這是**預覽不是週報本身**，文案上一定要講清楚。備稿有一半規則只活在前端
 *  （專案預設帶入、P7-005-OSM 每人合併、Jira 標籤歸集、頁籤報表與未識別人員的手動指派），
 *  server 這邊跑的只有 Sheet 掃描那段，所以數字跟最後真的送進 Lark 的內容不會完全一致。
 *  假裝它等於最後結果，比不給預覽更糟——使用者會照著它去核對，然後發現對不上。
 *
 *  **Jira 撈單刻意不放進來**：那要用「某個人的 Jira token」去查，而身分一律以登入 cookie
 *  為準（v4.10.0 收緊的邊界）。cron 沒有請求也沒有登入者，要撈就得繞過那條邊界，不值得。
 */
async function buildReminderPreview(): Promise<{ fields: Array<{ name: string; value: string; inline: boolean }>; footer: string }> {
  const sources = getReminderSources()
  if (!sources || sources.sheets.length === 0) {
    return {
      fields: [{
        name: '預覽',
        value: '還沒有預覽來源——先開一次週報頁跑過掃描，之後的提醒就會附上預覽。',
        inline: false,
      }],
      footer: '預覽僅供參考，實際送出內容以週報頁面為準',
    }
  }

  try {
    const draft = await buildWeeklyDraft(sources)
    if (draft.ok === false) {
      return {
        fields: [{ name: '預覽', value: `讀不到週報表：${draft.message}`, inline: false }],
        footer: '預覽僅供參考，實際送出內容以週報頁面為準',
      }
    }

    const fields: Array<{ name: string; value: string; inline: boolean }> = []

    // 逐人摘要。Discord 單一 field value 上限 1024 字元，人多時一定要截——
    // 超過就被 API 整包拒絕，訊息會完全發不出去（比少列幾個人嚴重得多）
    const byPerson = new Map<string, string[]>()
    for (const { person, item } of draft.items) {
      const list = byPerson.get(person) ?? []
      list.push(item.content.replace(/\s+/g, ' ').slice(0, 40))
      byPerson.set(person, list)
    }
    if (byPerson.size === 0) {
      fields.push({ name: '可自動送出的項目', value: '這個區間內沒有可自動判定的項目', inline: false })
    } else {
      const shown = [...byPerson.entries()].slice(0, 8)
      const lines = shown.map(([person, contents]) => {
        const heads = contents.slice(0, 3)
        const more = contents.length > heads.length ? `…等 ${contents.length} 筆` : ''
        return `**${person}**（${contents.length}）：${heads.join('｜')}${more}`
      })
      if (byPerson.size > shown.length) lines.push(`…另有 ${byPerson.size - shown.length} 人`)
      let value = lines.join('\n')
      if (value.length > 1000) value = `${value.slice(0, 990)}\n…（過長已截斷）`
      fields.push({ name: `可自動送出的項目（${draft.stats.peopleCount} 人 / ${draft.stats.itemCount} 筆）`, value, inline: false })
    }

    // 送不了的單獨列一欄——這是使用者真正要為此打開頁面的理由，不能安靜地漏掉
    if (draft.blockers.length > 0) {
      const heads = draft.blockers.slice(0, 6).map(b => `• ${b.detail}`)
      if (draft.blockers.length > heads.length) heads.push(`…另有 ${draft.blockers.length - heads.length} 項`)
      let value = heads.join('\n')
      if (value.length > 1000) value = `${value.slice(0, 990)}\n…（過長已截斷）`
      fields.push({ name: `需要你去頁面處理（${draft.blockers.length}）`, value, inline: false })
    }

    return {
      fields,
      footer: 'Jira 撈單與手動指派只在頁面上跑，不含在這裡',
    }
  } catch (e) {
    // 預覽算不出來絕不能連提醒本身都發不出去——提醒是主功能，預覽是附加的
    return {
      fields: [{ name: '預覽', value: `預覽產生失敗：${e instanceof Error ? e.message : String(e)}`, inline: false }],
      footer: '預覽僅供參考，實際送出內容以週報頁面為準',
    }
  }
}

/** 送出提醒到 Discord。webhook URL 沿用 AutoSpin 那組全域設定（同一個頻道，不另外設一份）。*/
async function sendWeeklyReminder(): Promise<{ sent: boolean; message: string }> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('discord_webhook_url') as { value: string } | undefined
  const webhookUrl = row?.value ?? ''
  if (!webhookUrl) return { sent: false, message: '尚未設定 Discord Webhook URL（在「Discord 通知」設定頁）' }

  const cfg = getReminderConfig()
  const { startLabel, endLabel } = getFridayAnchoredWeekRange()
  const preview = await buildReminderPreview()

  // mention 一定要放 content，塞在 embed 裡不會真的觸發 Discord 通知/ping（AutoSpin 那邊踩過）
  let content = '📋 該備週報了'
  if (cfg.mentionAll) {
    try {
      const mapRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('autospin_discord_user_map') as { value: string } | undefined
      const map = mapRow?.value ? JSON.parse(mapRow.value) as Array<{ discordUserId?: string }> : []
      const mentions = (Array.isArray(map) ? map : [])
        .map(e => e.discordUserId).filter((id): id is string => !!id)
        .map(id => `<@${id}>`).join(' ')
      if (mentions) content = `${mentions} ${content}`
    } catch { /* 對照表壞掉不該擋住提醒本身 */ }
  }

  const baseUrl = process.env.TOPPATH_BASE_URL || 'http://localhost:3000'
  const embed = {
    title: '週報備稿提醒',
    description: [
      '按下面的按鈕直接送出，或開週報彙整頁自己確認。',
      '**手動指派與比對不到專案的項目不會被送出**，會列在下面。',
    ].join('\n'),
    color: 0x62C6A5,
    fields: [
      { name: '本週撈取範圍', value: `${startLabel} ～ ${endLabel}`, inline: false },
      ...preview.fields,
    ],
    footer: { text: preview.footer },
    timestamp: new Date().toISOString(),
  }

  // 優先用 bot 發——只有 application 發的訊息才帶得動按鈕（webhook 送 components 會被
  // Discord 靜默丟掉，已實測）。bot 沒設定或還沒連上就退回 webhook：**沒有按鈕總比
  // 整則提醒都不見了好**。
  const { sendWeeklyReminderWithButton } = await import('../weekly-report-bot.js')
  if (await sendWeeklyReminderWithButton({ content, embed })) {
    return { sent: true, message: '已送出提醒（帶按鈕）' }
  }
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      embeds: [embed],
    }),
  })
  return { sent: true, message: '已送出提醒' }
}

/** 重新套用排程。設定改動後要呼叫，模組載入時也會跑一次。*/
export const restartWeeklyReminder = () => {
  if (weeklyReminderTask) { weeklyReminderTask.stop(); weeklyReminderTask = null }
  const cfg = getReminderConfig()
  if (!cfg.enabled) return
  const expr = reminderCronExpr(cfg)
  if (!cron.validate(expr)) { console.warn('[WeeklyReminder] 無效的 cron 表達式：', expr); return }
  weeklyReminderTask = cron.schedule(expr, async () => {
    try {
      const r = await sendWeeklyReminder()
      addHistory('weekly-report', '週報備稿提醒（定時）', r.message, { triggeredBy: 'cron', schedule: expr })
      console.log(`[WeeklyReminder] ${r.message}`)
    } catch (err) { console.error('[WeeklyReminder] 定時提醒失敗：', err) }
  }, { timezone: 'Asia/Taipei' })
  console.log(`[WeeklyReminder] 已啟動，排程：${expr}（Asia/Taipei）`)
}

// GET /api/weekly-report/reminder
router.get('/api/weekly-report/reminder', (_req, res) => {
  const cfg = getReminderConfig()
  res.json({ ok: true, config: cfg, cronExpr: cfg.enabled ? reminderCronExpr(cfg) : null })
})

// PUT /api/weekly-report/reminder — 整份覆蓋，存完立刻重新套用排程
router.put('/api/weekly-report/reminder', (req, res) => {
  try {
    const body = z.object({
      enabled: z.boolean(),
      weekday: z.number().int().min(0).max(6),
      time: z.string().regex(/^\d{1,2}:\d{2}$/, 'time 需為 HH:mm'),
      mentionAll: z.boolean().optional(),
    }).parse(req.body)
    const [hh, mm] = body.time.split(':').map(Number)
    if (hh > 23 || mm > 59) return res.status(400).json({ ok: false, message: 'time 超出範圍' })
    const cfg: WeeklyReminderConfig = { ...body, mentionAll: body.mentionAll === true }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(WEEKLY_REMINDER_KEY, JSON.stringify(cfg))
    restartWeeklyReminder()
    res.json({ ok: true, config: cfg, cronExpr: cfg.enabled ? reminderCronExpr(cfg) : null })
  } catch (e) {
    res.status(400).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

// POST /api/weekly-report/reminder/test — 立刻送一則，不受啟用開關影響（比照 Discord 設定頁的試發送）
router.post('/api/weekly-report/reminder/test', async (_req, res) => {
  try {
    const r = await sendWeeklyReminder()
    res.json({ ok: r.sent, message: r.message })
  } catch (e) {
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

// PUT /api/weekly-report/reminder/sources — 前端掃描成功後把「這次用的來源設定」存過來，
// 定時提醒的預覽就用這份跑。存的是設定不是結果，所以不會過期成錯誤資料，只會是「上次用的設定」。
router.put('/api/weekly-report/reminder/sources', (req, res) => {
  try {
    const body = z.object({
      weeklyUrl: z.string().min(1),
      sheets: z.array(z.object({
        url: z.string().min(1),
        dateColumn: z.string().min(1),
        personColumn: z.string().min(1),
        contentColumns: z.array(z.string()).min(1),
      })).max(3),
      mergeOsm: z.boolean().optional(),
      mergeJiraTags: z.boolean().optional(),
    }).parse(req.body)
    // actor **一定是從 cookie 判定**，不吃前端傳的值——這是背景撈 Jira 時唯一的授權依據，
    // 可被前端指定就等於誰都能冒用別人的 token（v4.10.0 收緊身分邊界的同一個理由）
    const actorEmail = authEmailFromRequest(req)
    const actorAccount = actorEmail ? readAccounts().find(a => a.email.toLowerCase() === actorEmail.toLowerCase()) : undefined
    const payload: WeeklyReminderSources = {
      savedAt: Date.now(), weeklyUrl: body.weeklyUrl, sheets: body.sheets,
      mergeOsm: body.mergeOsm === true, mergeJiraTags: body.mergeJiraTags === true,
      actorEmail: actorEmail ?? undefined,
      actorLabel: actorAccount?.label ?? undefined,
      authorizedAt: actorEmail ? Date.now() : undefined,
    }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(WEEKLY_REMINDER_SOURCES_KEY, JSON.stringify(payload))
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

// GET /api/weekly-report/submit-preview — Discord 按鈕「會送出什麼」的乾跑，唯讀不寫 Lark。
// 存在的理由：按鈕按下去就真的寫進團隊共用的週報表，收不回來。要驗證這條路算得對不對，
// 得有一個不會產生副作用的方式先看結果——這支就是。
router.get('/api/weekly-report/submit-preview', async (_req, res) => {
  try {
    const sources = getReminderSources()
    if (!sources) return res.json({ ok: false, message: '還沒有來源設定——先開一次週報頁跑過掃描' })
    const draft = await buildWeeklyDraft(sources)
    if (draft.ok === false) return res.json({ ok: false, message: draft.message })
    res.json({
      ok: true,
      weekRange: draft.weekRange,
      stats: draft.stats,
      wouldSend: draft.items.map(x => ({ person: x.person, project: x.item.projectName, content: x.item.content })),
      blockers: draft.blockers,
    })
  } catch (e) {
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

// 模組載入時套用一次，讓 server 重啟後排程自動恢復（跟 osm.ts 的 restartCron 同一套）
restartWeeklyReminder()

/**
 * server/routes/weekly-report.ts
 * 週報彙整 — 獨立工具（不掛在 OSM Tools 底下）。每週貼上當週 Lark Base 網址，
 * 動態讀取「成员」/「专案」下拉選項，填寫補充說明後直接新增一列到該表。
 * 詳見 CLAUDE.md 第 23 節。
 */
import { Router } from 'express'
import { z } from 'zod'
import { addHistory, getLarkToken, mustEnv, userJiraAuth, parseLarkSheetUrl } from '../shared.js'
import { callLLM } from './gemini.js'

export const router = Router()

/** 週報「依時間範圍撈 Jira 單」——沿用 jira.ts 批次開單時寫入的驗證人員欄位 id，不用另外動態偵測 */
const WEEKLY_REPORT_VERIFIER_FIELD_ID = process.env.JIRA_VERIFIER_FIELD_ID ?? 'customfield_10440'

// ── 「從 Sheet 分析本週內容」——2026-08-12，跟 CodeX 討論定案的設計 ──────────
// alias 精確比對（不靠 AI 猜身份）+ 三級信心分級（deterministic 規則，不是 Gemini 判斷）+
// 使用者確認勾選後才交 Gemini 摘要，AI 只負責摘要文字、不負責判定是誰做的。

/** 判斷欄位名稱是不是「姓名類」欄位——決定唯一 alias 命中時算高信心還是中信心 */
const NAME_COLUMN_HINTS = ['姓名', '名字', '填寫人', '負責人', '報告人', '驗證', 'qa', '人員', 'owner', 'assignee', 'pic', '道友', '道號', '成员', '成員']
function isNameLikeColumn(header: string): boolean {
  const h = header.toLowerCase()
  return NAME_COLUMN_HINTS.some(hint => h.includes(hint.toLowerCase()))
}

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
    const rec: Record<string, string> = {}
    headers.forEach((h, i) => { if (h) rec[h] = extractSheetCell((r as unknown[])[i]) })
    return rec
  }).filter(rec => Object.values(rec).some(v => v.trim()))

  return { ok: true, tabName: target.title, headers, rows }
}

interface MatchedCell { column: string; cellValue: string; alias: string }
interface AnalyzedRow { rowIndex: number; cells: Record<string, string>; confidence: 'high' | 'mid' | 'low' | 'none'; matchedCells: MatchedCell[] }

/**
 * 依 alias 清單掃描每一列每一格，找精確比對（trim + 不分大小寫），四級信心：
 * - high：唯一 alias 命中，且至少一格命中在姓名類欄位
 * - mid：唯一 alias 命中，但命中欄位都不是姓名類（例如備註、描述）
 * - low：同一列命中多個不同 alias（疑似多人任務/會議紀錄）
 * - none：完全沒命中任何 alias（2026-08-12 使用者要求：這種列不再丟棄，仍然回傳讓使用者
 *   自己判斷要不要手動勾選——alias 設定不完整、名字打法不一致時，這是唯一能救回漏判資料的機會；
 *   刻意用獨立的 'none' 值，不要塞進 'low'，避免跟「同列命中多個 alias」的語意混在一起，
 *   統計/預設勾選規則才不會誤判）
 * alias 少於 3 字元視為無效，不參與比對（太短容易誤判）。
 */
function analyzeSheetRows(headers: string[], rows: Record<string, string>[], aliases: string[]): AnalyzedRow[] {
  const validAliases = [...new Set(aliases.map(a => a.trim()).filter(a => a.length >= 3))]
  const results: AnalyzedRow[] = []

  rows.forEach((row, idx) => {
    const matchedCells: MatchedCell[] = []
    for (const h of headers) {
      const val = (row[h] ?? '').trim()
      if (!val) continue
      const hit = validAliases.find(a => a.toLowerCase() === val.toLowerCase())
      if (hit) matchedCells.push({ column: h, cellValue: val, alias: hit })
    }

    let confidence: AnalyzedRow['confidence']
    if (matchedCells.length === 0) {
      confidence = 'none'
    } else {
      const distinctAliases = new Set(matchedCells.map(m => m.alias))
      confidence = distinctAliases.size > 1
        ? 'low'
        : matchedCells.some(m => isNameLikeColumn(m.column)) ? 'high' : 'mid'
    }

    results.push({ rowIndex: idx + 2, cells: row, confidence, matchedCells }) // +2：第 1 列是表頭，資料從第 2 列開始
  })

  // high/mid/low 排在前面（同信心內維持原始列順序，Array.sort 是 stable sort），
  // none 一律排最後——使用者先處理可信資料，展開「無使用者」區塊才是撿漏的第二步
  const rank: Record<AnalyzedRow['confidence'], number> = { high: 0, mid: 1, low: 2, none: 3 }
  results.sort((a, b) => rank[a.confidence] - rank[b.confidence])

  return results
}

// POST /api/weekly-report/sheet-analysis — 讀取最多 3 個 Lark Sheet，依 alias 找出相關列
router.post('/api/weekly-report/sheet-analysis', async (req, res) => {
  try {
    const { sheetUrls, aliases } = z.object({
      sheetUrls: z.array(z.string().min(1)).min(1).max(3),
      aliases: z.array(z.string()),
    }).parse(req.body)

    const sources = []
    for (let i = 0; i < sheetUrls.length; i++) {
      const result = await readLarkSheetTab(sheetUrls[i])
      // 注意：這個專案 tsconfig.server.json 是 strict:false，`!result.ok` 這種寫法在該模式下
      // 對 boolean literal（ok:true/ok:false）判別聯合型別不會正確窄化（已用最小重現案例確認，
      // strict:true 就沒事），要用 `=== false` 明確比較才會正確窄化成 SheetTabError
      if (result.ok === false) {
        sources.push({ sourceLabel: `Sheet ${i + 1}`, tabName: '', error: result.message, rows: [] as AnalyzedRow[] })
        continue
      }
      const analyzed = analyzeSheetRows(result.headers, result.rows, aliases)
      sources.push({ sourceLabel: `Sheet ${i + 1}`, tabName: result.tabName, error: '', rows: analyzed })
    }

    res.json({ ok: true, sources })
  } catch (e) {
    res.status(500).json({ ok: false, message: `分析失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

// POST /api/weekly-report/sheet-analysis-draft — 使用者確認勾選後，把選取的列交 Gemini 摘要成草稿
// 依來源分開理解、合併成一段草稿，不確定的事項不寫成已完成事實——AI 只負責摘要文字，
// 「這列屬於誰」的判定完全在後端 analyzeSheetRows() 用 alias 規則決定，不交給 AI 猜
router.post('/api/weekly-report/sheet-analysis-draft', async (req, res) => {
  try {
    const { selections } = z.object({
      selections: z.array(z.object({
        sourceLabel: z.string(),
        tabName: z.string(),
        rows: z.array(z.object({
          cells: z.record(z.string(), z.string()),
        })),
      })),
    }).parse(req.body)

    const activeSelections = selections.filter(s => s.rows.length > 0)
    if (activeSelections.length === 0) return res.json({ ok: false, message: '沒有勾選任何列' })

    const sourcesText = activeSelections.map(s => {
      const rowsText = s.rows.map(r =>
        Object.entries(r.cells).filter(([, v]) => v.trim()).map(([k, v]) => `${k}：${v}`).join('；')
      ).join('\n')
      return `【來源：${s.sourceLabel}／分頁：${s.tabName}】\n${rowsText}`
    }).join('\n\n')

    const prompt = `以下是使用者確認過、跟他本週工作相關的表格列，依來源分開列出。請你用繁體中文整理成「本週工作內容」草稿，規則：
1. 依來源分開理解，不要把不同來源的內容混為一談
2. 輸出格式固定為條列式：第一行是「本週工作內容如下：」，接著每個工作項目各佔一行、用數字編號（1. 2. 3. ...），每項簡短一句話講清楚做了什麼，不要寫成一大段流暢文字，不要合併成段落
3. 不確定的事項不要寫成已完成的事實，用「可能」「待確認」等字眼標示
4. 不要編造原始資料沒有的內容，只根據下面提供的內容整理
5. 只輸出條列文字本身，不要加入前言、結語或任何額外說明（例如不要寫「以下是整理結果」這類開場白）

${sourcesText}`

    const draft = await callLLM(prompt)
    res.json({ ok: true, draft: draft.trim() })
  } catch (e) {
    res.status(500).json({ ok: false, message: `AI 摘要失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

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
    const userAuth = userJiraAuth(req)
    if (!userAuth) return res.status(401).json({ ok: false, message: '請先選擇帳號' })
    const { startDate, endDate } = z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body)

    // 結束日 +1 天、用 `<` 排除，避免 Jira 日期只算到當天 00:00 的邊界問題
    const endExclusive = new Date(`${endDate}T00:00:00Z`)
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
    const endExclusiveStr = endExclusive.toISOString().slice(0, 10)

    const verifierNumericId = WEEKLY_REPORT_VERIFIER_FIELD_ID.replace(/^customfield_/, '')
    const jql = `(reporter = currentUser() OR cf[${verifierNumericId}] = currentUser()) AND ((created >= "${startDate}" AND created < "${endExclusiveStr}") OR (updated >= "${startDate}" AND updated < "${endExclusiveStr}")) ORDER BY updated DESC`

    const baseUrl = mustEnv('JIRA_BASE_URL')
    const resp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: userAuth.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        maxResults: 200,
        fields: ['summary', 'status', 'created', 'updated', 'reporter', WEEKLY_REPORT_VERIFIER_FIELD_ID],
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
        const isVerifier = meAccountId ? verifierIds.includes(meAccountId) : false
        return {
          key: i.key,
          summary: i.fields.summary ?? '',
          status: i.fields.status?.name ?? '',
          created: i.fields.created ?? '',
          updated: i.fields.updated ?? '',
          role: isReporter && isVerifier ? 'both' : isVerifier ? 'verifier' : 'reporter',
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

// POST /api/weekly-report/submit — 永遠新增一列（2026-08-11 討論結論：曾考慮「查到同成員既有列就 PATCH
// 附加」，但這個 read-then-write 模式有兩個真實併發風險——同一人短時間內兩次送出可能兩次都查到「還沒有」
// 變成新增兩列，且 Lark Bitable 的 record update API 沒有 revision/ETag 可偵測「PATCH 當下是否已被別人
// 手動編輯過」，PATCH 有機會蓋掉別人正在 Lark 網頁上的手動編輯。永遠新增一列完全不會共用/覆寫任何既有
// 欄位，兩個風險都直接消失；代價只是同一人這週送多次會有多列，是可接受的小麻煩，不是資料風險）
router.post('/api/weekly-report/submit', async (req, res) => {
  const body = z.object({
    appToken: z.string().min(1),
    tableId: z.string().min(1),
    member: z.string().min(1),
    project: z.string().optional(),
    content: z.string().min(1),
  }).parse(req.body)

  try {
    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const fields: Record<string, string> = { '成员': body.member, '补充说明': body.content }
    if (body.project) fields['专案'] = body.project

    const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${body.appToken}/tables/${body.tableId}/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
    const data = await resp.json() as { code?: number; msg?: string; data?: { record?: { record_id?: string } } }
    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: `送出失敗：${data.msg ?? resp.statusText}` })
    }

    addHistory('weekly-report', `週報彙整 — ${body.member}`, body.content.slice(0, 300), {
      appToken: body.appToken, tableId: body.tableId, member: body.member, project: body.project ?? '', content: body.content,
    })

    res.json({ ok: true, recordId: data.data?.record?.record_id ?? '' })
  } catch (e) {
    res.status(500).json({ ok: false, message: `送出失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

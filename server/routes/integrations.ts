/**
 * server/routes/integrations.ts
 * All /api/integrations/*, /api/google/*, /api/sheets/* routes.
 */
import { Router } from 'express'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'
import {
  db,
  addHistory,
  getClientIP,
  getUser,
  log,
  mustEnv,
  getLarkToken,
  parseLarkSheetUrl,
  upload,
  larkGenerateSchema,
  gmailLatestSchema,
  osmVersionSyncSchema,
  writebackSchema,
  getGoogleServiceAccountToken,
  hasGoogleServiceAccount,
  parseGoogleSheetUrl,
} from '../shared.js'
import { callLLM, readGeminiPrompts, renderPrompt } from './gemini.js'
import { extractAdfText } from './jira.js'
import { readAccounts } from '../shared.js'

export const router = Router()

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface TestCase {
  測試模組: string
  測試維度: string
  測試標題: string
  前置條件: string
  操作步驟: string
  預期結果: string
  優先級: string
  來源?: string
}

interface JiraTestCase {
  test_type: string
  category_type: string
  category_reason: string
  function_module: string
  test_title: string
  expected_result: string
  source_reference: string
  jira_reference: string
}

interface JiraTestCaseResult {
  feature_name: string
  test_cases: JiraTestCase[]
}

interface GenerateApiResult {
  ok: boolean
  generated?: number
  written?: number
  cases?: TestCase[] | JiraTestCase[]
  message?: string
  bitableUrl?: string
  featureName?: string
  format?: 'jira'
}

// ─── SSE Job Store ────────────────────────────────────────────────────────────

interface JobEntry {
  status: 'running' | 'done' | 'error'
  result?: GenerateApiResult
  createdAt: number
  callbacks: Set<(result: GenerateApiResult) => void>
}
const jobStore = new Map<string, JobEntry>()
const JOB_TTL_MS = 30 * 60 * 1000

function cleanJobStore() {
  const now = Date.now()
  for (const [id, job] of jobStore.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) jobStore.delete(id)
  }
}

function finishJob(requestId: string, result: GenerateApiResult) {
  const job = jobStore.get(requestId)
  if (!job) return
  job.status = result.ok ? 'done' : 'error'
  job.result = result
  for (const cb of job.callbacks) cb(result)
  job.callbacks.clear()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 從 Jira 帳號拉取 Issue 詳情 */
const fetchJiraIssues = async (keys: string[], email: string): Promise<object[]> => {
  const account = readAccounts().find(a => a.email === email)
  if (!account) throw new Error(`找不到 Jira 帳號 ${email}`)
  const baseUrl = process.env.JIRA_BASE_URL ?? mustEnv('JIRA_BASE_URL')
  const auth = `Basic ${Buffer.from(`${email}:${account.token}`).toString('base64')}`
  return Promise.all(keys.map(async key => {
    const resp = await fetch(`${baseUrl}/rest/api/3/issue/${key}`, {
      headers: { Authorization: auth, Accept: 'application/json' }
    })
    if (!resp.ok) throw new Error(`無法取得 Jira ${key}: HTTP ${resp.status}`)
    const data = await resp.json() as Record<string, unknown>
    const fields = (data.fields ?? {}) as Record<string, unknown>
    return {
      key: data.key,
      summary: fields.summary ?? '',
      description: extractAdfText(fields.description),
      status: (fields.status as Record<string, unknown>)?.name ?? '',
      issueType: (fields.issuetype as Record<string, unknown>)?.name ?? '',
    }
  }))
}

/** 從 Lark Wiki 取得文件純文字內容 */
const fetchLarkDocContent = async (documentId: string): Promise<string> => {
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const resp = await fetch(`${base}/open-apis/docx/v1/documents/${documentId}/raw_content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await resp.json() as { code?: number; data?: { content?: string }; msg?: string }
  if (!resp.ok || data.code !== 0) {
    throw new Error(`讀取文件失敗 (code=${data.code}): ${data.msg}`)
  }
  return data.data?.content ?? ''
}

/** 從 Gemini 回傳文字中強制抽取最外層 JSON 陣列 */
function extractJsonArray(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const start = raw.indexOf('[')
  const end   = raw.lastIndexOf(']')
  if (start !== -1 && end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

/** 從 Gemini 回傳中抽取第一個 JSON 物件或陣列 */
function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  let start = -1
  let endChar = ''
  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    start = objStart; endChar = '}'
  } else if (arrStart !== -1) {
    start = arrStart; endChar = ']'
  }
  if (start === -1) return raw.trim()
  const end = raw.lastIndexOf(endChar)
  if (end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

/**
 * Gemini 有時在 JSON 字串值內輸出真實的換行/tab，導致 JSON.parse 失敗。
 * 此函式掃描字元，將字串值內的 literal 控制字元轉義。
 */
function sanitizeJsonLiterals(json: string): string {
  let inString = false
  let escaped = false
  let result = ''
  for (const char of json) {
    if (escaped) { result += char; escaped = false; continue }
    if (char === '\\' && inString) { escaped = true; result += char; continue }
    if (char === '"') { inString = !inString; result += char; continue }
    if (inString) {
      if (char === '\n') { result += '\\n'; continue }
      if (char === '\r') { result += '\\r'; continue }
      if (char === '\t') { result += '\\t'; continue }
    }
    result += char
  }
  return result
}

const generateWithGemini = async (docContent: string, promptId?: string, jiraIssues?: object[], modelSpec?: string): Promise<TestCase[] | JiraTestCaseResult> => {
  const prompts = readGeminiPrompts()
  const tpl = (promptId ? prompts.find(p => p.id === promptId) : null)
    ?? prompts.find(p => p.id === 'testcase-default')
    ?? prompts.find(p => p.id === 'default')
    ?? prompts[0]
  if (!tpl) throw new Error('找不到可用的 Prompt 模板')

  const jiraJson = jiraIssues && jiraIssues.length > 0 ? JSON.stringify(jiraIssues, null, 2) : '[]'
  const prompt = renderPrompt(tpl.template, {
    rawText: docContent.slice(0, 12000),
    docContent: docContent.slice(0, 12000),
    jira_issues: jiraJson,
  })
  const raw = await callLLM(prompt, modelSpec)
  console.log('[TestCase] Gemini 原始回傳前 300 字：', raw.slice(0, 300))

  const extracted = extractJsonBlock(raw)
  try {
    return JSON.parse(extracted)
  } catch {
    // Gemini sometimes outputs literal newlines inside JSON strings — sanitize and retry
    try {
      return JSON.parse(sanitizeJsonLiterals(extracted))
    } catch {
      throw new Error(`Gemini 回傳格式非合法 JSON：${extracted.slice(0, 300)}`)
    }
  }
}

/** 在指定資料夾動態建立新的 Bitable，並設定好所需欄位，回傳 appToken / tableId / url */
const createBitableForTestCases = async (name: string, folderToken: string): Promise<{ appToken: string; tableId: string; url: string }> => {
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

  const larkPost = (url: string, body: unknown) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const larkPut = (url: string, body: unknown) =>
    fetch(`${base}${url}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const larkGet = (url: string) =>
    fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } })

  const createResp = await larkPost('/open-apis/bitable/v1/apps', { name, folder_token: folderToken })
  const createData = await createResp.json() as { code?: number; msg?: string; data?: { app: { app_token: string; url: string } } }
  if (!createResp.ok || createData.code !== 0) throw new Error(`建立 Bitable 失敗 (code=${createData.code}): ${createData.msg}`)
  const appToken = createData.data!.app.app_token
  const appUrl = createData.data!.app.url

  const tablesData = await (await larkGet(`/open-apis/bitable/v1/apps/${appToken}/tables`)).json() as {
    code?: number; msg?: string; data?: { items: Array<{ table_id: string }> }
  }
  if (tablesData.code !== 0) throw new Error(`取得 Table 失敗: ${tablesData.msg}`)
  const tableId = tablesData.data!.items[0].table_id

  const recResp = await larkGet(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=50`)
  const recData = await recResp.json() as { code?: number; data?: { items?: Array<{ record_id: string }> } }
  const existingIds = recData.data?.items?.map((r) => r.record_id) ?? []
  if (existingIds.length > 0) {
    await larkPost(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, {
      records: existingIds,
    })
  }

  const fieldsData = await (await larkGet(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`)).json() as {
    code?: number; data?: { items: Array<{ field_id: string; field_name: string; type: number }> }
  }
  const allFields = fieldsData.data?.items ?? []
  const firstField = allFields[0]

  if (firstField) {
    await larkPut(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${firstField.field_id}`, {
      field_name: '測試標題',
      type: 1,
    })
  }

  for (const field of allFields.slice(1)) {
    await fetch(`${base}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${field.field_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  const extraFields: Array<{ field_name: string; type: number; property?: unknown }> = [
    {
      field_name: '測試模組',
      type: 3,
      property: { options: [] },
    },
    {
      field_name: '測試維度',
      type: 3,
      property: {
        options: [
          { name: '正向邏輯',      color: 0 },
          { name: '邊界分析',      color: 1 },
          { name: '異常阻斷',      color: 2 },
          { name: '版本變更',      color: 3 },
          { name: '使用者體驗',    color: 4 },
          { name: '搶登與裝置衝突', color: 5 },
        ],
      },
    },
    { field_name: '操作步驟', type: 1 },
    { field_name: '優先級',   type: 1 },
    { field_name: '前置條件', type: 1 },
    { field_name: '預期結果', type: 1 },
    { field_name: '來源',     type: 1 },
  ]

  for (const field of extraFields) {
    await larkPost(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, field)
  }

  return { appToken, tableId, url: appUrl }
}

/** 批次寫入 Lark Bitable，若設定 FOLDER_TOKEN 則每次動態建立新表 */
const writeTestCasesToBitable = async (cases: TestCase[], specUrl: string): Promise<{ written: number; bitableUrl: string }> => {
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

  let appToken: string
  let tableId: string
  let bitableUrl: string

  const folderToken = process.env.LARK_TESTCASE_FOLDER_TOKEN
  if (folderToken) {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`
    const wikiMatch = specUrl.match(/\/wiki\/([A-Za-z0-9]+)/)
    const docId = wikiMatch?.[1]?.slice(0, 8) ?? 'doc'
    const bitableName = `TestCase_${dateStr}_${timeStr}_${docId}`
    const created = await createBitableForTestCases(bitableName, folderToken)
    appToken = created.appToken
    tableId = created.tableId
    bitableUrl = created.url
  } else {
    appToken = mustEnv('LARK_TESTCASE_APP_TOKEN')
    tableId = mustEnv('LARK_TESTCASE_TABLE_ID')
    bitableUrl = process.env.LARK_TESTCASE_URL ?? ''
  }

  const records = cases.map((tc) => ({
    fields: {
      '測試模組': tc.測試模組,
      '測試維度': tc.測試維度,
      '測試標題': tc.測試標題,
      '前置條件': tc.前置條件,
      '操作步驟': tc.操作步驟,
      '預期結果': tc.預期結果,
      '優先級': tc.優先級,
      ...(tc.來源 ? { '來源': tc.來源 } : {}),
    },
  }))

  const BATCH = 500
  let written = 0
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH)
    const resp = await fetch(
      `${base}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: batch }),
      },
    )
    const data = await resp.json() as { code?: number; msg?: string }
    if (!resp.ok || data.code !== 0) throw new Error(`寫入 Bitable 失敗 (code=${data.code}): ${data.msg}`)
    written += batch.length
  }
  return { written, bitableUrl }
}

/** 建立 Jira 整合格式的 Bitable（新欄位結構） */
const createBitableForJiraTestCases = async (name: string, folderToken: string): Promise<{ appToken: string; tableId: string; url: string }> => {
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const larkPost = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const larkPut = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const larkGet = (url: string) =>
    fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } })

  const createResp = await larkPost('/open-apis/bitable/v1/apps', { name, folder_token: folderToken })
  const createData = await createResp.json() as { code?: number; msg?: string; data?: { app: { app_token: string; url: string } } }
  if (!createResp.ok || createData.code !== 0) throw new Error(`建立 Bitable 失敗 (code=${createData.code}): ${createData.msg}`)
  const appToken = createData.data!.app.app_token
  const appUrl = createData.data!.app.url

  const tablesData = await (await larkGet(`/open-apis/bitable/v1/apps/${appToken}/tables`)).json() as { code?: number; data?: { items: Array<{ table_id: string }> } }
  const tableId = tablesData.data!.items[0].table_id

  const recData = await (await larkGet(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=50`)).json() as { data?: { items?: Array<{ record_id: string }> } }
  const existingIds = recData.data?.items?.map(r => r.record_id) ?? []
  if (existingIds.length > 0) {
    await larkPost(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, { records: existingIds })
  }

  const fieldsData = await (await larkGet(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`)).json() as { data?: { items: Array<{ field_id: string }> } }
  const allFields = fieldsData.data?.items ?? []
  if (allFields[0]) {
    await larkPut(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${allFields[0].field_id}`, { field_name: '測試標題', type: 1 })
  }
  for (const field of allFields.slice(1)) {
    await fetch(`${base}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${field.field_id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  }

  const extraFields = [
    { field_name: '功能模組', type: 1 },
    { field_name: '測試類型', type: 3, property: { options: [{ name: '正向測試', color: 0 }, { name: '反向測試', color: 2 }, { name: '邊界測試', color: 1 }, { name: '異常測試', color: 3 }] } },
    { field_name: '類型', type: 3, property: { options: [{ name: '房間列表', color: 0 }, { name: '房內', color: 1 }, { name: '後台', color: 2 }, { name: 'DB', color: 3 }, { name: '下注', color: 4 }, { name: '派彩', color: 5 }, { name: '異常處理', color: 6 }, { name: '荷官端', color: 7 }, { name: '資訊端', color: 8 }, { name: '驗證端', color: 9 }, { name: 'LED', color: 10 }, { name: '未明確分類', color: 11 }] } },
    { field_name: '預期結果', type: 1 },
    { field_name: '來源依據', type: 1 },
    { field_name: 'JIRA單號', type: 1 },
    { field_name: '類型判定依據', type: 1 },
  ]
  for (const field of extraFields) {
    await larkPost(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, field)
  }
  return { appToken, tableId, url: appUrl }
}

/** 寫入 Jira 整合格式 TestCase 至 Bitable */
const writeJiraTestCasesToBitable = async (result: JiraTestCaseResult, specUrl: string): Promise<{ written: number; bitableUrl: string; featureName: string }> => {
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const folderToken = process.env.LARK_TESTCASE_FOLDER_TOKEN
  if (!folderToken) throw new Error('尚未設定 LARK_TESTCASE_FOLDER_TOKEN，無法動態建立 Bitable')

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`
  const suffix = specUrl.match(/\/wiki\/([A-Za-z0-9]+)/)?.[1]?.slice(0, 8) ?? 'doc'
  const name = `TestCase_${dateStr}_${timeStr}_${suffix}`
  const { appToken, tableId, url: bitableUrl } = await createBitableForJiraTestCases(name, folderToken)

  const records = result.test_cases.map(tc => ({
    fields: {
      '測試標題': tc.test_title,
      '功能模組': tc.function_module,
      '測試類型': tc.test_type,
      '類型': tc.category_type,
      '預期結果': tc.expected_result,
      '來源依據': tc.source_reference,
      'JIRA單號': tc.jira_reference,
      '類型判定依據': tc.category_reason,
    },
  }))

  const BATCH = 500
  let written = 0
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH)
    const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch }),
    })
    const data = await resp.json() as { code?: number; msg?: string }
    if (!resp.ok || data.code !== 0) throw new Error(`寫入 Bitable 失敗 (code=${data.code}): ${data.msg}`)
    written += batch.length
  }
  return { written, bitableUrl, featureName: result.feature_name }
}

// ─── Gmail helpers ────────────────────────────────────────────────────────────

let gmailTokenCache: { token: string; expiresAt: number } | null = null

async function getGmailAccessToken(): Promise<string> {
  const clientId     = process.env.GMAIL_CLIENT_ID ?? ''
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN ?? ''

  if (clientId && clientSecret && refreshToken) {
    const now = Date.now()
    if (gmailTokenCache && gmailTokenCache.expiresAt > now + 2 * 60 * 1000) {
      return gmailTokenCache.token
    }
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    })
    const data = await resp.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (!resp.ok || data.error) {
      throw new Error(`Gmail Token 換新失敗：${data.error_description ?? data.error ?? resp.status}`)
    }
    const newToken = data.access_token!
    const expiresIn = data.expires_in ?? 3600
    gmailTokenCache = { token: newToken, expiresAt: now + expiresIn * 1000 }
    console.log(`[Gmail] Access token 已自動更新，有效至 ${new Date(gmailTokenCache.expiresAt).toLocaleTimeString()}`)
    return newToken
  }

  const staticToken = process.env.GMAIL_ACCESS_TOKEN ?? ''
  if (!staticToken) throw new Error('Gmail 未設定：請在 .env 填入 GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN，或填入 GMAIL_ACCESS_TOKEN')
  return staticToken
}

/** Quoted-Printable 解碼 */
function decodeQP(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** 從 Gmail message payload 遞迴找 text/plain 的 base64url 資料 */
function findPlainText(payload: Record<string, unknown>): string | null {
  if (payload.mimeType === 'text/plain' && payload.body) {
    const b = payload.body as Record<string, unknown>
    if (typeof b.data === 'string') return b.data
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts as Record<string, unknown>[]) {
      const found = findPlainText(part)
      if (found) return found
    }
  }
  return null
}

/** 解析 OSM Version Check Report 純文字內容，回傳結構化記錄 */
function parseVersionReport(text: string) {
  const targetMatch = text.match(/Target Version:\s*(\S+)/)
  const generatedMatch = text.match(/Generated:\s*(.+)/)
  const targetVersion = targetMatch?.[1] ?? ''
  const generated = generatedMatch?.[1]?.trim() ?? ''

  const summaryMatch = text.match(/Target Version Found[\s\S]*?(\d+)[\s\S]*?Different Versions[\s\S]*?(\d+)[\s\S]*?Errors\/Not Found[\s\S]*?(\d+)[\s\S]*?Total Servers[\s\S]*?(\d+)/)
  const successMatch = text.match(/Success Rate[:\*\s]+([\d.]+)%/)

  const records: Array<{ serverName: string; ip: string; currentVersion: string; status: string; targetVersion: string }> = []

  const lineRe = /^(\S+)\s+\(([^)]+)\)\s+-\s+Found:\s+(\S+)\s+\|\s+Status:\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(text)) !== null) {
    records.push({
      serverName: m[1],
      ip: m[2],
      currentVersion: m[3],
      status: m[4].trim(),
      targetVersion,
    })
  }

  if (records.length === 0) {
    const ipOnlyRe = /^([\d.]+)\s+-\s+Found:\s+(\S+)\s+\|\s+Status:\s+(.+)$/gm
    let m2: RegExpExecArray | null
    while ((m2 = ipOnlyRe.exec(text)) !== null) {
      records.push({
        serverName: '',
        ip: m2[1],
        currentVersion: m2[2],
        status: m2[3].trim(),
        targetVersion,
      })
    }
  }

  if (records.length === 0) {
    const ipLineRe = /^\s*([\d.]+)\s+(\S+)\s+(OK|FAIL|Unknown|Different|Error[^\n]*)$/gm
    let m3: RegExpExecArray | null
    while ((m3 = ipLineRe.exec(text)) !== null) {
      records.push({
        serverName: '',
        ip: m3[1],
        currentVersion: m3[2],
        status: m3[3].trim(),
        targetVersion,
      })
    }
  }

  const upToDate = records.filter(r => r.currentVersion === targetVersion).length
  const outdated  = records.filter(r => r.currentVersion !== targetVersion && r.currentVersion && r.currentVersion !== 'N/A').length

  return {
    targetVersion,
    generated,
    summary: {
      totalServers: records.length,
      upToDate,
      outdated,
      unknown: records.length - upToDate - outdated,
      targetFound: summaryMatch ? parseInt(summaryMatch[1]) : null,
      differentVersions: summaryMatch ? parseInt(summaryMatch[2]) : null,
      errors: summaryMatch ? parseInt(summaryMatch[3]) : null,
      total: summaryMatch ? parseInt(summaryMatch[4]) : null,
      successRate: successMatch ? parseFloat(successMatch[1]) : null,
    },
    records,
  }
}

// ─── Multi-column writeback helpers ──────────────────────────────────────────

type MultiWrite = { rowIndex: number; columns: Record<string, string> }

const multiWritebackLark = async (sheetUrl: string, writes: MultiWrite[]) => {
  console.log('[WB-Lark] 1. parseLarkSheetUrl')
  const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)
  console.log('[WB-Lark] 2. token:', spreadsheetToken, 'sheetId:', sheetId)
  if (!spreadsheetToken) throw new Error('無法解析 Lark Sheet URL')

  console.log('[WB-Lark] 3. getLarkToken')
  const token = await getLarkToken()
  console.log('[WB-Lark] 4. got token, fetching headers')
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

  const headerRange = sheetId ? `${sheetId}!A1:Z2` : 'A1:Z2'
  const headerResp = await fetch(
    `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${headerRange}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  console.log('[WB-Lark] 5. headerResp.ok:', headerResp.ok, 'status:', headerResp.status)
  const headerData = (await headerResp.json()) as { data?: { valueRange?: { values?: unknown[][] } } }
  console.log('[WB-Lark] 6. headerData keys:', Object.keys(headerData ?? {}))
  const rows = headerData.data?.valueRange?.values ?? []
  const row1 = (rows[0] ?? []).map(c => (c !== null && c !== undefined ? String(c) : ''))
  const row2 = (rows[1] ?? []).map(c => (c !== null && c !== undefined ? String(c) : ''))
  const maxColLen = Math.max(row1.length, row2.length)
  const headers = Array.from({ length: maxColLen }, (_, i) => row1[i] || row2[i] || '')
  console.log('[WB-Lark] 7. headers:', headers)

  const results: { rowIndex: number; ok: boolean; error?: string }[] = []

  for (const write of writes) {
    let rowOk = true
    let rowError: string | undefined

    for (const [colName, value] of Object.entries(write.columns)) {
      const colIdx = headers.findIndex(h => h.toLowerCase() === colName.toLowerCase())
      if (colIdx === -1) continue
      const colLetter = String.fromCharCode(65 + colIdx)
      const range = sheetId ? `${sheetId}!${colLetter}${write.rowIndex}` : `${colLetter}${write.rowIndex}`

      const resp = await fetch(
        `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueRange: { range, values: [[value]] } }),
        },
      )

      if (!resp.ok) {
        const errText = await resp.text().catch(() => `HTTP ${resp.status}`)
        rowOk = false
        rowError = `${colName}：HTTP ${resp.status} — ${errText.slice(0, 200)}`
        break
      }
    }

    results.push({ rowIndex: write.rowIndex, ok: rowOk, error: rowError })
  }

  return results
}

const multiWritebackGoogle = async (sheetUrl: string, writes: MultiWrite[], accessToken: string) => {
  const { spreadsheetId, gid } = parseGoogleSheetUrl(sheetUrl)
  if (!spreadsheetId) throw new Error('無法解析 Google Sheets URL')

  const apiKey = mustEnv('GOOGLE_API_KEY')
  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${apiKey}&fields=sheets.properties`,
  )
  const meta = await metaResp.json() as { sheets?: { properties: { sheetId: number; title: string } }[] }
  const sheet = meta.sheets?.find(s => String(s.properties.sheetId) === gid) ?? meta.sheets?.[0]
  const sheetName = sheet?.properties.title ?? 'Sheet1'

  const headerRange = encodeURIComponent(`${sheetName}!A1:Z1`)
  const headerResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${headerRange}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const headerData = await headerResp.json() as { values?: string[][] }
  const headers = headerData.values?.[0] ?? []

  const data: { range: string; values: string[][] }[] = []
  for (const write of writes) {
    for (const [colName, value] of Object.entries(write.columns)) {
      const colIdx = headers.findIndex(h => h.toLowerCase() === colName.toLowerCase())
      if (colIdx === -1) continue
      const colLetter = String.fromCharCode(65 + colIdx)
      data.push({ range: `${sheetName}!${colLetter}${write.rowIndex}`, values: [[value]] })
    }
  }
  if (data.length === 0) return writes.map(w => ({ rowIndex: w.rowIndex, ok: true }))

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    },
  )
  const respData = await resp.json() as { error?: { message?: string } }
  const ok = resp.ok && !respData.error
  const errMsg = respData.error?.message
  return writes.map(w => ({ rowIndex: w.rowIndex, ok, error: ok ? undefined : errMsg }))
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/integrations/lark/generate-testcases
 * Validates input, starts background job, returns requestId immediately.
 * Client should then connect to /stream?requestId=... via SSE to receive result.
 */
router.post('/api/integrations/lark/generate-testcases', async (req, res) => {
  let body: ReturnType<typeof larkGenerateSchema.parse>
  try {
    body = larkGenerateSchema.parse(req.body)
  } catch {
    return res.status(400).json({ ok: false, message: '請求格式錯誤' })
  }

  // Normalize to sources array (supports both new multi-source and legacy single-source)
  const sourcesToFetch: { type: 'lark' | 'gdocs'; url: string }[] = body.sources?.length
    ? body.sources
    : body.specSource === 'gdocs'
      ? [{ type: 'gdocs', url: body.googleDocsUrl ?? '' }]
      : [{ type: 'lark', url: body.specUrl ?? '' }]

  // Validate all source URLs before starting job
  for (const src of sourcesToFetch) {
    if (src.type === 'gdocs') {
      if (!src.url.match(/\/document\/d\/([^/?\s]+)/))
        return res.status(400).json({ ok: false, message: `無法解析 Google 文檔 URL：${src.url}` })
    } else {
      if (!src.url.match(/\/wiki\/([A-Za-z0-9]+)/))
        return res.status(400).json({ ok: false, message: `無法解析 Lark Wiki URL：${src.url}` })
    }
  }
  if (body.jiraKeys.length > 0 && !body.jiraEmail)
    return res.status(400).json({ ok: false, message: '請選擇用於讀取 Jira 的帳號' })

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  cleanJobStore()
  jobStore.set(requestId, { status: 'running', createdAt: Date.now(), callbacks: new Set() })

  const clientIp = getClientIP(req)
  const user = getUser(req)

  // Fire-and-forget background job
  ;(async () => {
    try {
      // Fetch content from each source
      const docParts: string[] = []
      const sourceLabels: string[] = []

      for (let i = 0; i < sourcesToFetch.length; i++) {
        const src = sourcesToFetch[i]
        if (src.type === 'gdocs') {
          const docId = src.url.match(/\/document\/d\/([^/?\s]+)/)![1]
          const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`
          const resp = await fetch(exportUrl)
          if (!resp.ok) { finishJob(requestId, { ok: false, message: `無法讀取 Google 文檔 ${i + 1}（${resp.status}），請確認文件已設為「任何人可查看」` }); return }
          docParts.push(await resp.text())
          sourceLabels.push(src.url)
        } else {
          const documentId = src.url.match(/\/wiki\/([A-Za-z0-9]+)/)![1]
          docParts.push(await fetchLarkDocContent(documentId))
          sourceLabels.push(src.url)
        }
      }

      // Combine multiple docs with separator markers
      const docContent = docParts.length === 1
        ? docParts[0]
        : docParts.map((content, i) => {
            const typeLabel = sourcesToFetch[i].type === 'gdocs' ? 'Google 文檔' : 'Lark Wiki'
            return `=== 規格書 ${i + 1}（${typeLabel}）===\n${content}`
          }).join('\n\n')

      const sourceLabel = sourceLabels.join(', ')
      const srcLabel = sourcesToFetch.length > 1
        ? `多份規格書 (${sourcesToFetch.length})`
        : sourcesToFetch[0].type === 'gdocs' ? 'Google Docs' : 'Lark Wiki'

      if (!docContent.trim() && body.jiraKeys.length === 0) {
        finishJob(requestId, { ok: false, message: '文件內容為空，請確認讀取權限' }); return
      }

      let jiraIssues: object[] = []
      if (body.jiraKeys.length > 0) {
        jiraIssues = await fetchJiraIssues(body.jiraKeys, body.jiraEmail!)
        log('info', clientIp, user, 'Jira Issues 已載入', `${jiraIssues.length} 筆`)
      }

      log('info', clientIp, user, 'TestCase 生成開始', body.promptId ?? 'testcase-default')

      // Prepend multi-doc note if needed
      const finalContent = docParts.length > 1
        ? `[注意：以下包含 ${docParts.length} 份規格書，請整合分析並生成完整測試案例，避免重複。]\n\n${docContent}`
        : docContent

      const result = await generateWithGemini(finalContent, body.promptId, jiraIssues, body.modelSpec)

      if (!Array.isArray(result) && result && typeof result === 'object' && 'test_cases' in result) {
        const jiraResult = result as JiraTestCaseResult
        const { written, bitableUrl, featureName } = await writeJiraTestCasesToBitable(jiraResult, sourceLabel)
        const count = jiraResult.test_cases.length
        log('ok', clientIp, user, 'TestCase 生成完成（Jira 格式）', `生成 ${count} 筆，寫入 ${written} 筆`)
        addHistory('testcase', `TestCase 生成 — ${srcLabel}`, `生成 ${count} 筆，寫入 ${written} 筆`, { sourceLabel, cases: jiraResult.test_cases, bitableUrl })
        finishJob(requestId, { ok: true, generated: count, written, cases: jiraResult.test_cases, bitableUrl, featureName, format: 'jira' })
      } else {
        const cases = result as TestCase[]
        const { written, bitableUrl } = await writeTestCasesToBitable(cases, sourceLabel)
        log('ok', clientIp, user, 'TestCase 生成完成', `生成 ${cases.length} 筆，寫入 ${written} 筆`)
        addHistory('testcase', `TestCase 生成 — ${srcLabel}`, `生成 ${cases.length} 筆，寫入 ${written} 筆`, { sourceLabel, cases, bitableUrl })
        finishJob(requestId, { ok: true, generated: cases.length, written, cases, bitableUrl })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('error', clientIp, user, 'TestCase 生成失敗', message)
      finishJob(requestId, { ok: false, message })
    }
  })()

  res.json({ ok: true, requestId })
})

/**
 * GET /api/integrations/lark/generate-testcases/stream?requestId=...
 * SSE endpoint — pushes result when background job completes.
 * Sends heartbeat every 15s to keep proxy connections alive.
 */
router.get('/api/integrations/lark/generate-testcases/stream', (req, res) => {
  const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : ''
  const job = requestId ? jobStore.get(requestId) : undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (result: GenerateApiResult) => {
    res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
    res.end()
  }

  if (!job) {
    send({ ok: false, message: '找不到此任務，請重新提交' }); return
  }

  // Already finished — reply immediately
  if (job.status !== 'running' && job.result) {
    send(job.result); return
  }

  // Still running — register callback and keep alive with heartbeat
  job.callbacks.add(send)

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n')
  }, 15_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    job.callbacks.delete(send)
  })
})

// GET /api/integrations/lark/generate-testcases/status/:requestId
// Polling fallback when SSE disconnects but backend may still be running.
router.get('/api/integrations/lark/generate-testcases/status/:requestId', (req, res) => {
  cleanJobStore()
  const { requestId } = req.params
  const job = jobStore.get(requestId)
  if (!job) return res.status(404).json({ ok: false, status: 'missing', message: '找不到此任務，可能已過期' })
  if (job.status === 'running') return res.json({ ok: true, status: 'running' })
  if (!job.result) return res.json({ ok: true, status: 'running' })
  return res.json({ ok: true, status: job.status, result: job.result })
})

// GET /api/integrations/lark/generate-testcases/monitor
// Lightweight monitor for frontend dashboard banner.
router.get('/api/integrations/lark/generate-testcases/monitor', (req, res) => {
  cleanJobStore()
  const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : ''
  const running = [...jobStore.values()].filter(j => j.status === 'running').length
  const latest = [...jobStore.entries()]
    .map(([id, j]) => ({ requestId: id, status: j.status, createdAt: j.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
  const current = requestId ? jobStore.get(requestId) : undefined
  res.json({
    ok: true,
    running,
    latest,
    current: current ? { status: current.status, createdAt: current.createdAt } : null,
  })
})

/**
 * POST /api/integrations/generate-testcases-file
 * 上傳 PDF 或 DOCX 規格書，透過 Gemini 生成 TestCase 並寫入 Lark Bitable。
 * @limit 20MB per file（multer memoryStorage）。
 */
const extractFileContent = async (file: Express.Multer.File): Promise<string> => {
  const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
  if (file.mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')) {
    const parser = new PDFParse({ data: file.buffer })
    const parsed = await parser.getText()
    return parsed.text
  } else if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    originalname.toLowerCase().endsWith('.docx')
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer })
    return result.value
  }
  throw new Error(`不支援的格式：${originalname}`)
}

router.post('/api/integrations/generate-testcases-file', upload.array('files', 5), async (req, res, next) => {
  try {
    // Support both `files[]` (multi) and legacy `file` (single via upload.single shim)
    const uploadedFiles: Express.Multer.File[] = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : [])
    if (uploadedFiles.length === 0) return res.status(400).json({ ok: false, message: '請上傳 PDF 或 Word（.docx）檔案' })

    const promptId: string | undefined = typeof req.body.promptId === 'string' ? req.body.promptId : undefined
    const modelSpec: string | undefined = typeof req.body.modelSpec === 'string' ? req.body.modelSpec : undefined

    // Extract content from each file
    const docParts: string[] = []
    const fileNames: string[] = []
    for (const file of uploadedFiles) {
      const content = await extractFileContent(file)
      if (!content.trim()) return res.status(400).json({ ok: false, message: `無法從文件中讀取文字內容：${Buffer.from(file.originalname, 'latin1').toString('utf8')}` })
      docParts.push(content)
      fileNames.push(Buffer.from(file.originalname, 'latin1').toString('utf8'))
    }

    const docContent = docParts.length === 1
      ? docParts[0]
      : docParts.map((content, i) => `=== 規格書 ${i + 1}（${fileNames[i]}）===\n${content}`).join('\n\n')

    const finalContent = docParts.length > 1
      ? `[注意：以下包含 ${docParts.length} 份規格書，請整合分析並生成完整測試案例，避免重複。]\n\n${docContent}`
      : docContent

    const sourceLabel = fileNames.join(', ')
    log('info', getClientIP(req), getUser(req), 'TestCase 生成開始（檔案）', sourceLabel)
    const cases = await generateWithGemini(finalContent, promptId, undefined, modelSpec)
    const casesArr = Array.isArray(cases) ? cases as TestCase[] : (cases as JiraTestCaseResult).test_cases as unknown as TestCase[]
    const { written, bitableUrl } = await writeTestCasesToBitable(casesArr, sourceLabel)

    log('ok', getClientIP(req), getUser(req), 'TestCase 生成完成', `生成 ${casesArr.length} 筆，寫入 ${written} 筆`)
    addHistory('testcase', `TestCase 生成 — ${sourceLabel}`, `生成 ${casesArr.length} 筆，寫入 ${written} 筆`, { sourceLabel, cases: casesArr, bitableUrl })
    res.json({ ok: true, generated: casesArr.length, written, cases: casesArr, bitableUrl })
  } catch (error) {
    next(error)
  }
})

// POST /api/integrations/gmail/latest-report
router.post('/api/integrations/gmail/latest-report', async (req, res, next) => {
  try {
    const body = gmailLatestSchema.parse(req.body ?? {})
    const token = await getGmailAccessToken()
    const query = encodeURIComponent(body.query ?? process.env.GMAIL_QUERY ?? '')

    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const listData = await listResp.json() as { messages?: Array<{ id: string }>; error?: unknown }
    if (!listResp.ok) return res.status(listResp.status).json({ ok: false, error: listData })

    const msgId = listData.messages?.[0]?.id
    if (!msgId) return res.json({ ok: true, records: [], summary: null, message: '收件匣中沒有符合條件的信件' })

    const msgResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const msgData = await msgResp.json() as { payload?: Record<string, unknown>; snippet?: string; error?: unknown }
    if (!msgResp.ok) return res.status(msgResp.status).json({ ok: false, error: msgData })

    const b64 = msgData.payload ? findPlainText(msgData.payload) : null
    if (!b64) return res.json({ ok: true, records: [], summary: null, message: '找不到純文字內容（text/plain）' })

    const decoded = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    const plainText = decodeQP(decoded)

    const parsed = parseVersionReport(plainText)

    log('ok', getClientIP(req), getUser(req), 'Gmail 版本週報解析完成', `目標版本 ${parsed.targetVersion}，${parsed.records.length} 筆記錄`)
    const larkTargetRow = db.prepare(`SELECT targetVersion FROM machine_type_targets WHERE category = 'ImageRecon' LIMIT 1`).get() as { targetVersion: string } | undefined
    const effectiveTarget = larkTargetRow?.targetVersion ?? parsed.targetVersion
    const recordsWithLarkTarget = parsed.records.map((r: Record<string, unknown>) => ({
      ...r,
      targetVersion: effectiveTarget,
      status: r.currentVersion === effectiveTarget ? 'Match' : 'Mismatch',
    }))
    const matchCount = recordsWithLarkTarget.filter((r: Record<string, unknown>) => r.status === 'Match').length
    addHistory('imagerecon', `ImageRecon 週報解析 — 目標版本 ${effectiveTarget}`, `共 ${parsed.records.length} 台：符合 ${matchCount} 台，不符 ${parsed.records.length - matchCount} 台`, { targetVersion: effectiveTarget, generated: parsed.generated, records: recordsWithLarkTarget })
    res.json({ ok: true, ...parsed })
  } catch (error) {
    next(error)
  }
})

// POST /api/google/sheets/records
router.post('/api/google/sheets/records', async (req, res, next) => {
  try {
    const { sheetUrl } = z.object({ sheetUrl: z.string() }).parse(req.body)
    const { spreadsheetId, gid } = parseGoogleSheetUrl(sheetUrl)

    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, message: '無法解析 Google Sheets URL，格式應為 docs.google.com/spreadsheets/d/{id}/...' })
    }

    const apiKey = mustEnv('GOOGLE_API_KEY')

    const metaResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${apiKey}&fields=sheets.properties`,
    )
    const meta = await metaResp.json() as {
      sheets?: { properties: { sheetId: number; title: string } }[]
      error?: { message: string }
    }

    if (!metaResp.ok || meta.error) {
      return res.status(400).json({ ok: false, message: `Google Sheets API 錯誤: ${meta.error?.message ?? 'unknown'}` })
    }

    const sheet = meta.sheets?.find(s => String(s.properties.sheetId) === gid) ?? meta.sheets?.[0]
    if (!sheet) {
      return res.status(400).json({ ok: false, message: '找不到對應的工作表' })
    }
    const sheetName = sheet.properties.title

    const range = encodeURIComponent(`${sheetName}!A1:Z1000`)
    const valResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?key=${apiKey}`,
    )
    const valData = await valResp.json() as {
      values?: string[][]
      error?: { message: string }
    }

    if (!valResp.ok || valData.error) {
      return res.status(400).json({ ok: false, message: `讀取資料失敗: ${valData.error?.message ?? 'unknown'}` })
    }

    const rows = valData.values ?? []
    if (rows.length < 2) return res.json({ ok: true, headers: [], records: [] })

    const headers = rows[0].map(String)
    const jiraKeyHeader = headers.find(h => h.toLowerCase() === 'jira issue key') ?? 'Jira Issue Key'
    const stageHeader = headers.find(h => h === '處理階段') ?? ''

    const records = rows
      .slice(1)
      .map((row, i) => {
        const obj: Record<string, string> = {}
        headers.forEach((h, ci) => { obj[h] = String(row[ci] ?? '') })
        return { ...obj, _rowIndex: i + 2 }
      })
      .filter(r => {
        if (stageHeader) return r[stageHeader] !== '已完成'
        return !r[jiraKeyHeader] || r[jiraKeyHeader].trim() === ''
      })

    log('info', getClientIP(req), getUser(req), 'Google Sheet 讀取', `${records.length} 筆待處理`)
    res.json({ ok: true, headers, records, sheetName })
  } catch (error) {
    next(error)
  }
})

// POST /api/google/sheets/writeback
router.post('/api/google/sheets/writeback', async (req, res, next) => {
  try {
    if (!hasGoogleServiceAccount()) {
      return res.status(400).json({
        ok: false,
        message: 'Google Sheets 回寫需要設定 GOOGLE_SERVICE_ACCOUNT_EMAIL 與 GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
        needsSetup: true,
      })
    }

    const body = writebackSchema.parse(req.body)
    const { spreadsheetId, gid } = parseGoogleSheetUrl(body.sheetUrl)
    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, message: '無法解析 Google Sheets URL' })
    }

    const apiKey = mustEnv('GOOGLE_API_KEY')

    const metaResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${apiKey}&fields=sheets.properties`,
    )
    const meta = await metaResp.json() as { sheets?: { properties: { sheetId: number; title: string } }[] }
    const sheet = meta.sheets?.find(s => String(s.properties.sheetId) === gid) ?? meta.sheets?.[0]
    const sheetName = sheet?.properties.title ?? 'Sheet1'

    const accessToken = await getGoogleServiceAccountToken()

    const headerRange = encodeURIComponent(`${sheetName}!A1:Z1`)
    const headerResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${headerRange}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const headerData = await headerResp.json() as { values?: string[][] }
    const headers = headerData.values?.[0] ?? []
    const targetCol = body.issueKeyColumn.toLowerCase()
    const keyColIndex = headers.findIndex(h => h.toLowerCase() === targetCol)

    if (keyColIndex === -1) {
      return res.status(400).json({ ok: false, message: `找不到欄位「${body.issueKeyColumn}」（試算表標題列：${headers.join(', ')}）` })
    }

    const colLetter = String.fromCharCode(65 + keyColIndex)

    const writeResults = await Promise.all(
      body.writes.map(async ({ rowIndex, issueKey }) => {
        const range = `${sheetName}!${colLetter}${rowIndex}`
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ range, values: [[issueKey]] }),
          },
        )
        return { rowIndex, ok: r.ok }
      }),
    )

    res.json({ ok: true, results: writeResults })
  } catch (error) {
    next(error)
  }
})

// POST /api/sheets/writeback-multi
const writebackMultiSchema = z.object({
  sheetUrl: z.string(),
  source: z.enum(['lark', 'google']).default('lark'),
  writes: z.array(z.object({
    rowIndex: z.number(),
    columns: z.record(z.string(), z.string()),
  })),
})

router.post('/api/sheets/writeback-multi', async (req, res, next) => {
  try {
    console.log('[writeback-multi] body:', JSON.stringify(req.body).slice(0, 300))
    const body = writebackMultiSchema.parse(req.body)
    console.log('[writeback-multi] source:', body.source, 'writes:', body.writes.length)
    let results: { rowIndex: number; ok: boolean; error?: string }[]

    if (body.source === 'google') {
      if (!hasGoogleServiceAccount()) {
        return res.status(400).json({ ok: false, message: 'Google Sheets 回寫需設定 Service Account', needsSetup: true })
      }
      const accessToken = await getGoogleServiceAccountToken()
      results = await multiWritebackGoogle(body.sheetUrl, body.writes, accessToken)
    } else {
      results = await multiWritebackLark(body.sheetUrl, body.writes)
    }

    console.log('[writeback-multi] results:', JSON.stringify(results))
    const allOk = results.every(r => r.ok)
    res.json({ ok: true, allOk, results })
  } catch (error) {
    console.error('[writeback-multi] CAUGHT ERROR:', error)
    next(error)
  }
})

// POST /api/integrations/osm/version-sync
router.post('/api/integrations/osm/version-sync', (req, res, next) => {
  try {
    const body = osmVersionSyncSchema.parse(req.body)
    res.json({ ok: true, message: 'MVP: 已接收版本清單', count: body.rows.length })
  } catch (error) {
    next(error)
  }
})

// ─── URL Pool ────────────────────────────────────────────────────────────────

// DB table for admin-editable URL overrides (base data lives in frontend urlPoolData.ts)
db.exec(`CREATE TABLE IF NOT EXISTS url_pool_overrides (
  account TEXT PRIMARY KEY,
  url     TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`)

const URL_POOL_EXPIRE_MS = 8 * 60 * 60 * 1000 // 8 hours

// In-memory claim store: account -> { claimedBy, claimedAt }
type ClaimInfo = { claimedBy: string; claimedAt: number }
const urlPoolClaims = new Map<string, ClaimInfo>()

// SSE clients
const urlPoolSseClients = new Set<import('express').Response>()

function urlPoolPruneExpired() {
  const now = Date.now()
  for (const [account, info] of urlPoolClaims) {
    if (now - info.claimedAt > URL_POOL_EXPIRE_MS) urlPoolClaims.delete(account)
  }
}

function urlPoolBroadcast() {
  urlPoolPruneExpired()
  const data = Object.fromEntries(urlPoolClaims)
  const msg = `data: ${JSON.stringify(data)}\n\n`
  for (const client of urlPoolSseClients) {
    try { client.write(msg) } catch { urlPoolSseClients.delete(client) }
  }
}

// Periodic pruning every 30 min
setInterval(() => { urlPoolPruneExpired(); urlPoolBroadcast() }, 30 * 60 * 1000)

// GET /api/url-pool/stream — SSE
router.get('/api/url-pool/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()
  urlPoolPruneExpired()
  const data = Object.fromEntries(urlPoolClaims)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
  urlPoolSseClients.add(res)
  req.on('close', () => urlPoolSseClients.delete(res))
})

// GET /api/url-pool/status
router.get('/api/url-pool/status', (_req, res) => {
  urlPoolPruneExpired()
  res.json(Object.fromEntries(urlPoolClaims))
})

// GET /api/url-pool/go/:account — auto-claim + redirect (used as proxy URL)
router.get('/api/url-pool/go/:account', (req, res) => {
  const { account } = req.params
  const user = (req.query.user as string) || ''
  const to = (req.query.to as string) || ''
  let targetUrl = ''
  try { targetUrl = Buffer.from(to, 'base64').toString('utf8') } catch { /* ignore */ }
  if (!targetUrl) return res.status(400).send('Missing redirect target')

  // Auto-claim if not yet claimed or already claimed by same user
  const existing = urlPoolClaims.get(account)
  if (!existing || existing.claimedBy === user) {
    if (user) {
      urlPoolClaims.set(account, { claimedBy: user, claimedAt: Date.now() })
      urlPoolBroadcast()
    }
  }
  // Always redirect regardless of claim conflict (don't block access)
  return res.redirect(302, targetUrl)
})

// POST /api/url-pool/:account/claim
router.post('/api/url-pool/:account/claim', (req, res) => {
  const { account } = req.params
  const { claimedBy } = req.body as { claimedBy: string }
  if (!claimedBy) return res.status(400).json({ ok: false, message: 'missing claimedBy' })
  urlPoolPruneExpired()
  const existing = urlPoolClaims.get(account)
  if (existing && existing.claimedBy !== claimedBy) {
    return res.status(409).json({ ok: false, message: `已被 ${existing.claimedBy} 使用中` })
  }
  urlPoolClaims.set(account, { claimedBy, claimedAt: Date.now() })
  urlPoolBroadcast()
  return res.json({ ok: true })
})

// POST /api/url-pool/:account/release
router.post('/api/url-pool/:account/release', (req, res) => {
  const { account } = req.params
  const { claimedBy } = req.body as { claimedBy: string }
  const existing = urlPoolClaims.get(account)
  if (!existing) return res.json({ ok: true })
  if (claimedBy && existing.claimedBy !== claimedBy) {
    return res.status(403).json({ ok: false, message: '只能釋放自己使用的帳號' })
  }
  urlPoolClaims.delete(account)
  urlPoolBroadcast()
  return res.json({ ok: true })
})

// GET /api/url-pool/overrides — returns DB-saved URL overrides as { [account]: url }
router.get('/api/url-pool/overrides', (_req, res) => {
  const rows = db.prepare('SELECT account, url FROM url_pool_overrides').all() as { account: string; url: string }[]
  const map: Record<string, string> = {}
  for (const r of rows) map[r.account] = r.url
  return res.json(map)
})

// PUT /api/url-pool/:account/url — admin only, saves URL override to DB
router.put('/api/url-pool/:account/url', (req, res) => {
  const pin = process.env.ADMIN_PIN ?? ''
  const provided = String(req.headers['x-admin-pin'] ?? '')
  if (!pin || provided !== pin) return res.status(403).json({ ok: false, message: '需要管理員權限' })
  const { account } = req.params
  const { url } = req.body as { url?: string }
  if (!url) return res.status(400).json({ ok: false, message: 'missing url' })
  db.prepare(`INSERT INTO url_pool_overrides (account, url, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(account) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`)
    .run(account, url, new Date().toISOString())
  return res.json({ ok: true })
})

/**
 * server/routes/sheets.ts —— /api/lark/sheets/*（讀 Lark Sheet、回寫）。路徑本來就是中性的，2026-10-02 只把 router 從 routes/jira.ts 搬出來。
 * Meegle 五個工具與（停用前的）Jira 工具共用。
 */
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  db,
  addHistory,
  getClientIP,
  getUser,
  log,
  mustEnv,
  pinHash,
  readAccounts,
  upsertAccount,
  deleteAccountByEmail,
  userJiraAuth,
  toJiraDateTime,
  heavyLimiter,
  writeLimiter,
  getLarkToken,
  parseLarkSheetUrl,
  accountHasPermission,
  jiraAuthForAccount,
  matchAccountsByPersonName,
  hasJiraDelegation,
} from '../shared.js'
import { callLLM } from './gemini.js'
import { buildCompletenessPrompt, buildSpecContext, formatCommentWithAI } from '../comment-ai.js'
import { multiWritebackLark, multiWritebackLarkBatch, type MultiWrite } from './integrations.js'
import { getAuthAccount } from '../auth-session.js'
import { withRequestOperation } from '../request-context.js'
import { finishHeavyTask, heavyTaskConflict, tryStartHeavyTask, type HeavyTaskToken } from '../heavy-task-guard.js'
import { missingForcedRequiredFields } from '../../shared/jira-required-fields.js'
import { JIRA_KEY_EXACT_RE, JIRA_KEY_IN_TEXT_RE, JIRA_KEY_BRACKET_PREFIX_RE } from '../../shared/jira-key.js'
import { pickTransitionForTarget, type JiraTransitionLike } from '../../shared/jira-transition.js'
import {
  ATTACH_CACHE_DIR, AttachmentTooLargeError, cleanAttachmentCache, createAttachmentUploadHandler, createLease, holdLease,
  releaseLease, renewLease, safeUnlink, saveResponseToCache, startAttachmentCacheSweeper, touchCacheFile, uploadFileToJira, type CachedFile,
} from '../jira-attachment-files.js'


import { LARK_MEDIA_SCHEME } from '../attachment-downloads.js'

export const router = Router()

const writebackSchema = z.object({
  sheetUrl: z.string(),
  writes: z.array(z.object({ rowIndex: z.number(), issueKey: z.string() })),
  issueKeyColumn: z.string().default('Jira Issue Key'),
})

// POST /api/lark/sheets/records
router.post('/api/lark/sheets/records', async (req, res, next) => {
  try {
    const { sheetUrl, includeCreated } = z.object({ sheetUrl: z.string(), includeCreated: z.boolean().optional() }).parse(req.body)
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(sheetUrl)

    if (!spreadsheetToken) {
      return res
        .status(400)
        .json({ ok: false, message: '無法解析 Lark Sheet URL，格式應為 /sheets/{token}?sheet={id} 或 /wiki/{token}?sheet={id}' })
    }

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const range = sheetId ? `${sheetId}!A1:ZZ1000` : 'A1:ZZ1000'

    const larkHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const resp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
      { headers: larkHeaders },
    )
    const data = (await resp.json()) as {
      code?: number
      data?: { valueRange?: { values?: unknown[][] } }
    }

    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: 'Lark Sheets API 錯誤', detail: data })
    }

    const rows = data.data?.valueRange?.values ?? []
    if (rows.length < 2) return res.json({ ok: true, headers: [], records: [] })

    /** Lark Sheets API can return cell values as strings, numbers, booleans,
     *  or rich-text/formula objects. Extract the plain text string in all cases. */
    /** Extract http link URLs from rich-text array runs (for attachment/hyperlink cells). */
    const extractCellUrls = (cell: unknown): string[] => {
      if (!Array.isArray(cell)) return []
      const urls: string[] = []
      for (const run of cell as Array<{ text?: string; link?: string; type?: string; fileToken?: string }>) {
        if (typeof run.link === 'string' && run.link.startsWith('http')) urls.push(run.link)
        // 「插入 → 附件」的檔案：保留 fileToken，附件預載才下載得到（原本攤平成只剩檔名）
        else if (run.type === 'attachment' && typeof run.fileToken === 'string' && run.fileToken) {
          urls.push(`${LARK_MEDIA_SCHEME}${run.fileToken}/${encodeURIComponent(run.text ?? '')}`)
        }
      }
      return urls
    }

    const extractCell = (cell: unknown): string => {
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
      if (typeof cell === 'string') {
        // If the API returned the formula text instead of the computed value, return as-is.
        // (returnFormula=false should have prevented this, but guard just in case)
        return cell
      }
      if (Array.isArray(cell)) {
        // Lark rich-text array: [{text:"CGMN-1", link:"...", type:"url"}, {text:"\n"}, ...]
        return (cell as Array<{ text?: string }>).map(run => run.text ?? '').join('')
      }
      if (typeof cell === 'object') {
        const c = cell as Record<string, unknown>
        // Inline image cells: { type: "embed-image", fileToken: "...", link: "..." }
        // Return the link URL so the attachment pipeline can download via Lark media API
        if (c.type === 'embed-image' && typeof c.link === 'string' && c.link) return c.link
        // Formula cells: Lark may return computed value in various fields
        if (typeof c.formulaValue === 'string') return c.formulaValue
        if (c.formulaValue !== undefined && c.formulaValue !== null) return String(c.formulaValue)
        if (typeof c.displayValue === 'string') return c.displayValue
        if (typeof c.computedValue === 'string') return c.computedValue
        if (c.computedValue !== undefined && c.computedValue !== null) return String(c.computedValue)
        // Rich-text cells
        if (typeof c.text === 'string') return c.text
        if (Array.isArray(c.text)) return (c.text as Array<{ text?: string }>).map(t => t.text ?? '').join('')
        if (typeof c.value === 'string') return c.value
        if (c.value !== undefined && c.value !== null) return String(c.value)
      }
      return ''
    }

    const headers = (rows[0] as unknown[]).map(extractCell)
    const jiraKeyHeader = headers.find(h => h.toLowerCase() === 'jira issue key') ?? 'Jira Issue Key'
    const stageHeader = headers.find(h => h === '處理階段') ?? ''

    /**
     * Try to evaluate complex Lark formula bodies using raw row data.
     * Handles the pattern: IF(Xn<>"", IFERROR(INDEX(SPLIT(Xn, CHAR(c)), n), ""), "")
     * which extracts the nth line of a cell split by a character (e.g. newline).
     */
    const tryEvalComplexFormula = (formula: string, rawRow: unknown[]): string | null => {
      // Match IF(ColRef<>"", IFERROR(INDEX(SPLIT(ColRef, CHAR(charCode)), lineNum), ""), "")
      const m = formula.match(
        /^IF\(\s*([A-Z]+)\d*\s*<>""\s*,\s*IFERROR\(\s*INDEX\(\s*SPLIT\(\s*([A-Z]+)\d*\s*,\s*CHAR\(\s*(\d+)\s*\)\s*\)\s*,\s*(\d+)\s*\)\s*,\s*""\s*\)\s*,\s*""\s*\)$/i
      )
      if (!m) return null
      const colLetters = m[2]
      const charCode = parseInt(m[3], 10)
      const lineNum = parseInt(m[4], 10) - 1  // 1-based → 0-based
      const separator = String.fromCharCode(charCode)
      const colIndex = colLetters.split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1
      const cellVal = extractCell(rawRow[colIndex])
      if (!cellVal) return ''
      const parts = cellVal.split(separator)
      return parts[lineNum] ?? ''
    }

    /**
     * Lark v2 returns formula cells as the formula body string (without `=`).
     * Evaluate simple concatenation formulas like `"prefix"&G2` or `"a"&"b"`
     * using the raw cell values from the same row.
     */
    const evalFormula = (formula: string, rawRow: unknown[]): string => {
      // Split on & and evaluate each token
      const tokens = formula.split('&').map(t => t.trim())
      const parts: string[] = []
      for (const token of tokens) {
        if (token.startsWith('"') && token.endsWith('"')) {
          // Quoted string literal
          parts.push(token.slice(1, -1))
        } else {
          // Cell reference like G2, A1 — column letter(s) + row number
          const m = token.match(/^([A-Z]+)(\d+)$/)
          if (m) {
            const colIndex = m[1].split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1
            const cell = rawRow[colIndex]
            parts.push(extractCell(cell))
          } else {
            // Unknown token — include as-is
            parts.push(token)
          }
        }
      }
      return parts.join('')
    }

    // Cross-sheet formula reference pattern: 'SheetName'!CellRef (e.g. '填寫'!H1)
    const CROSS_SHEET_RE = /^'([^']+)'![A-Z]+\d+$/

    // First pass: extract raw string values and collect cross-sheet formula refs
    const dataRows = rows.slice(1)

    const rawStrRows = dataRows.map(row => (row as unknown[]).map(cell => extractCell(cell)))

    const formulaRefs = new Set<string>()
    for (const row of rawStrRows) {
      for (const val of row) {
        if (val && CROSS_SHEET_RE.test(val)) formulaRefs.add(val)
      }
    }

    // Batch-resolve cross-sheet formula references via Lark values_batch_get
    const resolvedMap = new Map<string, string>()
    if (formulaRefs.size > 0) {
      try {
        const params = [...formulaRefs].map(r => `ranges=${encodeURIComponent(r)}`).join('&')
        const batchResp = await fetch(
          `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_batch_get?${params}`,
          { headers: larkHeaders },
        )
        if (batchResp.ok) {
          const batchData = await batchResp.json() as {
            code?: number
            data?: { valueRanges?: { values?: unknown[][]; range?: string }[] }
          }
          if (batchData.code === 0) {
            for (const vr of batchData.data?.valueRanges ?? []) {
              const ref = vr.range?.trim()
              const cellVal = vr.values?.[0]?.[0]
              if (ref && cellVal !== undefined) resolvedMap.set(ref, extractCell(cellVal))
            }
          }
        }
      } catch (e) {
        console.warn('[lark-sheets] cross-sheet formula resolution failed:', e)
      }
    }

    const records = dataRows
      .map((row, i) => {
        const rawRow = row as unknown[]
        const strRow = rawStrRows[i]
        const obj: Record<string, string> = {}
        headers.forEach((h, ci) => {
          let val = strRow[ci]
          if (val && CROSS_SHEET_RE.test(val)) {
            // Try exact match, then try without single-quoted sheet name
            val = resolvedMap.get(val) ?? resolvedMap.get(val.replace(/^'([^']+)'/, '$1')) ?? val
          } else if (val && /^(".*"|[A-Z]+\d+)(&(".*"|[A-Z]+\d+))+$/.test(val)) {
            // Same-sheet concatenation formula
            val = evalFormula(val, rawRow)
          } else if (val && /^[A-Z_]+\(/.test(val)) {
            // Lark v2 returns complex formula body — try to evaluate it, else empty
            const evaluated = tryEvalComplexFormula(val, rawRow)
            val = evaluated !== null ? evaluated : ''
          }
          obj[h] = val
          // For hyperlink cells, also store the actual link URLs so attachment pipeline can download them
          const linkUrls = extractCellUrls(rawRow[ci])
          if (linkUrls.length > 0) obj[`${h}__url`] = linkUrls.join('\n')
        })
        return { ...obj, _rowIndex: i + 2 }
      })
      .filter((r) => {
        // Skip completely empty rows — ignore serial-number / checkbox / blank columns
        // "編號" is a row-counter column, not real content
        const SERIAL_HEADERS = new Set(['編號', 'No.', 'No', '#', 'no'])
        const hasAnyContent = headers.some(h => {
          if (!h || !h.trim()) return false   // unnamed column
          if (SERIAL_HEADERS.has(h.trim())) return false  // serial-number column — not real content
          const v = r[h]?.trim()
          if (!v || v === '0' || v === 'false') return false
          return true
        })
        if (!hasAnyContent) return false
        if (stageHeader) return r[stageHeader] !== '已完成'
        // includeCreated=true: return ALL non-empty rows (for batch-edit/comment);
        // frontend extractJiraIssuesFromRecords() will filter to rows with Jira keys.
        if (includeCreated) return true
        return !r[jiraKeyHeader] || r[jiraKeyHeader].trim() === ''
      })

    log('info', getClientIP(req), getUser(req), 'Lark Sheet 讀取', `${records.length} 筆待處理`)
    res.json({ ok: true, headers, records })
  } catch (error) {
    next(error)
  }
})


// POST /api/lark/sheets/writeback
router.post('/api/lark/sheets/writeback', async (req, res, next) => {
  try {
    const body = writebackSchema.parse(req.body)
    const { spreadsheetToken, sheetId } = parseLarkSheetUrl(body.sheetUrl)
    if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 Sheet URL' })

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

    const headerRange = sheetId ? `${sheetId}!A1:Z1` : 'A1:Z1'
    const headerResp = await fetch(
      `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${headerRange}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const headerData = (await headerResp.json()) as { data?: { valueRange?: { values?: unknown[][] } } }
    const headers = ((headerData.data?.valueRange?.values?.[0] ?? []) as unknown[]).map(String)
    const targetCol = body.issueKeyColumn.toLowerCase()
    const keyColIndex = headers.findIndex(h => h.toLowerCase() === targetCol)

    if (keyColIndex === -1) {
      return res.status(400).json({ ok: false, message: `找不到欄位「${body.issueKeyColumn}」（試算表標題列：${headers.join(', ')}）` })
    }

    const colLetter = String.fromCharCode(65 + keyColIndex)

    const writeResults = await Promise.all(
      body.writes.map(async ({ rowIndex, issueKey }) => {
        const cell = `${colLetter}${rowIndex}`
        const range = sheetId ? `${sheetId}!${cell}:${cell}` : `${cell}:${cell}`
        const r = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueRange: { range, values: [[issueKey]] } }),
        })
        return { rowIndex, ok: r.ok }
      }),
    )

    res.json({ ok: true, results: writeResults })
  } catch (error) {
    next(error)
  }
})


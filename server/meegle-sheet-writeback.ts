/**
 * Meegle 開單結果回填 Lark Sheet（v4.267.0，使用者要求、CodeX 設計 review）。
 *
 * 寫三欄：「Meegle 單號」（超連結）、「處理階段」、「處理時間」。欄位不存在就自動加在最右邊（使用者選 A）。
 *
 * 避開以前踩過的坑：
 * - 欄位超過 Z：沿用 `multiWritebackLarkBatch`（表頭讀 A1:ZZ2、欄位字母 AA 以後正確換算、缺欄位自動建、
 *   檢查 Lark 回應的 code——Lark 失敗也常回 HTTP 200）。舊的 Jira 回填只看 A1:Z1、用 fromCharCode，超過 Z 會寫錯欄
 * - **寫到別列**：列號是讀 Sheet 當下的，之後有人插列／刪列就對不上。寫入前讀那一列的摘要／標題，
 *   跟開單時的名稱不同就**不寫**、標「列已變動」。⚠️ 這只是防呆不是保證（CodeX）：同名列被刪、另一筆補進同位置，
 *   名稱一樣照樣會過；讀完到寫入之間有人插列也擋不住。要可靠得換成「來源列 UUID」（下一版選項）
 * - **舊回填蓋掉新狀態**：同一份 Sheet 用行程內的鎖排隊；拿到鎖之後才從 DB 讀**最新**的列組內容，
 *   寫完只有在版本（writeback_rev，每次標 pending 就 +1）沒變時才標 done，途中狀態又變了就維持 pending
 * - 回填失敗不影響開單結果；④ 顯示、可以「補寫回」（只用已存的單號，不重開）
 *
 * Lark 相關的讀寫從外面傳進來，測試用假的。
 */
import type Database from 'better-sqlite3'
import { finishWriteback, getBatchRow, rowSheetName, writebackStageText, type BatchRow } from './meegle-batch-store.js'

type DB = Database.Database

/** 回填的欄位。「單子標題貼這」跟 Jira 回填同格式（使用者要求）：單號超連結＋換行＋任務名稱；欄名比對會忽略空白與 ↓ */
export const WB_COLUMNS = { id: 'Meegle 單號', stage: '處理階段', time: '處理時間', title: '單子標題貼這' } as const

/** 超連結一定要用 richtext 的 segments 形式——{ type:'url', text, link } 會被 Lark 拒絕（實測 code 90204 invalid cell type） */
export type SheetCell = string | { type: 'richtext'; segments: Array<{ text: string; link?: string }> }

export type WritebackDeps = {
  /** 讀這一列的摘要、標題，以及「單子標題貼這」目前的內容（讀不到回 null；沒有那欄 pasted 就是空字串） */
  readRowNames: (sheetKey: string, rowIndex: number) => Promise<{ summary: string; title: string; pasted?: string } | null>
  /** 寫一列多欄；欄位不存在就建 */
  writeRow: (sheetKey: string, rowIndex: number, columns: Record<string, SheetCell>) => Promise<{ ok: boolean; error?: string }>
  now?: () => number
}

/** 名稱正規化：跟 planRow 取任務名稱同一套（換行換成空白、去頭尾空白） */
export function normName(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 這一列在 Sheet 上的「任務名稱」：摘要優先，沒有才用標題（跟 shared/meegle-batch-rules.ts planRow 一致） */
export function rowNameFromCells(c: { summary: string; title: string }): string {
  return normName(c.summary) || normName(c.title)
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })

/** 每份 Sheet 一條佇列：同一份 Sheet 的回填一個接一個，不同 Sheet 互不影響 */
const queues = new Map<string, Promise<unknown>>()
export function withSheetLock<T>(sheetKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(sheetKey) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  queues.set(sheetKey, next.catch(() => {}))
  return next
}

export type WritebackOutcome = { phase: 'done' | 'failed' | 'skipped'; message?: string }

/**
 * 回填一列。可以重複呼叫（補寫回）：每次都從 DB 讀最新狀態組內容。
 * 不需要回填的（還沒開成單、沒有來源 Sheet、已經是 done 且沒有新變化）直接跳過。
 */
export async function writebackRow(db: DB, batchId: string, rowKey: string, deps: WritebackDeps,
  opts: { force?: boolean; /** 呼叫端已經拿著這份 Sheet 的鎖（補回被清掉的回填：讀單號、判定、寫入要在同一把鎖內——CodeX 60c61d3 [P1]） */ lockHeld?: boolean } = {}): Promise<WritebackOutcome> {
  const first = getBatchRow(db, batchId, rowKey)
  if (!first || first.create_phase !== 'created' || !first.work_item_id) return { phase: 'skipped', message: '這一列還沒開單成功' }
  if (!first.sheet_url.startsWith('lark:')) return { phase: 'skipped', message: '來源不是 Lark Sheet' }
  const locked = <T>(fn: () => Promise<T>) => opts.lockHeld ? fn() : withSheetLock(first.sheet_url, fn)
  return locked(async () => {
    // 拿到鎖之後才讀最新狀態——排隊期間可能又推了狀態
    const row = getBatchRow(db, batchId, rowKey) as BatchRow
    if (row.writeback_phase === 'done' && !opts.force) return { phase: 'skipped', message: '已經寫回過' }
    const seen = row.writeback_rev
    const now = deps.now?.() ?? Date.now()
    const rowIndex = Number(row.row_key)
    const fail = (message: string): WritebackOutcome => { finishWriteback(db, batchId, rowKey, seen, false, message, now); return { phase: 'failed', message } }
    if (!Number.isInteger(rowIndex) || rowIndex < 2) return fail(`列號不合法：${row.row_key}`)

    let cells: { summary: string; title: string; pasted?: string } | null
    try { cells = await deps.readRowNames(row.sheet_url, rowIndex) } catch (e) { return fail(`讀不到 Sheet 第 ${rowIndex} 列：${(e as Error).message}`) }
    if (!cells) return fail(`讀不到 Sheet 第 ${rowIndex} 列的摘要／標題`)
    const onSheet = rowNameFromCells(cells)
    // 跟開單時 Sheet 上的名稱比（rowSheetName），不跟送出的任務名稱比——AI／手改過名稱的列會永遠對不上（v5.26.0）
    const expected = normName(rowSheetName(row))
    if (onSheet !== expected) {
      return fail(`列已變動：第 ${rowIndex} 列現在是「${onSheet || '（空白）'}」，不是開單時的「${expected}」。為了不寫到別列，沒有寫回`)
    }

    const columns: Record<string, SheetCell> = {
      [WB_COLUMNS.id]: row.url ? { type: 'richtext', segments: [{ text: `#${row.work_item_id}`, link: row.url }] } : `#${row.work_item_id}`,
      [WB_COLUMNS.stage]: writebackStageText(row),
      [WB_COLUMNS.time]: fmtTime(now),
      // 跟 Jira 回填（routes/jira.ts）同一個格式：第一段是單號超連結，第二段換行接任務名稱
      [WB_COLUMNS.title]: { type: 'richtext', segments: [row.url ? { text: `#${row.work_item_id}`, link: row.url } : { text: `#${row.work_item_id}` }, { text: `\n${normName(row.name)}` }] },
    }
    /**
     * 「單子標題貼這」已經有**別張單**（例如 Jira 的 CGFB-50）就不覆蓋，保留原值（CodeX review 15ba814）。
     * 只有空白、或本來就是同一張 Meegle 單（補寫回）才寫。其他三欄照寫。
     */
    let note: string | null = null
    const pasted = normName(cells.pasted ?? '')
    // 比對第一個字（單號）要完全相同——用 startsWith 的話 #151914590 也會被當成 #15191459
    if (pasted && pasted.split(' ')[0] !== `#${row.work_item_id}`) {
      delete columns[WB_COLUMNS.title]
      note = `「單子標題貼這」已經有別張單（${pasted.split(' ')[0]}），保留原值沒有覆蓋`
    }
    let r: { ok: boolean; error?: string }
    try { r = await deps.writeRow(row.sheet_url, rowIndex, columns) } catch (e) { r = { ok: false, error: (e as Error).message } }
    finishWriteback(db, batchId, rowKey, seen, r.ok, r.ok ? note : `寫入 Sheet 失敗：${r.error ?? '未知錯誤'}`, now)
    return r.ok ? { phase: 'done', ...(note ? { message: note } : {}) } : { phase: 'failed', message: r.error }
  })
}

/** Lark 讀表頭的上限：A1:ZZ（第 702 欄，0-based 701）。超過這裡的欄位我們看不到，寫過去可能蓋掉別人的資料 */
export const MAX_COL_IDX = 26 + 26 * 26 - 1

/**
 * 先算好每個要寫的欄位落在第幾欄（已存在的用原位置，缺的從最後一個非空表頭後面接）。純函式。
 * **任何一欄超過 ZZ 就整筆拒寫**（CodeX review d7d2d20 [P2]）——`multiWritebackLarkBatch` 本身不擋，
 * 表頭滿到 ZZ 時會照樣寫到 AAA～AAC，那幾欄要是有資料就被蓋掉，而且回傳成功。
 */
export function planColumns(headerCandidates: string[][], nextAppendColIdx: number, names: string[]): { ok: true; idx: Record<string, number> } | { ok: false; error: string } {
  const norm = (x: string) => x.replace(/[\s\n↓↑→←]+/g, '').toLowerCase()
  const idx: Record<string, number> = {}
  let append = nextAppendColIdx
  for (const n of names) {
    const found = headerCandidates.findIndex(c => c.some(h => norm(h) === norm(n)))
    idx[n] = found !== -1 ? found : append++
  }
  const over = names.filter(n => idx[n] > MAX_COL_IDX)
  if (over.length) return { ok: false, error: `欄位超過 ZZ（${over.join('、')} 會落在第 ${idx[over[0]] + 1} 欄），為了不蓋到別的資料沒有寫入。請刪掉不用的欄位，或手動在 ZZ 以內建好這幾欄` }
  return { ok: true, idx }
}

// ─── 真的 Lark 讀寫（路由用）────────────────────────────────────────────────

/** `lark:token:sheetId` → 給既有 Lark helper 用的網址 */
export function sheetKeyToUrl(sheetKey: string): string {
  const [, token, sheetId] = sheetKey.split(':')
  return `https://open.larksuite.com/sheets/${token}${sheetId ? `?sheet=${sheetId}` : ''}`
}

function cellText(c: unknown): string {
  if (c == null) return ''
  if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') return String(c)
  if (Array.isArray(c)) return c.map(x => (x && typeof x === 'object' && 'text' in x ? String((x as { text?: unknown }).text ?? '') : '')).join('')
  if (typeof c === 'object' && 'text' in (c as object)) return String((c as { text?: unknown }).text ?? '')
  return ''
}

/**
 * 讀某一列的幾個欄位（依欄名找欄，FormattedValue）。欄名都找不到回 null；個別找不到的欄回空字串。
 * 給 Meegle 批量評論回填前核對「這一列的 Meegle 單號還是不是這張單」用。
 */
export async function larkReadRowCells(sheetKey: string, rowIndex: number, names: string[]): Promise<Record<string, string> | null> {
  const { resolveSheetHeaders, colIndexToLetter, normalizeColName } = await import('./routes/integrations.js')
  const { getLarkToken } = await import('./shared.js')
  const [, spreadsheetToken, sheetId] = sheetKey.split(':')
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const { headerCandidates } = await resolveSheetHeaders(base, token, spreadsheetToken, sheetId)
  const idxs = names.map(name => headerCandidates.findIndex(c => c.some(h => normalizeColName(h) === normalizeColName(name))))
  if (idxs.every(i => i < 0)) return null
  const out: Record<string, string> = {}
  for (let k = 0; k < names.length; k++) {
    const i = idxs[k]
    if (i < 0) { out[names[k]] = ''; continue }
    const L = colIndexToLetter(i)
    const range = sheetId ? `${sheetId}!${L}${rowIndex}:${L}${rowIndex}` : `${L}${rowIndex}:${L}${rowIndex}`
    const resp = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}?valueRenderOption=FormattedValue`, { headers: { Authorization: `Bearer ${token}` } })
    const j = await resp.json() as { code?: number; msg?: string; data?: { valueRange?: { values?: unknown[][] } } }
    if (!resp.ok || j.code !== 0) throw new Error(`Lark 讀取失敗：HTTP ${resp.status} code ${j.code} ${j.msg ?? ''}`)
    out[names[k]] = cellText(j.data?.valueRange?.values?.[0]?.[0])
  }
  return out
}

/**
 * 一次讀整欄（第 1～lastRow 列，依欄名找欄，FormattedValue）。回傳 { 欄名: { 列號: 文字 } }；欄名找不到的那欄是空物件。
 * 給補回填「掃描 Sheet」用——逐列讀的話每一列都要重新解析表頭、打一次 API。
 */
export async function larkReadColumns(sheetKey: string, names: string[], lastRow: number): Promise<{ found: Record<string, boolean>; cells: Record<string, Record<number, string>> }> {
  const { resolveSheetHeaders, colIndexToLetter, normalizeColName } = await import('./routes/integrations.js')
  const { getLarkToken } = await import('./shared.js')
  const [, spreadsheetToken, sheetId] = sheetKey.split(':')
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const { headerCandidates } = await resolveSheetHeaders(base, token, spreadsheetToken, sheetId)
  const found: Record<string, boolean> = {}
  const cells: Record<string, Record<number, string>> = {}
  for (const name of names) {
    cells[name] = {}
    const i = headerCandidates.findIndex(c => c.some(h => normalizeColName(h) === normalizeColName(name)))
    found[name] = i >= 0
    if (i < 0) continue
    const L = colIndexToLetter(i)
    const range = sheetId ? `${sheetId}!${L}1:${L}${lastRow}` : `${L}1:${L}${lastRow}`
    const resp = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}?valueRenderOption=FormattedValue`, { headers: { Authorization: `Bearer ${token}` } })
    const j = await resp.json() as { code?: number; msg?: string; data?: { valueRange?: { values?: unknown[][] } } }
    if (!resp.ok || j.code !== 0) throw new Error(`Lark 讀取失敗：HTTP ${resp.status} code ${j.code} ${j.msg ?? ''}`)
    const vals = j.data?.valueRange?.values ?? []
    vals.forEach((row, k) => { cells[name][k + 1] = cellText(row?.[0]) })
  }
  return { found, cells }
}

export function larkWritebackDeps(): WritebackDeps {
  return {
    async readRowNames(sheetKey, rowIndex) {
      // integrations 很重，用到才載入
      const { resolveSheetHeaders, colIndexToLetter, normalizeColName } = await import('./routes/integrations.js')
      const { getLarkToken } = await import('./shared.js')
      const [, spreadsheetToken, sheetId] = sheetKey.split(':')
      const token = await getLarkToken()
      const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
      const { headerCandidates } = await resolveSheetHeaders(base, token, spreadsheetToken, sheetId)
      // 欄名比對跟寫入 helper 用同一支 normalizeColName——各寫一套的話讀寫會認到不同欄（CodeX review 0e11d3a）
      const idx = (name: string) => headerCandidates.findIndex(c => c.some(h => normalizeColName(h) === normalizeColName(name)))
      const read = async (i: number) => {
        if (i < 0) return ''
        const L = colIndexToLetter(i)
        const range = sheetId ? `${sheetId}!${L}${rowIndex}:${L}${rowIndex}` : `${L}${rowIndex}:${L}${rowIndex}`
        // ⚠️ 一定要 FormattedValue：「摘要」常是公式（實測 `"["&F2&"]["&E2&"]"&I2`），預設回的是公式原文，
        //    拿去比對永遠對不上、每一列都會被當成「列已變動」（2026-10-02 用使用者的真 Sheet 讀出來的）
        const resp = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}?valueRenderOption=FormattedValue`, { headers: { Authorization: `Bearer ${token}` } })
        const j = await resp.json() as { code?: number; msg?: string; data?: { valueRange?: { values?: unknown[][] } } }
        if (!resp.ok || j.code !== 0) throw new Error(`Lark 讀取失敗：HTTP ${resp.status} code ${j.code} ${j.msg ?? ''}`)
        return cellText(j.data?.valueRange?.values?.[0]?.[0])
      }
      const si = idx('摘要'), ti = idx('標題')
      if (si < 0 && ti < 0) return null
      const pi = idx(WB_COLUMNS.title)
      return { summary: await read(si), title: await read(ti), pasted: await read(pi) }
    },
    async writeRow(sheetKey, rowIndex, columns) {
      const { multiWritebackLarkBatch, resolveSheetHeaders } = await import('./routes/integrations.js')
      const { getLarkToken } = await import('./shared.js')
      // 寫之前先算好欄位位置：任何一欄超過 ZZ 就不寫（helper 自己不擋）
      const [, spreadsheetToken, sheetId] = sheetKey.split(':')
      const token = await getLarkToken()
      const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
      const { headerCandidates, nextAppendColIdx } = await resolveSheetHeaders(base, token, spreadsheetToken, sheetId)
      const plan = planColumns(headerCandidates, nextAppendColIdx, Object.keys(columns))
      // server tsconfig 沒開 strictNullChecks，聯集要用 'error' in 縮小
      if ('error' in plan) return { ok: false, error: plan.error }
      // 上面的預檢只是給好懂的錯誤訊息；**真正的關卡是 maxColIdx**——helper 會再讀一次表頭，
      // 兩次之間被塞滿的話，只有它自己最後那次的檢查擋得住（CodeX review bca81a7 [P2]）
      try {
        const [res] = await multiWritebackLarkBatch(sheetKeyToUrl(sheetKey), [{ rowIndex, columns }], { maxColIdx: MAX_COL_IDX })
        return res ? { ok: res.ok, error: res.error } : { ok: false, error: '沒有回傳結果' }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  }
}

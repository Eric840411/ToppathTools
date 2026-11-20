/**
 * 從 Lark「驗證表單_v2」一次匯入（之後工具就是主檔，不再讀這張表；沿用 33 的冪等做法）。
 *
 * 表的形狀（2026-11-20 唯讀查看，fixture 一律合成、不 commit 真實內容）：
 *   - 一張表裡有好幾段，每段以一列表頭開始：日期／類別／主題／<前綴>版本／描述／圖／確認OK／進度／備註／Meegle 單號／環境…
 *     「版本」表頭格的第 2 行起是當時的正式版本（例 Center Server:2.1.112）→ 批次的正式版本快照
 *     表頭寫「LL版本」這種帶前綴的段落 → 批次名稱加 -LL
 *   - 資料列：日期是 Excel 序號、只寫在每組第一列（後面空白＝沿用）；類別＝平台（可多個，逗號分隔）、主題＝類型、
 *     確認 OK＝OK 數量、進度＝結果、Meegle 單號「#16468199」、圖＝附件（API 只給 {id,type:'attachment'}，拿不到檔案）
 *   - 底下有大量空列與公式殘留（IF(…)），一律略過
 * 一段＝一個批次，名稱用該段第一個日期（年份＋MMDD）。冪等：批次 source_key＝表:頁:h表頭列、項目＝表:頁:列號。
 */
import type Database from 'better-sqlite3'
import { serialToDate } from '../shared/osm-release-rules.js'
import { createBatch, createItem, getItem } from './osm-verify-store.js'
import type { ItemInput } from '../shared/osm-verify-rules.js'

type Cell = string | number | null | undefined | Record<string, unknown> | unknown[]
export const DEFAULT_SOURCE = { token: 'JjLosMhsShlrfatriEBlX3d7gLd', sheetId: '1Xp7sf' } as const

function text(c: Cell): string {
  if (c == null) return ''
  if (typeof c === 'number') return String(c)
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => (x && typeof x === 'object' && 'text' in x ? String((x as { text?: unknown }).text ?? '') : '')).join('')
  return String((c as { text?: unknown }).text ?? '')
}
const norm = (s: string) => s.replace(/\s+/g, '')
const FORMULA = /^(IF|IFERROR|ROW|COUNTIF|COUNTA|INDEX|SPLIT|VLOOKUP|CONCATENATE)\(/i

export interface ParsedSection {
  headerRow: number
  label: string                 // 版本欄表頭的前綴（LL）；一般段落空字串
  prodVersion: string
  firstDate: string             // YYYY-MM-DD；沒有就空字串
  items: (ItemInput & { rowIndex: number; ticket: string })[]
}

function isHeader(r: Cell[]): boolean {
  const cells = r.map(c => norm(text(c)))
  return cells.includes('描述') && cells.includes('類別')
}

export function parseVerifySheet(rows: Cell[][]): ParsedSection[] {
  const sections: ParsedSection[] = []
  for (let h = 0; h < rows.length; h++) {
    if (!isHeader(rows[h] ?? [])) continue
    const head = rows[h]
    const col = (label: string) => head.findIndex(c => norm(text(c)) === label)
    // 表頭格第一行是「版本」或「LL版本」，後面幾行是當時的正式版本
    const colVersion = head.findIndex(c => /版本$/.test((text(c).trim().split('\n')[0] ?? '').replace(/\s+/g, '')))
    const cDate = col('日期'), cPlat = col('類別'), cType = col('主題'), cDesc = col('描述'), cAtt = col('圖')
    const cOk = col('確認OK'), cRes = col('進度'), cRem = col('備註'), cTicket = col('Meegle單號'), cEnv = col('環境'), cWho = col('填寫人')
    const vHead = colVersion >= 0 ? text(head[colVersion]).trim() : ''
    const firstLine = vHead.split('\n')[0]?.trim() ?? ''
    const label = firstLine.replace(/版本$/, '').trim()
    const sec: ParsedSection = { headerRow: h, label, prodVersion: vHead.split('\n').slice(1).map(s => s.trim()).filter(Boolean).join('\n'), firstDate: '', items: [] }
    for (let i = h + 1; i < rows.length && !isHeader(rows[i] ?? []); i++) {
      const r = rows[i] ?? []
      const desc = cDesc >= 0 ? text(r[cDesc]).trim() : ''
      if (!desc || FORMULA.test(desc)) continue
      const d = cDate >= 0 ? serialToDate(text(r[cDate])) : ''
      if (d && !sec.firstDate) sec.firstDate = d
      const att = cAtt >= 0 ? r[cAtt] : null
      const attText = Array.isArray(att)
        ? `Lark 附件 ${att.length} 個（未搬移檔案）`
        : text(att).trim()
      const ver = colVersion >= 0 ? text(r[colVersion]).trim() : ''
      const remark = [ver && `版本：${ver}`, cRem >= 0 ? text(r[cRem]).trim() : ''].filter(Boolean).join('\n')
      const ok = cOk >= 0 ? Number(text(r[cOk])) : 0
      const ticket = (cTicket >= 0 ? text(r[cTicket]) : '').match(/#?(\d{6,})/)?.[1] ?? ''
      sec.items.push({
        rowIndex: i,
        platform: cPlat >= 0 ? text(r[cPlat]).trim() : '',
        type: cType >= 0 ? text(r[cType]).trim() : '',
        description: desc,
        env: cEnv >= 0 ? text(r[cEnv]).trim() : '',
        result: cRes >= 0 ? text(r[cRes]).trim() : '',
        okCount: Number.isInteger(ok) && ok >= 0 ? ok : 0,
        verifier: cWho >= 0 ? text(r[cWho]).trim() : '',
        attachments: attText,
        remark,
        ticket,
      })
    }
    sections.push(sec)
  }
  return sections
}

export interface ImportResult { section: number; batch?: string; added: number; skipped: number; tickets: number; error?: string }

/** 匯進資料庫（冪等：重跑只補沒匯過的批次／項目；已匯過的單號不重複建） */
export function applyVerifySections(db: Database.Database, p: { sheetKey: string; sections: ParsedSection[]; actor: string; now?: number }): ImportResult[] {
  const out: ImportResult[] = []
  for (const s of p.sections) {
    if (!s.items.length) { out.push({ section: s.headerRow, added: 0, skipped: 0, tickets: 0, error: '這段沒有資料' }); continue }
    if (!s.firstDate) { out.push({ section: s.headerRow, added: 0, skipped: s.items.length, tickets: 0, error: '這段沒有任何日期，無法決定批次名稱' }); continue }
    const batchKey = `${p.sheetKey}:h${s.headerRow}`
    const year = Number(s.firstDate.slice(0, 4))
    const batch = s.firstDate.slice(5, 7) + s.firstDate.slice(8, 10) + (s.label ? `-${s.label.replace(/[^0-9A-Za-z._-]/g, '') || 'X'}` : '')
    let batchId = (db.prepare('SELECT id FROM osm_verify_batches WHERE source_key = ?').get(batchKey) as { id: string } | undefined)?.id
    if (!batchId) {
      const r = createBatch(db, { year, batch, publishStatus: 'draft', prodVersion: s.prodVersion }, p.actor, { sourceKey: batchKey, now: p.now })
      if ('reason' in r) { out.push({ section: s.headerRow, batch: `${year}-${batch}`, added: 0, skipped: s.items.length, tickets: 0, error: r.message }); continue }
      batchId = r.id
    }
    let added = 0, skipped = 0, tickets = 0
    for (const it of s.items) {
      const key = `${p.sheetKey}:${it.rowIndex}`
      if (db.prepare('SELECT 1 FROM osm_verify_items WHERE source_key = ?').get(key)) { skipped++; continue }
      const { rowIndex: _r, ticket, ...input } = it
      const r = createItem(db, batchId, input, p.actor, { sourceKey: key, now: p.now })
      if ('reason' in r) { skipped++; continue }
      added++
      if (ticket) {
        const now = p.now ?? Date.now()
        const item = getItem(db, r.id)!
        db.prepare(`INSERT INTO osm_verify_tickets (item_id, batch_id, seq, idempotency_key, status, work_item_id, message, created_by, created_label, created_at, updated_at)
          VALUES (?, ?, 1, ?, 'created', ?, '從 Lark 匯入', 'lark-import', '從 Lark 匯入', ?, ?) ON CONFLICT DO NOTHING`)
          .run(item.id, batchId, `import:${key}`, ticket, now, now)
        tickets++
      }
    }
    out.push({ section: s.headerRow, batch: `${year}-${batch}`, added, skipped, tickets })
  }
  return out
}

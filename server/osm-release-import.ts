/**
 * 從 Lark「OSM更新版本」表一次匯入歷史資料（之後工具就是主檔，不再讀這張表）。
 *
 * 表的形狀（2026-10-22 實讀）：
 *   - 第 1 列：測試日期／更新狀態／上線日期／組件（合併）／…／更新內容（合併）／SQL執行（OSM 才有）／更新結果（OM 才有）
 *     OSM 分頁還有第二組「LuckyLink組件」
 *   - 第 2 列：各元件名稱（OM ServerUpdate 沒有元件，第 2 列直接就是資料）
 *   - 日期是 Excel 序號；元件格「x」＝這次沒動、空白＝未提供、其他＝版號
 * 冪等：每列有 source_key（表 token＋分頁＋列號），重跑只補沒匯過的，不會重複。
 */
import type Database from 'better-sqlite3'
import { serialToDate, type ComponentState } from '../shared/osm-release-rules.js'
import { addComponent, addStatus, createRelease, listComponents, listStatuses, upsertTab } from './osm-release-store.js'

type Cell = string | number | null | undefined | Record<string, unknown>

export interface ParsedSheet {
  components: { name: string; group: string; col: number }[]
  showSql: boolean
  showResult: boolean
  records: {
    rowIndex: number; testDate: string; releaseDate: string; statusName: string
    values: { name: string; state: ComponentState; version: string }[]
    content: string; sqlText: string; resultText: string
  }[]
}

function text(c: Cell): string {
  if (c == null) return ''
  if (typeof c === 'number') return String(c)
  if (typeof c === 'string') return c
  // Lark 富文本格：[{text}] 或 {text}
  if (Array.isArray(c)) return (c as { text?: string }[]).map(x => x?.text ?? '').join('')
  return String((c as { text?: unknown }).text ?? '')
}

const norm = (s: string) => s.replace(/\s+/g, '')

export function parseReleaseSheet(rows: Cell[][]): ParsedSheet {
  const head = rows[0] ?? []
  const find = (label: string) => head.findIndex(c => norm(text(c)) === label)
  const colTest = find('測試日期'), colStatus = find('更新狀態'), colRelease = find('上線日期')
  const colContent = find('更新內容'), colSql = find('SQL執行'), colResult = find('更新結果')
  if (colTest < 0 || colStatus < 0 || colRelease < 0 || colContent < 0) {
    throw new Error('表頭不是預期的格式（找不到 測試日期／更新狀態／上線日期／更新內容）')
  }
  // 有沒有第二列表頭：第 2 列第一格是日期序號就代表沒有（OM ServerUpdate）
  const sub = rows[1] ?? []
  const hasSubHeader = !serialToDate(text(sub[colTest])) && sub.slice(0, colContent).some(c => text(c).trim())
  const components: ParsedSheet['components'] = []
  if (hasSubHeader) {
    let group = ''
    for (let col = 0; col < colContent; col++) {
      const top = text(head[col]).trim()
      if (top && col > colRelease) group = top
      const name = text(sub[col]).replace(/\s*\n\s*/g, ' ').trim()
      // 第 1 列的合併標題（組件、LuckyLink組件）決定這一欄屬於哪一組
      if (col > colRelease && name) components.push({ name, group, col })
    }
  }
  const dataStart = hasSubHeader ? 2 : 1
  const records: ParsedSheet['records'] = []
  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i] ?? []
    const testDate = serialToDate(text(r[colTest]))
    const releaseDate = serialToDate(text(r[colRelease]))
    const statusName = text(r[colStatus]).trim()
    const content = text(r[colContent]).trim()
    const values = components.map(c => {
      const raw = text(r[c.col]).trim()
      if (!raw) return { name: c.name, state: 'na' as const, version: '' }
      if (/^x$/i.test(raw)) return { name: c.name, state: 'unchanged' as const, version: '' }
      return { name: c.name, state: 'updated' as const, version: raw }
    })
    const anyVersion = values.some(v => v.state === 'updated')
    if (!testDate && !releaseDate && !content && !anyVersion) continue // 空列
    records.push({
      rowIndex: i, testDate, releaseDate, statusName, values, content,
      sqlText: colSql >= 0 ? text(r[colSql]).trim() : '',
      resultText: colResult >= 0 ? text(r[colResult]).trim() : '',
    })
  }
  return { components, showSql: colSql >= 0, showResult: colResult >= 0, records }
}

export function slugTabId(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `tab-${Date.now()}`
}

/** 把一個分頁匯進來。回傳新增筆數與略過（已匯過）筆數 */
export function applyParsedSheet(db: Database.Database, p: { sheetKey: string; tabTitle: string; parsed: ParsedSheet; actor: string }) {
  const tabId = slugTabId(p.tabTitle)
  upsertTab(db, { id: tabId, name: p.tabTitle, showComponents: p.parsed.components.length > 0, showSql: p.parsed.showSql, showResult: p.parsed.showResult })
  const existing = new Map(listComponents(db).filter(c => c.tabId === tabId).map(c => [c.name, c.id]))
  for (const c of p.parsed.components) if (!existing.has(c.name)) existing.set(c.name, addComponent(db, { tabId, name: c.name, groupName: c.group }))
  const statuses = new Map(listStatuses(db).map(s => [s.name, s.id]))
  let added = 0, skipped = 0
  for (const rec of p.parsed.records) {
    const sourceKey = `${p.sheetKey}:${rec.rowIndex}`
    if (db.prepare('SELECT 1 FROM osm_releases WHERE source_key = ?').get(sourceKey)) { skipped++; continue }
    let statusId: number | null = null
    if (rec.statusName) {
      if (!statuses.has(rec.statusName)) statuses.set(rec.statusName, addStatus(db, { name: rec.statusName }))
      statusId = statuses.get(rec.statusName)!
    }
    createRelease(db, {
      tabId, statusId, testDate: rec.testDate, releaseDate: rec.releaseDate,
      content: rec.content, sqlText: rec.sqlText, resultText: rec.resultText,
      values: rec.values.map(v => ({ componentId: existing.get(v.name)!, state: v.state, version: v.version })),
    }, p.actor, { source: 'lark-import', sourceKey })
    added++
  }
  return { tabId, added, skipped }
}

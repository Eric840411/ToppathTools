/**
 * API 參數紀錄：匯出 Excel（四分頁：時間軸／前台WS／前台HTTP／說明；比對摘要併進說明）。
 * 每一格匯出前再過一次 maskText，單格截在 32000 字（Excel 上限 32767）。
 */
import * as XLSX from 'xlsx'
import { maskText } from './mask.js'
import { pretty, type DiffResult, type TimelineRow } from './core.js'
import type { FrontEvent } from './types.js'

const CELL_MAX = 32000
const cell = (v: unknown) => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return v
  const s = maskText(String(v))
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…(截斷)` : s
}

/** UTC+8 毫秒時間 */
export function fmtTs(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
}

export interface ExcelInput {
  title: string
  infoLines: string[]
  timeline: TimelineRow[]
  front: FrontEvent[]
  offsetMs: number
  /** 前台 HTTP 是否包含 GA／xtrace 等雜訊（預設不含） */
  includeNoise: boolean
  diff: DiffResult | null
  baselineLabel: string
}

const KIND_LABEL = { added: '新增', missing: '缺少', type: '型別變更', value: '值變更' } as const
const STATUS_LABEL = { changed: '有差異', 'new-api': '新 API（基準沒有）', unobserved: '未觀測（這次沒錄到，不算刪除）', same: '相同' } as const

function sheet(rows: unknown[][], widths: number[]) {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(cell)))
  ws['!cols'] = widths.map(wch => ({ wch }))
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  return ws
}

export function buildExcel(input: ExcelInput): Buffer {
  const wb = XLSX.utils.book_new()
  const tl: unknown[][] = [['時間（後台時鐘，UTC+8）', '動作', 'API', '方向', '送出參數', '回傳參數', '來源／備註']]
  for (const r of input.timeline) tl.push([fmtTs(r.t), r.action, r.api, r.direction, pretty(r.req), pretty(r.res), r.source])
  XLSX.utils.book_append_sheet(wb, sheet(tl, [24, 46, 18, 18, 70, 60, 36]), '時間軸')

  const ws: unknown[][] = [['時間（已校正）', '來源', '方向', '內容']]
  for (const e of input.front) {
    if (e.kind === 'ws') ws.push([fmtTs(e.t + input.offsetMs), 'WebSocket 原始幀', e.dir === 'send' ? 'H5 → OSM' : 'OSM → H5', e.text])
    else if (e.kind === 'console' && /^(SEND|ON):/.test(e.text.trim())) ws.push([fmtTs(e.t + input.offsetMs), '遊戲 console（已解碼）', e.text.trim().startsWith('SEND') ? 'H5 → OSM' : 'OSM → H5', e.text])
  }
  XLSX.utils.book_append_sheet(wb, sheet(ws, [24, 20, 12, 120]), '前台WS')

  const http: unknown[][] = [['時間（已校正）', 'Method', 'URL', 'Status', '送出', '回傳', '雜訊']]
  for (const e of input.front) {
    if (e.kind !== 'http' || (e.noise && !input.includeNoise)) continue
    http.push([fmtTs(e.t + input.offsetMs), e.method, e.url, e.status, pretty(e.req), pretty(e.res), e.noise ? '是' : ''])
  }
  XLSX.utils.book_append_sheet(wb, sheet(http, [24, 8, 80, 8, 60, 60, 6]), '前台HTTP')

  const info: unknown[][] = [[input.title], ...input.infoLines.map(l => [l]), [''], ['── 與上次比對 ──'], [`基準：${input.baselineLabel}`]]
  if (input.diff?.hasBaseline) {
    const c = input.diff.counts
    info.push([`新增 ${c.added}、缺少 ${c.missing}、型別變更 ${c.type}、值變更 ${c.value}、新 API ${c.newApi}、未觀測 ${c.unobserved}（已忽略時間戳／流水號的值差異 ${c.volatileIgnored} 處）`])
    info.push([''], ['API', '狀態', '部位', '參數路徑', '差異', '基準', '本次'])
    for (const a of input.diff.apis) {
      if (a.status === 'same') continue
      if (!a.items.length) { info.push([`${a.label}（${a.direction}）`, STATUS_LABEL[a.status]]); continue }
      for (const it of a.items) info.push([`${a.label}（${a.direction}）`, STATUS_LABEL[a.status], it.part, it.path, KIND_LABEL[it.kind], it.before, it.after])
    }
  } else {
    info.push(['無基準：同環境＋同渠道＋同帳號＋同機台沒有更早的成功紀錄'])
  }
  XLSX.utils.book_append_sheet(wb, sheet(info, [60, 22, 10, 40, 10, 40, 40]), '說明')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

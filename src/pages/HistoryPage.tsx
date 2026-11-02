import { useEffect, useState } from 'react'
import { PageActions } from '../redesign/PageActions'


type CsvColumn = { header: string; key: string; aliases?: string[] }

const HISTORY_TESTCASE_COLUMNS: CsvColumn[] = [
  { header: '測試模組', key: '測試模組' },
  { header: '測試維度', key: '測試維度' },
  { header: '測試標題', key: '測試標題' },
  { header: '前置條件', key: '前置條件' },
  { header: '操作步驟', key: '操作步驟' },
  { header: '預期結果', key: '預期結果' },
  { header: '優先級', key: '優先級' },
  { header: '來源', key: '來源' },
  { header: '測項編號', key: '測項編號' },
  { header: '來源依據', key: '來源依據' },
  { header: '版本標記', key: '版本標記' },
  { header: '狀態', key: 'status' },
  { header: '取代測項', key: 'replacedBy' },
]

const HISTORY_JIRA_TESTCASE_COLUMNS: CsvColumn[] = [
  { header: '功能名稱', key: 'feature_name', aliases: ['featureName', '功能名稱'] },
  { header: '測試類型', key: 'test_type', aliases: ['測試類型'] },
  { header: '類型', key: 'category_type', aliases: ['類型', '分類'] },
  { header: '類型判定依據', key: 'category_reason', aliases: ['類型判定依據', '分類依據'] },
  { header: '功能模組', key: 'function_module', aliases: ['功能模組'] },
  { header: '測試標題', key: 'test_title', aliases: ['測試標題'] },
  { header: '預期結果', key: 'expected_result', aliases: ['預期結果'] },
  { header: '來源依據', key: 'source_reference', aliases: ['來源依據'] },
  { header: 'JIRA對應單號', key: 'jira_reference', aliases: ['JIRA對應單號', 'jira'] },
]

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function csvColumnValue(row: Record<string, unknown>, column: CsvColumn): unknown {
  if (row[column.key] !== undefined && row[column.key] !== '') return row[column.key]
  for (const alias of column.aliases ?? []) {
    if (row[alias] !== undefined && row[alias] !== '') return row[alias]
  }
  return ''
}

function buildCsv(columns: CsvColumn[], rows: Array<Record<string, unknown>>): string {
  return `\uFEFF${[
    columns.map(col => csvCell(col.header)).join(','),
    ...rows.map(row => columns.map(col => csvCell(csvColumnValue(row, col))).join(',')),
  ].join('\r\n')}\r\n`
}

function looksLikeJiraTestCase(row: unknown): row is Record<string, unknown> {
  return !!row && typeof row === 'object' && 'test_type' in row && 'category_type' in row && 'test_title' in row
}

function testcaseHistoryToCsv(cases: unknown[], detail: Record<string, unknown>): string {
  const featureName = String(detail.featureName ?? detail.feature_name ?? '')
  if (cases.some(looksLikeJiraTestCase)) {
    const rows = cases.map(row => ({ feature_name: featureName, ...(row as Record<string, unknown>) }))
    return buildCsv(HISTORY_JIRA_TESTCASE_COLUMNS, rows)
  }
  return buildCsv(HISTORY_TESTCASE_COLUMNS, cases as Array<Record<string, unknown>>)
}

function downloadTextFile(content: string, filename: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
interface HistoryRecord {
  id: string
  feature: string
  title: string
  summary: string
  detail: string
  operator_key?: string
  operator_name?: string
  created_at: number
}

type DaysFilter = 1 | 3 | 7
/**
 * 功能 key → 顯示名稱。**篩選按鈕直接用這張表的順序產生**（v5.27.2）：原本篩選清單、型別、名稱、顏色各寫一份，
 * 新功能只加了一兩處，結果 meegle-batch-status／-edit／-backfill 等紀錄顯示成原始代號、也沒有篩選按鈕（使用者 10/06）。
 * 新增功能的 history key 只要加在這裡（顏色沒給會用預設色）；`scripts/ui-checks/history-feature-labels.mjs` 會比對 server 有寫的 key
 */
const FEATURE_LABELS: Record<string, string> = {
  'meegle-batch-create': 'Meegle 開單',
  'meegle-batch-comment': 'Meegle 評論',
  'meegle-batch-status': 'Meegle 狀態',
  'meegle-batch-edit': 'Meegle 修改',
  'meegle-backfill': 'Meegle 補回填',
  'meegle-account': 'Meegle 綁定',
  'testcase': 'TestCase 生成',
  'machine-test': '機台測試',
  'ui-screenshot': 'UI 截圖',
  'scripted-bet': '腳本化投注',
  'jira': 'Meegle 批量工具',
  'jira-comment': 'Jira 批次評論',
  'osm-sync': 'OSM 機台同步',
  'osm-components': 'OSM 元件版本',
  'luckylink-components': 'LuckyLink 元件',
  'luckylink-protocol-versions': 'LuckyLink SAS/MML/G2S',
  'toppath-components': 'Toppath 元件',
  'osm-alert': '版本告警',
  'imagerecon': 'ImageRecon 週報',
  'image-check': '圖片刪除驗證',
  'gs-pdf-testcase': 'GS PDF TestCase',
  'gs-img-compare': 'GS 圖片比對',
  'gs-logchecker': 'GS Log 攔截',
  'gs-bonusv2': 'GS Bonus V2 統計',
  'osm-config-compare': 'Config 比對',
  'autospin': 'AutoSpin',
  'live-ledger': 'Live Ledger 對帳',
  'weekly-report': '週報彙整',
  'lark-notify': 'Lark 通知設定',
  'meter-reconcile': 'Meter 對帳',
  'osm-releases': 'OSM 版本更新紀錄',
  'egm-daycount': 'Egm DayCount 對帳',
}
type FeatureFilter = 'all' | keyof typeof FEATURE_LABELS
const DEFAULT_FEATURE_COLOR = '#64748b'

const FEATURE_COLORS: Record<string, string> = {
  'meegle-batch-create': '#14b8a6',
  'meegle-batch-comment': '#0ea5a4',
  'meegle-batch-status': '#10b981',
  'meegle-batch-edit': '#f59e0b',
  'meegle-backfill': '#38bdf8',
  'meegle-account': '#94a3b8',
  'autospin': '#e11d48',
  'live-ledger': '#a16207',
  'weekly-report': '#4f46e5',
  'lark-notify': '#0284c7',
  'testcase': '#6366f1',
  'machine-test': '#0891b2',
  'ui-screenshot': '#0d9488',
  'scripted-bet': '#2563eb',
  'jira': '#0052cc',
  'jira-comment': '#1d4ed8',
  'osm-sync': '#16a34a',
  'osm-components': '#059669',
  'luckylink-components': '#7c3aed',
  'luckylink-protocol-versions': '#be185d',
  'toppath-components': '#0e7490',
  'osm-alert': '#dc2626',
  'imagerecon': '#b45309',
  'image-check': '#9333ea',
  'gs-pdf-testcase': '#c026d3',
  'gs-img-compare': '#0369a1',
  'gs-logchecker': '#475569',
  'gs-bonusv2': '#b45309',
  'osm-config-compare': '#065f46',
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (m < 1) return '剛剛'
  if (m < 60) return `${m} 分鐘前`
  if (h < 24) return `${h} 小時前`
  return `${d} 天前`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const PAGE_SIZE = 10

export function HistoryPage() {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [days, setDays] = useState<DaysFilter>(7)
  const [feature, setFeature] = useState<FeatureFilter>('all')
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const fetchRecords = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/history?days=${days}&feature=${feature}`)
      const d = await r.json()
      setRecords(d.records ?? [])
      setPage(1)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRecords() }, [days, feature])

  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE))
  const pagedRecords = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const grouped = pagedRecords.reduce<Record<string, HistoryRecord[]>>((acc, rec) => {
    const date = new Date(rec.created_at).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
    ;(acc[date] ??= []).push(rec)
    return acc
  }, {})

  return (
    <div className="lst-hist">
      {/* 新版（原型 v7）：重新整理放頁首右側；時間範圍＋功能篩選同一個面板同一列（功能多，面板內換行）。版面樣式在 redesign/pages/lists.css */}
      <PageActions>
        <button
          type="button"
          className="btn-ghost lst-btn"
          onClick={fetchRecords}
          disabled={loading}
        >
          {loading ? '載入中...' : '重新整理'}
        </button>
      </PageActions>

      <section className="section-card lst-panel lst-hist-panel">
        {/* Filters */}
        <div className="lst-toolbar lst-hist-filters">
          {/* Days */}
          {([1, 3, 7] as DaysFilter[]).map(d => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className="lst-chip"
              aria-pressed={days === d}
            >
              {d === 1 ? '今日' : `${d} 天`}
            </button>
          ))}

          <span className="lst-sep" aria-hidden="true" />

          {/* Feature */}
          {(['all', ...Object.keys(FEATURE_LABELS)] as FeatureFilter[]).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFeature(f)}
              className="lst-chip"
              aria-pressed={feature === f}
            >
              {f === 'all' ? '全部' : FEATURE_LABELS[f]}
            </button>
          ))}
        </div>

        <div className="lst-hist-body">
          {loading && <p className="lst-dim">載入中...</p>}

          {!loading && records.length === 0 && (
            <div className="lst-empty">
              此時間範圍內沒有操作紀錄
            </div>
          )}

          {!loading && records.length > 0 && (
            <div className="lst-mono-sm lst-hist-count">
              共 {records.length} 筆，第 {page} / {totalPages} 頁
            </div>
          )}

          {Object.entries(grouped).map(([date, recs]) => (
            <div key={date} className="lst-hist-day">
              <div className="lst-mono-sm lst-hist-date">
                {date} · {recs.length} 筆
              </div>
              <div className="lst-hist-list">
                {recs.map(rec => {
                  const isExpanded = expandedId === rec.id
                  const featureColor = FEATURE_COLORS[rec.feature] ?? DEFAULT_FEATURE_COLOR
                  let detail: Record<string, unknown> = {}
                  try { detail = JSON.parse(rec.detail) as Record<string, unknown> } catch { detail = { raw: rec.detail } }

                  const cases = Array.isArray(detail.cases) ? detail.cases : null
                  const bitableUrl = typeof detail.bitableUrl === 'string' ? detail.bitableUrl : null

                  const handleDownload = (e: React.MouseEvent) => {
                    e.stopPropagation()
                    const blob = new Blob([JSON.stringify(cases, null, 2)], { type: 'application/json' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `testcase_${new Date(rec.created_at).toISOString().slice(0, 16).replace('T', '_')}.json`
                    a.click()
                    URL.revokeObjectURL(url)
                  }
                  const handleCsvDownload = (e: React.MouseEvent) => {
                    e.stopPropagation()
                    if (!cases) return
                    const stamp = new Date(rec.created_at).toISOString().slice(0, 16).replace('T', '_')
                    downloadTextFile(testcaseHistoryToCsv(cases, detail), `testcase_${stamp}.csv`)
                  }

                  return (
                    <div
                      key={rec.id}
                      className={`lst-hist-row${isExpanded ? ' is-open' : ''}`}
                    >
                      <div
                        onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                        className="lst-hist-head"
                      >
                        <div className="lst-hist-main">
                          <div className="lst-hist-line1">
                            <span className="lst-pill" style={{ '--c': featureColor } as React.CSSProperties}>
                              {FEATURE_LABELS[rec.feature] ?? rec.feature}
                            </span>
                            <span className="lst-hist-title">{rec.title}</span>
                          </div>
                          <div className="lst-hist-summary">{rec.summary}</div>
                          <div className="lst-mono-sm lst-hist-op">
                            操作者：{rec.operator_name || rec.operator_key || '未記錄'}
                          </div>
                        </div>
                        {cases && (
                          <>
                            <button
                              type="button"
                              onClick={handleDownload}
                              title="下載 TestCase JSON"
                              className="lst-sbtn lst-sbtn--ok"
                            >
                              JSON
                            </button>
                            <button
                              type="button"
                              onClick={handleCsvDownload}
                              title="由歷史 JSON 轉出 CSV"
                              className="lst-sbtn lst-sbtn--info"
                            >
                              CSV
                            </button>
                          </>
                        )}
                        <div className="lst-hist-time">
                          <div className="lst-dim">{timeAgo(rec.created_at)}</div>
                          <div className="lst-mono-sm">{formatDate(rec.created_at)}</div>
                        </div>
                        <span className="lst-hist-caret">{isExpanded ? '▲' : '▼'}</span>
                      </div>
                      {isExpanded && (
                        <div className="lst-hist-detail">
                          {bitableUrl && (
                            <div style={{ marginBottom: 10 }}>
                              <a href={bitableUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#818cf8', fontWeight: 600 }}>
                                前往 Lark Bitable
                              </a>
                            </div>
                          )}
                          {rec.feature === 'meegle-batch-create' && Array.isArray(detail.rows)
                            ? <MeegleBatchHistory detail={detail} />
                            : rec.feature === 'meegle-batch-comment' && Array.isArray(detail.rows)
                            ? <MeegleCommentHistory detail={detail} />
                            : (
                              <pre style={{ margin: 0, fontSize: 11, color: '#cbd5e1', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflowY: 'auto' }}>
                                {JSON.stringify(detail, null, 2)}
                              </pre>
                            )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="lst-pager">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-ghost lst-btn lst-btn--sm"
              >
                ← 上一頁
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  className={`btn-ghost lst-btn lst-btn--sm lst-page${p === page ? ' is-on' : ''}`}
                  aria-current={p === page ? 'page' : undefined}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="btn-ghost lst-btn lst-btn--sm"
              >
                下一頁 →
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

/**
 * Meegle 開單的歷史明細（v4.267.0，使用者要求「看得到從哪一列開成哪張單」）：
 * Sheet 連結 → 每列：列號、任務名稱、Meegle 單號（可點）、關聯需求、處理階段、回填 Sheet 結果。
 * 舊紀錄（v4.267.0 之前）只有 row／phase／workItemId，欄位缺的就顯示「—」。
 */
type MeegleHistRow = {
  row?: string; name?: string; phase?: string; workItemId?: string | null; url?: string | null
  requirementId?: string; requirementName?: string; stage?: string; writeback?: string; writebackMsg?: string | null; message?: string | null
}
const MEEGLE_PHASE: Record<string, string> = { created: '已開單', failed: '開單失敗', unknown: '結果待確認', creating: '開單中' }
const MEEGLE_WB: Record<string, string> = { done: '已寫回', pending: '待寫回', failed: '回填失敗', none: '—' }
function MeegleBatchHistory({ detail }: { detail: Record<string, unknown> }) {
  const rows = (detail.rows as MeegleHistRow[]).slice().sort((a, b) => Number(a.row) - Number(b.row))
  const sheetUrl = typeof detail.sheetUrl === 'string' ? detail.sheetUrl : ''
  const cell: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #1e293b', verticalAlign: 'top' }
  return (
    <div style={{ fontSize: 12, color: '#cbd5e1' }}>
      <div style={{ marginBottom: 8 }}>
        來源 Sheet：{sheetUrl ? <a href={sheetUrl} target="_blank" rel="noreferrer" style={{ color: '#2dd4bf', wordBreak: 'break-all' }}>{sheetUrl}</a> : <span style={{ color: '#64748b' }}>（舊紀錄沒有記）</span>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ color: '#94a3b8', textAlign: 'left' }}>
            {['列', '任務名稱', 'Meegle 單號', '關聯需求', '處理階段', '回填 Sheet'].map(h => <th key={h} style={{ ...cell, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={String(r.row)}>
                <td style={{ ...cell, color: '#94a3b8' }}>{r.row ?? '—'}</td>
                <td style={cell}>{r.name || '—'}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                  {r.workItemId ? (r.url ? <a href={r.url} target="_blank" rel="noreferrer" style={{ color: '#2dd4bf' }}>#{r.workItemId}</a> : `#${r.workItemId}`) : <span style={{ color: '#f87171' }}>{MEEGLE_PHASE[r.phase ?? ''] ?? r.phase ?? '—'}</span>}
                </td>
                <td style={cell}>{r.requirementName || (r.requirementId ? `#${r.requirementId}` : '—')}</td>
                <td style={cell}>{r.stage || (r.message ? <span style={{ color: '#f87171' }}>{r.message}</span> : '—')}</td>
                <td style={{ ...cell, color: r.writeback === 'failed' ? '#f87171' : r.writeback === 'done' ? '#94a3b8' : '#fbbf24' }} title={r.writebackMsg ?? ''}>
                  {MEEGLE_WB[r.writeback ?? 'none'] ?? '—'}{r.writebackMsg ? `：${r.writebackMsg}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type MeegleCommentHistRow = { workItemId?: string; summary?: string; sheetRow?: number; asEmail?: string; steps?: Array<{ step: string; phase: string; message?: string | null }> }
const MC_STEP: Record<string, string> = { desc: '測試說明', comment: '評論', review: 'AI 分析', writeback: 'Sheet 回填' }
const MC_PHASE: Record<string, string> = { done: '完成', skipped: '略過', failed: '失敗', unknown: '待確認', creating: '處理中', none: '未執行' }

/** Meegle 批量評論的紀錄：每列的單號、代理身分、各步驟結果（追溯「哪一列寫到哪張單、哪一步沒成功」） */
function MeegleCommentHistory({ detail }: { detail: Record<string, unknown> }) {
  const rows = (detail.rows as MeegleCommentHistRow[]).slice().sort((a, b) => Number(a.sheetRow) - Number(b.sheetRow))
  const sheetUrl = typeof detail.sheetUrl === 'string' ? detail.sheetUrl : ''
  const cell: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #1e293b', verticalAlign: 'top' }
  const color = (p: string) => p === 'done' || p === 'skipped' ? '#94a3b8' : p === 'failed' ? '#f87171' : '#fbbf24'
  return (
    <div style={{ fontSize: 12, color: '#cbd5e1' }}>
      <div style={{ marginBottom: 8 }}>
        來源 Sheet：{sheetUrl ? <a href={sheetUrl} target="_blank" rel="noreferrer" style={{ color: '#2dd4bf', wordBreak: 'break-all' }}>{sheetUrl}</a> : '—'}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ color: '#94a3b8', textAlign: 'left' }}>
            {['列', '摘要', 'Meegle 單號', '以誰的身分', '各步驟'].map(h => <th key={h} style={{ ...cell, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.workItemId}-${r.sheetRow}`}>
                <td style={{ ...cell, color: '#94a3b8' }}>{r.sheetRow ?? '—'}</td>
                <td style={cell}>{r.summary || '—'}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>{r.workItemId ? `#${r.workItemId}` : '—'}</td>
                <td style={cell}>{r.asEmail || '本人'}</td>
                <td style={cell}>
                  {(r.steps ?? []).map(s => (
                    <span key={s.step} title={s.message ?? ''} style={{ marginRight: 8, whiteSpace: 'nowrap', color: color(s.phase) }}>
                      {/* 影片步驟的 key 是 video:<內容 hash>（v4.272.0 起），不是序號——用它在這列影片步驟裡的位置編號（原本 Number(hash) 顯示成 NaN） */}
                      {MC_STEP[s.step] ?? (s.step.startsWith('video:') ? `影片 ${(r.steps ?? []).filter(x => x.step.startsWith('video:')).findIndex(x => x.step === s.step) + 1}` : s.step)}：{MC_PHASE[s.phase] ?? s.phase}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

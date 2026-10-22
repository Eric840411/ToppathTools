/**
 * OSM 版本更新紀錄：前後端共用的規則（只寫一份，避免「畫面擋了、送出卻放行」的漂移）。
 *
 * 每個元件在一筆紀錄裡是三態之一：
 *   - updated   這次有更新（必填版號）
 *   - unchanged 這次沒動（Lark 表上的 x）
 *   - na        未提供（Lark 表上的空白）——跟「沒動」不一樣，不能混成同一種
 */
export type ComponentState = 'updated' | 'unchanged' | 'na'
export const COMPONENT_STATES: ComponentState[] = ['updated', 'unchanged', 'na']

export interface ReleaseInput {
  tabId: string
  statusId: number | null
  testDate: string
  releaseDate: string
  content: string
  sqlText: string
  resultText: string
  values: { componentId: number; state: ComponentState; version: string }[]
}

export interface RuleTab { id: string; showComponents: boolean; active: boolean }
export interface RuleComponent { id: number; tabId: string; name: string; active: boolean }
export interface RuleStatus { id: number; active: boolean }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** 回傳欄位 → 錯誤訊息；空物件＝通過。新增與編輯共用（編輯時停用的元件／狀態若原本就有，可以保留） */
export function validateRelease(
  input: ReleaseInput,
  ctx: { tabs: RuleTab[]; components: RuleComponent[]; statuses: RuleStatus[]; keepIds?: { statusId?: number | null; componentIds?: number[] } },
): Record<string, string> {
  const errors: Record<string, string> = {}
  const tab = ctx.tabs.find(t => t.id === input.tabId)
  if (!tab) errors.tabId = '請選擇分頁'
  else if (!tab.active) errors.tabId = '這個分頁已停用'

  if (input.statusId == null) errors.statusId = '請選擇更新狀態'
  else {
    const st = ctx.statuses.find(s => s.id === input.statusId)
    if (!st) errors.statusId = '狀態不存在'
    else if (!st.active && ctx.keepIds?.statusId !== input.statusId) errors.statusId = '這個狀態已停用'
  }

  if (input.testDate && !isValidDate(input.testDate)) errors.testDate = '日期格式要是 YYYY-MM-DD'
  if (input.releaseDate && !isValidDate(input.releaseDate)) errors.releaseDate = '日期格式要是 YYYY-MM-DD'
  if (!input.testDate && !input.releaseDate) errors.releaseDate = '測試日期和上線日期至少填一個'
  if (input.testDate && input.releaseDate && input.releaseDate < input.testDate) errors.releaseDate = '上線日期不能早於測試日期'

  const seen = new Set<number>()
  for (const v of input.values) {
    const key = `component:${v.componentId}`
    if (seen.has(v.componentId)) { errors[key] = '同一個元件重複'; continue }
    seen.add(v.componentId)
    const comp = ctx.components.find(c => c.id === v.componentId)
    if (!comp || (tab && comp.tabId !== tab.id)) { errors[key] = '元件不屬於這個分頁'; continue }
    if (!comp.active && v.state === 'updated' && !ctx.keepIds?.componentIds?.includes(v.componentId)) { errors[key] = `${comp.name} 已停用`; continue }
    if (!COMPONENT_STATES.includes(v.state)) { errors[key] = '狀態不正確'; continue }
    if (v.state === 'updated' && !v.version.trim()) errors[key] = `${comp.name} 標了「有更新」，請填版號`
    if (v.state !== 'updated' && v.version.trim()) errors[key] = `${comp.name} 沒有標「有更新」，不能填版號`
    if (v.version.length > 200) errors[key] = '版號太長'
  }

  const anyUpdated = input.values.some(v => v.state === 'updated')
  if (tab?.showComponents && !anyUpdated && !input.content.trim()) errors.content = '至少要有一個元件有更新，或填寫更新內容'
  if (!tab?.showComponents && !input.content.trim()) errors.content = '請填寫更新內容'
  if (input.content.length > 20000) errors.content = '更新內容太長'
  return errors
}

/** 從更新內容裡抓單號（P5MA-3060、P5BU-1530…），給搜尋與標示用 */
export function extractTickets(text: string): string[] {
  return [...new Set((text.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g) ?? []))]
}

/** Excel／Lark 的日期序號（1899-12-30 起算）轉 YYYY-MM-DD；不是數字就回空字串 */
export function serialToDate(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return ''
  const ms = Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 編輯舊紀錄時，把「這次沒送到」的東西補回原值，再驗證、再寫入（CodeX 1022 審 b160ed5 兩個 [P1]）：
 *   - 分頁設定關掉 SQL／更新結果欄 → 畫面不顯示 → 送來是空的，不能因此清掉舊值
 *   - 送來的 values 沒包含的元件（分頁關掉元件欄、或畫面拿的是舊設定、不認得別人剛加的元件）→ 保留原值
 * 要清掉一個元件的值，畫面要明確送「未提供」；沒送＝沒動。
 */
export function mergeUnsentFields(
  cur: { sqlText: string; resultText: string; values: ReleaseInput['values'] },
  input: ReleaseInput,
  tab: { showSql: boolean; showResult: boolean } | undefined,
): ReleaseInput {
  const sent = new Set(input.values.map(v => v.componentId))
  return {
    ...input,
    sqlText: tab?.showSql ? input.sqlText : cur.sqlText,
    resultText: tab?.showResult ? input.resultText : cur.resultText,
    values: [...input.values, ...cur.values.filter(v => !sent.has(v.componentId))],
  }
}

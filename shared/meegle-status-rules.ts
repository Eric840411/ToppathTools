/**
 * Meegle 批量更新狀態前後端共用的規則（同一份，不在兩邊各寫——CLAUDE.md 跨功能踩坑 #3）。
 * 行為跟 CodeX 對過（2026-10-02）：
 *  - 目標狀態優先序固定：預覽手改 ＞ Sheet「目標狀態」欄 ＞ 整批預設；找不到、同名多個都擋列，不猜
 *  - 日期三選一：keep 保留原值（預設）／auto 用自動帶入／set 指定日期（Sheet 欄，空白退回 keep）
 */

/** 成功後回填的處理階段：跟 Jira 批量更新狀態同一個字，Sheet 不用改 */
export const STATUS_STAGE_DONE = '已切換狀態'

/** Sheet 上逐列覆寫目標狀態的欄位 */
export const TARGET_STATE_COLUMN = '目標狀態'

export type DateMode = 'keep' | 'auto' | 'set'
export const DATE_MODES: Array<{ key: DateMode; label: string }> = [
  { key: 'keep', label: '保留原值' },
  { key: 'auto', label: '用自動帶入' },
  { key: 'set', label: '指定日期' },
]

/**
 * 轉到這些狀態時，Meegle 自動化會把對應的日期欄改成「今天」（2026-10-02 在 #15190441 實測：
 * 轉換回 success 後 1～5 秒才改、會蓋掉手填值；「本機測試完成」沒有自動化）。key 是 state_key，不比名稱。
 */
export const AUTO_DATE_FIELDS: Record<string, { field: string; label: string }> = {
  rMaPpRVhj: { field: 'field_cbc597', label: '上C服時間' },   // C服
  Finished: { field: 'field_ce2cfc', label: '上線時間' },     // 完成
}

export type StateOption = { key: string; name: string }
export type TargetSource = 'preview' | 'sheet' | 'default'
export type TargetResolution =
  | { ok: true; key: string; name: string; source: TargetSource }
  | { ok: false; reason: string }

/** 依優先序決定這一列的目標狀態。Sheet 欄比對狀態**名稱**（去頭尾空白、全等），預覽／預設給的是 key。 */
export function resolveTargetState(
  input: { previewKey?: string | null; sheetValue?: string | null; defaultKey?: string | null },
  states: StateOption[],
): TargetResolution {
  const byKey = (key: string, source: TargetSource): TargetResolution => {
    const s = states.find(x => x.key === key)
    return s ? { ok: true, key: s.key, name: s.name, source } : { ok: false, reason: `目標狀態「${key}」不在目前的狀態清單裡` }
  }
  if (input.previewKey) return byKey(input.previewKey, 'preview')
  const name = String(input.sheetValue ?? '').trim()
  if (name) {
    const hits = states.filter(s => s.name.trim() === name)
    if (hits.length === 0) return { ok: false, reason: `Sheet 的目標狀態「${name}」對不到 Meegle 狀態` }
    if (hits.length > 1) return { ok: false, reason: `Sheet 的目標狀態「${name}」對到 ${hits.length} 個同名狀態，不自動選` }
    return { ok: true, key: hits[0].key, name: hits[0].name, source: 'sheet' }
  }
  if (input.defaultKey) return byKey(input.defaultKey, 'default')
  return { ok: false, reason: '沒有目標狀態（沒選整批預設、Sheet 也沒填）' }
}

const TZ_OFFSET_MS = 8 * 3600_000   // Meegle 日期欄存「台北當天 00:00」（實測自動化寫入 2026-10-01T16:00:00Z）

/** 台北日期字串 YYYY-MM-DD。比對日期一律比這個，不比毫秒（MQL 的 string_value 是 UTC，會差一天）。 */
export function taipeiDay(ms: number): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10)
}

/** 台北某天 00:00 的毫秒值（寫進 Meegle 用這個，跟自動化寫的同一種值） */
export function taipeiDayStart(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) - TZ_OFFSET_MS
}

export type ParsedDate = { ok: true; ms: number; day: string } | { ok: false; reason: string } | { ok: true; ms: null; day: null }

/**
 * Sheet 日期欄 → 台北當天 00:00。空白＝沒指定（呼叫端退回保留原值）。
 * 只收「年-月-日」（分隔 - / .，可帶時間，時間忽略——Meegle 這兩欄是日期）；
 * 沒有年份（9/15）、日期不存在（2/30）、其他格式都回錯誤擋列，不猜。
 */
export function parseSheetDate(text: string | null | undefined): ParsedDate {
  const s = String(text ?? '').trim()
  if (!s) return { ok: true, ms: null, day: null }
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s)
  if (!m) return { ok: false, reason: `日期「${s}」看不懂（請用 2026/09/15 這種有年份的格式）` }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = taipeiDayStart(y, mo, d)
  const day = taipeiDay(ms)
  if (day !== `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`) return { ok: false, reason: `日期「${s}」不存在` }
  return { ok: true, ms, day }
}

/**
 * 這一列日期最後應該是什麼（null＝不動，交給自動化）。
 * keep：原本有值就保留原值；原本空的就用自動帶入。set：Sheet 有填就用它，空白退回 keep。auto：不動。
 */
export function desiredDate(mode: DateMode, originalMs: number | null, sheetMs: number | null): number | null {
  if (mode === 'auto') return null
  if (mode === 'set' && sheetMs != null) return sheetMs
  return originalMs
}

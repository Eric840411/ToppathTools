/**
 * shared/lark-schedule-rules.ts — 排程提醒的純規則。
 *
 * 刻意跟 `server/lib/lark-schedule.ts` 分開：那邊會 `import { db }`，一載入就開 SQLite，
 * 純邏輯混在裡面就沒辦法單獨測。這裡不碰 DB、不打網路、不讀設定，所有外部條件都用參數傳進來。
 *
 * 守的是四條會靜默出錯的線：欄位轉型、時區換算、該不該推播、週期展開的冪等。
 */

export type BitableRecord = { record_id: string; fields: Record<string, unknown> }
export type LarkPerson = { id?: string; name?: string }

// ─── 欄位讀取 ────────────────────────────────────────────────────────────────

/**
 * ⚠️ 欄位型別是數字（type 2）不代表 API 會回數字——帶 formatter 的數字欄位
 * 實測回的是字串（"5"）。不強制轉型的話「提前提醒分鐘」會靜悄悄變成 0，
 * 提前提醒整個失效而且不報錯（2026-09-23 原型實測時第一次推播完全沒動作就是這個）。
 */
export function fNum(rec: BitableRecord, name: string): number | null {
  const v = rec.fields[name]
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim())
    return v.trim() !== '' && Number.isFinite(n) ? n : null
  }
  return null
}

/** 日期欄位回 epoch ms；字串一併容錯，理由同 fNum */
export function fDate(rec: BitableRecord, name: string): number | null {
  const v = rec.fields[name]
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 文字欄位可能回字串，也可能回 [{type:'text',text:'...'}] */
export function fText(rec: BitableRecord, name: string): string {
  const v = rec.fields[name]
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : (x as { text?: string })?.text ?? '')).join('')
  if (typeof v === 'object' && (v as { text?: string }).text) return (v as { text: string }).text
  return String(v)
}

export function fPeople(rec: BitableRecord, name: string): LarkPerson[] {
  const v = rec.fields[name]
  return Array.isArray(v) ? (v as LarkPerson[]).filter(Boolean) : []
}

// ─── 時區 ────────────────────────────────────────────────────────────────────

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 取得某個 epoch ms 在指定時區底下的年/月/日/星期（0=日） */
export function partsInTz(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms))
  const g = (t: string) => f.find(p => p.type === t)!.value
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { y: +g('year'), m: +g('month'), d: +g('day'), wd: wdMap[g('weekday')] }
}

/**
 * 把「指定時區的某年月日 HH:mm」轉成 epoch ms。
 * 先用 UTC 當起點推估，再拿該時刻實際的時區偏移修正一次——不依賴任何時區套件，
 * 半小時／十五分偏移與 DST 邊界都在測試裡驗過。
 */
export function tzDateToMs(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const asTz = new Date(new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(guess)).replace(' ', 'T') + 'Z')
  return guess - (asTz.getTime() - guess)
}

export function parseHHMM(s: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const hh = +m[1], mm = +m[2]
  return hh > 23 || mm > 59 ? null : { hh, mm }
}

// ─── 該不該推播 ──────────────────────────────────────────────────────────────

export type ScheduleKind = 'due' | 'stale' | null

export const TERMINAL_STATUS = new Set(['已完成', '已取消', '已逾期'])

/**
 * due   —— 到提醒時間了，推
 * stale —— 開始時間已經過去超過 staleMs，不推只標記逾期
 *          （防服務停機幾天後重啟，把一整批過期行程一次全噴進群裡洗版）
 * null  —— 不動
 */
export function classifySchedule(rec: BitableRecord, now: number, staleMs: number): ScheduleKind {
  if (TERMINAL_STATUS.has(fText(rec, '狀態'))) return null
  if (fDate(rec, '推播時間') != null) return null
  const start = fDate(rec, '開始時間')
  if (start == null) return null
  const lead = (fNum(rec, '提前提醒分鐘') ?? 0) * 60_000
  if (now < start - lead) return null
  return now > start + staleMs ? 'stale' : 'due'
}

/** 粗篩「表格裡被改成已完成／已取消、但群裡還沒回報過」的記錄 */
export function needsAnnounce(rec: BitableRecord): boolean {
  const status = fText(rec, '狀態')
  if (status !== '已完成' && status !== '已取消') return false
  return fDate(rec, '完成通知時間') == null && fDate(rec, '推播時間') != null
}

// ─── 週期展開 ────────────────────────────────────────────────────────────────

export type RuleSpec = {
  ruleId: string
  type: string            // 每天 / 每週 / 每月
  time: string            // HH:mm
  weekdays?: string[]     // 每週用
  dayOfMonth?: number | null  // 每月用
}

export type OccurrenceResult = { list: number[]; err: string | null }

/**
 * 產生某條規則在 [fromMs, toMs] 區間內的所有排定時刻。
 * 純計算，不碰表格——呼叫端自己負責用冪等 key 去重。
 */
export function occurrencesFor(rule: RuleSpec, fromMs: number, toMs: number, tz: string, days: number): OccurrenceResult {
  const time = parseHHMM(rule.time)
  if (!rule.type) return { list: [], err: '沒有設定週期類型' }
  if (!time) return { list: [], err: `開始時刻格式不對（要 HH:mm，讀到「${rule.time}」）` }

  const wdSel = new Set((rule.weekdays ?? []).map(String))
  if (rule.type === '每週' && wdSel.size === 0) return { list: [], err: '週期類型是每週，但沒有勾任何「週幾」' }
  if (rule.type === '每月' && !rule.dayOfMonth) return { list: [], err: '週期類型是每月，但沒有填「每月幾號」' }

  const list: number[] = []
  for (let i = 0; i <= days; i++) {
    const probe = fromMs + i * 86_400_000
    const { y, m, d, wd } = partsInTz(probe, tz)
    const hit = rule.type === '每天' ? true
      : rule.type === '每週' ? wdSel.has(WEEKDAYS[wd])
      : rule.type === '每月' ? d === rule.dayOfMonth
      : false
    if (!hit) continue
    const ms = tzDateToMs(y, m, d, time.hh, time.mm, tz)
    if (ms >= fromMs && ms <= toMs) list.push(ms)
  }
  return { list, err: null }
}

/**
 * 冪等 key = 規則ID@原始排定時刻(UTC ISO)。
 *
 * ⚠️ 三條保護，少一條就出事：
 *  · 用「**原始排定時刻**」而非實際開始時間 → 使用者在日曆上拖曳改期後 key 不變，
 *    下次展開不會把它當缺漏再補一筆（＝重複）
 *  · 帶**完整時刻**而非只有日期 → 同一天跑多場的規則不會互撞
 *  · 呼叫端只要看到 key 已存在就跳過，**不管那筆現在是什麼狀態**
 *    → 人工修改／取消／已完成的記錄永遠不會被重建覆蓋
 */
export const idempotencyKey = (ruleId: string, scheduledMs: number): string =>
  `${ruleId}@${new Date(scheduledMs).toISOString()}`

/** 一筆行程的認領 key。週期展開出來的用冪等Key，一次性的用 record_id。 */
export const occurrenceKeyOf = (rec: BitableRecord): string => fText(rec, '冪等Key') || rec.record_id

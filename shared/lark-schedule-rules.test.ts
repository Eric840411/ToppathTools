/**
 * shared/lark-schedule-rules 的單元測試。純函式，不開 DB 也不打網路。
 *
 * 跑法：npx tsx shared/lark-schedule-rules.test.ts
 *
 * 這裡守的是四條**會靜默出錯**的線——都是不報錯、功能看起來正常、但行為是錯的：
 *   ① 數字欄位回字串 → 提前提醒分鐘變 0 → 提醒永遠晚 N 分鐘到（原型階段實際踩過）
 *   ② 時區換算 → 排定時刻整個偏掉
 *   ③ 該不該推播 → 漏推、重推、或停機後一次噴一整批
 *   ④ 週期展開冪等 → 拖曳改期後長出重複的一筆
 */
import {
  fNum, fDate, fText, fPeople,
  tzDateToMs, partsInTz, parseHHMM,
  classifySchedule, needsAnnounce,
  occurrencesFor, idempotencyKey, occurrenceKeyOf,
  type BitableRecord,
} from './lark-schedule-rules.js'

let pass = 0
const fails: string[] = []

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; return }
  fails.push(`${name}\n    want ${w}\n    got  ${g}`)
}

const rec = (fields: Record<string, unknown>, id = 'rec1'): BitableRecord => ({ record_id: id, fields })

// ─── ① 欄位轉型 ─────────────────────────────────────────────────────────────
// Lark 的數字欄位帶 formatter 時回的是字串。不轉型 → fNum 回 null → 呼叫端 ?? 0
// → 「提前提醒 5 分鐘」變成「開始當下才提醒」，而且完全不報錯。

eq('fNum 數字', fNum(rec({ x: 5 }), 'x'), 5)
eq('fNum 字串（Lark 實際回這個）', fNum(rec({ x: '5' }), 'x'), 5)
eq('fNum 千分位字串', fNum(rec({ x: '1,200' }), 'x'), 1200)
eq('fNum 零不可以變成 null', fNum(rec({ x: 0 }), 'x'), 0)
eq('fNum 字串零', fNum(rec({ x: '0' }), 'x'), 0)
eq('fNum 空字串', fNum(rec({ x: '' }), 'x'), null)
eq('fNum 空白字串', fNum(rec({ x: '   ' }), 'x'), null)
eq('fNum 非數字', fNum(rec({ x: 'abc' }), 'x'), null)
eq('fNum 缺欄位', fNum(rec({}), 'x'), null)
eq('fNum NaN', fNum(rec({ x: NaN }), 'x'), null)

eq('fDate 數字', fDate(rec({ d: 1790131273921 }), 'd'), 1790131273921)
eq('fDate 字串', fDate(rec({ d: '1790131273921' }), 'd'), 1790131273921)
eq('fDate 缺欄位', fDate(rec({}), 'd'), null)

eq('fText 字串', fText(rec({ t: 'abc' }), 't'), 'abc')
eq('fText 陣列型', fText(rec({ t: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'c' }] }), 't'), 'abc')
eq('fText 缺欄位回空字串', fText(rec({}), 't'), '')
eq('fPeople 非陣列回空', fPeople(rec({ p: 'x' }), 'p'), [])
eq('fPeople 取值', fPeople(rec({ p: [{ id: 'ou_1', name: 'A' }] }), 'p'), [{ id: 'ou_1', name: 'A' }])

// ─── ② 時區 ─────────────────────────────────────────────────────────────────
// round-trip：指定時區的某時刻 → epoch → 轉回同一時區，必須回到原值。

function roundTrip(tz: string, y: number, m: number, d: number, hh: number, mm: number): string {
  const ms = tzDateToMs(y, m, d, hh, mm, tz)
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms)).replace(' ', 'T')
}

eq('tz 台北', roundTrip('Asia/Taipei', 2026, 9, 25, 10, 0), '2026-09-25T10:00')
eq('tz 新加坡', roundTrip('Asia/Singapore', 2026, 9, 25, 10, 0), '2026-09-25T10:00')
eq('tz +05:30 半小時偏移', roundTrip('Asia/Kolkata', 2026, 9, 25, 10, 0), '2026-09-25T10:00')
eq('tz +05:45 十五分偏移', roundTrip('Asia/Kathmandu', 2026, 9, 25, 10, 0), '2026-09-25T10:00')
eq('tz DST 開始當天', roundTrip('America/New_York', 2026, 3, 8, 14, 0), '2026-03-08T14:00')
eq('tz DST 結束當天', roundTrip('America/New_York', 2026, 11, 1, 14, 0), '2026-11-01T14:00')
eq('tz 英國 BST 切換日', roundTrip('Europe/London', 2026, 3, 29, 12, 0), '2026-03-29T12:00')
eq('tz 南半球 DST', roundTrip('Australia/Sydney', 2026, 10, 4, 12, 0), '2026-10-04T12:00')
eq('tz 跨年', roundTrip('Asia/Taipei', 2026, 12, 31, 23, 59), '2026-12-31T23:59')
eq('tz 午夜', roundTrip('Asia/Taipei', 2026, 9, 23, 0, 0), '2026-09-23T00:00')

// 2026-09-23 是星期三
eq('partsInTz 星期', partsInTz(tzDateToMs(2026, 9, 23, 12, 0, 'Asia/Taipei'), 'Asia/Taipei').wd, 3)

eq('parseHHMM 正常', parseHHMM('10:00'), { hh: 10, mm: 0 })
eq('parseHHMM 個位數小時', parseHHMM('9:05'), { hh: 9, mm: 5 })
eq('parseHHMM 全形冒號', parseHHMM('10：30'), { hh: 10, mm: 30 })
eq('parseHHMM 前後空白', parseHHMM('  10:30  '), { hh: 10, mm: 30 })
eq('parseHHMM 小時超界', parseHHMM('24:00'), null)
eq('parseHHMM 分鐘超界', parseHHMM('10:60'), null)
eq('parseHHMM 格式錯', parseHHMM('1000'), null)
eq('parseHHMM 空字串', parseHHMM(''), null)

// ─── ③ 該不該推播 ───────────────────────────────────────────────────────────

const T0 = tzDateToMs(2026, 9, 23, 10, 0, 'Asia/Taipei')   // 行程開始時間
const STALE = 6 * 3_600_000
const base = { 行程名稱: 'X', 開始時間: T0, 狀態: '待辦' }

eq('還沒到提醒時間 → 不動',
  classifySchedule(rec({ ...base, 提前提醒分鐘: 10 }), T0 - 11 * 60_000, STALE), null)
eq('到提醒時間 → due',
  classifySchedule(rec({ ...base, 提前提醒分鐘: 10 }), T0 - 9 * 60_000, STALE), 'due')
// ⚠️ 這條就是 ① 的下游：提前提醒分鐘是字串時，若 fNum 沒轉型就會變 0，這裡會回 null 而不是 due
eq('提前提醒分鐘是字串也要算數（①的下游）',
  classifySchedule(rec({ ...base, 提前提醒分鐘: '10' }), T0 - 9 * 60_000, STALE), 'due')
eq('沒填提前提醒 → 開始時間才推',
  classifySchedule(rec({ ...base }), T0 - 60_000, STALE), null)
eq('沒填提前提醒 → 到點推',
  classifySchedule(rec({ ...base }), T0, STALE), 'due')
eq('推過了 → 不重推',
  classifySchedule(rec({ ...base, 推播時間: T0 }), T0, STALE), null)
eq('已完成 → 不推', classifySchedule(rec({ ...base, 狀態: '已完成' }), T0, STALE), null)
eq('已取消 → 不推', classifySchedule(rec({ ...base, 狀態: '已取消' }), T0, STALE), null)
eq('已逾期 → 不推', classifySchedule(rec({ ...base, 狀態: '已逾期' }), T0, STALE), null)
eq('沒有開始時間 → 不推', classifySchedule(rec({ 行程名稱: 'X', 狀態: '待辦' }), T0, STALE), null)
eq('過期在門檻內 → 仍然 due',
  classifySchedule(rec({ ...base }), T0 + STALE - 60_000, STALE), 'due')
eq('過期超過門檻 → stale（停機重啟不洗版）',
  classifySchedule(rec({ ...base }), T0 + STALE + 60_000, STALE), 'stale')

eq('needsAnnounce 已完成且推過且沒宣告過 → true',
  needsAnnounce(rec({ 狀態: '已完成', 推播時間: T0 })), true)
eq('needsAnnounce 已宣告過 → false',
  needsAnnounce(rec({ 狀態: '已完成', 推播時間: T0, 完成通知時間: T0 })), false)
eq('needsAnnounce 沒推播過 → false（不宣告沒發過卡片的）',
  needsAnnounce(rec({ 狀態: '已完成' })), false)
eq('needsAnnounce 待辦 → false', needsAnnounce(rec({ 狀態: '待辦', 推播時間: T0 })), false)
eq('needsAnnounce 已逾期 → false（逾期不是人回報的）',
  needsAnnounce(rec({ 狀態: '已逾期', 推播時間: T0 })), false)

// ─── ④ 週期展開 ─────────────────────────────────────────────────────────────

const TZ = 'Asia/Taipei'
const from = tzDateToMs(2026, 9, 23, 9, 0, TZ)    // 星期三 09:00 出發
const to = from + 14 * 86_400_000

/** 用 partsInTz 組字串，不靠 Intl 的地區格式（不同平台輸出不一樣） */
const md = (ms: number) => {
  const p = partsInTz(ms, TZ)
  return `${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

const daily = occurrencesFor({ ruleId: 'r1', type: '每天', time: '10:00' }, from, to, TZ, 14)
eq('每天：14 天窗內 14 筆（當天 10:00 還沒過所以算得到）', daily.list.length, 14)
eq('每天：第一筆是當天', md(daily.list[0]), '09-23')
eq('每天：最後一筆不超出窗', daily.list[daily.list.length - 1] <= to, true)

// 09-23 是週三，窗口到 10-07 09:00。窗內的週二/週四只有這四天——
// 10-08(四) 15:30 已經超出窗口，會被排除。這條先前我算成 5 筆，是測試寫錯不是程式錯。
const weekly = occurrencesFor({ ruleId: 'r2', type: '每週', time: '15:30', weekdays: ['二', '四'] }, from, to, TZ, 14)
eq('每週二四：實際日期', weekly.list.map(md), ['09-24', '09-29', '10-01', '10-06'])
eq('每週二四：全部落在週二或週四',
  weekly.list.every(ms => [2, 4].includes(partsInTz(ms, TZ).wd)), true)
eq('每週二四：全部在窗內', weekly.list.every(ms => ms >= from && ms <= to), true)

const monthly = occurrencesFor({ ruleId: 'r3', type: '每月', time: '09:00', dayOfMonth: 1 }, from, to, TZ, 14)
eq('每月 1 號：窗內只有 10/01 一筆', monthly.list.length, 1)
eq('每月 1 號：日期正確', partsInTz(monthly.list[0], TZ).d, 1)

eq('每週沒勾週幾 → 報錯不靜默產生 0 筆',
  occurrencesFor({ ruleId: 'r4', type: '每週', time: '10:00' }, from, to, TZ, 14).err !== null, true)
eq('每月沒填幾號 → 報錯',
  occurrencesFor({ ruleId: 'r5', type: '每月', time: '10:00' }, from, to, TZ, 14).err !== null, true)
eq('時刻格式錯 → 報錯',
  occurrencesFor({ ruleId: 'r6', type: '每天', time: '1000' }, from, to, TZ, 14).err !== null, true)
eq('沒有週期類型 → 報錯',
  occurrencesFor({ ruleId: 'r7', type: '', time: '10:00' }, from, to, TZ, 14).err !== null, true)
eq('區間外不產生', occurrencesFor({ ruleId: 'r8', type: '每天', time: '10:00' }, from, from, TZ, 14).list.length, 0)

// 冪等：同樣輸入 → 同樣 key。這是「拖曳改期不會長出重複」的根據——
// key 綁的是**原始排定時刻**，使用者在日曆上把開始時間拖走並不會改變它。
const k1 = idempotencyKey('r1', daily.list[0])
const k2 = idempotencyKey('r1', daily.list[0])
eq('冪等 key 穩定', k1 === k2, true)
eq('冪等 key 帶完整時刻（同日多場不互撞）',
  idempotencyKey('r1', daily.list[0]) !== idempotencyKey('r1', daily.list[0] + 3_600_000), true)
eq('冪等 key 含規則 ID（不同規則同時刻不互撞）',
  idempotencyKey('rA', daily.list[0]) !== idempotencyKey('rB', daily.list[0]), true)

eq('occurrenceKeyOf 有冪等Key時用它',
  occurrenceKeyOf(rec({ 冪等Key: 'r1@2026-09-23T02:00:00.000Z' }, 'recX')), 'r1@2026-09-23T02:00:00.000Z')
eq('occurrenceKeyOf 一次性行程退回 record_id',
  occurrenceKeyOf(rec({}, 'recX')), 'recX')

// ─── 結果 ───────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`)
  process.exit(1)
}

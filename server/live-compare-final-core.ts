/**
 * AutoSpin 停止後的「後台對照總表」——結算判定與 Lark 卡片（純函式，不碰 DB／網路）。
 *
 * 同事 1106 需求：一按停止即時對照頁就空白，要①停止後還看得到②每次停止發一份總表到「OSM的秘密」群。
 * CodeX 1106 審過設計，重點：
 *   - 「t1 ≥ 停止時間」不夠：停止按鈕不等於最後一局完成，要等停止確認＋尾筆觀測收妥（一段時間沒有新局），
 *     終點定在最後一局之後再留一點時鐘餘裕；無法確認涵蓋就標未收斂，不能當一致
 *   - 結算中頁面也要顯示最近結果；結算上限 15 分鐘，逾時照現況發、標未收斂
 *   - 總計要含最後一個對上的窗口、只算一次；列出已查範圍、未查尾段、讀取錯誤
 *   - 報表叫「後台對照」，是 Meter 對後台（這台全部玩家），不能宣稱 AutoSpin 每一局都入帳；終點附近可能含其他玩家
 * 測試：npx tsx server/live-compare-final-core.test.ts
 */
import type { LiveCompareRow } from './live-compare.js'

/** 停止後最多結算多久，逾時照現況發、標未收斂 */
export const SETTLE_MAX_MS = 15 * 60_000
/** 最後一筆 spin 之後要安靜多久才算尾筆收妥（Python 收到停止後還會寫最後幾筆） */
export const TAIL_QUIET_MS = 30_000
/** 終點要比最後一局晚多少——Meter 的 upTime 跟伺服器不是同一個時鐘 */
export const TAIL_MARGIN_MS = 30_000

export type RunState = 'running' | 'settling' | 'final' | 'timeout'

/** 一台機台結算到哪了 */
export type MachineSettle = 'done' | 'overdue' | 'wait'

/**
 * done＝涵蓋到終點的窗口對上了；overdue＝同一窗口連兩次對不上（照逾期待查定案）；其他都要再等。
 * ⚠️ 只有 t1 ≥ 終點而且 match 才算 done——t1 還在終點之前的「一致」只代表前面那段沒問題。
 */
export function machineSettle(row: Pick<LiveCompareRow, 'win'>, targetUp: number): MachineSettle {
  const w = row.win
  if (!w) return 'wait'
  if (w.status === 'overdue') return 'overdue'
  if (w.status === 'match' && w.t1 != null && w.t1 >= targetUp) return 'done'
  return 'wait'
}

export interface SettleInput {
  /** session 已經不是 running（停止確認） */
  stopped: boolean
  /** 第一次發現停止的時間（結算上限從這裡算） */
  stoppedAt: number | null
  /** 這一輪最後一筆 spin 的時間（agent 時鐘，拿來定終點）；沒有任何 spin 是 null */
  lastSpinAt: number | null
  /** 伺服器最後一次看到 spin 筆數增加的時間（伺服器時鐘，拿來判斷尾筆收妥——不能拿 agent 時鐘跟伺服器的 now 比） */
  lastGrowthAt: number | null
  now: number
  rows: Array<Pick<LiveCompareRow, 'win'>>
}

export interface SettleDecision { state: RunState; targetUp: number | null; reason: string }

export function decideSettle(x: SettleInput): SettleDecision {
  if (!x.stopped || x.stoppedAt == null) return { state: 'running', targetUp: null, reason: '' }
  const overdueAt = x.stoppedAt + SETTLE_MAX_MS
  if (x.lastSpinAt == null) return { state: 'final', targetUp: null, reason: '這一輪沒有任何 spin 紀錄' }
  const targetUp = x.lastSpinAt + TAIL_MARGIN_MS
  if (x.now - (x.lastGrowthAt ?? x.stoppedAt) < TAIL_QUIET_MS) {
    return x.now > overdueAt
      ? { state: 'timeout', targetUp, reason: `停止後 ${SETTLE_MAX_MS / 60_000} 分鐘仍有新局寫入，沒辦法確定終點` }
      : { state: 'settling', targetUp, reason: '等最後幾局寫完' }
  }
  if (!x.rows.length) return { state: 'final', targetUp, reason: '沒有可比對的機台' }
  const st = x.rows.map(r => machineSettle(r, targetUp))
  if (st.every(s => s !== 'wait')) return { state: 'final', targetUp, reason: '' }
  if (x.now > overdueAt) {
    return { state: 'timeout', targetUp, reason: `停止後 ${SETTLE_MAX_MS / 60_000} 分鐘仍有 ${st.filter(s => s === 'wait').length} 台沒對到終點` }
  }
  return { state: 'settling', targetUp, reason: '等 Game Record 入帳（約 3 分鐘）' }
}

/** 一台的總計。已對上的段累計（okCount）＋目前這段若是一致也算進來——只算一次 */
export interface MachineSummary {
  name: string
  gmid: string
  autospin: number
  matchedCount: number
  matchedAmount: number
  /** 已比對範圍（Meter 時間）：起點 → 最後一個對上的切點 */
  checkedFrom: number | null
  checkedTo: number | null
  /** 已收到 Meter 快照、但還沒對上的尾段結束點（> checkedTo 才有） */
  uncheckedTo: number | null
  settle: MachineSettle
  /** 對不上時的差額（Meter − 後台） */
  diff: { count: number; amount: number } | null
  error: string
}

export function summarizeMachine(r: LiveCompareRow, targetUp: number | null): MachineSummary {
  const w = r.win
  const curMatch = w && w.status === 'match' && w.meter && w.t1 != null
  const matchedCount = (w?.okCount ?? 0) + (curMatch ? w!.meter!.count : 0)
  const matchedAmount = Math.round(((w?.okAmount ?? 0) + (curMatch ? w!.meter!.amount : 0)) * 100) / 100
  const checkedTo = w ? (curMatch ? w.t1 : (w.okCount > 0 || w.tStart !== r.t0 ? w.tStart : null)) : null
  const latest = w ? Math.max(w.latestUp ?? 0, w.t1 ?? 0) : 0
  const err = [r.meterError, r.grError && !r.win ? r.grError : '', r.reason && r.status === 'unreadable' ? r.reason : ''].filter(Boolean)
  return {
    name: r.clientMachineName || r.gmid,
    gmid: r.gmid,
    autospin: r.as?.count ?? 0,
    matchedCount,
    matchedAmount,
    checkedFrom: r.t0,
    checkedTo,
    uncheckedTo: latest && (checkedTo == null || latest > checkedTo) ? latest : null,
    settle: targetUp == null ? 'wait' : machineSettle(r, targetUp),
    diff: w && (w.status === 'overdue' || w.status === 'pending') && w.diff ? w.diff : null,
    error: [...new Set(err)].join('；'),
  }
}

const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
const tpe = (ms: number) => new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const hm = (ms: number) => new Date(ms).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' })
/** 外來文字的 < > 換全形，避免被當成 <at>／<font> */
const esc = (s: string) => s.replace(/</g, '＜').replace(/>/g, '＞')
const md = (content: string) => ({ tag: 'markdown', content })
const note = (text: string) => ({ tag: 'note', elements: [{ tag: 'plain_text', content: text }] })
const hr = { tag: 'hr' }

export interface FinalReportInput {
  userLabel: string
  startedAt: number
  stoppedAt: number
  state: 'final' | 'timeout'
  reason: string
  machines: MachineSummary[]
  isTest?: boolean
}

/** 機台一行的結論 */
function verdict(m: MachineSummary, state: 'final' | 'timeout'): string {
  if (m.settle === 'done') return "<font color='green'>✓ 一致</font>"
  if (m.settle === 'overdue') return "<font color='red'>✗ 逾期待查</font>"
  return state === 'timeout' ? "<font color='orange'>未收斂</font>" : "<font color='grey'>未定</font>"
}

export function buildFinalReportCard(x: FinalReportInput): object {
  const mins = Math.max(0, Math.round((x.stoppedAt - x.startedAt) / 60_000))
  const bad = x.machines.filter(m => m.settle === 'overdue').length
  const open = x.machines.filter(m => m.settle === 'wait').length
  const template = x.isTest ? 'orange' : bad ? 'red' : (x.state === 'timeout' || open) ? 'orange' : 'green'
  const head = bad ? `${bad} 台逾期待查` : (x.state === 'timeout' || open) ? '未收斂' : '全部一致'
  const header: Record<string, unknown> = {
    template,
    title: { tag: 'plain_text', content: `AutoSpin 後台對照總表｜${x.userLabel || '未知帳號'}｜${head}` },
    subtitle: { tag: 'plain_text', content: `${tpe(x.startedAt)} → ${tpe(x.stoppedAt)}・${Math.floor(mins / 60)}h${mins % 60}m・${x.machines.length} 台` },
  }
  if (x.isTest) header.text_tag_list = [{ tag: 'text_tag', text: { tag: 'plain_text', content: '試發送' }, color: 'orange' }]
  const el: object[] = []
  if (x.isTest) el.push(md("<font color='orange'>這是試發送，以下為範例資料</font>"))
  if (x.state === 'timeout') el.push(md(`<font color='orange'>未收斂：${esc(x.reason)}。下面是停止後最後一次比對的結果，沒對到終點的那段**不能當成一致**。</font>`))
  if (!x.machines.length) el.push(md(esc(x.reason || '這一輪沒有可比對的機台')))
  for (const m of x.machines) {
    el.push(hr)
    const lines = [
      `**${esc(m.name)}**　${verdict(m, x.state)}`,
      `<font color='grey'>${esc(m.gmid)}・AutoSpin ${n(m.autospin)} 局（參考）</font>`,
      `Meter ＝ 後台：**${n(m.matchedCount)} 局／${n(m.matchedAmount)}**` +
        (m.checkedFrom != null && m.checkedTo != null ? `　<font color='grey'>${hm(m.checkedFrom)}～${hm(m.checkedTo)}</font>` : ''),
    ]
    if (m.diff) lines.push(`<font color='red'>對不上的那段：Meter 比後台${m.diff.count >= 0 ? '多' : '少'} ${n(Math.abs(m.diff.count))} 局、${m.diff.amount >= 0 ? '多' : '少'} ${n(Math.abs(m.diff.amount))}</font>`)
    if (m.uncheckedTo != null && m.settle !== 'done') lines.push(`<font color='orange'>${m.checkedTo != null ? hm(m.checkedTo) : '起點'}～${hm(m.uncheckedTo)} 這段還沒檢查</font>`)
    if (m.checkedFrom == null) lines.push("<font color='orange'>沒有設到 Meter 起點，這台沒比對</font>")
    if (m.error) lines.push(`<font color='orange'>讀取問題：${esc(m.error)}</font>`)
    el.push(md(lines.join('\n')))
  }
  el.push(hr, note('這是 Instant Meter 對後台（Game Record＋Jackpot Abnormality，這台全部玩家）的對照，不代表 AutoSpin 每一局都入帳；終點附近可能含其他玩家的局。AutoSpin 局數只供參考。'))
  el.push(note(`Toppath Tools・${tpe(Date.now())}`))
  return { config: { wide_screen_mode: true, update_multi: true }, header, elements: el }
}

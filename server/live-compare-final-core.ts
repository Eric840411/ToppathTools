/**
 * AutoSpin 停止後的「後台對照總表」——結算判定與 Lark 卡片（純函式，不碰 DB／網路）。
 *
 * 同事 1106 需求：一按停止即時對照頁就空白，要①停止後還看得到②每次停止發一份總表到「OSM的秘密」群。
 * CodeX 1106 審過設計，重點：
 *   - 「t1 ≥ 停止時間」不夠：停止按鈕不等於最後一局完成，要等停止確認＋尾筆觀測收妥（一段時間沒有新局），
 *     終點是「尾筆收妥之後才讀到的 Meter 快照」（不用 agent 時鐘）；無法確認涵蓋就標未收斂，不能當一致
 *   - 結算中頁面也要顯示最近結果；結算上限 15 分鐘，逾時照現況發、標未收斂
 *   - 總計要含最後一個對上的窗口、只算一次；列出已查範圍、未查尾段、讀取錯誤
 *   - 報表叫「後台對照」，是 Meter 對後台（這台全部玩家），不能宣稱 AutoSpin 每一局都入帳；終點附近可能含其他玩家
 * 測試：npx tsx server/live-compare-final-core.test.ts
 */
import type { LiveCompareRow } from './live-compare.js'

/** 停止後最多結算多久，逾時照現況發、標未收斂 */
export const SETTLE_MAX_MS = 15 * 60_000
/** spin 筆數多久沒再增加才算尾筆收妥（伺服器時鐘；Python 收到停止後還會寫最後幾筆） */
export const TAIL_QUIET_MS = 30_000
/** 停止時一筆 spin 都還沒收到：至少再等這麼久才判定「這一輪沒有 spin」（第一筆可能還在路上） */
export const ZERO_SPIN_WAIT_MS = 3 * 60_000

export type RunState = 'running' | 'settling' | 'final' | 'timeout'

/** 一台機台結算到哪了 */
export type MachineSettle = 'done' | 'overdue' | 'wait'

/**
 * done＝涵蓋到終點的窗口對上了；overdue＝同一窗口連兩次對不上（照逾期待查定案）；其他都要再等。
 * ⚠️ 只有 t1 ≥ 終點而且 match 才算 done——t1 還在終點之前的「一致」只代表前面那段沒問題。
 * 終點還定不出來（null）一律等。
 */
export function machineSettle(row: Pick<LiveCompareRow, 'win'>, targetUp: number | null): MachineSettle {
  const w = row.win
  if (!w) return 'wait'
  if (w.status === 'overdue') return 'overdue'
  if (targetUp != null && w.status === 'match' && w.t1 != null && w.t1 >= targetUp) return 'done'
  return 'wait'
}

/**
 * 這台的終點：**尾筆收妥之後才讀到**的第一筆 Meter 快照的 upTime（Meter 自己的時間軸）。
 * ⚠️ 不能用 agent 的 observedAt 加餘裕——agent 時鐘可能差好幾分鐘（實測 164 秒），
 *    會讓還沒涵蓋尾局的窗口被判完成（CodeX aa55b01 P1）。快照的 readAt 是伺服器時鐘，
 *    跟「最後一次看到 spin 增加」同一個時鐘，比得起來；讀到的那一刻最後一局已經結束，Meter 裡一定有它。
 */
export function targetFromSnaps(snaps: Array<{ upTime: number; readAt: number }>, quietFrom: number): number | null {
  let best: number | null = null
  for (const s of snaps) if (s.readAt >= quietFrom && (best == null || s.upTime < best)) best = s.upTime
  return best
}

/** 尾筆收妥後要再等多久，本帳號 Game Record 才算到齊（實測晚約 2 分鐘） */
export const GR_SETTLE_MS = 4 * 60_000

/**
 * 這台的終點要有「Meter 已經涵蓋尾局」的證據（CodeX 7a44528 P1：晚讀到的快照可能是停止前的舊資料）。
 * 證據＝本帳號在這台最後一局的**下注時間（後台時鐘，跟 Meter 同一邊）**，一般局與 handpay 取較晚者（handpay 不進 Game Record，CodeX 862a4fa P1）：終點取它與收妥後快照的較晚者，
 * 窗口 t1 要追過它才算——Meter 停更（upTime 卡在舊時間）就永遠追不過，最後標未收斂，不會被當成一致。
 * 只有 Game Record 已經到齊（收妥後滿 GR_SETTLE_MS、而且本帳號局數跟上一次一樣）才拿來用；
 * 讀不到本帳號 Game Record 就沒有證據 → null。
 */
/** 證據的「局數」：一般局＋handpay（兩邊都要穩定才算到齊） */
export type OwnCheck = NonNullable<LiveCompareRow['own']>
export const evidenceCount = (own: OwnCheck | null | undefined): number | null => own && !('error' in own) ? own.gr + own.handpay : null

export function targetWithEvidence(x: {
  snapTarget: number | null
  own: OwnCheck | null | undefined
  prevGrCount: number | null
  now: number
  quietFrom: number
}): { target: number | null; why: string } {
  if (x.snapTarget == null) return { target: null, why: '還沒讀到尾筆收妥之後的 Meter' }
  if (x.now < x.quietFrom + GR_SETTLE_MS) return { target: null, why: '等本帳號 Game Record 到齊' }
  if (!x.own) return { target: null, why: '讀不到本帳號 Game Record／handpay，無法證明 Meter 涵蓋最後一局' }
  if ('error' in x.own) return { target: null, why: `${x.own.error}，無法證明 Meter 涵蓋最後一局` }
  if (x.own.lastBetAt == null) return { target: null, why: '本帳號在這台沒有任何一局，無法證明 Meter 涵蓋最後一局' }
  if (x.prevGrCount !== evidenceCount(x.own)) return { target: null, why: '本帳號 Game Record／handpay 局數還在變' }
  return { target: Math.max(x.snapTarget, x.own.lastBetAt), why: '' }
}

/** 本帳號局數比到停止後多久（入帳延遲靠「延後查詢」處理，這裡只放時鐘餘裕，不能放大） */
export const OWN_AFTER_STOP_MS = 60_000
/** 下一輪在停止後這麼短的時間內就開始，兩輪的局分不開（伺服器與後台時鐘差幾秒）→ 局數只供參考 */
export const OWN_MIN_GAP_MS = 15_000

/**
 * 本帳號局數的範圍上界（CodeX 431cd7c P1：「停止＋1 分鐘」會把同帳號緊接著重跑的下一輪算進來）。
 * stopAt＝這一輪最後一次心跳（伺服器時鐘）；nextStart＝同一個帳號下一輪的開始時間。
 * 上界取「stopAt＋1 分鐘」與「下一輪開始」較早者；下一輪離停止不到 15 秒 → 分不開，回 note 標只供參考。
 */
export function ownUntil(stopAt: number, nextStart: number | null): { untilMs: number; note: string } {
  const until = stopAt + OWN_AFTER_STOP_MS
  if (nextStart == null || nextStart >= until) return { untilMs: until, note: '' }
  if (nextStart - stopAt < OWN_MIN_GAP_MS) return { untilMs: nextStart, note: '下一輪在停止後馬上開始，兩輪的局可能分不開' }
  return { untilMs: nextStart, note: '' }
}

export interface SettleInput {
  /** session 已經不是 running（停止確認） */
  stopped: boolean
  /** 第一次發現停止的時間（伺服器時鐘；結算上限從這裡算） */
  stoppedAt: number | null
  /** 這一輪目前收到幾筆 spin */
  spinCount: number
  /** 伺服器最後一次看到 spin 筆數增加的時間（伺服器時鐘） */
  lastGrowthAt: number | null
  now: number
  rows: Array<Pick<LiveCompareRow, 'win' | 'gmid'>>
  /** 每台的終點（targetFromSnaps）；還定不出來是 null */
  targets: Record<string, number | null>
}

export interface SettleDecision { state: RunState; reason: string }

export function decideSettle(x: SettleInput): SettleDecision {
  if (!x.stopped || x.stoppedAt == null) return { state: 'running', reason: '' }
  const overdueAt = x.stoppedAt + SETTLE_MAX_MS
  const late = x.now > overdueAt
  // 尾筆收妥：一律先過這關（零筆也一樣，第一筆可能還在路上——CodeX aa55b01 P1）
  if (x.now - (x.lastGrowthAt ?? x.stoppedAt) < TAIL_QUIET_MS) {
    return late
      ? { state: 'timeout', reason: `停止後 ${SETTLE_MAX_MS / 60_000} 分鐘仍有新局寫入，沒辦法確定終點` }
      : { state: 'settling', reason: '等最後幾局寫完' }
  }
  if (x.spinCount === 0) {
    return x.now - x.stoppedAt >= ZERO_SPIN_WAIT_MS
      ? { state: 'final', reason: '這一輪沒有任何 spin 紀錄' }
      : { state: 'settling', reason: '還沒收到 spin 紀錄，再等一下' }
  }
  if (!x.rows.length) return { state: 'final', reason: '沒有可比對的機台' }
  const st = x.rows.map(r => machineSettle(r, x.targets[r.gmid] ?? null))
  if (st.every(s => s !== 'wait')) return { state: 'final', reason: '' }
  if (late) return { state: 'timeout', reason: `停止後 ${SETTLE_MAX_MS / 60_000} 分鐘仍有 ${st.filter(s => s === 'wait').length} 台沒對到終點` }
  return { state: 'settling', reason: '等 Game Record 入帳（約 3 分鐘）' }
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
  /**
   * AutoSpin 局數 vs 本帳號 Game Record＋handpay（同事 1106：要看「我跑的每一局有沒有進後台」）。
   * Meter 對後台抓不到「根本沒送到後台」的局，這一行才抓得到。只有結算時查過 handpay 才有（停止後、Game Record 到齊才比，不會因延遲誤報）。
   */
  own: { autospin: number; gr: number; handpay: number; note?: string } | null
  /** own 為 null 時的原因 */
  ownError: string
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
    settle: machineSettle(r, targetUp),
    diff: w && (w.status === 'overdue' || w.status === 'pending') && w.diff ? w.diff : null,
    own: r.own && !('error' in r.own) ? { autospin: r.own.autospin, gr: r.own.gr, handpay: r.own.handpay, ...(r.own.note ? { note: r.own.note } : {}) } : null,
    ownError: r.own && 'error' in r.own ? r.own.error : r.own ? '' : '沒查（停止後結算才查）',
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
  // AutoSpin 局數對不上本帳號後台也要反映在標題（CodeX b7f907e P2：不能一邊紅字一邊標題寫全部一致）
  const ownBad = x.machines.filter(m => m.own && !m.own.note && m.own.autospin !== m.own.gr + m.own.handpay).length
  const ownMissing = x.machines.filter(m => !m.own || m.own.note).length
  const open = x.machines.filter(m => m.settle === 'wait').length
  const template = x.isTest ? 'orange' : (bad || ownBad) ? 'red' : (!x.machines.length || x.state === 'timeout' || open || ownMissing) ? 'orange' : 'green'
  // 零台不能寫「全部一致」——沒有東西被檢查（CodeX aa55b01 P2）
  const head = !x.machines.length ? '無資料'
    : [bad ? `${bad} 台逾期待查` : '', ownBad ? `${ownBad} 台 AutoSpin 局數有差` : ''].filter(Boolean).join('・')
      || ((x.state === 'timeout' || open) ? '未收斂' : ownMissing ? `${ownMissing} 台局數沒查到或只供參考` : '全部一致')
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
      `<font color='grey'>${esc(m.gmid)}</font>`,
      `Meter ＝ 後台：**${n(m.matchedCount)} 局／${n(m.matchedAmount)}**` +
        (m.checkedFrom != null && m.checkedTo != null ? `　<font color='grey'>${hm(m.checkedFrom)}～${hm(m.checkedTo)}</font>` : ''),
    ]
    if (m.own) {
      const backend = m.own.gr + m.own.handpay
      const d = m.own.autospin - backend
      const hp = m.own.handpay ? `＋handpay ${n(m.own.handpay)}` : ''
      lines.push(`AutoSpin ${n(m.own.autospin)} 局 vs 你帳號 Game Record ${n(m.own.gr)} 局${hp}　` +
        (m.own.note ? `<font color='orange'>只供參考（${esc(m.own.note)}）</font>`
          : d === 0 ? "<font color='green'>✓ 局數相同</font>" : `<font color='red'>✗ AutoSpin ${d > 0 ? '多' : '少'} ${n(Math.abs(d))} 局</font>`))
    } else lines.push(`<font color='orange'>AutoSpin vs 你帳號 Game Record：沒查到（${esc(m.ownError || '讀不到 Game Record／handpay')}）</font>`)
    if (m.diff) lines.push(`<font color='red'>對不上的那段：Meter 比後台${m.diff.count >= 0 ? '多' : '少'} ${n(Math.abs(m.diff.count))} 局、${m.diff.amount >= 0 ? '多' : '少'} ${n(Math.abs(m.diff.amount))}</font>`)
    if (m.uncheckedTo != null && m.settle !== 'done') lines.push(`<font color='orange'>${m.checkedTo != null ? hm(m.checkedTo) : '起點'}～${hm(m.uncheckedTo)} 這段還沒檢查</font>`)
    if (m.checkedFrom == null) lines.push("<font color='orange'>沒有設到 Meter 起點，這台沒比對</font>")
    if (m.error) lines.push(`<font color='orange'>讀取問題：${esc(m.error)}</font>`)
    el.push(md(lines.join('\n')))
  }
  el.push(hr, note('兩種對照：①「Meter ＝ 後台」是機台 Meter 對後台帳（這台全部玩家，開頭／結尾可能混到別人的局）；②「AutoSpin vs 你帳號 Game Record」看 AutoSpin 跑的局有沒有進後台，範圍是開跑～停止後 1 分鐘、你帳號在這台的局。局數相同不保證逐局都對上（漏一局又多一局會互相抵掉）。'))
  el.push(note(`Toppath Tools・${tpe(Date.now())}`))
  return { config: { wide_screen_mode: true, update_multi: true }, header, elements: el }
}

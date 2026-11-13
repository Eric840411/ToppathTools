/**
 * shared/box-log-spins.ts — 盒子日誌逐局解析＋跟 Game Record 逐局比對（v5.85.0，Lusa 1113 要的「選填上傳盒子日誌」）
 *
 * 瀏覽器解析（日誌本身不上傳、不保存），只把精簡的每局清單送 server；server 抓 Game Record 明細後在這裡比對。
 * 前後端共用同一份規則（CLAUDE.md 踩坑 #3）。
 *
 * 日誌格式（2026-11-12 0150 實檔）：每行 `HH:MM:SS.mmm|LEVEL|訊息`，一局有兩行：
 *   DoactionResultReq action_type:4 {"spinid":215,"machine_coin":...,"cur_coin":...,"bet":960.0,"begin_time":1794412800.459583}
 *   DoactionResultReq action_type:5 {"spinid":215,...,"win":0.0,"begin_time":1794412800.459583,"isError":false,"nima":0}
 * spinid 1～999 循環 → 配對鍵是 spinid＋begin_time，不能只用 spinid。
 * 機台閒置時大約每 10 分鐘有一行心跳 → 超過 GAP_SEC 沒有任何一行＝日誌斷檔，那段只能標證據不足。
 *
 * CodeX（1113）：<1ms 只能當「候選」，多候選標歧義不強配；重送要留次數與內容差異；
 * 送出紀錄不等於後端已收到；確認語義前分類一律用「疑似」。
 *
 * claude-osm-2 用 0150 的 11/11 全天實測（6586 局）：
 *   - Game Record box_begin_time 是 begin_time「四捨五入」到 4 位小數（3310 局兩種算法不同，全部吻合四捨五入、0 局吻合截斷）
 *   - bet／win 單位跟日誌一致，不用換算
 *   - 斷線重送「不會再印 JSON」，只印 `thread_loop_check_action resend!!! N`；斷線是 `start reconnect`。
 *     重送一次後台就多一個 order_id，box_begin_time 不變 → 重複寫入靠 GR 端同局多筆抓，重送行只拿來解釋原因
 *   - 跨日開始的局只有 action 5（action 4 在前一天的檔），靠 begin_time 照樣配
 */

/** 超過這麼久沒有任何一行 → 視為日誌斷檔（實測閒置心跳間隔約 607 秒） */
export const GAP_SEC = 15 * 60
/** 結算時間離查詢視窗邊界這麼近的局不判（Game Record 以結算時間篩選，兩邊時鐘可能差幾秒） */
export const EDGE_SEC = 10
/** 解析不了的行離這筆 Game Record 的開局～結算這麼近 → 這筆可能就是那局，不判多出 */
export const BAD_PAD_SEC = 5

export type BoxSpin = {
  spinid: number
  /** begin_time 原字串（不經浮點） */
  beginRaw: string
  /** begin_time 換成整數微秒 */
  beginUs: number
  bet: number | null
  win: number | null
  /** 有沒有 action_type:5 */
  ended: boolean
  /** action_type:5 出現幾次（>1 ＝ 盒子重送） */
  endSends: number
  /** 重送時內容不同的版本數 */
  endVariants: number
  /** 第一筆 action_type:5 那行的時間（Unix 秒）；沒結束 → null */
  endSec: number | null
  /** 這局進行中到下一局開局前，盒子印了幾次 resend!!!（重送沒收到回應的訊息） */
  resends: number
  /** 同一段時間盒子斷線重連幾次（start reconnect） */
  reconnects: number
  isError: boolean
  nima: number
}

export type BoxLogParse = {
  spins: BoxSpin[]
  /** 日誌第一行～最後一行（Unix 秒）；沒有任何一局就無法定日期 → null */
  coverage: { start: number; end: number } | null
  /** 日誌斷檔區間（Unix 秒） */
  gaps: Array<{ start: number; end: number }>
  /** 看起來是 action 4／5 但 JSON 解析不了的行數 */
  badLines: number
  /** 解析不了的那幾行的時間（Unix 秒）；附近的 Game Record 只能列證據不足（CodeX 4c75d9a） */
  badSecs: number[]
  lines: number
}

/** '1794412800.459583' → 1794412800459583（整數微秒，不經浮點；位數不足補 0、超過截斷） */
export function toMicros(raw: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim())
  if (!m) return null
  const frac = (m[2] ?? '').padEnd(6, '0').slice(0, 6)
  const v = Number(m[1]) * 1_000_000 + Number(frac)
  return Number.isSafeInteger(v) ? v : null
}

const LINE_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\|/
/** 先認出是開局／結束那一行，再驗 JSON——被截斷（缺結尾 }）的行要算 badLines，不能安靜略過（CodeX 4581462） */
const ACTION_RE = /DoactionResultReq action_type:([45]) (.*?)\s*$/
/** JSON 裡 begin_time 的原字串（JSON.parse 會把它變成浮點） */
const BEGIN_RAW_RE = /"begin_time"\s*:\s*([0-9.]+)/
const RESEND_RE = /\|thread_loop_check_action resend!!!/
const RECONNECT_RE = /\|start reconnect/

type RawAction = { type: 4 | 5; tod: number; json: Record<string, unknown>; beginRaw: string; text: string; lineIdx: number }

/**
 * 解析一個或多個日誌檔（多檔照時間先後傳）。重疊上傳的同一行（同時間＋同內容）只算一次。
 */
export function parseBoxLogs(texts: string[]): BoxLogParse {
  const actions: RawAction[] = []
  const events: Array<{ tod: number; kind: 'resend' | 'reconnect' }> = []
  // 每行的 time-of-day（秒），跨午夜時 +86400
  const lineTods: number[] = []
  let badLines = 0
  const badTods: number[] = []
  let lines = 0
  let dayOffset = 0
  let lastTod = -1
  for (const text of texts) {
    // 每個檔案從頭開始；檔案之間如果時間倒退（下一天的檔），由跨午夜邏輯處理
    for (const line of text.split(/\r?\n/)) {
      const lm = LINE_RE.exec(line)
      if (!lm) continue
      lines++
      let tod = Number(lm[1]) * 3600 + Number(lm[2]) * 60 + Number(lm[3]) + Number(`0.${lm[4] ?? '0'}`)
      if (lastTod >= 0 && tod + dayOffset < lastTod - 12 * 3600) dayOffset += 86400
      tod += dayOffset
      lastTod = tod
      lineTods.push(tod)
      if (RESEND_RE.test(line)) events.push({ tod, kind: 'resend' })
      else if (RECONNECT_RE.test(line)) events.push({ tod, kind: 'reconnect' })
      const am = ACTION_RE.exec(line)
      if (!am) continue
      if (!am[2].startsWith('{')) { badLines++; badTods.push(tod); continue }
      const br = BEGIN_RAW_RE.exec(am[2])
      let json: Record<string, unknown> | null = null
      try { json = JSON.parse(am[2]) } catch { json = null }
      if (!json || !br || typeof json.spinid !== 'number') { badLines++; badTods.push(tod); continue }
      actions.push({ type: Number(am[1]) as 4 | 5, tod, json, beginRaw: br[1], text: am[2], lineIdx: lineTods.length - 1 })
    }
  }
  // 重疊上傳去重：同 time-of-day＋同內容
  const seen = new Set<string>()
  const uniq = actions.filter(a => { const k = `${a.type}|${a.tod}|${a.text}`; if (seen.has(k)) return false; seen.add(k); return true })

  // 用第一局的 begin_time（Unix 秒）跟它那行的 time-of-day 定出日期（日誌行只有時分秒）
  const anchor = uniq.find(a => a.type === 4) ?? uniq[0]
  const anchorUs = anchor ? toMicros(anchor.beginRaw) : null
  if (!anchor || anchorUs === null) return { spins: [], coverage: null, gaps: [], badLines, badSecs: [], lines }
  const TZ = 8 * 3600
  const dayLocal = Math.round((anchorUs / 1e6 + TZ - anchor.tod) / 86400) * 86400
  const toSec = (tod: number) => dayLocal + tod - TZ

  const byKey = new Map<string, { a4?: RawAction; a5: RawAction[] }>()
  for (const a of uniq) {
    const k = `${a.json.spinid}@${a.beginRaw}`
    const o = byKey.get(k) ?? { a5: [] }
    if (a.type === 4) { if (!o.a4) o.a4 = a } else o.a5.push(a)
    byKey.set(k, o)
  }
  const spins: BoxSpin[] = []
  for (const [, o] of byKey) {
    const first = o.a4 ?? o.a5[0]
    const beginUs = toMicros(first.beginRaw)
    if (beginUs === null) { badLines++; badTods.push(first.tod); continue }
    const e = o.a5[0]
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    spins.push({
      spinid: first.json.spinid as number,
      beginRaw: first.beginRaw,
      beginUs,
      bet: o.a4 ? num(o.a4.json.bet) : null,
      win: e ? num(e.json.win) : null,
      ended: o.a5.length > 0,
      endSends: o.a5.length,
      endVariants: new Set(o.a5.map(a => a.text)).size,
      endSec: e ? toSec(e.tod) : null,
      isError: o.a5.some(a => a.json.isError === true),
      nima: Math.max(0, ...o.a5.map(a => num(a.json.nima) ?? 0)),
      resends: 0,
      reconnects: 0,
    })
  }
  spins.sort((a, b) => a.beginUs - b.beginUs)
  // 重送／斷線歸給「開局時間 ≤ 事件時間」的最後一局（重送的是還沒收到回應的那局，下一局開局前都算它的）
  const dedupEv = new Set<string>()
  for (const ev of events) {
    const k = `${ev.kind}|${ev.tod}`
    if (dedupEv.has(k)) continue
    dedupEv.add(k)
    const t = toSec(ev.tod) * 1e6
    let lo = 0, hi = spins.length - 1, at = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (spins[mid].beginUs <= t) { at = mid; lo = mid + 1 } else hi = mid - 1 }
    if (at < 0) continue
    if (ev.kind === 'resend') spins[at].resends++
    else spins[at].reconnects++
  }

  const sorted = [...lineTods].sort((a, b) => a - b)
  const gaps: Array<{ start: number; end: number }> = []
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > GAP_SEC) gaps.push({ start: toSec(sorted[i - 1]), end: toSec(sorted[i]) })
  }
  return { spins, coverage: { start: toSec(sorted[0]), end: toSec(sorted[sorted.length - 1]) }, gaps, badLines, badSecs: badTods.map(toSec), lines }
}

/** Game Record 一筆（server 從 gameRecordList 明細挑出來的欄位） */
export type GrSpin = {
  orderId: string
  spinid: number
  /** box_begin_time（後台 4 位小數） */
  boxBeginTime: number
  bet: number
  win: number
  /** payout_time（Unix 秒；Game Record 的日期篩選看這個） */
  payoutSec: number
}

export type BoxCompareKind =
  | 'suspect_missing'   // 日誌有、已結束、Game Record 找不到
  | 'duplicate'         // 同一局 Game Record 兩筆以上
  | 'suspect_extra'     // Game Record 有、日誌涵蓋的時間內卻找不到
  | 'amount_diff'       // 配對到了但 bet／win 不同
  | 'ambiguous'         // 一筆對到多個候選，不強配
  | 'resent'            // 這局期間盒子有重送／斷線重連（不一定是錯，但重送一次後台就可能多一筆）
  | 'is_error'          // 盒子標 isError 的局

export type BoxCompareItem = {
  kind: BoxCompareKind
  spinid: number
  /** 開局時間（Unix 秒，小數） */
  beginSec: number
  orderIds: string[]
  box?: { bet: number | null; win: number | null; endSends: number; endVariants: number; resends: number; reconnects: number }
  gr?: Array<{ bet: number; win: number }>
}

export type BoxCompareResult = {
  items: BoxCompareItem[]
  counts: Record<BoxCompareKind, number> & { matched: number; notCovered: number; edge: number; unfinished: number; nearBadLine: number }
  notes: string[]
}

/** 開局時間換成 0.1ms 單位（後台 box_begin_time 是 4 位小數；JSON number 結尾的 0 會掉，.2880 → .288，乘完取整即可） */
function grTenths(t: number): number { return Math.round(t * 1e4) }
/**
 * 日誌 begin_time（整數微秒）→ 後台 box_begin_time 可能的 0.1ms 值：四捨五入（0150 11/11 實測）。
 * 剛好平手（第 5、6 位是 50，例如 .55195）時後台是對浮點數四捨五入，往哪邊取看二進位實際值
 * （實測 .55195 → .5519、.33055 → .3305），兩邊都當候選。
 */
function boxTenths(us: number): number[] {
  const r = Math.round(us / 100)
  return us % 100 === 50 ? [r - 1, r] : [r]
}

/**
 * 比對。window＝查詢視窗（Unix 秒，含頭不含尾；Game Record 依結算時間篩選）。
 * 只判日誌涵蓋、沒斷檔、離邊界 EDGE_SEC 以上的局；其他歸「日誌未涵蓋／邊界／未結束」不判。
 */
export function compareBoxLog(parse: Pick<BoxLogParse, 'spins' | 'coverage' | 'gaps'> & { badSecs?: number[] }, grRows: GrSpin[], window: { start: number; end: number }, opts: { grComplete?: boolean } = {}): BoxCompareResult {
  // CodeX 4581462：Game Record 沒抓完整（缺頁／缺欄位）時，「GR 沒有」不代表後台沒寫 → 不判疑似漏寫
  const grComplete = opts.grComplete !== false
  let missingSkipped = 0
  const counts = { suspect_missing: 0, duplicate: 0, suspect_extra: 0, amount_diff: 0, ambiguous: 0, resent: 0, is_error: 0, matched: 0, notCovered: 0, edge: 0, unfinished: 0, nearBadLine: 0 }
  const badSecs = parse.badSecs ?? []
  const items: BoxCompareItem[] = []
  const notes: string[] = []
  const cov = parse.coverage
  const inGap = (t: number) => parse.gaps.some(g => t > g.start && t < g.end)
  const covered = (t: number) => !!cov && t >= cov.start && t <= cov.end && !inGap(t)
  const nearEdge = (t: number) => Math.abs(t - window.start) < EDGE_SEC || Math.abs(t - window.end) < EDGE_SEC
  const inWindow = (t: number) => t >= window.start && t < window.end

  // 日誌局的索引：spinid＋四捨五入到 0.1ms 的開局時間；同鍵兩局以上＝多候選，不強配
  const idx = new Map<string, BoxSpin[]>()
  for (const s of parse.spins) {
    for (const t of boxTenths(s.beginUs)) {
      const k = `${s.spinid}@${t}`
      const a = idx.get(k) ?? []; a.push(s); idx.set(k, a)
    }
  }
  const grBySpin = new Map<BoxSpin, GrSpin[]>()
  // 被多候選 GR 對到的日誌局：沒強配，所以也不能判漏寫（CodeX 4581462）
  const inAmbiguous = new Set<BoxSpin>()
  for (const g of grRows) {
    const cands = idx.get(`${g.spinid}@${grTenths(g.boxBeginTime)}`) ?? []
    if (cands.length > 1) {
      for (const c of cands) inAmbiguous.add(c)
      counts.ambiguous++
      items.push({ kind: 'ambiguous', spinid: g.spinid, beginSec: g.boxBeginTime, orderIds: [g.orderId], gr: [{ bet: g.bet, win: g.win }] })
      continue
    }
    if (cands.length === 1) { const a = grBySpin.get(cands[0]) ?? []; a.push(g); grBySpin.set(cands[0], a); continue }
    if (nearEdge(g.payoutSec)) { counts.edge++; continue }
    if (!covered(g.boxBeginTime) || !covered(g.payoutSec)) { counts.notCovered++; continue }
    // CodeX 4c75d9a：那局的開局／結束行可能就是解析不了的那幾行 → 證據不足，不判多出
    if (badSecs.some(t => t >= g.boxBeginTime - BAD_PAD_SEC && t <= g.payoutSec + BAD_PAD_SEC)) { counts.nearBadLine++; continue }
    counts.suspect_extra++
    items.push({ kind: 'suspect_extra', spinid: g.spinid, beginSec: g.boxBeginTime, orderIds: [g.orderId], gr: [{ bet: g.bet, win: g.win }] })
  }

  for (const s of parse.spins) {
    const beginSec = s.beginUs / 1e6
    const gr = grBySpin.get(s) ?? []
    const box = { bet: s.bet, win: s.win, endSends: s.endSends, endVariants: s.endVariants, resends: s.resends, reconnects: s.reconnects }
    if (s.endSends > 1 || s.resends > 0 || s.reconnects > 0) { counts.resent++; items.push({ kind: 'resent', spinid: s.spinid, beginSec, orderIds: gr.map(g => g.orderId), box }) }
    if (s.isError) { counts.is_error++; items.push({ kind: 'is_error', spinid: s.spinid, beginSec, orderIds: gr.map(g => g.orderId), box }) }
    if (gr.length === 0) {
      // Game Record 以結算時間篩選：沒結束的局、結算在視窗外的局都不該期待在這次查詢裡
      if (!s.ended || s.endSec === null) { if (inWindow(beginSec)) counts.unfinished++; continue }
      if (!inWindow(s.endSec)) continue
      if (nearEdge(s.endSec)) { counts.edge++; continue }
      if (s.isError || inAmbiguous.has(s)) continue
      if (!grComplete) { missingSkipped++; continue }
      counts.suspect_missing++
      items.push({ kind: 'suspect_missing', spinid: s.spinid, beginSec, orderIds: [], box })
      continue
    }
    if (gr.length > 1) {
      counts.duplicate++
      items.push({ kind: 'duplicate', spinid: s.spinid, beginSec, orderIds: gr.map(g => g.orderId), box, gr: gr.map(g => ({ bet: g.bet, win: g.win })) })
      continue
    }
    const g = gr[0]
    if ((s.bet !== null && s.bet !== g.bet) || (s.win !== null && s.win !== g.win)) {
      counts.amount_diff++
      items.push({ kind: 'amount_diff', spinid: s.spinid, beginSec, orderIds: [g.orderId], box, gr: [{ bet: g.bet, win: g.win }] })
      continue
    }
    counts.matched++
  }
  items.sort((a, b) => a.beginSec - b.beginSec)

  if (!cov) notes.push('日誌裡沒有任何一局，無法比對')
  if (parse.gaps.length) notes.push(`日誌有 ${parse.gaps.length} 段超過 ${GAP_SEC / 60} 分鐘沒有任何紀錄，那幾段的 Game Record 不判（可能是斷檔或沒開機）`)
  if (counts.notCovered) notes.push(`${counts.notCovered} 筆 Game Record 落在日誌沒涵蓋的時間，不判，要比對請補那段日誌`)
  if (counts.nearBadLine) notes.push(`${counts.nearBadLine} 筆 Game Record 在日誌解析不了的那幾行附近，可能就是那幾局，不判多出`)
  if (counts.edge) notes.push(`${counts.edge} 局結算時間離查詢範圍邊界不到 ${EDGE_SEC} 秒，不判`)
  if (counts.unfinished) notes.push(`${counts.unfinished} 局在日誌裡沒有結束紀錄（日誌在那局中間截斷），不判`)
  if (counts.ambiguous) notes.push(`${counts.ambiguous} 筆 Game Record 同時對到日誌裡兩局以上，沒有強配，那幾局也不判漏寫，請人工確認`)
  if (missingSkipped) notes.push(`Game Record 沒抓完整，${missingSkipped} 局在 Game Record 找不到的不判漏寫（重查一次再看）`)
  notes.push('「疑似漏寫／疑似多出」是依日誌推斷：日誌記的是盒子送出，不代表後台一定收到；給開發時請附原始日誌')
  return { items, counts, notes }
}

/** 有問題的分類（畫面標紅、摘要列出） */
export const BOX_BAD_KINDS: BoxCompareKind[] = ['duplicate', 'suspect_missing', 'suspect_extra', 'amount_diff']

/**
 * 畫面用（v5.85.3，Lusa 1113「看不出那三筆重複」）：同一局已經有別的列（重複寫入／漏寫／金額不同／isError）時，
 * 「盒子重送／斷線重連」那列併掉——重送次數本來就顯示在那一列的日誌欄，不讓同一局出現兩次。
 * 只有重送、沒有別的問題的局照樣保留一列（後台只有 1 筆＝重送沒造成重複，留著當參考）。
 * 只改呈現，不改 counts。
 */
export function mergeResentRows(items: BoxCompareItem[]): BoxCompareItem[] {
  const key = (it: BoxCompareItem) => `${it.spinid}@${it.beginSec}`
  const covered = new Set(items.filter(it => it.kind !== 'resent' && it.box).map(key))
  return items.filter(it => it.kind !== 'resent' || !covered.has(key(it)))
}

/** 摘要：「重複寫入 1 局（多 2 筆）、疑似漏寫 3 局」；沒有問題回空陣列 */
export function boxProblemSummary(items: BoxCompareItem[]): string[] {
  const out: string[] = []
  const dup = items.filter(it => it.kind === 'duplicate')
  if (dup.length) out.push(`重複寫入 ${dup.length} 局（Game Record 多 ${dup.reduce((n, it) => n + Math.max(0, it.orderIds.length - 1), 0)} 筆）`)
  const n = (k: BoxCompareKind) => items.filter(it => it.kind === k).length
  if (n('suspect_missing')) out.push(`疑似漏寫 ${n('suspect_missing')} 局`)
  if (n('suspect_extra')) out.push(`疑似多出 ${n('suspect_extra')} 筆`)
  if (n('amount_diff')) out.push(`押注或贏分不同 ${n('amount_diff')} 局`)
  return out
}

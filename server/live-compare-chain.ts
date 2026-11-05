/**
 * AutoSpin 即時對照「逐局餘額檢查」的判定規則（純函式，不碰 DB／網路）。
 *
 * 以「一次進機台」（credit session）為單位：
 *   轉入金額 ＝ 首局 Before；每局 Before ＝ 上一局 After；末局 After ＝ 轉出金額；
 *   每局自己：After ＝ Before − Bet ＋ Win、Lose/Win ＝ Win − Bet、0 ≤ Bet Reward Credits ≤ Bet。
 *
 * 欄位（2026-11-05 QAT 原始資料核對）：
 *   Game Record：Balance Before＝bet_coin_now、Balance After＝payout_coin_now、Payout＝win、
 *                Bet Reward Credits＝bet_nima、Lose/Win＝playerWin；roundid＝gameid＋gmid＋userid＋session token
 *   Player Credit Log（rechargeRecordList）：type 1＝轉入（amount 負）、2＝轉出；
 *                reference＝gameid＋機台號＋userid＋session token＋「-in／-ou」
 * ⚠️ session 鍵要精確拆開比對（gmid＋userid＋token），不能只比字串結尾（CodeX 1105）。
 * ⚠️ 判定只有三種結果會給人看：通過／異常／待確認。資料不完整一律「待確認」，不判錯。
 * ⚠️ 中 JP（含 handpay）的局先不檢查（同事 1105：測試機台不設 handpay），標「含 JP 未檢查」。
 * ⚠️ 泥碼的扣法（優先扣、remain_nima 遞減）還沒有真資料，這版只驗 0 ≤ bet_nima ≤ bet，
 *    以及「這次進機台沒帶泥碼 → 每局 bet_nima 必須是 0」。
 */

export const BAL_EPS = 0.005

export interface ChainRound {
  orderId: string
  gmid: string
  userid: string
  /** 一次進機台的 token；拆不出來是 '' */
  token: string
  betAt: number      // ms
  payoutAt: number   // ms
  bet: number | null
  betNima: number
  win: number
  before: number | null
  after: number | null
  playerWin: number | null
  hasJp: boolean
}

export interface CreditTx {
  gmid: string
  userid: string
  token: string
  dir: 'in' | 'out'
  /** 正數：轉入／轉出了多少 */
  amount: number
  nima: number
  at: number
  reference: string
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v.replace(/,/g, '')); return Number.isFinite(n) ? n : null }
  return null
}

/** gmid（873-DFDCGRAND-0144）→ Credit Log reference 用的前綴（dfdcgrand0144） */
function creditPrefixOf(gmid: string): string | null {
  const m = /^\d+-([A-Za-z0-9]+)-([A-Za-z0-9]+)$/.exec(gmid)
  return m ? `${m[1].toLowerCase()}${m[2]}` : null
}

/** roundid ＝ gameid＋gmid＋userid＋token。前綴對不上就回 ''（不猜）。 */
export function tokenFromRoundid(roundid: string, gameid: string, gmid: string, userid: string): string {
  const head = `${gameid}${gmid}${userid}`
  if (!gameid || !gmid || !userid || !roundid.startsWith(head)) return ''
  const t = roundid.slice(head.length)
  return /^[0-9a-f]+$/i.test(t) ? t.toLowerCase() : ''
}

/** reference ＝ gameid＋機台號＋userid＋token＋「-in／-ou」。 */
export function parseReference(reference: string, gmid: string, userid: string): { token: string; dir: 'in' | 'out' } | null {
  const m = /^(.*)-(in|ou)$/.exec(reference)
  const prefix = creditPrefixOf(gmid)
  if (!m || !prefix || !userid) return null
  const head = `${prefix}${userid}`
  if (!m[1].startsWith(head)) return null
  const t = m[1].slice(head.length)
  if (!/^[0-9a-f]+$/i.test(t)) return null
  return { token: t.toLowerCase(), dir: m[2] === 'in' ? 'in' : 'out' }
}

export function normalizeRound(r: Record<string, unknown>): ChainRound | null {
  const orderId = String(r.order_id ?? '')
  const gmid = String(r.uid ?? '')
  const userid = String(r.userid ?? '')
  const betT = num(r.bet_time_precise), bet = num(r.bet)
  // ⚠️ 缺 bet 不能丟掉整局（分母會少、剩下的顯示全過——CodeX 555b858 P1），保留成未檢查。
  //    缺 bet_time_precise 會回 null——上游 guardFetchedRows 把 null／空字串轉成 0 放行，所以由 normalizeRoundsStrict 整批拒收。
  if (!orderId || !gmid || betT == null) return null
  const jpParts = [r.handpayamount, r.jackpotamount, r.jackpot_amount, r.jppoolrates_result1, r.jppoolrates_result2, r.jppoolrates_result3, r.jppoolrates_result4, r.jppoolrates_result5]
  return {
    orderId, gmid, userid,
    token: tokenFromRoundid(String(r.roundid ?? ''), String(r.gameid ?? ''), gmid, userid),
    betAt: betT * 1000,
    payoutAt: (num(r.payout_precise) ?? betT) * 1000,
    bet,
    betNima: num(r.bet_nima),
    win: num(r.win),
    before: num(r.bet_coin_now),
    after: num(r.payout_coin_now),
    playerWin: num(r.playerWin),
    hasJp: jpParts.some(v => (num(v) ?? 0) > 0),
  }
}

/**
 * 整批轉換：有任何一筆轉不出來（缺 order_id／uid／bet_time_precise）就整批拒收。
 * ⚠️ 不能只丟掉那筆——分母變小、剩下的全綠（CodeX 7b20fc6 P1：上游 guard 把 null／'' 時間轉成 0 放行）。
 */
export function normalizeRoundsStrict(raw: Record<string, unknown>[]): { rounds: ChainRound[] } | { error: string } {
  const rounds: ChainRound[] = []
  let bad = 0
  for (const x of raw) { const r = normalizeRound(x); if (r) rounds.push(r); else bad++ }
  return bad ? { error: `Game Record 有 ${bad}/${raw.length} 筆缺單號／機台／下注時間，逐局檢查不做（避免少算局數）` } : { rounds }
}

export function normalizeCredit(r: Record<string, unknown>): CreditTx | null {
  const gmid = String(r.gmid ?? ''), userid = String(r.userid ?? ''), reference = String(r.reference ?? '')
  const p = parseReference(reference, gmid, userid)
  const amount = num(r.amount), at = num(r.timestamp)
  if (!p || amount == null || at == null) return null
  const type = num(r.type)
  // type 跟 reference 結尾要一致，不一致的不採用
  if ((type === 1 && p.dir !== 'in') || (type === 2 && p.dir !== 'out')) return null
  return { gmid, userid, token: p.token, dir: p.dir, amount: Math.abs(amount), nima: Math.abs(num(r.nima) ?? 0), at, reference }
}

/**
 * 前後局／首尾對不上時，多久內算「等待入帳」而不是異常。
 * Game Record 會晚到（轉出已經記了、最後一局還沒進來），剛發生的斷點不能直接判錯（CodeX 3f471e7 P1）；
 * 超過這段時間還接不上，就是漏局或餘額錯——Game Record 漏局正是這個檢查要抓的東西，所以不能永遠待確認。
 */
export const CHAIN_GRACE_MS = 120_000

/** ok 通過｜anomaly 異常｜jp 含 JP 未檢查｜unknown 缺欄位／拆不出編號｜wait 剛發生的斷點，等入帳 */
export type RoundVerdict = 'ok' | 'anomaly' | 'jp' | 'unknown' | 'wait'

export interface RoundCheck {
  orderId: string
  betAt: number
  bet: number | null
  betNima: number | null
  win: number | null
  before: number | null
  after: number | null
  playerWin: number | null
  verdict: RoundVerdict
  /** 每條沒過或沒檢查的規則一句話 */
  problems: string[]
}

export type SessionVerdict = 'ok' | 'anomaly' | 'pending'

export interface SessionCheck {
  key: string
  gmid: string
  token: string
  inAmount: number | null
  inAt: number | null
  outAmount: number | null
  outAt: number | null
  verdict: SessionVerdict
  /** 待確認／異常的原因（session 層級） */
  notes: string[]
  rounds: RoundCheck[]
}

const off = (a: number, b: number) => Math.abs(a - b) > BAL_EPS
const f = (n: number | null) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/**
 * 一台機台、一個帳號的所有局＋所有轉帳 → 依 session 分組檢查。
 * rounds／credits 要是同一台（gmid）同一個帳號；其他的會被略過。`now` 用來判斷斷點是不是剛發生（等入帳）。
 */
export function checkChains(roundsIn: ChainRound[], creditsIn: CreditTx[], gmid: string, now: number): { sessions: SessionCheck[]; unkeyed: RoundCheck[] } {
  // 去重（分頁會重複）＋只留這台
  const seen = new Set<string>()
  const rounds = roundsIn.filter(r => r.gmid === gmid && !seen.has(r.orderId) && (seen.add(r.orderId), true))
  const seenRef = new Set<string>()
  const credits = creditsIn.filter(c => c.gmid === gmid && !seenRef.has(`${c.reference}|${c.at}`) && (seenRef.add(`${c.reference}|${c.at}`), true))

  const byToken = new Map<string, { rounds: ChainRound[]; credits: CreditTx[] }>()
  const unkeyedRounds: ChainRound[] = []
  for (const r of rounds) {
    if (!r.token) { unkeyedRounds.push(r); continue }
    const k = `${r.userid}|${r.token}`
    const g = byToken.get(k) ?? { rounds: [], credits: [] }
    g.rounds.push(r); byToken.set(k, g)
  }
  for (const c of credits) {
    const k = `${c.userid}|${c.token}`
    const g = byToken.get(k)
    if (g) g.credits.push(c)   // 沒有局的進出（進來沒玩就走）不列
  }

  const sessions: SessionCheck[] = []
  for (const [k, g] of byToken) {
    const rs = [...g.rounds].sort((a, b) => a.betAt - b.betAt || a.orderId.localeCompare(b.orderId))
    const ins = g.credits.filter(c => c.dir === 'in')
    const outs = g.credits.filter(c => c.dir === 'out')
    const notes: string[] = []
    let pending = false
    // ⚠️ 歧義時「停用」受影響的規則，不是標待確認後照樣硬比（CodeX 3f471e7 P2：中途多一筆轉入會被報斷鏈）
    const multi = ins.length > 1 || outs.length > 1
    if (multi) { notes.push(`這次進機台有 ${ins.length} 筆轉入、${outs.length} 筆轉出（可能是寶箱或中途轉帳），前後局與首尾不檢查，只驗每局自己`); pending = true }
    const tie = rs.some((r, i) => i > 0 && r.betAt === rs[i - 1].betAt)
    if (tie) { notes.push('有兩局下注時間相同，順序不唯一，前後局與首尾不檢查'); pending = true }
    const ordered = !multi && !tie
    if (!multi && ins.length === 0) { notes.push('查詢範圍內找不到轉入紀錄（可能在查詢起點之前），首局未檢查'); pending = true }
    // 沒有轉出不叫「進行中」：可能還在玩，也可能是跨日截斷／晚到（CodeX 1105）
    if (!multi && outs.length === 0) { notes.push('尚未取得轉出紀錄，末局未檢查'); pending = true }

    const inTx = ordered && ins.length === 1 ? ins[0] : null
    const outTx = ordered && outs.length === 1 ? outs[0] : null
    const checks = rs.map((r, i) => checkRound(r, {
      prev: ordered && i > 0 ? rs[i - 1] : null,
      first: i === 0 ? inTx : null,
      last: i === rs.length - 1 ? outTx : null,
      noNima: ins.length === 1 && ins[0].nima === 0,
      now,
    }))
    // ⚠️ 有任何一局沒檢查（等待入帳、缺欄位、JP），這一段就不能標「通過」（CodeX 555b858 P2）
    const notOk = checks.filter(c => c.verdict === 'wait' || c.verdict === 'unknown' || c.verdict === 'jp').length
    if (notOk) { notes.push(`有 ${notOk} 局未完成檢查`); pending = true }
    const anomaly = checks.some(c => c.verdict === 'anomaly')
    sessions.push({
      key: k, gmid, token: k.split('|')[1],
      inAmount: inTx?.amount ?? (ins.length === 1 ? ins[0].amount : null), inAt: ins.length === 1 ? ins[0].at : null,
      outAmount: outTx?.amount ?? (outs.length === 1 ? outs[0].amount : null), outAt: outs.length === 1 ? outs[0].at : null,
      verdict: anomaly ? 'anomaly' : pending ? 'pending' : 'ok',
      notes, rounds: checks,
    })
  }
  sessions.sort((a, b) => (a.rounds[0]?.betAt ?? 0) - (b.rounds[0]?.betAt ?? 0))
  const unkeyed = unkeyedRounds.map(r => {
    const c = checkRound(r, { prev: null, first: null, last: null, noNima: false, now })
    return { ...c, verdict: c.verdict === 'anomaly' ? 'anomaly' as const : 'unknown' as const, problems: ['roundid 拆不出進機台編號，前後局與轉帳未檢查', ...c.problems] }
  })
  return { sessions, unkeyed }
}

function checkRound(r: ChainRound, o: { prev: ChainRound | null; first: CreditTx | null; last: CreditTx | null; noNima: boolean; now: number }): RoundCheck {
  const hard: string[] = []      // 確定對不上
  const wait: string[] = []      // 剛發生的斷點，等入帳
  const unchecked: string[] = [] // 缺欄位或 JP，沒檢查
  const base = { orderId: r.orderId, betAt: r.betAt, bet: r.bet, betNima: r.betNima, win: r.win, before: r.before, after: r.after, playerWin: r.playerWin }
  /** 斷點：剛發生算等待，超過寬限才算異常 */
  const breakAt = (msg: string, at: number) => (o.now - at < CHAIN_GRACE_MS ? wait.push(`${msg}（等待入帳）`) : hard.push(`${msg}（可能漏局或餘額錯）`))

  // 泥碼（跟 JP 無關，JP 局也驗）
  if (r.bet == null) unchecked.push('缺 Bet，泥碼範圍、餘額公式與 Lose/Win 未檢查')
  if (r.betNima == null) unchecked.push('缺 Bet Reward Credits，泥碼未檢查')
  else if (r.bet == null) { /* 上面已記 */ }
  else if (r.betNima < -BAL_EPS || r.betNima > r.bet + BAL_EPS) hard.push(`Bet Reward Credits ${f(r.betNima)} 不在 0～Bet ${f(r.bet)} 之間`)
  else if (o.noNima && r.betNima > BAL_EPS) hard.push(`這次進機台沒帶泥碼，Bet Reward Credits 卻是 ${f(r.betNima)}`)

  if (r.before == null) unchecked.push('缺 Balance Before')
  if (r.after == null) unchecked.push('缺 Balance After')

  // Before 那一側（跟 JP 無關）
  if (o.prev && o.prev.after != null && r.before != null && off(r.before, o.prev.after)) breakAt(`Balance Before ${f(r.before)} ≠ 上一局 After ${f(o.prev.after)}`, r.betAt)
  if (o.first && r.before != null && off(r.before, o.first.amount)) breakAt(`首局 Balance Before ${f(r.before)} ≠ 轉入 ${f(o.first.amount)}`, r.betAt)

  if (r.hasJp) unchecked.push('含 JP，After／Payout／Lose/Win 未檢查')
  else {
    if (o.last && r.after != null && off(r.after, o.last.amount)) breakAt(`末局 Balance After ${f(r.after)} ≠ 轉出 ${f(o.last.amount)}`, o.last.at)
    if (r.win == null) unchecked.push('缺 Payout，餘額公式與 Lose/Win 未檢查')
    else if (r.bet != null) {
      if (r.before != null && r.after != null) {
        const want = r.before - r.bet + r.win
        if (off(r.after, want)) hard.push(`After ${f(r.after)} ≠ Before − Bet ＋ Payout ＝ ${f(want)}`)
      }
      if (r.playerWin == null) unchecked.push('缺 Lose/Win，未檢查')
      else if (off(r.playerWin, r.win - r.bet)) hard.push(`Lose/Win ${f(r.playerWin)} ≠ Payout − Bet ＝ ${f(r.win - r.bet)}`)
    }
  }

  const verdict: RoundVerdict = hard.length ? 'anomaly' : wait.length ? 'wait' : r.hasJp ? 'jp' : unchecked.length ? 'unknown' : 'ok'
  return { ...base, verdict, problems: [...hard, ...wait, ...unchecked] }
}

export interface ChainSummary {
  rounds: number
  ok: number
  anomaly: number
  jp: number
  unknown: number
  wait: number
  sessions: number
  sessionsPending: number
}

export function summarize(x: { sessions: SessionCheck[]; unkeyed: RoundCheck[] }): ChainSummary {
  const all = [...x.sessions.flatMap(s => s.rounds), ...x.unkeyed]
  return {
    rounds: all.length,
    ok: all.filter(r => r.verdict === 'ok').length,
    anomaly: all.filter(r => r.verdict === 'anomaly').length,
    jp: all.filter(r => r.verdict === 'jp').length,
    unknown: all.filter(r => r.verdict === 'unknown').length,
    wait: all.filter(r => r.verdict === 'wait').length,
    sessions: x.sessions.length,
    sessionsPending: x.sessions.filter(s => s.verdict === 'pending').length,
  }
}

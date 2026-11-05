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
  bet: number
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
  if (!orderId || !gmid || betT == null || bet == null) return null
  const jpParts = [r.handpayamount, r.jackpotamount, r.jackpot_amount, r.jppoolrates_result1, r.jppoolrates_result2, r.jppoolrates_result3, r.jppoolrates_result4, r.jppoolrates_result5]
  return {
    orderId, gmid, userid,
    token: tokenFromRoundid(String(r.roundid ?? ''), String(r.gameid ?? ''), gmid, userid),
    betAt: betT * 1000,
    payoutAt: (num(r.payout_precise) ?? betT) * 1000,
    bet,
    betNima: num(r.bet_nima) ?? 0,
    win: num(r.win) ?? 0,
    before: num(r.bet_coin_now),
    after: num(r.payout_coin_now),
    playerWin: num(r.playerWin),
    hasJp: jpParts.some(v => (num(v) ?? 0) > 0),
  }
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

export type CheckKind = 'row' | 'loseWin' | 'nima' | 'chain' | 'first' | 'last'
export type RoundVerdict = 'ok' | 'anomaly' | 'jp' | 'unknown'

export interface RoundCheck {
  orderId: string
  betAt: number
  bet: number
  betNima: number
  win: number
  before: number | null
  after: number | null
  playerWin: number | null
  verdict: RoundVerdict
  /** 每條沒過的規則一句話 */
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
 * rounds／credits 要是同一台（gmid）同一個帳號；其他的會被略過。
 */
export function checkChains(roundsIn: ChainRound[], creditsIn: CreditTx[], gmid: string): { sessions: SessionCheck[]; unkeyed: RoundCheck[] } {
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
    if (ins.length > 1 || outs.length > 1) { notes.push(`這次進機台有 ${ins.length} 筆轉入、${outs.length} 筆轉出，不硬湊，待確認`); pending = true }
    if (ins.length === 0) { notes.push('查詢範圍內找不到轉入紀錄（可能在查詢起點之前），無法驗首局'); pending = true }
    // 沒有轉出不叫「進行中」：可能還在玩，也可能是跨日截斷／晚到（CodeX 1105）
    if (outs.length === 0) { notes.push('尚未取得轉出紀錄，末局未檢查'); pending = true }
    // 同一毫秒兩局時順序不唯一，鏈不可判
    const tie = rs.some((r, i) => i > 0 && r.betAt === rs[i - 1].betAt)
    if (tie) { notes.push('有兩局下注時間相同，順序不唯一，前後局不檢查'); pending = true }

    const inTx = ins.length === 1 ? ins[0] : null
    const outTx = outs.length === 1 ? outs[0] : null
    const checks = rs.map((r, i) => checkRound(r, i === 0 ? null : rs[i - 1], {
      first: i === 0 ? inTx : null,
      last: i === rs.length - 1 ? outTx : null,
      noNima: inTx != null && inTx.nima === 0 && ins.length === 1,
      chainOk: !tie,
    }))
    const anomaly = checks.some(c => c.verdict === 'anomaly')
    sessions.push({
      key: k, gmid, token: k.split('|')[1],
      inAmount: inTx?.amount ?? null, inAt: inTx?.at ?? null,
      outAmount: outTx?.amount ?? null, outAt: outTx?.at ?? null,
      verdict: anomaly ? 'anomaly' : pending ? 'pending' : 'ok',
      notes, rounds: checks,
    })
  }
  sessions.sort((a, b) => (a.rounds[0]?.betAt ?? 0) - (b.rounds[0]?.betAt ?? 0))
  const unkeyed = unkeyedRounds.map(r => ({ ...checkRound(r, null, { first: null, last: null, noNima: false, chainOk: false }), verdict: 'unknown' as const }))
    .map(c => ({ ...c, problems: ['roundid 拆不出進機台編號，前後局與轉帳無法檢查', ...c.problems] }))
  return { sessions, unkeyed }
}

function checkRound(r: ChainRound, prev: ChainRound | null, o: { first: CreditTx | null; last: CreditTx | null; noNima: boolean; chainOk: boolean }): RoundCheck {
  const problems: string[] = []
  let unknown = false
  const base = { orderId: r.orderId, betAt: r.betAt, bet: r.bet, betNima: r.betNima, win: r.win, before: r.before, after: r.after, playerWin: r.playerWin }

  // 泥碼（JP 局也照驗，跟 JP 無關）
  if (r.betNima < -BAL_EPS || r.betNima > r.bet + BAL_EPS) problems.push(`Bet Reward Credits ${f(r.betNima)} 不在 0～Bet ${f(r.bet)} 之間`)
  else if (o.noNima && r.betNima > BAL_EPS) problems.push(`這次進機台沒帶泥碼，Bet Reward Credits 卻是 ${f(r.betNima)}`)

  if (r.before == null || r.after == null) { unknown = true; problems.push('缺 Balance Before／After') }

  // 前後局、首尾：跟 JP 無關的那一側照驗
  if (o.chainOk && prev && prev.after != null && r.before != null && off(r.before, prev.after)) {
    problems.push(`Balance Before ${f(r.before)} ≠ 上一局 After ${f(prev.after)}`)
  }
  if (o.first && r.before != null && off(r.before, o.first.amount)) problems.push(`首局 Balance Before ${f(r.before)} ≠ 轉入 ${f(o.first.amount)}`)

  if (r.hasJp) {
    // JP 局：After 端的公式與轉出先不驗
    return { ...base, verdict: problems.length && !unknown ? 'anomaly' : 'jp', problems: problems.length ? problems : ['含 JP，未檢查'] }
  }
  if (o.last && r.after != null && off(r.after, o.last.amount)) problems.push(`末局 Balance After ${f(r.after)} ≠ 轉出 ${f(o.last.amount)}`)
  if (r.before != null && r.after != null) {
    const want = r.before - r.bet + r.win
    if (off(r.after, want)) problems.push(`After ${f(r.after)} ≠ Before − Bet ＋ Payout ＝ ${f(want)}`)
  }
  if (r.playerWin != null && off(r.playerWin, r.win - r.bet)) problems.push(`Lose/Win ${f(r.playerWin)} ≠ Payout − Bet ＝ ${f(r.win - r.bet)}`)

  const hard = problems.filter(p => p !== '缺 Balance Before／After')
  return { ...base, verdict: hard.length ? 'anomaly' : unknown ? 'unknown' : 'ok', problems }
}

export interface ChainSummary {
  rounds: number
  ok: number
  anomaly: number
  jp: number
  unknown: number
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
    sessions: x.sessions.length,
    sessionsPending: x.sessions.filter(s => s.verdict === 'pending').length,
  }
}

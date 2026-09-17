/**
 * server/live-ledger-credit.ts — L3 上下分：從**後台每局的分數戳記**推出信用額的異動。
 *
 * 🚨 **原本的 L3 規格卡在「agent 沒有觀測入離機事件」，所以一直是 `implemented: false`。**
 *    但其實不需要 agent——後台 `gameRecordList` 每一局都帶
 *    `begin_machine_coin` / `end_machine_coin`，也就是**這一局前後的機台分數**。
 *    分數在「不是打這一局」的時候變動，那就是上分或下分。
 *
 * ── 為什麼用 `begin` 這條鏈，不用 `end − begin == win` ────────────────────
 *
 * 兩條恆等式都試過，實測（`873-BULLBLITZ-0136`，1,272 局）：
 *   `begin(n) == end(n-1) − bet(n)`   → 1,270 對裡只有 **3 對**不成立
 *   `end(n) − begin(n) == win(n)`     → **94 筆**不成立
 *
 * 那 94 筆不是掉錢：差額分布是 **47 筆 +1250 與 47 筆 −1250**（剛好是一注），
 * 而且成對出現在相鄰的兩局（例如 index 22 是 −1250、23 是 +1250）。
 * 也就是**後台的 `end` 戳記偶爾把下一局的下注提前扣掉了**，是戳記的時間邊界問題，
 * 前後抵銷、總額不變。
 *
 * ⚠️ 所以那 94 筆**不能報成金流異常**——報了就是 94 次假警報，而假警報一多，
 *    真正的那 3 筆就沒人看了。它們改記成「戳記品質」指標，另外顯示。
 *
 * ⚠️ 也**不能因此就不檢查**——那 3 筆是真的：上分 150,400、下分 248,903。
 *    分辨方式是換一條更可靠的鏈，不是放寬容差。
 *
 * ── 已知限制（要寫出來，不能讓「0 筆」被讀成「沒問題」）──────────────
 *
 * ⚠️ **不是每台機器都有分數戳記。**實測 `897-BIGFULINK-2065` 的 2,110 局
 *    **全部沒有** `begin_machine_coin`，整台無法檢查。這種情況回 `no_stamps`，
 *    不可以混進「沒有異常」裡。
 */
import { db } from './shared.js'
import type { ReconEnv } from './live-ledger.js'

/** 金額比較容差。分數是整數，但保留一點浮點餘裕。 */
const EPS = 0.005

export type CreditVerdict = 'clean' | 'transfers' | 'no_stamps' | 'too_few'

export interface CreditTransfer {
  spinIndex: number
  /** 正 = 上分（分數憑空增加），負 = 下分 */
  amount: number
  at: number | null
}

export interface CreditChainRow {
  env: ReconEnv
  machineName: string
  rounds: number
  /** 可檢查的連續局對數（spinIndex 不連續的地方不能比） */
  pairs: number
  transfersIn: number
  transfersOut: number
  transfers: CreditTransfer[]
  /**
   * `end − begin != win` 的筆數。⚠️ **這是戳記品質，不是金流異常**——
   * 實測它們成對出現、前後抵銷（±一注）。淨額另外給，不為 0 才需要看。
   */
  stampAnomalies: number
  stampNet: number
  verdict: CreditVerdict
  note: string
}

interface Round { i: number; begin: number; end: number; bet: number; win: number; at: number | null }

function loadRounds(env: ReconEnv, gmid: string, sinceMs: number, untilMs: number): {
  rounds: Round[]; total: number; withoutStamps: number
} {
  const raws = db.prepare(`
    SELECT spinIndex, raw, betTimePrecise FROM recon_backend_record
    WHERE env=? AND gmid=? AND betTimePrecise BETWEEN ? AND ?
    ORDER BY spinIndex ASC
  `).all(env, gmid, sinceMs, untilMs) as { spinIndex: number; raw: string; betTimePrecise: number | null }[]

  const rounds: Round[] = []
  let withoutStamps = 0
  for (const r of raws) {
    let j: Record<string, unknown>
    try { j = JSON.parse(r.raw) as Record<string, unknown> } catch { withoutStamps++; continue }
    const begin = Number(j.begin_machine_coin)
    const end = Number(j.end_machine_coin)
    const bet = Number(j.bet)
    const win = Number(j.win)
    // ⚠️ 少任何一個欄位都不能「當成 0 繼續算」——那會憑空算出巨大的上下分。
    if (![begin, end, bet, win].every(Number.isFinite)) { withoutStamps++; continue }
    rounds.push({ i: r.spinIndex, begin, end, bet, win, at: r.betTimePrecise })
  }
  return { rounds, total: raws.length, withoutStamps }
}

/**
 * 逐機台跑分數鏈。
 *
 * ⚠️ **只比 `spinIndex` 連續的兩局。**中間缺號代表我們沒抓到那幾局，
 *    硬比的話會把「沒抓到的那幾局的輸贏」算成上下分——憑空生出金流異常。
 */
export function creditChainAudit(env: ReconEnv, sinceMs: number, untilMs = Date.now()): CreditChainRow[] {
  const machines = db.prepare(`
    SELECT DISTINCT gmid FROM recon_backend_record
    WHERE env=? AND gmid IS NOT NULL AND gmid != '' AND betTimePrecise BETWEEN ? AND ?
  `).all(env, sinceMs, untilMs) as { gmid: string }[]

  const out: CreditChainRow[] = []
  for (const m of machines) {
    const { rounds, total, withoutStamps } = loadRounds(env, m.gmid, sinceMs, untilMs)
    const base: CreditChainRow = {
      env, machineName: m.gmid, rounds: total, pairs: 0,
      transfersIn: 0, transfersOut: 0, transfers: [],
      stampAnomalies: 0, stampNet: 0, verdict: 'no_stamps', note: '',
    }

    if (!rounds.length) {
      out.push({ ...base, verdict: 'no_stamps',
        note: `這台的 ${total} 局全部沒有分數戳記（begin_machine_coin），無法檢查上下分`
          + '——這不等於「沒有異常」' })
      continue
    }
    if (rounds.length < 2) {
      out.push({ ...base, verdict: 'too_few', note: '可用的局數不足兩局，湊不出一組可比的連續局' })
      continue
    }

    let prev: Round | null = null
    for (const r of rounds) {
      // 戳記品質：end − begin 應該等於 win（實測會成對偏差 ±一注，見檔頭）
      const stampDiff = (r.end - r.begin) - r.win
      if (Math.abs(stampDiff) > EPS) { base.stampAnomalies++; base.stampNet += stampDiff }

      if (prev && r.i === prev.i + 1) {
        base.pairs++
        // 分數鏈：這一局的起始分數 = 上一局的結束分數 − 這一局的下注
        const gap = r.begin - (prev.end - r.bet)
        if (Math.abs(gap) > EPS) {
          base.transfers.push({ spinIndex: r.i, amount: gap, at: r.at })
          if (gap > 0) base.transfersIn += gap; else base.transfersOut += -gap
        }
      }
      prev = r
    }

    if (!base.pairs) {
      out.push({ ...base, verdict: 'too_few',
        note: `${rounds.length} 局但沒有任何一組 spinIndex 連續——中間缺號就不能比，`
          + '硬比會把沒抓到那幾局的輸贏算成上下分' })
      continue
    }

    const noteParts: string[] = []
    if (withoutStamps) noteParts.push(`${withoutStamps} 局沒有分數戳記、未納入檢查`)
    if (base.stampAnomalies) {
      noteParts.push(`另有 ${base.stampAnomalies} 筆戳記前後不一致（淨額 ${base.stampNet.toFixed(2)}）`
        + (Math.abs(base.stampNet) <= EPS
        // ⚠️ CodeX 2026-09-18：「真實的重複扣款後補回也會長成相鄰成對、淨額 0」。
        //    淨額零不代表過程正確——只能說**疑似**邊界問題，不能宣告它不是金流異常。
        //    要排除得靠獨立的扣款／派彩流水與整段首尾餘額，這裡沒有那個依據。
        ? '，成對抵銷，**疑似**戳記時間邊界問題；但淨額 0 不代表過程正確（重複扣款後補回也長這樣），要排除需另外比對扣款／派彩流水'
        : '，**淨額不為 0，要查**'))
    }

    if (!base.transfers.length) {
      out.push({ ...base, verdict: 'clean',
        note: [`${base.pairs} 組連續局的分數鏈全部接得上，沒有帳外的分數異動`, ...noteParts].join('；') })
      continue
    }
    out.push({ ...base, verdict: 'transfers',
      note: [`偵測到 ${base.transfers.length} 次帳外分數異動：`
        + `上分 ${base.transfersIn.toLocaleString()}、下分 ${base.transfersOut.toLocaleString()}`,
      ...noteParts].join('；') })
  }

  // 有異動的排前面，其次是無法檢查的（那是缺口不是健康），最後才是乾淨的
  const rank: Record<CreditVerdict, number> = { transfers: 0, no_stamps: 1, too_few: 2, clean: 3 }
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.rounds - a.rounds)
}

/**
 * 給線別統計用的彙總。
 *
 * ⚠️ `noStamps` 一定要獨立算，不能併進 `clean`——那是「查不了」不是「沒問題」。
 *    實測 `897-BIGFULINK-2065` 的 2,110 局全部沒有分數戳記，整台無法檢查；
 *    併進 clean 的話畫面上會是一台漂亮的綠燈。
 */
export function creditSummary(env: ReconEnv, sinceMs: number, untilMs = Date.now()): {
  machines: number; clean: number; withTransfers: number; noStamps: number; tooFew: number
  transfersIn: number; transfersOut: number
} {
  const rows = creditChainAudit(env, sinceMs, untilMs)
  return {
    machines: rows.length,
    clean: rows.filter(r => r.verdict === 'clean').length,
    withTransfers: rows.filter(r => r.verdict === 'transfers').length,
    noStamps: rows.filter(r => r.verdict === 'no_stamps').length,
    tooFew: rows.filter(r => r.verdict === 'too_few').length,
    transfersIn: rows.reduce((n, r) => n + r.transfersIn, 0),
    transfersOut: rows.reduce((n, r) => n + r.transfersOut, 0),
  }
}

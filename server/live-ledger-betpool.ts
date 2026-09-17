/**
 * server/live-ledger-betpool.ts — L5 的跨源版本：**後台 bet ↔ LuckyLink 獎池增量**。
 *
 * 🚨 **現有的 L5 驗的是「LuckyLink 自己前後一致」，不是「玩家真的下了這些注」。**
 *    `jpMatrix()` 的 `coinIn` 取自 `poolChangeReport` 自己的 `oldcoinin`/`newcoinin`，
 *    所以 LuckyLink 就算整段少收了投注，它自己的算式仍然成立、仍然判 ok。
 *    要證明錢真的進去了，得拿**後台 gameRecordList 的 bet** 來對。
 *
 * 三條等式，②已經在做，這裡補①與③：
 *   ① poolChange 的 coinInΔ  ==  gameRecordList 的 betΔ      ← 跨源，這支
 *   ② Σchange_  ≈  coinInΔ × inc%                            ← jpMatrix() 已有
 *   ③ Σchange_  ≈  betΔ × inc%                               ← ①②都成立才成立
 *
 * ── 面額係數：為什麼需要，以及為什麼不能「自動校準」──────────────────
 *
 * 實測（2026-09-17，拿有 AutoSpin 紀錄的機台反推）：
 *   873-JJBX-0004        Σbet 12,312     coinInΔ 12,312    → 比值 1
 *   897-BIGFULINK-2065   Σbet 185,680    coinInΔ 185,680   → 比值 1
 *   873-BULLBLITZ-0136   Σbet 1,590,000  coinInΔ 15,900    → 比值 **100**
 *
 * 比值不是雜訊，是**乾淨的 10 的次方**（面額差異）。
 *
 * ⚠️ **但絕對不能直接拿算出來的比值去校準。**那會讓任何真實落差被係數吸收掉——
 *    少收了一半的投注，比值就變成 2，然後「校準」完一切完美。
 *    這個 repo 已經踩過一模一樣的坑：v4.120.0「全域偏移在製造假相符」。
 *
 *    所以規則是：**算出來的比值必須貼近 10 的次方才採用**（容差 2%），
 *    貼不上就回 `ratio_not_clean` 並拒絕比對——那本身就是要被看見的異常，
 *    不是要被吸收的參數。
 */
import { db } from './shared.js'
import type { ReconEnv } from './live-ledger.js'

/** 比值要多接近 10 的次方才算「面額差異」而不是「資料對不上」。 */
const RATIO_TOLERANCE = 0.02
/** 樣本太少時比值沒有意義——一兩局的誤差就能讓比值跳一個數量級。 */
const MIN_SPINS = 20
/** ③ 的容差。池增額是逐筆四捨五入累加的，不可能到小數完全相等。 */
const CHANGE_TOLERANCE = 0.005

export type BetPoolVerdict =
  | 'match' | 'mismatch' | 'no_pool' | 'no_bet' | 'too_few' | 'ratio_not_clean'

export interface BetPoolRow {
  env: ReconEnv
  machineName: string
  spins: number
  /** 後台 gameRecordList 的 bet 加總 */
  betSum: number
  /** LuckyLink 端的投入額增量（端點差，不是逐筆加總——見下方說明） */
  coinInDelta: number
  /** 逐筆加總的投入額。跟端點差不一致 = 我們漏抓了一段池變動 */
  coinInSum: number
  /** 漏抓量 = 端點差 − 逐筆加總 */
  coinInGap: number
  /** 採用的面額係數（10 的次方），拒絕採用時為 null */
  factor: number | null
  /** 實際算出來的比值，給人肉眼判斷用 */
  observedRatio: number | null
  /** ③ 預期的池增額 = betSum / factor × inc%（逐 level 加總） */
  expectedChange: number | null
  actualChange: number | null
  delta: number | null
  verdict: BetPoolVerdict
  note: string
}

/** 把比值貼到最近的 10 的次方；貼不上回 null。 */
export function snapToPowerOfTen(ratio: number): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  const k = Math.round(Math.log10(ratio))
  const snapped = Math.pow(10, k)
  return Math.abs(ratio / snapped - 1) <= RATIO_TOLERANCE ? snapped : null
}

/**
 * 逐機台比對。
 *
 * ⚠️ **投入額用端點差（`MAX(newcoinin) − MIN(oldcoinin)`），不是逐筆加總。**
 *    實測 `873-JJBX-0004 lv588`：逐筆加總 2,400、端點差 250,100，差 247,700——
 *    中間有一段池變動我們沒抓到。逐筆加總會**安靜地少算 24 萬**，端點差不會。
 *    兩者相減就是「漏抓了多少」，所以兩個都算、都回傳。
 *
 * ⚠️ **各 level 的 coinIn 是同一個量，不能相加。**實測近 24 小時同機台同時間戳
 *    有 2 筆的 5,110 組、3 筆 98 組、4 筆 78 組——一注會對每個 Level 各寫一筆，
 *    `892-TRIPLEPOT-0196` 的 lv552 與 lv553 投入額都是同一個 449,245。
 *    所以投入額取「筆數最多的那個 level」，而池增額才是各 level 加總。
 *
 * ⚠️ **泥碼已經含在 `bet` 裡面**（使用者 2026-09-17 確認），`bet_nima` 只是拆分明細。
 *    加上去會變成重複計算。而且泥碼**會造成 JP 累積**，所以泥碼局不能被排除。
 */
export function betPoolAudit(env: ReconEnv, sinceMs: number, untilMs = Date.now()): BetPoolRow[] {
  /**
   * 🚨 **一定要按 session 的實際時間範圍算，不能用畫面上選的那個大窗。**
   *
   * `poolChangeReport` 的投入額是**機台的**投入額（誰打都算），而
   * `recon_backend_record` 只有**我們這個帳號**的局（拉取時帶了 `playerName` 過濾）。
   * 窗一拉大，池那側就把別人打的也算進來，兩邊根本不是同一個量。
   *
   * 實測（2026-09-17）：用 30 天的窗算，三台的比值是 0.1140 / 0.0430 / 0.0014——
   * 看起來像「單位亂七八糟」。改用各 session 自己的時間範圍重算，
   * 同樣三台變成 **1 / 100 / 1**，乾乾淨淨。差別只在窗。
   *
   * ⚠️ 這**不保證**同一段時間沒有別人在打同一台。真有人插進來的話比值會變成
   *    不乾淨的數字 → `ratio_not_clean` → 拒絕比對並報出來。那是正確的行為：
   *    寧可說「這段不可信」，也不要把污染吃進係數裡假裝對上了。
   */
  const sessions = db.prepare(`
    SELECT sessionId, gmid, COUNT(*) spins, MIN(observedAt) t0, MAX(observedAt) t1
    FROM recon_spin
    WHERE env=? AND gmid IS NOT NULL AND gmid != '' AND observedAt BETWEEN ? AND ?
    GROUP BY sessionId, gmid
  `).all(env, sinceMs, untilMs) as
    { sessionId: string; gmid: string; spins: number; t0: number; t1: number }[]

  /**
   * 時間邊界的寬限。兩邊時鐘不同步（實測本機比後台慢到 120 秒），
   * 而且入帳有延遲——窗抓太緊會把邊界那幾局切掉，看起來像少收。
   */
  const MARGIN_MS = 10 * 60_000

  const out: BetPoolRow[] = []
  for (const m of sessions) {
    const winFrom = m.t0 - MARGIN_MS
    const winTo = m.t1 + MARGIN_MS
    const base: BetPoolRow = {
      env, machineName: m.gmid, spins: m.spins,
      betSum: 0, coinInDelta: 0, coinInSum: 0, coinInGap: 0,
      factor: null, observedRatio: null,
      expectedChange: null, actualChange: null, delta: null,
      verdict: 'no_bet', note: '',
    }

    // ── 後台側：bet 加總。⚠️ 直接用 bet，不加 bet_nima（泥碼已含在內）
    //
    // ⚠️ betTimePrecise 落庫時已經正規化成**毫秒**（實測 1788745485450），
    //    不是後台原始回應裡那個秒級 float（1788512695.42）。第一版把它除以 1000
    //    再比，結果是每一台都 no_bet——看起來像「後台根本沒有這台的資料」。
    const recs = db.prepare(`
      SELECT raw FROM recon_backend_record
      WHERE env=? AND gmid=?
        AND betTimePrecise IS NOT NULL
        AND betTimePrecise BETWEEN ? AND ?
    `).all(env, m.gmid, winFrom, winTo) as { raw: string }[]
    let betSum = 0, counted = 0
    for (const r of recs) {
      try {
        const j = JSON.parse(r.raw) as { bet?: number }
        const b = Number(j.bet)
        if (Number.isFinite(b)) { betSum += b; counted++ }
      } catch { /* 壞掉的那筆跳過，不讓它把整台弄爛 */ }
    }
    base.betSum = betSum
    if (!counted || betSum <= 0) {
      out.push({ ...base, verdict: 'no_bet', note: '後台查不到這台的下注紀錄，無從比對' })
      continue
    }

    // ── 池側：投入額取筆數最多的那個 level（各 level 的投入額是同一個量）
    const lv = db.prepare(`
      SELECT levelid, MAX(newcoinin) - MIN(oldcoinin) delta,
             SUM(newcoinin - oldcoinin) sum_, COUNT(*) rows
      FROM recon_pool_change
      WHERE env=? AND machineName=? AND ts BETWEEN ? AND ?
      GROUP BY levelid ORDER BY rows DESC LIMIT 1
    `).get(env, m.gmid, winFrom, winTo) as
      { levelid: string; delta: number; sum_: number; rows: number } | undefined
    if (!lv || !lv.rows || lv.delta <= 0) {
      out.push({ ...base, verdict: 'no_pool',
        note: '這段期間查不到這台的池變動——可能是 SAS 機台（沒有 LuckyLink），也可能是沒掛上' })
      continue
    }
    base.coinInDelta = lv.delta
    base.coinInSum = lv.sum_
    base.coinInGap = lv.delta - lv.sum_

    if (m.spins < MIN_SPINS) {
      out.push({ ...base, verdict: 'too_few',
        note: `只有 ${m.spins} 局，樣本太少——比值會被一兩局的誤差放大一個數量級，不做判定` })
      continue
    }

    // ── ① 跨源：比值必須是乾淨的 10 的次方（面額），否則拒絕比對
    const ratio = betSum / lv.delta
    base.observedRatio = ratio
    const factor = snapToPowerOfTen(ratio)
    if (factor === null) {
      out.push({ ...base, verdict: 'ratio_not_clean',
        note: `後台下注 ${betSum} ÷ LuckyLink 投入額 ${lv.delta} = ${ratio.toFixed(4)}，`
          + '不是乾淨的面額倍數（10 的次方）。**這正是要被看見的異常**——'
          + '兩邊對不上時把比值當係數吃掉，等於讓落差永遠不會出現' })
      continue
    }
    base.factor = factor

    // ── ③ 池增額：預期 = 換算後的投入額 × 各 level 的 inc%
    const levels = db.prepare(`
      SELECT p.levelid,
             MAX(p.newcoinin) - MIN(p.oldcoinin) delta,
             SUM(p.change_) actual,
             MAX(m.incrementPercent) incr
      FROM recon_pool_change p
      LEFT JOIN recon_machine_map m ON m.env=p.env AND m.machineName=p.machineName AND m.levelid=p.levelid
      WHERE p.env=? AND p.machineName=? AND p.ts BETWEEN ? AND ?
        AND p.verify IN ('ok','mismatch')
      GROUP BY p.levelid
    `).all(env, m.gmid, winFrom, winTo) as
      { levelid: string; delta: number; actual: number; incr: number | null }[]

    const betAsCoinIn = betSum / factor
    let expected = 0, actual = 0, missingIncr = 0
    for (const l of levels) {
      if (l.incr === null || !Number.isFinite(l.incr)) { missingIncr++; continue }
      expected += betAsCoinIn * l.incr
      actual += l.actual
    }
    if (!levels.length || missingIncr === levels.length) {
      out.push({ ...base, verdict: 'no_pool',
        note: '查不到任何 Level 的 increment%，無法算預期增額' })
      continue
    }
    base.expectedChange = expected
    base.actualChange = actual
    base.delta = actual - expected

    const ok = Math.abs(base.delta) <= Math.max(CHANGE_TOLERANCE, Math.abs(expected) * CHANGE_TOLERANCE)
    out.push({ ...base,
      verdict: ok ? 'match' : 'mismatch',
      note: ok
        ? `後台下注 ${betSum}（面額 ×${factor}）推得池增額 ${expected.toFixed(4)}，實際 ${actual.toFixed(4)}`
        : `後台下注推得池增額 ${expected.toFixed(4)}，實際 ${actual.toFixed(4)}，`
          + `差 ${base.delta.toFixed(4)}`
          + (base.coinInGap > 0
            ? `。⚠️ 這台還有 ${base.coinInGap} 的投入額是我們漏抓的（端點差 ${lv.delta} vs 逐筆加總 ${lv.sum_}），先確認是不是漏抓造成的`
            : ''),
    })
  }

  // mismatch 與 ratio_not_clean 最前面，其餘照局數多的在前
  const rank: Record<BetPoolVerdict, number> = {
    mismatch: 0, ratio_not_clean: 1, no_pool: 2, too_few: 3, no_bet: 4, match: 5,
  }
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.spins - a.spins)
}

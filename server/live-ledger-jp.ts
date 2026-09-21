/**
 * server/live-ledger-jp.ts — Live Ledger P2：L4（JP 中獎）與 L5（JP 池）的落庫與驗證。
 *
 * 跟主拉取迴圈分開，因為它們的節奏與失敗模式都不同：
 * 後台 gameRecordList 綁的是「我們自己的 spin」，而 JP 是**整個群組共用**的池，
 * 不依賴有沒有壓測在跑。
 *
 * ⚠️ 兩支報表的健康分開記（`poolChangeReport` / `awardsReport`），
 *    合成一盞燈的話，哪一支壞掉分不出來。
 */
import { db } from './shared.js'
import {
  type ReconEnv, type LlLevel, type LlPoolChange, type LlAward,
  fetchLevels, fetchPoolChanges, fetchAwards, verifyPoolChange, verifyAward, noteLlHealth,
} from './lib/luckylink-recon.js'

/** 每輪往回重疊，避免邊界那幾筆被永久跳過（跟後台拉取同一個理由）。 */
const OVERLAP_SEC = 120
/**
 * 冷啟動往回看多久。⚠️ **JP 的池變動很稀疏**——實測近 3 小時 0 筆、近 24 小時 202 筆。
 *    窗開太窄的話第一次啟動會抓到 0 筆，而畫面上「0 筆」跟「還沒串接」長得一樣。
 *    只有冷啟動用得到（之後靠 watermark 增量），代價很小。
 */
const COLD_START_SEC = 24 * 3600
const PAGE_SIZE = 500
const MAX_PAGES = 10

/**
 * ── 抓取視窗策略（2026-09-07 重寫）─────────────────────────────────────────
 *
 * 🚨 **舊做法會靜默掉資料。**原本用「游標 → now」當單一視窗，上限 500×10=5000。
 *    而這支 API 是**新到舊**排序——撞上限時拿到的是**最新的 5000 筆**，
 *    游標接著跳到最新那筆，**中間沒抓到的那段就永遠跳過去了**。
 *    實測資料表有 13.7 小時與 16.9 小時兩個缺口，而且完全沒有徵兆
 *    （跟 Jira 對帳 v4.99.0 同一種壞法）。
 *
 * 新做法分兩條：
 *   ① **即時視窗**：每輪固定只看「往前 LIVE_WINDOW_SEC」。cycle 每 60 秒跑一次，
 *      這個視窗永遠很小，**結構上不可能撞上限**。
 *   ② **補進度**：游標保留，但只用來偵測落後。落後時用固定長度的小切片往前補，
 *      一輪最多補 CATCHUP_SLICES_PER_CYCLE 片，不會把單輪拖太久。
 *
 * ⚠️ **切片撞上限時要把它切一半重試，不能讓游標跳過沒抓到的資料**——
 *    那正是舊做法的錯誤。切到 MIN_SLICE_SEC 還撞上限才承認「這段補不完」，
 *    **明確記錄成缺口**再往前走（否則會永遠卡在同一片，一筆都補不進來）。
 */
const LIVE_WINDOW_SEC = 90
/** 上界往回留一點，避免讀到「這一秒還在寫」的邊界（CodeX 建議 now-10s）。 */
const LIVE_LAG_SEC = 10
const CATCHUP_SLICE_SEC = 30 * 60
const CATCHUP_SLICES_PER_CYCLE = 4
/**
 * ⚠️ **最小切片 1 秒**（CodeX 定案）。這支資料的時間精度到秒——
 * 同一秒還打滿 5000 筆的話，**再切已經沒有意義，因為時間條件無法再區分資料**。
 * 那時要做的是明確報「這一秒抓不完」，而不是繼續切或偷偷跳過。
 */
const MIN_SLICE_SEC = 1

/**
 * 🚨 **這支 API 的 `dateTime` 是「本地時間（UTC+8）」，不是 UTC。**
 *
 * 原本送的是 `toISOString()`（UTC），於是**每次查詢的視窗都往前偏了 8 小時**——
 * 整條 L4／L5 管線一直落後真實時間 8 小時。
 *
 * 實測證據（2026-09-08）：同一個時段（資料表裡有 1314 筆）
 *     送 UTC 字串  [2026-09-06 06:00 → 07:00] → **0 筆**
 *     送本地字串   [2026-09-06 14:00 → 15:00] → **500 筆**
 * 而且資料表最新是 9/7 17:25、當下是 9/8 01:30——**正好差 8 小時**。
 *
 * ⚠️ **不要跟 OSM／GCP 後台的規則搞混。**那邊的 `dateTime[]` 確實是 ISO UTC
 *    （見 CLAUDE.md「Performance Meter 對帳」），**LuckyLink 這支相反**。
 *    兩個後台的同名參數用不同時區，是這次踩到的坑。
 */
const LL_TZ_OFFSET_MS = 8 * 3600_000
const toIso = (ms: number) =>
  new Date(ms + LL_TZ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')

/** LuckyLink 的 timestamp 可能是秒或毫秒，也可能是字串。統一成 epoch ms。 */
function tsMs(v: number | string): number {
  if (typeof v === 'string') {
    const p = Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z')
    if (Number.isFinite(p)) return p
    const n = Number(v)
    return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN
  }
  return v < 1e12 ? v * 1000 : v
}

function readWm(env: ReconEnv, source: string): number {
  const r = db.prepare('SELECT cursorTs FROM recon_watermark WHERE env=? AND source=? AND scope=?')
    .get(env, source, '') as { cursorTs: number } | undefined
  return r?.cursorTs ?? 0
}
function writeWm(env: ReconEnv, source: string, ts: number): void {
  db.prepare(`
    INSERT INTO recon_watermark (env, source, scope, cursorTs, updatedAt) VALUES (?, ?, '', ?, ?)
    ON CONFLICT(env, source, scope) DO UPDATE SET cursorTs=excluded.cursorTs, updatedAt=excluded.updatedAt
  `).run(env, source, ts, Date.now())
}

/**
 * 抓一段時間窗的池變動，並**明確回報有沒有撞到分頁上限**。
 *
 * 🚨 `capped` 是這整個修正的關鍵。舊版只看「拿到幾筆」，而
 *    「剛好 5000 筆」跟「其實更多、只給了 5000」在程式裡長得一模一樣——
 *    這正是 Jira 對帳 v4.99.0 那次的同一種壞法：**截斷完全沒有徵兆**。
 */
export async function fetchSlice(env: ReconEnv, fromMs: number, toMs: number): Promise<{
  ok: boolean; items: LlPoolChange[]; capped: boolean; errKind?: string; message?: string
}> {
  const items: LlPoolChange[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetchPoolChanges(env, toIso(fromMs), toIso(toMs), '', page, PAGE_SIZE)
    if (!r.ok) return { ok: false, items, capped: false, errKind: r.errKind, message: r.message }
    items.push(...r.items)
    // 沒填滿一頁 = 這段已經拿完
    if (r.items.length < PAGE_SIZE) return { ok: true, items, capped: false }
  }
  // 十頁都填滿 → 這段**可能還有更多沒拿到**，不能當成完整
  return { ok: true, items, capped: true }
}

/** Level 參數快取——每輪重抓一次就好，437 筆不大但也不必每頁都拉。 */
async function levelMap(env: ReconEnv): Promise<Map<string, LlLevel> | null> {
  const r = await fetchLevels(env, 1, 1000)
  if (!r.ok) { noteLlHealth(env, 'levelsListData', false, r.errKind, r.message); return null }
  noteLlHealth(env, 'levelsListData', true)
  return new Map(r.items.map(l => [String(l.id), l]))
}

/**
 * 機台 ↔ 獎池對應。**從 poolChangeReport 反推**——`egmList` 兩個環境都回 0 筆。
 *
 * ⚠️ `resolvedBy` 的升級路徑是 `config` → `observed`：報表真的出現過這個組合才算證實。
 *    **設定說掛著、報表卻從沒出現過**，那是機台掛錯獎池——平常完全看不出來的配置 bug，
 *    本身就該被看見（所以矩陣上要標「未觀測」而不是當成正常）。
 */
function upsertMachineMap(env: ReconEnv, c: LlPoolChange, level: LlLevel | undefined): void {
  db.prepare(`
    INSERT INTO recon_machine_map (env, machineName, levelid, groupid, groupName, levelName,
      protocallevelid, incrementPercent, basevalue, maxValue, channelId, assetnumber,
      resolvedBy, verifiedAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?)
    ON CONFLICT(env, machineName, levelid) DO UPDATE SET
      groupid=excluded.groupid, groupName=excluded.groupName, levelName=excluded.levelName,
      protocallevelid=excluded.protocallevelid, incrementPercent=excluded.incrementPercent,
      basevalue=excluded.basevalue, maxValue=excluded.maxValue,
      channelId=excluded.channelId, assetnumber=excluded.assetnumber,
      resolvedBy='observed', verifiedAt=excluded.verifiedAt, updatedAt=excluded.updatedAt
  `).run(env, c.machineName, String(c.levelid), String(c.groupid ?? ''), c.groupName ?? '',
    c.levelName ?? '', c.protocallevelid ?? null,
    level?.incrementPercent ?? null, level?.basevalue ?? null, level?.maxValue ?? null,
    String(c.channelId ?? ''), String(c.assetnumber ?? ''), Date.now(), Date.now())
}

export interface JpCycleResult {
  poolFetched: number; poolStored: number; poolMismatch: number
  awardFetched: number; awardStored: number; awardBad: number
  errors: string[]
}

/** 跑一輪 L5（池變動）+ L4（中獎）。 */
export async function runJpCycle(env: ReconEnv, now = Date.now()): Promise<JpCycleResult> {
  const out: JpCycleResult = {
    poolFetched: 0, poolStored: 0, poolMismatch: 0,
    awardFetched: 0, awardStored: 0, awardBad: 0, errors: [],
  }
  const levels = await levelMap(env)
  if (!levels) { out.errors.push('levelsListData 取不到，無法驗證（不是「沒有變動」）'); return out }

  // ── L5：池變動 ──
  {
    const wm = readWm(env, 'poolChangeReport')
    const liveFrom = now - LIVE_WINDOW_SEC * 1000
    const liveTo = now - LIVE_LAG_SEC * 1000

    // ① 即時視窗——固定小範圍，結構上不可能撞上限
    const live = await fetchSlice(env, liveFrom, liveTo)
    const collected: LlPoolChange[] = [...live.items]
    let failed = !live.ok
    if (!live.ok) {
      noteLlHealth(env, 'poolChangeReport', false, live.errKind, live.message)
      out.errors.push(`poolChangeReport 即時視窗：${live.message ?? live.errKind}`)
    }

    // ② 補進度——游標落後時，用切片往前補。切片撞上限就對半切，
    //    切到 1 秒還撞上限就明確報「這一秒抓不完」並停住（不偷偷跳過）。
    if (!failed) {
      let cursor = wm > 0 ? wm - OVERLAP_SEC * 1000 : now - COLD_START_SEC * 1000
      let slices = 0
      while (cursor < liveFrom && slices < CATCHUP_SLICES_PER_CYCLE) {
        let sliceEnd = Math.min(cursor + CATCHUP_SLICE_SEC * 1000, liveFrom)
        let got = await fetchSlice(env, cursor, sliceEnd)
        // 撞上限就對半切，直到裝得下或切到最小單位
        while (got.ok && got.capped && (sliceEnd - cursor) > MIN_SLICE_SEC * 1000) {
          sliceEnd = cursor + Math.max(MIN_SLICE_SEC * 1000, Math.floor((sliceEnd - cursor) / 2))
          got = await fetchSlice(env, cursor, sliceEnd)
        }
        if (!got.ok) {
          noteLlHealth(env, 'poolChangeReport', false, got.errKind, got.message)
          out.errors.push(`poolChangeReport 補進度 ${toIso(cursor)}：${got.message ?? got.errKind}`)
          break
        }
        if (got.capped) {
          /**
           * 🚨 切到最小單位還打滿——**時間條件已經無法再區分資料**（CodeX 定案）。
           *    這時：不推進游標、明確報錯、停止自動補。
           *
           * ⚠️ **刻意讓補進度卡住而不是跳過去。**跳過去等於靜默掉資料，
           *    那正是這次要修的 bug；卡住至少看得見，而且即時視窗照常運作，
           *    當下的資料不會斷。要解得換更細的條件（id／流水號／更深分頁）。
           */
          out.errors.push(
            `poolChangeReport 補進度卡住：${toIso(cursor)} 這 ${MIN_SLICE_SEC} 秒內就打滿 `
            + `${MAX_PAGES * PAGE_SIZE} 筆上限，時間條件已無法再細分。`
            + '需要改用更細的條件（id／流水號／更深分頁）才補得完，自動補進度已停止。')
          break
        }
        collected.push(...got.items)
        cursor = sliceEnd
        slices++
      }
      // 游標代表「到這個時間點為止是完整的」——只有補完整的切片才推進
      if (cursor > wm) writeWm(env, 'poolChangeReport', cursor)
    }

    if (!failed) {
      noteLlHealth(env, 'poolChangeReport', true)
      out.poolFetched = collected.length
      const ins = db.prepare(`
        INSERT INTO recon_pool_change (env, reqmd5, levelid, machineid, groupid, machineName,
          groupName, levelName, protocallevelid, oldcoinin, newcoinin, before_, change_, after_,
          beforeover, afterover, poolamount, reason, ts, fetchedAt, verify, verifyDelta, raw)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(env, reqmd5, levelid, ts) DO UPDATE SET
          verify=excluded.verify, verifyDelta=excluded.verifyDelta, fetchedAt=excluded.fetchedAt
      `)
      /**
       * ⚠️ **這裡刻意不再用「抓到的資料最大時間」去推游標。**
       *    那是舊做法：撞上限時拿到的是最新的一批，推過去就把中間沒抓到的
       *    整段跳過了。游標現在只由「完整補完的切片」推進（見上面），
       *    代表「到這個時間點為止是完整的」，而不是「我看過最新的一筆」。
       */
      const tx = db.transaction(() => {
        for (const c of collected) {
          const t = tsMs(c.timestamp)
          if (!Number.isFinite(t)) continue
          const lv = levels.get(String(c.levelid))
          const v = verifyPoolChange(c, lv)
          ins.run(env, String(c.reqmd5 ?? ''), String(c.levelid), String(c.machineid ?? ''),
            String(c.groupid ?? ''), c.machineName ?? '', c.groupName ?? '', c.levelName ?? '',
            c.protocallevelid ?? null, c.oldcoinin, c.newcoinin, c.before, c.change, c.after,
            c.beforeover, c.afterover, c.poolamount, String(c.reason), t, now,
            v.verify, v.delta, JSON.stringify(c))
          upsertMachineMap(env, c, lv)
          out.poolStored++
          if (v.verify === 'mismatch') out.poolMismatch++
        }
      })
      tx()
      out.poolFetched = collected.length
    }
  }

  // ── L4：中獎 ──
  {
    const wm = readWm(env, 'awardsReport')
    const from = wm > 0 ? wm - OVERLAP_SEC * 1000 : now - COLD_START_SEC * 1000
    const r = await fetchAwards(env, toIso(from), toIso(now + 60_000), '', 1, PAGE_SIZE)
    if (!r.ok) {
      noteLlHealth(env, 'awardsReport', false, r.errKind, r.message)
      out.errors.push(`awardsReport：${r.message ?? r.errKind}`)
    } else {
      noteLlHealth(env, 'awardsReport', true)
      out.awardFetched = r.items.length
      const ins = db.prepare(`
        INSERT INTO recon_jp_award (env, awardKey, machineName, gmid, groupName, levelid, levelname,
          protocallevelid, amount, beforeAmount, afterAmount, isException, ts, fetchedAt,
          eqSelfOk, eqBasevalueOk, eqPoolOk, verifyNote, raw)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(env, awardKey) DO UPDATE SET
          eqSelfOk=excluded.eqSelfOk, eqBasevalueOk=excluded.eqBasevalueOk,
          eqPoolOk=excluded.eqPoolOk, verifyNote=excluded.verifyNote, fetchedAt=excluded.fetchedAt
      `)
      let maxTs = wm
      const tx = db.transaction(() => {
        for (const a of r.items as LlAward[]) {
          const t = tsMs(a.time)
          if (!Number.isFinite(t)) continue
          // 中獎那一刻的 poolChange（Jackpot 類）的 before，用來做第三條等式的跨報表交叉
          const pc = db.prepare(`
            SELECT before_ FROM recon_pool_change
            WHERE env=? AND levelid=? AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1
          `).get(env, String(a.levelid), t - 60_000, t + 60_000, t) as { before_: number } | undefined
          const lv = levels.get(String(a.levelid))
          const v = verifyAward(a, lv, pc?.before_ ?? null)
          const key = `${a.machineid ?? a.gmid}|${a.levelid}|${t}`
          ins.run(env, key, String(a.gmid ?? ''), String(a.gmid ?? ''),
            a.groupName ?? a.groupname ?? '', String(a.levelid), a.levelname ?? '',
            a.protocallevelid ?? null, a.amount, a.beforeAmount, a.afterAmount,
            a.isException ? 1 : 0, t, now,
            v.eqSelfOk ? 1 : 0, v.eqBasevalueOk === null ? null : (v.eqBasevalueOk ? 1 : 0),
            v.eqPoolOk === null ? null : (v.eqPoolOk ? 1 : 0), v.note, JSON.stringify(a))
          out.awardStored++
          if (!v.eqSelfOk || v.eqBasevalueOk === false || v.eqPoolOk === false) out.awardBad++
          if (t > maxTs) maxTs = t
        }
      })
      tx()
      if (maxTs > wm) writeWm(env, 'awardsReport', maxTs)
    }
  }
  return out
}

// ─── 畫面用查詢 ──────────────────────────────────────────────────────────

export interface JpPoolRow {
  machineName: string; groupName: string; levelid: string; levelName: string
  protocallevelid: number | null; incrementPercent: number | null
  basevalue: number | null; maxValue: number | null
  resolvedBy: string; verifiedAt: number | null
  coinIn: number | null; expected: number | null; actual: number | null
  delta: number | null; verdict: string; samples: number
}

/**
 * JP 對應矩陣＋本區間累積。
 *
 * ⚠️ **群組的池數不一樣（實測 1 池 18 組／2 池 61／3 池 24／4 池 39）**，
 *    所以矩陣天然是不等長的，不要補空格湊齊——補了會讓人以為那台有那個池。
 *
 * ⚠️ `resolvedBy='config'`（設定帶入但報表從沒出現過）要標「未觀測」，
 *    **不是 MATCH**。它還沒被證實掛對。
 */
export function jpMatrix(env: ReconEnv, sinceMs: number): JpPoolRow[] {
  const maps = db.prepare(`
    SELECT * FROM recon_machine_map WHERE env=? ORDER BY machineName, protocallevelid, levelid
  `).all(env) as Record<string, unknown>[]
  const agg = db.prepare(`
    SELECT machineName, levelid,
           SUM(CASE WHEN verify='ok' OR verify='mismatch' THEN newcoinin - oldcoinin ELSE 0 END) coinIn,
           SUM(CASE WHEN verify='ok' OR verify='mismatch' THEN change_ ELSE 0 END) actual,
           SUM(CASE WHEN verify='mismatch' THEN 1 ELSE 0 END) bad,
           COUNT(*) n
    FROM recon_pool_change WHERE env=? AND ts >= ? GROUP BY machineName, levelid
  `).all(env, sinceMs) as { machineName: string; levelid: string; coinIn: number; actual: number; bad: number; n: number }[]
  const byKey = new Map(agg.map(a => [`${a.machineName}|${a.levelid}`, a]))

  return maps.map(m => {
    const a = byKey.get(`${m.machineName}|${m.levelid}`)
    const incr = m.incrementPercent as number | null
    const coinIn = a?.coinIn ?? null
    const expected = coinIn !== null && incr !== null ? coinIn * incr : null
    const actual = a?.actual ?? null
    const delta = expected !== null && actual !== null ? actual - expected : null
    const verdict = m.resolvedBy !== 'observed' ? '未觀測'
      : !a || a.n === 0 ? '本區間無變動'
        : a.bad > 0 ? 'MISMATCH'
          : 'MATCH'
    return {
      machineName: String(m.machineName), groupName: String(m.groupName ?? ''),
      levelid: String(m.levelid), levelName: String(m.levelName ?? ''),
      protocallevelid: (m.protocallevelid as number) ?? null,
      incrementPercent: incr, basevalue: (m.basevalue as number) ?? null,
      maxValue: (m.maxValue as number) ?? null,
      resolvedBy: String(m.resolvedBy), verifiedAt: (m.verifiedAt as number) ?? null,
      coinIn, expected, actual, delta, verdict, samples: a?.n ?? 0,
    }
  })
}

export function jpSummary(env: ReconEnv, sinceMs: number): {
  poolRows: number; poolOk: number; poolMismatch: number; poolSkipped: number
  awards: number; awardsBad: number; machines: number; levels: number
  observed: number; configOnly: number
} {
  const p = db.prepare(`
    SELECT COUNT(*) n,
      SUM(CASE WHEN verify='ok' THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN verify='mismatch' THEN 1 ELSE 0 END) bad,
      SUM(CASE WHEN verify LIKE 'skipped%' OR verify='no_level' THEN 1 ELSE 0 END) skip
    FROM recon_pool_change WHERE env=? AND ts >= ?
  `).get(env, sinceMs) as { n: number; ok: number; bad: number; skip: number }
  const a = db.prepare(`
    SELECT COUNT(*) n,
      SUM(CASE WHEN eqSelfOk=0 OR eqBasevalueOk=0 OR eqPoolOk=0 THEN 1 ELSE 0 END) bad
    FROM recon_jp_award WHERE env=? AND ts >= ?
  `).get(env, sinceMs) as { n: number; bad: number }
  const m = db.prepare(`
    SELECT COUNT(DISTINCT machineName) machines, COUNT(*) levels,
      SUM(CASE WHEN resolvedBy='observed' THEN 1 ELSE 0 END) observed
    FROM recon_machine_map WHERE env=?
  `).get(env) as { machines: number; levels: number; observed: number }
  return {
    poolRows: p?.n ?? 0, poolOk: p?.ok ?? 0, poolMismatch: p?.bad ?? 0, poolSkipped: p?.skip ?? 0,
    awards: a?.n ?? 0, awardsBad: a?.bad ?? 0,
    machines: m?.machines ?? 0, levels: m?.levels ?? 0,
    observed: m?.observed ?? 0, configOnly: (m?.levels ?? 0) - (m?.observed ?? 0),
  }
}

/**
 * ── 獎池水位（對帳台第一區的資料來源）─────────────────────────────────────────
 *
 * 🚨 **水位一律用設定的 `maxValue` 算，不看獎池名稱。**
 *    `GRAND-JJBXGOLD 70M` 的「70M」是 **basevalue**（歸零後的起始值），
 *    實際上限是 9,999,999,999。2026-09-08 我拿名稱當上限判斷過一次「已超出」，
 *    結論完全相反——使用者當場糾正。名稱是人取的，不是資料。
 *
 * 同一個 levelName 可能掛在很多台機器上（JPBZZF3 有 42 台），池是共用的，
 * 所以這裡**依 levelName 收斂成一列**，機台數另外列出來。
 */
export type PoolLevelRow = {
  levelName: string
  machineCount: number
  sampleMachine: string
  current: number | null
  maxValue: number | null
  basevalue: number | null
  incrementPercent: number | null
  /** 目前池值占設定上限的百分比。maxValue 缺就是 null——**不要用 0 代替**。 */
  waterPct: number | null
  atCap: boolean
  mismatch: number
  samples: number
  /** 這個獎池底下有沒有「使用者現在正在跑」的機台。有的話排最上面並標色。 */
  mine: boolean
  /** 我的哪幾台屬於這個池——標色時要標對是哪一台，不能只標代表機。 */
  myMachines: string[]
}

/**
 * @param myGmids 使用者現在正在跑的機台（gmid）。這些機台所屬的獎池會排在最上面
 *   並標色——使用者要的是「我這次在測的池怎麼樣」，其他池是背景資訊。
 *   ⚠️ 空集合時退回原本的嚴重度排序，不做任何特殊處理。
 */
export function jpPoolLevels(env: ReconEnv, sinceMs: number, myGmids: Set<string> = new Set()): PoolLevelRow[] {
  const maps = db.prepare(
    'SELECT machineName, levelName, incrementPercent, basevalue, maxValue FROM recon_machine_map WHERE env=?'
  ).all(env) as { machineName: string; levelName: string; incrementPercent: number | null; basevalue: number | null; maxValue: number | null }[]

  // 每個 (機台, level) 的最新池值——池是共用的，取任一台的最新值即可代表這個 level
  const latest = db.prepare(`
    SELECT machineName, levelName, after_ AS cur, ts FROM recon_pool_change p
    WHERE env=? AND ts=(SELECT MAX(ts) FROM recon_pool_change q
                        WHERE q.env=p.env AND q.levelName=p.levelName AND q.machineName=p.machineName)
    GROUP BY machineName, levelName
  `).all(env) as { machineName: string; levelName: string; cur: number; ts: number }[]
  const latestByKey = new Map(latest.map(r => [`${r.machineName}|${r.levelName}`, r]))

  const agg = db.prepare(`
    SELECT levelName, SUM(CASE WHEN verify='mismatch' THEN 1 ELSE 0 END) bad, COUNT(*) n
    FROM recon_pool_change WHERE env=? AND ts >= ? GROUP BY levelName
  `).all(env, sinceMs) as { levelName: string; bad: number; n: number }[]
  const aggByLevel = new Map(agg.map(a => [a.levelName, a]))

  const byLevel = new Map<string, PoolLevelRow>()
  for (const m of maps) {
    const key = m.levelName
    const seen = byLevel.get(key)
    const lat = latestByKey.get(`${m.machineName}|${m.levelName}`)
    const isMine = myGmids.has(m.machineName)
    if (!seen) {
      const a = aggByLevel.get(key)
      const cur = lat?.cur ?? null
      const max = Number.isFinite(m.maxValue as number) && (m.maxValue as number) > 0 ? m.maxValue : null
      byLevel.set(key, {
        mine: isMine, myMachines: isMine ? [m.machineName] : [],
        levelName: key, machineCount: 1, sampleMachine: m.machineName,
        current: cur, maxValue: max, basevalue: m.basevalue,
        incrementPercent: m.incrementPercent,
        waterPct: cur !== null && max ? (cur / max) * 100 : null,
        // ⚠️ 判「滿頂」用實際數值比對設定上限，不是靠 verify='skipped_overflow'——
        //    那個狀態的字面意思是「這筆沒驗」，不是「池滿了」。
        atCap: cur !== null && max ? cur >= max : false,
        mismatch: a?.bad ?? 0, samples: a?.n ?? 0,
      })
    } else {
      seen.machineCount++
      if (isMine) {
        seen.mine = true
        if (!seen.myMachines.includes(m.machineName)) seen.myMachines.push(m.machineName)
        // ⚠️ 代表機優先顯示「我的那台」——這個池可能掛 43 台，
        //    顯示別人的機台代碼對使用者沒有意義。
        seen.sampleMachine = m.machineName
      }
      // 取有值的那一台當代表；已經有值就不覆蓋
      if (seen.current === null && lat) {
        seen.current = lat.cur
        if (seen.maxValue) {
          seen.waterPct = (lat.cur / seen.maxValue) * 100
          seen.atCap = lat.cur >= seen.maxValue
        }
      }
    }
  }
  return [...byLevel.values()].sort((a, b) => {
    // ⚠️ **「我正在跑的」排在最前面，優先於嚴重度**（使用者要求）。
    //    有 2 台就是最上面 2 個、3 台就 3 個——因為那是他這次在測的東西，
    //    別台的池再嚴重也是背景資訊。同為「我的」時才回到嚴重度排序。
    if (a.mine !== b.mine) return a.mine ? -1 : 1
    // 有問題的排前面：滿頂 → 有不符 → 水位高的
    if (a.atCap !== b.atCap) return a.atCap ? -1 : 1
    if ((a.mismatch > 0) !== (b.mismatch > 0)) return a.mismatch > 0 ? -1 : 1
    return (b.waterPct ?? -1) - (a.waterPct ?? -1)
  })
}

/**
 * 增減值不符的逐筆明細，**帶「可能原因」**。
 *
 * 🚨 只寫「加太多 10,409」會讓人去追一筆不存在的超發。
 *    實測 7 筆不符**全部**是投入額變成負值（meter 重置／中獎歸零）造成的——
 *    公式拿投入額差推預期增額，負的投入額會推出負的預期值，差額自然很大。
 *    **原因欄不是裝飾，是防止誤判的必要資訊。**
 */
export type PoolMismatchRow = {
  ts: number; machineName: string; levelName: string
  coinIn: number; expected: number | null; actual: number; delta: number | null
  before: number; basevalue: number | null
  cause: 'coinin_negative' | 'at_basevalue' | 'unknown'
}

export function poolMismatches(env: ReconEnv, sinceMs: number, limit = 50): PoolMismatchRow[] {
  const rows = db.prepare(`
    SELECT p.ts, p.machineName, p.levelName, p.oldcoinin, p.newcoinin, p.before_, p.change_, p.verifyDelta,
           m.incrementPercent, m.basevalue
    FROM recon_pool_change p
    LEFT JOIN recon_machine_map m ON m.env=p.env AND m.machineName=p.machineName AND m.levelName=p.levelName
    WHERE p.env=? AND p.verify='mismatch' AND p.ts >= ?
    ORDER BY p.ts DESC LIMIT ?
  `).all(env, sinceMs, limit) as Record<string, number | string | null>[]

  return rows.map(r => {
    const coinIn = (r.newcoinin as number) - (r.oldcoinin as number)
    const incr = r.incrementPercent as number | null
    const before = r.before_ as number
    const base = r.basevalue as number | null
    return {
      ts: r.ts as number,
      machineName: String(r.machineName), levelName: String(r.levelName),
      coinIn,
      expected: incr !== null ? coinIn * incr : null,
      actual: r.change_ as number,
      delta: r.verifyDelta as number | null,
      before, basevalue: base,
      // ⚠️ 順序有意義：投入額倒退是最強的解釋，優先於「池值剛好在 basevalue」
      cause: coinIn < 0 ? 'coinin_negative'
        : (base !== null && Math.abs(before - base) < 1) ? 'at_basevalue'
          : 'unknown',
    }
  })
}

// ─── 逐筆明細：每一次投注把池推高了多少 ──────────────────────────────────
//
// 🚨 **「累積增額」跟「池淨變化」是兩個數，一定要分開列。**
//    累積增額 = 這個窗內每一筆 change_ 加總（投注推上去的量）
//    池淨變化 = 最後一筆的 after − 第一筆的 before（池實際移動了多少）
//    兩者相等時才是「只有投注、沒有別的事」；**差很多代表中間發生過中獎歸零
//    或溢流**，而那是使用者最需要知道的事。只給一個數字會把這件事藏起來。
//
// ⚠️ 池是**整個 Level 共用**的：同一個池上可能掛 43 台，別人打的也會推高它。
//    所以這裡一定要標明「這份明細涵蓋哪幾台」——只看自己的機台時，
//    累積增額**本來就會小於池淨變化**，那不是誤差。

export interface PoolChangeRow {
  ts: number
  machineName: string
  levelName: string
  /** 這一筆的投入額變化（newcoinin − oldcoinin）。負值＝meter 倒退（重置） */
  coinIn: number
  /** 這一筆池增加了多少 */
  change: number
  before: number
  after: number
  /** 從這個窗的第一筆算到這一筆為止的累積增額 */
  cumulative: number
  /** ok / mismatch / skipped_overflow / unknown_reason */
  verify: string
  verifyDelta: number | null
  reason: string
  /**
   * 這一筆是哪一局推的。
   *
   * 🚨 **池變動報表裡沒有局號**（欄位只有 levelid/machineid/coinin/before/change/
   *    after/reqmd5/reason…），所以這是**我們配上去的**，不是報表自己帶的。
   *    配不出來時一律 null，**不猜**——見 `joinNote`。
   */
  orderId: string | null
  spinIndex: number | null
  /** 配到的那一局的 `bet_time_precise` 與池變動時間差（ms），留著給事後校準用 */
  joinDelta: number | null
  /** matched / no_round（窗內沒有我們拉到的局）/ ambiguous（不只一局，不猜） */
  joinNote: 'matched' | 'no_round' | 'ambiguous'
  /**
   * 池變動報表自己的請求雜湊。**一次投注對每個 Level 各寫一筆、共用同一個 reqmd5**，
   * 所以即使配不到局號，靠它仍然分得出「這幾列是同一筆投注」。
   */
  reqmd5: string
}

export interface PoolDetail {
  levelName: string
  /** 這份明細實際涵蓋的機台 */
  machines: string[]
  /** 窗內總筆數（`rows` 可能只給最近幾筆） */
  total: number
  rows: PoolChangeRow[]
  /** 每一筆 change 的加總 */
  sumChange: number
  /** 最後一筆 after − 第一筆 before */
  netMove: number | null
  /** 有幾筆投入額是倒退的（meter 重置），這種筆數多時 sumChange 不可信 */
  negativeCoinIn: number
  mismatch: number
  incrementPercent: number | null
  firstTs: number | null
  lastTs: number | null
  /** 配到局號的筆數 */
  joined: number
  /** 窗內有 >1 局可選、因此不配的筆數 */
  joinAmbiguous: number
  /** 合理性檢查窗（ms）。⚠️ **這不是配對鍵**——鍵是投入額計數器，見 buildRoundJoin */
  joinSanityMs: number
  /** 每一段的配對診斷。配不出局號時，原因在這裡（遠端環境也查得到） */
  segments: SegmentDiag[]
}

/**
 * 池變動 ↔ 後台局號的配對。
 *
 * 🚨 **不要用時間配。**（2026-09-21 實測推翻了第一版）
 *
 *    第一版用「同機台 ± 750ms 內恰好一局」，而且我還「量」過：命中的時間差
 *    中位 10ms、p99 398ms，看起來非常漂亮。**那是選擇效應**——我只量了
 *    「已經配上的那些」的時間差，配不上的根本沒進統計。
 *
 *    把同一段用**順序**配對（233 筆池變動 ↔ 233 局，兩邊筆數完全相等、
 *    每一對的 coinIn 差都等於該局的 bet）再看時間差，真相是：
 *        中位 **−11,628ms**、min −18,761ms、p95 +17ms
 *        233 對裡有 **195 對**根本不在 ±750ms 內
 *    也就是說池變動的時間戳比 `bet_time_precise` **早約 12 秒**（兩個後台的
 *    時鐘／記錄時點不同）。結果第一版時間法「唯一命中 198 對，其中只有 37 對
 *    跟順序配對一致」——**其餘整段偏移一格**，而且每一筆看起來都正常。
 *    這正是這個專案一再踩到的那種錯：配錯的結果長得跟配對的一樣。
 *
 * ✅ **真正的鍵是投入額計數器**，不是時間：
 *      池變動的 `newcoinin`（機台累計投入額）
 *      後台該局的 `total_bet`（累計下注）
 *    兩者在同一段期間內**只差一個常數**（實測同一台一小時內只有 3 個值，
 *    換值的時點就是 `total_bet` 歸零重算的時候）。
 *    用它查表是**精確**的：對得上就是對得上，對不上就老實說對不上。
 *
 * ⚠️ 時間只留作**合理性檢查**（±SANITY_MS），不當鍵——它的作用只是擋掉
 *    「不同段剛好撞到同一個 total_bet」，不是用來挑最近的那一局。
 */
/**
 * 段的時間邊界往外放寬多少。
 * ⚠️ 這**不是配對鍵**，只用來決定「這一筆池變動屬於哪一段」——
 *    段長是分鐘等級，而兩邊時間戳差約 12 秒，這個粒度很安全。
 */
const SEGMENT_MARGIN_MS = 120_000
/** 一個 offset 至少要被幾筆支持才採用，避免拿雜訊當段落 */

/** 一段的配對診斷（不參與判定，只為了查得出「為什麼沒有局號」） */
export interface SegmentDiag {
  gmid: string; from: number; to: number
  rounds: number; poolRows: number
  offset: number | null; hits: number
  /** ok / no_overlap / ambiguous_offset:a/b / low_hits:h/n / unresolved */
  reason: string
}

interface JoinedRound { orderId: string; spinIndex: number | null; betTimePrecise: number; totalBet: number }

/**
 * 一「段」＝ `total_bet` 從頭累計的一次連續期間（重新進機台就會歸零重算）。
 * offset 只在段內是常數，所以所有推導都要先分段。
 */
interface MeterSegment {
  rounds: JoinedRound[]           // 依時間排序
  from: number; to: number        // betTimePrecise 範圍
  offset: number | null           // newcoinin − total_bet；推不出來就 null（整段不配）
  byTotalBet: Map<number, JoinedRound[]>
  /** 這一段涵蓋到幾筆池變動、offset 對上幾筆、推不出來的原因——診斷用，不參與判定 */
  poolCount: number
  hits: number
  reason: string
}

function buildRoundJoin(env: ReconEnv, poolRows: Record<string, number | string | null>[], sinceMs: number) {
  const empty = () => ({ orderId: null, spinIndex: null, delta: null, note: 'no_round' as const })
  const gmids = [...new Set(poolRows.map(r => String(r.machineName)).filter(Boolean))]
  if (!gmids.length) return { lookup: empty, segments: [] as SegmentDiag[] }

  const raw = db.prepare(`
    SELECT orderId, gmid, spinIndex, betTimePrecise, raw FROM recon_backend_record
    WHERE env=? AND betTimePrecise IS NOT NULL AND betTimePrecise >= ?
      AND gmid IN (${gmids.map(() => '?').join(',')})
    ORDER BY betTimePrecise ASC
  `).all(env, sinceMs - SEGMENT_MARGIN_MS, ...gmids) as
    { orderId: string; gmid: string; spinIndex: number | null; betTimePrecise: number; raw: string }[]

  // ── ① 依 total_bet 歸零切段 ────────────────────────────────────────────
  const segsByGmid = new Map<string, MeterSegment[]>()
  for (const r of raw) {
    let totalBet = NaN
    try { totalBet = Number(JSON.parse(r.raw)?.total_bet) } catch { /* 壞掉的 raw 當沒有 */ }
    if (!Number.isFinite(totalBet)) continue
    const round: JoinedRound = {
      orderId: r.orderId, spinIndex: r.spinIndex, betTimePrecise: r.betTimePrecise, totalBet,
    }
    const list = segsByGmid.get(r.gmid) ?? []
    const cur = list[list.length - 1]
    // total_bet 沒有往上走 ＝ 換了一段（重新進機台後從頭累計）
    if (!cur || totalBet <= cur.rounds[cur.rounds.length - 1].totalBet) {
      list.push({ rounds: [round], from: round.betTimePrecise, to: round.betTimePrecise,
        offset: null, byTotalBet: new Map(), poolCount: 0, hits: 0, reason: '' })
    } else {
      cur.rounds.push(round); cur.to = round.betTimePrecise
    }
    segsByGmid.set(r.gmid, list)
  }

  // ── ② 每一段推 offset ─────────────────────────────────────────────────
  //
  // 🚨 **offset 不可以用「時間最近的那一局」去推。**（2026-09-21 實測，這是第二次踩到）
  //    池的時間戳比 `bet_time_precise` 早約 12 秒，用時間找到的「最近一局」
  //    系統性地是**前一局**，推出來的 offset 就整段偏一個注額，
  //    而偏掉之後每一筆**照樣查得到值**（total_bet 是等差的），所以看起來完全正常。
  //
  // ✅ 改用**名次配對**推：段內的池列與局若筆數相同、且兩邊都依各自的計數器單調遞增，
  //    第 i 筆就對第 i 局。再要求「每一對算出來的 offset 都是同一個值」——
  //    這一條是**自我驗證**：配錯的話 offset 會散掉，不會剛好全部相同。
  //    不相同就整段不配（寧可留白，不要給一個看起來正常的錯局號）。
  for (const [gmid, segs] of segsByGmid) {
    const rows = poolRows.filter(r => String(r.machineName) === gmid)
      .map(r => ({ ts: Number(r.ts), newcoinin: Number(r.newcoinin ?? 0) }))
      .sort((a, b) => a.ts - b.ts)
    for (const seg of segs) {
      for (const r of seg.rounds) {
        const l = seg.byTotalBet.get(r.totalBet); if (l) l.push(r); else seg.byTotalBet.set(r.totalBet, [r])
      }
      const mine = rows.filter(r => r.ts >= seg.from - SEGMENT_MARGIN_MS && r.ts <= seg.to + SEGMENT_MARGIN_MS)
      seg.poolCount = mine.length
      if (!mine.length || !seg.rounds.length) { seg.reason = 'no_overlap'; continue }

      /**
       * 🚨 **第一版要求「池列數 == 局數」才推 offset，那太脆了。**（2026-09-21 實測）
       *    後台紀錄是每 15 秒增量拉的，**跑測當下一定會有幾局還沒拉到**——
       *    只要差一筆，整段就推不出 offset，畫面上變成**一筆局號都沒有**
       *    （使用者回報：16 筆配到 0 筆，而同一台的回填率顯示 90%）。
       *    「少幾筆」跟「對不起來」被混成同一種結果，而它們完全不同。
       *
       * ✅ 改用**兩端錨點**：段內第一筆與最後一筆各推一次 offset。
       *      candMin = 最小 newcoinin − 最小 total_bet
       *      candMax = 最大 newcoinin − 最大 total_bet
       *    兩端一致 → 兩邊都對得齊，採用。
       *    不一致 → 有一端缺資料（多半是尾端的局還沒拉到），改用「命中比較多」的那個；
       *    還是分不出來就留 null，**不猜**。
       *
       * ⚠️ 為什麼不能只用一端：`total_bet` 是等差的，offset 偏一個注額之後
       *    **每一筆照樣查得到值**，只有在序列的端點才露餡。只看一端就等於沒驗。
       */
      /**
       * ⚠️ **只看頭尾兩個錨點不夠。**（2026-09-21 第二次修）
       *    池記的是**整台機台**的投注，後台紀錄只有我們這個帳號的局——
       *    所以段內常常是「池 18 筆、局 10 筆」。這時頭尾錨點兩邊都落空
       *    （實測那幾段 hits 都是 0），只好整段留白，而那些段其實是配得出來的。
       *
       * ✅ 改成**掃候選再取最高命中**：候選 = 頭尾各取幾筆池列與局兩兩相減。
       *    真正的 offset 會讓「我們的局」全部對上，錯的 offset 只會零星命中——
       *    因為混進來的別人那幾筆會把等差數列打亂，這反而讓鑑別力變強。
       *    ⚠️ 仍然要求**最高的那個要比第二高的多**：並列就代表分不出來，不猜。
       */
      const hits = (off: number) => mine.filter(r => seg.byTotalBet.has(r.newcoinin - off)).length
      const SAMPLE = 6
      const coins = [...mine.slice(0, SAMPLE), ...mine.slice(-SAMPLE)].map(r => r.newcoinin)
      const bets = [...seg.rounds.slice(0, SAMPLE), ...seg.rounds.slice(-SAMPLE)].map(r => r.totalBet)
      const cands = [...new Set(coins.flatMap(c => bets.map(b => c - b)))]

      /**
       * 🚨 **命中數常常會打平，而那代表「真的分不出來」，不是缺一個聰明的規則。**
       *
       *    實測（2026-09-21，本機與使用者現場都一樣）：池裡混進**不是我們的注**時
       *    （池 81 筆 / 我們的局 75 筆），`newcoinin − total_bet` **根本不是常數**——
       *    每來一筆別人的注，offset 就 +一個注額。所以「找一個常數 offset」這個模型
       *    在那種段落上本來就不成立，命中數打平只是這件事的表徵。
       *
       *    ⚠️ 我試過用時間的一致性當平手裁判（取離散度最小的候選），**實測沒有鑑別力**：
       *       兩個候選的離散度是 15,844ms vs 15,971ms、12,000ms vs 16,359ms——都是雜訊。
       *       也試過用時間投票估每段偏移再做單調配對，票數 6:6、5:4，而且已知正確的那幾段
       *       反而只配到 58/66。**兩種都不寫進來**：看起來聰明但分不出來的規則，
       *       只會把「不知道」包裝成「知道」。
       *
       *    所以這裡就停在誠實的位置：打平就留白，並把原因寫清楚讓人看得懂
       *    （下面的 reason 會帶出池列數與局數，那個差額本身就是有用的訊息）。
       */
      let best = 0, bestOff: number | null = null, second = 0
      for (const off of cands) {
        const h = hits(off)
        if (h > best) { second = best; best = h; bestOff = off }
        else if (h > second) second = h
      }
      if (bestOff === null || best === 0) { seg.reason = 'no_candidate'; continue }
      if (best === second) {
        // ⚠️ 兩個方向的成因完全不同，不要混成同一句：
        //    池多 → 有別人的注（offset 會被推著走，常數模型不成立）
        //    池少 → 池變動還沒拉齊（等一下可能就好了，不是資料錯）
        seg.reason = mine.length > seg.rounds.length
          ? `mixed_bets:池 ${mine.length} 筆 / 我們的局 ${seg.rounds.length} 筆`
          : mine.length < seg.rounds.length
            ? `pool_behind:池 ${mine.length} 筆 / 我們的局 ${seg.rounds.length} 筆`
            : 'ambiguous_offset'
        continue
      }
      // 至少要有一定比例對得上，否則這個 offset 根本不成立。
      // ⚠️ 分母用「池列數與局數的較小者」——池多出來的那幾筆本來就不是我們的局，
      //    拿池的總數當分母會把「其實全中」誤判成「命中太少」。
      const need = Math.max(3, Math.ceil(Math.min(mine.length, seg.rounds.length) * 0.5))
      if (best >= need) { seg.offset = bestOff; seg.hits = best }
      else seg.reason = `low_hits:${best}/${Math.min(mine.length, seg.rounds.length)}`
    }
  }

  // ── ③ 查表：鍵是計數器，時間只用來挑「這一筆屬於哪一段」 ──────────────
  /**
   * 🚨 **每一段都要交代「offset 推出來了沒、為什麼」。**
   *    沒有這個的話，畫面上「一筆局號都沒有」有三種完全不同的原因
   *    （後台還沒拉到／兩端對不齊／根本沒有這台的局）長得一模一樣，
   *    而且**遠端環境查不了**——使用者回報時只能靠猜。
   */
  const segments: SegmentDiag[] = []
  for (const [gmid, segs] of segsByGmid) {
    for (const seg of segs) {
      segments.push({
        gmid, from: seg.from, to: seg.to, rounds: seg.rounds.length,
        poolRows: seg.poolCount, offset: seg.offset, hits: seg.hits,
        reason: seg.offset === null ? (seg.reason || 'unresolved') : 'ok',
      })
    }
  }

  const lookup = (gmid: string, ts: number, newcoinin: number) => {
    const segs = segsByGmid.get(gmid)
    if (!segs?.length) return empty()
    const inRange = segs.filter(s => ts >= s.from - SEGMENT_MARGIN_MS && ts <= s.to + SEGMENT_MARGIN_MS)
    const hits: JoinedRound[] = []
    for (const seg of inRange) {
      if (seg.offset === null) continue
      for (const r of seg.byTotalBet.get(newcoinin - seg.offset) ?? []) {
        if (!hits.some(h => h.orderId === r.orderId)) hits.push(r)
      }
    }
    if (hits.length === 1) {
      return { orderId: hits[0].orderId, spinIndex: hits[0].spinIndex,
        delta: ts - hits[0].betTimePrecise, note: 'matched' as const }
    }
    return { orderId: null, spinIndex: null, delta: null,
      note: (hits.length ? 'ambiguous' : 'no_round') as 'ambiguous' | 'no_round' }
  }

  return { lookup, segments }
}

export function poolChangeDetail(
  env: ReconEnv, sinceMs: number, levelName: string,
  opts: { machines?: string[]; limit?: number } = {},
): PoolDetail {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000)
  const machines = (opts.machines ?? []).filter(Boolean)
  // ⚠️ 機台清單走參數化展開，不要拼字串——machineName 來自外部查詢字串
  const machineClause = machines.length
    ? ` AND p.machineName IN (${machines.map(() => '?').join(',')})` : ''
  const all = db.prepare(`
    SELECT p.ts, p.machineName, p.levelName, p.oldcoinin, p.newcoinin,
           p.before_, p.change_, p.after_, p.verify, p.verifyDelta, p.reason, p.reqmd5
    FROM recon_pool_change p
    WHERE p.env=? AND p.levelName=? AND p.ts >= ?${machineClause}
    ORDER BY p.ts ASC, p.id ASC
  `).all(env, levelName, sinceMs, ...machines) as Record<string, number | string | null>[]

  const { lookup: join, segments } = buildRoundJoin(env, all, sinceMs)

  let running = 0
  const rows: PoolChangeRow[] = all.map(r => {
    const change = Number(r.change_ ?? 0)
    running += change
    const hit = join(String(r.machineName), Number(r.ts), Number(r.newcoinin ?? 0))
    return {
      ts: Number(r.ts), machineName: String(r.machineName), levelName: String(r.levelName),
      coinIn: Number(r.newcoinin ?? 0) - Number(r.oldcoinin ?? 0),
      change, before: Number(r.before_ ?? 0), after: Number(r.after_ ?? 0),
      cumulative: running,
      verify: String(r.verify ?? ''), verifyDelta: r.verifyDelta as number | null,
      reason: String(r.reason ?? ''),
      orderId: hit.orderId, spinIndex: hit.spinIndex, joinDelta: hit.delta, joinNote: hit.note,
      reqmd5: String(r.reqmd5 ?? ''),
    }
  })

  const incr = db.prepare(
    'SELECT incrementPercent FROM recon_machine_map WHERE env=? AND levelName=? AND incrementPercent IS NOT NULL LIMIT 1'
  ).get(env, levelName) as { incrementPercent: number } | undefined

  return {
    levelName,
    machines: [...new Set(rows.map(r => r.machineName))],
    total: rows.length,
    // 只回最近 limit 筆，但 `cumulative` 是從窗的第一筆算起的**真值**，不是這幾筆的小計
    rows: rows.slice(-limit),
    sumChange: running,
    netMove: rows.length ? rows[rows.length - 1].after - rows[0].before : null,
    negativeCoinIn: rows.filter(r => r.coinIn < 0).length,
    mismatch: rows.filter(r => r.verify === 'mismatch').length,
    incrementPercent: incr?.incrementPercent ?? null,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: rows.length ? rows[rows.length - 1].ts : null,
    joined: rows.filter(r => r.joinNote === 'matched').length,
    joinAmbiguous: rows.filter(r => r.joinNote === 'ambiguous').length,
    joinSanityMs: SEGMENT_MARGIN_MS,
    segments,
  }
}

// ─── 跨環境稽核：機台掛錯獎池 ────────────────────────────────────────────
//
// 🚨 **這是「會消失」而不是「會標紅」的一類問題。**
//
// 機台↔獎池的對應是**從 `poolChangeReport` 反推**的（見 `upsertMachineMap`，
// 因為 `egmList` 兩個環境都回 0 筆）。所以一台 QAT 機台若實際掛在 UAT 的池上：
//   · 它的池變動只會出現在 **UAT 後台**的報表裡
//   · QAT 這邊的 `recon_machine_map` 根本不會生出它那一列
//   · 結果是**整台機器從 QAT 的獎池矩陣上消失**，不是被標成異常
// 反向同理，UAT 那邊會多出一台「不認識的機台」。
//
// ⚠️ 原本的設計是靠 `resolvedBy='config'`（設定說掛著、報表卻沒出現）來抓，
//    但**沒有任何資料源可以當「設定」**：`egmList` 回 0 筆，`jp_groups` 只到環境層級
//    （3 筆：PROD/QAT/UAT），沒有機台↔獎池的對應。實測 184 筆 `resolvedBy` 全是
//    `observed`，一筆 `config` 都沒有——那條路等於不存在。
//
//    所以改用**不需要設定檔的推論**：兩個環境都拉之後，「在哪個環境看得到它的池變動」
//    本身就是事實，拿它跟「在哪個環境按過 spin」對照即可。

export type MachineEnvIssue = 'both_envs' | 'env_mismatch' | 'no_pool' | 'blank_name'

export interface MachineEnvRow {
  machineName: string
  /** 這台在哪些環境有觀測到池變動 */
  poolEnvs: ReconEnv[]
  /** 這台在哪些環境有 spin 觀測（我們實際在打的環境） */
  spinEnvs: ReconEnv[]
  lastPoolAt: number | null
  lastSpinAt: number | null
  /**
   * 每個環境**各自**的最後池變動時間。
   *
   * ⚠️ 這是 `both_envs` 能不能被讀懂的關鍵。只給一個 `poolEnvs: ['qat','uat']`
   *    的話，「真的同時掛兩邊」跟「三天前從 UAT 搬到 QAT」長得一模一樣，
   *    而後者是完全正常的操作。兩邊各自的時間擺出來，這件事自己會說話：
   *      qat 2 分鐘前 / uat 1 分鐘前  → 真的同時掛著
   *      qat 2 分鐘前 / uat 3 天前    → 搬過來的
   */
  lastPoolByEnv: Partial<Record<ReconEnv, number>>
  issue: MachineEnvIssue
  severity: 'critical' | 'warn' | 'info'
  note: string
}

/**
 * 人看得懂的時間長度。給告警文案用，不做在地化。
 *
 * ⚠️ **時間點與時間長度要分開。**「10 天前」（時間點）跟「相隔 10 天」（長度）
 *    是兩件事，共用同一個函式就會寫出「相隔 10.0 天前」這種讀不通的句子——
 *    這是實際發生過的，測試的輸出欄把它顯示出來才看到。
 */
function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} 秒`
  if (s < 5400) return `${Math.round(s / 60)} 分鐘`
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} 小時`
  return `${(s / 86400).toFixed(1)} 天`
}

/** 相對於現在的時間點。 */
function agoText(ms: number): string { return `${durationText(ms)}前` }

/**
 * 跨環境機台稽核。**不吃 env 參數**——它要看的就是「跨環境」，
 * 傳 env 進來等於又把兩個世界隔開，那正是問題本身。
 *
 * ⚠️ `no_pool` 是 **warn 不是 critical**：SAS 機台本來就沒有 LuckyLink 連線
 *    （`sasversion` 是 `sas` 不是 `g2s`），把它報成 critical 會讓真正的錯誤被埋掉。
 *    要分辨是「SAS 本來就沒有」還是「該掛卻沒掛上」，得靠 SLS 那條線（見 L6）。
 */
export function machineEnvAudit(sinceMs: number, now = Date.now()): MachineEnvRow[] {
  const pool = db.prepare(`
    SELECT machineName, env, MAX(ts) lastAt FROM recon_pool_change
    WHERE ts >= ? GROUP BY machineName, env
  `).all(sinceMs) as { machineName: string; env: ReconEnv; lastAt: number }[]
  const spin = db.prepare(`
    SELECT gmid AS machineName, env, MAX(observedAt) lastAt FROM recon_spin
    WHERE observedAt >= ? AND gmid IS NOT NULL AND gmid != '' GROUP BY gmid, env
  `).all(sinceMs) as { machineName: string; env: ReconEnv; lastAt: number }[]

  const by = new Map<string, MachineEnvRow>()
  const touch = (name: string): MachineEnvRow => {
    let r = by.get(name)
    if (!r) {
      r = { machineName: name, poolEnvs: [], spinEnvs: [], lastPoolAt: null, lastSpinAt: null,
        lastPoolByEnv: {}, issue: 'no_pool', severity: 'info', note: '' }
      by.set(name, r)
    }
    return r
  }
  for (const p of pool) {
    const r = touch(p.machineName)
    if (!r.poolEnvs.includes(p.env)) r.poolEnvs.push(p.env)
    r.lastPoolAt = Math.max(r.lastPoolAt ?? 0, p.lastAt)
    r.lastPoolByEnv[p.env] = Math.max(r.lastPoolByEnv[p.env] ?? 0, p.lastAt)
  }
  for (const s of spin) {
    const r = touch(s.machineName)
    if (!r.spinEnvs.includes(s.env)) r.spinEnvs.push(s.env)
    r.lastSpinAt = Math.max(r.lastSpinAt ?? 0, s.lastAt)
  }

  const out: MachineEnvRow[] = []
  for (const r of by.values()) {
    // ⚠️ 空字串的 machineName 是資料問題，不是機台。實測 recon_machine_map 裡真的有一筆。
    //    不報出來的話它會一直混在統計裡，讓每一個分母都多算一台。
    if (!r.machineName.trim()) {
      out.push({ ...r, issue: 'blank_name', severity: 'warn',
        note: '池變動報表回了空的 machineName——資料問題，會讓每個分母多算一台' })
      continue
    }
    if (r.poolEnvs.length > 1) {
      const seen = r.poolEnvs
        .map(e => `${e.toUpperCase()} ${agoText(now - (r.lastPoolByEnv[e] ?? 0))}`)
        .join('、')
      /**
       * ⚠️ **兩邊最後一次變動差很久 = 搬過環境，不是同時掛著。**
       *    搬機台是正常操作；報成 critical 會製造穩定的假警報，而假警報一多，
       *    真的「同時掛兩邊」就會被一起忽略掉。
       *    門檻用 6 小時：兩邊都還在動的機台不可能差這麼久。
       */
      const stamps = r.poolEnvs.map(e => r.lastPoolByEnv[e] ?? 0)
      const spread = Math.max(...stamps) - Math.min(...stamps)
      const moved = spread > 6 * 3600_000
      out.push({ ...r,
        issue: 'both_envs',
        severity: moved ? 'warn' : 'critical',
        note: moved
          ? `兩個環境都有池變動，但相隔 ${durationText(spread)}（${seen}）`
            + '——比較像是機台搬過環境，不是同時掛著。要確認的是舊環境那邊已經解除掛載'
          : `同一台機台在 ${seen} 都有池變動`
            + '——一台實體機台只會連一個獎池伺服器，兩邊同時都在動代表環境設定有問題' })
      continue
    }
    if (r.spinEnvs.length && r.poolEnvs.length
      && !r.spinEnvs.some(e => r.poolEnvs.includes(e))) {
      out.push({ ...r, issue: 'env_mismatch', severity: 'critical',
        note: `在 ${r.spinEnvs.join('／').toUpperCase()} 打局，但池變動出現在 `
          + `${r.poolEnvs.join('／').toUpperCase()}——機台掛到另一個環境的獎池` })
      continue
    }
    if (r.spinEnvs.length && !r.poolEnvs.length) {
      out.push({ ...r, issue: 'no_pool', severity: 'warn',
        note: '有在打局，但兩個環境都查不到它的池變動'
          + '——可能是 SAS 機台（本來就沒有 LuckyLink），也可能是該掛卻沒掛上' })
    }
  }
  // critical 在前，同級照最後活動時間新的在前
  const rank = { critical: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]
    || (b.lastSpinAt ?? b.lastPoolAt ?? 0) - (a.lastSpinAt ?? a.lastPoolAt ?? 0))
}

/**
 * 兩個環境的獎池矩陣合在一起，每一列自己帶 env 標籤。
 *
 * ⚠️ 這就是「把 env 從全域過濾器降級成每列標籤」那一步。原本每一支查詢都是
 *    `WHERE env=?`，兩個環境是兩個平行世界，畫面一次只看得到一邊——
 *    而跨環境掛錯**只有把兩邊擺在一起才看得出來**。
 */
export function jpMatrixAllEnvs(sinceMs: number): (JpPoolRow & { env: ReconEnv })[] {
  const out: (JpPoolRow & { env: ReconEnv })[] = []
  for (const env of ['qat', 'uat'] as const) {
    for (const row of jpMatrix(env, sinceMs)) out.push({ ...row, env })
  }
  return out
}

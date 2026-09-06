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

const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

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
    const from = wm > 0 ? wm - OVERLAP_SEC * 1000 : now - COLD_START_SEC * 1000
    const collected: LlPoolChange[] = []
    let failed = false
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await fetchPoolChanges(env, toIso(from), toIso(now + 60_000), '', page, PAGE_SIZE)
      if (!r.ok) {
        noteLlHealth(env, 'poolChangeReport', false, r.errKind, r.message)
        out.errors.push(`poolChangeReport 第 ${page} 頁：${r.message ?? r.errKind}`)
        failed = true; break
      }
      collected.push(...r.items)
      if (r.items.length < PAGE_SIZE) break
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
      let maxTs = wm
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
          if (t > maxTs) maxTs = t
        }
      })
      tx()
      // ⚠️ 沒有資料時不要把游標推到 now——那會把「還沒吐出來的那段」永久跳過
      if (maxTs > wm) writeWm(env, 'poolChangeReport', maxTs)
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

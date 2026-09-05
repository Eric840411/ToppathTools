/**
 * server/live-ledger-fetch.ts — Live Ledger P0 的「後台拉取迴圈」。
 *
 * 每 15 秒對每個作用中的 (env, 帳號) 增量拉一次 `gameRecordList`，落庫後跑一次序列對齊。
 *
 * ⚠️ 三條在這個專案上反覆踩過的規則，這裡全部適用：
 *
 * 1. **拿到 0 筆不等於「這段時間沒有局」。**（v4.89.0 後台對帳那次的教訓）
 *    設定沒建、token 失效、權限不足，全部長得跟「真的沒資料」一模一樣。
 *    所以每一輪都要把失敗原因結構化寫進 `recon_source_health`，不能只是回空陣列。
 *
 * 2. **watermark 要往回重疊一段再拉。**後台的 `bet_time_precise` 不保證即時可見，
 *    剛好卡在游標邊界的那幾筆會被永久跳過——而且不會有任何徵兆。
 *    重疊靠 upsert 去重，代價只是多拉幾筆。
 *
 * 3. **中途某一頁失敗一律整批放棄，不把「已抓到的幾頁」當結果。**
 *    那又是一份看不出殘缺的資料（v4.99.0 Jira 分頁那次同一個結論）。
 */
import { db } from './shared.js'
import { loadMeterConfig, meterPost } from './routes/meter-reconcile.js'
import {
  type ReconEnv, guardFetchedRows, noteSourceHealth,
  readWatermark, writeWatermark, upsertBackendRecords, reconSetting,
} from './live-ledger.js'

/** 後台設定的 profile。⚠️ qat/uat 跟 osm/gcp 是兩個不同的軸，不能混用。 */
const PROFILE_OF: Record<ReconEnv, 'osm' | 'gcp' | null> = {
  qat: 'osm',
  // ⚠️ UAT 目前**沒有**後台連線設定（meter_reconcile_config 只有 osm_/gcp_ 兩組，
  //    兩組都指向 QAT 的 backendservertest）。留 null 讓它明確回 missing_config，
  //    不要靜默回 0 筆——那正是 v4.89.0 修掉的那個坑。
  uat: null,
}

/** 每輪往回重疊的秒數（見檔頭第 2 點）。 */
const OVERLAP_SEC = 90
/** 第一次拉取時往回看多久——沒有 watermark 時的起點。 */
const COLD_START_SEC = 600
const PAGE_SIZE = 200
const MAX_PAGES = 20

export interface FetchOutcome {
  ok: boolean
  fetched: number
  upserted: number
  pages: number
  errKind?: string
  message?: string
  /** 撞到 MAX_PAGES 上限，**這一輪的結果是不完整的** */
  reachedLimit?: boolean
  /** 這一輪拉取涵蓋的時間範圍，寫進健康紀錄方便事後對照 */
  fromMs?: number
  toMs?: number
}

function isoOf(ms: number): string { return new Date(ms).toISOString() }

/**
 * 對單一 (env, 帳號) 拉一輪。
 *
 * `username` 是後台 `playerName` 的精準比對值，也是 `guardFetchedRows` 的期望值——
 * 兩者必須是同一個字串，否則守門會擋掉本來就該收的資料。
 */
export async function fetchBackendForScope(
  env: ReconEnv, username: string, now = Date.now(),
): Promise<FetchOutcome> {
  const source = 'gameRecordList'
  if (!username) {
    const o: FetchOutcome = {
      ok: false, fetched: 0, upserted: 0, pages: 0, errKind: 'no_username',
      message: '沒有帳號可用來過濾——多半是 Game URL 是 url-pool 中轉網址而沒有解開',
    }
    noteSourceHealth(env, source, false, o.errKind, o.message)
    return o
  }

  const profile = PROFILE_OF[env]
  if (!profile) {
    const o: FetchOutcome = {
      ok: false, fetched: 0, upserted: 0, pages: 0, errKind: 'missing_config',
      message: `${env.toUpperCase()} 沒有後台連線設定，無法查詢（不是「這段時間沒有局」）`,
    }
    noteSourceHealth(env, source, false, o.errKind, o.message)
    return o
  }

  const cfg = loadMeterConfig(profile)
  if (!cfg.base_url && !cfg.login_username) {
    const o: FetchOutcome = {
      ok: false, fetched: 0, upserted: 0, pages: 0, errKind: 'missing_config',
      message: `${profile} 後台連線設定是空的，請先到「Performance Meter 對帳」頁設定`,
    }
    noteSourceHealth(env, source, false, o.errKind, o.message)
    return o
  }

  const wm = readWatermark(env, source, username)
  const fromMs = wm > 0 ? wm - OVERLAP_SEC * 1000 : now - COLD_START_SEC * 1000
  // 上界刻意用 now + 1 分鐘：後台的時間戳可能比我們的時鐘快一點，卡死在 now 會漏掉最新那幾筆
  const toMs = now + 60_000

  const collected: Record<string, unknown>[] = []
  let pages = 0
  let reachedLimit = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      clientMachineName: '', playerId: '', playerName: username, orderId: '',
      page: String(page), pageSize: String(PAGE_SIZE),
      dateTimeType: '0',
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL',
      bgType: profile === 'gcp' ? '2' : '0', dataType: '0', isall: 'false',
      channelId: cfg.channel_id || '873',
    })
    params.append('dateTime[]', isoOf(fromMs))
    params.append('dateTime[]', isoOf(toMs))

    let data: any
    try {
      data = await meterPost(profile, cfg, '/egm/reports/gameRecordList', params)
    } catch (e) {
      // 見檔頭第 3 點：整批放棄，不回傳已抓到的部分
      const o: FetchOutcome = {
        ok: false, fetched: 0, upserted: 0, pages,
        errKind: 'network_error', message: `第 ${page} 頁查詢失敗：${e}`, fromMs, toMs,
      }
      noteSourceHealth(env, source, false, o.errKind, o.message)
      return o
    }
    if (data?.code && data.code !== 20000) {
      const o: FetchOutcome = {
        ok: false, fetched: 0, upserted: 0, pages,
        errKind: data.code === 40200 ? 'auth_failed' : 'api_error',
        message: `後台回 code=${data.code}（第 ${page} 頁）`, fromMs, toMs,
      }
      noteSourceHealth(env, source, false, o.errKind, o.message)
      return o
    }
    const items: Record<string, unknown>[] = data?.data?.items ?? data?.data?.list ?? []
    pages = page
    collected.push(...items)
    const total = Number(data?.data?.total ?? 0)
    if (items.length < PAGE_SIZE) break
    if (total > 0 && collected.length >= total) break
    if (page === MAX_PAGES) reachedLimit = true
  }

  // ⚠️ 守門一定要在落庫之前。對到別人的帳號時整批丟掉，不是「過濾掉那幾筆」——
  //    出現別人的資料代表過濾條件根本沒生效，這批的其餘部分同樣不可信。
  const guard = guardFetchedRows(collected, username)
  if (!guard.ok) {
    noteSourceHealth(env, source, false, guard.errKind, guard.message)
    return {
      ok: false, fetched: collected.length, upserted: 0, pages,
      errKind: guard.errKind, message: guard.message, fromMs, toMs,
    }
  }

  // guard 回傳的已經是正規化後的列，不要再 normalize 一次。
  // `raw` 用 orderId 對回原始那筆保留下來——出事時沒有原始回應根本查不動，
  // 而 BackendRound 只留了對齊需要的欄位。
  const rawByOrderId = new Map<string, unknown>()
  for (const it of collected) {
    const oid = String((it as Record<string, unknown>).order_id ?? '')
    if (oid) rawByOrderId.set(oid, it)
  }
  const rows = guard.rows.filter((r): r is NonNullable<typeof r> => !!r)
  const upserted = rows.length
    ? upsertBackendRecords(env, rows.map(r => ({
        orderId: r.orderId, gmid: r.gmid, playerId: r.playerId,
        bet: r.bet, win: r.win,
        // dateTime 就用 bet_time_precise（已是 epoch ms）——這張表的時間軸要跟對齊用的
        // 同一個，兩個欄位各取一個來源會讓「查得到卻對不上」變得無法解釋
        dateTime: r.betTimePrecise,
        spinIndex: r.spinIndex, betTimePrecise: r.betTimePrecise,
        username, raw: rawByOrderId.get(r.orderId) ?? null,
      })), { field: 'playerName', value: username })
    : 0

  // watermark 前進到「這一輪看到的最大時間戳」，不是 now——後台還沒吐出來的那段
  // 下一輪要重新涵蓋到。沒有資料時維持原游標，不要往前跳。
  //
  // ⚠️ **撞到分頁上限時一律不前進 watermark。**這支 API 是「新到舊」排序，
  //    截斷截掉的是**較舊**的那段（實測：查 7 天回 4000 筆／20 頁，只涵蓋最新 8 小時）。
  //    這時把游標推到最大時間戳，等於把中間沒抓到的那段**永久跳過**，
  //    而且之後完全查不出來少了什麼——跟 v4.99.0 Jira 分頁那次同一個坑。
  if (rows.length && !reachedLimit) {
    const maxTs = Math.max(...rows.map(r => r.betTimePrecise))
    if (maxTs > wm) writeWatermark(env, source, maxTs, username)
  }
  if (reachedLimit) {
    noteSourceHealth(env, source, false, 'truncated',
      `這一輪撞到分頁上限（${MAX_PAGES} 頁／${collected.length} 筆），結果不完整；` +
      '游標未前進，下一輪會重拉同一段。查詢範圍過大時才會發生，穩態下不應出現。')
  } else {
    noteSourceHealth(env, source, true)
  }
  return { ok: !reachedLimit, fetched: collected.length, upserted, pages, reachedLimit, fromMs, toMs }
}

/**
 * 目前「還需要拉取」的 (env, 帳號)。
 *
 * ⚠️ 刻意從 `recon_spin` 反推，不去讀 agentSessions 的記憶體狀態：
 *    ① worker 重啟後 agentSessions 可能還沒復原，但 DB 裡的觀測還在
 *    ② session 結束後還要再拉一段時間（寬限期）把 PENDING 收乾淨，
 *       只看「還在跑的 session」會讓最後那批永遠停在 PENDING
 */
export function activeScopes(now = Date.now()): Array<{ env: ReconEnv; username: string }> {
  const graceMs = Math.max(reconSetting('qat', 'sessionGraceSec'), 60) * 1000
  const rows = db.prepare(`
    SELECT DISTINCT env, note FROM recon_spin
    WHERE observedAt >= ? AND note IS NOT NULL AND note != ''
  `).all(now - graceMs) as { env: string; note: string }[]
  const out = new Map<string, { env: ReconEnv; username: string }>()
  for (const r of rows) {
    const m = /username=([^;\s]+)/.exec(r.note || '')
    if (!m) continue
    const env = (r.env === 'uat' ? 'uat' : 'qat') as ReconEnv
    out.set(`${env}|${m[1]}`, { env, username: m[1] })
  }
  return [...out.values()]
}

// ─── 迴圈驅動 ─────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * 「有 spin 嘗試，但後台一局都沒有」的診斷。
 *
 * ⚠️ 這個形狀**不是「後台掉單」**，而且把它報成掉單會把人導去查完全錯的地方。
 *    2026-09-05 實際發生過：AutoSpin 連續 29 小時按了 16,573 次 spin，
 *    每一發都回 `errcode 25 该玩家已经不在机器上了`——**一局都沒有成立**，
 *    因為進場流程誤判、實際上是以旁觀者身分坐在那裡按。
 *
 *    那種情況下對帳看到的就是 MISSING 接近 100%。要是文案寫「後台掉單」，
 *    使用者會去翻後台，而問題根本在進場那一端。
 */
export function diagnoseAllMissing(env: ReconEnv, sinceMs: number): { level: 'ok' | 'warn' | 'alert'; message?: string } {
  const r = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN status='MISSING' THEN 1 ELSE 0 END) missing,
           SUM(CASE WHEN status='MATCH'   THEN 1 ELSE 0 END) matched
    FROM recon_spin WHERE env=? AND observedAt >= ?
  `).get(env, sinceMs) as { total: number; missing: number; matched: number }
  // 樣本太少不下結論——剛開跑時本來就會全部 PENDING
  if (!r || r.total < 20) return { level: 'ok' }
  if (r.matched > 0) return { level: 'ok' }
  const ratio = (r.missing || 0) / r.total
  if (ratio < 0.9) return { level: 'ok' }
  return {
    level: 'alert',
    message: `${r.missing}/${r.total} 筆完全對不到後台紀錄，且一筆都沒配對成功。`
      + `**請先確認機台真的有成局**（agent 日誌裡看得到 errcode 25「该玩家已经不在机器上了」`
      + `就代表沒有真的入座，spin 全部沒起局），不是後台掉單。`,
  }
}

/** 跑一輪：所有作用中的 (env, 帳號) 各拉一次，然後每個 env 跑一次序列對齊。 */
export async function runLiveLedgerCycle(now = Date.now()): Promise<{
  scopes: number; fetched: number; upserted: number; failures: number
  bind: Record<string, { scanned: number; resolved: number; ambiguous: number; missing: number }>
}> {
  const { runBindCycle } = await import('./live-ledger.js')
  const scopes = activeScopes(now)
  let fetched = 0, upserted = 0, failures = 0
  const envs = new Set<ReconEnv>()
  for (const s of scopes) {
    const r = await fetchBackendForScope(s.env, s.username, now)
    fetched += r.fetched; upserted += r.upserted
    if (!r.ok) failures++
    envs.add(s.env)
  }
  const bind: Record<string, { scanned: number; resolved: number; ambiguous: number; missing: number }> = {}
  for (const env of envs) {
    const b = runBindCycle(env, now)
    bind[env] = { scanned: b.scanned, resolved: b.resolved, ambiguous: b.ambiguous, missing: b.missing }
    const diag = diagnoseAllMissing(env, now - 3600_000)
    if (diag.level === 'alert') noteSourceHealth(env, 'bind', false, 'all_missing', diag.message)
  }
  return { scopes: scopes.length, fetched, upserted, failures, bind }
}

/**
 * 啟動背景迴圈。⚠️ 用「上一輪跑完才排下一輪」而不是固定 setInterval——
 * 後台慢的時候固定間隔會讓多輪疊在一起，對同一個後台同時發好幾份查詢。
 */
export function startLiveLedgerLoop(): void {
  if (timer) return
  const tick = async () => {
    if (running) return
    running = true
    try {
      const r = await runLiveLedgerCycle()
      if (r.scopes > 0) {
        console.log(`[live-ledger] scopes=${r.scopes} fetched=${r.fetched} upserted=${r.upserted}`
          + ` failures=${r.failures} bind=${JSON.stringify(r.bind)}`)
      }
    } catch (e) {
      console.warn('[live-ledger] 迴圈失敗:', e)
    } finally {
      running = false
      const sec = Math.max(reconSetting('qat', 'fetchIntervalSec') || 15, 5)
      timer = setTimeout(tick, sec * 1000)
    }
  }
  timer = setTimeout(tick, 5_000)
  console.log('[live-ledger] 背景拉取迴圈已啟動')
}

export function stopLiveLedgerLoop(): void {
  if (timer) { clearTimeout(timer); timer = null }
}

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

/**
 * ⚠️ `dateTime[]` 一定要用 **ISO-Z**（`toISOString()`）。
 *    空白分隔的 `YYYY-MM-DD HH:mm:ss` 會被後端當**本地時間（UTC+8）**解讀，
 *    拿 UTC 值去填就會查到 0 筆——而且不報錯，看起來就像「這段時間沒有局」。
 *    兩種格式不能混用。
 */
function isoOf(ms: number): string { return new Date(ms).toISOString() }

/**
 * 從 gmid 前綴推通道（`897-BIGFULINK-2065` → `897`）。
 *
 * ⚠️ **不能全域寫死一個 channelId。**實測 897 那台的局用 873 去查一定查不到，
 *    結果是每一筆都變 MISSING——看起來像「全部掉單」，其實是查錯通道。
 */
/** 預設走全通道模式。設成 false 會退回「由 gmid 推單一通道」的舊行為。 */
const CHANNEL_ALL_MODE = process.env.LIVE_LEDGER_CHANNEL_ALL !== 'false'

export function channelOfGmid(gmid: string, dflt: string): string {
  const m = /^(\d{3,4})-/.exec(gmid || '')
  return m ? m[1] : dflt
}

/**
 * 對單一 (env, 帳號) 拉一輪。
 *
 * `username` 是後台 `playerName` 的精準比對值，也是 `guardFetchedRows` 的期望值——
 * 兩者必須是同一個字串，否則守門會擋掉本來就該收的資料。
 */
export async function fetchBackendForScope(
  env: ReconEnv, username: string, now = Date.now(), gmid = '',
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
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,dy,ALL',
      bgType: profile === 'gcp' ? '2' : '0', dataType: '0',
      // ⚠️ **跨通道要用 `isall=true` + `channelId=0`，不是逐機台換 channelId。**
      //    實測（同一組憑證，同一台 897-BIGFULINK-2065）：
      //      isall=false + channelId=897 → code 40501 權限不足
      //      isall=true  + channelId=0   → code 20000、total=28、拿得到 897 的局
      //    逐機台換 channelId 反而會撞權限——方向對、做法錯，這是實測推翻的。
      isall: 'true',
      // `0` 代表全通道。`channelOfGmid()` 留著當 fallback——萬一某個環境不吃 `0`，
      // 至少還能退回單一通道查詢，而不是整個查不到。
      channelId: CHANNEL_ALL_MODE ? '0' : channelOfGmid(gmid, cfg.channel_id || '873'),
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
        errKind: data.code === 40200 ? 'auth_failed'
          : (data.code === 40501 || data.code === 403) ? 'no_channel_permission' : 'api_error',
        // ⚠️ 通道權限不足要跟「掉單」分得出來——實測後台帳號只有 873 的權限，
        //    用它查 897 的機台會什麼都查不到，於是每一筆都變 MISSING。
        //    **正解是去要通道權限，不是查金流。**說錯原因會讓人往完全錯的方向查。
        message: (data.code === 40501 || data.code === 403)
          ? `後台帳號沒有通道 ${channelOfGmid(gmid, cfg.channel_id || '873')} 的權限（code=${data.code}）`
            + '——這個通道的對帳結果不可用，不是掉單'
          : `後台回 code=${data.code}（第 ${page} 頁）`, fromMs, toMs,
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
export function activeScopes(now = Date.now()): Array<{ env: ReconEnv; username: string; gmid: string }> {
  const graceMs = Math.max(reconSetting('qat', 'sessionGraceSec'), 60) * 1000
  const rows = db.prepare(`
    SELECT DISTINCT env, note, gmid FROM recon_spin
    WHERE observedAt >= ? AND note IS NOT NULL AND note != ''
  `).all(now - graceMs) as { env: string; note: string; gmid: string }[]
  const out = new Map<string, { env: ReconEnv; username: string; gmid: string }>()
  for (const r of rows) {
    const m = /username=([^;\s]+)/.exec(r.note || '')
    if (!m) continue
    const env = (r.env === 'uat' ? 'uat' : 'qat') as ReconEnv
    out.set(`${env}|${m[1]}`, { env, username: m[1], gmid: r.gmid || '' })
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
  // ⚠️ 通道權限不足時**不能報成掉單**。查不到那個通道的資料當然全部 MISSING，
  //    但正解是去要權限，不是查金流——說錯原因會讓人往完全錯的方向查。
  const perm = db.prepare(`SELECT message FROM recon_source_health
    WHERE env=? AND source='gameRecordList' AND errKind='no_channel_permission'`).get(env) as { message: string } | undefined
  if (perm) {
    return { level: 'warn', message: `這個區間的對帳結果**不可用**：${perm.message}。` +
      '畫面上的掉單數字在權限補齊之前沒有意義。' }
  }
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
/**
 * 時鐘量測**不能掛在拉取路徑上**。
 *
 * ⚠️ 第一版把它放在「跑完所有 scope 之後」，而 `activeScopes()` 是從 `recon_spin`
 *    反推的——沒有壓測在跑就沒有 scope，於是**時鐘從來沒被量過**，
 *    `recon_source_health` 裡連 `clock` 那一列都不存在。
 *    我清單上標「已串」但 DB 裡沒有資料可以佐證，是規格方核對時抓到的。
 *
 *    時鐘偏移跟「有沒有在壓測」無關，健康列應該隨時都看得到它——
 *    今天那 94 秒如果只有壓測時才量得到，等於還是要靠人記得去查。
 */
const CLOCK_PROBE_INTERVAL_MS = 5 * 60_000
/** JP 池／中獎不依賴有沒有壓測在跑（池是整個群組共用的），所以獨立節奏。 */
const JP_CYCLE_INTERVAL_MS = 60_000
let lastJpCycle = 0
let lastClockProbe = 0

export async function runLiveLedgerCycle(now = Date.now()): Promise<{
  scopes: number; fetched: number; upserted: number; failures: number
  bind: Record<string, { scanned: number; resolved: number; ambiguous: number; missing: number }>
}> {
  const { runBindCycle } = await import('./live-ledger.js')
  // 時鐘量測獨立於有沒有 scope——每 5 分鐘一次
  if (now - lastClockProbe >= CLOCK_PROBE_INTERVAL_MS) {
    lastClockProbe = now
    for (const env of ['qat', 'uat'] as const) await probeServerClock(env)
  }

  // L4/L5：JP 池與中獎。跟 scope 無關——池是整個群組共用的，不是我們的 spin 才有。
  if (now - lastJpCycle >= JP_CYCLE_INTERVAL_MS) {
    lastJpCycle = now
    const { runJpCycle } = await import('./live-ledger-jp.js')
    for (const env of ['qat'] as const) {
      try {
        const j = await runJpCycle(env, now)
        if (j.poolStored || j.awardStored || j.errors.length) {
          console.log(`[live-ledger] JP ${env} 池 ${j.poolStored}/${j.poolFetched}` +
            ` 不符 ${j.poolMismatch} · 中獎 ${j.awardStored} 異常 ${j.awardBad}` +
            (j.errors.length ? ` · ${j.errors[0]}` : ''))
        }
      } catch (e) { console.warn('[live-ledger] JP 迴圈失敗:', e) }
    }
  }

  const scopes = activeScopes(now)
  let fetched = 0, upserted = 0, failures = 0
  const envs = new Set<ReconEnv>()
  for (const s of scopes) {
    const r = await fetchBackendForScope(s.env, s.username, now, s.gmid)
    fetched += r.fetched; upserted += r.upserted
    if (!r.ok) failures++
    envs.add(s.env)
  }
  /**
   * ⚠️ **綁定／撤銷／未觀測掃描不能只在「有壓測在跑」時執行。**
   *
   * 這些工作處理的正是「事情已經發生、但還沒收斂」的狀態：晚到的後台紀錄要回綁、
   * 誤判的 unobserved 要撤銷。而 `activeScopes()` 只認最近 5 分鐘有觀測的帳號——
   * session 一結束就什麼都不做了，**該撤銷的誤報永遠掛在那裡**。
   * 實測：9 筆「已綁上卻還標成未觀測」就是這樣卡住的。
   *
   * 跟時鐘量測那次同一個坑：把維護性的工作掛在「有活動」的條件下，
   * 活動停止時它就再也不會收斂。
   */
  const envsToProcess = new Set<ReconEnv>(envs)
  for (const env of ['qat', 'uat'] as const) {
    const has = db.prepare(`SELECT 1 FROM recon_spin WHERE env=? AND observedAt >= ? LIMIT 1`)
      .get(env, now - 12 * 3600_000)
    if (has) envsToProcess.add(env)
  }

  const bind: Record<string, { scanned: number; resolved: number; ambiguous: number; missing: number }> = {}
  for (const env of envsToProcess) {
    // ⚠️ **一定要在 runBindCycle 之前**：那 1 筆「一局沒起卻綁到後台單」的錯誤綁定
    //    要先解開，正主才有機會在這一輪配到那張單。放後面的話正主要多等一輪。
    const { cleanupNonRoundFindings } = await import('./live-ledger.js')
    const cleaned = cleanupNonRoundFindings(env)
    if (cleaned.resolved || cleaned.unbound) {
      console.log(`[live-ledger] ${env} 收拾沒起注的誤報：撤銷告警 ${cleaned.resolved} 筆、`
        + `解除錯誤綁定 ${cleaned.unbound} 筆`)
    }
    const b = runBindCycle(env, now)
    // 綁定完才有兩側金額可比。L1/L2 只看已 MATCH 的列。
    const { compareAmounts, findUnobservedRounds, recordUnobservedFindings, resolveBoundUnobserved } = await import('./live-ledger.js')
    // ⚠️ 先把「後來綁上了」的誤報撤銷，再掃新的——順序反過來會讓剛撤銷的又被記一次。
    const undone = resolveBoundUnobserved(env)
    if (undone) console.log(`[live-ledger] ${env} 撤銷 ${undone} 筆「有單無 spin」誤報（後來綁上了）`)
    // 🚨 反向檢查：後台有局但前端沒觀測到。**這個方向原本完全看不到**——
    //    資料流是 spin-driven，沒有 spin 的局根本不會進入任何查詢。
    const unobs = findUnobservedRounds(env, now - 6 * 3600_000, now)
    const newUnobs = unobs.length ? recordUnobservedFindings(env, unobs) : 0
    if (newUnobs) console.log(`[live-ledger] ${env} 後台有局但前端未觀測：新增 ${newUnobs} 筆（總計 ${unobs.length}）`)
    const amt = compareAmounts(env, now - 6 * 3600_000)
    if (amt.l1Bad || amt.l2Bad) {
      console.log(`[live-ledger] ${env} 金額比對：檢查 ${amt.checked} 筆，L1 不符 ${amt.l1Bad}、L2 不符 ${amt.l2Bad}`)
    }
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
  // 一次性回填：findings 機制上線前就判定的 MISSING／AMBIGUOUS 補記錄，
  // 否則「近期告警 0」會跟「真的沒問題」長得一樣。
  void import('./live-ledger.js').then(m => {
    for (const env of ['qat', 'uat'] as const) {
      const n = m.backfillFindings(env)
      if (n) console.log(`[live-ledger] ${env} 回填 ${n} 筆既有 finding`)
    }
  }).catch(e => console.warn('[live-ledger] finding 回填失敗:', e))
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

/**
 * 量本機與後台 web 的時鐘差（HTTP `Date` header）。
 *
 * ⚠️ **只做觀測，絕對不參與配對校正。**實測 2026-09-05：
 *    Date header 偏移 +93 秒，而 `bet_time_precise − observedAt` 的偏移是 +29 秒，
 *    **兩者差 64.5 秒**——`bet_time_precise` 跟後台 web 不是同一個時鐘。
 *    拿這個值去校正配對，會比不校正更錯。
 *
 * 留著的理由：它不需要提權就量得到，而且 > 5 秒就該示警——
 * 那 94 秒如果早就顯示在畫面上，我們不會查到最後才發現。
 */
export async function probeServerClock(env: ReconEnv): Promise<number | null> {
  const profile = PROFILE_OF[env]
  if (!profile) return null
  const cfg = loadMeterConfig(profile)
  const base = (cfg.base_url || '').replace(/\/$/, '')
  if (!base) return null
  try {
    const t0 = Date.now()
    const r = await fetch(base, { method: 'HEAD' })
    const t1 = Date.now()
    const d = r.headers.get('date')
    if (!d) return null
    const server = new Date(d).getTime()
    if (!Number.isFinite(server)) return null
    // 用往返中點當本機對照時間，把 RTT 的一半誤差抵掉
    const offset = Math.round(server - (t0 + t1) / 2)
    db.prepare(`
      INSERT INTO recon_source_health (env, source, failCount, clockOffsetMs, clockCheckedAt)
      VALUES (?, 'clock', 0, ?, ?)
      ON CONFLICT(env, source) DO UPDATE SET clockOffsetMs=excluded.clockOffsetMs,
        clockCheckedAt=excluded.clockCheckedAt
    `).run(env, offset, Date.now())
    return offset
  } catch { return null }
}

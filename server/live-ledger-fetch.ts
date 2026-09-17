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
 *
 * 4. 🚨 **「撞上限就不推水位」單獨存在的話是一個單向閥門。**（2026-09-17 實測到的死鎖）
 *    這支 API 是新到舊排序，截斷截掉的是較舊的那段，所以不推水位是對的。
 *    但舊版到此為止——下一輪仍然查 `[水位, now]`，窗只會**更大**，於是再度截斷。
 *    一旦停機夠久（實測 9/8 卡到 9/17，整整 9 天）就永遠出不來，而且
 *    `failCount` 只有 3、其他來源都正常更新，看起來完全不像壞掉。
 *    正解是**分段續抓**：把大窗切成段、從最舊的一段開始，每段完整抓完才推水位。
 *    提高 `MAX_PAGES` 或把水位跳到 now 都不行——前者只是把閥門推遠，
 *    後者會把中間那段永久跳過（同第 3 點的結論）。
 */
import { db } from './shared.js'
import { loadMeterConfig, meterPost } from './routes/meter-reconcile.js'
import {
  type ReconEnv, guardFetchedRows, noteSourceHealth,
  readWatermark, writeWatermark, upsertBackendRecords, reconSetting,
  nowOnObservedAxis,
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

/**
 * 一段最多涵蓋多久（見檔頭第 4 點）。
 *
 * 實測：查 7 天回 4000 筆／20 頁，只涵蓋**最新 8 小時**——也就是繁忙時段
 * 8 小時約略就會吃滿 4000 筆。取 4 小時是留一半餘裕；真的塞不下時
 * `fetchSegmented()` 會自己對半切，所以這個值保守一點不會有損失。
 */
export const SEGMENT_MS = 4 * 60 * 60_000
/**
 * 對半切的下限。切到比這還小仍然截斷，就**不是**「窗開太大」了——
 * 單一帳號 5 分鐘內不可能有 4000 局，那是過濾條件沒生效之類的真問題，
 * 要當異常報出來，不能無限切下去。
 */
export const MIN_SEGMENT_MS = 5 * 60_000
/**
 * 一輪最多補幾段，避免補歷史缺口時把單輪撐到好幾分鐘
 * （迴圈耗時監控會因此誤報，而且會擋住其他 scope 的拉取）。
 * 剩下的段下一輪接著補——水位已經前進，不會重來。
 */
export const MAX_SEGMENTS_PER_CYCLE = 12
/**
 * 「最新那一段」的寬限：上界比這個還新的段，即使抓到 0 筆也**不推水位**。
 *
 * ⚠️ 這是檔頭第 2 點的另一面。後台 `bet_time_precise` 不保證即時可見，
 *    剛成的局可能還沒吐出來；這時把水位推過去，那幾筆就被永久跳過了。
 *    而補歷史段（上界早於這個寬限）就必須推——否則 0 筆的空檔會讓游標
 *    永遠停在原地，正是 9/8 那次卡死的成因之一。
 */
export const SETTLE_MS = 2 * 60_000

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
  const { fromMs, toMs, nowSrv } = planFetchWindow(env, wm, now)

  return await fetchSegmented(env, source, username, wm, fromMs, toMs, nowSrv,
    (a, b) => fetchOneWindow(env, source, username, gmid, profile, cfg, a, b))
}

/**
 * 算出這一輪要涵蓋的時間窗。
 *
 * 🚨 **兩個時間軸不能混用。**`wm` 來自後台的 `betTimePrecise`，在**後台軸**上；
 * `now` 是本機的 `Date.now()`。實測 `recon_source_health.clockOffsetMs = 120100`
 * ——本機比後台**慢** 2 分鐘。
 *
 * 舊版上界寫死 `now + 60_000`，那個 `+60s` 原本是想補「後台時間戳可能比我們快一點」，
 * 但它是**猜的常數、不是量到的偏移**：實際偏移 120 秒時，上界等於「後台時間 − 60 秒」，
 * **最新一分鐘的局根本查不到**，接著被老化判定當成 MISSING。
 * 這正是「用推導出來的常數去檢查現實」那類錯誤——偏移已經每 5 分鐘量一次了，用量到的。
 *
 * ⚠️ 只換上界，**不動 `wm`**（它已經在後台軸上）——兩邊都加就是重複補償，
 * 窗會整個往未來平移，反而漏掉舊的那頭。
 */
export function planFetchWindow(env: ReconEnv, wm: number, now: number): {
  fromMs: number; toMs: number; nowSrv: number
} {
  const nowSrv = nowOnObservedAxis(env, now)
  return {
    nowSrv,
    fromMs: wm > 0 ? wm - OVERLAP_SEC * 1000 : nowSrv - COLD_START_SEC * 1000,
    // 換軸之後仍留 1 分鐘安全邊界：偏移是每 5 分鐘量一次的，兩次之間還會漂一點
    toMs: nowSrv + 60_000,
  }
}

/**
 * 抓**單一個窗**：分頁、守門、落庫。
 *
 * 刻意不碰 watermark、也不寫「成功」的健康紀錄——那要看整輪分段的結果才算數，
 * 是 `fetchSegmented()` 的責任。失敗原因仍然當場寫，否則錯誤會被上層吃掉。
 */
async function fetchOneWindow(
  env: ReconEnv, source: string, username: string, gmid: string,
  profile: 'osm' | 'gcp', cfg: ReturnType<typeof loadMeterConfig>,
  fromMs: number, toMs: number,
): Promise<FetchOutcome & { maxTs?: number }> {
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

  // ⚠️ **撞到分頁上限時這個窗的結果是不完整的**，`maxTs` 不可以拿去推水位。
  //    這支 API 是「新到舊」排序，截斷截掉的是**較舊**的那段（實測：查 7 天回
  //    4000 筆／20 頁，只涵蓋最新 8 小時）。把游標推到最大時間戳等於把中間沒抓到
  //    的那段**永久跳過**，而且之後完全查不出來少了什麼——跟 v4.99.0 Jira 分頁那次
  //    同一個坑。要怎麼處置交給 `fetchSegmented()`（它會把窗切小再試）。
  return {
    ok: !reachedLimit, fetched: collected.length, upserted, pages, reachedLimit, fromMs, toMs,
    maxTs: rows.length ? Math.max(...rows.map(r => r.betTimePrecise)) : undefined,
  }
}

/**
 * 把 `[fromMs, toMs]` 切成段逐段抓，**從最舊的一段開始**，每段完整抓完才推水位。
 *
 * 🚨 這支存在的理由就是檔頭第 4 點那個死鎖。關鍵不變量：
 *
 *   **水位只會前進到「已經確認完整抓完」的位置。**
 *
 * 所以任何一段只要截斷，就對半切重試；切到 `MIN_SEGMENT_MS` 還截斷，
 * 就停在那裡把剩下的留給下一輪，**不跳過、不硬推**。
 * 水位前進到哪裡，就代表那之前的資料是完整的——這條性質是後面所有對帳的地基，
 * 一旦為了「補快一點」而破例，`recon_backend_record` 就會多出一段沒人知道的空洞。
 */
export async function fetchSegmented(
  env: ReconEnv, source: string, username: string,
  wm: number, fromMs: number, toMs: number, nowSrv: number,
  fetchWindow: (fromMs: number, toMs: number) => Promise<FetchOutcome & { maxTs?: number }>,
): Promise<FetchOutcome> {
  let cursor = fromMs
  let segments = 0
  let fetched = 0
  let upserted = 0
  let pages = 0
  let stalled: FetchOutcome | null = null
  // ⚠️ 記住「這一輪切到多小才塞得下」，下一段直接從那個大小開始。
  //    每段都重新從 SEGMENT_MS 試，補 9 天就要多打幾百次註定截斷的請求
  //    ——那是實打實的後台負擔，而且每次都要等完 20 頁才知道失敗。
  //    刻意**不在輪內放大回去**：同一輪的時段密度通常差不多，
  //    而下一輪本來就會重新從 SEGMENT_MS 開始探，不會永久困在小窗。
  let effSpan = SEGMENT_MS

  while (cursor < toMs && segments < MAX_SEGMENTS_PER_CYCLE) {
    let span = Math.min(effSpan, toMs - cursor)
    let out: FetchOutcome & { maxTs?: number } | null = null

    // 這一段塞不下就對半切，直到放得下或觸到下限
    for (;;) {
      const segTo = Math.min(cursor + span, toMs)
      out = await fetchWindow(cursor, segTo)
      if (!out.ok && !out.reachedLimit) {
        // 網路／權限／守門失敗：`fetchOneWindow` 已經寫過健康紀錄，直接把原因帶回去
        return { ...out, fetched: fetched + out.fetched, upserted: upserted + out.upserted,
          pages: pages + out.pages, fromMs, toMs }
      }
      if (!out.reachedLimit) break
      if (span <= MIN_SEGMENT_MS) break
      span = Math.max(MIN_SEGMENT_MS, Math.floor(span / 2))
      effSpan = span
    }

    fetched += out.fetched; upserted += out.upserted; pages += out.pages
    const segTo = Math.min(cursor + span, toMs)

    if (out.reachedLimit) {
      // 切到下限還是滿的——這不是「窗開太大」，是這段時間內真的有異常多的資料
      // （或過濾條件沒生效）。停在這裡，水位不動，把它報成異常。
      stalled = {
        ok: false, fetched, upserted, pages, reachedLimit: true, errKind: 'truncated',
        message:
          `補抓卡在 ${isoOf(cursor)} ~ ${isoOf(segTo)}：窗已切到 ${Math.round(span / 60_000)} 分鐘`
          + `仍撞到分頁上限（${MAX_PAGES} 頁／${out.fetched} 筆）。`
          + '單一帳號這麼短時間內不該有這麼多局，比較像過濾條件沒生效——'
          + '水位停在此處不前進，這段之後的資料都還沒補。',
        fromMs, toMs,
      }
      break
    }

    // ⚠️ 推水位的兩種情況，差別在「0 筆」怎麼解讀（見 SETTLE_MS）：
    //    · 歷史段（上界早於寬限）完整抓完 → 即使 0 筆也推，那段是真的沒有局
    //    · 最新段 → 只有抓到東西才推，後台可能還沒把剛成的局吐出來
    const isHistorical = segTo < nowSrv - SETTLE_MS
    const advanceTo = isHistorical ? segTo : (out.maxTs ?? 0)
    if (advanceTo > wm) writeWatermark(env, source, advanceTo, username)

    cursor = segTo
    segments++
  }

  if (stalled) {
    noteSourceHealth(env, source, false, stalled.errKind!, stalled.message!)
    return stalled
  }

  const remaining = Math.max(0, toMs - cursor)
  if (remaining > 0) {
    // 還沒補完但這一輪的額度用完了。這**不是錯誤**——水位已經前進，下一輪接著補。
    // 仍然寫進健康紀錄，因為「畫面顯示正常但其實落後 3 天」正是要避免的那種安靜。
    noteSourceHealth(env, source, false, 'backfilling',
      `補抓進行中：這一輪補了 ${segments} 段到 ${isoOf(cursor)}，`
      + `還差 ${Math.round(remaining / 3600_000)} 小時才追上現在。下一輪繼續。`)
    return { ok: false, fetched, upserted, pages, errKind: 'backfilling',
      message: '補抓進行中，尚未追上現在', fromMs, toMs }
  }

  noteSourceHealth(env, source, true)
  return { ok: true, fetched, upserted, pages, fromMs, toMs }
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
  const t0 = Date.now()
  let jpMs = 0, fetchMs = 0, bindMs = 0, notifyMs = 0
  const { runBindCycle } = await import('./live-ledger.js')
  // 時鐘量測獨立於有沒有 scope——每 5 分鐘一次
  if (now - lastClockProbe >= CLOCK_PROBE_INTERVAL_MS) {
    lastClockProbe = now
    for (const env of ['qat', 'uat'] as const) await probeServerClock(env)
  }

  // L4/L5：JP 池與中獎。跟 scope 無關——池是整個群組共用的，不是我們的 spin 才有。
  if (now - lastJpCycle >= JP_CYCLE_INTERVAL_MS) {
    lastJpCycle = now
    const tJp = Date.now()
    const { runJpCycle } = await import('./live-ledger-jp.js')
    /**
     * 🚨 **UAT 也要拉（v4.170.1 起）。**
     *
     * ⚠️ 之前這裡寫死 `['qat']`，所以 UAT 的 LuckyLink **一筆資料都沒有**——
     *    machine_map 184 筆、pool_change 69,891 筆、award 17 筆全部是 qat。
     *    而畫面上「UAT 沒有資料」跟「UAT 沒有異常」長得一模一樣。
     *
     * ⚠️ 不要照抄 `PROFILE_OF[env]` 那個 null 判斷——那是 **OSM 後台**的設定
     *    （UAT 確實沒有），**LuckyLink 是另一條線**，兩個環境都有 base URL
     *    （`lib/luckylink-recon.ts` 的 `BASE`）。2026-09-17 實測兩邊都登得進去、
     *    `fetchLevels` 各回得了資料。把兩者混為一談就會繼續把 UAT 關在門外。
     *
     * 這一步同時是「機台掛錯獎池」偵測的前置：兩個環境都有資料，
     * 才看得出「QAT 的機台其實掛在 UAT 的池上」——見 `machineEnvAudit()`。
     */
    for (const env of ['qat', 'uat'] as const) {
      try {
        const j = await runJpCycle(env, now)
        if (j.poolStored || j.awardStored || j.errors.length) {
          console.log(`[live-ledger] JP ${env} 池 ${j.poolStored}/${j.poolFetched}` +
            ` 不符 ${j.poolMismatch} · 中獎 ${j.awardStored} 異常 ${j.awardBad}` +
            (j.errors.length ? ` · ${j.errors[0]}` : ''))
        }
      } catch (e) { console.warn('[live-ledger] JP 迴圈失敗:', e) }
    }
    jpMs = Date.now() - tJp
  }

  const scopes = activeScopes(now)
  const tFetch = Date.now()
  let fetched = 0, upserted = 0, failures = 0
  const envs = new Set<ReconEnv>()
  for (const s of scopes) {
    const r = await fetchBackendForScope(s.env, s.username, now, s.gmid)
    fetched += r.fetched; upserted += r.upserted
    if (!r.ok) failures++
    envs.add(s.env)
  }
  fetchMs = Date.now() - tFetch
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
  const tBind = Date.now()
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

  /**
   * 🚨 **告警送出：兩個環境都跑，而且不掛在 `envsToProcess` 底下。**
   *
   * ⚠️ 第一版寫在上面那個迴圈裡面，那是這個檔案已經踩過兩次的同一個坑
   *    （時鐘量測、綁定撤銷，檔案裡都留著當時的註解）：
   *    **把維護性的工作掛在「最近有活動」的條件下，活動一停就再也不會收斂。**
   *    `envsToProcess` 只認最近 12 小時有觀測的 env——壓測結束超過 12 小時後，
   *    還沒送出去的告警會永遠卡在佇列裡，而且畫面上看不出來。
   *
   * 順序上一定要在所有撤銷邏輯（`cleanupNonRoundFindings` / `resolveBoundUnobserved`）
   * 之後：放前面會把這一輪正要被撤銷的誤報先發出去，人跑去查卻發現畫面上沒有那筆，
   * 比不發還糟。真正擋假警報的是通知端自己的靜置期（`notifyGraceSec`）——
   * 實測 missing 2,936 筆有 2,807 筆後來自己解決了，不等就送 96% 是假的。
   */
  bindMs = Date.now() - tBind

  const tNotify = Date.now()
  for (const env of ['qat', 'uat'] as const) {
    try {
      const { runNotifyCycle } = await import('./live-ledger-notify.js')
      const n = await runNotifyCycle(env, now)
      if (n.failed) console.warn(`[live-ledger] ${env} 告警送出失敗：${n.failed}`)
    } catch (e) { console.warn('[live-ledger] 告警迴圈失敗:', e) }
  }
  notifyMs = Date.now() - tNotify

  recordCycleStat({
    at: t0, totalMs: Date.now() - t0, fetchMs, bindMs, jpMs, notifyMs,
    scopes: scopes.length, fetched, failures,
  })
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

// ─── 迴圈自身的可觀測性 ──────────────────────────────────────────────────
//
// 🚨 **拉取是 serial 的**（`for (const s of scopes) await fetchBackendForScope(...)`），
//    所以單輪耗時 ≈ 帳號數 × RTT。30 台約 9~15 秒就吃滿 15 秒的間隔。
//
//    真正危險的是它跟 `pendingTimeoutSec`（90 秒）的交互：單輪耗時一旦拉長，
//    **晚到的後台紀錄還沒被拉回來，spin 就先被判 MISSING** → 假掉單暴增。
//    而這種失效長得跟「真的掉單」一模一樣，沒有這些數字就沒有任何徵兆。

/** 保留的樣本數。這是診斷用的環形紀錄，不是歷史檔案。 */
const CYCLE_STAT_KEEP = 500
/**
 * 單輪耗時超過 `pendingTimeoutSec` 的幾分之一就示警。
 *
 * ⚠️ 用比例不用固定秒數——門檻本來就可調，寫死一個秒數的話，
 *    使用者把 pendingTimeout 調小之後這盞燈就再也不會亮。
 */
const CYCLE_WARN_RATIO = 1 / 3

/**
 * 示警門檻。**只有這一個地方算**。
 *
 * ⚠️ 第一版在 `recordCycleStat()` 與 `cycleStats()` 各算了一次同一件事——
 *    突變測試當場抓到：把其中一邊改成固定 60 秒，「告警門檻」那條斷言照樣綠，
 *    因為它讀的是另一邊。兩份會各自漂移，而畫面上顯示的門檻跟實際示警用的
 *    門檻不同步，是最難查的一種 bug（看板說 30 秒、實際 60 秒才亮）。
 */
export function cycleWarnLimitMs(): number {
  return reconSetting('qat', 'pendingTimeoutSec') * 1000 * CYCLE_WARN_RATIO
}

export function recordCycleStat(s: {
  at: number; totalMs: number; fetchMs: number; bindMs: number; jpMs: number
  notifyMs: number; scopes: number; fetched: number; failures: number
}): void {
  try {
    db.prepare(`
      INSERT INTO recon_cycle_stat (at, totalMs, fetchMs, bindMs, jpMs, notifyMs, scopes, fetched, failures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.at, s.totalMs, s.fetchMs, s.bindMs, s.jpMs, s.notifyMs, s.scopes, s.fetched, s.failures)
    db.prepare(`
      DELETE FROM recon_cycle_stat WHERE id NOT IN (
        SELECT id FROM recon_cycle_stat ORDER BY at DESC LIMIT ?
      )
    `).run(CYCLE_STAT_KEEP)

    // ⚠️ 只在**真的有東西要拉**的輪次示警。沒有 scope 的輪次本來就很快，
    //    把它們算進來會讓平均數永遠漂亮，剛好蓋掉壓測時的那幾輪。
    if (s.scopes > 0) {
      const limitMs = cycleWarnLimitMs()
      if (s.totalMs > limitMs) {
        noteSourceHealth('qat', 'cycle', false, 'slow_cycle',
          `單輪耗時 ${(s.totalMs / 1000).toFixed(1)} 秒（${s.scopes} 個帳號，拉取 ${(s.fetchMs / 1000).toFixed(1)} 秒）`
          + `——超過掉單門檻的 1/3，再長下去晚到的紀錄會來不及回綁，**會開始出現假掉單**`)
      } else {
        noteSourceHealth('qat', 'cycle', true)
      }
    }
  } catch (e) {
    // ⚠️ 觀測失敗不能拖垮被觀測的東西
    console.warn('[live-ledger] 迴圈統計寫入失敗:', e)
  }
}

export interface CycleStats {
  samples: number
  lastMs: number | null
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number | null
  lastScopes: number | null
  /** 拉取占單輪的比例——接近 1 就代表瓶頸在 serial 拉取，該做合併查詢 */
  fetchShare: number | null
  warnAtMs: number
}

/** 近期迴圈耗時。⚠️ 只看有 scope 的輪次，見 `recordCycleStat` 的說明。 */
export function cycleStats(limit = 200): CycleStats {
  const warnAtMs = cycleWarnLimitMs()
  try {
    const rows = db.prepare(`
      SELECT totalMs, fetchMs, scopes FROM recon_cycle_stat
      WHERE scopes > 0 ORDER BY at DESC LIMIT ?
    `).all(limit) as { totalMs: number; fetchMs: number; scopes: number }[]
    if (!rows.length) {
      return { samples: 0, lastMs: null, p50Ms: null, p95Ms: null, maxMs: null, lastScopes: null, fetchShare: null, warnAtMs }
    }
    const sorted = [...rows].sort((a, b) => a.totalMs - b.totalMs)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].totalMs
    const totalAll = rows.reduce((n, r) => n + r.totalMs, 0)
    const fetchAll = rows.reduce((n, r) => n + r.fetchMs, 0)
    return {
      samples: rows.length,
      lastMs: rows[0].totalMs,
      p50Ms: at(0.5), p95Ms: at(0.95),
      maxMs: sorted[sorted.length - 1].totalMs,
      lastScopes: rows[0].scopes,
      fetchShare: totalAll > 0 ? fetchAll / totalAll : null,
      warnAtMs,
    }
  } catch {
    return { samples: 0, lastMs: null, p50Ms: null, p95Ms: null, maxMs: null, lastScopes: null, fetchShare: null, warnAtMs }
  }
}

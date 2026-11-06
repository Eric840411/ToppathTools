/**
 * AutoSpin「即時對照」：跑的當下，逐台比 AutoSpin／Game Record／Instant Meter 三邊。
 *
 * - AutoSpin：recon_spin（agent 每局寫入；outcome 為 not_started／no_bet 的不算一局）
 * - Game Record：/egm/reports/gameRecordList，playerName＝本帳號、全通道，再篩這台（uid＝gmid）
 * - Instant Meter：/egm/meter/egmMeterList，SAS 05＝Games Played、00＝Coin In（×Denom 才是金額）
 *
 * ⚠️ 三邊都從同一個起點 t0 算。t0 是**第一次讀到這台即時 Meter 的時間**（後台給的 upTime），
 *    不是 AutoSpin 開跑時間——開跑那一刻我們沒有 Meter 值，硬用開跑時間會讓 Meter 少算開頭那段。
 * ⚠️ Instant Meter 是整台機台累計，有別人在玩也會增加；Game Record 只算本帳號。
 * ⚠️ 只支援 QAT：13 個渠道各自一個後台網站（同一台 API 主機、同一組帳號），登入時用哪個
 *    origin 就只看得到那個渠道的機台，所以依 gmid 前綴的渠道號換 origin 登入。
 */
import { db } from './shared.js'
import { loadMeterConfig, meterPost } from './routes/meter-reconcile.js'
import { channelOfGmid } from './live-ledger-fetch.js'
import {
  type Baseline, type CompareStatus, type MeterReading, type SideValue,
  parseMeterItem, baselineInvalidReason, evaluateSides, dedupeByOrderId, guardOwnRounds, siteLoginCandidates,
} from './live-compare-core.js'
import { countSpins } from './live-compare-spins.js'
import { toBackendRounds } from './live-compare-window.js'
import { ensureWindowTables, evalMeterWindow, type WinView } from './live-compare-window-store.js'

ensureWindowTables(db)
import { normalizeRoundsStrict, normalizeCredit, checkChains, summarize, type ChainRound, type CreditTx, type SessionCheck, type RoundCheck, type ChainSummary } from './live-compare-chain.js'

/** QAT 渠道號 → 後台網站代號（2026-11-04 實測：用 qat-{site}.osmslot.org 當 origin 登入，回傳的 lastLoginChannelId 就是這個號碼）。 */
const QAT_CHANNEL_SITE: Record<string, string> = {
  '873': 'cp', '888': 'wf', '890': 'tbr', '891': 'tbp', '892': 'nc', '900': 'dy', '894': 'mdr',
  '895': 'dhs', '897': 'np', '896': 'cf', '893': 'bpo', '920': 'igo', '898': 'pf',
}
const METER_CACHE_MS = 15_000
const GR_PAGE_SIZE = 200
const GR_MAX_PAGES = 10
/** 逐局餘額檢查要往回多抓多久：進機台（轉入）通常在 AutoSpin 開跑前，要抓得到那筆才驗得了首局 */
const CHAIN_LOOKBACK_MS = 2 * 3600_000

db.exec(`
  CREATE TABLE IF NOT EXISTS live_compare_baseline (
    sessionId   TEXT NOT NULL,
    gmid        TEXT NOT NULL,
    t0          INTEGER NOT NULL,
    gamesPlayed REAL NOT NULL,
    coinIn      REAL NOT NULL,
    denom       REAL NOT NULL,
    createdAt   INTEGER NOT NULL,
    PRIMARY KEY (sessionId, gmid)
  )
`)

// ─── Instant Meter ───────────────────────────────────────────────────────────

/** 渠道 → 登入結果。cred 記下是哪組帳密登的，設定換了就不能再用（CodeX dfe4007 P2） */
const siteTokens = new Map<string, { token: string; lastlogintime: string; cred: string }>()
const credKey = (c: { username: string; password: string }) => `${c.username}\u0000${c.password}`
const meterListCache = new Map<string, { at: number; items: Map<string, Record<string, unknown>> | null; error?: string }>()

/**
 * 依序試每一組帳號登入這個渠道後台，第一組成功的就用它（token 依渠道快取）。
 * ⚠️ 帳號通常只能登入自己的渠道（QAT 實測：主帳號只能 CP、GCP 那組只能 NC，其他回 41104），
 *    所以不能「填一組就套全部渠道」——填了 NC 帳號 CP 就讀不到（CodeX 6dcda5d P2）。
 */
async function siteLogin(cfg: Record<string, string>, site: string): Promise<{ token: string; lastlogintime: string; cred: string } | string> {
  const origin = `https://qat-${site}.osmslot.org`
  const tried: string[] = []
  for (const c of siteLoginCandidates(cfg, loadMeterConfig('qat', 'gcp'))) {
    try {
      const r = await fetch(`${cfg.base_url.replace(/\/$/, '')}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, referer: `${origin}/` },
        body: JSON.stringify({ username: c.username, password: c.password }),
      })
      const d = await r.json() as { code?: number; data?: { token?: string; lastLoginTime?: number } }
      if (d.code === 20000 && d.data?.token) {
        const t = { token: d.data.token, lastlogintime: String(d.data.lastLoginTime ?? ''), cred: credKey(c) }
        siteTokens.set(site, t)
        return t
      }
      tried.push(`${c.source} code=${d.code ?? '?'}`)
    } catch (e) { tried.push(`${c.source} ${e}`) }
  }
  return `登入 ${site.toUpperCase()} 後台失敗（${tried.join('、') || '沒有可用帳號'}）——現有帳號都登不進這個渠道，請在下方「渠道後台帳號」填一組這個渠道能登入的帳號`
}

/** 讀某個渠道的全部機台 meter，15 秒內共用同一份。回傳 machineName → item。 */
async function meterListOf(channelId: string): Promise<{ items: Map<string, Record<string, unknown>> | null; error?: string }> {
  const hit = meterListCache.get(channelId)
  if (hit && Date.now() - hit.at < METER_CACHE_MS) return hit
  const site = QAT_CHANNEL_SITE[channelId]
  const save = (v: { items: Map<string, Record<string, unknown>> | null; error?: string }) => {
    meterListCache.set(channelId, { at: Date.now(), ...v }); return v
  }
  if (!site) return save({ items: null, error: `渠道 ${channelId} 不在已知的 QAT 後台清單` })
  const cfg = loadMeterConfig('qat', 'osm')
  if (!cfg.base_url || !siteLoginCandidates(cfg, loadMeterConfig('qat', 'gcp')).length) return save({ items: null, error: 'QAT OSM 後台連線設定是空的，請先到「Performance Meter 對帳」頁設定' })
  const origin = `https://qat-${site}.osmslot.org`
  for (let attempt = 0; attempt < 2; attempt++) {
    let tk = siteTokens.get(site)
    // 快取的 token 是用哪組帳密登的？那組已經不在候選裡（設定改了）就丟掉重登
    if (tk && !siteLoginCandidates(cfg, loadMeterConfig('qat', 'gcp')).some(c => credKey(c) === tk!.cred)) { siteTokens.delete(site); tk = undefined }
    if (!tk || attempt > 0) {
      const lg = await siteLogin(cfg, site)
      if (typeof lg === 'string') return save({ items: null, error: lg })
      tk = lg
    }
    try {
      // ⚠️ bgType=0＝OSM＋GCP 全部。沒帶時只回 bgType 1（OSM），GCP 機台（例：Lavie 的 GONGGONGLAIFU）會「找不到這台」。
      //    /egm/gsameter/egmMeterList 也是同一份，差別只在這個參數（2026-11-05 QAT 實測：892 渠道 不帶 264 台、=2 38 台、=0 302 台）
      const q = new URLSearchParams({ page: '1', pageSize: '1000', clientMachineName: '', channelId, bgType: '0' })
      const r = await fetch(`${cfg.base_url.replace(/\/$/, '')}/egm/meter/egmMeterList?${q}`, {
        headers: { accept: 'application/json', origin, referer: `${origin}/`, token: tk.token, lastlogintime: tk.lastlogintime },
      })
      const d = await r.json() as { code?: number; data?: { items?: Record<string, unknown>[]; total?: number } }
      if (d.code === 40200 && attempt === 0) continue
      if (d.code !== 20000) return save({ items: null, error: `Instant Meter 回 code=${d.code ?? '?'}` })
      const items = new Map<string, Record<string, unknown>>()
      for (const it of d.data?.items ?? []) items.set(String(it.machineName ?? ''), it)
      if ((d.data?.total ?? 0) > items.size) {
        return save({ items: null, error: `Instant Meter 只回了 ${items.size}/${d.data?.total} 台，結果不完整` })
      }
      return save({ items })
    } catch (e) { return save({ items: null, error: `Instant Meter 讀取失敗：${e}` }) }
  }
  return save({ items: null, error: 'Instant Meter 重新登入後仍未授權' })
}

// ─── Game Record ─────────────────────────────────────────────────────────────

/** 本帳號在 [fromMs, now] 的所有局（全通道），依 gmid 分組。 */
async function gameRecordsOf(username: string, fromMs: number): Promise<{ byGmid: Map<string, Array<{ t: number; bet: number }>>; chainRounds: ReturnType<typeof normalizeRoundsStrict> } | { error: string }> {
  const cfg = loadMeterConfig('qat', 'osm')
  if (!cfg.base_url && !cfg.login_username) return { error: 'QAT OSM 後台連線設定是空的' }
  const collected: unknown[] = []
  // 上界在開始前固定一次，翻頁時不能每頁各取一次 now
  const toIso = new Date(Date.now() + 60_000).toISOString()
  for (let page = 1; page <= GR_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      clientMachineName: '', playerId: '', playerName: username, orderId: '',
      page: String(page), pageSize: String(GR_PAGE_SIZE), dateTimeType: '0',
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,dy,ALL',
      bgType: '0', dataType: '0', isall: 'true', channelId: '0',
    })
    params.append('dateTime[]', new Date(fromMs - 60_000).toISOString())
    params.append('dateTime[]', toIso)
    let d: any
    try { d = await meterPost('qat', 'osm', cfg, '/egm/reports/gameRecordList', params) } catch (e) { return { error: `Game Record 讀取失敗：${e}` } }
    if (d?.code && d.code !== 20000) return { error: `Game Record 回 code=${d.code}` }
    const items: unknown[] = d?.data?.items ?? d?.data?.list ?? []
    collected.push(...items)
    const total = Number(d?.data?.total ?? 0)
    if (items.length < GR_PAGE_SIZE || (total > 0 && collected.length >= total)) break
    if (page === GR_MAX_PAGES) return { error: `Game Record 超過 ${GR_MAX_PAGES * GR_PAGE_SIZE} 筆，結果不完整` }
  }
  // 對到別人的帳號就整批不用（過濾條件沒生效，其餘的也不可信）
  // ⚠️ 不能用 Live Ledger 的 guardFetchedRows：它要求 spin_index，GCP 機台的列沒有，會整批讀不到（v5.79.3）
  const guard = guardOwnRounds(collected as Record<string, unknown>[], username)
  if ('message' in guard) return { error: guard.message }
  const byGmid = new Map<string, Array<{ t: number; bet: number }>>()
  for (const r of dedupeByOrderId(guard.rows)) {
    const g = byGmid.get(r.gmid) ?? []
    g.push({ t: r.betTimePrecise, bet: r.bet })
    byGmid.set(r.gmid, g)
  }
  // 逐局餘額檢查用的完整欄位（guard 已確認全是本帳號）
  const chainRounds = normalizeRoundsStrict(collected as Record<string, unknown>[])
  return { byGmid, chainRounds }
}

// ─── 這台全部玩家的 Game Record ＋ Jackpot Abnormality（Meter 固定窗口用）────────────

/**
 * 一台機台在 [fromMs, toMs] 的後台局（全部玩家）。⚠️ 用 CP 那組登入＋isall=true 才查得到其他渠道（892 用 NC 登入回 40501，1105 實測）。
 * handpay（/abnormality/getHandPayRecord）帶機台名時 API 會忽略日期，抓回後由 evaluateWindow 依時間切。
 * 任何一邊讀取失敗、截斷或有缺欄位的列，整台這輪不比（不能當 0）。
 */
async function machineBackendOf(clientMachineName: string, gmid: string, fromMs: number, toMs: number): Promise<{ gr: import('./live-compare-window.js').BackendRound[]; handpay: import('./live-compare-window.js').BackendRound[] } | { error: string }> {
  const cfg = loadMeterConfig('qat', 'osm')
  if (!cfg.base_url && !cfg.login_username) return { error: 'QAT OSM 後台連線設定是空的' }
  const studio = 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,dy,ALL'
  const grRaw: Record<string, unknown>[] = []
  for (let page = 1; page <= GR_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      clientMachineName, playerId: '', playerName: '', orderId: '', page: String(page), pageSize: String(GR_PAGE_SIZE),
      dateTimeType: '0', playerstudioid: studio, bgType: '0', dataType: '0', isall: 'true', channelId: '0',
    })
    params.append('dateTime[]', new Date(fromMs).toISOString())
    params.append('dateTime[]', new Date(toMs).toISOString())
    let d: any
    try { d = await meterPost('qat', 'osm', cfg, '/egm/reports/gameRecordList', params) } catch (e) { return { error: `Game Record（全部玩家）讀取失敗：${e}` } }
    if (d?.code !== 20000) return { error: `Game Record（全部玩家）回 code=${d?.code ?? '?'}` }
    const items: Record<string, unknown>[] = d?.data?.items ?? []
    grRaw.push(...items)
    const total = Number(d?.data?.total ?? 0)
    // ⚠️ 短頁也要核對 total：回的筆數少於 total＝不完整，不能當成全部（CodeX bfb0623 P1）
    if (total > 0 && grRaw.length >= total) break
    if (items.length < GR_PAGE_SIZE) { if (total > grRaw.length) return { error: `Game Record（全部玩家）只回了 ${grRaw.length}/${total} 筆，這輪不比` }; break }
    if (page === GR_MAX_PAGES) return { error: `Game Record（全部玩家）超過 ${GR_MAX_PAGES * GR_PAGE_SIZE} 筆，這輪不比` }
  }
  // 機台名篩選沒生效（混進別台）就整批不用
  const foreign = grRaw.filter(r => String(r.uid ?? '') !== gmid)
  if (foreign.length) return { error: `Game Record 用機台名查回 ${foreign.length} 筆別台的資料，這輪不比` }
  const hpParams = new URLSearchParams({
    clientMachineName, playerId: '', playerName: '', orderId: '', page: '1', pageSize: '200',
    dateTimeType: '0', playerstudioid: studio, isall: 'true', channelId: '0',
  })
  hpParams.append('dateTime[]', new Date(fromMs).toISOString())
  hpParams.append('dateTime[]', new Date(toMs).toISOString())
  let h: any
  try { h = await meterPost('qat', 'osm', cfg, '/abnormality/getHandPayRecord', hpParams) } catch (e) { return { error: `Jackpot Abnormality 讀取失敗：${e}` } }
  if (h?.code !== 20000) return { error: `Jackpot Abnormality 回 code=${h?.code ?? '?'}` }
  // ⚠️ 缺 uid 或別台的列不能靜默丟掉——整輪不比（CodeX bfb0623 P1）
  const hpRaw: Record<string, unknown>[] = h?.data?.items ?? []
  const hpForeign = hpRaw.filter(r => String(r.uid ?? '') !== gmid)
  if (hpForeign.length) return { error: `Jackpot Abnormality 有 ${hpForeign.length} 筆缺機台或不是這台，這輪不比` }
  if (Number(h?.data?.total ?? 0) > (h?.data?.items ?? []).length) return { error: 'Jackpot Abnormality 超過 200 筆，結果不完整，這輪不比' }
  const g = toBackendRounds(grRaw, 'gr'); if ('error' in g) return g
  const hp = toBackendRounds(hpRaw, 'handpay'); if ('error' in hp) return hp
  return { gr: g.rounds, handpay: hp.rounds }
}

// ─── Player Credit Log（進出機台轉帳）────────────────────────────────────────

/** 後台查詢用的台北時間字串 YYYY-MM-DD HH:mm:ss */
function tpeStr(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
}

async function creditLogOf(username: string, fromMs: number): Promise<{ credits: CreditTx[]; badByGmid: Map<string, number> } | { error: string }> {
  const cfg = loadMeterConfig('qat', 'osm')
  if (!cfg.base_url && !cfg.login_username) return { error: 'QAT OSM 後台連線設定是空的' }
  const collected: Record<string, unknown>[] = []
  const toStr = tpeStr(Date.now() + 60_000)
  for (let page = 1; page <= GR_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      userId: '', account: username, page: String(page), pageSize: String(GR_PAGE_SIZE), type: '0', channelId: '873',
      studioId: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,dy,ALL',
    })
    params.append('dateTime[]', tpeStr(fromMs))
    params.append('dateTime[]', toStr)
    let d: any
    try { d = await meterPost('qat', 'osm', cfg, '/egm/reports/rechargeRecordList', params) } catch (e) { return { error: `Player Credit Log 讀取失敗：${e}` } }
    if (d?.code && d.code !== 20000) return { error: `Player Credit Log 回 code=${d.code}` }
    const items: Record<string, unknown>[] = d?.data?.items ?? d?.data?.list ?? []
    collected.push(...items)
    const total = Number(d?.data?.total ?? 0)
    if (items.length < GR_PAGE_SIZE || (total > 0 && collected.length >= total)) break
    if (page === GR_MAX_PAGES) return { error: `Player Credit Log 超過 ${GR_MAX_PAGES * GR_PAGE_SIZE} 筆，結果不完整` }
  }
  // 過濾條件沒生效（出現別的帳號）就整批不用
  const foreign = collected.filter(r => String(r.account ?? '') !== username)
  if (foreign.length) return { error: `Player Credit Log 回傳含非目標帳號（${foreign.length}/${collected.length} 筆），不採用` }
  // 轉不出來的轉帳不能靜默丟掉：記下是哪台的，那台整台不做逐局檢查（漏一筆轉入／轉出會讓判定失真）
  const credits: CreditTx[] = [], badByGmid = new Map<string, number>()
  for (const r of collected) {
    const c = normalizeCredit(r)
    if (c) credits.push(c)
    else { const g = String(r.gmid ?? ''); badByGmid.set(g, (badByGmid.get(g) ?? 0) + 1) }
  }
  return { credits, badByGmid }
}

// ─── 組一輪結果 ─────────────────────────────────────────────────────────────

export interface LiveCompareRow {
  sessionId: string
  gmid: string
  machineType: string
  channelId: string
  channelName: string
  clientMachineName: string
  /** 機種：Instant Meter 清單的 bgType（1＝OSM、2＝GCP）；讀不到是 '' */
  meterKind: 'OSM' | 'GCP' | ''
  username: string
  status: CompareStatus
  /** 給人看的一句話：為什麼是這個狀態 */
  reason: string
  /** AutoSpin 開跑時間——AutoSpin 與 Game Record 從這裡算 */
  startedAt: number
  /** Meter 起點——Meter 差值與 asSinceT0 從這裡算 */
  t0: number | null
  as: SideValue & { betKnown: number; readAt: number }
  asSinceT0: (SideValue & { betKnown: number }) | null
  gr: (SideValue & { readAt: number }) | null
  grError?: string
  meter: (SideValue & { readAt: number }) | null
  meterError?: string
  meterCached: boolean
  /** Meter 即時值但停更（upTime 之後已有新局），這輪不比 Meter */
  meterStale: boolean
  cacheHourStr: string
  meterStart: { gamesPlayed: number; coinIn: number } | null
  meterNow: { gamesPlayed: number; coinIn: number } | null
  denom: number | null
  grMinusAs: SideValue
  meterMinusAs: SideValue
  /** 逐局餘額檢查（Game Record 七欄）；只列這一輪 AutoSpin 開跑後有下注的那幾次進機台 */
  chain: { summary: ChainSummary; sessions: SessionCheck[]; unkeyed: RoundCheck[] } | null
  chainError?: string
  /** Meter 固定窗口 (tStart, t1]：Meter 增量 vs 這台全部玩家 GR＋handpay */
  win: WinView | null
  winError?: string
}


export interface LiveSessionRef { id: string; startedAt: number }

export async function liveCompare(env: 'qat' | 'uat', sessions: LiveSessionRef[]): Promise<{ rows: LiveCompareRow[]; error?: string }> {
  if (env !== 'qat') return { rows: [], error: 'UAT 目前沒有 Instant Meter／Game Record 的連線設定，即時對照只支援 QAT' }
  const machines: Array<{ sessionId: string; startedAt: number; gmid: string; machineType: string; username: string }> = []
  for (const s of sessions) {
    const rs = db.prepare(`
      SELECT gmid, MAX(machineType) machineType, MAX(note) note FROM recon_spin
      WHERE env=? AND sessionId=? AND gmid<>'' GROUP BY gmid
    `).all(env, s.id) as Array<{ gmid: string; machineType: string; note: string | null }>
    for (const r of rs) {
      const m = /(?:^|\s)username=(\S+)/.exec(r.note ?? '')
      machines.push({ sessionId: s.id, startedAt: s.startedAt, gmid: r.gmid, machineType: r.machineType, username: m ? m[1] : '' })
    }
  }

  // 先把用得到的渠道 meter 讀好
  const channels = [...new Set(machines.map(m => channelOfGmid(m.gmid, '')))].filter(Boolean)
  const meterByCh = new Map<string, Awaited<ReturnType<typeof meterListOf>>>()
  await Promise.all(channels.map(async ch => { meterByCh.set(ch, await meterListOf(ch)) }))
  const meterReadAt = Date.now()

  // 起點：第一次讀到即時（非快取）Meter 才設；累計回退或 Denom 改變就重設
  const rows: LiveCompareRow[] = []
  const pending: Array<{ m: typeof machines[number]; base: Baseline | null; reading: MeterReading | null; item: Record<string, unknown> | null; meterError?: string; reason?: string }> = []
  for (const m of machines) {
    const ch = channelOfGmid(m.gmid, '')
    const ml = meterByCh.get(ch)
    let reading: MeterReading | null = null, item: Record<string, unknown> | null = null, meterError: string | undefined, reason: string | undefined
    if (!ch) meterError = 'gmid 看不出渠道'
    else if (!ml?.items) meterError = ml?.error || 'Instant Meter 讀取失敗'
    else {
      item = ml.items.get(m.gmid) ?? null
      if (!item) meterError = `渠道 ${ch} 的 Instant Meter 裡找不到這台`
      else { reading = parseMeterItem(item); if (!reading) meterError = 'Instant Meter 這台缺 05／00／Denom 欄位' }
    }
    let base = db.prepare('SELECT t0, gamesPlayed, coinIn, denom FROM live_compare_baseline WHERE sessionId=? AND gmid=?')
      .get(m.sessionId, m.gmid) as Baseline | undefined ?? null
    if (reading && !reading.useCache) {
      const bad = base ? baselineInvalidReason(base, reading) : null
      if (!base || bad) {
        if (bad) reason = `${bad}，已從這一輪重新設起點`
        base = { t0: reading.upTime || meterReadAt, gamesPlayed: reading.gamesPlayed, coinIn: reading.coinIn, denom: reading.denom }
        db.prepare(`INSERT OR REPLACE INTO live_compare_baseline (sessionId, gmid, t0, gamesPlayed, coinIn, denom, createdAt) VALUES (?,?,?,?,?,?,?)`)
          .run(m.sessionId, m.gmid, base.t0, base.gamesPlayed, base.coinIn, base.denom, Date.now())
        // 起點換了，舊的快照與窗口都作廢
        db.prepare('DELETE FROM live_compare_snap WHERE sessionId=? AND gmid=?').run(m.sessionId, m.gmid)
        db.prepare('DELETE FROM live_compare_win WHERE sessionId=? AND gmid=?').run(m.sessionId, m.gmid)
      }
    }
    pending.push({ m, base, reading, item, meterError, reason })
  }

  // Game Record：每個帳號一次，從該帳號最早的開跑時間抓；每台再用自己的窗口切
  const grByUser = new Map<string, Awaited<ReturnType<typeof gameRecordsOf>>>()
  const users = new Map<string, number>()
  for (const p of pending) {
    if (!p.m.username) continue
    users.set(p.m.username, Math.min(users.get(p.m.username) ?? Infinity, p.m.startedAt))
  }
  const clByUser = new Map<string, Awaited<ReturnType<typeof creditLogOf>>>()
  await Promise.all([...users].map(async ([u, from]) => {
    const [g, c] = await Promise.all([gameRecordsOf(u, from - CHAIN_LOOKBACK_MS), creditLogOf(u, from - CHAIN_LOOKBACK_MS)])
    grByUser.set(u, g); clByUser.set(u, c)
  }))
  const grReadAt = Date.now()

  for (const { m, base, reading, item, meterError, reason } of pending) {
    const ch = channelOfGmid(m.gmid, '')
    const cached = !!reading?.useCache
    const asReadAt = Date.now()
    const as: LiveCompareRow['as'] = { ...countSpins(db, 'qat', m.sessionId, m.gmid, m.startedAt, Number.MAX_SAFE_INTEGER, false), readAt: asReadAt }
    // AutoSpin 只當參考（v5.79.0）：Game Record 會晚 2 分鐘，拿即時局數比一定一直誤報
    const asSinceT0 = base ? countSpins(db, 'qat', m.sessionId, m.gmid, base.t0, Number.MAX_SAFE_INTEGER, true) : null
    let gr: LiveCompareRow['gr'] = null, grError: string | undefined
    let meter: LiveCompareRow['meter'] = null

    if (!m.username) grError = 'Game URL 裡沒有 username，查不了 Game Record'
    else {
      const g = grByUser.get(m.username)
      if (!g || 'error' in g) grError = g && 'error' in g ? g.error : 'Game Record 讀取失敗'
      else {
        const inWin = (g.byGmid.get(m.gmid) ?? []).filter(r => r.t >= m.startedAt)
        gr = { count: inWin.length, amount: Math.round(inWin.reduce((acc, r) => acc + r.bet, 0) * 100) / 100, readAt: grReadAt }
      }
    }
    let chain: LiveCompareRow['chain'] = null, chainError: string | undefined
    {
      const g = m.username ? grByUser.get(m.username) : undefined
      const c = m.username ? clByUser.get(m.username) : undefined
      if (!m.username) chainError = grError
      else if (!g || 'error' in g) chainError = grError
      else if (!c || 'error' in c) chainError = c && 'error' in c ? c.error : 'Player Credit Log 讀取失敗'
      else {
        const badCl = (c.badByGmid.get(m.gmid) ?? 0) + (c.badByGmid.get('') ?? 0)
        if ('error' in g.chainRounds) { chainError = g.chainRounds.error }
        else if (badCl) { chainError = `Player Credit Log 有 ${badCl} 筆這台（或缺機台）的轉帳解析不出來，逐局檢查不做` } else {
        const all = checkChains(g.chainRounds.rounds, c.credits, m.gmid, grReadAt)
        const mine = (r: RoundCheck) => r.betAt >= m.startedAt
        const x = { sessions: all.sessions.filter(s => s.rounds.some(mine)), unkeyed: all.unkeyed.filter(mine) }
        chain = { summary: summarize(x), ...x }
        }
      }
    }
    // ── Meter 固定窗口：Meter 增量 對 這台全部玩家 GR＋handpay（CodeX 1105 方案 B）──
    let win: LiveCompareRow['win'] = null, winError: string | undefined
    if (base && reading && !cached) {
      const w = await evalMeterWindow(db, { sessionId: m.sessionId, gmid: m.gmid, clientMachineName: String(item?.clientMachineName ?? ''), base, reading, readAt: meterReadAt }, machineBackendOf, Date.now())
      if ('error' in w) winError = w.error
      win = w.win
      if (win.t1 != null && win.meter) meter = { ...win.meter, readAt: meterReadAt }
    }
    // GR（本帳號）−AutoSpin 只當參考差值，不參與判定
    const ev = evaluateSides({ as, asSinceT0, gr, meter: null, meterCached: true })

    let status: CompareStatus
    let why = reason ?? ''
    if (meterError || !reading) { status = 'unreadable'; why = meterError || 'Instant Meter 讀取失敗' }
    else if (cached) { status = 'cache'; why = `Instant Meter 是快取值（停在 ${reading.cacheHourStr || '?'}），不能比；變成即時值後才開始` }
    else if (!base) { status = 'unreadable'; why = '還沒讀到即時 Meter，無法設起點' }
    else if (winError && win?.status !== 'overdue') { status = 'unreadable'; why = winError }
    else if (!win || win.t1 == null) { status = 'pending'; why = 'Meter 快照還沒滿 3 分鐘，等 Game Record 入帳再比' }
    else if (win.status === 'match') { status = 'match'; why = '' }
    else if (win.status === 'boundary') { status = 'pending'; why = '切點上剛好有一局在進行（下注在前、派彩在後），換下一個快照再比' }
    else if (win.status === 'overdue') {
      status = 'mismatch'
      const d = win.diff
      why = d ? `Meter 比後台${d.count >= 0 ? '多' : '少'} ${Math.abs(d.count)} 局、${d.amount >= 0 ? '多' : '少'} ${Math.abs(d.amount)}（同一窗口連續 ${win.fails} 次，逾期待查）` : '逾期待查'
    } else { status = 'pending'; why = '這個窗口有差異，下一輪同一窗口再確認' }

    rows.push({
      sessionId: m.sessionId, gmid: m.gmid, machineType: m.machineType,
      channelId: ch, channelName: QAT_CHANNEL_SITE[ch]?.toUpperCase() ?? ch,
      clientMachineName: String(item?.clientMachineName ?? ''),
      meterKind: item?.bgType === 2 || item?.bgType === '2' ? 'GCP' : item?.bgType === 1 || item?.bgType === '1' ? 'OSM' : '',
      username: m.username, status, reason: why, startedAt: m.startedAt, t0: base?.t0 ?? null,
      as, asSinceT0, gr, grError, meter, meterError, meterCached: cached, meterStale: false, cacheHourStr: reading?.cacheHourStr ?? '',
      meterStart: base ? { gamesPlayed: base.gamesPlayed, coinIn: base.coinIn } : null,
      meterNow: reading ? { gamesPlayed: reading.gamesPlayed, coinIn: reading.coinIn } : null,
      denom: reading?.denom ?? base?.denom ?? null,
      grMinusAs: ev.grMinusAs, meterMinusAs: win?.diff ?? { count: null, amount: null },
      chain, chainError, win, winError,
    })
  }
  return { rows }
}

/**
 * 同一時間只跑一次比對（頁面輪詢與背景結算共用）。窗口狀態是「讀 → 查後台 → 寫回」，
 * 兩邊同時推進同一台會重複前進或互相蓋掉（CodeX 1106 提醒要加鎖）。
 */
let liveCompareChain: Promise<unknown> = Promise.resolve()
export function liveCompareLocked(env: 'qat' | 'uat', sessions: LiveSessionRef[]): ReturnType<typeof liveCompare> {
  const next = liveCompareChain.then(() => liveCompare(env, sessions))
  liveCompareChain = next.catch(() => {})
  return next
}

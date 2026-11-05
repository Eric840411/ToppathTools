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
import { guardFetchedRows } from './live-ledger.js'
import { channelOfGmid } from './live-ledger-fetch.js'
import {
  type Baseline, type CompareStatus, type MeterReading, type SideValue,
  parseMeterItem, baselineInvalidReason, evaluateSides, decideStatus, meterWindowEnd, dedupeByOrderId,
} from './live-compare-core.js'
import { countSpins } from './live-compare-spins.js'

/** QAT 渠道號 → 後台網站代號（2026-11-04 實測：用 qat-{site}.osmslot.org 當 origin 登入，回傳的 lastLoginChannelId 就是這個號碼）。 */
const QAT_CHANNEL_SITE: Record<string, string> = {
  '873': 'cp', '888': 'wf', '890': 'tbr', '891': 'tbp', '892': 'nc', '900': 'dy', '894': 'mdr',
  '895': 'dhs', '897': 'np', '896': 'cf', '893': 'bpo', '920': 'igo', '898': 'pf',
}
const METER_CACHE_MS = 15_000
const GR_PAGE_SIZE = 200
const GR_MAX_PAGES = 10

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

const siteTokens = new Map<string, { token: string; lastlogintime: string }>()
const meterListCache = new Map<string, { at: number; items: Map<string, Record<string, unknown>> | null; error?: string }>()

/**
 * 渠道後台的登入帳號：有填 site_username 就用它，沒填退回 Performance Meter 那組主帳號。
 * ⚠️ 實測主帳號只能登入自己的渠道（CP），其他渠道回 41104——要另填一組共用帳號。
 */
function siteCreds(cfg: Record<string, string>): { username: string; password: string } {
  return cfg.site_username
    ? { username: cfg.site_username, password: cfg.site_password || '' }
    : { username: cfg.login_username || '', password: cfg.login_password || '' }
}

async function siteLogin(cfg: Record<string, string>, site: string): Promise<{ token: string; lastlogintime: string } | string> {
  const origin = `https://qat-${site}.osmslot.org`
  try {
    const r = await fetch(`${cfg.base_url.replace(/\/$/, '')}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, referer: `${origin}/` },
      body: JSON.stringify(siteCreds(cfg)),
    })
    const d = await r.json() as { code?: number; data?: { token?: string; lastLoginTime?: number } }
    if (d.code === 20000 && d.data?.token) {
      const t = { token: d.data.token, lastlogintime: String(d.data.lastLoginTime ?? '') }
      siteTokens.set(`${site}|${siteCreds(cfg).username}`, t)
      return t
    }
    return `登入 ${site.toUpperCase()} 後台失敗（code=${d.code ?? '?'}）`
      + (cfg.site_username ? '' : '——主後台帳號可能沒有這個渠道，請在下方「渠道後台帳號」填一組 13 個渠道都能登入的帳號')
  } catch (e) { return `登入 ${site.toUpperCase()} 後台失敗：${e}` }
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
  if (!cfg.base_url || !(cfg.site_username || cfg.login_username)) return save({ items: null, error: 'QAT OSM 後台連線設定是空的，請先到「Performance Meter 對帳」頁設定' })
  const origin = `https://qat-${site}.osmslot.org`
  for (let attempt = 0; attempt < 2; attempt++) {
    let tk = siteTokens.get(`${site}|${siteCreds(cfg).username}`)
    if (!tk || attempt > 0) {
      const lg = await siteLogin(cfg, site)
      if (typeof lg === 'string') return save({ items: null, error: lg })
      tk = lg
    }
    try {
      const q = new URLSearchParams({ page: '1', pageSize: '1000', clientMachineName: '', channelId })
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
async function gameRecordsOf(username: string, fromMs: number): Promise<{ byGmid: Map<string, Array<{ t: number; bet: number }>> } | { error: string }> {
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
  const guard = guardFetchedRows(collected, username)
  if (!guard.ok) return { error: guard.message || 'Game Record 回傳內容不符' }
  const byGmid = new Map<string, Array<{ t: number; bet: number }>>()
  for (const r of dedupeByOrderId(guard.rows.filter((x): x is NonNullable<typeof x> => !!x))) {
    const g = byGmid.get(r.gmid) ?? []
    g.push({ t: r.betTimePrecise, bet: r.bet })
    byGmid.set(r.gmid, g)
  }
  return { byGmid }
}

// ─── 連續對不上幾輪 ─────────────────────────────────────────────────────────

/** 同一輪內前端重整不會重複累加：距離上一次計數未滿 20 秒就沿用。 */
const streaks = new Map<string, { n: number; at: number }>()
function bumpStreak(key: string, differs: boolean): number {
  const now = Date.now()
  const s = streaks.get(key)
  if (!differs) { streaks.set(key, { n: 0, at: now }); return 0 }
  if (s && now - s.at < 20_000) return s.n
  const n = (s?.n ?? 0) + 1
  streaks.set(key, { n, at: now })
  return n
}

// ─── 組一輪結果 ─────────────────────────────────────────────────────────────

export interface LiveCompareRow {
  sessionId: string
  gmid: string
  machineType: string
  channelId: string
  channelName: string
  clientMachineName: string
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
  cacheHourStr: string
  meterStart: { gamesPlayed: number; coinIn: number } | null
  meterNow: { gamesPlayed: number; coinIn: number } | null
  denom: number | null
  grMinusAs: SideValue
  meterMinusAs: SideValue
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
  await Promise.all([...users].map(async ([u, from]) => { grByUser.set(u, await gameRecordsOf(u, from)) }))
  const grReadAt = Date.now()

  for (const { m, base, reading, item, meterError, reason } of pending) {
    const ch = channelOfGmid(m.gmid, '')
    const cached = !!reading?.useCache
    const asReadAt = Date.now()
    const as: LiveCompareRow['as'] = { ...countSpins(db, 'qat', m.sessionId, m.gmid, m.startedAt, Number.MAX_SAFE_INTEGER, false), readAt: asReadAt }
    // Meter 那段：起點 t0 到這次 Meter 的 upTime（快取／讀不到時不比，算到現在只給畫面參考）
    const meterEnd = reading && !reading.useCache ? meterWindowEnd(reading, meterReadAt) : undefined
    const asSinceT0 = base ? countSpins(db, 'qat', m.sessionId, m.gmid, base.t0, meterEnd ?? Number.MAX_SAFE_INTEGER, true) : null
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
    if (base && reading && !cached) {
      meter = {
        count: reading.gamesPlayed - base.gamesPlayed,
        amount: Math.round((reading.coinIn - base.coinIn) * base.denom * 100) / 100,
        readAt: meterReadAt,
      }
    }

    const input = { as, asSinceT0, gr, meter, meterCached: cached }
    const ev = evaluateSides(input)
    const streak = bumpStreak(`${m.sessionId}|${m.gmid}`, ev.differs)
    const status: CompareStatus = decideStatus(input, ev, streak)
    let why = reason ?? ''
    if (status === 'unreadable') why = grError || meterError || (!base ? '還沒讀到即時 Meter，無法設起點' : why)
    else if (status === 'cache') why = `Instant Meter 是快取值（停在 ${reading?.cacheHourStr || '?'}），只比 Game Record；變成即時值後才開始算 Meter 差值`
    else if (status === 'pending') why = '有差異，下一輪再確認'
    else if (status === 'mismatch') {
      const parts: string[] = []
      if (ev.grMinusAs.count) parts.push(`Game Record ${ev.grMinusAs.count > 0 ? '多' : '少'} ${Math.abs(ev.grMinusAs.count)} 局`)
      if (ev.meterMinusAs.count) parts.push(`Meter ${ev.meterMinusAs.count > 0 ? '多' : '少'} ${Math.abs(ev.meterMinusAs.count)} 局`)
      why = (parts.join('；') || '局數相同、金額對不上') + `（連續 ${streak} 輪）`
    }

    rows.push({
      sessionId: m.sessionId, gmid: m.gmid, machineType: m.machineType,
      channelId: ch, channelName: QAT_CHANNEL_SITE[ch]?.toUpperCase() ?? ch,
      clientMachineName: String(item?.clientMachineName ?? ''),
      username: m.username, status, reason: why, startedAt: m.startedAt, t0: base?.t0 ?? null,
      as, asSinceT0, gr, grError, meter, meterError, meterCached: cached, cacheHourStr: reading?.cacheHourStr ?? '',
      meterStart: base ? { gamesPlayed: base.gamesPlayed, coinIn: base.coinIn } : null,
      meterNow: reading ? { gamesPlayed: reading.gamesPlayed, coinIn: reading.coinIn } : null,
      denom: reading?.denom ?? base?.denom ?? null,
      grMinusAs: ev.grMinusAs, meterMinusAs: ev.meterMinusAs,
    })
  }
  return { rows }
}

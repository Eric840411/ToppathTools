import { Router } from 'express'
import { db, addHistory } from '../shared.js'
import { type MeterEnv, type MeterProfile, parseMeterEnv, loadMeterConfig, saveMeterConfigValue, migrateMeterConfigEnv, legacyUnclassified, missingConfigMessage } from '../meter-config.js'
import { apiProblem, countDelta, isNum, meterHistoryLine, meterVerdict, METER_VALID, missingMeterFields } from '../meter-verdict.js'
import { winLossJackpotTerm } from '../../shared/meter-rtp.js'
import { compareBoxLog, type BoxLogParse, type BoxSpin, type GrSpin } from '../../shared/box-log-spins.js'
import { buildCountIntervals, hourBucketFromRow, mapLimit, summarizeCountDiag, type HourBucket, type IntervalResult } from '../meter-count-diag.js'

export const router = Router()

// ─── Performance Meter 對帳 ──────────────────────────────────────────────────
// 比對 OSM/GCP EGM Metering 的 Coin Out 與 Game Record + Jackpot Abnormality 加總，
// 驗證兩邊數字是否完全一致。憑證存在 meter_reconcile_config，依環境×後台分四組（見 server/meter-config.ts）。

type Profile = MeterProfile
export { loadMeterConfig }

// 舊 osm_／gcp_ 搬到 {env}_{profile}_（只跑一次）
try {
  const m = migrateMeterConfigEnv()
  if (m.moved.length || m.skipped.length) console.log(`[meter-config] 環境拆分：搬移 ${m.moved.join(', ') || '無'}；未搬 ${m.skipped.join(', ') || '無'}`)
} catch (e) { console.error('[meter-config] 環境拆分失敗', e) }

/** QAT 才有預設 channel（873／892）；UAT 沒填就是沒填，不能拿 QAT 的值去查。 */
function channelOf(env: MeterEnv, profile: Profile, cfg: Record<string, string>): string {
  if (cfg.channel_id) return cfg.channel_id
  return env === 'qat' ? (profile === 'osm' ? '873' : '892') : ''
}

/** 查詢日期的隔天（用於 dateTime[] 上界／gaming day 邊界跨日計算）。 */
function nextDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** 後台自己的 Game Record 查詢介面（有 DevTools 截圖佐證）送出的 dateTime[] 其實是
 * ISO UTC 字串（例如 "2026-07-26T22:00:00.000Z"），不是單純日期字串——這才是真正能對齊
 * 整天邊界的格式，先前用 "YYYY-MM-DD HH:mm:ss" 這種空白分隔字串完全被後端忽略時分秒。
 * 使用者操作介面的時區固定是 UTC+8（已用真實請求反推驗證：本地 06:00 對應 UTC 前一天 22:00）。 */
function toUtcIso(dateStr: string, hh: number, mm = 0, ss = 0): string {
  const t = `${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000+08:00`
  return new Date(t).toISOString()
}


// 已用 hourly-meter 差值反算驗證過的欄位語意（見對話紀錄）。
// 注意：欄位 2（daily=RTP）在 egmMeterHourList 裡被挪用成該小時 bucket 的 Unix timestamp，
// 欄位 26（WIN/LOSE）在 hourly 資料裡完全不存在（hourly 只到 25 接著跳 29）——
// 所以 WIN/LOSE、RTP 一律用 coinIn/coinOut/jackpotWins 現算，不要直接讀 hourly row 的欄位 2/26。
const FIELD = { gamesPlayed: '5', coinIn: '6', coinOut: '10', jackpotWins: '29' } as const

function meterHeaders(cfg: Record<string, string>) {
  return {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'origin': cfg.origin || '',
    'referer': cfg.origin ? `${cfg.origin}/` : '',
    'token': cfg.token || '',
    'lastlogintime': cfg.lastlogintime || '',
  }
}

async function meterLogin(env: MeterEnv, profile: Profile, cfg: Record<string, string>): Promise<string | null> {
  if (!cfg.base_url) return null
  const baseUrl = cfg.base_url.replace(/\/$/, '')
  try {
    const r = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: cfg.origin || '', referer: cfg.origin ? `${cfg.origin}/` : '' },
      body: JSON.stringify({ username: cfg.login_username || '', password: cfg.login_password || '' }),
    })
    const d = await r.json() as { code?: number; data?: { token?: string; lastLoginTime?: number } }
    if (d.code === 20000 && d.data?.token) {
      saveMeterConfigValue(env, profile, 'token', d.data.token)
      saveMeterConfigValue(env, profile, 'lastlogintime', String(d.data.lastLoginTime ?? ''))
      return d.data.token
    }
    return null
  } catch { return null }
}

/** GET 呼叫，token 過期（code 40200）時自動重新登入一次再重試。 */
async function meterGet(env: MeterEnv, profile: Profile, cfg: Record<string, string>, path: string, params: URLSearchParams): Promise<any> {
  if (!cfg.base_url) throw new Error(missingConfigMessage(env, profile))
  const baseUrl = cfg.base_url.replace(/\/$/, '')
  let headers = meterHeaders(cfg)
  let r = await fetch(`${baseUrl}${path}?${params}`, { method: 'GET', headers })
  let d = await r.json() as { code?: number }
  if (d.code === 40200) {
    const newToken = await meterLogin(env, profile, cfg)
    if (newToken) {
      cfg = loadMeterConfig(env, profile)
      headers = meterHeaders(cfg)
      r = await fetch(`${baseUrl}${path}?${params}`, { method: 'GET', headers })
      d = await r.json()
    }
  }
  return d
}

/** POST 呼叫（gameRecordList 是 POST + query string 參數的舊風格 API）。*/
export async function meterPost(env: MeterEnv, profile: Profile, cfg: Record<string, string>, path: string, params: URLSearchParams): Promise<any> {
  if (!cfg.base_url) throw new Error(missingConfigMessage(env, profile))
  const baseUrl = cfg.base_url.replace(/\/$/, '')
  let headers = meterHeaders(cfg)
  let r = await fetch(`${baseUrl}${path}?${params}`, { method: 'POST', headers })
  let d = await r.json() as { code?: number }
  if (d.code === 40200) {
    const newToken = await meterLogin(env, profile, cfg)
    if (newToken) {
      cfg = loadMeterConfig(env, profile)
      headers = meterHeaders(cfg)
      r = await fetch(`${baseUrl}${path}?${params}`, { method: 'POST', headers })
      d = await r.json()
    }
  }
  return d
}

// ─── 設定 API ───────────────────────────────────────────────────────────────

// GET /api/osm/meter-reconcile/config?env=qat|uat&profile=osm|gcp — 讀取設定（密碼/token 不回傳明文）
router.get('/api/osm/meter-reconcile/config', (req, res) => {
  const env = parseMeterEnv(req.query.env)
  if (!env) return res.status(400).json({ ok: false, message: 'env 需為 qat 或 uat' })
  const profile = (req.query.profile as string) === 'gcp' ? 'gcp' : 'osm'
  const cfg = loadMeterConfig(env, profile)
  res.json({
    ok: true,
    env,
    // 舊版只有一組設定、又判斷不出屬於哪個環境時沒有搬移，畫面要提示重填
    legacyUnclassified: legacyUnclassified(profile),
    base_url: cfg.base_url || '',
    origin: cfg.origin || '',
    channelId: cfg.channel_id || '',
    login_username: cfg.login_username || '',
    hasPassword: !!cfg.login_password,
    hasToken: !!cfg.token,
    // AutoSpin 即時對照用：13 個渠道後台共用的帳號（主帳號只看得到自己那個渠道時才需要）
    site_username: cfg.site_username || '',
    hasSitePassword: !!cfg.site_password,
  })
})

// PUT /api/osm/meter-reconcile/config — 儲存設定
router.put('/api/osm/meter-reconcile/config', (req, res) => {
  const { profile, base_url, origin, channelId, login_username, login_password, site_username, site_password } = req.body as {
    profile?: string; base_url?: string; origin?: string; channelId?: string
    login_username?: string; login_password?: string; site_username?: string; site_password?: string
  }
  const env = parseMeterEnv((req.body as { env?: unknown })?.env)
  if (!env) return res.status(400).json({ ok: false, message: 'env 需為 qat 或 uat' })
  if (profile !== 'osm' && profile !== 'gcp') return res.status(400).json({ ok: false, message: 'profile 需為 osm 或 gcp' })
  // 網址改了，舊 token 是別的後台發的，不能再用
  const prevBase = loadMeterConfig(env, profile).base_url || ''
  if (typeof base_url === 'string' && base_url !== prevBase) { saveMeterConfigValue(env, profile, 'token', ''); saveMeterConfigValue(env, profile, 'lastlogintime', '') }
  if (typeof base_url === 'string') saveMeterConfigValue(env, profile, 'base_url', base_url)
  if (typeof origin === 'string') saveMeterConfigValue(env, profile, 'origin', origin)
  if (typeof channelId === 'string') saveMeterConfigValue(env, profile, 'channel_id', channelId)
  if (typeof login_username === 'string') saveMeterConfigValue(env, profile, 'login_username', login_username)
  if (typeof login_password === 'string' && login_password) saveMeterConfigValue(env, profile, 'login_password', login_password)
  if (typeof site_username === 'string') saveMeterConfigValue(env, profile, 'site_username', site_username)
  if (typeof site_password === 'string' && site_password) saveMeterConfigValue(env, profile, 'site_password', site_password)
  res.json({ ok: true })
})

// POST /api/osm/meter-reconcile/test — 測試登入
router.post('/api/osm/meter-reconcile/test', async (req, res) => {
  const env = parseMeterEnv((req.body as { env?: unknown })?.env)
  if (!env) return res.status(400).json({ ok: false, message: 'env 需為 qat 或 uat' })
  const profile = (req.body as { profile?: string })?.profile === 'gcp' ? 'gcp' : 'osm'
  const cfg = loadMeterConfig(env, profile)
  if (!cfg.base_url) return res.status(400).json({ ok: false, message: missingConfigMessage(env, profile) })
  const token = await meterLogin(env, profile, cfg)
  if (token) res.json({ ok: true, message: '✅ 登入成功' })
  else res.status(400).json({ ok: false, message: '登入失敗，請確認帳號密碼與網址設定' })
})

// GET /api/osm/meter-reconcile/game-types — 給 Egm DayCount 對帳的 Game Type 篩選下拉選單用。
// /public/gameNameAlias 是公開端點，不需要登入 token（已用真實請求確認），直接 fetch，不走 meterGet。
router.get('/api/osm/meter-reconcile/game-types', async (req, res) => {
  const env = parseMeterEnv(req.query.env)
  if (!env) return res.status(400).json({ ok: false, message: 'env 需為 qat 或 uat' })
  try {
    const cfg = loadMeterConfig(env, 'osm')
    if (!cfg.base_url) return res.json({ ok: false, message: missingConfigMessage(env, 'osm'), gameTypes: [] })
    const baseUrl = cfg.base_url.replace(/\/$/, '')
    const channelId = channelOf(env, 'osm', cfg)
    const r = await fetch(`${baseUrl}/public/gameNameAlias?channelId=${encodeURIComponent(channelId)}`)
    const d = await r.json() as { data?: { name: string; gameTag: string; id: number }[] }
    res.json({ ok: true, gameTypes: d.data ?? [] })
  } catch (e) {
    res.status(500).json({ ok: false, message: `查詢失敗: ${e}` })
  }
})

// ─── Egm DayCount 對帳（比對 gameCount 彙總報表 vs playerMachineCount 逐筆回推）─────
// 兩支 API 皆已用真實 Network request 截圖確認（channelId=873，OSM backendservertest.osmslot.org）。
// gameCount：一天一列的彙總報表（Egm DayCount）；playerMachineCount：player+machine 逐筆列（User Detail）。
router.post('/api/osm/meter-reconcile/egm-daycount', async (req, res) => {
  const { date, dayBoundary, allChannels, gameType: gameTypeFilter } = req.body as {
    date?: string; dayBoundary?: string; allChannels?: boolean; gameType?: string
  }
  if (!date) return res.status(400).json({ ok: false, message: 'date 為必填' })
  const env = parseMeterEnv((req.body as { env?: unknown })?.env)
  if (!env) return res.status(400).json({ ok: false, message: 'env 需為 qat 或 uat' })
  const gameType = gameTypeFilter || ''
  const boundary = dayBoundary === 'calendar' ? 'calendar' : 'gaming'
  const apiDateType = boundary === 'calendar' ? '1' : '0'
  const isall = allChannels ? 'true' : 'false'
  const cfg = loadMeterConfig(env, 'osm')
  if (!cfg.base_url) {
    return res.status(400).json({ ok: false, message: missingConfigMessage(env, 'osm') })
  }
  if (!allChannels && !channelOf(env, 'osm', cfg)) return res.status(400).json({ ok: false, message: `${env.toUpperCase()} 的 OSM（CP）後台沒有填 Channel ID` })
  // channelId=873 是「Player Channel: np +11」那個預設範圍；後台「All」勾選時實際送出的請求
  // 是 channelId=0 + isall=true（已用真實 Network request 截圖確認，不是拿掉 playerstudioid）。
  const channelId = allChannels ? '0' : channelOf(env, 'osm', cfg)
  // playerstudioid 這組固定清單已用真實查詢驗證可以精準對上「np +11」那個預設範圍，All 模式下
  // 後台一樣有帶這個參數（沒有拿掉），只是 channelId／isall 變了。
  const playerstudioid = 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,ALL'

  try {
    const num = (v: unknown) => { const n = parseFloat(String(v ?? '0')); return Number.isFinite(n) ? n : 0 }

    // ① Egm DayCount（gameCount）—— 一天一列彙總，只有一天時 items[0] 就是那一天的值。
    // 注意：這支 API 的 sumData 跟 items[] 範圍不一致（已用真實查詢驗證：查單一天 total=1，
    // 但 sumData 的數字卻是 items[0] 的好幾倍，看起來 sumData 沒有正確套用日期篩選）——
    // 所以只有一天時改用 items[0]，不要相信 sumData；playerMachineCount 的 sumData 沒有這個問題。
    const dcParams = new URLSearchParams({
      gameType, page: '1', pageSize: '10',
      dateType: apiDateType, version: '', bgType: '0', isall, channelId,
    })
    if (playerstudioid) dcParams.set('playerstudioid', playerstudioid)
    dcParams.append('dateTime[]', date); dcParams.append('dateTime[]', date)
    dcParams.append('date[]', date); dcParams.append('date[]', date)
    const dc = await meterGet(env, 'osm', cfg, '/egm/reports/gameCount', dcParams)
    // 回應無效（登入失敗、網址錯）不能被 num() 轉成 0——三邊都是 0 會顯示成「一致」（1104 走查 UAT 沒密碼時實測）
    const dcBad = apiProblem('Egm DayCount', dc, d => typeof d.data === 'object' && d.data !== null)
    if (dcBad) return res.status(502).json({ ok: false, message: `${env.toUpperCase()} 後台回應無效：${dcBad}（帳密或網址可能不對，請到 Performance Meter 頁測試登入）` })
    const dcRow = dc?.data?.items?.[0] ?? dc?.data?.sumData ?? {}
    const egmDayCount = {
      betUsers: num(dcRow.betUsers), betNumber: num(dcRow.betTimes), betAmount: num(dcRow.bet),
      transferIn: num(dcRow.machineIn), transferOut: num(dcRow.machineOut),
      winOrLose: num(dcRow.platformWin), winLoseRatio: num(dcRow.platformWinPercent),
      jackpotAmount: num(dcRow.jackpotamount),
    }

    // ② User Detail（playerMachineCount）—— 逐筆列，pageSize 拉大一次抓完（測試環境資料量不大）；
    // sumData 裡的加總欄位（betNumber/betAmount/transferIn/transferOut/winOrLose/winLoseRatio）可以直接信任，
    // 但沒有 betUsers 這種「不重複計數」欄位，要自己從 items[] 算 Bet Number > 0 的不重複 playerId。
    const udParams = new URLSearchParams({
      gameType, clientMachineName: '', playerId: '', playerName: '',
      page: '1', pageSize: '500', dateType: apiDateType, version: '', bgType: '0', isall, channelId,
    })
    udParams.append('dateTime[]', date); udParams.append('dateTime[]', date)
    udParams.append('date[]', date); udParams.append('date[]', date)
    const ud = await meterGet(env, 'osm', cfg, '/egm/reports/playerMachineCount', udParams)
    const udBad = apiProblem('User Detail', ud, d => typeof d.data === 'object' && d.data !== null)
    if (udBad) return res.status(502).json({ ok: false, message: `${env.toUpperCase()} 後台回應無效：${udBad}` })
    type UdRow = {
      playerId?: string; playerName?: string; clientMachineName?: string
      win?: string; betTimes?: string; bet?: string
      machineIn?: string; machineOut?: string; playerWin?: string
    }
    const udItemsAll: UdRow[] = ud?.data?.items ?? []
    const udTotal: number = ud?.data?.total ?? udItemsAll.length

    // ②b Jackpot Record（jackpotRecordList）—— 逐筆中獎紀錄，拿來驗證 Egm DayCount 的 Jackpot Amount。
    // 這支 API 跟前兩支不同：dateTimeType=1、dateTime[] 是空白分隔的本地時間字串（已用真實
    // Network request 截圖確認格式，不是 ISO UTC）。
    const dayStartHour = boundary === 'calendar' ? 0 : 6
    const nextDate = nextDateStr(date)
    const jrWindowStart = `${date} ${String(dayStartHour).padStart(2, '0')}:00:00`
    const jrWindowEnd = `${nextDate} ${String(dayStartHour).padStart(2, '0')}:00:00`
    const jrParams = new URLSearchParams({
      clientMachineName: '', playerId: '', playerName: '', orderId: '',
      page: '1', pageSize: '500', dateTimeType: '1', playerstudioid,
      gameType, bgType: '0', isall, channelId,
    })
    jrParams.append('dateTime[]', jrWindowStart); jrParams.append('dateTime[]', jrWindowEnd)
    const jr = await meterGet(env, 'osm', cfg, '/egm/reports/jackpotRecordList', jrParams)
    const jrBad = apiProblem('Jackpot Record', jr, d => typeof d.data === 'object' && d.data !== null)
    if (jrBad) return res.status(502).json({ ok: false, message: `${env.toUpperCase()} 後台回應無效：${jrBad}` })
    type JrRow = { userid?: string; username?: string; clientMachineName?: string; bet?: number; jackpotamount?: number; payoutTime?: string }
    const jrItemsAll: JrRow[] = jr?.data?.items ?? []
    const jrTotal: number = jr?.data?.total ?? jrItemsAll.length
    const jrSum = jr?.data?.sumData ?? {}
    const jackpotRecordTotal = num(jrSum.jackpotamount)
    const udTruncated = udTotal > udItemsAll.length // pageSize=500 不夠裝下全部時的保底警告
    const udSum = ud?.data?.sumData ?? {}

    const betUserSet = new Set(udItemsAll.filter(r => num(r.betTimes) > 0).map(r => r.playerId))

    // 同一個 UserId 會在多台機台各出現一列（Bet Number > 0 才算進 Total Bet User），使用者反應肉眼要
    // 從逐筆明細裡自己找出「有下注的帳號」很麻煩，這裡先按 playerId 彙整一次，跨機台的 Bet Number/Bet 加總。
    const userAgg = new Map<string, { playerId: string; playerName: string; betNumber: number; betAmount: number; machines: Set<string> }>()
    for (const r of udItemsAll) {
      const bt = num(r.betTimes)
      if (bt <= 0) continue
      const pid = r.playerId || ''
      const cur = userAgg.get(pid) ?? { playerId: pid, playerName: r.playerName || '', betNumber: 0, betAmount: 0, machines: new Set<string>() }
      cur.betNumber += bt
      cur.betAmount += num(r.bet)
      if (r.clientMachineName) cur.machines.add(r.clientMachineName)
      userAgg.set(pid, cur)
    }
    const bettingUsers = Array.from(userAgg.values())
      .map(u => ({ playerId: u.playerId, playerName: u.playerName, betNumber: u.betNumber, betAmount: u.betAmount, machineCount: u.machines.size }))
      .sort((a, b) => b.betAmount - a.betAmount)

    const userDetail = {
      betUsers: betUserSet.size, betNumber: num(udSum.betTimes), betAmount: num(udSum.bet),
      transferIn: num(udSum.machineIn), transferOut: num(udSum.machineOut),
      winOrLose: num(udSum.platformWin), winLoseRatio: num(udSum.platformWinPercent),
      jackpotAmount: jackpotRecordTotal, // 來自 jackpotRecordList（Jackpot Record 報表），不是 playerMachineCount
      recordCount: udTotal,
    }

    const fields = [
      { key: 'transferIn', label: 'Total Online Transfer In Amount' },
      { key: 'transferOut', label: 'Total Online Transfer Out Amount' },
      { key: 'betUsers', label: 'Total Bet User' },
      { key: 'betNumber', label: 'Total Bet Number' },
      { key: 'betAmount', label: 'Total Bet Amount' },
      { key: 'winOrLose', label: 'Total Win Or Lose Amount' },
      { key: 'winLoseRatio', label: 'Total Win Lose Ratio' },
    ] as const
    type ComparisonRow = { key: string; label: string; egmDayCount: number; userDetail: number; delta: number; pass: boolean }
    const comparison: ComparisonRow[] = fields.map(f => {
      const a = (egmDayCount as any)[f.key] as number
      const b = (userDetail as any)[f.key] as number
      const delta = a - b
      return { key: f.key, label: f.label, egmDayCount: a, userDetail: b, delta, pass: Math.abs(delta) < 0.005 }
    })
    // Jackpot Amount：對照 jackpotRecordList（Jackpot Record 報表）逐筆中獎紀錄加總，是真的比對，
    // 不是單純顯示（已用真實資料驗證：DFDC3 88 Fortunes 那筆 jackpotamount=2,222，跟 Egm DayCount 一致）。
    {
      const a = egmDayCount.jackpotAmount, b = jackpotRecordTotal, delta = a - b
      comparison.push({ key: 'jackpotAmount', label: 'Jackpot Amount', egmDayCount: a, userDetail: b, delta, pass: Math.abs(delta) < 0.005 })
    }
    const allPass = comparison.every(c => c.pass)

    const result = {
      ok: true, date, dayBoundary: boundary, allChannels: !!allChannels, gameType,
      allPass, comparison, egmDayCount, userDetail,
      udTruncated, udItems: udItemsAll, bettingUsers,
      jackpotRecords: jrItemsAll, jrTotal,
    }

    addHistory(
      'egm-daycount',
      `Egm DayCount 對帳（${env.toUpperCase()}・OSM）`,
      `${date}（${boundary === 'gaming' ? 'Gaming Day' : '自然日'}${allChannels ? '／All' : ''}${gameType ? `／${gameType}` : ''}）— ${allPass ? '✅ 一致' : `❌ ${comparison.filter(c => !c.pass).length} 個欄位不一致`}`,
      result,
    )

    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, message: `查詢失敗: ${e}` })
  }
})

// ─── 對帳查詢 ───────────────────────────────────────────────────────────────

router.post('/api/osm/meter-reconcile/query', async (req, res) => {
  const { machineName, source, date, dayBoundary, customStartTime } = req.body as {
    machineName?: string; source?: string; date?: string; dayBoundary?: string; customStartTime?: string
  }
  if (!machineName || !date) {
    return res.status(400).json({ ok: false, message: 'machineName / date 皆為必填' })
  }
  // 自訂起始時間（選填，格式 HH:mm）：只覆蓋 Game Record／Jackpot Abnormality 的查詢起點，
  // 不動 EGM Hourly Meter 那邊的整天邊界（meterDelta() 的 reset 偵測邏輯已經會自動退回原始累計值，
  // 不需要跟著調整）。用途：機台當天實際發生過 meter reset，Game Record 卻仍把 reset 前的紀錄
  // 算進整天加總，導致跟 meter 對不上——手動輸入實際 reset 時間，只narrow Game Record 這一側即可。
  // 已用真實案例驗證這支 API 確實支援秒級時間窗過濾（之前「dateTime[] 忽略時分秒」的結論是測試方法有誤）。
  const customStartMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(customStartTime ?? '')
  // 查詢範圍：'gaming'＝Gaming Day（本地 06:00 ~ 隔天 06:00），'calendar'＝自然日（00:00 ~ 24:00）。
  // 完整移植自 OSM/GCP 後台自己的 EGM Hourly Meter 頁面（Gaming Day 打勾 + Date Type 單選）——
  // 這支報表只支援這兩種整天邊界，做不到像 Game Record 那樣精準到分秒，所以拿掉原本的「查詢小時」
  // 輸入（那個輸入只會讓使用者誤以為 Coin Out 比對可以做到小時級精準，但 Game Record 側永遠是整天，
  // 兩邊範圍本來就對不齊）。
  const boundary = dayBoundary === 'calendar' ? 'calendar' : 'gaming'
  const dayStartHour = boundary === 'calendar' ? 0 : 6
  const apiDateType = boundary === 'calendar' ? '1' : '0'
  const env = parseMeterEnv((req.body as { env?: unknown })?.env)
  if (!env) return res.status(400).json({ ok: false, message: 'env 需為 qat 或 uat' })
  const profile: Profile = source === 'gcp' ? 'gcp' : 'osm'
  const cfg = loadMeterConfig(env, profile)
  if (!cfg.base_url) {
    return res.status(400).json({ ok: false, message: missingConfigMessage(env, profile) })
  }
  const channelId = channelOf(env, profile, cfg)
  if (!channelId) return res.status(400).json({ ok: false, message: `${env.toUpperCase()} 的 ${profile === 'osm' ? 'OSM（CP）' : 'GCP（NC）'} 後台沒有填 Channel ID` })
  const perfPath = profile === 'osm' ? '/egm/meter/egmPerformanceMeter' : '/egm/gsameter/egmPerformanceMeter'

  try {
    const num = (v: unknown) => { const n = parseFloat(String(v ?? '0')); return Number.isFinite(n) ? n : 0 }

    // ① EGM Hourly Meter — Coin In/Out/Jackpot Wins/Games Played 是「累計值（自上次 reset 起算，
    // 不是自當日 00:00 起算）」，直接拿原始讀數會跟 Game Record 的當日加總差好幾個數量級。
    // 已用真實資料驗證：(該整天最後一個 bucket − 第一個 bucket) 的差值才會等於整天 Game Record 加總
    // （不再用「查詢小時」挑 bucket，永遠取整天最後一筆，才能跟 Game Record 的整天範圍對齊）。
    // 若差值為負（代表當天發生過 reset），退回用最後一個 bucket 的原始累計值 best-effort。
    const hourParams = new URLSearchParams({
      page: '1', pageSize: '50',
      gameDay: boundary === 'gaming' ? '1' : '0', machineName: '', clientMachineName: machineName,
      dateType: apiDateType, channelId,
    })
    hourParams.append('date[]', date)
    hourParams.append('date[]', date)
    if (profile === 'gcp') hourParams.append('bgType', '2')
    const hourData = await meterGet(env, profile, cfg, `${perfPath.replace('egmPerformanceMeter', 'egmMeterHourList')}`, hourParams)
    const hourItems: Record<string, unknown>[] = hourData?.data?.items ?? []
    let meterRow: Record<string, unknown> | null = null
    let baselineRow: Record<string, unknown> | null = null
    const hourList: HourBucket[] = []
    let hourSkipped = 0
    let hourBuckets = 0   // v5.57.0：視窗內的 hourly bucket 數（0＝沒資料、1＝算不出差值，都不能判通過）
    const apiProblems = [apiProblem('EGM Hourly Meter', hourData, METER_VALID.hourly)].filter((x): x is string => !!x)
    const nextDate = nextDateStr(date)
    for (const row of hourItems) {
      const hourStr = (row.debug as { hourStr?: string } | undefined)?.hourStr ?? ''
      const [rowDate, rowTime] = hourStr.split(' ')
      const rowHour = parseInt(rowTime?.split(':')[0] ?? '-1', 10)
      if (rowHour < 0) continue
      // Gaming Day（06:00 起）會跨到隔天凌晨，日期字串不等於查詢日期也可能屬於同一個 gaming day
      // （隔天日期 + 小時 < 邊界起始小時，例如隔天 05:59 仍屬於今天開始的 gaming day）；
      // 自然日模式（00:00 起）沒有跨日問題，只接受日期字串等於查詢日期的 bucket。
      const inWindow = boundary === 'gaming'
        ? (rowDate === date && rowHour >= dayStartHour) || (rowDate === nextDate && rowHour < dayStartHour)
        : rowDate === date
      if (!inWindow) continue
      hourBuckets++
      // v5.84.0 局數分段定位用：欄位 2 在 hourly 是快照的 Unix 秒數；缺值就不收（定位會標不完整，不影響判定）
      // CodeX 5faf105：Number(null)／Number('') 是 0 → 先用 isNum 驗，缺值的快照計數、標不完整
      { const hb = hourBucketFromRow(row, hourStr, FIELD.gamesPlayed); if (hb) hourList.push(hb); else hourSkipped++ }
      if (!baselineRow) baselineRow = row // 保留整天範圍內第一個 bucket 當基準線
      meterRow = row // 保留最後一筆（整天範圍內最新的 bucket，才能跟 Game Record 的整天加總對齊）
    }
    // 找不到 hourly bucket 時 fallback 用當日 daily 總計（無基準線可減，直接用原始累計值）
    // ⚠️ v5.57.0（CodeX）：daily 只留作參考，判定一律 noData（meterVerdict），不能因為 fallback 有數字就判通過
    // CodeX 64cbfa8 [P2]：視窗內的 hourly bucket 缺必填 meter 數值 → API 無效（不能被 num() 轉成 0 判通過）
    { const miss = missingMeterFields([baselineRow, meterRow], { [FIELD.coinIn]: 'Coin In', [FIELD.coinOut]: 'Coin Out', [FIELD.jackpotWins]: 'Jackpot Wins', [FIELD.gamesPlayed]: 'Games Played' })
      if (miss.length) apiProblems.push(`EGM Hourly Meter 缺數值欄位（${miss.join('、')}）`) }
    const usedDaily = !meterRow
    if (!meterRow) {
      const dailyParams = new URLSearchParams({
        page: '1', pageSize: '10',
        gameDay: '1', isShowClient: '1', dateType: '0',
        machineName: '', clientMachineName: machineName, gameType: '',
        orderType: '0', channelId,
      })
      dailyParams.append('date[]', date)
      dailyParams.append('date[]', date)
      if (profile === 'gcp') dailyParams.append('bgType', '2')
      const dailyData = await meterGet(env, profile, cfg, perfPath, dailyParams)
      meterRow = dailyData?.data?.items?.[0] ?? null
      baselineRow = null
    }

    /** 目標小時的累計值減去當日第一個 bucket 的累計值；若為負（reset 過）就退回目標小時原始值。 */
    function meterDelta(field: string): number {
      if (!meterRow) return 0
      const target = num(meterRow[field])
      if (!baselineRow) return target
      const d = target - num(baselineRow[field])
      return d >= 0 ? d : target
    }

    const meter = meterRow ? (() => {
      const coinIn = meterDelta(FIELD.coinIn)
      const coinOut = meterDelta(FIELD.coinOut)
      const jackpotWins = meterDelta(FIELD.jackpotWins)
      // CP：WIN/LOSE = CoinIn − CoinOut − JackpotWins；NC：CoinIn − CoinOut（NC 的 Coin Out 已含 Jackpot Wins，Eric 11-13）
      const winLoss = coinIn - coinOut - winLossJackpotTerm(profile, jackpotWins)
      return {
        coinIn, coinOut, jackpotWins, winLoss,
        rtp: coinIn !== 0 ? (winLoss / coinIn) * 100 : 0, // 已驗證公式：RTP = WIN/LOSE ÷ CoinIn × 100
        gamesPlayed: meterDelta(FIELD.gamesPlayed),
      }
    })() : null

    // Game Record／Jackpot 用同一個「整天」邊界（跟 EGM Hourly Meter 的 boundary 選擇一致），
    // 用 ISO UTC 格式送出（已用實際後台頁面截到的 Network request 反推出真正格式：
    // dateTime[]=2026-07-26T22:00:00.000Z 這種 ISO UTC，本地 UTC+8 06:00 = UTC 前一天 22:00，
    // 先前用 "YYYY-MM-DD HH:mm:ss" 空白分隔字串完全被後端忽略時分秒，就是格式不對）。
    const customStartHour = customStartMatch ? parseInt(customStartMatch[1], 10) : null
    const customStartMin = customStartMatch ? parseInt(customStartMatch[2], 10) : null
    const windowStartIso = customStartMatch ? toUtcIso(date, customStartHour!, customStartMin!) : toUtcIso(date, dayStartHour)
    const windowEndIso = toUtcIso(nextDate, dayStartHour)
    const windowStartLocal = customStartMatch ? `${date} ${customStartMatch[0]}:00` : `${date} ${String(dayStartHour).padStart(2, '0')}:00:00`
    const windowEndLocal = `${nextDate} ${String(dayStartHour).padStart(2, '0')}:00:00`

    // ② Game Record 加總（gameRecordList 本身有 sumData，不用逐頁手動加總）
    const grParams = new URLSearchParams({
      clientMachineName: machineName, playerId: '', playerName: '', orderId: '',
      page: '1', pageSize: '1',
      dateTimeType: '0',
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL',
      bgType: profile === 'gcp' ? '2' : '0', dataType: '0', isall: 'false', channelId,
    })
    grParams.append('dateTime[]', windowStartIso)
    grParams.append('dateTime[]', windowEndIso)
    const grData = await meterPost(env, profile, cfg, '/egm/reports/gameRecordList', grParams)
    { const pr = apiProblem('Game Record', grData, METER_VALID.gameRecord); if (pr) apiProblems.push(pr) }
    const grSum = grData?.data?.sumData ?? {}
    // betRewardCredits = 泥碼下注額（sumData.bet_nima，已用真實 API 回應核對過欄位名稱）
    const gameRecord = {
      totalBet: num(grSum.bet), totalWin: num(grSum.win),
      betRewardCredits: num(grSum.bet_nima),
      recordCount: grData?.data?.total ?? 0,
    }

    // ③ Jackpot Abnormality（getHandPayRecord）——這支 API 的 clientMachineName 篩選會讓日期篩選失效
    // （實測：帶了機台名稱後，回傳的是該機台「最近 N 筆」handpay，完全忽略 dateTime[] 範圍），
    // 所以固定抓回後在這裡用 payoutTime 字串跟查詢時間窗（本地時間）做二次過濾。
    // 語意：Attendant Paid JP Meter（機台實際 meter 值）≠ 這支 API 的 handpay（QA 測試用人工派彩紀錄，
    // 不會真的寫進機台 meter）——已由使用者確認兩者是不同東西，數字相等純屬個案巧合。
    const jpParams = new URLSearchParams({
      clientMachineName: machineName, playerId: '', playerName: '', orderId: '',
      page: '1', pageSize: '200', dateTimeType: '0',
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,ALL',
      isall: 'false', channelId,
    })
    jpParams.append('dateTime[]', windowStartIso)
    jpParams.append('dateTime[]', windowEndIso)
    const jpData = await meterPost(env, profile, cfg, '/abnormality/getHandPayRecord', jpParams)
    { const pr = apiProblem('Jackpot Abnormality', jpData, METER_VALID.handPay); if (pr) apiProblems.push(pr) }
    type HandPayItem = { handpay?: number; payoutTime?: string; betTime?: string; username?: string }
    const jpItemsAll: HandPayItem[] = jpData?.data?.items ?? []
    const jpItems = jpItemsAll.filter(it => {
      const pt = it.payoutTime ?? ''
      return pt >= windowStartLocal && pt < windowEndLocal
    })
    const attendantPaidJp = jpItems.reduce((s, it) => s + num(it.handpay), 0)

    // ④ 公式比對
    // OSM：預期 Coin Out = Game Record 總 Win + Attendant Paid JP − Jackpot Wins
    // GCP：預期 Coin Out = Game Record 總 Win（GCP 的 Game Record 本身就含 Jackpot Wins + Attendant Paid JP）
    //
    // 公式修正歷程（同一天內來回修正了三次，記錄下來避免之後又走回頭路）：
    // 1. 最原始版本會扣 Jackpot Wins + Attendant Paid JP，Triple Treasure Pot（Jackpot Wins=75,685 非 0）
    //    這筆案例算出離譜負數，一度以為「不該扣任何東西」，改成 expectedCoinOut = Game Record 總 Win。
    // 2. 但 DFDC3（88 Fortunes）這筆案例（Jackpot Wins=5,000、Attendant Paid JP=0）用「不扣」的版本又不對：
    //    Game Record Payout（5,000）本身就已經含 Jackpot Wins，跟 meter 的 Coin Out（0）對不上。
    // 3. 關鍵差異：Jackpot Wins 有沒有被「同一筆」Game Record 記錄吃掉，取決於該次中獎走的是哪個派彩管道——
    //    DFDC3 直接把 Jackpot Wins 併入同一筆 Payout；Triple Treasure Pot 的 Jackpot Wins 沒有併入 Payout，
    //    而是另外走 Attendant Paid JP（getHandPayRecord 那 7 筆 handpay）。所以真正該比對的恆等式是：
    //      Game Record 總 Win + Attendant Paid JP = Jackpot Wins + Coin Out（= 後台的 TotalCoinOut）
    //    移項即得上面的公式，兩個真實案例都驗證通過：
    //      Triple Treasure Pot：4,870 + 75,685 − 75,685 = 4,870 = 實際 Coin Out ✓
    //      DFDC3：5,000 + 0 − 5,000 = 0 = 實際 Coin Out ✓
    //   ⚠️ 1014 用整個 Gaming Day 重查 DFDC3 (88 Fortunes) 07-28：7 筆、總 Win 5,055（其中 handpay 那筆 win 5,000），跟上面的 5,000 不同——當時驗證多半用了別的時間窗，沒再追（使用者 1014：公式維持現狀）
    //   1014 DFDC4（UAT）對不上是測試時手動加 handpay 改了數值、機台本身沒有對應紀錄（那筆 win＝2×19,002），不是公式問題；不符就判 fail、由人判斷
    const expectedCoinOut = profile === 'osm'
      ? gameRecord.totalWin + attendantPaidJp - (meter?.jackpotWins ?? 0)
      : gameRecord.totalWin
    const actualCoinOut = meter?.coinOut ?? 0
    const delta = actualCoinOut - expectedCoinOut
    // v5.57.0：沒資料／只有 1 個 bucket／沒活動／API 無效都不算通過（原本 0 = 0 會判「完全吻合」）
    const verdict = meterVerdict({ apiProblems, hourBuckets, usedDaily, meter, gameRecord, attendantPaidJp, handpayCount: jpItems.length, delta })
    const pass = verdict.pass

    // v5.84.0（Lusa 1113、CodeX 同意）：局數不同 → 逐段比 Meter 局數與 Game Record 筆數，定位對不上的區間。
    // 只在 fail 且局數有差時跑；查詢失敗不能當 0、也不改變上面的判定（CodeX）。
    let countDiag: (ReturnType<typeof summarizeCountDiag> & { intervals: IntervalResult[] }) | { error: string } | null = null
    const cd = countDelta({ meter, gameRecord, handpayCount: jpItems.length })
    if (verdict.status === 'fail' && cd !== null && cd !== 0) {
      try {
        if (hourList.length < 2) throw new Error('hourly 快照缺時間欄位，無法分段')
        const ws = Math.floor(Date.parse(windowStartIso) / 1000), we = Math.floor(Date.parse(windowEndIso) / 1000)
        const intervals = buildCountIntervals(hourList, ws, we)
        // CodeX 5a46e0b [P2]：自訂起點晚於最後一個快照 → 視窗內 0 個快照，明講無法定位，不能回「每段都對得上」
        if (intervals.length === 0) throw new Error('查詢範圍內沒有 hourly 快照，無法分段定位')
        const iso = (sec: number) => new Date(sec * 1000).toISOString()
        const results = await mapLimit(intervals, 4, async (iv): Promise<IntervalResult> => {
          const p = new URLSearchParams(grParams)
          p.delete('dateTime[]'); p.append('dateTime[]', iso(iv.start)); p.append('dateTime[]', iso(iv.end))
          try {
            const d = await meterPost(env, profile, cfg, '/egm/reports/gameRecordList', p)
            const pr = apiProblem('Game Record', d, METER_VALID.gameRecord)
            if (pr) return { ...iv, grCount: null, diff: null, error: pr }
            const n = Number(d?.data?.total ?? 0)
            return { ...iv, grCount: n, diff: iv.meterGames === null ? null : iv.meterGames - n }
          } catch (e) { return { ...iv, grCount: null, diff: null, error: String(e) } }
        })
        countDiag = { ...summarizeCountDiag(results, { meterGames: meter!.gamesPlayed, grCount: gameRecord.recordCount }, { skippedBuckets: hourSkipped }), intervals: results }
      } catch (e) { countDiag = { error: `分段定位失敗：${e instanceof Error ? e.message : String(e)}` } }
    }

    const result = {
      ok: true,
      machineName, source: profile, date, dayBoundary: boundary,
      customStartTime: customStartMatch ? customStartMatch[0] : null,
      pass, status: verdict.status, statusWhy: verdict.why, hourBuckets, usedDaily, expectedCoinOut, actualCoinOut, delta,
      attendantPaidJp,
      meter, gameRecord,
      jackpotAbnormality: { records: jpItems, sumHandpay: attendantPaidJp, count: jpItems.length },
      rawMeterRow: meterRow,
      countDiag,
    }

    addHistory(
      'meter-reconcile',
      `${machineName}（${env.toUpperCase()}・${profile.toUpperCase()}）`,
      meterHistoryLine(`${date}（${customStartMatch ? `${customStartMatch[0]} 起算` : boundary === 'gaming' ? 'Gaming Day 06:00起' : '自然日 00:00起'}）`, verdict, delta),
      result,
    )

    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, message: `查詢失敗: ${e}` })
  }
})

// ─── 盒子日誌逐局比對（v5.85.0，Lusa 1113）────────────────────────────────────
// 日誌在瀏覽器解析（shared/box-log-spins.ts），這裡只收精簡的每局清單；日誌本身不上傳、不保存。
// Game Record 抓整個查詢視窗的明細（不只局數對不上的時段：金額不同可能出現在局數剛好對上的時段，CodeX 1113）。

const BOX_GR_PAGE = 500
const BOX_GR_MAX = 20000
const BOX_SPINS_MAX = 50000

function sanitizeBoxLog(raw: unknown): Pick<BoxLogParse, 'spins' | 'coverage' | 'gaps' | 'badSecs'> | null {
  const o = raw as { spins?: unknown; coverage?: unknown; gaps?: unknown; badSecs?: unknown } | null
  if (!o || !Array.isArray(o.spins) || o.spins.length > BOX_SPINS_MAX) return null
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const numOrNull = (v: unknown) => (fin(v) ? v : null)
  const spins: BoxSpin[] = []
  for (const s of o.spins as Record<string, unknown>[]) {
    if (!s || !fin(s.spinid) || !fin(s.beginUs) || typeof s.beginRaw !== 'string') return null
    spins.push({
      spinid: s.spinid, beginRaw: s.beginRaw.slice(0, 32), beginUs: s.beginUs,
      bet: numOrNull(s.bet), win: numOrNull(s.win), ended: s.ended === true,
      endSends: fin(s.endSends) ? s.endSends : 0, endVariants: fin(s.endVariants) ? s.endVariants : 0,
      endSec: numOrNull(s.endSec), isError: s.isError === true, nima: fin(s.nima) ? s.nima : 0,
      resends: fin(s.resends) ? s.resends : 0, reconnects: fin(s.reconnects) ? s.reconnects : 0,
    })
  }
  const c = o.coverage as { start?: unknown; end?: unknown } | null
  const coverage = c && fin(c.start) && fin(c.end) ? { start: c.start, end: c.end } : null
  const gaps = Array.isArray(o.gaps)
    ? (o.gaps as Array<{ start?: unknown; end?: unknown }>).filter(g => g && fin(g.start) && fin(g.end)).map(g => ({ start: g.start as number, end: g.end as number }))
    : []
  const badSecs = Array.isArray(o.badSecs) ? (o.badSecs as unknown[]).filter(fin).slice(0, BOX_SPINS_MAX) : []
  return { spins, coverage, gaps, badSecs }
}

router.post('/api/osm/meter-reconcile/box-log', async (req, res) => {
  const { machineName, source, date, dayBoundary, customStartTime, log } = req.body as {
    machineName?: string; source?: string; date?: string; dayBoundary?: string; customStartTime?: string; log?: unknown
  }
  if (!machineName || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, message: 'machineName / date 皆為必填' })
  const parsed = sanitizeBoxLog(log)
  if (!parsed) return res.status(400).json({ ok: false, message: `盒子日誌解析結果格式不對（或超過 ${BOX_SPINS_MAX} 局）` })
  const env = parseMeterEnv((req.body as { env?: unknown })?.env)
  if (!env) return res.status(400).json({ ok: false, message: 'env 需為 qat 或 uat' })
  const profile: Profile = source === 'gcp' ? 'gcp' : 'osm'
  const cfg = loadMeterConfig(env, profile)
  if (!cfg.base_url) return res.status(400).json({ ok: false, message: missingConfigMessage(env, profile) })
  const channelId = channelOf(env, profile, cfg)
  if (!channelId) return res.status(400).json({ ok: false, message: `${env.toUpperCase()} 的後台沒有填 Channel ID` })

  // 視窗跟 /query 同一套算法
  const boundary = dayBoundary === 'calendar' ? 'calendar' : 'gaming'
  const dayStartHour = boundary === 'calendar' ? 0 : 6
  const cs = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(customStartTime ?? '')
  const startIso = cs ? toUtcIso(date, parseInt(cs[1], 10), parseInt(cs[2], 10)) : toUtcIso(date, dayStartHour)
  const endIso = toUtcIso(nextDateStr(date), dayStartHour)

  try {
    const base = new URLSearchParams({
      clientMachineName: machineName, playerId: '', playerName: '', orderId: '',
      page: '1', pageSize: String(BOX_GR_PAGE), dateTimeType: '0',
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL',
      bgType: profile === 'gcp' ? '2' : '0', dataType: '0', isall: 'false', channelId,
    })
    base.append('dateTime[]', startIso); base.append('dateTime[]', endIso)
    const byOrder = new Map<string, GrSpin>()
    const notes: string[] = []
    let total = -1
    let missingFields = 0
    for (let page = 1; ; page++) {
      const p = new URLSearchParams(base); p.set('page', String(page))
      const d = await meterPost(env, profile, cfg, '/egm/reports/gameRecordList', p)
      // 第 2 頁起 sumData 是空陣列（QAT 1113 實測）→ 只有第 1 頁用完整檢查，之後只驗 items／total
      const pr = page === 1
        ? apiProblem('Game Record', d, METER_VALID.gameRecord)
        : apiProblem('Game Record', d, (x: any) => Array.isArray(x?.data?.items) && Number.isFinite(Number(x?.data?.total)))
      // CodeX 1113：任何一頁失敗就不能拿殘缺明細判漏寫——直接回錯
      if (pr) return res.status(502).json({ ok: false, message: `Game Record 第 ${page} 頁查詢失敗：${pr}` })
      if (total < 0) {
        total = Number(d?.data?.total ?? 0)
        if (total > BOX_GR_MAX) return res.status(400).json({ ok: false, message: `這段時間 Game Record 有 ${total} 筆，超過 ${BOX_GR_MAX} 筆上限，請用自訂起始時間縮小範圍` })
      }
      const items: Record<string, unknown>[] = d?.data?.items ?? []
      for (const it of items) {
        const orderId = String(it.order_id ?? '')
        // CodeX 4581462：bet／win 也要驗，null 被 Number() 轉成 0 會誤判金額
        if (!orderId || !isNum(it.spinid) || !isNum(it.box_begin_time) || !isNum(it.payout_time) || !isNum(it.bet) || !isNum(it.win)) { missingFields++; continue }
        byOrder.set(orderId, {
          orderId, spinid: Number(it.spinid), boxBeginTime: Number(it.box_begin_time),
          bet: Number(it.bet), win: Number(it.win), payoutSec: Number(it.payout_time),
        })
      }
      if (items.length < BOX_GR_PAGE || page * BOX_GR_PAGE >= total) break
    }
    // 分頁期間有新紀錄寫入會讓頁面位移：用 order_id 去重後數量對不上 total 就標不完整（CodeX 1113）
    const got = byOrder.size + missingFields
    const complete = got === total && missingFields === 0
    if (missingFields) notes.push(`${missingFields} 筆 Game Record 缺 spinid／開局時間／結算時間／押注／贏分，沒辦法逐局比對`)
    if (got !== total) notes.push(`Game Record 總筆數 ${total}，分頁實際抓到 ${got} 筆（查詢期間可能有新紀錄寫入），請重查一次`)
    const window = { start: Date.parse(startIso) / 1000, end: Date.parse(endIso) / 1000 }
    const cmp = compareBoxLog(parsed, [...byOrder.values()], window, { grComplete: complete })
    res.json({ ok: true, complete, grTotal: total, window, items: cmp.items, counts: cmp.counts, notes: [...notes, ...cmp.notes] })
  } catch (e) {
    res.status(500).json({ ok: false, message: `盒子日誌比對失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

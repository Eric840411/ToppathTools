import { Router } from 'express'
import { db, addHistory } from '../shared.js'

export const router = Router()

// ─── Performance Meter 對帳 ──────────────────────────────────────────────────
// 比對 OSM/GCP EGM Metering 的 Coin Out 與 Game Record + Jackpot Abnormality 加總，
// 驗證兩邊數字是否完全一致。憑證存在 meter_reconcile_config（key 前綴 osm_/gcp_ 區分兩組後台）。

type Profile = 'osm' | 'gcp'

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

function loadMeterConfig(profile: Profile): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meter_reconcile_config WHERE key LIKE ?').all(`${profile}_%`) as { key: string; value: string }[]
  const cfg: Record<string, string> = {}
  for (const r of rows) cfg[r.key.slice(profile.length + 1)] = r.value
  return cfg
}

function saveMeterConfigValue(profile: Profile, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO meter_reconcile_config (key, value) VALUES (?, ?)').run(`${profile}_${key}`, value)
}

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

async function meterLogin(profile: Profile, cfg: Record<string, string>): Promise<string | null> {
  const baseUrl = (cfg.base_url || 'https://backendservertest.osmslot.org').replace(/\/$/, '')
  try {
    const r = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: cfg.origin || '', referer: cfg.origin ? `${cfg.origin}/` : '' },
      body: JSON.stringify({ username: cfg.login_username || '', password: cfg.login_password || '' }),
    })
    const d = await r.json() as { code?: number; data?: { token?: string; lastLoginTime?: number } }
    if (d.code === 20000 && d.data?.token) {
      saveMeterConfigValue(profile, 'token', d.data.token)
      saveMeterConfigValue(profile, 'lastlogintime', String(d.data.lastLoginTime ?? ''))
      return d.data.token
    }
    return null
  } catch { return null }
}

/** GET 呼叫，token 過期（code 40200）時自動重新登入一次再重試。 */
async function meterGet(profile: Profile, cfg: Record<string, string>, path: string, params: URLSearchParams): Promise<any> {
  const baseUrl = (cfg.base_url || 'https://backendservertest.osmslot.org').replace(/\/$/, '')
  let headers = meterHeaders(cfg)
  let r = await fetch(`${baseUrl}${path}?${params}`, { method: 'GET', headers })
  let d = await r.json() as { code?: number }
  if (d.code === 40200) {
    const newToken = await meterLogin(profile, cfg)
    if (newToken) {
      cfg = loadMeterConfig(profile)
      headers = meterHeaders(cfg)
      r = await fetch(`${baseUrl}${path}?${params}`, { method: 'GET', headers })
      d = await r.json()
    }
  }
  return d
}

/** POST 呼叫（gameRecordList 是 POST + query string 參數的舊風格 API）。*/
async function meterPost(profile: Profile, cfg: Record<string, string>, path: string, params: URLSearchParams): Promise<any> {
  const baseUrl = (cfg.base_url || 'https://backendservertest.osmslot.org').replace(/\/$/, '')
  let headers = meterHeaders(cfg)
  let r = await fetch(`${baseUrl}${path}?${params}`, { method: 'POST', headers })
  let d = await r.json() as { code?: number }
  if (d.code === 40200) {
    const newToken = await meterLogin(profile, cfg)
    if (newToken) {
      cfg = loadMeterConfig(profile)
      headers = meterHeaders(cfg)
      r = await fetch(`${baseUrl}${path}?${params}`, { method: 'POST', headers })
      d = await r.json()
    }
  }
  return d
}

// ─── 設定 API ───────────────────────────────────────────────────────────────

// GET /api/osm/meter-reconcile/config?profile=osm|gcp — 讀取設定（密碼/token 不回傳明文）
router.get('/api/osm/meter-reconcile/config', (req, res) => {
  const profile = (req.query.profile as string) === 'gcp' ? 'gcp' : 'osm'
  const cfg = loadMeterConfig(profile)
  res.json({
    ok: true,
    base_url: cfg.base_url || '',
    origin: cfg.origin || '',
    channelId: cfg.channel_id || '',
    login_username: cfg.login_username || '',
    hasPassword: !!cfg.login_password,
    hasToken: !!cfg.token,
  })
})

// PUT /api/osm/meter-reconcile/config — 儲存設定
router.put('/api/osm/meter-reconcile/config', (req, res) => {
  const { profile, base_url, origin, channelId, login_username, login_password } = req.body as {
    profile?: string; base_url?: string; origin?: string; channelId?: string
    login_username?: string; login_password?: string
  }
  if (profile !== 'osm' && profile !== 'gcp') return res.status(400).json({ ok: false, message: 'profile 需為 osm 或 gcp' })
  if (typeof base_url === 'string') saveMeterConfigValue(profile, 'base_url', base_url)
  if (typeof origin === 'string') saveMeterConfigValue(profile, 'origin', origin)
  if (typeof channelId === 'string') saveMeterConfigValue(profile, 'channel_id', channelId)
  if (typeof login_username === 'string') saveMeterConfigValue(profile, 'login_username', login_username)
  if (typeof login_password === 'string' && login_password) saveMeterConfigValue(profile, 'login_password', login_password)
  res.json({ ok: true })
})

// POST /api/osm/meter-reconcile/test — 測試登入
router.post('/api/osm/meter-reconcile/test', async (req, res) => {
  const profile = (req.body as { profile?: string })?.profile === 'gcp' ? 'gcp' : 'osm'
  const cfg = loadMeterConfig(profile)
  if (!cfg.base_url) return res.status(400).json({ ok: false, message: '尚未設定後台網址' })
  const token = await meterLogin(profile, cfg)
  if (token) res.json({ ok: true, message: '✅ 登入成功' })
  else res.status(400).json({ ok: false, message: '登入失敗，請確認帳號密碼與網址設定' })
})

// ─── Egm DayCount 對帳（比對 gameCount 彙總報表 vs playerMachineCount 逐筆回推）─────
// 兩支 API 皆已用真實 Network request 截圖確認（channelId=873，OSM backendservertest.osmslot.org）。
// gameCount：一天一列的彙總報表（Egm DayCount）；playerMachineCount：player+machine 逐筆列（User Detail）。
router.post('/api/osm/meter-reconcile/egm-daycount', async (req, res) => {
  const { date, dayBoundary, allChannels } = req.body as {
    date?: string; dayBoundary?: string; allChannels?: boolean
  }
  if (!date) return res.status(400).json({ ok: false, message: 'date 為必填' })
  const boundary = dayBoundary === 'calendar' ? 'calendar' : 'gaming'
  const apiDateType = boundary === 'calendar' ? '1' : '0'
  const isall = allChannels ? 'true' : 'false' // 目前只是照後台原始請求原樣傳送，實測沒有實際效果（見下方說明）
  const cfg = loadMeterConfig('osm')
  if (!cfg.base_url) {
    return res.status(400).json({ ok: false, message: '尚未設定 OSM 後台連線資訊，請先在下方「後台設定」填寫' })
  }
  const channelId = cfg.channel_id || '873'
  // playerstudioid 是後台 Player Channel 篩選，這組固定清單已用真實查詢驗證可以精準對上「np +11」
  // 那個預設範圍（跟後台截圖的 Egm DayCount／User Detail 完全吻合）。
  // ⚠️ 後台「All」勾選那個模式（Player Channel 欄位會變灰色）目前沒有實作——試過把 playerstudioid
  // 整個拿掉，結果 gameCount 直接回傳空資料（0），不是「不篩選」的意思，代表這個參數其實是必填，
  // 拿掉不等於「全部」；要支援 All 模式，需要使用者實際勾選後台的 All 再截一次 Network request
  // 才知道真正該傳什麼，這裡先不猜，allChannels 這個輸入目前沒有效果。
  const playerstudioid = 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,ALL'

  try {
    const num = (v: unknown) => { const n = parseFloat(String(v ?? '0')); return Number.isFinite(n) ? n : 0 }

    // ① Egm DayCount（gameCount）—— 一天一列彙總，只有一天時 items[0] 就是那一天的值。
    // 注意：這支 API 的 sumData 跟 items[] 範圍不一致（已用真實查詢驗證：查單一天 total=1，
    // 但 sumData 的數字卻是 items[0] 的好幾倍，看起來 sumData 沒有正確套用日期篩選）——
    // 所以只有一天時改用 items[0]，不要相信 sumData；playerMachineCount 的 sumData 沒有這個問題。
    const dcParams = new URLSearchParams({
      gameType: '', page: '1', pageSize: '10',
      dateType: apiDateType, version: '', bgType: '0', isall, channelId,
    })
    if (playerstudioid) dcParams.set('playerstudioid', playerstudioid)
    dcParams.append('dateTime[]', date); dcParams.append('dateTime[]', date)
    dcParams.append('date[]', date); dcParams.append('date[]', date)
    const dc = await meterGet('osm', cfg, '/egm/reports/gameCount', dcParams)
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
      gameType: '', clientMachineName: '', playerId: '', playerName: '',
      page: '1', pageSize: '500', dateType: apiDateType, version: '', bgType: '0', isall, channelId,
    })
    udParams.append('dateTime[]', date); udParams.append('dateTime[]', date)
    udParams.append('date[]', date); udParams.append('date[]', date)
    const ud = await meterGet('osm', cfg, '/egm/reports/playerMachineCount', udParams)
    type UdRow = {
      playerId?: string; playerName?: string; clientMachineName?: string
      win?: string; betTimes?: string; bet?: string
      machineIn?: string; machineOut?: string; playerWin?: string
    }
    const udItemsAll: UdRow[] = ud?.data?.items ?? []
    const udTotal: number = ud?.data?.total ?? udItemsAll.length
    const udTruncated = udTotal > udItemsAll.length // pageSize=500 不夠裝下全部時的保底警告
    const udSum = ud?.data?.sumData ?? {}

    const betUserSet = new Set(udItemsAll.filter(r => num(r.betTimes) > 0).map(r => r.playerId))
    const userDetail = {
      betUsers: betUserSet.size, betNumber: num(udSum.betTimes), betAmount: num(udSum.bet),
      transferIn: num(udSum.machineIn), transferOut: num(udSum.machineOut),
      winOrLose: num(udSum.platformWin), winLoseRatio: num(udSum.platformWinPercent),
      jackpotAmount: egmDayCount.jackpotAmount, // playerMachineCount 沒有這個欄位，沿用 gameCount 的值顯示，不參與比對
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
    const comparison = fields.map(f => {
      const a = (egmDayCount as any)[f.key] as number
      const b = (userDetail as any)[f.key] as number
      const delta = a - b
      return { key: f.key, label: f.label, egmDayCount: a, userDetail: b, delta, pass: Math.abs(delta) < 0.005 }
    })
    const allPass = comparison.every(c => c.pass)

    const result = {
      ok: true, date, dayBoundary: boundary, allChannels: !!allChannels,
      allPass, comparison, egmDayCount, userDetail,
      udTruncated, udItems: udItemsAll,
    }

    addHistory(
      'meter-reconcile',
      `Egm DayCount 對帳（OSM）`,
      `${date}（${boundary === 'gaming' ? 'Gaming Day' : '自然日'}${allChannels ? '／All' : ''}）— ${allPass ? '✅ 一致' : `❌ ${comparison.filter(c => !c.pass).length} 個欄位不一致`}`,
      result,
    )

    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, message: `查詢失敗: ${e}` })
  }
})

// ─── 對帳查詢 ───────────────────────────────────────────────────────────────

router.post('/api/osm/meter-reconcile/query', async (req, res) => {
  const { machineName, source, date, dayBoundary } = req.body as {
    machineName?: string; source?: string; date?: string; dayBoundary?: string
  }
  if (!machineName || !date) {
    return res.status(400).json({ ok: false, message: 'machineName / date 皆為必填' })
  }
  // 查詢範圍：'gaming'＝Gaming Day（本地 06:00 ~ 隔天 06:00），'calendar'＝自然日（00:00 ~ 24:00）。
  // 完整移植自 OSM/GCP 後台自己的 EGM Hourly Meter 頁面（Gaming Day 打勾 + Date Type 單選）——
  // 這支報表只支援這兩種整天邊界，做不到像 Game Record 那樣精準到分秒，所以拿掉原本的「查詢小時」
  // 輸入（那個輸入只會讓使用者誤以為 Coin Out 比對可以做到小時級精準，但 Game Record 側永遠是整天，
  // 兩邊範圍本來就對不齊）。
  const boundary = dayBoundary === 'calendar' ? 'calendar' : 'gaming'
  const dayStartHour = boundary === 'calendar' ? 0 : 6
  const apiDateType = boundary === 'calendar' ? '1' : '0'
  const profile: Profile = source === 'gcp' ? 'gcp' : 'osm'
  const cfg = loadMeterConfig(profile)
  if (!cfg.base_url) {
    return res.status(400).json({ ok: false, message: `尚未設定 ${profile.toUpperCase()} 後台連線資訊，請先在下方「後台設定」填寫` })
  }
  const channelId = cfg.channel_id || (profile === 'osm' ? '873' : '892')
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
    const hourData = await meterGet(profile, cfg, `${perfPath.replace('egmPerformanceMeter', 'egmMeterHourList')}`, hourParams)
    const hourItems: Record<string, unknown>[] = hourData?.data?.items ?? []
    let meterRow: Record<string, unknown> | null = null
    let baselineRow: Record<string, unknown> | null = null
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
      if (!baselineRow) baselineRow = row // 保留整天範圍內第一個 bucket 當基準線
      meterRow = row // 保留最後一筆（整天範圍內最新的 bucket，才能跟 Game Record 的整天加總對齊）
    }
    // 找不到 hourly bucket 時 fallback 用當日 daily 總計（無基準線可減，直接用原始累計值）
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
      const dailyData = await meterGet(profile, cfg, perfPath, dailyParams)
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
      const winLoss = coinIn - coinOut - jackpotWins // 已驗證公式：WIN/LOSE = CoinIn − CoinOut − JackpotWins
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
    const windowStartIso = toUtcIso(date, dayStartHour)
    const windowEndIso = toUtcIso(nextDate, dayStartHour)
    const windowStartLocal = `${date} ${String(dayStartHour).padStart(2, '0')}:00:00`
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
    const grData = await meterPost(profile, cfg, '/egm/reports/gameRecordList', grParams)
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
    const jpData = await meterPost(profile, cfg, '/abnormality/getHandPayRecord', jpParams)
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
    const expectedCoinOut = profile === 'osm'
      ? gameRecord.totalWin + attendantPaidJp - (meter?.jackpotWins ?? 0)
      : gameRecord.totalWin
    const actualCoinOut = meter?.coinOut ?? 0
    const delta = actualCoinOut - expectedCoinOut
    const pass = Math.abs(delta) < 0.005 // 浮點誤差容忍

    const result = {
      ok: true,
      machineName, source: profile, date, dayBoundary: boundary,
      pass, expectedCoinOut, actualCoinOut, delta,
      attendantPaidJp,
      meter, gameRecord,
      jackpotAbnormality: { records: jpItems, sumHandpay: attendantPaidJp, count: jpItems.length },
      rawMeterRow: meterRow,
    }

    addHistory(
      'meter-reconcile',
      `${machineName}（${profile.toUpperCase()}）`,
      `${date}（${boundary === 'gaming' ? 'Gaming Day 06:00起' : '自然日 00:00起'}）— ${pass ? '✅ 一致' : `❌ 不一致（差值 ${delta.toFixed(2)}）`}`,
      result,
    )

    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, message: `查詢失敗: ${e}` })
  }
})

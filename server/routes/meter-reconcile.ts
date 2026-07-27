import { Router } from 'express'
import { db, addHistory } from '../shared.js'

export const router = Router()

// ─── Performance Meter 對帳 ──────────────────────────────────────────────────
// 比對 OSM/GCP EGM Metering 的 Coin Out 與 Game Record + Jackpot Abnormality 加總，
// 驗證兩邊數字是否完全一致。憑證存在 meter_reconcile_config（key 前綴 osm_/gcp_ 區分兩組後台）。

type Profile = 'osm' | 'gcp'

/** gameRecordList / getHandPayRecord 的 dateTime[] 上界似乎是「不含當天」，
 * 同一天當 start/end 會查到 0 筆；要傳 date+1 才能真正包含當天資料（已用真實資料驗證）。 */
function nextDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
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

// ─── 對帳查詢 ───────────────────────────────────────────────────────────────

router.post('/api/osm/meter-reconcile/query', async (req, res) => {
  const { machineName, source, date, hour } = req.body as {
    machineName?: string; source?: string; date?: string; hour?: string
  }
  if (!machineName || !date || !hour) {
    return res.status(400).json({ ok: false, message: 'machineName / date / hour 皆為必填' })
  }
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
    // 已用真實資料驗證：(目標小時 bucket − 當日第一個 bucket) 的差值才會等於當日 Game Record 加總。
    // 若差值為負（代表當天發生過 reset），退回用目標小時的原始累計值 best-effort。
    const hourParams = new URLSearchParams({
      page: '1', pageSize: '50',
      gameDay: '1', machineName: '', clientMachineName: machineName,
      dateType: '0', channelId,
    })
    hourParams.append('date[]', date)
    hourParams.append('date[]', date)
    if (profile === 'gcp') hourParams.append('bgType', '2')
    const hourData = await meterGet(profile, cfg, `${perfPath.replace('egmPerformanceMeter', 'egmMeterHourList')}`, hourParams)
    const hourItems: Record<string, unknown>[] = hourData?.data?.items ?? []
    const targetHour = parseInt(hour.split(':')[0] || '0', 10)
    let meterRow: Record<string, unknown> | null = null
    let baselineRow: Record<string, unknown> | null = null
    for (const row of hourItems) {
      const hourStr = (row.debug as { hourStr?: string } | undefined)?.hourStr ?? ''
      const [rowDate, rowTime] = hourStr.split(' ')
      if (rowDate !== date) continue // API 可能回傳跨日的 bucket，日期不符的一律跳過
      const rowHour = parseInt(rowTime?.split(':')[0] ?? '-1', 10)
      if (rowHour < 0) continue
      if (!baselineRow) baselineRow = row // 保留當日第一個 bucket 當基準線
      if (rowHour <= targetHour) meterRow = row // 保留最後一個 <= 目標小時的 bucket
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

    // ② Game Record 加總（gameRecordList 本身有 sumData，不用逐頁手動加總）
    const grParams = new URLSearchParams({
      clientMachineName: machineName, playerId: '', playerName: '', orderId: '',
      page: '1', pageSize: '1',
      dateTimeType: '0',
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL',
      bgType: profile === 'gcp' ? '2' : '0', dataType: '0', isall: 'false', channelId,
    })
    grParams.append('dateTime[]', date)
    grParams.append('dateTime[]', nextDateStr(date))
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
    // 所以固定抓回後在這裡用 payoutTime 字串前綴做二次過濾，取當日真正的資料。
    // 語意：這支 API 的 handpay 對應的是「Attendant Paid JP」（需要人工核發的手付獎金），
    // 不是「Jackpot Wins」本身——Jackpot Wins 已經在 EGM Performance Meter 的欄位 29 裡（已用公式驗證），
    // 這兩者是公式裡不同的兩項，不能互相取代。
    const jpParams = new URLSearchParams({
      clientMachineName: machineName, playerId: '', playerName: '', orderId: '',
      page: '1', pageSize: '200', dateTimeType: '0',
      playerstudioid: 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,ALL',
      isall: 'false', channelId,
    })
    jpParams.append('dateTime[]', date)
    jpParams.append('dateTime[]', nextDateStr(date))
    const jpData = await meterPost(profile, cfg, '/abnormality/getHandPayRecord', jpParams)
    type HandPayItem = { handpay?: number; payoutTime?: string; betTime?: string; username?: string }
    const jpItemsAll: HandPayItem[] = jpData?.data?.items ?? []
    const jpItems = jpItemsAll.filter(it => (it.payoutTime ?? '').startsWith(date))
    const attendantPaidJp = jpItems.reduce((s, it) => s + num(it.handpay), 0)

    // ④ 公式比對
    // OSM：預期 Coin Out = Game Record 總 Win − Jackpot Wins（meter 欄位 29）− Attendant Paid JP（getHandPayRecord 當日 handpay 加總）
    // GCP：預期 Coin Out = Game Record 總 Win（含 Jackpot Wins + Attendant Paid JP，不用另外扣）
    const expectedCoinOut = profile === 'osm'
      ? gameRecord.totalWin - (meter?.jackpotWins ?? 0) - attendantPaidJp
      : gameRecord.totalWin
    const actualCoinOut = meter?.coinOut ?? 0
    const delta = actualCoinOut - expectedCoinOut
    const pass = Math.abs(delta) < 0.005 // 浮點誤差容忍

    const result = {
      ok: true,
      machineName, source: profile, date, hour,
      pass, expectedCoinOut, actualCoinOut, delta,
      attendantPaidJp,
      meter, gameRecord,
      jackpotAbnormality: { records: jpItems, sumHandpay: attendantPaidJp, count: jpItems.length },
      rawMeterRow: meterRow,
    }

    addHistory(
      'meter-reconcile',
      `${machineName}（${profile.toUpperCase()}）`,
      `${date} ${hour} — ${pass ? '✅ 一致' : `❌ 不一致（差值 ${delta.toFixed(2)}）`}`,
      result,
    )

    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, message: `查詢失敗: ${e}` })
  }
})

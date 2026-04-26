/**
 * server/routes/osm.ts
 * All /api/osm/*, /api/luckylink/*, /api/toppath/* routes,
 * plus OSM sync state and alert logic shared with index.ts cron.
 */
import { Router } from 'express'
import cron from 'node-cron'
import { z } from 'zod'
import vm from 'vm'
import { chromium } from 'playwright'
import { fetchAllGMList } from '../lib/pinus-client.js'
import {
  db,
  addHistory,
  getClientIP,
  getUser,
  log,
  getLarkToken,
  parseLarkSheetUrl,
  heavyLimiter,
  OSM_VERSION_COMPONENTS,
  OSM_VERSION_ORDER,
  LUCKYLINK_VERSION_COMPONENTS,
  LUCKYLINK_VERSION_ORDER,
} from '../shared.js'
import { callGeminiWithRotation } from './gemini.js'

export const router = Router()

// ─── Toppath Version constants ─────────────────────────────────────────────────

export const TOPPATH_VERSION_COMPONENTS = [
  { name: 'GM',     path: 'deployment-version-g-admin.json' },
  { name: 'API',    path: 'deployment-version-g-api.json' },
  { name: 'GW',     path: 'deployment-version-g-gw.json' },
  { name: 'TG-API', path: 'deployment-version-g-tg-api.json' },
]

// ─── Alert Config Helpers ─────────────────────────────────────────────────────

export const getAlertConfig = () => {
  const rows = db.prepare('SELECT key, value FROM alert_config').all() as { key: string; value: string }[]
  const cfg: Record<string, string> = {}
  for (const r of rows) cfg[r.key] = r.value
  return {
    enabled: cfg['enabled'] === 'true',
    schedule: cfg['schedule'] ?? '0 9 * * *',
  }
}

export const setAlertConfigKey = (key: string, value: string) => {
  db.prepare('INSERT OR REPLACE INTO alert_config (key, value) VALUES (?, ?)').run(key, value)
}

// ─── OSM Channel types and helpers ───────────────────────────────────────────

export interface OsmChannel {
  name: string
  channelId: number
  username: string
  password: string
  origin: string
}

export interface OsmMachine {
  id: string
  channelId: string
  machineName: string
  machineType: string
  version: string
  /** API: online | offline 等，小寫正規化後回傳 */
  onlineState: string
}

export interface OsmChannelResult {
  name: string
  channelId: number
  machines: OsmMachine[]
  error?: string
  syncTime: string
}

export function readOsmChannels(): OsmChannel[] {
  const names = (process.env.OSM_CHANNELS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return names.map(name => ({
    name,
    channelId: parseInt(process.env[`OSM_CHANNEL_${name}_ID`] ?? '0'),
    username: process.env[`OSM_CHANNEL_${name}_USERNAME`] ?? '',
    password: process.env[`OSM_CHANNEL_${name}_PASSWORD`] ?? '',
    origin: process.env[`OSM_CHANNEL_${name}_ORIGIN`] ?? '',
  }))
}

export async function syncOsmChannel(channel: OsmChannel): Promise<OsmChannelResult> {
  const baseUrl = process.env.OSM_BASE_URL ?? 'https://backendserver.osmplay.com'
  const syncTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })

  try {
    const loginResp = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'backendserver.osmplay.com',
        'Origin': channel.origin,
        'Referer': `${channel.origin}/`,
      },
      body: new URLSearchParams({ username: channel.username, password: channel.password }).toString(),
    })
    const loginData = await loginResp.json() as { data?: { token?: string }; msg?: string }
    const token = loginData.data?.token
    if (!token) throw new Error(`登入失敗：${loginData.msg ?? '無法取得 token'}`)

    const listResp = await fetch(
      `${baseUrl}/egm/floor/egmList?page=1&pageSize=500&isShowClient=1&searchName=&channelId=${channel.channelId}`,
      {
        headers: {
          'Host': 'backendserver.osmplay.com',
          'Origin': channel.origin,
          'Referer': `${channel.origin}/`,
          'token': token,
        },
      },
    )
    const listData = await listResp.json() as {
      data?: { items?: Array<Record<string, unknown>> }
      msg?: string
    }
    const machines = (listData.data?.items ?? []).map(item => {
      const raw = String((item as { onlineState?: unknown }).onlineState ?? '').trim().toLowerCase()
      let onlineState = 'unknown'
      if (raw === 'online' || raw === '1' || raw === 'true') onlineState = 'online'
      else if (raw === 'offline' || raw === '0' || raw === 'false') onlineState = 'offline'
      else if (raw) onlineState = raw

      return {
        id: String(item.id ?? ''),
        channelId: String(item.channelId ?? ''),
        machineName: String(item.machineName ?? ''),
        machineType: String((item as Record<string, unknown>).machineType ?? ''),
        version: String(item.version ?? ''),
        onlineState,
      }
    })

    const onlineCnt = machines.filter(m => m.onlineState === 'online').length
    const offlineCnt = machines.filter(m => m.onlineState === 'offline').length
    const unknownCnt = machines.length - onlineCnt - offlineCnt
    console.log(
      `[OSM] ${channel.name} 同步完成：${machines.length} 台 (online ${onlineCnt}, offline ${offlineCnt}, other ${unknownCnt})`,
    )
    console.log(
      `[OSM] ${channel.name} onlineState sample:`,
      machines.slice(0, 5).map(m => m.onlineState),
    )
    return { name: channel.name, channelId: channel.channelId, machines, syncTime }
  } catch (err) {
    console.error(`[OSM] ${channel.name} 同步失敗：`, err)
    return { name: channel.name, channelId: channel.channelId, machines: [], error: String(err), syncTime }
  }
}

// ─── OSM Sync Guard ───────────────────────────────────────────────────────────
export let osmSyncing = false
/** Cache of last OSM channel sync results, used by alert logic. */
export let osmChannelCache: OsmChannelResult[] = []

// ─── Alert send logic ─────────────────────────────────────────────────────────

export const sendLarkAlert = async () => {
  const webhookUrl = process.env.LARK_WEBHOOK_URL
    ?? `https://open.larksuite.com/open-apis/bot/v2/hook/${process.env.LARK_WEBHOOK_ID}`

  const targetRows = db.prepare('SELECT machineType, category, targetVersion FROM machine_type_targets').all() as { machineType: string; category: string; targetVersion: string }[]
  const targets: Record<string, Record<string, string>> = {}
  for (const r of targetRows) {
    if (!targets[r.machineType]) targets[r.machineType] = {}
    targets[r.machineType][r.category] = r.targetVersion
  }

  const lines: string[] = []
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
  lines.push(`📅 ${now}`)

  // ── OSM 元件版本 ──
  try {
    const channels = readOsmChannels()
    if (channels.length > 0) {
      const channel = channels[0]
      const baseUrl = process.env.OSM_BASE_URL ?? 'https://backendserver.osmplay.com'
      const loginResp = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': channel.origin, 'Referer': `${channel.origin}/` },
        body: new URLSearchParams({ username: channel.username, password: channel.password }).toString(),
      })
      const loginData = await loginResp.json() as { data?: { token?: string } }
      const token = loginData.data?.token
      if (token) {
        const histResp = await fetch(
          `${baseUrl}/manage/updateVersionHistoryRecord?page=1&pageSize=25&type=0&channelId=${channel.channelId}`,
          { method: 'POST', headers: { 'Origin': channel.origin, 'Referer': `${channel.origin}/`, 'token': token } }
        )
        const histData = await histResp.json() as { code?: number; data?: Record<string, string> }
        if (histData.code === 20000 && histData.data) {
          const dataMap = histData.data
          const osmOffTarget: string[] = []
          for (const [idx, name] of Object.entries(OSM_VERSION_COMPONENTS)) {
            const ver = dataMap[String(idx)]
            if (!ver) continue
            const target = targets[name]?.['OSM']
            if (target && ver !== target) osmOffTarget.push(`  • ${name}: ${ver} → 目標 ${target}`)
          }
          if (osmOffTarget.length > 0) {
            lines.push('\n🔧 OSM 元件版本未達標：')
            lines.push(...osmOffTarget)
          } else if (Object.keys(targets).some(k => targets[k]['OSM'])) {
            lines.push('\n🔧 OSM 元件版本：✅ 全部達標')
          }
        }
      }
    }
  } catch { /* 忽略取得失敗 */ }

  // ── LuckyLink 元件版本 ──
  try {
    const baseUrl = process.env.LUCKYLINK_BASE_URL ?? 'https://luckylink-prod-backendserver.cliveslot.com'
    const username = process.env.LUCKYLINK_USERNAME ?? ''
    const password = process.env.LUCKYLINK_PASSWORD ?? ''
    const origin = process.env.LUCKYLINK_ORIGIN ?? baseUrl
    let token: string | undefined
    if (username && password) {
      const loginResp = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': origin, 'Referer': `${origin}/` },
        body: new URLSearchParams({ username, password }).toString(),
      })
      const loginData = await loginResp.json() as { data?: { token?: string } }
      token = loginData.data?.token
    }
    const headers: Record<string, string> = { 'Origin': origin, 'Referer': `${origin}/` }
    if (token) headers['token'] = token
    const histResp = await fetch(`${baseUrl}/manage/updateVersionHistoryRecord?page=1&pageSize=25&type=0`, { method: 'POST', headers })
    const histData = await histResp.json() as { code?: number; data?: Record<string, string> }
    if (histData.code === 20000 && histData.data) {
      const dataMap = histData.data
      const llOffTarget: string[] = []
      for (const [idx, name] of Object.entries(LUCKYLINK_VERSION_COMPONENTS)) {
        const ver = dataMap[idx]
        if (!ver) continue
        const target = targets[name]?.['LuckyLink']
        if (target && ver !== target) llOffTarget.push(`  • ${name}: ${ver} → 目標 ${target}`)
      }
      if (llOffTarget.length > 0) {
        lines.push('\n🍀 LuckyLink 元件版本未達標：')
        lines.push(...llOffTarget)
      } else if (Object.keys(targets).some(k => targets[k]['LuckyLink'])) {
        lines.push('\n🍀 LuckyLink 元件版本：✅ 全部達標')
      }
    }
  } catch { /* 忽略取得失敗 */ }

  // ── Toppath 元件版本 ──
  try {
    const tpBase = (process.env.TOPPATH_VERSION_BASE_URL ?? 'https://staticpublic.osmslot.org/qat/version-info').replace(/\/$/, '')
    const tpResults = await Promise.all(
      TOPPATH_VERSION_COMPONENTS.map(async ({ name, path }) => {
        try {
          const r = await fetch(`${tpBase}/${path}`)
          const d = await r.json() as { version?: string }
          return { name, version: d.version ?? '' }
        } catch { return { name, version: '' } }
      })
    )
    const tpOffTarget: string[] = []
    for (const { name, version } of tpResults) {
      if (!version) continue
      const target = targets[name]?.['Toppath']
      if (target && version !== target) tpOffTarget.push(`  • ${name}: ${version} → 目標 ${target}`)
    }
    if (tpOffTarget.length > 0) {
      lines.push('\n🔷 Toppath 元件版本未達標：')
      lines.push(...tpOffTarget)
    } else if (Object.keys(targets).some(k => targets[k]['Toppath'])) {
      lines.push('\n🔷 Toppath 元件版本：✅ 全部達標')
    }
  } catch { /* 忽略取得失敗 */ }

  // ── OSM 機台（Online 未達標）──
  if (osmChannelCache.length > 0) {
    const machineOffTarget: string[] = []
    for (const ch of osmChannelCache) {
      for (const m of ch.machines) {
        const target = targets[m.machineType]?.['MachineType']
        const online = (m.onlineState ?? '').trim().toLowerCase() === 'online'
        if (online && target && m.version !== target) {
          machineOffTarget.push(`  • [${ch.name}] ${m.machineName || m.id} (${m.machineType}): ${m.version} → 目標 ${target}`)
        }
      }
    }
    if (machineOffTarget.length > 0) {
      lines.push(`\n🖥 OSM 機台 Online 未達標（${machineOffTarget.length} 台）：`)
      lines.push(...machineOffTarget.slice(0, 20))
      if (machineOffTarget.length > 20) lines.push(`  ...以及另外 ${machineOffTarget.length - 20} 台`)
    } else if (osmChannelCache.length > 0) {
      lines.push('\n🖥 OSM 機台：✅ 全部 Online 達標')
    }
  }

  const hasIssues = lines.some(l => l.includes('未達標'))
  if (!hasIssues) {
    lines.push('\n✅ 所有版本均已達標，無需處理。')
  }

  const text = lines.join('\n')
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  })

  console.log(`[Alert] 告警已發送至 Lark，${hasIssues ? '有未達標項目' : '全部達標'}`)
  return { hasIssues, text }
}

// ─── Cron Job Manager ─────────────────────────────────────────────────────────

export let activeCronTask: cron.ScheduledTask | null = null

export const restartCron = () => {
  if (activeCronTask) { activeCronTask.stop(); activeCronTask = null }
  const cfg = getAlertConfig()
  if (!cfg.enabled) return
  if (!cron.validate(cfg.schedule)) { console.warn('[Alert] 無效的 cron 表達式：', cfg.schedule); return }
  activeCronTask = cron.schedule(cfg.schedule, async () => {
    console.log('[Alert] 定時告警觸發')
    try {
      const result = await sendLarkAlert()
      addHistory('osm-alert', `版本告警（定時）${result.hasIssues ? '（有未達標項目）' : '（全部達標）'}`, result.hasIssues ? '發現版本未達標，已發送 Lark 告警' : '所有版本達標，通知已發送', { hasIssues: result.hasIssues, text: result.text, triggeredBy: 'cron', schedule: cfg.schedule })
    } catch (err) { console.error('[Alert] 定時告警失敗：', err) }
  }, { timezone: 'Asia/Taipei' })
  console.log(`[Alert] 定時告警已啟動，排程：${cfg.schedule}`)
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const LARK_CATEGORIES = ['MachineType', 'OSM', 'LuckyLink', 'Toppath', 'ImageRecon'] as const

// GET /api/osm/targets
router.get('/api/osm/targets', (_req, res) => {
  const rows = db.prepare('SELECT machineType, category, targetVersion FROM machine_type_targets').all() as { machineType: string; category: string; targetVersion: string }[]
  const result: Record<string, Record<string, string>> = {}
  for (const r of rows) {
    if (!result[r.machineType]) result[r.machineType] = {}
    result[r.machineType][r.category] = r.targetVersion
  }
  res.json({ ok: true, targets: result })
})

// DELETE /api/osm/targets/:machineType
router.delete('/api/osm/targets/:machineType', (req, res) => {
  db.prepare('DELETE FROM machine_type_targets WHERE machineType = ?').run(req.params.machineType)
  res.json({ ok: true })
})

/**
 * POST /api/osm/sync-targets-from-lark
 * 從 Lark Sheet 同步所有機台目標版本（5 個分頁：MachineType / OSM / LuckyLink / Toppath / ImageRecon）。
 * @rate-limit heavyLimiter — 每分鐘最多 15 次，此操作會清空並重寫整張目標版本表。
 */
router.post('/api/osm/sync-targets-from-lark', heavyLimiter, async (req, res, next) => {
  try {
    const { sheetUrl } = z.object({ sheetUrl: z.string().min(1) }).parse(req.body)
    const { spreadsheetToken } = parseLarkSheetUrl(sheetUrl)
    if (!spreadsheetToken) return res.status(400).json({ ok: false, message: '無法解析 Lark Sheet URL' })

    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

    const metaResp = await fetch(
      `${base}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const metaText = await metaResp.text()
    let metaData: { code?: number; data?: { sheets?: Array<{ sheet_id: string; title: string }> } }
    try { metaData = JSON.parse(metaText) } catch {
      throw new Error(`無法取得分頁清單，Lark API 回傳非 JSON 格式（HTTP ${metaResp.status}）`)
    }
    if (metaData.code !== 0) throw new Error(`Lark API 錯誤 code=${metaData.code}，請確認 token 權限`)
    const sheets = metaData.data?.sheets ?? []

    db.prepare('DELETE FROM machine_type_targets').run()
    const ins = db.prepare('INSERT OR REPLACE INTO machine_type_targets (machineType, category, targetVersion) VALUES (?, ?, ?)')

    let totalCount = 0
    const synced: string[] = []

    for (const category of LARK_CATEGORIES) {
      const sheet = sheets.find(s => s.title === category)
      if (!sheet) { console.log(`[Lark Targets] 分頁 "${category}" 未找到，略過`); continue }

      const range = `${sheet.sheet_id}!A1:B500`
      const dataResp = await fetch(
        `${base}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const sheetData = await dataResp.json() as { data?: { valueRange?: { values?: unknown[][] } } }
      const rows = sheetData.data?.valueRange?.values ?? []

      let catCount = 0
      for (const row of rows) {
        const machineType = String(row[0] ?? '').trim()
        const targetVersion = String(row[1] ?? '').trim()
        if (machineType && targetVersion) {
          ins.run(machineType, category, targetVersion)
          catCount++
        }
      }
      if (catCount > 0) { synced.push(category); totalCount += catCount }
    }

    res.json({ ok: true, synced, totalCount })
  } catch (error) {
    next(error)
  }
})

// GET /api/osm/version-history
router.get('/api/osm/version-history', async (_req, res, next) => {
  try {
    const channels = readOsmChannels()
    if (channels.length === 0) return res.status(400).json({ ok: false, message: '未設定任何 OSM 渠道' })

    const channel = channels[0]
    const baseUrl = process.env.OSM_BASE_URL ?? 'https://backendserver.osmplay.com'

    const loginResp = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'backendserver.osmplay.com',
        'Origin': channel.origin,
        'Referer': `${channel.origin}/`,
      },
      body: new URLSearchParams({ username: channel.username, password: channel.password }).toString(),
    })
    const loginData = await loginResp.json() as { data?: { token?: string }; msg?: string }
    const token = loginData.data?.token
    if (!token) throw new Error(`登入失敗：${loginData.msg ?? '無法取得 token'}`)

    const histResp = await fetch(
      `${baseUrl}/manage/updateVersionHistoryRecord?page=1&pageSize=25&type=0&channelId=${channel.channelId}`,
      {
        method: 'POST',
        headers: {
          'Host': 'backendserver.osmplay.com',
          'Origin': channel.origin,
          'Referer': `${channel.origin}/`,
          'token': token,
        },
      }
    )
    const histData = await histResp.json() as { code?: number; data?: Record<string, string>; message?: string }
    if (histData.code !== 20000) throw new Error(`API 錯誤：${histData.message ?? histData.code}`)

    const dataMap = histData.data ?? {}
    if (Object.keys(dataMap).length === 0) throw new Error('無法取得版本資料')

    const versions: Record<string, string> = {}
    for (const [idx, name] of Object.entries(OSM_VERSION_COMPONENTS)) {
      const val = dataMap[String(idx)]
      versions[name] = val != null ? String(val) : '—'
    }

    const ordered = OSM_VERSION_ORDER.map(name => ({ name, version: versions[name] ?? '—' }))

    const syncTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
    addHistory('osm-components', 'OSM 元件版本同步', ordered.map(c => `${c.name}: ${c.version}`).join('、'), { components: ordered, syncTime })
    res.json({ ok: true, components: ordered, syncTime })
  } catch (error) {
    next(error)
  }
})

// GET /api/luckylink/version-history
router.get('/api/luckylink/version-history', async (_req, res, next) => {
  try {
    const baseUrl = process.env.LUCKYLINK_BASE_URL ?? 'https://luckylink-prod-backendserver.cliveslot.com'
    const username = process.env.LUCKYLINK_USERNAME ?? ''
    const password = process.env.LUCKYLINK_PASSWORD ?? ''
    const origin = process.env.LUCKYLINK_ORIGIN ?? baseUrl

    let token: string | undefined
    if (username && password) {
      const loginResp = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': origin,
          'Referer': `${origin}/`,
        },
        body: new URLSearchParams({ username, password }).toString(),
      })
      const loginData = await loginResp.json() as { data?: { token?: string }; msg?: string }
      token = loginData.data?.token
      if (!token) throw new Error(`登入失敗：${loginData.msg ?? '無法取得 token'}`)
    }

    const headers: Record<string, string> = {
      'Origin': origin,
      'Referer': `${origin}/`,
    }
    if (token) headers['token'] = token

    const histResp = await fetch(
      `${baseUrl}/manage/updateVersionHistoryRecord?page=1&pageSize=25&type=0`,
      { method: 'POST', headers }
    )
    const histData = await histResp.json() as { code?: number; data?: Record<string, string>; message?: string }
    if (histData.code !== 20000) throw new Error(`API 錯誤：${histData.message ?? histData.code}`)

    const dataMap = histData.data ?? {}

    const versions: Record<string, string> = {}
    for (const [idx, name] of Object.entries(LUCKYLINK_VERSION_COMPONENTS)) {
      versions[name] = dataMap[idx] != null ? String(dataMap[idx]) : '—'
    }

    const components = LUCKYLINK_VERSION_ORDER.map(name => ({
      name,
      version: versions[name] ?? '—',
      pending: name === 'Bg Client' && versions[name] == null,
    }))

    const syncTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
    addHistory('luckylink-components', 'LuckyLink 元件版本同步', components.filter(c => !c.pending).map(c => `${c.name}: ${c.version}`).join('、'), { components, syncTime })
    res.json({ ok: true, components, syncTime })
  } catch (error) {
    next(error)
  }
})

// GET /api/toppath/version-history
router.get('/api/toppath/version-history', async (_req, res, next) => {
  try {
    const base = (process.env.TOPPATH_VERSION_BASE_URL ?? 'https://staticpublic.osmslot.org/qat/version-info').replace(/\/$/, '')
    const results = await Promise.all(
      TOPPATH_VERSION_COMPONENTS.map(async ({ name, path }) => {
        try {
          const resp = await fetch(`${base}/${path}`)
          const data = await resp.json() as { version?: string }
          return { name, version: data.version ?? '—' }
        } catch {
          return { name, version: '—' }
        }
      })
    )
    const syncTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
    addHistory('toppath-components', 'Toppath 元件版本同步', results.map(c => `${c.name}: ${c.version}`).join('、'), { components: results, syncTime })
    res.json({ ok: true, components: results, syncTime })
  } catch (error) { next(error) }
})

// GET /api/osm/channels
router.get('/api/osm/channels', (_req, res) => {
  const channels = readOsmChannels().map(c => ({ name: c.name, channelId: c.channelId, origin: c.origin }))
  res.json({ ok: true, channels })
})

// POST /api/osm/sync
router.post('/api/osm/sync', async (req, res, next) => {
  if (osmSyncing) return res.status(429).json({ ok: false, message: 'OSM 同步進行中，請稍候再試' })
  osmSyncing = true
  try {
    const channels = readOsmChannels()
    if (channels.length === 0) return res.status(400).json({ ok: false, message: '未設定任何 OSM 渠道，請在 .env 加入 OSM_CHANNELS' })
    log('info', getClientIP(req), getUser(req), 'OSM 全渠道同步開始', `共 ${channels.length} 個渠道`)
    const results = await Promise.all(channels.map(syncOsmChannel))
    const ok = results.filter(r => !r.error).length
    const fail = results.filter(r => r.error).length
    log(fail > 0 ? 'warn' : 'ok', getClientIP(req), getUser(req), 'OSM 全渠道同步完成', `成功 ${ok} 個，失敗 ${fail} 個`)
    osmChannelCache = results
    addHistory('osm-sync', 'OSM 全渠道同步', `成功 ${ok} 個渠道，失敗 ${fail} 個`, { channels: results.map(r => ({ name: r.name, machines: r.machines.length, error: r.error })) })
    res.json({ ok: true, channels: results })
  } catch (error) {
    next(error)
  } finally {
    osmSyncing = false
  }
})

// POST /api/osm/sync/:name
router.post('/api/osm/sync/:name', async (req, res, next) => {
  if (osmSyncing) return res.status(429).json({ ok: false, message: 'OSM 同步進行中，請稍候再試' })
  osmSyncing = true
  try {
    const channels = readOsmChannels()
    const channel = channels.find(c => c.name.toLowerCase() === req.params.name.toLowerCase())
    if (!channel) return res.status(404).json({ ok: false, message: `渠道 ${req.params.name} 未設定` })
    log('info', getClientIP(req), getUser(req), `OSM 單渠道同步：${channel.name}`)
    const result = await syncOsmChannel(channel)
    log(result.error ? 'warn' : 'ok', getClientIP(req), getUser(req), `OSM ${channel.name} 同步${result.error ? '失敗' : '完成'}`, `${result.machines.length} 台`)
    res.json({ ok: !result.error, channel: result })
  } catch (error) {
    next(error)
  } finally {
    osmSyncing = false
  }
})

// POST /api/osm/alert
router.post('/api/osm/alert', async (_req, res, next) => {
  try {
    const result = await sendLarkAlert()
    addHistory('osm-alert', `版本告警${result.hasIssues ? '（有未達標項目）' : '（全部達標）'}`, result.hasIssues ? '發現版本未達標，已發送 Lark 告警' : '所有版本達標，通知已發送', { hasIssues: result.hasIssues, text: result.text, triggeredBy: 'manual' })
    res.json({ ok: true, hasIssues: result.hasIssues })
  } catch (error) {
    next(error)
  }
})

// GET /api/osm/alert/config
router.get('/api/osm/alert/config', (_req, res) => {
  res.json({ ok: true, config: getAlertConfig() })
})

// POST /api/osm/alert/config
router.post('/api/osm/alert/config', (req, res) => {
  const body = z.object({ enabled: z.boolean().optional(), schedule: z.string().optional() }).parse(req.body)
  if (body.enabled !== undefined) setAlertConfigKey('enabled', String(body.enabled))
  if (body.schedule !== undefined) setAlertConfigKey('schedule', body.schedule)
  restartCron()
  res.json({ ok: true, config: getAlertConfig() })
})

// ─── Config Compare ───────────────────────────────────────────────────────────

interface DiffItem {
  path: string
  type: 'mismatch' | 'missing_in_live' | 'extra_in_live'
  templateValue?: unknown
  liveValue?: unknown
}

function deepDiff(template: unknown, live: unknown, path = ''): DiffItem[] {
  const diffs: DiffItem[] = []
  if (Array.isArray(template) && Array.isArray(live)) {
    if (JSON.stringify(template) !== JSON.stringify(live)) {
      diffs.push({ path, type: 'mismatch', templateValue: template, liveValue: live })
    }
    return diffs
  }
  if (template !== null && typeof template === 'object' && live !== null && typeof live === 'object') {
    const tObj = template as Record<string, unknown>
    const lObj = live as Record<string, unknown>
    for (const key of Object.keys(tObj)) {
      const p = path ? `${path}.${key}` : key
      if (!(key in lObj)) {
        diffs.push({ path: p, type: 'missing_in_live', templateValue: tObj[key] })
      } else {
        diffs.push(...deepDiff(tObj[key], lObj[key], p))
      }
    }
    for (const key of Object.keys(lObj)) {
      const p = path ? `${path}.${key}` : key
      if (!(key in tObj)) {
        diffs.push({ path: p, type: 'extra_in_live', liveValue: lObj[key] })
      }
    }
    return diffs
  }
  if (template !== live) {
    diffs.push({ path, type: 'mismatch', templateValue: template, liveValue: live })
  }
  return diffs
}

async function fetchServerCfg(url: string): Promise<Record<string, unknown>> {
  // Step 1: follow HTTP redirect, read HTML page
  const pageResp = await fetch(url, { redirect: 'follow' })
  let finalUrl = new URL(pageResp.url)
  let htmlText = await pageResp.text()

  // Step 1b: detect JavaScript-level redirects (window.location = '...') that fetch() can't follow.
  // Common pattern on redirect/proxy pages like osm-redirect.osmplay-new.com
  const jsRedirectRe = /(?:window\.)?location(?:\.href)?\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/i
  const metaRefreshRe = /<meta[^>]+url=["'](https?:\/\/[^"']+)["']/i
  const jsRedirectMatch = jsRedirectRe.exec(htmlText) ?? metaRefreshRe.exec(htmlText)
  if (jsRedirectMatch) {
    try {
      const redirectTarget = new URL(jsRedirectMatch[1])
      if (redirectTarget.hostname !== finalUrl.hostname) {
        // Re-fetch from the JS redirect target's origin (strip token/params for safety)
        const cleanOrigin = `${redirectTarget.protocol}//${redirectTarget.host}`
        const targetResp = await fetch(cleanOrigin, { redirect: 'follow' }).catch(() => null)
        if (targetResp?.ok) {
          const targetHtml = await targetResp.text()
          if (targetHtml.length > htmlText.length || targetHtml.includes('serverCfg')) {
            htmlText = targetHtml
            finalUrl = new URL(targetResp.url)
          }
        }
      }
    } catch { /* ignore invalid redirect URL */ }
  }

  const host = `${finalUrl.protocol}//${finalUrl.host}`

  // Step 2: find serverCfg.js URL from the page's <script src="..."> tags
  // e.g. <script src="/config/serverCfg.js"> or <script src="serverCfg.js">
  const scriptSrcRe = /(?:<script[^>]+src=["'])([^"']*serverCfg\.js[^"']*)["']/gi
  const pathDir = finalUrl.pathname.endsWith('/')
    ? finalUrl.pathname
    : finalUrl.pathname.substring(0, finalUrl.pathname.lastIndexOf('/') + 1)

  const candidates: string[] = []
  let m: RegExpExecArray | null
  while ((m = scriptSrcRe.exec(htmlText)) !== null) {
    const src = m[1]
    if (src.startsWith('http')) candidates.push(src)
    else if (src.startsWith('/')) candidates.push(`${host}${src}`)
    else candidates.push(`${host}${pathDir}${src}`)
  }
  // Fallback candidates if not found in HTML (common paths)
  candidates.push(`${host}${pathDir}serverCfg.js`)
  candidates.push(`${host}/config/serverCfg.js`)
  candidates.push(`${host}/serverCfg.js`)

  let jsText: string | null = null
  let fetchedUrl = ''
  for (const cfgUrl of [...new Set(candidates)]) {
    const cfgResp = await fetch(cfgUrl)
    if (!cfgResp.ok) continue
    const ct = cfgResp.headers.get('content-type') ?? ''
    if (ct.includes('text/html')) continue   // SPA fallback, skip
    const text = await cfgResp.text()
    if (text.includes('_ServerCfg')) { jsText = text; fetchedUrl = cfgUrl; break }
  }
  if (!jsText) throw new Error(`無法找到 serverCfg.js（嘗試路徑：${[...new Set(candidates)].join(', ')}）`)

  // Step 3: execute in sandbox
  const ctx = vm.createContext({ window: {} as Record<string, unknown> })
  try {
    vm.runInContext(jsText, ctx)
  } catch (e) {
    const preview = jsText.substring(0, 120).replace(/\n/g, '\\n')
    throw new Error(`執行 serverCfg.js 失敗（來源：${fetchedUrl}）：${String(e)}\n前 120 字元：${preview}`)
  }
  const cfg = (ctx as { window: Record<string, unknown> }).window._ServerCfg
  if (!cfg || typeof cfg !== 'object') throw new Error(`serverCfg.js 中找不到 window._ServerCfg（來源：${fetchedUrl}）`)
  return cfg as Record<string, unknown>
}

// GET /api/osm/config-templates
router.get('/api/osm/config-templates', (_req, res) => {
  const rows = db.prepare('SELECT id, name, version, template, created_at FROM config_templates ORDER BY created_at DESC').all()
  res.json({ ok: true, templates: rows })
})

// POST /api/osm/config-templates
router.post('/api/osm/config-templates', (req, res) => {
  const body = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().default(''),
    template: z.string().min(2),
  }).parse(req.body)
  // validate JSON
  try { JSON.parse(body.template) } catch { return res.status(400).json({ ok: false, message: '模板不是有效的 JSON' }) }
  db.prepare('INSERT OR REPLACE INTO config_templates (id, name, version, template, created_at) VALUES (?, ?, ?, ?, ?)').run(body.id, body.name, body.version, body.template, Date.now())
  res.json({ ok: true })
})

// DELETE /api/osm/config-templates/:id
router.delete('/api/osm/config-templates/:id', (req, res) => {
  db.prepare('DELETE FROM config_templates WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// POST /api/osm/config-compare
router.post('/api/osm/config-compare', heavyLimiter, async (req, res) => {
  try {
    const body = z.object({
      templateId: z.string().min(1),
      url: z.string().url(),
      useGemini: z.boolean().default(false),
    }).parse(req.body)

    const row = db.prepare('SELECT template, name, version FROM config_templates WHERE id = ?').get(body.templateId) as
      { template: string; name: string; version: string } | undefined
    if (!row) return res.status(404).json({ ok: false, message: '找不到模板' })

    const templateObj = JSON.parse(row.template) as Record<string, unknown>
    const liveObj = await fetchServerCfg(body.url)
    const diffs = deepDiff(templateObj, liveObj)

    let geminiAnalysis: string | null = null
    if (body.useGemini && diffs.length > 0) {
      const diffText = diffs.map(d => {
        if (d.type === 'mismatch') return `[值不一致] ${d.path}: 模板="${JSON.stringify(d.templateValue)}" 線上="${JSON.stringify(d.liveValue)}"`
        if (d.type === 'missing_in_live') return `[線上缺少] ${d.path}: 模板值="${JSON.stringify(d.templateValue)}"`
        return `[線上多出] ${d.path}: 值="${JSON.stringify(d.liveValue)}"`
      }).join('\n')
      const prompt = `以下是 OSM serverCfg.js 的比對結果（模板「${row.name} ${row.version}」vs 線上版本）：\n\n${diffText}\n\n請用繁體中文分析：\n1. 哪些差異可能導致功能異常？\n2. 哪些差異是正常的版本更新？\n3. 建議的修正行動是什麼？`
      geminiAnalysis = await callGeminiWithRotation(prompt)
    }

    const summary = `${diffs.length} 項差異（不一致 ${diffs.filter(d => d.type === 'mismatch').length}，缺少 ${diffs.filter(d => d.type === 'missing_in_live').length}，多出 ${diffs.filter(d => d.type === 'extra_in_live').length}）`
    addHistory('osm-config-compare', `Config 比對：${row.name}`, summary, { diffs, url: body.url, templateName: row.name, templateVersion: row.version })

    res.json({ ok: true, diffs, summary, geminiAnalysis, templateName: row.name, templateVersion: row.version })
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) })
  }
})

// POST /api/osm/frontend-machines
// Accept a frontend lobby URL (with token), connect via pinus WebSocket, return game type counts
router.post('/api/osm/frontend-machines', heavyLimiter, async (req, res) => {
  try {
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body)
    // Parse token from URL
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token')
    if (!token) return res.status(400).json({ ok: false, message: 'URL 中找不到 token 參數' })
    // Get gate URL from serverCfg.js
    const serverCfg = await fetchServerCfg(url) as {
      server?: unknown
      gate?: { scheme?: string; host?: string; port?: string | number }
    }
    const nestedGate = Array.isArray(serverCfg.server)
      ? (serverCfg.server as unknown[]).flat(3).find((v): v is { scheme?: string; host?: string; port?: string | number } => {
          return !!v && typeof v === 'object' && 'host' in v
        })
      : null
    const gateInfo = serverCfg.gate ?? nestedGate ?? null
    if (!gateInfo?.host) return res.status(400).json({ ok: false, message: '無法從 serverCfg.js 取得 gate 伺服器資訊' })
    const scheme = (gateInfo.scheme ?? 'wss://').replace('://', '')
    const gateUrl = `${scheme}://${gateInfo.host}${gateInfo.port ? `:${gateInfo.port}` : ''}`
    const connectorInfo = Array.isArray(serverCfg.server)
      ? (serverCfg.server as unknown[]).flat(3).find((v): v is { host?: string; port?: string | number } => {
          if (!v || typeof v !== 'object') return false
          const h = String((v as { host?: unknown }).host ?? '')
          return h.toLowerCase().includes('conn.')
        })
      : null
    const connectorUrl = connectorInfo?.host
      ? `${scheme}://${connectorInfo.host}${connectorInfo.port ? `:${connectorInfo.port}` : ''}`
      : undefined

    const counts = await fetchAllGMList({ gateUrl, connectorUrl, token })
    const total = Object.values(counts).reduce((s, c) => s + c, 0)
    res.json({ ok: true, counts, total })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ ok: false, message: msg })
  }
})

// POST /api/osm/frontend-gate-info
// Resolve token + gate/connector URLs from a frontend lobby URL for browser-direct fallback.
router.post('/api/osm/frontend-gate-info', heavyLimiter, async (req, res) => {
  try {
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body)
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token')
    if (!token) return res.status(400).json({ ok: false, message: 'URL 中找不到 token 參數' })

    const serverCfg = await fetchServerCfg(url) as {
      server?: unknown
      gate?: { scheme?: string; host?: string; port?: string | number }
    }
    const nestedGate = Array.isArray(serverCfg.server)
      ? (serverCfg.server as unknown[]).flat(3).find((v): v is { scheme?: string; host?: string; port?: string | number } => {
          return !!v && typeof v === 'object' && 'host' in v
        })
      : null
    const gateInfo = serverCfg.gate ?? nestedGate ?? null
    if (!gateInfo?.host) return res.status(400).json({ ok: false, message: '無法從 serverCfg.js 取得 gate 伺服器資訊' })
    const scheme = (gateInfo.scheme ?? 'wss://').replace('://', '')
    const gateUrl = `${scheme}://${gateInfo.host}${gateInfo.port ? `:${gateInfo.port}` : ''}`
    const connectorInfo = Array.isArray(serverCfg.server)
      ? (serverCfg.server as unknown[]).flat(3).find((v): v is { host?: string; port?: string | number } => {
          if (!v || typeof v !== 'object') return false
          const h = String((v as { host?: unknown }).host ?? '')
          return h.toLowerCase().includes('conn.')
        })
      : null
    const connectorUrl = connectorInfo?.host
      ? `${scheme}://${connectorInfo.host}${connectorInfo.port ? `:${connectorInfo.port}` : ''}`
      : undefined

    res.json({ ok: true, token, gateUrl, connectorUrl })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ ok: false, message: msg })
  }
})

// ─── Frontend Push / Pull ────────────────────────────────────────────────────
// Allows a game-console script to push machine counts, which the tool frontend polls for.

interface MachinePushEntry {
  counts: Record<string, number>
  total: number
  ts: number
}
const machinePushStore = new Map<string, MachinePushEntry>()
const MACHINE_PUSH_TTL_MS = 5 * 60 * 1000 // 5 minutes

// POST /api/osm/machine-push/:requestId
router.post('/api/osm/machine-push/:requestId', (req, res) => {
  const { requestId } = req.params
  const body = req.body as { counts?: Record<string, number>; total?: number }
  if (!body.counts || typeof body.counts !== 'object') {
    return res.status(400).json({ ok: false, message: 'Missing counts' })
  }
  machinePushStore.set(requestId, {
    counts: body.counts,
    total: typeof body.total === 'number' ? body.total : Object.values(body.counts).reduce((s, n) => s + n, 0),
    ts: Date.now(),
  })
  // Clean up expired entries
  for (const [key, entry] of machinePushStore.entries()) {
    if (Date.now() - entry.ts > MACHINE_PUSH_TTL_MS) machinePushStore.delete(key)
  }
  res.json({ ok: true })
})

// GET /api/osm/machine-pull/:requestId
router.get('/api/osm/machine-pull/:requestId', (req, res) => {
  const { requestId } = req.params
  const entry = machinePushStore.get(requestId)
  if (!entry) return res.json({ ok: false, message: 'pending' })
  if (Date.now() - entry.ts > MACHINE_PUSH_TTL_MS) {
    machinePushStore.delete(requestId)
    return res.json({ ok: false, message: 'expired' })
  }
  machinePushStore.delete(requestId)
  res.json({ ok: true, counts: entry.counts, total: entry.total })
})

// POST /api/osm/frontend-machines-auto
// Use Playwright to open lobby URL (WITHOUT gameid) and intercept large WS frames from hall.hallHandler.getAllGMListReq.
router.post('/api/osm/frontend-machines-auto', heavyLimiter, async (req, res) => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  })
  try {
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body)
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token')
    if (!token) return res.status(400).json({ ok: false, message: 'URL 中找不到 token 參數' })

    // Remove gameid — lobby without gameid triggers hall.hallHandler.getAllGMListReq push from server
    parsed.searchParams.delete('gameid')
    const lobbyUrl = parsed.toString()

    const largeFrames: string[] = []
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()

    // Intercept WebSocket frames; capture large ones (>5000 bytes) using latin1 to avoid UTF-8 truncation
    page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        const data = frame.payload
        if (data && data.length > 5000) {
          largeFrames.push(Buffer.from(data as string, 'binary').toString('latin1'))
        }
      })
    })

    await page.goto(lobbyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // Wait 5 seconds for the server to push getAllGMListReq response
    await page.waitForTimeout(5000)

    // Extract gmids from all captured frames
    // gmid format: 4175-LIGHTNINGGONGS-1422  (4-digit venue, uppercase game key, seq)
    const combined = largeFrames.join('')
    const gmidPattern = /\b(\d{4})-([A-Z][A-Z0-9]+(?:-[A-Z][A-Z0-9]*)*)-(\d+)\b/g
    const counts: Record<string, number> = {}
    const gmidSet = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = gmidPattern.exec(combined)) !== null) {
      gmidSet.add(m[0]) // full gmid e.g. "4175-LIGHTNINGGONGS-1422"
      // Game key = middle segment(s) joined and lowercased
      const gameKey = m[2].toLowerCase()
      counts[gameKey] = (counts[gameKey] || 0) + 1
    }

    const total = Object.values(counts).reduce((s, c) => s + c, 0)
    if (total === 0) {
      return res.status(500).json({
        ok: false,
        message: '自動抓取完成但未取得任何機台資料',
        debug: {
          framesCount: largeFrames.length,
          combinedLength: combined.length,
          preview: combined.slice(0, 300),
        },
      })
    }
    res.json({ ok: true, counts, total, gmids: Array.from(gmidSet), source: 'playwright', method: 'ws-intercept' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ ok: false, message: `自動抓取失敗：${msg}` })
  } finally {
    await browser.close()
  }
})

// ─── Jackpot Monitor (server-side, always running) ───────────────────────────

type JpLevel = 'grand' | 'major' | 'minor' | 'mini' | 'fortunate'
const JP_LEVELS: JpLevel[] = ['grand', 'major', 'minor', 'mini', 'fortunate']
const JP_MIN_DEFAULT: Record<JpLevel, number> = { grand: 1_000_000, major: 1_000, minor: 100, mini: 10, fortunate: 1_000 }
const JP_MAX_DEFAULT: Record<JpLevel, number> = { grand: 999_999_999, major: 999_999_999, minor: 99_999_999, mini: 9_999_999, fortunate: 999_999_999 }

interface JpGame { gameid: string; grand?: number; major?: number; minor?: number; mini?: number; fortunate?: number }
interface JpAnomalyRecord { gameId: string; level: JpLevel; value: number; prevValue?: number; reason: string; time: string }
interface JpPrevEntry { value: number; time: number }

// Cloudflare __cf_bm cookie jar — updated from every response, included in every request
let jpCfCookie: string | null = null

function extractCfCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null
  const match = setCookieHeader.match(/(__cf_bm=[^;]+)/)
  return match ? match[1] : null
}

async function fetchJpData(): Promise<{ games?: JpGame[], error?: number } | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (jpCfCookie) headers['Cookie'] = jpCfCookie
  const body = { channelid: jpState.channelId, timestamp: Date.now() - 1000 }
  jpState.lastRequestBody = JSON.stringify(body)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  let resp: Response
  try {
    resp = await fetch('https://center-image-recon.osmplay.com/cp/getjpinfos', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  // Always capture the Cloudflare cookie from the response for next request
  const newCookie = extractCfCookie(resp.headers.get('set-cookie'))
  if (newCookie) jpCfCookie = newCookie
  if (!resp.ok) return null
  return resp.json() as Promise<{ games?: JpGame[], error?: number }>
}

const jpState = {
  channelId: '4171',
  games:      [] as JpGame[],
  lastUpdated:   null as string | null,
  lastAttemptAt: null as string | null,
  anomalyLog: [] as JpAnomalyRecord[],
  larkSentAt: null as string | null,
  lastError:  null as string | null,
  lastRequestBody: null as string | null,
  prevValues: new Map<string, JpPrevEntry>(),
  notified:   new Set<string>(),
}

function detectJpAnomaly(level: JpLevel, value: number, prev: JpPrevEntry | undefined, min: number, max: number): string | null {
  if (value < 0) return null
  if (value < min) return `數值過小（${value.toLocaleString()} < ${min.toLocaleString()}），可能少識別一位`
  if (value > max) return `數值過大（${value.toLocaleString()} > ${max.toLocaleString()}），可能多識別一位`
  if (prev !== undefined) {
    const prevDigits = String(Math.floor(Math.abs(prev.value))).length
    const currDigits = String(Math.floor(value)).length
    if (Math.abs(currDigits - prevDigits) >= 2)
      return `位數異常：前次 ${prevDigits} 位 → 本次 ${currDigits} 位，疑似識別錯誤`
    if (value > prev.value && prev.value > 0) {
      const pct = (value - prev.value) / prev.value
      if (pct > 0.5 && (value - prev.value) > 500_000)
        return `單次暴增 ${(pct * 100).toFixed(0)}%（+${(value - prev.value).toLocaleString()}），可能識別錯誤`
    }
  }
  return null
}

let jpPolling = false

async function runJackpotPoll() {
  if (jpPolling) return
  jpPolling = true
  const now = new Date()
  const timeStr = now.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
  jpState.lastAttemptAt = timeStr
  try {
    let data = await fetchJpData()
    // error 101 on first attempt — we may have just received a fresh __cf_bm cookie;
    // retry once immediately with that cookie
    if (data?.error === 101 && jpCfCookie) {
      data = await fetchJpData()
    }
    if (!data) { jpState.lastError = 'upstream error'; return }
    if (!data.games || data.games.length === 0) {
      jpState.lastError = `empty response (error=${data.error ?? '?'})`
      return
    }

    jpState.games = data.games
    jpState.lastUpdated = timeStr
    jpState.lastError = null

    const newAnomalies: JpAnomalyRecord[] = []
    for (const g of data.games) {
      for (const level of JP_LEVELS) {
        const val = g[level]
        if (val === undefined || val < 0) continue
        const key = `${g.gameid}:${level}`
        const prev = jpState.prevValues.get(key)
        const row = db.prepare('SELECT min_val, max_val, enabled FROM jackpot_settings WHERE gameid = ? AND level = ?')
          .get(g.gameid, level) as { min_val: number; max_val: number; enabled: number } | undefined
        const min = row?.min_val ?? JP_MIN_DEFAULT[level]
        const max = row?.max_val ?? JP_MAX_DEFAULT[level]
        const enabled = (row?.enabled ?? 1) !== 0

        const reason = detectJpAnomaly(level, val, prev, min, max)
        if (reason && !jpState.notified.has(key)) {
          jpState.notified.add(key)
          const record: JpAnomalyRecord = { gameId: g.gameid, level, value: val, prevValue: prev?.value, reason, time: jpState.lastUpdated! }
          jpState.anomalyLog = [record, ...jpState.anomalyLog].slice(0, 50)
          if (enabled) newAnomalies.push(record)
        } else if (!reason) {
          jpState.notified.delete(key)
        }
        jpState.prevValues.set(key, { value: val, time: now.getTime() })
      }
    }

    if (newAnomalies.length > 0) {
      const webhookUrl = process.env.LARK_WEBHOOK_URL
        ?? `https://open.larksuite.com/open-apis/bot/v2/hook/${process.env.LARK_WEBHOOK_ID}`
      const nowStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
      const lines = [
        `🎰 Jackpot 獎池異常告警`,
        `📅 ${nowStr}　Channel: ${jpState.channelId}`,
        '',
        ...newAnomalies.map(a => {
          const change = a.prevValue !== undefined
            ? `（前次：${a.prevValue.toLocaleString()} → 現在：${a.value.toLocaleString()}）`
            : `（現在：${a.value.toLocaleString()}）`
          return `⚠️ ${a.gameId} [${a.level}] ${change}\n   原因：${a.reason}`
        }),
      ]
      const lac = new AbortController()
      const lt = setTimeout(() => lac.abort(), 8_000)
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg_type: 'text', content: { text: lines.join('\n') } }),
          signal: lac.signal,
        })
      } finally {
        clearTimeout(lt)
      }
      jpState.larkSentAt = jpState.lastUpdated
    }
  } catch (err) {
    jpState.lastError = String(err)
  } finally {
    jpPolling = false
  }
}

runJackpotPoll()
setInterval(runJackpotPoll, 15_000)

/**
 * GET /api/osm/jackpot?channelid=4171
 * Proxy to center-image-recon.osmplay.com — returns jackpot pool data for all games.
 */
router.get('/api/osm/jackpot', async (req, res, next) => {
  try {
    const channelid = (req.query.channelid as string) || '4171'
    const resp = await fetch('https://center-image-recon.osmplay.com/cp/getjpinfos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelid, timestamp: Date.now() - 1000 }),
    })
    if (!resp.ok) return res.status(resp.status).json({ ok: false, message: `upstream ${resp.status}` })
    const data = await resp.json()
    res.json(data)
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/osm/jackpot/state
 * Returns current backend monitor state (games, anomalyLog, lastUpdated, etc.)
 */
router.get('/api/osm/jackpot/state', (_req, res) => {
  res.json({
    ok: true,
    channelId:       jpState.channelId,
    games:           jpState.games,
    lastUpdated:     jpState.lastUpdated,
    lastAttemptAt:   jpState.lastAttemptAt,
    anomalyLog:      jpState.anomalyLog,
    larkSentAt:      jpState.larkSentAt,
    lastError:       jpState.lastError,
    lastRequestBody: jpState.lastRequestBody,
  })
})

/**
 * POST /api/osm/jackpot/channel
 * Update the channel ID being monitored. Resets state and triggers immediate poll.
 */
router.post('/api/osm/jackpot/channel', (req, res) => {
  const { channelId } = req.body as { channelId?: string }
  if (!channelId) return res.status(400).json({ ok: false, message: 'channelId required' })
  if (channelId !== jpState.channelId) {
    jpState.channelId = channelId
    jpState.games = []
    jpState.lastUpdated = null
    jpState.prevValues.clear()
    jpState.notified.clear()
    runJackpotPoll()
  }
  res.json({ ok: true, channelId: jpState.channelId })
})

/**
 * POST /api/osm/jackpot/lark-alert
 * Send jackpot anomaly notification to Lark webhook.
 */
router.post('/api/osm/jackpot/lark-alert', async (req, res, next) => {
  try {
    const webhookUrl = process.env.LARK_WEBHOOK_URL
      ?? `https://open.larksuite.com/open-apis/bot/v2/hook/${process.env.LARK_WEBHOOK_ID}`

    const { anomalies, channelid } = req.body as {
      channelid: string
      anomalies: { gameId: string; level: string; value: number; prevValue?: number; reason: string }[]
    }

    if (!anomalies || anomalies.length === 0) return res.json({ ok: true, skipped: true })

    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
    const lines = [
      `🎰 Jackpot 獎池異常告警`,
      `📅 ${now}　Channel: ${channelid}`,
      '',
      ...anomalies.map(a => {
        const change = a.prevValue !== undefined
          ? `　（前次：${a.prevValue.toLocaleString()} → 現在：${a.value.toLocaleString()}）`
          : `　（現在：${a.value.toLocaleString()}）`
        return `⚠️ ${a.gameId} [${a.level}]${change}\n   原因：${a.reason}`
      }),
    ]

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: lines.join('\n') } }),
    })

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/osm/jackpot/settings
 * Returns per-game threshold and alert settings.
 */
router.get('/api/osm/jackpot/settings', (req, res) => {
  const rows = db.prepare('SELECT gameid, level, min_val, max_val, enabled FROM jackpot_settings').all()
  res.json({ ok: true, settings: rows })
})

/**
 * POST /api/osm/jackpot/settings
 * Admin-only: upsert per-game threshold + alert settings.
 * Body: { settings: Array<{ gameid, level, min_val, max_val, enabled }> }
 */
router.post('/api/osm/jackpot/settings', (req, res) => {
  const pin = process.env.ADMIN_PIN ?? ''
  const provided = String(req.headers['x-admin-pin'] ?? '')
  if (pin && provided !== pin) return res.status(403).json({ ok: false, message: '需要管理員 PIN' })

  const { settings } = req.body as {
    settings: { gameid: string; level: string; min_val: number; max_val: number; enabled: boolean }[]
  }
  if (!Array.isArray(settings)) return res.status(400).json({ ok: false, message: 'settings 必須為陣列' })

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO jackpot_settings (gameid, level, min_val, max_val, enabled) VALUES (?, ?, ?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const s of settings) {
      upsert.run(s.gameid, s.level, s.min_val, s.max_val, s.enabled ? 1 : 0)
    }
  })
  tx()
  // Reset notified so anomalies re-evaluate with new thresholds on next poll
  jpState.notified.clear()
  res.json({ ok: true })
})

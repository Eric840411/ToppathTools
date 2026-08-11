/**
 * Alibaba Cloud SLS (Simple Log Service) REST API client
 * Uses HMAC-SHA1 request signing per the SLS API spec.
 */
import crypto from 'crypto'
import SlsPkg, { GetLogsRequest } from '@alicloud/sls20201230'
import { Config } from '@alicloud/openapi-client'

// Node ESM interop for this CJS package: the default import is the whole
// module.exports object, and the actual Client class lives at `.default`.
const SlsClient = (SlsPkg as unknown as { default: new (config: Config) => SlsClientInstance }).default

interface SlsClientInstance {
  getLogs(project: string, logstore: string, request: InstanceType<typeof GetLogsRequest>): Promise<{ statusCode?: number; body?: Record<string, string>[] }>
}

const SLS_ENDPOINT = process.env.SLS_ENDPOINT || 'ap-southeast-1.log.aliyuncs.com'
const SLS_KEY_ID = process.env.SLS_KEY_ID || ''
const SLS_KEY_SECRET = process.env.SLS_KEY_SECRET || ''

// 4 SLS projects to search
export const SLS_PROJECTS: string[] = (process.env.SLS_PROJECTS || [
  'liveslots-luckylinkmml-test-logs',
  'liveslots-luckylinkg2s-test-logs',
  'liveslots-luckylinkmml-cms-logs',
  'liveslots-luckylinkg2s-cms-logs',
].join(',')).split(',').map(s => s.trim()).filter(Boolean)

// Cache logstore lists per project (TTL: 5 min)
const logstoreCache = new Map<string, { stores: string[]; expiry: number }>()

function signRequest(
  method: string,
  date: string,
  xLogHeaders: Record<string, string>,
  resourcePath: string,
): string {
  const canonicalHeaders = Object.entries(xLogHeaders)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join('\n')

  const stringToSign = [method, '', '', date, canonicalHeaders, resourcePath].join('\n')
  return crypto.createHmac('sha1', SLS_KEY_SECRET).update(stringToSign).digest('base64')
}

async function slsGet(project: string, resourcePath: string, query: Record<string, string> = {}): Promise<unknown> {
  const date = new Date().toUTCString()
  const xLogHeaders: Record<string, string> = {
    'x-log-apiversion': '0.6.0',
    'x-log-signaturemethod': 'hmac-sha1',
  }
  const signature = signRequest('GET', date, xLogHeaders, resourcePath)
  const headers: Record<string, string> = {
    ...xLogHeaders,
    Date: date,
    Authorization: `LOG ${SLS_KEY_ID}:${signature}`,
  }

  const qs = new URLSearchParams(query).toString()
  const url = `https://${project}.${SLS_ENDPOINT}${resourcePath}${qs ? `?${qs}` : ''}`

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`SLS ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

/** List all logstores in a project (cached 5 min) */
async function listLogstores(project: string): Promise<string[]> {
  const now = Date.now()
  const cached = logstoreCache.get(project)
  if (cached && cached.expiry > now) return cached.stores

  const data = await slsGet(project, '/logstores', { offset: '0', size: '100' }) as { logstores?: string[] }
  const stores: string[] = data?.logstores ?? []
  logstoreCache.set(project, { stores, expiry: now + 5 * 60_000 })
  return stores
}

export interface SlsLogEntry {
  time: number       // unix timestamp seconds
  timeStr: string    // formatted
  project: string
  logstore: string
  content: string
  level: string      // ERROR / WARN / INFO etc.
}

/**
 * Search all 4 SLS projects for log entries matching machineNo,
 * filtered to ERROR/WARN/Exception only.
 * Returns up to `limit` entries sorted newest-first.
 */
export async function fetchSlsErrors(machineNo: string, limit = 20): Promise<SlsLogEntry[]> {
  if (!SLS_KEY_ID || !SLS_KEY_SECRET) {
    throw new Error('SLS credentials not configured (SLS_KEY_ID / SLS_KEY_SECRET missing in .env)')
  }

  const toTime = Math.floor(Date.now() / 1000)
  const fromTime = toTime - 24 * 60 * 60  // last 24 hours

  const query = `${machineNo} and (ERROR or WARN or Exception or Traceback)`

  const results: SlsLogEntry[] = []

  await Promise.allSettled(
    SLS_PROJECTS.map(async (project) => {
      try {
        const stores = await listLogstores(project)
        await Promise.allSettled(
          stores.map(async (logstore) => {
            try {
              const data = await slsGet(project, `/logstores/${logstore}`, {
                type: 'log',
                query,
                from: String(fromTime),
                to: String(toTime),
                line: String(limit),
                offset: '0',
              }) as { logs?: Record<string, string>[] }

              for (const log of (data?.logs ?? [])) {
                const content: string = log['content'] ?? log['message'] ?? JSON.stringify(log)
                // extract level from content like "2026-05-06 09:15:03 | ERROR | ..."
                const levelMatch = content.match(/\|\s*(ERROR|WARN(?:ING)?|INFO|DEBUG|CRITICAL|Exception|Traceback)/i)
                const level = levelMatch ? levelMatch[1].toUpperCase() : 'ERROR'

                const rawTime = log['__time__'] ?? log['_time_'] ?? ''
                const ts = rawTime ? parseInt(rawTime) : Math.floor(Date.now() / 1000)
                const timeStr = rawTime
                  ? new Date(ts * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Shanghai' })
                  : '—'

                results.push({ time: ts, timeStr, project, logstore, content, level })
              }
            } catch {
              // skip failed logstores silently
            }
          })
        )
      } catch {
        // skip failed projects silently
      }
    })
  )

  results.sort((a, b) => b.time - a.time)
  return results.slice(0, limit)
}

// ─── recordBet 三路對帳用：獨立一組 SLS 憑證（qat-toppath-osm-logs / tgapi-qat）──
// 跟上面 fetchSlsErrors 用的 .env 憑證是分開的兩件事（那組是舊功能寫死 4 個渠道 log project）。
// 這組固定從 env var 讀（2026-08-10 使用者明確要求：不用讓使用者自己設置，也不在畫面上顯示/可改，
// 不提供任何前端設定 UI）——**帳密本身不可以寫死在程式碼裡**（2026-08-11 GitHub push protection
// 擋下過一次真的把 AccessKey 寫進程式碼的 commit，之後一律只能放 .env，.env 有 gitignore 保護，
// 部署環境要記得同步設定這幾個變數，見 CLAUDE.md 第 7 節）。

export interface SlsCreds {
  accessKeyId: string
  accessKeySecret: string
  region: string
  project: string
  logstore: string
}

export function getSlsCreds(): SlsCreds {
  return {
    accessKeyId: process.env.SLS_RECORDBET_KEY_ID || '',
    accessKeySecret: process.env.SLS_RECORDBET_KEY_SECRET || '',
    region: process.env.SLS_RECORDBET_REGION || 'ap-southeast-1',
    project: process.env.SLS_RECORDBET_PROJECT || 'qat-toppath-osm-logs',
    logstore: process.env.SLS_RECORDBET_LOGSTORE || 'tgapi-qat',
  }
}

let cachedClient: { client: SlsClientInstance; key: string } | null = null

function getRecordBetClient(creds: SlsCreds): SlsClientInstance {
  const key = `${creds.accessKeyId}:${creds.region}`
  if (cachedClient && cachedClient.key === key) return cachedClient.client
  const config = new Config({
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    endpoint: `${creds.region}.log.aliyuncs.com`,
  })
  const client = new SlsClient(config)
  cachedClient = { client, key }
  return client
}

export interface SlsBetRecord {
  roundId: string
  machineId: string
  machineName: string
  userId: string
  gameId: string
  providerId: string
  amount: number       // requestJSON.amount（下注額）
  validBet: number
  payout: number
  moneyAfter: number
  usedCash: number
  usedMoneyMud: number
  remainingMoneyMud: number
  initialMoneyMud: number
  betTimestamp: number
  payoutTimestamp: number
  balance: number       // responseJSON.balance
  moneyMud: number      // responseJSON.moneyMud
  error: number         // responseJSON.error（0=正常）
  transactionId: string
  time: number           // SLS __time__（unix seconds）
  raw: Record<string, unknown>
}

/**
 * Fetch recordBet events from SLS within [fromTs, toTs] (unix seconds).
 * Parses the combined request+response JSON log line (the one with `requestJSON`/`responseJSON`
 * keys, distinct from the separate one-line request-only / response-only log entries SLS also emits
 * for the same event — see fetchSlsErrors comment history for the 3-lines-per-event log shape).
 * Optionally filters by machineId (exact match against requestJSON.machineId).
 */
export async function fetchRecordBet(fromTs: number, toTs: number, machineId?: string, limit = 1000): Promise<SlsBetRecord[]> {
  const creds = getSlsCreds()
  if (!creds.accessKeyId || !creds.accessKeySecret) {
    throw new Error('SLS 憑證尚未設定（sls_accessKeyId / sls_accessKeySecret）')
  }
  const client = getRecordBetClient(creds)

  const results: SlsBetRecord[] = []
  let offset = 0
  const pageSize = 100
  // SLS GetLogs line cap is 100 per call; page until exhausted or limit reached.
  for (let page = 0; page < 50 && results.length < limit; page++) {
    const request = new GetLogsRequest({
      from: fromTs, to: toTs, query: 'recordBet and requestJSON',
      line: pageSize, offset, reverse: false,
    })
    const resp = await client.getLogs(creds.project, creds.logstore, request)
    const body = (resp.body ?? []) as Record<string, string>[]
    if (body.length === 0) break

    for (const log of body) {
      const content = log['content'] ?? ''
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(content.trim())
      } catch {
        continue
      }
      const reqJson = parsed.requestJSON as Record<string, unknown> | undefined
      const resJson = parsed.responseJSON as Record<string, unknown> | undefined
      if (!reqJson) continue
      const mId = String(reqJson.machineId ?? '')
      if (machineId && mId !== machineId) continue

      const num = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v ?? 0)) || 0)
      const rawTime = log['__time__'] ?? ''
      results.push({
        roundId: String(reqJson.roundId ?? ''),
        machineId: mId,
        machineName: String(reqJson.machineName ?? ''),
        userId: String(reqJson.userId ?? ''),
        gameId: String(reqJson.gameId ?? ''),
        providerId: String(reqJson.providerId ?? parsed.providerId ?? ''),
        amount: num(reqJson.amount),
        validBet: num(reqJson.validBet),
        payout: num(reqJson.payout),
        moneyAfter: num(reqJson.moneyAfter),
        usedCash: num(reqJson.usedCash),
        usedMoneyMud: num(reqJson.usedMoneyMud),
        remainingMoneyMud: num(reqJson.remainingMoneyMud),
        initialMoneyMud: num(reqJson.initialMoneyMud),
        betTimestamp: num(reqJson.betTimestamp),
        payoutTimestamp: num(reqJson.payoutTimestamp),
        balance: num(resJson?.balance),
        moneyMud: num(resJson?.moneyMud),
        error: num(resJson?.error),
        transactionId: String(resJson?.transactionId ?? ''),
        time: rawTime ? parseInt(rawTime) : 0,
        raw: parsed,
      })
      if (results.length >= limit) break
    }
    if (body.length < pageSize) break
    offset += pageSize
  }

  results.sort((a, b) => a.time - b.time)
  return results
}

/** Quick connectivity/credential test: fetch 1 record from the last N minutes. */
export async function testSlsRecordBetConnection(minutesAgo = 60): Promise<{ ok: boolean; message: string; sampleCount: number }> {
  try {
    const to = Math.floor(Date.now() / 1000)
    const from = to - minutesAgo * 60
    const rows = await fetchRecordBet(from, to, undefined, 1)
    return { ok: true, message: `連線成功，過去 ${minutesAgo} 分鐘查到 ${rows.length >= 1 ? '至少 1' : '0'} 筆`, sampleCount: rows.length }
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), sampleCount: 0 }
  }
}

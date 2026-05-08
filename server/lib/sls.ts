/**
 * Alibaba Cloud SLS (Simple Log Service) REST API client
 * Uses HMAC-SHA1 request signing per the SLS API spec.
 */
import crypto from 'crypto'

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

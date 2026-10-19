/**
 * 抓「使用者給的網址」用的 fetch：擋掉打回伺服器本機／雲端 metadata／內網的請求（SSRF）。
 *
 * 資安審查 2026-10-19：Config 比對、圖片刪除驗證、規格書 PDF 匯入都會照請求帶進來的網址去抓，
 * 還會跟著轉址走——可以拿來打 127.0.0.1:3010（worker）或 169.254.169.254（雲端 metadata）。
 *
 * 規則：
 * - 只收 http／https
 * - 主機解析出來的**每一個** IP 都要通過：loopback、0.0.0.0、link-local（含 metadata）、
 *   multicast、保留段一律擋；私有網段（10/8、172.16/12、192.168/16、100.64/10、fc00::/7）
 *   只放行 OSM 自己的網域（測試站可能解析到內網），其他擋
 * - 轉址改成手動跟（最多 5 次），每一跳都重新檢查
 *
 * ⚠️ 已知限制：檢查與實際連線之間仍有 DNS rebinding 的時間差。這層是擋掉「直接填內網位址」
 *    與「轉址到內網」，不是完整的出口防火牆。
 */
import { lookup } from 'dns/promises'
import { isIP } from 'net'

/** 解析到內網也放行的網域（OSM 測試站） */
const PRIVATE_OK_SUFFIXES = ['osmslot.org', 'osmplay.com', 'osmplay-new.com', 'cliveslot.com']

export class UnsafeUrlError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0
}
function inV4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr)
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

const V4_BLOCK = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']
const V4_PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']

/** 'block'＝任何情況都擋；'private'＝只有 OSM 網域可以；'public'＝放行 */
export function classifyIp(ip: string): 'block' | 'private' | 'public' {
  if (isIP(ip) === 4) {
    if (V4_BLOCK.some(c => inV4(ip, c))) return 'block'
    if (V4_PRIVATE.some(c => inV4(ip, c))) return 'private'
    return 'public'
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase()
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return classifyIp(mapped[1])
    if (s === '::' || s === '::1') return 'block'
    if (/^fe[89ab]/.test(s)) return 'block'        // link-local fe80::/10
    if (/^ff/.test(s)) return 'block'              // multicast
    if (/^f[cd]/.test(s)) return 'private'         // ULA fc00::/7
    return 'public'
  }
  return 'block'
}

function hostAllowsPrivate(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return PRIVATE_OK_SUFFIXES.some(s => h === s || h.endsWith(`.${s}`))
}

/** 不通過丟 UnsafeUrlError；通過回傳解析好的 URL。 */
export async function assertSafeUrl(raw: string | URL): Promise<URL> {
  let u: URL
  try { u = new URL(String(raw)) } catch { throw new UnsafeUrlError('網址格式不正確') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError(`不支援的網址協定 ${u.protocol}`)
  if (u.username || u.password) throw new UnsafeUrlError('網址不能帶帳密')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new UnsafeUrlError(`無法解析主機 ${host}`) })).map(a => a.address)
  if (!ips.length) throw new UnsafeUrlError(`無法解析主機 ${host}`)
  for (const ip of ips) {
    const c = classifyIp(ip)
    if (c === 'block' || (c === 'private' && !hostAllowsPrivate(host))) {
      throw new UnsafeUrlError(`不允許連到內部位址（${host}）`)
    }
  }
  return u
}

/** 跟 fetch 一樣用，但每一跳都檢查；回應的 `url` 是最後一跳的網址。 */
export async function safeFetch(raw: string | URL, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = await assertSafeUrl(raw)
  for (let i = 0; i <= maxRedirects; i++) {
    const resp = await fetch(current, { ...init, redirect: 'manual' })
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      current = await assertSafeUrl(new URL(resp.headers.get('location')!, current))
      continue
    }
    // 手動跟轉址時 Response.url 是那一跳自己的網址；統一設成最後一跳，呼叫端拿來組相對路徑
    Object.defineProperty(resp, 'url', { value: current.toString() })
    return resp
  }
  throw new UnsafeUrlError('轉址次數過多')
}

/** 給 Playwright 這類自己發請求的地方：同步檢查字面上就是內部位址的主機（不做 DNS）。 */
export function isObviouslyInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  if (isIP(h)) return classifyIp(h) !== 'public'
  return false
}

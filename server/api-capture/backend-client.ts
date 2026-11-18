/**
 * API 參數紀錄：查 OSM 後台的 Log Third Http Req／Log Third Bet Req。
 *
 * 登入 `/auth/login`（code 20000 → data.token），之後 header 帶 token／lastlogintime；
 * token 過期回 40200 → 重新登入一次。分頁抓到最後一頁，**任何一頁失敗、筆數對不上、
 * 撞到頁數上限都標「不完整」**——不能讓缺資料的查詢看起來像成功（CodeX 定案）。
 */
import { normalizeBackendItem, type BackendItem, type BackendSource } from './core.js'

export interface BackendConfig {
  baseUrl: string
  origin: string
  username: string
  password: string
  channelId: string
}

export interface BackendFetchResult {
  items: BackendItem[]
  complete: boolean
  reasons: string[]
  pages: Record<BackendSource, number>
  totals: Record<BackendSource, number | null>
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const PAGE_SIZE = 100
const MAX_PAGES = 50

/** 後台時間參數是 UTC+8 的「YYYY-MM-DD HH:mm:ss」 */
export function fmtBackendTime(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

export async function fetchBackendLogs(
  cfg: BackendConfig,
  q: { userName: string; fromMs: number; toMs: number },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<BackendFetchResult> {
  const base = cfg.baseUrl.replace(/\/$/, '')
  const reasons: string[] = []
  const pages = { logThirdHttpReq: 0, logThirdHttpBetReq: 0 } as Record<BackendSource, number>
  const totals = { logThirdHttpReq: null, logThirdHttpBetReq: null } as Record<BackendSource, number | null>
  const baseHeaders = { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', origin: cfg.origin, referer: cfg.origin ? `${cfg.origin.replace(/\/$/, '')}/` : '' }
  let token = '', lastLoginTime = ''

  const login = async (): Promise<boolean> => {
    try {
      const r = await fetchImpl(`${base}/auth/login`, { method: 'POST', headers: baseHeaders, body: JSON.stringify({ username: cfg.username, password: cfg.password }), signal: AbortSignal.timeout(15_000) })
      const d = await r.json() as { code?: number; message?: string; data?: { token?: string; lastLoginTime?: number } }
      if (d.code === 20000 && d.data?.token) { token = d.data.token; lastLoginTime = String(d.data.lastLoginTime ?? ''); return true }
      reasons.push(`後台登入失敗（code ${d.code ?? r.status}${d.message ? `：${String(d.message).slice(0, 80)}` : ''}）`)
      return false
    } catch (e) {
      reasons.push(`後台登入連線失敗：${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  if (!cfg.baseUrl || !cfg.username || !cfg.password) {
    return { items: [], complete: false, reasons: ['這個環境的後台帳密還沒設定（請管理員到「後台設定」填）'], pages, totals }
  }
  if (!(await login())) return { items: [], complete: false, reasons, pages, totals }

  const items: BackendItem[] = []
  for (const ep of ['logThirdHttpReq', 'logThirdHttpBetReq'] as BackendSource[]) {
    let got = 0
    let relogged = false
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) { reasons.push(`${ep} 超過 ${MAX_PAGES} 頁上限，後面沒抓`); break }
      const params = new URLSearchParams()
      params.set('page', String(page)); params.set('pageSize', String(PAGE_SIZE))
      params.append('dateTime[]', fmtBackendTime(q.fromMs)); params.append('dateTime[]', fmtBackendTime(q.toMs))
      params.set('userId', ''); params.set('userName', q.userName)
      if (ep === 'logThirdHttpReq') { params.set('event', ''); params.set('status', '0') }
      params.set('channelId', cfg.channelId)
      let d: { code?: number; message?: string; data?: { items?: unknown[]; total?: number } }
      try {
        const r = await fetchImpl(`${base}/log/${ep}?${params}`, { method: 'POST', headers: { ...baseHeaders, token, lastlogintime: lastLoginTime }, signal: AbortSignal.timeout(20_000) })
        d = await r.json() as typeof d
      } catch (e) {
        reasons.push(`${ep} 第 ${page} 頁查詢失敗：${e instanceof Error ? e.message : String(e)}`)
        break
      }
      if (d.code === 40200 && !relogged) { relogged = true; if (await login()) { page--; continue } break }
      if (d.code !== undefined && d.code !== 20000 && !Array.isArray(d.data?.items)) {
        reasons.push(`${ep} 第 ${page} 頁回 code ${d.code}${d.message ? `：${String(d.message).slice(0, 80)}` : ''}`)
        break
      }
      const list = Array.isArray(d.data?.items) ? d.data!.items! : null
      if (!list) { reasons.push(`${ep} 第 ${page} 頁回應沒有 data.items`); break }
      if (typeof d.data?.total === 'number') totals[ep] = d.data.total
      pages[ep] = page
      for (const raw of list) if (raw && typeof raw === 'object') items.push(normalizeBackendItem(raw as Record<string, unknown>, ep))
      got += list.length
      if (list.length < PAGE_SIZE) break
    }
    if (totals[ep] !== null && got !== totals[ep]) reasons.push(`${ep} 抓到 ${got} 筆，後台說共有 ${totals[ep]} 筆`)
  }
  // 後台的 userName 篩選若沒生效，這裡再擋一次：只留這個帳號
  const mine = items.filter(it => !it.username || it.username.toLowerCase() === q.userName.toLowerCase())
  if (mine.length !== items.length) reasons.push(`後台回了 ${items.length - mine.length} 筆別的帳號（已排除，可能是 userName 篩選沒生效）`)
  return { items: mine, complete: reasons.every(r => r.includes('已排除')), reasons, pages, totals }
}

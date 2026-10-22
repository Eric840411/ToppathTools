/**
 * 應用層出站白名單（資安 2026-10-22，CodeX 同意的做法）。
 *
 * 目的：就算哪天又被打進來（SSRF、遠端執行、被污染的套件），也不能把資料送到清單外的主機。
 * 運維的安全組／出站代理才是獨立防線；這層是第二道，而且只管**這支 Node process 自己**發出的連線——
 * 子程序（python、uat-runner 本機模式）與 Local Agent 管不到，要靠運維那層。
 *
 * 攔在 `net.Socket.prototype.connect`：fetch（undici）、ws、http/https、阿里雲 SDK 最後都會走到這裡，
 * 一處攔全部，不用逐個函式庫掛 dispatcher。
 *
 * 模式（CodeX：程式預設 enforce，report 要明確設定而且有期限）：
 *   - 預設 enforce：清單外直接中斷連線（ECONNREFUSED 風格錯誤）並記 log
 *   - EGRESS_MODE=report 且 EGRESS_REPORT_UNTIL=<ISO 時間> 尚未到期：只記 log、不擋
 *     沒設到期或已過期 → 自動回到 enforce，並在 log 寫明
 * log 只記主機與埠，不記路徑／query／header（可能帶 key）。
 *
 * 清單：
 *   - 自家網域（OSM／LuckyLink）用後綴：*.osmplay.com、*.osmplay-new.com、*.osmslot.org、*.cliveslot.com
 *   - 共用平台（Google、Lark、阿里雲）只列**用得到的完整 hostname**——共用網域底下可能有攻擊者的資源
 *   - 環境變數裡設定的網址（*_URL、*_BASE_URL、SLS endpoint/project）啟動時自動加入
 *   - 本機（loopback）與 IPC 一律放行
 *   - 其他由程式動態登記（例如管理員設定的 Ollama 位址）：registerEgressHost()
 */
import net from 'net'
import { isIP } from 'net'
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright'

const OWNED_SUFFIXES = ['osmplay.com', 'osmplay-new.com', 'osmslot.org', 'cliveslot.com']

const STATIC_HOSTS = [
  // Lark／Meegle
  'open.larksuite.com', 'project.larksuite.com',
  // Google（Gemini、Sheets、Docs、Drive 附件、OAuth）
  'generativelanguage.googleapis.com', 'sheets.googleapis.com', 'www.googleapis.com', 'oauth2.googleapis.com',
  'docs.google.com', 'drive.google.com', 'drive.usercontent.google.com',
  // OpenAI（有設 key 才會用）
  'api.openai.com',
  // 版號告警允許的另一個 Lark webhook 網域（osm.ts LARK_WEBHOOK_HOSTS）
  'open.feishu.cn',
]

/** Google Doc 匯出／Drive 下載會 307 轉到每個檔案不同的 doc-xx-xx-docs.googleusercontent.com，只放這個形狀 */
const HOST_PATTERNS = [/^doc-[a-z0-9-]+-docs\.googleusercontent\.com$/]

const dynamicHosts = new Set<string>()
let envHostsLoaded = false

function hostFromUrl(v: string): string | null {
  try { return new URL(v).hostname.toLowerCase().replace(/^\[|\]$/g, '') } catch { return null }
}

/** 環境變數裡的網址／主機加進清單（dotenv 載入後第一次檢查時讀） */
function loadEnvHosts(env: NodeJS.ProcessEnv = process.env) {
  if (envHostsLoaded) return
  envHostsLoaded = true
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue
    if (/(_URL|_BASE_URL|_BASE|_ENDPOINT_URL)$/.test(k) && /^https?:\/\//i.test(v)) {
      const h = hostFromUrl(v)
      if (h) dynamicHosts.add(h)
    }
  }
  // OSM 渠道設定（JSON 陣列，origin／baseUrl 欄位）
  for (const m of String(env.OSM_CHANNELS ?? '').matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) {
    const h = hostFromUrl(m[0]); if (h) dynamicHosts.add(h)
  }
  // 阿里雲 SLS：SDK 會連 <project>.<endpoint>
  const slsEndpoint = (env.SLS_ENDPOINT || 'ap-southeast-1.log.aliyuncs.com').toLowerCase()
  const recordbetRegion = (env.SLS_RECORDBET_REGION || 'ap-southeast-1').toLowerCase()
  const recordbetEndpoint = `${recordbetRegion}.log.aliyuncs.com`
  dynamicHosts.add(slsEndpoint)
  dynamicHosts.add(recordbetEndpoint)
  for (const [k, v] of Object.entries(env)) {
    if (/^SLS_.*PROJECT$/.test(k) && v) {
      dynamicHosts.add(`${v.toLowerCase()}.${slsEndpoint}`)
      dynamicHosts.add(`${v.toLowerCase()}.${recordbetEndpoint}`)
    }
  }
  // SDK 預設的 recordBet project（見 lib/sls.ts）
  dynamicHosts.add(`${(env.SLS_RECORDBET_PROJECT || 'qat-toppath-osm-logs').toLowerCase()}.${recordbetEndpoint}`)
}

/** 程式執行中才知道的合法目的地（例如管理員設定的 Ollama 位址）。只收 hostname／IP，不收萬用字元 */
export function registerEgressHost(hostOrUrl: string | null | undefined) {
  if (!hostOrUrl) return
  const h = /^https?:\/\//i.test(hostOrUrl) ? hostFromUrl(hostOrUrl) : hostOrUrl.toLowerCase()
  if (h) dynamicHosts.add(h)
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.') || h === '::ffff:127.0.0.1'
}

export function isEgressAllowed(rawHost: string, env: NodeJS.ProcessEnv = process.env): boolean {
  loadEnvHosts(env)
  const host = rawHost.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host || isLoopback(host)) return true
  if (STATIC_HOSTS.includes(host) || dynamicHosts.has(host)) return true
  if (HOST_PATTERNS.some(re => re.test(host))) return true
  if (!isIP(host) && OWNED_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`))) return true
  return false
}

export type EgressMode = 'enforce' | 'report'

export function egressMode(env: NodeJS.ProcessEnv = process.env, now = Date.now()): { mode: EgressMode; reason: string } {
  if ((env.EGRESS_MODE ?? '').toLowerCase() !== 'report') return { mode: 'enforce', reason: '預設' }
  const until = Date.parse(env.EGRESS_REPORT_UNTIL ?? '')
  if (!Number.isFinite(until)) return { mode: 'enforce', reason: 'EGRESS_MODE=report 但沒設 EGRESS_REPORT_UNTIL，維持 enforce' }
  if (until <= now) return { mode: 'enforce', reason: `report 期限 ${env.EGRESS_REPORT_UNTIL} 已過，恢復 enforce` }
  return { mode: 'report', reason: `report 到 ${env.EGRESS_REPORT_UNTIL}` }
}

const lastLogged = new Map<string, number>()
function logViolation(host: string, port: unknown, mode: EgressMode) {
  const key = `${host}:${port}:${mode}`
  const now = Date.now()
  if ((lastLogged.get(key) ?? 0) > now - 10 * 60_000) return
  lastLogged.set(key, now)
  const tag = mode === 'enforce' ? 'BLOCKED' : 'WOULD-BLOCK'
  console.warn(`[egress] ${tag} host=${host} port=${port ?? ''} pid=${process.pid}`)
}

let installed = false

/** 掛上攔截。main 與 worker 各自在最早的 import 呼叫一次 */
export function installEgressGuard(label: string) {
  if (installed) return
  installed = true
  const proto = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => net.Socket }
  const original = proto.connect
  proto.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    let host: string | undefined
    let port: unknown
    let isPath = false
    const a0 = args[0]
    if (Array.isArray(a0)) {
      // net 內部用 normalized args 呼叫：[options, cb]
      const o = a0[0] as { host?: string; port?: unknown; path?: string } | undefined
      if (o && typeof o === 'object') { host = o.host; port = o.port; isPath = !!o.path }
    } else if (a0 && typeof a0 === 'object') {
      const o = a0 as { host?: string; port?: unknown; path?: string }
      host = o.host; port = o.port; isPath = !!o.path
    } else if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {
      port = a0; host = typeof args[1] === 'string' ? args[1] : 'localhost'
    } else if (typeof a0 === 'string') {
      isPath = true // IPC pipe
    }
    if (!isPath) {
      const h = host ?? 'localhost'
      if (!isEgressAllowed(h)) {
        const { mode } = egressMode()
        logViolation(h, port, mode)
        if (mode === 'enforce') {
          const err = Object.assign(new Error(`EGRESS_BLOCKED: ${h} 不在出站白名單`), { code: 'EGRESS_BLOCKED' })
          process.nextTick(() => this.destroy(err))
          return this
        }
      }
    }
    return original.apply(this, args)
  }
  const m = egressMode()
  console.log(`[egress] 出站白名單已啟用（${label}）：${m.mode}（${m.reason}）`)
}

/**
 * headless 瀏覽器是獨立 process，上面的攔截管不到：在 context 層 route（含 popup 的第一個請求）、
 * 擋 WebSocket、建 context 時要帶 serviceWorkers: 'block'（呼叫端負責）。
 * 遊戲前端會載入一些第三方資源（CDN、統計），額外允許清單用 extraHosts 帶進來。
 */
export async function guardBrowserContext(
  context: BrowserContext,
  extraHosts: readonly string[] = [],
) {
  const allowed = (url: string): boolean => {
    let u: URL
    try { u = new URL(url) } catch { return false }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true
    if (!/^(https?|wss?):$/.test(u.protocol)) return false
    const h = u.hostname.toLowerCase()
    return isEgressAllowed(h) || extraHosts.some(x => h === x || (x.startsWith('.') && h.endsWith(x)))
  }
  await context.route('**/*', route => {
    const url = route.request().url()
    if (allowed(url)) return route.continue()
    const { mode } = browserEgressMode()
    let host = ''
    try { host = new URL(url).hostname } catch { /* ignore */ }
    logViolation(`browser:${host}`, '', mode)
    return mode === 'enforce' ? route.abort('blockedbyclient') : route.continue()
  })
  if (context.routeWebSocket) {
    await context.routeWebSocket(/.*/, ws => {
      if (allowed(ws.url())) { ws.connectToServer(); return }
      const { mode } = browserEgressMode()
      let host = ''
      try { host = new URL(ws.url()).hostname } catch { /* ignore */ }
      logViolation(`browser-ws:${host}`, '', mode)
      if (mode === 'enforce') return ws.close({ code: 1008, reason: 'egress blocked' })
      ws.connectToServer()
    })
  }
}

/** 遊戲前端頁面會用到的第三方資源（從 Config 模板的 serverCfg 整理；統計類被擋不影響遊戲本身） */
export const GAME_PAGE_EXTRA_HOSTS = [
  'front-image-osm-qat.oss-ap-southeast-1.aliyuncs.com', 'liveslot-oss-dev.oss-ap-southeast-1.aliyuncs.com',
  'osmclient-c-new.bewen.me', 'fonts.googleapis.com', 'fonts.gstatic.com',
] as const

/**
 * 瀏覽器這層的模式：**預設 report（只記不擋）**，設 BROWSER_EGRESS_MODE=enforce 才擋。
 * 跟 Node 那層相反的原因：伺服器上跑的 headless 頁面都是 OSM 遊戲前端，會載入騰訊 RTC 視訊外掛（bewen.me）、
 * 統計、客服、阿里雲 OSS 等第三方資源，完整清單還不知道——直接擋會讓 Game Show／Scripted Bet 這些工具壞掉。
 * 先收 log（`[egress] WOULD-BLOCK host=browser:…`）把清單補齊，再切 enforce。
 */
export function browserEgressMode(env: NodeJS.ProcessEnv = process.env): { mode: EgressMode; reason: string } {
  return (env.BROWSER_EGRESS_MODE ?? '').toLowerCase() === 'enforce'
    ? { mode: 'enforce', reason: 'BROWSER_EGRESS_MODE=enforce' }
    : { mode: 'report', reason: '瀏覽器預設 report' }
}

/** 伺服器端開瀏覽器一律用這個：停用 Service Worker（不然請求繞過 route）＋掛出站攔截 */
export async function newGuardedContext(browser: Browser, opts: BrowserContextOptions = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' })
  await guardBrowserContext(ctx, GAME_PAGE_EXTRA_HOSTS)
  return ctx
}

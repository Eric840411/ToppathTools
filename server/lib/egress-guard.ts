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
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright'

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
  if (h === 'localhost' || h === '::1') return true
  // 一定要先確認是 IPv4 字面值再看 127/8：只看 startsWith('127.') 會放行 127.attacker.example（CodeX 審 529c495 [P1]）
  if (isIP(h) === 4) return h.startsWith('127.')
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return !!mapped && isIP(mapped[1]) === 4 && mapped[1].startsWith('127.')
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

/** prefix＝''（Node 這層）或 'BROWSER_'（瀏覽器那層）；兩層規則一樣：預設 enforce，report 必須設期限 */
export function egressMode(env: NodeJS.ProcessEnv = process.env, now = Date.now(), prefix = ''): { mode: EgressMode; reason: string } {
  const modeKey = `${prefix}EGRESS_MODE`, untilKey = `${prefix}EGRESS_REPORT_UNTIL`
  if ((env[modeKey] ?? '').toLowerCase() !== 'report') return { mode: 'enforce', reason: '預設' }
  const until = Date.parse(env[untilKey] ?? '')
  if (!Number.isFinite(until)) return { mode: 'enforce', reason: `${modeKey}=report 但沒設 ${untilKey}，維持 enforce` }
  if (until <= now) return { mode: 'enforce', reason: `report 期限 ${env[untilKey]} 已過，恢復 enforce` }
  return { mode: 'report', reason: `report 到 ${env[untilKey]}` }
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

// ─── report 到期：主動收掉 report 期間放行的東西 ─────────────────────────────────────
// CodeX 審 7508e3e [P1]：只在「建立連線時」檢查的話，report 期間建立的外站 socket／WebSocket、
// report 期間開的瀏覽器與錄製用 Chrome，到期後都還活著、還能繼續傳資料。
// 所以 report 期間放行的每一樣都列冊，一到期（或被改成 enforce）就關掉。
type Prefix = '' | 'BROWSER_'
const reportCleanups: Record<Prefix, Set<() => void>> = { '': new Set(), BROWSER_: new Set() }
let expiryTimer: ReturnType<typeof setInterval> | null = null

/** 立刻檢查一次：已經不是 report 的那一層，把列冊的東西全部關掉。回傳關掉幾個（測試用） */
export function checkReportExpiry(env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  let closed = 0
  for (const prefix of ['', 'BROWSER_'] as Prefix[]) {
    if (egressMode(env, now, prefix).mode === 'report') continue
    const set = reportCleanups[prefix]
    if (!set.size) continue
    console.warn(`[egress] ${prefix ? '瀏覽器' : 'Node'} report 期已結束，關閉 report 期間放行的 ${set.size} 個連線／瀏覽器`)
    for (const fn of [...set]) { try { fn() } catch { /* 已經關了 */ } closed++ }
    set.clear()
  }
  return closed
}

const exactTimers: Partial<Record<Prefix, { timer: ReturnType<typeof setTimeout>; until: number }>> = {}

/** 精準計時：在 report 到期那一刻檢查（30 秒輪詢只是備援，不然到期後會有最多 30 秒空窗——CodeX 審 c96c6aa）。
 *  期限變了（例如改了設定）就重設 */
function armExactTimer(prefix: Prefix, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const until = Date.parse(env[`${prefix}EGRESS_REPORT_UNTIL`] ?? '')
  const cur = exactTimers[prefix]
  if (cur && cur.until === until) return
  if (cur) { clearTimeout(cur.timer); delete exactTimers[prefix] }
  if (!Number.isFinite(until)) return
  const delay = Math.min(Math.max(until - now, 0) + 50, 2_147_000_000)
  const timer = setTimeout(() => { delete exactTimers[prefix]; checkReportExpiry(); if (reportCleanups[prefix].size) armExactTimer(prefix) }, delay)
  timer.unref?.()
  exactTimers[prefix] = { timer, until }
}

/**
 * 登記「沒有被完整防護的東西」；回傳取消登記的函式（東西自己先關掉時呼叫）。
 * ⚠️ 登記完**立刻檢查一次**：啟動時還在 report、登記時已經到期的話，要當場關掉（CodeX 審 c96c6aa [P1]）。
 */
export function onReportExpiry(prefix: Prefix, cleanup: () => void): () => void {
  reportCleanups[prefix].add(cleanup)
  if (!expiryTimer) {
    expiryTimer = setInterval(() => { checkReportExpiry(); for (const p of ['', 'BROWSER_'] as Prefix[]) if (reportCleanups[p].size) armExactTimer(p) }, 30_000)
    expiryTimer.unref?.()
  }
  armExactTimer(prefix)
  checkReportExpiry()
  return () => { reportCleanups[prefix].delete(cleanup) }
}

/** 錄製／headed 用 spawn 開的 Chrome：report 期間開的，到期就結束它 */
export function registerReportBrowserProcess(proc: { kill(signal?: NodeJS.Signals): boolean; once(ev: 'exit', fn: () => void): unknown }, launchArgs: readonly string[]) {
  // 凡是沒帶 DNS 規則就納管，不看「現在」是不是 report——產生參數時是 report、登記時已到期的，登記當下就會被關
  if (launchArgs.some(a => a.startsWith('--host-resolver-rules=MAP * ~NOTFOUND'))) return
  const off = onReportExpiry('BROWSER_', () => { proc.kill() })
  proc.once('exit', off)
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
        // report 放行的清單外連線：到期就切斷
        const off = onReportExpiry('', () => this.destroy(Object.assign(new Error(`EGRESS_REPORT_EXPIRED: ${h}`), { code: 'EGRESS_BLOCKED' })))
        this.once('close', off)
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
  hasDnsRules = false,
) {
  // 沒帶 host-resolver-rules 的瀏覽器（report 期間啟動、或不是走 launchGuardedChromium 開的）擋不住轉址：
  // 只要現在是 enforce 就整個停擺（fail closed），請使用者重開瀏覽器——report 到期後既有瀏覽器不會留下缺口
  //（CodeX 審 f2c9fa3 [P1]）
  const failClosed = () => !hasDnsRules && browserEgressMode().mode === 'enforce'
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
    if (failClosed() && !/^(data|blob|about):/.test(url)) {
      logViolation('browser:(沒有 DNS 規則的瀏覽器，請重新啟動)', '', 'enforce')
      return route.abort('blockedbyclient')
    }
    // ⚠️ route 只攔第一跳：放行後瀏覽器自己跟 3xx，下一跳不會再進來（實測連 route.fulfill 交回 3xx 也一樣）。
    //    轉址的逐跳限制靠啟動參數 browserGuardLaunchArgs() 的 --host-resolver-rules（CodeX 審 529c495 [P1]）
    if (allowed(url)) return route.continue()
    const { mode } = browserEgressMode()
    let host = ''
    try { host = new URL(url).hostname } catch { /* ignore */ }
    logViolation(`browser:${host}`, '', mode)
    return mode === 'enforce' ? route.abort('blockedbyclient') : route.continue()
  })
  if (context.routeWebSocket) {
    await context.routeWebSocket(/.*/, ws => {
      if (failClosed()) return ws.close({ code: 1008, reason: 'egress: restart browser' })
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
 * 瀏覽器這層的模式：跟 Node 那層同一套規則——**預設 enforce**，要觀察第三方資源清單時設
 * BROWSER_EGRESS_MODE=report＋BROWSER_EGRESS_REPORT_UNTIL=<ISO>，過期自動回 enforce（CodeX：不接受無期限 report）。
 * 遊戲頁需要的第三方資源逐項加進 GAME_PAGE_EXTRA_HOSTS；統計（PostHog）、客服（lc.chat）不是必要就不加。
 * 觀察期看 `[egress] WOULD-BLOCK host=browser:…`。
 * ⚠️ WebRTC（TRTC 視訊）走 UDP，不經過 route，這層管不到——要靠運維的出站防線。
 */
export function browserEgressMode(env: NodeJS.ProcessEnv = process.env, now = Date.now()): { mode: EgressMode; reason: string } {
  return egressMode(env, now, 'BROWSER_')
}

/**
 * 瀏覽器啟動參數：讓 Chromium 的 DNS 解析只認白名單（`MAP * ~NOTFOUND` 再逐一 EXCLUDE）。
 * 這是網路層的限制，轉址的每一跳、子資源、WebSocket 都要解析主機名，所以都會被擋——補上 route 只攔第一跳的洞。
 * 實測 IP 字面值（http://1.2.3.4）也會被 `MAP *` 對到，所以轉址到 IP 一樣擋得住；本機要明確 EXCLUDE 127.0.0.1。
 * ⚠️ WebRTC（UDP）不經過這裡，要靠運維的出站防線。
 * report 模式不加（只記不擋）。Chromium 只認最後一個 --host-resolver-rules，呼叫端不要再自己帶一個。
 */
export function browserGuardLaunchArgs(extraHosts: readonly string[] = GAME_PAGE_EXTRA_HOSTS, env: NodeJS.ProcessEnv = process.env, extraRules: string[] = []): string[] {
  if (browserEgressMode(env).mode !== 'enforce') return []
  loadEnvHosts(env)
  const excludes = new Set<string>(['localhost', '127.0.0.1', '[::1]', ...STATIC_HOSTS, ...dynamicHosts, ...extraHosts.map(h => h.replace(/^\./, '*.'))])
  for (const s of OWNED_SUFFIXES) { excludes.add(s); excludes.add(`*.${s}`) }
  // doc-xx-xx-docs.googleusercontent.com（Google Doc 匯出轉址）
  excludes.add('*-docs.googleusercontent.com')
  const rules = ['MAP * ~NOTFOUND', ...[...excludes].map(h => `EXCLUDE ${h}`), ...extraRules]
  return [`--host-resolver-rules=${rules.join(', ')}`]
}

/** 啟動時有帶 host-resolver-rules 的瀏覽器 */
const dnsGuardedBrowsers = new WeakSet<object>()

/** 呼叫端自己用其他方式啟動（例如 spawn Chrome 再 connectOverCDP）時，照實登記有沒有帶規則 */
export function markBrowserDnsGuard(browser: object, launchArgs: readonly string[]) {
  if (launchArgs.some(a => a.startsWith('--host-resolver-rules=MAP * ~NOTFOUND'))) dnsGuardedBrowsers.add(browser)
}

/** 伺服器端開 Chromium 一律用這個：合併 DNS 規則參數並登記 */
export async function launchGuardedChromium(
  launcher: { launch(opts?: LaunchOptions): Promise<Browser> },
  opts: LaunchOptions = {},
): Promise<Browser> {
  const guard = browserGuardLaunchArgs()
  const args = [...(opts.args ?? []), ...guard]
  const browser = await launcher.launch({ ...opts, args })
  markBrowserDnsGuard(browser, args)
  // report 期間開的（沒有 DNS 規則）：到期整個關掉，裡面的 WebSocket 一起斷
  // 沒帶 DNS 規則一律納管（不看現在的模式），登記當下若已到期會立刻關閉
  if (!dnsGuardedBrowsers.has(browser)) {
    const off = onReportExpiry('BROWSER_', () => { void browser.close().catch(() => {}) })
    browser.on('disconnected', off)
  }
  return browser
}

/** 伺服器端開瀏覽器一律用這個：停用 Service Worker（不然請求繞過 route）＋掛出站攔截 */
export async function newGuardedContext(browser: Browser, opts: BrowserContextOptions = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' })
  await guardBrowserContext(ctx, GAME_PAGE_EXTRA_HOSTS, dnsGuardedBrowsers.has(browser))
  return ctx
}

/** connectOverCDP 拿到的既有 context（headed 模式）也要掛攔截 */
export async function guardExistingContext(browser: Browser, ctx: BrowserContext): Promise<BrowserContext> {
  await guardBrowserContext(ctx, GAME_PAGE_EXTRA_HOSTS, dnsGuardedBrowsers.has(browser))
  return ctx
}

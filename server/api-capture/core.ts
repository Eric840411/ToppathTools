/**
 * API 參數紀錄：彙整／時間校正／參數簽名／比對（純函式，不碰 DB、不連網）。
 * docs/features/35-api-capture.md；測試 server/api-capture/core.test.ts。
 */
import { maskText, HTTP_NOISE_HOST } from './mask.js'
import type { FrontEvent, SpinRecord } from './types.js'

// ─── 後台日誌 ──────────────────────────────────────────────────────────────────

export type BackendSource = 'logThirdHttpReq' | 'logThirdHttpBetReq'
export const BACKEND_SOURCE_LABEL: Record<BackendSource, string> = {
  logThirdHttpReq: 'Log Third Http Req',
  logThirdHttpBetReq: 'Log Third Bet Req',
}

export interface BackendItem {
  source: BackendSource
  id: string
  event: string
  url: string
  /** 後台時鐘（毫秒） */
  reqtime: number
  restime: number | null
  useTime: number | null
  state: number | null
  isSuccess: boolean | null
  error: number | null
  username: string
  userid: string
  gmid: string
  roundId: string
  reference: string
  /** 已遮罩 */
  postData: string
  /** 已遮罩 */
  result: string
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

export function normalizeBackendItem(raw: Record<string, unknown>, source: BackendSource): BackendItem {
  const oid = (raw._id && typeof raw._id === 'object' ? (raw._id as Record<string, unknown>).$oid : raw._id) ?? ''
  return {
    source,
    id: str(oid),
    event: str(raw.event),
    url: maskText(str(raw.wholeUrl ?? raw.url)),
    reqtime: Number(raw.reqtime ?? 0),
    restime: numOrNull(raw.restime),
    useTime: numOrNull(raw.useTime),
    state: numOrNull(raw.state),
    isSuccess: typeof raw.isSuccess === 'boolean' ? raw.isSuccess : null,
    error: numOrNull(raw.error),
    username: str(raw.username ?? raw.userName),
    userid: str(raw.userid ?? raw.userId),
    gmid: str(raw.gmid),
    roundId: str(raw.roundId),
    reference: str(raw.reference),
    postData: maskText(str(raw.postData)),
    result: maskText(str(raw.result)),
  }
}

/** 字串若是 JSON 就解析，不是就回 undefined */
export function tryJson(s: string): unknown {
  const t = (s ?? '').trim()
  if (!t || !/^[{[]/.test(t)) return undefined
  try { return JSON.parse(t) } catch { return undefined }
}

export function pretty(s: string): string {
  const j = tryJson(s)
  return j === undefined ? (s ?? '') : JSON.stringify(j, null, 2)
}

// ─── 時間校正 ──────────────────────────────────────────────────────────────────

export interface Calibration {
  /** recordBet：用前台每局 moneyNtc end 對後台 recordBet；server-clock：只用 agent↔server 時差（假設 server≈後台）；none：都沒有 */
  method: 'recordBet' | 'server-clock' | 'none'
  /** agent 時鐘 + offsetMs = 後台時鐘 */
  offsetMs: number
  pairs: number
  /** 各局差值的最大−最小（毫秒），越小越可信 */
  spreadMs: number | null
  agentToServerMs: number | null
  note: string
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/**
 * 依「順序」對齊前台局與後台 recordBet：嘗試每一種位移，挑最可信的那一種。
 * ⚠️ 不用「找最近的一筆」——一局 4 秒、時鐘可能差好幾分鐘，最近那筆常常是隔壁局。
 * 局識別（CodeX 1118 [P2]）：前台每局的派彩（moneyNtc end − begin）要等於 recordBet 的 payout，對不上的位移扣分；
 * 局距均勻時多種位移會一樣集中——那時用 agent↔server 時差挑最接近的，**挑不出來就不校正**（不能隨便選最早那個）。
 */
export interface RecordBetPoint { reqtime: number; payout: number | null }

export function calibrate(spins: SpinRecord[], recordBets: RecordBetPoint[], agentToServerMs: number | null): Calibration {
  const ends = spins.filter((s): s is SpinRecord & { tEnd: number } => typeof s.tEnd === 'number').sort((a, b) => a.tEnd - b.tEnd)
  const rbs = [...recordBets].sort((a, b) => a.reqtime - b.reqtime)
  const fallback = (note: string): Calibration => agentToServerMs !== null
    ? { method: 'server-clock', offsetMs: agentToServerMs, pairs: 0, spreadMs: null, agentToServerMs, note }
    : { method: 'none', offsetMs: 0, pairs: 0, spreadMs: null, agentToServerMs, note }
  if (!ends.length || !rbs.length) return fallback(ends.length ? '後台沒有 recordBet 可對齊' : '前台沒有看到每局結束（moneyNtc end）')
  type Cand = { diffs: number[]; spread: number; mismatch: number; offset: number }
  const cands: Cand[] = []
  const need = Math.min(ends.length, rbs.length)
  for (let k = -(ends.length - 1); k <= rbs.length - 1; k++) {
    const diffs: number[] = []
    let mismatch = 0
    for (let i = 0; i < ends.length; i++) {
      const j = i + k
      if (j < 0 || j >= rbs.length) continue
      diffs.push(rbs[j].reqtime - ends[i].tEnd)
      const w = ends[i].win, p = rbs[j].payout
      if (w !== null && p !== null && Math.abs(w - p) > 0.001) mismatch++
    }
    if (diffs.length < need) continue   // 只接受最大重疊（避免只對上一筆就被當成最集中）
    cands.push({ diffs, spread: Math.max(...diffs) - Math.min(...diffs), mismatch, offset: Math.round(median(diffs)) })
  }
  if (!cands.length) return fallback('對不齊')
  cands.sort((a, b) => a.mismatch - b.mismatch || a.spread - b.spread)
  const top = cands[0]
  if (top.spread > 3000) return { ...fallback(`recordBet 對齊誤差 ${(top.spread / 1000).toFixed(1)} 秒過大，改用伺服器時差`), spreadMs: top.spread }
  // 跟最好的一樣好（派彩一樣對得上、誤差也在 3 秒內）的其他位移＝歧義
  const ties = cands.filter(c => c !== top && c.mismatch === top.mismatch && c.spread <= 3000 && Math.abs(c.offset - top.offset) > 1000)
  let best = top
  let tieNote = ''
  if (ties.length) {
    if (agentToServerMs === null) return fallback(`有 ${ties.length + 1} 種對齊方式一樣吻合（每局派彩分不出來），無法判斷`)
    const byPrior = [top, ...ties].sort((a, b) => Math.abs(a.offset - agentToServerMs) - Math.abs(b.offset - agentToServerMs))
    const d0 = Math.abs(byPrior[0].offset - agentToServerMs), d1 = Math.abs(byPrior[1].offset - agentToServerMs)
    // 最接近伺服器時差的那個要明顯比第二名近（差 ≥ 半個局距、至少 1 秒），不然還是分不出來
    const gap = Math.max(1000, Math.abs(byPrior[1].offset - byPrior[0].offset) / 2)
    if (d1 - d0 < gap) return fallback(`有 ${ties.length + 1} 種對齊方式一樣吻合，伺服器時差也分不出來`)
    best = byPrior[0]
    tieNote = `（有 ${ties.length + 1} 種對齊一樣吻合，以伺服器時差挑最接近的）`
  }
  // 只有一組時無從判斷集中度：跟 agent↔server 時差差太多（>5 分鐘）就不信
  if (best.diffs.length === 1 && agentToServerMs !== null && Math.abs(best.offset - agentToServerMs) > 300_000) return fallback('只有一局可對、且跟伺服器時差不一致')
  if (best.mismatch > 0) return { ...fallback(`recordBet 的派彩跟前台對不上 ${best.mismatch} 局，改用伺服器時差`), spreadMs: best.spread }
  return { method: 'recordBet', offsetMs: best.offset, pairs: best.diffs.length, spreadMs: best.spread, agentToServerMs, note: `以 ${best.diffs.length} 局 recordBet 對齊，誤差 ${(best.spread / 1000).toFixed(2)} 秒${tieNote}` }
}

// ─── 時間軸 ────────────────────────────────────────────────────────────────────

export interface TimelineRow {
  /** 後台時鐘（毫秒） */
  t: number
  kind: 'step' | 'backend'
  action: string
  api: string
  direction: string
  req: string
  res: string
  source: string
  /** backend 才有 */
  backendId?: string
}

const STEP_LABEL: Record<string, string> = {
  'open-lobby': '開啟 OSM 大廳', 'find-machine': '大廳找到機台', 'click-join': '點 Join 進機台', 'in-game': '進入機台畫面',
  'select-denom': '選面額（預設最小）', 'got-payout': '出現派彩，停止 Spin', 'spins-reached': '達到指定局數，停止 Spin',
  'max-spins-no-payout': '達到最多局數仍沒派彩，停止', 'exit-begin': '退出機台', 'exit-done': '退出完成', cancelled: '使用者取消', error: '前台錯誤',
}

export function stepLabel(action: string, detail?: Record<string, unknown>): string {
  if (action === 'spin' && detail) {
    const w = detail.win
    return `第 ${detail.n} 局 Spin（${w === null || w === undefined ? '看不到派彩資訊' : Number(w) > 0 ? `派彩 ${w}` : '沒派彩'}）`
  }
  if (action === 'find-machine' && detail?.cardName) return `大廳找到機台 ${detail.cardName}`
  if (action === 'exit-done' && detail && detail.ok === false) return '退出失敗（位子可能還佔著）'
  return STEP_LABEL[action] ?? action
}

export function backendAction(item: BackendItem, spinNo: number | null): string {
  const pd = tryJson(item.postData) as Record<string, unknown> | undefined
  const amount = pd && typeof pd.amount === 'number' ? pd.amount : null
  switch (item.event) {
    case 'authenticate': return '開大廳：OSM 向 CP 驗證 token，取回餘額、playerLevel'
    case 'balance': return '大廳：OSM 向 CP 查詢餘額'
    case 'recharge': return amount !== null && amount < 0 ? `進機台：CP 錢包轉入 OSM（${amount}）` : `退出機台：OSM 餘額轉回 CP（${amount !== null ? `+${amount}` : ''}）`
    case 'recordBet': return `第 ${spinNo ?? '?'} 局結算上報（注 ${pd?.amount ?? '?'}，派彩 ${pd?.payout ?? '?'}）`
    default: return item.event
  }
}

export function buildTimeline(steps: Extract<FrontEvent, { kind: 'step' }>[], backend: BackendItem[], offsetMs: number): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const s of steps) {
    const { url: _u, ...rest } = (s.detail ?? {}) as Record<string, unknown>
    rows.push({ t: s.t + offsetMs, kind: 'step', action: stepLabel(s.action, s.detail), api: '—', direction: '玩家操作（前台）', req: Object.keys(rest).length ? maskText(rest) : '', res: '', source: '前台腳本' })
  }
  let spinNo = 0
  for (const b of [...backend].sort((a, z) => a.reqtime - z.reqtime)) {
    if (b.event === 'recordBet') spinNo++
    rows.push({
      t: b.reqtime, kind: 'backend', action: backendAction(b, b.event === 'recordBet' ? spinNo : null), api: b.event, direction: 'OSM → CP',
      req: b.postData, res: b.result, backendId: b.id,
      source: `後台 ${BACKEND_SOURCE_LABEL[b.source]}｜HTTP ${b.state ?? '?'}${b.useTime !== null ? `｜${b.useTime}ms` : ''}`,
    })
  }
  return rows.sort((a, z) => a.t - z.t || (a.kind === 'step' ? -1 : 1))
}

/** 只留前台時間窗內（已換成後台時鐘）的後台日誌；窗外的另外回傳給說明頁 */
export function splitByWindow(items: BackendItem[], startMs: number, endMs: number, padBefore = 60_000, padAfter = 120_000) {
  const lo = startMs - padBefore, hi = endMs + padAfter
  const inside: BackendItem[] = [], outside: BackendItem[] = []
  for (const it of items) (it.reqtime >= lo && it.reqtime <= hi ? inside : outside).push(it)
  return { inside, outside, lo, hi }
}

// ─── 參數簽名 ──────────────────────────────────────────────────────────────────

export interface PathInfo { types: string[]; values: string[]; truncated: boolean; volatile: boolean }
export interface ApiSig {
  key: string
  label: string
  source: 'backend' | 'http' | 'ws'
  direction: string
  count: number
  request: Record<string, PathInfo>
  response: Record<string, PathInfo>
}
/** 簽名格式版本。改了路徑規則就要加一，server 比對時遇到舊版會從原始事件重建（v2：HTTP 送出參數分 query／body） */
export const SIGNATURE_VERSION = 2
export interface Signature { version: number; apis: Record<string, ApiSig> }

/** 時間戳／流水號：比對時只忽略「值」，存在與型別照樣檢查 */
const VOLATILE_KEY = /(time|timestamp|date|_at$|At$|^reference$|roundid|transactionid|^hash$|token|^_id$|\$oid|\$date|\$numberlong|^id$|seq|serial|nonce|^sign$|uuid|requestid|traceid|reqid|^ts$|^t$)/i
const VOLATILE_VALUE = /^(\d{13}|\d{10}|[0-9a-f]{24}|[0-9a-f]{32}|[0-9a-f-]{36}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}.*|\*\*\*)$/i

export function isVolatile(path: string, sampleValues: string[]): boolean {
  const last = path.split('.').pop()!.replace(/\[\]$/, '')
  if (VOLATILE_KEY.test(last)) return true
  return sampleValues.length > 0 && sampleValues.every(v => VOLATILE_VALUE.test(v))
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** 巢狀攤平：{a:{b:[{c:1}]}} → a(object)、a.b(array)、a.b[].c(number) */
export function flatten(v: unknown, prefix = '', out: Array<{ path: string; type: string; value: string | null }> = []) {
  const t = typeOf(v)
  if (prefix) out.push({ path: prefix, type: t, value: t === 'object' || t === 'array' ? null : String(v).slice(0, 60) })
  if (t === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, prefix ? `${prefix}.${k}` : k, out)
  else if (t === 'array') for (const x of (v as unknown[]).slice(0, 20)) flatten(x, `${prefix}[]`, out)
  return out
}

/** 遊戲 console 的鬆散物件：`{uid: 350612, gmid: 873-X-0144, road: Array(2), gmInfo: Object}` */
export function parseLooseObject(text: string): Record<string, unknown> | undefined {
  const s = text.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return undefined
  const body = s.slice(1, -1)
  const parts: string[] = []
  let depth = 0, cur = ''
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth++
    if (ch === '}' || ch === ']' || ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  const out: Record<string, unknown> = {}
  for (const p of parts) {
    const i = p.indexOf(':')
    if (i < 0) continue
    const k = p.slice(0, i).trim(), raw = p.slice(i + 1).trim()
    if (!k) continue
    if (/^-?\d+(\.\d+)?$/.test(raw)) out[k] = Number(raw)
    else if (raw === 'true' || raw === 'false') out[k] = raw === 'true'
    else if (raw === 'null' || raw === 'undefined') out[k] = null
    else if (/^Array\(\d+\)$/.test(raw) || raw.startsWith('[')) out[k] = []
    else if (raw === 'Object' || raw.startsWith('{')) out[k] = parseLooseObject(raw) ?? {}
    else out[k] = raw
  }
  return out
}

/** `SEND: 18 hall.hallHandler.watchGMReq {…}`／`ON: 0 moneyNtc {…}` */
export function parsePinusConsole(text: string): { dir: 'send' | 'on'; reqId: number; route: string; params: Record<string, unknown> | undefined } | null {
  const m = /^(SEND|ON):\s*(\d+)\s+(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return null
  return { dir: m[1] === 'SEND' ? 'send' : 'on', reqId: Number(m[2]), route: m[3], params: parseLooseObject(m[4]) }
}

const STATIC_PATH = /\.(json|js|css|png|jpe?g|gif|webp|svg|mp3|mp4|woff2?|ttf|atlas|skel|plist)$/i

/** 前台 HTTP 有沒有資格進參數比對：非雜訊、不是靜態檔 */
export function httpComparable(e: Extract<FrontEvent, { kind: 'http' }>): boolean {
  if (e.noise || HTTP_NOISE_HOST.test(e.url)) return false
  try { return !STATIC_PATH.test(new URL(e.url).pathname) } catch { return false }
}

function httpKey(e: Extract<FrontEvent, { kind: 'http' }>): { key: string; label: string } {
  try { const u = new URL(e.url); return { key: `http:${e.method} ${u.host}${u.pathname}`, label: `${e.method} ${u.pathname}` } } catch { return { key: `http:${e.method} ${e.url}`, label: `${e.method} ${e.url}` } }
}

function parseBody(s: string): unknown {
  const j = tryJson(s)
  if (j !== undefined) return j
  if (s && /^[\w%.-]+=[^&]*(&[\w%.-]+=[^&]*)*$/.test(s.trim())) return Object.fromEntries(new URLSearchParams(s.trim()))
  return undefined
}

/** 前台 HTTP 的送出參數＝網址 query＋body（CodeX 1118 [P2]：只看 body 會漏掉 GET 參數的變更） */
export function httpRequestParts(e: Extract<FrontEvent, { kind: 'http' }>): Record<string, unknown> | undefined {
  let query: Record<string, string> = {}
  try { query = Object.fromEntries(new URL(e.url).searchParams) } catch { /* 網址壞掉就沒有 query */ }
  const body = parseBody(e.req)
  const out: Record<string, unknown> = {}
  if (Object.keys(query).length) out.query = query
  if (body !== undefined) out.body = body
  return Object.keys(out).length ? out : undefined
}

export function buildSignature(input: { backend: BackendItem[]; front: FrontEvent[] }): Signature {
  const apis: Record<string, ApiSig> = {}
  const acc = new Map<string, { req: Map<string, { types: Set<string>; values: Set<string> }>; res: Map<string, { types: Set<string>; values: Set<string> }> }>()
  const add = (key: string, base: Omit<ApiSig, 'count' | 'request' | 'response'>, req: unknown, res: unknown) => {
    if (!apis[key]) { apis[key] = { ...base, count: 0, request: {}, response: {} }; acc.set(key, { req: new Map(), res: new Map() }) }
    apis[key].count++
    const a = acc.get(key)!
    for (const [part, v] of [['req', req], ['res', res]] as const) {
      if (v === undefined) continue
      for (const f of flatten(v)) {
        const m = a[part]
        if (!m.has(f.path)) m.set(f.path, { types: new Set(), values: new Set() })
        const e = m.get(f.path)!
        e.types.add(f.type)
        if (f.value !== null) e.values.add(f.value)
      }
    }
  }
  for (const b of input.backend) add(`backend:${b.event}`, { key: `backend:${b.event}`, label: b.event, source: 'backend', direction: 'OSM → CP' }, tryJson(b.postData), tryJson(b.result))
  for (const e of input.front) {
    if (e.kind === 'http' && httpComparable(e)) {
      const k = httpKey(e)
      add(k.key, { key: k.key, label: k.label, source: 'http', direction: 'H5 → Server' }, httpRequestParts(e), parseBody(e.res))
    } else if (e.kind === 'console') {
      const p = parsePinusConsole(e.text)
      if (!p) continue
      const key = `ws:${p.route}`
      const push = p.dir === 'on' && p.reqId === 0
      add(key, { key, label: p.route, source: 'ws', direction: push ? 'OSM → H5（推播）' : 'H5 ↔ OSM' }, p.dir === 'send' ? (p.params ?? {}) : undefined, p.dir === 'on' ? (p.params ?? {}) : undefined)
    }
  }
  for (const [key, a] of acc) {
    for (const [part, m] of [['request', a.req], ['response', a.res]] as const) {
      for (const [path, e] of m) {
        const vals = [...e.values].sort()
        apis[key][part][path] = { types: [...e.types].sort(), values: vals.slice(0, 8), truncated: vals.length > 8, volatile: isVolatile(path, vals) }
      }
    }
  }
  return { version: SIGNATURE_VERSION, apis }
}

// ─── 比對 ──────────────────────────────────────────────────────────────────────

export type DiffKind = 'added' | 'missing' | 'type' | 'value'
export interface DiffItem { part: 'request' | 'response'; path: string; kind: DiffKind; before: string; after: string; volatile: boolean }
export interface ApiDiff {
  key: string; label: string; source: ApiSig['source']; direction: string
  status: 'same' | 'changed' | 'new-api' | 'unobserved'
  items: DiffItem[]
}
export interface DiffResult {
  hasBaseline: boolean
  counts: { added: number; missing: number; type: number; value: number; volatileIgnored: number; newApi: number; unobserved: number }
  apis: ApiDiff[]
}

const showTypes = (p?: PathInfo) => (p ? p.types.join('|') : '')
const showValues = (p?: PathInfo) => (p ? (p.values.join(', ') + (p.truncated ? ' …' : '')) : '')

/**
 * 以「API＋方向＋request/response 巢狀路徑」比對。
 * - 型別變更與值變更分開算
 * - 時間戳／流水號（volatile）：ignoreVolatile 時只忽略「值」，存在與型別照樣檢查
 * - 基準有、這次沒錄到的 API ＝「未觀測」，不算刪除
 */
export function diffSignatures(cur: Signature, base: Signature | null, opts: { ignoreVolatile: boolean }): DiffResult {
  const counts = { added: 0, missing: 0, type: 0, value: 0, volatileIgnored: 0, newApi: 0, unobserved: 0 }
  if (!base) return { hasBaseline: false, counts, apis: [] }
  const apis: ApiDiff[] = []
  const keys = [...new Set([...Object.keys(cur.apis), ...Object.keys(base.apis)])].sort()
  for (const key of keys) {
    const c = cur.apis[key], b = base.apis[key]
    const meta = c ?? b
    const head = { key, label: meta.label, source: meta.source, direction: meta.direction }
    if (!b) { counts.newApi++; apis.push({ ...head, status: 'new-api', items: [] }); continue }
    if (!c) { counts.unobserved++; apis.push({ ...head, status: 'unobserved', items: [] }); continue }
    const items: DiffItem[] = []
    for (const part of ['request', 'response'] as const) {
      const cp = c[part], bp = b[part]
      for (const path of [...new Set([...Object.keys(cp), ...Object.keys(bp)])].sort()) {
        const x = cp[path], y = bp[path]
        const volatile = !!(x?.volatile || y?.volatile)
        if (x && !y) { items.push({ part, path, kind: 'added', before: '', after: showTypes(x), volatile }); counts.added++; continue }
        if (!x && y) { items.push({ part, path, kind: 'missing', before: showTypes(y), after: '', volatile }); counts.missing++; continue }
        if (showTypes(x) !== showTypes(y)) { items.push({ part, path, kind: 'type', before: showTypes(y), after: showTypes(x), volatile }); counts.type++; continue }
        // 物件／陣列本身沒有值；任一邊值太多（>8 種）就不比值
        if (!x!.values.length && !y!.values.length) continue
        if (x!.truncated || y!.truncated) continue
        if (showValues(x) === showValues(y)) continue
        if (volatile && opts.ignoreVolatile) { counts.volatileIgnored++; continue }
        items.push({ part, path, kind: 'value', before: showValues(y), after: showValues(x), volatile }); counts.value++
      }
    }
    apis.push({ ...head, status: items.length ? 'changed' : 'same', items })
  }
  const rank = { changed: 0, 'new-api': 1, unobserved: 2, same: 3 }
  apis.sort((a, z) => rank[a.status] - rank[z.status] || a.key.localeCompare(z.key))
  return { hasBaseline: true, counts, apis }
}

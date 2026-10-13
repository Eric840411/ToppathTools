/**
 * server/kb-relay.ts — 記憶共享 relay（規格：osm-qa-agent/docs/memory-sharing-spug-relay.md §A，v1.2）
 *
 * 同事的 AI ──POST /kb-mcp/mcp──▶ 這裡 ──WS──▶ 本機 relay-connector（GET /kb-mcp/connect 反向連進來）──▶ kb-mcp
 * 記憶不在 Spug：這支只轉接，不存、不快取、不判斷 token（token／ACL 全在本機 kb-mcp）。
 *
 * ⚠️ 不得記錄 body、Authorization、原始 URL（含 query）——log 只記時間、IP、status、bytes、耗時、固定路由名。
 *    所以這支 middleware 掛在 index.ts 最前面（cors／json parser／存取 log／dashboard metrics 之前），
 *    錯誤也不往 next(err) 丟（全站 error handler 會記 path）。
 *    反向代理（nginx）那層的 access log 要另外關，見 docs/features/31-kb-relay.md。
 *
 * 環境變數：KB_RELAY_SECRET（≥32 bytes；沒設 → 兩個端點都回 503，等於關閉）
 */
import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type express from 'express'
import { WebSocket, WebSocketServer } from 'ws'

const MCP_PATH = '/kb-mcp/mcp'
const CONNECT_PATH = '/kb-mcp/connect'
// 大小一律 UTF-8 bytes
const MAX_BODY = 64 * 1024              // 對外 POST body
const MAX_FRAME_OUT = 512 * 1024        // relay → connector
const MAX_FRAME_IN = 8 * 1024 * 1024    // connector → relay（ws maxPayload：接收層含分片累計就擋）
const MAX_INFLIGHT = 16
const RES_TIMEOUT_MS = 20_000
const PING_EVERY_MS = 25_000
const PONG_TIMEOUT_MS = 60_000
const RATE_PER_MIN = 60
const OFFLINE_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32010, message: 'memory service offline' }, id: null })
const rpcErr = (code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })

// 第一次用到才讀：ESM import 比 index.ts 的 dotenv.config() 早執行，載入當下讀會讀不到 .env
let secretHash: Buffer | null | undefined
function getSecretHash(): Buffer | null {
  if (secretHash !== undefined) return secretHash
  const secret = process.env.KB_RELAY_SECRET ?? ''
  secretHash = Buffer.byteLength(secret) >= 32 ? createHash('sha256').update(`Bearer ${secret}`).digest() : null
  if (!secretHash) console.log('[kb-relay] KB_RELAY_SECRET 未設或少於 32 bytes — relay 關閉（/kb-mcp/* 一律 503）')
  return secretHash
}
// 常數時間比對：兩邊先雜湊成等長再 timingSafeEqual，長度不同也不會提早結束
const authOk = (h: unknown, expect: Buffer) => typeof h === 'string' && timingSafeEqual(createHash('sha256').update(h).digest(), expect)

const relayLog = (o: Record<string, unknown>) => console.log(`[kb-relay] ${JSON.stringify({ t: new Date().toISOString(), ...o })}`)

// ─── connector 連線（同時只有一條）─────────────────────────────────────────────

type Pending = { conn: WebSocket; finish: (status: number, contentType: string, body: string) => void }
const pending = new Map<string, Pending>()
let conn: WebSocket | null = null

/** 這條連線上所有還沒回的請求一次結束（斷線、被取代、超限 frame） */
function failAll(of: WebSocket, status: number) {
  for (const [id, p] of pending) {
    if (p.conn !== of) continue
    pending.delete(id)
    p.finish(status, 'application/json', status === 503 ? OFFLINE_BODY : rpcErr(-32011, 'relay error'))
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_IN, clientTracking: false, perMessageDeflate: false })

function onConnector(ws: WebSocket, ip: string) {
  const old = conn
  conn = ws
  if (old) { failAll(old, 503); old.terminate(); relayLog({ ev: 'replaced' }) }
  relayLog({ ev: 'connected', ip })

  let lastPong = Date.now(), lastPing = Date.now()
  ws.on('pong', () => { lastPong = Date.now() })
  const beat = setInterval(() => {
    const now = Date.now()
    if (now - lastPong > PONG_TIMEOUT_MS) { relayLog({ ev: 'pong-timeout' }); ws.terminate(); return }
    if (now - lastPing >= PING_EVERY_MS) { lastPing = now; try { ws.ping() } catch { /* close 會處理 */ } }
  }, 5_000)
  beat.unref()

  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    let m: any
    try { m = JSON.parse(data.toString('utf8')) } catch { return }
    if (m?.type !== 'res' || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p || p.conn !== ws) return // id 不認得 → 丟掉
    pending.delete(m.id)
    const status = Number.isInteger(m.status) && m.status >= 200 && m.status <= 599 ? m.status : 502
    const ct = typeof m.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+(;[ \w=.+"-]*)?$/.test(m.contentType) && m.contentType.length <= 100 ? m.contentType : 'application/json'
    p.finish(status, ct, typeof m.body === 'string' ? m.body : '')
  })
  // 超限 frame（maxPayload）等接收錯誤：所有 pending 回 502 再斷線
  ws.on('error', (e) => { relayLog({ ev: 'ws-error', error: String((e as any)?.code || 'error').slice(0, 40) }); failAll(ws, 502); ws.terminate() })
  ws.on('close', (code) => {
    clearInterval(beat)
    failAll(ws, 503)
    if (conn === ws) conn = null
    relayLog({ ev: 'closed', code })
  })
}

function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

/** index.ts 的 server 'upgrade' 先問這支；回 true 表示是 /kb-mcp/* 已經處理掉，不要再交給別的 wss */
export function handleKbRelayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = req.url ?? ''
  if (!url.startsWith('/kb-mcp/') && !url.startsWith('/kb-mcp?') && url !== '/kb-mcp') return false
  // 跟 express 的 trust proxy 1 一樣：取 X-Forwarded-For 最右邊（最近一層代理加的）
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const ip = xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress ?? '?')
  socket.on('error', () => {})
  const t0 = Date.now()
  const qi = url.indexOf('?')
  const path = qi >= 0 ? url.slice(0, qi) : url
  const done = (status: number, text: string) => { relayLog({ route: 'connect', ip, status, ms: Date.now() - t0 }); rejectUpgrade(socket, status, text) }
  if (path !== CONNECT_PATH) { done(404, 'Not Found'); return true }
  if (qi >= 0) { done(400, 'Bad Request'); return true }
  const expect = getSecretHash()
  if (!expect) { done(503, 'Service Unavailable'); return true }
  if (!authOk(req.headers.authorization, expect)) { done(401, 'Unauthorized'); return true }
  wss.handleUpgrade(req, socket, head, (ws) => { relayLog({ route: 'connect', ip, status: 101, ms: Date.now() - t0 }); onConnector(ws, ip) })
  return true
}

export function closeKbRelay() { if (conn) conn.terminate() }

// ─── 對外 POST /kb-mcp/mcp ────────────────────────────────────────────────────

const hits = new Map<string, number[]>()
function rateOk(ip: string) {
  const now = Date.now()
  const arr = (hits.get(ip) ?? []).filter(t => now - t < 60_000)
  if (arr.length >= RATE_PER_MIN) { hits.set(ip, arr); return false }
  arr.push(now); hits.set(ip, arr)
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some(t => now - t < 60_000)) hits.delete(k)
  return true
}

function readBody(req: express.Request): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []; let size = 0, over = false
    req.on('data', (c: Buffer) => { if (over) return; size += c.length; if (size > MAX_BODY) { over = true; resolve(null) } else chunks.push(c) })
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)) })
    req.on('error', () => { if (!over) { over = true; resolve(null) } })
  })
}

/** 掛在 app 最前面；不是 /kb-mcp 開頭就 next() */
export async function kbRelayHttp(req: express.Request, res: express.Response, next: express.NextFunction) {
  const url = req.originalUrl ?? req.url
  if (!url.startsWith('/kb-mcp/') && !url.startsWith('/kb-mcp?') && url !== '/kb-mcp') return next()
  const t0 = Date.now()
  const ip = req.ip ?? req.socket.remoteAddress ?? '?'
  let bytes = 0
  const route = req.path === CONNECT_PATH ? 'connect' : req.path === MCP_PATH ? 'mcp' : 'other'
  const send = (status: number, body: string, contentType = 'application/json', extra: Record<string, string> = {}) => {
    if (res.headersSent) return
    // setHeader 不用 res.set：express 的 set 會自己在 Content-Type 後面加 charset，就不是原樣回了
    res.statusCode = status
    for (const [k, v] of Object.entries({ 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extra })) res.setHeader(k, v)
    res.end(body)
    relayLog({ route, ip, status, bytes, ms: Date.now() - t0 })
  }
  try {
    if (route !== 'mcp') {
      // /kb-mcp/connect 走 HTTP（沒有 upgrade）→ 426；其他（含 /kb-mcp/mcp/<x> 把 token 放 path）→ 404
      req.resume()
      return route === 'connect' ? send(426, rpcErr(-32600, 'upgrade required'), 'application/json', { Upgrade: 'websocket' }) : send(404, rpcErr(-32601, 'not found'))
    }
    if (url.includes('?')) { req.resume(); return send(400, rpcErr(-32600, 'query string not allowed')) }
    if (req.method !== 'POST') { req.resume(); return send(405, rpcErr(-32600, 'method not allowed'), 'application/json', { Allow: 'POST' }) }
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (ct !== 'application/json') { req.resume(); return send(415, rpcErr(-32600, 'content-type must be application/json')) }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { req.resume(); return send(413, rpcErr(-32600, 'body too large')) }
    if (!rateOk(ip)) { req.resume(); return send(429, rpcErr(-32002, 'rate limited'), 'application/json', { 'Retry-After': '60' }) }

    const buf = await readBody(req)
    if (!buf) { req.resume(); return send(413, rpcErr(-32600, 'body too large')) }
    bytes = buf.length
    if (!getSecretHash() || !conn || conn.readyState !== WebSocket.OPEN) return send(503, OFFLINE_BODY)
    if (pending.size >= MAX_INFLIGHT) return send(503, rpcErr(-32010, 'relay busy'))

    const auth = req.headers.authorization
    const id = randomUUID()
    const frame = JSON.stringify({ type: 'req', id, auth: typeof auth === 'string' ? auth : '', body: buf.toString('utf8') })
    if (Buffer.byteLength(frame) > MAX_FRAME_OUT) return send(413, rpcErr(-32600, 'request too large'))

    const ws = conn
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { if (pending.delete(id)) { send(504, rpcErr(-32011, 'memory service timeout')); resolve() } }, RES_TIMEOUT_MS)
      pending.set(id, { conn: ws, finish: (status, contentType, body) => { clearTimeout(timer); send(status, body, contentType); resolve() } })
      // 呼叫端先斷 → 名額立刻還回去
      res.on('close', () => { if (pending.delete(id)) { clearTimeout(timer); resolve() } })
      ws.send(frame, (e) => { if (e && pending.delete(id)) { clearTimeout(timer); send(503, OFFLINE_BODY); resolve() } })
    })
  } catch {
    send(502, rpcErr(-32011, 'relay error'))
  }
}

/** 測試用 */
export const _kbRelayState = () => ({ connected: !!conn, pending: pending.size })

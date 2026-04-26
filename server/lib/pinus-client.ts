/**
 * Minimal pinus WebSocket client for Node.js.
 * Connects to a pinus gate server, queries the connector,
 * then calls lobby.lobbyHandler.getAllGMListReq and extracts gmid counts.
 */
import WebSocket from 'ws'

// ─── Package layer ────────────────────────────────────────────────────────────

const PKG_HANDSHAKE     = 1
const PKG_HANDSHAKE_ACK = 2
const PKG_HEARTBEAT     = 3
const PKG_DATA          = 4

const MSG_REQUEST  = 0
const MSG_RESPONSE = 2

function pkgEncode(type: number, body?: Buffer): Buffer {
  const len = body ? body.length : 0
  const buf = Buffer.alloc(4 + len)
  buf[0] = type
  buf[1] = (len >> 16) & 0xff
  buf[2] = (len >> 8)  & 0xff
  buf[3] =  len        & 0xff
  if (body) body.copy(buf, 4)
  return buf
}

function msgEncode(reqId: number, route: string, body: object): Buffer {
  const flag  = (MSG_REQUEST << 1) | 0   // REQUEST, no route compress
  const idBytes: number[] = []
  let tmp = reqId
  do {
    let b = tmp & 0x7f
    tmp >>>= 7
    if (tmp > 0) b |= 0x80
    idBytes.push(b)
  } while (tmp > 0)

  const routeBuf = Buffer.from(route)
  const bodyBuf  = Buffer.from(JSON.stringify(body))
  const out = Buffer.alloc(1 + idBytes.length + 1 + routeBuf.length + bodyBuf.length)
  let off = 0
  out[off++] = flag
  for (const b of idBytes) out[off++] = b
  out[off++] = routeBuf.length
  routeBuf.copy(out, off); off += routeBuf.length
  bodyBuf.copy(out, off)
  return out
}

/** Parse all complete packages from buf, return leftover */
function pkgDecodeAll(buf: Buffer): { pkgs: Array<{ type: number; body: Buffer }>; rest: Buffer } {
  const pkgs: Array<{ type: number; body: Buffer }> = []
  let off = 0
  while (off + 4 <= buf.length) {
    const type = buf[off]
    const len  = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]
    if (off + 4 + len > buf.length) break
    pkgs.push({ type, body: buf.slice(off + 4, off + 4 + len) })
    off += 4 + len
  }
  return { pkgs, rest: buf.slice(off) }
}

/** Decode a DATA body that is a RESPONSE message → { id, data } */
function msgDecodeResponse(body: Buffer): { id: number; data: Buffer } | null {
  if (body.length < 1) return null
  const flag    = body[0]
  const msgType = (flag >> 1) & 0x7
  if (msgType !== MSG_RESPONSE) return null

  let off = 1, id = 0, shift = 0
  while (off < body.length) {
    const b = body[off++]
    id |= (b & 0x7f) << shift
    shift += 7
    if (!(b & 0x80)) break
  }
  return { id, data: body.slice(off) }
}

// ─── High-level helpers ───────────────────────────────────────────────────────

interface PinusResponse { id: number; data: Buffer }

/** Open a WebSocket, do pinus handshake, collect pending responses */
function openPinusWs(wsUrl: string, timeoutMs: number): Promise<{
  send: (id: number, route: string, body: object) => void
  waitResponse: (id: number) => Promise<Buffer>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false })
    let buf = Buffer.alloc(0)
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    const responseMap = new Map<number, (data: Buffer) => void>()
    let ready = false

    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`Connection timeout: ${wsUrl}`))
    }, timeoutMs)

    ws.on('open', () => {
      const hs = JSON.stringify({ sys: { version: '1.0.0', type: 'js-websocket' }, user: {} })
      ws.send(pkgEncode(PKG_HANDSHAKE, Buffer.from(hs)))
    })

    ws.on('message', (raw: Buffer) => {
      buf = Buffer.concat([buf, raw])
      const { pkgs, rest } = pkgDecodeAll(buf)
      buf = rest

      for (const pkg of pkgs) {
        if (pkg.type === PKG_HANDSHAKE) {
          try {
            const hs = JSON.parse(pkg.body.toString())
            if (hs.sys?.heartbeat) {
              heartbeatTimer = setInterval(
                () => ws.readyState === WebSocket.OPEN && ws.send(pkgEncode(PKG_HEARTBEAT)),
                hs.sys.heartbeat * 1000,
              )
            }
          } catch { /* ignore malformed hs */ }
          ws.send(pkgEncode(PKG_HANDSHAKE_ACK))
          if (!ready) {
            ready = true
            clearTimeout(timer)
            resolve({
              send: (id, route, body) => ws.send(pkgEncode(PKG_DATA, msgEncode(id, route, body))),
              waitResponse: (id) => new Promise((res, rej) => {
                responseMap.set(id, res)
                setTimeout(() => { responseMap.delete(id); rej(new Error(`Response ${id} timeout`)) }, timeoutMs)
              }),
              close: () => {
                if (heartbeatTimer) clearInterval(heartbeatTimer)
                ws.close()
              },
            })
          }
        } else if (pkg.type === PKG_DATA) {
          const resp = msgDecodeResponse(pkg.body)
          if (resp) {
            const cb = responseMap.get(resp.id)
            if (cb) { responseMap.delete(resp.id); cb(resp.data) }
          }
        } else if (pkg.type === PKG_HEARTBEAT) {
          ws.readyState === WebSocket.OPEN && ws.send(pkgEncode(PKG_HEARTBEAT))
        }
      }
    })

    ws.on('error', (e) => { clearTimeout(timer); if (!ready) reject(e) })
    ws.on('close', () => {
      clearTimeout(timer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (!ready) reject(new Error(`WebSocket closed before ready: ${wsUrl}`))
    })
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FetchAllGMParams {
  /** Gate WebSocket URL, e.g. wss://gate.osmplay-new.com */
  gateUrl: string
  /** Optional connector WebSocket URL, e.g. wss://conn.osmplay-new.com */
  connectorUrl?: string
  /** Full token string, e.g. 898b64eb...-111717607 */
  token: string
}

function buildGateCandidates(rawGateUrl: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(rawGateUrl)
  } catch {
    return [rawGateUrl]
  }

  const basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
  const pathCandidates = basePath ? [basePath] : ['', '/ws', '/websocket']
  const schemeCandidates = parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
    ? [parsed.protocol, parsed.protocol === 'wss:' ? 'ws:' : 'wss:']
    : ['wss:', 'ws:']

  const out: string[] = []
  for (const proto of schemeCandidates) {
    for (const p of pathCandidates) {
      const u = new URL(parsed.toString())
      u.protocol = proto
      u.pathname = p || '/'
      out.push(u.toString().replace(/\/$/, p ? '' : ''))
    }
  }

  // If serverCfg reports a "conn.*" host as the gate, it may be pointing directly at the
  // connector. The real nginx-proxied gate (which rewrites connector addresses) lives at
  // "gate.{baseDomain}" — add it as an additional candidate so we get the proper host rewrite.
  if (/^conn\d*\./.test(parsed.hostname) || parsed.hostname.startsWith('conn.')) {
    const baseDomain = parsed.hostname.replace(/^[^.]+\./, '')
    const scheme = parsed.protocol === 'ws:' ? 'ws' : 'wss'
    out.push(`${scheme}://gate.${baseDomain}`)
  }

  return [...new Set(out)]
}

function toGameCode(raw: string): string {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  const parts = v.split('-')
  if (parts.length >= 2) return parts[1].toLowerCase()
  return v.toLowerCase()
}

function extractCountsFromPayload(input: unknown): Record<string, number> {
  const counts: Record<string, number> = {}
  if (!input || typeof input !== 'object') return counts

  const root = input as Record<string, unknown>
  const gamelist = Array.isArray(root.gamelist) ? root.gamelist : []
  for (const game of gamelist) {
    if (!game || typeof game !== 'object') continue
    const gameObj = game as Record<string, unknown>
    const groups = Array.isArray(gameObj.list) ? gameObj.list : []
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const groupObj = group as Record<string, unknown>
      const gmInfoList = Array.isArray(groupObj.gminfolist) ? groupObj.gminfolist : []
      for (const info of gmInfoList) {
        if (!info || typeof info !== 'object') continue
        const gmid = String((info as Record<string, unknown>).gmid ?? '').trim()
        const code = toGameCode(gmid)
        if (!code) continue
        counts[code] = (counts[code] ?? 0) + 1
      }
    }
  }
  return counts
}

function collectCodesFromObject(input: unknown, out: string[]): void {
  if (!input) return
  if (Array.isArray(input)) {
    for (const item of input) collectCodesFromObject(item, out)
    return
  }
  if (typeof input !== 'object') return

  const obj = input as Record<string, unknown>
  const candidateKeys = ['gmid', 'gameId', 'gameid', 'gameCode', 'gamecode', 'gmid']
  for (const key of candidateKeys) {
    const val = obj[key]
    if (typeof val === 'string' && val.trim()) out.push(val.trim())
  }
  for (const val of Object.values(obj)) collectCodesFromObject(val, out)
}

async function runConnectorFlow(connUrl: string, token: string, timeoutMs: number): Promise<Record<string, number>> {
  const uidStr = token.split('-').pop() ?? '0'
  const conn = await openPinusWs(connUrl, timeoutMs)
  conn.send(1, 'connector.entryHandler.enter', { uid: uidStr, token })
  const enterRaw = await conn.waitResponse(1)
  let enterResult: { code?: number }
  try { enterResult = JSON.parse(enterRaw.toString()) } catch {
    throw new Error(`Enter response is not JSON: ${enterRaw.slice(0, 80).toString()}`)
  }
  // code 200 or 0 or undefined = success; anything else is an error
  if (enterResult.code !== undefined && enterResult.code !== 200 && enterResult.code !== 0) {
    throw new Error(`Enter error code=${enterResult.code}`)
  }

  conn.send(2, 'lobby.lobbyHandler.getAllGMListReq', {})
  const gmRaw = await conn.waitResponse(2)
  conn.close()

  let parsedJson: unknown = null
  try {
    parsedJson = JSON.parse(gmRaw.toString('utf8')) as unknown
  } catch {
    // non-JSON payload, fallback below
  }

  // 1) Preferred: structured parse for getAllGMListReq
  const structuredCounts = extractCountsFromPayload(parsedJson)
  if (Object.keys(structuredCounts).length > 0) return structuredCounts

  // 2) Fallback: scan payload for gmid-like strings.
  const text = gmRaw.toString('latin1')
  const candidates = new Set<string>()

  // Common gmid format: 0001-jjbx-111717607 (lowercase code + variable uid length)
  for (const m of text.match(/\d{3,6}-[a-z0-9_]+-\d{3,12}/gi) ?? []) candidates.add(m)
  // JSON-like payloads: "gmid":"0001-jjbx-111717607"
  for (const m of text.matchAll(/"gmid"\s*:\s*"([^"]+)"/gi)) {
    if (m[1]) candidates.add(m[1])
  }

  // 3) Fallback: parse generic JSON fields and extract known game-id fields.
  if (candidates.size === 0) {
    try {
      const json = parsedJson ?? JSON.parse(gmRaw.toString('utf8'))
      const jsonCodes: string[] = []
      collectCodesFromObject(json, jsonCodes)
      for (const c of jsonCodes) candidates.add(c)
    } catch {
      // ignore non-JSON payload
    }
  }

  const counts: Record<string, number> = {}
  for (const gmid of candidates) {
    const gameCode = toGameCode(gmid)
    if (!gameCode) continue
    counts[gameCode] = (counts[gameCode] ?? 0) + 1
  }

  if (Object.keys(counts).length === 0) {
    const preview = gmRaw.toString('utf8').replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(`連線成功但未解析到任何機台資料（payload=${gmRaw.length} bytes, preview="${preview}"）`)
  }
  return counts
}

async function fetchAllGMListOnce(
  gateUrl: string,
  token: string,
  preferredConnectorHost?: string,
): Promise<Record<string, number>> {
  // uid is the part after the last '-'; send as string (some gate versions reject numeric)
  const uidStr = token.split('-').pop() ?? '0'
  const uidNum = parseInt(uidStr, 10)
  void uidNum

  const timeoutMs = Number(process.env.OSM_FRONTEND_GATE_TIMEOUT_MS ?? 12000)

  // ── Step 1: gate query ───────────────────────────────────────────────────
  const gate = await openPinusWs(gateUrl, timeoutMs)
  // Try string uid first; if gate rejects (errcode), caller can retry with numeric
  gate.send(1, 'gate.gateHandler.queryEntry', { uid: uidStr, token })
  const gateRaw = await gate.waitResponse(1)
  gate.close()

  let gateResult: { code?: number; host?: string; port?: number }
  try { gateResult = JSON.parse(gateRaw.toString()) } catch {
    throw new Error(`Gate response is not JSON: ${gateRaw.slice(0, 80).toString()}`)
  }
  // Some pinus versions return { host, port } without a code field; treat host presence as success
  if (!gateResult.host) {
    throw new Error(`Gate error: no host in response (code=${gateResult.code}, raw=${gateRaw.slice(0, 80).toString()})`)
  }

  const gateHostname = new URL(gateUrl).hostname
  const rawConnHost  = gateResult.host ?? ''
  const scheme       = gateUrl.startsWith('wss') ? 'wss' : 'ws'
  const isInternal   = rawConnHost === '127.0.0.1' || rawConnHost === 'localhost' || rawConnHost === ''

  // ── Build connector candidate list ───────────────────────────────────────
  const connCandidates: string[] = []

  if (!isInternal) {
    // Gate returned a real host — use it as-is
    const p = gateResult.port ?? 0
    connCandidates.push(p ? `${scheme}://${rawConnHost}:${p}` : `${scheme}://${rawConnHost}`)
  } else {
    // Gate returned an internal IP — the real connector is on a separate subdomain.
    // Pattern observed: gate.XXX.com → conn1.XXX.com, conn2.XXX.com, ... conn5.XXX.com on port 443
    const baseDomain = gateHostname.replace(/^[^.]+\./, '') // strip first label, e.g. gate.osmplay-new.com → osmplay-new.com
    if (preferredConnectorHost) {
      connCandidates.push(`${scheme}://${preferredConnectorHost}`)
    }
    // Try numbered subdomains first (conn1–conn5), then bare conn, then gate hostname as last resort
    for (let i = 1; i <= 5; i++) connCandidates.push(`${scheme}://conn${i}.${baseDomain}`)
    connCandidates.push(`${scheme}://conn.${baseDomain}`)
    connCandidates.push(`${scheme}://${gateHostname}`) // same host as gate but on WSS port 443
  }

  // ── Step 2: try connector candidates in order ─────────────────────────────
  const connErrors: string[] = []
  for (const connUrl of connCandidates) {
    try {
      return await runConnectorFlow(connUrl, token, Math.min(timeoutMs, 8000))
    } catch (e) {
      connErrors.push(`${connUrl} → ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`前端直連失敗，已嘗試 ${connCandidates.length} 個 connector。${connErrors.slice(0, 3).join(' | ')}`)
}

/**
 * Connect to OSM gate → connector → getAllGMListReq.
 * Returns game-type counts, e.g. { jjbx: 155, wlzblink: 131, ... }
 */
export async function fetchAllGMList(params: FetchAllGMParams): Promise<Record<string, number>> {
  const { gateUrl, connectorUrl, token } = params
  const candidates = buildGateCandidates(gateUrl)
  const preferredConnectorHost = connectorUrl ? new URL(connectorUrl).hostname : undefined
  const errors: string[] = []

  for (const candidate of candidates) {
    try {
      return await fetchAllGMListOnce(candidate, token, preferredConnectorHost)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${candidate} -> ${msg}`)
    }
  }

  // Gate may be blocked by env/network policy; try direct connector as a fallback.
  if (connectorUrl) {
    const connCandidates = buildGateCandidates(connectorUrl)
    const timeoutMs = Number(process.env.OSM_FRONTEND_GATE_TIMEOUT_MS ?? 12000)
    for (const candidate of connCandidates) {
      try {
        return await runConnectorFlow(candidate, token, timeoutMs)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`direct-conn ${candidate} -> ${msg}`)
      }
    }
  }

  const topErrors = errors.slice(0, 4).join(' | ')
  throw new Error(
    `Gate 連線失敗，已嘗試 ${candidates.length} 組端點。` +
    ` 原始 gate=${gateUrl}${connectorUrl ? `，connector=${connectorUrl}` : ''}。` +
    ` 錯誤摘要：${topErrors || 'unknown error'}`
  )
}

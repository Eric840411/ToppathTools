// 記憶共享 relay 測試（server/kb-relay.ts，規格 osm-qa-agent/docs/memory-sharing-spug-relay.md §A）
// 用法：npm run build:server && node scripts/kb-relay/relay.test.mjs
//   接線照 index.ts（kbRelayHttp 掛最前面、upgrade 先問 handleKbRelayUpgrade），
//   後半段跑 osm-qa-agent 真的 relay-connector.cjs，本機 kb-mcp 用假的（不碰正式記憶與 tokens.json）。
//   心跳那條要等 60 秒以上；SKIP_SLOW=1 跳過。
import https from 'https'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OSM = process.env.OSM_QA_AGENT_DIR || path.join(ROOT, '..', 'osm-qa-agent')
const CERT = path.join(OSM, 'kb-mcp', 'certs', 'kb-mcp.crt'), KEY = path.join(OSM, 'kb-mcp', 'certs', 'kb-mcp.key')
const CONNECTOR = path.join(OSM, 'kb-mcp', 'relay-connector.cjs')
const SECRET = crypto.randomBytes(32).toString('base64url')
process.env.KB_RELAY_SECRET = SECRET // kb-relay 第一次用到才讀

// 抓 relay 的 log：之後檢查有沒有漏 token／body／query
const logs = []
const origLog = console.log
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[kb-relay]')) logs.push(s); else origLog(...a) }

const { kbRelayHttp, handleKbRelayUpgrade, _kbRelayState } = await import(pathToFileURL(path.join(ROOT, 'dist-server', 'server', 'kb-relay.js')).href)

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; origLog(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' — ' + extra : ''}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50) } return false }

const CA = fs.readFileSync(CERT)
const tls = { cert: CA, key: fs.readFileSync(KEY) }

// ---- relay（接線跟 index.ts 一樣）----
const app = express()
app.set('trust proxy', 1)
app.use(kbRelayHttp)
app.use(express.json())
app.use((req, res) => res.status(299).end('fallthrough'))
const srv = https.createServer(tls, app)
const otherWss = new WebSocketServer({ noServer: true })
otherWss.on('connection', ws => ws.send('other-ok'))
srv.on('upgrade', (req, socket, head) => {
  if (handleKbRelayUpgrade(req, socket, head)) return
  otherWss.handleUpgrade(req, socket, head, ws => otherWss.emit('connection', ws, req))
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const PORT = srv.address().port
const BASE = `https://localhost:${PORT}`

function post(p, { body = '{"jsonrpc":"2.0","id":1,"method":"ping"}', headers = {}, method = 'POST', chunked = false } = {}) {
  return new Promise((resolve) => {
    const buf = Buffer.from(body)
    const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.1', ...headers }
    if (!chunked && method === 'POST') h['Content-Length'] = buf.length
    const t0 = Date.now()
    const req = https.request(BASE + p, { method, headers: h, ca: CA }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d, ms: Date.now() - t0 }))
    })
    req.on('error', (e) => resolve({ status: 0, error: e.code }))
    if (method === 'POST') { if (chunked) { for (let i = 0; i < buf.length; i += 8192) req.write(buf.subarray(i, i + 8192)) } req.end(chunked ? undefined : buf) } else req.end()
  })
}
function upgrade(p, auth, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://localhost:${PORT}${p}`, { ca: CA, ...opts, headers: auth === undefined ? {} : { Authorization: auth } })
    ws.on('open', () => resolve({ ok: true, ws }))
    ws.on('unexpected-response', (_q, res) => { resolve({ ok: false, status: res.statusCode }); ws.terminate() })
    ws.on('error', () => resolve({ ok: false, status: -1 }))
  })
}
// 假 connector：手動回應
async function fakeConnector(onReq, opts) {
  const r = await upgrade('/kb-mcp/connect', `Bearer ${SECRET}`, opts)
  if (!r.ok) throw new Error('fake connector 連不上 ' + r.status)
  r.ws.frames = []
  r.ws.on('message', (d) => { const m = JSON.parse(d.toString()); r.ws.frames.push(m); onReq?.(m, r.ws) })
  await waitFor(() => _kbRelayState().connected)
  return r.ws
}
const reply = (ws, m, extra = {}) => ws.send(JSON.stringify({ type: 'res', id: m.id, status: 200, contentType: 'application/json', body: '{"ok":1}', ...extra }))

try {
  // ---- 對外端點的門口檢查（不需要 connector）----
  let r = await post('/kb-mcp/mcp')
  check('沒有 connector → 503 offline', r.status === 503 && JSON.parse(r.body).error?.code === -32010 && /memory service offline/.test(r.body), r.status)
  check('回應帶 Cache-Control: no-store', r.headers['cache-control'] === 'no-store')
  check('沒有 CORS header（沒經過 cors）', !r.headers['access-control-allow-origin'])
  r = await post('/kb-mcp/mcp?token=QUERYMARKER123')
  check('query string → 400', r.status === 400, r.status)
  r = await post('/kb-mcp/mcp/PATHMARKER456')
  check('token 放在 path → 404', r.status === 404, r.status)
  r = await post('/kb-mcp/whatever')
  check('其他 /kb-mcp 路徑 → 404', r.status === 404, r.status)
  r = await post('/kb-mcp/mcp', { method: 'GET' })
  check('GET → 405', r.status === 405 && r.headers.allow === 'POST', r.status)
  r = await post('/kb-mcp/mcp', { headers: { 'Content-Type': 'text/plain' } })
  check('非 JSON → 415', r.status === 415, r.status)
  r = await post('/kb-mcp/mcp', { headers: { 'Content-Type': 'application/json; charset=utf-8' } })
  check('application/json; charset=utf-8 可以（→ 503 offline）', r.status === 503, r.status)
  r = await post('/kb-mcp/mcp', { body: 'x'.repeat(64 * 1024 + 1) })
  check('body 64KB+1（Content-Length）→ 413', r.status === 413, r.status)
  r = await post('/kb-mcp/mcp', { body: 'x'.repeat(70 * 1024), chunked: true })
  check('body 超過 64KB（chunked，沒有 Content-Length）→ 413', r.status === 413, r.status)
  r = await post('/kb-mcp/connect', { method: 'GET' })
  check('/kb-mcp/connect 不是 upgrade → 426', r.status === 426, r.status)
  r = await post('/api/health', { method: 'GET' })
  check('其他路徑照常往下走', r.status === 299)

  // ---- connect 驗證 ----
  check('connect 錯 secret → 401', (await upgrade('/kb-mcp/connect', 'Bearer ' + crypto.randomBytes(32).toString('base64url'))).status === 401)
  check('connect 沒帶 Authorization → 401', (await upgrade('/kb-mcp/connect')).status === 401)
  check('connect 少了 Bearer 前綴 → 401', (await upgrade('/kb-mcp/connect', SECRET)).status === 401)
  check('connect 帶 query → 400', (await upgrade(`/kb-mcp/connect?x=1`, `Bearer ${SECRET}`)).status === 400)
  check('/kb-mcp/其他 upgrade → 404', (await upgrade('/kb-mcp/mcp', `Bearer ${SECRET}`)).status === 404)
  check('沒有連上任何 connector', !_kbRelayState().connected)
  const other = await upgrade('/ws/agent')
  const otherMsg = other.ok ? await new Promise(res => other.ws.once('message', d => res(d.toString()))) : ''
  check('其他 WS 路徑照舊交給原本的 wss', otherMsg === 'other-ok'); other.ws?.close()

  // ---- 轉送 ----
  let c1 = await fakeConnector((m, ws) => reply(ws, m, { status: 207, contentType: 'text/event-stream', body: 'event: message\ndata: {"r":' + JSON.parse(m.body).id + '}\n\n' }))
  r = await post('/kb-mcp/mcp', { body: '{"jsonrpc":"2.0","id":7,"method":"ping","x":"中文"}', headers: { Authorization: 'Bearer TOKENMARKER_abcdefghijklmnop', Cookie: 'sid=COOKIEMARKER', 'X-Other': 'OTHERMARKER', Accept: 'text/html' } })
  const f = c1.frames.at(-1)
  check('回應 status／contentType／body 原樣回', r.status === 207 && r.headers['content-type'] === 'text/event-stream' && r.body.includes('"r":7'), `${r.status} ${r.headers['content-type']}`)
  check('回應帶 no-store', r.headers['cache-control'] === 'no-store')
  check('frame 只有 type/id/auth/body', JSON.stringify(Object.keys(f).sort()) === '["auth","body","id","type"]', Object.keys(f).join(','))
  check('auth 原樣、其他 header 都沒轉', f.auth === 'Bearer TOKENMARKER_abcdefghijklmnop' && !JSON.stringify(f).includes('COOKIEMARKER') && !JSON.stringify(f).includes('OTHERMARKER'))
  check('body 是原始字串（UTF-8 沒壞）', f.body === '{"jsonrpc":"2.0","id":7,"method":"ping","x":"中文"}')
  check('id 是 uuid', /^[0-9a-f-]{36}$/.test(f.id))
  r = await post('/kb-mcp/mcp')
  check('沒帶 Authorization → auth 是空字串（交給 connector 擋）', c1.frames.at(-1).auth === '')
  r = await post('/kb-mcp/mcp', { body: '"' + '\\u0000'.repeat(10000) + '"' })
  check('跳脫膨脹的 body 照樣轉（frame < 512KB）', r.status === 207, r.status)

  // 不認得的 id 丟掉、status 不合法 → 502
  c1.removeAllListeners('message'); c1.frames = []
  c1.on('message', (d) => { const m = JSON.parse(d.toString()); c1.send(JSON.stringify({ type: 'res', id: 'nope', status: 200, body: 'WRONG' })); c1.send(JSON.stringify({ type: 'res', id: m.id, status: 99, body: 'x' })) })
  r = await post('/kb-mcp/mcp')
  check('不認得的 id 丟掉；status 不合法 → 502', r.status === 502 && !r.body.includes('WRONG'), r.status)

  // 16 個在途，第 17 個 503
  c1.removeAllListeners('message'); const held = []
  c1.on('message', (d) => held.push(JSON.parse(d.toString())))
  const burst = Array.from({ length: 16 }, () => post('/kb-mcp/mcp', { headers: { 'X-Forwarded-For': '10.0.1.1' } }))
  await waitFor(() => held.length === 16)
  r = await post('/kb-mcp/mcp')
  check('在途 16 個時第 17 個 → 503 busy', r.status === 503 && /busy/.test(r.body), `${r.status} pending=${_kbRelayState().pending}`)
  // 斷線 → 所有 pending 立刻 503
  const tClose = Date.now(); c1.terminate()
  const bs = await Promise.all(burst)
  check('connector 斷線 → 16 個 pending 立刻 503', bs.every(x => x.status === 503) && Date.now() - tClose < 2000, bs.map(x => x.status).join(','))
  check('pending 清空', await waitFor(() => _kbRelayState().pending === 0 && !_kbRelayState().connected))

  // 新連線取代舊連線，舊的 pending 503
  c1 = await fakeConnector(() => {})
  const p1 = post('/kb-mcp/mcp')
  await waitFor(() => c1.frames.length === 1)
  const c1Closed = new Promise(res => c1.once('close', () => res(true)))
  const c2 = await fakeConnector((m, ws) => reply(ws, m))
  r = await p1
  check('被新連線取代 → 舊連線的 pending 503', r.status === 503, r.status)
  check('舊連線被關掉', await Promise.race([c1Closed, sleep(2000).then(() => false)]))
  r = await post('/kb-mcp/mcp')
  check('新連線可用', r.status === 200, r.status)

  // 超過 8MB 的 frame → 斷線＋pending 502
  c2.removeAllListeners('message'); c2.frames = []; c2.on('message', d => c2.frames.push(JSON.parse(d.toString())))
  const p2 = post('/kb-mcp/mcp'), p3 = post('/kb-mcp/mcp')
  await waitFor(() => c2.frames.length === 2)
  c2.send(JSON.stringify({ type: 'res', id: 'x', body: 'y'.repeat(8 * 1024 * 1024) }))
  const [r2, r3] = await Promise.all([p2, p3])
  check('connector 送超過 8MB → 所有 pending 502', r2.status === 502 && r3.status === 502, `${r2.status},${r3.status}`)
  check('超限後斷線', await waitFor(() => !_kbRelayState().connected))

  // 20 秒逾時 → 504，晚到的回應丟掉
  const c3 = await fakeConnector(() => {})
  r = await post('/kb-mcp/mcp')
  check('20 秒沒回 → 504', r.status === 504 && r.ms >= 19_500 && r.ms < 22_000, `${r.status} ${r.ms}ms`)
  reply(c3, c3.frames[0]); await sleep(200)
  c3.on('message', d => reply(c3, JSON.parse(d.toString())))
  check('晚到的回應丟掉、pending 已釋放', _kbRelayState().pending === 0 && _kbRelayState().connected)

  // 每 IP 60/min
  const rl = []
  for (let i = 0; i < 61; i++) rl.push((await post('/kb-mcp/mcp', { headers: { 'X-Forwarded-For': '10.9.9.9' } })).status)
  r = await post('/kb-mcp/mcp', { headers: { 'X-Forwarded-For': '10.9.9.8' } })
  check('同一 IP 第 61 個 → 429，其他 IP 不受影響', rl.slice(0, 60).every(s => s === 200) && rl[60] === 429 && r.status !== 429, `第61=${rl[60]} 其他IP=${r.status}`)
  c3.terminate(); await waitFor(() => !_kbRelayState().connected)

  // 心跳：25 秒內收到 ping；不回 pong → 60 秒內被斷
  if (!process.env.SKIP_SLOW) {
    const c4 = await fakeConnector(() => {}, { autoPong: false }) // ws 8.13+：不自動回 pong
    let pinged = 0; c4.on('ping', () => pinged++)
    check('25 秒內收到 ping', await waitFor(() => pinged > 0, 31_000))
    const t0 = Date.now() - 25_000 // 連上到第一次 ping 約 25 秒
    const dropped = await waitFor(() => !_kbRelayState().connected, 75_000)
    check('不回 pong → 60～70 秒內被斷', dropped && Date.now() - t0 < 72_000, `${Date.now() - t0}ms`)
    c4.terminate()
  }

  // ---- 端對端：真的 relay-connector.cjs ----
  const fakeKb = []
  const kb = https.createServer(tls, (req, res) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => {
      fakeKb.push({ headers: req.headers, body: d })
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(d).id, result: { echo: 'KB_OK' } }))
    })
  })
  await new Promise(r => kb.listen(0, '127.0.0.1', r))
  const kill = path.join(os.tmpdir(), `kb-relay-test-${process.pid}.disabled`)
  const child = spawn(process.execPath, [CONNECTOR], {
    cwd: OSM, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KB_RELAY_URL: `wss://localhost:${PORT}/kb-mcp/connect`, KB_RELAY_SECRET: SECRET, NODE_EXTRA_CA_CERTS: CERT, KB_MCP_TLS_CERT: CERT, KB_LOCAL_URL: `https://127.0.0.1:${kb.address().port}/mcp`, KB_RELAY_KILL_FILE: kill },
  })
  let cout = ''; child.stdout.on('data', d => cout += d); child.stderr.on('data', d => cout += d)
  try {
    check('E2E：真 connector 連上 relay', await waitFor(() => _kbRelayState().connected, 10_000), cout.slice(0, 200))
    const tok = 'Bearer E2ETOKEN_' + crypto.randomBytes(12).toString('hex')
    r = await post('/kb-mcp/mcp', { body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'BODYMARKER' } } }), headers: { Authorization: tok, Cookie: 'sid=COOKIEMARKER', 'X-Forwarded-For': '10.0.2.1' } })
    check('E2E：請求經 relay＋connector 到 kb-mcp 再回來', r.status === 200 && /KB_OK/.test(r.body) && /"id":42/.test(r.body), `${r.status} ${r.body.slice(0, 80)}`)
    const kh = fakeKb.at(-1)?.headers ?? {}
    check('E2E：kb-mcp 收到的 Authorization 原樣、沒有 Cookie', kh.authorization === tok && !kh.cookie, Object.keys(kh).join(','))
    r = await post('/kb-mcp/mcp', { body: JSON.stringify({ jsonrpc: '2.0', id: 43, method: 'resources/list' }), headers: { Authorization: tok, 'X-Forwarded-For': '10.0.2.1' } })
    check('E2E：connector 白名單擋下的狀態碼原樣回（403）', r.status === 403, r.status)
    fs.writeFileSync(kill, '')
    check('E2E：connector 斷線開關 → relay 看到斷線', await waitFor(() => !_kbRelayState().connected, 8000))
    r = await post('/kb-mcp/mcp', { headers: { Authorization: tok, 'X-Forwarded-For': '10.0.2.1' } })
    check('E2E：斷線後 → 503 offline', r.status === 503 && /offline/.test(r.body), r.status)
    fs.unlinkSync(kill)
    check('E2E：拿掉開關 → 重連', await waitFor(() => _kbRelayState().connected, 12_000))
    check('E2E：connector log 不含 token', !cout.includes('E2ETOKEN') && !cout.includes(SECRET))
  } finally { child.kill(); try { fs.unlinkSync(kill) } catch {} ; kb.close() }

  // ---- log 不得含 token／secret／body／query／path 參數 ----
  const all = logs.join('\n')
  const leaks = ['TOKENMARKER', 'E2ETOKEN', SECRET, 'BODYMARKER', 'QUERYMARKER', 'PATHMARKER', 'COOKIEMARKER', 'OTHERMARKER', '中文'].filter(m => all.includes(m))
  check('relay log 不含 token／secret／body／query／path', leaks.length === 0 && logs.length > 20, leaks.join(',') || `${logs.length} 行`)
  const keys = new Set(logs.flatMap(l => Object.keys(JSON.parse(l.replace(/^\[kb-relay\] /, '')))))
  check('relay log 只有允許的欄位', [...keys].every(k => ['t', 'route', 'ip', 'status', 'bytes', 'ms', 'ev', 'code', 'error'].includes(k)), [...keys].join(','))
} catch (e) { fail++; origLog('FAIL 例外 ' + e.stack) }
finally {
  origLog(`\n${pass} pass / ${fail} fail`)
  srv.closeAllConnections?.(); srv.close()
  process.exit(fail ? 1 : 0)
}

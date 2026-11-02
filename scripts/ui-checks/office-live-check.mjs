/**
 * 文書工具（v5.68.0）真 server 冒煙：/office/* 與 /api/office/apps 的登入、權限、檔案送出、標頭。
 * 跑法：先用 DB 副本把 build 後的 server 起在別的 port（見 docs/features/34-office.md「驗證」），再
 *   node scripts/ui-checks/office-live-check.mjs <base url> <DB 副本路徑>
 * 版本裡至少要有 word（嵌 iframe 的）與 film（需要獨立分頁的）。
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import http from 'http'
import { devSidHash } from './lib/dev-session.mjs'

const [H, dbPath] = process.argv.slice(2)
if (!H || !dbPath) { console.error('用法：node scripts/ui-checks/office-live-check.mjs <base url> <DB 副本>'); process.exit(2) }
const db = new Database(dbPath)

function session(email) {
  const sid = randomBytes(24).toString('hex'); const now = Date.now()
  db.prepare('INSERT INTO auth_sessions (sid, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(devSidHash(sid), email, now, now + 3600_000)
  return { Cookie: `toppath_auth=${sid}` }
}
const admin = db.prepare("SELECT email FROM jira_accounts WHERE role = 'admin' LIMIT 1").get()?.email
// 沒有 office 權限的一般帳號：找一個非管理員、角色沒開 office、也沒有個人覆寫的
const plain = db.prepare(`SELECT a.email FROM jira_accounts a WHERE a.role != 'admin' AND a.role != ''
  AND NOT EXISTS (SELECT 1 FROM role_permissions p WHERE p.role = a.role AND p.page_key = 'office' AND p.allowed = 1)
  AND NOT EXISTS (SELECT 1 FROM account_permissions o WHERE o.email = a.email AND o.perm_key = 'office') LIMIT 1`).get()?.email
if (!admin || !plain) { console.error('DB 副本裡找不到管理員或一般帳號'); process.exit(2) }
const A = session(admin), P = session(plain)

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const get = (path, headers = {}, method = 'GET') => fetch(H + path, { method, headers, redirect: 'manual' })
const DOC = { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' }
const SUB = { 'Sec-Fetch-Dest': 'script', Accept: '*/*' }

console.log('== 未登入')
let r = await get('/office/word/', DOC)
check('開頁面 → 302 導回首頁（不是 SPA 的 index.html）', r.status === 302 && r.headers.get('location') === '/', `${r.status} ${r.headers.get('location')}`)
r = await get('/office/word/index.html', SUB)
check('子資源 → 401 JSON', r.status === 401 && (await r.json().catch(() => ({}))).code === 'UNAUTHENTICATED')
r = await get('/api/office/apps')
check('/api/office/apps → 401', r.status === 401)
r = await get('/OFFICE/WORD/', DOC)
check('大寫網址也擋', r.status === 302, String(r.status))

console.log('== 登入但沒有 office 權限')
r = await get('/office/word/', { ...P, ...DOC })
check('開頁面 → 403', r.status === 403, String(r.status))
r = await get('/office/word/index.html', { ...P, ...SUB })
check('子資源 → 403 JSON', r.status === 403 && (await r.json().catch(() => ({}))).code === 'FORBIDDEN')
r = await get('/api/office/apps', P)
check('/api/office/apps → 403', r.status === 403, String(r.status))

console.log('== 管理員')
r = await get('/api/office/apps', A)
let j = await r.json().catch(() => ({}))
check('/api/office/apps 只列有部署的', j.ok && j.deployed && j.apps.map(a => a.id).join(',') === 'word,film', JSON.stringify(j.apps?.map(a => a.id)))
check('film 標成需要獨立分頁', j.apps?.find(a => a.id === 'film')?.isolate === true)
r = await get('/office/word', { ...A, ...DOC })
check('少結尾斜線 → 301 /office/word/', r.status === 301 && r.headers.get('location') === '/office/word/', `${r.status} ${r.headers.get('location')}`)
r = await get('/office/word/', { ...A, ...DOC })
let body = await r.text()
check('index.html 200', r.status === 200 && body.includes('wordcraft'), String(r.status))
check('Content-Type html', (r.headers.get('content-type') ?? '').startsWith('text/html'))
check('COOP／COEP 標頭', r.headers.get('cross-origin-opener-policy') === 'same-origin' && r.headers.get('cross-origin-embedder-policy') === 'require-corp')
check('Cache-Control private', (r.headers.get('cache-control') ?? '').startsWith('private'), r.headers.get('cache-control'))
const wasm = body.match(/href="\.\/([^"]+\.wasm)"/)?.[1]
r = await get(`/office/word/${wasm}`, { ...A, 'Accept-Encoding': 'gzip' }, 'HEAD')
check('WASM 送預先壓好的 gzip', r.status === 200 && r.headers.get('content-encoding') === 'gzip', `${r.status} ${r.headers.get('content-encoding')}`)
check('WASM MIME', r.headers.get('content-type') === 'application/wasm', r.headers.get('content-type'))
check('hash 檔名長快取', (r.headers.get('cache-control') ?? '').includes('immutable'))
r = await get(`/office/word/${wasm}`, { ...A, 'Accept-Encoding': 'identity' }, 'HEAD')
check('不收 gzip 就送原檔', r.status === 200 && !r.headers.get('content-encoding'))
r = await get('/office/word/', { ...A, ...DOC })
const etag = r.headers.get('etag'); await r.arrayBuffer()
r = await get('/office/word/', { ...A, ...DOC, 'If-None-Match': etag })
check('非 hash 檔有 ETag → 304', !!etag && r.status === 304, `${etag} ${r.status}`)

console.log('== 路徑')
// ⚠️ 不能用 fetch：WHATWG URL 會先把 %2e%2e／.. 正規化掉，送出去的根本不是這條路徑
//    （實測 /office/word/%2e%2e/%2e%2e/CURRENT 被改成 /CURRENT、落到 SPA 回 200，看起來像漏洞其實沒打到）
const rawGet = (path, headers) => new Promise((res, rej) => {
  const u = new URL(H)
  http.get({ host: u.hostname, port: u.port, path, headers }, resp => { resp.resume(); res(resp.statusCode) }).on('error', rej)
})
for (const p of ['/office/word/..%2F..%2FCURRENT', '/office/word/%2e%2e/%2e%2e/CURRENT', '/office/word/../../CURRENT', '/office/word/%2e%2e%2f%2e%2e%2fCURRENT', '/office/word/..%5C..%5CCURRENT', '/office/word/snippets/%2e%2e/index.html', '/office/nope/', '/office/word/missing.js', '/office/excel/']) {
  const s = await rawGet(p, { ...A, ...SUB })
  check(`${p} → 404`, s === 404, String(s))
}
r = await get('/office/word/index.html', A, 'POST')
check('POST → 405', r.status === 405, String(r.status))

console.log('== SPA 本身不受影響')
r = await get('/', DOC)
check('首頁照常', r.status === 200 && (await r.text()).includes('<div id="root"'))
r = await get('/officeX', DOC)
check('/officeX 不被 office 吃掉（走 SPA）', r.status === 200)

db.prepare('DELETE FROM auth_sessions WHERE expires_at > ? AND created_at > ?').run(Date.now(), Date.now() - 600_000)
console.log(fail ? `\n${fail} 條失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)

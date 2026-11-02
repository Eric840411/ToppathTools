/**
 * 文書工具（v5.68.x）真 server 冒煙：/office/* 與 /api/office/apps 的登入、權限、檔案送出、標頭、版本綁定。
 * 跑法：先用 DB 副本把 build 後的 server 起在別的 port（見 docs/features/34-office.md「驗證」），再
 *   node scripts/ui-checks/office-live-check.mjs <base url> <DB 副本路徑> [OFFICE_DIST_DIR]
 * 版本裡至少要有 word（嵌 iframe 的）與 film（需要獨立分頁的）。
 * 給了 OFFICE_DIST_DIR 且 releases/ 底下有第二個版本時，會暫時切過去驗「舊版本網址照常可用」，結束時切回來。
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import http from 'http'
import { join } from 'path'
import { devSidHash } from './lib/dev-session.mjs'

const [H, dbPath, officeDir] = process.argv.slice(2)
if (!H || !dbPath) { console.error('用法：node scripts/ui-checks/office-live-check.mjs <base url> <DB 副本> [OFFICE_DIST_DIR]'); process.exit(2) }
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
const json = r => r.json().catch(() => ({}))
const DOC = { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' }
const SUB = { 'Sec-Fetch-Dest': 'script', Accept: '*/*' }

let r = await get('/api/office/apps', A)
let j = await json(r)
const REL = j.release
const W = `/office/v/${REL}/word`
console.log(`版本 ${REL}`)
// 拿不到版本就不能往下測，更不能進「切版」那段——會把 CURRENT 寫成 undefined／null，後面每一輪都跟著壞
const relOk = typeof REL === 'string' && /^[A-Za-z0-9._-]+$/.test(REL)
check('/api/office/apps 回得出目前版本', relOk, JSON.stringify(j).slice(0, 120))

console.log('== 未登入')
r = await get(`${W}/`, DOC)
check('開頁面 → 302 導回首頁（不是 SPA 的 index.html）', r.status === 302 && r.headers.get('location') === '/', `${r.status} ${r.headers.get('location')}`)
r = await get(`${W}/index.html`, SUB)
check('子資源 → 401 JSON', r.status === 401 && (await json(r)).code === 'UNAUTHENTICATED')
r = await get('/office/word/', DOC)
check('入口也擋（不先導到版本網址）', r.status === 302 && r.headers.get('location') === '/', `${r.status} ${r.headers.get('location')}`)
r = await get('/api/office/apps')
check('/api/office/apps → 401', r.status === 401)
r = await get(`/OFFICE/V/${REL}/WORD/`, DOC)
check('大寫網址也擋', r.status === 302, String(r.status))
r = await get(`/office/v/${REL}/effect/sw.js`)
let swText = await r.text()
check('sw.js 不登入也回退役版（舊 SW 才換得掉）', r.status === 200 && swText.includes('unregister') && (r.headers.get('content-type') ?? '').includes('javascript'), String(r.status))
check('sw.js 不快取', r.headers.get('cache-control') === 'no-store')

console.log('== 登入但沒有 office 權限')
r = await get(`${W}/`, { ...P, ...DOC })
check('開頁面 → 403', r.status === 403, String(r.status))
r = await get(`${W}/index.html`, { ...P, ...SUB })
check('子資源 → 403 JSON', r.status === 403 && (await json(r)).code === 'FORBIDDEN')
r = await get('/api/office/apps', P)
check('/api/office/apps → 403', r.status === 403, String(r.status))

console.log('== 管理員')
check('/api/office/apps 只列有部署的', j.ok && j.deployed && j.apps.map(a => a.id).join(',') === 'word,film', JSON.stringify(j.apps?.map(a => a.id)))
check('film 標成需要獨立分頁', j.apps?.find(a => a.id === 'film')?.isolate === true)
r = await get('/office/word/', { ...A, ...DOC })
check('入口 → 302 到目前版本', r.status === 302 && r.headers.get('location') === `${W}/`, `${r.status} ${r.headers.get('location')}`)
r = await get(W, { ...A, ...DOC })
check('版本網址少結尾斜線 → 302 補上', r.status === 302 && r.headers.get('location') === `${W}/`, `${r.status} ${r.headers.get('location')}`)
r = await get(`${W}/`, { ...A, ...DOC })
const body = await r.text()
check('index.html 200', r.status === 200 && body.includes('wordcraft'), String(r.status))
check('Content-Type html', (r.headers.get('content-type') ?? '').startsWith('text/html'))
check('COOP／COEP 標頭', r.headers.get('cross-origin-opener-policy') === 'same-origin' && r.headers.get('cross-origin-embedder-policy') === 'require-corp')
check('HTML 不長快取（每次回來驗登入）', (r.headers.get('cache-control') ?? '') === 'private, no-cache', r.headers.get('cache-control'))
const wasm = body.match(/href="\.\/([^"]+\.wasm)"/)?.[1]
r = await get(`${W}/${wasm}`, { ...A, 'Accept-Encoding': 'gzip' }, 'HEAD')
check('WASM 送預先壓好的 gzip', r.status === 200 && r.headers.get('content-encoding') === 'gzip', `${r.status} ${r.headers.get('content-encoding')}`)
check('WASM MIME', r.headers.get('content-type') === 'application/wasm', r.headers.get('content-type'))
check('hash 檔名長快取', (r.headers.get('cache-control') ?? '').includes('immutable'))
r = await get(`${W}/${wasm}`, { ...A, 'Accept-Encoding': 'identity' }, 'HEAD')
check('不收 gzip 就送原檔', r.status === 200 && !r.headers.get('content-encoding'))
r = await get(`${W}/`, { ...A, ...DOC })
const etag = r.headers.get('etag'); await r.arrayBuffer()
r = await get(`${W}/`, { ...A, ...DOC, 'If-None-Match': etag })
check('非 hash 檔有 ETag → 304', !!etag && r.status === 304, `${etag} ${r.status}`)

console.log('== 路徑')
// ⚠️ 不能用 fetch：WHATWG URL 會先把 %2e%2e／.. 正規化掉，送出去的根本不是這條路徑
//    （實測 /office/word/%2e%2e/%2e%2e/CURRENT 被改成 /CURRENT、落到 SPA 回 200，看起來像漏洞其實沒打到）
const rawGet = (path, headers) => new Promise((res, rej) => {
  const u = new URL(H)
  http.get({ host: u.hostname, port: u.port, path, headers }, resp => { resp.resume(); res(resp.statusCode) }).on('error', rej)
})
for (const p of [`${W}/..%2F..%2F..%2FCURRENT`, `${W}/%2e%2e/%2e%2e/%2e%2e/CURRENT`, `${W}/../../../CURRENT`, `${W}/%2e%2e%2f%2e%2e%2f%2e%2e%2fCURRENT`,
  `${W}/..%5C..%5C..%5CCURRENT`, `${W}/snippets/%2e%2e/index.html`, '/office/v/%2e%2e/word/', '/office/v/nope/word/', `/office/v/${REL}/nope/`,
  '/office/nope/', `${W}/missing.js`, `/office/v/${REL}/excel/`]) {
  const s = await rawGet(p, { ...A, ...SUB })
  check(`${p} → 404`, s === 404, String(s))
}
r = await get(`${W}/index.html`, A, 'POST')
check('POST → 405', r.status === 405, String(r.status))

if (officeDir && relOk) {
  console.log('== 部署切版：已開著的舊版本網址照常可用')
  const other = readdirSync(join(officeDir, 'releases')).find(n => !n.startsWith('.') && n !== REL)
  if (!other) check('releases/ 底下要有第二個版本', false)
  else {
    const swap = name => { writeFileSync(join(officeDir, 'CURRENT.tmp'), name + '\n'); renameSync(join(officeDir, 'CURRENT.tmp'), join(officeDir, 'CURRENT')) }
    swap(other)
    try {
      r = await get(`${W}/${wasm}`, A, 'HEAD')
      check(`切到 ${other} 後，舊版本的 hash WASM 仍 200`, r.status === 200, String(r.status))
      r = await get('/office/word/', { ...A, ...DOC })
      check('入口改導到新版本', r.headers.get('location') === `/office/v/${other}/word/`, r.headers.get('location'))
      j = await json(await get('/api/office/apps', A))
      check('/api/office/apps 回新版本', j.release === other, j.release)
    } finally {
      swap(REL)
      check('切回原版本', readFileSync(join(officeDir, 'CURRENT'), 'utf8').trim() === REL)
    }
  }
}

console.log('== SPA 本身不受影響')
r = await get('/', DOC)
check('首頁照常', r.status === 200 && (await r.text()).includes('<div id="root"'))
r = await get('/officeX', DOC)
check('/officeX 不被 office 吃掉（走 SPA）', r.status === 200)

db.prepare('DELETE FROM auth_sessions WHERE expires_at > ? AND created_at > ?').run(Date.now(), Date.now() - 600_000)
console.log(fail ? `\n${fail} 條失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)

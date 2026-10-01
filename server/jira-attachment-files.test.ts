/**
 * Jira 附件落盤／下載／上傳的測試。跑法：npx tsx server/jira-attachment-files.test.ts
 *
 * 全部打本機假伺服器，不碰真的 Lark／Jira：
 * - 下載超過上限要**在途中**中止，半成品刪掉；Content-Length 已經超過的連開始都不要
 * - 快取清理只刪過期的，touch 過的（使用中）不能刪
 * - 上傳到「假 Jira」：收到的內容要一模一樣，而且**記憶體不能長出一整份檔案**
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes, createHash } from 'crypto'
import { AttachmentTooLargeError, CACHE_TTL_MS, cleanAttachmentCache, saveResponseToCache, touchCacheFile, uploadFileToJira } from './jira-attachment-files.js'
import { MAX_ATTACHMENT_BYTES } from '../shared/attachment-limits.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'att-test-'))
const files = () => readdirSync(dir)

// ── 假下載伺服器：/bytes/N 回 N bytes；?len=1 帶 Content-Length，否則 chunked ──
let bytesSent = 0
const dl = createServer((req: IncomingMessage, res: ServerResponse) => {
  const u = new URL(req.url!, 'http://x')
  const n = Number(u.pathname.split('/')[2])
  const withLen = u.searchParams.get('len') === '1'
  res.writeHead(200, withLen ? { 'content-length': String(n), 'content-type': 'video/mp4' } : { 'content-type': 'video/mp4' })
  let left = n
  const chunk = Buffer.alloc(64 * 1024, 7)
  const pump = () => {
    while (left > 0) {
      const part = chunk.subarray(0, Math.min(chunk.length, left))
      left -= part.length; bytesSent += part.length
      if (!res.write(part)) { res.once('drain', pump); return }
    }
    res.end()
  }
  res.on('close', () => { left = 0 })   // 用戶端中止時停止送
  pump()
})
await new Promise<void>(r => dl.listen(0, r))
const dlPort = (dl.address() as { port: number }).port
const get = (path: string) => fetch(`http://127.0.0.1:${dlPort}${path}`)

const LIMIT = 1024 * 1024   // 測試用 1 MiB 上限，跑得快
{
  const f = await saveResponseToCache(await get(`/bytes/${LIMIT}`), LIMIT, dir)
  eq('剛好等於上限 → 收下', [f.size, statSync(f.path).size], [LIMIT, LIMIT])
}
{
  const before = files().length
  bytesSent = 0
  const err = await saveResponseToCache(await get(`/bytes/${50 * LIMIT}`), LIMIT, dir).then(() => null, e => e)
  eq('超過上限（chunked）→ AttachmentTooLargeError', err instanceof AttachmentTooLargeError, true)
  eq('超過上限 → 半成品刪掉', files().length, before)
  eq('超過上限 → 途中就中止，沒有把 50MiB 下載完', bytesSent < 10 * LIMIT, true)
}
{
  const before = files().length
  bytesSent = 0
  const err = await saveResponseToCache(await get(`/bytes/${50 * LIMIT}?len=1`), LIMIT, dir).then(() => null, e => e)
  eq('Content-Length 已超過 → 直接拒絕', err instanceof AttachmentTooLargeError ? (err as AttachmentTooLargeError).sizeBytes : null, 50 * LIMIT)
  eq('Content-Length 已超過 → 沒留檔', files().length, before)
}
{
  const err = await saveResponseToCache(await get(`/bytes/${LIMIT + 1}`), LIMIT, dir).then(() => null, e => e)
  eq('上限 +1 byte → 拒絕', err instanceof AttachmentTooLargeError, true)
}
{
  const f = await saveResponseToCache(await get(`/bytes/${57 * 1024 * 1024}`), MAX_ATTACHMENT_BYTES, dir)
  eq('57MB 在正式上限內 → 收下且大小正確', f.size, 57 * 1024 * 1024)
}
dl.close()

// ── 快取清理 ──
{
  const old = join(dir, 'old-file'); const busy = join(dir, 'busy-file')
  writeFileSync(old, 'x'); writeFileSync(busy, 'x')
  const past = new Date(Date.now() - CACHE_TTL_MS - 60_000)
  utimesSync(old, past, past); utimesSync(busy, past, past)
  touchCacheFile(busy)   // 上傳前會 touch
  cleanAttachmentCache(Date.now(), dir)
  eq('過期的被清掉', files().includes('old-file'), false)
  eq('touch 過（使用中）的不能被清掉', files().includes('busy-file'), true)
}

// ── 上傳到假 Jira：內容一致、記憶體不長出整份檔案 ──
// 假 Jira 跑在**子 process**：它為了驗內容要把整份收進記憶體，放在同一個 process 會把那 57MB 算進來，
// 量測就會跟著 GC 時機飄（實測偶發誤報）。拆開之後量到的只有送出端自己
{
  const size = 57 * 1024 * 1024
  const src = join(dir, 'upload-src')
  writeFileSync(src, randomBytes(size))
  const srcHash = createHash('sha256').update(readFileSync(src)).digest('hex')
  const jiraScript = join(dir, 'fake-jira.mjs')
  writeFileSync(jiraScript, `
import { createServer } from 'http'
import { createHash } from 'crypto'
const srv = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const boundary = '--' + String(req.headers['content-type']).split('boundary=')[1]
  const start = body.indexOf('\\r\\n\\r\\n') + 4
  const end = body.lastIndexOf('\\r\\n' + boundary)
  const file = body.subarray(start, end)
  process.stdout.write(JSON.stringify({ bytes: file.length, hash: createHash('sha256').update(file).digest('hex'), token: req.headers['x-atlassian-token'] }) + '\\n')
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ filename: 'vid.mp4' }]))
})
srv.listen(0, () => process.stdout.write('PORT ' + srv.address().port + '\\n'))
`)
  const { spawn } = await import('child_process')
  const jira = spawn(process.execPath, [jiraScript], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  jira.stdout.on('data', d => { out += d })
  const portDeadline = Date.now() + 10_000
  while (!/PORT (\d+)/.test(out)) {
    if (Date.now() > portDeadline) throw new Error('假 Jira 子 process 沒有啟動')
    await new Promise(r => setTimeout(r, 20))
  }
  const port = Number(out.match(/PORT (\d+)/)![1])
  global.gc?.()
  await new Promise(r => setTimeout(r, 50))
  const base = process.memoryUsage()
  let peak = 0
  const sampler = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers) }, 5)
  const stored = await uploadFileToJira('TEST-1', 'vid.mp4', src, 'video/mp4', 'Basic x', `http://127.0.0.1:${port}`)
  clearInterval(sampler)
  const hashDeadline = Date.now() + 10_000
  while (!out.includes('"hash"') && Date.now() < hashDeadline) await new Promise(r => setTimeout(r, 20))
  jira.kill()
  const got = JSON.parse(out.split('\n').find(l => l.includes('"hash"')) ?? '{}') as { bytes: number; hash: string; token: string }
  eq('上傳：Jira 收到的內容一模一樣', [got.bytes, got.hash === srcHash], [size, true])
  eq('上傳：帶 X-Atlassian-Token: no-check', got.token, 'no-check')
  eq('上傳：回傳 Jira 存的檔名', stored, 'vid.mp4')
  console.log(`   （送出端記憶體峰值增量 ${(peak / 1024 / 1024).toFixed(1)}MB，檔案 ${(size / 1024 / 1024).toFixed(0)}MB）`)
  eq('上傳：送出端沒有把整份檔案讀進記憶體（峰值 < 檔案的 1/4）', peak < size / 4, true)
}

// ── 租約：排隊中的附件跨過 TTL 也不能被清掉（CodeX review 05145a3）──
{
  const leaseDir = mkdtempSync(join(tmpdir(), 'att-lease-'))
  const t0 = Date.now()
  const id1 = '11111111-1111-4111-8111-111111111111', id2 = '22222222-2222-4222-8222-222222222222'
  for (const id of [id1, id2]) {
    writeFileSync(join(dir, id), 'x')
    const nearExpiry = new Date(t0 - CACHE_TTL_MS + 10 * 60_000)   // 再 10 分鐘就過期
    utimesSync(join(dir, id), nearExpiry, nearExpiry)
  }
  const { createLease, renewLease, releaseLease, leasedCacheIds } = await import('./jira-attachment-files.js')
  const lease = createLease([id1, id2], { now: t0, ttlMs: 30 * 60_000, leaseDir, cacheDir: '/nonexistent' })   // 不 touch，只靠租約
  // 批次跑了 25 分鐘：檔案已超過 TTL，但租約還有效
  cleanAttachmentCache(t0 + 25 * 60_000, dir, leaseDir)
  eq('租約：檔案超過 TTL 但租約有效 → 不清', [files().includes(id1), files().includes(id2)], [true, true])
  // 續約後再過 25 分鐘（原本的租約早該到期）
  renewLease(lease, { now: t0 + 25 * 60_000, ttlMs: 30 * 60_000, leaseDir })
  cleanAttachmentCache(t0 + 50 * 60_000, dir, leaseDir)
  eq('租約：續約後跨過原本到期時間仍受保護', files().includes(id1), true)
  // 批次結束放掉租約 → 下一輪清理就刪
  releaseLease(lease, leaseDir)
  cleanAttachmentCache(t0 + 51 * 60_000, dir, leaseDir)
  eq('租約：放掉後過期檔照常清掉', [files().includes(id1), files().includes(id2)], [false, false])
  // worker 當掉沒放租約：到期後不再保護，租約檔本身也被清掉
  writeFileSync(join(dir, id1), 'x'); utimesSync(join(dir, id1), new Date(t0 - CACHE_TTL_MS - 60_000), new Date(t0 - CACHE_TTL_MS - 60_000))
  createLease([id1], { now: t0, ttlMs: 30 * 60_000, leaseDir, cacheDir: '/nonexistent' })
  cleanAttachmentCache(t0 + 31 * 60_000, dir, leaseDir)
  eq('租約：到期（沒人放）後不再保護', files().includes(id1), false)
  eq('租約：過期的租約檔被清掉', leasedCacheIds(t0 + 31 * 60_000, leaseDir).ids.size === 0 && readdirSync(leaseDir).length === 0, true)
  eq('租約：不是 UUID 的 cacheId 不收', leasedCacheIds(t0, leaseDir).ids.size === 0 && JSON.parse(readFileSync(join(leaseDir, createLease(['../etc/passwd'], { now: t0, leaseDir, cacheDir: '/nonexistent' }) + '.json'), 'utf8')).ids.length, 0)
}

// ── 租約檔讀不懂 → 這一輪一個都不刪；跨 process 續約與讀取交錯不能讀到半份（CodeX review 5056b6c）──
{
  const leaseDir = mkdtempSync(join(tmpdir(), 'att-lease2-'))
  const { createLease, renewLease, leasedCacheIds } = await import('./jira-attachment-files.js')
  const id = '33333333-3333-4333-8333-333333333333'
  writeFileSync(join(dir, id), 'x')
  utimesSync(join(dir, id), new Date(Date.now() - CACHE_TTL_MS - 60_000), new Date(Date.now() - CACHE_TTL_MS - 60_000))
  writeFileSync(join(leaseDir, '44444444-4444-4444-8444-444444444444.json'), '{"ids":["3333')   // 半份 JSON
  const removed = cleanAttachmentCache(Date.now(), dir, leaseDir)
  eq('租約檔讀不懂 → 這一輪不刪（不知道它保護了誰）', [removed, files().includes(id)], [0, true])
  eq('租約檔讀不懂 → 回報 uncertain', leasedCacheIds(Date.now(), leaseDir).uncertain, true)

  // 租約目錄本身列不出來（權限／I/O 錯誤）：拿一個「檔案」當目錄，readdir 會丟 ENOTDIR
  const notADir = join(leaseDir, '..', `lease-not-a-dir-${process.pid}`)
  writeFileSync(notADir, 'x')
  const removed2 = cleanAttachmentCache(Date.now(), dir, notADir)
  eq('租約目錄列舉失敗 → 這一輪不刪', [removed2, files().includes(id)], [0, true])
  eq('租約目錄列舉失敗 → 回報 uncertain', leasedCacheIds(Date.now(), notADir).uncertain, true)
  eq('租約目錄不存在（ENOENT）→ 視為沒有租約、不是 uncertain', leasedCacheIds(Date.now(), join(leaseDir, 'does-not-exist')).uncertain, false)

  // 跨 process：子 process 狂續約，這邊狂讀，一次都不能讀到空檔／半份
  const leaseDir3 = mkdtempSync(join(tmpdir(), 'att-lease3-'))
  const many = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`)
  const leaseId = createLease(many, { leaseDir: leaseDir3, cacheDir: '/nonexistent' })
  const childFile = join(leaseDir3, '..', `renew-child-${process.pid}.ts`)
  writeFileSync(childFile, `import { renewLease } from ${JSON.stringify(new URL('./jira-attachment-files.ts', import.meta.url).href)}
const end = Date.now() + 2500
let n = 0
while (Date.now() < end) { renewLease(${JSON.stringify(leaseId)}, { leaseDir: ${JSON.stringify(leaseDir3)} }); n++ }
console.log(n)`)
  const { spawn } = await import('child_process')
  const child = spawn(process.execPath, ['--import', 'tsx', childFile], { stdio: ['ignore', 'pipe', 'inherit'] })
  let childOut = ''
  child.stdout.on('data', d => { childOut += d })
  const childDone = new Promise(r => child.on('close', r))
  await new Promise(r => setTimeout(r, 400))   // 等子 process 開始寫
  // 兩種讀法分開算：
  // ① 原始讀（不重試）：讀到「內容不完整」（空檔、JSON 解析失敗）＝寫入不是原子的。Windows 上 rename 替換那一瞬間
  //    可能拿到 EPERM／EBUSY，那是作業系統層的鎖，不是內容壞掉，另外計數、不算失敗
  // ② 正式路徑 leasedCacheIds（會重試）：不能回報 uncertain、也不能少 id
  // 分開是因為重試會把「讀到半份」蓋掉——只看 ② 的話，非原子寫入有一半機率測不出來（突變實測）
  const leaseFp = join(leaseDir3, `${leaseId}.json`)
  let reads = 0, partial = 0, osLocked = 0, prodBad = 0
  const until = Date.now() + 1800
  while (Date.now() < until) {
    reads++
    try {
      const raw = readFileSync(leaseFp, 'utf8')
      try { if ((JSON.parse(raw) as { ids: string[] }).ids.length !== many.length) partial++ } catch { partial++ }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOENT') osLocked++
      else partial++
    }
    const r = leasedCacheIds(Date.now(), leaseDir3)
    if (r.uncertain || r.ids.size !== many.length) prodBad++
    await new Promise(r => setImmediate(r))
  }
  await childDone
  console.log(`   （子 process 續約 ${childOut.trim()} 次，這邊讀 ${reads} 次；作業系統鎖 ${osLocked} 次）`)
  eq('跨 process：原始讀一次都沒讀到不完整的內容（寫入是原子的）', partial, 0)
  eq('跨 process：正式讀取路徑一次都沒回報 uncertain／少 id', prodBad, 0)
  eq('跨 process：子 process 真的有在續約（不然上一條是空測）', Number(childOut.trim()) > 100, true)
  void renewLease
}

// ── 上傳 handler：錯誤回應／中途斷線都不留半成品 ──
{
  const express = (await import('express')).default
  const { Writable } = await import('stream')
  const { createWriteStream } = await import('fs')
  const { createAttachmentUploadHandler } = await import('./jira-attachment-files.js')
  const upDir = mkdtempSync(join(tmpdir(), 'att-up-'))
  const upFiles = () => readdirSync(upDir)
  const settle = () => new Promise(r => setTimeout(r, 1500))   // removeUploadPaths 在 Windows 上可能要重試

  /** 模擬磁碟寫滿：真的建立檔案、寫一點之後丟 ENOSPC */
  const enospcStream = (path: string) => {
    const real = createWriteStream(path)
    let written = 0
    return new Writable({
      write(chunk, _enc, cb) {
        written += chunk.length
        if (written > 256 * 1024) { real.end(); cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); return }
        real.write(chunk, cb)
      },
      final(cb) { real.end(cb) },
    })
  }
  let streamFactory: ((p: string) => import('stream').Writable) | undefined
  const app = express()
  const okStreams: import('stream').Writable[] = []
  const okHandler = await createAttachmentUploadHandler({ dir: upDir, createStream: p => { const w = createWriteStream(p); okStreams.push(w); return w } })
  const failHandler = await createAttachmentUploadHandler({ dir: upDir, createStream: p => (streamFactory ?? enospcStream)(p) })
  app.post('/ok', okHandler)
  app.post('/fail', failHandler)
  const srv = app.listen(0)
  await new Promise(r => srv.once('listening', r))
  const port = (srv.address() as { port: number }).port
  const post = (path: string, size: number) => {
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.alloc(size, 1)], { type: 'video/mp4' }), 'v.mp4')
    return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: fd })
  }

  const r1 = await post('/ok', 2 * 1024 * 1024)
  const d1 = await r1.json() as { ok: boolean; cacheId: string; size: number }
  eq('上傳 handler：正常上傳落盤、大小正確', [d1.ok, d1.size, upFiles().includes(d1.cacheId)], [true, 2 * 1024 * 1024, true])

  const before = upFiles().length
  const r2 = await post('/fail', 2 * 1024 * 1024)
  const d2 = await r2.json() as { ok: boolean; message: string }
  await settle()
  eq('磁碟寫滿：回錯誤', [r2.status, d2.ok, /ENOSPC/.test(d2.message)], [500, false, true])
  eq('磁碟寫滿：半成品刪掉（回了錯誤之後也要刪）', upFiles().length, before)

  // 中途斷線：送一半就把連線切掉
  const { request } = await import('http')
  const before2 = upFiles().length
  await new Promise<void>(resolve => {
    const boundary = 'xBOUNDARYx'
    const req = request({ host: '127.0.0.1', port, path: '/ok', method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
    req.on('error', () => resolve())
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v.mp4"\r\nContent-Type: video/mp4\r\n\r\n`)
    req.write(Buffer.alloc(1024 * 1024, 2))
    setTimeout(() => { req.destroy(); resolve() }, 300)
  })
  await settle()
  eq('中途斷線：半成品刪掉', upFiles().length, before2)
  eq('中途斷線：寫入串流已經關閉（不能留著開啟的檔案描述符）', okStreams[okStreams.length - 1]?.destroyed, true)
  srv.close()
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

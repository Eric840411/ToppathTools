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
{
  const size = 57 * 1024 * 1024
  const src = join(dir, 'upload-src')
  writeFileSync(src, randomBytes(size))
  const srcHash = createHash('sha256').update(readFileSync(src)).digest('hex')
  let receivedHash = '', receivedBytes = 0, sawAuth = ''
  const jira = createServer(async (req, res) => {
    sawAuth = String(req.headers['x-atlassian-token'] ?? '')
    // 從 multipart 裡取檔案內容：找第一個空行之後到結尾邊界之前
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const boundary = '--' + String(req.headers['content-type']).split('boundary=')[1]
    const start = body.indexOf('\r\n\r\n') + 4
    const end = body.lastIndexOf('\r\n' + boundary)
    const file = body.subarray(start, end)
    receivedBytes = file.length
    receivedHash = createHash('sha256').update(file).digest('hex')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ filename: 'vid.mp4' }]))
  })
  await new Promise<void>(r => jira.listen(0, r))
  const port = (jira.address() as { port: number }).port
  global.gc?.()
  const base = process.memoryUsage()
  let peak = 0
  const sampler = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers) }, 5)
  const stored = await uploadFileToJira('TEST-1', 'vid.mp4', src, 'video/mp4', 'Basic x', `http://127.0.0.1:${port}`)
  clearInterval(sampler)
  jira.close()
  eq('上傳：Jira 收到的內容一模一樣', [receivedBytes, receivedHash === srcHash], [size, true])
  eq('上傳：帶 X-Atlassian-Token: no-check', sawAuth, 'no-check')
  eq('上傳：回傳 Jira 存的檔名', stored, 'vid.mp4')
  // 註：假 Jira 跟測試在同一個 process，它自己為了驗內容會把整份收進記憶體——那是接收端，不算在上傳端。
  // 所以只看「送出那段時間」上傳端是否另外長出一整份：把接收端那份（size）扣掉後要明顯小於 size
  console.log(`   （送出期間記憶體峰值增量 ${(peak / 1024 / 1024).toFixed(1)}MB，其中約 ${(size / 1024 / 1024).toFixed(0)}MB 是假 Jira 收下的那份）`)
  eq('上傳：送出端沒有另外把整份檔案讀進記憶體', peak - size < size / 2, true)
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

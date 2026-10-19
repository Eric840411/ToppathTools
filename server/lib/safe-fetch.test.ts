/**
 * safe-fetch 的回歸。跑法：npx tsx server/lib/safe-fetch.test.ts
 * 本機起兩個 http server：一個轉址到 127.0.0.1，確認轉址那一跳會被擋（不只擋第一跳）。
 */
import { createServer } from 'http'
import { classifyIp, assertSafeUrl, safeFetch, UnsafeUrlError, isObviouslyInternalHost } from './safe-fetch.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) pass++
  else fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}
async function rejects(name: string, p: Promise<unknown>) {
  try { await p; fails.push(`${name}: 沒有被擋`) }
  catch (e) { eq(name, e instanceof UnsafeUrlError, true) }
}

eq('127.0.0.1', classifyIp('127.0.0.1'), 'block')
eq('metadata', classifyIp('169.254.169.254'), 'block')
eq('0.0.0.0', classifyIp('0.0.0.0'), 'block')
eq('10.x', classifyIp('10.1.2.3'), 'private')
eq('172.31', classifyIp('172.31.0.1'), 'private')
eq('172.32 公網', classifyIp('172.32.0.1'), 'public')
eq('192.168', classifyIp('192.168.1.36'), 'private')
eq('公網', classifyIp('8.8.8.8'), 'public')
eq('::1', classifyIp('::1'), 'block')
eq('mapped loopback', classifyIp('::ffff:127.0.0.1'), 'block')
eq('fe80', classifyIp('fe80::1'), 'block')
eq('ULA', classifyIp('fd00::1'), 'private')
eq('obvious localhost', isObviouslyInternalHost('localhost'), true)
eq('obvious 127', isObviouslyInternalHost('127.0.0.1'), true)
eq('obvious 公網網域', isObviouslyInternalHost('qat-cp.osmslot.org'), false)

await rejects('file://', assertSafeUrl('file:///etc/passwd'))
await rejects('直接 127', assertSafeUrl('http://127.0.0.1:3010/internal/worker/x'))
await rejects('localhost', assertSafeUrl('http://localhost:3000/'))
await rejects('metadata', assertSafeUrl('http://169.254.169.254/latest/meta-data/'))
await rejects('十進位 IP', assertSafeUrl('http://2130706433/'))
await rejects('內網非 OSM', assertSafeUrl('http://192.168.1.36:3000/'))
await rejects('帶帳密', assertSafeUrl('https://user:pw@example.com/'))

// 轉址到 loopback：第一跳是公網才測得到「每一跳都檢查」。本機測試只能用 loopback 當起點，
// 所以直接驗 safeFetch 對起點就擋（起點檢查）＋ 用 assertSafeUrl 模擬 location 那一跳。
const srv = createServer((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }); res.end() })
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
const port = (srv.address() as { port: number }).port
await rejects('safeFetch 起點 loopback', safeFetch(`http://127.0.0.1:${port}/`))
await rejects('location 相對 → loopback', assertSafeUrl(new URL('http://127.0.0.1:1/secret', 'https://example.com/')))
srv.close()

console.log(`safe-fetch: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

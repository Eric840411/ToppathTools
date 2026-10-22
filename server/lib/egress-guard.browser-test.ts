/**
 * 瀏覽器出站攔截的實機測試（真的開 Chromium）。跑法：npx tsx server/lib/egress-guard.browser-test.ts
 *
 * CodeX 審 529c495 [P1]：白名單站 302 轉到外站時，route 只攔第一跳。
 * 這裡用 --host-resolver-rules 把 evil.test 指到本機，讓「外站」真的連得到——沒有逐跳檢查的話頁面會載到 EVIL。
 * 先跑一次「不掛防護」當對照組，確認這個測試環境真的會載到 EVIL（不然擋住只是因為 evil.test 本來就連不到）。
 */
import { createServer } from 'http'
import { chromium } from 'playwright'
import { newGuardedContext, browserGuardLaunchArgs } from './egress-guard.js'

let pass = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = '') => { if (c) pass++; else fails.push(`${n} ${d}`) }

const srv = createServer((req, res) => {
  const host = String(req.headers.host ?? '')
  if (host.startsWith('evil.test')) { res.end('EVIL'); return }
  if (req.url === '/redirect') { res.writeHead(302, { location: `http://evil.test:${port}/` }); res.end(); return }
  if (req.url === '/img-redirect') { res.writeHead(302, { location: `http://evil.test:${port}/x.png` }); res.end(); return }
  res.setHeader('content-type', 'text/html')
  res.end('<html><body>GOOD</body></html>')
})
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
const port = (srv.address() as { port: number }).port

// 對照組：不掛防護時，轉址真的會載到 EVIL
{
  const raw = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP evil.test 127.0.0.1'] })
  const p = await (await raw.newContext()).newPage()
  await p.goto(`http://127.0.0.1:${port}/redirect`)
  ok('對照組：沒防護會載到 EVIL', (await p.textContent('body'))?.includes('EVIL') === true)
  await raw.close()
}

const browser = await chromium.launch({ headless: true, args: browserGuardLaunchArgs(undefined, process.env, ['MAP evil.test 127.0.0.1']) })
try {
  const ctx = await newGuardedContext(browser)
  const page = await ctx.newPage()

  await page.goto(`http://127.0.0.1:${port}/`)
  ok('白名單站（本機）正常載入', (await page.textContent('body'))?.includes('GOOD') === true)

  let navErr = ''
  try { await page.goto(`http://127.0.0.1:${port}/redirect`, { timeout: 10000 }) } catch (e) { navErr = String(e) }
  const body = navErr ? '' : (await page.textContent('body').catch(() => '')) ?? ''
  ok('轉址到外站被擋（不能載到 EVIL）', !body.includes('EVIL'), `body=${body} err=${navErr.slice(0, 80)}`)

  let ipErr = ''
  try { await page.goto(`http://8.8.8.8/`, { timeout: 8000 }) } catch (e) { ipErr = String(e) }
  ok('直接開公網 IP 被擋', /ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED/i.test(ipErr), ipErr.slice(0, 80))

  let direct = ''
  try { await page.goto(`http://evil.test:${port}/`, { timeout: 10000 }) } catch (e) { direct = String(e) }
  ok('直接開外站被擋', /ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED|blocked/i.test(direct), direct.slice(0, 80))
} finally {
  await browser.close()
  srv.close()
}

console.log(`egress-guard.browser: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

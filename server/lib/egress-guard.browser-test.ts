/**
 * 瀏覽器出站攔截的實機測試（真的開 Chromium）。跑法：npx tsx server/lib/egress-guard.browser-test.ts
 *
 * CodeX 審 529c495 [P1]：白名單站 302 轉到外站時，route 只攔第一跳。
 * 這裡用 --host-resolver-rules 把 evil.test 指到本機，讓「外站」真的連得到——沒有逐跳檢查的話頁面會載到 EVIL。
 * 先跑一次「不掛防護」當對照組，確認這個測試環境真的會載到 EVIL（不然擋住只是因為 evil.test 本來就連不到）。
 */
import { createServer } from 'http'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { newGuardedContext, browserGuardLaunchArgs, launchGuardedChromium, markBrowserDnsGuard, checkReportExpiry } from './egress-guard.js'

let pass = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = '') => { if (c) pass++; else fails.push(`${n} ${d}`) }

const srv = createServer((req, res) => {
  const host = String(req.headers.host ?? '')
  if (host.startsWith('evil.test')) { res.end('EVIL'); return }
  if (req.url === '/redirect') { res.writeHead(302, { location: `http://evil.test:${port}/` }); res.end(); return }
  if (req.url === '/img-redirect') { res.writeHead(302, { location: `http://evil.test:${port}/x.png` }); res.end(); return }
  if (req.url === '/ip-redirect') { res.writeHead(302, { location: `http://127.0.0.2:${port}/ip` }); res.end(); return }
  if (req.url === '/ip') { res.end('EVIL-IP'); return }
  res.setHeader('content-type', 'text/html')
  res.end('<html><body>GOOD</body></html>')
})
await new Promise<void>(r => srv.listen(0, '0.0.0.0', () => r()))
const port = (srv.address() as { port: number }).port

// 對照組：不掛防護時，轉址真的會載到 EVIL
{
  const raw = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP evil.test 127.0.0.1'] })
  const p = await (await raw.newContext()).newPage()
  await p.goto(`http://127.0.0.1:${port}/redirect`)
  ok('對照組：沒防護會載到 EVIL', (await p.textContent('body'))?.includes('EVIL') === true)
  await raw.close()
}

const guardArgs = browserGuardLaunchArgs(undefined, process.env, ['MAP evil.test 127.0.0.1'])
const browser = await chromium.launch({ headless: true, args: guardArgs })
markBrowserDnsGuard(browser, guardArgs)
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

  // CodeX 審 f2c9fa3：白名單站轉址到 IP（127.0.0.2 不在 DNS 規則的 EXCLUDE 裡，但 route 會把 127/8 當本機放行）
  let ipBody = ''
  try { await page.goto(`http://127.0.0.1:${port}/ip-redirect`, { timeout: 8000 }); ipBody = (await page.textContent('body')) ?? '' } catch { /* blocked */ }
  ok('轉址到 IP 被擋（網路層）', !ipBody.includes('EVIL-IP'), ipBody)

  let direct = ''
  try { await page.goto(`http://evil.test:${port}/`, { timeout: 10000 }) } catch (e) { direct = String(e) }
  ok('直接開外站被擋', /ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED|blocked/i.test(direct), direct.slice(0, 80))
} finally {
  await browser.close()
}

// 對照組：不掛防護時轉址到 IP 真的會載到
{
  const raw = await chromium.launch({ headless: true })
  const p = await (await raw.newContext()).newPage()
  await p.goto(`http://127.0.0.1:${port}/ip-redirect`)
  ok('對照組：沒防護會載到 EVIL-IP', (await p.textContent('body'))?.includes('EVIL-IP') === true)
  await raw.close()
}

// CodeX 審 f2c9fa3 [P1]：report 期間啟動的瀏覽器（沒有 DNS 規則），到期變 enforce 後要整個停擺
{
  process.env.BROWSER_EGRESS_MODE = 'report'
  process.env.BROWSER_EGRESS_REPORT_UNTIL = new Date(Date.now() + 3600_000).toISOString()
  const b2 = await launchGuardedChromium(chromium, { headless: true })
  const p2 = await (await newGuardedContext(b2)).newPage()
  await p2.goto(`http://127.0.0.1:${port}/`)
  ok('report 期間照常載入', (await p2.textContent('body'))?.includes('GOOD') === true)
  delete process.env.BROWSER_EGRESS_MODE   // 等同到期：回到 enforce
  delete process.env.BROWSER_EGRESS_REPORT_UNTIL
  let err = ''
  try { await p2.goto(`http://127.0.0.1:${port}/`, { timeout: 8000 }) } catch (e) { err = String(e) }
  ok('到期後同一個瀏覽器停擺（連白名單也擋，要求重開）', /ERR_BLOCKED_BY_CLIENT/.test(err), err.slice(0, 80))
  await b2.close()
}
// CodeX 審 7508e3e [P1]：report 期間開到外站的 WebSocket，到期後不能再傳資料
{
  const wss = new WebSocketServer({ port: 0, host: '0.0.0.0' })
  await new Promise<void>(r => wss.once('listening', () => r()))
  const wsPort = (wss.address() as { port: number }).port
  let afterExpiry = 0
  let expired = false
  wss.on('connection', ws => ws.on('message', () => { if (expired) afterExpiry++ }))
  // 期限在啟動前就設好（正式環境也是啟動時固定），留 6 秒給下面開頁、連 WS
  process.env.BROWSER_EGRESS_MODE = 'report'
  const until3 = Date.now() + 6000
  process.env.BROWSER_EGRESS_REPORT_UNTIL = new Date(until3).toISOString()
  const b3 = await launchGuardedChromium(chromium, { headless: true, args: ['--host-resolver-rules=MAP evil.test 127.0.0.1'] })
  const p3 = await (await newGuardedContext(b3)).newPage()
  await p3.goto(`http://127.0.0.1:${port}/`)
  await p3.evaluate(url => new Promise<void>(res => { const w = new WebSocket(url); (window as unknown as { __w: WebSocket }).__w = w; w.onopen = () => res() }), `ws://evil.test:${wsPort}/`)
  // 不手動清理：靠到期那一刻的精準計時器自己關（CodeX 審 c96c6aa：手動清理只證明清理後無訊息）
  let leaked = 0
  const sender = setInterval(() => { void p3.evaluate(() => (window as unknown as { __w: WebSocket }).__w.send('tick')).catch(() => {}) }, 100)
  await new Promise(r => setTimeout(r, Math.max(until3 - Date.now(), 0)))
  expired = true
  await new Promise(r => setTimeout(r, 2500))
  clearInterval(sender)
  leaked = afterExpiry
  delete process.env.BROWSER_EGRESS_MODE; delete process.env.BROWSER_EGRESS_REPORT_UNTIL
  ok('到期後（容許 300ms 內的在途訊息）外站 WS 收不到持續傳送', leaked <= 3, String(leaked))
  ok('到期後 report 期間開的瀏覽器被自動關掉（沒有手動清理）', !b3.isConnected())
  wss.close()
}
srv.close()

console.log(`egress-guard.browser: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

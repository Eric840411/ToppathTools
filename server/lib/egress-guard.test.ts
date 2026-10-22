/**
 * 出站白名單的回歸。跑法：npx tsx server/lib/egress-guard.test.ts
 * 重點：共用平台只放用得到的 hostname（不是整個網域）、report 模式要有期限、真的連線會被擋。
 */
import { createServer } from 'net'
import { connect } from 'net'
import { spawn } from 'child_process'
import { isEgressAllowed, egressMode, browserEgressMode, installEgressGuard, registerEgressHost, checkReportExpiry, registerReportBrowserProcess } from './egress-guard.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (got === want) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const env = { OSM_BASE_URL: 'https://backendserver.osmplay.com', IMAGERECON_API_URL: 'https://osm-watch.cliveslot.com/x?token=t', SLS_RECORDBET_PROJECT: 'qat-toppath-osm-logs' } as NodeJS.ProcessEnv
eq('Lark API', isEgressAllowed('open.larksuite.com', env), true)
eq('Meegle', isEgressAllowed('project.larksuite.com', env), true)
eq('Lark 其他子網域不放', isEgressAllowed('evil.larksuite.com', env), false)
eq('Gemini', isEgressAllowed('generativelanguage.googleapis.com', env), true)
eq('googleapis 其他子網域不放', isEgressAllowed('storage.googleapis.com', env), false)
eq('自家後綴', isEgressAllowed('backend-np.osmplay.com', env), true)
eq('自家後綴 osmslot', isEgressAllowed('qat-cp.osmslot.org', env), true)
eq('cliveslot', isEgressAllowed('osm-watch.cliveslot.com', env), true)
eq('假冒後綴', isEgressAllowed('osmplay.com.evil.io', env), false)
eq('前綴相似', isEgressAllowed('evilosmplay.com', env), false)
eq('SLS project host', isEgressAllowed('qat-toppath-osm-logs.ap-southeast-1.log.aliyuncs.com', env), true)
eq('阿里雲其他不放', isEgressAllowed('attacker.oss-ap-southeast-1.aliyuncs.com', env), false)
eq('loopback', isEgressAllowed('127.0.0.1', env), true)
eq('localhost', isEgressAllowed('localhost', env), true)
eq('任意外站', isEgressAllowed('attacker.example', env), false)
// CodeX 審 529c495 [P1]：假 loopback
eq('127.開頭的網域不是 loopback', isEgressAllowed('127.attacker.example', env), false)
eq('localhost 前綴網域', isEgressAllowed('localhost.attacker.example', env), false)
eq('127/8 其他位址', isEgressAllowed('127.0.0.2', env), true)
eq('mapped loopback', isEgressAllowed('::ffff:127.0.0.1', env), true)
eq('公網 IP', isEgressAllowed('8.8.8.8', env), false)
eq('大小寫與結尾點', isEgressAllowed('OPEN.LARKSUITE.COM.', env), true)
registerEgressHost('http://192.168.2.106:11434')
eq('動態登記（Ollama）', isEgressAllowed('192.168.2.106', env), true)

const now = Date.parse('2026-10-22T00:00:00Z')
eq('預設 enforce', egressMode({} as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('report 沒期限 → enforce', egressMode({ EGRESS_MODE: 'report' } as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('report 過期 → enforce', egressMode({ EGRESS_MODE: 'report', EGRESS_REPORT_UNTIL: '2026-10-21T00:00:00Z' } as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('report 期限內', egressMode({ EGRESS_MODE: 'report', EGRESS_REPORT_UNTIL: '2026-10-24T00:00:00Z' } as NodeJS.ProcessEnv, now).mode, 'report')
eq('瀏覽器預設 enforce', browserEgressMode({} as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('瀏覽器 report 沒期限 → enforce', browserEgressMode({ BROWSER_EGRESS_MODE: 'report' } as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('瀏覽器 report 期限內', browserEgressMode({ BROWSER_EGRESS_MODE: 'report', BROWSER_EGRESS_REPORT_UNTIL: '2026-10-24T00:00:00Z' } as NodeJS.ProcessEnv, now).mode, 'report')
eq('Node 的 report 不影響瀏覽器', browserEgressMode({ EGRESS_MODE: 'report', EGRESS_REPORT_UNTIL: '2026-10-24T00:00:00Z' } as NodeJS.ProcessEnv, now).mode, 'enforce')

// 真的連線：裝上攔截後，fetch 清單外主機要失敗、本機要成功
installEgressGuard('test')
const srv = createServer(s => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
const port = (srv.address() as { port: number }).port
const local = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text()).catch(e => String(e))
eq('本機連線照常', local, 'ok')
const blocked = await fetch('http://attacker.example/').then(() => 'connected').catch(e => String(e.cause?.code ?? e.cause?.message ?? e))
eq('清單外被擋', /EGRESS_BLOCKED/.test(blocked), true)

// CodeX 審 7508e3e [P1]：report 期間放行的清單外連線，到期要被切斷（不能只在建立時檢查）
process.env.EGRESS_MODE = 'report'
process.env.EGRESS_REPORT_UNTIL = new Date(Date.now() + 3600_000).toISOString()
const fakeLookup = (_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) => (o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))
const holdSrv = createServer(() => { /* 保持連線不關，模擬持續傳資料的外站 */ })
await new Promise<void>(r => holdSrv.listen(0, '127.0.0.1', () => r()))
const holdPort = (holdSrv.address() as { port: number }).port
const sock = connect({ host: 'evil.invalid', port: holdPort, lookup: fakeLookup } as never)
sock.on('error', () => { /* 到期被切斷時會帶 EGRESS_REPORT_EXPIRED */ })
await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej) })
eq('report 期間清單外連線可建立', sock.destroyed, false)
delete process.env.EGRESS_MODE; delete process.env.EGRESS_REPORT_UNTIL
const closedN = checkReportExpiry()
await new Promise(r => setTimeout(r, 50))
eq('到期後被切斷', sock.destroyed, true)
eq('到期關閉數', closedN >= 1, true)
holdSrv.close()

// 錄製用 Chrome（spawn 的子程序）：report 期間開的，到期要結束
process.env.BROWSER_EGRESS_MODE = 'report'
process.env.BROWSER_EGRESS_REPORT_UNTIL = new Date(Date.now() + 3600_000).toISOString()
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
registerReportBrowserProcess(child, [])
const exited = new Promise<boolean>(r => { child.once('exit', () => r(true)); setTimeout(() => r(false), 5000) })
delete process.env.BROWSER_EGRESS_MODE; delete process.env.BROWSER_EGRESS_REPORT_UNTIL
checkReportExpiry()
eq('到期後錄製用子程序被結束', await exited, true)
const child2 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' })
registerReportBrowserProcess(child2, ['--host-resolver-rules=MAP * ~NOTFOUND'])
eq('有 DNS 規則的不必登記（不會被誤殺）', checkReportExpiry(), 0)

srv.close()

console.log(`egress-guard: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

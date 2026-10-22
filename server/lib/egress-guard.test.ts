/**
 * 出站白名單的回歸。跑法：npx tsx server/lib/egress-guard.test.ts
 * 重點：共用平台只放用得到的 hostname（不是整個網域）、report 模式要有期限、真的連線會被擋。
 */
import { createServer } from 'net'
import { isEgressAllowed, egressMode, installEgressGuard, registerEgressHost } from './egress-guard.js'

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
eq('公網 IP', isEgressAllowed('8.8.8.8', env), false)
eq('大小寫與結尾點', isEgressAllowed('OPEN.LARKSUITE.COM.', env), true)
registerEgressHost('http://192.168.2.106:11434')
eq('動態登記（Ollama）', isEgressAllowed('192.168.2.106', env), true)

const now = Date.parse('2026-10-22T00:00:00Z')
eq('預設 enforce', egressMode({} as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('report 沒期限 → enforce', egressMode({ EGRESS_MODE: 'report' } as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('report 過期 → enforce', egressMode({ EGRESS_MODE: 'report', EGRESS_REPORT_UNTIL: '2026-10-21T00:00:00Z' } as NodeJS.ProcessEnv, now).mode, 'enforce')
eq('report 期限內', egressMode({ EGRESS_MODE: 'report', EGRESS_REPORT_UNTIL: '2026-10-24T00:00:00Z' } as NodeJS.ProcessEnv, now).mode, 'report')

// 真的連線：裝上攔截後，fetch 清單外主機要失敗、本機要成功
installEgressGuard('test')
const srv = createServer(s => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
const port = (srv.address() as { port: number }).port
const local = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text()).catch(e => String(e))
eq('本機連線照常', local, 'ok')
const blocked = await fetch('http://attacker.example/').then(() => 'connected').catch(e => String(e.cause?.code ?? e.cause?.message ?? e))
eq('清單外被擋', /EGRESS_BLOCKED/.test(blocked), true)
srv.close()

console.log(`egress-guard: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

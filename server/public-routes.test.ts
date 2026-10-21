/**
 * 免登入白名單的回歸。跑法：npx tsx server/public-routes.test.ts
 * 重點是「旁邊的路由沒有被順手放行」——每條放行規則都配一條長得很像但必須擋的路徑。
 */
import { publicApiRule, isGuardedPath, isInternalPath, isLoopbackDirect } from './public-routes.js'

let pass = 0
const fails: string[] = []
const open = (m: string, p: string) => { if (publicApiRule(m, p)) pass++; else fails.push(`應放行 ${m} ${p}`) }
const shut = (m: string, p: string) => { if (!publicApiRule(m, p)) pass++; else fails.push(`應擋下 ${m} ${p}（被「${publicApiRule(m, p)!.why}」放行）`) }

open('GET', '/api/health'); open('HEAD', '/api/health')
open('POST', '/api/auth/login'); shut('GET', '/api/auth/login')
open('GET', '/api/accounts'); open('GET', '/api/jira/accounts'); open('POST', '/api/accounts')
shut('DELETE', '/api/accounts/a@x'); shut('POST', '/api/accounts/a@x/set-pin'); shut('POST', '/api/accounts/a@x/verify-pin')
shut('PATCH', '/api/accounts/a@x/role'); shut('GET', '/api/accounts/extra')

open('POST', '/api/machine-test/ocr-proxy'); shut('GET', '/api/machine-test/ocr-proxy')
open('GET', '/api/osm-uat/upload-assets/abc/raw'); shut('DELETE', '/api/osm-uat/upload-assets/abc'); shut('GET', '/api/osm-uat/upload-assets')
open('POST', '/api/frontend-auto/runs/r1/evidence'); shut('POST', '/api/frontend-auto/runs/r1/stop')

open('GET', '/api/machine-test/agent/source-manifest'); open('GET', '/api/machine-test/agent/source/server/agent-runner.ts')
shut('GET', '/api/machine-test/agent/install.bat')           // 會發 agent token，必須登入
shut('POST', '/api/machine-test/start'); shut('POST', '/api/machine-test/agent/source/x')
open('GET', '/api/autospin/agent/download/agent.py'); shut('GET', '/api/autospin/agent/download/install.bat')
open('POST', '/api/autospin/agent/start'); open('POST', '/api/autospin/agent/s1/log'); open('GET', '/api/autospin/agent/s1/should-stop')
shut('POST', '/api/autospin/agent/stop-all'); shut('POST', '/api/autospin/agent/hub-dispatch'); shut('DELETE', '/api/autospin/history')
shut('GET', '/api/autospin/agent/screenshots/s1'); shut('POST', '/api/autospin/agent/s1/pause')
open('GET', '/api/autospin/templates'); shut('POST', '/api/autospin/templates'); shut('DELETE', '/api/autospin/templates/a.png')
open('GET', '/api/autospin/template-img/a.png')
shut('GET', '/api/autospin/reconcile/config'); shut('PUT', '/api/autospin/reconcile/config')
open('PUT', '/api/machine-test/cctv-upload'); shut('POST', '/api/machine-test/cctv-refs/X')
open('POST', '/api/ui-screenshot/task/t1/upload'); shut('POST', '/api/ui-screenshot/start'); shut('DELETE', '/api/ui-screenshot/run/r1')
open('POST', '/api/machine-test/osm-status')
open('GET', '/api/autospin/live-ledger/sls-health'); shut('PUT', '/api/autospin/live-ledger/config')

shut('GET', '/api/gemini/keys'); shut('POST', '/api/gemini/keys'); shut('GET', '/api/history')
shut('POST', '/api/osm/config-compare'); shut('POST', '/api/osm/alert/config'); shut('GET', '/api/url-pool/go/a')
shut('POST', '/internal/testcase-jobs/x/finish')

// CodeX [P1]：Express 路由不分大小寫，守門也不能分
for (const p of ['/API/history', '/Api/gemini/keys', '/aPi/autospin/configs', '/INTERNAL/worker/health']) {
  if (isGuardedPath(p)) pass++; else fails.push(`大小寫變體要受守門：${p}`)
}
if (isInternalPath('/Internal/worker/tasks')) pass++; else fails.push('isInternalPath 大小寫')
shut('GET', '/API/history'); shut('POST', '/API/GEMINI/KEYS')
open('GET', '/API/HEALTH')   // 白名單也一樣不分大小寫（跟 Express 一致）
if (isGuardedPath('/api/x') && isGuardedPath('/internal/worker/health') && !isGuardedPath('/assets/app.js') && !isGuardedPath('/')) pass++
else fails.push('isGuardedPath')

const ok = (n: string, c: boolean) => { if (c) pass++; else fails.push(n) }
ok('loopback 直連', isLoopbackDirect('127.0.0.1', {}))
ok('ipv6 loopback', isLoopbackDirect('::1', {}))
ok('mapped loopback', isLoopbackDirect('::ffff:127.0.0.1', {}))
ok('經過 nginx', !isLoopbackDirect('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }))
ok('x-real-ip', !isLoopbackDirect('127.0.0.1', { 'x-real-ip': '1.2.3.4' }))
ok('外部 IP', !isLoopbackDirect('192.168.1.36', {}))

console.log(`public-routes: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }

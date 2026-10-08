/**
 * 正式站 serverCfg debug 打開（1008，osm-qa-agent-03 回報 osmplay 不印 SEND／ON）。
 *   npx tsx scripts/ui-checks/server-cfg-debug.test.ts
 *
 * 守：只把關閉的 debug 改成 true、別的鍵（apiDebug／_debug）不能動；真瀏覽器載入後前端真的印出 SEND；
 *     沒有 serverCfg.js／沒有 debug 鍵要能分辨出來（警告），不能當成已開啟。
 */
import http from 'http'
import { chromium } from 'playwright'
import { enableServerCfgDebug, installServerCfgDebug, describeServerCfgDebug } from '../../server/machine-test/server-cfg-debug.js'

let fail = 0
const ok = (c: boolean, label: string, got?: unknown) => { if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

// ── 字串 ──
const real = 'window._ServerCfg = {\n  gate: "wss://gate.osmplay.com",\n  debug: false,\n  apiDebug: false,\n}'
const r1 = enableServerCfgDebug(real)
ok(r1.changed && /\n  debug: true,/.test(r1.body), '正式站格式 debug: false → true', r1.body)
ok(/apiDebug: false/.test(r1.body), 'apiDebug 不能被改到', r1.body)
ok(r1.original === 'debug: false', '原值記下來', r1.original)
ok(enableServerCfgDebug('x={"debug":false}').body === 'x={"debug": true}', 'JSON 寫法（鍵帶引號）')
ok(enableServerCfgDebug('x={debug:0}').body === 'x={debug: true}', 'debug:0 也算關閉')
ok(!enableServerCfgDebug('x={_debug: false, isdebug: false}').changed, '_debug／isdebug 不是 debug 鍵')
ok(!enableServerCfgDebug('x={debug: true}').changed, '本來就開的不動')
ok(!enableServerCfgDebug('x={debugUrl: "a"}').changed && enableServerCfgDebug('x={debugUrl: "a"}').original === '', '沒有 debug 鍵 → original 空、不改')
ok(describeServerCfgDebug({ hits: 0, original: '', enabled: false, error: '' }).level === 'warn', '沒攔到 → 警告')
ok(describeServerCfgDebug({ hits: 1, original: '', enabled: false, error: '' }).level === 'warn', '沒有 debug 鍵 → 警告')

// ── 真瀏覽器：前端照 _ServerCfg.debug 決定要不要印 SEND（跟 osmplay 一樣） ──
const routes: Record<string, string> = {
  '/serverCfg.js': real,
  '/nocfg/index.html': '<script>console.log("SEND: 1 hall.hallHandler.loginReq")</script>',
  '/index.html': '<script src="/serverCfg.js?v=3"></script><script>if (window._ServerCfg.debug) console.log("SEND: 1 hall.hallHandler.loginReq {}")</script>',
}
const srv = http.createServer((q, s) => { const body = routes[(q.url ?? '').split('?')[0]]; s.writeHead(body ? 200 : 404, { 'content-type': q.url?.includes('.js') ? 'application/javascript' : 'text/html' }); s.end(body ?? '') })
await new Promise<void>(res => srv.listen(0, '127.0.0.1', res))
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
const browser = await chromium.launch({ headless: true })
try {
  const load = async (path: string, install: boolean) => {
    const ctx = await browser.newContext()
    const st = install ? await installServerCfgDebug(ctx) : null
    const page = await ctx.newPage(); const sends: string[] = []
    page.on('console', m => { if (/^SEND:/.test(m.text())) sends.push(m.text()) })
    await page.goto(base + path); await page.waitForTimeout(300)
    await ctx.close(); return { st, sends }
  }
  const off = await load('/index.html', false)
  ok(off.sends.length === 0, '對照組：沒掛攔截 → 前端不印 SEND（模擬 osmplay）', off.sends)
  const on = await load('/index.html', true)
  ok(on.sends.length === 1, '掛了攔截 → 前端印出 SEND', on.sends)
  ok(on.st?.hits === 1 && on.st.enabled && describeServerCfgDebug(on.st).level === 'info', '狀態：攔到 1 次、已開啟', on.st)
  const none = await load('/nocfg/index.html', true)
  ok(none.st?.hits === 0 && describeServerCfgDebug(none.st!).level === 'warn', '頁面沒有 serverCfg.js → 警告，不當成已開啟', none.st)
} finally { await browser.close(); srv.close() }

console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)

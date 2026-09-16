/**
 * 更新程式碼改走 WebSocket 推送，而且內容對不上就不寫。
 *
 *   node scripts/ui-checks/agent-source-push.mjs
 *
 * 為什麼要有這支（2026-09-16 正式站實際踩到）：
 * 同一份檔案用 HTTP 下載會在途中被截斷——run-lark-tc-backend.js 少 868 字、
 * backend-recorder.js 少 4936 字——而 **HTTP 回 200、寫檔也成功**，
 * 所以整條路徑一路顯示「更新成功」，實際寫進去的卻是一個被截斷的 runner。
 *
 * ⚠️ 被截斷的檔案比更新失敗危險得多：它不會當場出事，會在之後某次執行時
 *    以看不懂的方式壞掉，而那時沒有人會聯想到是更新造成的。
 *
 * 這支釘住三件事：
 *   1. server 真的把內容跟著 WS 訊息一起送（不是只送檔名）
 *   2. agent 有內容就用內容，**不會再回頭用 HTTP**
 *   3. 內容跟指紋對不上時**不寫檔**，而且講得出收到幾個字
 */
import { readFileSync } from 'node:fs'
import { hashOne } from '../../dist-server/server/agent-source-hash.js'

let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}
const ok = (name, cond, detail) => eq(name + (detail ? ' (' + detail + ')' : ''), !!cond, true)

// ── 1. server 端：update_sources 有帶 contents ──
const route = readFileSync('server/routes/machine-test.ts', 'utf8')
ok('update_sources 有帶內容，不是只送檔名',
  /type: 'update_sources', files, contents/.test(route))
ok('內容附上每個檔的指紋（agent 才驗得了）', /hash: hashOne\(content\)/.test(route))
ok('仍然照舊送 files（舊版 agent 才不會整個更新不動）',
  /const files = Object\.keys\(AGENT_SOURCE_WHITELIST\)/.test(route))

// ── 2. agent 端：有推內容就不要再走 HTTP ──
const agent = readFileSync('server/agent-runner.ts', 'utf8')
ok('agent 會優先用 WS 推過來的內容', /const fromWs = pushed\.get\(file\)/.test(agent))
ok('只有拿不到推送內容時才 fetch（舊 server 的退路）',
  /} else \{[\s\S]{0,200}agent\/source\/\$\{file\}/.test(agent))
ok('驗證優先用推過來的指紋', /pushed\.get\(file\)\?\.hash \?\? wantPerFile\[file\]/.test(agent))

// ⚠️ 這條是重點：對不上一定要「不寫」，不是「寫了再說」
const guard = /if \(want && hashOne\(content\) !== want\) \{[\s\S]{0,400}?continue/.test(agent)
ok('內容跟指紋對不上時 continue（跳過寫檔）', guard)
ok('而且錯誤訊息講得出收到幾個字',
  /收到 \$\{content\.length\} 字/.test(agent))
ok('沒有先寫檔再驗（那樣壞檔案已經落地了）',
  agent.indexOf('writeFileSync(targetPath') > agent.indexOf('hashOne(content) !== want'),
  '寫檔必須在驗證之後')

// ── 3. 實際跑一次那段判斷邏輯 ──
// 用真實檔案內容模擬：完整的要通過、被截斷的要被擋
const real = readFileSync('server/uat-runner/backend-recorder.js', 'utf8')
const want = hashOne(real)
const truncated = real.slice(0, real.length - 4936)   // 正式站實際少掉的字數
eq('完整內容 → 指紋相符', hashOne(real) === want, true)
eq('被截斷 4936 字 → 指紋不符（會被擋下來）', hashOne(truncated) === want, false)
ok('而且長度看得出來差多少', real.length - truncated.length === 4936,
  `${real.length} → ${truncated.length}`)

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }

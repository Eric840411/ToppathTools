/**
 * Agent 指紋對不上時，要講得出「是哪幾個檔案」。
 *
 *   node scripts/ui-checks/agent-source-diff.mjs
 *
 * 為什麼要有這支（2026-09-16 使用者實際卡住）：
 * 畫面顯示「目前版本 v4.151.1 · 7e8701db／目標版本 v4.151.1 · c0d168cb ─ 需要更新程式碼」。
 * 版本號一樣、指紋不一樣，而**兩邊都只給一個總指紋**——所以使用者除了反覆按更新
 * 之外沒有任何事情可以做，按了也不會知道為什麼還是不一致。
 *
 * 現在 agent 會逐檔比對 manifest 的 perFile 並回報差異清單。
 * 這支釘住三件事：
 *   1. perFile 真的有出現在 manifest 裡（agent 要靠它比對）
 *   2. 每個檔案的 hash 算法兩邊一致（normalizeSource + hashOne）
 *   3. **「沒有差異」跟「這台 agent 還不會回報」不可以混成同一種顯示**
 */
import { readFileSync } from 'node:fs'
import { hashOne, normalizeSource, compareAgentSources } from '../../dist-server/server/agent-source-hash.js'

const BASE = process.env.UAT_BASE || 'http://127.0.0.1:3000'
let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}
const ok = (name, cond, detail) => eq(name + (detail ? ' (' + detail + ')' : ''), !!cond, true)

const r = await fetch(BASE + '/api/machine-test/agent/source-manifest')
const mf = await r.json()

ok('manifest 有 files', Array.isArray(mf.files) && mf.files.length > 0, String(mf.files?.length))
ok('manifest 有 perFile（agent 要靠它逐檔比對）',
  !!mf.perFile && Object.keys(mf.perFile).length === mf.files.length,
  Object.keys(mf.perFile || {}).length + ' / ' + mf.files?.length)
ok('manifest 有總指紋', typeof mf.expectedAll === 'string' && mf.expectedAll.length > 0)

// 用同一套算法自己重算，確認「agent 端算出來的」會跟 server 對得上
// （這兩邊各寫一份的話，指紋就會永遠對不上而且沒人知道為什麼）
const recomputed = {}
for (const rel of mf.files) {
  let content = ''
  try { content = readFileSync('server/' + rel, 'utf8') } catch { content = '' }
  recomputed[rel] = hashOne(content)
}
const mismatched = mf.files.filter(f => recomputed[f] !== mf.perFile[f])
// ⚠️ machine-test/runner.ts 是例外：server 會改寫它的 gemini import 才送出去，
//    所以直接讀原始檔算出來本來就會不一樣。這正是「指紋要對實際 serve 出去的
//    內容算」那條規則的由來，不是 bug。
eq('除了會被改寫的 runner.ts 之外，逐檔 hash 兩邊一致',
  mismatched, ['machine-test/runner.ts'])

// normalizeSource 的對稱性：換行寫法不同不應該造成差異
eq('CRLF 與 LF 算出同一個 hash', hashOne('a\r\nb\r\n'), hashOne('a\nb\n'))
eq('檔尾多幾個換行也算同一個', hashOne('a\nb\n\n\n'), hashOne('a\nb\n'))
ok('normalizeSource 會把 CRLF 收成 LF', !normalizeSource('x\r\ny').includes('\r'))

// ⚠️ 三態不可以被壓成兩態
eq('舊 agent（沒回報指紋）是 unknown，不是 current',
  compareAgentSources({ expectedAll: 'a', expectedRestartScoped: 'b' }), 'unknown')
eq('檔案落後 → needs_update',
  compareAgentSources({ expectedAll: 'a', expectedRestartScoped: 'b', agentAll: 'x', agentRestartScopedAtBoot: 'b' }), 'needs_update')
eq('檔案最新但跑的是舊的 → needs_restart',
  compareAgentSources({ expectedAll: 'a', expectedRestartScoped: 'b', agentAll: 'a', agentRestartScopedAtBoot: 'old' }), 'needs_restart')

// 畫面上「沒有差異」與「不會回報」必須分得開
const page = readFileSync('src/pages/LocalAgentPage.tsx', 'utf8')
ok('畫面有處理 sourceDiff', /sourceDiff/.test(page))
ok('而且把 null（不會回報）跟空陣列（沒有差異）分開',
  /sourceDiff == null/.test(page), '沒有分開的話，舊 agent 會被顯示成「沒有差異」')

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }

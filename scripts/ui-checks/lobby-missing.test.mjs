// 大廳找不到機台：分原因（v5.55.0／5.56.1，osm-qa-agent spec #8，CodeX：完整清單缺席只能說「未提供，疑似未開放」、Test 要後台證據、沒查到盒子狀態不等於 offline）
//   node scripts/ui-checks/lobby-missing.test.mjs
// 使用者 1013：Sheet 不要出現中文；F 欄只新增 test machine，「不是 Test 卻不在大廳」照舊 offline、原因只寫在訊息
// 用真的後台 EGM List 項目（fixtures/egm-list，0239，istest 0、online、maintain）＋改單一欄位造出各情境；F 欄走真的 shortLine
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lobbyMissingReason, judgeMachineInfo, judge, shortLine } from '../machine-test/machine-test-batch.mjs'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'egm-list', '873-LIONLINK-0239.json')
const item = JSON.parse(fs.readFileSync(FIX, 'utf8')).item
let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c ? '：' + JSON.stringify(got) : ''}`) }
const row = (box, complete = true) => { const r = judgeMachineInfo('873-LIONLINK-0239', box, null, {}).row; r.boxListComplete = complete; return r }
/** 一台只有進場失敗（大廳找不到）＋原因的結果 → F 欄 */
const F = (reason) => {
  const result = { overall: 'fail', steps: [{ step: '進入機台', status: 'fail', message: `大廳找不到機台代碼: 873-LIONLINK-0239 | reason: ${reason}` }] }
  return shortLine(result, judge(result, ['entry']), null, ['entry'])
}

let s = lobbyMissingReason(row({ ...item, istest: 1, onlineState: 'online' }))
ok(/^set to Test in the OSM back office \(EGM List istest=1, pre-test check\), not offline/.test(s), 'istest=1 → set to Test（不是離線）', s)
ok(F(s) === 'test machine', 'F 欄 → test machine', F(s))
s = lobbyMissingReason(row({ ...item, onlineState: 'online' }))
ok(/^not offered by the lobby, possibly not opened/.test(s) && /isShowClient=1, isUsed=1, machineStatus=maintain, istest=0/.test(s), '真的 0239（istest 0、online、maintain）→ not offered, possibly not opened＋列出 isShowClient／isUsed／machineStatus', s)
ok(F(s) === 'offline', '⚠️ 使用者 1013：不是 Test 卻不在大廳 → F 照舊 offline（不加新詞，原因只在訊息）', F(s))
s = lobbyMissingReason(row({ ...item, onlineState: 'offline' }))
ok(/^box offline/.test(s) && F(s) === 'offline', '盒子離線 → offline', [s, F(s)])
s = lobbyMissingReason(row(null, false))
ok(/^cause unknown/.test(s) && F(s) === 'offline', '⚠️ 後台清單不完整、沒有這台 → cause unknown（F 照舊 offline）', [s, F(s)])
ok(/list complete/.test(lobbyMissingReason(row(null, true))), '後台清單完整、也沒有這台 → not in the back-office EGM List either')
ok(/^cause unknown/.test(lobbyMissingReason(null)), '沒有測前資料 → cause unknown')
ok(/^not offered/.test(lobbyMissingReason(row({ ...item, istest: '0', onlineState: 'online' }))), "istest 是字串 '0' → 不算 Test")
// 使用者：不要顯示中文——原因那段（會進 Lark）不能有中文
const reasons = [row({ ...item, istest: 1, onlineState: 'online' }), row({ ...item, onlineState: 'online' }), row({ ...item, onlineState: 'offline' }), row(null, true), row(null, false), null].map(lobbyMissingReason)
const CJK = /[㐀-鿿＀-￯]/   // 中日韓漢字＋全形標點
ok(reasons.every(x => !CJK.test(x)), '⚠️ 每一種原因都沒有中文（使用者：不要顯示中文）', reasons.filter(x => CJK.test(x)))
ok(F('x') === 'offline', '對照：沒有分到原因的大廳找不到 → 照舊 offline')
console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)

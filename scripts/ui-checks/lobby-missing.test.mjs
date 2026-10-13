// 大廳找不到機台：分原因（v5.54.0，osm-qa-agent spec #8，CodeX：完整清單缺席只能說「未提供，疑似未開放」、Test 要後台證據、沒查到盒子狀態不等於 offline）
//   node scripts/ui-checks/lobby-missing.test.mjs
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
  const result = { overall: 'fail', steps: [{ step: '進入機台', status: 'fail', message: `大廳找不到機台代碼: 873-LIONLINK-0239｜原因：${reason}` }] }
  return shortLine(result, judge(result, ['entry']), null, ['entry'])
}

let s = lobbyMissingReason(row({ ...item, istest: 1, onlineState: 'online' }))
ok(/^OSM 後台設成 Test（EGM List istest=1/.test(s), 'istest=1 → 後台設成 Test（不是離線）', s)
ok(F(s) === 'test machine', 'F 欄 → test machine', F(s))
s = lobbyMissingReason(row({ ...item, onlineState: 'online' }))
ok(/^大廳未提供這台，疑似未開放/.test(s) && /isShowClient=1、isUsed=1、machineStatus=maintain、istest=0/.test(s), '真的 0239（istest 0、online、maintain）→ 未提供，疑似未開放，列出 isShowClient／isUsed／machineStatus（不叫大家都去查 Test）', s)
ok(F(s) === 'not offered', 'F 欄 → not offered', F(s))
s = lobbyMissingReason(row({ ...item, onlineState: 'offline' }))
ok(/^盒子 offline/.test(s) && F(s) === 'offline', '盒子離線 → offline', [s, F(s)])
s = lobbyMissingReason(row(null, false))
ok(/無法確認/.test(s) && F(s) === 'offline', '⚠️ 後台清單不完整、沒有這台 → 原因寫「無法確認」（F 照舊 offline，不改寫）', [s, F(s)])
ok(/清單完整/.test(lobbyMissingReason(row(null, true))), '後台清單完整、也沒有這台 → 寫「後台也沒有」')
ok(/無法確認/.test(lobbyMissingReason(null)), '沒有測前資料 → 無法確認')
ok(/^大廳未提供這台/.test(lobbyMissingReason(row({ ...item, istest: '0', onlineState: 'online' }))), "istest 是字串 '0' → 不算 Test")
ok(F('x') === 'offline', '對照：沒有分到原因的大廳找不到 → 照舊 offline')
console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)

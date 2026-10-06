// 退出異常處理手冊（1003）：WS 停在哪一步、手冊比對、危險動作一律不套
// cd C:\machine-test-agent-claude && npx tsx scripts/exit-playbook-probe.ts
import { exitWsStage, matchExitPlaybook, type ExitPlaybookEntry } from '../server/machine-test/runner.ts'
let fail = 0
const ok = (name: string, cond: boolean, got?: unknown) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${got !== undefined ? `：${JSON.stringify(got)}` : ''}`); if (!cond) fail++ }

// 1572 實際的 WS（節錄）
const normal = [
  { dir: 'SEND', text: 'P!hall.hallHandler.getGmLockTimeReq{"gmid":"892-MONEYGONG-1572"}' },
  { dir: 'RECV', text: ':{"errcode":0,"errcodedes":"success","locktime":86400000}' },
  { dir: 'SEND', text: 'Ehall.hallHandler.leaveGMReq325599moneygong892-MONEYGONG-1572' },
  { dir: 'RECV', text: '5moneygong"892-MONEYGONG-1572)success' },
  { dir: 'RECV', text: '@oleaveGMNtc"moneygong*892-MONEYGONG-15721pn<fB9' },
]
ok('正常離機 → ntc', exitWsStage(normal) === 'ntc')
ok('沒送 leaveGMReq → no-leave-req', exitWsStage(normal.slice(0, 2)) === 'no-leave-req')
ok('送了沒回 → req-no-resp', exitWsStage(normal.slice(0, 3)) === 'req-no-resp')
ok('回了沒 leaveGMNtc → resp-no-ntc', exitWsStage(normal.slice(0, 4)) === 'resp-no-ntc')
ok('leaveGMReq 之前的回應不算回應', exitWsStage([normal[1], normal[2]]) === 'req-no-resp')

const stuckTexts = ['Tips', 'Cash out credit:  2,003,084']
const pb: ExitPlaybookEntry[] = [
  { name: 'cashout 框按 Confirm 沒反應 → Cancel 重來', match: { text: 'Cash ?out credit', wsStage: 'no-leave-req' }, action: { type: 'click-text', text: 'Cancel' } },
]
ok('症狀相符 → 套用', matchExitPlaybook(pb, stuckTexts, 'no-leave-req')?.name === pb[0].name)
ok('WS 階段不同 → 不套', matchExitPlaybook(pb, stuckTexts, 'req-no-resp') === null)
ok('畫面文字不同 → 不套', matchExitPlaybook(pb, ['Want to reserve this machine?'], 'no-leave-req') === null)
ok('沒有手冊 → 不套', matchExitPlaybook([], stuckTexts, 'no-leave-req') === null)
// 危險動作：就算症狀相符也不套
for (const t of ['Spin', 'SPIN', 'Reserve Now', 'PLAY NOW', 'View', 'Top Up']) {
  ok(`禁止自動點「${t}」`, matchExitPlaybook([{ name: 'x', match: { text: 'Cash' }, action: { type: 'click-text', text: t } }], stuckTexts, 'no-leave-req') === null)
}
ok('什麼都不比對的條目不套（等於全套）', matchExitPlaybook([{ name: 'x', match: {}, action: { type: 'escape' } }], stuckTexts, 'no-leave-req') === null)
ok('不在白名單的動作類型不套', matchExitPlaybook([{ name: 'x', match: { text: 'Cash' }, action: { type: 'spin' as never } }], stuckTexts, 'no-leave-req') === null)
ok('壞掉的 regex 不套也不炸', matchExitPlaybook([{ name: 'x', match: { text: '([' }, action: { type: 'escape' } }], stuckTexts, 'no-leave-req') === null)
ok('只比 WS 階段也可以', matchExitPlaybook([{ name: 'w', match: { wsStage: 'req-no-resp' }, action: { type: 'wait', seconds: 30 } }], [], 'req-no-resp')?.name === 'w')

console.log(fail ? `\n${fail} 個案例失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)

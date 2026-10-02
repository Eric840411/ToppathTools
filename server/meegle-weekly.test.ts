/** 週報撈 Meegle：週期邊界與專案判斷。跑法：npx tsx server/meegle-weekly.test.ts */
import { createdDayVerdict, cronActorProblem, fetchMeegleWeek, parseMqlUtc, projectFromTitle, resolveCronActor, weekBounds } from './meegle-weekly.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
// 週期 2026-09-25（五）～ 2026-10-01（四），台北
const b = weekBounds('2026-09-25', '2026-10-01')
eq('精準起點＝台北 9/25 00:00＝UTC 9/24 16:00', new Date(b.fromMs).toISOString(), '2026-09-24T16:00:00.000Z')
eq('精準終點（不含）＝台北 10/2 00:00', new Date(b.toMs).toISOString(), '2026-10-01T16:00:00.000Z')
eq('查詢放寬：9/24 ～ 10/3（不含）', [b.qStart, b.qEnd], ['2026-09-24', '2026-10-03'])
eq('MQL 時間是 UTC', parseMqlUtc('2026-10-02 05:59:12'), Date.parse('2026-10-02T05:59:12Z'))
eq('更新在台北 10/1 23:59（UTC 15:59）→ 在週期內', (() => { const m = parseMqlUtc('2026-10-01 15:59:00')!; return m >= b.fromMs && m < b.toMs })(), true)
eq('更新在台北 10/2 00:01（UTC 10/1 16:01）→ 不在', (() => { const m = parseMqlUtc('2026-10-01 16:01:00')!; return m >= b.fromMs && m < b.toMs })(), false)
eq('建立 UTC 9/25 → 一定在', createdDayVerdict('2026-09-25', '2026-09-25', '2026-10-01'), 'in')
eq('建立 UTC 9/30 → 一定在', createdDayVerdict('2026-09-30', '2026-09-25', '2026-10-01'), 'in')
eq('建立 UTC 9/24 → 不一定（台北可能已是 9/25）', createdDayVerdict('2026-09-24', '2026-09-25', '2026-10-01'), 'maybe')
eq('建立 UTC 10/1 → 不一定（台北可能是 10/2）', createdDayVerdict('2026-10-01', '2026-09-25', '2026-10-01'), 'maybe')
eq('建立 UTC 10/2 → 一定不在', createdDayVerdict('2026-10-02', '2026-09-25', '2026-10-01'), 'out')
eq('建立 UTC 9/23 → 一定不在', createdDayVerdict('2026-09-23', '2026-09-25', '2026-10-01'), 'out')
eq('專案：標題第一個中括號', projectFromTitle('[OSM][OSM後台]所有弹窗Sure按钮修改为Confirm'), 'OSM')
eq('專案：沒有中括號 → 空', projectFromTitle('teee'), '')
eq('專案：前面有空白也可以', projectFromTitle('  [設計][百家樂]Super Speed'), '設計')

// CodeX review [P1]：排程授權人每次重查帳號存在、未停權、有週報權限
eq('授權人：正常', cronActorProblem({ email: 'a@t', status: 'active' }, true), null)
eq('授權人：帳號被刪', cronActorProblem(undefined, false), '授權人帳號不存在（可能已刪除）')
eq('授權人：停權（token 仍有效也不行）', cronActorProblem({ email: 'a@t', status: 'disabled' }, true), '授權人帳號已停權')
eq('授權人：沒有週報權限', cronActorProblem({ email: 'a@t', status: 'active' }, false), '授權人沒有「週報彙整」權限')

// 關卡整條：失效時不呼叫 Meegle（tokenOf 沒被叫）、不換人
const calls: string[] = []
const gate = (acc: { email: string; status?: string; role?: string } | undefined, perm: boolean) => resolveCronActor('a@t', {
  findAccount: () => acc, hasPermission: () => perm, tokenOf: e => { calls.push(e); return { token: 'T' } },
})
calls.length = 0; eq('關卡：停權 → 原因、沒有讀 token', [gate({ email: 'a@t', status: 'disabled' }, true), calls.length], [{ reason: '授權人帳號已停權（a@t）' }, 0])
calls.length = 0; eq('關卡：沒權限 → 沒有讀 token', [('reason' in gate({ email: 'a@t', status: 'active' }, false)), calls.length], [true, 0])
calls.length = 0; eq('關卡：都正常 → 只讀授權人自己的 token', [gate({ email: 'a@t', status: 'active' }, true), calls], [{ token: 'T' }, ['a@t']])
eq('關卡：綁定失效 → 原因', resolveCronActor('a@t', { findAccount: () => ({ email: 'a@t', status: 'active' }), hasPermission: () => true, tokenOf: () => ({ reason: '的 Meegle 綁定已失效' }) }), { reason: '授權人 a@t 的 Meegle 綁定已失效' })

// CodeX review [P2]：邊界單讀得到卻沒有建立時間 → 整批報錯、講是哪張，不默默排除
const out = (o: unknown) => ({ exitCode: 0, stdout: JSON.stringify(o), stderr: '', timedOut: false })
const mqlRow = { moql_field_list: [
  { key: 'work_item_id', value: { long_value: 15190441 } }, { key: 'name', value: { string_value: '[OSM]邊界單' } },
  { key: 'start_time', value: { string_value: '2026-10-01' } }, { key: 'updated_at', value: { string_value: '2026-10-05 01:00:00' } },
] }
const fakeRunner = (createTime: unknown) => async (args: string[]) => args[1] === 'query'
  ? out({ data: { '1': [mqlRow] }, list: [{ count: 1, group_infos: [{ group_id: '1' }] }], session_id: 's' })
  : out({ work_item_attribute: createTime === undefined ? {} : { create_time: createTime } })
const who = { userKey: 'u1', name: 'Eric' }
const r1 = await fetchMeegleWeek('tok', who, '2026-09-25', '2026-10-01', fakeRunner(undefined) as never)
eq('邊界單沒有 create_time → 整批 unknown、訊息有單號', [r1.kind, 'message' in r1 && /#15190441/.test(r1.message)], ['unknown', true])
const r2 = await fetchMeegleWeek('tok', who, '2026-09-25', '2026-10-01', fakeRunner('不是時間') as never)
eq('邊界單 create_time 看不懂 → 整批 unknown', r2.kind, 'unknown')
const r3 = await fetchMeegleWeek('tok', who, '2026-09-25', '2026-10-01', fakeRunner('2026-10-01T10:00:00Z') as never)
eq('邊界單建立在週期內（台北 10/1 18:00）→ 收進來', r3.kind === 'ok' && r3.value.map(i => i.key), ['#15190441'])
const r4 = await fetchMeegleWeek('tok', who, '2026-09-25', '2026-10-01', fakeRunner('2026-10-01T17:00:00Z') as never)
eq('邊界單建立在週期外（台北 10/2 01:00）→ 不收', r4.kind === 'ok' && r4.value.length, 0)
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

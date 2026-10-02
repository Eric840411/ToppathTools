/**
 * Meegle「任務項」開單層的測試。跑法：npx tsx server/meegle-workitem.test.ts
 *
 * 全部用假 runner 餵 2026-10-01 實測錄下來的 CLI 輸出，不連網路、不開真單。
 * 重點守的是「會開出重複單」與「靜默丟資料」那幾條：
 * - 外層 retryable:true 但 server 說 retriable=false → 一定要判成 rejected 以外的東西時才能擋重送
 * - 建單逾時 → unknown，不能是 rejected（rejected 代表可以安全重送）
 * - MQL 第 2 頁之後沒有 session_id／count，不能因此停在第 2 頁
 */
import {
  buildCreateFields, clearDetailUrlCache, createTask, detailUrlFor, findUserViaParticipants, interpretCli, listRequirements, mqlString, pickUserByEmail,
  planTransition, queryAll, resolveRoleIds, resolveUsersByEmail, transitionToState, type Runner,
} from './meegle-workitem.js'
import { pickRequirement } from '../shared/meegle-batch-rules.js'
import type { CliResult } from './meegle-cli.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const out = (stdout: string, timedOut = false): CliResult => ({ exitCode: 0, stdout, stderr: '', timedOut })
const ENV = {} as NodeJS.ProcessEnv

// ── interpretCli ──
const userNotFound = '{"data":null,"error":{"code":"SERVER_CALL_FAILED","message":"error=ErrnoCannotFindUserInfo,message=Can not find user info,retriable=false\\nlogid: 2026","retryable":true},"meta":{}}'
eq('外層 retryable:true 但 server retriable=false → rejected', interpretCli(out(userNotFound)).kind, 'rejected')
eq('錯誤印在 stderr、stdout 空、結束碼 1（實測的真實形狀）→ 仍判得出 rejected', interpretCli({ exitCode: 1, stdout: '', stderr: userNotFound, timedOut: false }).kind, 'rejected')
eq('rejected 訊息去掉 logid', (interpretCli(out(userNotFound)) as { message: string }).message.includes('logid'), false)
eq('沒有 retriable=false 的錯誤 → unknown（寧可擋重送）', interpretCli(out('{"data":null,"error":{"code":"X","message":"gateway timeout","retryable":true}}')).kind, 'unknown')
eq('逾時 → unknown', interpretCli(out('', true)).kind, 'unknown')
eq('看不懂的輸出 → unknown，不是 ok', interpretCli(out('panic: something')).kind, 'unknown')
eq('轉狀態成功印 "success" → ok', interpretCli(out('"success"')), { kind: 'ok', value: 'success' })

// ── 人員 ──
const eric = { email: 'eric.wu@toppath.tw', name_cn: 'Eric', name_en: 'Eric', status: 'activated', user_key: '7399589791446188037' }
eq('email 不分大小寫對到', pickUserByEmail('Eric.Wu@Toppath.tw', [eric]), { ok: true, userKey: '7399589791446188037', email: 'eric.wu@toppath.tw', name: 'Eric' })
eq('查不到 → NOT_FOUND（實測 Tim）', (pickUserByEmail('tim@toppath.tw', []) as { reason: string }).reason, 'NOT_FOUND')
eq('名字不是 email → NO_EMAIL，不拿去模糊搜', (pickUserByEmail('Tim', [eric]) as { reason: string }).reason, 'NO_EMAIL')
eq('搜尋結果有別人（模糊命中）但 email 不同 → NOT_FOUND', (pickUserByEmail('eric@toppath.tw', [eric]) as { reason: string }).reason, 'NOT_FOUND')
eq('同 email 兩筆 → MULTIPLE', (pickUserByEmail('eric.wu@toppath.tw', [eric, { ...eric, user_key: '2' }]) as { reason: string }).reason, 'MULTIPLE')
eq('停用帳號 → INACTIVE', (pickUserByEmail('eric.wu@toppath.tw', [{ ...eric, status: 'deactivated' }]) as { reason: string }).reason, 'INACTIVE')

{
  const calls: string[][] = []
  const runner: Runner = async (args) => { calls.push(args); return out(JSON.stringify([eric])) }
  const emails = Array.from({ length: 25 }, (_, i) => `u${i}@x.tw`)
  const r = await resolveUsersByEmail('t', [...emails, 'U0@x.tw'], runner)
  eq('25 個 email 分兩批查（每批上限 20），重複的不重查', calls.length, 2)
  eq('每個 email 都有結果，不會靜默少掉', r.kind === 'ok' ? Object.keys(r.value).length : -1, 25)
  const fail = await resolveUsersByEmail('t', ['a@x.tw'], async () => out('', true))
  eq('查詢本身逾時 → 整批 unknown，不能變成「查不到」', fail.kind, 'unknown')
}

// ── MQL 翻頁（第 2 頁之後沒有 session_id／list，實測 Master 空間）──
{
  const row = (id: number) => ({ moql_field_list: [{ key: 'work_item_id', value: { long_value: id } }, { key: 'name', value: { string_value: `n${id}` } }] })
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(from + i))
  const calls: string[][] = []
  const runner: Runner = async (args) => {
    calls.push(args)
    if (!args.includes('--session-id')) return out(JSON.stringify({ data: { 1: page(1, 50) }, list: [{ count: 120, group_infos: [{ group_id: '1' }] }], session_id: 'S' }))
    const pageNum = JSON.parse(args[args.indexOf('--group-pagination-list') + 1])[0].page_num
    return out(JSON.stringify({ data: { 1: page((pageNum - 1) * 50 + 1, pageNum === 3 ? 20 : 50) }, list: null, session_id: null }))
  }
  const r = await queryAll('t', 'P', 'SELECT', runner)
  eq('120 筆翻 3 頁全部讀到', r.kind === 'ok' ? r.value.length : -1, 120)
  eq('翻頁用第一頁的 session_id', calls[2]?.[calls[2].indexOf('--session-id') + 1], 'S')

  const stuck: Runner = async (args) => args.includes('--session-id')
    ? out(JSON.stringify({ data: { 1: [] } }))
    : out(JSON.stringify({ data: { 1: page(1, 50) }, list: [{ count: 120, group_infos: [{ group_id: '1' }] }], session_id: 'S' }))
  eq('翻頁拿到空頁 → unknown，不能回傳 50 筆假裝讀完', (await queryAll('t', 'P', 'SELECT', stuck)).kind, 'unknown')
  const noSession: Runner = async () => out(JSON.stringify({ data: { 1: page(1, 50) }, list: [{ count: 120, group_infos: [{ group_id: '1' }] }] }))
  eq('沒有翻頁資訊 → unknown', (await queryAll('t', 'P', 'SELECT', noSession)).kind, 'unknown')
}

// ── 關聯需求 ──
const reqs = [{ id: '15170734', name: '系统维护' }, { id: '15171668', name: 'Rust Server' }, { id: '15183436', name: 'OSM' }]
eq('名稱精確對到', pickRequirement(' rust server ', reqs), { ok: true, requirement: { id: '15171668', name: 'Rust Server' } })
eq('只是包含不算（OSM ≠ OSM 2.0）', (pickRequirement('OSM 2.0', reqs) as { reason: string }).reason, 'NOT_FOUND')
eq('填需求 ID 也可以（同名多筆時的解法）', pickRequirement('#15183436', reqs).ok, true)
eq('同名多筆 → MULTIPLE 並列出候選', pickRequirement('OSM', [...reqs, { id: '9', name: 'osm' }]).ok === false
  && (pickRequirement('OSM', [...reqs, { id: '9', name: 'osm' }]) as { candidates: unknown[] }).candidates.length, 2)
eq('空白 → EMPTY（由呼叫端決定用預設，不在這裡偷偷補）', (pickRequirement('  ', reqs) as { reason: string }).reason, 'EMPTY')
{
  const r = await listRequirements('t', async () => out(JSON.stringify({
    data: { 1: [{ moql_field_list: [{ key: 'work_item_id', value: { long_value: 15170734 } }, { key: 'name', value: { string_value: '系统维护' } }] }] },
    list: [{ count: 1, group_infos: [{ group_id: '1' }] }], session_id: 'S',
  })), ENV)
  eq('需求清單解析', r, { kind: 'ok', value: [{ id: '15170734', name: '系统维护' }] })
}
eq('MQL 字串跳脫單引號', mqlString("it's"), "'it\\'s'")

// ── 角色 ──
const rolesOut = JSON.stringify({ list: [
  { role_id: 'role_b2bf14', role_name: '受托人' }, { role_id: 'role_a288f6', role_name: 'RD 負責人' },
  { role_id: 'role_e18f13', role_name: '回報者' }, { role_id: 'role_d2a2b6', role_name: 'Code Review 人員' },
  { role_id: 'role_037ecd', role_name: 'QA 驗證人員' },
] })
const roleIds = { assignee: 'role_b2bf14', rdOwner: 'role_a288f6', reporter: 'role_e18f13', codeReview: 'role_d2a2b6', qaVerifier: 'role_037ecd' }
eq('5 個角色都對到', await resolveRoleIds('t', async () => out(rolesOut), ENV), { kind: 'ok', value: roleIds })
eq('少一個角色 → rejected（設定被改過就整批不開）', (await resolveRoleIds('t', async () => out(JSON.stringify({ list: [{ role_id: 'r', role_name: '受托人' }] })), ENV)).kind, 'rejected')

// ── 建單內容 ──
{
  const fields = buildCreateFields({ name: 'A', description: '', requirementId: '15170734', roles: { reporter: ['u1'], rdOwner: ['u2', 'u3'], assignee: [] } }, roleIds, ENV)
  eq('所有 field_value 都是字串（數字會被 Meegle 擋）', fields.every(f => typeof f.field_value === 'string'), true)
  eq('關聯需求帶進去', fields.find(f => f.field_key === 'field_eab776')?.field_value, '15170734')
  eq('空描述不送', fields.some(f => f.field_key === 'description'), false)
  eq('role_owners 只帶有人的角色、順序固定', JSON.parse(fields.find(f => f.field_key === 'role_owners')!.field_value),
    [{ role: 'role_a288f6', owners: ['u2', 'u3'] }, { role: 'role_e18f13', owners: ['u1'] }])
}
{
  const ok = await createTask('t', { name: 'A', requirementId: '1', roles: {} }, roleIds, async () => out('{"url":"https://x/15190441","work_item_id":15190441}'), ENV)
  eq('建單成功拿到單號', ok, { kind: 'ok', value: { workItemId: '15190441', url: 'https://x/15190441' } })
  eq('建單逾時 → unknown（不可重送）', (await createTask('t', { name: 'A', requirementId: '1', roles: {} }, roleIds, async () => out('', true), ENV)).kind, 'unknown')
  eq('人員無效 → rejected（整張沒建，可修正後重送）', (await createTask('t', { name: 'A', requirementId: '1', roles: {} }, roleIds, async () => out(userNotFound), ENV)).kind, 'rejected')
  eq('回應成功但沒單號 → unknown，不能當失敗', (await createTask('t', { name: 'A', requirementId: '1', roles: {} }, roleIds, async () => out('{"url":""}'), ENV)).kind, 'unknown')
}

// ── 單子網址：用空間 simple_name／類型 api_name，不用 CLI 回的 project_key/type_key（2026-10-02 使用者實測點不開）──
{
  // 實測回應（project search／workitem meta-types，TP-項目管理-測試）
  const projectOut = JSON.stringify({ pagination: { total: 1 }, projects: [{ name: 'TP-項目管理-測試', project_key: '6abb348976c120f4f43c746a', simple_name: '3kvkm7' }] })
  const typesOut = JSON.stringify({ list: [{ api_name: 'story', type_key: 'story' }, { api_name: 'task_normal', name: '任務項', type_key: '6abd3a436ef2d2a4b44051d8' }] })
  let calls = 0
  const runner: Runner = async args => { calls++; return out(args[0] === 'project' ? projectOut : typesOut) }
  clearDetailUrlCache()
  eq('網址＝simple_name／api_name（不是 project_key／type_key）', await detailUrlFor('t', '15194994', runner, ENV), 'https://project.larksuite.com/3kvkm7/task_normal/detail/15194994')
  const before = calls
  eq('第二張單用快取', await detailUrlFor('t', '15194995', runner, ENV), 'https://project.larksuite.com/3kvkm7/task_normal/detail/15194995')
  eq('快取命中不再打 CLI', calls, before)

  clearDetailUrlCache()
  const noType: Runner = async args => out(args[0] === 'project' ? projectOut : JSON.stringify({ list: [{ api_name: 'story', type_key: 'story' }] }))
  eq('查不到類型 → 空字串，不退回壞網址', await detailUrlFor('t', '1', noType, ENV), '')
  clearDetailUrlCache()
  const noProj: Runner = async args => out(args[0] === 'project' ? JSON.stringify({ projects: [{ project_key: 'other', simple_name: 'zz' }] }) : typesOut)
  eq('查不到空間（只有別的空間）→ 空字串', await detailUrlFor('t', '1', noProj, ENV), '')
  clearDetailUrlCache()
  eq('CLI 逾時 → 空字串', await detailUrlFor('t', '1', async () => out('', true), ENV), '')
  eq('失敗不進快取：之後查得到就用對的', await detailUrlFor('t', '7', runner, ENV), 'https://project.larksuite.com/3kvkm7/task_normal/detail/7')
}

// ── 狀態（id 取自實測：從「待辦事項」出發）──
const fromTodo = { state_key: 'Not started', state_name: '待辦事項', transition: [
  { id: 3238336, state_key: 'In Progress', state_name: '開發中', confirm_form: null }, { id: 3238341, state_key: 'BAOjDk8Pv', state_name: '可本機測試', confirm_form: null },
  { id: 3238337, state_key: 'Finished', state_name: '完成', confirm_form: null },
] }
eq('用 state_key 找 transition id', planTransition('BAOjDk8Pv', fromTodo), { action: 'go', transitionId: '3238341', current: '待辦事項' })
eq('已經是目標狀態 → 不動', planTransition('Not started', fromTodo), { action: 'none', current: '待辦事項' })
eq('state_key 不存在 → blocked', planTransition('nope', fromTodo).action, 'blocked')
eq('不拿名稱比對（傳名稱進來對不到）', planTransition('可本機測試', fromTodo).action, 'blocked')
eq('需要表單的轉換不自動做', planTransition('Finished', { ...fromTodo, transition: [{ id: 1, state_key: 'Finished', state_name: '完成', confirm_form: { x: 1 } }] }).action, 'blocked')
{
  const calls: string[][] = []
  const runner: Runner = async (args) => { calls.push(args); return args[1] === 'list-state-transitions' ? out(JSON.stringify(fromTodo)) : out('"success"') }
  const r = await transitionToState('t', '15190441', 'BAOjDk8Pv', runner, ENV)
  eq('推狀態成功', r, { kind: 'ok', value: { from: '待辦事項', changed: true } })
  eq('每次都先即時查 transition，不沿用固定 id', calls.map(c => c[1]), ['list-state-transitions', 'transition-state'])
  eq('送出的是查到的 id', calls[1][calls[1].indexOf('--transition-id') + 1], '3238341')
  const weird = await transitionToState('t', '1', 'BAOjDk8Pv', async (a) => a[1] === 'list-state-transitions' ? out(JSON.stringify(fromTodo)) : out('{"foo":1}'), ENV)
  eq('轉換回應不是 success → unknown', weird.kind, 'unknown')
}

// ── 人員退路：從既有單子的參與人找（實測 Tim）──
{
  const tim = { email: 'tim@toppath.tw', name_cn: 'Tim', name_en: 'Tim', user_key: '7392032137467281414' }
  const runner: Runner = async (args) => {
    const mql = args[args.indexOf('--mql') + 1]
    if (mql.includes("'Tim'")) return out(JSON.stringify({ data: { 1: [{ moql_field_list: [{ key: '__受托人', value: { user_value_list: [tim] } }, { key: '__回報者', value: { user_value_list: [tim] } }] }] } }))
    return out('{"data":null,"error":{"message":"error=ErrMetadataError,message=attribute value not found (Code: 3011) | user does not exist,retriable=false"}}')
  }
  const r = await findUserViaParticipants('t', 'tim@toppath.tw', ['tim', 'Tim'], runner, ENV)
  eq('名稱不存在(3011)換下一個候選，最後用 email 對到；同一人出現兩次不算多筆', r.kind === 'ok' && r.value.ok ? r.value.userKey : r, '7392032137467281414')
  const wrong = await findUserViaParticipants('t', 'tim2@toppath.tw', ['Tim'], runner, ENV)
  eq('名字對到但 email 不同 → 不認', wrong.kind === 'ok' && wrong.value.ok, false)
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

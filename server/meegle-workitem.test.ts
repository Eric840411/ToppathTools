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
  buildCreateFields, clearDetailUrlCache, createTask, detailUrlFor, bulkVerdict, checkDirectoryLabel, findUserViaParticipants, interpretCli, listRequirements, listSpaceRoster, parseSameLabelIds, searchUserKey, mqlString, pickUserByEmail,
  planTransition, queryAll, resolveRoleIds, resolveUsersByEmail, transitionToState, loadCreateMeta, interpretCreateMeta, type Runner,
} from './meegle-workitem.js'
import { pickRequirement } from '../shared/meegle-batch-rules.js'
import type { CliResult } from './meegle-cli.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ── 空間人員名單＋租戶名錄同名檢查（2026-10-05 真 CLI 實測的形狀）──
{
  const role = (key: string, users: object[]) => ({ key, value: { user_value_list: users } })
  const tim = { email: 'tim@toppath.tw', name_cn: 'Tim', name_en: 'Tim', user_key: 'k-tim' }
  const amy = { email: 'amy@toppath.tw', name_cn: 'Amy', name_en: 'Amy', user_key: 'k-amy' }
  const ghost = { name_cn: 'Ghost', name_en: 'Ghost', user_key: 'k-ghost' }
  const head = { data: { 1: [{ moql_field_list: [role('__受托人', [tim]), role('__回報者', [amy, tim])] }] }, list: [{ count: 2, group_infos: [{ group_id: 'g' }] }], session_id: 's' }
  const p2 = { data: { 1: [{ moql_field_list: [role('__QA 驗證人員', [ghost])] }] } }
  const runner: Runner = async (args) => out(JSON.stringify(args.includes('--session-id') ? p2 : head))
  const r = await listSpaceRoster('t', runner, ENV)
  eq('名單＝各角色出現過的人、依 user_key 去重、翻到第 2 頁', r.kind === 'ok' ? r.value.map(u => u.userKey) : r, ['k-amy', 'k-ghost', 'k-tim'])
  eq('沒 email 的人留著（email 空字串），同名時才算得到人數', r.kind === 'ok' ? r.value.find(u => u.userKey === 'k-ghost')?.email : r, '')
  const half: Runner = async (args) => args.includes('--session-id') ? out('', true) : out(JSON.stringify(head))
  eq('掃到一半失敗 → 整份 unknown，不能拿半份名單當完整的', (await listSpaceRoster('t', half, ENV)).kind, 'unknown')

  const msg3012 = "error=ErrMetadataError,message=metadata error,attribute value not unique (Code: 3012) | Context: user 'Eric' is not unique. matches 2 items with the same label: 'Eric<id:7399589791446188037>', 'Eric<id:7612517114682871515>'. pick one, or combine several with IN,retriable=false"
  eq('3012 訊息解析出所有同名 user_key', parseSameLabelIds(msg3012), ['7399589791446188037', '7612517114682871515'])
  const dir = (stdout: string): Runner => async () => out(stdout)
  const multi = await checkDirectoryLabel('t', 'Eric', dir(JSON.stringify({ data: null, error: { message: msg3012 } })), ENV)
  eq('租戶名錄同名（Eric 兩個帳號）→ multiple', multi.kind === 'ok' ? multi.value : multi, { kind: 'multiple', count: 2 })
  const missing = await checkDirectoryLabel('t', 'X', dir('{"data":null,"error":{"message":"attribute value not found (Code: 3011) | user does not exist,retriable=false"}}'), ENV)
  eq('3011 → missing（呼叫端不能當成唯一放行）', missing.kind === 'ok' ? missing.value.kind : missing, 'missing')
  eq('查詢逾時 → unknown，不是 unique', (await checkDirectoryLabel('t', 'Tim', async () => out('', true), ENV)).kind, 'unknown')
  const uniq = await checkDirectoryLabel('t', 'Tim', dir(JSON.stringify(head)), ENV)
  eq('查得到 → unique', uniq.kind === 'ok' ? uniq.value.kind : uniq, 'unique')

  const ok = (v: object) => ({ kind: 'ok' as const, value: v as never })
  eq('全部確認：每個名稱都唯一 → 放行', bulkVerdict([{ label: 'Tim', result: ok({ kind: 'unique' }) }]).ok, true)
  eq('全部確認：同名 → 不放行', bulkVerdict([{ label: 'Eric', result: ok({ kind: 'multiple', count: 2 }) }]).ok, false)
  eq('全部確認：3011 名錄查不到 → 不放行（不是「沒回 3012 就好」）', bulkVerdict([{ label: 'X', result: ok({ kind: 'missing' }) }]).ok, false)
  eq('全部確認：查詢逾時 → 不放行', bulkVerdict([{ label: 'Tim', result: { kind: 'unknown', message: '逾時' } }]).ok, false)
  eq('全部確認：第二個名稱同名 → 不放行', bulkVerdict([{ label: 'Tim', result: ok({ kind: 'unique' }) }, { label: '提姆', result: ok({ kind: 'multiple', count: 2 }) }]).ok, false)
  eq('全部確認：一個都沒查 → 不放行', bulkVerdict([]).ok, false)
}

// ── user search 要重複旗標（`--user-keys a b` 實測只查第一個）──
{
  const calls: string[][] = []
  await resolveUsersByEmail('t', ['a@x.tw', 'b@x.tw'], async (args) => { calls.push(args); return out('[]') })
  eq('每個 email 前面都有 --user-keys', calls[0].filter(a => a === '--user-keys').length, 2)
  const u = { email: 'tim@toppath.tw', name_cn: 'Tim', user_key: 'k-tim', status: 'activated' }
  const found = await searchUserKey('t', 'k-tim', async () => out(JSON.stringify([u])))
  eq('用 user_key 查得到', found.kind === 'ok' ? found.value : found, { userKey: 'k-tim', email: 'tim@toppath.tw', name: 'Tim' })
  const none = await searchUserKey('t', 'k-tim', async () => out('[]'))
  eq('user search 查不到 → null（不是錯誤）', none.kind === 'ok' ? none.value : none, null)
  const off = await searchUserKey('t', 'k-tim', async () => out(JSON.stringify([{ ...u, status: 'deactivated' }])))
  eq('停用帳號 → null，不能選', off.kind === 'ok' ? off.value : off, null)
}

// ── 建立必填（2026-10-06 任務類型）：fixture 是兩個空間當天實際的 CLI 回應 ─────────────
{
  const fx = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'meegle', f), 'utf8')
  const space = (s: 'test' | 'prod') => ({
    mcf: fx(`meta-create-fields.${s}-space.20261006.json`), mf: fx(`meta-fields.${s}-space.20261006.json`), tt: fx(`meta-fields-tasktype.${s}-space.20261006.json`),
  })
  const fake = (d: { mcf: string; mf: string; tt: string }): Runner => async (args) =>
    out(args[1] === 'meta-create-fields' ? d.mcf : args.includes('--field-keys') ? d.tt : d.mf)
  for (const [s, key, bugId] of [['test', 'field_ef5b10', '97y2igrb3'], ['prod', 'field_ee72d7', 'h_mb402w7']] as const) {
    const m = await loadCreateMeta('t', fake(space(s)), ENV)
    eq(`${s}：任務類型用名稱找到該空間的 key、必填、選項含 BUG 的 id`,
      m.kind === 'ok' ? [m.value.taskType?.fieldKey, m.value.taskType?.required, m.value.taskType?.options.find(o => o.name === 'BUG')?.id, m.value.unknownRequired] : m,
      [key, true, bugId, []])
  }
  // CodeX：template 是已驗證例外；其他工具不認得的必填 → 列欄名（不靠 default_appear 猜）
  const conf = JSON.parse(space('test').mcf).FieldConfList
  const all = JSON.parse(space('test').mf).list
  const opts = JSON.parse(space('test').tt).list[0].option
  const extra = [...conf, { field_key: 'field_new', field_name: '新必填', field_type_key: 'select', is_required: 1, default_value: { default_appear: 1 } }]
  const r1 = interpretCreateMeta(extra, all, opts, ENV)
  eq('預覽後多了一個必填（就算 default_appear=1）→ 列出來', typeof r1 === 'string' ? r1 : r1.unknownRequired, ['新必填（field_new）'])
  eq('template 必填但是已驗證例外 → 不列', typeof r1 === 'string' ? r1 : r1.unknownRequired.some(x => x.includes('template')), false)
  eq('同名「任務類型」兩個欄位 → 擋', typeof interpretCreateMeta(conf, [...all, { field_key: 'field_x', field_name: '任務類型', field_type: 'select' }], opts, ENV), 'string')
  eq('任務類型不是 select → 擋', typeof interpretCreateMeta(conf, all.map((f: { field_name: string }) => f.field_name === '任務類型' ? { ...f, field_type: 'text' } : f), opts, ENV), 'string')
  eq('選項名稱重複 → 擋', typeof interpretCreateMeta(conf, all, [...opts, { option_id: 'dup', option_name: 'bug' }], ENV), 'string')
  eq('必填但選項被刪光 → 擋', typeof interpretCreateMeta(conf, all, [], ENV), 'string')
  const opt = interpretCreateMeta(conf.map((c: { field_key: string }) => c.field_key === 'field_ef5b10' ? { ...c, is_required: 0 } : c), all, opts, ENV)
  eq('改回非必填 → required=false', typeof opt === 'string' ? opt : opt.taskType?.required, false)
  eq('空間沒有任務類型欄位 → taskType=null', (() => { const r = interpretCreateMeta(conf.filter((c: { field_key: string }) => c.field_key !== 'field_ef5b10'), all.filter((f: { field_name: string }) => f.field_name !== '任務類型'), null, ENV); return typeof r === 'string' ? r : r.taskType })(), null)
  const failed = await loadCreateMeta('t', async () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }), ENV)
  eq('metadata 讀取失敗 → 不是 ok（呼叫端整批擋）', failed.kind !== 'ok', true)
  // 送出的欄位：select 寫 option_id 字串
  const f = buildCreateFields({ name: 'n', requirementId: '1', roles: {}, taskType: { fieldKey: 'field_ee72d7', optionId: 'h_mb402w7' } }, {} as never, ENV)
  eq('開單欄位帶任務類型（該空間的 key＋option_id）', f.find(x => x.field_key === 'field_ee72d7')?.field_value, 'h_mb402w7')
  eq('沒有任務類型 → 只帶名稱與關聯需求', buildCreateFields({ name: 'n', requirementId: '1', roles: {} }, {} as never, ENV).map(x => x.field_key), ['name', 'field_eab776'])
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }

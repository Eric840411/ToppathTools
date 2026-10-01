/**
 * Meegle「任務項」的開單／查詢／推狀態。全部用呼叫者本人的 token（runMeegle 不准空 token）。
 *
 * ⚠️ 2026-10-01 用 CLI 1.0.23 實測出來的契約（不是讀文件推的）：
 * 1. `workitem create --fields` 的 field_value **一律要字串**；數字會被擋（MCPGatewayRequestMismatch），
 *    `role_owners` 要把 `[{role, owners:[user_key]}]` 先 JSON.stringify 再放進去。
 * 2. 5 個角色可以在建單那一次全部設好；**任一人員無效整張單不會建立**（ErrnoCannotFindUserInfo），
 *    所以沒有「單開了、角色沒補上」的半成品。
 * 3. 失敗時錯誤 JSON 在 **stderr**、結束碼 1，stdout 是空的。
 *    CLI 外層的 `error.retryable` 不可信：同一個錯誤 server 回 `retriable=false`，外層卻是 `true`。
 *    分類一律看 server 訊息裡的 `retriable=`，不看外層旗標。
 * 4. 狀態流的 transition id 會**隨目前狀態不同而不同**（待辦→可本機測試是 3238341，從可本機測試出發的
 *    id 是另一組）。所以一律「用目標狀態名稱即時查」，不沿用任何 id。
 * 5. `user search` 不是完整名錄：有人明明掛在單子的角色上，用名字、email、user_key 都查不到（實測 Tim）。
 *    查不到就是查不到，**不猜、不退回操作人**。
 * 6. MQL 單次最多 50 筆，要用 session_id + group_pagination_list 翻頁，不能只拿第一頁。
 */
import { runMeegle, MeegleCliError, type CliResult } from './meegle-cli.js'
import type { Requirement } from '../shared/meegle-batch-rules.js'

/** 允許開單的空間與類型。只認這一組，關聯需求也只能指向同一空間的「需求」。 */
export function meegleTarget(env: NodeJS.ProcessEnv = process.env) {
  return {
    projectKey: env.MEEGLE_PROJECT_KEY || '6abb348976c120f4f43c746a',   // TP-項目管理-測試
    taskTypeKey: env.MEEGLE_TASK_TYPE_KEY || '6abd3a436ef2d2a4b44051d8', // 任務項
    requirementTypeKey: env.MEEGLE_REQUIREMENT_TYPE_KEY || 'story',      // 需求
    requirementFieldKey: env.MEEGLE_REQUIREMENT_FIELD_KEY || 'field_eab776', // 任務項的「關聯需求」
  }
}

/** Sheet 欄位對應的 5 個角色；key 是前後端共用的代號，roleName 用來在 meta-roles 裡找真正的 role id。 */
export const MEEGLE_ROLES = [
  { key: 'assignee', roleName: '受托人' },
  { key: 'rdOwner', roleName: 'RD 負責人' },
  { key: 'reporter', roleName: '回報者' },
  { key: 'codeReview', roleName: 'Code Review 人員' },
  { key: 'qaVerifier', roleName: 'QA 驗證人員' },
] as const
export type MeegleRoleKey = typeof MEEGLE_ROLES[number]['key']

export type Runner = (args: string[], token: string) => Promise<CliResult>
const defaultRunner: Runner = (args, token) => runMeegle(args, token, { timeoutMs: 45_000 })

/** 呼叫結果分三類：成功、確定失敗（伺服器明確拒絕，沒有副作用）、結果不明（逾時、連不上）。 */
export type CallOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; message: string }

type Envelope = { data?: unknown; error?: { code?: unknown; message?: unknown } | null }

/**
 * 解讀一次 CLI 輸出。純函式，測試直接打這裡。
 * - 逾時 → unknown（請求可能已經送到伺服器）
 * - error 物件：server 訊息寫 `retriable=false` → rejected；其餘（含外層 retryable:true）→ unknown
 *   ⚠️ 這裡寧可判 unknown：對「建單」來說 unknown 會擋住重送，判錯成 rejected 才會重複開單。
 * - 沒有 error 的 JSON → ok
 */
export function interpretCli(r: CliResult): CallOutcome<unknown> {
  if (r.timedOut) return { kind: 'unknown', message: 'Meegle 回應逾時，無法確定是否已執行' }
  // ⚠️ 失敗時錯誤 JSON 印在 **stderr**、結束碼 1，stdout 是空的（實測）。只讀 stdout 的話所有錯誤都會變成「看不懂」→ unknown，
  // 「人員無效」這種明確拒絕就會被當成結果待確認、擋住修正後重送。
  const text = r.stdout.trim() || r.stderr.trim()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    // 狀態轉換成功時 CLI 只印 "success"（帶引號的 JSON 字串，上面會解析成功）；其餘看不懂的輸出都不當成功
    return { kind: 'unknown', message: `Meegle 回應無法判讀：${(text || r.stderr).slice(0, 200)}` }
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed && (parsed as Envelope).error) {
    const err = (parsed as Envelope).error!
    const message = String(err.message ?? err.code ?? 'Meegle 回報錯誤')
    if (/retriable=false/i.test(message)) return { kind: 'rejected', message: cleanMessage(message) }
    return { kind: 'unknown', message: cleanMessage(message) }
  }
  return { kind: 'ok', value: parsed }
}

/** 拿掉 logid 等雜訊，留給使用者看得懂的那段。 */
function cleanMessage(m: string): string {
  return m.replace(/\nlogid:.*$/s, '').replace(/,retriable=(true|false)/i, '').trim()
}

async function call(runner: Runner, args: string[], token: string): Promise<CallOutcome<unknown>> {
  try {
    return interpretCli(await runner([...args, '--format', 'json'], token))
  } catch (e) {
    if (e instanceof MeegleCliError && (e.code === 'NO_TOKEN' || e.code === 'CLI_MISSING')) {
      return { kind: 'rejected', message: e.message }
    }
    return { kind: 'unknown', message: (e as Error).message }
  }
}

// ─── 人員 ───────────────────────────────────────────────────────────────────

export type UserMatch =
  | { ok: true; userKey: string; email: string; name: string }
  | { ok: false; reason: 'NOT_FOUND' | 'MULTIPLE' | 'INACTIVE' | 'NO_EMAIL'; message: string }

type SearchUser = { user_key?: unknown; email?: unknown; name_cn?: unknown; name_en?: unknown; status?: unknown }

/** 從 `user search` 的結果挑出這個 email。純函式。只認 email 完全相同（不分大小寫）且已啟用的那一個。 */
export function pickUserByEmail(email: string, results: SearchUser[]): UserMatch {
  const want = email.trim().toLowerCase()
  if (!want || !want.includes('@')) return { ok: false, reason: 'NO_EMAIL', message: '沒有 email，無法對應 Meegle 帳號' }
  const hits = results.filter(u => typeof u.email === 'string' && u.email.trim().toLowerCase() === want)
  if (hits.length === 0) return { ok: false, reason: 'NOT_FOUND', message: `Meegle 查不到 ${email}` }
  if (hits.length > 1) return { ok: false, reason: 'MULTIPLE', message: `${email} 對到 ${hits.length} 個 Meegle 帳號` }
  const u = hits[0]
  if (u.status !== undefined && u.status !== 'activated') {
    return { ok: false, reason: 'INACTIVE', message: `${email} 的 Meegle 帳號狀態是 ${String(u.status)}，不能指派` }
  }
  if (typeof u.user_key !== 'string' || !u.user_key) return { ok: false, reason: 'NOT_FOUND', message: `Meegle 回傳的 ${email} 沒有 user_key` }
  const name = [u.name_cn, u.name_en].find(v => typeof v === 'string' && v) as string | undefined
  return { ok: true, userKey: u.user_key, email: String(u.email), name: name ?? '' }
}

/** 一次解析多個 email（CLI 一次最多 20 個）。查詢本身失敗時整批回 unknown，不把「查不到」跟「沒查成」混在一起。 */
export async function resolveUsersByEmail(token: string, emails: string[], runner: Runner = defaultRunner): Promise<CallOutcome<Record<string, UserMatch>>> {
  const uniq = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))]
  const out: Record<string, UserMatch> = {}
  for (let i = 0; i < uniq.length; i += 20) {
    const chunk = uniq.slice(i, i + 20)
    const r = await call(runner, ['user', 'search', '--user-keys', ...chunk], token)
    if (r.kind !== 'ok') return r
    const list = Array.isArray(r.value) ? r.value as SearchUser[] : []
    for (const email of chunk) out[email] = pickUserByEmail(email, list)
  }
  return { kind: 'ok', value: out }
}

/**
 * `user search` 查不到時的退路：從空間既有單子的角色人員裡找（實測 Tim 只能這樣找到）。
 * MQL 只能用「顯示名稱」精確比對（大小寫有別），所以拿幾個候選名稱去試，
 * **最後一定要 email 完全相同才算**——名稱只是用來縮小範圍，不是判斷依據，不會認錯人。
 */
export async function findUserViaParticipants(token: string, email: string, nameCandidates: string[], runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<UserMatch>> {
  const t = meegleTarget(env)
  const want = email.trim().toLowerCase()
  const roleCols = MEEGLE_ROLES.map(r => `\`__${r.roleName}\``).join(', ')
  const tried = new Set<string>()
  for (const raw of nameCandidates) {
    const name = raw.trim()
    if (!name || tried.has(name)) continue
    tried.add(name)
    const r = await call(runner, ['workitem', 'query', '--project-key', t.projectKey, '--mql',
      `SELECT \`work_item_id\`, ${roleCols} FROM \`${t.projectKey}\`.\`${t.taskTypeKey}\` WHERE array_contains(all_participate_persons(), ${mqlString(name)}) LIMIT 50`], token)
    // 名稱不存在時 Meegle 回 3011「user does not exist」→ 換下一個候選名稱，不算查詢失敗
    if (r.kind === 'rejected' && /Code: 3011|does not exist/i.test(r.message)) continue
    if (r.kind !== 'ok') return r
    const users: SearchUser[] = []
    for (const group of Object.values((r.value as MqlPage).data ?? {})) {
      for (const row of group) for (const f of Object.values(flattenMqlRow(row))) {
        const list = f.user_value_list
        if (Array.isArray(list)) users.push(...(list as SearchUser[]))
      }
    }
    // 同一人會在多張單、多個角色重複出現 → 依 user_key 去重後再判斷是否唯一
    const uniq = [...new Map(users.filter(u => typeof u.email === 'string' && u.email.trim().toLowerCase() === want).map(u => [String(u.user_key), u])).values()]
    if (uniq.length) return { kind: 'ok', value: pickUserByEmail(email, uniq.map(u => ({ ...u, status: undefined }))) }
  }
  return { kind: 'ok', value: { ok: false, reason: 'NOT_FOUND', message: `Meegle 查不到 ${email}` } }
}

// ─── MQL ────────────────────────────────────────────────────────────────────

type MqlField = { key?: string; value?: Record<string, unknown> }
type MqlPage = {
  data?: Record<string, Array<{ moql_field_list?: MqlField[] }>>
  list?: Array<{ count?: number; group_infos?: Array<{ group_id?: string }> }>
  session_id?: string
}

/** 把一列 MQL 結果攤平成 { field_key: 原始值物件 }。 */
export function flattenMqlRow(row: { moql_field_list?: MqlField[] }): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const f of row.moql_field_list ?? []) if (f.key) out[f.key] = f.value ?? {}
  return out
}

/** 跑一個 MQL 並翻完所有頁（每頁 50 筆）。只支援單一分組（目前查詢都沒有 GROUP BY）。 */
export async function queryAll(token: string, projectKey: string, mql: string, runner: Runner = defaultRunner, maxPages = 40): Promise<CallOutcome<Array<Record<string, Record<string, unknown>>>>> {
  const rows: Array<Record<string, Record<string, unknown>>> = []
  const first = await call(runner, ['workitem', 'query', '--project-key', projectKey, '--mql', mql], token)
  if (first.kind !== 'ok') return first
  // ⚠️ 總筆數、session_id、分組 id 只有第一頁有；第 2 頁之後這幾個欄位是 null（實測 Master 空間 4237 筆）。
  // 所以要從第一頁記下來，不能每頁重讀——重讀的話翻到第 2 頁就會以為「沒有下一頁」而停住。
  const head = first.value as MqlPage
  const total = head.list?.[0]?.count ?? 0
  const sessionId = head.session_id
  const groupId = head.list?.[0]?.group_infos?.[0]?.group_id
  let page = head
  for (let pageNo = 1; ; pageNo++) {
    const before = rows.length
    for (const group of Object.values(page.data ?? {})) for (const row of group) rows.push(flattenMqlRow(row))
    if (rows.length >= total) break
    if (!sessionId || !groupId) return { kind: 'unknown', message: `查詢共 ${total} 筆，但 Meegle 沒有給翻頁資訊，只讀到 ${rows.length} 筆` }
    if (pageNo > 1 && rows.length === before) return { kind: 'unknown', message: `查詢共 ${total} 筆，翻頁拿到空頁，只讀到 ${rows.length} 筆` }
    if (pageNo >= maxPages) return { kind: 'unknown', message: `查詢結果超過 ${maxPages * 50} 筆，沒有全部讀完` }
    const next = await call(runner, ['workitem', 'query', '--project-key', projectKey, '--session-id', sessionId,
      '--group-pagination-list', JSON.stringify([{ group_id: groupId, page_num: pageNo + 1 }])], token)
    if (next.kind !== 'ok') return next
    page = next.value as MqlPage
  }
  return { kind: 'ok', value: rows }
}

/** MQL 字串字面值跳脫：單引號與反斜線。 */
export function mqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// ─── 關聯需求 ────────────────────────────────────────────────────────────────

// 名稱比對規則（pickRequirement）在 shared/meegle-batch-rules.ts，前端預覽與後端共用。

/** 列出允許空間裡所有「需求」（給整批預設的下拉選單，也給名稱比對用）。 */
export async function listRequirements(token: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Requirement[]>> {
  const t = meegleTarget(env)
  const r = await queryAll(token, t.projectKey,
    `SELECT \`name\`, \`work_item_id\` FROM \`${t.projectKey}\`.\`${t.requirementTypeKey}\``, runner)
  if (r.kind !== 'ok') return r
  return {
    kind: 'ok',
    value: r.value
      .map(row => ({ id: String(row.work_item_id?.long_value ?? ''), name: String(row.name?.string_value ?? '') }))
      .filter(x => x.id),
  }
}

/** 送出前再確認這個需求 ID 還在允許的空間／類型裡（可能在預覽之後被刪掉或搬走）。 */
export async function confirmRequirement(token: string, id: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Requirement | null>> {
  if (!/^\d+$/.test(id)) return { kind: 'ok', value: null }
  const t = meegleTarget(env)
  const r = await queryAll(token, t.projectKey,
    `SELECT \`name\`, \`work_item_id\` FROM \`${t.projectKey}\`.\`${t.requirementTypeKey}\` WHERE \`work_item_id\` = ${id}`, runner)
  if (r.kind !== 'ok') return r
  const hit = r.value.find(row => String(row.work_item_id?.long_value ?? '') === id)
  return { kind: 'ok', value: hit ? { id, name: String(hit.name?.string_value ?? '') } : null }
}

// ─── 角色 ───────────────────────────────────────────────────────────────────

/** 依角色名稱找出這個類型真正的 role id；少任何一個就整批不能開（設定被改過）。 */
export async function resolveRoleIds(token: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Record<MeegleRoleKey, string>>> {
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'meta-roles', '--project-key', t.projectKey, '--work-item-type', t.taskTypeKey], token)
  if (r.kind !== 'ok') return r
  const list = ((r.value as { list?: Array<{ role_id?: string; role_name?: string }> }).list ?? [])
  const out = {} as Record<MeegleRoleKey, string>
  const missing: string[] = []
  for (const role of MEEGLE_ROLES) {
    const hits = list.filter(x => (x.role_name ?? '').trim() === role.roleName)
    if (hits.length !== 1 || !hits[0].role_id) missing.push(role.roleName)
    else out[role.key] = hits[0].role_id
  }
  if (missing.length) return { kind: 'rejected', message: `Meegle「任務項」找不到角色：${missing.join('、')}（設定可能被改過）` }
  return { kind: 'ok', value: out }
}

// ─── 開單 ───────────────────────────────────────────────────────────────────

export type CreateInput = {
  name: string
  description?: string
  requirementId: string
  roles: Partial<Record<MeegleRoleKey, string[]>> // 值是 user_key
}

/** 組 `workitem create --fields` 的內容。純函式。所有 field_value 都是字串（見檔頭契約 1）。 */
export function buildCreateFields(input: CreateInput, roleIds: Record<MeegleRoleKey, string>, env: NodeJS.ProcessEnv = process.env) {
  const t = meegleTarget(env)
  const fields: Array<{ field_key: string; field_value: string }> = [
    { field_key: 'name', field_value: input.name },
    { field_key: t.requirementFieldKey, field_value: input.requirementId },
  ]
  if (input.description?.trim()) fields.push({ field_key: 'description', field_value: input.description })
  const roleOwners = MEEGLE_ROLES
    .map(r => ({ role: roleIds[r.key], owners: (input.roles[r.key] ?? []).filter(Boolean) }))
    .filter(r => r.owners.length > 0)
  if (roleOwners.length) fields.push({ field_key: 'role_owners', field_value: JSON.stringify(roleOwners) })
  return fields
}

export async function createTask(token: string, input: CreateInput, roleIds: Record<MeegleRoleKey, string>, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<{ workItemId: string; url: string }>> {
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'create', '--project-key', t.projectKey, '--work-item-type', t.taskTypeKey,
    '--fields', JSON.stringify(buildCreateFields(input, roleIds, env))], token)
  if (r.kind !== 'ok') return r
  const v = r.value as { work_item_id?: unknown; url?: unknown }
  const id = v.work_item_id != null ? String(v.work_item_id) : ''
  // 成功卻拿不到單號：單可能已經開了，不能當失敗讓人重送
  if (!/^\d+$/.test(id)) return { kind: 'unknown', message: 'Meegle 回應成功但沒有單號' }
  return { kind: 'ok', value: { workItemId: id, url: typeof v.url === 'string' ? v.url : '' } }
}

// ─── 狀態 ───────────────────────────────────────────────────────────────────

type TransitionList = { state_key?: string; state_name?: string; transition?: Array<{ id?: number; state_key?: string; state_name?: string; confirm_form?: unknown }> }

export type TransitionPlan =
  | { action: 'none'; current: string }
  | { action: 'go'; transitionId: string; current: string }
  | { action: 'blocked'; message: string }

/**
 * 依目標狀態決定要用哪個 transition。純函式。
 * 比對 **state_key**（例如 `BAOjDk8Pv`），不比名稱——Jira 那次就是拿名稱／別處的 id 套用才把單切錯（docs/features/01-jira.md）。
 * 需要填表單的轉換不自動做；同一目標多條轉換不挑。
 */
export function planTransition(targetKey: string, list: TransitionList): TransitionPlan {
  const want = targetKey.trim()
  const current = list.state_name ?? ''
  if ((list.state_key ?? '') === want) return { action: 'none', current }
  const hits = (list.transition ?? []).filter(t => (t.state_key ?? '') === want)
  const available = (list.transition ?? []).map(t => t.state_name).filter(Boolean).join('、')
  if (hits.length === 0) return { action: 'blocked', message: `目前狀態「${current}」不能直接轉到目標狀態。可轉：${available || '無'}` }
  const label = hits[0].state_name ?? want
  if (hits.length > 1) return { action: 'blocked', message: `有 ${hits.length} 個轉換都指向「${label}」，不自動選` }
  if (hits[0].confirm_form) return { action: 'blocked', message: `轉到「${label}」需要填確認表單，請到 Meegle 手動操作` }
  return { action: 'go', transitionId: String(hits[0].id), current }
}

export async function transitionToState(token: string, workItemId: string, targetKey: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<{ from: string; changed: boolean }>> {
  const t = meegleTarget(env)
  const list = await call(runner, ['workflow', 'list-state-transitions', '--project-key', t.projectKey, '--work-item-id', workItemId], token)
  if (list.kind !== 'ok') return list
  const plan = planTransition(targetKey, list.value as TransitionList)
  if (plan.action === 'blocked') return { kind: 'rejected', message: plan.message }
  if (plan.action === 'none') return { kind: 'ok', value: { from: plan.current, changed: false } }
  const r = await call(runner, ['workflow', 'transition-state', '--project-key', t.projectKey, '--work-item-id', workItemId, '--transition-id', plan.transitionId], token)
  if (r.kind !== 'ok') return r
  if (r.value !== 'success') return { kind: 'unknown', message: `轉換狀態回應無法判讀：${JSON.stringify(r.value).slice(0, 200)}` }
  return { kind: 'ok', value: { from: plan.current, changed: true } }
}

/** 列出這個類型可以推到的狀態（給「開單後推到」選單）。從空間裡任一張既有任務讀；狀態流是全連通的（實測）。 */
export async function listTaskStates(token: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Array<{ key: string; name: string }>>> {
  const t = meegleTarget(env)
  const q = await call(runner, ['workitem', 'query', '--project-key', t.projectKey, '--mql',
    `SELECT \`work_item_id\` FROM \`${t.projectKey}\`.\`${t.taskTypeKey}\` LIMIT 1`], token)
  if (q.kind !== 'ok') return q
  const first = Object.values((q.value as MqlPage).data ?? {}).flat()[0]
  const id = first ? String(flattenMqlRow(first).work_item_id?.long_value ?? '') : ''
  if (!id) return { kind: 'ok', value: [] }
  const list = await call(runner, ['workflow', 'list-state-transitions', '--project-key', t.projectKey, '--work-item-id', id], token)
  if (list.kind !== 'ok') return list
  const v = list.value as TransitionList
  const states = [{ key: v.state_key ?? '', name: v.state_name ?? '' }, ...(v.transition ?? []).map(x => ({ key: x.state_key ?? '', name: x.state_name ?? '' }))]
  return { kind: 'ok', value: [...new Map(states.filter(s => s.key).map(s => [s.key, s])).values()] }
}

/**
 * 「結果待確認」的列：用名稱＋關聯需求＋建立日期在空間裡找，看單到底有沒有開出來。
 * 建立日期（start_time）MQL 只回到「日」（實測 "2026-10-01"），所以只能篩到「那天以後」；
 * 剩下的同名單由呼叫端排除「已經記在別列的單號」再判斷是否唯一。
 */
export async function findTasksByName(token: string, name: string, requirementId: string, sinceDay: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Array<{ workItemId: string }>>> {
  const t = meegleTarget(env)
  const r = await queryAll(token, t.projectKey,
    `SELECT \`work_item_id\`, \`start_time\`, \`${t.requirementFieldKey}\` FROM \`${t.projectKey}\`.\`${t.taskTypeKey}\` WHERE \`name\` = ${mqlString(name)}`, runner)
  if (r.kind !== 'ok') return r
  return {
    kind: 'ok',
    value: r.value
      .filter(row => String((row[t.requirementFieldKey]?.key_label_value as { key?: unknown } | undefined)?.key ?? '') === requirementId)
      .filter(row => String(row.start_time?.string_value ?? '') >= sinceDay)
      .map(row => ({ workItemId: String(row.work_item_id?.long_value ?? '') }))
      .filter(x => x.workItemId),
  }
}

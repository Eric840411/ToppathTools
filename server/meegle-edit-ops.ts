/**
 * Meegle 批量修改：讀／寫單子欄位與角色（CLI 1.0.23，2026-10-02 在 #15190441 實測）。
 *  - 讀：`workitem get --fields a --fields b`；select 值是 `{label, value}`（value＝option_id）、date 是 `{timestamp}`、文字原樣；
 *    **空的欄位整個不會出現** → 當成 ""。名稱在 work_item_attribute.work_item_name；角色在 role_members
 *  - 寫：`workitem update --fields [{field_key, field_value: 字串}]`；名稱 field_key＝"name"；清空＝""
 *  - 角色：`role_owners` 在 update 被拒 → `--role-operate {op: add|remove, role_key, user_keys}`，沒有 replace
 *  - 描述圖片：`attachment +upload --resource-type 16 --field-key description` 拿 file_url，Markdown `![](url)` 嵌入（Meegle 會加 uuid 註解）
 */
import { EDIT_FIELDS, roleKeyOf, type CurrentValues, type Option } from '../shared/meegle-edit-rules.js'
import { MEEGLE_ROLE_DEFS, type MeegleRoleKey } from '../shared/meegle-batch-rules.js'
import { call, defaultRunner, meegleTarget, type CallOutcome, type Runner } from './meegle-workitem.js'

const PLAIN_KEYS = EDIT_FIELDS.filter(f => f.kind !== 'role' && f.key !== 'name').map(f => f.key)
const SELECT_KEYS = EDIT_FIELDS.filter(f => f.kind === 'select').map(f => f.key)

type GetResult = {
  work_item_attribute?: { work_item_name?: unknown; role_members?: Array<{ key?: unknown; members?: Array<{ key?: unknown; name?: unknown; email?: unknown }> }> }
  work_item_fields?: Array<{ key?: unknown; value?: unknown }>
}

export type EditCurrent = { values: CurrentValues; people: Record<string, string> }

/** 讀一張單所有可改欄位的目前值（role:xxx 用 roleIds 對到 role_key） */
export async function readEditCurrent(token: string, workItemId: string, roleIds: Record<MeegleRoleKey, string>, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<EditCurrent>> {
  const t = meegleTarget(env)
  const args = ['workitem', 'get', '--project-key', t.projectKey, '--work-item-id', workItemId]
  for (const k of PLAIN_KEYS) args.push('--fields', k)
  const r = await call(runner, args, token)
  if (r.kind !== 'ok') return r
  const v = r.value as GetResult
  if (!v?.work_item_attribute) return { kind: 'unknown', message: 'Meegle 回應裡沒有這張單' }
  const values: CurrentValues = { name: String(v.work_item_attribute.work_item_name ?? '') }
  for (const k of PLAIN_KEYS) {
    const raw = (v.work_item_fields ?? []).find(f => f.key === k)?.value
    if (raw == null || raw === '') values[k] = ''
    else if (typeof raw === 'string') values[k] = raw
    else if (typeof raw === 'object' && 'timestamp' in (raw as object)) { const ts = (raw as { timestamp?: unknown }).timestamp; values[k] = typeof ts === 'number' && ts > 0 ? String(ts) : '' }
    else if (typeof raw === 'object' && 'value' in (raw as object)) values[k] = String((raw as { value?: unknown }).value ?? '')
    else values[k] = ''
  }
  const people: Record<string, string> = {}
  for (const def of MEEGLE_ROLE_DEFS) {
    const role = (v.work_item_attribute.role_members ?? []).find(m => m.key === roleIds[def.key])
    const members = role?.members ?? []
    values[`role:${def.key}`] = members.map(m => String(m.key ?? '')).filter(Boolean)
    for (const m of members) if (m.key) people[String(m.key)] = String(m.name ?? m.email ?? m.key)
  }
  return { kind: 'ok', value: { values, people } }
}

/** 單選欄位的選項（option_id ↔ 名稱）。meta-fields 不帶 --field-keys 時不回 option（實測） */
export async function listEditOptions(token: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Record<string, Option[]>>> {
  return listSelectOptions(token, SELECT_KEYS, runner, env)
}

/** 指定幾個單選欄位的選項（開單的「其他欄位」也用；一次 CLI 呼叫）。任何一欄找不到 → rejected（設定被改過就整批不送） */
export async function listSelectOptions(token: string, keys: string[], runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Record<string, Option[]>>> {
  const t = meegleTarget(env)
  const args = ['workitem', 'meta-fields', '--project-key', t.projectKey, '--work-item-type', t.taskTypeKey]
  for (const k of keys) args.push('--field-keys', k)
  const r = await call(runner, args, token)
  if (r.kind !== 'ok') return r
  const list = (r.value as { list?: Array<{ field_key?: string; option?: Array<{ option_id?: string; option_name?: string }> }> }).list ?? []
  const out: Record<string, Option[]> = {}
  for (const k of keys) {
    const f = list.find(x => x.field_key === k)
    if (!f) return { kind: 'rejected', message: `Meegle 找不到欄位 ${k}（設定可能被改過）` }
    out[k] = (f.option ?? []).filter(o => o.option_id).map(o => ({ id: String(o.option_id), name: String(o.option_name ?? '') }))
  }
  return { kind: 'ok', value: out }
}

/** 一次寫多個一般欄位（含名稱）。成功只代表 Meegle 收下，呼叫端要讀回驗證 */
export async function updateFields(token: string, workItemId: string, fields: Array<{ field_key: string; field_value: string }>, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<true>> {
  if (!fields.length) return { kind: 'ok', value: true }
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'update', '--project-key', t.projectKey, '--work-item-id', workItemId, '--fields', JSON.stringify(fields)], token)
  return r.kind === 'ok' ? { kind: 'ok', value: true } : r
}

export async function roleOperate(token: string, workItemId: string, op: 'add' | 'remove', roleId: string, userKeys: string[], runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<true>> {
  if (!userKeys.length) return { kind: 'ok', value: true }
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'update', '--project-key', t.projectKey, '--work-item-id', workItemId,
    '--role-operate', JSON.stringify({ op, role_key: roleId, user_keys: userKeys })], token)
  return r.kind === 'ok' ? { kind: 'ok', value: true } : r
}

/** 上傳一張圖到「描述」欄（resource-type 16），回 file_url */
export async function uploadDescriptionImage(token: string, workItemId: string, path: string, filename: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<string>> {
  const t = meegleTarget(env)
  const r = await call(runner, ['attachment', '+upload', path, '--resource-type', '16', '--project-key', t.projectKey, '--work-item-id', workItemId, '--filename', filename, '--field-key', 'description'], token)
  if (r.kind !== 'ok') return r
  const url = (r.value as { file_url?: unknown }).file_url
  return typeof url === 'string' && url ? { kind: 'ok', value: url } : { kind: 'unknown', message: '上傳回應沒有網址' }
}

export { roleKeyOf }

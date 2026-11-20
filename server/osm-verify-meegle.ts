/**
 * 版本驗證表的 Meegle 開單（docs/features/35-osm-verify.md）。
 *
 * 既有的批量開單固定一組空間＋「任務項」類型；這裡擴充成**空間、類型都可選**，
 * 選了之後依該類型的 `meta-create-fields` 重新判斷必填欄位（不沿用任務項的假設）。
 * 底層照舊走 meegle-workitem 的 call()／queryAll()（同一套 CLI 契約：field_value 一律字串、
 * 逾時／看不懂＝結果不明、retriable=false＝確定失敗）。token 一律由呼叫端帶本人的，這裡不碰儲存。
 *
 * 「模板」：Meegle 的 `template`（任務流程，field_type_key=work_item_template）。meta-fields 會列出選項。
 *   - 預設任務項類型：沿用既有「已驗證可省略」（實開會自動帶「一般流程」），不出下拉
 *   - 其他類型：模板是必填時才出下拉（選項來自 meta-fields）；⚠️ 送 option_id 的格式沒有實開驗證過
 */
import { call, defaultRunner, meegleTarget, queryAll, mqlString, listRequirements, resolveDetailUrlBase, type CallOutcome, type Runner } from './meegle-workitem.js'
import { spaceEnv, type MeegleSpace } from './meegle-space.js'
import type { CreateFieldDef, TypeCreateSchema } from '../shared/osm-verify-rules.js'

/** 這個空間＋類型的 env：project key 由 spaceEnv 換、類型 key 換成選的（meegleTarget 從 env 讀） */
export function typeEnv(space: MeegleSpace, typeKey: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...spaceEnv(space, base), MEEGLE_TASK_TYPE_KEY: typeKey }
}

/** 預設任務項類型（既有批量開單用的那個），模板已驗證可省略只限它 */
const defaultTaskType = (base: NodeJS.ProcessEnv) => meegleTarget(base).taskTypeKey

export async function listTypes(token: string, env: NodeJS.ProcessEnv, runner: Runner = defaultRunner): Promise<CallOutcome<{ key: string; name: string }[]>> {
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'meta-types', '--project-key', t.projectKey], token)
  if (r.kind !== 'ok') return r
  const list = ((r.value as { list?: Array<{ type_key?: unknown; name?: unknown; api_name?: unknown; is_disable?: unknown }> }).list ?? [])
    .filter(x => typeof x.type_key === 'string' && x.type_key && x.is_disable !== 1 && x.is_disable !== true)
    .map(x => ({ key: String(x.type_key), name: String(x.name || x.api_name || x.type_key) }))
  return { kind: 'ok', value: list }
}

type CreateConf = { field_key?: string; field_name?: string; field_type_key?: string; is_required?: number }
type FieldMeta = { field_key?: string; field_name?: string; field_type?: string; option?: Array<{ option_id?: string; option_name?: string }> }

const TEXT_KINDS = new Set(['text', 'multi_text', 'multi-text', 'number', 'link'])

/**
 * 純函式：建立必填清單 → 使用者要填的欄位＋工具不支援的欄位。
 * name／description 由工具自己填；角色（role_owners）、人員、日期等這裡不支援 → 列為不支援、整個類型不能開（不猜預設值）。
 */
export function interpretTypeSchema(p: {
  typeKey: string; conf: CreateConf[]; fields: FieldMeta[]; selectOptions: Record<string, { id: string; name: string }[]>
  requirements: { id: string; name: string }[] | null; env: NodeJS.ProcessEnv; base: NodeJS.ProcessEnv
}): TypeCreateSchema {
  const out: CreateFieldDef[] = []
  const unsupported: string[] = []
  const reqKey = meegleTarget(p.env).requirementFieldKey
  for (const c of p.conf) {
    if (c.is_required !== 1 || !c.field_key) continue
    const key = c.field_key, name = c.field_name || key, kind = c.field_type_key ?? ''
    if (key === 'name' || key === 'description') continue
    if (kind === 'work_item_template' || key === 'template') {
      if (p.typeKey === defaultTaskType(p.base)) continue   // 已驗證可省略（meegle-workitem interpretCreateMeta 同一條）
      const opts = (p.fields.find(f => f.field_key === key)?.option ?? []).filter(o => o.option_id && o.option_name).map(o => ({ id: String(o.option_id), name: String(o.option_name) }))
      if (!opts.length) { unsupported.push(`${name}（讀不到選項）`); continue }
      out.push({ key, name, kind: 'template', options: opts })
      continue
    }
    if (kind === 'select') {
      const opts = p.selectOptions[key] ?? []
      if (!opts.length) { unsupported.push(`${name}（讀不到選項）`); continue }
      out.push({ key, name, kind: 'select', options: opts })
      continue
    }
    if (kind === 'work_item_related_select') {
      if (key === reqKey && p.requirements) out.push({ key, name, kind: 'requirement', options: p.requirements })
      else out.push({ key, name, kind: 'related' })
      continue
    }
    if (TEXT_KINDS.has(kind)) { out.push({ key, name, kind: 'text' }); continue }
    unsupported.push(`${name}（${kind || '未知類型'}）`)
  }
  return { typeKey: p.typeKey, fields: out, unsupported }
}

/** 每次要用時重讀（不快取）：選完之後 Meegle 設定可能改過，送出前要用最新的再驗一次 */
export async function loadTypeSchema(token: string, env: NodeJS.ProcessEnv, base: NodeJS.ProcessEnv = process.env, runner: Runner = defaultRunner): Promise<CallOutcome<TypeCreateSchema>> {
  const t = meegleTarget(env)
  const args = ['--project-key', t.projectKey, '--work-item-type', t.taskTypeKey]
  const [mc, mf] = await Promise.all([call(runner, ['workitem', 'meta-create-fields', ...args], token), call(runner, ['workitem', 'meta-fields', ...args], token)])
  if (mc.kind !== 'ok') return mc
  if (mf.kind !== 'ok') return mf
  const conf = (mc.value as { FieldConfList?: CreateConf[] }).FieldConfList
  if (!Array.isArray(conf)) return { kind: 'unknown', message: 'Meegle 建立欄位設定格式不對（沒有 FieldConfList）' }
  const fields = (mf.value as { list?: FieldMeta[] }).list ?? []
  const selectOptions: Record<string, { id: string; name: string }[]> = {}
  for (const c of conf.filter(c => c.is_required === 1 && c.field_type_key === 'select' && c.field_key)) {
    // meta-fields 不帶 --field-keys 時不一定回 option（既有實測），逐欄讀
    const o = await call(runner, ['workitem', 'meta-fields', ...args, '--field-keys', c.field_key!], token)
    if (o.kind !== 'ok') return o
    const hit = ((o.value as { list?: FieldMeta[] }).list ?? []).find(x => x.field_key === c.field_key)
    selectOptions[c.field_key!] = (hit?.option ?? []).filter(x => x.option_id && x.option_name).map(x => ({ id: String(x.option_id), name: String(x.option_name) }))
  }
  let requirements: { id: string; name: string }[] | null = null
  const reqKey = t.requirementFieldKey
  if (conf.some(c => c.is_required === 1 && c.field_key === reqKey && c.field_type_key === 'work_item_related_select')) {
    const r = await listRequirements(token, runner, env)
    if (r.kind !== 'ok') return r
    requirements = r.value
  }
  return { kind: 'ok', value: interpretTypeSchema({ typeKey: t.taskTypeKey, conf, fields, selectOptions, requirements, env, base }) }
}

export type CreateOutcome =
  | { kind: 'created'; workItemId: string; url: string }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown'; message: string }

/** 建單。逾時／503／成功但沒單號 → unknown（單可能已經開了，不能當失敗讓人重送） */
export async function createWorkItem(token: string, env: NodeJS.ProcessEnv, fields: { field_key: string; field_value: string }[], runner: Runner = defaultRunner): Promise<CreateOutcome> {
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'create', '--project-key', t.projectKey, '--work-item-type', t.taskTypeKey, '--fields', JSON.stringify(fields)], token)
  if (r.kind === 'rejected') return { kind: 'failed', message: r.message }
  if (r.kind === 'unknown') return { kind: 'unknown', message: r.message }
  const v = r.value as { work_item_id?: unknown }
  const id = v?.work_item_id != null ? String(v.work_item_id) : ''
  if (!/^\d+$/.test(id)) return { kind: 'unknown', message: 'Meegle 回應成功但沒有單號' }
  const base = await resolveDetailUrlBase(token, runner, env)
  return { kind: 'created', workItemId: id, url: base.kind === 'ok' ? base.value + id : '' }
}

/**
 * 「到遠端查」：同空間同類型、名稱相同的單裡，找描述帶這把 key 的。
 * 只認描述原文裡真的出現 key 的（名稱只是縮小範圍），讀不到描述的不算找到。
 */
export async function lookupByKey(token: string, env: NodeJS.ProcessEnv, name: string, key: string, runner: Runner = defaultRunner): Promise<CallOutcome<{ workItemId: string; url: string }[]>> {
  const t = meegleTarget(env)
  const r = await queryAll(token, t.projectKey, `SELECT \`work_item_id\`, \`description\` FROM \`${t.projectKey}\`.\`${t.taskTypeKey}\` WHERE \`name\` = ${mqlString(name)}`, runner)
  if (r.kind !== 'ok') return r
  const hits = r.value
    .filter(row => JSON.stringify(row.description ?? '').includes(key))
    .map(row => String(row.work_item_id?.long_value ?? ''))
    .filter(id => /^\d+$/.test(id))
  if (!hits.length) return { kind: 'ok', value: [] }
  const base = await resolveDetailUrlBase(token, runner, env)
  return { kind: 'ok', value: [...new Set(hits)].map(id => ({ workItemId: id, url: base.kind === 'ok' ? base.value + id : '' })) }
}

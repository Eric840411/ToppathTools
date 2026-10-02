/**
 * Meegle 批量更新狀態：讀／寫單子的狀態與日期欄（CLI 1.0.23，2026-10-02 在 #15190441 實測）。
 *  - `workitem get --fields a --fields b`：日期欄值是 `{ iso_time, timestamp }`；**空的欄位整個不會出現在 work_item_fields**
 *  - `workitem update` 的 field_value **必須是字串**（給數字回 MCPGatewayRequestMismatch）；日期寫毫秒字串
 *  - MQL 的日期 string_value 是 UTC，會差一天——不要用 MQL 讀日期
 */
import { AUTO_DATE_FIELDS } from '../shared/meegle-status-rules.js'
import { call, defaultRunner, meegleTarget, type CallOutcome, type Runner } from './meegle-workitem.js'

type GetResult = {
  work_item_attribute?: { work_item_status?: { key?: unknown; name?: unknown }; work_item_name?: unknown }
  work_item_fields?: Array<{ key?: unknown; value?: unknown }>
}

const DATE_FIELD_KEYS = [...new Set(Object.values(AUTO_DATE_FIELDS).map(f => f.field))]

export type CurrentInfo = { stateKey: string; stateName: string; name: string; dates: Record<string, number | null> }

/** 讀一張單的目前狀態＋兩個自動化日期欄（預覽與送出都用這支）。 */
export async function readCurrent(token: string, workItemId: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<CurrentInfo>> {
  const t = meegleTarget(env)
  const args = ['workitem', 'get', '--project-key', t.projectKey, '--work-item-id', workItemId]
  for (const f of DATE_FIELD_KEYS) args.push('--fields', f)
  const r = await call(runner, args, token)
  if (r.kind !== 'ok') return r
  const v = r.value as GetResult
  const attr = v?.work_item_attribute
  if (!attr || !attr.work_item_status) return { kind: 'unknown', message: 'Meegle 回應裡沒有這張單的狀態' }
  const dates: Record<string, number | null> = {}
  for (const key of DATE_FIELD_KEYS) {
    const f = (v.work_item_fields ?? []).find(x => x.key === key)
    const ts = (f?.value as { timestamp?: unknown } | undefined)?.timestamp
    dates[key] = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : null
  }
  return { kind: 'ok', value: { stateKey: String(attr.work_item_status.key ?? ''), stateName: String(attr.work_item_status.name ?? ''), name: String(attr.work_item_name ?? ''), dates } }
}

export async function readDate(token: string, workItemId: string, field: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<number | null>> {
  const r = await readCurrent(token, workItemId, runner, env)
  if (r.kind !== 'ok') return r
  if (!(field in r.value.dates)) return { kind: 'rejected', message: `不支援的日期欄 ${field}` }
  return { kind: 'ok', value: r.value.dates[field] }
}

export async function readState(token: string, workItemId: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<{ key: string; name: string }>> {
  const r = await readCurrent(token, workItemId, runner, env)
  return r.kind === 'ok' ? { kind: 'ok', value: { key: r.value.stateKey, name: r.value.stateName } } : r
}

/** 寫日期欄（台北當天 00:00 的毫秒）。成功只代表 Meegle 收下，呼叫端要再讀回驗證。 */
export async function writeDate(token: string, workItemId: string, field: string, ms: number, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<true>> {
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'update', '--project-key', t.projectKey, '--work-item-id', workItemId,
    '--fields', JSON.stringify([{ field_key: field, field_value: String(ms) }])], token)
  return r.kind === 'ok' ? { kind: 'ok', value: true } : r
}

/**
 * 開單「其他欄位」的實機驗證（2026-10-06）：測試空間實開一張帶全部其他欄位的單，回讀每一欄。
 * 用**主機的 meegle 登入**（不帶 token），只打測試空間。跑法：npx tsx scripts/meegle-create-extras-live-check.ts
 * 會真的開一張單（名稱標「工具測試請忽略」），印出單號讓人事後關掉。
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { buildCreateFields, interpretCli, listRequirements, loadCreateMeta, meegleTarget, type Runner } from '../server/meegle-workitem.js'
import { listSelectOptions } from '../server/meegle-edit-ops.js'
import { CREATE_EXTRA_FIELDS, CREATE_SELECT_KEYS, resolveCreateExtras } from '../shared/meegle-create-fields.js'

const require = createRequire(import.meta.url)
const BIN = join(dirname(require.resolve('@lark-project/meegle/package.json')), 'bin', `meegle-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`)
const TEST_KEY = '6abb348976c120f4f43c746a'
const env = { ...process.env, MEEGLE_PROJECT_KEY: TEST_KEY }
const hostRunner: Runner = async (args) => {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: 60_000 })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: !!r.error }
}
const t = meegleTarget(env)
const opts = await listSelectOptions('host', CREATE_SELECT_KEYS, hostRunner, env)
if (opts.kind !== 'ok') throw new Error(`選項：${opts.message}`)
const pick = (k: string) => opts.value[k][opts.value[k].length - 1]?.name ?? ''
const raw: Record<string, string> = {
  priority: pick('priority'), field_9a3fe4: pick('field_9a3fe4'), field_07e581: pick('field_07e581'), field_710be5: pick('field_710be5'), field_e742d0: pick('field_e742d0'),
  field_3db883: '2026/09/27', field_cbc597: '2026/09/28', field_ce2cfc: '2026/09/29', field_b4c668: '2026/09/25', field_9bae45: '2026/09/30', field_f4ace6: '4h',
  field_1ab2a7: '開發說明第一行\n第二行', field_44db22: '1. 步驟一\n2. 步驟二', field_f6b7ab: 'https://gitlab.example/merge_requests/1',
}
const ex = resolveCreateExtras(raw, opts.value)
if (ex.issues.length) throw new Error(ex.issues.join('；'))
const cm = await loadCreateMeta('host', hostRunner, env)
if (cm.kind !== 'ok') throw new Error(cm.message)
const tt = cm.value.taskType!
const reqs = await listRequirements('host', hostRunner, env)
if (reqs.kind !== 'ok') throw new Error('需求')
const req = reqs.value.find(r => /OSM/.test(r.name)) ?? reqs.value[0]
const fields = buildCreateFields({ name: '[工具測試請忽略] 開單其他欄位驗證 2026-10-06', requirementId: req.id, roles: {}, taskType: { fieldKey: tt.fieldKey, optionId: tt.options[0].id }, extraFields: ex.fields }, {} as never, env)
console.log('送出：', JSON.stringify(fields))
const created = interpretCli(await hostRunner(['workitem', 'create', '--project-key', t.projectKey, '--work-item-type', t.taskTypeKey, '--fields', JSON.stringify(fields)], 'host'))
console.log('開單：', JSON.stringify(created))
if (created.kind !== 'ok') process.exit(1)
const id = String((created.value as { work_item_id?: unknown }).work_item_id)
const got = interpretCli(await hostRunner(['workitem', 'get', '--project-key', t.projectKey, '--work-item-id', id, ...CREATE_EXTRA_FIELDS.flatMap(f => ['--fields', f.key])], 'host'))
if (got.kind !== 'ok') throw new Error('回讀失敗')
const back = (got.value as { work_item_fields?: Array<{ key: string; value: unknown }> }).work_item_fields ?? []
let bad = 0
for (const f of ex.fields) {
  const v = back.find(b => b.key === f.field_key)?.value
  const s = typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? '')
  const ok = s.includes(f.field_value) || (typeof v === 'number' && String(v) === f.field_value)
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${f.field_key} 送 ${JSON.stringify(f.field_value).slice(0, 40)} 讀回 ${s.slice(0, 80)}`)
}
console.log(`#${id}：${bad ? `${bad} 欄不符` : '全部欄位讀回一致'}`)

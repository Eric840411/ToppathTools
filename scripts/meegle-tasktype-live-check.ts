/**
 * 任務類型開單的實機驗證（2026-10-06，CodeX 要求：測試空間實開一張，回讀確認任務類型真的是 BUG、省略 template 的結果）。
 * 用**主機的 meegle 登入**（不帶 token），只打測試空間。跑法：npx tsx scripts/meegle-tasktype-live-check.ts
 * 會真的開一張單（名稱標「工具測試請忽略」），印出單號讓人事後關掉。
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { buildCreateFields, interpretCli, listRequirements, loadCreateMeta, meegleTarget, type Runner } from '../server/meegle-workitem.js'

const require = createRequire(import.meta.url)
const BIN = join(dirname(require.resolve('@lark-project/meegle/package.json')), 'bin', `meegle-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`)
const TEST_KEY = '6abb348976c120f4f43c746a'
if (process.env.MEEGLE_PROJECT_KEY && process.env.MEEGLE_PROJECT_KEY !== TEST_KEY) throw new Error('只准打測試空間')
const env = { ...process.env, MEEGLE_PROJECT_KEY: TEST_KEY }
const hostRunner: Runner = async (args) => {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: 60_000 })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: !!r.error }
}
const t = meegleTarget(env)
const cm = await loadCreateMeta('host', hostRunner, env)
if (cm.kind !== 'ok') throw new Error(`loadCreateMeta：${cm.message}`)
console.log('建立必填：', JSON.stringify({ taskType: cm.value.taskType && { fieldKey: cm.value.taskType.fieldKey, required: cm.value.taskType.required, options: cm.value.taskType.options }, unknownRequired: cm.value.unknownRequired }))
const tt = cm.value.taskType!
const bug = tt.options.find(o => o.name === 'BUG')!
const reqs = await listRequirements('host', hostRunner, env)
if (reqs.kind !== 'ok' || !reqs.value.length) throw new Error('讀不到需求')
const req = reqs.value.find(r => /OSM/.test(r.name)) ?? reqs.value[0]
const fields = buildCreateFields({ name: '[工具測試請忽略] 任務類型開單驗證 2026-10-06', description: 'Toppath Tools 驗證任務類型欄位能否寫入，請忽略／可直接終止', requirementId: req.id, roles: {}, taskType: { fieldKey: tt.fieldKey, optionId: bug.id } }, {} as never, env)
console.log('送出欄位：', JSON.stringify(fields))
const created = interpretCli(await hostRunner(['workitem', 'create', '--project-key', t.projectKey, '--work-item-type', t.taskTypeKey, '--fields', JSON.stringify(fields)], 'host'))
console.log('開單：', JSON.stringify(created))
if (created.kind !== 'ok') process.exit(1)
const id = String((created.value as { work_item_id?: unknown }).work_item_id)
const got = interpretCli(await hostRunner(['workitem', 'get', '--project-key', t.projectKey, '--work-item-id', id, '--fields', tt.fieldKey, '--fields', 'template'], 'host'))
console.log('回讀：', JSON.stringify(got).slice(0, 1500))

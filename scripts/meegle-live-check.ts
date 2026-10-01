/**
 * Meegle 開單層打真的 Meegle（測試空間）。跑法：npx tsx scripts/meegle-live-check.ts
 * ⚠️ 只給本機開發用：runner 不帶 token、沿用這台主機 `meegle auth login` 的登入（正式程式碼禁止這樣做，
 * 見 server/meegle-cli.ts 規則 1）。會在「TP-項目管理-測試」開一張名稱帶「[工具測試]」的單。
 */
import { spawn } from 'child_process'
import { resolveMeegleBinary, type CliResult } from '../server/meegle-cli.js'
import {
  createTask, findTasksByName, findUserViaParticipants, listRequirements, listTaskStates, resolveRoleIds,
  resolveUsersByEmail, transitionToState, type Runner,
} from '../server/meegle-workitem.js'

// 直接跑執行檔（不經 shell，JSON 參數才不會被引號規則弄壞），環境沿用主機 → 用主機登入
const runner: Runner = (args) => new Promise<CliResult>((resolve) => {
  const child = spawn(resolveMeegleBinary(), args, { windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  child.on('close', code => resolve({ exitCode: code, stdout, stderr, timedOut: false }))
})
const T = 'host-login'

const log = (k: string, v: unknown) => console.log(`■ ${k}:`, JSON.stringify(v))
const reqs = await listRequirements(T, runner); log('需求清單', reqs)
const states = await listTaskStates(T, runner); log('狀態清單', states)
const roles = await resolveRoleIds(T, runner); log('角色', roles)
log('email 查人（Eric、Tim）', await resolveUsersByEmail(T, ['eric.wu@toppath.tw', 'tim@toppath.tw'], runner))
log('退路找 Tim', await findUserViaParticipants(T, 'tim@toppath.tw', ['tim', 'Tim'], runner))
if (roles.kind !== 'ok') process.exit(1)
const name = `[工具測試] 批量開單 live check ${new Date().toISOString().slice(11, 19)}（請忽略）`
const created = process.env.SKIP_CREATE ? { kind: 'ok' as const, value: { workItemId: '15190820', url: '' } } : await createTask(T, { name, description: 'live check', requirementId: '15170734', roles: { reporter: ['7399589791446188037'], rdOwner: ['7399589791446188037', '7392032137467281414'] } }, roles.value, runner)
log('建單', created)
if (created.kind !== 'ok') process.exit(1)
log('推到可本機測試（BAOjDk8Pv）', await transitionToState(T, created.value.workItemId, 'BAOjDk8Pv', runner))
log('再推一次同狀態（應不動）', await transitionToState(T, created.value.workItemId, 'BAOjDk8Pv', runner))
await new Promise(r => setTimeout(r, 4000)) // MQL 剛建的單要幾秒才查得到
log('用名稱找回這張單', await findTasksByName(T, name, '15170734', new Date(Date.now() - 864e5).toISOString().slice(0, 10), runner))
log('人員無效時建單（應 rejected、不建單）', await createTask(T, { name: `${name} 無效人員`, requirementId: '15170734', roles: { reporter: ['1111111111111111111'] } }, roles.value, runner))
log('推到不存在的狀態（應 rejected）', await transitionToState(T, created.value.workItemId, 'no-such-state', runner))

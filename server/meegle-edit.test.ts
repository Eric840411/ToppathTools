/**
 * Meegle 批量修改送出流程。跑法：npx tsx server/meegle-edit.test.ts
 * 假 Meegle 照 2026-10-02 #15190441 實測：update 設絕對值；角色只能 add／remove；描述讀回會拿掉圖片替代文字、加 uuid 註解。
 */
import Database from 'better-sqlite3'
import { initMeegleEditSchema, getEditSteps, claimEditRow, beginEditStep } from './meegle-edit-store.js'
import { runEditRow, continueEditRow, planHash, type EditDeps, type EditPayload } from './meegle-edit-run.js'
import { resolveRow, type CurrentValues, type RawEdit, type ResolveCtx } from '../shared/meegle-edit-rules.js'
import { textFingerprint } from './meegle-comment-ops.js'
import type { CallOutcome } from './meegle-workitem.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const ROLE_IDS = { assignee: 'role_b2bf14', rdOwner: 'role_a288f6', reporter: 'role_e18f13', codeReview: 'role_d2a2b6', qaVerifier: 'role_037ecd' }
const CTX: ResolveCtx = {
  options: { priority: [{ id: 'option_1', name: 'P0' }, { id: 'option_2', name: 'P1' }], field_07e581: [], field_710be5: [], field_e742d0: [] },
  personMap: { zen: { userKey: 'u_zen', email: 'z@t', name: 'Zen' }, amy: { userKey: 'u_amy', email: 'a@t', name: 'Amy' }, bob: { userKey: 'u_bob', email: 'b@t', name: 'Bob' } },
}
type Sim = {
  values: CurrentValues
  failRoleAdd?: number; failUpdate?: 'rejected' | 'unknown'; failUpload?: boolean; dropImagesOnRead?: boolean
  uploads: number; updates: number; roleOps: string[]; sheetWrites: number; failWriteback?: boolean
  ctx: ResolveCtx
}
const base = (): CurrentValues => ({ name: '舊名', description: '舊描述', priority: 'option_1', field_f6b7ab: '', 'role:rdOwner': ['u_zen'], 'role:reporter': ['u_amy'] })
function makeSim(over: Partial<Sim> = {}): Sim { return { values: base(), uploads: 0, updates: 0, roleOps: [], sheetWrites: 0, ctx: CTX, ...over } }
function depsFor(sim: Sim, db: Database.Database): EditDeps {
  const ok = <T,>(value: T): CallOutcome<T> => ({ kind: 'ok', value })
  return {
    db, now: () => 1_000_000, fmtTime: () => 't', normText: textFingerprint,
    resolveCtx: async () => ok({ ...sim.ctx, roleIds: ROLE_IDS }),
    readCurrent: async () => {
      const v = structuredClone(sim.values)
      // Meegle 讀回：拿掉圖片替代文字、加 uuid 註解
      if (typeof v.description === 'string') v.description = (v.description as string).replace(/!\[[^\]]*\]\(([^)]*)\)/g, (_m, u) => sim.dropImagesOnRead ? '' : `![](${u})<!-- image:{"uuid":"X"} -->`)
      return ok(v)
    },
    updateFields: async (_id, fields) => {
      sim.updates++
      if (sim.failUpdate) return { kind: sim.failUpdate, message: '模擬' }
      for (const f of fields) sim.values[f.field_key] = f.field_value
      return ok(true as const)
    },
    roleOperate: async (_id, op, roleId, keys) => {
      const key = `role:${Object.entries(ROLE_IDS).find(([, v]) => v === roleId)![0]}`
      sim.roleOps.push(`${op}:${key}:${keys.join(',')}`)
      if (op === 'add' && sim.failRoleAdd) { sim.failRoleAdd--; return { kind: 'unknown', message: '逾時' } }
      const cur = (sim.values[key] as string[]) ?? []
      sim.values[key] = op === 'remove' ? cur.filter(k => !keys.includes(k)) : [...cur, ...keys.filter(k => !cur.includes(k))]
      return ok(true as const)
    },
    uploadImage: async (_id, _p, name) => { sim.uploads++; return sim.failUpload ? { kind: 'unknown', message: '上傳逾時' } : ok(`https://x/download/${name}-${sim.uploads}?u=1`) },
    readRowCells: async () => ({ 'Meegle 單號': '#15190441' }),
    writeRow: async () => { if (sim.failWriteback) return { ok: false, error: 'Sheet 鎖住' }; sim.sheetWrites++; return { ok: true } },
  }
}
const newDb = () => { const db = new Database(':memory:'); initMeegleEditSchema(db); return db }
let n = 0
function input(raws: RawEdit[], images: EditPayload['images'] = [], baseline = base(), ctx = CTX) {
  const plan = resolveRow(raws, ctx)
  return { batchId: `b${++n}`, workItemId: '15190441', sourceKey: 'lark:t:s', sheetUrl: 'u', sheetRow: 3, summary: 's', space: 'test' as const, ownerEmail: 'e@t',
    content: { raws, baseline, planHash: planHash(plan.edits, images), images } }
}
const phases = (db: Database.Database, b: string) => Object.fromEntries(getEditSteps(db, b, '15190441').map(s => [s.step, s.phase]))

// 1. 一般欄位＋角色，全成功
{
  const sim = makeSim(), db = newDb()
  const p = input([{ key: 'name', op: 'set', raw: '新名' }, { key: 'priority', op: 'set', raw: 'P1' }, { key: 'role:rdOwner', op: 'set', raw: 'bob' }, { key: 'field_f6b7ab', op: 'clear' }])
  await runEditRow(depsFor(sim, db), p)
  eq('全成功：四步完成', phases(db, p.batchId), { fields: 'done', roles: 'done', verify: 'done', writeback: 'done' })
  eq('全成功：值都寫上', [sim.values.name, sim.values.priority, sim.values['role:rdOwner'], sim.values.field_f6b7ab], ['新名', 'option_2', ['u_bob'], ''])
  eq('全成功：角色先 remove 再 add', sim.roleOps, ['remove:role:rdOwner:u_zen', 'add:role:rdOwner:u_bob'])
}
// 2. CodeX：角色做到一半（remove 成功、add 逾時）→ 重試會核對「改到一半」的狀態並續做，不被自己的覆寫保護擋住
{
  const sim = makeSim({ failRoleAdd: 1 }), db = newDb()
  const p = input([{ key: 'role:rdOwner', op: 'set', raw: 'bob' }])
  const deps = depsFor(sim, db)
  await runEditRow(deps, p)
  eq('角色一半：roles 失敗、此時角色是空的', [phases(db, p.batchId).roles, sim.values['role:rdOwner']], ['failed', []])
  await continueEditRow(deps, p.batchId, '15190441', { retry: true })
  eq('角色一半：重試續做成功', [phases(db, p.batchId).roles, sim.values['role:rdOwner']], ['done', ['u_bob']])
  eq('角色一半：重試沒有再 remove（現況已經移除了）', sim.roleOps, ['remove:role:rdOwner:u_zen', 'add:role:rdOwner:u_bob', 'add:role:rdOwner:u_bob'])
}
// 3. 角色被別人改成不認得的樣子 → 待確認，不硬改
{
  const sim = makeSim(), db = newDb()
  const p = input([{ key: 'role:rdOwner', op: 'set', raw: 'bob' }])
  sim.values['role:rdOwner'] = ['u_amy']   // 預覽之後有人改了
  await runEditRow(depsFor(sim, db), p)
  eq('角色被別人改過 → 失敗且沒有任何角色操作', [phases(db, p.batchId).roles, sim.roleOps.length], ['failed', 0])
}
// 4. 一般欄位預覽後被改過 → 擋，不寫
{
  const sim = makeSim(), db = newDb()
  const p = input([{ key: 'name', op: 'set', raw: '新名' }])
  sim.values.name = '別人改的名'
  await runEditRow(depsFor(sim, db), p)
  eq('預覽後被改過 → fields 失敗、沒有 update', [phases(db, p.batchId).fields, sim.updates], ['failed', 0])
}
// 5. 圖片：上傳成功的 URL 重試沿用，不重傳；讀回驗圖片網址
{
  const sim = makeSim({ failUpdate: 'unknown' }), db = newDb()
  const p = input([{ key: 'description', op: 'set', raw: '新描述' }], [{ name: 'a.png', path: '/x/a', key: 'ha' }, { name: 'b.png', path: '/x/b', key: 'hb' }])
  const deps = depsFor(sim, db)
  await runEditRow(deps, p)
  eq('圖片：update 失敗時已上傳 2 張', [phases(db, p.batchId).fields, sim.uploads], ['failed', 2])
  sim.failUpdate = undefined
  await continueEditRow(deps, p.batchId, '15190441', { retry: true })
  eq('圖片：重試沒有重傳', sim.uploads, 2)
  eq('圖片：完成、描述＝新文字＋兩張圖', [phases(db, p.batchId).verify, (sim.values.description as string).match(/download\//g)?.length], ['done', 2])
}
// 6. 圖片讀回不見了 → verify 失敗（不能只驗文字）
{
  const sim = makeSim({ dropImagesOnRead: true }), db = newDb()
  const p = input([{ key: 'description', op: 'set', raw: '新描述' }], [{ name: 'a.png', path: '/x/a', key: 'ha' }])
  await runEditRow(depsFor(sim, db), p)
  eq('圖片讀回不見 → verify 失敗', phases(db, p.batchId).verify, 'failed')
}
// 7. 只加圖、沒改描述 → 接在原描述後面；但描述預覽後被別人改過 → 擋
{
  const sim = makeSim(), db = newDb()
  const p = input([], [{ name: 'a.png', path: '/x/a', key: 'ha' }])
  await runEditRow(depsFor(sim, db), p)
  eq('只加圖：原描述保留、圖接在後面', [(sim.values.description as string).startsWith('舊描述'), /download\/a\.png/.test(sim.values.description as string)], [true, true])
  const sim2 = makeSim(), db2 = newDb()
  const p2 = input([], [{ name: 'a.png', path: '/x/a', key: 'ha' }])
  sim2.values.description = '別人剛改的描述'
  await runEditRow(depsFor(sim2, db2), p2)
  eq('只加圖但描述被改過 → 擋、沒上傳也沒寫', [phases(db2, p2.batchId).fields, sim2.uploads, sim2.updates], ['failed', 0, 0])
}
// 8. CodeX：人員對照在預覽後變了 → 計畫不同 → 要求重新預覽
{
  const sim = makeSim(), db = newDb()
  const p = input([{ key: 'role:rdOwner', op: 'set', raw: 'bob' }])
  sim.ctx = { ...CTX, personMap: { ...CTX.personMap, bob: { userKey: 'u_bob2', email: 'b2@t', name: 'Bob2' } } }
  await runEditRow(depsFor(sim, db), p)
  const st = getEditSteps(db, p.batchId, '15190441').find(s => s.step === 'fields')
  eq('計畫變了 → 擋、要求重新預覽、沒有任何操作', [st?.phase, /重新預覽/.test(st?.message ?? ''), sim.roleOps.length, sim.updates], ['failed', true, 0, 0])
}
// 9. 回填失敗 → 「修改完成、回填失敗」，重試只補回填
{
  const sim = makeSim({ failWriteback: true }), db = newDb()
  const p = input([{ key: 'name', op: 'set', raw: '新名' }])
  const deps = depsFor(sim, db)
  await runEditRow(deps, p)
  const wb = getEditSteps(db, p.batchId, '15190441').find(s => s.step === 'writeback')
  eq('回填失敗：前三步 done、訊息寫明修改完成', [phases(db, p.batchId).verify, wb?.phase, /修改完成、回填失敗/.test(wb?.message ?? '')], ['done', 'failed', true])
  sim.failWriteback = false
  const updatesBefore = sim.updates
  await continueEditRow(deps, p.batchId, '15190441', { retry: true })
  eq('回填重試：只補回填、沒再寫 Meegle', [phases(db, p.batchId).writeback, sim.updates - updatesBefore], ['done', 0])
}
// 10. 讀回不符 → 重試從 fields 重做（目前值＝要寫的值時不被覆寫保護擋）
{
  const sim = makeSim(), db = newDb()
  const p = input([{ key: 'name', op: 'set', raw: '新名' }])
  const deps = depsFor(sim, db)
  const orig = deps.updateFields
  deps.updateFields = async (id, f) => { const r = await orig(id, f); sim.values.name = '被吃掉'; return r }
  await runEditRow(deps, p)
  eq('讀回不符 → verify 失敗', phases(db, p.batchId).verify, 'failed')
  deps.updateFields = orig
  sim.values.name = '新名'   // Meegle 其實寫上了（讀回那次剛好不一致）
  await continueEditRow(deps, p.batchId, '15190441', { retry: true })
  eq('讀回不符重試 → 完成', phases(db, p.batchId).verify, 'done')
}
// 11. 解析不出來（人員沒對照）→ 整列擋、不送半套
{
  const sim = makeSim(), db = newDb()
  const p = input([{ key: 'name', op: 'set', raw: '新名' }, { key: 'role:rdOwner', op: 'set', raw: 'Tim' }])
  await runEditRow(depsFor(sim, db), p)
  eq('人員沒對照 → 整列擋、名稱也沒改', [phases(db, p.batchId).fields, sim.values.name], ['failed', '舊名'])
}
// 12. 認領
{
  const db = newDb()
  const a = { batchId: 'x1', workItemId: '1', sourceKey: 's', sheetUrl: '', sheetRow: 2, summary: '', space: 'test' as const, ownerEmail: 'e@t', payload: '{}' }
  eq('認領 claimed', claimEditRow(db, a).kind, 'claimed')
  beginEditStep(db, 'x1', '1', 'fields')
  eq('同單別批次在跑 → busy', claimEditRow(db, { ...a, batchId: 'x2' }).kind, 'busy')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

/**
 * Meegle 批量修改：送出**一列**（一張單）。步驟與規則跟 CodeX 對過（2026-10-02）：
 *
 *   認領 → 重算計畫（跟預覽存的不同 → 要求重新預覽）→ 覆寫保護 → ① fields → ② roles → ③ verify → ④ writeback
 *
 *  - 計畫由後端 resolve（後端不收前端算好的 option_id／user_key）；預覽時也是後端算的，存成 planHash。
 *    送出時重算，人員對照／選項變了導致計畫不同 → 擋，請重新預覽
 *  - 覆寫保護：每個要改的欄位，目前值必須是「預覽原值」或「要寫的新值」（後者讓重試能過）；
 *    角色另外允許「原值∩新值」（先 remove 再 add，做到一半的樣子）。其他值＝別人改過或不知道是不是我們造成的 → 待確認，不硬改
 *    ⚠️ 讀到寫之間的空窗擋不住（Meegle 沒有條件式更新，docs/decisions.md）
 *  - 圖片上傳是獨立的副作用：成功的 URL 存進 fields 步驟，重試沿用，不重傳；讀回要驗圖片網址都在
 *  - 角色：逐角色 remove（原值−新值）→ add（新值−原值），每做完一個操作就記下來；中途失敗重試時先讀現況核對再續做
 *  - writeback 失敗＝「修改完成、回填失敗」，只重試回填
 * 遠端呼叫全部從 deps 傳進來，測試用假的。
 */
import type Database from 'better-sqlite3'
import { MEEGLE_ID_COLUMN, parseMeegleIdCell } from '../shared/meegle-comment-rules.js'
import { EDIT_STAGE_DONE, resolveRow, roleKeyOf, sameValue, type CurrentValues, type RawEdit, type ResolveCtx, type ResolvedEdit } from '../shared/meegle-edit-rules.js'
import type { MeegleRoleKey } from '../shared/meegle-batch-rules.js'
import {
  beginEditStep, claimEditRow, finishEditStep, getEditRow, getEditSteps, resetForRewrite,
  type EditClaimInput, type EditClaimResult, type EditStepRow,
} from './meegle-edit-store.js'
import type { CallOutcome } from './meegle-workitem.js'
import type { SheetCell } from './meegle-sheet-writeback.js'
import { createHash } from 'crypto'

type DB = Database.Database

export type EditDeps = {
  db: DB
  resolveCtx: () => Promise<CallOutcome<ResolveCtx & { roleIds: Record<MeegleRoleKey, string> }>>
  readCurrent: (workItemId: string) => Promise<CallOutcome<CurrentValues>>
  updateFields: (workItemId: string, fields: Array<{ field_key: string; field_value: string }>) => Promise<CallOutcome<true>>
  roleOperate: (workItemId: string, op: 'add' | 'remove', roleId: string, userKeys: string[]) => Promise<CallOutcome<true>>
  uploadImage: (workItemId: string, path: string, name: string) => Promise<CallOutcome<string>>
  readRowCells: (sheetKey: string, rowIndex: number, names: string[]) => Promise<Record<string, string> | null>
  writeRow: (sheetKey: string, rowIndex: number, columns: Record<string, SheetCell>) => Promise<{ ok: boolean; error?: string }>
  fmtTime: (ms: number) => string
  normText: (s: string) => string
  now?: () => number
}

/** 送出的內容（存進 payload）：Sheet 原文、預覽時看到的原值、預覽算出的計畫 hash、要嵌進描述的圖片 */
export type EditPayload = {
  raws: RawEdit[]
  baseline: CurrentValues
  planHash: string
  images: Array<{ name: string; path: string; key: string }>
}

/** 計畫的指紋：預覽與送出各算一次，不同就要重新預覽 */
export function planHash(edits: ResolvedEdit[], images: Array<{ key: string }>): string {
  const norm = edits.map(e => e.kind === 'role' ? [e.key, [...e.userKeys].sort()] : [e.key, e.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return createHash('sha256').update(JSON.stringify({ e: norm, i: images.map(i => i.key) })).digest('hex')
}

/** 描述最後要長什麼樣（圖片接在後面）。沒改描述只加圖 → 接在目前描述後面（使用者選 A，待確認前先這樣） */
export function buildDescription(base: string, urls: Array<{ name: string; url: string }>): string {
  const body = base.replace(/\r\n/g, '\n').trim()
  if (!urls.length) return body
  return `${body}${body ? '\n\n' : ''}${urls.map(u => `![${u.name.replace(/[[\]]/g, '')}](${u.url})`).join('\n\n')}`
}

const msgOf = (r: { kind: string; message?: string }) => ('message' in r && r.message) || '未知錯誤'
const sortKeys = (a: string[]) => [...a].sort()
const sameSet = (a: string[], b: string[]) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))

export type EditRunInput = EditClaimInput & { content: EditPayload }
export type EditRunResult = { claim: EditClaimResult | { kind: 'plan-changed'; message: string }; steps: EditStepRow[] }

export async function runEditRow(deps: EditDeps, p: EditRunInput): Promise<EditRunResult> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const claim = claimEditRow(db, { ...p, payload: JSON.stringify(p.content) }, now())
  if (claim.kind !== 'claimed') return { claim, steps: getEditSteps(db, p.batchId, p.workItemId) }
  return { claim, steps: await continueEditRow(deps, p.batchId, p.workItemId) }
}

/** 從紀錄接著做（送出與重試共用）。done 的不重做；verify 失敗的重試從 fields 重做。 */
export async function continueEditRow(deps: EditDeps, B: string, R: string, opts: { retry?: boolean } = {}): Promise<EditStepRow[]> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const row = getEditRow(db, B, R)
  if (!row) return []
  if (opts.retry) resetForRewrite(db, B, R, now())
  const steps = () => getEditSteps(db, B, R)
  const step = (s: string) => steps().find(x => x.step === s)
  const data = (s: string) => { try { const d = step(s)?.data; return d ? JSON.parse(d) as Record<string, unknown> : {} } catch { return {} } }
  const content = JSON.parse(row.payload) as EditPayload

  const needEdit = ['fields', 'roles', 'verify'].some(s => !['done', 'skipped'].includes(step(s)?.phase ?? ''))
  let edits: ResolvedEdit[] = []
  let roleIds = {} as Record<MeegleRoleKey, string>
  if (needEdit) {
    // 重算計畫；跟預覽不同 → 擋（不送跟使用者看到的不一樣的東西）
    const ctx = await deps.resolveCtx()
    const first = steps().find(s => s.phase === 'none' || s.phase === 'failed')?.step as 'fields' | 'roles' | 'verify' | 'writeback' | undefined
    const failAt = (m: string) => { if (first && first !== 'writeback' && beginEditStep(db, B, R, first, now())) finishEditStep(db, B, R, first, 'failed', m, undefined, now()); return steps() }
    if (ctx.kind !== 'ok') return failAt(`讀不到 Meegle 的選項／角色設定：${msgOf(ctx)}`)
    const plan = resolveRow(content.raws, ctx.value)
    if (plan.issues.length) return failAt(`這一列不能送：${plan.issues.join('；')}`)
    if (planHash(plan.edits, content.images) !== content.planHash) return failAt('人員對照或選項在預覽之後變了，要寫的值跟預覽不同。請回 ③ 重新預覽')
    edits = plan.edits
    roleIds = ctx.value.roleIds
  }

  // ① fields：一般欄位（含名稱、描述＋圖片）一次 update
  const plain = edits.filter((e): e is Extract<ResolvedEdit, { kind: Exclude<ResolvedEdit['kind'], 'role'> }> => e.kind !== 'role')
  const roleEdits = edits.filter((e): e is Extract<ResolvedEdit, { kind: 'role' }> => e.kind === 'role')
  if (needEdit && !['done', 'skipped'].includes(step('fields')?.phase ?? '')) {
    if (!beginEditStep(db, B, R, 'fields', now())) return steps()
    if (!plain.length && !content.images.length) { finishEditStep(db, B, R, 'fields', 'skipped', '沒有一般欄位要改', undefined, now()) }
    else {
      const cur = await deps.readCurrent(R)
      if (cur.kind !== 'ok') { finishEditStep(db, B, R, 'fields', 'failed', `讀不到目前的值：${msgOf(cur)}`, undefined, now()); return steps() }
      const fp = (v: unknown) => deps.normText(String(v ?? ''))
      const changed = plain.filter(e => {
        const now_ = cur.value[e.key]
        if (sameValue(e, now_, deps.normText)) return false
        return e.kind === 'multi' || e.kind === 'name' || e.kind === 'text' ? fp(now_) !== fp(content.baseline[e.key]) : String(now_ ?? '') !== String(content.baseline[e.key] ?? '')
      })
      // 描述＋圖片：重試時目前值可能已經是「我們寫過的版本」（含圖片）→ 用存下來的 written 比對
      const prevWritten = typeof data('fields').written === 'string' ? data('fields').written as string : null
      const descChanged: Array<{ key: string }> = changed.filter(e => !(e.key === 'description' && prevWritten != null && fp(cur.value.description) === fp(prevWritten)))
      // 只加圖、沒改描述文字：圖會接在「預覽時的描述」後面，所以描述也要沒被別人改過（不然接上去會蓋掉別人的修改）
      if (content.images.length && !plain.some(e => e.key === 'description')) {
        const d = fp(cur.value.description)
        if (d !== fp(content.baseline.description) && !(prevWritten != null && d === fp(prevWritten))) descChanged.push({ key: 'description' })
      }
      if (descChanged.length) {
        finishEditStep(db, B, R, 'fields', 'failed', `預覽之後被改過，沒有覆寫：${descChanged.map(e => e.key).join('、')}。請重新預覽`, { needsConfirm: true }, now())
        return steps()
      }
      // 圖片：成功的 URL 存起來，重試沿用（不重傳）
      const uploaded = (data('fields').uploaded as Record<string, string> | undefined) ?? {}
      for (const img of content.images) {
        if (uploaded[img.key]) continue
        const up = await deps.uploadImage(R, img.path, img.name)
        if (up.kind !== 'ok') { finishEditStep(db, B, R, 'fields', 'failed', `圖片 ${img.name} 上傳失敗：${msgOf(up)}`, { uploaded }, now()); return steps() }
        uploaded[img.key] = up.value
        db.prepare(`UPDATE meegle_edit_steps SET data = ? WHERE batch_id = ? AND row_key = ? AND step = 'fields'`).run(JSON.stringify({ ...data('fields'), uploaded }), B, R)
      }
      const fields = plain.filter(e => e.key !== 'description').map(e => ({ field_key: e.key, field_value: e.value }))
      let written: string | null = null
      if (content.images.length || plain.some(e => e.key === 'description')) {
        const descEdit = plain.find(e => e.key === 'description')
        // A：有改描述 → 新文字＋新圖；沒改描述只加圖 → 接在預覽時的描述後面
        const base = descEdit ? descEdit.value : String(content.baseline.description ?? '')
        written = buildDescription(base, content.images.map(i => ({ name: i.name, url: uploaded[i.key] })))
        fields.push({ field_key: 'description', field_value: written })
      }
      const w = await deps.updateFields(R, fields)
      if (w.kind !== 'ok') { finishEditStep(db, B, R, 'fields', 'failed', `${w.kind === 'rejected' ? 'Meegle 拒絕' : '結果不明（讀回會確認）'}：${w.message}`, { uploaded, written }, now()); return steps() }
      finishEditStep(db, B, R, 'fields', 'done', null, { uploaded, written }, now())
    }
  }
  if (needEdit && !['done', 'skipped'].includes(step('fields')?.phase ?? '')) return steps()

  // ② roles：逐角色 remove → add，每個操作做完就記
  if (needEdit && !['done', 'skipped'].includes(step('roles')?.phase ?? '')) {
    if (!beginEditStep(db, B, R, 'roles', now())) return steps()
    if (!roleEdits.length) finishEditStep(db, B, R, 'roles', 'skipped', '沒有角色要改', undefined, now())
    else {
      const cur = await deps.readCurrent(R)
      if (cur.kind !== 'ok') { finishEditStep(db, B, R, 'roles', 'failed', `讀不到目前的角色：${msgOf(cur)}`, undefined, now()); return steps() }
      for (const e of roleEdits) {
        const rk = roleKeyOf(e.key)!
        const from = (content.baseline[e.key] as string[] | undefined) ?? []
        const to = e.userKeys
        const now_ = (cur.value[e.key] as string[] | undefined) ?? []
        const mid = from.filter(k => to.includes(k))
        if (!sameSet(now_, from) && !sameSet(now_, to) && !sameSet(now_, mid)) {
          finishEditStep(db, B, R, 'roles', 'failed', `${e.display ? '' : ''}角色「${e.key.slice(5)}」現在的人員不是預覽時、也不是我們改到一半的樣子（可能有人同時在改），沒有硬改，請到 Meegle 確認後重新預覽`, { needsConfirm: true }, now())
          return steps()
        }
        const toRemove = now_.filter(k => !to.includes(k))
        const toAdd = to.filter(k => !now_.includes(k))
        if (toRemove.length) {
          const r = await deps.roleOperate(R, 'remove', roleIds[rk], toRemove)
          if (r.kind !== 'ok') { finishEditStep(db, B, R, 'roles', 'failed', `移除 ${e.key.slice(5)} 舊人員${r.kind === 'rejected' ? '被拒' : '結果不明'}：${r.message}（重試會先讀現況核對）`, undefined, now()); return steps() }
        }
        if (toAdd.length) {
          const r = await deps.roleOperate(R, 'add', roleIds[rk], toAdd)
          if (r.kind !== 'ok') { finishEditStep(db, B, R, 'roles', 'failed', `加入 ${e.key.slice(5)} 新人員${r.kind === 'rejected' ? '被拒' : '結果不明'}：${r.message}（舊人員可能已移除，重試會先讀現況核對再續做）`, undefined, now()); return steps() }
        }
      }
      finishEditStep(db, B, R, 'roles', 'done', null, undefined, now())
    }
  }
  if (needEdit && !['done', 'skipped'].includes(step('roles')?.phase ?? '')) return steps()

  // ③ verify：讀回比對每一個改過的欄位＋圖片網址
  if (needEdit && step('verify')?.phase !== 'done') {
    if (!beginEditStep(db, B, R, 'verify', now())) return steps()
    const back = await deps.readCurrent(R)
    if (back.kind !== 'ok') { finishEditStep(db, B, R, 'verify', 'failed', `讀不回來確認：${msgOf(back)}`, undefined, now()); return steps() }
    const written = typeof data('fields').written === 'string' ? data('fields').written as string : null
    const uploaded = Object.values((data('fields').uploaded as Record<string, string> | undefined) ?? {})
    const bad: string[] = []
    for (const e of edits) {
      if (e.key === 'description' || (written != null && e.key === 'description')) continue
      if (!sameValue(e, back.value[e.key], deps.normText)) bad.push(e.key)
    }
    if (written != null) {
      const v = String(back.value.description ?? '')
      if (deps.normText(v.replace(/!\[[^\]]*\]\([^)]*\)/g, '')) !== deps.normText(written.replace(/!\[[^\]]*\]\([^)]*\)/g, ''))) bad.push('description')
      // 圖片網址要都在（Meegle 會拿掉替代文字、加 uuid 註解，所以只比網址）
      const missing = uploaded.filter(u => !v.includes(u.split('?')[0]))
      if (missing.length) bad.push(`description 圖片少了 ${missing.length} 張`)
    }
    if (bad.length) { finishEditStep(db, B, R, 'verify', 'failed', `讀回跟要寫的不一樣：${bad.join('、')}（重試會重新寫入）`, undefined, now()); return steps() }
    finishEditStep(db, B, R, 'verify', 'done', null, undefined, now())
  }

  return writebackEdit(deps, B, R)
}

/** ④ Sheet 回填「處理階段＝已修改欄位」。前三步都 done／skipped 才寫；先確認那一列還是這張單。 */
export async function writebackEdit(deps: EditDeps, B: string, R: string): Promise<EditStepRow[]> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const row = getEditRow(db, B, R)
  const steps = getEditSteps(db, B, R)
  if (!row) return steps
  const ok = (s: string) => ['done', 'skipped'].includes(steps.find(x => x.step === s)?.phase ?? '')
  if (!ok('fields') || !ok('roles') || !ok('verify') || ok('writeback')) return steps
  if (!row.source_key.startsWith('lark:')) return steps
  if (!beginEditStep(db, B, R, 'writeback', now())) return getEditSteps(db, B, R)
  const fail = (m: string) => { finishEditStep(db, B, R, 'writeback', 'failed', `修改完成、回填失敗：${m}`, undefined, now()); return getEditSteps(db, B, R) }
  let cells: Record<string, string> | null
  try { cells = await deps.readRowCells(row.source_key, row.sheet_row, [MEEGLE_ID_COLUMN]) } catch (e) { return fail(`讀不到 Sheet 第 ${row.sheet_row} 列：${(e as Error).message}`) }
  if (!cells) return fail(`Sheet 找不到「${MEEGLE_ID_COLUMN}」欄`)
  if (parseMeegleIdCell(cells[MEEGLE_ID_COLUMN] ?? '') !== row.work_item_id) return fail(`第 ${row.sheet_row} 列的 Meegle 單號現在是「${cells[MEEGLE_ID_COLUMN] || '（空白）'}」，不是 #${row.work_item_id}，沒有回填`)
  let r: { ok: boolean; error?: string }
  try { r = await deps.writeRow(row.source_key, row.sheet_row, { '處理階段': EDIT_STAGE_DONE, '處理時間': deps.fmtTime(now()) }) } catch (e) { r = { ok: false, error: (e as Error).message } }
  if (!r.ok) return fail(r.error ?? '未知錯誤')
  finishEditStep(db, B, R, 'writeback', 'done', null, undefined, now())
  return getEditSteps(db, B, R)
}

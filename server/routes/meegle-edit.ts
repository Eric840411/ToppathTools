/**
 * Meegle 批量修改（`/api/meegle/edit/*`，Jira 頁「Meegle 修改」分頁）。
 *
 * 身分：只用登入者本人的 Meegle 綁定（跟 Jira 批量修改一樣，沒有代理）。權限：page key `jira`。
 * 預覽與送出都由後端 resolve（CodeX）：前端只送 Sheet 原文；預覽回 planHash，送出時重算比對，不同就要求重新預覽。
 * 流程與防護：server/meegle-edit-run.ts；紀錄：meegle-edit-store.ts；共用規則：shared/meegle-edit-rules.ts。
 * 雙空間（v5.10.0）：新請求必帶 space；動到既有單之前先核對單子真的在那個空間（server/meegle-space.ts）。
 * 設計：docs/features/28-meegle.md「28e」
 */
import { Router, type Request, type Response } from 'express'
import { createReadStream, existsSync } from 'fs'
import { createHash } from 'crypto'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { accountHasPermission, addHistory, db, getClientIP, log, writeLimiter } from '../shared.js'
import { sheetSourceKey } from '../../shared/lark-sheet-url.js'
import { getAccountRow } from '../meegle-account-service.js'
import { decryptMeegleToken } from '../meegle-token-crypto.js'
import { defaultRunner, resolveDetailUrlBase, resolveRoleIds, type CallOutcome } from '../meegle-workitem.js'
import { checkItemSpace, otherSpaceOf, rowSpace, spaceEnv, spaceGuardMessage, spaceSchema, type MeegleSpace } from '../meegle-space.js'
import { listEditOptions, readEditCurrent, roleOperate, updateFields, uploadDescriptionImage } from '../meegle-edit-ops.js'
import { textFingerprint } from '../meegle-comment-ops.js'
import { listPersonMap } from '../meegle-batch-store.js'
import { EDIT_FIELDS, displayCurrent, resolveEdit, resolveRow, sameValue, type ResolveCtx } from '../../shared/meegle-edit-rules.js'
import type { MappedPerson, MeegleRoleKey } from '../../shared/meegle-batch-rules.js'
import {
  expireStaleEditSteps, getEditRow, getEditSteps, initMeegleEditSchema, listPreviousEditForSource, type EditStepRow,
} from '../meegle-edit-store.js'
import { continueEditRow, planHash, runEditRow, type EditDeps } from '../meegle-edit-run.js'
import { busyHandler, withWritebackBusy } from '../meegle-writeback-busy.js'
import { fmtTime, larkReadRowCells, larkWritebackDeps, withSheetLock } from '../meegle-sheet-writeback.js'
import { cachePath, holdLease, isCacheId, touchCacheFile } from '../jira-attachment-files.js'

export const router = Router()
initMeegleEditSchema(db)

export const STALE_MS = 10 * 60_000

type Ctx = { email: string; token: string }
function requireSelf(req: Request, res: Response): Ctx | null {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, code: 'NOT_LOGGED_IN', message: '請先登入' }); return null }
  if (!accountHasPermission(account.email, account.role, 'jira')) { res.status(403).json({ ok: false, code: 'FORBIDDEN', message: '沒有批量工具的權限' }); return null }
  const email = account.email.toLowerCase()
  const row = getAccountRow(db, email)
  if (!row) { res.status(409).json({ ok: false, code: 'NOT_BOUND', message: '你還沒綁定 Meegle' }); return null }
  if (row.status !== 'valid') { res.status(409).json({ ok: false, code: 'BINDING_INVALID', message: '你的 Meegle 綁定已失效，請重新綁定' }); return null }
  try { return { email, token: decryptMeegleToken(row.token_enc) } } catch {
    res.status(409).json({ ok: false, code: 'DECRYPT_FAILED', message: '你的 Meegle token 解不開，請重新綁定' }); return null
  }
}

function personMap(): Record<string, MappedPerson> {
  return Object.fromEntries(listPersonMap(db).map(p => [p.alias, { userKey: p.meegle_user_key, email: p.meegle_email, name: p.meegle_name }]))
}

/** 選項與角色 id 依「token＋空間」快取 5 分鐘（每列預覽都要用，不要每列打兩次 meta）。兩個空間的選項可能不同，不能共用 */
const ctxCache = new Map<string, { at: number; value: { options: ResolveCtx['options']; roleIds: Record<MeegleRoleKey, string> } }>()
async function resolveCtxFor(token: string, space: MeegleSpace, fresh = false): Promise<CallOutcome<ResolveCtx & { roleIds: Record<MeegleRoleKey, string> }>> {
  const ck = `${space}|${token}`
  const hit = ctxCache.get(ck)
  if (!fresh && hit && Date.now() - hit.at < 5 * 60_000) return { kind: 'ok', value: { ...hit.value, personMap: personMap() } }
  const env = spaceEnv(space)
  const [opts, roles] = await Promise.all([listEditOptions(token, defaultRunner, env), resolveRoleIds(token, defaultRunner, env)])
  if (opts.kind !== 'ok') return opts
  if (roles.kind !== 'ok') return roles
  ctxCache.set(ck, { at: Date.now(), value: { options: opts.value, roleIds: roles.value } })
  return { kind: 'ok', value: { options: opts.value, roleIds: roles.value, personMap: personMap() } }
}

/** 圖片的穩定識別：檔案內容 sha256 前 16 碼（同評論） */
function fileKey(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex').slice(0, 16)))
  })
}

const rawSchema = z.union([
  z.object({ key: z.string().max(40), op: z.literal('set'), raw: z.string().max(100_000) }),
  z.object({ key: z.string().max(40), op: z.literal('clear') }),
])
const imageSchema = z.object({ cacheId: z.string().refine(isCacheId, '附件快取 id 不合法'), name: z.string().min(1).max(300) })

function publicSteps(steps: EditStepRow[]) {
  return steps.map(s => ({ step: s.step, phase: s.phase, message: s.message, attemptAt: s.attempt_at }))
}

// POST /api/meegle/edit/meta —— 欄位清單、單選選項、已對照的人、單子網址前綴
router.post('/api/meegle/edit/meta', async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const { space } = z.object({ space: spaceSchema }).parse(req.body)
    const [c, base] = await Promise.all([resolveCtxFor(ctx.token, space, true), resolveDetailUrlBase(ctx.token, defaultRunner, spaceEnv(space))])
    if (c.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀不到 Meegle 欄位設定：${c.message}` })
    res.json({
      ok: true, fields: EDIT_FIELDS, options: c.value.options, detailBase: base.kind === 'ok' ? base.value : '',
      people: Object.entries(c.value.personMap).map(([alias, p]) => ({ alias, name: p.name, email: p.email })),
    })
  } catch (e) { next(e) }
})

// POST /api/meegle/edit/preview —— ③ 一列的預覽：後端 resolve、讀目前值、算 planHash（前端逐列呼叫、同時最多 3 張）
router.post('/api/meegle/edit/preview', async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const b = z.object({ workItemId: z.string().regex(/^\d{5,}$/), raws: z.array(rawSchema).max(40), images: z.array(imageSchema).max(30).default([]), space: spaceSchema }).parse(req.body)
    // 預覽就核對空間（Meegle 不驗 project key）
    const own = await checkItemSpace(ctx.token, b.workItemId, b.space)
    if (own.kind === 'rejected') return res.status(409).json({ ok: false, code: 'WRONG_SPACE', message: own.message })
    if (own.kind !== 'ok') return res.status(502).json({ ok: false, message: `確認 #${b.workItemId} 所屬空間失敗：${own.message}` })
    const c = await resolveCtxFor(ctx.token, b.space)
    if (c.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀不到 Meegle 欄位設定：${c.message}` })
    const cur = await readEditCurrent(ctx.token, b.workItemId, c.value.roleIds, defaultRunner, spaceEnv(b.space))
    if (cur.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀不到 #${b.workItemId}：${cur.message}` })
    const plan = resolveRow(b.raws, c.value)
    const missingImg = b.images.filter(i => !existsSync(cachePath(i.cacheId)))
    if (missingImg.length) plan.issues.push(`圖片快取已過期：${missingImg.map(i => i.name).join('、')}，請重新載入附件`)
    const keys = missingImg.length ? [] : await Promise.all(b.images.map(i => fileKey(cachePath(i.cacheId))))
    const people = { ...cur.value.people, ...Object.fromEntries(Object.values(c.value.personMap).map(p => [p.userKey, p.name || p.email])) }
    const disp = (key: string) => displayCurrent(key, cur.value.values[key], { options: c.value.options, people })
    res.json({
      ok: true, issues: plan.issues, planHash: planHash(plan.edits, keys.map(key => ({ key }))),
      // 預覽原值：送出時覆寫保護用。只回要改的欄位＋描述（只加圖時也要比對描述）
      baseline: Object.fromEntries([...plan.edits.map(e => e.key), 'description'].map(k => [k, cur.value.values[k] ?? ''])),
      // 換不出來的欄位也列出來（紅字＋原因），使用者才能在這一列用 ✎ 修正或改成不改——不列的話受阻了卻找不到要改哪裡（walkthrough 抓到的）
      changes: b.raws.map(r => {
        const res = resolveEdit(r, c.value)
        if ('edit' in res) return { key: r.key, from: disp(r.key), to: res.edit.display, same: sameValue(res.edit, cur.value.values[r.key], textFingerprint) }
        return { key: r.key, from: disp(r.key), to: r.op === 'set' ? r.raw : '（清空）', same: false, error: res.reason }
      }),
      currentDescription: String(cur.value.values.description ?? ''),
    })
  } catch (e) { next(e) }
})

// POST /api/meegle/edit/previous —— 這份 Sheet 之前送過的列（接回失敗待重試、補寫回）
router.post('/api/meegle/edit/previous', (req, res, next) => {
  try {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const { sheetUrl, space } = z.object({ sheetUrl: z.string().min(1).max(2000), space: spaceSchema }).parse(req.body)
    expireStaleEditSteps(db, STALE_MS)
    const key = sheetSourceKey(sheetUrl)
    res.json({ ok: true, otherSpace: otherSpaceOf(db, key, space), rows: listPreviousEditForSource(db, key, space).map(r => ({ batchId: r.batch_id, workItemId: r.work_item_id, sheetRow: r.sheet_row, summary: r.summary, mine: r.owner_email === account.email.toLowerCase(), steps: publicSteps(r.steps) })) })
  } catch (e) { next(e) }
})

function depsFor(token: string, space: MeegleSpace): EditDeps {
  const writer = larkWritebackDeps()
  const env = spaceEnv(space)
  return {
    db,
    resolveCtx: () => resolveCtxFor(token, space, true),   // 送出一律重讀（快取的選項可能過期）
    readCurrent: async id => {
      const roles = await resolveCtxFor(token, space)
      if (roles.kind !== 'ok') return roles
      const r = await readEditCurrent(token, id, roles.value.roleIds, defaultRunner, env)
      return r.kind === 'ok' ? { kind: 'ok', value: r.value.values } : r
    },
    updateFields: (id, f) => updateFields(token, id, f, defaultRunner, env),
    roleOperate: (id, op, roleId, keys) => roleOperate(token, id, op, roleId, keys, defaultRunner, env),
    uploadImage: (id, path, name) => uploadDescriptionImage(token, id, path, name, defaultRunner, env),
    readRowCells: larkReadRowCells,
    writeRow: (key, row, cols) => withSheetLock(key, () => writer.writeRow(key, row, cols)),
    fmtTime,
    normText: textFingerprint,
  }
}

// POST /api/meegle/edit/row —— 送出一列
router.post('/api/meegle/edit/row', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const b = z.object({
      batchId: z.string().uuid(), sheetUrl: z.string().min(1).max(2000), sheetRow: z.number().int().min(2), summary: z.string().max(2000).default(''),
      workItemId: z.string().regex(/^\d{5,}$/), raws: z.array(rawSchema).max(40), images: z.array(imageSchema).max(30).default([]),
      baseline: z.record(z.string(), z.union([z.string().max(200_000), z.array(z.string().max(100)).max(50)])), planHash: z.string().regex(/^[0-9a-f]{64}$/),
      space: spaceSchema,
    }).parse(req.body)
    const own = await checkItemSpace(ctx.token, b.workItemId, b.space)
    if (own.kind === 'rejected') return res.status(409).json({ ok: false, code: 'WRONG_SPACE', message: own.message })
    if (own.kind !== 'ok') return res.status(502).json({ ok: false, message: `確認 #${b.workItemId} 所屬空間失敗：${own.message}` })
    const missing = b.images.filter(i => !existsSync(cachePath(i.cacheId)))
    if (missing.length) return res.status(410).json({ ok: false, code: 'ATTACHMENT_EXPIRED', message: `圖片快取已過期：${missing.map(m => m.name).join('、')}，請回 ③ 重新載入` })
    for (const i of b.images) touchCacheFile(cachePath(i.cacheId))
    expireStaleEditSteps(db, STALE_MS)
    const lease = holdLease(b.images.map(i => i.cacheId))
    try {
      const images = await Promise.all(b.images.map(async i => ({ name: i.name, path: cachePath(i.cacheId), key: await fileKey(cachePath(i.cacheId)) })))
      const result = await runEditRow(depsFor(ctx.token, b.space), {
        batchId: b.batchId, workItemId: b.workItemId, sourceKey: sheetSourceKey(b.sheetUrl), sheetUrl: b.sheetUrl, sheetRow: b.sheetRow, summary: b.summary,
        ownerEmail: ctx.email, payload: '', space: b.space, content: { raws: b.raws, baseline: b.baseline, planHash: b.planHash, images },
      })
      if (result.claim.kind === 'space-mismatch' || result.claim.kind === 'space-conflict') {
        return res.status(409).json({ ok: false, code: result.claim.kind === 'space-conflict' ? 'SPACE_CONFLICT' : 'SPACE_MISMATCH', message: spaceGuardMessage(result.claim, b.space) })
      }
      const bad = result.steps.find(s => s.phase === 'failed')
      log(bad ? 'warn' : 'ok', getClientIP(req), ctx.email, 'Meegle 修改', `${b.space === 'prod' ? '［正式］' : '［測試］'}#${b.workItemId} ${bad ? `${bad.step} 失敗` : result.claim.kind === 'claimed' ? '完成' : result.claim.kind}`)
      res.json({ ok: true, claim: result.claim, steps: publicSteps(result.steps) })
    } finally { lease.release() }
  } catch (e) { next(e) }
})

// POST /api/meegle/edit/row/retry —— 重試失敗的步驟（用上次存的內容；圖片沿用已上傳的網址）
// 整個 handler 期間都標成「正在補寫」：包含前面核對空間的等待；斷線也要等 handler 跑完才放（CodeX review 1e123a9／074271b）
router.post('/api/meegle/edit/row/retry', writeLimiter, busyHandler('edit', b => ({ batchId: b.batchId, rowKey: b.rowKey }), async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const b = z.object({ batchId: z.string().uuid(), rowKey: z.string().regex(/^\d{5,}$/) }).parse(req.body)
    const row = getEditRow(db, b.batchId, b.rowKey)
    if (!row || row.owner_email !== ctx.email) return res.status(404).json({ ok: false, message: '找不到這一列' })
    // 空間用紀錄上的；重試前一樣核對單子所屬空間
    const space = rowSpace(row.space)
    const own = await checkItemSpace(ctx.token, row.work_item_id, space)
    if (own.kind === 'rejected') return res.status(409).json({ ok: false, code: 'WRONG_SPACE', message: own.message })
    if (own.kind !== 'ok') return res.status(502).json({ ok: false, message: `確認 #${row.work_item_id} 所屬空間失敗：${own.message}` })
    expireStaleEditSteps(db, STALE_MS)
    const steps = await withWritebackBusy('edit', b.batchId, b.rowKey, () => continueEditRow(depsFor(ctx.token, space), b.batchId, b.rowKey, { retry: true }))
    log('ok', getClientIP(req), ctx.email, 'Meegle 修改', `#${b.rowKey} 重試`)
    res.json({ ok: true, steps: publicSteps(steps) })
  } catch (e) { next(e) }
}))

// POST /api/meegle/edit/finish —— 一批結束寫操作紀錄
router.post('/api/meegle/edit/finish', (req, res, next) => {
  try {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const email = account.email.toLowerCase()
    const { batchId, sheetUrl } = z.object({ batchId: z.string().uuid(), sheetUrl: z.string().max(2000) }).parse(req.body)
    const rows = db.prepare('SELECT * FROM meegle_edit_rows WHERE batch_id = ? AND owner_email = ? ORDER BY created_at').all(batchId, email) as Array<{ row_key: string; work_item_id: string; summary: string; sheet_row: number; payload: string; space: string }>
    if (!rows.length) return res.json({ ok: true })
    const detail = rows.map(r => {
      let fields: string[] = []
      try { fields = (JSON.parse(r.payload) as { raws: Array<{ key: string; op: string }> }).raws.map(x => `${x.key}${x.op === 'clear' ? '（清空）' : ''}`) } catch { /* ignore */ }
      return { workItemId: r.work_item_id, summary: r.summary, sheetRow: r.sheet_row, fields, steps: publicSteps(getEditSteps(db, batchId, r.row_key)) }
    })
    const okCount = detail.filter(d => d.steps.every(s => s.phase === 'done' || s.phase === 'skipped')).length
    const space = rowSpace(rows[0].space)
    addHistory('meegle-batch-edit', 'Meegle 批量修改', `［${space === 'prod' ? '正式' : '測試'}］完成 ${okCount}／${rows.length} 張`, { batchId, sheetUrl, space, rows: detail })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

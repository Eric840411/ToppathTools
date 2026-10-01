/**
 * Meegle 批量開單（`/api/meegle/batch/*`）。
 *
 * 身分：只認登入 cookie，用**本人綁定的** Meegle token 操作；前端沒有任何參數能指定用誰的 token（CodeX review）。
 * 權限：跟 Jira 批量工具同一個 page key（`jira`）。
 * 列規則（能不能送、人員怎麼對）在 shared/meegle-batch-rules.ts，預覽與這裡用同一份。
 * 防重複開單的落地紀錄在 meegle-batch-store.ts。CLI 契約與踩坑在 meegle-workitem.ts 檔頭。
 *
 * 詳細設計：docs/features/28-meegle.md
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { accountHasPermission, addHistory, db, getClientIP, log, writeLimiter } from '../shared.js'
import { getAccountRow } from '../meegle-account-service.js'
import { decryptMeegleToken } from '../meegle-token-crypto.js'
import {
  claimRow, expireStaleCreating, finishCreate, finishState, getBatchRow, getPersonMap, initMeegleBatchSchema,
  listCreatedFromSheet, listPersonMap, resolveUnknown, upsertPersonMap, type BatchRow,
} from '../meegle-batch-store.js'
import {
  confirmRequirement, createTask, findTasksByName, findUserViaParticipants, listRequirements, listTaskStates,
  meegleTarget, resolveRoleIds, resolveUsersByEmail, transitionToState,
} from '../meegle-workitem.js'
import { MEEGLE_ROLE_DEFS, normAlias, type MeegleRoleKey } from '../../shared/meegle-batch-rules.js'

export const router = Router()
initMeegleBatchSchema(db)

/** 開單途中伺服器重啟會留下 creating；超過這個時間就轉成「結果待確認」。CLI 單次逾時 45 秒，留足餘裕。 */
const STALE_CREATING_MS = 5 * 60_000

type Ctx = { email: string; label: string; token: string }

/** 登入＋權限＋取出本人 token。失敗時已回應，回傳 null。 */
function requireCtx(req: Request, res: Response): Ctx | null {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, code: 'NOT_LOGGED_IN', message: '請先登入' }); return null }
  if (!accountHasPermission(account.email, account.role, 'jira')) {
    res.status(403).json({ ok: false, code: 'FORBIDDEN', message: '沒有批量開單的權限' }); return null
  }
  const row = getAccountRow(db, account.email)
  if (!row) { res.status(409).json({ ok: false, code: 'NOT_BOUND', message: '還沒綁定 Meegle，請先到「個人帳號」綁定' }); return null }
  if (row.status !== 'valid') { res.status(409).json({ ok: false, code: 'BINDING_INVALID', message: 'Meegle 綁定已失效，請到「個人帳號」重新綁定' }); return null }
  let token: string
  try { token = decryptMeegleToken(row.token_enc) } catch {
    res.status(409).json({ ok: false, code: 'DECRYPT_FAILED', message: 'Meegle token 解不開（伺服器金鑰可能換過），請重新綁定' }); return null
  }
  return { email: account.email.toLowerCase(), label: account.label, token }
}

function publicRow(r: BatchRow | undefined) {
  if (!r) return null
  return { rowKey: r.row_key, createPhase: r.create_phase, workItemId: r.work_item_id, url: r.url, statePhase: r.state_phase, message: r.message }
}

// GET /api/meegle/batch/meta —— 需求清單、可推到的狀態、目標空間
router.get('/api/meegle/batch/meta', async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res)
    if (!ctx) return
    const [reqs, states] = await Promise.all([listRequirements(ctx.token), listTaskStates(ctx.token)])
    if (reqs.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀取需求清單失敗：${reqs.message}` })
    res.json({
      ok: true,
      projectKey: meegleTarget().projectKey,
      requirements: reqs.value,
      // 狀態讀不到不影響開單，只是「開單後推到」選單會是空的
      states: states.kind === 'ok' ? states.value : [],
      statesError: states.kind === 'ok' ? null : states.message,
    })
  } catch (e) { next(e) }
})

// GET /api/meegle/batch/people —— 人員對照表（全部，或只查指定的名字）
router.get('/api/meegle/batch/people', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  const people = listPersonMap(db).map(p => ({ alias: p.alias, userKey: p.meegle_user_key, email: p.meegle_email, name: p.meegle_name, updatedBy: p.updated_by, updatedAt: p.updated_at }))
  res.json({ ok: true, people })
})

// POST /api/meegle/batch/previous —— 這份 Sheet 之前開過哪些單（跨批次），預覽標「已開過」避免重開
router.post('/api/meegle/batch/previous', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  const { sheetUrl } = z.object({ sheetUrl: z.string().max(2000) }).parse(req.body)
  res.json({ ok: true, rows: listCreatedFromSheet(db, sheetUrl).map(r => ({ rowKey: r.row_key, name: r.name, workItemId: r.work_item_id, url: r.url, createdAt: r.created_at })) })
})

// POST /api/meegle/batch/people/verify —— 填 email → 查 Meegle 帳號 → 記住對照
router.post('/api/meegle/batch/people/verify', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res)
    if (!ctx) return
    const { alias, email } = z.object({ alias: z.string().trim().min(1).max(100), email: z.string().trim().email().max(200) }).parse(req.body)
    const search = await resolveUsersByEmail(ctx.token, [email])
    if (search.kind !== 'ok') return res.status(502).json({ ok: false, code: 'UNAVAILABLE', message: `查詢 Meegle 失敗：${search.message}` })
    let match = search.value[email.toLowerCase()]
    // server tsconfig 沒開 strictNullChecks，聯集要用 'reason' in 縮小
    if ('reason' in match && match.reason === 'NOT_FOUND') {
      // 退路：user search 不是完整名錄（實測 Tim），改從既有單子的參與人找，email 必須完全相同
      const local = email.split('@')[0]
      const candidates = [alias, alias.split(/\s+/)[0], local, local.charAt(0).toUpperCase() + local.slice(1)]
      const viaItems = await findUserViaParticipants(ctx.token, email, candidates)
      if (viaItems.kind !== 'ok') return res.status(502).json({ ok: false, code: 'UNAVAILABLE', message: `查詢 Meegle 失敗：${viaItems.message}` })
      match = viaItems.value
    }
    if ('reason' in match) return res.status(422).json({ ok: false, code: match.reason, message: match.message })
    upsertPersonMap(db, alias, { userKey: match.userKey, email: match.email, name: match.name }, ctx.email)
    log('ok', getClientIP(req), ctx.email, 'Meegle 人員對照', `${alias} → ${match.email}`)
    res.json({ ok: true, person: { alias: normAlias(alias), userKey: match.userKey, email: match.email, name: match.name } })
  } catch (e) { next(e) }
})

const rowSchema = z.object({
  batchId: z.string().uuid(),
  rowKey: z.string().min(1).max(40),
  sheetUrl: z.string().max(2000).optional().default(''),
  name: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).optional().default(''),
  requirementId: z.string().regex(/^\d+$/),
  // 值是 Sheet 上的人名；伺服器自己查對照表換成 user_key，不收前端給的 user_key
  roles: z.record(z.enum(MEEGLE_ROLE_DEFS.map(r => r.key) as [MeegleRoleKey, ...MeegleRoleKey[]]), z.array(z.string().max(100)).max(20)),
  targetStateKey: z.string().max(100).optional().default(''),
})

async function pushState(ctx: Ctx, batchId: string, rowKey: string, workItemId: string, targetStateKey: string) {
  if (!targetStateKey) return
  const t = await transitionToState(ctx.token, workItemId, targetStateKey)
  if (t.kind === 'ok') finishState(db, batchId, rowKey, 'done', null)
  else finishState(db, batchId, rowKey, t.kind === 'rejected' ? 'failed' : 'unknown', t.message)
}

// POST /api/meegle/batch/row —— 開一列（前端逐列呼叫）
router.post('/api/meegle/batch/row', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res)
    if (!ctx) return
    const body = rowSchema.parse(req.body)
    expireStaleCreating(db, STALE_CREATING_MS)

    const claim = claimRow(db, { batchId: body.batchId, rowKey: body.rowKey, ownerEmail: ctx.email, sheetUrl: body.sheetUrl, name: body.name, requirementId: body.requirementId, targetState: body.targetStateKey })
    if (claim.kind === 'not-owner') return res.status(403).json({ ok: false, message: '這一列是別人送出的' })
    if (claim.kind === 'busy') return res.json({ ok: true, row: publicRow(claim.row) })
    if (claim.kind === 'already-created') {
      // 已經開過：只補推狀態，不重開
      if (claim.row.state_phase !== 'done' && body.targetStateKey && claim.row.work_item_id) {
        await pushState(ctx, body.batchId, body.rowKey, claim.row.work_item_id, body.targetStateKey)
      }
      return res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) })
    }

    // 認領成功後的任何提早結束，都要把 creating 收掉（否則這列會卡成「結果待確認」）
    const fail = (message: string) => { finishCreate(db, body.batchId, body.rowKey, { phase: 'failed', message }); return res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) }) }

    // 送出前再確認需求還在（預覽之後可能被刪掉或搬走）
    const reqCheck = await confirmRequirement(ctx.token, body.requirementId)
    if (reqCheck.kind !== 'ok') return fail(`確認關聯需求失敗：${reqCheck.message}`)
    if (!reqCheck.value) return fail('關聯需求已不存在或不在允許的空間')

    const roleIds = await resolveRoleIds(ctx.token)
    if (roleIds.kind !== 'ok') return fail(roleIds.message)

    const map = getPersonMap(db, Object.values(body.roles).flat())
    const roles: Partial<Record<MeegleRoleKey, string[]>> = {}
    const unmapped: string[] = []
    for (const [key, aliases] of Object.entries(body.roles) as [MeegleRoleKey, string[]][]) {
      const keys: string[] = []
      for (const a of aliases) {
        const p = map[normAlias(a)]
        if (p) { if (!keys.includes(p.meegle_user_key)) keys.push(p.meegle_user_key) }
        else if (a.trim()) unmapped.push(a.trim())
      }
      roles[key] = keys
    }

    const created = await createTask(ctx.token, { name: body.name, description: body.description, requirementId: body.requirementId, roles }, roleIds.value)
    if (created.kind === 'rejected') return fail(created.message)
    if (created.kind === 'unknown') {
      finishCreate(db, body.batchId, body.rowKey, { phase: 'unknown', message: created.message })
      return res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) })
    }
    finishCreate(db, body.batchId, body.rowKey, { phase: 'created', workItemId: created.value.workItemId, url: created.value.url })
    log('ok', getClientIP(req), ctx.email, 'Meegle 開單', `#${created.value.workItemId} ${body.name}${unmapped.length ? `（未對照留空：${[...new Set(unmapped)].join('、')}）` : ''}`)
    await pushState(ctx, body.batchId, body.rowKey, created.value.workItemId, body.targetStateKey)
    res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)), unmapped: [...new Set(unmapped)] })
  } catch (e) { next(e) }
})

// POST /api/meegle/batch/row/retry-state —— 已開單但推狀態失敗：只重推狀態
router.post('/api/meegle/batch/row/retry-state', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res)
    if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().min(1).max(40), targetStateKey: z.string().min(1).max(100) }).parse(req.body)
    const row = getBatchRow(db, body.batchId, body.rowKey)
    if (!row || row.owner_email !== ctx.email) return res.status(404).json({ ok: false, message: '找不到這一列' })
    if (row.create_phase !== 'created' || !row.work_item_id) return res.status(409).json({ ok: false, message: '這一列還沒開單成功' })
    await pushState(ctx, body.batchId, body.rowKey, row.work_item_id, body.targetStateKey)
    res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) })
  } catch (e) { next(e) }
})

// POST /api/meegle/batch/row/confirm —— 結果待確認：去 Meegle 查到底有沒有開出來
router.post('/api/meegle/batch/row/confirm', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res)
    if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().min(1).max(40) }).parse(req.body)
    expireStaleCreating(db, STALE_CREATING_MS)
    const row = getBatchRow(db, body.batchId, body.rowKey)
    if (!row || row.owner_email !== ctx.email) return res.status(404).json({ ok: false, message: '找不到這一列' })
    if (row.create_phase !== 'unknown') return res.json({ ok: true, row: publicRow(row) })

    // 建立日期只到「日」，往前多抓一天避免跨日／時區
    const since = new Date(row.created_at - 24 * 3600_000).toISOString().slice(0, 10)
    const found = await findTasksByName(ctx.token, row.name, row.requirement_id, since)
    if (found.kind !== 'ok') return res.status(502).json({ ok: false, message: `查詢失敗：${found.message}` })
    // 排除已經記在別列的單號（同一批裡可能有同名的列）
    const taken = new Set((db.prepare('SELECT work_item_id FROM meegle_batch_rows WHERE work_item_id IS NOT NULL').all() as { work_item_id: string }[]).map(r => r.work_item_id))
    const candidates = found.value.filter(f => !taken.has(f.workItemId))
    if (candidates.length === 1) {
      const id = candidates[0].workItemId
      const t = meegleTarget()
      resolveUnknown(db, body.batchId, body.rowKey, { workItemId: id, url: `https://project.larksuite.com/${t.projectKey}/${t.taskTypeKey}/detail/${id}` })
    } else if (candidates.length === 0) {
      resolveUnknown(db, body.batchId, body.rowKey, null)
    } else {
      // 多張同名同需求的單都可能是它 → 不替人選，維持待確認
      return res.json({ ok: true, row: publicRow(row), candidates: candidates.map(c => c.workItemId), message: `Meegle 上有 ${candidates.length} 張同名的單，請到 Meegle 確認` })
    }
    res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) })
  } catch (e) { next(e) }
})

// POST /api/meegle/batch/finish —— 一批送完，寫一筆操作歷史
router.post('/api/meegle/batch/finish', writeLimiter, (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  const { batchId } = z.object({ batchId: z.string().uuid() }).parse(req.body)
  const rows = db.prepare('SELECT * FROM meegle_batch_rows WHERE batch_id = ? AND owner_email = ?').all(batchId, account.email.toLowerCase()) as BatchRow[]
  const count = (p: string) => rows.filter(r => r.create_phase === p).length
  addHistory('meegle-batch-create', 'Meegle 批次開單',
    `開單 ${count('created')} 筆${count('unknown') ? `，待確認 ${count('unknown')} 筆` : ''}${count('failed') ? `，失敗 ${count('failed')} 筆` : ''}`,
    { batchId, rows: rows.map(r => ({ row: r.row_key, phase: r.create_phase, workItemId: r.work_item_id, state: r.state_phase, message: r.message })) })
  res.json({ ok: true })
})

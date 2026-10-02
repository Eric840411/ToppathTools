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
import { sheetSourceKey } from '../../shared/lark-sheet-url.js'
import { larkWritebackDeps, writebackRow } from '../meegle-sheet-writeback.js'

/** 回填 Sheet（失敗不影響開單；結果落在 writeback_phase，④ 顯示、可補寫回） */
async function writeback(batchId: string, rowKey: string, force = false) {
  try { await writebackRow(db, batchId, rowKey, larkWritebackDeps(), { force }) } catch (e) { console.warn('[Meegle] 回填 Sheet 失敗：', e) }
}
import { getAccountRow } from '../meegle-account-service.js'
import { decryptMeegleToken } from '../meegle-token-crypto.js'
import {
  adoptTarget, claimRow, expireStaleCreating, finishCreate, finishState, getBatchRow, getPersonMap, initMeegleBatchSchema,
  listPersonMap, listRowsFromSheet, needsStatePush, resolveUnknown, writebackStageText, upsertPersonMap, type BatchRow,
} from '../meegle-batch-store.js'
import {
  confirmRequirement, createTask, detailUrlFor, findTasksByName, findUserViaParticipants, listRequirements, listTaskStates,
  meegleTarget, resolveRoleIds, resolveUsersByEmail, transitionToState,
} from '../meegle-workitem.js'
import { MEEGLE_ROLE_DEFS, normAlias, type MeegleRoleKey } from '../../shared/meegle-batch-rules.js'

export const router = Router()
initMeegleBatchSchema(db)

// 舊紀錄存的是完整網址，啟動時換成識別值（只動還不是 lark: 開頭的）
{
  const urls = db.prepare(`SELECT DISTINCT sheet_url FROM meegle_batch_rows WHERE sheet_url != '' AND sheet_url NOT LIKE 'lark:%'`).all() as { sheet_url: string }[]
  const upd = db.prepare('UPDATE meegle_batch_rows SET sheet_url = ? WHERE sheet_url = ?')
  for (const { sheet_url } of urls) upd.run(sheetSourceKey(sheet_url), sheet_url)
}

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
  if (!row) { res.status(409).json({ ok: false, code: 'NOT_BOUND', message: '還沒綁定 Meegle，請先到側欄「個人帳號」（修仙版叫「本命道籍」）綁定' }); return null }
  if (row.status !== 'valid') { res.status(409).json({ ok: false, code: 'BINDING_INVALID', message: 'Meegle 綁定已失效，請到側欄「個人帳號」（修仙版叫「本命道籍」）重新綁定' }); return null }
  let token: string
  try { token = decryptMeegleToken(row.token_enc) } catch {
    res.status(409).json({ ok: false, code: 'DECRYPT_FAILED', message: 'Meegle token 解不開（伺服器金鑰可能換過），請重新綁定' }); return null
  }
  return { email: account.email.toLowerCase(), label: account.label, token }
}

function publicRow(r: BatchRow | undefined) {
  if (!r) return null
  // targetStateKey 一律回紀錄裡的，前端不自己記（CodeX review 4bc4fa9 [P2]）
  return { batchId: r.batch_id, rowKey: r.row_key, targetStateKey: r.target_state, writebackPhase: r.writeback_phase, writebackMsg: r.writeback_msg, createPhase: r.create_phase, workItemId: r.work_item_id, url: r.url, statePhase: r.state_phase, message: r.message }
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
  // 含開單中／待確認的列與它們的 batchId：重整頁面後前端靠這個把原批次接回來（CodeX review 999f895 [P1]）
  res.json({ ok: true, rows: listRowsFromSheet(db, sheetSourceKey(sheetUrl)).map(r => ({ ...publicRow(r), name: r.name, owner: r.owner_email, createdAt: r.created_at })) })
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
  /** 目標狀態的顯示名稱，只用在回填 Sheet「處理階段」的文字 */
  targetStateName: z.string().max(100).optional().default(''),
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

    const claim = claimRow(db, { batchId: body.batchId, rowKey: body.rowKey, ownerEmail: ctx.email, sheetUrl: sheetSourceKey(body.sheetUrl), name: body.name, requirementId: body.requirementId, targetState: body.targetStateKey, targetStateName: body.targetStateName })
    if (claim.kind === 'source-mismatch') return res.status(409).json({ ok: false, code: 'SOURCE_MISMATCH', message: '這個批次是另一份 Sheet 的，請重新讀取 Sheet 後再送' })
    if (claim.kind === 'not-owner') return res.status(403).json({ ok: false, message: '這一列是別人送出的' })
    if (claim.kind === 'busy') return res.json({ ok: true, row: publicRow(claim.row) })
    if (claim.kind === 'already-created') {
      // 已經開過：不重開，**也不在這裡推狀態**（CodeX review 0c30dde [P2]×2）——
      // 這筆可能是別人開的（用我的 token 推別人的單＝繞過 retry-state 的本人限制），
      // 或原本刻意「不推狀態」（另一個分頁帶來的目標不能把它改掉）。要補推一律走明確的「重推狀態」。
      return res.json({ ok: true, row: publicRow(claim.row), message: claim.row.owner_email === ctx.email ? '這一列已經開過，沒有重開' : '這一列別人已經開過，沒有重開' })
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
    // 網址自己組（空間 simple_name／類型 api_name），CLI 回的 url 點了不會跳到單——見 detailUrlFor
    finishCreate(db, body.batchId, body.rowKey, { phase: 'created', workItemId: created.value.workItemId, url: await detailUrlFor(ctx.token, created.value.workItemId) })
    log('ok', getClientIP(req), ctx.email, 'Meegle 開單', `#${created.value.workItemId} ${body.name}${unmapped.length ? `（未對照留空：${[...new Set(unmapped)].join('、')}）` : ''}`)
    await pushState(ctx, body.batchId, body.rowKey, created.value.workItemId, body.targetStateKey)
    // 推完狀態才寫，「處理階段」才寫得對（已推到 X／推到 X 未完成）
    await writeback(body.batchId, body.rowKey)
    res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)), unmapped: [...new Set(unmapped)] })
  } catch (e) { next(e) }
})

// POST /api/meegle/batch/row/retry-state —— 已開單但推狀態失敗：只重推狀態
router.post('/api/meegle/batch/row/retry-state', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res)
    if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().min(1).max(40), targetStateKey: z.string().max(100).optional().default(''), targetStateName: z.string().max(100).optional().default('') }).parse(req.body)
    const row = getBatchRow(db, body.batchId, body.rowKey)
    if (!row || row.owner_email !== ctx.email) return res.status(404).json({ ok: false, message: '找不到這一列' })
    if (row.create_phase !== 'created' || !row.work_item_id) return res.status(409).json({ ok: false, message: '這一列還沒開單成功' })
    const target = adoptTarget(db, body.batchId, body.rowKey, body.targetStateKey, Date.now(), body.targetStateName)
    if (!target) return res.status(400).json({ ok: false, message: '這一列沒有目標狀態，請先在「開單後推到」選一個' })
    await pushState(ctx, body.batchId, body.rowKey, row.work_item_id, target)
    await writeback(body.batchId, body.rowKey)
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
    if (row.create_phase !== 'unknown') {
      if (needsStatePush(row)) await pushState(ctx, row.batch_id, row.row_key, row.work_item_id!, row.target_state)
      if (row.create_phase === 'created') await writeback(body.batchId, body.rowKey)
      return res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) })
    }

    // 建立日期只到「日」，往前多抓一天避免跨日／時區
    const since = new Date(row.created_at - 24 * 3600_000).toISOString().slice(0, 10)
    const found = await findTasksByName(ctx.token, row.name, row.requirement_id, since)
    if (found.kind !== 'ok') return res.status(502).json({ ok: false, message: `查詢失敗：${found.message}` })
    // 排除已經記在別列的單號（同一批裡可能有同名的列）
    const taken = new Set((db.prepare('SELECT work_item_id FROM meegle_batch_rows WHERE work_item_id IS NOT NULL').all() as { work_item_id: string }[]).map(r => r.work_item_id))
    const candidates = found.value.filter(f => !taken.has(f.workItemId))
    if (candidates.length === 1) {
      const id = candidates[0].workItemId
      resolveUnknown(db, body.batchId, body.rowKey, { workItemId: id, url: await detailUrlFor(ctx.token, id) })
      // 查回來的單還沒推過狀態，照原本送出時的目標補推（CodeX review 999f895 [P2]）
      const after = getBatchRow(db, body.batchId, body.rowKey)
      if (after && needsStatePush(after)) await pushState(ctx, after.batch_id, after.row_key, after.work_item_id!, after.target_state)
      await writeback(body.batchId, body.rowKey)
    } else if (candidates.length === 0) {
      resolveUnknown(db, body.batchId, body.rowKey, null)
    } else {
      // 多張同名同需求的單都可能是它 → 不替人選，維持待確認
      return res.json({ ok: true, row: publicRow(row), candidates: candidates.map(c => c.workItemId), message: `Meegle 上有 ${candidates.length} 張同名的單，請到 Meegle 確認` })
    }
    res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) })
  } catch (e) { next(e) }
})

// POST /api/meegle/batch/row/writeback —— 補寫回 Sheet（只用已存的單號，不重開單）
router.post('/api/meegle/batch/row/writeback', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res)
    if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().min(1).max(40) }).parse(req.body)
    const row = getBatchRow(db, body.batchId, body.rowKey)
    if (!row || row.owner_email !== ctx.email) return res.status(404).json({ ok: false, message: '找不到這一列' })
    if (row.create_phase !== 'created') return res.status(409).json({ ok: false, message: '這一列還沒開單成功，沒有東西可以寫回' })
    await writeback(body.batchId, body.rowKey, true)
    res.json({ ok: true, row: publicRow(getBatchRow(db, body.batchId, body.rowKey)) })
  } catch (e) { next(e) }
})

// POST /api/meegle/batch/finish —— 一批送完，寫一筆操作歷史
router.post('/api/meegle/batch/finish', writeLimiter, (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
  const { batchId, sheetUrl, requirementNames } = z.object({
    batchId: z.string().uuid(),
    /** 原始 Sheet 網址（紀錄裡放連結用；DB 只存識別值） */
    sheetUrl: z.string().max(2000).optional().default(''),
    /** 需求 ID → 名稱，紀錄裡顯示用 */
    requirementNames: z.record(z.string(), z.string().max(200)).optional().default({}),
  }).parse(req.body)
  const rows = db.prepare('SELECT * FROM meegle_batch_rows WHERE batch_id = ? AND owner_email = ?').all(batchId, account.email.toLowerCase()) as BatchRow[]
  const count = (p: string) => rows.filter(r => r.create_phase === p).length
  addHistory('meegle-batch-create', 'Meegle 批次開單',
    `開單 ${count('created')} 筆${count('unknown') ? `，待確認 ${count('unknown')} 筆` : ''}${count('failed') ? `，失敗 ${count('failed')} 筆` : ''}`,
    // 追溯用（使用者要求「看得到從哪一列開成哪張單」）：Sheet 連結＋每列的名稱、單號連結、關聯需求、處理階段、回填結果
    {
      batchId, sheetUrl,
      rows: rows.map(r => ({
        row: r.row_key, name: r.name, phase: r.create_phase, workItemId: r.work_item_id, url: r.url,
        requirementId: r.requirement_id, requirementName: requirementNames[r.requirement_id] ?? '',
        state: r.state_phase, stage: r.create_phase === 'created' ? writebackStageText(r) : '',
        writeback: r.writeback_phase, writebackMsg: r.writeback_msg, message: r.message,
      })),
    })
  res.json({ ok: true })
})

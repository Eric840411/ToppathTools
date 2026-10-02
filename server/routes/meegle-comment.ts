/**
 * Meegle 批量評論（`/api/meegle/comment/*`，Jira 頁「Meegle 評論」分頁）。
 *
 * 身分：操作者只認登入 cookie。逐列可用「填寫人」的身分送出，條件（每次送出前後端重驗，CodeX）：
 *   對方綁了 Meegle 且綁定有效＋操作者對他有 `meegle.comment.batch` 代理授權（不繼承 Jira 授權）
 * 權限：page key `jira`（跟 Meegle 開單一樣）；AI 預覽另驗 jira-ai-format／jira-ai-review。
 * 流程與防重送：server/meegle-comment-run.ts；紀錄：meegle-comment-store.ts；Meegle 實測行為：meegle-comment-ops.ts 檔頭。
 *
 * 設計：docs/features/28-meegle.md「批量評論」
 */
import { Router, type Request, type Response } from 'express'
import { createReadStream, existsSync } from 'fs'
import { createHash } from 'crypto'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { accountHasPermission, addHistory, db, getClientIP, hasJiraDelegation, log, matchAccountsByPersonName, writeLimiter } from '../shared.js'
import { sheetSourceKey } from '../../shared/lark-sheet-url.js'
import { getAccountRow } from '../meegle-account-service.js'
import { decryptMeegleToken } from '../meegle-token-crypto.js'
import { addComment, classifyRemote, commentCandidates, descHash, getDescription, listComments, setDescription, uploadFile } from '../meegle-comment-ops.js'
import {
  expireStaleSteps, getCommentRow, getSnapshot, getSteps, initMeegleCommentSchema, listPreviousForSource, resolveUnknownStep, setSnapshot, stepData, type StepRow,
} from '../meegle-comment-store.js'
import { runCommentRow, writebackComment, type RunDeps } from '../meegle-comment-run.js'
import { resolveDetailUrlBase } from '../meegle-workitem.js'
import { fmtTime, larkReadRowCells, larkWritebackDeps, withSheetLock } from '../meegle-sheet-writeback.js'
import { cachePath, holdLease, isCacheId, touchCacheFile } from '../jira-attachment-files.js'
import { buildCompletenessPrompt, buildSpecContext, formatCommentWithAI } from '../comment-ai.js'
import { callLLM } from './gemini.js'
import { withRequestOperation } from '../request-context.js'

export const router = Router()
initMeegleCommentSchema(db)

/** 送出途中伺服器重啟留下的 creating：超過就轉「結果不明」。每列最多好幾次 CLI（各 45 秒），留足餘裕 */
const STALE_MS = 15 * 60_000

type Ctx = { email: string; label: string }

function requireLogin(req: Request, res: Response): Ctx | null {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, code: 'NOT_LOGGED_IN', message: '請先登入' }); return null }
  if (!accountHasPermission(account.email, account.role, 'jira')) { res.status(403).json({ ok: false, code: 'FORBIDDEN', message: '沒有批量工具的權限' }); return null }
  return { email: account.email.toLowerCase(), label: account.label }
}

type Identity = { ok: true; email: string; token: string; userKey: string } | { ok: false; code: string; message: string }

/** 用誰的身分：自己、或有授權的填寫人。綁定與授權每次都即時查，不信前端。 */
function identityFor(actor: string, asEmail: string): Identity {
  const target = (asEmail || actor).trim().toLowerCase()
  if (target !== actor && !hasJiraDelegation(actor, target, 'meegle.comment.batch')) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: `沒有「Meegle 批量評論」代理授權，不能用 ${target} 的身分送出` }
  }
  const row = getAccountRow(db, target)
  if (!row) return { ok: false, code: 'NOT_BOUND', message: `${target} 還沒綁定 Meegle` }
  if (row.status !== 'valid') return { ok: false, code: 'BINDING_INVALID', message: `${target} 的 Meegle 綁定已失效` }
  try { return { ok: true, email: target, token: decryptMeegleToken(row.token_enc), userKey: row.meegle_user_key ?? '' } } catch {
    return { ok: false, code: 'DECRYPT_FAILED', message: `${target} 的 Meegle token 解不開，請重新綁定` }
  }
}

function publicSteps(steps: StepRow[]) {
  // name：影片步驟的檔名（步驟本身用內容 hash 命名，畫面要顯示檔名）
  return steps.map(s => ({ step: s.step, phase: s.phase, message: s.message, attemptAt: s.attempt_at, name: typeof stepData(s).name === 'string' ? stepData(s).name as string : undefined }))
}

/** 影片的穩定識別：檔案內容 sha256 前 16 碼（重新下載 cacheId 會變、排序會變，內容不會）——CodeX review 64f53aa [P1] */
function fileKey(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex').slice(0, 16)))
  })
}

type RowContent = {
  sheetUrl: string; sheetRow: number; summary: string; workItemId: string; asEmail: string
  description: string; images: Array<{ cacheId: string; name: string }>; commentText: string
  videos: Array<{ cacheId: string; name: string }>; reviewText: string | null
}

/** 送出一列（/row 與 /row/continue 共用）。身分、附件快取、租約都在這裡處理 */
async function executeRow(req: Request, ctx: Ctx, batchId: string, c: RowContent, opts: { expectedRemoteHash: string; confirmedRemoteHash: string | null; allowRepeat: boolean }) {
  const id = identityFor(ctx.email, c.asEmail)
  if ('code' in id) return { status: 403, body: { ok: false, code: id.code, message: id.message } }
  const files = [...c.images, ...c.videos]
  const missing = files.filter(f => !existsSync(cachePath(f.cacheId)))
  if (missing.length) return { status: 410, body: { ok: false, code: 'ATTACHMENT_EXPIRED', message: `附件快取已過期：${missing.map(m => m.name).join('、')}，請回 ③ 重新產生預覽` } }
  for (const f of files) touchCacheFile(cachePath(f.cacheId))
  expireStaleSteps(db, STALE_MS)
  const lease = holdLease(files.map(f => f.cacheId))
  try {
    const videos = await Promise.all(c.videos.map(async f => ({ name: f.name, path: cachePath(f.cacheId), key: await fileKey(cachePath(f.cacheId)) })))
    const writer = larkWritebackDeps()
    const deps: RunDeps = {
      db,
      getDescription: wid => getDescription(id.token, wid),
      setDescription: (wid, md) => setDescription(id.token, wid, md),
      uploadFile: (wid, path, name, kind) => uploadFile(id.token, wid, path, name, kind),
      addComment: (wid, content, tok) => addComment(id.token, wid, content, tok),
      readRowCells: larkReadRowCells,
      // 同一份 Sheet 的回填跟開單回填排同一條隊（欄位不存在時會建欄，不能兩個同時建）
      writeRow: (key, row, cols) => withSheetLock(key, () => writer.writeRow(key, row, cols)),
      fmtTime,
    }
    const result = await runCommentRow(deps, {
      batchId, workItemId: c.workItemId, sourceKey: sheetSourceKey(c.sheetUrl), sheetUrl: c.sheetUrl, sheetRow: c.sheetRow, summary: c.summary,
      ownerEmail: ctx.email, asEmail: id.email === ctx.email ? '' : id.email, withReview: c.reviewText != null, allowRepeat: opts.allowRepeat,
      // 內容整包存起來：「繼續送出」從這裡拿，不靠前端草稿
      payload: JSON.stringify(c),
      description: c.description, images: c.images.map(f => ({ name: f.name, path: cachePath(f.cacheId) })),
      commentText: c.commentText, videos, reviewText: c.reviewText,
      expectedRemoteHash: opts.expectedRemoteHash, confirmedRemoteHash: opts.confirmedRemoteHash,
    })
    const failedStep = result.steps.find(st => st.phase === 'failed' || st.phase === 'unknown')
    log(failedStep ? 'warn' : 'ok', getClientIP(req), ctx.email, 'Meegle 評論', `#${c.workItemId}${id.email !== ctx.email ? `（以 ${id.email} 身分）` : ''} ${failedStep ? `${failedStep.step}：${failedStep.phase}` : '完成'}`)
    return { status: 200, body: { ok: true, claim: result.claim, steps: publicSteps(result.steps) } }
  } finally { lease.release() }
}

// POST /api/meegle/comment/meta —— 單子網址的前綴（空間簡稱／類型名稱）。不能在前端寫死：CLI 回的 project_key 網址點不開（v4.269.1）
router.post('/api/meegle/comment/meta', async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const me = identityFor(ctx.email, '')
    if ('code' in me) return res.json({ ok: true, detailBase: '', bound: false, message: me.message })
    const base = await resolveDetailUrlBase(me.token)
    res.json({ ok: true, detailBase: base.kind === 'ok' ? base.value : '', bound: true })
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/identities —— ② 填寫人能不能用（綁定＋授權）
router.post('/api/meegle/comment/identities', (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const { names } = z.object({ names: z.array(z.string().max(100)).max(300) }).parse(req.body)
    const seen = new Set<string>()
    const results: Array<{ name: string; status: string; email?: string; label?: string; candidates?: string[]; message?: string }> = []
    for (const raw of names) {
      const name = raw.trim()
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      const matched = matchAccountsByPersonName(name)
      if (matched.length === 0) { results.push({ name, status: 'no_account', message: '後台查無此人' }); continue }
      if (matched.length > 1) { results.push({ name, status: 'ambiguous', candidates: matched.map(m => m.label), message: '對應到多個帳號' }); continue }
      const hit = matched[0]
      const id = identityFor(ctx.email, hit.email)
      results.push(!('code' in id)
        ? { name, status: 'ok', email: hit.email, label: hit.label }
        : { name, status: id.code === 'NOT_AUTHORIZED' ? 'not_authorized' : 'not_bound', email: hit.email, label: hit.label, message: id.message })
    }
    res.json({ ok: true, self: identityFor(ctx.email, '').ok, selfEmail: ctx.email, results })
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/remote —— ③ 點到某列時讀 Meegle 上目前的測試說明（不一次讀 24 張）
router.post('/api/meegle/comment/remote', async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const { workItemId } = z.object({ workItemId: z.string().regex(/^\d{5,}$/) }).parse(req.body)
    const me = identityFor(ctx.email, '')
    if ('code' in me) return res.status(409).json({ ok: false, code: me.code, message: me.message })
    const cur = await getDescription(me.token, workItemId)
    if (cur.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀不到 #${workItemId} 的測試說明：${cur.message}` })
    res.json({ ok: true, current: cur.value, hash: descHash(cur.value), state: classifyRemote(cur.value, getSnapshot(db, workItemId)) })
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/ai —— ③ 預覽時跑 AI（送出時不跑；CodeX：先排版、再分析排版結果）
router.post('/api/meegle/comment/ai', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const body = z.object({
      rawText: z.string().max(50000), summary: z.string().max(2000).default(''),
      format: z.boolean(), review: z.boolean(),
      promptId: z.string().max(100).optional(), modelSpec: z.string().max(200).optional(),
      specContext: z.string().max(50000).default(''), knowledgeDocIds: z.array(z.number().int()).max(20).default([]),
      // 跟 Jira 批量評論送出時帶的同一組環境資訊（前端用 src/features/batch-comment/comment-text.ts 的 aiContextFor 算）
      environment: z.string().max(200).optional(), version: z.string().max(200).optional(), platform: z.string().max(200).optional(),
      machineId: z.string().max(200).optional(), gameMode: z.string().max(200).optional(),
    }).parse(req.body)
    const account = getAuthAccount(req)!
    if (body.format && !accountHasPermission(account.email, account.role, 'jira-ai-format')) return res.status(403).json({ ok: false, message: '這個帳號沒有「AI 排版評論」的權限' })
    if (body.review && !accountHasPermission(account.email, account.role, 'jira-ai-review')) return res.status(403).json({ ok: false, message: '這個帳號沒有「AI 完整性分析」的權限' })
    const kb = body.knowledgeDocIds
      .map(id => db.prepare('SELECT name, content_cache FROM knowledge_docs WHERE id = ?').get(id) as { name: string; content_cache: string | null } | undefined)
      .filter((d): d is { name: string; content_cache: string } => !!d?.content_cache).map(d => ({ name: d.name, content: d.content_cache }))
    const spec = buildSpecContext(kb, body.specContext)
    // AI 失敗要明示（CodeX）：直接回錯，不默默回原文當成功
    let text = body.rawText
    if (body.format) {
      text = await withRequestOperation('Meegle 評論預覽：AI 排版', () => formatCommentWithAI({ rawText: body.rawText, promptId: body.promptId, specContext: spec || undefined, modelSpec: body.modelSpec, environment: body.environment, version: body.version, platform: body.platform, machineId: body.machineId, gameMode: body.gameMode }))
    }
    let review: string | null = null
    if (body.review) {
      review = await withRequestOperation('Meegle 評論預覽：AI 完整性分析', () => callLLM(buildCompletenessPrompt(body.summary, '', text), body.modelSpec))
    }
    res.json({ ok: true, text, review, formatted: body.format })
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/previous —— 這份 Sheet 之前送過的列（接回待確認、補寫回、已評論標示）
router.post('/api/meegle/comment/previous', (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const { sheetUrl } = z.object({ sheetUrl: z.string().min(1).max(2000) }).parse(req.body)
    expireStaleSteps(db, STALE_MS)
    const rows = listPreviousForSource(db, sheetSourceKey(sheetUrl))
    res.json({ ok: true, rows: rows.map(r => ({ batchId: r.batch_id, workItemId: r.work_item_id, sheetRow: r.sheet_row, summary: r.summary, owner: r.owner_email, mine: r.owner_email === ctx.email, asEmail: r.as_email, hasPayload: !!r.payload, steps: publicSteps(r.steps) })) })
  } catch (e) { next(e) }
})

const attachmentSchema = z.object({ cacheId: z.string().refine(isCacheId, '附件快取 id 不合法'), name: z.string().min(1).max(300) })

// POST /api/meegle/comment/row —— 送出一列
router.post('/api/meegle/comment/row', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const body = z.object({
      batchId: z.string().uuid(), sheetUrl: z.string().min(1).max(2000), sheetRow: z.number().int().min(2), summary: z.string().max(2000).default(''),
      workItemId: z.string().regex(/^\d{5,}$/), asEmail: z.string().max(200).default(''),
      description: z.string().min(1).max(50000), images: z.array(attachmentSchema).max(30).default([]),
      commentText: z.string().min(1).max(20000), videos: z.array(attachmentSchema).max(10).default([]),
      reviewText: z.string().max(20000).nullable().default(null),
      expectedRemoteHash: z.string().regex(/^[0-9a-f]{64}$/), confirmedRemoteHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
      allowRepeat: z.boolean().default(false),
    }).parse(req.body)
    const { batchId, expectedRemoteHash, confirmedRemoteHash, allowRepeat, ...content } = body
    const r = await executeRow(req, ctx, batchId, content, { expectedRemoteHash, confirmedRemoteHash, allowRepeat })
    res.status(r.status).json(r.body)
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/row/continue —— 接著做還沒做的步驟（用上次存的內容，不靠前端草稿；重整頁面後也能按）
// 測試說明還沒成功的列不能用這個：要重新預覽（送前要拿最新的遠端版本比對）
router.post('/api/meegle/comment/row/continue', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().regex(/^\d{5,}$/) }).parse(req.body)
    const row = ownedRow(req, res, ctx, body.batchId, body.rowKey); if (!row) return
    const desc = getSteps(db, body.batchId, body.rowKey).find(st => st.step === 'desc')
    if (desc?.phase !== 'done') return res.status(409).json({ ok: false, message: '測試說明還沒成功寫入，請回 ③ 重新預覽這一列再送' })
    let content: RowContent
    try { content = JSON.parse(row.payload ?? '') as RowContent } catch { return res.status(409).json({ ok: false, message: '找不到上次送出的內容，請回 ③ 重新預覽這一列再送' }) }
    // desc 已完成，runner 不會再比遠端 hash；這裡給一個不會被用到的值
    const r = await executeRow(req, ctx, body.batchId, content, { expectedRemoteHash: '0'.repeat(64), confirmedRemoteHash: null, allowRepeat: true })
    res.status(r.status).json(r.body)
  } catch (e) { next(e) }
})

function ownedRow(req: Request, res: Response, ctx: Ctx, batchId: string, rowKey: string) {
  const row = getCommentRow(db, batchId, rowKey)
  if (!row || row.owner_email !== ctx.email) { res.status(404).json({ ok: false, message: '找不到這一列' }); return null }
  return row
}

// POST /api/meegle/comment/row/candidates —— 結果不明的評論：列出「可能就是這則」的候選，由人確認
router.post('/api/meegle/comment/row/candidates', async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().regex(/^\d{5,}$/), step: z.string().regex(/^(comment|review|video:[0-9a-f]+)$/), content: z.string().max(20000).default('') }).parse(req.body)
    const row = ownedRow(req, res, ctx, body.batchId, body.rowKey); if (!row) return
    const step = getSteps(db, body.batchId, body.rowKey).find(s => s.step === body.step)
    if (!step || step.phase !== 'unknown') return res.status(409).json({ ok: false, message: '這一步不是「結果不明」' })
    const id = identityFor(ctx.email, row.as_email)
    if ('code' in id) return res.status(403).json({ ok: false, code: id.code, message: id.message })
    const since = (step.attempt_at ?? step.updated_at) - 120_000
    const list = await listComments(id.token, row.work_item_id, since)
    // 查詢失敗：維持 unknown，不能當成「沒有送出」（CodeX）
    if (list.kind !== 'ok') return res.status(502).json({ ok: false, message: `查不到評論清單（維持待確認）：${list.message}` })
    const candidates = body.step.startsWith('video:')
      ? list.value.filter(c => c.fileUrl && (!id.userKey || c.creator === id.userKey))
      // 正文用送出當下存在後端的那份（重整後前端草稿沒了也查得到——CodeX review 64f53aa [P2]）
      : commentCandidates(list.value, { creator: id.userKey, sinceMs: since + 120_000, content: typeof stepData(step).content === 'string' ? stepData(step).content as string : body.content })
    res.json({ ok: true, candidates })
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/row/resolve —— 人確認：done＝確定有送出；failed＝確定沒有、可重送
router.post('/api/meegle/comment/row/resolve', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().regex(/^\d{5,}$/), step: z.string().regex(/^(desc|comment|review|writeback|video:[0-9a-f]+)$/), outcome: z.enum(['done', 'failed']) }).parse(req.body)
    const row = ownedRow(req, res, ctx, body.batchId, body.rowKey); if (!row) return
    if (!resolveUnknownStep(db, body.batchId, body.rowKey, body.step, body.outcome, `${ctx.email} 確認：${body.outcome === 'done' ? '已送出' : '沒有送出'}`)) {
      return res.status(409).json({ ok: false, message: '這一步已經不是「結果不明」' })
    }
    if (body.step === 'desc' && body.outcome === 'done') {
      const id = identityFor(ctx.email, row.as_email)
      if (!('code' in id)) {
        const cur = await getDescription(id.token, row.work_item_id)
        if (cur.kind === 'ok') setSnapshot(db, row.work_item_id, descHash(cur.value), ctx.email)
      }
    }
    log('ok', getClientIP(req), ctx.email, 'Meegle 評論', `#${body.rowKey} ${body.step} 人工確認為 ${body.outcome}`)
    res.json({ ok: true, steps: publicSteps(getSteps(db, body.batchId, body.rowKey)) })
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/row/writeback —— 補寫回（只跑 Sheet 回填，不碰 Meegle）
router.post('/api/meegle/comment/row/writeback', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const body = z.object({ batchId: z.string().uuid(), rowKey: z.string().regex(/^\d{5,}$/) }).parse(req.body)
    if (!ownedRow(req, res, ctx, body.batchId, body.rowKey)) return
    const writer = larkWritebackDeps()
    const steps = await writebackComment({
      db, readRowCells: larkReadRowCells, fmtTime,
      writeRow: (key, row, cols) => withSheetLock(key, () => writer.writeRow(key, row, cols)),
      getDescription: async () => ({ kind: 'rejected', message: '補寫回不碰 Meegle' }),
      setDescription: async () => ({ kind: 'rejected', message: '補寫回不碰 Meegle' }),
      uploadFile: async () => ({ kind: 'rejected', message: '補寫回不碰 Meegle' }),
      addComment: async () => ({ kind: 'rejected', message: '補寫回不碰 Meegle' }),
    }, body.batchId, body.rowKey)
    res.json({ ok: true, steps: publicSteps(steps) })
  } catch (e) { next(e) }
})

// POST /api/meegle/comment/finish —— 一批結束寫操作紀錄（每列的路徑：單號、各步驟結果）
router.post('/api/meegle/comment/finish', (req, res, next) => {
  try {
    const ctx = requireLogin(req, res); if (!ctx) return
    const { batchId, sheetUrl } = z.object({ batchId: z.string().uuid(), sheetUrl: z.string().max(2000) }).parse(req.body)
    const rows = db.prepare('SELECT * FROM meegle_comment_rows WHERE batch_id = ? AND owner_email = ? ORDER BY created_at').all(batchId, ctx.email) as Array<{ row_key: string; work_item_id: string; summary: string; as_email: string; sheet_row: number }>
    if (!rows.length) return res.json({ ok: true })
    const detail = rows.map(r => ({ workItemId: r.work_item_id, summary: r.summary, sheetRow: r.sheet_row, asEmail: r.as_email, steps: publicSteps(getSteps(db, batchId, r.row_key)) }))
    const okCount = detail.filter(d => d.steps.every(s => s.phase === 'done' || s.phase === 'skipped')).length
    const unknown = detail.filter(d => d.steps.some(s => s.phase === 'unknown')).length
    addHistory('meegle-batch-comment', 'Meegle 批量評論',
      `完成 ${okCount}／${rows.length} 張${unknown ? `，待確認 ${unknown} 張` : ''}`,
      // 追溯用：Sheet 連結＋每列的單號、列號、代理身分、各步驟結果
      { batchId, sheetUrl, rows: detail })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/**
 * Meegle 批量更新狀態（`/api/meegle/status/*`，Jira 頁「Meegle 狀態」分頁）。
 *
 * 身分：只用登入者本人的 Meegle 綁定（跟 Jira 批量更新狀態一樣，沒有代理）。
 * 權限：page key `jira`（跟 Meegle 開單／評論一樣）。
 * 流程與日期規則：server/meegle-status-run.ts；紀錄：meegle-status-store.ts；共用規則：shared/meegle-status-rules.ts。
 * 雙空間（v5.10.0）：新請求必帶 space；動到既有單之前先核對單子真的在那個空間（server/meegle-space.ts）。
 * 設計：docs/features/28-meegle.md「批量更新狀態」
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { accountHasPermission, addHistory, db, getClientIP, log, writeLimiter } from '../shared.js'
import { sheetSourceKey } from '../../shared/lark-sheet-url.js'
import { getAccountRow } from '../meegle-account-service.js'
import { decryptMeegleToken } from '../meegle-token-crypto.js'
import { defaultRunner, listTaskStates, resolveDetailUrlBase, transitionToState } from '../meegle-workitem.js'
import { checkItemSpace, otherSpaceOf, rowSpace, spaceEnv, spaceGuardMessage, spaceSchema, type MeegleSpace } from '../meegle-space.js'
import { readCurrent, readDate, readState, writeDate } from '../meegle-status-ops.js'
import {
  expireStaleStatusSteps, getStatusRow, getStatusSteps, initMeegleStatusSchema, listPreviousStatusForSource, dateDataOf, type StatusStepRow,
} from '../meegle-status-store.js'
import { continueStatusRow, runStatusRow, type StatusDeps } from '../meegle-status-run.js'
import { fmtTime, larkReadRowCells, larkWritebackDeps, withSheetLock } from '../meegle-sheet-writeback.js'
import { AUTO_DATE_FIELDS, DATE_MODES } from '../../shared/meegle-status-rules.js'

export const router = Router()
initMeegleStatusSchema(db)

/** 送出途中伺服器重啟留下的 creating：一列最多約 25 秒（等自動化 20 秒＋讀回），留足餘裕 */
export const STALE_MS = 5 * 60_000

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

function publicSteps(steps: StatusStepRow[]) {
  return steps.map(s => {
    const dd = s.step === 'date' ? dateDataOf(s) : null
    return { step: s.step, phase: s.phase, message: s.message, attemptAt: s.attempt_at, ...(dd ? { date: { label: dd.label, original: dd.original, desired: dd.desired, pending: !!dd.pending } } : {}) }
  })
}

function depsFor(token: string, space: MeegleSpace): StatusDeps {
  const writer = larkWritebackDeps()
  const env = spaceEnv(space)
  return {
    db,
    readDate: (id, field) => readDate(token, id, field, defaultRunner, env),
    readState: id => readState(token, id, defaultRunner, env),
    transition: (id, target) => transitionToState(token, id, target, defaultRunner, env),
    writeDate: (id, field, ms) => writeDate(token, id, field, ms, defaultRunner, env),
    readRowCells: larkReadRowCells,
    // 同一份 Sheet 的回填跟開單／評論回填排同一條隊（欄位不存在時會建欄）
    writeRow: (key, row, cols) => withSheetLock(key, () => writer.writeRow(key, row, cols)),
    fmtTime,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  }
}

// POST /api/meegle/status/meta —— 狀態清單、日期模式、會被自動化改的欄位、單子網址前綴
router.post('/api/meegle/status/meta', async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const { space } = z.object({ space: spaceSchema }).parse(req.body)
    const env = spaceEnv(space)
    const [states, base] = await Promise.all([listTaskStates(ctx.token, defaultRunner, env), resolveDetailUrlBase(ctx.token, defaultRunner, env)])
    if (states.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀不到 Meegle 狀態清單：${states.message}` })
    res.json({
      ok: true, states: states.value, dateModes: DATE_MODES, detailBase: base.kind === 'ok' ? base.value : '',
      autoDateFields: Object.entries(AUTO_DATE_FIELDS).map(([stateKey, f]) => ({ stateKey, field: f.field, label: f.label })),
    })
  } catch (e) { next(e) }
})

// POST /api/meegle/status/current —— ③ 預覽：一張單的目前狀態＋兩個日期欄（前端逐列呼叫、同時最多 3 張）
router.post('/api/meegle/status/current', async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const { workItemId, space } = z.object({ workItemId: z.string().regex(/^\d{5,}$/), space: spaceSchema }).parse(req.body)
    // 預覽就核對空間（Meegle 不驗 project key）
    const own = await checkItemSpace(ctx.token, workItemId, space)
    if (own.kind === 'rejected') return res.status(409).json({ ok: false, code: 'WRONG_SPACE', message: own.message })
    if (own.kind !== 'ok') return res.status(502).json({ ok: false, message: `確認 #${workItemId} 所屬空間失敗：${own.message}` })
    const r = await readCurrent(ctx.token, workItemId, defaultRunner, spaceEnv(space))
    if (r.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀不到 #${workItemId}：${r.message}` })
    res.json({ ok: true, ...r.value })
  } catch (e) { next(e) }
})

// POST /api/meegle/status/previous —— 這份 Sheet 之前送過的列（接回日期待確認、補寫回）
router.post('/api/meegle/status/previous', (req, res, next) => {
  try {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const { sheetUrl, space } = z.object({ sheetUrl: z.string().min(1).max(2000), space: spaceSchema }).parse(req.body)
    expireStaleStatusSteps(db, STALE_MS)
    const key = sheetSourceKey(sheetUrl)
    const rows = listPreviousStatusForSource(db, key, space)
    res.json({ ok: true, otherSpace: otherSpaceOf(db, key, space), rows: rows.map(r => ({ batchId: r.batch_id, workItemId: r.work_item_id, sheetRow: r.sheet_row, summary: r.summary, mine: r.owner_email === account.email.toLowerCase(), targetKey: r.target_key, targetName: r.target_name, dateMode: r.date_mode, steps: publicSteps(r.steps) })) })
  } catch (e) { next(e) }
})

// POST /api/meegle/status/row —— 送出一列（轉狀態 → 日期 → 回填）。可能要等自動化，最多約 25 秒
router.post('/api/meegle/status/row', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const b = z.object({
      batchId: z.string().uuid(), sheetUrl: z.string().min(1).max(2000), sheetRow: z.number().int().min(2), summary: z.string().max(2000).default(''),
      workItemId: z.string().regex(/^\d{5,}$/), targetKey: z.string().min(1).max(100), targetName: z.string().max(100).default(''),
      dateMode: z.enum(['keep', 'auto', 'set']), sheetDate: z.number().int().positive().nullable().default(null),
      space: spaceSchema,
    }).parse(req.body)
    const own = await checkItemSpace(ctx.token, b.workItemId, b.space)
    if (own.kind === 'rejected') return res.status(409).json({ ok: false, code: 'WRONG_SPACE', message: own.message })
    if (own.kind !== 'ok') return res.status(502).json({ ok: false, message: `確認 #${b.workItemId} 所屬空間失敗：${own.message}` })
    expireStaleStatusSteps(db, STALE_MS)
    const result = await runStatusRow(depsFor(ctx.token, b.space), {
      batchId: b.batchId, workItemId: b.workItemId, sourceKey: sheetSourceKey(b.sheetUrl), sheetUrl: b.sheetUrl, sheetRow: b.sheetRow, summary: b.summary,
      ownerEmail: ctx.email, targetKey: b.targetKey, targetName: b.targetName, dateMode: b.dateMode, sheetDate: b.dateMode === 'set' ? b.sheetDate : null, space: b.space,
    })
    if (result.claim.kind === 'space-mismatch' || result.claim.kind === 'space-conflict') {
      return res.status(409).json({ ok: false, code: result.claim.kind === 'space-conflict' ? 'SPACE_CONFLICT' : 'SPACE_MISMATCH', message: spaceGuardMessage(result.claim, b.space) })
    }
    const bad = result.steps.find(s => s.phase === 'failed')
    log(bad ? 'warn' : 'ok', getClientIP(req), ctx.email, 'Meegle 狀態', `${b.space === 'prod' ? '［正式］' : '［測試］'}#${b.workItemId} → ${b.targetName || b.targetKey} ${bad ? `${bad.step} 失敗` : result.claim.kind === 'claimed' ? '完成' : result.claim.kind}`)
    res.json({ ok: true, claim: result.claim, steps: publicSteps(result.steps) })
  } catch (e) { next(e) }
})

// POST /api/meegle/status/row/retry —— 重試失敗的步驟（含「只補日期」：用第一次讀到的原值，不重新讀）
router.post('/api/meegle/status/row/retry', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireSelf(req, res); if (!ctx) return
    const b = z.object({ batchId: z.string().uuid(), rowKey: z.string().regex(/^\d{5,}$/) }).parse(req.body)
    const row = getStatusRow(db, b.batchId, b.rowKey)
    if (!row || row.owner_email !== ctx.email) return res.status(404).json({ ok: false, message: '找不到這一列' })
    // 空間用紀錄上的；重試前一樣核對單子所屬空間
    const space = rowSpace(row.space)
    const own = await checkItemSpace(ctx.token, row.work_item_id, space)
    if (own.kind === 'rejected') return res.status(409).json({ ok: false, code: 'WRONG_SPACE', message: own.message })
    if (own.kind !== 'ok') return res.status(502).json({ ok: false, message: `確認 #${row.work_item_id} 所屬空間失敗：${own.message}` })
    expireStaleStatusSteps(db, STALE_MS)
    const steps = await continueStatusRow(depsFor(ctx.token, space), b.batchId, b.rowKey)
    log('ok', getClientIP(req), ctx.email, 'Meegle 狀態', `#${b.rowKey} 重試`)
    res.json({ ok: true, steps: publicSteps(steps) })
  } catch (e) { next(e) }
})

// POST /api/meegle/status/finish —— 一批結束寫操作紀錄
router.post('/api/meegle/status/finish', (req, res, next) => {
  try {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const email = account.email.toLowerCase()
    const { batchId, sheetUrl } = z.object({ batchId: z.string().uuid(), sheetUrl: z.string().max(2000) }).parse(req.body)
    const rows = db.prepare('SELECT * FROM meegle_status_rows WHERE batch_id = ? AND owner_email = ? ORDER BY created_at').all(batchId, email) as Array<{ row_key: string; work_item_id: string; summary: string; sheet_row: number; target_name: string; date_mode: string; space: string }>
    if (!rows.length) return res.json({ ok: true })
    const detail = rows.map(r => ({ workItemId: r.work_item_id, summary: r.summary, sheetRow: r.sheet_row, target: r.target_name, dateMode: r.date_mode, steps: publicSteps(getStatusSteps(db, batchId, r.row_key)) }))
    const okCount = detail.filter(d => d.steps.every(s => s.phase === 'done' || s.phase === 'skipped')).length
    const pending = detail.filter(d => d.steps.some(s => s.step === 'date' && s.date?.pending && s.phase === 'failed')).length
    const space = rowSpace(rows[0].space)
    addHistory('meegle-batch-status', 'Meegle 批量更新狀態',
      `［${space === 'prod' ? '正式' : '測試'}］完成 ${okCount}／${rows.length} 張${pending ? `，日期待確認 ${pending} 張` : ''}`,
      { batchId, sheetUrl, space, rows: detail })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

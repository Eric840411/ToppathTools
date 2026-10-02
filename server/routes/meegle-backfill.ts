/**
 * Meegle 補回填（`/api/meegle/backfill/*`，Jira 頁「Meegle 補回填」分頁）。
 * 只做「待補記錄」：四個 Meegle 工具裡 Meegle 已完成、Sheet 回填沒寫成的列；補寫回交給各工具原本的 writeback。
 * 權限：page key `jira`；預設只看自己送的，admin 可看全部人（`all=1`）。回填用的是 Lark 應用身分，不用個人 Meegle token。
 * 清單規則：server/meegle-backfill.ts。設計：docs/features/28-meegle.md「28f」
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { accountHasPermission, addHistory, db, getClientIP, log, writeLimiter } from '../shared.js'
import { BACKFILL_TOOLS, listPendingBackfill, retryBackfill, type BackfillRunners, type PendingItem } from '../meegle-backfill.js'
import { fmtTime, larkReadRowCells, larkWritebackDeps, withSheetLock, writebackRow } from '../meegle-sheet-writeback.js'
import { writebackComment } from '../meegle-comment-run.js'
import { writebackStatus } from '../meegle-status-run.js'
import { writebackEdit } from '../meegle-edit-run.js'
import { getBatchRow } from '../meegle-batch-store.js'
import { expireStaleSteps, getSteps as getCommentSteps } from '../meegle-comment-store.js'
import { expireStaleStatusSteps, getStatusSteps } from '../meegle-status-store.js'
import { expireStaleEditSteps, getEditSteps } from '../meegle-edit-store.js'
import { STALE_MS as COMMENT_STALE } from './meegle-comment.js'
import { STALE_MS as STATUS_STALE } from './meegle-status.js'
import { STALE_MS as EDIT_STALE } from './meegle-edit.js'

/** 列清單前先照各工具自己的規則把中斷的 creating 過期（用各工具匯出的時限，不在這裡另抄數字） */
function expireAll() {
  expireStaleSteps(db, COMMENT_STALE)
  expireStaleStatusSteps(db, STATUS_STALE)
  expireStaleEditSteps(db, EDIT_STALE)
}

export const router = Router()

type Ctx = { email: string; admin: boolean }
function requireCtx(req: Request, res: Response): Ctx | null {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, message: '請先登入' }); return null }
  if (!accountHasPermission(account.email, account.role, 'jira')) { res.status(403).json({ ok: false, message: '沒有批量工具的權限' }); return null }
  return { email: account.email.toLowerCase(), admin: account.role === 'admin' }
}

function publicItem(it: PendingItem) {
  const [, token = '', sheetId = ''] = it.sourceKey.split(':')
  return { ...it, tool: it.tool, toolLabel: BACKFILL_TOOLS.find(t => t.key === it.tool)?.label, stage: BACKFILL_TOOLS.find(t => t.key === it.tool)?.stage, sheetLabel: `${token.slice(0, 6)}…／${sheetId}` }
}

/** 各工具原本的回填：Meegle 那邊的呼叫一律不准（這裡只補 Sheet） */
function runners(): BackfillRunners {
  const writer = larkWritebackDeps()
  const writeRow = (key: string, row: number, cols: Parameters<typeof writer.writeRow>[2]) => withSheetLock(key, () => writer.writeRow(key, row, cols))
  const noMeegle = async () => ({ kind: 'rejected' as const, message: '補回填不碰 Meegle' })
  const wbPhase = (steps: Array<{ step: string; phase: string; message: string | null }>) => {
    const wb = steps.find(s => s.step === 'writeback')
    return { ok: wb?.phase === 'done', message: wb?.phase === 'done' ? null : wb?.message ?? '沒有寫回' }
  }
  return {
    create: async (b, r) => {
      await writebackRow(db, b, r, writer)
      const row = getBatchRow(db, b, r)
      return { ok: row?.writeback_phase === 'done', message: row?.writeback_phase === 'done' ? null : row?.writeback_msg ?? '沒有寫回' }
    },
    comment: async (b, r) => {
      await writebackComment({ db, readRowCells: larkReadRowCells, writeRow, fmtTime, getDescription: noMeegle, setDescription: noMeegle, uploadFile: noMeegle, addComment: noMeegle }, b, r)
      return wbPhase(getCommentSteps(db, b, r))
    },
    status: async (b, r) => {
      await writebackStatus({ db, readRowCells: larkReadRowCells, writeRow, fmtTime, sleep: async () => {}, readDate: noMeegle, readState: noMeegle, transition: noMeegle, writeDate: noMeegle }, b, r)
      return wbPhase(getStatusSteps(db, b, r))
    },
    edit: async (b, r) => {
      await writebackEdit({ db, readRowCells: larkReadRowCells, writeRow, fmtTime, normText: s => s, resolveCtx: noMeegle, readCurrent: noMeegle, updateFields: noMeegle, roleOperate: noMeegle, uploadImage: noMeegle }, b, r)
      return wbPhase(getEditSteps(db, b, r))
    },
  }
}

// GET /api/meegle/backfill/pending?all=1 —— 待補清單（預設自己的；admin 帶 all=1 看全部人）
router.get('/api/meegle/backfill/pending', (req, res, next) => {
  try {
    const ctx = requireCtx(req, res); if (!ctx) return
    const all = req.query.all === '1' && ctx.admin
    expireAll()
    res.json({ ok: true, scope: all ? 'all' : 'mine', canSeeAll: ctx.admin, items: listPendingBackfill(db, { owner: all ? null : ctx.email }).map(publicItem) })
  } catch (e) { next(e) }
})

// POST /api/meegle/backfill/retry —— 補寫回勾選的列（逐列跑，各自回報）
router.post('/api/meegle/backfill/retry', writeLimiter, async (req, res, next) => {
  try {
    const ctx = requireCtx(req, res); if (!ctx) return
    const { items } = z.object({ items: z.array(z.object({ tool: z.enum(['create', 'comment', 'status', 'edit']), batchId: z.string().uuid(), rowKey: z.string().min(1).max(40) })).min(1).max(200) }).parse(req.body)
    // 只能補清單裡看得到的（自己的；admin 可補全部人的）——不信前端給的列
    expireAll()
    const visible = listPendingBackfill(db, { owner: ctx.admin ? null : ctx.email })
    const run = runners()
    const results: Array<{ tool: string; batchId: string; rowKey: string; workItemId: string; ok: boolean; message: string | null }> = []
    for (const it of items) {
      const hit = visible.find(v => v.tool === it.tool && v.batchId === it.batchId && v.rowKey === it.rowKey)
      if (!hit) { results.push({ ...it, workItemId: '', ok: false, message: '這一列不在待補清單裡（可能已經補好、或不是你送的）' }); continue }
      const r = await retryBackfill(run, it)
      results.push({ ...it, workItemId: hit.workItemId, ok: r.ok, message: r.message })
    }
    const okN = results.filter(r => r.ok).length
    log(okN === results.length ? 'ok' : 'warn', getClientIP(req), ctx.email, 'Meegle 補回填', `${okN}／${results.length} 筆寫回`)
    addHistory('meegle-backfill', 'Meegle 補回填', `寫回 ${okN}／${results.length} 筆`, { results })
    res.json({ ok: true, results })
  } catch (e) { next(e) }
})

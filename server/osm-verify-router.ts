/**
 * 版本驗證表 `/api/osm-verify/*`（docs/features/35-osm-verify.md）。
 *
 * 做成工廠（依賴從外面傳進來），測試才能用記憶體 DB＋假登入＋假 Meegle CLI 打真的 HTTP；
 * 正式接線在 routes/osm-verify.ts。
 *
 * 權限三層（後端每支 API 都驗，前端只是跟著不渲染按鈕）：
 *   osm-verify         查看
 *   osm-verify-edit    新增／編輯批次與項目、綁定版本紀錄、開單
 *   osm-verify-manage  標記已上正式、刪除、從 Lark 匯入、管理設定（平台對應、事件 API 金鑰）
 * 事件 API（GET events、POST events/:id/ack）**只收服務憑證**（Bearer），不看登入 session；
 * 已列在 server/public-routes.ts（osm-qa-agent 的 scripts/verify-form/pull-events.cjs 在打）。
 *
 * ⚠️ Meegle token：只在 deps.meegle.binding() 裡解密、只傳給 CLI；任何回應、歷史、log 都不帶。
 */
import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import {
  initOsmVerifySchema, listBatches, getBatch, createBatch, updateBatch, deleteBatch, listItems, getItem, createItem, updateItem, deleteItem,
  listBindings, bindRelease, unbindRelease, checkBatch, markReleased, listRevisions, claimTicket, finishTicket, applyLookup, getTicket,
  listEvents, ackEvent, latestTicket, verifyEventKey, regenerateEventKey, hasEventKey, getPlatformMap, setPlatformMap, sweepStalePending,
  type TicketRow, type ClaimMode,
} from './osm-verify-store.js'
import { listReleases, listTabs } from './osm-release-store.js'
import { validateBatch, validateItem, ticketName, ticketDescription, resolveCreateValues, type BatchInput, type ItemInput } from '../shared/osm-verify-rules.js'
import { typeEnv, listTypes, loadTypeSchema, createWorkItem, lookupByKey } from './osm-verify-meegle.js'
import { applyVerifySections, parseVerifySheet, DEFAULT_SOURCE } from './osm-verify-import.js'
import type { Runner } from './meegle-workitem.js'

type DB = Database.Database
type Account = { email: string; label?: string; role: string }

export interface OsmVerifyDeps {
  db: DB
  auth: (req: Request) => Account | null
  permissions: (email: string, role: string) => string[]
  history: (title: string, summary: string, detail: unknown) => void
  writeLimiter?: RequestHandler
  meegle: {
    /** 解密本人的 token；失敗回錯誤（未綁定／失效／解不開）。token 只在這裡出現 */
    binding: (email: string) => { ok: true; token: string; bindingRev: string } | { ok: false; code: string; message: string }
    canUseSpace: (role: string, space: 'test' | 'prod') => boolean
    runner: Runner
    baseEnv: NodeJS.ProcessEnv
  }
  lark?: { readSheet: (sheetToken: string, sheetId: string) => Promise<unknown[][]> }
}

type Level = 'view' | 'edit' | 'manage'
const KEY: Record<Level, string> = { view: 'osm-verify', edit: 'osm-verify-edit', manage: 'osm-verify-manage' }

/** 回應裡的開單紀錄：不帶開單人 email、綁定 rev（內部用） */
const publicTicket = (t: TicketRow | null | undefined) => t && ({
  id: t.id, itemId: t.itemId, seq: t.seq, key: t.key, status: t.status, space: t.space, typeKey: t.typeKey, name: t.name,
  workItemId: t.workItemId, url: t.url, message: t.message, createdLabel: t.createdLabel, attempts: t.attempts, createdAt: t.createdAt, updatedAt: t.updatedAt,
})

const batchSchema = z.object({
  year: z.number().int(),
  batch: z.string().max(40),
  publishStatus: z.enum(['draft', 'verified']).default('draft'),
  prodVersion: z.string().max(4000).default(''),
})
const itemSchema = z.object({
  platform: z.string().max(200).default(''),
  type: z.string().max(100).default(''),
  description: z.string().max(5000).default(''),
  env: z.string().max(200).default(''),
  result: z.string().max(200).default(''),
  okCount: z.number().int().default(0),
  verifier: z.string().max(200).default(''),
  attachments: z.string().max(4000).default(''),
  remark: z.string().max(5000).default(''),
})
const spaceSchema = z.enum(['test', 'prod'])

export function buildOsmVerifyRouter(deps: OsmVerifyDeps): Router {
  const { db } = deps
  initOsmVerifySchema(db)
  const router = Router()
  const limit: RequestHandler = deps.writeLimiter ?? ((_q, _s, next) => next())

  function need(req: Request, res: Response, level: Level) {
    const acc = deps.auth(req)
    if (!acc) { res.status(401).json({ ok: false, message: '請先登入' }); return null }
    const keys = deps.permissions(acc.email, acc.role)
    const p = { acc, view: keys.includes(KEY.view), edit: keys.includes(KEY.edit), manage: keys.includes(KEY.manage) }
    // 編輯／管理都隱含查看
    const ok = level === 'view' ? (p.view || p.edit || p.manage) : level === 'edit' ? p.edit || p.manage : p.manage
    if (!ok) {
      const label = level === 'view' ? '查看' : level === 'edit' ? '編輯' : '管理'
      res.status(403).json({ ok: false, message: `需要版本驗證表「${label}」權限，請洽管理員` }); return null
    }
    return p
  }
  const actorOf = (p: { acc: Account }) => p.acc.label || p.acc.email
  const fail = (res: Response, r: { reason: string; message: string; current?: unknown }) => {
    const status = r.reason === 'not_found' || r.reason === 'release_not_found' ? 404 : r.reason === 'conflict' ? 409 : r.reason === 'check_failed' || r.reason === 'already' || r.reason === 'released' || r.reason === 'last_binding' || r.reason === 'duplicate' || r.reason === 'busy' || r.reason === 'not_bound' ? 409 : 400
    res.status(status).json({ ok: false, code: r.reason === 'conflict' ? 'CONFLICT' : r.reason.toUpperCase(), message: r.message, current: r.current })
  }
  const detail = (id: string) => {
    sweepStalePending(db)
    const { check, releases } = checkBatch(db, id)
    return {
      batch: getBatch(db, id),
      items: listItems(db, id).map(i => ({ ...i, tickets: i.tickets.map(publicTicket) })),
      bindings: releases, check,
    }
  }

  // ─── 事件 API（服務憑證，不看 session） ───────────────────────────────────

  const bearer = (req: Request, res: Response) => {
    if (verifyEventKey(db, req.headers.authorization)) return true
    res.status(401).json({ ok: false, message: '服務憑證無效' })
    return false
  }
  router.get('/api/osm-verify/events', (req, res) => {
    if (!bearer(req, res)) return
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null
    const r = listEvents(db, cursor, Number(req.query.limit ?? 50))
    res.json({ ok: true, events: r.events, nextCursor: r.nextCursor })
  })
  router.post('/api/osm-verify/events/:id/ack', (req, res) => {
    if (!bearer(req, res)) return
    const b = z.object({ batchRev: z.number().int() }).safeParse(req.body)
    if (!b.success) return res.status(400).json({ ok: false, message: '缺少 batchRev' })
    const r = ackEvent(db, String(req.params.id), b.data.batchRev)
    if ('reason' in r) return res.status(r.reason === 'not_found' ? 404 : 409).json({ ok: false, message: r.message })
    res.json({ ok: true })
  })

  // ─── 讀取 ─────────────────────────────────────────────────────────────────

  router.get('/api/osm-verify/meta', (req, res) => {
    const p = need(req, res, 'view'); if (!p) return
    res.json({
      ok: true,
      perms: { view: true, edit: p.edit || p.manage, manage: p.manage },
      isAdmin: p.acc.role === 'admin',
      platformMap: getPlatformMap(db),
      eventKeyConfigured: p.manage ? hasEventKey(db) : undefined,
    })
  })

  router.get('/api/osm-verify/batches', (req, res) => {
    if (!need(req, res, 'view')) return
    res.json({ ok: true, batches: listBatches(db) })
  })

  router.get('/api/osm-verify/batches/:id', (req, res) => {
    if (!need(req, res, 'view')) return
    const id = String(req.params.id)
    if (!getBatch(db, id)) return res.status(404).json({ ok: false, message: '找不到這個批次' })
    res.json({ ok: true, ...detail(id) })
  })

  router.get('/api/osm-verify/batches/:id/revisions', (req, res) => {
    if (!need(req, res, 'view')) return
    res.json({ ok: true, revisions: listRevisions(db, String(req.params.id)) })
  })

  /** 綁定用的版本紀錄清單（只給摘要；看完整內容要有 OSM 版本更新紀錄的權限） */
  router.get('/api/osm-verify/releases', (req, res) => {
    if (!need(req, res, 'edit')) return
    const tabs = new Map(listTabs(db).map(t => [t.id, t.name]))
    res.json({
      ok: true,
      releases: listReleases(db).slice(0, 300).map(r => ({
        id: r.id, rev: r.rev, tabId: r.tabId, tabName: tabs.get(r.tabId) ?? r.tabId, date: r.releaseDate || r.testDate,
        content: r.content.split('\n').map(l => l.trim()).find(Boolean) ?? '',
      })),
    })
  })

  // ─── 批次 ─────────────────────────────────────────────────────────────────

  router.post('/api/osm-verify/batches', limit, (req, res) => {
    const p = need(req, res, 'edit'); if (!p) return
    const input = batchSchema.parse(req.body) as BatchInput
    const errors = validateBatch(input)
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, message: '有欄位需要修正', errors })
    const r = createBatch(db, input, actorOf(p))
    if ('reason' in r) return fail(res, r)
    deps.history('新增驗證批次', `${input.year}-${input.batch}`, { batchId: r.id })
    res.json({ ok: true, id: r.id, ...detail(r.id) })
  })

  router.put('/api/osm-verify/batches/:id', limit, (req, res) => {
    const p = need(req, res, 'edit'); if (!p) return
    const id = String(req.params.id)
    const { rev, ...rest } = z.object({ rev: z.number().int() }).passthrough().parse(req.body)
    const input = batchSchema.parse(rest) as BatchInput
    const errors = validateBatch(input)
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, message: '有欄位需要修正', errors })
    const r = updateBatch(db, id, rev, input, actorOf(p))
    if ('reason' in r) return fail(res, r)
    deps.history('修改驗證批次', `${input.year}-${input.batch}（第 ${r.rev} 版）`, { batchId: id, rev: r.rev })
    res.json({ ok: true, ...detail(id) })
  })

  router.delete('/api/osm-verify/batches/:id', (req, res) => {
    const p = need(req, res, 'manage'); if (!p) return
    const id = String(req.params.id)
    const rev = Number(req.query.rev)
    if (!Number.isInteger(rev)) return res.status(400).json({ ok: false, message: '缺少版本號 rev' })
    const name = getBatch(db, id)?.name ?? id
    const r = deleteBatch(db, id, rev, actorOf(p))
    if ('reason' in r) return fail(res, r)
    deps.history('刪除驗證批次', name, { batchId: id })
    res.json({ ok: true })
  })

  router.post('/api/osm-verify/batches/:id/release', limit, (req, res) => {
    const p = need(req, res, 'manage'); if (!p) return
    const id = String(req.params.id)
    const b = z.object({ rev: z.number().int(), prodVersion: z.string().max(4000).optional() }).parse(req.body)
    const r = markReleased(db, id, b.rev, b.prodVersion, actorOf(p))
    if ('reason' in r) return fail(res, r)
    deps.history('標記已上正式', getBatch(db, id)?.name ?? id, { batchId: id, rev: r.rev })
    res.json({ ok: true, ...detail(id) })
  })

  router.post('/api/osm-verify/batches/:id/releases', limit, (req, res) => {
    const p = need(req, res, 'edit'); if (!p) return
    const id = String(req.params.id)
    const { releaseId } = z.object({ releaseId: z.number().int() }).parse(req.body)
    const r = bindRelease(db, id, releaseId, actorOf(p))
    if ('reason' in r) return fail(res, r)
    deps.history('綁定版本紀錄', `${getBatch(db, id)?.name ?? id} ← #${releaseId}`, { batchId: id, releaseId })
    res.json({ ok: true, ...detail(id) })
  })

  router.delete('/api/osm-verify/batches/:id/releases/:releaseId', (req, res) => {
    const p = need(req, res, 'edit'); if (!p) return
    const id = String(req.params.id)
    const releaseId = Number(req.params.releaseId)
    const r = unbindRelease(db, id, releaseId, actorOf(p))
    if ('reason' in r) return fail(res, r)
    deps.history('解除綁定版本紀錄', `${getBatch(db, id)?.name ?? id} ✕ #${releaseId}`, { batchId: id, releaseId })
    res.json({ ok: true, ...detail(id) })
  })

  // ─── 驗證項目 ─────────────────────────────────────────────────────────────

  router.post('/api/osm-verify/batches/:id/items', limit, (req, res) => {
    const p = need(req, res, 'edit'); if (!p) return
    const id = String(req.params.id)
    const input = itemSchema.parse(req.body) as ItemInput
    const errors = validateItem(input)
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, message: '有欄位需要修正', errors })
    const r = createItem(db, id, input, actorOf(p))
    if ('reason' in r) return fail(res, r)
    res.json({ ok: true, itemId: r.id, ...detail(id) })
  })

  router.put('/api/osm-verify/items/:id', limit, (req, res) => {
    const p = need(req, res, 'edit'); if (!p) return
    const itemId = Number(req.params.id)
    const { rev, ...rest } = z.object({ rev: z.number().int() }).passthrough().parse(req.body)
    const input = itemSchema.parse(rest) as ItemInput
    const errors = validateItem(input)
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, message: '有欄位需要修正', errors })
    const r = updateItem(db, itemId, rev, input, actorOf(p))
    if ('reason' in r) return fail(res, r)
    res.json({ ok: true, ...detail(getItem(db, itemId)!.batchId) })
  })

  router.delete('/api/osm-verify/items/:id', (req, res) => {
    const p = need(req, res, 'manage'); if (!p) return
    const itemId = Number(req.params.id)
    const rev = Number(req.query.rev)
    if (!Number.isInteger(rev)) return res.status(400).json({ ok: false, message: '缺少版本號 rev' })
    const item = getItem(db, itemId)
    const r = deleteItem(db, itemId, rev, actorOf(p))
    if ('reason' in r) return fail(res, r)
    deps.history('刪除驗證項目', `#${itemId} ${item?.description.slice(0, 40) ?? ''}`, { itemId })
    res.json({ ok: true, ...(item ? detail(item.batchId) : {}) })
  })

  // ─── 管理設定 ─────────────────────────────────────────────────────────────

  router.put('/api/osm-verify/settings/platform-map', limit, (req, res) => {
    if (!need(req, res, 'manage')) return
    const map = z.record(z.string().min(1).max(60), z.array(z.string().min(1).max(120)).max(20)).parse(req.body?.map ?? {})
    setPlatformMap(db, map)
    deps.history('修改平台對應', `${Object.keys(map).length} 個平台`, { platforms: Object.keys(map) })
    res.json({ ok: true, platformMap: getPlatformMap(db) })
  })

  /** 重新產生事件 API 金鑰：只在這次回應出現明文，DB 只存雜湊；舊金鑰立即失效 */
  router.post('/api/osm-verify/settings/event-key', limit, (req, res) => {
    if (!need(req, res, 'manage')) return
    const key = regenerateEventKey(db)
    deps.history('重新產生事件 API 金鑰', '舊金鑰已失效', {})
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, key })
  })

  router.post('/api/osm-verify/import', limit, async (req, res, next) => {
    const p = need(req, res, 'manage'); if (!p) return
    try {
      if (!deps.lark) return res.status(503).json({ ok: false, message: '伺服器沒有設定 Lark' })
      const b = z.object({ sheetToken: z.string().regex(/^[A-Za-z0-9]{10,64}$/).optional(), sheetId: z.string().regex(/^[A-Za-z0-9]{2,20}$/).optional() }).parse(req.body ?? {})
      const token = b.sheetToken ?? DEFAULT_SOURCE.token, sheetId = b.sheetId ?? DEFAULT_SOURCE.sheetId
      const rows = await deps.lark.readSheet(token, sheetId)
      const results = applyVerifySections(db, { sheetKey: `${token}:${sheetId}`, sections: parseVerifySheet(rows as never), actor: '從 Lark 匯入' })
      deps.history('從 Lark 匯入驗證表', results.map(r => `${r.batch ?? `第 ${r.section + 1} 列那段`}: ${r.error ? '略過' : `+${r.added}`}`).join('、'), { results })
      res.json({ ok: true, results })
    } catch (e) { next(e) }
  })

  // ─── 開單 ─────────────────────────────────────────────────────────────────

  function meegleCtx(req: Request, res: Response, space: 'test' | 'prod', acc: Account) {
    if (!deps.meegle.canUseSpace(acc.role, space)) { res.status(403).json({ ok: false, code: 'TEST_SPACE_ADMIN_ONLY', message: '測試空間只有管理員能用' }); return null }
    const b = deps.meegle.binding(acc.email)
    if ('code' in b) { res.status(409).json({ ok: false, code: b.code, message: b.message }); return null }
    return b
  }

  router.get('/api/osm-verify/meegle/types', async (req, res, next) => {
    const p = need(req, res, 'edit'); if (!p) return
    try {
      const space = spaceSchema.parse(req.query.space)
      const b = meegleCtx(req, res, space, p.acc); if (!b) return
      const r = await listTypes(b.token, typeEnv(space, '', deps.meegle.baseEnv), deps.meegle.runner)
      if (r.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀取工作項類型失敗：${r.message}` })
      res.json({ ok: true, types: r.value })
    } catch (e) { next(e) }
  })

  router.get('/api/osm-verify/meegle/schema', async (req, res, next) => {
    const p = need(req, res, 'edit'); if (!p) return
    try {
      const space = spaceSchema.parse(req.query.space)
      const typeKey = z.string().min(1).max(80).parse(req.query.type)
      const b = meegleCtx(req, res, space, p.acc); if (!b) return
      const r = await loadTypeSchema(b.token, typeEnv(space, typeKey, deps.meegle.baseEnv), deps.meegle.baseEnv, deps.meegle.runner)
      if (r.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀取建立欄位失敗：${r.message}` })
      res.json({ ok: true, schema: r.value })
    } catch (e) { next(e) }
  })

  /**
   * 開單（按下即送出、不確認；勾選多列逐列獨立回報）。
   * 送出前用最新的類型欄位設定再驗一次；每列先原子搶占冪等 key 才呼叫 Meegle。
   */
  router.post('/api/osm-verify/tickets', limit, async (req, res, next) => {
    const p = need(req, res, 'edit'); if (!p) return
    try {
      const b = z.object({
        itemIds: z.array(z.number().int()).min(1).max(100),
        mode: z.enum(['create', 'resend', 'again']).default('create'),
        space: spaceSchema,
        typeKey: z.string().min(1).max(80),
        values: z.record(z.string(), z.string().max(2000)).default({}),
      }).parse(req.body)
      const bind = meegleCtx(req, res, b.space, p.acc); if (!bind) return
      const env = typeEnv(b.space, b.typeKey, deps.meegle.baseEnv)
      const schema = await loadTypeSchema(bind.token, env, deps.meegle.baseEnv, deps.meegle.runner)
      if (schema.kind !== 'ok') return res.status(502).json({ ok: false, message: `讀取建立欄位失敗，沒有開任何單：${schema.message}` })
      const resolved = resolveCreateValues(schema.value, b.values)
      if (Object.keys(resolved.errors).length) return res.status(400).json({ ok: false, message: '開單設定有欄位需要修正（Meegle 設定可能剛改過），沒有開任何單', errors: resolved.errors, schema: schema.value })

      const results: { itemId: number; ok: boolean; status?: string; message?: string; ticket?: ReturnType<typeof publicTicket> }[] = []
      for (const itemId of [...new Set(b.itemIds)]) {
        const item = getItem(db, itemId)
        if (!item) { results.push({ itemId, ok: false, message: '找不到這個項目' }); continue }
        const batch = getBatch(db, item.batchId)
        if (!batch) { results.push({ itemId, ok: false, message: '找不到批次' }); continue }
        const name = ticketName(item)
        // 沿用同一把 key 重送（確認重送／開單失敗重試）：空間／類型要跟第一次一樣，不然同一把 key 會開在別處
        const prev = latestTicket(db, itemId)
        const reusing = (b.mode === 'resend' && prev?.status === 'unknown') || (b.mode === 'create' && prev?.status === 'failed')
        if (reusing && prev && (prev.space !== b.space || prev.typeKey !== b.typeKey)) {
          results.push({ itemId, ok: false, status: 'space_mismatch', message: '這張單第一次開在別的空間／類型，請切回原本的設定再重送（或改用「再開一張」）', ticket: publicTicket(prev) })
          continue
        }
        const claim = claimTicket(db, { itemId, mode: b.mode as ClaimMode, actor: p.acc.email, label: actorOf(p), bindingRev: bind.bindingRev, space: b.space, typeKey: b.typeKey, name })
        if ('reason' in claim) { results.push({ itemId, ok: false, status: claim.reason, message: claim.message, ticket: publicTicket(claim.ticket) }); continue }
        const t = claim.ticket
        const fields = [
          { field_key: 'name', field_value: t.name || name },
          { field_key: 'description', field_value: ticketDescription(batch.name, item, t.key) },
          ...resolved.fields,
        ]
        const out = await createWorkItem(bind.token, env, fields, deps.meegle.runner)
        const done = finishTicket(db, t.id, out)
        results.push({ itemId, ok: out.kind === 'created', status: done?.status ?? out.kind, message: out.kind === 'created' ? '' : out.message, ticket: publicTicket(done) })
      }
      const created = results.filter(r => r.ok).length
      deps.history('驗證項目開單', `${created}/${results.length} 列開單成功（${b.space === 'prod' ? '正式' : '測試'}空間）`, {
        space: b.space, typeKey: b.typeKey, mode: b.mode,
        results: results.map(r => ({ itemId: r.itemId, status: r.status, workItemId: r.ticket?.workItemId ?? '' })),
      })
      const batchId = results.map(r => getItem(db, r.itemId)?.batchId).find(Boolean)
      res.json({ ok: true, results, ...(batchId ? detail(batchId) : {}) })
    } catch (e) { next(e) }
  })

  /** 結果不明的單：用 key 到遠端查。查無也不重送 */
  router.post('/api/osm-verify/tickets/:id/lookup', limit, async (req, res, next) => {
    const p = need(req, res, 'edit'); if (!p) return
    try {
      const t = getTicket(db, Number(req.params.id))
      if (!t) return res.status(404).json({ ok: false, message: '找不到這張單的紀錄' })
      if (t.status !== 'unknown') return res.status(409).json({ ok: false, message: '只有結果不明的單需要到遠端查', ticket: publicTicket(t) })
      const space = t.space === 'test' ? 'test' : 'prod'
      const bind = meegleCtx(req, res, space, p.acc); if (!bind) return
      const r = await lookupByKey(bind.token, typeEnv(space, t.typeKey, deps.meegle.baseEnv), t.name, t.key, deps.meegle.runner)
      if (r.kind !== 'ok') return res.status(502).json({ ok: false, message: `到遠端查失敗（結果仍不明，沒有重送）：${r.message}` })
      const out = applyLookup(db, t.id, r.value)
      if (out.result === 'created') deps.history('遠端查到結果不明的單', `#${out.ticket?.workItemId}`, { ticketId: t.id })
      res.json({ ok: true, result: out.result, ticket: publicTicket(out.ticket), ...detail(t.batchId) })
    } catch (e) { next(e) }
  })

  // zod 錯誤 → 400（不讓它變成 500）
  router.use('/api/osm-verify', ((err, _req, res, next) => {
    if (err instanceof z.ZodError) return res.status(400).json({ ok: false, message: '參數格式不對', issues: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) })
    next(err)
  }) as import('express').ErrorRequestHandler)

  return router
}

export { listBindings }

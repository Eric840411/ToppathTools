/**
 * OSM 版本更新紀錄 `/api/osm-releases/*`（docs/features/33-osm-releases.md）。
 *
 * 權限三層（權限管理頁按角色勾選，後端逐項驗，不是只藏按鈕）：
 *   osm-releases         查看
 *   osm-releases-edit    新增／編輯紀錄
 *   osm-releases-manage  設定（分頁／元件／狀態）、刪除紀錄、從 Lark 匯入
 * 管理員一律全開（getEffectivePermissions 對 admin 回全部 key）。
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { db, addHistory, getEffectivePermissions, getLarkToken, writeLimiter } from '../shared.js'
import { getAuthAccount } from '../auth-session.js'
import { validateRelease, mergeUnsentFields, type ReleaseInput, type ReleaseUpdateInput } from '../../shared/osm-release-rules.js'
import {
  initOsmReleaseSchema, listTabs, listComponents, listStatuses, listReleases, getRelease, createRelease, updateRelease, deleteRelease,
  listRevisions, upsertTab, addComponent, updateComponent, deleteComponent, reorder, addStatus, updateStatus,
  listViews, saveView, deleteView,
} from '../osm-release-store.js'
import { parseReleaseSheet, applyParsedSheet } from '../osm-release-import.js'

export const router = Router()
initOsmReleaseSchema(db)

type Level = 'view' | 'edit' | 'manage'
const KEY: Record<Level, string> = { view: 'osm-releases', edit: 'osm-releases-edit', manage: 'osm-releases-manage' }

function perms(req: Request) {
  const acc = getAuthAccount(req)
  if (!acc) return null
  const keys = getEffectivePermissions(acc.email, acc.role)
  return { acc, view: keys.includes(KEY.view), edit: keys.includes(KEY.edit), manage: keys.includes(KEY.manage) }
}

/** 沒權限就回 403 並結束；有權限回帳號 */
function need(req: Request, res: Response, level: Level) {
  const p = perms(req)
  if (!p) { res.status(401).json({ ok: false, message: '請先登入' }); return null }
  // 編輯／管理都隱含查看
  const ok = level === 'view' ? (p.view || p.edit || p.manage) : level === 'edit' ? p.edit || p.manage : p.manage
  if (!ok) {
    const label = level === 'view' ? '查看' : level === 'edit' ? '編輯紀錄' : '管理設定'
    res.status(403).json({ ok: false, message: `需要「${label}」權限，請洽管理員` })
    return null
  }
  return p
}

const actorOf = (p: { acc: { email: string; label?: string } }) => p.acc.label || p.acc.email

const valueSchema = z.object({ componentId: z.number().int(), state: z.enum(['updated', 'unchanged', 'na']), version: z.string().max(200).default('') })
const releaseSchema = z.object({
  tabId: z.string().min(1).max(60),
  statusId: z.number().int().nullable(),
  testDate: z.string().max(10).default(''),
  releaseDate: z.string().max(10).default(''),
  content: z.string().max(20000).default(''),
  sqlText: z.string().max(20000).default(''),
  resultText: z.string().max(20000).default(''),
  values: z.array(valueSchema).max(200).default([]),
})
// 編輯：SQL／更新結果／values 沒送＝保留原值，不能用 .default('') 把「沒送」跟「送空的」抹成同一種
const releaseUpdateSchema = releaseSchema.extend({
  sqlText: z.string().max(20000).optional(),
  resultText: z.string().max(20000).optional(),
  values: z.array(valueSchema).max(200).optional(),
})

function ruleCtx() {
  return {
    tabs: listTabs(db).map(t => ({ id: t.id, showComponents: t.showComponents, active: t.active })),
    components: listComponents(db).map(c => ({ id: c.id, tabId: c.tabId, name: c.name, active: c.active })),
    statuses: listStatuses(db).map(s => ({ id: s.id, active: s.active })),
  }
}

// ─── 讀取 ──────────────────────────────────────────────────────────────────────

router.get('/api/osm-releases/meta', (req, res) => {
  const p = need(req, res, 'view'); if (!p) return
  const releases = listReleases(db)
  const counts: Record<string, number> = {}
  for (const r of releases) counts[r.tabId] = (counts[r.tabId] ?? 0) + 1
  const last = releases.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
  res.json({
    ok: true,
    tabs: listTabs(db), components: listComponents(db), statuses: listStatuses(db), counts,
    lastUpdated: last ? { at: last.updatedAt, by: last.updatedBy } : null,
    perms: { view: true, edit: p.edit || p.manage, manage: p.manage },
  })
})

router.get('/api/osm-releases/list', (req, res) => {
  if (!need(req, res, 'view')) return
  const tab = typeof req.query.tab === 'string' ? req.query.tab : undefined
  res.json({ ok: true, releases: listReleases(db, tab) })
})

router.get('/api/osm-releases/:id/revisions', (req, res) => {
  if (!need(req, res, 'view')) return
  res.json({ ok: true, revisions: listRevisions(db, Number(req.params.id)) })
})

// ─── 新增／編輯／刪除 ──────────────────────────────────────────────────────────

router.post('/api/osm-releases', writeLimiter, (req, res) => {
  const p = need(req, res, 'edit'); if (!p) return
  const input = releaseSchema.parse(req.body) as ReleaseInput
  const errors = validateRelease(input, ruleCtx())
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, message: '有欄位需要修正', errors })
  const id = createRelease(db, input, actorOf(p))
  addHistory('osm-releases', '新增版本更新紀錄', `${input.tabId} ${input.releaseDate || input.testDate}`, { id, tabId: input.tabId })
  res.json({ ok: true, id, release: getRelease(db, id) })
})

router.put('/api/osm-releases/:id', writeLimiter, (req, res) => {
  const p = need(req, res, 'edit'); if (!p) return
  const id = Number(req.params.id)
  const { rev, ...rest } = z.object({ rev: z.number().int() }).passthrough().parse(req.body)
  const cur = getRelease(db, id)
  if (!cur) return res.status(404).json({ ok: false, message: '找不到這筆紀錄（可能已被刪除）' })
  // 隱藏欄位／沒送到的元件保留原值，不能因為畫面沒顯示就清掉
  const input = mergeUnsentFields(cur, releaseUpdateSchema.parse(rest) as ReleaseUpdateInput)
  // 停用的狀態／元件：舊紀錄原本就用著的可以保留，不能新選
  const errors = validateRelease(input, { ...ruleCtx(), keepIds: { statusId: cur.statusId, componentIds: cur.values.filter(v => v.state === 'updated').map(v => v.componentId) } })
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, message: '有欄位需要修正', errors })
  const r = updateRelease(db, id, rev, input, actorOf(p))
  if ('current' in r) return res.status(409).json({ ok: false, code: 'CONFLICT', message: `${r.current.updatedBy} 在你編輯期間改過這筆，請重新載入後再改`, current: r.current })
  if (!r.ok) return res.status(404).json({ ok: false, message: '找不到這筆紀錄' })
  const newRev = 'rev' in r ? r.rev : 0
  addHistory('osm-releases', '修改版本更新紀錄', `${input.tabId} ${input.releaseDate || input.testDate}（第 ${newRev} 版）`, { id, rev: newRev })
  res.json({ ok: true, release: getRelease(db, id) })
})

router.delete('/api/osm-releases/:id', (req, res) => {
  const p = need(req, res, 'manage'); if (!p) return
  const id = Number(req.params.id)
  const rev = Number(req.query.rev)
  if (!Number.isInteger(rev)) return res.status(400).json({ ok: false, message: '缺少版本號 rev' })
  const r = deleteRelease(db, id, rev, actorOf(p))
  if ('current' in r) return res.status(409).json({ ok: false, code: 'CONFLICT', message: '這筆在你開啟後被改過，請重新載入再刪除', current: r.current })
  if (!r.ok) return res.status(404).json({ ok: false, message: '找不到這筆紀錄' })
  addHistory('osm-releases', '刪除版本更新紀錄', `#${id}`, { id })
  res.json({ ok: true })
})

// ─── 設定（需要管理設定）──────────────────────────────────────────────────────

const tabSchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().min(1).max(40), showComponents: z.boolean(), showSql: z.boolean(), showResult: z.boolean(), active: z.boolean().optional() })
router.post('/api/osm-releases/tabs', writeLimiter, (req, res) => {
  if (!need(req, res, 'manage')) return
  upsertTab(db, tabSchema.parse(req.body))
  res.json({ ok: true, tabs: listTabs(db) })
})

router.post('/api/osm-releases/components', writeLimiter, (req, res) => {
  if (!need(req, res, 'manage')) return
  const b = z.object({ tabId: z.string().min(1), name: z.string().min(1).max(60), groupName: z.string().max(40).default('') }).parse(req.body)
  if (!listTabs(db).some(t => t.id === b.tabId)) return res.status(400).json({ ok: false, message: '分頁不存在' })
  if (listComponents(db).some(c => c.tabId === b.tabId && c.name === b.name.trim())) return res.status(409).json({ ok: false, message: '這個分頁已經有同名元件' })
  addComponent(db, b)
  res.json({ ok: true, components: listComponents(db) })
})

router.put('/api/osm-releases/components/:id', writeLimiter, (req, res) => {
  if (!need(req, res, 'manage')) return
  updateComponent(db, Number(req.params.id), z.object({ name: z.string().min(1).max(60).optional(), groupName: z.string().max(40).optional(), active: z.boolean().optional() }).parse(req.body))
  res.json({ ok: true, components: listComponents(db) })
})

router.delete('/api/osm-releases/components/:id', (req, res) => {
  if (!need(req, res, 'manage')) return
  const r = deleteComponent(db, Number(req.params.id))
  if (!r.ok) return res.status(409).json({ ok: false, message: r.message })
  res.json({ ok: true, components: listComponents(db) })
})

router.post('/api/osm-releases/statuses', writeLimiter, (req, res) => {
  if (!need(req, res, 'manage')) return
  const b = z.object({ name: z.string().min(1).max(30), tone: z.enum(['test', 'maint', 'hot', 'other']).default('other') }).parse(req.body)
  if (listStatuses(db).some(s => s.name === b.name.trim())) return res.status(409).json({ ok: false, message: '已經有同名狀態' })
  addStatus(db, b)
  res.json({ ok: true, statuses: listStatuses(db) })
})

router.put('/api/osm-releases/statuses/:id', writeLimiter, (req, res) => {
  if (!need(req, res, 'manage')) return
  updateStatus(db, Number(req.params.id), z.object({ name: z.string().min(1).max(30).optional(), tone: z.enum(['test', 'maint', 'hot', 'other']).optional(), active: z.boolean().optional() }).parse(req.body))
  res.json({ ok: true, statuses: listStatuses(db) })
})

router.post('/api/osm-releases/reorder', writeLimiter, (req, res) => {
  if (!need(req, res, 'manage')) return
  const b = z.object({ kind: z.enum(['tabs', 'components', 'statuses']), ids: z.array(z.union([z.string(), z.number()])).max(500) }).parse(req.body)
  reorder(db, b.kind === 'tabs' ? 'osm_release_tabs' : b.kind === 'components' ? 'osm_release_components' : 'osm_release_statuses', b.ids)
  res.json({ ok: true })
})

/**
 * 從 Lark 表一次匯入歷史資料（冪等，重跑只補沒匯過的列）。
 * 網址可以是 wiki（裡面是 sheet）或 sheets 連結；匯入「全部分頁」，選取目錄這類沒有日期欄的分頁會自動略過。
 */
router.post('/api/osm-releases/import', writeLimiter, async (req, res, next) => {
  const p = need(req, res, 'manage'); if (!p) return
  try {
    const { url } = z.object({ url: z.string().url() }).parse(req.body)
    const u = new URL(url)
    if (!/\.(larksuite\.com|feishu\.cn)$/.test(u.hostname)) return res.status(400).json({ ok: false, message: '只接受 Lark 的網址' })
    const token = await getLarkToken()
    const H = { Authorization: `Bearer ${token}` }
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    let sheetToken = (u.pathname.match(/\/sheets\/([A-Za-z0-9]+)/) ?? [])[1]
    const wiki = (u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/) ?? [])[1]
    if (!sheetToken && wiki) {
      const node = await (await fetch(`${base}/open-apis/wiki/v2/spaces/get_node?token=${wiki}`, { headers: H })).json() as { code: number; data?: { node?: { obj_token?: string; obj_type?: string } } }
      if (node.code !== 0 || node.data?.node?.obj_type !== 'sheet') return res.status(400).json({ ok: false, message: '這個 Wiki 頁讀不到，或裡面不是試算表' })
      sheetToken = node.data.node.obj_token
    }
    if (!sheetToken) return res.status(400).json({ ok: false, message: '網址裡找不到試算表' })
    const meta = await (await fetch(`${base}/open-apis/sheets/v3/spreadsheets/${sheetToken}/sheets/query`, { headers: H })).json() as { code: number; data?: { sheets?: { sheet_id: string; title: string }[] } }
    if (meta.code !== 0) return res.status(400).json({ ok: false, message: `讀不到試算表（code ${meta.code}），請確認機器人有權限` })
    const results: { tab: string; added?: number; skipped?: number; error?: string }[] = []
    for (const s of meta.data?.sheets ?? []) {
      const v = await (await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${sheetToken}/values/${s.sheet_id}!A1:AD2000?valueRenderOption=ToString`, { headers: H })).json() as { code: number; data?: { valueRange?: { values?: unknown[][] } } }
      try {
        const parsed = parseReleaseSheet((v.data?.valueRange?.values ?? []) as never)
        const r = applyParsedSheet(db, { sheetKey: `${sheetToken}:${s.sheet_id}`, tabTitle: s.title, parsed, actor: '從 Lark 匯入' })
        results.push({ tab: s.title, added: r.added, skipped: r.skipped })
      } catch (e) {
        results.push({ tab: s.title, error: (e as Error).message })
      }
    }
    addHistory('osm-releases', '從 Lark 匯入版本更新紀錄', results.map(r => `${r.tab}: ${r.error ? '略過' : `+${r.added}`}`).join('、'), { results })
    res.json({ ok: true, results })
  } catch (e) { next(e) }
})

// ─── 個人檢視 ──────────────────────────────────────────────────────────────────

router.get('/api/osm-releases/views', (req, res) => {
  const p = need(req, res, 'view'); if (!p) return
  res.json({ ok: true, views: listViews(db, p.acc.email) })
})
router.post('/api/osm-releases/views', writeLimiter, (req, res) => {
  const p = need(req, res, 'view'); if (!p) return
  const b = z.object({ name: z.string().min(1).max(40), filters: z.record(z.string(), z.unknown()) }).parse(req.body)
  if (listViews(db, p.acc.email).length >= 30) return res.status(400).json({ ok: false, message: '最多存 30 個檢視' })
  saveView(db, p.acc.email, b.name, b.filters)
  res.json({ ok: true, views: listViews(db, p.acc.email) })
})
router.delete('/api/osm-releases/views/:id', (req, res) => {
  const p = need(req, res, 'view'); if (!p) return
  deleteView(db, p.acc.email, Number(req.params.id))
  res.json({ ok: true, views: listViews(db, p.acc.email) })
})

// ─── 線上目前版本（只有抓得到的元件才顯示）──────────────────────────────────

/** Toppath 分頁：GM／GW／API／TG-API 對應 staticpublic 的版本 JSON。其他元件目前沒有線上來源，不回 */
router.get('/api/osm-releases/live', async (req, res) => {
  if (!need(req, res, 'view')) return
  const tab = String(req.query.tab ?? '')
  if (tab !== 'toppath') return res.json({ ok: true, live: [] })
  const base = (process.env.TOPPATH_VERSION_BASE_URL ?? 'https://staticpublic.osmplay.com/prod/version-info').replace(/\/$/, '')
  const map = [['GM', 'g-admin'], ['API', 'g-api'], ['GW', 'g-gw'], ['TG-API', 'g-tg-api']] as const
  const live = await Promise.all(map.map(async ([name, comp]) => {
    try {
      const d = await (await fetch(`${base}/deployment-version-${comp}.json`, { signal: AbortSignal.timeout(8000) })).json() as { version?: string; updatetime?: string }
      return { name, version: d.version ?? '', at: d.updatetime ?? '' }
    } catch (e) {
      return { name, version: '', at: '', error: (e as Error).message }
    }
  }))
  res.json({ ok: true, live, fetchedAt: Date.now(), env: '正式環境' })
})

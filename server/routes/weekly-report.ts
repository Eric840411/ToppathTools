/**
 * server/routes/weekly-report.ts
 * 週報彙整 — 獨立工具（不掛在 OSM Tools 底下）。每週貼上當週 Lark Base 網址，
 * 動態讀取「成员」/「专案」下拉選項，填寫補充說明後直接新增一列到該表。
 * 詳見 CLAUDE.md 第 23 節。
 */
import { Router } from 'express'
import { z } from 'zod'
import { addHistory, getLarkToken } from '../shared.js'

export const router = Router()

/** 解析 Lark Base 網址（/base/{appToken}?table={tableId}），跟 parseLarkSheetUrl（/sheets、/wiki 用）是不同格式 */
function parseLarkBaseUrl(url: string): { appToken: string; tableId: string } | null {
  const appMatch = url.match(/\/base\/([A-Za-z0-9]+)/)
  const tableMatch = url.match(/[?&]table=([A-Za-z0-9]+)/)
  if (!appMatch || !tableMatch) return null
  return { appToken: appMatch[1], tableId: tableMatch[1] }
}

const REQUIRED_FIELDS = ['成员', '专案', '补充说明'] as const

interface LarkFieldOption { id: string; name: string }
interface LarkField { field_name: string; type: number; property?: { options?: { id: string; name: string }[] } | null }

// POST /api/weekly-report/parse — 貼上網址，讀取欄位選項並驗證必要欄位存在
router.post('/api/weekly-report/parse', async (req, res) => {
  const body = z.object({ url: z.string().min(1) }).parse(req.body)
  const parsed = parseLarkBaseUrl(body.url)
  if (!parsed) return res.status(400).json({ ok: false, message: '網址格式不正確，需要包含 /base/{appToken} 與 ?table={tableId}' })

  try {
    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${parsed.appToken}/tables/${parsed.tableId}/fields?page_size=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await resp.json() as { code?: number; msg?: string; data?: { items?: LarkField[] } }
    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: `讀取表格失敗：${data.msg ?? resp.statusText}（請確認網址正確、且此帳號有存取權限）` })
    }
    const fields = data.data?.items ?? []
    const fieldNames = new Set(fields.map(f => f.field_name))
    const missingFields = REQUIRED_FIELDS.filter(f => !fieldNames.has(f))
    if (missingFields.length > 0) {
      return res.status(400).json({ ok: false, message: `這張表缺少必要欄位：${missingFields.join('、')}`, missingFields })
    }

    const memberField = fields.find(f => f.field_name === '成员')
    const projectField = fields.find(f => f.field_name === '专案')
    const members: LarkFieldOption[] = (memberField?.property?.options ?? []).map(o => ({ id: o.id, name: o.name }))
    const projects: LarkFieldOption[] = (projectField?.property?.options ?? []).map(o => ({ id: o.id, name: o.name }))

    res.json({ ok: true, appToken: parsed.appToken, tableId: parsed.tableId, members, projects })
  } catch (e) {
    res.status(500).json({ ok: false, message: `讀取失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

// POST /api/weekly-report/submit — 永遠新增一列（2026-08-11 討論結論：曾考慮「查到同成員既有列就 PATCH
// 附加」，但這個 read-then-write 模式有兩個真實併發風險——同一人短時間內兩次送出可能兩次都查到「還沒有」
// 變成新增兩列，且 Lark Bitable 的 record update API 沒有 revision/ETag 可偵測「PATCH 當下是否已被別人
// 手動編輯過」，PATCH 有機會蓋掉別人正在 Lark 網頁上的手動編輯。永遠新增一列完全不會共用/覆寫任何既有
// 欄位，兩個風險都直接消失；代價只是同一人這週送多次會有多列，是可接受的小麻煩，不是資料風險）
router.post('/api/weekly-report/submit', async (req, res) => {
  const body = z.object({
    appToken: z.string().min(1),
    tableId: z.string().min(1),
    member: z.string().min(1),
    project: z.string().optional(),
    content: z.string().min(1),
  }).parse(req.body)

  try {
    const token = await getLarkToken()
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
    const fields: Record<string, string> = { '成员': body.member, '补充说明': body.content }
    if (body.project) fields['专案'] = body.project

    const resp = await fetch(`${base}/open-apis/bitable/v1/apps/${body.appToken}/tables/${body.tableId}/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
    const data = await resp.json() as { code?: number; msg?: string; data?: { record?: { record_id?: string } } }
    if (!resp.ok || data.code !== 0) {
      return res.status(400).json({ ok: false, message: `送出失敗：${data.msg ?? resp.statusText}` })
    }

    addHistory('weekly-report', `週報彙整 — ${body.member}`, body.content.slice(0, 300), {
      appToken: body.appToken, tableId: body.tableId, member: body.member, project: body.project ?? '', content: body.content,
    })

    res.json({ ok: true, recordId: data.data?.record?.record_id ?? '' })
  } catch (e) {
    res.status(500).json({ ok: false, message: `送出失敗：${e instanceof Error ? e.message : String(e)}` })
  }
})

/**
 * 版本驗證表（docs/features/35-osm-verify.md）：前後端共用的規則，只寫一份。
 * 規格：osm-qa-agent reports/spec-verify-form-1120.md v2（CodeX r1 審過）。
 *
 * - 發布狀態與學習狀態分開（一個是人填的流程、一個是 agent 學習進度）
 * - 標「已上正式」必須至少綁一筆有效的版本紀錄，而且驗證項目的平台都要有版本紀錄涵蓋
 * - 開單冪等 key 寫進 Meegle 描述尾，結果不明時用它到遠端查；查無也不自動重送
 */

export type PublishStatus = 'draft' | 'verified' | 'released'
export type LearnStatus = 'none' | 'learning' | 'done' | 'failed'
export type TicketStatus = 'pending' | 'created' | 'unknown' | 'failed'

export const PUBLISH_LABEL: Record<PublishStatus, string> = { draft: '填寫中', verified: '驗證完成', released: '已上正式' }
export const LEARN_LABEL: Record<LearnStatus, string> = { none: '未開始', learning: '學習中', done: '已完成', failed: '失敗' }
/** failed 叫「開單失敗」，不能叫驗證失敗（使用者 1120 定） */
export const TICKET_LABEL: Record<TicketStatus, string> = { pending: '開單中', created: '已開單', unknown: '結果不明', failed: '開單失敗' }

export const EVENT_TYPES = ['batch.released', 'batch.ticket_created', 'batch.revised'] as const
export type EventType = typeof EVENT_TYPES[number]

export interface BatchInput {
  year: number
  batch: string
  publishStatus: Exclude<PublishStatus, 'released'>
  prodVersion: string
}

export interface ItemInput {
  platform: string
  type: string
  description: string
  env: string
  result: string
  okCount: number
  verifier: string
  attachments: string
  remark: string
}

/** 顯示名稱＝年份＋批次（例 2026-1120）：帶年份避免跨年同一個 MMDD 覆寫 */
export const batchDisplayName = (year: number, batch: string) => `${year}-${batch.trim()}`

export function validateBatch(input: BatchInput): Record<string, string> {
  const e: Record<string, string> = {}
  if (!Number.isInteger(input.year) || input.year < 2020 || input.year > 2100) e.year = '年份不正確'
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/.test(input.batch.trim())) e.batch = '批次只能用英數字與 . _ -（例 1120），最多 20 字'
  if (input.publishStatus !== 'draft' && input.publishStatus !== 'verified') e.publishStatus = '發布狀態只能是填寫中或驗證完成（已上正式要用「標記已上正式」）'
  if (input.prodVersion.length > 4000) e.prodVersion = '正式版本快照太長'
  return e
}

export function validateItem(input: ItemInput): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.description.trim()) e.description = '請填寫描述'
  if (input.description.length > 5000) e.description = '描述太長'
  if (input.platform.length > 200) e.platform = '平台太長'
  if (input.type.length > 100) e.type = '類型太長'
  if (!Number.isInteger(input.okCount) || input.okCount < 0 || input.okCount > 100000) e.okCount = 'OK 數量要是 0 以上的整數'
  for (const k of ['env', 'result', 'verifier'] as const) if (input[k].length > 200) e[k] = '太長'
  if (input.attachments.length > 4000) e.attachments = '附件太長'
  if (input.remark.length > 5000) e.remark = '備註太長'
  return e
}

/** 「H5,PC,Middle」→ ['H5','PC','Middle']（Lark 表用逗號分隔多個平台） */
export function splitPlatforms(s: string): string[] {
  return [...new Set(s.split(/[,，、/]+/).map(x => x.trim()).filter(Boolean))]
}

export const normKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')

// ─── 上正式檢查 ───────────────────────────────────────────────────────────────

export interface CheckRelease {
  id: number
  valid: boolean          // 版本紀錄還在（沒被刪）
  tabId: string
  tabName: string
  updatedComponents: string[]  // 這筆「有更新」的元件名稱
}

/**
 * 平台對應（管理設定）：平台 → 涵蓋它的分頁或「分頁/元件」。
 *   { "H5": ["osm/H5 Client"], "OSM後台": ["osm/BG Client"], "Center": ["toppath"] }
 * 沒設對應時只認「完全同名」：平台＝分頁 id／分頁名稱，或＝綁定版本紀錄裡有更新的元件名稱。
 * 不做模糊比對——寬鬆比對會把沒涵蓋的平台當成有，擋不住漏綁。
 */
export type PlatformMap = Record<string, string[]>

export interface ReleaseCheck {
  ok: boolean
  missingBinding: boolean       // 一筆有效版本紀錄都沒綁
  invalidReleaseIds: number[]   // 綁了但已被刪
  noItems: boolean
  itemsWithoutPlatform: number
  uncovered: string[]           // 沒有任何綁定版本紀錄涵蓋的平台
}

export function platformCovered(platform: string, releases: CheckRelease[], map: PlatformMap): boolean {
  const valid = releases.filter(r => r.valid)
  const mapped = Object.entries(map).find(([k]) => normKey(k) === normKey(platform))?.[1]
  if (mapped && mapped.length) {
    return mapped.some(target => {
      const [tab, comp] = target.split('/').map(x => x.trim())
      return valid.some(r => (normKey(r.tabId) === normKey(tab) || normKey(r.tabName) === normKey(tab))
        && (!comp || r.updatedComponents.some(c => normKey(c) === normKey(comp))))
    })
  }
  const p = normKey(platform)
  return valid.some(r => normKey(r.tabId) === p || normKey(r.tabName) === p || r.updatedComponents.some(c => normKey(c) === p))
}

export function releaseCheck(items: { platform: string }[], releases: CheckRelease[], map: PlatformMap): ReleaseCheck {
  const validCount = releases.filter(r => r.valid).length
  const platforms = [...new Set(items.flatMap(i => splitPlatforms(i.platform)))]
  const uncovered = platforms.filter(p => !platformCovered(p, releases, map))
  const itemsWithoutPlatform = items.filter(i => splitPlatforms(i.platform).length === 0).length
  const r: ReleaseCheck = {
    ok: false,
    missingBinding: validCount === 0,
    invalidReleaseIds: releases.filter(x => !x.valid).map(x => x.id),
    noItems: items.length === 0,
    itemsWithoutPlatform,
    uncovered,
  }
  r.ok = !r.missingBinding && !r.noItems && itemsWithoutPlatform === 0 && uncovered.length === 0
  return r
}

// ─── 開單 ─────────────────────────────────────────────────────────────────────

/** 冪等 key：批次 id 前 8 碼＋項目 id＋這個項目第幾張。同一個項目同時兩個請求算出同一把 → DB 唯一約束擋第二個 */
export const ticketKey = (batchId: string, itemId: number, seq: number) => `OSMV-${batchId.replace(/-/g, '').slice(0, 8)}-${itemId}-${seq}`
export const KEY_MARK = '[osm-verify-key]'
export const keyLine = (key: string) => `${KEY_MARK} ${key}`

/** 單名：跟 Lark 表「摘要」公式一樣是 [主題][類別]描述 */
export function ticketName(item: { type: string; platform: string; description: string }): string {
  const first = item.description.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  const head = `${item.type ? `[${item.type}]` : ''}${item.platform ? `[${item.platform}]` : ''}`
  return (head + first).slice(0, 200)
}

export function ticketDescription(batchName: string, item: ItemInput, key: string): string {
  const lines = [
    `版本驗證表：${batchName}`,
    item.platform && `平台：${item.platform}`,
    item.type && `類型：${item.type}`,
    '',
    item.description.trim(),
    '',
    item.env && `驗證環境：${item.env}`,
    item.result && `結果：${item.result}`,
    item.verifier && `驗證人：${item.verifier}`,
    item.remark.trim() && `備註：${item.remark.trim()}`,
    item.attachments.trim() && `附件：${item.attachments.trim()}`,
    '',
    keyLine(key),   // 一定在最後一行：結果不明時用它到遠端查
  ]
  return lines.filter((l): l is string => typeof l === 'string').join('\n').replace(/\n{3,}/g, '\n\n')
}

/** 開單設定面板依類型要填的欄位 */
export type CreateFieldKind = 'text' | 'select' | 'requirement' | 'related' | 'template'
export interface CreateFieldDef {
  key: string
  name: string
  kind: CreateFieldKind
  options?: { id: string; name: string }[]
}
export interface TypeCreateSchema {
  typeKey: string
  fields: CreateFieldDef[]     // 要使用者填的必填欄
  unsupported: string[]        // 工具不支援的必填欄 → 這個類型不能開
}

/** 使用者填的值 → 要送的 field_value；有缺或不合法回錯誤（前端即時提示、後端送出前同一份再驗） */
export function resolveCreateValues(schema: TypeCreateSchema, values: Record<string, string>): { fields: { field_key: string; field_value: string }[]; errors: Record<string, string> } {
  const fields: { field_key: string; field_value: string }[] = []
  const errors: Record<string, string> = {}
  if (schema.unsupported.length) errors._type = `這個類型有工具不支援的必填欄位：${schema.unsupported.join('、')}`
  for (const f of schema.fields) {
    const v = (values[f.key] ?? '').trim()
    if (!v) { errors[f.key] = `請填「${f.name}」`; continue }
    if (f.kind === 'select' || f.kind === 'template' || f.kind === 'requirement') {
      if (!(f.options ?? []).some(o => o.id === v)) { errors[f.key] = `「${f.name}」的選項不存在（可能剛被改過，請重新讀取）`; continue }
    }
    if (f.kind === 'related' && !/^\d+$/.test(v)) { errors[f.key] = `「${f.name}」要填單號（數字）`; continue }
    if (v.length > 2000) { errors[f.key] = `「${f.name}」太長`; continue }
    fields.push({ field_key: f.key, field_value: v })
  }
  return { fields, errors }
}

/** 學習事件 payload（契約：agent 端 scripts/verify-form/pull-events.cjs） */
export interface SnapshotPayload {
  batchName: string
  prodVersion: string
  releases: { id: number; rev: number }[]
  items: { id: number; platform: string; type: string; description: string; env: string; result: string; okCount: number; verifier: string; tickets: string[] }[]
}

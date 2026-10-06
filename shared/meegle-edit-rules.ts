/**
 * Meegle 批量修改前後端共用的規則（同一份，不在兩邊各寫——CLAUDE.md 跨功能踩坑 #3）。
 * 前端算預覽、後端送出前**用同一個函式重算一次**：後端不收前端算好的 option_id／user_key，只收 Sheet 上的原文。
 *
 * 規則（使用者 10/02：欄位全照 Jira 版；CodeX 線框：每欄 不修改／Sheet 欄／固定值／明確清空）：
 *  - Sheet 欄模式下，該列**空白＝這欄不修改**（不是清空）；要清空必須明確選「明確清空」
 *  - 單選：用選項**名稱**比對（去頭尾空白、全等），對不到 → 擋列
 *  - 人員：Sheet 上是暱稱，靠開單那份人員對照表換成 Meegle 帳號；**有任何一個名字對不到 → 擋列**（CodeX：未對照擋受影響列。
 *    跟開單不同——開單對不到是角色留空，修改對不到如果照送，等於把人從角色上拿掉）
 *  - 日期：同狀態工具的 parseSheetDate（台北當天 00:00）
 *  - 任務名稱不能清空
 * Meegle 實測（2026-10-02 #15190441）：清空一律 field_value ""；select 寫 option_id；角色只能 role-operate add／remove。
 */
import { MEEGLE_ROLE_DEFS, normAlias, splitPeople, type MappedPerson, type MeegleRoleKey } from './meegle-batch-rules.js'
import { parseSheetDate, taipeiDay } from './meegle-status-rules.js'

export const EDIT_STAGE_DONE = '已修改欄位'   // 跟 Jira 批量修改同一個字，Sheet 不用改

/** related＝關聯多個工作項（2026-10-06 關聯任務）：field_value 是單號數字陣列的 JSON 字串 `[15244721,15245280]`（實測；字串陣列、逗號字串都會被擋） */
export type EditKind = 'name' | 'text' | 'multi' | 'select' | 'date' | 'role' | 'related'
export type EditFieldDef = { key: string; label: string; group: string; kind: EditKind; clearable: boolean; images?: boolean }

export const EDIT_FIELDS: EditFieldDef[] = [
  { key: 'name', label: '任務名稱', group: '名稱', kind: 'name', clearable: false },
  { key: 'description', label: '描述', group: '描述與圖片', kind: 'multi', clearable: true, images: true },
  { key: 'priority', label: '優先順序', group: '優先順序', kind: 'select', clearable: true },
  ...MEEGLE_ROLE_DEFS.map(r => ({ key: `role:${r.key}`, label: r.label, group: '人員', kind: 'role' as const, clearable: true })),
  { key: 'field_07e581', label: '嚴重性 (QA)', group: '測試頁', kind: 'select', clearable: true },
  { key: 'field_710be5', label: 'QA測試難易度', group: '測試頁', kind: 'select', clearable: true },
  { key: 'field_e742d0', label: '退件', group: '測試頁', kind: 'select', clearable: true },
  { key: 'field_3db883', label: '本機測試完成時間', group: '測試頁', kind: 'date', clearable: true },
  { key: 'field_cbc597', label: '上C服時間', group: '測試頁', kind: 'date', clearable: true },
  { key: 'field_ce2cfc', label: '上線時間', group: '測試頁', kind: 'date', clearable: true },
  { key: 'field_1ab2a7', label: '開發說明', group: '開發說明', kind: 'multi', clearable: true },
  { key: 'field_f6b7ab', label: 'Gitlab 連結', group: 'Gitlab', kind: 'text', clearable: true },
]
export const editFieldDef = (key: string) => EDIT_FIELDS.find(f => f.key === key)
export const roleKeyOf = (key: string) => (key.startsWith('role:') ? key.slice(5) as MeegleRoleKey : null)

/** ② 每欄的設定 */
export type FieldMode = { mode: 'skip' } | { mode: 'sheet'; column: string } | { mode: 'fixed'; value: string } | { mode: 'clear' }

/** 一列一欄要做的事（原文）。前端組好送給後端；後端自己再用 resolveEdit 換成 Meegle 的值 */
export type RawEdit = { key: string; op: 'set'; raw: string } | { key: string; op: 'clear' }

/** 依 ② 的設定取出這一列要改的欄位（原文）。Sheet 欄空白＝不改。 */
export function rawEditsForRow(record: Record<string, unknown>, modes: Record<string, FieldMode>): RawEdit[] {
  const out: RawEdit[] = []
  for (const f of EDIT_FIELDS) {
    const m = modes[f.key]
    if (!m || m.mode === 'skip') continue
    if (m.mode === 'clear') { if (f.clearable) out.push({ key: f.key, op: 'clear' }); continue }
    const raw = m.mode === 'sheet' ? String(record[m.column] ?? '') : m.value
    if (!raw.trim()) continue
    out.push({ key: f.key, op: 'set', raw })
  }
  return out
}

export type Option = { id: string; name: string }
export type ResolveCtx = { options: Record<string, Option[]>; personMap: Record<string, MappedPerson> }
/** 換成 Meegle 的值：value＝field_value 字串（清空是 ""）；role 的 userKeys＝最後角色上要有的人（清空是 []） */
export type ResolvedEdit =
  | { key: string; kind: Exclude<EditKind, 'role'>; value: string; display: string }
  | { key: string; kind: 'role'; userKeys: string[]; display: string }
export type ResolveResult = { ok: true; edit: ResolvedEdit } | { ok: false; reason: string }

export function resolveEdit(e: RawEdit, ctx: ResolveCtx): ResolveResult {
  const f = editFieldDef(e.key)
  if (!f) return { ok: false, reason: `不支援的欄位 ${e.key}` }
  if (e.op === 'clear') {
    if (!f.clearable) return { ok: false, reason: `${f.label}不能清空` }
    return { ok: true, edit: f.kind === 'role' ? { key: f.key, kind: 'role', userKeys: [], display: '（清空）' } : { key: f.key, kind: f.kind, value: '', display: '（清空）' } }
  }
  return resolveFieldValue(f, e.raw, ctx)
}

/**
 * 單一欄位的原文 → Meegle 的值（不含清空）。開單的「其他欄位」（shared/meegle-create-fields.ts）也用這一支，
 * 規則只寫一份（CLAUDE.md 跨功能踩坑 #3）。
 */
export function resolveFieldValue(f: EditFieldDef, raw: string, ctx: ResolveCtx): ResolveResult {
  switch (f.kind) {
    case 'name':
    case 'text': {
      const v = raw.trim()
      if (!v) return { ok: false, reason: `${f.label}是空的` }
      return { ok: true, edit: { key: f.key, kind: f.kind, value: v, display: v } }
    }
    case 'multi':
      return { ok: true, edit: { key: f.key, kind: 'multi', value: raw.replace(/\r\n/g, '\n').trim(), display: raw.trim() } }
    case 'select': {
      const name = raw.trim()
      const hits = (ctx.options[f.key] ?? []).filter(o => o.name.trim() === name)
      if (hits.length === 0) return { ok: false, reason: `${f.label}「${name}」不是 Meegle 的選項（可選：${(ctx.options[f.key] ?? []).map(o => o.name).join('／') || '讀不到選項'}）` }
      if (hits.length > 1) return { ok: false, reason: `${f.label}「${name}」對到多個選項` }
      return { ok: true, edit: { key: f.key, kind: 'select', value: hits[0].id, display: hits[0].name } }
    }
    case 'date': {
      const d = parseSheetDate(raw)
      if ('reason' in d) return { ok: false, reason: `${f.label}：${d.reason}` }
      if (d.ms == null) return { ok: false, reason: `${f.label}是空的` }
      return { ok: true, edit: { key: f.key, kind: 'date', value: String(d.ms), display: d.day.replace(/-/g, '/') } }
    }
    case 'related': {
      // 「#15244721, 15245280」「15244721、15245280」都收；每個都要是單號（5 位以上數字），有一個不是就擋，不略過
      const parts = raw.split(/[,，、\s]+/).map(x => x.trim().replace(/^#/, '')).filter(Boolean)
      const bad = parts.filter(x => !/^\d{5,}$/.test(x))
      if (bad.length) return { ok: false, reason: `${f.label}：「${bad.join('、')}」不是單號（填 Meegle 單號，多個用逗號分隔）` }
      if (!parts.length) return { ok: false, reason: `${f.label}是空的` }
      const ids = [...new Set(parts)]
      return { ok: true, edit: { key: f.key, kind: 'related', value: `[${ids.join(',')}]`, display: ids.map(x => `#${x}`).join('、') } }
    }
    case 'role': {
      const names = splitPeople(raw)
      const missing = names.filter(n => !ctx.personMap[normAlias(n)])
      if (missing.length) return { ok: false, reason: `${f.label}：${missing.join('、')} 沒有人員對照，先到開單分頁設定` }
      const people = names.map(n => ctx.personMap[normAlias(n)])
      const keys = [...new Set(people.map(p => p.userKey))]
      return { ok: true, edit: { key: f.key, kind: 'role', userKeys: keys, display: people.map(p => p.name || p.email).join('、') } }
    }
  }
}

/** 一整列：全部欄位都換得出來才能送；有任何一欄換不出來 → 整列擋（不送半套） */
export function resolveRow(raws: RawEdit[], ctx: ResolveCtx): { edits: ResolvedEdit[]; issues: string[] } {
  const edits: ResolvedEdit[] = []
  const issues: string[] = []
  for (const r of raws) {
    const res = resolveEdit(r, ctx)
    if ('edit' in res) edits.push(res.edit); else issues.push(res.reason)
  }
  return { edits, issues }
}

/** Meegle 上目前的值（顯示與比對用）。select 存 option_id、date 存毫秒字串、role 存 user_key 陣列、文字原樣；空＝"" 或 [] */
export type CurrentValues = Record<string, string | string[]>

/** 畫面顯示目前值 */
export function displayCurrent(key: string, cur: string | string[] | undefined, ctx: { options: Record<string, Option[]>; people?: Record<string, string> }): string {
  const f = editFieldDef(key)
  if (!f) return ''
  if (f.kind === 'role') { const ks = (cur as string[] | undefined) ?? []; return ks.length ? ks.map(k => ctx.people?.[k] ?? k).join('、') : '（空白）' }
  const v = String(cur ?? '')
  if (!v) return '（空白）'
  if (f.kind === 'select') return ctx.options[key]?.find(o => o.id === v)?.name ?? v
  if (f.kind === 'date') return taipeiDay(Number(v)).replace(/-/g, '/')
  return v
}

/** 比對「目前值」跟「要的值」是否已經一樣（讀回驗證、預覽標「沒有變更」都用這個） */
export function sameValue(edit: ResolvedEdit, cur: string | string[] | undefined, normText: (s: string) => string = s => s.replace(/\s+/g, '')): boolean {
  if (edit.kind === 'role') { const a = [...edit.userKeys].sort(); const b = [...((cur as string[] | undefined) ?? [])].sort(); return a.length === b.length && a.every((x, i) => x === b[i]) }
  const v = String(cur ?? '')
  if (edit.kind === 'date') return edit.value === '' ? v === '' : !!v && taipeiDay(Number(v)) === taipeiDay(Number(edit.value))
  if (edit.kind === 'multi') return normText(v) === normText(edit.value)
  return v.trim() === edit.value.trim()
}

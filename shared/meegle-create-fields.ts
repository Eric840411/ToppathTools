/**
 * Meegle 批量開單「其他欄位」（2026-10-06 使用者：開單時也要能設所有欄位，像以前 Jira 那樣自己選要填哪些）。
 * 前端預覽與後端送出共用這一份；值怎麼換成 Meegle 的格式沿用批量修改的 resolveFieldValue（同一套規則，不另寫）。
 *
 * 範圍：任務項在兩個空間 key 相同的欄位（2026-10-06 實查 fixture server/fixtures/meegle/meta-fields.*）。
 * 不放：名稱／描述／關聯需求／任務類型／人員（開單本來就有專門的欄）、測試說明（有批量評論工具）、系統欄位。
 * select 的選項每個空間即時讀，送出時後端只收「選項名稱」，自己換 option_id。
 */
import { EDIT_FIELDS, resolveFieldValue, type EditFieldDef, type Option } from './meegle-edit-rules.js'

const fromEdit = (key: string) => EDIT_FIELDS.find(f => f.key === key)!

export const CREATE_EXTRA_FIELDS: EditFieldDef[] = [
  { ...fromEdit('priority'), group: '基本' },
  { key: 'field_9a3fe4', label: '難易度', group: '基本', kind: 'select', clearable: true },
  { ...fromEdit('field_07e581'), group: '測試頁' },
  { ...fromEdit('field_710be5'), group: '測試頁' },
  { ...fromEdit('field_e742d0'), group: '測試頁' },
  { ...fromEdit('field_3db883'), group: '時間' },
  { ...fromEdit('field_cbc597'), group: '時間' },
  { ...fromEdit('field_ce2cfc'), group: '時間' },
  { ...fromEdit('field_1ab2a7'), group: '說明與連結' },
  { key: 'field_44db22', label: '重新產生問題步驟', group: '說明與連結', kind: 'multi', clearable: true },
  { ...fromEdit('field_f6b7ab'), group: '說明與連結' },
]
export const CREATE_EXTRA_GROUPS = ['基本', '測試頁', '時間', '說明與連結'] as const
export const createExtraDef = (key: string) => CREATE_EXTRA_FIELDS.find(f => f.key === key)
export const CREATE_SELECT_KEYS = CREATE_EXTRA_FIELDS.filter(f => f.kind === 'select').map(f => f.key)

/**
 * 一列的其他欄位（原文）→ 要送的 field_value。空白＝不填（開單沒有「清空」的意思）。
 * 有任何一欄換不出來（選項不存在、日期看不懂、不認得的欄位）→ issues，整列擋（不送半套）。
 */
export function resolveCreateExtras(values: Record<string, string> | undefined, options: Record<string, Option[]>): {
  fields: Array<{ field_key: string; field_value: string }>
  display: Array<{ label: string; value: string }>
  issues: string[]
} {
  const fields: Array<{ field_key: string; field_value: string }> = []
  const display: Array<{ label: string; value: string }> = []
  const issues: string[] = []
  for (const [key, raw] of Object.entries(values ?? {})) {
    if (!raw.trim()) continue
    const def = createExtraDef(key)
    if (!def) { issues.push(`不支援的欄位 ${key}`); continue }
    const r = resolveFieldValue(def, raw, { options, personMap: {} })
    if ('reason' in r) { issues.push(r.reason); continue }
    if (r.edit.kind === 'role') { issues.push(`${def.label}不能在這裡設定`); continue }
    fields.push({ field_key: def.key, field_value: r.edit.value })
    display.push({ label: def.label, value: r.edit.display })
  }
  return { fields, display, issues }
}

/**
 * Meegle 批量開單：每一列「能不能送、送什麼」的規則。前端預覽與後端送出共用這一份
 * （前後端各寫一份一定會漂移，症狀是「畫面標可送出、送出卻被擋」或反過來）。
 *
 * 規則（2026-10-01 跟使用者、CodeX 定案）：
 * - 任務名稱：Sheet「摘要」→「標題」。都空 → 擋。
 * - 關聯需求（必填）：畫面上逐列覆寫 → Sheet「關聯需求」欄 → 整批預設。
 *   **有填但對不到（找不到、同名多筆）就擋，不退回預設**——退回預設等於把單掛到使用者沒選的需求底下。
 * - 人員：Sheet 存的是暱稱（Dean、zen、James Chang），靠人員對照表換成 Meegle 帳號。
 *   **對不上的名字，那個角色留空、不擋整列**（使用者決定），但要列成警告，送出前看得到。
 *   一格可以有多個人（「zen,James Chang」），逗號／頓號／換行分隔。
 * - 受托人、Code Review 人員 Sheet 沒有欄位：整批預設，可逐列覆寫。
 * - 「進度」欄不使用（不等於 Meegle 狀態）。開單後要不要推狀態，由整批的「開單後推到」決定。
 */

export const MEEGLE_ROLE_DEFS = [
  { key: 'assignee', label: '受托人', sheetColumn: null },
  { key: 'rdOwner', label: 'RD 負責人', sheetColumn: 'RD負責人' },
  { key: 'reporter', label: '回報者', sheetColumn: '回報者' },
  { key: 'codeReview', label: 'Code Review', sheetColumn: null },
  { key: 'qaVerifier', label: 'QA 驗證', sheetColumn: 'QA驗證人員' },
] as const
export type MeegleRoleKey = typeof MEEGLE_ROLE_DEFS[number]['key']

export const SHEET_REQUIREMENT_COLUMN = '關聯需求'

/** 人名正規化：去頭尾空白、多個空白併成一個、不分大小寫。對照表的鍵就是這個。 */
export function normAlias(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 一格裡的多個人名。 */
export function splitPeople(cell: string | undefined | null): string[] {
  return String(cell ?? '').split(/[,，、\n]/).map(s => s.trim()).filter(Boolean)
}

export type Requirement = { id: string; name: string }

export type RequirementMatch =
  | { ok: true; requirement: Requirement }
  | { ok: false; reason: 'NOT_FOUND' | 'MULTIPLE' | 'EMPTY'; message: string; candidates?: Requirement[] }

/**
 * 需求名稱精確比對（去頭尾空白、不分大小寫）。同名多筆不挑。
 * 也接受直接填需求 ID（同名多筆時的解法）。
 */
export function pickRequirement(text: string, all: Requirement[]): RequirementMatch {
  const raw = text.trim()
  if (!raw) return { ok: false, reason: 'EMPTY', message: '沒有填關聯需求' }
  const byId = all.filter(r => r.id === raw.replace(/^#/, ''))
  if (byId.length === 1) return { ok: true, requirement: byId[0] }
  const want = raw.toLowerCase()
  const hits = all.filter(r => r.name.trim().toLowerCase() === want)
  if (hits.length === 0) return { ok: false, reason: 'NOT_FOUND', message: `找不到名稱為「${raw}」的需求` }
  if (hits.length > 1) return { ok: false, reason: 'MULTIPLE', message: `有 ${hits.length} 個需求都叫「${raw}」，請改選或填需求 ID`, candidates: hits }
  return { ok: true, requirement: hits[0] }
}

export type MappedPerson = { userKey: string; email: string; name: string }

export type RowInput = {
  record: Record<string, unknown>                          // Sheet 原始列
  requirementOverride?: string                              // 畫面上逐列覆寫（需求 ID）
  roleOverrides?: Partial<Record<MeegleRoleKey, string[]>>  // 畫面上逐列覆寫（人名）
}

export type BatchDefaults = {
  requirementId: string                                     // 整批預設需求 ID，可空
  roles: Partial<Record<MeegleRoleKey, string[]>>           // 受托人／Code Review 的整批預設（人名）
}

export type RowPlan = {
  name: string
  description: string
  requirement: Requirement | null
  roles: Record<MeegleRoleKey, { aliases: string[]; people: MappedPerson[]; unmapped: string[] }>
  blocks: string[]    // 有任何一條 → 這列不送
  warnings: string[]  // 會送，但要讓人看到（例如人員未對照、角色會留空）
}

const str = (v: unknown) => (v == null ? '' : String(v))

export function planRow(input: RowInput, defaults: BatchDefaults, requirements: Requirement[], personMap: Record<string, MappedPerson>): RowPlan {
  const rec = input.record
  const blocks: string[] = []
  const warnings: string[] = []

  const name = (str(rec['摘要']).trim() || str(rec['標題']).trim()).replace(/[\r\n]+/g, ' ').trim()
  if (!name) blocks.push('沒有摘要／標題，無法當任務名稱')
  const description = str(rec['描述'])

  let requirement: Requirement | null = null
  const override = (input.requirementOverride ?? '').trim()
  const sheetReq = str(rec[SHEET_REQUIREMENT_COLUMN]).trim()
  if (override) {
    const m = pickRequirement(override, requirements)
    if ('reason' in m) blocks.push(`逐列指定的需求無效：${m.message}`)
    else requirement = m.requirement
  } else if (sheetReq) {
    const m = pickRequirement(sheetReq, requirements)
    if ('reason' in m) blocks.push(`Sheet「${SHEET_REQUIREMENT_COLUMN}」：${m.message}`)  // 不退回整批預設
    else requirement = m.requirement
  } else if (defaults.requirementId) {
    const m = pickRequirement(defaults.requirementId, requirements)
    if ('reason' in m) blocks.push(`整批預設需求已不存在：${m.message}`)
    else requirement = m.requirement
  } else {
    blocks.push('沒有關聯需求（請選整批預設，或在這列指定）')
  }

  const roles = {} as RowPlan['roles']
  for (const def of MEEGLE_ROLE_DEFS) {
    const rowOverride = input.roleOverrides?.[def.key]
    const aliases = rowOverride !== undefined
      ? rowOverride.map(s => s.trim()).filter(Boolean)
      : def.sheetColumn ? splitPeople(str(rec[def.sheetColumn])) : (defaults.roles[def.key] ?? []).map(s => s.trim()).filter(Boolean)
    const people: MappedPerson[] = []
    const unmapped: string[] = []
    for (const a of aliases) {
      const p = personMap[normAlias(a)]
      if (p) { if (!people.some(x => x.userKey === p.userKey)) people.push(p) }
      else unmapped.push(a)
    }
    if (unmapped.length) warnings.push(`${unmapped.join('、')} 未對照，${def.label}${people.length ? '只會帶入已對照的人' : '將留空'}`)
    roles[def.key] = { aliases, people, unmapped }
  }

  return { name, description, requirement, roles, blocks, warnings }
}

/** 一批裡所有出現過的人名（去重、保留第一次出現的寫法），給「人員對照」那塊用。 */
export function collectAliases(rows: RowInput[], defaults: BatchDefaults): string[] {
  const seen = new Map<string, string>()
  const add = (a: string) => { const k = normAlias(a); if (k && !seen.has(k)) seen.set(k, a.trim()) }
  for (const r of rows) {
    for (const def of MEEGLE_ROLE_DEFS) {
      const o = r.roleOverrides?.[def.key]
      if (o !== undefined) o.forEach(add)
      else if (def.sheetColumn) splitPeople(str(r.record[def.sheetColumn])).forEach(add)
    }
  }
  for (const list of Object.values(defaults.roles)) (list ?? []).forEach(add)
  return [...seen.values()]
}

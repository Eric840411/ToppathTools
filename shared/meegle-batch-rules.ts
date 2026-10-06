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

/**
 * 每個角色讀 Sheet 的哪一欄：依序找，**第一個存在的欄位**就用它（欄位存在但這列空白 → 這列這個角色沒人，不會跳去下一個欄名）。
 * 各份 Sheet 欄名不一樣（2026-10-01：一份叫「回報者／RD負責人」，另一份叫「填寫人／RD」），使用者決定由工具認常見欄名，不改 Sheet。
 */
export const MEEGLE_ROLE_DEFS = [
  { key: 'assignee', label: '受托人', sheetColumns: [] },
  { key: 'rdOwner', label: 'RD 負責人', sheetColumns: ['RD負責人', 'RD'] },
  { key: 'reporter', label: '回報者', sheetColumns: ['回報者', '回報人', '填寫人'] },
  { key: 'codeReview', label: 'Code Review', sheetColumns: [] },
  { key: 'qaVerifier', label: 'QA 驗證', sheetColumns: ['QA驗證人員'] },
] as const

/** 這份 Sheet 裡某個角色實際對到的欄名（標題去頭尾空白比對）；沒有就是 null。 */
export function roleColumn(def: typeof MEEGLE_ROLE_DEFS[number], record: Record<string, unknown>): string | null {
  const keys = Object.keys(record)
  for (const want of def.sheetColumns) {
    const hit = keys.find(k => k.trim() === want)
    if (hit !== undefined) return hit
  }
  return null
}
export type MeegleRoleKey = typeof MEEGLE_ROLE_DEFS[number]['key']

export const SHEET_REQUIREMENT_COLUMN = '關聯需求'
export const SHEET_TASK_TYPE_COLUMN = '任務類型'

/**
 * 這個空間「任務類型」欄位的現況（2026-10-06：兩個空間都改成建立必填，field_key 兩邊不同）。
 * 由伺服器每次讀 meta-create-fields／meta-fields 給，**不寫死**。null＝這個空間沒有這個欄位。
 */
export type TaskTypeMeta = { required: boolean; options: string[] }

/** 選項名稱比對（去頭尾空白、不分大小寫）。對到回選項的正式寫法，對不到回 null */
export function pickTaskType(text: string, options: string[]): string | null {
  const want = text.trim().toLowerCase()
  return options.find(o => o.trim().toLowerCase() === want) ?? null
}

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
  taskTypeOverride?: string                                 // 畫面上逐列覆寫（任務類型選項名稱）
}

export type BatchDefaults = {
  requirementId: string                                     // 整批預設需求 ID，可空
  roles: Partial<Record<MeegleRoleKey, string[]>>           // 受托人／Code Review 的整批預設（人名）
  taskType?: string                                         // 整批預設任務類型（選項名稱），可空
}

export type RowPlan = {
  name: string
  description: string
  requirement: Requirement | null
  taskType: string | null   // 選項名稱（正式寫法）；null＝不帶
  roles: Record<MeegleRoleKey, { aliases: string[]; people: MappedPerson[]; unmapped: string[] }>
  blocks: string[]    // 有任何一條 → 這列不送
  warnings: string[]  // 會送，但要讓人看到（例如人員未對照、角色會留空）
}

const str = (v: unknown) => (v == null ? '' : String(v))

/**
 * Sheet 中間又出現一次標題列（實測：分段的表每段開頭重複一列「日期／填寫人／摘要／RD…」）。
 * 不擋的話會開出一張叫「摘要」的單，人員欄的「填寫人」「RD」也會被當成人名。
 * 判斷：至少 2 格的值剛好等於自己的欄名。
 */
export function isRepeatedHeaderRow(rec: Record<string, unknown>): boolean {
  let hits = 0, nonEmpty = 0
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith('_') || !k.trim()) continue
    const val = str(v).trim()
    if (!val) continue
    nonEmpty++
    if (val === k.trim()) hits++
  }
  if (hits < 2) return false
  // 任務名稱那格也是欄名 → 一定是標題列（不然會開出一張叫「摘要」的單）
  if (str(rec['摘要']).trim() === '摘要' || str(rec['標題']).trim() === '標題') return true
  // 否則要「過半」才算：部門欄填「RD」「QA」這種剛好等於欄名的值很常見，只憑兩格就擋會誤殺真資料（CodeX review 0c30dde [P2]）
  return hits * 2 > nonEmpty
}

function sheetPeople(def: typeof MEEGLE_ROLE_DEFS[number], rec: Record<string, unknown>): string[] {
  const col = roleColumn(def, rec)
  return col ? splitPeople(str(rec[col])) : []
}

/**
 * 任務類型（2026-10-06，CodeX 定案）：逐列覆寫 → Sheet「任務類型」欄 → 整批預設。
 * **有填但不是選項就擋，不退回預設**（跟關聯需求同一條理由）。
 * meta＝null：這個空間沒有這個欄位 → 不帶；Sheet 有填就警告一聲（不擋）。
 * meta.required＝false：沒填可以送；有填照樣要是合法選項。
 */
export function planTaskType(input: RowInput, defaults: BatchDefaults, meta: TaskTypeMeta | null): { taskType: string | null; block?: string; warning?: string } {
  const override = (input.taskTypeOverride ?? '').trim()
  const sheet = str(input.record[SHEET_TASK_TYPE_COLUMN]).trim()
  const def = (defaults.taskType ?? '').trim()
  if (!meta) return { taskType: null, ...(override || sheet ? { warning: `這個 Meegle 空間沒有「任務類型」欄位，填的「${override || sheet}」不會帶入` } : {}) }
  const [raw, from] = override ? [override, '逐列指定的任務類型'] : sheet ? [sheet, `Sheet「${SHEET_TASK_TYPE_COLUMN}」`] : def ? [def, '整批預設任務類型'] : ['', '']
  if (!raw) return meta.required ? { taskType: null, block: '沒有任務類型（Meegle 必填；請選整批預設，或在這列／Sheet 指定）' } : { taskType: null }
  const hit = pickTaskType(raw, meta.options)
  if (!hit) return { taskType: null, block: `${from}「${raw}」不是 Meegle 的選項（可選：${meta.options.join('、') || '無'}）` }
  return { taskType: hit }
}

export function planRow(input: RowInput, defaults: BatchDefaults, requirements: Requirement[], personMap: Record<string, MappedPerson>, taskTypeMeta: TaskTypeMeta | null = null): RowPlan {
  const rec = input.record
  const blocks: string[] = []
  const warnings: string[] = []

  const name = (str(rec['摘要']).trim() || str(rec['標題']).trim()).replace(/[\r\n]+/g, ' ').trim()
  if (isRepeatedHeaderRow(rec)) blocks.push('這列是重複的標題列，不是資料')
  else if (!name) blocks.push('沒有摘要／標題，無法當任務名稱')
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

  const tt = planTaskType(input, defaults, taskTypeMeta)
  if (tt.block) blocks.push(tt.block)
  if (tt.warning) warnings.push(tt.warning)

  const roles = {} as RowPlan['roles']
  for (const def of MEEGLE_ROLE_DEFS) {
    const rowOverride = input.roleOverrides?.[def.key]
    const aliases = rowOverride !== undefined
      ? rowOverride.map(s => s.trim()).filter(Boolean)
      : def.sheetColumns.length ? sheetPeople(def, rec) : (defaults.roles[def.key] ?? []).map(s => s.trim()).filter(Boolean)
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

  return { name, description, requirement, taskType: tt.taskType, roles, blocks, warnings }
}

/** 一批裡所有出現過的人名（去重、保留第一次出現的寫法），給「人員對照」那塊用。 */
export function collectAliases(rows: RowInput[], defaults: BatchDefaults): string[] {
  const seen = new Map<string, string>()
  const add = (a: string) => { const k = normAlias(a); if (k && !seen.has(k)) seen.set(k, a.trim()) }
  for (const r of rows) {
    if (isRepeatedHeaderRow(r.record)) continue
    for (const def of MEEGLE_ROLE_DEFS) {
      const o = r.roleOverrides?.[def.key]
      if (o !== undefined) o.forEach(add)
      else if (def.sheetColumns.length) sheetPeople(def, r.record).forEach(add)
    }
  }
  for (const list of Object.values(defaults.roles)) (list ?? []).forEach(add)
  return [...seen.values()]
}

export type PreviousRowLike = { createPhase: string; statePhase: string; targetStateKey?: string | null; workItemId?: string | null }

/**
 * 讀 Sheet 時，哪些歷史列要接回「送出結果」區、保留原批次與原目標狀態（前端用；跟 needsStatePush 同一個判斷）：
 * - 開單中／待確認 → 要能「查詢結果」（CodeX review 999f895 [P1]）
 * - 已開單、有目標狀態、但狀態還沒推成功 → 要能「重推狀態」。只恢復待確認的話，推狀態前中斷或推失敗的列
 *   重整後只剩「已開過」、沒有任何補推入口（CodeX review df9b538 [P2]）
 */
export function isRestorablePrevious(p: PreviousRowLike): boolean {
  if (p.createPhase === 'creating' || p.createPhase === 'unknown') return true
  return p.createPhase === 'created' && !!p.workItemId && !!p.targetStateKey && p.statePhase !== 'done'
}

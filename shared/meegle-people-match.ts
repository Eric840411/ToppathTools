/**
 * Meegle 批量開單 ② 人員對照：用 Sheet 上的名字在空間名單裡猜人。純函式，後端算建議、測試直接打這裡。
 *
 * 只是「建議」——寫入對照一定要使用者確認後走 verify（email 完全相同）。
 * 一層一層比，某一層有命中就停，不把不同層的結果混在一起：
 *   exact    完整名字＝Meegle 顯示名稱（不分大小寫、空白壓成一個）
 *   partial  第一個詞＝顯示名稱（Sheet「Tim Chen」→ Meegle「Tim」），或名字＝email 前綴（「eric.wu」）
 * partial 可能是別人，前端不能放進「全部確認」。
 */

/** email 為空字串＝Meegle 沒給 email：不能選（verify 要 email），但同名時要算進人數。 */
export type RosterPerson = { userKey: string; email: string; name: string; names: string[] }

export type RosterMatch =
  | { status: 'unique'; confidence: 'exact' | 'partial'; user: RosterPerson }
  | { status: 'ambiguous'; confidence: 'exact' | 'partial'; users: RosterPerson[] }
  | { status: 'none' }

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

export function matchRoster(alias: string, roster: RosterPerson[]): RosterMatch {
  const full = norm(alias)
  if (!full) return { status: 'none' }
  const first = full.split(' ')[0]
  const local = (u: RosterPerson) => u.email ? u.email.split('@')[0].toLowerCase() : ''
  const levels: Array<{ confidence: 'exact' | 'partial'; test: (u: RosterPerson) => boolean }> = [
    { confidence: 'exact', test: u => u.names.some(n => norm(n) === full) },
    { confidence: 'partial', test: u => (first !== full && u.names.some(n => norm(n) === first)) || local(u) === full || local(u) === full.replace(/ /g, '.') },
  ]
  for (const { confidence, test } of levels) {
    const hits = [...new Map(roster.filter(test).map(u => [u.userKey, u])).values()]
    // 唯一但沒 email → 不能預填，當成要人工處理（ambiguous 裡沒有可選的人，前端照舊手打）
    if (hits.length === 1 && hits[0].email) return { status: 'unique', confidence, user: hits[0] }
    if (hits.length) return { status: 'ambiguous', confidence, users: hits }
  }
  return { status: 'none' }
}

/** 下拉選人的搜尋：名字或 email 含關鍵字（不分大小寫）。 */
export function filterRoster(query: string, roster: RosterPerson[]): RosterPerson[] {
  const q = norm(query)
  if (!q) return roster
  return roster.filter(u => u.email.toLowerCase().includes(q) || u.names.some(n => norm(n).includes(q)))
}

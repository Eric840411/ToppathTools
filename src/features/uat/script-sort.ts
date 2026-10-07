/**
 * 後台錄製腳本「全部」的排序（1007 使用者確認）：
 *   ① 名稱開頭有編號（字母前綴＋數字，例 T-007、T-A-001）→ 前綴 A～Z、再依數字大小
 *   ② 沒有編號的純文字（例「範本：…」）→ 接在後面
 *   ③ 純數字開頭（例「12」）→ 排最後
 * 同一組裡依名稱（數字依大小比）、再依 id 定序，順序穩定（CodeX）。
 */
const CODE = /^([A-Za-z]+(?:-[A-Za-z]+)*)-?(\d+)/
export function scriptSortKey(title: string): { group: 0 | 1 | 2; prefix: string; num: number } {
  const t = title.trim()
  const m = t.match(CODE)
  if (m) return { group: 0, prefix: m[1].toUpperCase(), num: Number(m[2]) }
  return { group: /^\d/.test(t) ? 2 : 1, prefix: '', num: 0 }
}
export function compareScripts(a: { title: string; id?: string }, b: { title: string; id?: string }): number {
  const ka = scriptSortKey(a.title), kb = scriptSortKey(b.title)
  if (ka.group !== kb.group) return ka.group - kb.group
  if (ka.group === 0) {
    const p = ka.prefix.localeCompare(kb.prefix, 'en')
    if (p) return p
    if (ka.num !== kb.num) return ka.num - kb.num
  }
  const t = a.title.localeCompare(b.title, 'zh-Hant', { numeric: true })
  if (t) return t
  return (a.id ?? '').localeCompare(b.id ?? '')
}
export const sortScriptsByNumber = <T extends { title: string; id?: string }>(xs: T[]): T[] => [...xs].sort(compareScripts)

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

/**
 * 上次執行的一句話（1007）。⚠️ 只有**每一筆都確實 pass** 才顯示通過（CodeX a26744e [P2]：未驗被顯示成「上次通過 0/1」）。
 * 順序：停止 → 失敗 → 受阻 → 未驗（含沒有結果）→ 通過
 */
export type LastRun = { at: number; pass: number; fail: number; blocked: number; unverified?: number; total: number; dryRun: boolean; stopped: boolean }
export function lastRunText(r: LastRun | null | undefined): { text: string; cls: '' | 'is-ok' | 'is-bad' | 'is-warn' } {
  if (!r) return { text: '尚未執行', cls: '' }
  const when = new Date(r.at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  if (r.stopped) return { text: `上次已停止 ${when}`, cls: 'is-warn' }
  if (r.fail) return { text: `上次失敗 ${r.fail}/${r.total} ${when}`, cls: 'is-bad' }
  if (r.blocked) return { text: `上次受阻 ${r.blocked}/${r.total} ${when}`, cls: 'is-warn' }
  if (r.total === 0 || r.pass !== r.total) return { text: `上次未驗 ${r.total - r.pass}/${r.total} ${when}`, cls: 'is-warn' }
  return { text: `上次${r.dryRun ? '試跑' : ''}通過 ${r.pass}/${r.total} ${when}`, cls: 'is-ok' }
}

/**
 * 清單要顯示哪幾列＋每列的標籤（純函式，給畫面與測試共用）。
 * 「別人的」看**登入帳號**，不從清單猜（CodeX a26744e [P2]：取清單第一個建立者，加入 Bob 的之後會把 Alice 自己的標成別人的）
 */
export function buildScriptRows<T extends { id?: string; title: string; createdBy?: string }>(p: { scripts: T[]; mineIds: string[]; me: string; tab: 'all' | 'mine'; match: (s: T) => boolean }) {
  const byId = new Map(p.scripts.flatMap(s => s.id ? [[s.id, s] as const] : []))
  const inMine = new Set(p.mineIds)
  const base = p.tab === 'all' ? sortScriptsByNumber(p.scripts) : p.mineIds.flatMap(id => { const s = byId.get(id); return s ? [s] : [] })
  return base.filter(p.match).map(s => ({
    script: s,
    inMine: !!s.id && inMine.has(s.id),
    others: p.tab === 'mine' && !!p.me && !!s.createdBy && s.createdBy !== p.me,
  }))
}

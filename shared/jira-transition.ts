/**
 * Jira 狀態切換：用「目標狀態」決定每張單自己的 transition——前後端共用這一份規則。
 *
 * 為什麼（2026-10-01 實際出事）：批量更新狀態原本拿**清單第一張單**的 transitionId 套到每一張。
 * 但 transition ID 是 workflow 專屬的——CGFB 的 `4` 是「本機測試完成」，P5MA 的 `4` 卻是「Done」。
 * 清單第一張是 CGFB-98，於是 P5MA-9675～9684 十張單被切到「完成」，而且沒有任何錯誤。
 *
 * 規則（跟 CodeX 討論定案）：
 * - 只用同一個 Jira 站台的**目標狀態 ID（to.id）**比對；名稱只拿來顯示，**不做名稱比對、也不用名稱 fallback**——
 *   狀態可能有專案 scope，同名不保證同 ID；transition 名稱更是各 workflow 自己取（P5MA「本機環境」→可本機測試，
 *   CGFB「可本機測試」→可本機測試）
 * - 對不到 → 這張不送（回報「這張單目前不能切到 X」）
 * - 同一個目標有多條 transition → 也不送：不同路徑可能有不同的 post-function／畫面欄位，不能隨便挑第一條
 */

export type JiraTransitionLike = { id: string; name: string; to?: { id?: string; name?: string } }

export type PickResult =
  | { ok: true; transitionId: string; transitionName: string }
  | { ok: false; code: 'NO_PATH' | 'AMBIGUOUS'; message: string }

export function pickTransitionForTarget(transitions: JiraTransitionLike[], toStatusId: string, toStatusName = toStatusId): PickResult {
  const matches = transitions.filter(t => t.to?.id === toStatusId)
  if (matches.length === 0) {
    return { ok: false, code: 'NO_PATH', message: `這張單目前不能切到「${toStatusName}」（它現在的狀態沒有通往那裡的路徑）` }
  }
  if (matches.length > 1) {
    return {
      ok: false, code: 'AMBIGUOUS',
      message: `有 ${matches.length} 條路徑都能切到「${toStatusName}」（${matches.map(m => m.name).join('、')}），為避免走錯路徑先不送，請到 Jira 手動切換`,
    }
  }
  return { ok: true, transitionId: matches[0].id, transitionName: matches[0].name }
}

export type TargetStatusOption = { toId: string; toName: string }

/** 下拉選單用：以目標狀態去重（同一個目標的多條 transition 只列一次） */
export function targetStatusOptions(transitions: JiraTransitionLike[]): TargetStatusOption[] {
  const seen = new Map<string, TargetStatusOption>()
  for (const t of transitions) {
    const toId = t.to?.id
    if (!toId || seen.has(toId)) continue
    seen.set(toId, { toId, toName: t.to?.name ?? t.name })
  }
  return [...seen.values()]
}

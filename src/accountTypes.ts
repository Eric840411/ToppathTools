/** 登入帳號（原本寫在 components/JiraAccountModal.tsx；Jira 停用、那個彈窗刪掉後搬到這裡，2026-10-02） */
export interface AccountInfo {
  email: string
  label: string
  role: string   // 'qa' | 'pm' | 'pm,qa' (comma-separated, sorted)
  hasPIN?: boolean
  /** 角色的顯示名稱（後端算：自建角色顯示名稱，內建維持 QA／PM 等代號）。舊後端沒有這欄 */
  roleLabel?: string
}

/** 判斷帳號是否有某個 mode 的權限 */
export function accountHasRole(acc: AccountInfo | null, r: 'qa' | 'pm'): boolean {
  if (!acc) return true   // 未登入時不限制
  return acc.role.split(',').includes(r)
}

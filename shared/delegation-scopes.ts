/**
 * 代理授權的用途（scope）。前端授權頁的選項／表格標籤、後端 zod 白名單、型別都從這裡來——
 * 原本三處各寫一份字串，加一種用途就要改三個地方，漏一處就是「開得出授權但後端不收」或「表格顯示錯用途」。
 *
 * ⚠️ 每種用途是**獨立權限**：同一張表（jira_account_delegates）只是共用存放與有效判斷，
 * 不會互相繼承。meegle.comment.batch 不因為有 jira.comment.batch 就生效（使用者 2026-10-02：新開，不共用；CodeX 同意）。
 */
export const DELEGATION_SCOPES = [
  { key: 'jira.comment.batch', label: '批量評論（用他的身分張貼）', short: '批量評論' },
  { key: 'jira.read.asOther', label: '跨帳號讀取（週報撈單用）', short: '跨帳號讀取' },
  { key: 'meegle.comment.batch', label: 'Meegle 批量評論（用他的身分：覆寫測試說明＋上傳附件＋評論）', short: 'Meegle 批量評論' },
] as const

export type DelegationScope = typeof DELEGATION_SCOPES[number]['key']
export const DELEGATION_SCOPE_KEYS = DELEGATION_SCOPES.map(s => s.key) as [DelegationScope, ...DelegationScope[]]

export function delegationScopeShort(scope: string): string {
  return DELEGATION_SCOPES.find(s => s.key === scope)?.short ?? scope
}

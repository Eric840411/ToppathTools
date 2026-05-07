import type { AccountInfo } from './components/JiraAccountModal'

export const GLOBAL_ACCOUNT_KEY = 'global_jira_account'

export function loadGlobalAccount(): AccountInfo | null {
  try {
    return JSON.parse(sessionStorage.getItem(GLOBAL_ACCOUNT_KEY) ?? 'null') as AccountInfo | null
  } catch {
    return null
  }
}

export function saveGlobalAccount(account: AccountInfo | null) {
  if (account) sessionStorage.setItem(GLOBAL_ACCOUNT_KEY, JSON.stringify(account))
  else sessionStorage.removeItem(GLOBAL_ACCOUNT_KEY)
}

export async function fetchAuthAccount(): Promise<AccountInfo | null> {
  const resp = await fetch('/api/auth/me')
  const data = await resp.json() as { ok?: boolean; authenticated?: boolean; account?: AccountInfo | null }
  return data.ok && data.authenticated && data.account ? data.account : null
}

export async function logoutAuthAccount() {
  await fetch('/api/auth/logout', { method: 'POST' })
  saveGlobalAccount(null)
}

import { useEffect, useRef, useState } from 'react'
import Portal from './Portal'
import { useIsGameMode } from './GameModeContext'
import type { AccountInfo } from './JiraAccountModal'

const LAST_LOGIN_EMAIL_KEY = 'toppath_last_login_email'

interface Props {
  onLogin: (account: AccountInfo) => void
}

interface AccountsResponse {
  ok: boolean
  accounts?: AccountInfo[]
}

interface LoginResponse {
  ok: boolean
  account?: AccountInfo
  message?: string
}

interface AddAccountResponse {
  ok: boolean
  message?: string
}

function readLastLoginEmail(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(LAST_LOGIN_EMAIL_KEY)
  } catch {
    return null
  }
}

function saveLastLoginEmail(email: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LAST_LOGIN_EMAIL_KEY, email)
  } catch {
    // Ignore storage failures so a successful login is not blocked.
  }
}

function isSameEmail(left: string | null, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase()
}

export function AuthLoginModal({ onLogin }: Props) {
  const isGame = useIsGameMode()
  const [view, setView] = useState<'login' | 'add'>('login')
  const [accounts, setAccounts] = useState<AccountInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<AccountInfo | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loginLoadingEmail, setLoginLoadingEmail] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [newToken, setNewToken] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newPin, setNewPin] = useState('')
  const [newRole, setNewRole] = useState<'qa' | 'pm'>('qa')
  const [addLoading, setAddLoading] = useState(false)
  const [addSuccess, setAddSuccess] = useState('')
  const [lastLoginEmail, setLastLoginEmail] = useState<string | null>(() => readLastLoginEmail())
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const pinRef = useRef<HTMLInputElement>(null)

  const PAGE_SIZE = 5

  async function fetchAccounts(cancelled = false) {
    setLoading(true)
    fetch('/api/jira/accounts')
      .then(resp => resp.json() as Promise<AccountsResponse>)
      .then(data => {
        if (!cancelled && data.ok) setAccounts(data.accounts ?? [])
      })
      .catch(() => {
        if (!cancelled) setError('帳號清單讀取失敗')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
  }

  useEffect(() => {
    let cancelled = false
    void fetchAccounts(cancelled)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (target) setTimeout(() => pinRef.current?.focus(), 50)
  }, [target])

  async function login(account: AccountInfo, accountPin?: string) {
    setLoginLoadingEmail(account.email)
    setError('')
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: account.email, pin: accountPin }),
      })
      const data = await (resp.json() as Promise<LoginResponse>)
      if (!data.ok || !data.account) {
        setError(data.message ?? '登入失敗')
        return
      }
      saveLastLoginEmail(data.account.email)
      setLastLoginEmail(data.account.email)
      onLogin(data.account)
    } catch {
      setError('登入失敗')
    } finally {
      setLoginLoadingEmail(null)
    }
  }

  function handleAccountClick(account: AccountInfo) {
    if (account.hasPIN) {
      setTarget(account)
      setPin('')
      setError('')
      return
    }
    void login(account)
  }

  async function handleAddAccount() {
    if (!newEmail.trim() || !newToken.trim() || !newLabel.trim() || !newPin.trim()) return
    setAddLoading(true)
    setError('')
    setAddSuccess('')
    try {
      const resp = await fetch('/api/jira/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          token: newToken.trim(),
          label: newLabel.trim(),
          role: newRole,
          pin: newPin.trim(),
        }),
      })
      const data = await (resp.json() as Promise<AddAccountResponse>)
      if (!data.ok) {
        setError(data.message ?? '新增帳號失敗')
        return
      }
      setAddSuccess('帳號已新增，請回登入清單選擇帳號。')
      setNewEmail('')
      setNewToken('')
      setNewLabel('')
      setNewPin('')
      setNewRole('qa')
      await fetchAccounts()
      setView('login')
    } catch {
      setError('新增帳號失敗')
    } finally {
      setAddLoading(false)
    }
  }

  const normalizedFilter = filter.trim().toLowerCase()
  const filteredAccounts = normalizedFilter
    ? accounts.filter(account =>
        account.label.toLowerCase().includes(normalizedFilter) ||
        account.email.toLowerCase().includes(normalizedFilter),
      )
    : accounts

  function handleFilterChange(value: string) {
    setFilter(value)
    setPage(0)
  }

  return (
    <Portal>
      <div className="modal-overlay auth-login-overlay">
        <div className="modal auth-login-modal" onClick={event => event.stopPropagation()}>
          <div className="modal-header auth-login-header">
            <h2>ToppathTools Login</h2>
          </div>

          {!target && view === 'login' && (
            <div className="modal-body">
              <div className="auth-login-lock">🔐</div>
              <p className="auth-login-copy">選擇你的 Jira 帳號登入後才能使用系統。</p>
              <div className="auth-login-tabs">
                <button type="button" className="auth-login-tab active">登入</button>
                <button type="button" className="auth-login-tab" onClick={() => { setView('add'); setError(''); setAddSuccess('') }}>新增帳號</button>
              </div>
              {error && <p className="auth-login-error">{error}</p>}
              {addSuccess && <p className="auth-login-success">{addSuccess}</p>}
              {loading && <p className="idle-hint">Loading accounts...</p>}
              {!loading && accounts.length === 0 && <div className="alert-warn">尚未建立 Jira 帳號，請先由管理員新增帳號。</div>}
              <input
                type="search"
                value={filter}
                onChange={event => handleFilterChange(event.target.value)}
                placeholder="搜尋帳號..."
                aria-label="搜尋帳號"
                className="auth-login-search"
              />
              <div className="auth-login-list">
                {(() => {
                  const lastLoginAccount = filteredAccounts.find(a => isSameEmail(lastLoginEmail, a.email))
                  const otherAccounts = filteredAccounts.filter(a => !isSameEmail(lastLoginEmail, a.email))
                  const totalPages = Math.ceil(otherAccounts.length / PAGE_SIZE)
                  const safePage = Math.min(page, Math.max(0, totalPages - 1))
                  const pagedOthers = otherAccounts.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

                  const renderAccount = (account: AccountInfo) => (
                    <button
                      key={account.email}
                      type="button"
                      className="auth-login-account"
                      disabled={loginLoadingEmail === account.email}
                      onClick={() => handleAccountClick(account)}
                    >
                      <span className="auth-login-account-main">
                        <strong>{account.label}</strong>
                        <span>{account.email}</span>
                      </span>
                      <span className="auth-login-account-meta">
                        {isSameEmail(lastLoginEmail, account.email) && <span className="auth-login-last-badge" title="Last used">上次</span>}
                        <span>{account.role.toUpperCase()}</span>
                        {account.hasPIN ? <span title="PIN protected">🔒</span> : <span title="No PIN">⚠</span>}
                        {loginLoadingEmail === account.email && <span>...</span>}
                      </span>
                    </button>
                  )

                  return (
                    <>
                      {lastLoginAccount && renderAccount(lastLoginAccount)}
                      {lastLoginAccount && pagedOthers.length > 0 && (
                        <div className="auth-login-divider" />
                      )}
                      {pagedOthers.map(renderAccount)}
                      {totalPages > 1 && (
                        <div className="auth-login-pagination">
                          <button
                            type="button"
                            className="auth-login-page-btn"
                            disabled={safePage === 0}
                            onClick={() => setPage(safePage - 1)}
                          >‹</button>
                          <span className="auth-login-page-info">{safePage + 1} / {totalPages}</span>
                          <button
                            type="button"
                            className="auth-login-page-btn"
                            disabled={safePage >= totalPages - 1}
                            onClick={() => setPage(safePage + 1)}
                          >›</button>
                        </div>
                      )}
                    </>
                  )
                })()}
                {!loading && filteredAccounts.length === 0 && accounts.length > 0 && (
                  <p className="auth-login-empty">找不到符合的帳號</p>
                )}
              </div>
            </div>
          )}

          {!target && view === 'add' && (
            <div className="modal-body">
              <div className="auth-login-lock">＋</div>
              <p className="auth-login-copy">填入你的 Jira 帳號資訊並設定登入 PIN 密碼。</p>
              <div className="auth-login-tabs">
                <button type="button" className="auth-login-tab" onClick={() => { setView('login'); setError('') }}>登入</button>
                <button type="button" className="auth-login-tab active">新增帳號</button>
              </div>
              <div className="auth-login-form">
                <input value={newLabel} onChange={event => setNewLabel(event.target.value)} placeholder="顯示名稱，例如 Eric Wu" />
                <input type="email" value={newEmail} onChange={event => setNewEmail(event.target.value)} placeholder="Jira Email" />
                <input type="password" value={newToken} onChange={event => setNewToken(event.target.value)} placeholder="Jira API Token" />
                <a
                  className="auth-login-token-help"
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  前往 Atlassian 帳號設定產生 API Token
                </a>
                <input type="password" value={newPin} onChange={event => setNewPin(event.target.value)} placeholder="設定 PIN 密碼（登入時使用）" />
                <div className="auth-login-role-row">
                  <button type="button" className={newRole === 'qa' ? 'active' : ''} onClick={() => setNewRole('qa')}>QA</button>
                  <button type="button" className={newRole === 'pm' ? 'active' : ''} onClick={() => setNewRole('pm')}>PM</button>
                </div>
              </div>
              {error && <p className="auth-login-error">{error}</p>}
              <div className="auth-login-actions">
                <button
                  type="button"
                  className="auth-login-primary"
                  disabled={addLoading || !newEmail.trim() || !newToken.trim() || !newLabel.trim() || !newPin.trim()}
                  onClick={() => void handleAddAccount()}
                >
                  {addLoading ? '新增中...' : '新增帳號'}
                </button>
                <button type="button" className="auth-login-secondary" onClick={() => { setView('login'); setError('') }}>
                  {isGame ? 'BACK' : '返回'}
                </button>
              </div>
            </div>
          )}

          {target && (
            <div className="modal-body">
              <div className="auth-login-lock">🔐</div>
              <p className="auth-login-copy">
                {target.label} 需要 PIN 驗證
              </p>
              <div className="auth-login-pin-wrap">
                <input
                  ref={pinRef}
                  type="password"
                  value={pin}
                  onChange={event => setPin(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && pin.trim()) void login(target, pin) }}
                  placeholder="Enter PIN"
                  className="auth-login-pin"
                />
              </div>
              {error && <p className="auth-login-error">{error}</p>}
              <div className="auth-login-actions">
                <button type="button" className="auth-login-primary" disabled={!pin.trim() || loginLoadingEmail === target.email} onClick={() => void login(target, pin)}>
                  {loginLoadingEmail === target.email ? '登入中...' : '登入'}
                </button>
                <button type="button" className="auth-login-secondary" onClick={() => { setTarget(null); setPin(''); setError('') }}>
                  {isGame ? 'BACK' : '返回'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Portal>
  )
}

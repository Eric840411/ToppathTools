import { useEffect, useRef, useState } from 'react'
import Portal from './Portal'
import { useIsGameMode } from './GameModeContext'
import type { AccountInfo } from './JiraAccountModal'

interface Props {
  onLogin: (account: AccountInfo) => void
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
  const [adminPin, setAdminPin] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newToken, setNewToken] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newRole, setNewRole] = useState<'qa' | 'pm'>('qa')
  const [addLoading, setAddLoading] = useState(false)
  const [addSuccess, setAddSuccess] = useState('')
  const pinRef = useRef<HTMLInputElement>(null)

  async function fetchAccounts(cancelled = false) {
    setLoading(true)
    fetch('/api/jira/accounts')
      .then(resp => resp.json())
      .then(data => {
        if (!cancelled && data.ok) setAccounts(data.accounts)
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
      const data = await resp.json()
      if (!data.ok || !data.account) {
        setError(data.message ?? '登入失敗')
        return
      }
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
    if (!adminPin.trim() || !newEmail.trim() || !newToken.trim() || !newLabel.trim()) return
    setAddLoading(true)
    setError('')
    setAddSuccess('')
    try {
      const adminResp = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: adminPin }),
      })
      const adminData = await adminResp.json()
      if (!adminData.ok) {
        setError(adminData.message ?? '管理員 PIN 錯誤')
        return
      }

      const resp = await fetch('/api/jira/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          token: newToken.trim(),
          label: newLabel.trim(),
          role: newRole,
        }),
      })
      const data = await resp.json()
      if (!data.ok) {
        setError(data.message ?? '新增帳號失敗')
        return
      }
      setAddSuccess('帳號已新增，請回登入清單選擇帳號。')
      setNewEmail('')
      setNewToken('')
      setNewLabel('')
      setNewRole('qa')
      await fetchAccounts()
      setView('login')
    } catch {
      setError('新增帳號失敗')
    } finally {
      setAddLoading(false)
    }
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
              <div className="auth-login-list">
                {accounts.map(account => (
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
                      <span>{account.role.toUpperCase()}</span>
                      {account.hasPIN ? <span title="PIN protected">🔒</span> : <span title="No PIN">⚠</span>}
                      {loginLoadingEmail === account.email && <span>...</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!target && view === 'add' && (
            <div className="modal-body">
              <div className="auth-login-lock">＋</div>
              <p className="auth-login-copy">新增 Jira 帳號需要管理員 PIN。</p>
              <div className="auth-login-tabs">
                <button type="button" className="auth-login-tab" onClick={() => { setView('login'); setError('') }}>登入</button>
                <button type="button" className="auth-login-tab active">新增帳號</button>
              </div>
              <div className="auth-login-form">
                <input type="password" value={adminPin} onChange={event => setAdminPin(event.target.value)} placeholder="Admin PIN" />
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
                  disabled={addLoading || !adminPin.trim() || !newEmail.trim() || !newToken.trim() || !newLabel.trim()}
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

import { useEffect, useRef, useState } from 'react'
import Portal from './Portal'
import { DungeonIcon } from './DungeonIcon'
import { useIsGameMode } from './GameModeContext'

export interface AccountInfo {
  email: string
  label: string
  role: string   // 'qa' | 'pm' | 'pm,qa' (comma-separated, sorted)
  hasPIN?: boolean
}

/** 判斷帳號是否有某個 mode 的權限 */
export function accountHasRole(acc: AccountInfo | null, r: 'qa' | 'pm'): boolean {
  if (!acc) return true   // 未登入時不限制
  return acc.role.split(',').includes(r)
}

type ModalTab = 'select' | 'add'

const ADMIN_SESSION_KEY = 'jira_admin_pin'

interface Props {
  currentEmail: string
  onClose: () => void
  onSelect: (account: AccountInfo) => void
  onClearCurrent: () => void
}

export function JiraAccountModal({ currentEmail, onClose, onSelect, onClearCurrent }: Props) {
  const isGame = useIsGameMode()
  const [tab, setTab] = useState<ModalTab>('select')
  const [accounts, setAccounts] = useState<AccountInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null)

  // 新增帳號 - role 改為多選
  const [newEmail, setNewEmail] = useState('')
  const [newToken, setNewToken] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newRole, setNewRole] = useState<'qa' | 'pm'>('qa')
  const [addError, setAddError] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addSuccess, setAddSuccess] = useState(false)

  // 管理員驗證
  const [isAdmin, setIsAdmin] = useState(() => !!sessionStorage.getItem(ADMIN_SESSION_KEY))
  const [showAdminPinInput, setShowAdminPinInput] = useState(false)
  const [adminPinValue, setAdminPinValue] = useState('')
  const [adminPinError, setAdminPinError] = useState('')
  const [adminPinLoading, setAdminPinLoading] = useState(false)
  const adminPinRef = useRef<HTMLInputElement>(null)

  // 管理員：內聯修改角色
  const [roleEditTarget, setRoleEditTarget] = useState<string | null>(null)
  const [roleEditValues, setRoleEditValues] = useState<Set<'qa' | 'pm'>>(new Set())
  const [roleEditLoading, setRoleEditLoading] = useState(false)
  const [roleEditError, setRoleEditError] = useState('')

  useEffect(() => {
    if (showAdminPinInput) setTimeout(() => adminPinRef.current?.focus(), 50)
  }, [showAdminPinInput])

  const handleVerifyAdminPin = async () => {
    if (!adminPinValue.trim()) return
    setAdminPinLoading(true); setAdminPinError('')
    try {
      const r = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: adminPinValue }),
      })
      const d = await r.json()
      if (d.ok) {
        setIsAdmin(true)
        sessionStorage.setItem(ADMIN_SESSION_KEY, adminPinValue)
        setShowAdminPinInput(false); setAdminPinValue('')
      } else {
        setAdminPinError(d.message ?? 'PIN 錯誤')
      }
    } catch { setAdminPinError('網路錯誤') }
    finally { setAdminPinLoading(false) }
  }

  const handleExitAdmin = () => {
    setIsAdmin(false)
    sessionStorage.removeItem(ADMIN_SESSION_KEY)
    setRoleEditTarget(null)
  }

  // ── 帳號 PIN 設定 ────────────────────────────────────────────────────────────
  const [pinTarget, setPinTarget] = useState<string | null>(null)
  const [pinOld, setPinOld] = useState('')
  const [pinNew, setPinNew] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinSetError, setPinSetError] = useState('')
  const [pinSetLoading, setPinSetLoading] = useState(false)

  const openPinSetup = (email: string) => {
    setPinTarget(email); setPinOld(''); setPinNew(''); setPinConfirm(''); setPinSetError('')
  }
  const closePinSetup = () => { setPinTarget(null) }

  const handleSetPin = async () => {
    if (pinNew !== pinConfirm) { setPinSetError('兩次 PIN 不一致'); return }
    setPinSetLoading(true); setPinSetError('')
    try {
      const r = await fetch(`/api/jira/accounts/${encodeURIComponent(pinTarget!)}/set-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPin: pinOld || undefined, newPin: pinNew || undefined }),
      })
      const d = await r.json()
      if (!d.ok) { setPinSetError(d.message ?? '設定失敗') }
      else { closePinSetup(); await fetchAccounts() }
    } catch { setPinSetError('網路錯誤') }
    finally { setPinSetLoading(false) }
  }

  // ── 帳號使用前 PIN 驗證 ──────────────────────────────────────────────────────
  const [verifyTarget, setVerifyTarget] = useState<AccountInfo | null>(null)
  const [verifyPin, setVerifyPin] = useState('')
  const [verifyError, setVerifyError] = useState('')
  const [verifyLoading, setVerifyLoading] = useState(false)
  const verifyPinRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (verifyTarget) setTimeout(() => verifyPinRef.current?.focus(), 50)
  }, [verifyTarget])

  const handleVerifyAccountPin = async () => {
    if (!verifyTarget) return
    setVerifyLoading(true); setVerifyError('')
    try {
      const r = await fetch(`/api/jira/accounts/${encodeURIComponent(verifyTarget.email)}/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: verifyPin }),
      })
      const d = await r.json()
      if (d.ok) { onSelect(verifyTarget); onClose() }
      else { setVerifyError(d.message ?? 'PIN 錯誤') }
    } catch { setVerifyError('網路錯誤') }
    finally { setVerifyLoading(false) }
  }

  // ── 帳號 CRUD ───────────────────────────────────────────────────────────────
  const fetchAccounts = async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/jira/accounts')
      const data = await resp.json()
      if (data.ok) {
        setAccounts(data.accounts)
        if (currentEmail && !data.accounts.find((a: AccountInfo) => a.email === currentEmail)) {
          onClearCurrent()
        }
      }
    } finally { setLoading(false) }
  }

  useEffect(() => { fetchAccounts() }, [])

  const handleAdd = async () => {
    if (!newEmail.trim() || !newToken.trim() || !newLabel.trim()) return
    setAddLoading(true); setAddError('')
    try {
      const resp = await fetch('/api/jira/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail.trim(), token: newToken.trim(), label: newLabel.trim(), role: newRole }),
      })
      const data = await resp.json()
      if (!data.ok) { setAddError(data.message ?? '新增失敗') }
      else {
        setAddSuccess(true)
        setNewEmail(''); setNewToken(''); setNewLabel(''); setNewRole('qa')
        await fetchAccounts()
        setTimeout(() => { setAddSuccess(false); setTab('select') }, 800)
      }
    } catch { setAddError('網路錯誤，請確認伺服器是否運行') }
    finally { setAddLoading(false) }
  }

  const handleDelete = async (email: string) => {
    if (!confirm(`確定刪除「${accounts.find(a => a.email === email)?.label ?? email}」？`)) return
    setDeleteLoading(email)
    try {
      const resp = await fetch(`/api/jira/accounts/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: { 'x-admin-pin': sessionStorage.getItem(ADMIN_SESSION_KEY) ?? '' },
      })
      const d = await resp.json()
      if (!d.ok) {
        alert(d.message ?? '刪除失敗')
        if (resp.status === 403) handleExitAdmin()
      } else { await fetchAccounts() }
    } finally { setDeleteLoading(null) }
  }

  // ── 管理員：修改角色 ─────────────────────────────────────────────────────────
  const openRoleEdit = (acc: AccountInfo) => {
    setRoleEditTarget(acc.email)
    setRoleEditValues(new Set(acc.role.split(',') as ('qa' | 'pm')[]))
    setRoleEditError('')
  }

  const handleSaveRole = async () => {
    if (!roleEditTarget || roleEditValues.size === 0) return
    setRoleEditLoading(true); setRoleEditError('')
    try {
      const resp = await fetch(`/api/jira/accounts/${encodeURIComponent(roleEditTarget)}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-pin': sessionStorage.getItem(ADMIN_SESSION_KEY) ?? '' },
        body: JSON.stringify({ roles: [...roleEditValues] }),
      })
      const d = await resp.json()
      if (!d.ok) { setRoleEditError(d.message ?? '儲存失敗'); if (resp.status === 403) handleExitAdmin() }
      else {
        setRoleEditTarget(null)
        await fetchAccounts()
        // 若改的是目前使用中帳號，立即同步 currentAccount 的 role
        if (roleEditTarget === currentEmail) {
          const acc = accounts.find(a => a.email === roleEditTarget)
          if (acc) onSelect({ ...acc, role: d.role })
        }
      }
    } catch { setRoleEditError('網路錯誤') }
    finally { setRoleEditLoading(false) }
  }

  const handleSelectAccount = (acc: AccountInfo) => {
    if (acc.hasPIN) {
      setVerifyTarget(acc); setVerifyPin(''); setVerifyError('')
    } else {
      onSelect(acc); onClose()
    }
  }

  const roleBadge = (role: string) => {
    const roles = role.split(',')
    return (
      <span style={{ display: 'flex', gap: 3 }}>
        {roles.map(r => (
          <span key={r} style={{ padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: r === 'pm' ? '#fef3c7' : '#e0f2fe', color: r === 'pm' ? '#92400e' : '#0369a1' }}>
            {r.toUpperCase()}
          </span>
        ))}
      </span>
    )
  }

  const RoleToggle = ({ value, checked, onChange }: { value: 'qa' | 'pm'; checked: boolean; onChange: (v: boolean) => void }) => (
    <button type="button" onClick={() => onChange(!checked)}
      style={{ padding: '5px 14px', border: `2px solid ${checked ? '#6366f1' : '#e5e7eb'}`, borderRadius: 6, background: checked ? '#ede9fe' : '#f9fafb', color: checked ? '#6366f1' : '#6b7280', fontWeight: checked ? 700 : 400, cursor: 'pointer', fontSize: 13 }}>
      {value.toUpperCase()}
    </button>
  )

  const pinTargetAcc = accounts.find(a => a.email === pinTarget)

  return (
    <Portal>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Jira 帳號</h2>
          <button type="button" className={`modal-close${isGame ? ' dng-modal-close' : ''}`} onClick={onClose}>
            {isGame ? <DungeonIcon name="close" tone="slate" /> : '✕'}
          </button>
        </div>

        {/* ── PIN 驗證彈窗（使用帳號時） ── */}
        {verifyTarget && (
          <div className="modal-body">
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🔒</div>
              <p style={{ fontWeight: 600, fontSize: 15, margin: '0 0 4px' }}>{verifyTarget.label}</p>
              <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>此帳號已設定 PIN，請輸入 PIN 以繼續</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input ref={verifyPinRef} type="password" placeholder="輸入 PIN" value={verifyPin}
                onChange={e => setVerifyPin(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleVerifyAccountPin()}
                style={{ padding: '10px 12px', border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 14, textAlign: 'center', letterSpacing: 4 }} />
              {verifyError && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>❌ {verifyError}</p>}
              <button type="button" className="submit-btn" disabled={verifyLoading || !verifyPin.trim()} onClick={handleVerifyAccountPin}>
                {verifyLoading ? '驗證中...' : '確認'}
              </button>
              <button type="button" onClick={() => setVerifyTarget(null)}
                style={{ fontSize: 13, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}>
                返回
              </button>
            </div>
          </div>
        )}

        {/* ── PIN 設定彈窗 ── */}
        {pinTarget && !verifyTarget && (
          <div className="modal-body">
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontWeight: 600, fontSize: 14, margin: '0 0 4px' }}>
                {pinTargetAcc?.hasPIN ? '🔒 修改 / 移除 PIN' : '🔓 設定 PIN'} — {pinTargetAcc?.label}
              </p>
              <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                {pinTargetAcc?.hasPIN ? '輸入舊 PIN 後設定新 PIN；留空新 PIN 可移除鎖定' : '設定後，使用此帳號時需要輸入 PIN'}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pinTargetAcc?.hasPIN && (
                <label className="field">
                  <span>舊 PIN<em className="req"> *</em></span>
                  <input type="password" value={pinOld} onChange={e => setPinOld(e.target.value)}
                    placeholder="輸入舊 PIN" style={{ letterSpacing: 2 }} />
                </label>
              )}
              <label className="field">
                <span>新 PIN{pinTargetAcc?.hasPIN ? '（留空則移除 PIN）' : <em className="req"> *</em>}</span>
                <input type="password" value={pinNew} onChange={e => setPinNew(e.target.value)}
                  placeholder={pinTargetAcc?.hasPIN ? '留空 = 移除鎖定' : '設定 PIN'} style={{ letterSpacing: 2 }} />
              </label>
              {pinNew && (
                <label className="field">
                  <span>確認新 PIN<em className="req"> *</em></span>
                  <input type="password" value={pinConfirm} onChange={e => setPinConfirm(e.target.value)}
                    placeholder="再次輸入新 PIN" style={{ letterSpacing: 2 }} />
                </label>
              )}
              {pinSetError && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>❌ {pinSetError}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="submit-btn" style={{ flex: 1 }}
                  disabled={pinSetLoading || (pinTargetAcc?.hasPIN ? !pinOld : !pinNew)} onClick={handleSetPin}>
                  {pinSetLoading ? '儲存中...' : '儲存'}
                </button>
                <button type="button" onClick={closePinSetup}
                  style={{ padding: '10px 16px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── 正常帳號選擇 ── */}
        {!pinTarget && !verifyTarget && (
          <>
            <div className="modal-tabs">
              <button type="button" className={`modal-tab${tab === 'select' ? ' active' : ''}`} onClick={() => setTab('select')}>選擇帳號</button>
              <button type="button" className={`modal-tab${tab === 'add' ? ' active' : ''}`} onClick={() => setTab('add')}>新增帳號</button>
            </div>

            {tab === 'select' && (
              <div className="modal-body">
                {loading && <p className="idle-hint">載入中...</p>}
                {!loading && accounts.length === 0 && (
                  <div className="alert-warn">尚無儲存的帳號，請切換到「新增帳號」頁面新增。</div>
                )}
                {accounts.map(acc => (
                  <div key={acc.email} style={{ marginBottom: 8 }}>
                    {/* 帳號卡片 */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 0,
                      border: `1.5px solid ${acc.email === currentEmail ? '#22c55e' : '#e2e8f0'}`,
                      borderRadius: 10, background: acc.email === currentEmail ? '#f0fdf4' : '#fff',
                      overflow: 'hidden',
                    }}>
                      {/* 左側：可點擊選帳號 */}
                      <button type="button" onClick={() => handleSelectAccount(acc)}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>{acc.label}</span>
                          {roleBadge(acc.role)}
                          {acc.email === currentEmail && <span className="badge badge--ok">使用中</span>}
                          {acc.hasPIN && <span title="已設定 PIN" style={{ fontSize: 11 }}>🔒</span>}
                        </div>
                        <span style={{ fontSize: 12, color: '#64748b' }}>{acc.email}</span>
                      </button>

                      {/* 右側：動作按鈕（緊貼邊框） */}
                      <div style={{ display: 'flex', alignItems: 'stretch', borderLeft: '1px solid #f1f5f9', flexShrink: 0 }}>
                        <button type="button" title={acc.hasPIN ? '修改 PIN' : '設定 PIN'}
                          onClick={() => openPinSetup(acc.email)}
                          style={{ padding: '0 10px', background: acc.hasPIN ? '#fef9c3' : 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: acc.hasPIN ? '#92400e' : '#94a3b8' }}>
                          {acc.hasPIN ? '🔒' : '🔓'}
                        </button>
                        {isAdmin && (
                          <>
                            <button type="button" title="修改角色"
                              onClick={() => roleEditTarget === acc.email ? setRoleEditTarget(null) : openRoleEdit(acc)}
                              style={{ padding: '0 10px', background: roleEditTarget === acc.email ? '#ede9fe' : 'none', border: 'none', borderLeft: '1px solid #f1f5f9', cursor: 'pointer', fontSize: 13, color: '#6366f1' }}>
                              🎭
                            </button>
                            <button type="button"
                              disabled={deleteLoading === acc.email}
                              onClick={() => handleDelete(acc.email)}
                              style={{ padding: '0 10px', background: 'none', border: 'none', borderLeft: '1px solid #f1f5f9', cursor: 'pointer', fontSize: 13, color: '#ef4444' }}>
                              {deleteLoading === acc.email ? '…' : '✕'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* 內聯角色編輯區 */}
                    {isAdmin && roleEditTarget === acc.email && (
                      <div style={{ marginTop: 4, padding: '10px 14px', background: '#f5f3ff', borderRadius: 8, border: '1px solid #ddd6fe' }}>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>選擇 {acc.label} 的可用模式：</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <RoleToggle value="qa" checked={roleEditValues.has('qa')}
                            onChange={v => { const s = new Set(roleEditValues); v ? s.add('qa') : s.delete('qa'); setRoleEditValues(s) }} />
                          <RoleToggle value="pm" checked={roleEditValues.has('pm')}
                            onChange={v => { const s = new Set(roleEditValues); v ? s.add('pm') : s.delete('pm'); setRoleEditValues(s) }} />
                          <button type="button" disabled={roleEditLoading || roleEditValues.size === 0} onClick={handleSaveRole}
                            style={{ padding: '5px 14px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                            {roleEditLoading ? '儲存...' : '儲存'}
                          </button>
                          <button type="button" onClick={() => setRoleEditTarget(null)}
                            style={{ padding: '5px 10px', background: '#f3f4f6', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#6b7280' }}>
                            取消
                          </button>
                        </div>
                        {roleEditError && <p style={{ fontSize: 12, color: '#dc2626', margin: '6px 0 0' }}>❌ {roleEditError}</p>}
                      </div>
                    )}
                  </div>
                ))}

                <div style={{ marginTop: 16, borderTop: '1px solid #f3f4f6', paddingTop: 14 }}>
                  {isAdmin ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>🔓 管理員模式（可刪除帳號、修改角色）</span>
                      <button type="button" onClick={handleExitAdmin}
                        style={{ fontSize: 12, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                        退出管理員
                      </button>
                    </div>
                  ) : showAdminPinInput ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input ref={adminPinRef} type="password" placeholder="輸入管理員 PIN"
                          value={adminPinValue} onChange={e => setAdminPinValue(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleVerifyAdminPin()}
                          style={{ flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                        <button type="button" onClick={handleVerifyAdminPin}
                          disabled={adminPinLoading || !adminPinValue.trim()}
                          style={{ padding: '7px 14px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                          {adminPinLoading ? '…' : '驗證'}
                        </button>
                        <button type="button" onClick={() => { setShowAdminPinInput(false); setAdminPinValue(''); setAdminPinError('') }}
                          style={{ padding: '7px 10px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                          取消
                        </button>
                      </div>
                      {adminPinError && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>❌ {adminPinError}</p>}
                    </div>
                  ) : (
                    <button type="button" onClick={() => setShowAdminPinInput(true)}
                      style={{ fontSize: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}>
                      🔐 管理員登入（解鎖刪除、角色編輯）
                    </button>
                  )}
                </div>
              </div>
            )}

            {tab === 'add' && (
              <div className="modal-body">
                <p className="modal-desc">Token 僅儲存於伺服器本機，不會傳到前端或上傳至任何雲端服務。</p>
                <div className="form-stack">
                  <label className="field">
                    <span>角色 <em className="req">*</em></span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['qa', 'pm'] as const).map(r => (
                        <button key={r} type="button" onClick={() => setNewRole(r)}
                          style={{ flex: 1, padding: '8px 0', border: `2px solid ${newRole === r ? '#6366f1' : '#e5e7eb'}`, borderRadius: 6, background: newRole === r ? '#ede9fe' : '#f9fafb', color: newRole === r ? '#6366f1' : '#6b7280', fontWeight: newRole === r ? 700 : 400, cursor: 'pointer', fontSize: 13 }}>
                          {r.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <span className="field-hint">QA 模式：批次開單與評論工作流；PM 模式：從 Lark Bitable 批次建立 Issues。雙身分須由管理員另行設定。</span>
                  </label>
                  <label className="field">
                    <span>顯示名稱 <em className="req">*</em></span>
                    <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Eric Wu" />
                  </label>
                  <label className="field">
                    <span>Jira Email <em className="req">*</em></span>
                    <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="your@email.com" />
                  </label>
                  <label className="field">
                    <span>API Token <em className="req">*</em></span>
                    <input type="password" value={newToken} onChange={e => setNewToken(e.target.value)} placeholder="ATATT..." />
                    <span className="field-hint">
                      前往{' '}
                      <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
                        Atlassian 帳號設定
                      </a>{' '}
                      產生 API Token
                    </span>
                  </label>
                  {addError && <div className="alert-error">{addError}</div>}
                </div>
                <div className="modal-actions">
                  <button type="button" className={`submit-btn${addSuccess ? ' saved' : ''}`}
                    style={{ width: 'auto', padding: '10px 28px' }}
                    disabled={!newEmail.trim() || !newToken.trim() || !newLabel.trim() || addLoading}
                    onClick={handleAdd}>
                    {addSuccess ? '已儲存 ✓' : addLoading ? '儲存中...' : '儲存'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </Portal>
  )
}

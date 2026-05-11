import { useEffect, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = 'qa' | 'pm' | 'admin' | 'other'
type Status = 'active' | 'disabled'

interface Account {
  email: string
  label: string
  role: Role
  status: Status
  hasPIN: boolean
}

interface PermMatrix {
  qa: Record<string, boolean>
  pm: Record<string, boolean>
  other: Record<string, boolean>
}

const PAGE_META: { key: string; label: string; group: string }[] = [
  { key: 'jira',         label: 'Jira 批量開單',      group: 'Jira / TestCase' },
  { key: 'lark',         label: 'TestCase 生成',        group: 'Jira / TestCase' },
  { key: 'osm',          label: 'OSM 版號同步',        group: 'OSM Tools' },
  { key: 'machinetest',  label: '機台自動化測試',       group: 'OSM Tools' },
  { key: 'imagecheck',   label: '圖片刪除驗證',         group: 'OSM Tools' },
  { key: 'osm-config',   label: 'Config 比對',         group: 'OSM Tools' },
  { key: 'autospin',     label: 'AutoSpin',            group: 'OSM Tools' },
  { key: 'url-pool',     label: 'URL 帳號池',           group: 'OSM Tools' },
  { key: 'jackpot',      label: 'Jackpot 監控',        group: 'OSM Tools' },
  { key: 'osm-uat',      label: 'UAT 整合測試',         group: 'OSM Tools' },
  { key: 'gs-imgcompare', label: 'Game Show 圖片比對', group: 'Game Show' },
  { key: 'gs-logchecker', label: 'Game Show Log 攔截', group: 'Game Show' },
  { key: 'gs-bonusv2',   label: 'Game Show Bonus V2',  group: 'Game Show' },
  { key: 'history',      label: '操作歷史紀錄',         group: '系統' },
]

const ROLE_LABELS: Record<Role, string> = { admin: '管理員', qa: 'QA', pm: 'PM', other: 'Other' }

const EMPTY_MATRIX: PermMatrix = { qa: {}, pm: {}, other: {} }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function badge(role: Role) {
  const color: Record<Role, string> = {
    admin: '#7c3aed', qa: '#0284c7', pm: '#0052cc', other: '#64748b',
  }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 99,
      background: `${color[role]}22`, color: color[role],
      fontSize: 11, fontWeight: 600, border: `1px solid ${color[role]}44`,
    }}>
      {ROLE_LABELS[role]}
    </span>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SystemAdminPage() {
  const [subTab, setSubTab] = useState<'permissions' | 'accounts'>('permissions')

  // ── Permission matrix state ──
  const [matrix, setMatrix] = useState<PermMatrix>(EMPTY_MATRIX)
  const [matrixLoading, setMatrixLoading] = useState(true)
  const [matrixSaving, setMatrixSaving] = useState(false)
  const [matrixMsg, setMatrixMsg] = useState('')

  // ── Account state ──
  const [accounts, setAccounts] = useState<Account[]>([])
  const [acctLoading, setAcctLoading] = useState(false)
  const [acctMsg, setAcctMsg] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [newAcct, setNewAcct] = useState({ email: '', label: '', role: 'qa' as Role, token: '', pin: '', status: 'active' as Status })
  const [editTarget, setEditTarget] = useState<Account | null>(null)
  const [editForm, setEditForm] = useState({ label: '', role: 'qa' as Role, status: 'active' as Status, pin: '', clearPin: false })

  // ── Load matrix ──
  useEffect(() => {
    setMatrixLoading(true)
    fetch('/api/admin/permissions')
      .then(r => r.json())
      .then(d => { if (d.ok) setMatrix(d.matrix) })
      .finally(() => setMatrixLoading(false))
  }, [])

  // ── Load accounts ──
  function loadAccounts() {
    setAcctLoading(true)
    fetch('/api/admin/accounts')
      .then(r => r.json())
      .then(d => { if (d.ok) setAccounts(d.accounts) })
      .finally(() => setAcctLoading(false))
  }
  useEffect(() => { loadAccounts() }, [])

  function togglePerm(role: keyof PermMatrix, key: string) {
    setMatrix(prev => ({
      ...prev,
      [role]: { ...prev[role], [key]: !prev[role][key] },
    }))
  }

  async function saveMatrix() {
    setMatrixSaving(true)
    setMatrixMsg('')
    try {
      const r = await fetch('/api/admin/permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matrix }),
      })
      const d = await r.json()
      setMatrixMsg(d.ok ? '✅ 已儲存' : `❌ ${d.message}`)
    } catch {
      setMatrixMsg('❌ 儲存失敗')
    } finally {
      setMatrixSaving(false)
    }
  }

  async function createAccount() {
    if (!newAcct.email || !newAcct.label) { setAcctMsg('❌ 請填寫 Email 和名稱'); return }
    const r = await fetch('/api/admin/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newAcct),
    })
    const d = await r.json()
    if (d.ok) {
      setAcctMsg('✅ 已新增')
      setNewAcct({ email: '', label: '', role: 'qa', token: '', pin: '', status: 'active' })
      setShowAddForm(false)
      loadAccounts()
    } else {
      setAcctMsg(`❌ ${d.message}`)
    }
  }

  function openEdit(a: Account) {
    setEditTarget(a)
    setEditForm({ label: a.label, role: a.role, status: a.status, pin: '', clearPin: false })
    setAcctMsg('')
  }

  async function saveEdit() {
    if (!editTarget) return
    const r = await fetch(`/api/admin/accounts/${encodeURIComponent(editTarget.email)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
    })
    const d = await r.json()
    if (d.ok) {
      setAcctMsg('✅ 已更新')
      setEditTarget(null)
      loadAccounts()
    } else {
      setAcctMsg(`❌ ${d.message}`)
    }
  }

  async function deleteAccount(email: string) {
    if (!confirm(`確認刪除帳號 ${email}？`)) return
    const r = await fetch(`/api/admin/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })
    const d = await r.json()
    if (d.ok) { setAcctMsg('✅ 已刪除'); loadAccounts() }
    else setAcctMsg(`❌ ${d.message}`)
  }

  // ── Group pages for matrix display ──
  const groups = Array.from(new Set(PAGE_META.map(p => p.group)))

  // ─── Styles ───────────────────────────────────────────────────────────────

  const card: React.CSSProperties = {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
    padding: 24, marginBottom: 20,
  }

  const tableStyle: React.CSSProperties = {
    width: '100%', borderCollapse: 'collapse', fontSize: 13,
  }

  const th: React.CSSProperties = {
    padding: '10px 16px', textAlign: 'center', fontWeight: 600,
    background: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569',
    fontSize: 13,
  }

  const thLeft: React.CSSProperties = { ...th, textAlign: 'left' }

  const td: React.CSSProperties = {
    padding: '9px 16px', borderBottom: '1px solid #f1f5f9', textAlign: 'center',
  }

  const tdLeft: React.CSSProperties = { ...td, textAlign: 'left' }

  const inputStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1',
    fontSize: 13, width: '100%', outline: 'none',
  }

  const btnPrimary: React.CSSProperties = {
    padding: '7px 16px', background: '#0f172a', color: '#fff',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500,
    whiteSpace: 'nowrap',
  }

  const btnOutline: React.CSSProperties = {
    padding: '7px 14px', background: '#fff', color: '#475569',
    border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 13,
    whiteSpace: 'nowrap',
  }

  const btnDanger: React.CSSProperties = {
    ...btnOutline, color: '#dc2626', borderColor: '#fca5a5',
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '20px 28px', maxWidth: 1100 }}>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#f1f5f9', padding: 4, borderRadius: 8, width: 'fit-content', border: '1px solid #e2e8f0' }}>
        {([['permissions', '功能權限'], ['accounts', '帳號管理']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubTab(id)}
            style={{
              padding: '7px 20px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500,
              background: subTab === id ? '#fff' : 'transparent',
              color: subTab === id ? '#0f172a' : '#64748b',
              boxShadow: subTab === id ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Permission Matrix ── */}
      {subTab === 'permissions' && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>功能頁面權限</h2>
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>管理員永遠全開（不可修改）。Other 為客製化角色，由管理員自訂。</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {matrixMsg && <span style={{ fontSize: 12, color: matrixMsg.startsWith('✅') ? '#16a34a' : '#dc2626' }}>{matrixMsg}</span>}
              <button type="button" style={btnPrimary} onClick={saveMatrix} disabled={matrixSaving}>
                {matrixSaving ? '儲存中…' : '儲存權限設定'}
              </button>
            </div>
          </div>

          {matrixLoading ? (
            <p style={{ color: '#94a3b8', fontSize: 13 }}>載入中…</p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={{ ...thLeft, width: '40%' }}>功能頁面</th>
                  <th style={th}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      {badge('admin')} <span style={{ fontSize: 10, color: '#94a3b8' }}>鎖定</span>
                    </span>
                  </th>
                  <th style={th}>{badge('qa')}</th>
                  <th style={th}>{badge('pm')}</th>
                  <th style={th}>{badge('other')}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(group => (
                  <>
                    <tr key={`grp-${group}`}>
                      <td colSpan={5} style={{
                        padding: '8px 16px', background: '#f8fafc',
                        fontSize: 11, fontWeight: 600, color: '#64748b',
                        textTransform: 'uppercase', letterSpacing: '.6px',
                        borderBottom: '1px solid #e2e8f0',
                      }}>
                        {group}
                      </td>
                    </tr>
                    {PAGE_META.filter(p => p.group === group).map(page => (
                      <tr key={page.key} style={{ transition: 'background .1s' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}
                      >
                        <td style={tdLeft}>{page.label}</td>
                        {/* Admin — always checked, disabled */}
                        <td style={td}>
                          <input type="checkbox" checked disabled style={{ cursor: 'not-allowed', accentColor: '#7c3aed' }} />
                        </td>
                        {(['qa', 'pm', 'other'] as const).map(role => (
                          <td key={role} style={td}>
                            <input
                              type="checkbox"
                              checked={!!matrix[role]?.[page.key]}
                              onChange={() => togglePerm(role, page.key)}
                              style={{ cursor: 'pointer', accentColor: '#0284c7' }}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Account Management ── */}
      {subTab === 'accounts' && (
        <div>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>帳號管理</h2>
                <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>管理所有使用者帳號，指派角色與 PIN。</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {acctMsg && <span style={{ fontSize: 12, color: acctMsg.startsWith('✅') ? '#16a34a' : '#dc2626' }}>{acctMsg}</span>}
                <button type="button" style={btnPrimary} onClick={() => { setShowAddForm(v => !v); setAcctMsg('') }}>
                  {showAddForm ? '取消' : '+ 新增帳號'}
                </button>
              </div>
            </div>

            {/* Add form */}
            {showAddForm && (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginBottom: 12 }}>
                  <div>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>Email *</label>
                    <input style={inputStyle} placeholder="user@example.com" value={newAcct.email}
                      onChange={e => setNewAcct(p => ({ ...p, email: e.target.value }))} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>名稱 *</label>
                    <input style={inputStyle} placeholder="顯示名稱" value={newAcct.label}
                      onChange={e => setNewAcct(p => ({ ...p, label: e.target.value }))} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>角色</label>
                    <select style={{ ...inputStyle }} value={newAcct.role}
                      onChange={e => setNewAcct(p => ({ ...p, role: e.target.value as Role }))}>
                      <option value="qa">QA</option>
                      <option value="pm">PM</option>
                      <option value="other">Other</option>
                      <option value="admin">管理員</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>Jira Token（可選）</label>
                    <input style={inputStyle} placeholder="JIRA API token" value={newAcct.token}
                      onChange={e => setNewAcct(p => ({ ...p, token: e.target.value }))} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>初始 PIN（可選）</label>
                    <input style={inputStyle} type="password" placeholder="4–8 位數字" value={newAcct.pin}
                      onChange={e => setNewAcct(p => ({ ...p, pin: e.target.value }))} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>狀態</label>
                    <select style={{ ...inputStyle }} value={newAcct.status}
                      onChange={e => setNewAcct(p => ({ ...p, status: e.target.value as Status }))}>
                      <option value="active">啟用</option>
                      <option value="disabled">停用</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" style={btnPrimary} onClick={createAccount}>建立帳號</button>
                  <button type="button" style={btnOutline} onClick={() => setShowAddForm(false)}>取消</button>
                </div>
              </div>
            )}

            {/* Edit modal */}
            {editTarget && (
              <div style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
              }}>
                <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 480, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 16px', color: '#0f172a' }}>
                    編輯帳號：{editTarget.label}
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>名稱</label>
                      <input style={inputStyle} value={editForm.label}
                        onChange={e => setEditForm(p => ({ ...p, label: e.target.value }))} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>角色</label>
                      <select style={{ ...inputStyle }} value={editForm.role}
                        onChange={e => setEditForm(p => ({ ...p, role: e.target.value as Role }))}>
                        <option value="qa">QA</option>
                        <option value="pm">PM</option>
                        <option value="other">Other</option>
                        <option value="admin">管理員</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>狀態</label>
                      <select style={{ ...inputStyle }} value={editForm.status}
                        onChange={e => setEditForm(p => ({ ...p, status: e.target.value as Status }))}>
                        <option value="active">啟用</option>
                        <option value="disabled">停用</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>
                        重設 PIN {editTarget.hasPIN ? '（已設定）' : '（未設定）'}
                      </label>
                      <input style={inputStyle} type="password" placeholder="留空保持不變"
                        value={editForm.pin}
                        onChange={e => setEditForm(p => ({ ...p, pin: e.target.value, clearPin: false }))} />
                    </div>
                  </div>
                  {editTarget.hasPIN && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#dc2626', marginBottom: 16, cursor: 'pointer' }}>
                      <input type="checkbox" checked={editForm.clearPin}
                        onChange={e => setEditForm(p => ({ ...p, clearPin: e.target.checked, pin: '' }))} />
                      清除 PIN（下次登入不需要 PIN）
                    </label>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" style={btnPrimary} onClick={saveEdit}>儲存</button>
                    <button type="button" style={btnOutline} onClick={() => setEditTarget(null)}>取消</button>
                  </div>
                </div>
              </div>
            )}

            {/* Accounts table */}
            {acctLoading ? (
              <p style={{ color: '#94a3b8', fontSize: 13 }}>載入中…</p>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thLeft}>帳號</th>
                    <th style={thLeft}>名稱</th>
                    <th style={th}>角色</th>
                    <th style={th}>狀態</th>
                    <th style={th}>PIN</th>
                    <th style={th}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(a => (
                    <tr key={a.email}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ ...tdLeft, fontFamily: 'monospace', fontSize: 12, color: '#475569' }}>{a.email}</td>
                      <td style={tdLeft}>{a.label}</td>
                      <td style={td}>{badge(a.role)}</td>
                      <td style={td}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600,
                          background: a.status === 'active' ? '#dcfce7' : '#fee2e2',
                          color: a.status === 'active' ? '#16a34a' : '#dc2626',
                        }}>
                          {a.status === 'active' ? '啟用' : '停用'}
                        </span>
                      </td>
                      <td style={{ ...td, fontSize: 11, color: a.hasPIN ? '#16a34a' : '#94a3b8' }}>
                        {a.hasPIN ? '已設定' : '—'}
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                          <button type="button" style={btnOutline} onClick={() => openEdit(a)}>編輯</button>
                          <button type="button" style={btnDanger} onClick={() => deleteAccount(a.email)}>刪除</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {accounts.length === 0 && (
                    <tr><td colSpan={6} style={{ ...td, color: '#94a3b8', textAlign: 'center', padding: 32 }}>尚無帳號</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

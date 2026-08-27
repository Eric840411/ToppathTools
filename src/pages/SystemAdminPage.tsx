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
  { key: 'jira-qa',      label: 'Jira 批量開單（QA 模式）', group: 'Jira / TestCase' },
  { key: 'jira-pm',      label: 'Jira 批量開單（PM 模式）', group: 'Jira / TestCase' },
  { key: 'jira-update',  label: 'Jira 批次更新票', group: 'Jira / TestCase' },
  { key: 'lark',         label: 'TestCase 生成',            group: 'Jira / TestCase' },
  { key: 'weekly-report', label: '週報彙整',                group: 'Jira / TestCase' },
  { key: 'osm',          label: 'OSM 版號同步',        group: 'OSM Tools' },
  { key: 'machinetest',  label: '機台自動化測試',       group: 'OSM Tools' },
  { key: 'imagecheck',   label: '圖片刪除驗證',         group: 'OSM Tools' },
  { key: 'osm-config',   label: 'Config 比對',         group: 'OSM Tools' },
  { key: 'autospin',     label: 'AutoSpin',            group: 'OSM Tools' },
  { key: 'url-pool',     label: 'URL 帳號池',           group: 'OSM Tools' },
  { key: 'jackpot',      label: 'Jackpot 監控',        group: 'OSM Tools' },
  { key: 'osm-uat',      label: 'UAT 整合測試',         group: 'OSM Tools' },
  { key: 'ui-screenshot', label: 'UI 解析度截圖',       group: 'OSM Tools' },
  { key: 'meter-reconcile', label: 'Performance Meter 對帳', group: 'OSM Tools' },
  { key: 'egm-daycount', label: 'Egm DayCount 對帳', group: 'OSM Tools' },
  { key: 'gs-imgcompare', label: 'Game Show 圖片比對', group: 'Game Show' },
  { key: 'gs-logchecker', label: 'Game Show Log 攔截', group: 'Game Show' },
  { key: 'gs-bonusv2',   label: 'Game Show Bonus V2',  group: 'Game Show' },
  { key: 'history',      label: '操作歷史紀錄',         group: '系統' },
  { key: 'knowledge',   label: '知識庫',               group: '系統' },
  { key: 'local-agent', label: 'Local Agent',          group: '系統' },
  { key: 'discord-notify', label: 'Discord 通知設定',   group: '系統' },
  { key: 'cultivation-board', label: '境界排行榜',      group: '系統' },
  { key: 'xianxia-quotes',    label: '每日仙語管理',    group: '系統' },
  { key: 'jira-ai-format', label: 'AI 排版評論（批量評論）', group: '功能開關' },
  { key: 'jira-ai-review', label: 'AI 完整性分析（批量評論）', group: '功能開關' },
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

  // ── Cultivation (admin override) state ──
  const [cultivationLevels, setCultivationLevels] = useState<{ name: string; threshold: number }[]>([])
  const [cultivationTarget, setCultivationTarget] = useState<Account | null>(null)
  const [permTarget, setPermTarget] = useState<Account | null>(null)
  const [permData, setPermData] = useState<{ roleDefaults: string[]; overrides: Record<string, boolean> } | null>(null)
  const [permSaving, setPermSaving] = useState(false)
  const [permMsg, setPermMsg] = useState('')
  // Jira 代理張貼授權（誰可以用誰的身分張貼批量評論）
  const [delegates, setDelegates] = useState<{ id: number; actor_email: string; target_email: string; scope: string; enabled: number; created_at: number; expires_at: number | null; revoked_at: number | null }[]>([])
  const [delActor, setDelActor] = useState('')
  const [delTarget, setDelTarget] = useState('')
  // 用途（scope）原本寫死成 'jira.comment.batch'，所以畫面上根本開不出「跨帳號讀取」那種授權——
  // 但週報的 Jira 撈單要的正是後者。表格那邊早就會顯示兩種用途了，只有新增這邊漏掉（2026-08-27
  // 使用者實際去開授權才發現：開好了、狀態也是有效，但用途不對所以撈單還是被擋）。
  const [delScope, setDelScope] = useState<'jira.comment.batch' | 'jira.read.asOther'>('jira.comment.batch')
  const [delMsg, setDelMsg] = useState('')
  const [cultivationInfo, setCultivationInfo] = useState<{ level: string; activeDays: number } | null>(null)
  const [cultivationDaysInput, setCultivationDaysInput] = useState(0)
  const [cultivationSaving, setCultivationSaving] = useState(false)
  const [cultivationMsg, setCultivationMsg] = useState('')

  useEffect(() => {
    fetch('/api/admin/cultivation-levels')
      .then(r => r.json())
      .then(d => { if (d.ok) setCultivationLevels(d.levels) })
      .catch(() => {})
  }, [])

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
  useEffect(() => { loadAccounts(); void loadDelegates() }, [])

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
      setMatrixMsg(d.ok ? '通過 已儲存' : `失敗 ${d.message}`)
    } catch {
      setMatrixMsg('失敗 儲存失敗')
    } finally {
      setMatrixSaving(false)
    }
  }

  async function createAccount() {
    if (!newAcct.email || !newAcct.label) { setAcctMsg('失敗 請填寫 Email 和名稱'); return }
    const r = await fetch('/api/admin/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newAcct),
    })
    const d = await r.json()
    if (d.ok) {
      setAcctMsg('通過 已新增')
      setNewAcct({ email: '', label: '', role: 'qa', token: '', pin: '', status: 'active' })
      setShowAddForm(false)
      loadAccounts()
    } else {
      setAcctMsg(`失敗 ${d.message}`)
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
      setAcctMsg('通過 已更新')
      setEditTarget(null)
      loadAccounts()
    } else {
      setAcctMsg(`失敗 ${d.message}`)
    }
  }

  async function deleteAccount(email: string) {
    if (!confirm(`確認刪除帳號 ${email}？`)) return
    const r = await fetch(`/api/admin/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })
    const d = await r.json()
    if (d.ok) { setAcctMsg('通過 已刪除'); loadAccounts() }
    else setAcctMsg(`失敗 ${d.message}`)
  }

  async function loadDelegates() {
    const r = await fetch('/api/admin/jira-delegates')
    const d = await r.json() as { ok: boolean; delegates?: typeof delegates }
    if (d.ok) setDelegates(d.delegates ?? [])
  }

  async function addDelegate() {
    if (!delActor || !delTarget) { setDelMsg('失敗 請選擇授權人與被代理帳號'); return }
    const r = await fetch('/api/admin/jira-delegates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorEmail: delActor, targetEmail: delTarget, scope: delScope }),
    })
    const d = await r.json() as { ok: boolean; message?: string }
    setDelMsg(d.ok ? '通過 已新增授權' : `失敗 ${d.message ?? '新增失敗'}`)
    if (d.ok) { setDelTarget(''); void loadDelegates() }
  }

  async function revokeDelegate(id: number) {
    const r = await fetch(`/api/admin/jira-delegates/${id}`, { method: 'DELETE' })
    const d = await r.json() as { ok: boolean; message?: string }
    setDelMsg(d.ok ? '通過 已撤銷' : `失敗 ${d.message ?? '撤銷失敗'}`)
    void loadDelegates()
  }

  // ── 個人權限覆寫 ──
  // 角色權限是團隊層級的預設，這裡是疊在上面的個人例外：三態（繼承角色／強制開啟／強制關閉），
  // 直接對應後端 account_permissions 的「沒有這筆／allowed=1／allowed=0」。
  async function openPerm(a: Account) {
    setPermTarget(a)
    setPermMsg('')
    setPermData(null)
    const r = await fetch(`/api/admin/accounts/${encodeURIComponent(a.email)}/permissions`)
    const d = await r.json() as { ok: boolean; roleDefaults?: string[]; overrides?: Record<string, boolean>; message?: string }
    if (d.ok) setPermData({ roleDefaults: d.roleDefaults ?? [], overrides: d.overrides ?? {} })
    else setPermMsg(`失敗 ${d.message ?? '讀取失敗'}`)
  }

  function setPermOverride(key: string, value: 'inherit' | 'on' | 'off') {
    setPermData(prev => {
      if (!prev) return prev
      const next = { ...prev.overrides }
      if (value === 'inherit') delete next[key]
      else next[key] = value === 'on'
      return { ...prev, overrides: next }
    })
  }

  async function savePerm() {
    if (!permTarget || !permData) return
    setPermSaving(true)
    try {
      const r = await fetch(`/api/admin/accounts/${encodeURIComponent(permTarget.email)}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: permData.overrides }),
      })
      const d = await r.json() as { ok: boolean; message?: string }
      setPermMsg(d.ok ? '通過 已更新' : `失敗 ${d.message ?? '儲存失敗'}`)
    } catch { setPermMsg('失敗 儲存失敗') }
    finally { setPermSaving(false) }
  }

  async function openCultivation(a: Account) {
    setCultivationTarget(a)
    setCultivationMsg('')
    const r = await fetch(`/api/admin/accounts/${encodeURIComponent(a.email)}/cultivation`)
    const d = await r.json()
    if (d.ok) {
      setCultivationInfo({ level: d.level, activeDays: d.activeDays })
      setCultivationDaysInput(d.activeDays)
    }
  }

  async function saveCultivation() {
    if (!cultivationTarget) return
    setCultivationSaving(true)
    try {
      const r = await fetch(`/api/admin/accounts/${encodeURIComponent(cultivationTarget.email)}/cultivation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeDays: cultivationDaysInput }),
      })
      const d = await r.json()
      if (d.ok) {
        setCultivationInfo({ level: d.level, activeDays: d.activeDays })
        setCultivationMsg('通過 已更新')
      } else {
        setCultivationMsg(`失敗 ${d.message}`)
      }
    } catch {
      setCultivationMsg('失敗 儲存失敗')
    } finally {
      setCultivationSaving(false)
    }
  }

  // ── Group pages for matrix display ──
  const groups = Array.from(new Set(PAGE_META.map(p => p.group)))

  // ─── Styles ───────────────────────────────────────────────────────────────

  const card: React.CSSProperties = {
    background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 12,
    padding: 24, marginBottom: 20,
  }

  const tableStyle: React.CSSProperties = {
    width: '100%', borderCollapse: 'collapse', fontSize: 13,
  }

  const th: React.CSSProperties = {
    padding: '10px 16px', textAlign: 'center', fontWeight: 600,
    background: '#162032', borderBottom: '2px solid #2d3f55', color: '#94a3b8',
    fontSize: 13,
  }

  const thLeft: React.CSSProperties = { ...th, textAlign: 'left' }

  const td: React.CSSProperties = {
    padding: '9px 16px', borderBottom: '1px solid #1e293b', textAlign: 'center',
  }

  const tdLeft: React.CSSProperties = { ...td, textAlign: 'left' }

  const inputStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55',
    fontSize: 13, width: '100%', outline: 'none',
    background: '#0f172a', color: '#e2e8f0',
  }

  const btnPrimary: React.CSSProperties = {
    padding: '7px 16px', background: '#6366f1', color: '#fff',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500,
    whiteSpace: 'nowrap',
  }

  const btnOutline: React.CSSProperties = {
    padding: '7px 14px', background: '#1e293b', color: '#94a3b8',
    border: '1px solid #2d3f55', borderRadius: 6, cursor: 'pointer', fontSize: 13,
    whiteSpace: 'nowrap',
  }

  const btnDanger: React.CSSProperties = {
    ...btnOutline, color: '#f87171', borderColor: 'rgba(239,68,68,0.4)',
    background: 'rgba(239,68,68,0.1)',
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '20px 28px', maxWidth: 1100 }}>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#162032', padding: 4, borderRadius: 8, width: 'fit-content', border: '1px solid #2d3f55' }}>
        {([['permissions', '功能權限'], ['accounts', '帳號管理']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubTab(id)}
            style={{
              padding: '7px 20px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500,
              background: subTab === id ? '#1e293b' : 'transparent',
              color: subTab === id ? '#e2e8f0' : '#64748b',
              boxShadow: subTab === id ? '0 1px 3px rgba(0,0,0,.3)' : 'none',
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
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>功能頁面權限</h2>
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>管理員永遠全開（不可修改）。Other 為客製化角色，由管理員自訂。</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {matrixMsg && <span style={{ fontSize: 12, color: matrixMsg.startsWith('通過') ? '#16a34a' : '#dc2626' }}>{matrixMsg}</span>}
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
                        padding: '8px 16px', background: '#162032',
                        fontSize: 11, fontWeight: 600, color: '#64748b',
                        textTransform: 'uppercase', letterSpacing: '.6px',
                        borderBottom: '1px solid #2d3f55',
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
                <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>帳號管理</h2>
                <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>管理所有使用者帳號，指派角色與 PIN。</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {acctMsg && <span style={{ fontSize: 12, color: acctMsg.startsWith('通過') ? '#16a34a' : '#dc2626' }}>{acctMsg}</span>}
                <button type="button" style={btnPrimary} onClick={() => { setShowAddForm(v => !v); setAcctMsg('') }}>
                  {showAddForm ? '取消' : '+ 新增帳號'}
                </button>
              </div>
            </div>

            {/* Add form */}
            {showAddForm && (
              <div style={{ background: '#162032', border: '1px solid #2d3f55', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginBottom: 12 }}>
                  <div>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>
                      {newAcct.role === 'other' ? '帳號識別碼 *' : 'Email *'}
                    </label>
                    <input style={inputStyle}
                      placeholder={newAcct.role === 'other' ? '任意唯一識別碼（如 guest01）' : 'user@example.com'}
                      value={newAcct.email}
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
                <div style={{ background: '#1e293b', borderRadius: 12, padding: 28, width: 480, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 16px', color: '#e2e8f0' }}>
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
                        onChange={e => setEditForm(p => ({ ...p, role: e.target.value as Role }))}
                        disabled={editTarget?.role === 'admin'}>
                        <option value="qa">QA</option>
                        <option value="pm">PM</option>
                        <option value="other">Other</option>
                        {editTarget?.role === 'admin' && <option value="admin">管理員（唯一，不可更改）</option>}
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

            {/* 個人權限覆寫 modal */}
            {permTarget && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                <div style={{ background: '#1e293b', borderRadius: 12, padding: 28, width: 560, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 8px', color: '#e2e8f0' }}>
                    功能權限：{permTarget.label}
                  </h3>
                  <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 16px' }}>
                    疊在角色權限之上的個人例外。「繼承角色」＝照上面的角色權限表；設成開啟／關閉才會覆寫。
                    {permTarget.role === 'admin' && <span style={{ color: '#fbbf24' }}>（管理員一律全開，覆寫不會生效）</span>}
                  </p>
                  {!permData ? (
                    <p style={{ fontSize: 12, color: '#64748b' }}>載入中…</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                      {PAGE_META.map(pm => {
                        const inherited = permData.roleDefaults.includes(pm.key)
                        const ov = permData.overrides[pm.key]
                        const cur: 'inherit' | 'on' | 'off' = ov === undefined ? 'inherit' : (ov ? 'on' : 'off')
                        return (
                          <div key={pm.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#cbd5e1' }}>
                            <span style={{ flex: 1 }}>{pm.label} <span style={{ color: '#475569' }}>· {pm.group}</span></span>
                            <span style={{ fontSize: 11, color: inherited ? '#4ade80' : '#64748b', width: 76, textAlign: 'right' }}>
                              角色{inherited ? '有' : '無'}
                            </span>
                            <select value={cur} onChange={e => setPermOverride(pm.key, e.target.value as 'inherit' | 'on' | 'off')}
                              style={{ ...inputStyle, width: 110, padding: '4px 6px', margin: 0 }}>
                              <option value="inherit">繼承角色</option>
                              <option value="on">強制開啟</option>
                              <option value="off">強制關閉</option>
                            </select>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" style={btnPrimary} onClick={savePerm} disabled={permSaving || !permData}>
                      {permSaving ? '儲存中…' : '儲存'}
                    </button>
                    <button type="button" style={btnOutline} onClick={() => setPermTarget(null)}>關閉</button>
                  </div>
                  {permMsg && <p style={{ fontSize: 12, marginTop: 10, color: permMsg.startsWith('通過') ? '#4ade80' : '#f87171' }}>{permMsg}</p>}
                </div>
              </div>
            )}

            {/* Cultivation adjust modal */}
            {cultivationTarget && (
              <div style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
              }}>
                <div style={{ background: '#1e293b', borderRadius: 12, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 8px', color: '#e2e8f0' }}>
                    調整境界：{cultivationTarget.label}
                  </h3>
                  <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 16px' }}>
                    直接改「累計登入天數」，之後帳號正常登入仍會從這個新天數繼續往上累計。
                  </p>
                  {cultivationInfo && (
                    <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
                      目前境界：{cultivationInfo.level}（累計 {cultivationInfo.activeDays} 天）
                    </p>
                  )}
                  <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>快速選擇境界</label>
                  <select
                    style={{ ...inputStyle, marginBottom: 12 }}
                    value=""
                    onChange={e => { if (e.target.value) setCultivationDaysInput(Number(e.target.value)) }}
                  >
                    <option value="">（選擇境界快速帶入天數）</option>
                    {cultivationLevels.map(lv => (
                      <option key={lv.name} value={lv.threshold}>{lv.name}（{lv.threshold} 天）</option>
                    ))}
                  </select>
                  <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>累計登入天數</label>
                  <input
                    style={{ ...inputStyle, marginBottom: 16 }}
                    type="number"
                    min={0}
                    value={cultivationDaysInput}
                    onChange={e => setCultivationDaysInput(Math.max(0, Number(e.target.value) || 0))}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" style={btnPrimary} onClick={saveCultivation} disabled={cultivationSaving}>
                      {cultivationSaving ? '儲存中…' : '儲存'}
                    </button>
                    <button type="button" style={btnOutline} onClick={() => setCultivationTarget(null)}>關閉</button>
                  </div>
                  {cultivationMsg && <p style={{ fontSize: 12, marginTop: 10, color: cultivationMsg.startsWith('通過') ? '#4ade80' : '#f87171' }}>{cultivationMsg}</p>}
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
                      onMouseEnter={e => (e.currentTarget.style.background = '#1e293b')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ ...tdLeft, fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' }}>{a.email}</td>
                      <td style={tdLeft}>{a.label}</td>
                      <td style={td}>{badge(a.role)}</td>
                      <td style={td}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600,
                          background: a.status === 'active' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                          color: a.status === 'active' ? '#4ade80' : '#f87171',
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
                          <button type="button" style={btnOutline} onClick={() => openPerm(a)}>功能權限</button>
                          <button type="button" style={btnOutline} onClick={() => openCultivation(a)}>調整境界</button>
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

          {/* Jira 代理張貼授權 */}
          <div style={{ borderTop: '1px solid #2d3f55', marginTop: 24, paddingTop: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: '0 0 4px' }}>Jira 代理張貼授權</h3>
            <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 14px' }}>
              指定「誰可以用誰的身分做事」。<b>兩種用途是分開的，開了一種不會涵蓋另一種</b>——
              「批量評論」是<b>寫入</b>（用他的身分張貼留言），「跨帳號讀取」是<b>讀取</b>（週報撈他的 Jira 單）。<br />
              被授權的人在批量評論會多出「以誰的身分送出」下拉；
              Jira 上只會顯示被代理的帳號，系統內部的操作紀錄仍會記下實際操作者。撤銷後保留紀錄可查。
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
              <select style={{ ...inputStyle, width: 200, margin: 0 }} value={delActor} onChange={e => setDelActor(e.target.value)}>
                <option value="">授權給誰（代理人）</option>
                {accounts.map(a => <option key={a.email} value={a.email}>{a.label}</option>)}
              </select>
              <span style={{ color: '#64748b', fontSize: 12 }}>可以用</span>
              <select style={{ ...inputStyle, width: 200, margin: 0 }} value={delTarget} onChange={e => setDelTarget(e.target.value)}>
                <option value="">誰的身分（被代理帳號）</option>
                {accounts.map(a => <option key={a.email} value={a.email}>{a.label}</option>)}
              </select>
              <span style={{ color: '#64748b', fontSize: 12 }}>用途</span>
              <select style={{ ...inputStyle, width: 190, margin: 0 }} value={delScope}
                onChange={e => setDelScope(e.target.value as typeof delScope)}>
                <option value="jira.comment.batch">批量評論（用他的身分張貼）</option>
                <option value="jira.read.asOther">跨帳號讀取（週報撈單用）</option>
              </select>
              <button type="button" style={btnPrimary} onClick={addDelegate}>新增授權</button>
              {delMsg && <span style={{ fontSize: 12, color: delMsg.startsWith('通過') ? '#4ade80' : '#f87171' }}>{delMsg}</span>}
            </div>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thLeft}>代理人</th>
                  <th style={thLeft}>可用身分</th>
                  <th style={th}>用途</th>
                  <th style={th}>狀態</th>
                  <th style={th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {delegates.map(d => {
                  const expired = !!d.expires_at && d.expires_at <= Date.now()
                  const active = d.enabled === 1 && !d.revoked_at && !expired
                  return (
                    <tr key={d.id}>
                      <td style={tdLeft}>{d.actor_email}</td>
                      <td style={tdLeft}>{d.target_email}</td>
                      <td style={{ ...td, fontSize: 11, color: '#94a3b8' }}>{d.scope === 'jira.comment.batch' ? '批量評論' : '跨帳號讀取'}</td>
                      <td style={{ ...td, fontSize: 11, color: active ? '#4ade80' : '#94a3b8' }}>
                        {active ? '有效' : d.revoked_at ? '已撤銷' : expired ? '已過期' : '停用'}
                      </td>
                      <td style={td}>
                        {active && <button type="button" style={btnDanger} onClick={() => revokeDelegate(d.id)}>撤銷</button>}
                      </td>
                    </tr>
                  )
                })}
                {delegates.length === 0 && (
                  <tr><td colSpan={5} style={{ ...td, color: '#94a3b8', textAlign: 'center', padding: 24 }}>尚無代理授權</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

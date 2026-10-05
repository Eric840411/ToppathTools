import { useEffect, useMemo, useState, useRef } from 'react'

/**
 * 系統管理 →「角色管理」（v5.9.0）。版面：CodeX 線框、使用者看樣稿 mockup-role-management.html 確認。
 * 原本的「功能權限」矩陣併進這裡：左邊角色清單、右邊編輯（名稱、顏色、可見功能、使用中的帳號、刪除）。
 * - 管理員：固定、唯讀、永遠全開
 * - 內建（QA／PM／Other）：這版不能改名刪除，可見功能能改
 * - 自建：可改名、改色、刪除；使用中的刪不掉（後端擋，畫面列出是哪些帳號）
 * 規則都在後端 server/role-store.ts，這裡只負責顯示與送出。
 */

export type RoleInfo = { key: string; label: string; color: string; builtin: boolean; fixed?: boolean; users: string[]; perms: Record<string, boolean> }
type PageMeta = { key: string; label: string; group: string }

const COLORS = ['#7c3aed', '#2563eb', '#0284c7', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#64748b']

export function RoleBadge({ role, roles }: { role: string; roles: RoleInfo[] }) {
  const parts = role.split(',').map(s => s.trim()).filter(Boolean)
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {parts.map(k => {
        const r = roles.find(x => x.key === k)
        const color = r?.color ?? '#64748b'
        return (
          <span key={k} style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 99, background: `${color}22`, color, fontSize: 11, fontWeight: 600, border: `1px solid ${color}44`, whiteSpace: 'nowrap' }}>
            {r?.label ?? k}
          </span>
        )
      })}
    </span>
  )
}

export function RoleManager({ pageMeta, onChanged, onGoAccounts }: { pageMeta: PageMeta[]; onChanged: (roles: RoleInfo[]) => void; onGoAccounts: () => void }) {
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [cur, setCur] = useState('')
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<{ label: string; color: string; perms: Record<string, boolean> } | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; users?: string[] } | null>(null)
  // 名稱沒填就按建立：要講出來（使用者 10/05：按了沒反應，原來是沒填名稱——修仙版的灰色鈕看起來跟能按的一樣）
  const [nameError, setNameError] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  async function load(select?: string) {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/roles')
      const d = await r.json() as { ok: boolean; roles?: RoleInfo[]; message?: string }
      if (!d.ok || !d.roles) throw new Error(d.message ?? '讀取失敗')
      setRoles(d.roles); onChanged(d.roles)
      const key = select ?? (d.roles.some(x => x.key === cur) ? cur : d.roles[1]?.key ?? d.roles[0]?.key ?? '')
      setCur(key); setCreating(false)
      const role = d.roles.find(x => x.key === key)
      if (role) setDraft({ label: role.label, color: role.color, perms: { ...role.perms } })
    } catch (e) { setMsg({ ok: false, text: `讀取角色失敗：${(e as Error).message}` }) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const role = roles.find(r => r.key === cur)
  const fixed = !creating && !!role?.fixed
  const custom = creating || (!!role && !role.builtin)
  const groups = useMemo(() => Array.from(new Set(pageMeta.map(p => p.group))), [pageMeta])
  const dirty = !!draft && (creating || (!!role && (draft.label !== role.label || draft.color !== role.color || pageMeta.some(p => !!draft.perms[p.key] !== !!role.perms[p.key]))))
  const visible = roles.filter(r => !search.trim() || r.label.toLowerCase().includes(search.trim().toLowerCase()))

  function pick(key: string) {
    if (dirty && !confirm('有尚未儲存的變更，要放棄嗎？')) return
    const r = roles.find(x => x.key === key)
    setCur(key); setCreating(false); setMsg(null); setNameError(false)
    if (r) setDraft({ label: r.label, color: r.color, perms: { ...r.perms } })
  }
  function resetDraft() {
    if (creating) { setCreating(false); const first = roles.find(x => !x.fixed) ?? roles[0]; if (first) { setCur(first.key); setDraft({ label: first.label, color: first.color, perms: { ...first.perms } }) }; return }
    if (role) setDraft({ label: role.label, color: role.color, perms: { ...role.perms } })
  }
  function startCreate() {
    if (dirty && !confirm('有尚未儲存的變更，要放棄嗎？')) return
    setCreating(true); setCur(''); setMsg(null); setNameError(false)
    setDraft({ label: '', color: COLORS[4], perms: {} })
  }

  /** 回應一律解成 { ok, message }：不是 JSON（代理錯誤頁、逾時）也要變成看得到的錯誤，不能安靜吞掉（使用者 10/05：按了建立角色什麼都沒發生） */
  async function readJson<T extends { ok: boolean; message?: string }>(r: Response): Promise<T> {
    const text = await r.text()
    try { return JSON.parse(text) as T } catch { return { ok: false, message: `伺服器回應看不懂（HTTP ${r.status}）${text ? '：' + text.slice(0, 120) : ''}` } as T }
  }

  async function save() {
    if (!draft) return
    if (!draft.label.trim()) {
      setNameError(true); setMsg({ ok: false, text: '請先填角色名稱' })
      nameRef.current?.focus()
      return
    }
    setBusy(true); setMsg(null)
    try {
      const body = { label: draft.label, color: draft.color, perms: Object.fromEntries(pageMeta.map(p => [p.key, !!draft.perms[p.key]])) }
      const r = creating
        ? await fetch('/api/admin/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch(`/api/admin/roles/${encodeURIComponent(cur)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(role?.builtin ? { color: body.color, perms: body.perms } : body) })
      const d = await readJson<{ ok: boolean; message?: string; role?: { key: string } }>(r)
      if (!d.ok) { setMsg({ ok: false, text: `${creating ? '建立' : '儲存'}失敗：${d.message ?? `HTTP ${r.status}`}` }); return }
      setMsg({ ok: true, text: creating ? '已新增角色' : '已儲存' })
      await load(creating ? d.role?.key : cur)
    } catch (e) {
      setMsg({ ok: false, text: `${creating ? '建立' : '儲存'}失敗（連不到伺服器）：${(e as Error).message}` })
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!role || !confirm(`確認刪除角色「${role.label}」？`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`/api/admin/roles/${encodeURIComponent(role.key)}`, { method: 'DELETE' })
      const d = await readJson<{ ok: boolean; message?: string; users?: string[] }>(r)
      if (!d.ok) { setMsg({ ok: false, text: d.message ?? `刪除失敗（HTTP ${r.status}）`, users: d.users }); return }
      setMsg({ ok: true, text: `已刪除「${role.label}」` })
      await load(roles.find(x => x.key !== role.key && !x.fixed)?.key)
    } catch (e) {
      setMsg({ ok: false, text: `刪除失敗（連不到伺服器）：${(e as Error).message}` })
    } finally { setBusy(false) }
  }

  const card: React.CSSProperties = { background: '#10182a', border: '1px solid #2d3f55', borderRadius: 12, padding: 16 }
  const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #2d3f55', fontSize: 13, background: '#0f172a', color: '#e2e8f0', outline: 'none', minWidth: 0 }
  const btn: React.CSSProperties = { padding: '7px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0, border: '1px solid #2d3f55', background: '#1e293b', color: '#cbd5e1' }
  const btnPrimary: React.CSSProperties = { ...btn, background: '#6366f1', border: '1px solid #6366f1', color: '#fff', fontWeight: 600 }
  const tag = (r: RoleInfo) => r.fixed
    ? <span className="rm-tag" style={{ fontSize: 11, padding: '1px 7px', borderRadius: 99, border: '1px solid rgba(245,183,59,.5)', color: '#f5b73b', whiteSpace: 'nowrap' }}>固定</span>
    : r.builtin
      ? <span className="rm-tag" style={{ fontSize: 11, padding: '1px 7px', borderRadius: 99, border: '1px solid #2d3f55', color: '#94a3b8', whiteSpace: 'nowrap' }}>內建</span>
      : <span className="rm-tag" style={{ fontSize: 11, padding: '1px 7px', borderRadius: 99, border: '1px solid #6366f1', color: '#a5b4fc', whiteSpace: 'nowrap' }}>自訂</span>

  if (loading && !roles.length) return <div style={card}><p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>載入中…</p></div>

  return (
    <div className="role-manager" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 14, alignItems: 'start' }}>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input style={{ ...input, flex: 1 }} placeholder="搜尋角色" value={search} onChange={e => setSearch(e.target.value)} aria-label="搜尋角色" />
          <button type="button" style={btnPrimary} onClick={startCreate}>＋ 新增</button>
        </div>
        {visible.map(r => (
          <button key={r.key} type="button" onClick={() => pick(r.key)} aria-pressed={r.key === cur && !creating}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', marginBottom: 4, borderRadius: 8, cursor: 'pointer', textAlign: 'left', color: '#e2e8f0', fontSize: 13,
              background: r.key === cur && !creating ? 'rgba(99,102,241,.14)' : 'transparent', border: `1px solid ${r.key === cur && !creating ? '#4f46e5' : 'transparent'}` }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>{r.users.length} 人</span>
            {tag(r)}
          </button>
        ))}
        {creating && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, background: 'rgba(99,102,241,.14)', border: '1px solid #4f46e5', fontSize: 13 }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: draft?.color }} /><span style={{ fontWeight: 600 }}>{draft?.label || '（新角色）'}</span>
          </div>
        )}
      </div>

      {draft && (creating || role) && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ width: 16, height: 16, borderRadius: '50%', background: draft.color }} />
            <h2 style={{ margin: 0, fontSize: 17, color: '#e2e8f0' }}>{creating ? '新增角色' : role!.label}</h2>
            {!creating && tag(role!)}
          </div>
          {fixed && <div style={{ border: '1px solid rgba(245,183,59,.45)', background: 'rgba(245,183,59,.08)', color: '#f5b73b', borderRadius: 8, padding: '9px 12px', marginBottom: 12, fontSize: 12.5 }}>管理員固定擁有所有功能，不能修改或刪除（避免把自己鎖在系統外）。</div>}

          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginBottom: 14, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#94a3b8' }}>名稱
              <input ref={nameRef} style={{ ...input, width: 220, ...(nameError ? { borderColor: '#f87171', boxShadow: '0 0 0 2px rgba(248,113,113,.25)' } : {}) }} value={draft.label} disabled={!custom} maxLength={20}
                aria-invalid={nameError || undefined}
                onChange={e => { const v = e.target.value; setDraft(d => d && ({ ...d, label: v })); if (v.trim()) { setNameError(false); setMsg(m => (m && !m.ok && m.text === '請先填角色名稱' ? null : m)) } }} placeholder="例如：測試協力" />
              {nameError && <span style={{ color: '#f87171', fontSize: 11.5 }}>名稱必填</span>}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#94a3b8' }}>顏色
              <div style={{ display: 'flex', gap: 6 }}>
                {COLORS.map(c => (
                  <button key={c} type="button" aria-label={`顏色 ${c}`} aria-pressed={draft.color === c} disabled={fixed}
                    onClick={() => setDraft(d => d && ({ ...d, color: c }))}
                    style={{ width: 24, height: 24, borderRadius: 6, background: c, cursor: fixed ? 'not-allowed' : 'pointer', border: `2px solid ${draft.color === c ? '#e2e8f0' : 'transparent'}`, padding: 0 }} />
                ))}
              </div>
            </div>
            {!custom && !fixed && <span style={{ fontSize: 12, color: '#64748b' }}>內建角色這一版不能改名、刪除；顏色與可見功能可以改</span>}
          </div>

          {groups.map(g => (
            <div key={g} style={{ marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 6px', fontSize: 12, color: '#64748b', letterSpacing: '.5px' }}>{g}</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
                {pageMeta.filter(p => p.group === g).map(p => {
                  const on = fixed || !!draft.perms[p.key]
                  return (
                    <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, fontSize: 13, color: '#cbd5e1', cursor: fixed ? 'not-allowed' : 'pointer',
                      background: '#0f172a', border: `1px solid ${on ? '#4f46e5' : '#1e293b'}` }}>
                      <input type="checkbox" checked={on} disabled={fixed} onChange={e => setDraft(d => d && ({ ...d, perms: { ...d.perms, [p.key]: e.target.checked } }))} />
                      {p.label}
                    </label>
                  )
                })}
              </div>
            </div>
          ))}

          {!creating && role && (
            <div style={{ marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 6px', fontSize: 12, color: '#64748b' }}>使用這個角色的帳號（{role.users.length}）</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {role.users.map(u => <span key={u} style={{ padding: '2px 8px', borderRadius: 6, background: '#0f172a', border: '1px solid #1e293b', fontSize: 12, color: '#cbd5e1' }}>{u}</span>)}
                {!role.users.length && <span style={{ fontSize: 12, color: '#64748b' }}>沒有帳號使用</span>}
              </div>
              <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>ⓘ 帳號在「帳號管理」單獨加減的權限（個人覆寫）不在這裡，那邊會標「＋覆寫」</p>
            </div>
          )}

          {msg && (
            <div style={{ border: `1px solid ${msg.ok ? 'rgba(63,208,127,.45)' : 'rgba(242,107,107,.45)'}`, background: msg.ok ? 'rgba(63,208,127,.08)' : 'rgba(242,107,107,.08)', color: msg.ok ? '#4ade80' : '#f87171', borderRadius: 8, padding: '9px 12px', marginBottom: 12, fontSize: 12.5 }}>
              {msg.text}{msg.users?.length ? `（${msg.users.join('、')}）` : ''}
              {msg.users?.length ? <> <button type="button" onClick={onGoAccounts} style={{ background: 'none', border: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0 }}>前往帳號管理 →</button></> : null}
            </div>
          )}

          {!fixed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid #1e293b', paddingTop: 12 }}>
              <span style={{ flex: 1, fontSize: 12, color: '#64748b' }}>{dirty ? '尚未儲存變更' : '設定已是最新'}</span>
              {custom && !creating && <button type="button" style={{ ...btn, color: '#f87171', borderColor: 'rgba(239,68,68,.4)', background: 'rgba(239,68,68,.08)' }} onClick={() => void remove()} disabled={busy}>刪除角色</button>}
              <button type="button" style={btn} disabled={busy || !dirty} onClick={resetDraft}>取消</button>
              <button type="button" style={btnPrimary} disabled={busy || !dirty} onClick={() => void save()}>{busy ? '儲存中…' : creating ? '建立角色' : '儲存'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

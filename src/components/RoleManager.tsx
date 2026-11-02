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

  // 新版（原型 v7）：左「角色」面板（搜尋＋新增上下疊、角色卡片）、右邊編輯面板（標籤在左、權限是一行一個勾選、按鈕在右下）。樣式在 redesign/pages/settings.css
  const tag = (r: RoleInfo) => r.fixed
    ? <span className="rm-tag rm-tag--fixed">固定</span>
    : r.builtin
      ? <span className="rm-tag">內建</span>
      : <span className="rm-tag rm-tag--custom">自訂</span>

  if (loading && !roles.length) return <section className="section-card"><p className="st-dim" style={{ margin: 0 }}>載入中…</p></section>

  return (
    <div className="role-manager">
      <section className="section-card st-card rm-list">
        <h2 className="section-title">角色</h2>
        <div className="rm-list-tools">
          <input className="lst-field" placeholder="搜尋角色" value={search} onChange={e => setSearch(e.target.value)} aria-label="搜尋角色" />
          <button type="button" className="btn-ghost lst-btn" onClick={startCreate}>＋ 新增</button>
        </div>
        <div className="rm-cards">
          {visible.map(r => (
            <button key={r.key} type="button" className="rm-role" onClick={() => pick(r.key)} aria-pressed={r.key === cur && !creating}>
              <span className="rm-role-h">
                <span className="rm-dot" style={{ background: r.color }} />
                <span className="rm-role-name">{r.label}</span>
                {tag(r)}
              </span>
              <span className="rm-role-n">{r.users.length} 人</span>
            </button>
          ))}
          {creating && (
            <div className="rm-role is-on">
              <span className="rm-role-h">
                <span className="rm-dot" style={{ background: draft?.color }} />
                <span className="rm-role-name">{draft?.label || '（新角色）'}</span>
              </span>
            </div>
          )}
        </div>
      </section>

      {draft && (creating || role) && (
        <section className="section-card st-card rm-edit">
          <h2 className="section-title">
            <span className="rm-dot" style={{ background: draft.color }} />
            {creating ? '新增角色' : role!.label}
            {!creating && tag(role!)}
          </h2>
          {fixed && <div className="lst-note lst-note--warn rm-gap">管理員固定擁有所有功能，不能修改或刪除（避免把自己鎖在系統外）。</div>}

          <div className="st-form">
            <label className="st-l" htmlFor="rm-name">名稱</label>
            <div className="st-cell">
              <input id="rm-name" ref={nameRef} className={`lst-field rm-name${nameError ? ' is-invalid' : ''}`} value={draft.label} disabled={!custom} maxLength={20}
                aria-invalid={nameError || undefined}
                onChange={e => { const v = e.target.value; setDraft(d => d && ({ ...d, label: v })); if (v.trim()) { setNameError(false); setMsg(m => (m && !m.ok && m.text === '請先填角色名稱' ? null : m)) } }} placeholder="例如：測試協力" />
              {nameError && <span className="rm-err">名稱必填</span>}
            </div>
            <span className="st-l">顏色</span>
            <div className="st-inline">
              <div className="rm-colors">
                {COLORS.map(c => (
                  <button key={c} type="button" className="rm-color" aria-label={`顏色 ${c}`} aria-pressed={draft.color === c} disabled={fixed}
                    onClick={() => setDraft(d => d && ({ ...d, color: c }))}
                    style={{ background: c }} />
                ))}
              </div>
              {!custom && !fixed && <span className="st-hint rm-builtin-note">內建角色這一版不能改名、刪除；顏色與可見功能可以改</span>}
            </div>
          </div>

          {groups.map(g => (
            <div key={g} className="rm-group">
              <h4 className="rm-group-h">{g}</h4>
              <div className="rm-perms">
                {pageMeta.filter(p => p.group === g).map(p => {
                  const on = fixed || !!draft.perms[p.key]
                  return (
                    <label key={p.key} className="st-chk">
                      <input type="checkbox" checked={on} disabled={fixed} onChange={e => setDraft(d => d && ({ ...d, perms: { ...d.perms, [p.key]: e.target.checked } }))} />
                      {p.label}
                    </label>
                  )
                })}
              </div>
            </div>
          ))}

          {!creating && role && (
            <div className="rm-group">
              <h4 className="rm-group-h">使用這個角色的帳號（{role.users.length}）</h4>
              <div className="lst-tags">
                {role.users.map(u => <span key={u} className="lst-tag">{u}</span>)}
                {!role.users.length && <span className="st-dim">沒有帳號使用</span>}
              </div>
              <p className="st-hint">ⓘ 帳號在「帳號管理」單獨加減的權限（個人覆寫）不在這裡，那邊會標「＋覆寫」</p>
            </div>
          )}

          {msg && (
            <div className={`lst-note ${msg.ok ? 'lst-note--ok' : 'lst-note--bad'} rm-gap`}>
              {msg.text}{msg.users?.length ? `（${msg.users.join('、')}）` : ''}
              {msg.users?.length ? <> <button type="button" className="lst-link rm-go" onClick={onGoAccounts}>前往帳號管理 →</button></> : null}
            </div>
          )}

          {!fixed && (
            <div className="st-actions st-actions--bar">
              <span className="st-dim st-grow">{dirty ? '尚未儲存變更' : '設定已是最新'}</span>
              {custom && !creating && <button type="button" className="btn-ghost lst-btn st-btn--danger" onClick={() => void remove()} disabled={busy}>刪除角色</button>}
              <button type="button" className="btn-ghost lst-btn" disabled={busy || !dirty} onClick={resetDraft}>取消</button>
              <button type="button" className="submit-btn lst-btn" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '儲存中…' : creating ? '建立角色' : '儲存'}</button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

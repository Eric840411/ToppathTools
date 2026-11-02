import { useEffect, useState } from 'react'

/**
 * 系統管理 → Meegle 身分對照。
 * 給「工具登入 email 跟 Meegle email 不同」的人用：管理員把登入 email 對到某個 Meegle user_key，
 * 那個人才能綁定。user_key 從使用者綁定失敗時的錯誤訊息拿（畫面會顯示）。
 * 這裡看得到每個人的綁定狀態，但**看不到也拿不到任何人的 token**。
 */

type Override = { login_email: string; meegle_user_key: string; note: string; created_by: string; created_at: number }
type BindingRow = { email: string; meegle_name: string; meegle_email: string; meegle_user_key: string; status: string; last_verified_at: number | null; last_check_code: string | null }

const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false }) : '—')

export function MeegleIdentityOverridesPanel() {
  const [overrides, setOverrides] = useState<Override[]>([])
  const [bindings, setBindings] = useState<BindingRow[]>([])
  const [loginEmail, setLoginEmail] = useState('')
  const [userKey, setUserKey] = useState('')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const d = await (await fetch('/api/admin/meegle-identity-overrides')).json()
      if (!d.ok) { setMsg({ ok: false, text: d.message ?? '讀取失敗' }); return }
      setOverrides(d.overrides ?? []); setBindings(d.bindings ?? [])
    } catch { setMsg({ ok: false, text: '讀取 Meegle 身分對照失敗' }) }
  }
  useEffect(() => { load() }, [])

  async function save() {
    setBusy(true); setMsg(null)
    try {
      const d = await (await fetch('/api/admin/meegle-identity-overrides', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginEmail: loginEmail.trim(), meegleUserKey: userKey.trim(), note: note.trim() }),
      })).json()
      if (!d.ok) { setMsg({ ok: false, text: d.message ?? '儲存失敗' }); return }
      setLoginEmail(''); setUserKey(''); setNote('')
      setMsg({ ok: true, text: '已儲存對照，請那位使用者重新按「驗證並綁定」' })
      await load()
    } catch { setMsg({ ok: false, text: '儲存失敗' }) } finally { setBusy(false) }
  }

  async function remove(email: string) {
    setBusy(true); setMsg(null)
    try {
      const d = await (await fetch(`/api/admin/meegle-identity-overrides/${encodeURIComponent(email)}`, { method: 'DELETE' })).json()
      if (!d.ok) { setMsg({ ok: false, text: d.message ?? '刪除失敗' }); return }
      await load()
    } catch { setMsg({ ok: false, text: '刪除失敗' }) } finally { setBusy(false) }
  }

  // 新版（原型 v7）：一塊「標題帶＋說明＋工具列＋兩張表」面板，樣式在 redesign/pages/settings.css
  return (
    <section className="section-card st-card st-raw">
      <h2 className="section-title">Meegle 綁定與身分對照</h2>
      <p className="st-note st-pad">
        使用者在「個人帳號」貼自己的 Meegle token 綁定，工具會用 <b>email 比對</b>確認是本人。
        email 不同的人會被擋下，畫面上會顯示他的 Meegle user_key——把它填到下面建立對照，他就能綁定。
        <b>對照只影響「新的綁定」</b>，刪除對照不會解除已經綁好的人。這裡看不到任何人的 token。
      </p>

      <div className="lst-toolbar st-toolbar-top">
        <input className="lst-field st-w220" placeholder="工具登入 email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} />
        <span className="st-dim">對到 Meegle user_key</span>
        <input className="lst-field st-w200" placeholder="例如 7399589791446188037" value={userKey} onChange={e => setUserKey(e.target.value)} />
        <input className="lst-field st-w180" placeholder="備註（選填）" value={note} onChange={e => setNote(e.target.value)} />
        <button type="button" className="btn-ghost lst-btn" onClick={save} disabled={busy || !loginEmail.trim() || !userKey.trim()}>新增對照</button>
        {msg && <span className={msg.ok ? 'st-msg-ok' : 'st-msg-err'}>{msg.text}</span>}
      </div>

      <div className="table-wrap lst-tbl st-tbl-gap">
        <table className="version-table st-tbl">
          <thead><tr><th>登入 email</th><th>Meegle user_key</th><th>備註</th><th>建立者</th><th></th></tr></thead>
          <tbody>
            {overrides.map(o => (
              <tr key={o.login_email}>
                <td className="lst-mono-sm">{o.login_email}</td>
                <td className="lst-mono-sm">{o.meegle_user_key}</td>
                <td>{o.note || '—'}</td>
                <td>{o.created_by} · {fmt(o.created_at)}</td>
                <td><button type="button" className="lst-link st-link--danger" onClick={() => remove(o.login_email)} disabled={busy}>刪除</button></td>
              </tr>
            ))}
            {overrides.length === 0 && <tr><td colSpan={5} className="lst-empty">尚無對照（email 相同的人不需要）</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="table-wrap lst-tbl">
        <table className="version-table st-tbl">
          <thead><tr><th>已綁定的帳號</th><th>Meegle 身分</th><th>狀態</th><th>最後成功驗證</th></tr></thead>
          <tbody>
            {bindings.map(b => (
              <tr key={b.email}>
                <td className="lst-mono-sm">{b.email}</td>
                <td>{b.meegle_name || '—'} <span className="st-dim">{b.meegle_email}</span></td>
                <td>
                  <span className={b.status === 'valid' ? 'lst-pill lst-pill--pass' : 'lst-pill lst-pill--fail'}>{b.status === 'valid' ? '有效' : '已失效'}</span>
                  {b.last_check_code && b.status === 'valid' && <span style={{ color: '#fbbf24', fontSize: 11 }}>（上次驗證未完成）</span>}
                </td>
                <td>{fmt(b.last_verified_at)}</td>
              </tr>
            ))}
            {bindings.length === 0 && <tr><td colSpan={4} className="lst-empty">還沒有人綁定</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

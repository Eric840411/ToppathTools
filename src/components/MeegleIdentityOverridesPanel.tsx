import { useEffect, useState } from 'react'

/**
 * 系統管理 → Meegle 身分對照。
 * 給「工具登入 email 跟 Meegle email 不同」的人用：管理員把登入 email 對到某個 Meegle user_key，
 * 那個人才能綁定。user_key 從使用者綁定失敗時的錯誤訊息拿（畫面會顯示）。
 * 這裡看得到每個人的綁定狀態，但**看不到也拿不到任何人的 token**。
 */

type Override = { login_email: string; meegle_user_key: string; note: string; created_by: string; created_at: number }
type BindingRow = { email: string; meegle_name: string; meegle_email: string; meegle_user_key: string; status: string; last_verified_at: number | null; last_check_code: string | null }

const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, background: '#162032', borderBottom: '2px solid #2d3f55', color: '#94a3b8', fontSize: 13 }
const td: React.CSSProperties = { padding: '9px 16px', borderBottom: '1px solid #1e293b', textAlign: 'left', fontSize: 13 }
const input: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, border: '1px solid #2d3f55', fontSize: 13, outline: 'none', background: '#0f172a', color: '#e2e8f0' }
const btn: React.CSSProperties = { padding: '7px 14px', background: '#1e293b', color: '#94a3b8', border: '1px solid #2d3f55', borderRadius: 6, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
const btnDanger: React.CSSProperties = { ...btn, color: '#f87171', borderColor: 'rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.1)' }
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

  return (
    <div style={{ borderTop: '1px solid #2d3f55', marginTop: 24, paddingTop: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: '0 0 4px' }}>Meegle 綁定與身分對照</h3>
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 14px', lineHeight: 1.7 }}>
        使用者在「個人帳號」貼自己的 Meegle token 綁定，工具會用 <b>email 比對</b>確認是本人。
        email 不同的人會被擋下，畫面上會顯示他的 Meegle user_key——把它填到下面建立對照，他就能綁定。
        <b>對照只影響「新的綁定」</b>，刪除對照不會解除已經綁好的人。這裡看不到任何人的 token。
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input style={{ ...input, width: 220 }} placeholder="工具登入 email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} />
        <span style={{ color: '#64748b', fontSize: 12 }}>對到 Meegle user_key</span>
        <input style={{ ...input, width: 200 }} placeholder="例如 7399589791446188037" value={userKey} onChange={e => setUserKey(e.target.value)} />
        <input style={{ ...input, width: 180 }} placeholder="備註（選填）" value={note} onChange={e => setNote(e.target.value)} />
        <button type="button" style={btn} onClick={save} disabled={busy || !loginEmail.trim() || !userKey.trim()}>新增對照</button>
      </div>
      {msg && <p style={{ fontSize: 12, margin: '0 0 12px', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
        <thead><tr><th style={th}>登入 email</th><th style={th}>Meegle user_key</th><th style={th}>備註</th><th style={th}>建立者</th><th style={th}></th></tr></thead>
        <tbody>
          {overrides.map(o => (
            <tr key={o.login_email}>
              <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{o.login_email}</td>
              <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{o.meegle_user_key}</td>
              <td style={td}>{o.note || '—'}</td>
              <td style={{ ...td, color: '#94a3b8' }}>{o.created_by} · {fmt(o.created_at)}</td>
              <td style={td}><button type="button" style={btnDanger} onClick={() => remove(o.login_email)} disabled={busy}>刪除</button></td>
            </tr>
          ))}
          {overrides.length === 0 && <tr><td colSpan={5} style={{ ...td, color: '#94a3b8', textAlign: 'center', padding: 20 }}>尚無對照（email 相同的人不需要）</td></tr>}
        </tbody>
      </table>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>已綁定的帳號</th><th style={th}>Meegle 身分</th><th style={th}>狀態</th><th style={th}>最後成功驗證</th></tr></thead>
        <tbody>
          {bindings.map(b => (
            <tr key={b.email}>
              <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{b.email}</td>
              <td style={td}>{b.meegle_name || '—'} <span style={{ color: '#64748b', fontSize: 11 }}>{b.meegle_email}</span></td>
              <td style={{ ...td, color: b.status === 'valid' ? '#4ade80' : '#f87171' }}>
                {b.status === 'valid' ? '有效' : '已失效'}
                {b.last_check_code && b.status === 'valid' && <span style={{ color: '#fbbf24', fontSize: 11 }}>（上次驗證未完成）</span>}
              </td>
              <td style={{ ...td, color: '#94a3b8' }}>{fmt(b.last_verified_at)}</td>
            </tr>
          ))}
          {bindings.length === 0 && <tr><td colSpan={4} style={{ ...td, color: '#94a3b8', textAlign: 'center', padding: 20 }}>還沒有人綁定</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

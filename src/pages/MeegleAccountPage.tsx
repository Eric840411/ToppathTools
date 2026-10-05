import { useEffect, useState } from 'react'
import './MeegleAccountPage.css'

type Binding = {
  status: 'valid' | 'invalid'
  meegleName: string
  meegleEmail: string
  meegleUserKey: string
  boundAt: number
  lastVerifiedAt: number | null
  lastCheckedAt: number | null
  lastCheckCode: string | null
  lastCheckReason: string | null
}

type ApiError = { code?: string; message?: string; meegleEmail?: string; meegleName?: string; meegleUserKey?: string }

const fmtTime = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false }) : '—')

/** 暫時性的驗證失敗（連不上／逾時）——綁定狀態沒變，只是這次沒驗成 */
const TRANSIENT = new Set(['UNAVAILABLE', 'UNEXPECTED', 'CLI_MISSING'])

/** onBack：從 Meegle 批量工具的綁定引導過來時才有，顯示「回到 Meegle 批量工具」（那邊的畫面保持掛載，草稿還在） */
export function MeegleAccountPage({ themeMode, onBack }: { themeMode?: 'classic' | 'xianxia'; onBack?: () => void }) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [keyConfigured, setKeyConfigured] = useState(true)
  const [loginEmail, setLoginEmail] = useState('')
  const [binding, setBinding] = useState<Binding | null>(null)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'' | 'bind' | 'verify' | 'unbind'>('')
  const [error, setError] = useState<ApiError | null>(null)
  const [notice, setNotice] = useState('')
  const [confirmUnbind, setConfirmUnbind] = useState(false)

  async function load() {
    setLoading(true); setLoadError('')
    try {
      const r = await fetch('/api/meegle/account')
      const d = await r.json()
      if (!d.ok) { setLoadError(d.message ?? '讀取失敗'); return }
      setKeyConfigured(!!d.keyConfigured)
      setLoginEmail(d.loginEmail ?? '')
      setBinding(d.binding ?? null)
    } catch {
      setLoadError('讀取綁定狀態失敗，請重新整理')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function call(kind: 'bind' | 'verify' | 'unbind') {
    setBusy(kind); setError(null); setNotice(''); setConfirmUnbind(false)
    try {
      const r = kind === 'bind'
        ? await fetch('/api/meegle/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
        : kind === 'verify'
          ? await fetch('/api/meegle/account/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          : await fetch('/api/meegle/account', { method: 'DELETE' })
      const d = await r.json().catch(() => ({ ok: false, message: `伺服器回應 ${r.status}` }))
      if (!d.ok) { setError(d); return }
      setBinding(d.binding ?? null)
      if (kind === 'bind') {
        setToken(''); setShowToken(false); setEditing(false)
        setNotice('綁定成功，token 已加密保存。畫面不會再顯示 token。')
      } else if (kind === 'verify') {
        const b = d.binding as Binding | null
        setNotice(b?.lastCheckCode ? '' : '驗證成功，token 仍然有效。')
      } else {
        setNotice('已解除綁定，本站存的 token 已刪除。要讓這組 token 作廢，請到 Meegle 按「重置 Token」。')
      }
    } catch {
      setError({ message: '網路錯誤，請稍後再試' })
    } finally { setBusy('') }
  }

  const xianxia = themeMode === 'xianxia'
  const state: 'unbound' | 'valid' | 'invalid' = binding ? binding.status : 'unbound'
  const pillText = state === 'unbound' ? '未綁定' : state === 'valid' ? '有效' : '已失效'
  const showInput = state !== 'valid' || editing
  const transientCheck = binding?.lastCheckCode && TRANSIENT.has(binding.lastCheckCode)

  return (
    <div className="mg-page">
      <section className="mg-card">
        <div className="mg-card-head">
          <div>
            <h2 className="mg-title">{xianxia ? 'Meegle 靈契' : 'Meegle 個人綁定'}</h2>
            <div className="mg-subtitle">Meegle 個人綁定</div>
          </div>
          {!loading && <span className={`mg-pill mg-pill--${state}`}>{pillText}</span>}
        </div>

        {onBack && (
          <div className={`mg-alert ${binding?.status === 'valid' ? 'mg-alert--ok' : 'mg-alert--warn'}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{binding?.status === 'valid' ? '綁定完成，可以回到 Meegle 批量工具繼續了。' : '你是從 Meegle 批量工具過來的，綁定好之後按右邊回去，剛剛的畫面還在。'}</span>
            <button type="button" className="mg-btn mg-btn--primary" onClick={onBack}>回到 Meegle 批量工具 →</button>
          </div>
        )}
        {loading && <p className="mg-mono">讀取中…</p>}
        {loadError && <div className="mg-alert mg-alert--bad">{loadError}</div>}

        {!loading && !loadError && (
          <>
            {!keyConfigured && (
              <div className="mg-alert mg-alert--warn">
                <strong>伺服器尚未設定加密金鑰（MEEGLE_TOKEN_KEY）</strong>，暫時無法綁定或驗證。請聯絡管理員。
              </div>
            )}

            <dl className="mg-rows">
              <dt>登入帳號</dt><dd>{loginEmail || '—'}</dd>
              <dt>Meegle 身分</dt>
              <dd>
                {binding
                  ? <>{binding.meegleName || '（未提供姓名）'}{binding.meegleEmail && <> · {binding.meegleEmail}</>} <span className="mg-mono">user_key {binding.meegleUserKey}</span></>
                  : '—'}
              </dd>
              <dt>最後成功驗證</dt><dd>{fmtTime(binding?.lastVerifiedAt ?? null)}</dd>
            </dl>

            {state === 'invalid' && (
              <div className="mg-alert mg-alert--bad">
                <strong>這組 token 已經不能用了。</strong>{binding?.lastCheckReason ? `原因：${binding.lastCheckReason}。` : ''}
                請到 Meegle 複製新的 token 更新綁定。在更新之前，用你身分進行的 Meegle 操作都會失敗。
              </div>
            )}

            {state !== 'unbound' && transientCheck && (
              <div className="mg-alert mg-alert--warn">
                {fmtTime(binding!.lastCheckedAt)} 那次驗證<strong>沒有完成</strong>（{binding!.lastCheckReason ?? binding!.lastCheckCode}）。
                這不代表 token 失效，綁定狀態維持不變，可以稍後再按「重新驗證」。
              </div>
            )}

            {error && (
              <div className="mg-alert mg-alert--bad">
                {error.code === 'IDENTITY_MISMATCH' ? (
                  <>
                    <strong>這組 token 不是你的。</strong>{error.message}
                    {error.meegleUserKey && (
                      <> 如果這確實是你的 Meegle 帳號（只是 email 不同），請把這串 user_key 給管理員建立對照：<span className="mg-mono">{error.meegleUserKey}</span></>
                    )}
                  </>
                ) : error.code === 'TOKEN_INVALID' ? (
                  <><strong>Meegle 不接受這組 token。</strong>請確認複製的是「HTTP Header」分頁裡的 Token，而且沒有被重置過。</>
                ) : error.code === 'UNAVAILABLE' ? (
                  <><strong>暫時連不上 Meegle，這次沒有驗證成功。</strong>原本的綁定沒有被改動，請稍後再試。<span className="mg-mono">（{error.message}）</span></>
                ) : (
                  <>{error.message ?? '操作失敗'}</>
                )}
              </div>
            )}
            {notice && <div className="mg-alert mg-alert--ok">{notice}</div>}

            {showInput && (
              <div className="mg-field">
                <label htmlFor="mg-token">{state === 'unbound' ? '個人 Token' : '新的個人 Token'}</label>
                <div className="mg-input-row">
                  <input
                    id="mg-token" className="mg-input" type={showToken ? 'text' : 'password'} autoComplete="off" spellCheck={false}
                    placeholder="貼上從 Meegle 複製的 Token" value={token} onChange={e => setToken(e.target.value)}
                    disabled={!keyConfigured || !!busy}
                  />
                  <button type="button" className="mg-btn mg-btn--small" onClick={() => setShowToken(v => !v)} disabled={!token}>
                    {showToken ? '隱藏' : '顯示'}
                  </button>
                </div>
              </div>
            )}

            <div className="mg-actions">
              {showInput && (
                <button type="button" className="mg-btn mg-btn--primary" onClick={() => call('bind')} disabled={!keyConfigured || !token.trim() || !!busy}>
                  {busy === 'bind' ? '驗證中…' : state === 'unbound' ? '驗證並綁定' : '驗證並更新'}
                </button>
              )}
              {state === 'valid' && editing && (
                <button type="button" className="mg-btn" onClick={() => { setEditing(false); setToken('') }} disabled={!!busy}>取消更換</button>
              )}
              {state !== 'unbound' && (
                <button type="button" className="mg-btn" onClick={() => call('verify')} disabled={!keyConfigured || !!busy}>
                  {busy === 'verify' ? '驗證中…' : '重新驗證'}
                </button>
              )}
              {state === 'valid' && !editing && (
                <button type="button" className="mg-btn" onClick={() => { setEditing(true); setNotice(''); setError(null) }} disabled={!!busy}>更換 token</button>
              )}
              {state !== 'unbound' && !confirmUnbind && (
                <button type="button" className="mg-btn mg-btn--danger" onClick={() => setConfirmUnbind(true)} disabled={!!busy}>解除綁定</button>
              )}
            </div>
            {confirmUnbind && (
              <div className="mg-confirm">
                確定解除？解除後用你身分進行的 Meegle 操作都會失敗。
                <button type="button" className="mg-btn mg-btn--danger mg-btn--small" onClick={() => call('unbind')} disabled={!!busy}>
                  {busy === 'unbind' ? '解除中…' : '確定解除'}
                </button>
                <button type="button" className="mg-btn mg-btn--small" onClick={() => setConfirmUnbind(false)} disabled={!!busy}>取消</button>
              </div>
            )}
          </>
        )}
      </section>

      <aside className="mg-card mg-help">
        <h3>如何取得 Token</h3>
        <ol className="mg-steps">
          <li>在 Lark 開啟 <strong>Meegle</strong></li>
          <li>首頁「MCP &amp; CLI」卡片 → <strong>MCP 設定</strong></li>
          <li>切到 <code>HTTP Header</code> 分頁</li>
          <li>按「<strong>複製 Token</strong>」，貼到左邊</li>
        </ol>
        <ul className="mg-notes">
          <li>這組 token <strong>等同你的 Meegle 身分</strong>，而且長期有效。不要貼到聊天室或分享給別人。</li>
          <li>token 在本站<strong>加密保存</strong>，綁定後畫面不會再顯示。</li>
          <li><strong>解除綁定只刪除本站存的 token。</strong>要讓 token 真正作廢，需到 Meegle 同一頁按「重置 Token」。</li>
          <li>重置後舊 token 立刻失效，請把新的貼回來更新綁定。</li>
          <li>工具只接受<strong>你本人</strong>的 token（以 email 比對）。email 不同的情況請找管理員建立對照。</li>
        </ul>
      </aside>
    </div>
  )
}

/**
 * Lark 通知設定（Discord → Lark 遷移，使用者 2026-10-03；版面照 CodeX 設計稿）。
 * 四塊：機器人憑證／目標群組＋試發／各功能通知出口／@人對照狀態，底部統一「取消／儲存設定」。
 *
 * - Secret 只寫不讀：畫面只顯示尾碼，欄位留空＝保留原值（後端也是這樣處理）
 * - 整頁只有管理員能用，後端每支 API 都會檢查
 * - 試發／重新整理群組不需要先存（用目前欄位的值），但「驗證憑證」驗的是欄位上的值；Secret 沒重填就驗已存的
 */
import { useEffect, useMemo, useState } from 'react'
import './LarkNotifySettingsPage.css'

type Outlet = 'discord' | 'lark' | 'both'
type Config = { appId: string; hasSecret: boolean; secretTail: string; keyConfigured: boolean; chatId: string; toolUrl: string }
type Feature = { key: string; label: string }
type MentionRow = { label: string; email: string; status: 'mapped' | 'not_found' | 'unknown' }
type Msg = { ok: boolean; text: string } | null


async function api<T>(method: string, url: string, body?: unknown): Promise<T & { ok: boolean; message?: string }> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({ ok: false, message: `伺服器回 ${r.status}` }))
  return j
}

export function LarkNotifySettingsPage() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saved, setSaved] = useState<{ config: Config; outlets: Record<string, Outlet> } | null>(null)
  const [features, setFeatures] = useState<Feature[]>([])
  const [botName, setBotName] = useState('')
  const [retryQueue, setRetryQueue] = useState(0)

  // 編輯中的值
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [editingSecret, setEditingSecret] = useState(false)
  const [chatId, setChatId] = useState('')
  const [toolUrl, setToolUrl] = useState('')
  const [outlets, setOutlets] = useState<Record<string, Outlet>>({})

  const [verifyMsg, setVerifyMsg] = useState<Msg>(null)
  const [verified, setVerified] = useState<boolean | null>(null)
  const [chatTab, setChatTab] = useState<'pick' | 'manual'>('pick')
  const [chats, setChats] = useState<Array<{ chatId: string; name: string }> | null>(null)
  const [chatsMsg, setChatsMsg] = useState<Msg>(null)
  const [testMsg, setTestMsg] = useState<Msg>(null)
  const [mentions, setMentions] = useState<{ noPermission: boolean; error: string; rows: MentionRow[] } | null>(null)
  const [saveMsg, setSaveMsg] = useState<Msg>(null)
  const [busy, setBusy] = useState('')
  // 群組與 @人 是頁面載入時同時讀的，各自一個旗標（共用 busy 會互相蓋掉，讀取中卻顯示成「沒設定」）
  const [chatsLoading, setChatsLoading] = useState(false)
  const [mentionsLoading, setMentionsLoading] = useState(false)

  const resetToSaved = (s: { config: Config; outlets: Record<string, Outlet> }) => {
    setAppId(s.config.appId); setSecret(''); setEditingSecret(!s.config.hasSecret)
    setChatId(s.config.chatId); setToolUrl(s.config.toolUrl); setOutlets(s.outlets)
  }

  const load = async () => {
    setLoading(true); setLoadError('')
    const j = await api<{ config: Config; outlets: Record<string, Outlet>; features: Feature[]; botName: string; retryQueue: number }>('GET', '/api/lark-notify/config')
    setLoading(false)
    if (!j.ok) { setLoadError(j.message ?? '讀取失敗'); return }
    const s = { config: j.config, outlets: j.outlets }
    setSaved(s); setFeatures(j.features); setBotName(j.botName); setRetryQueue(j.retryQueue); resetToSaved(s)
    if (j.config.appId && j.config.hasSecret) { setVerified(!!j.botName || null); void loadChats(); void loadMentions() }
  }

  const loadChats = async () => {
    setChatsLoading(true); setChatsMsg(null)
    const j = await api<{ chats: Array<{ chatId: string; name: string }>; code?: string }>('GET', '/api/lark-notify/chats')
    setChatsLoading(false)
    if (!j.ok) { setChats(null); setChatsMsg({ ok: false, text: j.message ?? '讀不到群組' }); return }
    setChats(j.chats)
    setChatsMsg({ ok: true, text: `機器人目前在 ${j.chats.length} 個群組` })
  }
  const loadMentions = async () => {
    setMentionsLoading(true)
    const j = await api<{ noPermission: boolean; error: string; rows: MentionRow[] }>('GET', '/api/lark-notify/mentions')
    setMentionsLoading(false)
    if (j.ok) setMentions({ noPermission: j.noPermission, error: j.error, rows: j.rows })
  }

  useEffect(() => { void load() }, [])

  const dirty = useMemo(() => {
    if (!saved) return false
    return appId !== saved.config.appId || !!secret || chatId !== saved.config.chatId || toolUrl !== saved.config.toolUrl
      || features.some(f => outlets[f.key] !== saved.outlets[f.key])
  }, [saved, appId, secret, chatId, toolUrl, outlets, features])

  const verify = async () => {
    setBusy('verify'); setVerifyMsg(null)
    // Secret 有重填就驗欄位上那組；沒重填就驗已存的（App ID 也改了卻沒填 Secret 時，提醒要一起填）
    if (!secret && saved && appId !== saved.config.appId) { setBusy(''); setVerifyMsg({ ok: false, text: '換了 App ID 要連 Secret 一起重填才驗得了' }); return }
    const j = await api<{ botName?: string }>('POST', '/api/lark-notify/verify', secret ? { appId, secret } : {})
    setBusy('')
    setVerified(j.ok)
    setVerifyMsg({ ok: j.ok, text: j.message ?? '' })
    if (j.ok && j.botName) setBotName(j.botName)
  }

  const testSend = async () => {
    if (!chatId.trim()) { setTestMsg({ ok: false, text: '先選群組或填 chat ID' }); return }
    setBusy('test'); setTestMsg(null)
    const j = await api('POST', '/api/lark-notify/test', { chatId: chatId.trim() })
    setBusy('')
    const name = chats?.find(c => c.chatId === chatId.trim())?.name
    setTestMsg({ ok: j.ok, text: j.ok ? `試發成功${name ? ` · ${name}` : ''}` : (j.message ?? '試發失敗') })
  }

  const save = async () => {
    setBusy('save'); setSaveMsg(null)
    const j = await api<{ config: Config; outlets: Record<string, Outlet> }>('PUT', '/api/lark-notify/config', {
      appId, secret: secret || undefined, chatId, toolUrl, outlets,
    })
    setBusy('')
    if (!j.ok) { setSaveMsg({ ok: false, text: j.message ?? '儲存失敗' }); return }
    const s = { config: j.config, outlets: j.outlets }
    setSaved(s); resetToSaved(s)
    setSaveMsg({ ok: true, text: '已儲存' })
    if (j.config.appId && j.config.hasSecret) { void loadChats(); void loadMentions() }
  }

  if (loading) return <div className="ln-page"><div className="ln-card">讀取中…</div></div>
  if (loadError) return <div className="ln-page"><div className="ln-card ln-msg ln-msg--error">{loadError}</div></div>

  const cfg = saved!.config
  const mappedN = mentions?.rows.filter(r => r.status === 'mapped').length ?? 0
  const pendingN = mentions ? mentions.rows.length - mappedN : 0

  return (
    <div className="ln-page">
      <div className="ln-head">
        <p className="ln-sub">集中管理通知機器人、目標群組與人員對照，所有通知都發到 Lark</p>
        <span className="ln-pill" title="工具只用 Lark 的發訊息 API，不接收事件（長連線留給 Claude 的 Lark 外掛）">僅發送通知</span>
      </div>

      {/* ① 機器人憑證 */}
      <section className="ln-card">
        <div className="ln-card-head">
          <h2 className="ln-card-title">機器人憑證{botName && <span className="ln-chip">{botName}</span>}</h2>
          {verified === true && <span className="ln-state ln-state--ok"><i />已驗證</span>}
          {verified === false && <span className="ln-state ln-state--bad"><i />驗證失敗</span>}
        </div>
        {!cfg.keyConfigured && (
          <div className="ln-msg ln-msg--error ln-banner">伺服器沒有設定加密金鑰（MEEGLE_TOKEN_KEY），Secret 存不了。請先在主機的環境變數設好再回來。</div>
        )}
        <div className="ln-row">
          <label className="ln-label" htmlFor="ln-appid">App ID</label>
          <input id="ln-appid" className="ln-input" value={appId} onChange={e => setAppId(e.target.value)} placeholder="cli_xxxxxxxx" autoComplete="off" />
        </div>
        <div className="ln-row">
          <label className="ln-label" htmlFor="ln-secret">App Secret</label>
          {editingSecret
            ? <input id="ln-secret" className="ln-input" type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={cfg.hasSecret ? '留空＝保留原值' : '貼上 App Secret'} autoComplete="new-password" />
            : <div className="ln-input ln-input--static">••••••••{cfg.secretTail ? ` ${cfg.secretTail}` : ''}</div>}
          {cfg.hasSecret && (
            <button type="button" className="ln-btn" onClick={() => { setEditingSecret(v => !v); setSecret('') }}>{editingSecret ? '不更換' : '更換 Secret'}</button>
          )}
          <button type="button" className="ln-btn ln-btn--outline" onClick={verify} disabled={busy === 'verify' || !appId.trim() || (!secret && !cfg.hasSecret)}>{busy === 'verify' ? '驗證中…' : '驗證憑證'}</button>
        </div>
        <div className="ln-foot">
          <span className="ln-hint">{cfg.hasSecret ? '已儲存，僅顯示尾碼；留空保留原值' : '還沒設定 Secret'}</span>
          <span className="ln-hint">🔒 僅管理員可修改</span>
        </div>
        {verifyMsg && <div className={`ln-msg ${verifyMsg.ok ? 'ln-msg--ok' : 'ln-msg--error'}`}>{verifyMsg.text}</div>}
      </section>

      {/* ② 目標群組 */}
      <section className="ln-card">
        <h2 className="ln-card-title">目標群組</h2>
        <div className="ln-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={chatTab === 'pick'} className={`ln-tab${chatTab === 'pick' ? ' is-active' : ''}`} onClick={() => setChatTab('pick')}>選擇群組</button>
          <button type="button" role="tab" aria-selected={chatTab === 'manual'} className={`ln-tab${chatTab === 'manual' ? ' is-active' : ''}`} onClick={() => setChatTab('manual')}>手填 chat ID</button>
        </div>
        {chatTab === 'pick' && (
          <>
            <div className="ln-row ln-row--nolabel">
              <select className="ln-input" value={chats?.some(c => c.chatId === chatId) ? chatId : ''} onChange={e => setChatId(e.target.value)} disabled={!chats?.length}>
                <option value="">{chats ? (chats.length ? '選一個群組' : '機器人還沒加入任何群組') : chatsLoading ? '讀取群組中…' : cfg.hasSecret ? '讀不到群組（看下方訊息）' : '先儲存憑證才讀得到群組'}</option>
                {chats?.map(c => <option key={c.chatId} value={c.chatId}>{c.name || c.chatId}</option>)}
              </select>
              <button type="button" className="ln-btn ln-btn--outline" onClick={loadChats} disabled={chatsLoading || !cfg.hasSecret}>{chatsLoading ? '讀取中…' : '↻ 重新整理'}</button>
            </div>
            <div className="ln-hint ln-hint--under">僅列出機器人已加入的群組{chatsMsg && !chatsMsg.ok ? `　·　${chatsMsg.text}` : ''}</div>
          </>
        )}
        <div className="ln-row">
          <label className="ln-label" htmlFor="ln-chat">chat ID</label>
          <input id="ln-chat" className="ln-input" value={chatId} onChange={e => setChatId(e.target.value)} placeholder="oc_xxxxxxxx" readOnly={chatTab === 'pick'} />
          <button type="button" className="ln-btn ln-btn--outline" onClick={testSend} disabled={busy === 'test' || !cfg.hasSecret}>{busy === 'test' ? '發送中…' : '試發'}</button>
          {testMsg && <span className={`ln-result ${testMsg.ok ? 'ln-result--ok' : 'ln-result--bad'}`}>{testMsg.ok ? '✓' : '✕'} {testMsg.text}</span>}
        </div>
        {chatId !== cfg.chatId && <div className="ln-hint ln-hint--under">試發用的是欄位上的群組；正式通知要按下方「儲存設定」後才會改發到這裡</div>}
      </section>

      {/* ③ 通知內容（v5.5.0 Discord 退場：出口固定 Lark，不再有 Discord／雙發可選） */}
      <section className="ln-card">
        <h2 className="ln-card-title">通知內容</h2>
        <table className="ln-table">
          <thead><tr><th>功能</th><th>發到</th></tr></thead>
          <tbody>
            {features.map(f => (
              <tr key={f.key}><td>{f.label}</td><td><span className="ln-chip ln-chip--ok">Lark</span></td></tr>
            ))}
          </tbody>
        </table>
        <div className="ln-hint ln-hint--under">AutoSpin 通知的開關、顯示欄位、定時彙總報告在側欄「AutoSpin 通知」頁，依帳號分開設定</div>
        <div className="ln-note">
          <span className="ln-note-icon">↗</span>
          <b>週報通知：開啟工具確認頁</b>
          <span className="ln-hint">Lark 卡片上是連結，登入並確認後才送出（不能在卡片上直接送）</span>
        </div>
        <div className="ln-row">
          <label className="ln-label" htmlFor="ln-toolurl">工具網址</label>
          <input id="ln-toolurl" className="ln-input" value={toolUrl} onChange={e => setToolUrl(e.target.value)} placeholder="http://工具的網址（週報卡片的連結會指到這裡）" />
        </div>
        {(!cfg.hasSecret || !cfg.chatId) && (
          <div className="ln-msg ln-msg--error">機器人憑證或目標群組還沒存好——所有通知都會發不出去</div>
        )}
        {retryQueue > 0 && <div className="ln-hint ln-hint--under">目前有 {retryQueue} 則通知在等補送</div>}
      </section>

      {/* ④ @人對照狀態 */}
      <section className="ln-card">
        <h2 className="ln-card-title">
          @人對照狀態
          {mentions && !mentions.noPermission && <span className="ln-chip ln-chip--ok">已配對 {mappedN}</span>}
          {mentions && !mentions.noPermission && pendingN > 0 && <span className="ln-chip ln-chip--warn">待處理 {pendingN}</span>}
          {mentions?.noPermission && <span className="ln-chip ln-chip--warn">缺少權限</span>}
        </h2>
        {mentions?.noPermission && (
          <div className="ln-msg ln-msg--error ln-banner">機器人沒有「透過 email 取得使用者 ID」的權限（contact:user.id:readonly），目前通知只會寫名字、不會真的 @ 到人。到 Lark 開發者後台幫這個應用開權限並發佈版本後，按「重新配對」。</div>
        )}
        {mentions?.error && <div className="ln-msg ln-msg--error">{mentions.error}</div>}
        {mentions ? (
          <table className="ln-table">
            <thead><tr><th>使用者 Email</th><th>工具帳號</th><th>狀態</th></tr></thead>
            <tbody>
              {mentions.rows.map(r => (
                <tr key={r.email}>
                  <td>{r.email}</td>
                  <td>{r.label || '—'}</td>
                  <td>
                    {r.status === 'mapped' && <span className="ln-state ln-state--ok"><i />已配對</span>}
                    {r.status === 'not_found' && <span className="ln-state ln-state--warn"><i />查無帳號</span>}
                    {r.status === 'unknown' && <span className="ln-state ln-state--muted"><i />無法查詢</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="ln-hint">{cfg.hasSecret ? '讀取中…' : '存好機器人憑證後才查得到'}</div>}
        <div className="ln-foot">
          <span className="ln-hint">未配對者保留姓名，不產生 @ 提及</span>
          <button type="button" className="ln-btn ln-btn--outline" onClick={loadMentions} disabled={mentionsLoading || !cfg.hasSecret}>{mentionsLoading ? '配對中…' : '重新配對'}</button>
        </div>
      </section>

      <div className="ln-savebar">
        <span className="ln-hint">{saveMsg ? <span className={saveMsg.ok ? 'ln-ok' : 'ln-bad'}>{saveMsg.text}</span> : dirty ? 'ⓘ 尚未儲存變更' : '設定已是最新'}</span>
        <div className="ln-savebar-actions">
          <button type="button" className="ln-btn" onClick={() => { resetToSaved(saved!); setSaveMsg(null) }} disabled={!dirty || busy === 'save'}>取消</button>
          <button type="button" className="ln-btn ln-btn--primary" onClick={save} disabled={!dirty || busy === 'save'}>{busy === 'save' ? '儲存中…' : '儲存設定'}</button>
        </div>
      </div>
    </div>
  )
}

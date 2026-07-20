import { useEffect, useState } from 'react'

const STATE_META: { key: string; label: string; color: string; desc: string }[] = [
  { key: 'queued', label: '排隊中', color: '#6b7280', desc: '任務已建立，Agent 尚未開始執行' },
  { key: 'running', label: '執行中', color: '#3b82f6', desc: '每次餘額/事件回報時同步更新（同一則訊息）' },
  { key: 'success', label: '已完成', color: '#22c55e', desc: 'Session 結束，過程中沒有偵測到異常' },
  { key: 'failed', label: '失敗', color: '#ef4444', desc: 'Session 結束，曾偵測到餘額異常（跌幅 > 30%）' },
  { key: 'stopped', label: '已停止', color: '#9ca3af', desc: '手動停止或連線逾時' },
]

export function DiscordNotifySettingsPage() {
  const [url, setUrl] = useState('')
  const [savedUrl, setSavedUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/autospin/discord-webhook')
      const data = await res.json()
      setUrl(data.url || '')
      setSavedUrl(data.url || '')
    } catch {
      setMsg({ text: '讀取設定失敗，請稍後重試', ok: false })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleSave() {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch('/api/autospin/discord-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setSavedUrl(url.trim())
        setMsg({ text: url.trim() ? '✅ 已儲存 Webhook 設定' : '✅ 已關閉通知（URL 清空）', ok: true })
      } else {
        setMsg({ text: `儲存失敗：${data.message || '未知錯誤'}`, ok: false })
      }
    } catch (e) {
      setMsg({ text: `儲存失敗：${e}`, ok: false })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setMsg(null)
    try {
      const res = await fetch('/api/autospin/discord-webhook/test', { method: 'POST' })
      const data = await res.json()
      setMsg(data.ok
        ? { text: '✅ 測試訊息已送出，請至 Discord 頻道查看', ok: true }
        : { text: `測試失敗：${data.message || '未知錯誤'}`, ok: false })
    } catch (e) {
      setMsg({ text: `測試失敗：${e}`, ok: false })
    } finally {
      setTesting(false)
    }
  }

  const isConfigured = !!savedUrl
  const isDirty = url.trim() !== savedUrl

  return (
    <div className="discord-notify-page">
      <div className="discord-notify-head">
        <div>
          <h1 className="discord-notify-title">
            💬 Discord 通知設定
            <span className={isConfigured ? 'badge badge--ok' : 'badge'}>
              {isConfigured ? '● 已啟用' : '○ 未設定'}
            </span>
          </h1>
          <p className="discord-notify-sub">
            設定 AutoSpin 執行狀態即時彙報用的 Discord Webhook。每台機台開始測試時建立一則訊息，之後同一則訊息會隨狀態變化持續更新，不會洗版。
          </p>
        </div>
      </div>

      <div className="discord-notify-grid">
        {/* Left: 設定 */}
        <div>
          <div className="discord-notify-card">
            <div className="discord-notify-card-title">🔗 Webhook URL</div>
            <p className="discord-notify-card-note">
              頻道可隨時更換，不需要改代碼 —— 只要在這裡貼上新的 Webhook URL 並儲存即可。<br />
              在 Discord 頻道設定 → 整合 → Webhook 建立後複製網址貼在這裡。
            </p>
            <div className="discord-notify-field">
              <label>Discord Webhook URL</label>
              <input
                className="discord-notify-input"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://discord.com/api/webhooks/xxxxxxxx/xxxxxxxxxxxxxxxxxxxxxxxx"
                disabled={loading}
                spellCheck={false}
              />
            </div>
            <div className="discord-notify-actions">
              <button
                className="discord-notify-btn discord-notify-btn--primary"
                onClick={handleSave}
                disabled={saving || loading || !isDirty}
              >
                {saving ? '儲存中…' : '💾 儲存設定'}
              </button>
              <button
                className="discord-notify-btn discord-notify-btn--secondary"
                onClick={handleTest}
                disabled={testing || loading || !savedUrl}
                title={!savedUrl ? '請先儲存 Webhook URL' : ''}
              >
                {testing ? '送出中…' : '📨 發送測試訊息'}
              </button>
            </div>
            {msg && <div className={`discord-notify-msg ${msg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{msg.text}</div>}
          </div>

          <div className="discord-notify-card">
            <div className="discord-notify-card-title">🔄 狀態生命週期</div>
            <p className="discord-notify-card-note">
              同一台機台的通知只會有「一則」訊息，狀態變化時原地編輯更新。
            </p>
            <div className="discord-notify-state-list">
              {STATE_META.map((s, i) => (
                <div key={s.key}>
                  <div className="discord-notify-state-row">
                    <span className="discord-notify-state-dot" style={{ background: s.color }} />
                    <span className="discord-notify-state-name">{s.label}</span>
                    <span className="discord-notify-state-desc">{s.desc}</span>
                  </div>
                  {i < STATE_META.length - 1 && i !== 1 && <div className="discord-notify-state-arrow">↓</div>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: 預覽 */}
        <div className="discord-notify-card">
          <div className="discord-notify-card-title">👁 訊息預覽</div>
          <p className="discord-notify-card-note">實際發送到 Discord 頻道的卡片樣式示意</p>
          <div className="discord-notify-preview">
            <div className="discord-notify-preview-embed">
              <div className="discord-notify-preview-title">▶️ AutoSpin — JJBXGRAND_01</div>
              <div className="discord-notify-preview-fields">
                <div>
                  <div className="discord-notify-preview-field-name">狀態</div>
                  <div className="discord-notify-preview-field-value">▶️ 執行中</div>
                </div>
                <div>
                  <div className="discord-notify-preview-field-name">Spin 數</div>
                  <div className="discord-notify-preview-field-value">128</div>
                </div>
                <div className="full">
                  <div className="discord-notify-preview-field-name">Game URL</div>
                  <div className="discord-notify-preview-field-value">https://qat-cp.osmslot.org/game/...</div>
                </div>
                <div className="full">
                  <div className="discord-notify-preview-field-name">截圖</div>
                  <div className="discord-notify-preview-field-value">https://.../screenshot/xxx/JJBXGRAND_01_128.png</div>
                </div>
              </div>
              <div className="discord-notify-preview-time">今天 14:32</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { loadGlobalAccount } from '../authSession'

/** 通知啟用開關/顯示欄位/定時彙總報告設定依帳號分開，這裡取目前選擇的帳號當 x-user-label。 */
function getUserLabel(): string {
  return loadGlobalAccount()?.label ?? ''
}

function ToggleSwitch({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={checked ? '點擊停用' : '點擊啟用'}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0, flexShrink: 0,
        background: checked ? '#3b82f6' : '#374151',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        position: 'relative',
        transition: 'background 0.2s ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s ease',
      }} />
    </button>
  )
}

type FieldKey = 'gameUrl' | 'spinCount' | 'errorSummary' | 'screenshotUrl'
const FIELD_META: { key: FieldKey; label: string }[] = [
  { key: 'spinCount', label: 'Spin 數' },
  { key: 'gameUrl', label: 'Game URL' },
  { key: 'errorSummary', label: '錯誤摘要' },
  { key: 'screenshotUrl', label: '截圖連結' },
]
const DEFAULT_FIELDS: Record<FieldKey, boolean> = {
  gameUrl: true, spinCount: true, errorSummary: true, screenshotUrl: true,
}
const DEFAULT_TITLE_TEMPLATE = 'AutoSpin — {machineType}'

type ReportFieldKey = 'spins' | 'winRate' | 'errcodes' | 'recover' | 'kickouts' | 'crChecks' | 'uptime'
const REPORT_FIELD_META: { key: ReportFieldKey; label: string }[] = [
  { key: 'spins', label: 'Spin 數 / OK 率' },
  { key: 'winRate', label: '中獎次數 / 總贏分' },
  { key: 'errcodes', label: 'errcode 明細' },
  { key: 'recover', label: 'RECOVER（斷線重連）' },
  { key: 'kickouts', label: 'kickouts（低餘額離機重進）' },
  { key: 'crChecks', label: 'CR checks / 無回應' },
  { key: 'uptime', label: '已跑時間' },
]
const DEFAULT_REPORT_FIELDS: Record<ReportFieldKey, boolean> = {
  spins: true, winRate: true, errcodes: true, recover: true, kickouts: true, crChecks: true, uptime: true,
}

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
  const [enabled, setEnabled] = useState(true)
  const [savedEnabled, setSavedEnabled] = useState(true)
  const [fields, setFields] = useState<Record<FieldKey, boolean>>(DEFAULT_FIELDS)
  const [savedFields, setSavedFields] = useState<Record<FieldKey, boolean>>(DEFAULT_FIELDS)
  const [titleTemplate, setTitleTemplate] = useState(DEFAULT_TITLE_TEMPLATE)
  const [savedTitleTemplate, setSavedTitleTemplate] = useState(DEFAULT_TITLE_TEMPLATE)
  const [footer, setFooter] = useState('')
  const [savedFooter, setSavedFooter] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  // ── 定時彙總報告（RECOVER/errcode/CR checks/kickouts 等長時間穩定性統計）──────────
  const [reportEnabled, setReportEnabled] = useState(false)
  const [savedReportEnabled, setSavedReportEnabled] = useState(false)
  const [reportIntervalMin, setReportIntervalMin] = useState(20)
  const [savedReportIntervalMin, setSavedReportIntervalMin] = useState(20)
  const [reportFields, setReportFields] = useState<Record<ReportFieldKey, boolean>>(DEFAULT_REPORT_FIELDS)
  const [savedReportFields, setSavedReportFields] = useState<Record<ReportFieldKey, boolean>>(DEFAULT_REPORT_FIELDS)
  const [reportCustomNote, setReportCustomNote] = useState('')
  const [savedReportCustomNote, setSavedReportCustomNote] = useState('')
  const [reportAiEnabled, setReportAiEnabled] = useState(false)
  const [savedReportAiEnabled, setSavedReportAiEnabled] = useState(false)
  const [reportSaving, setReportSaving] = useState(false)
  const [reportMsg, setReportMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [reportTesting, setReportTesting] = useState(false)

  // ── 帳號 → Discord User ID 對照（通知 tag 發起人用）───────────────────────────
  const [userMap, setUserMap] = useState<{ userLabel: string; discordUserId: string }[]>([])
  const [savedUserMap, setSavedUserMap] = useState<{ userLabel: string; discordUserId: string }[]>([])
  const [userMapSaving, setUserMapSaving] = useState(false)
  const [userMapMsg, setUserMapMsg] = useState<{ text: string; ok: boolean } | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/autospin/discord-webhook', { headers: { 'x-user-label': getUserLabel() } })
      const data = await res.json()
      setUrl(data.url || '')
      setSavedUrl(data.url || '')
      setEnabled(data.enabled !== false)
      setSavedEnabled(data.enabled !== false)
      const f = { ...DEFAULT_FIELDS, ...(data.fields || {}) }
      setFields(f)
      setSavedFields(f)
      const t = data.titleTemplate || DEFAULT_TITLE_TEMPLATE
      setTitleTemplate(t)
      setSavedTitleTemplate(t)
      setFooter(data.footer || '')
      setSavedFooter(data.footer || '')
    } catch {
      setMsg({ text: '讀取設定失敗，請稍後重試', ok: false })
    } finally {
      setLoading(false)
    }
  }

  async function loadReportSettings() {
    try {
      const res = await fetch('/api/autospin/status-report-settings', { headers: { 'x-user-label': getUserLabel() } })
      const data = await res.json()
      setReportEnabled(!!data.enabled); setSavedReportEnabled(!!data.enabled)
      const iv = data.intervalMin ?? 20
      setReportIntervalMin(iv); setSavedReportIntervalMin(iv)
      const f = { ...DEFAULT_REPORT_FIELDS, ...(data.fields || {}) }
      setReportFields(f); setSavedReportFields(f)
      const note = data.customNote || ''
      setReportCustomNote(note); setSavedReportCustomNote(note)
      setReportAiEnabled(!!data.aiEnabled); setSavedReportAiEnabled(!!data.aiEnabled)
    } catch { /* best-effort */ }
  }

  async function loadUserMap() {
    try {
      const res = await fetch('/api/autospin/discord-user-map')
      const data = await res.json()
      const m = data.map || []
      setUserMap(m); setSavedUserMap(m)
    } catch { /* best-effort */ }
  }

  useEffect(() => { load(); loadReportSettings(); loadUserMap() }, [])

  const reportFieldsDirty = REPORT_FIELD_META.some(f => reportFields[f.key] !== savedReportFields[f.key])
  const reportDirty = reportEnabled !== savedReportEnabled || reportIntervalMin !== savedReportIntervalMin
    || reportFieldsDirty || reportCustomNote !== savedReportCustomNote || reportAiEnabled !== savedReportAiEnabled

  async function handleSaveReportSettings() {
    setReportSaving(true)
    setReportMsg(null)
    try {
      const res = await fetch('/api/autospin/status-report-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-label': getUserLabel() },
        body: JSON.stringify({ enabled: reportEnabled, intervalMin: reportIntervalMin, fields: reportFields, customNote: reportCustomNote, aiEnabled: reportAiEnabled }),
      })
      const data = await res.json()
      if (data.ok) {
        setSavedReportEnabled(reportEnabled); setSavedReportIntervalMin(reportIntervalMin)
        setSavedReportFields(reportFields); setSavedReportCustomNote(reportCustomNote)
        setSavedReportAiEnabled(reportAiEnabled)
        setReportMsg({ text: '通過 已儲存定時彙總報告設定', ok: true })
      } else {
        setReportMsg({ text: `儲存失敗：${data.message || '未知錯誤'}`, ok: false })
      }
    } catch (e) {
      setReportMsg({ text: `儲存失敗：${e}`, ok: false })
    } finally {
      setReportSaving(false)
    }
  }

  async function handleTestReport() {
    setReportTesting(true)
    setReportMsg(null)
    try {
      const res = await fetch('/api/autospin/status-report-test', { method: 'POST', headers: { 'x-user-label': getUserLabel() } })
      const data = await res.json()
      setReportMsg(data.ok
        ? { text: '通過 測試彙總報告已送出（假資料），請至 Discord 頻道查看效果', ok: true }
        : { text: `試發送失敗：${data.message || '未知錯誤'}`, ok: false })
    } catch (e) {
      setReportMsg({ text: `試發送失敗：${e}`, ok: false })
    } finally {
      setReportTesting(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch('/api/autospin/discord-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-label': getUserLabel() },
        body: JSON.stringify({ url: url.trim(), enabled, fields, titleTemplate: titleTemplate.trim() || DEFAULT_TITLE_TEMPLATE, footer: footer.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setSavedUrl(url.trim())
        setSavedEnabled(enabled)
        setSavedFields(fields)
        setSavedTitleTemplate(titleTemplate.trim() || DEFAULT_TITLE_TEMPLATE)
        setSavedFooter(footer.trim())
        setMsg({ text: url.trim() ? '通過 已儲存 Webhook 設定' : '通過 已關閉通知（URL 清空）', ok: true })
      } else {
        setMsg({ text: `儲存失敗：${data.message || '未知錯誤'}`, ok: false })
      }
    } catch (e) {
      setMsg({ text: `儲存失敗：${e}`, ok: false })
    } finally {
      setSaving(false)
    }
  }

  const userMapDirty = JSON.stringify(userMap) !== JSON.stringify(savedUserMap)

  async function handleSaveUserMap() {
    const cleaned = userMap.map(e => ({ userLabel: e.userLabel.trim(), discordUserId: e.discordUserId.trim() }))
      .filter(e => e.userLabel && e.discordUserId)
    setUserMapSaving(true)
    setUserMapMsg(null)
    try {
      const res = await fetch('/api/autospin/discord-user-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ map: cleaned }),
      })
      const data = await res.json()
      if (data.ok) {
        setUserMap(cleaned); setSavedUserMap(cleaned)
        setUserMapMsg({ text: '通過 已儲存對照表', ok: true })
      } else {
        setUserMapMsg({ text: `儲存失敗：${data.message || '未知錯誤'}`, ok: false })
      }
    } catch (e) {
      setUserMapMsg({ text: `儲存失敗：${e}`, ok: false })
    } finally {
      setUserMapSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setMsg(null)
    try {
      const res = await fetch('/api/autospin/discord-webhook/test', { method: 'POST' })
      const data = await res.json()
      setMsg(data.ok
        ? { text: '通過 測試訊息已送出，請至 Discord 頻道查看', ok: true }
        : { text: `測試失敗：${data.message || '未知錯誤'}`, ok: false })
    } catch (e) {
      setMsg({ text: `測試失敗：${e}`, ok: false })
    } finally {
      setTesting(false)
    }
  }

  const isConfigured = !!savedUrl
  const fieldsDirty = FIELD_META.some(f => fields[f.key] !== savedFields[f.key])
  const isDirty = url.trim() !== savedUrl || enabled !== savedEnabled || fieldsDirty
    || titleTemplate !== savedTitleTemplate || footer !== savedFooter

  return (
    <div className="discord-notify-page">
      <div className="discord-notify-head">
        <div>
          <h1 className="discord-notify-title">
            訊 Discord 通知設定
            <span className={isConfigured ? (savedEnabled ? 'badge badge--ok' : 'badge badge--warn') : 'badge'}>
              {isConfigured ? (savedEnabled ? '● 已啟用' : '⏸ 已暫停') : '○ 未設定'}
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
            <div className="discord-notify-card-title">Webhook URL</div>
            <p className="discord-notify-card-note">
              頻道可隨時更換，不需要改代碼 —— 只要在這裡貼上新的 Webhook URL 並儲存即可（<strong>全員共用同一個網址</strong>）。<br />
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <ToggleSwitch checked={enabled} disabled={loading} onToggle={() => setEnabled(v => !v)} />
              <div>
                <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 700 }}>啟用通知</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>關閉後即使 URL 有設定也不會發送，不用清空網址就能暫停（依目前帳號分開設定，不影響其他人）</div>
              </div>
            </div>
            <div className="discord-notify-actions">
              <button
                className="discord-notify-btn discord-notify-btn--primary"
                onClick={handleSave}
                disabled={saving || loading || !isDirty}
              >
                {saving ? '儲存中…' : '儲存設定'}
              </button>
              <button
                className="discord-notify-btn discord-notify-btn--secondary"
                onClick={handleTest}
                disabled={testing || loading || !savedUrl}
                title={!savedUrl ? '請先儲存 Webhook URL' : ''}
              >
                {testing ? '送出中…' : '發送測試訊息'}
              </button>
            </div>
            {msg && <div className={`discord-notify-msg ${msg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{msg.text}</div>}
          </div>

          <div className="discord-notify-card">
            <div className="discord-notify-card-title">訊息格式</div>
            <p className="discord-notify-card-note">自訂卡片要顯示哪些欄位、標題文字（右側預覽會即時同步）。<strong>顯示欄位依目前帳號分開設定</strong>，標題模板/頁尾文字全員共用。</p>

            <div className="discord-notify-field" style={{ marginBottom: 14 }}>
              <label>顯示欄位</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {FIELD_META.map(f => (
                  <label
                    key={f.key}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                      border: '1px solid #334155', borderRadius: 7, background: '#0f172a',
                      fontSize: 12, color: '#cbd5e1', cursor: 'pointer', userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={fields[f.key]}
                      disabled={loading}
                      onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.checked }))}
                      style={{ cursor: 'pointer', accentColor: '#5865f2' }}
                    />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="discord-notify-field" style={{ marginBottom: 14 }}>
              <label>訊息標題模板</label>
              <input
                className="discord-notify-input"
                value={titleTemplate}
                onChange={e => setTitleTemplate(e.target.value)}
                placeholder={DEFAULT_TITLE_TEMPLATE}
                disabled={loading}
              />
              <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>用 <code>{'{machineType}'}</code> 代表機台代碼，例如加公司代號：<code>[TP] {'{machineType}'}</code></div>
            </div>

            <div className="discord-notify-field">
              <label>自訂頁尾文字（選填）</label>
              <input
                className="discord-notify-input"
                value={footer}
                onChange={e => setFooter(e.target.value)}
                placeholder="例如：Toppath QA Team"
                disabled={loading}
              />
            </div>
          </div>

          <div className="discord-notify-card">
            <div className="discord-notify-card-title">定時彙總報告（AutoSpin 長時間穩定性統計）</div>
            <p className="discord-notify-card-note">
              跟上面的啟動/結束通知共用同一個 Webhook URL，是另外獨立開關——每隔設定的間隔，把累計統計（Spin 數/errcode/斷線重連/CR checks 等）發一則新的彙總訊息，不會覆蓋前一則。<strong>以下設定依目前帳號分開</strong>，只影響你自己派工的 session。
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <ToggleSwitch checked={reportEnabled} disabled={loading} onToggle={() => setReportEnabled(v => !v)} />
              <div>
                <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 700 }}>啟用定時彙總報告</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>關閉後即使有設定間隔也不會發送</div>
              </div>
            </div>
            <div className="discord-notify-field" style={{ marginBottom: 14 }}>
              <label>間隔（分鐘）</label>
              <input
                className="discord-notify-input"
                type="number" min={1} step={1}
                value={reportIntervalMin}
                onChange={e => setReportIntervalMin(Math.max(1, parseInt(e.target.value) || 20))}
                style={{ maxWidth: 120 }}
                disabled={loading}
              />
              <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>Agent 每 3 秒隨心跳拿到最新設定，改了不用重啟 Agent</div>
            </div>
            <div className="discord-notify-field" style={{ marginBottom: 14 }}>
              <label>顯示欄位</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {REPORT_FIELD_META.map(f => (
                  <label
                    key={f.key}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                      border: '1px solid #334155', borderRadius: 7, background: '#0f172a',
                      fontSize: 12, color: '#cbd5e1', cursor: 'pointer', userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={reportFields[f.key]}
                      disabled={loading}
                      onChange={e => setReportFields(prev => ({ ...prev, [f.key]: e.target.checked }))}
                      style={{ cursor: 'pointer', accentColor: '#5865f2' }}
                    />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="discord-notify-field">
              <label>自訂欄位（選填）</label>
              <textarea
                className="discord-notify-input"
                value={reportCustomNote}
                onChange={e => setReportCustomNote(e.target.value)}
                placeholder="會原樣附加在每則彙總報告的最下方，例如備註、負責人、環境標籤等"
                disabled={loading}
                rows={2}
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16, marginBottom: 16 }}>
              <ToggleSwitch checked={reportAiEnabled} disabled={loading} onToggle={() => setReportAiEnabled(v => !v)} />
              <div>
                <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 700, marginBottom: 3 }}>啟用 AI 分析區塊</div>
                <div style={{ color: '#64748b', fontSize: 11, lineHeight: 1.5 }}>關閉時完全不呼叫 Gemini，零額外開銷；開啟才會在報告最下方加一段「傀 AI 分析」判斷是否異常</div>
              </div>
            </div>
            <div className="discord-notify-actions">
              <button
                className="discord-notify-btn discord-notify-btn--primary"
                onClick={handleSaveReportSettings}
                disabled={reportSaving || loading || !reportDirty}
              >
                {reportSaving ? '儲存中…' : '儲存彙總報告設定'}
              </button>
              <button
                className="discord-notify-btn discord-notify-btn--secondary"
                onClick={handleTestReport}
                disabled={reportTesting || loading || !savedUrl}
                title={!savedUrl ? '請先儲存 Webhook URL' : '用假資料送一則測試彙總報告，確認格式與效果'}
              >
                {reportTesting ? '送出中…' : '試發送'}
              </button>
            </div>
            {reportMsg && <div className={`discord-notify-msg ${reportMsg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{reportMsg.text}</div>}
          </div>

          <div className="discord-notify-card">
            <div className="discord-notify-card-title">帳號 → Discord Tag 對照表</div>
            <p className="discord-notify-card-note">
              AutoSpin 通知（即時彙報 + 定時彙總報告）會依「這個 session 是哪個帳號派工啟動的」查這張表，
              找得到對照就在訊息開頭 @ 那個人（會真的觸發 Discord 通知）。帳號名稱要跟畫面右上角「目前帳號」
              顯示的一致；Discord User ID 可在 Discord 設定「開發者模式」後，對使用者頭像點右鍵「複製使用者 ID」取得。
            </p>
            {userMap.length === 0 && (
              <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0' }}>尚未設定任何對照，通知不會 tag 任何人。</p>
            )}
            {userMap.map((entry, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <input
                  className="discord-notify-input"
                  style={{ flex: 1 }}
                  placeholder="帳號名稱（例：Eric Wu）"
                  value={entry.userLabel}
                  onChange={e => setUserMap(prev => prev.map((x, i) => i === idx ? { ...x, userLabel: e.target.value } : x))}
                  disabled={loading}
                />
                <input
                  className="discord-notify-input"
                  style={{ flex: 1 }}
                  placeholder="Discord User ID（純數字）"
                  value={entry.discordUserId}
                  onChange={e => setUserMap(prev => prev.map((x, i) => i === idx ? { ...x, discordUserId: e.target.value } : x))}
                  disabled={loading}
                />
                <button
                  className="discord-notify-btn discord-notify-btn--secondary"
                  onClick={() => setUserMap(prev => prev.filter((_, i) => i !== idx))}
                  disabled={loading}
                >
                  刪除
                </button>
              </div>
            ))}
            <div className="discord-notify-actions">
              <button
                className="discord-notify-btn discord-notify-btn--secondary"
                onClick={() => setUserMap(prev => [...prev, { userLabel: '', discordUserId: '' }])}
                disabled={loading}
              >
                + 新增對照
              </button>
              <button
                className="discord-notify-btn discord-notify-btn--primary"
                onClick={handleSaveUserMap}
                disabled={userMapSaving || loading || !userMapDirty}
              >
                {userMapSaving ? '儲存中…' : '儲存對照表'}
              </button>
            </div>
            {userMapMsg && <div className={`discord-notify-msg ${userMapMsg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{userMapMsg.text}</div>}
          </div>

          <div className="discord-notify-card">
            <div className="discord-notify-card-title">更新 狀態生命週期</div>
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
          <div className="discord-notify-card-title">訊息預覽</div>
          <p className="discord-notify-card-note">實際發送到 Discord 頻道的卡片樣式示意</p>
          <div className="discord-notify-preview">
            <div className="discord-notify-preview-embed">
              <div className="discord-notify-preview-title">
                ▶ {(titleTemplate || DEFAULT_TITLE_TEMPLATE).replace('{machineType}', 'JJBXGRAND_01')}
              </div>
              <div className="discord-notify-preview-fields">
                <div>
                  <div className="discord-notify-preview-field-name">狀態</div>
                  <div className="discord-notify-preview-field-value">▶ 執行中</div>
                </div>
                {fields.spinCount && (
                  <div>
                    <div className="discord-notify-preview-field-name">Spin 數</div>
                    <div className="discord-notify-preview-field-value">128</div>
                  </div>
                )}
                {fields.gameUrl && (
                  <div className="full">
                    <div className="discord-notify-preview-field-name">Game URL</div>
                    <div className="discord-notify-preview-field-value">https://qat-cp.osmslot.org/game/...</div>
                  </div>
                )}
                {fields.errorSummary && (
                  <div className="full">
                    <div className="discord-notify-preview-field-name">錯誤摘要</div>
                    <div className="discord-notify-preview-field-value">（有異常時才會顯示內容）</div>
                  </div>
                )}
                {fields.screenshotUrl && (
                  <div className="full">
                    <div className="discord-notify-preview-field-name">截圖</div>
                    <div className="discord-notify-preview-field-value">https://.../screenshot/xxx/JJBXGRAND_01_128.png</div>
                  </div>
                )}
              </div>
              <div className="discord-notify-preview-time">
                {footer ? `${footer} • ` : ''}今天 14:32
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

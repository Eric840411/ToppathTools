import { useEffect, useState } from 'react'
import { loadGlobalAccount } from '../authSession'
import { PageActions } from '../redesign/PageActions'

/**
 * AutoSpin 通知設定（v5.5.0：原本的「Discord 通知」頁拿掉 Discord 專屬的 Webhook URL 與 Discord ID 對照表）。
 * 通知一律發 Lark——機器人、群組、@人在「通知設定」頁（只限管理員）；這頁是每個帳號自己的 AutoSpin 通知偏好，
 * 所以沿用原本的頁面權限（discord-notify），非管理員也能改自己的。
 * 版面、樣式 class（discord-notify-*）沿用原頁；v5.13.0 刪 Discord 時刻意不改名（權限 key discord-notify 也保留，改了既有角色的權限會失效）。
 */

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
        width: 36, height: 20, borderRadius: 10, padding: 0, flexShrink: 0,
        background: checked ? 'var(--xx-jade, #75d7cf)' : '#1e2733',
        border: `1px solid ${checked ? 'var(--xx-jade, #75d7cf)' : '#3a4552'}`,
        boxShadow: checked ? '0 0 10px 1px rgba(117, 215, 207, .55)' : 'none',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        position: 'relative',
        transition: 'background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 1, left: checked ? 17 : 1, width: 16, height: 16, borderRadius: '50%',
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

type ReportFieldKey = 'spins' | 'winRate' | 'errcodes' | 'recover' | 'kickouts' | 'crChecks' | 'uptime' | 'sls'
const REPORT_FIELD_META: { key: ReportFieldKey; label: string; hint?: string }[] = [
  { key: 'spins', label: 'Spin 數 / OK 率' },
  { key: 'winRate', label: '中獎次數 / 總贏分' },
  { key: 'errcodes', label: 'errcode 明細' },
  { key: 'recover', label: 'RECOVER（斷線重連）' },
  { key: 'kickouts', label: 'kickouts（低餘額離機重進）' },
  { key: 'crChecks', label: 'CR checks / 無回應' },
  { key: 'uptime', label: '已跑時間' },
  // ⚠️ 只查「這台機台」的 log（用 groupId 定位，不是用名稱比對——名稱會配到別的遊戲去）。
  //    它回答的是「這段時間掉單是不是因為服務掛了」，那是看 errcode 看不出來的。
  {
    key: 'sls', label: 'SLS 服務健康（G2S／MML）',
    hint: '只查這台機台對應的 log：JP 廣播中斷、MML 心跳消失、G2S 斷線／協議錯，附發生時間點。查不到對應時會標「查不了」，不會寫成「正常」。',
  },
]
const DEFAULT_REPORT_FIELDS: Record<ReportFieldKey, boolean> = {
  spins: true, winRate: true, errcodes: true, recover: true, kickouts: true, crChecks: true, uptime: true, sls: true,
}

const STATE_META: { key: string; label: string; color: string; desc: string }[] = [
  { key: 'queued', label: '排隊中', color: '#6b7280', desc: '任務已建立，Agent 尚未開始執行' },
  { key: 'running', label: '執行中', color: '#3b82f6', desc: '每次餘額/事件回報時同步更新（同一則訊息）' },
  { key: 'success', label: '已完成', color: '#22c55e', desc: 'Session 結束，過程中沒有偵測到異常' },
  { key: 'failed', label: '失敗', color: '#ef4444', desc: 'Session 結束，曾偵測到餘額異常（跌幅 > 30%）' },
  { key: 'stopped', label: '已停止', color: '#9ca3af', desc: '手動停止或連線逾時' },
]

export function AutoSpinNotifySettingsPage() {
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

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/autospin/notify-format', { headers: { 'x-user-label': getUserLabel() } })
      const data = await res.json()
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

  useEffect(() => { load(); loadReportSettings() }, [])

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
        setReportMsg({ text: '已儲存定時彙總報告設定', ok: true })
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
        ? { text: '測試彙總報告已送出（假資料），請到 Lark 通知群組查看效果', ok: true }
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
      const res = await fetch('/api/autospin/notify-format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-label': getUserLabel() },
        body: JSON.stringify({ enabled, fields, titleTemplate: titleTemplate.trim() || DEFAULT_TITLE_TEMPLATE, footer: footer.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setSavedEnabled(enabled)
        setSavedFields(fields)
        setSavedTitleTemplate(titleTemplate.trim() || DEFAULT_TITLE_TEMPLATE)
        setSavedFooter(footer.trim())
        setMsg({ text: '已儲存通知設定', ok: true })
      } else {
        setMsg({ text: `儲存失敗：${data.message || '未知錯誤'}`, ok: false })
      }
    } catch (e) {
      setMsg({ text: `儲存失敗：${e}`, ok: false })
    } finally {
      setSaving(false)
    }
  }

  const fieldsDirty = FIELD_META.some(f => fields[f.key] !== savedFields[f.key])
  const isDirty = enabled !== savedEnabled || fieldsDirty
    || titleTemplate !== savedTitleTemplate || footer !== savedFooter

  return (
    <div className="discord-notify-page st-asn">
      {/* 新版（原型 v7）：左邊兩張設定面板（標籤在左、控制項在右）、右邊窄欄訊息預覽；已啟用膠囊放頁首右側。版面樣式在 redesign/pages/settings.css */}
      <div className="discord-notify-head">
        <div>
          <h1 className="discord-notify-title">AutoSpin 通知</h1>
          <p className="discord-notify-sub">
            AutoSpin 執行狀態即時彙報與定時彙總報告，發到 Lark 通知群組（群組、機器人、@人 由管理員在「通知設定」頁設定）。每台機台開始測試時建立一則訊息，之後同一則訊息會隨狀態變化持續更新，不會洗版。
          </p>
        </div>
      </div>
      <PageActions>
        <span className={savedEnabled ? 'lst-pill lst-pill--pass' : 'lst-pill lst-pill--warn'}>
          {savedEnabled ? '已啟用' : '已暫停'}
        </span>
      </PageActions>

      <div className="discord-notify-grid">
        {/* Left: 設定 */}
        <div className="st-col">
          <section className="section-card st-card">
            <h2 className="section-title">訊息格式</h2>
            <p className="st-note">自訂卡片要顯示哪些欄位、標題文字（右側預覽會即時同步）。<strong>啟用開關與顯示欄位依目前帳號分開設定</strong>，標題模板/頁尾文字全員共用。</p>
            <div className="st-form">
              <span className="st-l" />
              <div className="st-sw">
                <ToggleSwitch checked={enabled} disabled={loading} onToggle={() => setEnabled(v => !v)} />
                <div>
                  <div className="st-sw-label">啟用通知</div>
                  <div className="st-hint">關閉後你派工的 session 不會發通知（依目前帳號分開設定，不影響其他人）</div>
                </div>
              </div>

              <span className="st-l">顯示欄位</span>
              <div className="st-checks">
                {FIELD_META.map(f => (
                  <label key={f.key} className="st-chk">
                    <input
                      type="checkbox"
                      checked={fields[f.key]}
                      disabled={loading}
                      onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.checked }))}
                    />
                    {f.label}
                  </label>
                ))}
              </div>

              <label className="st-l" htmlFor="asn-title-tpl">訊息標題模板</label>
              <div className="st-cell">
                <input
                  id="asn-title-tpl"
                  className="lst-field st-grow"
                  value={titleTemplate}
                  onChange={e => setTitleTemplate(e.target.value)}
                  placeholder={DEFAULT_TITLE_TEMPLATE}
                  disabled={loading}
                />
                <div className="st-hint">用 <code>{'{machineType}'}</code> 代表機台代碼，例如加公司代號：<code>[TP] {'{machineType}'}</code></div>
              </div>

              <label className="st-l" htmlFor="asn-footer">自訂頁尾文字（選填）</label>
              <input
                id="asn-footer"
                className="lst-field st-grow"
                value={footer}
                onChange={e => setFooter(e.target.value)}
                placeholder="例如：Toppath QA Team"
                disabled={loading}
              />
            </div>
            <div className="st-actions">
              <button className="submit-btn lst-btn" onClick={handleSave} disabled={saving || loading || !isDirty}>
                {saving ? '儲存中…' : '儲存設定'}
              </button>
            </div>
            {msg && <div className={`discord-notify-msg ${msg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{msg.text}</div>}
          </section>

          <section className="section-card st-card">
            <h2 className="section-title">定時彙總報告（AutoSpin 長時間穩定性統計）</h2>
            <p className="st-note">
              跟上面的啟動/結束通知發到同一個 Lark 群組，是另外獨立開關——每隔設定的間隔，把累計統計（Spin 數/errcode/斷線重連/CR checks 等）發一則新的彙總訊息，不會覆蓋前一則。<strong>以下設定依目前帳號分開</strong>，只影響你自己派工的 session。
            </p>
            <div className="st-form">
              <span className="st-l" />
              <div className="st-sw">
                <ToggleSwitch checked={reportEnabled} disabled={loading} onToggle={() => setReportEnabled(v => !v)} />
                <div>
                  <div className="st-sw-label">啟用定時彙總報告</div>
                  <div className="st-hint">關閉後即使有設定間隔也不會發送</div>
                </div>
              </div>

              <label className="st-l" htmlFor="asn-interval">間隔（分鐘）</label>
              <div className="st-cell">
                <input
                  id="asn-interval"
                  className="lst-field st-grow"
                  type="number" min={1} step={1}
                  value={reportIntervalMin}
                  onChange={e => setReportIntervalMin(Math.max(1, parseInt(e.target.value) || 20))}
                  disabled={loading}
                />
                <div className="st-hint">Agent 每 3 秒隨心跳拿到最新設定，改了不用重啟 Agent</div>
              </div>

              <span className="st-l st-l--top">顯示欄位</span>
              <div className="st-checks">
                {REPORT_FIELD_META.map(f => (
                  <label key={f.key} className="st-chk">
                    <input
                      type="checkbox"
                      checked={reportFields[f.key]}
                      disabled={loading}
                      onChange={e => setReportFields(prev => ({ ...prev, [f.key]: e.target.checked }))}
                    />
                    {f.label}
                    {/* ⚠️ 有 hint 的欄位要把「它會查什麼、查不到時怎麼顯示」講出來——
                        看不出差別的開關，使用者只會憑感覺關掉 */}
                    {f.hint && <span className="st-info" title={f.hint}>ⓘ</span>}
                  </label>
                ))}
              </div>

              <label className="st-l st-l--top" htmlFor="asn-note">自訂欄位（選填）</label>
              <textarea
                id="asn-note"
                className="lst-field st-ta"
                value={reportCustomNote}
                onChange={e => setReportCustomNote(e.target.value)}
                placeholder="會原樣附加在每則彙總報告的最下方，例如備註、負責人、環境標籤等"
                disabled={loading}
                rows={2}
              />

              <span className="st-l" />
              <div className="st-sw">
                <ToggleSwitch checked={reportAiEnabled} disabled={loading} onToggle={() => setReportAiEnabled(v => !v)} />
                <div>
                  <div className="st-sw-label">啟用 AI 分析區塊</div>
                  <div className="st-hint">關閉時完全不呼叫 Gemini，零額外開銷；開啟才會在報告最下方加一段「AI 分析」判斷是否異常</div>
                </div>
              </div>
            </div>
            <div className="st-actions">
              <button
                className="btn-ghost lst-btn"
                onClick={handleTestReport}
                disabled={reportTesting || loading}
                title="用假資料送一則測試彙總報告，確認格式與效果"
              >
                {reportTesting ? '送出中…' : '試發送'}
              </button>
              <button
                className="submit-btn lst-btn"
                onClick={handleSaveReportSettings}
                disabled={reportSaving || loading || !reportDirty}
              >
                {reportSaving ? '儲存中…' : '儲存彙總報告設定'}
              </button>
            </div>
            {reportMsg && <div className={`discord-notify-msg ${reportMsg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{reportMsg.text}</div>}
          </section>

          <section className="section-card st-card">
            <h2 className="section-title">狀態生命週期</h2>
            <p className="st-note">
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
          </section>
        </div>

        {/* Right: 預覽 */}
        <section className="section-card st-card st-asn-preview">
          <h2 className="section-title">訊息預覽</h2>
          <p className="st-note">卡片內容示意（實際發到 Lark，排版會是 Lark 卡片樣式）</p>
          <div className="st-pv">
            <div className="st-pv-title">
              {(titleTemplate || DEFAULT_TITLE_TEMPLATE).replace('{machineType}', 'JJBXGRAND_01')}
            </div>
            <dl className="st-kv">
              <dt>狀態</dt><dd>執行中</dd>
              {fields.spinCount && <><dt>Spin 數</dt><dd>128</dd></>}
              {fields.gameUrl && <><dt>Game URL</dt><dd>https://qat-cp.osmslot.org/game/...</dd></>}
              {fields.errorSummary && <><dt>錯誤摘要</dt><dd>（有異常時才會顯示內容）</dd></>}
              {fields.screenshotUrl && <><dt>截圖</dt><dd>https://.../screenshot/xxx/JJBXGRAND_01_128.png</dd></>}
            </dl>
            <div className="st-pv-foot">
              {footer ? `${footer} • ` : ''}今天 14:32
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

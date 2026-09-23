import { useCallback, useEffect, useState } from 'react'

/**
 * 排程提醒（時辰法旨）配置頁。
 *
 * app id / secret 刻意不在這裡——它們走 `LARK_APP_ID` / `LARK_APP_SECRET` 環境變數，
 * 跟專案既有作法一致。密鑰進了 DB 或 git 歷史就永久留在那裡。
 */

type Settings = {
  enabled: boolean
  chatId: string
  chatAllowlist: string[]
  baseToken: string
  schedTable: string
  ruleTable: string
  schedView: string
  baseHost: string
  tz: string
  expandDays: number
  staleHours: number
  interactiveButton: boolean
}

type TickInfo = { pushed: number; stale: number; announced: number; expanded: number; error?: string; at: number }

type RecordRow = {
  recordId: string
  name: string
  start: number | null
  status: string
  pushedAt: number | null
  doneBy: string
}

const STATUS_COLOR: Record<string, string> = {
  待辦: '#6b7280',
  已完成: '#22c55e',
  已取消: '#9ca3af',
  已逾期: '#ef4444',
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

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6,
  border: '1px solid #3a4552', background: '#131a23', color: '#e5e7eb',
  fontSize: 13, fontFamily: 'inherit',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4,
}

const cardStyle: React.CSSProperties = {
  background: '#0f151d', border: '1px solid #253040', borderRadius: 10,
  padding: 16, marginBottom: 16,
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

const fmt = (ms: number | null) =>
  ms == null ? '—' : new Date(ms).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * ⚠️ 不能直接 `.then(r => r.json())`。後端還沒重啟、路由不存在時，回來的是 SPA 的
 * index.html，`json()` 會丟 SyntaxError 變成 unhandled rejection——畫面永遠停在
 * 「載入中…」，只有 console 有一行看不懂的 JSON.parse 錯誤。要回可讀的訊息。
 */
async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    return { ok: false, message: `連不上伺服器：${e instanceof Error ? e.message : String(e)}` }
  }
  const text = await res.text()
  if (text.trimStart().startsWith('<')) {
    return { ok: false, message: `後端沒有這個路由（${res.status}）——server 可能還沒重啟到有排程提醒的版本` }
  }
  try {
    return { ok: true, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, message: `回應不是 JSON（${res.status}）：${text.slice(0, 80)}` }
  }
}

export function LarkSchedulePage() {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [tick, setTick] = useState<TickInfo | null>(null)
  const [callbackConfigured, setCallbackConfigured] = useState(false)
  const [rows, setRows] = useState<RecordRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const load = useCallback(async () => {
    const r = await api<{ ok: boolean; settings: Settings; lastTick: TickInfo | null; callbackConfigured: boolean }>(
      '/api/lark-schedule/settings')
    if (r.ok && r.data.ok) {
      setS(r.data.settings)
      setSaved(r.data.settings)
      setTick(r.data.lastTick)
      setCallbackConfigured(r.data.callbackConfigured)
    } else if (!r.ok) {
      setMsg({ text: r.message, ok: false })
    }
    setLoading(false)
  }, [])

  const loadRows = useCallback(async () => {
    const r = await api<{ ok: boolean; items: RecordRow[] }>('/api/lark-schedule/records')
    if (r.ok && r.data.ok) setRows(r.data.items)
  }, [])

  useEffect(() => { void load(); void loadRows() }, [load, loadRows])

  const dirty = s && saved && JSON.stringify(s) !== JSON.stringify(saved)

  const patch = (p: Partial<Settings>) => setS(prev => (prev ? { ...prev, ...p } : prev))

  const save = async () => {
    if (!s) return
    setBusy('save')
    try {
      const r = await api<{ ok: boolean; settings: Settings; message?: string }>('/api/lark-schedule/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      })
      if (!r.ok) { setMsg({ text: r.message, ok: false }); return }
      if (r.data.ok) { setS(r.data.settings); setSaved(r.data.settings); setMsg({ text: '已儲存', ok: true }) }
      else setMsg({ text: r.data.message ?? '儲存失敗', ok: false })
    } finally { setBusy(null) }
  }

  type ActResult = {
    ok: boolean; message?: string; created?: number; messageId?: string
    summary?: { pushed: number; announced: number; stale: number; expanded: number; error?: string }
  }

  const act = async (path: string, label: string) => {
    setBusy(path)
    try {
      const r = await api<ActResult>(`/api/lark-schedule/${path}`, { method: 'POST' })
      if (!r.ok) { setMsg({ text: r.message, ok: false }); return }
      const d = r.data
      if (d.ok) {
        const detail = d.summary
          ? `推播 ${d.summary.pushed}、回報 ${d.summary.announced}、逾期 ${d.summary.stale}、展開 ${d.summary.expanded}`
          : d.created != null ? `新建 ${d.created} 筆`
          : d.messageId ? `已送出（${d.messageId}）` : ''
        setMsg({ text: `${label}完成${detail ? ` — ${detail}` : ''}`, ok: true })
        void load(); void loadRows()
      } else {
        setMsg({ text: d.message ?? d.summary?.error ?? `${label}失敗`, ok: false })
      }
    } finally { setBusy(null) }
  }

  if (loading || !s) return <div style={{ padding: 24, color: '#9ca3af' }}>載入中…</div>

  return (
    <div style={{ padding: '4px 0 32px', color: '#e5e7eb', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 19 }}>排程提醒</h2>
        <ToggleSwitch checked={s.enabled} disabled={busy === 'save'} onToggle={() => patch({ enabled: !s.enabled })} />
        <span style={{ fontSize: 12, color: s.enabled ? 'var(--xx-jade, #75d7cf)' : '#6b7280' }}>
          {s.enabled ? '執行中' : '已停用'}
        </span>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: 12.5, color: '#9ca3af', lineHeight: 1.7 }}>
        多維表格當行程表（日曆視圖排程）→ 到點把卡片推進 Lark 群 → 點卡片上的「完成」直接回寫狀態。<br />
        週期性行程寫在「週期規則」表，每天自動展開未來 {s.expandDays} 天。
      </p>

      {msg && (
        <div style={{
          ...cardStyle, padding: '10px 14px', marginBottom: 14,
          borderColor: msg.ok ? '#1f6f4a' : '#7f1d1d',
          background: msg.ok ? '#0e1f18' : '#1f1315',
          color: msg.ok ? '#86efac' : '#fca5a5', fontSize: 13,
        }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(360px, 1.1fr)', gap: 16, alignItems: 'start' }}>
        <div>
          <div style={cardStyle}>
            <h3 style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--xx-jade, #75d7cf)' }}>推播目標</h3>
            <Field label="Lark 群 chat_id" hint="點名發送。不在白名單內的 chat_id 一律拒發——這隻 app 與其他群共用。">
              <input style={fieldStyle} value={s.chatId} onChange={e => patch({ chatId: e.target.value })} placeholder="oc_..." />
            </Field>
            <Field label="白名單" hint="儲存時會自動把上面的 chat_id 補進來。">
              <input
                style={fieldStyle}
                value={s.chatAllowlist.join(', ')}
                onChange={e => patch({ chatAllowlist: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })}
                placeholder="oc_..., oc_..."
              />
            </Field>
            <button
              type="button"
              onClick={() => void act('test', '測試發送')}
              disabled={busy !== null || !s.chatId}
              style={{ ...fieldStyle, width: 'auto', cursor: 'pointer', background: '#1c2836', borderColor: '#3a4552' }}
            >
              {busy === 'test' ? '發送中…' : '發一張測試卡片'}
            </button>
          </div>

          <div style={cardStyle}>
            <h3 style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--xx-jade, #75d7cf)' }}>多維表格</h3>
            <Field label="Base token" hint="網址裡 /base/ 後面那一段">
              <input style={fieldStyle} value={s.baseToken} onChange={e => patch({ baseToken: e.target.value })} />
            </Field>
            <Field label="行程表 table_id">
              <input style={fieldStyle} value={s.schedTable} onChange={e => patch({ schedTable: e.target.value })} placeholder="tbl..." />
            </Field>
            <Field label="週期規則表 table_id" hint="留空則不做週期展開，只跑一次性行程。">
              <input style={fieldStyle} value={s.ruleTable} onChange={e => patch({ ruleTable: e.target.value })} placeholder="tbl..." />
            </Field>
            <Field label="日曆視圖 view_id" hint="卡片上「開啟記錄」按鈕會跳到這個視圖。">
              <input style={fieldStyle} value={s.schedView} onChange={e => patch({ schedView: e.target.value })} placeholder="vew..." />
            </Field>
            <Field label="Base 網域">
              <input style={fieldStyle} value={s.baseHost} onChange={e => patch({ baseHost: e.target.value })} />
            </Field>
          </div>

          <div style={cardStyle}>
            <h3 style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--xx-jade, #75d7cf)' }}>行為</h3>
            <Field label="時區" hint="週期規則的「開始時刻」以這個時區解讀。">
              <input style={fieldStyle} value={s.tz} onChange={e => patch({ tz: e.target.value })} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="展開天數">
                <input type="number" style={fieldStyle} value={s.expandDays}
                  onChange={e => patch({ expandDays: Number(e.target.value) || 14 })} />
              </Field>
              <Field label="逾期門檻（小時）" hint="開始時間過了這麼久就不推，只標記逾期。">
                <input type="number" style={fieldStyle} value={s.staleHours}
                  onChange={e => patch({ staleHours: Number(e.target.value) || 6 })} />
              </Field>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 4 }}>
              <ToggleSwitch checked={s.interactiveButton} onToggle={() => patch({ interactiveButton: !s.interactiveButton })} />
              <div>
                <div style={{ fontSize: 13 }}>卡片放「✅ 完成」互動按鈕</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3, lineHeight: 1.6 }}>
                  需要先在開發者後台的 <b>回調配置</b>（不是事件配置）填入回調網址。
                  {callbackConfigured
                    ? <span style={{ color: '#86efac' }}> 環境變數已設定。</span>
                    : <span style={{ color: '#fbbf24' }}> 尚未設定 LARK_CALLBACK_ENCRYPT_KEY / VERIFICATION_TOKEN，按鈕點了不會有反應。</span>}
                  <br />關閉時卡片只放「開啟記錄」連結，點進表格改狀態，群裡一樣會自動回報。
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button" onClick={() => void save()} disabled={!dirty || busy !== null}
              style={{
                ...fieldStyle, width: 'auto', cursor: dirty ? 'pointer' : 'default',
                background: dirty ? 'var(--xx-jade, #75d7cf)' : '#1c2836',
                color: dirty ? '#0b1116' : '#6b7280',
                borderColor: dirty ? 'var(--xx-jade, #75d7cf)' : '#3a4552', fontWeight: 600,
              }}
            >
              {busy === 'save' ? '儲存中…' : dirty ? '儲存設定' : '已是最新'}
            </button>
            <button type="button" onClick={() => void act('tick', '手動跑一輪')} disabled={busy !== null}
              style={{ ...fieldStyle, width: 'auto', cursor: 'pointer', background: '#1c2836' }}>
              {busy === 'tick' ? '執行中…' : '手動跑一輪'}
            </button>
            <button type="button" onClick={() => void act('expand', '展開週期規則')} disabled={busy !== null || !s.ruleTable}
              style={{ ...fieldStyle, width: 'auto', cursor: 'pointer', background: '#1c2836' }}>
              {busy === 'expand' ? '展開中…' : '展開週期規則'}
            </button>
          </div>
        </div>

        <div>
          <div style={cardStyle}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--xx-jade, #75d7cf)' }}>最近一輪</h3>
            {tick ? (
              <div style={{ fontSize: 12.5, lineHeight: 1.9, color: '#9ca3af' }}>
                <div>時間：{fmt(tick.at)}</div>
                <div>推播 {tick.pushed} · 回報 {tick.announced} · 逾期 {tick.stale} · 展開 {tick.expanded}</div>
                {tick.error && <div style={{ color: '#fca5a5' }}>錯誤：{tick.error}</div>}
              </div>
            ) : <div style={{ fontSize: 12.5, color: '#6b7280' }}>尚未跑過</div>}
          </div>

          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: 'var(--xx-jade, #75d7cf)' }}>行程一覽（{rows.length}）</h3>
              <button type="button" onClick={() => void loadRows()}
                style={{ ...fieldStyle, width: 'auto', padding: '4px 10px', fontSize: 12, cursor: 'pointer', background: '#1c2836' }}>
                重新整理
              </button>
            </div>
            {rows.length === 0 ? (
              <div style={{ fontSize: 12.5, color: '#6b7280' }}>沒有資料，或尚未設定表格位置。</div>
            ) : (
              <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ color: '#6b7280', textAlign: 'left' }}>
                      <th style={{ padding: '6px 4px', fontWeight: 500 }}>開始</th>
                      <th style={{ padding: '6px 4px', fontWeight: 500 }}>行程</th>
                      <th style={{ padding: '6px 4px', fontWeight: 500 }}>狀態</th>
                      <th style={{ padding: '6px 4px', fontWeight: 500 }}>已推</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.recordId} style={{ borderTop: '1px solid #1c2430' }}>
                        <td style={{ padding: '6px 4px', color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmt(r.start)}</td>
                        <td style={{ padding: '6px 4px' }}>
                          {r.name || <span style={{ color: '#4b5563' }}>(未命名)</span>}
                          {r.doneBy && <span style={{ color: '#6b7280', marginLeft: 6 }}>· {r.doneBy}</span>}
                        </td>
                        <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>
                          <span style={{ color: STATUS_COLOR[r.status] ?? '#9ca3af' }}>● </span>
                          {r.status || '—'}
                        </td>
                        <td style={{ padding: '6px 4px', color: r.pushedAt ? '#75d7cf' : '#4b5563' }}>
                          {r.pushedAt ? '✓' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

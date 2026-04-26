import { useEffect, useState, useRef } from 'react'
import Portal from './Portal'

interface GeminiKey { label: string; keyMasked: string; isEnv?: boolean }
interface GeminiPrompt { id: string; name: string; template: string; category: string }
interface KeyStat { label: string; calls_today: number; calls_total: number; last_used_at: number | null; last_error: string | null; last_error_at: number | null; stats_date: string }
interface ProbeResult { label: string; status: 'ok' | 'exhausted' | 'invalid' | 'error'; message: string }

interface Props { onClose: () => void }

export default function GeminiSettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<'keys' | 'prompts' | 'openai'>('keys')

  // ─── OpenAI Key ───────────────────────────────────────────────────────────
  const [openaiKeySet, setOpenaiKeySet] = useState(false)
  const [openaiKeyMasked, setOpenaiKeyMasked] = useState('')
  const [openaiKeyInput, setOpenaiKeyInput] = useState('')
  const [openaiMsg, setOpenaiMsg] = useState('')

  const fetchOpenAIKey = async () => {
    const r = await fetch('/api/openai/key')
    const d = await r.json() as { ok: boolean; isSet: boolean; keyMasked?: string }
    setOpenaiKeySet(d.isSet)
    setOpenaiKeyMasked(d.keyMasked ?? '')
  }

  useEffect(() => { fetchOpenAIKey() }, [])

  const handleSaveOpenAIKey = async () => {
    if (!openaiKeyInput.trim()) return
    const r = await fetch('/api/openai/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: openaiKeyInput.trim() }),
    })
    const d = await r.json()
    if (d.ok) { setOpenaiKeyInput(''); setOpenaiMsg('✅ 已儲存'); fetchOpenAIKey() }
    else setOpenaiMsg('❌ 儲存失敗')
  }

  const handleDeleteOpenAIKey = async () => {
    if (!confirm('確定移除 OpenAI API Key？')) return
    await fetch('/api/openai/key', { method: 'DELETE' })
    setOpenaiMsg('已移除')
    fetchOpenAIKey()
  }

  // ─── Keys ─────────────────────────────────────────────────────────────────
  const [keys, setKeys] = useState<GeminiKey[]>([])
  const [nextRrLabel, setNextRrLabel] = useState<string | null>(null)
  const [dailyLimit, setDailyLimit] = useState(1500)
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [keyMsg, setKeyMsg] = useState('')
  const [keyLoading, setKeyLoading] = useState(false)
  const [keyStats, setKeyStats] = useState<KeyStat[]>([])
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({})
  const [probing, setProbing] = useState(false)

  const fetchKeys = async () => {
    const r = await fetch('/api/gemini/keys')
    const d = await r.json()
    setKeys(d.keys ?? [])
    setNextRrLabel(d.nextRrLabel ?? null)
  }

  const fetchStats = async () => {
    const r = await fetch('/api/gemini/key-stats')
    const d = await r.json() as { stats?: KeyStat[] }
    setKeyStats(d.stats ?? [])
  }

  const handleProbe = async () => {
    setProbing(true)
    try {
      const r = await fetch('/api/gemini/probe', { method: 'POST' })
      const d = await r.json() as { results?: ProbeResult[] }
      const map: Record<string, ProbeResult> = {}
      d.results?.forEach(r => { map[r.label] = r })
      setProbeResults(map)
      fetchStats()
    } finally {
      setProbing(false)
    }
  }

  useEffect(() => { fetchKeys(); fetchStats(); handleProbe() }, [])

  const handleAddKey = async () => {
    if (!newKeyLabel.trim() || !newKeyValue.trim()) return
    setKeyLoading(true)
    setKeyMsg('')
    const r = await fetch('/api/gemini/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newKeyLabel.trim(), key: newKeyValue.trim() }),
    })
    const d = await r.json()
    setKeyMsg(d.ok ? '✅ 已新增' : `❌ ${d.message}`)
    if (d.ok) { setNewKeyLabel(''); setNewKeyValue(''); fetchKeys() }
    setKeyLoading(false)
  }

  const handleDeleteKey = async (label: string) => {
    if (!confirm(`確定刪除「${label}」？`)) return
    await fetch(`/api/gemini/keys/${encodeURIComponent(label)}`, { method: 'DELETE' })
    fetchKeys()
  }

  // ─── Prompts ───────────────────────────────────────────────────────────────
  const [prompts, setPrompts] = useState<GeminiPrompt[]>([])
  const [editPrompt, setEditPrompt] = useState<GeminiPrompt | null>(null)
  const [promptMsg, setPromptMsg] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const fetchPrompts = async () => {
    const r = await fetch('/api/gemini/prompts')
    const d = await r.json()
    setPrompts(d.prompts ?? [])
  }

  useEffect(() => { fetchPrompts() }, [])

  const handleSelectPrompt = (p: GeminiPrompt) => {
    setEditPrompt({ ...p })
    setPromptMsg('')
  }

  const handleNewPrompt = () => {
    const id = `prompt_${Date.now()}`
    setEditPrompt({ id, name: '新 Prompt', template: '', category: '' })
    setPromptMsg('')
  }

  const handleSavePrompt = async () => {
    if (!editPrompt) return
    if (!editPrompt.name.trim() || !editPrompt.template.trim()) {
      setPromptMsg('❌ 名稱與模板不可空白')
      return
    }
    const r = await fetch('/api/gemini/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...editPrompt, category: editPrompt.category ?? '' }),
    })
    const d = await r.json()
    setPromptMsg(d.ok ? '✅ 已儲存' : '❌ 儲存失敗')
    if (d.ok) fetchPrompts()
  }

  const handleDeletePrompt = async (id: string) => {
    if (id === 'default') { setPromptMsg('❌ 預設模板不可刪除'); return }
    if (!confirm('確定刪除此 Prompt？')) return
    await fetch(`/api/gemini/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setEditPrompt(null)
    fetchPrompts()
  }

  // 自動調整 textarea 高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }, [editPrompt?.template])

  return (
    <Portal>
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ width: 780, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h2>⚙️ AI 模型設定</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Tab */}
        <div style={{ display: 'flex', gap: 8, padding: '0 20px', borderBottom: '1px solid #e5e7eb' }}>
          {([
            { id: 'keys', label: '🔑 Gemini Keys' },
            { id: 'openai', label: '🤖 OpenAI Key' },
            { id: 'prompts', label: '📝 Prompt 模板' },
          ] as { id: 'keys' | 'prompts' | 'openai'; label: string }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '10px 18px',
                background: 'none',
                border: 'none',
                borderBottom: tab === t.id ? '2px solid #6366f1' : '2px solid transparent',
                color: tab === t.id ? '#6366f1' : '#6b7280',
                fontWeight: tab === t.id ? 700 : 400,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* ── API Keys Tab ── */}
          {tab === 'keys' && (
            <div>
              <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 12 }}>
                可新增多組 Gemini API Key，配額用完時系統自動切換下一組。
                優先使用此清單中的 Key；若清單為空，則使用 <code>.env</code> 中的 <code>GEMINI_API_KEY</code>。
              </p>

              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  placeholder="名稱（如 Key-1）"
                  value={newKeyLabel}
                  onChange={e => setNewKeyLabel(e.target.value)}
                  style={{ flex: '0 0 140px', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                />
                <input
                  placeholder="API Key（AIzaSy...）"
                  value={newKeyValue}
                  onChange={e => setNewKeyValue(e.target.value)}
                  type="password"
                  style={{ flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                />
                <button
                  onClick={handleAddKey}
                  disabled={keyLoading}
                  style={{ padding: '7px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                >
                  新增
                </button>
              </div>
              {keyMsg && <p style={{ fontSize: 13, marginBottom: 8 }}>{keyMsg}</p>}

              {keys.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <button
                    onClick={handleProbe}
                    disabled={probing}
                    style={{ padding: '5px 14px', background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                  >
                    {probing ? '測試中...' : '🔍 測試所有 Key 可用性'}
                  </button>
                </div>
              )}

              {keys.length === 0 ? (
                <p style={{ color: '#9ca3af', fontSize: 13 }}>尚無任何 Key（請新增或在 .env 設定 GEMINI_API_KEY）</p>
              ) : (
                <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12, color: '#6b7280' }}>
                  <span>每日上限（RPD）：</span>
                  <input
                    type="number" min={1} value={dailyLimit}
                    onChange={e => setDailyLimit(Math.max(1, parseInt(e.target.value) || 1500))}
                    style={{ width: 80, padding: '3px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12 }}
                  />
                  <span style={{ color: '#9ca3af' }}>Free tier = 1500，Paid = 依方案而定</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                      <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>名稱</th>
                      <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Key（遮罩）</th>
                      <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>狀態</th>
                      <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>上次使用</th>
                      <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k, i) => {
                      const stat = keyStats.find(s => s.label === k.label)
                      const probe = probeResults[k.label]
                      const isQuotaHit = (stat?.last_error === 'RESOURCE_EXHAUSTED' || stat?.last_error === '429') && probe?.status !== 'ok'
                      const quotaHitTime = isQuotaHit && stat?.last_error_at
                        ? new Date(stat.last_error_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                        : null
                      const statusBadge = probe
                        ? probe.status === 'ok'
                          ? <span style={{ color: '#16a34a', fontWeight: 600 }}>✅ 可用</span>
                          : probe.status === 'exhausted'
                          ? <span style={{ color: '#dc2626', fontWeight: 600 }}>❌ 配額耗盡</span>
                          : <span style={{ color: '#d97706', fontWeight: 600 }}>⚠️ {probe.message}</span>
                        : probing
                        ? <span style={{ color: '#6b7280', fontSize: 11 }}>🔄 測試中...</span>
                        : stat?.last_error
                        ? <span style={{ color: '#d97706', fontSize: 11 }} title={stat.last_error}>⚠️ 上次失敗</span>
                        : <span style={{ color: '#9ca3af', fontSize: 11 }}>— 未測試</span>
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                            {k.label}
                            {k.isEnv && <span style={{ marginLeft: 6, padding: '1px 6px', background: '#e0f2fe', color: '#0369a1', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>.env</span>}
                            {nextRrLabel === k.label && <span style={{ marginLeft: 6, padding: '1px 6px', background: '#d1fae5', color: '#065f46', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>▶ 下一個</span>}
                          </td>
                          <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: '#6b7280' }}>{k.keyMasked}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{statusBadge}</td>
                          <td style={{ padding: '8px 10px', fontSize: 11, whiteSpace: 'nowrap' }}>
                            <div style={{ color: stat?.last_used_at ? '#374151' : '#d1d5db' }}>
                              {stat?.last_used_at
                                ? new Date(stat.last_used_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                                : '—'}
                            </div>
                            {quotaHitTime && (
                              <div style={{ marginTop: 2, color: '#dc2626', fontSize: 10 }} title="上次配額耗盡時間">
                                ⛔ 配額耗盡 {quotaHitTime}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                            {!k.isEnv && (
                              <button
                                onClick={() => handleDeleteKey(k.label)}
                                style={{ padding: '4px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
                              >
                                刪除
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </>
              )}
            </div>
          )}

          {/* ── OpenAI Tab ── */}
          {tab === 'openai' && (
            <div>
              <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>
                填入 OpenAI API Key 後，Model Selector 會自動出現 Codex Mini、GPT-5.3 Codex、GPT-4o 等選項。
                Key 儲存於後端 DB，不寫入 <code>.env</code>。
              </p>

              {openaiKeySet ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: '12px 16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8 }}>
                  <span style={{ fontSize: 13, color: '#15803d', fontWeight: 600 }}>✅ API Key 已設定</span>
                  <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: 13 }}>{openaiKeyMasked}</span>
                  <button
                    onClick={handleDeleteOpenAIKey}
                    style={{ marginLeft: 'auto', padding: '4px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                  >
                    移除
                  </button>
                </div>
              ) : (
                <div style={{ padding: '12px 16px', background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#854d0e' }}>
                  ⚠️ 尚未設定，填入 Key 後才會出現 OpenAI 模型選項
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  type="password"
                  placeholder="sk-proj-..."
                  value={openaiKeyInput}
                  onChange={e => setOpenaiKeyInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSaveOpenAIKey()}
                  style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                />
                <button
                  onClick={handleSaveOpenAIKey}
                  disabled={!openaiKeyInput.trim()}
                  style={{ padding: '8px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  {openaiKeySet ? '更新' : '儲存'}
                </button>
              </div>
              {openaiMsg && <p style={{ fontSize: 13, margin: 0 }}>{openaiMsg}</p>}

              <div style={{ marginTop: 20, padding: '12px 16px', background: '#f8fafc', borderRadius: 8, fontSize: 12, color: '#6b7280', lineHeight: 1.7 }}>
                <strong>取得 API Key：</strong> <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ color: '#6366f1' }}>platform.openai.com/api-keys</a><br />
                <strong>計費：</strong> Codex Mini — $1.50 / 1M input tokens，$6.00 / 1M output tokens（無免費額度，新帳號有試用 credit）
              </div>
            </div>
          )}

          {/* ── Prompts Tab ── */}
          {tab === 'prompts' && (
            <div style={{ display: 'flex', gap: 16, height: '100%' }}>
              {/* 左側清單（依分類分組） */}
              <div style={{ flex: '0 0 200px', borderRight: '1px solid #e5e7eb', paddingRight: 12, overflowY: 'auto' }}>
                <button
                  onClick={handleNewPrompt}
                  style={{ width: '100%', padding: '7px 0', marginBottom: 10, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                >
                  ＋ 新增模板
                </button>
                {(() => {
                  const grouped: Record<string, GeminiPrompt[]> = {}
                  for (const p of prompts) {
                    const cat = p.category?.trim() || '未分類'
                    ;(grouped[cat] ??= []).push(p)
                  }
                  return Object.entries(grouped).map(([cat, list]) => (
                    <div key={cat} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 6px 4px', marginBottom: 2 }}>
                        {cat}
                      </div>
                      {list.map(p => (
                        <div
                          key={p.id}
                          onClick={() => handleSelectPrompt(p)}
                          style={{
                            padding: '7px 10px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            marginBottom: 2,
                            background: editPrompt?.id === p.id ? '#ede9fe' : 'transparent',
                            color: editPrompt?.id === p.id ? '#6366f1' : '#374151',
                            fontWeight: editPrompt?.id === p.id ? 600 : 400,
                            fontSize: 13,
                          }}
                        >
                          {p.id === 'default' ? '⭐ ' : ''}{p.name}
                        </div>
                      ))}
                    </div>
                  ))
                })()}
              </div>

              {/* 右側編輯 */}
              {editPrompt ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      placeholder="模板名稱"
                      value={editPrompt.name}
                      onChange={e => setEditPrompt({ ...editPrompt, name: e.target.value })}
                      style={{ flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <span style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>ID: {editPrompt.id}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      placeholder="分類（如：TestCase 生成、QA 報告）"
                      value={editPrompt.category ?? ''}
                      onChange={e => setEditPrompt({ ...editPrompt, category: e.target.value })}
                      style={{ flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <span style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>分類（可自定）</span>
                  </div>

                  <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                    可用變數：<code>{'{{rawText}}'}</code> 原始驗證內容、<code>{'{{envBlock}}'}</code> 環境區塊、
                    <code>{'{{environment}}'}</code> <code>{'{{version}}'}</code> <code>{'{{platform}}'}</code>{' '}
                    <code>{'{{machineId}}'}</code> <code>{'{{gameMode}}'}</code>
                  </p>

                  <textarea
                    ref={textareaRef}
                    placeholder="在此輸入 Prompt 模板..."
                    value={editPrompt.template}
                    onChange={e => setEditPrompt({ ...editPrompt, template: e.target.value })}
                    style={{
                      flex: 1,
                      minHeight: 300,
                      padding: '10px 12px',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                      fontSize: 13,
                      lineHeight: 1.6,
                      resize: 'vertical',
                      fontFamily: 'monospace',
                    }}
                  />

                  {promptMsg && <p style={{ fontSize: 13, margin: 0 }}>{promptMsg}</p>}

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={handleSavePrompt}
                      style={{ flex: 1, padding: '9px 0', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                    >
                      💾 儲存
                    </button>
                    {editPrompt.id !== 'default' && (
                      <button
                        onClick={() => handleDeletePrompt(editPrompt.id)}
                        style={{ padding: '9px 16px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                      >
                        刪除
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 14 }}>
                  點選左側模板以編輯，或新增一個模板
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </Portal>
  )
}

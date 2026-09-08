import { useEffect, useState } from 'react'

type Quote = {
  id: string
  text: string
  source: string
  created_at: number
  last_used_cycle: number
}

type Suggestion = { text: string; source: string }

export function XianxiaQuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)
  const [newText, setNewText] = useState('')
  const [newSource, setNewSource] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editSource, setEditSource] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [suggestCount, setSuggestCount] = useState(5)
  /** 只從這部作品裡找。⚠️ 指定單一作品時模型的準確度明顯較高，也避開「一直重複那幾部」。 */
  const [onlySource, setOnlySource] = useState('')
  /** 這次被去重擋掉幾句——要顯示出來，安靜地少給會被誤會成「AI 很懶」。 */
  const [dropped, setDropped] = useState(0)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestError, setSuggestError] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = () => {
    setLoading(true)
    fetch('/api/xianxia/quotes')
      .then(r => r.json())
      .then((d: { ok: boolean; quotes?: Quote[] }) => setQuotes(d.quotes ?? []))
      .catch(() => setMsg({ ok: false, text: '讀取語錄庫失敗' }))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    if (!newText.trim()) return
    setAdding(true)
    setMsg(null)
    try {
      const res = await fetch('/api/xianxia/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newText.trim(), source: newSource.trim() }),
      }).then(r => r.json())
      if (res.ok) {
        setNewText('')
        setNewSource('')
        load()
        setMsg({ ok: true, text: '已新增' })
      } else {
        setMsg({ ok: false, text: res.message ?? '新增失敗' })
      }
    } catch {
      setMsg({ ok: false, text: '新增失敗' })
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (q: Quote) => {
    setEditingId(q.id)
    setEditText(q.text)
    setEditSource(q.source)
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editText.trim()) return
    setSavingEdit(true)
    try {
      const res = await fetch(`/api/xianxia/quotes/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: editText.trim(), source: editSource.trim() }),
      }).then(r => r.json())
      if (res.ok) {
        setEditingId(null)
        load()
      } else {
        setMsg({ ok: false, text: res.message ?? '儲存失敗' })
      }
    } catch {
      setMsg({ ok: false, text: '儲存失敗' })
    } finally {
      setSavingEdit(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('確定刪除這則語錄？')) return
    await fetch(`/api/xianxia/quotes/${id}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null)
    load()
  }

  const handleSuggest = async () => {
    setSuggesting(true)
    setSuggestError('')
    setSuggestions([])
    try {
      const res = await fetch('/api/xianxia/quotes/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: suggestCount, onlySource: onlySource.trim() || undefined }),
      }).then(r => r.json())
      if (res.ok) {
        setSuggestions(res.suggestions ?? [])
        setDropped(res.duplicatesDropped ?? 0)
        // ⚠️ 「一句都沒有」有兩種完全不同的原因，不能用同一句話帶過——
        //    全被去重擋掉時叫人「再試一次」是沒用的建議。
        if ((res.suggestions ?? []).length === 0) {
          setSuggestError(res.duplicatesDropped
            ? `這次 ${res.duplicatesDropped} 句全都是語錄庫已經有的，已自動擋掉。可以指定一部還沒收錄的作品再試。`
            : 'AI 沒有給出有信心的候選句子，可以再試一次或換個數量')
        }
      } else {
        setSuggestError(res.message ?? 'AI 建議失敗')
      }
    } catch {
      setSuggestError('AI 建議失敗')
    } finally {
      setSuggesting(false)
    }
  }

  const handleAcceptSuggestion = async (s: Suggestion, idx: number) => {
    const res = await fetch('/api/xianxia/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: s.text, source: s.source }),
    }).then(r => r.json()).catch(() => null)
    if (res?.ok) {
      setSuggestions(prev => prev.filter((_, i) => i !== idx))
      load()
    }
  }

  return (
    <div className="discord-notify-page">
      <div className="discord-notify-head">
        <div>
          <h1 className="discord-notify-title">每日仙語管理</h1>
          <p className="discord-notify-sub">
            Dashboard（修仙版）每天固定顯示一則語錄，抽選邏輯是「這一輪還沒抽過的裡面隨機挑」，整輪抽完才會重新洗牌，語錄庫可以隨時新增成長。
          </p>
        </div>
      </div>

      <div className="discord-notify-grid">
        <div>
          <div className="discord-notify-card">
            <div className="discord-notify-card-title">新增語錄</div>
            <div className="discord-notify-field" style={{ marginBottom: 10 }}>
              <textarea
                className="discord-notify-input"
                style={{ minHeight: 60, resize: 'vertical' }}
                placeholder="語錄內容"
                value={newText}
                onChange={e => setNewText(e.target.value)}
              />
            </div>
            <div className="discord-notify-field" style={{ marginBottom: 10 }}>
              <input
                className="discord-notify-input"
                placeholder="出處（例：凡人修仙傳）"
                value={newSource}
                onChange={e => setNewSource(e.target.value)}
              />
            </div>
            <div className="discord-notify-actions">
              <button
                className="discord-notify-btn discord-notify-btn--primary"
                onClick={handleAdd}
                disabled={adding || !newText.trim()}
              >
                {adding ? '新增中…' : '+ 新增'}
              </button>
            </div>
            {msg && <div className={`discord-notify-msg ${msg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{msg.text}</div>}
          </div>

          <div className="discord-notify-card" style={{ marginTop: 16 }}>
            <div className="discord-notify-card-title">AI 建議候選語錄</div>
            <p className="discord-notify-card-note">
              請 Gemini 幫忙生成候選語錄草稿——但這只是草稿，AI 可能編造根本不存在的句子或講錯出處，
              請自己確認出處真的存在才按「加入語錄庫」，不會自動幫你存進去。
              {/* ⚠️ 實測：指定單一作品又要 8 句時，回來的有好幾句是「小心駛得萬年船」
                  「斬草不除根」這類通用成語——不是那部作品的原創台詞，是模型為了湊滿
                  數量填的。數量越大湊數越明顯，這件事要講出來，不能讓人以為指定作品就可靠。 */}
              <br />
              <span style={{ color: '#ead8a6' }}>
                ⚠️ 數量拉太大時，AI 會用通用成語湊數（實測指定單一作品要 8 句就出現了）。
                一次 3~5 句、需要更多就多按幾次，品質會比較穩。
              </span>
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <input
                className="discord-notify-input"
                type="number"
                min={1}
                max={10}
                style={{ width: 70 }}
                value={suggestCount}
                onChange={e => setSuggestCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
              />
              {/* 指定作品是最有效的辦法——模型在單一作品上的準確度明顯高於「隨便給幾句」，
                  也是避開「一直重複那幾部」最直接的手段 */}
              <input
                className="discord-notify-input"
                style={{ flex: 1, minWidth: 0 }}
                placeholder="只從這部作品裡找（選填，例：遮天）"
                value={onlySource}
                onChange={e => setOnlySource(e.target.value)}
              />
              <button
                className="discord-notify-btn discord-notify-btn--secondary"
                onClick={handleSuggest}
                disabled={suggesting}
              >
                {suggesting ? 'AI 生成中…' : 'AI 建議'}
              </button>
            </div>
            {dropped > 0 && suggestions.length > 0 && (
              <div className="discord-notify-msg" style={{ fontSize: 12 }}>
                已自動擋掉 {dropped} 句語錄庫裡已經有的
              </div>
            )}
            {suggestError && <div className="discord-notify-msg discord-notify-msg--error">{suggestError}</div>}
            {suggestions.map((s, idx) => (
              <div key={idx} style={{ border: '1px solid #334155', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 13, marginBottom: 4 }}>{s.text}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>出處：{s.source || '（未標示）'}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="discord-notify-btn discord-notify-btn--primary" onClick={() => handleAcceptSuggestion(s, idx)}>加入語錄庫</button>
                  <button className="discord-notify-btn discord-notify-btn--secondary" onClick={() => setSuggestions(prev => prev.filter((_, i) => i !== idx))}>忽略</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="discord-notify-card">
            <div className="discord-notify-card-title">語錄庫（{quotes.length} 則）</div>
            {loading && <p className="discord-notify-card-note">載入中…</p>}
            {!loading && quotes.length === 0 && <p className="discord-notify-card-note">語錄庫是空的，先新增幾則吧。</p>}
            {quotes.map(q => (
              <div key={q.id} style={{ border: '1px solid #263345', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                {editingId === q.id ? (
                  <>
                    <textarea
                      className="discord-notify-input"
                      style={{ minHeight: 50, resize: 'vertical', marginBottom: 8, width: '100%' }}
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                    />
                    <input
                      className="discord-notify-input"
                      style={{ marginBottom: 8, width: '100%' }}
                      value={editSource}
                      onChange={e => setEditSource(e.target.value)}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="discord-notify-btn discord-notify-btn--primary" onClick={handleSaveEdit} disabled={savingEdit || !editText.trim()}>
                        {savingEdit ? '儲存中…' : '儲存'}
                      </button>
                      <button className="discord-notify-btn discord-notify-btn--secondary" onClick={() => setEditingId(null)}>取消</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, marginBottom: 4 }}>{q.text}</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                      出處：{q.source || '（未標示）'} · 已用於第 {q.last_used_cycle} 輪
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="discord-notify-btn discord-notify-btn--secondary" onClick={() => startEdit(q)}>編輯</button>
                      <button className="discord-notify-btn discord-notify-btn--secondary" onClick={() => handleDelete(q.id)}>刪除</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

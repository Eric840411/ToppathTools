import { useEffect, useState } from 'react'

type Quote = {
  id: string
  text: string
  source: string
  created_at: number
  last_used_cycle: number
}

type Suggestion = { text: string; source: string; hasTraditional?: boolean }

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
  /** 格式不符被丟掉的行數（模型的開場白那種）。同樣要顯示，不能安靜地少給。 */
  const [unparsed, setUnparsed] = useState(0)
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
        setUnparsed(res.unparsedDropped ?? 0)
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

  // 新版（原型 v7）：左欄「新增語錄」「AI 建議候選語錄」兩塊面板（標籤在左），右欄「語錄庫」卡片清單；版面樣式在 redesign/pages/settings.css 的 .st-xq-*
  return (
    <div className="discord-notify-page st-asn st-xq">
      <div className="discord-notify-head">
        <div>
          <h1 className="discord-notify-title">每日仙語管理</h1>
          <p className="discord-notify-sub">
            Dashboard（修仙版）每天固定顯示一則語錄，抽選邏輯是「這一輪還沒抽過的裡面隨機挑」，整輪抽完才會重新洗牌，語錄庫可以隨時新增成長。
          </p>
        </div>
      </div>

      <div className="st-xq-grid">
        <div className="st-col">
          <section className="section-card st-card">
            <h2 className="section-title">新增語錄</h2>
            <div className="st-form">
              <span className="st-l st-l--top">語錄內容</span>
              <textarea
                className="lst-field st-ta"
                placeholder="語錄內容"
                value={newText}
                onChange={e => setNewText(e.target.value)}
              />
              <span className="st-l">出處</span>
              <input
                className="lst-field"
                placeholder="例：凡人修仙傳"
                value={newSource}
                onChange={e => setNewSource(e.target.value)}
              />
            </div>
            <div className="st-actions">
              <button
                className="submit-btn lst-btn"
                onClick={handleAdd}
                disabled={adding || !newText.trim()}
              >
                {adding ? '新增中…' : '+ 新增'}
              </button>
            </div>
            {msg && <div className={`discord-notify-msg ${msg.ok ? 'discord-notify-msg--ok' : 'discord-notify-msg--error'}`}>{msg.text}</div>}
          </section>

          <section className="section-card st-card">
            <h2 className="section-title">AI 建議候選語錄</h2>
            <p className="st-note">
              請 Gemini 幫忙生成候選語錄草稿——但這只是草稿，AI 可能編造根本不存在的句子或講錯出處，
              請自己確認出處真的存在才按「加入語錄庫」，不會自動幫你存進去。
              {/* 實測：指定單一作品又要 8 句時，回來的有好幾句是「小心駛得萬年船」
                  「斬草不除根」這類通用成語——不是那部作品的原創台詞，是模型為了湊滿
                  數量填的。數量越大湊數越明顯，這件事要講出來，不能讓人以為指定作品就可靠。 */}
              <br />
              <span className="st-xq-warn">
                數量拉太大時，AI 會用通用成語湊數（實測指定單一作品要 8 句就出現了）。
                一次 3~5 句、需要更多就多按幾次，品質會比較穩。
              </span>
            </p>
            <div className="st-form">
              <span className="st-l">數量</span>
              <input
                className="lst-field st-xq-count"
                type="number"
                min={1}
                max={10}
                value={suggestCount}
                onChange={e => setSuggestCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
              />
              {/* 指定作品是最有效的辦法——模型在單一作品上的準確度明顯高於「隨便給幾句」，
                  也是避開「一直重複那幾部」最直接的手段 */}
              <span className="st-l">只從這部作品裡找</span>
              <input
                className="lst-field"
                placeholder="選填，例：遮天"
                value={onlySource}
                onChange={e => setOnlySource(e.target.value)}
              />
            </div>
            <div className="st-actions">
              <button
                className="submit-btn lst-btn"
                onClick={handleSuggest}
                disabled={suggesting}
              >
                {suggesting ? 'AI 生成中…' : 'AI 建議'}
              </button>
            </div>
            {unparsed > 0 && suggestions.length > 0 && (
              <p className="st-note st-xq-unparsed">
                另有 {unparsed} 行不符「台詞｜出處」格式已略過（多半是 AI 的開場白）
              </p>
            )}
            {dropped > 0 && suggestions.length > 0 && (
              <div className="discord-notify-msg st-xq-dropped">
                已自動擋掉 {dropped} 句語錄庫裡已經有的
              </div>
            )}
            {suggestError && <div className="discord-notify-msg discord-notify-msg--error">{suggestError}</div>}
            {suggestions.length > 0 && (
              <div className="st-xq-list st-xq-list--suggest">
                {suggestions.map((s, idx) => (
                  <div key={idx} className="st-xq-item">
                    <div className="st-xq-text">{s.text}</div>
                    <div className="st-xq-meta">
                      <span>出處：{s.source || '（未標示）'}</span>
                      {/* 只標示不自動轉換：改了字沒人看得出來，改錯一個字就變成
                          原著裡不存在的話。要不要用交給人決定。 */}
                      {s.hasTraditional && (
                        <span
                          className="st-xq-trad"
                          title="語錄庫統一用簡體，這句含繁體字。系統刻意不自動轉換——改錯一個字就會變成原著裡不存在的話。"
                        >繁體</span>
                      )}
                    </div>
                    <div className="st-xq-btns">
                      <button className="submit-btn lst-btn" onClick={() => handleAcceptSuggestion(s, idx)}>加入語錄庫</button>
                      <button className="btn-ghost lst-btn" onClick={() => setSuggestions(prev => prev.filter((_, i) => i !== idx))}>忽略</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="section-card st-card">
          <h2 className="section-title">語錄庫（{quotes.length} 則）</h2>
          {loading && <p className="st-note">載入中…</p>}
          {!loading && quotes.length === 0 && <p className="st-note">語錄庫是空的，先新增幾則吧。</p>}
          <div className="st-xq-list">
            {quotes.map(q => (
              <div key={q.id} className="st-xq-item">
                {editingId === q.id ? (
                  <>
                    <textarea
                      className="lst-field st-ta"
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                    />
                    <input
                      className="lst-field"
                      value={editSource}
                      onChange={e => setEditSource(e.target.value)}
                    />
                    <div className="st-xq-btns">
                      <button className="submit-btn lst-btn" onClick={handleSaveEdit} disabled={savingEdit || !editText.trim()}>
                        {savingEdit ? '儲存中…' : '儲存'}
                      </button>
                      <button className="btn-ghost lst-btn" onClick={() => setEditingId(null)}>取消</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="st-xq-text">{q.text}</div>
                    <div className="st-xq-meta">
                      出處：{q.source || '（未標示）'} · 已用於第 {q.last_used_cycle} 輪
                    </div>
                    <div className="st-xq-btns">
                      <button className="btn-ghost lst-btn" onClick={() => startEdit(q)}>編輯</button>
                      <button className="btn-ghost lst-btn st-btn--danger" onClick={() => handleDelete(q.id)}>刪除</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

import { useState, useRef, useCallback, useEffect } from 'react'
import { PageActions } from '../redesign/PageActions'

interface CheckResult {
  path: string
  found: boolean
  matchedUrl: string | null
}

interface CheckResponse {
  ok: boolean
  results: CheckResult[]
  loadedImageCount: number
  foundCount: number
  checkedCount: number
}

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|svg|gif|avif|bmp)$/i

function parseGitDiff(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    const nsMatch = t.match(/^D\t(.+)$/)
    if (nsMatch) { if (IMAGE_EXT.test(nsMatch[1])) paths.push(nsMatch[1]); continue }
    const stMatch = t.match(/^deleted:\s+(.+)$/)
    if (stMatch) { if (IMAGE_EXT.test(stMatch[1])) paths.push(stMatch[1]); continue }
    const guiMatch = t.match(/^deleted\b.+?\s{2,}(.+)$/)
    if (guiMatch) { const p = guiMatch[1].trim(); if (IMAGE_EXT.test(p)) paths.push(p); continue }
    const diffMatch = t.match(/^-{3}\s+a\/(.+)$/)
    if (diffMatch) { if (IMAGE_EXT.test(diffMatch[1])) paths.push(diffMatch[1]); continue }
    const anyPath = t.match(/(?:^|\s)((?:\S+\/)+\S+)$/)
    if (anyPath && IMAGE_EXT.test(anyPath[1])) paths.push(anyPath[1])
  }
  return [...new Set(paths)]
}

export function ImageCheckPage() {
  const [url, setUrl] = useState('')
  const [deletedList, setDeletedList] = useState('')
  const [gitDiffText, setGitDiffText] = useState('')
  const [showGitPaste, setShowGitPaste] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [liveCount, setLiveCount] = useState(0)
  const [screenshotTs, setScreenshotTs] = useState(0)
  const [result, setResult] = useState<CheckResponse | null>(null)
  const [error, setError] = useState('')
  const [screenshotParsing, setScreenshotParsing] = useState(false)
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  // Poll status + refresh screenshot while session active
  useEffect(() => {
    if (sessionId) {
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/image-check/status/${sessionId}`)
          const d = await r.json() as { ok: boolean; loadedImageCount: number }
          if (d.ok) setLiveCount(d.loadedImageCount)
        } catch { /* ignore */ }
        setScreenshotTs(Date.now())
      }, 1500)
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [sessionId])

  const handleParseDiff = () => {
    const parsed = parseGitDiff(gitDiffText)
    setDeletedList(parsed.join('\n'))
    setShowGitPaste(false)
    setGitDiffText('')
  }

  const parseScreenshot = useCallback(async (file: File) => {
    setScreenshotParsing(true)
    setScreenshotPreview(URL.createObjectURL(file))
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const r = await fetch('/api/image-check/parse-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type || 'image/png' }),
      })
      const d = await r.json() as { ok: boolean; paths: string[]; message?: string }
      if (d.ok && d.paths.length > 0) {
        setDeletedList(prev => {
          const existing = prev.trim() ? prev.trim().split('\n') : []
          return [...new Set([...existing, ...d.paths])].join('\n')
        })
      } else {
        alert(d.message ?? '未能識別任何已刪除路徑，請確認截圖清晰可見')
      }
    } catch (e) {
      alert(`截圖解析失敗：${String(e)}`)
    } finally {
      setScreenshotParsing(false)
    }
  }, [])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    if (item) {
      const file = item.getAsFile()
      if (file) { e.preventDefault(); parseScreenshot(file) }
    }
  }, [parseScreenshot])

  const handleStart = async () => {
    if (!url.trim() || !deletedList.trim()) return
    const deletedImages = deletedList.split('\n').map(l => l.trim()).filter(Boolean)
    setLoading(true)
    setResult(null)
    setError('')
    setLiveCount(0)
    setSessionId(null)
    setScreenshotTs(0)
    try {
      const r = await fetch('/api/image-check/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), deletedImages }),
      })
      const d = await r.json() as { ok: boolean; sessionId: string; message?: string }
      if (!d.ok) throw new Error(d.message ?? 'API 回傳失敗')
      setSessionId(d.sessionId)
    } catch (e) {
      setError(`啟動失敗：${String(e)}`)
      setLoading(false)
    }
  }

  const handleStop = async () => {
    if (!sessionId) return
    const sid = sessionId
    setSessionId(null)
    try {
      const r = await fetch(`/api/image-check/stop/${sid}`, { method: 'POST' })
      const d: CheckResponse = await r.json()
      if (!d.ok) throw new Error('API 回傳失敗')
      setResult(d)
    } catch (e) {
      setError(`取得結果失敗：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleBrowserClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!sessionId || !imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    await fetch(`/api/image-check/click/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    }).catch(() => {})
    setTimeout(() => setScreenshotTs(Date.now()), 400)
  }, [sessionId])

  const handleBrowserScroll = useCallback(async (e: React.WheelEvent<HTMLImageElement>) => {
    if (!sessionId || !imgRef.current) return
    e.preventDefault()
    const rect = imgRef.current.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    await fetch(`/api/image-check/scroll/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y, deltaY: e.deltaY }),
    }).catch(() => {})
    setTimeout(() => setScreenshotTs(Date.now()), 300)
  }, [sessionId])

  const stillLoaded = result?.results.filter(r => r.found) ?? []
  const confirmed = result?.results.filter(r => !r.found) ?? []

  // 新版（原型 v7）：左「輸入」右「結果」兩個面板、欄位標籤在左；樣式在 redesign/pages/osm.css 的 .ic-*。
  // 流程不變：輸入 → 虛擬瀏覽器 → 結果；輸入面板只在還沒開始時出現（跟原本一樣）
  const pathCount = deletedList.split('\n').filter(l => l.trim()).length
  const canStart = !loading && !!url.trim() && !!deletedList.trim()
  return (
    <div className="ic-page">
      {/* Input section — hide when session active */}
      {!sessionId && !result && (
        <div className="ic-grid">
          <section className="section-card ic-panel">
            <h3 className="section-title">輸入</h3>
            <div className="ic-row">
              <label className="ic-label" htmlFor="ic-url">前端 URL（含 token）</label>
              <input
                id="ic-url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://osm-redirect.osmslot.org/?token=xxx&gameid=xxx..."
                className="ic-input"
              />
            </div>

            <div className="ic-row ic-row--top">
              <span className="ic-label">已刪除圖片清單</span>
              <div className="ic-field">
                <div className="ic-tools">
                  <button type="button" className={`btn-ghost${showGitPaste ? ' is-on' : ''}`} onClick={() => setShowGitPaste(v => !v)}>貼上 git diff 文字解析</button>
                  <button type="button" className="btn-ghost" onClick={() => fileInputRef.current?.click()}>上傳截圖 AI 識別</button>
                  <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) parseScreenshot(f); e.target.value = '' }} />
                </div>

                <div onPaste={handlePaste} className="ic-paste" tabIndex={0}>
                  {screenshotParsing ? <span>Gemini 識別中...</span>
                    : screenshotPreview ? <><img src={screenshotPreview} alt="" style={{ height: 40, borderRadius: 4 }} /><span>已解析，路徑已填入</span></>
                    : <span>或直接 Ctrl+V 貼上 git diff 截圖（Gemini 自動識別）</span>}
                </div>

                {showGitPaste && (
                  <div className="ic-gitpaste">
                    <div className="ic-hint">支援 git diff --name-status / git status / GUI 格式</div>
                    <textarea value={gitDiffText} onChange={e => setGitDiffText(e.target.value)}
                      placeholder={'D\tassets/resources/jackpot/aruze1.png\n...'} rows={5} className="ic-input ic-mono" />
                    <div className="ic-tools">
                      <button type="button" className="submit-btn submit-btn--sm" onClick={handleParseDiff} disabled={!gitDiffText.trim()}>
                        解析並填入 ({parseGitDiff(gitDiffText).length} 個)
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => { setShowGitPaste(false); setGitDiffText('') }}>取消</button>
                    </div>
                  </div>
                )}

                <textarea value={deletedList} onChange={e => setDeletedList(e.target.value)}
                  placeholder={'assets/resources/jackpot/aruze1.png\n...'} rows={6} className="ic-input ic-mono" />
              </div>
            </div>

            <div className="ic-actions">
              <span className="ic-hint">{pathCount} 個路徑</span>
              <button type="button" className="submit-btn submit-btn--sm" onClick={handleStart} disabled={!canStart}>
                {loading ? '啟動中...' : '開始偵測'}
              </button>
            </div>
          </section>

          <section className="section-card ic-panel">
            <h3 className="section-title">結果</h3>
            <div className="ic-empty">開始偵測、在虛擬瀏覽器操作完按「完成」後，結果會顯示在這裡</div>
          </section>
        </div>
      )}

      {error && <div className="ic-error">{error}</div>}

      {/* Virtual browser panel */}
      {sessionId && (
        <section className="section-card ic-panel">
          <div className="ic-toolbar">
            <span className="ic-live">已攔截 <strong>{liveCount}</strong> 個圖片請求</span>
            <span className="ic-hint">可點擊畫面操作遊戲 · 滾輪捲動 · 畫面每 1.5 秒自動更新</span>
            <button type="button" className="submit-btn submit-btn--sm ic-push" onClick={handleStop}>完成，取得結果</button>
          </div>
          <div className="ic-browser">
            {screenshotTs > 0 ? (
              <img
                ref={imgRef}
                src={`/api/image-check/screenshot/${sessionId}?t=${screenshotTs}`}
                alt="browser"
                onClick={handleBrowserClick}
                onWheel={handleBrowserScroll}
                style={{ width: '100%', display: 'block', userSelect: 'none' }}
                draggable={false}
              />
            ) : (
              <div className="ic-empty">載入中...</div>
            )}
          </div>
        </section>
      )}

      {/* Results */}
      {result && (
        <>
          <div className="ic-stats">
            <div className={`ic-stat ${stillLoaded.length > 0 ? 'is-bad' : 'is-ok'}`}>
              <div className="ic-stat-label">仍在載入（需確認）</div>
              <div className="ic-stat-value">{stillLoaded.length}</div>
            </div>
            <div className="ic-stat is-ok">
              <div className="ic-stat-label">已確認刪除</div>
              <div className="ic-stat-value">{confirmed.length}</div>
            </div>
            <div className="ic-stat">
              <div className="ic-stat-label">頁面共載入圖片數</div>
              <div className="ic-stat-value">{result.loadedImageCount}</div>
            </div>
          </div>

          {stillLoaded.length > 0 && (
            <section className="section-card ic-panel">
              <h3 className="section-title">仍被載入（{stillLoaded.length} 個）</h3>
              <div className="table-wrap">
                <table className="version-table">
                  <thead><tr><th>路徑</th><th>對應到的請求</th></tr></thead>
                  <tbody>
                    {stillLoaded.map(r => (
                      <tr key={r.path}><td className="ic-mono ic-bad">{r.path}</td><td className="ic-mono">{r.matchedUrl || '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {confirmed.length > 0 && (
            <section className="section-card ic-panel">
              <h3 className="section-title">已確認刪除（{confirmed.length} 個）</h3>
              <div className="table-wrap">
                <table className="version-table">
                  <thead><tr><th>路徑</th></tr></thead>
                  <tbody>{confirmed.map(r => <tr key={r.path}><td className="ic-mono">{r.path}</td></tr>)}</tbody>
                </table>
              </div>
            </section>
          )}

          <PageActions>
            <button type="button" className="btn-ghost" onClick={() => { setResult(null); setError('') }}>← 重新偵測</button>
          </PageActions>
        </>
      )}
    </div>
  )
}

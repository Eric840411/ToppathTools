import { useState, useRef, useCallback, useEffect } from 'react'

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

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Input section — hide when session active */}
      {!sessionId && !result && (
        <>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              前端 URL（含 token）
            </label>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://osm-redirect.osmslot.org/?token=xxx&gameid=xxx..."
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>已刪除圖片清單</label>
              <button onClick={() => setShowGitPaste(v => !v)}
                style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #6366f1', background: showGitPaste ? '#6366f1' : '#fff', color: showGitPaste ? '#fff' : '#6366f1', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                📋 貼上 git diff 文字解析
              </button>
              <button onClick={() => fileInputRef.current?.click()}
                style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #7c3aed', background: '#fff', color: '#7c3aed', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                🖼️ 上傳截圖 AI 識別
              </button>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>或直接 Ctrl+V 貼上截圖</span>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) parseScreenshot(f); e.target.value = '' }} />
            </div>

            <div onPaste={handlePaste}
              style={{ marginBottom: 8, padding: '10px 14px', background: '#faf5ff', border: '1px dashed #c4b5fd', borderRadius: 8, fontSize: 12, color: '#7c3aed', minHeight: 36, display: 'flex', alignItems: 'center', gap: 10 }}>
              {screenshotParsing ? <span>🤖 Gemini 識別中...</span>
                : screenshotPreview ? <><img src={screenshotPreview} alt="" style={{ height: 40, borderRadius: 4 }} /><span>已解析，路徑已填入</span></>
                : <span>📸 Ctrl+V 貼上 git diff 截圖 → Gemini 自動識別</span>}
            </div>

            {showGitPaste && (
              <div style={{ marginBottom: 10, padding: '12px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>支援 git diff --name-status / git status / GUI 格式</div>
                <textarea value={gitDiffText} onChange={e => setGitDiffText(e.target.value)}
                  placeholder={'D\tassets/resources/jackpot/aruze1.png\n...'} rows={5}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11, fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={handleParseDiff} disabled={!gitDiffText.trim()}
                    style={{ padding: '6px 16px', borderRadius: 6, background: '#6366f1', color: '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: gitDiffText.trim() ? 'pointer' : 'default', opacity: gitDiffText.trim() ? 1 : 0.5 }}>
                    解析並填入 ({parseGitDiff(gitDiffText).length} 個)
                  </button>
                  <button onClick={() => { setShowGitPaste(false); setGitDiffText('') }}
                    style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#6b7280' }}>取消</button>
                </div>
              </div>
            )}

            <textarea value={deletedList} onChange={e => setDeletedList(e.target.value)}
              placeholder={'assets/resources/jackpot/aruze1.png\n...'} rows={6}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }} />
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
              {deletedList.split('\n').filter(l => l.trim()).length} 個路徑
            </div>
          </div>

          <button onClick={handleStart} disabled={loading || !url.trim() || !deletedList.trim()}
            style={{ padding: '10px 28px', borderRadius: 8, background: loading || !url.trim() || !deletedList.trim() ? '#a5b4fc' : '#6366f1', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 16 }}>
            {loading ? '啟動中...' : '🚀 開始偵測'}
          </button>
        </>
      )}

      {error && (
        <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Virtual browser panel */}
      {sessionId && (
        <div>
          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ padding: '8px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534', fontWeight: 600 }}>
              🟢 已攔截 <strong>{liveCount}</strong> 個圖片請求
            </div>
            <button onClick={handleStop}
              style={{ padding: '8px 20px', borderRadius: 8, background: '#6366f1', color: '#fff', border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              ✅ 完成，取得結果
            </button>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>可點擊畫面操作遊戲 · 滾輪捲動</span>
          </div>

          {/* Browser screenshot */}
          <div style={{ border: '2px solid #6366f1', borderRadius: 10, overflow: 'hidden', background: '#000', cursor: 'pointer' }}>
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
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: 13 }}>
                載入中...
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>畫面每 1.5 秒自動更新</div>
        </div>
      )}

      {/* Results */}
      {result && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={() => { setResult(null); setError('') }}
              style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151' }}>
              ← 重新偵測
            </button>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 140, padding: '14px 18px', background: stillLoaded.length > 0 ? '#fef2f2' : '#f0fdf4', borderRadius: 10, border: `1px solid ${stillLoaded.length > 0 ? '#fecaca' : '#bbf7d0'}` }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: stillLoaded.length > 0 ? '#dc2626' : '#16a34a' }}>{stillLoaded.length}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>❌ 仍在載入（需確認）</div>
            </div>
            <div style={{ flex: 1, minWidth: 140, padding: '14px 18px', background: '#f0fdf4', borderRadius: 10, border: '1px solid #bbf7d0' }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: '#16a34a' }}>{confirmed.length}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>✅ 已確認刪除</div>
            </div>
            <div style={{ flex: 1, minWidth: 140, padding: '14px 18px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: '#475569' }}>{result.loadedImageCount}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>頁面共載入圖片數</div>
            </div>
          </div>

          {stillLoaded.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>❌ 仍被載入（{stillLoaded.length} 個）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {stillLoaded.map(r => (
                  <div key={r.path} style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 11, fontFamily: 'monospace' }}>
                    <div style={{ color: '#dc2626', fontWeight: 600 }}>{r.path}</div>
                    {r.matchedUrl && <div style={{ color: '#9ca3af', marginTop: 2 }}>→ {r.matchedUrl}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {confirmed.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', marginBottom: 8 }}>✅ 已確認刪除（{confirmed.length} 個）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {confirmed.map(r => (
                  <div key={r.path} style={{ padding: '6px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', color: '#166534' }}>
                    {r.path}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

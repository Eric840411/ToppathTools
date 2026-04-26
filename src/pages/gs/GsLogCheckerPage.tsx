import { useEffect, useState } from 'react'

export function GsLogCheckerPage() {
  const [script, setScript] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/api/gs/log-checker-script')
      .then(r => r.json())
      .then((d: { ok: boolean; script?: string }) => {
        if (d.ok && d.script) setScript(d.script)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleCopy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000) }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(script).then(done).catch(() => fallbackCopy())
    } else {
      fallbackCopy()
    }
  }

  const fallbackCopy = () => {
    const ta = document.createElement('textarea')
    ta.value = script
    ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.focus(); ta.select()
    try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* ignore */ }
    document.body.removeChild(ta)
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="section-card" style={{ marginBottom: 16 }}>
        <h2 className="section-title">🔍 Log 攔截工具</h2>
        <div style={{ fontSize: 14, color: '#475569', lineHeight: 1.7 }}>
          <p>此工具會攔截前端頁面對 <code>/api/log</code> 的請求，解析兩層 JSON payload，驗證欄位完整性並顯示結果。</p>
        </div>
      </div>

      <div className="two-col" style={{ marginBottom: 16 }}>
        <div className="section-card">
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 12 }}>使用方式</h3>
          <ol style={{ fontSize: 13, color: '#374151', lineHeight: 2, paddingLeft: 20 }}>
            <li>開啟 Game Show 遊戲頁面</li>
            <li>按 <code>F12</code> 開啟開發者工具</li>
            <li>切換至 <strong>Console</strong> 分頁</li>
            <li>將右側腳本完整複製後貼入 Console</li>
            <li>按 Enter 執行，頁面右下角會出現浮動面板</li>
            <li>在遊戲中觸發各種操作，面板即時顯示攔截結果</li>
            <li>驗證完畢後可點擊「匯出 CSV」儲存記錄</li>
          </ol>
        </div>
        <div className="section-card">
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 12 }}>面板功能說明</h3>
          <ul style={{ fontSize: 13, color: '#374151', lineHeight: 2, paddingLeft: 20 }}>
            <li>自動攔截所有 <code>/api/log</code> XHR 請求</li>
            <li>解析雙層 JSON（outer + <code>jsondata</code> inner）</li>
            <li>可設定要驗證的欄位，空值自動標紅</li>
            <li>可分別設定「驗證欄位」與「匯出欄位」</li>
            <li>匯出 CSV 包含欄位值與驗證狀態欄</li>
            <li>面板可拖曳移動位置</li>
          </ul>
        </div>
      </div>

      <div className="section-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: 0 }}>注入腳本</h3>
          <button type="button" onClick={handleCopy} disabled={!script}
            style={{ padding: '7px 20px', borderRadius: 6, background: copied ? '#16a34a' : '#0f172a', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: script ? 'pointer' : 'default' }}>
            {copied ? '✅ 已複製' : '📋 複製腳本'}
          </button>
        </div>
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>載入中...</div>
        ) : script ? (
          <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: 16, borderRadius: 8, fontSize: 11, fontFamily: 'monospace', overflow: 'auto', maxHeight: 400, lineHeight: 1.5, margin: 0 }}>
            {script}
          </pre>
        ) : (
          <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>腳本載入失敗，請檢查伺服器連線</div>
        )}
      </div>
    </div>
  )
}

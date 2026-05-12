import { useEffect, useState } from 'react'

type Tab = 'checker' | 'compare'

const STEPS = [
  { n: 1, icon: '🎮', title: '開啟遊戲頁面', desc: '在瀏覽器中開啟目標 Game Show 遊戲頁面' },
  { n: 2, icon: '🛠', title: '開啟開發者工具', desc: '按下 F12 開啟 DevTools，切換至 Console 分頁' },
  { n: 3, icon: '📋', title: '貼入腳本', desc: '複製右側腳本後貼入 Console，按 Enter 執行' },
  { n: 4, icon: '🎯', title: '觸發遊戲操作', desc: '在遊戲中進行 Spin、進場等動作，面板即時攔截 Log' },
  { n: 5, icon: '📊', title: '選取驗證欄位', desc: '勾選要驗證的欄位（balance、seq_index 等）' },
  { n: 6, icon: '💾', title: '匯出報告', desc: '點擊面板中的「匯出 CSV」或「匯出 JSON」儲存結果' },
]

const FEATURES = [
  { color: '#339af0', label: '自動攔截 /api/log XHR 請求' },
  { color: '#51cf66', label: '解析三層結構（root / data / jsondata）' },
  { color: '#fcc419', label: '空值欄位自動標紅 ✅ / ❌' },
  { color: '#f783ac', label: '驗證欄位與匯出欄位可分別設定' },
  { color: '#a9e34b', label: '匯出 CSV（含驗證狀態欄）與原始 JSON' },
  { color: '#b197fc', label: '可拖曳浮動面板，自動排除噪音事件' },
]

export function GsLogCheckerPage() {
  const [tab, setTab] = useState<Tab>('checker')
  const [script, setScript] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [showScript, setShowScript] = useState(false)

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
      navigator.clipboard.writeText(script).then(done).catch(fallbackCopy)
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

  const handleDownload = () => {
    const blob = new Blob([script], { type: 'text/javascript' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'intercept.js'
    a.click()
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Tab 切換 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {([
          { key: 'checker', label: '🔍 Log 攔截工具' },
          { key: 'compare', label: '📊 Log 結構比對' },
        ] as { key: Tab; label: string }[]).map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            style={{
              padding: '9px 22px', borderRadius: 8, border: '1.5px solid', fontSize: 13,
              fontWeight: 600, cursor: 'pointer',
              borderColor: tab === t.key ? '#6366f1' : '#e2e8f0',
              background: tab === t.key ? 'rgba(99,102,241,0.15)' : '#1e293b',
              color: tab === t.key ? '#818cf8' : '#64748b',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Log 攔截工具 ── */}
      {tab === 'checker' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Hero */}
          <div className="section-card" style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 28 }}>📋</span>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>Log Checker</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                  在 DevTools Console 注入腳本，即時攔截並驗證前端 <code style={{ background: 'rgba(52,211,153,0.1)', padding: '1px 5px', borderRadius: 4, color: '#34d399', fontFamily: 'monospace' }}>/api/log</code> 的 XHR 回應
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {FEATURES.map(f => (
                <span key={f.label} style={{
                  padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 500,
                  background: f.color + '18', color: f.color,
                  border: `1px solid ${f.color}55`,
                }}>{f.label}</span>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>

            {/* 使用步驟 */}
            <div className="section-card" style={{ padding: '20px 24px' }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', borderRadius: 6, padding: '2px 8px', fontSize: 12 }}>使用步驟</span>
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {STEPS.map(s => (
                  <div key={s.n} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{
                      flexShrink: 0, width: 28, height: 28, borderRadius: 8,
                      background: 'rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 14,
                    }}>{s.icon}</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
                        <span style={{ color: '#a5b4fc', marginRight: 4 }}>Step {s.n}.</span>{s.title}
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 注入腳本 */}
            <div className="section-card" style={{ padding: '20px 24px' }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399', borderRadius: 6, padding: '2px 8px', fontSize: 12 }}>注入腳本</span>
                {script && <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>{script.split('\n').length} 行</span>}
              </h3>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <button type="button" onClick={handleCopy} disabled={!script}
                  style={{
                    flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 700,
                    cursor: script ? 'pointer' : 'default', border: 'none',
                    background: copied ? '#16a34a' : '#4f46e5',
                    color: '#fff',
                    opacity: script ? 1 : 0.5,
                    transition: 'background .15s',
                  }}>
                  {copied ? '✅ 已複製！' : '📋 複製腳本'}
                </button>
                <button type="button" onClick={handleDownload} disabled={!script}
                  style={{
                    flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 700,
                    cursor: script ? 'pointer' : 'default', border: '1.5px solid #e2e8f0',
                    background: '#162032', color: '#cbd5e1',
                    opacity: script ? 1 : 0.5,
                  }}>
                  ⬇️ 下載 .js
                </button>
              </div>

              {/* Tips */}
              <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: '#fbbf24', lineHeight: 1.6 }}>
                  <strong>⚠️ 注意事項：</strong><br />
                  • 僅在測試環境使用，勿長期掛載於正式站<br />
                  • 每次測試前重新執行腳本，確保攔截器是最新版<br />
                  • 如出現 CSP 限制，可嘗試在 DevTools Sources 注入
                </div>
              </div>

              {/* Toggle script preview */}
              <button type="button" onClick={() => setShowScript(v => !v)}
                style={{ background: 'none', border: '1px solid #2d3f55', borderRadius: 6, padding: '5px 12px', fontSize: 12, color: '#64748b', cursor: 'pointer', width: '100%' }}>
                {showScript ? '▲ 收起腳本預覽' : '▼ 展開腳本預覽'}
              </button>

              {showScript && (
                <div style={{ marginTop: 10 }}>
                  {loading ? (
                    <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>載入中...</div>
                  ) : script ? (
                    <pre style={{
                      background: '#0f172a', color: '#e2e8f0', padding: 14, borderRadius: 8,
                      fontSize: 10.5, fontFamily: 'monospace', overflow: 'auto', maxHeight: 320,
                      lineHeight: 1.55, margin: 0,
                    }}>{script}</pre>
                  ) : (
                    <div style={{ padding: 16, textAlign: 'center', color: '#f87171', fontSize: 13 }}>腳本載入失敗，請檢查伺服器連線</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Log 結構比對 ── */}
      {tab === 'compare' && (
        <div className="section-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3f55', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>📊 Log 結構比對</span>
              <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>支援雙檔結構比對與單檔欄位缺失驗證</span>
            </div>
            <a href="/api/gs/log-compare" target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>
              在新視窗開啟 ↗
            </a>
          </div>
          <iframe
            src="/api/gs/log-compare"
            style={{ width: '100%', height: 'calc(100vh - 260px)', minHeight: 600, border: 'none', display: 'block' }}
            title="Log 結構比對工具"
          />
        </div>
      )}
    </div>
  )
}

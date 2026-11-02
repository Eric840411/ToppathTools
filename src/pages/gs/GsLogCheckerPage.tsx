import { useEffect, useRef, useState } from 'react'
import { XianxiaIcon } from '../../components/XianxiaIcon'

// ── Log 結構比對 inline HTML (extracted from log-compare.html body) ─────────
const LOG_COMPARE_HTML = `<div class="page-wrap">
  <div class="card">
    <div class="card-title"><span>比對設定</span><span class="badge badge-slate">LOG 結構比對</span></div>
    <div class="grid-2">
      <label>執行模式<select id="cmp-run-mode"><option value="compare" selected>雙檔比對（舊版 vs 新版）</option><option value="validate">單檔驗證（欄位缺失）</option></select></label>
    </div>
    <div class="compare-grid grid-2">
      <label id="cmp-old-file-label"><span id="cmp-old-file-text">舊版 JSON（原始）</span><input id="cmp-old-file" type="file" accept=".json,application/json"></label>
      <label id="cmp-new-file-label">新版 JSON（原始）<input id="cmp-new-file" type="file" accept=".json,application/json"></label>
    </div>
    <div class="grid-2">
      <label>匹配鍵<select id="cmp-match-mode"><option value="function_name_event" selected>function_name + event（預設）</option><option value="function_name">function_name</option><option value="custom">自訂欄位（data / root.）</option></select></label>
      <label id="cmp-custom-wrap" class="hidden">自訂匹配欄位（逗號分隔）<input id="cmp-custom-fields" type="text" placeholder="例如 function_name,root.event"></label>
    </div>
    <div id="cmp-event-hint" class="hint-box">匹配鍵預設為「function_name + event」，其中 <strong>event</strong> 取值順序：① <code>payload</code> 最外層的 <code>event</code>（即整筆 log 的 root.event）→ ② <code>data.event</code> → ③ <code>jsondata</code> 解析後的 <code>event</code>。<span class="hint-box-sub">（自訂匹配鍵請用欄位名，如 <code>root.status</code>、<code>balance</code>。不加前綴預設視為 <code>data</code> 欄位。）</span></div>
    <details class="examples-block cmp-examples">
      <summary class="cmp-examples-summary">填寫範例（點此展開／收合）</summary>
      <div class="examples-body cmp-examples-body">
        <p class="cmp-examples-rule"><strong>規則：</strong>欄位名<strong>不加前綴</strong>時視為 <code>data</code> 層；最外層請寫 <code>root.</code> 前綴。</p>
        <ul class="cmp-examples-list"><li><strong>root</strong>（<code>payload</code> 最外層）：<code>root.host</code>、<code>root.username</code>、<code>root.event</code>、<code>root.status</code>、<code>root.channelId</code></li><li><strong>data</strong>（<code>payload.data</code>）：<code>function_name</code>、<code>event_name</code>、<code>balance</code>、<code>seq_index</code>、<code>jsondata</code></li><li><strong>jsondata 內層</strong>（解析 <code>data.jsondata</code> 後的 key）：<code>switch</code>、<code>table</code>、<code>round_number</code>、<code>time</code></li></ul>
        <p class="cmp-examples-block"><strong>自訂匹配欄位</strong>（選「自訂欄位」時）：<code>function_name,root.event</code> 或 <code>root.status,seq_index</code></p>
        <p class="cmp-examples-block"><strong>data/root 比對欄位</strong>（勾選啟用後）：<code>balance,seq_index,root.host,root.status</code></p>
        <p class="cmp-examples-block"><strong>單檔驗證欄位</strong>（只需上傳 1 份 JSON）：<code>root.event,function_name,balance,seq_index</code></p>
        <p class="cmp-examples-block"><strong>單檔 jsondata 摘要</strong>：僅展示實際 jsondata 內容樣本，不做結構差異判定。</p>
        <p class="cmp-examples-block"><strong>忽略欄位</strong>：預設已含 <code>host</code> 等；若要比對 root 的 host，請從忽略清單移除 <code>host</code>。</p>
      </div>
    </details>
    <div class="compare-grid grid-2">
      <label class="row-checkbox"><input id="cmp-enable-outer" type="checkbox">啟用 data/root 欄位比對（jsondata path/type 固定必比）</label>
      <label id="cmp-outer-wrap" class="hidden">data/root 比對欄位（逗號分隔）<input id="cmp-outer-fields" type="text" placeholder="例如 balance,seq_index,root.host,root.status"></label>
    </div>
    <label id="cmp-required-wrap" class="hidden" style="margin-bottom:12px;">單檔驗證欄位（逗號分隔，支援 root. / data.）<input id="cmp-required-fields" type="text" placeholder="例如 root.event,function_name,balance,seq_index"></label>
    <section id="cmp-auto-fields-wrap" class="auto-fields-wrap cmp-auto-fields hidden">
      <div class="auto-fields-head cmp-auto-fields-head"><strong>自動掃描欄位（單檔 JSON）</strong><span id="cmp-auto-fields-note" class="auto-fields-note cmp-auto-fields-note">上傳單檔後會依欄位出現率自動推薦（預設 ≥ 95%）</span></div>
      <div class="auto-fields-search-row cmp-auto-fields-search-row"><input id="cmp-auto-search" type="text" placeholder="搜尋欄位（例如 root.event / balance）"><select id="cmp-auto-filter"><option value="all" selected>全部</option><option value="recommended">僅推薦</option><option value="missing">僅有缺失</option><option value="checked">僅已勾選</option></select></div>
      <div class="auto-fields-actions cmp-auto-fields-actions"><button id="cmp-auto-select-recommended" type="button" class="lcw-btn-muted">勾選推薦</button><button id="cmp-auto-select-all" type="button" class="lcw-btn-muted">全選</button><button id="cmp-auto-clear" type="button" class="lcw-btn-muted">全清</button><button id="cmp-auto-apply" type="button" class="lcw-btn-primary" style="padding:7px 16px;font-size:12px;">套用到驗證欄位</button></div>
      <div class="auto-fields-columns cmp-auto-fields-columns">
        <section class="auto-col cmp-auto-col"><h4>root 欄位</h4><div id="cmp-auto-fields-root" class="auto-fields-list cmp-auto-fields-list"></div></section>
        <section class="auto-col cmp-auto-col"><h4>data 欄位</h4><div id="cmp-auto-fields-data" class="auto-fields-list cmp-auto-fields-list"></div></section>
      </div>
    </section>
    <label style="margin-bottom:10px;">忽略欄位（逗號分隔）<input id="cmp-ignore-fields" type="text" value="timestamp,_capturedAt,trace_id,token,host"></label>
    <label style="margin-bottom:12px;">排除事件（逗號分隔，event 含關鍵字即略過）<input id="cmp-exclude-events" type="text" value="connecting,connected,disconnecting,disconnected,client.video.join,client.video.leave"></label>
    <label class="row-checkbox" style="margin-bottom:14px;"><input id="cmp-only-has-function-name" type="checkbox" checked>僅驗證有 function_name 的資料（空值直接跳過；若要檢查 function_name 缺失請取消勾選）</label>
    <div class="compare-actions"><button id="cmp-run" class="lcw-btn-primary">︎ 開始比對</button><button id="cmp-download" class="lcw-btn-muted" disabled>⬇ 下載差異 CSV</button></div>
    <div id="cmp-summary" class="compare-summary"></div>
  </div>
  <div id="cmp-tabs" class="cmp-tabs hidden"><button class="cmp-tab-btn active" data-tab="all">全部明細</button><button class="cmp-tab-btn" data-tab="missing-group">整組缺失</button><button class="cmp-tab-btn" data-tab="jsondata">jsondata 結構差異</button><button class="cmp-tab-btn" data-tab="outer">data/root 欄位差異</button></div>
  <div id="cmp-tab-panels"><div id="cmp-panel-all" class="compare-details"></div><div id="cmp-panel-missing-group" class="compare-details hidden"></div><div id="cmp-panel-jsondata" class="compare-details hidden"></div><div id="cmp-panel-outer" class="compare-details hidden"></div></div>
</div>`

const LOG_COMPARE_CSS = `
.lcw *, .lcw *::before, .lcw *::after { box-sizing: border-box; }
.lcw { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; color: #cbd5e1; }
.lcw .page-wrap { max-width: 1000px; margin: 0 auto; padding: 16px; }
.lcw .card { background: #1e293b; border: 1px solid #2d3f55; border-radius: 12px; padding: 20px 22px; margin-bottom: 14px; }
.lcw .card-title { font-size: 13px; font-weight: 700; color: #e2e8f0; margin: 0 0 16px; display: flex; align-items: center; gap: 8px; }
.lcw .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; }
.lcw .badge-indigo { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.lcw .badge-slate  { background: #162032; color: #94a3b8; }
.lcw .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.lcw .cmp-file-grid-single { grid-template-columns: 1fr !important; }
.lcw label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 600; color: #94a3b8; }
.lcw label.row-checkbox { flex-direction: row; align-items: center; gap: 8px; font-weight: 500; color: #cbd5e1; cursor: pointer; margin-bottom: 10px; }
.lcw input[type="text"], .lcw input[type="file"], .lcw select { padding: 8px 10px; border: 1px solid #2d3f55; border-radius: 8px; font-size: 13px; color: #e2e8f0; background: #0f172a; transition: border-color .15s; outline: none; width: 100%; }
.lcw input[type="text"]:focus, .lcw select:focus { border-color: #6366f1; box-shadow: 0 0 0 3px #6366f125; }
.lcw input[type="file"] { cursor: pointer; color: #94a3b8; background: #162032; }
.lcw input[type="checkbox"] { width: 15px; height: 15px; cursor: pointer; accent-color: #6366f1; flex-shrink: 0; }
.lcw .hint-box { background: #162032; border: 1px solid #2d3f55; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.55; color: #94a3b8; margin-bottom: 12px; }
.lcw .hint-box code { font-size: 11px; padding: 1px 4px; background: #2d3f55; border-radius: 4px; font-family: monospace; }
.lcw .hint-box-sub { display: block; margin-top: 4px; color: #64748b; font-size: 11px; }
.lcw .examples-block { border: 1px solid #2d3f55; border-radius: 8px; background: #162032; overflow: hidden; margin-bottom: 12px; }
.lcw .examples-block summary { padding: 9px 12px; font-size: 12px; font-weight: 600; color: #94a3b8; cursor: pointer; list-style-position: inside; user-select: none; }
.lcw .examples-block summary:hover { background: #2d3f55; }
.lcw .examples-body { padding: 0 14px 12px; font-size: 12px; line-height: 1.55; color: #94a3b8; border-top: 1px solid #2d3f55; }
.lcw .examples-body p { margin: 8px 0 0; }
.lcw .examples-body ul { margin: 6px 0 10px 1.2em; padding: 0; }
.lcw .examples-body ul li { margin-bottom: 4px; }
.lcw .examples-body code { font-size: 11px; padding: 1px 4px; background: #2d3f55; border-radius: 4px; font-family: monospace; }
.lcw .hidden { display: none !important; }
.lcw .auto-fields-wrap { border: 1px solid #2d3f55; border-radius: 10px; background: #162032; padding: 14px; margin-bottom: 12px; }
.lcw .auto-fields-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; font-weight: 700; color: #e2e8f0; }
.lcw .auto-fields-note { font-size: 11px; color: #64748b; font-weight: 400; }
.lcw .auto-fields-search-row { display: flex; gap: 8px; margin-bottom: 8px; }
.lcw .auto-fields-search-row input { flex: 1; }
.lcw .auto-fields-search-row select { width: 140px; }
.lcw .auto-fields-actions { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.lcw .auto-fields-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lcw .auto-col h4 { font-size: 11px; font-weight: 700; color: #94a3b8; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .5px; }
.lcw .auto-fields-list { max-height: 160px; overflow-y: auto; border: 1px solid #2d3f55; border-radius: 6px; padding: 6px 8px; background: #0f172a; }
.lcw .lcw-btn-primary { padding: 9px 22px; background: #4f46e5; color: #fff; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s; }
.lcw .lcw-btn-primary:hover:not(:disabled) { background: #4338ca; }
.lcw .lcw-btn-primary:disabled { opacity: .45; cursor: default; }
.lcw .lcw-btn-muted { padding: 7px 14px; background: #1e293b; color: #94a3b8; border: 1px solid #2d3f55; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s; }
.lcw .lcw-btn-muted:hover:not(:disabled) { background: #2d3f55; }
.lcw .lcw-btn-muted:disabled { opacity: .45; cursor: default; }
.lcw .compare-actions { display: flex; gap: 10px; align-items: center; padding-top: 4px; }
.lcw .compare-summary { margin-top: 14px; font-size: 13px; line-height: 1.6; }
.lcw .cmp-tabs { display: flex; gap: 4px; border-bottom: 2px solid #2d3f55; padding-bottom: 0; margin-bottom: 4px; }
.lcw .cmp-tab-btn { padding: 7px 16px; border: none; background: none; font-size: 13px; font-weight: 600; color: #94a3b8; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; border-radius: 6px 6px 0 0; transition: color .15s; }
.lcw .cmp-tab-btn:hover { color: #818cf8; background: rgba(99,102,241,0.08); }
.lcw .cmp-tab-btn.active { color: #818cf8; border-bottom-color: #818cf8; }
.lcw .compare-details { margin-top: 12px; font-size: 13px; line-height: 1.6; }
`

function LogComparePanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    if (containerRef.current) {
      containerRef.current.innerHTML = LOG_COMPARE_HTML
    }

    if (!document.getElementById('lcw-styles')) {
      const style = document.createElement('style')
      style.id = 'lcw-styles'
      style.textContent = LOG_COMPARE_CSS
      document.head.appendChild(style)
    }

    if (!document.getElementById('lcw-script')) {
      const script = document.createElement('script')
      script.id = 'lcw-script'
      script.src = '/api/gs/log-compare-app.js'
      document.body.appendChild(script)
    }

    return () => {
      document.getElementById('lcw-styles')?.remove()
      document.getElementById('lcw-script')?.remove()
    }
  }, [])

  return <div ref={containerRef} className="lcw" />
}

type Tab = 'checker' | 'compare'

const STEPS: Array<{ n: number; title: string; desc: string }> = [
  { n: 1, title: '開啟遊戲頁面', desc: '在瀏覽器中開啟目標 Game Show 遊戲頁面' },
  { n: 2, title: '開啟開發者工具', desc: '按下 F12 開啟 DevTools，切換至 Console 分頁' },
  { n: 3, title: '貼入腳本', desc: '複製下方腳本後貼入 Console，按 Enter 執行' },
  { n: 4, title: '觸發遊戲操作', desc: '在遊戲中進行 Spin、進場等動作，面板即時攔截 Log' },
  { n: 5, title: '選取驗證欄位', desc: '勾選要驗證的欄位（balance、seq_index 等）' },
  { n: 6, title: '匯出報告', desc: '點擊面板中的「匯出 CSV」或「匯出 JSON」儲存結果' },
]

const FEATURES = [
  { color: '#339af0', label: '自動攔截 /api/log XHR 請求' },
  { color: '#51cf66', label: '解析三層結構（root / data / jsondata）' },
  { color: '#fcc419', label: '空值欄位自動標紅 通過 / 失敗' },
  { color: '#f783ac', label: '驗證欄位與匯出欄位可分別設定' },
  { color: '#a9e34b', label: '匯出 CSV（含驗證狀態欄）與原始 JSON' },
  { color: '#b197fc', label: '可拖曳浮動面板，自動排除噪音事件' },
]

export function GsLogCheckerPage() {
  const [tab, setTab] = useState<Tab>('checker')
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
    <div className="gl-page">
      {/* 新版：分頁列用共用 .rd-tabs（redesign/pages/kit.css）；步進條與腳本面板樣式在 redesign/pages/gs.css */}
      <div className="rd-tabs" role="tablist" aria-label="Log 工具">
        {([
          { key: 'checker', label: 'Log 攔截工具' },
          { key: 'compare', label: 'Log 結構比對' },
        ] as { key: Tab; label: string }[]).map(t => (
          <button key={t.key} type="button" role="tab" className="rd-tab"
            aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Log 攔截工具 ── */}
      {tab === 'checker' && (
        <>
          {/* 介紹卡：原型沒有，使用者 1102 決定保留 */}
          <div className="section-card" style={{ padding: '18px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <XianxiaIcon name="monitor" size={34} />
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--rd-fg, #e2e8f0)' }}>Log Checker</div>
                <div style={{ fontSize: 12, color: 'var(--rd-fg-2, #94a3b8)', marginTop: 2 }}>
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

          {/* 使用步驟：靜態編號，產品不追蹤做到哪一步，所以不畫打勾／目前步驟 */}
          <div className="section-card">
            <h3 className="section-title">使用步驟</h3>
            <ol className="gl-steps">
              {STEPS.map(s => (
                // 設計圖只有標題；說明改成滑過顯示（使用者 1102：排版要跟設計圖一致）
                <li key={s.n} className="gl-step" title={s.desc}>
                  <span className="gl-step-n">{s.n}</span>
                  <span className="gl-step-title">{s.title}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* 注入腳本 */}
          <div className="section-card">
            <h3 className="section-title">注入腳本</h3>
            <div className="gl-actions">
              <button type="button" onClick={handleCopy} disabled={!script}
                className={`gl-btn-primary${copied ? ' is-done' : ''}`}>
                {copied ? '已複製！' : '複製腳本'}
              </button>
              <button type="button" onClick={handleDownload} disabled={!script} className="btn-ghost">
                ⬇ 下載 .js
              </button>
              {script && <span className="gl-lines">{script.split('\n').length} 行</span>}
              {/* 設計圖沒有注意事項區塊；內容要留，縮成按鈕列右側一行 */}
              <span className="gl-note-inline">⚠ 僅限測試環境・每次測試前重新執行・遇 CSP 改在 DevTools Sources 注入</span>
            </div>

            {loading ? (
              <div className="gl-code-state">載入中...</div>
            ) : script ? (
              <pre className="gl-code">{script}</pre>
            ) : (
              <div className="gl-code-state is-error">腳本載入失敗，請檢查伺服器連線</div>
            )}
          </div>
        </>
      )}

      {/* ── Log 結構比對 (inline, always mounted to preserve state) ── */}
      <div style={{ display: tab === 'compare' ? 'block' : 'none' }}>
        <LogComparePanel />
      </div>
    </div>
  )
}

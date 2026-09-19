import { useMemo, useState } from 'react'
import { PROD_SIM_BASE, PROD_SIM_TARGETS, PROD_SIM_TARGET_LABEL, toProdSimUrls, type ProdSimTarget } from '../data/prodSimUrl'

/**
 * 「模擬正式」分頁：把正式環境的 token URL 換成模擬正式環境的連結。
 *
 * ⚠️ 這裡**不產 token、不存 token**。它只是換入口——貼進來的東西完全留在瀏覽器裡，
 *    不打任何 API、不寫 localStorage、不落 DB（跟 CodeX 討論後的明確界線：
 *    完整 token 不該被我們的工具記錄下來）。
 *
 * ⚠️ 也**不自動開啟**。兩邊同時開等於同一個 token 兩個 session，
 *    要開哪一邊由使用者自己按。
 */

function copyText(text: string) {
  const fallback = () => {
    // 非 HTTPS／非 localhost 進來時沒有 clipboard API（內網用 IP 開就是這種情況）
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(fallback)
  else fallback()
}

export function ProdSimPanel() {
  const [input, setInput] = useState('')
  const [copied, setCopied] = useState<ProdSimTarget | null>(null)

  // 輸入一改就整個重算（含清空 → ok=false → 下面的按鈕全部停用）。
  // 不留任何「上一次算好的結果」，否則改壞輸入之後複製到的還是舊連結。
  const result = useMemo(() => toProdSimUrls(input), [input])

  function handleCopy(t: ProdSimTarget) {
    copyText(result.urls[t])
    setCopied(t)
    setTimeout(() => setCopied(c => (c === t ? null : c)), 2000)
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ padding: '8px 12px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 8, marginBottom: 12, fontSize: 12, color: '#60a5fa', lineHeight: 1.7 }}>
        悟 貼上<b>正式環境</b>的 token URL，下面會自動換成模擬正式環境的連結。
        <b>只換網域，其餘參數原封不動</b>——token 不會被改、也不會被這個工具記錄或上傳。
      </div>

      <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>正式 token URL</label>
      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="https://osm-redirect.osmplay.com/?token=...&platform=50&mode=live&studioid=cp&username=...&gameid=..."
        spellCheck={false}
        style={{
          width: '100%', minHeight: 84, fontSize: 11.5, fontFamily: 'monospace', lineHeight: 1.6,
          background: '#0f172a', color: '#e2e8f0', border: '1px solid #2d3f55', borderRadius: 8,
          padding: 10, resize: 'vertical', boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button type="button" onClick={() => setInput('')} disabled={!input} style={btn('#6b7280', !input)}>清空</button>
        {result.ok && (
          <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
            來源 <code style={code}>{result.sourceHost || '(無網域)'}</code>
            {result.fields.username && <> · 帳號 <code style={code}>{result.fields.username}</code></>}
            {result.fields.gameid && <> · 遊戲 <code style={code}>{result.fields.gameid}</code></>}
            {result.fields.studioid && <> · 渠道 <code style={code}>{result.fields.studioid}</code></>}
          </span>
        )}
      </div>

      {/* 錯誤：轉不出來。空字串代表「還沒貼」，不報錯。 */}
      {!result.ok && result.error && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.35)', borderRadius: 8, fontSize: 12, color: '#f87171' }}>
          {result.error}
        </div>
      )}

      {/* ⚠️ 警告要顯示但不擋。最重要的一條是「貼到測試環境的 token」——
          那種連結產得出來、看起來完全正常，開進去才發現登不進去。 */}
      {result.warnings.map((w, i) => (
        <div key={i} style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(234,179,8,.08)', border: '1px solid rgba(234,179,8,.35)', borderRadius: 8, fontSize: 12, color: '#eab308', lineHeight: 1.7 }}>
          {w}
        </div>
      ))}

      <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
        {PROD_SIM_TARGETS.map(t => {
          const url = result.urls[t]
          const disabled = !result.ok || !url
          return (
            <div key={t} style={{ background: '#162032', border: '1px solid #2d3f55', borderRadius: 10, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#e2e8f0' }}>{PROD_SIM_TARGET_LABEL[t]}</span>
                <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{PROD_SIM_BASE[t]}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button
                    type="button" disabled={disabled} onClick={() => handleCopy(t)}
                    data-testid={`prod-sim-copy-${t}`}
                    style={btn(copied === t ? '#16a34a' : '#2563eb', disabled)}
                  >{copied === t ? '已複製！' : '複製'}</button>
                  {/* ⚠️ 不自動開，也不同時開兩邊——同一個 token 開兩個 session 會互踢。 */}
                  <a
                    href={disabled ? undefined : url}
                    target="_blank" rel="noreferrer"
                    data-testid={`prod-sim-open-${t}`}
                    style={{ ...btn('#475569', disabled), textDecoration: 'none', display: 'inline-block' }}
                  >開啟</a>
                </div>
              </div>
              <div style={{
                fontSize: 11, fontFamily: 'monospace', color: disabled ? '#475569' : '#94a3b8',
                background: '#0f172a', border: '1px solid #223045', borderRadius: 6, padding: '8px 10px',
                wordBreak: 'break-all', lineHeight: 1.6, minHeight: 34,
              }}>
                {disabled ? '（等待貼上正式 token URL）' : url}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const code: React.CSSProperties = { color: '#cbd5e1', background: '#0f172a', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }

function btn(color: string, disabled = false): React.CSSProperties {
  return {
    padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: `1px solid ${disabled ? '#334155' : color}`,
    background: disabled ? '#1e293b' : color,
    color: disabled ? '#64748b' : '#fff',
    opacity: disabled ? .6 : 1,
    pointerEvents: disabled ? 'none' : undefined,
  }
}

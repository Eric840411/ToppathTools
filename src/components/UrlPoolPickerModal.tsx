import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UrlPoolEntry } from '../data/urlPoolData'
import { POOL_SOURCE, POOL_LABEL, POOL_ENVS, type PoolEnv } from '../data/urlPoolEnv'

/** 帳號池選取彈窗 — 從 URL 帳號池挑一個帳號的大廳 URL 帶入指定欄位，避免手動複製貼上帶 token 的長網址。
 * 由 Machine Test「大廳 URL」與 AutoSpin「Game URL」共用。 */
export function UrlPoolPickerModal({ title, claimedByLabel, onSelect, onClose }: {
  title: string
  claimedByLabel: string
  onSelect: (url: string) => void
  onClose: () => void
}) {
  /**
   * ⚠️ 這個彈窗被 AutoSpin「Game URL」與機台測試「大廳 URL」共用。
   *    v4.105.0 給 URL 帳號池加了 UAT 之後，**這裡仍然只看得到 191 筆 QAT**——
   *    使用者截圖回報「共 191 個帳號」。加資料源時沒把消費端一起更新，
   *    跟今天修過兩次的「新增狀態但漏掉讀取端」是同一種。
   */
  const [poolEnv, setPoolEnv] = useState<PoolEnv>('qat')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [claims, setClaims] = useState<Record<string, { claimedBy: string | null }>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [hideUsed, setHideUsed] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/url-pool/overrides').then(r => r.json()).catch(() => ({})),
      fetch('/api/url-pool/status').then(r => r.json()).catch(() => ({})),
    ]).then(([o, claimsData]: [Record<string, string>, Record<string, { claimedBy: string | null }>]) => {
      setOverrides(o)
      setClaims(claimsData)
      setLoading(false)
    })
  }, [])

  // 跟著分頁重算（override 在這裡才套上）——存成 state 的話切分頁不會更新
  const entries = POOL_SOURCE[poolEnv].map(r => ({ ...r, url: overrides[r.account] ?? r.url }))

  const filtered = entries.filter(e => {
    // ⚠️ 沒有 URL 的不能選：選了會把空字串帶進 Game URL 欄位。
    //    UAT 有 27 筆是這種（產 token 的腳本沒跑出來）。
    if (!e.url) return false
    if (hideUsed && claims[e.account]?.claimedBy) return false
    const q = search.toLowerCase()
    return !q || e.username.toLowerCase().includes(q) || e.account.includes(q)
  })

  const handleSelect = async (e: UrlPoolEntry) => {
    // Claim the account so URL pool page reflects it as "佔用"
    await fetch(`/api/url-pool/${e.account}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimedBy: claimedByLabel }),
    }).catch(() => { /* non-fatal */ })
    onSelect(e.url)
    onClose()
  }

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#1e293b', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: 520, maxWidth: '95vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>帳號池 — {title}</span>
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} style={{ padding: '2px 8px', fontSize: 16 }}>關閉</button>
        </div>

        {/* Filters */}
        {/* ⚠️ 環境分頁。兩邊是完全獨立的帳號池（網域不同），不是同一批的篩選，
            所以做成分頁——跟 URL 帳號池那頁同一套心智模型，不要在這裡另創一種。 */}
        <div style={{ padding: '10px 20px 0', display: 'flex', gap: 4 }}>
          {POOL_ENVS.map(e => (
            <button
              key={e} type="button" onClick={() => setPoolEnv(e)}
              data-testid={`pool-picker-env-${e}`}
              style={{
                padding: '5px 14px', borderRadius: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${poolEnv === e ? '#2563eb' : '#2d3f55'}`,
                background: poolEnv === e ? '#2563eb' : 'transparent',
                color: poolEnv === e ? '#fff' : '#94a3b8',
              }}
            >
              {POOL_LABEL[e]}
              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, opacity: .75 }}>
                {POOL_SOURCE[e].filter(r => r.url).length}
              </span>
            </button>
          ))}
        </div>

        <div style={{ padding: '10px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            autoFocus
            placeholder="搜尋使用者名稱或帳號..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={hideUsed} onChange={e => setHideUsed(e.target.checked)} />
            只顯示空閒
          </label>
        </div>

        {/* Table */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#64748b' }}>載入中...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#64748b' }}>無符合帳號</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#162032', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#cbd5e1', borderBottom: '1px solid #e5e7eb' }}>使用者名稱</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#cbd5e1', borderBottom: '1px solid #e5e7eb' }}>狀態</th>
                  <th style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => {
                  const claimedBy = claims[e.account]?.claimedBy
                  return (
                    <tr key={e.account} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '7px 12px', color: '#cbd5e1' }}>{e.username}</td>
                      <td style={{ padding: '7px 12px' }}>
                        {claimedBy
                          ? <span style={{ color: '#ef4444', fontSize: 12 }}>佔用（{claimedBy}）</span>
                          : <span style={{ color: '#22c55e', fontSize: 12 }}>空閒</span>}
                      </td>
                      <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 12, padding: '3px 10px', color: '#2563eb' }}
                          onClick={() => handleSelect(e)}
                        >
                          選取
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid #f3f4f6', fontSize: 12, color: '#64748b' }}>
          共 {filtered.length} 個帳號
        </div>
      </div>
    </div>,
    document.body,
  )
}

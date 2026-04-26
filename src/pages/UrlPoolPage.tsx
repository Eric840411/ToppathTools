import { useEffect, useRef, useState } from 'react'
import type { AccountInfo } from '../components/JiraAccountModal'
import { URL_POOL_DATA, type UrlPoolEntry } from '../data/urlPoolData'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ClaimMap {
  [account: string]: { claimedBy: string; claimedAt: number }
}

interface Props {
  currentAccount: AccountInfo | null
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildProxyUrl(row: UrlPoolEntry, userLabel: string): string {
  const serverOrigin = window.location.port === '5173'
    ? `${window.location.protocol}//${window.location.hostname}:3000`
    : window.location.origin
  const encoded = btoa(row.url)
  return `${serverOrigin}/api/url-pool/go/${row.account}?user=${encodeURIComponent(userLabel)}&to=${encoded}`
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function UrlPoolPage({ currentAccount }: Props) {
  const [claims, setClaims] = useState<ClaimMap>({})
  const [editingRow, setEditingRow] = useState<string | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [localData, setLocalData] = useState<UrlPoolEntry[]>(() =>
    URL_POOL_DATA.map(r => ({ ...r }))
  )
  const [filter, setFilter] = useState<'all' | 'available' | 'in-use' | 'mine'>('all')
  const [searchText, setSearchText] = useState('')
  const [loadingAccount, setLoadingAccount] = useState<string | null>(null)
  const [copiedAccount, setCopiedAccount] = useState<string | null>(null)
  const [viewingUrl, setViewingUrl] = useState<string | null>(null)
  const [viewCopied, setViewCopied] = useState(false)
  const sseRef = useRef<EventSource | null>(null)

  const isAdmin = !!sessionStorage.getItem('jira_admin_pin')

  // ── Load DB URL overrides on mount ──────────────────────────────────────────
  useEffect(() => {
    fetch('/api/url-pool/overrides')
      .then(r => r.json())
      .then((overrides: Record<string, string>) => {
        setLocalData(URL_POOL_DATA.map(r => ({ ...r, url: overrides[r.account] ?? r.url })))
      })
      .catch(() => { /* keep static data */ })
  }, [])

  // ── SSE connection ──────────────────────────────────────────────────────────
  useEffect(() => {
    const connect = () => {
      const es = new EventSource('/api/url-pool/stream')
      sseRef.current = es
      es.onmessage = (e) => {
        try { setClaims(JSON.parse(e.data)) } catch { /* ignore */ }
      }
      es.onerror = () => {
        es.close()
        setTimeout(connect, 3000)
      }
    }
    connect()
    return () => sseRef.current?.close()
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleCopyProxyUrl(row: UrlPoolEntry) {
    if (!currentAccount) return
    const proxyUrl = buildProxyUrl(row, currentAccount.label)
    try {
      await navigator.clipboard.writeText(proxyUrl)
      setCopiedAccount(row.account)
      setTimeout(() => setCopiedAccount(a => a === row.account ? null : a), 2000)
    } catch {
      prompt('複製以下 URL：', proxyUrl)
    }
  }

  async function handleRelease(account: string) {
    if (!currentAccount) return
    setLoadingAccount(account)
    try {
      await fetch(`/api/url-pool/${account}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimedBy: currentAccount.label }),
      })
    } catch {
      alert('網路錯誤')
    } finally {
      setLoadingAccount(null)
    }
  }

  function startEdit(row: UrlPoolEntry) {
    setEditingRow(row.account)
    setEditUrl(row.url)
  }

  async function saveEdit(account: string) {
    setSavingEdit(true)
    try {
      const pin = sessionStorage.getItem('jira_admin_pin') ?? ''
      const res = await fetch(`/api/url-pool/${account}/url`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin },
        body: JSON.stringify({ url: editUrl }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string }
        alert(err.message ?? '儲存失敗')
        return
      }
      setLocalData(prev => prev.map(r => r.account === account ? { ...r, url: editUrl } : r))
      setEditingRow(null)
    } catch {
      alert('網路錯誤')
    } finally {
      setSavingEdit(false)
    }
  }

  // ── Filtered rows ────────────────────────────────────────────────────────────
  const myLabel = currentAccount?.label ?? ''

  const filtered = localData.filter(row => {
    const claim = claims[row.account]
    if (filter === 'available' && claim) return false
    if (filter === 'in-use' && !claim) return false
    if (filter === 'mine' && claim?.claimedBy !== myLabel) return false
    if (searchText) {
      const s = searchText.toLowerCase()
      return (
        row.account.includes(s) ||
        row.username.toLowerCase().includes(s) ||
        row.url.toLowerCase().includes(s)
      )
    }
    return true
  })

  const totalInUse = Object.keys(claims).length
  const totalAvail = localData.length - totalInUse
  const myCount = Object.values(claims).filter(c => c.claimedBy === myLabel).length

  return (
    <div style={{ padding: '0 0 24px' }}>
      {/* ── Header stats ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <StatBadge label="總計" value={localData.length} color="#6b7280" />
          <StatBadge label="可用" value={totalAvail} color="#16a34a" />
          <StatBadge label="使用中" value={totalInUse} color="#dc2626" />
          {myLabel && <StatBadge label="我的" value={myCount} color="#2563eb" />}
        </div>

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {(['all', 'available', 'in-use', 'mine'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid',
                background: filter === f ? '#2563eb' : '#f3f4f6',
                color: filter === f ? '#fff' : '#374151',
                borderColor: filter === f ? '#2563eb' : '#e2e8f0',
              }}
            >
              {f === 'all' ? '全部' : f === 'available' ? '可用' : f === 'in-use' ? '使用中' : '我的'}
            </button>
          ))}
          <input
            type="text"
            placeholder="搜尋帳號/用戶名稱..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, width: 160 }}
          />
        </div>
      </div>

      {!currentAccount && (
        <div style={{ padding: '10px 14px', background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          請先在右上角選擇帳號才能複製使用 URL
        </div>
      )}

      <div style={{ padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, marginBottom: 12, fontSize: 12, color: '#1d4ed8' }}>
        💡 「複製使用 URL」會產生一個中轉連結，貼到 AutoSpin Game URL 或機台測試 Game URL 使用。開啟時自動認領，8 小時後自動釋放。
      </div>

      {/* ── Table ─────────────────────────────────────────────────────────────── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
              <th style={th}>帳號</th>
              <th style={th}>用戶名稱</th>
              <th style={th}>Token URL</th>
              <th style={th}>狀態</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(row => {
              const claim = claims[row.account]
              const isClaimedByMe = claim?.claimedBy === myLabel
              const isEditing = editingRow === row.account
              const isLoading = loadingAccount === row.account
              const isCopied = copiedAccount === row.account

              return (
                <tr key={row.account} style={{ borderBottom: '1px solid #f1f5f9', background: isClaimedByMe ? '#eff6ff' : claim ? '#fef2f2' : undefined }}>
                  <td style={td}>{row.account}</td>
                  <td style={td}>{row.username}</td>
                  <td style={{ ...td, maxWidth: 360 }}>
                    {isEditing ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          value={editUrl}
                          onChange={e => setEditUrl(e.target.value)}
                          style={{ flex: 1, fontSize: 11, padding: '2px 6px', border: '1px solid #93c5fd', borderRadius: 4 }}
                        />
                        <button type="button" onClick={() => saveEdit(row.account)} disabled={savingEdit} style={btnSm('#16a34a')}>{savingEdit ? '...' : '儲存'}</button>
                        <button type="button" onClick={() => setEditingRow(null)} disabled={savingEdit} style={btnSm('#6b7280')}>取消</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 11, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }} title={row.url}>
                          {row.url}
                        </span>
                        <button type="button" onClick={() => setViewingUrl(row.url)} style={btnSm('#6b7280', true)}>查看</button>
                        {isAdmin && <button type="button" onClick={() => startEdit(row)} style={btnSm('#6b7280', true)}>編輯</button>}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    {claim ? (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: isClaimedByMe ? '#dbeafe' : '#fee2e2', color: isClaimedByMe ? '#1d4ed8' : '#dc2626' }}>
                        {isClaimedByMe ? '我' : claim.claimedBy}
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: '#dcfce7', color: '#16a34a' }}>可用</span>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {/* 複製使用 URL — available to anyone with account, triggers auto-claim on use */}
                      <button
                        type="button"
                        disabled={!currentAccount || isLoading}
                        onClick={() => handleCopyProxyUrl(row)}
                        style={btnSm(isCopied ? '#16a34a' : '#2563eb')}
                        title="複製中轉 URL，貼到 AutoSpin / 機台測試 Game URL，開啟時自動認領"
                      >
                        {isCopied ? '已複製！' : '複製使用 URL'}
                      </button>
                      {/* 釋放 — only for rows claimed by me */}
                      {isClaimedByMe && (
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleRelease(row.account)}
                          style={btnSm('#dc2626')}
                        >
                          {isLoading ? '...' : '釋放'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: '#9ca3af', fontSize: 13 }}>沒有符合條件的項目</div>
        )}
      </div>

      {/* ── View URL modal ───────────────────────────────────────────────────── */}
      {viewingUrl && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setViewingUrl(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 10, padding: 20, maxWidth: 640, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Token URL</div>
            <textarea
              readOnly
              value={viewingUrl}
              style={{ width: '100%', minHeight: 100, fontSize: 11, fontFamily: 'monospace', border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, resize: 'vertical', boxSizing: 'border-box' }}
              onFocus={e => e.target.select()}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => {
                  const doCopy = (text: string) => {
                    // Fallback for non-HTTPS / non-localhost (clipboard API unavailable)
                    const ta = document.createElement('textarea')
                    ta.value = text
                    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px'
                    document.body.appendChild(ta)
                    ta.focus(); ta.select()
                    document.execCommand('copy')
                    document.body.removeChild(ta)
                  }
                  if (navigator.clipboard) {
                    navigator.clipboard.writeText(viewingUrl).catch(() => doCopy(viewingUrl))
                  } else {
                    doCopy(viewingUrl)
                  }
                  setViewCopied(true)
                  setTimeout(() => setViewCopied(false), 2000)
                }}
                style={btnSm(viewCopied ? '#16a34a' : '#2563eb')}
              >{viewCopied ? '已複製！' : '複製'}</button>
              <button type="button" onClick={() => { setViewingUrl(null); setViewCopied(false) }} style={btnSm('#6b7280')}>關閉</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#f8fafc', border: `1px solid ${color}22`, borderRadius: 8, fontSize: 12 }}>
      <span style={{ color: '#6b7280' }}>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: '#374151', fontSize: 12,
}
const td: React.CSSProperties = {
  padding: '6px 10px', verticalAlign: 'middle',
}
function btnSm(color: string, ghost = false): React.CSSProperties {
  return {
    padding: '2px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', border: `1px solid ${color}`,
    background: ghost ? 'transparent' : color,
    color: ghost ? color : '#fff',
    flexShrink: 0,
  }
}

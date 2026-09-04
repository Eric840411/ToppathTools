import { useEffect, useRef, useState } from 'react'
import type { AccountInfo } from '../components/JiraAccountModal'
import { type UrlPoolEntry } from '../data/urlPoolData'
import { POOL_SOURCE, POOL_LABEL, type PoolEnv } from '../data/urlPoolEnv'

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
  const [poolEnv, setPoolEnv] = useState<PoolEnv>('qat')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  /**
   * 被我們自己的工具「綁在設定裡」的帳號（key 是 username）。
   *
   * ⚠️ 跟 `claims`（中轉認領）**不是同一件事**。中轉是自願制，實測幾乎沒人走——
   *    8 台已設定的 Game URL 裡 5 台在用帳號池的帳號、0 台走中轉，畫面卻顯示「使用中 0」。
   *    這份是從 `autospin_configs.gameUrl` 反推的，不需要任何人配合。
   */
  const [assigned, setAssigned] = useState<Record<string, { by: string; machineType: string }>>({})
  const [assignedFailed, setAssignedFailed] = useState(false)
  /**
   * ⚠️ 資料要跟著 env 重算，而且 override 要一起套。
   *    原本是 mount 時把 override 併進去存成 state——切 env 之後那份 state 還是舊環境的，
   *    切回來也不會重抓（那支 fetch 只跑一次）。改成「原始資料 + override」在 render 時合併。
   */
  const localData = POOL_SOURCE[poolEnv].map(r => ({ ...r, url: overrides[r.account] ?? r.url }))
  const [filter, setFilter] = useState<'all' | 'available' | 'in-use' | 'mine'>('all')
  const [searchText, setSearchText] = useState('')
  const [loadingAccount, setLoadingAccount] = useState<string | null>(null)
  const [copiedAccount, setCopiedAccount] = useState<string | null>(null)
  const [viewingUrl, setViewingUrl] = useState<string | null>(null)
  const [viewCopied, setViewCopied] = useState(false)
  const sseRef = useRef<EventSource | null>(null)

  const isAdmin = currentAccount?.role === 'admin'

  // ── Load DB URL overrides on mount ──────────────────────────────────────────
  useEffect(() => {
    fetch('/api/url-pool/overrides')
      .then(r => r.json())
      .then((o: Record<string, string>) => setOverrides(o))
      .catch(() => { /* keep static data */ })
  }, [])

  // ⚠️ 即時查，不做快取（跟 CodeX 討論定案）：資料量很小（691 × 8），而且
  //    autospin_configs 是使用者手動改的，多一層快取只會讓狀態更難解釋。
  useEffect(() => {
    fetch('/api/url-pool/assigned')
      .then(r => r.json())
      .then((d: { ok: boolean; assigned?: Record<string, { by: string; machineType: string }> }) => {
        if (d.ok && d.assigned) { setAssigned(d.assigned); setAssignedFailed(false) }
        else setAssignedFailed(true)
      })
      // ⚠️ 失敗要標示。靜默當成「沒有人綁著」正是這個功能要修的那種誤導
      .catch(() => setAssignedFailed(true))
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
      const res = await fetch(`/api/url-pool/${account}/url`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: editUrl }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string }
        alert(err.message ?? '儲存失敗')
        return
      }
      setOverrides(prev => ({ ...prev, [account]: editUrl }))
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

  const totalInUse = localData.filter(r => claims[r.account]).length
  const totalAssigned = localData.filter(r => !claims[r.account] && assigned[r.username]).length
  const totalNoUrl = localData.filter(r => !r.url).length
  // 可用 = 沒被認領、沒被設定綁著、而且真的有 URL
  const totalAvail = localData.filter(r => !claims[r.account] && !assigned[r.username] && r.url).length
  const myCount = Object.values(claims).filter(c => c.claimedBy === myLabel).length

  return (
    <div style={{ padding: '0 0 24px' }}>
      {/* ── Header stats ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* ⚠️ 兩個環境是**完全獨立的帳號池**（網域不同、號段不同），不是同一批資料的篩選。
            所以做成分頁而不是篩選鈕——放在篩選鈕旁邊會讓人以為可以「同時看兩邊」。 */}
        <div style={{ display: 'flex', gap: 4, padding: 3, background: '#0f172a', border: '1px solid #2d3f55', borderRadius: 8 }}>
          {(['qat', 'uat'] as const).map(e => (
            <button
              key={e} type="button" onClick={() => setPoolEnv(e)}
              /* ⚠️ 給穩定識別：側邊欄有「總網試煉 UAT 整合測試」，
                 只靠文字找 UAT 會抓到那一個（驗證腳本第一版就是這樣點錯的）*/
              data-testid={`url-pool-env-${e}`}
              style={{
                padding: '5px 16px', borderRadius: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                border: 'none', background: poolEnv === e ? '#2563eb' : 'transparent',
                color: poolEnv === e ? '#fff' : '#94a3b8',
              }}
            >
              {POOL_LABEL[e]}
              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, opacity: .75 }}>{POOL_SOURCE[e].length}</span>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <StatBadge label="總計" value={localData.length} color="#6b7280" />
          <StatBadge label="可用" value={totalAvail} color="#16a34a" />
          <StatBadge label="使用中" value={totalInUse} color={totalInUse > 0 ? '#dc2626' : '#6b7280'} />
          {/* ⚠️ 「已設定」跟「使用中」要分開（CodeX review）：前者是某台機台的設定綁著這個帳號，
              可能沒在跑；後者是有人主動按了中轉。混成一個會讓人不知道能不能搶。 */}
          <StatBadge label="已設定" value={totalAssigned} color={totalAssigned > 0 ? '#d97706' : '#6b7280'} />
          {totalNoUrl > 0 && <StatBadge label="無 URL" value={totalNoUrl} color="#eab308" />}
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
                background: filter === f ? '#2563eb' : '#1e293b',
                color: filter === f ? '#fff' : '#94a3b8',
                borderColor: filter === f ? '#2563eb' : '#2d3f55',
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
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #2d3f55', fontSize: 12, width: 160 }}
          />
        </div>
      </div>

      {!currentAccount && (
        <div style={{ padding: '10px 14px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, marginBottom: 12, fontSize: 13, color: '#fbbf24' }}>
          請先在右上角選擇帳號才能複製使用 URL
        </div>
      )}

      {/* ⚠️ 讀不到「已設定」時一定要講。靜默的話畫面會顯示「已設定 0」，
          看起來像「沒有人綁著」——那正是這個功能要修的誤導。 */}
      {assignedFailed && (
        <div style={{ padding: '8px 12px', background: 'rgba(234,179,8,.08)', border: '1px solid rgba(234,179,8,.35)', borderRadius: 8, marginBottom: 12, fontSize: 12, color: '#eab308' }}>
          <b>讀不到「已設定」狀態</b>——下面的「可用」可能包含其實已經被某台機台設定綁住的帳號，拿走會撞帳號。重新整理再試一次。
        </div>
      )}

      <div style={{ padding: '8px 12px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 8, marginBottom: 12, fontSize: 12, color: '#60a5fa' }}>
        悟 「複製使用 URL」會產生一個中轉連結，貼到 AutoSpin Game URL 或機台測試 Game URL 使用。開啟時自動認領，8 小時後自動釋放。
      </div>

      {/* ── Table ─────────────────────────────────────────────────────────────── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#162032', borderBottom: '2px solid #2d3f55' }}>
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
                        <span style={{ fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }} title={row.url}>
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
                      /* ⚠️ 有帳號但沒有 URL 的不能標成「可用」——點下去會產生一個空的中轉連結。
                            這 27 筆是產 token 的腳本沒跑出來的，刻意保留在清單上（過濾掉的話
                            沒有人會知道它們存在），但要標清楚而且擋住複製。 */
                      !row.url
                        ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'rgba(234,179,8,.15)', color: '#eab308' }} title="這個帳號存在，但來源表上沒有 URL。用「編輯」補上就能使用。">無 URL</span>
                        : assigned[row.username]
                        ? <span
                            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'rgba(217,119,6,.15)', color: '#d97706' }}
                            title={`${assigned[row.username].by} 的「${assigned[row.username].machineType}」設定裡填著這個帳號。可能沒在跑，但拿走的話那台下次啟動會撞帳號。`}
                          >已設定 · {assigned[row.username].machineType}</span>
                        : <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: '#dcfce7', color: '#16a34a' }}>可用</span>

                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {/* 複製使用 URL — available to anyone with account, triggers auto-claim on use */}
                      <button
                        type="button"
                        disabled={!currentAccount || isLoading || !row.url}
                        onClick={() => handleCopyProxyUrl(row)}
                        style={btnSm(isCopied ? '#16a34a' : '#2563eb')}
                        title={row.url
                          ? '複製中轉 URL，貼到 AutoSpin / 機台測試 Game URL，開啟時自動認領'
                          : '這個帳號沒有 URL，請先用「編輯」補上'}
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
          <div style={{ textAlign: 'center', padding: 32, color: '#64748b', fontSize: 13 }}>沒有符合條件的項目</div>
        )}
      </div>

      {/* ── View URL modal ───────────────────────────────────────────────────── */}
      {viewingUrl && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setViewingUrl(null)}
        >
          <div
            style={{ background: '#1e293b', borderRadius: 10, padding: 20, maxWidth: 640, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Token URL</div>
            <textarea
              readOnly
              value={viewingUrl}
              style={{ width: '100%', minHeight: 100, fontSize: 11, fontFamily: 'monospace', border: '1px solid #2d3f55', borderRadius: 6, padding: 8, resize: 'vertical', boxSizing: 'border-box' }}
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#162032', border: `1px solid ${color}22`, borderRadius: 8, fontSize: 12 }}>
      <span style={{ color: '#94a3b8' }}>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: '#cbd5e1', fontSize: 12,
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

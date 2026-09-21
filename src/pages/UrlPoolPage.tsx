import { useEffect, useRef, useState } from 'react'
import type { AccountInfo } from '../components/JiraAccountModal'
import { type UrlPoolEntry } from '../data/urlPoolData'
import { POOL_SOURCE, POOL_LABEL, type PoolEnv } from '../data/urlPoolEnv'
import { POOL_DEVICES, POOL_DEVICE_LABEL, toDeviceUrl, type PoolDevice } from '../data/urlPoolDevice'
import { ProdSimPanel } from '../components/ProdSimPanel'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ClaimMap {
  [account: string]: { claimedBy: string; claimedAt: number }
}

interface Props {
  currentAccount: AccountInfo | null
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * ⚠️ `targetUrl` 要傳**已經套過版本（H5／PC）的那條**，不是 `row.url`。
 *    中轉端（`/api/url-pool/go/:account`）只認 `to`，原封不動 302 過去——
 *    這裡傳錯的話按鈕顯示 PC、開起來卻是 H5，而且完全不會報錯。
 */
function buildProxyUrl(account: string, targetUrl: string, userLabel: string): string {
  const serverOrigin = window.location.port === '5173'
    ? `${window.location.protocol}//${window.location.hostname}:3000`
    : window.location.origin
  const encoded = btoa(targetUrl)
  return `${serverOrigin}/api/url-pool/go/${account}?user=${encodeURIComponent(userLabel)}&to=${encoded}`
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function UrlPoolPage({ currentAccount }: Props) {
  const [claims, setClaims] = useState<ClaimMap>({})
  const [editingRow, setEditingRow] = useState<string | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  /**
   * ⚠️ 「模擬正式」不是第三個帳號池，是一個**轉換器分頁**（貼正式 token URL → 換網域），
   *    所以它只活在這個頁面的本地 state，`PoolEnv` 型別不動。
   *    把它塞進 `PoolEnv` 的話，AutoSpin／機台測試的帳號池選取彈窗會跟著多出
   *    一個永遠是空的分頁——那正是 [urlPoolEnv.ts] 開頭那段警語在講的漂移。
   */
  const [tab, setTab] = useState<PoolEnv | 'prodsim'>('qat')
  const poolEnv: PoolEnv = tab === 'prodsim' ? 'qat' : tab
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
  /**
   * 版本（H5／PC）。**不是第三個帳號池，也不是第三個環境**——同一個帳號、同一個 token，
   * 只是把 URL 的 `platform`／`device` 換掉，決定進 H5 還是 PC（Cocos）版。
   *
   * 兩層：`device` 是整頁的預設（使用者要求預設 H5），`rowDevice` 是單列覆寫（每列那顆切換鈕）。
   * 切整頁預設時會清掉所有單列覆寫，否則畫面上會出現「明明切成 PC，卻有幾列還是 H5」
   * 這種說不清楚的狀態。
   */
  const [device, setDevice] = useState<PoolDevice>('h5')
  const [rowDevice, setRowDevice] = useState<Record<string, PoolDevice>>({})
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

  // ── 版本（H5／PC）──────────────────────────────────────────────────────────
  const deviceOf = (account: string): PoolDevice => rowDevice[account] ?? device

  function switchAllDevices(d: PoolDevice) {
    setDevice(d)
    setRowDevice({})   // 見 state 宣告處：不清的話會留下解釋不了的混合狀態
  }

  function toggleRowDevice(account: string) {
    const next: PoolDevice = deviceOf(account) === 'h5' ? 'pc' : 'h5'
    setRowDevice(prev => ({ ...prev, [account]: next }))
    // 換了版本，已複製／查看中的提示就不再指向同一條 URL，清掉免得誤會
    setCopiedAccount(a => a === account ? null : a)
  }

  async function handleCopyProxyUrl(row: UrlPoolEntry, targetUrl: string) {
    if (!currentAccount) return
    const proxyUrl = buildProxyUrl(row.account, targetUrl, currentAccount.label)
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
          {(['qat', 'uat', 'prodsim'] as const).map(e => (
            <button
              key={e} type="button" onClick={() => setTab(e)}
              /* ⚠️ 給穩定識別：側邊欄有「總網試煉 UAT 整合測試」，
                 只靠文字找 UAT 會抓到那一個（驗證腳本第一版就是這樣點錯的）*/
              data-testid={`url-pool-env-${e}`}
              style={{
                padding: '5px 16px', borderRadius: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                border: 'none', background: tab === e ? '#2563eb' : 'transparent',
                color: tab === e ? '#fff' : '#94a3b8',
              }}
            >
              {e === 'prodsim' ? '模擬正式' : POOL_LABEL[e]}
              {/* 模擬正式沒有帳號數可以顯示（它不是帳號池），所以只有兩個環境有數字 */}
              {e !== 'prodsim' && (
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, opacity: .75 }}>{POOL_SOURCE[e].length}</span>
              )}
            </button>
          ))}
        </div>

        {/* 統計與篩選只屬於帳號池；模擬正式分頁沒有清單可以統計／篩選 */}
        {tab !== 'prodsim' && (<>
        {/* ⚠️ 版本跟環境是**不同維度**：環境換的是「哪一批帳號」，版本換的是「同一個帳號進哪一版」。
            所以樣式刻意跟 QAT/UAT 那組分頁不同（這是開關不是分頁），避免被當成第三個帳號池。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#64748b' }}>版本</span>
          <div style={{ display: 'flex', gap: 2, padding: 2, background: '#0f172a', border: '1px solid #2d3f55', borderRadius: 7 }}>
            {POOL_DEVICES.map(d => (
              <button
                key={d} type="button" onClick={() => switchAllDevices(d)}
                data-testid={`url-pool-device-${d}`}
                title={d === 'h5'
                  ? 'H5（手機版）：帳號池原始的 Token URL'
                  : 'PC（Cocos 版）：同一個 token，只把 platform 換成 50、device 換成 pc'}
                style={{
                  padding: '4px 12px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: 'none', background: device === d ? '#0891b2' : 'transparent',
                  color: device === d ? '#fff' : '#94a3b8',
                }}
              >{POOL_DEVICE_LABEL[d]}</button>
            ))}
          </div>
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
        </>)}
      </div>

      {tab === 'prodsim' ? <ProdSimPanel /> : (<>

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
        <div style={{ marginTop: 4, color: '#94a3b8' }}>
          「版本」切 PC 只是把同一條 URL 的 <code>platform</code> 換成 <code>50</code>、<code>device</code> 換成 <code>pc</code>——
          帳號、token、遊戲都不變，所以 H5 / PC 共用同一份認領狀態（同一個帳號同時只能在一邊玩）。
        </div>
      </div>

      {/* ── Table ─────────────────────────────────────────────────────────────── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#162032', borderBottom: '2px solid #2d3f55' }}>
              <th style={th}>帳號</th>
              <th style={th}>用戶名稱</th>
              <th style={th}>Token URL</th>
              <th style={th}>版本</th>
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
              const rowDev = deviceOf(row.account)
              /** 這一列實際要用的 URL。⚠️ 永遠從 `row.url`（原始 H5）算，不要接著上一次的結果轉。 */
              const effUrl = toDeviceUrl(row.url, rowDev)

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
                        <span style={{ fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }} title={effUrl}>
                          {effUrl}
                        </span>
                        <button type="button" onClick={() => setViewingUrl(effUrl)} style={btnSm('#6b7280', true)}>查看</button>
                        {/* ⚠️ 「編輯」動的一律是**原始（H5）URL**，不是畫面上那條轉換後的。
                            PC 版是算出來的，存回去會把轉換結果變成資料本身，下次再轉就疊上去了。 */}
                        {isAdmin && (
                          <button
                            type="button" onClick={() => startEdit(row)} style={btnSm('#6b7280', true)}
                            title={rowDev === 'pc' ? '編輯原始（H5）Token URL——PC 版是由它換算出來的，不另外儲存' : undefined}
                          >編輯</button>
                        )}
                      </div>
                    )}
                  </td>
                  {/* ── 版本切換（單列覆寫整頁預設）───────────────────────────── */}
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      onClick={() => toggleRowDevice(row.account)}
                      disabled={!row.url}
                      data-testid={`url-pool-row-device-${row.account}`}
                      title={row.url
                        ? (rowDev === 'h5' ? '目前是 H5，點一下改用 PC（Cocos）版' : '目前是 PC（Cocos），點一下改回 H5')
                        : '這個帳號沒有 URL，沒有東西可以切換'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
                        borderRadius: 999, fontSize: 11, fontWeight: 700, flexShrink: 0,
                        cursor: row.url ? 'pointer' : 'not-allowed',
                        opacity: row.url ? 1 : .45,
                        border: `1px solid ${rowDev === 'pc' ? '#0891b2' : '#2d3f55'}`,
                        background: rowDev === 'pc' ? 'rgba(8,145,178,.15)' : '#1e293b',
                        color: rowDev === 'pc' ? '#22d3ee' : '#94a3b8',
                      }}
                    >
                      {POOL_DEVICE_LABEL[rowDev]}
                      <span style={{ fontSize: 10, fontWeight: 400, opacity: .7 }}>⇄</span>
                    </button>
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
                        onClick={() => handleCopyProxyUrl(row, effUrl)}
                        style={btnSm(isCopied ? '#16a34a' : '#2563eb')}
                        title={row.url
                          ? `複製中轉 URL（${POOL_DEVICE_LABEL[rowDev]} 版），貼到 AutoSpin / 機台測試 Game URL，開啟時自動認領`
                          : '這個帳號沒有 URL，請先用「編輯」補上'}
                      >
                        {isCopied ? '已複製！' : `複製使用 URL${rowDev === 'pc' ? '（PC）' : ''}`}
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

      </>)}
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

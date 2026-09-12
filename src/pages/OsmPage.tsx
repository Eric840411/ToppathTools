import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  gameTypeOf,
  isMachineOnline,
  groupByChannelForType,
  hasVersionMismatch,
  matchRange,
  referenceVersion,
  searchDistribution,
} from './osm-gametype-dist'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OsmMachine {
  id: string
  channelId: string
  machineName: string
  machineType: string
  version: string
  /** 後端正規化：online | offline | unknown */
  onlineState: string
}

interface OsmChannelResult {
  name: string
  channelId: number
  machines: OsmMachine[]
  error?: string
  syncTime: string
}

interface OsmComponentVersion {
  name: string
  version: string
  pending?: boolean
}

interface LlProtocolMachine {
  gmid: string
  clientversion: string
  isactive: boolean
  onTarget: boolean | null
}

interface LlProtocolGame {
  name: string
  machines: LlProtocolMachine[]
  online: number
  offline: number
  onTargetCount: number
}

interface LlProtocolGroup {
  targetVersion: string | null
  total: number
  online: number
  offline: number
  onTargetCount: number
  games: LlProtocolGame[]
}

interface LlProtocolVersions {
  SAS: LlProtocolGroup
  MML: LlProtocolGroup
  G2S: LlProtocolGroup
}

interface LlGameProtocolEntry extends LlProtocolGame {
  targetVersion: string | null
}

interface LlGameGroup {
  name: string
  total: number
  online: number
  offline: number
  protocols: Partial<Record<'SAS' | 'MML' | 'G2S', LlGameProtocolEntry>>
}

interface VersionRecord {
  serverName: string
  ip: string
  currentVersion: string
  targetVersion?: string
  status?: string
}

interface ReportSummary {
  totalServers: number
  upToDate: number
  outdated: number
  unknown: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getVersionDistribution(machines: OsmMachine[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const m of machines) {
    const v = m.version || '未知'
    map.set(v, (map.get(v) ?? 0) + 1)
  }
  return map
}


// 機種代碼取法與 online 判定都在 osm-gametype-dist.ts（有單元測試），這裡只留薄包裝，
// 避免同一份規則在這個檔案裡長出第二套——那正是「缺少機台」那段跟機種卡數字對不上的原因。
function isOnline(m: OsmMachine): boolean {
  return isMachineOnline(m)
}

function countOnlineStates(machines: OsmMachine[]) {
  let online = 0
  let offline = 0
  let unknown = 0
  for (const m of machines) {
    const s = (m.onlineState ?? '').toString().trim().toLowerCase()
    if (s === 'online') online++
    else if (s === 'offline') offline++
    else unknown++
  }
  return { online, offline, unknown }
}

function imageReconStatusLabel(match: boolean): string {
  return match ? '通過 達標' : '未達標'
}

const CHANNEL_COLORS: Record<string, string> = {
  CP: '#4f86f7',
  WF: '#f76b4f',
  TBR: '#4fcf70',
  TBP: '#f7c94f',
  MDR: '#c44ff7',
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function VersionBar({ machines }: { machines: OsmMachine[] }) {
  const dist = getVersionDistribution(machines)
  const total = machines.length
  if (total === 0) return <div className="osm-vbar osm-vbar--empty">無資料</div>

  const BAR_COLORS = ['#4f86f7', '#4fcf70', '#f7c94f', '#f76b4f', '#c44ff7', '#4fcfc0', '#f7844f']
  const entries = [...dist.entries()].sort((a, b) => b[1] - a[1])

  return (
    <div className="osm-vbar">
      <div className="osm-vbar-track">
        {entries.map(([v, c], i) => (
          <div
            key={v}
            className="osm-vbar-seg"
            style={{ width: `${(c / total) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length] }}
            title={`${v}: ${c} 台`}
          />
        ))}
      </div>
      <div className="osm-vbar-legend">
        {entries.map(([v, c], i) => (
          <span key={v} className="osm-vbar-item">
            <span className="osm-vbar-dot" style={{ background: BAR_COLORS[i % BAR_COLORS.length] }} />
            {v} ({c})
          </span>
        ))}
      </div>
    </div>
  )
}

const CATEGORIES = ['MachineType', 'OSM', 'LuckyLink', 'Toppath', 'ImageRecon'] as const

function MachineRows({ machines, targetVersion }: { machines: OsmMachine[]; targetVersion?: string }) {
  const sorted = [...machines].sort((a, b) => {
    const ao = isOnline(a) ? 1 : 0
    const bo = isOnline(b) ? 1 : 0
    if (ao !== bo) return ao - bo
    return (a.machineName || a.id).localeCompare(b.machineName || b.id, 'zh-Hant')
  })
  return (
    <>
      {sorted.map(m => {
        const on = isOnline(m)
        const off = (m.onlineState ?? '').toString().trim().toLowerCase() === 'offline'
        const onTarget = targetVersion ? m.version === targetVersion : null
        return (
          <tr key={m.id} className={!on && off ? 'osm-machine-row--offline' : ''}>
            <td>{m.machineName || m.id}</td>
            <td>
              <span className={`osm-version-tag${onTarget === false ? ' osm-version-tag--diff' : ''}`}>
                {m.version || '—'}
              </span>
            </td>
            <td>
              {on ? (
                <span className="osm-badge osm-badge--online">Online</span>
              ) : off ? (
                <span className="osm-badge osm-badge--offline">Offline</span>
              ) : (
                <span className="osm-badge osm-badge--muted">{m.onlineState || '—'}</span>
              )}
            </td>
            <td>
              {onTarget === null ? (
                <span className="osm-badge osm-badge--muted">—</span>
              ) : onTarget ? (
                <span className="osm-badge osm-badge--ok">達標</span>
              ) : (
                <span className="osm-badge osm-badge--warn">未達標</span>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

function MachineTable({ machines, targets }: { machines: OsmMachine[]; targets: Record<string, Record<string, string>> }) {
  // Group by machineType
  const groups = new Map<string, OsmMachine[]>()
  for (const m of machines) {
    const key = m.machineType || '(未知類型)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(m)
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  return (
    <div className="osm-machine-groups-scroll">
      {sortedGroups.map(([type, ms]) => {
        const typeTargets = targets[type] ?? {}
        const mainTarget = typeTargets['MachineType']
        const onTargetCnt = mainTarget ? ms.filter(m => m.version === mainTarget).length : null
        const allOnTarget = onTargetCnt === ms.length
        return (
          <div key={type} className="osm-machine-group-col">
            <div className="osm-type-group-header">
              <span className="osm-type-badge">{type}</span>
              <span className="osm-type-count">{ms.length} 台</span>
              {mainTarget ? (
                <span className={`osm-badge ${allOnTarget ? 'osm-badge--ok' : 'osm-badge--warn'}`}>
                  {onTargetCnt}/{ms.length} 達標
                </span>
              ) : (
                <span className="osm-badge osm-badge--muted">未設定目標</span>
              )}
              {CATEGORIES.map(cat => typeTargets[cat] ? (
                <span key={cat} className="osm-type-cat-ver">
                  <span className="osm-type-cat-label">{cat}</span>
                  <span className="osm-type-cat-val">{typeTargets[cat]}</span>
                </span>
              ) : null)}
            </div>
            <table className="osm-machine-table">
              <thead>
                <tr>
                  <th>機台名稱</th>
                  <th>版本</th>
                  <th>連線</th>
                  <th>達標</th>
                </tr>
              </thead>
              <tbody>
                <MachineRows machines={ms} targetVersion={mainTarget} />
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// ── 機種渠道分布彈窗 ──
// 同一個機種會散在好幾個渠道上，先前只能一個渠道一個渠道翻。點上方機種卡就列出它分布在
// 哪些渠道、每台機器叫什麼。
//
// 資料完全來自畫面上已有的 channelResults，不打新的 API、不重新同步——機種卡的數字本來就是
// 從它算的，只是 allMachinesFlat 那行 flatten 時把「這台屬於哪個渠道」丟掉了。
function GameTypeChannelsModal({ type, channelResults, onClose }: {
  type: string
  channelResults: OsmChannelResult[]
  onClose: () => void
}) {
  // 預設隱藏不在線上的機台（使用者決定），但保留開關
  const [showOffline, setShowOffline] = useState(false)
  const [query, setQuery] = useState('')
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // ⚠️ 改搜尋字串時把清單捲回最上面。不做的話會出現跟「被離線開關藏住」同一類的假象：
  // 使用者捲到下面（141 台的機種捲得很長）才打字，結果命中的那幾列在最上面，
  // 畫面上只看到一片空白——看起來像沒有命中，其實只是捲過頭了。
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0 }, [query])

  useEffect(() => {
    // ⚠️ Esc 一律關彈窗，即使搜尋框有字——刻意不改成「先清搜尋」（跟 CodeX 討論定案：
    // 不為了這個加行為複雜度）。清除用輸入框右邊那顆 ×。
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 分組規則（含「只有離線機台的渠道也要列出來」）在 osm-gametype-dist.ts，有單元測試。
  // 渠道順序沿用 channelResults 自己的順序，跟左邊那排渠道卡一致（使用者決定）。
  const groups = groupByChannelForType(channelResults, type)

  const totalCount = groups.reduce((sum, g) => sum + g.machines.length, 0)
  const totalOnline = groups.reduce((sum, g) => sum + g.online, 0)
  const totalOffline = groups.reduce((sum, g) => sum + g.offline, 0)
  const totalUnknown = groups.reduce((sum, g) => sum + g.unknown, 0)

  // 版本標色的參考點：線上機台裡最多台在用的那個版本（只看線上，理由見那支函式的註解）
  const refVersion = referenceVersion(groups)

  const hiddenLabel = totalUnknown > 0 ? '離線/未知' : '離線'

  // 搜尋＋「顯示離線」開關套用後實際要畫的東西（規則在 osm-gametype-dist.ts，有單元測試）
  const found = searchDistribution(groups, query, showOffline)
  const q = query.trim().toLowerCase()

  /** 命中處高亮。用 React 節點組，不碰 innerHTML。 */
  const hl = (text: string) => {
    const r = matchRange(text, q)
    if (!r) return text
    return (
      <>
        {text.slice(0, r[0])}
        <mark className="osm-dist-hit">{text.slice(r[0], r[1])}</mark>
        {text.slice(r[1])}
      </>
    )
  }

  /** 「顯示離線」按鈕。⚠️ 一定要是真的按鈕不是一句灰字（CodeX review）。 */
  const revealBtn = (
    <button type="button" className="osm-dist-reveal" onClick={() => setShowOffline(true)}>
      顯示離線
    </button>
  )

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(3,7,18,0.72)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px 24px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(560px, 100%)', background: '#111c2e', border: '1px solid #334155',
          borderRadius: 12, boxShadow: '0 18px 48px rgba(0,0,0,0.55)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column', maxHeight: '80vh',
        }}
      >
        <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #24344a', display: 'flex', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: '#93c5fd', marginBottom: 5, wordBreak: 'break-all' }}>{type}</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.65 }}>
              {groups.length === 0 ? (
                <>目前沒有任何渠道有這個機種</>
              ) : (
                <>
                  分布在 <b style={{ color: '#f1f5f9' }}>{groups.length}</b> 個渠道，共 <b style={{ color: '#f1f5f9' }}>{totalCount}</b> 台
                  {' — '}線上 <b style={{ color: '#f1f5f9' }}>{totalOnline}</b>
                  {totalOffline > 0 && <>、離線 <b style={{ color: '#f1f5f9' }}>{totalOffline}</b></>}
                  {totalUnknown > 0 && <>、未知 <b style={{ color: '#f1f5f9' }}>{totalUnknown}</b></>}
                  <div style={{ color: '#64748b', marginTop: 2 }}>機種卡的「OSM」只算線上機台</div>
                </>
              )}
            </div>
          </div>
          <button
            type="button" onClick={onClose} aria-label="關閉"
            style={{
              background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6,
              width: 26, height: 26, flex: '0 0 auto', cursor: 'pointer', fontSize: 15, padding: 0,
              // × 這個字元在 em box 裡本來就偏下，靠 lineHeight 對不準（使用者回報過），
              // 用 flex 置中才會真的在框框正中間
              display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {totalCount > 0 && (
          <div className="osm-dist-tools">
            <div className="osm-dist-searchwrap">
              <span className="osm-dist-searchico" aria-hidden>🔍</span>
              <input
                className="osm-dist-search"
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜尋渠道／型號／機台名稱／版本"
                aria-label="搜尋這個機種的渠道、型號、機台名稱或版本"
              />
              {query && (
                <button type="button" className="osm-dist-clear" title="清除搜尋"
                  onClick={() => setQuery('')}>×</button>
              )}
            </div>
            <div className="osm-dist-toolrow">
              {totalCount > totalOnline && (
                <label>
                  <input type="checkbox" checked={showOffline} onChange={e => setShowOffline(e.target.checked)} />
                  顯示{hiddenLabel}機台（{totalCount - totalOnline} 台）
                </label>
              )}
              {found.active && (
                // ⚠️ 這行的分母是機種總台數，不是搜尋結果——上方「共 N 台」維持部署現況，
                // 搜尋的縮放只在這裡表達，兩個數字才不會互相矛盾。
                <span className="osm-dist-count">
                  符合 <b>{found.matchCount}</b> / {found.totalCount} 台
                  {found.hiddenByOffline > 0 && (
                    <>
                      ，另有 <b>{found.hiddenByOffline}</b> 台{hiddenLabel}已隱藏 {revealBtn}
                    </>
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {found.active && found.matchCount === 0 ? (
          // ⚠️ 這個狀態一定要跟「有命中但全被離線開關藏住」長得不一樣（CodeX review）：
          // 那個是黃字＋按鈕，這個是置中灰字。兩者混在一起的話，使用者會把「被藏住」
          // 誤讀成「沒有這台機器」。
          <div className="osm-dist-empty">
            沒有符合 <code>{query.trim()}</code> 的渠道、型號、機台或版本
            <div className="osm-dist-empty-sub">比對這四項，不是模糊比對</div>
          </div>
        ) : (
        <div ref={bodyRef} style={{ overflowY: 'auto', padding: '4px 0 10px' }}>
          {found.channels.map(({ channel: g, models, matchCount }, gi) => {
            const channelVisible = showOffline ? g.machines.length : g.online
            return (
              <div key={g.name} style={{ padding: '10px 16px 4px', borderTop: gi === 0 ? 'none' : '1px solid #1c2942' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
                  <span className="osm-channel-badge" style={{ background: CHANNEL_COLORS[g.name] ?? '#888', fontSize: 10, flexShrink: 0 }}>{hl(g.name)}</span>
                  <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                    {/* 搜尋中顯示「符合數 / 總數」——只寫符合數的話會跟上方的渠道統計對不上 */}
                    {found.active
                      ? <><b style={{ color: '#f1f5f9' }}>{matchCount}</b> / {g.machines.length} 台</>
                      : <><b style={{ color: '#f1f5f9' }}>{g.machines.length}</b> 台</>}
                    {' · '}線上 <b style={{ color: '#f1f5f9' }}>{g.online}</b>
                    {g.offline > 0 && <>{' · '}離線 <b style={{ color: '#f1f5f9' }}>{g.offline}</b></>}
                    {g.unknown > 0 && <>{' · '}未知 <b style={{ color: '#f1f5f9' }}>{g.unknown}</b></>}
                    {models.length > 1 && <>{' · '}<b style={{ color: '#f1f5f9' }}>{models.length}</b> 種機型</>}
                  </span>
                </div>

                {models.map(mg => {
                  const visible = mg.visible
                  // 這組型號裡有沒有版本跟基準不同的線上機台。**訊號跟版本欄標黃色共用
                  // 同一支 hasVersionMismatch()**——自己在這裡再寫一份 some() 等於畫面上
                  // 兩個地方各自定義「異常」，之後一定漂（那支函式的註解就是講這件事）。
                  // ⚠️ 一律看整組 mg.group.machines，不是搜尋後的 mg.matched：
                  // 這個型號有沒有版本異常是事實，不該因為搜尋縮小範圍就消失。
                  const tagClass = [
                    'osm-modeltag',
                    hasVersionMismatch(mg.group.machines, refVersion) ? 'osm-modeltag--alert' : '',
                    mg.group.online === 0 ? 'osm-modeltag--empty' : '',
                    mg.group.label ? '' : 'osm-modeltag--nolabel',
                  ].filter(Boolean).join(' ')
                  return (
                    <div key={mg.group.key || '(none)'} style={{ marginBottom: 8 }}>
                      {/* 機型那一行永遠顯示，即使這個機型底下一台都不在線上——它本身就是答案 */}
                      <div className={tagClass}>
                        <span className="osm-modeltag__label">{mg.group.label ? hl(mg.group.label) : '型號未提供'}</span>
                        <span className="osm-modeltag__count">
                          {found.active
                            ? <>{mg.matched.length} / {mg.group.machines.length} 台</>
                            : <>{mg.group.machines.length} 台</>}
                          {mg.group.online !== mg.group.machines.length && <>（線上 {mg.group.online}）</>}
                        </span>
                        <span className="osm-modeltag__rune">&#9670;</span>
                      </div>
                      {/* ⚠️ 搜尋中、命中的全是離線機台 → 明講並給一顆真的按鈕。
                          不講的話這裡會是一片空白，跟「這個型號沒有符合的」完全分不出來。 */}
                      {found.active && visible.length === 0 && mg.matched.length > 0 && (
                        <div className="osm-dist-hidden">
                          <span>找到 {mg.matched.length} 台符合搜尋的{hiddenLabel}機台，目前被「顯示{hiddenLabel}機台」隱藏</span>
                          {revealBtn}
                        </div>
                      )}
                      {visible.length > 0 && (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                          <tbody>
                            {visible.map(m => {
                              const on = isMachineOnline(m)
                              const off = (m.onlineState ?? '').toString().trim().toLowerCase() === 'offline'
                              const diff = !!refVersion && on && !!m.version && m.version !== refVersion
                              return (
                                <tr key={m.id}>
                                  <td style={{ padding: '3.5px 0', borderBottom: '1px solid #1a2537', fontFamily: 'monospace', color: on ? '#cbd5e1' : '#64748b' }}>
                                    {hl(m.machineName || m.id)}
                                  </td>
                                  <td style={{ padding: '3.5px 0', borderBottom: '1px solid #1a2537', width: 96 }}>
                                    <span className={diff ? 'osm-version-tag osm-version-tag--diff' : 'osm-version-tag'} style={{ fontSize: 11 }}>
                                      {m.version ? hl(m.version) : '—'}
                                    </span>
                                  </td>
                                  <td style={{ padding: '3.5px 0', borderBottom: '1px solid #1a2537', width: 64, textAlign: 'right' }}>
                                    {on ? (
                                      <span className="osm-badge osm-badge--online">Online</span>
                                    ) : off ? (
                                      <span className="osm-badge osm-badge--offline">Offline</span>
                                    ) : (
                                      <span className="osm-badge osm-badge--muted">{m.onlineState || '—'}</span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )
                })}

                {/* 搜尋中時這句不顯示——上面每個型號已經各自講了「符合 N 台但被藏住」，
                    再加一句渠道層級的會重複，而且它的台數是整個渠道的、跟搜尋結果對不上 */}
                {!found.active && channelVisible === 0 && (
                  // ⚠️ 這個渠道一台都不在線上時，渠道與機型那幾行仍然要顯示——使用者要回答的
                  // 問題是「這個機種在哪些渠道、什麼機型」，整段藏掉會讓他以為這裡沒有這個機種。
                  <div style={{ fontSize: 11, color: '#64748b', paddingBottom: 6 }}>
                    這個渠道的 {g.machines.length} 台都不在線上，開啟上方開關可以看到機器名稱
                  </div>
                )}
              </div>
            )
          })}
        </div>
        )}

        <div style={{ padding: '9px 16px', borderTop: '1px solid #24344a', fontSize: 11, color: '#64748b', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span>{refVersion ? '黃色版本 = 跟線上最多台在用的 ' + refVersion + ' 不同' : '渠道順序跟左邊那排渠道卡一致'}</span>
          <span>Esc 或點灰底關閉</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ChannelRow({
  result,
  selected,
  onSelect,
  onSync,
  loading,
  targets,
}: {
  result: OsmChannelResult
  selected: boolean
  onSelect: () => void
  onSync: (name: string) => void
  loading: boolean
  targets: Record<string, Record<string, string>>
}) {
  const color = CHANNEL_COLORS[result.name] ?? '#888'
  const { online, offline } = countOnlineStates(result.machines)
  const total = result.machines.length
  const onlinePct = total > 0 ? Math.round((online / total) * 100) : 0
  const hasTargets = Object.keys(targets).length > 0
  const onlineOffTarget = result.machines.filter(m => {
    const target = targets[m.machineType]?.['MachineType']
    return isOnline(m) && target && m.version !== target
  })
  const hasOffTarget = onlineOffTarget.length > 0
  const statusColor = result.error ? '#f87171' : (hasTargets && hasOffTarget) ? '#facc15' : hasTargets ? '#4ade80' : '#e2e8f0'

  return (
    <div
      className={`osm-channel-row${selected ? ' osm-channel-row--selected' : ''}`}
      style={{ borderLeftColor: statusColor }}
      onClick={onSelect}
    >
      <div className="osm-channel-row-main">
        <span className="osm-channel-badge" style={{ background: color }}>{result.name}</span>
        <span className="osm-card-count">{total} 台</span>
        {!result.error && total > 0 && (
          <span className="osm-channel-row-conn">
            <span className="osm-badge osm-badge--online">{online}</span>
            <span className="osm-badge osm-badge--offline">{offline}</span>
          </span>
        )}
        {result.error && <span className="osm-badge osm-badge--error">錯誤</span>}
        <button
          type="button"
          className="osm-btn osm-btn--sm osm-btn--icon-only"
          onClick={e => { e.stopPropagation(); onSync(result.name) }}
          disabled={loading}
          title="重新同步"
        >
          {loading ? '…' : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4" />
              <path d="M18 3v4h-4M6 21v-4h4" />
            </svg>
          )}
        </button>
      </div>
      {!result.error && total > 0 && (
        <div className="osm-online-bar-track osm-channel-row-bar">
          <div className="osm-online-bar-on" style={{ width: `${onlinePct}%` }} />
        </div>
      )}
      <div className="osm-channel-row-meta">
        <span className="osm-channel-row-time">{result.syncTime ? result.syncTime.slice(5, 16) : '—'}</span>
        {hasOffTarget && <span className="osm-badge osm-badge--warn">{onlineOffTarget.length}</span>}
        <span className="osm-channel-row-arrow">{selected ? '◀' : '▶'}</span>
      </div>
    </div>
  )
}

function ChannelDetailPanel({
  result,
  targets,
}: {
  result: OsmChannelResult
  targets: Record<string, Record<string, string>>
}) {
  const color = CHANNEL_COLORS[result.name] ?? '#888'
  const { online, offline, unknown } = countOnlineStates(result.machines)
  const total = result.machines.length
  const onlinePct = total > 0 ? Math.round((online / total) * 100) : 0
  const onlineOffTarget = result.machines.filter(m => {
    const target = targets[m.machineType]?.['MachineType']
    return isOnline(m) && target && m.version !== target
  })
  const offTargetByType = new Map<string, { target: string; count: number }>()
  for (const m of onlineOffTarget) {
    const target = targets[m.machineType]?.['MachineType'] ?? ''
    const entry = offTargetByType.get(m.machineType)
    if (entry) entry.count++
    else offTargetByType.set(m.machineType, { target, count: 1 })
  }
  const hasOffTarget = onlineOffTarget.length > 0

  return (
    <div className="osm-detail-panel">
      <div className="osm-detail-panel-header">
        <span className="osm-channel-badge osm-channel-badge--lg" style={{ background: color }}>{result.name}</span>
        <span className="osm-detail-count">{total} 台</span>
        {!result.error && total > 0 && (
          <>
            <span className="osm-badge osm-badge--online">{online} Online</span>
            <span className="osm-badge osm-badge--offline">{offline} Offline</span>
            {unknown > 0 && <span className="osm-badge osm-badge--muted">{unknown} 未知</span>}
          </>
        )}
        <span className="osm-detail-time">上次同步：{result.syncTime || '—'}</span>
      </div>

      {result.error ? (
        <p className="osm-card-error">{result.error}</p>
      ) : (
        <>
          {total > 0 && (
            <div className="osm-online-bar-wrap">
              <div className="osm-online-bar-track">
                <div className="osm-online-bar-on" style={{ width: `${onlinePct}%` }} />
              </div>
              <span className="osm-online-bar-lbl">連線率 {onlinePct}%</span>
            </div>
          )}
          {hasOffTarget && (
            <div className="osm-offtarget-alert">
              <span className="osm-offtarget-title">Online 未達標：{onlineOffTarget.length} 台</span>
              <div className="osm-offtarget-list">
                {[...offTargetByType.entries()].map(([mt, { target, count }]) => (
                  <span key={mt} className="osm-offtarget-item">
                    <span className="osm-type-badge">{mt}</span>
                    <span className="osm-offtarget-count">{count} 台</span>
                    <span className="osm-offtarget-arrow">→</span>
                    <span className="osm-offtarget-target">目標 {target}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <VersionBar machines={result.machines} />
          {result.machines.length > 0 && (
            <MachineTable machines={result.machines} targets={targets} />
          )}
          {result.machines.length === 0 && (
            <div className="osm-empty"><p>此渠道目前無機台資料。</p></div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Version Dashboard ────────────────────────────────────────────────────────

function VersionDashboard({
  channelResults, targets, versionHistory, llVersions, tpVersions,
  imageReconRecords, imageReconTargetVersion, llProto,
}: {
  channelResults: OsmChannelResult[]
  targets: Record<string, Record<string, string>>
  versionHistory: OsmComponentVersion[]
  llVersions: OsmComponentVersion[]
  tpVersions: OsmComponentVersion[]
  imageReconRecords: VersionRecord[]
  imageReconTargetVersion: string | null
  llProto: LlProtocolVersions | null
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)

  // Under-target machines with channel name
  const offTargetMachines = channelResults.flatMap(c =>
    c.machines
      .filter(m => { const t = targets[m.machineType]?.['MachineType']; return isOnline(m) && t && m.version !== t })
      .map(m => ({ ...m, channelName: c.name, target: targets[m.machineType]['MachineType'] }))
  )

  // Group machines: key = "channel|machineType|currentVersion"
  type MachineGroup = { channelName: string; machineType: string; current: string; target: string; count: number; machines: typeof offTargetMachines }
  const groupMap = new Map<string, MachineGroup>()
  for (const m of offTargetMachines) {
    const key = `${m.channelName}|${m.machineType}|${m.version}`
    const g = groupMap.get(key)
    if (g) { g.count++; g.machines.push(m) }
    else groupMap.set(key, { channelName: m.channelName, machineType: m.machineType, current: m.version, target: m.target, count: 1, machines: [m] })
  }
  const machineGroups = [...groupMap.values()].sort((a, b) => b.count - a.count)

  // Under-target components
  type CompIssue = { system: string; name: string; current: string; target: string }
  const irTarget = targets['ImageRecon']?.['ImageRecon'] ?? imageReconTargetVersion ?? null
  const offTargetComps: CompIssue[] = [
    ...versionHistory.filter(c => { const t = targets[c.name]?.['OSM']; return t && c.version !== t })
      .map(c => ({ system: 'OSM', name: c.name, current: c.version, target: targets[c.name]['OSM'] })),
    ...llVersions.filter(c => { const t = targets[c.name]?.['LuckyLink']; return !c.pending && t && c.version !== t })
      .map(c => ({ system: 'LuckyLink', name: c.name, current: c.version, target: targets[c.name]['LuckyLink'] })),
    ...tpVersions.filter(c => { const t = targets[c.name]?.['Toppath']; return t && c.version !== t })
      .map(c => ({ system: 'Toppath', name: c.name, current: c.version, target: targets[c.name]['Toppath'] })),
    ...(irTarget ? imageReconRecords.filter(r => r.currentVersion !== irTarget)
      .map(r => ({ system: 'ImageRecon', name: r.serverName, current: r.currentVersion, target: irTarget })) : []),
  ]

  // Under-target LuckyLink SAS/MML/G2S machines（只算在線機台，跟 offTargetMachines 同一套邏輯）
  type ProtoMachine = { protocol: 'SAS' | 'MML' | 'G2S'; game: string; gmid: string; current: string; target: string }
  const protoOffTargetMachines: ProtoMachine[] = []
  if (llProto) {
    for (const protoKey of ['SAS', 'MML', 'G2S'] as const) {
      const group = llProto[protoKey]
      if (!group.targetVersion) continue
      for (const game of group.games) {
        for (const m of game.machines) {
          if (m.isactive && m.onTarget === false) {
            protoOffTargetMachines.push({ protocol: protoKey, game: game.name, gmid: m.gmid, current: m.clientversion, target: group.targetVersion })
          }
        }
      }
    }
  }
  type ProtoGroup = { protocol: string; game: string; current: string; target: string; count: number; machines: ProtoMachine[] }
  const protoGroupMap = new Map<string, ProtoGroup>()
  for (const m of protoOffTargetMachines) {
    const key = `${m.protocol}|${m.game}|${m.current}`
    const g = protoGroupMap.get(key)
    if (g) { g.count++; g.machines.push(m) }
    else protoGroupMap.set(key, { protocol: m.protocol, game: m.game, current: m.current, target: m.target, count: 1, machines: [m] })
  }
  const protoGroups = [...protoGroupMap.values()].sort((a, b) => b.count - a.count)

  const hasAnyData = channelResults.length > 0 || versionHistory.length > 0 || llVersions.length > 0 || tpVersions.length > 0 || imageReconRecords.length > 0 || !!llProto
  if (!hasAnyData) {
    return <p className="osm-empty">尚未取得資料。按「迅 一鍵全部取得」同步所有版本。</p>
  }

  const totalIssues = offTargetMachines.length + offTargetComps.length + protoOffTargetMachines.length

  const sysColor: Record<string, string> = { OSM: '#dbeafe', LuckyLink: '#d1fae5', Toppath: '#ede9fe', ImageRecon: '#fce7f3' }

  return (
    <>
      {/* Summary */}
      <div className="osm-stat-row" style={{ marginBottom: 12 }}>
        <div className={`stat-chip ${totalIssues === 0 ? 'stat-chip--online' : 'stat-chip--warn'}`}>
          <span className="stat-chip-val">{totalIssues}</span>
          <span className="stat-chip-lbl">未達標項目</span>
        </div>
        <div className={`stat-chip ${offTargetMachines.length === 0 ? 'stat-chip--online' : 'stat-chip--warn'}`}>
          <span className="stat-chip-val">{offTargetMachines.length}</span>
          <span className="stat-chip-lbl">機台（{machineGroups.length} 組）</span>
        </div>
        <div className={`stat-chip ${offTargetComps.length === 0 ? 'stat-chip--online' : 'stat-chip--warn'}`}>
          <span className="stat-chip-val">{offTargetComps.length}</span>
          <span className="stat-chip-lbl">未達標元件</span>
        </div>
        <div className={`stat-chip ${protoOffTargetMachines.length === 0 ? 'stat-chip--online' : 'stat-chip--warn'}`}>
          <span className="stat-chip-val">{protoOffTargetMachines.length}</span>
          <span className="stat-chip-lbl">LuckyLink 機台（{protoGroups.length} 組）</span>
        </div>
      </div>

      {totalIssues === 0 && (
        <div className="osm-alert osm-alert--ok">通過 所有版本均已達標</div>
      )}

      {/* Machine groups — compact cards */}
      {machineGroups.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', marginBottom: 6, letterSpacing: '0.02em' }}>未達標機台（按類型分組）</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {machineGroups.map(g => {
              const key = `${g.channelName}|${g.machineType}|${g.current}`
              const expanded = expandedGroup === key
              return (
                <div key={key} style={{ border: '1px solid #334155', borderRadius: 6, overflow: 'hidden' }}>
                  {/* Group row */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#1e293b', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setExpandedGroup(expanded ? null : key)}
                  >
                    <span className="osm-channel-badge" style={{ background: CHANNEL_COLORS[g.channelName] ?? '#888', fontSize: 10, flexShrink: 0 }}>{g.channelName}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, flex: 1, color: '#f1f5f9' }}>{g.machineType}</span>
                    <span style={{ fontSize: 12, color: '#f87171', fontWeight: 700, marginRight: 4 }}>{g.current || '—'}</span>
                    <span style={{ fontSize: 12, color: '#64748b' }}>→</span>
                    <span style={{ fontSize: 12, color: '#4ade80', fontWeight: 700, marginLeft: 4, marginRight: 8 }}>{g.target}</span>
                    <span style={{ fontSize: 11, background: '#f59e0b22', border: '1px solid #f59e0b66', borderRadius: 10, padding: '1px 8px', fontWeight: 700, color: '#fbbf24' }}>{g.count} 台</span>
                    <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>{expanded ? '▲' : '▼'}</span>
                  </div>
                  {/* Expanded machine list */}
                  {expanded && (
                    <div style={{ padding: '6px 10px 8px', background: '#0f172a', borderTop: '1px solid #334155', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {g.machines.map(m => (
                        <span key={m.id} style={{ fontSize: 11, padding: '2px 7px', background: '#1e293b', border: '1px solid #475569', borderRadius: 4, color: '#cbd5e1', fontWeight: 500 }}>{m.machineName}</span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* LuckyLink protocol machine groups — compact cards */}
      {protoGroups.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', marginBottom: 6, letterSpacing: '0.02em' }}>未達標機台（LuckyLink 協定）</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {protoGroups.map(g => {
              const key = `proto|${g.protocol}|${g.game}|${g.current}`
              const expanded = expandedGroup === key
              return (
                <div key={key} style={{ border: '1px solid #334155', borderRadius: 6, overflow: 'hidden' }}>
                  {/* Group row */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#1e293b', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setExpandedGroup(expanded ? null : key)}
                  >
                    <span className="osm-type-badge" style={{ fontSize: 10, flexShrink: 0 }}>{g.protocol}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, flex: 1, color: '#f1f5f9' }}>{g.game}</span>
                    <span style={{ fontSize: 12, color: '#f87171', fontWeight: 700, marginRight: 4 }}>{g.current || '—'}</span>
                    <span style={{ fontSize: 12, color: '#64748b' }}>→</span>
                    <span style={{ fontSize: 12, color: '#4ade80', fontWeight: 700, marginLeft: 4, marginRight: 8 }}>{g.target}</span>
                    <span style={{ fontSize: 11, background: '#f59e0b22', border: '1px solid #f59e0b66', borderRadius: 10, padding: '1px 8px', fontWeight: 700, color: '#fbbf24' }}>{g.count} 台</span>
                    <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>{expanded ? '▲' : '▼'}</span>
                  </div>
                  {/* Expanded machine list */}
                  {expanded && (
                    <div style={{ padding: '6px 10px 8px', background: '#0f172a', borderTop: '1px solid #334155', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {g.machines.map(m => (
                        <span key={m.gmid} style={{ fontSize: 11, padding: '2px 7px', background: '#1e293b', border: '1px solid #475569', borderRadius: 4, color: '#cbd5e1', fontWeight: 500 }}>{m.gmid}</span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Components — compact table */}
      {offTargetComps.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', marginBottom: 6, letterSpacing: '0.02em' }}>未達標元件</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {offTargetComps.map(c => (
              <div key={`${c.system}-${c.name}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 12 }}>
                <span style={{ padding: '2px 7px', borderRadius: 4, background: sysColor[c.system] ?? '#334155', color: '#1e293b', fontSize: 11, flexShrink: 0, fontWeight: 700 }}>{c.system}</span>
                <span style={{ flex: 1, fontWeight: 600, color: '#f1f5f9', fontSize: 13 }}>{c.name}</span>
                <span style={{ color: '#f87171', fontWeight: 700, fontSize: 12 }}>{c.current || '—'}</span>
                <span style={{ color: '#64748b', fontSize: 12 }}>→</span>
                <span style={{ color: '#4ade80', fontWeight: 700, fontSize: 12 }}>{c.target}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function OsmPage() {
  // OSM machine versions
  const [channelResults, setChannelResults] = useState<OsmChannelResult[]>([])
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncingChannel, setSyncingChannel] = useState<string | null>(null)
  const [osmError, setOsmError] = useState<string | null>(null)
  const [neverSynced, setNeverSynced] = useState(true)
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [distType, setDistType] = useState<string | null>(null)

  // Machine type target versions (machineType → category → version)
  const [targets, setTargets] = useState<Record<string, Record<string, string>>>({})
  const [targetsExpanded, setTargetsExpanded] = useState(false)
  const larkSheetUrl = 'https://casinoplus.sg.larksuite.com/sheets/W2hDs1VnZh78mntQJJ9lkXvvgRf'
  const [larkSyncing, setLarkSyncing] = useState(false)
  const [larkSyncMsg, setLarkSyncMsg] = useState<{ ok: boolean; msg: string } | null>(null)

  // OSM Version History
  const [versionHistory, setVersionHistory] = useState<OsmComponentVersion[]>([])
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false)
  const [versionHistoryError, setVersionHistoryError] = useState<string | null>(null)
  const [versionHistorySyncTime, setVersionHistorySyncTime] = useState<string | null>(null)

  // LuckyLink Version History
  const [llVersions, setLlVersions] = useState<OsmComponentVersion[]>([])
  const [llLoading, setLlLoading] = useState(false)
  const [llError, setLlError] = useState<string | null>(null)
  const [llSyncTime, setLlSyncTime] = useState<string | null>(null)

  // LuckyLink SAS/MML/G2S 版本統計
  const [llProto, setLlProto] = useState<LlProtocolVersions | null>(null)
  const [llProtoNoData, setLlProtoNoData] = useState<{ count: number; offlineCount: number } | null>(null)
  const [llProtoLoading, setLlProtoLoading] = useState(false)
  const [llProtoError, setLlProtoError] = useState<string | null>(null)
  const [llProtoSyncTime, setLlProtoSyncTime] = useState<string | null>(null)
  const [llProtoExpandedGames, setLlProtoExpandedGames] = useState<Set<string>>(new Set())

  // Toppath Version History
  const [tpVersions, setTpVersions] = useState<OsmComponentVersion[]>([])
  const [tpLoading, setTpLoading] = useState(false)
  const [tpError, setTpError] = useState<string | null>(null)
  const [tpSyncTime, setTpSyncTime] = useState<string | null>(null)

  // Frontend machine count (pinus)
  const [frontendUrl, setFrontendUrl] = useState('')
  const [frontendLoading, setFrontendLoading] = useState(false)
  const [frontendCounts, setFrontendCounts] = useState<Record<string, number>>({})
  const [frontendGmids, setFrontendGmids] = useState<Set<string>>(new Set())
  const [frontendError, setFrontendError] = useState('')
  const [frontendSource, setFrontendSource] = useState<'server' | 'browser' | null>(null)
  const [expandedDiffTypes, setExpandedDiffTypes] = useState<Set<string>>(new Set())
  // Alert
  const [alertSending, setAlertSending] = useState(false)
  const [alertMsg, setAlertMsg] = useState<{ ok: boolean; msg: string } | null>(null)
  const [alertConfigExpanded, setAlertConfigExpanded] = useState(false)
  const [alertEnabled, setAlertEnabled] = useState(false)
  const [alertSchedule, setAlertSchedule] = useState('0 9 * * *')
  const [alertWebhookUrl, setAlertWebhookUrl] = useState('')
  const [alertConfigSaving, setAlertConfigSaving] = useState(false)

  // ImageRecon section
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [records, setRecords] = useState<VersionRecord[]>([])
  const [summary, setSummary] = useState<ReportSummary | null>(null)
  const [targetVersion, setTargetVersion] = useState<string | null>(null)
  const [generated, setGenerated] = useState<string | null>(null)


  // ─── OSM sync ─────────────────────────────────────────────────────────────

  const handleFetchFrontend = async () => {
    if (!frontendUrl.trim()) return
    setFrontendLoading(true); setFrontendError('')
    try {
      // Best path: backend Playwright simulates frontend login/session and fetches list automatically.
      const autoResp = await fetch('/api/osm/frontend-machines-auto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: frontendUrl.trim() }),
      })
      const autoData = await autoResp.json() as { ok: boolean; counts?: Record<string, number>; gmids?: string[]; message?: string }
      if (autoData.ok && autoData.counts && Object.keys(autoData.counts).length > 0) {
        setFrontendCounts(autoData.counts)
        setFrontendGmids(new Set((autoData.gmids ?? []).map(g => g.toLowerCase())))
        setExpandedDiffTypes(new Set())
        setFrontendSource('server')
        return
      }

      const r = await fetch('/api/osm/frontend-machines', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: frontendUrl.trim() }),
      })
      const d = await r.json() as { ok: boolean; counts?: Record<string, number>; message?: string }
      const hasServerCounts = !!d.ok && !!d.counts && Object.keys(d.counts).length > 0
      if (hasServerCounts) {
        setFrontendCounts(d.counts ?? {})
        setFrontendSource('server')
        return
      }

      const errMsg = autoData.message ?? d.message ?? '自動抓取失敗，請確認 URL 是否有效'
      setFrontendError(errMsg)
      setFrontendSource(null)
    } catch (e) {
      setFrontendSource(null)
      setFrontendError(e instanceof Error ? e.message : String(e))
    }
    finally { setFrontendLoading(false) }
  }


  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true)
    setOsmError(null)
    try {
      const resp = await fetch('/api/osm/sync', { method: 'POST' })
      const data = await resp.json() as { ok: boolean; channels?: OsmChannelResult[]; message?: string }
      if (!data.ok) throw new Error(data.message ?? '同步失敗')
      setChannelResults(data.channels ?? [])
      setNeverSynced(false)
    } catch (err) {
      setOsmError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncingAll(false)
    }
  }, [])

  const handleSyncOne = useCallback(async (name: string) => {
    setSyncingChannel(name)
    setOsmError(null)
    try {
      const resp = await fetch(`/api/osm/sync/${encodeURIComponent(name)}`, { method: 'POST' })
      const data = await resp.json() as { ok: boolean; channel?: OsmChannelResult; message?: string }
      if (!data.ok) throw new Error(data.message ?? `${name} 同步失敗`)
      if (data.channel) {
        setChannelResults(prev =>
          prev.some(c => c.name === data.channel!.name)
            ? prev.map(c => c.name === data.channel!.name ? data.channel! : c)
            : [...prev, data.channel!]
        )
        setNeverSynced(false)
      }
    } catch (err) {
      setOsmError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncingChannel(null)
    }
  }, [])

  // ─── Target versions ──────────────────────────────────────────────────────

  const fetchTargets = useCallback(async () => {
    try {
      const resp = await fetch('/api/osm/targets')
      const data = await resp.json() as { ok: boolean; targets?: Record<string, Record<string, string>> }
      if (data.ok && data.targets) setTargets(data.targets)
    } catch { /* silent */ }
  }, [])

  useEffect(() => { fetchTargets() }, [fetchTargets])


  const handleSyncFromLark = useCallback(async () => {
    if (!larkSheetUrl.trim()) return
    setLarkSyncing(true)
    setLarkSyncMsg(null)
    try {
      const resp = await fetch('/api/osm/sync-targets-from-lark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: larkSheetUrl.trim() }),
      })
      const data = await resp.json() as { ok: boolean; synced?: string[]; totalCount?: number; message?: string }
      if (!data.ok) throw new Error(data.message ?? '同步失敗')
setLarkSyncMsg({ ok: true, msg: `已同步 ${data.totalCount} 筆，涵蓋分頁：${(data.synced ?? []).join('、')}` })
      await fetchTargets()
    } catch (err) {
      setLarkSyncMsg({ ok: false, msg: err instanceof Error ? err.message : String(err) })
    } finally {
      setLarkSyncing(false)
    }
  }, [larkSheetUrl, fetchTargets])

  // All unique machineTypes seen across all channels
  const allMachineTypes = [...new Set(
    channelResults.flatMap(c => c.machines.map(m => m.machineType)).filter(Boolean)
  )].sort()

  // ─── OSM Version History fetch ────────────────────────────────────────────

  const handleFetchVersionHistory = useCallback(async () => {
    setVersionHistoryLoading(true)
    setVersionHistoryError(null)
    try {
      const resp = await fetch('/api/osm/version-history')
      const data = await resp.json() as {
        ok: boolean
        components?: OsmComponentVersion[]
        syncTime?: string
        message?: string
      }
      if (!data.ok) throw new Error(data.message ?? '取得失敗')
      setVersionHistory(data.components ?? [])
      setVersionHistorySyncTime(data.syncTime ?? null)
    } catch (err) {
      setVersionHistoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setVersionHistoryLoading(false)
    }
  }, [])

  // ─── LuckyLink Version History fetch ──────────────────────────────────────

  const handleFetchLlVersions = useCallback(async () => {
    setLlLoading(true)
    setLlError(null)
    try {
      const resp = await fetch('/api/luckylink/version-history')
      const data = await resp.json() as {
        ok: boolean
        components?: OsmComponentVersion[]
        syncTime?: string
        message?: string
      }
      if (!data.ok) throw new Error(data.message ?? '取得失敗')
      setLlVersions(data.components ?? [])
      setLlSyncTime(data.syncTime ?? null)
    } catch (err) {
      setLlError(err instanceof Error ? err.message : String(err))
    } finally {
      setLlLoading(false)
    }
  }, [])

  // ─── LuckyLink SAS/MML/G2S 版本統計 fetch ──────────────────────────────────

  const handleFetchLlProto = useCallback(async () => {
    setLlProtoLoading(true)
    setLlProtoError(null)
    try {
      const resp = await fetch('/api/luckylink/protocol-versions')
      const data = await resp.json() as {
        ok: boolean
        protocols?: LlProtocolVersions
        noData?: { count: number; offlineCount: number }
        syncTime?: string
        message?: string
      }
      if (!data.ok) throw new Error(data.message ?? '取得失敗')
      setLlProto(data.protocols ?? null)
      setLlProtoNoData(data.noData ?? null)
      setLlProtoSyncTime(data.syncTime ?? null)
    } catch (err) {
      setLlProtoError(err instanceof Error ? err.message : String(err))
    } finally {
      setLlProtoLoading(false)
    }
  }, [])

  const toggleLlProtoGame = useCallback((key: string) => {
    setLlProtoExpandedGames(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // 依遊戲名稱重新分組（原始資料是協定→遊戲，這裡轉成遊戲→協定，方便一張卡看到同款遊戲的 SAS/MML/G2S 分佈）
  const llGameGroups = useMemo<LlGameGroup[]>(() => {
    if (!llProto) return []
    const map = new Map<string, LlGameGroup>()
    for (const protoKey of ['SAS', 'MML', 'G2S'] as const) {
      const group = llProto[protoKey]
      for (const game of group.games) {
        let entry = map.get(game.name)
        if (!entry) {
          entry = { name: game.name, total: 0, online: 0, offline: 0, protocols: {} }
          map.set(game.name, entry)
        }
        entry.protocols[protoKey] = { ...game, targetVersion: group.targetVersion }
        entry.total += game.machines.length
        entry.online += game.online
        entry.offline += game.offline
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  }, [llProto])

  // ─── Toppath Version History fetch ────────────────────────────────────────

  const handleFetchTpVersions = useCallback(async () => {
    setTpLoading(true)
    setTpError(null)
    try {
      const resp = await fetch('/api/toppath/version-history')
      const data = await resp.json() as {
        ok: boolean
        components?: OsmComponentVersion[]
        syncTime?: string
        message?: string
      }
      if (!data.ok) throw new Error(data.message ?? '取得失敗')
      setTpVersions(data.components ?? [])
      setTpSyncTime(data.syncTime ?? null)
    } catch (err) {
      setTpError(err instanceof Error ? err.message : String(err))
    } finally {
      setTpLoading(false)
    }
  }, [])

  // ─── ImageRecon fetch ──────────────────────────────────────────────────────

  const handleFetchReport = useCallback(async () => {
    setReportLoading(true)
    setReportError(null)
    try {
      const resp = await fetch('/api/integrations/gmail/latest-report', { method: 'POST' })
      const data = await resp.json() as {
        ok: boolean
        message?: string
        targetVersion?: string
        generated?: string
        summary?: ReportSummary
        records?: VersionRecord[]
      }
      if (!data.ok) throw new Error(data.message ?? '取得失敗')
      if (!data.records || data.records.length === 0) throw new Error('資料已取得，但未找到符合格式的版本記錄')
      setRecords(data.records)
      setSummary(data.summary ?? null)
      setTargetVersion(data.targetVersion ?? null)
      setGenerated(data.generated ?? null)
    } catch (err) {
      setReportError(err instanceof Error ? err.message : String(err))
    } finally {
      setReportLoading(false)
    }
  }, [])

  // ─── Alert ────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/osm/alert/config')
      .then(r => r.json())
      .then((d: { ok: boolean; config?: { enabled?: boolean; schedule?: string; webhookUrl?: string } }) => {
        if (d.ok && d.config) {
          setAlertEnabled(!!d.config.enabled)
          if (d.config.schedule) setAlertSchedule(d.config.schedule)
          if (d.config.webhookUrl) setAlertWebhookUrl(d.config.webhookUrl)
        }
      })
      .catch(() => {})
  }, [])


  const handleSendAlert = useCallback(async () => {
    setAlertSending(true)
    setAlertMsg(null)
    try {
      const resp = await fetch('/api/osm/alert', { method: 'POST' })
      const data = await resp.json() as { ok: boolean; hasIssues?: boolean; message?: string }
      if (!data.ok) throw new Error(data.message ?? '發送失敗')
      setAlertMsg({ ok: true, msg: data.hasIssues ? '告警已發送（有不達標項目）' : '已發送（目前全部達標）' })
    } catch (err) {
      setAlertMsg({ ok: false, msg: err instanceof Error ? err.message : String(err) })
    } finally {
      setAlertSending(false)
    }
  }, [])

  // ─── Fetch all sections at once ───────────────────────────────────────────

  const [fetchAllLoading, setFetchAllLoading] = useState(false)

  const handleFetchAll = useCallback(async () => {
    setFetchAllLoading(true)
    await Promise.allSettled([
      handleSyncAll(),
      handleFetchVersionHistory(),
      handleFetchLlVersions(),
      handleFetchLlProto(),
      handleFetchTpVersions(),
      handleFetchReport(),
    ])
    setFetchAllLoading(false)
  }, [handleSyncAll, handleFetchVersionHistory, handleFetchLlVersions, handleFetchLlProto, handleFetchTpVersions, handleFetchReport])

  const handleSaveAlertConfig = useCallback(async () => {
    setAlertConfigSaving(true)
    try {
      const resp = await fetch('/api/osm/alert/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: alertEnabled, schedule: alertSchedule, webhookUrl: alertWebhookUrl }),
      })
      const data = await resp.json() as { ok: boolean; message?: string }
      if (!data.ok) throw new Error(data.message ?? '儲存失敗')
      setAlertMsg({ ok: true, msg: '告警設定已儲存' })
    } catch (err) {
      setAlertMsg({ ok: false, msg: err instanceof Error ? err.message : String(err) })
    } finally {
      setAlertConfigSaving(false)
    }
  }, [alertEnabled, alertSchedule, alertWebhookUrl])

  // ─── Stats ────────────────────────────────────────────────────────────────

  const totalMachines = channelResults.reduce((s, c) => s + c.machines.length, 0)
  const errorChannels = channelResults.filter(c => !!c.error).length
  const allMachinesFlat = channelResults.flatMap(c => c.machines)
  const globalConn = countOnlineStates(allMachinesFlat)
  const gameTypeCounts: { type: string; count: number }[] = Object.entries(
    allMachinesFlat.filter(isOnline).reduce<Record<string, number>>((acc, m) => {
      const t = gameTypeOf(m)
      acc[t] = (acc[t] ?? 0) + 1
      return acc
    }, {})
  ).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)

  return (
    <div className="osm-page">

      {/* ─── Lark 同步 & 告警設定 ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">目標版本 & 告警設定</h2>
            <p className="osm-section-sub">從 Lark Sheet 同步目標版本，手動或定時發送告警到 Lark 群組機器人</p>
          </div>
          <button
            className="osm-btn osm-btn--sm osm-btn--ghost"
            onClick={() => setTargetsExpanded(v => !v)}
          >{targetsExpanded ? '▲ 收起' : '▼ 展開'}</button>
        </div>

        {/* Main action row */}
        <div className="osm-lark-sync-row">
          <input
            className="osm-lark-url-input"
            type="text"
            value={larkSheetUrl}
            readOnly
          />
          <button
            className="osm-btn osm-btn--primary"
            onClick={handleSyncFromLark}
            disabled={larkSyncing || !larkSheetUrl.trim()}
          >{larkSyncing ? '同步中…' : '從 Lark 同步'}</button>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleSendAlert}
            disabled={alertSending}
          >{alertSending ? '發送中…' : '發送告警'}</button>
          <button
            type="button"
            className="osm-btn osm-btn--sm osm-btn--ghost"
            onClick={() => setAlertConfigExpanded(v => !v)}
          >{alertConfigExpanded ? '收起排程' : '排程設定'}</button>
        </div>

        {/* Feedback messages */}
        {larkSyncMsg && (
          <div className={`osm-alert ${larkSyncMsg.ok ? 'osm-alert--ok' : 'osm-alert--error'}`}>
            {larkSyncMsg.msg}
          </div>
        )}
        {alertMsg && (
          <div className={`osm-alert-msg ${alertMsg.ok ? 'osm-alert-msg--ok' : 'osm-alert-msg--error'}`}>
            {alertMsg.msg}
          </div>
        )}

        {/* Alert schedule config */}
        {alertConfigExpanded && (
          <div className="osm-alert-config">
            <div className="osm-alert-config-row">
              <label className="osm-alert-config-label">
                <input
                  type="checkbox"
                  checked={alertEnabled}
                  onChange={e => setAlertEnabled(e.target.checked)}
                />
                <span>啟用定時告警</span>
              </label>
            </div>
            <div className="osm-alert-config-row">
              <label className="osm-alert-config-label">Lark Webhook URL</label>
              <input
                className="osm-lark-url-input"
                type="text"
                placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/..."
                value={alertWebhookUrl}
                onChange={e => setAlertWebhookUrl(e.target.value)}
              />
            </div>
            <div className="osm-alert-config-row">
              <label className="osm-alert-config-label">Cron 排程</label>
              <input
                className="osm-lark-url-input"
                type="text"
                placeholder="例如：0 9 * * *（每天早上 9 點）"
                value={alertSchedule}
                onChange={e => setAlertSchedule(e.target.value)}
                disabled={!alertEnabled}
              />
            </div>
            <div className="osm-alert-config-row">
              <span className="osm-alert-cron-hint">
                常用：<code>0 9 * * *</code>（每天 09:00）、<code>0 9 * * 1-5</code>（週一至五 09:00）
              </span>
            </div>
            <div className="osm-alert-config-row">
              <button
                type="button"
                className="osm-btn osm-btn--primary"
                onClick={handleSaveAlertConfig}
                disabled={alertConfigSaving}
              >
                {alertConfigSaving ? '儲存中…' : '儲存設定'}
              </button>
            </div>
          </div>
        )}

        {/* Targets grid */}
        {targetsExpanded && Object.keys(targets).length > 0 && (
          <div className="osm-targets-grid">
            {[...new Set([...Object.keys(targets), ...allMachineTypes])].sort().map(mt => {
              const catTargets = targets[mt] ?? {}
              const totalOfType = channelResults.flatMap(c => c.machines).filter(m => m.machineType === mt).length
              const mainTarget = catTargets['MachineType']
              const onTarget = mainTarget ? channelResults.flatMap(c => c.machines).filter(m => m.machineType === mt && m.version === mainTarget).length : 0
              return (
                <div key={mt} className="osm-target-row">
                  <span className="osm-type-badge">{mt}</span>
                  {totalOfType > 0 && <span className="osm-type-count">{totalOfType} 台</span>}
                  {mainTarget && (
                    <span className={`osm-badge ${onTarget === totalOfType && totalOfType > 0 ? 'osm-badge--ok' : 'osm-badge--warn'}`}>
                      {onTarget}/{totalOfType} 達標
                    </span>
                  )}
                  {CATEGORIES.map(cat => catTargets[cat] ? (
                    <span key={cat} className="osm-type-cat-ver">
                      <span className="osm-type-cat-label">{cat}</span>
                      <span className="osm-type-cat-val">{catTargets[cat]}</span>
                    </span>
                  ) : null)}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ─── 一鍵全部取得 + 未達標 Dashboard ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">版本達標總覽</h2>
            <p className="osm-section-sub">一次取得所有版本資料，列出所有未達標的元件與機台</p>
          </div>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleFetchAll}
            disabled={fetchAllLoading || syncingAll || versionHistoryLoading || llLoading || llProtoLoading || tpLoading || reportLoading}
          >
            {fetchAllLoading ? '取得中…' : '一鍵全部取得'}
          </button>
        </div>

        <VersionDashboard
          channelResults={channelResults}
          targets={targets}
          versionHistory={versionHistory}
          llVersions={llVersions}
          tpVersions={tpVersions}
          imageReconRecords={records}
          imageReconTargetVersion={targetVersion}
          llProto={llProto}
        />
      </section>

      {/* ─── OSM 機台版本 ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">機台版本 Dashboard</h2>
            <p className="osm-section-sub">從各渠道 OSM 後台即時取得機台版本資訊</p>
          </div>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleSyncAll}
            disabled={syncingAll}
          >
            {syncingAll ? '同步中…' : '全部同步'}
          </button>
        </div>

        {osmError && (
          <div className="osm-alert osm-alert--error">{osmError}</div>
        )}

        {!neverSynced && channelResults.length > 0 && (
          <div className="osm-stat-row">
            <div className="stat-chip">
              <span className="stat-chip-val">{channelResults.length}</span>
              <span className="stat-chip-lbl">渠道數</span>
            </div>
            <div className="stat-chip">
              <span className="stat-chip-val">{totalMachines}</span>
              <span className="stat-chip-lbl">機台總數</span>
            </div>
            <div className="stat-chip stat-chip--online">
              <span className="stat-chip-val">{globalConn.online}</span>
              <span className="stat-chip-lbl">Online</span>
            </div>
            <div className="stat-chip stat-chip--offline">
              <span className="stat-chip-val">{globalConn.offline}</span>
              <span className="stat-chip-lbl">Offline</span>
            </div>
            {globalConn.unknown > 0 && (
              <div className="stat-chip">
                <span className="stat-chip-val">{globalConn.unknown}</span>
                <span className="stat-chip-lbl">連線未知</span>
              </div>
            )}
            {errorChannels > 0 && (
              <div className="stat-chip stat-chip--warn">
                <span className="stat-chip-val">{errorChannels}</span>
                <span className="stat-chip-lbl">同步失敗</span>
              </div>
            )}
          </div>
        )}

        {!neverSynced && gameTypeCounts.length > 0 && (() => {
          const maxCount = gameTypeCounts[0]?.count ?? 1
          const hasFrontend = Object.keys(frontendCounts).length > 0
          return (
            <>
              {/* Frontend URL input */}
              <div style={{ display: 'flex', gap: 8, margin: '20px 0 4px', alignItems: 'center' }}>
                <input
                  value={frontendUrl} onChange={e => setFrontendUrl(e.target.value)}
                  placeholder="貼上前端大廳 URL（含 token，不需要 gameid）"
                  style={{ flex: 1, padding: '5px 10px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 12 }}
                  onKeyDown={e => e.key === 'Enter' && handleFetchFrontend()}
                />
                <button
                  onClick={handleFetchFrontend} disabled={frontendLoading || !frontendUrl.trim()}
                  className="osm-btn osm-btn--primary" style={{ fontSize: 12, padding: '5px 14px', whiteSpace: 'nowrap' }}
                >{frontendLoading ? '取得中...' : '取得前端機台數'}</button>
              </div>
              {frontendError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 4 }}>失敗 {frontendError}</div>}
              {!frontendError && frontendSource && (
                <div style={{ color: '#475569', fontSize: 12, marginBottom: 4 }}>通過 已取得前端機台數</div>
              )}
              {/* Game type grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
                {gameTypeCounts.map(({ type, count }) => {
                  const pct = Math.round((count / maxCount) * 100)
                  const fCount = frontendCounts[type]
                  const diff = hasFrontend ? (fCount ?? 0) - count : null
                  const diffColor = diff === null ? '#d1d5db' : diff === 0 ? '#16a34a' : '#dc2626'
                  // Missing gmids: backend online machines of this type not found in frontend gmids
                  const hasMissing = diff !== null && diff < 0 && frontendGmids.size > 0
                  const missingMachines = hasMissing
                    ? allMachinesFlat.filter(m => isOnline(m) && m.machineName.split('-')[1]?.toLowerCase() === type && !frontendGmids.has(m.machineName.toLowerCase()))
                    : []
                  const isExpanded = expandedDiffTypes.has(type)
                  const toggleExpand = () => setExpandedDiffTypes(prev => {
                    const next = new Set(prev)
                    if (next.has(type)) next.delete(type); else next.add(type)
                    return next
                  })
                  return (
                    <div key={type} className="osm-gt-card" onClick={() => setDistType(type)} title="看這個機種分布在哪些渠道" style={{ background: '#162032', border: `1px solid ${hasMissing ? '#fca5a5' : '#334155'}`, borderRadius: 8, padding: '7px 10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#93c5fd' }}>{type}</span>
                        {diff !== null && diff !== 0 && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: diffColor }}>
                            {diff > 0 ? `+${diff}` : diff}
                          </span>
                        )}
                        {diff === 0 && <span style={{ fontSize: 10, color: '#4ade80' }}>通過</span>}
                      </div>
                      <div style={{ height: 4, background: '#334155', borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: '#3b82f6', borderRadius: 2 }} />
                      </div>
                      <div style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                        <span>OSM <b style={{ color: '#f1f5f9' }}>{count}</b></span>
                        <span style={{ color: diffColor }}>
                          前端 <b>{hasFrontend ? (fCount ?? <span style={{ color: '#64748b' }}>—</span>) : <span style={{ color: '#64748b' }}>—</span>}</b>
                        </span>
                      </div>
                      {hasMissing && missingMachines.length > 0 && (
                        <div style={{ marginTop: 5, borderTop: '1px solid #f87171' }}>
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); toggleExpand() }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#f87171', padding: '3px 0', width: '100%', textAlign: 'left', fontWeight: 600 }}
                          >
                            {isExpanded ? '▲' : '▼'} 缺少 {missingMachines.length} 台
                          </button>
                          {isExpanded && (
                            <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 2 }}>
                              {missingMachines.map(m => (
                                <div key={m.id} style={{ fontSize: 10, fontFamily: 'monospace', color: '#fca5a5', lineHeight: 1.6 }}>{m.machineName}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )
        })()}

        {neverSynced ? (
          <div className="osm-empty">
            <p>尚未同步。按「全部同步」取得各渠道機台版本。</p>
          </div>
        ) : (
          <div className="osm-master-detail" style={{ marginTop: 24 }}>
            <div className="osm-channel-list">
              {channelResults.map(result => (
                <ChannelRow
                  key={result.name}
                  result={result}
                  selected={selectedChannel === result.name}
                  onSelect={() => setSelectedChannel(prev => prev === result.name ? null : result.name)}
                  onSync={handleSyncOne}
                  loading={syncingChannel === result.name || syncingAll}
                  targets={targets}
                />
              ))}
            </div>
            {selectedChannel && (() => {
              const sel = channelResults.find(c => c.name === selectedChannel)
              return sel ? (
                <ChannelDetailPanel result={sel} targets={targets} />
              ) : null
            })()}
            {!selectedChannel && (
              <div className="osm-detail-placeholder">
                <span>← 點選左側渠道查看機台詳情</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ─── Divider ─── */}
      <hr className="osm-divider" />

      {/* ─── OSM 元件版本 ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">OSM 元件版本</h2>
            <p className="osm-section-sub">從 OSM 後台取得各元件目前版本，與 Lark Sheet OSM 目標版本比對</p>
          </div>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleFetchVersionHistory}
            disabled={versionHistoryLoading}
          >
            {versionHistoryLoading ? '取得中…' : '取得元件版本'}
          </button>
        </div>

        {versionHistoryError && (
          <div className="osm-alert osm-alert--error">{versionHistoryError}</div>
        )}

        {versionHistory.length > 0 && (
          <>
            {versionHistorySyncTime && (
              <p className="osm-report-time">取得時間：{versionHistorySyncTime}</p>
            )}
            <div className="osm-comp-ver-grid">
              {versionHistory.map(comp => {
                // targets structure: { [machineType]: { [category]: version } }
                // comp.name is the machineType key; category is 'OSM'
                const target = targets[comp.name]?.['OSM']
                const onTarget = target ? comp.version === target : null
                return (
                  <div key={comp.name} className={`osm-comp-ver-card${onTarget === false ? ' osm-comp-ver-card--warn' : onTarget === true ? ' osm-comp-ver-card--ok' : ''}`}>
                    <div className="osm-comp-ver-name">{comp.name}</div>
                    <div className="osm-comp-ver-version">{comp.version || '—'}</div>
                    {target && (
                      <div className="osm-comp-ver-target">目標 {target}</div>
                    )}
                    <div className="osm-comp-ver-status">
                      {onTarget === null ? (
                        <span className="osm-badge osm-badge--muted">未設定目標</span>
                      ) : onTarget ? (
                        <span className="osm-badge osm-badge--ok">通過 達標</span>
                      ) : (
                        <span className="osm-badge osm-badge--warn">未達標</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {!versionHistoryLoading && versionHistory.length === 0 && !versionHistoryError && (
          <div className="osm-empty">
            <p>尚未取得資料。按「取得元件版本」從 OSM 拉取各元件版本。</p>
          </div>
        )}
      </section>

      {/* ─── Divider ─── */}
      <hr className="osm-divider" />

      {/* ─── LuckyLink 元件版本 ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">LuckyLink 元件版本</h2>
            <p className="osm-section-sub">從 LuckyLink 後台取得各元件目前版本，與 Lark Sheet LuckyLink 目標版本比對</p>
          </div>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleFetchLlVersions}
            disabled={llLoading}
          >
            {llLoading ? '取得中…' : '取得元件版本'}
          </button>
        </div>

        {llError && (
          <div className="osm-alert osm-alert--error">{llError}</div>
        )}

        {llVersions.length > 0 && (
          <>
            {llSyncTime && (
              <p className="osm-report-time">取得時間：{llSyncTime}</p>
            )}
            <div className="osm-comp-ver-grid">
              {llVersions.map(comp => {
                const target = targets[comp.name]?.['LuckyLink']
                const onTarget = comp.pending ? null : target ? comp.version === target : null
                return (
                  <div key={comp.name} className={`osm-comp-ver-card${onTarget === false ? ' osm-comp-ver-card--warn' : onTarget === true ? ' osm-comp-ver-card--ok' : ''}`}>
                    <div className="osm-comp-ver-name">{comp.name}</div>
                    <div className="osm-comp-ver-version">{comp.pending ? '待 API 支援' : comp.version || '—'}</div>
                    {target && !comp.pending && (
                      <div className="osm-comp-ver-target">目標 {target}</div>
                    )}
                    <div className="osm-comp-ver-status">
                      {comp.pending ? (
                        <span className="osm-badge osm-badge--muted">開發中</span>
                      ) : onTarget === null ? (
                        <span className="osm-badge osm-badge--muted">未設定目標</span>
                      ) : onTarget ? (
                        <span className="osm-badge osm-badge--ok">通過 達標</span>
                      ) : (
                        <span className="osm-badge osm-badge--warn">未達標</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {!llLoading && llVersions.length === 0 && !llError && (
          <div className="osm-empty">
            <p>尚未取得資料。按「取得元件版本」從 LuckyLink 拉取各元件版本。</p>
          </div>
        )}
      </section>

      {/* ─── Divider ─── */}
      <hr className="osm-divider" />

      {/* ─── LuckyLink SAS/MML/G2S 版本 ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">LuckyLink SAS/MML/G2S 版本</h2>
            <p className="osm-section-sub">依遊戲分組，展開查看各協定機台版本，與 Lark Sheet LuckyLink 目標版本比對</p>
          </div>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleFetchLlProto}
            disabled={llProtoLoading}
          >
            {llProtoLoading ? '取得中…' : '取得 SAS/MML/G2S 版本'}
          </button>
        </div>

        {llProtoError && (
          <div className="osm-alert osm-alert--error">{llProtoError}</div>
        )}

        {llProto && (
          <>
            {llProtoSyncTime && (
              <p className="osm-report-time">取得時間：{llProtoSyncTime}</p>
            )}
            {llGameGroups.length === 0 ? (
              <div className="osm-empty"><p>無機台資料</p></div>
            ) : (
              <div className="osm-machine-groups-scroll">
                {llGameGroups.map(gg => (
                  <div key={gg.name} className="osm-machine-group-col">
                    <div className="osm-type-group-header">
                      <span className="osm-type-badge">{gg.name}</span>
                      <span className="osm-type-count">{gg.total} 台</span>
                      <span className="osm-channel-row-conn">
                        <span className="osm-badge osm-badge--online">{gg.online}</span>
                        <span className="osm-badge osm-badge--offline">{gg.offline}</span>
                      </span>
                    </div>

                    {(['SAS', 'MML', 'G2S'] as const).map(protoKey => {
                      const game = gg.protocols[protoKey]
                      if (!game) return null
                      const hasTarget = !!game.targetVersion
                      const allOnTarget = hasTarget && game.onTargetCount === game.machines.length
                      const gameKey = `${gg.name}:${protoKey}`
                      const expanded = llProtoExpandedGames.has(gameKey)
                      return (
                        <div key={protoKey}>
                          <button
                            type="button"
                            className="osm-proto-row"
                            onClick={() => toggleLlProtoGame(gameKey)}
                          >
                            <span>{expanded ? '▾' : '▸'}</span>
                            <span className="osm-type-badge">{protoKey}</span>
                            <span className="osm-card-count">{game.machines.length} 台</span>
                            <span className="osm-channel-row-conn">
                              <span className="osm-badge osm-badge--online">{game.online}</span>
                              <span className="osm-badge osm-badge--offline">{game.offline}</span>
                            </span>
                            {hasTarget ? (
                              <span className={`osm-badge ${allOnTarget ? 'osm-badge--ok' : 'osm-badge--warn'}`}>
                                {game.onTargetCount}/{game.machines.length} 達標
                              </span>
                            ) : (
                              <span className="osm-badge osm-badge--muted">未設定目標</span>
                            )}
                            <span style={{ flex: 1 }} />
                            {game.targetVersion && (
                              <span className="osm-type-cat-ver">
                                <span className="osm-type-cat-label">目標</span>
                                <span className="osm-type-cat-val">{game.targetVersion}</span>
                              </span>
                            )}
                          </button>
                          {expanded && (
                            <div className="osm-proto-table-region">
                              <table className="osm-machine-table">
                                <thead>
                                  <tr>
                                    <th>GMID</th>
                                    <th>版本</th>
                                    <th>連線</th>
                                    <th>達標</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {game.machines.map(m => (
                                    <tr key={m.gmid} className={!m.isactive ? 'osm-machine-row--offline' : ''}>
                                      <td>{m.gmid}</td>
                                      <td>
                                        <span className={`osm-version-tag${m.onTarget === false ? ' osm-version-tag--diff' : ''}`}>
                                          {m.clientversion}
                                        </span>
                                      </td>
                                      <td>
                                        {m.isactive ? (
                                          <span className="osm-badge osm-badge--online">Online</span>
                                        ) : (
                                          <span className="osm-badge osm-badge--offline">Offline</span>
                                        )}
                                      </td>
                                      <td>
                                        {m.onTarget === null ? (
                                          <span className="osm-badge osm-badge--muted">—</span>
                                        ) : m.onTarget ? (
                                          <span className="osm-badge osm-badge--ok">達標</span>
                                        ) : (
                                          <span className="osm-badge osm-badge--warn">未達標</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}

            {llProtoNoData && llProtoNoData.count > 0 && (
              <p className="osm-report-time" style={{ marginTop: 12 }}>
                <span className="osm-badge osm-badge--muted">無資料</span>
                {' '}（sasversion 為空）：{llProtoNoData.count} 台，其中離線 {llProtoNoData.offlineCount} 台
              </p>
            )}
          </>
        )}

        {!llProtoLoading && !llProto && !llProtoError && (
          <div className="osm-empty">
            <p>尚未取得資料。按「取得 SAS/MML/G2S 版本」從 LuckyLink 拉取全部機台並依協定分類。</p>
          </div>
        )}
      </section>

      {/* ─── Divider ─── */}
      <hr className="osm-divider" />

      {/* ─── Toppath 元件版本 ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">Toppath 元件版本</h2>
            <p className="osm-section-sub">從靜態 JSON 取得 GM / API / GW / TG-API 目前版本，與 Lark Sheet Toppath 目標版本比對</p>
          </div>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleFetchTpVersions}
            disabled={tpLoading}
          >
            {tpLoading ? '取得中…' : '取得元件版本'}
          </button>
        </div>

        {tpError && (
          <div className="osm-alert osm-alert--error">{tpError}</div>
        )}

        {tpVersions.length > 0 && (
          <>
            {tpSyncTime && (
              <p className="osm-report-time">取得時間：{tpSyncTime}</p>
            )}
            <div className="osm-comp-ver-grid">
              {tpVersions.map(comp => {
                const target = targets[comp.name]?.['Toppath']
                const onTarget = target ? comp.version === target : null
                return (
                  <div key={comp.name} className={`osm-comp-ver-card${onTarget === false ? ' osm-comp-ver-card--warn' : onTarget === true ? ' osm-comp-ver-card--ok' : ''}`}>
                    <div className="osm-comp-ver-name">{comp.name}</div>
                    <div className="osm-comp-ver-version">{comp.version || '—'}</div>
                    {target && (
                      <div className="osm-comp-ver-target">目標 {target}</div>
                    )}
                    <div className="osm-comp-ver-status">
                      {onTarget === null ? (
                        <span className="osm-badge osm-badge--muted">未設定目標</span>
                      ) : onTarget ? (
                        <span className="osm-badge osm-badge--ok">通過 達標</span>
                      ) : (
                        <span className="osm-badge osm-badge--warn">未達標</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {!tpLoading && tpVersions.length === 0 && !tpError && (
          <div className="osm-empty">
            <p>尚未取得資料。按「取得元件版本」從 Toppath 靜態接口拉取各元件版本。</p>
          </div>
        )}
      </section>

      {/* ─── Divider ─── */}
      <hr className="osm-divider" />

      {/* ─── Section 2: ImageRecon Server 版本 ─── */}
      <section className="osm-section">
        <div className="osm-section-header">
          <div>
            <h2 className="osm-section-title">ImageRecon Server 版本</h2>
            <p className="osm-section-sub">從 ImageRecon API 取得各伺服器/服務版本，以 Lark Sheet ImageRecon 目標版本比對</p>
          </div>
          <button
            type="button"
            className="osm-btn osm-btn--primary"
            onClick={handleFetchReport}
            disabled={reportLoading}
          >
            {reportLoading ? '取得中…' : '取得最新版本'}
          </button>
        </div>

        {reportError && (
          <div className="osm-alert osm-alert--error">{reportError}</div>
        )}

        {summary && (() => {
          // Lark target takes priority; fall back to Gmail-parsed target
          const larkTarget = targets['ImageRecon']?.['ImageRecon'] ?? null
          const effectiveTarget = larkTarget ?? targetVersion
          const onTargetCount = records.filter(r => r.currentVersion === effectiveTarget).length
          return (
            <div className="osm-stat-row">
              {effectiveTarget && (
                <div className="stat-chip stat-chip--blue">
                  <span className="stat-chip-val">{effectiveTarget}</span>
                  <span className="stat-chip-lbl">目標版本{larkTarget ? '（Lark）' : '（API）'}</span>
                </div>
              )}
              <div className="stat-chip">
                <span className="stat-chip-val">{summary.totalServers}</span>
                <span className="stat-chip-lbl">伺服器數</span>
              </div>
              {effectiveTarget && (
                <div className={`stat-chip ${onTargetCount === summary.totalServers ? 'stat-chip--ok' : 'stat-chip--warn'}`}>
                  <span className="stat-chip-val">{onTargetCount}/{summary.totalServers}</span>
                  <span className="stat-chip-lbl">達標</span>
                </div>
              )}
              {generated && (
                <span className="osm-report-time">產生時間：{generated}</span>
              )}
            </div>
          )
        })()}

        {records.length > 0 && (
          <div className="osm-table-wrap">
            <table className="osm-report-table">
              <thead>
                <tr>
                  <th>伺服器</th>
                  <th>IP</th>
                  <th>目標版本</th>
                  <th>實際版本</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => {
                  const larkTarget = targets['ImageRecon']?.['ImageRecon'] ?? null
                  const effectiveTarget = larkTarget ?? r.targetVersion
                  const match = !effectiveTarget || r.currentVersion === effectiveTarget
                  return (
                    <tr key={i}>
                      <td>{r.serverName}</td>
                      <td className="osm-td-mono">{r.ip || '—'}</td>
                      <td className="osm-td-mono">{effectiveTarget || '—'}</td>
                      <td className={`osm-td-mono${!match ? ' osm-td--warn' : ''}`}>
                        {r.currentVersion}
                      </td>
                      <td>
                        <span className={`osm-badge${match ? ' osm-badge--ok' : ' osm-badge--warn'}`}>
                          {imageReconStatusLabel(match)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!reportLoading && records.length === 0 && !reportError && (
          <div className="osm-empty">
            <p>尚未取得版本。按「取得最新版本」從 ImageRecon API 取得版本資訊。</p>
          </div>
        )}
      </section>

      {distType && (
        <GameTypeChannelsModal
          type={distType}
          channelResults={channelResults}
          onClose={() => setDistType(null)}
        />
      )}

    </div>
  )
}

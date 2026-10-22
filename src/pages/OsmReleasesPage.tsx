/**
 * OSM 版本更新紀錄（docs/features/33-osm-releases.md；版面照 CodeX 2026-10-22 文字設計稿）。
 * 工具就是主檔，Lark 表只在第一次匯入歷史資料時讀。
 *
 * - 時間軸（月份分組＋右側詳情）／矩陣（元件群組可收合）兩種檢視
 * - 新增／編輯在寬側欄，元件逐列三態：有更新（必填版號）／未異動（表上的 x）／未提供（表上的空白）
 * - 欄位規則跟後端共用 shared/osm-release-rules.ts，畫面擋的跟送出驗的是同一份
 * - 權限三層由後端 /meta 回傳；畫面只是跟著藏按鈕，真正的檢查在後端
 * - 編輯衝突（別人先存了）後端回 409，畫面提示，不覆蓋
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { validateRelease, extractTickets, type ComponentState, type ReleaseInput } from '../../shared/osm-release-rules'
import './OsmReleasesPage.css'

type Tab = { id: string; name: string; sort: number; showComponents: boolean; showSql: boolean; showResult: boolean; active: boolean }
type Comp = { id: number; tabId: string; name: string; groupName: string; sort: number; active: boolean; usage: number }
type Status = { id: number; name: string; tone: string; sort: number; active: boolean; usage: number }
type Value = { componentId: number; state: ComponentState; version: string }
type Release = {
  id: number; tabId: string; statusId: number | null; testDate: string; releaseDate: string
  content: string; sqlText: string; resultText: string; source: string
  createdBy: string; createdAt: number; updatedBy: string; updatedAt: number; rev: number; values: Value[]
}
type Perms = { view: boolean; edit: boolean; manage: boolean }
type Meta = { tabs: Tab[]; components: Comp[]; statuses: Status[]; counts: Record<string, number>; lastUpdated: { at: number; by: string } | null; perms: Perms }
type Filters = { tabId: string; search: string; from: string; to: string; statusIds: number[]; componentIds: number[]; mode: 'timeline' | 'matrix' }
type View = { id: number; name: string; filters: Partial<Filters> }
type Revision = { rev: number; action: string; actor: string; at: number; snapshot: Release | null }
type Live = { name: string; version: string; at: string; error?: string }

type ApiResult<T> = T & { ok: boolean; message?: string; errors?: Record<string, string>; code?: string; current?: Release }

async function api<T>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  return r.json().catch(() => ({ ok: false, message: `伺服器回 ${r.status}` }))
}

const STATE_LABEL: Record<ComponentState, string> = { updated: '有更新', unchanged: '未異動', na: '未提供' }
const TONES = [['test', '測試'], ['maint', '維護'], ['hot', '熱更'], ['other', '其他']] as const
const ACTION_LABEL: Record<string, string> = { create: '新增', update: '修改', delete: '刪除', import: '從 Lark 匯入' }

const keyDate = (r: Release) => r.releaseDate || r.testDate
const md = (d: string) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}` : '')
const ymd = (d: string) => d.replace(/-/g, '/')
const fmtTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const groupOf = (c: Comp) => c.groupName || '元件'
const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean) ?? ''

/** 把文字裡的單號標出來（只標示、不連結；使用者 1022 決定單號只顯示文字可搜尋） */
function WithTickets({ text }: { text: string }) {
  const parts = text.split(/(\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b)/g)
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} className="orl-tk">{p}</span> : <Fragment key={i}>{p}</Fragment>))}</>
}

function StatusChip({ status, short }: { status?: Status; short?: boolean }) {
  if (!status) return <span className="orl-status orl-status--none">未填狀態</span>
  const label = short ? status.name.replace(/上正式$/, '') : status.name
  return <span className={`orl-status orl-status--${status.tone}`}>{label}</span>
}

const emptyFilters = (tabId: string): Filters => ({ tabId, search: '', from: '', to: '', statusIds: [], componentIds: [], mode: 'timeline' })

export function OsmReleasesPage() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [loadError, setLoadError] = useState('')
  const [releases, setReleases] = useState<Release[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [filters, setFilters] = useState<Filters>(emptyFilters(''))
  const [compPickerOpen, setCompPickerOpen] = useState(false)
  const [views, setViews] = useState<View[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editor, setEditor] = useState<{ release: Release | null } | null>(null)
  const [revisionsOf, setRevisionsOf] = useState<Release | null>(null)
  const [screen, setScreen] = useState<'list' | 'settings'>('list')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [live, setLive] = useState<{ live: Live[]; fetchedAt: number; env: string } | null>(null)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null)

  const loadMeta = async () => {
    const j = await api<Meta>('GET', '/api/osm-releases/meta')
    if (!j.ok) { setLoadError(j.message ?? '讀取失敗'); return null }
    setMeta(j)
    return j
  }
  const loadList = async (tabId: string) => {
    if (!tabId) { setReleases([]); return }
    setListLoading(true)
    const j = await api<{ releases: Release[] }>('GET', `/api/osm-releases/list?tab=${encodeURIComponent(tabId)}`)
    setListLoading(false)
    if (j.ok) setReleases(j.releases)
    else setFlash({ ok: false, text: j.message ?? '讀取紀錄失敗' })
  }

  useEffect(() => {
    void (async () => {
      const m = await loadMeta()
      if (!m) return
      const first = m.tabs.find(t => t.active) ?? m.tabs[0]
      if (first) setFilters(emptyFilters(first.id))
      const v = await api<{ views: View[] }>('GET', '/api/osm-releases/views')
      if (v.ok) setViews(v.views)
    })()
  }, [])

  useEffect(() => { void loadList(filters.tabId); setSelectedId(null) }, [filters.tabId])

  useEffect(() => {
    setLive(null)
    if (filters.tabId !== 'toppath') return
    void api<{ live: Live[]; fetchedAt: number; env: string }>('GET', '/api/osm-releases/live?tab=toppath').then(j => { if (j.ok) setLive(j) })
  }, [filters.tabId])

  useEffect(() => { if (flash?.ok) { const t = setTimeout(() => setFlash(null), 3500); return () => clearTimeout(t) } }, [flash])

  const tab = meta?.tabs.find(t => t.id === filters.tabId)
  const tabComps = useMemo(() => (meta?.components ?? []).filter(c => c.tabId === filters.tabId), [meta, filters.tabId])
  const statusById = useMemo(() => new Map((meta?.statuses ?? []).map(s => [s.id, s])), [meta])
  const compById = useMemo(() => new Map((meta?.components ?? []).map(c => [c.id, c])), [meta])

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase()
    return releases.filter(r => {
      const d = keyDate(r).slice(0, 7)
      if (filters.from && d < filters.from) return false
      if (filters.to && d > filters.to) return false
      if (filters.statusIds.length && (r.statusId == null || !filters.statusIds.includes(r.statusId))) return false
      if (filters.componentIds.length && !r.values.some(v => v.state === 'updated' && filters.componentIds.includes(v.componentId))) return false
      if (q) {
        const hay = [r.content, r.sqlText, r.resultText, ...r.values.filter(v => v.state === 'updated').map(v => `${compById.get(v.componentId)?.name ?? ''} ${v.version}`)].join('\n').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [releases, filters, compById])

  const selected = filtered.find(r => r.id === selectedId) ?? filtered[0] ?? null
  const perms = meta?.perms ?? { view: true, edit: false, manage: false }
  const filterActive = !!(filters.search || filters.from || filters.to || filters.statusIds.length || filters.componentIds.length)

  const afterSave = async (saved: Release, text: string) => {
    setEditor(null)
    await loadMeta()
    if (saved.tabId !== filters.tabId) setFilters(f => ({ ...f, tabId: saved.tabId }))
    else await loadList(filters.tabId)
    setSelectedId(saved.id)
    setFlash({ ok: true, text })
  }

  const remove = async (r: Release) => {
    if (!window.confirm(`確定刪除 ${md(keyDate(r))} 這筆紀錄？\n刪除後列表看不到，但修改履歷會保留。`)) return
    const j = await api('DELETE', `/api/osm-releases/${r.id}?rev=${r.rev}`)
    if (!j.ok) { setFlash({ ok: false, text: j.message ?? '刪除失敗' }); if (j.code === 'CONFLICT') void loadList(filters.tabId); return }
    await loadMeta(); await loadList(filters.tabId)
    setFlash({ ok: true, text: '已刪除' })
  }

  const saveView = async () => {
    const name = window.prompt('這個檢視要叫什麼名字？（只有你自己看得到）')?.trim()
    if (!name) return
    const j = await api<{ views: View[] }>('POST', '/api/osm-releases/views', { name, filters })
    if (j.ok) { setViews(j.views); setFlash({ ok: true, text: `已存成「${name}」` }) } else setFlash({ ok: false, text: j.message ?? '儲存失敗' })
  }
  const applyView = (id: string) => {
    const v = views.find(x => String(x.id) === id)
    if (!v) return
    const tabId = v.filters.tabId && meta?.tabs.some(t => t.id === v.filters.tabId) ? v.filters.tabId : filters.tabId
    setFilters({ ...emptyFilters(tabId), ...v.filters, tabId })
  }
  const deleteView = async (v: View) => {
    if (!window.confirm(`刪除檢視「${v.name}」？`)) return
    const j = await api<{ views: View[] }>('DELETE', `/api/osm-releases/views/${v.id}`)
    if (j.ok) setViews(j.views)
  }

  if (loadError) return <div className="orl-page"><div className="orl-card orl-msg orl-msg--bad">{loadError}</div></div>
  if (!meta) return <div className="orl-page"><div className="orl-muted">讀取中…</div></div>

  if (screen === 'settings') {
    return <SettingsScreen meta={meta} onBack={() => { setScreen('list'); void loadList(filters.tabId) }} reloadMeta={loadMeta} />
  }

  const months: { key: string; items: Release[] }[] = []
  for (const r of filtered) {
    const k = keyDate(r).slice(0, 7) || '未填日期'
    const last = months[months.length - 1]
    if (last?.key === k) last.items.push(r)
    else months.push({ key: k, items: [r] })
  }

  return (
    <div className="orl-page">
      <div className="orl-head">
        <div className="orl-head-meta">
          {meta.lastUpdated ? <>最後更新 {fmtTime(meta.lastUpdated.at)}・由 {meta.lastUpdated.by}</> : '還沒有任何紀錄'}
          {!perms.edit && <span className="orl-ro">唯讀</span>}
        </div>
        <div className="orl-head-actions">
          {perms.manage && <button className="orl-btn" onClick={() => setScreen('settings')}>設定</button>}
          <span title={perms.edit ? '' : '需要「編輯紀錄」權限，請洽管理員'}>
            <button className="orl-btn orl-btn--primary" disabled={!perms.edit || !tab?.active} onClick={() => setEditor({ release: null })}>＋ 新增更新</button>
          </span>
        </div>
      </div>

      {flash && <div className={`orl-flash ${flash.ok ? 'orl-flash--ok' : 'orl-flash--bad'}`} onClick={() => setFlash(null)}>{flash.text}</div>}

      {meta.tabs.length === 0 ? (
        <div className="orl-card orl-empty">
          還沒有任何分頁。{perms.manage ? '請到「設定 → 從 Lark 匯入」匯入歷史資料，或新增分頁。' : '請洽管理員設定。'}
        </div>
      ) : (
        <>
          <div className="orl-tabs">
            {meta.tabs.filter(t => t.active || meta.counts[t.id]).map(t => (
              <button key={t.id} className={`orl-tab${t.id === filters.tabId ? ' is-on' : ''}`} onClick={() => setFilters(f => ({ ...emptyFilters(t.id), mode: f.mode }))}>
                {t.name}<b>{meta.counts[t.id] ?? 0}</b>{!t.active && <i>已停用</i>}
              </button>
            ))}
          </div>

          <div className="orl-filters">
            <input className="orl-input orl-search" placeholder="搜尋單號、內容或版號…（例 P5MA-3060）" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
            <label className="orl-range">日期
              <input type="month" className="orl-input" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} />
              ～
              <input type="month" className="orl-input" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} />
            </label>
            <select className="orl-input" value={filters.statusIds[0] ?? ''} onChange={e => setFilters(f => ({ ...f, statusIds: e.target.value ? [Number(e.target.value)] : [] }))}>
              <option value="">狀態：全部</option>
              {meta.statuses.map(s => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : '（已停用）'}</option>)}
            </select>
            {tab?.showComponents && (
              <button className={`orl-input orl-pick${filters.componentIds.length ? ' is-set' : ''}`} onClick={() => setCompPickerOpen(o => !o)}>
                元件：{filters.componentIds.length ? filters.componentIds.map(id => compById.get(id)?.name).join('、') : '全部'} {compPickerOpen ? '▴' : '▾'}
              </button>
            )}
            <select className="orl-input" value="" onChange={e => { if (e.target.value === '__save') void saveView(); else applyView(e.target.value) }}>
              <option value="">我的檢視{views.length ? `（${views.length}）` : ''}</option>
              {views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              <option value="__save">＋ 把目前篩選存成檢視…</option>
            </select>
            {filterActive && <button className="orl-link" onClick={() => setFilters(f => ({ ...emptyFilters(f.tabId), mode: f.mode }))}>清除篩選</button>}
            <div className="orl-grow" />
            <div className="orl-seg">
              <button className={filters.mode === 'timeline' ? 'is-on' : ''} onClick={() => setFilters(f => ({ ...f, mode: 'timeline' }))}>時間軸</button>
              <button className={filters.mode === 'matrix' ? 'is-on' : ''} disabled={!tab?.showComponents} title={tab?.showComponents ? '' : '這個分頁沒有元件欄'} onClick={() => setFilters(f => ({ ...f, mode: 'matrix' }))}>矩陣</button>
            </div>
          </div>

          {compPickerOpen && tab?.showComponents && (
            <div className="orl-card orl-comp-picker">
              {[...new Set(tabComps.map(groupOf))].map(g => (
                <div key={g} className="orl-comp-picker-group">
                  <span className="orl-muted">{g}</span>
                  {tabComps.filter(c => groupOf(c) === g).map(c => (
                    <label key={c.id} className={`orl-check${c.active ? '' : ' is-off'}`}>
                      <input type="checkbox" checked={filters.componentIds.includes(c.id)}
                        onChange={e => setFilters(f => ({ ...f, componentIds: e.target.checked ? [...f.componentIds, c.id] : f.componentIds.filter(x => x !== c.id) }))} />
                      {c.name}
                    </label>
                  ))}
                </div>
              ))}
              {views.length > 0 && (
                <div className="orl-comp-picker-group">
                  <span className="orl-muted">我的檢視</span>
                  {views.map(v => <span key={v.id} className="orl-viewtag">{v.name}<button title="刪除這個檢視" onClick={() => void deleteView(v)}>✕</button></span>)}
                </div>
              )}
            </div>
          )}

          {listLoading ? <div className="orl-muted">讀取中…</div> : filtered.length === 0 ? (
            <div className="orl-card orl-empty">{releases.length ? '沒有符合篩選的紀錄' : '這個分頁還沒有紀錄'}</div>
          ) : filters.mode === 'matrix' && tab?.showComponents ? (
            <Matrix releases={filtered} comps={tabComps} statusById={statusById} collapsed={collapsed} setCollapsed={setCollapsed}
              onPick={id => { setSelectedId(id); setFilters(f => ({ ...f, mode: 'timeline' })) }} />
          ) : (
            <div className="orl-main">
              <div className="orl-timeline">
                {months.map(m => (
                  <div key={m.key}>
                    <div className="orl-month">{m.key.length === 7 ? `${m.key.slice(0, 4)} 年 ${Number(m.key.slice(5))} 月` : m.key}</div>
                    {m.items.map(r => {
                      const ups = r.values.filter(v => v.state === 'updated')
                      const lines = r.content.split('\n').filter(l => l.trim())
                      return (
                        <button key={r.id} className={`orl-card orl-rcard${selected?.id === r.id ? ' is-sel' : ''}`} onClick={() => setSelectedId(r.id)}>
                          <div className="orl-rcard-row1">
                            <span className="orl-date">{r.releaseDate ? `${md(r.releaseDate)} 上線` : `${md(r.testDate)} 測試`}</span>
                            {r.releaseDate && r.testDate && <span className="orl-muted">測試 {md(r.testDate)}</span>}
                            <StatusChip status={r.statusId == null ? undefined : statusById.get(r.statusId)} />
                          </div>
                          {ups.length > 0 && (
                            <div className="orl-comps">
                              {ups.slice(0, 8).map(v => <span key={v.componentId} className="orl-comp">{compById.get(v.componentId)?.name ?? '?'} <em>{v.version}</em></span>)}
                              {ups.length > 8 && <span className="orl-muted">+{ups.length - 8}</span>}
                            </div>
                          )}
                          {lines.length > 0 && (
                            <div className="orl-summary"><WithTickets text={firstLine(r.content)} />{lines.length > 1 && <span className="orl-more"> +{lines.length - 1} 行</span>}</div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
              {selected && (
                <Detail release={selected} tab={tab} comps={tabComps} statusById={statusById} perms={perms} live={live}
                  onEdit={() => setEditor({ release: selected })} onRevisions={() => setRevisionsOf(selected)} onDelete={() => void remove(selected)} />
              )}
            </div>
          )}
        </>
      )}

      {editor && (
        <Editor meta={meta} reloadMeta={loadMeta} initialTabId={filters.tabId} release={editor.release} onClose={() => setEditor(null)}
          onSaved={(r, isNew) => void afterSave(r, isNew ? '已新增' : '已儲存')} />
      )}
      {revisionsOf && <Revisions release={revisionsOf} compById={compById} statusById={statusById} onClose={() => setRevisionsOf(null)} />}
    </div>
  )
}

// ─── 詳情 ──────────────────────────────────────────────────────────────────────

function Detail({ release: r, tab, comps, statusById, perms, live, onEdit, onRevisions, onDelete }: {
  release: Release; tab?: Tab; comps: Comp[]; statusById: Map<number, Status>; perms: Perms
  live: { live: Live[]; fetchedAt: number; env: string } | null
  onEdit: () => void; onRevisions: () => void; onDelete: () => void
}) {
  const status = r.statusId == null ? undefined : statusById.get(r.statusId)
  const valueOf = new Map(r.values.map(v => [v.componentId, v]))
  const shown = comps.filter(c => valueOf.has(c.id) && valueOf.get(c.id)!.state !== 'na')
    .sort((a, b) => Number(valueOf.get(b.id)!.state === 'updated') - Number(valueOf.get(a.id)!.state === 'updated'))
  const naCount = comps.filter(c => valueOf.get(c.id)?.state === 'na').length
  const tickets = extractTickets(r.content)
  return (
    <div className="orl-card orl-detail">
      <div className="orl-muted">{tab?.name}・{status?.name ?? '未填狀態'}</div>
      <h3>{r.releaseDate ? `${md(r.releaseDate)} 上線` : `${md(r.testDate)} 測試`}</h3>
      <div className="orl-kv">
        <span>測試日期</span><span>{r.testDate ? ymd(r.testDate) : '—'}</span>
        <span>上線日期</span><span>{r.releaseDate ? ymd(r.releaseDate) : '—'}</span>
        <span>填寫</span><span>{r.source === 'lark-import' ? '從 Lark 匯入' : `${r.createdBy}・${fmtTime(r.createdAt)}`}</span>
        {r.rev > 1 && <><span>最後修改</span><span>{r.updatedBy}・{fmtTime(r.updatedAt)}</span></>}
        {tickets.length > 0 && <><span>單號</span><span className="orl-tk">{tickets.join('　')}</span></>}
      </div>
      {tab?.showComponents && (
        <>
          <div className="orl-hd">元件版號</div>
          {shown.length ? (
            <table className="orl-vtable"><tbody>
              {shown.map(c => {
                const v = valueOf.get(c.id)!
                return <tr key={c.id}><td>{c.name}</td>{v.state === 'updated' ? <td className="orl-v">{v.version}</td> : <td className="orl-na">未異動</td>}</tr>
              })}
            </tbody></table>
          ) : <div className="orl-muted">沒有元件資料</div>}
          {naCount > 0 && <div className="orl-muted orl-small">另有 {naCount} 個元件未提供</div>}
        </>
      )}
      <div className="orl-hd">更新內容</div>
      <div className="orl-content">{r.content ? <WithTickets text={r.content} /> : '（無）'}</div>
      {tab?.showSql && <><div className="orl-hd">SQL 執行</div><div className="orl-content orl-mono">{r.sqlText || '（無）'}</div></>}
      {tab?.showResult && <><div className="orl-hd">更新結果</div><div className="orl-content">{r.resultText || '（無）'}</div></>}
      {live && live.live.length > 0 && (
        <div className="orl-live">
          線上目前版本（{fmtTime(live.fetchedAt)} 抓取・{live.env}）：
          {live.live.map(l => {
            const comp = comps.find(c => c.name.toUpperCase() === l.name.toUpperCase())
            const mine = comp ? valueOf.get(comp.id) : undefined
            const same = mine?.state === 'updated' && mine.version === l.version
            return <span key={l.name} className="orl-live-item">{l.name} {l.version || (l.error ? '讀取失敗' : '—')}{same && <b> ✓</b>}</span>
          })}
        </div>
      )}
      <div className="orl-detail-actions">
        {perms.edit && <button className="orl-btn" onClick={onEdit}>編輯</button>}
        <button className="orl-btn" onClick={onRevisions}>修改履歷（{r.rev}）</button>
        {perms.manage && <button className="orl-btn orl-btn--danger" onClick={onDelete}>刪除</button>}
      </div>
    </div>
  )
}

// ─── 矩陣 ──────────────────────────────────────────────────────────────────────

function Matrix({ releases, comps, statusById, collapsed, setCollapsed, onPick }: {
  releases: Release[]; comps: Comp[]; statusById: Map<number, Status>
  collapsed: Record<string, boolean>; setCollapsed: (f: (c: Record<string, boolean>) => Record<string, boolean>) => void
  onPick: (id: number) => void
}) {
  // 停用且這批紀錄都沒用到的元件不佔欄位
  const used = new Set(releases.flatMap(r => r.values.filter(v => v.state !== 'na').map(v => v.componentId)))
  const cols = comps.filter(c => c.active || used.has(c.id))
  const groups = [...new Set(cols.map(groupOf))]
  // 預設只展開第一組（照設計稿：LuckyLink 組件預設收合）
  const isCollapsed = (g: string, i: number) => collapsed[g] ?? i > 0
  return (
    <div className="orl-card orl-matrix-wrap">
      <table className="orl-matrix">
        <thead>
          <tr>
            <th rowSpan={2}>日期</th><th rowSpan={2}>狀態</th>
            {groups.map((g, i) => {
              const n = cols.filter(c => groupOf(c) === g).length
              const c = isCollapsed(g, i)
              return (
                <th key={g} className="orl-grp" colSpan={c ? 1 : n}>
                  <button className="orl-link" onClick={() => setCollapsed(s => ({ ...s, [g]: !c }))}>{g} <span className="orl-muted">{c ? `（${n} 欄已收合 ▸）` : '◂'}</span></button>
                </th>
              )
            })}
            <th rowSpan={2}>摘要</th>
          </tr>
          <tr>
            {groups.map((g, i) => isCollapsed(g, i)
              ? <th key={g}>有更新的</th>
              : cols.filter(c => groupOf(c) === g).map(c => <th key={c.id} className={c.active ? '' : 'is-off'}>{c.name}</th>))}
          </tr>
        </thead>
        <tbody>
          {releases.map(r => {
            const valueOf = new Map(r.values.map(v => [v.componentId, v]))
            const status = r.statusId == null ? undefined : statusById.get(r.statusId)
            return (
              <tr key={r.id} onClick={() => onPick(r.id)} title="點一下看詳情">
                <td className="orl-nowrap">{md(keyDate(r))}{!r.releaseDate && <span className="orl-muted">（測）</span>}</td>
                <td><StatusChip status={status} short /></td>
                {groups.map((g, i) => {
                  const gc = cols.filter(c => groupOf(c) === g)
                  if (isCollapsed(g, i)) {
                    const ups = gc.filter(c => valueOf.get(c.id)?.state === 'updated')
                    return ups.length
                      ? <td key={g} className="orl-v">{ups.map(c => `${c.name} ${valueOf.get(c.id)!.version}`).join('・')}</td>
                      : <td key={g} className={gc.some(c => valueOf.get(c.id)?.state === 'unchanged') ? 'orl-x' : 'orl-e'}>{gc.some(c => valueOf.get(c.id)?.state === 'unchanged') ? '未異動' : '未提供'}</td>
                  }
                  return gc.map(c => {
                    const v = valueOf.get(c.id)
                    if (v?.state === 'updated') return <td key={c.id} className="orl-v">{v.version}</td>
                    if (v?.state === 'unchanged') return <td key={c.id} className="orl-x">未異動</td>
                    return <td key={c.id} className="orl-e">未提供</td>
                  })
                })}
                <td className="orl-msum"><WithTickets text={firstLine(r.content)} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── 新增／編輯 ────────────────────────────────────────────────────────────────

type Form = Omit<ReleaseInput, 'values'> & { values: Record<number, { state: ComponentState; version: string }> }

function formFrom(r: Release | null, tabId: string, meta: Meta): Form {
  const firstStatus = meta.statuses.find(s => s.active)
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const values: Form['values'] = {}
  if (r) for (const v of r.values) values[v.componentId] = { state: v.state, version: v.version }
  return r
    ? { tabId: r.tabId, statusId: r.statusId, testDate: r.testDate, releaseDate: r.releaseDate, content: r.content, sqlText: r.sqlText, resultText: r.resultText, values }
    : { tabId, statusId: firstStatus?.id ?? null, testDate: today, releaseDate: '', content: '', sqlText: '', resultText: '', values }
}

/** 表單裡出現的元件：啟用中的全部列出；停用的只有這筆原本就有值才列（舊紀錄要讀得到、改得到） */
function formComps(meta: Meta, f: Form): Comp[] {
  return meta.components.filter(c => c.tabId === f.tabId && (c.active || (f.values[c.id] && f.values[c.id].state !== 'na')))
}

function toInput(meta: Meta, f: Form, isNew: boolean): ReleaseInput {
  const tab = meta.tabs.find(t => t.id === f.tabId)
  const comps = tab?.showComponents ? formComps(meta, f) : []
  return {
    tabId: f.tabId, statusId: f.statusId, testDate: f.testDate, releaseDate: f.releaseDate, content: f.content,
    sqlText: tab?.showSql ? f.sqlText : '', resultText: tab?.showResult ? f.resultText : '',
    // 新紀錄沒碰過的元件預設「未異動」（Lark 表上大部分列都是 x）；舊紀錄沒有值的（之後才加的元件）維持「未提供」，不能存檔時偷偷改掉
    values: comps.map(c => ({ componentId: c.id, state: f.values[c.id]?.state ?? (isNew ? 'unchanged' : 'na'), version: f.values[c.id]?.state === 'updated' ? f.values[c.id].version : '' })),
  }
}

function Editor({ meta, reloadMeta, initialTabId, release, onClose, onSaved }: {
  meta: Meta; reloadMeta: () => Promise<Meta | null>; initialTabId: string; release: Release | null; onClose: () => void; onSaved: (r: Release, isNew: boolean) => void
}) {
  const [base, setBase] = useState<Release | null>(release)
  const [form, setForm] = useState<Form>(() => formFrom(release, initialTabId, meta))
  const [initial, setInitial] = useState(() => JSON.stringify(toInput(meta, formFrom(release, initialTabId, meta), !release)))
  const [touched, setTouched] = useState(false)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [conflict, setConflict] = useState<Release | null>(null)
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const tab = meta.tabs.find(t => t.id === form.tabId)
  const comps = tab?.showComponents ? formComps(meta, form) : []
  const groups = [...new Set(comps.map(groupOf))]
  const input = toInput(meta, form, !base)
  const dirty = JSON.stringify(input) !== initial
  const keepIds = base ? { statusId: base.statusId, componentIds: base.values.filter(v => v.state === 'updated').map(v => v.componentId) } : undefined
  const errors = validateRelease(input, {
    tabs: meta.tabs, statuses: meta.statuses,
    components: meta.components.map(c => ({ id: c.id, tabId: c.tabId, name: c.name, active: c.active })), keepIds,
  })
  const shownErrors = touched ? { ...errors, ...serverErrors } : serverErrors

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const close = () => { if (!dirty || window.confirm('有未儲存的內容，確定要關閉？')) onClose() }
  const set = (p: Partial<Form>) => { setForm(f => ({ ...f, ...p })); setServerErrors({}) }
  const setVal = (id: number, p: Partial<{ state: ComponentState; version: string }>) =>
    setForm(f => ({ ...f, values: { ...f.values, [id]: { state: f.values[id]?.state ?? (base ? 'na' : 'unchanged'), version: f.values[id]?.version ?? '', ...p } } }))

  const save = async () => {
    setTouched(true); setMsg('')
    if (Object.keys(errors).length) { setMsg('有欄位需要修正'); return }
    setSaving(true)
    const j = base
      ? await api<{ release: Release }>('PUT', `/api/osm-releases/${base.id}`, { ...input, rev: base.rev })
      : await api<{ release: Release }>('POST', '/api/osm-releases', input)
    setSaving(false)
    if (j.ok) { onSaved(j.release, !base); return }
    if (j.code === 'CONFLICT' && j.current) { setConflict(j.current); return }
    setServerErrors(j.errors ?? {}); setMsg(j.message ?? '儲存失敗')
  }

  /**
   * 衝突時：拿最新版重新開始（我的修改會被捨棄，所以先確認）。
   * 設定要一起重讀——對方可能剛加了元件，用舊設定重建表單會看不到那些值（CodeX 1022 [P1]；後端也會補回沒送到的值）
   */
  const takeLatest = async () => {
    if (!conflict || !window.confirm('改用最新版本？你在這個視窗的修改會被捨棄。')) return
    const m = (await reloadMeta()) ?? meta
    const f = formFrom(conflict, conflict.tabId, m)
    setBase(conflict); setForm(f); setInitial(JSON.stringify(toInput(m, f, false))); setConflict(null); setServerErrors({}); setMsg('')
  }

  const err = (k: string) => shownErrors[k] ? <div className="orl-err">{shownErrors[k]}</div> : null

  return createPortal(
    <div className="orl-portal orl-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="orl-drawer" role="dialog" aria-label={base ? '編輯更新' : '新增更新'}>
        <div className="orl-drawer-head">
          <b>{base ? `編輯更新（第 ${base.rev} 版）` : '新增更新'}</b>
          <button className="orl-x-btn" onClick={close} aria-label="關閉">✕</button>
        </div>
        {conflict && (
          <div className="orl-banner">
            <b>{conflict.updatedBy}</b> 在 {fmtTime(conflict.updatedAt)} 改過這筆（已是第 {conflict.rev} 版），你的修改還沒存。
            <div className="orl-banner-actions">
              <button className="orl-btn" onClick={() => void takeLatest()}>改用最新版本重新編輯</button>
              <span className="orl-muted">或先把要改的內容複製起來再切換</span>
            </div>
          </div>
        )}
        <div className="orl-grid4">
          <label><span className="orl-flabel">分頁</span>
            <select className="orl-input" value={form.tabId} disabled={!!base} onChange={e => set({ tabId: e.target.value, values: {} })}>
              {meta.tabs.filter(t => t.active || t.id === form.tabId).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>{err('tabId')}
          </label>
          <label><span className="orl-flabel">狀態</span>
            <select className="orl-input" value={form.statusId ?? ''} onChange={e => set({ statusId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">請選擇</option>
              {meta.statuses.filter(s => s.active || s.id === base?.statusId).map(s => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : '（已停用）'}</option>)}
            </select>{err('statusId')}
          </label>
          <label><span className="orl-flabel">測試日期</span>
            <input type="date" className="orl-input" value={form.testDate} onChange={e => set({ testDate: e.target.value })} />{err('testDate')}
          </label>
          <label><span className="orl-flabel">上線日期</span>
            <input type="date" className="orl-input" value={form.releaseDate} onChange={e => set({ releaseDate: e.target.value })} />{err('releaseDate')}
          </label>
        </div>
        <div className={`orl-fgrid${tab?.showComponents ? '' : ' orl-fgrid--single'}`}>
          {tab?.showComponents && (
            <div className="orl-fcomps">
              <div className="orl-flabel">元件版號 <span className="orl-muted">（有更新才填版號）</span></div>
              {groups.map((g, gi) => {
                const gc = comps.filter(c => groupOf(c) === g)
                const updatedN = gc.filter(c => input.values.find(v => v.componentId === c.id)?.state === 'updated').length
                const hasErr = gc.some(c => shownErrors[`component:${c.id}`])
                const isOpen = open[g] ?? (gi === 0 || updatedN > 0 || hasErr)
                return (
                  <div key={g} className="orl-fgroup">
                    {groups.length > 1 && (
                      <button className="orl-link orl-fgroup-head" onClick={() => setOpen(o => ({ ...o, [g]: !isOpen }))}>
                        {g}（{gc.length}）{updatedN > 0 && <span className="orl-v"> {updatedN} 個有更新</span>} {isOpen ? '▾' : '▸'}
                      </button>
                    )}
                    {isOpen && gc.map(c => {
                      const st = input.values.find(v => v.componentId === c.id)?.state ?? 'na'
                      return (
                        <div key={c.id}>
                          <div className="orl-crow">
                            <span className={c.active ? '' : 'orl-off'} title={c.active ? '' : '已停用的元件，只有原本就有值的紀錄看得到'}>{c.name}</span>
                            <span className="orl-pill3">
                              {(['updated', 'unchanged', 'na'] as const).map(s => (
                                <button key={s} className={st === s ? 'is-on' : ''} disabled={s === 'updated' && !c.active && !keepIds?.componentIds.includes(c.id)}
                                  onClick={() => setVal(c.id, { state: s })}>{STATE_LABEL[s]}</button>
                              ))}
                            </span>
                            {st === 'updated'
                              ? <input className={`orl-input orl-ver${shownErrors[`component:${c.id}`] ? ' is-bad' : ''}`} value={form.values[c.id]?.version ?? ''} placeholder="版號" onChange={e => setVal(c.id, { version: e.target.value })} />
                              : <span />}
                          </div>
                          {err(`component:${c.id}`)}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
              {comps.length === 0 && <div className="orl-muted">這個分頁還沒有元件，請到設定新增</div>}
            </div>
          )}
          <div className="orl-ftexts">
            <label><span className="orl-flabel">更新內容 <span className="orl-muted">（支援多行，單號會自動辨識）</span></span>
              <textarea className="orl-input orl-ta" rows={9} value={form.content} onChange={e => set({ content: e.target.value })} />
            </label>
            {extractTickets(form.content).length > 0 && <div className="orl-small orl-muted">單號：<span className="orl-tk">{extractTickets(form.content).join('　')}</span></div>}
            {err('content')}
            {tab?.showSql && <label><span className="orl-flabel">SQL 執行</span><textarea className="orl-input orl-ta orl-mono" rows={3} value={form.sqlText} onChange={e => set({ sqlText: e.target.value })} /></label>}
            {tab?.showResult && <label><span className="orl-flabel">更新結果</span><textarea className="orl-input orl-ta" rows={3} value={form.resultText} onChange={e => set({ resultText: e.target.value })} /></label>}
          </div>
        </div>
        <div className="orl-drawer-foot">
          <span className={msg ? 'orl-err' : 'orl-muted'}>{msg || '離開前有未儲存內容會提醒・別人同時修改時會提示衝突'}</span>
          <span className="orl-btns">
            <button className="orl-btn" onClick={close}>取消</button>
            <button className="orl-btn orl-btn--primary" disabled={saving || !!conflict || (!!base && !dirty)} onClick={() => void save()}>{saving ? '儲存中…' : '儲存'}</button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ─── 修改履歷 ──────────────────────────────────────────────────────────────────

function diffSnap(a: Release | null, b: Release | null, compById: Map<number, Comp>, statusById: Map<number, Status>): string[] {
  if (!a || !b) return []
  const out: string[] = []
  const st = (id: number | null) => (id == null ? '未填' : statusById.get(id)?.name ?? `#${id}`)
  if (a.statusId !== b.statusId) out.push(`狀態：${st(a.statusId)} → ${st(b.statusId)}`)
  if (a.testDate !== b.testDate) out.push(`測試日期：${a.testDate || '—'} → ${b.testDate || '—'}`)
  if (a.releaseDate !== b.releaseDate) out.push(`上線日期：${a.releaseDate || '—'} → ${b.releaseDate || '—'}`)
  if (a.content !== b.content) out.push('更新內容有修改')
  if (a.sqlText !== b.sqlText) out.push('SQL 執行有修改')
  if (a.resultText !== b.resultText) out.push('更新結果有修改')
  const show = (v?: Value) => (!v ? '未提供' : v.state === 'updated' ? v.version : STATE_LABEL[v.state])
  const av = new Map(a.values.map(v => [v.componentId, v])), bv = new Map(b.values.map(v => [v.componentId, v]))
  for (const id of new Set([...av.keys(), ...bv.keys()])) {
    const x = show(av.get(id)), y = show(bv.get(id))
    if (x !== y) out.push(`${compById.get(id)?.name ?? `#${id}`}：${x} → ${y}`)
  }
  return out
}

function Revisions({ release, compById, statusById, onClose }: { release: Release; compById: Map<number, Comp>; statusById: Map<number, Status>; onClose: () => void }) {
  const [revs, setRevs] = useState<Revision[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void api<{ revisions: Revision[] }>('GET', `/api/osm-releases/${release.id}/revisions`).then(j => (j.ok ? setRevs(j.revisions) : setError(j.message ?? '讀取失敗')))
  }, [release.id])
  return createPortal(
    <div className="orl-portal orl-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="orl-modal" role="dialog" aria-label="修改履歷">
        <div className="orl-drawer-head"><b>修改履歷・{md(keyDate(release))}</b><button className="orl-x-btn" onClick={onClose} aria-label="關閉">✕</button></div>
        {error && <div className="orl-err">{error}</div>}
        {!revs && !error && <div className="orl-muted">讀取中…</div>}
        {revs?.map((r, i) => {
          const prev = revs[i + 1]
          const changes = r.action === 'update' ? diffSnap(prev?.snapshot ?? null, r.snapshot, compById, statusById) : []
          return (
            <div key={r.rev} className="orl-rev">
              <div><b>第 {r.rev} 版</b>・{ACTION_LABEL[r.action] ?? r.action}・{r.actor}・<span className="orl-muted">{fmtTime(r.at)}</span></div>
              {r.action === 'update' && (changes.length ? <ul>{changes.map((c, k) => <li key={k}>{c}</li>)}</ul> : <div className="orl-muted orl-small">沒有欄位變動</div>)}
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

// ─── 設定 ──────────────────────────────────────────────────────────────────────

function SettingsScreen({ meta, onBack, reloadMeta }: { meta: Meta; onBack: () => void; reloadMeta: () => Promise<Meta | null> }) {
  const [section, setSection] = useState<'tabs' | 'components' | 'statuses' | 'import'>(meta.tabs.length ? 'components' : 'import')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (p: Promise<ApiResult<unknown>>, okText?: string) => {
    const j = await p
    if (!j.ok) { setMsg({ ok: false, text: j.message ?? '操作失敗' }); return false }
    await reloadMeta()
    setMsg(okText ? { ok: true, text: okText } : null)
    return true
  }
  const nav = [['tabs', '分頁'], ['components', '元件'], ['statuses', '狀態清單'], ['import', '從 Lark 匯入']] as const
  return (
    <div className="orl-page">
      <div className="orl-head">
        <button className="orl-btn" onClick={onBack}>← 回到紀錄</button>
        <span className="orl-muted">設定變更立即生效；被紀錄用過的項目只能停用，不能刪除</span>
      </div>
      {msg && <div className={`orl-flash ${msg.ok ? 'orl-flash--ok' : 'orl-flash--bad'}`} onClick={() => setMsg(null)}>{msg.text}</div>}
      <div className="orl-settings">
        <div className="orl-card orl-nav">
          {nav.map(([k, l]) => <button key={k} className={section === k ? 'is-on' : ''} onClick={() => { setSection(k); setMsg(null) }}>{l}</button>)}
        </div>
        <div className="orl-card orl-settings-body">
          {section === 'tabs' && <TabsSettings meta={meta} run={run} />}
          {section === 'components' && <ComponentsSettings meta={meta} run={run} />}
          {section === 'statuses' && <StatusSettings meta={meta} run={run} />}
          {section === 'import' && <ImportSettings reloadMeta={reloadMeta} />}
        </div>
      </div>
    </div>
  )
}

type Run = (p: Promise<ApiResult<unknown>>, okText?: string) => Promise<boolean>

function move<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d
  if (j < 0 || j >= list.length) return list
  const out = list.slice();[out[i], out[j]] = [out[j], out[i]]
  return out
}

function TabsSettings({ meta, run }: { meta: Meta; run: Run }) {
  const [draft, setDraft] = useState({ id: '', name: '', showComponents: true, showSql: false, showResult: false })
  const save = (t: Tab, p: Partial<Tab>) => run(api('POST', '/api/osm-releases/tabs', { id: t.id, name: t.name, showComponents: t.showComponents, showSql: t.showSql, showResult: t.showResult, active: t.active, ...p }))
  const reorder = (list: Tab[]) => run(api('POST', '/api/osm-releases/reorder', { kind: 'tabs', ids: list.map(t => t.id) }))
  return (
    <>
      <div className="orl-sec-head"><b>分頁</b><span className="orl-muted">對應 Lark 表的各個頁籤；勾選決定表單要顯示哪些欄位</span></div>
      <table className="orl-list">
        <thead><tr><th /><th>名稱</th><th>代碼</th><th>元件欄</th><th>SQL 執行</th><th>更新結果</th><th>紀錄</th><th>狀態</th></tr></thead>
        <tbody>
          {meta.tabs.map((t, i) => (
            <tr key={t.id}>
              <td className="orl-order"><button disabled={i === 0} onClick={() => void reorder(move(meta.tabs, i, -1))}>▲</button><button disabled={i === meta.tabs.length - 1} onClick={() => void reorder(move(meta.tabs, i, 1))}>▼</button></td>
              <td><RenameCell value={t.name} onSave={name => save(t, { name })} /></td>
              <td className="orl-muted orl-mono">{t.id}</td>
              <td><input type="checkbox" checked={t.showComponents} onChange={e => void save(t, { showComponents: e.target.checked })} /></td>
              <td><input type="checkbox" checked={t.showSql} onChange={e => void save(t, { showSql: e.target.checked })} /></td>
              <td><input type="checkbox" checked={t.showResult} onChange={e => void save(t, { showResult: e.target.checked })} /></td>
              <td>{meta.counts[t.id] ?? 0} 筆</td>
              <td><button className={`orl-tag${t.active ? '' : ' is-off'}`} onClick={() => void save(t, { active: !t.active })} title="點一下切換">{t.active ? '啟用' : '已停用'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="orl-add">
        <input className="orl-input" placeholder="名稱（例 PC_OSM）" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
        <input className="orl-input orl-mono" placeholder="代碼（小寫英數與 -）" value={draft.id} onChange={e => setDraft(d => ({ ...d, id: e.target.value.toLowerCase() }))} />
        <label className="orl-check"><input type="checkbox" checked={draft.showComponents} onChange={e => setDraft(d => ({ ...d, showComponents: e.target.checked }))} />元件欄</label>
        <label className="orl-check"><input type="checkbox" checked={draft.showSql} onChange={e => setDraft(d => ({ ...d, showSql: e.target.checked }))} />SQL</label>
        <label className="orl-check"><input type="checkbox" checked={draft.showResult} onChange={e => setDraft(d => ({ ...d, showResult: e.target.checked }))} />更新結果</label>
        <button className="orl-btn orl-btn--primary" disabled={!draft.name.trim() || !/^[a-z0-9-]{1,40}$/.test(draft.id) || meta.tabs.some(t => t.id === draft.id)}
          onClick={() => void run(api('POST', '/api/osm-releases/tabs', draft), `已新增分頁「${draft.name}」`).then(ok => { if (ok) setDraft({ id: '', name: '', showComponents: true, showSql: false, showResult: false }) })}>＋ 新增分頁</button>
      </div>
    </>
  )
}

function ComponentsSettings({ meta, run }: { meta: Meta; run: Run }) {
  const [tabId, setTabId] = useState(meta.tabs.find(t => t.showComponents)?.id ?? meta.tabs[0]?.id ?? '')
  const [draft, setDraft] = useState({ name: '', groupName: '' })
  const list = meta.components.filter(c => c.tabId === tabId)
  const groupNames = [...new Set(list.map(c => c.groupName).filter(Boolean))]
  const upd = (c: Comp, p: Partial<Pick<Comp, 'name' | 'groupName' | 'active'>>) => run(api('PUT', `/api/osm-releases/components/${c.id}`, p))
  const reorder = (l: Comp[]) => run(api('POST', '/api/osm-releases/reorder', { kind: 'components', ids: l.map(c => c.id) }))
  return (
    <>
      <div className="orl-sec-head">
        <b>元件</b>
        <select className="orl-input" value={tabId} onChange={e => setTabId(e.target.value)}>
          {meta.tabs.map(t => <option key={t.id} value={t.id}>分頁：{t.name}</option>)}
        </select>
        <span className="orl-muted">群組名稱相同的元件在矩陣裡會併成一組、可收合</span>
      </div>
      <table className="orl-list">
        <thead><tr><th /><th>名稱</th><th>群組</th><th>被引用</th><th>狀態</th><th /></tr></thead>
        <tbody>
          {list.map((c, i) => (
            <tr key={c.id}>
              <td className="orl-order"><button disabled={i === 0} onClick={() => void reorder(move(list, i, -1))}>▲</button><button disabled={i === list.length - 1} onClick={() => void reorder(move(list, i, 1))}>▼</button></td>
              <td><RenameCell value={c.name} onSave={name => upd(c, { name })} /></td>
              <td><RenameCell value={c.groupName} placeholder="（未分組）" onSave={groupName => upd(c, { groupName })} /></td>
              <td>{c.usage} 筆</td>
              <td><button className={`orl-tag${c.active ? '' : ' is-off'}`} onClick={() => void upd(c, { active: !c.active })} title="點一下切換">{c.active ? '啟用' : '已停用'}</button></td>
              <td>{c.usage === 0 && <button className="orl-link orl-danger" onClick={() => { if (window.confirm(`刪除元件「${c.name}」？`)) void run(api('DELETE', `/api/osm-releases/components/${c.id}`), '已刪除') }}>刪除</button>}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} className="orl-muted">這個分頁還沒有元件</td></tr>}
        </tbody>
      </table>
      <div className="orl-add">
        <input className="orl-input" placeholder="元件名稱" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
        <input className="orl-input" placeholder="群組（例 LuckyLink組件）" list="orl-groups" value={draft.groupName} onChange={e => setDraft(d => ({ ...d, groupName: e.target.value }))} />
        <datalist id="orl-groups">{groupNames.map(g => <option key={g} value={g} />)}</datalist>
        <button className="orl-btn orl-btn--primary" disabled={!tabId || !draft.name.trim()}
          onClick={() => void run(api('POST', '/api/osm-releases/components', { tabId, ...draft }), `已新增「${draft.name}」`).then(ok => { if (ok) setDraft(d => ({ ...d, name: '' })) })}>＋ 新增元件</button>
      </div>
    </>
  )
}

function StatusSettings({ meta, run }: { meta: Meta; run: Run }) {
  const [draft, setDraft] = useState({ name: '', tone: 'other' })
  const upd = (s: Status, p: Partial<Pick<Status, 'name' | 'tone' | 'active'>>) => run(api('PUT', `/api/osm-releases/statuses/${s.id}`, p))
  const reorder = (l: Status[]) => run(api('POST', '/api/osm-releases/reorder', { kind: 'statuses', ids: l.map(s => s.id) }))
  return (
    <>
      <div className="orl-sec-head"><b>狀態清單</b><span className="orl-muted">色系只影響標籤顏色</span></div>
      <table className="orl-list">
        <thead><tr><th /><th>名稱</th><th>色系</th><th>預覽</th><th>被引用</th><th>狀態</th></tr></thead>
        <tbody>
          {meta.statuses.map((s, i) => (
            <tr key={s.id}>
              <td className="orl-order"><button disabled={i === 0} onClick={() => void reorder(move(meta.statuses, i, -1))}>▲</button><button disabled={i === meta.statuses.length - 1} onClick={() => void reorder(move(meta.statuses, i, 1))}>▼</button></td>
              <td><RenameCell value={s.name} onSave={name => upd(s, { name })} /></td>
              <td><select className="orl-input" value={s.tone} onChange={e => void upd(s, { tone: e.target.value })}>{TONES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              <td><StatusChip status={s} /></td>
              <td>{s.usage} 筆</td>
              <td><button className={`orl-tag${s.active ? '' : ' is-off'}`} onClick={() => void upd(s, { active: !s.active })} title="點一下切換">{s.active ? '啟用' : '已停用'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="orl-add">
        <input className="orl-input" placeholder="狀態名稱" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
        <select className="orl-input" value={draft.tone} onChange={e => setDraft(d => ({ ...d, tone: e.target.value }))}>{TONES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <button className="orl-btn orl-btn--primary" disabled={!draft.name.trim()}
          onClick={() => void run(api('POST', '/api/osm-releases/statuses', draft), `已新增「${draft.name}」`).then(ok => { if (ok) setDraft({ name: '', tone: 'other' }) })}>＋ 新增狀態</button>
      </div>
    </>
  )
}

function ImportSettings({ reloadMeta }: { reloadMeta: () => Promise<Meta | null> }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<{ tab: string; added?: number; skipped?: number; error?: string }[] | null>(null)
  const go = async () => {
    setBusy(true); setError(''); setResults(null)
    const j = await api<{ results: { tab: string; added?: number; skipped?: number; error?: string }[] }>('POST', '/api/osm-releases/import', { url: url.trim() })
    setBusy(false)
    if (!j.ok) { setError(j.message ?? '匯入失敗'); return }
    setResults(j.results)
    await reloadMeta()
  }
  return (
    <>
      <div className="orl-sec-head"><b>從 Lark 匯入</b></div>
      <p className="orl-muted orl-small">
        貼上 Lark「OSM 更新版本」表的網址（Wiki 或試算表都可以），會把每個頁籤匯成一個分頁、表頭的元件建成元件。
        重複匯入只會補還沒匯過的列，不會重複；匯入後這個工具就是主檔，之後在 Lark 表上的修改不會同步過來。
      </p>
      <div className="orl-add">
        <input className="orl-input orl-grow" placeholder="https://xxx.larksuite.com/wiki/…" value={url} onChange={e => setUrl(e.target.value)} />
        <button className="orl-btn orl-btn--primary" disabled={busy || !/^https:\/\//.test(url.trim())} onClick={() => void go()}>{busy ? '匯入中…' : '開始匯入'}</button>
      </div>
      {error && <div className="orl-err">{error}</div>}
      {results && (
        <table className="orl-list">
          <thead><tr><th>頁籤</th><th>結果</th></tr></thead>
          <tbody>{results.map(r => <tr key={r.tab}><td>{r.tab}</td><td>{r.error ? <span className="orl-muted">略過：{r.error}</span> : `新增 ${r.added} 筆${r.skipped ? `，${r.skipped} 筆先前已匯入` : ''}`}</td></tr>)}</tbody>
        </table>
      )}
    </>
  )
}

/** 點一下就地改名；Enter 存、Esc 取消 */
function RenameCell({ value, placeholder, onSave }: { value: string; placeholder?: string; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  if (!editing) return <button className="orl-rename" title="點一下修改" onClick={() => setEditing(true)}>{value || <span className="orl-muted">{placeholder}</span>}</button>
  const commit = async () => { if (v.trim() === value) { setEditing(false); return } if (await onSave(v.trim())) setEditing(false) }
  return (
    <input className="orl-input orl-rename-input" autoFocus value={v} onChange={e => setV(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { setV(value); setEditing(false) } }} onBlur={() => void commit()} />
  )
}

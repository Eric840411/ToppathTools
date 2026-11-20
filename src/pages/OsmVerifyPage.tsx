/**
 * 版本驗證表（docs/features/35-osm-verify.md；版面 CodeX 出圖、Eric 1120 同意）。
 * 取代 Lark「驗證表單_v2」：填驗證項目 → 綁版本紀錄 → 標記已上正式 → 各列用自己的 Meegle 帳號開單 → OSM QA agent 拉事件學習。
 *
 * - 上方批次清單；選中後標題列＋「上正式檢查」卡＋滿寬驗證項目表
 * - 規則（上正式檢查、開單欄位）跟後端共用 shared/osm-verify-rules.ts
 * - 權限由後端 /meta 回傳；權限不足的按鈕直接不渲染，真正的檢查在後端
 * - 開單按下即送出、不確認；結果不明的列展開提示列（到遠端查／確認重送／再開一張）
 * - 彈窗一律 createPortal 掛 body（祖先有 backdrop-filter）
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  PUBLISH_LABEL, LEARN_LABEL, TICKET_LABEL, validateItem, validateBatch, resolveCreateValues,
  type PublishStatus, type LearnStatus, type TicketStatus, type ItemInput, type ReleaseCheck, type TypeCreateSchema, type PlatformMap,
} from '../../shared/osm-verify-rules'
import { PageActions } from '../redesign/PageActions'
import './OsmVerifyPage.css'

type Perms = { view: boolean; edit: boolean; manage: boolean }
type Meta = { perms: Perms; isAdmin: boolean; platformMap: PlatformMap; eventKeyConfigured?: boolean }
type Batch = {
  id: string; year: number; batch: string; name: string; publishStatus: PublishStatus; learnStatus: LearnStatus; prodVersion: string
  releasedAt: number | null; releasedBy: string; updatedBy: string; updatedAt: number; rev: number; itemCount: number; bindingCount: number
}
type Ticket = { id: number; seq: number; key: string; status: TicketStatus; space: string; typeKey: string; workItemId: string; url: string; message: string; createdLabel: string; attempts: number; updatedAt: number }
type Item = ItemInput & { id: number; rev: number; updatedBy: string; updatedAt: number; tickets: Ticket[] }
type Bound = { id: number; valid: boolean; tabId: string; tabName: string; updatedComponents: string[]; boundRev: number; currentRev: number | null; date: string; content: string }
type Detail = { batch: Batch; items: Item[]; bindings: Bound[]; check: ReleaseCheck }
type Revision = { entity: string; entityId: string; rev: number; action: string; actor: string; at: number; snapshot: unknown }
type ReleaseOption = { id: number; rev: number; tabId: string; tabName: string; date: string; content: string }
type ApiResult<T> = T & { ok: boolean; message?: string; errors?: Record<string, string>; code?: string }

async function api<T>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  return r.json().catch(() => ({ ok: false, message: `伺服器回 ${r.status}` }))
}

const fmtTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean) ?? ''
const latestTicket = (i: Item): Ticket | undefined => i.tickets[i.tickets.length - 1]
const ACTION_LABEL: Record<string, string> = { create: '新增', update: '修改', delete: '刪除', import: '從 Lark 匯入', bind: '綁定版本紀錄', unbind: '解除綁定', release: '標記已上正式', revise: '上正式後修訂' }
const EMPTY_ITEM: ItemInput = { platform: '', type: '', description: '', env: '', result: '', okCount: 0, verifier: '', attachments: '', remark: '' }

/** 開單設定：記住個人上次的選擇（只存在這台瀏覽器） */
type TicketPrefs = { space: 'test' | 'prod'; typeKey: string; values: Record<string, string> }
const PREFS_KEY = 'osm-verify-ticket-prefs'
function loadPrefs(): TicketPrefs {
  try { const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null'); if (v && (v.space === 'test' || v.space === 'prod')) return { space: v.space, typeKey: String(v.typeKey ?? ''), values: v.values ?? {} } } catch { /* */ }
  return { space: 'prod', typeKey: '', values: {} }
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`ovf-chip ovf-chip--${tone}`}>{children}</span>
}

export function OsmVerifyPage() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [loadError, setLoadError] = useState('')
  const [batches, setBatches] = useState<Batch[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null)
  const [checked, setChecked] = useState<number[]>([])
  const [busyIds, setBusyIds] = useState<number[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  const [prefs, setPrefs] = useState<TicketPrefs>(loadPrefs)
  const [types, setTypes] = useState<{ key: string; name: string }[] | null>(null)
  const [schema, setSchema] = useState<TypeCreateSchema | null>(null)
  const [schemaMsg, setSchemaMsg] = useState('')
  const [modal, setModal] = useState<null | { kind: 'batch'; batch: Batch | null } | { kind: 'item'; item: Item | null } | { kind: 'revisions' } | { kind: 'bind' } | { kind: 'settings' } | { kind: 'import' }>(null)

  const perms = meta?.perms ?? { view: false, edit: false, manage: false }
  const space = meta?.isAdmin ? prefs.space : 'prod'   // 測試空間只給管理員（沿用 Meegle 開單慣例）

  const loadBatches = async () => {
    const j = await api<{ batches: Batch[] }>('GET', '/api/osm-verify/batches')
    if (j.ok) setBatches(j.batches)
    return j.ok ? j.batches : []
  }
  const loadDetail = async (id: string) => {
    if (!id) { setDetail(null); return }
    const j = await api<Detail>('GET', `/api/osm-verify/batches/${id}`)
    if (j.ok) setDetail({ batch: j.batch, items: j.items, bindings: j.bindings, check: j.check })
    else setFlash({ ok: false, text: j.message ?? '讀取批次失敗' })
  }
  /** 後端操作回來都帶最新的批次內容，直接換上；批次清單另外重讀（計數會變） */
  const applyDetail = (j: Partial<Detail>) => {
    if (j.batch && j.items && j.bindings && j.check) setDetail({ batch: j.batch, items: j.items, bindings: j.bindings, check: j.check })
    void loadBatches()
  }

  useEffect(() => {
    void (async () => {
      const m = await api<Meta>('GET', '/api/osm-verify/meta')
      if (!m.ok) { setLoadError(m.message ?? '讀取失敗'); return }
      setMeta(m)
      const list = await loadBatches()
      if (list[0]) setSelectedId(list[0].id)
    })()
  }, [])
  useEffect(() => { setChecked([]); void loadDetail(selectedId) }, [selectedId])
  useEffect(() => { if (flash?.ok) { const t = setTimeout(() => setFlash(null), 3500); return () => clearTimeout(t) } }, [flash])
  useEffect(() => { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) }, [prefs])

  // 開單設定：打開面板時讀類型、選了類型讀必填欄位
  // 類型清單：打開面板、或已記住類型（工具列要顯示名稱）時讀；schema 不跟著面板收合清掉，收起來照樣能逐列開單
  const wantTypes = perms.edit && (panelOpen || !!prefs.typeKey)
  useEffect(() => {
    if (!wantTypes) return
    setTypes(null)
    void api<{ types: { key: string; name: string }[] }>('GET', `/api/osm-verify/meegle/types?space=${space}`).then(j => {
      if (j.ok) setTypes(j.types)
      else { setTypes([]); setSchemaMsg(j.message ?? '讀取類型失敗') }
    })
  }, [wantTypes, space])
  useEffect(() => {
    setSchema(null)
    if (!perms.edit || !prefs.typeKey) return
    setSchemaMsg('讀取欄位中…')
    void api<{ schema: TypeCreateSchema }>('GET', `/api/osm-verify/meegle/schema?space=${space}&type=${encodeURIComponent(prefs.typeKey)}`).then(j => {
      if (j.ok) { setSchema(j.schema); setSchemaMsg('') } else setSchemaMsg(j.message ?? '讀取欄位失敗')
    })
  }, [perms.edit, space, prefs.typeKey])

  const createCheck = useMemo(() => (schema ? resolveCreateValues(schema, prefs.values) : null), [schema, prefs.values])
  const ticketReady = !!schema && !!createCheck && Object.keys(createCheck.errors).length === 0

  const sendTickets = async (itemIds: number[], mode: 'create' | 'resend' | 'again' = 'create') => {
    if (!ticketReady) { setPanelOpen(true); setFlash({ ok: false, text: '請先在「開單設定」選好類型並填完必填欄位' }); return }
    setBusyIds(b => [...b, ...itemIds])
    const j = await api<Partial<Detail> & { results: { itemId: number; ok: boolean; status?: string; message?: string }[]; schema?: TypeCreateSchema }>('POST', '/api/osm-verify/tickets', { itemIds, mode, space, typeKey: prefs.typeKey, values: prefs.values })
    setBusyIds(b => b.filter(x => !itemIds.includes(x)))
    if (!j.ok) { if (j.schema) setSchema(j.schema); setFlash({ ok: false, text: j.message ?? '開單失敗' }); return }
    applyDetail(j)
    const ok = j.results.filter(r => r.ok).length
    const bad = j.results.filter(r => !r.ok)
    setFlash({ ok: bad.length === 0, text: bad.length ? `${ok}/${j.results.length} 列開單成功；其他：${bad.map(r => r.message).filter(Boolean).slice(0, 3).join('；')}` : `${ok} 列開單成功` })
    setChecked(c => c.filter(x => !j.results.some(r => r.ok && r.itemId === x)))
  }
  const lookup = async (t: Ticket, itemId: number) => {
    setBusyIds(b => [...b, itemId])
    const j = await api<Partial<Detail> & { result: string }>('POST', `/api/osm-verify/tickets/${t.id}/lookup`)
    setBusyIds(b => b.filter(x => x !== itemId))
    if (!j.ok) { setFlash({ ok: false, text: j.message ?? '到遠端查失敗' }); return }
    applyDetail(j)
    setFlash({ ok: j.result === 'created', text: j.result === 'created' ? '遠端找到這張單，已改成已開單' : j.result === 'multiple' ? '遠端找到多張帶同一把 key 的單，請到 Meegle 確認' : '遠端查無；沒有重送，請選「確認重送」或「再開一張」' })
  }

  const markReleased = async () => {
    if (!detail) return
    const j = await api<Partial<Detail>>('POST', `/api/osm-verify/batches/${detail.batch.id}/release`, { rev: detail.batch.rev })
    if (!j.ok) { setFlash({ ok: false, text: j.message ?? '標記失敗' }); if (j.code === 'CONFLICT') void loadDetail(detail.batch.id); return }
    applyDetail(j)
    setFlash({ ok: true, text: `${detail.batch.name} 已標記上正式，OSM QA agent 下次拉事件時會開始學習` })
  }
  const unbind = async (releaseId: number) => {
    if (!detail) return
    const j = await api<Partial<Detail>>('DELETE', `/api/osm-verify/batches/${detail.batch.id}/releases/${releaseId}`)
    if (!j.ok) { setFlash({ ok: false, text: j.message ?? '解除失敗' }); return }
    applyDetail(j)
  }
  const deleteItem = async (it: Item) => {
    if (!confirm(`刪除這個驗證項目？\n${firstLine(it.description)}`)) return
    const j = await api<Partial<Detail>>('DELETE', `/api/osm-verify/items/${it.id}?rev=${it.rev}`)
    if (!j.ok) { setFlash({ ok: false, text: j.message ?? '刪除失敗' }); if (j.code === 'CONFLICT' && detail) void loadDetail(detail.batch.id); return }
    applyDetail(j)
  }
  const deleteBatch = async (b: Batch) => {
    if (!confirm(`刪除批次 ${b.name}？（軟刪除，修改履歷保留）`)) return
    const j = await api<object>('DELETE', `/api/osm-verify/batches/${b.id}?rev=${b.rev}`)
    if (!j.ok) { setFlash({ ok: false, text: j.message ?? '刪除失敗' }); return }
    setModal(null)
    const list = await loadBatches()
    setSelectedId(list[0]?.id ?? '')
  }

  if (loadError) return <div className="ovf-page"><div className="ovf-card ovf-msg ovf-msg--bad">{loadError}</div></div>
  if (!meta) return <div className="ovf-page"><div className="ovf-muted">讀取中…</div></div>

  const b = detail?.batch
  const items = detail?.items ?? []
  const allChecked = items.length > 0 && items.every(i => checked.includes(i.id))
  const released = b?.publishStatus === 'released'

  return (
    <div className="ovf-page">
      <PageActions className="ovf-head">
        <div className="ovf-head-actions">
          {perms.edit && <button className="ovf-btn ovf-btn--primary submit-btn lst-btn" onClick={() => setModal({ kind: 'batch', batch: null })}>＋ 新增批次</button>}
          {perms.manage && <button className="ovf-btn btn-ghost lst-btn" onClick={() => setModal({ kind: 'import' })}>匯入</button>}
          {perms.manage && <button className="ovf-btn btn-ghost lst-btn" onClick={() => setModal({ kind: 'settings' })}>管理設定</button>}
        </div>
      </PageActions>

      {flash && <div className={`ovf-flash ${flash.ok ? 'ovf-flash--ok' : 'ovf-flash--bad'}`} onClick={() => setFlash(null)}>{flash.text}</div>}

      {/* 批次清單 */}
      <div className="ovf-card ovf-batches">
        {batches.length === 0 ? <div className="ovf-empty">還沒有任何批次{perms.edit ? '，按右上「新增批次」開始' : ''}</div> : (
          <table className="ovf-table">
            <thead><tr><th>批次</th><th>發布狀態</th><th>學習狀態</th><th className="ovf-num">綁定版本紀錄</th><th className="ovf-num">驗證項目</th><th>正式版本快照</th><th>最後修改</th></tr></thead>
            <tbody>
              {batches.map(x => (
                <tr key={x.id} className={x.id === selectedId ? 'is-on' : ''} onClick={() => setSelectedId(x.id)}>
                  <td className="ovf-mono"><b>{x.name}</b></td>
                  <td><Chip tone={x.publishStatus}>{PUBLISH_LABEL[x.publishStatus]}</Chip></td>
                  <td><Chip tone={`learn-${x.learnStatus}`}>{LEARN_LABEL[x.learnStatus]}</Chip></td>
                  <td className="ovf-num">{x.bindingCount}</td>
                  <td className="ovf-num">{x.itemCount}</td>
                  <td className="ovf-mono ovf-clip" title={x.prodVersion}>{x.prodVersion ? x.prodVersion.split('\n').join('・') : <span className="ovf-muted">未填</span>}</td>
                  <td className="ovf-muted ovf-small ovf-nowrap">{fmtTime(x.updatedAt)}・{x.updatedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {b && detail && (
        <>
          {/* 批次標題列 */}
          <div className="ovf-titlebar">
            <div className="ovf-title">
              <b className="ovf-mono">{b.name}</b>
              <Chip tone={b.publishStatus}>{PUBLISH_LABEL[b.publishStatus]}</Chip>
              <Chip tone={`learn-${b.learnStatus}`}>學習：{LEARN_LABEL[b.learnStatus]}</Chip>
              {b.releasedAt && <span className="ovf-muted ovf-small">{fmtTime(b.releasedAt)} 由 {b.releasedBy} 標記上正式</span>}
            </div>
            <div className="ovf-actions">
              <button className="ovf-btn" onClick={() => setModal({ kind: 'revisions' })}>修改履歷</button>
              {perms.edit && <button className="ovf-btn" onClick={() => setModal({ kind: 'batch', batch: b })}>編輯批次</button>}
              {perms.manage && !released && (
                <button className="ovf-btn ovf-btn--primary" disabled={!detail.check.ok} title={detail.check.ok ? '' : '上正式檢查還沒過'} onClick={() => void markReleased()}>標記已上正式</button>
              )}
            </div>
          </div>

          {/* 上正式檢查 */}
          <div className={`ovf-card ovf-check ${detail.check.ok ? 'is-ok' : 'is-bad'}`}>
            <div className="ovf-check-head">
              <b>上正式檢查</b>
              <span className={detail.check.ok ? 'ovf-ok' : 'ovf-bad'}>{detail.check.ok ? '通過' : '未通過'}</span>
              <span className="ovf-grow" />
              {perms.edit && <button className="ovf-btn" onClick={() => setModal({ kind: 'bind' })}>綁定版本紀錄</button>}
            </div>
            {!detail.check.ok && (
              <ul className="ovf-check-list">
                {detail.check.missingBinding && <li>缺少版本綁定：至少要綁一筆有效的版本紀錄</li>}
                {detail.check.invalidReleaseIds.length > 0 && <li>綁定的版本紀錄已被刪除：#{detail.check.invalidReleaseIds.join('、#')}</li>}
                {detail.check.noItems && <li>還沒有驗證項目</li>}
                {detail.check.itemsWithoutPlatform > 0 && <li>{detail.check.itemsWithoutPlatform} 個項目沒填平台</li>}
                {detail.check.uncovered.length > 0 && <li>未涵蓋的平台／元件：{detail.check.uncovered.map(p => <span key={p} className="ovf-tag">{p}</span>)}<span className="ovf-muted ovf-small">（綁定涵蓋它的版本紀錄，或請管理者在「管理設定」設定平台對應）</span></li>}
              </ul>
            )}
            {detail.bindings.length > 0 && (
              <div className="ovf-bound">
                {detail.bindings.map(r => (
                  <div key={r.id} className={`ovf-bound-row ${r.valid ? '' : 'is-gone'}`}>
                    <span className="ovf-mono">#{r.id}</span>
                    <span>{r.valid ? r.tabName : '已刪除'}</span>
                    <span className="ovf-mono ovf-muted">{r.date}</span>
                    <span className="ovf-clip ovf-grow">{r.content || r.updatedComponents.join('、')}</span>
                    {r.valid && r.currentRev !== r.boundRev && <span className="ovf-warn ovf-small">綁定後被改過（第 {r.boundRev} → {r.currentRev} 版）</span>}
                    {perms.edit && <button className="ovf-link ovf-small" onClick={() => void unbind(r.id)}>解除</button>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 驗證項目 */}
          <div className="ovf-card ovf-items">
            {perms.edit && (
              <div className="ovf-toolbar">
                <button className="ovf-btn" onClick={() => setModal({ kind: 'item', item: null })}>＋ 新增項目</button>
                <button className={`ovf-btn ${panelOpen ? 'is-on' : ''}`} onClick={() => setPanelOpen(o => !o)}>開單設定{!panelOpen && prefs.typeKey ? `：${types?.find(t => t.key === prefs.typeKey)?.name ?? '…'}` : ''}</button>
                <button className="ovf-btn ovf-btn--primary" disabled={!checked.length} onClick={() => void sendTickets(checked)}>勾選列開單{checked.length ? `（${checked.length}）` : ''}</button>
                <span className="ovf-muted ovf-small">按下即送出、用你自己綁定的 Meegle 帳號；逐列回報結果</span>
              </div>
            )}
            {perms.edit && panelOpen && (
              <div className="ovf-panel">
                {meta.isAdmin && (
                  <label className="ovf-field"><span>空間</span>
                    <select className="ovf-input" value={prefs.space} onChange={e => setPrefs(p => ({ ...p, space: e.target.value as 'test' | 'prod', typeKey: '', values: {} }))}>
                      <option value="prod">正式</option><option value="test">測試</option>
                    </select>
                  </label>
                )}
                <label className="ovf-field"><span>類型</span>
                  <select className="ovf-input" value={prefs.typeKey} onChange={e => setPrefs(p => ({ ...p, typeKey: e.target.value }))} disabled={!types}>
                    <option value="">{types ? '選擇工作項類型' : '讀取中…'}</option>
                    {(types ?? []).map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
                  </select>
                </label>
                {schema?.fields.map(f => (
                  <label key={f.key} className="ovf-field"><span>{f.kind === 'template' ? '模板' : f.name}</span>
                    {f.options ? (
                      <select className={`ovf-input ${createCheck?.errors[f.key] ? 'is-bad' : ''}`} value={prefs.values[f.key] ?? ''} onChange={e => setPrefs(p => ({ ...p, values: { ...p.values, [f.key]: e.target.value } }))}>
                        <option value="">請選擇</option>
                        {f.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    ) : (
                      <input className={`ovf-input ${createCheck?.errors[f.key] ? 'is-bad' : ''}`} value={prefs.values[f.key] ?? ''} placeholder={f.kind === 'related' ? '單號（數字）' : ''} onChange={e => setPrefs(p => ({ ...p, values: { ...p.values, [f.key]: e.target.value } }))} />
                    )}
                  </label>
                ))}
                <div className="ovf-panel-note">
                  {schemaMsg && <span className="ovf-muted">{schemaMsg}</span>}
                  {schema && schema.unsupported.length > 0 && <span className="ovf-bad">這個類型有工具不支援的必填欄位：{schema.unsupported.join('、')}，不能從這裡開單</span>}
                  {schema && !schema.unsupported.length && schema.fields.length === 0 && <span className="ovf-muted">這個類型除了名稱與描述沒有其他必填欄位</span>}
                  {ticketReady && <span className="ovf-ok">設定完成（會記住你這次的選擇）</span>}
                </div>
              </div>
            )}
            {items.length === 0 ? <div className="ovf-empty">還沒有驗證項目</div> : (
              <div className="ovf-scroll">
                <table className="ovf-table ovf-table--items">
                  <thead>
                    <tr>
                      {perms.edit && <th className="ovf-cb"><input type="checkbox" checked={allChecked} onChange={e => setChecked(e.target.checked ? items.map(i => i.id) : [])} aria-label="全選" /></th>}
                      <th>平台</th><th>類型</th><th>描述</th><th>驗證環境</th><th>結果</th><th className="ovf-num">OK 數量</th><th>驗證人</th><th>附件</th><th>備註</th><th>開單狀態</th><th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => {
                      const t = latestTicket(it)
                      const busy = busyIds.includes(it.id) || t?.status === 'pending'
                      return (
                        <Fragment key={it.id}>
                          <tr className={t?.status === 'unknown' ? 'has-hint' : ''}>
                            {perms.edit && <td className="ovf-cb"><input type="checkbox" checked={checked.includes(it.id)} onChange={e => setChecked(c => e.target.checked ? [...c, it.id] : c.filter(x => x !== it.id))} aria-label="勾選" /></td>}
                            <td className="ovf-nowrap">{it.platform}</td>
                            <td className="ovf-nowrap">{it.type}</td>
                            <td className="ovf-desc">{it.description}</td>
                            <td>{it.env}</td>
                            <td>{it.result}</td>
                            <td className="ovf-num">{it.okCount}</td>
                            <td>{it.verifier}</td>
                            <td className="ovf-pre ovf-small">{it.attachments}</td>
                            <td className="ovf-pre ovf-small">{it.remark}</td>
                            <td className="ovf-nowrap">
                              {!t ? <span className="ovf-muted">未開單</span> : (
                                <>
                                  <Chip tone={`t-${t.status}`}>{TICKET_LABEL[t.status]}</Chip>
                                  {t.workItemId && (t.url ? <a className="ovf-tk" href={t.url} target="_blank" rel="noreferrer">#{t.workItemId}</a> : <span className="ovf-tk">#{t.workItemId}</span>)}
                                  {t.status === 'failed' && t.message && <div className="ovf-bad ovf-small ovf-msgline" title={t.message}>{t.message}</div>}
                                </>
                              )}
                            </td>
                            <td className="ovf-nowrap">
                              {perms.edit && (busy ? <span className="ovf-muted ovf-small">開單中…</span> : (
                                <>
                                  {(!t || t.status === 'failed') && <button className="ovf-btn ovf-btn--sm ovf-btn--primary" onClick={() => void sendTickets([it.id])}>{t ? '重試' : '開單'}</button>}
                                  {t?.status === 'created' && <button className="ovf-link ovf-small" onClick={() => void sendTickets([it.id], 'again')}>再開一張</button>}
                                </>
                              ))}
                              {perms.edit && <button className="ovf-link ovf-small" onClick={() => setModal({ kind: 'item', item: it })}>編輯</button>}
                              {perms.manage && <button className="ovf-link ovf-small ovf-danger" onClick={() => void deleteItem(it)}>刪除</button>}
                            </td>
                          </tr>
                          {t?.status === 'unknown' && (
                            <tr className="ovf-hint-row">
                              <td colSpan={perms.edit ? 12 : 11}>
                                <span className="ovf-warn">開單結果不明</span>
                                <span className="ovf-muted ovf-small">{t.message || 'Meegle 沒有明確回應，單可能已經開了'}・key <span className="ovf-mono">{t.key}</span>・不會自動重送</span>
                                {perms.edit && !busy && (
                                  <span className="ovf-hint-actions">
                                    <button className="ovf-btn ovf-btn--sm" onClick={() => void lookup(t, it.id)}>到遠端查</button>
                                    <button className="ovf-btn ovf-btn--sm" onClick={() => void sendTickets([it.id], 'resend')}>確認重送</button>
                                    <button className="ovf-btn ovf-btn--sm" onClick={() => void sendTickets([it.id], 'again')}>再開一張</button>
                                  </span>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {modal?.kind === 'batch' && <BatchModal batch={modal.batch} canDelete={perms.manage} onClose={() => setModal(null)} onDelete={b2 => void deleteBatch(b2)}
        onSaved={(j, id) => { setModal(null); applyDetail(j); if (id) setSelectedId(id); setFlash({ ok: true, text: '已儲存' }) }} onConflict={() => b && void loadDetail(b.id)} />}
      {modal?.kind === 'item' && b && <ItemModal batchId={b.id} item={modal.item} onClose={() => setModal(null)} onSaved={j => { setModal(null); applyDetail(j) }} onConflict={() => void loadDetail(b.id)} />}
      {modal?.kind === 'revisions' && b && <RevisionsModal batch={b} onClose={() => setModal(null)} />}
      {modal?.kind === 'bind' && b && detail && <BindModal batchId={b.id} bound={detail.bindings.map(x => x.id)} onClose={() => setModal(null)} onSaved={j => { applyDetail(j) }} />}
      {modal?.kind === 'settings' && <SettingsModal meta={meta} onClose={() => setModal(null)} onSaved={m => { setMeta(m); if (b) void loadDetail(b.id) }} />}
      {modal?.kind === 'import' && <ImportModal onClose={() => setModal(null)} onDone={async () => { const list = await loadBatches(); if (!selectedId && list[0]) setSelectedId(list[0].id); else if (selectedId) void loadDetail(selectedId) }} />}
    </div>
  )
}

// ─── 彈窗 ────────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return createPortal(
    <div className="ovf-portal ovf-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`ovf-modal ${wide ? 'ovf-modal--wide' : ''}`} role="dialog" aria-label={title}>
        <div className="ovf-modal-head"><b>{title}</b><button className="ovf-x-btn" onClick={onClose} aria-label="關閉">✕</button></div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

function BatchModal({ batch, canDelete, onClose, onSaved, onConflict, onDelete }: { batch: Batch | null; canDelete: boolean; onClose: () => void; onSaved: (j: Partial<Detail>, id?: string) => void; onConflict: () => void; onDelete: (b: Batch) => void }) {
  const now = new Date()
  const [year, setYear] = useState(batch?.year ?? now.getFullYear())
  const [code, setCode] = useState(batch?.batch ?? `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`)
  const [status, setStatus] = useState<'draft' | 'verified'>(batch && batch.publishStatus !== 'released' ? batch.publishStatus : 'draft')
  const [prodVersion, setProdVersion] = useState(batch?.prodVersion ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const input = { year: Number(year), batch: code, publishStatus: status, prodVersion }
    const e = validateBatch(input)
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    const j = batch
      ? await api<Partial<Detail>>('PUT', `/api/osm-verify/batches/${batch.id}`, { ...input, rev: batch.rev })
      : await api<Partial<Detail> & { id: string }>('POST', '/api/osm-verify/batches', input)
    setSaving(false)
    if (!j.ok) { setMsg(j.message ?? '儲存失敗'); setErrors(j.errors ?? {}); if (j.code === 'CONFLICT') onConflict(); return }
    onSaved(j, 'id' in j ? (j as { id: string }).id : undefined)
  }
  return (
    <Modal title={batch ? `編輯批次 ${batch.name}` : '新增批次'} onClose={onClose}>
      <div className="ovf-form">
        <label className="ovf-field"><span>年份</span><input className={`ovf-input ${errors.year ? 'is-bad' : ''}`} type="number" value={year} onChange={e => setYear(Number(e.target.value))} /></label>
        <label className="ovf-field"><span>批次</span><input className={`ovf-input ${errors.batch ? 'is-bad' : ''}`} value={code} onChange={e => setCode(e.target.value)} placeholder="1120" /></label>
        <div className="ovf-muted ovf-small">顯示名稱：<span className="ovf-mono">{year}-{code.trim()}</span>（帶年份，避免跨年同一個日期覆寫）</div>
        {errors.batch && <div className="ovf-err">{errors.batch}</div>}
        {batch?.publishStatus === 'released'
          ? <div className="ovf-muted ovf-small">已上正式，發布狀態不能改回；修改會通知 OSM QA agent 重新學習</div>
          : (
            <label className="ovf-field"><span>發布狀態</span>
              <select className="ovf-input" value={status} onChange={e => setStatus(e.target.value as 'draft' | 'verified')}>
                <option value="draft">{PUBLISH_LABEL.draft}</option><option value="verified">{PUBLISH_LABEL.verified}</option>
              </select>
            </label>
          )}
        <label className="ovf-field ovf-field--block"><span>正式環境版本快照</span>
          <textarea className="ovf-input ovf-mono" rows={5} value={prodVersion} onChange={e => setProdVersion(e.target.value)} placeholder={'Center Server:2.1.112\nGame Client New:1.5.93.9'} />
        </label>
        {msg && <div className="ovf-err">{msg}</div>}
      </div>
      <div className="ovf-modal-foot">
        {batch && canDelete && batch.publishStatus !== 'released' ? <button className="ovf-btn ovf-btn--danger" onClick={() => onDelete(batch)}>刪除批次</button> : <span />}
        <span className="ovf-actions">
          <button className="ovf-btn" onClick={onClose}>取消</button>
          <button className="ovf-btn ovf-btn--primary" disabled={saving} onClick={() => void save()}>{saving ? '儲存中…' : '儲存'}</button>
        </span>
      </div>
    </Modal>
  )
}

function ItemModal({ batchId, item, onClose, onSaved, onConflict }: { batchId: string; item: Item | null; onClose: () => void; onSaved: (j: Partial<Detail>) => void; onConflict: () => void }) {
  const [v, setV] = useState<ItemInput>(item ? { platform: item.platform, type: item.type, description: item.description, env: item.env, result: item.result, okCount: item.okCount, verifier: item.verifier, attachments: item.attachments, remark: item.remark } : EMPTY_ITEM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k: keyof ItemInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(x => ({ ...x, [k]: k === 'okCount' ? Number(e.target.value) : e.target.value }))
  const save = async () => {
    const e = validateItem(v)
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    const j = item
      ? await api<Partial<Detail>>('PUT', `/api/osm-verify/items/${item.id}`, { ...v, rev: item.rev })
      : await api<Partial<Detail>>('POST', `/api/osm-verify/batches/${batchId}/items`, v)
    setSaving(false)
    if (!j.ok) { setMsg(j.message ?? '儲存失敗'); setErrors(j.errors ?? {}); if (j.code === 'CONFLICT') onConflict(); return }
    onSaved(j)
  }
  const field = (k: keyof ItemInput, label: string, opts: { area?: boolean; placeholder?: string; type?: string } = {}) => (
    <label className={`ovf-field ${opts.area ? 'ovf-field--block' : ''}`}><span>{label}</span>
      {opts.area
        ? <textarea className={`ovf-input ${errors[k] ? 'is-bad' : ''}`} rows={3} value={String(v[k])} onChange={set(k)} placeholder={opts.placeholder} />
        : <input className={`ovf-input ${errors[k] ? 'is-bad' : ''}`} type={opts.type ?? 'text'} value={String(v[k])} onChange={set(k)} placeholder={opts.placeholder} />}
      {errors[k] && <span className="ovf-err">{errors[k]}</span>}
    </label>
  )
  return (
    <Modal title={item ? '編輯驗證項目' : '新增驗證項目'} onClose={onClose} wide>
      <div className="ovf-form ovf-form--grid">
        {field('platform', '平台', { placeholder: 'H5,PC,Middle（多個用逗號）' })}
        {field('type', '類型', { placeholder: 'OSM' })}
        {field('env', '驗證環境', { placeholder: 'QAT／UAT' })}
        {field('result', '結果', { placeholder: '驗證通過／無法測試' })}
        {field('okCount', 'OK 數量', { type: 'number' })}
        {field('verifier', '驗證人')}
      </div>
      <div className="ovf-form">
        {field('description', '描述', { area: true })}
        {field('attachments', '附件', { area: true, placeholder: '連結，一行一個' })}
        {field('remark', '備註', { area: true })}
        {msg && <div className="ovf-err">{msg}</div>}
      </div>
      <div className="ovf-modal-foot">
        <span className="ovf-muted ovf-small">{item ? `第 ${item.rev} 版・${item.updatedBy}` : ''}</span>
        <span className="ovf-actions">
          <button className="ovf-btn" onClick={onClose}>取消</button>
          <button className="ovf-btn ovf-btn--primary" disabled={saving} onClick={() => void save()}>{saving ? '儲存中…' : '儲存'}</button>
        </span>
      </div>
    </Modal>
  )
}

function RevisionsModal({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const [list, setList] = useState<Revision[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { void api<{ revisions: Revision[] }>('GET', `/api/osm-verify/batches/${batch.id}/revisions`).then(j => (j.ok ? setList(j.revisions) : setError(j.message ?? '讀取失敗'))) }, [batch.id])
  return (
    <Modal title={`修改履歷・${batch.name}`} onClose={onClose} wide>
      {error && <div className="ovf-err">{error}</div>}
      {!list ? <div className="ovf-muted">讀取中…</div> : list.length === 0 ? <div className="ovf-muted">沒有紀錄</div> : (
        <div className="ovf-revs">
          {list.map((r, i) => (
            <div key={i} className="ovf-rev">
              <button className="ovf-link ovf-rev-head" onClick={() => setOpen(open === i ? null : i)}>
                <span className="ovf-mono ovf-muted">{fmtTime(r.at)}</span>
                <span>{r.actor}</span>
                <span>{ACTION_LABEL[r.action] ?? r.action}{r.entity === 'item' ? ` 項目 #${r.entityId}` : ''}</span>
                <span className="ovf-muted">第 {r.rev} 版</span>
              </button>
              {open === i && <pre className="ovf-pre ovf-rev-body">{JSON.stringify(r.snapshot, null, 2)}</pre>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

function BindModal({ batchId, bound, onClose, onSaved }: { batchId: string; bound: number[]; onClose: () => void; onSaved: (j: Partial<Detail>) => void }) {
  const [list, setList] = useState<ReleaseOption[] | null>(null)
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState('')
  const [done, setDone] = useState<number[]>(bound)
  useEffect(() => { void api<{ releases: ReleaseOption[] }>('GET', '/api/osm-verify/releases').then(j => (j.ok ? setList(j.releases) : setMsg(j.message ?? '讀取失敗'))) }, [])
  const shown = (list ?? []).filter(r => !q.trim() || `${r.tabName} ${r.date} ${r.content} #${r.id}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80)
  const bind = async (id: number) => {
    const j = await api<Partial<Detail>>('POST', `/api/osm-verify/batches/${batchId}/releases`, { releaseId: id })
    if (!j.ok) { setMsg(j.message ?? '綁定失敗'); return }
    setDone(d => [...d, id]); onSaved(j)
  }
  return (
    <Modal title="綁定版本紀錄" onClose={onClose} wide>
      <input className="ovf-input ovf-full" placeholder="搜尋分頁、日期、內容、#編號" value={q} onChange={e => setQ(e.target.value)} />
      {msg && <div className="ovf-err">{msg}</div>}
      {!list ? <div className="ovf-muted">讀取中…</div> : (
        <div className="ovf-pick">
          {shown.map(r => (
            <div key={r.id} className="ovf-pick-row">
              <span className="ovf-mono">#{r.id}</span><span>{r.tabName}</span><span className="ovf-mono ovf-muted">{r.date}</span>
              <span className="ovf-clip ovf-grow">{r.content}</span>
              {done.includes(r.id) ? <span className="ovf-ok ovf-small">已綁定</span> : <button className="ovf-btn ovf-btn--sm" onClick={() => void bind(r.id)}>綁定</button>}
            </div>
          ))}
          {shown.length === 0 && <div className="ovf-muted">沒有符合的版本紀錄</div>}
        </div>
      )}
    </Modal>
  )
}

function SettingsModal({ meta, onClose, onSaved }: { meta: Meta; onClose: () => void; onSaved: (m: Meta) => void }) {
  const toText = (m: PlatformMap) => Object.entries(m).map(([k, v]) => `${k} = ${v.join(', ')}`).join('\n')
  const [mapText, setMapText] = useState(toText(meta.platformMap))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [key, setKey] = useState('')
  const [configured, setConfigured] = useState(!!meta.eventKeyConfigured)
  const parse = (): PlatformMap | string => {
    const out: PlatformMap = {}
    for (const [n, raw] of mapText.split('\n').entries()) {
      const line = raw.trim()
      if (!line) continue
      const m = /^(.+?)\s*=\s*(.+)$/.exec(line)
      if (!m) return `第 ${n + 1} 行格式要是「平台 = 分頁id 或 分頁id/元件名稱, …」`
      out[m[1].trim()] = m[2].split(/[,，]/).map(s => s.trim()).filter(Boolean)
    }
    return out
  }
  const saveMap = async () => {
    const map = parse()
    if (typeof map === 'string') { setMsg({ ok: false, text: map }); return }
    const j = await api<{ platformMap: PlatformMap }>('PUT', '/api/osm-verify/settings/platform-map', { map })
    if (!j.ok) { setMsg({ ok: false, text: j.message ?? '儲存失敗' }); return }
    setMsg({ ok: true, text: '平台對應已儲存' }); onSaved({ ...meta, platformMap: j.platformMap })
  }
  const regen = async () => {
    if (configured && !confirm('重新產生後舊金鑰立即失效，OSM QA agent 要換上新金鑰才拉得到事件。確定？')) return
    const j = await api<{ key: string }>('POST', '/api/osm-verify/settings/event-key')
    if (!j.ok) { setMsg({ ok: false, text: j.message ?? '產生失敗' }); return }
    setKey(j.key); setConfigured(true)
  }
  return (
    <Modal title="管理設定" onClose={onClose} wide>
      <div className="ovf-section">
        <b>平台對應</b>
        <div className="ovf-muted ovf-small">上正式檢查用：一行一個平台，右邊列出涵蓋它的版本紀錄分頁 id，或「分頁id/元件名稱」（該元件要有更新才算）。沒設的平台只認跟分頁或元件完全同名。</div>
        <textarea className="ovf-input ovf-mono ovf-full" rows={7} value={mapText} onChange={e => setMapText(e.target.value)} placeholder={'H5 = osm/H5 Client\nOSM後台 = osm/BG Client\nCenter = toppath'} />
        <div><button className="ovf-btn ovf-btn--primary" onClick={() => void saveMap()}>儲存平台對應</button></div>
      </div>
      <div className="ovf-section">
        <b>事件 API 金鑰</b>
        <div className="ovf-muted ovf-small">給 OSM QA agent 拉學習事件用（Authorization: Bearer）。伺服器只存雜湊，明文只在產生當下顯示這一次。目前：{configured ? '已設定' : '尚未設定'}</div>
        {key && <div className="ovf-key"><span className="ovf-mono">{key}</span><button className="ovf-btn ovf-btn--sm" onClick={() => void navigator.clipboard?.writeText(key)}>複製</button><div className="ovf-warn ovf-small">關掉這個視窗後就看不到了，請立刻交給 agent 的設定</div></div>}
        <div><button className="ovf-btn" onClick={() => void regen()}>{configured ? '重新產生金鑰' : '產生金鑰'}</button></div>
      </div>
      {msg && <div className={msg.ok ? 'ovf-ok' : 'ovf-err'}>{msg.text}</div>}
    </Modal>
  )
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<{ section: number; batch?: string; added: number; skipped: number; tickets: number; error?: string }[] | null>(null)
  const [msg, setMsg] = useState('')
  const run = async () => {
    setRunning(true); setMsg('')
    const j = await api<{ results: NonNullable<typeof results> }>('POST', '/api/osm-verify/import', {})
    setRunning(false)
    if (!j.ok) { setMsg(j.message ?? '匯入失敗'); return }
    setResults(j.results); onDone()
  }
  return (
    <Modal title="從 Lark 匯入" onClose={onClose}>
      <div className="ovf-muted ovf-small">讀 Lark「驗證表單_v2」（只讀、不寫回）。表裡每一段表頭匯成一個批次，名稱用該段第一個日期；Meegle 單號一起匯成已開單。重跑只補沒匯過的列。</div>
      {msg && <div className="ovf-err">{msg}</div>}
      {results && (
        <ul className="ovf-check-list">
          {results.map(r => <li key={r.section}>{r.batch ?? `第 ${r.section + 1} 列那段`}：{r.error ? <span className="ovf-muted">略過（{r.error}）</span> : `新增 ${r.added} 筆、略過 ${r.skipped} 筆、單號 ${r.tickets} 張`}</li>)}
        </ul>
      )}
      <div className="ovf-modal-foot"><span /><span className="ovf-actions">
        <button className="ovf-btn" onClick={onClose}>關閉</button>
        <button className="ovf-btn ovf-btn--primary" disabled={running} onClick={() => void run()}>{running ? '匯入中…' : results ? '再跑一次' : '開始匯入'}</button>
      </span></div>
    </Modal>
  )
}

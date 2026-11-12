import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RetargetPlanRow } from '../../../shared/uat-tc-retarget'
import type { AutoScript } from './types'
import { safePost as post } from './batch-retarget-http'

/**
 * 「批次改綁 TC 表格」（v5.82.0，只限 H5／PC 腳本）。版面 CodeX 1112 出圖。
 *
 * 2026-11-12 同事要把自己 30 支 H5 腳本改綁到複製出來的新表（編號相同）。單支彈窗要開 30 次。
 *
 * ⚠️ **只批次套用「每一筆都配上」的腳本。**有任何一筆要人選的（新表沒有、編號重複、沒編號）
 *    一律不勾、按「逐筆處理」轉原本的單支彈窗。人在這裡明確勾選＋確認「採用建議配對」，
 *    CodeX 認定不算自動套用；但總表一定要能展開看舊／新 TC，不能只給一個數字。
 * ⚠️ 伺服器套用時會重撈新表、重算狀態、比對預覽當下的 updatedAt——這裡的預覽結果只是給人看的。
 * ⚠️ 換了網址，舊的預覽一律作廢（不然會拿 A 表的預覽去套 B 表）。
 * ⚠️ 彈窗走 `createPortal`＋自己的 z-index（跟單支彈窗同一個理由，見 TcRetargetDialog.tsx 檔頭）。
 */

type Status = 'ready' | 'needs-review' | 'no-bindings' | 'same-table' | 'forbidden' | 'conflict' | 'not-found' | 'no-owner' | 'plan-changed'

interface PlanScript {
  scriptId: string
  name?: string
  tableId?: string
  updatedAt?: number
  planKey?: string
  status: Status
  rows?: RetargetPlanRow[]
}

interface ApplyResult {
  scriptId: string
  name?: string
  status: Status | 'applied'
  bound?: number
  backupId?: string
}

const STATUS_TEXT: Record<Status | 'applied', string> = {
  'ready': '全部配對',
  'needs-review': '要逐筆處理',
  'no-bindings': '沒綁 TC',
  'same-table': '已經是這張表',
  'forbidden': '不是你的腳本',
  'conflict': '預覽後被修改過',
  'not-found': '找不到腳本',
  'no-owner': '舊腳本沒記擁有者（要管理員）',
  'plan-changed': '新表在預覽後變了，請重新檢查',
  'applied': '已改綁',
}

const STATUS_TONE: Record<Status | 'applied', 'ok' | 'warn' | 'bad' | 'muted'> = {
  'ready': 'ok', 'applied': 'ok',
  'needs-review': 'warn', 'conflict': 'warn', 'plan-changed': 'warn',
  'forbidden': 'bad', 'not-found': 'bad', 'no-owner': 'bad',
  'no-bindings': 'muted', 'same-table': 'muted',
}


function bindingCountOf(script: AutoScript): number {
  try { const v = JSON.parse(script.bindings || '[]'); return Array.isArray(v) ? v.length : 0 } catch { return 0 }
}

export function BatchRetargetDialog({ open, scripts, defaultIds, onClose, onOpenSingle, onApplied }: {
  open: boolean
  scripts: AutoScript[]
  /** 預設勾選的腳本（呼叫端決定：有勾的用勾的，沒有就用「我的」） */
  defaultIds: string[]
  onClose: () => void
  /** 「逐筆處理」：關掉這個、開那一支的單支改綁彈窗 */
  onOpenSingle: (scriptId: string) => void
  /** 有任何一支套用成功 → 外面要重新載入腳本 */
  onApplied: () => void
}) {
  const candidates = useMemo(() => scripts.filter(s => bindingCountOf(s) > 0), [scripts])
  const [picked, setPicked] = useState<string[]>(() => defaultIds.filter(id => candidates.some(s => s.id === id)))
  const [url, setUrl] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<'plan' | 'apply' | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [plan, setPlan] = useState<{ newTableId: string; newTcCount: number; scripts: PlanScript[]; url: string } | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [view, setView] = useState<'all' | 'ready' | 'review'>('all')
  const [confirmed, setConfirmed] = useState(false)
  const [results, setResults] = useState<ApplyResult[] | null>(null)

  /**
   * 改勾選一律走這裡：勾選變了，「我已確認」就要重勾（CodeX 1112 P2：全選曾沿用舊的確認）。
   * ⚠️ 不要直接呼叫 setChosen——batch-retarget-http.test.ts 會檢查。
   */
  const choose = (next: string[] | ((prev: string[]) => string[])) => { setChosen(next); setConfirmed(false) }

  if (!open) return null

  const step = results ? 3 : plan ? 2 : 1
  const q = search.trim().toLowerCase()
  const changeUrl = (v: string) => {
    setUrl(v)
    // 換網址＝舊預覽作廢
    if (plan) { setPlan(null); choose([]); setExpanded(null) }
  }

  const doPlan = async () => {
    setBusy('plan'); setMsg(null); setResults(null)
    const res = await post<{ ok: boolean; message?: string; newTableId?: string; newTcCount?: number; scripts?: PlanScript[] }>(
      '/api/osm-uat/retarget/batch-plan', { scriptIds: picked, newLarkUrl: url.trim() })
    setBusy(null)
    if (!res.ok) { setMsg({ text: res.message ?? '檢查配對失敗', ok: false }); return }
    const list = res.scripts ?? []
    setPlan({ newTableId: res.newTableId ?? '', newTcCount: res.newTcCount ?? 0, scripts: list, url: url.trim() })
    choose(list.filter(s => s.status === 'ready').map(s => s.scriptId))
    setView('all')
  }

  const doApply = async () => {
    if (!plan) return
    const items = plan.scripts
      .filter(s => chosen.includes(s.scriptId) && s.status === 'ready')
      .map(s => ({ scriptId: s.scriptId, expectedUpdatedAt: s.updatedAt, expectedPlanKey: s.planKey }))
    setBusy('apply'); setMsg(null)
    const res = await post<{ ok: boolean; message?: string; applied?: number; results?: ApplyResult[] }>(
      '/api/osm-uat/retarget/batch-apply', { newLarkUrl: plan.url, items })
    setBusy(null)
    if (!res.ok) {
      // ⚠️ 請求本身失敗（逾時、斷線）時伺服器可能已經改了一部分——不要盲目重試。
      //    舊預覽作廢（勾選與確認一起清掉），要重新「檢查配對」，已改好的會顯示「已經是這張表」。
      setMsg({ text: `${res.message ?? '套用失敗'}。結果待確認：請重新「檢查配對」，已改好的會顯示「已經是這張表」。`, ok: false })
      setPlan(null); choose([]); setExpanded(null)
      onApplied()
      return
    }
    setResults(res.results ?? [])
    if ((res.applied ?? 0) > 0) onApplied()
  }

  const planRows = plan?.scripts ?? []
  const nameOf = (s: PlanScript | ApplyResult) => s.name ?? scripts.find(x => x.id === s.scriptId)?.name ?? s.scriptId
  const readyRows = planRows.filter(s => s.status === 'ready')
  const reviewRows = planRows.filter(s => s.status !== 'ready')
  const shownPlan = (view === 'ready' ? readyRows : view === 'review' ? reviewRows : planRows)
    .filter(s => !q || nameOf(s).toLowerCase().includes(q))
  const chosenTcCount = readyRows.filter(s => chosen.includes(s.scriptId)).reduce((n, s) => n + (s.rows?.length ?? 0), 0)
  const unmatchedOf = (s: PlanScript) => (s.rows ?? []).filter(r => r.reason !== 'matched').length

  return createPortal(
    <div className="uat-studio uat-tc-modal uat-retarget-overlay" role="dialog" aria-modal="true" aria-label="批次改綁 TC 表格"
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="uat-tc-picker uat-retarget uat-bulk-retarget">
        <div className="uat-tc-picker-head">
          <div>
            <span className="uat-net-kicker">BULK RETARGET</span>
            <h3>批次改綁 TC 表格</h3>
            <p>先檢查配對，再確認套用；按下套用之前不會改任何腳本。</p>
          </div>
          <button type="button" className="uat-btn is-quiet" disabled={!!busy} onClick={onClose}>關閉</button>
        </div>

        <ol className="uat-bulk-steps">
          <li className={step > 1 ? 'is-done' : step === 1 ? 'is-on' : ''}>選擇腳本</li>
          <li className={step > 2 ? 'is-done' : step === 2 ? 'is-on' : ''}>檢查配對</li>
          <li className={step === 3 ? 'is-on' : ''}>套用結果</li>
        </ol>

        <div className="uat-retarget-body">
          <label className="uat-retarget-url">
            新的 Lark TC 表格網址
            <textarea className="uat-field" rows={2} value={url} disabled={!!busy || !!results}
              onChange={e => changeUrl(e.target.value)} placeholder="https://xxx.larksuite.com/base/...?table=tbl..." />
          </label>

          {msg && <p className={msg.ok ? 'uat-retarget-ok' : 'uat-retarget-bad'} role="status">{msg.text}</p>}

          {/* ── 1. 選擇腳本 ── */}
          {step === 1 && <>
            <div className="uat-bulk-toolbar">
              <input className="uat-field" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋腳本名稱" />
              <button type="button" className="uat-btn is-quiet" onClick={() => setPicked(candidates.map(s => s.id))}>全選</button>
              <button type="button" className="uat-btn is-quiet" onClick={() => setPicked([])}>清除</button>
              <span>{`已選 ${picked.length}／${candidates.length} 支（只列已綁 TC 的）`}</span>
            </div>
            <div className="uat-bulk-pick">
              {candidates.filter(s => !q || s.name.toLowerCase().includes(q)).map(s => (
                <label key={s.id} className="uat-bulk-pick-row">
                  <input type="checkbox" checked={picked.includes(s.id)}
                    onChange={() => setPicked(p => p.includes(s.id) ? p.filter(x => x !== s.id) : [...p, s.id])} />
                  <b>{s.name}</b>
                  <small>{s.table_id || '—'} · 綁 {bindingCountOf(s)} TC · {s.owner_email ? s.owner_email.split('@')[0] : s.created_by}</small>
                </label>
              ))}
              {!candidates.length && <p className="uat-inline-hint">沒有已綁 TC 的腳本。</p>}
            </div>
            <div className="uat-bulk-foot">
              <button type="button" className="uat-btn is-primary" disabled={!picked.length || !url.trim() || !!busy} onClick={() => void doPlan()}>
                {busy === 'plan' ? '讀取新表、比對中…' : `檢查 ${picked.length} 支的配對`}
              </button>
            </div>
          </>}

          {/* ── 2. 檢查配對 ── */}
          {step === 2 && plan && <>
            <div className="uat-bulk-summary">
              <span>目標表 <code>{plan.newTableId}</code>（{plan.newTcCount} 筆 TC）</span>
              <span>已分析 <b>{planRows.length}</b> 支</span>
              <span className="is-ok">全部配對 <b>{readyRows.length}</b></span>
              <span className="is-warn">需處理 <b>{reviewRows.length}</b></span>
            </div>
            <div className="uat-bulk-toolbar">
              <input className="uat-field" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋腳本名稱" />
              <div className="uat-filter-row" role="tablist">
                <button type="button" className={view === 'all' ? 'is-active' : ''} onClick={() => setView('all')}>{`全部 ${planRows.length}`}</button>
                <button type="button" className={view === 'ready' ? 'is-active' : ''} onClick={() => setView('ready')}>{`可套用 ${readyRows.length}`}</button>
                <button type="button" className={view === 'review' ? 'is-active' : ''} onClick={() => setView('review')}>{`需處理 ${reviewRows.length}`}</button>
              </div>
              <button type="button" className="uat-btn is-quiet" onClick={() => choose(readyRows.map(s => s.scriptId))}>選取全部可套用</button>
            </div>
            <table className="uat-retarget-table uat-bulk-table">
              <thead><tr><th /><th>腳本</th><th>目前表格</th><th>已綁</th><th>配對結果</th><th>操作</th></tr></thead>
              <tbody>
                {shownPlan.map(s => {
                  const ready = s.status === 'ready'
                  const total = s.rows?.length ?? 0
                  const pill = ready ? `${total}／${total} 全部配對`
                    : s.status === 'needs-review' ? `${total - unmatchedOf(s)}／${total}・缺 ${unmatchedOf(s)} 筆`
                      : STATUS_TEXT[s.status]
                  return [
                    <tr key={s.scriptId}>
                      <td><input type="checkbox" disabled={!ready} checked={ready && chosen.includes(s.scriptId)}
                        aria-label={`套用：${nameOf(s)}`}
                        onChange={() => choose(c => c.includes(s.scriptId) ? c.filter(x => x !== s.scriptId) : [...c, s.scriptId])} /></td>
                      <td><b>{nameOf(s)}</b></td>
                      <td><code>{s.tableId || '—'}</code></td>
                      <td>{total} 筆</td>
                      <td><span className={`uat-bulk-pill is-${STATUS_TONE[s.status]}`}>{pill}</span></td>
                      <td>
                        {s.rows?.length ? <button type="button" className="uat-btn is-quiet is-mini"
                          onClick={() => setExpanded(e => e === s.scriptId ? null : s.scriptId)}>{expanded === s.scriptId ? '收合配對' : '展開配對'}</button> : null}
                        {s.status === 'needs-review' && <button type="button" className="uat-btn is-mini" onClick={() => onOpenSingle(s.scriptId)}>逐筆處理</button>}
                      </td>
                    </tr>,
                    expanded === s.scriptId && <tr key={`${s.scriptId}-d`} className="uat-bulk-detail"><td /><td colSpan={5}>
                      <table className="uat-retarget-table">
                        <thead><tr><th>編號</th><th>目前 TC</th><th>新表 TC</th></tr></thead>
                        <tbody>{(s.rows ?? []).map(r => (
                          <tr key={r.old.recordId} className={r.suggestion ? '' : 'is-unset'}>
                            <td><b>{r.old.number || '（無編號）'}</b><small>{r.note}</small></td>
                            <td>{r.old.text}<small>舊記錄：{r.old.recordId}</small></td>
                            <td>{r.suggestion ? <>{r.suggestion.text}<small>新記錄：{r.suggestion.recordId}</small></> : <span className="uat-retarget-warn">{r.note}</span>}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </td></tr>,
                  ]
                })}
              </tbody>
            </table>
            <div className="uat-bulk-foot">
              <label className="uat-check">
                <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                我已確認目標表與勾選腳本的配對內容
                <small>只套用勾選的腳本；每支先備份再改綁，可以在單支「改綁 TC 表格」裡還原。沒勾的腳本保持原狀。</small>
              </label>
              <button type="button" className="uat-btn is-quiet" disabled={!!busy} onClick={() => { setPlan(null); choose([]) }}>返回選擇</button>
              <button type="button" className="uat-btn is-primary" disabled={!confirmed || !chosen.length || !!busy} onClick={() => void doApply()}>
                {busy === 'apply' ? '套用中…' : `確認套用 ${chosen.length} 支・${chosenTcCount} 筆 TC`}
              </button>
            </div>
          </>}

          {/* ── 3. 套用結果 ── */}
          {step === 3 && results && <>
            <div className="uat-bulk-summary">
              <span className="is-ok">已改綁 <b>{results.filter(r => r.status === 'applied').length}</b> 支</span>
              <span className="is-warn">沒改 <b>{results.filter(r => r.status !== 'applied').length}</b> 支</span>
            </div>
            <table className="uat-retarget-table uat-bulk-table">
              <thead><tr><th>腳本</th><th>結果</th><th /></tr></thead>
              <tbody>{results.map(r => (
                <tr key={r.scriptId}>
                  <td><b>{nameOf(r)}</b></td>
                  <td><span className={`uat-bulk-pill is-${STATUS_TONE[r.status]}`}>{r.status === 'applied' ? `已改綁 ${r.bound} 筆` : STATUS_TEXT[r.status]}</span></td>
                  <td>{r.status !== 'applied' && r.status !== 'forbidden' && r.status !== 'not-found' && r.status !== 'no-owner' &&
                    <button type="button" className="uat-btn is-mini" onClick={() => onOpenSingle(r.scriptId)}>逐筆處理</button>}</td>
                </tr>
              ))}</tbody>
            </table>
            {reviewRows.some(s => s.status === 'needs-review') && (
              <p className="uat-retarget-warn">還有 {reviewRows.filter(s => s.status === 'needs-review').length} 支要逐筆處理，沒有改動。</p>
            )}
            <div className="uat-bulk-foot">
              <button type="button" className="uat-btn is-primary" onClick={onClose}>完成</button>
            </div>
          </>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

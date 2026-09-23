import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RetargetPlanRow, RetargetTc, RetargetBinding } from '../../../shared/uat-tc-retarget'

/**
 * 「改綁 TC 表格」。**Backend 與 H5／PC 共用這一個元件**。
 *
 * 為什麼需要：腳本存檔時把 `tableId` 一起存進去，候選 TC 只顯示那張表的。
 * 所以在新表建了 TC（實務上常是把舊表複製一份挪用）之後，舊腳本會一筆新 TC 都看不到——
 * 錄了幾十步的腳本等於報廢。
 *
 * ⚠️ **不自動套用。**編號相同不代表同一個測項，所以這裡只列建議，由人逐列確認。
 *    配不上的留白，**不能保留舊的回寫目標**（舊 recordId 指向舊表，回寫會寫錯地方且不報錯）。
 * ⚠️ **彈窗一定走 `createPortal` 掛 `document.body`**——這個版面的祖先有 `backdrop-filter`，
 *    `position: fixed` 會被困在容器裡然後被裁掉。
 */

type Kind = 'backend' | 'frontend'

interface PlanResponse {
  ok: boolean
  message?: string
  newTableId?: string
  newTcCount?: number
  rows?: RetargetPlanRow[]
  newTcs?: RetargetTc[]
  current?: { tableId: string; larkUrl: string; bindingCount: number }
}

interface ApplyResponse {
  ok: boolean
  message?: string
  backupId?: string
  bound?: number
  unresolved?: RetargetBinding[]
  invalidDecisions?: string[]
  blockers?: string[]
}

interface BackupRow {
  id: string; actor: string; createdAt: number
  tableId: string; larkUrl: string; bindingCount: number
}

const REASON_LABEL: Record<RetargetPlanRow['reason'], string> = {
  'matched': '已配對',
  'number-empty': '沒有編號',
  'number-duplicate': '編號重複',
  'not-found': '新表沒有',
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  // ⚠️ 路由不存在時伺服器回的是 SPA 的 index.html，直接 json() 會丟 SyntaxError
  //    變成看不懂的錯誤。先看開頭是不是 `<`。
  if (text.trimStart().startsWith('<')) {
    return { ok: false, message: `後端沒有這個路由（${res.status}）——server 可能還沒重啟到有這個功能的版本` } as T
  }
  try { return JSON.parse(text) as T } catch { return { ok: false, message: `回應不是 JSON：${text.slice(0, 80)}` } as T }
}

export function TcRetargetDialog({ kind, scriptId, scriptName, currentTableId, open, onClose, onApplied }: {
  kind: Kind
  scriptId: string
  scriptName: string
  currentTableId: string
  open: boolean
  onClose: () => void
  /** 套用成功後通知外面重新載入腳本 */
  onApplied: () => void
}) {
  const [newLarkUrl, setNewLarkUrl] = useState('')
  const [busy, setBusy] = useState<'plan' | 'apply' | 'restore' | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [plan, setPlan] = useState<PlanResponse | null>(null)
  /** 舊 recordId → 選定的新 recordId（空字串 = 不接） */
  const [decisions, setDecisions] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ApplyResponse | null>(null)
  const [backups, setBackups] = useState<BackupRow[]>([])

  const loadBackups = useCallback(async () => {
    if (!scriptId) return
    const res = await fetch(`/api/osm-uat/retarget/backups?kind=${kind}&scriptId=${encodeURIComponent(scriptId)}`)
      .then(r => r.json()).catch(() => null) as { ok?: boolean; backups?: BackupRow[] } | null
    if (res?.ok) setBackups(res.backups ?? [])
  }, [kind, scriptId])

  useEffect(() => { if (open) void loadBackups() }, [open, loadBackups])

  if (!open) return null

  const doPlan = async () => {
    setBusy('plan'); setMsg(null); setResult(null)
    const res = await post<PlanResponse>('/api/osm-uat/retarget/plan', { kind, scriptId, newLarkUrl: newLarkUrl.trim() })
    setBusy(null)
    if (!res.ok) { setPlan(null); setMsg({ text: res.message ?? '產生配對失敗', ok: false }); return }
    setPlan(res)
    // 只有 matched 才預先選起來；其餘一律留白讓人自己決定
    setDecisions(Object.fromEntries((res.rows ?? []).map(r => [r.old.recordId, r.suggestion?.recordId ?? ''])))
    const matched = (res.rows ?? []).filter(r => r.reason === 'matched').length
    setMsg({ text: `目標表有 ${res.newTcCount} 筆 TC；${matched}／${res.rows?.length ?? 0} 筆有建議配對，其餘請自己選`, ok: true })
  }

  const doApply = async () => {
    setBusy('apply'); setMsg(null)
    const res = await post<ApplyResponse>('/api/osm-uat/retarget/apply', { kind, scriptId, newLarkUrl: newLarkUrl.trim(), decisions })
    setBusy(null)
    setResult(res)
    if (!res.ok) { setMsg({ text: res.message ?? '套用失敗', ok: false }); return }
    setMsg({ text: `已改綁 ${res.bound} 筆${res.unresolved?.length ? `，${res.unresolved.length} 筆沒接上` : ''}`, ok: !res.blockers?.length })
    void loadBackups()
    onApplied()
  }

  const doRestore = async (backupId: string) => {
    if (!window.confirm('還原會把表格、綁定、步驟歸屬都退回這次改綁之前。確定嗎？')) return
    setBusy('restore'); setMsg(null)
    const res = await post<{ ok: boolean; message?: string; bindings?: number }>('/api/osm-uat/retarget/restore', { backupId })
    setBusy(null)
    setMsg({ text: res.ok ? `已還原（${res.bindings} 筆綁定）` : (res.message ?? '還原失敗'), ok: !!res.ok })
    if (res.ok) { setPlan(null); setResult(null); onApplied() }
  }

  const unmatchedCount = (plan?.rows ?? []).filter(r => !decisions[r.old.recordId]).length

  return createPortal(
    <div className="uat-studio uat-tc-modal" role="dialog" aria-modal="true" aria-label="改綁 TC 表格"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="uat-tc-picker uat-retarget">
        <div className="uat-tc-picker-head">
          <div>
            <span className="uat-net-kicker">RETARGET</span>
            <h3>改綁 TC 表格</h3>
            <p>{scriptName}｜目前表格 <code>{currentTableId || '（未綁定）'}</code></p>
          </div>
          <button type="button" className="uat-btn is-quiet" onClick={onClose}>關閉</button>
        </div>

        <div className="uat-retarget-body">
          <label className="uat-retarget-url">
            新的 Lark TC 網址
            <textarea className="uat-field" rows={2} value={newLarkUrl} onChange={e => setNewLarkUrl(e.target.value)}
              placeholder="https://xxx.larksuite.com/base/...?table=tbl..." />
          </label>
          <div className="uat-retarget-actions">
            <button type="button" className="uat-btn is-quiet" disabled={!newLarkUrl.trim() || busy !== null} onClick={() => void doPlan()}>
              {busy === 'plan' ? '讀取目標表中…' : '產生配對建議'}
            </button>
            {plan && (
              <button type="button" className="uat-btn is-primary" disabled={busy !== null} onClick={() => void doApply()}>
                {busy === 'apply' ? '套用中…' : `套用（${(plan.rows ?? []).length - unmatchedCount}／${(plan.rows ?? []).length} 已選）`}
              </button>
            )}
          </div>

          {msg && <p className={msg.ok ? 'uat-retarget-ok' : 'uat-retarget-bad'} role="status">{msg.text}</p>}

          {plan && (
            <>
              {/* ⚠️ 沒選的那幾筆講清楚會發生什麼——不然按下去只會看到「N 筆沒接上」，
                     不知道那代表腳本跑不了 */}
              {unmatchedCount > 0 && (
                <p className="uat-retarget-warn">
                  還有 <b>{unmatchedCount}</b> 筆沒選。沒選的綁定會被移除，<b>它們的步驟會保留但指著舊 TC，腳本在接好之前不能執行</b>。
                </p>
              )}
              <table className="uat-retarget-table">
                <thead><tr><th>目前綁定</th><th>狀態</th><th>接到新表的哪一筆</th></tr></thead>
                <tbody>
                  {(plan.rows ?? []).map(row => (
                    <tr key={row.old.recordId} className={decisions[row.old.recordId] ? '' : 'is-unset'}>
                      <td>
                        <b>{row.old.number || '（無編號）'}</b>
                        <small>{row.old.text}</small>
                      </td>
                      <td><span className={`uat-retarget-tag is-${row.reason}`}>{REASON_LABEL[row.reason]}</span>
                        <small>{row.note}</small></td>
                      <td>
                        <select value={decisions[row.old.recordId] ?? ''}
                          onChange={e => setDecisions(d => ({ ...d, [row.old.recordId]: e.target.value }))}>
                          <option value="">— 不接（移除這筆綁定）—</option>
                          {(plan.newTcs ?? []).map(tc => (
                            <option key={tc.recordId} value={tc.recordId}>
                              {tc.number || tc.recordId}｜{(tc.text ?? '').slice(0, 40)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {result?.ok && (
            <div className="uat-retarget-result">
              {!!result.blockers?.length && (
                <ul className="uat-retarget-bad">{result.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
              )}
              {!!result.invalidDecisions?.length && (
                <p className="uat-retarget-bad">有 {result.invalidDecisions.length} 個選擇在目標表裡不存在（或被重複選到），已當成未接上。</p>
              )}
              {result.backupId && <p className="uat-retarget-ok">改綁前的狀態已備份，下面可以還原。</p>}
            </div>
          )}

          <details className="uat-retarget-backups">
            <summary>改綁紀錄與還原（{backups.length}）</summary>
            {!backups.length && <p>還沒有改綁紀錄。</p>}
            <ul>
              {backups.map(b => (
                <li key={b.id}>
                  <span><code>{b.tableId}</code>｜{b.bindingCount} 筆綁定｜{new Date(b.createdAt).toLocaleString('zh-TW', { hour12: false })}｜{b.actor}</span>
                  <button type="button" className="uat-btn is-quiet" disabled={busy !== null} onClick={() => void doRestore(b.id)}>還原到這裡</button>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>
    </div>,
    document.body,
  )
}

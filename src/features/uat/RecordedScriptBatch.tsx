import { useEffect, useRef, useState } from 'react'
import type { RecordedScript } from './MultiTcRecorder'
import { MultiTcResults } from './MultiTcResults'
import { queueRequest, runRecordedQueue, type QueueEntry } from './recorded-queue'
import { recordingSaveErrors } from '../../../shared/uat-recording-schema'
import { stepDependencyIssues } from '../../../server/uat-runner/step-dependencies.js'

export function RecordedScriptBatch({ scripts, selectedIds, onOrder, agentId, running, busy, onBusy, onRun }: {
  scripts: RecordedScript[]; selectedIds: string[]; onOrder: (ids: string[]) => void; agentId: string;
  running: boolean; busy: boolean; onBusy: (busy: boolean) => void; onRun: () => void
}) {
  const [entries, setEntries] = useState<QueueEntry[]>([])
  const [dryRun, setDryRun] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [message, setMessage] = useState('')
  const cancelled = useRef(false)
  const current = useRef<QueueEntry[]>([])
  const active = useRef(false)
  useEffect(() => () => { cancelled.current = true }, [])
  useEffect(() => {
    if (!busy) return
    const preventLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', preventLeave)
    return () => window.removeEventListener('beforeunload', preventLeave)
  }, [busy])
  useEffect(() => { setConfirm(false) }, [selectedIds, agentId, scripts])
  const selected = selectedIds.map(id => scripts.find(s => s.id === id))
  const missing = selected.some(s => !s)
  const locked = busy || running
  const all = entries.flatMap(entry => entry.results)
  const risks = [
    { title: '失敗 TC', rows: all.filter(r => r.outcome === 'fail') },
    { title: '待確認／受阻', rows: all.filter(r => ['unverified', 'blocked'].includes(r.outcome)) },
    { title: '回寫失敗', rows: all.filter(r => !!r.publishError) },
  ]
  const repeated = new Set<string>(), seen = new Set<string>()
  selected.forEach(s => s?.bindings.forEach(b => { const key = `${s.larkUrl}:${b.recordId}`; if (seen.has(key)) repeated.add(key); seen.add(key) }))
  const update = (index: number, patch: Partial<QueueEntry>) => {
    current.current = current.current.map((entry, i) => i === index ? { ...entry, ...patch } : entry)
    setEntries(current.current)
  }
  const start = async (trial: boolean) => {
    if (active.current || locked || !selectedIds.length || missing) return
    const errors = selected.flatMap(s => s ? [...recordingSaveErrors(s), ...stepDependencyIssues(s.steps).map(i => i.message), ...(!s.steps.some(step => !step.disabled) ? ['沒有啟用步驟'] : [])].map(error => `${s.title}：${error}`) : ['選取的腳本已不存在'])
    if (errors.length) { setMessage(errors.join('；')); setConfirm(false); return }
    active.current = true; cancelled.current = false; onBusy(true); setDryRun(trial); setConfirm(false); setMessage('')
    const queue: QueueEntry[] = selected.map(s => ({ id: s!.id!, title: s!.title, state: 'waiting', results: [] }))
    current.current = queue; setEntries(queue)
    try { await runRecordedQueue(queue, { agentId, dryRun: trial, cancelled: () => cancelled.current, update, started: onRun }) }
    finally { active.current = false; onBusy(false) }
  }
  const stop = async () => {
    cancelled.current = true
    setMessage('已取消後續派工，正在停止目前腳本…')
    try {
      const entry = current.current.find(e => e.state === 'running')
      if (entry?.sessionId) {
        const status = await queueRequest('/api/osm-uat/status')
        if (status.sessionId === entry.sessionId && status.status === 'running') await queueRequest('/api/osm-uat/stop', {})
      }
    } catch (e) { setMessage(`後續派工已取消，但停止目前腳本失敗：${String(e)}。請再按停止。`) }
  }
  return <>
    <div className="uat-stat-grid">{[['PASS', all.filter(r => r.outcome === 'pass').length], ['FAIL', all.filter(r => r.outcome === 'fail').length], ['待確認／受阻', risks[1].rows.length], ['完成腳本', entries.filter(e => e.state === 'done').length], ['耗時（秒）', Math.round(entries.reduce((sum, e) => sum + (e.durationMs || 0), 0) / 1000)]].map(([label, value]) => <article className="uat-stat" key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
    <section className="uat-panel uat-risk-queue">
      <div className="uat-section-title"><span>SCRIPT QUEUE</span><h3>腳本執行順序 <small>{selectedIds.length} 份</small></h3><p>由上往下逐份執行。可只勾選一份；上下移動可調整優先順序。</p></div>
      <ol className="uat-script-order">{selectedIds.map((id, i) => <li key={id}><span>{selected[i]?.title || '腳本已不存在，請移除'}</span><div>{[-1, 1].map(delta => <button className="uat-btn is-quiet" key={delta} disabled={locked || i + delta < 0 || i + delta >= selectedIds.length} aria-label={`${selected[i]?.title || id}${delta < 0 ? '優先' : '延後'}`} onClick={() => { const next = [...selectedIds]; [next[i], next[i + delta]] = [next[i + delta], next[i]]; onOrder(next) }}>{delta < 0 ? '上移' : '下移'}</button>)}<button className="uat-btn is-quiet" disabled={locked} onClick={() => onOrder(selectedIds.filter(key => key !== id))}>移除</button></div></li>)}</ol>
      {!selectedIds.length && <p>請從左側勾選要執行的腳本。</p>}
      <div className="uat-tc-record-actions"><button className="uat-btn" disabled={locked || missing || !selectedIds.length} onClick={() => void start(true)}>試跑選取腳本</button><button className="uat-btn" disabled={locked || missing || !selectedIds.length} onClick={() => setConfirm(true)}>正式執行選取腳本</button>{busy && <button className="uat-btn is-danger" onClick={() => void stop()}>停止整個佇列</button>}</div>
      <p>試跑不寫入 Lark。一般 TC 判定失敗會繼續下一份；啟動或連線異常會停止後續派工。執行期間請保留此頁，離開後不再派發下一份腳本。</p>
      {confirm && <div className="uat-multi-confirm"><strong>確認依上述順序正式執行 {selectedIds.length} 份腳本？</strong><p>將更新所綁定 TC 的 PASS／FAIL 與附圖。{repeated.size > 0 && `其中 ${repeated.size} 筆 TC 重複綁定，後執行的腳本會覆蓋先前回寫。`}</p><button className="uat-btn" disabled={locked} onClick={() => void start(false)}>確認執行佇列</button><button className="uat-btn is-quiet" onClick={() => setConfirm(false)}>取消</button></div>}
      {message && <p role="alert">{message}</p>}
    </section>
    <section className="uat-panel uat-risk-queue"><div className="uat-section-title"><span>RISK QUEUE</span><h3>本次腳本待處理項目</h3><p>只統計本次佇列已取得的結果；相同 TC 在不同腳本各計一次。</p></div><div className="uat-script-risks">{risks.map(group => <div key={group.title}><strong>{group.title} {group.rows.length}</strong>{group.rows.slice(0, 5).map((row, i) => <p key={`${row.recordId}-${i}`}>{row.task}</p>)}</div>)}</div></section>
    {!!entries.length && <section className="uat-panel uat-risk-queue"><h3>{dryRun ? '本次試跑' : '本次正式執行'}</h3>{entries.map((entry, index) => <details key={entry.id} open={entry.state === 'running' || entry.state === 'error'}><summary>{index + 1}. {entry.title} · {{ waiting: '待執行', running: '執行中', done: '已完成', error: '執行異常', cancelled: '已停止／取消' }[entry.state]}</summary>{entry.error && <p role="alert">{entry.error}</p>}<MultiTcResults results={entry.results} dryRun={dryRun} /></details>)}</section>}
  </>
}

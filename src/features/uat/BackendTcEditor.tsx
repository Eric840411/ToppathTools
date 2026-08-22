/**
 * src/features/uat/BackendTcEditor.tsx
 *
 * 後台單筆 TC 的積木編輯器。
 *
 * 之前整個 UAT 畫面沒有「單筆 TC」這一層——模組只設定「要收哪些 TC」，
 * 掃描也只回分類統計。積木是掛在單筆 TC 上的，所以要先有這一層才編得了。
 *
 * 積木定義（BLOCK_DEFS）由後端 /api/osm-uat/blocks 提供，**不在前端另抄一份**：
 * 抄兩份的下場是「畫面上有這顆積木、跑起來說不認得」。參數表單也是照定義自動長。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UatThemeMode } from './types'

export interface BackendTc {
  recordId: string
  text: string
  sub: string
  taskType: string
  stepCount: number
  verifierName: string | null
  /** registry = 只在離線快照裡看過（可能已從 Lark 移除）；live = 這次掃描確認存在 */
  source?: 'registry' | 'live'
}

interface BlockParam {
  key: string
  label: string
  type: 'text' | 'number' | 'textarea' | 'select' | 'boolean'
  options?: string[]
  default?: unknown
  placeholder?: string
  help?: string
  required?: boolean
}

interface BlockDef {
  label: string
  category: string
  description: string
  params?: BlockParam[]
  defaultOnFail?: string
}

type Step = Record<string, unknown> & { action: string }

const CATEGORY_LABEL: Record<string, string> = {
  nav: '導航', read: '讀取', assert: '驗證', compare: '比對', evidence: '證據與流程', legacy: '沿用既有',
}

export function BackendTcEditor({ tc, allTcs, themeMode, onSaved, onClose }: {
  tc: BackendTc
  /** 給「從其他 TC 複製」用。121 筆只對應 23 支驗證器，同一支底下步驟高度重複，
   *  沒有複製功能就是逐筆手工 121 次 */
  allTcs: BackendTc[]
  themeMode: UatThemeMode
  onSaved: (recordId: string, stepCount: number) => void
  onClose: () => void
}) {
  const xianxia = themeMode === 'xianxia'
  const [blockDefs, setBlockDefs] = useState<Record<string, BlockDef>>({})
  const [steps, setSteps] = useState<Step[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [copyFrom, setCopyFrom] = useState('')
  const [recSession, setRecSession] = useState<string | null>(null)
  const [recCount, setRecCount] = useState(0)
  const [verifierName, setVerifierName] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/osm-uat/blocks')
        const d = await r.json() as { ok: boolean; blockDefs?: Record<string, BlockDef> }
        if (d.ok) setBlockDefs(d.blockDefs ?? {})
      } catch { /* 積木庫載不到就顯示空清單，不擋住其他操作 */ }
    })()
  }, [])

  const loadSteps = useCallback(async (recordId: string) => {
    try {
      const r = await fetch(`/api/osm-uat/tc-steps/${encodeURIComponent(recordId)}`)
      const d = await r.json() as { ok: boolean; steps?: Step[]; verifierName?: string | null }
      setSteps(d.steps ?? [])
      setVerifierName(d.verifierName ?? null)
      setSelected(null)
      setDirty(false)
      setMsg(null)
    } catch { setMsg({ text: '讀取積木失敗', tone: 'error' }) }
  }, [])

  useEffect(() => { void loadSteps(tc.recordId) }, [tc.recordId, loadSteps])

  const addBlock = (action: string) => {
    const def = blockDefs[action]
    const step: Step = { action }
    for (const prm of def?.params ?? []) if (prm.default !== undefined) step[prm.key] = prm.default
    setSteps(prev => { const next = [...prev, step]; setSelected(next.length - 1); return next })
    setDirty(true)
  }
  const patchStep = (index: number, patch: Record<string, unknown>) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, ...patch } : s)); setDirty(true)
  }
  const moveStep = (index: number, delta: number) => {
    setSteps(prev => {
      const next = [...prev]
      const to = index + delta
      if (to < 0 || to >= next.length) return prev
      ;[next[index], next[to]] = [next[to], next[index]]
      setSelected(to)
      return next
    })
    setDirty(true)
  }
  const removeStep = (index: number) => {
    setSteps(prev => prev.filter((_, i) => i !== index)); setSelected(null); setDirty(true)
  }

  const doCopy = async () => {
    if (!copyFrom) return
    if (steps.length && !window.confirm('這會覆蓋目前的積木，確定嗎？')) return
    try {
      const r = await fetch(`/api/osm-uat/tc-steps/${encodeURIComponent(copyFrom)}`)
      const d = await r.json() as { ok: boolean; steps?: Step[] }
      if (!d.steps?.length) return setMsg({ text: '那筆 TC 沒有積木可複製', tone: 'error' })
      setSteps(d.steps); setSelected(null); setDirty(true)
      setMsg({ text: `已複製 ${d.steps.length} 顆積木，記得儲存`, tone: 'ok' })
    } catch { setMsg({ text: '複製失敗', tone: 'error' }) }
  }

  // ── 錄製 ──────────────────────────────────────────────────────────────
  // 開一個有頭的瀏覽器並自動登入後台，使用者的操作直接變積木；
  // 要標檢查條件就按住 Alt 點元素（錄製只錄得到「做了什麼」，錄不到「在檢查什麼」）。
  const startRecord = async () => {
    setMsg({ text: '正在開啟後台並登入…', tone: 'ok' })
    try {
      const r = await fetch('/api/osm-uat/record/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: tc.recordId }),
      })
      const d = await r.json() as { ok: boolean; sessionId?: string; message?: string }
      if (!d.ok || !d.sessionId) return setMsg({ text: d.message ?? '錄製啟動失敗', tone: 'error' })
      setRecSession(d.sessionId)
      setRecCount(0)
      setMsg({ text: '錄製中：在開啟的視窗操作；要標檢查條件就按住 Alt 點那個元素', tone: 'ok' })
    } catch { setMsg({ text: '錄製啟動失敗', tone: 'error' }) }
  }

  // 錄製期間輪詢，讓按鈕顯示已經錄到幾顆——不然使用者不知道到底有沒有在錄。
  // 使用者自己把瀏覽器關掉時 done 會變 true，這裡要負責收尾。
  useEffect(() => {
    if (!recSession) return
    let stopped = false
    const timer = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/osm-uat/record/status/${recSession}`)
        const d = await r.json() as { ok: boolean; done?: boolean; steps?: Step[] }
        if (!d.ok || stopped) return
        setRecCount(d.steps?.length ?? 0)
        if (d.done) { stopped = true; window.clearInterval(timer); void finishRecord(recSession) }
      } catch { /* 一次查不到不用中斷輪詢 */ }
    }, 2000)
    return () => { stopped = true; window.clearInterval(timer) }
    // finishRecord 只用到參數帶進去的 sessionId，放進 deps 會讓 interval 每次 render 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recSession])

  /**
   * 停止錄製並把積木接到現有清單後面。
   * 沒有任何斷言的錄製跑起來永遠 PASS——那不是測試是重播，要問清楚而不是安靜收下。
   */
  const finishRecord = async (sessionId: string) => {
    setRecSession(null)
    try {
      const r = await fetch(`/api/osm-uat/record/stop/${sessionId}`, { method: 'POST' })
      const d = await r.json() as { ok: boolean; steps?: Step[]; hasAssertion?: boolean }
      const recorded = d.steps ?? []
      if (!recorded.length) return setMsg({ text: '這次沒有錄到任何操作', tone: 'error' })
      if (!d.hasAssertion) {
        const warn = `錄到 ${recorded.length} 顆積木，但一個檢查條件都沒有。\n\n`
          + '這樣的腳本跑起來永遠 PASS（等於只是重播操作，不會驗任何東西）。\n'
          + '仍要加入嗎？（也可以取消，重錄時按住 Alt 點元素標檢查條件）'
        if (!window.confirm(warn)) return
      }
      setSteps(prev => [...prev, ...recorded])
      setDirty(true)
      setMsg({ text: `已加入 ${recorded.length} 顆積木，記得儲存`, tone: 'ok' })
    } catch { setMsg({ text: '取得錄製結果失敗', tone: 'error' }) }
  }


  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch(`/api/osm-uat/tc-steps/${encodeURIComponent(tc.recordId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps }),
      })
      const d = await r.json() as { ok: boolean; message?: string }
      if (!d.ok) { setMsg({ text: d.message ?? '儲存失敗', tone: 'error' }); return }
      setDirty(false)
      setMsg({ text: steps.length ? `已儲存 ${steps.length} 顆積木` : '已清空，這筆會回去走原本的驗證器', tone: 'ok' })
      onSaved(tc.recordId, steps.length)
    } catch { setMsg({ text: '儲存失敗', tone: 'error' }) }
    finally { setSaving(false) }
  }

  const grouped = useMemo(() => {
    const out = new Map<string, { action: string; def: BlockDef }[]>()
    for (const [action, def] of Object.entries(blockDefs)) {
      const list = out.get(def.category) ?? []
      list.push({ action, def })
      out.set(def.category, list)
    }
    return out
  }, [blockDefs])

  const copyCandidates = allTcs.filter(t => t.recordId !== tc.recordId && t.stepCount > 0)
  const current = selected !== null ? steps[selected] : null
  const currentDef = current ? blockDefs[current.action] : null

  return (
    <div className="uat-tc-editor">
      <div className="uat-tc-editor-head">
        <div>
          <span className="uat-net-kicker">TC STEPS</span>
          <h3>{xianxia ? '術式編排' : '積木編輯'}</h3>
          <small className="uat-tc-editor-id">{tc.sub || tc.taskType || '未分類'} · <code>{tc.recordId}</code></small>
        </div>
        <span className="uat-tc-editor-actions">
          {recSession ? (
            <button type="button" className="uat-btn is-danger" onClick={() => void finishRecord(recSession)}>
              停止錄製（{recCount} 顆）
            </button>
          ) : (
            <button type="button" className="uat-btn is-quiet" onClick={() => void startRecord()}>錄製</button>
          )}
          <button type="button" className="uat-btn is-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '儲存中' : dirty ? '儲存' : '已儲存'}
          </button>
          <button type="button" className="uat-btn is-quiet" onClick={() => {
            if (dirty && !window.confirm('有還沒儲存的變更，確定關閉嗎？')) return
            onClose()
          }}>關閉</button>
        </span>
      </div>

      <p className="uat-tc-editor-text">{tc.text || '（這筆 TC 沒有描述文字）'}</p>

      {!steps.length && (
        <div className="uat-tc-editor-hint">
          目前這筆走的是內建驗證器
          {verifierName ? <code>{verifierName}</code> : <span>（尚未對應）</span>}。
          加了積木之後就改照積木跑；把積木全部刪掉再儲存會回到現在的行為。
        </div>
      )}

      <div className="uat-tc-editor-body">
        <aside className="uat-tc-blocks">
          <h4>{xianxia ? '術式庫' : '積木庫'}</h4>
          {[...grouped.entries()].map(([category, items]) => (
            <section key={category}>
              <h5>{CATEGORY_LABEL[category] ?? category}</h5>
              {items.map(({ action, def }) => (
                <button type="button" className={`uat-tc-block is-${category}`} key={action} onClick={() => addBlock(action)}>
                  <i />
                  <span><strong>{def.label}</strong><small>{def.description}</small></span>
                  <b>加入</b>
                </button>
              ))}
            </section>
          ))}
        </aside>

        <main className="uat-tc-steps">
          {steps.length ? steps.map((step, i) => {
            const def = blockDefs[step.action]
            return (
              <article
                className={`uat-tc-step is-${def?.category ?? 'unknown'}${selected === i ? ' is-selected' : ''}`}
                key={i}
                onClick={() => setSelected(i)}
              >
                <span className="uat-tc-step-index">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{def?.label ?? `⚠️ 不認得的積木：${step.action}`}</strong>
                  <small>{summarize(step, def)}</small>
                </div>
                <span className="uat-tc-step-actions">
                  <button type="button" disabled={i === 0} onClick={e => { e.stopPropagation(); moveStep(i, -1) }}>上移</button>
                  <button type="button" disabled={i === steps.length - 1} onClick={e => { e.stopPropagation(); moveStep(i, 1) }}>下移</button>
                  <button type="button" onClick={e => { e.stopPropagation(); removeStep(i) }}>移除</button>
                </span>
              </article>
            )
          }) : (
            <div className="uat-tc-steps-empty">
              <strong>尚未加入積木</strong>
              <span>從左邊點一顆加入，或從其他 TC 複製一份過來</span>
            </div>
          )}

          {copyCandidates.length > 0 && (
            <div className="uat-tc-copy">
              <select className="uat-field" value={copyFrom} onChange={e => setCopyFrom(e.target.value)}>
                <option value="">從其他 TC 複製積木…</option>
                {copyCandidates.map(t => (
                  <option value={t.recordId} key={t.recordId}>
                    [{t.sub || '未分類'}] {t.text.slice(0, 40) || t.recordId}（{t.stepCount} 顆）
                  </option>
                ))}
              </select>
              <button type="button" className="uat-btn is-quiet" disabled={!copyFrom} onClick={() => void doCopy()}>複製</button>
            </div>
          )}
        </main>

        <aside className="uat-tc-inspector">
          <h4>{xianxia ? '術式參數' : '步驟參數'}</h4>
          {current && currentDef ? (
            <>
              <p className="uat-tc-inspector-desc">{currentDef.description}</p>
              {(currentDef.params ?? []).map(prm => (
                <label className="uat-tc-field" key={prm.key}>
                  {prm.label}{prm.required && <b> *</b>}
                  {prm.type === 'textarea' ? (
                    <textarea
                      className="uat-field uat-code-field"
                      value={toText(current[prm.key])}
                      placeholder={prm.placeholder}
                      onChange={e => patchStep(selected!, { [prm.key]: e.target.value })}
                    />
                  ) : prm.type === 'select' ? (
                    <select
                      className="uat-field"
                      value={String(current[prm.key] ?? prm.default ?? '')}
                      onChange={e => patchStep(selected!, { [prm.key]: e.target.value })}
                    >
                      {(prm.options ?? []).map(o => <option value={o} key={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      className="uat-field"
                      type={prm.type === 'number' ? 'number' : 'text'}
                      value={String(current[prm.key] ?? '')}
                      placeholder={prm.placeholder}
                      onChange={e => patchStep(selected!, {
                        [prm.key]: prm.type === 'number'
                          ? (e.target.value === '' ? undefined : Number(e.target.value))
                          : e.target.value,
                      })}
                    />
                  )}
                  {prm.help && <small>{prm.help}</small>}
                </label>
              ))}
              {/* onFail 不是每顆積木都宣告，但每顆都吃得到，所以固定給一個 */}
              {!(currentDef.params ?? []).some(prm => prm.key === 'onFail') && (
                <label className="uat-tc-field">
                  失敗時
                  <select className="uat-field" value={String(current.onFail ?? currentDef.defaultOnFail ?? 'stop')}
                    onChange={e => patchStep(selected!, { onFail: e.target.value })}>
                    <option value="stop">中止這筆 TC</option>
                    <option value="continue">記為失敗但繼續</option>
                    <option value="manual">改判需人工</option>
                  </select>
                  <small>continue 一樣算失敗，只是繼續往下跑好把問題一次看完。</small>
                </label>
              )}
            </>
          ) : (
            <p className="uat-tc-inspector-empty">點中間的積木來編參數</p>
          )}
        </aside>
      </div>

      {msg && <span className={`uat-backend-cred-msg${msg.tone === 'error' ? ' is-error' : ''}`}>{msg.text}</span>}
    </div>
  )
}

function toText(value: unknown) {
  if (Array.isArray(value)) return value.join('\n')
  return value === undefined || value === null ? '' : String(value)
}

/** 步驟卡片上那行摘要：挑最能認出這顆積木在做什麼的幾個參數 */
function summarize(step: Step, def?: BlockDef) {
  if (!def) return JSON.stringify(step).slice(0, 80)
  const parts = (def.params ?? [])
    .filter(prm => step[prm.key] !== undefined && String(step[prm.key]).trim() !== '')
    .slice(0, 3)
    .map(prm => `${prm.key}: ${toText(step[prm.key]).replace(/\n/g, ', ').slice(0, 40)}`)
  return parts.join(' · ') || '（尚未設定參數）'
}

import { useMemo } from 'react'
import { XianxiaIcon } from '../../components/XianxiaIcon'
import type { AutoBaseline, AutoStep, UatThemeMode } from './types'
import { actionLabel, CATEGORY_LABELS, CONTAINER_ACTIONS, createStep, duplicateStep, findStep, removeStep, STEP_LIBRARY, updateStepTree } from './step-model'

/** 後台設定片段（只要清單需要的欄位——完整內容在 server 那邊，前端不需要也不該存一份） */
export interface BackendSnippetOption {
  id: string
  title: string
  note?: string
  stepCount: number
}

/** 腳本綁定的一筆 Lark TC（只留畫面用得到的欄位） */
export interface TcBindingOption { recordId: string; number: string; text: string }

interface Props {
  steps: AutoStep[]
  baselines: AutoBaseline[]
  snippets: BackendSnippetOption[]
  /** 這份腳本綁了哪些 TC。空陣列＝沒綁，整個 TC 欄位不出現 */
  bindings: TcBindingOption[]
  selectedId: string | null
  onSelectedIdChange: (id: string | null) => void
  onChange: (steps: AutoStep[]) => void
  themeMode: UatThemeMode
}

/**
 * 拖曳畫布與左側積木庫已移除（使用者 2026-09-18 定案）。
 *
 * 換成清單式：新增走頂端的下拉、排序走每一列的 ↑↓。
 * ⚠️ **排序不能一起拿掉**——步驟的先後就是測試本身，沒有排序等於錄完只能重錄。
 */
function setChildren(tree: AutoStep[], parentId: string | null, updater: (items: AutoStep[]) => AutoStep[]): AutoStep[] {
  if (!parentId) return updater(tree)
  return tree.map(step => step.id === parentId
    ? { ...step, children: updater(step.children ?? []) }
    : { ...step, children: step.children ? setChildren(step.children, parentId, updater) : undefined })
}

/** 把某一步往上／往下移一格。到頭了就不動（不要繞回另一端——那是意外的行為）。 */
function nudge(tree: AutoStep[], parentId: string | null, id: string, delta: number) {
  return setChildren(tree, parentId, items => {
    const from = items.findIndex(item => item.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= items.length) return items
    const next = [...items]
    const [moving] = next.splice(from, 1)
    next.splice(to, 0, moving)
    return next
  })
}

/**
 * 哪些積木**一定要指定所屬 TC**。
 *
 * ⚠️ 這份名單必須跟後端的分類表（`frontend-tc-engine.js` 的 `FRONTEND_BLOCK_DEFS`）
 * 一致——不一致的症狀是「畫面沒標紅、按執行才被擋」，或更糟的反過來。
 * 後端才是說了算的那一份；這裡只是提早顯示。
 */
const TC_REQUIRED_ACTIONS = new Set(['assert_visible', 'assert_api_called', 'find_baseline_scroll', 'screenshot'])
export function needsTc(action: string) { return TC_REQUIRED_ACTIONS.has(action) }

function StepList({ items, parentId, selectedId, onSelect, onChange, tree, xianxia, labelFor, tcLabel }: {
  items: AutoStep[]
  parentId: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  onChange: (tree: AutoStep[]) => void
  tree: AutoStep[]
  xianxia: boolean
  labelFor: (action: string) => string
  /** 綁了 TC 時才有：把 recordId 換成顯示用的編號 */
  tcLabel: ((recordId: string) => string) | null
}) {
  return (
    <div className={`uat-block-list${parentId ? ' is-nested' : ''}`}>
      {items.length === 0 && (
        <div className="uat-block-empty">
          <XianxiaIcon name="document" size={22} />
          <strong>{xianxia ? '此處尚無術式' : '這裡還沒有步驟'}</strong>
          <span>{xianxia ? '由上方「納入術式」選取，或先行觀照錄術' : '用上方的「新增步驟」加入，或先錄一段'}</span>
        </div>
      )}
      {items.map((step, index) => {
        const isContainer = CONTAINER_ACTIONS.has(step.action)
        return (
          <article
            key={step.id}
            className={`uat-step-block is-${step.action}${selectedId === step.id ? ' is-selected' : ''}`}
            onClick={event => { event.stopPropagation(); onSelect(step.id) }}
          >
            <div className="uat-step-move">
              <button type="button" aria-label={xianxia ? '上移術式' : '往上移'} disabled={index === 0}
                onClick={event => { event.stopPropagation(); onChange(nudge(tree, parentId, step.id, -1)) }}>▲</button>
              <button type="button" aria-label={xianxia ? '下移術式' : '往下移'} disabled={index === items.length - 1}
                onClick={event => { event.stopPropagation(); onChange(nudge(tree, parentId, step.id, 1)) }}>▼</button>
            </div>
            <span className="uat-step-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="uat-step-copy">
              <strong>{xianxia && step.name === actionLabel(step.action) ? labelFor(step.action) : (step.name || labelFor(step.action))}</strong>
              <span>{labelFor(step.action)}{step.selector ? ` · ${step.selector}` : step.value ? ` · ${step.value}` : ''}</span>
            </div>
            {/* ⚠️ 綁了 TC 的腳本，**沒指定所屬 TC 的檢查／截圖是跑不了的**（執行前就會被擋）。
                在清單上直接標出來，不要等到按了執行才說。 */}
            {tcLabel ? (
              step.tcId
                ? <span className="uat-step-tag is-tc">{tcLabel(step.tcId)}</span>
                : needsTc(step.action) && <span className="uat-step-tag is-danger">{xianxia ? '未歸屬試煉' : '未指定 TC'}</span>
            ) : null}
            {step.failureMode === 'retry' && <span className="uat-step-tag">重試 {step.retryCount ?? 1}</span>}
            {isContainer && <span className="uat-step-count">{step.children?.length ?? 0} {xianxia ? '道子術式' : '個子步驟'}</span>}
            {isContainer && (
              <div className="uat-step-children">
                <StepList items={step.children ?? []} parentId={step.id} selectedId={selectedId} onSelect={onSelect} onChange={onChange} tree={tree} xianxia={xianxia} labelFor={labelFor} tcLabel={tcLabel} />
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

export function BlockEditor({ steps, baselines, snippets, bindings, selectedId, onSelectedIdChange, onChange, themeMode }: Props) {
  const xianxia = themeMode === 'xianxia'
  const xianxiaActionLabels: Record<string, string> = {
    goto: '開啟幻境', click: '點化元件', click_viewport: '點定畫面', click_xy: '點化幻境座標', type: '注入靈文',
    wait: '靜候靈息', screenshot: '留存靈影', assert_visible: '驗證顯形', find_baseline_scroll: '尋影校驗', group: '術式陣組', repeat: '周天循環',
    backend_snippet: '調動後樞',
  }
  const labelFor = (action: string) => xianxia ? (xianxiaActionLabels[action] ?? actionLabel(action)) : actionLabel(action)
  const categoryFor = (category: string) => xianxia ? ({ browser: '幻境門', interaction: '御物術', assertion: '校驗術', evidence: '留影術', flow: '陣法控制' }[category] ?? CATEGORY_LABELS[category]) : CATEGORY_LABELS[category]
  const selected = useMemo(() => selectedId ? findStep(steps, selectedId) : null, [steps, selectedId])
  const tcLabel = bindings.length
    ? (recordId: string) => {
        const hit = bindings.find(item => item.recordId === recordId)
        // ⚠️ 找不到不要顯示成空白：那看起來像「沒綁」，但它其實綁了一個已經不在清單裡的 TC
        return hit ? (hit.number || hit.text || hit.recordId) : `已失效的 TC（${recordId.slice(0, 8)}…）`
      }
    : null
  const updateSelected = (patch: Partial<AutoStep>) => {
    if (selected) onChange(updateStepTree(steps, selected.id, patch))
  }
  const addStep = (action: string) => {
    const created = createStep(action)
    if (xianxia) created.name = labelFor(action)
    onChange([...steps, created])
    onSelectedIdChange(created.id)
  }
  const duplicateSelected = () => {
    if (!selected) return
    const copy = duplicateStep(selected)
    onChange([...steps, copy])
    onSelectedIdChange(copy.id)
  }
  const deleteSelected = () => {
    if (!selected) return
    onChange(removeStep(steps, selected.id))
    onSelectedIdChange(null)
  }

  return (
    <div className="uat-editor-grid is-modal">
      <section className="uat-canvas" onClick={() => onSelectedIdChange(null)}>
        <div className="uat-pane-heading">
          <div><span>{xianxia ? 'TRIAL ARRAY' : 'WORKFLOW'}</span><h3>{xianxia ? '試煉陣圖' : '測試流程'}</h3></div>
          {/* 積木庫拿掉之後，新增改走這顆下拉——不留的話就沒有任何方式手動加步驟 */}
          <select
            className="uat-field uat-add-step"
            value=""
            onClick={event => event.stopPropagation()}
            onChange={event => { if (event.target.value) addStep(event.target.value) }}
          >
            <option value="">{xianxia ? '＋ 納入術式' : '＋ 新增步驟'}</option>
            {Object.keys(CATEGORY_LABELS).map(category => {
              const items = STEP_LIBRARY.filter(item => item.category === category)
              if (!items.length) return null
              return <optgroup label={categoryFor(category)} key={category}>
                {items.map(item => <option value={item.action} key={item.action}>{labelFor(item.action)}</option>)}
              </optgroup>
            })}
          </select>
          <small>{steps.length} {xianxia ? '處陣眼' : '個區塊'}</small>
        </div>
        <StepList items={steps} parentId={null} selectedId={selectedId} onSelect={onSelectedIdChange} onChange={onChange} tree={steps} xianxia={xianxia} labelFor={labelFor} tcLabel={tcLabel} />
      </section>

      <aside className="uat-inspector">
        <div className="uat-pane-heading">
          <div><span>{xianxia ? 'ARRAY EYE' : 'INSPECTOR'}</span><h3>{xianxia ? '陣眼設定' : '步驟設定'}</h3></div>
        </div>
        {!selected ? (
          <div className="uat-inspector-empty"><XianxiaIcon name="settings" size={28} /><strong>{xianxia ? '選取一處陣眼' : '選取一個積木'}</strong><span>{xianxia ? '點選左側陣圖中的術式即可調校' : '點左邊清單裡的步驟就能編輯細節'}</span></div>
        ) : (
          <div className="uat-inspector-form">
            <label>{xianxia ? '術式名號' : '步驟名稱'}<input className="uat-field" value={selected.name} onChange={event => updateSelected({ name: event.target.value })} /></label>
            {/* 綁了 TC 才出現。⚠️ 沒綁的腳本硬給一個空選單，會讓人以為自己漏填了 */}
            {!!bindings.length && (
              <label>{xianxia ? '所屬試煉' : '所屬 TC'}
                <select className="uat-field" value={selected.tcId ?? ''} onChange={event => updateSelected({ tcId: event.target.value })}>
                  <option value="">{xianxia ? '共用前置（不歸屬）' : '共用步驟（不屬於任何 TC）'}</option>
                  {bindings.map(item => <option value={item.recordId} key={item.recordId}>{item.number || item.recordId} {item.text}</option>)}
                </select>
                {needsTc(selected.action) && !selected.tcId && (
                  <span className="uat-hint" style={{ color: 'var(--uat-danger)' }}>
                    {xianxia ? '校驗與留影術式必須歸屬某一試煉，否則無法啟陣。'
                      : '檢查與截圖一定要指定所屬 TC，否則執行會被擋下來——結果不知道要回寫到哪一筆。'}
                  </span>
                )}
              </label>
            )}
            <label>{xianxia ? '術式類別' : '動作類型'}<select className="uat-field" value={selected.action} onChange={event => updateSelected({ ...createStep(event.target.value), id: selected.id, name: selected.name })}>{STEP_LIBRARY.map(item => <option value={item.action} key={item.action}>{labelFor(item.action)}</option>)}</select></label>
            {selected.action === 'goto' && <label>網址<input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="https://..." /></label>}
            {['click', 'type', 'assert_visible'].includes(selected.action) && <label>Selector<input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder="#submit 或 [data-testid=...]" /></label>}
            {selected.action === 'type' && <label>輸入內容<input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} /></label>}
            {selected.action === 'backend_snippet' && (
              <>
                <label>{xianxia ? '後樞術式' : '後台設定片段'}
                  <select className="uat-field" value={selected.snippetId ?? ''}
                    onChange={event => updateSelected({ snippetId: event.target.value })}>
                    <option value="">{snippets.length ? '請選擇' : '目前沒有片段'}</option>
                    {snippets.map(item => (
                      <option value={item.id} key={item.id}>{item.title}（{item.stepCount} 步）</option>
                    ))}
                  </select>
                </label>
                {/* ⚠️ 選了一份已經被刪掉的片段時**一定要講**——執行時會被擋下來，
                    但在編輯器裡看起來只是「沒選」，使用者會以為自己漏選了。 */}
                {selected.snippetId && !snippets.some(item => item.id === selected.snippetId) && (
                  <p className="uat-hint" style={{ color: 'var(--uat-danger)' }}>
                    這顆積木引用的片段已經不存在（可能被刪了）。請重新選一份，否則執行時會被擋下來。
                  </p>
                )}
                {(() => {
                  const picked = snippets.find(item => item.id === selected.snippetId)
                  return picked?.note ? <p className="uat-hint">{picked.note}</p> : null
                })()}
                <p className="uat-hint">
                  這一步會另開一顆瀏覽器登入後台、跑完這份設定再回來繼續。
                  ⚠️ <b>不會自動還原</b>——要還原請在腳本最後再放一顆，選還原用的那份片段。
                </p>
              </>
            )}
            {['click_viewport', 'click_xy'].includes(selected.action) && <div className="uat-field-row"><label>X<input className="uat-field" type="number" value={selected.x ?? 0} onChange={event => updateSelected({ x: Number(event.target.value) })} /></label><label>Y<input className="uat-field" type="number" value={selected.y ?? 0} onChange={event => updateSelected({ y: Number(event.target.value) })} /></label></div>}
            {selected.action === 'wait' && <label>{xianxia ? '靜候毫秒' : '等待毫秒'}<input className="uat-field" type="number" min="0" value={selected.value ?? '1000'} onChange={event => updateSelected({ value: event.target.value })} /></label>}
            {selected.action === 'repeat' && <label>{xianxia ? '周天次數' : '重複次數'}<input className="uat-field" type="number" min="1" max="50" value={selected.value ?? '2'} onChange={event => updateSelected({ value: event.target.value })} /></label>}
            {selected.action === 'find_baseline_scroll' && <><label>{xianxia ? '基準靈影' : '基準圖'}<select className="uat-field" value={selected.baselineId ?? ''} onChange={event => updateSelected({ baselineId: event.target.value })}><option value="">{xianxia ? '選取靈影' : '請選擇'}</option>{baselines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>{xianxia ? '靈紋偏移界線' : '差異門檻'}<input className="uat-field" type="number" step="0.01" min="0" max="1" value={selected.threshold ?? 0.08} onChange={event => updateSelected({ threshold: Number(event.target.value) })} /></label></>}
            {!CONTAINER_ACTIONS.has(selected.action) && <><label>{xianxia ? '陣眼失守時' : '失敗處理'}<select className="uat-field" value={selected.failureMode ?? 'inherit'} onChange={event => updateSelected({ failureMode: event.target.value as AutoStep['failureMode'] })}><option value="inherit">{xianxia ? '承襲全陣設定' : '沿用執行設定'}</option><option value="continue">{xianxia ? '續行下一陣眼' : '繼續下一步'}</option><option value="stop">{xianxia ? '立即收陣' : '立即停止'}</option><option value="retry">{xianxia ? '重演後定奪' : '重試後再判定'}</option></select></label>{selected.failureMode === 'retry' && <label>{xianxia ? '重演次數' : '重試次數'}<input className="uat-field" type="number" min="1" max="10" value={selected.retryCount ?? 1} onChange={event => updateSelected({ retryCount: Number(event.target.value) })} /></label>}</>}
            <div className="uat-inspector-actions"><button type="button" className="uat-btn is-quiet" onClick={duplicateSelected}>{xianxia ? '拓印術式' : '建立複本'}</button><button type="button" className="uat-btn is-danger" onClick={deleteSelected}>{xianxia ? '撤去陣眼' : '刪除步驟'}</button></div>
          </div>
        )}
      </aside>
    </div>
  )
}

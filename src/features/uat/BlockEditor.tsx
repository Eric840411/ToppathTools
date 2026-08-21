import { useMemo, useState, type DragEvent } from 'react'
import { XianxiaIcon } from '../../components/XianxiaIcon'
import type { AutoBaseline, AutoStep, UatThemeMode } from './types'
import { actionLabel, CATEGORY_LABELS, CONTAINER_ACTIONS, createStep, duplicateStep, findStep, removeStep, STEP_LIBRARY, updateStepTree } from './step-model'

interface Props {
  steps: AutoStep[]
  baselines: AutoBaseline[]
  selectedId: string | null
  onSelectedIdChange: (id: string | null) => void
  onChange: (steps: AutoStep[]) => void
  themeMode: UatThemeMode
}

type DragPayload = { kind: 'library'; action: string } | { kind: 'step'; id: string; parentId: string | null }

function readDrag(event: DragEvent): DragPayload | null {
  try { return JSON.parse(event.dataTransfer.getData('application/x-toppath-step')) as DragPayload } catch { return null }
}

function setChildren(tree: AutoStep[], parentId: string | null, updater: (items: AutoStep[]) => AutoStep[]): AutoStep[] {
  if (!parentId) return updater(tree)
  return tree.map(step => step.id === parentId
    ? { ...step, children: updater(step.children ?? []) }
    : { ...step, children: step.children ? setChildren(step.children, parentId, updater) : undefined })
}

function moveWithin(tree: AutoStep[], parentId: string | null, sourceId: string, targetId: string) {
  return setChildren(tree, parentId, items => {
    const from = items.findIndex(item => item.id === sourceId)
    const to = items.findIndex(item => item.id === targetId)
    if (from < 0 || to < 0 || from === to) return items
    const next = [...items]
    const [moving] = next.splice(from, 1)
    next.splice(to, 0, moving)
    return next
  })
}

function insertInto(tree: AutoStep[], parentId: string | null, step: AutoStep, beforeId?: string) {
  return setChildren(tree, parentId, items => {
    const next = [...items]
    const index = beforeId ? next.findIndex(item => item.id === beforeId) : -1
    if (index >= 0) next.splice(index, 0, step)
    else next.push(step)
    return next
  })
}

function moveAcross(tree: AutoStep[], sourceId: string, targetParentId: string | null, beforeId?: string) {
  const source = findStep(tree, sourceId)
  if (!source || source.id === targetParentId) return tree
  const targetParent = targetParentId ? findStep(tree, targetParentId) : null
  if (targetParent && findStep(source.children ?? [], targetParent.id)) return tree
  return insertInto(removeStep(tree, sourceId), targetParentId, source, beforeId)
}

function StepList({ items, parentId, selectedId, onSelect, onChange, tree, xianxia, labelFor }: {
  items: AutoStep[]
  parentId: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  onChange: (tree: AutoStep[]) => void
  tree: AutoStep[]
  xianxia: boolean
  labelFor: (action: string) => string
}) {
  const handleDrop = (event: DragEvent, beforeId?: string) => {
    event.preventDefault()
    event.stopPropagation()
    const payload = readDrag(event)
    if (!payload) return
    if (payload.kind === 'library') onChange(insertInto(tree, parentId, createStep(payload.action), beforeId))
    else if (payload.parentId === parentId && beforeId) onChange(moveWithin(tree, parentId, payload.id, beforeId))
    else onChange(moveAcross(tree, payload.id, parentId, beforeId))
  }

  return (
    <div className={`uat-block-list${parentId ? ' is-nested' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => handleDrop(event)}>
      {items.length === 0 && (
        <div className="uat-block-empty">
          <XianxiaIcon name="document" size={22} />
          <strong>{xianxia ? '將術式移入此處' : '拖曳積木到這裡'}</strong>
          <span>{xianxia ? '亦可從左側術式庫點選納入陣圖' : '也可以從左側點一下快速加入'}</span>
        </div>
      )}
      {items.map((step, index) => {
        const isContainer = CONTAINER_ACTIONS.has(step.action)
        return (
          <article
            key={step.id}
            className={`uat-step-block is-${step.action}${selectedId === step.id ? ' is-selected' : ''}`}
            draggable
            onDragStart={event => {
              event.stopPropagation()
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('application/x-toppath-step', JSON.stringify({ kind: 'step', id: step.id, parentId } satisfies DragPayload))
            }}
            onDragOver={event => event.preventDefault()}
            onDrop={event => handleDrop(event, step.id)}
            onClick={event => { event.stopPropagation(); onSelect(step.id) }}
          >
            <div className="uat-step-grip" aria-label={xianxia ? '移動術式' : '拖曳步驟'}><i /><i /><i /></div>
            <span className="uat-step-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="uat-step-copy">
              <strong>{xianxia && step.name === actionLabel(step.action) ? labelFor(step.action) : (step.name || labelFor(step.action))}</strong>
              <span>{labelFor(step.action)}{step.selector ? ` · ${step.selector}` : step.value ? ` · ${step.value}` : ''}</span>
            </div>
            {step.failureMode === 'retry' && <span className="uat-step-tag">重試 {step.retryCount ?? 1}</span>}
            {isContainer && <span className="uat-step-count">{step.children?.length ?? 0} {xianxia ? '道子術式' : '個子步驟'}</span>}
            {isContainer && (
              <div className="uat-step-children">
                <StepList items={step.children ?? []} parentId={step.id} selectedId={selectedId} onSelect={onSelect} onChange={onChange} tree={tree} xianxia={xianxia} labelFor={labelFor} />
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

export function BlockEditor({ steps, baselines, selectedId, onSelectedIdChange, onChange, themeMode }: Props) {
  const xianxia = themeMode === 'xianxia'
  const xianxiaActionLabels: Record<string, string> = {
    goto: '開啟幻境', click: '點化元件', click_viewport: '點定畫面', click_xy: '點化幻境座標', type: '注入靈文',
    wait: '靜候靈息', screenshot: '留存靈影', assert_visible: '驗證顯形', find_baseline_scroll: '尋影校驗', group: '術式陣組', repeat: '周天循環',
  }
  const labelFor = (action: string) => xianxia ? (xianxiaActionLabels[action] ?? actionLabel(action)) : actionLabel(action)
  const categoryFor = (category: string) => xianxia ? ({ browser: '幻境門', interaction: '御物術', assertion: '校驗術', evidence: '留影術', flow: '陣法控制' }[category] ?? CATEGORY_LABELS[category]) : CATEGORY_LABELS[category]
  const [librarySearch, setLibrarySearch] = useState('')
  const selected = useMemo(() => selectedId ? findStep(steps, selectedId) : null, [steps, selectedId])
  const filteredLibrary = STEP_LIBRARY.filter(item => `${item.label}${item.description}`.toLowerCase().includes(librarySearch.toLowerCase()))
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
    <div className="uat-editor-grid">
      <aside className="uat-block-library">
        <div className="uat-pane-heading">
          <div><span>{xianxia ? 'TECHNIQUES' : 'BLOCKS'}</span><h3>{xianxia ? '術式庫' : '積木庫'}</h3></div>
        </div>
        <input className="uat-field" value={librarySearch} onChange={event => setLibrarySearch(event.target.value)} placeholder={xianxia ? '尋找術式' : '搜尋積木'} />
        {Object.keys(CATEGORY_LABELS).map(category => {
          const items = filteredLibrary.filter(item => item.category === category)
          if (!items.length) return null
          return <section className="uat-library-group" key={category}>
            <h4>{categoryFor(category)}</h4>
            {items.map(item => (
              <button
                type="button"
                className={`uat-library-block is-${item.action}`}
                key={item.action}
                draggable
                onDragStart={event => event.dataTransfer.setData('application/x-toppath-step', JSON.stringify({ kind: 'library', action: item.action } satisfies DragPayload))}
                onClick={() => addStep(item.action)}
              >
                <span className="uat-library-mark" />
                <span><strong>{labelFor(item.action)}</strong><small>{xianxia ? `納入${categoryFor(category)}陣列` : item.description}</small></span>
              </button>
            ))}
          </section>
        })}
      </aside>

      <section className="uat-canvas" onClick={() => onSelectedIdChange(null)}>
        <div className="uat-pane-heading">
          <div><span>{xianxia ? 'TRIAL ARRAY' : 'WORKFLOW'}</span><h3>{xianxia ? '試煉陣圖' : '測試流程'}</h3></div>
          <small>{steps.length} {xianxia ? '處陣眼' : '個區塊'}</small>
        </div>
        <StepList items={steps} parentId={null} selectedId={selectedId} onSelect={onSelectedIdChange} onChange={onChange} tree={steps} xianxia={xianxia} labelFor={labelFor} />
      </section>

      <aside className="uat-inspector">
        <div className="uat-pane-heading">
          <div><span>{xianxia ? 'ARRAY EYE' : 'INSPECTOR'}</span><h3>{xianxia ? '陣眼設定' : '步驟設定'}</h3></div>
        </div>
        {!selected ? (
          <div className="uat-inspector-empty"><XianxiaIcon name="settings" size={28} /><strong>{xianxia ? '選取一處陣眼' : '選取一個積木'}</strong><span>{xianxia ? '點選陣圖中的術式即可調校' : '點擊中央步驟即可編輯細節'}</span></div>
        ) : (
          <div className="uat-inspector-form">
            <label>{xianxia ? '術式名號' : '步驟名稱'}<input className="uat-field" value={selected.name} onChange={event => updateSelected({ name: event.target.value })} /></label>
            <label>{xianxia ? '術式類別' : '動作類型'}<select className="uat-field" value={selected.action} onChange={event => updateSelected({ ...createStep(event.target.value), id: selected.id, name: selected.name })}>{STEP_LIBRARY.map(item => <option value={item.action} key={item.action}>{labelFor(item.action)}</option>)}</select></label>
            {selected.action === 'goto' && <label>網址<input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="https://..." /></label>}
            {['click', 'type', 'assert_visible'].includes(selected.action) && <label>Selector<input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder="#submit 或 [data-testid=...]" /></label>}
            {selected.action === 'type' && <label>輸入內容<input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} /></label>}
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

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

/**
 * TC 在畫面上的短標籤。
 *
 * 🚨 **實際資料裡編號既不唯一也不一定有**（2026-09-18 拉真表確認：100 筆裡
 * 有 16 個編號重複、14 筆根本沒編號）。所以沒編號時退回敘述的前幾個字，
 * 再沒有才用 recordId。
 *
 * ⚠️ **不要用 `??` 去接編號**：空字串不是 null，`??` 不會觸發，結果是渲染出一個
 * **空的標籤**——看起來像「這一步沒歸屬」，但它其實有。這就是原本的寫法。
 */
export function tcShortLabel(tc: TcBindingOption | undefined, recordId: string) {
  if (!tc) return `已失效的 TC（${recordId.slice(0, 8)}…）`
  return tc.number || (tc.text ? tc.text.slice(0, 12) : '') || tc.recordId.slice(0, 8)
}

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
const TC_REQUIRED_ACTIONS = new Set(['assert_visible', 'assert_api_called', 'find_baseline_scroll', 'screenshot', 'assert_pc_scene', 'assert_pc_node', 'assert_ws_called', 'assert_text', 'assert_compare', 'assert_row_match', 'assert_video_playing', 'read_value'])
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
          <strong>{'這裡還沒有步驟'}</strong>
          <span>{'用上方的「新增步驟」加入，或先錄一段'}</span>
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
              <button type="button" aria-label={'往上移'} disabled={index === 0}
                onClick={event => { event.stopPropagation(); onChange(nudge(tree, parentId, step.id, -1)) }}>▲</button>
              <button type="button" aria-label={'往下移'} disabled={index === items.length - 1}
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
                : needsTc(step.action) && <span className="uat-step-tag is-danger">{'未指定 TC'}</span>
            ) : null}
            {step.failureMode === 'retry' && <span className="uat-step-tag">重試 {step.retryCount ?? 1}</span>}
            {isContainer && <span className="uat-step-count">{step.children?.length ?? 0} {'個子步驟'}</span>}
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
  // v5.8.1 使用者：修仙版的 UAT 內文用普通版用語（標題保留修仙版）→ 積木名稱、分類一律用普通版。修仙名稱表留著，之後要改回只要換這兩行
  void xianxiaActionLabels
  const labelFor = (action: string) => actionLabel(action)
  const categoryFor = (category: string) => CATEGORY_LABELS[category]
  const selected = useMemo(() => selectedId ? findStep(steps, selectedId) : null, [steps, selectedId])
  // ⚠️ 找不到不要顯示成空白：那看起來像「沒綁」，但它其實綁了一個已經不在清單裡的 TC
  const tcLabel = bindings.length
    ? (recordId: string) => tcShortLabel(bindings.find(item => item.recordId === recordId), recordId)
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
            <option value="">{'＋ 新增步驟'}</option>
            {Object.keys(CATEGORY_LABELS).map(category => {
              const items = STEP_LIBRARY.filter(item => item.category === category)
              if (!items.length) return null
              return <optgroup label={categoryFor(category)} key={category}>
                {items.map(item => <option value={item.action} key={item.action}>{labelFor(item.action)}</option>)}
              </optgroup>
            })}
          </select>
          <small>{steps.length} {'個區塊'}</small>
        </div>
        <StepList items={steps} parentId={null} selectedId={selectedId} onSelect={onSelectedIdChange} onChange={onChange} tree={steps} xianxia={xianxia} labelFor={labelFor} tcLabel={tcLabel} />
      </section>

      <aside className="uat-inspector">
        <div className="uat-pane-heading">
          <div><span>{xianxia ? 'ARRAY EYE' : 'INSPECTOR'}</span><h3>{xianxia ? '陣眼設定' : '步驟設定'}</h3></div>
        </div>
        {!selected ? (
          <div className="uat-inspector-empty"><XianxiaIcon name="settings" size={28} /><strong>{'選取一個積木'}</strong><span>{'點左邊清單裡的步驟就能編輯細節'}</span></div>
        ) : (
          <div className="uat-inspector-form">
            <label>{'步驟名稱'}<input className="uat-field" value={selected.name} onChange={event => updateSelected({ name: event.target.value })} /></label>
            {/* 綁了 TC 才出現。⚠️ 沒綁的腳本硬給一個空選單，會讓人以為自己漏填了 */}
            {!!bindings.length && (
              <label>{'所屬 TC'}
                <select className="uat-field" value={selected.tcId ?? ''} onChange={event => updateSelected({ tcId: event.target.value })}>
                  <option value="">{'共用步驟（不屬於任何 TC）'}</option>
                  {bindings.map(item => <option value={item.recordId} key={item.recordId}>{item.number || item.recordId} {item.text}</option>)}
                </select>
                {needsTc(selected.action) && !selected.tcId && (
                  <span className="uat-hint" style={{ color: 'var(--uat-danger)' }}>
                    {'檢查與截圖一定要指定所屬 TC，否則執行會被擋下來——結果不知道要回寫到哪一筆。'}
                  </span>
                )}
              </label>
            )}
            <label>{'動作類型'}<select className="uat-field" value={selected.action} onChange={event => updateSelected({ ...createStep(event.target.value), id: selected.id, name: selected.name })}>{STEP_LIBRARY.map(item => <option value={item.action} key={item.action}>{labelFor(item.action)}</option>)}</select></label>
            {selected.action === 'goto' && <label>網址<input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="https://..." /></label>}
            {selected.action === 'goto' && <label>導頁後等待毫秒<input className="uat-field" type="number" min="0" max="30000" value={selected.settleMs ?? 3000} onChange={event => updateSelected({ settleMs: event.target.value === '' ? undefined : Number(event.target.value) })} /><span className="uat-hint">預設 3000。要截載入畫面（例：左下角版本號）填 0，不然截到的會是大廳</span></label>}
            {selected.action === 'popup_watch' && <label>自動關彈窗<select className="uat-field" value={selected.value || 'pause'} onChange={event => updateSelected({ value: event.target.value })}><option value="pause">暫停（要驗彈窗本身時，放在彈窗出現之前）</option><option value="resume">恢復</option></select><span className="uat-hint">執行期間工具每 1.5 秒自動關大廳彈窗；要截圖或點彈窗（例：廣告 JP 彈框）就先暫停</span></label>}
            {['click', 'type', 'assert_visible', 'scroll'].includes(selected.action) && <label>Selector<input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder="#submit 或 [data-testid=...]" /></label>}
            {selected.action === 'assert_ws_called' && (
              <>
                <label>WS route
                  <input className="uat-field uat-code-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="dealGMActionReq" />
                </label>
                <label>payload 要含（可留空）
                  <input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder="isspin:1" />
                  <span className="uat-hint">比對時會去掉引號與空白，所以寫 isspin:1 就好</span>
                </label>
                <label>至少幾筆<input className="uat-field" type="number" min="1" value={selected.minCount ?? 1} onChange={event => updateSelected({ minCount: Number(event.target.value) })} /></label>
              </>
            )}
            {['click', 'click_viewport', 'click_xy', 'pc_click_node'].includes(selected.action) && (
              <label className="uat-checkline">
                <input type="checkbox" checked={selected.allowDangerous === true} onChange={event => updateSelected({ allowDangerous: event.target.checked })} />
                允許這個危險操作（預約／帶入額度／充值…）
                <span className="uat-hint">沒勾的話，腳本跑到會真的預約機台或動到餘額的按鈕時會停下來。放行只對這一顆有效；正式環境一律不放行</span>
              </label>
            )}
            {selected.action === 'read_value' && (
              <>
                <label>DOM 選擇器（H5，二選一）
                  <input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder=".balance-value" />
                </label>
                <label>Cocos 節點名／路徑（PC，二選一）
                  <input className="uat-field uat-code-field" value={selected.nodeName ?? ''} onChange={event => updateSelected({ nodeName: event.target.value })} placeholder="lb_coin" />
                </label>
                <label>存成變數名
                  <input className="uat-field uat-code-field" value={selected.as ?? ''} onChange={event => updateSelected({ as: event.target.value })} placeholder="beforeBalance" />
                </label>
                <label>只取一段（選填，正規式）
                  <input className="uat-field uat-code-field" value={selected.pattern ?? ''} onChange={event => updateSelected({ pattern: event.target.value || undefined })} placeholder="less than ([\d,]*\d)" />
                  <span className="uat-hint">用括號包住要存的那段，存第 1 組（取數字用 <code>([\d,]*\d)</code>，結尾限定數字才不會吃到後面的逗號）；對不到會讓這步失敗並顯示讀到的整句，不會存空值。留空＝存整段文字</span>
                </label>
                <label className="uat-checkline">
                  <input type="checkbox" checked={selected.overwrite === true} onChange={event => updateSelected({ overwrite: event.target.checked })} />
                  允許覆寫同名變數
                  <span className="uat-hint">預設不允許——同名靜默覆寫會讓後面引用到哪一次讀的值完全看不出來</span>
                </label>
              </>
            )}
            {selected.action === 'assert_compare' && (
              <>
                <label>左邊算式
                  <input className="uat-field uat-code-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="beforeBalance - betAmount" />
                </label>
                <label>右邊算式
                  <input className="uat-field uat-code-field" value={selected.expect ?? ''} onChange={event => updateSelected({ expect: event.target.value })} placeholder="afterBalance" />
                  <span className="uat-hint">支援 + - * / 與括號；變數就是上面「讀成變數」存的名字</span>
                </label>
                <label>容差（%）<input className="uat-field" type="number" value={selected.tolerancePct ?? 0} onChange={event => updateSelected({ tolerancePct: Number(event.target.value) })} /></label>
                <label>絕對容差<input className="uat-field" type="number" value={selected.absoluteTolerance ?? 0} onChange={event => updateSelected({ absoluteTolerance: Number(event.target.value) })} /></label>
              </>
            )}
            {selected.action === 'wait_for' && (
              <>
                <label>等什麼
                  <select className="uat-field" value={selected.until ?? 'visible'} onChange={event => updateSelected({ until: event.target.value as 'visible' | 'hidden' | 'text' | 'node' })}>
                    <option value="visible">元素出現</option>
                    <option value="hidden">元素消失（例如 loading 結束）</option>
                    <option value="text">畫面出現這段文字</option>
                    <option value="node">PC：場景節點出現</option>
                  </select>
                </label>
                {(selected.until ?? 'visible') !== 'node' && (selected.until ?? 'visible') !== 'text' && (
                  <label>DOM 選擇器<input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder=".el-table__body tr" /></label>
                )}
                {selected.until === 'text' && (
                  <label>要出現的文字<input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="Success" /></label>
                )}
                {selected.until === 'node' && (
                  <label>Cocos 節點名／路徑<input className="uat-field uat-code-field" value={selected.nodeName ?? ''} onChange={event => updateSelected({ nodeName: event.target.value })} placeholder="btn_spin" /></label>
                )}
                <label>最多等幾毫秒
                  <input className="uat-field" type="number" value={selected.timeoutMs ?? 15000} onChange={event => updateSelected({ timeoutMs: Number(event.target.value) })} />
                  <span className="uat-hint">等不到就是失敗——不會默默往下跑</span>
                </label>
              </>
            )}
            {selected.action === 'assert_text' && (
              <>
                <label>DOM 選擇器（H5，二選一）
                  <input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder=".balance-value" />
                </label>
                <label>Cocos 節點名／路徑（PC，二選一）
                  <input className="uat-field uat-code-field" value={selected.nodeName ?? ''} onChange={event => updateSelected({ nodeName: event.target.value })} placeholder="lb_coin" />
                  <span className="uat-hint">PC 的文字是 label，直接讀得到——不需要 OCR</span>
                </label>
                <label>比對方式
                  <select className="uat-field" value={selected.matchMode ?? 'contains'} onChange={event => updateSelected({ matchMode: event.target.value as 'contains' | 'equals' | 'regex' | 'number' })}>
                    <option value="contains">包含</option>
                    <option value="equals">完全相等</option>
                    <option value="regex">正則</option>
                    <option value="number">數值比較</option>
                  </select>
                </label>
                <label>期望值
                  <input className="uat-field uat-code-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder={selected.matchMode === 'number' ? '>=100' : 'Good Fortune'} />
                  <span className="uat-hint">數值模式可帶比較符號：{'>='}100、{'<'}50、=0；比對前會去掉千分位與貨幣符號</span>
                </label>
              </>
            )}
            {selected.action === 'require_precondition' && (
              <>
                <label>DOM 選擇器（H5，二選一）
                  <input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder=".lucky-bonus-entry" />
                </label>
                <label>Cocos 節點名（PC，二選一）
                  <input className="uat-field uat-code-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="btn-activity" />
                </label>
                <label>不成立時的說明（必填）
                  <input className="uat-field" value={selected.reason ?? ''} onChange={event => updateSelected({ reason: event.target.value })} placeholder="Lucky Hour Bonus 活動時段沒開，這條 TC 沒東西可測" />
                  <span className="uat-hint">⚠️ 若「那個條件」本身就是這條 TC 要驗的東西，就不該用這顆——那是 FAIL 不是受阻</span>
                </label>
              </>
            )}
            {selected.action === 'press_key' && (
              <label>按鍵
                <input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="Space / Enter / ArrowDown" />
                <span className="uat-hint">會先點一下畫布中央偏上讓焦點回到頁面，再按鍵（Cocos 是掛在 document 上聽鍵盤的）</span>
              </label>
            )}
            {selected.action === 'scroll' && (
              <label>捲動量
                <input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="top / bottom / 600（px，負數往上）" />
                <span className="uat-hint">填了 Selector 又不填這欄＝把那個元素捲進畫面。沒填 Selector 時會自己找真的捲得動的容器（行動版常常不是 window 在捲）</span>
              </label>
            )}
            {selected.action === 'pc_scroll' && (
              <>
                <label>捲到哪
                  <input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="top / bottom / 0.3，或 find:節點名" />
                </label>
                <label>清單節點（可留空）
                  <input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder="ScrollView-jp（排行榜）；留空＝大廳清單" />
                  <span className="uat-hint">🚨 開著別的頁面時**一定要指定**：不指定會去捲被蓋在底下的大廳清單，然後回報成功——畫面卻沒動</span>
                </label>
              </>
            )}
            {selected.action === 'type' && <label>輸入內容<input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} /><span className="uat-hint">可以寫 {'{{變數}}'}（前面用「讀值」存的），例如 {'{{machineNo}}'}；變數不存在或是空的會直接判失敗</span></label>}
            {/* PC（Cocos）：沒有 DOM 可選，所以欄位問的是機台與場景，不是 selector */}
            {['pc_click_node', 'assert_pc_node'].includes(selected.action) && (
              <label>節點
                <input className="uat-field uat-code-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="btn-road（節點名）或 Road（畫面上的字）" />
                <span className="uat-hint">先比節點名稱、再比標籤文字，**都要完全相等**——模糊比對會點到隔壁那顆按鈕，而畫面上看起來只是「沒反應」{selected.action === 'pc_click_node' ? <>。可以寫 {'{{變數}}'}，例如 {'menu_ScrollView>view>content>{{game}}'}</> : null}</span>
              </label>
            )}
            {selected.action === 'assert_pc_node' && (
              <label className="uat-check">
                <input type="checkbox" checked={selected.inViewport === true} onChange={event => updateSelected({ inViewport: event.target.checked || undefined })} />必須在畫面內
                <span className="uat-hint">勾了：節點中心要在視窗內、也在清單的可視區（遮罩）內，而且捲動停下來才算；不在就判失敗。不勾：只要節點存在就通過（在視窗外只記一筆提醒）。只看中心點，不保證整列完整顯示</span>
              </label>
            )}
            {selected.action === 'pc_click_node' && (
              <label className="uat-check">
                <input type="checkbox" checked={selected.skipIfMissing === true} onChange={event => updateSelected({ skipIfMissing: event.target.checked || undefined })} />找不到就跳過
                <span className="uat-hint">勾了：等 3 秒還是找不到這個節點 → 記成「跳過」，不算失敗（例如大廳廣告有時候不出現）。場景樹讀不到、或找到了卻點不到 → 照樣判失敗</span>
              </label>
            )}
            {selected.action === 'pc_enter_machine' && (
              <label>機台
                <input className="uat-field" value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })} placeholder="Coin Combo（同款隨機挑空的）、4186-COINCOMBO-0138（指定），或留空／*（任一台空機）" />
                <span className="uat-hint">只填遊戲名＝同款裡隨機挑一台空的；填 gmid 或卡片名稱＝指定那一台；留空或 *＝整個大廳隨機挑一台空機。空機＝沒人、沒鎖定、沒離線；都沒有空機會等 15 秒（剛有人離開約 8 秒才釋放）再判失敗。挑了哪一台、實際進到哪一台都會寫進日誌，進錯台算失敗</span>
              </label>
            )}
            {selected.action === 'assert_pc_scene' && (
              <>
                <label>預期場景
                  <select className="uat-field" value={selected.value ?? 'lobby'} onChange={event => updateSelected({ value: event.target.value })}>
                    <option value="lobby">大廳（lobby）</option>
                    <option value="game">機台內（game）</option>
                  </select>
                </label>
                <label>機台名稱（可留空）
                  <input className="uat-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder="Rising Rockets Emperor-141" />
                  <span className="uat-hint">填了就會當場從場景樹讀「現在人在哪一台」來核對——實測點座標會點到隔壁機台，不核對看不出來</span>
                </label>
              </>
            )}
            {selected.action === 'backend_snippet' && (
              <>
                <label>{'後台設定片段'}
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
                <label>讀回的資料存成變數名（選填）
                  <input className="uat-field uat-code-field" value={selected.as ?? ''} onChange={event => updateSelected({ as: event.target.value })} placeholder="jp" />
                  <span className="uat-hint">片段裡有「讀取表格」時填。例：片段存成 rows、這裡填 jp → 後面用 <code>jp.rows</code>。片段結束時的後台畫面會自動截圖當證據</span>
                </label>
              </>
            )}
            {selected.action === 'assert_row_match' && (
              <>
                <label>表格變數
                  <input className="uat-field uat-code-field" value={selected.from ?? ''} onChange={event => updateSelected({ from: event.target.value })} placeholder="jp.rows" />
                </label>
                <label>條件（一行一條，全部符合的列至少要有一列）
                  <textarea className="uat-field uat-code-field" rows={4} value={selected.value ?? ''} onChange={event => updateSelected({ value: event.target.value })}
                    placeholder={'Jackpot Amount = {{amount}}\nBet Time = {{time}}\nClient Announcement Time @now'} />
                  <span className="uat-hint"><code>=</code> 相等（像數字就比數值）、<code>^=</code> 開頭是、<code>*=</code> 包含、<code>~=</code> 遮罩（te*****aa）、<code>@now</code> 欄位「起 To 迄」要包含現在。<code>{'{{變數}}'}</code> 會換成前面「讀成變數」的值</span>
                </label>
              </>
            )}
            {selected.action === 'assert_video_playing' && (
              <>
                <label>影片選擇器
                  <input className="uat-field uat-code-field" value={selected.selector ?? ''} onChange={event => updateSelected({ selector: event.target.value })} placeholder="video（預設）" />
                </label>
                <div className="uat-field-row">
                  <label>至少前進秒數<input className="uat-field" type="number" min="0.1" step="0.1" value={selected.minAdvanceSec ?? 0.5} onChange={event => updateSelected({ minAdvanceSec: Number(event.target.value) })} /></label>
                  <label>最多等毫秒<input className="uat-field" type="number" min="1000" value={selected.timeoutMs ?? 8000} onChange={event => updateSelected({ timeoutMs: Number(event.target.value) })} /></label>
                </div>
              </>
            )}
            {['click_viewport', 'click_xy'].includes(selected.action) && <div className="uat-field-row"><label>X<input className="uat-field" type="number" value={selected.x ?? 0} onChange={event => updateSelected({ x: Number(event.target.value) })} /></label><label>Y<input className="uat-field" type="number" value={selected.y ?? 0} onChange={event => updateSelected({ y: Number(event.target.value) })} /></label></div>}
            {selected.action === 'wait' && <label>{'等待毫秒'}<input className="uat-field" type="number" min="0" value={selected.value ?? '1000'} onChange={event => updateSelected({ value: event.target.value })} /></label>}
            {selected.action === 'repeat' && <label>{'重複次數'}<input className="uat-field" type="number" min="1" max="50" value={selected.value ?? '2'} onChange={event => updateSelected({ value: event.target.value })} /></label>}
            {selected.action === 'find_baseline_scroll' && <><label>{'基準圖'}<select className="uat-field" value={selected.baselineId ?? ''} onChange={event => updateSelected({ baselineId: event.target.value })}><option value="">{'請選擇'}</option>{baselines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>{'差異門檻'}<input className="uat-field" type="number" step="0.01" min="0" max="1" value={selected.threshold ?? 0.08} onChange={event => updateSelected({ threshold: Number(event.target.value) })} /></label></>}
            {!CONTAINER_ACTIONS.has(selected.action) && <><label>{'失敗處理'}<select className="uat-field" value={selected.failureMode ?? 'inherit'} onChange={event => updateSelected({ failureMode: event.target.value as AutoStep['failureMode'] })}><option value="inherit">{'沿用執行設定'}</option><option value="continue">{'繼續下一步'}</option><option value="stop">{'立即停止'}</option><option value="retry">{'重試後再判定'}</option></select></label>{selected.failureMode === 'retry' && <label>{'重試次數'}<input className="uat-field" type="number" min="1" max="10" value={selected.retryCount ?? 1} onChange={event => updateSelected({ retryCount: Number(event.target.value) })} /></label>}</>}
            <div className="uat-inspector-actions"><button type="button" className="uat-btn is-quiet" onClick={duplicateSelected}>{'建立複本'}</button><button type="button" className="uat-btn is-danger" onClick={deleteSelected}>{'刪除步驟'}</button></div>
          </div>
        )}
      </aside>
    </div>
  )
}

import type { AutoStep } from './types'

export const STEP_LIBRARY = [
  { action: 'goto', label: '前往頁面', category: 'browser', description: '開啟指定網址' },
  { action: 'click', label: '點擊元素', category: 'interaction', description: '用 selector 點擊元素' },
  { action: 'click_viewport', label: '點擊畫面', category: 'interaction', description: '點擊 viewport 座標' },
  { action: 'click_xy', label: '點擊 Canvas', category: 'interaction', description: '點擊 Canvas 內座標' },
  { action: 'type', label: '輸入文字', category: 'interaction', description: '在欄位輸入內容' },
  { action: 'wait', label: '等待', category: 'browser', description: '等待指定毫秒' },
  { action: 'press_key', label: '按鍵盤', category: 'interaction', description: '按一個鍵（Space／Enter／ArrowDown…）。PC 機台內的 SPIN 就是靠空白鍵或 Enter' },
  { action: 'scroll', label: '捲動畫面', category: 'interaction', description: '捲動頁面或指定容器：填 top／bottom／px 數字；填了 Selector 且不填數值＝把那個元素捲進畫面' },
  { action: 'pc_scroll', label: 'PC 捲動清單', category: 'interaction', description: 'PC 版：把大廳的機台清單捲到 top／bottom／0~1 的比例位置' },
  { action: 'screenshot', label: '截圖', category: 'evidence', description: '擷取目前畫面' },
  { action: 'assert_visible', label: '驗證可見', category: 'assertion', description: '確認元素出現在畫面' },
  { action: 'find_baseline_scroll', label: '尋找基準圖', category: 'assertion', description: '捲動並比對基準圖' },
  { action: 'assert_ws_called', label: '這個 WS 訊息必須送出', category: 'assertion', description: 'OSM 的業務走 WS(pinus)：這一步要送出指定的 route（例 dealGMActionReq），可再指定 payload 片段（例 isspin:1）' },
  { action: 'assert_api_called', label: '這支 API 必須被呼叫', category: 'assertion', description: '這一步要打到指定的後端 API，而且狀態碼要符合' },
  { action: 'assert_text', label: '驗文字／數字', category: 'assertion', description: 'H5 讀 DOM、PC 讀 Cocos label（不是 OCR）。可比包含／完全相等／正則，或數值比較（>=100、<50）' },
  { action: 'read_value', label: '讀成變數', category: 'flow', description: '把畫面上的一個值（H5 的 DOM 文字或 PC 的 Cocos label）存成變數，之後用「比對兩個值」對照' },
  { action: 'assert_compare', label: '比對兩個值／算式', category: 'assertion', description: '例：左邊填 before - bet，右邊填 after。支援 + - * / 與括號、容差' },
  { action: 'wait_for', label: '等到…出現／消失', category: 'flow', description: '等元素出現／消失、文字出現、或 PC 節點出現；條件成立就立刻往下走（取代猜秒數的等待）' },
  { action: 'require_precondition', label: '前置條件（不符判受阻）', category: 'flow', description: '環境要備好才測得了（例：活動要開著、要有第二台空機）。不成立時整筆 TC 判「受阻」——不是 FAIL，避免對 Lark 謊報一個不存在的 bug' },
  { action: 'backend_snippet', label: '後台設定', category: 'backend', description: '跑一份後台設定片段（例如把某個開關打開），完成後回到前端繼續' },
  // ⚠️ PC（Cocos）專用：畫面是一張 canvas，沒有 DOM 可選，所以 H5 那套選擇器積木在 PC 上一律命中 0。
  //    這兩顆讀的是 Cocos 場景樹。
  { action: 'pc_enter_machine', label: 'PC 進機台', category: 'interaction', description: 'PC 版：等大廳就緒、挑一台可用的機台並進入（讀 Cocos 場景樹，不用座標）' },
  { action: 'pc_click_node', label: 'PC 點節點', category: 'interaction', description: 'PC 版：點場景樹裡的某個節點（填節點名如 btn-road，或畫面上的字如 Road）' },
  { action: 'assert_pc_node', label: 'PC 驗節點', category: 'assertion', description: 'PC 版：確認場景樹裡有這個節點且看得見（面板打開後用它驗）' },
  { action: 'assert_pc_scene', label: 'PC 驗場景', category: 'assertion', description: 'PC 版：確認目前在大廳或機台內；填機台名稱時會核對「實際進到哪一台」' },
  { action: 'group', label: '步驟群組', category: 'flow', description: '整理一組可收合步驟' },
  { action: 'repeat', label: '重複區塊', category: 'flow', description: '依次數重複子步驟' },
] as const

export const CATEGORY_LABELS: Record<string, string> = {
  browser: '瀏覽器', interaction: '互動', assertion: '驗證', evidence: '證據', flow: '流程控制', backend: '後台連動',
}

export const CONTAINER_ACTIONS = new Set(['group', 'repeat'])

/**
 * 產生一個 id。
 *
 * 🚨 **不能直接用 `crypto.randomUUID()`。** 它**只在安全情境（HTTPS 或 localhost）存在**；
 *    使用者從區網 IP（`http://192.168.x.x:3000`）或隧道開這個工具時它根本不存在，
 *    `createStep()` 一呼叫就丟 `crypto.randomUUID is not a function`。
 *
 *    而 `parseSteps()` 外面包著 try/catch → **整份步驟被吃掉變成空陣列**，
 *    症狀是「**每一份腳本都顯示 0 區塊、編輯器說還沒有步驟**」，
 *    但資料庫裡步驟好好的、TC 綁定也讀得出來（綁定沒走 createStep）。
 *    2026-09-19 實測：localhost `isSecureContext: true`、區網 IP `false`。
 *
 * 🚨 **而且這不只是顯示問題**：畫面顯示 0 步驟時按「儲存腳本」，存回去的就是空的——
 *    會把那份腳本的步驟真的清掉。
 */
export function newStepId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // 不安全情境的退路：getRandomValues 沒有這個限制
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createStep(action = 'goto'): AutoStep {
  const definition = STEP_LIBRARY.find(item => item.action === action)
  const step: AutoStep = {
    id: newStepId(),
    name: definition?.label ?? action,
    action,
    failureMode: 'inherit',
  }
  if (action === 'wait') step.value = '1000'
  if (action === 'repeat') {
    step.value = '2'
    step.children = []
  }
  if (action === 'group') step.children = []
  if (action === 'assert_api_called') { step.expectStatus = '2xx'; step.minCount = 1 }
  return step
}

function normalizeOne(item: unknown, index: number): AutoStep {
  if (typeof item === 'string') return { ...createStep('wait'), name: item, value: '1000' }
  if (!item || typeof item !== 'object') return { ...createStep('wait'), name: `步驟 ${index + 1}`, value: '1000' }
  const row = item as Record<string, unknown>
  const rawAction = typeof row.action === 'string' && row.action ? row.action : 'wait'
  const action = rawAction === 'fill' ? 'type' : rawAction
  const step = createStep(action)
  step.id = typeof row.id === 'string' && row.id ? row.id : step.id
  step.name = typeof row.name === 'string' ? row.name : typeof row.title === 'string' ? row.title : step.name
  if (typeof row.value === 'string') step.value = row.value
  if (typeof row.selector === 'string') step.selector = row.selector
  if (typeof row.x === 'number') step.x = row.x
  if (typeof row.y === 'number') step.y = row.y
  if (typeof row.baselineId === 'string') step.baselineId = row.baselineId
  if (typeof row.threshold === 'number') step.threshold = row.threshold
  if (typeof row.scrollStep === 'number') step.scrollStep = row.scrollStep
  if (typeof row.maxScrolls === 'number') step.maxScrolls = row.maxScrolls
  if (typeof row.urlPattern === 'string') step.urlPattern = row.urlPattern
  if (typeof row.snippetId === 'string') step.snippetId = row.snippetId
  if (typeof row.tcId === 'string') step.tcId = row.tcId
  if (row.expectStatus === '2xx' || row.expectStatus === 'any' || row.expectStatus === 'exact') step.expectStatus = row.expectStatus
  if (typeof row.statusCode === 'number') step.statusCode = row.statusCode
  if (typeof row.minCount === 'number') step.minCount = row.minCount
  if (typeof row.selectorStrategy === 'string') step.selectorStrategy = row.selectorStrategy
  if (typeof row.selectorCheck === 'string') step.selectorCheck = row.selectorCheck
  if (typeof row.selectorCheckReason === 'string') step.selectorCheckReason = row.selectorCheckReason
  if (typeof row.retryCount === 'number') step.retryCount = row.retryCount
  if (row.failureMode === 'continue' || row.failureMode === 'stop' || row.failureMode === 'retry') step.failureMode = row.failureMode
  if (Array.isArray(row.children)) step.children = row.children.map(normalizeOne)
  return step
}

export function parseSteps(raw: string): AutoStep[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map(normalizeOne) : []
  } catch {
    return []
  }
}

export function serializeSteps(steps: AutoStep[]) {
  return JSON.stringify(steps.map(cleanStep))
}

function cleanStep(step: AutoStep): Record<string, unknown> {
  const row: Record<string, unknown> = { id: step.id, name: step.name.trim() || actionLabel(step.action), action: step.action }
  // ⚠️ 新增參數欄位時**這兩行一定要一起加**。漏了的話步驟在畫面上編得好好的，
  //    存檔（serialize）之後參數就消失了，而且不會有任何錯誤——重新載入才發現變空的。
  //
  // 🚨 **上面 `normalizeOne()` 那一長串也要一起加。** 白名單有兩份——寫出去一份、
  //    讀回來一份——只補這裡的話欄位存得進去卻讀不回來，症狀一模一樣（重載後變空的），
  //    但查起來更難，因為資料庫裡明明看得到。`snippetId` 就這樣漏過一次。
  for (const key of ['value', 'selector', 'baselineId', 'urlPattern', 'snippetId', 'tcId', 'selectorStrategy', 'selectorCheck', 'selectorCheckReason'] as const) if (step[key]?.trim()) row[key] = step[key]?.trim()
  for (const key of ['x', 'y', 'threshold', 'scrollStep', 'maxScrolls', 'retryCount', 'statusCode', 'minCount'] as const) if (typeof step[key] === 'number') row[key] = step[key]
  if (step.expectStatus) row.expectStatus = step.expectStatus
  if (step.failureMode && step.failureMode !== 'inherit') row.failureMode = step.failureMode
  if (CONTAINER_ACTIONS.has(step.action)) row.children = (step.children ?? []).map(cleanStep)
  return row
}

export function compileExecutableSteps(steps: AutoStep[]): AutoStep[] {
  const output: AutoStep[] = []
  for (const step of steps) {
    if (step.action === 'group') {
      output.push(...compileExecutableSteps(step.children ?? []))
      continue
    }
    if (step.action === 'repeat') {
      const count = Math.min(50, Math.max(1, Number(step.value) || 1))
      for (let i = 0; i < count; i++) {
        output.push(...compileExecutableSteps(step.children ?? []).map(child => ({ ...child, name: `${child.name}（${i + 1}/${count}）` })))
      }
      continue
    }
    output.push({ ...step, children: undefined })
  }
  return output
}

export function actionLabel(action: string) {
  return STEP_LIBRARY.find(item => item.action === action)?.label ?? action
}

export function findStep(steps: AutoStep[], id: string): AutoStep | null {
  for (const step of steps) {
    if (step.id === id) return step
    const nested = findStep(step.children ?? [], id)
    if (nested) return nested
  }
  return null
}

export function updateStepTree(steps: AutoStep[], id: string, patch: Partial<AutoStep>): AutoStep[] {
  return steps.map(step => step.id === id ? { ...step, ...patch } : { ...step, children: step.children ? updateStepTree(step.children, id, patch) : undefined })
}

export function removeStep(steps: AutoStep[], id: string): AutoStep[] {
  return steps.filter(step => step.id !== id).map(step => ({ ...step, children: step.children ? removeStep(step.children, id) : undefined }))
}

export function duplicateStep(step: AutoStep): AutoStep {
  return { ...step, id: newStepId(), name: `${step.name}（複本）`, children: step.children?.map(duplicateStep) }
}

export function countExecutableSteps(steps: AutoStep[]) {
  return compileExecutableSteps(steps).length
}

export function moveTopLevel(steps: AutoStep[], sourceId: string, targetId: string) {
  const from = steps.findIndex(step => step.id === sourceId)
  const to = steps.findIndex(step => step.id === targetId)
  if (from < 0 || to < 0 || from === to) return steps
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

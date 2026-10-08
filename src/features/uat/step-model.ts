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
  { action: 'assert_row_match', label: '表格要有一筆符合', category: 'assertion', description: '拿前台讀到的值去表格（通常是後台片段讀回來的）找那一筆，例：Jackpot Amount = {{amount}}。一行一條，運算子 = ^= *= ~= @now' },
  { action: 'assert_video_playing', label: '影片要真的在播', category: 'assertion', description: '影片沒暫停、而且播放時間有往前走（只看沒暫停不夠，卡在載入時也是沒暫停）' },
  { action: 'popup_watch', label: '暫停／恢復自動關彈窗', category: 'flow', description: '執行期間工具會自動關大廳彈窗；要驗彈窗本身（例：廣告 JP 彈框）時先暫停，驗完再恢復' },
  { action: 'backend_snippet', label: '後台設定', category: 'backend', description: '跑一份後台設定片段（例如把某個開關打開），完成後回到前端繼續' },
  // ⚠️ PC（Cocos）專用：畫面是一張 canvas，沒有 DOM 可選，所以 H5 那套選擇器積木在 PC 上一律命中 0。
  //    這兩顆讀的是 Cocos 場景樹。
  { action: 'pc_enter_machine', label: 'PC 進機台', category: 'interaction', description: 'PC 版：等大廳清單載完、照卡片資料挑一台空機進入，並核對實際進到哪一台；留空或 * ＝隨機挑一台空機' },
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

/**
 * 讀進來的步驟：**保留所有欄位**，只檢查已知欄位的型別（型別不對就丟掉那一欄）。
 *
 * 🚨 1007 claude-osm-2 回報：原本這裡（和下面的 cleanStep）是**白名單**，只複製列出來的欄位，其他一律默默丟掉——
 *    settleMs／as／from／reason／pattern／until／timeoutMs／matchMode／expect／容差／overwrite／nodeName… 全部消失。
 *    從畫面按「執行」走 parseSteps → compileExecutableSteps，送出去的步驟就少了這些欄位
 *    （assert_row_match 少了 from、require_precondition 少了 reason、goto 的 settleMs:0 變回預設 3 秒），
 *    畫面上一存檔也會把 API 寫進去的欄位清掉。用 API 直接派工的不經過這裡，所以那邊一直是好的。
 *    白名單＝每加一個欄位就要記得改兩處，漏了沒有任何錯誤；改成「預設保留、已知的才驗」。
 *    守門：scripts/ui-checks/step-model-roundtrip.test.ts（每種 action、每個欄位都要原封不動地存回來）
 */
const STRING_KEYS = ['value', 'selector', 'baselineId', 'urlPattern', 'snippetId', 'tcId', 'selectorStrategy', 'selectorCheck', 'selectorCheckReason', 'from', 'as', 'pattern', 'expect', 'nodeName', 'reason'] as const
const NUMBER_KEYS = ['x', 'y', 'threshold', 'scrollStep', 'maxScrolls', 'retryCount', 'statusCode', 'minCount', 'minAdvanceSec', 'settleMs', 'tolerancePct', 'absoluteTolerance', 'timeoutMs'] as const
// 原本就會去頭尾空白、空的不存的欄位（行為不變）；其他字串欄位原樣保留——pattern／expect 的空白可能有意義
const TRIM_KEYS = ['value', 'selector', 'baselineId', 'urlPattern', 'snippetId', 'tcId', 'selectorStrategy', 'selectorCheck', 'selectorCheckReason'] as const
const BOOLEAN_KEYS = ['overwrite', 'allowDangerous', 'collapsed'] as const
const ENUMS: Record<string, readonly string[]> = {
  expectStatus: ['2xx', 'any', 'exact'],
  until: ['visible', 'hidden', 'text', 'node'],
  matchMode: ['contains', 'equals', 'regex', 'number'],
}
function normalizeOne(item: unknown, index: number): AutoStep {
  if (typeof item === 'string') return { ...createStep('wait'), name: item, value: '1000' }
  if (!item || typeof item !== 'object') return { ...createStep('wait'), name: `步驟 ${index + 1}`, value: '1000' }
  const row = item as Record<string, unknown>
  const rawAction = typeof row.action === 'string' && row.action ? row.action : 'wait'
  const action = rawAction === 'fill' ? 'type' : rawAction
  const base = createStep(action)
  const { children: rawChildren, title, ...rest } = row
  const step = { ...base, ...rest, action } as AutoStep & Record<string, unknown>
  step.id = typeof row.id === 'string' && row.id ? row.id : base.id
  step.name = typeof row.name === 'string' ? row.name : typeof title === 'string' ? title : base.name
  // 已知欄位型別不對 → 丟掉那一欄（有預設值的退回預設）
  for (const k of STRING_KEYS) if (k in step && typeof step[k] !== 'string') delete step[k]
  for (const k of NUMBER_KEYS) if (k in step && (typeof step[k] !== 'number' || !Number.isFinite(step[k] as number))) delete step[k]
  for (const k of BOOLEAN_KEYS) if (k in step && typeof step[k] !== 'boolean') delete step[k]
  for (const [k, ok] of Object.entries(ENUMS)) if (k in step && !ok.includes(step[k] as string)) { if (k in base) step[k] = (base as unknown as Record<string, unknown>)[k]; else delete step[k] }
  if (!['inherit', 'continue', 'stop', 'retry'].includes(step.failureMode as string)) step.failureMode = 'inherit'
  if (Array.isArray(rawChildren)) step.children = rawChildren.map(normalizeOne)
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

/** 存回去的步驟：**保留所有欄位**（見 normalizeOne 的說明），只做整理——原本那幾個字串欄位去頭尾空白、空的不存；collapsed（畫面狀態）不存 */
function cleanStep(step: AutoStep): Record<string, unknown> {
  const { collapsed: _collapsed, children, ...rest } = step
  const row: Record<string, unknown> = { ...rest, name: step.name.trim() || actionLabel(step.action) }
  for (const k of TRIM_KEYS) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) row[k] = v.trim()
    else delete row[k]
  }
  for (const [k, v] of Object.entries(row)) if (v === undefined) delete row[k]
  if (!step.failureMode || step.failureMode === 'inherit') delete row.failureMode
  if (CONTAINER_ACTIONS.has(step.action)) row.children = (children ?? []).map(cleanStep)
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

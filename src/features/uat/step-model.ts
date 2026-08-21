import type { AutoStep } from './types'

export const STEP_LIBRARY = [
  { action: 'goto', label: '前往頁面', category: 'browser', description: '開啟指定網址' },
  { action: 'click', label: '點擊元素', category: 'interaction', description: '用 selector 點擊元素' },
  { action: 'click_viewport', label: '點擊畫面', category: 'interaction', description: '點擊 viewport 座標' },
  { action: 'click_xy', label: '點擊 Canvas', category: 'interaction', description: '點擊 Canvas 內座標' },
  { action: 'type', label: '輸入文字', category: 'interaction', description: '在欄位輸入內容' },
  { action: 'wait', label: '等待', category: 'browser', description: '等待指定毫秒' },
  { action: 'screenshot', label: '截圖', category: 'evidence', description: '擷取目前畫面' },
  { action: 'assert_visible', label: '驗證可見', category: 'assertion', description: '確認元素出現在畫面' },
  { action: 'find_baseline_scroll', label: '尋找基準圖', category: 'assertion', description: '捲動並比對基準圖' },
  { action: 'group', label: '步驟群組', category: 'flow', description: '整理一組可收合步驟' },
  { action: 'repeat', label: '重複區塊', category: 'flow', description: '依次數重複子步驟' },
] as const

export const CATEGORY_LABELS: Record<string, string> = {
  browser: '瀏覽器', interaction: '互動', assertion: '驗證', evidence: '證據', flow: '流程控制',
}

export const CONTAINER_ACTIONS = new Set(['group', 'repeat'])

export function createStep(action = 'goto'): AutoStep {
  const definition = STEP_LIBRARY.find(item => item.action === action)
  const step: AutoStep = {
    id: crypto.randomUUID(),
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
  for (const key of ['value', 'selector', 'baselineId'] as const) if (step[key]?.trim()) row[key] = step[key]?.trim()
  for (const key of ['x', 'y', 'threshold', 'scrollStep', 'maxScrolls', 'retryCount'] as const) if (typeof step[key] === 'number') row[key] = step[key]
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
  return { ...step, id: crypto.randomUUID(), name: `${step.name}（複本）`, children: step.children?.map(duplicateStep) }
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

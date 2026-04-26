export interface TestStepConfig {
  entry: boolean
  stream: boolean
  spin: boolean
  audio: boolean
  ideck: boolean
  touchscreen: boolean
  cctv: boolean
  exit: boolean
}

export interface MachineTestSession {
  lobbyUrls: string[]
  machineCodes: string[]
  steps: TestStepConfig
  /** 調適模式：若設定則 daily-analysis API 強制使用此固定 gmid */
  debugGmid?: string
  /** LLM model for CCTV vision step, e.g. 'gemini' or 'ollama:gemma4:26b' */
  cctvModelSpec?: string
  /** headed 模式：顯示瀏覽器視窗（不設 off-screen position） */
  headedMode?: boolean
  /** 日誌 API 環境：'qat' | 'prod'，決定 daily-analysis URL，預設 'qat' */
  osmEnv?: 'qat' | 'prod'
  /** AI 音頻分析：錄音後傳送 WAV 至 Gemini 判斷靜音/音量/爆音/雜訊 */
  aiAudio?: boolean
}

export type StepStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface StepResult {
  step: string
  status: StepStatus
  message: string
  durationMs: number
}

export interface MachineResult {
  machineCode: string
  overall: StepStatus
  steps: StepResult[]
  consoleLogs: string[]
  startedAt: string
  finishedAt: string
}

export type BonusAction = 'auto_wait' | 'spin' | 'takewin' | 'touchscreen'

export interface MachineProfile {
  machineType: string
  bonusAction: BonusAction
  /** Text labels of <span> elements on the touchscreen panel, e.g. ["3,2","6,5"] */
  touchPoints?: string[] | null
  /** Whether to also click .btn_take after all touchscreen positions */
  clickTake?: boolean | null
  /** gameid URL param for fallback profile matching, e.g. "osmbwjl" */
  gmid?: string | null
  spinSelector?: string | null
  balanceSelector?: string | null
  exitSelector?: string | null
  /** iDeck test: the row class containing btn_bet buttons, e.g. "row4" / "row2" */
  ideckRowClass?: string | null
  /** iDeck test: XPath list to find bet buttons (replaces ideckRowClass + betRandomConfig) */
  ideckXpaths?: string[] | null
  /** Touchscreen positions to click immediately after entering game (e.g. denom change screen).
   *  Each string is the text content of a <span> element, e.g. ["5,32", "3,2"] */
  entryTouchPoints?: string[] | null
  /** Stage 2 entry touchscreen: YES/NO confirmation */
  entryTouchPoints2?: string[] | null
  notes?: string | null
}

export type TestEventType =
  | 'log'
  | 'session_start'
  | 'machine_start'
  | 'machine_done'
  | 'session_done'
  | 'error'
  | 'queue_update'

export interface JobStatus {
  machineCode: string
  state: 'pending' | 'running' | 'done' | 'failed'
  agentId?: string
  startedAt?: number
  finishedAt?: number
}

export interface TestEvent {
  type: TestEventType
  machineCode?: string
  /** Agent hostname that generated this event (distributed mode only) */
  agentHostname?: string
  status?: StepStatus | 'info'
  message: string
  result?: MachineResult
  /** Populated on queue_update events (distributed work-stealing queue) */
  statuses?: JobStatus[]
  ts: string
}

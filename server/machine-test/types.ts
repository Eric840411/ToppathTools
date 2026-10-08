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
  /** Operator frozen when the long-running test session starts. */
  account?: string
  agentId?: string
  operator?: {
    key: string
    name: string
  }
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
  /** Session ID — used as file prefix for cctv-saves / audio-saves */
  sessionId?: string
  /** 1007 learn 自動找 iDeck 畫面指標：iDeck 多拍 idle／pre／post（batch --learn 自動帶） */
  ideckCapture?: boolean
  /**
   * 1008 下注規則（使用者選「照建議隔開」）：'learn'＝學習專用規則（Spin 前最小注、iDeck 族群由小到大、開局族群大鍵不按）。
   * 沒帶＝/machine-test 原本的行為（v5.40 之前）。batch --learn 自動帶
   */
  betRules?: 'learn'
  /** 1007 iDeck 時間學習：機種 → 學習值（中控 start 時從 machine_test_ideck_timing 帶入；只有 confirmed 才套用） */
  ideckTimings?: Record<string, import('./verdicts.js').IdeckTimingCfg>
  /** 1007：這些機種不准用短等待（batch 撤銷寫入中控失敗時帶入） */
  ideckNoFast?: string[]
}

export type StepStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface StepResult {
  step: string
  status: StepStatus
  message: string
  durationMs: number
  /** Extra context returned by the step (e.g. machineType from enterGMNtc response) */
  extraData?: Record<string, string>
}

export interface MachineResult {
  machineCode: string
  overall: StepStatus
  steps: StepResult[]
  consoleLogs: string[]
  startedAt: string
  finishedAt: string
  /**
   * 產生這筆結果的 session。伺服器轉播 agent 事件時不帶 sessionId（broadcastToViewers(ev)），
   * 外部腳本（machine-test-batch.mjs）靠這個欄位確認結果屬於自己發動的那一輪，
   * 不會混進試跑或別人的批次（2026-09-24）。
   */
  sessionId?: string
}

export type BonusAction = 'auto_wait' | 'spin' | 'takewin' | 'touchscreen'

export interface AudioConfig {
  /** Peak dB threshold — above this triggers 爆音風險. Default: -3 */
  peakWarnDb?: number
  /** Spectral centroid Hz threshold — above this triggers 音色偏亮. Default: 1500 */
  centroidWarnHz?: number
  /** RMS dB lower bound — below this triggers 音量偏低. Default: -60 */
  rmsMinDb?: number
  /** RMS dB upper bound — above this triggers 音量過大. Default: -20 */
  rmsMaxDb?: number
}

export interface MachineProfile {
  machineType: string
  bonusAction: BonusAction
  /** Text labels of <span> elements on the touchscreen panel, e.g. ["3,2","6,5"] */
  touchPoints?: string[] | null
  /** Whether to also click .btn_take after all touchscreen positions */
  clickTake?: boolean | null
  /** gameid URL param for fallback profile matching, e.g. "osmbwjl" */
  gmid?: string | null
  /** machineType value returned in enterGMNtc response for fallback matching, e.g. "wlzbhelix15" */
  enterMachineType?: string | null
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
  /** Per-machine audio analysis thresholds. Overrides global defaults when set. */
  audioConfig?: AudioConfig | null
  /** Expected number of playing <video> streams (screens). If set, fewer streams = FAIL.
   *  e.g. 2 for dual-screen machines, 1 for single-screen (default when unset). */
  expectedScreens?: number | null
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

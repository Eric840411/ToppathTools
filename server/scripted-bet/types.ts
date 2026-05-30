export interface ScriptedBetAccount {
  account: string
  username: string
  label: string
  url: string
}

export interface ScriptedBetMachineProfile {
  machineType: string
  entryTouchPoints?: string[] | null
  entryTouchPoints2?: string[] | null
  /** touch points to use on exit failure (bonus/special game handling) */
  touchPoints?: string[] | null
  bonusAction?: string | null
  spinSelector?: string | null
  exitSelector?: string | null
}

export interface ScriptedBetConfig {
  targetMachineCode: string
  spinMin: number
  spinMax: number
  spinDelayMinMs: number
  spinDelayMaxMs: number
  maxExitRetries: number
  exitFailTouchPoints?: string[]
  headedMode?: boolean
  /** Auto-resolved from Machine Test profiles by machineType */
  machineProfile?: ScriptedBetMachineProfile | null
}

export type ScriptedBetAccountState =
  | 'pending'
  | 'opening'
  | 'entering'
  | 'spinning'
  | 'exiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'stopped'

export interface ScriptedBetAccountStatus {
  account: string
  username: string
  label: string
  state: ScriptedBetAccountState
  targetMachineCode: string
  spinTarget?: number
  spinDone: number
  exitAttempts: number
  message: string
  startedAt?: number
  finishedAt?: number
}

export type ScriptedBetEventType =
  | 'session_start'
  | 'account_update'
  | 'log'
  | 'session_done'
  | 'error'

export interface ScriptedBetEvent {
  type: ScriptedBetEventType
  sessionId: string
  account?: string
  status?: ScriptedBetAccountState | 'info'
  message: string
  statuses?: ScriptedBetAccountStatus[]
  ts: string
}

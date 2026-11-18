/**
 * API 參數紀錄：agent ↔ server 共用型別（agent 會下載這支，只放型別）。
 */

export type CaptureEnv = 'qat' | 'uat'
export type StopCondition = 'payout' | 'spins'

/** server → agent */
export interface ApiCaptureStartMessage {
  type: 'api_capture_start'
  runId: string
  /** 大廳連結（含 token）。只在記憶體、不寫檔 */
  url: string
  machine: string
  stopCondition: StopCondition
  /** stopCondition=spins 時要跑幾局 */
  spins: number
  /** 不論條件，最多幾局就停（保護） */
  maxSpins: number
  headed: boolean
}

/** agent 錄到的一筆前台事件。t 一律是 agent 本機時鐘（毫秒） */
export type FrontEvent =
  | { kind: 'step'; t: number; action: string; detail?: Record<string, unknown> }
  | { kind: 'ws'; t: number; dir: 'send' | 'recv'; url: string; text: string }
  | { kind: 'console'; t: number; text: string }
  | { kind: 'http'; t: number; method: string; url: string; status: number; resourceType: string; req: string; res: string; noise: boolean }

export type CapturePhase = 'login' | 'enter' | 'spin' | 'exit' | 'done'

/** agent → server：進度 */
export interface ApiCaptureProgress {
  type: 'api_capture_progress'
  runId: string
  phase: CapturePhase
  message: string
  spin?: number
}

/** agent → server：分批送事件（一批最多 CHUNK_SIZE 筆） */
export interface ApiCaptureChunk {
  type: 'api_capture_chunk'
  runId: string
  seq: number
  items: FrontEvent[]
}

export interface SpinRecord {
  n: number
  /** 按下 Spin 的時間（agent 時鐘） */
  tClick: number
  /** 看到 moneyNtc end 的時間；沒看到為 null */
  tEnd: number | null
  coinBegin: number | null
  coinEnd: number | null
  /** coinEnd − coinBegin；看不到 moneyNtc 時為 null（不是 0） */
  win: number | null
}

/** agent → server：結束（成功、失敗、取消都送） */
export interface ApiCaptureDone {
  type: 'api_capture_done'
  runId: string
  ok: boolean
  cancelled: boolean
  error: string | null
  /** 送出的事件總數，server 用來核對有沒有掉批 */
  total: number
  chunks: number
  /** 送出這則訊息當下的 agent 時鐘（server 用來估 agent↔server 時差） */
  agentNow: number
  startedAt: number
  finishedAt: number
  spins: SpinRecord[]
  stopReason: 'payout' | 'spins' | 'max-spins' | 'cancelled' | 'error'
  /** 前台有沒有看到 moneyNtc（看不到就判斷不了派彩） */
  payoutObservable: boolean
  exitOk: boolean
}

export const API_CAPTURE_CHUNK_SIZE = 200

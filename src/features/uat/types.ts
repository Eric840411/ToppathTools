export type UatMainTab = 'backend' | 'h5' | 'pc'
export type UatThemeMode = 'classic' | 'xianxia'
export type AutoPlatform = 'h5' | 'pc'
export type AutoFilter = 'all' | 'mine' | 'public'
export type RunStatus = 'idle' | 'running' | 'done' | 'error'
export type StepFailureMode = 'inherit' | 'continue' | 'stop' | 'retry'
export type BackendModuleId = 'dashboard' | 'egm-core' | 'reports' | 'game-config' | 'meters' | 'ranking' | 'jackpot' | 'reservation' | 'logs' | 'vip-version' | 'other'
export type BackendModuleTone = 'blue' | 'cyan' | 'violet' | 'amber' | 'orange' | 'green' | 'rose' | 'slate'

export interface BackendPlanModule {
  instanceId: string
  sourceId: BackendModuleId | 'custom'
  name: string
  xianxiaName: string
  description: string
  tone: BackendModuleTone
  filters: string[]
}

export interface UatConfig {
  larkUrl: string
  filter: string
  dashGameType: string
  dashClientVersion: string
  modulePlan: BackendPlanModule[]
}

export interface TcGroup { name: string; count: number }

export interface AutoStep {
  id: string
  name: string
  action: string
  value?: string
  selector?: string
  x?: number
  y?: number
  baselineId?: string
  threshold?: number
  scrollStep?: number
  maxScrolls?: number
  retryCount?: number
  failureMode?: StepFailureMode
  collapsed?: boolean
  children?: AutoStep[]
}

export interface AutoScript {
  id: string
  name: string
  platform: AutoPlatform
  steps: string
  created_by: string
  is_public: number
  created_at?: number
  updated_at?: number
}

export interface AutoBaseline {
  id: string
  script_id: string
  name: string
  image_path: string
  crop_x?: number
  crop_y?: number
  crop_w?: number
  crop_h?: number
  threshold?: number
}

export interface AutoTemplate {
  id: string
  name: string
  image_path: string
  last_confidence: number | null
}

export interface OcrRegion {
  id: string
  name: string
  label: string
  crop_x: number
  crop_y: number
  crop_w: number
  crop_h: number
  accuracy: number | null
}

export interface AutoRun {
  id: string
  script_id: string
  result: string
  started_at?: number
  finished_at?: number
  passed?: number
  failed?: number
  skipped?: number
}

export interface AgentOption {
  agentId: string
  label?: string
  hostname?: string
}

export interface AutoCropResult {
  id: string
  name: string
  imagePath: string
  x: number
  y: number
  w: number
  h: number
  threshold: number
}

export type StepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip'

export type UatMainTab = 'backend' | 'h5' | 'pc'
export type UatThemeMode = 'classic' | 'xianxia'
export type AutoPlatform = 'h5' | 'pc'
export type AutoFilter = 'all' | 'mine' | 'public'
export type RunStatus = 'idle' | 'running' | 'done' | 'error'
export type StepFailureMode = 'inherit' | 'continue' | 'stop' | 'retry'
export interface UatConfig {
  larkUrl: string
  filter: string
  dashGameType: string
  dashClientVersion: string
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
  /**
   * 這顆積木屬於哪一筆 TC（Lark 的 recordId）。空＝共用步驟。
   *
   * ⚠️ **檢查／截圖類的積木一定要指定**，沒指定不給跑——沒有歸屬的檢查結果
   * 不知道要回寫到哪一筆，而「跑了但沒人收」跟「沒跑」在畫面上看起來一樣。
   * （跟 Backend 同一條規則。）
   */
  tcId?: string
  /**
   * `backend_snippet`：要跑哪一份後台設定片段。
   *
   * ⚠️ 只存 id，不存步驟——片段被改過之後這顆積木要**跟著改**，
   *    存一份快照的話會出現「你以為改好了、腳本還在跑舊的」。
   */
  snippetId?: string
  /** assert_api_called：要打到的 API 網址樣式（`*` 當萬用字元） */
  urlPattern?: string
  /** assert_api_called：狀態碼要求 */
  expectStatus?: '2xx' | 'any' | 'exact'
  /** assert_api_called：expectStatus 為 exact 時要比對的狀態碼 */
  statusCode?: number
  /** assert_api_called：至少要被打到幾次 */
  minCount?: number
  /** 這條 selector 是階梯的哪一階產的。`cssPath` 是最脆的一階，編輯器會標出來 */
  selectorStrategy?: string
  /** 錄製當下驗過的結果（ok／none／many／mismatch／invalid／unknown）。
   *  ⚠️ `unknown` 不是失敗——措辭表 `SELECTOR_CHECK_LABEL` 刻意不收它 */
  selectorCheck?: string
  /** selectorCheck 為 unknown 時的理由（unsupported／gone／shadow），純診斷用 */
  selectorCheckReason?: string
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
